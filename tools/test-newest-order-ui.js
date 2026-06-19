const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');

const appUrl = process.env.NEWEST_ORDER_QA_URL || 'http://127.0.0.1:31386/';
const targetUrl = `${appUrl}${appUrl.includes('?') ? '&' : '?'}newestOrderQa=${Date.now()}`;

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
            const vm = window.vueApp;
            const sample = [
                { id: 1, media_type: 'movie', title: 'Older', release_date: '2024-01-01', popularity: 100 },
                { id: 2, media_type: 'movie', title: 'Newest', release_date: '2026-06-18', popularity: 1 },
                { id: 3, media_type: 'tv', name: 'Middle', first_air_date: '2025-08-20', popularity: 50 },
                { id: 2, media_type: 'movie', title: 'Duplicate', release_date: '2026-06-18', popularity: 1 },
                { id: 4, media_type: 'movie', title: 'Unknown date', popularity: 999 }
            ];
            const sorted = vm.sortMediaNewest(sample);

            vm.rawList = [
                { vod_name: '2023 item', vod_year: '2023', vod_pic: '', site_key: 'a' },
                { vod_name: '2026 item', vod_time: '2026-06-18 10:00:00', vod_pic: '', site_key: 'b' },
                { vod_name: '2025 item', vod_pubdate: '2025-03-02', vod_pic: '', site_key: 'c' }
            ];

            return {
                sortedTitles: sorted.map(item => item.title || item.name),
                sortedDates: sorted.map(item => vm.mediaDateValue(item)),
                groupedNames: vm.groupedList.map(item => item.name),
                rowConfigs: Object.fromEntries(Object.entries(vm.rowConfigs).map(([key, config]) => [
                    key,
                    { path: config.path, sortMode: config.sortMode, title: vm.t(config.titleKey) }
                ]))
            };
        })()`);

        assert.deepEqual(result.sortedTitles, ['Newest', 'Middle', 'Older', 'Unknown date']);
        assert.ok(result.sortedDates.every((value, index, array) => index === 0 || array[index - 1] >= value));
        assert.deepEqual(result.groupedNames, ['2026 item', '2025 item', '2023 item']);
        assert.equal(result.rowConfigs.randomRow.sortMode, 'newest');
        assert.equal(result.rowConfigs.movieRow.path, '/discover/movie');
        assert.equal(result.rowConfigs.tvRow.path, '/discover/tv');
        assert.ok(Object.values(result.rowConfigs).every(config => config.sortMode === 'newest'));

        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        app.exit(0);
    } catch (error) {
        console.error(error.stack || error.message);
        app.exit(1);
    }
});
