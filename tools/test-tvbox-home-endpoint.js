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

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 200)}`));
                }
            });
        }).on('error', reject);
    });
}

(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donggua-tvbox-home-'));
    let child = null;
    const sourceServer = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.searchParams.get('ac') === 'detail') {
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
                code: 1,
                list: [
                    {
                        vod_id: 'm1',
                        vod_name: '流浪地球2 4K',
                        vod_pic: 'https://example.test/poster.jpg',
                        vod_year: '2023',
                        type_name: '电影',
                        vod_play_url: 'HD$https://example.test/movie.m3u8'
                    },
                    {
                        vod_id: 's1',
                        vod_name: '霸总短剧合集',
                        vod_pic: 'https://example.test/short.jpg',
                        vod_time: '2026-06-20 12:00:00',
                        type_name: '短剧',
                        vod_remarks: '竖屏爽文',
                        vod_play_url: '01$https://example.test/short.m3u8'
                    }
                ]
            }));
            return;
        }
        res.statusCode = 404;
        res.end('not found');
    });

    try {
        const sourcePort = await listen(sourceServer);
        fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
            sites: [
                {
                    key: 'mock-maccms',
                    name: 'Mock MacCMS',
                    api: `http://127.0.0.1:${sourcePort}/api.php/provide/vod/`,
                    active: true
                }
            ]
        }, null, 2));

        const appPort = sourcePort + 1;
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

        let logs = '';
        child.stdout.on('data', chunk => { logs += chunk.toString(); });
        child.stderr.on('data', chunk => { logs += chunk.toString(); });

        await waitFor(`http://127.0.0.1:${appPort}/api/search/diagnostics`);
        const result = await getJson(`http://127.0.0.1:${appPort}/api/recommendations/tvbox-home?sourceLimit=1&pages=1`);

        assert.equal(result.ok, true);
        assert.equal(result.mode, 'source-native');
        assert.equal(result.compatibleSources, 1);
        assert.equal(result.rows.randomRow[0].vod_name, '流浪地球2 4K');
        assert.equal(result.rows.randomRow.findIndex(item => item.vod_name.includes('短剧')) > 0, true);

        console.log(JSON.stringify({
            ok: true,
            mode: result.mode,
            compatibleSources: result.compatibleSources,
            top: result.rows.randomRow.slice(0, 3).map(item => ({
                name: item.vod_name,
                score: item.recommendation_score,
                reason: item.recommendation_reason
            }))
        }, null, 2));
    } finally {
        if (child) child.kill();
        sourceServer.close();
        try {
            fs.rmSync(dataDir, { recursive: true, force: true });
        } catch {}
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
