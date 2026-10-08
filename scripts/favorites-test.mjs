// 收藏(追剧)+ 更新检查 + 大家都在看 回归:node scripts/favorites-test.mjs
//  ① 纯函数:parsePlayUrl(选 m3u8 那一路/空段/无集名)、vodStatus(完结判定)、parseDetail(BOM/垃圾)、normItem(瘦身/线路回退/海报)
//  ② lib/favorites 单元(SQLite 内存库 + 假时钟 + 本地假 maccms 站真 HTTP):增删/上限 100/seen/has_update/匿名 status/鉴权;
//     后台检查:每站每批 ≤20 id、全站每轮请求预算按站轮转、并发 ≤2、同站两批间隔、变化检测与推送(跳过已看/封禁)、
//     next_check(连载 4h/完结 72h/有变化 2h)、失败退避 1h→6h→24h、跟踪表两块容量(没人收藏的行 ≤ maxWatch − anonReserve,
//     匿名挤不掉任何行;服务器收藏用任何空位,表全满只挤 ≥24h 没人要的;洪水 flood/flood2/flood3、收藏/取消刷行 evict-anon)、
//     查无此片连续 2 次删行(只在同一回包有别的 id 时才记;整批一个都没回 = 站点抽风,按失败退避,blip;有人收藏的 24h 后再看)、
//     每 IP 新登记预算、14 天无人问的没人收藏行清理、通知闸门 notifyOk(可注入与接口鉴权不同的口径)、绝不请求任何 .m3u8
//  ③ lib/popular 单元:除调用者外 ≥2 个不同用户才上榜(匿名按"他也看过"算)、每人 <120s 不算、封禁用户不算、只算 vod、
//     只有 7 天窗口、按扣掉调用者后的人数/时长排序、上限 20、全站一份候选缓存、探测复现(review2/srvfix/pop-probe.js)
//  ④ 端到端:临时目录起真正的 server.js(CACHE_TYPE=sqlite),db.json 指向本地假 maccms 站,走真实 HTTP
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };   // worktree 没有 node_modules 时走 NODE_PATH
const Database = dep('better-sqlite3');
const { createFavorites, parsePlayUrl, vodStatus, parseDetail, normItem, favIdOf, DEF } = require(path.join(ROOT, 'lib/favorites'));
const { createPopular } = require(path.join(ROOT, 'lib/popular'));
const { createUserStats } = require(path.join(ROOT, 'lib/user-stats'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 600) : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HOUR = 3600e3, DAYMS = 86400e3;

// ---------------- 假 maccms 站 ----------------
// vods: "<站>|<id>" → { name, eps, remarks };vod_play_url 两路:第一路是网盘分享(不含 m3u8、集数多 5),第二路才是 m3u8(指回本服务器,
//   谁去拉它都会被记进 log —— 用来断言"绝不拉 m3u8")
function startMock() {
    const vods = new Map();
    const log = [];
    const failSites = new Set();     // 直连这些站 → 500(经代理 /proxy/?url= 的照常回)
    const slowSites = new Map();     // 直连这些站额外慢多少 ms(经代理不慢)
    const remote = { body: null, fail: false, hits: 0 };   // /remote/db.json:REMOTE_DB_URL 的假远程配置
    let active = 0, maxActive = 0, delay = 40, bom = true;
    const srv = http.createServer(async (req, res) => {
        let u = new URL(req.url, 'http://x');
        if (u.pathname === '/remote/db.json') {
            remote.hits++;
            if (remote.fail || !remote.body) { res.writeHead(500); return res.end('down'); }
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(remote.body));
        }
        // 假 CORS 代理:/proxy/?url=<真地址> → 按真地址的路径照常处理,记 proxied
        let proxied = false;
        if (u.pathname.startsWith('/proxy')) {
            proxied = true;
            try { u = new URL(u.searchParams.get('url') || ''); } catch (e) { res.writeHead(400); return res.end('bad'); }
        }
        const site = u.pathname.split('/')[1] || '';
        const ent = { site, proxied, path: u.pathname, ac: u.searchParams.get('ac'), ids: (u.searchParams.get('ids') || '').split(',').filter(Boolean), t0: Date.now(), t1: 0 };
        log.push(ent);
        active++; maxActive = Math.max(maxActive, active);
        await sleep(delay + (!proxied && slowSites.get(site) || 0));
        active--;
        ent.t1 = Date.now();
        if (ent.ac !== 'detail') { res.writeHead(404); return res.end('no'); }
        if (!proxied && failSites.has(site)) { res.writeHead(500); return res.end('boom'); }
        const list = [];
        for (const id of ent.ids) {
            const v = vods.get(site + '|' + id);
            if (!v) continue;
            const share = [], m3u = [];
            for (let i = 1; i <= v.eps + 5; i++) share.push(`第${String(i).padStart(2, '0')}集$https://pan.example/${id}/${i}`);
            for (let i = 1; i <= v.eps; i++) m3u.push(`第${String(i).padStart(2, '0')}集$http://127.0.0.1:${port}/m3u8/${site}/${id}/${i}/index.m3u8`);
            list.push({ vod_id: /^\d+$/.test(id) ? Number(id) : id, vod_name: v.name, vod_remarks: v.remarks || ('更新至' + v.eps + '集'),
                vod_play_from: 'share$$$m3u8', vod_play_url: share.join('#') + '$$$' + m3u.join('#') + '#', vod_content: 'x'.repeat(200) });
        }
        const body = JSON.stringify({ code: 1, msg: '数据列表', page: 1, pagecount: 1, limit: '20', total: list.length, list });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });   // 不少资源站就是这么回的(还带 BOM)
        res.end((bom ? '﻿' : '') + body);
    });
    let port = 0;
    return new Promise(r => srv.listen(0, '127.0.0.1', () => {
        port = srv.address().port;
        r({
            vods, log, failSites, slowSites, remote, srv, base: `http://127.0.0.1:${port}`, port,
            set: (site, id, eps, remarks, name) => vods.set(site + '|' + id, { eps, remarks, name: name || `${site}-${id}` }),
            reset: () => { log.length = 0; maxActive = 0; },
            get maxActive() { return maxActive; },
            setDelay: (ms) => { delay = ms; }, setBom: (b) => { bom = b; },
            close: () => new Promise(rr => srv.close(rr)),
        });
    }));
}
const fetchJson = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();   // 字符串(带 BOM):走模块自己的 parseDetail
};

