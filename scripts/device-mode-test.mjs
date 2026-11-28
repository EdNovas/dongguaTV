#!/usr/bin/env node
// 手机版 / 电视版分流回归(离线,把 index.html 页头第一段脚本放进假的浏览器环境里跑):
//   各种设备默认去哪(手机 / 电脑 / iPad / 安卓平板 / 电视浏览器 / 盒子 App / 老盒子)、认不准时弹「手机还是电视」、
//   手动选过(?tv= / 记住的)优先、?tv= 用过从地址栏去掉、电视上用网页版按方向键提示换回电视版、App 里的状态栏 / 顶部安全区
//   node scripts/device-mode-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const GUARD = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('force_tv_mode') && s.includes('new Function'));
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

const UA = {
    phone: 'Mozilla/5.0 (Linux; Android 15; 24129PN74C Build/AQ3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.179 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    tablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    boxWv: 'Mozilla/5.0 (Linux; Android 11; X96 Max Build/RQ3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Safari/537.36',
    t1: 'Mozilla/5.0 (Linux; Android 7.1.2; T1 Build/NHG47L; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/52.0.2743.100 Safari/537.36',
    fireTv: 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/120.4.1 like Chrome/120.0.6099.230 Safari/537.36',
};

// o: { ua, touch, apk, old, search, ls, sess }
function run(o) {
    const store = Object.assign({}, o.ls || {}), sess = Object.assign({}, o.sess || {});
    const lis = { win: {}, doc: {} }, els = {}, nativeCalls = [];
    const r = { written: '', replaced: null, href: null, url: null, store, sess, els, nativeCalls };
    const mkEl = (id, parent) => ({ id, parentNode: parent || null, focus() { doc.activeElement = this; } });
    const scan = (h, parent) => { for (const m of h.matchAll(/id="([^"]+)"/g)) els[m[1]] = mkEl(m[1], parent); };
    const body = {
        kids: [],
        appendChild(el) { this.kids.push(el); el.parentNode = body; },
        removeChild(el) { this.kids = this.kids.filter(x => x !== el); el.parentNode = null; for (const k in els) if (els[k].parentNode === el) delete els[k]; },
    };
    const props = {};
    const doc = {
        activeElement: null, hidden: false, body,
        documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } },
        getElementById: id => els[id] || null,
        addEventListener: (n, f) => { (lis.doc[n] = lis.doc[n] || []).push(f); },
        write: (h) => { r.written += h; scan(h, null); },
        createElement: () => {
            const el = { id: '', parentNode: null };
            Object.defineProperty(el, 'innerHTML', { set(h) { scan(h, el); } });
            return el;
        },
    };
    const loc = {
        pathname: '/', search: o.search || '', hash: '',
        replace: (u) => { r.replaced = u; },
        set href(u) { r.href = u; }, get href() { return 'https://x' + this.pathname + this.search; },
    };
    const win = {
        navigator: { userAgent: o.ua, maxTouchPoints: o.touch ? 5 : 0 },
        location: loc,
        history: { state: null, replaceState: (s, t, u) => { r.url = u; } },
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
        sessionStorage: { getItem: k => (k in sess ? sess[k] : null), setItem: (k, v) => { sess[k] = String(v); } },
        addEventListener: (n, f) => { (lis.win[n] = lis.win[n] || []).push(f); },
        matchMedia: () => ({ addEventListener() { } }),
        setTimeout, clearTimeout, stop() { }, fetch() { },
        document: doc,
    };
    if (o.old) win.Function = function () { throw new SyntaxError('old'); };
    if (o.apk) {
        win.AndroidFullscreen = {};
        if (!o.old) win.Capacitor = { isNativePlatform: () => true, nativePromise: (p, m, a) => { nativeCalls.push(p + '.' + m + ':' + a.style); return Promise.resolve(); } };
    }
    win.window = win;
    vm.createContext(win);
    vm.runInContext(GUARD, win);
    r.sat = props['--dg-sat'];
    r.picker = /id="dg-pick-tv"/.test(r.written);
    r.toTv = !!(r.replaced && r.replaced.indexOf('/tv/') === 0);
    r.nudge = !!(lis.win.keydown && lis.win.keydown.length);
    const ev = (target, keyCode) => ({ target, keyCode, key: '', preventDefault() { this.prevented = true; }, stopPropagation() { }, stopImmediatePropagation() { } });
    r.key = (keyCode, target) => { const e = ev(target || doc.body, keyCode); (lis.win.keydown || []).concat(lis.doc.keydown || []).forEach(f => f(e)); return e; };
    r.click = (id) => { const e = ev(els[id], 0); (lis.doc.click || []).forEach(f => f(e)); return e; };
    r.doc = doc;
    return r;
}

