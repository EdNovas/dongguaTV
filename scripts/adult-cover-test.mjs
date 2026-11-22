#!/usr/bin/env node
// [adult] 封面加载不出来就藏(public/adult/adult.js 的 covers):node scripts/adult-cover-test.mjs(离线、零网络)
//  ① 纯函数:coverHost / coverCands / cleanAlt / searchAlts / coverProbeUrl / coverClass(成对探测 → 图床结论)/ coverVerdict(决策表)/
//     coverGuard(本机的问题)/ coverControls(挑对照)/ coverProbe(HEAD no-cors no-store,up / down / slow)/ coverHead(代理那一张的状态码)/
//     图床记忆(两次 down、不同的图、隔 ≥60 秒才记死;6 小时;无痕不写;保险丝;复活)
//  ② 控制器(假时钟 / 假存储 / 假 IntersectionObserver / 假探测):换备用地址;文件坏(图床 up)重试一次再藏、不记失败;down + 对照通 → 藏 + 记失败、
//     两次记死、挂着的换 alt;对照都不通 / 没有对照 → 网络问题不藏、有图加载出来再试(每张卡隔 15 秒);没有成功过的图 → 用别的卡片的封面当对照;
//     slow → 30 秒第二轮(还 slow 本会话藏、不记失败;up 留着;down 记失败);断网 / 后台不探、online / 回前台从头试;冻过 / 联网 / 断网时在路上的探测作废重来;
//     本机的问题(≥3 个 down、up 不比它多)不藏、日志一次、不记失败,对照错开;卡住 30 秒才探(up = 只是慢,2 分钟不再探;down 换 alt / 藏);
//     弱网(全都慢)一张都不藏;窗口化网格换块不吃重试、不按过时结论藏、重挂的重复失败不再探;同一个图床 30 秒内合并、并发上限;
//     本机记死的图床 1 分钟 / 10 分钟后台复查复活;图床有图加载出来 → 因它藏掉的卡放回来;封面代理只按单张(404 藏、5xx 不藏);
//     1×1 算失败;服务器死图床;没登记的图只当对照;一个定时器
//  ③ 端到端:假 window + 假 DOM 里跑 adult.js(boot 装好文档级 load/error 捕获)+ 真 Vue(vue.global.prod.min.js):
//     /api/config 的 cover_dead_hosts;浏览网格拿掉坏卡不留洞、不整个重来、焦点给紧跟着的那张、视口上面的改动先压着、翻过去了才放开、
//     网格没排版(浏览页藏在搜索页后面)时什么都不动、「已隐藏 N 部 · 显示」(显示时补滚动、焦点给放出来的卡)、底栏按出了几张算;
//     搜索网格换同组别的线路的海报;首页行拿掉坏卡、空了的行 / 不足 12 部的新片速递整行不出、滚动位置补回去;
//     相关推荐;搜索联想开着时不删行、下次重算才拿掉;收藏用换到的那张封面;浏览页整页被藏时不狂翻页;继续观看不受影响;断网 / 网络问题 / 无痕
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < (n || 8); i++) await tick(); };

const A = require(path.join(ROOT, 'public/adult/adult.js'));
const CV = A.COVER;

console.log('① 纯函数');
{
    const H = A.coverHost;
    ok(H('https://Fb.LJ260522.top/upload/a.jpg') === 'fb.lj260522.top' && H('http://u:p@img.example.test:8080/x.jpg') === 'img.example.test' && H('//cdn.example.test/a.png') === 'cdn.example.test',
        'coverHost:主机名小写、去掉账号和端口、协议相对地址也认');
    ok(H('/api/img?k=c%3AA-1&s=s1') === 'self' && H('https://site.test/api/img?k=1', 'site.test') === 'self' && H('data:image/png;base64,xx') === '' && H('') === '' && H(null) === '' && H('javascript:alert(1)') === '' && H('https://bad host/a.jpg') === '',
        'coverHost:同源 / 相对地址(封面代理)= self;data: / 空 / 不合法 = 空');
    {
        const hs = A.makeCoverHosts({ now: () => 1, store: () => null });
        hs.setServer(['img_cdn.example.test']);
        ok(H('https://IMG_CDN.example.test/a.jpg') === 'img_cdn.example.test' && hs.isDead('img_cdn.example.test'), 'coverHost / 服务器死图床表:带下划线的主机名照认(与服务器同口径)');
    }
    const it = { id: 'c:A-1', poster_path: 'https://a.test/1.jpg', _alt: ['https://b.test/1.jpg', 'https://a.test/1.jpg', 'https://x.test/mac_default.jpg', 'ftp://c.test/1.jpg', 'https://c.test/1.jpg'] };
    ok(eq(A.coverCands(it), ['https://a.test/1.jpg', 'https://b.test/1.jpg', 'https://c.test/1.jpg']), 'coverCands:主封面在前、alt 依次、去重、占位 / 非 http 丢掉');
    ok(eq(A.coverCands(it, (u) => /b\.test/.test(u)), ['https://a.test/1.jpg', 'https://c.test/1.jpg']) && eq(A.coverCands({ id: 'x', poster_path: '' }), []) && eq(A.coverCands(null), []) && eq(A.coverCands({ poster_path: '/api/img?k=1' }), ['/api/img?k=1']),
        'coverCands:死图床上的跳过;pic 空 = 没有;代理地址照认');
    ok(eq(A.cleanAlt(['https://b.test/1.jpg', 'https://a.test/1.jpg', 'https://b.test/1.jpg', 'javascript:x', 'https://c.test/1.jpg', 'https://d.test/1.jpg'], 'https://a.test/1.jpg'), ['https://b.test/1.jpg', 'https://c.test/1.jpg']) && eq(A.cleanAlt(null, ''), []) && eq(A.cleanAlt('https://b.test/x.jpg', ''), []),
        'cleanAlt:≤2、去重、不等于主封面、只认 http(s) 数组');
    const g = { sources: [{ vod_pic: 'https://a.test/1.jpg' }, { vod_pic: 'https://a.test/2.jpg' }, { vod_pic: 'https://b.test/1.jpg' }, { vod_pic: 'https://x/nopic.gif' }, { vod_pic: '' }, { vod_pic: 'https://c.test/1.jpg' }, { vod_pic: 'https://c.test/1.jpg' }] };
    ok(eq(A.searchAlts(g, 'https://a.test/1.jpg', 3), ['https://b.test/1.jpg', 'https://c.test/1.jpg', 'https://a.test/2.jpg']) && eq(A.searchAlts(g, '', 2), ['https://a.test/1.jpg', 'https://b.test/1.jpg']) && eq(A.searchAlts(null, ''), []),
        'searchAlts:别的线路的海报,先挑不同图床的,最多 n 个');
    ok(A.coverProbeUrl('http://img.test/a.jpg', true) === 'https://img.test/a.jpg' && A.coverProbeUrl('http://img.test/a.jpg', false) === 'http://img.test/a.jpg' && A.coverProbeUrl('https://img.test/a.jpg', true) === 'https://img.test/a.jpg',
        'coverProbeUrl:https 页面上的 http 封面按 https 探(浏览器加载它时也是自动升级的);http 页面照原样');
    // 成对探测 → 图床结论
    const K = A.coverClass;
    ok(K({ target: 'up', controlUp: false }, 1) === 'file' && K({ target: 'up', controlUp: true }, 1) === 'file', '目标 up → 图床通、文件坏(不管对照)');
    ok(K({ target: 'down', controlUp: true }, 1) === 'host' && K({ target: 'down', controlUp: false }, 1) === 'net' && K({ target: 'slow', controlUp: false }, 1) === 'net',
        '目标 down + 对照通 → 连不上这个图床;对照一个都没 up → 网络问题');
    ok(K({ target: 'slow', controlUp: true }, 1) === 'amb' && K({ target: 'slow', controlUp: true }, 2) === 'host2' && K({ target: 'up', controlUp: true }, 2) === 'keep' && K({ target: 'down', controlUp: true }, 2) === 'host' && K({ target: 'slow', controlUp: false }, 2) === 'net' && K(null, 1) === 'net',
        'slow + 对照通 → 第二轮;第二轮还 slow → 本会话藏;第二轮 up → 留着(只是慢);第二轮 down → 连不上');
    // 决策表
    const V = A.coverVerdict;
    ok(V({ online: false, vs: ['host'] }) === 'off' && V({ online: true, hidden: true, vs: ['host'] }) === 'off', '断网 / 页面在后台 → 不探不藏,等 online / 回前台');
    ok(V({ online: true, vs: [] }) === 'pend' && V({ online: true, vs: ['host', 'pend'] }) === 'pend' && V({ online: true, vs: ['amb'] }) === 'pend', '还有图床没探完(或等第二轮)→ 等');
    ok(V({ online: true, vs: ['host', 'net'] }) === 'net' && V({ online: true, vs: ['file'], guard: true }) === 'guard' && V({ online: true, vs: ['host'], guard: true }) === 'guard',
        '有一个图床是「网络问题」→ 不藏;本机的问题 → 什么都不新藏(文件坏的也不藏)');
    ok(V({ online: true, vs: ['keep', 'host'] }) === 'keep' && V({ online: true, vs: ['file', 'host'] }) === 'retry' && V({ online: true, vs: ['file'], retried: true }) === 'hide'
        && V({ online: true, vs: ['host'] }) === 'hide' && V({ online: true, vs: ['host2', 'host'] }) === 'hide',
        '第二轮通了 → 留着;文件坏 → 先重试一次,重试过了还坏 → 藏;连不上 / 第二轮还 slow → 藏');
    // 本机的问题
    const G = A.coverGuard, t0 = 1e6;
    const lg = (dn, up) => dn.map((h, i) => ({ t: t0 + i, h, up: false })).concat(up.map((h, i) => ({ t: t0 + i, h, up: true })));
    ok(!G(lg(['a', 'b'], []), t0 + 10) && G(lg(['a', 'b', 'c'], ['x', 'y', 'z']), t0 + 10) && !G(lg(['a', 'b', 'c'], ['w', 'x', 'y', 'z']), t0 + 10) && G(lg(['a', 'a', 'b', 'c'], ['x']), t0 + 10),
        'coverGuard:2 分钟内 ≥3 个图床 down、看到 up 的图床数 ≤ 这个数 → 本机的问题(同一个图床只算一次)');
    ok(!G(lg(['a', 'b', 'c'], []), t0 + CV.GUARD_MS + 10) && !G(null, t0), 'coverGuard:2 分钟前的不算');
    // 挑对照
    const Cc = A.coverControls;
    const okl = [{ h: 'old.test', u: 'https://old.test/1.jpg', t: 1 }, { h: 'new.test', u: 'https://new.test/1.jpg', t: 9 }, { h: 'mid.test', u: 'https://mid.test/1.jpg', t: 5 }, { h: 'dead.test', u: 'https://dead.test/1.jpg', t: 8 }];
    ok(eq(Cc(okl, (h) => h === 'dead.test', null, 2).map(x => x.h), ['new.test', 'mid.test']), 'coverControls:新的在前、跳过要跳过的(目标 / 死图床)、≤2');
    ok(eq(Cc(okl, (h) => h === 'dead.test', new Set(['new.test']), 2).map(x => x.h), ['mid.test', 'old.test']) && eq(Cc(okl, null, new Set(['new.test', 'mid.test', 'old.test', 'dead.test']), 3).map(x => x.h), ['new.test', 'dead.test', 'mid.test']),
        'coverControls:2 分钟内已经探到 up / 刚当过对照的图床排后(对照多覆盖几个图床);都用过了照样按新旧挑');
    ok(eq(Cc([], null, null, 2), []) && eq(Cc(null), []), 'coverControls:没有成功过的图 → 空');
    ok(CV.MIN === 16 && CV.TTL_MS === 6 * 3600 * 1000 && CV.KEY === 'dg_cover_hosts' && CV.ALT_MAX === 2 && CV.PROBE_MS === 20000 && CV.RETRY_MS === 3000 && CV.ROUND2_MS === 30000
        && CV.STALL_MS === 30000 && CV.STALL_OK_MS === 120000 && CV.GUARD_MS === 120000 && CV.GUARD_N === 3 && CV.FREEZE_MS === 5000 && CV.KICK_MS === 15000
        && CV.STRIKE_SPAN === 60000 && CV.NEW_MAX === 4 && CV.NEW_WIN === 600000 && CV.RECHECK_FIRST === 60000 && CV.RECHECK_MS === 600000,
        '常量:16px / 6 小时 / dg_cover_hosts / alt ≤2 / 探测 20 秒 / 重试 3 秒 / 第二轮 30 秒 / 卡住 30 秒、只是慢 2 分钟不再探 / 本机的问题 2 分钟 ≥3 个 / 冻过 5 秒 / 再试隔 15 秒 / 记死两次隔 60 秒、10 分钟最多 4 个 / 复查 1 分钟、10 分钟');
    ok(!('STALL_MAX' in CV) && !('NET_MIN_MS' in CV) && !('SELF_MS' in CV) && typeof A.coverJudge === 'undefined' && typeof A.coverVia === 'undefined' && typeof A.coverWeak === 'undefined' && typeof A.coverBurst === 'undefined',
        'v1 那套按耗时猜网络的(Resource Timing / 弱成功 / 80ms / 同源保险丝 / 网络切换)全删了');
    const SRC = fs.readFileSync(path.join(ROOT, 'public/adult/adult.js'), 'utf8');
    ok(!/getEntriesByName|PerformanceObserver|transferSize|\/sw\.js\?cvprobe/.test(SRC), 'adult.js 里不再有 Resource Timing / 探 /sw.js');
}
{
    // coverProbe:HEAD、no-cors(不透明响应也算回了)、no-store、不带 cookie / Referer、可中止;https 页面上的 http 地址按 https 问
    const f0 = globalThis.fetch, loc0 = globalThis.location;
    const calls = [];
    const run = (impl, url, ms) => new Promise((res) => { globalThis.fetch = (u, o) => { calls.push([u, o]); return impl(o); }; A.coverProbe(url, ms || 50, res); });
    globalThis.location = { protocol: 'https:' };
    const r1 = await run(() => Promise.resolve({ type: 'opaque', status: 0 }), 'http://img.example.test/a.jpg');
    const r2 = await run(() => Promise.reject(new TypeError('Failed to fetch')), 'https://img.example.test/b.jpg');
    let aborted = false;
    const r3 = await run((o) => new Promise((res, rej) => { o.signal.addEventListener('abort', () => { aborted = true; rej(new Error('AbortError')); }); }), 'https://img.example.test/c.jpg', 30);
    const r4 = await run(() => Promise.resolve({ type: 'opaque', status: 0 }), 'https://img.example.test/405');
    globalThis.fetch = undefined;
    const r5 = await new Promise((res) => A.coverProbe('https://img.example.test/d.jpg', 30, res));
    if (loc0 === undefined) delete globalThis.location; else globalThis.location = loc0;
    globalThis.fetch = f0;
    const o = calls[0][1];
    ok(r1 === 'up' && r2 === 'down' && r3 === 'slow' && aborted && r4 === 'up' && r5 === 'slow', 'coverProbe:回了(不透明响应,405 也一样)= up;超时前报错 = down;超时 = slow(并中止);没有 fetch = slow', [r1, r2, r3, aborted, r4, r5]);
    ok(calls[0][0] === 'https://img.example.test/a.jpg' && o.method === 'HEAD' && o.mode === 'no-cors' && o.cache === 'no-store' && o.credentials === 'omit' && o.referrerPolicy === 'no-referrer' && !!o.signal,
        'coverProbe:HEAD、no-cors、no-store(不走 HTTP 缓存)、不带 cookie / Referer、可中止;https 页面上的 http 地址按 https 问', calls[0]);
}
{
    // coverHead(封面代理那一张):HEAD、no-store、同源 cookie;状态码 / 报错 = 0 / 超时 = 0
    const f0 = globalThis.fetch;
    const calls = [];
    const run = (impl, ms) => new Promise((res) => { globalThis.fetch = (u, o) => { calls.push([u, o]); return impl(); }; A.coverHead('/api/img?k=c%3AA-1&s=s1', ms || 50, res); });
    const got = [await run(() => Promise.resolve({ status: 404 })), await run(() => Promise.resolve({ status: 502 })), await run(() => Promise.reject(new TypeError('x'))), await run(() => new Promise(() => { }), 30)];
    globalThis.fetch = f0;
    ok(eq(got, [404, 502, 0, 0]) && calls[0][0] === '/api/img?k=c%3AA-1&s=s1' && calls[0][1].method === 'HEAD' && calls[0][1].cache === 'no-store' && calls[0][1].credentials === 'same-origin',
        'coverHead:回状态码;断网 / 超时 = 0;HEAD、no-store、带同源 cookie', got);
}
{
    // ---- 图床记忆 ----
    const clock = { t: 5e6 };
    const mem = new Map();
    const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
    let incog = false;
    const reg = [];
    const Hs = A.makeCoverHosts({ now: () => clock.t, store: () => storage, incognito: () => incog, register: (k) => reg.push(k) });
    const SP = CV.STRIKE_SPAN;
    ok(Hs.strike('a.test', 'https://a.test/1.jpg', clock.t) === false && !Hs.isDead('a.test'), '一次 down:还不死');
    ok(Hs.strike('a.test', 'https://a.test/1.jpg', clock.t + SP + 5000) === false && !Hs.isDead('a.test'), '同一张再 down 不算第二次');
    ok(Hs.strike('a.test', 'https://a.test/2.jpg', clock.t + 20000) === false && !Hs.isDead('a.test'), '第二张不同的图,但和第一张相隔 <60 秒(一阵子的 DNS 抽风)→ 只算一次,不记死');
    ok(Hs.strike('a.test', 'https://a.test/3.jpg', clock.t + SP + 1000) === true && Hs.isDead('a.test') && Hs.local('a.test') && Hs.marked('a.test') && Hs.strike('a.test', 'https://a.test/4.jpg', clock.t + SP + 9000) === false,
        '不同的图、最早和最晚相隔 ≥60 秒、本会话没成功过 → 记死(只报一次;算本机记死的)');
    const saved = JSON.parse(mem.get('dg_cover_hosts') || 'null');
    ok(saved && saved.v === 1 && saved.d['a.test'] === clock.t + CV.TTL_MS && eq(reg, ['dg_cover_hosts']), '落盘 localStorage dg_cover_hosts(到期时间 = 6 小时后),并登记给 dgPrivacy(一键清除 / 无痕拦截)', saved);
    Hs.ok('b.test');
    ok(Hs.strike('b.test', 'u1', clock.t) === false && Hs.strike('b.test', 'u2', clock.t + SP + 9000) === false && !Hs.isDead('b.test') && Hs.hostOk('b.test'), '本会话成功过的图床怎么 down 都不记死');
    const Hs2 = A.makeCoverHosts({ now: () => clock.t, store: () => storage, incognito: () => incog });
    ok(Hs2.isDead('a.test') && eq(Hs2.dead(), ['a.test']), '刷新后(新实例)从 localStorage 读回来');
    clock.t += CV.TTL_MS + 1;
    const Hs3 = A.makeCoverHosts({ now: () => clock.t, store: () => storage });
    ok(!Hs2.isDead('a.test') && !Hs3.isDead('a.test') && eq(Hs3.dead(), []), '6 小时后过期');
    clock.t -= CV.TTL_MS + 1;
    ok(Hs2.ok('a.test') === true && !Hs2.isDead('a.test') && Hs2.marked('a.test') && !!JSON.parse(mem.get('dg_cover_hosts')).d['a.test'] && Hs2.ok('a.test') === false,
        '记死的图床有一张目录封面加载出来了 → 本会话不当死(只在第一次报);本机记录先不删(可能是缓存里出来的)');
    ok(Hs2.revive('a.test') === true && !Hs2.marked('a.test') && !mem.has('dg_cover_hosts') && Hs2.revive('a.test') === false, 'revive(后台 no-store 探测确认通了):删掉本机记录');
    {
        const Hd = A.makeCoverHosts({ now: () => clock.t, store: () => null });
        ok(Hd.strike('dd.test', 'u1', clock.t) === false && Hd.strike('dd.test', 'u2', clock.t + 3 * 3600 * 1000) === false && !Hd.isDead('dd.test'), '两次 down 相隔 3 小时(超过 30 分钟)→ 不记死');
        ok(Hd.strike('dd.test', 'u3', clock.t + 3 * 3600 * 1000 + 10 * 60000) === true, '30 分钟内又一次(隔了 ≥60 秒)→ 才记死');
    }
    mem.clear(); incog = true;
    const Hi = A.makeCoverHosts({ now: () => clock.t, store: () => storage, incognito: () => incog });
    Hi.strike('i.test', 'u1', clock.t); Hi.strike('i.test', 'u2', clock.t + SP + 1);
    ok(Hi.isDead('i.test') && !mem.has('dg_cover_hosts'), '无痕:记死只在内存里,localStorage 不写');
    incog = false;
    ok(Hs.setServer(['Dead.Test', 'bad host', '', 7, 'x.test']) === true && Hs.isDead('dead.test') && !Hs.local('dead.test') && Hs.isDead('x.test') && !Hs.isDead('bad host') && Hs.setServer(['x.test', 'dead.test']) === false && Hs.setServer([]) === true && !Hs.isDead('dead.test'),
        '服务器死图床表:小写、丢掉不合法的;返回有没有变化;服务器说死的不算「本机记死」(不用本机复查)');
    Hs.setServer(['srv.test']);
    ok(Hs.ok('srv.test') === true && !Hs.isDead('srv.test'), '服务器说死、这台设备有目录封面加载出来 → 本会话不当死(返回 true)');
    ok(!Hs.isDead('self') && Hs.strike('self', 'u1', clock.t) === false && Hs.strike('self', 'u2', clock.t + SP + 9000) === false && !Hs.isDead('self'), '同源(封面代理)永远不记死');
    const Hf = A.makeCoverHosts({ now: () => clock.t, store: () => storage });
    const killed = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map(h => { Hf.strike(h + '.test', 'u1', clock.t); return Hf.strike(h + '.test', 'u2', clock.t + SP + 5000); });
    ok(eq(killed, [true, true, true, true, false, false]) && !Hf.isDead('f5.test'), '保险丝:10 分钟内最多新记死 4 个图床', killed);
    clock.t += 600001;
    ok(Hf.strike('f5.test', 'u3', clock.t) === true, '10 分钟后又能记');
    mem.set('dg_cover_hosts', '{"v":1,"d":{"ok.test":' + (clock.t + 1000) + ',"far.test":' + (clock.t + CV.TTL_MS * 10) + ',"bad host":' + (clock.t + 1000) + '}}');
    const Hb = A.makeCoverHosts({ now: () => clock.t, store: () => storage });
    ok(Hb.isDead('ok.test') && !Hb.isDead('far.test') && eq(Hb.dead(), ['ok.test']), '读回来时丢掉不合法的主机名和离谱的到期时间');
    mem.set('dg_cover_hosts', 'not json');
    ok(eq(A.makeCoverHosts({ now: () => clock.t, store: () => storage }).dead(), []) && eq(A.makeCoverHosts({ now: () => clock.t, store: () => { throw new Error('denied'); } }).dead(), []), '坏数据 / 存储被禁用都不出错');
}

