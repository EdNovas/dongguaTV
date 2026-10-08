// 弹幕服务器缓存回归:node scripts/danmaku-cache-test.mjs
//  ① lib/danmaku-store 单元(假时钟 + SQLite 内存库):新鲜/过期、gzip 落盘与重开、热层字节 LRU、容量淘汰、并发合并、重抓退避
//  ② 端到端:临时目录里起真正的 server.js(CACHE_TYPE=sqlite)+ 假 danmu_api(数请求次数):
//     并发合并成一次回源 / 重启后不回源 / 过期先回旧的再后台重抓 / 重抓拿到空不冲掉旧的 / 空结果与低置信不落盘、缓存头正确
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };   // worktree 没有 node_modules 时走 NODE_PATH
const Database = dep('better-sqlite3');
const { createStore } = require(path.join(ROOT, 'lib/danmaku-store'));

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mkData = (n, tag) => Array.from({ length: n }, (_, i) => [i * 0.5, 0, 16777215, 'u', (tag || 'x') + i]);

// ---------------- ① 单元 ----------------
{
    console.log('① lib/danmaku-store');
    let t = 1e12;
    const db = new Database(':memory:');
    const st = createStore({ db: () => db, now: () => t, freshMs: 1000, memBytes: 1e6, maxBytes: 1e9 });
    ok(st.get('a') === null, '未命中返回 null');
    const json = st.put('a', mkData(100, 'A'));
    ok(JSON.parse(json).data.length === 100 && JSON.parse(json).code === 0, 'put 返回 DPlayer v3 响应 JSON');
    let h = st.get('a');
    ok(h && h.fresh && h.n === 100 && h.json === json, '刚存的是新鲜的');
    t += 1500;
    h = st.get('a');
    ok(h && !h.fresh, '过了 freshMs 变成不新鲜(仍返回旧的)');
    const row = db.prepare('SELECT n, bytes, length(gz) l FROM danmaku_store WHERE k = ?').get('a');
    ok(row && row.n === 100 && row.bytes === row.l && row.l < json.length, '持久层存的是 gzip(比原文小)');
    // 新实例(冷内存)从 SQLite 读回
    const st2 = createStore({ db: () => db, now: () => t, freshMs: 1000 });
    const h2 = st2.get('a');
    ok(h2 && h2.json === json && h2.n === 100, '重开实例后从 SQLite 读回同一份');
    // db=null → 只用内存
    const st3 = createStore({ db: null, now: () => t });
    st3.put('m', mkData(3));
    ok(st3.get('m') && st3.stats().persistent === false, '无数据库时只用内存');
    // 热层字节 LRU
    const st4 = createStore({ db: null, now: () => t, memBytes: 20000 });
    for (let i = 0; i < 20; i++) st4.put('k' + i, mkData(50, 'L' + i));
    ok(st4.stats().memBytes <= 20000 && st4.get('k0') === null && st4.get('k19') !== null, '热层超字节上限淘汰最旧的');
    // 容量淘汰(按 accessed_at)
    const db5 = new Database(':memory:');
    let t5 = 1e12;
    const st5 = createStore({ db: () => db5, now: () => t5, maxBytes: 1, pruneEveryMs: 0, memBytes: 1e7 });
    for (let i = 0; i < 5; i++) { t5 += 10; st5.put('p' + i, mkData(200, 'P' + i)); }
    const left = db5.prepare('SELECT COUNT(*) c FROM danmaku_store').get().c;
    ok(left <= 1, '超出持久层容量会按最久未访问淘汰(剩 ' + left + ')');
    // 并发合并
    let calls = 0;
    const fn = async () => { calls++; await sleep(30); return 7; };
    const rs = await Promise.all([st.once('z', fn), st.once('z', fn), st.once('z', fn)]);
    ok(calls === 1 && rs.every(x => x === 7), '同键并发只执行一次');
    await st.once('z', fn);
    ok(calls === 2, '上一次结束后再调会重新执行');
    // 重抓退避
    ok(st.refreshAllowed('r'), '没失败过可以重抓');
    st.refreshFailed('r');
    ok(!st.refreshAllowed('r'), '刚失败过不重抓');
    t += 3600e3 + 1;
    ok(st.refreshAllowed('r'), '退避期过了可以再重抓');
}

