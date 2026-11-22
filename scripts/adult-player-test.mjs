#!/usr/bin/env node
// [adult] 播放器增强回归(离线、零网络、无浏览器):node scripts/adult-player-test.mjs
//  ① 纯逻辑:按格分摊 / 上报值(60% 算一次、回看累加、封顶)/ 发送门槛 / base64 / 热度归一 / 平滑 / 曲线路径 / 横滑定位 / 时间格式(对照 DPlayer)/
//     双击分区 / 跳转判定 / 倍速档 / 可接管判定 / 选集串第一集 / 源站 / 作品键
//  ② 热度条:等 playing(或 4s)才拿、画进 .dplayer-bar(pointer-events:none、缩略图框亮着让开)、204 / 不到 3 人 / 形状不对不画、换作品中止旧请求、
//     同一部换线路不重拿、重建播放器重新插、直播不拿
//  ③ 热度贡献:按格记秒数、跳变 / 倍速范围外不记、门槛(5 分钟 / 30%)、每天一次、用户跳转停留 +1(程序跳转 / 续播不算)、无痕不记不发不建设备号、
//     pagehide 走 sendBeacon、切后台存待发 → 下次打开补发、重建播放器接着记、从不写 Vue 状态
//  ④ 手势:与【真】index.html 的双击 / 单击 / 亮度音量手势代码、【真】seek-preview.js 控制器在同一个容器上一起跑 ——
//     长按 2 倍速(恢复原倍速、dplayer_speed 原样)、移动 / 暂停 / 控制栏 / 面板 / 直播不触发、第二根手指 / 取消恢复、contextmenu 拦截;
//     双击左右的波纹与累加(只在 index.html 真跳了之后)、中间双击 / 单击照旧;横滑定位(缩略图跟着指、松手才 seek、回到起点取消、
//     竖滑 / 边缘 / 不可取消 / 直播不接、全屏左侧与亮度手势共存);接管的 touchend 不再传给 index.html
//  ⑤ 键盘:J / L ±10s、Shift+> / Shift+< 倍速档;输入框 / 修饰键 / 隐藏 / TV / 直播 / 锁屏不响应;DPlayer 与 index.html 本来没有这几个键
//  ⑥ 起播提速:悬停 150ms / 按下即预取、离开中止(已被领取的不中止)、60s 有效、LRU 20、同时 ≤3、在播 / 后台 / 省流量 / 慢网 / 断网 / 年龄门前不预取、
//     preconnect(带 crossorigin、≤4、同源不加)、绝不拉 m3u8;【真】adult.js fetchWork 直接用预取结果;点开到拿到作品 JSON 的耗时估算
//  ⑦ 钩子:【真】adult.js 的 dgAdultHooks(add 注册、幂等)、普通对象的包一层、浏览器引导;静态检查(不碰播放通道、不写 Vue、脚本标签)
// 改 public/adult/player-x.js、index.html 的手势 / 倍速记忆、seek-preview.js 的指针处理后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\r\n').join('\n');
const SRC = read('public/adult/player-x.js');
const SP_SRC = read('public/libs/js/seek-preview.js');
const HTML = read('public/index.html');
const DPLAYER = read('public/libs/js/DPlayer.min.js');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra).slice(0, 500))); } };
const errors = [];
const flushIO = () => new Promise(r => setImmediate(r));
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

function loadCore() {
    const ctx = { console, URL };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx, { filename: 'player-x.js' });
    return ctx.DgAdultPlayerCore;
}
const Core = loadCore();
const { C } = Core;
const SPCore = (() => { const ctx = { console }; ctx.window = ctx; vm.createContext(ctx); vm.runInContext(SP_SRC, ctx, { filename: 'seek-preview.js' }); return ctx.DgSeekPreviewCore; })();

