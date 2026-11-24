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
//  ⑥ 第四阶段(目录 / 镜像 = 替身,scripts/fixtures/adult-server/mirror-stub.cjs):/api/catalog/related、/feed、GET|POST /heat 的出口过滤 / 校验 / 限流 /
//     上报者哈希(dev 原文不落地);beacon orient;换域名跟随接线(搜索 / 爬虫 / /api/sites 走 apiFor,闸门与 catalogHttpGet 的结果 report 回去);
//     后台:没配 ADMIN_TOKEN 全 404、错令牌 401 + 锁定、测试台、追加屏蔽词只会更严 + 持久化 + 重启并集、隐藏作品处处不出、站点停用持久化、镜像状态 / 探测
//     复核 SEC-2:POST /api/adult/admin/mirror/reset(回到主地址)。复核 SEC-3(① 里,进程内闸门 + 假 app):公网直连、没配 ADULT_CLIENT_IP_HEADER 时
//     客户端自己写的转发头不改变客户端键(热度扇出上限照样生效、后台锁定按 IPv6 /64)、Cloudflare 回源地址认不出、clientKeyOf 的 p: 键也按 /64
//  (换域名跟随本身的逻辑见 scripts/adult-mirror-test.mjs)
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
    ok(c2.adult === true && c2.age_gate === true && c2.site_name === 'MEI.NU' && c2.tmdb_api_key === null && c2.push_enabled === false && c2.rules_version === RV && c2.img_proxy === false, 'configFields(img_proxy 默认 false)', c2);
    ok(Array.isArray(c2.cover_dead_hosts) && c2.cover_dead_hosts.length === 0, 'configFields:没有目录 → cover_dead_hosts []', c2.cover_dead_hosts);
    ok(c2.purchase_url === 'https://ednovas.me', 'configFields:没配 PURCHASE_URL → 购买链接沿用主站 ednovas.me', c2.purchase_url);
    {
        const pu = (v) => gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => true, ownToken: () => false, env: { PURCHASE_URL: v } }).configFields().purchase_url;
        ok(pu('https://shop.example.test/buy?a=1') === 'https://shop.example.test/buy?a=1' && pu('  https://x.example.test  ') === 'https://x.example.test', 'PURCHASE_URL 配了 http(s) 地址 → 用它', [pu('https://shop.example.test/buy?a=1')]);
        ok(['0', 'off', 'OFF', 'none', 'false', 'no'].every(v => pu(v) === ''), 'PURCHASE_URL=0/off/none/false/no → 不显示购买链接');
        ok(pu('javascript:alert(1)') === 'https://ednovas.me' && pu('https://a b') === 'https://ednovas.me' && pu('https://x.example.test/' + 'a'.repeat(400)) === 'https://ednovas.me', 'PURCHASE_URL 配错(非 http(s)/带空格/超长)→ 回到主站地址');
    }
    {
        const big = Array.from({ length: 260 }, (_, i) => 'h' + i + '.example');
        const okTok = (t) => t === 'good' || t === 'bannedtok';
        const gBig = gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => true, ownToken: okTok, isBanned: (t) => t === 'bannedtok', env: {}, catalog: () => ({ coverDeadHosts: () => big }) });
        const gThrow = gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => true, ownToken: okTok, env: {}, catalog: () => ({ coverDeadHosts: () => { throw new Error('x'); } }) });
        const authed = { headers: { 'x-dg-token': 'good' }, query: {} };
        ok(gBig.configFields(authed).cover_dead_hosts.length === 200 && JSON.stringify(gThrow.configFields(authed).cover_dead_hosts) === '[]', 'configFields:cover_dead_hosts ≤200;目录出错 → []');
        // 只给能看目录的请求(和 requireAuth 同口径):要登录的站 = 自己的有效令牌、没被封;公开站 = 确认过年龄;没给 req = 不给
        const n = (gg, req) => gg.configFields(req).cover_dead_hosts.length;
        ok(n(gBig, undefined) === 0 && n(gBig, { headers: {}, query: {} }) === 0 && n(gBig, { headers: { 'x-dg-token': 'nope' }, query: {} }) === 0
            && n(gBig, { headers: { cookie: 'dg_age=1' }, query: {} }) === 0 && n(gBig, { headers: { 'x-dg-token': 'bannedtok' }, query: {} }) === 0
            && n(gBig, { headers: { cookie: 'dg_t=good' }, query: {} }) === 200 && n(gBig, { headers: {}, query: { token: 'good' } }) === 200,
        'configFields:要登录的站 —— 没令牌 / 令牌不对 / 只有年龄 Cookie / 被封的令牌 → [];Cookie 或 ?token= 的有效令牌 → 给');
        const gPub = gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => false, ownToken: () => false, env: {}, catalog: () => ({ coverDeadHosts: () => ['a.example'] }) });
        ok(n(gPub, { headers: { cookie: 'dg_age=1' }, query: {} }) === 1 && n(gPub, { headers: { 'x-dg-age': '1' }, query: {} }) === 1 && n(gPub, { headers: {}, query: {} }) === 0,
            'configFields:公开站 —— 确认过年龄才给');
    }
    // 上报者身份:只信直连的公网对端,或运维声明的反代头;客户端自己写的转发头造不出新身份
    const rq = (peer, headers) => ({ headers: headers || {}, socket: { remoteAddress: peer } });
    const T = gate.trustedClientNet;
    ok(T(rq('127.0.0.1', { 'x-real-ip': '203.0.113.1' }), '') === '' && T(rq('::ffff:127.0.0.1', { 'x-forwarded-for': '198.51.100.7' }), '') === ''
        && T(rq('172.17.0.1', { 'cf-connecting-ip': '8.8.8.8' }), '') === '' && T(rq('::1'), '') === '', '上报者身份:本机/内网反代后面、没配头 → 认不出(转发头不算)');
    // 复核 SEC-3:直连的公网对端自己加转发头不再"认不出"(以前一加 X-Forwarded-For 就退到按单个地址算 → 热度扇出上限没了、IPv6 不按 /64)
    ok(T(rq('8.8.8.8'), '') === '8.8.8.8' && T(rq('::ffff:8.8.4.4'), '') === '8.8.4.4' && T(rq('8.8.8.8', { 'x-real-ip': '1.2.3.4' }), '') === '8.8.8.8'
        && T(rq('9.9.9.9', { 'x-forwarded-for': '1.1.1.1' }), '') === '9.9.9.9' && T(rq('9.9.9.9', { forwarded: 'for=1.1.1.1', 'true-client-ip': '1.1.1.2' }), '') === '9.9.9.9',
    '复核 SEC-3:直连公网对端可信,客户端自己写的转发头(XFF / X-Real-IP / Forwarded …)不改变它', [T(rq('8.8.8.8', { 'x-real-ip': '1.2.3.4' }), ''), T(rq('9.9.9.9', { 'x-forwarded-for': '1.1.1.1' }), '')]);
    ok(T(rq('172.70.12.34', { 'cf-connecting-ip': '8.8.8.8' }), '') === '' && T(rq('104.16.0.1'), '') === '' && T(rq('2606:4700:10::6816:1'), '') === '' && T(rq('2a06:98c7:1::1'), '') === ''
        && T(rq('2a06:98d0::1'), '') === '2a06:98d0:0:0::/64' && T(rq('172.80.0.1'), '') === '172.80.0.1' && T(rq('104.32.0.1'), '') === '104.32.0.1',
    '复核 SEC-3:对端是 Cloudflare 回源地址(没配头的 CDN)→ 认不出;段外的照常', [T(rq('2a06:98d0::1'), ''), T(rq('172.80.0.1'), '')]);
    ok(T(rq('2001:4860:1:2:aaaa::1'), '') === T(rq('2001:4860:1:2:bbbb::9'), '') && T(rq('2001:4860:1:2:aaaa::1'), '') !== T(rq('2001:4860:1:3::1'), ''), '上报者身份:IPv6 按 /64 归并');
    // 客户端键(限流 / 后台锁定 / 热度扇出):没配头时只看对端,转发头带不带都一样;认不出时也按对端网络(IPv6 /64)
    const K = gate.clientKeyOf;
    ok(typeof K === 'function'
        && K(rq('2a01:4f8:c0c:1234::5'), '') === K(rq('2a01:4f8:c0c:1234::99', { 'x-forwarded-for': '1.2.3.4' }), '') && K(rq('2a01:4f8:c0c:1234::5'), '') === 'n:2a01:4f8:c0c:1234::/64'
        && K(rq('45.33.10.20', { 'x-forwarded-for': '1.1.1.1' }), '') === 'n:45.33.10.20' && K(rq('45.33.10.20'), '') === 'n:45.33.10.20'
        && K(rq('fd00:1:2:3::7', { 'x-real-ip': '8.8.8.8' }), '') === K(rq('fd00:1:2:3::8'), '') && K(rq('fd00:1:2:3::7'), '') === 'p:fd00:1:2:3::/64'
        && K(rq('2606:4700:10::1', { 'cf-connecting-ip': '2a01::1' }), '') === 'p:2606:4700:10:0::/64' && K(rq('127.0.0.1'), '') === 'p:127.0.0.1'
        && K(rq('127.0.0.1', { 'x-real-ip': '2a01:4f8:c0c:1234::5' }), 'x-real-ip') === 'n:2a01:4f8:c0c:1234::/64' && K(rq('fd00::1', {}), 'x-real-ip') === 'p:fd00:0:0:0::/64',
    '复核 SEC-3:clientKeyOf —— 转发头开不出新键、IPv6 一律 /64(含认不出时的 p: 键);配了 ADULT_CLIENT_IP_HEADER 照旧只认它',
    typeof K === 'function' ? [K(rq('2a01:4f8:c0c:1234::5'), ''), K(rq('2a01:4f8:c0c:1234::99', { 'x-forwarded-for': '1.2.3.4' }), ''), K(rq('fd00:1:2:3::7'), ''), K(rq('2606:4700:10::1', { 'cf-connecting-ip': '2a01::1' }), ''), K(rq('fd00::1', {}), 'x-real-ip')] : 'clientKeyOf 没导出');
    // 进程内挂一个闸门(假 app,不起服务器):公网直连 + 没配头 → 热度扇出上限照样生效、后台锁定按 /64(带不带转发头都一样)
    {
        const routes = {}, adminMw = [];
        const fakeApp = {
            use(p, ...fns) { if (p === '/api/adult/admin' && fns.length === 1 && typeof fns[0] === 'function' && fns[0].length === 3) adminMw.push(fns[0]); },
            get(p, ...h) { [].concat(p).forEach((x) => { routes['GET ' + x] = h[h.length - 1]; }); },
            post(p, ...h) { [].concat(p).forEach((x) => { routes['POST ' + x] = h[h.length - 1]; }); },
            put(p, ...h) { [].concat(p).forEach((x) => { routes['PUT ' + x] = h[h.length - 1]; }); },
            delete() { },
        };
        const adds = [];
        const cat = { heatAdd: async (wk, o, who) => { adds.push(who); return true; }, heat: async () => null, adminHidden: async () => [], isHidden: () => false };
        const g3 = gate.createAdultGate({ adult, allSites: () => [], authConfigured: () => true, ownToken: () => true, env: { ADULT_ADMIN_TOKEN: 'sec3-admin-token-0123456789' }, catalog: () => cat, log: () => { } });
        g3.register(fakeApp);
        const heatH = routes['POST /api/catalog/heat'], auth = adminMw[0];
        const fres = () => { const r = { code: 200, j: null, set() { return r; }, setHeader() { return r; }, status(c) { r.code = c; return r; }, json(j) { r.j = j; return r; }, end() { return r; } }; return r; };
        const B100 = Buffer.alloc(100, 7).toString('base64');
        const heatReq = (peer, dev, wk, hdrs) => ({ method: 'POST', headers: Object.assign({ 'x-dg-token': 'sec3tok' }, hdrs || {}), query: {}, params: {}, socket: { remoteAddress: peer }, body: { wk, dur: 3600, bins: B100, dev } });
        if (typeof heatH !== 'function' || typeof auth !== 'function') ok(false, '进程内闸门:没拿到 POST /api/catalog/heat 或后台鉴权中间件', Object.keys(routes).length);
        else {
            for (const d of ['devSEC3noHdr01', 'devSEC3noHdr02', 'devSEC3noHdr03']) await heatH(heatReq('45.33.10.20', d, 'c:SEC-301'), fres());
            const nNo = adds.length;
            for (const d of ['devSEC3xff0001', 'devSEC3xff0002', 'devSEC3xff0003']) await heatH(heatReq('45.33.10.20', d, 'c:SEC-302', { 'x-forwarded-for': '1.1.1.' + d.slice(-1) }), fres());
            const nX = adds.length - nNo;
            for (const d of ['devSEC3v6xff01', 'devSEC3v6xff02', 'devSEC3v6xff03']) await heatH(heatReq('2a01:4f8:c0c:1234::' + d.slice(-1), d, 'c:SEC-303', { 'x-forwarded-for': '9.9.9.' + d.slice(-1) }), fres());
            const nV6 = adds.length - nNo - nX;
            ok(nNo === 1 && nX === 1 && nV6 === 1, '复核 SEC-3:公网直连、没配头:同一网络 3 个假设备号当天同一部片只计 1 份 —— 客户端加 X-Forwarded-For / 换 /64 里的地址也一样', [nNo, nX, nV6]);
            const call = (peer, hdrs, tok) => new Promise((resolve) => {
                const res = fres();
                res.json = (j) => { resolve(res.code + ' ' + (j && j.error)); return res; };
                auth({ headers: Object.assign({ 'x-admin-token': tok || 'wrong-guess-token' }, hdrs || {}), socket: { remoteAddress: peer } }, res, () => resolve('next'));
            });
            const pre = '2a01:4f8:c0c:5678::';
            const L = [];
            for (let i = 1; i <= 5; i++) L.push(await call(pre + i, i % 2 ? { 'x-forwarded-for': '1.2.3.' + i } : null));
            const more = [];
            for (let i = 100; i < 110; i++) more.push(await call(pre + i.toString(16), { 'x-forwarded-for': '5.6.7.8', 'x-real-ip': '5.6.7.9' }));
            const goodLocked = await call(pre + 'abc', null, 'sec3-admin-token-0123456789');
            const v4 = [];
            for (let i = 0; i < 6; i++) v4.push(await call('45.33.99.7', i % 2 ? { 'x-forwarded-for': '7.7.7.' + i } : null));
            const other = await call('2a01:4f8:c0c:9999::1', null, 'sec3-admin-token-0123456789');
            ok(L.slice(0, 4).every((x) => x === '401 BAD_TOKEN') && L[4] === '429 LOCKED' && more.every((x) => x === '429 LOCKED') && goodLocked === '429 LOCKED'
                && v4.slice(0, 4).every((x) => x === '401 BAD_TOKEN') && v4[4] === '429 LOCKED' && v4[5] === '429 LOCKED' && other === 'next',
            '复核 SEC-3:后台错令牌锁定按对端网络(IPv6 /64)—— 一半带转发头也是同一个键,锁住后同一 /64 换地址 + 加 XFF 照样 429;IPv4 加 XFF 也开不出第二份配额;别的网络照常',
            [L, [...new Set(more)], goodLocked, v4, other]);
        }
    }
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

