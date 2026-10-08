// [v2board 分支专用] 机场同步令牌只活在内存 + 重启后靠 /check 重新登记 + /check 面板不可达 回归:node scripts/v2board-token-test.mjs
//  ① 令牌不落盘(V1):机场令牌 = 'v2board_' + 未加盐 sha256(邮箱),谁知道邮箱谁就算得出来。曾经存进 SQLite v2board_tokens 并在启动时恢复,
//     结果重启后任何知道某人邮箱的人都能读他的历史/收藏/求片、把他的推送订阅换成自己的(review3/email-token.mjs,已撤回)。
//     现在:不建表、不写、不恢复;早期测试版留下的 v2board_tokens 表原样留着但不再读(不删)。
//  ② 重启后怎么回来:/api/config?token= 报 sync_enabled:false → 前端每次页面加载补做一次 POST /api/auth/v2board/check
//     (用面板 auth_data,不是邮箱)→ 重新登记 → sync_enabled:true。
//  ③ /check 面板不可达(R4/V3):所有域名都没答上来 → {success:false, unreachable:true};
//     403 只有回包是 v2board 的 JSON(带字符串 message 的对象)才算令牌失效;Cloudflare 质询/1020(HTML、cf-mitigated)= 没答上来、试下一个域名;
//     404/405 = 没答上来(旧域名不再指向面板);业务 500/套餐过期/流量用尽/其它 4xx = 确定答复,形状不变、不带 unreachable。
//  端到端:临时目录起真正的 server.js,用 -r 预加载一个 axios 桩把"机场面板"的请求在进程内答掉(全程不碰外网),
//  走真实的 /api/auth/v2board 与 /api/auth/v2board/check。
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };
const Database = dep('better-sqlite3');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 600) : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const v2t = (email) => 'v2board_' + sha(email.toLowerCase());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2btok-'));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));
fs.writeFileSync(path.join(tmp, 'db.json'), JSON.stringify({ sites: [] }));
// 机场面板桩:域名表 → 两个假面板;登录 → auth_data;getSubscribe → 不限时套餐 + 邮箱(按授权串认人)
//   BEH:/check 的面板故障桩,令牌 → [第一个域名的表现, 第二个域名的表现]
fs.writeFileSync(path.join(tmp, 'v2b-stub.cjs'), `
const axios = require('axios');
const PANEL = 'https://panel.v2b.test', PANEL2 = 'https://panel2.v2b.test';
const USERS = { 'tok-alice': 'alice@example.com', 'tok-bob': 'Bob@Example.com' };
const BEH = {
    'tok-down': ['net', 'net'], 'tok-timeout': ['timeout', 'timeout'], 'tok-502': [502, 'net'], 'tok-html': ['html', 'timeout'],
    'tok-500gen': ['500gen', '500trace'], 'tok-429': [429, 503],
    'tok-gone': ['500biz', 'net'], 'tok-401': [401, 'net'], 'tok-mixed': ['net', 403], 'tok-exp': ['net', 'expired'], 'tok-traffic': ['traffic', 'net'],
    // V3:CDN/WAF 的 403 不是账号结论;404/405 是旧域名
    'tok-cf': ['cf403', 'cf1020'], 'tok-cfjson': ['cfjson403', 'net'], 'tok-empty403': ['empty403', 'timeout'],
    'tok-cfok': ['cf403', 'ok'], 'tok-cfexp': ['cf1020', 'v2b403'], 'tok-v2b403': ['v2b403', 'ok'],
    'tok-404': [404, 'net'], 'tok-405': ['json405', 'timeout'], 'tok-404ok': [404, 'ok'],
};
const httpErr = (st, data, headers) => { const e = new Error('Request failed with status code ' + st); e.response = { status: st, data, headers: headers || {} }; return e; };
function act(kind) {
    if (kind === 'net') { const e = new Error('connect ECONNREFUSED 10.255.255.1:443'); e.code = 'ECONNREFUSED'; throw e; }
    if (kind === 'timeout') { const e = new Error('timeout of 10000ms exceeded'); e.code = 'ECONNABORTED'; throw e; }
    if (kind === 'html') return { status: 200, data: '<html>domain parked</html>' };
    if (kind === '500gen') throw httpErr(500, { message: 'Server Error' });
    if (kind === '500trace') throw httpErr(500, { message: 'SQLSTATE[HY000] [2002] Connection refused', exception: 'PDOException', trace: [] });
    if (kind === '500biz') throw httpErr(500, { message: 'The user does not exist' });
    if (kind === 'expired') return { data: { data: { plan_id: 1, expired_at: 1000, u: 0, d: 0, transfer_enable: 0, email: 'exp@example.com' } } };
    if (kind === 'traffic') return { data: { data: { plan_id: 1, expired_at: 0, u: 10, d: 10, transfer_enable: 5, email: 'tr@example.com' } } };
    if (kind === 'ok') return { data: { data: { plan_id: 1, expired_at: 0, u: 0, d: 0, transfer_enable: 0, email: 'cf@example.com' } } };
    // Cloudflare 托管质询(Under Attack / Bot Fight):403 + HTML + cf-mitigated: challenge
    if (kind === 'cf403') throw httpErr(403, '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf challenge</body></html>', { 'cf-mitigated': 'challenge', server: 'cloudflare', 'content-type': 'text/html; charset=UTF-8' });
    // Cloudflare 1020(防火墙规则封了机房 IP):403 + HTML,只有 server: cloudflare
    if (kind === 'cf1020') throw httpErr(403, '<html><title>Attention Required! | Cloudflare</title>Error 1020 Access denied</html>', { server: 'cloudflare', 'content-type': 'text/html' });
    if (kind === 'cfjson403') throw httpErr(403, { message: 'challenge' }, { 'cf-mitigated': 'challenge', server: 'cloudflare' });
    if (kind === 'empty403') throw httpErr(403, '', { server: 'nginx' });
    // v2board 自己的令牌失效:abort(403, '未登录或登陆已过期') → Laravel JSON(面板在 Cloudflare 后面时照样带 server: cloudflare)
    if (kind === 'v2b403') throw httpErr(403, { message: '未登录或登陆已过期' }, { server: 'cloudflare', 'content-type': 'application/json' });
    if (kind === 'json405') throw httpErr(405, { message: 'The GET method is not supported for this route.' });
    if (typeof kind === 'number') throw httpErr(kind, kind >= 500 ? '<html>' + kind + '</html>' : { message: 'x' });
    throw new Error('bad stub kind ' + kind);
}
const og = axios.get.bind(axios), op = axios.post.bind(axios);
axios.get = async (url, cfg) => {
    url = String(url);
    if (/\\/domains\\.json$/.test(url)) return { data: [PANEL, PANEL2] };
    const auth = (cfg && cfg.headers && cfg.headers.Authorization) || '';
    const bases = [PANEL, PANEL2];
    for (let i = 0; i < bases.length; i++) {
        if (!url.startsWith(bases[i] + '/')) continue;
        if (url.startsWith(bases[i] + '/api/v1/user/getSubscribe')) {
            if (BEH[auth]) return act(BEH[auth][i]);
            const email = USERS[auth];
            if (!email) throw httpErr(403, { message: '未登录或登陆已过期' }, { 'content-type': 'application/json' });
            return { data: { data: { plan_id: 1, expired_at: 0, u: 0, d: 0, transfer_enable: 0, email, plan: { name: '测试套餐' } } } };
        }
        throw new Error('unexpected panel GET ' + url);
    }
    return og(url, cfg);
};
axios.post = async (url, body, cfg) => {
    url = String(url);
    if (url === PANEL + '/api/v1/passport/auth/login') {
        const tok = 'tok-' + String(body && body.email || '').split('@')[0].toLowerCase();
        if (body && body.password === 'pw' && USERS[tok]) return { data: { data: { auth_data: tok } } };
        return { data: { data: null } };
    }
    if (url.startsWith(PANEL + '/') || url.startsWith(PANEL2 + '/')) throw new Error('unexpected panel POST ' + url);
    return op(url, body, cfg);
};
`);

