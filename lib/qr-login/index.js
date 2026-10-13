'use strict';
// 📱 扫码登录(server.js 用;Vercel 的 api/index.js 没有:要在内存里等手机确认,无状态的函数做不了)。
//   电视(或任何不方便打字的设备)出二维码,已登录的手机扫码、核对设备后确认 → 电视拿到手机的登录凭据,再走原来的校验接口登录。
//
//   ① 电视 POST /api/auth/qr/new → { code, secret, ttl }。二维码 = <站点>/?tvlogin=<code>;secret 只留在电视上:
//      看到(或拍下)二维码的人拿着 code 也取不走凭据,取凭据要 code + secret
//   ② 手机打开链接(没登录就先登录)→ POST /scan { code } 拿到"哪台设备在请求"(UA)给用户核对;电视上显示"已扫码"
//   ③ 手机确认 → POST /approve { code, auth } 交出本机登录凭据(deps.checkAuth 校验并规范化,不合格不收);取消 → POST /deny
//   ④ 电视每 2 秒 POST /poll { code, secret } → 确认了就拿到凭据,取走即删(只能取一次);取消、过期也只告诉一次
//   · code 96 位、secret 128 位随机;5 分钟过期;全站同时最多挂 max 个;按 IP 限流(LIMITS,每分钟)
//   · 凭据只在内存里待到电视取走或过期(每分钟清一次):不落盘、不进日志
const crypto = require('crypto');

const DEF = { ttlMs: 5 * 60e3, max: 2000 };
// 电视每 2 秒轮询一次 = 30 次/分;给同一个出口 IP 下的几台电视留余量
const LIMITS = { new: 10, scan: 30, approve: 30, deny: 30, poll: 120 };
const CODE_RE = /^[A-Za-z0-9_-]{16}$/;

function createQrLogin(deps) {
    deps = deps || {};
    const C = Object.assign({}, DEF, deps.opts || {});
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    const rand = typeof deps.randomBytes === 'function' ? deps.randomBytes : crypto.randomBytes;
    const enabled = () => { try { return !!(deps.enabled && deps.enabled()); } catch (e) { return false; } };
    const checkAuth = (a) => { try { return (deps.checkAuth && deps.checkAuth(a)) || null; } catch (e) { return null; } };
    const reqs = new Map();   // code → { secret, status: pending | scanned | approved | denied, exp, ua, auth }

    function sweep() {
        const t = now();
        for (const [code, r] of reqs) if (t > r.exp) reqs.delete(code);
    }
    function live(code) {
        if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
        const r = reqs.get(code);
        if (r && now() > r.exp) { reqs.delete(code); return null; }
        return r || null;
    }
    const open = (r) => !!r && (r.status === 'pending' || r.status === 'scanned');
    const sameSecret = (a, b) => {
        if (typeof b !== 'string') return false;
        const x = Buffer.from(a), y = Buffer.from(b);
        return x.length === y.length && crypto.timingSafeEqual(x, y);
    };

    function create(ua) {
        sweep();
        if (reqs.size >= C.max) return null;
        for (let i = 0; i < 5; i++) {
            const code = rand(12).toString('base64url');
            if (reqs.has(code)) continue;
            const secret = rand(16).toString('base64url');
            reqs.set(code, { secret, status: 'pending', exp: now() + C.ttlMs, ua: String(ua || '').slice(0, 300), auth: null });
            return { code, secret, ttl: Math.round(C.ttlMs / 1000) };
        }
        return null;
    }
    function scan(code) {
        const r = live(code);
        if (!open(r)) return null;
        r.status = 'scanned';
        return { ua: r.ua };
    }
    function approve(code, auth) {
        const r = live(code);
        if (!open(r) || !auth) return false;
        r.status = 'approved';
        r.auth = auth;
        return true;
    }
    function deny(code) {
        const r = live(code);
        if (!open(r)) return false;
        r.status = 'denied';
        return true;
    }
    function poll(code, secret) {
        const r = live(code);
        if (!r || !sameSecret(r.secret, secret)) return { status: 'expired' };
        if (r.status === 'approved') { reqs.delete(code); return { status: 'approved', auth: r.auth }; }
        if (r.status === 'denied') { reqs.delete(code); return { status: 'denied' }; }
        return { status: r.status };
    }

    function registerRoutes(app) {
        const limit = (max) => (deps.limiter ? deps.limiter(max) : (req, res, next) => next());
        const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
        const off = (res) => res.status(404).json({ ok: false, message: '本站没有开启扫码登录' });
        app.post('/api/auth/qr/new', limit(LIMITS.new), (req, res) => {
            if (!enabled()) return off(res);
            const r = create(req.headers['user-agent']);
            res.set('Cache-Control', 'no-store');
            if (!r) return res.status(503).json({ ok: false, message: '扫码登录的人太多了，请稍后再试' });
            res.json(Object.assign({ ok: true }, r));
        });
        app.post('/api/auth/qr/scan', limit(LIMITS.scan), (req, res) => {
            if (!enabled()) return off(res);
            const r = scan(body(req).code);
            res.json(r ? { ok: true, ua: r.ua } : { ok: false, expired: true });
        });
        app.post('/api/auth/qr/approve', limit(LIMITS.approve), (req, res) => {
            if (!enabled()) return off(res);
            const b = body(req);
            if (!open(live(b.code))) return res.json({ ok: false, expired: true });
            const auth = checkAuth(b.auth);
            if (!auth) return res.json({ ok: false, invalid: true });
            res.json(approve(b.code, auth) ? { ok: true } : { ok: false, expired: true });
        });
        app.post('/api/auth/qr/deny', limit(LIMITS.deny), (req, res) => {
            if (!enabled()) return off(res);
            res.json({ ok: deny(body(req).code) });
        });
        app.post('/api/auth/qr/poll', limit(LIMITS.poll), (req, res) => {
            if (!enabled()) return off(res);
            const b = body(req);
            res.set('Cache-Control', 'no-store');
            res.json(poll(b.code, b.secret));
        });
        const timer = setInterval(sweep, 60e3);
        if (timer.unref) timer.unref();
    }

    return { create, scan, approve, deny, poll, sweep, size: () => reqs.size, registerRoutes };
}

module.exports = { createQrLogin, LIMITS };