// ---------------------------------------------------------------- ①b 复核 SEC-2:后台镜像页「回到主地址」按钮(public/adult/admin.js + 极简 DOM 替身)
console.log('①b 后台镜像页「回到主地址」');
{
    class El {
        constructor(tag, doc) { this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.children = []; this.attrs = new Map(); this.listeners = {}; this.parentNode = null; this._text = ''; this.className = ''; this.value = ''; this.disabled = false; }
        get firstChild() { return this.children[0] || null; }
        appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
        setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'class') this.className = String(v); }
        getAttribute(k) { return k === 'class' ? this.className : (this.attrs.has(k) ? this.attrs.get(k) : null); }
        removeAttribute(k) { this.attrs.delete(k); }
        addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
        click() { if (this.disabled) return; for (const fn of this.listeners.click || []) fn({ preventDefault() { }, target: this }); }
        focus() { }
        get textContent() { return this.tagName === '#TEXT' ? this._text : this.children.map((c) => c.textContent).join(''); }
        set textContent(v) { this.children = []; if (this.tagName === '#TEXT') this._text = String(v); else if (String(v) !== '') this.appendChild(this.ownerDocument.createTextNode(v)); }
        all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
        querySelector(sel) {
            const pred = sel[0] === '.' ? (c) => (' ' + c.className + ' ').indexOf(' ' + sel.slice(1) + ' ') >= 0 : sel[0] === '[' ? (c) => c.attrs.has(sel.slice(1, -1)) : (c) => c.tagName === sel.toUpperCase();
            return this.all(pred)[0] || null;
        }
    }
    const doc = { createElement: (t) => new El(t, doc), createTextNode: (t) => { const e = new El('#text', doc); e._text = String(t); return e; } };
    const mount = doc.createElement('main');
    const head = doc.createElement('header'); head.className = 'adm-head'; mount.appendChild(head);
    const MIR0 = [{ key: 'av_s01', primary: 'https://p1-zy.example/api.php/provide/vod', current: 'https://m1-zy.example/api.php/provide/vod', since: 1, fails: 0, candidates: 1, reason: 'failover' },
        { key: 'av_s02', primary: 'https://p2-zy.example/api.php/provide/vod', current: 'https://p2-zy.example/api.php/provide/vod', since: 0, fails: 0, candidates: 0, reason: '' }];
    let mirrors = MIR0.map((x) => Object.assign({}, x));
    const flog = [];
    let confirmAns = false;
    const win = { sessionStorage: { _m: new Map([['dgx_admin_token', 'ui-token-xyz']]), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } }, confirm: () => confirmAns };
    const fetchFn = async (u, o) => {
        const body = o.body ? JSON.parse(o.body) : undefined;
        flog.push({ u, m: o.method, body, tok: o.headers['X-Admin-Token'] });
        const p = u.replace('/api/adult/admin', '');
        let st = 200, j = {};
        if (o.method === 'GET' && p === '/stats') j = { works: 1, lines: 1, sites: [], rejected: {}, extraBlock: { n: 0, rev: '' }, catalog: true, mirrors: 1 };
        else if (o.method === 'GET' && p === '/mirrors') j = mirrors;
        else if (o.method === 'POST' && p === '/mirror/reset') { const x = mirrors.find((y) => y.key === body.key); const sw = x.current !== x.primary; x.current = x.primary; x.reason = 'admin-reset'; j = { key: body.key, ok: true, switched: sw, current: x.primary, reason: 'admin-reset' }; }
        else st = 404;
        return { ok: st < 300, status: st, text: async () => JSON.stringify(j) };
    };
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    const ADM = require(path.join(ROOT, 'public/adult/admin.js'));
    const ui = ADM.boot(doc, mount, { window: win, fetch: fetchFn });
    await flush();
    await ui.select('mirrors');
    await flush();
    const rbs = () => mount.all((c) => c.tagName === 'BUTTON' && c.textContent === '回到主地址');
    const b0 = rbs();
    ok(b0.length === 2 && b0[0].disabled === false && b0[1].disabled === true, '镜像页:每个站一个「回到主地址」;已经在主地址上的不可点', b0.map((b) => b.disabled));
    if (b0.length === 2) {
        confirmAns = false;
        b0[0].click(); await flush();
        const n0 = flog.filter((x) => x.m === 'POST' && /\/mirror\/reset$/.test(x.u)).length;
        confirmAns = true;
        b0[0].click(); await flush();
        const posts = flog.filter((x) => x.m === 'POST' && /\/mirror\/reset$/.test(x.u));
        const b1 = rbs();
        ok(n0 === 0 && posts.length === 1 && posts[0].body.key === 'av_s01' && posts[0].tok === 'ui-token-xyz' && posts[0].u === '/api/adult/admin/mirror/reset'
            && b1.length === 2 && b1.every((b) => b.disabled) && /av_s01 已回到主地址/.test(mount.textContent),
        '点「回到主地址」:先确认(取消 = 不发);确认后 POST /api/adult/admin/mirror/reset {key} 带 X-Admin-Token,刷新表格、提示已回到主地址',
            [n0, posts.map((x) => [x.u, x.body, x.tok]), b1.map((b) => b.disabled), mount.textContent.slice(0, 300)]);
    }
    const html = fs.readFileSync(path.join(ROOT, 'public/adult/admin.html'), 'utf8');
    ok(/<script src="\/adult\/admin\.js\?v=8" defer><\/script>/.test(html), 'admin.html 引用 admin.js?v=8(改了 admin.js 要换版本串)');
    ok(/硬过滤名单/.test(ADM.reasonNote('category')) && ADM.reasonNote('item:minor') && ADM.reasonNote('item:newthing') === '硬过滤' && ADM.reasonNote('zzz') === '' && ADM.reasonNote('constructor') === '',
        '后台概览:拦截原因带白话说明(未知的 item:* 写「硬过滤」,原型链上的名字不当说明)');
    const hv = ADM.historyView({ enabled: true, sites: 30, started: 30, done: 12, pages: 50000, pagesTotal: 100000, etaMs: 5 * 3600e3 });
    ok(hv && hv.pct === '50%' && hv.sites === '12 / 30' && hv.eta === '5 小时' && !hv.done && ADM.historyView({ enabled: true, sites: 2, started: 2, done: 2, pages: 9, pagesTotal: 9, finishedAt: 0 }).pct === '100%' && ADM.historyView(null) === null,
        '后台概览:历史回填进度(百分比 / 站数 / 预计时间)', hv);
}

