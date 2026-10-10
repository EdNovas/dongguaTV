#!/usr/bin/env node
// 首页板块顺序 / 开关 + 偏好设置弹窗回归(离线、零网络):
//   node scripts/home-layout-test.mjs
//  ① public/index.html 里 <dg-home-core> 那段纯函数:七个板块、存储值规整(旧版本 / 别的设备 / 手改)、
//     老的「隐藏随机盲盒」迁移、换位
//  ② 模板接线:首页按 homeBlocks 顺序渲染、设置弹窗限高可滚动、两个入口开的是同一个弹窗;整份 #app 模板用 Vue 编译器编一遍
//  ③ 在沙箱里真跑 Vue 方法 / 计算属性:首页块顺序、设置里上移下移(跳过没列出的板块)、开关、推服务器只推最后一次、
//     拉取时不盖掉本机还没推的改动、ref 在 v-for 里是数组时滚动 / 跳转照常
// 改 index.html 里首页板块、偏好设置弹窗任何一处后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };   // worktree 没有 node_modules 时走 NODE_PATH
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const ks = layout => layout.map(s => s.k + (s.on ? '' : '(关)')).join(',');

const coreM = /\/\/ <dg-home-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-home-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-home-core> 段'); process.exit(1); }
const H = vm.runInNewContext(coreM[1] + '\n;DgHome;', { Array, Object, JSON, Set, String });
const DEF = 'history,fav,recommend,popular,live,catnav,random';

console.log('① 纯函数');
{
    ok(H.SECTIONS.map(s => s.k).join(',') === DEF && H.SECTIONS.every(s => s.l && /^fa-/.test(s.icon)), '七个板块:继续观看 / 收藏 / 为你推荐 / 大家都在看 / 直播 / 分类栏 / 随机盲盒,都有名字和图标');
    ok(ks(H.normalize(null)) === DEF, '没有值 → 默认顺序、全开');
    for (const bad of ['x', 123, {}, { k: 'history' }, [null, 1, 'nope', { k: 'zzz' }]]) ok(ks(H.normalize(bad)) === DEF, '乱七八糟的值 → 默认:' + JSON.stringify(bad));
    ok(ks(H.normalize([{ k: 'random', on: false }, { k: 'zzz' }, { k: 'history' }, { k: 'random', on: true }])) === 'random(关),history,fav,recommend,popular,live,catnav',
        '认得的按给定顺序留下、重复的只留第一个、不认得的丢掉、没给到的按默认顺序补在后面', ks(H.normalize([{ k: 'random', on: false }, { k: 'zzz' }, { k: 'history' }, { k: 'random', on: true }])));
    ok(ks(H.normalize(['live', 'catnav'])) === 'live,catnav,history,fav,recommend,popular,random', '只存了键名的也认(当开着)');
    ok(H.normalize([{ k: 'fav' }])[0].on === true && H.normalize([{ k: 'fav', on: false }])[0].on === false, '没写 on 当开着,on:false 才是关');
    ok(ks(H.initial(null, false)) === DEF, '没存过、老版本也没关随机盲盒 → 默认');
    ok(ks(H.initial(null, true)) === 'history,fav,recommend,popular,live,catnav,random(关)', '老版本关了随机盲盒 → 迁移成随机盲盒关');
    ok(ks(H.initial('{坏的 json', true)) === 'history,fav,recommend,popular,live,catnav,random(关)', '存的值坏了 → 当没存过(老设置照样迁移)');
    const saved = JSON.stringify([{ k: 'random', on: true }, { k: 'catnav', on: false }]);
    ok(ks(H.initial(saved, true)) === 'random,catnav(关),history,fav,recommend,popular,live', '存过新布局 → 用新布局,不再看老的隐藏随机盲盒');
    const d = H.normalize(null);
    const sw = H.swap(d, 'random', 'catnav');
    ok(ks(sw) === 'history,fav,recommend,popular,live,random,catnav' && ks(d) === DEF, 'swap 换位、不改原数组');
    ok(H.swap(d, 'random', 'zzz') === d && H.swap(d, 'fav', 'fav') === d, 'swap 不认得的键 / 同一个 → 原样返回');
    ok(H.isDefault(d) && !H.isDefault(sw) && !H.isDefault(H.normalize([{ k: 'history', on: false }])), 'isDefault:顺序和开关都是默认才算');
    ok(H.info('live').l === '直播频道' && H.info('nope') === null, 'info 查名字');
}

