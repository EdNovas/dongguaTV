#!/usr/bin/env node
// 弹幕按集自动校正回归(离线、零外网):
//   node scripts/danmaku-auto-test.mjs
//  ① 判定纯函数(<dg-dm-auto-core> 在沙箱里真跑):±1 秒聚类、三条判定、窗口避开被剪段、缓存键和总长校验、条数上限、片名是 constructor / __proto__
//  ② 整条流程:真的 afpOffline(_mkFetch / _resolveMedia / _segList / _fetchEnvRange / _localEnv / _p,只把 TS 拆包和 decodeAudioData 换成按时间生成响度)+
//     真的 dmTime + 假网络 + 真的 ad-clip-core 剪段:如意式缺开头、Δ≈0 零分片、Δ<0、Δ 过大、Δ 只是提示(第 30 集)、阶梯形偏移、音频不一样、参考线路取片失败换下一条、
//     清单只走 Worker、来源缺失 / 腾讯 / 通道不对一个请求都不发、不抢片头分析、换集 / 换线 / 关弹幕 / 手动立刻停且不写结果、让路、本机记录零下载
//  ③ 接线:_dmBackend 收来源、play() 换集时 begin、_dpSwitchHls 通知换通道、关弹幕停
//  ④ 两个后端的来源字段:纯函数逐字一致;真跑 server.js 和 api/index.js + 假 danmu_api:来源随缓存保存、采样后还在、低置信和按 id 不给来源、老条目照常回 + 提前重抓 + 不钉长缓存
// 改弹幕时间、自动校正、来源字段、afpOffline 的取片函数后必跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const C = require(path.join(ROOT, 'public/libs/js/ad-clip-core.js'));
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const tick = () => new Promise(r => setImmediate(r));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const grab = (name) => {
    const m = new RegExp('// <' + name + '>\\n([\\s\\S]*?)\\n\\s*// </' + name + '>').exec(HTML);
    if (!m) { console.log('✗ index.html 里找不到 <' + name + '> 段'); process.exit(1); }
    return m[1];
};
const X = vm.runInNewContext(grab('dg-dm-resync-core') + '\n' + grab('dg-dm-time-core') + '\n' + grab('dg-dm-auto-core') + `
;({ DM_AUTO, dmOffSlot, dmStripAds, dmTimeCreate, dmAutoSrcOf, dmAutoCluster, dmAutoJudge, dmAutoWindow, dmAutoRefRange, dmAutoLag, dmAutoHintOk, dmAutoConfirm, dmAutoRefs, dmAutoGet, dmAutoPut, dmAutoCreate });`, { setTimeout, clearTimeout, console });
const { DM_AUTO, dmStripAds, dmTimeCreate, dmAutoSrcOf, dmAutoCluster, dmAutoJudge, dmAutoWindow, dmAutoRefRange, dmAutoLag, dmAutoHintOk, dmAutoConfirm, dmAutoRefs, dmAutoGet, dmAutoPut, dmAutoCreate } = X;

// 真的 afpOffline:从 index.html 抠整个对象。只换 _tsToAdts(拆包)和 _ac(解码),其它都是线上那份
const afpSrc = (() => {
    const a = HTML.indexOf('if (!window.afpOffline) window.afpOffline = {');
    const b = HTML.indexOf('// ========== 🗨️ 弹幕样式管理器', a);
    if (a < 0 || b < 0) { console.log('✗ 找不到 afpOffline'); process.exit(1); }
    const body = HTML.slice(a + 'if (!window.afpOffline) window.afpOffline = '.length, b);
    return body.slice(0, body.lastIndexOf('};') + 1);
})();

const mkStore = (init) => {
    const data = new Map(Object.entries(init || {}));
    return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); }, removeItem: k => data.delete(k), data };
};

