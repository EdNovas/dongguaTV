// [adult] p4 资源站换域名跟随(lib/adult-mirror)回归 —— 零外网:httpGet / DNS / 时钟 / 存储全部注入,域名全是虚构的
//  ① SSRF 闸门:内网 / 回环 / 链路本地 / CGNAT / 组播 / 保留段;IPv6 ::1 / fc00::/7 / fe80::/10 / IPv4 映射 / NAT64 / 6to4 / Teredo;
//     十进制 / 八进制 / 十六进制 / 简写 主机名;URL 里带账号密码;非 http(s);DNS 解析到内网(含"一个公网一个内网")
//  ② 换源阈值:30 分钟内连续 ≥3 次计数类失败才换;成功清零;4xx / other 不计;分散超过 30 分钟不换;过期上报(旧地址)忽略
//  ③ 指纹:停放页 / HTML 拒;别家片库(时间重叠、片名不同)拒;同一片库(片名重合 ≥3)收;"太新"时按分类表 Jaccard 收 / 拒
//  ④ 发现:旧 api 地址的 3xx Location;旧站根页里的链接 / 裸域名(只拼同一个 api 路径;垃圾主机不探;内网链接被 SSRF 拒)
//  ⑤ SSRF:配置的镜像解析到内网 / 带账号密码 / 十进制 IP → 拒,而且一次都不连
//  ⑥ 探测限流:每站每小时 ≤10 个出网请求;下一轮从游标接着试;重启不清零
//  ⑦ 持久化:换到镜像后重启仍用镜像;站点表主地址改了 → 状态作废
//  ⑧ 回切:6 小时后主地址验过(maccms + 指纹)才切回;主地址被停放 → 不切回
//  ⑨ 手动 probe;没快照时只认配置的镜像;makeSafeHttpGet 拒内网(不连);safeLookup 拒 localhost;classifyError;fileStore
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const M = require(path.join(ROOT, 'lib/adult-mirror'));
const { ssrf } = M;
const FIX = path.join(ROOT, 'scripts/fixtures/mirror');
const CAT = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogs.json'), 'utf8'));
const PARKING = fs.readFileSync(path.join(FIX, 'parking.html'), 'utf8');
const ROOT_LINKS = fs.readFileSync(path.join(FIX, 'root-links.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
    if (c) { pass++; return true; }
    fail++;
    console.log('  ✗ ' + msg + (extra !== undefined ? '  →  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 700) : ''));
    return false;
};
const listBody = (items, classes) => JSON.stringify({ code: 1, msg: '数据列表', page: 1, pagecount: 1, limit: '20', total: items.length, list: items, class: classes || [] });
const A = (cls) => listBody(CAT.A, cls === undefined ? CAT.classes_a : cls);

// ---------------------------------------------------------------- ① SSRF
console.log('① SSRF 闸门');
{
    const pub = ['8.8.8.8', '1.1.1.1', '100.128.0.1', '100.63.255.255', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2a00:1450:4001::1'];
    const priv = ['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255', '169.254.169.254', '0.0.0.0', '224.0.0.1', '239.255.255.250',
        '255.255.255.255', '240.0.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.9', '192.0.0.8',
        '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
        '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1', '2002:a00:1::1', '2001::1', '2001:0:4136:e378::1', '2001:db8::1', '::127.0.0.1', '100::1', 'not-an-ip', ''];
    ok(pub.every(ssrf.isPublicIp), '公网地址放行', pub.filter((x) => !ssrf.isPublicIp(x)));
    ok(priv.every((x) => !ssrf.isPublicIp(x)), '内网 / 回环 / 链路本地 / CGNAT / 组播 / 保留 / 文档段 / IPv6 本地 / IPv4 映射 / NAT64 / 6to4 / Teredo 一律拒', priv.filter(ssrf.isPublicIp));
    const S = (u) => { const r = ssrf.checkUrlStatic(u); return r.ok ? 'ok' : r.reason; };
    const tricks = ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://0x7f000001/', 'http://127.1/', 'http://017700000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
        'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[fe80::1%25eth0]/', 'http://[fd00::1]:8080/', 'http://100.64.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://0/', 'http://0.0.0.0:80/'];
    ok(tricks.every((u) => S(u) === 'private-ip' || S(u) === 'bad-url'), '十进制 / 八进制 / 十六进制 / 简写 / IPv6 字面量 / 元数据地址 → 拒', tricks.map((u) => [u, S(u)]).filter((x) => x[1] === 'ok'));
    ok(S('http://user:pw@8.8.8.8/') === 'userinfo' && S('http://user@zyx-good.com/') === 'userinfo' && S('https://:pw@zyx-good.com/') === 'userinfo', 'URL 带账号密码 → 拒', [S('http://user:pw@8.8.8.8/'), S('http://user@zyx-good.com/')]);
    ok(['ftp://zyx-good.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://zyx-good.com/', 'data:text/plain,x'].every((u) => S(u) === 'scheme' || S(u) === 'bad-url'), '非 http(s) → 拒');
    ok(['http://localhost/', 'http://LOCALHOST./', 'http://foo.localhost/', 'http://printer.local/', 'http://db.internal/', 'http://intranet/', 'http://x.test/', 'http://a.b.onion/'].every((u) => S(u) === 'bad-host'), 'localhost / .local / .internal / 单标签主机 → 拒');
    ok(S('http://8.8.8.8/api.php/provide/vod') === 'ok' && S('https://zyx-good.com:8443/api.php/provide/vod') === 'ok', '公网 IP / 普通域名(任意端口)放行');
    const dnsMap = { 'zyx-good.com': ['93.184.216.34'], 'rebind.zyx': ['10.0.0.5'], 'mixed.zyx': ['93.184.216.34', '127.0.0.1'], 'v6local.zyx': ['::1'], 'empty.zyx': [] };
    const resolve = async (h) => { if (h === 'nx.zyx') throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return dnsMap[h] || ['93.184.216.34']; };
    const C = async (u) => { const r = await ssrf.checkUrl(u, resolve); return r.ok ? 'ok' : r.reason; };
    ok(await C('https://zyx-good.com/x') === 'ok' && await C('https://rebind.zyx/x') === 'private-ip' && await C('https://mixed.zyx/x') === 'private-ip' && await C('https://v6local.zyx/x') === 'private-ip'
        && await C('https://nx.zyx/x') === 'dns' && await C('https://empty.zyx/x') === 'dns', 'DNS 解析到内网(含"一个公网一个内网")/ 解析不到 → 拒',
    [await C('https://rebind.zyx/x'), await C('https://mixed.zyx/x'), await C('https://nx.zyx/x'), await C('https://empty.zyx/x')]);
    // safeLookup(连接时再判):localhost 解析到回环 → EPRIVATE
    const lk = await new Promise((r) => ssrf.safeLookup('localhost', { all: true }, (e, a) => r(e ? e.code : a)));
    ok(lk === 'EPRIVATE', 'safeLookup:localhost(回环)→ EPRIVATE', lk);
    // 默认 httpGet:静态检查就拒,不连(本机起个服务器看它收没收到请求)
    const http = await import('http');
    let hits = 0;
    const srv = http.createServer((q, s) => { hits++; s.end('{"list":[]}'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const g = M.makeSafeHttpGet();
    let err = null;
    try { await g(`http://127.0.0.1:${srv.address().port}/api.php/provide/vod?ac=list`); } catch (e) { err = e; }
    let err2 = null;
    try { await g(`http://localhost:${srv.address().port}/api.php/provide/vod?ac=list`); } catch (e) { err2 = e; }
    srv.close();
    ok(err && err.code === 'EREFUSED' && err2 && (err2.code === 'EREFUSED' || err2.code === 'EPRIVATE') && hits === 0, 'makeSafeHttpGet:回环 IP / localhost 一律拒,服务器一个请求都没收到', [err && err.code, err2 && err2.code, hits]);
}

// ---------------------------------------------------------------- 假互联网
// routes:url(精确,含 query)或 'GET <origin>/' → 处理函数;DNS:host → [ip]
function makeNet() {
    const routes = new Map();
    const dns = new Map();
    const log = [];
    const httpGet = async (url) => {
        log.push(url);
        const h = routes.get(url);
        if (!h) return { status: 404, headers: { 'content-type': 'text/html' }, data: '<html>404</html>' };
        const r = await h(url);
        if (r instanceof Error) throw r;
        return r;
    };
    const resolve = async (host) => {
        if (dns.has(host)) { const v = dns.get(host); if (v instanceof Error) throw v; return v; }
        return ['93.184.216.34'];
    };
    const json = (body) => () => ({ status: 200, headers: { 'content-type': 'application/json' }, data: body });
    const html = (body, st) => () => ({ status: st || 200, headers: { 'content-type': 'text/html' }, data: body });
    const redirect = (loc, st) => () => ({ status: st || 301, headers: { location: loc }, data: '' });
    const err = (code) => () => Object.assign(new Error(code), { code });
    return { routes, dns, log, httpGet, resolve, json, html, redirect, err };
}
const memStore = () => { const box = { obj: {} }; return { box, load: () => JSON.parse(JSON.stringify(box.obj)), save: (o) => { box.obj = JSON.parse(JSON.stringify(o)); } }; };
const clock = () => { const c = { t: Date.UTC(2026, 10, 20, 12, 0, 0) }; c.now = () => c.t; return c; };
const settle = async (m) => { for (let i = 0; i < 200; i++) { await new Promise((r) => setImmediate(r)); if (![...m._state.values()].some((s) => s.busy)) return; } };
const API = (host, p) => `https://${host}${p || '/api.php/provide/vod'}`;
const LIST = (api) => api + '?ac=list';
const SAMPLE = (api) => api + '?ac=detail&h=24&pagesize=20&pg=1';

// ---------------------------------------------------------------- ② 阈值 + ③ 指纹 + ⑤ SSRF(配置的镜像)
console.log('② 换源阈值 / ③ 指纹 / ⑤ 配置镜像的 SSRF');
{
    const N = makeNet(), C = clock(), st = memStore();
    const P = API('alphazy1.com');
    const mirrors = [
        API('alpha-parked.com'),           // 停放页(HTML)
        API('alpha-other.com'),            // 别家片库(时间重叠、片名不同、分类表同模板)
        'https://user:pw@alphazy5.com/api.php/provide/vod',   // 带账号密码(https:主地址是 https,http 的配置镜像会被挪到最后兜底,见 ⑤b)
        'https://2130706433/api.php/provide/vod',            // 十进制 127.0.0.1
        API('alpha-rebind.com'),           // DNS → 内网
        API('alphazy2.com'),               // 真镜像(同一片库,条目往前挪了两条)
    ];
    N.routes.set(LIST(API('alpha-parked.com')), N.html(PARKING));
    N.routes.set(LIST(API('alpha-other.com')), N.json(listBody(CAT.B, CAT.classes_a)));
    N.dns.set('alpha-rebind.com', ['10.0.0.9']);
    N.routes.set(LIST(API('alpha-rebind.com')), N.json(A()));
    N.routes.set(LIST(API('alphazy2.com')), N.json(listBody(CAT.A_shift2, CAT.classes_a)));
    const m = M.createMirror({ sites: [{ key: 'av_a', api: P, mirrors }], httpGet: N.httpGet, resolve: N.resolve, now: C.now, store: st });
    ok(m.apiFor('av_a') === P && m.apiFor('nope') === null, 'apiFor:初始 = 主地址;不认识的站 → null');
    m.report('av_a', true, 'ok', { url: SAMPLE(P), data: JSON.parse(A()) });
    ok(m.status()[0].snapshot === true, '成功的最新一页样本 → 指纹快照', m.status()[0]);
    // 阈值
    m.report('av_a', false, 'timeout', { url: SAMPLE(P) }); m.report('av_a', false, '5xx', { url: SAMPLE(P) });
    m.report('av_a', false, '4xx', { url: SAMPLE(P) }); m.report('av_a', false, 'other', { url: SAMPLE(P) });
    await settle(m);
    ok(N.log.length === 0 && m.apiFor('av_a') === P, '2 次计数类失败 + 4xx/other → 不换源(一个请求都不发)', N.log);
    m.report('av_a', true, 'ok', { url: SAMPLE(P) });
    m.report('av_a', false, 'dns', { url: SAMPLE(P) }); m.report('av_a', false, 'conn', { url: SAMPLE(P) });
    await settle(m);
    ok(N.log.length === 0, '成功一次清零:之后再 2 次失败仍不换', N.log);
    C.t += 31 * 60e3;
    m.report('av_a', false, 'body', { url: SAMPLE(P) });
    await settle(m);
    ok(N.log.length === 0, '3 次失败分散超过 30 分钟 → 不换', N.log);
    m.report('av_a', false, 'timeout', { url: SAMPLE(P) });
    m.report('av_a', false, 'timeout', { url: SAMPLE(P) });
    await settle(m);
    const s1 = m.status()[0];
    ok(m.apiFor('av_a') === API('alphazy2.com') && s1.reason === 'failover' && s1.current === API('alphazy2.com'), '30 分钟内连续 3 次 → 换到验证通过的镜像', s1);
    const tried = Object.fromEntries(m._state.get('av_a').tried.map((x) => [x.url, x.reason]));
    ok(tried[API('alpha-parked.com')] === 'not-json', '停放页(HTML)→ 拒 not-json', tried);
    ok(tried[API('alpha-other.com')] === 'names-mismatch', '别家片库(时间重叠、片名全不同,分类表同模板)→ 拒 names-mismatch', tried);
    ok(tried[mirrors[2]] === 'ssrf:userinfo' && tried[mirrors[3]] === 'ssrf:private-ip' && tried[API('alpha-rebind.com')] === 'ssrf:private-ip', 'SSRF:带账号密码 / 十进制回环 / DNS 指向内网 → 拒', tried);
    ok(!N.log.some((u) => /alpha-rebind|2130706433|alphazy5/.test(u)), '…被 SSRF 拒的候选一次都没连', N.log);
    ok(N.log.every((u) => /\?ac=list$/.test(u)), '验证只发 ?ac=list', N.log);
    ok(st.box.obj.sites && st.box.obj.sites.av_a && st.box.obj.sites.av_a.current === API('alphazy2.com'), '换源立即落盘', st.box.obj);
    // 过期上报:换源前发出的、旧地址的失败不算到新地址头上
    const n0 = N.log.length;
    for (let i = 0; i < 5; i++) m.report('av_a', false, 'timeout', { url: SAMPLE(P) });
    await settle(m);
    ok(N.log.length === n0 && m.apiFor('av_a') === API('alphazy2.com'), '旧地址的过期上报忽略', N.log.slice(n0));
    // ⑦ 持久化:重启后仍用镜像;探测预算也带过去
    const m2 = M.createMirror({ sites: [{ key: 'av_a', api: P, mirrors }], httpGet: N.httpGet, resolve: N.resolve, now: C.now, store: st });
    ok(m2.apiFor('av_a') === API('alphazy2.com') && m2.status()[0].budgetLeft === m.status()[0].budgetLeft, '重启:仍用镜像、探测预算不清零', [m2.apiFor('av_a'), m2.status()[0].budgetLeft, m.status()[0].budgetLeft]);
    const m3 = M.createMirror({ sites: [{ key: 'av_a', api: API('alphazy9.com'), mirrors }], httpGet: N.httpGet, resolve: N.resolve, now: C.now, store: st });
    ok(m3.apiFor('av_a') === API('alphazy9.com'), '站点表里主地址改了 → 旧状态作废,用新主地址');
}

// ---------------------------------------------------------------- ③ "太新"的指纹:按分类表
console.log('③ 太新的指纹(分类表 Jaccard)');
{
    for (const [label, classes, want] of [['分类表相同 → 收', CAT.classes_a, true], ['分类表不同(抢注的域名换了别家片库)→ 拒', CAT.classes_other, false]]) {
        const N = makeNet(), C = clock();
        const P = API('deltazy1.com');
        N.routes.set(LIST(API('deltazy2.com')), N.json(listBody(CAT.A_fresh, classes)));
        const m = M.createMirror({ sites: [{ key: 'd', api: P, mirrors: [API('deltazy2.com')] }], httpGet: N.httpGet, resolve: N.resolve, now: C.now });
        m.report('d', true, 'ok', { url: P + '?ac=list', data: JSON.parse(A()) });
        C.t = Date.UTC(2026, 10, 23, 12, 0, 0);   // 过了三天(A_fresh 是 11-23 上午的条目)
        for (let i = 0; i < 3; i++) m.report('d', false, 'timeout', { url: SAMPLE(P) });
        await settle(m);
        const t = m._state.get('d').tried[0] || {};
        ok((m.apiFor('d') === API('deltazy2.com')) === want && (want ? t.reason === 'classes' : t.reason === 'classes-mismatch'), '候选全是更新的条目:' + label, t);
    }
    {   // 修订:候选把上架时间报到未来(比现在晚 10 小时以上)→ 不走"太新"的分类表比对(抄一份公开分类表 + 写未来时间就能冒充)
        const N = makeNet(), C = clock();
        const P = API('deltazy1.com');
        N.routes.set(LIST(API('deltazy2.com')), N.json(listBody(CAT.A_fresh, CAT.classes_a)));
        const m = M.createMirror({ sites: [{ key: 'd', api: P, mirrors: [API('deltazy2.com')] }], httpGet: N.httpGet, resolve: N.resolve, now: C.now });
        m.report('d', true, 'ok', { url: P + '?ac=list', data: JSON.parse(A()) });
        for (let i = 0; i < 3; i++) m.report('d', false, 'timeout', { url: SAMPLE(P) });   // 现在还是 11-20,候选报的是 11-23
        await settle(m);
        const t = m._state.get('d').tried[0] || {};
        ok(m.apiFor('d') === P && t.reason === 'future-times', '候选的上架时间在未来(分类表一样也不收)', t);
        const snap = { names: ['x1', 'x2', 'x3'], maxTime: Date.UTC(2026, 10, 20, 10, 0, 0), classes: ['1:a', '2:b', '3:c'] };
        const cand = (h) => ({ names: ['y1', 'y2'], minTime: Date.UTC(2026, 10, 20, 11, 0, 0), maxTime: Date.UTC(2026, 10, 20, 12 + h, 0, 0), classes: ['1:a', '2:b', '3:c'] });
        const now = Date.UTC(2026, 10, 20, 12, 0, 0);
        ok(M.fingerprint(snap, cand(8), now).ok === true && M.fingerprint(snap, cand(11), now).reason === 'future-times', 'fingerprint:北京时间(看起来晚 8 小时)照收;晚 10 小时以上 = future-times',
            [M.fingerprint(snap, cand(8), now), M.fingerprint(snap, cand(11), now)]);
    }
    // 快照只有片名、没有分类表(样本是 ac=detail)→ 太新的候选拒
    const N = makeNet(), C = clock();
    const P = API('epsilonzy1.com');
    N.routes.set(LIST(API('epsilonzy2.com')), N.json(listBody(CAT.A_fresh, CAT.classes_a)));
    const m = M.createMirror({ sites: [{ key: 'e', api: P, mirrors: [API('epsilonzy2.com')] }], httpGet: N.httpGet, resolve: N.resolve, now: C.now });
    m.report('e', true, 'ok', { url: SAMPLE(P), data: { list: CAT.A } });
    for (let i = 0; i < 3; i++) m.report('e', false, 'timeout', { url: SAMPLE(P) });
    await settle(m);
    ok(m.apiFor('e') === P, '快照没有分类表时,太新的候选不收(宁可不换)', m._state.get('e').tried);
}

// ---------------------------------------------------------------- ④ 发现
console.log('④ 发现:跳转 Location / 根页链接');
{
    // 旧 api 地址 301 → 新域名(Location 带了别的路径和参数:只取源站,拼同一个 api 路径)
    const N = makeNet(), C = clock();
    const P = API('betazy1.com');
    N.routes.set(P, N.redirect('https://betazy2.com/index.php?from=old'));
    N.routes.set(LIST(API('betazy2.com')), N.json(A()));
    const m = M.createMirror({ sites: [{ key: 'b', api: P }], httpGet: N.httpGet, resolve: N.resolve, now: C.now });
    m.report('b', true, 'ok', { url: SAMPLE(P), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m.report('b', false, '5xx', { url: SAMPLE(P) });
    await settle(m);
    ok(m.apiFor('b') === API('betazy2.com') && N.log.includes(LIST(API('betazy2.com'))) && !N.log.some((u) => /index\.php/.test(u)), '旧 api 地址的 301 Location → 新域名 + 同一个 api 路径', [m.apiFor('b'), N.log]);
    // 根页 302 → 新域名
    const N2 = makeNet(), C2 = clock();
    const P2 = API('betaxx1.com');
    N2.routes.set(P2, N2.html('<html>gone</html>', 410));
    N2.routes.set('https://betaxx1.com/', N2.redirect('/new-home', 302));   // 同源跳转不算
    N2.routes.set(LIST(API('betaxx1.com')), N2.err('ETIMEDOUT'));
    const m2 = M.createMirror({ sites: [{ key: 'b2', api: P2 }], httpGet: N2.httpGet, resolve: N2.resolve, now: C2.now });
    m2.report('b2', true, 'ok', { url: SAMPLE(P2), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m2.report('b2', false, 'timeout', { url: SAMPLE(P2) });
    await settle(m2);
    ok(m2.apiFor('b2') === P2 && m2.status()[0].reason === 'no-valid-mirror' && N2.log.length === 2, '同源跳转不算候选 → 没找到(只花了 2 个请求)', [m2.status()[0], N2.log]);

    // 根页链接:只拼同一个 api 路径;垃圾主机(CDN / 统计)不探;内网链接被 SSRF 拒;同前缀的域名优先
    const N3 = makeNet(), C3 = clock();
    const P3 = API('gammazy1.com');
    N3.routes.set(P3, N3.html('<html>Service Unavailable</html>', 503));
    N3.routes.set('https://gammazy1.com/', N3.html(ROOT_LINKS));
    N3.routes.set(LIST(API('gammazy9.com')), N3.html('<html>not here</html>', 404));            // 链接指的新站,api 不在这个路径
    N3.routes.set(LIST(API('gammazy7.com')), N3.json(listBody(CAT.A_shift2, CAT.classes_a)));   // 正文裸域名:同一片库 → 收
    N3.routes.set(LIST('https://gammaxx-pathonly.com/api/vod'), N3.json(A()));                 // 片库在别的路径:永远不该被探到
    const m3 = M.createMirror({ sites: [{ key: 'g', api: P3 }], httpGet: N3.httpGet, resolve: N3.resolve, now: C3.now });
    m3.report('g', true, 'ok', { url: SAMPLE(P3), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m3.report('g', false, '5xx', { url: SAMPLE(P3) });
    await settle(m3);
    ok(m3.apiFor('g') === API('gammazy7.com'), '根页公告里的裸域名(与旧域名同前缀)→ 同一 api 路径验证通过 → 切过去', [m3.apiFor('g'), N3.log]);
    ok(!N3.log.some((u) => /jsdelivr|googletagmanager|sedo|parkingcrew/.test(u)), '垃圾主机(CDN / 统计 / 停放商)一个都不探', N3.log);
    ok(N3.log.filter((u) => /\?ac=list$/.test(u)).every((u) => u.endsWith('/api.php/provide/vod?ac=list')) && !N3.log.some((u) => /\/api\/vod/.test(u)), '候选一律是 新源站 + 同一个 api 路径', N3.log);
    ok(N3.log.indexOf(LIST(API('gammazy9.com'))) >= 0 && N3.log.indexOf(LIST(API('gammazy9.com'))) < N3.log.indexOf(LIST(API('gammazy7.com'))), '同前缀的域名先探', N3.log);
    // 同一个根页、但同前缀的两个都不对 → 继续探别的链接:内网链接被 SSRF 拒(不连),别家片库被指纹拒
    const N4 = makeNet(), C4 = clock();
    const P4 = API('gammazy1.com');
    N4.routes.set(P4, N4.html('<html>Service Unavailable</html>', 503));
    N4.routes.set('https://gammazy1.com/', N4.html(ROOT_LINKS));
    N4.routes.set(LIST('https://evil-other.net/api.php/provide/vod'), N4.json(listBody(CAT.B, CAT.classes_a)));
    N4.dns.set('img.gammacdn-static.com', ['192.168.3.3']);
    const m4 = M.createMirror({ sites: [{ key: 'g', api: P4 }], httpGet: N4.httpGet, resolve: N4.resolve, now: C4.now });
    m4.report('g', true, 'ok', { url: SAMPLE(P4), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m4.report('g', false, '5xx', { url: SAMPLE(P4) });
    await settle(m4);
    const t4 = Object.fromEntries(m4._state.get('g').tried.map((x) => [x.url, x.reason]));
    ok(m4.apiFor('g') === P4 && t4['https://evil-other.net/api.php/provide/vod'] === 'names-mismatch' && t4['http://10.0.0.7/api.php/provide/vod'] === 'ssrf:private-ip'
        && t4['https://img.gammacdn-static.com/api.php/provide/vod'] === 'ssrf:private-ip' && !N4.log.some((u) => /10\.0\.0\.7|gammacdn-static/.test(u)),
    '根页里的别家片库 → 指纹拒;内网 IP 链接 / 解析到内网的链接 → SSRF 拒且不连;最后不换', [m4.apiFor('g'), t4, N4.log]);
    // 停放页的根页:没有可用链接
    const N5 = makeNet(), C5 = clock();
    const P5 = API('zetazy1.com');
    N5.routes.set(P5, N5.html(PARKING));
    N5.routes.set('https://zetazy1.com/', N5.html(PARKING));
    const m5 = M.createMirror({ sites: [{ key: 'z', api: P5 }], httpGet: N5.httpGet, resolve: N5.resolve, now: C5.now });
    m5.report('z', true, 'ok', { url: SAMPLE(P5), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m5.report('z', false, 'body', { url: SAMPLE(P5) });
    await settle(m5);
    ok(m5.apiFor('z') === P5 && N5.log.length === 2, '域名被停放:停放页里只有停放商 / 统计链接 → 不探、不换', N5.log);
    // 没快照:发现的候选一律拒(只认配置的镜像)
    const N6 = makeNet(), C6 = clock();
    const P6 = API('etazy1.com');
    N6.routes.set(P6, N6.redirect('https://etazy2.com/'));
    N6.routes.set(LIST(API('etazy2.com')), N6.json(A()));
    const m6 = M.createMirror({ sites: [{ key: 'h', api: P6 }], httpGet: N6.httpGet, resolve: N6.resolve, now: C6.now });
    for (let i = 0; i < 3; i++) m6.report('h', false, 'timeout', { url: SAMPLE(P6) });
    await settle(m6);
    ok(m6.apiFor('h') === P6 && (m6._state.get('h').tried[0] || {}).reason === 'no-snapshot', '没有指纹快照:发现的候选不收', m6._state.get('h').tried);
    const N7 = makeNet(), C7 = clock();
    const P7 = API('thetazy1.com');
    N7.routes.set(LIST(API('thetazy2.com')), N7.json(A()));
    const m7 = M.createMirror({ sites: [{ key: 'i', api: P7, mirrors: [API('thetazy2.com')] }], httpGet: N7.httpGet, resolve: N7.resolve, now: C7.now });
    for (let i = 0; i < 3; i++) m7.report('i', false, 'timeout', { url: SAMPLE(P7) });
    await settle(m7);
    ok(m7.apiFor('i') === API('thetazy2.com') && (m7._state.get('i').tried[0] || {}).reason === 'trusted-no-snapshot', '没有指纹快照:站长配置的镜像(maccms 有效)照收', m7._state.get('i').tried);
}

// ---------------------------------------------------------------- ⑥ 探测限流
console.log('⑥ 探测限流(每站每小时 ≤10)');
{
    const N = makeNet(), C = clock(), st = memStore();
    const P = API('kappazy0.com');
    const mirrors = Array.from({ length: 15 }, (_, i) => API(`kappazy${i + 1}.com`));
    for (let i = 0; i < 14; i++) N.routes.set(LIST(mirrors[i]), N.html(PARKING));
    N.routes.set(LIST(mirrors[14]), N.json(A()));
    const mk = () => M.createMirror({ sites: [{ key: 'k', api: P, mirrors }], httpGet: N.httpGet, resolve: N.resolve, now: C.now, store: st });
    const m = mk();
    m.report('k', true, 'ok', { url: SAMPLE(P), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m.report('k', false, 'timeout', { url: SAMPLE(P) });
    await settle(m);
    ok(N.log.length === 10 && m.status()[0].reason === 'rate-limited' && m.apiFor('k') === P, '一轮最多 10 个出网请求,超了停(reason rate-limited)', [N.log.length, m.status()[0].reason]);
    // 30 分钟后再失败:预算还没回来 → 一个都不发
    C.t += 31 * 60e3;
    for (let i = 0; i < 3; i++) m.report('k', false, 'timeout', { url: SAMPLE(P) });
    await settle(m);
    ok(N.log.length === 10, '一小时内预算用完:再失败也不发请求', N.log.length);
    // 重启也不清零
    const m2 = mk();
    const pr = await m2.probe('k');
    ok(N.log.length === 10 && pr.reason === 'rate-limited', '重启后预算不清零(手动 probe 也受限)', [N.log.length, pr]);
    // 一小时后:从游标接着往下试(不从头再来)
    C.t += 30 * 60e3;
    for (let i = 0; i < 3; i++) m2.report('k', false, 'timeout', { url: SAMPLE(P) });
    await settle(m2);
    const after = N.log.slice(10);
    ok(after[0] === LIST(mirrors[10]) && m2.apiFor('k') === mirrors[14] && after.length === 5, '下一轮从游标接着试(第 11 个起),第 15 个验过 → 切过去', after);
}

// ---------------------------------------------------------------- ⑧ 回切 + 手动 probe
console.log('⑧ 回切(6 小时)/ 手动 probe');
{
    const N = makeNet(), C = clock(), st = memStore();
    const P = API('lambdazy1.com'), MR = API('lambdazy2.com');
    let primaryUp = false, parked = false;
    N.routes.set(LIST(P), () => (parked ? { status: 200, headers: {}, data: PARKING } : primaryUp ? { status: 200, headers: {}, data: A() } : Object.assign(new Error('x'), { code: 'ECONNREFUSED' })));
    N.routes.set(LIST(MR), N.json(A()));
    const m = M.createMirror({ sites: [{ key: 'l', api: P, mirrors: [MR] }], httpGet: N.httpGet, resolve: N.resolve, now: C.now, store: st });
    m.report('l', true, 'ok', { url: SAMPLE(P), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m.report('l', false, 'conn', { url: SAMPLE(P) });
    await settle(m);
    ok(m.apiFor('l') === MR, '主地址拒连 → 切到镜像');
    m.report('l', true, 'ok', { url: SAMPLE(MR), data: JSON.parse(A()) });   // 镜像上继续收样本
    primaryUp = true; parked = true;
    C.t += 6 * 3600e3 + 1000;
    await m.tick();
    ok(m.apiFor('l') === MR, '6 小时后主地址被停放(HTML)→ 不切回', m._state.get('l').tried[0]);
    parked = false;
    C.t += 3 * 3600e3;
    await m.tick();
    ok(m.apiFor('l') === MR, '距上次回切检查不到 6 小时 → 不查', m._state.get('l').tried[0]);
    C.t += 3 * 3600e3 + 1000;
    await m.tick();
    ok(m.apiFor('l') === P && m.status()[0].reason === 'failback', '6 小时后主地址验过(maccms + 指纹)→ 切回', m.status()[0]);
    ok(st.box.obj.sites.l.current === P, '回切落盘');
    // 手动 probe:当前地址通 → current-ok
    const pr = await m.probe('l');
    ok(pr.ok === true && pr.reason === 'current-ok' && pr.switched === false, '手动 probe:当前地址通 → current-ok', pr);
    // 手动 probe:当前地址不通 → 换源一轮
    primaryUp = false;
    C.t += 2 * 3600e3;
    const pr2 = await m.probe('l');
    ok(pr2.switched === true && m.apiFor('l') === MR && pr2.reason === 'manual-probe', '手动 probe:当前不通 → 换源', pr2);
    ok((await m.probe('nope')).reason === 'unknown-site', '手动 probe:不认识的站');
}

// ---------------------------------------------------------------- ⑨ 杂项
console.log('⑤b 降级(https 主地址 → http 镜像)/ isMirrorUrl');
{
    // 配置的 http 镜像排在前面也先试 https 的;https 的都不行才兜底试 http 的(有快照时照样要指纹对得上)
    const N = makeNet(), C = clock();
    const P = API('zetazy1.com');
    const HTTPM = 'http://zetazy3.com/api.php/provide/vod';
    N.routes.set(LIST(HTTPM), N.json(listBody(CAT.A_shift2, CAT.classes_a)));
    N.routes.set(LIST(API('zetazy2.com')), N.json(listBody(CAT.A_shift2, CAT.classes_a)));
    const m = M.createMirror({ sites: [{ key: 'z', api: P, mirrors: [HTTPM, API('zetazy2.com')] }], httpGet: N.httpGet, resolve: N.resolve, now: C.now });
    m.report('z', true, 'ok', { url: SAMPLE(P), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m.report('z', false, 'timeout', { url: SAMPLE(P) });
    await settle(m);
    ok(m.apiFor('z') === API('zetazy2.com') && !N.log.some((u) => u.indexOf('zetazy3') >= 0), 'https 主地址:配置的 http 镜像排在前面也先用 https 的(http 的一次都没连)', [m.apiFor('z'), N.log]);
    ok(m.isMirrorUrl(API('zetazy2.com') + '?ac=detail&ids=1') && !m.isMirrorUrl(P + '?ac=list') && !m.isMirrorUrl('https://unrelated.com/x'), 'isMirrorUrl:只认换上去的镜像源站(主地址 / 不相干的 = false)');
    // https 的都不行 → 兜底 http 的(src config-http)
    const N2 = makeNet(), C2 = clock();
    N2.routes.set(LIST(HTTPM), N2.json(listBody(CAT.A_shift2, CAT.classes_a)));
    const m2 = M.createMirror({ sites: [{ key: 'z', api: P, mirrors: [HTTPM, API('zetazy2.com')] }], httpGet: N2.httpGet, resolve: N2.resolve, now: C2.now });
    m2.report('z', true, 'ok', { url: SAMPLE(P), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m2.report('z', false, 'timeout', { url: SAMPLE(P) });
    await settle(m2);
    const tz = m2._state.get('z').tried;
    const iHttp = tz.findIndex((x) => x.url === HTTPM), iHttps = tz.findIndex((x) => x.url === API('zetazy2.com'));
    ok(m2.apiFor('z') === HTTPM && iHttp >= 0 && tz[iHttp].src === 'config-http' && tz[iHttp].ok && iHttps >= 0 && !tz[iHttps].ok
        && N2.log.indexOf(LIST(API('zetazy2.com'))) < N2.log.indexOf(LIST(HTTPM)), '别的都不行 → 最后才兜底用配置的 http 镜像', [tz.map((x) => [x.url, x.src, x.reason]), N2.log]);
    // 发现来的 http 候选(主地址 https)一律不认
    const N3 = makeNet(), C3 = clock();
    const P3 = API('etazy1.com');
    N3.routes.set(P3, N3.redirect('http://etazy2.com/'));
    N3.routes.set(LIST('http://etazy2.com/api.php/provide/vod'), N3.json(listBody(CAT.A_shift2, CAT.classes_a)));
    const m3 = M.createMirror({ sites: [{ key: 'e', api: P3 }], httpGet: N3.httpGet, resolve: N3.resolve, now: C3.now });
    m3.report('e', true, 'ok', { url: SAMPLE(P3), data: JSON.parse(A()) });
    for (let i = 0; i < 3; i++) m3.report('e', false, '5xx', { url: SAMPLE(P3) });
    await settle(m3);
    const t3 = Object.fromEntries(m3._state.get('e').tried.map((x) => [x.url, x.reason]));
    ok(m3.apiFor('e') === P3 && t3['http://etazy2.com/api.php/provide/vod'] === 'downgrade' && !N3.log.some((u) => /etazy2\.com\/api/.test(u)), '发现来的 http 候选(主地址 https)→ downgrade 拒、不连', [t3, N3.log]);
    // 复核:没有指纹快照时,配置的 http 镜像(降级)也不收、一次都不连(开机就失败的主地址不能把整站换到没验过指纹的明文地址上)
    const N4 = makeNet(), C4 = clock();
    N4.routes.set(LIST(HTTPM), N4.json(listBody(CAT.A_shift2, CAT.classes_a)));
    const m4 = M.createMirror({ sites: [{ key: 'z', api: P, mirrors: [HTTPM] }], httpGet: N4.httpGet, resolve: N4.resolve, now: C4.now });
    for (let i = 0; i < 3; i++) m4.report('z', false, 'body', { url: SAMPLE(P) });
    await settle(m4);
    const t4 = m4._state.get('z').tried.find((x) => x.url === HTTPM);
    ok(m4.apiFor('z') === P && t4 && t4.reason === 'downgrade-no-snapshot' && !N4.log.some((u) => u.indexOf('zetazy3') >= 0), '没快照:配置的 http 镜像(降级)不收、不连', [m4.apiFor('z'), t4, N4.log]);
    // 旧版本存下的"没验指纹就换到 http 镜像"状态:读到就回主地址(按新规则重来)
    let saved5 = null;
    const st5 = { load: () => ({ v: 1, sites: { z: { primary: P, current: HTTPM, since: 1, snapshot: null, tried: [{ url: HTTPM, src: 'config-http', ok: true, reason: 'trusted-no-snapshot-http', at: 1 }] } } }), save: (o) => { saved5 = o; } };
    const m5 = M.createMirror({ sites: [{ key: 'z', api: P, mirrors: [HTTPM] }], httpGet: makeNet().httpGet, store: st5, now: clock().now });
    ok(m5.apiFor('z') === P && m5.status()[0].reason === 'reset-unverified-http', '旧状态(没验指纹的 http 镜像)→ 重启回主地址', m5.status()[0]);
    void saved5;
}

// ---------------------------------------------------------------- ⑤c axiosGuard:跟随跳转时每一跳再判(真 http + axios)
console.log('⑤c axiosGuard(server.js 直连镜像源站):302 到内网字面 IP / localhost 拒,不跳转照常');
{
    const http = require('http');
    const axios = require('axios');
    const hits = [];
    const inner = http.createServer((req, res) => { hits.push(req.url); res.setHeader('content-type', 'application/json'); res.end('{"secret":"internal"}'); });
    await new Promise((r) => inner.listen(0, '127.0.0.1', r));
    const ip = inner.address().port;
    const outer = http.createServer((req, res) => {
        if (req.url.startsWith('/to-ip')) { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${ip}/latest/meta-data`); return res.end(); }
        if (req.url.startsWith('/to-v6')) { res.statusCode = 302; res.setHeader('location', `http://[::1]:${ip}/x`); return res.end(); }
        if (req.url.startsWith('/to-metadata')) { res.statusCode = 301; res.setHeader('location', 'http://169.254.169.254/latest/meta-data'); return res.end(); }
        if (req.url.startsWith('/to-host')) { res.statusCode = 302; res.setHeader('location', `http://localhost:${ip}/h`); return res.end(); }
        if (req.url.startsWith('/to-cred')) { res.statusCode = 302; res.setHeader('location', 'http://user:pw@example-zy.com/'); return res.end(); }
        if (req.url.startsWith('/to-file')) { res.statusCode = 302; res.setHeader('location', 'file:///etc/passwd'); return res.end(); }
        res.setHeader('content-type', 'application/json'); res.end('{"code":1,"list":[]}');
    });
    await new Promise((r) => outer.listen(0, '127.0.0.1', r));
    const op = outer.address().port;
    const tryGet = async (p) => { try { const r = await axios.get(`http://127.0.0.1:${op}${p}`, ssrf.axiosGuard({ timeout: 3000 })); return { status: r.status, data: r.data }; } catch (e) { return { err: e.code || e.message, cause: e.cause && e.cause.code }; } };
    for (const p of ['/to-ip', '/to-v6', '/to-metadata', '/to-host', '/to-cred', '/to-file']) {
        const r = await tryGet(p);
        ok(r.err && !r.data && (r.err === 'EPRIVATE' || r.cause === 'EPRIVATE'), 'axiosGuard:' + p + ' → 拒(EPRIVATE)', r);
    }
    ok(hits.length === 0, 'axiosGuard:内网服务一次都没被打到', hits);
    // 对照:不加闸门的 axios 会跟着 302 打到内网(证明上面的拒是闸门拦的,不是跳转本身失败)
    let ctl = null;
    try { ctl = (await axios.get(`http://127.0.0.1:${op}/to-ip`, { timeout: 3000 })).data; } catch (e) { ctl = e.code; }
    ok(ctl && ctl.secret === 'internal' && hits.length === 1, '对照:不加闸门 → 跟着 302 打到内网', [ctl, hits]);
    const plain = await tryGet('/api.php/provide/vod?ac=list');
    ok(plain.status === 200 && plain.data && plain.data.code === 1, 'axiosGuard:不跳转的请求照常', plain);
    const g = ssrf.axiosGuard({ timeout: 1, maxRedirects: 10, headers: { a: 1 } });
    ok(g.lookup === ssrf.safeLookup && g.maxRedirects === 3 && typeof g.beforeRedirect === 'function' && g.timeout === 1 && g.headers.a === 1 && ssrf.axiosGuard({ maxRedirects: 0 }).maxRedirects === 0, 'axiosGuard:lookup / 最多 3 跳 / 原配置保留', g);
    let threw = null;
    try { g.beforeRedirect({ href: 'http://10.0.0.1/' }, {}); } catch (e) { threw = e.code; }
    let pass2 = true;
    try { g.beforeRedirect({ protocol: 'https:', hostname: 'mirror-zy.com', path: '/api.php/provide/vod' }, {}); } catch (e) { pass2 = false; }
    ok(threw === 'EPRIVATE' && pass2, 'axiosGuard.beforeRedirect:内网 → EPRIVATE;公网主机名放行(由 lookup 连接时再判)', [threw, pass2]);
    await new Promise((r) => outer.close(r));
    await new Promise((r) => inner.close(r));
}

console.log('⑨ classifyError / isNewestUrl / fileStore / parseMaccms');
{
    const E = (o) => Object.assign(new Error(o.message || 'x'), o);
    const cases = [
        [E({ code: 'ECONNABORTED', message: 'timeout of 8000ms exceeded' }), 'timeout'], [E({ code: 'ENOTFOUND' }), 'dns'], [E({ code: 'EAI_AGAIN' }), 'dns'],
        [E({ response: { status: 502 } }), '5xx'], [E({ response: { status: 404 } }), '4xx'], [E({ code: 'ECONNREFUSED' }), 'conn'], [E({ code: 'CERT_HAS_EXPIRED' }), 'conn'],
        [new SyntaxError('Unexpected token <'), 'body'], [E({ message: 'catalog: 空响应' }), 'body'], [E({ code: 'EWHATEVER' }), 'other'], [null, 'other'],
    ];
    ok(cases.every(([e, k]) => M.classifyError(e) === k), 'classifyError', cases.map(([e, k]) => [k, M.classifyError(e)]).filter((x) => x[0] !== x[1]));
    const api = 'https://x-zy.com/api.php/provide/vod';
    ok(M.isNewestUrl(api + '?ac=list', api) && M.isNewestUrl(api + '?ac=detail&h=24&pagesize=20&pg=1', api) && M.isNewestUrl(api + '?ac=detail&pagesize=20', api)
        && !M.isNewestUrl(api + '?ac=detail&wd=x', api) && !M.isNewestUrl(api + '?ac=detail&ids=1,2', api) && !M.isNewestUrl(api + '?ac=detail&t=3', api)
        && !M.isNewestUrl(api + '?ac=detail&pg=2', api) && !M.isNewestUrl('https://other.com/api.php/provide/vod?ac=list', api), 'isNewestUrl:只认不带筛选的最新一页');
    const p = M.parseMaccms('﻿' + A());
    ok(p.ok && p.names.length === 8 && p.classes.length === 6 && p.maxTime > p.minTime && !M.parseMaccms(PARKING).ok && !M.parseMaccms('{"code":1}').ok && !M.parseMaccms('[1,2]').ok, 'parseMaccms:BOM / HTML / 无 list / 数组', p);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adult-mirror-'));
    const f = path.join(dir, 'sub', 'adult-mirror.json');
    const fsx = M.fileStore(f);
    ok(JSON.stringify(fsx.load()) === '{}' && fsx.save({ v: 1, sites: { a: { primary: 'p', current: 'c' } } }) && fsx.load().sites.a.current === 'c', 'fileStore:没文件 = {};原子写后读回');
    fs.writeFileSync(f, '{broken');
    ok(JSON.stringify(fsx.load()) === '{}', 'fileStore:坏文件 = {}');
    fs.rmSync(dir, { recursive: true, force: true });
    // 存储里坏条目不影响启动
    const st = { load: () => ({ sites: { a: { primary: 1 }, b: null, c: { primary: 'https://c-zy.com/api.php/provide/vod', current: 'https://c2-zy.com/api.php/provide/vod', probeTimes: 'x' } } }), save: () => { } };
    const m = M.createMirror({ sites: [{ key: 'c', api: 'https://c-zy.com/api.php/provide/vod' }], httpGet: async () => ({ status: 500 }), store: st });
    ok(m.apiFor('c') === 'https://c2-zy.com/api.php/provide/vod' && m.status()[0].budgetLeft === 10, '存储里的坏条目跳过、类型不对的字段回默认');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
