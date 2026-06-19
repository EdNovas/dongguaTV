const { readPlayerSettings, savePlayerSettings, detectMpcPaths, detectMpvPaths, validateMpcPath, validateMpvPath } = require('./externalPlayerConfig');
const { classifyPlayUrl } = require('./playUrlClassifier');
const { playWithMpc } = require('./mpcPlayer');
const { playWithMpv } = require('./mpvPlayer');
const { LocalProxy } = require('./localProxy');
const http = require('http');

function createRangeTestUpstream() {
    const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 'utf8');
    const server = http.createServer((req, res) => {
        const range = req.headers.range;
        const isHead = req.method === 'HEAD';
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'video/mp4');

        if (range) {
            const match = String(range).match(/^bytes=(\d+)-(\d+)?$/);
            if (!match) {
                res.statusCode = 416;
                res.end();
                return;
            }
            const start = Number(match[1]);
            const end = match[2] ? Number(match[2]) : body.length - 1;
            const safeEnd = Math.min(end, body.length - 1);
            const chunk = body.subarray(start, safeEnd + 1);
            res.statusCode = 206;
            res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${body.length}`);
            res.setHeader('Content-Length', chunk.length);
            res.end(isHead ? undefined : chunk);
            return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Length', body.length);
        res.end(isHead ? undefined : body);
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                server,
                url: `http://127.0.0.1:${address.port}/range-test.mp4`
            });
        });
    });
}

function createHlsRewriteTestUpstream() {
    const requests = [];
    const bodies = {
        '/init.mp4': Buffer.from('init-segment', 'utf8'),
        '/key.bin': Buffer.from('0123456789abcdef', 'utf8'),
        '/segments/seg-1.ts': Buffer.from('segment-one', 'utf8')
    };
    const server = http.createServer((req, res) => {
        requests.push({
            url: req.url,
            referer: req.headers.referer || ''
        });

        if (req.url === '/playlist.m3u8') {
            const playlist = [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-MAP:URI="init.mp4"',
                '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
                '#EXTINF:4.000,',
                'segments/seg-1.ts',
                '#EXT-X-ENDLIST',
                ''
            ].join('\n');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Content-Length', Buffer.byteLength(playlist));
            res.end(playlist);
            return;
        }

        const body = bodies[req.url];
        if (body) {
            res.statusCode = 200;
            res.setHeader('Content-Type', req.url.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream');
            res.setHeader('Content-Length', body.length);
            res.end(body);
            return;
        }

        res.statusCode = 404;
        res.end('not found');
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                server,
                url: `http://127.0.0.1:${address.port}/playlist.m3u8`,
                requests
            });
        });
    });
}

function requestThroughProxy(url, headers) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                });
            });
        });
        req.setTimeout(10000, () => {
            req.destroy(new Error('Proxy range request timed out'));
        });
        req.on('error', reject);
    });
}

function requestHeadThroughProxy(url, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: 'HEAD', headers }, res => {
            res.resume();
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers
                });
            });
        });
        req.setTimeout(10000, () => {
            req.destroy(new Error('Proxy HEAD request timed out'));
        });
        req.on('error', reject);
        req.end();
    });
}

class PlayerManager {
    constructor(dataDir, httpClient) {
        this.dataDir = dataDir;
        this.localProxy = new LocalProxy(httpClient);
    }

    getSettings() {
        return readPlayerSettings(this.dataDir);
    }

    saveSettings(patch) {
        return savePlayerSettings(this.dataDir, patch || {});
    }

    detectMpc() {
        const matches = detectMpcPaths();
        return {
            found: matches.length > 0,
            matches,
            recommended: matches[0] || ''
        };
    }

    validateMpc(exePath) {
        const settings = this.getSettings();
        return validateMpcPath(exePath || settings.mpcExePath);
    }

    detectMpv() {
        const matches = detectMpvPaths();
        return {
            found: matches.length > 0,
            matches,
            recommended: matches[0] || ''
        };
    }

    validateMpv(exePath) {
        const settings = this.getSettings();
        return validateMpvPath(exePath || settings.mpvExePath);
    }