console.log('① 判定');
{
    ok(dmAutoSrcOf({ src: 'imgo' }) === 'imgo' && dmAutoSrcOf({ src: ' IMGO ' }) === 'imgo', '来源取响应字段');
    ok(dmAutoSrcOf({ code: 0, data: [] }) === '' && dmAutoSrcOf(null) === '' && dmAutoSrcOf({ src: 1 }) === '', '缺字段 / 不是字符串 = 未知');

    let c = dmAutoCluster([2943.8, 2943.875, 2943.8, 2919.6, 734]);
    ok(c && near(c.mode, 2943.8, 0.1) && c.votes === 3 && c.n === 5, '3/5 票取众数', c);
    ok(dmAutoCluster([2943.8, 2943.8]) === null, '不够 3 票不算');
    ok(dmAutoCluster([100, 100, 100, 200, 200, 200]) === null, '正好一半不算过半');
    ok(dmAutoCluster([100, 100, 200, 200]) === null, '两派各半不算');
    ok(dmAutoCluster([100, 200, 300, 400, 500]) === null, '都不一样不算');
    ok(dmAutoCluster([]) === null, '没有清单不算');
    c = dmAutoCluster([1000, 1000.9, 1001.8, 1002.7, 1000.4]);
    ok(c && c.votes === 4 && !c.idx.includes(3), '只把中心 ±1 秒内的算一簇,不把一串链起来(1002.7 不算)', c);
    c = dmAutoCluster([2742, 2759.12, 2742.05, 2742, 2742.1]);
    ok(c && near(c.mode, 2742, 0.2) && c.votes === 4, '小众的总长不影响众数', c);

    ok(dmAutoJudge(2943.8, 2943.3).v === 'zero' && dmAutoJudge(2943.8, 2944.5).v === 'zero', '|Δ|<1:h=0');
    ok(dmAutoJudge(2943.8, 2942.8).v === 'measure' && dmAutoJudge(2943.8, 2942.8).d === 2943.8 - 2942.8, 'Δ=1 不算 ≈0,要测');
    ok(dmAutoJudge(2943.8, 2954.17).v === 'neg', 'Δ<0 不动(西瓜 -10.37)');
    ok(dmAutoJudge(2943.8, 734).v === 'big', 'Δ 过大拒绝(芒果残缺 2209.8)');
    ok(dmAutoJudge(3000, 2700).v === 'measure', 'Δ=300 上限内', dmAutoJudge(3000, 2700));
    ok(dmAutoJudge(3000.5, 2700).v === 'big', 'Δ 超过 300 秒拒绝');
    ok(dmAutoJudge(700, 600).v === 'big' && dmAutoJudge(680, 600).v === 'measure', '短片按总长 15%:600 秒上限 90');
    ok(dmAutoJudge(NaN, 100).v === 'fail' && dmAutoJudge(100, 0).v === 'fail', '总长不对');

    const cuts = [{ start: 50, end: 70, dur: 20 }];
    const toBase = t => C.fromCutTime(t, cuts), same = t => t;
    let w = dmAutoWindow(100, 20, 3000, toBase, same);
    ok(w && w.p === 100 && near(w.b0, 120, 1e-6) && near(w.b1, 140, 1e-6) && w.s0 === 100, '换回清单时间轴(剪段之后 +20)', w);
    w = dmAutoWindow(40, 20, 3000, toBase, same);
    ok(w && w.p === 65 && near(w.b0, 85, 1e-6) && near(w.b1, 105, 1e-6), '跨被剪段 → 往后挪,模板不混广告', w);
    w = dmAutoWindow(1000, 20, 3000, same, t => dmStripAds(t, [1005, 1025]));
    ok(w && w.p === 1025 && near(w.s0, 1005, 1e-6), '跨判成插播的组 → 挪开,s0 是扣过插播的时间', w);
    ok(dmAutoWindow(2990, 20, 3000, same, same) === null, '放不下返回 null');
    let r = dmAutoRefRange(40, 20, 119.96, 15);
    ok(near(r.from, 144.96, 1e-6) && near(r.to, 194.96, 1e-6), '头部窗口 [40+Δ−15, 60+Δ+15]');
    r = dmAutoRefRange(1553, 20, 120, 3);
    ok(near(r.from, 1670, 1e-6) && near(r.to, 1696, 1e-6), '第二锚点 [锚点+h−3, 锚点+20+h+3]');
    ok(dmAutoRefRange(5, 20, 1, 15).from === 0, '不取负时间');

    const corr = (a, ao, b, bo, w2) => { let d = 0; for (let i = 0; i < w2; i++) d += a[ao + i] === b[bo + i] ? 1 : 0; return d / w2; };
    const tpl = [1, 2, 3, 4], refEnv = [9, 9, 9, 1, 2, 3, 4, 9];
    const m = dmAutoLag(tpl, refEnv, 100, 40, corr);
    ok(m && near(m.lag, 60.3, 1e-6) && m.r === 1, 'lag = 参考时间 − 我方时间(0.1 秒一步)', m);
    ok(dmAutoLag([1, 2, 3], [1], 0, 0, corr) === null, '参考比模板短返回 null');
    ok(dmAutoHintOk({ r: 0.8, lag: 5 }) && !dmAutoHintOk({ r: 0.79, lag: 5 }) && !dmAutoHintOk({ r: 0.9, lag: -1 }) && !dmAutoHintOk(null), '头部:r≥0.8 且 lag>0');
    ok(dmAutoConfirm({ r: 0.8, lag: 121 }, 120) && !dmAutoConfirm({ r: 0.95, lag: 121.1 }, 120) && !dmAutoConfirm({ r: 0.79, lag: 120 }, 120) && !dmAutoConfirm(null, 120), '第二锚点:r≥0.8 且 |lag−h|≤1');

    // 同集其它线路
    const keyOf = n => { const x = String(n).match(/第\s*0*(\d+)\s*集/); return x ? 'N' + x[1] + (/(上|下)/.exec(n) || [''])[0] : 'T' + n; };
    const sources = [
        { site_key: 'cur', vod_play_url: '第29集$https://cur.test/a.m3u8' },
        { site_key: 'b', o: 5, vod_play_url: '第1集$https://b.test/1.m3u8#第029集$https://b.test/29.m3u8' },
        { site_key: 'a', o: 1, vod_play_url: 'x$$$第29集$https://a.test/29.m3u8?sign=1' },
        { site_key: 'c', o: 1, vod_play_url: '第29集$https://c.test/share/29' },
        { site_key: 'd', o: 1, vod_play_url: '第29集上$https://d.test/29a.m3u8' },
        { site_key: 'e', o: 1, _cachedDetail: { vod_play_url: '第29集$https://cur.test/a.m3u8' }, vod_play_url: '' },
        { site_key: 'f', o: 2, _cachedDetail: { vod_play_url: '第29集$https://f.test/29.m3u8' } },
        null,
    ];
    const refs = dmAutoRefs(sources, 'cur', 'https://cur.test/a.m3u8', '第29集', keyOf, s => s.o);
    ok(refs.map(x => x.site).join() === 'a,f,b', '只要同集的 m3u8,不含本线路 / 同一地址 / 分享页 / 上下半,rank 小的在前', refs);
    ok(dmAutoRefs(sources, 'cur', '', '', keyOf, s => s.o).length === 0, '没有集名不找');

    // 本机记录
    const K = '小巷人家|site|29|f', ls = mkStore(), store = () => ls;
    dmAutoPut(store, K, { st: 'ok', h: 120, dur: 2823.8, at: 1000 });
    ok(dmAutoGet(store, K, 2823.8, 2000).h === 120, '同总长命中');
    ok(dmAutoGet(store, K, 2824.5, 2000).h === 120, '差 0.7 秒仍命中');
    ok(dmAutoGet(store, K, 2824.8, 2000) === null, '差 ≥1 秒重算');
    ok(dmAutoGet(store, '小巷人家|site|29|r', 2823.8, 2000) === null, '通道不同不共用');
    ok(dmAutoGet(store, K, 2823.8, 1000 + 31 * 864e5) === null, '30 天后过期');
    dmAutoPut(store, K, { st: 'fail', h: 0, dur: 2823.8, at: 1000 });
    ok(!!dmAutoGet(store, K, 2823.8, 1000 + 5 * 3600e3) && dmAutoGet(store, K, 2823.8, 1000 + 7 * 3600e3) === null, '失败只记 6 小时');
    dmAutoPut(store, K, { st: 'yield', h: 0, dur: 2823.8, at: 1000 });
    ok(!!dmAutoGet(store, K, 2823.8, 1000 + 1700e3) && dmAutoGet(store, K, 2823.8, 1000 + 1900e3) === null, '让路没做完只记半小时');
    dmAutoPut(store, K, { st: '???', h: 9, dur: 2823.8, at: 1000 });
    ok(dmAutoGet(store, K, 2823.8, 2000) === null, '不认识的状态不算');
    dmAutoPut(store, K, { st: 'ok', h: 9, dur: 2823.8, at: 5000 });
    ok(dmAutoGet(store, K, 2823.8, 2000) === null, '时钟倒退不算');
    const bad = () => { throw new Error('denied'); };
    ok(dmAutoGet(bad, K, 1, 1) === null, '存储不可用读不抛');
    dmAutoPut(bad, K, { st: 'ok', h: 1, dur: 1, at: 1 });
    ok(true, '存储不可用写不抛');
    const ls2 = mkStore({ [DM_AUTO.STORE]: '{oops' });
    ok(dmAutoGet(() => ls2, K, 1, 1) === null, '坏数据当空');
    const ls3 = mkStore(), s3 = () => ls3;
    for (let i = 0; i < DM_AUTO.CAP + 20; i++) dmAutoPut(s3, 'k' + i, { st: 'ok', h: 1, dur: 100, at: i + 1 });
    const left = Object.keys(JSON.parse(ls3.getItem(DM_AUTO.STORE)));
    ok(left.length === DM_AUTO.CAP && !left.includes('k:k0') && left.includes('k:k' + (DM_AUTO.CAP + 19)), '超上限淘汰最旧的');
    const ls4 = mkStore(), s4 = () => ls4;
    ok(dmAutoGet(s4, 'constructor', 100, 2) === null && dmAutoGet(s4, '__proto__', 100, 2) === null, '片名是 constructor / __proto__ 读到空');
    dmAutoPut(s4, '__proto__', { st: 'ok', h: 3, dur: 100, at: 1 });
    ok(dmAutoGet(s4, '__proto__', 100, 2).h === 3 && ({}).h === undefined, '片名是 __proto__ 正常存,不污染原型');
}

console.log('② 整条流程');
// ---- 假世界:一条"平台"响度(平滑噪声,10Hz),各线路是它的一段段拼接 ----
const seedNoise = (seed, n) => { let x = seed >>> 0; const a = new Float32Array(n); for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; a[i] = x / 4294967296; } return a; };
const SMOOTH = (() => { const raw = seedNoise(7, 40000); const out = new Float32Array(raw.length); for (let i = 2; i + 2 < raw.length; i++) out[i] = (raw[i - 2] + raw[i - 1] + raw[i] + raw[i + 1] + raw[i + 2]) / 5; return out; })();
const OTHER = (() => { const raw = seedNoise(99, 40000); const out = new Float32Array(raw.length); for (let i = 2; i + 2 < raw.length; i++) out[i] = (raw[i - 2] + raw[i - 1] + raw[i] + raw[i + 1] + raw[i + 2]) / 5; return out; })();
const ampAt = (t, table) => { const f = Math.max(0, t) * 10, i = Math.floor(f), w = f - i; const a = table[i] || 0, b = table[i + 1] || 0; return a + (b - a) * w; };
const WORKER = 'https://w.test';

// 一条线路 = 片段列表 { t0, dur } (平台时间) 或 { ad:true, dur }。按 4 秒切片;Worker 版默认去掉 workerDrop 的片段
const mkLine = (site, pieces, opt) => {
    opt = opt || {};
    const segDur = opt.segDur || 4;
    const url = 'https://' + site + '.test/ep/index.m3u8', segs = [];
    pieces.forEach((pc, pi) => {
        let done = 0;
        while (done < pc.dur - 1e-6) {
            const d = Math.min(segDur, pc.dur - done);
            segs.push({ d, pc: pi, ad: !!pc.ad, tp: pc.ad ? (pc.tp || 0) + done : pc.t0 + done, other: !!(pc.other || opt.other) });
            done += d;
        }
    });
    segs.forEach((x, i) => { x.url = 'https://' + site + '.test/ep/' + i + '.ts'; });
    const text = (list) => '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n' + list.map(x => '#EXTINF:' + x.d.toFixed(3) + ',\n' + x.url).join('\n') + '\n#EXT-X-ENDLIST\n';
    const line = { site, url, segs, opt, rawText: text(segs), workerText: text(segs.filter(x => !x.workerDrop && !(opt.workerDropAds && x.ad))), total: 0 };
    line.total = (opt.workerDropAds ? segs.filter(x => !x.ad) : segs).reduce((a, x) => a + x.d, 0);
    return line;
};
const CLEAN_TOTAL = 2943.8;
const cleanLine = (site, opt) => mkLine(site, [{ t0: 0, dur: CLEAN_TOTAL }], opt);