// ---------------- ② 端到端 ----------------
console.log('② server.js 端到端');
const mock = { search: 0, comment: 0, byId: 0, round: 1, empty: false, delay: 0, idMixup: false, noUrl: false };
const upstream = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (mock.delay) await sleep(mock.delay);
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/tk/api/v2/search/episodes') {
        mock.search++;
        const anime = u.searchParams.get('anime') || '';
        if (mock.empty || anime === '不存在的剧') return res.end(JSON.stringify({ animes: [] }));
        // "沾边剧" 只给一个名字包含它的条目 → 包含档 = 低置信
        const animeTitle = anime === '沾边剧' ? '沾边剧风云再起 from qiyi' : anime + ' from qiyi';
        return res.end(JSON.stringify({ animes: [{ animeTitle, episodes: [1, 2, 3].map(n => ({ episodeId: 1000 + n, episodeTitle: '第' + n + '集', url: 'https://v.qq.com/x/cover/' + encodeURIComponent(anime) + '/' + n + '.html' })) }] }));
    }
    // 按视频地址取(无状态);老版本 danmu_api 不认 ?url= → 400
    if (u.pathname === '/tk/api/v2/comment') {
        if (mock.noUrl || !u.searchParams.get('url')) { res.statusCode = 400; return res.end(JSON.stringify({ errorCode: 400, success: false, errorMessage: 'Missing commentId or url parameter' })); }
        // 按地址取时上游临时失败(429/5xx):不能退回按 id(那条路多实例会串剧)
        if (mock.urlFail) { res.statusCode = mock.urlFail; return res.end(JSON.stringify({ errorCode: mock.urlFail, success: false, errorMessage: 'Too many requests' })); }
        mock.comment++;
        const n = mock.empty ? 0 : (mock.round === 1 ? 120 : 150);
        return res.end(JSON.stringify({ count: n, comments: Array.from({ length: n }, (_, i) => ({ p: `${i},1,16777215,[qiyi]`, m: 'r' + mock.round + '-' + i })) }));
    }
    // 按 id 取:多实例时同一个号会指向别的剧(idMixup 模拟线上实锤的串剧)
    const m = u.pathname.match(/^\/tk\/api\/v2\/comment\/(\d+)$/);
    if (m) {
        mock.comment++; mock.byId++;
        if (mock.idMixup) return res.end(JSON.stringify({ count: 50, comments: Array.from({ length: 50 }, (_, i) => ({ p: `${i},1,16777215,[qiyi]`, m: 'WRONG-SHOW-' + i })) }));
        const n = mock.empty ? 0 : (mock.round === 1 ? 120 : 150);
        return res.end(JSON.stringify({ count: n, comments: Array.from({ length: n }, (_, i) => ({ p: `${i},1,16777215,[qiyi]`, m: 'r' + mock.round + '-' + i })) }));
    }
    res.statusCode = 404; res.end('{}');
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;

// 临时目录里跑一份 server.js(cache.db 写在它自己的目录,不碰仓库里的)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-cache-'));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));

