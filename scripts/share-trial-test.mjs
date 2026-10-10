#!/usr/bin/env node
// 分享链接试看(没登录先看几分钟,到点再要求登录)回归(离线、零网络):
//   node scripts/share-trial-test.mjs
//  ① public/index.html 里 <dg-trial-core> 那段纯函数:每部剧在本机累计的试看秒数(存储值不可信、7 天过期、最多 50 部、只增不减)
//  ② 登录门(Vue 之外那段脚本)在沙箱里真跑 showLoginScreen:还有试看时间 → 试看;用完了 / 站长关了 / 不是分享链接 → 照旧
//  ③ 在沙箱里真跑 Vue 方法:只有画面真在走才计时、后台补算有上限、到点暂停 + 退出全屏 + 出登录、到点后被播起来会按住、
//     登录后接着播并补上首页 / 历史 / 账号初始化、离开播放页回登录页、试看不写观看历史
//  ④ 服务器 SHARE_TRIAL_MINUTES 解析(两个后端同一口径)+ 模板接线(试看时不显示收藏 / 分享 / 投屏 / 离线缓存)
// 改 index.html 里登录门、深链、试看,或 /api/auth/check 后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

const coreM = /\/\/ <dg-trial-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-trial-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-trial-core> 段'); process.exit(1); }
const T = vm.runInNewContext(coreM[1] + '\n;DgTrial;', { Object, JSON, Number, String, Math });
const DAY = 86400e3, NOW0 = 1e12;

console.log('① 纯函数');
{
    for (const bad of [null, '', '坏的', '[]', '123', '{"a":1}', '{"a":{"s":"x","at":1}}']) ok(Object.keys(T.read(bad, NOW0)).length === 0, '存储值不对 → 当没有:' + bad);
    const m = T.read(JSON.stringify({ 兰香如故: { s: 120, at: NOW0 - DAY }, 老剧: { s: 99, at: NOW0 - 8 * DAY }, 未来: { s: 5, at: NOW0 + DAY }, 负数: { s: -3, at: NOW0 } }), NOW0);
    ok(Object.keys(m).join(',') === '兰香如故', '只留 7 天内、时间不在未来、秒数不为负的', Object.keys(m));
    ok(T.used(m, '  兰香如故 ') === 120 && T.used(m, '没看过') === 0, 'used 按剧名(去空格)查,没看过 = 0');
    ok(T.used(T.put(T.read('', NOW0), 'Friends', 7, NOW0), ' friends') === 7, '剧名不分大小写、不看首尾空格');
    const p = T.read(JSON.stringify({ ['__proto__']: { s: 1, at: NOW0 } }), NOW0);
    ok(Object.getPrototypeOf({}) === Object.prototype && T.used(p, '__proto__') === 1, '剧名是 __proto__ 也不会污染原型');
    let x = T.put(m, '兰香如故', 60, NOW0);
    ok(T.used(x, '兰香如故') === 120 && T.used(m, '兰香如故') === 120, 'put 只增不减(另一个标签页记的更多就留着),不改原对象');
    x = T.put(x, '兰香如故', 200, NOW0 + 1);
    ok(T.used(x, '兰香如故') === 200, 'put 记下更多的秒数');
    let big = T.read('', NOW0);
    for (let i = 0; i < 60; i++) big = T.put(big, '剧' + i, i, NOW0 + i);
    ok(Object.keys(big).length === 50 && T.used(big, '剧59') === 59 && T.used(big, '剧9') === 0, '最多记 50 部,挤掉最久没看的');
    ok(T.left(300, 0) === 300 && T.left(300, 299.6) === 0 && T.left(300, 400) === 0, 'left 剩余秒数(不为负)');
    ok(T.fmt(300) === '5:00' && T.fmt(65.4) === '1:05' && T.fmt(-3) === '0:00', 'fmt 分:秒');
}

const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
function any() {
    const f = function () { return any(); };
    return new Proxy(f, {
        get(t, k) {
            if (k === Symbol.toPrimitive) return () => '';
            if (k === 'then') return undefined;
            if (k === Symbol.iterator) return function* () { };
            return any();
        },
        apply() { return any(); }, construct() { return any(); }, set() { return true; }, has() { return true; }
    });
}
const sandbox = (obj) => {
    const ctx = new Proxy(obj, {
        has() { return true; },
        get(t, k) { if (k in t) return t[k]; if (k === 'window' || k === 'self' || k === 'globalThis') return ctx; return any(); },
        set(t, k, v) { t[k] = v; return true; }
    });
    return ctx;
};
const mkStore = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

