#!/usr/bin/env node
// [adult] 本机隐私 + 后台页回归(离线、零网络):node scripts/adult-privacy-test.mjs
//  ① 老板键:` / 连按两次 Esc / F9;盖上时所有媒体暂停 + 静音、恢复时照原状态(盖着期间 app 又要播 / 取消静音也照意图恢复);
//     搜索框里打 ` 照常输入;设了 PIN 老板键不会直接解开(老板 ↔ 锁屏);Esc 不关锁屏;盖着时键盘到不了 app;Tab 只在锁屏里转
//  ② 无痕:onHistoryWrite 否决(FE-BROWSE 的 add/call 钩子 + 没有 adult.js 时的普通对象)、列出的本机键不写、统计 / 反馈 / 热度 / 历史推送不发、
//     adult.js 线路反馈被挡、角落小标;关掉后照常
//  ③ PIN:PBKDF2 记录格式、对 / 错、连错 5 次 30s 再翻倍(假时钟)、闲置锁(正在播放不算)、后台 ≥1 分钟回来锁、打开即锁、没有 WebCrypto 时不可用
//  ④ 标签页伪装:标题 / 图标换掉,app 改 document.title / 图标后被盖回去,关掉恢复 app 最后设的标题;源码里没有 setInterval(不轮询)
//  ⑤ 一键清除:只删列出的键、会话清空、图片缓存 / 接口缓存删掉(外壳留)、云端历史(带令牌)、离线下载要二次确认;忘记 PIN = 全部重置
//  ⑥ 设置面板:纯 DOM 渲染、开关 / 下拉 / 设 PIN 表单
//  ⑦ admin.js:服务器字符串全部 textContent(注入 <img onerror> / <script> 不会变成元素,innerHTML 一次都没用)、401 / 429 / 404 关闭、
//     令牌只进 sessionStorage、屏蔽词校验、各接口的请求体
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIV_SRC = fs.readFileSync(path.join(ROOT, 'public/adult/privacy.js'), 'utf8');
const ADMIN_SRC = fs.readFileSync(path.join(ROOT, 'public/adult/admin.js'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public/adult/admin.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ================= 桩 DOM =================
const MUT = [];   // [{ mo, target, opts }]
class Ev {
    constructor(type, init = {}) {
        this.type = type; this.bubbles = !!init.bubbles; this.cancelable = init.cancelable !== false;
        Object.assign(this, init);
        this.defaultPrevented = false; this._stop = false; this._imm = false; this.target = null; this.currentTarget = null;
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this._stop = true; }
    stopImmediatePropagation() { this._stop = true; this._imm = true; }
}
class Target {
    constructor() { this._ls = []; }
    addEventListener(type, fn, opt) { const capture = opt === true || !!(opt && opt.capture); if (!this._ls.some(l => l.type === type && l.fn === fn && l.capture === capture)) this._ls.push({ type, fn, capture, once: !!(opt && opt.once) }); }
    removeEventListener(type, fn, opt) { const capture = opt === true || !!(opt && opt.capture); this._ls = this._ls.filter(l => !(l.type === type && l.fn === fn && l.capture === capture)); }
    _fire(ev, phase) {
        for (const l of this._ls.slice()) {
            if (l.type !== ev.type) continue;
            if (phase === 'capture' && !l.capture) continue;
            if (phase === 'bubble' && l.capture) continue;
            if (l.once) this.removeEventListener(l.type, l.fn, l.capture);
            ev.currentTarget = this;
            l.fn.call(this, ev);
            if (ev._imm) return;
        }
    }
}
function dispatch(win, target, ev) {
    ev.target = target;
    const chain = [];
    for (let n = target.parentNode; n; n = n.parentNode) chain.unshift(n);
    const path = [win, ...chain];
    for (const n of path) { n._fire(ev, 'capture'); if (ev._stop) return !ev.defaultPrevented; }
    target._fire(ev, 'target');
    if (ev._stop) return !ev.defaultPrevented;
    if (ev.bubbles) for (const n of path.slice().reverse()) { n._fire(ev, 'bubble'); if (ev._stop) break; }
    return !ev.defaultPrevented;
}
function notify(node, type, attr) {
    for (const r of MUT) {
        const { mo, target, opts } = r;
        if (!(target === node || (opts.subtree && target.contains(node)))) continue;
        if (type === 'childList' && !opts.childList) continue;
        if (type === 'characterData' && !opts.characterData) continue;
        if (type === 'attributes' && (!opts.attributes || (opts.attributeFilter && opts.attributeFilter.indexOf(attr) < 0))) continue;
        mo._q.push({ type, target: node, attributeName: attr || null });
        if (!mo._sched) { mo._sched = true; queueMicrotask(() => { mo._sched = false; const q = mo._q; mo._q = []; if (q.length && MUT.some(x => x.mo === mo)) mo._cb(q, mo); }); }
    }
}
class MO { constructor(cb) { this._cb = cb; this._q = []; } observe(target, opts) { MUT.push({ mo: this, target, opts: opts || {} }); } disconnect() { for (let i = MUT.length - 1; i >= 0; i--) if (MUT[i].mo === this) MUT.splice(i, 1); this._q = []; } takeRecords() { const q = this._q; this._q = []; return q; } }

class Node extends Target {
    constructor(doc) { super(); this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); notify(this, 'childList'); return c; }
    insertBefore(c, ref) { if (!ref) return this.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); const i = this.childNodes.indexOf(ref); c.parentNode = this; this.childNodes.splice(i, 0, c); notify(this, 'childList'); return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i < 0) throw new Error('NotFoundError'); this.childNodes.splice(i, 1); c.parentNode = null; notify(this, 'childList'); return c; }
    replaceChild(n, o) { this.insertBefore(n, o); return this.removeChild(o); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return x === this.ownerDocument || x === this; }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; const s = String(v == null ? '' : v); if (s) { const t = new Text(this.ownerDocument, s); t.parentNode = this; this.childNodes.push(t); } notify(this, 'childList'); }
}
class Text extends Node {
    constructor(doc, s) { super(doc); this.nodeType = 3; this.data = s; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); notify(this, 'characterData'); }
}
const HTML_LOG = { innerHTML: 0, created: [] };
class Element extends Node {
    constructor(doc, tag) { super(doc); this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this._attrs = new Map(); this.style = {}; this.value = ''; this.checked = false; this.disabled = false; HTML_LOG.created.push(this.tagName); }
    setAttribute(k, v) { this._attrs.set(String(k).toLowerCase(), String(v)); notify(this, 'attributes', String(k).toLowerCase()); }
    getAttribute(k) { const v = this._attrs.get(String(k).toLowerCase()); return v === undefined ? null : v; }
    hasAttribute(k) { return this._attrs.has(String(k).toLowerCase()); }
    removeAttribute(k) { if (this._attrs.delete(String(k).toLowerCase())) notify(this, 'attributes', String(k).toLowerCase()); }
    get id() { return this.getAttribute('id') || ''; }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get classList() {
        const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
        return {
            add: (...c) => { const s = new Set(list()); c.forEach(x => s.add(x)); el.className = [...s].join(' '); },
            remove: (...c) => { el.className = list().filter(x => c.indexOf(x) < 0).join(' '); },
            contains: (c) => list().indexOf(c) >= 0,
            toggle: (c, on) => { const has = list().indexOf(c) >= 0; const want = on === undefined ? !has : !!on; if (want && !has) el.className = list().concat(c).join(' '); if (!want && has) el.className = list().filter(x => x !== c).join(' '); return want; },
        };
    }
    get innerHTML() { return ''; }
    set innerHTML(v) { HTML_LOG.innerHTML++; throw new Error('innerHTML used: ' + String(v).slice(0, 60)); }
    get outerHTML() { return ''; }
    get type() { return this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : (this.tagName === 'BUTTON' ? 'submit' : '')); }
    get isContentEditable() { return this.getAttribute('contenteditable') === 'true'; }
    focus() { const d = this.ownerDocument; if (d.activeElement === this) return; d.activeElement = this; dispatch(d.defaultView, this, new Ev('focusin', { bubbles: true })); }
    blur() { const d = this.ownerDocument; if (d.activeElement === this) d.activeElement = d.body; }
    click(detail = 1) {
        const w = this.ownerDocument.defaultView;
        if (this.disabled) return;
        dispatch(w, this, new Ev('click', { bubbles: true, detail }));
        if (this.tagName === 'BUTTON' && this.type === 'submit') { let f = this.parentNode; while (f && f.tagName !== 'FORM') f = f.parentNode; if (f) dispatch(w, f, new Ev('submit', { bubbles: true })); }
        if (this.tagName === 'INPUT' && this.type === 'checkbox') { this.checked = !this.checked; dispatch(w, this, new Ev('change', { bubbles: true })); }
    }
    dispatchEvent(ev) { return dispatch(this.ownerDocument.defaultView, this, ev); }
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    setPointerCapture() { }
}
class Media extends Element {
    constructor(doc, tag) { super(doc, tag); this.paused = true; this.ended = false; this._muted = false; this.plays = 0; }
    get muted() { return this._muted; }
    set muted(v) { const w = this._muted; this._muted = !!v; if (w !== this._muted) dispatch(this.ownerDocument.defaultView, this, new Ev('volumechange')); }
    play() { this.plays++; this.paused = false; dispatch(this.ownerDocument.defaultView, this, new Ev('play')); return Promise.resolve(); }
    pause() { if (this.paused) return; this.paused = true; dispatch(this.ownerDocument.defaultView, this, new Ev('pause')); }
}
function parseCompound(s) {
    s = s.trim();
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)?/.exec(s);
    const tag = m[1] ? m[1].toUpperCase() : null;
    let rest = s.slice(m[0].length);
    const parts = [];
    const re = /^(?:\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:([~]?=)"?([^"\]]*)"?)?\])/;
    while (rest) { const x = re.exec(rest); if (!x) throw new Error('bad selector ' + s); parts.push(x); rest = rest.slice(x[0].length); }
    return { tag, parts };
}
function matches(el, sel) {
    return sel.split(',').some(one => {
        const c = parseCompound(one);
        if (c.tag && el.tagName !== c.tag) return false;
        return c.parts.every(p => {
            if (p[1]) return el.classList.contains(p[1]);
            if (p[2]) return el.id === p[2];
            const v = el.getAttribute(p[3]);
            if (v == null) return false;
            if (!p[4]) return true;
            if (p[4] === '=') return v === p[5];
            return v.split(/\s+/).indexOf(p[5]) >= 0;
        });
    });
}
class Doc extends Node {
    constructor() {
        super(null); this.ownerDocument = this; this.nodeType = 9; this.hidden = false; this.visibilityState = 'visible'; this.readyState = 'complete';
        this.documentElement = new Element(this, 'html'); this.appendChild(this.documentElement);
        this.head = new Element(this, 'head'); this.body = new Element(this, 'body');
        this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body);
        this.activeElement = this.body; this.fullscreenElement = null; this.pictureInPictureElement = null;
    }
    createElement(t) { const tag = String(t).toLowerCase(); return (tag === 'video' || tag === 'audio') ? new Media(this, tag) : new Element(this, tag); }
    createTextNode(s) { return new Text(this, String(s)); }
    getElementById(id) { return this.documentElement.querySelector('#' + id); }
    querySelectorAll(s) { return this.documentElement.querySelectorAll(s).concat(matches(this.documentElement, s) ? [this.documentElement] : []); }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    get title() { const t = this.head.querySelector('title'); return t ? t.textContent : ''; }
    set title(v) { let t = this.head.querySelector('title'); if (!t) { t = this.createElement('title'); this.head.appendChild(t); } t.textContent = v; }
    exitFullscreen() { this.fullscreenElement = null; return Promise.resolve(); }
    exitPictureInPicture() { this.pictureInPictureElement = null; return Promise.resolve(); }
}
function makeStorage() {
    const m = new Map();
    return {
        _m: m, writes: [],
        getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
        setItem(k, v) { this.writes.push(String(k)); m.set(String(k), String(v)); },
        removeItem(k) { m.delete(String(k)); },
        clear() { m.clear(); },
        key(i) { return [...m.keys()][i] ?? null; },
        get length() { return m.size; },
    };
}
function makeClock(start) {
    let t = start, id = 0;
    const q = new Map();
    return {
        now: () => t,
        setTimeout: (fn, ms) => { const i = ++id; q.set(i, { at: t + Math.max(0, Number(ms) || 0), fn }); return i; },
        clearTimeout: (i) => { q.delete(i); },
        pending: () => q.size,
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                let nx = null;
                for (const [i, x] of q) if (x.at <= end && (!nx || x.at < nx[1].at)) nx = [i, x];
                if (!nx) break;
                q.delete(nx[0]); t = nx[1].at;
                try { nx[1].fn(); } catch (e) { console.log('timer threw', e); }
                await flush(3);
            }
            t = end;
            await flush(3);
        },
    };
}
// 一个全新的「浏览器」:window(= vm 全局)+ document + 存储 + 假时钟 + 假 fetch;可选预置 localStorage / 钩子 / DgAdult
function makeEnv(opts = {}) {
    const doc = new Doc();
    const title = doc.createElement('title'); title.textContent = opts.title || 'DGX'; doc.head.appendChild(title);
    const icon = doc.createElement('link'); icon.setAttribute('rel', 'icon'); icon.setAttribute('href', 'icon.png'); icon.setAttribute('type', 'image/png'); doc.head.appendChild(icon);
    const app = doc.createElement('div'); app.setAttribute('id', 'app'); doc.body.appendChild(app);
    const clock = makeClock(opts.now || 1_800_000_000_000);
    const ls = makeStorage(), ss = makeStorage();
    for (const [k, v] of Object.entries(opts.ls || {})) ls._m.set(k, v);
    const fetchLog = [], beaconLog = [];
    const win = new Target();
    Object.assign(win, {
        document: doc, localStorage: ls, sessionStorage: ss, MutationObserver: MO, URL, TextEncoder, Response, Promise, console,
        crypto: opts.noCrypto ? undefined : globalThis.crypto, isSecureContext: opts.insecure ? false : true,
        innerWidth: 400, innerHeight: 800, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, queueMicrotask,
        location: { href: 'https://adult.example.test/', origin: 'https://adult.example.test', reloads: 0, reload() { this.reloads++; } },
        navigator: { sendBeacon(u) { beaconLog.push(String(u)); return true; } },
        fetch: (u, o) => { fetchLog.push({ url: String(u && u.url ? u.url : u), method: (o && o.method) || 'GET', body: o && o.body }); return Promise.resolve(new Response('{}', { status: 200 })); },
        __clock: clock,
    });
    if (opts.hooks) win.dgAdultHooks = opts.hooks;
    if (opts.DgAdult) win.DgAdult = opts.DgAdult;
    if (opts.caches) win.caches = opts.caches;
    if (opts.indexedDB) win.indexedDB = opts.indexedDB;
    if (opts.AndroidPrivacy) win.AndroidPrivacy = opts.AndroidPrivacy;
    win.window = win;
    doc.defaultView = win;
    const ctx = vm.createContext(win);
    vm.runInContext('Date.now = () => __clock.now();', ctx);
    if (!opts.noBoot) vm.runInContext(PRIV_SRC, ctx, { filename: 'privacy.js' });
    return { win, doc, ls, ss, clock, fetchLog, beaconLog, P: win.dgPrivacy, ctx, app };
}
const key = (env, k, init = {}) => {
    const t = init.target || env.doc.activeElement || env.doc.body;
    const ev = new Ev('keydown', Object.assign({ bubbles: true, key: k, code: init.code || (k === '`' ? 'Backquote' : k) }, init));
    dispatch(env.win, t, ev);
    return ev;
};
const layerOf = (env) => env.doc.body.querySelector('.dgp-layer');
const coverOf = (env) => env.doc.body.querySelector('.dgp-cover');
const iconHref = (env) => env.doc.head.querySelector('link').getAttribute('href');
// FE-BROWSE 的钩子对象(add / call 语义,与 adult.js 的 hooks 一致)
function fakeHooks() {
    const subs = {};
    return {
        add(n, fn) { (subs[n] = subs[n] || []).push(fn); return true; },
        call(n, ...a) { let okv = true; for (const f of subs[n] || []) if (f(...a) === false) okv = false; return okv; },
        count: (n) => (subs[n] || []).length,
    };
}