const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
let srv = null, port = 0, srvLog = '';
async function startServer(extraEnv) {
    port = 20000 + Math.floor(Math.random() * 20000);
    srvLog = '';
    srv = spawn(process.execPath, ['-r', './v2b-stub.cjs', 'server.js'], {
        cwd: tmp,
        env: Object.assign({}, process.env, {
            NODE_PATH, PORT: String(port), CACHE_TYPE: 'sqlite', ACCESS_PASSWORD: 'mainpw', ADMIN_TOKEN: 'adm',
            LIVE_TV_DISABLED: '1', KAZUMI_DISABLE: '1', CORS_PROXY_URL: '', REMOTE_DB_URL: '', TMDB_API_KEY: '', DANMU_API_URL: '',
            FAV_CHECK_DISABLE: '1', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: ''
        }, extraEnv || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', d => { srvLog += d; });
    srv.stderr.on('data', d => { srvLog += d; });
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
async function api(method, p, json) {
    const r = await fetch(`http://127.0.0.1:${port}` + p, { method, headers: json ? { 'content-type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { }
    return { status: r.status, j };
}
const dbFile = path.join(tmp, 'cache.db');
const syncOf = async (tk) => { const r = await api('GET', '/api/config?token=' + encodeURIComponent(tk)); return r.j && r.j.sync_enabled; };
const hasTable = () => { const d = new Database(dbFile, { readonly: true }); try { return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'v2board_tokens'").get(); } finally { d.close(); } };
// 推送订阅(合法格式的 FCM 地址;本测试从不触发发送)
const subOf = (ep) => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { endpoint: ep, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }; };

try {
    console.log('① 登录/复查照常;令牌不落盘(V1)');
    await startServer();
    let r = await api('POST', '/api/auth/v2board', { email: 'alice@example.com', password: 'pw' });
    const A = r.j && r.j.userToken;
    ok(r.j && r.j.success === true && A === v2t('alice@example.com'), '密码登录成功', r.j);
    ok(await syncOf(A) === true, '登录后 sync_enabled:true');
    r = await api('POST', '/api/auth/v2board/check', { v2boardToken: 'tok-bob' });
    const Bt = r.j && r.j.userToken;
    ok(r.j && r.j.success === true && Bt === v2t('bob@example.com') && !('unreachable' in r.j), '免密复查成功(按面板返回的邮箱生成令牌)', r.j);
    ok(await syncOf(Bt) === true, '复查后 sync_enabled:true');
    r = await api('POST', '/api/auth/v2board', { email: 'alice@example.com', password: 'wrong' });
    ok(r.j && r.j.success === false, '密码错误 → 失败', r.j);
    r = await api('POST', '/api/auth/v2board/check', { v2boardToken: 'tok-nobody' });
    ok(r.j && r.j.success === false && r.j.tokenExpired === true && !('unreachable' in r.j), '复查令牌无效(面板 JSON 403)→ tokenExpired,不带 unreachable', r.j);
    // 受害者在重启前留下的数据:一条求片 + 一个推送订阅
    r = await api('POST', '/api/requests', { token: A, name: '受害者的求片' });
    ok(r.j && r.j.ok === true, 'alice 提交求片', r.j);
    r = await api('POST', '/api/push/subscribe', { token: A, subscription: subOf('https://fcm.googleapis.com/fcm/send/alice-own') });
    ok(r.j && r.j.ok === true, 'alice 订阅推送', r.j);
    await stopServer();
    ok(!hasTable(), '登录/复查成功后库里没有 v2board_tokens 表(令牌不落盘)');
    // 早期测试版留下的表与行:原样留着,但不再读
    {
        const d = new Database(dbFile);
        d.exec('CREATE TABLE IF NOT EXISTS v2board_tokens (token TEXT PRIMARY KEY, checked_at INTEGER NOT NULL)');
        const ins = d.prepare('INSERT OR REPLACE INTO v2board_tokens (token, checked_at) VALUES (?, ?)');
        ins.run(A, Date.now()); ins.run(Bt, Date.now()); ins.run(v2t('old@example.com'), Date.now() - 86400e3);
        d.close();
    }

    console.log('② 重启后:只知道邮箱的人什么都拿不到;用户自己靠 /check 重新登记');
    await startServer();
    ok(await syncOf(A) === false && await syncOf(Bt) === false && await syncOf(v2t('old@example.com')) === false, '重启后机场令牌都不在内存表(旧表里的行不恢复)');
    ok(!/已恢复 \d+ 个机场同步令牌/.test(srvLog), '启动日志没有"恢复令牌"', srvLog.slice(-400));
    {
        // 攻击者只知道 alice 的邮箱:sha256 算出同步令牌(review3/email-token.mjs)
        const T = v2t('alice@example.com');
        r = await api('GET', '/api/favorites?token=' + T);
        ok(r.status === 401, '邮箱算出的令牌:GET /api/favorites → 401', r);
        r = await api('GET', '/api/history/pull?token=' + T);
        ok(r.status === 401, '邮箱算出的令牌:GET /api/history/pull → 401', r);
        r = await api('GET', '/api/requests/mine?token=' + T);
        ok(r.status === 401 && !JSON.stringify(r.j).includes('受害者的求片'), '邮箱算出的令牌:读不到求片', r);
        r = await api('POST', '/api/push/subscribe', { token: T, subscription: subOf('https://fcm.googleapis.com/fcm/send/ATTACKER') });
        ok(r.status === 401, '邮箱算出的令牌:不能把推送订阅换成自己的', r);
        const d = new Database(dbFile, { readonly: true });
        const eps = d.prepare('SELECT endpoint FROM push_subs WHERE user_token = ?').all(T).map(x => x.endpoint);
        d.close();
        ok(eps.length === 1 && eps[0].endsWith('/alice-own'), 'alice 自己的订阅还在、没被替换', eps);
    }
    // 用户自己:前端看到 sync_enabled:false → 用面板 auth_data 补做一次 /check → 重新登记
    r = await api('POST', '/api/auth/v2board/check', { v2boardToken: 'tok-alice', email: 'alice@example.com' });
    ok(r.j && r.j.success === true && r.j.userToken === A, '重启后 /check 成功', r.j);
    ok(await syncOf(A) === true, '/check 之后 sync_enabled:true');
    r = await api('GET', '/api/favorites?token=' + A);
    ok(r.status === 200 && r.j && r.j.enabled === true, '/check 之后服务器收藏照常', r.j);
    r = await api('GET', '/api/history/pull?token=' + A);
    ok(r.status === 200 && r.j && r.j.sync_enabled === true, '/check 之后历史同步照常', r.j);
    r = await api('GET', '/api/requests/mine?token=' + A);
    ok(r.status === 200 && r.j && r.j.requests.some(x => x.name === '受害者的求片'), '/check 之后自己的求片照常', r.j);
    ok(await syncOf(Bt) === false, '没复查的 bob 仍不在内存表');
    await stopServer();
    {
        const d = new Database(dbFile, { readonly: true });
        const n = d.prepare('SELECT COUNT(*) n FROM v2board_tokens').get().n;
        const fresh = d.prepare('SELECT checked_at FROM v2board_tokens WHERE token = ?').get(v2t('old@example.com'));
        d.close();
        ok(n === 3 && fresh && fresh.checked_at < Date.now() - 3600e3, '旧表原样留着:不删、不写、不更新', n);
    }

    console.log('③ /check 面板不可达 vs 面板给了确定答复(R4/V3)');
    await startServer();
    const check = async (tok) => (await api('POST', '/api/auth/v2board/check', { v2boardToken: tok })).j;
    const flags = (j) => ['tokenExpired', 'expired', 'trafficExhausted', 'userToken'].filter(k => j && k in j);
    for (const [tok, why] of [
        ['tok-down', '两个域名都连不上'], ['tok-timeout', '两个域名都超时'], ['tok-502', '网关 502 + 连不上'],
        ['tok-html', '2xx 停放页(不是订阅数据)+ 超时'], ['tok-500gen', 'Laravel 崩溃页 500(Server Error / 调试模式 exception+trace)'],
        ['tok-429', '面板按我们服务器 IP 限流 429 + 503'],
        ['tok-cf', '两个域名都是 Cloudflare 403(质询 cf-mitigated / 1020 封 IP,HTML)'],
        ['tok-cfjson', 'Cloudflare 403 带 cf-mitigated(哪怕回包像 JSON)+ 连不上'],
        ['tok-empty403', '403 空回包 + 超时'],
        ['tok-404', '旧域名 404 + 连不上'], ['tok-405', '旧域名 405 + 超时'],
    ]) {
        const j = await check(tok);
        ok(j && j.success === false && j.unreachable === true && typeof j.message === 'string' && j.message && flags(j).length === 0, 'unreachable:' + why, j);
    }
    {
        let j = await check('tok-cfok');
        ok(j && j.success === true && j.userToken === v2t('cf@example.com') && !('unreachable' in j), '第一个域名被 Cloudflare 403 拦、第二个正常答复 → 用第二个的答复(以前:tokenExpired 直接登出)', j);
        j = await check('tok-cfexp');
        ok(j && j.success === false && j.tokenExpired === true && !('unreachable' in j), '第一个域名 Cloudflare 1020、第二个是面板 JSON 403 → tokenExpired', j);
        j = await check('tok-v2b403');
        ok(j && j.success === false && j.tokenExpired === true && !('unreachable' in j), '面板 JSON 403(未登录或登陆已过期,经 Cloudflare 转发)→ tokenExpired,不再试下一个域名', j);
        j = await check('tok-404ok');
        ok(j && j.success === true && j.userToken === v2t('cf@example.com'), '旧域名 404、第二个正常 → 成功', j);
        j = await check('tok-gone');
        ok(j && j.success === false && !('unreachable' in j) && typeof j.message === 'string' && flags(j).length === 0, '面板业务 500(账号已删)= 确定答复 → 形状不变,不带 unreachable', j);
        j = await check('tok-401');
        ok(j && j.success === false && !('unreachable' in j) && typeof j.message === 'string', '其它 4xx(401)= 面板答复了 → 不带 unreachable', j);
        j = await check('tok-mixed');
        ok(j && j.success === false && j.tokenExpired === true && !('unreachable' in j), '第一个域名连不上、第二个答 JSON 403 → tokenExpired', j);
        j = await check('tok-exp');
        ok(j && j.success === false && j.expired === true && !('unreachable' in j), '第一个域名连不上、第二个答套餐过期 → expired', j);
        j = await check('tok-traffic');
        ok(j && j.success === false && j.trafficExhausted === true && !('unreachable' in j), '流量用尽 → trafficExhausted', j);
    }
    ok(!/TypeError|ReferenceError/.test(srvLog), '服务端日志无异常', srvLog.slice(-800));
    await stopServer();

    console.log('④ 没有 SQLite:同样只活在内存');
    await startServer({ CACHE_TYPE: 'json' });
    r = await api('POST', '/api/auth/v2board', { email: 'alice@example.com', password: 'pw' });
    ok(r.j && r.j.success === true && await syncOf(A) === true, 'json 模式登录照常');
    r = await api('POST', '/api/auth/v2board/check', { v2boardToken: 'tok-down' });
    ok(r.j && r.j.success === false && r.j.unreachable === true, 'json 模式 /check 面板不可达同样带 unreachable', r.j);
    await stopServer();
    await startServer({ CACHE_TYPE: 'json' });
    ok(await syncOf(A) === false, 'json 模式重启后不在内存表');
    r = await api('POST', '/api/auth/v2board/check', { v2boardToken: 'tok-alice' });
    ok(r.j && r.j.success === true && await syncOf(A) === true, 'json 模式 /check 重新登记');
    ok(!/TypeError|ReferenceError/.test(srvLog), 'json 模式无异常', srvLog.slice(-800));
    await stopServer();
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e) + '\n' + srvLog.slice(-1500));
} finally {
    await stopServer();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

// 静态:server.js 不再有任何读写 v2board_tokens 的代码;/check 的 403 先过 v2boardTokenRejected
{
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(!/(INTO|FROM|EXISTS)\s+v2board_tokens/.test(src) && !/persistV2boardToken|restoreV2boardTokens|V2BOARD_TOKEN_KEEP_MS/.test(src), 'server.js:没有令牌落盘/恢复代码');
    ok(!/status\s*===\s*403\)\s*\{\s*\/\/\s*Token 过期/.test(src) && /if \(v2boardTokenRejected\(err\)\)/.test(src), '/check:403 只认面板 JSON(v2boardTokenRejected)');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