console.log('② 模板接线');
{
    const appStart = HTML.indexOf('<div id="app" v-cloak>');
    const mainScriptAt = HTML.indexOf('createApp({');
    const scriptOpen = HTML.lastIndexOf('<script', mainScriptAt);
    const tplEnd = HTML.lastIndexOf('</div>', scriptOpen);
    const TPL = HTML.slice(appStart + '<div id="app" v-cloak>'.length, tplEnd);
    ok(appStart > 0 && tplEnd > appStart, '找到 #app 模板');

    // 首页:一个 v-for 按 homeBlocks 排,七种块各一个分支,榜单行是最后的 v-else
    ok(/<div v-show="!offHome" class="home-flow">\s*(?:<!--[\s\S]*?-->\s*)?<template v-for="\(\{ id, k, key, config \}, bi\) in homeBlocks" :key="id">/.test(TPL), '首页内容区:<template v-for … in homeBlocks :key="id">');
    for (const k of ['history', 'fav', 'recommend', 'popular', 'live']) ok(new RegExp(`<div v-(?:else-)?if="k === '${k}'" class="section-container home-sec`).test(TPL), `板块 ${k} 是 homeBlocks 的一个分支,用统一间距(home-sec)`);
    ok(/<section v-else-if="k === 'catnav'" class="catnav/.test(TPL), '分类栏是一个分支');
    ok(/<div v-else class="section-container animate__animated animate__fadeInUp" :class="\{ 'home-first': bi === 0 \}"\s*:ref="key \+ '-section'" :data-row-key="key">/.test(TPL), '榜单行(随机盲盒 + 其余分类)是 v-else 分支,ref / data-row-key 照旧');
    ok((TPL.match(/'home-first': bi === 0/g) || []).length === 7, '七种块都会在排第一时拿到 home-first(上边距 60)');
    ok(!/v-for="\(config, key, index\) in rowConfigs"/.test(TPL) && !/key === 'randomRow' && hideRandomRow/.test(TPL), '不再直接遍历 rowConfigs、不再用 v-show 藏随机盲盒');
    ok(!/style="margin-top: 60px; margin-bottom: 10px;"/.test(TPL) && !/marginTop: watchHistory\.length \? '48px' : '60px'/.test(TPL), '旧的"按上面是谁"写死的边距删掉了');
    ok(/\.home-flow > \.home-sec \{ margin-top: 48px; margin-bottom: 44px; \}/.test(HTML) && /\.home-flow > \.home-first \{ margin-top: 60px; \}/.test(HTML), '间距 CSS:板块 48/44,第一个 60');
    ok(/v-if="!hideRandomRow"[^>]*catNavJump\('random'\)/.test(TPL) && /v-if="recommendList\.length > 0 && homeOn\.recommend"[^>]*catNavJump\('recommend'\)/.test(TPL), '分类栏的快捷入口跟着板块开关藏');

    // 偏好设置弹窗:右下角齿轮和页脚「偏好设置」开的是同一个弹窗;限高 + 内容区滚动 + 标题栏固定
    ok(/class="btn-settings" @click="showSettingsModal = true"/.test(TPL) && /class="tv-mode-toggle" @click="showSettingsModal = true" title="偏好设置"/.test(TPL), '右下角齿轮、页脚「偏好设置」都打开 showSettingsModal');
    ok((TPL.match(/v-if="showSettingsModal"/g) || []).length === 1, '只有一个偏好设置弹窗(两个入口共用,改一处两边都生效)');
    ok(/<div class="info-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">\s*<div class="settings-head">[\s\S]*?<\/div>\s*<div class="settings-body">/.test(TPL), '弹窗结构:标题栏 settings-head + 滚动区 settings-body');
    ok(/\.settings-modal \{[^}]*max-height: calc\(100vh - 40px\);[^}]*max-height: calc\(100dvh - 40px\);/.test(HTML) && /\.settings-body \{[^}]*min-height: 0;[^}]*overflow-y: auto;/.test(HTML), '弹窗最高到屏幕高度(vh 兜底 + dvh),内容区 overflow-y:auto');
    ok(/@media \(max-height: 760px\) \{[\s\S]*?\.set-row, \.set-block \{ padding: 10px 0; \}/.test(HTML), '矮屏把行距收紧');
    const modal = TPL.slice(TPL.indexOf('v-if="showSettingsModal"'), TPL.indexOf('<!-- ★★★ TMDb 电影详情弹窗 ★★★ -->'));
    ok(!/hideRandomRow/.test(modal) && !/隐藏随机盲盒/.test(modal), '旧的「隐藏随机盲盒」开关去掉了(并进首页板块)');
    ok(/<li v-for="\(s, i\) in homeLayoutView" :key="s\.k"/.test(modal) && /moveHomeSection\(s\.k, -1\)/.test(modal) && /moveHomeSection\(s\.k, 1\)/.test(modal)
        && /toggleHomeSection\(s\.k, \$event\.target\.checked\)/.test(modal) && /@click="resetHomeLayout"/.test(modal), '首页板块:逐个列出,上移 / 下移 / 开关 / 恢复默认');
    ok(/:data-home-mv="s\.k \+ ':-1'" :disabled="i === 0"/.test(modal) && /:data-home-mv="s\.k \+ ':1'" :disabled="i === homeLayoutView\.length - 1"/.test(modal), '…头一个不能上移、最后一个不能下移');
    ok(/:aria-label="'上移' \+ s\.l"/.test(modal) && /:aria-label="'下移' \+ s\.l"/.test(modal) && /:aria-label="'在首页显示' \+ s\.l"/.test(modal) && /aria-live="polite">\{\{ homeLayoutMsg \}\}/.test(modal), '…按钮 / 开关有读屏名字,移动结果播报');
    ok(!/<div[^>]*@click="showSettingsModal = false; (?:openRequestModal|confirmLogout)/.test(modal) && /<button v-if="requestsEnabled" type="button" class="set-row is-link"/.test(modal) && /<button type="button" class="set-row is-link"\s*@click="showSettingsModal = false; confirmLogout\(\)">/.test(modal),
        '求片 / 退出登录是 button(键盘、遥控器能选到),不再是带 @click 的 div');
    for (const m of ["v-model=\"filterNsfw\" @change=\"saveSettings('filterNsfw')\"", "v-model=\"introSkipShow\" @change=\"saveSettings('introSkipShow')\"", "v-model=\"introSkipAuto\" @change=\"saveSettings('introSkipAuto')\"",
        '@click="setCoverScale(lv.v)"', 'v-if="pushUi !== \'hidden\'"', '@change="togglePush($event)"', '@change="showSettingsModal = false; toggleTVMode()"', '@click="refreshV2boardInfo"'])
        ok(modal.includes(m), '弹窗里原有的设置项还在:' + m);
    ok(/<i class="fas fa-user-circle" style="margin-right: 8px; color: #e50914;"><\/i>机场账户/.test(modal), '机场账户卡片的图标样式没丢');

    // 设置的存取:本机 donggua_home_layout,同步账号推 / 拉 user_settings.homeLayout
    ok(/homeLayout: \(function \(\) \{ try \{ return DgHome\.initial\(localStorage\.getItem\('donggua_home_layout'\), localStorage\.getItem\('donggua_hide_random'\) === 'true'\);/.test(HTML), 'data:homeLayout 从本机读,没存过时迁移老的隐藏随机盲盒');
    ok(/settings: \{ homeLayout: this\.homeLayout \}/.test(HTML) && /data\.settings\.homeLayout/.test(HTML), '推 / 拉服务器设置里的 homeLayout');
    ok(!/saveSettings\('hideRandomRow'\)|key === 'hideRandomRow'/.test(HTML), 'saveSettings 里旧的 hideRandomRow 分支删了');

    // 模板是写在 HTML 里的(in-DOM):浏览器先按 HTML 规则建 DOM,Vue 再编译 #app 的 innerHTML。
    //   结构用 parse5(和浏览器同一套解析规则)建树来查:闭合标签放错位置时,浏览器会把后面的分支嵌进前一个分支里
    const parse5 = dep('parse5');
    const attr = (n, name) => { const a = (n.attrs || []).find(x => x.name === name); return a ? a.value : null; };
    const kidsOf = n => ((n.nodeName === 'template' ? n.content : n).childNodes || []).filter(c => c.nodeName !== '#comment' && !(c.nodeName === '#text' && !c.value.trim()));
    const walk = function* (n) { yield n; for (const c of ((n.nodeName === 'template' ? n.content : n).childNodes || [])) yield* walk(c); };
    const findBy = (root, pred) => { for (const n of walk(root)) if (n.attrs && pred(n)) return n; return null; };
    const hasCls = c => n => (' ' + (attr(n, 'class') || '') + ' ').includes(' ' + c + ' ');
    // v-else / v-else-if 前面紧挨着的必须是 v-if / v-else-if(中间只能有空白和注释),否则 Vue 编译报错、整页白屏
    const brokenElse = root => {
        const bad = [];
        for (const n of walk(root)) {
            if (!n.childNodes && !n.content) continue;
            const ks2 = kidsOf(n);
            ks2.forEach((c, i) => {
                if (!c.attrs || (attr(c, 'v-else') === null && attr(c, 'v-else-if') === null)) return;
                const p = ks2[i - 1];
                if (!p || !p.attrs || (attr(p, 'v-if') === null && attr(p, 'v-else-if') === null)) bad.push('<' + c.nodeName + ' ' + (attr(c, 'v-else-if') !== null ? 'v-else-if="' + attr(c, 'v-else-if') + '"' : 'v-else') + '>');
            });
        }
        return bad;
    };
    ok(brokenElse(parse5.parseFragment('<div><p v-if="a"></p><b>x</b><p v-else></p></div>')).length === 1 && brokenElse(parse5.parseFragment('<div><p v-if="a"><span></p><p v-else></p></div>')).length === 0,
        '对照:v-else 前面隔了别的元素会被查出来');
    const app = findBy(parse5.parse(HTML), n => attr(n, 'id') === 'app');
    ok(!!app && brokenElse(app).length === 0, '整份 #app:每个 v-else / v-else-if 都紧挨着上一个分支', app ? brokenElse(app) : 'no #app');
    const flow = app && findBy(app, hasCls('home-flow'));
    const loop = flow && kidsOf(flow);
    const branches = loop && loop.length === 1 && loop[0].nodeName === 'template' ? kidsOf(loop[0]).map(n => n.nodeName + ' ' + (attr(n, 'v-if') !== null ? 'if ' + attr(n, 'v-if') : attr(n, 'v-else-if') !== null ? 'elif ' + attr(n, 'v-else-if') : attr(n, 'v-else') !== null ? 'else' : '?')) : null;
    ok(JSON.stringify(branches) === JSON.stringify(["div if k === 'history'", "div elif k === 'fav'", "div elif k === 'recommend'", "div elif k === 'popular'", "div elif k === 'live'", "section elif k === 'catnav'", 'div else']),
        '浏览器解析后:首页内容区里只有那一个 v-for,下面正好是七个分支(闭合标签没放错)', branches);
    const sm = app && findBy(app, hasCls('settings-modal'));
    const smKids = sm ? kidsOf(sm).map(n => attr(n, 'class')) : null;
    const body = sm && findBy(sm, hasCls('settings-body'));
    ok(JSON.stringify(smKids) === JSON.stringify(['settings-head', 'settings-body']) && body && findBy(body, hasCls('home-layout')) && findBy(body, hasCls('set-tip')),
        '浏览器解析后:设置弹窗 = 标题栏 + 滚动区,首页板块和底部提示都在滚动区里', smKids);

    // 绑定表达式:用页面自带的 Vue 编译浏览器解析后的 innerHTML。生产版编译器只对表达式语法错误报错(结构错误上面查)
    const vueSrc = fs.readFileSync(path.join(ROOT, 'public/libs/js/vue.global.prod.min.js'), 'utf8');
    // 浏览器版编译器借 document.createElement('div') 解码实体:文本走 textContent,属性值走 children[0].getAttribute('foo')
    const decodeEntities = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, '\u00a0')
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
    const decoder = () => {
        let s = '';
        return {
            set innerHTML(v) { s = String(v); },
            get textContent() { return decodeEntities(s); },
            get children() { const m = /^<div foo="([\s\S]*)">$/.exec(s); return [{ getAttribute: () => decodeEntities(m ? m[1] : '') }]; },
        };
    };
    const vctx = { console: { log() { }, warn() { }, error() { } }, document: { createElement: decoder }, setTimeout, clearTimeout, Promise, Symbol, Map, Set, WeakMap, WeakSet, Proxy, Reflect, Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Error, TypeError, SyntaxError };
    vctx.window = vctx; vctx.self = vctx; vctx.globalThis = vctx;
    vm.runInNewContext(vueSrc, vctx);
    const compileErrs = src => { const errs = []; try { vctx.Vue.compile(src, { onError: e => errs.push(e), onWarn: () => { }, whitespace: 'condense' }); } catch (e) { errs.push(e); } return errs; };
    ok(compileErrs('<div>{{ a + }}</div>').length > 0 && compileErrs('<div v-for="({ a, b }, i) in list" :key="a">{{ b }}</div>').length === 0, '对照:表达式写错会报错,解构 v-for 能编');
    const errs = compileErrs(app ? parse5.serialize(app) : '');
    ok(typeof vctx.Vue.compile === 'function' && errs.length === 0, '整份 #app 模板(浏览器解析后的 innerHTML)Vue 编译无错误', errs.slice(0, 3).map(e => (e && (e.message || e.code))));
}

console.log('③ 沙箱里真跑方法');
const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const SRC = scripts.find(s => s.includes('createApp({'));
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
let captured = null;
const store = new Map(), timers = [], fetches = [], focused = [], scrolls = [];
const ctxObj = {
    Vue: { createApp(o) { captured = o; return { mount() { return {}; }, use() { return this; }, config: {} }; } },
    console: { log() { }, warn() { }, error() { }, info() { } },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: id => { if (id && timers[id - 1]) timers[id - 1].live = false; },
    setInterval: () => 0, clearInterval() { }, requestAnimationFrame: () => 0,
    fetch: (url, opt) => { fetches.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null }); return Promise.resolve({ ok: true, json: () => Promise.resolve(ctxObj._pullData || {}) }); },
    document: { querySelector: sel => ({ focus() { focused.push(sel); } }), getElementById: () => null, addEventListener() { }, body: { classList: { add() { }, remove() { }, contains: () => false } } },
    Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet, Symbol, Error, TypeError,
    URL, URLSearchParams, Uint8Array, ArrayBuffer, Proxy, Reflect, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, AbortController, TextEncoder, TextDecoder,
    scrollY: 0, innerHeight: 800,
    scrollTo(a) { scrolls.push(a); },
};
const ctx = new Proxy(ctxObj, {
    has() { return true; },
    get(t, k) { if (k in t) return t[k]; if (k === 'window' || k === 'self' || k === 'globalThis') return ctx; return any(); },
    set(t, k, v) { t[k] = v; return true; }
});
try { vm.runInNewContext(SRC, ctx, { timeout: 5000 }); } catch (e) { }
const M = (captured && captured.methods) || {}, CP = (captured && captured.computed) || {}, W = (captured && captured.watch) || {};
ok(!!captured && ['moveHomeSection', 'toggleHomeSection', 'resetHomeLayout', '_saveHomeLayout', '_pushHomeLayout', 'pullUserSettings', 'catNavJump', 'onFavPopRowScroll', 'scrollRowBy', 'onRecommendScroll'].every(n => typeof M[n] === 'function')
    && ['homeOn', 'hideRandomRow', 'homeBlocks', 'homeLayoutView', 'homeLayoutIsDefault'].every(n => typeof CP[n] === 'function'), '沙箱里跑出了首页板块的方法和计算属性');
