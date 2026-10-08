// Web Push 回归:node scripts/push-test.mjs
//  ① 纯函数:订阅地址 SSRF 白名单(http/IP 字面量/其它主机/userinfo/端口/结尾点/反斜杠/百分号编码…)、密钥/subject 校验、通知内容清洗
//  ② lib/webpush 单元(SQLite 内存库 + 真 web-push 库):VAPID 自动生成并持久化/env 优先/env 坏了回退、订阅上限 5/换账号归属/退订、
//     发到本地假推送服务(自定义 https.Agent 把 TLS 连接改成连本机明文 HTTP —— 主机名仍是 fcm.googleapis.com,白名单照常生效):
//     校验请求头(VAPID JWT aud/sub/exp、aes128gcm、TTL、Urgency、Topic)并用订阅私钥解密出原文;410/404 删订阅、其它失败 5 次删、
//     封禁不发、库里混进的非法地址发前删、全站并发上限、测试通知每用户 1 次/分;白名单可注入放宽(硬规则不放宽)
//     + lib/user-stats 批量改求片状态的回调(只报状态真变了的)
//  ③ 端到端:临时目录起真正的 server.js(CACHE_TYPE=sqlite):密钥跨重启不变、env 密钥优先、订阅/拒收/上限/退订、测试通知限流;
//     求片单条/批量改状态 → 推送钩子真的被调用(往库里塞一条非法地址的订阅,钩子触发时会被发前校验删掉 —— 全程不碰外网)
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import https from 'https';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };   // worktree 没有 node_modules 时走 NODE_PATH
const Database = dep('better-sqlite3');
const webpushLib = dep('web-push');
const ece = dep('http_ece');
const { createWebPush, normEndpoint, normKey, subjectOk, validPair, cleanPayload, DEF } = require(path.join(ROOT, 'lib/webpush'));
const { createUserStats } = require(path.join(ROOT, 'lib/user-stats'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 600) : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
const jwtOf = (authz) => {
    const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(String(authz || ''));
    if (!m) return null;
    const [h, p] = m[1].split('.');
    return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), payload: JSON.parse(Buffer.from(p, 'base64url').toString()), k: m[2] };
};
// 浏览器那一侧的订阅:p256dh 公私钥 + auth
function mkClient(endpoint) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = crypto.randomBytes(16);
    return { ecdh, auth, sub: { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } };
}