console.log('① 默认去哪');
{
    let r = run({ ua: UA.phone, touch: true });
    ok(!r.toTv && !r.picker && !r.nudge, '安卓手机浏览器 → 网页版,不弹窗、不装遥控器提示', r);
    r = run({ ua: UA.iphone, touch: true });
    ok(!r.toTv && !r.picker, 'iPhone → 网页版');
    r = run({ ua: UA.ipad, touch: true });
    ok(!r.toTv && !r.picker, 'iPad(桌面 UA)→ 网页版');
    r = run({ ua: UA.desktop });
    ok(!r.toTv && !r.picker && !r.nudge, '电脑 → 网页版');
    r = run({ ua: UA.tablet, touch: true });
    ok(!r.toTv && !r.picker && !r.nudge, '安卓平板浏览器(有触屏)→ 网页版');
    r = run({ ua: UA.fireTv });
    ok(r.toTv && r.replaced === '/tv/', 'Fire TV 浏览器 → 电视版', r.replaced);
    r = run({ ua: UA.t1, old: true });
    ok(r.toTv, '老内核大屏安卓(斐讯 T1 浏览器)→ 电视版');
    r = run({ ua: UA.t1, old: true, apk: true, touch: true });
    ok(r.toTv && !r.picker, '老盒子装 App(哪怕报有触屏)→ 电视版,不弹窗(网页版本来就打不开)');
    r = run({ ua: UA.boxWv, apk: true });
    ok(r.toTv && !r.picker, '新盒子装 App、没有触屏 → 电视版');
    r = run({ ua: UA.phone, apk: true, touch: true });
    ok(!r.toTv && !r.picker && r.sat === '0px' && r.nativeCalls[0] === 'SystemBars.setStyle:DARK', '手机装 App → 网页版 + 顶部安全区 0 + 状态栏浅色图标', r);
    ok(!r.nudge, '…手机 App 不装遥控器提示');
}

console.log('② 认不准 → 弹「手机还是电视」');
{
    let r = run({ ua: UA.boxWv, apk: true, touch: true });
    ok(r.picker && !r.replaced, 'App 装在有触屏的非手机上(平板?报触屏的盒子?)→ 弹窗,先不跳', r.replaced);
    ok(/<plaintext/.test(r.written), '…后面的页面用 plaintext 吞掉不解析');
    ok(r.doc.activeElement && r.doc.activeElement.id === 'dg-pick-tv' && r.els['dg-pick-tv'].className === 'dgp on', '…默认停在「电视」上并高亮(遥控器直接按 OK)');
r.doc.activeElement = null; r.key(13);
ok(r.store.force_tv_mode === '1' && r.replaced === '/tv/', '…窗口还没焦点时(activeElement 不对)按 OK 也选高亮的那个', r.replaced);
r = run({ ua: UA.boxWv, apk: true, touch: true });
    r.key(37);
    ok(r.doc.activeElement.id === 'dg-pick-web', '…左键到「手机」');
    r.key(22);
    ok(r.doc.activeElement.id === 'dg-pick-tv', '…DPAD 右(22)回「电视」');
    r.key(23);
    ok(r.store.force_tv_mode === '1' && r.store.dg_device === 'tv' && r.replaced === '/tv/', '…DPAD OK(23)选电视:记住并打开电视版', r);
    r = run({ ua: UA.boxWv, apk: true, touch: true });
    r.click('dg-pick-web');
    ok(r.store.force_tv_mode === '0' && r.store.dg_device === 'web' && r.replaced === '/', '点「手机 / 平板」:记住并重新打开网页版', r);
    r = run({ ua: UA.boxWv });
    ok(r.picker, '浏览器里没有触屏的大屏安卓 → 弹窗');
    r = run({ ua: UA.phone, touch: true, search: '?tv=ask', ls: { force_tv_mode: '1' } });
    ok(r.picker && !('force_tv_mode' in r.store) && r.url === '/', '?tv=ask:清掉记住的选择,再问一次,地址栏去掉参数', r);
    r = run({ ua: UA.t1, old: true, search: '?tv=ask' });
    ok(r.toTv && !r.picker, '?tv=ask 在老内核上直接电视版(网页版打不开)');
}

console.log('③ 手动选过的优先');
{
    let r = run({ ua: UA.phone, touch: true, ls: { force_tv_mode: '1' } });
    ok(r.toTv, '手机上开了 TV 模式 → 电视版');
    r = run({ ua: UA.fireTv, ls: { force_tv_mode: '0' } });
    ok(!r.toTv && !r.picker, '电视上关了 TV 模式 → 网页版');
    r = run({ ua: UA.boxWv, apk: true, touch: true, ls: { force_tv_mode: '0' } });
    ok(!r.picker && !r.toTv, '选过一次就不再弹');
    r = run({ ua: UA.phone, touch: true, ls: { force_tv_mode: '1' }, search: '?tvlogin=ABC' });
    ok(!r.toTv, '手机扫电视登录码打开的页面(?tvlogin=)永远是网页版');
}