const D = (captured && typeof captured.data === 'function') ? captured.data.call(new Proxy({}, { get: () => any() })) : {};
ok(D && Array.isArray(D.homeLayout) && ks(D.homeLayout) === DEF && D.hideRandomRow === undefined, 'data:默认布局;hideRandomRow 不再是 data(由布局算出)');

function makeApp(over) {
    const app = Object.assign({
        homeLayout: H.normalize(null), homeLayoutMsg: '',
        watchHistory: [], favoritesEnabled: true, favList: [], recommendList: [], popularList: [], liveEnabled: true, liveChannels: [],
        rowConfigs: { randomRow: {}, movieRow: {}, tvRow: {}, cnRow: {} },
        syncEnabled: false, syncToken: '', showSettingsModal: false, $refs: {},
        $nextTick(f) { if (f) f(); return Promise.resolve(); },
    }, over || {});
    for (const n of Object.keys(CP)) Object.defineProperty(app, n, { get: () => CP[n].call(app), configurable: true });
    for (const n of Object.keys(M)) if (typeof M[n] === 'function') app[n] = M[n].bind(app);
    return app;
}
const ids = app => app.homeBlocks.map(b => b.id).join(',');
{
    // 首页块:开着且有内容的板块按布局顺序,随机盲盒就是 randomRow 那一行,其余榜单接在最后
    const a = makeApp({ watchHistory: [1], favList: [1], popularList: [1, 2, 3], liveChannels: [1] });
    ok(ids(a) === 'history,fav,live,catnav,row:randomRow,row:movieRow,row:tvRow,row:cnRow', '没推荐、大家都在看不足 4 部 → 不出现;其余按默认顺序', ids(a));
    const b = a.homeBlocks.find(x => x.id === 'row:movieRow');
    ok(b && b.k === 'row' && b.key === 'movieRow' && b.config === a.rowConfigs.movieRow, '榜单块带着 key / config(行模板照旧用这两个名字)');
    a.homeLayout = H.normalize([{ k: 'random' }, { k: 'live', on: false }]);
    ok(ids(a) === 'row:randomRow,history,fav,catnav,row:movieRow,row:tvRow,row:cnRow', '随机盲盒挪到最前、直播关掉', ids(a));
    a.homeLayout = H.normalize([{ k: 'random', on: false }, { k: 'catnav', on: false }]);
    ok(ids(a) === 'history,fav,live,row:movieRow,row:tvRow,row:cnRow' && a.hideRandomRow === true, '随机盲盒 / 分类栏都关:都不渲染;hideRandomRow 跟着变', ids(a));
    const e = makeApp({ favoritesEnabled: false, liveEnabled: false, homeLayout: H.normalize(null) });
    ok(e.homeLayoutView.map(s => s.k).join(',') === 'history,recommend,popular,catnav,random' && e.homeLayoutView[0].l === '继续观看' && e.homeLayoutView[0].on === true,
        '设置里不列站长没开的收藏 / 直播', e.homeLayoutView.map(s => s.k));
}
{
    // 上移 / 下移:只在设置里列出的板块之间换;到头不动;焦点留在被移动的那一项上
    const a = makeApp({ liveEnabled: false });
    focused.length = 0;
    a.moveHomeSection('catnav', -1);
    const view = () => a.homeLayoutView.map(s => s.k).join(',');
    ok(view() === 'history,fav,recommend,catnav,popular,random' && ks(a.homeLayout) === 'history,fav,recommend,catnav,live,popular,random',
        '直播没列出:分类栏上移一位换到大家都在看前面(和列表里的上一项换,直播留在原位置)', [view(), ks(a.homeLayout)]);
    ok(/分类栏 已移到第 4 位/.test(a.homeLayoutMsg) && focused[0] === '[data-home-mv="catnav:-1"]', '播报"已移到第 4 位",焦点留在它的上移按钮', [a.homeLayoutMsg, focused[0]]);
    a.moveHomeSection('history', -1);
    ok(ks(a.homeLayout) === 'history,fav,recommend,catnav,live,popular,random', '第一个再上移:不动');
    for (let i = 0; i < 3; i++) a.moveHomeSection('random', -1);
    ok(view() === 'history,fav,random,recommend,catnav,popular', '随机盲盒连按三次上移', view());
    focused.length = 0;
    a.moveHomeSection('random', -1); a.moveHomeSection('random', -1);
    ok(ks(a.homeLayout).startsWith('random,') && focused[1] === '[data-home-mv="random:1"]', '移到最前后焦点换到它的下移按钮(上移按钮已变灰)', [ks(a.homeLayout), focused]);
    const z = makeApp({});
    focused.length = 0;
    z.moveHomeSection('catnav', 1);
    ok(ks(z.homeLayout).endsWith('random,catnav') && focused[0] === '[data-home-mv="catnav:-1"]', '移到最后:焦点换到上移按钮', [ks(z.homeLayout), focused]);
    z.toggleHomeSection('popular', false);
    ok(z.homeLayout.find(s => s.k === 'popular').on === false && !z.homeLayoutIsDefault, '关掉一个板块');
    focused.length = 0;
    z.resetHomeLayout();
    ok(ks(z.homeLayout) === DEF && z.homeLayoutIsDefault && z.homeLayoutMsg === '已恢复默认顺序', '恢复默认');
    ok(focused[0] === '[data-home-mv]:not([disabled])', '恢复默认后按钮变灰:焦点挪到列表里第一个能按的按钮', focused);
    ok(store.get('donggua_home_layout') === JSON.stringify(H.normalize(null)), '每次改都存本机 donggua_home_layout');
}
{
    // 同步账号:推服务器只推最后一次(防抖 600ms),关弹窗时立刻推;没登录同步不推
    const a = makeApp({ syncEnabled: true, syncToken: 'tk' });
    timers.length = 0; fetches.length = 0;
    a.moveHomeSection('random', -1); a.moveHomeSection('random', -1); a.toggleHomeSection('live', false);
    const live = timers.filter(t => t.live);
    ok(fetches.length === 0 && live.length === 1 && live[0].ms === 600, '连改三次:还没推,只挂着一个 600ms 的定时器', { fetches: fetches.length, live: live.length });
    live[0].fn();
    ok(fetches.length === 1 && fetches[0].url === '/api/settings/push' && fetches[0].body.token === 'tk' && ks(fetches[0].body.settings.homeLayout) === ks(a.homeLayout) && !a._homePushT,
        '定时器到点推一次,推的是最后的布局', fetches[0] && fetches[0].body);
    fetches.length = 0;
    a.moveHomeSection('catnav', -1);
    a.showSettingsModal = false;
    if (W.showSettingsModal) (typeof W.showSettingsModal === 'function' ? W.showSettingsModal : W.showSettingsModal.handler).call(a, false);
    ok(fetches.length === 1 && ks(fetches[0].body.settings.homeLayout) === ks(a.homeLayout), '还没推就关了弹窗 → 立刻推', fetches.length);
    const n = makeApp({ syncEnabled: false });
    timers.length = 0; fetches.length = 0;
    n.moveHomeSection('random', -1);
    ok(fetches.length === 0 && timers.filter(t => t.live).length === 0, '没登录同步账号:只存本机');
}
{
    // 拉取:服务器的布局过 normalize 后应用、存本机;本机刚改还没推的不被盖掉
    const a = makeApp({ syncEnabled: true, syncToken: 'tk' });
    ctxObj._pullData = { sync_enabled: true, settings: { homeLayout: [{ k: 'live' }, { k: 'zzz' }, { k: 'random', on: false }] } };
    await a.pullUserSettings();
    ok(ks(a.homeLayout) === 'live,random(关),history,fav,recommend,popular,catnav' && store.get('donggua_home_layout') === JSON.stringify(a.homeLayout), '拉到服务器布局:规整后应用并存本机', ks(a.homeLayout));
    timers.length = 0;
    a.moveHomeSection('catnav', -1);
    const mine = ks(a.homeLayout);
    await a.pullUserSettings();
    ok(ks(a.homeLayout) === mine, '本机刚改、还没推上去时拉取不覆盖', ks(a.homeLayout));
    ctxObj._pullData = { sync_enabled: true, settings: { coverScale: 1 } };
    const b = makeApp({ syncEnabled: true, syncToken: 'tk', homeLayout: H.normalize([{ k: 'random' }]), applyCoverScale() { } });
    await b.pullUserSettings();
    ok(ks(b.homeLayout).startsWith('random,'), '服务器没存布局:本机的不动');
}
{
    // 板块在 v-for 里,ref 是数组:跳到「为你推荐」、收藏 / 大家都在看 / 为你推荐的左右箭头都照常
    const sec = { getBoundingClientRect: () => ({ top: 500 }) };
    const a = makeApp({ $refs: { recommendSection: [sec] } });
    scrolls.length = 0;
    a.catNavJump('recommend');
    ok(scrolls.length === 1 && scrolls[0].top === 380, '「猜你想看」跳到为你推荐(ref 是数组)', scrolls);
    const row = { scrollLeft: 50, clientWidth: 400, scrollWidth: 1200, scrollBy(o) { this.by = o; } };
    const f = makeApp({ $refs: { favRow: [row], recommendRow: [row] }, favCanScrollLeft: false, favCanScrollRight: false, recommendCanScrollLeft: false, recommendCanScrollRight: false });
    f.onFavPopRowScroll('favRow', 'fav');
    f.onRecommendScroll();
    ok(f.favCanScrollLeft === true && f.favCanScrollRight === true && f.recommendCanScrollLeft === true, '收藏 / 为你推荐的箭头状态照常算(ref 是数组)');
    f.scrollRowBy('favRow', 1);
    ok(row.by && row.by.left === 320, '收藏行点右箭头照常滚');
    const g = makeApp({ $refs: { favRow: row }, favCanScrollLeft: false, favCanScrollRight: false });
    g.onFavPopRowScroll('favRow', 'fav');
    ok(g.favCanScrollLeft === true, 'ref 是单个元素时也照常');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
