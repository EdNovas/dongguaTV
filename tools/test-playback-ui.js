const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const appUrl = process.env.PLAYBACK_QA_URL || 'http://127.0.0.1:31386/';
const qaUrl = new URL(appUrl);
qaUrl.searchParams.set('_playbackQa', String(Date.now()));
const mediaUrl = process.env.PLAYBACK_QA_MEDIA_URL
    || 'http://127.0.0.1:31487/synthetic-player-test.mp4?token=qa%26safe';
const screenshotPath = process.env.PLAYBACK_QA_SCREENSHOT
    || path.join(process.cwd(), 'tmp', 'playback-ui-qa.png');
const messages = [];
const loadFailures = [];

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(win, expression, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const matched = await win.webContents.executeJavaScript(`Boolean(${expression})`);
        if (matched) return;
        await delay(150);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
}

async function readState(win) {
    return win.webContents.executeJavaScript(`(() => {
        const action = window.vueApp && window.vueApp.playbackAction;
        return {
            currentSource: window.vueApp && window.vueApp.currentSource && window.vueApp.currentSource.site_key,
            currentGroup: window.vueApp && window.vueApp.currentGroup && window.vueApp.currentGroup.name,
            currentUrl: window.vueApp && window.vueApp.currentUrl,
            showDetail: Boolean(window.vueApp && window.vueApp.showDetail),
            action: action ? { kind: action.kind, status: action.status, message: action.message, proxyUrl: action.proxyUrl } : null,
            diagnosticsOk: Boolean(window.vueApp && window.vueApp.playbackDiagnostics && window.vueApp.playbackDiagnostics.ok),
            classification: window.vueApp && window.vueApp.playbackClassification ? {
                recommendedPlayer: window.vueApp.playbackClassification.recommendedPlayer,
                reason: window.vueApp.playbackClassification.reason
            } : null,
            clipboard: window.__playbackQaClipboard || null,
            sourceCount: document.querySelectorAll('[data-testid="playback-source"]').length,
            statusVisible: Boolean(document.querySelector('[data-testid="playback-action-status"]')),
            detailOverlayExists: Boolean(document.querySelector('.detail-overlay')),
            appHasPlaybackMarkup: Boolean(document.querySelector('#app') && document.querySelector('#app').innerHTML.includes('playback-diagnose'))
        };
    })()`);
}