console.log('② 登录门');
{
    const AUTH = scripts.find(s => s.includes('async function checkAuthStatus'));
    ok(!!AUTH && /function tryStartTrial\(name\)/.test(AUTH) && /SHARE_TRIAL_SEC = Math\.max\(0, Number\(data\.shareTrial\) \|\| 0\);/.test(AUTH), '登录门:读 /api/auth/check 的 shareTrial,有 tryStartTrial');
    const run = ({ search, sec, used, startResult }) => {
        const els = new Map();
        const el = id => {
            if (!els.has(id)) {
                const cls = new Set(id === 'password-screen' ? ['hidden'] : []);
                els.set(id, { id, style: {}, classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) }, cls, focus() { }, textContent: '', innerHTML: '' });
            }
            return els.get(id);
        };
        const calls = [];
        const ls = mkStore();
        if (used != null) ls.setItem('donggua_trial', JSON.stringify({ 兰香如故: { s: used, at: Date.now() } }));
        const o = {
            console: { log() { }, warn() { }, error() { } }, DgTrial: T, Date, JSON, Math, Number, String, Object, Array, Promise, URLSearchParams,
            localStorage: ls, sessionStorage: mkStore(), location: { search, pathname: '/' },
            document: { getElementById: el, addEventListener() { }, body: { classList: { add() { }, remove() { } } } },
            setTimeout: () => 0, clearTimeout() { }, setInterval: () => 0, clearInterval() { },
            fetch: () => new Promise(() => { }),
            vueApp: { showDeepLinkPreview: (meta) => calls.push('preview:' + meta.name) },
        };
        o.startTrial = (name, limit) => { calls.push('trial:' + name + ':' + limit); return startResult !== false; };
        const ctx = sandbox(o);
        vm.runInNewContext(AUTH + '\n;globalThis.__setTrialSec = v => { SHARE_TRIAL_SEC = v; };', ctx, { timeout: 5000 });
        o.__setTrialSec(sec);
        o.showLoginScreen();
        const scr = el('password-screen');
        return { calls, shown: !scr.cls.has('hidden') && scr.style.display !== 'none', deeplink: scr.cls.has('deeplink-mode') };
    };
    const q = '?play=' + encodeURIComponent('兰香如故') + '&ep=' + encodeURIComponent('第01集') + '&t=945&s=g5JxZLER9s';
    let r = run({ search: q, sec: 300 });
    ok(r.calls.join() === 'trial:兰香如故:300' && !r.shown, '没登录 + 分享链接 + 还有试看时间 → 直接试看,不出登录框、不渲染锁定框架', r);
    r = run({ search: q, sec: 300, used: 120 });
    ok(r.calls.join() === 'trial:兰香如故:300' && !r.shown, '这部剧看过 2 分钟 → 还能试看(剩下的时间由播放页接着算)', r);
    r = run({ search: q, sec: 300, used: 300 });
    ok(r.calls.join() === 'preview:兰香如故' && r.shown && r.deeplink, '这部剧的试看时间用完了 → 锁定框架 + 半透明登录框', r);
    r = run({ search: q, sec: 0 });
    ok(r.calls.join() === 'preview:兰香如故' && r.shown && r.deeplink, '站长关了试看(SHARE_TRIAL_MINUTES=0)→ 跟以前一样锁定 + 登录', r);
    r = run({ search: q, sec: 300, startResult: false });
    ok(r.calls.join() === 'trial:兰香如故:300,preview:兰香如故' && r.shown, '播放页没接受试看(已经初始化过)→ 退回锁定框架,不卡在空白页', r);
    r = run({ search: '', sec: 300 });
    ok(r.calls.length === 0 && r.shown && !r.deeplink, '不是分享链接 → 普通登录页(试看只给分享链接)', r);
}

