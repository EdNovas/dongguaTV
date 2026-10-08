'use strict';
// 🔔 Web Push(server.js 用;Vercel 无状态存不住订阅 → api/index.js 只挂桩)。
//
// 为什么这样做:
//   · VAPID 密钥站长不用提供:优先读 env VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY,没有就首次启动生成一对存进 SQLite app_meta,
//     以后一直用同一对 —— 换钥匙 = 所有浏览器的订阅全部作废(推送服务会拒收旧订阅)。
//   · 订阅地址(endpoint)是浏览器交上来的任意字符串,服务器之后会主动 POST 它 → 典型 SSRF 入口。
//     只收 https + 已知推送服务主机(FCM/Mozilla/Apple/WNS),拒 IP 字面量/端口/userinfo/结尾点/反斜杠;
//     并且存"规范化后"的地址、主机只许 [a-z0-9-] 标签 —— web-push 发送时用旧版 url.parse 解析它,新旧解析器分歧是 SSRF 绕过的老套路,
//     这样收紧后两者不可能读出不同主机(不自己再调 url.parse:Node 24 一调就打 DEP0169 告警)。发送前对库里的地址再验一遍。
//   · 发送失败绝不抛给调用方(收藏更新检查/求片后台不能因为推送挂掉);404/410 = 订阅已失效,直接删;
//     只有推送服务明确拒收这条订阅(HTTP 400/401/403/413)才计失败,连续 5 次删。网络错误/超时/429/5xx 是我们这边或推送服务的临时问题,
//     与订阅无关 —— 以前也计数,VPS 连不上 FCM 时一轮 5 部剧更新就把用户订阅删光,而浏览器开关还亮着(审查实锤)。
//   · 只发给仍然有效的令牌(sendToUser 每次现判):被封禁一律不发;"还算不算有效"由 deps.notifyOk 判(缺省 = 接口鉴权用的 tokenOk)。
//     server.js 里独立密码令牌要还在 PASSWORD_HASH_MAP(站长删了/改了密码 → 不发),机场令牌不在内存表也照发 ——
//     它只活在内存,重启后要等用户再打开网站才回来,按内存表判会让每次重启后所有机场用户静默收不到推送。
const crypto = require('crypto');
const net = require('net');