    classify(playUrlResult) {
        return classifyPlayUrl(playUrlResult, this.getSettings());
    }

    diagnosePlayback(playUrlResult) {
        const input = typeof playUrlResult === 'string' ? { url: playUrlResult } : (playUrlResult || {});
        const settings = this.getSettings();
        const classification = classifyPlayUrl(input, settings);
        const mpcValidation = validateMpcPath(settings.mpcExePath);
        const mpvValidation = validateMpvPath(settings.mpvExePath);
        const proxyStatus = this.localProxy.getStatus();
        const headers = input.headers || {};
        const headerNames = Object.keys(headers).filter(key => Boolean(headers[key]));
        const expiresAtMs = input.expiresAt ? new Date(input.expiresAt).getTime() : null;
        const now = Date.now();
        const expiresInSeconds = Number.isFinite(expiresAtMs) ? Math.round((expiresAtMs - now) / 1000) : null;
        const issues = [];
        const recommendations = [];

        if (!input.url) {
            issues.push({
                code: 'missing-url',
                severity: 'error',
                message: 'No playback URL is available for the current item.'
            });
        }

        if (input.sourceKind === 'plugin-required') {
            issues.push({
                code: 'plugin-required',
                severity: 'error',
                message: 'This source needs a TVBox plugin runtime and cannot be played directly.'
            });
            recommendations.push('Use a supported HTTP/MacCMS source or configure a trusted plugin runtime bridge later.');
        }

        if (expiresInSeconds !== null && expiresInSeconds <= 0) {
            issues.push({
                code: 'url-expired',
                severity: 'error',
                message: 'The playback URL has expired.'
            });
            recommendations.push('Refresh the episode or source detail to resolve a new playback URL.');
        } else if (expiresInSeconds !== null && expiresInSeconds < 300) {
            issues.push({
                code: 'url-expires-soon',
                severity: 'warning',
                message: 'The playback URL will expire soon.'
            });
            recommendations.push('Start playback soon or refresh the source before opening an external player.');
        }

        if (classification.recommendedPlayer === 'mpc' && !mpcValidation.valid) {
            issues.push({
                code: 'mpc-not-ready',
                severity: 'warning',
                message: 'MPC is recommended, but the configured MPC path is not valid.'
            });
            recommendations.push('Open Settings and configure a valid MPC-HC or MPC-BE executable path.');
        }

        if (classification.recommendedPlayer === 'mpv' && !mpvValidation.valid) {
            issues.push({
                code: 'mpv-not-ready',
                severity: 'warning',
                message: 'mpv.net is recommended, but the configured mpv path is not valid.'
            });
            recommendations.push('Open Settings and configure a valid mpv.net executable path.');
        }

        if (headerNames.length > 0 && settings.useLocalProxy === false) {
            issues.push({
                code: 'headers-without-proxy',
                severity: 'warning',
                message: 'This playback URL needs custom headers, but LocalProxy is disabled.'
            });
            recommendations.push('Enable LocalProxy so external/internal playback can receive Referer, Cookie, User-Agent, or Authorization headers.');
        }

        if (classification.recommendedPlayer === 'mpc' || classification.recommendedPlayer === 'mpv') {
            recommendations.push(classification.reason);
        }

        if (input.format === 'm3u8' && headerNames.length > 0) {
            recommendations.push('For HLS with headers, use the LocalProxy URL or an external-player button instead of copying the raw URL.');
        }

        if (issues.length === 0) {
            recommendations.push('No obvious playback configuration problem was detected.');
        }

        return {
            ok: issues.length === 0,
            checkedAt: new Date().toISOString(),
            classification,
            playUrl: {
                present: Boolean(input.url),
                format: input.format || 'unknown',
                quality: input.quality || 'unknown',
                codec: input.codec || 'unknown',
                hdr: Boolean(input.hdr),
                sourceKind: input.sourceKind || 'normal',
                hasHeaders: headerNames.length > 0,
                headerNames,
                expiresAt: input.expiresAt || null,
                expiresInSeconds
            },
            player: {
                defaultPlayer: settings.defaultPlayer,
                mpcValidation: {
                    valid: mpcValidation.valid,
                    reason: mpcValidation.reason,
                    playerType: mpcValidation.playerType,
                    message: mpcValidation.message
                },
                mpvValidation: {
                    valid: mpvValidation.valid,
                    reason: mpvValidation.reason,
                    playerType: mpvValidation.playerType,
                    message: mpvValidation.message
                }
            },
            proxy: {
                useLocalProxy: settings.useLocalProxy,
                localProxyPort: settings.localProxyPort,
                status: proxyStatus
            },
            issues,
            recommendations: Array.from(new Set(recommendations.filter(Boolean)))
        };
    }