const mkWorld = (cfg) => {
    const w = { sleeps: 0, firstAt: null, reqs: [], lines: new Map(), token: 1, src: 'imgo', logs: [], segFail: new Set(), listFail: new Set(), clock: 1e12, ls: cfg.ls || mkStore(), hold: null };
    const add = (l) => w.lines.set(l.site, l);
    cfg.refs.forEach(add); add(cfg.own);
    const segMap = new Map();
    w.lines.forEach(l => l.segs.forEach(x => segMap.set(x.url, { l, x })));
    const resp = (status, body, url) => ({ ok: status >= 200 && status < 300, status, url, text: async () => String(body), arrayBuffer: async () => body });
    // 分片 = 1KB 假字节,开头记着是第几个注册的分片,"解码"时据此生成 PCM
    const reg = [];
    const fetchStub = async (u) => {
        if (w.firstAt == null) w.firstAt = w.sleeps;
        w.reqs.push(u);
        await tick();   // 每个请求至少占一个宏任务:测试才插得进"下载中途"
        const uo = new URL(u);
        const viaWorker = uo.origin === WORKER, target = viaWorker ? uo.searchParams.get('url') : u;
        if (w.hold) await w.hold;
        if (/\.m3u8/.test(target)) {
            const site = new URL(target).hostname.split('.')[0], l = w.lines.get(site);
            if (!l || (w.listFail.has(site) && viaWorker)) return resp(403, 'forbidden', u);
            return resp(200, viaWorker ? l.workerText : l.rawText, u);
        }
        const hit = segMap.get(target);
        if (!hit || w.segFail.has(hit.l.site)) return resp(404, '', u);
        const id = reg.length; reg.push(hit);
        const buf = new ArrayBuffer(1000); new Uint32Array(buf)[0] = id;
        return resp(200, buf, u);
    };
    const video = { paused: false, readyState: 4, currentTime: 30, seeking: false, buffered: { length: 1, start: () => 0, end: () => 1e6 }, addEventListener() { } };
    const dm = {
        dan: Array.from({ length: 200 }, (_, i) => ({ time: i * 15 })), danIndex: 0, showing: true, drawn: [], seeks: 0, clears: 0,
        options: { time: () => video.currentTime },
        clear() { this.danIndex = 0; this.clears++; },
        seek() { this.seeks++; this.clear(); for (let e = 0; e < this.dan.length; e++) { if (this.dan[e].time >= this.options.time()) { this.danIndex = e; break; } this.danIndex = this.dan.length; } },
    };
    w.player = { video, danmaku: dm };
    const ctx = vm.createContext({ fetch: fetchStub, URL, console: { log() { }, warn() { } }, setTimeout, clearTimeout, MessageChannel, dp: w.player, crypto: {}, window: {}, navigator: { onLine: true } });
    const A = w.A = vm.runInContext('(' + afpSrc + ')', ctx);
    A._tsToAdts = (u8) => ({ type: 'aac', data: u8, pts: -1, vpts: -1 });
    A._ac = {
        decodeAudioData: async (buf) => {
            const { l, x } = reg[new Uint32Array(buf)[0]];
            const sr = 1000, n = Math.round(x.d * sr), pcm = new Float32Array(n);
            const table = (x.ad || x.other) ? OTHER : SMOOTH;
            for (let i = 0; i < n; i++) pcm[i] = ampAt(x.tp + i / sr, table);
            void l;
            return { sampleRate: sr, getChannelData: () => pcm };
        }
    };
    A._mb = 0;
    const cuts = cfg.cuts || [];
    const own = cfg.own;
    w.vue = { currentSource: { site_key: own.site }, corsProxyUrl: WORKER, currentUrl: own.url, _introChannel: () => w.g.ch };
    w.T = dmTimeCreate({ player: () => w.player, store: () => w.ls, adCore: () => C, adOpt: () => null, adState: () => null, render: () => { } });
    w.T.install(w.player);
    w.g = { off: '', want: true, hls: w.hlsObj = {}, showing: true, listN: 200, total: cfg.total, key: 'T|' + own.site + '|29|f', proxy: true, saving: false, cutBusy: false, paused: false, seeking: false, readyState: 4, currentTime: 30, ahead: 30, ch: 'f' };
    const refsOf = () => cfg.refs.map((l, i) => ({ site: l.site, url: l.url, o: i, i }));
    w.auto = dmAutoCreate({
        time: w.T,
        now: () => w.clock,
        sleep: async (ms) => { w.clock += ms; w.sleeps++; await tick(); },
        store: () => w.ls,
        log: t => w.logs.push(t),
        token: () => w.token,
        vue: () => w.vue,
        afp: () => (w.noAfp ? null : A),
        source: () => w.src,
        curUrl: () => own.url,
        toBase: t => C.fromCutTime(t, cuts),
        baseTotal: d => d + cuts.reduce((a, c) => a + c.dur, 0),
        strip: t => dmStripAds(t, w.T.runs),
        refs: refsOf,
        view: () => Object.assign({}, w.g, { showing: dm.showing }),
    });
    w.play = () => { w.T.begin(w.token, 'T|' + own.site + '|29', false); w.auto.begin(w.token); };
    w.settle = async (states, max) => {
        states = states || ['done', 'off', 'cache'];
        for (let i = 0; i < (max || 200000); i++) { await tick(); if (states.includes(w.auto.state) && !w.auto.looping) return true; }
        return false;
    };
    w.segReqs = () => w.reqs.filter(u => /\.ts/.test(decodeURIComponent(u)));
    w.listReqs = () => w.reqs.filter(u => /\.m3u8/.test(decodeURIComponent(u)));
    return w;
};
// 如意式:缺平台开头 head 秒;V=625 处 20 秒插播(adCut 剪掉);片尾 12.16 秒广告(adCut 剪掉)。hls.js 手里的总长是剪后的
const ruyi = (head, opt) => {
    opt = opt || {};
    const mid = 625, ad1 = 20, tailAd = 12.16;
    const body = CLEAN_TOTAL - head - mid;
    const pieces = [{ t0: head, dur: mid }, { ad: true, dur: ad1 }, { t0: head + mid, dur: body }, { ad: true, dur: tailAd, tp: 200 }];
    const line = mkLine('ruyi', pieces);
    const cuts = [{ start: mid, end: mid + ad1, dur: ad1 }, { start: mid + ad1 + body, end: mid + ad1 + body + tailAd, dur: tailAd }];
    const total = line.total - ad1 - tailAd;
    return { line, cuts, total };
};
const FIVE = () => ['hn', 'xl', 'sb', 'gs', 'hy'].map(s => cleanLine(s));