// ================= ① 老板键 =================
console.log('① 老板键');
{
    const env = makeEnv();
    const { doc, P } = env;
    ok(P && typeof P.incognito === 'function' && typeof P.locked === 'function' && typeof P.onChange === 'function', 'window.dgPrivacy:incognito / locked / onChange');
    ok(!!doc.head.querySelector('#dgp-css') && !!layerOf(env) && !P.locked(), '装好样式和层,没盖');
    const v1 = doc.createElement('video'), v2 = doc.createElement('video'), a1 = doc.createElement('audio');
    env.app.appendChild(v1); env.app.appendChild(v2); env.app.appendChild(a1);
    v1.play(); v2.muted = true;   // v1 在播有声 / v2 暂停静音 / a1 暂停有声
    const changes = [];
    P.onChange(s => changes.push(s.cover));
    const ev = key(env, '`');
    ok(ev.defaultPrevented && P.locked() && P.cover() === 'boss', '按 ` → 盖上(老板画面),按键被吃掉');
    ok(v1.paused && v1.muted && v2.paused && v2.muted && a1.paused && a1.muted, '所有媒体暂停 + 静音');
    ok(doc.title === '无标题文档' && /^data:image\/svg\+xml,/.test(iconHref(env)), '标签页标题 / 图标换成伪装');
    ok(doc.documentElement.classList.contains('dgp-covered') && !!coverOf(env) && coverOf(env).classList.contains('dgp-doc'), '整页盖成空白文档(html.dgp-covered)');
    ok(changes[changes.length - 1] === 'boss', 'onChange 收到 cover=boss');
    // 盖着期间:app 又要播 v2(自动下一集)、把 v1 取消静音 → 继续压住,记下意图
    v2.play(); v1.muted = false;
    ok(v2.paused && v2.muted && v1.muted, '盖着期间 app 播放 / 取消静音 → 立刻压回');
    // 盖着期间新加到 body 末尾的元素(toast)→ 我们的层还是最后一个
    const toast = doc.createElement('div'); doc.body.appendChild(toast);
    await flush();
    ok(doc.body.lastChild === layerOf(env), '盖着时有新元素加到 body 末尾 → 层挪回最后(同 z-index 后来者在上)');
    // 盖着时 app 的快捷键收不到
    let appKeys = 0;
    doc.addEventListener('keydown', () => { appKeys++; });
    key(env, ' ', { code: 'Space' });
    ok(appKeys === 0, '盖着时键盘事件到不了 app(空格不会播放)');
    key(env, '`');
    ok(!P.locked() && !doc.documentElement.classList.contains('dgp-covered') && !coverOf(env), '再按 ` → 恢复');
    ok(!v1.paused && !v1.muted, 'v1 恢复播放且声音照原样(盖着时 app 取消了静音 → 恢复为有声)');
    ok(!v2.paused && v2.muted, 'v2 照「盖着时 app 要播」恢复播放,静音照原样');
    ok(a1.paused && !a1.muted, 'a1 原来暂停有声 → 还是暂停、有声');
    ok(doc.title === 'DGX' && iconHref(env) === 'icon.png' && doc.head.querySelector('link').getAttribute('type') === 'image/png', '标题 / 图标恢复');
    key(env, ' ', { code: 'Space' });
    ok(appKeys === 1, '恢复后键盘照常到 app');
    // 搜索框里打 ` 照常输入
    const inp = doc.createElement('input'); env.app.appendChild(inp); inp.focus();
    const e2 = key(env, '`', { target: inp });
    ok(!e2.defaultPrevented && !P.locked(), '焦点在输入框:` 照常输入,不触发');
    doc.body.focus && doc.body.focus();
    // 长按不重复触发
    const e3 = key(env, '`', { target: doc.body, repeat: true });
    ok(!P.locked() && !e3.defaultPrevented, '按住不放(repeat)不触发');
    // 连按两次 Esc
    P.set({ bossKey: 'esc2' });
    key(env, 'Escape', { target: doc.body });
    ok(!P.locked(), 'Esc 一次:不触发');
    await env.clock.advance(500);
    key(env, 'Escape', { target: doc.body });
    ok(!P.locked(), '两次 Esc 隔 500ms:不触发');
    await env.clock.advance(200);
    key(env, 'Escape', { target: doc.body });
    ok(P.locked() && P.cover() === 'boss', '两次 Esc 在 400ms 内:触发');
    await env.clock.advance(100);
    key(env, 'Escape', { target: doc.body });
    await env.clock.advance(100);
    key(env, 'Escape', { target: doc.body });
    ok(!P.locked(), '盖着时再连按两次 Esc:恢复');
    P.set({ bossKey: 'f9' });
    key(env, '`', { target: doc.body });
    ok(!P.locked(), '改成 F9 后 ` 不再触发');
    key(env, 'F9', { target: doc.body });
    ok(P.locked(), 'F9 触发');
    key(env, 'F9', { target: doc.body });
    ok(!P.locked(), 'F9 恢复');
    P.set({ bossKey: 'off' });
    key(env, 'F9', { target: doc.body });
    ok(!P.locked(), '关掉老板键:什么都不触发');
    // 伪装画面:搜索页
    P.set({ bossKey: 'backquote', cover: 'search' });
    key(env, '`', { target: doc.body });
    ok(coverOf(env).classList.contains('dgp-search') && doc.title === '搜索' && !!coverOf(env).querySelector('input'), '伪装画面 = 搜索页(标题「搜索」)');
    ok(doc.activeElement === coverOf(env).querySelector('input'), '焦点在假搜索框');
    const e4 = key(env, '`', { target: coverOf(env).querySelector('input') });
    ok(!P.locked() && e4.defaultPrevented, '在假搜索框里按 ` → 恢复(不当输入)');
    // 退出全屏 / 画中画
    doc.fullscreenElement = env.app; doc.pictureInPictureElement = v1;
    key(env, '`', { target: doc.body });
    ok(doc.fullscreenElement === null && doc.pictureInPictureElement === null, '盖上时退出全屏和画中画');
    key(env, '`', { target: doc.body });
    // 三指轻点
    const touches = (n) => Array.from({ length: n }, (_, i) => ({ clientX: 100 + i * 20, clientY: 300 }));
    const tap3 = () => {
        dispatch(env.win, doc.body, new Ev('touchstart', { touches: touches(3) }));
        dispatch(env.win, doc.body, new Ev('touchend', { touches: [] }));
    };
    tap3();
    ok(!P.locked(), '三指轻点默认关');
    P.set({ touch3: true });
    tap3();
    ok(P.locked(), '打开后三指轻点 → 盖上');
    tap3();
    ok(!P.locked(), '再三指轻点 → 恢复');
    dispatch(env.win, doc.body, new Ev('touchstart', { touches: touches(3) }));
    dispatch(env.win, doc.body, new Ev('touchmove', { touches: touches(3).map(t => ({ clientX: t.clientX + 80, clientY: t.clientY })) }));
    dispatch(env.win, doc.body, new Ev('touchend', { touches: [] }));
    ok(!P.locked(), '三指滑动(不是轻点)不触发');
    // 悬浮按钮
    ok(!doc.body.querySelector('.dgp-fab'), '悬浮按钮默认没有');
    P.set({ fab: true });
    const fab = doc.body.querySelector('.dgp-fab');
    ok(!!fab && fab.getAttribute('aria-label') && /px$/.test(fab.style.left), '打开后出现悬浮按钮(有 aria-label、有位置)');
    dispatch(env.win, fab, new Ev('pointerdown', { pointerId: 1, clientX: 10, clientY: 10, bubbles: true }));
    dispatch(env.win, fab, new Ev('pointerup', { pointerId: 1, clientX: 11, clientY: 10, bubbles: true }));
    ok(P.locked() && !doc.body.querySelector('.dgp-fab'), '点悬浮按钮 → 盖上,按钮藏起来');
    key(env, '`', { target: doc.body });
    const fab2 = doc.body.querySelector('.dgp-fab');
    dispatch(env.win, fab2, new Ev('pointerdown', { pointerId: 2, clientX: 50, clientY: 50, bubbles: true }));
    dispatch(env.win, fab2, new Ev('pointermove', { pointerId: 2, clientX: 10, clientY: 120, bubbles: true }));
    dispatch(env.win, fab2, new Ev('pointerup', { pointerId: 2, clientX: 10, clientY: 120, bubbles: true }));
    const fp = P.settings().fabPos;
    ok(!P.locked() && fp && fp.x >= 0 && fp.x <= 1 && fp.y > 0, '拖动悬浮按钮 = 挪位置(不触发),位置存成比例', fp);
    // 切走自动暂停
    P.set({ autoPause: true });
    v1.play();
    doc.hidden = true; doc.visibilityState = 'hidden'; dispatch(env.win, doc, new Ev('visibilitychange'));
    ok(v1.paused, '切走自动暂停:标签页隐藏 → 暂停');
    doc.hidden = false; doc.visibilityState = 'visible'; dispatch(env.win, doc, new Ev('visibilitychange'));
    ok(v1.paused, '回来不自动播');
    ok(!/setInterval/.test(PRIV_SRC), 'privacy.js 不用 setInterval(不轮询)');
}

