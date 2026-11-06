#!/usr/bin/env node
// 慢平台弹幕"加载中一闪就没、之后一条都没有"回归(零外网,假 danmu_api):
//   node scripts/danmaku-load-test.mjs
//  起因(2026-11,《嫁金钗》):弹幕只有优酷,danmu_api 现抓一集 1.8 万条要 19~38 秒,我们取弹幕一律 12 秒超时 → 永远拿到空;
//  空的不进缓存,所以"有缓存"也没用。另外 Service Worker 把空弹幕存了,再开这一集服务器 4 秒内没回就回这份旧的空弹幕。
//  ① server.js 端到端:取弹幕要 14 秒(超过旧的 12 秒)也能拿到 —— 前台到点先回 pending(no-store),后台接着抓完存进缓存,
//     前端再要合并进同一次抓取(只回源一次),之后命中长缓存;弹幕源出错 → why:'fail'(短缓存期间也带着);真没有 → 不带 why;
//     第一轮就慢 / 超时的不再马上重试第二轮
//  ② api/index.js(Vercel 版,无后台):同样的超时(非 Vercel 下)与 why:'fail'
//  ③ 前端 _dmBackend.read 在沙箱里真跑:pending 两秒后再要、换集后不再要、等满 3 分钟按"没响应";空弹幕在左上角说原因、关着弹幕不说
//  ④ 静态:SW 不碰 /api/danmaku/、版本已升;"弹幕加载中"整个隐藏;两个后端取弹幕都不再写死 12 秒
// 改弹幕端点、取弹幕超时、_dmBackend、sw.js 后必跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const norm = (t) => t.split('\r\n').join('\n');
const HTML = norm(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));
const SW = norm(fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8'));
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------- 假 danmu_api ----------------
// 剧名决定行为:慢剧 = 每次取弹幕 14 秒;坏剧 = 500;慢坏剧 = 16 秒后 500;空剧 = 0 条;其它 = 立刻 80 条
const SLOW_MS = 14000;
const calls = new Map();   // 剧名 -> 取弹幕次数
const bump = (k) => calls.set(k, (calls.get(k) || 0) + 1);
const upstream = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/tk/api/v2/search/episodes') {
        const anime = u.searchParams.get('anime') || '';
        return res.end(JSON.stringify({ animes: [{ animeTitle: anime + '(2026)【国产剧】from youku', episodes: [1, 2, 3].map(n => ({ episodeId: 9000 + n, episodeTitle: '【youku】 第' + n + '集', url: 'https://v.youku.com/v_show/id_' + encodeURIComponent(anime) + '_' + n + '.html' })) }] }));
    }
    if (u.pathname === '/tk/api/v2/comment') {
        const url = u.searchParams.get('url') || '';
        const m = /id_([^_]+)_\d+\.html/.exec(url);
        const anime = m ? decodeURIComponent(m[1]) : '';
        bump(anime);
        if (/慢坏剧/.test(anime)) await sleep(16000);
        else if (/慢剧/.test(anime)) await sleep(SLOW_MS);
        if (/坏剧/.test(anime)) { res.statusCode = 500; return res.end('{}'); }
        const n = /空剧/.test(anime) ? 0 : 80;
        return res.end(JSON.stringify({ count: n, comments: Array.from({ length: n }, (_, i) => ({ p: `${i},1,16777215,[youku]`, m: anime + i })) }));
    }
    res.statusCode = 404; res.end('{}');
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const upPort = upstream.address().port;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-load-'));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'api'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'api/index.js'), path.join(tmp, 'api/index.js'));
for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));
const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
const ENV = { NODE_PATH, DANMU_API_URL: 'http://127.0.0.1:' + upPort, DANMU_API_TOKEN: 'tk', ACCESS_PASSWORD: '', ADMIN_TOKEN: '', LIVE_TV_DISABLED: '1', KAZUMI_DISABLE: '1', CORS_PROXY_URL: '', REMOTE_DB_URL: '', DANMU_API_SINGLE_INSTANCE: '', VERCEL: '' };
let srv = null, port = 0, log = '';
const start = async (args, extra, probe) => {
    port = 20000 + Math.floor(Math.random() * 20000);
    srv = spawn(process.execPath, args(port), { cwd: tmp, env: Object.assign({}, process.env, ENV, { PORT: String(port), CACHE_TYPE: 'sqlite' }, extra || {}), stdio: ['ignore', 'pipe', 'pipe'] });
    log = '';
    srv.stdout.on('data', d => { log += d; });
    srv.stderr.on('data', d => { log += d; });
    for (let i = 0; i < 150; i++) {
        await sleep(100);
        try { const r = await fetch(`http://127.0.0.1:${port}${probe}`); if (r.status < 500) return; } catch (e) { }
    }
    throw new Error('后端没起来:\n' + log.slice(-1500));
};
const stop = async () => { if (!srv) return; const p = new Promise(r => srv.once('exit', r)); srv.kill(); await p; srv = null; };
const get = async (id) => {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/api/danmaku/v3/?id=${encodeURIComponent(id)}`);
    const j = await r.json();
    return { j, ms: Date.now() - t0, n: (j.data || []).length, cc: r.headers.get('cache-control') || '' };
};
// 像前端那样:见 pending 两秒后再要,直到最终结果
const getFinal = async (id) => { let a = await get(id), k = 0; while (a.j.pending && k++ < 30) { await sleep(2000); a = await get(id); } return a; };
const SERVER = () => ['server.js'], API = (p) => ['-e', `require('./api/index.js').listen(${p})`];

try {
    console.log('① server.js 端到端');
    await start(SERVER, { DANMAKU_FG_WAIT_MS: '2000' }, '/api/debug');
    const ID = '慢剧|第01集|v5|k:tv|y:2026|n:3';
    const t0 = Date.now();
    let a = await get(ID);
    ok(a.n === 0 && a.j.pending === 1 && /no-store/.test(a.cc) && a.ms < 6000, '取弹幕要 14 秒:前台到点先回 pending、no-store', { pending: a.j.pending, ms: a.ms, cc: a.cc });
    // 前端的做法:见 pending 两秒后再要
    let polls = 0;
    while (a.j.pending && Date.now() - t0 < 40000) { await sleep(2000); a = await get(ID); polls++; }
    const took = Date.now() - t0;
    ok(a.n === 80 && !a.j.pending && /max-age=604800/.test(a.cc), '后台抓完:再要就拿到弹幕,7 天缓存头', { n: a.n, cc: a.cc, took });
    ok(took > 12000, '真的超过了旧的 12 秒超时(用时 ' + took + 'ms)');
    ok(calls.get('慢剧') === 1, '中途再要都合并进同一次抓取,只回源一次(实际 ' + calls.get('慢剧') + ' 次,轮询 ' + polls + ' 次)');
    ok(!/comment\?url\([^)]*\) 失败/.test(log), '没有超时失败的日志');
    a = await get(ID);
    ok(a.n === 80 && a.ms < 1000 && calls.get('慢剧') === 1, '之后命中服务器缓存,秒回', { ms: a.ms });

    a = await getFinal('坏剧|第01集|v5|k:tv|y:2026|n:3');
    ok(a.n === 0 && a.j.why === 'fail' && /no-store/.test(a.cc), '弹幕源出错 → why:fail、no-store', { why: a.j.why, cc: a.cc });
    const cBad = calls.get('坏剧');
    a = await get('坏剧|第01集|v5|k:tv|y:2026|n:3');
    ok(a.j.why === 'fail' && calls.get('坏剧') === cBad, '短缓存期间再要也带着 why:fail,不回源', { why: a.j.why });
    ok(cBad === 2, '出错得很快:照旧等 3 秒再赛一轮(限流的瞬时失败要重试),共 ' + cBad + ' 次');
    a = await getFinal('空剧|第01集|v5|k:tv|y:2026|n:3');
    ok(a.n === 0 && a.j.why === undefined && !a.j.pending, '真没有弹幕 → 不带 why', a.j);
    await stop();

    // 第一轮就慢、最后还出错(16 秒后 500):不再马上赛第二轮(旧版两轮各超时一次,前端白等)
    calls.clear();
    await start(SERVER, { DANMAKU_FG_WAIT_MS: '1500' }, '/api/debug');
    const ID2 = '慢坏剧|第02集|v5|k:tv|y:2026|n:3';
    a = await get(ID2);
    ok(a.j.pending === 1, '慢且出错:先回 pending');
    const t2 = Date.now();
    while (a.j.pending && Date.now() - t2 < 60000) { await sleep(2000); a = await get(ID2); }
    ok(a.n === 0 && a.j.why === 'fail' && calls.get('慢坏剧') === 1, '第一轮慢的出错了不再赛第二轮,直接 why:fail', { why: a.j.why, calls: calls.get('慢坏剧') });
    await stop();

    console.log('② api/index.js(Vercel 版;这里不在 Vercel 上)');
    calls.clear();
    await start(API, null, '/api/danmaku/v3/');
    a = await get('慢剧三|第01集|v5|k:tv|y:2026|n:3');
    ok(a.n === 80 && a.ms > 12000, 'api/index.js:取弹幕要 14 秒也能拿到(不再 12 秒超时)', { n: a.n, ms: a.ms });
    a = await get('坏剧|第01集|v5|k:tv|y:2026|n:3');
    ok(a.n === 0 && a.j.why === 'fail' && /no-store/.test(a.cc), 'api/index.js:弹幕源出错 → why:fail', { why: a.j.why });
    a = await get('坏剧|第01集|v5|k:tv|y:2026|n:3');
    ok(a.j.why === 'fail', 'api/index.js:短缓存命中也带 why:fail');
    a = await get('空剧|第01集|v5|k:tv|y:2026|n:3');
    ok(a.n === 0 && a.j.why === undefined, 'api/index.js:真没有 → 不带 why', a.j);
    await stop();
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e) + '\n' + log.slice(-1500));
} finally {
    await stop();
    upstream.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

console.log('③ 前端 _dmBackend.read(沙箱)');
{
    const a = HTML.indexOf('        const _dmDatedRe =');
    const b0 = HTML.indexOf('        const _dmBackend = {', a);
    const b = HTML.indexOf('\n        };', b0);
    ok(a > 0 && b0 > a && b > b0, '找到 _dmDatedRe / dmEmptyNotice / _dmBackend');
    const code = HTML.slice(a, b + '\n        };'.length);
    let clock = 1e12;
    const timers = [];
    const fetches = [];
    let replies = [];
    const notices = [];
    const dp = { danmaku: { showing: true }, notice: (t, ms) => notices.push(t) };
    const ctx = vm.createContext({
        console, dp, dmAutoSrcOf: (d) => d.src || '', dmAlignAfterLoad: () => { }, dmAuto: { wake() { } },
        document: { querySelector: () => null },
        Date: class extends Date { static now() { return clock; } },
        setTimeout: (f, ms) => { timers.push({ f, at: clock + ms }); return timers.length; },
        fetch: (url) => { fetches.push(url); const r = replies.shift() || { code: 0, data: [] }; return Promise.resolve({ ok: true, json: () => Promise.resolve(r) }); },
        decodeURIComponent, encodeURIComponent,
    });
    vm.runInContext(code + '\n;globalThis.__B = _dmBackend;', ctx);
    const B = ctx.__B;
    const flush = () => new Promise(r => setImmediate(r));
    const runTimers = async (adv) => { clock += adv; const due = timers.splice(0).filter(t => { if (t.at <= clock) return true; timers.push(t); return false; }); for (const t of due) t.f(); await flush(); await flush(); };
    const read = (id) => { const got = { ok: [], err: [] }; B.want = id; B.read({ url: '/api/danmaku/v3/?id=' + id, success: (l) => got.ok.push(l), error: (m) => got.err.push(m) }); return got; };

    // pending → 两秒后再要 → 又 pending → 再要 → 拿到
    replies = [{ code: 0, data: [], pending: 1 }, { code: 0, data: [], pending: 1 }, { code: 0, src: 'youku', data: [[1, 0, 16777215, 'u', 'hi']] }];
    let g = read('A%7C1');
    await flush(); await flush();
    ok(fetches.length === 1 && !g.ok.length && timers.length === 1, 'pending:先不回调(DPlayer 不收起),两秒后再要', { f: fetches.length, ok: g.ok.length, t: timers.length });
    await runTimers(1999);
    ok(fetches.length === 1, '不到两秒不再要');
    await runTimers(1);
    await runTimers(2000);
    ok(fetches.length === 3 && g.ok.length === 1 && g.ok[0].length === 1 && g.ok[0][0].text === 'hi' && !notices.length, '第三次拿到弹幕:回调一次,不提示', { f: fetches.length, ok: g.ok.length, notices });

    // 换集:等待中的那次作废
    fetches.length = 0; timers.length = 0;
    replies = [{ code: 0, data: [], pending: 1 }];
    g = read('B%7C1');
    await flush(); await flush();
    B.want = 'C%7C2';
    await runTimers(2000);
    ok(fetches.length === 1 && !g.ok.length && !g.err.length, '换集后不再要、也不回调');

    // 等满 3 分钟还是 pending → 按"没响应"收尾
    fetches.length = 0; timers.length = 0; notices.length = 0;
    replies = Array.from({ length: 200 }, () => ({ code: 0, data: [], pending: 1 }));
    g = read('D%7C1');
    await flush(); await flush();
    for (let i = 0; i < 100 && !g.ok.length; i++) await runTimers(2000);
    ok(g.ok.length === 1 && g.ok[0].length === 0 && notices[0] === '弹幕源暂时没响应，稍后重开本集再试', '等满 3 分钟:回调空列表,提示弹幕源没响应', { ok: g.ok.length, notices, f: fetches.length });
    ok(fetches.length >= 80 && fetches.length <= 95, '这 3 分钟里大约每两秒要一次(' + fetches.length + ' 次)');

    // 空弹幕说原因
    const emptyWith = async (reply, showing) => { notices.length = 0; dp.danmaku.showing = showing; replies = [reply]; const r = read('E%7C' + Math.random()); await flush(); await flush(); return { r, n: notices.slice() }; };
    let e = await emptyWith({ code: 0, data: [], why: 'fail' }, true);
    ok(e.r.ok.length === 1 && e.n[0] === '弹幕源暂时没响应，稍后重开本集再试', 'why:fail → 弹幕源没响应', e.n);
    e = await emptyWith({ code: 0, data: [], why: 'busy' }, true);
    ok(e.n[0] === '弹幕服务繁忙，稍后重开本集再试', 'why:busy → 繁忙', e.n);
    e = await emptyWith({ code: 0, data: [] }, true);
    ok(e.n[0] === '本集暂无弹幕', '没有 why → 本集暂无弹幕', e.n);
    e = await emptyWith({ code: 0, data: [] }, false);
    ok(e.r.ok.length === 1 && !e.n.length, '关着弹幕不提示');
    e = await emptyWith({ code: 0, data: [[1, 0, 1, 'u', 'x']], why: 'fail' }, true);
    ok(!e.n.length, '有弹幕就不提示');
    dp.danmaku.showing = true;
}

console.log('④ 静态');
{
    // SW:/api/danmaku/ 不接(不调 respondWith),别的同源 API 照常
    const handlers = {};
    const self = { location: new URL('https://ednovas.video/sw.js'), addEventListener: (t, f) => { handlers[t] = f; }, registration: {}, clients: { claim: async () => { } }, skipWaiting: () => { } };
    vm.runInContext(SW, vm.createContext({ self, URL, caches: {}, fetch: () => Promise.reject(new Error('no')), Response: class { }, console, setTimeout }));
    const responded = (u) => { let r = false; handlers.fetch({ request: { url: u, method: 'GET', destination: '', mode: 'cors', headers: { has: () => false } }, respondWith: (p) => { r = true; Promise.resolve(p).catch(() => { }); }, waitUntil: () => { } }); return r; };
    ok(!responded('https://ednovas.video/api/danmaku/v3/?id=%E5%AB%81%E9%87%91%E9%92%97%7C%E7%AC%AC01%E9%9B%86%7Cv5'), 'SW 不碰 /api/danmaku/(空弹幕不进 Cache Storage、不在 4 秒竞速里回放)');
    ok(responded('https://ednovas.video/api/popular?window=7d'), '别的同源 API 照常走 SW');
    const v = /const CACHE_VERSION = 'v(\d+)'/.exec(SW);
    ok(v && +v[1] >= 42, 'SW 已升版(旧缓存里存着的空弹幕随 activate 清掉)', v && v[1]);
    // "弹幕加载中"整个隐藏
    ok(/#dplayer \.dplayer-danloading \{\s*display: none !important;\s*\}/.test(HTML), '"弹幕加载中"隐藏(画面正中间抖着碍事,后台抓就行)');
    // 两个后端:取弹幕不再写死 12 秒
    for (const f of ['server.js', 'api/index.js']) {
        const s = norm(fs.readFileSync(path.join(ROOT, f), 'utf8'));
        const a = s.indexOf('async function fetchDanmakuFromInstance(');
        const body = s.slice(a, s.indexOf('\n}\n', a));
        const loop = body.slice(body.indexOf('let transient = false;'));
        ok(!/timeout: 12000/.test(loop) && (loop.match(/timeout: cWait\(\)/g) || []).length === 2, f + ':取弹幕(按地址 / 按 id)都用 cWait(),不再写死 12 秒');
        ok(/process\.env\.VERCEL \? 12000 : Math\.min\(55000, cEnd - Date\.now\(\)\)/.test(loop), f + ':VPS 一次最多 55 秒、合计 60 秒;Vercel 照旧 12 秒');
    }
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
