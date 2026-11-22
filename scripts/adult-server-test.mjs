// [adult] 成人站服务端接线回归(零外网:假 maccms 站、假目录模块都在本机;片名全是合成的)
//  ① lib/adult-gate 纯函数:Cookie 解析 / 令牌来源优先级 / Cookie 属性 / 时长解析 / env 默认值只填未设置的 / 搜索计划与相关性闸门
//  ② server.js 端到端(子进程,DB_FILE=假站点表,CACHE_DB_PATH=临时目录,ACCESS_PASSWORD=test,alice,目录换成替身):
//     没令牌 401 且不打上游;登录/验证下发 dg_t(HttpOnly/SameSite=Lax/https 才 Secure)、登出清掉;
//     查询硬拦 → 空结果、一个资源站都不打;被拦条目(分类/父分类/泄露/换脸/未成年/审查级/非成人分区)不出搜索也不出详情(404);
//     番号查询只发 [带横线, 不带横线];search:false 不参与扇出、active:false 处处不见;结果带 _wk/_wt/_b/_dur;
//     缓存键带 RULES_VERSION;写穿目录只收放行的原始条目;目录路由(鉴权、ETag/304、私有缓存、过滤、线路补站名);
//     关掉的功能(TMDB/预览/SEO/站点地图 404、弹幕空、求片/片头/推送关)、/api/config 字段、爬虫分享卡片不出;
//     历史下发 / 历史上报 / 热门 / 收藏 按片名过滤
//  ③ 没配密码 + memory 缓存:内容接口放行、目录 503;显式 *_DISABLE=0 能把功能开回来
//  ④ 真 lib/site-catalog(仓库里有才跑):目录路由形状对、爬虫只调 API(绝不拉 m3u8/图片)
//  ⑤ api/index.js(Vercel):搜索/详情/目录 503,TMDB/预览 404,/api/config 带成人字段,站点表照常
//  第二阶段(②/②b/④ 里):/api/catalog/tags(featured 只认 true)、/api/catalog/suggest(被拦查询不进目录、exact 卡片被滤 → null)、
//     POST /api/catalog/beacon(204、text/plain 也认、坏请求 400、每令牌每分钟 60 次 → 429、上报者只给哈希、零上游)、
//     作品线路 _family/_native 按站点表重算、_meta.actress/siblings 再过滤、/api/img 默认 404 + /cache/adult-img 直接访问 404、
//     ADULT_IMG_PROXY=1:地址只从索引查(url= 不看、回环地址拒、被拦片名不取)、/api/config img_proxy、/api/popular 认 dg_t Cookie、
//     server.js 把 lib/popular 的片名交给目录(popularTitles)、站点表 strict/codeTrust 传进 policy.checkItem
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const FIX = path.join(ROOT, 'scripts/fixtures/adult-server');
const gate = require(path.join(ROOT, 'lib/adult-gate'));
const adult = require(path.join(ROOT, 'lib/adult'));
const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
const RV = adult.RULES_VERSION;
const DATA = JSON.parse(fs.readFileSync(path.join(FIX, 'items.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
    if (c) { pass++; return true; }
    fail++;
    console.log('  ✗ ' + msg + (extra !== undefined ? '  →  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600) : ''));
    return false;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const BLOCKED = new Set();   // 'site_id'
for (const [k, list] of Object.entries(DATA.sites)) for (const it of list) if (it.blocked) BLOCKED.add(k + '_' + it.vod_id);

// ---------------------------------------------------------------- ① 纯函数
console.log('① lib/adult-gate 纯函数');
{
    const c = gate.parseCookies('a=1; dg_t=abc%20d; dg_t=second; e="q"; bad; =x');
    ok(c.a === '1' && c.dg_t === 'abc d' && c.e === 'q' && !('bad' in c), 'parseCookies:解码、同名取第一个、去引号、跳过坏片段', Object.assign({}, c));
    ok(Object.getPrototypeOf(gate.parseCookies('constructor=1')) === null, 'parseCookies:无原型(constructor 之类的键不会撞原型)');
    const req = (o) => Object.assign({ headers: {}, query: {}, body: {} }, o);
    ok(gate.readToken(req({ headers: { cookie: 'dg_t=C', 'x-dg-token': 'H' }, query: { token: 'Q' }, body: { token: 'B' } })) === 'C', 'readToken:Cookie 优先');
    ok(gate.readToken(req({ headers: { 'x-dg-token': 'H' }, query: { token: 'Q' }, body: { token: 'B' } })) === 'H', 'readToken:其次 x-dg-token');
    ok(gate.readToken(req({ query: { token: 'Q' }, body: { token: 'B' } })) === 'Q', 'readToken:其次 ?token=');
    ok(gate.readToken(req({ body: { token: 'B' } })) === 'B', 'readToken:最后 body.token');
    ok(gate.readToken(req({ query: { token: ['x', 'y'] }, body: { token: 123 } })) === '', 'readToken:非字符串不收');
    ok(gate.readToken(req({ headers: { cookie: 'dg_t=' + 'x'.repeat(300) } })) === '', 'readToken:超长不收');
    const ck = gate.tokenCookie('tok', req({}));
    ok(/^dg_t=tok; /.test(ck) && /HttpOnly/.test(ck) && /SameSite=Lax/.test(ck) && /Path=\//.test(ck) && /Max-Age=2592000/.test(ck) && !/Secure/.test(ck), 'tokenCookie:http 下没有 Secure', ck);
    ok(/; Secure$/.test(gate.tokenCookie('tok', req({ headers: { 'x-forwarded-proto': 'https, http' } }))), 'tokenCookie:x-forwarded-proto=https → Secure');
    ok(/; Secure$/.test(gate.tokenCookie('tok', req({ headers: { 'cf-visitor': '{"scheme":"https"}' } }))), 'tokenCookie:cf-visitor https → Secure');
    ok(/^dg_t=; .*Max-Age=0/.test(gate.clearTokenCookie(req({}))), 'clearTokenCookie:Max-Age=0');
    const durs = [['02:00:10', 7210], ['58:38', 3518], ['120分钟', 7200], ['136', 8160], ['7212', 7212], ['', 0], ['abc', 0], ['99:99', 0], [null, 0], ['13:00:00', 0]];
    ok(durs.every(([v, s]) => gate.parseDur(v) === s), 'parseDur:时:分:秒 / 分:秒 / N分钟 / 纯数字(≤600 当分钟)/ 认不出 0 / 超 12h 0', durs.map(([v]) => gate.parseDur(v)));
    ok(gate.ageConfirmed(req({ headers: { cookie: 'a=b; dg_age=1' } })) && gate.ageConfirmed(req({ headers: { 'x-dg-age': '1' } })) && !gate.ageConfirmed(req({ headers: { cookie: 'dg_age=0' } })) && !gate.ageConfirmed(req({})) && !gate.ageConfirmed(null), 'ageConfirmed:Cookie dg_age=1 或 x-dg-age: 1');
    const env = { KAZUMI_DISABLE: '', PUSH_DISABLE: '0' };
    const applied = gate.applyAdultEnvDefaults(env);
    ok(env.KAZUMI_DISABLE === '' && env.PUSH_DISABLE === '0' && env.LIVE_TV_DISABLED === '1' && env.SHARE_TRIAL_MINUTES === '0' && env.DANMAKU_DISABLE === '1'
        && !applied.includes('KAZUMI_DISABLE') && applied.includes('INTRO_DISABLE'), 'applyAdultEnvDefaults:只填未设置的,显式空串/0 不动', env);
    {
        const e1 = { CORS_PROXY_URL: 'https://main-worker.test' }, n1 = gate.applyAdultProxyEnv(e1);
        const e2 = { CORS_PROXY_URL: 'https://main-worker.test', ADULT_CORS_PROXY_URL: 'https://adult-worker.test' }, n2 = gate.applyAdultProxyEnv(e2);
        const e3 = { CORS_PROXY_URL: 'https://main-worker.test', ADULT_CORS_PROXY_URL: '' }, n3 = gate.applyAdultProxyEnv(e3);
        ok(!('CORS_PROXY_URL' in e1) && /ADULT_CORS_PROXY_URL/.test(n1 || '') && e2.CORS_PROXY_URL === 'https://adult-worker.test' && n2 === null && e3.CORS_PROXY_URL === '' && n3 === null,
            'applyAdultProxyEnv:只认 ADULT_CORS_PROXY_URL;只配了 CORS_PROXY_URL(主站 Worker)→ 摘掉并告警;显式空串 = 不用代理', [e1, n1, e2, e3]);
    }
    const view = gate.withAdultDefaults({ PUSH_DISABLE: '0' });
    const off = gate.offFlags(view);
    ok(!off.push && off.requests && off.intro && off.danmaku, 'offFlags(withAdultDefaults):未设置 = 关,显式 0 = 开', off);
    const g = gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => true, ownToken: () => false, off: { push: true } });
    ok(JSON.stringify(g.makePlan('ssis 001')) === JSON.stringify({ kind: 'code', key: 'SSIS-001', variants: ['SSIS-001', 'SSIS001'], raw: 'ssis 001' }), '搜索计划:番号只发 [带横线, 不带横线]', g.makePlan('ssis 001'));
    ok(g.makePlan('FC2-PPV-1234567').variants.every(v => v !== 'FC2' && v !== 'FC2-PPV-'), '搜索计划:FC2 不发裸前缀', g.makePlan('FC2-PPV-1234567'));
    ok(g.makePlan('人妻 温泉').kind === 'text' && g.makePlan('人妻 温泉').variants.length === 1, '搜索计划:文本查询不拆子关键词');
    const gt = g.gateFor('周末 姐姐');
    ok(g.relevant(gt, { vod_name: '邻家姐姐的周末' }) && !g.relevant(gt, { vod_name: '无关的作品' }) && g.relevant(gt, { vod_name: '无关', vod_actor: '周末 姐姐' }), '相关性闸门:每个词都要出现(片名/副名/演员),不要求连续');
    const gc = g.gateFor('SSIS-001');
    ok(g.relevant(gc, {}, adult.title.parseTitle('SSIS001 某某', '')) && !g.relevant(gc, {}, adult.title.parseTitle('SSIS-002 某某', '')), '相关性闸门:番号查询只留同一番号');
    ok(g.checkRaw({ key: 'x' }, null).ok === false && g.checkRaw({ key: 'x' }, { vod_name: '邻家姐姐的周末', type_name: '国产自拍' }).ok === true, 'checkRaw:无效条目不放行,正常条目放行');
    ok(g.checkRaw({ key: 'x' }, { vod_name: '某部电视剧', type_name: '国产剧' }).reason === 'bucket:x_mainstream', 'checkRaw:非成人分区丢弃');
    // storedItemOk:字符串 / JSON 字符串 / 数组 也查片名;太深的套娃不放行
    ok(!g.storedItemOk('准高一少女 初恋') && !g.storedItemOk(JSON.stringify({ name: '准高一少女 初恋' })) && !g.storedItemOk(JSON.stringify(JSON.stringify({ name: '准高一少女 初恋' })))
        && !g.storedItemOk([{ name: '邻家姐姐的周末' }, { name: '准高一少女 初恋' }]) && !g.storedItemOk([[[[[{ name: '邻家姐姐的周末' }]]]]]),
    'storedItemOk:字符串/JSON 字符串/数组里的被拦片名都拦,套娃过深不放行');
    ok(g.storedItemOk('邻家姐姐的周末') && g.storedItemOk(JSON.stringify({ name: '邻家姐姐的周末' })) && g.storedItemOk(null) && g.storedItemOk('') && g.storedItemOk(42) && g.storedItemOk({ name: '邻家姐姐的周末' }),
        'storedItemOk:正常片名/空值/数字 放行');
    // API_REQUIRE_AUTH=1:没配密码也要令牌(年龄 Cookie 不够)
    {
        const mkRes = () => { const r = { code: 200, body: null, headers: {} }; r.set = (k, v) => { r.headers[k] = v; return r; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
        const run = (gg, req) => { const res = mkRes(); let nexted = false; gg.requireAuth(Object.assign({ headers: {}, query: {}, body: {} }, req), res, () => { nexted = true; }); return nexted ? 'next' : res.code + ':' + (res.body && res.body.error); };
        const gOpen = gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => false, ownToken: (t) => t === 'good', env: {} });
        const gReq = gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => false, ownToken: (t) => t === 'good', env: { API_REQUIRE_AUTH: '1' } });
        const age = { headers: { cookie: 'dg_age=1' } };
        ok(run(gOpen, age) === 'next' && run(gOpen, {}) === '401:AGE_REQUIRED', '没配密码、没开 API_REQUIRE_AUTH:年龄 Cookie 即可', [run(gOpen, age), run(gOpen, {})]);
        ok(run(gReq, age) === '401:AUTH_REQUIRED' && run(gReq, { headers: { 'x-dg-token': 'good' } }) === 'next' && gReq.configFields().auth_required === true,
            'API_REQUIRE_AUTH=1:年龄 Cookie 不够,要有效令牌;/api/config 报 auth_required', [run(gReq, age), run(gReq, { headers: { 'x-dg-token': 'good' } })]);
        ok(run(gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => false, ownToken: () => true, env: { API_REQUIRE_AUTH: '0' } }), age) === 'next', 'API_REQUIRE_AUTH=0 = 没开');
    }
    {
        const seen = [];
        const spy = Object.assign({}, adult, { policy: Object.assign({}, adult.policy, { checkItem: (it, ctx) => { seen.push(Object.assign({}, ctx)); return adult.policy.checkItem(it, ctx); } }) });
        const gs = gate.createAdultGate({ adult: spy, allSites: () => [], authConfigured: () => true, ownToken: () => false, env: {} });
        gs.checkRaw({ key: 's1', strict: true }, { vod_name: '邻家姐姐的周末', type_name: '国产自拍' });
        gs.checkRaw({ key: 's2', codeTrust: false }, { vod_name: 'SSIS-001 某合成', type_name: '日本有码' });
        gs.checkRaw({ key: 's3' }, { vod_name: '邻家姐姐的周末', type_name: '国产自拍' });
        ok(seen.length === 3 && seen[0].strict === true && seen[0].siteTrust === true && seen[1].strict === false && seen[1].siteTrust === false && seen[1].codeOk === false && seen[2].strict === false && seen[2].siteTrust === true,
            '站点表 strict:true → ctx.strict=true;codeTrust:false → siteTrust=false、codeOk=false', seen.map(c => [c.strict, c.siteTrust, c.codeOk]));
    }
    let threw = false;
    try { gate.createAdultGate({}); } catch (e) { threw = true; }
    ok(threw, 'createAdultGate 缺 lib/adult → 抛错(fail-closed)');
    threw = false;
    try { gate.vercelGuard({}); } catch (e) { threw = true; }
    ok(threw, 'vercelGuard 缺 lib/adult → 抛错(fail-closed)');
    const c2 = g.configFields();
    ok(c2.adult === true && c2.age_gate === true && c2.site_name === 'DGX' && c2.tmdb_api_key === null && c2.push_enabled === false && c2.rules_version === RV && c2.img_proxy === false, 'configFields(img_proxy 默认 false)', c2);
    // 上报者身份:只信直连的公网对端,或运维声明的反代头;客户端自己写的转发头造不出新身份
    const rq = (peer, headers) => ({ headers: headers || {}, socket: { remoteAddress: peer } });
    const T = gate.trustedClientNet;
    ok(T(rq('127.0.0.1', { 'x-real-ip': '203.0.113.1' }), '') === '' && T(rq('::ffff:127.0.0.1', { 'x-forwarded-for': '198.51.100.7' }), '') === ''
        && T(rq('172.17.0.1', { 'cf-connecting-ip': '8.8.8.8' }), '') === '' && T(rq('::1'), '') === '', '上报者身份:本机/内网反代后面、没配头 → 认不出(转发头不算)');
    ok(T(rq('8.8.8.8'), '') === '8.8.8.8' && T(rq('::ffff:8.8.4.4'), '') === '8.8.4.4' && T(rq('8.8.8.8', { 'x-real-ip': '1.2.3.4' }), '') === ''
        && T(rq('9.9.9.9', { 'x-forwarded-for': '1.1.1.1' }), '') === '', '上报者身份:直连公网对端可信;带了转发头(前面有不认识的反代)→ 认不出');
    ok(T(rq('2001:4860:1:2:aaaa::1'), '') === T(rq('2001:4860:1:2:bbbb::9'), '') && T(rq('2001:4860:1:2:aaaa::1'), '') !== T(rq('2001:4860:1:3::1'), ''), '上报者身份:IPv6 按 /64 归并');
    ok(T(rq('127.0.0.1', { 'x-real-ip': '203.0.113.9' }), 'x-real-ip') === '203.0.113.9' && T(rq('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.5' }), 'x-forwarded-for') === '203.0.113.5'
        && T(rq('127.0.0.1', {}), 'x-real-ip') === '' && T(rq('127.0.0.1', { 'x-real-ip': 'garbage' }), 'x-real-ip') === '', '上报者身份:配了 ADULT_CLIENT_IP_HEADER 只认它(x-forwarded-for 取最右一跳)');
    // 封面缓存目录:不在 public/ 下(默认 cache.db 同目录的 adult-img-cache;配到 public/ 里 → 退回默认)
    {
        const base = path.join(os.tmpdir(), 'dg-imgdir-probe');
        const mkG = (env) => gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => true, ownToken: () => false, env });
        const pub = path.join(ROOT, 'public');
        const d1 = mkG({ CACHE_DB_PATH: path.join(base, 'c.db') }).imgCacheDir();
        const d2 = mkG({ CACHE_DB_PATH: path.join(base, 'c.db'), ADULT_IMG_CACHE_DIR: path.join(pub, 'cache', 'x') }).imgCacheDir();
        const d3 = mkG({ ADULT_IMG_CACHE_DIR: path.join(base, 'own') }).imgCacheDir();
        const d4 = mkG({}).imgCacheDir();
        const inPub = (d) => { const r = path.relative(pub, d); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };   // 跨盘符时 relative 回绝对路径
        ok(d1 === path.join(base, 'adult-img-cache') && d2 === d1 && d3 === path.join(base, 'own') && d4 === path.join(ROOT, 'node_modules', '.cache', 'adult-img-cache') && ![d1, d2, d3, d4].some(inPub),
            '封面缓存目录:默认 cache.db 同目录(没配 CACHE_DB_PATH → node_modules/.cache,已被 gitignore)、可配 ADULT_IMG_CACHE_DIR、绝不落在 public/', [d1, d2, d3, d4]);
    }
    // 严格站:政策回的 codeOk 更严 → 搜索分组(_wk)、分区路由都以它为准;普通站照旧
    {
        const it = { vod_id: 1, vod_name: 'SSIS-904 某合成标题', type_name: '爱播资源', vod_class: '国产传媒' };
        const cs = g.checkRaw({ key: 'sx', strict: true }, it), cn = g.checkRaw({ key: 'sn' }, it);
        const ws = cs.ok ? g.identity(it, cs)._wk : '', wn = cn.ok ? g.identity(it, cn)._wk : '';
        ok(cs.ok && cs.codeOk === false && cs.codeVeto === true && ws.indexOf('t:') === 0 && cn.ok && cn.codeVeto === false && wn === 'c:SSIS-904',
            '严格站:政策不信的番号不进 c: 键(普通站同一条照旧 c:)', [cs.ok, cs.codeOk, cs.codeVeto, ws, cn.ok, wn]);
    }
    ok(gate.ipHeaderOf({ ADULT_CLIENT_IP_HEADER: ' CF-Connecting-IP ' }) === 'cf-connecting-ip' && gate.ipHeaderOf({ ADULT_CLIENT_IP_HEADER: 'bad header!' }) === '' && gate.ipHeaderOf({}) === '', 'ADULT_CLIENT_IP_HEADER 解析');
}

