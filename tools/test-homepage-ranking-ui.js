const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-gpu');

const appUrl = process.env.HOMEPAGE_QA_URL || 'http://127.0.0.1:31386/';
const targetUrl = `${appUrl}${appUrl.includes('?') ? '&' : '?'}homepageRankingQa=${Date.now()}`;
const screenshotPath = process.env.HOMEPAGE_QA_SCREENSHOT
    || 'D:/CodexWorks/tmp/donggua-home-ranking-preview.png';
const blockPattern = /短剧|微短剧|竖屏|霸总|爽文|动态漫|有声动漫|全集|合集|一口气|解说|体育赛事|世界杯.*VS/i;
const consoleMessages = [];

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
        width: 1600,
        height: 1000,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        consoleMessages.push({
            level,
            message: String(message).slice(0, 500),
            line,
            sourceId: String(sourceId).slice(0, 160)
        });
    });

    try {
        await win.loadURL(targetUrl);
        await waitFor(win, 'window.vueApp');
        await win.webContents.executeJavaScript(`(() => {
            const vm = window.vueApp;
            vm.isAuthenticated = true;
            vm.dismissFirstRunGuide && vm.dismissFirstRunGuide();
            vm.fetchAllLists();
            return true;
        })()`);
        await waitFor(
            win,
            'window.vueApp.recommendationDiagnostics && Array.isArray(window.vueApp.rowLists.randomRow)',
            45000
        );

        const state = await win.webContents.executeJavaScript(`(() => {
            const vm = window.vueApp;
            const readRow = key => (vm.rowLists[key] || []).slice(0, 18).map(item => ({
                title: vm.rowItemTitle(item),
                origin: item.recommendation_origin || 'fallback',
                category: item.recommendation_category || '',
                sourceCount: Number(item.source_count || 0)
            }));
            return {
                mode: vm.recommendationMode,
                fallbackReason: vm.recommendationFallbackReason,
                random: readRow('randomRow'),
                movies: readRow('movieRow'),
                series: readRow('tvRow'),
                diagnostics: {
                    compatibleSources: Number(vm.recommendationDiagnostics.compatibleSources || 0),
                    scannedSources: Number(vm.recommendationDiagnostics.scannedSources || 0),
                    rankedCount: Number(vm.recommendationDiagnostics.rankedCount || 0),
                    cache: vm.recommendationDiagnostics.cache ? {
                        hit: Boolean(vm.recommendationDiagnostics.cache.hit),
                        stale: Boolean(vm.recommendationDiagnostics.cache.stale),
                        ttlSeconds: Number(vm.recommendationDiagnostics.cache.ttlSeconds || 0)
                    } : null
                }
            };
        })()`);

        const blocked = state.random.filter(item => blockPattern.test(item.title));
        assert.ok(state.random.length > 0, 'Homepage recommendation row is empty.');
        assert.equal(blocked.length, 0, `Blocked homepage titles found: ${blocked.map(item => item.title).join(', ')}`);
        assert.ok(
            ['douban-source', 'douban', 'source-native', 'tmdb'].includes(state.mode),
            `Unexpected recommendation mode: ${state.mode}`
        );
        const doubanOpenRoute = await win.webContents.executeJavaScript(`(() => {
            const vm = window.vueApp;
            const item = (vm.rowLists.randomRow || []).find(entry => entry.recommendation_origin === 'douban');
            if (!item) return null;
            let route = null;
            const originalAutoSearch = vm.autoSearch;
            vm.autoSearch = (...args) => {
                route = args;
                return args;
            };
            try {
                vm.openRowItem(item);
            } finally {
                vm.autoSearch = originalAutoSearch;
            }
            return { title: item.vod_name, route };
        })()`);
        assert.ok(doubanOpenRoute, 'No Douban homepage item was available for click routing.');
        assert.deepEqual(
            doubanOpenRoute.route,
            [doubanOpenRoute.title, doubanOpenRoute.title],
            'Douban homepage cards must search the configured user sources by title.'
        );

        win.show();
        await waitFor(
            win,
            "document.querySelector('.appletv-shell') && getComputedStyle(document.querySelector('.appletv-shell')).display !== 'none'"
        );
        await win.webContents.executeJavaScript(`(() => {
            const vm = window.vueApp;
            vm.dismissFirstRunGuide && vm.dismissFirstRunGuide();
            vm.closeOverlayPanels && vm.closeOverlayPanels();
            document.querySelectorAll('#app-loader, .app-loader').forEach(node => {
                node.classList.add('hidden');
                node.style.setProperty('display', 'none', 'important');
                node.remove();
            });
            window.scrollTo(0, 0);
            document.body.getBoundingClientRect();
            return {
                loaderCount: document.querySelectorAll('#app-loader, .app-loader').length,
                shellVisible: Boolean(document.querySelector('.appletv-shell')),
                cardCount: document.querySelectorAll('.hot-card').length
            };
        })()`);
        await waitFor(win, "document.querySelectorAll('.hot-card').length > 0");
        await waitFor(
            win,
            "Array.from(document.querySelectorAll('.hot-card img')).filter(img => img.complete && img.naturalWidth > 20).length >= 5",
            30000
        );
        await delay(800);
        const visualState = await win.webContents.executeJavaScript(`(() => ({
            loaderCount: document.querySelectorAll('#app-loader, .app-loader').length,
            cardCount: document.querySelectorAll('.hot-card').length,
            loadedPosterCount: Array.from(document.querySelectorAll('.hot-card img'))
                .filter(img => img.complete && img.naturalWidth > 20).length,
            visibleTitles: Array.from(document.querySelectorAll('.movie-title, .media-card-title'))
                .slice(0, 8)
                .map(node => node.textContent.trim())
        }))()`);
        assert.equal(visualState.loaderCount, 0, 'Startup loader is still visible during screenshot capture.');
        assert.ok(visualState.cardCount > 0, 'Homepage cards are missing during screenshot capture.');
        assert.ok(visualState.loadedPosterCount >= 5, 'Homepage posters did not load during screenshot capture.');
        const captures = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const image = await win.webContents.capturePage();
            const png = image.toPNG();
            captures.push({ image, png, bytes: png.length });
            await delay(500);
        }
        captures.sort((left, right) => right.bytes - left.bytes);
        const selectedCapture = captures[0];
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        fs.writeFileSync(screenshotPath, selectedCapture.png);

        console.log(JSON.stringify({
            ok: true,
            screenshotPath,
            captureBytes: captures.map(capture => capture.bytes),
            visualState,
            doubanOpenRoute,
            ...state
        }, null, 2));
        app.exit(0);
    } catch (error) {
        let state = null;
        try {
            state = await win.webContents.executeJavaScript(`(() => ({
                hasVue: Boolean(window.vueApp),
                isAuthenticated: Boolean(window.vueApp && window.vueApp.isAuthenticated),
                recommendationMode: window.vueApp && window.vueApp.recommendationMode,
                hasDiagnostics: Boolean(window.vueApp && window.vueApp.recommendationDiagnostics),
                rowKeys: window.vueApp ? Object.keys(window.vueApp.rowLists || {}) : [],
                bodyText: document.body.innerText.slice(0, 500)
            }))()`);
        } catch {}
        console.error(JSON.stringify({
            error: error.stack || error.message,
            state,
            consoleMessages
        }, null, 2));
        app.exit(1);
    }
});
