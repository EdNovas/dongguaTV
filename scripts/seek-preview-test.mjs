#!/usr/bin/env node
// 进度条缩略图预览回归(离线、零网络、无浏览器):
//   node scripts/seek-preview-test.mjs
//  ① 纯逻辑:按时间找分片、取哪一帧、LRU(条数 + 字节)、拖动时顶上的最近一张、缓冲判定、带宽让路闸门、不启用条件、框位置、时间格式(对照 DPlayer)
//  ② 预览 loader:清单只拉一次(startLoad 重载走内存)、分片/密钥照常走网络、abort/destroy 后迟到回调丢掉、直播清单不缓存;
//     【真】index.html OfflineLoader 还在查 IndexedDB 时 abort → 查完不发请求、不回调;父类不认标志时 loadInternal 也挡住
//  ③ 控制器(假时钟 + 假 DOM + 假 hls.js,行为按 1.1.5):停手 150ms 才取、同时最多 1 个分片、主视频 waiting/seeking 立刻中止、
//     起播/卡顿/缓冲不足不取、暂停时只在这次播放真播起来过(本令牌的 playing)且 readyState≥3 才取、换令牌/reset/销毁即拆、
//     任何时刻最多一个实例、失败静默且计满停用、剪过插播的时间轴换算、触屏拖动、预算、页面后台、清缓冲与下一张不打架、
//     分离音轨只取目标段、离线库查询中被中止不再发请求、不碰主播放器的 plugins
//  ④ 接线(index.html 静态):hls.js 分支 bind 在 loadSource/attachMedia 之前、原生分支 unbind、play() 两处令牌递增后 reset、closeDetail / goHome reset、
//     收起播放页(showDetail = false)的每一处都审过、模块不碰 dp.plugins.hls/_dpSwitchHls/_proxyRetrying;hls.min.js 1.1.5 的前提(换版本先报)
//  ⑤ sw.js:hls.js 的 XHR 分片(含 .png/.jpg 伪装)不进缓存;<img> 台标照常;预缓存同一个 ?v=
//  ⑥ 浏览器引导:有 document 时自动建 window.dgSeekPreview,入口给什么垃圾参数都不抛
// 改 seek-preview.js、播放器 hls 接线、sw.js 后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/libs/js/seek-preview.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const HLS = fs.readFileSync(path.join(ROOT, 'public/libs/js/hls.min.js'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8').split('\r\n').join('\n');
const DPLAYER = fs.readFileSync(path.join(ROOT, 'public/libs/js/DPlayer.min.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra).slice(0, 400))); } };

function loadCore(extra) {
    const ctx = Object.assign({ console }, extra || {});
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx, { filename: 'seek-preview.js' });
    return ctx;
}
const Core = loadCore().DgSeekPreviewCore;
const { C } = Core;

class R {   // TimeRanges
    constructor(a) { this.a = a || []; }
    get length() { return this.a.length; }
    start(i) { return this.a[i][0]; }
    end(i) { return this.a[i][1]; }
}
const mkFrags = (n, d, sn0) => Array.from({ length: n }, (_, i) => ({ sn: (sn0 || 0) + i, start: i * d, duration: d }));
const tickIO = () => new Promise(r => setImmediate(r));   // 跑完所有微任务(离线库查询的 .then 链)

// index.html 里真正的离线 loader(OfflineLoader)原文:预览 loader 继承它,中止在它查 IndexedDB 期间也要生效
const OFFLINE_SRC = (() => {
    const a = HTML.indexOf('class OfflineLoader extends Base {');
    const b = a > 0 ? HTML.indexOf('window._OfflineHlsLoader = OfflineLoader;', a) : -1;
    return b > a ? HTML.slice(a, b) : '';
})();
// 查库结果由测试手动放出(模拟 IndexedDB 慢)
function mkDb() {
    const pend = [];
    return { pend, get: (store, key) => new Promise(res => pend.push({ key, res })), settle(rec) { pend.splice(0).forEach(p => p.res(rec)); } };
}
function mkOffline(Base, db) {
    return vm.runInNewContext('(function () {\n' + OFFLINE_SRC + '\nreturn OfflineLoader;\n})()',
        { Base, offlineDB: db, offlineKey: u => String(u), _navSeq: 1, performance: { now: () => 7 }, window: {}, console, Promise });
}

// ======================= ① 纯逻辑 =======================
console.log('① 纯逻辑');
{
    const { fragIndexAt } = Core;
    const fr = mkFrags(10, 6);
    ok(fragIndexAt([], 3) === -1 && fragIndexAt(null, 3) === -1 && fragIndexAt(fr, NaN) === -1 && fragIndexAt(fr, '3') === -1, 'fragIndexAt:空表 / NaN / 非数字 → -1');
    ok(fragIndexAt(fr, -5) === 0 && fragIndexAt(fr, 0) === 0 && fragIndexAt(fr, 5.999) === 0 && fragIndexAt(fr, 6) === 1 && fragIndexAt(fr, 59.9) === 9 && fragIndexAt(fr, 1e9) === 9 && fragIndexAt(fr, Infinity) === 9, 'fragIndexAt:边界(片头归本片、首片前归 0、末片后归末片)');
    // 不等长分片:二分 = 线性
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const fv = []; let t = 0.4;
    for (let i = 0; i < 500; i++) { const d = 0.5 + rnd() * 10; fv.push({ sn: i, start: t, duration: d }); t += d; }
    let same = true;
    for (let k = 0; k < 3000; k++) {
        const q = rnd() * (t + 20) - 10;
        let lin = 0; for (let i = 0; i < fv.length; i++) if (fv[i].start <= q) lin = i;
        if (fragIndexAt(fv, q) !== lin) { same = false; break; }
    }
    ok(same, 'fragIndexAt:500 个不等长分片 × 3000 次随机查询,二分与线性查找一致');

    const { thumbTime } = Core;
    const tt = (s, d) => +(thumbTime({ start: s, duration: d }, 1) - s).toFixed(6);
    ok(tt(100, 6) === 1 && tt(0, 4) === 1 && tt(0, 2) === 0.6 && tt(0, 1) === 0.1 && tt(0, 0.1) === 0.05 && tt(50, 0) === 0, 'thumbTime:6s/4s 片取片内 1s、2s 片 0.6s、1s 片 0.1s、极短片取中点、无时长取片头', [tt(100, 6), tt(0, 4), tt(0, 2), tt(0, 1), tt(0, 0.1), tt(50, 0)]);
    let inside = true, room = true;
    for (let d = 0.05; d < 15; d += 0.05) {
        const p = thumbTime({ start: 10, duration: d }, C.MAX_BUF);
        if (!(p >= 10 && p < 10 + d)) inside = false;
        if (d >= C.MAX_BUF + 0.2 && 10 + d - p < C.MAX_BUF) room = false;   // 片内剩余 ≥ 前向缓冲 → hls.js 不会顺手取下一片
    }
    ok(inside && room, 'thumbTime:总在片内;片长 ≥ maxBuf+0.2s 时 seek 点后至少留 maxBuf 秒');
    ok(C.MAX_BUF <= 2 && C.MAX_MAX_BUF <= 4 && C.MAX_BUF <= C.MAX_MAX_BUF, '预览实例前向缓冲很小(≤2s / ≤4s)');

    const { Lru } = Core;
    const l = new Lru(3, 100);
    l.set(1, 'a', 10); l.set(2, 'b', 10); l.set(3, 'c', 10); l.get(1); l.set(4, 'd', 10);
    ok(l.size === 3 && l.has(1) && !l.has(2) && l.has(3) && l.has(4), 'LRU:超条数淘汰最久没用的(get 算一次使用)', l.keys());
    l.set(5, 'e', 80);
    ok(l.bytes <= 100 && l.has(5) && l.keys().join() === '1,4,5', 'LRU:超字节淘汰(从最久没用的开始)', { keys: l.keys(), bytes: l.bytes });
    l.set(5, 'e2', 5);
    ok(l.peek(5) === 'e2' && l.bytes === 25, 'LRU:同键覆盖时字节数跟着改', l.bytes);
    l.set(9, 'huge', 1000);
    ok(l.size === 1 && l.has(9), 'LRU:单张超过上限也留着这一张(不会清空成 0)');
    const before = l.keys().join(); l.peek(9); ok(l.keys().join() === before, 'LRU:peek 不改顺序');
    l.clear(); ok(l.size === 0 && l.bytes === 0, 'LRU:clear');

    const { nearestKey, nearSec } = Core;
    const f6 = mkFrags(400, 6);
    ok(nearestKey([10, 50], f6, 61, 30) === 10 && nearestKey([10, 50], f6, 63, 30) === 10, 'nearestKey:在片内距离为 0');
    ok(nearestKey([10, 50], f6, 80, 30) === 10 && nearestKey([10, 50], f6, 290, 30) === 50 && nearestKey([10, 50], f6, 200, 30) === -1, 'nearestKey:取最近的;都超过 maxSec 返回 -1');
    ok(nearestKey([], f6, 10, 30) === -1 && nearestKey([999], f6, 10, 1e9) === -1, 'nearestKey:空缓存 / 键越界');
    ok(nearSec(600) === 30 && nearSec(7200) === 108 && nearSec(NaN) === 30 && nearSec(Infinity) === 30, 'nearSec:短片 30s,长片按时长 1.5%');

    const { bufferedAhead, isBuffered, pointIn } = Core;
    const br = new R([[0, 10], [20, 50]]);
    ok(bufferedAhead(br, 25) === 25 && bufferedAhead(br, 15) === 0 && bufferedAhead(br, 19.8) === 30.2 && bufferedAhead(br, 60) === 0 && bufferedAhead(null, 1) === 0 && bufferedAhead(br, NaN) === 0, 'bufferedAhead:段内算到段尾、空隙为 0、段前 0.3s 内算进段');
    ok(isBuffered(br, 5) && !isBuffered(br, 15) && !isBuffered(br, 9.99) && isBuffered(br, 20) && !isBuffered(new R([]), 1), 'isBuffered');
    ok(Math.abs(pointIn(new R([[12.3, 20]]), 12, 18) - 12.6) < 1e-9 && pointIn(new R([[30, 40]]), 12, 18) === null && pointIn(new R([[12, 12.03]]), 12, 18) === null, 'pointIn:片内有缓冲的点(时间戳晚一点的情况)');

    const { fragOverlaps } = Core;
    const fo = (a, d) => fragOverlaps({ start: a, duration: d }, 1200, 1206);
    ok(fo(1200, 4) && fo(1204, 4) && fo(1196, 6) && fo(1201, 1) && fo(1203, 0.06), 'fragOverlaps:和目标段 [1200,1206) 有真重叠的音频片放行(含被目标段整个盖住的短片)');
    ok(!fo(1206, 4) && !fo(1196, 4) && !fo(1208, 4) && !fo(1205.97, 4) && !fo(1192.03, 7.98) &&!fo(1100, 4), 'fragOverlaps:只碰到边 / 浮点误差级的重叠 / 目标段以外 → 不放行');
    ok(!fragOverlaps({ start: NaN, duration: 4 }, 1200, 1206) && !fragOverlaps({ start: 1200, duration: 0 }, 1200, 1206) && !fragOverlaps({ start: 1200, duration: 4 }, 0, 0) && !fragOverlaps(null, 1200, 1206), 'fragOverlaps:时间不明 / 目标段没定 → 不放行');

    const { gate, keepJob } = Core;
    const base = { hidden: false, paused: false, ended: false, seeking: false, readyState: 4, ahead: 30, remain: 1000, sinceStall: Infinity, sincePlaying: 60000, played: true };
    const g = o => gate(Object.assign({}, base, o));
    ok(g({}).ok && g({}).why === 'ahead', '闸门:播放中、前方 30s → 可以取');
    ok(!g({ ahead: 19.9 }).ok && g({ ahead: 19.9 }).why === 'buffer', '闸门:前方不足 20s 不取');
    ok(g({ ahead: 8, remain: 8.5 }).ok && !g({ ahead: 5, remain: 8.5 }).ok, '闸门:片尾不足 20s 时缓冲到片尾也算');
    ok(!g({ seeking: true }).ok && g({ seeking: true }).why === 'seeking', '闸门:主视频正在 seek 不取');
    ok(!g({ readyState: 1 }).ok && g({ readyState: 1 }).why === 'startup', '闸门:主视频还没首帧不取');
    ok(!g({ readyState: 2 }).ok && g({ readyState: 2 }).why === 'stall', '闸门:播放中 readyState<3(卡着)不取');
    ok(!g({ sincePlaying: 3999 }).ok && !g({ sincePlaying: -1 }).ok && g({ sincePlaying: -1 }).why === 'startup', '闸门:开播 4s 内 / 还没播过不取');
    ok(!g({ sinceStall: 1999 }).ok && g({ sinceStall: 1999 }).why === 'settle' && g({ sinceStall: 2001 }).ok, '闸门:waiting/seeking 之后 2s 内不取');
    ok(g({ paused: true, ahead: 0, readyState: 3 }).ok && g({ paused: true, ahead: 0, readyState: 4 }).why === 'paused' && g({ ended: true, ahead: 0, readyState: 2 }).ok, '闸门:这次播放真播起来过 → 暂停(readyState≥3)/ 结束时可以取');
    ok(!g({ paused: true, played: false, readyState: 4 }).ok && g({ paused: true, played: false, readyState: 4 }).why === 'unplayed' && !g({ ended: true, played: false }).ok && !g({ paused: true, played: undefined }).ok, '闸门:暂停但这次播放还没真播起来过(自动播放被拦、停在起播点拉首屏)→ 不取');
    ok(!g({ paused: true, readyState: 2 }).ok && g({ paused: true, readyState: 2 }).why === 'stall', '闸门:暂停但 readyState<3(主播放器还在等当前这一段)→ 不取');
    ok(!g({ paused: true, seeking: true }).ok && !g({ paused: true, readyState: 1 }).ok && !g({ paused: true, sinceStall: 500 }).ok, '闸门:暂停时 seek 中 / 没首帧 / 刚卡过照样不取');
    ok(g({ played: false }).ok, '闸门:播放分支不看 played(起播 4s + readyState≥3 + 前方 20s 已经够严)');
    ok(!g({ hidden: true }).ok && g({ hidden: true }).why === 'hidden' && !gate(null).ok, '闸门:页面在后台 / 没有主视频不取');
    const k = o => keepJob(Object.assign({}, base, o));
    ok(k({}) && k({ ahead: 8 }) && !k({ ahead: 7.9 }) && k({ ahead: 2, remain: 2.5 }) && !k({ seeking: true }) && !k({ hidden: true }) && !k({ readyState: 2 }) && k({ paused: true, ahead: 0 }) && !keepJob(null), 'keepJob:取的过程中前方掉到 8s 以下 / seek / 卡 / 后台就中止,暂停照常');
    ok(!k({ paused: true, readyState: 2 }) && k({ ended: true, readyState: 2 }), 'keepJob:暂停着 readyState 掉到 3 以下也中止(播完的不算)');

    const { disabledReason } = Core;
    const env = { off: false, saveData: false, effectiveType: '4g', tv: false, hls: true, preferNative: false, mse: true, live: false, casting: false, pointer: true, locked: false, trialEnded: false };
    const dr = o => disabledReason(Object.assign({}, env, o));
    ok(dr({}) === '', '不启用条件:正常环境启用');
    const table = [[{ off: true }, 'off'], [{ saveData: true }, 'saveData'], [{ effectiveType: 'slow-2g' }, 'slowNet'], [{ effectiveType: '2g' }, 'slowNet'], [{ effectiveType: '3g' }, 'slowNet'],
        [{ tv: true }, 'tv'], [{ hls: false }, 'noMse'], [{ preferNative: true }, 'native'], [{ mse: false }, 'notMse'], [{ live: true }, 'live'], [{ casting: true }, 'cast'], [{ pointer: false }, 'noPointer'],
        [{ locked: true }, 'locked'], [{ trialEnded: true }, 'trial']];
    ok(table.every(([o, w]) => dr(o) === w), '不启用条件:省流量 / 2G·3G / TV / 无 MSE / 原生 HLS / 主视频不在 MSE 上 / 直播 / 投屏 / 无指针事件 / 预览锁定 / 试看结束 / 手动关', table.map(([o, w]) => [w, dr(o)]));
    ok(dr({ effectiveType: '4g' }) === '' && dr({ effectiveType: 'constructor' }) === '' && dr({ effectiveType: '__proto__' }) === '' && dr({ effectiveType: undefined }) === '' && disabledReason(null) === 'env', '不启用条件:原型键不误判成慢网');

    const { boxLeft } = Core;
    ok(boxLeft(500, 168, 1000) === 416 && boxLeft(10, 168, 1000) === 6 && boxLeft(995, 168, 1000) === 1000 - 168 - 6 && boxLeft(50, 168, 150) === 0 && boxLeft(50, 100, 108) === 4, 'boxLeft:以指针为中心、夹在容器里、容器太窄居中');

    const { fmtTime } = Core;
    const m = /secondToTime:(function\(e\)\{[\s\S]*?\.join\(":"\)\})/.exec(DPLAYER);
    ok(!!m, 'DPlayer 还有 secondToTime');
    if (m) {
        const dpFmt = vm.runInNewContext('(' + m[1] + ')');
        const vals = [0, 0.4, 1, 59.9, 60, 61.5, 599, 3599.9, 3600, 3661, 7322.7, 36000, 86399];
        ok(vals.every(v => fmtTime(v) === dpFmt(v)), '时间格式与 DPlayer secondToTime 一致', vals.map(v => [fmtTime(v), dpFmt(v)]));
    }
    ok(fmtTime(NaN) === '00:00' && fmtTime(-3) === '00:00' && fmtTime(Infinity) === '00:00', '时间格式:NaN / 负数 / 无穷 → 00:00');

    const { thumbSize } = Core;
    const s169 = thumbSize(1920, 1080), s43 = thumbSize(1080, 810), s916 = thumbSize(1080, 1920), s0 = thumbSize(0, 0);
    ok(s169.w === 160 && s169.h === 90 && s43.w === 160 && s43.h === 120 && s916.h === 120 && s916.w === 68 && s0.w === 160 && s0.h === 90, '缩略图尺寸:宽 160 按比例;竖屏高度封顶 120;没宽高按 16:9', [s169, s43, s916, s0]);

    const { fitSize } = Core;
    const f1 = fitSize({ w: 160, h: 90 }, 300), f2 = fitSize({ w: 68, h: 120 }, 95.6), f3 = fitSize({ w: 160, h: 90 }, 35.9), f4 = fitSize({ w: 160, h: 90 }, NaN), f5 = fitSize(null, 300);
    ok(f1.w === 160 && f1.h === 90 && f2.h === 95 && f2.w === 54 && f3 === null && f4 === null && f5 === null, 'fitSize:放得下原样;放不下等比缩到上沿以内;不到 36px 不出框', [f1, f2, f3, f4]);

    const cfg = Core.hlsConfig(function L() { });
    ok(cfg.autoStartLoad === false && cfg.startLevel === 0 && cfg.maxBufferLength === C.MAX_BUF && cfg.maxMaxBufferLength === C.MAX_MAX_BUF && cfg.maxBufferSize === 0
        && cfg.capLevelToPlayerSize === false && cfg.startFragPrefetch === false && cfg.fragLoadingMaxRetry <= 1 && typeof cfg.loader === 'function' && cfg.pLoader === cfg.loader, 'hls 配置:不自动加载、最低一档、前向 1~2s(maxBufferSize 0 让 maxBufferLength 说了算)、少重试、自带 loader');
}

// ======================= ② 预览 loader =======================
console.log('② 预览 loader');
{
    const net = [];
    class Base {
        constructor() { this.stats = { loading: {}, loaded: 0, total: 0 }; this.aborted = false; }
        load(ctx, cfg, cb) { net.push(ctx); this._cb = cb; this._ctx = ctx; }
        reply(data) { this._cb.onSuccess({ url: this._ctx.url, data }, this.stats, this._ctx, null); }
        abort() { this.aborted = true; }
        destroy() { }
    }
    const mem = new Map(), later = [];
    const L = Core.makeLoader(Base, mem, () => 42, f => later.push(f));
    const VOD = '#EXTM3U\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n', LIVE = '#EXTM3U\n#EXTINF:6,\na.ts\n';
    let got = [];
    const cb = { onSuccess: (r, st, ctx) => got.push([r.data, st.loaded, ctx.url]), onError: () => { }, onTimeout: () => { } };
    const a = new L({}); a.load({ type: 'manifest', url: 'u1' }, {}, cb); a.reply(VOD);
    ok(net.length === 1 && got.length === 1 && mem.get('u1') === VOD, 'loader:第一次清单走网络、结果留在内存');
    const b = new L({}); b.load({ type: 'level', url: 'u1' }, {}, cb);
    ok(net.length === 1 && got.length === 1 && later.length === 1, 'loader:同一清单再拉(startLoad 重载)不走网络,异步回调');
    later.shift()();
    ok(got.length === 2 && got[1][0] === VOD && got[1][1] === VOD.length && got[1][2] === 'u1' && b.stats.loading.end === 42, 'loader:内存命中照样填 stats 回 onSuccess');
    const c = new L({}); c.load({ type: 'level', url: 'u1' }, {}, cb); c.abort(); later.shift()();
    ok(got.length === 2 && c.aborted, 'loader:abort 之后内存命中的迟到回调丢掉');
    const d2 = new L({}); d2.load({ type: 'level', url: 'u1' }, {}, cb); d2.destroy(); later.shift()();
    ok(got.length === 2, 'loader:destroy 之后迟到回调丢掉');
    const e = new L({}); e.load({ type: 'level', url: 'live' }, {}, cb); e.reply(LIVE);
    ok(!mem.has('live'), 'loader:直播清单(没有 ENDLIST)不缓存');
    const f = new L({}); f.load({ type: 'manifest', url: 'master' }, {}, cb); f.reply('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nl.m3u8\n');
    ok(mem.has('master'), 'loader:主清单缓存');
    const n0 = net.length;
    const fr = new L({}); fr.load({ type: undefined, url: 'seg.ts', frag: { sn: 1 } }, {}, cb);
    const ky = new L({}); ky.load({ type: undefined, url: 'key.key', keyInfo: {} }, {}, cb);
    const fr2 = new L({}); fr2.load({ type: undefined, url: 'seg.ts', frag: { sn: 1 } }, {}, cb);
    ok(net.length === n0 + 3, 'loader:分片 / AES-128 密钥每次照常走(父类)loader,不进内存');
    ok(Core.makeLoader(null, mem, () => 0, f => f()) === null, 'loader:没有父类返回 null(用 hls.js 默认)');
    // 闸:不是这次要的那一片(和它的密钥)不发请求
    let want = 7;
    const G = Core.makeLoader(Base, new Map(), () => 0, f => f(), fr => fr.sn === want);
    const n1 = net.length;
    const g1 = new G({}); g1.load({ url: 's8.ts', frag: { sn: 8, type: 'main' } }, {}, cb);
    const g2 = new G({}); g2.load({ url: 'k.key', frag: { sn: 8, type: 'main' }, responseType: 'arraybuffer' }, {}, cb);
    ok(net.length === n1 && g1._spHeld && g2._spHeld, 'loader 闸:不是目标片的分片 / 密钥挂着不发');
    let threw = false; try { g1.abort(); g2.destroy(); } catch (e) { threw = true; }
    ok(!threw && g1._spDead, 'loader 闸:挂着的 abort / destroy 是空操作');
    const g3 = new G({}); g3.load({ url: 's7.ts', frag: { sn: 7, type: 'main' } }, {}, cb);
    const g4 = new G({}); g4.load({ url: 'init.mp4', frag: { sn: 'initSegment', type: 'main' } }, {}, cb);
    const g6 = new G({}); g6.load({ url: 'ainit.mp4', frag: { sn: 'initSegment', type: 'audio' } }, {}, cb);
    ok(net.length === n1 + 3, 'loader 闸:目标片、fMP4 初始化段(视频 / 分离音轨)照常发');
    const g5 = new G({}); g5.load({ url: 'a8.aac', frag: { sn: 8, type: 'audio' } }, {}, cb);
    const g7 = new G({}); g7.load({ url: 's8.vtt', frag: { sn: 8, type: 'subtitle' } }, {}, cb);
    ok(net.length === n1 + 3 && g5._spHeld && g7._spHeld, 'loader 闸:分离音轨 / 字幕的片也过闸(闸说不要就挂着,不再一律放行)');
    const g8 = new G({}); g8.load({ url: 'a7.aac', frag: { sn: 7, type: 'audio' } }, {}, cb);
    ok(net.length === n1 + 4, 'loader 闸:闸放行的音轨片照常发');
    const g9 = new G({}); g9.abort();
    g9.load({ url: 's7.ts', frag: { sn: 7, type: 'main' } }, {}, cb);
    ok(net.length === n1 + 4, 'loader:已 abort 的 loader 再 load 不发请求');
}

// 中止在任何阶段都生效:预览 loader 继承 index.html 的【真】OfflineLoader(先 await IndexedDB 才决定走不走网络)
{
    ok(!!OFFLINE_SRC && /\.then\(rec => \{\s*if \(this\._offDestroyed\) return;/.test(OFFLINE_SRC), 'index.html 的 OfflineLoader 还在、查完库先看 _offDestroyed 再决定回调 / 走网络');
    const xhr = [], xhrAborted = [];
    class Xhr {   // hls.js 1.1.5 XhrLoader 的骨架:load 记下参数后调 this.loadInternal(),那里才真 new XMLHttpRequest(失败重试也走它)
        constructor() { this.stats = { loading: {}, loaded: 0, total: 0, aborted: false }; this.callbacks = null; this.config = null; this.loader = null; }
        load(ctx, cfg, cb) { if (this.stats.loading.start) throw new Error('Loader can only be used once.'); this.stats.loading.start = 1; this.context = ctx; this.config = cfg; this.callbacks = cb; this.loadInternal(); }
        loadInternal() { if (!this.config) return; this.loader = { url: this.context.url }; xhr.push(this.context.url); }
        abort() { if (this.loader) { this.stats.aborted = true; xhrAborted.push(this.context.url); } if (this.callbacks && this.callbacks.onAbort) this.callbacks.onAbort(this.stats, this.context, this.loader); }
        destroy() { this.callbacks = null; this.loader = null; this.config = null; }
    }
    const db = mkDb();
    const Off = mkOffline(Xhr, db);
    const P = Core.makeLoader(Off, new Map(), () => 0, f => f(), fr => fr.sn === 7);
    const got = [];
    const cb = { onSuccess: r => got.push(r.url), onError: () => got.push('err'), onTimeout: () => got.push('timeout'), onAbort: () => got.push('abort') };
    const fctx = sn => ({ url: 'seg' + sn + '.ts', frag: { sn, type: 'main', start: 0, duration: 6 }, responseType: 'arraybuffer' });

    const p0 = new P({}); p0.load(fctx(7), {}, cb);
    ok(xhr.length === 0 && db.pend.length === 1, '离线 loader:先查库(此时还没发请求)');
    db.settle(null); await tickIO();
    ok(xhr.length === 1 && xhr[0] === 'seg7.ts', '对照:没中止、库里没有 → 走网络');

    const p1 = new P({}); p1.load(fctx(7), {}, cb);
    p1.abort();   // stopLoad / 主视频 waiting·seeking / 停手换位置:正赶上还在查库
    db.settle(null); await tickIO();
    ok(xhr.length === 1 && got.length === 0, '查库期间 abort → 查完库没有也不发请求、不回调', { xhr, got });

    const p2 = new P({}); p2.load(fctx(7), {}, cb);
    p2.abort();
    db.settle({ data: new ArrayBuffer(8), size: 8 }); await tickIO();
    ok(xhr.length === 1 && got.length === 0, '查库期间 abort → 查完库命中了也不回调(迟到结果丢掉)', { xhr, got });

    const p3 = new P({}); p3.load(fctx(7), {}, cb);
    p3.destroy();
    db.settle(null); await tickIO();
    ok(xhr.length === 1 && got.length === 0, '查库期间 destroy(实例销毁)→ 不发请求');

    const p4 = new P({}); p4.load(fctx(7), {}, cb);
    db.settle({ data: new ArrayBuffer(8), size: 8 }); await tickIO();
    ok(got.length === 1 && got[0] === 'seg7.ts' && xhr.length === 1, '对照:没中止的离线命中照常回调、不走网络');

    const p5 = new P({}); p5.load(fctx(7), {}, cb);
    db.settle(null); await tickIO();
    p5.abort();
    ok(xhr.length === 2 && xhrAborted.length === 1 && xhrAborted[0] === 'seg7.ts', '对照:已经发出去的请求 abort 照常掐掉 xhr');

    const n0 = db.pend.length;
    const p6 = new P({}); p6.load(fctx(8), {}, cb);
    ok(db.pend.length === n0 && p6._spHeld && xhr.length === 2, '闸说不要的片连离线库都不查(挂着)');

    // 父类将来不认 _offDestroyed:查完库照样调 XhrLoader.load → loadInternal 这一道挡住,不 new XMLHttpRequest
    class Off2 extends Xhr { load(ctx, cfg, cbs) { Promise.resolve().then(() => super.load(ctx, cfg, cbs)); } }
    const P2 = Core.makeLoader(Off2, new Map(), () => 0, f => f(), fr => fr.sn === 7);
    const q = new P2({}); q.load(fctx(7), {}, cb); q.abort(); await tickIO();
    ok(xhr.length === 2, 'loadInternal 兜底:父类不认中止标志也发不出请求', xhr);
    const q2 = new P2({}); q2.load(fctx(7), {}, cb); await tickIO();
    ok(xhr.length === 3, '对照:没中止的 loadInternal 照常放行');
}

// ======================= ③ 控制器 =======================
console.log('③ 控制器');
const E = { MANIFEST_PARSED: 'hlsManifestParsed', LEVEL_LOADED: 'hlsLevelLoaded', FRAG_LOADED: 'hlsFragLoaded', FRAG_BUFFERED: 'hlsFragBuffered', ERROR: 'hlsError', BUFFER_FLUSHING: 'hlsBufferFlushing', DESTROYING: 'hlsDestroying' };

function setup(opt) {
    opt = opt || {};
    const errors = [];
    // ---- 假时钟 ----
    let now = 1000, seq = 0;
    const q = new Map();
    const clock = {
        now: () => now,
        setTimeout: (f, ms) => { const id = ++seq; q.set(id, { at: now + Math.max(0, +ms || 0), f }); return id; },
        clearTimeout: id => { q.delete(id); },
        advance(ms) {
            const end = now + ms;
            for (let guard = 0; guard < 100000; guard++) {
                let best = null;
                for (const [id, x] of q) if (x.at <= end && (!best || x.at < best.x.at || (x.at === best.x.at && id < best.id))) best = { id, x };
                if (!best) break;
                q.delete(best.id);
                now = Math.max(now, best.x.at);
                try { best.x.f(); } catch (e) { errors.push(e); }
            }
            now = end;
        }
    };
    // ---- 假 DOM ----
    class T {
        constructor() { this._l = {}; }
        addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
        removeEventListener(t, f) { const a = this._l[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } }
        dispatch(t, ev) { (this._l[t] || []).slice().forEach(f => { try { f(Object.assign({ type: t }, ev || {})); } catch (e) { errors.push(e); } }); }
        count(t) { return (this._l[t] || []).length; }
    }
    class CL {
        constructor() { this.s = new Set(); }
        add(c) { this.s.add(c); } remove(c) { this.s.delete(c); } contains(c) { return this.s.has(c); }
        toggle(c, on) { if (on === undefined) on = !this.s.has(c); if (on) this.s.add(c); else this.s.delete(c); return on; }
    }
    let dataN = 0;
    const env = { mode: opt.mode || 'ok', supported: opt.supported !== false, frags: opt.frags || mkFrags(400, 6, 1000), fragMs: opt.fragMs || 50, fragBytes: opt.fragBytes || 1e6,
        flushMs: opt.flushMs == null ? 3 : opt.flushMs, levels: opt.levels || null, blank: !!opt.blank,
        // 分离音轨(EXT-X-MEDIA TYPE=AUDIO):音频片表、单片耗时、音轨控制器一口气往后要几片(1.1.5 新实例取片位置 = 刚取完那片的片尾,会连着要)
        audioFrags: opt.audioFrags || null, audioMs: opt.audioMs || 10, audioGreedy: opt.audioGreedy || 4,
        instances: [], alive: 0, maxAlive: 0, inflight: 0, maxInflight: 0, fragLoads: [], audioLoads: [], net: [], netAborted: 0, pluginTouches: [], draws: [], previewPlays: 0 };
    class El extends T {
        constructor(tag) { super(); this.tagName = tag; this.classList = new CL(); this.style = {}; this.children = []; this.parentNode = null; this.attrs = {}; this.textContent = ''; this.rect = { left: 0, top: 0, width: 0, height: 0, bottom: 0 }; this.id = ''; }
        set className(v) { String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
        setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = v; }
        removeAttribute(k) { delete this.attrs[k]; }
        getBoundingClientRect() { return Object.assign({ right: this.rect.left + this.rect.width }, this.rect); }
        get offsetWidth() { return this.rect.width; }
        querySelector(sel) {
            const cls = sel.replace(/^\./, '');
            const walk = n => { for (const c of n.children) { if (c.classList.contains(cls)) return c; const r = walk(c); if (r) return r; } return null; };
            return walk(this);
        }
        getContext() {
            return {
                drawImage: (v) => env.draws.push(+v.currentTime.toFixed(3)),
                getImageData: () => ({ data: env.blank ? [0, 0, 0, 0] : [12, 34, 56, 255] })
            };
        }
        toDataURL(type) { return 'data:' + (type || 'image/png') + ';base64,' + 'A'.repeat(3000) + (++dataN); }
    }
    class Video extends El {
        constructor() { super('video'); this.buffered = new R([]); this.readyState = 0; this.seeking = false; this.paused = true; this.ended = false; this._ct = 0; this.duration = NaN; this.videoWidth = 1920; this.videoHeight = 1080; this.seeks = []; }
        get currentTime() { return this._ct; }
        set currentTime(x) { this._ct = x; this.seeks.push(+x.toFixed(3)); if (this.readyState >= 1) { this.seeking = true; this._settle(); } }
        _covered() { return Core.isBuffered(this.buffered, this._ct); }
        _settle() {
            if (!this._covered()) return;
            if (!this.seeking) { if (this.readyState < 2) { this.readyState = 2; this.dispatch('loadeddata'); } return; }
            clock.setTimeout(() => { if (!this.seeking || !this._covered()) return; this.seeking = false; this.readyState = Math.max(this.readyState, 2); this.dispatch('seeked'); }, 3);
        }
        load() { }
        play() { env.previewPlays++; }
    }
    const doc = new T();
    doc.hidden = false;
    doc.head = new El('head'); doc.body = new El('body'); doc.documentElement = new El('html');
    doc.createElement = tag => tag === 'video' ? new Video() : new El(tag);
    doc.getElementById = id => doc.head.children.find(c => c.id === id) || null;
    // ---- 假 hls.js(只模拟预览控制器用到的 1.1.5 行为) ----
    // hls.js 默认 loader 的替身 = "网络":真发出去的请求记在 env.net,同时在路上的数 env.inflight
    class BaseLoader {
        constructor() { this.stats = { loading: {}, loaded: 0, total: 0 }; this._t = 0; }
        load(ctx, cfg, cb) {
            env.net.push(ctx.frag ? ctx.frag.sn : ctx.url);
            env.inflight++; env.maxInflight = Math.max(env.maxInflight, env.inflight);
            const ms = ctx.frag && ctx.frag.type === 'audio' ? env.audioMs : env.fragMs;
            this._t = env.mode === 'hang' ? -1 : clock.setTimeout(() => { this._t = 0; env.inflight--; cb.onSuccess({ url: ctx.url, data: new ArrayBuffer(8) }, this.stats, ctx, null); }, ms);
        }
        abort() { if (this._t) { if (this._t > 0) clock.clearTimeout(this._t); this._t = 0; env.inflight--; env.netAborted++; } }
        destroy() { this.abort(); }
    }
    class FakeHls {
        static isSupported() { return env.supported; }
        constructor(cfg) { this.cfg = cfg; this.h = {}; this.calls = []; this.media = null; this.levels = []; this.loading = false; this.gen = 0; this.dead = false; env.instances.push(this); env.alive++; env.maxAlive = Math.max(env.maxAlive, env.alive); }
        on(e, f) { (this.h[e] = this.h[e] || []).push(f); }
        emit(e, d) { if (this.dead) return; (this.h[e] || []).slice().forEach(f => { try { f(e, d); } catch (er) { errors.push(er); } }); }
        trigger(e, d) {
            this.calls.push(['trigger', e, d]);
            if (e === E.BUFFER_FLUSHING) { const v = this.media; clock.setTimeout(() => { this._vr = this._ar = null; if (v) v.buffered = new R([]); }, env.flushMs); }
        }
        set loadLevel(x) { this.calls.push(['loadLevel', x]); }
        loadSource(u) {
            this.calls.push(['loadSource', u]);
            clock.setTimeout(() => {
                if (this.dead) return;
                if (env.mode === 'fatalManifest') return this.emit(E.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
                this.levels = env.levels || [{ bitrate: 1 }];
                this.emit(E.MANIFEST_PARSED, { levels: this.levels });
            }, 5);
        }
        attachMedia(v) { this.calls.push(['attachMedia']); this.media = v; }
        startLoad(pos) {
            this.calls.push(['startLoad', +(+pos).toFixed(3), !!this.media]);
            this._cancelFrag();
            this.loading = true;
            const g = ++this.gen;
            clock.setTimeout(() => {   // 子清单(重)载入:LEVEL_LOADED 先给 stream-controller(没有 media 就不取分片),再给外面
                if (this.dead || g !== this.gen) return;
                const hadMedia = !!this.media;
                this.emit(E.LEVEL_LOADED, { details: { live: env.mode === 'live', fragments: env.frags } });
                if (!hadMedia || g !== this.gen || !this.loading || env.mode === 'live') return;
                this._loadFrag(Core.fragIndexAt(env.frags, pos));
                if (env.audioFrags) this._loadAudio(Core.fragIndexAt(env.audioFrags, pos), env.audioGreedy);   // 音轨控制器(没有 media 也不取)
            }, 5);
        }
        // 音轨控制器:从 pos 所在的音频片起,一片取完立刻要下一片(最多 left 片);经同一个 config.loader
        _loadAudio(k, left) {
            const a = env.audioFrags[k];
            if (!a || !(left > 0)) return;
            const L = this.cfg.loader, ld = this._ald = new L(this.cfg), g = this.gen;
            ld.load({ url: 'aud' + k, frag: { sn: a.sn, type: 'audio', start: a.start, duration: a.duration }, responseType: 'arraybuffer' }, {}, {
                onSuccess: () => {
                    if (this._ald === ld) this._ald = null;
                    if (this.dead || !this.loading || g !== this.gen) return;
                    env.audioLoads.push(k);
                    this.emit(E.FRAG_LOADED, { frag: a, payload: { byteLength: 1000 } });
                    const r = this._ar;
                    this._ar = r && a.start <= r[1] + 1e-6 && a.start + a.duration >= r[0] - 1e-6 ? [Math.min(r[0], a.start), Math.max(r[1], a.start + a.duration)] : [a.start, a.start + a.duration];
                    this._updBuf();
                    this.emit(E.FRAG_BUFFERED, { frag: { sn: a.sn, type: 'audio', start: a.start } });
                    if (this.media) this.media._settle();
                    this._loadAudio(k + 1, left - 1);
                }, onError: () => { }, onTimeout: () => { }
            });
        }
        // video.buffered = 各 SourceBuffer 的交集(有分离音轨时视频段 ∩ 音频段)
        _updBuf() {
            const v = this.media;
            if (!v) return;
            const vr = this._vr, ar = this._ar;
            if (!vr) { v.buffered = new R([]); return; }
            if (!env.audioFrags) { v.buffered = new R([vr]); return; }
            const s0 = ar ? Math.max(vr[0], ar[0]) : 0, e0 = ar ? Math.min(vr[1], ar[1]) : 0;
            v.buffered = new R(e0 > s0 ? [[s0, e0]] : []);
        }
        // 分片经 config.loader 取(预览的 SeekPreviewLoader → 这里的 BaseLoader = 网络)
        _loadFrag(i) {
            const f = env.frags[i];
            if (!f) return;
            const L = this.cfg.loader, ld = this._ld = new L(this.cfg);
            ld.load({ url: 'seg' + i, frag: { sn: f.sn, type: 'main', start: f.start, duration: f.duration }, responseType: 'arraybuffer' }, {}, {
                onSuccess: () => { if (this._ld === ld) this._ld = null; this._fragDone(i); }, onError: () => { }, onTimeout: () => { }
            });
        }
        _cancelFrag() {
            if (this._ld) { try { this._ld.abort(); } catch (e) { errors.push(e); } this._ld = null; }
            if (this._ald) { try { this._ald.abort(); } catch (e) { errors.push(e); } this._ald = null; }
        }
        _fragDone(i) {
            if (this.dead || !this.loading) return;
            const f = env.frags[i];
            if (env.mode === 'fatalFrag') { this.loading = false; return this.emit(E.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadError', frag: f }); }
            env.fragLoads.push(i);
            this.emit(E.FRAG_LOADED, { frag: f, payload: { byteLength: env.fragBytes } });
            const v = this.media;
            this._vr = [f.start + (opt.ptsLag || 0), f.start + f.duration];
            this._updBuf();
            if (v.readyState < 1) v.readyState = 1;
            // stream-controller 的监听排在外面的前面:目标片缓冲完那一拍就决定要不要取下一片 —— 新实例内部 loadedmetadata 还没置位
            //   (取片位置 = 这片的片尾),或片内剩余不足 maxBufferLength,都会同步发出下一片的请求(1.1.5 实测如此)
            if ((!this._lm || f.start + f.duration - v.currentTime < this.cfg.maxBufferLength) && env.frags[i + 1]) this._loadFrag(i + 1);
            this._lm = true;
            this.emit(E.FRAG_BUFFERED, { frag: { sn: f.sn, type: 'main', start: f.start } });
            v._settle();
        }
        stopLoad() { this.calls.push(['stopLoad']); this.loading = false; this.gen++; this._cancelFrag(); }
        destroy() { this.calls.push(['destroy']); this._cancelFrag(); if (!this.dead) { this.dead = true; env.alive--; } }
        count(name) { return this.calls.filter(c => c[0] === name).length; }
    }
    FakeHls.Events = E;
    FakeHls.DefaultConfig = { loader: BaseLoader };
    // ---- 假播放器 / 主视频 / vue ----
    const main = new Video();
    Object.assign(main, { paused: false, readyState: 4, duration: 2400, buffered: new R([[90, 160]]), src: 'blob:https://ednovas.video/0c1e' });   // hls.js attachMedia 后 src 是 blob:
    main._ct = 100;
    const mkPlayer = () => {
        const cont = new El('div'); cont.className = 'dplayer'; cont.rect = { left: 0, top: 0, width: 1000, height: 562, bottom: 562 };
        const wrap = new El('div'); wrap.className = 'dplayer-bar-wrap'; wrap.rect = { left: 100, top: 515, width: 800, height: 14, bottom: 529 };
        const bar = new El('div'); bar.className = 'dplayer-bar'; bar.rect = { left: 100, top: 520, width: 800, height: 4, bottom: 524 };
        wrap.appendChild(bar); cont.appendChild(wrap);
        const evs = {};
        const plugins = new Proxy({}, { get(t, k) { env.pluginTouches.push(String(k)); return undefined; }, set(t, k) { env.pluginTouches.push('set:' + String(k)); return true; } });
        return { container: cont, template: { playedBarWrap: wrap }, events: { on(n, f) { (evs[n] = evs[n] || []).push(f); }, fire(n) { (evs[n] || []).slice().forEach(f => f()); } }, plugins, video: main };
    };
    const player = mkPlayer();
    const vue = Object.assign({ _playToken: 1, currentGroup: { name: 'x' }, isTVMode: false, previewLocked: false, trial: { on: false, ended: false }, _liveActive: false, _isCasting: () => false }, opt.vue || {});
    const store = Object.assign({}, opt.ls || {});
    const win = Object.assign({ Hls: FakeHls, vueApp: vue, navigator: { connection: { saveData: false, effectiveType: '4g' } }, PointerEvent: function () { }, devicePixelRatio: 1,
        localStorage: { getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) } }, opt.win || {});
    if (opt.offline) win._OfflineHlsLoader = mkOffline(BaseLoader, opt.offline);   // 【真】index.html OfflineLoader 垫在网络 loader 上(查库结果由测试放出)
    const ctl = Core.createController({ win, doc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, raf: f => clock.setTimeout(f, 0), getHls: () => win.Hls, getVue: () => win.vueApp });
    const URL0 = 'https://cdn.example.com/vod/ep1/index.m3u8';
    const s = {
        env, clock, doc, main, player, vue, win, ctl, errors, FakeHls, mkPlayer, URL0,
        ui: () => player.__dgSp,
        wrap: () => player.template.playedBarWrap,
        xAt: t => 100 + 800 * t / main.duration,
        hover(t, p) { (p || player).template.playedBarWrap.dispatch('pointermove', { clientX: 100 + 800 * t / main.duration, pointerType: 'mouse', pointerId: 1, button: 0 }); },
        leave(p) { (p || player).template.playedBarWrap.dispatch('pointerleave', { pointerType: 'mouse', pointerId: 1 }); },
        inst: () => env.instances[env.instances.length - 1],
        S: () => ctl._S,
        shown: () => { const u = player.__dgSp; return !!(u && u.box.classList.contains('on')); },
        start(ms) { main.dispatch('playing'); clock.advance(ms == null ? 5000 : ms); }
    };
    if (opt.bind !== false) ctl.bind(player, main, URL0);
    return s;
}

// --- A 停手 150ms 才取 + 完整一次取图 ---
{
    const s = setup();
    s.start();
    for (let i = 0; i < 20; i++) { s.hover(1100 + i * 3); s.clock.advance(50); }
    ok(s.env.instances.length === 0, 'A:指针一直在动(每 50ms)→ 不取,也不建预览实例');
    ok(!s.shown(), 'A:没有缓存、没有在取 → 不出框(留 DPlayer 自己的时间气泡)');
    s.hover(1200);
    s.clock.advance(140);
    ok(s.env.instances.length === 0, 'A:停手 140ms 还不取');
    s.clock.advance(15);
    ok(s.env.instances.length === 1 && s.inst().calls[0][0] === 'loadSource' && s.inst().calls[0][1] === s.URL0, 'A:停手 150ms 后建实例,读主播放器同一个清单地址');
    const h = s.inst();
    ok(h.cfg.autoStartLoad === false && h.cfg.maxBufferLength <= 2 && h.cfg.maxMaxBufferLength <= 4 && typeof h.cfg.loader === 'function', 'A:实例配置:不自动加载、缓冲很小、自带 loader');
    s.clock.advance(6);   // MANIFEST_PARSED
    ok(h.calls.some(c => c[0] === 'startLoad' && c[2] === false) && s.env.fragLoads.length === 0, 'A:先在没挂 <video> 时 startLoad 拿分片表(此时 hls.js 不取分片)');
    s.clock.advance(6);   // LEVEL_LOADED → attach → aim
    const sl = h.calls.filter(c => c[0] === 'startLoad');
    ok(h.count('attachMedia') === 1 && sl.length === 2 && sl[1][1] === 1201 && sl[1][2] === true, 'A:拿到分片表才挂 <video>,只从 t 所在分片里的 seek 点开始取', sl);
    ok(s.shown() && s.ui().box.classList.contains('wait') && !s.ui().box.classList.contains('pic'), 'A:取的时候出占位框(带时间)');
    ok(s.ui().lab.textContent === '20:00', 'A:框里时间 = 指针处时间', s.ui().lab.textContent);
    s.clock.advance(200);
    ok(s.env.fragLoads.length === 1 && s.env.fragLoads[0] === 200, 'A:只取了一个分片(t 所在的那一片)', s.env.fragLoads);
    ok(s.env.net.length === 1 && s.env.net[0] === 1200 && s.env.netAborted === 0, 'A:新实例顺手预取的下一片挂在 loader 里,一个字节都没发出去', { net: s.env.net, aborted: s.env.netAborted });
    const iStop = h.calls.findIndex(c => c[0] === 'stopLoad');
    ok(iStop > 0 && h.calls.slice(0, iStop).filter(c => c[0] === 'startLoad').length === 2, 'A:目标片缓冲好立刻 stopLoad');
    const st = s.ctl.status();
    ok(st.cached === 1 && st.n.ok === 1 && st.job === null && s.env.draws.length === 1 && s.env.draws[0] === 1201, 'A:画在 seek 点那一帧并缓存', { st, draws: s.env.draws });
    ok(h.calls.some(c => c[0] === 'trigger' && c[1] === E.BUFFER_FLUSHING && c[2].startOffset === 0 && c[2].endOffset === Infinity && c[2].type === null), 'A:画完清掉预览实例的缓冲(只留一片的内存)');
    const u = s.ui();
    ok(s.shown() && u.box.classList.contains('pic') && !u.box.classList.contains('wait') && /^data:image\/jpeg/.test(u.img.src), 'A:框里换成缩略图');
    ok(u.cont.classList.contains('dg-sp-on'), 'A:框亮着时容器带 dg-sp-on(藏 DPlayer 自带时间气泡)');
    ok(u.pic.style.width === '160px' && u.pic.style.height === '90px' && u.box.style.width === '168px', 'A:16:9 片 160×90', [u.pic.style.width, u.pic.style.height]);
    ok(u.box.style.left === '416px' && u.box.style.bottom === '52px', 'A:框以指针为中心、底边在进度条上方 10px', [u.box.style.left, u.box.style.bottom]);
    ok(s.env.previewPlays === 0, 'A:预览 <video> 从不 play()');
    s.leave();
    ok(!s.shown() && !u.cont.classList.contains('dg-sp-on'), 'A:移出进度条就收起');
    s.hover(1203); s.clock.advance(1);
    ok(s.shown() && u.box.classList.contains('pic') && !u.box.classList.contains('approx'), 'A:回到同一片立刻出缓存图(不再取)');
    s.clock.advance(1000);
    ok(s.env.fragLoads.length === 1 && s.env.instances.length === 1, 'A:缓存命中不再取、不建新实例');
    const css = s.doc.getElementById('dg-sp-css');
    ok(!!css && css.textContent.includes('.dplayer.dg-sp-on .dplayer-bar-wrap .dplayer-bar-time{opacity:0!important;visibility:hidden!important}') && css.textContent.includes('.dplayer-hide-controller .dg-sp{display:none!important}') && /pointer-events:none/.test(css.textContent), 'A:样式注入一次(DPlayer 时间气泡让位、控制栏隐藏时跟着藏、不挡指针)');
    ok(s.errors.length === 0, 'A:全程无异常', s.errors.map(String));
}

// --- B 拖动时先顶上最近的一张;同时最多 1 个分片;取完接着取最新位置 ---
{
    const s = setup({ fragMs: 2000 });
    s.start();
    s.hover(1200); s.clock.advance(170);
    ok(s.S().job && s.env.inflight === 1, 'B:第一张在路上');
    s.hover(1500); s.clock.advance(300);
    s.hover(1800); s.clock.advance(300);
    ok(s.env.maxInflight === 1 && s.inst().calls.filter(c => c[0] === 'startLoad').length === 2, 'B:在路上的没完,不发第二个');
    s.clock.advance(2000);
    ok(s.env.fragLoads[0] === 200, 'B:第一张照常取完(不浪费)');
    s.clock.advance(2500);
    ok(s.env.fragLoads.length === 2 && s.env.fragLoads[1] === 300 && s.env.maxInflight === 1, 'B:接着取指针现在的位置(1800s 那片),跳过中间划过的', s.env.fragLoads);
    // 最近一张:1820s 离 1800~1806 那片 14s,先顶上(半透明)
    s.hover(1820); s.clock.advance(1);
    const u = s.ui();
    ok(s.shown() && u.box.classList.contains('pic') && u.box.classList.contains('approx'), 'B:没缓存的位置先顶上最近一张(approx)');
    s.hover(2200); s.clock.advance(1);
    ok(!s.shown(), 'B:离最近的缓存太远(>36s)不顶');
    s.clock.advance(170);
    ok(s.shown() && u.box.classList.contains('wait') && !u.box.classList.contains('approx'), 'B:停手后去取,出占位');
    s.clock.advance(2500);
    ok(s.env.fragLoads.length === 3 && s.env.maxInflight === 1 && s.env.maxAlive === 1, 'B:全程同时最多 1 个分片、1 个实例', s.env);
    ok(s.errors.length === 0, 'B:无异常', s.errors.map(String));
}

// --- C 主视频 waiting / seeking 立刻中止;之后 2s 内不取 ---
for (const evName of ['waiting', 'seeking']) {
    const s = setup({ fragMs: 3000 });
    s.start();
    s.hover(1200); s.clock.advance(200);
    ok(s.env.inflight === 1, 'C(' + evName + '):预览分片在路上');
    const h = s.inst(), stops = h.count('stopLoad');
    s.main.dispatch(evName);
    ok(s.env.inflight === 0 && h.count('stopLoad') === stops + 1 && s.S().job === null, 'C(' + evName + '):主视频 ' + evName + ' → 立刻 stopLoad 掐掉预览分片');
    const st = s.ctl.status();
    ok(st.n.abort === 1 && st.fails === 0 && st.failed === 0, 'C(' + evName + '):中止不算失败、不拉黑这一片');
    s.clock.advance(1500);
    ok(s.env.inflight === 0 && h.calls.filter(c => c[0] === 'startLoad').length === 2, 'C(' + evName + '):2s 内不重取');
    s.clock.advance(1200);
    ok(s.env.inflight === 1 || s.env.fragLoads.length === 1, 'C(' + evName + '):过了 2s 指针还在 → 重取');
    ok(s.errors.length === 0, 'C:无异常', s.errors.map(String));
}

// --- D 闸门:缓冲不足 / 起播 / 暂停;取的过程中缓冲往下掉 ---
{
    const s = setup();
    s.main.buffered = new R([[95, 105]]);   // 前方 5s
    s.start();
    s.hover(1200); s.clock.advance(1500);
    ok(s.env.instances.length === 0 && s.ctl.status().last === 'buffer', 'D:前方不足 20s → 不取(也不建实例)', s.ctl.status().last);
    s.main.buffered = new R([[95, 130]]);
    s.clock.advance(600);
    ok(s.env.instances.length === 1, 'D:缓冲够了,指针还在 → 自动开始取');
    s.clock.advance(300);
    ok(s.ctl.status().cached === 1, 'D:取到');
}
{
    const s = setup();
    s.main.dispatch('playing');
    s.clock.advance(1000);
    s.hover(1200); s.clock.advance(500);
    ok(s.env.instances.length === 0 && s.ctl.status().last === 'startup', 'D:开播 4s 内不取');
    s.clock.advance(3000);
    ok(s.env.instances.length === 1, 'D:开播满 4s 后取');
}
{
    // 绑定时主视频已经在播、之后没有 playing 事件:第一次看到在播就开始算 4s 起播期
    const s = setup();
    s.clock.advance(10000);
    s.hover(1200); s.clock.advance(400);
    ok(s.env.instances.length === 0 && s.ctl.status().last === 'startup', 'D:没收到 playing 也有起播期(第一次看到在播起算)');
    s.clock.advance(4200);
    ok(s.env.instances.length === 1, 'D:…4s 后照常取');
}
{
    // 自动播放被拦:主视频停在起播点(paused),主播放器还在拉首屏 —— readyState 已经到 4 也一个字节都不抢
    const s = setup();
    Object.assign(s.main, { paused: true, readyState: 4, buffered: new R([[100, 112]]) });
    s.hover(1200); s.clock.advance(3000);
    ok(s.env.instances.length === 0 && s.env.net.length === 0 && s.ctl.status().last === 'unplayed', 'D:暂停但这次播放还没真播起来过(自动播放被拦)→ 不取、不建实例', s.ctl.status().last);
    s.main.paused = false; s.main.dispatch('playing');   // 用户点了播放:真播起来了
    s.clock.advance(1000);
    ok(s.env.instances.length === 0, 'D:…播起来后 4s 起播期内照样不取');
    s.main.paused = true;   // 又暂停(当前位置往后有数据,readyState 4)
    s.hover(1200); s.clock.advance(400);
    ok(s.env.instances.length === 1 && s.ctl.status().cached === 1, 'D:这次播放播起来过、暂停着且 readyState≥3 → 可以取(前方缓冲不够 20s 也行)');
    s.main.readyState = 2;   // 暂停着,主播放器在等当前这一段
    s.hover(1800); s.clock.advance(3000);
    ok(s.env.fragLoads.length === 1 && s.ctl.status().last === 'stall', 'D:暂停但 readyState<3 → 不取下一张', s.ctl.status().last);
    s.main.readyState = 1;
    s.clock.advance(1000);
    ok(s.env.fragLoads.length === 1 && s.ctl.status().last === 'startup', 'D:暂停但主视频没首帧(readyState<2)不取');
    s.main.readyState = 3;
    s.clock.advance(600);
    ok(s.env.fragLoads.length === 2, 'D:readyState 回到 3,指针还在 → 接着取');
}
{
    // 上一次播放(旧令牌)播起来过不算:换集后新一集自动播放被拦,照样不取
    const s = setup();
    s.start();
    s.vue._playToken = 2; s.ctl.reset('play');   // play() 递增令牌 → reset
    Object.assign(s.main, { paused: true, readyState: 4 });
    s.ctl.bind(s.player, s.main, s.URL0);   // _dgHlsCustomType 重新 bind
    s.hover(1200); s.clock.advance(3000);
    ok(s.env.instances.length === 0 && s.ctl.status().last === 'unplayed', 'D:旧令牌的 playing 不带到新一集(新一集自动播放被拦 → 不取)', s.ctl.status().last);
    s.main.dispatch('playing'); s.main.paused = true;
    s.hover(1200); s.clock.advance(400);
    ok(s.env.instances.length === 1 && s.ctl.status().cached === 1, 'D:新一集真播起来过之后暂停 → 可以取');
}
{
    const s = setup();
    s.vue._playToken = 2;            // play() 已递增令牌,旧绑定还没拆(下一次指针移动才拆)
    s.main.dispatch('playing');      // 这是新一次播放的 playing
    const b = s.S().bound;
    ok(b && b.played === false && b.playingAt === 0, 'D:令牌已变时的 playing 不记到旧绑定上', b && { played: b.played, playingAt: b.playingAt });
}
{
    const s = setup();
    s.start();
    Object.assign(s.main, { paused: true, ended: true, readyState: 2, _ct: 2400 });
    s.hover(1200); s.clock.advance(400);
    ok(s.ctl.status().cached === 1, 'D:这次播放播完了(ended,readyState 2)→ 可以取');
}
{
    const s = setup({ fragMs: 3000 });
    s.start();
    s.hover(1200); s.clock.advance(300);
    ok(s.env.inflight === 1, 'D:在路上');
    s.main.buffered = new R([[95, 106]]);   // 前方掉到 6s
    s.clock.advance(250);
    ok(s.env.inflight === 0 && s.ctl.status().last === 'abort:main', 'D:取的过程中主视频前方缓冲掉到 8s 以下 → 中止', s.ctl.status().last);
}
{
    const s = setup({ fragMs: 3000 });
    s.start();
    s.hover(1200); s.clock.advance(300);
    s.doc.hidden = true; s.doc.dispatch('visibilitychange');
    ok(s.env.inflight === 0 && s.ctl.status().last === 'abort:hidden', 'D:页面切到后台 → 中止');
    s.clock.advance(5000);
    ok(s.env.inflight === 0 && s.env.fragLoads.length === 0, 'D:后台期间不取');
}

// --- E 令牌 / reset / 播放器销毁 / 换地址 —— 任何时刻最多一个实例 ---
{
    const s = setup();
    s.start();
    s.hover(1200); s.clock.advance(400);
    ok(s.env.alive === 1 && s.ctl.status().cached === 1, 'E:有一个实例、一张缓存');
    s.vue._playToken = 2;   // 换线路 / 换集(play() 递增令牌)
    s.hover(1300);
    ok(s.env.alive === 0 && !s.ctl.status().bound && !s.shown(), 'E:令牌变了 → 下一次指针移动就拆掉实例、收起框');
    s.clock.advance(2000);
    ok(s.env.instances.length === 1, 'E:旧绑定不再取');
    s.ctl.bind(s.player, s.main, s.URL0);   // 新的 play() → _dgHlsCustomType 重新 bind
    s.start();   // switchVideo 后主视频重新起播(playing)
    s.hover(1200); s.clock.advance(1);
    ok(!s.shown(), 'E:新绑定从零开始(上一次的缓存作废)');
    s.clock.advance(400);
    ok(s.env.instances.length === 2 && s.env.maxAlive === 1, 'E:新实例;旧的早已销毁');
    // 同令牌同地址重复 bind:不动
    const a0 = s.env.alive, n0 = s.env.instances.length, c0 = s.ctl.status().cached;
    s.ctl.bind(s.player, s.main, s.URL0);
    ok(s.env.alive === a0 && s.ctl.status().cached === c0 && s.env.instances.length === n0, 'E:同令牌同地址重复 bind 不重建');
    // 同令牌换地址(代理回退 _dpSwitchHls → switchVideo → customType):重建、缓存清空
    s.ctl.bind(s.player, s.main, 'https://proxy.example.com/?url=' + encodeURIComponent(s.URL0));
    ok(s.env.alive === 0 && s.ctl.status().cached === 0 && s.ctl.status().bound, 'E:同令牌换地址(代理回退)→ 销毁旧实例、缓存清空');
    s.start();
    s.hover(1200); s.clock.advance(400);
    ok(s.inst().calls[0][1].startsWith('https://proxy.example.com/'), 'E:新实例读新地址');
    s.ctl.reset('play');
    ok(s.env.alive === 0 && !s.ctl.status().bound, 'E:reset(play) 拆掉');
    s.ctl.bind(s.player, s.main, s.URL0); s.start();
    s.hover(1200); s.clock.advance(400);
    s.ctl.reset('close');
    ok(s.env.alive === 0 && !s.shown(), 'E:reset(close)(关播放页)拆掉、收起');
    // 原生通道
    s.ctl.bind(s.player, s.main, s.URL0); s.start(); s.hover(1200); s.clock.advance(400);
    s.ctl.unbind('native');
    ok(s.env.alive === 0 && !s.ctl.status().bound, 'E:unbind(native)');
    // 播放器销毁(_dpRebuildFresh / 观看历史里 dp.destroy())
    s.ctl.bind(s.player, s.main, s.URL0); s.start(); s.hover(1200); s.clock.advance(400);
    const wrap = s.wrap(), cont = s.player.container, box = s.ui().box;
    s.player.events.fire('destroy');
    ok(s.env.alive === 0 && !s.ctl.status().bound && !cont.children.includes(box) && wrap.count('pointermove') === 0 && wrap.count('pointerdown') === 0 && !s.player.__dgSp, 'E:播放器 destroy → 拆实例、删框、摘掉进度条监听');
    // 新播放器:重新装界面
    const p2 = s.mkPlayer();
    s.ctl.bind(p2, s.main, s.URL0); s.start();
    s.hover(1200, p2); s.clock.advance(400);
    ok(!!p2.__dgSp && s.ctl.status().cached === 1, 'E:新播放器重新装界面并能取');
    ok(s.env.maxAlive === 1, 'E:全程同时最多一个预览实例', s.env.maxAlive);
    ok(s.errors.length === 0, 'E:无异常', s.errors.map(String));
}

// --- F 不启用条件 ---
{
    const cases = [
        ['省流量', { win: { navigator: { connection: { saveData: true, effectiveType: '4g' } } } }],
        ['3G', { win: { navigator: { connection: { saveData: false, effectiveType: '3g' } } } }],
        ['2G', { win: { navigator: { connection: { saveData: false, effectiveType: '2g' } } } }],
        ['TV 模式(isTVMode)', { vue: { isTVMode: true } }],
        ['不支持 MSE(iPhone)', { supported: false }],
        ['原生 HLS 通道(Safari/iPad)', { win: { _dgPreferNativeHls: true } }],
        ['直播(_liveActive)', { vue: { _liveActive: true } }],
        ['直播(currentGroup._isLive)', { vue: { currentGroup: { _isLive: true } } }],
        ['投屏', { vue: { _isCasting: () => true } }],
        ['没有 PointerEvent', { win: { PointerEvent: undefined } }],
        ['未登录预览框架', { vue: { previewLocked: true } }],
        ['试看已结束', { vue: { trial: { on: true, ended: true } } }],
        ['手动关(localStorage)', { ls: { donggua_seekprev_off: '1' } }],
        ['主视频走原生 HLS(src 是 m3u8 地址)', { mainSrc: 'https://cdn.example.com/vod/ep1/index.m3u8' }],
        ['同一次播放换成 MP4 直链(src 是 mp4)', { mainSrc: 'https://kz.example.com/ep1.mp4' }]
    ];
    for (const [name, o] of cases) {
        const s = setup(o);
        if (o.mainSrc) s.main.src = o.mainSrc;
        s.start();
        s.hover(1200); s.clock.advance(3000);
        ok(s.env.instances.length === 0 && !s.shown() && s.env.fragLoads.length === 0, 'F:' + name + ' → 不取、不出框');
    }
    const s = setup();
    s.doc.body.classList.add('tv-mode');
    s.start(); s.hover(1200); s.clock.advance(3000);
    ok(s.env.instances.length === 0, 'F:body.tv-mode → 不取');
    // 指针停住之后(150ms 内没有新的移动)才变的:取之前再看一遍
    const sc = setup();
    sc.start(); sc.hover(1200); sc.clock.advance(50);
    sc.vue._isCasting = () => true;
    sc.clock.advance(3000);
    ok(sc.env.instances.length === 0, 'F:停手后开始投屏 → 取之前再查一遍,不取');
    const st = setup();
    st.start(); st.hover(1200); st.clock.advance(50);
    st.vue._playToken = 9;   // 停手期间换了集(play() 递增令牌),指针没再动
    st.clock.advance(3000);
    ok(st.env.instances.length === 0 && !st.ctl.status().bound, 'F:停手期间令牌变了 → 不取、直接拆掉');
    const s2 = setup({ bind: false });
    s2.ctl.bind(s2.player, s2.main, 'blob:https://x/abc');
    ok(!s2.ctl.status().bound, 'F:地址是 blob: 不绑定');
    const s3 = setup({ win: { navigator: { connection: { saveData: false, effectiveType: 'constructor' } } } });
    s3.start(); s3.hover(1200); s3.clock.advance(400);
    ok(s3.env.instances.length === 1, 'F:effectiveType 是原型键名不误判成慢网');
}

// --- G 失败静默:超时计数、坏片不重试、计满停用;致命错误 ---
{
    const s = setup({ mode: 'hang' });
    s.start();
    s.hover(1200); s.clock.advance(200);
    ok(s.S().job, 'G:在路上');
    s.clock.advance(C.JOB_TIMEOUT_MS);
    let st = s.ctl.status();
    ok(st.n.fail === 1 && st.fails === 1 && st.failed === 1 && st.job === null && s.env.inflight === 0, 'G:12s 超时 → 记一次失败、停掉加载', st);
    ok(!s.shown(), 'G:失败不出框、不报错');
    s.hover(1201); s.clock.advance(3000);
    ok(s.ctl.status().n.jobs === 1, 'G:同一片失败过不再重试');
    s.hover(600); s.clock.advance(200 + C.JOB_TIMEOUT_MS);
    s.hover(1800); s.clock.advance(200 + C.JOB_TIMEOUT_MS);
    st = s.ctl.status();
    ok(st.fails === 3 && /^fail/.test(st.dead) && !st.inst && s.env.alive === 0, 'G:连续失败 3 次 → 这一集停用、实例销毁', st);
    s.hover(300); s.clock.advance(5000);
    ok(s.ctl.status().n.jobs === 3, 'G:停用后不再取');
}
{
    const s = setup({ blank: true });
    s.start(); s.hover(1200); s.clock.advance(400);
    const st = s.ctl.status();
    ok(st.cached === 0 && st.fails === 1 && st.last === 'draw', 'G:画出来是空帧(帧还没解出来)→ 当失败,不缓存', st);
}
{
    const s = setup({ mode: 'fatalManifest' });
    s.start(); s.hover(1200); s.clock.advance(400);
    let st = s.ctl.status();
    ok(/^fatal:manifestLoadError/.test(st.dead) && s.env.alive === 0, 'G:清单拿不到(致命)→ 这一集停用', st);
    s.hover(600); s.clock.advance(3000);
    ok(s.env.instances.length === 1, 'G:停用后不再建实例');
}
{
    const s = setup({ mode: 'fatalFrag' });
    s.start(); s.hover(1200); s.clock.advance(400);
    let st = s.ctl.status();
    ok(st.fails === 1 && !st.dead && s.env.alive === 0, 'G:分片拿不到(致命)→ 记失败、拆实例,不整集停用', st);
    s.hover(600); s.clock.advance(1500);
    ok(s.env.instances.length === 2 && s.env.maxAlive === 1, 'G:下一张换新实例(旧的已销毁)');
    s.hover(1800); s.clock.advance(1500);
    st = s.ctl.status();
    ok(st.fails === 3 && /^fail/.test(st.dead), 'G:分片连续失败 3 次也停用', st);
}
{
    const s = setup({ mode: 'live' });
    s.start(); s.hover(1200); s.clock.advance(400);
    ok(s.ctl.status().dead === 'live' && s.env.alive === 0 && s.env.fragLoads.length === 0, 'G:清单是直播 → 停用');
}
{
    const s = setup({ frags: [] });
    s.start(); s.hover(1200); s.clock.advance(400);
    ok(s.ctl.status().dead === 'empty' && s.env.alive === 0, 'G:空清单 → 停用');
}

// --- H 剪过插播的时间轴 / 多码率 / 时间戳偏移 ---
{
    const s = setup({ vue: { _cutToBase: t => t + 100 } });
    s.start(); s.hover(1200); s.clock.advance(400);
    ok(s.env.fragLoads[0] === 216 && s.env.draws[0] === 1297, 'H:剪过插播(adCut)→ 进度条时间经 _cutToBase 换回原清单时间轴再找分片', { f: s.env.fragLoads, d: s.env.draws });
    ok(s.ui().lab.textContent === '20:00', 'H:框里时间仍是进度条上的时间(剪后时间轴)');
}
{
    const s = setup({ vue: { _cutToBase: () => { throw new Error('x'); } } });
    s.start(); s.hover(1200); s.clock.advance(400);
    ok(s.env.fragLoads[0] === 200, 'H:_cutToBase 抛错 → 按原时间(不影响取图)');
}
{
    const s = setup({ levels: [{ bitrate: 800000 }, { bitrate: 2500000 }, { bitrate: 6000000 }] });
    s.start(); s.hover(1200); s.clock.advance(400);
    ok(s.inst().calls.some(c => c[0] === 'loadLevel' && c[1] === 0), 'H:多码率主清单 → 锁最低一档');
}
{
    const s = setup({ ptsLag: 1.5, frags: mkFrags(400, 6, 0) });   // 分片实际时间戳比清单晚 1.5s:预定 seek 点没被缓冲盖住
    s.start(); s.hover(1200); s.clock.advance(600);
    ok(s.ctl.status().cached === 1 && s.env.draws[0] > 1201.5 && s.env.draws[0] < 1206, 'H:缓冲段没盖住预定点 → 改到本片里有数据的地方再画', s.env.draws);
}

// --- L 分离音轨(EXT-X-MEDIA TYPE=AUDIO):音轨控制器连着往后要,只放行和目标分片同一段的音频片 ---
{
    // 视频 6s 一片(sn 1000+),音频 4s 一片(sn 5000+);1200s → 视频 [1200,1206),同段音频 = [1200,1204) [1204,1208)
    const s = setup({ audioFrags: mkFrags(600, 4, 5000), audioMs: 10, audioGreedy: 6 });
    s.start(); s.hover(1200); s.clock.advance(400);
    const aud = s.env.net.filter(x => x >= 5000), vid = s.env.net.filter(x => x < 5000);
    ok(s.ctl.status().cached === 1 && s.env.draws[0] === 1201, 'L:目标片 + 同段音频到齐就画(video.buffered 是各 SourceBuffer 的交集)', { st: s.ctl.status(), draws: s.env.draws });
    ok(aud.length === 2 && aud[0] === 5300 && aud[1] === 5301, 'L:音轨控制器一口气往后要 6 片 → 只有和目标段重叠的 2 片发出去,目标段以外一个都不取', s.env.net);
    ok(vid.length === 1 && vid[0] === 1200, 'L:视频仍只取目标那一片', s.env.net);
    s.hover(1800); s.clock.advance(400);
    const aud2 = s.env.net.filter(x => x >= 5000);
    ok(s.ctl.status().cached === 2 && aud2.length === 4 && aud2[2] === 5450 && aud2[3] === 5451, 'L:下一张同样只取同段音频', s.env.net);
    ok(s.errors.length === 0, 'L:无异常', s.errors.map(String));
}
{
    // 音频片比视频长(10s):只要盖住目标段的那一片
    const s = setup({ audioFrags: mkFrags(300, 10, 7000), audioMs: 10, audioGreedy: 5 });
    s.start(); s.hover(1200); s.clock.advance(400);
    const aud = s.env.net.filter(x => x >= 7000);
    ok(s.ctl.status().cached === 1 && aud.length === 1 && aud[0] === 7120, 'L:长音频片 → 只取盖住目标段的那一片', s.env.net);
}

// --- M 离线库还在查的时候任务被中止:查完库也不再发请求(预览 loader 继承【真】OfflineLoader) ---
{
    const db = mkDb();
    const s = setup({ offline: db });
    s.start(); s.hover(1200); s.clock.advance(170);
    ok(s.S().job && s.S().job.idx === 200 && db.pend.length === 1 && s.env.net.length === 0, 'M:目标片先去离线库查(还没发请求)', { pend: db.pend.length, net: s.env.net });
    s.main.dispatch('waiting');   // 主视频卡了 → 立刻中止(stopLoad → loader.abort)
    ok(s.S().job === null && s.ctl.status().last === 'abort:waiting', 'M:主视频 waiting → 任务中止');
    db.settle(null); await tickIO(); s.clock.advance(100);
    ok(s.env.net.length === 0 && s.env.inflight === 0, 'M:库里没有,查完也不再发请求(中止没丢)', s.env.net);
    // 过了 2s 指针还在 → 重取:新 loader 照常查库、走网络、出图
    s.clock.advance(2500);
    ok(db.pend.length === 1, 'M:过了 2s 重取,新 loader 照常先查库');
    db.settle(null); await tickIO(); s.clock.advance(100);
    ok(s.env.net.length === 1 && s.env.net[0] === 1200 && s.ctl.status().cached === 1, 'M:没中止的照常走网络、出图', { net: s.env.net, st: s.ctl.status() });
    // reset(换集)正赶上查库:同样不发
    s.hover(1800); s.clock.advance(170);
    ok(db.pend.length === 1, 'M:下一张在查库');
    s.ctl.reset('play');
    db.settle(null); await tickIO(); s.clock.advance(100);
    ok(s.env.net.length === 1 && s.env.alive === 0, 'M:查库期间 reset(实例销毁)→ 不发请求', s.env.net);
    ok(s.errors.length === 0, 'M:无异常', s.errors.map(String));
}

// --- K 小播放器(手机竖屏只有 ~190px 高):框不顶出播放器上沿 ---
{
    const s = setup({ fragMs: 50 });
    const cont = s.player.container, wrap = s.wrap(), bar = wrap.children[0];
    cont.rect = { left: 16, top: 246, width: 344, height: 193, bottom: 439 };
    wrap.rect = { left: 36, top: 369, width: 304, height: 34, bottom: 403 };
    bar.rect = { left: 36, top: 383, width: 304, height: 6, bottom: 389 };
    s.start();
    const hv = t => { wrap.dispatch('pointermove', { clientX: 36 + 304 * t / s.main.duration, pointerType: 'mouse', pointerId: 1 }); };
    hv(1200); s.clock.advance(400);
    const u = s.ui(), H0 = parseInt(u.pic.style.height), W0 = parseInt(u.pic.style.width), bottom = parseInt(u.box.style.bottom);
    ok(s.shown() && W0 === 160 && H0 === 90, '小播放器:16:9 的 160×90 放得下就原样', [W0, H0]);
    ok(bottom + C.BOX_CHROME + H0 <= cont.rect.height - C.BOX_TOP, '小播放器:框顶在播放器上沿以内', { bottom, H0 });
    // 竖屏片(短剧):68×120 放不下 → 等比缩
    s.main.duration = 2400;
    s.inst().media.videoWidth = 1080; s.inst().media.videoHeight = 1920;
    hv(1800); s.clock.advance(400);
    const H1 = parseInt(u.pic.style.height), W1 = parseInt(u.pic.style.width);
    ok(s.shown() && H1 < 120 && H1 >= 90 && Math.abs(W1 / H1 - 1080 / 1920) < 0.03 && parseInt(u.box.style.bottom) + C.BOX_CHROME + H1 <= cont.rect.height - C.BOX_TOP, '小播放器:竖屏片缩到放得下(比例不变)', [W1, H1]);
    // 进度条贴着上沿(极小播放器):不出框
    cont.rect = { left: 16, top: 346, width: 344, height: 93, bottom: 439 };
    hv(1800); s.clock.advance(1);
    ok(!s.shown() && !cont.classList.contains('dg-sp-on'), '小播放器:连 36px 都没有就不出框(DPlayer 时间气泡照常)');
}

// --- I 触屏拖动 / 鼠标拖出进度条 / 右键 ---
{
    const s = setup();
    s.start();
    const wrap = s.wrap();
    wrap.dispatch('pointermove', { clientX: s.xAt(1200), pointerType: 'touch', pointerId: 5 });
    s.clock.advance(1);
    ok(!s.S().ptr && !s.shown(), 'I:触屏没按下的 pointermove 不算悬停');
    wrap.dispatch('pointerdown', { clientX: s.xAt(1200), pointerType: 'touch', pointerId: 5, button: 0 });
    ok(s.doc.count('pointermove') === 1 && s.doc.count('pointerup') === 1 && s.doc.count('pointercancel') === 1, 'I:按下后在 document 上跟手');
    for (let i = 0; i < 10; i++) { s.doc.dispatch('pointermove', { clientX: s.xAt(1200 + i * 20), pointerType: 'touch', pointerId: 5 }); s.clock.advance(40); }
    s.doc.dispatch('pointermove', { clientX: s.xAt(999), pointerType: 'touch', pointerId: 9 });   // 别的手指
    ok(Math.abs(s.S().ptr.t - 1380) < 1e-6, 'I:拖动跟手(只认按下的那根手指)', s.S().ptr.t);
    s.clock.advance(200);
    ok(s.env.instances.length === 1, 'I:拖动中停手 150ms → 取');
    s.clock.advance(300);
    ok(s.shown() && s.ctl.status().cached === 1, 'I:拖动中出缩略图');
    s.doc.dispatch('pointerup', { pointerType: 'touch', pointerId: 5 });
    ok(!s.shown() && !s.S().ptr && s.doc.count('pointermove') === 0 && s.doc.count('pointerup') === 0, 'I:松手收起、摘掉 document 监听');
    // 鼠标按住拖出进度条(纵向离开)仍跟手
    wrap.dispatch('pointerdown', { clientX: s.xAt(600), pointerType: 'mouse', pointerId: 1, button: 0 });
    wrap.dispatch('pointerleave', { pointerType: 'mouse', pointerId: 1 });
    s.doc.dispatch('pointermove', { clientX: s.xAt(700), pointerType: 'mouse', pointerId: 1 });
    ok(s.S().ptr && Math.abs(s.S().ptr.t - 700) < 1e-6, 'I:鼠标按住拖出进度条仍跟手(pointerleave 不收)');
    s.doc.dispatch('pointerup', { pointerType: 'mouse', pointerId: 1 });
    ok(!s.S().ptr, 'I:松开收起');
    wrap.dispatch('pointerdown', { clientX: s.xAt(600), pointerType: 'mouse', pointerId: 1, button: 2 });
    ok(s.doc.count('pointermove') === 0, 'I:右键不算拖动');
    // 指针在两端:框夹在容器里
    s.hover(0); s.clock.advance(1);
    s.hover(2400); s.clock.advance(1);
    ok(s.errors.length === 0, 'I:无异常', s.errors.map(String));
}

// --- J 预算 / 清缓冲与下一张不打架 / 不碰主播放器 ---
{
    const s = setup({ fragBytes: C.TOKEN_BYTES + 1 });
    s.start(); s.hover(1200); s.clock.advance(400);
    ok(s.ctl.status().cached === 1, 'J:第一张照常');
    s.hover(1800); s.clock.advance(400);
    const st = s.ctl.status();
    ok(st.dead === 'budget' && s.env.fragLoads.length === 1 && s.env.alive === 0, 'J:这一集超过 200MB → 停取、拆实例', st);
    s.hover(1203); s.clock.advance(1);
    ok(s.shown() && s.ui().box.classList.contains('pic'), 'J:停取后已缓存的照样显示');
}
{
    const s = setup({ flushMs: 800 });
    s.start(); s.hover(1200); s.clock.advance(400);
    const h = s.inst(), n0 = h.calls.filter(c => c[0] === 'startLoad').length;
    s.hover(1800); s.clock.advance(300);
    ok(h.calls.filter(c => c[0] === 'startLoad').length === n0 && s.S().job && s.S().job.idx === -1, 'J:上一张的缓冲还在清 → 下一张先等(不把旧数据当成已缓冲)');
    s.clock.advance(700);
    ok(s.ctl.status().cached === 2 && s.env.fragLoads[1] === 300, 'J:清完接着取');
}
{
    const s = setup({ flushMs: 1e9 });   // 清缓冲一直没完成:最多等 2s
    s.start(); s.hover(1200); s.clock.advance(400);
    s.hover(1800); s.clock.advance(2600);
    ok(s.env.fragLoads.length === 2, 'J:清缓冲迟迟不完 → 最多等 2s 照常取');
}
{
    // 跑一个完整场景,主播放器的 plugins 一次都没被读写
    const s = setup();
    s.start(); s.hover(1200); s.clock.advance(400); s.hover(1800); s.clock.advance(400);
    s.main.dispatch('seeking'); s.ctl.reset('play'); s.player.events.fire('destroy');
    ok(s.env.pluginTouches.length === 0, 'J:全程没读写过 player.plugins(不碰 dp.plugins.hls)', s.env.pluginTouches);
}

// ======================= ④ 接线(静态) =======================
console.log('④ 接线');
{
    const tag = /<script data-cfasync="false" src="libs\/js\/seek-preview\.js\?v=(\d+)" defer><\/script>/.exec(HTML);
    ok(!!tag, 'index.html 以 defer 引入 seek-preview.js?v=');
    ok(tag && SW.includes("'./libs/js/seek-preview.js?v=" + tag[1] + "'"), 'sw.js 预缓存同一个 ?v=');
    const a = HTML.indexOf('window._dgHlsCustomType = function (video, player) {');
    const body = HTML.slice(a, HTML.indexOf('function buildOfflineHlsConfig()', a));
    const nat = body.slice(0, body.indexOf('return;'));
    ok(!/dgSeekPreview/.test(nat), '_dgHlsCustomType:原生通道分支不加接线(adclip-test 守着那里的顺序;主视频不是 blob: 时控制器自己不启用)');
    const iBind = body.indexOf('window.dgSeekPreview.bind(player, video, video.src)'), iNew = body.indexOf('const hls = new Hls('), iLoad = body.indexOf('hls.loadSource(video.src);'), iAtt = body.indexOf('hls.attachMedia(video);');
    ok(iBind > iNew && iBind < iLoad && iLoad < iAtt, '_dgHlsCustomType:hls.js 分支在 loadSource / attachMedia 之前 bind(src 还不是 blob:)');
    ok(/try \{ if \(window\.dgSeekPreview\) window\.dgSeekPreview\.bind\(player, video, video\.src\); \} catch \(e\) \{ \}/.test(body), 'bind 包在 try/catch 里');
    const incs = [...HTML.matchAll(/this\._playToken = \(this\._playToken \|\| 0\) \+ 1\)?;/g)];
    ok(incs.length === 2, 'play() 里递增 _playToken 的有两处', incs.length);
    ok(incs.every(m => /window\.dgSeekPreview\.reset\('play'\)/.test(HTML.slice(m.index, m.index + 700).split('\n').slice(0, 3).join('\n'))), '每处递增令牌后两行内 reset(play)');
    ok(/const playToken = \(this\._playToken = \(this\._playToken \|\| 0\) \+ 1\);\s*\n\s*try \{ if \(window\.adClipSkip\) window\.adClipSkip\.vue = this;/.test(HTML), '不挤开 adclip-test 守着的"递增令牌后立刻交 vue"');
    const cd = HTML.indexOf('                closeDetail() {');
    ok(cd > 0 && /window\.dgSeekPreview\.reset\('close'\)/.test(HTML.slice(cd, cd + 1500)), 'closeDetail 调 reset(close)');
    // goHome 也会直接收起播放页(搜索结果页返回、TV 遥控返回、安卓 App 返回键注入的 JS、回首页),不走 closeDetail
    const gh = HTML.indexOf('                goHome() {');
    const ghBody = gh > 0 ? HTML.slice(gh, HTML.indexOf('\n                },', gh)) : '';
    const iGhReset = ghBody.indexOf("window.dgSeekPreview.reset('home')"), iGhHide = ghBody.indexOf('this.showDetail = false;'), iGhTv = ghBody.indexOf("window.location.href = '/'");
    ok(iGhReset > 0 && iGhHide > iGhReset && iGhTv > 0 && iGhTv < iGhReset, 'goHome 收起播放页前调 reset(home)(TV 模式那支整页刷新,不用)', { iGhTv, iGhReset, iGhHide });
    ok(/try \{ if \(window\.dgSeekPreview\) window\.dgSeekPreview\.reset\('home'\); \} catch \(e\) \{ \}/.test(ghBody), 'goHome 的 reset 包在 try/catch 里');
    // 收起播放页(showDetail = false)的每一处都审过:closeDetail / goHome 先 reset;只有深链加载帧那两处(帧下面还没起播放器)不用。新加一处这里就报,先审再改白名单
    const hides = [...HTML.matchAll(/this\.showDetail = false;/g)].map(m => {
        const pre = HTML.slice(0, m.index).split('\n').slice(-12).join('\n');
        return /window\.dgSeekPreview\.reset\(/.test(pre) ? 'reset' : (/deepLinkLoading/.test(pre) ? 'frame' : 'UNAUDITED@' + HTML.slice(0, m.index).split('\n').length);
    });
    ok(hides.length === 4 && hides.filter(x => x === 'reset').length === 2 && hides.filter(x => x === 'frame').length === 2, '收起播放页的每一处:closeDetail / goHome 先 reset,其余只有深链加载帧两处', hides);
    ok((HTML.match(/window\.dgSeekPreview\./g) || []).length === 5, 'index.html 里只有 5 处接线(bind / reset×4)', (HTML.match(/window\.dgSeekPreview\./g) || []).length);
    // 模块不碰主播放器的状态
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ok(!/plugins|_dpSwitchHls|_proxyRetrying|_errDiagTok|handlePlaybackError|_offHandlePlayError|_startWatchdog|adClipSkip|\badCut\b/.test(code), 'seek-preview.js 不碰 dp.plugins.hls / _dpSwitchHls / _proxyRetrying / 错误链 / 看门狗 / 去插播');
    ok(!/_playToken\s*=[^=]|\._activeCut\s*=|_setActiveCut/.test(code), 'seek-preview.js 只读令牌和剪段,不写');
    ok(!/\.play\(\)/.test(code), 'seek-preview.js 从不 play()');
    ok(!/\?\.|\?\?|catch\s*\{|\.\.\.\w/.test(code), 'seek-preview.js 不用 ?. / ?? / 无参 catch / 展开语法(老 WebView 也能解析)');
    try { new vm.Script(SRC); ok(true, 'seek-preview.js 语法'); } catch (e) { ok(false, 'seek-preview.js 语法', e.message); }
    // 不往 Vue methods 里加东西(index-methods-test 管重名)
    ok(!/dgSeekPreview|seekPreview/.test(HTML.slice(HTML.indexOf('methods: {'), HTML.indexOf('methods: {') + 200)), '没有新增 Vue 方法');
}
{
    // hls.min.js 1.1.5 的前提:换版本先报
    ok(HLS.includes('getLoadPosition=function(){var t=this.media,e=0;return this.loadedmetadata&&t?e=t.currentTime:this.nextLoadPosition&&(e=this.nextLoadPosition),e}'), 'hls:取片位置 = 有元数据时 media.currentTime,否则 startLoad 给的位置');
    ok(HLS.includes('c.doTickIdle=function(){var t,e,r=this.hls,i=this.levelLastLoaded,n=this.levels,s=this.media,o=r.config,l=r.nextLoadLevel;if(null!==i&&(s||!this.startFragRequested&&o.startFragPrefetch)'), 'hls:没挂 media(且不预取)时 stream-controller 不取分片 —— 先 startLoad 只拿分片表');
    ok(HLS.includes('e>0&&-1===t&&(this.log("Override startPosition with lastCurrentTime @"+e.toFixed(3)),t=e),this.state=xt,this.nextLoadPosition=this.startPosition=this.lastCurrentTime=t,this.tick()'), 'hls:startLoad(t) 把下一次取片位置设成 t');
    ok(HLS.includes('this.log("Attempt loading level index "+e+(t?" at sn "+t.msn+" part "+t.part:"")+" with URL-id "+i+" "+n),this.clearTimer(),this.hls.trigger(a.a.LEVEL_LOADING'), 'hls:每次 startLoad 都会重载子清单(所以清单留在内存)');
    ok(HLS.includes('getMaxBufferLength=function(t){var e,r=this.config;return e=t?Math.max(8*r.maxBufferSize/t,r.maxBufferLength):r.maxBufferLength,Math.min(e,r.maxMaxBufferLength)}'), 'hls:前向目标公式(maxBufferSize 0 → maxBufferLength 说了算)');
    ok(HLS.includes('e.type?i.append(n(e.type),e.type):this.getSourceBufferTypes().forEach((function(t){i.append(n(t),t)}))'), 'hls:BUFFER_FLUSHING type:null 清所有 SourceBuffer');
    ok(HLS.includes('bitrate-e.bitrate})),this._levels=n'), 'hls:levels 按码率升序(0 = 最低一档)');
    ok(HLS.includes('key:"loadLevel",get:function(){return this.levelController.level},set:function(t){o.b.log("set loadLevel:"+t),this.levelController.manualLevel=t}'), 'hls:loadLevel = 手动锁档');
    ok(HLS.includes('FRAG_BUFFERED="hlsFragBuffered"') && HLS.includes('BUFFER_FLUSHING="hlsBufferFlushing"') && HLS.includes('MANIFEST_PARSED="hlsManifestParsed"') && HLS.includes('LEVEL_LOADED="hlsLevelLoaded"'), 'hls:事件名');
    ok(HLS.includes('c.stopLoad=function(){this.fragmentLoader.abort();'), 'hls:stopLoad 掐掉在路上的分片');
}

// ======================= ⑤ sw.js =======================
console.log('⑤ sw.js');
{
    const handlers = {};
    const self = { location: new URL('https://ednovas.video/sw.js'), addEventListener: (t, f) => { handlers[t] = f; }, registration: {}, clients: { claim: async () => { } }, skipWaiting: () => { } };
    vm.runInContext(SW, vm.createContext({ self, URL, caches: {}, fetch: () => Promise.reject(new Error('no')), Response: class { }, console, setTimeout }));
    const responded = (u, dest) => {
        let r = false;
        handlers.fetch({ request: { url: u, method: 'GET', destination: dest, mode: 'cors', headers: { has: () => false } }, respondWith: (p) => { r = true; Promise.resolve(p).catch(() => { }); }, waitUntil: () => { } });
        return r;
    };
    ok(!responded('https://cdn.example.com/vod/ep1/seg001.png', '') && !responded('https://cdn.example.com/vod/ep1/seg001.jpg?k=1', ''), 'SW:hls.js XHR 取的 .png/.jpg 伪装分片不接(不进 LIVE_IMG_CACHE)');
    ok(!responded('https://cdn.example.com/vod/ep1/seg001.ts', '') && !responded('https://cdn.example.com/vod/ep1/index.m3u8', ''), 'SW:跨域分片 / 清单不接');
    ok(!responded('https://cors.ednovas.video/?url=' + encodeURIComponent('https://cdn.example.com/a.png'), '') && !responded('https://ednovas.video/?url=x.ts', ''), 'SW:走代理的(?url=)不接');
    // [adult] 成人站分支(ADULT_SITE):没有直播台标,跨域图片都是资源站海报 → 策略1b 整条关掉,一律不进缓存
    const ADULT_SW = /const ADULT_SITE = true/.test(SW);
    ok(ADULT_SW ? !responded('https://tb.zbds.top/logo/cctv1.png', 'image') : responded('https://tb.zbds.top/logo/cctv1.png', 'image'), ADULT_SW ? 'SW(成人站):跨域 <img> 海报不进缓存' : 'SW:<img> 台标照常 Cache First');
    ok(responded('https://image.tmdb.org/t/p/w500/x.jpg', 'image') && responded('https://image.tmdb.org/t/p/w500/x.jpg', ''), 'SW:TMDB 图照常');
    ok(ADULT_SW ? !responded('https://tb.zbds.top/logo/cctv1.png', undefined) : responded('https://tb.zbds.top/logo/cctv1.png', undefined), ADULT_SW ? 'SW(成人站):老浏览器也不缓存跨域海报' : 'SW:老浏览器没有 destination 时按扩展名认图片');
    ok(responded('https://ednovas.video/libs/js/seek-preview.js?v=1', 'script'), 'SW:seek-preview.js 走静态资源策略');
    const v = /const CACHE_VERSION = 'v(\d+)'/.exec(SW);
    ok(v && +v[1] >= 43, 'SW 已升版(v43 起)', v && v[1]);
}

// ======================= ⑥ 浏览器引导 =======================
console.log('⑥ 浏览器引导');
{
    const fakeDoc = { createElement: () => ({}), addEventListener: () => { }, getElementById: () => null, hidden: false };
    const ctx = loadCore({ document: fakeDoc, setTimeout, clearTimeout, performance: { now: () => 1 } });
    const g = ctx.dgSeekPreview;
    ok(!!g && typeof g.bind === 'function' && typeof g.unbind === 'function' && typeof g.reset === 'function' && typeof g.status === 'function', '有 document 时自动建 window.dgSeekPreview');
    let threw = false;
    try {
        g.bind(null, null, null); g.bind({}, {}, 'https://x/a.m3u8'); g.bind({ container: null, template: null }, { addEventListener: null }, 'https://x/a.m3u8');
        g.unbind(); g.reset('play'); g.reset(); g.status();
        g.bind(undefined, undefined, 123);
    } catch (e) { threw = e; }
    ok(!threw, '入口给垃圾参数、没有 Hls / vueApp 都不抛', String(threw));
    const ctx2 = loadCore({ document: fakeDoc });
    ok(ctx2.dgSeekPreview && ctx2.DgSeekPreviewCore, '重复加载不报错');
    const ctx3 = loadCore();
    ok(!ctx3.dgSeekPreview && !!ctx3.DgSeekPreviewCore, '没有 document(node / worker)只导出纯逻辑');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