// ---------------------------------------------------------------- 假 maccms 站
const stubLog = [];
const stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = /^\/([a-d])\/api\.php\/provide\/vod\/?$/.exec(u.pathname);
    const q = Object.fromEntries(u.searchParams);
    stubLog.push({ path: u.pathname, site: m ? m[1] : '', q, url: req.url });
    if (!m) { res.writeHead(404); return res.end('no'); }
    const site = m[1], base = `http://127.0.0.1:${stub.address().port}`;
    const all = DATA.sites[site].map(({ blocked, ...it }) => Object.assign({
        vod_pic: `${base}/img/${it.vod_id}.jpg`, vod_play_from: 'dgm3u8', vod_play_url: `第1集$${base}/media/${it.vod_id}.m3u8`,
        vod_remarks: 'HD', vod_year: '2026', vod_content: '<p>合成简介</p>', vod_time: '2026-11-21 10:00:00', vod_tag: '', vod_class: '', vod_actor: '',
    }, it));
    let list = all;
    if (q.ac === 'list') return res.end(JSON.stringify({ code: 1, page: 1, pagecount: 1, limit: 20, total: 0, list: [], class: DATA.classes }));
    if (site !== 'b') {   // b:无视 wd / ids,永远回整页(模拟 s37/s49 那种站)
        if (q.wd != null) list = all.filter(it => it.vod_name.toLowerCase().includes(String(q.wd).toLowerCase()));
        if (q.ids != null) { const want = String(q.ids).split(','); list = all.filter(it => want.includes(String(it.vod_id))); }
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 1, msg: '数据列表', page: 1, pagecount: 1, limit: '20', total: list.length, list }));
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adult-srv-'));
const DB_FILE = path.join(tmp, 'db.json');
const SITES = [
    { key: 'a', name: '站A', api: `${STUB}/a/api.php/provide/vod/`, active: true, family: 'famA' },
    { key: 'b', name: '站B', api: `${STUB}/b/api.php/provide/vod/`, active: true, family: 'famB', nativeHls: false },
    { key: 'c', name: '站C', api: `${STUB}/c/api.php/provide/vod/`, active: true, search: false },
    { key: 'd', name: '站D', api: `${STUB}/d/api.php/provide/vod/`, active: false },
];
fs.writeFileSync(DB_FILE, '\uFEFF' + JSON.stringify({ sites: SITES }, null, 2));   // 带 BOM:PowerShell 存的 db.json 就是这样