// ================= ② 无痕 =================
console.log('② 无痕');
{
    const hooks = fakeHooks();
    let beaconSent = 0;
    const DgAdult = { beacon: { send() { beaconSent++; return true; } } };
    const env = makeEnv({ hooks, DgAdult });
    const { P, win, doc, ls, ss } = env;
    ok(hooks.count('onHistoryWrite') === 1 && hooks.count('onSettingsRender') === 1, '挂到 dgAdultHooks(add):onHistoryWrite / onSettingsRender');
    ok(hooks.call('onHistoryWrite', { kind: 'history', name: 'x' }) === true, '没开无痕:不否决');
    win.localStorage.setItem('donggua_watch_history', '[1]');
    ok(ls.getItem('donggua_watch_history') === '[1]', '没开无痕:照常写');
    P.setIncognito(true);
    ok(P.incognito() === true && JSON.parse(ls.getItem('dgp_settings')).incognito === true, '开无痕(存进 dgp_settings)');
    ok(hooks.call('onHistoryWrite', { kind: 'history', name: 'x' }) === false && hooks.call('onHistoryWrite', { kind: 'progress' }) === false && hooks.call('onHistoryWrite', { kind: 'stats' }) === false, '无痕:onHistoryWrite 一律否决(历史 / 进度 / 统计)');
    const blocked = ['donggua_watch_history', 'donggua_progress_某片_第1集', 'donggua_hist_synced', 'donggua_watch_pending', 'donggua_live_recent', 'donggua_fav_cache', 'donggua_src_res', 'dg_wk_tags', 'donggua_afp|片|站|1'];
    blocked.forEach(k => win.localStorage.setItem(k, 'NEW'));
    ok(blocked.every(k => ls.getItem(k) !== 'NEW'), '无痕:列出的本机键一个都没写', blocked.filter(k => ls.getItem(k) === 'NEW'));
    win.sessionStorage.setItem('dg_bc_sent', '["x"]');
    ok(ss.getItem('dg_bc_sent') === null, '无痕:sessionStorage 的线路反馈去重(带作品键)也不写');
    win.localStorage.setItem('donggua_favorites', '[]'); win.localStorage.setItem('dg_blur_cover', '1'); win.localStorage.setItem('emax_auth_hash', 'tok');
    ok(ls.getItem('donggua_favorites') === '[]' && ls.getItem('dg_blur_cover') === '1' && ls.getItem('emax_auth_hash') === 'tok', '无痕:收藏 / 设置 / 登录照常写');
    ok(P.isBlockedKey('donggua_progress_x') && !P.isBlockedKey('donggua_favorites') && P.keys().keys.indexOf('donggua_watch_history') >= 0, 'isBlockedKey / keys() 公开列表');
    P.registerKeys({ keys: ['dg_feed_seen'], prefixes: ['dg_pv_'] });
    win.localStorage.setItem('dg_feed_seen', '1'); win.localStorage.setItem('dg_pv_cache_1', '1');
    ok(ls.getItem('dg_feed_seen') === null && ls.getItem('dg_pv_cache_1') === null, 'registerKeys 加的键 / 前缀也拦');
    // 网络
    const before = env.fetchLog.length;
    const r1 = await win.fetch('/api/stats/watch', { method: 'POST', body: '{}' });
    const r2 = await win.fetch('/api/history/push', { method: 'POST', body: '{}' });
    const r3 = await win.fetch('/api/catalog/beacon', { method: 'POST', body: '{}' });
    const r4 = await win.fetch('https://adult.example.test/api/catalog/heat', { method: 'POST', body: '{}' });
    ok(env.fetchLog.length === before && r1.status === 204 && r2.status === 503 && r3.status === 204 && r4.status === 204, '无痕:统计 / 历史推送(503)/ 线路反馈 / 热度 POST 不发', [r1.status, r2.status, r3.status, r4.status]);
    await win.fetch('/api/catalog/work?wk=c:ABC-1');
    await win.fetch('/api/catalog/heat/c:ABC-1');
    await win.fetch('https://other.example/api/stats/watch', { method: 'POST' });
    await win.fetch(new URL('https://adult.example.test/api/search?wd=x'));
    ok(env.fetchLog.length === before + 4, '无痕:GET 照常、别的站照常', env.fetchLog.slice(before));
    ok(win.navigator.sendBeacon('/api/history/push', 'x') === true && win.navigator.sendBeacon('/api/stats/watch', 'x') === true && env.beaconLog.length === 0, '无痕:sendBeacon 推送 / 统计被吞(假装发了)');
    win.navigator.sendBeacon('/api/other', 'x');
    ok(env.beaconLog.length === 1, '别的 sendBeacon 照常');
    ok(DgAdult.beacon.send({}) === false && beaconSent === 0, '无痕:adult.js 线路反馈(用原生 fetch 绕过包装)在 send 上被挡');
    ok(!!doc.body.querySelector('.dgp-badge') && /无痕/.test(doc.body.querySelector('.dgp-badge').textContent), '无痕:角落小标');
    P.setIncognito(false);
    ok(!doc.body.querySelector('.dgp-badge') && hooks.call('onHistoryWrite', { kind: 'history' }) === true, '关无痕:小标没了、不再否决');
    win.localStorage.setItem('donggua_watch_history', '[2]');
    await win.fetch('/api/stats/watch', { method: 'POST' });
    ok(ls.getItem('donggua_watch_history') === '[2]' && env.fetchLog.length === before + 5 && DgAdult.beacon.send({}) === true, '关无痕:照常写、照常发');
    // 没有 adult.js:放一个普通对象(adult.js 装上时合并)
    const env2 = makeEnv();
    const H = env2.win.dgAdultHooks;
    ok(H && typeof H.onHistoryWrite === 'function' && typeof H.onSettingsRender === 'function', '没有 dgAdultHooks:放一个带两个函数的普通对象');
    env2.P.setIncognito(true);
    ok(H.onHistoryWrite({ kind: 'history' }) === false, '普通对象上的 onHistoryWrite 也否决');
    // 开着无痕启动:上次无痕会话的接口 / 图片缓存清掉
    const cacheStore = fakeCaches();
    makeEnv({ ls: { dgp_settings: JSON.stringify({ incognito: true }) }, caches: cacheStore.api });
    await flush(10);
    ok(cacheStore.deleted.indexOf('donggua-images-v43') >= 0 && cacheStore.entries('donggua-static-v43').every(u => !/\/api\//.test(u)), '无痕状态下打开:清掉图片缓存和接口缓存', cacheStore.dump());
}
function fakeCaches() {
    const stores = new Map([
        ['donggua-static-v43', ['https://adult.example.test/index.html', 'https://adult.example.test/api/catalog/work?wk=c:A', 'https://adult.example.test/api/search?wd=x', 'https://adult.example.test/libs/js/vue.js']],
        ['donggua-images-v43', ['https://img.example/a.jpg']],
        ['donggua-live-img-v43', ['https://img.example/b.png']],
        ['other-cache', ['https://x/api/y']],
    ]);
    const deleted = [];
    const api = {
        keys: async () => [...stores.keys()],
        delete: async (n) => { deleted.push(n); return stores.delete(n); },
        open: async (n) => ({
            keys: async () => (stores.get(n) || []).map(url => ({ url })),
            delete: async (r) => { const a = stores.get(n) || []; const i = a.indexOf(r.url); if (i >= 0) { a.splice(i, 1); return true; } return false; },
        }),
    };
    return { api, deleted, entries: (n) => stores.get(n) || [], dump: () => Object.fromEntries(stores) };
}

// ================= ③ PIN =================
console.log('③ PIN');
{
    const env = makeEnv();
    const { P, doc, ls, clock, win } = env;
    const M = vm.runInContext('typeof module', env.ctx);
    ok(M === 'undefined', '(桩环境里没有 module:privacy.js 自动 boot)');
    ok(P.pinAvailable() && !P.hasPin(), 'WebCrypto 可用,还没 PIN');
    // 通过设置面板设 PIN
    const box = doc.createElement('div'); env.app.appendChild(box);
    win.dgAdultHooks.onSettingsRender(box);
    const sec = box.querySelector('[data-dgp-section]');
    ok(!!sec && /隐私/.test(sec.textContent) && /PIN 锁/.test(sec.textContent) && /不是账号安全/.test(sec.textContent), '设置面板:隐私一节(含「不是账号安全」说明)');
    sec.querySelector('[data-dgp="pinSet"]').click();
    let s2 = box.querySelector('[data-dgp-section]');
    s2.querySelector('[data-dgp="pinNew"]').value = '1234';
    s2.querySelector('[data-dgp="pinNew2"]').value = '1235';
    s2.querySelector('[data-dgp="pinOk"]').click();
    ok(/不一样/.test(box.textContent) && !P.hasPin(), '两次不一样 → 不设');
    s2 = box.querySelector('[data-dgp-section]');
    s2.querySelector('[data-dgp="pinNew"]').value = '12a4';
    s2.querySelector('[data-dgp="pinNew2"]').value = '12a4';
    s2.querySelector('[data-dgp="pinOk"]').click();
    ok(/4–6 位数字/.test(box.textContent) && !P.hasPin(), '不是 4–6 位数字 → 不设');
    s2 = box.querySelector('[data-dgp-section]');
    s2.querySelector('[data-dgp="pinNew"]').value = '482913';
    s2.querySelector('[data-dgp="pinNew2"]').value = '482913';
    s2.querySelector('[data-dgp="pinOk"]').click();
    for (let i = 0; i < 100 && !P.hasPin(); i++) await new Promise(r => setTimeout(r, 20));
    await flush();
    ok(P.hasPin() && /PIN 已设置/.test(box.textContent), '设 PIN 成功(面板提示)');
    const rec = JSON.parse(ls.getItem('dgp_pin'));
    ok(rec.v === 1 && rec.kdf === 'pbkdf2-sha256' && rec.it === 150000 && /^[0-9a-f]{32}$/.test(rec.salt) && /^[0-9a-f]{64}$/.test(rec.dk) && !/482913/.test(ls.getItem('dgp_pin')), 'PIN 记录:PBKDF2-SHA256 15 万次、16 字节盐、32 字节派生值,不存明文', rec);
    // 独立用 node 的 WebCrypto 复算一遍
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('482913'), 'PBKDF2', false, ['deriveBits']);
    const dk = Buffer.from(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(rec.salt, 'hex'), iterations: 150000 }, k, 256)).toString('hex');
    ok(dk === rec.dk, '派生值与独立复算一致');
    // 锁屏
    ok(P.lock() === true && P.cover() === 'lock' && coverOf(env).classList.contains('dgp-lock'), 'lock() → 锁屏');
    ok(doc.title === '无标题文档', '锁着时标签页不露标题');
    const lockInput = coverOf(env).querySelector('.dgp-pin');
    ok(doc.activeElement === lockInput, '焦点在 PIN 输入框');
    const escEv = key(env, 'Escape', { target: lockInput });
    ok(P.cover() === 'lock' && escEv.defaultPrevented, 'Esc 关不掉锁屏');
    // Tab 只在锁屏里转
    const f0 = doc.activeElement;
    for (let i = 0; i < 6; i++) key(env, 'Tab', { target: doc.activeElement });
    ok(coverOf(env).contains(doc.activeElement), 'Tab 转了 6 次焦点还在锁屏里');
    f0.focus();
    // 页面别处抢焦点 → 拉回锁屏
    const outside = doc.createElement('button'); env.app.appendChild(outside); outside.focus();
    ok(coverOf(env).contains(doc.activeElement), '焦点跑到页面里 → 拉回锁屏');
    // 老板键:锁屏 → 老板画面 → 再按回锁屏(不会解开)
    key(env, '`', { target: doc.activeElement });
    ok(P.cover() === 'boss', '锁屏上按老板键 → 换成伪装画面');
    key(env, '`', { target: doc.activeElement });
    ok(P.cover() === 'lock', '再按 → 回到锁屏(有 PIN 绝不直接解开)');
    // 错 PIN / 对 PIN(通过锁屏表单)
    // 提交锁屏表单,等到有结论(出了提示 / 解开了)
    const submitPin = async (v) => {
        const c = coverOf(env), i = c.querySelector('.dgp-pin'), err = c.querySelector('.dgp-err');
        err.textContent = '';
        i.value = v;
        dispatch(env.win, c.querySelector('form'), new Ev('submit', { bubbles: true }));
        for (let n = 0; n < 300; n++) { if (err.textContent !== '' || !P.locked()) break; await new Promise(r => setTimeout(r, 10)); }
        await flush();
    };
    await submitPin('000000');
    ok(P.cover() === 'lock' && /不对/.test(coverOf(env).textContent), '错 PIN:还锁着、提示不对');
    // 解锁后媒体按原状态恢复
    await submitPin('482913');
    ok(!P.locked() && doc.title === 'DGX', '对 PIN:解锁、标题恢复');
    // 连错 5 次 → 30s,之后翻倍(假时钟)
    P.lock();
    for (let i = 0; i < 4; i++) await submitPin('111111');
    ok(P.locked() && !/秒后再试/.test(coverOf(env).textContent), '错 4 次:还能继续输');
    await submitPin('111111');
    const t1 = coverOf(env).textContent;
    ok(/30 秒后再试/.test(t1) && coverOf(env).querySelector('.dgp-pin').disabled, '错第 5 次:锁 30 秒(输入框禁用)', t1);
    await submitPin('482913');
    ok(P.locked(), '锁定期间对的 PIN 也不认');
    await clock.advance(29_000);
    ok(/1 秒后再试/.test(coverOf(env).textContent), '倒计时走到 1 秒', coverOf(env).textContent);
    await clock.advance(1_000);
    ok(!coverOf(env).querySelector('.dgp-pin').disabled, '30 秒到:能输了');
    await submitPin('222222');
    ok(/60 秒后再试/.test(coverOf(env).textContent), '第 6 次错:等 60 秒(翻倍)', coverOf(env).textContent);
    await clock.advance(60_000);
    await submitPin('333333');
    ok(/120 秒后再试/.test(coverOf(env).textContent), '第 7 次错:等 120 秒', coverOf(env).textContent);
    const fr = JSON.parse(ls.getItem('dgp_pin_fail'));
    ok(fr.n === 7 && fr.until === clock.now() + 120_000, '失败次数和解禁时间存在本机(刷新也不清零)', fr);
    await clock.advance(120_000);
    await submitPin('482913');
    ok(!P.locked() && ls.getItem('dgp_pin_fail') === null, '解禁后对的 PIN 解锁,失败计数清零');
    // 闲置锁:默认 5 分钟;正在播放不算闲置
    const v = doc.createElement('video'); env.app.appendChild(v);
    await clock.advance(4 * 60e3);
    ok(!P.locked(), '闲置 4 分钟:没锁');
    await clock.advance(61e3);
    ok(P.locked(), '闲置满 5 分钟:锁上');
    await submitPin('482913');
    v.play();
    await clock.advance(12 * 60e3);
    ok(!P.locked(), '一直在播放:12 分钟也不算闲置');
    v.pause();
    await clock.advance(5 * 60e3 + 2000);
    ok(P.locked(), '停了以后闲置 5 分钟:锁上');
    await submitPin('482913');
    P.set({ idleMin: 1 });
    await clock.advance(61e3);
    ok(P.locked(), '闲置改成 1 分钟:1 分钟锁');
    await submitPin('482913');
    P.set({ idleMin: 30 });
    // 后台:离开 30s 回来不锁;≥1 分钟锁;隐藏期间页面内容不可见
    const hide = () => { doc.hidden = true; doc.visibilityState = 'hidden'; dispatch(env.win, doc, new Ev('visibilitychange')); };
    const show = () => { doc.hidden = false; doc.visibilityState = 'visible'; dispatch(env.win, doc, new Ev('visibilitychange')); };
    hide();
    ok(doc.documentElement.classList.contains('dgp-hide'), '切到后台:页面内容先藏起来(回来那一帧不露)');
    await clock.advance(30e3);
    show();
    ok(!P.locked() && !doc.documentElement.classList.contains('dgp-hide'), '离开 30 秒回来:不锁、内容回来');
    hide();
    await clock.advance(61e3);
    show();
    ok(P.locked() && P.cover() === 'lock', '离开超过 1 分钟回来:锁上');
    await submitPin('482913');
    // 盖着的锁屏里的「忘记 PIN」→ 确认框
    P.lock();
    const forgot = Array.from(coverOf(env).querySelectorAll('button')).find(b => /忘记 PIN/.test(b.textContent));
    forgot.click();
    const confirmBox = coverOf(env).querySelector('.dgp-confirm');
    ok(!confirmBox.hasAttribute('hidden') && /退出登录/.test(confirmBox.textContent) && /离线下载/.test(confirmBox.textContent), '忘记 PIN:先给确认框(说清楚会退出登录、清空本机和离线下载)');
    ok(doc.activeElement === confirmBox.querySelector('[data-dgp-reset]'), '焦点到「重置这台设备」');
    await submitPin('482913');
    // 设置面板:修改 / 移除 PIN
    win.dgAdultHooks.onSettingsRender(box);
    let s3 = box.querySelector('[data-dgp-section]');
    ok(!!s3.querySelector('[data-dgp="idleMin"]') && !!s3.querySelector('[data-dgp="pinRemove"]'), '有 PIN 时:闲置下拉、修改 / 移除按钮');
    s3.querySelector('[data-dgp="pinRemove"]').click();
    s3 = box.querySelector('[data-dgp-section]');
    s3.querySelector('[data-dgp="pinCur"]').value = '000000';
    s3.querySelector('[data-dgp="pinOk"]').click();
    for (let i = 0; i < 100 && !/不对/.test(box.textContent); i++) await new Promise(r => setTimeout(r, 20));
    ok(P.hasPin() && /当前 PIN 不对/.test(box.textContent), '移除 PIN:当前 PIN 错 → 不移除');
    s3 = box.querySelector('[data-dgp-section]');
    s3.querySelector('[data-dgp="pinCur"]').value = '482913';
    s3.querySelector('[data-dgp="pinOk"]').click();
    for (let i = 0; i < 100 && P.hasPin(); i++) await new Promise(r => setTimeout(r, 20));
    await flush();
    ok(!P.hasPin() && ls.getItem('dgp_pin') === null && /PIN 已移除/.test(box.textContent), '移除 PIN 成功');
    await clock.advance(31 * 60e3);
    ok(!P.locked(), '没 PIN:闲置不锁');
    // 打开即锁:带着 PIN 记录启动
    const env3 = makeEnv({ ls: { dgp_pin: JSON.stringify(rec) } });
    ok(env3.P.cover() === 'lock' && env3.doc.title === '无标题文档' && env3.doc.documentElement.classList.contains('dgp-covered'), '有 PIN 打开站点:直接锁屏、标题伪装');
    // 记录被改坏:照样锁(fail-closed),哪个 PIN 都不认
    const env4 = makeEnv({ ls: { dgp_pin: '{"v":1,"it":5}' } });
    ok(env4.P.cover() === 'lock', 'PIN 记录坏了:照样锁(fail-closed)');
    // 没有 WebCrypto(http 非 localhost)
    const env5 = makeEnv({ insecure: true });
    ok(!env5.P.pinAvailable(), 'isSecureContext=false:PIN 不可用');
    const b5 = env5.doc.createElement('div'); env5.app.appendChild(b5);
    env5.P.renderSettings(b5);
    ok(/不是 HTTPS/.test(b5.textContent) && !b5.querySelector('[data-dgp="pinSet"]'), '设置面板说明原因、没有「设置 PIN」');
    const env6 = makeEnv({ insecure: true, ls: { dgp_pin: JSON.stringify(rec) } });
    ok(env6.P.cover() === 'lock' && !coverOf(env6).querySelector('.dgp-pin') && /不是 HTTPS/.test(coverOf(env6).textContent), '有 PIN 但没 WebCrypto:锁着,只能重置(不给输入框)');
}