// ---------------- ① 纯函数 ----------------
console.log('① 纯函数');
{
    const good = [
        'https://fcm.googleapis.com/fcm/send/cX1:APA91bH-abc_DEF',
        'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABkABC-_def',
        'https://web.push.apple.com/QGxmN2ZjY2Y3LTk',
        'https://api.push.apple.com/3/device/abc',
        'https://wns2-bn3p.notify.windows.com/w/?token=BQYAAAB%2bxyz%3d',
        'https://db5.wns.windows.com/w/?token=abc',
        'https://android.googleapis.com/gcm/send/abc',
        'https://eu-1.push.services.mozilla.com/wpush/v1/x',
        'HTTPS://FCM.GOOGLEAPIS.COM/fcm/send/Case',
    ];
    for (const g of good) ok(!!normEndpoint(g), '接受 ' + g.slice(0, 60), normEndpoint(g));
    ok(normEndpoint('HTTPS://FCM.GOOGLEAPIS.COM/fcm/send/Case') === 'https://fcm.googleapis.com/fcm/send/Case', '规范化:协议/主机小写,路径大小写保留');
    const bad = [
        ['http://fcm.googleapis.com/fcm/send/x', 'http'],
        ['https://127.0.0.1/x', 'IPv4'], ['https://[::1]/x', 'IPv6'], ['https://2130706433/x', '整数 IP'], ['https://0x7f000001/x', '十六进制 IP'],
        ['https://0177.0.0.1/x', '八进制 IP'], ['https://169.254.169.254/latest/meta-data', '云元数据'],
        ['https://evil.com/x', '其它主机'], ['https://googleapis.com/x', '裸后缀'], ['https://evilgoogleapis.com/x', '后缀不带点'],
        ['https://fcm.googleapis.com.evil.com/x', '白名单当子域'], ['https://notify.windows.com.evil.com/x', '白名单当子域 2'],
        ['https://fcm.googleapis.com@evil.com/x', 'userinfo 骗主机'], ['https://user:pw@fcm.googleapis.com/x', '带 userinfo'],
        ['https://evil.com#@fcm.googleapis.com/x', '# + @'], ['https://evil.com\\@fcm.googleapis.com/x', '反斜杠 + @'],
        ['https://evil.com\\.fcm.googleapis.com/x', '反斜杠'], ['https://fcm.googleapis.com\\evil', '反斜杠在路径'],
        ['https://fcm.googleapis.com:8443/x', '端口'], ['https://fcm.googleapis.com:443/x', '显式 443'], ['https://fcm.googleapis.com:/x', '空端口'],
        ['https://fcm.googleapis.com./x', '结尾点'], ['https://fcm.googleapis.com%2eevil.com/x', '百分号编码的点'],
        ['https://fcm.googleapis.com%40evil.com/x', '百分号编码的 @'], ['https://evil.com%2f.googleapis.com/x', '百分号编码的 /'],
        ['https://fcm.googleapis.com/x y', '空格'], ['https://fcm.googleapis.com/\tx', '制表符'], ['https://fcm.googleapis.com/\u0000', 'NUL'],
        ['https://fcm.googleapis.com/路径', '非 ASCII'], ['https://ｆcm.googleapis.com/x', '全角同形字'],
        ['javascript:alert(1)', 'javascript'], ['ftp://fcm.googleapis.com/x', 'ftp'], ['//fcm.googleapis.com/x', '协议相对'],
        ['https:/fcm.googleapis.com/x', '单斜杠'], ['https:fcm.googleapis.com/x', '无斜杠'],
        ['https://fcm.googleapis.com/' + 'a'.repeat(3000), '超长'], ['', '空'], [null, 'null'], [123, '数字'], [{ toString: () => 'https://fcm.googleapis.com/x' }, '对象'],
        // *.googleapis.com 不再整片放行:谁都能开的存储桶主机会让服务器直连 POST 到攻击者看得见日志的地方(S5)
        ['https://storage.googleapis.com/attacker-bucket/x', 'GCS 存储'], ['https://attacker-bucket.storage.googleapis.com/x', 'GCS 桶子域'],
        ['https://x.storage.googleapis.com/x', 'GCS 桶子域 2'], ['https://firebasestorage.googleapis.com/v0/b/attacker.appspot.com/o?name=a', 'Firebase 存储'],
        ['https://storage.googleapis.com/upload/storage/v1/b/attacker-bucket/o?uploadType=media&name=x', 'GCS 上传接口'],
        ['https://jmt17.googleapis.com/fcm/send/x', '其它 googleapis 子域'], ['https://www.googleapis.com/x', 'www.googleapis.com'],
        ['https://x.fcm.googleapis.com/fcm/send/x', 'fcm 的子域'],
    ];
    for (const [b, why] of bad) ok(normEndpoint(b) === null, '拒绝 ' + why, normEndpoint(b));
    // 注入放宽:只放宽主机名,硬规则照旧
    const allow = (h) => h === 'push.test';
    ok(normEndpoint('https://push.test/ep') === null && normEndpoint('https://push.test/ep', allow) === 'https://push.test/ep', '注入 allowHost 放宽主机');
    ok(normEndpoint('http://push.test/ep', allow) === null && normEndpoint('https://push.test:8443/ep', allow) === null && normEndpoint('https://127.0.0.1/ep', () => true) === null
        && normEndpoint('https://a@push.test/ep', allow) === null, '放宽后 http/端口/IP/userinfo 仍拒');
    // 密钥
    const c = mkClient('x');
    ok(normKey(c.sub.keys.p256dh, 65) === c.sub.keys.p256dh && normKey(c.sub.keys.auth, 16) === c.sub.keys.auth, 'p256dh/auth 合法');
    ok(normKey(c.ecdh.getPublicKey().toString('base64'), 65) === c.sub.keys.p256dh, '标准 base64(带 +/=)也收并转 base64url');
    ok(normKey(b64u(Buffer.alloc(65, 5)), 65) === null && normKey(b64u(Buffer.alloc(64, 4)), 65) === null && normKey('!!!', 16) === null && normKey(null, 16) === null && normKey('a'.repeat(300), 16) === null, '长度/首字节/字符集不对拒收');
    ok(subjectOk('https://ednovas.video') && subjectOk('mailto:admin@example.com') && subjectOk('https://tv.example.com/path'), 'subject 合法');
    ok(!subjectOk('http://ednovas.video') && !subjectOk('https://localhost:3000') && !subjectOk('https://127.0.0.1') && !subjectOk('mailto:') && !subjectOk('') && !subjectOk('abc') && !subjectOk(null), 'subject 非法(Apple 会拒)');
    const g1 = webpushLib.generateVAPIDKeys(), g2 = webpushLib.generateVAPIDKeys();
    ok(validPair(g1.publicKey, g1.privateKey) && !validPair(g1.publicKey, g2.privateKey) && !validPair(g1.publicKey, '') && !validPair('x', g1.privateKey), 'VAPID 公私钥配对校验');
    let p = cleanPayload({ title: '《剧》更新了\u0000\n', body: 'x'.repeat(500), url: '/?play=%E5%89%A7&ep=1', tag: 'fav:剧' });
    ok(p.title === '《剧》更新了' && p.body.length === DEF.bodyMax && p.url === '/?play=%E5%89%A7&ep=1' && p.tag === 'fav:剧', '通知内容清洗', p);
    for (const u of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', '/x\ny', 123, '/' + 'a'.repeat(700)]) ok(cleanPayload({ url: u }).url === '/', '外链/怪地址 → /: ' + String(u).slice(0, 30));
    ok(cleanPayload(null).title === '冬瓜TV' && !('tag' in cleanPayload({})), '缺省标题、无 tag 不带');
}

// ---------------- 本地假推送服务 ----------------
// 自定义 Agent:web-push 只认 https.Agent 实例;把"建 TLS 连接"换成连本机明文端口 → 请求原样到达假服务(Host 头仍是真推送服务的主机名)
class LoopAgent extends https.Agent {
    constructor(port) { super({ keepAlive: false }); this.loopPort = port; }
    createConnection() { return net.connect({ port: this.loopPort, host: '127.0.0.1' }); }
}
function startPushMock() {
    const got = [];
    const clients = new Map();   // 路径 → mkClient()
    let active = 0, maxActive = 0, delay = 0;
    const srv = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
            active++; maxActive = Math.max(maxActive, active);
            if (delay) await sleep(delay);
            active--;
            const body = Buffer.concat(chunks);
            const ent = { host: req.headers.host, path: req.url, headers: req.headers, len: body.length, plain: null };
            const cl = clients.get(req.url);
            if (cl) { try { ent.plain = JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: cl.ecdh, authSecret: b64u(cl.auth) }).toString()); } catch (e) { ent.err = e.message; } }
            got.push(ent);
            const m = /\/(\d{3})(?:\/|$)/.exec(req.url);   // 路径里带 /410/ 之类 → 回这个状态码
            res.writeHead(m ? Number(m[1]) : 201);
            res.end();
        });
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({
        got, clients, srv, port: srv.address().port,
        get maxActive() { return maxActive; }, reset: () => { got.length = 0; maxActive = 0; }, setDelay: (ms) => { delay = ms; },
        close: () => new Promise(rr => srv.close(rr)),
    })));
}

// 假 app
function mkApp() {
    const routes = new Map();
    const reg = (m) => (p, ...hs) => { routes.set(m + ' ' + p, hs); };
    return { routes, get: reg('GET'), post: reg('POST') };
}
async function call(app, method, p, o) {
    o = o || {};
    const hs = app.routes.get(method + ' ' + p);
    if (!hs) throw new Error('no route ' + method + ' ' + p);
    const req = { method, body: o.body || {}, query: o.query || {}, headers: Object.assign({ 'user-agent': 'Mozilla/5.0 (Test) Chrome/129' }, o.headers || {}) };
    const res = {
        statusCode: 200, body: undefined, headers: {}, headersSent: false,
        status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; },
        json(x) { this.body = x; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; }
    };
    let i = 0;
    const next = () => { const h = hs[i++]; if (h) return h(req, res, next); };
    await next();
    return res;
}