// 假 app:收集路由,直接调 handler 链
function mkApp() {
    const routes = new Map();
    const reg = (m) => (p, ...hs) => { routes.set(m + ' ' + p, hs); };
    return { routes, get: reg('GET'), post: reg('POST') };
}
async function call(app, method, p, o) {
    o = o || {};
    const hs = app.routes.get(method + ' ' + p);
    if (!hs) throw new Error('no route ' + method + ' ' + p);
    const req = { method, body: o.body || {}, query: o.query || {}, headers: Object.assign({ 'x-ip': '1.1.1.1' }, o.headers || {}) };
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

// ---------------- ① 纯函数 ----------------
console.log('① 纯函数');
{
    let p = parsePlayUrl('第1集$a.m3u8#第2集$b.m3u8#第3集$c.m3u8');
    ok(p.ep_count === 3 && p.latest_ep === '第3集', '单路按 # 计集数', p);
    p = parsePlayUrl('第1集$https://pan/1#第2集$https://pan/2#第3集$https://pan/3$$$第1集$x/1.m3u8#第2集$x/2.M3U8');
    ok(p.ep_count === 2 && p.latest_ep === '第2集', '多路选第一条含 m3u8 的(大小写不敏感)', p);
    p = parsePlayUrl('第1集$https://pan/1#第2集$https://pan/2$$$第1集$https://pan2/1');
    ok(p.ep_count === 2, '都不含 m3u8 → 第一路', p);
    p = parsePlayUrl('第1集$a.m3u8#第2集$b.m3u8#');
    ok(p.ep_count === 2 && p.latest_ep === '第2集', '结尾多余的 # 不算一集', p);
    p = parsePlayUrl('https://x/movie.m3u8');
    ok(p.ep_count === 1 && p.latest_ep === '正片', '无集名 → 正片', p);
    ok(parsePlayUrl('').ep_count === 0 && parsePlayUrl(null).ep_count === 0 && parsePlayUrl(123).ep_count === 0, '空/非字符串 → 0 集');
    const big = parsePlayUrl(Array.from({ length: 3000 }, (_, i) => `第${i + 1}期$u${i}.m3u8`).join('#'));
    ok(big.ep_count === 3000 && big.latest_ep === '第3000期', '3000 集综艺', big);
    const fin = (r) => vodStatus({ vod_play_url: 'a$x.m3u8', vod_remarks: r }).finished;
    ok(fin('已完结') === 1 && fin('完结') === 1 && fin('全40集') === 1 && fin('全集') === 1 && fin('HD国语全36集') === 1, '完结判定');
    ok(fin('更新至10集') === 0 && fin('HD') === 0 && fin('') === 0 && fin(undefined) === 0, '连载判定');
    ok(vodStatus({ vod_remarks: 'x'.repeat(200) }).remarks.length === DEF.remarksMax, 'remarks 截断');
    ok(Array.isArray(parseDetail('﻿{"list":[{"vod_id":1}]}')) && parseDetail({ list: [] }).length === 0, 'parseDetail 认字符串(带 BOM)与对象');
    ok(parseDetail('<html>') === null && parseDetail({ code: 0 }) === null && parseDetail(null) === null && parseDetail('{"list":{}}') === null, 'parseDetail 不认识 → null(按失败退避)');
    const siteOk = (k) => k === 's1' || k === 's2';
    const srcs = Array.from({ length: 14 }, (_, i) => ({ site_key: i % 2 ? 's1' : 'kz_qsf', vod_id: String(100 + i), site_name: 'n' + i }));
    let it = normItem({ name: '  剧A  ', poster: 'javascript:alert(1)', workSig: 'y2024m', workLabel: '2024 剧集', checkSource: { site_key: 'kz_qsf', vod_id: '1' }, sources: srcs, addedEpCount: 12, extra: 'drop me', progress: 99 }, siteOk);
    ok(it && it.name === '剧A' && it.poster === '' && it.workSig === 'y2024m' && it.kind === 'vod' && it.addedEpCount === 12, 'normItem 基本字段/危险海报清空', it);
    ok(it.sources.length === 10 && !('extra' in it) && !('progress' in it), '线路最多 10 条、其它字段丢弃', it.sources.length);
    ok(it.checkSource && it.checkSource.site_key === 's1' && it.checkSource.vod_id === '101', '规则站不能查更新 → 回退第一条 maccms 线路', it.checkSource);
    it = normItem({ name: '剧B', poster: '/api/tmdb-image/w300/abc.jpg', checkSource: { site_key: 's2', vod_id: '7', site_name: '站2' } }, siteOk);
    ok(it.poster === '/api/tmdb-image/w300/abc.jpg' && it.checkSource.site_key === 's2' && it.addedEpCount === 0 && it.sources.length === 0, '相对海报保留、checkSource 直接用', it);
    it = normItem({ name: '剧C', checkSource: { site_key: 's1', vod_id: '1,2' }, sources: [{ site_key: 'nope', vod_id: '3' }, { site_key: 's1', vod_id: '../x' }] }, siteOk);
    ok(it.checkSource === null, '非法 vod_id / 未知站 → 没有检查线路', it.checkSource);
    ok(normItem({ name: '  ' }, siteOk) === null && normItem(null, siteOk) === null && normItem('x', siteOk) === null, '没有剧名 → 拒收');
    ok(favIdOf('剧A', '') === '剧A' && favIdOf('剧A', 'y1') === '剧A|w:y1', 'fav_id 口径');
}

// ---------------- ② lib/favorites 单元 ----------------
console.log('② lib/favorites 单元');
const M = await startMock();
const SITES = () => [
    { key: 's1', name: '站1', api: M.base + '/s1/api.php/provide/vod' },
    { key: 's2', name: '站2', api: M.base + '/s2/api.php/provide/vod' },
    { key: 's3', name: '站3', api: M.base + '/s3/api.php/provide/vod' },
    { key: 'kz_qsf', name: '七色番', api: '', kazumi: true },       // 规则站:没有 http api → 不能查更新
    { key: 'bad', name: '坏站', api: M.base + '/bad/x.m3u8' },      // api 指向 m3u8 的配置 → 一律不查
];
let NOW = Date.UTC(2026, 9, 8, 4, 0, 0);
const TK = { a: sha('alice'), b: sha('bob'), c: sha('carol'), d: sha('dave'), x: sha('banned') };
const validTokens = new Set(Object.values(TK));
const banned = new Set([TK.x]);
const pushes = [];
function mkFav(db, extra) {
    const app = mkApp();
    const fav = createFavorites(Object.assign({
        db: () => db, now: () => NOW,
        tokenOk: (t) => validTokens.has(t), isBanned: (t) => banned.has(t),
        adminAuthed: (req) => req.headers['x-admin-token'] === 'adm',
        ipKey: (req) => req.headers['x-ip'] || '0.0.0.0',
        sites: SITES, fetchJson,
        push: async (t, p) => { pushes.push({ t, p }); return { sent: 1 }; },
        opts: { siteGapMs: 150 }
    }, extra || {}));
    fav.registerRoutes(app);
    return { fav, app };
}
const W = (db, s, v) => db.prepare('SELECT * FROM fav_watch WHERE site_key = ? AND vod_id = ?').get(s, String(v));
const item = (name, site, vid, extra) => Object.assign({ name, poster: 'https://img.example/' + encodeURIComponent(name) + '.jpg', checkSource: site ? { site_key: site, vod_id: String(vid), site_name: site } : null, sources: site ? [{ site_key: site, vod_id: String(vid), site_name: site }] : [] }, extra || {});
try {
    // ---- 关闭/鉴权 ----
    {
        let dbOn = null;
        const { app } = mkFav(null, { db: () => dbOn });
        let r = await call(app, 'GET', '/api/favorites', { query: { token: TK.a } });
        ok(r.body && r.body.enabled === false && r.body.limit === 100 && r.body.items.length === 0, '没 SQLite → enabled:false', r.body);
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('x', 's1', 1) } });
        ok(r.body && r.body.ok === false && r.body.enabled === false, '没 SQLite → add enabled:false', r.body);
        r = await call(app, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: '1' }] } });
        ok(r.body && r.body.enabled === false && Object.keys(r.body.status).length === 0, '没 SQLite → status 空', r.body);
        ok(r.headers['Cache-Control'] === 'no-store', 'no-store');
    }
    const db = new Database(':memory:');
    const { fav, app } = mkFav(db);
    {
        let r = await call(app, 'GET', '/api/favorites', { query: {} });
        ok(r.statusCode === 401, '无 token → 401', r.statusCode);
        r = await call(app, 'GET', '/api/favorites', { query: { token: 'constructor' } });
        ok(r.statusCode === 401, '原型键 token → 401', r.statusCode);
        r = await call(app, 'GET', '/api/favorites', { query: { token: TK.x } });
        ok(r.statusCode === 403 && r.body.banned === true, '封禁 → 403', r.body);
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.x, item: item('x', 's1', 1) } });
        ok(r.statusCode === 403, '封禁不能加', r.statusCode);
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: ['a'], item: item('x', 's1', 1) } });
        ok(r.statusCode === 401, '数组 token → 401', r.statusCode);
    }

    // ---- 增删改查 ----
    M.set('s1', '101', 12, '更新至12集', '剧A');
    for (let i = 102; i <= 145; i++) M.set('s1', String(i), 20 + i % 7);
    M.set('s2', '201', 5, '更新至5集', '剧B');
    M.set('s2', '202', 8);
    M.set('s2', '203', 9);
    M.set('s3', '301', 36, '已完结');
    {
        let r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('剧A', 's1', 101, { workSig: 'y2024m', workLabel: '2024 剧集', addedEpCount: 10 }) } });
        ok(r.body && r.body.ok === true && r.body.fav_id === '剧A|w:y2024m', '加收藏 → fav_id 带 workSig', r.body);
        NOW += 1000;
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('剧Z', 'kz_qsf', 9, { sources: [{ site_key: 'kz_qsf', vod_id: '9' }, { site_key: 's2', vod_id: '202', site_name: '站2' }] }) } });
        ok(r.body && r.body.ok === true && r.body.fav_id === '剧Z', '番剧线路收藏', r.body);
        const z = db.prepare("SELECT check_site, check_vid FROM user_favorites WHERE fav_id = '剧Z'").get();
        ok(z.check_site === 's2' && z.check_vid === '202', '番剧线路不能查更新 → 改用 maccms 线路', z);
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.a, item: { poster: 'x' } } });
        ok(r.statusCode === 400 && r.body.error === 'item', '没剧名 → 400', r.body);
        NOW += 1000;
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.b, item: item('剧B', 's2', 201) } });   // 没给 addedEpCount
        ok(r.body.ok === true, 'bob 加剧B');
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.c, item: item('剧B', 's2', 201, { addedEpCount: 7 }) } });
        ok(r.body.ok === true, 'carol 加剧B(已看 7 集)');
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.d, item: item('剧B', 's2', 201, { addedEpCount: 1 }) } });
        ok(r.body.ok === true, 'dave 加剧B(之后被封禁)');
        r = await call(app, 'GET', '/api/favorites', { query: { token: TK.a } });
        const L = r.body;
        ok(L.enabled === true && L.limit === 100 && L.items.length === 2 && L.items[0].fav_id === '剧Z' && L.items[1].fav_id === '剧A|w:y2024m', '按 added_at 降序', L.items && L.items.map(x => x.fav_id));
        const A = L.items[1];
        ok(A.status === null && A.has_update === false && A.seen_count === 10 && A.data.name === '剧A' && A.data.checkSource.vod_id === '101' && A.data.workLabel === '2024 剧集', '未检查前 status=null', A);
        // 重复添加 = 更新 data,added_at 不变,seen 取大
        const before = db.prepare("SELECT added_at FROM user_favorites WHERE user_token = ? AND fav_id = '剧A|w:y2024m'").get(TK.a).added_at;
        NOW += 1000;
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('剧A', 's1', 101, { workSig: 'y2024m', poster: 'https://img.example/new.jpg', addedEpCount: 3 }) } });
        const rowA = db.prepare("SELECT * FROM user_favorites WHERE user_token = ? AND fav_id = '剧A|w:y2024m'").get(TK.a);
        ok(r.body.ok && rowA.added_at === before && JSON.parse(rowA.data).poster === 'https://img.example/new.jpg' && rowA.seen_count === 10, '重复添加更新 data,added_at 不变,seen 不倒退', rowA);
        ok(db.prepare('SELECT COUNT(*) n FROM user_favorites WHERE user_token = ?').get(TK.a).n === 2, '重复添加不新增行');
        // 换了检查线路:已看集数按新线路重来(各站集数不一样)
        await call(app, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('剧A', 's2', 203, { workSig: 'y2024m', addedEpCount: 4 }) } });
        const sw = db.prepare("SELECT seen_count, check_site FROM user_favorites WHERE user_token = ? AND fav_id = '剧A|w:y2024m'").get(TK.a);
        ok(sw.check_site === 's2' && sw.seen_count === 4, '换线路 → seen 按新线路', sw);
        await call(app, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('剧A', 's1', 101, { workSig: 'y2024m', poster: 'https://img.example/new.jpg', addedEpCount: 10 }) } });
        ok(db.prepare("SELECT seen_count FROM user_favorites WHERE user_token = ? AND fav_id = '剧A|w:y2024m'").get(TK.a).seen_count === 10, '换回来');
        // 上限 100(没检查线路的收藏不登记跟踪表)
        for (let i = 0; i < 100; i++) {
            r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.c, item: item('满' + i, null) } });
            if (!(r.body && r.body.ok)) break;
        }
        ok(r.body && r.body.ok === false && r.body.error === 'limit' && r.body.limit === 100, '第 101 部 → limit', r.body);
        ok(db.prepare('SELECT COUNT(*) n FROM user_favorites WHERE user_token = ?').get(TK.c).n === 100, '正好 100 部');
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.c, item: item('满5', null, null, { poster: '/p.jpg' }) } });
        ok(r.body.ok === true, '满了仍可更新已有的', r.body);
        r = await call(app, 'POST', '/api/favorites/remove', { body: { token: TK.c, fav_id: '满0' } });
        ok(r.body.ok === true && r.body.removed === 1, '删除', r.body);
        r = await call(app, 'POST', '/api/favorites/remove', { body: { token: TK.c, fav_id: '满0' } });
        ok(r.body.ok === true && r.body.removed === 0, '重复删除 removed:0', r.body);
        r = await call(app, 'POST', '/api/favorites/add', { body: { token: TK.c, item: item('满新', null) } });
        ok(r.body.ok === true, '删一部后又能加', r.body);
        r = await call(app, 'POST', '/api/favorites/remove', { body: { token: TK.c } });
        ok(r.statusCode === 400, '缺 fav_id → 400', r.statusCode);
        r = await call(app, 'POST', '/api/favorites/remove', { body: { token: TK.b, fav_id: '满1' } });
        ok(r.body.removed === 0 && db.prepare("SELECT COUNT(*) n FROM user_favorites WHERE fav_id = '满1'").get().n === 1, '删不到别人的');
    }

    // ---- 匿名 status 登记 ----
    {
        const items = [];
        for (let i = 102; i <= 145; i++) items.push({ site_key: 's1', vod_id: String(i) });
        items.push({ site_key: 's2', vod_id: 203 }, { site_key: 's3', vod_id: '301' }, { site_key: 's3', vod_id: '301' });
        items.push({ site_key: 'nope', vod_id: '1' }, { site_key: 'kz_qsf', vod_id: '1' }, { site_key: 's1', vod_id: '1,2' }, { site_key: 's1', vod_id: '../x' },
            { site_key: 'bad', vod_id: '5' }, { site_key: 's1' }, null, 'x', { site_key: '__proto__', vod_id: '1' }, { site_key: 's1', vod_id: 'a'.repeat(65) });
        const r = await call(app, 'POST', '/api/favorites/status', { body: { items }, headers: { 'x-ip': '9.9.9.9' } });
        ok(r.body && r.body.enabled === true && Object.keys(r.body.status).length === 0, '还没检查过 → 空', r.body);
        ok(Object.getPrototypeOf(r.body.status) === null, 'status 表无原型');
        const n = db.prepare('SELECT COUNT(*) n FROM fav_watch').get().n;
        // 44(s1 102..145)+ s2/203 + s3/301 + 收藏登记的 s1/101、s2/201、s2/202 = 49
        ok(n === 49, '只登记合法的、去重', n);
        ok(!W(db, 'nope', 1) && !W(db, 'kz_qsf', 1) && !W(db, 'bad', 5), '未知站/规则站/m3u8 api 不登记');
        const big = await call(app, 'POST', '/api/favorites/status', { body: { items: Array.from({ length: 150 }, (_, i) => ({ site_key: 's1', vod_id: String(102 + (i % 44)) })) } });
        ok(big.body.enabled === true, '超过 100 条只看前 100');
        ok((await call(app, 'POST', '/api/favorites/status', { body: { items: 'x' } })).body.enabled === true, 'items 非数组不报错');
    }

    // ---- 第一轮检查 ----
    banned.add(TK.d);
    M.reset();
    let sum = await fav.runRound();
    ok(sum.due === 49 && sum.requests === 5 && sum.checked === 49 && sum.failed === 0 && sum.changed === 0, '第一轮:49 个到期 → 5 个请求(s1 3 批 + s2 1 + s3 1)', sum);
    {
        const det = M.log.filter(x => x.ac === 'detail');
        ok(det.length === 5 && M.log.length === 5, '只发了详情请求', M.log.map(x => x.path + ' ' + x.ac));
        ok(det.every(x => x.ids.length >= 1 && x.ids.length <= 20), '每批 ≤20 个 id', det.map(x => x.ids.length));
        ok(!M.log.some(x => /m3u8/i.test(x.path)), '没有任何 m3u8 请求');
        ok(det.filter(x => x.site === 's1').map(x => x.ids.length).sort((a, b) => a - b).join() === '5,20,20', 's1 切成 20/20/5', det.filter(x => x.site === 's1').map(x => x.ids.length));
        const s1 = det.filter(x => x.site === 's1').sort((a, b) => a.t0 - b.t0);
        ok(s1[1].t0 - s1[0].t1 >= 140 && s1[2].t0 - s1[1].t1 >= 140, '同一站两批间隔 ≥ siteGapMs', s1.map(x => [x.t0, x.t1]));
        ok(M.maxActive <= 2, '并发 ≤2', M.maxActive);
        const a = W(db, 's1', 101);
        ok(a.ep_count === 12 && a.latest_ep === '第12集' && a.remarks === '更新至12集' && a.finished === 0 && a.checked_at === NOW && a.changed_at === null && a.fails === 0, '选 m3u8 那一路计集数(分享路多 5 集、结尾 # 不算)', a);
        ok(a.next_check === NOW + 4 * HOUR, '连载没变化 → 4h', a.next_check - NOW);
        const f = W(db, 's3', 301);
        ok(f.finished === 1 && f.next_check === NOW + 72 * HOUR, '完结 → 72h', f);
        ok(pushes.length === 0, '第一次检查(基线)不推送', pushes);
        // has_update / 基线
        let r = await call(app, 'GET', '/api/favorites', { query: { token: TK.a } });
        const A = r.body.items.find(x => x.fav_id === '剧A|w:y2024m');
        ok(A.status && A.status.ep_count === 12 && A.status.latest_ep === '第12集' && A.status.finished === false && A.status.checked_at === NOW && A.has_update === true && A.seen_count === 10, '收藏时看到 10 集、现在 12 集 → has_update', A);
        r = await call(app, 'GET', '/api/favorites', { query: { token: TK.b } });
        const B = r.body.items[0];
        ok(B.seen_count === 5 && B.has_update === false, '没给集数的收藏以第一次检查为基线(不误报红点)', B);
        // seen
        r = await call(app, 'POST', '/api/favorites/seen', { body: { token: TK.a, fav_id: '剧A|w:y2024m', count: 11 } });
        ok(r.body.ok && r.body.seen_count === 11, 'seen 11', r.body);
        r = await call(app, 'POST', '/api/favorites/seen', { body: { token: TK.a, fav_id: '剧A|w:y2024m', count: 3 } });
        ok(r.body.ok && r.body.seen_count === 11, 'seen 不倒退', r.body);
        r = await call(app, 'POST', '/api/favorites/seen', { body: { token: TK.a, fav_id: '剧A|w:y2024m' } });
        ok(r.body.ok && r.body.seen_count === 12, '不给 count → 设为当前集数', r.body);
        r = await call(app, 'POST', '/api/favorites/seen', { body: { token: TK.a, fav_id: '剧A|w:y2024m', count: 'abc' } });
        ok(r.body.ok && r.body.seen_count === 12, '非法 count 同不给', r.body);
        r = await call(app, 'POST', '/api/favorites/seen', { body: { token: TK.a, fav_id: '没有' } });
        ok(r.body.ok === false && r.body.error === 'not_found', 'seen 不存在的', r.body);
        r = await call(app, 'GET', '/api/favorites', { query: { token: TK.a } });
        ok(r.body.items.find(x => x.fav_id === '剧A|w:y2024m').has_update === false, '清红点');
        // 已检查过的 → 匿名 status 返回
        r = await call(app, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: '102' }, { site_key: 's3', vod_id: '301' }, { site_key: 's2', vod_id: '999' }] } });
        const st = r.body.status;
        ok(st['s1|102'] && st['s1|102'].ep_count === 20 + 102 % 7 && st['s3|301'].finished === true && !('checked_at' in st['s3|301']) && !st['s2|999'], '匿名 status 返回已知状态', st);
        ok(W(db, 's2', 999) && W(db, 's2', 999).ep_count === null && W(db, 's2', 999).next_check === NOW, '新登记的下一轮就查');
        db.prepare("DELETE FROM fav_watch WHERE site_key = 's2' AND vod_id = '999'").run();
    }
    // 同一时刻再跑:没有到期的
    M.reset();
    sum = await fav.runRound();
    ok(sum.due === 0 && sum.requests === 0 && M.log.length === 0, '没到期不请求', sum);

    // ---- 集数变多 → 推送 ----
    NOW += 4 * HOUR + 1;
    M.set('s2', '201', 7, '更新至7集', '剧B');
    M.reset(); pushes.length = 0;
    sum = await fav.runRound();
    ok(sum.due === 48 && sum.requests === 4 && sum.changed === 1, '4h 后连载的都到期(完结的不到期)', sum);
    {
        const b = W(db, 's2', 201);
        ok(b.ep_count === 7 && b.changed_at === NOW && b.next_check === NOW + 2 * HOUR, '有变化 → changed_at=now、2h 后再查', b);
        ok(W(db, 's2', 203).next_check === NOW + 4 * HOUR, '没变化的 → 4h');
        ok(pushes.length === 1 && pushes[0].t === TK.b, '只推给没看过新集的(carol 已看 7 集、dave 被封)', pushes.map(x => x.t.slice(0, 6)));
        const p = pushes[0] && pushes[0].p;
        ok(p && p.title === '《剧B》更新了' && p.body === '更新至 第07集' && p.tag === 'fav:剧B' && p.url === '/?play=' + encodeURIComponent('剧B') + '&ep=' + encodeURIComponent('第07集'), '推送内容', p);
        ok(sum.pushed === 1, 'pushed 计数', sum.pushed);
        const r = await call(app, 'GET', '/api/favorites', { query: { token: TK.b } });
        ok(r.body.items[0].has_update === true && r.body.items[0].status.changed_at === NOW, 'bob 看到红点', r.body.items[0]);
    }
    // workSig 带进推送地址
    {
        db.prepare("UPDATE user_favorites SET seen_count = 0 WHERE user_token = ? AND fav_id = '剧A|w:y2024m'").run(TK.a);
        db.prepare("UPDATE fav_watch SET next_check = 0 WHERE site_key = 's1' AND vod_id = '101'").run();
        M.set('s1', '101', 13, '更新至13集', '剧A');
        pushes.length = 0;
        await fav.runRound();
        ok(pushes.length === 1 && pushes[0].p.url.endsWith('&w=y2024m') && pushes[0].p.tag === 'fav:剧A|w:y2024m', '同名拆卡:url 带 w=', pushes[0] && pushes[0].p);
    }
    // 名字/备注变了但集数没变:不推送、2h 后再查
    {
        db.prepare("UPDATE fav_watch SET next_check = 0 WHERE site_key = 's2' AND vod_id = '202'").run();
        M.set('s2', '202', 8, 'HD中字');
        pushes.length = 0;
        sum = await fav.runRound();
        const r = W(db, 's2', 202);
        ok(pushes.length === 0 && sum.changed === 0 && r.remarks === 'HD中字' && r.next_check === NOW + 2 * HOUR && r.changed_at === null, '只有备注变 → 不推送、2h', r);
    }

    // ---- 失败退避 ----
    {
        const s2 = () => W(db, 's2', 203);
        M.failSites.add('s2');
        db.prepare("UPDATE fav_watch SET next_check = 0 WHERE site_key = 's2'").run();
        sum = await fav.runRound();
        ok(s2().fails === 1 && s2().next_check === NOW + HOUR && sum.failed === 3, '失败 1 次 → 1h', [s2(), sum]);
        NOW += HOUR + 1;
        sum = await fav.runRound();
        ok(s2().fails === 2 && s2().next_check === NOW + 6 * HOUR, '失败 2 次 → 6h', s2());
        NOW += 6 * HOUR + 1;
        sum = await fav.runRound();
        ok(s2().fails === 3 && s2().next_check === NOW + 24 * HOUR, '失败 3 次 → 24h', s2());
        NOW += 24 * HOUR + 1;
        sum = await fav.runRound();
        ok(s2().fails === 4 && s2().next_check === NOW + 24 * HOUR, '再失败仍 24h', s2());
        ok(W(db, 's2', 201).ep_count === 7 && W(db, 's2', 201).latest_ep === '第07集', '失败不清掉已知状态');
        M.failSites.delete('s2');
        M.vods.delete('s2|203');   // 下架
        NOW += 24 * HOUR + 1;
        sum = await fav.runRound();
        ok(W(db, 's2', 201).fails === 0 && W(db, 's2', 201).next_check === NOW + 4 * HOUR, '恢复 → fails 清零', W(db, 's2', 201));
        ok(s2().fails === 5 && s2().next_check === NOW + 24 * HOUR, '片子在站上没了 → 按失败退避', s2());
        // 超时也算失败(假站慢于超时)
        const slow = mkFav(db, { opts: { siteGapMs: 10, timeoutMs: 50 }, fetchJson: async (url, key, t) => { const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), t); try { const r = await fetch(url, { signal: ac.signal }); return await r.text(); } finally { clearTimeout(tm); } } });
        M.setDelay(200);
        db.prepare("UPDATE fav_watch SET next_check = 0, fails = 0 WHERE site_key = 's3'").run();
        await slow.fav.runRound();
        ok(W(db, 's3', 301).fails === 1 && W(db, 's3', 301).next_check === NOW + HOUR, '超时 → 失败退避', W(db, 's3', 301));
        M.setDelay(40);
    }
    // ---- 站点从配置里删了 ----
    {
        const gone = mkFav(db, { sites: () => SITES().filter(s => s.key !== 's3') });
        db.prepare("UPDATE fav_watch SET next_check = 0 WHERE site_key = 's3'").run();
        M.reset();
        const s = await gone.fav.runRound();
        ok(s.skipped === 1 && W(db, 's3', 301).next_check === NOW + 24 * HOUR && !M.log.some(x => x.site === 's3'), '站点不在配置里 → 不请求、一天后再看', s);
    }
    // ---- 删除收藏后不再推送 ----
    {
        let r = await call(app, 'POST', '/api/favorites/remove', { body: { token: TK.b, fav_id: '剧B' } });
        ok(r.body.removed === 1, 'bob 删剧B');
        db.prepare("UPDATE fav_watch SET next_check = 0 WHERE site_key = 's2' AND vod_id = '201'").run();
        db.prepare("UPDATE user_favorites SET seen_count = 0 WHERE fav_id = '剧B'").run();
        M.set('s2', '201', 9, '更新至9集', '剧B');
        pushes.length = 0;
        await fav.runRound();
        ok(pushes.length === 1 && pushes[0].t === TK.c, '只剩 carol 收到(dave 封禁、bob 已删)', pushes.map(x => x.t.slice(0, 6)));
    }
    // ---- 推送抛错不影响检查 ----
    {
        const bad = mkFav(db, { push: async () => { throw new Error('push down'); } });
        db.prepare("UPDATE fav_watch SET next_check = 0 WHERE site_key = 's2' AND vod_id = '201'").run();
        M.set('s2', '201', 10);
        const s = await bad.fav.runRound();
        ok(s.changed === 1 && W(db, 's2', 201).ep_count === 10, '推送失败吞掉', s);
    }
    // ---- 管理员手动跑一轮 / 定时器 ----
    {
        let r = await call(app, 'POST', '/api/admin/favorites/check', {});
        ok(r.statusCode === 403, '非站长 403');
        r = await call(app, 'POST', '/api/admin/favorites/check', { headers: { 'x-admin-token': 'adm' } });
        ok(r.body && r.body.ok === true && typeof r.body.due === 'number', '站长手动检查', r.body);
        const [p1, p2] = [fav.runRound(), fav.runRound()];
        ok(p1 === p2, '同时只跑一轮(共用同一个 promise)');
        await p1;
        const off = mkFav(db, { checkEnabled: () => false });
        r = await call(off.app, 'POST', '/api/admin/favorites/check', { headers: { 'x-admin-token': 'adm' } });
        ok(r.body && r.body.ok === false && r.body.error === 'disabled', 'FAV_CHECK_DISABLE → 手动也不跑', r.body);
        off.fav.start(); fav.start();
        await sleep(20);
        ok(off.fav._armed() === false && fav._armed() === true, '定时器只在开关打开时启动');
        fav.stop();
        ok(fav._armed() === false, 'stop 清定时器');
    }
    db.close();

    // ---- 每轮请求预算按站轮转 ----
    {
        const db2 = new Database(':memory:');
        const { fav: f2, app: a2 } = mkFav(db2, { opts: { siteGapMs: 10, maxReqPerRound: 3, batchIds: 2 } });
        const items = [];
        for (let i = 1; i <= 6; i++) { M.set('s1', 'p' + i, 3); items.push({ site_key: 's1', vod_id: 'p' + i }); }
        for (let i = 1; i <= 4; i++) { M.set('s2', 'p' + i, 3); items.push({ site_key: 's2', vod_id: 'p' + i }); }
        for (let i = 1; i <= 2; i++) { M.set('s3', 'p' + i, 3); items.push({ site_key: 's3', vod_id: 'p' + i }); }
        await call(a2, 'POST', '/api/favorites/status', { body: { items } });
        M.reset();
        let s = await f2.runRound();
        const by = (k) => M.log.filter(x => x.site === k).length;
        ok(s.due === 12 && s.requests === 3 && by('s1') === 1 && by('s2') === 1 && by('s3') === 1, '预算 3 → 三个站各一批(大站不饿死小站)', [s, by('s1'), by('s2'), by('s3')]);
        ok(M.log.every(x => x.ids.length <= 2), 'batchIds 生效');
        M.reset();
        s = await f2.runRound();
        ok(s.due === 6 && s.requests === 3 && db2.prepare('SELECT COUNT(*) n FROM fav_watch WHERE checked_at IS NULL').get().n === 0, '剩下的下一轮查完', s);
        db2.close();
    }
    // ---- 跟踪表两块容量(V4):没人收藏的行最多 maxWatch − anonReserve,到了就不再接受匿名新登记;服务器收藏可用任何空位;
    //      表全满时服务器收藏只能挤"没人收藏、且 ≥24h 没人要"的行里最久没人要的;有人收藏的永不挤 ----
    //      (上一轮:表满时服务器收藏挤掉最久没人要的,不管它多近被要过 → 任何令牌反复 收藏/取消 就能把本机收藏用户的行一行行挤掉)
    {
        const db3 = new Database(':memory:');
        const { fav: f3, app: a3 } = mkFav(db3, { opts: { maxWatch: 10, anonReserve: 4, newPerIpHour: 1000 } });
        for (const v of ['r1', 'r2', 'r3']) {
            await call(a3, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('剧' + v, 's1', v) } });
            NOW += 1000;
        }
        for (let i = 0; i < 12; i++) {
            await call(a3, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'n' + i }] } });
            NOW += 1000;
        }
        const keysOf = () => db3.prepare('SELECT vod_id FROM fav_watch ORDER BY vod_id').all().map(r => r.vod_id);
        const cnt = () => db3.prepare('SELECT COUNT(*) n FROM fav_watch').get().n;
        let keys = keysOf();
        ok(keys.join() === 'n0,n1,n2,n3,n4,n5,r1,r2,r3', '没人收藏的行停在 maxWatch − anonReserve = 6;表没满(预留的空位不给匿名)', keys);
        let st = await call(a3, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'n0' }, { site_key: 's1', vod_id: 'n11' }] } });
        ok(st.body.enabled === true && Object.keys(st.body.status).length === 0 && !W(db3, 's1', 'n11'), '没跟踪的 → 状态未知(不报错)', st.body);
        // 有空位:服务器收藏直接登记,一行不挤
        NOW += 1000;
        let r = await call(a3, 'POST', '/api/favorites/add', { body: { token: TK.b, item: item('剧s1', 's1', 's1v') } });
        ok(r.body.ok === true && keysOf().join() === 'n0,n1,n2,n3,n4,n5,r1,r2,r3,s1v', '预留空位:服务器收藏直接登记,匿名行一行不动', keysOf());
        // 表全满,没人收藏的行都是 24h 内有人要过的 → 新收藏照常成功但先不跟踪,一行不删(上一轮:挤掉十几秒前刚被问过的 n1)
        NOW += 1000;
        r = await call(a3, 'POST', '/api/favorites/add', { body: { token: TK.b, item: item('剧s2', 's1', 's2v') } });
        ok(r.body.ok === true && !W(db3, 's1', 's2v') && keysOf().join() === 'n0,n1,n2,n3,n4,n5,r1,r2,r3,s1v', '表满且没人收藏的行都在 24h 内被要过 → 收藏成功、先不跟踪、一行不删', keysOf());
        await call(a3, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'n7' }] } });
        ok(!W(db3, 's1', 'n7') && cnt() === 10, '匿名新登记仍然挤不掉任何行');
        // 24h 后:n0 刚被续期,n1..n5 已 ≥24h 没人要 → GET 列表补登 s2v,挤掉最久没人要的 n1
        NOW += 24 * HOUR;
        await call(a3, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'n0' }] } });
        NOW += 1000;
        r = await call(a3, 'GET', '/api/favorites', { query: { token: TK.b } });
        keys = keysOf();
        ok(keys.join() === 'n0,n2,n3,n4,n5,r1,r2,r3,s1v,s2v', '≥24h 没人要的才让位:列表补登挤掉 n1,刚续期的 n0 留着', keys);
        // 再收藏 s3v..s6v:依次挤掉 n2..n5;n0 24h 内被要过 → s7v 先不跟踪
        for (let i = 3; i <= 6; i++) { NOW += 1000; await call(a3, 'POST', '/api/favorites/add', { body: { token: TK.b, item: item('剧s' + i, 's1', 's' + i + 'v') } }); }
        keys = keysOf();
        ok(keys.join() === 'n0,r1,r2,r3,s1v,s2v,s3v,s4v,s5v,s6v', '按最久没人要依次让位(都 ≥24h);有人收藏的 r* 一行没动', keys);
        NOW += 1000;
        r = await call(a3, 'POST', '/api/favorites/add', { body: { token: TK.b, item: item('剧s7', 's1', 's7v') } });
        ok(r.body.ok === true && !W(db3, 's1', 's7v') && keysOf().join() === keys.join(), 'n0 24h 内被要过 → 新收藏成功但不跟踪,一行不删', r.body);
        // n0 也 ≥24h 没人要了 → 重新收藏 s7(= 更新)时挤掉它;之后表里全是被收藏引用的行 → 再收藏只能不跟踪
        NOW += 24 * HOUR;
        await call(a3, 'POST', '/api/favorites/add', { body: { token: TK.b, item: item('剧s7', 's1', 's7v') } });
        keys = keysOf();
        ok(keys.join() === 'r1,r2,r3,s1v,s2v,s3v,s4v,s5v,s6v,s7v', 'n0 ≥24h 没人要 → 让位给 s7v', keys);
        r = await call(a3, 'POST', '/api/favorites/add', { body: { token: TK.b, item: item('剧s8', 's1', 's8v') } });
        ok(r.body.ok === true && !W(db3, 's1', 's8v') && keysOf().join() === keys.join(), '全是被引用的行 → 新收藏成功但不跟踪,一行不删', r.body);
        // 被删掉的收藏行(以前的版本淘汰掉的等):用户 GET 列表时补登回来
        db3.prepare("DELETE FROM fav_watch WHERE vod_id = 'r2'").run();
        r = await call(a3, 'GET', '/api/favorites', { query: { token: TK.a } });
        ok(W(db3, 's1', 'r2') && r.body.items.length === 3 && cnt() === 10, 'GET 列表补登缺失的收藏行(不超上限)', r.body.items.length);
        // 取消收藏:服务器收藏登记的行没人再收藏 → 立刻删(不留孤行占预留,见 dropFavOrphan)
        await call(a3, 'POST', '/api/favorites/remove', { body: { token: TK.b, fav_id: '剧s7' } });
        ok(!W(db3, 's1', 's7v') && cnt() === 9, '取消收藏:s7v 没人收藏了 → 行直接删掉', keysOf());
        db3.prepare("DELETE FROM fav_watch WHERE vod_id = 'r3'").run();
        NOW += 1000;
        await call(a3, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'n9' }, { site_key: 's1', vod_id: 'n10' }] } });   // 匿名占掉空位 → 表又满
        ok(cnt() === 10 && W(db3, 's1', 'n9') && W(db3, 's1', 'n10'), '匿名补满空位(没人收藏的才 2 行,远没到 6)');
        NOW += 5 * 60e3 + 1;   // 列表续期/补登每 token 5 分钟一次
        r = await call(a3, 'GET', '/api/favorites', { query: { token: TK.a } });
        ok(!W(db3, 's1', 'r3') && W(db3, 's1', 'n9') && W(db3, 's1', 'n10'), 'n9/n10 都是 24h 内的匿名行 → 补登先不成功,一行不删', keysOf());
        NOW += 24 * HOUR;
        await call(a3, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'n9' }] } });   // n9 的主人回来了
        r = await call(a3, 'GET', '/api/favorites', { query: { token: TK.a } });
        keys = keysOf();
        ok(keys.includes('r3') && !keys.includes('n10') && keys.includes('n9') && cnt() === 10, '24h 后补登:挤掉没人要的 n10,刚被问过的 n9 留着', keys);
        // 没人收藏的行 14 天没人问 → 清(以前 30 天);有人收藏的保留
        NOW += 13 * DAYMS;
        await f3.runRound();
        ok(!!W(db3, 's1', 'n9'), '13 天没人问:还留着');
        NOW += DAYMS + 1;
        await f3.runRound();
        keys = keysOf();
        ok(keys.join() === 'r1,r2,r3,s1v,s2v,s3v,s4v,s5v,s6v', '14 天没人问的没人收藏行被清理,收藏的保留', keys);
        db3.close();
    }
    // ---- 没人收藏的行 14 天没人问就清(V4,以前 30 天);有人收藏的永远不清 ----
    {
        const dbp = new Database(':memory:');
        const { fav: fp, app: ap } = mkFav(dbp, { fetchJson: async () => ({ list: [] }), sleep: async () => { } });
        await call(ap, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'old1' }, { site_key: 's1', vod_id: 'old2' }] } });
        await call(ap, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('留着剧', 's1', 'keep1') } });
        NOW += 13 * DAYMS;
        await call(ap, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'old2' }] } });   // old2 13 天后又被问了一次
        NOW += DAYMS + 1;
        await fp.runRound();
        ok(!W(dbp, 's1', 'old1') && !!W(dbp, 's1', 'old2') && !!W(dbp, 's1', 'keep1'), '14 天没人问的没人收藏行被清(old1);1 天前被问过的(old2)、有人收藏的(keep1)留着',
            dbp.prepare('SELECT vod_id FROM fav_watch ORDER BY vod_id').all().map(x => x.vod_id));
        dbp.close();
    }
    // ---- 收藏/取消 反复刷,挤不掉本机收藏用户的行(review3/evict-anon.js,V4) ----
    //   上一轮:任何令牌持有者每 收藏一次再取消 就挤掉一行几分钟前刚被本机收藏用户问过的行,被挤的用户在表满时永远登记不回来
    {
        const dbe = new Database(':memory:');
        const fetchAll = async (url) => { const ids = decodeURIComponent(url.split('ids=')[1]).split(','); return { list: ids.map(id => ({ vod_id: id, vod_play_url: '第1集$a.m3u8#第2集$b.m3u8', vod_remarks: '更新至2集' })) }; };
        const { fav: fe, app: ae } = mkFav(dbe, { fetchJson: fetchAll, sleep: async () => { }, opts: { siteGapMs: 0 } });
        const n = (w) => dbe.prepare('SELECT COUNT(*) n FROM fav_watch' + (w ? ' WHERE ' + w : '')).get().n;
        const LEGIT = 'CAST(vod_id AS INT) BETWEEN 500 AND 799';
        const legitItems = (u) => Array.from({ length: 10 }, (_, i) => ({ site_key: 's1', vod_id: String(500 + u * 10 + i) }));
        // 30 个本机收藏用户(没开同步),各 10 部,都登记并查过
        for (let u = 0; u < 30; u++) await call(ae, 'POST', '/api/favorites/status', { body: { items: legitItems(u) }, headers: { 'x-ip': '203.0.113.' + u } });
        await fe.runRound();
        // 攻击者从一个 IP 按预算灌真实存在的 id(maccms id 是连续整数),直到不再接受
        let id = 20000, prev = -1;
        while (n() !== prev) { prev = n(); await call(ae, 'POST', '/api/favorites/status', { body: { items: Array.from({ length: 100 }, () => ({ site_key: 's1', vod_id: String(id++) })) }, headers: { 'x-ip': '198.51.100.1' } }); NOW += 20 * 60e3; }
        ok(n() === DEF.maxWatch - DEF.anonReserve && n(LEGIT) === 300, 'evict-anon:匿名登记(本机收藏 + 灌进来的)最多占 maxWatch − anonReserve = 2000 行', [n(), n(LEGIT)]);
        for (let k = 0; k < 5; k++) await fe.runRound();
        // 本机收藏用户 2 小时前来过;攻击者现在把灌进来的免费续期一遍
        for (let u = 0; u < 30; u++) await call(ae, 'POST', '/api/favorites/status', { body: { items: legitItems(u) }, headers: { 'x-ip': '203.0.113.' + u } });
        NOW += 2 * HOUR;
        for (let s = 20000; s < id; s += 100) await call(ae, 'POST', '/api/favorites/status', { body: { items: Array.from({ length: 100 }, (_, i) => ({ site_key: 's1', vod_id: String(s + i) })) }, headers: { 'x-ip': '198.51.100.1' } });
        const EV = [sha('evil0'), sha('evil1'), sha('evil2'), sha('evil3')];
        EV.forEach(t => validTokens.add(t));
        const churn = async (tk, from, count) => {
            for (let i = 0; i < count; i++) {
                const v = String(from + i);
                await call(ae, 'POST', '/api/favorites/add', { body: { token: tk, item: item('x' + v, 's1', v) } });
                await call(ae, 'POST', '/api/favorites/remove', { body: { token: tk, fav_id: 'x' + v } });
            }
        };
        // 一个令牌 收藏 → 取消 来回 300 次(正好用完它每小时的新登记预算)
        await churn(EV[0], 90000, 300);
        ok(n(LEGIT) === 300 && n() === DEF.maxWatch - DEF.anonReserve, 'evict-anon:300 次 收藏/取消 之后本机收藏用户的 300 行一行不少(上一轮:0),取消的收藏不留孤行', [n(), n(LEGIT)]);
        // 再换 3 个令牌各刷 300 次:每次取消都把那行删掉 → 预留一行都占不住(第三轮:刷满 3000 后所有新收藏都登记不上)
        await churn(EV[1], 91000, 300); await churn(EV[2], 92000, 300); await churn(EV[3], 93000, 300);
        ok(n() === DEF.maxWatch - DEF.anonReserve && n(LEGIT) === 300 && n("src = 'fav'") === 0, 'evict-anon:4 个令牌各刷 300 次,预留仍空着,本机收藏用户的行一行不少', [n(), n(LEGIT)]);
        const r = await call(ae, 'POST', '/api/favorites/add', { body: { token: TK.c, item: item('满表新剧', 's1', '99999') } });
        ok(r.body.ok === true && n("vod_id = '99999'") === 1, '刷完之后同步用户的新收藏照常被跟踪', r.body);
        // 1 小时后本机收藏用户回来:300 部全部照常有状态
        NOW += HOUR;
        let withStatus = 0;
        for (let u = 0; u < 30; u++) { const x = await call(ae, 'POST', '/api/favorites/status', { body: { items: legitItems(u) }, headers: { 'x-ip': '203.0.113.' + u } }); withStatus += Object.keys(x.body.status).length; }
        ok(withStatus === 300, 'evict-anon:本机收藏用户的 300 部全部照常有状态(上一轮:0)', withStatus);
        EV.forEach(t => validTokens.delete(t));
        dbe.close();
    }
    // ---- 预留被 收藏/取消 刷空(review4 reserve-drain,第三轮实锤):孤行 + 免费续期 → 之后所有新收藏都不跟踪 ----
    {
        const dbr = new Database(':memory:');
        const { fav: fr, app: ar } = mkFav(dbr, { sleep: async () => { }, opts: { siteGapMs: 0 } });
        const n = (w) => dbr.prepare('SELECT COUNT(*) n FROM fav_watch' + (w ? ' WHERE ' + w : '')).get().n;
        const EV = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => sha('drain' + i));
        EV.forEach(t => validTokens.add(t));
        // 10 个令牌各 收藏→取消 300 次(合计 3000,足够刷满整张表)
        for (let k = 0; k < EV.length; k++) for (let i = 0; i < 300; i++) {
            const v = String(100000 + k * 1000 + i);
            await call(ar, 'POST', '/api/favorites/add', { body: { token: EV[k], item: item('d' + v, 's1', v) } });
            await call(ar, 'POST', '/api/favorites/remove', { body: { token: EV[k], fav_id: 'd' + v } });
        }
        ok(n() === 0, 'reserve-drain:3000 次 收藏/取消 之后跟踪表里一行孤行都没留', n());
        // 攻击者再用匿名 status 把这些 id 续期:它们是新登记 → 受匿名那块 2000 上限约束,碰不到预留
        for (let s = 100000; s < 110000; s += 1000) for (let b = 0; b < 3; b++)
            await call(ar, 'POST', '/api/favorites/status', { body: { items: Array.from({ length: 100 }, (_, i) => ({ site_key: 's1', vod_id: String(s + b * 100 + i) })) }, headers: { 'x-ip': '198.51.100.' + (s / 1000 % 250) } });
        ok(n() <= DEF.maxWatch - DEF.anonReserve, 'reserve-drain:匿名续期最多占 2000 行', n());
        const r = await call(ar, 'POST', '/api/favorites/add', { body: { token: TK.c, item: item('预留新剧', 's1', '777777') } });
        ok(r.body.ok === true && n("vod_id = '777777'") === 1 && W(dbr, 's1', '777777').src === 'fav', 'reserve-drain:同步用户的新收藏照常被跟踪(第三轮:tracked=0)', r.body);
        // 兜底:万一表里有服务器收藏留下的孤行(老数据/删除失败)把表塞满 —— 没人收藏的行超过 2000 时,新收藏先挤这种孤行,不看多新
        dbr.prepare('DELETE FROM fav_watch').run();
        const insFav = dbr.prepare("INSERT INTO fav_watch (site_key, vod_id, next_check, last_wanted, fails, src) VALUES ('s1', ?, ?, ?, 0, ?)");
        dbr.transaction(() => {
            for (let i = 0; i < DEF.maxWatch - DEF.anonReserve; i++) insFav.run('a' + i, NOW, NOW, 'anon');
            for (let i = 0; i < DEF.anonReserve; i++) insFav.run('f' + i, NOW, NOW - i, 'fav');
        })();
        ok(n() === DEF.maxWatch, '兜底场景:表满(2000 匿名 + 1000 刚续期的孤行)', n());
        const r2 = await call(ar, 'POST', '/api/favorites/add', { body: { token: TK.c, item: item('孤行兜底', 's1', '888888') } });
        ok(r2.body.ok === true && n("vod_id = '888888'") === 1 && n("src = 'anon'") === DEF.maxWatch - DEF.anonReserve && n("vod_id = 'f999'") === 0,
            '兜底:挤掉最久没人要的服务器收藏孤行(哪怕刚续期过),匿名那 2000 行一行不动', [n(), n("src = 'anon'")]);
        // 没人收藏的行没超过 2000(预留被真收藏占满)→ 仍只挤 ≥24h 没人要的
        dbr.prepare("DELETE FROM fav_watch WHERE src = 'fav'").run();
        for (let i = 0; i < DEF.anonReserve; i++) dbr.prepare("INSERT INTO user_favorites (user_token, fav_id, data, added_at, updated_at, seen_count, check_site, check_vid) VALUES (?, ?, '{}', 1, 1, 0, 's1', ?)").run('ref' + (i % 7), 'r' + i, 'r' + i);
        dbr.transaction(() => { for (let i = 0; i < DEF.anonReserve; i++) insFav.run('r' + i, NOW, NOW, 'fav'); })();
        ok(n() === DEF.maxWatch && n("src = 'anon'") === DEF.maxWatch - DEF.anonReserve, '准备:2000 匿名 + 1000 真被收藏的行 = 表满', n());
        const r3 = await call(ar, 'POST', '/api/favorites/add', { body: { token: TK.c, item: item('真满了', 's1', '999999') } });
        ok(r3.body.ok === true && n("vod_id = '999999'") === 0, '预留被真收藏占满、匿名行都在 24h 内:新收藏先不跟踪(不挤任何人)', r3.body);
        EV.forEach(t => validTokens.delete(t));
        dbr.close();
    }
    // ---- 洪水攻击复现(review/flood.js):轮换伪造 IP 灌 3000 个垃圾 id,真用户的匿名登记一行不少(S2) ----
    {
        const dbf = new Database(':memory:');
        const { app: af } = mkFav(dbf);
        await call(af, 'POST', '/api/favorites/status', { body: { items: [1, 2, 3, 4, 5].map(i => ({ site_key: 's1', vod_id: 'real' + i })) }, headers: { 'x-ip': '203.0.113.5' } });
        NOW += 60e3;
        for (let ip = 0; ip < 10; ip++) for (let b = 0; b < 4; b++)
            await call(af, 'POST', '/api/favorites/status', { body: { items: Array.from({ length: 100 }, (_, i) => ({ site_key: 's1', vod_id: `junk${ip}_${b}_${i}` })) }, headers: { 'x-ip': '198.51.100.' + ip } });
        const left = dbf.prepare("SELECT COUNT(*) n FROM fav_watch WHERE vod_id LIKE 'real%'").get().n;
        const total = dbf.prepare('SELECT COUNT(*) n FROM fav_watch').get().n;
        ok(left === 5 && total === DEF.maxWatch - DEF.anonReserve, '洪水后匿名登记停在 maxWatch − anonReserve = 2000(留 1000 给服务器收藏),真用户的 5 行都在', { left, total });
        // 洪水后真用户再查:续期照常、状态照常返回
        dbf.prepare("UPDATE fav_watch SET ep_count = 3, latest_ep = '第3集', remarks = '', finished = 0, checked_at = 1 WHERE vod_id = 'real1'").run();
        const r = await call(af, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'real1' }] }, headers: { 'x-ip': '203.0.113.5' } });
        ok(r.body.status['s1|real1'] && r.body.status['s1|real1'].ep_count === 3 && W(dbf, 's1', 'real1').last_wanted === NOW, '洪水后真用户照常拿到状态、续期', r.body);
        dbf.close();
    }
    // ---- 洪水锁表复现(review2/srvfix/flood2.js,R2):单 IP 按预算 10 小时灌 3000 个垃圾 id,之后每 6 天免费续期一次 ----
    //   最早:表满后服务器收藏只能挤"7 天没人要"的行,垃圾行永远新鲜 → 新收藏 {ok:true} 却永远不跟踪(没红点没推送)
    //   现在(V4):匿名最多占 2000 行,服务器收藏用预留的容量,一行不挤;站点对整批 id 一个都不回 = 分不清是垃圾还是站点抽风(V5)
    //   → 按请求失败退避、不删;攻击者停止续期 14 天后被清掉
    {
        const dbf2 = new Database(':memory:');
        const { fav: ff, app: af2 } = mkFav(dbf2, { fetchJson: async () => ({ list: [] }), sleep: async () => { }, opts: { siteGapMs: 0 } });
        const n = (w) => dbf2.prepare('SELECT COUNT(*) n FROM fav_watch' + (w ? ' WHERE ' + w : '')).get().n;
        await call(af2, 'POST', '/api/favorites/status', { body: { items: [1, 2, 3, 4, 5].map(i => ({ site_key: 's1', vod_id: 'real' + i })) }, headers: { 'x-ip': '203.0.113.5' } });
        NOW += 60e3;
        const junk = (h, b) => Array.from({ length: 100 }, (_, i) => ({ site_key: 's1', vod_id: `junk${h}_${b}_${i}` }));
        for (let h = 0; h < 10; h++) { for (let b = 0; b < 3; b++) await call(af2, 'POST', '/api/favorites/status', { body: { items: junk(h, b) }, headers: { 'x-ip': '198.51.100.1' } }); NOW += HOUR; }
        const CAP = DEF.maxWatch - DEF.anonReserve;
        ok(n() === CAP && n("vod_id LIKE 'real%'") === 5, '单 IP 按预算 10 小时灌垃圾 → 匿名登记停在 2000,真用户的 5 行都在', n());
        const refresh = async () => {
            for (let h = 0; h < 10; h++) for (let b = 0; b < 3; b++) await call(af2, 'POST', '/api/favorites/status', { body: { items: junk(h, b) }, headers: { 'x-ip': '198.51.100.1' } });
            await call(af2, 'POST', '/api/favorites/status', { body: { items: [1, 2, 3, 4, 5].map(i => ({ site_key: 's1', vod_id: 'real' + i })) }, headers: { 'x-ip': '203.0.113.5' } });   // 真用户也常来
        };
        for (let wk = 0; wk < 3; wk++) {
            NOW += 6 * DAYMS; await refresh();
            const r = await call(af2, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('新剧' + wk, 's1', 'sync' + wk) } });
            ok(r.body.ok === true && n(`vod_id = 'sync${wk}'`) === 1 && n("vod_id LIKE 'junk%'") === CAP - 5 && n() === CAP + wk + 1, `flood2 第 ${(wk + 1) * 6} 天:垃圾刚续期,服务器收藏用预留容量照样被跟踪(一行不挤)`, [r.body, n(), n(`vod_id = 'sync${wk}'`)]);
            await call(af2, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'newanon' + wk }] }, headers: { 'x-ip': '203.0.113.' + (10 + wk) } });
            ok(n(`vod_id = 'newanon${wk}'`) === 0, `flood2 第 ${(wk + 1) * 6} 天:匿名那块满了,匿名新登记不跟踪(剩余风险,见 lib/favorites 头注释)`);
        }
        // 站点对整批 id 一个都不回:每轮 ≤60 批×20 = 1200 行,2003 行一遍 2 轮。两遍都只按失败退避,不记查无、不删
        const rounds = async () => { const t = { failed: 0, dropped: 0 }; for (let i = 0; i < 3; i++) { const x = await ff.runRound(); t.failed += x.failed; t.dropped += x.dropped; } return t; };
        let s = await rounds();
        ok(s.failed === CAP + 3 && s.dropped === 0 && n() === CAP + 3, 'flood2 第一遍:整批一个都没回 → 全部按请求失败退避,不删', s);
        NOW += HOUR + 1;
        s = await rounds();
        const jr = dbf2.prepare("SELECT miss, fails FROM fav_watch WHERE vod_id = 'junk0_0_0'").get();
        ok(s.dropped === 0 && n() === CAP + 3 && jr.miss === 0 && jr.fails === 2, 'flood2 第二遍:仍只退避(查无次数不动),一行不删', [s, jr]);
        // 攻击者停止续期:14 天后没人收藏的行全被清掉,收藏的留着;匿名新登记恢复
        NOW += 15 * DAYMS;
        await ff.runRound();
        ok(n("vod_id LIKE 'junk%'") === 0 && n("vod_id LIKE 'sync%'") === 3, 'flood2:停止续期 14 天后垃圾被清理,3 部收藏的留着', n());
        await call(af2, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'newanon9' }] }, headers: { 'x-ip': '203.0.113.99' } });
        ok(n("vod_id = 'newanon9'") === 1, '垃圾清掉后匿名新登记照常跟踪');
        dbf2.close();
    }
    // ---- 真实 id 灌表(review3/flood3.js,V4):站点对灌进来的 id 都正常回,查无删行不起作用、续期又免费 ----
    //   匿名最多占 2000 行,服务器收藏靠预留的 1000 行照样被跟踪、查到状态。
    //   剩余风险(已知、接受,见 lib/favorites 头注释):这时本机收藏(没登录/没开同步的设备)的新登记一直被拒
    {
        const dbr = new Database(':memory:');
        const fetchAll = async (url) => { const ids = decodeURIComponent(url.split('ids=')[1]).split(','); return { list: ids.map(id => ({ vod_id: id, vod_play_url: '第1集$a.m3u8', vod_remarks: '完结' })) }; };
        const { fav: fr, app: ar } = mkFav(dbr, { fetchJson: fetchAll, sleep: async () => { }, opts: { siteGapMs: 0 } });
        const n = (w) => dbr.prepare('SELECT COUNT(*) n FROM fav_watch' + (w ? ' WHERE ' + w : '')).get().n;
        const JUNK = "vod_id GLOB '1[0-9][0-9][0-9][0-9]'";
        const batchOf = (h, b) => Array.from({ length: 100 }, (_, i) => ({ site_key: 's1', vod_id: String(10000 + h * 300 + b * 100 + i) }));
        for (let h = 0; h < 10; h++) {
            for (let b = 0; b < 3; b++) await call(ar, 'POST', '/api/favorites/status', { body: { items: batchOf(h, b) }, headers: { 'x-ip': '198.51.100.1' } });
            NOW += HOUR;
            for (let k = 0; k < 3; k++) await fr.runRound();
        }
        const CAP = DEF.maxWatch - DEF.anonReserve;
        ok(n() === CAP && n(JUNK) === CAP, 'flood3:单 IP 10 小时灌真实 id → 停在 2000(上一轮:3000 全满)', n());
        const refresh = async () => { for (let h = 0; h < 10; h++) for (let b = 0; b < 3; b++) await call(ar, 'POST', '/api/favorites/status', { body: { items: batchOf(h, b) }, headers: { 'x-ip': '198.51.100.1' } }); };
        for (let wk = 0; wk < 3; wk++) {
            NOW += 6 * DAYMS; await refresh();
            const r = await call(ar, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('灌表剧' + wk, 's1', 'sync' + wk) } });
            ok(r.body.ok === true && n(`vod_id = 'sync${wk}'`) === 1 && n(JUNK) === CAP && n() === CAP + wk + 1, `flood3 第 ${(wk + 1) * 6} 天:服务器收藏用预留容量被跟踪,灌进来的一行没被挤(上一轮:挤掉一行)`, [r.body, n(), n(JUNK)]);
            await call(ar, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'newanon' + wk }] }, headers: { 'x-ip': '203.0.113.' + (10 + wk) } });
            ok(n(`vod_id = 'newanon${wk}'`) === 0, `flood3 第 ${(wk + 1) * 6} 天:剩余风险 —— 本机收藏的新登记被拒(已登记的不受影响)`);
            for (let k = 0; k < 3; k++) await fr.runRound();
        }
        const g = await call(ar, 'GET', '/api/favorites', { query: { token: TK.a } });
        ok(g.body.items.length === 3 && g.body.items.every(x => x.status && x.status.ep_count === 1 && x.status.finished === true), 'flood3:3 部服务器收藏都查到了状态', g.body.items.map(x => x.status));
        dbr.close();
    }
    // ---- 站点抽风回空列表(review3/blip.js,V5):这批要的 id 一个都没回来 = 当请求失败(退避、查无次数不动),不删任何行 ----
    //   上一轮:{code:1,list:[]} 当"全部查无",相隔 1h 的两次抽风就删光这个站的本机收藏行、把服务器收藏推迟到 24h 后
    {
        const dbb2 = new Database(':memory:');
        let mode = 'ok';
        const { fav: fb, app: ab } = mkFav(dbb2, {
            sleep: async () => { }, opts: { siteGapMs: 0 },
            fetchJson: async (url) => {
                if (mode === 'empty') return { code: 1, msg: '数据列表', page: 1, total: 0, list: [] };
                const ids = decodeURIComponent(url.split('ids=')[1]).split(',');
                return { list: ids.filter(x => mode !== 'only-a1' || x === 'a1').map(x => ({ vod_id: x, vod_play_url: '第1集$a.m3u8#第2集$b.m3u8', vod_remarks: '更新至2集' })) };
            }
        });
        for (let i = 1; i <= 3; i++) await call(ab, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('抽风剧' + i, 's1', 'r' + i, { addedEpCount: 2 }) } });
        await call(ab, 'POST', '/api/favorites/status', { body: { items: [1, 2, 3].map(i => ({ site_key: 's1', vod_id: 'a' + i })) }, headers: { 'x-ip': '203.0.113.9' } });
        const rows = () => dbb2.prepare('SELECT vod_id, miss, fails, next_check - ? AS due FROM fav_watch ORDER BY vod_id').all(NOW);
        let s = await fb.runRound();
        ok(s.checked === 6 && rows().every(x => x.miss === 0 && x.fails === 0), 'blip 基线:6 行都查到', rows());
        mode = 'empty';
        NOW += 5 * HOUR;
        const b1 = await fb.runRound();
        NOW += HOUR + 1;
        const b2 = await fb.runRound();
        ok(b1.dropped === 0 && b2.dropped === 0 && b1.failed === 6 && b2.failed === 6, 'blip:相隔 1h 两次空列表 → 都按请求失败,一行不删(上一轮:第二次删掉 3 行)', [b1, b2]);
        ok(rows().length === 6 && rows().every(x => x.miss === 0 && x.fails === 2 && x.due === 6 * HOUR), 'blip:失败退避 1h→6h,查无次数不动(收藏的也没被推到 24h)', rows());
        mode = 'ok';
        NOW += 6 * HOUR + 1;
        s = await fb.runRound();
        ok(s.checked === 6 && rows().every(x => x.fails === 0 && x.miss === 0), 'blip:站点恢复 → 照常查到、失败计数清零', rows());
        // 单 id 的批次:回包里没有它 = 没有"别的 id"能证明这次回包正常 → 也只按失败退避,不记查无
        mode = 'only-a1';
        dbb2.prepare("UPDATE fav_watch SET next_check = ? WHERE vod_id != 'a2'").run(NOW + 100 * DAYMS);
        dbb2.prepare("UPDATE fav_watch SET next_check = 0 WHERE vod_id = 'a2'").run();
        s = await fb.runRound();
        let a2 = dbb2.prepare("SELECT miss, fails FROM fav_watch WHERE vod_id = 'a2'").get();
        ok(s.requests === 1 && s.failed === 1 && a2.miss === 0 && a2.fails === 1, '单 id 批次回包里没有它 → 失败退避,不记查无', [s, a2]);
        // 同一回包里有这批别的 id(a1)、唯独没有 a2 → 才记一次查无
        dbb2.prepare("UPDATE fav_watch SET next_check = 0 WHERE vod_id IN ('a1', 'a2')").run();
        s = await fb.runRound();
        a2 = dbb2.prepare("SELECT miss, fails FROM fav_watch WHERE vod_id = 'a2'").get();
        ok(s.checked === 1 && a2.miss === 1, '回包里有别的 id、唯独没有它 → 记一次查无', [s, a2]);
        dbb2.close();
    }
    // ---- 查无此片(R2,真 HTTP 假站):详情请求成功但返回里没有这个 id → 连续 2 次就删(没人收藏时);有人收藏的 24h 后再看 ----
    {
        const dbj = new Database(':memory:');
        const { fav: fj, app: aj } = mkFav(dbj, { opts: { siteGapMs: 0 } });
        const st = (vid) => W(dbj, 's3', vid);
        M.set('s3', 'ok1', 3);
        await call(aj, 'POST', '/api/favorites/status', { body: { items: ['j1', 'j2', 'ok1', 'flip1'].map(v => ({ site_key: 's3', vod_id: v })) } });
        await call(aj, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('下架剧', 's3', 'refgone') } });
        M.reset();
        let s = await fj.runRound();
        ok(s.requests === 1 && s.checked === 1 && s.failed === 4 && s.dropped === 0, '第 1 轮:一个批量请求,ok1 查到,其余 4 个各记一次查无', s);
        ok(st('j1').miss === 1 && st('j1').fails === 1 && st('j1').next_check === NOW + HOUR && st('ok1').miss === 0, '第一次查无:不删,按失败退避 1h', st('j1'));
        M.set('s3', 'flip1', 2);   // flip1 上架了
        NOW += HOUR + 1;
        s = await fj.runRound();
        ok(!st('j1') && !st('j2') && s.dropped === 2, '第 2 轮:连续 2 次查无、没人收藏 → 删掉', s);
        ok(st('flip1') && st('flip1').miss === 0 && st('flip1').ep_count === 2, '中间查到了 → 查无次数清零', st('flip1'));
        ok(st('refgone') && st('refgone').miss === 2 && st('refgone').next_check === NOW + 24 * HOUR, '有人收藏的查无行:不删,24h 后再看', st('refgone'));
        // flip1 又下架:从 0 重新数,第一次只退避
        M.vods.delete('s3|flip1');
        NOW += 4 * HOUR + 1;
        await fj.runRound();
        ok(st('flip1') && st('flip1').miss === 1, '清零后再查无:从 1 重新数,不删', st('flip1'));
        // 中间夹一次请求失败:既不算查无也不清零 → 恢复后再查无,接着数到 2 → 删
        M.failSites.add('s3');
        NOW += HOUR + 1;
        await fj.runRound();
        ok(st('flip1') && st('flip1').miss === 1 && st('flip1').fails === 2, '请求失败:查无次数不变', st('flip1'));
        M.failSites.delete('s3');
        NOW += 6 * HOUR + 1;
        s = await fj.runRound();
        ok(!st('flip1') && s.dropped === 1, '失败之后再查无 = 连续第 2 次 → 删', s);
        // 删掉的 id 再被匿名问起 → 重新登记、从头数
        await call(aj, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's3', vod_id: 'j1' }] } });
        ok(st('j1') && st('j1').miss === 0 && st('j1').next_check === NOW, '删掉的 id 再被问起 → 重新登记', st('j1'));
        // 收藏删了以后,原来有人收藏的查无行到期就删
        await call(aj, 'POST', '/api/favorites/remove', { body: { token: TK.a, fav_id: '下架剧' } });
        NOW += 24 * HOUR + 1;
        await fj.runRound();
        ok(!st('refgone'), '收藏删掉后,查无行到期就删', st('refgone'));
        dbj.close();
    }
    // ---- 私密站:匿名 status 要令牌,新登记预算按令牌算(伪造 IP 头换不来新预算)(S2) ----
    {
        const dba = new Database(':memory:');
        const { fav: fa, app: aa } = mkFav(dba, { authRequired: () => true, opts: { newPerIpHour: 5 } });
        fa._ensureSchema();
        const many = (p) => Array.from({ length: 8 }, (_, i) => ({ site_key: 's1', vod_id: p + i }));
        let r = await call(aa, 'POST', '/api/favorites/status', { body: { items: many('z') } });
        ok(r.statusCode === 401 && r.body.ok === false && dba.prepare('SELECT COUNT(*) n FROM fav_watch').get().n === 0, '私密站无令牌 → 401、不登记', r.body);
        r = await call(aa, 'POST', '/api/favorites/status', { body: { token: 'constructor', items: many('z') } });
        ok(r.statusCode === 401, '私密站原型键令牌 → 401', r.statusCode);
        r = await call(aa, 'POST', '/api/favorites/status', { body: { token: TK.x, items: many('z') } });
        ok(r.statusCode === 403 && r.body.banned === true, '私密站封禁令牌 → 403', r.body);
        r = await call(aa, 'POST', '/api/favorites/status', { body: { token: TK.a, items: many('a') }, headers: { 'x-ip': '1.0.0.1' } });
        ok(r.body.enabled === true && dba.prepare("SELECT COUNT(*) n FROM fav_watch WHERE vod_id LIKE 'a%'").get().n === 5, '按令牌的新登记预算 5', r.body);
        await call(aa, 'POST', '/api/favorites/status', { body: { token: TK.a, items: many('b') }, headers: { 'x-ip': '2.0.0.2' } });
        ok(dba.prepare("SELECT COUNT(*) n FROM fav_watch WHERE vod_id LIKE 'b%'").get().n === 0, '同一令牌换 IP 头 → 预算不重置');
        r = await call(aa, 'POST', '/api/favorites/status', { query: { token: TK.b }, body: { items: many('c') }, headers: { 'x-ip': '2.0.0.2' } });
        ok(r.body.enabled === true && dba.prepare("SELECT COUNT(*) n FROM fav_watch WHERE vod_id LIKE 'c%'").get().n === 5, '别的令牌有自己的预算;也认 ?token=', r.body);
        dba.close();
    }
    {
        // 公开站:每 IP 新登记预算
        const db4 = new Database(':memory:');
        const { app: a4 } = mkFav(db4, { opts: { newPerIpHour: 5 } });
        const many = Array.from({ length: 8 }, (_, i) => ({ site_key: 's1', vod_id: 'q' + i }));
        await call(a4, 'POST', '/api/favorites/status', { body: { items: many }, headers: { 'x-ip': '5.5.5.5' } });
        ok(db4.prepare('SELECT COUNT(*) n FROM fav_watch').get().n === 5, '每 IP 每小时新登记有预算', db4.prepare('SELECT COUNT(*) n FROM fav_watch').get().n);
        await call(a4, 'POST', '/api/favorites/status', { body: { items: many }, headers: { 'x-ip': '6.6.6.6' } });
        ok(db4.prepare('SELECT COUNT(*) n FROM fav_watch').get().n === 8, '别的 IP 不受影响');
        await call(a4, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'q99' }] }, headers: { 'x-ip': '5.5.5.5' } });
        ok(!W(db4, 's1', 'q99'), '预算用完 → 不登记');
        NOW += HOUR + 1;
        await call(a4, 'POST', '/api/favorites/status', { body: { items: [{ site_key: 's1', vod_id: 'q99' }] }, headers: { 'x-ip': '5.5.5.5' } });
        ok(!!W(db4, 's1', 'q99'), '一小时后恢复');
        db4.close();
    }
    // ---- 集数来回跳:同一集只推一次(S3,review/flap.js) ----
    {
        const dbx = new Database(':memory:');
        let eps = 11;
        const mkUrl = (n) => Array.from({ length: n }, (_, i) => `第${i + 1}集$https://x/${i}.m3u8`).join('#');
        const got = [];
        const { fav: fx, app: ax } = mkFav(dbx, {
            fetchJson: async () => ({ list: [{ vod_id: 100, vod_play_url: eps < 0 ? '' : mkUrl(eps), vod_remarks: '更新至' + eps + '集' }] }),
            push: async (t, p) => { got.push({ t, p }); return { sent: 1 }; }
        });
        await call(ax, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('跳剧', 's1', 100, { addedEpCount: 11 }) } });
        await fx.runRound();   // 基线 11 集
        ok(got.length === 0 && W(dbx, 's1', 100).max_ep === 11, '基线 11 集不推送、max_ep=11', W(dbx, 's1', 100));
        const seq = [12, 11, 12, 11, 12];
        const counts = [];
        for (const e of seq) {
            eps = e; NOW += 5 * HOUR;
            const s = await fx.runRound();
            counts.push(s.pushed);
        }
        ok(got.length === 1 && got[0].p.body === '更新至 第12集' && counts.join() === '1,0,0,0,0', '12→11→12→11→12:只推第一次的 12', { counts, got: got.map(x => x.p.body) });
        const w = W(dbx, 's1', 100);
        ok(w.ep_count === 12 && w.max_ep === 12, '最终 ep_count/max_ep = 12', w);
        // 回落照存(角标可暂时消失),max_ep 不降
        eps = 11; NOW += 5 * HOUR; await fx.runRound();
        ok(W(dbx, 's1', 100).ep_count === 11 && W(dbx, 's1', 100).max_ep === 12, '回落存 11,max_ep 仍 12', W(dbx, 's1', 100));
        let r = await call(ax, 'GET', '/api/favorites', { query: { token: TK.a } });
        ok(r.body.items[0].has_update === false, '回落时 11 ≤ 已看 11 → 不亮红点', r.body.items[0]);
        // 播放列表空了(重新采集):0 集绝不覆盖已知集数
        eps = -1; NOW += 5 * HOUR;
        const s0 = await fx.runRound();
        ok(s0.changed === 0 && W(dbx, 's1', 100).ep_count === 11 && W(dbx, 's1', 100).latest_ep === '第11集' && W(dbx, 's1', 100).max_ep === 12, '空播放列表不把 11 改成 0', W(dbx, 's1', 100));
        eps = 12; NOW += 5 * HOUR;
        await fx.runRound();
        ok(got.length === 1, '空 → 12(已通知过)不再推', got.length);
        // 真的出了新一集(13 > max_ep 12)→ 推
        eps = 13; NOW += 5 * HOUR;
        await fx.runRound();
        ok(got.length === 2 && got[1].p.body === '更新至 第13集' && W(dbx, 's1', 100).max_ep === 13, '新的一集照推', got.map(x => x.p.body));
        // 第一次查就是空列表:不当基线,之后第一次查到正数才作基线(不误推)
        await call(ax, 'POST', '/api/favorites/add', { body: { token: TK.b, item: item('空剧', 's1', 'e1') } });
        eps = -1; NOW += 5 * HOUR;
        const fe = mkFav(dbx, { fetchJson: async (url) => ({ list: [{ vod_id: 'e1', vod_play_url: eps < 0 ? '' : mkUrl(eps) }, { vod_id: 100, vod_play_url: mkUrl(13) }] }), push: async (t, p) => { got.push({ t, p }); return { sent: 1 }; } });
        await fe.fav.runRound();
        eps = 6; NOW += 5 * HOUR;
        await fe.fav.runRound();
        ok(got.length === 2 && W(dbx, 's1', 'e1').ep_count === 6 && dbx.prepare("SELECT seen_count FROM user_favorites WHERE fav_id = '空剧'").get().seen_count === 6, '先空后 6 集:当基线、不推送', [got.length, W(dbx, 's1', 'e1')]);
        dbx.close();
    }
    // ---- 老库迁移:fav_watch 没有 max_ep 列 → 幂等补列,老行以上次存的集数为已通知最高(S3) ----
    {
        const dbm = new Database(':memory:');
        dbm.exec(`CREATE TABLE fav_watch (site_key TEXT NOT NULL, vod_id TEXT NOT NULL, ep_count INTEGER, latest_ep TEXT, remarks TEXT, finished INTEGER,
            checked_at INTEGER, changed_at INTEGER, next_check INTEGER, last_wanted INTEGER, fails INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (site_key, vod_id))`);
        dbm.prepare("INSERT INTO fav_watch (site_key, vod_id, ep_count, latest_ep, remarks, finished, checked_at, next_check, last_wanted) VALUES ('s1', 'm1', 12, '第12集', '', 0, 1, 0, ?)").run(NOW);
        let eps = 12;
        const got = [];
        const mkUrl = (n) => Array.from({ length: n }, (_, i) => `第${i + 1}集$https://x/${i}.m3u8`).join('#');
        const m1 = mkFav(dbm, { fetchJson: async () => ({ list: [{ vod_id: 'm1', vod_play_url: mkUrl(eps) }] }), push: async (t, p) => { got.push(p); return { sent: 1 }; } });
        ok(m1.fav._ensureSchema() && dbm.prepare('PRAGMA table_info(fav_watch)').all().some(c => c.name === 'max_ep'), '补上 max_ep 列');
        ok(W(dbm, 's1', 'm1').miss === 0, '同时补上 miss 列(老行 = 0)', W(dbm, 's1', 'm1'));
        ok(mkFav(dbm).fav._ensureSchema(), '再建实例(=重启)迁移不报错');
        // 上一版建的表:有 max_ep、没有 miss → 只补 miss
        const dbm2 = new Database(':memory:');
        dbm2.exec(`CREATE TABLE fav_watch (site_key TEXT NOT NULL, vod_id TEXT NOT NULL, ep_count INTEGER, latest_ep TEXT, remarks TEXT, finished INTEGER,
            checked_at INTEGER, changed_at INTEGER, next_check INTEGER, last_wanted INTEGER, fails INTEGER NOT NULL DEFAULT 0, max_ep INTEGER, PRIMARY KEY (site_key, vod_id))`);
        dbm2.prepare("INSERT INTO fav_watch (site_key, vod_id, next_check, last_wanted, max_ep) VALUES ('s1', 'q1', 0, ?, 7)").run(NOW);
        ok(mkFav(dbm2).fav._ensureSchema() && mkFav(dbm2).fav._ensureSchema() && W(dbm2, 's1', 'q1').miss === 0 && W(dbm2, 's1', 'q1').max_ep === 7, '有 max_ep 没 miss 的表 → 幂等补 miss', W(dbm2, 's1', 'q1'));
        ok(W(dbm, 's1', 'm1').src === 'anon' && W(dbm2, 's1', 'q1').src === 'anon', '老表补 src 列,老行一律当 anon(不会被当孤行直接删/挤)', [W(dbm, 's1', 'm1').src, W(dbm2, 's1', 'q1').src]);
        dbm2.close();
        await call(m1.app, 'POST', '/api/favorites/add', { body: { token: TK.a, item: item('老剧', 's1', 'm1', { addedEpCount: 10 }) } });
        eps = 11; await m1.fav.runRound();
        eps = 12; NOW += 5 * HOUR; await m1.fav.runRound();
        ok(got.length === 0 && W(dbm, 's1', 'm1').max_ep === 12, '老行 12→11→12 不推(以老 ep_count 为已通知最高)', got);
        dbm.close();
    }
    // ---- 站点列表没加载到:整轮跳过,一行都不碰;加载到但站不在了才推迟(S6) ----
    {
        const dbs = new Database(':memory:');
        let mode = 'fail';
        const calls = [];
        const s6 = mkFav(dbs, {
            sites: () => [],   // 请求路径的同步列表(模拟 REMOTE_DB_URL 还没加载:本地只有模板)
            loadSites: async () => { calls.push(mode); if (mode === 'fail') return null; if (mode === 'throw') throw new Error('remote down'); if (mode === 'empty') return []; return SITES().filter(s => s.key !== 's3'); }
        });
        s6.fav._ensureSchema();
        dbs.prepare('INSERT INTO fav_watch (site_key, vod_id, next_check, last_wanted, fails) VALUES (?, ?, 0, ?, 0)').run('s1', '101', NOW);
        dbs.prepare('INSERT INTO fav_watch (site_key, vod_id, next_check, last_wanted, fails) VALUES (?, ?, 0, ?, 0)').run('s3', '301', NOW);
        M.reset();
        for (const m of ['fail', 'throw', 'empty']) {
            mode = m;
            const s = await s6.fav.runRound();
            ok(s.no_sites === true && s.skipped === 0 && s.requests === 0 && W(dbs, 's1', '101').next_check === 0 && W(dbs, 's3', '301').next_check === 0, '站点列表 ' + m + ' → 整轮跳过、行不动', s);
        }
        ok(M.log.length === 0 && calls.join() === 'fail,throw,empty', '没加载到就一个请求都不发、每轮都重新试加载', [M.log.length, calls]);
        mode = 'ok';
        const s = await s6.fav.runRound();
        ok(s.checked === 1 && s.skipped === 1 && W(dbs, 's1', '101').checked_at === NOW && W(dbs, 's3', '301').next_check === NOW + 24 * HOUR, '加载到了:照常查;真不在列表里的站才推迟 24h', s);
        dbs.close();
    }
    // ---- 推送只发给仍有效的令牌(S7)+ 通知闸门 notifyOk:注入的口径放行的令牌照推,失效的密码令牌/封禁的不推 ----
    {
        const dbt = new Database(':memory:');
        const got = [];
        const mkUrl = (n) => Array.from({ length: n }, (_, i) => `第${i + 1}集$https://x/${i}.m3u8`).join('#');
        let eps = 3;
        const fetchV7 = async () => ({ list: [{ vod_id: 'v7', vod_play_url: mkUrl(eps) }] });
        const pushGot = async (t) => { got.push(t); return { sent: 1 }; };
        // 注入的通知口径:还在令牌表里 / 或是某种"外部令牌"格式(测试用 ext_ 前缀)
        const notifyOk = (t) => validTokens.has(t) || /^ext_[0-9a-f]{64}$/.test(t);
        const st = mkFav(dbt, { fetchJson: fetchV7, push: pushGot, notifyOk });
        const gone = sha('gone-user');
        const EXT = 'ext_' + sha('restart@example.com'), EXTBAN = 'ext_' + sha('banned@example.com');
        for (const t of [gone, EXT, EXTBAN]) validTokens.add(t);
        for (const t of [TK.a, gone, EXT, EXTBAN]) await call(st.app, 'POST', '/api/favorites/add', { body: { token: t, item: item('七剧', 's1', 'v7', { addedEpCount: 3 }) } });
        await st.fav.runRound();
        // 改了密码(密码令牌失效);外部令牌都不在令牌表;其中一个外部令牌用户被封禁
        for (const t of [gone, EXT, EXTBAN]) validTokens.delete(t);
        banned.add(EXTBAN);
        eps = 4; NOW += 5 * HOUR;
        let s = await st.fav.runRound();
        ok(s.changed === 1 && got.slice().sort().join() === [TK.a, EXT].sort().join(), '通知闸门:有效的照推;注入口径放行的外部令牌照推;失效的密码令牌、封禁的不推', got.map(x => x.slice(0, 12)));
        // 没注入 notifyOk → 同接口鉴权的 tokenOk(不在令牌表里就不推)
        got.length = 0;
        const plain = mkFav(dbt, { fetchJson: fetchV7, push: pushGot });
        eps = 5; NOW += 5 * HOUR;
        s = await plain.fav.runRound();
        ok(s.changed === 1 && got.join() === TK.a, '没注入 notifyOk → 退回 tokenOk', got.map(x => x.slice(0, 12)));
        // 接口鉴权不受 notifyOk 影响:不在令牌表里的外部令牌不能读/改收藏
        const r = await call(st.app, 'GET', '/api/favorites', { query: { token: EXT } });
        ok(r.statusCode === 401, '接口鉴权仍用 tokenOk:不在令牌表里的外部令牌 401', r.statusCode);
        banned.delete(EXTBAN);
        dbt.close();
    }
    // ---- 出网请求预算含代理重试(S8):fetchJson 经 ctl.extra() 申请重试名额,全轮总数 ≤ maxReqPerRound ----
    {
        const dbb = new Database(':memory:');
        const seen = [];
        let grants = 0, denied = 0;
        const sb = mkFav(dbb, {
            opts: { siteGapMs: 1, maxReqPerRound: 5, batchIds: 1, concurrency: 1 },
            fetchJson: async (url, key, t, ctl) => {
                seen.push(url);
                // 模拟"直连失败 → 申请走代理重试":每批都要一次额外请求
                if (ctl && typeof ctl.extra === 'function') { if (ctl.extra()) grants++; else denied++; }
                return { list: [] };
            }
        });
        const items = Array.from({ length: 6 }, (_, i) => ({ site_key: 's1', vod_id: 'b' + i }));
        await call(sb.app, 'POST', '/api/favorites/status', { body: { items } });
        const s = await sb.fav.runRound();
        // 5 个名额:批1(1)+重试(1)+批2(1)+重试(1)+批3(1)→ 重试被拒;第 4 批起不再发
        ok(s.requests === 5 && seen.length === 3 && grants === 2 && denied === 1, '代理重试也占预算,总数不超 5', { s, seen: seen.length, grants, denied });
        ok(dbb.prepare('SELECT COUNT(*) n FROM fav_watch WHERE next_check <= ?').get(NOW).n === 3, '没轮到的 3 批保持到期,下一轮先查', dbb.prepare('SELECT vod_id, next_check FROM fav_watch').all());
        dbb.close();
    }
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e));
}