console.log('③ 沙箱里真跑方法');
const SRC = scripts.find(s => s.includes('createApp({'));
let captured = null;
const clock = { now: NOW0 };
class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
const store = mkStore(), intervals = [], calls = [];
const loc = { search: '?play=' + encodeURIComponent('兰香如故') + '&ep=1', pathname: '/' };
const ctxObj = {
    Vue: { createApp(o) { captured = o; return { mount() { return {}; }, use() { return this; }, config: {} }; } },
    console: { log() { }, warn() { }, error() { }, info() { } },
    localStorage: store, sessionStorage: mkStore(), location: loc,
    history: { state: null, replaceState(s, t, u) { calls.push('replace:' + u); loc.search = String(u).includes('?') ? String(u).slice(String(u).indexOf('?')) : ''; } },
    setTimeout: () => 0, clearTimeout() { }, requestAnimationFrame: () => 0,
    setInterval: (fn, ms) => { intervals.push({ fn, ms, live: true }); return intervals.length; },
    clearInterval: id => { if (id && intervals[id - 1]) intervals[id - 1].live = false; },
    document: { fullscreenElement: null, pictureInPictureElement: null, addEventListener() { }, getElementById: () => null, querySelector: () => null, body: { classList: { add: c => calls.push('body+' + c), remove() { }, contains: () => false } } },
    addEventListener: (ev) => calls.push('listen:' + ev),
    showLoginForDeepLink: () => calls.push('loginOverlay'), showLoginScreen: () => calls.push('loginScreen'),
    Promise, JSON, Math, Date: FakeDate, Object, Array, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet, Symbol, Error, TypeError,
    URL, URLSearchParams, Uint8Array, ArrayBuffer, Proxy, Reflect, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, AbortController, TextEncoder, TextDecoder,
    scrollY: 0, innerHeight: 800, scrollTo() { },
};
const ctx = sandbox(ctxObj);
try { vm.runInNewContext(SRC + '\n;globalThis.__setDp = v => { dp = v; }; globalThis.__setKey = v => { TMDB_API_KEY = v; };', ctx, { timeout: 5000 }); } catch (e) { }
const M = (captured && captured.methods) || {}, CP = (captured && captured.computed) || {}, W = (captured && captured.watch) || {};
const names = ['startTrial', '_trialTick', '_trialSave', '_trialEnd', '_trialStop', '_trialFinish', '_trialRunDeferred', '_trialLeave', 'addToWatchHistory', 'promptLogin'];
ok(!!captured && names.every(n => typeof M[n] === 'function') && typeof CP.trialLeftText === 'function' && typeof ctxObj.__setDp === 'function', '沙箱里跑出了试看的方法', names.filter(n => typeof M[n] !== 'function'));
const D = (captured && typeof captured.data === 'function') ? captured.data.call(new Proxy({}, { get: () => any() })) : {};
ok(D.trial && D.trial.on === false && D.trial.ended === false && D.trial.used === 0, 'data:trial 默认关着');