// ================= ④ 标签页伪装 =================
console.log('④ 标签页伪装');
{
    const env = makeEnv({ title: 'DGX' });
    const { P, doc } = env;
    P.set({ disguise: true, preset: 'mail' });
    ok(doc.title === '收件箱' && decodeURIComponent(iconHref(env)).indexOf('<rect') > 0, '伪装成邮箱:标题「收件箱」+ 信封图标');
    doc.title = '某某作品 - DGX';   // app 改标题
    await flush();
    ok(doc.title === '收件箱', 'app 改 document.title → 被盖回去');
    doc.head.querySelector('link').setAttribute('href', 'icon2.png');   // app 换图标
    await flush();
    ok(/^data:image\/svg/.test(iconHref(env)), 'app 换图标 → 被盖回去');
    P.set({ preset: 'custom', customTitle: '  周报\n草稿  ' });
    ok(doc.title === '周报 草稿', '自定义标题(去控制字符、压空白)');
    P.set({ customTitle: '' });
    ok(doc.title === '无标题文档', '自定义标题为空 → 「无标题文档」');
    P.set({ preset: 'search' });
    ok(doc.title === '搜索', '伪装成搜索');
    // 伪装开着时老板键:盖上再恢复,标题仍是伪装
    key(env, '`', { target: doc.body });
    ok(doc.title === '搜索', '伪装开着:老板键盖上时用伪装预设');
    key(env, '`', { target: doc.body });
    ok(doc.title === '搜索', '恢复后还是伪装');
    P.set({ disguise: false });
    ok(doc.title === '某某作品 - DGX' && iconHref(env) === 'icon2.png', '关伪装:恢复 app 最后设的标题和图标');
    doc.title = '新标题';
    await flush();
    ok(doc.title === '新标题', '关着时不再改标题');
    // 页面原本没有图标:伪装时加一个,关掉删掉
    const env2 = makeEnv();
    env2.doc.head.removeChild(env2.doc.head.querySelector('link'));
    env2.P.set({ disguise: true });
    ok(env2.doc.head.querySelectorAll('link').length === 1, '原本没图标:伪装时补一个');
    env2.P.set({ disguise: false });
    ok(env2.doc.head.querySelectorAll('link').length === 0, '关掉时删掉补的');
}