// ---------------- ② 单元 ----------------
console.log('② lib/webpush 单元');
const P = await startPushMock();
const loop = new LoopAgent(P.port);
let NOW = Date.UTC(2026, 9, 8, 4, 0, 0);
const TK = { a: sha('alice'), b: sha('bob'), c: sha('carol'), x: sha('banned') };
const valid = new Set(Object.values(TK));
const banned = new Set([TK.x]);
function mkWp(db, extra) {
    const app = mkApp();
    const wp = createWebPush(Object.assign({
        db: () => db, now: () => NOW, env: { SITE_URL: 'https://tv.example.com/' },
        tokenOk: (t) => valid.has(t), isBanned: (t) => banned.has(t),
        sendOptions: { agent: loop }
    }, extra || {}));
    wp.registerRoutes(app);
    return { wp, app };
}
const subCount = (db, t) => db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_token = ?').get(t).n;
try {
    // ---- 关闭 / VAPID ----
    {
        const off = mkWp(null);
        let r = await call(off.app, 'GET', '/api/push/key');
        ok(r.body && r.body.enabled === false && r.body.publicKey === null && r.headers['Cache-Control'] === 'no-store', '没 SQLite → enabled:false', r.body);
        r = await call(off.app, 'POST', '/api/push/subscribe', { body: { token: TK.a, subscription: mkClient('https://fcm.googleapis.com/fcm/send/x').sub } });
        ok(r.body && r.body.ok === false && r.body.enabled === false, '没 SQLite → 不收订阅', r.body);
        ok((await off.wp.sendToUser(TK.a, { title: 't' })).sent === 0, '没 SQLite → sendToUser 空操作');
    }
    const db = new Database(':memory:');
    const { wp, app } = mkWp(db);
    let r = await call(app, 'GET', '/api/push/key');
    const PUB = r.body && r.body.publicKey;
    ok(r.body && r.body.enabled === true && typeof PUB === 'string' && Buffer.from(PUB, 'base64url').length === 65, '自动生成 VAPID 公钥', r.body);
    const meta = JSON.parse(db.prepare("SELECT v FROM app_meta WHERE k = 'vapid'").get().v);
    ok(meta.publicKey === PUB && validPair(meta.publicKey, meta.privateKey), '密钥对存进 app_meta', Object.keys(meta));
    ok(mkWp(db).wp.publicKey() === PUB, '再建一个实例(=重启)用同一对');
    const envPair = webpushLib.generateVAPIDKeys();
    ok(mkWp(db, { env: { VAPID_PUBLIC_KEY: envPair.publicKey, VAPID_PRIVATE_KEY: envPair.privateKey } }).wp.publicKey() === envPair.publicKey, 'env 密钥优先');
    const warns = [];
    const ow = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    const badEnv = mkWp(db, { env: { VAPID_PUBLIC_KEY: envPair.publicKey, VAPID_PRIVATE_KEY: webpushLib.generateVAPIDKeys().privateKey } }).wp.publicKey();
    console.warn = ow;
    ok(badEnv === PUB && warns.some(w => /VAPID/.test(w)), 'env 不成对 → 告警并回退库里那对', [badEnv === PUB, warns]);
    ok(JSON.parse(db.prepare("SELECT v FROM app_meta WHERE k = 'vapid'").get().v).publicKey === PUB, 'env 密钥不覆盖库里那对');
    {
        const dbBad = new Database(':memory:');
        const w0 = mkWp(dbBad);
        w0.wp.publicKey();
        dbBad.prepare("UPDATE app_meta SET v = 'garbage' WHERE k = 'vapid'").run();
        const fresh = mkWp(dbBad).wp.publicKey();
        ok(fresh && validPair(fresh, JSON.parse(dbBad.prepare("SELECT v FROM app_meta WHERE k = 'vapid'").get().v).privateKey), '库里那对坏了 → 重新生成');
    }

    // ---- 订阅 ----
    {
        const sub = (t, s) => call(app, 'POST', '/api/push/subscribe', { body: { token: t, subscription: s } });
        r = await sub('nope', mkClient('https://fcm.googleapis.com/fcm/send/x').sub);
        ok(r.statusCode === 401, '非法 token 401', r.statusCode);
        r = await sub('constructor', mkClient('https://fcm.googleapis.com/fcm/send/x').sub);
        ok(r.statusCode === 401, '原型键 token 401');
        r = await sub(TK.x, mkClient('https://fcm.googleapis.com/fcm/send/x').sub);
        ok(r.statusCode === 403 && r.body.banned === true, '封禁 403', r.body);
        for (const ep of ['http://fcm.googleapis.com/fcm/send/x', 'https://127.0.0.1/x', 'https://evil.com/x', 'https://fcm.googleapis.com@evil.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com./x']) {
            r = await sub(TK.a, mkClient(ep).sub);
            ok(r.statusCode === 400 && r.body.error === 'endpoint', '拒收 ' + ep, r.body);
        }
        const k = mkClient('https://fcm.googleapis.com/fcm/send/k');
        r = await sub(TK.a, { endpoint: k.sub.endpoint, keys: { p256dh: 'abc', auth: k.sub.keys.auth } });
        ok(r.statusCode === 400 && r.body.error === 'keys', '坏 p256dh 拒收', r.body);
        r = await sub(TK.a, { endpoint: k.sub.endpoint });
        ok(r.statusCode === 400 && r.body.error === 'keys', '缺 keys 拒收', r.body);
        r = await sub(TK.a, 'x');
        ok(r.statusCode === 400, '订阅不是对象拒收', r.body);
        ok(subCount(db, TK.a) === 0, '拒收的都没入库');
        // 上限 5
        for (let i = 1; i <= 6; i++) {
            const c = mkClient(`https://fcm.googleapis.com/fcm/send/a${i}`);
            P.clients.set(`/fcm/send/a${i}`, c);
            NOW += 1000;
            r = await sub(TK.a, c.sub);
            ok(r.body && r.body.ok === true, '订阅 a' + i, r.body);
        }
        const eps = db.prepare('SELECT endpoint FROM push_subs WHERE user_token = ? ORDER BY created_at').all(TK.a).map(x => x.endpoint.split('/').pop());
        ok(eps.join() === 'a2,a3,a4,a5,a6', '每用户最多 5 个,超出删最旧', eps);
        const row = db.prepare("SELECT * FROM push_subs WHERE endpoint LIKE '%/a6'").get();
        ok(row.ua === 'Mozilla/5.0 (Test) Chrome/129' && row.fails === 0 && row.created_at === NOW, '记录 UA/时间', row);
        // 同一订阅换账号 → 归新账号
        NOW += 1000;
        r = await sub(TK.b, P.clients.get('/fcm/send/a6').sub);
        ok(r.body.ok && subCount(db, TK.a) === 4 && subCount(db, TK.b) === 1, '同一浏览器订阅换账号登录 → 归新账号', [subCount(db, TK.a), subCount(db, TK.b)]);
        // 退订
        r = await call(app, 'POST', '/api/push/unsubscribe', { body: { token: TK.a, endpoint: 'https://fcm.googleapis.com/fcm/send/a6' } });
        ok(r.body.ok && r.body.removed === 0 && subCount(db, TK.b) === 1, '退不掉别人的订阅', r.body);
        r = await call(app, 'POST', '/api/push/unsubscribe', { body: { token: TK.b, endpoint: 'HTTPS://FCM.googleapis.com/fcm/send/a6' } });
        ok(r.body.ok && r.body.removed === 1 && subCount(db, TK.b) === 0, '退订(地址按规范化匹配)', r.body);
        r = await call(app, 'POST', '/api/push/unsubscribe', { body: { token: TK.a, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/a5' } } });
        ok(r.body.ok && r.body.removed === 1, '也认 subscription.endpoint', r.body);
        r = await call(app, 'POST', '/api/push/unsubscribe', { body: { token: TK.a } });
        ok(r.statusCode === 400, '缺 endpoint 400');
    }

    // ---- 发送 ----
    {
        P.reset();
        const res = await wp.sendToUser(TK.a, { title: '《剧A》更新了', body: '更新至 第05集', url: '/?play=%E5%89%A7A&ep=%E7%AC%AC05%E9%9B%86', tag: 'fav:剧A' });
        ok(res.sent === 3 && res.failed === 0 && res.removed === 0 && P.got.length === 3, '发到用户全部订阅(a2,a3,a4)', [res, P.got.length]);
        const g = P.got.find(x => x.path === '/fcm/send/a2');
        ok(g && g.host === 'fcm.googleapis.com', '请求发往订阅的推送服务主机', g && g.host);
        const j = g && jwtOf(g.headers.authorization);
        ok(j && j.header.alg === 'ES256' && j.payload.aud === 'https://fcm.googleapis.com' && j.payload.sub === 'https://tv.example.com' && j.k === PUB, 'VAPID JWT:aud=推送服务源、sub=SITE_URL、k=公钥', j);
        ok(j && j.payload.exp * 1000 > Date.now() && j.payload.exp * 1000 <= Date.now() + 24 * 3600e3 + 60e3, 'JWT 过期时间 ≤24h', j && j.payload.exp);
        ok(g.headers['content-encoding'] === 'aes128gcm' && g.headers.ttl === '86400' && g.headers.urgency === 'normal' && /^[A-Za-z0-9_-]{32}$/.test(g.headers.topic || ''), '头:aes128gcm / TTL 1 天 / Urgency / Topic', g.headers);
        ok(g.plain && g.plain.title === '《剧A》更新了' && g.plain.body === '更新至 第05集' && g.plain.url === '/?play=%E5%89%A7A&ep=%E7%AC%AC05%E9%9B%86' && g.plain.tag === 'fav:剧A', '用订阅私钥解密出原文', g.plain || g.err);
        ok(P.got.every(x => x.headers.topic === g.headers.topic), '同 tag 同 Topic(推送服务里合并)');
        ok(db.prepare("SELECT last_ok FROM push_subs WHERE endpoint LIKE '%/a2'").get().last_ok === NOW, '成功记 last_ok');
        // 410 / 404 → 删;推送服务拒收(400/401/403/413)→ 计数,5 次删;429/5xx 只记日志、不计数(S4)
        const add = async (t, p) => { const c = mkClient('https://fcm.googleapis.com' + p); P.clients.set(p, c); NOW += 1000; return wp._subscribe(t, c.sub, 'ua'); };
        const failsOf = (like) => { const row = db.prepare('SELECT fails FROM push_subs WHERE endpoint LIKE ?').get(like); return row ? row.fails : null; };
        await add(TK.c, '/gone/410/x');
        await add(TK.c, '/nf/404/x');
        await add(TK.c, '/err/403/x');
        let rc = await wp.sendToUser(TK.c, { title: 't' });
        ok(rc.removed === 2 && rc.failed === 1 && subCount(db, TK.c) === 1, '410/404 删订阅,403 计失败', rc);
        for (let i = 2; i <= 4; i++) await wp.sendToUser(TK.c, { title: 't' });
        ok(failsOf('%/403/x') === 4, '连续被拒 4 次还留着');
        rc = await wp.sendToUser(TK.c, { title: 't' });
        ok(rc.removed === 1 && subCount(db, TK.c) === 0, '第 5 次被拒删掉', rc);
        for (const code of [400, 401, 413]) {
            await add(TK.c, `/rej/${code}/x`);
            for (let i = 1; i <= 5; i++) rc = await wp.sendToUser(TK.c, { title: 't' });
            ok(rc.removed === 1 && subCount(db, TK.c) === 0, `HTTP ${code} 也计数,5 次删`, rc);
        }
        for (const code of [429, 500, 502, 503]) {
            await add(TK.c, `/tmp/${code}/x`);
            for (let i = 1; i <= 7; i++) rc = await wp.sendToUser(TK.c, { title: 't' });
            ok(rc.failed === 1 && rc.removed === 0 && subCount(db, TK.c) === 1 && failsOf(`%/tmp/${code}/x`) === 0, `HTTP ${code} 只记日志不计数,7 次后订阅还在`, rc);
            db.prepare('DELETE FROM push_subs WHERE user_token = ?').run(TK.c);
        }
        // 网络错误/超时(没有状态码,review/fails.js):VPS 连不上 FCM 时一轮 5 部剧更新不能把订阅删光
        {
            const dbe = new Database(':memory:');
            let n = 0;
            const errs = [
                () => Object.assign(new Error('connect ETIMEDOUT 142.250.0.1:443'), { code: 'ETIMEDOUT' }),
                () => Object.assign(new Error('getaddrinfo ENOTFOUND fcm.googleapis.com'), { code: 'ENOTFOUND' }),
                () => new Error('Socket timeout'),
            ];
            const fakeWp = { generateVAPIDKeys: webpushLib.generateVAPIDKeys, sendNotification: async () => { throw errs[n++ % errs.length](); } };
            const we = createWebPush({ db: () => dbe, webpush: fakeWp, tokenOk: () => true, isBanned: () => false });
            ok(we._subscribe(TK.a, mkClient('https://fcm.googleapis.com/fcm/send/net').sub).ok === true, '网络错误用例:订阅');
            let last = null;
            for (let i = 1; i <= 6; i++) last = await we.sendToUser(TK.a, { title: 't' });
            const row = dbe.prepare('SELECT fails FROM push_subs').get();
            ok(n === 6 && last.failed === 1 && last.removed === 0 && row && row.fails === 0, 'ETIMEDOUT/ENOTFOUND/Socket timeout 6 次 → 订阅保留、不计数', { n, last, row });
            dbe.close();
        }
        // 成功会把失败计数清零
        await add(TK.c, '/flaky/403/y');
        await wp.sendToUser(TK.c, { title: 't' });
        ok(failsOf('%/flaky/403/y') === 1, '被拒一次计 1');
        db.prepare("UPDATE push_subs SET endpoint = 'https://fcm.googleapis.com/flaky/ok/y' WHERE endpoint LIKE '%/flaky/403/y'").run();
        P.clients.set('/flaky/ok/y', P.clients.get('/flaky/403/y'));
        rc = await wp.sendToUser(TK.c, { title: 't' });
        ok(rc.sent === 1 && failsOf('%/flaky/ok/y') === 0, '成功清零失败计数', rc);
        // 令牌已失效(不再是 PASSWORD_HASH_MAP 自有键:改了密码/机场令牌被挤出/强制登出后换人用)→ 不发(S7)
        P.reset();
        valid.delete(TK.c);
        rc = await wp.sendToUser(TK.c, { title: 't' });
        ok(rc.sent === 0 && P.got.length === 0 && subCount(db, TK.c) === 1, '失效令牌不发(订阅留着,换回有效令牌后照常)', rc);
        valid.add(TK.c);
        rc = await wp.sendToUser(TK.c, { title: 't' });
        ok(rc.sent === 1, '令牌恢复有效 → 照常发', rc);
        // 发送闸门可单独注入(V2):接口鉴权仍用 tokenOk,发送前用 notifyOk —— server.js 让重启后不在内存表的机场令牌照收推送
        {
            const V2B = 'v2board_' + sha('restart@example.com');
            const gw = mkWp(db, { notifyOk: (t) => valid.has(t) || /^v2board_[0-9a-f]{64}$/.test(t) });
            await add(V2B, '/gate/v2b');
            P.reset();
            let rg = await gw.wp.sendToUser(V2B, { title: 'gate' });
            ok(rg.sent === 1 && P.got.length === 1 && P.got[0].plain && P.got[0].plain.title === 'gate', 'notifyOk 认的机场令牌(不在 tokenOk 里)→ 照发', rg);
            rg = await wp.sendToUser(V2B, { title: 'gate' });
            ok(rg.sent === 0, '没注入 notifyOk 的实例 → 同 tokenOk,不发', rg);
            banned.add(V2B);
            rg = await gw.wp.sendToUser(V2B, { title: 'gate' });
            ok(rg.sent === 0, 'notifyOk 认、但被封禁 → 不发', rg);
            banned.delete(V2B);
            valid.delete(TK.c);
            rg = await gw.wp.sendToUser(TK.c, { title: 'gate' });
            ok(rg.sent === 0 && subCount(db, TK.c) === 1, 'notifyOk 不认失效的独立密码令牌 → 不发', rg);
            valid.add(TK.c);
            const rs = await call(gw.app, 'POST', '/api/push/subscribe', { body: { token: V2B, subscription: mkClient('https://fcm.googleapis.com/fcm/send/gate2').sub } });
            ok(rs.statusCode === 401, '接口鉴权不受 notifyOk 影响:不在 tokenOk 里的令牌不能订阅', rs.statusCode);
            db.prepare('DELETE FROM push_subs WHERE user_token = ?').run(V2B);
        }
        // 封禁不发
        P.reset();
        banned.add(TK.c);
        rc = await wp.sendToUser(TK.c, { title: 't' });
        ok(rc.sent === 0 && P.got.length === 0, '封禁用户不发', rc);
        banned.delete(TK.c);
        // 库里混进的非法地址:发前删,一个字节都不往外发
        db.prepare("INSERT INTO push_subs (user_token, endpoint, p256dh, auth, created_at, fails) VALUES (?, 'https://evil.com/x', ?, ?, ?, 0)").run(TK.b, P.clients.get('/fcm/send/a2').sub.keys.p256dh, P.clients.get('/fcm/send/a2').sub.keys.auth, NOW);
        db.prepare("INSERT INTO push_subs (user_token, endpoint, p256dh, auth, created_at, fails) VALUES (?, 'https://fcm.googleapis.com:8443/x', ?, ?, ?, 0)").run(TK.b, P.clients.get('/fcm/send/a2').sub.keys.p256dh, P.clients.get('/fcm/send/a2').sub.keys.auth, NOW);
        P.reset();
        rc = await wp.sendToUser(TK.b, { title: 't' });
        ok(rc.removed === 2 && rc.sent === 0 && P.got.length === 0 && subCount(db, TK.b) === 0, '库里的非法地址发前删掉、不外发', rc);
        // 没订阅 / 非法 token / 坏 payload 都不抛
        ok((await wp.sendToUser('nobody', { title: 't' })).sent === 0 && (await wp.sendToUser(null)).sent === 0 && (await wp.sendToUser(TK.a, null)).sent === 3, '各种怪输入不抛');
        const broken = createWebPush({ db: () => { throw new Error('db down'); }, tokenOk: () => true });
        ok((await broken.sendToUser(TK.a, { title: 't' })).sent === 0 && broken.enabled() === false, '库挂了 → 静默');
        // 全站并发上限
        P.reset(); P.setDelay(60);
        for (let i = 0; i < 20; i++) { const t = sha('u' + i); valid.add(t); await add(t, '/many/' + i); }
        const all = await Promise.all(Array.from({ length: 20 }, (_, i) => wp.sendToUser(sha('u' + i), { title: 'x' })));
        ok(all.every(x => x.sent === 1) && P.maxActive <= DEF.maxConcurrent && P.maxActive >= 2, '全站并发 ≤' + DEF.maxConcurrent, P.maxActive);
        P.setDelay(0);
        // subject:VAPID_SUBJECT 优先;SITE_URL 不合法 → 默认
        P.reset();
        await mkWp(db, { env: { VAPID_SUBJECT: 'mailto:admin@example.com', SITE_URL: 'https://tv.example.com' } }).wp.sendToUser(TK.a, { title: 's' });
        ok(jwtOf(P.got[0].headers.authorization).payload.sub === 'mailto:admin@example.com', 'VAPID_SUBJECT 优先');
        P.reset();
        await mkWp(db, { env: { SITE_URL: 'http://localhost:3000' } }).wp.sendToUser(TK.a, { title: 's' });
        ok(jwtOf(P.got[0].headers.authorization).payload.sub === 'https://ednovas.video', 'SITE_URL 不是 https → 默认 subject');
    }
    // ---- 注入放宽白名单 ----
    {
        const db2 = new Database(':memory:');
        const strict = mkWp(db2);
        const loose = mkWp(db2, { allowHost: (h) => h === 'push.test' });
        const c = mkClient('https://push.test/ep1');
        P.clients.set('/ep1', c);
        r = await call(strict.app, 'POST', '/api/push/subscribe', { body: { token: TK.a, subscription: c.sub } });
        ok(r.statusCode === 400, '默认白名单拒 push.test');
        r = await call(loose.app, 'POST', '/api/push/subscribe', { body: { token: TK.a, subscription: c.sub } });
        ok(r.body && r.body.ok === true, '注入 allowHost 后收', r.body);
        P.reset();
        const rs = await loose.wp.sendToUser(TK.a, { title: 'loose' });
        ok(rs.sent === 1 && P.got[0].host === 'push.test' && P.got[0].plain && P.got[0].plain.title === 'loose', '发到放宽的主机', [rs, P.got[0] && P.got[0].host]);
        P.reset();
        const rs2 = await strict.wp.sendToUser(TK.a, { title: 'strict' });
        ok(rs2.removed === 1 && P.got.length === 0, '默认白名单的实例发前删掉它', rs2);
        db2.close();
    }
    // ---- 测试通知 ----
    {
        r = await call(app, 'POST', '/api/push/test', { body: { token: TK.a } });
        ok(r.body && r.body.ok === true && r.body.sent === 3, '测试通知', r.body);
        r = await call(app, 'POST', '/api/push/test', { body: { token: TK.a } });
        ok(r.statusCode === 429 && r.body.error === 'rate' && r.body.retry_after > 0 && r.body.retry_after <= 60, '1 分钟内第二次 429', r.body);
        NOW += 61e3;
        r = await call(app, 'POST', '/api/push/test', { body: { token: TK.a } });
        ok(r.body && r.body.ok === true, '一分钟后又能发', r.body);
        r = await call(app, 'POST', '/api/push/test', { body: { token: TK.b } });
        ok(r.body && r.body.ok === false && r.body.error === 'no_subscription', '没订阅 → no_subscription', r.body);
        r = await call(app, 'POST', '/api/push/test', { body: { token: TK.b } });
        ok(r.statusCode === 429, '没订阅也计次(防探测刷库)');
        r = await call(app, 'POST', '/api/push/test', { body: { token: 'nope' } });
        ok(r.statusCode === 401, '测试通知要登录');
        const plain = P.got.find(x => x.plain && x.plain.tag === 'test');
        ok(plain && plain.plain.title === '测试通知' && plain.plain.url === '/', '测试通知内容', plain && plain.plain);
    }
    db.close();

    // ---- lib/user-stats 批量改求片状态的回调 ----
    {
        const dbs = new Database(':memory:');
        const calls = [];
        let throwIt = false;
        const us = createUserStats({ db: () => dbs, adminAuthed: () => true, onRequestStatus: (rows) => { calls.push(...rows); if (throwIt) throw new Error('boom'); } });
        us._ensureSchema();
        const ins = dbs.prepare("INSERT INTO content_requests (user_token, name, status, created_at, updated_at) VALUES (?, ?, ?, 1, 1)");
        ins.run(TK.a, '片1', 'pending'); ins.run(TK.b, '片2', 'fulfilled'); ins.run(TK.a, '片3', 'need_info');
        const uApp = mkApp();
        us.registerRoutes(uApp);
        const bulk = (b) => call(uApp, 'POST', '/api/admin/requests/bulk', { body: b });
        r = await bulk({ ids: [1, 3], action: 'rejected', expect: 'pending' });
        ok(r.body.changed === 1 && calls.length === 1 && calls[0].id === 1 && calls[0].from === 'pending' && calls[0].to === 'rejected' && calls[0].user_token === TK.a && calls[0].name === '片1', '带预期状态:只报真改到的', [r.body, calls]);
        calls.length = 0;
        r = await bulk({ ids: [1, 2, 3], action: 'fulfilled', fulfill_link: 'magnet:?x' });
        ok(r.body.changed === 3 && calls.map(x => x.id + ':' + x.from).sort().join() === '1:rejected,3:need_info', '状态没变的(本来就 fulfilled)不报', calls);
        calls.length = 0;
        r = await bulk({ ids: [1], action: 'delete' });
        ok(r.body.changed === 1 && calls.length === 0, '删除不报');
        throwIt = true;
        r = await bulk({ ids: [2, 3], action: 'pending' });
        ok(r.statusCode === 200 && r.body.ok === true && r.body.changed === 2, '回调抛错不影响批量结果', r.body);
        const noCb = createUserStats({ db: () => dbs, adminAuthed: () => true });
        const a2 = mkApp(); noCb.registerRoutes(a2);
        r = await call(a2, 'POST', '/api/admin/requests/bulk', { body: { ids: [2], action: 'rejected' } });
        ok(r.body.ok === true && r.body.changed === 1, '没注入回调照常');
        dbs.close();
    }
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e));
}

// ---------------- ③ 端到端 ----------------
console.log('③ server.js 端到端');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));