// 假播放器:currentTime 由测试推进
const mkDp = () => {
    const v = { paused: false, ended: false, readyState: 4, currentTime: 945 };
    const d = { video: v, calls: [], pause() { v.paused = true; d.calls.push('pause'); }, play() { v.paused = false; d.calls.push('play'); }, fullScreen: { cancel: (t) => d.calls.push('cancel:' + t) } };
    return d;
};
function makeApp(over) {
    const app = Object.assign({
        trial: { on: false, ended: false, name: '', used: 0, limit: 0 },
        showDetail: false, deepLinkLoading: false, isTestingSources: false, currentGroup: null, hlsCutEnabled: false, _cfgHlsCut: true,
        watchHistory: [], watchStatsEnabled: true, _appInitialized: false,
    }, over || {});
    for (const n of Object.keys(CP)) Object.defineProperty(app, n, { get: () => CP[n].call(app), configurable: true });
    for (const n of Object.keys(M)) if (typeof M[n] === 'function') app[n] = M[n].bind(app);
    app.initApp = (o) => { calls.push('initApp:' + JSON.stringify(o)); return Promise.resolve(); };
    app.fetchHero = () => { calls.push('hero'); return Promise.resolve(); };
    app.fetchAllLists = () => calls.push('lists');
    app.loadWatchHistory = () => calls.push('history');
    app._shareOpenReport = () => calls.push('shareOpen');
    app._favRefreshMaybe = () => { };
    return app;
}
const tick = (app, sec, dpObj, adv) => { clock.now += sec * 1000; if (dpObj && adv !== undefined) dpObj.video.currentTime += adv; app._trialTick(); };
{
    // 开始试看:先出加载帧,只做试看那一套初始化
    store.m.clear(); calls.length = 0; intervals.length = 0;
    const a = makeApp();
    ok(a.startTrial('兰香如故', 300) === true, 'startTrial 返回 true');
    ok(a.trial.on && a.trial.limit === 300 && a.trial.used === 0 && a.showDetail && a.deepLinkLoading && a.currentGroup.name === '兰香如故' && calls.includes('body+detail-open'),
        '试看开始:立刻出播放页加载帧(不先露出空首页)', a.trial);
    ok(calls.includes('initApp:{"trial":true}') && intervals.some(i => i.live && i.ms === 1000) && calls.includes('listen:pagehide'), '只按试看模式初始化;每秒计时;关页时存一下');
    ok(a.startTrial('别的剧', 300) === false, '同一页不会开第二次试看');
    ok(a.trialLeftText === '5:00' && a.trialLimitText === '5 分钟', '剩余时间显示 5:00、总时长 5 分钟', [a.trialLeftText, a.trialLimitText]);

    // 计时:按画面实际往前走的时长算
    const d = mkDp(); ctxObj.__setDp(d);
    const near = (x, y) => Math.abs(x - y) < 0.01;
    tick(a, 1, d, 1);
    ok(a.trial.used === 0, '播放器刚出来那一拍只记起点(深链直接跳到 945 秒那一下不算看过)', a.trial.used);
    tick(a, 1, d, 1); tick(a, 1, d, 1);
    ok(near(a.trial.used, 2), '播放中每秒 +1', a.trial.used);
    d.video.paused = true; tick(a, 10, d, 0);
    ok(near(a.trial.used, 2), '暂停不算', a.trial.used);
    d.video.paused = false; d.video.readyState = 1; tick(a, 5, d, 0);
    ok(near(a.trial.used, 2), '缓冲(readyState<2)不算', a.trial.used);
    d.video.readyState = 4; tick(a, 3, d, 0);
    ok(near(a.trial.used, 2), '在"播"但画面卡住不动不算', a.trial.used);
    tick(a, 1, d, 0.3); tick(a, 1, d, 0.2);
    ok(near(a.trial.used, 2.5), '网络差一卡一卡(两秒里画面只走了半秒)→ 只算半秒,不按墙钟白扣', a.trial.used);
    tick(a, 1, d, 1.1);
    ok(near(a.trial.used, 3.6), '定时器 / 帧边界抖动(一拍里走了 1.1 秒)按实际算', a.trial.used);
    tick(a, 1, d, 600);
    ok(near(a.trial.used, 4.8), '往后拖进度条:跳过去的不算看过(这一拍最多算 1 秒 + 0.2 容差)', a.trial.used);
    tick(a, 1, d, -900);
    ok(near(a.trial.used, 4.8), '往回拖 / 切到下一集从头播:不算', a.trial.used);
    d.video.playbackRate = 2; tick(a, 1, d, 2);
    ok(near(a.trial.used, 6.8), '2 倍速:一秒看了 2 秒内容就算 2 秒(试看 5 分钟 = 5 分钟内容)', a.trial.used);
    d.video.playbackRate = 1;
    tick(a, 60, d, 60);
    ok(near(a.trial.used, 66.8), '后台标签页一分钟才跑一次:按画面走过的补上', a.trial.used);
    tick(a, 120, d, 120);
    ok(near(a.trial.used, 137), '…流逝时间一次最多算 70 秒(电脑睡眠醒来后拖进度条不会被整段算上)', a.trial.used);
    ok(T.used(T.read(store.getItem('donggua_trial'), clock.now), '兰香如故') > 130, '每隔几秒存到本机(刷新不重新计时)');

    // 到点:暂停、退出全屏、出登录浮层
    d.calls.length = 0; calls.length = 0;
    tick(a, 70, d, 70); tick(a, 70, d, 70); tick(a, 70, d, 70); tick(a, 70, d, 70);
    ok(a.trial.ended && a.trial.used === 300 && a.trialLeftText === '0:00', '满 5 分钟 → 试看结束', a.trial);
    ok(d.calls.includes('pause') && d.calls.includes('cancel:browser') && d.calls.includes('cancel:web') && calls.includes('loginOverlay'), '到点暂停、退出全屏 / 网页全屏、出半透明登录浮层', [d.calls, calls]);
    ok(T.used(T.read(store.getItem('donggua_trial'), clock.now), '兰香如故') === 300, '用完的时间存到本机(换个标签页打开同一部也不能重新试看)');
    d.calls.length = 0; d.video.paused = false;
    tick(a, 1, d, 1);
    ok(d.calls.includes('pause') && a.trial.used === 300, '时间到了又被播起来(空格 / 媒体键 / 切集)→ 一秒内按住', d.calls);

    // 试看中不记观看历史
    a.watchHistory = [];
    a.addToWatchHistory('兰香如故', '', '第01集', 10, 100, { name: '兰香如故', sources: [] });
    ok(a.watchHistory.length === 0, '试看(没登录)不写观看历史(不然会把本机原有历史盖掉)');

    // 登录成功:接着播、补初始化
    calls.length = 0; d.calls.length = 0;
    a._trialBoot = 'done'; ctxObj.__setKey('k');
    a._trialFinish();
    ok(!a.trial.on && !a.trial.ended && a.hlsCutEnabled === true && d.calls.includes('play'), '登录后:试看结束、恢复剪插播开关、从暂停处接着播', [a.trial, d.calls]);
    ok(['hero', 'lists', 'history', 'shareOpen'].every(x => calls.includes(x)) && !a._trialBoot && !intervals.some(i => i.live), '…补上首页轮播 / 榜单、观看历史(连带云同步与收藏)、分享打开上报;计时器停了', calls);
}
{
    // 初始化还没跑完就登录了:标记 upgrade,由 initApp 收尾时补
    calls.length = 0; intervals.length = 0; store.m.clear();
    const a = makeApp();
    a.startTrial('兰香如故', 300);
    a._trialFinish();
    ok(a._trialBoot === 'upgrade' && !calls.includes('history'), '初始化还在跑时登录 → 记下 upgrade,不提前补(initApp 收尾时补)');
    ok(/if \(trial\) \{\s*if \(this\._trialBoot === 'upgrade'\) this\._trialRunDeferred\(\);[^\n]*\n\s*else this\._trialBoot = 'done';\s*\}/.test(SRC), 'initApp 收尾:upgrade → 立刻补;否则记 done');
}
{
    // 试看中离开播放页 → 去掉 ?play=,出普通登录页
    calls.length = 0; intervals.length = 0;
    loc.search = '?play=' + encodeURIComponent('兰香如故');
    const a = makeApp();
    a.startTrial('兰香如故', 300);
    a.showDetail = false;
    (typeof W.showDetail === 'function' ? W.showDetail : W.showDetail.handler).call(a, false);
    ok(!a.trial.on && calls.includes('replace:/') && calls.includes('loginScreen') && calls.indexOf('replace:/') < calls.indexOf('loginScreen') && !intervals.some(i => i.live),
        '关掉播放页 / 深链没搜到 → 停止试看,先清掉 ?play= 再出登录页(不然又被当成分享链接)', calls);
    ok(a._trialBoot === 'running', '…登录后照样走 _trialFinish 补初始化');
    const b = makeApp();
    calls.length = 0;
    (typeof W.showDetail === 'function' ? W.showDetail : W.showDetail.handler).call(b, false);
    ok(!calls.includes('loginScreen'), '没在试看时关播放页:不出登录页');
}

