const { readPlayerSettings, savePlayerSettings, detectMpcPaths, validateMpcPath } = require('./externalPlayerConfig');
const { classifyPlayUrl } = require('./playUrlClassifier');
const { playWithMpc } = require('./mpcPlayer');
const { LocalProxy } = require('./localProxy');
const http = require('http');

function createRangeTestUpstream() {
    const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 'utf8');
    const server = http.createServer((req, res) => {
        const range = req.headers.range;
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
            res.end(chunk);
            return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Length', body.length);
        res.end(body);
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

    classify(playUrlResult) {
        return classifyPlayUrl(playUrlResult, this.getSettings());
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

    async openMpc(playUrlResult) {
        const input = typeof playUrlResult === 'string' ? { url: playUrlResult } : (playUrlResult || {});
        const settings = this.getSettings();
        const classification = classifyPlayUrl(input, settings);
        const proxy = settings.useLocalProxy ? await this.localProxy.register(input, settings) : null;
        playWithMpc(proxy ? proxy.proxyUrl : input.url, settings);
        return {
            ok: true,
            proxyUrl: proxy ? proxy.proxyUrl : null,
            recommendedPlayer: classification.recommendedPlayer,
            reason: classification.reason
        };
    }
}

module.exports = {
    PlayerManager
};