function finish(payload, exitCode) {
    console.log(JSON.stringify(payload, null, 2));
    app.exit(exitCode);
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 1000,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        messages.push({
            level,
            message: String(message).slice(0, 400),
            line,
            sourceId: String(sourceId).slice(0, 120)
        });
    });
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        loadFailures.push({ errorCode, errorDescription, validatedURL });
    });

    try {
        await win.loadURL(qaUrl.toString());
        await waitFor(win, 'window.vueApp', 15000);
        await waitFor(
            win,
            'document.getElementById("app-loader") && document.getElementById("app-loader").classList.contains("hidden")',
            45000
        );
        const sourceStructure = await win.webContents.executeJavaScript(`(async () => {
            const html = await fetch(location.href, { cache: 'no-store' }).then(response => response.text());
            const parsed = new DOMParser().parseFromString(html, 'text/html');
            const detail = parsed.querySelector('.detail-overlay');
            const ancestry = [];
            let node = detail;
            while (node && ancestry.length < 8) {
                ancestry.push({
                    tag: node.tagName,
                    id: node.id || null,
                    className: typeof node.className === 'string' ? node.className : null,
                    condition: node.getAttribute && node.getAttribute('v-if')
                });
                node = node.parentElement;
            }
            return {
                detailExists: Boolean(detail),
                insideApp: Boolean(detail && parsed.querySelector('#app') && parsed.querySelector('#app').contains(detail)),
                ancestry
            };
        })()`);
        if (!sourceStructure.detailExists || !sourceStructure.insideApp || sourceStructure.ancestry[1]?.className !== 'appletv-main') {
            throw new Error(`Playback detail markup is nested incorrectly: ${JSON.stringify(sourceStructure)}`);
        }

        await win.webContents.executeJavaScript(`(() => {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {
                    writeText: async value => {
                        window.__playbackQaClipboard = value;
                    }
                }
            });

            const headers = {
                Referer: 'https://donggua.test/player',
                'User-Agent': 'DongguaTV-Player-Test/1.0',
                Authorization: 'Bearer local-player-test'
            };
            const firstUrl = ${JSON.stringify(mediaUrl)};
            const secondUrl = firstUrl + '&line=2';
            const first = {
                site_key: 'qa-line-1',
                site_name: 'QA Line 1',
                vod_id: 'qa-video',
                vod_name: 'Playback UI QA',
                vod_play_url: 'Line 1$' + firstUrl,
                latency: 20,
                _testType: 'direct',
                _headers: headers,
                _sourceKind: 'cloud-drive'
            };
            const second = {
                site_key: 'qa-line-2',
                site_name: 'QA Line 2',
                vod_id: 'qa-video',
                vod_name: 'Playback UI QA',
                vod_play_url: 'Line 2$' + secondUrl,
                latency: 40,
                _testType: 'direct',
                _headers: headers,
                _sourceKind: 'cloud-drive'
            };

            const vm = window.vueApp;
            vm.currentGroup = { name: 'Playback UI QA', pic: '', sources: [first, second] };
            vm.currentSource = first;
            vm.episodeList = [{ name: 'Line 1', url: firstUrl }];
            vm.currentUrl = firstUrl;
            vm.showDetail = true;
            vm.dismissFirstRunGuide();
            vm.loadingDetail = false;
            vm.playbackAction = null;
            vm.playbackDiagnostics = null;
            vm.playbackClassification = null;
            document.body.classList.add('detail-open');
            vm.$forceUpdate();
            vm.$nextTick(() => window.scrollTo(0, 0));
        })()`);

        await waitFor(win, 'document.querySelector("[data-testid=\\"playback-diagnose\\"]")');
        await waitFor(win, 'document.querySelectorAll("[data-testid=\\"playback-source\\"]").length === 2');

        await win.webContents.executeJavaScript(
            'document.querySelector("[data-testid=\\"playback-diagnose\\"]").click()'
        );
        await waitFor(win, 'window.vueApp.playbackAction && window.vueApp.playbackAction.status !== "working"');
        const diagnostics = await readState(win);
        if (!diagnostics.diagnosticsOk || diagnostics.action.status !== 'success') {
            throw new Error(`Playback diagnostics did not pass: ${JSON.stringify(diagnostics)}`);
        }
        await win.webContents.executeJavaScript(`(() => {
            const guide = Array.from(document.querySelectorAll('.info-modal-overlay'))
                .find(node => node.textContent.includes('First Run Guide'));
            if (guide) guide.remove();
            document.getElementById('app-loader')?.remove();
        })()`);
        win.showInactive();
        await delay(300);
        const image = await win.webContents.capturePage();
        win.hide();
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        fs.writeFileSync(screenshotPath, image.toPNG());

        await win.webContents.executeJavaScript(
            'document.querySelector("[data-testid=\\"playback-copy-proxy\\"]").click()'
        );
        await waitFor(win, 'window.vueApp.playbackAction && window.vueApp.playbackAction.kind === "proxy" && window.vueApp.playbackAction.status !== "working"');
        const proxyCopy = await readState(win);
        if (proxyCopy.action.status !== 'success' || !/^http:\/\/127\.0\.0\.1:\d+\/play\//.test(proxyCopy.clipboard || '')) {
            throw new Error(`Proxy URL copy failed: ${JSON.stringify(proxyCopy)}`);
        }

        await win.webContents.executeJavaScript(
            'document.querySelectorAll("[data-testid=\\"playback-source\\"]")[1].click()'
        );
        await waitFor(win, 'window.vueApp.currentSource && window.vueApp.currentSource.site_key === "qa-line-2"');
        const sourceSwitch = await readState(win);
        if (sourceSwitch.action !== null || sourceSwitch.diagnosticsOk) {
            throw new Error(`Source switch retained stale playback state: ${JSON.stringify(sourceSwitch)}`);
        }

        await win.webContents.executeJavaScript(
            'document.querySelector("[data-testid=\\"playback-open-mpv\\"]").click()'
        );
        await waitFor(win, 'window.vueApp.playbackAction && window.vueApp.playbackAction.kind === "mpv" && window.vueApp.playbackAction.status !== "working"', 15000);
        const mpvLaunch = await readState(win);
        if (mpvLaunch.action.status !== 'success') {
            throw new Error(`mpv.net launch failed: ${JSON.stringify(mpvLaunch)}`);
        }

        finish({
            ok: true,
            diagnostics,
            proxyCopy,
            sourceSwitch,
            mpvLaunch,
            sourceStructure,
            loadFailures,
            consoleMessages: messages.slice(-20),
            screenshotPath
        }, 0);
    } catch (error) {
        try {
            const image = await win.webContents.capturePage();
            fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
            fs.writeFileSync(screenshotPath, image.toPNG());
        } catch (_) {
            // Keep the original QA failure.
        }
        finish({
            ok: false,
            error: String(error && error.stack || error),
            state: await readState(win).catch(() => null),
            loadFailures,
            consoleMessages: messages.slice(-20),
            screenshotPath
        }, 1);
    }
});
