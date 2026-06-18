const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { buildMpvArgs } = require('../server/player/mpvPlayer');
const { classifyPlayUrl } = require('../server/player/playUrlClassifier');
const { PlayerManager } = require('../server/player/playerManager');

async function main() {
    const specialUrl = 'http://127.0.0.1:9979/play/test?token=a%26b&name=%E6%B5%8B%E8%AF%95';
    assert.deepStrictEqual(
        buildMpvArgs(specialUrl, { fullscreenOnStart: true }),
        ['--fs', specialUrl]
    );
    assert.deepStrictEqual(
        buildMpvArgs(specialUrl, { fullscreenOnStart: false }),
        [specialUrl]
    );

    const classification = classifyPlayUrl({
        url: specialUrl,
        format: 'mkv',
        quality: '4k',
        codec: 'hevc',
        hdr: true,
        sourceKind: 'cloud-drive',
        headers: { Referer: 'https://example.test/' }
    }, {
        defaultPlayer: 'mpv',
        useMpcFor4K: true,
        useMpcForHEVC: true,
        useMpcForHDR: true,
        useMpcForCloudDrive: true
    });
    assert.strictEqual(classification.recommendedPlayer, 'mpv');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donggua-player-stack-'));
    const manager = new PlayerManager(dataDir, axios);
    manager.saveSettings({
        defaultPlayer: 'mpv',
        useLocalProxy: true,
        localProxyPort: 19979,
        fullscreenOnStart: false
    });

    try {
        const range = await manager.runProxyRangeSelfTest();
        const head = await manager.runProxyHeadSelfTest();
        const expiry = await manager.runProxyExpirySelfTest();
        const hls = await manager.runProxyM3u8RewriteSelfTest();

        assert.strictEqual(range.ok, true);
        assert.strictEqual(range.statusCode, 206);
        assert.strictEqual(range.contentRange, 'bytes 10-29/62');
        assert.strictEqual(head.ok, true);
        assert.strictEqual(expiry.ok, true);
        assert.strictEqual(hls.ok, true);
        assert.strictEqual(hls.rewrittenUrls, 3);

        console.log('Player stack tests passed: mpv args, classification, Range, HEAD, expiry, HLS rewrite.');
    } finally {
        await manager.localProxy.stop();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
