const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function waitFor(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = () => {
            http.get(url, res => {
                res.resume();
                if (res.statusCode && res.statusCode < 500) return resolve();
                if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${url}`));
                setTimeout(tick, 300);
            }).on('error', () => {
                if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${url}`));
                setTimeout(tick, 300);
            });
        };
        tick();
    });
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body)
    });
    res.end(body);
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (error) {
                    reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 200)}`));
                }
            });
        }).on('error', reject);
    });
}

(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donggua-plugin-bridge-'));
    const bridgeRequests = [];
    let child = null;

    const bridgeServer = http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            sendJson(res, 200, { status: 'available', runtime: { mode: 'test' } });
            return;
        }
        if (req.method === 'POST' && req.url === '/runtime/search') {
            const payload = await readJsonBody(req);
            bridgeRequests.push({ operation: 'search', payload });
            sendJson(res, 200, {
                ok: true,
                status: 'available',
                result: {
                    list: [
                        {
                            vod_id: 'bridge-vod-1',
                            vod_name: `Bridge Result ${payload.params && payload.params.keyword || ''}`.trim(),
                            vod_pic: 'https://example.test/bridge.jpg',
                            vod_remarks: 'Bridge search',
                            type_name: 'Plugin',
                            vod_year: '2026'
                        }
                    ]
                }
            });
            return;
        }
        if (req.method === 'POST' && req.url === '/runtime/detail') {
            const payload = await readJsonBody(req);
            bridgeRequests.push({ operation: 'detail', payload });
            sendJson(res, 200, {
                ok: true,
                status: 'available',
                result: {
                    list: [
                        {
                            vod_id: payload.params && payload.params.id || 'bridge-vod-1',
                            vod_name: 'Bridge Detail',
                            vod_pic: 'https://example.test/bridge-detail.jpg',
                            vod_content: 'Detail returned by a trusted local Bridge.',
                            vod_play_from: 'bridge',
                            vod_play_url: 'HD$https://example.test/bridge.m3u8'
                        }
                    ]
                }
            });
            return;
        }
        sendJson(res, 404, { error: 'not found' });
    });

    try {
        const bridgePort = await listen(bridgeServer);
        const appPort = bridgePort + 1;
        const pluginSource = {
            id: 'plugin-source-1',
            sourceSubscriptionId: 'sub-1',
            sourceType: 'plugin-required',
            key: 'csp_Test',
            name: 'Bridge Plugin Source',
            api: 'csp_Test',
            tvboxType: 3,
            searchable: true,
            quickSearch: true,
            filterable: false,
            switchable: true,
            ext: null,
            jar: null,
            spider: null,
            status: 'plugin-required',
            supportLevel: 'plugin-required',
            enabled: true,
            raw: { key: 'csp_Test', name: 'Bridge Plugin Source', type: 3, api: 'csp_Test' },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ sites: [] }, null, 2));
        fs.writeFileSync(path.join(dataDir, 'sources.json'), JSON.stringify([pluginSource], null, 2));
        fs.writeFileSync(path.join(dataDir, 'subscriptions.json'), JSON.stringify([
            { id: 'sub-1', name: 'Plugin Fixture', enabled: true }
        ], null, 2));
        fs.writeFileSync(path.join(dataDir, 'plugin-runtime-settings.json'), JSON.stringify({
            externalHttpBaseUrl: `http://127.0.0.1:${bridgePort}`,
            enableJavaCatvod: false,
            allowSubscriptionJarExecution: false
        }, null, 2));

        child = spawn(process.execPath, ['server.js'], {
            cwd: path.resolve(__dirname, '..'),
            env: {
                ...process.env,
                PORT: String(appPort),
                DONGGUATV_DATA_DIR: dataDir,
                TMDB_API_KEY: ''
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        await waitFor(`http://127.0.0.1:${appPort}/api/search/diagnostics`);
        const diagnostics = await getJson(`http://127.0.0.1:${appPort}/api/search/diagnostics?wd=Bridge`);
        assert.equal(diagnostics.counts.pluginBridgeSearchSources, 1);

        const search = await getJson(`http://127.0.0.1:${appPort}/api/search?wd=Bridge&smart=false`);
        assert.equal(search.list.length, 1);
        assert.equal(search.list[0].site_key, 'plugin:plugin-source-1');
        assert.equal(search.list[0].source_origin, 'tvbox-plugin');
        assert.equal(search.list[0].vod_name, 'Bridge Result Bridge');

        const detail = await getJson(`http://127.0.0.1:${appPort}/api/detail?id=bridge-vod-1&site_key=${encodeURIComponent('plugin:plugin-source-1')}`);
        assert.equal(detail.list.length, 1);
        assert.equal(detail.list[0].vod_name, 'Bridge Detail');
        assert.match(detail.list[0].vod_play_url, /bridge\.m3u8/);

        assert.equal(bridgeRequests.some(item => item.operation === 'search'), true);
        assert.equal(bridgeRequests.some(item => item.operation === 'detail'), true);
        const searchPayload = bridgeRequests.find(item => item.operation === 'search').payload;
        assert.equal(searchPayload.policy.allowSubscriptionJarExecution, false);
        assert.equal(searchPayload.source.id, 'plugin-source-1');

        console.log(JSON.stringify({
            ok: true,
            pluginBridgeSearchSources: diagnostics.counts.pluginBridgeSearchSources,
            searchTitle: search.list[0].vod_name,
            detailTitle: detail.list[0].vod_name,
            bridgeOperations: bridgeRequests.map(item => item.operation)
        }, null, 2));
    } finally {
        if (child) child.kill();
        bridgeServer.close();
        try {
            fs.rmSync(dataDir, { recursive: true, force: true });
        } catch {}
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
