const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { URL } = require('url');

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

function createId() {
    return crypto.randomBytes(12).toString('hex');
}

function sanitizeHeaders(headers) {
    const next = {};
    const allowed = ['user-agent', 'referer', 'cookie', 'authorization', 'accept', 'origin'];
    for (const [key, value] of Object.entries(headers || {})) {
        const lower = key.toLowerCase();
        if (allowed.includes(lower) && value) next[key] = value;
    }
    return next;
}

function copyResponseHeaders(proxyRes, upstreamHeaders) {
    for (const [key, value] of Object.entries(upstreamHeaders || {})) {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower)) continue;
        if (['content-length', 'content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag'].includes(lower)) {
            proxyRes.setHeader(key, value);
        }
    }
    if (!proxyRes.getHeader('Accept-Ranges')) {
        proxyRes.setHeader('Accept-Ranges', 'bytes');
    }
}

function resolveSegmentUrl(baseUrl, segment) {
    try {
        return new URL(segment, baseUrl).toString();
    } catch (error) {
        return segment;
    }
}

class LocalProxy {
    constructor(httpClient) {
        this.httpClient = httpClient;
        this.server = null;
        this.port = null;
        this.entries = new Map();
    }

    async ensureStarted(port) {
        const desiredPort = Number(port) || 9979;
        if (this.server && this.port === desiredPort) return;
        if (this.server) await this.stop();

        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res).catch(error => {
                res.statusCode = 502;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: error.message || 'Local proxy error' }));
            });
        });

        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(desiredPort, '127.0.0.1', () => {
                this.port = desiredPort;
                this.server.off('error', reject);
                resolve();
            });
        });
    }

    async stop() {
        if (!this.server) return;
        await new Promise(resolve => this.server.close(resolve));
        this.server = null;
        this.port = null;
        this.entries.clear();
    }

    getStatus() {
        const now = Date.now();
        let activeEntries = 0;
        let expiredEntries = 0;
        for (const entry of this.entries.values()) {
            if (entry.removeAt && entry.removeAt <= now) expiredEntries += 1;
            else activeEntries += 1;
        }
        return {
            running: !!this.server,
            host: this.server ? '127.0.0.1' : null,
            port: this.port,
            activeEntries,
            expiredEntries
        };
    }

    async checkPort(port) {
        const desiredPort = Number(port) || 9979;
        if (this.server && this.port === desiredPort) {
            return {
                available: true,
                runningByLocalProxy: true,
                host: '127.0.0.1',
                port: desiredPort,
                reason: 'local-proxy-running'
            };
        }

        const tester = net.createServer();
        return new Promise(resolve => {
            tester.once('error', error => {
                resolve({
                    available: false,
                    runningByLocalProxy: false,
                    host: '127.0.0.1',
                    port: desiredPort,
                    code: error.code || 'UNKNOWN',
                    reason: error.code === 'EADDRINUSE'
                        ? 'port-in-use'
                        : error.code === 'EACCES'
                            ? 'permission-denied'
                            : 'listen-failed',
                    message: error.message || 'Port check failed'
                });
            });
            tester.once('listening', () => {
                tester.close(() => {
                    resolve({
                        available: true,
                        runningByLocalProxy: false,
                        host: '127.0.0.1',
                        port: desiredPort,
                        reason: 'available'
                    });
                });
            });
            tester.listen(desiredPort, '127.0.0.1');
        });
    }

    async register(playUrlResult, settings) {
        const input = playUrlResult || {};
        if (!input.url) throw new Error('Playback URL is required.');
        await this.ensureStarted(settings.localProxyPort || 9979);
        const id = createId();
        const ttl = DEFAULT_TTL_MS;
        this.entries.set(id, {
            url: input.url,
            headers: sanitizeHeaders(input.headers || {}),
            expiresAt: input.expiresAt || null,
            removeAt: Date.now() + ttl
        });
        return {
            id,
            proxyUrl: `http://127.0.0.1:${this.port}/play/${id}`,
            expiresAt: new Date(Date.now() + ttl).toISOString()
        };
    }

    getEntry(id) {
        const entry = this.entries.get(id);
        if (!entry) return null;
        if (Date.now() > entry.removeAt) {
            this.entries.delete(id);
            return null;
        }
        return entry;
    }

    async handleRequest(req, res) {
        const match = req.url.match(/^\/play\/([a-f0-9]+)$/i);
        if (!match) {
            res.statusCode = 404;
            res.end('Not found');
            return;
        }

        const entry = this.getEntry(match[1]);
        if (!entry) {
            res.statusCode = 404;
            res.end('Expired or unknown play id');
            return;
        }

        const headers = {
            ...entry.headers
        };
        for (const key of ['range', 'accept', 'origin']) {
            if (req.headers[key]) headers[key] = req.headers[key];
        }

        const upstream = await this.httpClient.get(entry.url, {
            responseType: 'stream',
            timeout: 20000,
            maxRedirects: 5,
            validateStatus: status => status >= 200 && status < 400,
            headers
        });

        const contentType = String(upstream.headers['content-type'] || '');
        const isM3u8 = contentType.includes('mpegurl') || /\.m3u8(\?|#|$)/i.test(entry.url);
        if (isM3u8 && !req.headers.range) {
            const chunks = [];
            upstream.data.on('data', chunk => chunks.push(chunk));
            upstream.data.on('error', error => res.destroy(error));
            upstream.data.on('end', async () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const rewritten = await this.rewriteM3u8(body, entry, headers);
                res.statusCode = upstream.status;
                res.setHeader('Content-Type', contentType || 'application/vnd.apple.mpegurl');
                res.setHeader('Content-Length', Buffer.byteLength(rewritten));
                res.end(rewritten);
            });
            return;
        }

        res.statusCode = upstream.status;
        copyResponseHeaders(res, upstream.headers);
        upstream.data.pipe(res);
    }

    async rewriteM3u8(body, parentEntry, headers) {
        const lines = [];
        for (const line of String(body || '').split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || /^https?:\/\//i.test(trimmed) === false && trimmed.startsWith('data:')) {
                lines.push(line);
                continue;
            }
            if (trimmed.startsWith('#')) {
                lines.push(line);
                continue;
            }
            const segmentUrl = /^https?:\/\//i.test(trimmed) ? trimmed : resolveSegmentUrl(parentEntry.url, trimmed);
            const id = createId();
            this.entries.set(id, {
                url: segmentUrl,
                headers,
                expiresAt: parentEntry.expiresAt,
                removeAt: parentEntry.removeAt
            });
            lines.push(`http://127.0.0.1:${this.port}/play/${id}`);
        }
        return lines.join('\n');
    }
}

module.exports = {
    LocalProxy
};
