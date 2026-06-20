const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

function postJson(url, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload || {});
        const req = http.request(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body)
            }
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(text || '{}');
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (error) {
                    reject(new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donggua-java-self-test-api-'));
    const appPort = 31987;
    let child = null;

    try {
        fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ sites: [] }, null, 2));
        fs.writeFileSync(path.join(dataDir, 'plugin-runtime-settings.json'), JSON.stringify({
            enableJavaCatvod: true,
            javaPath: '',
            localJavaBridgeMode: 'stub',
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

        await waitFor(`http://127.0.0.1:${appPort}/api/plugin-runtimes/java-catvod/local-status`);
        const result = await postJson(`http://127.0.0.1:${appPort}/api/plugin-runtimes/java-catvod/reflect-self-test`, {});

        assert.equal(result.ok, true);
        assert.equal(result.mode, 'reflect');
        assert.equal(result.fakeSpiderOnly, true);
        assert.equal(result.searchTitle, 'Reflect Search Joy');
        assert.equal(result.detailTitle, 'Reflect Detail');
        assert.match(result.playUrl, /reflect-1\.m3u8/);
        assert.match(result.java.executable, /java\.exe$/i);
        assert.equal(result.settings.allowSubscriptionJarExecution, false);

        console.log(JSON.stringify({
            ok: true,
            endpoint: '/api/plugin-runtimes/java-catvod/reflect-self-test',
            java: result.java.executable,
            mode: result.mode,
            fakeSpiderOnly: result.fakeSpiderOnly,
            searchTitle: result.searchTitle,
            detailTitle: result.detailTitle,
            playUrl: result.playUrl
        }, null, 2));
    } finally {
        if (child) child.kill();
        try {
            fs.rmSync(dataDir, { recursive: true, force: true });
        } catch {}
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