{
    // ---- 如意第 29 集 ----
    const R = ruyi(120);
    let w = mkWorld({ own: R.line, refs: FIVE(), cuts: R.cuts, total: R.total });
    w.play();
    ok(await w.settle(), '如意:流程结束');
    ok(w.auto.state === 'done' && w.auto.last.st === 'ok', '如意:成功', w.auto.last);
    ok(near(w.T.h, 120, 0.15) && near(w.T.offset, 120, 0.15), '如意:h≈120,取实测 lag', w.T.h);
    ok(w.player.danmaku.seeks === 1, '如意:h 算出来对齐一次,不反复清屏', w.player.danmaku.seeks);
    ok(near(w.player.danmaku.options.time(), 30 + w.T.h, 1e-6), '如意:弹幕时间 = currentTime + h');
    ok(w.listReqs().filter(u => u.startsWith('https://ruyi')).length === 0, '如意:本线路清单也走 Worker(通道 f)');
    ok(w.listReqs().filter(u => !u.startsWith(WORKER)).length === 0, '参考线路清单只走 Worker,一条直连都没有', w.listReqs().filter(u => !u.startsWith(WORKER)));
    const segsUsed = new Set(w.segReqs().map(u => new URL(u).hostname.split('.')[0]));
    ok(segsUsed.has('ruyi') && segsUsed.has('hn') && segsUsed.size === 2, '如意:分片只取本线路 + 一条参考线路', [...segsUsed]);
    ok(w.segReqs().length <= 32, '如意:只取窗口里的分片(模板 20 秒 ×2 + 参考 50 + 26 秒,4 秒一片)', w.segReqs().length);
    const pl = w.segReqs().filter(u => u.includes('ruyi')).map(u => +u.match(/(\d+)\.ts/)[1]).sort((a, b) => a - b);
    ok(pl[0] === 10 && pl.includes(10) && !pl.some(i => i >= 157 && i <= 161), '如意:模板分片换回清单时间轴,没碰被剪的插播', pl);
    const stored = JSON.parse(w.ls.getItem(DM_AUTO.STORE));
    const rec = stored['k:' + w.g.key];
    ok(rec && rec.st === 'ok' && near(rec.h, 120, 0.15) && near(rec.dur, R.total, 1e-6), '如意:结果按 剧|线路|集|通道 存,带总长', rec);
    ok(w.A._busy === false, '如意:做完放开 _busy');

    // 刷新后(新世界,同一份 localStorage)命中缓存零下载,起播就对齐
    let w2 = mkWorld({ own: R.line, refs: FIVE(), cuts: R.cuts, total: R.total, ls: w.ls });
    w2.g.currentTime = 0; w2.player.video.currentTime = 0; w2.g.paused = true;   // 刚起播,没到稳定条件
    w2.play();
    ok(await w2.settle(), '缓存:流程结束');
    ok(w2.auto.state === 'cache' && near(w2.T.h, 120, 0.15), '缓存:命中,不用等播放稳定', w2.auto.state);
    ok(w2.reqs.length === 0, '缓存:零请求', w2.reqs);
    ok(w2.player.danmaku.seeks === 1 && w2.player.danmaku.danIndex === 8, '缓存:起播时读指针对齐到 h 之后,不爆弹幕', w2.player.danmaku.danIndex);

    // 总长变了(比如这次 adCut 没生效)→ 重算
    let w3 = mkWorld({ own: R.line, refs: FIVE(), cuts: [], total: R.total + 32.16, ls: w.ls });
    w3.play();
    ok(await w3.settle(), '总长不同:流程结束');
    ok(w3.reqs.length > 0 && w3.auto.state !== 'cache', '总长差 ≥1 秒不认旧记录,重算');
    ok(w3.auto.last && w3.auto.last.st === 'rej', 'adCut 没生效时 Δ=87.84 对不上真值 → 拒绝,不动', w3.auto.last);
    ok(w3.T.offset === 0, 'adCut 没生效:offset 还是 0');

    // ---- 同线路连续对不上:不再每集白花流量 ----
    {
        const k0 = w.g.key, c = k0.lastIndexOf('|'), e = k0.lastIndexOf('|', c - 1);
        const head = k0.slice(0, e + 1), tail = k0.slice(c);
        const seed = (rows) => { const ls = mkStore(); rows.forEach(([k, st, at]) => dmAutoPut(() => ls, k, { st, h: 0, dur: 2000, at: at || 1e12 })); return ls; };
        const go = async (rows) => { const q = mkWorld({ own: R.line, refs: FIVE(), cuts: R.cuts, total: R.total, ls: seed(rows) }); q.play(); await q.settle(); return q; };
        let q = await go([[head + '27' + tail, 'rej'], [head + '28' + tail, 'rej']]);
        ok(q.reqs.length === 0 && q.auto.state === 'off' && q.T.offset === 0, '同线路 2 集对不上:第 3 集一个请求都不发', q.reqs.length);
        q = await go([[head + '28' + tail, 'rej']]);
        ok(q.auto.last && q.auto.last.st === 'ok', '只对不上 1 集:照常测', q.auto.last);
        q = await go([[head + '26' + tail, 'ok'], [head + '27' + tail, 'rej'], [head + '28' + tail, 'rej']]);
        ok(q.auto.last && q.auto.last.st === 'ok', '这条线路对上过:不算连续对不上', q.auto.last);
        q = await go([[head + '27|r', 'rej'], [head + '28|r', 'rej']]);
        ok(q.auto.last && q.auto.last.st === 'ok', '别的通道对不上:不影响这个通道', q.auto.last);
        q = await go([['T|别的线路|27' + tail, 'rej'], ['T|别的线路|28' + tail, 'rej']]);
        ok(q.auto.last && q.auto.last.st === 'ok', '别的线路对不上:不影响这条线路', q.auto.last);
        const old = 1e12 - 31 * 864e5;
        q = await go([[head + '27' + tail, 'rej', old], [head + '28' + tail, 'rej', old]]);
        ok(q.auto.last && q.auto.last.st === 'ok', '记录过期:可以再试', q.auto.last);
    }

    // ---- 测量中弹幕来源变了:结果不用、不写记录 ----
    {
        const q = mkWorld({ own: R.line, refs: FIVE(), cuts: R.cuts, total: R.total });
        q.play();
        for (let i = 0; i < 2000 && !q.segReqs().length; i++) await tick();
        q.src = 'qq';
        await q.settle();
        const m = JSON.parse(q.ls.getItem(DM_AUTO.STORE) || '{}');
        ok(q.T.offset === 0 && q.auto.state === 'off' && !Object.keys(m).length, '来源变成腾讯:不移动、不记结果', { off: q.T.offset, st: q.auto.state });
        ok(q.A._busy === false, '来源变了:放开 _busy');
    }

    // ---- 干净线路:Δ≈0 零分片 ----
    const own = cleanLine('hl');
    w = mkWorld({ own, refs: FIVE(), total: own.total });
    w.play();
    ok(await w.settle(), '干净线路:流程结束');
    ok(w.auto.last.st === 'zero' && w.T.offset === 0 && w.segReqs().length === 0, '干净线路:h=0、零分片', { st: w.auto.last.st, segs: w.segReqs().length });
    ok(w.player.danmaku.seeks === 0, '干净线路:不清屏');
    ok(w.listReqs().length === 5, '干净线路:只取 5 份清单', w.listReqs().length);

    // ---- Δ<0 / Δ 过大 ----
    const xg = mkLine('xg', [{ t0: 0, dur: 597.8 }, { ad: true, dur: 10.37 }, { t0: 597.8, dur: CLEAN_TOTAL - 597.8 }]);
    w = mkWorld({ own: xg, refs: FIVE(), total: xg.total });
    w.play();
    await w.settle();
    ok(w.auto.last.st === 'neg' && w.T.offset === 0 && w.segReqs().length === 0, '西瓜 Δ=-10.37:不动,零分片', w.auto.last);
    const mg = mkLine('mg', [{ t0: 0, dur: 734 }]);
    w = mkWorld({ own: mg, refs: FIVE(), total: mg.total });
    w.play();
    await w.settle();
    ok(w.auto.last.st === 'big' && w.T.offset === 0 && w.segReqs().length === 0, '芒果残缺 Δ=2209.8:拒绝,零分片', w.auto.last);

    // ---- 第 30 集:Δ 只是提示 ----
    {
        const head = 115.09, t30 = 2742;   // Worker 删了尾巴:众数 2742,线路 2742-119.96
        const refs30 = ['hn', 'xl', 'sb', 'gs', 'hy'].map(s => mkLine(s, [{ t0: 0, dur: t30 }]));
        const ownTotal = t30 - 119.96;
        const l = mkLine('ruyi', [{ t0: head, dur: ownTotal }]);
        w = mkWorld({ own: l, refs: refs30, total: ownTotal });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'ok' && near(w.T.h, 115.09, 0.15), '第 30 集:Δ=119.96、真值 115.09 → h 取实测 lag', { h: w.T.h, d: w.auto.last.d });
    }
    // 第 10 / 1 集:偏移逐集不同
    for (const head of [135, 100]) {
        const r2 = ruyi(head);
        w = mkWorld({ own: r2.line, refs: FIVE(), cuts: r2.cuts, total: r2.total });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'ok' && near(w.T.h, head, 0.15), '如意逐集:h≈' + head, w.T.h);
    }

    // ---- 阶梯形(量子)----
    {
        // 轴 V≈30~85 +7.1、V≈90~730 +15.15、V≥830 +25.1:按总长算 Δ≈25
        const pieces = [{ t0: 7.1, dur: 85 }, { t0: 15.15 + 85, dur: 645 }, { t0: 25.1 + 730, dur: CLEAN_TOTAL - 25.1 - 730 }];
        const l = mkLine('lz', pieces);
        w = mkWorld({ own: l, refs: FIVE(), total: l.total });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'rej' && w.T.offset === 0, '量子阶梯:拒绝,不动', w.auto.last);
        // 头部能对上(提示窗口内),但第二锚点差得远:只有第二锚点拦得住
        const p2 = [{ t0: 50, dur: 1000 }, { t0: 1060, dur: CLEAN_TOTAL - 1060 }];
        const l2 = mkLine('lz', p2);
        w = mkWorld({ own: l2, refs: FIVE(), total: l2.total });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'rej' && w.auto.last.why === '第二锚点' && w.T.offset === 0, '头部 +50、后面 +60:第二锚点拒绝', w.auto.last);
        ok(near(w.auto.last.lag, 50, 0.15) && near(w.auto.last.lag2, 50, 3.2) && w.auto.last.r2 < 0.8, '第二锚点:窗口只有 ±3 秒,差 10 秒找不到,r<0.8', w.auto.last);
        // 差不到 1 秒:算对齐
        const p3 = [{ t0: 30, dur: 1000 }, { t0: 1030.6, dur: CLEAN_TOTAL - 1030.6 }];
        const l3 = mkLine('lz', p3);
        w = mkWorld({ own: l3, refs: FIVE(), total: l3.total });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'ok' && near(w.T.h, 30, 0.15), '后段只差 0.6 秒:算对齐,h 取头部', w.auto.last);
        // 差 2 秒:窗口里找得到但超 1 秒,拒绝
        const p4 = [{ t0: 30, dur: 1000 }, { t0: 1032, dur: CLEAN_TOTAL - 1032 }];
        const l4 = mkLine('lz', p4);
        w = mkWorld({ own: l4, refs: FIVE(), total: l4.total });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'rej' && near(w.auto.last.lag2, 32, 0.2) && w.T.offset === 0, '后段差 2 秒:|lag−h|>1 拒绝', w.auto.last);
    }

    // ---- 音频不一样 ----
    {
        const l = mkLine('ot', [{ t0: 120, dur: CLEAN_TOTAL - 120 }], { other: true });
        w = mkWorld({ own: l, refs: FIVE(), total: l.total });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'rej' && w.auto.last.why === '开头' && w.T.offset === 0, '音频对不上:r<0.8 拒绝', w.auto.last);
        ok(w.segReqs().length < 20, '开头就拒绝:不再下第二锚点', w.segReqs().length);
    }

    // ---- 提示窗口之外不接受 ----
    {
        const l = mkLine('ot', [{ t0: 120, dur: CLEAN_TOTAL - 150 }]);   // Δ=150,真值 120:差 30 秒超出 ±15
        w = mkWorld({ own: l, refs: FIVE(), total: l.total });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'rej' && w.T.offset === 0, '真值在提示窗口外:拒绝', w.auto.last);
    }

    // ---- 参考线路取片失败换下一条 / 都失败放弃 ----
    {
        const R2 = ruyi(120);
        w = mkWorld({ own: R2.line, refs: FIVE(), cuts: R2.cuts, total: R2.total });
        w.segFail.add('hn'); w.segFail.add('xl');
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'ok' && near(w.T.h, 120, 0.15) && w.auto.last.ref === 'sb', '前两条取片失败,换第三条', w.auto.last);
        w = mkWorld({ own: R2.line, refs: FIVE(), cuts: R2.cuts, total: R2.total });
        ['hn', 'xl', 'sb', 'gs', 'hy'].forEach(s => w.segFail.add(s));
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'fail' && w.T.offset === 0, '都失败:放弃,不动', w.auto.last);
        const r5 = JSON.parse(w.ls.getItem(DM_AUTO.STORE))['k:' + w.g.key];
        ok(r5 && r5.st === 'fail', '失败也记');
        // 再开一次(6 小时内)不再下载
        const before = w.reqs.length;
        w.token++; w.play();
        await w.settle();
        ok(w.reqs.length === before && w.auto.state === 'cache', '失败记录有效期内不重下', w.reqs.length - before);
        // 本线路分片失败
        w = mkWorld({ own: R2.line, refs: FIVE(), cuts: R2.cuts, total: R2.total });
        w.segFail.add('ruyi');
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'fail' && w.T.offset === 0, '本线路取片失败:放弃,不动', w.auto.last);
    }

    // ---- 凑不出众数 ----
    {
        const refs = [cleanLine('hn'), cleanLine('xl'), mkLine('sb', [{ t0: 0, dur: 2919.6 }]), mkLine('gs', [{ t0: 0, dur: 1000 }])];
        const R3 = ruyi(120);
        w = mkWorld({ own: R3.line, refs, cuts: R3.cuts, total: R3.total });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'fail' && w.segReqs().length === 0 && w.T.offset === 0, '不到 3 票:不下分片,不动', w.auto.last);
        // Worker 拉不到的线路不算票、不够换后面的
        const refs2 = [...FIVE(), cleanLine('aa'), cleanLine('ab')];
        w = mkWorld({ own: R3.line, refs: refs2, cuts: R3.cuts, total: R3.total });
        w.listFail.add('hn'); w.listFail.add('xl');
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'ok' && w.auto.last.votes === 5, 'Worker 拉不到的换后面的,凑够 5 份', w.auto.last);
    }

    // ---- 本线路清单和在播的不是一份 ----
    {
        const R4 = ruyi(120);
        const l = Object.assign({}, R4.line, { workerText: R4.line.workerText.replace('#EXTINF:4.000,', '#EXTINF:14.000,') });
        w = mkWorld({ own: l, refs: FIVE(), cuts: R4.cuts, total: R4.total });
        w.play();
        await w.settle();
        ok(w.auto.last.st === 'fail' && /对不上/.test(w.auto.last.why) && w.T.offset === 0, '本线路清单总长和在播的差 ≥1 秒:模板时间不可信,放弃', w.auto.last);
    }

    // ---- 不启用:来源、通道、直播… 一个请求都不发 ----
    const quiet = async (name, set, expectWhy, offset) => {
        const R5 = ruyi(120);
        const q = mkWorld({ own: R5.line, refs: FIVE(), cuts: R5.cuts, total: R5.total });
        set(q);
        q.play();
        ok(await q.settle(), name + ':流程结束');
        ok(q.reqs.length === 0, name + ':没有任何下载', q.reqs.slice(0, 3));
        ok(q.T.offset === (offset || 0) && q.T.h === 0, name + ':不移动');
        ok(q.auto.state === 'off' && (!expectWhy || expectWhy.test(q.auto.why)), name + ':记下原因', { state: q.auto.state, why: q.auto.why });
    };
    await quiet('腾讯来源', q => { q.src = 'qq'; }, /来源 qq/);
    await quiet('来源未知(老缓存)', q => { q.src = ''; }, /来源 未知/);
    await quiet('弹幕一直没到', q => { q.src = undefined; }, /没到/);
    await quiet('没有弹幕', q => { q.src = undefined; q.g.want = false; }, /没有弹幕/);
    await quiet('原生通道', q => { q.g.hls = null; }, /hls\.js/);
    await quiet('直播', q => { q.g.off = '直播'; }, /直播/);
    await quiet('没配 Worker', q => { q.g.proxy = false; }, /Worker/);
    await quiet('省流量', q => { q.g.saving = true; }, /省流量/);
    await quiet('片子太短', q => { q.g.total = 120; }, /太短/);
    await quiet('会话流量到顶', q => { q.A._mb = 3000; }, /上限/);
    await quiet('手动设过', q => { q.ls.setItem('donggua_dm_offset', JSON.stringify({ ['k:T|ruyi|29']: { v: 50, at: 1 } })); }, /手动/, 50);

    // ---- 门控 ----
    const gated = async (name, set, clear, expectStart) => {
        const R6 = ruyi(120);
        const q = mkWorld({ own: R6.line, refs: FIVE(), cuts: R6.cuts, total: R6.total });
        set(q);
        q.play();
        for (let i = 0; i < 500; i++) await tick();
        ok(q.reqs.length === 0, name + ':不开始', q.reqs.slice(0, 2));
        ok(q.auto.state === 'wait', name + ':还在等', q.auto.state);
        clear(q);
        await q.settle();
        ok(q.auto.last && q.auto.last.st === 'ok', name + ':条件满足后才开始', q.auto.last);
    };
    await gated('播放位置不到 10 秒', q => { q.g.currentTime = 9; }, q => { q.g.currentTime = 11; });
    await gated('暂停', q => { q.g.paused = true; }, q => { q.g.paused = false; });
    await gated('readyState<3', q => { q.g.readyState = 2; }, q => { q.g.readyState = 4; });
    await gated('前方缓冲不足 6 秒', q => { q.g.ahead = 5; }, q => { q.g.ahead = 8; });
    await gated('拖动中', q => { q.g.seeking = true; }, q => { q.g.seeking = false; });
    await gated('adCut 还在扫', q => { q.g.cutBusy = true; }, q => { q.g.cutBusy = false; });
    await gated('总长还没拿到', q => { q._t = q.g.total; q.g.total = 0; }, q => { q.g.total = q._t; });
    await gated('片头分析在跑(不抢带宽)', q => { q.A._busy = true; }, q => { q.A._busy = false; });
    await gated('afpOffline 还没初始化', q => { q.noAfp = true; }, q => { q.noAfp = false; });
    {
        // 连续稳 3 个 tick 才开始,片头分析先抢:每秒看一次的那边 10 秒一到就占上
        const R7 = ruyi(120);
        const q = mkWorld({ own: R7.line, refs: FIVE(), cuts: R7.cuts, total: R7.total });
        q.play();
        await q.settle();
        ok(q.firstAt === DM_AUTO.PLAY_MIN + DM_AUTO.CALM, '续看(currentTime 一上来就 >10)也要真的播过 10 秒才发第一个请求,起播阶段不抢带宽', q.firstAt);
        // 播过 10 秒之后才不稳过:恢复后连续稳 3 个 tick 就开始,片头分析(每秒看一次)先抢到就等它
        const R7b = ruyi(120);
        const q7 = mkWorld({ own: R7b.line, refs: FIVE(), cuts: R7b.cuts, total: R7b.total });
        q7.g.ahead = 2;
        q7.play();
        for (let i = 0; i < 60; i++) await tick();
        ok(q7.reqs.length === 0 && q7.sleeps > DM_AUTO.PLAY_MIN + 5, '缓冲不足时只等');
        const n7 = q7.sleeps;
        q7.g.ahead = 30;
        await q7.settle();
        ok(q7.firstAt - n7 >= DM_AUTO.CALM - 1 && q7.firstAt - n7 <= DM_AUTO.CALM + 1, '恢复后连续稳 ' + DM_AUTO.CALM + ' 秒才开始(片头分析优先)', q7.firstAt - n7);
    }

    // ---- 让路 ----
    {
        const R8 = ruyi(120);
        const q = mkWorld({ own: R8.line, refs: FIVE(), cuts: R8.cuts, total: R8.total });
        q.play();
        for (let i = 0; i < 2000 && !q.segReqs().length; i++) await tick();
        const n = q.segReqs().length;
        ok(n > 0, '让路:已开始下分片');
        q.player.video.readyState = 2;   // 真的 _fetchEnvRange 逐段看 dp.video
        q.g.readyState = 2;
        for (let i = 0; i < 300; i++) await tick();
        ok(q.segReqs().length <= n + 1, '让路:播放吃紧马上停(最多多一片在途)', q.segReqs().length - n);
        ok(q.A._busy === false, '让路:放开 _busy');
        ok(!q.auto.last, '让路:第一次不下结论');
        q.player.video.readyState = 4; q.g.readyState = 4;
        await q.settle();
        ok(q.auto.last && q.auto.last.st === 'ok' && near(q.T.h, 120, 0.15), '让路:恢复后接着做完', q.auto.last);

        const R9 = ruyi(120);
        const q2 = mkWorld({ own: R9.line, refs: FIVE(), cuts: R9.cuts, total: R9.total });
        q2.play();
        for (let i = 0; i < 2000 && !q2.segReqs().length; i++) await tick();
        q2.player.video.readyState = 2;
        for (let i = 0; i < 300; i++) await tick();
        q2.player.video.readyState = 4;
        for (let i = 0; i < 2000 && q2.segReqs().length < 4; i++) await tick();
        q2.player.video.readyState = 2;
        for (let i = 0; i < 300; i++) await tick();
        q2.player.video.readyState = 4;
        await q2.settle();
        ok(q2.auto.last && q2.auto.last.st === 'yield' && q2.T.offset === 0, '让路两次:这次放弃,记半小时', q2.auto.last);
    }

    // ---- 换集立刻中止,结果不写到新一集 ----
    {
        const R10 = ruyi(120);
        const q = mkWorld({ own: R10.line, refs: FIVE(), cuts: R10.cuts, total: R10.total });
        q.play();
        for (let i = 0; i < 2000 && !q.segReqs().length; i++) await tick();
        ok(q.A._busy === true && q.auto.state === 'measure', '换集:测量进行中');
        let release;
        q.hold = new Promise(r => { release = r; });   // 下一个请求挂住,模拟网慢
        for (let i = 0; i < 50; i++) await tick();
        const n = q.reqs.length;
        q.src = 'qq';   // 新一集不是芒果:新流程自己结束,下面看到的都是上一轮的动静
        q.token++; q.g.key = 'T|ruyi|30|f'; q.g.total = 2000;
        q.T.begin(q.token, 'T|ruyi|30', false);
        q.auto.begin(q.token);
        q.A._abort = true;   // play() 里也会设
        for (let i = 0; i < 20; i++) await tick();
        ok(q.A._busy === false, '换集:在途请求没回来也立刻放开 _busy');
        ok(q.T.h === 0 && q.T.offset === 0, '换集:h 立刻清零');
        ok(!q.ls.getItem(DM_AUTO.STORE), '换集:半截结果不落盘');
        release(); q.hold = null;
        await q.settle();
        ok(q.reqs.length <= n + 2, '换集:上一轮不再发新请求', q.reqs.length - n);
        ok(q.T.h === 0 && !q.ls.getItem(DM_AUTO.STORE), '换集:上一轮晚到的结果写不到新一集');
    }

    // ---- 关弹幕立刻中止,再开接着做 ----
    {
        const R11 = ruyi(120);
        const q = mkWorld({ own: R11.line, refs: FIVE(), cuts: R11.cuts, total: R11.total });
        q.play();
        for (let i = 0; i < 2000 && !q.segReqs().length; i++) await tick();
        const n = q.segReqs().length;
        q.player.danmaku.showing = false;
        q.auto.halt();
        for (let i = 0; i < 100; i++) await tick();
        ok(q.A._busy === false && q.segReqs().length <= n + 1 && !q.auto.last, '关弹幕:停下、放开、不下结论');
        for (let i = 0; i < 500; i++) await tick();
        ok(q.segReqs().length <= n + 1, '关弹幕:一直不下载');
        q.player.danmaku.showing = true;
        q.auto.wake();
        await q.settle();
        ok(q.auto.last && q.auto.last.st === 'ok' && near(q.T.h, 120, 0.15), '再开弹幕:接着做完', q.auto.last);
    }

    // ---- 手动 ----
    {
        const R12 = ruyi(120);
        const q = mkWorld({ own: R12.line, refs: FIVE(), cuts: R12.cuts, total: R12.total });
        q.play();
        for (let i = 0; i < 2000 && !q.segReqs().length; i++) await tick();
        q.T.setManual(30);
        for (let i = 0; i < 50; i++) await tick();
        ok(q.A._busy === false && q.T.offset === 30, '测量中手动调了:停下,手动值生效');
        await q.settle();
        ok(q.auto.state === 'off' && /手动/.test(q.auto.why), '测量中手动调了:这一集不再自动算', q.auto.why);
        const n = q.reqs.length;
        q.T.resetManual();
        ok(q.T.offset === 0, '重置回 h(还没算出来是 0)');
        await q.settle();
        ok(q.reqs.length > n && q.auto.last && q.auto.last.st === 'ok' && near(q.T.offset, 120, 0.15), '重置手动值后接着算', q.auto.last);

        // 手动设过、本机有记录:只记下 h,不生效,零下载
        const R13 = ruyi(120);
        const q2 = mkWorld({ own: R13.line, refs: FIVE(), cuts: R13.cuts, total: R13.total });
        q2.ls.setItem(DM_AUTO.STORE, JSON.stringify({ ['k:' + q2.g.key]: { st: 'ok', h: 120, dur: R13.total, at: q2.clock } }));
        q2.ls.setItem('donggua_dm_offset', JSON.stringify({ ['k:T|ruyi|29']: { v: 50, at: 1 } }));
        q2.play();
        await q2.settle();
        ok(q2.T.h === 120 && q2.T.offset === 50 && q2.reqs.length === 0, '手动优先:h 记下,不生效,零下载', { h: q2.T.h, off: q2.T.offset });
        q2.T.resetManual();
        ok(q2.T.offset === 120, '重置后回到 h');
    }

    // ---- 同一次播放换通道 ----
    {
        const R14 = ruyi(120);
        const q = mkWorld({ own: R14.line, refs: FIVE(), cuts: R14.cuts, total: R14.total });
        q.play();
        await q.settle();
        ok(near(q.T.offset, 120, 0.15), '换通道前 h≈120');
        ok(q.auto.onSwitch() === false, '同一个 hls 实例:不动');
        q.g.hls = {}; q.g.ch = 'r'; q.g.key = 'T|ruyi|29|r'; q.g.total = R14.line.total;
        ok(q.auto.onSwitch() === true && q.T.h === 0 && q.T.offset === 0, '换了 hls 实例:h 立刻作废');
        await q.settle();
        ok(q.auto.last && q.T.offset === 0, '换通道后重算(原始通道带着插播,总长不同 → 不套旧值)', q.auto.last);
    }

    // ---- 存储不可用:同一页不重下 ----
    {
        const R15 = ruyi(120);
        const q = mkWorld({ own: R15.line, refs: FIVE(), cuts: R15.cuts, total: R15.total });
        q.ls.getItem = (k) => { if (k === DM_AUTO.STORE) throw new Error('denied'); return null; };
        q.ls.setItem = () => { throw new Error('denied'); };
        q.play();
        await q.settle();
        ok(near(q.T.offset, 120, 0.15), '存储不可用:照常算');
        const n = q.reqs.length;
        q.token++; q.play();
        await q.settle();
        ok(q.reqs.length === n && q.auto.state === 'cache' && near(q.T.offset, 120, 0.15), '存储不可用:同一页靠内存不重下');
    }

    // ---- 主清单要跟到媒体清单 ----
    {
        const R16 = ruyi(120);
        const refs = FIVE();
        const q = mkWorld({ own: R16.line, refs, cuts: R16.cuts, total: R16.total });
        // 第一条参考线路:Worker 给主清单,子清单是 Worker 地址
        const media = refs[0].workerText;
        refs[0].workerText = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n' + WORKER + '/?url=' + encodeURIComponent('https://hn.test/ep/sub.m3u8') + '\n';
        const orig = q.A._resolveMedia.bind(q.A);
        let followed = 0;
        q.A._resolveMedia = async (u, F) => {
            const r = await orig(u, F);
            if (/hn\.test/.test(u) && /EXTINF/.test(r.text)) followed++;
            return r;
        };
        const w0 = q.A._fetchText.bind(q.A);
        q.A._fetchText = async (u, F) => {
            if (decodeURIComponent(u).includes('hn.test/ep/sub.m3u8')) { await F.playlist(u).then(r => r.text()); return media; }
            return w0(u, F);
        };
        q.play();
        await q.settle();
        ok(followed === 1 && q.auto.last.votes === 5, '主清单跟到媒体清单才算票', q.auto.last);
    }

    // ---- 真的 dmTime:起播后 h 到达不爆弹幕 ----
    {
        const R17 = ruyi(120);
        const q = mkWorld({ own: R17.line, refs: FIVE(), cuts: R17.cuts, total: R17.total });
        const dm = q.player.danmaku;
        q.player.video.currentTime = 30; q.g.currentTime = 30;
        q.play();
        dm.danIndex = 2;   // 播到 30 秒时读指针的位置
        await q.settle();
        ok(dm.dan[dm.danIndex].time >= 150 && dm.dan[dm.danIndex - 1].time < 150, 'h 到达:读指针跳到 currentTime+h,不把跳过的画出来', dm.danIndex);
        ok(dm.seeks === 1, 'h 到达:只对齐一次');
    }
}

