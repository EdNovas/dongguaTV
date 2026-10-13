#!/usr/bin/env node
// 扫码登录(电视出二维码,已登录的手机扫码确认后电视自动登录)回归(④ 在本机起真服务器,其余离线):
//   node scripts/qr-login-test.mjs
//  ① lib/qr-login 状态机(假时钟):code / secret 格式、扫码 → 确认 → 电视取走(只能取一次)、取消、5 分钟过期、
//     secret 不对 / 格式怪一律只说"过期"、确认了没人取也会清掉、全站上限、随机数撞车不死循环
//  ② lib/qr-login 路由(进程内 express):各接口回包;凭据不合格不收(请求还开着);限流按 LIMITS 挂上;站点没开 → 404
//  ③ server.js 接线:qrLoginAuth 只收配置里的访问密码(动态令牌 / 封禁 / 格式不对 / 别的登录方式都不收);
//     /api/auth/check 报 qrLogin;Vercel 那份(api/index.js)没有
//  ④ 真服务器端到端:电视建码 → 手机扫码 → 手机确认 → 电视取到凭据 → 用它过 /api/auth/verify;凭据不进日志;建码限流;没配密码的站不开
//  ⑤ 登录门(电视这一侧)在沙箱里真跑:输密码 / 扫码两种方式的切换、电视上默认出二维码、二维码内容、轮询各状态、
//     拿到凭据后过 /api/auth/verify 再登录(核实不过不登录)、过期自动换新最多 3 次、停掉后晚到的回包不生效
//  ⑥ 手机这一侧(Vue 方法)在沙箱里真跑:读码核对设备、交出密码哈希、失败提示、取消时告诉电视、不重复提交
//  ⑦ 模板 / 样式接线
// 改登录门、/api/auth/*、lib/qr-login 后必跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const DAY = 86400e3, NOW0 = 1.8e12;

const { createQrLogin, LIMITS } = require(path.join(ROOT, 'lib/qr-login/index.js'));

console.log('① 状态机');
{
    let t = NOW0;
    const Q = createQrLogin({ now: () => t });
    const a = Q.create('Mozilla/5.0 (Linux; Android 9; AFTMM) ' + 'x'.repeat(400));
    ok(!!a && /^[A-Za-z0-9_-]{16}$/.test(a.code) && /^[A-Za-z0-9_-]{22}$/.test(a.secret) && a.ttl === 300, '建码:code 16 位、secret 22 位(base64url),5 分钟', a);
    ok(Q.poll(a.code, a.secret).status === 'pending', '没人扫:pending');
    ok(['', 'x', a.secret.slice(1), a.secret + 'x', 'é'.repeat(22), undefined, 123].every(s => Q.poll(a.code, s).status === 'expired'),
        'secret 不对(长度不同、非 ASCII、不是字符串)一律只说过期,不报错');
    const s = Q.scan(a.code);
    ok(!!s && s.ua.length === 300 && s.ua.startsWith('Mozilla'), '扫码:拿到设备 UA(截到 300 字)');
    ok(Q.poll(a.code, a.secret).status === 'scanned', '电视看到"已扫码"');
    ok(Q.approve(a.code, null) === false, '没有凭据不算确认');
    ok(Q.approve(a.code, { type: 'password', hash: 'h' }) === true && Q.approve(a.code, { type: 'password', hash: 'h2' }) === false, '确认一次;再确认不行');
    ok(Q.scan(a.code) === null && Q.deny(a.code) === false, '确认过的码不能再扫、再取消');
    ok(Q.poll(a.code, 'w'.repeat(22)).status === 'expired', '确认之后 secret 不对照样取不走');
    const p = Q.poll(a.code, a.secret);
    ok(p.status === 'approved' && p.auth.hash === 'h', '电视取到凭据', p);
    ok(Q.poll(a.code, a.secret).status === 'expired' && Q.size() === 0, '只能取一次,取走即删');

    const b = Q.create('UA');
    ok(Q.deny(b.code) === true && Q.approve(b.code, { x: 1 }) === false, '取消后不能再确认');
    ok(Q.poll(b.code, b.secret).status === 'denied' && Q.poll(b.code, b.secret).status === 'expired', '电视知道"取消了"(只说一次)');

    const c = Q.create('UA');
    t += 300e3 + 1;
    ok(Q.scan(c.code) === null && Q.approve(c.code, { a: 1 }) === false && Q.poll(c.code, c.secret).status === 'expired' && Q.size() === 0,
        '5 分钟过期:扫不了、确认不了,电视换新码');
    const d = Q.create('UA');
    Q.approve(d.code, { secret: 1 });
    t += 300e3 + 1;
    Q.sweep();
    ok(Q.size() === 0, '确认了但电视一直没来取:过期就清掉(凭据不一直留在内存里)');
    ok(['__proto__', 'constructor', '', 'x'.repeat(17), null, {}].every(k => Q.scan(k) === null && Q.poll(k, 'x').status === 'expired'), 'code 格式不对直接当不存在');
}
{
    let t = 0;
    const Q = createQrLogin({ now: () => t, opts: { max: 3 } });
    ok([Q.create(), Q.create(), Q.create()].every(Boolean) && Q.create() === null, '全站同时最多挂 max 个,满了不建');
    t += 300e3 + 1;
    ok(!!Q.create() && Q.size() === 1, '建码前先清掉过期的');
    const Q2 = createQrLogin({ randomBytes: n => Buffer.alloc(n, 7) });
    ok(!!Q2.create() && Q2.create() === null, '随机数撞车:换 5 次还撞就放弃,不死循环');
}