const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
let srv = null, port = 0;
async function startServer(extraEnv) {
    port = 20000 + Math.floor(Math.random() * 20000);
    srv = spawn(process.execPath, ['server.js'], {
        cwd: tmp,
        env: Object.assign({}, process.env, { NODE_PATH, PORT: String(port), CACHE_TYPE: 'sqlite', DANMU_API_URL: 'http://127.0.0.1:' + upPort, DANMU_API_TOKEN: 'tk', ACCESS_PASSWORD: '', ADMIN_TOKEN: '', LIVE_TV_DISABLED: '1', KAZUMI_DISABLE: '1', CORS_PROXY_URL: '', REMOTE_DB_URL: '' }, extraEnv || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    srv.stdout.on('data', d => { log += d; });
    srv.stderr.on('data', d => { log += d; });
    for (let i = 0; i < 100; i++) {
        await sleep(100);
        try { const r = await fetch(`http://127.0.0.1:${port}/api/debug`); if (r.ok) return; } catch (e) { }
    }
    throw new Error('server did not start:\n' + log.slice(-2000));
}
async function stopServer() {
    if (!srv) return;
    const p = new Promise(r => srv.once('exit', r));
    srv.kill(); await p; srv = null;
}
const get = async (id) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/danmaku/v3/?id=${encodeURIComponent(id)}`);
    const j = await r.json();
    return { n: (j.data || []).length, first: j.data && j.data[0] && j.data[0][4], cc: r.headers.get('cache-control') || '' };
};

try {
    await startServer();
    // 并发 8 个同一集 → 只回源一次
    mock.delay = 150;
    const rs = await Promise.all(Array.from({ length: 8 }, () => get('兰香如故|第1集|v4')));
    mock.delay = 0;
    ok(rs.every(r => r.n === 120), '并发请求都拿到弹幕');
    ok(mock.comment === 1, '8 个并发只回源一次(实际 comment 请求 ' + mock.comment + ' 次)');
    ok(rs.every(r => /max-age=604800/.test(r.cc)), '高贴合非空 → 7 天缓存头');
    const c1 = mock.comment;
    const again = await get('兰香如故|第1集|v4');
    ok(again.n === 120 && mock.comment === c1, '再请求命中服务器缓存,不回源');

    // 重启后仍命中(持久化)
    await stopServer();
    await startServer();
    const afterRestart = await get('兰香如故|第1集|v4');
    ok(afterRestart.n === 120 && mock.comment === c1, '重启后命中持久缓存,不回源');
    ok(/max-age=604800/.test(afterRestart.cc), '持久缓存命中也给 7 天缓存头');

    // 空结果:不落盘、no-store
    const e1 = await get('不存在的剧|第1集|v4');
    ok(e1.n === 0 && /no-store/.test(e1.cc), '空结果 no-store');

    // 低置信(包含档):10 分钟缓存头、第二次从短缓存出也还是 10 分钟(旧版这里会给 7 天)
    const l1 = await get('沾边剧|第1集|v4');
    const l2 = await get('沾边剧|第1集|v4');
    ok(l1.n > 0 && /max-age=600\b/.test(l1.cc), '低置信结果只给 10 分钟缓存头(' + l1.cc + ')');
    ok(l2.n === l1.n && /max-age=600\b/.test(l2.cc), '低置信结果再次命中也只给 10 分钟(' + l2.cc + ')');

    // 持久层只存了高贴合那一份
    await stopServer();
    const dbf = new Database(path.join(tmp, 'cache.db'), { readonly: true });
    const keys = dbf.prepare('SELECT k FROM danmaku_store').all().map(r => r.k);
    dbf.close();
    ok(keys.length === 1 && /兰香如故\|第1集$/.test(keys[0]), '只有高贴合非空结果落盘(' + keys.join(', ') + ')');

    // 按 id 取会串剧(线上实锤)→ 必须按视频地址取
    await startServer();
    mock.idMixup = true;
    const byIdBefore = mock.byId;
    const mixed = await get('串剧测试|第2集|v5|t:国产剧|y:2025|n:30');
    ok(mixed.n > 0 && /^r\d-/.test(mixed.first || '') && mock.byId === byIdBefore, '按视频地址取弹幕,不走会串剧的 id(拿到 ' + mixed.first + ')');
    // 按地址取遇到 429 → 跳过,绝不退回按 id
    mock.urlFail = 429;
    const byIdBefore429 = mock.byId;
    const r429 = await get('限流测试|第1集|v5|k:tv|y:2025|n:30');
    ok(r429.n === 0 && mock.byId === byIdBefore429 && /no-store/.test(r429.cc), '按地址取 429 时不退回按 id(宁可这次没弹幕)');
    mock.urlFail = 0;
    // 老版本 danmu_api 不认 ?url= → 退回按 id,但结果只当低置信(no-store、不落盘)
    mock.noUrl = true;
    const legacy = await get('老版本测试|第1集|v5|t:国产剧|y:2025|n:30');
    ok(legacy.n > 0 && mock.byId > byIdBefore && /no-store/.test(legacy.cc), '不支持按地址取时退回按 id,结果 no-store 不缓存(' + legacy.cc + ')');
    mock.noUrl = false; mock.idMixup = false;
    await stopServer();

    // 过期:先回旧的,后台重抓;重抓拿到新的就替换
    await startServer({ DANMAKU_CACHE_DAYS: '0.00001' });   // ≈0.86s 新鲜期
    await sleep(1200);
    mock.round = 2;
    const cBefore = mock.comment;
    const stale = await get('兰香如故|第1集|v4');
    ok(stale.n === 120 && stale.first === 'r1-0', '过期仍先回旧的(秒开)');
    await sleep(800);
    ok(mock.comment === cBefore + 1, '过期命中触发一次后台重抓');
    const fresh = await get('兰香如故|第1集|v4');
    ok(fresh.n === 150 && fresh.first === 'r2-0', '后台重抓成功后换成新的');

    // 过期后重抓拿到空 → 保留旧的,且一小时内不再重抓
    await sleep(1200);
    mock.empty = true;
    const c2 = mock.comment, s2 = mock.search;
    const keep = await get('兰香如故|第1集|v4');
    ok(keep.n === 150, '重抓前先回旧的');
    await sleep(4500);   // 全空会等 3s 再赛一轮
    const keep2 = await get('兰香如故|第1集|v4');
    ok(keep2.n === 150, '重抓拿到空不冲掉旧弹幕');
    const s3 = mock.search;
    await get('兰香如故|第1集|v4');
    await sleep(300);
    ok(mock.search === s3, '重抓失败后一小时内不再重抓');
    ok(s3 > s2 || mock.comment > c2, '确实发起过重抓');
    mock.empty = false;
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e));
} finally {
    await stopServer();
    upstream.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