// ---------------- ③ lib/popular 单元 ----------------
console.log('③ lib/popular 单元');
try {
    const dbp = new Database(':memory:');
    createUserStats({ db: () => dbp })._ensureSchema();
    const T0 = Date.UTC(2026, 9, 8, 4, 0, 0);
    let PN = T0;
    let on = true;
    const pop = createPopular({ db: () => dbp, enabled: () => on, now: () => PN });
    const ins = dbp.prepare('INSERT INTO watch_stats (user_token, kind, title, episode, seconds, completed, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const w = (u, title, ep, s, ago, kind, c) => ins.run(u, kind || 'vod', title, ep, s, c || 0, T0 - (ago || 0), T0 - (ago || 0));
    const titles = (r) => r.items.map(x => x.title).join();
    const has = (r, t) => r.items.some(x => x.title === t);
    w('u1', '剧A', '第1集', 300, HOUR); w('u2', '剧A', '第1集', 130, 2 * HOUR);
    w('u1', '剧B', '第1集', 5000, HOUR);
    w('u1', '剧C', '第1集', 30, HOUR); w('u2', '剧C', '第1集', 30, HOUR); w('u3', '剧C', '第1集', 30, HOUR);
    w('u1', '剧D', '第1集', 1000, 6 * DAYMS); w('u2', '剧D', '第2集', 900, 6 * DAYMS); w('u2', '剧D', '第3集', 100, 6 * DAYMS, 'vod', 1);
    w('u1', '剧E', '第1集', 500, HOUR); w('ux', '剧E', '第1集', 500, HOUR);
    w('u1', '老剧', '第1集', 9000, 8 * DAYMS); w('u2', '老剧', '第1集', 9000, 8 * DAYMS);
    w('u1', 'CCTV-1', '', 9000, HOUR, 'live'); w('u2', 'CCTV-1', '', 9000, HOUR, 'live');
    w('u1', '剧F', '第1集', 70, HOUR); w('u1', '剧F', '第2集', 70, HOUR); w('u2', '剧F', '第1集', 130, HOUR);
    // 探测攻击(review/pop.js):受害人看了 2537s,攻击者用任意有效令牌上报同名 60s → 以前上榜且 seconds-60 = 受害人时长
    w('victim', '某敏感片', '第1集', 2537, HOUR); w('attacker', '某敏感片', '第1集', 60, 0);
    // 60~119s 的也不算"在看"(门槛从 60 提到 120)
    w('u1', '剧H', '第1集', 100, HOUR); w('u2', '剧H', '第1集', 119, HOUR);
    dbp.prepare("INSERT INTO user_stats (user_token, banned) VALUES ('ux', 1)").run();
    let r = pop.get('u9');   // 调用者 u9 一部都没看过
    ok(r.window === '7d' && titles(r) === '剧D,剧A,剧F', '7 天:除调用者外 ≥2 人、每人 ≥120s、去封禁、去直播、按人数再按时长', r.items);
    ok(r.items.every(x => Object.keys(x).sort().join() === 'kind,title' && x.kind === 'vod'), '只出片名/种类:不出人数/秒数/集数', r.items);
    ok(!has(r, '某敏感片'), '一条 60s 的探测上报凑不出"2 人"', r.items);
    ok(!has(r, '剧H'), '每人 <120s 不算', r.items);
    ok(has(r, '剧F'), '每人累计秒数 ≥120 才算(u1 两集合计 140s)', r.items);
    // S1:调用者自己不算人数 —— u1 看过 D/A/F,对他来说每部都只剩 u2 一个"别人" → 一部都不上榜
    r = pop.get('u1');
    ok(r.items.length === 0, '调用者自己的观看不算人数(u1 看到的榜单里没有"他 + 1 人"看过的剧)', r.items);
    ok(titles(pop.get('u2')) === '' && titles(pop.get('u3')) === '剧D,剧A,剧F', 'u2 同理;u3 只看过不到 120s 的剧C → 照常看到 3 部', [titles(pop.get('u2')), titles(pop.get('u3'))]);
    // 认不出调用者(公开站不带令牌):当他也看过 → 2 人的剧不上榜(不然上报完观看再不带令牌来看,自己那票又算回去)
    ok(pop.get('').items.length === 0 && pop.get(undefined).items.length === 0 && pop.get(null).items.length === 0 && pop.get(['u9']).items.length === 0, '匿名调用者少算 1 人 → 2 人的剧不上榜');
    // 审查探测(review2/srvfix/pop-probe.js):攻击者给"受害人看过的"和"没人看的"各报 120s
    w('attacker', '某敏感片', 'x', 120, 0); w('attacker', '没人看的片', 'x', 120, 0);
    pop.invalidate();
    r = pop.get('attacker');
    ok(!has(r, '某敏感片') && !has(r, '没人看的片'), '探测:攻击者 + 受害人 → 攻击者看不到这部(读不出别人看没看过)', r.items);
    ok(!has(pop.get(''), '某敏感片'), '探测:不带令牌来看也一样');
    w('o2', '某敏感片', '第1集', 300, HOUR);
    pop.invalidate();
    r = pop.get('attacker');
    ok(has(r, '某敏感片') && !has(r, '没人看的片'), '攻击者 + 另外 2 人(受害人、o2)→ 上榜;没人看的片照旧不上', r.items);
    ok(!/victim|attacker|"o2"|"u1"/.test(JSON.stringify(r)), '回包不含任何令牌', r);
    // 排序按"扣掉调用者后"的人数/时长:X={r1,r2,r3} 时长大,Z={r2,r3,r4} 时长小
    w('r1', '排X', '第1集', 9000, HOUR); w('r2', '排X', '第1集', 200, HOUR); w('r3', '排X', '第1集', 200, HOUR);
    w('r2', '排Z', '第1集', 200, HOUR); w('r3', '排Z', '第1集', 200, HOUR); w('r4', '排Z', '第1集', 200, HOUR);
    pop.invalidate();
    const ix = (rr, t) => rr.items.findIndex(x => x.title === t);
    r = pop.get('u9');
    ok(ix(r, '排X') >= 0 && ix(r, '排X') < ix(r, '排Z'), '旁观者:同为 3 人,时长大的 X 在前', r.items);
    r = pop.get('r1');
    ok(ix(r, '排Z') >= 0 && ix(r, '排X') > ix(r, '排Z'), 'r1:X 扣掉他自己(含他的 9000s)只剩 2 人 → 排到 Z 后面', r.items);
    // 缓存:全站一份候选(与调用者无关),10 分钟内不重查
    w('u3', '剧B', '第1集', 500, HOUR);
    ok(!has(pop.get('u9'), '剧B') && !has(pop.get('u5'), '剧B'), '10 分钟缓存内不变(换调用者也是同一份候选)');
    pop.invalidate();
    ok(has(pop.get('u9'), '剧B'), '缓存失效后剧B 上榜');
    {
        let qn = 0;
        const spy = createPopular({ db: () => ({ prepare: (s) => { qn++; return dbp.prepare(s); } }), now: () => PN });
        spy.get('a'); spy.get('b'); spy.get(''); spy.get('u1'); spy.get('r1');
        ok(qn === 1, '五个不同调用者只查一次库', qn);
    }
    // 上限 20
    for (let i = 0; i < 25; i++) { w('u1', '批量' + i, '第1集', 150 + i, HOUR); w('u2', '批量' + i, '第1集', 150, HOUR); }
    pop.invalidate();
    ok(pop.get('u9').items.length === 20, '最多 20 条');
    // 候选只取前 N 部;逐个记的贡献者有上限(maxTrack,下限 = 门槛+1):名单太长的剧按"调用者在里面"少算 1 人
    {
        const dbq = new Database(':memory:');
        createUserStats({ db: () => dbq })._ensureSchema();
        const iq = dbq.prepare('INSERT INTO watch_stats (user_token, kind, title, episode, seconds, completed, first_at, last_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
        const wq = (u, t, s) => iq.run(u, 'vod', t, '第1集', s, T0 - HOUR, T0 - HOUR);
        for (const u of ['b1', 'b2', 'b3', 'b4', 'b5']) wq(u, '大剧', 200);
        for (const u of ['c1', 'c2', 'c3']) wq(u, '中剧', 300);
        wq('c1', '小剧', 500); wq('c2', '小剧', 500);
        const q1 = createPopular({ db: () => dbq, now: () => PN, opts: { candidates: 2, maxTrack: 3 } });
        ok(titles(q1.get('zz')) === '大剧,中剧' && titles(q1.get('b1')) === '大剧,中剧' && titles(q1.get('c1')) === '大剧,中剧', '候选只取前 2 部;5 人的大剧不记名单照常上榜;c1 看中剧还剩 2 人', [titles(q1.get('zz')), titles(q1.get('c1'))]);
        const q2 = createPopular({ db: () => dbq, now: () => PN, opts: { maxTrack: 1 } });
        ok(has(q2.get('zz'), '小剧') && !has(q2.get('c1'), '小剧') && has(q2.get('c1'), '中剧'), 'maxTrack 太小也按下限 3 记名单:2 人剧对旁观者照常上榜、对看过的人不上', [titles(q2.get('zz')), titles(q2.get('c1'))]);
        dbq.close();
    }
    on = false;
    pop.invalidate();
    ok(pop.get('u9').items.length === 0, '统计关闭 → 空');
    const broken = createPopular({ db: () => new Database(':memory:') });
    ok(broken.get('u9').items.length === 0 && broken.get('u9').window === '7d', '表不存在 → 空不抛');
    // 路由:公开站(没配访问密码)不要令牌;window 参数照收照忽略(只有 7 天)
    const app = mkApp();
    on = true;
    pop.registerRoutes(app);
    const rr = await call(app, 'GET', '/api/popular', { query: { window: '1d' } });
    ok(rr.body && rr.body.window === '7d' && Array.isArray(rr.body.items) && /private/.test(rr.headers['Cache-Control']) && /max-age/.test(rr.headers['Cache-Control']), '/api/popular 路由(公开站):1d 窗口没了,固定 7d', rr.body);
    ok(has(rr.body, '某敏感片') && !has(rr.body, '剧A'), '公开站不带令牌 = 匿名:3 人的剧上榜,2 人的不上', rr.body.items);
    // 私密站:要有效令牌;封禁 403;没看过的调用者看到同一份,看过的扣掉自己
    const okTk = new Set(['tk1', 'tk2', 'tkb', 'u1']);
    const priv = createPopular({ db: () => dbp, now: () => PN, authRequired: () => true, tokenOk: (t) => okTk.has(t), isBanned: (t) => t === 'tkb' });
    const app2 = mkApp();
    priv.registerRoutes(app2);
    let pr = await call(app2, 'GET', '/api/popular', { query: {} });
    ok(pr.statusCode === 401 && pr.body.ok === false && pr.body.error === 'auth' && pr.body.items === undefined, '私密站无令牌 → 401', pr.body);
    pr = await call(app2, 'GET', '/api/popular', { query: { token: 'constructor' } });
    ok(pr.statusCode === 401, '私密站非法令牌 → 401', pr.statusCode);
    pr = await call(app2, 'GET', '/api/popular', { query: { token: 'tkb' } });
    ok(pr.statusCode === 403 && pr.body.banned === true, '私密站封禁 → 403', pr.body);
    pr = await call(app2, 'GET', '/api/popular', { query: { token: 'tk1', window: '7d' } });
    const pr2 = await call(app2, 'GET', '/api/popular', { query: { token: 'tk2', window: '1d' } });
    ok(pr.statusCode === 200 && pr.body.items.length > 0 && JSON.stringify(pr.body) === JSON.stringify(pr2.body), '私密站有效令牌 → 200,没看过的调用者同一份结果(window 参数不影响)', pr.body);
    const pr3 = await call(app2, 'GET', '/api/popular', { query: { token: 'u1' } });
    ok(has(pr.body, '剧D') && !has(pr3.body, '剧D') && !has(pr3.body, '剧A'), '私密站:u1 的榜单扣掉他自己(剧D/剧A 只剩 1 个别人)', pr3.body.items);
    // 审查探测原样复现(review2/srvfix/pop-probe.js):私密站,只有攻击者 + 受害人
    {
        const dbx = new Database(':memory:');
        createUserStats({ db: () => dbx })._ensureSchema();
        const ix2 = dbx.prepare('INSERT INTO watch_stats (user_token, kind, title, episode, seconds, completed, first_at, last_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
        ix2.run('victim', 'vod', '某敏感片', '第1集', 2537, PN - HOUR, PN - HOUR);
        ix2.run('attacker', 'vod', '某敏感片', 'x', 120, PN, PN);
        ix2.run('attacker', 'vod', '没人看的片', 'x', 120, PN, PN);
        const valid = new Set(['attacker', 'victim', 'other1']);
        const pp = createPopular({ db: () => dbx, now: () => PN, authRequired: () => true, tokenOk: (t) => valid.has(t), isBanned: () => false });
        const appx = mkApp();
        pp.registerRoutes(appx);
        let x = await call(appx, 'GET', '/api/popular', { query: { window: '1d', token: 'attacker' } });
        ok(x.statusCode === 200 && x.body.window === '7d' && !has(x.body, '某敏感片') && !has(x.body, '没人看的片'), 'pop-probe:攻击者 + 受害人 → 攻击者 1d/7d 都看不到这部', x.body);
        x = await call(appx, 'GET', '/api/popular', { query: { window: '7d', token: 'attacker' } });
        ok(!has(x.body, '某敏感片'), 'pop-probe:7d 同样看不到', x.body);
        ix2.run('other1', 'vod', '某敏感片', '第1集', 300, PN - HOUR, PN - HOUR);
        pp.invalidate();
        x = await call(appx, 'GET', '/api/popular', { query: { token: 'attacker' } });
        ok(has(x.body, '某敏感片') && !has(x.body, '没人看的片'), 'pop-probe:攻击者 + 另外 2 人(受害人、other1)→ 上榜', x.body);
        ok(!/victim|attacker|other1/.test(JSON.stringify(x.body)), 'pop-probe:回包不含令牌', x.body);
        dbx.close();
    }
    dbp.close();
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e));
}

// ---------------- ④ 端到端 ----------------
console.log('④ server.js 端到端');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'favorites-'));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));
// 资源站配置指向本地假站(带 BOM:db.json 由 PowerShell 保存时就是这样)
fs.writeFileSync(path.join(tmp, 'db.json'), '﻿' + JSON.stringify({ sites: [
    { key: 'mock1', name: '假站1', api: M.base + '/mock1/api.php/provide/vod', active: true },
    { key: 'mock2', name: '假站2', api: M.base + '/mock2/api.php/provide/vod', active: true },
] }, null, 2));

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
            FAV_CHECK_DISABLE: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: ''
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
    const headers = Object.assign({}, o.headers || {});
    let body;
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
    const r = await fetch(base() + p, { method, headers, body, redirect: 'manual' });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { }
    return { status: r.status, j, txt };
}
const ADM = { 'x-admin-token': 'adm' };
const E = { main: sha('mainpw'), alice: sha('alice'), bob: sha('bob') };
const dbFile = path.join(tmp, 'cache.db');

