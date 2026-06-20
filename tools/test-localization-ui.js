const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appUrl = process.env.LOCALIZATION_QA_URL || 'http://127.0.0.1:31386/';
const targetUrl = `${appUrl}${appUrl.includes('?') ? '&' : '?'}localizationQa=${Date.now()}`;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donggua-localization-'));

app.setPath('userData', userDataDir);
app.commandLine.appendSwitch('disable-gpu');

const expected = {
    'zh-CN': {
        nav: ['首页', '搜索', '电影', '剧集', '动漫', '综艺', '直播', '订阅源', '设置'],
        searchPlaceholder: '搜索电影、剧集、动漫、直播频道或订阅源...',
        settingsTitle: '播放器与应用设置'
    },
    'ja-JP': {
        nav: ['ホーム', '検索', '映画', 'ドラマ', 'アニメ', 'バラエティ', 'ライブ', '配信元', '設定'],
        searchPlaceholder: '映画、ドラマ、アニメ、ライブ、配信元を検索...',
        settingsTitle: 'プレーヤーとアプリ設定'
    },
    'en-US': {
        nav: ['Home', 'Search', 'Movies', 'Series', 'Anime', 'Variety', 'Live', 'Sources', 'Settings'],
        searchPlaceholder: 'Search movies, series, anime, live channels, or sources...',
        settingsTitle: 'Player and App Settings'
    }
};

function cleanupAndExit(code) {
    try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
    app.exit(code);
}

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

async function setLanguage(win, language) {
    await win.webContents.executeJavaScript(`(() => {
        const vm = window.vueApp;
        vm.uiLanguage = ${JSON.stringify(language)};
        vm.changeUiLanguage();
        vm.showSettingsModal = true;
        vm.$forceUpdate();
    })()`);
    await waitFor(win, 'document.querySelector(".info-modal select")');
    await waitFor(win, 'document.querySelector("[data-testid=\\"settings-back\\"]")?.innerText.trim()');
}

async function readUi(win) {
    return win.webContents.executeJavaScript(`(() => ({
        language: window.vueApp.uiLanguage,
        htmlLang: document.documentElement.lang,
        nav: Array.from(document.querySelectorAll('.appletv-nav-item span'))
            .map(node => node.textContent.trim()),
        searchPlaceholder: document.querySelector('.search-input')?.getAttribute('placeholder') || '',
        settingsTitle: document.querySelector('.info-modal h2')?.textContent.trim() || '',
        languageOptions: Array.from(document.querySelectorAll('.info-modal select option'))
            .slice(0, 3)
            .map(node => node.textContent.trim()),
        savedLanguage: localStorage.getItem('donggua_ui_language')
    }))()`);
}

function verifyLanguage(language, state) {
    assert.equal(state.language, language);
    assert.equal(state.htmlLang, language);
    assert.equal(state.savedLanguage, language);
    assert.deepEqual(state.nav, expected[language].nav);
    assert.equal(state.searchPlaceholder, expected[language].searchPlaceholder);
    assert.equal(state.settingsTitle, expected[language].settingsTitle);
    assert.deepEqual(state.languageOptions, ['简体中文', 'English', '日本語']);
}