// ---------------------------------------------------------------- 假 maccms 站
const stubLog = [];
const stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = /^\/(a2|[a-d])\/api\.php\/provide\/vod\/?$/.exec(u.pathname);   // a2:第四阶段"站 a 的镜像地址"(同一份片库)
    const q = Object.fromEntries(u.searchParams);
    stubLog.push({ path: u.pathname, site: m ? m[1] : (u.pathname.startsWith('/html/') ? 'html' : ''), q, url: req.url });
    if (u.pathname.startsWith('/html/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><body>This domain may be for sale</body></html>'); }   // 第四阶段:停放页
    if (!m) { res.writeHead(404); return res.end('no'); }
    const site = m[1] === 'a2' ? 'a' : m[1], base = `http://127.0.0.1:${stub.address().port}`;
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
        TMDB_API_KEY: '', TMDB_PROXY_URL: '', CORS_PROXY_URL: '', DANMU_API_URL: '', DANMU_API_TOKEN: '', ADMIN_TOKEN: '', ADULT_ADMIN_TOKEN: '', REMOTE_DB_URL: '',
        LIVE_M3U_ADULT: '', SITE_URL: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '', DB_FILE,
    }, extra || {});
}
let srv = null, port = 0, srvLog = '';
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function startServer(extra, args) {
    port = await freePort();   // 第四阶段:随机端口会撞上并行跑的别的服务(非 HTTP 回包让 fetch 直接抛),改成先向系统要一个空闲端口
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
    ok(create && !create.hasDb && create.adultOk && create.httpGet === 'function' && create.log === 'function' && create.env && create.avdbFactory === 'function' && create.tagsOk
        && create.dbPath === path.join(path.dirname(CACHE_DB), 'catalog.db')
        && JSON.stringify(create.keys) === JSON.stringify(['adult', 'avdbFactory', 'dbPath', 'env', 'getSites', 'httpGet', 'log', 'popularTitles', 'tags', 'tg']),
        'createCatalog 拿到约定的依赖(第三阶段:dbPath = cache.db 旁边的 catalog.db、avdbFactory、tags、tg(TG 频道);不再给 cache.db 连接)', create);
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
        ['GET', '/api/catalog/tag/wife'], ['GET', '/api/catalog/actress?q=x'], ['GET', '/api/catalog/actress/7'], ['GET', '/api/catalog/studios'],
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
    // —— 多个关键词(用户 2026-11-24「黑丝 女同」):资源站只认整串 → 只发最长的那个词,回来的按全部词过滤(分类名也算) ——
    for (const [q, want] of [['周末 自拍', ['a_102', 'b_204']], ['姐姐 周末', ['a_102', 'b_204']], ['周末 这个词谁都没有', []]]) {
        n0 = stubCount();
        const sm = await sse('/api/search?wd=' + encodeURIComponent(q) + '&stream=true', CK);
        const sent = [...new Set(stubLog.slice(n0).filter(x => x.q.wd != null).map(x => x.q.wd))];
        ok(sent.length === 1 && q.split(' ').includes(sent[0]) && !sent[0].includes(' '), `多词「${q}」:只发其中一个词给资源站`, sent);
        ok(JSON.stringify(sm.items.map(keyOf).sort()) === JSON.stringify(want), `多词「${q}」:每个词都要对上(片名 / 分类名)`, sm.items.map(it => [keyOf(it), it.vod_name, it.type_name]));
    }
    ok(!(await sse('/api/search?wd=' + encodeURIComponent('周末 偷拍') + '&stream=true', CK)).items.length, '多词里有被拦的词 → 整个查询照样被拦');
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
    // 第三阶段:AVDB 拦截的番号(替身 avdbPol('SSIS-002') = block)—— 搜索出口、单站搜索、详情都不出
    s = await sse('/api/search?wd=' + encodeURIComponent('SSIS-002') + '&stream=true', CK);
    ok(s.items.length === 0, 'AVDB pol=block 的番号:搜索不出(b 站 203 原本会出)', s.items.map(keyOf));
    r = await api('POST', '/api/search', { cookie: CK, json: { keyword: 'SSIS-002', siteKey: 'b' } });
    ok(r.j && r.j.list.length === 0, 'AVDB 拦截:POST 单站搜索也不出', r.j);
    r = await api('GET', '/api/detail?id=203&site_key=b', { cookie: CK });
    ok(r.status === 404, 'AVDB 拦截:详情 404', r.status);
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
    ok(bq && JSON.stringify(bq.q) === JSON.stringify({ b: 'jp_censored', tag: '!bad', sort: 'new', dur: '!bad', flag: 'unc', page: 1 }), '目录浏览:参数清洗(非法 sort 回默认,page≥1;给了但非法的 tag / dur 标成 !bad 交给目录回空页)', bq && bq.q);
    r = await api('GET', '/api/catalog/browse?b=' + encodeURIComponent('../../etc') + '&page=abc', { cookie: CK });
    const bq2 = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    ok(r.status === 200 && bq2 && bq2.q.b === '!bad' && bq2.q.tag === '' && bq2.q.page === 1, '目录浏览:非法分区不悄悄变成 ""(=全部分区),标成 !bad', bq2 && bq2.q);
    // 国产 / 日本 整类浏览:b 逗号分隔 ≤6 个分区原样交给目录;多于 6 个 / 有一段不合法 → !bad
    const bqOf = async (b) => { await api('GET', '/api/catalog/browse?b=' + b, { cookie: CK }); return (readLines(CAT_LOG).filter(x => x.ev === 'browse').pop() || {}).q || {}; };
    const bm1 = await bqOf('jp_censored,jp_uncensored,jp_subbed'), bm2 = await bqOf('a,b,c,d,e,f,g'), bm3 = await bqOf('jp_censored,' + encodeURIComponent('../x')), bm4 = await bqOf(',jp_censored');
    ok(bm1.b === 'jp_censored,jp_uncensored,jp_subbed' && bm2.b === '!bad' && bm3.b === '!bad' && bm4.b === '!bad', '目录浏览:b 可以是逗号分隔的几个分区(≤6,每段都合法)', [bm1.b, bm2.b, bm3.b, bm4.b]);
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
        ok(JSON.stringify(M.actress) === JSON.stringify([{ aid: 7, name: 'テスト花子' }, { aid: null, name: 'テスト二号' }]) && M.siblings.length === 1 && M.siblings[0].wk === 'c:SSIS-001#U' && M.label_prefix === 'SSIS' && M.bucket_label === '中文字幕',
            '作品 _meta:演员 {aid,name} 过一遍查询硬拦词(旧字符串形状也认)、兄弟作品按片名再过滤', M);
        ok(M.released === '2024-09-28' && M.maker === 'S1 NO.1 STYLE' && M.label === 'S1' && M.avdb === true, '作品 _meta:第三阶段 released / maker / label / avdb 透传', M);
    }
    n0 = stubCount();
    r = await api('GET', '/api/catalog/tags?b=jp_censored', { cookie: CK });
    let tl = readLines(CAT_LOG).filter(x => x.ev === 'tags').pop();
    ok(r.status === 200 && tl && tl.b === 'jp_censored' && JSON.stringify(r.j) === JSON.stringify({ groups: [{ id: 'persona', label: '身份·职业' }], tags: [
        { id: 'wife', label: '人妻', count: 9, featured: true, group: 'persona' }] })
        && /max-age=60/.test(r.h.get('cache-control') || ''), '/api/catalog/tags:{groups, tags:[{id,label,count,featured:true,group}]},只放 featured === true、坏条目丢掉', [r.status, r.j, tl]);
    // 第三阶段新路由:标签页 / 演员 / 片商
    r = await api('GET', '/api/catalog/tag/wife', { cookie: CK });
    ok(r.status === 200 && r.j.tag.id === 'wife' && JSON.stringify(r.j.items.map(c => c.name)) === JSON.stringify(['邻家姐姐的周末']) && r.j.related.length === 1 && /max-age=60/.test(r.h.get('cache-control') || ''),
        '/api/catalog/tag/:id:卡片按片名再过滤', r.j);
    const r404 = [await api('GET', '/api/catalog/tag/x_minor', { cookie: CK }), await api('GET', '/api/catalog/tag/' + encodeURIComponent('<x>'), { cookie: CK })];
    ok(r404.every(x => x.status === 404 && x.j && x.j.error === 'NOT_FOUND' && !/x_minor|<x>/.test(x.text)), '/api/catalog/tag/:id:blocked / 非法 → 404(不回显)', r404.map(x => [x.status, x.text]));
    r = await api('GET', '/api/catalog/actress?q=' + encodeURIComponent('テスト'), { cookie: CK });
    ok(r.status === 200 && JSON.stringify(r.j) === JSON.stringify([{ aid: 7, name: 'テスト花子', n: 3 }]) && /no-store/.test(r.h.get('cache-control') || ''), '/api/catalog/actress?q=:名字被拦的不出', r.j);
    const nAs = readLines(CAT_LOG).filter(x => x.ev === 'actressSearch').length;
    r = await api('GET', '/api/catalog/actress?q=' + encodeURIComponent('迷奸'), { cookie: CK });
    ok(r.status === 200 && r.j.length === 0 && readLines(CAT_LOG).filter(x => x.ev === 'actressSearch').length === nAs, '/api/catalog/actress?q=:被拦的查询不进目录', r.j);
    r = await api('GET', '/api/catalog/actress/7?page=2', { cookie: CK });
    ok(r.status === 200 && r.j.actress.name === 'テスト花子' && JSON.stringify(r.j.actress.aliases) === JSON.stringify(['Test Hanako']) && r.j.results.length === 1 && r.j.page === 2,
        '/api/catalog/actress/:aid:别名 / 卡片过滤、page 透传', r.j);
    ok((await api('GET', '/api/catalog/actress/8', { cookie: CK })).status === 404 && (await api('GET', '/api/catalog/actress/999', { cookie: CK })).status === 404
        && (await api('GET', '/api/catalog/actress/' + encodeURIComponent('a b'), { cookie: CK })).status === 404, '/api/catalog/actress/:aid:名字被拦 / 没有 / 非法 → 404');
    r = await api('GET', '/api/catalog/studios?b=jp_censored', { cookie: CK });
    const stq = readLines(CAT_LOG).filter(x => x.ev === 'studios').pop();
    ok(r.status === 200 && JSON.stringify(r.j) === JSON.stringify([{ id: 'S1', label: 'S1', count: 4 }]) && stq && stq.b === 'jp_censored', '/api/catalog/studios:被拦 / 坏条目丢掉', [r.j, stq]);
    await api('GET', '/api/catalog/browse?b=jp_censored&t=wife,busty&x=subbed&v=zh&dur=xxl&sort=released&studio=S1&actress=7&cursor=abc_-1&facets=1', { cookie: CK });
    const bq5 = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    ok(bq5 && JSON.stringify(bq5.q) === JSON.stringify({ b: 'jp_censored', tag: '', sort: 'released', dur: 'xxl', flag: '', page: 1, t: 'wife,busty', x: 'subbed', v: 'zh', studio: 'S1', actress: '7', cursor: 'abc_-1', facets: true }),
        '目录浏览:第三阶段参数 t/x/v/dur/sort/studio/actress/cursor/facets 透传', bq5 && bq5.q);
    await api('GET', '/api/catalog/browse?t=a,b,c,d&x=' + encodeURIComponent('<x>') + '&v=bogus&studio=' + encodeURIComponent('a<b') + '&actress=' + encodeURIComponent('a b') + '&cursor=' + encodeURIComponent('!!'), { cookie: CK });
    const bq6 = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    ok(bq6 && bq6.q.t === '!bad' && bq6.q.x === '!bad' && bq6.q.v === '!bad' && bq6.q.studio === '!bad' && bq6.q.actress === '!bad' && bq6.q.cursor === '' && !('facets' in bq6.q), '目录浏览:非法的第三阶段参数 → !bad(目录回空页)', bq6 && bq6.q);
    await api('GET', '/api/catalog/browse?studio=' + encodeURIComponent("M's video"), { cookie: CK });
    const bq7 = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    ok(bq7 && bq7.q.studio === "M's video", "目录浏览:片商名带单引号(M's video)照常透传", bq7 && bq7.q);
    // 复核 r3:nr=1(推荐位不要审查级作品)透传成 nr:true;别的值 / 没给 → 不带这个键
    await api('GET', '/api/catalog/browse?t=wife&sort=hot&page=1&nr=1', { cookie: CK });
    const bq8 = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    await api('GET', '/api/catalog/browse?t=wife&sort=hot&page=1&nr=yes', { cookie: CK });
    const bq9 = readLines(CAT_LOG).filter(x => x.ev === 'browse').pop();
    ok(bq8 && bq8.q.nr === true && bq9 && !('nr' in bq9.q) && !('nr' in bq7.q), '目录浏览:nr=1 → nr:true(去掉审查级);其它值 / 没给不带', [bq8 && bq8.q, bq9 && bq9.q]);
    r = await api('GET', '/api/catalog/tags?b=' + encodeURIComponent('../x'), { cookie: CK });
    tl = readLines(CAT_LOG).filter(x => x.ev === 'tags').pop();
    ok(r.status === 200 && tl && tl.b === '!bad', '/api/catalog/tags:非法分区标成 !bad 交给目录', tl);
    r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('ssis-001'), { cookie: CK });
    ok(r.status === 200 && r.j.kind === 'code' && r.j.exact === 'c:SSIS-001' && r.j.items.length === 2 && /no-store/.test(r.h.get('cache-control') || ''), '/api/catalog/suggest:番号 → kind code + exact', r.j);
    r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('ssis-002'), { cookie: CK });
    ok(r.status === 200 && r.j.exact === null && JSON.stringify(r.j.items.map(c => c.wk)) === JSON.stringify(['c:SSIS-002']), '/api/catalog/suggest:片名被拦的卡片滤掉,exact 指向它 → null', r.j);
    r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('无码'), { cookie: CK });
    ok(r.j && r.j.kind === 'alias' && JSON.stringify(r.j.alias) === JSON.stringify({ label: '日本无码', b: 'jp_uncensored' }), '/api/catalog/suggest:别名 {b|tag,label}(多余字段不透传)', r.j);
    // 多词全是标签词:合成别名的 tags 要透传(之前被字段白名单吃掉,回车只按第一个标签开)
    r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('人妻 巨乳'), { cookie: CK });
    ok(r.j && r.j.kind === 'alias' && r.j.alias.tag === 'wife' && Array.isArray(r.j.alias.tags) && r.j.alias.tags.map(x => x.tag).join() === 'wife,busty' && r.j.alias.tags.every(x => Object.keys(x).join() === 'tag,label'), '/api/catalog/suggest:多词合成别名带 tags(只留 tag / label)', r.j);
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
    ok(cfg.adult === true && cfg.catalog === true && cfg.age_gate === true && cfg.site_name === 'MEI.NU' && cfg.auth_required === true && cfg.rules_version === RV, '/api/config 成人站字段', cfg);
    ok(cfg.tmdb_api_key === null && cfg.tmdb_proxy_url === null && cfg.danmaku_enabled === false && cfg.requests_enabled === false && cfg.push_enabled === false
        && cfg.intro_enabled === false && cfg.live_enabled === false && cfg.img_proxy === false, '/api/config:TMDB/弹幕/求片/推送/片头/直播 都报关,img_proxy:false', cfg);
    ok(JSON.stringify(cfg.cover_dead_hosts) === JSON.stringify(['img-gone.example', 'pic.gone2.example']), '/api/config cover_dead_hosts:目录的死封面域名(只放像域名的、去重)', cfg.cover_dead_hosts);
    {
        // 未登录(登录框之前也要拿站名的那次)/ 令牌不对:不给上游图床名单;带 dg_t Cookie(登录后应用启动那次)照常给
        const anon = (await api('GET', '/api/config')).j || {};
        const bad = (await api('GET', '/api/config?token=not-a-token')).j || {};
        const ck = (await api('GET', '/api/config', { cookie: CK })).j || {};
        ok(anon.site_name === 'MEI.NU' && JSON.stringify(anon.cover_dead_hosts) === '[]' && JSON.stringify(bad.cover_dead_hosts) === '[]' && ck.cover_dead_hosts && ck.cover_dead_hosts.length === 2,
            '/api/config cover_dead_hosts:未登录 / 令牌不对 → [];带登录 Cookie → 给', [anon.cover_dead_hosts, bad.cover_dead_hosts, ck.cover_dead_hosts]);
    }
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
    // 存下之后 AVDB 才拦掉的番号(替身 SSIS-002 = block):作品名 / 线路片名里有它的,历史下发也不出
    db.prepare('INSERT OR REPLACE INTO user_history (user_token, item_id, item_data, updated_at) VALUES (?, ?, ?, ?)').run(ALICE, 'h7', JSON.stringify({ name: 'SSIS-002 温泉旅馆的邂逅' }), Date.now());
    db.prepare('INSERT OR REPLACE INTO user_history (user_token, item_id, item_data, updated_at) VALUES (?, ?, ?, ?)').run(ALICE, 'h8', JSON.stringify({ name: '某作品', groupData: { name: '某作品', sources: [{ site_key: 'a', vod_id: '9', vod_name: '[SSIS-002] 温泉' }] } }), Date.now());
    r = await api('GET', '/api/history/pull?token=' + ALICE);
    ok(r.j && r.j.sync_enabled && JSON.stringify(r.j.history.map(h => h.id)) === JSON.stringify(['h1']), '历史下发:库里被拦的条目(含 AVDB 后来拦掉的番号)不下发', r.j && r.j.history.map(h => h.id));
    db.exec(`CREATE TABLE IF NOT EXISTS watch_stats (
        user_token TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, episode TEXT NOT NULL DEFAULT '',
        seconds INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, first_at INTEGER, last_at INTEGER,
        PRIMARY KEY (user_token, kind, title, episode)) WITHOUT ROWID`);
    const ins = db.prepare("INSERT OR REPLACE INTO watch_stats (user_token, kind, title, episode, seconds, completed, first_at, last_at) VALUES (?, 'vod', ?, '1', 600, 0, ?, ?)");
    for (const u of ['u1', 'u2', 'u3']) for (const t of ['邻家姐姐的周末', '准高一少女 初恋', 'SSIS-002 温泉旅馆的邂逅']) ins.run(u, t, Date.now(), Date.now());
    r = await api('GET', '/api/popular?token=' + TOK, { cookie: CK });
    const titles = (r.j && r.j.items || []).map(x => x.title);
    ok(r.status === 200 && titles.includes('邻家姐姐的周末') && !titles.includes('准高一少女 初恋'), '热门:被拦片名不上榜', r.j);
    ok(!titles.includes('SSIS-002 温泉旅馆的邂逅'), '热门:片名里的番号被 AVDB 拦了(替身 SSIS-002 = block)也不上榜', titles);
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
    db.prepare('INSERT OR REPLACE INTO user_favorites (user_token, fav_id, data, added_at, updated_at, seen_count) VALUES (?, ?, ?, ?, ?, 0)').run(ALICE, 'fy', JSON.stringify({ name: 'SSIS-002 温泉旅馆的邂逅', sources: [] }), Date.now(), Date.now());
    r = await api('GET', '/api/favorites?token=' + ALICE);
    ok(r.j && JSON.stringify(r.j.items.map(x => x.data.name)) === JSON.stringify(['邻家姐姐的周末']), '收藏列表:库里被拦的(含 AVDB 后来拦掉的番号)不下发', r.j && r.j.items.map(x => x.data.name));
    r = await api('POST', '/api/favorites/add', { json: { token: ALICE, item: { name: 'SSIS-002 温泉旅馆的邂逅' } } });
    ok(r.status === 400, '收藏:AVDB 拦掉的番号加不进去', [r.status, r.j]);
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
    ok(r.status === 404 && r.j && r.j.error === 'REFUSED' && pq.length === nPic + 1 && pq[pq.length - 1].k === 'c:SSIS-001' && pq[pq.length - 1].s === 'a' && pq[pq.length - 1].meta === true,
        '/api/img:地址从目录索引查(按 k/s),请求里的 url= 不看;索引里的地址被拒 = 确定取不到 → 404(前端藏卡)', [r.status, r.j, pq.slice(-1)]);
    ok(stubCount() === n0, '/api/img:索引里的地址是回环地址 → 拒,一次都不连(SSRF)', stubLog.slice(n0).map(x => x.url));
    r = await api('GET', '/api/img?k=' + encodeURIComponent('t:blocked1'), { cookie: CK });
    ok(r.status === 404, '/api/img:片名被拦的作品 → 404(不取)', r.status);
    r = await api('GET', '/api/img?k=' + encodeURIComponent('c:NOPE-001') + '&s=a', { cookie: CK });
    ok(r.status === 404, '/api/img:索引里没有 → 404', r.status);
    r = await api('GET', '/api/img?url=' + encodeURIComponent('https://img.example/a.jpg'), { cookie: CK });
    ok(r.status === 400, '/api/img:只给 url= → 400', r.status);
    // 第三阶段:搜索结果里已经在目录索引的条目,封面也改写成 /api/img(没入索引的照旧直链)
    {
        const sj = await api('GET', '/api/search?wd=' + encodeURIComponent('ssis 001'), { cookie: CK });
        const L = (sj.j && sj.j.list) || [];
        const a101 = L.find(x => x.site_key === 'a' && String(x.vod_id) === '101'), b201 = L.find(x => x.site_key === 'b' && String(x.vod_id) === '201');
        ok(a101 && a101.vod_pic === '/api/img?k=' + encodeURIComponent('c:SSIS-001') + '&s=a' && b201 && !/^\/api\/img/.test(String(b201.vod_pic || '')),
            '封面代理开着:搜索结果里已入索引的条目封面也走 /api/img(没入索引的照旧)', [a101 && a101.vod_pic, b201 && b201.vod_pic]);
    }
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
        ok(r.status === 200 && r.j && Array.isArray(r.j.tags) && Array.isArray(r.j.groups) && r.j.tags.every(t => typeof t.id === 'string' && t.featured === true && t.count > 0 && typeof t.group === 'string'), '真目录:/api/catalog/tags 形状', r.j);
        r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('ssis001'), { cookie: CK });
        ok(r.status === 200 && r.j && r.j.kind === 'code' && Array.isArray(r.j.items) && ('exact' in r.j) && ('alias' in r.j), '真目录:/api/catalog/suggest 形状', r.j);
        r = await api('GET', '/api/catalog/suggest?q=' + encodeURIComponent('人妻'), { cookie: CK });
        ok(r.status === 200 && r.j && r.j.kind === 'alias' && r.j.alias && r.j.alias.tag === 'wife', '真目录:联想别名(第三阶段词表:人妻 → wife)', r.j);
        r = await api('GET', '/api/catalog/browse?b=cn_amateur&facets=1', { cookie: CK });
        ok(r.status === 200 && r.j && r.j.facets && Array.isArray(r.j.facets.groups) && Array.isArray(r.j.facets.sorts) && r.j.facets.sorts.some(x => x.id === 'released') && 'cursor_next' in r.j, '真目录:browse facets=1 形状', r.j && r.j.facets);
        r = await api('GET', '/api/catalog/tag/x_minor', { cookie: CK });
        ok(r.status === 404, '真目录:blocked 标签页 404', r.status);
        ok(fs.existsSync(path.join(tmp, 'catalog.db')), '真目录:catalog.db 建在 cache.db 旁边');
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
    const vport = await freePort();
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