console.log('④ ?tv= 用过从地址栏去掉');
{
    let r = run({ ua: UA.phone, touch: true, search: '?tv=0' });
    ok(r.store.force_tv_mode === '0' && r.url === '/', '?tv=0:记住,地址栏变回 /(以后在设置里开 TV 模式、刷新不会被它又关掉)', r);
    r = run({ ua: UA.phone, touch: true, search: '?a=1&tv=1&b=2' });
    ok(r.store.force_tv_mode === '1' && r.url === '/?a=1&b=2' && r.replaced === '/tv/?a=1&b=2', '?tv=1 夹在中间:去掉它,别的参数原样带去电视版', r);
    r = run({ ua: UA.phone, touch: true, search: '?play=x&tv=0' });
    ok(r.url === '/?play=x', '?tv=0 在末尾', r.url);
    r = run({ ua: UA.phone, touch: true, search: '?play=x' });
    ok(r.url === null, '没有 ?tv= 不动地址栏');
}

console.log('⑤ 电视上用网页版:按方向键提示换回电视版');
{
    let r = run({ ua: UA.boxWv, apk: true, ls: { force_tv_mode: '0' } });
    ok(r.nudge, '盒子 App 关了 TV 模式 → 装上遥控器提示');
    let e = r.key(65);
    ok(!r.els['dg-nudge-tv'] && !e.prevented, '…普通字母键不弹');
    e = r.key(39, { tagName: 'INPUT' });
    ok(!r.els['dg-nudge-tv'], '…在输入框里按方向键不弹');
    e = r.key(40);
    ok(r.els['dg-nudge-tv'] && r.doc.activeElement.id === 'dg-nudge-tv' && e.prevented, '…第一次按方向键弹出,停在「换成电视版」,这一下不传给页面', r.doc.activeElement);
    r.key(39);
    ok(r.doc.activeElement.id === 'dg-nudge-no', '…右键到「留在网页版」');
    r.key(13);
    ok(!r.els['dg-nudge-tv'] && r.sess.dg_tv_nudge === 'off' && r.store.force_tv_mode === '0' && r.href === null, '…选留在网页版:关掉,这次打开不再问', r.sess);
    r.key(40);
    ok(!r.els['dg-nudge-tv'], '…之后再按方向键不弹');
    r = run({ ua: UA.boxWv, apk: true, ls: { force_tv_mode: '0' } });
    r.key(23); r.key(23);
    ok(r.store.force_tv_mode === '1' && r.href === '/tv/', 'OK 键弹出、再按 OK 换成电视版(记住)', r);
    r = run({ ua: UA.fireTv, ls: { force_tv_mode: '0' } });
    r.key(38);
    r.click('dg-nudge-tv');
    ok(r.href === '/tv/', '电视浏览器关了 TV 模式:点「换成电视版」也行');
    r = run({ ua: UA.boxWv, apk: true, ls: { force_tv_mode: '0' }, sess: { dg_tv_nudge: 'off' } });
    r.key(40);
    ok(!r.els['dg-nudge-tv'], '这次打开已经说过「留在网页版」→ 不弹');
    r = run({ ua: UA.boxWv, apk: true, touch: true, ls: { force_tv_mode: '0', dg_device: 'web' } });
    ok(!r.nudge, '弹窗里说过是「手机 / 平板」的 → 不装遥控器提示');
    r = run({ ua: UA.desktop, ls: { force_tv_mode: '0', dg_device: 'tv' } });
    ok(r.nudge, '弹窗里说过是「电视」的(UA 认不出来)→ 用网页版时也提示');
    r = run({ ua: UA.tablet, touch: true, ls: { force_tv_mode: '0' } });
    ok(!r.nudge, '有触屏的安卓平板 → 不装');
}

console.log('⑥ 页面里的开关');
{
    ok(/if \(newMode\) window\.location\.href = '\/tv\/';/.test(HTML), '设置里开「TV 模式」直接去 /tv/');
    const core = fs.readFileSync(path.join(ROOT, 'public/tv/core.js'), 'utf8');
    ok(/TV\.leaveTV = function/.test(core) && /location\.href = '\/\?tv=0'/.test(core), '电视版「关闭 TV 模式」→ /?tv=0');
    const mine = fs.readFileSync(path.join(ROOT, 'public/tv/mine.js'), 'utf8');
    ok(/关闭 TV 模式/.test(mine) && /TV\.leaveTV\(\)/.test(mine), '「我的」里有「关闭 TV 模式」');
    const home = fs.readFileSync(path.join(ROOT, 'public/tv/home.js'), 'utf8');
    ok(/hm-web/.test(home) && /TV\.leaveTV\(\)/.test(home), '手机上电视版顶栏有「手机版」');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