async function verifyChineseInteractions(win) {
    await setLanguage(win, 'zh-CN');
    const settings = await win.webContents.executeJavaScript(`(() => ({
        back: document.querySelector('[data-testid="settings-back"]')?.innerText.trim() || '',
        text: document.querySelector('.info-modal')?.innerText || '',
        misleadingToggle: (document.querySelector('.info-modal')?.innerText || '').includes('Prefer external player for heavy streams')
    }))()`);
    assert.equal(settings.back, '返回');
    assert.match(settings.text, /隐藏随机推荐栏目/);
    assert.match(settings.text, /过滤成人内容/);
    assert.match(settings.text, /外部播放器/);
    assert.match(settings.text, /保存设置/);
    assert.equal(settings.misleadingToggle, false);
    assert.doesNotMatch(settings.text, /Runtime config files|No user TVBox subscription|Prefer external player|Save settings|Proxy status/);

    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="proxy-status"]').click()`);
    await waitFor(win, `window.vueApp.playerSettingsMessage === '代理状态已更新'`);

    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="settings-back"]').click()`);
    await waitFor(win, '!window.vueApp.showSettingsModal');

    await win.webContents.executeJavaScript(`(() => {
        window.vueApp.showSubscriptionPanel = true;
        window.vueApp.loadSubscriptionData();
    })()`);
    await waitFor(win, 'document.querySelector("[data-testid=\\"subscription-back\\"]")');
    await waitFor(win, '!window.vueApp.subscriptionLoading');
    const subscription = await win.webContents.executeJavaScript(`(() => ({
        back: document.querySelector('[data-testid="subscription-back"]')?.innerText.trim() || '',
        text: document.querySelector('.info-modal')?.innerText || '',
        error: window.vueApp.subscriptionError
    }))()`);
    assert.equal(subscription.back, '返回');
    assert.match(subscription.text, /仅导入你自己的 TVBox JSON 地址/);
    assert.match(subscription.text, /导入订阅/);
    assert.match(subscription.text, /全部刷新/);
    assert.equal(subscription.error, '');

    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="subscription-refresh"]').click()`);
    await waitFor(win, `window.vueApp.subscriptionMessage === '订阅数据已刷新'`);

    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="subscription-back"]').click()`);
    await waitFor(win, '!window.vueApp.showSubscriptionPanel');

    await win.webContents.executeJavaScript(`(() => {
        const vm = window.vueApp;
        vm.showSettingsModal = false;
        vm.showSubscriptionPanel = false;
        vm.keyword = '不存在的测试片名987654321';
        vm.doSearch();
    })()`);
    await waitFor(win, 'window.vueApp.searched && !window.vueApp.loading', 60000);
    await waitFor(win, 'document.querySelector("[data-testid=\\"search-diagnostics-refresh\\"]")', 60000);
    await waitFor(win, 'window.vueApp.searchDiagnostics && !window.vueApp.searchDiagnosticsLoading', 60000);
    const diagnostics = await win.webContents.executeJavaScript(`(() => {
        const text = document.body.innerText;
        return {
            text,
            hasRefresh: Boolean(document.querySelector('[data-testid="search-diagnostics-refresh"]')),
            hasSubscriptions: Boolean(document.querySelector('[data-testid="search-open-subscriptions"]')),
            hasSettings: Boolean(document.querySelector('[data-testid="search-open-settings"]')),
            hasHome: Boolean(document.querySelector('[data-testid="search-go-home"]'))
        };
    })()`);
    assert.match(diagnostics.text, /没有找到：“不存在的测试片名987654321”/);
    assert.match(diagnostics.text, /搜索诊断/);
    assert.match(diagnostics.text, /搜索会使用内置 HTTP 站点/);
    assert.match(diagnostics.text, /请尝试其他片名/);
    assert.doesNotMatch(diagnostics.text, /No results for|Search Diagnostics|Try alternate titles/);
    assert.equal(diagnostics.hasRefresh, true);
    assert.equal(diagnostics.hasSubscriptions, true);
    assert.equal(diagnostics.hasSettings, true);
    assert.equal(diagnostics.hasHome, true);

    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="search-open-settings"]').click()`);
    await waitFor(win, 'window.vueApp.showSettingsModal');
    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="settings-back"]').click()`);
    await waitFor(win, '!window.vueApp.showSettingsModal');

    await win.webContents.executeJavaScript(`document.querySelector('[data-testid="search-go-home"]').click()`);
    await waitFor(win, '!window.vueApp.searched');
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
        await waitFor(win, 'document.querySelectorAll(".appletv-nav-item span").length === 9');

        const results = {};
        for (const language of ['zh-CN', 'ja-JP', 'en-US']) {
            await setLanguage(win, language);
            results[language] = await readUi(win);
            verifyLanguage(language, results[language]);
        }

        await verifyChineseInteractions(win);
        await setLanguage(win, 'zh-CN');
        console.log(JSON.stringify({
            ok: true,
            checkedLanguages: Object.keys(results),
            languageOptions: results['zh-CN'].languageOptions
        }, null, 2));
        cleanupAndExit(0);
    } catch (error) {
        console.error(error.stack || error.message);
        cleanupAndExit(1);
    }
});