// ---------------------------------------------------------------- ⑥ 第四阶段(目录 / 镜像 = 替身)
//   相关推荐 / 竖屏短片流 / 热度条 的出口过滤、热度上报校验与限流、上报者哈希;换域名跟随接线(搜索 / 爬虫走 apiFor、结果报给 report);
//   后台:没配 ADMIN_TOKEN 全 404、错令牌 401 + 锁定、各接口校验、追加屏蔽词只会更严且持久化、站点停用持久化、隐藏作品处处不出
console.log('⑥ 第四阶段:相关 / 短片流 / 热度 / 换域名接线 / 后台');
{
    // 修订:adult-admin.json 里不合口径的词(手改 / 损坏 / 旧版的 1 字、>40 字、控制字符、非字符串)单独丢掉,其余照样恢复
    const AS = require(path.join(ROOT, 'lib/adult-gate/admin-state.js'));
    const f = path.join(tmp, 'admin-state-bad.json');
    fs.writeFileSync(f, JSON.stringify({ v: 1, blockWords: ['x', '合成好词甲', '  合成好词乙  ', 'y'.repeat(41), 'bad' + String.fromCharCode(1) + 'word', 42, null] }));
    const ast = AS.createAdminState({ file: f, log: () => { } });
    ok(JSON.stringify(ast.blockWords()) === JSON.stringify(['合成好词甲', '合成好词乙']), 'admin-state:坏词单独丢掉(和 PUT / policy 同口径 2..40 字),好词照样恢复', ast.blockWords());
    const P0 = require(path.join(ROOT, 'lib/adult/policy.js'));
    ok(P0.extraWordOk('合成好词甲') && !P0.extraWordOk('x') && !P0.extraWordOk('y'.repeat(41)) && !P0.extraWordOk(42), 'policy.extraWordOk:单个词的合法性');
}
{
    const DB4 = path.join(tmp, 'db4.json');
    const A2 = `${STUB}/a2/api.php/provide/vod/`;
    const SITES4 = SITES.concat([{ key: 'e', name: '站E', api: `${STUB}/html/api.php/provide/vod/`, active: true, mirrors: ['https://e-mirror-zy.com/api.php/provide/vod'] }]);
    fs.writeFileSync(DB4, JSON.stringify({ sites: SITES4 }, null, 2));
    const MLOG = path.join(tmp, 'mirror.log');
    const P4DIR = path.join(tmp, 'p4');
    fs.mkdirSync(P4DIR, { recursive: true });
    const C4 = path.join(P4DIR, 'cache-p4.db');
    const ADMIN = 'p4-admin-token-0123456789abcdef';
    const base = {
        ACCESS_PASSWORD: 'test', CACHE_TYPE: 'sqlite', CACHE_DB_PATH: C4, DB_FILE: DB4,
        ADULT_TEST_CATALOG_STUB: path.join(FIX, 'catalog-stub.cjs'), ADULT_TEST_CATALOG_LOG: CAT_LOG,
        ADULT_TEST_MIRROR_STUB: path.join(FIX, 'mirror-stub.cjs'), ADULT_TEST_MIRROR_LOG: MLOG, ADULT_TEST_MIRROR_MAP: JSON.stringify({ a: A2 }),
        ADULT_CLIENT_IP_HEADER: 'x-real-ip', ADULT_TEST_PROBE_URLS: `${A2}?ac=list ${STUB}/html/api.php/provide/vod/?ac=list ${SITES[0].api}?ac=list&pg=1`, ADULT_TEST_PROBE_SITE: 'a',
    };
    const hooks = ['-r', path.join(FIX, 'catalog-hook.cjs'), '-r', path.join(FIX, 'v2b-stub.cjs')];   // v2b-stub:复核 r3 测机场个人令牌的热度扇出上限
    const CK = 'dg_t=' + sha('test');
    const AH = (ip, tok) => ({ 'X-Admin-Token': tok === undefined ? ADMIN : tok, 'X-Real-IP': ip || '198.51.100.20' });
    const last = (ev) => readLines(CAT_LOG).filter((x) => x.ev === ev).pop();
    const mlog = () => readLines(MLOG);
    const b64 = (arr) => Buffer.from(arr).toString('base64');
    const BINS = b64(Array.from({ length: 100 }, (_, i) => i * 2));
    const heat = (json, ip, extra) => api('POST', '/api/catalog/heat', Object.assign({ cookie: CK, json, headers: { 'X-Real-IP': ip || '198.51.100.31' } }, extra || {}));
    const devs = [];
    // —— 服务器 1:成人后台关着(复核修订:契约是 ADMIN_TOKEN 开后台;只想要主站求片后台 → ADULT_ADMIN_TOKEN=off)——
    try {
        await startServer(Object.assign({}, base, { ADMIN_TOKEN: 'main-site-qiupian-admin-token-0123', ADULT_ADMIN_TOKEN: 'off' }), hooks);
        // 后台整体关
        for (const [m, p] of [['GET', '/api/adult/admin/stats'], ['POST', '/api/adult/admin/hide'], ['GET', '/api/adult/admin/mirrors'], ['PUT', '/api/adult/admin/block-words']]) {
            const r = await api(m, p, { headers: AH(), json: m === 'GET' ? undefined : {} });
            ok(r.status === 404 && r.j && r.j.error === 'NOT_AVAILABLE', `ADULT_ADMIN_TOKEN=off(配了 ADMIN_TOKEN 也不开):${m} ${p} → 404`, [r.status, r.text.slice(0, 100)]);
        }
        let r = await api('GET', '/admin/adult');
        ok(r.status === 404, 'ADULT_ADMIN_TOKEN=off:/admin/adult 页面也 404', r.status);
        ok((await api('GET', '/api/adult/admin/stats', { headers: AH('198.51.100.52', 'main-site-qiupian-admin-token-0123') })).status === 404, 'ADULT_ADMIN_TOKEN=off:ADMIN_TOKEN 也开不了成人后台');
        r = await api('GET', '/adult/admin.html');
        ok(r.status === 404, '后台关着:静态目录里的 /adult/admin.html 也 404(不由 express.static 直接给)', r.status);
        // 换域名跟随接线
        const mc = mlog().find((x) => x.ev === 'create');
        ok(mc && JSON.stringify(mc.keys) === JSON.stringify(['log', 'sites', 'store']) && mc.storeFile === 'adult-mirror.json' && mc.storeDir === P4DIR
            && JSON.stringify(mc.sites) === JSON.stringify(['a', 'b', 'c', 'e']) && mc.mirrorsOf.e === 1 && mlog().some((x) => x.ev === 'start'),
        'server.js 建镜像模块:站点表(不含 active:false)+ mirrors、状态文件 = cache.db 旁边的 adult-mirror.json、start()', mc);
        const cc = readLines(CAT_LOG).filter((x) => x.ev === 'create').pop();
        ok(cc && cc.apis && cc.apis.a === SITES[0].api && cc.apis.b === SITES[1].api,
            '目录爬虫拿到的站点表:一直是主地址(回填进度 / 分类图按 api 记,换镜像不能让它们从头来);打出去时才换(见下面 probe_http)', cc && cc.apis);
        r = await api('GET', '/api/sites', { cookie: CK });
        const sa = (r.j && r.j.sites || []).find((s) => s.key === 'a'), se = (r.j && r.j.sites || []).find((s) => s.key === 'e');
        ok(sa && sa.api === A2 && se && !('mirrors' in se), '/api/sites:镜像在用的站报当前地址;备用域名表不下发', [sa, se]);
        let n0 = stubCount();
        const s4 = await sse('/api/search?wd=' + encodeURIComponent('周末') + '&stream=true', CK);
        const hit = stubLog.slice(n0);
        ok(s4.items.some((it) => keyOf(it) === 'a_102') && hit.some((x) => x.site === 'a2') && !hit.some((x) => x.site === 'a'), '闸门搜索:站 a 打的是镜像地址(a2),不再打主地址', hit.map((x) => x.site + ':' + x.q.ac));
        await sleep(50);
        ok(mlog().some((x) => x.ev === 'report' && x.k === 'a' && x.ok === true && x.kind === 'ok' && String(x.url).startsWith(A2) && x.hasData), '闸门搜索结果报给镜像模块:成功 + 样本数据', mlog().filter((x) => x.ev === 'report').slice(-6));
        ok(mlog().some((x) => x.ev === 'report' && x.k === 'e' && x.ok === false && x.kind === 'body' && !x.hasData), '闸门:停放页(HTML)→ report(e, false, body)', mlog().filter((x) => x.ev === 'report' && x.k === 'e'));
        n0 = stubCount();
        await api('GET', '/api/catalog/tags?b=probe_http', { cookie: CK });
        const ph = last('probe_http');
        const hitP = stubLog.slice(n0);
        const reps = mlog().filter((x) => x.ev === 'report' && x.k === 'a');
        ok(ph && ph.out[0].ok && !ph.out[1].ok && reps.some((x) => x.ok && x.url === `${A2}?ac=list` && x.hasData) && reps.some((x) => !x.ok && x.kind === 'body' && /\/html\//.test(x.url)),
            '目录 httpGet(catalogHttpGet):成功 / 非 JSON 都报给镜像模块(带 url,成功带样本)', [ph, reps.slice(-3)]);
        ok(ph && ph.out[2] && ph.out[2].ok && !hitP.some((x) => x.site === 'a') && hitP.filter((x) => x.site === 'a2').length >= 2 && reps.some((x) => x.ok && x.url === `${A2}?ac=list&pg=1`),
            '目录按主地址拼的 URL:镜像在用时换成当前地址再打(查询串原样),主地址一个请求都不打', [ph && ph.out[2], hitP.map((x) => x.site), reps.slice(-2)]);
        // —— 相关推荐 ——
        n0 = stubCount();
        ok((await api('GET', '/api/catalog/related/' + encodeURIComponent('c:SSIS-001'))).status === 401 && (await api('GET', '/api/catalog/feed')).status === 401
            && (await api('GET', '/api/catalog/heat/' + encodeURIComponent('c:SSIS-001'))).status === 401 && (await api('POST', '/api/catalog/heat', { json: {} })).status === 401, '相关 / 短片流 / 热度 没令牌 → 401');
        // —— 分享短码(2026-11-23:每部作品自己的链接 #/v/<码>)——
        {
            ok((await api('POST', '/api/catalog/share', { json: { wk: 'c:SSIS-001' } })).status === 401 && (await api('GET', '/api/catalog/share/AbCdEfGh12')).status === 401, '分享短码:没令牌 → 401(要登录)');
            let s = await api('POST', '/api/catalog/share', { cookie: CK, json: { wk: 'c:SSIS-001' } });
            ok(s.status === 200 && s.j.code === 'AbCdEfGh12' && /no-store/.test(s.h.get('cache-control') || ''), 'POST /api/catalog/share → {code}', s.j);
            ok((await api('POST', '/api/catalog/share', { cookie: CK, json: { wk: 'c:NOPE-001' } })).status === 404 && (await api('POST', '/api/catalog/share', { cookie: CK, json: { wk: 'xyz' } })).status === 400
                && (await api('POST', '/api/catalog/share', { cookie: CK, json: {} })).status === 400, '分享短码:作品没有 → 404;键不合法 / 没给 → 400');
            s = await api('GET', '/api/catalog/share/AbCdEfGh12', { cookie: CK });
            ok(s.status === 200 && s.j.wk === 'c:SSIS-001', 'GET /api/catalog/share/:code → {wk}', s.j);
            ok((await api('GET', '/api/catalog/share/ZZZZZZZZZZ', { cookie: CK })).status === 404 && (await api('GET', '/api/catalog/share/' + encodeURIComponent('bad code'), { cookie: CK })).status === 404
                && (await api('GET', '/api/catalog/share/abc', { cookie: CK })).status === 404, '分享短码:认不出 / 不合法 → 404');
        }
        r = await api('GET', '/api/catalog/related/' + encodeURIComponent('c:SSIS-001'), { cookie: CK });
        ok(r.status === 200 && JSON.stringify(r.j.items.map((c) => c.wk)) === JSON.stringify(['t:ok1', 't:hid1', 'c:REL-001']) && /max-age=60/.test(r.h.get('cache-control') || ''),
            '/api/catalog/related/:wk:自己 / 被拦片名 / AVDB 拦的番号 都滤掉', r.j && r.j.items.map((c) => c.wk));
        ok(r.j.actress && r.j.actress.aid === 7 && r.j.actress.name === 'テスト花子' && JSON.stringify(r.j.actress.items.map((c) => c.wk)) === JSON.stringify(['c:REL-002']) && r.j.studio === null,
            'related:演员行卡片再过滤;片商名被拦 → studio:null', [r.j.actress, r.j.studio]);
        ok(last('related').limit === 24, 'related:limit 默认 24', last('related'));
        r = await api('GET', '/api/catalog/related?k=' + encodeURIComponent('c:REL-001') + '&limit=999', { cookie: CK });
        ok(r.status === 200 && r.j.actress === null && r.j.studio && r.j.studio.label === 'S1' && r.j.studio.items.length === 1 && last('related').limit === 48, 'related ?k=:演员名被拦 → actress:null;limit 上限 48', [r.j, last('related')]);
        ok((await api('GET', '/api/catalog/related/' + encodeURIComponent('c:NOPE-001'), { cookie: CK })).status === 404 && (await api('GET', '/api/catalog/related/xyz', { cookie: CK })).status === 400, 'related:没有 → 404;非法键 → 400');
        // —— 短片流 ——
        r = await api('GET', '/api/catalog/feed?vert=1&cursor=abc_1', { cookie: CK });
        const fq = last('feed');
        ok(fq && JSON.stringify(fq.o) === JSON.stringify({ cursor: 'abc_1', vert: true, limit: 10, rand: false }) && /no-store/.test(r.h.get('cache-control') || ''), 'feed:cursor / vert / limit 透传(有游标时不随机起点)', fq);
        const fi = (r.j && r.j.items) || [];
        ok(r.status === 200 && JSON.stringify(fi.map((x) => x.wk)) === JSON.stringify(['t:feed1', 't:hid1']) && r.j.cursor_next === 'nx_1',
            'feed vert=1:被拦片名 / AVDB 拦的番号 / 横屏 / 一条线路都不剩的 都不出', fi.map((x) => x.wk));
        const f1 = fi[0] || {};
        ok(f1.orient === 'v' && f1.dur === 45 && JSON.stringify((f1.lines || []).map((l) => l.site + ':' + l.url.split('/').pop())) === JSON.stringify(['a:f1.m3u8', 'b:f1b2.m3u8'])
            && f1.lines[0].site_name === '站A' && f1.lines[0]._native === 'ok' && f1.lines[1]._native === 'risky' && f1.lines[1]._family === 'famB',
        'feed 线路:停用站 / 未知站 / 非 http(s) / 片名被拦的线路丢掉;站名、_family、_native 按站点表', f1.lines);
        ok(f1.lines && f1.lines[0].vod_id === '101' && f1.lines[1].vod_id === '', 'feed 线路带 vod_id(刷短片报画面方向用;目录没给 → 空串)', f1.lines);
        r = await api('GET', '/api/catalog/feed?cursor=' + encodeURIComponent('!!') + '&limit=99', { cookie: CK });
        ok(last('feed').o.cursor === '' && last('feed').o.vert === false && last('feed').o.limit === 20 && (r.j.items || []).some((x) => x.wk === 't:feed4'), 'feed:非法 cursor → 空;limit 上限 20;不要竖屏时横屏照出', [last('feed').o, (r.j.items || []).map((x) => x.wk)]);
        // —— 热度 ——
        r = await api('GET', '/api/catalog/heat/' + encodeURIComponent('c:SSIS-001'), { cookie: CK });
        ok(r.status === 200 && r.j.bins.length === 100 && r.j.bins[0] === 100 && r.j.bins[1] === 0 && r.j.bins[50] === 50 && r.j.users === 5 && /max-age=300/.test(r.h.get('cache-control') || ''), 'GET heat:bins 夹到 0..100', r.j);
        const hf = await api('GET', '/api/catalog/heat/' + encodeURIComponent('c:FEW-001'), { cookie: CK });
        const hn = await api('GET', '/api/catalog/heat?k=' + encodeURIComponent('c:NOPE-001'), { cookie: CK });
        const hb = await api('GET', '/api/catalog/heat/x', { cookie: CK });
        ok(hf.status === 204 && hn.status === 204 && hb.status === 400, 'GET heat:不到 3 人 / 没有 → 204;非法键 → 400', [hf.status, hn.status, hb.status]);
        const DEV1 = 'devAAAA1111bbbbZZ', DEV2 = 'devCCCC2222ddddYY';
        devs.push(DEV1, DEV2);
        r = await heat({ wk: 'c:SSIS-001', dur: 7210.4, bins: BINS, dev: DEV1 });
        const h1 = last('heatAdd');
        ok(r.status === 204 && h1 && h1.wk === 'c:SSIS-001' && h1.n === 100 && h1.b0 === 0 && h1.b99 === 198 && h1.dur === 7210 && /^[0-9a-f]{32}$/.test(h1.who) && !h1.who.includes(DEV1),
            'POST heat → 204;目录收到 bins[100] / dur / who(哈希,不是 dev 原文)', [r.status, h1]);
        await heat({ wk: 'c:SSIS-001', dur: 100, bins: BINS, dev: DEV1 });
        const h1b = last('heatAdd');
        // 复核修订(回到契约):who = sha256(dev + 当天的盐);认得出网络(这里 X-Real-IP 是声明过的可信头)时同一网络同一部片当天只收第一台设备
        const nHeat = () => readLines(CAT_LOG).filter((x) => x.ev === 'heatAdd').length;
        const nA0 = nHeat();
        const r2s = (await heat({ wk: 'c:SSIS-001', dur: 100, bins: BINS, dev: DEV2 })).status;
        const nA = nHeat();
        await heat({ wk: 'c:SSIS-001', dur: 100, bins: BINS, dev: DEV2 }, '198.51.100.35');
        const h3 = last('heatAdd');
        const nB = nHeat();
        ok(h1b.who === h1.who && r2s === 204 && nA === nA0 && nB === nA0 + 1 && h3.who !== h1.who && /^[0-9a-f]{32}$/.test(h3.who),
            'who:同一设备当天不变;同一可信网络同一部片的第二台设备照回 204 但不计(假设备号凑不出人数);它从别的网络来就算一份(按设备)', [h1.who, h1b.who, h3.who, r2s, nA0, nA, nB]);
        // 认不出网络(反代后面没配头:请求不带声明的 X-Real-IP → 对端是本机)→ 按设备算,不设网络上限(否则全站每部片每天只 1 份,热度条永远出不来)
        const whoP = [];
        for (const d of ['devPROXY0001aa', 'devPROXY0002bb', 'devPROXY0003cc']) {
            devs.push(d);
            const n1 = readLines(CAT_LOG).filter((x) => x.ev === 'heatAdd').length;
            const rp = await api('POST', '/api/catalog/heat', { cookie: CK, json: { wk: 'c:FEW-001', dur: 300, bins: BINS, dev: d } });
            const evs = readLines(CAT_LOG).filter((x) => x.ev === 'heatAdd');
            whoP.push(rp.status === 204 && evs.length === n1 + 1 ? evs[evs.length - 1].who : null);
        }
        ok(whoP.every((w) => /^[0-9a-f]{32}$/.test(w || '')) && new Set(whoP).size === 3, '认不出客户端网络(同一个本机对端):3 台设备 = 3 份(热度条凑得到 3 人)', whoP);
        // 复核 r3:一人一个的令牌(机场用户)认不出网络时也按人算 —— 同一个人造 3 个设备号只计第一份(照回 204)
        const lv = await api('POST', '/api/auth/v2board', { json: { email: 'viewer@example.test', password: 'pw' } });
        const CKV = 'dg_t=' + (lv.j && lv.j.userToken);
        const v2c = [];
        for (const d of ['devV2BU0001aa', 'devV2BU0002bb', 'devV2BU0003cc']) {
            devs.push(d);
            const n1 = nHeat();
            const rp = await api('POST', '/api/catalog/heat', { cookie: CKV, json: { wk: 'c:FEW-002', dur: 300, bins: BINS, dev: d } });
            v2c.push(rp.status + ':' + (nHeat() - n1));
        }
        const rpw = await api('POST', '/api/catalog/heat', { cookie: CK, json: { wk: 'c:FEW-002', dur: 300, bins: BINS, dev: 'devPROXY0004dd' } });
        devs.push('devPROXY0004dd');
        const v2o = readLines(CAT_LOG).filter((x) => x.ev === 'heatAdd' && x.wk === 'c:FEW-002').length;
        ok(lv.j && lv.j.success === true && /^v2board_/.test(lv.j.userToken) && v2c.join() === '204:1,204:0,204:0' && rpw.status === 204 && v2o === 2,
            '机场个人令牌 + 认不出网络:同一个人 3 个设备号当天同一部片只计 1 份;共享密码令牌不受影响', [lv.j && lv.j.success, v2c, rpw.status, v2o]);
        const nH = readLines(CAT_LOG).filter((x) => x.ev === 'heatAdd').length;
        const bad = [
            ['99 字节', { wk: 'c:SSIS-001', dur: 100, bins: b64(new Array(99).fill(1)), dev: DEV1 }],
            ['101 字节', { wk: 'c:SSIS-001', dur: 100, bins: b64(new Array(101).fill(1)), dev: DEV1 }],
            ['非 base64 字符', { wk: 'c:SSIS-001', dur: 100, bins: '!'.repeat(136), dev: DEV1 }],
            ['base64url 字符', { wk: 'c:SSIS-001', dur: 100, bins: BINS.replace(/[A]/g, '-').slice(0, 136), dev: DEV1 }],
            ['数组', { wk: 'c:SSIS-001', dur: 100, bins: new Array(100).fill(1), dev: DEV1 }],
            ['没 dev', { wk: 'c:SSIS-001', dur: 100, bins: BINS }],
            ['dev 太短', { wk: 'c:SSIS-001', dur: 100, bins: BINS, dev: 'short' }],
            ['dev 带怪字符', { wk: 'c:SSIS-001', dur: 100, bins: BINS, dev: 'dev<script>xx' }],
            ['坏 wk', { wk: 'x', dur: 100, bins: BINS, dev: DEV1 }],
            ['dur 0', { wk: 'c:SSIS-001', dur: 0, bins: BINS, dev: DEV1 }],
            ['dur 字符串', { wk: 'c:SSIS-001', dur: 'abc', bins: BINS, dev: DEV1 }],
            ['dur 超 12h', { wk: 'c:SSIS-001', dur: 50000, bins: BINS, dev: DEV1 }],
        ];
        const codes = [];
        for (const [, j] of bad) codes.push((await heat(j, '198.51.100.32')).status);
        ok(codes.every((c) => c === 400) && readLines(CAT_LOG).filter((x) => x.ev === 'heatAdd').length === nH, 'POST heat 校验:长度 / 字符集 / dev / wk / dur 不对 → 400,不进目录', bad.map(([n], i) => n + ':' + codes[i]));
        const rt = await fetch(B() + '/api/catalog/heat', { method: 'POST', headers: { cookie: CK, 'Content-Type': 'text/plain;charset=UTF-8', 'X-Real-IP': '198.51.100.33' }, body: JSON.stringify({ wk: 'c:SSIS-001', dur: 60, bins: BINS, dev: 'devBEACON0001xx' }) });
        devs.push('devBEACON0001xx');
        ok(rt.status === 204, 'POST heat:sendBeacon 的 text/plain JSON 也认', rt.status);
        // 限流:每设备每分钟 6 次;每 IP 每分钟 30 次(伪造的 X-Real-IP 在这里是声明过的可信头,所以按它分 IP)
        const DEVR = 'devRATE000001aa';
        devs.push(DEVR);
        const dc = [];
        for (let i = 0; i < 7; i++) dc.push((await heat({ wk: 'c:SSIS-001', dur: 60, bins: BINS, dev: DEVR }, '198.51.100.40')).status);
        ok(dc.slice(0, 6).every((c) => c === 204) && dc[6] === 429, 'POST heat:每设备每分钟 6 次,超了 429', dc);
        const ic = [];
        for (let i = 0; i < 31; i++) { const d = 'devIP' + String(i).padStart(10, '0'); devs.push(d); ic.push((await heat({ wk: 'c:SSIS-001', dur: 60, bins: BINS, dev: d }, '198.51.100.41')).status); }
        const other = (await heat({ wk: 'c:SSIS-001', dur: 60, bins: BINS, dev: 'devOTHERIP00001' }, '198.51.100.42')).status;
        devs.push('devOTHERIP00001');
        ok(ic.slice(0, 30).every((c) => c === 204) && ic[30] === 429 && other === 204, 'POST heat:每 IP 每分钟 30 次(换设备号开不出新配额),别的 IP 不受影响', [ic.slice(28), other]);
        // 上报 orient
        r = await api('POST', '/api/catalog/beacon', { cookie: CK, json: { site_key: 'a', vod_id: '101', ok: true, orient: 'v', w: 720, h: 1280 } });
        const bo = last('beacon');
        const r2 = await api('POST', '/api/catalog/beacon', { cookie: CK, json: { site_key: 'a', vod_id: '101', ok: true, orient: 'diag' } });
        ok(r.status === 204 && bo.r.orient === 'v' && bo.r.w === 720 && bo.r.h === 1280 && r2.status === 204 && last('beacon').r.orient === '', 'beacon:orient(v/h/sq)/ w / h 透传;别的 orient → 空', [bo.r, last('beacon').r]);
        ok(stubCount() === n0, '相关 / 短片流 / 热度 / 上报 一个资源站都没打', stubLog.slice(n0).map((x) => x.url));
    } catch (e) {
        ok(false, '⑥ 服务器 1 异常: ' + (e && e.stack || e), srvLog.slice(-2000));
    } finally { await stopServer(); }

    // —— 服务器 2:配了 ADULT_ADMIN_TOKEN ——
    const ADMIN_FILE = path.join(P4DIR, 'adult-admin.json');
    let wk102 = '';
    try {
        await startServer(Object.assign({}, base, { ADULT_ADMIN_TOKEN: ADMIN }), hooks);
        let r = await api('GET', '/admin/adult');
        const hasPage = fs.existsSync(path.join(ROOT, 'public', 'adult', 'admin.html'));
        ok(hasPage ? (r.status === 200 && r.h.get('x-frame-options') === 'DENY' && /no-store/.test(r.h.get('cache-control') || '') && /text\/html/.test(r.h.get('content-type') || '')) : r.status === 404,
            '/admin/adult:页面不要令牌(' + (hasPage ? '有 admin.html → 200 + DENY 嵌入 + no-store' : '还没有 admin.html → 404') + ')', [r.status, r.h.get('x-frame-options')]);
        r = await api('GET', '/adult/admin.html');
        ok(r.status === 302 && r.h.get('location') === '/admin/adult' && /no-store/.test(r.h.get('cache-control') || ''), '静态 /adult/admin.html → 302 到 /admin/adult(那里才带 DENY / no-store)', [r.status, r.h.get('location')]);
        r = await api('GET', '/api/adult/admin/stats', { headers: { 'X-Real-IP': '198.51.100.50' } });
        const r1 = await api('GET', '/api/adult/admin/stats', { headers: AH('198.51.100.50', 'wrong-token') });
        const r1b = await api('GET', '/api/adult/admin/stats', { headers: AH('198.51.100.50', ADMIN + 'x') });
        ok(r.status === 401 && r.j.error === 'NO_TOKEN' && r1.status === 401 && r1b.status === 401 && r1.j.error === 'BAD_TOKEN' && /no-store/.test(r1.h.get('cache-control') || ''), '后台:没令牌 → 401 NO_TOKEN;错令牌 / 多一位 → 401 BAD_TOKEN', [r.status, r1.status, r1b.status]);
        ok((await api('GET', '/api/adult/admin/stats?token=' + ADMIN, { headers: { 'X-Real-IP': '198.51.100.51' } })).status === 401, '后台:令牌只认 X-Admin-Token 头(?token= 不认)');
        r = await api('GET', '/api/adult/admin/stats', { headers: AH() });
        const sb = (r.j && r.j.sites || []).find((x) => x.key === 'b'), se = (r.j && r.j.sites || []).find((x) => x.key === 'e');
        ok(r.status === 200 && r.j.works === 3 && r.j.catalog === true && r.j.rejected['category:x'] === 2 && r.j.extraBlock && r.j.extraBlock.n === 0
            && sb && sb.fails === 2 && sb.overrideActive === null && sb.active === true && se && se.active === true, 'GET stats:目录 adminStats + 闸门这边的站点覆盖 / 追加词', r.j);
        // —— 规则测试台 ——
        const T = (j) => api('POST', '/api/adult/admin/test', { headers: AH(), json: j });
        r = await T({ title: '准高一少女 初恋' });
        ok(r.status === 200 && r.j.query === true && r.j.item.ok === false && typeof r.j.item.reason === 'string' && r.j.item.reason, '测试台:被拦片名 → query:true、item.ok:false + 原因', r.j);
        r = await T({ title: 'SSIS-001 温泉旅馆的邂逅', type_name: '日本有码' });
        ok(r.status === 200 && r.j.query === false && r.j.item.ok === true && r.j.item.bucket && r.j.parsed.code === 'SSIS-001' && r.j.parsed.key === 'SSIS-001' && r.j.parsed.codeOk === true
            && Array.isArray(r.j.tags) && r.j.tags.every((t) => typeof t.id === 'string' && typeof t.kind === 'string') && r.j.avdb === null, '测试台:正常番号 → item / parsed / tags / avdb', r.j);
        r = await T({ title: 'SSIS-002 某作品', type_name: '日本有码' });
        ok(r.status === 200 && r.j.avdb === 'block' && r.j.item.ok === false && r.j.item.reason === 'avdb:block', '测试台:AVDB 拦的番号 → avdb:block', r.j);
        const tv = [await T({}), await T({ title: '' }), await T({ title: 'x'.repeat(401) }), await T({ title: 'ok', type_name: 5 }), await T({ title: 'ok', type_name: 'x'.repeat(61) })];
        ok(tv.every((x) => x.status === 400), '测试台:缺标题 / 空 / 超长 / type_name 不是字符串或超长 → 400', tv.map((x) => x.status));
        // —— 追加屏蔽词(只会更严) ——
        const BW = (j) => api('PUT', '/api/adult/admin/block-words', { headers: AH(), json: j });
        r = await api('GET', '/api/adult/admin/block-words', { headers: AH() });
        ok(r.status === 200 && Array.isArray(r.j.words) && r.j.words.length === 0 && r.j.n === 0, 'GET block-words:初始空', r.j);
        const bv = [await BW({}), await BW({ words: 'x' }), await BW({ words: new Array(501).fill(0).map((_, i) => '词' + i) }), await BW({ words: ['好词', 'a'] }),
            await BW({ words: ['好词', 'x'.repeat(41)] }), await BW({ words: ['好词', 5] }), await BW({ words: ['好词', 'ab\u0001'] })];
        r = await api('GET', '/api/adult/admin/block-words', { headers: AH() });
        ok(bv.every((x) => x.status === 400) && r.j.n === 0, 'PUT block-words 校验:不是数组 / >500 / 1 字 / >40 字 / 非字符串 / 控制字符 → 400,词表不变', bv.map((x) => x.status));
        let home = await api('GET', '/api/catalog/home', { cookie: CK });
        ok((home.j.rows[0].items || []).some((c) => c.name === '邻家姐姐的周末'), '对照:加词之前首页有「邻家姐姐的周末」');
        r = await BW({ words: ['姐姐的周', 'Zz Probe', '姐姐的周'] });
        ok(r.status === 200 && r.j.n === 2 && r.j.applied.main === true && r.j.applied.catalog === true && JSON.stringify(last('setExtraBlock').words) === JSON.stringify(['姐姐的周', 'Zz Probe']),
            'PUT block-words:去重、设到主线程 policy + 目录(setExtraBlock)', [r.j, last('setExtraBlock')]);
        home = await api('GET', '/api/catalog/home', { cookie: CK });
        let n0 = stubCount();
        const sq = await sse('/api/search?wd=' + encodeURIComponent('姐姐的周') + '&stream=true', CK);
        const sq2 = await api('GET', '/api/search?wd=' + encodeURIComponent('zz-probe'), { cookie: CK });
        ok(!(home.j.rows[0].items || []).some((c) => c.name === '邻家姐姐的周末') && sq.items.length === 0 && sq2.j.list.length === 0 && stubCount() === n0,
            '追加词立即生效:首页卡片出口被滤;命中追加词的查询空结果、一个资源站都不打', [home.j.rows[0].items.map((c) => c.name), stubLog.slice(n0).map((x) => x.url)]);
        const af = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
        ok(JSON.stringify(af.blockWords) === JSON.stringify(['姐姐的周', 'Zz Probe']), '追加词持久化到 cache.db 旁边的 adult-admin.json', af);
        r = await BW({ words: [] });
        home = await api('GET', '/api/catalog/home', { cookie: CK });
        n0 = stubCount();
        const sb2 = await sse('/api/search?wd=' + encodeURIComponent('迷奸') + '&stream=true', CK);
        ok(r.status === 200 && r.j.n === 0 && (home.j.rows[0].items || []).some((c) => c.name === '邻家姐姐的周末') && !(home.j.rows[0].items || []).some((c) => c.name === '准高一少女 初恋')
            && sb2.items.length === 0 && stubCount() === n0, 'PUT []:只清空追加词;内置规则一条不动(被拦片名仍不出、硬拦查询仍不打上游)', [r.j, home.j.rows[0].items.map((c) => c.name)]);
        // [integ] 目录没设上(setExtraBlock 回 {ok:false}):闸门等它的结果 → 503 CATALOG_FAILED;主线程已生效且落盘(只会更严,重启再推给目录)
        r = await BW({ words: ['ZzCatFail'] });
        const afx = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
        const sqx = await api('GET', '/api/search?wd=' + encodeURIComponent('zzcatfail'), { cookie: CK });
        ok(r.status === 503 && r.j.error === 'CATALOG_FAILED' && r.j.applied && r.j.applied.main === true && r.j.applied.catalog === false && r.j.n === 1
            && JSON.stringify(afx.blockWords) === JSON.stringify(['ZzCatFail']) && sqx.j.list.length === 0, 'PUT block-words:目录回 {ok:false} → 503(主线程照样生效并落盘)', [r.status, r.j, afx.blockWords]);
        r = await BW({ words: [] });
        ok(r.status === 200 && r.j.n === 0, '清空追加词(接着测)', r.j);
        // —— 隐藏作品 ——
        const H = (j, ip) => api('POST', '/api/adult/admin/hide', { headers: AH(ip), json: j });
        r = await api('GET', '/api/adult/admin/hidden', { headers: AH() });
        ok(r.status === 200 && Array.isArray(r.j) && r.j.length === 0, 'GET hidden:初始空', r.j);
        r = await H({ wk: 't:hid1', on: true });
        ok(r.status === 200 && r.j.ok && r.j.hidden === true && last('adminHide').wk === 't:hid1' && last('adminHide').on === true, 'POST hide:交给目录 adminHide、闸门的隐藏表立刻刷新', [r.j, last('adminHide')]);
        r = await H({ wk: 't:catdown1', on: true });
        ok(r.status === 503 && r.j.ok === false && r.j.error === 'CATALOG_UNAVAILABLE' && r.j.detail === 'unavailable', 'POST hide:目录回 {ok:false} → 503(不再当成功)', [r.status, r.j]);
        await H({ wk: 't:blocked1', on: true });
        r = await api('GET', '/api/adult/admin/hidden', { headers: AH() });
        ok(JSON.stringify(r.j.map((x) => [x.wk, x.name])) === JSON.stringify([['t:hid1', '被隐藏的合成作品']]), 'GET hidden:片名被拦的条目不列(被拦的本来就哪儿都不出)', r.j);
        const rel = await api('GET', '/api/catalog/related/' + encodeURIComponent('c:SSIS-001'), { cookie: CK });
        const fd = await api('GET', '/api/catalog/feed?vert=1', { cookie: CK });
        ok(!rel.j.items.some((c) => c.wk === 't:hid1') && !fd.j.items.some((x) => x.wk === 't:hid1'), '隐藏的作品:相关推荐 / 短片流都不出', [rel.j.items.map((c) => c.wk), fd.j.items.map((x) => x.wk)]);
        ok((await api('GET', '/api/catalog/related/' + encodeURIComponent('t:hid1'), { cookie: CK })).status === 404 && (await api('GET', '/api/catalog/heat/' + encodeURIComponent('t:hid1'), { cookie: CK })).status === 204,
            '隐藏的作品:自己的相关页 404、热度 204');
        // 复核 r3:隐藏主作品 → 它的 ~N / #clip 兄弟在作品页也 404(直链 / 继续观看 / 分享链接都开不了);撤销后照常
        const WK = (k) => api('GET', '/api/catalog/work?k=' + encodeURIComponent(k), { cookie: CK });
        const sibPre = [(await WK('c:SSIS-001~2')).status, (await WK('c:SSIS-001#clip')).status];
        await H({ wk: 'c:SSIS-001', on: true });
        const sibMid = [(await WK('c:SSIS-001')).status, (await WK('c:SSIS-001~2')).status, (await WK('c:SSIS-001#clip')).status];
        const nWork = readLines(CAT_LOG).filter((x) => x.ev === 'work').length;
        await WK('c:SSIS-001~3');
        const sibAsk = readLines(CAT_LOG).filter((x) => x.ev === 'work').length - nWork;
        await H({ wk: 'c:SSIS-001', on: false });
        const sibPost = (await WK('c:SSIS-001~2')).status;
        ok(sibPre.join() === '200,200' && sibMid.join() === '404,404,404' && sibAsk === 0 && sibPost === 200,
            '隐藏主作品:它的 ~N / #clip 兄弟作品页也 404(不去问目录);撤销隐藏后照常 200', [sibPre, sibMid, sibAsk, sibPost]);
        // 兄弟单独被隐藏:主作品照开,_meta.siblings 不再列它
        await H({ wk: 'c:SSIS-001#U', on: true });
        const wsib = await WK('c:SSIS-001');
        await H({ wk: 'c:SSIS-001#U', on: false });
        const wsib2 = await WK('c:SSIS-001');
        ok(wsib.status === 200 && wsib.j._meta.siblings.length === 0 && wsib2.j._meta.siblings.length === 1 && wsib2.j._meta.siblings[0].wk === 'c:SSIS-001#U',
            '兄弟单独隐藏:主作品照开,作品页的同番号版本里不再列它', [wsib.j && wsib.j._meta.siblings, wsib2.j && wsib2.j._meta.siblings]);
        let js = await api('GET', '/api/search?wd=' + encodeURIComponent('周末'), { cookie: CK });
        const it102 = (js.j.list || []).find((x) => keyOf(x) === 'a_102');
        wk102 = it102 ? it102._wk : '';
        ok(!!wk102, '对照:隐藏前搜得到 a_102', js.j.list.map(keyOf));
        await H({ wk: wk102, on: true });
        js = await api('GET', '/api/search?wd=' + encodeURIComponent('周末'), { cookie: CK });
        const sse2 = await sse('/api/search?wd=' + encodeURIComponent('周末') + '&stream=true', CK);
        const dt = await api('GET', '/api/detail?id=102&site_key=a', { cookie: CK });
        const dp = await api('POST', '/api/detail', { cookie: CK, json: { id: 102, siteKey: 'a' } });
        ok(!(js.j.list || []).some((x) => keyOf(x) === 'a_102') && !sse2.items.some((x) => keyOf(x) === 'a_102') && dt.status === 404 && dp.status === 404,
            '隐藏的作品:现搜结果(JSON / SSE)不出、详情 GET / POST 404', [js.j.list.map(keyOf), dt.status, dp.status]);
        await H({ wk: wk102, on: false });
        js = await api('GET', '/api/search?wd=' + encodeURIComponent('周末'), { cookie: CK });
        ok((js.j.list || []).some((x) => keyOf(x) === 'a_102') && (await api('GET', '/api/detail?id=102&site_key=a', { cookie: CK })).status === 200, '取消隐藏:搜索 / 详情恢复');
        const hv = [await H({ wk: 'bad', on: true }), await H({ wk: 't:x', on: 'yes' }), await H({ on: true }), await H({ wk: 't:' + 'x'.repeat(300), on: true })];
        ok(hv.every((x) => x.status === 400), 'POST hide 校验 → 400', hv.map((x) => x.status));
        // —— 站点停用(运行时覆盖,持久化)——
        r = await api('GET', '/api/adult/admin/sites', { headers: AH() });
        const rows = Object.fromEntries((r.j || []).map((x) => [x.key, x]));
        ok(r.status === 200 && JSON.stringify(Object.keys(rows)) === JSON.stringify(['a', 'b', 'c', 'd', 'e']) && rows.d.configuredActive === false && rows.d.active === false
            && rows.a.current === A2 && rows.a.api === SITES[0].api && rows.a.lastOk === 1700000000000 && rows.e.mirrors === 1 && rows.b.overrideActive === null, 'GET sites:站点表全部(含 active:false)+ 镜像当前地址 + 目录统计', r.j);
        const SS = (j, ip) => api('POST', '/api/adult/admin/site', { headers: AH(ip), json: j });
        r = await SS({ key: 'b', active: false });
        ok(r.status === 200 && r.j.active === false && r.j.overrideActive === false && r.j.persisted === true, 'POST site b active:false → 停用(已落盘)', r.j);
        const as1 = last('adminSite');
        ok(r.j.catalog === true && as1 && as1.key === 'b' && as1.active === false && as1.known === true && as1.cfgActive === false,
            'POST site:也交给目录 adminSite(目录的站点表里 b 已标成 active:false,不是删掉)', [r.j.catalog, as1]);
        n0 = stubCount();
        const sites2 = await api('GET', '/api/sites', { cookie: CK });
        const sb3 = await sse('/api/search?wd=' + encodeURIComponent('周末') + '&stream=true', CK);
        const db3 = await api('GET', '/api/detail?id=201&site_key=b', { cookie: CK });
        await api('GET', '/api/catalog/tags?b=probe_sites', { cookie: CK });
        const ps = last('probe_sites');
        ok(!sites2.j.sites.some((s) => s.key === 'b') && !sb3.items.some((x) => x.site_key === 'b') && !stubLog.slice(n0).some((x) => x.site === 'b') && db3.status === 404
            && Array.isArray(ps.sites) && !ps.sites.some((x) => x[0] === 'b' && x[2] !== false) && ps.sites.some((x) => x[0] === 'b' && x[2] === false) && ps.sites.some((x) => x[0] === 'a' && x[1] === SITES[0].api),
        '停用的站:/api/sites 不列、搜索不扇出(一个请求都不打)、详情 404、目录的站点表里标成 active:false(不爬;留在表里 = 重扫 / 保留期不当成"站点已删除"删它的线路)', [sites2.j.sites.map((s) => s.key), ps]);
        r = await work4(CK);
        ok(r.status === 200 && !r.j.sources.some((s) => s.site_key === 'b'), '停用的站:作品页线路也不出', r.j && r.j.sources.map((s) => s.site_key));
        const sv = [await SS({ key: 'zz', active: false }), await SS({ key: 'b', active: 'no' }), await SS({ active: false }), await SS({ key: 'x'.repeat(65), active: false })];
        ok(sv[0].status === 404 && sv.slice(1).every((x) => x.status === 400), 'POST site:不认识的站 404;字段不对 400', sv.map((x) => x.status));
        r = await SS({ key: 'd', active: true });
        const sd = await api('GET', '/api/sites', { cookie: CK });
        ok(r.status === 200 && r.j.active === false && r.j.configuredActive === false && !sd.j.sites.some((s) => s.key === 'd'), 'POST site d active:true:db 里 active:false 的站开不了(只能撤销后台停用)', r.j);
        ok(JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')).siteOff.b > 0, '站点停用持久化到 adult-admin.json');
        // —— 镜像 ——
        r = await api('GET', '/api/adult/admin/mirrors', { headers: AH() });
        ok(r.status === 200 && Array.isArray(r.j) && r.j.some((x) => x.key === 'a' && x.current === A2), 'GET mirrors → mirror.status()', r.j);
        r = await api('POST', '/api/adult/admin/mirror/probe', { headers: AH(), json: { key: 'a' } });
        ok(r.status === 200 && r.j.reason === 'stub' && mlog().some((x) => x.ev === 'probe' && x.k === 'a'), 'POST mirror/probe → mirror.probe(key)', r.j);
        const mv = [await api('POST', '/api/adult/admin/mirror/probe', { headers: AH(), json: { key: 'zz' } }), await api('POST', '/api/adult/admin/mirror/probe', { headers: AH(), json: {} })];
        ok(mv[0].status === 404 && mv[1].status === 400, 'mirror/probe:不认识的站 404、缺 key 400', mv.map((x) => x.status));
        // 复核 SEC-2:后台「回到主地址」
        const rsNo = await api('POST', '/api/adult/admin/mirror/reset', { headers: { 'X-Real-IP': '198.51.100.21' }, json: { key: 'a' } });
        r = await api('POST', '/api/adult/admin/mirror/reset', { headers: AH(), json: { key: 'a' } });
        ok(rsNo.status === 401 && r.status === 200 && r.j.ok === true && r.j.switched === true && r.j.from === A2 && r.j.current === SITES[0].api && r.j.reason === 'admin-reset'
            && mlog().filter((x) => x.ev === 'reset' && x.k === 'a').length === 1, 'POST mirror/reset → mirror.reset(key)(要 X-Admin-Token;没令牌 401 且不调)', [rsNo.status, r.status, r.j]);
        const mvr = [await api('POST', '/api/adult/admin/mirror/reset', { headers: AH(), json: { key: 'zz' } }), await api('POST', '/api/adult/admin/mirror/reset', { headers: AH(), json: {} }), await api('POST', '/api/adult/admin/mirror/reset', { headers: AH(), json: { key: 'x'.repeat(65) } })];
        ok(mvr[0].status === 404 && mvr[1].status === 400 && mvr[2].status === 400, 'mirror/reset:不认识的站 404、缺 key / 太长 400', mvr.map((x) => x.status));
        r = await api('GET', '/api/adult/admin/mirrors', { headers: AH() });
        ok(r.status === 200 && r.j.some((x) => x.key === 'a' && x.current === SITES[0].api), 'mirror/reset 之后 GET mirrors:a 回到主地址', r.j);
        ok((await api('GET', '/api/adult/admin/nope', { headers: AH() })).status === 404, '后台下未知路径 → 404');
        await BW({ words: ['姐姐的周'] });   // 留一个,下面重启验持久化
        // —— 锁定:同一 IP 10 分钟 5 次错令牌 → 429,锁着时对的令牌也不收;别的 IP 不受影响 ——
        //    修订:不带令牌的请求只回 401、不算错(和站长共用客户端键的人发空请求锁不住站长)
        const NT = [];
        for (let i = 0; i < 12; i++) NT.push((await api('GET', '/api/adult/admin/stats', { headers: { 'X-Real-IP': '198.51.100.66' } })).status);
        const goodAfterNt = (await api('GET', '/api/adult/admin/stats', { headers: AH('198.51.100.66') })).status;
        ok(NT.every((c) => c === 401) && goodAfterNt === 200, '后台:12 次不带令牌的请求不算错,对的令牌照常 200', [NT, goodAfterNt]);
        const L = [];
        for (let i = 0; i < 4; i++) L.push((await api('GET', '/api/adult/admin/stats', { headers: AH('198.51.100.66', 'bad' + i) })).status);
        const good = (await api('GET', '/api/adult/admin/stats', { headers: AH('198.51.100.66') })).status;
        const fifth = await api('GET', '/api/adult/admin/stats', { headers: AH('198.51.100.66', 'bad5') });
        const after = (await api('GET', '/api/adult/admin/stats', { headers: AH('198.51.100.66') })).status;
        const otherIp = (await api('GET', '/api/adult/admin/stats', { headers: AH('198.51.100.67') })).status;
        ok(L.every((c) => c === 401) && good === 200 && fifth.status === 429 && fifth.j.error === 'LOCKED' && after === 429 && otherIp === 200,
            '后台锁定:4 次错 → 401、对的仍 200;第 5 次错 → 429 LOCKED,之后对的令牌也 429;别的 IP 照常', [L, good, fifth.status, after, otherIp]);
    } catch (e) {
        ok(false, '⑥ 服务器 2 异常: ' + (e && e.stack || e), srvLog.slice(-2000));
    } finally { await stopServer(); }

    // —— 服务器 3:重启后持久化(停用的站、追加词;目录存的词并进来)——
    try {
        const nX = readLines(CAT_LOG).filter((x) => x.ev === 'setExtraBlock').length;
        const nS = readLines(CAT_LOG).filter((x) => x.ev === 'adminSite').length;
        // 复核修订:这台只配契约里的 ADMIN_TOKEN(没有 ADULT_ADMIN_TOKEN)→ 成人后台照样开、认它
        await startServer(Object.assign({}, base, { ADMIN_TOKEN: ADMIN, ADULT_TEST_CAT_XWORDS: '合成目录词', ADULT_TEST_CAT_SITEOV: 'a' }), hooks);
        await sleep(100);
        let r = await api('GET', '/api/adult/admin/block-words', { headers: AH('198.51.100.70') });
        ok(r.status === 200, '只配 ADMIN_TOKEN(契约):成人后台开、认这个令牌', [r.status, r.text.slice(0, 80)]);
        const sx = readLines(CAT_LOG).filter((x) => x.ev === 'setExtraBlock').slice(nX);
        ok(r.status === 200 && JSON.stringify(r.j.words.slice().sort()) === JSON.stringify(['合成目录词', '姐姐的周'].sort()) && sx.length >= 1 && sx[sx.length - 1].words.length === 2,
            '重启:后台存的追加词 ∪ 目录存的追加词 → 主线程 + 目录都设上', [r.j, sx]);
        ok(JSON.stringify(JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8')).blockWords.slice().sort()) === JSON.stringify(['合成目录词', '姐姐的周'].sort()), '重启:并集写回 adult-admin.json');
        const home = await api('GET', '/api/catalog/home', { cookie: CK });
        ok(!(home.j.rows[0].items || []).some((c) => c.name === '邻家姐姐的周末'), '重启:追加词在第一个请求之前就生效');
        const s1 = await api('GET', '/api/sites', { cookie: CK });
        ok(!s1.j.sites.some((s) => s.key === 'b'), '重启:停用的站仍停用', s1.j.sites.map((s) => s.key));
        {
            // 目录存着 a 停用(以前"启用"没存上留下的),adult-admin.json 只停 b → 启动对齐:目录 a 撤销、b 补上停用
            const ev = readLines(CAT_LOG).filter((x) => x.ev === 'adminSite').slice(nS);
            ok(ev.some((x) => x.key === 'a' && x.active === true) && ev.some((x) => x.key === 'b' && x.active === false) && ev.length === 2,
                '重启:目录的站点停用覆盖按 adult-admin.json 对齐(多的撤销、少的补上)', ev);
            ok(s1.j.sites.some((s) => s.key === 'a'), '重启:a 没被后台停用 → 照常出现在 /api/sites', s1.j.sites.map((s) => s.key));
        }
        r = await api('POST', '/api/adult/admin/site', { headers: AH('198.51.100.70'), json: { key: 'b', active: true } });
        const s2 = await api('GET', '/api/sites', { cookie: CK });
        ok(r.status === 200 && r.j.active === true && r.j.overrideActive === null && s2.j.sites.some((s) => s.key === 'b'), 'POST site b active:true → 撤销停用', r.j);
        const as2 = last('adminSite');
        ok(r.j.catalog === true && as2 && as2.key === 'b' && as2.active === true && as2.cfgActive === true, 'POST site active:true:目录的覆盖也撤销', as2);
        await api('PUT', '/api/adult/admin/block-words', { headers: AH('198.51.100.70'), json: { words: [] } });
        // dev 原文绝不落地:临时目录里的文件、服务器日志都没有
        const files = [];
        const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else if (st.size < 64 * 1024 * 1024) files.push(p); } };
        walk(tmp);
        const leaks = [];
        for (const f of files) { const buf = fs.readFileSync(f).toString('latin1'); for (const d of devs) if (buf.includes(d)) leaks.push(path.basename(f) + ':' + d); }
        ok(devs.length > 30 && !leaks.length && !devs.some((d) => srvLog.includes(d)), '热度上报的 dev 原文不落任何文件 / 日志(只存按天加盐的哈希)', leaks.slice(0, 5));
        const af = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
        ok(/^[0-9a-f]{64}$/.test(af.heatSecret || ''), 'adult-admin.json 存着热度盐的种子(重启后同一设备当天哈希不变)');
    } catch (e) {
        ok(false, '⑥ 服务器 3 异常: ' + (e && e.stack || e), srvLog.slice(-2000));
    } finally { await stopServer(); }
    // —— 服务器 4(修订):换上去的镜像源站,出网时再判地址(静态 + 连接那一刻 safeLookup):镜像指到内网(这里 = 本机替身 127.0.0.1)→ 直连拒、一个请求都不打 ——
    try {
        await startServer(Object.assign({}, base, { ADULT_TEST_MIRROR_GUARDED: '1' }), hooks);
        const n0 = stubCount();
        const nRep = mlog().filter((x) => x.ev === 'report' && x.k === 'a' && x.ok === false).length;
        const r = await api('GET', '/api/search?wd=' + encodeURIComponent('合成镜像防护'), { cookie: CK });   // 没搜过的词(别吃到前面的搜索缓存)
        const ck = await api('GET', '/api/check?key=a', { cookie: CK });
        const hit = stubLog.slice(n0);
        ok(r.status === 200 && !hit.some((x) => x.site === 'a2') && hit.some((x) => x.site === 'b') && mlog().filter((x) => x.ev === 'report' && x.k === 'a' && x.ok === false).length > nRep
            && ck.j && ck.j.latency >= 9000,
            '镜像源站解析到内网:搜索 / 测速都不直连它(报失败给镜像模块),别的站照常', [hit.map((x) => x.url), ck.j]);
    } catch (e) {
        ok(false, '⑥ 服务器 4 异常: ' + (e && e.stack || e), srvLog.slice(-2000));
    } finally { await stopServer(); }
    async function work4(cookie) { return api('GET', '/api/catalog/work?k=' + encodeURIComponent('c:SSIS-001'), { cookie }); }
}

stub.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