console.log('④ 服务器 / 模板接线');
{
    for (const f of ['server.js', 'api/index.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const m = /const SHARE_TRIAL_SEC = \(\(\) => \{[\s\S]*?\}\)\(\);/.exec(src);
        ok(!!m && /shareTrial: SHARE_TRIAL_SEC/.test(src), f + ':有 SHARE_TRIAL_SEC,/api/auth/check 返回 shareTrial');
        if (!m) continue;
        const val = env => vm.runInNewContext(m[0] + '\n;SHARE_TRIAL_SEC;', { process: { env }, Number, Math, String });
        const cases = [[{}, 300], [{ SHARE_TRIAL_MINUTES: '' }, 300], [{ SHARE_TRIAL_MINUTES: '0' }, 0], [{ SHARE_TRIAL_MINUTES: '3' }, 180], [{ SHARE_TRIAL_MINUTES: '0.5' }, 30],
            [{ SHARE_TRIAL_MINUTES: '1000' }, 7200], [{ SHARE_TRIAL_MINUTES: 'abc' }, 0], [{ SHARE_TRIAL_MINUTES: '-1' }, 0]];
        const got = cases.map(([e]) => val(e));
        ok(JSON.stringify(got) === JSON.stringify(cases.map(c => c[1])), f + ':SHARE_TRIAL_MINUTES 默认 5 分钟、0 / 非数字 / 负数 = 关、最多 120 分钟', got);
    }
    const s = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), a = fs.readFileSync(path.join(ROOT, 'api/index.js'), 'utf8');
    const iife = t => (/const SHARE_TRIAL_SEC = \(\(\) => \{[\s\S]*?\}\)\(\);/.exec(t) || [''])[0];
    ok(iife(s) && iife(s) === iife(a), '两个后端的解析逐字一致');

    ok(/window\.startApp = \(\) => \{\s*\/\/[^\n]*\n\s*if \(this\._trialBoot\) return this\._trialFinish\(\);/.test(SRC) && /window\.startTrial = \(name, limit\) => this\.startTrial\(name, limit\);/.test(SRC),
        '登录成功的 startApp 先看是不是试看转正;startTrial 暴露给登录门');
    ok(/if \(TMDB_API_KEY && !trial\) \{/.test(SRC) && /if \(!trial\) this\.loadWatchHistory\(\);/.test(SRC) && /this\.hlsCutEnabled = this\._cfgHlsCut && !this\.trial\.on;/.test(SRC),
        '试看模式的 initApp:不加载首页内容和观看历史,不交剪后清单(那个接口要令牌)');
    ok(/r\.status !== 429 && r\.status !== 401 && r\.status !== 403 && r\.status < 500 && !perEpisode\) this\._markNativeBad\(job\.site\)/.test(HTML), '剪后清单交付 401 / 403 不记"这个站剪不了"');
    const TPL = HTML.slice(HTML.indexOf('<div id="app" v-cloak>'));
    ok(/<div v-if="trial\.on" class="trial-bar">[\s\S]*?\{\{ trialLimitText \}\}[\s\S]*?\{\{ trialLeftText \}\}[\s\S]*?@click="promptLogin"/.test(TPL), '标题下有试看剩余时间 + 登录按钮');
    ok(/<div v-if="trial\.on && trial\.ended" class="preview-lock-overlay trial-end">[\s\S]*?试看结束[\s\S]*?@click="promptLogin"/.test(TPL), '到点后播放器上盖"试看结束"遮罩 + 立即登录');
    ok(/\.preview-lock-overlay\.trial-end \{ z-index: 2000; \}/.test(HTML), '…遮罩盖过播放器暂停时的大播放键(z-index 1000)和控制栏,点不到播放');
    ok(/'trial-ended': trial\.on && trial\.ended/.test(TPL) && /\.player-box\.trial-ended \.desktop-play-overlay \{ display: none; \}/.test(HTML), '…大播放键也藏起来(半透明遮罩后面不再透出一个播放键)');
    ok(/v-if="favoritesEnabled && !previewLocked && !trial\.on/.test(TPL) && /<div v-if="!previewLocked && !trial\.on" style="display: flex; gap: 10px; align-items: center;">\s*<button class="btn-cast"[^>]*@click="openSharePanel"/.test(TPL)
        && /'dg-no-frame': previewLocked \|\| trial\.on/.test(TPL) && /<span v-if="!previewLocked && !trial\.on" @click="toggleOfflinePanel"/.test(TPL),
        '试看时不显示收藏、分享、投屏、分享当前画面、离线缓存(投屏 / 缓存后看不计试看时长)');
    ok(!/机场|v2board/i.test(TPL.slice(TPL.indexOf('class="trial-bar"'), TPL.indexOf('class="trial-bar"') + 600)), '试看的文案不提机场(两个分支通用)');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