const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
let srv = null, port = 0, srvLog = '', allLog = '';
async function startServer(extraEnv) {
    port = 20000 + Math.floor(Math.random() * 20000);
    srvLog = '';
    srv = spawn(process.execPath, ['server.js'], {
        cwd: tmp,
        env: Object.assign({}, process.env, {
            NODE_PATH, PORT: String(port), CACHE_TYPE: 'sqlite', ACCESS_PASSWORD: 'mainpw,alice,bob', ADMIN_TOKEN: 'adm',
            LIVE_TV_DISABLED: '1', KAZUMI_DISABLE: '1', CORS_PROXY_URL: '', REMOTE_DB_URL: '', TMDB_API_KEY: '', DANMU_API_URL: '', STATS_DISABLE: '', SITE_URL: '',
            FAV_CHECK_DISABLE: '1', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: ''
        }, extraEnv || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', d => { srvLog += d; allLog += d; });
    srv.stderr.on('data', d => { srvLog += d; allLog += d; });
    for (let i = 0; i < 100; i++) {
        await sleep(100);
        try { const r = await fetch(`http://127.0.0.1:${port}/api/debug`); if (r.ok) return; } catch (e) { }
    }
    throw new Error('server did not start:\n' + srvLog.slice(-2000));
}
async function stopServer() {
    if (!srv) return;
    const p = new Promise(r => srv.once('exit', r));
    srv.kill(); await p; srv = null;
}
const base = () => `http://127.0.0.1:${port}`;
async function api(method, p, o) {
    o = o || {};
    const headers = Object.assign({ 'user-agent': 'Mozilla/5.0 (E2E) Chrome/129' }, o.headers || {});
    let body;
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
    const r = await fetch(base() + p, { method, headers, body, redirect: 'manual' });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { }
    return { status: r.status, j, txt };
}
const E = { main: sha('mainpw'), alice: sha('alice'), bob: sha('bob') };
const dbFile = path.join(tmp, 'cache.db');
const waitFor = async (fn, ms) => { const t = Date.now() + (ms || 3000); while (Date.now() < t) { if (fn()) return true; await sleep(50); } return fn(); };
const dbGet = (sql, ...a) => { const d = new Database(dbFile, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const dbRun = (sql, ...a) => { const d = new Database(dbFile); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
// 钩子探针:往库里塞一条非法地址的订阅;钩子一触发 sendToUser,发前校验就会删掉它(不碰外网)
const probe = (token, tag) => { const c = mkClient('x'); dbRun('INSERT INTO push_subs (user_token, endpoint, p256dh, auth, created_at, fails) VALUES (?, ?, ?, ?, ?, 0)', token, 'https://probe.invalid/' + tag, c.sub.keys.p256dh, c.sub.keys.auth, Date.now()); };
const probeGone = (tag) => !dbGet('SELECT 1 x FROM push_subs WHERE endpoint = ?', 'https://probe.invalid/' + tag);

try {
    await startServer();
    let r = await api('GET', '/api/push/key');
    const K1 = r.j && r.j.publicKey;
    ok(r.j && r.j.enabled === true && Buffer.from(K1 || '', 'base64url').length === 65, 'GET /api/push/key', r.j);
    ok(await waitFor(() => /已自动生成 VAPID 密钥/.test(srvLog), 2000), '首次启动日志提示已生成密钥');
    r = await api('GET', '/api/config?token=' + E.alice);
    ok(r.j && r.j.push_enabled === true, '/api/config.push_enabled');
    await stopServer();
    await startServer();
    r = await api('GET', '/api/push/key');
    ok(r.j && r.j.publicKey === K1 && !/已自动生成 VAPID 密钥/.test(srvLog), '重启后密钥不变(存在 SQLite)', r.j);
    // 订阅
    const sub = (t, s) => api('POST', '/api/push/subscribe', { json: { token: t, subscription: s } });
    for (let i = 1; i <= 6; i++) {
        r = await sub(E.alice, mkClient('https://fcm.googleapis.com/fcm/send/e2e' + i).sub);
        if (!(r.j && r.j.ok)) break;
        await sleep(5);
    }
    ok(r.j && r.j.ok === true, 'HTTP 订阅', r.j);
    ok(dbGet('SELECT COUNT(*) n FROM push_subs WHERE user_token = ?', E.alice).n === 5 && !dbGet("SELECT 1 x FROM push_subs WHERE endpoint LIKE '%/e2e1'"), 'HTTP:最多 5 个,删最旧');
    for (const ep of ['http://fcm.googleapis.com/x', 'https://10.0.0.1/x', 'https://[::ffff:127.0.0.1]/x', 'https://metadata.google.internal/x', 'https://fcm.googleapis.com@127.0.0.1/x', 'https://fcm.googleapis.com:8080/x', 'https://web.push.apple.com./x', 'https://evil.com/fcm.googleapis.com']) {
        r = await sub(E.alice, mkClient(ep).sub);
        ok(r.status === 400 && r.j && r.j.error === 'endpoint', 'HTTP 拒收 ' + ep, r.j);
    }
    ok((await sub('constructor', mkClient('https://fcm.googleapis.com/fcm/send/z').sub)).status === 401, 'HTTP 原型键 token 401');
    r = await api('POST', '/api/push/unsubscribe', { json: { token: E.alice, endpoint: 'https://fcm.googleapis.com/fcm/send/e2e6' } });
    ok(r.j && r.j.ok && r.j.removed === 1, 'HTTP 退订', r.j);
    dbRun('DELETE FROM push_subs WHERE user_token = ?', E.alice);   // 之后不让任何东西往真 FCM 发
    // 测试通知(没订阅:不外发)+ 限流
    r = await api('POST', '/api/push/test', { json: { token: E.bob } });
    ok(r.j && r.j.ok === false && r.j.error === 'no_subscription', 'HTTP 测试通知:没订阅', r.j);
    r = await api('POST', '/api/push/test', { json: { token: E.bob } });
    ok(r.status === 429, 'HTTP 测试通知限流', r.status);
    // 求片状态变化 → 推送钩子(单条)
    r = await api('POST', '/api/requests', { json: { token: E.alice, name: '端到端求片' } });
    const rid = r.j && r.j.id;
    ok(r.j && r.j.ok === true && rid, '提交求片', r.j);
    probe(E.alice, 'same');
    r = await api('POST', '/api/requests/admin', { json: { admin: 'adm', id: rid, status: 'pending', fulfill_link: 'x' } });
    await sleep(400);
    ok(r.j && r.j.ok === true && !probeGone('same'), '状态没变(只改链接)→ 不推送');
    r = await api('POST', '/api/requests/admin', { json: { admin: 'adm', id: rid, status: 'fulfilled', fulfill_link: 'magnet:?xt=1' } });
    ok(r.j && r.j.ok === true && await waitFor(() => probeGone('same')), '单条改成 fulfilled → 推送钩子触发', r.j);
    // 批量
    r = await api('POST', '/api/requests', { json: { token: E.bob, name: '端到端求片2' } });
    const rid2 = r.j && r.j.id;
    probe(E.bob, 'bulk');
    probe(E.alice, 'bulk-a');
    r = await api('POST', '/api/admin/requests/bulk', { json: { ids: [rid, rid2], action: 'need_info' }, headers: { 'x-admin-token': 'adm' } });
    ok(r.j && r.j.ok === true && r.j.changed === 2 && await waitFor(() => probeGone('bulk') && probeGone('bulk-a')), '批量改成 need_info → 两个提交人都触发', r.j);
    probe(E.bob, 'bulk-pending');
    r = await api('POST', '/api/admin/requests/bulk', { json: { ids: [rid2], action: 'pending' }, headers: { 'x-admin-token': 'adm' } });
    await sleep(400);
    ok(r.j && r.j.changed === 1 && !probeGone('bulk-pending'), '改回 pending 不推送');
    dbRun('DELETE FROM push_subs');
    ok(!/\[WebPush\][^\n]*(失败|Error)|TypeError|ReferenceError|\[UserStats\] notify/.test(allLog), '服务端日志无异常', allLog.slice(-1500));
    await stopServer();
    // V2:发送闸门 —— 重启后机场令牌不在内存表(不再落盘)也照收推送;站长从 env 删掉的独立密码令牌不再收
    {
        const V2B = 'v2board_' + sha('restart@example.com');
        const now = Date.now();
        const insReq = (tk, name) => dbRun("INSERT INTO content_requests (user_token, name, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)", tk, name, now, now).lastInsertRowid;
        const idV = insReq(V2B, '机场用户的求片'), idB = insReq(E.bob, '独立密码用户的求片');
        await startServer({ ACCESS_PASSWORD: 'mainpw,alice' });   // 重启:内存表里没有任何机场令牌;站长删掉了 bob 的密码
        r = await api('GET', '/api/config?token=' + V2B);
        ok(r.j && r.j.sync_enabled === false, '前提:重启后机场令牌不在内存表(sync_enabled:false)', r.j);
        probe(V2B, 'v2b'); probe(E.bob, 'bob-gone');
        r = await api('POST', '/api/requests/admin', { json: { admin: 'adm', id: idV, status: 'fulfilled' } });
        ok(r.j && r.j.ok === true && await waitFor(() => probeGone('v2b')), '机场用户的求片有结果 → 不在内存表也照推(V2;上一版:静默不推)', r.j);
        r = await api('POST', '/api/requests/admin', { json: { admin: 'adm', id: idB, status: 'fulfilled' } });
        await sleep(400);
        ok(r.j && r.j.ok === true && !probeGone('bob-gone'), '密码已从 env 删掉的独立密码令牌 → 不推', r.j);
        r = await api('POST', '/api/push/subscribe', { json: { token: V2B, subscription: mkClient('https://fcm.googleapis.com/fcm/send/v2b').sub } });
        ok(r.status === 401, '接口鉴权不变:不在内存表的机场令牌不能订阅(要先 /check 重新登记)', r.status);
        dbRun('DELETE FROM push_subs');
        await stopServer();
    }
    // env 密钥优先;env 不成对 → 告警回退库里那对
    const envPair = webpushLib.generateVAPIDKeys();
    await startServer({ VAPID_PUBLIC_KEY: envPair.publicKey, VAPID_PRIVATE_KEY: envPair.privateKey, VAPID_SUBJECT: 'mailto:admin@example.com' });
    r = await api('GET', '/api/push/key');
    ok(r.j && r.j.publicKey === envPair.publicKey, 'env VAPID 密钥优先', r.j);
    await stopServer();
    await startServer({ VAPID_PUBLIC_KEY: envPair.publicKey, VAPID_PRIVATE_KEY: 'bad' });
    r = await api('GET', '/api/push/key');
    ok(r.j && r.j.publicKey === K1 && await waitFor(() => /VAPID_PUBLIC_KEY \/ VAPID_PRIVATE_KEY 无效或不成对/.test(srvLog), 2000), 'env 坏了 → 告警并回退自动生成的那对', r.j);
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e) + '\n' + srvLog.slice(-1500));
} finally {
    await stopServer();
    await P.close();
    loop.destroy();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

// 静态:单条求片接口在改状态处调用了钩子;Vercel 有桩
{
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(/onRequestStatus:\s*\(rows\)\s*=>\s*notifyRequestStatus\(rows\)/.test(src), 'server.js 把批量回调接到 notifyRequestStatus');
    const vsrc = fs.readFileSync(path.join(ROOT, 'api/index.js'), 'utf8');
    ok(/'\/api\/push\/subscribe'/.test(vsrc) && /publicKey:\s*null/.test(vsrc), 'api/index.js 推送桩');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
