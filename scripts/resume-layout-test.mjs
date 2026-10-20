#!/usr/bin/env node
// iOS/iPadOS 长时间后台回来的恢复 + 播放页覆盖层几何回归(离线、零网络):
//   node scripts/resume-layout-test.mjs
//  ① public/index.html 里 <dg-resume-core> 那段纯函数:网络形状的失败 / 覆盖层盖没盖满 / 回来之后做什么
//  ② CSS:覆盖层四边钉住 + dvh 下限 + 纵向不串滚;html、body 都锁;盖住后藏起的首页层和 #app 的真实子节点一一对得上
//  ③ 沙箱里真跑:showDetail 侦听器(页面锁/首页隐藏的唯一来源,goHome 不再漏)、_onPageResume(后台里不做、去重、每次叫醒静默跳过、
//     离开够久才重建剪后清单、投屏标志、不刷 SW)、_swReloadIfPending、_relayoutDetail(没盖满才切 position、全屏中不动)
//  ④ 接线(静态):生命周期信号只挂一次、closeDetail 同步撤类、分诊等网络后重探、原生通道不切离线缓存、SW 播放页开着时推迟刷新、
//     只在用户关播放页 / 回首页时刷
// 改 index.html 里播放页覆盖层、页面锁、后台恢复、SW 刷新策略后必跑。
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

const coreM = /\/\/ <dg-resume-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-resume-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-resume-core> 段'); process.exit(1); }
const CORE = coreM[1];
const R = vm.runInNewContext(CORE + '\n;({ dgNetShaped, dgCovers, dgResumePlan });', {});

// 从 HTML 里按大括号配对抽一个对象成员(方法 / 侦听器)
function matchBrace(s, open) {
    let d = 0, q = null;
    for (let i = open; i < s.length; i++) {
        const c = s[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '/' && s[i + 1] === '/') { i = s.indexOf('\n', i); continue; }
        if (c === '{') d++;
        else if (c === '}') { d--; if (!d) return i; }
    }
    throw new Error('unbalanced');
}
function member(name, from) {
    const re = new RegExp('\\n\\s+' + name + '\\(([^)]*)\\)\\s*\\{');
    const at = from ? HTML.indexOf(from) : 0;
    const m = re.exec(HTML.slice(at));
    if (!m) throw new Error('member not found: ' + name);
    const open = at + m.index + m[0].length - 1;
    return { params: m[1], body: HTML.slice(open, matchBrace(HTML, open) + 1) };
}