// 子进程环境:不继承任何真实部署配置(cwd 是临时目录 → dotenv 读不到仓库的 .env;下面再把相关键显式清空)
function childEnv(extra) {
    const e = Object.assign({}, process.env);
    for (const k of Object.keys(gate.ADULT_ENV_DEFAULTS)) delete e[k];   // 让本分支默认值生效
    for (const k of ['STATS_DISABLE', 'CATALOG_DISABLE', 'CATALOG_MAX_SITES', 'CATALOG_FIRST_DELAY_MS', 'ADULT_TEST_CATALOG_STUB', 'ADULT_TEST_CATALOG_LOG', 'VERCEL', 'SITES_JSON', 'OUTBOUND_MAX_TOTAL_SOCKETS', 'SITE_NAME',
        'ADULT_IMG_PROXY', 'ADULT_IMG_CACHE_DIR', 'ADULT_IMG_CACHE_MB', 'ADULT_CLIENT_IP_HEADER']) delete e[k];
    return Object.assign(e, {
        TMDB_API_KEY: '', TMDB_PROXY_URL: '', CORS_PROXY_URL: '', DANMU_API_URL: '', DANMU_API_TOKEN: '', ADMIN_TOKEN: '', REMOTE_DB_URL: '',
        LIVE_M3U_ADULT: '', SITE_URL: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '', DB_FILE,
    }, extra || {});
}
let srv = null, port = 0, srvLog = '';
async function startServer(extra, args) {
    port = 20000 + Math.floor(Math.random() * 20000);
    srvLog = '';
    srv = spawn(process.execPath, (args || []).concat([path.join(ROOT, 'server.js')]), { cwd: tmp, env: childEnv(Object.assign({ PORT: String(port) }, extra)), stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { srvLog += d; });
    srv.stderr.on('data', d => { srvLog += d; });
    for (let i = 0; i < 150; i++) {
        await sleep(100);
        try { const r = await fetch(`http://127.0.0.1:${port}/api/debug`); if (r.ok) return; } catch (e) { }
        if (srv.exitCode != null) break;
    }
    throw new Error('server.js 没起来:\n' + srvLog.slice(-3000));
}
async function stopServer() {
    if (!srv) return;
    const p = new Promise(r => srv.once('exit', r));
    srv.kill(); await p; srv = null;
}
const B = () => `http://127.0.0.1:${port}`;
async function api(method, p, o) {
    o = o || {};
    const headers = Object.assign({}, o.headers || {});
    if (o.cookie) headers.cookie = o.cookie;
    let body;
    if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
    const r = await fetch(B() + p, { method, headers, body, redirect: 'manual' });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) { }
    return { status: r.status, j, text, h: r.headers };
}
async function sse(p, cookie) {
    const r = await api('GET', p, { cookie, headers: { Accept: 'text/event-stream' } });
    const items = [];
    let done = false;
    for (const block of r.text.split('\n\n')) {
        if (/^event: done/m.test(block)) { done = true; continue; }
        const m = /^data: (.*)$/m.exec(block);
        if (m) { try { const a = JSON.parse(m[1]); if (Array.isArray(a)) items.push(...a); } catch (e) { } }
    }
    return { status: r.status, items, done, j: r.j, ct: r.h.get('content-type') || '' };
}
const keyOf = (it) => it.site_key + '_' + it.vod_id;
const stubCount = () => stubLog.length;
const readLines = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