// ---------------- ② 控制器 ----------------
//   假探测:W.rules[图床] = 'up' / 'down' / 'slow'(20 秒后才回)/ 'manual'(测试自己 W.answer)/ 函数(url) → 其中之一;没写的按 W.rules['*'](默认 up)。
//   网络回包也挂在假时钟上(W.lat 毫秒后),和控制器自己的定时器分开记(net:true),好数「只有一个定时器」
function world(o) {
    o = o || {};
    const clock = { t: 1e7 };
    let timers = [];
    const mem = o.mem || new Map();
    const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
    const ios = [];
    class FakeIO { constructor(cb, opt) { this.cb = cb; this.opt = opt; this.t = new Set(); ios.push(this); } observe(el) { this.t.add(el); } unobserve(el) { this.t.delete(el); } disconnect() { this.t.clear(); } }
    const hostOfU = (u) => { const m = /^(?:https?:)?\/\/([^/:?#]+)/i.exec(String(u)); return m ? m[1].toLowerCase() : 'self'; };
    const W = {
        clock, mem, ios, on: true, hidden: false, incog: false, reg: [], flushes: 0, logs: [], probes: [], heads: [], manual: [], lat: 40,
        rules: Object.assign({ '*': 'up' }, o.rules || {}),
        env: {
            now: () => clock.t, online: () => W.on, hidden: () => W.hidden, store: () => storage, incognito: () => W.incog,
            selfHost: () => 'site.test', IO: () => (o.noIO ? null : FakeIO), register: (k) => W.reg.push(k), log: (m) => W.logs.push(m),
            probe: (url, ms, cb) => {
                const h = hostOfU(url);
                W.probes.push({ url, h, t: clock.t });
                let r = Object.prototype.hasOwnProperty.call(W.rules, h) ? W.rules[h] : W.rules['*'];
                if (typeof r === 'function') r = r(url, h);
                if (r === 'manual' || !r) { W.manual.push({ url, h, cb }); return; }
                timers.push({ f: () => cb(r), at: clock.t + (r === 'slow' ? ms : W.lat), net: true });
            },
            head: (url, ms, cb) => { W.heads.push({ url, ms, cb }); },
            setTimeout: (f, ms) => { const x = { f, at: clock.t + ms }; timers.push(x); return x; },
            clearTimeout: (x) => { timers = timers.filter(y => y !== x); },
        },
        timers: () => timers.slice(),
        ctlTimers: () => timers.filter(x => !x.net).length,
        advance(ms) {
            const end = clock.t + ms;
            for (; ;) {
                const due = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                timers = timers.filter(x => x !== due);
                clock.t = Math.max(clock.t, due.at);
                due.f();
            }
            clock.t = end;
        },
        freeze(ms) { clock.t += ms; },    // 页面冻住(睡眠):时间过去了,定时器一个都没跑
        answer(h, v) { const L = W.manual.filter(x => x.h === h); W.manual = W.manual.filter(x => x.h !== h); L.forEach(x => x.cb(v)); return L.length; },
        img(src, extra) {
            const a = { src };
            return Object.assign({ a, getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, naturalWidth: 0, naturalHeight: 0, complete: false, isConnected: true }, extra || {});
        },
        io() { return ios[ios.length - 1]; },
        see(...els) { const I = W.io(); if (I) I.cb(els.map(el => ({ target: el, isIntersecting: true }))); },
        unsee(...els) { const I = W.io(); if (I) I.cb(els.map(el => ({ target: el, isIntersecting: false }))); },
        hostProbes: (h) => W.probes.filter(p => p.h === h).length,
    };
    W.C = A.makeCovers(W.env);
    W.C.listen(() => { W.flushes++; });
    W.card = (id, pic, alt) => (alt ? { id, _wk: id, poster_path: pic, _alt: alt } : { id, _wk: id, poster_path: pic });
    W.mount = (it, extra) => { const el = W.img(W.C.src(it), extra); W.C.attach(el, it); return el; };
    W.load = (el, w, h) => { el.naturalWidth = w == null ? 320 : w; el.naturalHeight = h == null ? 180 : h; return W.C.onLoad(el); };
    W.err = (el) => W.C.onError(el);
    let n = 0;
    // 一张别的图床的目录封面真加载出来了
    W.okFrom = (host) => { const it = W.card('ok:' + host + ':' + (++n), 'https://' + host + '/' + n + '.jpg'); const el = W.mount(it); W.load(el); return el; };
    W.ph = (k) => { const s = W.C.state(k); return s ? s.ph : ''; };
    W.deadMem = () => { try { return Object.keys(JSON.parse(mem.get('dg_cover_hosts')).d); } catch (e) { return []; } };
    return W;
}
console.log('② 控制器');
{
    const W = world();
    const it = W.card('c:N-1', 'https://a.test/1.jpg', ['https://b.test/1.jpg']);
    const el = W.mount(it);
    ok(el.a.src === 'https://a.test/1.jpg' && W.C.visible(it), '起步:主封面');
    W.err(el);
    ok(el.a.src === 'https://b.test/1.jpg' && W.C.visible(it) && W.C.src(it) === 'https://b.test/1.jpg' && W.probes.length === 0 && W.flushes === 0, '主封面失败 → 就地换成 alt(还有地址就不探、不用等一批生效)');
    W.load(el);
    ok(W.C.visible(it) && W.C.src(it) === 'https://b.test/1.jpg' && W.C.hostOk('b.test') && !W.C.hostOk('a.test') && W.C.okPic('c:N-1', '') === 'https://b.test/1.jpg',
        'alt 加载出来:记下 b.test 成功过;收藏用的封面 = 真加载出来的这张');
    ok(W.C.visible({ id: 'x', poster_path: 'https://q.test/1.jpg' }) && !W.C.visible({ id: 'y', poster_path: '' }) && !W.C.visible({ id: 'z', poster_path: 'https://x/mac_default.jpg' }) && W.C.visible({ id: 1, poster_path: '' }),
        '没有任何能用的封面(pic 空 / 占位图)= 不出;没有字符串 id 的(不是目录卡片)不管');
    const t1 = W.card('c:N-2', 'https://tiny.test/1.jpg'), te = W.mount(t1);
    ok(W.load(te, 1, 1) === false && W.ph('c:N-2') === 'probe' && W.hostProbes('tiny.test') === 1, '1×1 的图 = 失败(onLoad 返回 false,调用方拦住事件)→ 探它的图床');
}
{
    // 文件坏(图床 up):3 秒后重试一次;还失败 → 藏(不给图床记失败)
    const W = world();
    W.okFrom('good.test');
    const it = W.card('c:F-1', 'https://bad.test/404.jpg'), el = W.mount(it);
    W.err(el);
    ok(W.ph('c:F-1') === 'probe' && W.hostProbes('bad.test') === 1 && W.hostProbes('good.test') === 1, '地址都失败了 → 成对探测:那个图床 + 对照(本会话加载成功过的 good.test)');
    W.advance(100);
    ok(W.ph('c:F-1') === 'file' && W.C.visible(it) && W.flushes === 0, '图床回了(up)= 文件坏:先不藏,3 秒后重试一次');
    el.a.src = 'stale';
    W.advance(CV.RETRY_MS);
    ok(el.a.src === 'https://bad.test/404.jpg' && W.C.state('c:F-1').fr && W.ph('c:F-1') === '', '3 秒到:从头重试(用掉文件坏的那次重试)');
    const p0 = W.probes.length;
    W.err(el);
    ok(W.ph('c:F-1') === 'hid' && W.C.state('c:F-1').hw === 'file' && W.probes.length === p0 && W.flushes === 0, '重试还失败 → 判藏(30 秒内探过这个图床:直接用结论,不再探)');
    const v0 = W.C.ver();
    W.advance(149);
    ok(W.flushes === 0, '攒一批:150ms 之内不生效');
    W.advance(2);
    ok(W.flushes === 1 && W.C.ver() === v0 + 1 && !W.C.visible(it) && W.C.src(it) === A.PLACEHOLDER, '150ms 后一次生效(版本号 +1,订阅者调一次);藏掉的卡「显示」之后用中性占位');
    W.advance(CV.STRIKE_SPAN + 1000);
    const it2 = W.card('c:F-2', 'https://bad.test/403.jpg'), e2 = W.mount(it2);
    W.err(e2); W.advance(100); W.advance(CV.RETRY_MS); W.err(e2); W.advance(200);
    ok(W.ph('c:F-2') === 'hid' && !W.C.isDeadHost('bad.test') && W.deadMem().length === 0, '图床是通的(只是文件坏):两张都藏了,也不记死图床');
}
{
    // 连不上(down、对照通):藏 + 记一次失败;30 秒内同图床别的卡直接用结论;隔 ≥60 秒另一张又 down → 记死
    const W = world({ rules: { 'dead.test': 'down' } });
    W.okFrom('good.test');
    const a = W.card('c:D-1', 'https://dead.test/1.jpg'), ea = W.mount(a);
    W.err(ea);
    W.advance(100);
    ok(W.ph('c:D-1') === 'hid' && W.C.state('c:D-1').hw === 'host' && eq(W.C.state('c:D-1').hh, ['dead.test']), 'down + 对照通 → 藏(这台设备连不上这个图床)');
    ok(!W.C.isDeadHost('dead.test') && W.deadMem().length === 0, '只记一次失败:还不记死');
    const n0 = W.probes.length;
    const b = W.card('c:D-2', 'https://dead.test/2.jpg'), eb = W.mount(b);
    W.err(eb);
    ok(W.probes.length === n0 && W.ph('c:D-2') === 'hid', '30 秒内同一个图床的别的卡:直接用刚才的结论(不再探)');
    W.advance(CV.STRIKE_SPAN + 1000);
    const pending = W.card('c:D-4', 'https://dead.test/4.jpg', ['https://good.test/d4.jpg']), ep = W.mount(pending);
    const c = W.card('c:D-3', 'https://dead.test/3.jpg'), ec = W.mount(c);
    W.err(ec);
    W.advance(100);
    ok(W.C.isDeadHost('dead.test') && W.deadMem()[0] === 'dead.test' && eq(W.reg, ['dg_cover_hosts']), '隔 ≥60 秒、另一张图又 down(对照通)→ 本机记死(落盘)');
    ok(ep.a.src === 'https://good.test/d4.jpg' && W.C.visible(pending), '挂着、还在加载的死图床地址 → 就地换 alt');
    ok(!W.C.visible(W.card('c:D-5', 'https://dead.test/5.jpg')), '只有死图床封面的卡:渲染之前就不出');
    ok(W.ctlTimers() <= 1, '控制器自己只有一个定时器', W.ctlTimers());
}
{
    // 网络问题:对照也 down → 不藏、不记失败;之后有图加载出来 → 从头再试(每张卡至少隔 15 秒)
    const W = world();
    W.okFrom('good.test');
    W.rules['*'] = 'down';
    const it = W.card('c:NT-1', 'https://flaky.test/1.jpg'), el = W.mount(it);
    W.err(el);
    W.advance(100);
    ok(W.ph('c:NT-1') === 'wait' && W.C.state('c:NT-1').why === 'net' && W.C.visible(it) && W.deadMem().length === 0, '目标 down、对照也 down → 网络问题:不藏、不记失败');
    W.rules['*'] = 'up';
    el.a.src = 'stale';
    W.okFrom('other.test');
    W.advance(10);
    ok(el.a.src === 'stale', '刚失败没多久(<15 秒):有图加载出来也先不重试');
    W.advance(CV.KICK_MS);
    ok(el.a.src === 'https://flaky.test/1.jpg' && W.ph('c:NT-1') === '', '15 秒到:因为有图加载出来过 → 从头再试(不算次数)');
    W.load(el);
    ok(W.C.visible(it) && W.C.hostOk('flaky.test'), '网好了:照常出');
    // 一张成功过的图都没有、页面上也没有别的卡:没有对照 → 网络问题
    const W2 = world({ rules: { 'lone.test': 'down' } });
    const l = W2.card('c:NT-2', 'https://lone.test/1.jpg'), le = W2.mount(l);
    W2.err(le); W2.advance(100);
    ok(W2.ph('c:NT-2') === 'wait' && W2.C.state('c:NT-2').why === 'net' && W2.hostProbes('lone.test') === 1 && W2.probes.length === 1, '没有任何对照(没成功过的图、没别的卡)→ 当网络问题:不藏');
    const W3 = world({ rules: { 'lone.test': 'up' } });
    const l3 = W3.card('c:NT-3', 'https://lone.test/x.jpg'), le3 = W3.mount(l3);
    W3.err(le3); W3.advance(100);
    ok(W3.ph('c:NT-3') === 'file', '没有对照、但目标 up → 图床通、文件坏(照样只重试一次)');
}
{
    // 本会话还没有加载成功过的图:用页面上别的卡片的封面当对照
    const W = world({ rules: { 'blocked.test': 'down' } });
    const other = W.card('c:FB-0', 'https://reach.test/0.jpg'); W.mount(other);   // 还在加载
    const it = W.card('c:FB-1', 'https://blocked.test/1.jpg'), el = W.mount(it);
    W.err(el); W.advance(100);
    ok(W.probes.some(p => p.url === 'https://reach.test/0.jpg') && W.ph('c:FB-1') === 'hid', '对照用别的卡片的封面(reach.test 通)→ 目标 down → 藏');
}
{
    // slow:30 秒后第二轮;还是 slow → 本会话藏(不记失败);第二轮 up → 留着;第二轮 down → 记失败
    const W = world({ rules: { 'hang.test': 'slow' } });
    W.okFrom('good.test');
    const it = W.card('c:SL-1', 'https://hang.test/1.jpg'), el = W.mount(it);
    W.err(el);
    W.advance(CV.PROBE_MS + 100);
    ok(W.ph('c:SL-1') === 'probe' && W.C.visible(it) && W.hostProbes('hang.test') === 1, '目标 20 秒没回、对照通 → 说不清:先不藏,等第二轮');
    W.advance(CV.ROUND2_MS - 300);
    ok(W.hostProbes('hang.test') === 1, '30 秒之内不再探');
    W.advance(400);
    ok(W.hostProbes('hang.test') === 2, '30 秒到:第二轮');
    W.advance(CV.PROBE_MS + 100);
    ok(W.ph('c:SL-1') === 'hid' && W.C.state('c:SL-1').hw === 'host' && !W.C.isDeadHost('hang.test') && W.deadMem().length === 0, '第二轮还是 slow → 本会话藏(不记失败、不记死)');
    let n = 0;
    W.rules['hang2.test'] = () => (++n === 1 ? 'slow' : 'up');
    const k2 = W.card('c:SL-2', 'https://hang2.test/1.jpg'), e2 = W.mount(k2);
    W.err(e2);
    W.advance(CV.PROBE_MS + CV.ROUND2_MS + 500);
    ok(W.ph('c:SL-2') === 'wait' && W.C.state('c:SL-2').why === 'keep' && W.C.visible(k2), '第二轮 up → 留着(只是慢),之后有图加载出来再试');
    // 第二轮 down:记失败(和之前一次 down 凑成两次 → 记死)
    W.rules['hang3.test'] = 'down';
    const k3 = W.card('c:SL-3', 'https://hang3.test/1.jpg'), e3 = W.mount(k3);
    W.err(e3); W.advance(100);
    ok(W.ph('c:SL-3') === 'hid' && !W.C.isDeadHost('hang3.test'), '先一次 down(记一次失败)');
    W.advance(CV.STRIKE_SPAN + 1000);
    let m = 0;
    W.rules['hang3.test'] = () => (++m === 1 ? 'slow' : 'down');
    const k4 = W.card('c:SL-4', 'https://hang3.test/2.jpg'), e4 = W.mount(k4);
    W.err(e4);
    W.advance(CV.PROBE_MS + CV.ROUND2_MS + 500);
    ok(W.ph('c:SL-4') === 'hid' && W.C.isDeadHost('hang3.test'), '第二轮 down(对照通)→ 藏并记失败(第二次 → 记死)');
}
{
    // 断网 / 页面在后台:不探;online / 切回前台从头再试(不算次数)
    const W = world({ rules: { 'off.test': 'down' } });
    W.okFrom('good.test');
    const it = W.card('c:OF-1', 'https://off.test/1.jpg'), el = W.mount(it);
    W.on = false;
    W.err(el);
    ok(W.ph('c:OF-1') === 'wait' && W.C.state('c:OF-1').why === 'off' && W.hostProbes('off.test') === 0, '断网:不探,等 online');
    W.advance(10 * 60000);
    ok(W.C.visible(it) && W.hostProbes('off.test') === 0, '断网十分钟也不藏、不探');
    W.on = true;
    el.a.src = 'stale';
    W.C.online();
    ok(el.a.src === 'https://off.test/1.jpg' && W.ph('c:OF-1') === '' && !W.C.state('c:OF-1').fr, 'online → 从头再试(不算次数)');
    W.hidden = true;
    W.err(el);
    ok(W.ph('c:OF-1') === 'wait' && W.C.state('c:OF-1').why === 'off' && W.hostProbes('off.test') === 0, '页面在后台:不探');
    W.hidden = false;
    el.a.src = 'stale';
    W.C.visibility(false);
    ok(el.a.src === 'https://off.test/1.jpg' && W.ph('c:OF-1') === '', '切回前台 → 从头再试');
    // 探测在路上时断网 / 切到后台 → 作废;回来重新探
    W.rules['off.test'] = 'manual';
    W.err(el);
    ok(W.ph('c:OF-1') === 'probe' && W.manual.length === 1, '在探');
    W.on = false; W.C.offline();
    ok(W.ph('c:OF-1') === 'wait' && W.C.state('c:OF-1').why === 'off', '断网了 → 在路上的探测作废,等 online');
    W.answer('off.test', 'down');
    W.advance(200);
    ok(W.C.visible(it) && W.ph('c:OF-1') === 'wait', '作废的探测回来了也不认(不藏)');
}
{
    // 页面冻过 >5 秒(睡眠):在路上的探测作废重来
    const W = world({ rules: { 'zz.test': 'manual' } });
    W.okFrom('good.test');
    const it = W.card('c:FZ-1', 'https://zz.test/1.jpg'), el = W.mount(it);
    W.err(el);
    W.advance(100);
    W.freeze(10000);
    W.answer('zz.test', 'down');                  // 睡醒:网卡还没起来,探测报错
    ok(W.ph('c:FZ-1') === 'probe' && W.manual.length === 1 && W.C.visible(it), '冻过之后才回来的探测(心跳 >6 秒没跑)→ 作废,重新探(不藏)', W.C.state('c:FZ-1'));
    W.advance(100);
    W.answer('zz.test', 'down');
    W.advance(100);
    ok(W.ph('c:FZ-1') === 'hid', '重新探的结果才算');
    // 定时器晚到 >5 秒(冻过)也作废
    const W2 = world({ rules: { 'zz.test': 'manual' } });
    W2.okFrom('good.test');
    const i2 = W2.card('c:FZ-2', 'https://zz.test/2.jpg'), e2 = W2.mount(i2);
    W2.err(e2);
    W2.advance(100);
    const ep0 = W2.C.stats().epoch;
    W2.freeze(8000);
    W2.advance(10);
    ok(W2.C.stats().epoch > ep0 && W2.manual.length === 2, '心跳晚到 >5 秒 → 作废,在等的重新探');
    W2.manual[0].cb('down');
    W2.advance(100);
    ok(W2.ph('c:FZ-2') === 'probe', '旧的那次回来了不认');
}
{
    // 本机的问题:≥3 个图床 down、看到 up 的不比它多 → 不藏、日志一次、不记失败
    const W = world({ rules: { 'g1.test': 'down', 'g2.test': 'down', 'g3.test': 'down', 'g4.test': 'down' } });
    W.okFrom('ok1.test');
    const cs = ['g1', 'g2', 'g3', 'g4'].map(h => { const it = W.card('c:G-' + h, 'https://' + h + '.test/1.jpg'); const el = W.mount(it); return { it, el }; });
    cs.forEach(x => W.err(x.el));
    W.advance(200);
    const phs = cs.map(x => W.ph(x.it.id));
    ok(phs.filter(p => p === 'hid').length === 2 && phs.filter(p => p === 'wait').length === 2 && cs.slice(2).every(x => W.C.state(x.it.id).why === 'guard'),
        '只有 1 个图床通:前两个 down 照藏;第三个起(3 个 down、1 个 up)→ 像是本机 DNS / 代理的问题,不藏', phs);
    ok(W.logs.length === 1 && /本机/.test(W.logs[0]), '日志只打一次', W.logs);
    ok(W.C.stats().guard === true, 'guard 生效');
    W.advance(CV.STRIKE_SPAN + 1000);
    const late = W.card('c:G-g3b', 'https://g3.test/2.jpg'), le = W.mount(late);
    W.err(le); W.advance(200);
    ok(W.ph('c:G-g3b') === 'wait' && !W.C.isDeadHost('g3.test'), '本机的问题期间:不藏、不记失败');
    // 对照覆盖得多(5 个图床通)→ 3 个一起 down 也分得清:照藏
    const W2 = world({ rules: { 'h1.test': 'down', 'h2.test': 'down', 'h3.test': 'down' } });
    ['o1', 'o2', 'o3', 'o4', 'o5'].forEach(h => { W2.okFrom(h + '.test'); W2.advance(5); });
    const cs2 = ['h1', 'h2', 'h3'].map(h => { const it = W2.card('c:H2-' + h, 'https://' + h + '.test/1.jpg'); const el = W2.mount(it); return { it, el }; });
    cs2.forEach(x => W2.err(x.el));
    W2.advance(200);
    ok(cs2.every(x => W2.ph(x.it.id) === 'hid') && W2.logs.length === 0 && new Set(W2.probes.filter(p => /^o\d/.test(p.h)).map(p => p.h)).size === 5,
        '同时在探的几个图床错开对照(5 个通的图床都用上了)→ 3 个 down < 5 个 up:不是本机的问题,照藏', cs2.map(x => W2.ph(x.it.id)));
}
{
    // 本机的问题只压 2 分钟(不是一票否决):到点重新成对探测(没有别的图加载、没人 kick 也会),还是 down、对照通 → 藏;对照也连不上 → 照旧不藏
    const rules = { 'p1.test': 'down', 'p2.test': 'down', 'p3.test': 'down', 'p4.test': 'down', 'p5.test': 'down' };
    const setup = (W) => {
        W.okFrom('ok1.test');
        const cs = ['p1', 'p2', 'p3', 'p4', 'p5'].map(h => { const it = W.card('c:GX-' + h, 'https://' + h + '.test/1.jpg'); return { it, el: W.mount(it) }; });
        cs.forEach(x => W.err(x.el));
        W.advance(200);
        return cs.slice(2).map(x => x.it.id);
    };
    const W = world({ rules: Object.assign({}, rules) }), ks = setup(W);
    ok(ks.every(k => W.ph(k) === 'wait' && W.C.state(k).why === 'guard'), '前提:后三个图床被「本机的问题」压着', ks.map(W.ph));
    W.advance(CV.GUARD_MS - 1000);
    const n0 = W.hostProbes('p3.test');
    ok(ks.every(k => W.ph(k) === 'wait'), '2 分钟内照旧不藏');
    W.advance(2000);
    ok(ks.every(k => W.ph(k) === 'hid') && W.hostProbes('p3.test') === n0 + 1 && W.C.stats().guard === true,
        '压满 2 分钟:重新探一次,还是 down、对照通 → 藏(这时「本机的问题」还亮着也藏;被屏蔽的图床不会永远留白卡)', ks.map(W.ph));
    const W2 = world({ rules: Object.assign({}, rules) }), ks2 = setup(W2);
    W2.rules['ok1.test'] = 'down';
    W2.advance(CV.GUARD_MS + 1000);
    ok(ks2.every(k => W2.ph(k) === 'wait' && W2.C.state(k).why === 'net'), '压满 2 分钟时对照也连不上(弱网 / 断了)→ 网络问题,照旧不藏', ks2.map(k => W2.C.state(k)));
}
{
    // 卡住:在视口附近待满 30 秒才探;up = 只是慢(2 分钟内不再探);down + 对照通 → 换 alt / 藏;网络问题 → 不动
    const W = world({ rules: { 'slowimg.test': 'up', 'black.test': 'down' } });
    W.okFrom('good.test');
    const it = W.card('c:ST-1', 'https://slowimg.test/1.jpg'), el = W.mount(it);
    const far = W.card('c:ST-0', 'https://black.test/far.jpg'), fe = W.mount(far);   // 不在视口附近(浏览器还没真发请求)
    W.see(el);
    W.advance(CV.STALL_MS - 100);
    ok(W.hostProbes('slowimg.test') === 0, '在视口附近不到 30 秒:不探');
    W.advance(200);
    ok(W.hostProbes('slowimg.test') === 1, '满 30 秒还没 load / error → 探它的图床');
    W.advance(100);
    ok(W.ph('c:ST-1') === '' && W.C.visible(it) && el.a.src === 'https://slowimg.test/1.jpg', '图床回了 → 只是慢:不动它');
    W.advance(CV.STALL_OK_MS - 2000);
    ok(W.hostProbes('slowimg.test') === 1, '2 分钟内不再为它探这个图床');
    W.advance(5000);
    ok(W.hostProbes('slowimg.test') === 2, '2 分钟后还卡着 → 再探');
    W.load(el);
    ok(W.C.visible(it) && W.C.hostOk('slowimg.test'), '最后加载出来了:照常');
    W.advance(30 * 60000);
    ok(W.hostProbes('black.test') === 0 && W.C.visible(far), '一直不在视口附近的:半小时也不探、不藏');
    // 卡在黑洞图床上:有 alt → 换 alt;没有 → 藏
    const b1 = W.card('c:ST-2', 'https://black.test/1.jpg', ['https://good.test/st2.jpg']), b1e = W.mount(b1);
    const b2 = W.card('c:ST-3', 'https://black.test/2.jpg'), b2e = W.mount(b2);
    W.see(b1e, b2e);
    W.advance(CV.STALL_MS + 200);
    ok(b1e.a.src === 'https://good.test/st2.jpg' && W.C.visible(b1), '卡住、图床 down、对照通 → 换 alt');
    W.advance(200);
    ok(W.ph('c:ST-3') === 'hid' && !W.C.visible(b2), '没有 alt → 藏');
    // 网络问题(对照也不通)→ 不动
    const W2 = world({ rules: { '*': 'down' } });
    W2.okFrom('good.test');
    const s1 = W2.card('c:ST-4', 'https://x.test/1.jpg'), s1e = W2.mount(s1);
    W2.see(s1e);
    W2.advance(CV.STALL_MS + 500);
    ok(W2.ph('c:ST-4') === '' && W2.C.visible(s1) && s1e.a.src === 'https://x.test/1.jpg', '卡住、对照也不通 → 网络问题:不动它');
    // 卡住、图床 slow、对照通 → 第二轮还 slow → 本会话藏
    const W3 = world({ rules: { 'hole.test': 'slow' } });
    W3.okFrom('good.test');
    const h1 = W3.card('c:ST-5', 'https://hole.test/1.jpg'), h1e = W3.mount(h1);
    W3.see(h1e);
    W3.advance(CV.STALL_MS + CV.PROBE_MS + 500);
    ok(W3.ph('c:ST-5') === '' && W3.C.visible(h1), '卡住、HEAD 也 20 秒没回:先不藏,等第二轮');
    W3.advance(CV.ROUND2_MS + CV.PROBE_MS + 500);
    ok(W3.ph('c:ST-5') === 'hid' && W3.deadMem().length === 0, '第二轮还 slow → 本会话藏(不记失败)');
}
{
    // 弱网:所有图床都慢(HEAD 也 20 秒没回)→ 一张都不藏;HEAD 回得来、图很慢 → 只是慢,不藏
    const W = world({ rules: { '*': 'slow' } });
    W.okFrom('good.test');
    const cs = [];
    for (let i = 0; i < 12; i++) { const it = W.card('c:WK-' + i, 'https://h' + (i % 4) + '.weak.test/' + i + '.jpg'); const el = W.mount(it); cs.push({ it, el }); }
    W.see(...cs.map(x => x.el));
    W.advance(3 * 60000);
    W.err(cs[0].el); W.err(cs[5].el);              // 弱网上也有报错的(连接被重置)
    W.advance(10 * 60000);
    ok(cs.every(x => W.C.visible(x.it) && W.ph(x.it.id) !== 'hid') && W.deadMem().length === 0 && W.flushes === 0, '弱网(全都 slow):卡住的、报错的,十几分钟一张都不藏、不记死', cs.map(x => W.ph(x.it.id)));
    const W2 = world({ rules: { '*': 'up' } });
    W2.okFrom('good.test');
    W2.lat = 8000;                                 // HEAD 要 8 秒才回
    const cs2 = [];
    for (let i = 0; i < 6; i++) { const it = W2.card('c:WK2-' + i, 'https://h' + i + '.slow.test/' + i + '.jpg'); const el = W2.mount(it); cs2.push({ it, el }); }
    W2.see(...cs2.map(x => x.el));
    W2.advance(10 * 60000);
    ok(cs2.every(x => W2.C.visible(x.it) && W2.ph(x.it.id) === ''), '弱网(HEAD 慢慢回得来、图一直没下完):只是慢,不藏');
}
{
    // 窗口化网格换块:卸载的卡不吃重试次数;重挂之后的重复失败不再探;重挂后加载出来了,晚到的结论不藏它
    const W = world();
    W.okFrom('good.test');
    const it = W.card('c:DT-1', 'https://file.test/1.jpg'), el = W.mount(it);
    W.err(el);
    W.advance(100);
    ok(W.ph('c:DT-1') === 'file', '文件坏:3 秒后重试');
    W.C.detach(el); el.isConnected = false;
    W.advance(CV.RETRY_MS);
    ok(W.ph('c:DT-1') === '' && !W.C.state('c:DT-1').fr, '重试时卡片不在页面上(换块卸载了)→ 不吃次数,重新挂上时从头试');
    const el2 = W.mount(it);
    ok(el2.a.src === 'https://file.test/1.jpg', '重新挂上:从第一个地址开始');
    W.err(el2);
    W.advance(100);
    ok(W.ph('c:DT-1') === 'file', '还是给一次重试');
    W.advance(CV.RETRY_MS);
    ok(W.C.state('c:DT-1').fr, '挂着的时候才用掉这次重试');
    W.err(el2);
    ok(W.ph('c:DT-1') === 'hid', '再失败 → 藏');
    // 在探的时候换块:重挂的那个又报一次同一个地址 → 不再探;重挂的加载出来了 → 晚到的结论不藏它
    W.rules['p.test'] = 'manual';
    const p = W.card('c:DT-2', 'https://p.test/1.jpg'), pe = W.mount(p);
    W.err(pe);
    const n0 = W.probes.length;
    W.C.detach(pe); pe.isConnected = false;
    const pe2 = W.mount(p);
    ok(pe2.a.src === 'https://p.test/1.jpg', '在探的卡重挂:还是那个地址(浏览器再请求一次 = 免费的重试)');
    W.err(pe2);
    ok(W.probes.length === n0, '重挂的又报同一个地址失败:这一轮已经在判了,不再探');
    const pe3 = W.mount(p);
    W.load(pe3);
    W.answer('p.test', 'down');
    W.advance(300);
    ok(W.ph('c:DT-2') === '' && W.C.visible(p), '重挂的加载出来了 → 晚到的「连不上」不藏它');
}
{
    // 同一个图床 30 秒内合并;同时最多 6 个成对探测
    const W = world({ rules: { '*': 'manual' } });
    W.okFrom('good.test');
    const cs = [];
    for (let i = 0; i < 20; i++) { const it = W.card('c:CC-' + i, 'https://d' + (i % 10) + '.test/' + i + '.jpg'); const el = W.mount(it); cs.push({ it, el }); }
    cs.forEach(x => W.err(x.el));
    const targets = new Set(W.probes.filter(p => /^d\d/.test(p.h)).map(p => p.h));
    ok(targets.size === CV.PAR && W.C.stats().queued === 10 - CV.PAR, '20 张卡、10 个图床:同一个图床合并成一次,同时最多 6 个在探,其余排队', [targets.size, W.C.stats().queued]);
    W.rules['*'] = 'down'; W.rules['good.test'] = 'up';
    W.manual.slice().forEach(x => { W.manual.splice(W.manual.indexOf(x), 1); x.cb(x.h === 'good.test' ? 'up' : 'down'); });
    W.advance(500);
    ok(new Set(W.probes.filter(p => /^d\d/.test(p.h)).map(p => p.h)).size === 10 && W.C.stats().queued === 0, '回来一个,排队的接着探');
}
{
    // 本机记死的图床:刷新后渲染前就跳过;1 分钟后后台探(no-store)→ down 接着死;之后每 10 分钟,up → 复活、卡片回来
    const mem = new Map([['dg_cover_hosts', JSON.stringify({ v: 1, d: { 'rv.test': 1e7 + 3600e3 } })]]);
    const W = world({ mem, rules: { 'rv.test': 'down' } });
    const it = W.card('c:RV-1', 'https://rv.test/1.jpg');
    ok(!W.C.visible(it) && W.C.isDeadHost('rv.test') && W.probes.length === 0, '本机记死的图床:卡片渲染之前就不出,不请求');
    W.advance(CV.RECHECK_FIRST - 1000);
    ok(W.hostProbes('rv.test') === 0, '1 分钟之内不探');
    W.advance(2000);
    ok(W.hostProbes('rv.test') === 1 && W.C.isDeadHost('rv.test'), '1 分钟后后台探一下:还是 down → 接着死');
    W.rules['rv.test'] = 'up';
    W.advance(CV.RECHECK_MS + 500);
    ok(W.hostProbes('rv.test') === 2 && !W.C.isDeadHost('rv.test') && W.C.visible(it) && W.deadMem().length === 0 && W.flushes >= 1, '10 分钟后再探:up → 复活(记录删掉),卡片回来');
}
{
    // 图床有目录封面加载出来了:因为连不上它藏掉的卡放回来(从头试);本机记过它死 → 后台探一下才删记录
    const W = world({ rules: { 'flap.test': 'down' } });
    W.okFrom('good.test');
    const it = W.card('c:FL-1', 'https://flap.test/1.jpg'), el = W.mount(it);
    W.err(el); W.advance(300);
    ok(W.ph('c:FL-1') === 'hid', '先藏了(连不上)');
    W.rules['flap.test'] = 'up';
    W.okFrom('flap.test');
    W.advance(300);
    ok(W.ph('c:FL-1') === '' && W.C.visible(it), 'flap.test 有图加载出来了 → 因它藏掉的卡放回来');
    const mem = new Map([['dg_cover_hosts', JSON.stringify({ v: 1, d: { 'mk.test': 1e7 + 3600e3 } })]]);
    const W2 = world({ mem });
    const im = W2.img('https://mk.test/1.jpg');
    W2.C.attach(im, W2.card('c:MK-1', 'https://mk.test/1.jpg'));
    W2.load(im);
    ok(!W2.C.isDeadHost('mk.test') && W2.deadMem()[0] === 'mk.test', '记死的图床有目录封面加载出来:本会话不当死,记录先留着(可能是缓存)');
    W2.advance(2000);
    ok(W2.hostProbes('mk.test') === 1 && W2.deadMem().length === 0, '马上后台 no-store 探一下:通了才删记录');
}
{
    // 封面代理(同源 /api/img):只按单张判 —— 3 秒后重试一次;还失败 → HEAD:404 / 410 藏;5xx / 断网不藏、以后再试;2xx 但加载出来是 1×1 → 藏
    const W = world();
    const it = W.card('c:PX-1', '/api/img?k=c%3APX-1&s=s1'), el = W.mount(it);
    W.see(el);
    W.err(el);
    ok(W.ph('c:PX-1') === 'file' && W.probes.length === 0 && W.heads.length === 0, '代理地址失败:不探图床,3 秒后重试一次');
    W.advance(CV.RETRY_MS);
    ok(W.C.state('c:PX-1').pr && W.ph('c:PX-1') === '', '重试');
    W.err(el);
    ok(W.heads.length === 1 && W.heads[0].url === '/api/img?k=c%3APX-1&s=s1' && W.ph('c:PX-1') === 'probe', '还失败 → HEAD 那一张');
    W.heads[0].cb(502);
    ok(W.ph('c:PX-1') === 'wait' && W.C.visible(it), '5xx(服务器 / 上游的问题)→ 不藏,以后再试');
    W.advance(10);
    W.okFrom('good.test');
    W.advance(CV.KICK_MS + 100);
    ok(W.ph('c:PX-1') === '', '之后有图加载出来 → 再试');
    W.err(el);
    W.heads[1].cb(404);
    ok(W.ph('c:PX-1') === 'hid', '404 → 藏');
    const t = W.card('c:PX-2', '/api/img?k=c%3APX-2&s=s1'), te = W.mount(t);
    W.load(te, 1, 1); W.advance(CV.RETRY_MS); W.load(te, 1, 1);
    W.heads[2].cb(200);
    ok(W.ph('c:PX-2') === 'hid', '加载出来是 1×1、HEAD 200 → 藏(文件不能用)');
    const e = W.card('c:PX-3', '/api/img?k=c%3APX-3&s=s1'), ee = W.mount(e);
    W.err(ee); W.advance(CV.RETRY_MS); W.err(ee);
    W.heads[3].cb(200);
    ok(W.ph('c:PX-3') === 'wait', '报错、HEAD 200(服务器说有)→ 网络问题,不藏');
    W.err(W.mount(W.card('c:PX-4', '/api/img?k=c%3APX-4&s=s1'))); W.advance(CV.RETRY_MS);
    ok(!W.C.isDeadHost('self') && W.C.stats().seen === 0, '同源永远不记死、不判卡住');
}
{
    // 服务器的死图床表:变了 → 挂着、还在加载的就地换 alt;没登记的图(继续观看)只当对照,不算「图床成功过」
    const W = world();
    const it = W.card('c:SV-1', 'https://sv.test/1.jpg', ['https://alt.test/1.jpg']), el = W.mount(it);
    W.C.setServerDead(['sv.test']);
    ok(el.a.src === 'https://alt.test/1.jpg' && W.C.src(it) === 'https://alt.test/1.jpg' && eq(W.C.deadHosts(), ['sv.test']), '服务器说死了:还在加载的就地换 alt');
    W.load(el);
    W.C.setServerDead([]);
    ok(W.C.src(it) === 'https://alt.test/1.jpg', '已经加载出来的备用封面:主封面的图床复活了也不换回去(不再闪一次)');
    const hist = W.img('https://hist.test/1.jpg');
    W.load(hist);
    ok(!W.C.hostOk('hist.test') && W.C.stats().okHosts.indexOf('hist.test') >= 0, '没登记的图(继续观看 / 收藏)加载出来:当对照,不算图床成功过(可能是缓存)');
}
{
    // 正在预览的卡片要被藏 → 先停预览;一个定时器
    const W = world({ rules: { 'pv.test': 'down' } });
    W.okFrom('good.test');
    const stops = [];
    globalThis.dgAdultPreview = { stop: (why) => stops.push(why) };
    const it = W.card('c:PV-1', 'https://pv.test/1.jpg');
    const card = { classList: { contains: (c) => c === 'dg-pv-on' } };
    const el = W.mount(it, { closest: () => card });
    W.err(el); W.advance(300);
    delete globalThis.dgAdultPreview;
    ok(eq(stops, ['cover-hidden']), '正在预览的卡片要被拿掉 → 先停预览', stops);
    ok(W.ctlTimers() <= 1, '一个定时器');
}

// ---------------- ③ 端到端:假 DOM + 真 Vue ----------------
function makeDom(win) {
    const parse = (() => {
        const cache = new Map();
        const one = (s) => {
            const c = { tag: '', id: '', cls: [], attrs: [] };
            const re = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|([.#]?)([\w-]+)|\*/g;
            let m, i = 0;
            while ((m = re.exec(s))) {
                if (m.index !== i) throw new Error('selector ' + s);
                i = re.lastIndex;
                if (m[1]) c.attrs.push([m[1], m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : null]);
                else if (m[5] === '.') c.cls.push(m[6]);
                else if (m[5] === '#') c.id = m[6];
                else if (m[6]) c.tag = m[6].toUpperCase();
            }
            if (i !== s.length) throw new Error('selector ' + s);
            return c;
        };
        return (sel) => { if (!cache.has(sel)) cache.set(sel, sel.split(',').map(a => a.trim().split(/\s+/).map(one))); return cache.get(sel); };
    })();
    const mc = (el, c) => {
        if (!el || el.nodeType !== 1) return false;
        if (c.tag && el.tagName !== c.tag) return false;
        if (c.id && el.getAttribute('id') !== c.id) return false;
        const cl = (el.getAttribute('class') || '').split(/\s+/);
        for (const x of c.cls) if (cl.indexOf(x) < 0) return false;
        for (const [k, v] of c.attrs) { const a = el.getAttribute(k); if (a == null || (v != null && a !== v)) return false; }
        return true;
    };
    const ma = (el, chain) => {
        if (!mc(el, chain[chain.length - 1])) return false;
        let n = el.parentNode, i = chain.length - 2;
        while (i >= 0 && n) { if (mc(n, chain[i])) i--; n = n.parentNode; }
        return i < 0;
    };
    const matches = (el, sel) => parse(sel).some(ch => ma(el, ch));
    let doc;
    class N {
        constructor(t, name) { this.nodeType = t; this.nodeName = name; this.parentNode = null; this.childNodes = []; this._v = ''; this._ls = Object.create(null); }
        get nodeValue() { return this.nodeType === 1 ? null : this._v; } set nodeValue(v) { this._v = String(v); }
        get data() { return this._v; } set data(v) { this._v = String(v); }
        get firstChild() { return this.childNodes[0] || null; }
        get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
        get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
        get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] || null; }
        get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
        get ownerDocument() { return doc; }
        get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc; }
        insertBefore(n, ref) { if (n.parentNode) n.parentNode.removeChild(n); const i = ref ? this.childNodes.indexOf(ref) : -1; n.parentNode = this; if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n); return n; }
        appendChild(n) { return this.insertBefore(n, null); }
        removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; if (doc && doc.activeElement && !doc.activeElement.isConnected) doc.activeElement = doc.body; return n; }
        contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
        get textContent() { if (this.nodeType === 3 || this.nodeType === 8) return this._v; return this.childNodes.map(c => (c.nodeType === 8 ? '' : c.textContent)).join(''); }
        set textContent(v) { if (this.nodeType === 3 || this.nodeType === 8) { this._v = String(v); return; } this.childNodes.slice().forEach(c => this.removeChild(c)); if (v != null && v !== '') this.appendChild(doc.createTextNode(String(v))); }
        addEventListener(t, f, o) { const cap = o === true || !!(o && o.capture); (this._ls[t] = this._ls[t] || []).push({ f, cap }); }
        removeEventListener(t, f, o) { const cap = o === true || !!(o && o.capture); this._ls[t] = (this._ls[t] || []).filter(x => !(x.f === f && x.cap === cap)); }
        querySelectorAll(sel) { const out = []; const walk = (n) => n.childNodes.forEach(c => { if (c.nodeType === 1) { if (matches(c, sel)) out.push(c); walk(c); } }); walk(this); return out; }
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    }
    class El extends N {
        constructor(tag) { super(1, tag.toUpperCase()); this.tagName = tag.toUpperCase(); this._a = Object.create(null); const st = {}; st.setProperty = (k, v) => { st[k] = v; }; st.removeProperty = (k) => { delete st[k]; }; this.style = st; }
        setAttribute(k, v) { this._a[k] = String(v); }
        getAttribute(k) { return k in this._a ? this._a[k] : null; }
        hasAttribute(k) { return k in this._a; }
        removeAttribute(k) { delete this._a[k]; }
        get className() { return this._a.class || ''; } set className(v) { this._a.class = String(v); }
        get classList() {
            const el = this, list = () => (el._a.class || '').split(/\s+/).filter(Boolean);
            return {
                contains: (c) => list().indexOf(c) >= 0,
                add: (...cs) => { const l = list(); cs.forEach(c => { if (l.indexOf(c) < 0) l.push(c); }); el._a.class = l.join(' '); },
                remove: (...cs) => { el._a.class = list().filter(c => cs.indexOf(c) < 0).join(' '); },
                toggle: (c, on) => { const has = list().indexOf(c) >= 0; const want = on === undefined ? !has : !!on; if (want && !has) el.classList.add(c); else if (!want && has) el.classList.remove(c); return want; },
            };
        }
        get id() { return this._a.id || ''; } set id(v) { this._a.id = String(v); }
        get children() { return this.childNodes.filter(n => n.nodeType === 1); }
        get innerHTML() { return ''; }
        set innerHTML(v) {
            const s = String(v == null ? '' : v);
            const dec = (x) => x.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[e]));
            const a = /^<div foo="([^"]*)">$/.exec(s);
            if (a) { this.textContent = ''; const d = new El('div'); d.setAttribute('foo', dec(a[1])); this.appendChild(d); return; }
            if (/<[a-z!/]/i.test(s)) throw new Error('innerHTML 不支持标记: ' + s.slice(0, 300));
            this.textContent = dec(s);
        }
        matches(sel) { return matches(this, sel); }
        closest(sel) { let n = this; while (n && n.nodeType === 1) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
        getBoundingClientRect() { const r = win._layout ? win._layout(this) : null; return r || { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
        get offsetHeight() { return 0; }
        focus() { if (this.isConnected) doc.activeElement = this; }
        blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    }
    class Img extends El {
        constructor() { super('img'); this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; }
        get src() { return this._a.src || ''; } set src(v) { this._a.src = String(v); }
    }
    doc = new N(9, '#document');
    doc.createElement = (t) => (String(t).toLowerCase() === 'img' ? new Img() : new El(String(t)));
    doc.createElementNS = (ns, t) => new El(String(t));
    doc.createTextNode = (v) => { const n = new N(3, '#text'); n._v = String(v); return n; };
    doc.createComment = (v) => { const n = new N(8, '#comment'); n._v = String(v); return n; };
    doc.createEvent = () => ({ timeStamp: 0, initEvent() { } });
    doc.getElementById = (id) => doc.querySelector('#' + id);
    const html = doc.appendChild(doc.createElement('html'));
    doc.documentElement = html;
    doc.head = html.appendChild(doc.createElement('head'));
    doc.body = html.appendChild(doc.createElement('body'));
    doc.activeElement = doc.body;
    doc.title = ''; doc.cookie = ''; doc.hidden = false;
    const fire = (target, type, init) => {
        const ev = Object.assign({ type, target, bubbles: false, _stop: false, defaultPrevented: false, stopPropagation() { this._stop = true; }, stopImmediatePropagation() { this._stop = true; this._imm = true; }, preventDefault() { this.defaultPrevented = true; } }, init || {});
        const path = [];
        for (let n = target; n; n = n.parentNode) path.unshift(n);
        const call = (node, phase) => {
            for (const x of ((node._ls && node._ls[type]) || []).slice()) {
                if (phase !== 'target' && !x.cap) continue;
                ev.currentTarget = node;
                x.f.call(node, ev);
                if (ev._imm) return;
            }
        };
        call(win, 'cap');
        for (const n of path.slice(0, -1)) { if (ev._stop) return ev; call(n, 'cap'); }
        if (!ev._stop) call(target, 'target');
        if (ev.bubbles && !ev._stop) for (const n of path.slice(0, -1).reverse()) { if (ev._stop) break; for (const x of ((n._ls && n._ls[type]) || []).slice()) if (!x.cap) x.f.call(n, ev); }
        return ev;
    };
    return { doc, fire, El, Img, matches };
}
async function e2e() {
    const ios = [];
    class FakeIO { constructor(cb, opt) { this.cb = cb; this.opt = opt || {}; this.t = new Set(); ios.push(this); } observe(el) { this.t.add(el); } unobserve(el) { this.t.delete(el); } disconnect() { this.t.clear(); } }
    const lsMem = new Map([['dg_age_ok', '1']]);
    const net = { calls: [], config: { adult: true, catalog: true, site_name: 'DGX', img_proxy: false, cover_dead_hosts: ['fb.dead.test'] }, related: null };
    const scrolls = [];
    const win = {
        navigator: { userAgent: 'node', onLine: true }, innerWidth: 1280, innerHeight: 800, scrollY: 0,
        location: { href: 'https://site.test/', protocol: 'https:', host: 'site.test', hostname: 'site.test', pathname: '/', search: '', hash: '', replace() { } },
        history: { state: null, pushState() { }, replaceState() { }, back() { } },
        localStorage: { getItem: k => (lsMem.has(k) ? lsMem.get(k) : null), setItem: (k, v) => lsMem.set(k, String(v)), removeItem: k => lsMem.delete(k) },
        sessionStorage: { getItem: () => null, setItem() { }, removeItem() { } },
        performance: { now: () => Date.now() }, console: { log() { }, warn() { }, error() { }, info() { } },
        setTimeout, clearTimeout, setInterval: () => 0, clearInterval() { }, queueMicrotask,
        Headers, Response, URL, URLSearchParams, AbortController,
        IntersectionObserver: FakeIO, SVGElement: function SVGElement() { }, Element: null, Node: null,
        _ls: Object.create(null),
        addEventListener(t, f, o) { const cap = o === true || !!(o && o.capture); (this._ls[t] = this._ls[t] || []).push({ f, cap }); },
        removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter(x => x.f !== f); },
        scrollTo(x, y) { scrolls.push(y); win.scrollY = y; },
        fetch: async (u) => {
            const s = String(u);
            net.calls.push(s);
            const J = (b, st) => new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json' } });
            if (s === '/api/config') return J(net.config);
            if (s.startsWith('/api/catalog/related/') && net.related) return J(net.related);
            return J({}, 404);
        },
    };
    const D = makeDom(win);
    win.document = D.doc;
    win.Element = D.El;
    win.window = win; win.self = win; win.globalThis = win;
    const ctx = vm.createContext(win);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/adult/adult.js'), 'utf8'), ctx, { filename: 'adult.js' });
    const AD = win.DgAdult;
    ok(!!AD && !!AD.covers, '假 window 里 adult.js 起来了(boot 装好文档级 load / error 捕获)');
    await ticks(12);
    ok(net.calls.includes('/api/config') && eq(AD.covers.deadHosts(), ['fb.dead.test']), 'boot:年龄确认后拿 /api/config,cover_dead_hosts 立刻生效', [net.calls, AD.covers.deadHosts()]);
    ok(['online', 'offline', 'pageshow'].every(t => (win._ls[t] || []).length > 0) && ['visibilitychange', 'resume'].every(t => (D.doc._ls[t] || []).length > 0),
        'boot:断网 / 联网 / bfcache 恢复 / 切前后台 / 冻结后恢复都接上了(在路上的探测作废重来)');
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/libs/js/vue.global.prod.min.js'), 'utf8'), ctx, { filename: 'vue.js' });
    const Vue = win.Vue;
    ok(!!Vue && typeof Vue.createApp === 'function', 'Vue 加载在 adult.js 之后(与页面同序)');
    const clock = { t: 2e7 };
    let timers = [];
    const probes = [], heads = [];
    // 假探测:按图床查 rules(没写的按 '*',默认 up),40ms 后回(slow = 20 秒后回)
    const rules = { '*': 'up' };
    const hostOfU = (u) => { const m = /^(?:https?:)?\/\/([^/:?#]+)/i.exec(String(u)); return m ? m[1].toLowerCase() : 'self'; };
    const fakeEnv = () => ({
        now: () => clock.t, log() { },
        probe: (url, ms, cb) => {
            probes.push(url);
            const h = hostOfU(url);
            const v = Object.prototype.hasOwnProperty.call(rules, h) ? rules[h] : rules['*'];
            timers.push({ f: () => cb(v), at: clock.t + (v === 'slow' ? ms : 40) });
        },
        head: (url, ms, cb) => { heads.push({ url, cb }); },
        setTimeout: (f, ms) => { const x = { f, at: clock.t + ms }; timers.push(x); return x; }, clearTimeout: (x) => { timers = timers.filter(y => y !== x); },
    });
    AD.covers._reset(fakeEnv());
    AD.covers.setServerDead(['fb.dead.test']);
    const advance = async (ms) => {
        const end = clock.t + ms;
        for (; ;) {
            const due = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            timers = timers.filter(x => x !== due);
            clock.t = Math.max(clock.t, due.at);
            due.f();
        }
        clock.t = end;
        await ticks(6);
    };
    const coverIO = () => ios.filter(x => x.opt.rootMargin === '200px 0px 200px 0px').pop();
    const gridIO = () => ios.filter(x => x.opt.rootMargin === '1600px 0px 1600px 0px').pop();
    const loadImg = (img, w, h) => { img.naturalWidth = w == null ? 320 : w; img.naturalHeight = h == null ? 180 : h; img.complete = true; return D.fire(img, 'load'); };
    const errImg = (img) => D.fire(img, 'error');
    const srv = (wk, pic, extra) => Object.assign({ wk, name: '合成作品 ' + wk, pic, sub: '', badge: '', code: '', dur: 600, n_sites: 1, bucket: 'cn_amateur' }, extra || {});
    // 页面上别处一张图(没登记的,比如继续观看的封面)加载出来了:当对照用
    let pn = 0;
    const otherImg = (h) => {
        const im = D.doc.createElement('img');
        im.setAttribute('src', 'https://' + (h || 'probe.test') + '/' + (++pn) + '.jpg');
        D.doc.body.appendChild(im);
        loadImg(im);
        D.doc.body.removeChild(im);
    };
    // 连不上的图床(rules 里写 down):报错 → 成对探测(40ms)→ 藏 → 150ms 后生效
    const failHost = async (get) => { get().forEach(errImg); await advance(300); };
    // 文件坏(图床通):报错 → 探到 up → 3 秒后重试 → 还报错 → 藏
    // 假布局:网格顶在视口顶上,6 排一块,一排 200 高,视口 800 高(卡片都在视口里 / 下面,上面没有)
    const simpleLayout = (host, cols) => (el) => {
        const cls = el.getAttribute && (el.getAttribute('class') || '');
        if (/(^|\s)dg-grid(\s|$)/.test(cls)) return { top: 0, bottom: 20000, height: 20000, width: 1000, left: 0, right: 1000 };
        if (/\bdg-blk\b/.test(cls)) { const bi = +el.getAttribute('data-blk'), top = bi * 6 * 200; return { top, bottom: top + 1180, height: 1180, width: 1000, left: 0, right: 1000 }; }
        if (/\bbrowse-card\b/.test(cls)) { const all = host.querySelectorAll('.browse-card'), i = all.indexOf(el); if (i < 0) return null; const top = Math.floor(i / cols) * 200; return { top, bottom: top + 180, height: 180, width: 200, left: 0, right: 200 }; }
        return null;
    };
    const failFile = async (get) => { get().forEach(errImg); await advance(100); await advance(AD.COVER.RETRY_MS); get().forEach(errImg); await advance(300); };

    // ---- 浏览网格(:cover)----
    {
        const cards = [];
        for (let i = 0; i < 100; i++) {
            if (i === 3) cards.push(srv('c:E-' + i, ''));
            else if (i === 4) cards.push(srv('c:E-' + i, 'https://fb.dead.test/' + i + '.jpg'));
            else if (i === 5) cards.push(srv('c:E-' + i, 'https://fb.dead.test/' + i + '.jpg', { alt: ['https://img.b.test/' + i + '.jpg'] }));
            else cards.push(srv('c:E-' + i, 'https://' + (i % 2 ? 'img.a.test' : 'img.b.test') + '/' + i + '.jpg'));
        }
        const items = cards.map(AD.cardToItem).map(Object.freeze);
        ok(items[5]._alt && items[5]._alt[0] === 'https://img.b.test/5.jpg' && !('_alt' in items[6]), 'cardToItem 带上服务器的 alt(没有就不带键)');
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        const vis = [];
        const app = Vue.createApp({
            components: { DgAdGrid: AD.components.DgAdGrid },
            data: () => ({ items }),
            methods: { onVis(n, h) { vis.push([n, h]); } },
            template: '<dg-ad-grid ref="g" :cover="true" :items="items" :tv="true" :loading="false" @vis="onVis"></dg-ad-grid>',
        });
        const root = app.mount(host);
        await ticks();
        const g = root.$refs.g;
        const blocks = () => host.querySelectorAll('.dg-blk');
        const imgs = () => host.querySelectorAll('.dg-blk img');
        const per = g.per;
        win._layout = simpleLayout(host, g.cols);
        ok(g.cols >= 4 && per === g.cols * 6 && g.shown.length === 98 && g.hiddenN === 2 && blocks().length === Math.ceil(98 / per) && blocks().length >= 4, '6 排一块;没封面的、只在死图床上的两张渲染之前就拿掉', [g.cols, g.shown.length, g.hiddenN, blocks().length]);
        ok(eq(vis[vis.length - 1], [98, 2]), '网格报「出了 98 张、藏了 2 张」(浏览页底栏按这个数)', vis);
        ok(!imgs().some(im => /fb\.dead\.test/.test(im.getAttribute('src'))) && imgs().some(im => im.getAttribute('src') === 'https://img.b.test/5.jpg'), '死图床上的地址一张都不请求;有 alt 的直接用 alt');
        const note = host.querySelector('.dg-cv-note');
        ok(note && /已隐藏 2 部封面加载不出来的作品/.test(note.textContent) && note.querySelector('.dg-cv-show') && note.getAttribute('role') == null, '网格底下:「已隐藏 2 部封面加载不出来的作品 · 显示」(不带 role=status)', note && note.textContent);
        const bs = blocks();
        gridIO().cb([{ target: bs[0], isIntersecting: true, boundingClientRect: { height: 1500 } }, { target: bs[1], isIntersecting: true, boundingClientRect: { height: 1500 } }, { target: bs[2], isIntersecting: false, boundingClientRect: { height: 1480 } }]);
        await ticks();
        ok(eq(g.dead, { 2: 1480 }) && blocks()[2].querySelectorAll('.browse-card').length === 0, '离开视口的块只留空壳');
        const first = () => Array.from(blocks()[0].querySelectorAll('.browse-card'));
        const cardOf = (wk) => host.querySelectorAll('.browse-card').find(c => c.getAttribute('data-bid') === wk);
        const cardImg = (wk) => cardOf(wk).querySelector('img');
        coverIO().cb(['c:E-0', 'c:E-1', 'c:E-7'].map(wk => ({ target: cardImg(wk), isIntersecting: true })));
        loadImg(cardImg('c:E-1')); loadImg(cardImg('c:E-7'));
        ok(cardImg('c:E-1').classList.contains('loaded'), '成功的封面:模板的 @load 照常加 loaded');
        cardOf('c:E-0').focus();
        errImg(cardImg('c:E-0'));
        await advance(200);
        ok(g.shown.length === 98 && !!cardOf('c:E-0') && probes.some(u => /img\.b\.test\/0\.jpg/.test(u)) && probes.some(u => /img\.a\.test/.test(u)), '报错 → 探那个图床 + 对照;图床通(文件坏)→ 先不藏,3 秒后重试');
        const dead0 = Object.assign({}, g.dead);
        await failFile(() => [cardImg('c:E-0')]);
        ok(g.shown.length === 97 && g.hiddenN === 3 && !cardOf('c:E-0'), '重试还失败 → 从网格里拿掉', [g.shown.length, g.hiddenN]);
        ok(first().length === per && first()[0].getAttribute('data-bid') === 'c:E-1' && blocks()[1].querySelectorAll('.browse-card').length === per, '拿掉之后块还是满的(后面的卡往前补,块边上不留洞)', [first().length, per]);
        ok(eq(g.dead, dead0) && blocks().length === Math.ceil(97 / per) && blocks()[2].querySelectorAll('.browse-card').length === 0, '窗口化网格不整个重来(空壳块和量好的高度都还在)', g.dead);
        ok(D.doc.activeElement && D.doc.activeElement.getAttribute && D.doc.activeElement.getAttribute('data-bid') === 'c:E-1', '焦点在被拿掉的卡上 → 还给紧跟着的那张(遥控器不丢焦点)', D.doc.activeElement && D.doc.activeElement.getAttribute && D.doc.activeElement.getAttribute('data-bid'));
        ok(/已隐藏 3 部/.test(host.querySelector('.dg-cv-note').textContent) && eq(vis[vis.length - 1], [97, 3]), '已隐藏的数跟着变;网格报新的数');
        coverIO().cb(['c:E-8', 'c:E-12'].map(wk => ({ target: cardImg(wk), isIntersecting: true })));
        cardOf('c:E-12').focus();
        await failFile(() => [cardImg('c:E-8'), cardImg('c:E-12')]);
        ok(!cardOf('c:E-8') && !cardOf('c:E-12') && D.doc.activeElement.getAttribute('data-bid') === 'c:E-13', '焦点卡和前面一张一起拿掉 → 焦点给紧跟在它后面的 E-13', D.doc.activeElement.getAttribute && D.doc.activeElement.getAttribute('data-bid'));
        const tinyImg = cardImg('c:E-9');
        const ev = loadImg(tinyImg, 1, 1);
        ok(ev._stop && !tinyImg.classList.contains('loaded'), '1×1 的图:文档级捕获拦住 load(模板不加 loaded,不显示)');
        await advance(100); await advance(AD.COVER.RETRY_MS);
        loadImg(cardImg('c:E-9'), 1, 1);
        await advance(300);
        ok(!cardOf('c:E-9') && g.hiddenN === 6, '小图当失败:重试还是 1×1 → 拿掉', g.hiddenN);
        ok(eq(g.dead, dead0) && blocks().length === Math.ceil(94 / per), '片单变短、块数可能变少:只丢超出的块的记录,前面量好的空壳不动(不整个重来)', [g.dead, blocks().length]);
        const np = probes.length;
        await advance(10 * 60000);
        ok(g.shown.length === 94 && !!cardOf('c:E-2') && !probes.slice(np).some(u => /\/2\.jpg/.test(u)), '没有结果的、还没进视口附近(浏览器还没真发请求)的:十分钟也不探、不拿掉', [g.shown.length, g.hiddenN]);
        const pv = [];
        win.dgAdultPreview = { stop(why) { pv.push(why); } };
        cardOf('c:E-14').classList.add('dg-pv-on');
        await failFile(() => [cardImg('c:E-14')]);
        ok(!cardOf('c:E-14') && eq(pv, ['cover-hidden']), '正在预览的卡片要被拿掉 → 先停预览(卡片卸载后 preview.js 收不到离开事件)', pv);
        delete win.dgAdultPreview;
        D.fire(host.querySelector('.dg-cv-show'), 'click');
        await ticks();
        ok(g.reveal && g.shown.length === 100 && !host.querySelector('.dg-cv-note') && eq(vis[vis.length - 1], [100, 0]), '点「显示」:藏掉的全部出来,提示行收起');
        const shownImg = (wk) => { const c = cardOf(wk); return c ? c.querySelector('img').getAttribute('src') : null; };
        ok(shownImg('c:E-0') === AD.PLACEHOLDER && shownImg('c:E-3') === AD.PLACEHOLDER && shownImg('c:E-4') === AD.PLACEHOLDER, '显示出来的坏卡用中性占位(死图床的地址照样不请求)');
        win._layout = null;
        app.unmount();
        ok(AD.covers.stats().els === 0, '网格卸载:<img> 登记全部撤掉');
    }
    // ---- 视口上面的改动先压着 —— 不滚、正在看的卡一张都不动;翻过去了(到了视口下面)才放开;放回来的插入点在上面也先不插 ----
    {
        AD.covers._reset(fakeEnv());
        rules['jump.bad.test'] = 'down';
        const items = [];
        for (let i = 0; i < 120; i++) {
            const bad = i === 2 || i === 27 || i === 60;
            items.push(srv('c:J-' + i, 'https://' + (bad ? 'jump.bad.test' : i === 70 ? 'late.test' : 'jump.ok.test') + '/' + i + '.jpg'));
        }
        const its = items.map(AD.cardToItem).map(Object.freeze);
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        const app = Vue.createApp({ components: { DgAdGrid: AD.components.DgAdGrid }, data: () => ({ items: its }), template: '<dg-ad-grid ref="g" :cover="true" :items="items"></dg-ad-grid>' });
        const root = app.mount(host);
        await ticks();
        const g = root.$refs.g, cols = g.cols, GT = 1000, RH = 200, BH = 6 * RH - 20;
        let gridHidden = false;
        // 假布局:卡片按渲染顺序一排 cols 张,每排 200 高,网格顶在文档 1000 处;块 = 6 排;都减去 scrollY(没有浏览器滚动锚定)。gridHidden = 网格没排版(display:none)
        win._layout = (el) => {
            if (gridHidden) return null;
            const cls = el.getAttribute && (el.getAttribute('class') || '');
            if (/(^|\s)dg-grid(\s|$)/.test(cls)) { const top = GT - win.scrollY; return { top, bottom: top + 30000, height: 30000, width: 1000, left: 0, right: 1000 }; }
            if (/\bdg-blk\b/.test(cls)) { const bi = +el.getAttribute('data-blk'), top = GT + bi * 6 * RH - win.scrollY; return { top, bottom: top + BH, height: BH, width: 1000, left: 0, right: 1000 }; }
            if (/\bbrowse-card\b/.test(cls)) {
                const all = host.querySelectorAll('.browse-card'), i = all.indexOf(el);
                if (i < 0) return null;
                const top = GT + Math.floor(i / cols) * RH - win.scrollY, left = (i % cols) * 220;
                return { top, bottom: top + 180, height: 180, width: 200, left, right: left + 200 };
            }
            return null;
        };
        win.scrollY = GT + 5 * RH;   // 视口顶 = 第 5 排的顶;视口里是第 5~8 排
        const inView = () => host.querySelectorAll('.browse-card').map(c => ({ id: c.getAttribute('data-bid'), r: c.getBoundingClientRect() })).filter(x => x.r.bottom > 1 && x.r.top < 800);
        const cardOf = (wk) => host.querySelectorAll('.browse-card').find(c => c.getAttribute('data-bid') === wk);
        const bad = () => ['c:J-2', 'c:J-27', 'c:J-60'].map(wk => cardOf(wk).querySelector('img'));
        const before = inView();
        const top0 = new Map(before.map(x => [x.id, x.r.top]));
        const sc0 = scrolls.length;
        otherImg();
        await failHost(bad);
        const after = inView();
        ok(!!cardOf('c:J-2') && cardOf('c:J-2').querySelector('img').getAttribute('src') === AD.PLACEHOLDER && !cardOf('c:J-27') && !cardOf('c:J-60') && g.hiddenN === 2,
            '图床连不上:视口上面那张(J-2)判了藏也先压着(留在原处、中性占位);视口里的(J-27)和下面的(J-60)照常拿掉', [g.shown.length, g.hiddenN]);
        const moved = before.filter(x => x.id < 'c:J-27' && top0.get(x.id) !== (after.find(y => y.id === x.id) || { r: {} }).r.top);
        ok(win.scrollY === GT + 5 * RH && scrolls.length === sc0 && before.filter(x => /^c:J-2[0-6]$/.test(x.id)).every(x => (after.find(y => y.id === x.id) || { r: {} }).r.top === x.r.top && (after.find(y => y.id === x.id) || { r: {} }).r.left === x.r.left),
            '不滚动;视口里被拿掉那张前面的卡一张都没挪(上面没有改动)', { scrollY: win.scrollY, scrolled: scrolls.slice(sc0), moved: moved.map(x => x.id) });
        win.scrollY = 0;
        gridIO().cb([{ target: host.querySelectorAll('.dg-blk')[0], isIntersecting: true, boundingClientRect: { height: BH } }]);
        await ticks();
        ok(!cardOf('c:J-2') && g.hiddenN === 3 && g.shown.length === 117, '翻过去了(J-2 到了视口下面)→ 放开,这时拿掉看不见', [g.hiddenN, g.shown.length]);
        win.scrollY = GT + 5 * RH;
        AD.covers.setServerDead(['fb.dead.test', 'late.test']);
        await advance(200);
        ok(!cardOf('c:J-70') && g.hiddenN === 4, '视口下面的卡(J-70)不出了:照常拿掉');
        win.scrollY = GT + 19 * RH;
        const before2 = inView();
        const sc1 = scrolls.length;
        AD.covers.setServerDead(['fb.dead.test']);
        await advance(200);
        const after2 = inView();
        ok(!cardOf('c:J-70') && scrolls.length === sc1 && before2.every(x => { const y = after2.find(z => z.id === x.id); return y && y.r.top === x.r.top && y.r.left === x.r.left; }),
            '放回来的卡插入点在视口上面 → 先不插(视口里的卡一张都不挪)', before2.map(x => x.id).slice(0, 5));
        win.scrollY = 0;
        gridIO().cb([{ target: host.querySelectorAll('.dg-blk')[0], isIntersecting: true, boundingClientRect: { height: BH } }]);
        await ticks();
        ok(!!cardOf('c:J-70') && g.hiddenN === 3, '翻回去了(插入点到了视口下面)→ 插回来');
        // 网格没排版(浏览页被 v-show 藏着、搜索页在上面):视口里的、下面的,什么都不动;有排版了再按视口放
        win.scrollY = GT + 5 * RH;
        gridHidden = true;
        const ids0 = g.shown.map(it => it.id).join(',');
        AD.covers.setServerDead(['fb.dead.test', 'late.test', 'jump.ok.test']);   // 几乎所有卡都不出了(视口里的、上面的、下面的都有)
        await advance(200);
        ok(g.shown.map(it => it.id).join(',') === ids0 && g.hiddenN === 3, '网格没排版:一张都不拿(回来时滚回原位,上面少了卡就对不上了)', g.hiddenN);
        gridHidden = false;
        gridIO().cb([{ target: host.querySelectorAll('.dg-blk')[0], isIntersecting: false, boundingClientRect: { height: BH } }]);
        await ticks();
        const shown = g.shown.map(it => it.id);
        ok(shown.indexOf('c:J-1') >= 0 && shown.indexOf('c:J-0') >= 0 && shown.indexOf('c:J-40') < 0 && shown.indexOf('c:J-100') < 0,
            '有排版了:视口上面的接着压着,视口里 / 下面的才拿掉', shown.slice(0, 8));
        win._layout = null;
        app.unmount();
        win.scrollY = 0;
    }
    // ---- 压着的卡到了视口里 / 列表顶上就放开(不会一直是灰的占位卡):回到顶上(滚动停下来再放)、从搜索页回来(有了排版)----
    {
        AD.covers._reset(fakeEnv());
        rules['hd.bad.test'] = 'down'; rules['hd.bad2.test'] = 'down';
        const items = [];
        for (let i = 0; i < 90; i++) items.push(srv('c:HD-' + i, 'https://' + (i === 1 ? 'hd.bad.test' : i === 31 ? 'hd.bad2.test' : 'hd.ok.test') + '/' + i + '.jpg'));
        const its = items.map(AD.cardToItem).map(Object.freeze);
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        const app = Vue.createApp({ components: { DgAdGrid: AD.components.DgAdGrid }, data: () => ({ items: its }), template: '<dg-ad-grid ref="g" :cover="true" :items="items"></dg-ad-grid>' });
        const root = app.mount(host);
        await ticks();
        const g = root.$refs.g, cols = g.cols, GT = 300, RH = 200, BH = 6 * RH - 20;
        let gridHidden = false;
        win._layout = (el) => {
            if (gridHidden) return null;
            const cls = el.getAttribute && (el.getAttribute('class') || '');
            if (/(^|\s)dg-grid(\s|$)/.test(cls)) { const top = GT - win.scrollY; return { top, bottom: top + 30000, height: 30000, width: 1000, left: 0, right: 1000 }; }
            if (/\bdg-blk\b/.test(cls)) { const bi = +el.getAttribute('data-blk'), top = GT + bi * 6 * RH - win.scrollY; return { top, bottom: top + BH, height: BH, width: 1000, left: 0, right: 1000 }; }
            if (/\bbrowse-card\b/.test(cls)) {
                const all = host.querySelectorAll('.browse-card'), i = all.indexOf(el);
                if (i < 0) return null;
                const top = GT + Math.floor(i / cols) * RH - win.scrollY, left = (i % cols) * 220;
                return { top, bottom: top + 180, height: 180, width: 200, left, right: left + 200 };
            }
            return null;
        };
        const cardOf = (wk) => host.querySelectorAll('.browse-card').find(c => c.getAttribute('data-bid') === wk);
        win.scrollY = GT + 4 * RH;   // 视口顶 = 第 4 排:HD-1(第 0 排)在视口上面
        otherImg();
        await failHost(() => [cardOf('c:HD-1').querySelector('img')]);
        ok(!!cardOf('c:HD-1') && g.hiddenN === 0, '前提:视口上面的 HD-1 判了藏,先压着(中性占位)');
        win.scrollY = 0;   // 翻回列表顶上(块的 IntersectionObserver 没有回调)
        (win._ls.scroll || []).forEach(x => x.f());
        await new Promise(r => setTimeout(r, 260));
        await ticks();
        ok(!cardOf('c:HD-1') && g.hiddenN === 1 && !(win._ls.scroll || []).length, '回到列表顶上、滚动停下来 → 放开(首屏里不留灰的占位卡);没有压着的了就撤掉滚动侦听', [g.hiddenN, (win._ls.scroll || []).length]);
        win.scrollY = GT + 4 * RH;
        gridHidden = true;   // 浏览页藏在搜索页后面
        await failHost(() => [cardOf('c:HD-31').querySelector('img')]);
        ok(!!cardOf('c:HD-31') && g.hiddenN === 1, '前提:网格没排版时判的藏全压着');
        gridHidden = false;  // 回来了,滚回存下的位置:HD-31 在视口里
        gridIO().cb([{ target: host.querySelectorAll('.dg-blk')[0], isIntersecting: true, boundingClientRect: { height: BH } }]);
        await ticks();
        ok(!cardOf('c:HD-31') && g.hiddenN === 2, '有了排版、它在视口里 → 放开(不用等它整个到了视口下面)', g.hiddenN);
        win._layout = null;
        app.unmount();
        win.scrollY = 0;
    }
    // ---- 「显示」:插回去的卡在视口上面 → 补滚动(老 WebView 没有滚动锚定),焦点给视口里第一张放出来的卡 ----
    {
        AD.covers._reset(fakeEnv());
        const items = [];
        for (let i = 0; i < 60; i++) items.push(srv('c:RV-' + i, 'https://' + (i % 10 === 3 ? 'rv.dead.test' : 'rv.ok.test') + '/' + i + '.jpg'));
        AD.covers.setServerDead(['fb.dead.test', 'rv.dead.test']);
        const its = items.map(AD.cardToItem).map(Object.freeze);
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        const app = Vue.createApp({ components: { DgAdGrid: AD.components.DgAdGrid }, data: () => ({ items: its }), template: '<dg-ad-grid ref="g" :cover="true" :items="items" :tv="true"></dg-ad-grid>' });
        const root = app.mount(host);
        await ticks();
        const g = root.$refs.g, cols = g.cols, GT = 500, RH = 200;
        ok(g.hiddenN === 6, '6 张在死图床上:藏着');
        win._layout = (el) => {
            const cls = el.getAttribute && (el.getAttribute('class') || '');
            const n = host.querySelectorAll('.browse-card').length, rows = Math.ceil(n / cols);
            if (/(^|\s)dg-grid(\s|$)/.test(cls)) { const top = GT - win.scrollY; return { top, bottom: top + rows * RH + 40, height: rows * RH + 40, width: 1000, left: 0, right: 1000 }; }
            if (/\bbrowse-card\b/.test(cls)) {
                const all = host.querySelectorAll('.browse-card'), i = all.indexOf(el);
                if (i < 0) return null;
                const top = GT + Math.floor(i / cols) * RH - win.scrollY;
                return { top, bottom: top + 180, height: 180, width: 200, left: 0, right: 200 };
            }
            return null;
        };
        const rows0 = Math.ceil(g.shown.length / cols);
        win.scrollY = GT + rows0 * RH + 40 - 700;   // 翻到底:视口下沿刚好露出「显示」那一行
        const cards = () => host.querySelectorAll('.browse-card');
        const firstVis = () => cards().find(c => c.getBoundingClientRect().bottom > 1);
        const fv = firstVis(), fvId = fv.getAttribute('data-bid'), fvTop = fv.getBoundingClientRect().top;
        const btn = host.querySelector('.dg-cv-show');
        btn.focus();
        const sc0 = scrolls.length;
        D.fire(btn, 'click');
        await ticks();
        const fv2 = cards().find(c => c.getAttribute('data-bid') === fvId);
        ok(g.shown.length === 60 && scrolls.length === sc0 + 1 && fv2 && Math.abs(fv2.getBoundingClientRect().top - fvTop) < 1,
            '点「显示」:上面插回去的卡把内容往下顶 → 补滚动,视口里原来那张卡不动', { scrolled: scrolls.slice(sc0), top: fv2 && fv2.getBoundingClientRect().top, fvTop });
        const ae = D.doc.activeElement, aid = ae && ae.getAttribute ? ae.getAttribute('data-bid') : '';
        const aTop = ae && ae.getBoundingClientRect ? ae.getBoundingClientRect().top : -1;
        ok(/^c:RV-\d*3$/.test(aid) && aTop >= 0 && aTop < 800, '「显示」点完就没了:焦点给视口里第一张放出来的卡(遥控器不丢焦点)', aid);
        win._layout = null; win.scrollY = 0;
        app.unmount();
    }
    // ---- 搜索结果流式重排(keep)不带着页面走 ----
    {
        AD.covers._reset(fakeEnv());
        const mk = (i) => Object.freeze({ id: 'g' + i + '|', _wk: '', title: '组' + i, name: '组' + i, poster_path: 'https://keep.test/' + i + '.jpg', _n: 1, _sub: '', _badge: '', _code: '', _durText: '', _pk: 'g' + i });
        const list = []; for (let i = 0; i < 160; i++) list.push(mk(i));
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        const app = Vue.createApp({ components: { DgAdGrid: AD.components.DgAdGrid }, data: () => ({ items: list }), template: '<dg-ad-grid ref="g" :keep="true" :cover="true" :items="items"></dg-ad-grid>' });
        const root = app.mount(host);
        await ticks();
        const cols = root.$refs.g.cols;
        win._layout = (el) => {
            const cls = el.getAttribute && (el.getAttribute('class') || '');
            if (/(^|\s)dg-grid(\s|$)/.test(cls)) { const top = 100 - win.scrollY; return { top, bottom: top + 9000, height: 9000, width: 1000, left: 0, right: 1000 }; }
            if (/\bbrowse-card\b/.test(cls)) { const all = host.querySelectorAll('.browse-card'), i = all.indexOf(el); if (i < 0) return null; const top = 100 + Math.floor(i / cols) * 200 - win.scrollY; return { top, bottom: top + 180, height: 180, width: 200, left: 0, right: 200 }; }
            return null;
        };
        win.scrollY = 2500;
        const sc0 = scrolls.length;
        const firstVis = host.querySelectorAll('.browse-card').find(c => c.getBoundingClientRect().bottom > 1);
        const fi = list.findIndex(x => x.id === firstVis.getAttribute('data-bid'));
        const re = list.slice(); const [mv] = re.splice(fi, 1); re.splice(Math.max(0, fi - 12), 0, mv);
        root.items = re;
        await ticks();
        const re2 = re.slice(); const [mv2] = re2.splice(fi + 1, 1); re2.unshift(mv2);
        root.items = re2;
        await ticks();
        ok(win.scrollY === 2500 && scrolls.length === sc0, '搜索结果流式重排(keep)→ 页面不动(不追着第一张可见的卡滚)', { scrollY: win.scrollY, scrolls: scrolls.slice(sc0) });
        win._layout = null;
        app.unmount();
        win.scrollY = 0;
    }
    // ---- 搜索网格(keep + :cover):主封面坏了 → 同组别的线路的海报;收藏用换到的那张 ----
    {
        AD.covers._reset(fakeEnv());
        AD.covers.setServerDead(['fb.dead.test']);
        const groups = [
            { name: '合成搜索一', _wk: 'c:SR-1', pic: 'https://dead1.test/a.jpg', sources: [{ vod_pic: 'https://dead1.test/a.jpg' }, { vod_pic: 'https://line2.test/a.jpg' }] },
            { name: '合成搜索二', _wk: '', pic: '', sources: [{ vod_pic: '' }] },
            { name: '合成搜索三', _wk: '', pic: 'https://dead3.test/c.jpg', sources: [{ vod_pic: 'https://dead3.test/c.jpg' }, { vod_pic: 'https://line3.test/c.jpg' }] },
        ];
        const items = groups.map(g => {
            const o = { id: g.name + '|', _wk: g._wk, title: g.name, name: g.name, poster_path: g.pic, _n: 1, _sub: '', _badge: '', _code: '', _durText: '', _pk: g.name, _g: g };
            const alt = AD.searchAlts(g, g.pic, 3);
            if (alt.length) o._alt = alt;
            return Object.freeze(o);
        });
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        const app = Vue.createApp({ components: { DgAdGrid: AD.components.DgAdGrid }, data: () => ({ items }), template: '<dg-ad-grid ref="g" :keep="true" :cover="true" :items="items"></dg-ad-grid>' });
        const root = app.mount(host);
        await ticks();
        const ims = host.querySelectorAll('.browse-card img');
        ok(root.$refs.g.hiddenN === 1 && /已隐藏 1 部/.test(host.querySelector('.dg-cv-note').textContent), '搜索结果:没有任何海报的那组藏到「已隐藏 1 部 · 显示」里');
        errImg(ims[0]); errImg(ims[1]);
        ok(ims[0].getAttribute('src') === 'https://line2.test/a.jpg' && ims[1].getAttribute('src') === 'https://line3.test/c.jpg', '主封面失败 → 换同组别的线路的海报');
        loadImg(ims[0]); loadImg(ims[1]);
        await advance(300);
        ok(root.$refs.g.shown.length === 2 && ims[0].classList.contains('loaded'), '备用海报加载成功:卡片照常');
        const fav = AD.mixin.methods.adOkPic;
        ok(fav({ _wk: 'c:SR-1', name: '合成搜索一' }, '合成搜索一') === 'https://line2.test/a.jpg' && fav({ _wk: '', name: '合成搜索三' }, '合成搜索三') === 'https://line3.test/c.jpg' && fav({ _wk: 'c:NONE' }, 'x') === '',
            '收藏:主封面坏了、换到的备用海报真加载出来了 → 收藏的封面用那张(按作品键 / 海报键找)');
        app.unmount();
    }
    // ---- 首页行:index.html 原样的卡片模板 + mixin ----
    {
        AD.covers._reset(fakeEnv());
        AD.covers.setServerDead(['fb.dead.test']);
        rules['row.a.test'] = 'down'; rules['row.b2.test'] = 'down'; rules['sg.bad.test'] = 'down';
        const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
        const start = HTML.indexOf('<div class="hot-card" v-for="item in rowLists[key]"');
        const re = /<\/?div\b[^>]*>/g;
        re.lastIndex = start;
        let depth = 0, end = -1, m;
        while ((m = re.exec(HTML))) { if (m[0][1] === '/') depth--; else depth++; if (depth === 0) { end = m.index + m[0].length; break; } }
        const cardTpl = HTML.slice(start, end).replace(/<!--[\s\S]*?-->/g, '');
        ok(start > 0 && end > start && /v-dg-cv="item"/.test(cardTpl) && /:src="item\._wk && adultMode \? adCvSrc\(item\) : getPosterUrl\(item\.poster_path\)"/.test(cardTpl), 'index.html 首页行卡片:<img v-dg-cv="item" :src="adCvSrc(item)">');
        const tpl = '<div class="home"><div v-for="key in Object.keys(rowConfigs)" :key="key" class="section-container" :data-row-key="key"><div class="hot-row">' + cardTpl + '</div></div>'
            + '<div class="hist"><div class="history-card" v-for="h in watchHistory" :key="h.name"><div class="poster-wrap"><img :src="h.poster" loading="lazy"></div></div></div></div>';
        const bbMore = [];
        for (let i = 11; i <= 16; i++) bbMore.push(srv('c:H-' + i, 'https://row.b.test/' + i + '.jpg'));
        const home = {
            rows: [
                { id: 'aa', title: '行一', items: [srv('c:H-1', 'https://row.a.test/1.jpg'), srv('c:H-2', 'https://row.a.test/2.jpg')] },
                { id: 'bb', title: '行二', items: [srv('c:H-3', 'https://row.b2.test/3.jpg'), srv('c:H-4', 'https://row.b.test/4.jpg'), srv('c:H-5', 'https://fb.dead.test/5.jpg'), srv('c:H-6', '')].concat(bbMore) },
                { id: 'cc', title: '行三', items: [srv('c:H-7', 'https://row.c.test/7.jpg')] },
                { id: 'dd', title: '全在死图床', items: [srv('c:H-8', 'https://fb.dead.test/8.jpg')] },
                { id: 'ff', title: '行五', items: [srv('c:H-30', 'https://row.f.test/30.jpg')] },
            ],
        };
        win.fetch = async (u) => {
            const s = String(u);
            const J = (b, st) => new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json' } });
            if (s === '/api/catalog/home') return J(home);
            if (s === '/api/catalog/buckets') return J([]);
            return J({}, 404);
        };
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        let searched = 0;
        const app = Vue.createApp({
            mixins: [AD.mixin],
            data: () => ({ rowConfigs: {}, rowLists: {}, viewPages: {}, watchHistory: [{ name: '看过的', poster: 'https://hist.test/1.jpg' }], favList: [], showDetail: false }),
            methods: { getPosterUrl: (p) => p || 'data:image/svg+xml,x', autoSearch() { searched++; } },
            template: tpl,
        });
        const vmRoot = app.mount(host);
        vmRoot.adult.catalog = true;
        await vmRoot.adultLoadHome();
        await ticks();
        ok(eq(Object.keys(vmRoot.rowConfigs), ['ad_aa', 'ad_bb', 'ad_cc', 'ad_ff']) && vmRoot.rowLists.ad_bb.length === 8, '首页行:死图床 / 没封面的卡片渲染之前拿掉;全在死图床上的那行整行不出', [Object.keys(vmRoot.rowConfigs), vmRoot.rowLists.ad_bb && vmRoot.rowLists.ad_bb.length]);
        const sec = (k) => host.querySelectorAll('[data-row-key]').find(s => s.getAttribute('data-row-key') === k);
        const rowImg = (wk) => host.querySelectorAll('.hot-card').find(c => c.getAttribute('data-wk') === wk).querySelector('img');
        ok(host.querySelectorAll('.hot-card').length === 12 && rowImg('c:H-3').getAttribute('src') === 'https://row.b2.test/3.jpg', '首页行渲染了 12 张卡,<img src> 是控制器给的地址');
        win._layout = (el) => {
            const k = el.getAttribute && el.getAttribute('data-row-key');
            if (k) {
                const all = host.querySelectorAll('[data-row-key]'), i = all.indexOf(el);
                if (i < 0) return null;
                const top = i * 400 - win.scrollY;
                return { top, bottom: top + 400, height: 400, width: 1000, left: 0, right: 1000 };
            }
            const cls = el.getAttribute && (el.getAttribute('class') || '');
            if (/\bhot-row\b/.test(cls)) return { top: 0, bottom: 300, height: 300, width: 1000, left: 0, right: 1000 };
            if (/\bhot-card\b/.test(cls)) {
                const row = el.parentNode, all = row.querySelectorAll('.hot-card'), i = all.indexOf(el);
                const left = i * 300 - (row.scrollLeft || 0);
                return { top: 0, bottom: 280, height: 280, width: 280, left, right: left + 280 };
            }
            return null;
        };
        win.scrollY = 500;
        const rowB = sec('ad_bb').querySelector('.hot-row');
        rowB.scrollLeft = 900;
        const firstInRow = () => { for (const c of rowB.querySelectorAll('.hot-card')) { const r = c.getBoundingClientRect(); if (r.right > 1) return { wk: c.getAttribute('data-wk'), left: r.left }; } return null; };
        const b0 = firstInRow();
        const histImg = host.querySelector('.history-card img');
        errImg(histImg);
        ok(histImg.getAttribute('src') === 'https://hist.test/1.jpg' && vmRoot.watchHistory.length === 1, '继续观看的封面出错:不藏、不换(继续观看 / 收藏从来不藏)');
        coverIO().cb(host.querySelectorAll('.hot-card img').map(im => ({ target: im, isIntersecting: true })));
        loadImg(rowImg('c:H-7'));
        ['p1.test', 'p2.test', 'p3.test', 'p4.test'].forEach(otherImg);   // 页面上别处还有几个图床的图加载出来了(对照够多,分得清不是本机的问题)
        await failHost(() => [rowImg('c:H-1'), rowImg('c:H-2'), rowImg('c:H-3')]);
        ok(eq(Object.keys(vmRoot.rowConfigs), ['ad_bb', 'ad_cc', 'ad_ff']) && !sec('ad_aa') && vmRoot.rowLists.ad_bb.length === 7 && host.querySelectorAll('.hot-card').length === 9, '首页行:连不上的图床上的卡拿掉,一张不剩的行整行不出', [Object.keys(vmRoot.rowConfigs), host.querySelectorAll('.hot-card').length]);
        ok(win.scrollY === 100, '上面的行没了:滚动位置补回去(正在看的行二不跳)', win.scrollY);
        const b1 = firstInRow();
        ok(b0 && b1 && b0.wk === 'c:H-12' && b1.wk === b0.wk && b1.left === b0.left && rowB.scrollLeft === 600, '横排左边(视口外)那张没了 → scrollLeft 补回去,露出来的第一张还是 H-12、位置不动', { b0, b1, sl: rowB.scrollLeft });
        ok(!AD.covers.isDeadHost('row.a.test'), '行一的两张图同一阵 down:只探一次、只记一次失败,图床不记死(卡片照样藏)');
        ok(searched === 0, '没有走片名搜索');
        // 播放页开着(首页各层排着版、只是看不见)→ 不滚窗口,改关掉播放页时要回到的位置
        vmRoot.showDetail = true;
        await ticks();
        win.scrollY = 400;
        vmRoot._adReturnY = 400;
        const sc0 = scrolls.length;
        coverIO().cb([{ target: rowImg('c:H-7'), isIntersecting: true }]);
        await failFile(() => [rowImg('c:H-7')]);
        ok(!sec('ad_cc') && scrolls.length === sc0 && win.scrollY === 400 && vmRoot._adReturnY === 0, '播放页开着时上面的行没了 → 窗口不动,回去的位置跟着改(关掉播放页回到原来那一行)', { y: win.scrollY, ret: vmRoot._adReturnY, scrolls: scrolls.slice(sc0) });
        vmRoot.showDetail = false;
        await ticks();
        // 搜索联想 —— 下拉开着时封面坏了也不删行(鼠标指着的 / 方向键选中的不跳);下次重算才拿掉,高亮跟着那一行
        const sItems = [srv('c:SG-1', 'https://row.c.test/s1.jpg'), srv('c:SG-2', 'https://sg.bad.test/2.jpg'), srv('c:SG-3', 'https://row.c.test/s3.jpg'), srv('c:SG-4', '')].map(AD.cardToItem);
        const S = vmRoot.adult.sug;
        S.q = '合成'; S.items = sItems; S.alias = null; S.hi = -1; S.open = true;
        await ticks();
        ok(eq(vmRoot.adSugRows.map(r => r.k), ['i:c:SG-1', 'i:c:SG-2', 'i:c:SG-3', 'all']), '搜索联想:没有封面的作品(pic 空)整行不出', vmRoot.adSugRows.map(r => r.k));
        const key = (k) => ({ key: k, isComposing: false, preventDefault() { } });
        vmRoot.adSugKey(key('ArrowDown')); vmRoot.adSugKey(key('ArrowDown')); vmRoot.adSugKey(key('ArrowDown'));
        ok(S.hi === 2 && vmRoot.adSugRows[S.hi].k === 'i:c:SG-3', '方向键选中第三行(SG-3)');
        const sgImg = D.doc.createElement('img');
        sgImg.setAttribute('src', vmRoot.adCvSrc(sItems[1]));
        D.doc.body.appendChild(sgImg);
        AD.cvDirective.mounted(sgImg, { value: sItems[1] });
        await failHost(() => [sgImg]);
        ok(!AD.covers.visible(sItems[1]) && eq(vmRoot.adSugRows.map(r => r.k), ['i:c:SG-1', 'i:c:SG-2', 'i:c:SG-3', 'all']) && vmRoot.adSugRows[S.hi].k === 'i:c:SG-3',
            '下拉开着:SG-2 的封面判了藏,但行不删(指针 / 高亮下的行不跳)', [vmRoot.adSugRows.map(r => r.k), S.hi]);
        S.items = sItems.slice();   // 打字:来了新的一批建议(重算)
        await ticks();
        ok(eq(vmRoot.adSugRows.map(r => r.k), ['i:c:SG-1', 'i:c:SG-3', 'all']) && vmRoot.adSugRows[S.hi].k === 'i:c:SG-3', '下次重算才拿掉 SG-2;高亮还在 SG-3 上(没落到下一行)', [vmRoot.adSugRows.map(r => r.k), S.hi]);
        ok(typeof AD.mixin.methods.adCvOk === 'undefined' && typeof AD.mixin.methods.adSearchImgErr === 'undefined', '没人调的 adCvOk / adSearchImgErr 删掉了');
        S.open = false;
        win._layout = null; win.scrollY = 0;
        app.unmount();
    }
    // ---- 新片速递:前端拿掉封面加载不出来的之后不足 12 部 → 整行不出 ----
    {
        AD.covers._reset(fakeEnv());
        rules['fr.bad.test'] = 'down';
        const fresh = [], fresh2 = [];
        for (let i = 0; i < 12; i++) fresh.push(srv('c:FR-' + i, 'https://' + (i === 0 ? 'fr.dead.test' : 'fr.ok.test') + '/' + i + '.jpg'));
        for (let i = 0; i < 12; i++) fresh2.push(srv('c:FS-' + i, 'https://' + (i === 0 ? 'fr.bad.test' : 'fr.ok.test') + '/s' + i + '.jpg'));
        AD.covers.setServerDead(['fr.dead.test']);
        const r = AD.mixin.methods._adCvRows.call({}, AD.homeToRows({ rows: [{ id: 'fresh', title: '新片速递', items: fresh }, { id: 'new', title: '新上架', items: fresh.slice(0, 3) }] }));
        ok(eq(r.order, ['ad_new']) && r.lists.ad_new.length === 2, '新片速递:12 部里 1 部在死图床上 → 剩 11 部 < 12,整行不出(别的行照常)', r.order);
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        win.fetch = async (u) => (String(u) === '/api/catalog/home' ? new Response(JSON.stringify({ rows: [{ id: 'fresh', title: '新片速递', items: fresh2 }] }), { status: 200 }) : new Response('[]', { status: 200 }));
        const app = Vue.createApp({
            mixins: [AD.mixin],
            data: () => ({ rowConfigs: {}, rowLists: {}, viewPages: {}, watchHistory: [], favList: [], showDetail: false }),
            methods: { getPosterUrl: (p) => p, autoSearch() { } },
            template: '<div><div v-for="key in Object.keys(rowConfigs)" :key="key" :data-row-key="key"><img v-for="item in rowLists[key]" :key="item.id" v-dg-cv="item" :src="adCvSrc(item)"></div></div>',
        });
        const v = app.mount(host);
        v.adult.catalog = true;
        await v.adultLoadHome();
        await ticks();
        ok(eq(Object.keys(v.rowConfigs), ['ad_fresh']) && v.rowLists.ad_fresh.length === 12, '12 部都能出:新片速递照常');
        otherImg();
        await failHost(() => host.querySelectorAll('img').filter(im => /fr\.bad\.test/.test(im.getAttribute('src'))));
        ok(!v.rowConfigs.ad_fresh, '其中一部封面加载不出来 → 剩 11 部,整行不出');
        // 图床活过来了(fr.bad.test 上别的目录封面加载出来了)→ 因它藏掉的那部放回来,够 12 部了 → 整行回来
        const rvIt = Object.freeze(AD.cardToItem(srv('c:FS-X', 'https://fr.bad.test/x.jpg'))), rv = D.doc.createElement('img');
        rv.setAttribute('src', rvIt.poster_path);
        D.doc.body.appendChild(rv);
        AD.cvDirective.mounted(rv, { value: rvIt });
        loadImg(rv);
        await advance(200);
        ok(eq(Object.keys(v.rowConfigs), ['ad_fresh']) && v.rowLists.ad_fresh.length === 12 && host.querySelectorAll('img').length === 12,
            '图床活过来了 → 藏掉的那部放回来,新片速递又够 12 部:整行回来(从首页原始的行重新筛)', [Object.keys(v.rowConfigs), (v.rowLists.ad_fresh || []).length]);
        AD.cvDirective.beforeUnmount(rv);
        D.doc.body.removeChild(rv);
        app.unmount();
    }
    // ---- 相关推荐:坏卡拿掉,一排全没了整排不出;横排左边(视口外)的卡没了 → 补 scrollLeft ----
    {
        AD.covers._reset(fakeEnv());
        rules['rel.x.test'] = 'down'; rules['rel.c.test'] = 'down';
        const relItems = [];
        for (let i = 1; i <= 6; i++) relItems.push(srv('c:RL-' + i, 'https://rel.' + (i === 1 ? 'x' : 'a') + '.test/' + i + '.jpg'));
        net.related = { items: relItems, actress: { aid: 7, name: '合成女优', items: [srv('c:RL-9', 'https://rel.c.test/9.jpg')] }, studio: null };
        win.fetch = async (u) => (String(u).startsWith('/api/catalog/related/') ? new Response(JSON.stringify(net.related), { status: 200 }) : new Response('{}', { status: 404 }));
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        const app = Vue.createApp({ components: { DgAdRails: AD.components.DgAdRails }, data: () => ({ wk: 'c:SELF' }), template: '<dg-ad-rails ref="r" :wk="wk" :tv="true"></dg-ad-rails>' });
        const root = app.mount(host);
        await ticks(12);
        const rimg = (wk) => host.querySelectorAll('.dg-rail-card').find(c => c.getAttribute('data-wk') === wk).querySelector('img');
        ok(host.querySelectorAll('.dg-rail').length === 2 && host.querySelectorAll('.dg-rail-card').length === 7, '相关推荐两排 7 张');
        win._layout = (el) => {
            const cls = el.getAttribute && (el.getAttribute('class') || '');
            if (/\bdg-rail-row\b/.test(cls)) return { top: 0, bottom: 300, height: 300, width: 1000, left: 0, right: 1000 };
            if (/\bdg-rail-card\b/.test(cls)) { const row = el.parentNode, all = row.querySelectorAll('.dg-rail-card'), i = all.indexOf(el); const left = i * 300 - (row.scrollLeft || 0); return { top: 0, bottom: 280, height: 280, width: 280, left, right: left + 280 }; }
            return null;
        };
        const row = host.querySelector('.dg-rail-row');
        row.scrollLeft = 600;
        coverIO().cb(host.querySelectorAll('.dg-rail-card img').map(im => ({ target: im, isIntersecting: true })));
        loadImg(rimg('c:RL-2'));
        rimg('c:RL-9').parentNode.parentNode.focus();
        await failHost(() => [rimg('c:RL-1'), rimg('c:RL-9')]);
        const rc3 = host.querySelectorAll('.dg-rail-card').find(c => c.getAttribute('data-wk') === 'c:RL-3');
        ok(host.querySelectorAll('.dg-rail').length === 1 && host.querySelectorAll('.dg-rail-card').length === 5 && !host.querySelectorAll('.dg-rail-card').some(c => c.getAttribute('data-wk') === 'c:RL-1'), '相关推荐:坏卡拿掉;同演员那排一张不剩 → 整排不出');
        ok(row.scrollLeft === 300 && rc3 && rc3.getBoundingClientRect().left === 0, '横排左边(视口外)那张没了 → scrollLeft 补回去,露出来的第一张还是 RL-3、位置不动', { sl: row.scrollLeft, left: rc3 && rc3.getBoundingClientRect().left });
        void root;
        win._layout = null;
        app.unmount();
    }
    // ---- 浏览页整页被藏时不一页接一页地狂拉(「稀」按留下来能出的算,含上一页后来被藏掉的)----
    {
        AD.covers._reset(fakeEnv());
        const pages = [];
        const mk = (p, hostName, n) => { const a = []; for (let i = 0; i < n; i++) a.push(srv('c:BP-' + p + '-' + i, hostName ? 'https://' + hostName + '/' + p + '-' + i + '.jpg' : '')); return a; };
        pages[1] = mk(1, 'pg1.test', 20); pages[2] = mk(2, 'pg2.test', 20); pages[3] = mk(3, '', 20); pages[4] = mk(4, 'pg4.test', 20);
        let pg = 0;
        win.fetch = async (u) => {
            const s = String(u);
            const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
            if (s.startsWith('/api/catalog/browse')) { pg++; return J({ results: pages[pg] || [], total_results: 80, cursor_next: pg < 4 ? 'cur' + pg : null }); }
            return J({});
        };
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        const app = Vue.createApp({
            mixins: [AD.mixin],
            data: () => ({ rowConfigs: {}, rowLists: {}, viewPages: {}, watchHistory: [], favList: [], browse: { open: true, seq: 0, items: [], page: 0, totalPages: 0, total: 0, done: false, error: false, idle: 0, loading: false, sel: {}, type: 'all' } }),
            methods: { getPosterUrl: (p) => p, autoSearch() { }, _browseAbort() { }, _browseFill() { } },
            template: '<div></div>',
        });
        const v = app.mount(host);
        v.adult.catalog = true;
        await v._adBrowseFetch(true);
        ok(v.browse.items.length === 20 && v.browse.idle === 0 && v.adBrowseN === 20, '第 1 页 20 张都能出:不稀;底栏的数(网格还没报)= 片单长度');
        AD.covers.setServerDead(['pg1.test']);
        await v._adBrowseFetch(false);
        ok(v.browse.items.length === 40 && v.browse.idle === 1, '上一页到现在一张都出不来了 → 这一页也算稀(idle +1)', v.browse.idle);
        await v._adBrowseFetch(false);
        ok(v.browse.idle === 2, '这一页全没封面(渲染之前就藏)→ 稀', v.browse.idle);
        await v._adBrowseFetch(false);
        ok(v.browse.idle === 3, '上一页全没封面 → 这一页照样算稀', v.browse.idle);
        v.adBrowseVis(0, 80);
        ok(v.adBrowseN === 0 && eq(v.adult.bvis, { n: 0, h: 80 }), '网格报「出了 0 张、藏了 80 张」→ 底栏按 0 算(出空状态 + 网格底下的「已隐藏 80 部 · 显示」)');
        app.unmount();
    }
    // ---- 断网 / 网络问题 / 无痕 ----
    {
        AD.covers._reset(fakeEnv());
        lsMem.delete('dg_cover_hosts');
        rules['off.b.test'] = 'down';
        const items = [srv('c:OF-1', 'https://off.a.test/1.jpg'), srv('c:OF-2', 'https://off.b.test/2.jpg'), srv('c:OF-3', 'https://off.b.test/3.jpg'), srv('c:OF-4', 'https://off.c.test/4.jpg')].map(AD.cardToItem).map(Object.freeze);
        const host = D.doc.body.appendChild(D.doc.createElement('div'));
        const app = Vue.createApp({ components: { DgAdGrid: AD.components.DgAdGrid }, data: () => ({ items }), template: '<dg-ad-grid ref="g" :cover="true" :items="items"></dg-ad-grid>' });
        const root = app.mount(host);
        await ticks();
        const gi = (wk) => host.querySelectorAll('.browse-card').find(c => c.getAttribute('data-bid') === wk).querySelector('img');
        win._layout = simpleLayout(host, root.$refs.g.cols);
        loadImg(gi('c:OF-1'));
        win.navigator.onLine = false;
        D.fire(win, 'offline');
        const np = probes.length;
        errImg(gi('c:OF-2'));
        await advance(10 * 60000);
        ok(root.$refs.g.shown.length === 4 && root.$refs.g.hiddenN === 0 && probes.length === np, '断网:失败的封面不探、不藏(十分钟后也不藏)');
        win.navigator.onLine = true;
        gi('c:OF-2').setAttribute('src', 'stale');
        D.fire(win, 'online');
        ok(gi('c:OF-2').getAttribute('src') === 'https://off.b.test/2.jpg', 'online 事件 → 从头重试');
        rules['*'] = 'down'; rules['off.b.test'] = 'down';   // 网其实还没通:对照(off.a.test)也连不上
        errImg(gi('c:OF-2'));
        await advance(2000);
        ok(root.$refs.g.hiddenN === 0, '刚 online 重试又失败、对照也连不上(网络问题):不藏');
        rules['*'] = 'up';
        D.doc.hidden = true; D.fire(D.doc, 'visibilitychange');
        errImg(gi('c:OF-3'));
        gi('c:OF-3').setAttribute('src', 'stale');
        D.doc.hidden = false; D.fire(D.doc, 'visibilitychange');
        ok(gi('c:OF-3').getAttribute('src') === 'https://off.b.test/3.jpg', '页面在后台时失败的 → 切回前台(visibilitychange)从头再试');
        // 无痕:图床记死只在内存里(两次 down、隔 ≥60 秒、对照通)
        win.dgPrivacy = { incognito: () => true, registerKeys() { } };
        await advance(10);
        otherImg('p5.test');                          // 网好了,别处有图加载出来 → 等着的 OF-2 (隔 ≥15 秒)从头再试
        await advance(AD.COVER.KICK_MS + 100);
        ok(gi('c:OF-2').getAttribute('src') === 'https://off.b.test/2.jpg' && AD.covers.state('c:OF-2').ph === '', '网络问题时等着的卡:之后有图加载出来 → 从头再试');
        await failHost(() => [gi('c:OF-2')]);
        await advance(AD.COVER.STRIKE_SPAN + 1000);
        await failHost(() => [gi('c:OF-3')]);
        ok(AD.covers.isDeadHost('off.b.test') && !lsMem.has('dg_cover_hosts') && root.$refs.g.hiddenN === 2, '无痕:两张都藏、图床记死,但 localStorage 一个字都不写', [AD.covers.isDeadHost('off.b.test'), root.$refs.g.hiddenN]);
        delete win.dgPrivacy;
        win._layout = null;
        app.unmount();
    }
}
console.log('③ 端到端(假 DOM + 真 Vue)');
try { await e2e(); } catch (e) { fail++; console.log('  ✗ 端到端抛错: ' + (e && e.stack || e)); }

console.log(`\n${fail ? '✗' : '✓'} adult-cover-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