// ======================= 假时钟 / 假 DOM =======================
function mkClock(t0) {
    const c = { t: t0 || Date.UTC(2026, 10, 22, 12, 0, 0), q: [], id: 0 };
    c.now = () => c.t;
    c.setTimeout = (f, ms) => { const id = ++c.id; c.q.push({ id, at: c.t + Math.max(0, +ms || 0), f }); return id; };
    c.clearTimeout = (id) => { if (!id) return; const i = c.q.findIndex(x => x.id === id); if (i >= 0) c.q.splice(i, 1); };
    c.advance = async (ms) => {
        const end = c.t + ms;
        await flushIO();
        for (; ;) {
            let bi = -1;
            for (let i = 0; i < c.q.length; i++) {
                const x = c.q[i];
                if (x.at <= end && (bi < 0 || x.at < c.q[bi].at || (x.at === c.q[bi].at && x.id < c.q[bi].id))) bi = i;
            }
            if (bi < 0) break;
            const x = c.q.splice(bi, 1)[0];
            c.t = Math.max(c.t, x.at);
            try { x.f(); } catch (e) { errors.push(e); }
            await flushIO();
        }
        c.t = end;
        await flushIO();
    };
    return c;
}
class Ev {
    constructor(type, init) {
        init = init || {};
        Object.assign(this, init);
        this.type = type;
        this.bubbles = !!init.bubbles;
        this.cancelable = !!init.cancelable;
        this.defaultPrevented = false;
        this._stop = false; this._imm = false; this._passive = false;
        this.target = null; this.currentTarget = null;
    }
    preventDefault() { if (this.cancelable && !this._passive) this.defaultPrevented = true; }
    stopPropagation() { this._stop = true; }
    stopImmediatePropagation() { this._stop = true; this._imm = true; }
}
class FakePointerEvent extends Ev { }
class Tgt {
    constructor() { this._ls = Object.create(null); }
    addEventListener(type, fn, opt) {
        if (typeof fn !== 'function') return;
        const capture = typeof opt === 'boolean' ? opt : !!(opt && opt.capture);
        const L = this._ls[type] || (this._ls[type] = []);
        if (L.some(l => l.fn === fn && l.capture === capture)) return;
        L.push({ fn, capture, passive: !!(opt && typeof opt === 'object' && opt.passive), once: !!(opt && typeof opt === 'object' && opt.once) });
    }
    removeEventListener(type, fn, opt) {
        const capture = typeof opt === 'boolean' ? opt : !!(opt && opt.capture);
        const L = this._ls[type];
        if (!L) return;
        const i = L.findIndex(l => l.fn === fn && l.capture === capture);
        if (i >= 0) L.splice(i, 1);
    }
    listenerCount(type) { return (this._ls[type] || []).length; }
    _invoke(ev, phase) {
        const L = this._ls[ev.type];
        if (!L || !L.length) return;
        for (const l of L.slice()) {
            if (phase === 'capture' && !l.capture) continue;
            if (phase === 'bubble' && l.capture) continue;
            if (!this._ls[ev.type].includes(l)) continue;
            if (l.once) this.removeEventListener(ev.type, l.fn, l.capture);
            ev.currentTarget = this; ev._passive = l.passive;
            try { l.fn.call(this, ev); } catch (e) { errors.push(e); }
            ev._passive = false;
            if (ev._imm) return;
        }
    }
    // 捕获(自顶向下)→ 目标(先捕获后冒泡)→ 冒泡;stopPropagation 之后不再到下一个节点
    dispatchEvent(ev) {
        ev.target = this;
        const path = [];
        for (let p = this.parentNode; p; p = p.parentNode) path.push(p);
        const top = path.length ? path[path.length - 1] : null;
        if (top && top._win) path.push(top._win);
        for (let i = path.length - 1; i >= 0; i--) { path[i]._invoke(ev, 'capture'); if (ev._stop) return !ev.defaultPrevented; }
        this._invoke(ev, 'capture');
        if (!ev._stop) this._invoke(ev, 'bubble');
        if (ev.bubbles) for (const p of path) { if (ev._stop) break; p._invoke(ev, 'bubble'); }
        return !ev.defaultPrevented;
    }
}
class CL {
    constructor() { this.s = new Set(); }
    add(...a) { a.forEach(c => this.s.add(c)); }
    remove(...a) { a.forEach(c => this.s.delete(c)); }
    contains(c) { return this.s.has(c); }
    toggle(c, on) { if (on === undefined) on = !this.s.has(c); if (on) this.s.add(c); else this.s.delete(c); return !!on; }
}
function parseSel(sel) {
    return String(sel).split(',').map(s => s.trim()).filter(Boolean).map(chain => chain.split(/\s+/).map(comp => {
        const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)(\[[^\]]+\])?$/.exec(comp);
        if (!m) throw new Error('bad selector ' + comp);
        const parts = (m[2] || '').match(/[.#][\w-]+/g) || [];
        let attr = null;
        if (m[3]) { const a = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(m[3]); attr = a ? { k: a[1], v: a[2] } : null; }
        return { tag: m[1] ? m[1].toLowerCase() : '', cls: parts.filter(p => p[0] === '.').map(p => p.slice(1)), id: (parts.find(p => p[0] === '#') || '').slice(1), attr };
    }));
}
function matchComp(el, c) {
    if (!el || !el.tagName || !el.classList) return false;
    if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
    if (c.id && el.id !== c.id) return false;
    for (const k of c.cls) if (!el.classList.contains(k)) return false;
    if (c.attr) { const v = el.getAttribute(c.attr.k); if (v === null || (c.attr.v !== undefined && v !== c.attr.v)) return false; }
    return true;
}
function matchChain(el, chain) {
    if (!matchComp(el, chain[chain.length - 1])) return false;
    let i = chain.length - 2, p = el.parentNode;
    while (i >= 0 && p) { if (matchComp(p, chain[i])) i--; p = p.parentNode; }
    return i < 0;
}
const matchSel = (el, sel) => parseSel(sel).some(ch => matchChain(el, ch));
class El extends Tgt {
    constructor(tag) {
        super();
        this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.classList = new CL(); this.style = {};
        this.attrs = Object.create(null); this._text = ''; this.rect = { left: 0, top: 0, width: 0, height: 0 };
    }
    get className() { return Array.from(this.classList.s).join(' '); }
    set className(v) { this.classList.s = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = String(v); }
    setAttribute(k, v) { if (k === 'class') this.className = v; else this.attrs[k] = String(v); }
    getAttribute(k) { if (k === 'class') return this.className || null; return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    get innerHTML() { return this._html || ''; }
    set innerHTML(v) { this.textContent = ''; this._html = String(v); }
    contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
    getBoundingClientRect() { const r = this.rect; return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }; }
    get offsetWidth() { return this.rect.width; }
    get offsetHeight() { return this.rect.height; }
    matches(sel) { return matchSel(this, sel); }
    closest(sel) { for (let p = this; p && p.classList; p = p.parentNode) if (matchSel(p, sel)) return p; return null; }
    querySelectorAll(sel) { const out = [], ch = parseSel(sel); const walk = n => { for (const c of n.children) { if (ch.some(x => matchChain(c, x))) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getElementsByTagName(t) { return this.querySelectorAll(String(t).toLowerCase()); }
}
class Video extends El {
    constructor(clock) {
        super('video');
        this.clock = clock; this._ct = 0; this.duration = NaN; this.paused = true; this.ended = false; this.readyState = 0; this.seeking = false; this._rate = 1;
        this.muted = false; this.src = ''; this.videoWidth = 1920; this.videoHeight = 1080;
        this.buffered = { length: 0, start() { return 0; }, end() { return 0; } };
    }
    get currentTime() { return this._ct; }
    set currentTime(x) { this._ct = +x; this.seeking = true; this.clock.setTimeout(() => this.fire('seeking'), 0); this.clock.setTimeout(() => { this.seeking = false; this.fire('seeked'); }, 1); }
    get playbackRate() { return this._rate; }
    set playbackRate(r) { r = +r; if (r === this._rate) return; this._rate = r; this.clock.setTimeout(() => this.fire('ratechange'), 0); }
    fire(t) { this.dispatchEvent(new Ev(t)); }
    load() { }
}
class Doc extends El {
    constructor(clock) {
        super('#document');
        this.clock = clock;
        this.documentElement = new El('html'); this.appendChild(this.documentElement);
        this.head = new El('head'); this.body = new El('body');
        this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body);
        this.hidden = false; this.activeElement = this.body;
    }
    createElement(t) { return t === 'video' ? new Video(this.clock) : new El(t); }
    createElementNS(ns, t) { return new El(t); }
    getElementById(id) { return this.querySelector('#' + id); }
}
class Win extends Tgt { }
function mkLS() {
    const m = new Map();
    return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
}
function mkResp(status, body) {
    const txt = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    return { ok: status >= 200 && status < 300, status, text: async () => txt, json: async () => JSON.parse(txt) };
}
// 假 fetch:每次调用记一条;resp(status, body) 手动放出;auto(call) 自动应答;signal 中止 → AbortError
function mkFetch() {
    const calls = [];
    const f = (url, opts) => {
        const c = { url: String(url), opts: opts || {}, aborted: false, done: false };
        calls.push(c);
        return new Promise((res, rej) => {
            c.resp = (status, body) => { if (c.done || c.aborted) return; c.done = true; res(mkResp(status, body)); };
            const sig = opts && opts.signal;
            if (sig) {
                const ab = () => { if (c.done) return; c.aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
                if (sig.aborted) ab(); else sig.addEventListener('abort', ab);
            }
            if (f.auto) f.auto(c);
        });
    };
    f.calls = calls;
    return f;
}
// 一个世界:时钟 + 文档 + 窗口 + 本地存储 + fetch + 播放器 DOM(DPlayer 1.26 的结构)+ 假 dp
function mkWorld(o) {
    o = o || {};
    const clock = mkClock(o.t0);
    const doc = new Doc(clock);
    const win = new Win();
    doc._win = win;
    const ls = mkLS();
    const fetch = mkFetch();
    const beacons = [], posts = [];
    const mqs = Object.assign({ '(any-pointer: coarse)': true, '(pointer: coarse)': true, '(hover: none)': false }, o.mqs || {});
    const vue = Object.assign({ _playToken: 1, isTVMode: false, showDetail: true, corsProxyUrl: '', frameShare: { show: false } }, o.vue || {});
    let vueSets = 0;
    const vueProxy = new Proxy(vue, { set(t, k, v) { vueSets++; t[k] = v; return true; } });
    const nav = { onLine: true, connection: {}, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140 Mobile', maxTouchPoints: 5, sendBeacon: (u, b) => { beacons.push({ u, b }); return true; } };
    const DgAdult = Object.assign({
        workUrl: (wk, ex) => '/api/catalog/work?k=' + encodeURIComponent(wk) + (ex ? '&expand=1' : ''),
        ageGate: { accepted: () => true },
        auth: { post: (u, b) => { posts.push({ u, b }); return Promise.resolve(null); } }
    }, o.DgAdult || {});
    Object.assign(win, {
        document: doc, localStorage: ls, navigator: nav, innerWidth: 400, innerHeight: 800, devicePixelRatio: 2,
        matchMedia: q => ({ matches: !!mqs[q] }), location: { origin: 'https://site.test', href: 'https://site.test/' },
        PointerEvent: FakePointerEvent, Blob, btoa: s => Buffer.from(s, 'binary').toString('base64'), crypto: webcrypto, URL, AbortController,
        fetch, vueApp: vueProxy, DgAdult, dgPrivacy: o.dgPrivacy || null,
        getComputedStyle: (el) => ({ opacity: (el.classList.contains('dplayer-controller-show') || !(el.parentNode && el.parentNode.classList.contains('dplayer-hide-controller'))) ? '1' : '0' })
    });
    // 播放器 DOM
    const cont = new El('div'); cont.id = 'dplayer'; cont.className = 'dplayer dplayer-hide-controller';
    cont.rect = { left: 0, top: 100, width: 400, height: 225 };
    const vwrap = new El('div'); vwrap.className = 'dplayer-video-wrap'; vwrap.rect = Object.assign({}, cont.rect);
    const video = new Video(clock); video.className = 'dplayer-video'; video.rect = Object.assign({}, cont.rect);
    const dan = new El('div'); dan.className = 'dplayer-danmaku';
    vwrap.appendChild(video); vwrap.appendChild(dan);
    const ctl = new El('div'); ctl.className = 'dplayer-controller'; ctl.rect = { left: 0, top: 273, width: 400, height: 52 };
    const wrap = new El('div'); wrap.className = 'dplayer-bar-wrap'; wrap.rect = { left: 10, top: 276, width: 380, height: 34 };
    const bar = new El('div'); bar.className = 'dplayer-bar'; bar.rect = { left: 10, top: 290, width: 380, height: 6 };
    wrap.appendChild(bar); ctl.appendChild(wrap);
    const icons = new El('div'); icons.className = 'dplayer-icons';
    const setting = new El('div'); setting.className = 'dplayer-setting';
    const sbox = new El('div'); sbox.className = 'dplayer-setting-box';
    setting.appendChild(sbox); icons.appendChild(setting); ctl.appendChild(icons);
    const mask = new El('div'); mask.className = 'dplayer-mask';
    const dm = new El('div'); dm.className = 'dm-settings-panel'; dm.style.display = 'none';
    const skip = new El('button'); skip.className = 'intro-skip-btn';
    [vwrap, ctl, mask, dm, skip].forEach(x => cont.appendChild(x));
    doc.body.appendChild(cont);
    video.duration = o.dur == null ? 1000 : o.dur;
    video.readyState = 4; video.paused = !o.playing; video._ct = o.ct || 0;
    const dom = { cont, vwrap, video, dan, ctl, wrap, bar, icons, sbox, mask, dm, skip };
    // 假 dp(DPlayer 1.26 用到的那几样)
    const dp = {
        container: cont, video, options: { playbackSpeed: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3] }, seeks: [], speeds: [], autoHide: 0, toggles: 0, vols: [], _h: {}, danmaku: null,
        seek(t) { dp.seeks.push(t); t = Math.max(t, 0); if (dp.video.duration) t = Math.min(t, dp.video.duration); dp.video.currentTime = t; },
        speed(r) { dp.speeds.push(r); dp.video.playbackRate = r; },
        toggle() { dp.toggles++; dp.video.paused = !dp.video.paused; },
        volume(v) { dp.vols.push(v); return v; },
        controller: { setAutoHide() { dp.autoHide++; cont.classList.remove('dplayer-hide-controller'); }, show() { cont.classList.remove('dplayer-hide-controller'); } },
        on(n, f) { (dp._h[n] = dp._h[n] || []).push(f); }, emit(n) { (dp._h[n] || []).forEach(f => f()); }
    };
    // index.html 的倍速记忆(new DPlayer 之后 / 换集重绑):ratechange 就写 localStorage dplayer_speed(前者任何倍速都写,后者只写非 1)
    video.addEventListener('ratechange', () => { ls.setItem('dplayer_speed', String(video.playbackRate)); });
    video.addEventListener('ratechange', () => { const s = video.playbackRate; if (s && s !== 1) ls.setItem('dplayer_speed', String(s)); });
    const w = { clock, doc, win, ls, fetch, beacons, posts, vue, dom, dp, video, cont, get vueSets() { return vueSets; }, mqs, nav };
    w.mkPx = (extra) => Core.createPlayerX(Object.assign({ win, doc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, storage: ls }, extra || {}));
    return w;
}
const CTX = (wk, extra) => Object.assign({ wk, dur: 1000, isLive: false, lineKey: 'av_s01|1', siteKey: 'av_s01', vodId: '1', url: 'https://cdn.example.com/a/index.m3u8', fresh: true, episodes: 1 }, extra || {});
// 播放:媒体时间从 from 到 to,每 step 秒一次 timeupdate(墙上时间按倍速走)
async function playSpan(w, from, to, step, rate) {
    step = step || 0.25; rate = rate || 1;
    const v = w.video;
    v.paused = false; v._ct = from;
    if (Math.abs(v._rate - rate) > 1e-9) { v._rate = rate; }
    v.fire('timeupdate');   // 起点也有一次(浏览器开播 / seek 之后都会报)
    for (let t = from + step; t <= to + 1e-9; t += step) {
        v._ct = Math.min(t, to);
        v.fire('timeupdate');
        await w.clock.advance(step / rate * 1000);
    }
}
const decode = (b64) => Array.from(Buffer.from(b64, 'base64'));

// ======================= ① 纯逻辑 =======================
console.log('① 纯逻辑');
{
    const { addWatched, binsOut, eligible, b64, binOf } = Core;
    const w = new Float64Array(100);
    ok(near(addWatched(w, 5, 25, 1000), 20) && near(w[0], 5) && near(w[1], 10) && near(w[2], 5) && w[3] === 0, 'addWatched:跨格按重叠秒数分摊', Array.from(w.slice(0, 4)));
    const w2 = new Float64Array(100);
    ok(addWatched(w2, 995, 1005, 1000) === 5 && near(w2[99], 5) && addWatched(w2, 10, 5, 1000) === 0 && addWatched(w2, NaN, 5, 1000) === 0 && addWatched(w2, 0, 5, 0) === 0 && addWatched(w2, 0, 5, Infinity) === 0, 'addWatched:片尾夹住、倒序 / NaN / 没时长不记');
    const w3 = new Float64Array(100);
    let sum = 0; for (let t = 0; t < 1000; t += 0.37) sum += addWatched(w3, t, Math.min(1000, t + 0.37), 1000);
    ok(near(sum, 1000, 1e-6) && w3.every(x => near(x, 10, 1e-6)), 'addWatched:整片碎步播完每格正好 10 秒');
    const W = new Float64Array(100); W[0] = 5.9; W[1] = 6; W[2] = 15.9; W[3] = 16; W[4] = 1e6; W[5] = 0;
    const bonus = new Uint8Array(100); bonus[5] = 1; bonus[1] = 1;
    const out = binsOut(W, bonus, 1000);
    ok(out[0] === 0 && out[1] === 2 && out[2] === 1 && out[3] === 2 && out[4] === C.BIN_CAP && out[5] === 1 && out.length === 100, 'binsOut:不到 60% = 0、60% = 1、再多一整格 +1、跳转停留 +1、封顶 ' + C.BIN_CAP, Array.from(out.slice(0, 6)));
    ok(eligible(300, 7200) && !eligible(299, 7200) && eligible(60, 200) && !eligible(59, 200) && !eligible(100, NaN) && eligible(300, NaN), '门槛:≥5 分钟 或 ≥30%');
    const bytes = new Uint8Array(100); bytes[0] = 255; bytes[99] = 7;
    const s = b64(bytes, x => Buffer.from(x, 'binary').toString('base64'));
    ok(s.length === 136 && /==$/.test(s) && decode(s)[0] === 255 && decode(s)[99] === 7 && decode(s).length === 100, 'b64:100 字节 → 136 字符', s);
    ok(binOf(0, 1000) === 0 && binOf(999.9, 1000) === 99 && binOf(1000, 1000) === 99 && binOf(-1, 1000) === 0 && binOf(5, NaN) === -1 && binOf(5, Infinity) === -1, 'binOf');

    const { normHeat, smoothBins, heatPath } = Core;
    const bins = Array.from({ length: 100 }, (_, i) => (i === 70 ? 100 : i === 20 ? 40 : 5));
    ok(Array.isArray(normHeat({ bins, users: 3 })) && normHeat({ bins, users: 2 }) === null && normHeat({ bins: bins.slice(1), users: 9 }) === null
        && normHeat({ bins: new Array(100).fill(0), users: 9 }) === null && normHeat(null) === null && normHeat({ bins: 'x', users: 9 }) === null, 'normHeat:≥3 人、100 格、不全 0');
    ok(eq(normHeat({ bins: bins.map((x, i) => (i === 3 ? 'abc' : i === 4 ? 500 : i === 5 ? -3 : x)), users: 5 }).slice(3, 6), [0, 100, 0]), 'normHeat:非数 → 0、夹在 0..100');
    const sm = smoothBins(bins);
    ok(sm.length === 100 && sm.indexOf(Math.max(...sm)) === 70 && sm[70] < 100 && sm[69] > 5, 'smoothBins:长度不变、峰位不变、削峰填谷');
    const p = heatPath(sm, 1000, 100);
    const nums = (p.line.match(/-?\d+(\.\d+)?/g) || []).map(Number);
    const ys = [], xs = [];
    for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
    const iMin = ys.indexOf(Math.min(...ys));
    ok(/^M0 /.test(p.line) && /L1000 100L0 100Z$/.test(p.area) && p.area.startsWith(p.line) && ys.every(y => y >= 0 && y <= 100) && xs[iMin] > 650 && xs[iMin] < 760 && Math.min(...ys) <= 9,
        '曲线:从 0 到 1000、y 在 0..100、最高点落在第 70 格、顶上留 8%', { x: xs[iMin], y: Math.min(...ys) });
    ok(heatPath([0, 0, 0], 1000, 100) === null && heatPath([], 1000, 100) === null, '曲线:全 0 / 空 → null');

    const { scrubSpan, scrubTarget } = Core;
    ok(scrubSpan(7200) === 900 && scrubSpan(1000) === 250 && scrubSpan(120) === 60 && scrubSpan(30) === 30 && scrubSpan(NaN) === 0 && scrubSpan(Infinity) === 0, '横滑一屏宽 = 时长 1/4,夹 60..900 秒且不超时长');
    const a = scrubTarget(100, 23, 400, 1000), b = scrubTarget(100, 124, 400, 1000), c = scrubTarget(100, -424, 400, 1000), dd = scrubTarget(990, 400, 400, 1000), e = scrubTarget(100, 25, 400, 1000);
    ok(a.cancel && a.t === 100 && near(b.t, 162.5) && !b.cancel && near(b.delta, 62.5) && near(c.t, 0) && near(dd.t, 999.5) && e.cancel && near(e.t, 100.625), '横滑:24px 死区、按宽度比例、夹在 [0, 时长-0.5]、不到 1 秒算取消', [a, b, c, dd, e]);
    ok(scrubTarget(100, 50, 0, 1000).cancel && scrubTarget(100, 50, 400, NaN).cancel && scrubTarget(NaN, 50, 400, 1000).cancel, '横滑:没宽度 / 没时长 / 当前时间不明 → 取消');

    const { fmtTime, fmtDelta } = Core;
    const m = /secondToTime:(function\(e\)\{[\s\S]*?\.join\(":"\)\})/.exec(DPLAYER);
    ok(!!m, 'DPlayer 还有 secondToTime');
    if (m) {
        const dpFmt = vm.runInNewContext('(' + m[1] + ')');
        const vals = [0, 0.4, 1, 59.9, 60, 61.5, 599, 3599.9, 3600, 3661, 7322.7, 36000];
        ok(vals.every(v => fmtTime(v) === dpFmt(v)), '时间格式与 DPlayer secondToTime 一致', vals.map(v => [fmtTime(v), dpFmt(v)]));
    }
    ok(fmtDelta(62.5) === '+1:03' && fmtDelta(-45) === '−0:45' && fmtDelta(3725) === '+1:02:05' && fmtDelta(NaN) === '+0:00', 'fmtDelta:+1:03 / −0:45 / +1:02:05');

    const { zoneOf, seekedBy, nextSpeed } = Core;
    ok(zoneOf(139, 0, 400) === 'L' && zoneOf(140, 0, 400) === 'C' && zoneOf(260, 0, 400) === 'C' && zoneOf(261, 0, 400) === 'R' && zoneOf(5, 0, 0) === 'C', '双击分区与 index.html 一致:左 35% / 右 35%');
    ok(seekedBy(100, 90, 1000, -10) && seekedBy(100, 110, 1000, 10) && seekedBy(4, 0, 1000, -10) && seekedBy(995, 1000, 1000, 10) && !seekedBy(100, 100, 1000, -10)
        && !seekedBy(100, 95, 1000, -10) && !seekedBy(100, 110, 1000, -10) && !seekedBy(100, NaN, 1000, 10) && !seekedBy(995, 1000, NaN, 10), 'seekedBy:±10 或被片头片尾夹住才算');
    const L = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
    ok(nextSpeed(1, 1, L) === 1.25 && nextSpeed(1, -1, L) === 0.75 && nextSpeed(3, 1, L) === null && nextSpeed(0.5, -1, L) === null && nextSpeed(1.1, 1, L) === 1.25 && nextSpeed(1.1, -1, L) === 1 && nextSpeed(NaN, 1, L) === 1.25 && nextSpeed(2, 1, null) === 3, '倍速档:按列表上下一档');

    const { interactive, panelOpen, firstEpUrl, originOf, validWk, wkOf } = Core;
    const W2 = mkWorld();
    const d = W2.dom;
    const btn = new El('button'); d.vwrap.appendChild(btn);
    const inp = new El('input'); d.cont.appendChild(inp);
    const ce = new El('div'); ce.setAttribute('contenteditable', 'true'); d.cont.appendChild(ce);
    const roleBtn = new El('div'); roleBtn.setAttribute('role', 'button'); d.cont.appendChild(roleBtn);
    const spBox = new El('div'); spBox.className = 'dg-sp'; d.cont.appendChild(spBox);
    const outside = new El('div'); W2.doc.body.appendChild(outside);
    ok(!interactive(d.video, d.cont) && !interactive(d.dan, d.cont) && !interactive(d.cont, d.cont), '可接管:视频 / 弹幕层 / 容器本身');
    ok([d.bar, d.wrap, d.ctl, d.sbox, d.mask, d.dm, d.skip, btn, inp, ce, roleBtn, spBox, outside].every(x => interactive(x, d.cont)), '不接管:进度条 / 控制栏 / 齿轮菜单 / 遮罩 / 弹幕设置 / 跳过片头 / 按钮 / 输入框 / 可编辑 / role=button / 预览框 / 容器外');
    ok(!panelOpen(d.cont), '面板:都关着');
    d.sbox.classList.add('dplayer-setting-box-open'); const p1 = panelOpen(d.cont); d.sbox.classList.remove('dplayer-setting-box-open');
    d.mask.classList.add('dplayer-mask-show'); const p2 = panelOpen(d.cont); d.mask.classList.remove('dplayer-mask-show');
    d.dm.style.display = 'block'; const p3 = panelOpen(d.cont); d.dm.style.display = 'none';
    ok(p1 && p2 && p3 && !panelOpen(d.cont), '面板:齿轮菜单 / 遮罩 / 弹幕设置开着 = 有面板');
    ok(firstEpUrl('正片$https://a.example.com/1.m3u8#第2集$https://a.example.com/2.m3u8') === 'https://a.example.com/1.m3u8'
        && firstEpUrl('HD$https://x.example.com/v.mp4$$$HD$https://y.example.com/v/index.m3u8') === 'https://y.example.com/v/index.m3u8'
        && firstEpUrl('https://z.example.com/a.m3u8') === 'https://z.example.com/a.m3u8' && firstEpUrl('正片$/api/kz/ep/1') === '' && firstEpUrl('') === '' && firstEpUrl(null) === '',
        'firstEpUrl:与测速同一取法($$$ 取含 m3u8 的组、第一集、只要 http(s))');
    ok(originOf('https://cdn.example.com:8443/a/b.m3u8?x=1') === 'https://cdn.example.com:8443' && originOf('ftp://x.example.com/') === '' && originOf('https://u:p@x.example.com/') === '' && originOf('nope') === '', 'originOf:只要 http(s)、不带账号');
    ok(validWk('c:ABC-001') && validWk('t:abc') && !validWk('x:1') && !validWk('c:') && !validWk('c:' + 'x'.repeat(300)) && !validWk(1) && wkOf({ _wk: 'c:A' }) === 'c:A' && wkOf({ wk: 't:b' }) === 't:b' && wkOf({ wk: 'nope' }) === '' && wkOf(null) === '', '作品键');
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ======================= ② 热度条 =======================
console.log('② 热度条');
const HEAT = Array.from({ length: 100 }, (_, i) => (i >= 60 && i <= 75 ? 100 - Math.abs(68 - i) * 8 : 6));
await (async () => {
    const w = mkWorld();
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:ABC-001'));
    await w.clock.advance(3990);
    ok(w.fetch.calls.filter(c => /heat/.test(c.url)).length === 0, '暂停着、4 秒内没 playing:不拿热度(不跟起播抢)');
    await w.clock.advance(20);
    const hc = w.fetch.calls.filter(c => /heat/.test(c.url));
    ok(hc.length === 1 && hc[0].url === '/api/catalog/heat/c%3AABC-001' && !hc[0].opts.method && hc[0].opts.credentials === 'same-origin', '4 秒兜底:GET /api/catalog/heat/:wk(编码过的作品键)', hc.map(c => c.url));
    hc[0].resp(200, { bins: HEAT, users: 5 });
    await w.clock.advance(1);
    const svg = w.dom.bar.querySelector('.dgx-heat');
    ok(!!svg && svg.parentNode === w.dom.bar && svg.classList.contains('on') && svg.getAttribute('preserveAspectRatio') === 'none' && svg.getAttribute('aria-hidden') === 'true', '画进 .dplayer-bar(跟着进度条走、不占布局)');
    const pa = svg && svg.querySelector('.dgx-heat-a'), pl = svg && svg.querySelector('.dgx-heat-l');
    ok(pa && pl && /^M0 /.test(pl.getAttribute('d')) && /Z$/.test(pa.getAttribute('d')), '面积 + 线两条路径');
    ok(px.status().heat.shown && w.doc.getElementById('dgx-css'), '状态 / 样式表');
    // 同一部换线路:不重拿、条还在
    px.onPlayerReady(w.dp, w.video, CTX('c:ABC-001', { lineKey: 'av_s02|9' }));
    await w.clock.advance(5000);
    ok(w.fetch.calls.filter(c => /heat/.test(c.url)).length === 1 && w.dom.bar.querySelector('.dgx-heat'), '同一部换线路:不重拿,条还在');
    // 重建播放器(新容器 / 新进度条):重新插进去
    const w2dom = mkWorld().dom;   // 另一套 DOM 当作新播放器
    const dp2 = Object.assign({}, w.dp, { container: w2dom.cont, video: w2dom.video, _h: {} });
    dp2.on = (n, f) => { (dp2._h[n] = dp2._h[n] || []).push(f); };
    px.onPlayerDestroy('rebuild');
    ok(!w.dom.bar.querySelector('.dgx-heat'), 'rebuild:旧条拆掉');
    px.onPlayerReady(dp2, w2dom.video, CTX('c:ABC-001'));
    await w.clock.advance(10);
    ok(w2dom.bar.querySelector('.dgx-heat') && w.fetch.calls.filter(c => /heat/.test(c.url)).length === 1, '重建播放器:新进度条上重画,不重拿');
})();
await (async () => {
    // playing 一到就拿;204 / 不到 3 人 / 形状不对 → 不画
    for (const [status, body, why] of [[204, null, '204'], [200, { bins: HEAT, users: 2 }, '不到 3 人'], [200, { bins: HEAT.slice(1), users: 9 }, '99 格'], [200, '<html>', '不是 JSON'], [500, { error: 1 }, '500']]) {
        const w = mkWorld();
        const px = w.mkPx();
        px.onPlayerReady(w.dp, w.video, CTX('c:ABC-002'));
        await w.clock.advance(500);
        w.video.paused = false; w.video.fire('playing');
        const hc = w.fetch.calls.filter(c => /heat/.test(c.url));
        hc.forEach(c => c.resp(status, body));
        await w.clock.advance(10);
        ok(hc.length === 1 && !w.dom.bar.querySelector('.dgx-heat') && errors.length === 0, 'playing 即拿;' + why + ' → 不画', { n: hc.length, e: errors.map(String) });
    }
    // 已经在播时 onPlayerReady → 立刻拿
    const w = mkWorld({ playing: true });
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:ABC-003'));
    ok(w.fetch.calls.filter(c => /heat/.test(c.url)).length === 1, '已经在播:立刻拿');
    // 换作品:旧请求中止、迟到的旧结果不画
    px.onPlayerReady(w.dp, w.video, CTX('c:ABC-004'));
    const hc = w.fetch.calls.filter(c => /heat/.test(c.url));
    ok(hc.length === 2 && hc[0].aborted && !hc[1].aborted, '换作品:旧请求中止', hc.map(c => [c.url, c.aborted]));
    hc[0].resp(200, { bins: HEAT, users: 9 });
    await w.clock.advance(5);
    ok(!w.dom.bar.querySelector('.dgx-heat'), '换作品:旧结果不画');
    hc[1].resp(200, { bins: HEAT, users: 9 });
    await w.clock.advance(5);
    ok(!!w.dom.bar.querySelector('.dgx-heat'), '换作品:新结果画上');
    // 直播 / 没作品键:不拿不画
    const w3 = mkWorld({ playing: true });
    const px3 = w3.mkPx();
    px3.onPlayerReady(w3.dp, w3.video, CTX('c:ABC-005', { isLive: true }));
    px3.onPlayerReady(w3.dp, w3.video, CTX(''));
    await w3.clock.advance(6000);
    ok(w3.fetch.calls.length === 0 && !w3.dom.bar.querySelector('.dgx-heat'), '直播 / 不是目录作品:不拿热度');
    // 关播放页:条拆掉、在路上的请求中止
    const w4 = mkWorld({ playing: true });
    const px4 = w4.mkPx();
    px4.onPlayerReady(w4.dp, w4.video, CTX('c:ABC-006'));
    px4.onPlayerDestroy('close');
    ok(w4.fetch.calls[0] && w4.fetch.calls[0].aborted, '关播放页:在路上的热度请求中止');
    // 样式:让开缩略图框、不吃指针、绝对定位
    ok(Core.CSS.includes('.dplayer.dg-sp-on .dgx-heat{opacity:0!important}') && /\.dgx-heat\{position:absolute;[^}]*bottom:100%[^}]*pointer-events:none/.test(Core.CSS), '样式:绝对定位在进度条上沿、pointer-events:none、缩略图框亮着时藏');
    ok(/dg-sp-on/.test(SP_SRC) && /classList\.add\('dg-sp-on'\)/.test(SP_SRC), 'seek-preview.js 亮框时仍给容器加 dg-sp-on');
})();

// ======================= ③ 热度贡献 =======================
console.log('③ 热度贡献');
await (async () => {
    const w = mkWorld();
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:ABC-001'));
    w.video.paused = false; w.video.fire('playing');
    await playSpan(w, 0, 400, 0.25, 1);
    ok(near(px.status().sess.total, 400, 0.01) && px.status().sess.eligible, '1x 播 400 秒:记 400 秒,够门槛', px.status().sess);
    px.onPlayerDestroy('close');
    ok(w.posts.length === 1 && w.posts[0].u === '/api/catalog/heat' && w.beacons.length === 0, '关播放页:走 DgAdult.auth.post 发一次', w.posts.map(p => p.u));
    const b = w.posts[0] && w.posts[0].b;
    const bins = b ? decode(b.bins) : [];
    ok(b && b.wk === 'c:ABC-001' && b.dur === 1000 && /^[0-9a-f]{32}$/.test(b.dev) && bins.length === 100 && bins.slice(0, 40).every(x => x === 1) && bins.slice(40).every(x => x === 0),
        '上报 {wk, dur, bins(100 字节), dev(32 位十六进制)}:看过的 40 格 = 1', { wk: b && b.wk, dur: b && b.dur, head: bins.slice(38, 42) });
    ok(w.ls.getItem('dgx_dev') === b.dev && JSON.parse(w.ls.getItem('dgx_heat_sent'))['c:ABC-001'] === Core.utcDay(w.clock.now()), '设备号存本机;今天发过的记下');
    // 同一天再看:不再发;第二天:再发
    px.onPlayerReady(w.dp, w.video, CTX('c:ABC-001'));
    w.video.fire('playing');
    await playSpan(w, 0, 400, 0.5, 1);
    px.onPlayerDestroy('close');
    ok(w.posts.length === 1, '同一部同一天:只发一次');
    w.clock.t += 86400000;
    px.onPlayerReady(w.dp, w.video, CTX('c:ABC-001'));
    w.video.fire('playing');
    await playSpan(w, 0, 400, 0.5, 1);
    px.onPlayerDestroy('home');
    ok(w.posts.length === 2 && w.posts[1].b.dev === b.dev, '第二天:再发一次(同一个设备号)');
    ok(w.vueSets === 0 && errors.length === 0, '从不写 Vue 状态、不抛', { sets: w.vueSets, e: errors.map(String) });
})();
await (async () => {
    // 跳变 / 倍速范围
    const w = mkWorld();
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:R-001'));
    w.video.fire('playing');
    await playSpan(w, 0, 10, 0.25, 1);
    const t1 = px.status().sess.total;
    w.video._ct = 13; w.video.fire('timeupdate');   // 跳了 3 秒(没有 seeking:比如卡顿后追帧)
    const t2 = px.status().sess.total;
    await playSpan(w, 13, 23, 0.5, 3);    // 3 倍速
    const t3 = px.status().sess.total;
    await playSpan(w, 23, 25, 0.1, 0.25); // 0.25 倍速
    const t4 = px.status().sess.total;
    await playSpan(w, 25, 45, 0.5, 2);    // 长按 2 倍速:照记
    const t5 = px.status().sess.total;
    ok(near(t1, 10, 0.01) && near(t2, 10, 0.01) && near(t3, 10, 0.01) && near(t4, 10, 0.01) && near(t5, 30, 0.01), '跳变 >2s、3x、0.25x 不记;2x 照记', [t1, t2, t3, t4, t5]);
    w.video.paused = true; w.video._ct = 46; w.video.fire('timeupdate');
    ok(near(px.status().sess.total, 30, 0.01), '暂停时的 timeupdate 不记');
    // 门槛
    for (const [dur, watch, send, why] of [[200, 70, true, '200 秒的片看 70 秒(35%)'], [1000, 250, false, '1000 秒的片看 250 秒(25%、不到 5 分钟)'], [7200, 300, true, '2 小时的片看满 5 分钟']]) {
        const x = mkWorld({ dur });
        const p = x.mkPx();
        p.onPlayerReady(x.dp, x.video, CTX('c:T-' + dur));
        x.video.fire('playing');
        await playSpan(x, 0, watch, 1, 1);
        p.onPlayerDestroy('close');
        ok((x.posts.length === 1) === send, '门槛:' + why + (send ? ' → 发' : ' → 不发'), x.posts.length);
    }
})();
await (async () => {
    // 60% 才算、回看累加、用户跳过去停留 +1、程序跳转 / 续播跳转不算
    const w = mkWorld();
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:S-001'));
    // 续播:第一次 playing 之前,用户刚点过(打开作品),index.html 恢复进度 seek 到 500 → 不算
    w.doc.body.dispatchEvent(new Ev('pointerdown', { bubbles: true, pointerType: 'touch' }));
    w.video.currentTime = 500;
    await w.clock.advance(5);
    w.video.paused = false; w.video.fire('playing');
    await playSpan(w, 500, 507, 0.25, 1);          // 第 50 格播 7 秒(70%)
    await w.clock.advance(2000);
    w.video.currentTime = 0; await w.clock.advance(5);   // 没操作的跳转
    await playSpan(w, 0, 300, 1, 1);               // 先攒够门槛
    await w.clock.advance(2000);
    // 用户跳到 700(1.5 秒内有操作)并停留 6 秒 → 第 70 格 = 1(6 秒 = 60%)+ 1
    w.doc.body.dispatchEvent(new Ev('touchend', { bubbles: true }));
    w.video.currentTime = 700;
    await w.clock.advance(5);
    await playSpan(w, 700, 706, 0.25, 1);
    await w.clock.advance(3000);
    // 程序跳转(插播跳过之类,前后 3 秒没操作)到 800 停 6 秒 → 第 80 格只有 1
    w.video.currentTime = 800;
    await w.clock.advance(5);
    await playSpan(w, 800, 806, 0.25, 1);
    // 用户跳到 900 只停 3 秒 → 第 90 格 = 0(不到 60%)且没有 +1
    w.doc.body.dispatchEvent(new Ev('keydown', { bubbles: true, key: 'x' }));
    w.video.currentTime = 900;
    await w.clock.advance(5);
    await playSpan(w, 900, 903, 0.25, 1);
    // 第 60 格回看两遍(20 秒)→ 2
    await w.clock.advance(3000);
    w.video.currentTime = 600; await w.clock.advance(5);
    await playSpan(w, 600, 610, 0.25, 1);
    w.video.currentTime = 600; await w.clock.advance(5);   // 没操作的回跳(循环播放之类)
    await playSpan(w, 600, 610, 0.25, 1);
    px.onPlayerDestroy('close');
    const bins = w.posts[0] ? decode(w.posts[0].b.bins) : [];
    ok(bins[50] === 1 && bins[70] === 2 && bins[80] === 1 && bins[90] === 0 && bins[60] === 2 && bins[10] === 1, '续播跳转不加分、用户跳转停留 ≥5s +1、程序跳转不加、停 3 秒不算、回看两遍 = 2',
        { b50: bins[50], b70: bins[70], b80: bins[80], b90: bins[90], b60: bins[60], b10: bins[10] });
})();
await (async () => {
    // 同一部换线路:续播跳转重新算宽限期(点线路 → index.html 恢复进度 seek,不算用户跳转)
    const w = mkWorld();
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:S-002'));
    w.video.fire('playing');
    await playSpan(w, 0, 300, 1, 1);
    w.doc.body.dispatchEvent(new Ev('pointerdown', { bubbles: true, pointerType: 'mouse' }));   // 点了另一条线路
    px.onPlayerReady(w.dp, w.video, CTX('c:S-002', { lineKey: 'av_s09|3' }));
    w.video.currentTime = 400;                                                                  // 新线路恢复进度
    await w.clock.advance(5);
    w.video.fire('playing');
    await playSpan(w, 400, 406, 0.25, 1);
    px.onPlayerDestroy('close');
    const bins = w.posts[0] ? decode(w.posts[0].b.bins) : [];
    ok(w.posts.length === 1 && bins[40] === 1 && bins[0] === 1, '换线路后的续播跳转不加分(第 40 格只有播放的 1)', bins.slice(39, 42));
})();
await (async () => {
    // 无痕:不记不发、连设备号都不生成;中途打开无痕:这一部作废;隐私模块出错 = 当无痕
    let inc = true;
    const subs = [];
    const priv = { incognito: () => inc, locked: () => false, onChange: (f) => { subs.push(f); return () => { }; } };
    const w = mkWorld({ dgPrivacy: priv });
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:P-001'));
    w.video.fire('playing');
    await playSpan(w, 0, 400, 1, 1);
    w.doc.hidden = true; w.doc.dispatchEvent(new Ev('visibilitychange'));
    w.win.dispatchEvent(new Ev('pagehide'));
    px.onPlayerDestroy('close');
    ok(w.posts.length === 0 && w.beacons.length === 0 && w.ls.getItem('dgx_dev') === null && w.ls.getItem('dgx_heat_pend') === null && w.ls.getItem('dgx_heat_sent') === null, '无痕:不发、不存待发、不生成设备号');
    ok(subs.length === 1, '订阅了 dgPrivacy.onChange');
    inc = false;
    w.doc.hidden = false;
    px.onPlayerReady(w.dp, w.video, CTX('c:P-002'));
    w.video.fire('playing');
    await playSpan(w, 0, 400, 1, 1);
    inc = true; subs.forEach(f => f());
    inc = false;   // 又关掉:这一部已经作废,不会补上
    px.onPlayerDestroy('close');
    ok(w.posts.length === 0, '中途打开无痕:这一部作废(关掉无痕也不补)');
    const w2 = mkWorld({ dgPrivacy: { incognito: () => { throw new Error('boom'); }, onChange() { } } });
    const px2 = w2.mkPx();
    px2.onPlayerReady(w2.dp, w2.video, CTX('c:P-003'));
    w2.video.fire('playing');
    await playSpan(w2, 0, 400, 1, 1);
    px2.onPlayerDestroy('close');
    ok(w2.posts.length === 0, '隐私模块出错:当无痕(不发)');
})();
await (async () => {
    // pagehide → sendBeacon(JSON);切后台 → 存待发;下次打开 8 秒后补发;无痕时丢掉
    const w = mkWorld();
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:B-001'));
    w.video.fire('playing');
    await playSpan(w, 0, 350, 1, 1);
    w.win.dispatchEvent(new Ev('pagehide'));
    ok(w.beacons.length === 1 && w.posts.length === 0 && w.beacons[0].u === '/api/catalog/heat', 'pagehide:走 sendBeacon');
    const body = w.beacons[0] ? JSON.parse(await w.beacons[0].b.text()) : null;
    ok(body && body.wk === 'c:B-001' && body.dur === 1000 && decode(body.bins).length === 100 && w.beacons[0].b.type === 'application/json', 'sendBeacon 的正文:JSON {wk,dur,bins,dev}', body);

    const w2 = mkWorld();
    const pa = w2.mkPx();
    pa.onPlayerReady(w2.dp, w2.video, CTX('c:B-002'));
    w2.video.fire('playing');
    await playSpan(w2, 0, 320, 1, 1);
    w2.doc.hidden = true; w2.doc.dispatchEvent(new Ev('visibilitychange'));
    const pend = JSON.parse(w2.ls.getItem('dgx_heat_pend') || 'null');
    ok(pend && pend.wk === 'c:B-002' && pend.day === Core.utcDay(w2.clock.now()) && decode(pend.bins).length === 100 && w2.posts.length === 0, '切后台:存一份待发(不发)', pend);
    // 回来接着看,再关:发最新的、清掉待发
    w2.doc.hidden = false;
    await playSpan(w2, 320, 360, 1, 1);
    pa.onPlayerDestroy('close');
    ok(w2.posts.length === 1 && w2.ls.getItem('dgx_heat_pend') === null && decode(w2.posts[0].b.bins).slice(0, 36).every(x => x === 1), '回来接着看再关:发最新的,待发清掉');
    // 后台被杀:下次打开(新实例、同一份存储)8 秒后补发
    w2.ls.setItem('dgx_heat_pend', JSON.stringify({ wk: 'c:B-003', dur: 1000, bins: pend.bins, day: pend.day }));
    const pb = Core.createPlayerX({ win: w2.win, doc: w2.doc, now: w2.clock.now, setTimeout: w2.clock.setTimeout, clearTimeout: w2.clock.clearTimeout, storage: w2.ls });
    await w2.clock.advance(7900);
    ok(w2.posts.length === 1, '补发:打开 8 秒内不发(不跟起播抢)');
    await w2.clock.advance(200);
    ok(w2.posts.length === 2 && w2.posts[1].b.wk === 'c:B-003' && w2.ls.getItem('dgx_heat_pend') === null && JSON.parse(w2.ls.getItem('dgx_heat_sent'))['c:B-003'] != null && pb.status().n.pendSent === 1, '补发:8 秒后发出、清掉、记今天发过');
    // 太旧(前天)/ 坏数据 / 无痕 → 丢掉不发
    for (const [pd, why] of [[{ wk: 'c:B-004', dur: 1000, bins: pend.bins, day: pend.day - 2 }, '前天的'], [{ wk: 'c:B-005', dur: 1000, bins: 'AAAA', day: pend.day }, 'bins 坏'], [{ wk: 'evil', dur: 1000, bins: pend.bins, day: pend.day }, '作品键不对']]) {
        w2.ls.setItem('dgx_heat_pend', JSON.stringify(pd));
        Core.createPlayerX({ win: w2.win, doc: w2.doc, now: w2.clock.now, setTimeout: w2.clock.setTimeout, clearTimeout: w2.clock.clearTimeout, storage: w2.ls });
        await w2.clock.advance(8100);
        ok(w2.posts.length === 2 && w2.ls.getItem('dgx_heat_pend') === null, '补发:' + why + ' → 丢掉');
    }
    w2.ls.setItem('dgx_heat_pend', JSON.stringify({ wk: 'c:B-006', dur: 1000, bins: pend.bins, day: pend.day }));
    w2.win.dgPrivacy = { incognito: () => true };
    Core.createPlayerX({ win: w2.win, doc: w2.doc, now: w2.clock.now, setTimeout: w2.clock.setTimeout, clearTimeout: w2.clock.clearTimeout, storage: w2.ls });
    await w2.clock.advance(8100);
    ok(w2.posts.length === 2, '补发:无痕时不发');
})();
await (async () => {
    // rebuild 接着记(只发一次、两段都在);换作品先把上一部发掉;直播不记
    const w = mkWorld();
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:K-001'));
    w.video.fire('playing');
    await playSpan(w, 0, 200, 1, 1);
    px.onPlayerDestroy('rebuild');
    const w2dom = mkWorld({ t0: w.clock.now() }).dom;
    w2dom.video.clock = w.clock;
    const dp2 = Object.assign({}, w.dp, { container: w2dom.cont, video: w2dom.video, _h: {} });
    dp2.on = (n, f) => { (dp2._h[n] = dp2._h[n] || []).push(f); };
    px.onPlayerReady(dp2, w2dom.video, CTX('c:K-001'));
    const vSave = w.video; w.video = w2dom.video; w2dom.video.duration = 1000; w2dom.video.fire('playing');
    await playSpan(w, 500, 610, 1, 1);
    px.onPlayerReady(dp2, w2dom.video, CTX('c:K-002'));   // 换一部:先发上一部
    const bins = w.posts[0] ? decode(w.posts[0].b.bins) : [];
    ok(w.posts.length === 1 && w.posts[0].b.wk === 'c:K-001' && bins.slice(0, 20).every(x => x === 1) && bins.slice(50, 61).every(x => x === 1) && bins[30] === 0, 'rebuild 接着记、换作品时把上一部发掉(两段都在)', bins.slice(48, 62));
    px.onPlayerReady(dp2, w2dom.video, CTX('c:K-003', { isLive: true }));
    await playSpan(w, 0, 400, 1, 1);
    px.onPlayerDestroy('close');
    ok(w.posts.length === 1 && px.status().sess === null, '直播:不记不发');
    // DPlayer 自己发 destroy 事件:只拆接线,不发
    const x = mkWorld();
    const p = x.mkPx();
    p.onPlayerReady(x.dp, x.video, CTX('c:K-004'));
    x.video.fire('playing');
    await playSpan(x, 0, 400, 1, 1);
    x.dp.emit('destroy');
    ok(x.posts.length === 0 && !p.status().bound && p.status().sess && p.status().sess.total >= 399, 'DPlayer destroy 事件:只拆接线,记录留着(不算看完)');
    w.video = vSave;
})();

// ======================= ④ 手势(真 index.html 手势代码 + 真 seek-preview 控制器) =======================
console.log('④ 手势');
const SSB = (/const safeSeekBy = \(delta\) => \{[\s\S]*?\n\s*\};/.exec(HTML) || [''])[0];
const G0 = HTML.indexOf('let _swipeConsumed = false;');
const G1 = G0 > 0 ? HTML.indexOf('// 倍速变化时显示指示器', G0) : -1;
const GSNIP = G1 > G0 ? HTML.slice(G0, G1) : '';
ok(!!SSB && !!GSNIP && /width \* 0\.35/.test(GSNIP) && /now - lastTap < 300/.test(GSNIP), 'index.html 的 safeSeekBy / 双击(35% 分区、300ms)/ 亮度音量手势代码还在');
class FakeHls { static isSupported() { return true; } }
FakeHls.Events = {};
FakeHls.DefaultConfig = {};
async function mkGestureWorld(o) {
    o = o || {};
    const w = mkWorld(Object.assign({ playing: true, ct: 100 }, o));
    const gctx = vm.createContext({ document: w.doc, navigator: w.win.navigator, window: w.win, Date: { now: () => w.clock.now() }, setTimeout: w.clock.setTimeout, clearTimeout: w.clock.clearTimeout, console, Number, Math });
    const hintL = new El('div'); hintL.className = 'dplayer-seek-hint left'; w.cont.appendChild(hintL);
    const hintR = new El('div'); hintR.className = 'dplayer-seek-hint right'; w.cont.appendChild(hintR);
    w.overlay = 0;
    if (GSNIP) {
        const install = vm.runInContext('(function (container, dp, seekHintLeft, seekHintRight, updateOverlayState, mobilePlayOverlay) {\n' +
            'let lastTap = 0; let tapTimeout = null; let controllerHideTimer = null; const SEEK_SECONDS = 10;\n' + SSB + '\n' + GSNIP + '\n})', gctx);
        const mpo = new El('div'); mpo.className = 'mobile-play-overlay'; w.cont.appendChild(mpo);
        install(w.cont, w.dp, hintL, hintR, () => { w.overlay++; }, mpo);
    }
    // 排在 index.html 之后的冒泡监听:被我们截停的 touchend 不该到这里
    w.bubbleTE = 0;
    w.cont.addEventListener('touchend', () => { w.bubbleTE++; });
    // DPlayer 的右键菜单(容器上的冒泡监听)
    w.ctxMenu = 0;
    w.cont.addEventListener('contextmenu', () => { w.ctxMenu++; });
    // 真 seek-preview 控制器
    w.video.src = 'blob:https://site.test/1';
    w.sp = SPCore.createController({ win: w.win, doc: w.doc, now: w.clock.now, setTimeout: w.clock.setTimeout, clearTimeout: w.clock.clearTimeout, raf: f => w.clock.setTimeout(f, 16), getHls: () => FakeHls, getVue: () => w.win.vueApp });
    w.sp.bind({ container: w.cont, template: { playedBarWrap: w.dom.wrap }, events: { on() { } } }, w.video, 'https://cdn.example.com/a/index.m3u8');
    w.ls.setItem('dplayer_speed', o.lsSpeed == null ? '1.25' : o.lsSpeed);
    w.video._rate = o.rate == null ? 1.25 : o.rate;
    w.px = w.mkPx();
    w.px.onPlayerReady(w.dp, w.video, CTX('c:G-001', o.ctx || {}));
    await w.clock.advance(10);
    return w;
}
const P = (x, y, id) => ({ identifier: id == null ? 1 : id, clientX: x, clientY: y });
function touch(w, type, target, pts, opt) {
    opt = opt || {};
    const end = type === 'touchend' || type === 'touchcancel';
    const ev = new Ev(type, { bubbles: true, cancelable: opt.cancelable !== false && type !== 'touchcancel', touches: end ? (opt.rest || []) : pts, changedTouches: opt.changed || pts });
    target.dispatchEvent(ev);
    return ev;
}
await (async () => {
    // 长按 2 倍速
    const w = await mkGestureWorld();
    const V = w.video;
    touch(w, 'touchstart', V, [P(200, 200)]);
    await w.clock.advance(440);
    ok(V.playbackRate === 1.25 && !w.px.status().lp, '长按:不到 450ms 不动');
    await w.clock.advance(20);
    ok(V.playbackRate === 2 && w.px.status().lp && w.cont.classList.contains('dgx-lp'), '长按 ≥450ms:2 倍速');
    const badge = w.cont.querySelector('.dgx-badge');
    ok(badge && badge.classList.contains('on') && /2x/.test(badge.textContent) && /▶▶/.test(badge.textContent), '长按:顶部「2x ▶▶」');
    await w.clock.advance(5);
    ok(w.ls.getItem('dplayer_speed') === '1.25', '长按:index.html 把 2 记成用户倍速 → 原值写回去');
    const te = touch(w, 'touchend', V, [P(200, 200)]);
    await w.clock.advance(5);
    ok(V.playbackRate === 1.25 && !w.px.status().lp && !badge.classList.contains('on') && w.ls.getItem('dplayer_speed') === '1.25', '松手:恢复原来的 1.25 倍,记忆原样');
    ok(te.defaultPrevented && w.bubbleTE === 0, '松手的 touchend:preventDefault + 不再传给 index.html');
    const hiddenBefore = w.cont.classList.contains('dplayer-hide-controller');
    await w.clock.advance(400);
    ok(w.cont.classList.contains('dplayer-hide-controller') === hiddenBefore && w.overlay === 0, '长按之后 index.html 不把它当单击(控制栏不切换)');
    // 紧接着在左侧点一下:index.html 不会把它和长按凑成双击
    const t0 = V.currentTime;
    touch(w, 'touchstart', V, [P(40, 200)]); await w.clock.advance(30); touch(w, 'touchend', V, [P(40, 200)]);
    await w.clock.advance(5);
    ok(V.currentTime === t0, '长按松手后马上点一下:不会凑成双击快退');
    await w.clock.advance(1700);
    ok(!w.cont.classList.contains('dgx-lp'), '倍速浮层的遮挡 1.6 秒后撤掉');
    ok(Core.CSS.includes('.dgx-lp .dplayer-speed-indicator{opacity:0!important}'), '长按期间藏 index.html 的倍速浮层');
})();
await (async () => {
    // 不触发的情况
    const cases = [
        ['移动超过 10px', async (w) => { touch(w, 'touchstart', w.video, [P(200, 200)]); await w.clock.advance(100); touch(w, 'touchmove', w.video, [P(200, 214)]); await w.clock.advance(500); touch(w, 'touchend', w.video, [P(200, 214)]); }],
        ['暂停着', async (w) => { w.video.paused = true; touch(w, 'touchstart', w.video, [P(200, 200)]); await w.clock.advance(600); touch(w, 'touchend', w.video, [P(200, 200)]); }],
        ['按在控制栏上', async (w) => { touch(w, 'touchstart', w.dom.icons, [P(200, 300)]); await w.clock.advance(600); touch(w, 'touchend', w.dom.icons, [P(200, 300)]); }],
        ['按在进度条上', async (w) => { touch(w, 'touchstart', w.dom.bar, [P(200, 293)]); await w.clock.advance(600); touch(w, 'touchend', w.dom.bar, [P(200, 293)]); }],
        ['齿轮菜单开着', async (w) => { w.dom.sbox.classList.add('dplayer-setting-box-open'); touch(w, 'touchstart', w.video, [P(200, 200)]); await w.clock.advance(600); touch(w, 'touchend', w.video, [P(200, 200)]); }],
        ['弹幕设置开着', async (w) => { w.dom.dm.style.display = 'block'; touch(w, 'touchstart', w.video, [P(200, 200)]); await w.clock.advance(600); touch(w, 'touchend', w.video, [P(200, 200)]); }],
        ['跳过片头按钮', async (w) => { touch(w, 'touchstart', w.dom.skip, [P(300, 150)]); await w.clock.advance(600); touch(w, 'touchend', w.dom.skip, [P(300, 150)]); }],
        ['不是触屏设备', async (w) => { w.mqs['(any-pointer: coarse)'] = false; w.mqs['(pointer: coarse)'] = false; touch(w, 'touchstart', w.video, [P(200, 200)]); await w.clock.advance(600); touch(w, 'touchend', w.video, [P(200, 200)]); }],
        ['两根手指', async (w) => { touch(w, 'touchstart', w.video, [P(200, 200), P(250, 200, 2)]); await w.clock.advance(600); touch(w, 'touchend', w.video, [P(200, 200)], { rest: [P(250, 200, 2)] }); }]
    ];
    for (const [why, run] of cases) {
        const w = await mkGestureWorld();
        await run(w);
        await w.clock.advance(5);
        ok(w.video.playbackRate === 1.25 && w.px.status().n.lp === 0, '长按不触发:' + why);
    }
    const wl = await mkGestureWorld({ ctx: { isLive: true } });
    touch(wl, 'touchstart', wl.video, [P(200, 200)]); await wl.clock.advance(600); touch(wl, 'touchend', wl.video, [P(200, 200)]);
    ok(wl.video.playbackRate === 1.25 && wl.px.status().n.lp === 0, '长按不触发:直播');
})();
await (async () => {
    // 长按中途:取消 / 第二根手指 / 视频暂停 / 切后台 → 恢复;contextmenu 拦截
    for (const [why, run] of [
        ['touchcancel', (w) => touch(w, 'touchcancel', w.video, [P(200, 200)])],
        ['第二根手指', (w) => touch(w, 'touchstart', w.video, [P(200, 200), P(260, 210, 2)])],
        ['视频暂停', (w) => { w.video.paused = true; w.video.fire('pause'); }],
        ['切后台', (w) => { w.doc.hidden = true; w.doc.dispatchEvent(new Ev('visibilitychange')); }]
    ]) {
        const w = await mkGestureWorld();
        touch(w, 'touchstart', w.video, [P(200, 200)]);
        await w.clock.advance(500);
        const on = w.video.playbackRate === 2;
        run(w);
        await w.clock.advance(5);
        ok(on && w.video.playbackRate === 1.25 && !w.px.status().lp && w.ls.getItem('dplayer_speed') === '1.25', '长按中途' + why + ':恢复原倍速');
        if (why === '第二根手指') {
            const te = touch(w, 'touchend', w.video, [P(200, 200)], { rest: [P(260, 210, 2)] });
            const te2 = touch(w, 'touchend', w.video, [P(260, 210, 2)]);
            ok(te.defaultPrevented && te2.defaultPrevented && w.bubbleTE === 0, '第二根手指之后这一串 touchend 都吞掉(不当点击)');
        }
    }
    const w = await mkGestureWorld();
    touch(w, 'touchstart', w.video, [P(200, 200)]);
    await w.clock.advance(560);
    const cm = new Ev('contextmenu', { bubbles: true, cancelable: true });
    w.video.dispatchEvent(cm);
    ok(cm.defaultPrevented && w.ctxMenu === 0, '长按时安卓的 contextmenu:拦下(DPlayer 不弹右键菜单)');
    touch(w, 'touchend', w.video, [P(200, 200)]);
    await w.clock.advance(1000);
    const cm2 = new Ev('contextmenu', { bubbles: true, cancelable: true });
    w.video.dispatchEvent(cm2);
    ok(!cm2.defaultPrevented && w.ctxMenu === 1, '平时(电脑右键)的 contextmenu 不拦');
})();
await (async () => {
    // 修订(p4 复审 F7):安卓 Chrome 的系统长按是 400ms,contextmenu 比我们的 450ms 先到 —— 按着还没到点也要拦,并就此开始 2 倍速
    const w = await mkGestureWorld();
    touch(w, 'touchstart', w.video, [P(200, 200)]);
    await w.clock.advance(400);
    const cm = new Ev('contextmenu', { bubbles: true, cancelable: true });
    w.video.dispatchEvent(cm);
    ok(cm.defaultPrevented && w.ctxMenu === 0, '长按 400ms 时安卓先发的 contextmenu:拦下(DPlayer 菜单不弹)');
    await w.clock.advance(5);
    ok(w.video.playbackRate === 2 && w.px.status().lp && w.cont.classList.contains('dgx-lp'), '系统已认定长按:就此开始 2 倍速(不等 450ms)');
    await w.clock.advance(100);
    ok(w.px.status().n.lp === 1, '450ms 的计时不会再开一次');
    touch(w, 'touchend', w.video, [P(200, 200)]);
    await w.clock.advance(5);
    ok(w.video.playbackRate === 1.25 && !w.px.status().lp && w.ls.getItem('dplayer_speed') === '1.25', '松手:恢复原来的倍速');
    // 视频暂停着(本来就不会长按倍速)/ 手指已经挪开:contextmenu 照旧给 DPlayer
    const wp = await mkGestureWorld();
    wp.video.paused = true;
    touch(wp, 'touchstart', wp.video, [P(200, 200)]);
    await wp.clock.advance(400);
    const cmp = new Ev('contextmenu', { bubbles: true, cancelable: true });
    wp.video.dispatchEvent(cmp);
    ok(!cmp.defaultPrevented && wp.ctxMenu === 1 && wp.px.status().n.lp === 0, '暂停着按住:contextmenu 不拦(没有要接管的长按)');
    const wm = await mkGestureWorld();
    touch(wm, 'touchstart', wm.video, [P(200, 200)]);
    await wm.clock.advance(100);
    touch(wm, 'touchmove', wm.video, [P(200, 214)]);
    await wm.clock.advance(300);
    const cmm = new Ev('contextmenu', { bubbles: true, cancelable: true });
    wm.video.dispatchEvent(cmm);
    ok(!cmm.defaultPrevented && wm.px.status().n.lp === 0, '手指挪开了(不算长按):contextmenu 不拦');
})();
await (async () => {
    // 双击左右:index.html 真跳了才出波纹,连点累加;中间双击 / 单击照旧
    const w = await mkGestureWorld();
    const V = w.video;
    const tapAt = async (x) => { touch(w, 'touchstart', V, [P(x, 200)]); await w.clock.advance(40); touch(w, 'touchend', V, [P(x, 200)]); await w.clock.advance(2); };
    await tapAt(40);
    ok(V.currentTime === 100 && !w.cont.querySelector('.dgx-rip.on'), '左侧单击:不跳、不出波纹');
    await w.clock.advance(100);
    await tapAt(40);
    const rip = w.cont.querySelector('.dgx-rip.l');
    ok(V.currentTime === 90 && rip && rip.classList.contains('on') && rip.textContent.includes('−10s'), '左侧双击:index.html 快退 10 秒 → 波纹「−10s」', { t: V.currentTime, txt: rip && rip.textContent });
    await w.clock.advance(80);
    await tapAt(40);
    ok(V.currentTime === 80 && rip.textContent.includes('−20s'), '接着点:累加「−20s」', rip.textContent);
    await w.clock.advance(700);
    ok(!rip.classList.contains('on'), '波纹 0.65 秒后收起');
    await w.clock.advance(1000);
    await tapAt(380); await w.clock.advance(100); await tapAt(380);
    const ripR = w.cont.querySelector('.dgx-rip.r');
    ok(V.currentTime === 90 && ripR && ripR.classList.contains('on') && ripR.textContent.includes('+10s') && !rip.classList.contains('on'), '右侧双击:「+10s」(重新计数)');
    await w.clock.advance(1000);
    const tg = w.dp.toggles;
    await tapAt(200); await w.clock.advance(100); await tapAt(200);
    ok(w.dp.toggles === tg + 1 && V.currentTime === 90 && w.px.status().n.rip === 3, '中间双击:index.html 照旧切播放 / 暂停,不出波纹');
    await w.clock.advance(1000);
    const was = w.cont.classList.contains('dplayer-hide-controller');
    await tapAt(200);
    await w.clock.advance(350);
    ok(w.cont.classList.contains('dplayer-hide-controller') !== was, '单击:index.html 照旧开关控制栏');
    ok(Core.CSS.includes('.dgx-on .dplayer-seek-hint{display:none!important}') && w.cont.classList.contains('dgx-on'), '旧的「-10秒」提示框藏掉(触屏设备容器带 dgx-on)');
    // currentTime 不可用(换源中):index.html 不跳,也不出波纹
    await w.clock.advance(1000);
    V._ct = NaN;
    const n0 = w.px.status().n.rip;
    await tapAt(40); await w.clock.advance(100); await tapAt(40);
    ok(w.px.status().n.rip === n0, '换源中 currentTime=NaN:不出波纹');
})();
await (async () => {
    // 横滑定位 + 缩略图
    const w = await mkGestureWorld();
    const V = w.video;
    const s0 = touch(w, 'touchstart', V, [P(200, 200)]);
    const m1 = touch(w, 'touchmove', V, [P(215, 202)]);
    ok(!m1.defaultPrevented && !w.px.status().scrub, '横滑:15px 还没接管');
    const m2 = touch(w, 'touchmove', V, [P(230, 203)]);
    ok(m2.defaultPrevented && w.px.status().scrub && w.cont.classList.contains('dgx-scrubbing'), '横滑 ≥24px 且 |dx|>2|dy|:接管(preventDefault)');
    const m3 = touch(w, 'touchmove', V, [P(324, 210)]);   // dx = 124 → +62.5s → 162.5
    const box = w.cont.querySelector('.dgx-scrub');
    ok(box && box.classList.contains('on') && box.textContent.includes('02:42 / 16:40') && box.textContent.includes('+1:03') && m3.defaultPrevented, '横滑:中间显示目标时间 / 时长和差值', box && box.textContent);
    ok(w.sp._S.ptr && near(w.sp._S.ptr.t, 162.5, 0.01) && !w.sp._S.ptr.drag && w.dp.autoHide >= 1 && !w.cont.classList.contains('dplayer-hide-controller'), '横滑:dgSeekPreview 收到这个位置的合成悬停(缩略图),控制栏亮着', w.sp._S.ptr && w.sp._S.ptr.t);
    ok(w.video.currentTime === 100 && w.dp.seeks.length === 0, '横滑:松手之前不 seek');
    const te = touch(w, 'touchend', V, [P(324, 210)]);
    await w.clock.advance(5);
    ok(w.dp.seeks.length === 1 && near(w.dp.seeks[0], 162.5) && near(V.currentTime, 162.5), '松手:dp.seek 到目标(162.5)', w.dp.seeks);
    ok(te.defaultPrevented && w.bubbleTE === 0 && !box.classList.contains('on') && w.sp._S.ptr === null && !w.cont.classList.contains('dgx-scrubbing'), '松手:touchend 截停、浮层收起、缩略图收起(pointerleave)');
    await w.clock.advance(400);
    ok(w.overlay === 0 && !w.cont.classList.contains('dplayer-hide-controller'), '松手之后 index.html 不把它当单击');
    // 回到起点 = 取消
    touch(w, 'touchstart', V, [P(200, 200)]);
    touch(w, 'touchmove', V, [P(260, 200)]);
    ok(w.sp._S.ptr && w.sp._S.ptr.t > 162.5, '取消:先拖出去');
    touch(w, 'touchmove', V, [P(210, 201)]);
    ok(box.classList.contains('on') && box.classList.contains('cancel') && box.textContent.includes('松手取消') && w.sp._S.ptr === null, '取消:回到起点附近显示「松手取消」,缩略图收起');
    touch(w, 'touchend', V, [P(210, 201)]);
    await w.clock.advance(5);
    ok(w.dp.seeks.length === 1, '取消:松手不 seek');
    // 往左拖到头:夹在 0
    touch(w, 'touchstart', V, [P(370, 200)]);
    touch(w, 'touchmove', V, [P(300, 200)]);
    touch(w, 'touchmove', V, [P(-2000, 200)]);
    touch(w, 'touchend', V, [P(-2000, 200)]);
    await w.clock.advance(5);
    ok(w.dp.seeks.length === 2 && w.dp.seeks[1] === 0, '往左拖过头:夹在 0', w.dp.seeks);
    ok(w.px.status().n.scrubSeek === 2 && errors.length === 0, '计数 / 不抛', errors.map(String));
})();
await (async () => {
    // 不接管的横滑 / 竖滑
    const cases = [
        ['竖滑', (w) => { touch(w, 'touchstart', w.video, [P(200, 150)]); return [touch(w, 'touchmove', w.video, [P(205, 170)]), touch(w, 'touchmove', w.video, [P(210, 230)])]; }],
        ['斜着(|dx| ≤ 2|dy|)', (w) => { touch(w, 'touchstart', w.video, [P(200, 150)]); return [touch(w, 'touchmove', w.video, [P(240, 172)])]; }],
        ['从屏幕左边缘起手', (w) => { touch(w, 'touchstart', w.video, [P(8, 150)]); return [touch(w, 'touchmove', w.video, [P(60, 152)])]; }],
        ['从屏幕右边缘起手', (w) => { touch(w, 'touchstart', w.video, [P(392, 150)]); return [touch(w, 'touchmove', w.video, [P(330, 152)])]; }],
        ['浏览器已在滚动(不可取消)', (w) => { touch(w, 'touchstart', w.video, [P(200, 150)]); return [touch(w, 'touchmove', w.video, [P(260, 152)], { cancelable: false })]; }],
        ['在进度条上起手', (w) => { touch(w, 'touchstart', w.dom.bar, [P(200, 293)]); return [touch(w, 'touchmove', w.dom.bar, [P(260, 293)])]; }],
        ['没时长', (w) => { w.video.duration = NaN; touch(w, 'touchstart', w.video, [P(200, 150)]); return [touch(w, 'touchmove', w.video, [P(260, 152)])]; }]
    ];
    for (const [why, run] of cases) {
        const w = await mkGestureWorld();
        const evs = run(w);
        const pt = evs[evs.length - 1].changedTouches[0];
        touch(w, 'touchend', w.video, [pt]);
        await w.clock.advance(5);
        ok(!w.px.status().scrub && w.dp.seeks.length === 0 && evs.every(e => !e.defaultPrevented || why === '竖滑') && w.px.status().n.scrub === 0, '横滑不接管:' + why);
    }
    const wl = await mkGestureWorld({ ctx: { isLive: true } });
    touch(wl, 'touchstart', wl.video, [P(200, 150)]);
    const ml = touch(wl, 'touchmove', wl.video, [P(260, 152)]);
    ok(!ml.defaultPrevented && wl.px.status().n.scrub === 0, '横滑不接管:直播');
})();
await (async () => {
    // 全屏:左侧横滑归我们(亮度手势自己放弃),左侧竖滑归 index.html 的亮度
    const w = await mkGestureWorld();
    w.cont.classList.add('dplayer-fulled');
    touch(w, 'touchstart', w.video, [P(60, 150)]);
    touch(w, 'touchmove', w.video, [P(70, 151)]);
    touch(w, 'touchmove', w.video, [P(90, 152)]);
    touch(w, 'touchmove', w.video, [P(180, 153)]);
    touch(w, 'touchend', w.video, [P(180, 153)]);
    await w.clock.advance(5);
    ok(w.dp.seeks.length === 1 && w.win._videoBrightness === undefined && !w.video.style.filter, '全屏左侧横滑:定位,亮度不动');
    touch(w, 'touchstart', w.video, [P(60, 150)]);
    const v1 = touch(w, 'touchmove', w.video, [P(61, 130)]);
    const v2 = touch(w, 'touchmove', w.video, [P(62, 80)]);
    touch(w, 'touchend', w.video, [P(62, 80)]);
    await w.clock.advance(5);
    ok(/brightness/.test(w.video.style.filter || '') && w.win._videoBrightness > 1 && w.dp.seeks.length === 1 && v2.defaultPrevented && w.px.status().n.lp === 0, '全屏左侧竖滑:index.html 的亮度照旧', { f: w.video.style.filter });
    void v1;
})();
await (async () => {
    // DPlayer 重建清空容器:浮层用的时候重建;换了容器(rebuild 换干净 #dplayer)监听装到新容器上
    const w = await mkGestureWorld();
    w.cont.children.filter(c => /dgx-/.test(c.className)).forEach(c => w.cont.removeChild(c));
    touch(w, 'touchstart', w.video, [P(200, 200)]);
    await w.clock.advance(500);
    ok(w.cont.querySelector('.dgx-badge.on') && w.video.playbackRate === 2, '浮层被清掉:用的时候重建');
    touch(w, 'touchend', w.video, [P(200, 200)]);
    await w.clock.advance(5);
    const w2 = mkWorld({ playing: true, t0: w.clock.now() });
    w2.video.clock = w.clock;
    const dp2 = Object.assign({}, w.dp, { container: w2.cont, video: w2.video, _h: {} });
    dp2.on = (n, f) => { (dp2._h[n] = dp2._h[n] || []).push(f); };
    w.px.onPlayerDestroy('rebuild');
    w.px.onPlayerReady(dp2, w2.video, CTX('c:G-001'));
    touch(w2, 'touchstart', w2.video, [P(200, 200)]);
    await w.clock.advance(500);
    ok(w2.video.playbackRate === 2 && w2.cont.classList.contains('dgx-on'), '换了容器:手势装到新容器上');
    touch(w2, 'touchend', w2.video, [P(200, 200)]);
    await w.clock.advance(5);
    ok(w2.video.playbackRate === 1, '新容器上松手恢复');
    touch(w, 'touchstart', w.video, [P(200, 200)]);
    await w.clock.advance(500);
    ok(w.video.playbackRate === 1.25, '旧容器上的触摸不再接管');
    touch(w, 'touchend', w.video, [P(200, 200)]);
    ok(w.cont.listenerCount('touchstart') === 3, '同一个容器只装一次(重复 onPlayerReady 不叠加)', w.cont.listenerCount('touchstart'));
})();

// ======================= ⑤ 键盘 =======================
console.log('⑤ 键盘');
await (async () => {
    const w = mkWorld({ playing: true, ct: 100 });
    w.mqs['(any-pointer: coarse)'] = false; w.mqs['(pointer: coarse)'] = false;
    const px = w.mkPx();
    px.onPlayerReady(w.dp, w.video, CTX('c:K-100'));
    const key = (k, o, target) => { const e = new Ev('keydown', Object.assign({ bubbles: true, cancelable: true, key: k }, o || {})); (target || w.doc.body).dispatchEvent(e); return e; };
    const e1 = key('j');
    ok(e1.defaultPrevented && w.dp.seeks[0] === 90 && w.dp.autoHide >= 1, 'J:后退 10 秒(dp.seek)', w.dp.seeks);
    await w.clock.advance(5);
    key('l'); await w.clock.advance(5);
    key('L'); await w.clock.advance(5);
    ok(w.dp.seeks[1] === 100 && w.dp.seeks[2] === 110, 'L / 大写锁定的 L:前进 10 秒', w.dp.seeks);
    w.video._ct = 4; key('j'); await w.clock.advance(5);
    w.video._ct = 995; key('l'); await w.clock.advance(5);
    ok(w.dp.seeks[3] === 0 && w.dp.seeks[4] === 1000, '夹在片头 / 片尾', w.dp.seeks);
    const e2 = key('J', { shiftKey: true });
    ok(!e2.defaultPrevented && w.dp.seeks.length === 5, 'Shift+J:不响应');
    w.video._rate = 1;
    const e3 = key('>', { shiftKey: true, code: 'Period' }); await w.clock.advance(5);
    key('.', { shiftKey: true, code: 'Period' }); await w.clock.advance(5);
    ok(e3.defaultPrevented && w.dp.speeds[0] === 1.25 && w.dp.speeds[1] === 1.5 && w.ls.getItem('dplayer_speed') === '1.5', 'Shift+>:加一档(倍速记忆由 index.html 照常写)', w.dp.speeds);
    key('<', { shiftKey: true, code: 'Comma' }); await w.clock.advance(5);
    ok(w.dp.speeds[2] === 1.25, 'Shift+<:减一档');
    w.video._rate = 3;
    const e4 = key('>', { shiftKey: true });
    ok(e4.defaultPrevented && w.dp.speeds.length === 3, '已经最快:不变(按键照样吃掉)');
    w.video._rate = 1;
    const n0 = w.dp.seeks.length + w.dp.speeds.length;
    const inp = new El('input'); w.doc.body.appendChild(inp);
    const ce = new El('div'); ce.setAttribute('contenteditable', ''); w.doc.body.appendChild(ce);
    const blocked = [
        ['输入框里', () => key('j', {}, inp)], ['可编辑区域', () => key('l', {}, ce)], ['Ctrl', () => key('j', { ctrlKey: true })], ['Meta', () => key('l', { metaKey: true })],
        ['Alt', () => key('>', { altKey: true, shiftKey: true })],
        ['已被别人处理', () => { const e = new Ev('keydown', { bubbles: true, cancelable: true, key: 'j' }); e.defaultPrevented = true; w.doc.body.dispatchEvent(e); return e; }],
        ['TV 模式', () => { w.vue.isTVMode = true; const e = key('j'); w.vue.isTVMode = false; return e; }],
        ['播放页没开', () => { w.vue.showDetail = false; const e = key('j'); w.vue.showDetail = true; return e; }],
        ['截帧分享弹窗开着', () => { w.vue.frameShare.show = true; const e = key('j'); w.vue.frameShare.show = false; return e; }],
        ['播放器不可见', () => { const r = w.cont.rect; w.cont.rect = { left: 0, top: 0, width: 0, height: 0 }; const e = key('l'); w.cont.rect = r; return e; }],
        ['页面在后台', () => { w.doc.hidden = true; const e = key('l'); w.doc.hidden = false; return e; }],
        ['锁屏中', () => { w.win.dgPrivacy = { locked: () => true, incognito: () => false }; const e = key('l'); w.win.dgPrivacy = null; return e; }],
        ['别的键', () => key('k')]
    ];
    for (const [why, run] of blocked) { const e = run(); ok(!e.defaultPrevented || why === '已被别人处理', '键盘不响应:' + why); }
    ok(w.dp.seeks.length + w.dp.speeds.length === n0, '以上都没动播放器');
    px.onPlayerReady(w.dp, w.video, CTX('c:K-100', { isLive: true }));
    const e5 = key('l');
    ok(!e5.defaultPrevented && w.dp.seeks.length + w.dp.speeds.length === n0, '直播:不响应');
    px.onPlayerDestroy('close');
    ok(!key('l').defaultPrevented, '关了播放页:不响应');
    // DPlayer 自带热键只有 空格 / 方向键 / Esc,index.html 也没有 J / L / > / <
    const hk = /t\.options\.hotkey&&document\.addEventListener\("keydown",\(function\(e\)\{[\s\S]*?\}\}\}\)\)/.exec(DPLAYER);
    const codes = hk ? (hk[0].match(/case (\d+)/g) || []).map(s => +s.slice(5)) : [];
    ok(hk && codes.length >= 5 && codes.every(c => [32, 37, 38, 39, 40, 27].includes(c)), 'DPlayer 热键只有 空格 / ←↑→↓(没有 J / L / > / <)', codes);
    ok(!/e\.key\s*===\s*'[jJlL<>]'|e\.code\s*===\s*'Key[JL]'|keyCode\s*===\s*(74|76|188|190)\b/.test(HTML), 'index.html 本来没有 J / L / > / < 快捷键(不重复)');
})();

// ======================= ⑥ 起播提速:悬停预取 =======================
console.log('⑥ 起播提速');
const WORK = (wk, host, extra) => Object.assign({ name: '合成作品 ' + wk, pic: '', _wk: wk, _meta: { code: 'ABC-001' }, sources: [
    { site_key: 'av_s01', site_name: '站一', vod_id: 11, vod_name: '合成标题', vod_play_url: '', type_name: '' },
    { site_key: 'av_s02', site_name: '站二', vod_id: 12, vod_name: '合成标题', vod_play_url: '正片$https://' + (host || 'cdn-a.example.com') + '/v/index.m3u8', type_name: '' }
] }, extra || {});
function cardEl(w, wk) { const el = new El('div'); el.className = 'hot-card'; el.setAttribute('data-wk', wk); w.doc.body.appendChild(el); return el; }
const hov = (px, wk, el, type) => px.onCardHover({ wk, _wk: wk }, el, type === 'touch' ? new Ev('touchstart', { touches: [P(10, 10)] }) : new Ev('pointerover', { pointerType: 'mouse' }));
await (async () => {
    const w = mkWorld({ vue: { corsProxyUrl: 'https://cors.example.net/' } });
    const px = w.mkPx();
    const el = cardEl(w, 'c:ABC-001');
    hov(px, 'c:ABC-001', el, 'mouse');
    await w.clock.advance(100);
    el.dispatchEvent(new Ev('mouseleave'));
    await w.clock.advance(500);
    ok(w.fetch.calls.length === 0, '悬停不到 150ms 就离开:不预取');
    hov(px, 'c:ABC-001', el, 'mouse');
    hov(px, 'c:ABC-001', el, 'mouse');   // 重复调用(两条接线)
    await w.clock.advance(149);
    ok(w.fetch.calls.length === 0, '悬停 149ms:还没预取');
    await w.clock.advance(2);
    ok(w.fetch.calls.length === 1 && w.fetch.calls[0].url === '/api/catalog/work?k=c%3AABC-001' && w.fetch.calls[0].opts.credentials === 'same-origin' && w.fetch.calls[0].opts.signal, '悬停 150ms:预取一次 /api/catalog/work?k=(与 openWork 同一个地址)', w.fetch.calls.map(c => c.url));
    w.fetch.calls[0].resp(200, WORK('c:ABC-001'));
    await w.clock.advance(1);
    const links = w.doc.head.querySelectorAll('link');
    ok(links.length === 2 && links[0].getAttribute('href') === 'https://cors.example.net' && links[1].getAttribute('href') === 'https://cdn-a.example.com'
        && links.every(l => l.getAttribute('rel') === 'preconnect' && l.getAttribute('crossorigin') === 'anonymous'), 'preconnect:CORS 代理 + 第一条有地址的线路的源站(带 crossorigin)', links.map(l => l.getAttribute('href')));
    const p1 = px.prefetched('c:ABC-001'), p2 = px.prefetched('c:ABC-001');
    const [d1, d2] = await Promise.all([p1, p2]);
    d1.name = 'mutated';
    ok(d1 && d2 && d2.name === '合成作品 c:ABC-001' && d1 !== d2 && d2.sources.length === 2, 'prefetched(wk):每次给一份新的作品 JSON');
    ok(px.prefetched('c:NOPE-1') === null && px.prefetched('evil') === null && px.prefetched(null) === null, 'prefetched:没预取过 / 不合法 → null');
    el.dispatchEvent(new Ev('mouseleave'));
    ok(px.prefetched('c:ABC-001') !== null, '已完成的离开不丢');
    await w.clock.advance(60001);
    ok(px.prefetched('c:ABC-001') === null, '60 秒后作废');
    ok(w.fetch.calls.every(c => /^\/api\/catalog\/work\?k=/.test(c.url)), '只请求作品接口(绝不拉 m3u8 / 分片)');
    // 复核:停留不到 150ms 就按下去(点得快)→ 按下那一刻就预取,点击(openWork)认领它;计时器不再到点又拉一遍
    const fc = cardEl(w, 'c:FAST-1');
    const n0 = w.fetch.calls.length;
    hov(px, 'c:FAST-1', fc, 'mouse');
    await w.clock.advance(60);
    fc.dispatchEvent(new Ev('pointerdown', { pointerType: 'mouse' }));
    ok(w.fetch.calls.length === n0 + 1 && w.fetch.calls[n0].url.endsWith('c%3AFAST-1'), '快点击:按下(<150ms)立刻预取', w.fetch.calls.slice(n0).map(c => c.url));
    const fcl = px.prefetched('c:FAST-1');
    await w.clock.advance(500);
    ok(fcl !== null && w.fetch.calls.length === n0 + 1, '快点击:openWork 认领这一份;150ms 计时器不再多拉一遍', w.fetch.calls.slice(n0).map(c => c.url));
    w.fetch.calls[n0].resp(200, WORK('c:FAST-1'));
    const fgot = await fcl;
    ok(fgot && fgot._wk === 'c:FAST-1' && px.status().prefetch.some(x => x.wk === 'c:FAST-1' && x.claimed), '快点击:认领的拿到结果', px.status().prefetch);
})();
await (async () => {
    // 离开中止(未领取)/ 领取后离开不中止 / 触屏立刻 / 滚动中止 / 抬手留着
    const w = mkWorld();
    const px = w.mkPx();
    const a = cardEl(w, 'c:A-1'), b = cardEl(w, 'c:B-1');
    hov(px, 'c:A-1', a, 'mouse');
    await w.clock.advance(200);
    a.dispatchEvent(new Ev('pointerleave'));
    ok(w.fetch.calls[0].aborted && px.prefetched('c:A-1') === null, '离开卡片(还没回、没人要):中止');
    hov(px, 'c:B-1', b, 'mouse');
    await w.clock.advance(200);
    const claim = px.prefetched('c:B-1');
    b.dispatchEvent(new Ev('mouseleave'));
    ok(!w.fetch.calls[1].aborted, '点开了(prefetched 领取)再离开:不中止');
    w.fetch.calls[1].resp(200, WORK('c:B-1'));
    const got = await claim;
    ok(got && got._wk === 'c:B-1', '领取的 Promise 拿到结果');
    const t = cardEl(w, 'c:T-1');
    hov(px, 'c:T-1', t, 'touch');
    ok(w.fetch.calls.length === 3 && w.fetch.calls[2].url.endsWith('c%3AT-1'), '触屏按下:立刻预取');
    t.dispatchEvent(new Ev('touchmove', { touches: [P(10, 40)] }));
    ok(w.fetch.calls[2].aborted, '手指滑动(在滚列表):中止');
    const t2 = cardEl(w, 'c:T-2');
    hov(px, 'c:T-2', t2, 'touch');
    t2.dispatchEvent(new Ev('touchmove', { touches: [P(12, 14)] }));
    t2.dispatchEvent(new Ev('touchend', {}));
    ok(!w.fetch.calls[3].aborted, '小抖动 + 抬手:留着(马上就是 click)');
    // 触屏上紧跟的兼容 mouseenter 不再发第二次
    hov(px, 'c:T-2', t2, 'mouse');
    await w.clock.advance(200);
    ok(w.fetch.calls.length === 4, '同一部再次悬停:复用,不重复请求');
})();
await (async () => {
    // 不预取的情况
    const cases = [
        ['主视频在播', (w, px) => { w.video.paused = false; px.onPlayerReady(w.dp, w.video, CTX('c:M-1')); }],
        ['页面上有没静音的视频在播', (w) => { const v = new Video(w.clock); v.paused = false; v.muted = false; w.doc.body.appendChild(v); }],
        ['页面在后台', (w) => { w.doc.hidden = true; }],
        ['省流量', (w) => { w.nav.connection = { saveData: true }; }],
        ['断网', (w) => { w.nav.onLine = false; }],
        ['年龄门还没过', (w) => { w.win.DgAdult.ageGate.accepted = () => false; }],
        ['后台在剪插播(mainBusy)', (w) => { w.win.DgAdult.mainBusy = () => true; }]
    ];
    for (const [why, setup] of cases) {
        const w = mkWorld();
        const px = w.mkPx();
        setup(w, px);
        const n0 = w.fetch.calls.length;
        hov(px, 'c:N-1', cardEl(w, 'c:N-1'), 'mouse');
        hov(px, 'c:N-2', cardEl(w, 'c:N-2'), 'touch');
        await w.clock.advance(300);
        ok(w.fetch.calls.filter(c => /catalog\/work/.test(c.url)).length === 0 && w.fetch.calls.length === n0, '不预取:' + why);
    }
    const w = mkWorld();
    const px = w.mkPx();
    const pv = new Video(w.clock); pv.paused = false; pv.muted = true; w.doc.body.appendChild(pv);
    hov(px, 'c:N-3', cardEl(w, 'c:N-3'), 'touch');
    ok(w.fetch.calls.length === 1, '静音的封面预览在播:照常预取(只是几 KB 的 JSON)');
})();
await (async () => {
    // 同时最多 3 个在路上;LRU 20;preconnect 最多 4 个、同源不加、10 秒内不重复加
    const w = mkWorld();
    const px = w.mkPx();
    for (let i = 0; i < 5; i++) { hov(px, 'c:Q-' + i, cardEl(w, 'c:Q-' + i), 'touch'); }
    const live = w.fetch.calls.filter(c => !c.aborted);
    ok(w.fetch.calls.length === 5 && live.length === 3 && w.fetch.calls[0].aborted && w.fetch.calls[1].aborted, '同时最多 3 个在路上(最早的先中止)', w.fetch.calls.map(c => c.aborted));
    const w2 = mkWorld();
    const p2 = w2.mkPx();
    w2.fetch.auto = (c) => { const k = decodeURIComponent(c.url.split('k=')[1]); const n = +k.split('-')[1]; c.resp(200, WORK(k, n === 7 ? 'site.test' : 'h' + (n % 6) + '.example.com')); };
    for (let i = 0; i < 25; i++) { hov(p2, 'c:L-' + i, cardEl(w2, 'c:L-' + i), 'touch'); await w2.clock.advance(1); }
    ok(p2._S.pf.size === 20 && p2.prefetched('c:L-0') === null && p2.prefetched('c:L-24') !== null, 'LRU:最多留 20 部');
    const links = w2.doc.head.querySelectorAll('link[data-dgx]');
    ok(links.length === 4 && links.every(l => l.getAttribute('href') !== 'https://site.test') && new Set(links.map(l => l.getAttribute('href'))).size === 4, 'preconnect:最多 4 个、同源不加、不重复', links.map(l => l.getAttribute('href')));
    const n = p2.status().n.pc;
    hov(p2, 'c:L-24', cardEl(w2, 'c:L-24b'), 'touch');
    await w2.clock.advance(5);
    ok(p2.status().n.pc === n, 'preconnect:10 秒内同一源站不重复加');
})();
await (async () => {
    // 【真】adult.js 的 fetchWork 用预取结果(不再请求);预取失败 → 照常请求
    const store = new Map();
    globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const A = require(path.join(ROOT, 'public/adult/adult.js'));
    ok(typeof A.fetchWork === 'function' && typeof A.workUrl === 'function' && A.workUrl('c:ABC-001', false) === '/api/catalog/work?k=c%3AABC-001', 'adult.js 的作品地址与预取同一个');
    const w = mkWorld({ DgAdult: { workUrl: A.workUrl } });
    const px = w.mkPx();
    const realFetch = globalThis.fetch;
    const nodeCalls = [];
    globalThis.fetch = (u, o) => { nodeCalls.push(String(u)); return Promise.resolve(mkResp(200, WORK('c:ABC-009'))); };
    globalThis.dgAdultPlayer = px;
    try {
        hov(px, 'c:ABC-009', cardEl(w, 'c:ABC-009'), 'touch');
        const gP = A.fetchWork('c:ABC-009', false);
        w.fetch.calls[0].resp(200, WORK('c:ABC-009'));
        const g = await gP;
        ok(g && g._wk === 'c:ABC-009' && g.sources.length === 2 && nodeCalls.length === 0, 'openWork 的 fetchWork:直接用预取(没有第二次请求)', { n: nodeCalls.length, g: g && g._wk });
        hov(px, 'c:ABC-010', cardEl(w, 'c:ABC-010'), 'touch');
        const gP2 = A.fetchWork('c:ABC-010', false);
        w.fetch.calls[1].resp(500, { error: 1 });
        const g2 = await gP2;
        ok(nodeCalls.length === 1 && /c%3AABC-010/.test(nodeCalls[0]) && g2 && g2.sources.length === 2, '预取失败:照常请求一次');
        const g3 = await A.fetchWork('c:ABC-011', false);
        ok(nodeCalls.length === 2 && g3, '没预取过:照常请求');
    } finally { globalThis.fetch = realFetch; delete globalThis.dgAdultPlayer; }
})();
await (async () => {
    // 起播时间估算:点开 → 拿到作品 JSON(openWork 第一步,之后才开播放页测速)。服务器查一次 ~2ms,主要是往返
    const rows = [];
    for (const rtt of [60, 150, 300]) {
        const res = {};
        for (const mode of ['none', 'desktop', 'touch']) {
            const w = mkWorld();
            const px = w.mkPx();
            w.fetch.auto = (c) => { w.clock.setTimeout(() => c.resp(200, WORK('c:E-1')), rtt); };
            const el = cardEl(w, 'c:E-1');
            if (mode === 'desktop') { hov(px, 'c:E-1', el, 'mouse'); await w.clock.advance(400); }      // 鼠标移上去 → 400ms 后点
            if (mode === 'touch') { hov(px, 'c:E-1', el, 'touch'); await w.clock.advance(120); }        // 手指按下 → 120ms 后 click
            const t0 = w.clock.now();
            let tReady = -1;
            const pre = px.prefetched('c:E-1');
            Promise.resolve(pre ? pre.then(d => d || null) : null).then(d => d || w.fetch('/api/catalog/work?k=c%3AE-1').then(r => r.json())).then(() => { tReady = w.clock.now(); });
            await w.clock.advance(rtt + 50);
            res[mode] = tReady - t0;
        }
        rows.push({ rtt, ...res });
    }
    ok(rows.every(r => r.none === r.rtt && r.desktop === Math.max(0, r.rtt - 250) && r.touch === Math.max(0, r.rtt - 120)), '估算:不预取 = 1 个往返;电脑 = 往返 − (悬停到点击 400ms − 150ms 停留);手机 = 往返 − 按下到点击的 120ms', rows);
    console.log('    点开 → 作品 JSON(ms,模型):' + rows.map(r => `往返 ${r.rtt}: 原来 ${r.none} / 悬停 ${r.desktop} / 手机 ${r.touch}`).join(';'));
    const conn = [40, 120, 250].map(r => ({ rtt: r, cold: 4 * r, warm: r }));
    console.log('    第一条线路的 m3u8(测速 / 起播第一个请求,TLS1.3 估算):' + conn.map(c => `往返 ${c.rtt}: 冷连 ${c.cold} → 预连 ${c.warm}(省 ${c.cold - c.warm})`).join(';'));
})();

// ======================= ⑦ 钩子 / 引导 / 静态 =======================
console.log('⑦ 钩子 / 引导 / 静态');
await (async () => {
    const store = new Map();
    globalThis.localStorage = globalThis.localStorage || { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const A = require(path.join(ROOT, 'public/adult/adult.js'));
    const H = A.hooks;
    ok(H && typeof H.add === 'function' && typeof H.count === 'function', 'adult.js 导出 dgAdultHooks(add / count)');
    const before = ['onPlayerReady', 'onPlayerDestroy', 'onCardHover'].map(n => H.count(n));
    const w = mkWorld({ playing: true });
    w.win.dgAdultHooks = H;
    const px = w.mkPx();
    ok(px._register() === true && px._register() === true, '_register:找到 dgAdultHooks');
    const after = ['onPlayerReady', 'onPlayerDestroy', 'onCardHover'].map(n => H.count(n));
    ok(after.every((n, i) => n === before[i] + 1) && H.count('onHistoryWrite') === 0, '按契约名各注册一次(重复注册不叠加;不碰 onHistoryWrite)', { before, after });
    A.hook('onPlayerReady', w.dp, w.video, CTX('c:H-1'));
    A.hook('onPlayerReady', w.dp, w.video, CTX('c:H-1'));
    ok(px.status().bound && px.status().wk === 'c:H-1' && w.video.listenerCount('timeupdate') === 1, 'dgAdultHooks.onPlayerReady → 接上(调两次也只绑一次)');
    A.hook('onPlayerDestroy', 'close');
    ok(!px.status().bound, 'dgAdultHooks.onPlayerDestroy → 拆掉');
    // 清掉,别影响别的测试
    ['onPlayerReady', 'onPlayerDestroy', 'onCardHover'].forEach(n => { A._hooks.remove(n, px[n]); });
    ok(['onPlayerReady', 'onPlayerDestroy', 'onCardHover'].every((n, i) => H.count(n) === before[i]), '注销干净');
    // 普通对象:包一层,原来的照调
    const w2 = mkWorld({ playing: true });
    let calls = 0;
    w2.win.dgAdultHooks = { onPlayerReady() { calls++; } };
    const px2 = w2.mkPx();
    px2._register();
    w2.win.dgAdultHooks.onPlayerReady(w2.dp, w2.video, CTX('c:H-2'));
    ok(calls === 1 && px2.status().wk === 'c:H-2' && typeof w2.win.dgAdultHooks.onCardHover === 'function', '普通对象:包一层(原来的照调,缺的补上)');
    // 没有 dgAdultHooks:稍后再找
    const w3 = mkWorld();
    const px3 = w3.mkPx();
    ok(px3._register() === false, '还没有 dgAdultHooks:返回 false');
    w3.win.dgAdultHooks = { };
    await w3.clock.advance(1600);
    ok(typeof w3.win.dgAdultHooks.onPlayerReady === 'function', '稍后出现:补注册');
    // 浏览器引导:有 document 时自动建 window.dgAdultPlayer,并挂上 dgAdultHooks;入口给垃圾参数不抛
    const w4 = mkWorld();
    const ctx = { console, document: w4.doc, localStorage: w4.ls, navigator: w4.nav, setTimeout: w4.clock.setTimeout, clearTimeout: w4.clock.clearTimeout, addEventListener() { } };
    ctx.window = ctx;
    ctx.dgAdultHooks = { };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx, { filename: 'player-x.js' });
    const g = ctx.dgAdultPlayer;
    ok(g && typeof g.onPlayerReady === 'function' && typeof g.prefetched === 'function' && typeof ctx.dgAdultHooks.onPlayerReady === 'function', '浏览器引导:window.dgAdultPlayer + 挂上 dgAdultHooks');
    let threw = false;
    try {
        g.onPlayerReady(); g.onPlayerReady(null, null, null); g.onPlayerReady({}, {}, 5); g.onPlayerDestroy(); g.onPlayerDestroy('x');
        g.onCardHover(); g.onCardHover(null, null, null); g.onCardHover({ wk: 5 }, 7, 'x'); g.prefetched(); g.prefetched({}); g.status();
    } catch (e) { threw = e; }
    ok(!threw, '入口给垃圾参数不抛', String(threw));
})();
{
    let syntax = true;
    try { new vm.Script(SRC); } catch (e) { syntax = e.message; }
    ok(syntax === true, 'player-x.js 语法', syntax);
    ok(!/plugins\.hls|_dpSwitchHls|_proxyRetrying|_playToken|dgSeekPreview\./.test(SRC.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), '不碰播放通道(hls 插件 / _dpSwitchHls / 吞错闸门 / 播放令牌),缩略图只靠派发指针事件驱动');
    ok(!/\bvue(App)?\.[\w$]+\s*=[^=]/.test(SRC) && !/\$set|\$forceUpdate/.test(SRC), '从不写 Vue 状态');
    const fetches = (SRC.match(/fetchFn\(([^,]+),/g) || []).map(s => s.slice(8, -1).trim());
    ok(fetches.length === 3 && fetches.every(a => /HEAT_URL|HEAT_POST|workUrlOf/.test(a)), '只请求三个地址:热度 GET / 热度 POST / 作品', fetches);
    ok(/<script[^>]+src="adult\/player-x\.js\?v=\d+"[^>]*\bdefer\b/.test(HTML), 'index.html 用 <script defer> 加载 adult/player-x.js?v=');
    ok(/addEventListener\('pointermove', onWrapMove/.test(SP_SRC) && /e\.pointerType !== 'touch'/.test(SP_SRC) && /addEventListener\('pointerleave', onWrapLeave/.test(SP_SRC), 'seek-preview.js 仍把非 touch 的 pointermove 当悬停、pointerleave 收起(横滑缩略图的前提)');
    ok(/dp\.video\.addEventListener\('ratechange'[\s\S]{0,200}localStorage\.setItem\('dplayer_speed', speed\)/.test(HTML), 'index.html 的 ratechange 仍会记倍速(长按要把它写回去的原因)');
    ok(errors.length === 0, '整个过程没有监听器抛错', errors.slice(0, 5).map(e => String(e && e.stack || e)));
    // 浏览器实测回归:DPlayer 自带 ".dplayer svg{width:100%;height:100%}"(特异性 0,1,1),只写 .dgx-heat(0,1,0)时
    //   桌面端热度曲线被压成进度条的 3px 高 —— 定高的那条规则必须带 ".dplayer svg.dgx-heat"(0,2,1)
    const DP_CSS = fs.readFileSync(path.join(ROOT, 'public/libs/js/DPlayer.min.js'), 'utf8');
    const heatRule = (SRC.match(/'([^']*\.dgx-heat[^']*\{[^']*height:20px[^']*)'/) || [])[1] || '';
    ok(/\.dplayer svg ?\{[^}]*height: ?100%/.test(DP_CSS) &&/\.dplayer svg\.dgx-heat[,{]/.test(heatRule),
        '热度条定高规则压得过 DPlayer 的 .dplayer svg{height:100%}(桌面端曲线不被压成 3px)', heatRule.slice(0, 80));
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