// ================= ⑤ 一键清除 / 忘记 PIN =================
console.log('⑤ 一键清除');
{
    const caches = fakeCaches();
    const idbCalls = [];
    const fakeIdb = {
        open(name) {
            idbCalls.push('open:' + name);
            const req = {};
            setTimeout(() => {
                const db = {
                    objectStoreNames: ['files', 'episodes'],
                    transaction(names, mode) { idbCalls.push('tx:' + names.join(',') + ':' + mode); const tx = { objectStore: (n) => ({ clear: () => idbCalls.push('clear:' + n) }) }; setTimeout(() => tx.oncomplete && tx.oncomplete(), 0); return tx; },
                    close() { idbCalls.push('close'); },
                };
                req.result = db; req.onsuccess && req.onsuccess();
            }, 0);
            return req;
        },
    };
    const seed = {
        donggua_watch_history: '[{"name":"x"}]', 'donggua_progress_x_1': '12', donggua_hist_synced: '{}', donggua_live_recent: '[]', donggua_fav_cache: '{}', dg_wk_tags: '{}',
        donggua_history_deleted: '{}', donggua_trial: '{}', donggua_popular_cache3: '{}',
        donggua_favorites: '[1]', emax_auth_hash: 'TOKEN123', dg_age_ok: '1', dg_blur_cover: '1', donggua_site_health2: '{}', dgp_settings: '{}',
    };
    const env = makeEnv({ ls: seed, caches: caches.api, indexedDB: fakeIdb });
    const { P, ls, ss, win, doc } = env;
    // 用真正的计时器跑 IDB 桩
    win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
    ss.setItem('dg_bc_sent', '[]'); ss.setItem('donggua_share_ref', 'x');
    // 通过设置面板:清除… → 勾离线下载 → 二次确认
    const box = doc.createElement('div'); env.app.appendChild(box);
    P.renderSettings(box);
    box.querySelector('[data-dgp="clear"]').click();
    const off = box.querySelector('[data-dgp="clear_offline"]');
    ok(!!off && !!box.querySelector('[data-dgp="clear_server"]') && box.querySelector('[data-dgp="clear_server"]').checked, '清除…:给两个选项(云端历史默认勾、离线下载默认不勾)');
    off.click();
    box.querySelector('[data-dgp="clearGo"]').click();
    ok(/没法恢复/.test(box.textContent) && !!box.querySelector('[data-dgp="clearGo2"]') && ls.getItem('donggua_watch_history') !== null, '勾了离线下载 → 先要第二次确认(还没删)');
    // 清除过程中 app 卸载时又写历史 / 推送 → 拦下
    box.querySelector('[data-dgp="clearGo2"]').click();
    win.localStorage.setItem('donggua_watch_history', '[{"name":"rewrite"}]');
    for (let i = 0; i < 100 && win.location.reloads === 0; i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 450));
    const left = [...ls._m.keys()].sort();
    ok(['donggua_watch_history', 'donggua_progress_x_1', 'donggua_hist_synced', 'donggua_live_recent', 'donggua_fav_cache', 'dg_wk_tags', 'donggua_history_deleted', 'donggua_trial', 'donggua_popular_cache3'].every(k => ls.getItem(k) === null), '列出的记录键都删了', left);
    ok(['donggua_favorites', 'emax_auth_hash', 'dg_age_ok', 'dg_blur_cover', 'donggua_site_health2', 'dgp_settings'].every(k => ls.getItem(k) !== null), '收藏 / 登录 / 年龄确认 / 设置留着', left);
    ok(ss.length === 0, 'sessionStorage 清空');
    const clr = env.fetchLog.find(x => x.url === '/api/history/clear');
    ok(!!clr && clr.method === 'POST' && JSON.parse(clr.body).token === 'TOKEN123', '云端历史:POST /api/history/clear 带同步令牌', env.fetchLog);
    ok(caches.deleted.indexOf('donggua-images-v43') >= 0 && caches.deleted.indexOf('donggua-live-img-v43') >= 0 && caches.deleted.indexOf('other-cache') < 0
        && caches.entries('donggua-static-v43').length === 2 && caches.entries('donggua-static-v43').every(u => !/\/api\//.test(u)), '图片缓存删、外壳缓存只删 /api/、别人的缓存不动', caches.dump());
    ok(idbCalls.indexOf('clear:files') >= 0 && idbCalls.indexOf('clear:episodes') >= 0, '离线下载:清空 donggua_offline 的表', idbCalls);
    ok(win.location.reloads === 1, '清完刷新页面');
    // 不勾离线下载 → 不碰 IDB
    const idb2 = []; const env2 = makeEnv({ ls: { emax_auth_hash: 't' }, indexedDB: { open() { idb2.push(1); return {}; } } });
    const out = await env2.P.clearLocal({ server: false, offline: false, reload: false });
    ok(idb2.length === 0 && out.server === null && !env2.fetchLog.some(x => x.url === '/api/history/clear'), '不勾离线下载 / 云端:不碰 IDB、不调清云端');
    // 忘记 PIN → 全部重置(退出登录)
    let loggedOut = 0;
    const rec = { v: 1, kdf: 'pbkdf2-sha256', it: 150000, salt: '00'.repeat(16), dk: '11'.repeat(32) };
    const env3 = makeEnv({ ls: Object.assign({}, seed, { dgp_pin: JSON.stringify(rec) }), DgAdult: { auth: { logout() { loggedOut++; return Promise.resolve(); } } }, caches: fakeCaches().api });
    env3.win.setTimeout = setTimeout; env3.win.clearTimeout = clearTimeout;
    ok(env3.P.cover() === 'lock', '(有 PIN:锁着)');
    const c3 = coverOf(env3);
    Array.from(c3.querySelectorAll('button')).find(b => /忘记 PIN/.test(b.textContent)).click();
    c3.querySelector('[data-dgp-reset]').click();
    for (let i = 0; i < 200 && env3.win.location.reloads === 0; i++) await new Promise(r => setTimeout(r, 20));
    ok(env3.ls.length === 0 && env3.ss.length === 0 && loggedOut === 1 && env3.win.location.reloads === 1, '忘记 PIN:本机全部清空(含 PIN 和登录)、服务器登出、刷新', [...env3.ls._m.keys()]);
}

// ================= ⑥ 设置面板 / App =================
console.log('⑥ 设置面板');
{
    const calls = [];
    const env = makeEnv({ AndroidPrivacy: { setSecure: (b) => { calls.push(b); } } });
    const { P, doc } = env;
    ok(calls[0] === true, 'App:启动时按设置开防截屏(默认开)');
    const box = doc.createElement('div'); env.app.appendChild(box);
    P.renderSettings(box);
    P.renderSettings(box);
    ok(box.querySelectorAll('[data-dgp-section]').length === 1, '同一容器重画只留一份');
    const other = doc.createElement('div'); other.textContent = '别的模块'; box.insertBefore(other, box.firstChild);
    P.renderSettings(box);
    ok(box.firstChild === other && box.querySelectorAll('[data-dgp-section]').length === 1, '不动容器里别人的东西');
    const inc = box.querySelector('[data-dgp="incognito"]');
    ok(inc && inc.getAttribute('aria-label') === '无痕模式', '开关有 aria-label');
    inc.click();
    ok(P.incognito() && box.querySelector('[data-dgp="incognito"]').checked, '点无痕开关 → 开,面板跟着更新');
    const sel = box.querySelector('[data-dgp="bossKey"]');
    sel.value = 'f9'; dispatch(env.win, sel, new Ev('change', { bubbles: true }));
    ok(P.settings().bossKey === 'f9', '老板键下拉');
    const sec = box.querySelector('[data-dgp="secure"]');
    ok(!!sec, 'App:有防截屏开关');
    sec.click();
    ok(calls[calls.length - 1] === false, '关防截屏 → 调 AndroidPrivacy.setSecure(false)');
    box.parentNode.removeChild(box);
    P.setIncognito(false);   // 容器拿掉之后再变化:不报错、不再重画
    ok(!P.incognito(), '容器拿掉后状态变化照常');
    ok(JSON.stringify(Object.keys(P.settings()).sort()) === JSON.stringify(['autoPause', 'bossKey', 'cover', 'customTitle', 'disguise', 'fab', 'fabPos', 'idleMin', 'incognito', 'preset', 'secure', 'touch3']), 'settings() 字段');
    // 坏设置 → 默认值
    const env2 = makeEnv({ ls: { dgp_settings: '{"bossKey":"x","idleMin":7,"preset":"<b>","fabPos":{"x":5,"y":-1},"incognito":"yes"}' } });
    const st = env2.P.settings();
    ok(st.bossKey === 'backquote' && st.idleMin === 5 && st.preset === 'doc' && st.fabPos.x === 1 && st.fabPos.y === 0 && st.incognito === false, '存的设置坏了 → 逐项回默认(incognito 只认 true)', st);
    // 没有存储也能用
    const env3 = makeEnv();
    env3.win.localStorage = null;
    env3.P.setIncognito(true);
    ok(env3.P.incognito(), '存储不可用:照样能开(只是不记住)');
}

// ================= ⑦ admin.js =================
console.log('⑦ admin.js');
{
    ok(/<script src="\/adult\/admin\.js\?v=\d+" defer><\/script>/.test(ADMIN_HTML) && !/https?:\/\//.test(ADMIN_HTML.replace(/<!--[\s\S]*?-->/g, '')) && /noindex/.test(ADMIN_HTML), 'admin.html:绝对路径加载 admin.js、不引外部 CDN、noindex');
    const XSS = '<img src=x onerror=alert(1)>', XSS2 = '<script>alert(2)</script>';
    function adminEnv(routes, opts = {}) {
        const doc = new Doc();
        const main = doc.createElement('main'); main.setAttribute('id', 'dgx-admin');
        const head = doc.createElement('header'); head.className = 'adm-head'; main.appendChild(head);
        doc.body.appendChild(main);
        const ls = makeStorage(), ss = makeStorage();
        if (opts.token) ss._m.set('dgx_admin_token', opts.token);
        const log = [];
        const win = new Target();
        Object.assign(win, { document: doc, localStorage: ls, sessionStorage: ss, URL, console, setTimeout, clearTimeout, __dgAdminNoBoot: true, module: { exports: {} } });
        win.window = win; doc.defaultView = win;
        const fetchFn = async (u, o) => {
            log.push({ url: u, method: o.method, body: o.body ? JSON.parse(o.body) : undefined, token: o.headers['X-Admin-Token'] });
            const p = u.replace('/api/adult/admin', '');
            const r = routes(o.method + ' ' + p, o, log);
            const status = r.status || 200;
            return { ok: status >= 200 && status < 300, status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)), headers: { get: () => null } };
        };
        const ctx = vm.createContext(win);
        vm.runInContext(ADMIN_SRC, ctx, { filename: 'admin.js' });
        const api = win.module.exports;
        const boot = () => api.boot(doc, main, { window: win, fetch: fetchFn });
        return { doc, main, ls, ss, log, win, ctx, fetchFn, api, boot };
    }
    const evil = {
        'GET /stats': { body: { works: 1234, lines: 5678, sites: [{ key: 'av_s01', name: XSS, lastOk: Date.now() - 120e3, fails: 2, active: true, overrideActive: null }], rejected: { [XSS]: 7, minor: 3 }, rescan: { gen: 3, note: XSS2 }, avdb: { [XSS2]: XSS }, extraBlock: { n: 2, rev: XSS }, catalog: true, mirrors: 0 } },
        'POST /test': { body: { query: false, item: { ok: false, reason: XSS, bucket: XSS2, review: 'noncon' }, parsed: { code: XSS, key: 'c:' + XSS, kind: 'jav', codeOk: true }, tags: [{ id: XSS, kind: 'review' }], avdb: { pol: XSS2 } } },
        'GET /block-words': { body: { words: [XSS, '测试词'], n: 2, rev: 'r1' } },
        'PUT /block-words': { body: { ok: true, words: ['甲乙', '丙丁'], n: 2, rev: 'r2' } },
        'GET /hidden': { body: [{ wk: 'c:' + XSS, name: XSS2, at: Date.now() }] },
        'POST /hide': { body: { ok: true } },
        'GET /sites': { body: [{ key: 'av_s01', name: XSS, api: 'javascript:alert(1)', current: XSS, active: true, overrideActive: null, lastOk: 0, fails: 0 }, { key: 'av_s02', name: 'B', active: false, overrideActive: false, current: 'https://b.example/api.php' }, { key: 'av_s03', name: 'C', active: false, overrideActive: null }] },
        'POST /site': { body: { ok: true } },
        'GET /mirrors': { body: [{ key: 'av_s01', primary: 'https://a.example/api.php', current: XSS, since: Date.now(), fails: 3, lastProbe: 0, candidates: 2, reason: XSS2 }] },
        'POST /mirror/probe': { body: { ok: false, tried: [XSS], reason: XSS2 } },
    };
    const A = adminEnv((k) => evil[k] || { status: 404, body: { error: 'NOT_FOUND' } }, { token: 'T0K' });
    HTML_LOG.created = [];
    const adminApi = A.api;
    ok(typeof adminApi.boot === 'function' && typeof adminApi.parseWords === 'function', 'admin.js 导出 boot / parseWords');
    ok(!A.main.querySelector('.adm-panel'), '__dgAdminNoBoot:require / 测试时不自己启动');
    const ui = A.boot();
    await flush(10);
    const txt = () => A.main.textContent;
    ok(A.log[0] && A.log[0].url === '/api/adult/admin/stats' && A.log[0].token === 'T0K', 'sessionStorage 里有令牌 → 直接进概览,请求带 X-Admin-Token');
    ok(txt().indexOf(XSS) >= 0 && txt().indexOf(XSS2) >= 0 && /1,234/.test(txt()), '概览:服务器字符串原样当文字显示(含 <img onerror> / <script>)');
    for (const t of ['test', 'words', 'hidden', 'sites', 'mirrors']) { await ui.select(t); await flush(10); }
    // 规则测试
    await ui.select('test'); await flush(5);
    A.main.querySelector('#adm-t-title').value = '测试片名';
    A.main.querySelector('#adm-t-type').value = '日本有码';
    dispatch(A.win, A.main.querySelector('form'), new Ev('submit', { bubbles: true }));
    await flush(10);
    const tl = A.log.filter(x => x.url.endsWith('/test')).pop();
    ok(tl && tl.method === 'POST' && tl.body.title === '测试片名' && tl.body.type_name === '日本有码', '规则测试:POST {title, type_name}');
    ok(/拦截/.test(txt()) && txt().indexOf(XSS) >= 0 && /审查级/.test(txt()) && /noncon/.test(txt()), '规则测试结果:判定 / 原因 / 审查级 / 标签都当文字');
    // 屏蔽词
    await ui.select('words'); await flush(10);
    const ta = A.main.querySelector('#adm-words');
    ok(ta.value.split('\n')[0] === XSS, '屏蔽词:原样放进 textarea 的 value');
    ta.value = '甲乙\n丙丁\n甲乙\n';
    Array.from(A.main.querySelectorAll('button')).find(b => b.textContent === '保存').click();
    await flush(10);
    const pw = A.log.filter(x => x.method === 'PUT').pop();
    ok(pw && JSON.stringify(pw.body) === JSON.stringify({ words: ['甲乙', '丙丁'] }) && /已保存 2 个词/.test(txt()), 'PUT block-words {words}(去重)', pw && pw.body);
    ta.value = '甲';
    const nPut = A.log.filter(x => x.method === 'PUT').length;
    Array.from(A.main.querySelectorAll('button')).find(b => b.textContent === '保存').click();
    await flush(5);
    ok(A.log.filter(x => x.method === 'PUT').length === nPut && /长度 1/.test(txt()), '词太短:本地拦下不发');
    // 隐藏作品
    await ui.select('hidden'); await flush(10);
    ok(txt().indexOf(XSS2) >= 0 && txt().indexOf('c:' + XSS) >= 0, '隐藏作品列表当文字');
    Array.from(A.main.querySelectorAll('button')).find(b => b.textContent === '取消隐藏').click();
    await flush(10);
    const hl = A.log.filter(x => x.url.endsWith('/hide')).pop();
    ok(hl && hl.body.wk === 'c:' + XSS && hl.body.on === false, '取消隐藏:POST {wk, on:false}');
    A.main.querySelector('#adm-wk').value = ' c:ABC-123 ';
    dispatch(A.win, A.main.querySelector('form'), new Ev('submit', { bubbles: true }));
    await flush(10);
    const hl2 = A.log.filter(x => x.url.endsWith('/hide')).pop();
    ok(hl2.body.wk === 'c:ABC-123' && hl2.body.on === true, '按作品键隐藏:POST {wk, on:true}');
    // 资源站
    await ui.select('sites'); await flush(10);
    const btns = Array.from(A.main.querySelectorAll('button')).filter(b => ['停用', '撤销停用', '启用'].indexOf(b.textContent) >= 0);
    ok(btns.map(b => b.textContent).join(',') === '停用,撤销停用,启用' && btns[2].disabled, '资源站:启用的给「停用」、后台停用的给「撤销停用」、配置里停用的「启用」灰掉', btns.map(b => b.textContent));
    btns[0].click(); await flush(10);
    const sl = A.log.filter(x => x.url.endsWith('/site')).pop();
    ok(sl && sl.body.key === 'av_s01' && sl.body.active === false, 'POST site {key, active:false}');
    ok(!A.main.querySelectorAll('a').length, '服务器给的地址(含 javascript:)不做成链接');
    // 镜像
    await ui.select('mirrors'); await flush(10);
    Array.from(A.main.querySelectorAll('button')).find(b => b.textContent === '探测').click();
    await flush(10);
    const ml = A.log.filter(x => x.url.endsWith('/mirror/probe')).pop();
    ok(ml && ml.body.key === 'av_s01' && txt().indexOf(XSS2) >= 0 && /探测完成/.test(txt()), '镜像:探测 POST {key},结果当文字');
    ok(HTML_LOG.innerHTML === 0, '整个过程一次 innerHTML 都没用');
    ok(HTML_LOG.created.indexOf('IMG') < 0 && HTML_LOG.created.indexOf('SCRIPT') < 0, '注入的 <img onerror> / <script> 没变成元素', [...new Set(HTML_LOG.created)]);
    ok(A.ls.length === 0, '令牌没写进 localStorage');
    // 401 / 429 / 404 关闭
    const B = adminEnv(() => ({ status: 401, body: { error: 'BAD_TOKEN' } }));
    B.boot();
    await flush(5);
    ok(!!B.main.querySelector('#adm-token') && B.log.length === 0, '没令牌:先给令牌表单,不发请求');
    B.main.querySelector('#adm-token').value = 'wrong';
    dispatch(B.win, B.main.querySelector('form'), new Ev('submit', { bubbles: true }));
    await flush(10);
    ok(/管理令牌不对/.test(B.main.textContent) && B.ss.getItem('dgx_admin_token') === null && B.log[0].token === 'wrong', '401 → 「管理令牌不对」,令牌不留');
    const C = adminEnv(() => ({ status: 429, body: { error: 'LOCKED' } }));
    C.boot();
    C.main.querySelector('#adm-token').value = 'x';
    dispatch(C.win, C.main.querySelector('form'), new Ev('submit', { bubbles: true }));
    await flush(10);
    ok(/失败次数太多/.test(C.main.textContent), '429 → 锁定提示');
    const D = adminEnv(() => ({ status: 404, body: { error: 'NOT_AVAILABLE' } }), { token: 'T' });
    D.boot();
    await flush(10);
    ok(/后台没有开启/.test(D.main.textContent) && !!D.main.querySelector('#adm-token') && D.ss.getItem('dgx_admin_token') === null, '404 NOT_AVAILABLE → 「后台没有开启」回登录、令牌清掉');
    // 登录成功:令牌进 sessionStorage
    const E = adminEnv((k) => evil[k] || { status: 404, body: {} });
    E.boot();
    E.main.querySelector('#adm-token').value = ' good ';
    dispatch(E.win, E.main.querySelector('form'), new Ev('submit', { bubbles: true }));
    await flush(10);
    ok(E.ss.getItem('dgx_admin_token') === 'good' && E.ls.length === 0 && !!E.main.querySelector('[role="tablist"]'), '登录成功:令牌只进 sessionStorage,出页签');
    Array.from(E.main.querySelectorAll('button')).find(b => b.textContent === '退出').click();
    ok(E.ss.getItem('dgx_admin_token') === null && !!E.main.querySelector('#adm-token'), '退出:清令牌回登录');
    // parseWords
    const pw2 = adminApi.parseWords('  甲乙 \n\nABC，abc\n' + 'x'.repeat(41) + '\n丙');
    ok(JSON.stringify(pw2.words) === JSON.stringify(['甲乙', 'ABC']) && pw2.errors.length === 2, 'parseWords:去空白、不分大小写去重、长度 2–40', pw2);
    const many = Array.from({ length: 501 }, (_, i) => 'w' + i).join('\n');
    ok(adminApi.parseWords(many).errors.some(e => /最多 500/.test(e)), 'parseWords:超过 500 个报错');
    ok(adminApi.fmtAgo(0) === '—' && adminApi.fmtAgo(Date.now() - 90e3) === '1 分钟前' && adminApi.toMs(1_700_000_000) === 1_700_000_000_000, '时间格式(秒 / 毫秒都认)');
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