// ---------------------------------------------------------------- ② server.js 端到端(目录 = 替身)
console.log('② server.js 端到端');
const CAT_LOG = path.join(tmp, 'catalog.log');
const CACHE_DB = path.join(tmp, 'cache-a.db');
try {
    await startServer({ ACCESS_PASSWORD: 'test,alice', CACHE_TYPE: 'sqlite', CACHE_DB_PATH: CACHE_DB, ADULT_TEST_CATALOG_STUB: path.join(FIX, 'catalog-stub.cjs'), ADULT_TEST_CATALOG_LOG: CAT_LOG, TMDB_API_KEY: 'fake-key-never-used' },
        ['-r', path.join(FIX, 'catalog-hook.cjs'), '-r', path.join(FIX, 'v2b-stub.cjs')]);
    ok(fs.existsSync(CACHE_DB), 'CACHE_DB_PATH 生效:sqlite 建在指定位置');
    ok(/本分支默认关闭/.test(srvLog) && /PUSH_DISABLE/.test(srvLog) && /SHARE_PAGE_DISABLE/.test(srvLog), '启动日志列出默认关闭的功能', srvLog.slice(0, 800));
    ok(/已忽略配置的 TMDB_API_KEY/.test(srvLog), '配了 TMDB_API_KEY 也不用(启动时摘掉并告警)');
    const create = readLines(CAT_LOG).find(x => x.ev === 'create');
    ok(create && create.hasDb && create.adultOk && create.httpGet === 'function' && create.log === 'function' && create.env
        && JSON.stringify(create.keys) === JSON.stringify(['adult', 'db', 'env', 'getSites', 'httpGet', 'log', 'popularTitles']), 'createCatalog 拿到约定的依赖(db 实例 / adult / httpGet / log / env / getSites / popularTitles)', create);
    ok(create && JSON.stringify(create.sites) === JSON.stringify(['a', 'b', 'c']), 'getSites:不含 active:false 的站,含 search:false 的站(目录照爬)', create && create.sites);
    ok(readLines(CAT_LOG).some(x => x.ev === 'start'), 'catalog.start() 被调用');

    // —— 鉴权 ——
    const before = stubCount();
    const unauth = [
        ['GET', '/api/search?wd=' + encodeURIComponent('周末') + '&stream=true'],
        ['GET', '/api/search?wd=' + encodeURIComponent('周末')],
        ['POST', '/api/search', { keyword: '周末', siteKey: 'a' }],
        ['GET', '/api/detail?id=101&site_key=a'],
        ['POST', '/api/detail', { id: 101, siteKey: 'a' }],
        ['GET', '/api/sites'], ['GET', '/api/check?key=a'], ['GET', '/api/popular'],
        ['GET', '/api/catalog/home'], ['GET', '/api/catalog/browse?b=jp_censored'], ['GET', '/api/catalog/buckets'], ['GET', '/api/catalog/work?k=c:SSIS-001'], ['GET', '/api/catalog/lookup?q=SSIS-001'],
        ['GET', '/api/catalog/tags'], ['GET', '/api/catalog/suggest?q=SSIS-001'], ['POST', '/api/catalog/beacon', { wk: 'c:SSIS-001', site_key: 'a', vod_id: '101', ok: false }], ['GET', '/api/img?k=c:SSIS-001&s=a'],
        ['GET', '/api/kz/ep/x/y'],
    ];
    for (const [m, p, json] of unauth) {
        const r = await api(m, p, { json });
        ok(r.status === 401 && r.j && r.j.error === 'AUTH_REQUIRED' && /no-store/.test(r.h.get('cache-control') || ''), `没令牌 ${m} ${p} → 401 AUTH_REQUIRED`, [r.status, r.text.slice(0, 120)]);
    }
    ok((await api('GET', '/api/search?wd=x&stream=true', { cookie: 'dg_t=' + sha('wrong') })).status === 401, '错令牌 → 401');
    ok((await api('GET', '/api/search?wd=x&stream=true', { cookie: 'dg_t=constructor' })).status === 401, '原型键令牌(constructor)→ 401');
    ok(stubCount() === before, '没过鉴权的请求一个资源站都没打', stubLog.slice(before));

    let r = await api('POST', '/api/auth/verify', { json: { password: 'nope' } });
    ok(r.j && r.j.success === false && !r.h.get('set-cookie'), '密码错:不下发 Cookie');
    r = await api('POST', '/api/auth/verify', { json: { password: 'test' } });
    const sc = r.h.get('set-cookie') || '';
    const TOK = sha('test'), ALICE = sha('alice');
    ok(r.j && r.j.success === true && sc.includes('dg_t=' + TOK) && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Path=\//.test(sc) && /Max-Age=2592000/.test(sc) && !/Secure/.test(sc),
        '密码验证成功 → Set-Cookie dg_t(HttpOnly, SameSite=Lax, Path=/, 30 天;http 不带 Secure)', sc);
    r = await api('POST', '/api/auth/verify', { json: { passwordHash: ALICE }, headers: { 'X-Forwarded-Proto': 'https' } });
    ok(r.j && r.j.success && /dg_t=/.test(r.h.get('set-cookie') || '') && /Secure/.test(r.h.get('set-cookie') || ''), '会话恢复(passwordHash)也下发;x-forwarded-proto=https → Secure', r.h.get('set-cookie'));
    r = await api('POST', '/api/auth/logout');
    ok(r.status === 200 && /^dg_t=;/.test(r.h.get('set-cookie') || '') && /Max-Age=0/.test(r.h.get('set-cookie') || ''), '登出:清掉 dg_t', r.h.get('set-cookie'));
    // 机场登录 / 机场免密续期 / 扫码取凭据:成功都下发 dg_t
    const V2B = 'v2board_' + sha('viewer@example.test');
    r = await api('POST', '/api/auth/v2board', { json: { email: 'viewer@example.test', password: 'bad' } });
    ok(r.j && r.j.success === false && !r.h.get('set-cookie'), '机场登录失败:不下发 Cookie', r.j);
    r = await api('POST', '/api/auth/v2board', { json: { email: 'viewer@example.test', password: 'pw' } });
    ok(r.j && r.j.success === true && r.j.userToken === V2B && (r.h.get('set-cookie') || '').includes('dg_t=' + V2B), '机场登录成功 → dg_t = 机场同步令牌', [r.j, r.h.get('set-cookie')]);
    ok((await api('GET', '/api/sites', { cookie: 'dg_t=' + V2B })).status === 200, '…拿这个 Cookie 能访问内容接口');
    r = await api('POST', '/api/auth/v2board/check', { json: { v2boardToken: 'AUTH-OK' } });
    ok(r.j && r.j.success === true && (r.h.get('set-cookie') || '').includes('dg_t=' + V2B), '机场免密续期(/check)成功 → 下发 dg_t', [r.j, r.h.get('set-cookie')]);
    r = await api('POST', '/api/auth/v2board/check', { json: { v2boardToken: 'AUTH-BAD' } });
    ok(r.j && r.j.success === false && !r.h.get('set-cookie'), '机场续期失败:不下发', r.j);
    const qn = await api('POST', '/api/auth/qr/new');
    const qa = await api('POST', '/api/auth/qr/approve', { json: { code: qn.j && qn.j.code, auth: { type: 'password', hash: TOK } } });
    r = await api('POST', '/api/auth/qr/poll', { json: { code: qn.j && qn.j.code, secret: qn.j && qn.j.secret } });
    ok(qa.j && qa.j.ok && r.j && r.j.status === 'approved' && (r.h.get('set-cookie') || '').includes('dg_t=' + TOK), '扫码登录:电视取到密码凭据 → 下发 dg_t', [qa.j, r.j && r.j.status, r.h.get('set-cookie')]);
    const CK = 'other=1; dg_t=' + TOK;
    ok((await api('GET', '/api/sites', { headers: { 'x-dg-token': TOK } })).status === 200, 'x-dg-token 头也认');
    ok((await api('GET', '/api/sites?token=' + TOK)).status === 200, '?token= 也认');

    // —— /api/sites / /api/check:active:false 处处不见 ——
    r = await api('GET', '/api/sites', { cookie: CK });
    ok(r.status === 200 && r.j && JSON.stringify(r.j.sites.map(s => s.key)) === JSON.stringify(['a', 'b', 'c']), '/api/sites 不含 active:false 的站', r.j && r.j.sites.map(s => s.key));
    r = await api('GET', '/api/check?key=a', { cookie: CK });
    ok(r.j && r.j.latency < 9000, '/api/check 站A 通', r.j);
    r = await api('GET', '/api/check?key=d', { cookie: CK });
    ok(r.j && r.j.latency >= 9000 && !stubLog.some(x => x.site === 'd'), '/api/check 停用站 = 9999,且没去打它', r.j);

    // —— 查询硬拦:不打上游 ——
    for (const q of ['迷奸', '偷拍 周末', '准高一']) {
        const n0 = stubCount();
        const s = await sse('/api/search?wd=' + encodeURIComponent(q) + '&stream=true', CK);
        const j = await api('GET', '/api/search?wd=' + encodeURIComponent(q), { cookie: CK });
        const p = await api('POST', '/api/search', { cookie: CK, json: { keyword: q, siteKey: 'a' } });
        ok(s.status === 200 && s.done && s.items.length === 0 && j.j && j.j.list.length === 0 && p.j && p.j.list.length === 0, `被拦的查询「${q}」:SSE/JSON/POST 全是空结果`, [s.items.length, j.j, p.j]);
        ok(stubCount() === n0, `被拦的查询「${q}」:一个资源站都没打`, stubLog.slice(n0).map(x => x.url));
    }

    // —— 番号查询 ——
    let n0 = stubCount();
    let s = await sse('/api/search?wd=' + encodeURIComponent('ssis 001') + '&stream=true', CK);
    const lists = stubLog.slice(n0).filter(x => x.q.ac === 'list');
    ok(JSON.stringify(lists.map(x => x.site).sort()) === JSON.stringify(['a', 'b']), '第一次搜索时每个参与的站顺带拉一次分类图(ac=list)', lists.map(x => x.site));
    let reqs = stubLog.slice(n0).filter(x => x.q.wd != null);
    const wds = [...new Set(reqs.map(x => x.q.wd))].sort();
    ok(JSON.stringify(wds) === JSON.stringify(['SSIS-001', 'SSIS001']), '番号查询只发 [SSIS-001, SSIS001](绝不发裸厂牌 SSIS)', wds);
    ok(reqs.every(x => x.site === 'a' || x.site === 'b') && reqs.filter(x => x.site === 'a').length === 2 && reqs.filter(x => x.site === 'b').length === 2, '…只打参与扇出的站 a/b(c 是 search:false,d 停用)', reqs.map(x => x.site + ':' + x.q.wd));
    ok(s.done && s.ct.includes('text/event-stream'), 'SSE:有 done 事件');
    const got = Object.fromEntries(s.items.map(it => [keyOf(it), it]));
    ok(JSON.stringify(Object.keys(got).sort()) === JSON.stringify(['a_101', 'b_201', 'b_202']), '番号查询结果:只留同一番号(SSIS-002 与 b 站整页里的其它条目被闸门挡掉)', Object.keys(got));
    const a101 = got.a_101 || {}, b201 = got.b_201 || {}, b202 = got.b_202 || {};
    ok(a101._wk === 'c:SSIS-001' && a101._wt === 'SSIS-001 温泉旅馆的邂逅' && a101._dur === 7210 && a101._b === 'jp_subbed' && a101._variant === '中字' && a101.site_name === '站A · 中字' && a101.type_id === 2,
        '结果带 _wk/_wt/_b/_dur/_variant/site_name(站名后带版本)', a101);
    ok(a101._family === 'famA' && !('_native' in a101) && b201._family === 'famB' && b201._native === 'risky' && b201.site_name === '站B',
        '搜索结果也带站点表的 _family(同家镜像收成一张、不被首集地址去重并掉)和 _native:risky', [a101._family, a101._native, b201._family, b201._native, b201.site_name]);
    ok(b201._wk === 'c:SSIS-001' && b201._dur === 7212 && b201._b === 'jp_censored', '不带横线的同一番号并到同一个 _wk;纯数字大时长按秒', b201);
    ok(b202._wk === 'c:SSIS-001#U' && /无码流出/.test(b202._wt), '无码流出是另一张卡(#U),显示名带后缀', b202);
    ok(s.items.every(it => !('vod_tag' in it) || it.vod_tag === undefined), '出口不带 vod_tag 等多余字段(映射后)');

    // —— 文本查询 ——
    n0 = stubCount();
    s = await sse('/api/search?wd=' + encodeURIComponent('周末') + '&stream=true', CK);
    reqs = stubLog.slice(n0);
    ok(JSON.stringify([...new Set(reqs.map(x => x.q.wd))]) === JSON.stringify(['周末']), '文本查询只发原词(不拆子关键词、不找 TMDB 翻译);分类图已缓存不再拉', reqs.map(x => x.q.wd));
    let keys = s.items.map(keyOf).sort();
    ok(JSON.stringify(keys) === JSON.stringify(['a_102', 'b_204']), '文本查询:被拦的(分类/父分类/泄露/换脸/未成年/审查级/非成人分区)一条不出;b 站整页按相关性闸门只留含「周末」的', keys);
    ok(!s.items.some(it => BLOCKED.has(keyOf(it))), '…没有任何 blocked 条目');
    ok(s.items.every(it => typeof it._wk === 'string' && it._wk.startsWith('t:') && typeof it._wt === 'string' && it._b === 'cn_amateur'), '无番号作品 _wk = t:…', s.items.map(it => [it._wk, it._b]));
    const j = await api('GET', '/api/search?wd=' + encodeURIComponent('周末'), { cookie: CK });
    keys = (j.j && j.j.list || []).map(keyOf).sort();
    ok(JSON.stringify(keys) === JSON.stringify(['a_102', 'b_204']) && j.j.list.every(it => it.site_profile !== null), 'JSON 模式同样过滤', keys);
    r = await api('GET', '/api/search?wd=' + encodeURIComponent('周末') + '&site_key=c', { cookie: CK });
    ok(r.j && r.j.list.length === 1 && r.j.list[0].vod_id === 301, '显式 site_key 指定 search:false 的站:照搜(刷新线路用)', r.j);
    r = await api('GET', '/api/search?wd=' + encodeURIComponent('周末') + '&site_key=d', { cookie: CK });
    ok(r.j && r.j.list.length === 0 && !stubLog.some(x => x.site === 'd'), '停用站连显式 site_key 都搜不到');
    r = await api('POST', '/api/search', { cookie: CK, json: { keyword: '周末', siteKey: 'a' } });
    ok(r.j && JSON.stringify(r.j.list.map(x => x.vod_id)) === JSON.stringify([102]), 'POST 单站搜索同样过滤', r.j);
    r = await api('POST', '/api/search', { cookie: CK, json: { keyword: '周末', siteKey: 'd' } });
    ok(r.status === 404, 'POST 单站搜索:停用站 404');
    s = await sse('/api/search?wd=' + encodeURIComponent('合集') + '&stream=true', CK);
    ok(s.items.length === 0, '只命中被拦条目的查询 → 空', s.items.map(keyOf));
    s = await sse('/api/search?wd=' + encodeURIComponent('JUL-123') + '&stream=true', CK);
    ok(s.items.length === 1 && s.items[0].vod_id === 105 && s.items[0]._wk === 't:夏日回忆' && s.items[0]._dur === 7200, '占位番号(JUL-123):不按番号并组(_wk 用片名)', s.items.map(it => [keyOf(it), it._wk, it._dur]));

    // —— 缓存键带规则版本 ——
    const db = new Database(CACHE_DB);
    const ckeys = db.prepare("SELECT category, key FROM cache WHERE category IN ('search','detail')").all();
    ok(ckeys.length > 0 && ckeys.filter(x => x.category === 'search').every(x => x.key.startsWith('adult:' + RV + ':')), '搜索缓存键带 RULES_VERSION', ckeys.slice(0, 5));

    // —— 写穿目录 ——
    await sleep(100);
    const ing = readLines(CAT_LOG).filter(x => x.ev === 'ingest');
    const ingIds = ing.flatMap(x => x.ids.map(id => x.site + '_' + id));
    ok(ing.length > 0 && ingIds.includes('a_101') && ingIds.includes('a_102') && !ingIds.some(k => BLOCKED.has(k)), '写穿目录:只收放行的原始条目', ingIds);

    // —— 详情 ——
    r = await api('GET', '/api/detail?id=101&site_key=a', { cookie: CK });
    ok(r.status === 200 && r.j && r.j.list[0].vod_name === 'SSIS-001 温泉旅馆的邂逅 中文字幕', '详情:正常条目 200');
    for (const [id, site] of [[103, 'a'], [104, 'a'], [106, 'a'], [107, 'a'], [108, 'a'], [109, 'a'], [110, 'a'], [205, 'b'], [206, 'b']]) {
        const g = await api('GET', `/api/detail?id=${id}&site_key=${site}`, { cookie: CK });
        const p = await api('POST', '/api/detail', { cookie: CK, json: { id, siteKey: site } });
        ok(g.status === 404 && p.status === 404 && g.j && Array.isArray(g.j.list) && g.j.list.length === 0, `详情:被拦条目 ${site}_${id} → GET/POST 都 404`, [g.status, p.status]);
    }
    r = await api('GET', '/api/detail?id=999&site_key=b', { cookie: CK });
    ok(r.status === 404, '详情:站点不认 ids 回整页时,对不上 vod_id 的不冒充(404)', r.status);
    r = await api('GET', '/api/detail?id=201&site_key=b', { cookie: CK });
    ok(r.status === 200 && r.j.list[0].vod_id === 201, '详情:站点回整页时按 vod_id 挑对的那条');
    r = await api('POST', '/api/detail', { cookie: CK, json: { id: 301, siteKey: 'c' } });
    ok(r.status === 200 && r.j.vod_id === 301, '详情:search:false 的站照常可用(POST)');
    r = await api('GET', '/api/detail?id=401&site_key=d', { cookie: CK });
    ok(r.status === 404 && r.j && r.j.error === 'Site not found', '详情:停用站 404');
    const dkeys = db.prepare("SELECT key FROM cache WHERE category = 'detail'").all().map(x => x.key);
    ok(dkeys.length >= 2 && dkeys.every(k => k.startsWith('adult:' + RV + ':')) && !dkeys.some(k => /_detail_(103|104|106|107|108|109|110|205|206)$/.test(k)), '详情缓存键带 RULES_VERSION;被拦的不进缓存', dkeys);
    ok(!stubLog.some(x => x.site === 'd'), '停用站 d 从头到尾没被请求过');
    ok(!stubLog.some(x => x.site === 'c' && x.q.wd != null && !(x.q.wd === '周末')), 'search:false 的站只在显式 site_key 时被搜');
    const listN = {};
    for (const x of stubLog) if (x.q.ac === 'list') listN[x.site] = (listN[x.site] || 0) + 1;
    ok(Object.values(listN).every(n => n === 1), '分类图每站只拉一次(按天缓存)', listN);

    // —— 目录 ——
    r = await api('GET', '/api/catalog/home', { cookie: CK });
    const names = (r.j && r.j.rows || []).flatMap(row => row.items.map(c => c.name));
    ok(r.status === 200 && /private/.test(r.h.get('cache-control') || '') && /max-age=60/.test(r.h.get('cache-control') || '') && r.h.get('etag'), '目录首页:200 + private, max-age=60 + ETag', [r.status, r.h.get('cache-control'), r.h.get('etag')]);
    ok(JSON.stringify(names) === JSON.stringify(['SSIS-001 温泉旅馆的邂逅', '邻家姐姐的周末']), '目录首页:片名被拦的卡片再过滤一遍', names);
    // 用原生 http:fetch 对手动带 If-None-Match 的请求会自动加 Cache-Control: no-cache(规范行为),服务器理应回 200;浏览器自己的缓存重验证不加
    const r304 = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/catalog/home', headers: { cookie: CK, 'If-None-Match': r.h.get('etag') } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
    ok(r304 === 304, '目录首页:If-None-Match → 304', r304);
    r = await api('GET', '/api/catalog/browse?b=jp_censored&sort=bogus&dur=zz&flag=unc&page=0&tag=' + encodeURIComponent('<x>'), { cookie: CK });
    const bq = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    ok(r.status === 200 && r.j && r.j.results.length === 1 && r.j.results[0].name === '邻家姐姐的周末' && /max-age=60/.test(r.h.get('cache-control') || ''), '目录浏览:结果再过滤', r.j);
    ok(bq && JSON.stringify(bq.q) === JSON.stringify({ b: 'jp_censored', tag: '!bad', sort: 'new', dur: '', flag: 'unc', page: 1 }), '目录浏览:参数清洗(非法 sort/dur 回默认,page≥1;给了但非法的 tag 标成 !bad 交给目录回空页)', bq && bq.q);
    r = await api('GET', '/api/catalog/browse?b=' + encodeURIComponent('../../etc') + '&page=abc', { cookie: CK });
    const bq2 = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    ok(r.status === 200 && bq2 && bq2.q.b === '!bad' && bq2.q.tag === '' && bq2.q.page === 1, '目录浏览:非法分区不悄悄变成 ""(=全部分区),标成 !bad', bq2 && bq2.q);
    await api('GET', '/api/catalog/browse?lp=ssis', { cookie: CK });
    const bq3 = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    await api('GET', '/api/catalog/browse?lp=' + encodeURIComponent('SS%IS'), { cookie: CK });
    const bq4 = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    ok(bq3 && bq3.q.lp === 'SSIS' && bq4 && bq4.q.lp === '!bad' && !('lp' in bq.q), '目录浏览:厂牌前缀 lp 转大写;非法 → !bad;没给不带这个键', [bq3 && bq3.q, bq4 && bq4.q]);
    r = await api('GET', '/api/catalog/buckets', { cookie: CK });
    ok(r.status === 200 && Array.isArray(r.j) && r.j[0].id === 'jp_censored', '目录分区列表');
    r = await api('GET', '/api/catalog/work?k=' + encodeURIComponent('c:SSIS-001'), { cookie: CK });
    const srcs = (r.j && r.j.sources) || [];
    ok(r.status === 200 && JSON.stringify(srcs.map(x => x.site_key + '_' + x.vod_id)) === JSON.stringify(['a_101', 'b_201']), '作品:停用站线路、片名被拦的线路丢掉', srcs.map(x => x.site_key + '_' + x.vod_id));
    ok(srcs[0] && srcs[0].site_name === '站A · 中字' && srcs[1].site_name === '站B' && 'site_profile' in srcs[0] && r.j._meta && r.j._meta.code === 'SSIS-001', '作品:线路补上站点表里的站名(带版本:中字)+ site_profile', srcs[0]);
    ok(r.j._meta && r.j._meta.n_sites === 2, '作品 _meta.n_sites 按闸门留下的线路重算(目录给 4,停用站/被拦的不算)', r.j._meta && r.j._meta.n_sites);
    r = await api('GET', '/api/catalog/lookup?q=' + encodeURIComponent('ssis001'), { cookie: CK });
    let lk = readLines(CAT_LOG).filter(x => x.ev === 'lookup').pop();
    ok(r.status === 200 && r.j && r.j.kind === 'code' && r.j.key === 'SSIS-001' && r.j.results.length === 1 && r.j.results[0].wk === 'c:SSIS-001' && /no-store/.test(r.h.get('cache-control') || '') && lk && lk.limit === 8,
        '本地查找:番号 → {kind:code,key,results}(目录 lookup,零上游)', [r.status, r.j, lk]);
    r = await api('GET', '/api/catalog/lookup?q=' + encodeURIComponent('周末') + '&limit=99', { cookie: CK });
    lk = readLines(CAT_LOG).filter(x => x.ev === 'lookup').pop();
    ok(r.status === 200 && r.j.kind === 'text' && r.j.key === null && JSON.stringify(r.j.results.map(x => x.name)) === JSON.stringify(['邻家姐姐的周末']) && lk.limit === 24, '本地查找:文字查询,片名被拦的卡片丢掉,limit 夹到 24', [r.j, lk]);
    const nLk = readLines(CAT_LOG).filter(x => x.ev === 'lookup').length;
    r = await api('GET', '/api/catalog/lookup?q=' + encodeURIComponent('萝莉'), { cookie: CK });
    ok(r.status === 200 && r.j.results.length === 0 && readLines(CAT_LOG).filter(x => x.ev === 'lookup').length === nLk, '本地查找:硬拦查询直接空,目录都不查', r.j);
    r = await api('GET', '/api/catalog/work?k=nope', { cookie: CK });
    ok(r.status === 400, '作品:非法 k → 400');
    r = await api('GET', '/api/catalog/work?k=' + encodeURIComponent('c:NOPE-001'), { cookie: CK });
    ok(r.status === 404, '作品:没有 → 404');
    r = await api('GET', '/api/catalog/work?k=' + encodeURIComponent('c:SSIS-001') + '&expand=1', { cookie: CK });
    let wl = readLines(CAT_LOG).filter(x => x.ev === 'work').pop();
    ok(r.status === 200 && wl && wl.expand === true && /no-store/.test(r.h.get('cache-control') || ''), '作品 expand=1:传给目录,回包 no-store', [wl, r.h.get('cache-control')]);
    for (let i = 0; i < 10; i++) await api('GET', '/api/catalog/work?k=' + encodeURIComponent('c:SSIS-001') + '&expand=1', { cookie: CK });
    wl = readLines(CAT_LOG).filter(x => x.ev === 'work').pop();
    const last = await api('GET', '/api/catalog/work?k=' + encodeURIComponent('c:SSIS-001') + '&expand=1', { cookie: CK });
    const wl2 = readLines(CAT_LOG).filter(x => x.ev === 'work').pop();
    ok(wl2 && wl2.expand === false && last.h.get('x-expand-limited') === '1', '作品 expand:每令牌每分钟最多 10 次,超了降级成只读索引', [wl2, last.h.get('x-expand-limited')]);

    // —— 第二阶段:作品线路字段 / 标签 / 联想 / 上报 / 封面代理默认关 ——
    r = await api('GET', '/api/catalog/work?k=' + encodeURIComponent('c:SSIS-001'), { cookie: CK });
    {
        const by = Object.fromEntries(((r.j && r.j.sources) || []).map(x => [x.site_key, x]));
        ok(by.a && by.b && by.a._family === 'famA' && by.b._family === 'famB' && by.a._native === 'ok' && by.b._native === 'risky', '作品线路:_family / _native 按站点表重算(目录给的旧值不算)', [by.a, by.b]);
        ok(by.a._res === '1920x1080' && by.a._dead === false && by.b._dead === true && by.a._same === 'g1' && by.b._same === 'g1', '作品线路:_dead / _res / _same 照目录给的', [by.a, by.b]);
        const M = (r.j && r.j._meta) || {};
        ok(JSON.stringify(M.actress) === JSON.stringify(['テスト花子']) && M.siblings.length === 1 && M.siblings[0].wk === 'c:SSIS-001#U' && M.label_prefix === 'SSIS' && M.bucket_label === '中文字幕',
            '作品 _meta:演员过一遍查询硬拦词、兄弟作品按片名再过滤', M);
    }
    n0 = stubCount();
    r = await api('GET', '/api/catalog/tags?b=jp_censored', { cookie: CK });
    let tl = readLines(CAT_LOG).filter(x => x.ev === 'tags').pop();
    ok(r.status === 200 && tl && tl.b === 'jp_censored' && JSON.stringify(r.j) === JSON.stringify({ tags: [
        { id: 'milf', label: '人妻熟女', count: 9, featured: true }, { id: 'incest', label: '乱伦剧情', count: 5, featured: false }, { id: 'noncon', label: '强制凌辱', count: 3, featured: false }] })
        && /max-age=60/.test(r.h.get('cache-control') || ''), '/api/catalog/tags:{tags:[{id,label,count,featured}]},featured 只认 true、坏条目丢掉', [r.status, r.j, tl]);
    r = await api('GET', '/api/catalog/tags?b=' + encodeURIComponent('../x'), { cookie: CK });
    tl = readLines(CAT_LOG).filter(x => x.ev === 'tags').pop();
    ok(r.status === 200 && tl && tl.b === '!bad', '/api/catalog/tags:非法分区标成 !bad 交给目录', tl);
    r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('ssis-001'), { cookie: CK });
    ok(r.status === 200 && r.j.kind === 'code' && r.j.exact === 'c:SSIS-001' && r.j.items.length === 2 && /no-store/.test(r.h.get('cache-control') || ''), '/api/catalog/suggest:番号 → kind code + exact', r.j);
    r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('ssis-002'), { cookie: CK });
    ok(r.status === 200 && r.j.exact === null && JSON.stringify(r.j.items.map(c => c.wk)) === JSON.stringify(['c:SSIS-002']), '/api/catalog/suggest:片名被拦的卡片滤掉,exact 指向它 → null', r.j);
    r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('无码'), { cookie: CK });
    ok(r.j && r.j.kind === 'alias' && JSON.stringify(r.j.alias) === JSON.stringify({ label: '日本无码', b: 'jp_uncensored' }), '/api/catalog/suggest:别名 {b|tag,label}(多余字段不透传)', r.j);
    r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('周末'), { cookie: CK });
    ok(r.j && r.j.kind === 'text' && JSON.stringify(r.j.items.map(c => c.name)) === JSON.stringify(['邻家姐姐的周末']), '/api/catalog/suggest:未知 kind 当 text、卡片再过滤', r.j);
    const nSug = readLines(CAT_LOG).filter(x => x.ev === 'suggest').length;
    r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('迷奸 合集'), { cookie: CK });
    const r2s = await api('GET', '/api/catalog/suggest?q=', { cookie: CK });
    ok(r.j && r.j.kind === 'blocked' && r.j.items.length === 0 && r2s.j && r2s.j.kind === 'empty' && readLines(CAT_LOG).filter(x => x.ev === 'suggest').length === nSug,
        '/api/catalog/suggest:被拦 → blocked、空 → empty,都不进目录', [r.j, r2s.j]);
    r = await api('POST', '/api/catalog/beacon', { cookie: CK, json: { wk: 'c:SSIS-001', site_key: 'a', vod_id: 101, ok: false, err: 'x'.repeat(500), dur: 7200, w: 1280, h: 720 } });
    let bl = readLines(CAT_LOG).filter(x => x.ev === 'beacon').pop();
    ok(r.status === 204 && bl && bl.r.site_key === 'a' && bl.r.vod_id === '101' && bl.r.ok === false && bl.r.err.length === 200 && bl.r.dur === 7200 && bl.r.w === 1280
        && /^[0-9a-f]{32}$/.test(bl.who) && bl.who !== TOK && !bl.who.includes(TOK.slice(0, 16)), 'POST /api/catalog/beacon → 204;上报者只给哈希(不是令牌原文)', [r.status, bl]);
    const r1 = await fetch(B() + '/api/catalog/beacon', { method: 'POST', headers: { cookie: CK, 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ wk: 'c:SSIS-001', site_key: 'b', vod_id: '201', ok: true, dur: 7212 }) });
    bl = readLines(CAT_LOG).filter(x => x.ev === 'beacon').pop();
    ok(r1.status === 204 && bl && bl.r.site_key === 'b' && bl.r.ok === true, 'beacon:navigator.sendBeacon 的 text/plain JSON 也认', [r1.status, bl]);
    const nB = readLines(CAT_LOG).filter(x => x.ev === 'beacon').length;
    r = await api('POST', '/api/catalog/beacon', { cookie: CK, json: { site_key: 'a', vod_id: '101', ok: 'no' } });
    const rUnk = await api('POST', '/api/catalog/beacon', { cookie: CK, json: { site_key: 'd', vod_id: '401', ok: false } });
    ok(r.status === 400 && rUnk.status === 204 && readLines(CAT_LOG).filter(x => x.ev === 'beacon').length === nB, 'beacon:字段不对 → 400;停用站 → 204 但不进目录', [r.status, rUnk.status]);
    {
        const B2 = 'dg_t=' + ALICE;
        // 本机反代后面、没配 ADULT_CLIENT_IP_HEADER:伪造的 X-Real-IP 不改变上报者身份(同一个令牌 = 同一个上报者);不同令牌 = 不同上报者
        const whoOf = async (cookie, ip) => {
            const rr = await api('POST', '/api/catalog/beacon', { cookie, headers: { 'X-Real-IP': ip, 'X-Forwarded-For': ip }, json: { site_key: 'a', vod_id: '101', ok: false } });
            return [rr.status, (readLines(CAT_LOG).filter(x => x.ev === 'beacon').pop() || {}).who];
        };
        const w1 = await whoOf(CK, '203.0.113.1'), w2 = await whoOf(CK, '203.0.113.2'), w3 = await whoOf(B2, '203.0.113.3');
        ok(w1[0] === 204 && w2[0] === 204 && w3[0] === 204 && w1[1] && w1[1] === w2[1] && w3[1] && w3[1] !== w1[1], 'beacon:伪造转发头造不出新上报者;不同令牌才是不同上报者', [w1, w2, w3]);
        // ALICE 上面已经用了 1 次:再 59 次 204,之后 429;换伪造的转发头也开不出新配额
        let codes = [];
        for (let i = 0; i < 61; i++) codes.push((await api('POST', '/api/catalog/beacon', { cookie: B2, json: { site_key: 'a', vod_id: '101', ok: true } })).status);
        const spoof = (await api('POST', '/api/catalog/beacon', { cookie: B2, headers: { 'X-Real-IP': '198.51.100.9', 'X-Forwarded-For': '198.51.100.9' }, json: { site_key: 'a', vod_id: '101', ok: true } })).status;
        const other = (await api('POST', '/api/catalog/beacon', { cookie: CK, json: { site_key: 'a', vod_id: '101', ok: true } })).status;
        ok(codes.slice(0, 59).every(c => c === 204) && codes.slice(59).every(c => c === 429) && spoof === 429 && other === 204,
            'beacon:每令牌每分钟 60 次,超了 429;伪造 X-Real-IP / XFF 不另开配额(别的令牌不受影响)', [codes.slice(57), spoof, other]);
    }
    ok(stubCount() === n0, '标签 / 联想 / 上报 一个资源站都没打', stubLog.slice(n0).map(x => x.url));
    r = await api('GET', '/api/img?k=' + encodeURIComponent('c:SSIS-001') + '&s=a', { cookie: CK });
    ok(r.status === 404 && r.j && r.j.error === 'NOT_AVAILABLE' && !readLines(CAT_LOG).some(x => x.ev === 'picUrl'), '/api/img:默认关(ADULT_IMG_PROXY 没设)→ 404,不查目录', [r.status, r.j]);
    r = await api('GET', '/cache/adult-img/0000000000000000000000000000000000000000.jpg', { cookie: CK });
    ok(r.status === 404, '/cache/adult-img 直接访问 → 404(缓存只能经 /api/img)', r.status);

    // —— /api/config 与关掉的功能 ——
    r = await api('GET', '/api/config?token=' + TOK);
    const cfg = r.j || {};
    ok(cfg.adult === true && cfg.catalog === true && cfg.age_gate === true && cfg.site_name === 'DGX' && cfg.auth_required === true && cfg.rules_version === RV, '/api/config 成人站字段', cfg);
    ok(cfg.tmdb_api_key === null && cfg.tmdb_proxy_url === null && cfg.danmaku_enabled === false && cfg.requests_enabled === false && cfg.push_enabled === false
        && cfg.intro_enabled === false && cfg.live_enabled === false && cfg.img_proxy === false, '/api/config:TMDB/弹幕/求片/推送/片头/直播 都报关,img_proxy:false', cfg);
    r = await api('GET', '/api/auth/check');
    ok(r.j && r.j.shareTrial === 0 && r.j.requirePassword === true, '分享试看默认关(SHARE_TRIAL_MINUTES=0)', r.j);
    for (const p of ['/api/tmdb-proxy?path=/trending/all/week', '/api/tmdb-image/w300/abc.jpg', '/api/preview?name=x', '/sitemap.xml', '/movie/1', '/tv/1']) {
        const x = await api('GET', p, { cookie: CK });
        ok(x.status === 404, `${p} → 404`, x.status);
    }
    r = await api('GET', '/api/danmaku/v3/?id=' + encodeURIComponent('某片|第1集'), { cookie: CK });
    ok(r.status === 200 && r.j && Array.isArray(r.j.data) && r.j.data.length === 0, '弹幕:空');
    r = await api('GET', '/api/requests/mine?token=' + ALICE);
    ok(r.status === 403, '求片:关', r.status);
    r = await api('GET', '/api/intro/marks?title=x&site=a');
    const r2 = await api('POST', '/api/intro/mark', { json: { token: TOK, title: 'x', site: 'a', ep: 1, op_start: 10, op_end: 100 } });
    ok(r.j && JSON.stringify(r.j.marks) === '{}' && r2.status === 403, '片头:读空、写拒', [r.j, r2.status]);
    r = await api('GET', '/api/push/key');
    ok(r.status === 404 && r.j && r.j.enabled === false, '推送:关', r.j);
    r = await api('GET', '/api/live/channels');
    ok(r.j && r.j.enabled === false, '直播:关');
    r = await api('GET', '/?play=' + encodeURIComponent('某片') + '&s=abcdef', { headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
    ok(r.status === 200 && r.text.includes('id="app"') && !r.text.includes('正在进入播放页'), '社交爬虫打开分享链:不出分享卡片页,一律回 SPA');
    ok(/noindex/.test(r.h.get('x-robots-tag') || ''), '页面带 X-Robots-Tag: noindex', r.h.get('x-robots-tag'));

    // —— 历史 / 热门 / 收藏 ——
    r = await api('POST', '/api/history/push', { json: { token: ALICE, history: [
        { id: 'h1', data: { name: '邻家姐姐的周末' }, updated_at: Date.now() },
        { id: 'h2', data: { name: '准高一少女 初恋' }, updated_at: Date.now() },
        { id: 'h4', data: { name: '某作品', groupData: { name: '某作品', sources: [{ site_key: 'a', vod_id: '103', vod_name: '情侣自拍流出 周末合集' }] } }, updated_at: Date.now() },
        { id: 'h5', data: JSON.stringify({ name: '准高一少女 初恋' }), updated_at: Date.now() },   // data 塞成 JSON 字符串也要查片名
        { id: 'h6', data: '准高一少女 初恋', updated_at: Date.now() },                            // 纯字符串当片名查
    ] } });
    ok(r.j && r.j.saved === 1, '历史上报:片名/线路被拦的不入库', r.j);
    db.prepare('INSERT OR REPLACE INTO user_history (user_token, item_id, item_data, updated_at) VALUES (?, ?, ?, ?)').run(ALICE, 'h3', JSON.stringify({ name: '情侣自拍流出 合集' }), Date.now());
    r = await api('GET', '/api/history/pull?token=' + ALICE);
    ok(r.j && r.j.sync_enabled && JSON.stringify(r.j.history.map(h => h.id)) === JSON.stringify(['h1']), '历史下发:库里被拦的条目不下发', r.j && r.j.history.map(h => h.id));
    db.exec(`CREATE TABLE IF NOT EXISTS watch_stats (
        user_token TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, episode TEXT NOT NULL DEFAULT '',
        seconds INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, first_at INTEGER, last_at INTEGER,
        PRIMARY KEY (user_token, kind, title, episode)) WITHOUT ROWID`);
    const ins = db.prepare("INSERT OR REPLACE INTO watch_stats (user_token, kind, title, episode, seconds, completed, first_at, last_at) VALUES (?, 'vod', ?, '1', 600, 0, ?, ?)");
    for (const u of ['u1', 'u2', 'u3']) for (const t of ['邻家姐姐的周末', '准高一少女 初恋']) ins.run(u, t, Date.now(), Date.now());
    r = await api('GET', '/api/popular?token=' + TOK, { cookie: CK });
    const titles = (r.j && r.j.items || []).map(x => x.title);
    ok(r.status === 200 && titles.includes('邻家姐姐的周末') && !titles.includes('准高一少女 初恋'), '热门:被拦片名不上榜', r.j);
    r = await api('GET', '/api/popular', { cookie: CK });
    ok(r.status === 200 && Array.isArray(r.j && r.j.items) && r.j.items.some(x => x.title === '邻家姐姐的周末') && /Cookie/i.test(r.h.get('vary') || ''), '/api/popular:只带 dg_t Cookie(不带 ?token=)也认,回包 Vary: Cookie', [r.status, r.j, r.h.get('vary')]);
    r = await api('GET', '/api/popular', { headers: { 'x-dg-token': TOK } });
    ok(r.status === 200, '/api/popular:x-dg-token 头也认', r.status);
    r = await api('GET', '/api/popular', { cookie: 'dg_t=' + sha('nope') });
    ok(r.status === 401, '/api/popular:错 Cookie → 401', r.status);
    await api('GET', '/api/catalog/tags?b=probe_popular', { cookie: CK });
    const pl = readLines(CAT_LOG).filter(x => x.ev === 'popular').pop();
    ok(pl && Array.isArray(pl.titles) && pl.titles.includes('邻家姐姐的周末'), 'server.js 把 lib/popular 的片名交给目录(本站热门行;按匿名口径,3 人看过的才有)', pl);
    r = await api('POST', '/api/favorites/add', { json: { token: ALICE, item: { name: '准高一少女 初恋' } } });
    ok(r.status === 400, '收藏:被拦片名加不进去', [r.status, r.j]);
    r = await api('POST', '/api/favorites/add', { json: { token: ALICE, item: { name: '邻家姐姐的周末' } } });
    ok(r.j && r.j.ok, '收藏:正常片名照常', r.j);
    db.prepare('INSERT OR REPLACE INTO user_favorites (user_token, fav_id, data, added_at, updated_at, seen_count) VALUES (?, ?, ?, ?, ?, 0)').run(ALICE, 'fx', JSON.stringify({ name: '情侣自拍流出 合集', sources: [] }), Date.now(), Date.now());
    r = await api('GET', '/api/favorites?token=' + ALICE);
    ok(r.j && JSON.stringify(r.j.items.map(x => x.data.name)) === JSON.stringify(['邻家姐姐的周末']), '收藏列表:库里被拦的不下发', r.j && r.j.items.map(x => x.data.name));
    db.close();
} catch (e) {
    ok(false, '② 异常: ' + (e && e.stack || e), srvLog.slice(-2000));
} finally { await stopServer(); }

// ---------------------------------------------------------------- ②b 封面代理开着(ADULT_IMG_PROXY=1,目录 = 替身)
console.log('②b 封面代理(ADULT_IMG_PROXY=1)');
try {
    await startServer({ ACCESS_PASSWORD: 'test', CACHE_TYPE: 'sqlite', CACHE_DB_PATH: path.join(tmp, 'cache-img.db'), ADULT_TEST_CATALOG_STUB: path.join(FIX, 'catalog-stub.cjs'), ADULT_TEST_CATALOG_LOG: CAT_LOG,
        ADULT_IMG_PROXY: '1', ADULT_TEST_IMG_BASE: STUB, ADULT_CLIENT_IP_HEADER: 'x-real-ip' }, ['-r', path.join(FIX, 'catalog-hook.cjs')]);
    const CK = 'dg_t=' + sha('test');
    let r = await api('GET', '/api/config?token=' + sha('test'));
    ok(r.j && r.j.img_proxy === true, '/api/config img_proxy:true', r.j);
    r = await api('GET', '/api/img?k=' + encodeURIComponent('c:SSIS-001') + '&s=a');
    ok(r.status === 401, '/api/img 要鉴权', r.status);
    const n0 = stubCount();
    const nPic = readLines(CAT_LOG).filter(x => x.ev === 'picUrl').length;
    r = await api('GET', '/api/img?k=' + encodeURIComponent('c:SSIS-001') + '&s=a&url=' + encodeURIComponent(STUB + '/img/evil.jpg'), { cookie: CK });
    const pq = readLines(CAT_LOG).filter(x => x.ev === 'picUrl');
    ok(r.status === 502 && r.j && r.j.error === 'REFUSED' && pq.length === nPic + 1 && pq[pq.length - 1].k === 'c:SSIS-001' && pq[pq.length - 1].s === 'a' && pq[pq.length - 1].meta === true,
        '/api/img:地址从目录索引查(按 k/s),请求里的 url= 不看', [r.status, r.j, pq.slice(-1)]);
    ok(stubCount() === n0, '/api/img:索引里的地址是回环地址 → 拒,一次都不连(SSRF)', stubLog.slice(n0).map(x => x.url));
    r = await api('GET', '/api/img?k=' + encodeURIComponent('t:blocked1'), { cookie: CK });
    ok(r.status === 404, '/api/img:片名被拦的作品 → 404(不取)', r.status);
    r = await api('GET', '/api/img?k=' + encodeURIComponent('c:NOPE-001') + '&s=a', { cookie: CK });
    ok(r.status === 404, '/api/img:索引里没有 → 404', r.status);
    r = await api('GET', '/api/img?url=' + encodeURIComponent('https://img.example/a.jpg'), { cookie: CK });
    ok(r.status === 400, '/api/img:只给 url= → 400', r.status);
    r = await api('GET', '/cache/adult-img/x.jpg', { cookie: CK });
    ok(r.status === 404, '/cache/adult-img 直接访问 → 404', r.status);
    // 旧缓存位置的路径归一化绕过(//、/./、x/../、%2f、\、结尾点、大小写)也拦;新缓存目录不在 public/ 下
    {
        // server.js 的 /cache 静态目录是相对 cwd 的 public/cache(子进程 cwd = 临时目录)→ 探针文件放临时目录里,不碰仓库
        const oldDir = path.join(tmp, 'public', 'cache', 'adult-img');
        const probe = 'ffffffffffffffffffffffffffffffffffffffff.jpg';
        let made = false;
        try { fs.mkdirSync(oldDir, { recursive: true }); fs.writeFileSync(path.join(oldDir, probe), 'PROBE'); fs.writeFileSync(path.join(tmp, 'public', 'cache', 'ok.txt'), 'OKFILE'); made = true; } catch (e) { }
        const ctl = await (async () => { const rr = await fetch(B() + '/cache/ok.txt'); return [rr.status, await rr.text()]; })();
        ok(made && ctl[0] === 200 && ctl[1] === 'OKFILE', '对照:/cache 静态目录本身能取到文件(说明下面的 404 是拦下来的)', ctl);
        const raw = (p) => new Promise((resolve) => {
            const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { cookie: CK } }, (rs) => { let t = ''; rs.on('data', d => { t += d; }); rs.on('end', () => resolve([rs.statusCode, t])); });
            rq.on('error', (e) => resolve([0, String(e)])); rq.end();
        });
        const variants = ['/cache/adult-img/' + probe, '/cache//adult-img/' + probe, '/cache/./adult-img/' + probe, '/cache/x/../adult-img/' + probe, '/cache/adult-img%2f' + probe,
            '/cache/adult-img%5c' + probe, '/cache/ADULT-IMG/' + probe, '/cache/adult-img./' + probe, '/cache/%61dult-img/' + probe];
        const got = [];
        for (const v of variants) got.push([v, ...(await raw(v))]);
        ok(got.every(g => g[1] === 404 && g[2] !== 'PROBE'), '旧缓存位置 /cache/adult-img 的各种路径变体都 404', got.filter(g => g[1] !== 404 || g[2] === 'PROBE'));
        try { fs.unlinkSync(path.join(oldDir, probe)); fs.unlinkSync(path.join(tmp, 'public', 'cache', 'ok.txt')); } catch (e) { }
        // 上报者身份:配了 ADULT_CLIENT_IP_HEADER=x-real-ip → 同一个令牌、不同 X-Real-IP = 不同上报者;没带这个头 = 只按令牌
        const whoOf = async (ip) => {
            const rr = await api('POST', '/api/catalog/beacon', { cookie: CK, headers: ip ? { 'X-Real-IP': ip } : {}, json: { site_key: 'a', vod_id: '101', ok: false } });
            return [rr.status, (readLines(CAT_LOG).filter(x => x.ev === 'beacon').pop() || {}).who];
        };
        const a1 = await whoOf('203.0.113.1'), a1b = await whoOf('203.0.113.1'), a2 = await whoOf('203.0.113.2'), a0 = await whoOf('');
        ok([a1, a1b, a2, a0].every(x => x[0] === 204 && /^[0-9a-f]{32}$/.test(x[1] || '')) && a1[1] === a1b[1] && a1[1] !== a2[1] && a0[1] !== a1[1], 'beacon:配了可信 IP 头 → 令牌 + 客户端网络 区分上报者', [a1, a1b, a2, a0]);
    }
} catch (e) {
    ok(false, '②b 异常: ' + (e && e.stack || e), srvLog.slice(-2000));
} finally { await stopServer(); }