try {
    M.set('mock1', '1001', 5, '更新至5集', '端到端剧A');
    M.set('mock1', '1002', 5, '更新至5集', '端到端剧B');
    M.set('mock1', '1003', 2);
    M.set('mock2', '2001', 30, '全30集');
    M.reset();
    await startServer();
    let r = await api('GET', '/api/config?token=' + E.alice);
    ok(r.j && r.j.favorites_enabled === true && r.j.push_enabled === true, '/api/config 收藏/推送开关', r.j && [r.j.favorites_enabled, r.j.push_enabled]);
    r = await api('GET', '/api/favorites?token=' + E.alice);
    ok(r.status === 200 && r.j.enabled === true && r.j.limit === 100 && r.j.items.length === 0, '空收藏', r.j);
    ok((await api('GET', '/api/favorites?token=constructor')).status === 401, '原型键 token 401');
    ok((await api('GET', '/api/favorites?token=nope')).status === 401, '非法 token 401');
    const add = (tk, it) => api('POST', '/api/favorites/add', { json: { token: tk, item: it } });
    const mk = (name, site, vid, extra) => Object.assign({ name, checkSource: site ? { site_key: site, vod_id: vid, site_name: site } : null, sources: site ? [{ site_key: site, vod_id: vid, site_name: site }] : [] }, extra || {});
    r = await add(E.alice, mk('端到端剧A', 'mock1', '1001', { addedEpCount: 3 }));
    ok(r.j && r.j.ok === true && r.j.fav_id === '端到端剧A', 'alice 加收藏', r.j);
    r = await add(E.bob, mk('端到端剧B', 'mock1', '1002'));
    ok(r.j && r.j.ok === true, 'bob 加收藏');
    r = await add(E.main, mk('主密码剧', 'mock2', '2001'));
    ok(r.j && r.j.ok === true, '主密码(非同步用户)也能用服务器收藏', r.j);
    r = await api('POST', '/api/favorites/status', { json: { items: [{ site_key: 'mock1', vod_id: '1009' }] } });
    ok(r.status === 401 && r.j && r.j.ok === false, '私密站:匿名 status 不带令牌 → 401', r.j);
    r = await api('POST', '/api/favorites/status', { json: { token: E.main, items: [{ site_key: 'mock1', vod_id: '1003' }, { site_key: 'mock2', vod_id: '2001' }, { site_key: 'mockX', vod_id: '1' }] } });
    ok(r.j && r.j.enabled === true && Object.keys(r.j.status).length === 0, '匿名 status(主密码令牌):未检查 → 空', r.j);
    ok((await api('POST', '/api/admin/favorites/check')).status === 403, '手动检查要站长令牌');
    r = await api('POST', '/api/admin/favorites/check', { headers: ADM });
    ok(r.j && r.j.ok === true && r.j.due === 4 && r.j.requests === 2 && r.j.checked === 4 && r.j.failed === 0, '站长手动跑一轮:4 个 → 2 个请求', r.j);
    const det = M.log.filter(x => x.ac === 'detail');
    ok(det.length === 2 && det.every(x => x.ids.length <= 20) && det.find(x => x.site === 'mock1').ids.sort().join() === '1001,1002,1003', '同站合并成一个批量详情请求', det.map(x => [x.site, x.ids]));
    ok(!M.log.some(x => /m3u8/i.test(x.path)) && M.log.every(x => x.ac === 'detail'), '服务器只请求了详情 API,没碰 m3u8', M.log.map(x => x.path + '?' + x.ac));
    r = await api('GET', '/api/favorites?token=' + E.alice);
    let A = r.j.items[0];
    ok(A.status && A.status.ep_count === 5 && A.status.latest_ep === '第05集' && A.has_update === true && A.seen_count === 3, 'alice:5 集 > 已看 3 → 红点', A);
    r = await api('POST', '/api/favorites/seen', { json: { token: E.alice, fav_id: '端到端剧A', count: 5 } });
    ok(r.j && r.j.ok && r.j.seen_count === 5, 'seen', r.j);
    r = await api('GET', '/api/favorites?token=' + E.alice);
    ok(r.j.items[0].has_update === false, '清红点');
    r = await api('GET', '/api/favorites?token=' + E.bob);
    ok(r.j.items[0].has_update === false && r.j.items[0].seen_count === 5, 'bob:基线不误报', r.j.items[0]);
    r = await api('POST', '/api/favorites/status', { json: { token: E.main, items: [{ site_key: 'mock1', vod_id: '1003' }, { site_key: 'mock2', vod_id: '2001' }] } });
    ok(r.j.status['mock1|1003'] && r.j.status['mock1|1003'].ep_count === 2 && r.j.status['mock2|2001'].finished === true, '匿名 status 返回状态', r.j.status);
    // 更新:改假站集数 + 让它到期 → 手动跑一轮
    M.set('mock1', '1002', 6, '更新至6集', '端到端剧B');
    // 推送钩子探针:给 bob/alice 各塞一条非法地址的订阅 —— 推送一触发,发前校验就删掉它(全程不碰外网)
    const P256 = 'B' + 'A'.repeat(86), AUTH = 'A'.repeat(22);
    {
        const dbf = new Database(dbFile);
        dbf.prepare("UPDATE fav_watch SET next_check = 0 WHERE site_key = 'mock1'").run();
        const ins = dbf.prepare('INSERT INTO push_subs (user_token, endpoint, p256dh, auth, created_at, fails) VALUES (?, ?, ?, ?, ?, 0)');
        ins.run(E.bob, 'https://probe.invalid/bob', P256, AUTH, Date.now());
        ins.run(E.alice, 'https://probe.invalid/alice', P256, AUTH, Date.now());
        dbf.close();
    }
    M.reset();
    r = await api('POST', '/api/admin/favorites/check', { headers: ADM });
    ok(r.j && r.j.changed === 1 && r.j.requests === 1, '集数变多被发现', r.j);
    {
        const dbr = new Database(dbFile, { readonly: true });
        const left = dbr.prepare("SELECT endpoint FROM push_subs WHERE endpoint LIKE 'https://probe.invalid/%'").all().map(x => x.endpoint);
        dbr.close();
        ok(left.join() === 'https://probe.invalid/alice', '更新 → 只给收藏了它的 bob 触发推送', left);
    }
    r = await api('GET', '/api/favorites?token=' + E.bob);
    ok(r.j.items[0].has_update === true && r.j.items[0].status.ep_count === 6 && r.j.items[0].status.changed_at > 0, 'bob 看到更新', r.j.items[0]);
    {
        const dbr = new Database(dbFile, { readonly: true });
        const row = dbr.prepare("SELECT next_check, checked_at FROM fav_watch WHERE site_key = 'mock1' AND vod_id = '1002'").get();
        ok(row.next_check - row.checked_at === 2 * HOUR, '有变化 → 2h 后', row);
        dbr.close();
    }
    // 上限 100
    let last = null;
    for (let i = 0; i < 100; i++) { last = await add(E.alice, mk('满' + i, null)); if (!(last.j && last.j.ok)) break; }
    ok(last.j && last.j.ok === false && last.j.error === 'limit' && last.j.limit === 100, 'HTTP:第 101 部 → limit', last.j);
    r = await api('POST', '/api/favorites/remove', { json: { token: E.alice, fav_id: '满0' } });
    ok(r.j && r.j.ok && r.j.removed === 1, 'HTTP 删除', r.j);
    // 大家都在看(经真实上报接口)
    const watch = (tk, batch, items) => api('POST', '/api/stats/watch', { json: { token: tk, batch, items } });
    await watch(E.alice, 'popbatch-a1', [{ k: 'vod', t: '大家剧', e: '第1集', s: 200 }, { k: 'vod', t: '独看剧', e: '第1集', s: 900 }, { k: 'vod', t: '探测剧', e: '第1集', s: 3000 }, { k: 'vod', t: '两人剧', e: '第1集', s: 300 }]);
    await watch(E.bob, 'popbatch-b1', [{ k: 'vod', t: '大家剧', e: '第2集', s: 150 }, { k: 'vod', t: '探测剧', e: '第1集', s: 60 }, { k: 'vod', t: '两人剧', e: '第1集', s: 300 }]);
    await watch(E.main, 'popbatch-m1', [{ k: 'vod', t: '大家剧', e: '第1集', s: 400 }]);
    r = await api('GET', '/api/popular');
    ok(r.status === 401 && r.j && r.j.error === 'auth', '私密站:/api/popular 不带令牌 → 401', r.j);
    r = await api('GET', '/api/popular?token=' + E.bob);
    ok(r.j && r.j.window === '7d' && r.j.items.map(x => x.title).join() === '大家剧' && Object.keys(r.j.items[0]).sort().join() === 'kind,title', '/api/popular:除调用者外 ≥2 人(每人 ≥120s)才上榜,只给片名(bob 看两人剧只剩 alice 一个别人)', r.j);
    r = await api('GET', '/api/popular?window=1d&token=' + E.main);
    ok(r.j && r.j.window === '7d' && r.j.items.map(x => x.title).join() === '两人剧,大家剧', '/api/popular?window=1d → 只有 7 天;主密码没看过两人剧 → alice+bob 两个别人,上榜', r.j);
    // 匿名 status 每 IP 30 次/分(前面已用 3 次,含一次 401)
    let got429 = false, okCount = 3;
    for (let i = 0; i < 31 && !got429; i++) {
        const x = await api('POST', '/api/favorites/status', { json: { token: E.main, items: [] } });
        if (x.status === 429) got429 = true; else okCount++;
    }
    ok(got429 && okCount === 30, '匿名 status 限流 30 次/分', okCount);
    ok(!/\[Favorites\]|\[Popular\]|\[WebPush\][^\n]*(失败|Error)|TypeError|ReferenceError/.test(allLog), '服务端日志无收藏/推送模块告警', allLog.slice(-1500));
    await stopServer();

    // FAV_CHECK_DISABLE:收藏照常,检查不跑
    await startServer({ FAV_CHECK_DISABLE: '1' });
    r = await api('POST', '/api/admin/favorites/check', { headers: ADM });
    ok(r.j && r.j.ok === false && r.j.error === 'disabled', 'FAV_CHECK_DISABLE=1 → 不检查', r.j);
    r = await api('GET', '/api/favorites?token=' + E.alice);
    ok(r.j && r.j.enabled === true && r.j.items.length === 99, 'FAV_CHECK_DISABLE=1 收藏照常(重启后数据还在)', r.j && r.j.items.length);
    await stopServer();
    // FAV_CHECK_DISABLE=0 是"不关"(envFlag 口径)
    await startServer({ FAV_CHECK_DISABLE: '0' });
    r = await api('POST', '/api/admin/favorites/check', { headers: ADM });
    ok(r.j && r.j.ok === true, 'FAV_CHECK_DISABLE=0 → 照常检查', r.j);
    await stopServer();

    // 只让指定的 (站, 片) 到期,其余推到很远
    const dueOnly = (pairs) => {
        const dbw = new Database(dbFile);
        dbw.prepare('UPDATE fav_watch SET next_check = ?').run(Date.now() + 100 * DAYMS);
        const u = dbw.prepare('UPDATE fav_watch SET next_check = 0 WHERE site_key = ? AND vod_id = ?');
        for (const [s, v] of pairs) u.run(s, v);
        dbw.close();
    };
    const watchRow = (s, v) => { const d = new Database(dbFile, { readonly: true }); try { return d.prepare('SELECT * FROM fav_watch WHERE site_key = ? AND vod_id = ?').get(s, v); } finally { d.close(); } };

    // S8:后台检查走 bg 分支 —— 慢站不做"代理对比"、直连失败的代理重试计入请求数、绝不写共享代理记忆;交互请求行为不变
    await startServer({ CORS_PROXY_URL: M.base + '/proxy' });
    dueOnly([['mock1', '1001'], ['mock2', '2001']]);
    M.slowSites.set('mock1', 1700); M.failSites.add('mock2');
    M.reset();
    r = await api('POST', '/api/admin/favorites/check', { headers: ADM });
    const prox = M.log.filter(x => x.proxied);
    ok(r.j && r.j.requests === 3 && r.j.checked === 2 && r.j.failed === 0, '后台:2 批 + 1 次代理重试 = 3 个请求(重试计入预算)', r.j);
    ok(prox.length === 1 && prox[0].site === 'mock2' && !M.log.some(x => x.site === 'mock1' && x.proxied), '后台:慢站不做代理对比;只有直连失败的站走了一次代理', M.log.map(x => x.site + (x.proxied ? '(代理)' : '(直连)')));
    M.reset();
    await api('GET', '/api/detail?id=2001&site_key=mock2&nocache=1');
    ok(M.log.length >= 1 && M.log[0].site === 'mock2' && M.log[0].proxied === false, '后台没写代理记忆 → 用户请求 mock2 仍先直连', M.log.map(x => x.site + (x.proxied ? '(代理)' : '(直连)')));
    M.reset();
    await api('GET', '/api/detail?id=1001&site_key=mock1&nocache=1');
    ok(M.log.some(x => x.site === 'mock1' && !x.proxied) && M.log.some(x => x.site === 'mock1' && x.proxied), '交互请求不变:慢站照旧直连 → 代理对比', M.log.map(x => x.site + (x.proxied ? '(代理)' : '(直连)')));
    // 两个站现在都被交互请求记成"要代理" → 后台只读这份记忆,直接走代理、不先直连
    dueOnly([['mock1', '1001'], ['mock2', '2001']]);
    M.reset();
    r = await api('POST', '/api/admin/favorites/check', { headers: ADM });
    ok(r.j && r.j.requests === 2 && r.j.checked === 2 && M.log.length === 2 && M.log.every(x => x.proxied), '后台读代理记忆:已知要代理的站直接走代理', M.log.map(x => x.site + (x.proxied ? '(代理)' : '(直连)')));
    M.slowSites.clear(); M.failSites.clear();
    await stopServer();

    // S6:REMOTE_DB_URL —— 重启后还没人调过 /api/sites,后台检查也要先拉远程配置(以前用本地模板 → 全部到期行推迟 24h)
    const localDbJson = fs.readFileSync(path.join(tmp, 'db.json'));
    try {
        fs.writeFileSync(path.join(tmp, 'db.json'), JSON.stringify({ sites: [{ key: 'tpl', name: '模板占位', api: '', active: true }] }));
        M.remote.body = { sites: [
            { key: 'mock1', name: '假站1', api: M.base + '/mock1/api.php/provide/vod', active: true },
            { key: 'mock2', name: '假站2', api: M.base + '/mock2/api.php/provide/vod', active: true },
        ] };
        M.remote.fail = false; M.remote.hits = 0;
        dueOnly([['mock1', '1001'], ['mock2', '2001']]);
        await startServer({ REMOTE_DB_URL: M.base + '/remote/db.json' });
        M.reset();
        r = await api('POST', '/api/admin/favorites/check', { headers: ADM });
        ok(r.j && r.j.checked === 2 && r.j.skipped === 0 && M.remote.hits >= 1 && watchRow('mock1', '1001').next_check < Date.now() + 5 * HOUR, '远程配置没加载过 → 后台先拉远程配置再查,不推迟', [r.j, M.remote.hits]);
        await stopServer();
        // 远程配置拉不到:整轮跳过,行一个都不动
        M.remote.fail = true;
        dueOnly([['mock1', '1001'], ['mock2', '2001']]);
        await startServer({ REMOTE_DB_URL: M.base + '/remote/db.json' });
        M.reset();
        r = await api('POST', '/api/admin/favorites/check', { headers: ADM });
        ok(r.j && r.j.no_sites === true && r.j.skipped === 0 && r.j.requests === 0 && watchRow('mock1', '1001').next_check === 0 && watchRow('mock2', '2001').next_check === 0, '远程配置拉不到 → 本轮跳过、不推迟任何行', r.j);
        // /api/sites 行为不变:拉不到 → 回退本地 db.json
        r = await api('GET', '/api/sites');
        ok(r.j && Array.isArray(r.j.sites) && r.j.sites.some(s => s.key === 'tpl') && !r.j.sites.some(s => s.key === 'mock1'), '/api/sites 远程失败 → 回退本地', r.j && r.j.sites);
        M.remote.fail = false;
        r = await api('GET', '/api/sites');
        ok(r.j && r.j.sites && r.j.sites.some(s => s.key === 'mock1'), '/api/sites 远程恢复 → 用远程配置', r.j && r.j.sites && r.j.sites.map(s => s.key));
        await stopServer();
    } finally {
        fs.writeFileSync(path.join(tmp, 'db.json'), localDbJson);
    }

    // 公开站(没配访问密码):/api/popular 与匿名 status 照旧不要令牌
    await startServer({ ACCESS_PASSWORD: '' });
    r = await api('GET', '/api/popular');
    ok(r.status === 200 && r.j && Array.isArray(r.j.items), '公开站 /api/popular 不要令牌', r.j);
    r = await api('POST', '/api/favorites/status', { json: { items: [{ site_key: 'mock1', vod_id: '1003' }] } });
    ok(r.status === 200 && r.j && r.j.enabled === true && r.j.status['mock1|1003'], '公开站匿名 status 不要令牌', r.j);
    await stopServer();
    // 没 SQLite:一律降级
    await startServer({ CACHE_TYPE: 'json' });
    r = await api('GET', '/api/config?token=' + E.alice);
    ok(r.j && r.j.favorites_enabled === false && r.j.push_enabled === false, 'json 缓存 → 收藏/推送关闭', r.j && [r.j.favorites_enabled, r.j.push_enabled]);
    r = await api('GET', '/api/favorites?token=' + E.alice);
    ok(r.j && r.j.enabled === false && r.j.items.length === 0, 'json 缓存 → GET enabled:false', r.j);
    r = await api('POST', '/api/favorites/status', { json: { items: [{ site_key: 'mock1', vod_id: '1' }] } });
    ok(r.j && r.j.enabled === false, 'json 缓存 → status enabled:false', r.j);
    r = await api('GET', '/api/popular?token=' + E.alice);
    ok(r.j && r.j.items.length === 0, 'json 缓存 → popular 空', r.j);
    ok(!/TypeError|ReferenceError/.test(srvLog), 'json 模式无异常', srvLog.slice(-800));
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e) + '\n' + srvLog.slice(-1500));
} finally {
    await stopServer();
    await M.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

// 静态:Vercel 桩
{
    const vsrc = fs.readFileSync(path.join(ROOT, 'api/index.js'), 'utf8');
    ok(/favorites_enabled:\s*false/.test(vsrc) && /push_enabled:\s*false/.test(vsrc), 'api/index.js /api/config 关收藏/推送');
    ok(/app\.get\('\/api\/favorites'/.test(vsrc) && /'\/api\/favorites\/status'/.test(vsrc) && /app\.get\('\/api\/popular'/.test(vsrc) && /app\.get\('\/api\/push\/key'/.test(vsrc), 'api/index.js 有收藏/推送/popular 桩');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
