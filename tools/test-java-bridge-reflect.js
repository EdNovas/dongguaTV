const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function findJavaHome() {
    const candidates = [
        process.env.JAVA_HOME,
        'C:\\Program Files\\Microsoft\\jdk-21.0.11.10-hotspot',
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Zulu'
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        const direct = path.join(candidate, 'bin', 'java.exe');
        const javac = path.join(candidate, 'bin', 'javac.exe');
        const jar = path.join(candidate, 'bin', 'jar.exe');
        if (fs.existsSync(direct) && fs.existsSync(javac) && fs.existsSync(jar)) return candidate;

        const entries = fs.readdirSync(candidate, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => path.join(candidate, entry.name));
        for (const entry of entries) {
            if (
                fs.existsSync(path.join(entry, 'bin', 'java.exe')) &&
                fs.existsSync(path.join(entry, 'bin', 'javac.exe')) &&
                fs.existsSync(path.join(entry, 'bin', 'jar.exe'))
            ) {
                return entry;
            }
        }
    }
    return '';
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function waitForHealth(port, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = () => {
            http.get(`http://127.0.0.1:${port}/health`, res => {
                res.resume();
                if (res.statusCode && res.statusCode < 500) return resolve();
                if (Date.now() > deadline) return reject(new Error('Timed out waiting for Java bridge health'));
                setTimeout(tick, 300);
            }).on('error', () => {
                if (Date.now() > deadline) return reject(new Error('Timed out waiting for Java bridge health'));
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
                    resolve(JSON.parse(text));
                } catch (error) {
                    reject(new Error(`Invalid JSON: ${text.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: options.timeout || 60000,
        cwd: options.cwd || process.cwd(),
        shell: false
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error && result.error.message}`);
    }
    return result;
}

(async () => {
    const javaHome = findJavaHome();
    assert.ok(javaHome, 'A JDK with java, javac, and jar is required for this test.');
    const java = path.join(javaHome, 'bin', 'java.exe');
    const javac = path.join(javaHome, 'bin', 'javac.exe');
    const jar = path.join(javaHome, 'bin', 'jar.exe');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donggua-java-reflect-'));
    const bridgeOut = path.join(tempDir, 'bridge');
    const spiderSrc = path.join(tempDir, 'spider-src', 'com', 'example');
    const spiderClasses = path.join(tempDir, 'spider-classes');
    const spiderJar = path.join(tempDir, 'fake-spider.jar');
    let child = null;

    try {
        run('powershell', [
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.resolve(__dirname, '../tools/catvod-runtime-bridge-java/build.ps1'),
            '-JavaHome',
            javaHome,
            '-OutDir',
            bridgeOut
        ], { timeout: 120000 });
        const bridgeJar = path.join(bridgeOut, 'catvod-runtime-bridge.jar');
        assert.ok(fs.existsSync(bridgeJar), 'Bridge jar should be built.');

        fs.mkdirSync(spiderSrc, { recursive: true });
        fs.mkdirSync(spiderClasses, { recursive: true });
        fs.writeFileSync(path.join(spiderSrc, 'FakeSpider.java'), `
package com.example;

import java.util.List;

public class FakeSpider {
    public void init(String ext) {}

    public String searchContent(String keyword, boolean quick) {
        return "{\\"list\\":[{\\"vod_id\\":\\"reflect-1\\",\\"vod_name\\":\\"Reflect Search " + keyword + "\\",\\"vod_pic\\":\\"https://example.test/reflect.jpg\\",\\"vod_remarks\\":\\"reflect\\"}]}";
    }

    public String detailContent(List<String> ids) {
        String id = ids == null || ids.isEmpty() ? "reflect-1" : ids.get(0);
        return "{\\"list\\":[{\\"vod_id\\":\\"" + id + "\\",\\"vod_name\\":\\"Reflect Detail\\",\\"vod_play_from\\":\\"reflect\\",\\"vod_play_url\\":\\"HD$https://example.test/reflect.m3u8\\"}]}";
    }

    public String playerContent(String flag, String id, List<String> flags) {
        return "{\\"url\\":\\"https://example.test/play/" + id + ".m3u8\\",\\"headers\\":{\\"User-Agent\\":\\"DongguaTV-Test\\"}}";
    }
}
`, 'utf8');

        run(javac, ['-encoding', 'UTF-8', '-d', spiderClasses, path.join(spiderSrc, 'FakeSpider.java')]);
        run(jar, ['cf', spiderJar, '-C', spiderClasses, '.']);
        assert.ok(fs.existsSync(spiderJar), 'Fake Spider jar should be built.');

        const port = await freePort();
        child = spawn(java, [
            '-jar',
            bridgeJar,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--mode',
            'reflect',
            '--spider-jar',
            spiderJar,
            '--spider-class',
            'com.example.FakeSpider',
            '--spider-ext',
            'test-ext'
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        let logs = '';
        child.stdout.on('data', chunk => { logs += chunk.toString(); });
        child.stderr.on('data', chunk => { logs += chunk.toString(); });

        await waitForHealth(port);
        const search = await postJson(`http://127.0.0.1:${port}/runtime/search`, {
            params: { keyword: 'Joy', quick: false }
        });
        assert.equal(search.ok, true);
        assert.equal(search.status, 'reflect');
        assert.equal(search.result.list[0].vod_name, 'Reflect Search Joy');

        const detail = await postJson(`http://127.0.0.1:${port}/runtime/detail`, {
            params: { id: 'reflect-1' }
        });
        assert.equal(detail.ok, true);
        assert.equal(detail.result.list[0].vod_name, 'Reflect Detail');
        assert.match(detail.result.list[0].vod_play_url, /reflect\.m3u8/);

        const play = await postJson(`http://127.0.0.1:${port}/runtime/play`, {
            params: { flag: 'HD', id: 'reflect-1' }
        });
        assert.equal(play.ok, true);
        assert.match(play.result.url, /reflect-1\.m3u8/);
        assert.equal(play.result.headers['User-Agent'], 'DongguaTV-Test');

        console.log(JSON.stringify({
            ok: true,
            javaHome,
            bridgeMode: search.status,
            searchTitle: search.result.list[0].vod_name,
            detailTitle: detail.result.list[0].vod_name,
            playUrl: play.result.url
        }, null, 2));
    } finally {
        if (child) child.kill();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
    }
})().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