// ---------------------------------------------------------------- ③ 没配密码 + memory 缓存
console.log('③ 没配密码 + memory 缓存(目录不可用)');
try {
    await startServer({ ACCESS_PASSWORD: '', CACHE_TYPE: 'memory', INTRO_DISABLE: '0', SHARE_PAGE_DISABLE: '0' });
    ok(/没有配置 ACCESS_PASSWORD/.test(srvLog), '启动时告警:内容接口对所有人开放');
    const AGE = 'dg_age=1';
    let r0 = await api('GET', '/api/search?wd=' + encodeURIComponent('周末'));
    ok(r0.status === 401 && r0.j && r0.j.error === 'AGE_REQUIRED' && /no-store/.test(r0.h.get('cache-control') || ''), '没配密码:没有年龄确认 Cookie → 401 AGE_REQUIRED', [r0.status, r0.j]);
    r0 = await api('GET', '/api/catalog/home', { cookie: 'dg_age=0' });
    ok(r0.status === 401 && r0.j && r0.j.error === 'AGE_REQUIRED', '没配密码:dg_age 不是 1 也不行', [r0.status, r0.j]);
    r0 = await api('GET', '/api/search?wd=' + encodeURIComponent('周末'), { headers: { 'x-dg-age': '1' } });
    ok(r0.status === 200 && r0.j && Array.isArray(r0.j.list), '没配密码:x-dg-age: 1 头也算确认过', [r0.status, r0.j]);
    r0 = await api('GET', '/api/config');
    ok(r0.status === 200, '没配密码:非内容接口(/api/config)不要年龄确认', r0.status);
    const s = await sse('/api/search?wd=' + encodeURIComponent('周末') + '&stream=true', AGE);
    ok(s.status === 200 && JSON.stringify(s.items.map(keyOf).sort()) === JSON.stringify(['a_102', 'b_204']), '没配密码:带年龄确认 Cookie、不带令牌也能搜(仍然过滤)', s.items.map(keyOf));
    let r = await api('GET', '/api/catalog/home', { cookie: AGE });
    ok(r.status === 503 && r.j && r.j.error === 'CATALOG_UNAVAILABLE', '非 sqlite:目录 503 CATALOG_UNAVAILABLE', [r.status, r.j]);
    r = await api('GET', '/api/catalog/work?k=c:SSIS-001', { cookie: AGE });
    ok(r.status === 503, '非 sqlite:作品 503');
    r = await api('GET', '/api/config');
    ok(r.j && r.j.catalog === false && r.j.auth_required === false && r.j.intro_enabled === true, '/api/config:catalog:false / auth_required:false / 显式 INTRO_DISABLE=0 → intro_enabled:true', r.j);
    r = await api('POST', '/api/intro/mark', { json: { title: 'x', site: 'a', ep: 'bad' } });
    ok(r.status === 400, '显式 INTRO_DISABLE=0:片头接口回到原实现(参数错 400,而不是关闭的 403)', r.status);
    r = await api('GET', '/api/push/key');
    ok(r.status === 404, '推送仍是默认关');
    r = await api('GET', '/?play=' + encodeURIComponent('邻家姐姐的周末'), { headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
    ok(r.status === 200 && /og:title/.test(r.text) && !/themoviedb/.test(r.text), '显式 SHARE_PAGE_DISABLE=0:爬虫拿到分享卡片(海报用站点图标,不碰 TMDB)', r.text.slice(0, 200));
} catch (e) {
    ok(false, '③ 异常: ' + (e && e.stack || e), srvLog.slice(-2000));
} finally { await stopServer(); }

// ---------------------------------------------------------------- ④ 真 lib/site-catalog
console.log('④ 真 lib/site-catalog');
if (!fs.existsSync(path.join(ROOT, 'lib/site-catalog/index.js'))) {
    console.log('  (仓库里还没有 lib/site-catalog/index.js,跳过)');
} else {
    try {
        const n0 = stubCount();
        await startServer({ ACCESS_PASSWORD: 'test', CACHE_TYPE: 'sqlite', CACHE_DB_PATH: path.join(tmp, 'cache-real.db'), CATALOG_FIRST_DELAY_MS: '0' });
        const CK = 'dg_t=' + sha('test');
        ok(!/首页目录不可用/.test(srvLog), '真目录模块加载成功', srvLog.slice(-800));
        let home = null;
        for (let i = 0; i < 40; i++) {
            await sleep(250);
            const r = await api('GET', '/api/catalog/home', { cookie: CK });
            if (r.status === 200) home = r.j;
            if (home && Array.isArray(home.rows) && home.rows.some(x => x.items && x.items.length)) break;
        }
        ok(home && Array.isArray(home.rows) && 'generatedAt' in home, '真目录:/api/catalog/home 形状 {generatedAt, rows[]}', home);
        const cards = (home && home.rows || []).flatMap(x => x.items || []);
        ok(cards.every(c => c && typeof c.wk === 'string' && typeof c.name === 'string'), '真目录:卡片有 wk/name');
        const blockedNames = new Set(Object.values(DATA.sites).flat().filter(x => x.blocked).map(x => x.vod_name));
        ok(!cards.some(c => blockedNames.has(c.name)), '真目录:首页没有被拦条目', cards.map(c => c.name));
        let r = await api('GET', '/api/catalog/buckets', { cookie: CK });
        ok(r.status === 200 && Array.isArray(r.j), '真目录:/api/catalog/buckets 是数组', r.j);
        r = await api('GET', '/api/catalog/browse?b=cn_amateur&page=1', { cookie: CK });
        ok(r.status === 200 && r.j && Array.isArray(r.j.results) && 'total_pages' in r.j && 'total_results' in r.j, '真目录:/api/catalog/browse 形状', r.j);
        ok(!(r.j && r.j.results || []).some(c => blockedNames.has(c.name)), '真目录:浏览没有被拦条目');
        r = await api('GET', '/api/catalog/browse?b=' + encodeURIComponent('../../etc') + '&page=abc', { cookie: CK });
        ok(r.status === 200 && r.j && Array.isArray(r.j.results) && r.j.results.length === 0 && r.j.total_results === 0, '真目录:非法分区 → 空页(不能变成"全部分区")', r.j);
        r = await api('GET', '/api/catalog/work?k=' + encodeURIComponent('c:SSIS-001'), { cookie: CK });
        ok(r.status === 200 || r.status === 404, '真目录:/api/catalog/work 200 或 404', [r.status, r.text.slice(0, 200)]);
        if (r.status === 200) ok(Array.isArray(r.j.sources) && r.j.sources.every(x => x.site_name && x.site_key !== 'd'), '真目录:作品线路都有站名、没有停用站', r.j.sources);
        if (r.status === 200) {
            ok(r.j.sources.every(x => typeof x._family === 'string' && typeof x._dead === 'boolean' && typeof x._res === 'string' && (x._native === 'ok' || x._native === 'risky') && typeof x._same === 'string')
                && r.j.sources.filter(x => x.site_key === 'b').every(x => x._native === 'risky' && x._family === 'famB'), '真目录:线路带 _family/_dead/_res/_native/_same', r.j.sources);
            const M = r.j._meta || {};
            ok(typeof M.bucket_label === 'string' && Array.isArray(M.tags) && Array.isArray(M.actress) && Array.isArray(M.siblings) && typeof M.label_prefix === 'string' && typeof M.first_seen === 'number', '真目录:_meta 第二阶段字段', M);
        }
        r = await api('GET', '/api/catalog/tags', { cookie: CK });
        ok(r.status === 200 && r.j && Array.isArray(r.j.tags) && r.j.tags.every(t => typeof t.id === 'string' && typeof t.featured === 'boolean' && t.count > 0), '真目录:/api/catalog/tags 形状', r.j);
        r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('ssis001'), { cookie: CK });
        ok(r.status === 200 && r.j && r.j.kind === 'code' && Array.isArray(r.j.items) && ('exact' in r.j) && ('alias' in r.j), '真目录:/api/catalog/suggest 形状', r.j);
        r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('人妻'), { cookie: CK });
        ok(r.status === 200 && r.j && r.j.kind === 'alias' && r.j.alias && r.j.alias.tag === 'milf', '真目录:联想别名', r.j);
        const nb = stubCount();
        r = await api('POST', '/api/catalog/beacon', { cookie: CK, json: { wk: 'c:SSIS-001', site_key: 'a', vod_id: '101', ok: true, dur: 7210, w: 1280, h: 720 } });
        ok(r.status === 204 && stubCount() === nb, '真目录:上报 204、零上游', r.status);
        r = await api('GET', '/api/img?k=c:SSIS-001&s=a', { cookie: CK });
        ok(r.status === 404, '真目录:/api/img 默认关', r.status);
        const crawl = stubLog.slice(n0);
        console.log(`  (真目录:首页 ${(home && home.rows || []).length} 行 / ${cards.length} 张卡;假站收到 ${crawl.length} 个请求:${[...new Set(crawl.map(x => x.site + ':' + x.q.ac))].join(' ')})`);
        ok(!crawl.some(x => /^\/(media|img)\//.test(x.path)), '真目录:爬虫绝不拉 m3u8 / 图片', crawl.filter(x => /^\/(media|img)\//.test(x.path)).map(x => x.url));
        ok(!crawl.some(x => x.site === 'd'), '真目录:不爬停用站', crawl.filter(x => x.site === 'd').map(x => x.url));
        ok(crawl.every(x => x.q.ac === 'list' || x.q.ac === 'detail' || x.q.ac === 'videolist'), '真目录:只调 maccms API(ac=list/detail)', crawl.map(x => x.url).slice(0, 10));
    } catch (e) {
        ok(false, '④ 异常: ' + (e && e.stack || e), srvLog.slice(-2000));
    } finally { await stopServer(); }
}

// ---------------------------------------------------------------- ⑤ api/index.js(Vercel)
console.log('⑤ api/index.js(Vercel)');
{
    const vport = 20000 + Math.floor(Math.random() * 20000);
    const env = childEnv({ SITES_JSON: JSON.stringify({ sites: SITES }), ACCESS_PASSWORD: 'test' });
    delete env.DB_FILE;
    const p = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'api/index.js'))}).listen(${vport})`], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let vlog = ''; p.stdout.on('data', d => { vlog += d; }); p.stderr.on('data', d => { vlog += d; });
    const V = (q) => fetch(`http://127.0.0.1:${vport}${q}`).then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));
    try {
        let up = false;
        for (let i = 0; i < 100 && !up; i++) { await sleep(100); try { up = (await fetch(`http://127.0.0.1:${vport}/api/debug`)).ok; } catch (e) { } }
        ok(up, 'api/index.js 起来了', vlog.slice(-800));
        const n0 = stubCount();
        for (const q of ['/api/search?wd=' + encodeURIComponent('周末') + '&stream=true', '/api/detail?id=101&site_key=a', '/api/catalog/home', '/api/kz/ep/a/b']) {
            const r = await V(q);
            ok(r.status === 503 && r.j && r.j.error === 'ADULT_VERCEL_UNSUPPORTED', `Vercel ${q} → 503`, r);
        }
        ok(stubCount() === n0, 'Vercel:一个资源站都没打');
        for (const q of ['/api/tmdb-proxy?path=/x', '/api/tmdb-image/w300/a.jpg', '/api/preview?name=x']) {
            const r = await V(q);
            ok(r.status === 404, `Vercel ${q} → 404`, r.status);
        }
        let r = await V('/api/config');
        ok(r.j && r.j.adult === true && r.j.catalog === false && r.j.vercel_unsupported === true && r.j.tmdb_api_key === null && r.j.danmaku_enabled === false && r.j.rules_version === RV, 'Vercel /api/config 带成人字段', r.j);
        r = await V('/api/danmaku/v3/?id=x');
        ok(r.status === 200 && r.j && r.j.data.length === 0, 'Vercel 弹幕:默认关(空)');
        r = await V('/api/sites');
        ok(r.status === 200 && r.j && Array.isArray(r.j.sites), 'Vercel /api/sites 照常(外壳)', r.status);
    } finally { const e = new Promise(res => p.once('exit', res)); p.kill(); await e; }
}

stub.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