console.log('③ 接线');
{
    ok(/_dmBackend\.src = \{ id, v: dmAutoSrcOf\(d\) \};/.test(HTML), '_dmBackend.read 把来源存在模块级变量');
    ok(/source\(\) \{ const s = _dmBackend\.src; return \(s && s\.id === _dmBackend\.want\) \? s\.v : undefined; \}/.test(HTML), '来源绑定当前要的这份弹幕');
    ok(!/this\.\w*[dD]mSrc/.test(HTML), '来源不进 Vue');
    const beginAt = HTML.indexOf('_dmTimeBegin() {');
    ok(beginAt > 0 && /dmAuto\.begin\(tok\)/.test(HTML.slice(beginAt, beginAt + 800)), '_dmTimeBegin 里 begin(两处令牌递增都走它)');
    const swAt = HTML.indexOf('_dpSwitchHls(url, danmakuOpt, type) {');
    ok(swAt > 0 && (HTML.slice(swAt, swAt + 1500).match(/dmAuto\.onSwitch\(\)/g) || []).length === 2, '_dpSwitchHls 两个出口都通知换通道');
    ok(/dp\.on\('danmaku_hide', \(\) => \{ try \{ dmAuto\.halt\(\); \} catch \(e\) \{ \} \}\)/.test(HTML), '关弹幕立刻停');
    ok(/closeDetail\(\) \{[\s\S]{0,800}?this\.closeFrameShare\(\); return; \}\n\s*try \{ dmAuto\.halt\(\); \} catch \(e\) \{ \}/.test(HTML), '关播放页立刻停');
    ok(/dp\.on\('danmaku_show', \(\) => \{ try \{ dmAuto\.wake\(\); \} catch \(e\) \{ \} \}\)/.test(HTML), '开弹幕接着算');
    ok(/RF0\.channel = 'f'/.test(HTML), '参考线路强制 Worker 通道');
    const core = grab('dg-dm-auto-core');
    ok(!/\/api\/intro/.test(core), '不用片头包络接口');
    ok(/A\._mkFetch\(vue\)/.test(core) && /A\._resolveMedia\(/.test(core) && /A\._segList\(/.test(core) && /A\._fetchEnvRange\(/.test(core) && /A\._p\.bind\(A\)/.test(core), '复用 afpOffline 的 _mkFetch / _resolveMedia / _segList / _fetchEnvRange / _p');
    ok(!/fetch\(/.test(core.replace(/_mkFetch\(/g, '').replace(/_fetchEnvRange\(/g, '').replace(/_fetchText\(/g, '')), '核心段不自己发请求');
    ok(!/document\.|window\.|localStorage/.test(core), '核心段不碰全局(都从 env 进来)');
    ok(/if \(!window\.afpOffline\) window\.afpOffline = \{/.test(HTML), 'afpOffline 还在原处');
    ok(/afp: \(\) => window\.afpOffline \|\| null/.test(HTML), 'afpOffline 没初始化时安全跳过');
}

console.log('④ 两个后端的来源字段');
{
    const srcOf = (f) => {
        const s = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\r\n').join('\n');
        const a = s.indexOf('const DANMAKU_SRC_HOSTS = '), b = s.indexOf('// ⛔ 以下联网', a);
        return a > 0 && b > a ? s.slice(a, b) : '';
    };
    const S = srcOf('server.js'), I = srcOf('api/index.js');
    ok(S && S === I, 'danmakuSourceOf 两后端逐字一致');
    const sourceOf = vm.runInNewContext(S + '\n;danmakuSourceOf', { URL });
    const cases = [
        [{ episodeTitle: '【imgo】 第1集', url: 'https://www.mgtv.com/b/1/2.html' }, 'imgo'],
        [{ episodeTitle: '第1集', url: 'https://www.mgtv.com/b/1/2.html' }, 'imgo'],
        [{ episodeTitle: '【imgo】 第1集' }, 'imgo'],
        [{ episodeTitle: '【qq】 第1集', url: 'https://v.qq.com/x/cover/a/b.html' }, 'qq'],
        [{ url: 'https://v.qq.com/x/cover/a/b.html' }, 'qq'],
        [{ episodeTitle: '【qiyi】 第1集', url: 'https://www.iqiyi.com/v_1.html' }, 'qiyi'],
        [{ episodeTitle: '【bilibili1】 第1集', url: 'https://www.bilibili.com/bangumi/play/ep1' }, 'bilibili'],
        [{ episodeTitle: '【migu】 《小巷人家》第01集', url: 'https://webapi.miguvideo.com/x' }, 'migu'],
        [{ episodeTitle: '【aiyifan】 第1集', url: 'https://www.yfsp.tv/play/1' }, 'aiyifan'],
        [{ episodeTitle: '【qq】 第1集', url: 'https://www.mgtv.com/b/1/2.html' }, ''],
        [{ episodeTitle: '第1集 【imgo】', url: '' }, ''],
        [{ episodeTitle: '第1集', url: 'tencent:abc<分隔>iqiyi:def' }, ''],
        [{ episodeTitle: '第1集', url: 'https://evil-mgtv.com/x' }, ''],
        [{}, ''], [null, ''],
    ];
    for (const [e, want] of cases) ok(sourceOf(e) === want, '来源 ' + JSON.stringify(e), sourceOf(e));

    const { createStore } = require(path.join(ROOT, 'lib/danmaku-store'));
    const st = createStore({ db: null });
    ok(st.toJson([[1]], undefined) === '{"code":0,"version":3,"data":[[1]],"msg":""}', '不传来源还是老格式');
    ok(JSON.parse(st.toJson([[1]], 'imgo')).src === 'imgo' && JSON.parse(st.toJson([[1]], '')).src === '', '传了就带(空串 = 查过但不确定)');
    st.put('a', [[1]]);
    ok(st.get('a').hasSrc === false, '没有来源字段的条目 hasSrc=false');
    st.put('b', [[1]], 'imgo');
    ok(st.get('b').hasSrc === true && JSON.parse(st.get('b').json).data.length === 1, '有来源字段的条目 hasSrc=true,内容不变');
    st.put('c', [[1]], '');
    ok(st.get('c').hasSrc === true, '查过但不确定也不算老条目(不反复重抓)');

    // —— 真跑两个后端 + 假 danmu_api ——
    const mock = { search: 0, comment: 0, fail: new Set(), many: 0, noUrl: false, empty: false };
    const eps = (plat, name) => [1, 2, 3].map(n => ({ episodeId: 1000 + n, episodeTitle: '【' + plat + '】 第' + n + '集', url: (plat === 'imgo' ? 'https://www.mgtv.com/b/' : 'https://v.qq.com/x/cover/') + encodeURIComponent(name) + '/' + n + '.html' }));
    const upstream = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        res.setHeader('Content-Type', 'application/json');
        if (u.pathname === '/tk/api/v2/search/episodes') {
            mock.search++;
            const anime = u.searchParams.get('anime') || '';
            if (anime === '沾边剧') return res.end(JSON.stringify({ animes: [{ animeTitle: '沾边剧风云再起(2024)【电视剧】from 360', episodes: eps('imgo', anime) }] }));
            if (anime === '双平台') return res.end(JSON.stringify({ animes: [{ animeTitle: '双平台(2024)【电视剧】from tencent', episodes: eps('qq', anime) }, { animeTitle: '双平台(2024)【电视剧】from imgo', episodes: eps('imgo', anime) }] }));
            const plat = /腾讯/.test(anime) ? 'qq' : 'imgo';
            return res.end(JSON.stringify({ animes: [{ animeTitle: anime + '(2024)【电视剧】from 360', episodes: eps(plat, anime) }] }));
        }
        if (u.pathname === '/tk/api/v2/comment') {
            const url = u.searchParams.get('url') || '';
            if (mock.noUrl || !url) { res.statusCode = 400; return res.end(JSON.stringify({ errorCode: 400, errorMessage: 'Missing commentId or url parameter' })); }
            if (mock.fail.has(new URL(url).hostname)) { res.statusCode = 500; return res.end('{}'); }
            mock.comment++;
            const n = mock.empty ? 0 : (mock.many || 50);
            return res.end(JSON.stringify({ count: n, comments: Array.from({ length: n }, (_, i) => ({ p: `${i},1,16777215,[x]`, m: 'c' + i })) }));
        }
        if (/^\/tk\/api\/v2\/comment\/\d+$/.test(u.pathname)) {
            mock.comment++;
            const n = mock.empty ? 0 : 5;
            return res.end(JSON.stringify({ count: n, comments: Array.from({ length: n }, (_, i) => ({ p: `${i},1,16777215,[x]`, m: 'id' + i })) }));
        }
        res.statusCode = 404; res.end('{}');
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-auto-'));
    fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
    fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'api'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'api/index.js'), path.join(tmp, 'api/index.js'));
    for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));
    const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
    const ENV = { NODE_PATH, DANMU_API_URL: 'http://127.0.0.1:' + upPort, DANMU_API_TOKEN: 'tk', ACCESS_PASSWORD: '', ADMIN_TOKEN: '', LIVE_TV_DISABLED: '1', KAZUMI_DISABLE: '1', CORS_PROXY_URL: '', REMOTE_DB_URL: '', DANMU_API_SINGLE_INSTANCE: '' };
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
        const r = await fetch(`http://127.0.0.1:${port}/api/danmaku/v3/?id=${encodeURIComponent(id)}`);
        const j = await r.json();
        return { j, src: j.src, n: (j.data || []).length, first: j.data && j.data[0] && j.data[0][4], cc: r.headers.get('cache-control') || '' };
    };
    const SERVER = () => ['server.js'], API = (p) => ['-e', `require('./api/index.js').listen(${p})`];
    const both = async (name, launch, probe, extra) => {
        mock.fail.clear(); mock.many = 0; mock.noUrl = false; mock.empty = false;
        await start(launch, extra, probe);
        let a = await get('芒果剧|第1集|v5|k:tv|y:2024|n:3');
        ok(a.n === 50 && a.src === 'imgo' && /max-age=604800/.test(a.cc), name + ':芒果 → src=imgo,长缓存', { src: a.src, cc: a.cc });
        const c0 = mock.comment;
        a = await get('芒果剧|第1集|v5|k:tv|y:2024|n:3');
        ok(a.src === 'imgo' && mock.comment === c0, name + ':命中缓存来源还在,不回源', a.src);
        a = await get('腾讯剧|第1集|v5|k:tv|y:2024|n:3');
        ok(a.src === 'qq', name + ':腾讯 → src=qq', a.src);
        a = await get('沾边剧|第1集|v5');
        ok(a.n > 0 && a.src === '' && /max-age=600\b/.test(a.cc), name + ':低置信不给来源', { src: a.src, cc: a.cc });
        a = await get('沾边剧|第1集|v5');
        ok(a.n > 0 && a.src === '', name + ':低置信命中内存缓存也不给', a.src);
        mock.many = 13000;
        a = await get('采样剧|第1集|v5|k:tv|y:2024|n:3');
        ok(a.n === 12000 && a.src === 'imgo', name + ':超上限采样后来源还在', { n: a.n, src: a.src });
        mock.many = 0;
        mock.fail.add('v.qq.com');
        a = await get('双平台|第1集|v5|k:tv|y:2024|n:3');
        ok(a.n > 0 && a.src === '', name + ':前面的候选瞬时失败、后面顶上 = 低置信,来源不作数', { n: a.n, src: a.src });
        mock.fail.clear();
        mock.noUrl = true;
        a = await get('按号剧|第1集|v5|k:tv|y:2024|n:3');
        ok(a.n > 0 && a.src === '' && /no-store/.test(a.cc), name + ':按 id 取的不给来源', { src: a.src, cc: a.cc });
        mock.noUrl = false;
        mock.empty = true;
        a = await get('空弹幕剧|第1集|v5|k:tv|y:2024|n:3');
        ok(a.n === 0 && !a.src && /no-store/.test(a.cc), name + ':空弹幕没有来源', { src: a.src });
        mock.empty = false;
        await stop();
    };
    try {
        await both('server.js', SERVER, '/api/debug');
        await both('api/index.js', API, '/api/danmaku/v3/');

        // —— 老条目(server.js 持久层):照常回、提前重抓、期间不给长缓存;不作废 ——
        const Database = dep('better-sqlite3');
        const zlib = require('node:zlib');
        const legacyJson = JSON.stringify({ code: 0, version: 3, data: [[1, 0, 16777215, '', 'old']], msg: '' });
        const dbPath = path.join(tmp, 'cache.db');
        await start(SERVER, null, '/api/debug');
        await stop();
        const putLegacy = (key) => {
            const db = new Database(dbPath);
            db.prepare('INSERT OR REPLACE INTO danmaku_store (k, gz, n, bytes, fetched_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)').run('m1|' + key, zlib.gzipSync(Buffer.from(legacyJson)), 1, 10, Date.now(), Date.now());
            db.close();
        };
        putLegacy('老条目剧|第1集|k:tv|y:2024');
        putLegacy('老条目空|第1集|k:tv|y:2024');
        await start(SERVER, null, '/api/debug');
        const cBefore = mock.comment;
        let a = await get('老条目剧|第1集|v5|k:tv|y:2024|n:3');
        ok(a.n === 1 && a.first === 'old' && a.src === undefined, '老条目:先回旧弹幕,没有来源字段(前端按未知)', { first: a.first, src: a.src });
        ok(/max-age=600\b/.test(a.cc) && !/604800/.test(a.cc), '老条目:不给 7 天缓存头,别被 CDN 再钉一周', a.cc);
        for (let i = 0; i < 50 && mock.comment === cBefore; i++) await sleep(50);
        await sleep(100);
        ok(mock.comment === cBefore + 1, '老条目:提前后台重抓一次');
        a = await get('老条目剧|第1集|v5|k:tv|y:2024|n:3');
        ok(a.n === 50 && a.src === 'imgo' && /max-age=604800/.test(a.cc), '老条目:重抓后带上来源,恢复长缓存', { src: a.src, cc: a.cc });
        mock.empty = true;
        const s0 = mock.search;
        a = await get('老条目空|第1集|v5|k:tv|y:2024|n:3');
        ok(a.first === 'old', '老条目重抓拿到空:先回旧的');
        await sleep(4500);
        a = await get('老条目空|第1集|v5|k:tv|y:2024|n:3');
        ok(a.first === 'old' && a.n === 1, '老条目重抓拿到空:不冲掉旧弹幕');
        const s1 = mock.search;
        await get('老条目空|第1集|v5|k:tv|y:2024|n:3');
        await sleep(200);
        ok(s1 > s0 && mock.search === s1, '老条目重抓失败:一小时内不再试');
        mock.empty = false;
        await stop();
        // 限速:一分钟最多提前重抓 30 集
        const db2 = new Database(dbPath);
        const ins = db2.prepare('INSERT OR REPLACE INTO danmaku_store (k, gz, n, bytes, fetched_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (let i = 0; i < 40; i++) ins.run('m1|限速剧' + i + '|第1集|k:tv|y:2024', zlib.gzipSync(Buffer.from(legacyJson)), 1, 10, Date.now(), Date.now());
        db2.close();
        await start(SERVER, null, '/api/debug');
        const s2 = mock.search;
        for (let i = 0; i < 40; i++) await get('限速剧' + i + '|第1集|v5|k:tv|y:2024|n:3');
        await sleep(600);
        ok(mock.search - s2 === 30, '老条目提前重抓每分钟最多 30 集', mock.search - s2);
        await stop();
    } catch (e) {
        fail++; console.log('  ✗ 异常: ' + (e && e.stack || e));
    } finally {
        await stop();
        upstream.close();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
    }
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