const DEF = {
    maxSubsPerUser: 5,          // 每用户最多 5 个订阅(手机/平板/电脑…),超出删最旧
    ttl: 86400,                 // 推送服务最多替我们存 1 天(设备离线太久,过时的"更新了"没意义)
    timeoutMs: 10000,
    maxFails: 5,                // 连续失败几次删订阅
    testGapMs: 60e3,            // 测试通知每用户 1 次/分钟
    testMapMax: 20000,
    endpointMax: 2048,
    uaMax: 300,
    titleMax: 80,
    bodyMax: 200,
    urlMax: 600,
    tagMax: 120,
    maxConcurrent: 6,           // 全站同时最多几个推送请求:批量处理 200 条求片也不会占满出网连接池(maxSockets 96)、饿死资源站请求
    maxQueue: 3000,             // 排队上限,超出直接丢(推送是锦上添花,不能无限堆内存)
};
// 已知推送服务主机:精确匹配 + 后缀匹配(后缀必须带前导点,防 evilgoogleapis.com)
//   Google 只认两个精确主机:'*.googleapis.com' 后缀会放进 storage.googleapis.com / <桶>.storage.googleapis.com /
//   firebasestorage.googleapis.com 这类"谁都能开一个桶"的主机 → 服务器直连 POST 到攻击者看得见日志的地方、暴露源站 IP(审查实锤)。
//   后缀规则只留给推送厂商自家的专用域(子域全是推送节点,外人开不出来)。
const ALLOW_EXACT = new Set(['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const ALLOW_SUFFIX = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com', '.wns.windows.com'];
function defaultAllowHost(h) {
    h = String(h || '').toLowerCase();
    return ALLOW_EXACT.has(h) || ALLOW_SUFFIX.some(s => h.length > s.length && h.endsWith(s));
}
// 推送服务"拒收这条订阅/这条请求"的状态码:连续 maxFails 次才删(404/410 = 订阅已失效,另行立即删)
const REJECT_CODES = new Set([400, 401, 403, 413]);
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/g;

// 订阅地址 → 规范化后的地址;不合格 → null。allowHost(hostname, URL) 可注入(测试放宽),协议/userinfo/端口/IP 等硬规则不可放宽
function normEndpoint(raw, allowHost) {
    if (typeof raw !== 'string') return null;
    if (raw.length < 12 || raw.length > DEF.endpointMax) return null;
    if (/[^\x21-\x7e]/.test(raw)) return null;                 // 空白/控制字符/非 ASCII(IDN 同形字)一律不收
    if (raw.includes('\\') || raw.includes('@')) return null;  // 反斜杠/userinfo:新旧解析器在这两处最容易分歧
    if (!/^https:\/\//i.test(raw)) return null;
    if (/^https:\/\/[^/?#]*:/i.test(raw)) return null;         // 显式端口(含 :443)一律不收:真推送服务从不带端口
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    if (!host || host.endsWith('.') || host.startsWith('[') || net.isIP(host)) return null;
    if (/^[0-9.]+$/.test(host)) return null;   // 纯数字主机(整数/简写 IP 写法;URL 解析器本会转成点分 IP,再兜一道)
    // 主机只许 [a-z0-9-] 标签:web-push 发送时用的是旧版 url.parse,规范化地址 = "https://<这种主机>/…" 时两个解析器不可能分歧
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
    const ok = typeof allowHost === 'function' ? !!allowHost(host, u) : defaultAllowHost(host);
    if (!ok) return null;
    const canon = u.href;
    if (!canon.startsWith('https://' + host + '/')) return null;
    return canon;
}
// base64/base64url 公钥/鉴权串 → 规范 base64url;长度不对 → null(p256dh = 65 字节未压缩点,auth = 16 字节)
function normKey(s, bytes) {
    if (typeof s !== 'string' || s.length > 200) return null;
    const t = s.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!t || !B64URL_RE.test(t)) return null;
    const buf = Buffer.from(t, 'base64url');
    if (buf.length !== bytes) return null;
    if (bytes === 65 && buf[0] !== 0x04) return null;
    return buf.toString('base64url');
}
// VAPID subject 必须是 https URL 或 mailto(Apple 会拒非法 subject;localhost/IP 也会被拒)
function subjectOk(s) {
    if (typeof s !== 'string' || !s.trim()) return false;
    let u;
    try { u = new URL(s.trim()); } catch (e) { return false; }
    if (u.protocol === 'mailto:') return !!u.pathname && u.pathname.includes('@');
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return !!h && h !== 'localhost' && !h.endsWith('.localhost') && !h.startsWith('[') && !net.isIP(h);
}
// 私钥推出的公钥必须等于给的公钥(env 填错一半时尽早发现,而不是推送全部 403)
function validPair(pub, priv) {
    try {
        const p = normKey(pub, 65);
        const k = typeof priv === 'string' ? priv.trim() : '';
        if (!p || !B64URL_RE.test(k)) return false;
        const kb = Buffer.from(k, 'base64url');
        if (kb.length !== 32) return false;
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.setPrivateKey(kb);
        return ecdh.getPublicKey().toString('base64url') === p;
    } catch (e) { return false; }
}
const clean = (v, n) => String(v == null ? '' : v).replace(CTRL_RE, ' ').trim().slice(0, n);
// 通知内容:标题/正文截断;url 只收站内相对路径(点通知打开的地址,绝不能被做成外链)
function cleanPayload(p) {
    p = p && typeof p === 'object' ? p : {};
    let url = typeof p.url === 'string' ? p.url.trim() : '';
    if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\') || url.length > DEF.urlMax || /[\u0000-\u001f\u007f]/.test(url)) url = '/';
    const out = { title: clean(p.title, DEF.titleMax) || '冬瓜TV', body: clean(p.body, DEF.bodyMax), url };
    const tag = clean(p.tag, DEF.tagMax);
    if (tag) out.tag = tag;
    return out;
}
// 同 tag 的通知在推送服务里合并(RFC 8030 Topic:base64url ≤32 字符),设备离线期间同一部剧更新多次只送最后一条
const topicOf = (tag) => tag ? crypto.createHash('sha256').update(String(tag)).digest('base64url').slice(0, 32) : '';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS push_subs (
    user_token TEXT NOT NULL, endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ua TEXT,
    created_at INTEGER, last_ok INTEGER, fails INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_token, created_at);
`;

function createWebPush(deps) {
    deps = deps || {};
    const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;
    const env = deps.env || process.env;
    let wp = deps.webpush || null;
    if (!wp) { try { wp = require('web-push'); } catch (e) { console.warn('[WebPush] 缺少 web-push 依赖,推送已禁用:', e.message); } }
    // 依赖一律调用时才取(server.js 里 REQ_DB_OK 等定义在注册点之后,构造时碰会撞 TDZ)
    const dbOf = () => { try { return deps.db ? (deps.db() || null) : null; } catch (e) { return null; } };
    const tokenOk = (t) => { try { return typeof t === 'string' && !!t && !!(deps.tokenOk && deps.tokenOk(t)); } catch (e) { return false; } };
    // 发送闸门(后台发通知时用,接口鉴权不用它);没注入 = 同 tokenOk
    const notifyOk = typeof deps.notifyOk === 'function'
        ? (t) => { try { return typeof t === 'string' && !!t && !!deps.notifyOk(t); } catch (e) { return false; } }
        : tokenOk;
    const isBanned = (t) => { try { return !!(deps.isBanned && deps.isBanned(t)); } catch (e) { return false; } };
    const allowHost = typeof deps.allowHost === 'function' ? deps.allowHost : null;

    const warnAt = {};
    const warn = (tag, e) => { const t = Date.now(); if (!warnAt[tag] || t - warnAt[tag] > 60e3) { warnAt[tag] = t; console.warn('[WebPush] ' + tag + ':', e && e.message || e); } };

    const inited = new WeakSet();
    let stmtDb = null;
    const stmts = new Map();
    const q = (d, sql) => {
        if (d !== stmtDb) { stmts.clear(); stmtDb = d; }
        let s = stmts.get(sql);
        if (!s) { s = d.prepare(sql); stmts.set(sql, s); }
        return s;
    };
    function getDb() {
        const d = dbOf();
        if (d && !inited.has(d)) { d.exec(SCHEMA); inited.add(d); }
        return d;
    }

    // ---------- VAPID ----------
    let vapid = null, vapidDb = null;
    function subject() {
        if (subjectOk(env.VAPID_SUBJECT)) return env.VAPID_SUBJECT.trim();
        if (env.VAPID_SUBJECT) warn('subject', 'VAPID_SUBJECT 必须是 https:// 网址或 mailto:,已忽略');
        const site = String(env.SITE_URL || '').trim().replace(/\/+$/, '');
        return subjectOk(site) ? site : 'https://ednovas.video';
    }
    function loadVapid(d) {
        if (vapid && vapidDb === d) return vapid;
        let pair = null;
        const ep = env.VAPID_PUBLIC_KEY, ek = env.VAPID_PRIVATE_KEY;
        if (ep || ek) {
            if (validPair(ep, ek)) pair = { publicKey: normKey(ep, 65), privateKey: String(ek).trim(), source: 'env' };
            else console.warn('[WebPush] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 无效或不成对,改用自动生成的密钥');
        }
        if (!pair) {
            const row = q(d, "SELECT v FROM app_meta WHERE k = 'vapid'").get();
            let saved = null;
            try { saved = row && JSON.parse(row.v); } catch (e) { saved = null; }
            if (saved && validPair(saved.publicKey, saved.privateKey)) pair = { publicKey: saved.publicKey, privateKey: saved.privateKey, source: 'db' };
            else {
                const g = wp.generateVAPIDKeys();
                q(d, "INSERT OR REPLACE INTO app_meta (k, v) VALUES ('vapid', ?)").run(JSON.stringify({ publicKey: g.publicKey, privateKey: g.privateKey, created_at: nowFn() }));
                pair = { publicKey: g.publicKey, privateKey: g.privateKey, source: 'generated' };
                console.log('[WebPush] 已自动生成 VAPID 密钥并存入数据库(以后一直用这一对;换掉会让所有已订阅失效)');
            }
        }
        pair.subject = subject();
        vapid = pair; vapidDb = d;
        return vapid;
    }
    function enabled() {
        if (!wp) return false;
        try { const d = getDb(); return !!(d && loadVapid(d)); } catch (e) { warn('init', e); return false; }
    }
    function publicKey() {
        try { const d = getDb(); return d ? loadVapid(d).publicKey : null; } catch (e) { warn('init', e); return null; }
    }

    // ---------- 订阅 ----------
    function normSubscription(s) {
        if (!s || typeof s !== 'object') return { error: 'subscription' };
        const endpoint = normEndpoint(s.endpoint, allowHost);
        if (!endpoint) return { error: 'endpoint' };
        const keys = s.keys && typeof s.keys === 'object' ? s.keys : {};
        const p256dh = normKey(keys.p256dh, 65), auth = normKey(keys.auth, 16);
        if (!p256dh || !auth) return { error: 'keys' };
        return { endpoint, p256dh, auth };
    }
    function subscribe(token, sub, ua) {
        const d = getDb();
        const n = normSubscription(sub);
        if (n.error) return { ok: false, error: n.error };
        const now = nowFn();
        d.transaction(() => {
            // 同一个浏览器订阅换了登录账号 → 归新账号(旧账号不该再收到这台设备的通知);重订阅不重置 created_at 以外的统计
            q(d, `INSERT INTO push_subs (user_token, endpoint, p256dh, auth, ua, created_at, last_ok, fails) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
                ON CONFLICT(endpoint) DO UPDATE SET user_token = excluded.user_token, p256dh = excluded.p256dh, auth = excluded.auth,
                    ua = excluded.ua, created_at = excluded.created_at, fails = 0`).run(token, n.endpoint, n.p256dh, n.auth, clean(ua, DEF.uaMax) || null, now);
            const rows = q(d, 'SELECT endpoint FROM push_subs WHERE user_token = ? ORDER BY created_at DESC, rowid DESC').all(token);
            const del = q(d, 'DELETE FROM push_subs WHERE endpoint = ?');
            for (const r of rows.slice(DEF.maxSubsPerUser)) del.run(r.endpoint);
        })();
        return { ok: true };
    }
    function unsubscribe(token, endpoint) {
        const d = getDb();
        if (typeof endpoint !== 'string' || !endpoint || endpoint.length > DEF.endpointMax) return { ok: false, error: 'endpoint' };
        let canon = endpoint;
        try { canon = new URL(endpoint).href; } catch (e) { }
        const del = q(d, 'DELETE FROM push_subs WHERE endpoint = ? AND user_token = ?');
        let removed = del.run(canon, token).changes;
        if (!removed && canon !== endpoint) removed = del.run(endpoint, token).changes;
        return { ok: true, removed };
    }

    // ---------- 发送 ----------
    let active = 0;
    const waiters = [];
    const acquire = () => {
        if (active < DEF.maxConcurrent) { active++; return Promise.resolve(true); }
        if (waiters.length >= DEF.maxQueue) return Promise.resolve(false);
        return new Promise(r => waiters.push(r));
    };
    const release = () => { const w = waiters.shift(); if (w) w(true); else active--; };
    // → { sent, failed, removed };绝不 reject
    async function sendToUser(token, payload) {
        const out = { sent: 0, failed: 0, removed: 0 };
        try {
            // 令牌已失效(notifyOk 不认:如独立密码被删/改)/被封禁 → 不发:这台设备的订阅还挂在旧令牌上,不能继续收到旧账号的通知
            if (!wp || typeof token !== 'string' || !token || !notifyOk(token) || isBanned(token)) return out;
            const d = getDb();
            if (!d) return out;
            const v = loadVapid(d);
            const subs = q(d, 'SELECT endpoint, p256dh, auth, fails FROM push_subs WHERE user_token = ? ORDER BY created_at DESC LIMIT ?').all(token, DEF.maxSubsPerUser);
            if (!subs.length) return out;
            const p = cleanPayload(payload);
            const body = JSON.stringify(p);
            const opts = Object.assign({
                TTL: DEF.ttl, urgency: 'normal', timeout: DEF.timeoutMs,
                vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey }
            }, p.tag ? { topic: topicOf(p.tag) } : {}, deps.sendOptions || {});
            const drop = (ep) => { try { q(d, 'DELETE FROM push_subs WHERE endpoint = ?').run(ep); } catch (e) { warn('db', e); } };
            await Promise.all(subs.map(async (s) => {
                // 发送前再验一遍(旧版本存进来的/手改库的行):不合格的直接删,绝不往外发
                if (normEndpoint(s.endpoint, allowHost) !== s.endpoint) { drop(s.endpoint); out.removed++; return; }
                if (!(await acquire())) { out.failed++; warn('queue', '推送排队已满,丢弃一条'); return; }
                try {
                    await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, opts);
                    out.sent++;
                    try { q(d, 'UPDATE push_subs SET last_ok = ?, fails = 0 WHERE endpoint = ?').run(nowFn(), s.endpoint); } catch (e) { warn('db', e); }
                } catch (e) {
                    const code = e && e.statusCode;
                    if (code === 404 || code === 410) { drop(s.endpoint); out.removed++; return; }
                    out.failed++;
                    warn('send', (code ? 'HTTP ' + code + ' ' : '') + (e && e.message || e));
                    // 只有推送服务拒收这条订阅才计数;网络错误(无状态码)/超时/429/5xx 只记日志,订阅原样保留
                    if (!REJECT_CODES.has(code)) return;
                    if ((s.fails || 0) + 1 >= DEF.maxFails) { drop(s.endpoint); out.removed++; }
                    else { try { q(d, 'UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').run(s.endpoint); } catch (e2) { warn('db', e2); } }
                } finally { release(); }
            }));
        } catch (e) { warn('send', e); }
        return out;
    }

    // ---------- 路由 ----------
    const testAt = new Map();
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    const body = (req) => (req.body && typeof req.body === 'object') ? req.body : {};
    // 鉴权失败/封禁/未启用 → 返回 true 表示已回包
    function guard(req, res, token) {
        if (!tokenOk(token)) { res.status(401).json({ ok: false, error: 'auth' }); return true; }
        if (isBanned(token)) { res.status(403).json({ ok: false, error: 'banned', banned: true }); return true; }
        if (!enabled()) { res.json({ ok: false, enabled: false, error: 'disabled' }); return true; }
        return false;
    }
    function registerRoutes(app) {
        app.get('/api/push/key', (req, res) => {
            noStore(res);
            if (!enabled()) return res.json({ enabled: false, publicKey: null });
            res.json({ enabled: true, publicKey: publicKey() });
        });
        app.post('/api/push/subscribe', (req, res) => {
            noStore(res);
            const b = body(req);
            if (guard(req, res, b.token)) return;
            try {
                const r = subscribe(b.token, b.subscription, req.headers && req.headers['user-agent']);
                res.status(r.ok ? 200 : 400).json(r);
            } catch (e) { warn('subscribe', e); res.status(500).json({ ok: false, error: 'db' }); }
        });
        app.post('/api/push/unsubscribe', (req, res) => {
            noStore(res);
            const b = body(req);
            if (guard(req, res, b.token)) return;
            try {
                const ep = typeof b.endpoint === 'string' ? b.endpoint : (b.subscription && b.subscription.endpoint);
                const r = unsubscribe(b.token, ep);
                res.status(r.ok ? 200 : 400).json(r);
            } catch (e) { warn('unsubscribe', e); res.status(500).json({ ok: false, error: 'db' }); }
        });
        app.post('/api/push/test', async (req, res) => {
            noStore(res);
            const b = body(req);
            if (guard(req, res, b.token)) return;
            const now = nowFn();
            const last = testAt.get(b.token);
            if (last && now - last < DEF.testGapMs) return res.status(429).json({ ok: false, error: 'rate', retry_after: Math.ceil((DEF.testGapMs - (now - last)) / 1000) });
            if (testAt.size >= DEF.testMapMax) testAt.clear();
            testAt.set(b.token, now);   // 先记再发:没订阅也算一次,防有人拿它探测/刷库
            try {
                const n = q(getDb(), 'SELECT COUNT(*) n FROM push_subs WHERE user_token = ?').get(b.token).n;
                if (!n) return res.json({ ok: false, error: 'no_subscription' });
            } catch (e) { warn('test', e); return res.status(500).json({ ok: false, error: 'db' }); }
            const r = await sendToUser(b.token, { title: '测试通知', body: '推送已开通,收藏的剧更新、求片有结果都会这样提醒你', url: '/', tag: 'test' });
            res.json(Object.assign({ ok: r.sent > 0 }, r));
        });
    }

    return { registerRoutes, sendToUser, enabled, publicKey, _subscribe: subscribe, _ensureSchema: () => !!getDb() };
}

module.exports = { createWebPush, normEndpoint, normKey, subjectOk, validPair, cleanPayload, defaultAllowHost, DEF };