console.log('② 路由');
{
    const express = require('express');
    const bodyParser = require('body-parser');
    let on = true;
    const limits = [];
    const Q = createQrLogin({
        enabled: () => on,
        checkAuth: a => (a && a.good ? { type: 'password', hash: 'H' } : null),
        limiter: max => { limits.push(max); return (req, res, next) => next(); },
    });
    const app = express();
    app.use(bodyParser.json());
    Q.registerRoutes(app);
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/api/auth/qr/`;
    const post = async (p, body, headers) => {
        const r = await fetch(base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body || {}) });
        return { status: r.status, cc: r.headers.get('cache-control') || '', j: await r.json() };
    };
    try {
        ok(JSON.stringify(limits) === JSON.stringify([LIMITS.new, LIMITS.scan, LIMITS.approve, LIMITS.deny, LIMITS.poll]), '五个接口都挂了限流', limits);
        let r = await post('new', {}, { 'user-agent': 'TestTV/1.0 (Android TV)' });
        ok(r.status === 200 && r.j.ok === true && !!r.j.code && !!r.j.secret && r.j.ttl === 300 && /no-store/.test(r.cc), '建码(不缓存)', r);
        const { code, secret } = r.j;
        r = await post('scan', { code });
        ok(r.j.ok === true && r.j.ua === 'TestTV/1.0 (Android TV)' && !('secret' in r.j), '扫码回设备 UA(不回 secret)', r.j);
        r = await post('scan', { code: 'A'.repeat(16) });
        ok(r.j.ok === false && r.j.expired === true, '不存在的码:过期');
        r = await post('approve', { code, auth: { good: false } });
        ok(r.j.ok === false && r.j.invalid === true, '凭据不合格:不收', r.j);
        r = await post('poll', { code, secret });
        ok(r.j.status === 'scanned' && /no-store/.test(r.cc), '…请求还开着(手机重新登录后能再确认)', r.j);
        r = await post('approve', { code, auth: { good: true, junk: 'x' } });
        ok(r.j.ok === true, '合格的凭据:收下');
        r = await post('approve', { code, auth: { good: true } });
        ok(r.j.ok === false && r.j.expired === true, '再确认一次:已经用过了');
        r = await post('poll', { code, secret });
        ok(r.j.status === 'approved' && JSON.stringify(r.j.auth) === JSON.stringify({ type: 'password', hash: 'H' }), '电视取到的是校验后规范化的凭据,不是手机原样交的', r.j);
        r = await post('new');
        const d2 = r.j;
        ok((await post('deny', { code: d2.code })).j.ok === true && (await post('poll', d2)).j.status === 'denied', '取消');
        ok((await post('poll', { code: 'not-a-code', secret: 'x' })).j.status === 'expired' && (await post('poll')).j.status === 'expired', '乱传参数 / 不传参数:过期');
        on = false;
        r = await post('new');
        ok(r.status === 404 && r.j.ok === false && (await post('poll', d2)).status === 404, '站点没开(没配访问密码)→ 全部 404');
    } finally { await new Promise(res => srv.close(res)); }
}

console.log('③ server.js 接线');
const SJ = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('\r\n').join('\n');
{
    const m = /function qrLoginAuth\(a\) \{[\s\S]*?\n\}/.exec(SJ);
    ok(!!m, 'server.js 有 qrLoginAuth');
    const MAP = Object.create(null);
    MAP[sha('main')] = { index: 0 }; MAP[sha('alice')] = { index: 1 }; MAP[sha('banned')] = { index: 2 }; MAP[sha('dyn')] = { index: -1 };
    const tokLike = 'tok_' + sha('a@b.c');
    MAP[tokLike] = { index: -1 };
    const auth = vm.runInNewContext((m ? m[0] : 'function qrLoginAuth(){return null}') + '\n;qrLoginAuth;', { PASSWORD_HASH_MAP: MAP, isBanned: t => t === sha('banned') });
    ok(JSON.stringify(auth({ type: 'password', hash: sha('alice'), extra: 1 })) === JSON.stringify({ type: 'password', hash: sha('alice') }), '独立密码:配置里的照收(多余字段丢掉)');
    ok(auth({ type: 'password', hash: sha('main') }) !== null, '主密码也行');
    ok([sha('dyn'), sha('banned'), sha('nope'), sha('alice').toUpperCase(), tokLike, 'x', '', null].every(h => auth({ type: 'password', hash: h }) === null),
        '动态令牌(不是配置里的密码)、被封禁的、不存在的、大写、非哈希令牌、格式不对:都不收');
    ok(auth({ type: 'token', token: 'tok-123456', email: 'a@b.c' }) === null, '不是访问密码的凭据:不收');
    ok([null, 1, 'str', {}, { type: 'admin' }].every(x => auth(x) === null), '其它类型都不收');
    ok(/qrLogin = require\('\.\/lib\/qr-login'\)\.createQrLogin\(\{\s*enabled: \(\) => ACCESS_PASSWORDS\.length > 0,\s*checkAuth: qrLoginAuth,\s*limiter: \(max\) => rateLimit\(\{ windowMs: 60 \* 1000, max, keyGenerator: ipKey/.test(SJ)
        && /qrLogin\.registerRoutes\(app\);/.test(SJ), '只在配了访问密码时开;按真实 IP 限流');
    ok(/qrLogin: !!qrLogin && ACCESS_PASSWORDS\.length > 0/.test(SJ), '/api/auth/check 报 qrLogin(模块加载失败也报 false)');
    ok(SJ.indexOf("require('./lib/qr-login')") < SJ.indexOf("app.get('/api/auth/check'"), '在 /api/auth/check 之前接好');
    const AJ = fs.readFileSync(path.join(ROOT, 'api/index.js'), 'utf8');
    ok(!/qr-login|\/api\/auth\/qr|qrLogin/.test(AJ), 'Vercel 那份没有(前端读不到 qrLogin 就不出二维码)');
}

console.log('④ 真服务器端到端');
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-qr-'));
    fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
    fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
    for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));
    fs.writeFileSync(path.join(tmp, 'db.json'), JSON.stringify({ sites: [] }));
    const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
    const start = async (env) => {
        const port = 20000 + Math.floor(Math.random() * 20000);
        const srv = spawn(process.execPath, ['server.js'], {
            cwd: tmp,
            env: Object.assign({}, process.env, {
                NODE_PATH, PORT: String(port), CACHE_TYPE: 'memory', ACCESS_PASSWORD: '', ADMIN_TOKEN: '', LIVE_TV_DISABLED: '1', KAZUMI_DISABLE: '1',
                CORS_PROXY_URL: '', REMOTE_DB_URL: '', TMDB_API_KEY: '', DANMU_API_URL: '', STATS_DISABLE: '1', SITE_URL: '', FAV_CHECK_DISABLE: '1',
                VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: ''
            }, env),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        srv.stdout.on('data', d => { log += d; });
        srv.stderr.on('data', d => { log += d; });
        for (let i = 0; i < 150; i++) {
            await sleep(100);
            try { const r = await fetch(`http://127.0.0.1:${port}/api/auth/check`); if (r.ok) return { srv, base: `http://127.0.0.1:${port}`, log: () => log }; } catch (e) { }
        }
        srv.kill();
        throw new Error('server did not start:\n' + log.slice(-1500));
    };
    const stop = async (S) => { const p = new Promise(r => S.srv.once('exit', r)); S.srv.kill(); await p; };
    const TV_UA = 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 Chrome/120 Safari/537.36';
    let S = await start({ ACCESS_PASSWORD: 'mainpw,alice' });
    try {
        const J = async (p, body) => {
            const r = await fetch(S.base + p, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': TV_UA }, body: JSON.stringify(body) });
            return r.json();
        };
        const chk = await J('/api/auth/check');
        ok(chk.qrLogin === true && chk.requirePassword === true, '配了访问密码:/api/auth/check 报 qrLogin', chk);
        const n = await J('/api/auth/qr/new', {});
        ok(n.ok === true && !!n.code && !!n.secret, '电视建码', n);
        const sc = await J('/api/auth/qr/scan', { code: n.code });
        ok(sc.ok === true && /AFTMM/.test(sc.ua), '手机扫码看到是哪台设备', sc);
        ok((await J('/api/auth/qr/approve', { code: n.code, auth: { type: 'password', hash: sha('nope') } })).invalid === true, '不是本站的密码:不收');
        ok((await J('/api/auth/qr/approve', { code: n.code, auth: { type: 'password', hash: sha('alice') } })).ok === true, '手机确认(独立密码 alice)');
        const p = await J('/api/auth/qr/poll', { code: n.code, secret: n.secret });
        ok(p.status === 'approved' && p.auth.type === 'password' && p.auth.hash === sha('alice'), '电视取到凭据', p);
        const v = await J('/api/auth/verify', { passwordHash: p.auth.hash });
        ok(v.success === true && v.syncEnabled === true, '电视拿它过原来的校验接口:就是 alice(独立用户,能同步)', v);
        ok((await J('/api/auth/qr/poll', { code: n.code, secret: n.secret })).status === 'expired', '再取:没了');
        const n2 = await J('/api/auth/qr/new', {});
        ok((await J('/api/auth/qr/approve', { code: n2.code, auth: { type: 'token', token: 'panel-token-123', email: 'a@b.c' } })).invalid === true, '不是访问密码的凭据:不收');
        ok((await J('/api/auth/qr/poll', { code: n2.code, secret: n2.secret })).status === 'pending', '…电视那边还在等(没确认)');
        ok(!S.log().includes(sha('alice')), '凭据不进服务器日志');
        let limited = false;
        for (let i = 0; i < 10 && !limited; i++) {
            const r = await fetch(S.base + '/api/auth/qr/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            limited = r.status === 429;
        }
        ok(limited, '同一 IP 每分钟建码超过 10 次 → 429');
    } finally { await stop(S); }
    S = await start({ ACCESS_PASSWORD: '' });
    try {
        const chk = await (await fetch(S.base + '/api/auth/check')).json();
        const r = await fetch(S.base + '/api/auth/qr/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        ok(chk.qrLogin === false && r.status === 404, '没配访问密码(没有登录墙):不开扫码登录', chk);
    } finally { await stop(S); }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
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

console.log('⑤ 电视这一侧(登录门)');
const AUTH = scripts.find(s => s.includes('async function checkAuthStatus'));
class FakeEl {
    constructor(id) { this.id = id; this.style = {}; this.cls = new Set(id === 'password-screen' ? ['hidden'] : []); this.attrs = {}; this.textContent = ''; }
    get classList() {
        const c = this.cls;
        return { add: x => c.add(x), remove: x => c.delete(x), contains: x => c.has(x), toggle: (x, on) => { if (on === undefined ? !c.has(x) : on) c.add(x); else c.delete(x); } };
    }
    set src(v) { this.attrs.src = String(v); }
    get src() { return this.attrs.src || ''; }
    removeAttribute(k) { delete this.attrs[k]; }
    focus() { }
}
const CODE = 'Ab_-'.repeat(4), SECRET = 'S'.repeat(22), HASH = sha('alice');
function tvEnv(o) {
    o = o || {};
    const clock = { now: NOW0 };
    class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
    const timers = []; let tid = 0;
    const els = new Map();
    const el = id => { if (!els.has(id)) els.set(id, new FakeEl(id)); return els.get(id); };
    const ls = mkStore();
    if (o.tv) ls.setItem('force_tv_mode', '1');
    const calls = [], routes = {};
    const doc = { getElementById: el, hidden: false, head: { appendChild() { } }, createElement: () => ({}), addEventListener() { }, body: { classList: { add() { }, remove() { } }, appendChild() { } } };
    const obj = {
        console: { log() { }, warn() { }, error() { } }, Date: FakeDate, JSON, Math, Number, String, Object, Array, Promise, URLSearchParams, Error, RegExp,
        parseInt, parseFloat, isNaN, isFinite,
        localStorage: ls, sessionStorage: mkStore(),
        location: { search: o.search || '', origin: 'https://tv.example', pathname: '/', reload() { calls.push('reload'); } },
        navigator: { userAgent: o.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
        document: doc,
        setTimeout: (fn, ms) => { timers.push({ id: ++tid, fn, ms: ms || 0, at: clock.now + (ms || 0), live: true }); return tid; },
        clearTimeout: (id) => { const t = timers.find(x => x.id === id); if (t) t.live = false; },
        setInterval: () => 0, clearInterval() { }, alert() { },
        qrcode: () => ({ data: '', addData(d) { this.data = d; }, make() { }, createDataURL() { return 'data:QR(' + this.data + ')'; } }),
        fetchT: (url, opts) => {
            const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
            calls.push({ url, body });
            const h = routes[url];
            return Promise.resolve(h ? h(body) : { __status: 404, body: {} }).then(r => {
                const status = (r && r.__status) || 200;
                const b = r && r.__status ? r.body : r;
                return { status, ok: status < 400, json: async () => b };
            });
        },
        startApp: async () => { calls.push('startApp'); },
        Capacitor: o.native ? { isNativePlatform: () => true } : undefined,
    };
    const ctx = sandbox(obj);
    vm.runInNewContext(AUTH + '\n;globalThis.__qr = { set: v => { QR_LOGIN = v; }, get: () => QR_LOGIN, qrl };', ctx, { timeout: 5000 });
    const polls = () => timers.filter(t => t.live && t.ms === 2000).length;
    const advance = async (ms) => {
        const end = clock.now + ms;
        for (;;) {
            const due = timers.filter(t => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            clock.now = Math.max(clock.now, due.at);
            due.live = false;
            due.fn();
            await flush();
        }
        clock.now = end;
        await flush();
    };
    return {
        o: obj, el, ls, calls, routes, clock, doc, polls, advance,
        vis: id => el(id).style.display !== undefined && el(id).style.display !== 'none',
        tip: () => el('qr-login-tip').textContent, tipErr: () => el('qr-login-tip').cls.has('err'),
        n: url => calls.filter(c => c.url === url).length,
    };
}
const newOk = () => ({ ok: true, code: CODE, secret: SECRET, ttl: 300 });
{
    const E = tvEnv();
    E.o.__qr.set(false);
    E.o.switchLoginMode('qr');
    ok(!E.vis('qr-login') && E.vis('password-form') && !E.vis('switch-to-qr') && !E.vis('switch-to-password'), '本站没开扫码登录:要 qr 也退回密码框,两个切换入口都不出');
    E.o.__qr.set(true);
    E.o.switchLoginMode('password');
    ok(E.vis('password-form') && !E.vis('qr-login') && E.vis('switch-to-qr') && !E.vis('switch-to-password'), '电脑上的密码框:多一个"手机扫码登录"入口');
    ok(E.n('/api/auth/qr/new') === 0, '没切到扫码就不建码');
    E.o.switchLoginMode('qr');
    ok(E.vis('qr-login') && !E.vis('password-form') && E.vis('switch-to-password') && !E.vis('switch-to-qr'), '切到扫码:出二维码,下面给"使用密码登录"');
}
{
    const E = tvEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' });
    E.o.__qr.set(true);
    E.o.switchLoginMode('password');
    ok(!E.vis('switch-to-qr'), '手机上不给"手机扫码登录"(本来就是手机)');
}
for (const [o, want, msg] of [[{ tv: true }, 'qr', '记住的 TV 模式'], [{ search: '?tv=1' }, 'qr', '?tv=1'], [{ native: true }, 'qr', '原生 App'],
    [{ ua: 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit Chrome Safari SmartTV' }, 'qr', '电视浏览器 UA'],
    [{}, 'password', '电脑'], [{ tv: true, search: '?tv=0' }, 'password', '?tv=0 关掉'], [{ tv: true, off: true }, 'password', '电视但本站没开扫码']]) {
    const E = tvEnv(o);
    E.o.__qr.set(!o.off);
    ok(E.o.loginDefaultMode() === want, '登录框默认方式:' + msg + ' → ' + want);
}
{
    // 电视上打开登录框 → 出二维码 → 轮询 → 手机确认(独立密码)→ 核实后登录
    const E = tvEnv({ tv: true });
    E.o.__qr.set(true);
    E.routes['/api/auth/qr/new'] = newOk;
    E.o.showLoginScreen();
    await flush();
    ok(E.vis('qr-login') && !E.vis('password-form') && E.vis('switch-to-password') && !E.vis('switch-to-qr'), '电视上打开登录框:直接出二维码,下面给"使用密码登录"');
    ok(E.el('qr-login-img').attrs.src === 'data:QR(https://tv.example/?tvlogin=' + CODE + ')', '二维码内容 = 本站/?tvlogin=<code>(不含 secret)', E.el('qr-login-img').attrs);
    ok(/用已登录的手机扫码/.test(E.tip()) && !E.tipErr() && !E.vis('qr-login-again') && E.polls() === 1, '提示扫码,2 秒后开始轮询');
    E.routes['/api/auth/qr/poll'] = b => (b.code === CODE && b.secret === SECRET ? { status: 'pending' } : { status: 'expired' });
    await E.advance(2000);
    ok(E.n('/api/auth/qr/poll') === 1 && E.polls() === 1, '轮询带 code + secret;没人扫就接着等');
    E.routes['/api/auth/qr/poll'] = () => ({ status: 'scanned' });
    await E.advance(2000);
    ok(/已扫码/.test(E.tip()) && E.polls() === 1, '已扫码 → 提示在手机上确认');
    E.routes['/api/auth/qr/poll'] = () => ({ status: 'approved', auth: { type: 'password', hash: HASH } });
    E.routes['/api/auth/verify'] = b => (b.passwordHash === HASH ? { success: true, passwordHash: HASH } : { success: false });
    await E.advance(2000);
    ok(E.ls.getItem('emax_auth_hash') === HASH, '过 /api/auth/verify 之后存成本机登录');
    ok(Math.abs(Number(E.ls.getItem('emax_auth_expiry')) - (E.clock.now + 365 * DAY)) < 10e3, '…记住 1 年(电视是自己的设备)');
    ok(E.calls.includes('startApp') && E.el('password-screen').cls.has('hidden') && E.polls() === 0, '进站、收起登录框、停止轮询');
}
{
    const E = tvEnv({ tv: true });
    E.o.__qr.set(true);
    E.routes['/api/auth/qr/new'] = newOk;
    E.o.showLoginScreen();
    await flush();
    E.routes['/api/auth/qr/poll'] = () => ({ status: 'approved', auth: { type: 'password', hash: HASH } });
    E.routes['/api/auth/verify'] = () => ({ success: false });
    await E.advance(2000);
    ok(/密码已经失效/.test(E.tip()) && E.tipErr() && E.vis('qr-login-again') && !E.ls.getItem('emax_auth_hash') && !E.calls.includes('startApp'), '独立密码核实不过:不登录,提示 + 可重新生成');
}
{
    // 只认访问密码:拿到别的凭据(服务器不会给,防万一)就不登录
    const E = tvEnv({ tv: true });
    E.o.__qr.set(true);
    E.routes['/api/auth/qr/new'] = newOk;
    E.o.showLoginScreen();
    await flush();
    E.routes['/api/auth/qr/poll'] = () => ({ status: 'approved', auth: { type: 'token', token: 'panel-tok' } });
    await E.advance(2000);
    ok(/登录信息不完整/.test(E.tip()) && E.tipErr() && !E.ls.getItem('emax_auth_hash') && !E.calls.includes('startApp') && E.n('/api/auth/verify') === 0,
        '拿到的不是访问密码的凭据:不登录,提示重新扫码');
}
{
    const E = tvEnv({ tv: true });
    E.o.__qr.set(true);
    E.routes['/api/auth/qr/new'] = newOk;
    E.o.showLoginScreen();
    await flush();
    E.routes['/api/auth/qr/poll'] = () => ({ status: 'denied' });
    await E.advance(2000);
    ok(E.tip() === '已在手机上取消' && E.tipErr() && E.vis('qr-login-again') && E.polls() === 0, '手机上取消:电视提示并停止轮询,可重新生成');
    E.o.qrLoginStart(true);
    await flush();
    ok(E.n('/api/auth/qr/new') === 2 && E.polls() === 1 && !E.vis('qr-login-again'), '点"重新生成"→ 新码、重新轮询');
}
{
    // 过期:自动换新最多 3 次,之后停下等点
    const E = tvEnv({ tv: true });
    E.o.__qr.set(true);
    E.routes['/api/auth/qr/new'] = newOk;
    E.routes['/api/auth/qr/poll'] = () => ({ status: 'expired' });
    E.o.showLoginScreen();
    await flush();
    for (let i = 0; i < 4; i++) await E.advance(2000);
    ok(E.n('/api/auth/qr/new') === 4 && E.tip() === '二维码已过期' && E.vis('qr-login-again') && E.polls() === 0, '服务器说过期:自动换新 3 次,第 4 次停下等点(没人看的电视不一直轮询)', E.n('/api/auth/qr/new'));
    E.o.qrLoginStart(true);
    await flush();
    await E.advance(2000);
    ok(E.n('/api/auth/qr/new') === 6, '点了"重新生成"又能自动换新(计数清零)', E.n('/api/auth/qr/new'));
}
{
    const E = tvEnv({ tv: true });
    E.o.__qr.set(true);
    E.routes['/api/auth/qr/new'] = newOk;
    E.routes['/api/auth/qr/poll'] = () => ({ status: 'pending' });
    E.o.showLoginScreen();
    await flush();
    await E.advance(300e3 + 2000);
    ok(E.n('/api/auth/qr/new') === 2, '本地也按 ttl 算过期:到点不再问服务器,直接换新码');
    E.doc.hidden = true;
    const before = E.n('/api/auth/qr/poll');
    await E.advance(6000);
    ok(E.n('/api/auth/qr/poll') === before && E.polls() === 1, '页面在后台:不发轮询,只排着');
    E.doc.hidden = false;
    E.o.hideLoginScreen();
    await E.advance(4000);
    ok(E.n('/api/auth/qr/poll') === before && E.polls() === 0, '登录框收起:停止轮询');
}
{
    // 停掉之后,还在路上的建码回包不能再画二维码、开轮询
    const E = tvEnv({ tv: true });
    E.o.__qr.set(true);
    let release;
    E.routes['/api/auth/qr/new'] = () => new Promise(r => { release = () => r(newOk()); });
    E.o.showLoginScreen();
    await flush();
    E.o.switchLoginMode('password');
    release();
    await flush();
    ok(!E.el('qr-login-img').attrs.src && E.polls() === 0 && E.vis('password-form'), '切走以后晚到的建码回包不生效');
    let releasePoll;
    E.routes['/api/auth/qr/new'] = newOk;
    E.routes['/api/auth/qr/poll'] = () => new Promise(r => { releasePoll = () => r({ status: 'approved', auth: { type: 'password', hash: HASH } }); });
    E.routes['/api/auth/verify'] = () => ({ success: true, passwordHash: HASH });
    E.o.switchLoginMode('qr');
    await flush();
    await E.advance(2000);
    E.o.dismissDeepLinkLogin();
    releasePoll();
    await flush();
    ok(!E.ls.getItem('emax_auth_hash') && !E.calls.includes('startApp'), '关掉登录浮层以后晚到的"已确认"不会把电视登进去');
}
{
    const E = tvEnv({ search: '?tvlogin=' + CODE });
    E.o.__qr.set(true);
    E.o.showLoginScreen();
    ok(E.el('login-subtitle-text').textContent === '先登录，再确认让电视登录' && E.vis('password-form'), '手机扫码打开、但这台手机没登录:先登录,副标题说明为什么');
    const F = tvEnv();
    F.o.showLoginScreen();
    ok(F.el('login-subtitle-text').textContent === '需要密码才能访问', '平常打开:副标题照旧');
    const G = tvEnv({ tv: true });
    G.o.__qr.set(true);
    G.routes['/api/auth/qr/new'] = newOk;
    G.o.showLoginForDeepLink();
    await flush();
    ok(G.vis('qr-login') && G.n('/api/auth/qr/new') === 1, '电视上从分享链接唤起登录浮层:也直接出二维码');
}

console.log('⑥ 手机这一侧(Vue)');
const SRC = scripts.find(s => s.includes('createApp({'));
let captured = null;
const pstore = mkStore(), hist = [], posts = [], proutes = {};
const ploc = { href: 'https://site.example/', search: '', pathname: '/', hash: '', origin: 'https://site.example' };
const setUrl = (u) => { const x = new URL(u); ploc.href = x.href; ploc.search = x.search; ploc.pathname = x.pathname; ploc.hash = x.hash; };
const pctx = {
    Vue: { createApp(o) { captured = o; return { mount() { return {}; }, use() { return this; }, config: {} }; } },
    console: { log() { }, warn() { }, error() { }, info() { } },
    localStorage: pstore, sessionStorage: mkStore(), location: ploc,
    history: { state: null, replaceState(s, t, u) { hist.push(String(u)); setUrl(new URL(String(u), ploc.href).href); } },
    setTimeout: () => 0, clearTimeout() { }, setInterval: () => 0, clearInterval() { }, requestAnimationFrame: () => 0,
    document: { addEventListener() { }, getElementById: () => null, querySelector: () => null, body: { classList: { add() { }, remove() { }, contains: () => false } } },
    addEventListener() { },
    fetch: (url, opts) => {
        let body;
        try { body = opts && opts.body ? JSON.parse(opts.body) : undefined; } catch (e) { body = opts.body; }
        posts.push({ url, body });
        const h = proutes[url];
        return Promise.resolve(h ? h(body) : { __status: 404, body: {} }).then(r => {
            if (r === 'NETWORK') throw new TypeError('Failed to fetch');
            const status = (r && r.__status) || 200;
            const b = r && r.__status ? r.body : r;
            return { status, ok: status < 400, json: async () => b };
        });
    },
    AUTH_STORAGE_KEY: 'emax_auth_hash',
    detectTVMode: () => false,
    Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet, Symbol, Error, TypeError,
    URL, URLSearchParams, Uint8Array, ArrayBuffer, Proxy, Reflect, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, AbortController, TextEncoder, TextDecoder,
    scrollY: 0, innerHeight: 800, scrollTo() { },
};
try { vm.runInNewContext(SRC, sandbox(pctx), { timeout: 5000 }); } catch (e) { }
const PM = (captured && captured.methods) || {};
const pnames = ['_tvLoginOpen', 'tvLoginApprove', 'tvLoginCancel', '_tvLoginAuth', '_tvLoginFail', '_tvLoginPost', '_tvDeviceLabel', 'handleDeepLink'];
ok(!!captured && pnames.every(n => typeof PM[n] === 'function'), '沙箱里跑出了手机这一侧的方法', pnames.filter(n => typeof PM[n] !== 'function'));
const PD = (captured && typeof captured.data === 'function') ? captured.data.call(new Proxy({}, { get: () => any() })) : {};
ok(PD.tvLogin && PD.tvLogin.show === false && PD.isTVMode === false, 'data:tvLogin 默认关着;isTVMode 用 detectTVMode()', PD.tvLogin);
const phoneApp = () => {
    const app = { tvLogin: { show: false, state: '', code: '', device: '', msg: '' } };
    for (const n of Object.keys(PM)) if (typeof PM[n] === 'function') app[n] = PM[n].bind(app);
    return app;
};
const lastPost = (u) => posts.filter(p => p.url === u).at(-1);
{
    setUrl('https://site.example/?tvlogin=bad&x=1');
    let a = phoneApp();
    a._tvLoginOpen('bad');
    ok(!a.tvLogin.show && hist.at(-1) === '/?x=1', '码的格式不对:不弹;地址栏去掉 tvlogin(别的参数留着)', hist.at(-1));

    setUrl('https://site.example/?tvlogin=' + CODE);
    proutes['/api/auth/qr/scan'] = () => ({ ok: true, ua: 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36' });
    a = phoneApp();
    a._tvLoginOpen(CODE);
    ok(a.tvLogin.show && a.tvLogin.state === 'loading' && hist.at(-1) === '/', '读码中;地址栏去掉 tvlogin(刷新不会再弹)');
    await flush();
    ok(a.tvLogin.state === 'confirm' && a.tvLogin.device === '电视' && lastPost('/api/auth/qr/scan').body.code === CODE, '读到是哪台设备(Fire TV → 电视),等用户确认', a.tvLogin);

    pstore.m.clear();
    pstore.setItem('emax_auth_type', 'password');
    pstore.setItem('emax_auth_hash', HASH);
    proutes['/api/auth/qr/approve'] = () => ({ ok: true });
    const p1 = a.tvLoginApprove();
    ok(a.tvLogin.state === 'sending', '确认中(按钮禁用)');
    await a.tvLoginApprove();
    await p1;
    ok(posts.filter(p => p.url === '/api/auth/qr/approve').length === 1, '连点两下只提交一次');
    ok(a.tvLogin.state === 'done' && JSON.stringify(lastPost('/api/auth/qr/approve').body) === JSON.stringify({ code: CODE, auth: { type: 'password', hash: HASH } }),
        '独立密码:交出密码哈希', lastPost('/api/auth/qr/approve').body);
    a.tvLoginCancel();
    ok(!a.tvLogin.show && !posts.some(p => p.url === '/api/auth/qr/deny'), '确认完点"好的":只关弹窗,不告诉电视取消');
}
{
    pstore.m.clear();
    pstore.setItem('emax_auth_hash', HASH);
    const a = phoneApp();
    ok(JSON.stringify(a._tvLoginAuth()) === JSON.stringify({ type: 'password', hash: HASH }), '交出本机的访问密码哈希');
    pstore.m.clear();
    ok(JSON.stringify(a._tvLoginAuth()) === JSON.stringify({ type: 'password', hash: '' }), '本机没登录:交空的(服务器不收,提示重新登录一次)');
}
{
    const run = async (scan, approve) => {
        proutes['/api/auth/qr/scan'] = () => scan;
        proutes['/api/auth/qr/approve'] = () => approve;
        const a = phoneApp();
        a._tvLoginOpen(CODE);
        await flush();
        if (a.tvLogin.state === 'confirm') { await a.tvLoginApprove(); await flush(); }
        return a.tvLogin;
    };
    let t = await run({ ok: false, expired: true });
    ok(t.state === 'error' && /过期或用过了/.test(t.msg), '码过期 / 用过了:提示到电视上重新生成', t);
    t = await run({ __status: 404, body: { ok: false, message: '本站没有开启扫码登录' } });
    ok(t.state === 'error' && t.msg === '本站没有开启扫码登录', '站点没开:照服务器的话说', t);
    t = await run('NETWORK');
    ok(t.state === 'error' && /网络不太好/.test(t.msg), '网络错误:提示稍后再试', t);
    t = await run({ ok: true, ua: 'x' }, { ok: false, invalid: true });
    ok(t.state === 'error' && /退出后重新登录一次/.test(t.msg), '本机凭据交不出去(过期的老会话等):提示重新登录一次再扫', t);
    t = await run({ ok: true, ua: 'x' }, { ok: false, expired: true });
    ok(t.state === 'error' && /过期或用过了/.test(t.msg), '确认时码刚好过期:同样提示', t);
}
{
    proutes['/api/auth/qr/scan'] = () => ({ ok: true, ua: 'x' });
    proutes['/api/auth/qr/deny'] = () => ({ ok: true });
    const a = phoneApp();
    a._tvLoginOpen(CODE);
    await flush();
    const before = posts.filter(p => p.url === '/api/auth/qr/deny').length;
    a.tvLoginCancel();
    await flush();
    ok(!a.tvLogin.show && posts.filter(p => p.url === '/api/auth/qr/deny').length === before + 1 && lastPost('/api/auth/qr/deny').body.code === CODE, '还没确认就关掉:告诉电视"取消了"');
    const b = phoneApp();
    b._tvLoginOpen(CODE);
    b.tvLogin = Object.assign({}, b.tvLogin, { show: false });
    await flush();
    ok(!b.tvLogin.show && b.tvLogin.state === 'loading', '读码回包晚到、弹窗已经关了:不再弹出来');
}
{
    const L = phoneApp()._tvDeviceLabel;
    const cases = [
        ['Mozilla/5.0 (Linux; Android 11; BRAVIA 4K VH2 Build/RTM6.230109.205) AppleWebKit Chrome Safari', '电视'],
        ['Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233; wv) AppleWebKit Chrome', '电视'],
        ['Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit', '电视'],
        ['Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit', '电视'],
        ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile', 'iPhone'],
        ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit Chrome Mobile Safari', '安卓手机'],
        ['Mozilla/5.0 (Linux; Android 9; MiBOX4 Build/PI; wv) AppleWebKit Chrome Safari', '安卓平板或电视盒子'],
        ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit Chrome', 'Windows 电脑'],
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari', 'Mac 电脑'],
        ['Mozilla/5.0 (X11; Linux x86_64) Firefox', '电脑'],
        ['', '设备'], [null, '设备'],
    ];
    const bad = cases.filter(([ua, want]) => L(ua) !== want).map(([ua, want]) => [String(ua).slice(0, 40), want, L(ua)]);
    ok(bad.length === 0, '按 UA 粗分设备类型', bad);
}
{
    let opened = '', played = '';
    const a = phoneApp();
    a._tvLoginOpen = c => { opened = c; };
    a._openWorkByName = n => { played = n; };
    a._openRequestsDeepLink = () => { };
    setUrl('https://site.example/?tvlogin=' + CODE + '&play=x');
    PM.handleDeepLink.call(a);
    ok(opened === CODE && played === '', 'handleDeepLink:?tvlogin= 交给扫码登录,不当成分享链接', { opened, played });
}

console.log('⑦ 模板 / 样式接线');
{
    ok(/<div id="qr-login" class="qr-login" style="display: none;">\s*<div class="qr-login-code"><img id="qr-login-img" alt="[^"]+"><\/div>\s*<div id="qr-login-tip" class="qr-login-tip">[^<]*<\/div>\s*<button type="button" id="qr-login-again" class="mode-switch-btn" style="display: none;" onclick="qrLoginStart\(true\)">/.test(HTML),
        '登录框里有二维码区(图、提示、重新生成)');
    ok(/<button type="button" id="switch-to-qr" class="mode-switch-btn" style="display: none;"\s*onclick="switchLoginMode\('qr'\)">/.test(HTML)
        && /<button type="button" id="switch-to-password" class="mode-switch-btn" style="display: none;"\s*onclick="switchLoginMode\('password'\)">/.test(HTML)
        && /<span id="login-subtitle-text">需要密码才能访问<\/span>/.test(HTML), '"手机扫码登录" / "使用密码登录"入口、可改的副标题');
    ok(!/v2board-form|switch-to-v2board|toggleV2boardPasswordVisibility|revalidateV2boardSession|V2B_TOKEN_KEY|AUTH_TYPE_KEY/.test(HTML), '没有带进机场账户的登录界面和代码');
    ok(/\.qr-login-code \{[^}]*background: #fff;/.test(HTML) && /\.qr-login-code img \{[^}]*image-rendering: pixelated;/.test(HTML), '二维码白底留静区、像素放大不糊');
    const AUTHS = AUTH || '';
    ok(/QR_LOGIN = data\.qrLogin === true;/.test(AUTHS) && /function hideLoginScreen\(\) \{\s*qrLoginStop\(\);/.test(AUTHS)
        && /window\.dismissDeepLinkLogin = function \(\) \{[\s\S]{0,160}qrLoginStop\(\);/.test(AUTHS) && /window\.showLoginForDeepLink = function \(\) \{[\s\S]{0,500}switchLoginMode\(loginDefaultMode\(\)\);/.test(AUTHS),
        '登录门:读 qrLogin;收起 / 关掉浮层时停止轮询;深链浮层也按设备选默认方式');
    ok(/isTVMode: detectTVMode\(\),/.test(HTML) && !/isTVMode: \(function \(\)/.test(HTML), '播放页的 TV 模式和登录框共用 detectTVMode(电视关键词只有一份)');
    const tvList = /const tvKeywords = \[([\s\S]*?)\];/.exec(AUTHS);
    ok(!!tvList && ['android tv', 'googletv', 'aftt', 'aftm', 'aftb', 'firetv', 'chromecast', 'sabrina', 'boreal', 'roku', 'smarttv', 'smart-tv', 'tizen', 'webos', 'web0s', 'leanback'].every(k => tvList[1].includes("'" + k + "'")),
        '电视关键词一个没少(从播放页原样搬过来)');
    ok((HTML.match(/s\.src = 'libs\/js\/qrcode-generator\.min\.js\?v=2\.0\.4'/g) || []).length === 2 && fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8').includes("'./libs/js/qrcode-generator.min.js?v=2.0.4'"),
        '登录框和截帧分享用同一个二维码库文件(sw.js 已预缓存)');
    const TPL = HTML.slice(HTML.indexOf('<div id="app" v-cloak>'));
    const modal = (/<div class="info-modal-overlay" v-if="tvLogin\.show" @click\.self="tvLoginCancel">[\s\S]*?\n {8}<\/div>\n/.exec(TPL) || [''])[0];
    ok(!!modal && /@click="tvLoginApprove"/.test(modal) && /:disabled="tvLogin\.state === 'sending'"/.test(modal) && (modal.match(/@click="tvLoginCancel"/g) || []).length === 4
        && /只在你自己的设备上确认/.test(modal) && /\{\{ tvLogin\.device \}\}/.test(modal) && /\{\{ tvLogin\.msg \}\}/.test(modal),
        '手机上的确认弹窗:显示设备、提醒只在自己的设备上确认、确认 / 取消接好', modal.length);
    ok(/if \(p\.get\('tvlogin'\)\) \{ this\._tvLoginOpen\(p\.get\('tvlogin'\)\); return; \}/.test(HTML), 'handleDeepLink 接 ?tvlogin=');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
