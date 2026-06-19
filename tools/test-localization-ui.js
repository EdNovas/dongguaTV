const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');

const appUrl = process.env.LOCALIZATION_QA_URL || 'http://127.0.0.1:31386/';
const targetUrl = `${appUrl}${appUrl.includes('?') ? '&' : '?'}localizationQa=${Date.now()}`;

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
    await delay(100);
}

async function readUi(win) {
    return win.webContents.executeJavaScript(`(() => ({
        language: window.vueApp.uiLanguage,
        htmlLang: document.documentElement.lang,
        nav: Array.from(document.querySelectorAll('.appletv-nav-item span'))
            .map(node => node.textContent.trim()),
        searchPlaceholder: document.querySelector('.search-input')?.getAttribute('placeholder') || '',
        settingsTitle: document.querySelector('.info-modal h3')?.textContent.trim() || '',
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

        await setLanguage(win, 'zh-CN');
        console.log(JSON.stringify({
            ok: true,
            checkedLanguages: Object.keys(results),
            languageOptions: results['zh-CN'].languageOptions
        }, null, 2));
        app.exit(0);
    } catch (error) {
        console.error(error.stack || error.message);
        app.exit(1);
    }
});
