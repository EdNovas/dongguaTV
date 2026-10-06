#!/usr/bin/env node
// 资源站档案(lib/site-profiles)离线测试。
//   node scripts/site-profiles-test.mjs
// 覆盖:profiles.json 结构/档位合法性、域名归一化(www./端口/大小写)、内置规则站按 key 查、db.json 覆盖层
// (profile 长短字段 / ad_tier 简写 / 中文标签)、坏输入不抛、profileMap 去重与 __proto__、
// 以及 api/index.js 的 /api/sites 真实返回(进程内起 express,SITES_JSON 注入站点,不碰外网)。
// 改 lib/site-profiles/* 或两后端的 /api/sites、/api/search 附加逻辑后必跑。失败退出码非 0。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = require(path.join(ROOT, 'lib/site-profiles/index.js'));
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/site-profiles/profiles.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) pass++;
    else { fail++; failures.push(name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

// ============ 1. 数据文件本身 ============
{
    ok(/^\d{4}-\d{2}-\d{2}$/.test(DATA.version), 'json: version 是日期');
    eq(P.version, DATA.version, 'module: 导出 version');
    const TIERS = ['clean', 'noburn', 'unknown', 'ads'];
    const RES = [undefined, '4k', '1080p', '720p', 'sd'];
    for (const [k, v] of Object.entries(DATA.hosts)) {
        ok(k === k.toLowerCase() && !/^www\./.test(k) && !/[/:]/.test(k), 'json: host 键已归一化 ' + k);
        ok(TIERS.includes(v.t), 'json: 合法档位 ' + k, v.t);
        ok(RES.includes(v.r), 'json: 合法分辨率 ' + k, v.r);
    }
    for (const [k, v] of Object.entries(DATA.keys)) {
        ok(/^kz_[a-z0-9_]+$/.test(k), 'json: keys 只放内置规则站 ' + k);
        ok(TIERS.includes(v.t), 'json: 合法档位 ' + k, v.t);
    }
    // c(编码)只允许 hevc 或不写 —— 前端只认 'hevc',写成 h265/H.265 也能被模块归一化,但数据文件保持一种写法
    for (const [k, v] of Object.entries(Object.assign({}, DATA.hosts, DATA.keys))) ok(v.c === undefined || v.c === 'hevc', 'json: 合法编码 ' + k, v.c);
    // clean 档只给真正抽帧验过的(审计:当前只有 3 个番剧规则站)
    const cleanHosts = Object.entries(DATA.hosts).filter(([, v]) => v.t === 'clean').map(([k]) => k);
    eq(cleanHosts, [], 'json: maccms 站目前没有 clean 档');
    // 审计判死的源不该有档案(它们应从 db.json 删掉,不是贴标签)
    for (const dead of ['wolongzyw.com', 'mozhuazy.com', 'wwzy.tv', 'api.wwzy.tv', 'p2100.net', 'cj.huohua.vip', 'zy.sh0o.cn', 'api.jmzy.com', 'taopianapi.com'])
        ok(!(dead in DATA.hosts), 'json: 死源无档案 ' + dead);
    // 内置规则站的 key 必须真实存在(改名后档案会静默失效)
    let kzKeys = [];
    try { kzKeys = require(path.join(ROOT, 'lib/kazumi')).getSites({ env: {} }).map((s) => s.key); } catch (e) { kzKeys = null; }
    if (kzKeys) for (const k of Object.keys(DATA.keys)) ok(kzKeys.includes(k), 'json: keys 对应现存规则站 ' + k, kzKeys);
}

// ============ 2. hostOf ============
{
    eq(P.hostOf('https://www.Lovedan.NET/api.php/provide/vod'), 'lovedan.net', 'hostOf: 小写 + 去 www.');
    eq(P.hostOf('http://cj.rycjapi.com:8080/api.php/provide/vod/'), 'cj.rycjapi.com', 'hostOf: 去端口');
    eq(P.hostOf('cj.rycjapi.com/api.php/provide/vod'), 'cj.rycjapi.com', 'hostOf: 无协议也能解析');
    eq(P.hostOf('https://wwwx.example.com/'), 'wwwx.example.com', 'hostOf: 只剥 "www." 整段');
    eq(P.hostOf(''), '', 'hostOf: 空串');
    eq(P.hostOf(null), '', 'hostOf: null');
    eq(P.hostOf('http://'), '', 'hostOf: 坏 URL 不抛');
}

// ============ 3. profileFor:内置表 ============
{
    const S = (key, api, extra) => Object.assign({ key, name: key, api, active: true }, extra || {});
    eq(P.profileFor(S('rycj', 'https://cj.rycjapi.com/api.php/provide/vod')),
        { tier: 'noburn', res: '1080p', geo: false, note: '片尾偶有12秒插播', codec: '' }, 'profile: 如意 = 无硬广 1080p');
    eq(P.profileFor(S('ffzy', 'http://api.ffzyapi.com/api.php/provide/vod')).geo, true, 'profile: 非凡 海外受限');
    eq(P.profileFor(S('myzy', 'https://api.maoyanapi.top/api.php/provide/vod')).res, 'sd', 'profile: 猫眼 标清');
    eq(P.profileFor(S('lovedan', 'https://www.lovedan.net/api.php/provide/vod')).tier, 'ads', 'profile: www. 前缀也能命中');
    eq(P.profileFor(S('lzi', 'https://cj.lziapi.com/api.php/provide/vod/')),
        { tier: 'unknown', res: '', geo: true, note: '', codec: '' }, 'profile: 量子 未评测 + 海外受限');
    // key 不参与 maccms 站查找:同一站在不同部署 key 不同,换 key 仍按域名命中
    eq(P.profileFor(S('whatever', 'https://cj.rycjapi.com/x')).tier, 'noburn', 'profile: maccms 只认域名');
    eq(P.profileFor(S('new', 'https://unknown-site.example/api')), { tier: 'unknown', res: '', geo: false, note: '', codec: '' }, 'profile: 未知域名 → 未评测');
    // 内置规则站:按 key;db.json 里同 key 的 maccms 条目(kazumi 不为 true)不能套用 kz 档案
    eq(P.profileFor({ key: 'kz_7sefun', name: '七色番', kazumi: true, api: '' }).tier, 'clean', 'profile: 七色番 无广告');
    eq(P.profileFor({ key: 'kz_moonci', kazumi: true, api: '' }), { tier: 'clean', res: '1080p', geo: false, note: 'HEVC', codec: 'hevc' }, 'profile: 月之祠 HEVC 备注');
    eq(P.profileFor({ key: 'kz_dm84', kazumi: true, api: '' }).tier, 'noburn', 'profile: 动漫巴士 无硬广');
    eq(P.profileFor(S('kz_7sefun', 'https://some-maccms.example/api')).tier, 'unknown', 'profile: 同 key 的 maccms 覆盖条目不吃 kz 档案');
    eq(P.profileFor({ key: 'kz_new', kazumi: true, api: '' }).tier, 'unknown', 'profile: 新规则站默认未评测');
    // 原型键不算命中
    eq(P.profileFor({ key: 'constructor', kazumi: true }).tier, 'unknown', 'profile: keys 原型键');
    eq(P.profileFor(S('x', 'https://constructor/')).tier, 'unknown', 'profile: hosts 原型键');
    eq(P.profileFor(S('x', 'https://__proto__/')).tier, 'unknown', 'profile: hosts __proto__');
}

// ============ 4. db.json 覆盖层 ============
{
    const api = 'https://cj.rycjapi.com/api.php/provide/vod';
    eq(P.profileFor({ key: 'r', api, ad_tier: 'ads' }).tier, 'ads', 'override: ad_tier 简写');
    eq(P.profileFor({ key: 'r', api, ad_tier: '无广告' }).tier, 'clean', 'override: ad_tier 中文标签');
    eq(P.profileFor({ key: 'r', api, ad_tier: 'CLEAN' }).tier, 'clean', 'override: ad_tier 大小写');
    eq(P.profileFor({ key: 'r', api, ad_tier: 'bogus' }).tier, 'unknown', 'override: 写错的档位 → 未评测(不保留旧值,免得以为生效了)');
    eq(P.profileFor({ key: 'r', api, ad_tier: '' }).tier, 'noburn', 'override: 空 ad_tier 忽略');
    eq(P.profileFor({ key: 'r', api, profile: { res: '720P' } }),
        { tier: 'noburn', res: '720p', geo: false, note: '片尾偶有12秒插播', codec: '' }, 'override: profile 只改写了的字段');
    eq(P.profileFor({ key: 'r', api, profile: { t: 'ads', r: '4K', geo: 1, n: '  新横幅  ' } }),
        { tier: 'ads', res: '4k', geo: true, note: '新横幅', codec: '' }, 'override: profile 短字段');
    eq(P.profileFor({ key: 'r', api, profile: { note: '' } }).note, '', 'override: 空 note 可清掉内置备注');
    eq(P.profileFor({ key: 'r', api, profile: { c: 'H.265' } }).codec, 'hevc', 'override: 短字段 c 认 H.265 → hevc');
    eq(P.profileFor({ key: 'r', api, profile: { codec: 'avc' } }).codec, '', 'override: 非 HEVC 的 codec → 空');
    eq(P.profileFor({ key: 'kz_xfdm', kazumi: true, api: '' }).codec, 'hevc', 'profile: 稀饭 HEVC');
    eq(P.profileFor({ key: 'kz_7sefun', kazumi: true, api: '' }).codec, '', 'profile: 七色番 H.264');
    eq(P.profileFor({ key: 'r', api, profile: { tier: 'clean' }, ad_tier: 'ads' }).tier, 'ads', 'override: ad_tier 在 profile 之后生效');
    eq(P.profileFor({ key: 'r', api, profile: { res: '540p' } }).res, 'sd', 'override: 540p → 标清');
    eq(P.profileFor({ key: 'r', api, profile: { res: 'weird' } }).res, '', 'override: 认不出的分辨率 → 空');
    eq(P.profileFor({ key: 'r', api, profile: { note: 'x'.repeat(500) } }).note.length, 120, 'override: note 截断');
    eq(P.profileFor({ key: 'r', api, profile: 'ads' }).tier, 'noburn', 'override: profile 非对象忽略');
    eq(P.profileFor({ key: 'r', api, profile: ['ads'] }).tier, 'noburn', 'override: profile 数组忽略');
    eq(P.profileFor({ key: 'kz_7sefun', kazumi: true, ad_tier: 'ads' }).tier, 'ads', 'override: 规则站也能覆盖');
}

// ============ 5. 坏输入 / profileMap ============
{
    for (const bad of [null, undefined, 0, 'str', [], {}]) {
        let r, threw = false;
        try { r = P.profileFor(bad); } catch (e) { threw = true; }
        ok(!threw && r && r.tier === 'unknown', 'robust: profileFor(' + JSON.stringify(bad) + ')', r);
    }
    const m = P.profileMap([
        { key: 'a', api: 'https://cj.rycjapi.com/' },
        { key: 'a', api: 'https://api.zuidapi.com/' },   // 同 key 取第一个(db.json 优先于内置,与 allSites 同序)
        { key: '__proto__', api: 'https://api.zuidapi.com/' },
        { key: '', api: 'https://api.zuidapi.com/' },
        null,
        { api: 'https://api.zuidapi.com/' },
        { key: 'kz_xfdm', kazumi: true, api: '' },
    ]);
    eq(m.a.tier, 'noburn', 'map: 同 key 取第一个');
    eq(Object.keys(m).sort(), ['__proto__', 'a', 'kz_xfdm'].sort(), 'map: 跳过空 key / null');
    eq(Object.getPrototypeOf(m), null, 'map: 无原型(__proto__ 键不污染)');
    eq(JSON.parse(JSON.stringify(m)).kz_xfdm.tier, 'clean', 'map: 可正常 JSON 序列化');
    eq(P.profileMap(null), {}, 'map: 非数组 → 空表');
    eq(JSON.stringify(P.profileMap(null)), '{}', 'map: 空表序列化');
}

// ============ 6. 两后端接线(源码静态检查:require 必须是静态字面量,Vercel 才打包) ============
{
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const vc = fs.readFileSync(path.join(ROOT, 'api/index.js'), 'utf8');
    ok(/require\('\.\/lib\/site-profiles'\)/.test(srv), 'wire: server.js 静态 require');
    ok(/require\('\.\.\/lib\/site-profiles'\)/.test(vc), 'wire: api/index.js 静态 require');
    ok(/res\.json\(withSiteProfiles\(sitesData\)\)/.test(srv), 'wire: server.js /api/sites 带档案表');
    // 搜索:发出的每个出口都附 site_profile;写进缓存的 list 不带
    ok((srv.match(/site_profile/g) || []).length >= 6, 'wire: server.js 搜索出口附 site_profile');
    ok((vc.match(/site_profile/g) || []).length >= 6, 'wire: api/index.js 搜索出口附 site_profile');
    ok(!/cacheManager\.set\('search'[^\n]*site_profile/.test(srv), 'wire: 搜索缓存不含档案');
    // /api/sites 必须返回新对象:往 remoteDbCache / EMBEDDED_SITES 上挂 profiles 会让过期判断与后续合并读到脏数据
    for (const [name, src] of [['server.js', srv], ['api/index.js', vc]])
        ok(/Object\.assign\(\{\}, (sitesData|d), \{ profiles:/.test(src), 'wire: ' + name + ' 档案表不改缓存对象');
}

// ============ 7. api/index.js /api/sites 真实返回(进程内,SITES_JSON 注入,不碰外网) ============
async function liveVercel() {
    const embedded = { sites: [
        { key: 'rycj', name: '如意', api: 'https://cj.rycjapi.com/api.php/provide/vod', active: true },
        { key: 'zuid', name: '最大', api: 'https://api.zuidapi.com/api.php/provide/vod', active: true, ad_tier: 'unknown' },
    ] };
    const snapshot = JSON.stringify(embedded);
    const saved = { SITES_JSON: process.env.SITES_JSON, REMOTE_DB_URL: process.env.REMOTE_DB_URL };
    process.env.SITES_JSON = snapshot;
    delete process.env.REMOTE_DB_URL;
    const origWarn = console.warn, origLog = console.log;
    console.log = () => {};   // 模块加载期的启动日志不刷屏
    let app;
    try { app = require(path.join(ROOT, 'api/index.js')); }
    finally { console.log = origLog; console.warn = origWarn; }
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = (p) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
            let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }).on('error', reject);
    });
    try {
        const r1 = await get('/api/sites');
        let d = null; try { d = JSON.parse(r1.body); } catch (e) { }
        ok(r1.status === 200 && d, 'vercel: /api/sites 200', r1.status);
        if (d) {
            eq(d.sites.length, 2, 'vercel: sites 原样返回');
            eq(d.profiles_version, P.version, 'vercel: profiles_version');
            eq(d.profiles && d.profiles.rycj && d.profiles.rycj.tier, 'noburn', 'vercel: 如意档案');
            eq(d.profiles && d.profiles.zuid && d.profiles.zuid.tier, 'unknown', 'vercel: db 覆盖生效');
            ok(d.profiles && d.profiles.kz_7sefun && d.profiles.kz_7sefun.tier === 'clean', 'vercel: 档案表含内置规则站', d.profiles && Object.keys(d.profiles));
        }
        const r2 = await get('/api/sites');   // 第二次仍带(不是只在第一次写进缓存)
        let d2 = null; try { d2 = JSON.parse(r2.body); } catch (e) { }
        ok(d2 && d2.profiles && d2.profiles.rycj, 'vercel: 重复请求仍带档案');
    } finally {
        await new Promise((r) => server.close(r));
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

try { await liveVercel(); }
catch (e) { ok(false, 'vercel: 进程内启动失败', e && e.message); }

console.log(`site-profiles: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  ✗ ' + f); process.exit(1); }
process.exit(0);   // api/index.js 里可能有 setInterval 之类的句柄,显式退出