    async createProxyUrl(playUrlResult) {
        const settings = this.getSettings();
        return this.localProxy.register(playUrlResult, settings);
    }

    getProxyStatus() {
        const settings = this.getSettings();
        return {
            settings: {
                useLocalProxy: settings.useLocalProxy,
                localProxyPort: settings.localProxyPort
            },
            proxy: this.localProxy.getStatus()
        };
    }

    async checkProxyPort(port) {
        const settings = this.getSettings();
        return this.localProxy.checkPort(port || settings.localProxyPort || 9979);
    }

    async runProxyRangeSelfTest() {
        const settings = this.getSettings();
        const upstream = await createRangeTestUpstream();
        try {
            const proxy = await this.localProxy.register({
                url: upstream.url,
                format: 'mp4',
                sourceKind: 'normal',
                headers: {}
            }, settings);
            const response = await requestThroughProxy(proxy.proxyUrl, { Range: 'bytes=10-29' });
            const contentRange = String(response.headers['content-range'] || '');
            const ok = response.statusCode === 206
                && contentRange === 'bytes 10-29/62'
                && response.body.length === 20
                && String(response.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
            return {
                ok,
                statusCode: response.statusCode,
                contentRange,
                contentLength: Number(response.headers['content-length'] || response.body.length),
                bodyLength: response.body.length,
                proxyUrl: proxy.proxyUrl,
                proxyPort: this.localProxy.getStatus().port,
                checkedAt: new Date().toISOString()
            };
        } finally {
            await new Promise(resolve => upstream.server.close(resolve));
        }
    }

    async runProxyHeadSelfTest() {
        const settings = this.getSettings();
        const upstream = await createRangeTestUpstream();
        try {
            const proxy = await this.localProxy.register({
                url: upstream.url,
                format: 'mp4',
                sourceKind: 'normal',
                headers: {}
            }, settings);
            const response = await requestHeadThroughProxy(proxy.proxyUrl, {});
            const ok = response.statusCode === 200
                && Number(response.headers['content-length'] || 0) === 62
                && String(response.headers['accept-ranges'] || '').toLowerCase() === 'bytes'
                && String(response.headers['content-type'] || '').includes('video/mp4');
            return {
                ok,
                statusCode: response.statusCode,
                contentLength: Number(response.headers['content-length'] || 0),
                acceptRanges: response.headers['accept-ranges'] || '',
                contentType: response.headers['content-type'] || '',
                proxyUrl: proxy.proxyUrl,
                proxyPort: this.localProxy.getStatus().port,
                checkedAt: new Date().toISOString()
            };
        } finally {
            await new Promise(resolve => upstream.server.close(resolve));
        }
    }

    async runProxyExpirySelfTest() {
        const settings = this.getSettings();
        const upstream = await createRangeTestUpstream();
        try {
            let expiredRejected = false;
            try {
                await this.localProxy.register({
                    url: upstream.url,
                    format: 'mp4',
                    sourceKind: 'normal',
                    headers: {},
                    expiresAt: new Date(Date.now() - 1000).toISOString()
                }, settings);
            } catch (error) {
                expiredRejected = /expired/i.test(error.message || '');
            }

            const proxy = await this.localProxy.register({
                url: upstream.url,
                format: 'mp4',
                sourceKind: 'normal',
                headers: {},
                expiresAt: new Date(Date.now() + 250).toISOString()
            }, settings);
            await new Promise(resolve => setTimeout(resolve, 450));
            const response = await requestThroughProxy(proxy.proxyUrl, {});
            const ok = expiredRejected
                && response.statusCode === 410
                && new Date(proxy.expiresAt).getTime() <= Date.now();
            return {
                ok,
                expiredRejected,
                expiredStatusCode: response.statusCode,
                proxyUrl: proxy.proxyUrl,
                proxyExpiresAt: proxy.expiresAt,
                proxyPort: this.localProxy.getStatus().port,
                checkedAt: new Date().toISOString()
            };
        } finally {
            await new Promise(resolve => upstream.server.close(resolve));
        }
    }

    async runProxyM3u8RewriteSelfTest() {
        const settings = this.getSettings();
        const upstream = await createHlsRewriteTestUpstream();
        try {
            const proxy = await this.localProxy.register({
                url: upstream.url,
                format: 'm3u8',
                sourceKind: 'live',
                headers: {
                    Referer: 'https://example.test/hls'
                }
            }, settings);
            const playlistResponse = await requestThroughProxy(proxy.proxyUrl, {});
            const playlist = playlistResponse.body.toString('utf8');
            const proxyUrls = playlist.match(/http:\/\/127\.0\.0\.1:\d+\/play\/[a-f0-9]+/gi) || [];
            const uniqueProxyUrls = Array.from(new Set(proxyUrls));
            const childResponses = [];
            for (const childUrl of uniqueProxyUrls) {
                const response = await requestThroughProxy(childUrl, {});
                childResponses.push({
                    url: childUrl,
                    statusCode: response.statusCode,
                    bodyLength: response.body.length
                });
            }

            const childUpstreamRequests = upstream.requests.filter(request => request.url !== '/playlist.m3u8');
            const childReferersOk = childUpstreamRequests.length === 3
                && childUpstreamRequests.every(request => request.referer === 'https://example.test/hls');
            const ok = playlistResponse.statusCode === 200
                && uniqueProxyUrls.length === 3
                && !/URI="(?:init\.mp4|key\.bin)"/i.test(playlist)
                && !/\nsegments\/seg-1\.ts(?:\r?\n|$)/i.test(playlist)
                && childResponses.every(response => response.statusCode === 200 && response.bodyLength > 0)
                && childReferersOk;

            return {
                ok,
                statusCode: playlistResponse.statusCode,
                rewrittenUrls: uniqueProxyUrls.length,
                childResponses,
                childReferersOk,
                proxyPort: this.localProxy.getStatus().port,
                checkedAt: new Date().toISOString()
            };
        } finally {
            await new Promise(resolve => upstream.server.close(resolve));
        }
    }

    async openMpc(playUrlResult) {
        const input = typeof playUrlResult === 'string' ? { url: playUrlResult } : (playUrlResult || {});
        const settings = this.getSettings();
        const classification = classifyPlayUrl(input, settings);
        const proxy = settings.useLocalProxy ? await this.localProxy.register(input, settings) : null;
        const launch = playWithMpc(proxy ? proxy.proxyUrl : input.url, settings);
        return {
            ok: true,
            proxyUrl: proxy ? proxy.proxyUrl : null,
            launch,
            recommendedPlayer: classification.recommendedPlayer,
            reason: classification.reason
        };
    }

    async openMpv(playUrlResult) {
        const input = typeof playUrlResult === 'string' ? { url: playUrlResult } : (playUrlResult || {});
        const settings = this.getSettings();
        const classification = classifyPlayUrl(input, settings);
        const proxy = settings.useLocalProxy ? await this.localProxy.register(input, settings) : null;
        const launch = playWithMpv(proxy ? proxy.proxyUrl : input.url, settings);
        return {
            ok: true,
            proxyUrl: proxy ? proxy.proxyUrl : null,
            launch,
            recommendedPlayer: classification.recommendedPlayer,
            reason: classification.reason
        };
    }
}

module.exports = {
    PlayerManager
};
