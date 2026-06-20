const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appUrl = process.env.NEWEST_ORDER_QA_URL || 'http://127.0.0.1:31386/';
const targetUrl = `${appUrl}${appUrl.includes('?') ? '&' : '?'}newestOrderQa=${Date.now()}`;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donggua-newest-order-'));

app.setPath('userData', userDataDir);
app.commandLine.appendSwitch('disable-gpu');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(win, expression, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const matched = await win.webContents.executeJavaScript(`Boolean(${expression})`);
        if (matched) return;
        await delay(200);
    }
    throw new Error(`Timed out waiting for ${expression}`);
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    try {
        await win.loadURL(targetUrl);
        await waitFor(win, 'window.vueApp');

        const result = await win.webContents.executeJavaScript(`(() => {
            try {
            const vm = window.vueApp;
            const sample = [
                { id: 1, media_type: 'movie', title: 'Older', release_date: '2024-01-01', popularity: 100 },
                { id: 2, media_type: 'movie', title: 'Newest', release_date: '2026-06-18', popularity: 1 },
                { id: 3, media_type: 'tv', name: 'Middle', first_air_date: '2025-08-20', popularity: 50 },
                { id: 2, media_type: 'movie', title: 'Duplicate', release_date: '2026-06-18', popularity: 1 },
                { id: 4, media_type: 'movie', title: 'Unknown date', popularity: 999 }
            ];
            const newestSorted = vm.sortMediaNewest(sample);
            const popularSorted = vm.sortMediaPopular(sample);

            vm.rawList = [
                { vod_name: '2023 item', vod_year: '2023', vod_pic: '', site_key: 'a' },
                { vod_name: '2026 item', vod_time: '2026-06-18 10:00:00', vod_pic: '', site_key: 'b' },
                { vod_name: '2025 item', vod_pubdate: '2025-03-02', vod_pic: '', site_key: 'c' }
            ];

            return {
                newestTitles: newestSorted.map(item => item.title || item.name),
                newestDates: newestSorted.map(item => vm.mediaDateValue(item)),
                popularTitles: popularSorted.map(item => item.title || item.name),
                popularScores: popularSorted.map(item => Number(item.popularity || 0)),
                groupedNames: vm.groupedList.map(item => item.name),
                rowConfigs: Object.fromEntries(Object.entries(vm.rowConfigs).map(([key, config]) => [
                    key,
                    { path: config.path, sortMode: config.sortMode, title: vm.t(config.titleKey) }
                ]))
            };
            } catch (error) {
                return { ok: false, error: error.stack || error.message };
            }
        })()`);

        assert.notEqual(result.ok, false, result.error);
        assert.deepEqual(result.newestTitles, ['Newest', 'Middle', 'Older', 'Unknown date']);
        assert.ok(result.newestDates.every((value, index, array) => index === 0 || array[index - 1] >= value));
        assert.deepEqual(result.popularTitles, ['Unknown date', 'Older', 'Middle', 'Newest']);
        assert.ok(result.popularScores.every((value, index, array) => index === 0 || array[index - 1] >= value));
        assert.deepEqual(result.groupedNames, ['2026 item', '2025 item', '2023 item']);
        assert.equal(result.rowConfigs.randomRow.sortMode, 'popular');
        assert.equal(result.rowConfigs.movieRow.path, '/discover/movie');
        assert.equal(result.rowConfigs.tvRow.path, '/discover/tv');
        assert.ok(Object.values(result.rowConfigs).every(config => config.sortMode === 'popular'));

        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {}
        app.exit(0);
    } catch (error) {
        console.error(error.stack || error.message);
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {}
        app.exit(1);
    }
});