console.log('① 纯函数');
{
    ok(R.dgNetShaped(new TypeError('Load failed')) && R.dgNetShaped(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'TypeError(断网/跨域)、AbortError(超时中止)算网络形状');
    ok(!R.dgNetShaped(new Error('HTTP 404')) && !R.dgNetShaped(new Error('multi-variant')) && !R.dgNetShaped({ transient: true }) && !R.dgNetShaped(null) && !R.dgNetShaped('deadline'),
        'HTTP 404 / multi-variant / 5xx 标记 / 空 / 字符串都不算');
    ok(R.dgCovers({ top: 0, left: 0, bottom: 1180, right: 820 }, 820, 1180) && R.dgCovers({ top: -0.5, left: 0, bottom: 1179.4, right: 820 }, 820, 1180), '盖满整个视口(1px 余量)');
    ok(!R.dgCovers({ top: 0, left: 0, bottom: 820, right: 820 }, 820, 1180), '横屏的旧高度(820)放在竖屏(1180)里 → 没盖满(露出底下约 31%)');
    ok(!R.dgCovers({ top: 1180 * 0.31, left: 0, bottom: 1180 * 1.31, right: 820 }, 820, 1180), '上滑动画卡在 translateY(31%) → 没盖满');
    ok(!R.dgCovers(null, 820, 1180), '没有盒子 → 不算盖满');
    const P = (o) => JSON.stringify(R.dgResumePlan(o));
    ok(P({ reason: 'visible', awayMs: 30e3, showDetail: true, hasDp: true }) === '{"relayout":true,"wake":true,"revive":false}', '离开 30s → 重排 + 叫醒静默跳过(停下才有事做),不重建剪后清单');
    ok(P({ reason: 'visible', awayMs: 0, showDetail: true, hasDp: true }).includes('"wake":true'), '…哪怕只离开一下也叫醒(以前要 ≥60s,短暂离开时停下的扫描整集不再跑)');
    ok(P({ reason: 'visible', awayMs: 2 * 3600e3, showDetail: true, hasDp: true }) === '{"relayout":true,"wake":true,"revive":true}', '离开 2 小时 → 重排 + 叫醒 + 重建');
    ok(P({ reason: 'gap', awayMs: 125e3, showDetail: true, hasDp: true }).includes('"revive":true'), '计时器断档 2 分钟 → 重建');
    ok(P({ reason: 'pageshow', awayMs: 0, showDetail: true, hasDp: true }).includes('"revive":true') && P({ reason: 'online', awayMs: 0, showDetail: true, hasDp: true }).includes('"revive":true'), '往返缓存恢复 / 网络恢复 → 不管离开多久都重建');
    ok(P({ reason: 'online', awayMs: 9e6, showDetail: false, hasDp: true }) === '{"relayout":false,"wake":false,"revive":false}', '播放页没开 → 什么都不做');
    ok(P({ reason: 'online', awayMs: 9e6, showDetail: true, hasDp: true, live: true }) === '{"relayout":true,"wake":false,"revive":false}', '直播 → 只重排');
    ok(P({ reason: 'online', awayMs: 9e6, showDetail: true, hasDp: false }) === '{"relayout":true,"wake":false,"revive":false}', '还没有播放器 → 只重排');
    ok(P(undefined) === '{"relayout":false,"wake":false,"revive":false}', '没参数也不抛');
}

console.log('② CSS');
{
    const rule = (sel) => { const i = HTML.indexOf('\n        ' + sel + ' {'); if (i < 0) return ''; const open = HTML.indexOf('{', i); return HTML.slice(open, HTML.indexOf('}', open) + 1); };
    const ov = rule('.detail-overlay');
    ok(/position: fixed;/.test(ov) && /top: 0;/.test(ov) && /right: 0;/.test(ov) && /bottom: 0;/.test(ov) && /left: 0;/.test(ov), '.detail-overlay 四边都钉住(不只靠 top + height)', ov);
    ok(!/height: 100%/.test(ov) && /height: auto;/.test(ov) && !/\binset\b/.test(ov), '…没有 height:100%;不用 inset(iPadOS < 14.5 不认)');
    ok(/overscroll-behavior-y: contain;/.test(ov) && /overflow-y: auto;/.test(ov), '…自己滚、纵向不串到底层页面(横向留给浏览器左右滑动返回)');
    ok(/@supports \(height: 100dvh\) \{\s*\.detail-overlay \{\s*min-height: 100dvh;\s*\}\s*\}/.test(HTML), '@supports dvh:覆盖层最少一个真实窗口高');
    ok(!/\.detail-overlay \{[^}]*100vh/.test(HTML), '…没有 100vh 兜底(会钻到 Safari 工具栏下面)');
    ok(/\n        html\.detail-open,\n        body\.detail-open \{\s*overflow: hidden !important;\s*overscroll-behavior-y: none;\s*\}/.test(HTML), 'html、body 都锁(iOS 主屏 App 只锁 body 挡不住触摸滚动)');
    // html 锁着时 body 必须放开:否则 body 的 overflow 不再传给视口、自己变成滚不动的滚动容器,首页吸顶搜索栏改吸在 body 上、打开播放页时跳出视口
    const bodyRel = /\n        html\.detail-open body \{\s*overflow: visible !important;\s*\}/.exec(HTML);
    ok(!!bodyRel && bodyRel.index > HTML.indexOf('\n        html.detail-open,\n        body.detail-open {'), 'html.detail-open body { overflow: visible !important }(特异度 0,1,2 压过 body.detail-open,且写在它后面)');
    ok(/\.detail-overlay\.active \{\s*display: block;\s*animation: slideUp/.test(HTML), '正常打开的上滑动画还在(.active)');
    // 盖住后藏起的首页层:每个都是 #app 真实的直接子节点;覆盖层/弹窗/封禁锁/TV 悬浮钮一个都不能在里面;首页层一个都不能漏
    const cm = /((?:\s*body\.detail-covered #app > [^,{]+,?)+)\s*\{\s*visibility: hidden !important;\s*\}/.exec(HTML);
    const sels = cm ? cm[1].split(',').map(s => s.trim().replace(/^body\.detail-covered #app > /, '')).filter(Boolean) : [];
    ok(sels.length === 11, '隐藏列表 11 项', sels);
    const parse5 = dep('parse5');
    const attr = (n, name) => { const a = (n.attrs || []).find(x => x.name === name); return a ? a.value : null; };
    const walk = function* (n) { yield n; for (const c of ((n.nodeName === 'template' ? n.content : n).childNodes || [])) yield* walk(c); };
    let app = null; for (const n of walk(parse5.parse(HTML))) if (n.attrs && attr(n, 'id') === 'app') { app = n; break; }
    const kids = app ? app.childNodes.filter(c => c.attrs) : [];
    const matches = (n, sel) => sel[0] === '#' ? attr(n, 'id') === sel.slice(1) : (' ' + (attr(n, 'class') || '') + ' ').includes(' ' + sel.slice(1) + ' ');
    ok(sels.length && sels.every(s => kids.some(k => matches(k, s))), '列出的每一项都是 #app 的直接子节点', sels.filter(s => !kids.some(k => matches(k, s))));
    const keep = ['.detail-overlay', '.info-modal-overlay', '.ban-lock', '.tv-mode-float-btn'];
    ok(!sels.some(s => keep.includes(s)), '覆盖层 / 弹窗 / 封禁锁 / TV 悬浮钮不藏', sels);
    const notHome = (k) => k.nodeName === 'teleport' || keep.some(s => matches(k, s));
    const missed = kids.filter(k => !notHome(k) && !sels.some(s => matches(k, s))).map(k => k.nodeName + '.' + (attr(k, 'class') || '') + '#' + (attr(k, 'id') || ''));
    ok(missed.length === 0, '#app 下的首页层一个都没漏(新加首页层要补进隐藏列表)', missed);
}

console.log('③ 沙箱里真跑');
const mkCls = () => { const s = new Set(); return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)), toggle: (x, on) => { if (on === undefined ? !s.has(x) : on) s.add(x); else s.delete(x); return s.has(x); }, contains: x => s.has(x), _s: s }; };
function mkWorld() {
    const W = { timers: [], reloads: 0, replaced: [], logs: [], warns: [], ss: new Map(), now: 1e12, raf: [] };
    const posSets = [];
    const overlay = {
        _pos: '', scrollTop: 120, rect: { top: 0, left: 0, bottom: 1180, right: 820 },
        style: { animation: '', get position() { return overlay._pos; }, set position(v) { overlay._pos = v; posSets.push(v); } },
        get offsetHeight() { return 1180; }, getBoundingClientRect() { return overlay.rect; }
    };
    W.overlay = overlay; W.posSets = posSets;
    W.document = {
        visibilityState: 'visible', hidden: false, fullscreenElement: null, webkitFullscreenElement: null, pictureInPictureElement: null,
        documentElement: { classList: mkCls() }, body: { classList: mkCls() },
        querySelector: (s) => s === '.detail-overlay' ? overlay : null
    };
    W.window = { innerWidth: 820, innerHeight: 1180, visualViewport: null, location: { search: '', pathname: '/', reload: () => { W.reloads++; } } };
    W.window.window = W.window;
    W.setTimeout = (fn, ms) => { W.timers.push({ fn, ms, live: true }); return W.timers.length; };
    W.clearTimeout = (id) => { if (id && W.timers[id - 1]) W.timers[id - 1].live = false; };
    W.history = { state: null, replaceState: (s, t, u) => { W.replaced.push(u); W.window.location.search = ''; } };
    W.sessionStorage = { setItem: (k, v) => W.ss.set(k, v), getItem: k => W.ss.get(k) || null };
    W.console = { log: (...a) => W.logs.push(a.join(' ')), warn: (...a) => W.warns.push(a), error() { } };
    W.Date = { now: () => W.now };
    W.requestAnimationFrame = (f) => { W.raf.push(f); return W.raf.length; };
    W.getComputedStyle = () => ({ transform: 'none' });
    W.dp = null;
    W.perf = 1e6;
    return W;
}
// 把成员源码在给定世界里编成函数(全局名都换成世界里的桩)
const GLOBALS = ['document', 'window', 'setTimeout', 'clearTimeout', 'location', 'history', 'sessionStorage', 'console', 'Date', 'requestAnimationFrame', 'getComputedStyle', 'dp', 'performance'];
function build(W, names) {
    const src = names.map(([n, from]) => { const m = member(n, from); return n + '(' + m.params + ') ' + m.body; }).join(',\n');
    const f = new Function(...GLOBALS, CORE + '\nreturn {' + src + '};');
    return f(W.document, W.window, W.setTimeout, W.clearTimeout, W.window.location, W.history, W.sessionStorage, W.console, W.Date, W.requestAnimationFrame, W.getComputedStyle, W.dp, { now: () => W.perf });
}
const WATCH_AT = '            watch: {';
{
    // showDetail 侦听器:页面锁 / 首页隐藏的唯一来源
    const W = mkWorld();
    const M = build(W, [['showDetail', WATCH_AT], ['_swReloadIfPending']]);
    const app = { showDetail: true, trial: { on: false }, favRefreshed: 0, _favRefreshMaybe() { this.favRefreshed++; }, _trialLeave() { } };
    app._swReloadIfPending = M._swReloadIfPending.bind(app);
    const watch = (v) => { app.showDetail = v; M.showDetail.call(app, v); };
    const html = W.document.documentElement.classList, body = W.document.body.classList;
    watch(true);
    ok(html.contains('detail-open') && body.contains('detail-open') && !body.contains('detail-covered'), '打开:html + body 都加 detail-open,首页先不藏(上滑动画期间)');
    ok(app._detailOpenAt === W.perf, '…记下打开时刻(_relayoutDetail 据此不掐正常播放的上滑动画)');
    const cover = W.timers.filter(t => t.live && t.ms === 450);
    ok(cover.length === 1 && W.overlay.style.animation === '', '…450ms 后再藏首页;可见时打开不动动画');
    cover[0].fn();
    ok(body.contains('detail-covered'), '…动画放完 → body.detail-covered');
    W.overlay.style.animation = 'none'; W.overlay.style.position = 'absolute';
    watch(false);   // goHome 的路径:只 showDetail = false,不调 closeDetail
    ok(!html.contains('detail-open') && !body.contains('detail-open') && !body.contains('detail-covered'), '关闭(goHome 路径)→ 三个类全撤(以前 goHome 漏撤 body.detail-open)');
    ok(W.overlay.style.animation === '' && W.overlay._pos === '', '…清掉 _relayoutDetail 写的行内样式(下次打开照样有上滑动画)');
    ok(app.favRefreshed === 1, '…原来的关闭逻辑照旧(刷新收藏状态)');
    // 450ms 内就关掉:定时器作废,首页不会被藏
    watch(true);
    const t2 = W.timers.filter(t => t.live && t.ms === 450);
    watch(false);
    ok(t2.length === 1 && !t2[0].live && !body.contains('detail-covered'), '打开后 450ms 内关掉 → 藏首页的定时器作废');
    // 后台里打开(深链重载):不要上滑动画
    W.document.visibilityState = 'hidden';
    watch(true);
    ok(W.overlay.style.animation === 'none', '页面在后台时打开 → 行内 animation:none(不会冻在半路)');
    W.document.visibilityState = 'visible';
    watch(false);
    // SW 新版本等着刷新:侦听器不刷 —— 搜索打断深链加载帧、深链没搜到这类"程序关掉播放页"也走这里,刷了会把用户刚输入的搜索刷没
    W.window._dgSwReloadPending = true; W.window.location.search = '?play=%E7%B9%81%E8%8A%B1&ep=1';
    watch(true); watch(false);
    ok(W.reloads === 0 && W.window._dgSwReloadPending === true, 'showDetail 变 false(不管哪条路径)→ 侦听器不刷 SW,继续等用户关播放页 / 回首页');
}
{
    // _swReloadIfPending:可见、不在播放页才刷;先去掉地址栏深链(goHome 不清它)
    const W = mkWorld();
    const M = build(W, [['_swReloadIfPending']]);
    const app = { showDetail: true };
    W.window._dgSwReloadPending = true; W.window.location.search = '?play=%E7%B9%81%E8%8A%B1&ep=1';
    ok(M._swReloadIfPending.call(app) === false && W.reloads === 0, '播放页还开着 → 不刷');
    app.showDetail = false; W.document.visibilityState = 'hidden';
    ok(M._swReloadIfPending.call(app) === false && W.reloads === 0, '页面不可见 → 不刷');
    W.document.visibilityState = 'visible';
    ok(M._swReloadIfPending.call(app) === true && W.reloads === 1 && W.replaced[0] === '/' && W.window._dgSwReloadPending === false, '关了播放页且可见 → 先去掉 ?play= 再刷新(不把刚关的剧又打开)', { reloads: W.reloads, replaced: W.replaced });
    ok(M._swReloadIfPending.call(app) === false && W.reloads === 1, '没有待刷新 → 什么都不做');
}
{
    // _onPageResume:去重 / 重建去插播通道 / 投屏标志 / SW 待刷新
    const W = mkWorld();
    W.dp = { video: { src: 'https://tv.example/api/hls/cut/x.m3u8', currentSrc: '', webkitCurrentPlaybackTargetIsWireless: false } };
    const calls = { cut: [], skip: [], relay: [] };
    W.window.adCut = { revive: (v, r) => { calls.cut.push([v, r]); return '重交'; } };
    W.window.adClipSkip = { revive: (r) => { calls.skip.push(r); return true; } };
    W.window._castWireless = true;
    const M = build(W, [['_onPageResume'], ['_swReloadIfPending']]);
    const app = { showDetail: true, _liveActive: false, _relayoutDetail(f) { calls.relay.push(f); } };
    app._onPageResume = M._onPageResume.bind(app); app._swReloadIfPending = M._swReloadIfPending.bind(app);
    app._onPageResume('visible', 2 * 3600e3);
    ok(calls.cut.length === 1 && calls.cut[0][0] === W.dp.video && calls.cut[0][1] === 'visible' && calls.skip.length === 1, '离开 2 小时回来 → adCut.revive + adClipSkip.revive 各一次');
    ok(calls.relay.length === 1 && calls.relay[0] === true, '…覆盖层强制重排一次');
    ok(W.window._castWireless === false, '…<video> 已不在投屏 → 清掉卡住的投屏标志');
    ok(W.window._dgResumeAt === W.now, '…记下回来的时刻(分诊据此等网络)');
    const diag = JSON.parse(W.ss.get('donggua_resume_diag') || '{}');
    ok(diag.reason === 'visible' && diag.awayMs === 2 * 3600e3 && diag.cut === '重交' && diag.detail === true && Array.isArray(diag.rect), '…诊断写进 sessionStorage donggua_resume_diag', diag);
    ok(W.logs.some(l => /^\[后台恢复\] visible 离开 120 分钟/.test(l)), '…console 一行 [后台恢复]', W.logs);
    W.now += 1000;
    app._onPageResume('pageshow', 2 * 3600e3);
    ok(calls.cut.length === 1 && calls.relay.length === 1, '3s 内重复的信号(visibilitychange + pageshow)只算一次');
    app._onPageResume('online', 0);
    ok(calls.cut.length === 2 && calls.cut[1][1] === 'online', '网络恢复不受 3s 去重限制(网络刚通才是重建的好时机)');
    W.now += 10e3;
    const resumeAt0 = W.window._dgResumeAt;
    const nSkip0 = calls.skip.length;
    app._onPageResume('visible', 30e3);
    ok(calls.cut.length === 2 && calls.skip.length === nSkip0 + 1 && calls.relay.length === 3 && calls.relay[2] === false, '离开 30s → 重排(不强制)+ 叫醒静默跳过;不重交剪后清单(上 MB 的 POST 只在离开够久时发)');
    ok(W.window._dgResumeAt === resumeAt0, '…也不算"刚恢复"(分诊不会因为切了下标签页就多等网络)');
    // 先来一次短的 visible(不重建),3s 内又来往返缓存的 pageshow(要重建)→ 不能被去重吞掉
    W.now += 10e3;
    app._onPageResume('visible', 20e3);
    W.now += 500;
    app._onPageResume('pageshow', 20e3);
    ok(calls.cut.length === 3 && calls.cut[2][1] === 'pageshow', '短 visible 之后 3s 内的 pageshow(要重建)不被去重吞掉', calls.cut.map(c => c[1]));
    // 页面还在后台时收到的(iOS 醒来时排队的 online 可能先于 visibilitychange):什么都不做,也不占去重窗口
    W.now += 10e3;
    W.document.hidden = true; W.document.visibilityState = 'hidden';
    const n0 = [calls.cut.length, calls.skip.length, calls.relay.length];
    app._onPageResume('online', 0);
    ok(calls.cut.length === n0[0] && calls.skip.length === n0[1] && calls.relay.length === n0[2], '页面还在后台时的 online → 什么都不做(这时探测只会再失败、量到的是旧布局)');
    W.document.hidden = false; W.document.visibilityState = 'visible';
    W.now += 500;
    app._onPageResume('visible', 3 * 3600e3);
    ok(calls.cut.length === n0[0] + 1 && calls.skip.length === n0[1] + 1 && calls.relay.length === n0[2] + 1 && calls.relay[calls.relay.length - 1] === true, '…紧接着(3s 内)回到前台的 visible 照样做全套(没被后台那次占掉去重窗口)');
    W.now += 10e3;
    app._liveActive = true;
    const nCut1 = calls.cut.length, nSkip1 = calls.skip.length;
    app._onPageResume('visible', 9e6);
    ok(calls.cut.length === nCut1 && calls.skip.length === nSkip1, '直播 → 不重建剪后清单、不叫醒静默跳过');
    app._liveActive = false;
    W.now += 10e3;
    app.showDetail = false;
    const nRelay = calls.relay.length, nSkip2 = calls.skip.length;
    app._onPageResume('visible', 9e6);
    ok(calls.cut.length === nCut1 && calls.skip.length === nSkip2 && calls.relay.length === nRelay, '播放页没开 → 不重排、不重建、不叫醒');
    // SW 待刷新:回来时一律不刷(首页上可能正有用户的搜索;只在用户关播放页 / 回首页时刷,见 _swReloadIfPending)
    W.window._dgSwReloadPending = true;
    app.showDetail = false; W.now += 10e3;
    app._onPageResume('visible', 9e6);
    ok(W.reloads === 0 && W.window._dgSwReloadPending === true, '回来时(哪怕在首页)不刷 SW');
    // 出错不外抛
    const W2 = mkWorld();
    const M2 = build(W2, [['_onPageResume'], ['_swReloadIfPending']]);
    let threw = false;
    try { M2._onPageResume.call({ showDetail: true, _relayoutDetail() { throw new Error('x'); } }, 'visible', 9e6); } catch (e) { threw = true; }
    ok(!threw, '内部出错不外抛(生命周期事件里不能炸)');
}
{
    // _relayoutDetail:没盖满才切 position;force 也切;全屏中不动;滚动位置保留;下一帧还没盖满就打一行几何
    const W = mkWorld();
    // dp 是编译时传进去的值:先放好播放器桩(之后只改它的字段),iPad 原生全屏 / WebKit 画中画的分支才真的被跑到
    W.dp = { video: { webkitDisplayingFullscreen: false, webkitPresentationMode: 'inline' } };
    const M = build(W, [['_relayoutDetail']]);
    // 刚打开(700ms 内)的尺寸变化:上滑动画正在正常播(盒子还在 translateY 里,看起来"没盖满")→ 不动;回到前台(force)照样处理
    const fresh = { showDetail: true, _detailOpenAt: W.perf - 200 };
    W.overlay.rect = { top: 300, left: 0, bottom: 1480, right: 820 };
    M._relayoutDetail.call(fresh, false);
    ok(W.overlay.style.animation === '' && W.posSets.length === 0 && !W.document.body.classList.contains('detail-covered'), '刚打开 200ms 时窗口尺寸变了(比如滚动条消失)→ 不掐上滑动画、不切 position');
    M._relayoutDetail.call(fresh, true);
    ok(W.overlay.style.animation === 'none' && W.posSets.length === 2, '…force(回到前台)照样取消动画并重排');
    W.overlay.style.animation = ''; W.posSets.length = 0; W.raf.length = 0; W.warns.length = 0;
    W.overlay.rect = { top: 0, left: 0, bottom: 1180, right: 820 };
    W.document.body.classList.remove('detail-covered'); W.document.documentElement.classList.remove('detail-open');
    const app = { showDetail: true };
    M._relayoutDetail.call(app, false);
    ok(W.overlay.style.animation === 'none' && W.posSets.length === 0, '盖满时:只取消可能卡住的动画,不切 position');
    W.raf.splice(0).forEach(f => f());
    ok(W.warns.length === 0, '…下一帧盖满 → 不打警告');
    ok(W.document.documentElement.classList.contains('detail-open') && W.document.body.classList.contains('detail-covered'), '…补上 html.detail-open / body.detail-covered');
    W.overlay.rect = { top: 0, left: 0, bottom: 820, right: 820 };   // WebKit 还用横屏的旧高度
    W.overlay.scrollTop = 333;
    M._relayoutDetail.call(app, false);
    ok(JSON.stringify(W.posSets) === '["absolute",""]' && W.overlay._pos === '' && W.overlay.scrollTop === 333, '没盖满 → position 切 absolute 再切回(逼 WebKit 重算),滚动位置保留', W.posSets);
    W.raf.splice(0).forEach(f => f());
    ok(W.warns.length === 1 && /覆盖层没盖满/.test(W.warns[0][0]) && W.warns[0][1].bottom === 820 && W.warns[0][1].innerHeight === 1180, '下一帧还没盖满 → console.warn 几何数据', W.warns);
    W.posSets.length = 0; W.overlay.rect = { top: 0, left: 0, bottom: 1180, right: 820 };
    M._relayoutDetail.call(app, true);
    ok(W.posSets.length === 2, 'force(离开够久)→ 盖满也切一次');
    W.posSets.length = 0;
    W.document.fullscreenElement = {};
    M._relayoutDetail.call(app, true);
    ok(W.posSets.length === 0, '全屏中 → 不切 position(会被踢出全屏)');
    W.document.fullscreenElement = null;
    W.document.pictureInPictureElement = {};
    M._relayoutDetail.call(app, true);
    ok(W.posSets.length === 0, '画中画中(标准 API)→ 不切 position');
    W.document.pictureInPictureElement = null;
    W.dp.video.webkitDisplayingFullscreen = true; W.posSets.length = 0;
    M._relayoutDetail.call(app, true);
    ok(W.posSets.length === 0, 'iPad <video> 原生全屏(webkitDisplayingFullscreen)→ 不切 position');
    W.dp.video.webkitDisplayingFullscreen = false;
    W.dp.video.webkitPresentationMode = 'picture-in-picture'; W.posSets.length = 0;
    M._relayoutDetail.call(app, true);
    ok(W.posSets.length === 0, 'WebKit 画中画(原生控件 / webkitSetPresentationMode 进的,标准 API 看不到)→ 不切 position');
    W.dp.video.webkitPresentationMode = 'inline'; W.posSets.length = 0;
    M._relayoutDetail.call(app, true);
    ok(W.posSets.length === 2, '…退出全屏 / 画中画后照常重排(对照:上面的不动确实是守卫挡的)', W.posSets);
    W.posSets.length = 0;
    M._relayoutDetail.call({ showDetail: false }, true);
    ok(W.posSets.length === 0, '播放页没开 → 什么都不做');
}

console.log('④ 接线(静态)');
{
    const lifeAt = HTML.indexOf('if (!this._lifeHooked) {');
    const life = lifeAt > 0 ? HTML.slice(lifeAt, matchBrace(HTML, HTML.indexOf('{', lifeAt)) + 1) : '';
    ok(/this\._lifeHooked = true;/.test(life), '生命周期信号只挂一次(_lifeHooked)');
    for (const [ev, re] of [['visibilitychange', /document\.addEventListener\('visibilitychange'/], ['pagehide', /window\.addEventListener\('pagehide'/], ['pageshow', /window\.addEventListener\('pageshow', \(e\) => \{ if \(e && e\.persisted\) this\._onPageResume\('pageshow'/],
        ['online', /window\.addEventListener\('online', \(\) => this\._onPageResume\('online', 0\)\)/], ['orientationchange', /window\.addEventListener\('orientationchange', relayout\)/],
        ['visualViewport resize', /visualViewport\.addEventListener\('resize', relayout/], ['fullscreenchange', /document\.addEventListener\('fullscreenchange', relayout\)/], ['webkitfullscreenchange', /document\.addEventListener\('webkitfullscreenchange', relayout\)/]])
        ok(re.test(life), '挂了 ' + ev);
    ok(/gap > 120e3 && !document\.hidden\) this\._onPageResume\('gap', gap\)/.test(life) && /}, 15000\);/.test(life), '计时器断档检测(15s 一跳,隔 2 分钟以上 = 被挂起过)');
    ok((HTML.match(/if \(!this\._lifeHooked\) \{/g) || []).length === 1, '只有一处挂生命周期信号');
    ok(/this\.onFavPopRowScroll\('popularRow', 'popular'\);\s*\n\s*if \(this\.showDetail\) this\._relayoutDetail\(false\);/.test(HTML), '原有的 resize 节流里也检查覆盖层');
    const cd = member('closeDetail').body;
    ok(/document\.body\.classList\.remove\('detail-open'\);\s*\n\s*document\.body\.classList\.remove\('detail-covered'\);[^\n]*\n\s*document\.documentElement\.classList\.remove\('detail-open'\);/.test(cd), 'closeDetail 同步撤掉 detail-covered / html.detail-open(TV 焦点代码紧接着要聚焦首页)');
    // 分诊:断网 / 刚回来时探测失败 → 等网络再探,不急着判 workerdown 换直连
    const tri = HTML.slice(HTML.indexOf('const classify = (pr) => {'), HTML.indexOf("if (source === 'emptyPlaylist' && cls === 'ok') cls = 'stripped';"));
    ok(tri.length > 200 && /cls = classify\(await probeM3u8\(wrapped\)\);/.test(tri) && /\} catch \(e\) \{\s*\n\s*cls = 'workerdown';/.test(tri), '分诊:探测分类抽成 classify,失败先记 workerdown');
    ok(/navigator\.onLine === false \|\| \(window\._dgResumeAt && Date\.now\(\) - window\._dgResumeAt < 30000\)/.test(tri) && /armGuard\(30000\)/.test(tri) && /window\.addEventListener\('online', done\)/.test(tri)
        && /navigator\.onLine === false \? 8000 : 2500/.test(tri) && /try \{ cls = classify\(await probeM3u8\(wrapped\)\); \} catch \(e2\) \{ cls = 'workerdown'; \}/.test(tri), '…断网/刚回来 30s 内:罩住闸门、等联网(最多 8s / 已在线 2.5s)再探一次');
    ok(/this\._playToken !== playToken\) return;\s*\n\s*try \{ cls = classify/.test(tri), '…等完先查播放令牌(换集/换源了就作废)');
    // 令牌对不上就直接 return、不碰 _proxyRetrying(新的 play() 已复位;再清会把新一次播放正在分诊的闸门清掉)
    const iife = HTML.slice(HTML.indexOf('// 通过 worker 重取本集 m3u8,分类'), HTML.indexOf("} catch (e) { this._proxyRetrying = false; console.warn('[播放器] 代理分诊异常"));
    ok(iife.length > 2000 && (iife.match(/this\._playToken !== playToken\) return;/g) || []).length === 4 && !/this\._playToken !== playToken\) \{ this\._proxyRetrying = false;/.test(iife), '分诊里 4 处令牌检查都只 return,不清别人的闸门');
    const reprobeAt = HTML.indexOf("try { cls = classify(await probeM3u8(wrapped)); } catch (e2) { cls = 'workerdown'; }");
    ok(reprobeAt > 0 && reprobeAt < HTML.indexOf('const others = (this.corsProxyUrls') && reprobeAt < HTML.indexOf("switchTo(fb, '过滤代理临时故障→直连兜底')"), '…重探在备用代理探测 / 直连兜底之前');
    // 离线缓存切换:原生通道读不到 IndexedDB
    const off = member('_offSwitchToCacheIfAvailable').body;
    ok(/^\{\s*(?:\/\/[^\n]*\n\s*)*if \(window\._dgPreferNativeHls\) return false;/.test(off), '_offSwitchToCacheIfAvailable 第一句:原生 HLS 通道直接不切');
    // SW:正在播放的守卫原样;播放页开着/后台 → 推迟,回到首页再刷
    const a = HTML.indexOf('let swRefreshing = false;');
    const swh = a > 0 ? HTML.slice(a, HTML.indexOf('window.location.reload();', a)) : '';
    ok(/!dp\.video\.paused && !dp\.video\.ended\)\s*\{[^}]*return;/.test(swh), 'SW:正在播放不刷新的守卫还在');
    ok(/if \(window\.vueApp && window\.vueApp\.showDetail\) \{\s*window\._dgSwReloadPending = true;/.test(swh) && swh.indexOf('_dgSwReloadPending') > swh.indexOf('!dp.video.paused'), 'SW:播放页开着 → 记下待刷新、不刷(在刷新之前)');
    ok(!/visibilityState/.test(swh), 'SW:后台里的首页照旧当场刷(不推迟到切回来当面闪一下)');
    // 待刷新只在用户自己关播放页 / 回首页时执行(两个方法的最后一句)
    const cdEnd = member('closeDetail').body, ghEnd = member('goHome').body;
    ok(/this\._swReloadIfPending\(\);[^\n]*\n\s*\}$/.test(cdEnd) && /this\._swReloadIfPending\(\);[^\n]*\n\s*\}$/.test(ghEnd), 'closeDetail / goHome 收尾时刷待刷新的 SW');
    ok((HTML.match(/this\._swReloadIfPending\(\)/g) || []).length === 2, '…只有这两处调用(侦听器 / 后台恢复都不刷)');
    const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
    ok(/const CACHE_VERSION = 'v40'/.test(sw), 'sw.js v40(重新预缓存页面外壳)');
    // dg-resume-core 在 adClipSkip 前面、同一个脚本里(adClipSkip / adCut 直接调 dgNetShaped)
    const main = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('createApp({')) || '';
    ok(main.indexOf('// <dg-resume-core>') > 0 && main.indexOf('// <dg-resume-core>') < main.indexOf('window.adClipSkip = {'), '<dg-resume-core> 在主脚本里、adClipSkip 之前');
    ok(/dgNetShaped\(e\) \|\| \/\^HTTP \(5\\d\\d\|429\)\$\//.test(HTML) && /!dgNetShaped\(e\) \|\| this\.NATIVE_DEADLINE/.test(HTML), 'adClipSkip / adCut 用 dgNetShaped 分类网络形状的失败');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
