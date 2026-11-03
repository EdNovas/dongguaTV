#!/usr/bin/env node
// 弹幕时间映射与手动偏移回归(离线、零网络):
//   node scripts/danmaku-offset-test.mjs
//  ① DPlayer.min.js 的前提:frame / seek / send 都读 options.time(),reload / switchVideo 不碰它(升级改了就先报)
//  ② <dg-dm-time-core> 在沙箱里真跑,判定核心用真的 ad-clip-core.js、弹幕模块用 DPlayer 同样的 seek / frame 语义:
//     单调、落在组内冻结、多组累计、不重复扣已剪的段(含 95 集真实如意清单)、手动偏移方向和范围、异常回退、
//     换会话清零(复用实例 / 新建实例 / 后来才有弹幕模块 / 直播)、起播前列表到达不爆弹幕、同集换线到偏移更大的线路不爆弹幕、存储上限、片名是 constructor / __proto__
//  ③ 接线:play() 两处令牌递增后 begin、新建播放器时 install、列表到达看弹幕时间、设置面板和手机菜单行
// 改弹幕时间、插播判定状态、DPlayer 版本后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const DPJS = fs.readFileSync(path.join(ROOT, 'public/libs/js/DPlayer.min.js'), 'utf8');
const C = require(path.join(ROOT, 'public/libs/js/ad-clip-core.js'));
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('① DPlayer 的前提');
{
    ok(DPJS.includes('time:function(){return a.video.currentTime}'), '弹幕时间默认取 video.currentTime(挂在 danmaku.options.time 上)');
    ok(DPJS.includes('t&&this.options.time()>parseFloat(t.time)'), 'frame 按 options.time() 比较');
    ok(DPJS.includes('this.dan[e].time>=this.options.time()'), 'seek 按 options.time() 对齐');
    ok(DPJS.includes('time:this.options.time(),text:e.text'), 'send 自己发的弹幕也记 options.time()');
    ok(DPJS.includes('key:"reload",value:function(e){this.options.api=e,this.dan=[],this.clear(),this.load()}'), 'reload 只换 api,options.time 留着(复用实例靠这个)');
    ok(DPJS.includes('this.danmaku&&this.danmaku.reload({id:t.id'), 'switchVideo 走 danmaku.reload,不重建弹幕模块');
    ok(/key:"clear",value:function\(\)\{this\.danTunnel=[^;]*?this\.danIndex=0/.test(DPJS), 'clear 把读指针归零(列表到达时读指针在 0)');
    ok(/t\.dan=\[\]\.concat\.apply\(\[\],e\)\.sort/.test(DPJS), 'load 只换列表,不动读指针');
    ok(typeof C.planCuts === 'function' && typeof C.toCutTime === 'function', 'ad-clip-core 有 planCuts / toCutTime');
}

const grab = (name) => {
    const m = new RegExp('// <' + name + '>\\n([\\s\\S]*?)\\n\\s*// </' + name + '>').exec(HTML);
    if (!m) { console.log('✗ index.html 里找不到 <' + name + '> 段'); process.exit(1); }
    return m[1];
};
const RESYNC = grab('dg-dm-resync-core'), CORE = grab('dg-dm-time-core');
const X = vm.runInNewContext(RESYNC + '\n' + CORE + `
;({ dmPointerOff, dmResync, dmStripAds, dmAdRuns, dmAdSig, dmOffClamp, dmOffGet, dmOffPut, dmOffText, dmAlignAfterLoad, dmTimeCreate, DM_OFF_STORE, DM_OFF_CAP, DM_OFF_MAX });`);
const { dmResync, dmStripAds, dmAdRuns, dmOffClamp, dmOffGet, dmOffPut, dmOffText, dmAlignAfterLoad, dmTimeCreate, DM_OFF_STORE, DM_OFF_CAP, DM_OFF_MAX } = X;

// 弹幕模块:seek / frame 照 DPlayer 的语义写;options.time 默认读 video.currentTime
const makeVideo = () => {
    const L = {};
    return { currentTime: 0, readyState: 4, seeking: false, addEventListener(k, f) { (L[k] = L[k] || []).push(f); }, fire(k) { (L[k] || []).forEach(f => f()); }, count: k => (L[k] || []).length };
};
const makePlayer = (times) => {
    const video = makeVideo();
    const dm = {
        dan: (times || []).map(t => ({ time: t })), danIndex: 0, drawn: [], clears: 0,
        options: { time: () => player.video.currentTime },
        clear() { this.danIndex = 0; this.clears++; },
        seek() {
            this.clear();
            for (let e = 0; e < this.dan.length; e++) {
                if (this.dan[e].time >= this.options.time()) { this.danIndex = e; break; }
                this.danIndex = this.dan.length;
            }
        },
        frame() {
            let t = this.dan[this.danIndex];
            const out = [];
            while (t && this.options.time() > parseFloat(t.time)) { out.push(t.time); t = this.dan[++this.danIndex]; }
            this.drawn.push(...out);
            return out;
        },
        // DPlayer 的 reload:只换列表、清屏(读指针归零),options.time 不动
        reload(times2) { this.dan = []; this.clear(); this.pending = times2; },
        loaded() { this.dan = this.pending.map(t => ({ time: t })); },
    };
    const player = { video, danmaku: dm };
    return player;
};
const makeStore = (init) => {
    const m = Object.assign(Object.create(null), init);
    return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, raw: m };
};
// 一个 dmTime + 假环境
const makeEnv = (over) => {
    const e = {
        cur: null, ad: null, views: [], store_: makeStore(),
        player: () => e.cur,
        store: () => e.store_,
        adCore: () => C,
        adOpt: () => null,
        adState: () => e.ad,
        render: v => { e.views.push(v); },
    };
    Object.assign(e, over);
    e.t = dmTimeCreate(e);
    return e;
};
const everySecond = Array.from({ length: 4000 }, (_, i) => i);

// 真实形状的清单状态:groups + res + off + skipped + overrides
const makeState = (rows) => {
    // rows = [[时长, 分辨率, 首帧 PTS]...]
    const frags = [];
    let t = 0;
    rows.forEach((r, i) => { frags.push({ sn: i, cc: i, start: t, duration: r[0] }); t += r[0]; });
    const groups = C.groupsFromFrags(frags);
    const st = { groups, res: Object.create(null), off: Object.create(null), skipped: Object.create(null), overrides: Object.create(null) };
    rows.forEach((r, i) => { if (r[1]) st.res[i] = r[1]; if (r[2] != null) st.off[i] = r[2] - groups[i].start; });
    return st;
};
// 如意第 29 集的形状(调查报告实测):正片 1280x674 每组 20 秒、首帧 PTS = 时间 + 1.48;V=625~645 插播 1280x720、PTS 从 1.48 重启;之后正片时钟不计插播
const ruyi = () => {
    const rows = [];
    let v = 0, adSeen = 0;
    while (v < 625) { rows.push([Math.min(20, 625 - v), '1280x674', v + 1.48]); v += Math.min(20, 625 - v); }
    rows.push([20, '1280x720', 1.48]); v += 20; adSeen += 20;
    while (v < 2843.8) { const d = Math.min(20, 2843.8 - v); rows.push([d, '1280x674', v - adSeen + 1.48]); v += d; }
    rows.push([12.16, '1280x720', 1.48]);
    return makeState(rows);
};

console.log('② 时间映射:单调、冻结、累计');
{
    ok(dmStripAds(100, []) === 100, '没有插播:原样');
    const runs = [100, 120, 300, 310, 500, 540];
    ok(dmStripAds(99, runs) === 99, '第一段之前不扣');
    ok(dmStripAds(100, runs) === 100 && dmStripAds(110, runs) === 100 && dmStripAds(119.99, runs) === 100, '落在组内:停在组起点');
    ok(dmStripAds(120, runs) === 100, '组尾和组起点接得上');
    ok(dmStripAds(200, runs) === 180, '过了第一段:扣 20');
    ok(dmStripAds(305, runs) === 280, '第二段内:停在 300-20');
    ok(dmStripAds(400, runs) === 370, '过了第二段:扣 30');
    ok(dmStripAds(520, runs) === 470, '第三段内:停在 500-30');
    ok(dmStripAds(600, runs) === 530, '三段都过:扣 70');
    let mono = true, prev = -Infinity;
    for (let t = 0; t < 700; t += 0.07) { const x = dmStripAds(t, runs); if (x < prev - 1e-9) mono = false; prev = x; }
    ok(mono, '全程单调不减');

    // 有偏移、负向偏移也单调
    const e = makeEnv(), p = makePlayer();
    e.cur = p; e.t.begin(1, 'a|b|1', false);
    e.t.runs = runs;
    for (const off of [120, -30]) {
        e.t.offset = off;
        let m = true, last = -Infinity;
        for (let t = 0; t < 700; t += 0.13) { const x = p.danmaku.options.time.call(null, (p.video.currentTime = t)); if (x < last - 1e-9) m = false; last = x; }
        ok(m, '偏移 ' + off + ':全程单调不减');
    }
    e.t.offset = -30; p.video.currentTime = 10;
    ok(p.danmaku.options.time() === 0, '负向偏移算出负数按 0 封底', p.danmaku.options.time());
}

console.log('③ 插播段来自 adClipSkip 的状态,不另起判定');
{
    const st = ruyi();
    const r = dmAdRuns(st, C, null);
    ok(r.length === 4 && near(r[0], 625) && near(r[1], 645) && near(r[2], 2843.8, 1e-3) && near(r[3], 2855.96, 1e-3), '如意 ep29 形状:中插 625~645 + 片尾 12.16 秒,同一套 planCuts 判出来', r);
    ok(near(dmStripAds(1220, r), 1200), '如意未剪轴 V=1220 → 去插播后 1200(报告实测:这句台词在 P≈1200)', dmStripAds(1220, r));
    ok(near(dmStripAds(645.1, r), 625.1) && near(dmStripAds(630, r), 625), '段后接上、段内冻结');

    // 还没判到的(右边未知)不算;知道了才算
    const partial = ruyi();
    delete partial.res[Object.keys(partial.res).find(k => partial.groups[k].start >= 645)];
    ok(dmAdRuns(partial, C, null).length === 0 || !near(dmAdRuns(partial, C, null)[0], 625), '插播后面一组还没解析:planCuts 判 wait,不扣');

    // 自动跳过的:check 记在 st.skipped(左侧未知时 planCuts 判不出,也要算)
    const a = ruyi();
    Object.keys(a.res).forEach(k => { if (a.groups[k].start < 625 && a.groups[k].start > 0) { delete a.res[k]; delete a.off[k]; } });
    const adIdx = a.groups.findIndex(g => near(g.start, 625));
    ok(dmAdRuns(a, C, null).every(x => !near(x, 625)), '左侧未知:planCuts 不判');
    a.skipped[adIdx] = [adIdx];
    const ra = dmAdRuns(a, C, null);
    ok(near(ra[0], 625) && near(ra[1], 645), '自动跳过的组(st.skipped)要扣', ra);
    // 放弃跳过照常播的:st.overrides
    const b = ruyi();
    Object.keys(b.res).forEach(k => { if (b.groups[k].start < 625 && b.groups[k].start > 0) { delete b.res[k]; delete b.off[k]; } });
    b.overrides[adIdx] = 1;
    const rb = dmAdRuns(b, C, null);
    ok(near(rb[0], 625) && near(rb[1], 645), '放弃跳过照常播的组(st.overrides)也要扣', rb);
    // 用户拖过去的:check 没轮到(skipped 空),但加载过 → planCuts 能判
    const c = ruyi();
    ok(!Object.keys(c.skipped).length && near(dmAdRuns(c, C, null)[0], 625), '用户拖过去、check 没轮到的组也要扣');
    // 没加载过的组:不知道
    const d = ruyi();
    d.res[adIdx] = undefined; d.off[adIdx] = undefined;
    delete d.res[adIdx]; delete d.off[adIdx];
    ok(dmAdRuns(d, C, null).every(x => !near(x, 625)), '拖过去但没加载过的组:判不出,不扣(不为它多发请求)');

    // 相邻组并成一段;同时被 planCuts 和 skipped 标到不重复算
    const e = ruyi();
    e.skipped[adIdx] = [adIdx];
    const re = dmAdRuns(e, C, null);
    ok(re.length === 4 && near(dmStripAds(1000, re), 980), 'planCuts 和 st.skipped 都标到同一组:只扣一次', re);
    const g2 = makeState([[100, '1x1', 1], [10, '1x1', 1], [10, '1x1', 1], [100, '1x1', 1]]);
    g2.skipped[1] = [1, 2]; g2.skipped[2] = [1, 2];
    ok(JSON.stringify(dmAdRuns(g2, null, null)) === '[100,120]', '相邻组并成一段', dmAdRuns(g2, null, null));
    // 活 Fragment 的 start 漂了:压到的部分不重复算
    const g3 = { groups: [{ cc: 0, start: 0, end: 100 }, { cc: 1, start: 100, end: 120 }, { cc: 2, start: 119.5, end: 200 }, { cc: 3, start: 200, end: 210 }], res: {}, off: {}, skipped: { 1: [1], 3: [3] }, overrides: {} };
    ok(JSON.stringify(dmAdRuns(g3, null, null)) === '[100,120,200,210]', '段之间正常');
    g3.groups[1].end = 120.4; g3.skipped[2] = [2]; g3.groups[2].end = 200; g3.groups[3].start = 199.8;
    const r3 = dmAdRuns(g3, null, null);
    let m3 = true, p3 = -Infinity;
    for (let t = 0; t < 230; t += 0.05) { const x = dmStripAds(t, r3); if (x < p3 - 1e-9) m3 = false; p3 = x; }
    ok(m3, '组边界压了一点也单调', r3);
    // planCuts 抛异常:只留 skipped
    const boom = ruyi();
    boom.skipped[adIdx] = [adIdx];
    const rb2 = dmAdRuns(boom, { planCuts() { throw new Error('x'); } }, null);
    ok(rb2.length === 2 && near(rb2[0], 625), '判定核心出错:已跳过的还算');
    ok(dmAdRuns(null, C, null).length === 0 && dmAdRuns({ groups: [] }, C, null).length === 0, '没有状态:空');
}

console.log('④ 不重复扣 adCut 剪掉的段');
{
    // 真实流程:原清单 → planCuts → cutPlaylist → 剪后清单就是 hls.js / 原生通道的 st.groups
    let text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:20\n#EXT-X-PLAYLIST-TYPE:VOD\n';
    const st0 = ruyi();
    st0.groups.forEach((g, i) => { if (i) text += '#EXT-X-DISCONTINUITY\n'; text += '#EXTINF:' + g.dur + ',\nseg' + i + '.ts\n'; });
    text += '#EXT-X-ENDLIST\n';
    const base = 'https://x.test/a/index.m3u8';
    const p = C.parseMedia(text, base);
    const cuts = C.planCuts(p.groups, cc => st0.res[cc], null, { offOf: cc => st0.off[cc] });
    ok(cuts.length === 2, '原清单判出 2 段', cuts.length);
    const cc = [];
    cuts.forEach(c => { for (let k = c.cc0; k <= c.cc1; k++) cc.push(k); });
    const cutText = C.cutPlaylist(text, base, cc).text;
    const q = C.parseMedia(cutText, base);
    // 剪后的状态:每组 res 不变,偏移 = PTS - 剪后时间
    const stP = { groups: q.groups, res: Object.create(null), off: Object.create(null), skipped: Object.create(null), overrides: Object.create(null) };
    let oi = 0;
    q.groups.forEach((g) => {
        while (cc.includes(oi)) oi++;
        stP.res[g.cc] = st0.res[oi];
        stP.off[g.cc] = st0.off[oi] + st0.groups[oi].start - g.start;
        oi++;
    });
    const runsP = dmAdRuns(stP, C, null);
    ok(runsP.length === 0, '剪后时间轴上已经没有被剪的组:一秒都不扣', runsP);
    const e = makeEnv(), pl = makePlayer(); e.cur = pl; e.t.begin(1, 'k', false); e.ad = stP;
    pl.video.currentTime = 1200; e.t.refresh(pl);
    ok(pl.danmaku.options.time() === 1200, 'P 轴上弹幕时间就是 currentTime(不用 _cutToBase,否则多扣 20 秒)', pl.danmaku.options.time());
    e.t.setManual(120);
    ok(pl.danmaku.options.time() === 1320, '如意:手动 +120 后 P=1200 → 弹幕时间 1320,正好是红牛基准上这句台词的位置', pl.danmaku.options.time());
    // 没剪(扫描超时交原样清单):同一段由映射扣掉,结果和剪后一致
    const runsV = dmAdRuns(st0, C, null);
    let same = true;
    for (let v = 0; v < 2843; v += 3.7) { const inAd = v >= 625 && v < 645; if (!inAd && !near(dmStripAds(v, runsV), C.toCutTime(v, cuts), 1e-6)) same = false; }
    ok(same, '原时间轴上扣完 = 剪后时间轴(两条路殊途同归)');
    ok(!/_cutToBase|_cutToPlay|fromCutTime|_activeCut/.test(CORE), '核心里不用 _cutToBase 这类换算');

    // 95 集真实如意清单:逐组真实分辨率和 PTS,映射 = 真实剪段换算;剪后状态不再扣
    const JK = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/jackie-rycj.json'), 'utf8')).episodes;
    let bad = [], pBad = [];
    for (const ep of JK) {
        const frags = [];
        let t = 0, sn = 0;
        for (const [cc2, ds] of ep.g) for (const d of String(ds).split(',').map(Number)) { frags.push({ sn: sn++, cc: cc2, start: t, duration: d }); t += d; }
        const groups = C.groupsFromFrags(frags);
        const st = { groups, res: Object.create(null), off: Object.create(null), skipped: Object.create(null), overrides: Object.create(null) };
        groups.forEach((g, i) => {
            const ad = ep.ads.find(x => Math.abs(x.start - g.start) < 0.05);
            st.res[g.cc] = ad ? ad.res : ep.main;
            st.off[g.cc] = ep.off[i];
        });
        const runs = dmAdRuns(st, C, null);
        const flat = ep.ads.map(a => [a.start, a.start + a.dur]).flat();
        if (runs.length !== flat.length || runs.some((x, i) => !near(x, flat[i], 0.05))) bad.push(ep.key);
        // 剪后状态
        const drop = new Set();
        groups.forEach(g => { if (ep.ads.some(x => Math.abs(x.start - g.start) < 0.05)) drop.add(g.cc); });
        const fr2 = [];
        let t2 = 0, sn2 = 0;
        const off2 = Object.create(null), res2 = Object.create(null);
        groups.forEach((g, i) => {
            if (drop.has(g.cc)) return;
            off2[g.cc] = ep.off[i] + g.start - t2;
            res2[g.cc] = ep.main;
            for (let k = 0; k < g.n; k++) { const f = frags[g.sn0 + k]; fr2.push({ sn: sn2++, cc: g.cc, start: t2, duration: f.duration }); t2 += f.duration; }
        });
        const stP2 = { groups: C.groupsFromFrags(fr2), res: res2, off: off2, skipped: Object.create(null), overrides: Object.create(null) };
        if (dmAdRuns(stP2, C, null).length) pBad.push(ep.key);
    }
    ok(!bad.length, '95 集:插播段和逐类确认过的广告一一对应', bad.slice(0, 5));
    ok(!pBad.length, '95 集:剪后时间轴上没有任何组再被扣', pBad.slice(0, 5));
}

console.log('⑤ 手动偏移:方向、范围、覆盖自动值');
{
    const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
    e.t.begin(1, '剧|线路|第1集', false);
    p.video.currentTime = 100.5;
    ok(p.danmaku.options.time() === 100.5, '没调过:弹幕时间 = 当前时间');
    p.danmaku.frame(); p.danmaku.drawn = [];
    // 提前:弹幕更早出现 = 弹幕时间加正数
    e.t.step(10);
    ok(p.danmaku.options.time() === 110.5, '提前 10 秒:弹幕时间加 10');
    ok(p.danmaku.clears === 1, '手动偏移变化:对齐一次');
    p.video.currentTime = 101.5; p.danmaku.frame();
    ok(p.danmaku.drawn.join() === '111', '提前 10 秒:数据时间 111 的弹幕在画面 101.5 秒时出现,比原来早 10 秒', p.danmaku.drawn);
    ok(e.views[e.views.length - 1].text === '弹幕提前 10 秒', '文案和方向一致', e.views[e.views.length - 1]);
    p.danmaku.drawn = [];
    e.t.step(-20);
    ok(p.danmaku.options.time() === 91.5, '推后:弹幕时间减');
    ok(e.views[e.views.length - 1].text === '弹幕推后 10 秒', '推后文案', e.views[e.views.length - 1]);
    p.video.currentTime = 92.5; p.danmaku.frame();
    ok(p.danmaku.drawn.length === 0, '推后 10 秒:画面 92.5 秒时数据时间 92 的弹幕还不出现', p.danmaku.drawn);
    p.video.currentTime = 102.5; p.danmaku.frame();
    ok(p.danmaku.drawn.join() === '92', '推后 10 秒:数据时间 92 的弹幕在画面 102.5 秒才出现,比原来晚 10 秒', p.danmaku.drawn);
    ok(dmOffText(12) === '弹幕提前 12 秒' && dmOffText(-12) === '弹幕推后 12 秒' && dmOffText(0) === '未调整' && dmOffText(null) === '未调整', '文案');
    ok(dmOffText(119.96) === '弹幕提前 120 秒', '小数显示四舍五入', dmOffText(119.96));

    // 12 下调到 120
    const e2 = makeEnv(), p2 = makePlayer(); e2.cur = p2; e2.t.begin(1, 'k', false);
    for (let i = 0; i < 12; i++) e2.t.step(10);
    ok(e2.t.offset === 120, '+10 按 12 下到 120 秒', e2.t.offset);

    // 范围
    for (let i = 0; i < 100; i++) e2.t.step(10);
    ok(e2.t.offset === DM_OFF_MAX && DM_OFF_MAX === 600, '上限 +600', e2.t.offset);
    for (let i = 0; i < 200; i++) e2.t.step(-10);
    ok(e2.t.offset === -600, '下限 -600', e2.t.offset);
    ok(dmOffClamp('abc') === 0 && dmOffClamp(NaN) === 0 && dmOffClamp(Infinity) === 0 && dmOffClamp(1e9) === 600 && dmOffClamp(-1e9) === -600, '非法值');

    // 覆盖自动值
    const e3 = makeEnv(), p3 = makePlayer(); e3.cur = p3; e3.t.begin(5, 'k', false);
    ok(e3.t.h === 0 && e3.t.offset === 0, 'h 这一版恒为 0');
    const c0 = p3.danmaku.clears;
    ok(e3.t.setAuto(120, 5) === true && e3.t.offset === 120 && p3.danmaku.clears === c0 + 1, '自动值生效并对齐');
    ok(e3.t.setAuto(99, 4) === false && e3.t.offset === 120, '别的播放会话的自动值不要');
    e3.t.step(1);
    ok(e3.t.manual === 121 && e3.t.offset === 121, '手动调整从当前有效值起步(覆盖,不叠加)', [e3.t.manual, e3.t.offset]);
    const c1 = p3.danmaku.clears;
    e3.t.setAuto(200, 5);
    ok(e3.t.offset === 121 && p3.danmaku.clears === c1 && e3.t.h === 200, '手动设过:后来的自动值只记下,不生效,不清屏');
    e3.t.setManual(0);
    ok(e3.t.offset === 0 && e3.t.manual === 0, '手动设成 0 也算设过,压过自动值');
    e3.t.resetManual();
    ok(e3.t.manual === null && e3.t.offset === 200, '重置:回到自动值');
    ok(e3.views[e3.views.length - 1].canReset === false, '重置后不能再重置');

    // 落盘与下次打开
    const e4 = makeEnv(), p4 = makePlayer(); e4.cur = p4;
    e4.t.begin(1, '剧A|如意|29', false); e4.t.setManual(120);
    e4.t.begin(2, '剧A|如意|30', false);
    ok(e4.t.offset === 0, '换集:这一集没调过,不带上一集的值');
    e4.t.setManual(115);
    e4.t.begin(3, '剧A|红牛|29', false);
    ok(e4.t.offset === 0, '换线路:不带另一条线路的值');
    e4.t.begin(4, '剧A|如意|29', false);
    ok(e4.t.offset === 120 && e4.t.manual === 120, '回到原来那集:记得');
    e4.t.begin(5, '剧A|如意|30', false);
    ok(e4.t.offset === 115, '另一集也记得');
    e4.t.resetManual();
    e4.t.begin(6, '剧A|如意|30', false);
    ok(e4.t.offset === 0 && e4.t.manual === null, '重置后下次打开也没有');
    ok(e4.t.setManual(5) === 5, '存');
    e4.t.begin(7, '', false);
    ok(e4.t.offset === 0, '没有键:不读别的集');
    e4.t.setManual(9);
    ok(!Object.keys(JSON.parse(e4.store_.getItem(DM_OFF_STORE))).some(k => k === 'k:'), '没有键:不落盘');
}

console.log('⑥ 存储:上限、原型链键、坏数据');
{
    const s = makeStore(), st = () => s;
    for (let i = 0; i < DM_OFF_CAP + 50; i++) dmOffPut(st, 'k' + i, i % 600, 1000 + i);
    const m = JSON.parse(s.getItem(DM_OFF_STORE));
    ok(Object.keys(m).length === DM_OFF_CAP, '条数不超过上限', Object.keys(m).length);
    ok(dmOffGet(st, 'k0') === null && dmOffGet(st, 'k49') === null && dmOffGet(st, 'k50') === 50 && dmOffGet(st, 'k' + (DM_OFF_CAP + 49)) != null, '淘汰最久没改的');
    ok(DM_OFF_CAP <= 1000, '上限不离谱');

    const s2 = makeStore(), st2 = () => s2;
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) ok(dmOffGet(st2, k) === null, '空表查 ' + k + ':没有');
    dmOffPut(st2, 'constructor', 12, 1);
    dmOffPut(st2, '__proto__', -34, 2);
    ok(dmOffGet(st2, 'constructor') === 12, '片名 constructor:存取正常');
    ok(dmOffGet(st2, '__proto__') === -34, '片名 __proto__:存取正常');
    ok(dmOffGet(st2, 'toString') === null, '不串到别的原型键');
    ok(({}).v === undefined && Object.getPrototypeOf(JSON.parse(s2.getItem(DM_OFF_STORE))) === Object.prototype, '没污染原型');
    dmOffPut(st2, 'constructor', null, 3);
    ok(dmOffGet(st2, 'constructor') === null && dmOffGet(st2, '__proto__') === -34, '删一个不影响另一个');
    // 完整键:片名 constructor 的不同集 / 线路不串
    const e = makeEnv(), p = makePlayer(); e.cur = p;
    e.t.begin(1, 'constructor|x|1', false); e.t.setManual(7);
    e.t.begin(2, '__proto__|x|1', false);
    ok(e.t.offset === 0, '片名 __proto__ 不读到 constructor 的值');
    e.t.setManual(8);
    e.t.begin(3, 'constructor|x|1', false);
    ok(e.t.offset === 7, '片名 constructor 还是自己的值');

    // 坏数据
    const bad = makeStore({ [DM_OFF_STORE]: '{坏的' }), stb = () => bad;
    ok(dmOffGet(stb, 'a') === null, '坏 JSON:当没有');
    dmOffPut(stb, 'a', 3, 1);
    ok(dmOffGet(stb, 'a') === 3, '坏 JSON:下次写入后恢复');
    for (const raw of ['[1,2]', 'null', '5', '"x"']) {
        const b2 = makeStore({ [DM_OFF_STORE]: raw });
        ok(dmOffGet(() => b2, 'a') === null, '不是对象(' + raw + '):当没有');
        dmOffPut(() => b2, 'a', 3, 1);
        ok(dmOffGet(() => b2, 'a') === 3, '不是对象(' + raw + '):能写回');
    }
    const b3 = makeStore({ [DM_OFF_STORE]: JSON.stringify({ 'k:a': { v: 99999 }, 'k:b': { v: 'x' }, 'k:c': 5, 'k:d': null }) });
    ok(dmOffGet(() => b3, 'a') === 600 && dmOffGet(() => b3, 'b') === null && dmOffGet(() => b3, 'c') === null && dmOffGet(() => b3, 'd') === null, '手改过的值:限幅或当没有');
    // 存储抛异常
    const thrower = () => { throw new Error('no storage'); };
    ok(dmOffGet(thrower, 'a') === null, '存储读不了:当没有');
    let threw = false;
    try { dmOffPut(thrower, 'a', 1, 1); } catch (x) { threw = true; }
    ok(!threw, '存储写不了:不抛');
    const quota = makeStore(); quota.setItem = () => { throw new Error('quota'); };
    const e5 = makeEnv({ store_: quota }), p5 = makePlayer(); e5.cur = p5; e5.t.begin(1, 'k', false);
    ok(e5.t.setManual(30) === 30 && p5.danmaku.options.time() === 30, '存储满了:这次播放照样生效');
}

console.log('⑦ 异常回退');
{
    const e = makeEnv(), p = makePlayer(); e.cur = p; e.t.begin(1, 'k', false);
    p.video.currentTime = 77;
    e.t.runs = null;
    ok(p.danmaku.options.time() === 77, 'runs 坏了:退回 currentTime', p.danmaku.options.time());
    e.t.runs = [];
    e.t.offset = NaN;
    ok(p.danmaku.options.time() === 77, '偏移不是数:退回 currentTime', p.danmaku.options.time());
    e.t.offset = 0;
    p.video.currentTime = NaN;
    ok(Number.isNaN(p.danmaku.options.time()), '换源中 currentTime=NaN:原样,不算出假时间(dmPointerOff 会放弃)');
    p.video.currentTime = 50;
    const v = p.video;
    p.video = null;
    let threw = false;
    try { p.danmaku.options.time(); } catch (x) { threw = true; }
    p.video = v;
    ok(threw, '连 video 都没了:交回 DPlayer 原来的取法(和以前一样)');
    // adState / adCore 抛异常 → timeupdate 里接住,弹幕时间不受影响
    const e2 = makeEnv(), p2 = makePlayer(); e2.cur = p2; e2.t.begin(1, 'k', false);
    e2.adState = () => { throw new Error('boom'); };
    const e3 = makeEnv({ adState: () => { throw new Error('boom'); } }), p3 = makePlayer(); e3.cur = p3; e3.t.begin(1, 'k', false);
    p3.video.currentTime = 12;
    let threw2 = false;
    try { p3.video.fire('timeupdate'); } catch (x) { threw2 = true; }
    ok(!threw2 && p3.danmaku.options.time() === 12, 'timeupdate 里判定状态出错:吞掉,弹幕时间照常');
    const e4 = makeEnv({ render: () => { throw new Error('boom'); } }), p4 = makePlayer(); e4.cur = p4;
    let threw3 = false;
    try { e4.t.begin(1, 'k', false); e4.t.setManual(3); } catch (x) { threw3 = true; }
    ok(!threw3 && e4.t.offset === 3, '界面更新出错:不影响偏移');
    const e6 = makeEnv({ player: () => { throw new Error('boom'); } });
    let threw4 = false;
    try { e6.t.realign(); e6.t.render(); } catch (x) { threw4 = true; }
    ok(!threw4, '取不到播放器:realign / render 不抛');
    // 每帧路径不碰环境:只读普通字段
    let touched = 0;
    const e7 = makeEnv({ adState: () => { touched++; return null; }, store: () => { touched++; return makeStore(); }, adCore: () => { touched++; return C; } }), p7 = makePlayer();
    e7.cur = p7; e7.t.begin(1, '', false); touched = 0;
    for (let i = 0; i < 2000; i++) { p7.video.currentTime = i; p7.danmaku.options.time(); }
    ok(touched === 0, '每帧路径不读判定状态、不碰存储', touched);
    const mapSrc = /map\(t\) \{([\s\S]*?)\n\s*\},/.exec(CORE)[1], stripSrc = /const dmStripAds = \(t, runs\) => \{([\s\S]*?)\n\s*\};/.exec(CORE)[1];
    ok(!/JSON|localStorage|Object\.|vue|\[\]|\{\s*\}|new /i.test(mapSrc + stripSrc), '每帧路径没有 JSON / 存储 / Vue / 分配', mapSrc + stripSrc);
}

console.log('⑧ 换会话立刻清零:复用实例 / 新建实例 / 后来才有弹幕模块 / 直播');
{
    // switchVideo 复用实例:同一个 dm,options.time 不变,值换掉
    const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
    e.t.begin(1, '剧|线|1', false);
    e.t.setManual(120);
    e.t.runs = [100, 120];
    p.video.currentTime = 500;
    ok(p.danmaku.options.time() === 600, '第 1 集:插播 + 偏移');
    const timeFn = p.danmaku.options.time;
    e.t.begin(2, '剧|线|2', false);
    ok(p.danmaku.options.time === timeFn && p.video.count('timeupdate') === 1, '复用实例:不重复挂');
    ok(p.danmaku.options.time() === 500 && e.t.runs.length === 0 && e.t.manual === null, '换集同一拍清零,不带上一集的插播段和偏移', p.danmaku.options.time());
    // 上一次播放的 hls 状态还挂着(tok 不等)→ env.adState 返回 null
    e.ad = null; p.video.fire('timeupdate');
    ok(e.t.runs.length === 0, '上一次播放的状态不算');

    // new DPlayer:新实例的 options.time 是原始的 → install
    const p2 = makePlayer(everySecond); e.cur = p2;
    p2.video.currentTime = 300;
    ok(p2.danmaku.options.time() === 300 && !p2.danmaku._dgTime, '新实例:还没挂');
    e.t.begin(3, '剧|线|1', false);
    ok(p2.danmaku._dgTime === true && p2.danmaku.options.time() === 420, 'begin 时当前播放器已有弹幕模块:挂上并应用这一集的值', p2.danmaku.options.time());
    const p3 = makePlayer(everySecond);
    e.cur = null; e.t.begin(4, '剧|线|1', false);
    ok(e.views[e.views.length - 1].visible === false, '播放器还没建:界面不显示');
    e.cur = p3; p3.video.currentTime = 10;
    ok(e.t.install(p3) === true && e.t.install(p3) === false, '建好后 install 一次,不重复挂');
    ok(p3.danmaku.options.time() === 130, 'new DPlayer 路:映射在位');
    ok(e.views[e.views.length - 1].visible === true && e.views[e.views.length - 1].text === '弹幕提前 120 秒', '界面显示当前值');
    // 旧实例的 timeupdate 不再影响
    const stale = makeEnv(), a = makePlayer(), b = makePlayer();
    stale.cur = a; stale.t.begin(1, 'k', false);
    stale.cur = b; stale.t.begin(2, 'k', false);
    let called = 0;
    const orig = stale.t.refresh; stale.t.refresh = (x) => { called++; return orig(x); };
    a.video.fire('timeupdate');
    ok(called === 0, '被顶替的播放器:timeupdate 不再触发重算');
    b.video.fire('timeupdate');
    ok(called === 1, '当前播放器才重算');

    // 后来才有弹幕模块(先看直播建的播放器 → 重建):没弹幕模块时 install 什么都不做
    const noDm = { video: makeVideo(), danmaku: undefined };
    const e2 = makeEnv(); e2.cur = noDm;
    ok(e2.t.install(noDm) === false, '没弹幕模块:不挂');
    e2.t.begin(1, 'k', false);
    ok(e2.views[e2.views.length - 1].visible === false, '没弹幕模块:界面不显示');
    const later = makePlayer();
    noDm.danmaku = later.danmaku; later.video = noDm.video;
    e2.t.begin(2, 'k', false);
    ok(noDm.danmaku._dgTime === true && e2.views[e2.views.length - 1].visible === true, '弹幕模块后来才有:下一次 begin 补上');

    // 直播:不启用
    const e3 = makeEnv(), p4 = makePlayer(everySecond); e3.cur = p4;
    e3.t.begin(1, '剧|线|1', false); e3.t.setManual(120);
    e3.t.begin(2, '', true);
    p4.video.currentTime = 42;
    ok(p4.danmaku.options.time() === 42, '直播:弹幕时间就是 currentTime');
    ok(e3.views[e3.views.length - 1].visible === false, '直播:界面不显示');
    ok(e3.t.setManual(100) === null && p4.danmaku.options.time() === 42, '直播:手动偏移无效');
    e3.t.step(10); e3.t.resetManual(); e3.t.setAuto(5, 2);
    ok(p4.danmaku.options.time() === 42, '直播:别的入口也无效');
    e3.ad = ruyi();
    p4.video.fire('timeupdate');
    ok(e3.t.runs.length === 0, '直播:不算插播');
    e3.t.begin(3, '剧|线|1', false);
    p4.video.currentTime = 10;
    ok(p4.danmaku.options.time() === 130, '从直播回到点播:恢复');
}

console.log('⑨ 插播新判定:差值超过 2 秒才对齐');
{
    const e = makeEnv(), p = makePlayer(everySecond); e.cur = p; e.t.begin(1, 'k', false);
    const st = ruyi();
    p.video.currentTime = 100; p.video.fire('timeupdate');   // 清掉 begin 的一次性对齐
    p.danmaku.danIndex = 100;
    const c0 = p.danmaku.clears;
    // 组都在播放头后面:映射不变,不清屏
    e.ad = st; p.video.currentTime = 100.5; p.video.fire('timeupdate');
    ok(e.t.runs.length === 4 && p.danmaku.clears === c0, '插播段在播放头后面:不清屏', [e.t.runs.length, p.danmaku.clears - c0]);
    // 同一状态不重算
    let calls = 0;
    const counting = { planCuts(...a) { calls++; return C.planCuts(...a); } };
    const e2 = makeEnv({ adCore: () => counting }), p2 = makePlayer(); e2.cur = p2; e2.t.begin(1, 'k', false); e2.ad = ruyi();
    for (let i = 0; i < 50; i++) { p2.video.currentTime = i; p2.video.fire('timeupdate'); }
    ok(calls === 1, '状态没变:只算一次', calls);
    e2.ad.off[9999] = 1; p2.video.fire('timeupdate');
    ok(calls === 2, '学到新组:重算', calls);
    const stNew = ruyi(); e2.ad = stNew; p2.video.fire('timeupdate');
    ok(calls === 3, '换了 hls 实例:重算', calls);

    // 播放头已在插播之后(左侧未知拖过去之后才判出):差 20 秒 → 对齐一次
    const e3 = makeEnv(), p3 = makePlayer(everySecond); e3.cur = p3; e3.t.begin(1, 'k', false);
    p3.video.currentTime = 700; p3.video.fire('timeupdate');
    p3.danmaku.seek();
    const c3 = p3.danmaku.clears;
    e3.ad = ruyi(); p3.video.fire('timeupdate');
    ok(p3.danmaku.clears === c3 + 1 && p3.danmaku.options.time() === 680, '播放头之前新判出 20 秒:对齐', [p3.danmaku.clears - c3, p3.danmaku.options.time()]);
    p3.danmaku.drawn = []; p3.video.currentTime = 702; p3.danmaku.frame();
    ok(p3.danmaku.drawn.join() === '680,681', '对齐后从新位置接着出,不补画也不漏', p3.danmaku.drawn);
    // 差值 ≤2 秒:不清屏
    const e4 = makeEnv(), p4 = makePlayer(everySecond); e4.cur = p4; e4.t.begin(1, 'k', false);
    p4.video.currentTime = 200; p4.video.fire('timeupdate'); p4.danmaku.seek();
    const c4 = p4.danmaku.clears;
    const small = makeState([[100, '1x1', 1], [1.5, '1x1', 1], [200, '1x1', 1]]);
    small.skipped[1] = [1];
    e4.ad = small; p4.video.fire('timeupdate');
    ok(p4.danmaku.clears === c4 && near(p4.danmaku.options.time(), 198.5), '只差 1.5 秒:不清屏', [p4.danmaku.clears - c4, p4.danmaku.options.time()]);
    // 状态没了(换 hls):段清空;差得多就对齐
    e3.ad = null; p3.video.fire('timeupdate');
    ok(e3.t.runs.length === 0 && p3.danmaku.options.time() === 702, '状态没了:插播段清空');

    // 同集换线不重载弹幕:拿到新视频后看一眼读指针
    const e5 = makeEnv(), p5 = makePlayer(everySecond); e5.cur = p5; e5.t.begin(1, '剧|a|1', false);
    p5.video.currentTime = 1000; p5.video.fire('timeupdate'); p5.danmaku.seek();
    e5.t.begin(2, '剧|b|1', false);
    p5.video.currentTime = 0; p5.video.readyState = 0; p5.video.fire('timeupdate');
    ok(p5.danmaku.danIndex === 1000, '新视频元数据还没到:不动');
    p5.video.readyState = 4; p5.video.currentTime = 1.2; p5.video.fire('timeupdate');
    ok(p5.danmaku.danIndex === 2, '元数据到了:读指针对到新位置', p5.danmaku.danIndex);
    const c5 = p5.danmaku.clears; p5.video.currentTime = 1.5; p5.video.fire('timeupdate');
    ok(p5.danmaku.clears === c5, '只看一次');
}

console.log('⑩ 起播前列表到达不爆弹幕');
{
    // 偏移已知、currentTime=0、列表到达
    const e = makeEnv(), p = makePlayer(); e.cur = p; e.t.begin(1, '剧|线|1', false); e.t.setManual(120);
    p.danmaku.reload(everySecond); p.danmaku.loaded();
    p.video.currentTime = 0;
    ok(dmAlignAfterLoad(p) === true, '弹幕时间 120 > 1:对齐(旧判断看 currentTime=0 会跳过)');
    ok(p.danmaku.frame().length === 0, '这一帧一条都不画(修之前一帧画 120 秒的量)', p.danmaku.drawn.length);
    p.video.currentTime = 2.5;
    ok(p.danmaku.frame().join() === '120,121,122', '之后从 120 秒的弹幕接着出', p.danmaku.drawn);
    // 没偏移、刚开始:和以前一样不对齐
    const e2 = makeEnv(), p2 = makePlayer(); e2.cur = p2; e2.t.begin(1, '剧|线|1', false);
    p2.danmaku.reload(everySecond); p2.danmaku.loaded();
    ok(dmAlignAfterLoad(p2) === false, '弹幕时间 0:不用对齐');
    // 没偏移、播到一半才到
    p2.video.currentTime = 300;
    ok(dmAlignAfterLoad(p2) === true && p2.danmaku.frame().length === 0, '播到一半列表才到:照旧对齐');
    // 负向偏移:currentTime=30、推后 120 秒 → 弹幕时间 0,读指针留在开头,一条不画,走到 120 秒才开始
    const e3 = makeEnv(), p3 = makePlayer(); e3.cur = p3; e3.t.begin(1, '剧|线|1', false); e3.t.setManual(-120);
    p3.danmaku.reload(everySecond); p3.danmaku.loaded();
    p3.video.currentTime = 30;
    ok(dmAlignAfterLoad(p3) === false && p3.danmaku.danIndex === 0, '负向偏移算出 ≤1:不对齐,读指针在开头');
    ok(p3.danmaku.frame().length === 0, '负向偏移:不会画出一批');
    p3.video.currentTime = 120.5;
    ok(p3.danmaku.frame().join() === '0', '负向偏移:走过偏移量后从头开始', p3.danmaku.drawn);
    // 负向偏移但播得够远:正常对齐
    const e4 = makeEnv(), p4 = makePlayer(); e4.cur = p4; e4.t.begin(1, '剧|线|1', false); e4.t.setManual(-120);
    p4.danmaku.reload(everySecond); p4.danmaku.loaded();
    p4.video.currentTime = 500;
    ok(dmAlignAfterLoad(p4) === true && p4.danmaku.frame().length === 0, '负向偏移、播到后面:对齐,不爆');
    // 组内冻结时列表到达
    const e5 = makeEnv(), p5 = makePlayer(); e5.cur = p5; e5.t.begin(1, '剧|线|1', false); e5.t.runs = [100, 120];
    p5.danmaku.reload(everySecond); p5.danmaku.loaded();
    p5.video.currentTime = 110;
    ok(dmAlignAfterLoad(p5) === true && p5.danmaku.frame().length === 0, '正在播广告时列表到达:对到组起点');
    ok(dmAlignAfterLoad(null) === false && dmAlignAfterLoad({}) === false && dmAlignAfterLoad({ danmaku: {} }) === false, '没有弹幕模块:什么都不做');
}

console.log('⑩+ 同集换线:第一个有效 timeupdate 之前也不爆弹幕');
{
    // 同集换线 / 起播失败自动换线:danmakuKey 不变、不重载,列表和读指针都留着。
    // 真实时序:play() 里先 begin → switchVideo:pause + 换 src,currentTime 归零、readyState 0,浏览器 load 算法发一次 timeupdate(元数据没到,s.align 不处理)
    //          → loadedmetadata → playAfterSwitch → dp.play() → 下一个 rAF 的 frame() 就按新映射比较,这一帧早于第一个有效 timeupdate
    const switchLine = (p, e, tok, key) => {
        e.t.begin(tok, key, false);
        p.video.currentTime = 0; p.video.readyState = 0; p.video.fire('timeupdate');
        p.video.readyState = 1;
    };
    const firstUpdate = (p, t) => { p.video.readyState = 4; p.video.currentTime = t; p.video.fire('timeupdate'); };
    const atPointer = p => { const x = p.danmaku.dan[p.danmaku.danIndex]; return x ? x.time : null; };
    // 线路 B 第 29 集存过 +120,今天在线路 A 播到 t=30,切到 B(审查复现:每秒 4 条时一帧 360 条)
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|B|29', false); e.t.setManual(120);
        e.t.begin(2, '剧|A|29', false);
        p.video.currentTime = 30; p.danmaku.seek(); p.video.fire('timeupdate');
        ok(atPointer(p) === 30, '线路 A 没有偏移:读指针在 30', atPointer(p));
        switchLine(p, e, 3, '剧|B|29');
        ok(e.t.offset === 120 && p.danmaku.options.time() === 120, '换到 B:偏移换成 120', p.danmaku.options.time());
        const first = p.danmaku.frame();
        ok(first.length === 0, '第一帧一条都不画(修之前一帧画出 30~120 秒的弹幕)', first.length);
        ok(p.danmaku.drawn.length === 0, '这一帧之后屏幕上还是 0 条', p.danmaku.drawn.length);
        firstUpdate(p, 0.5);
        ok(atPointer(p) === 121, '第一个有效 timeupdate:读指针拉回 120.5 之后的 121', atPointer(p));
        p.video.currentTime = 2.5;
        ok(p.danmaku.frame().join() === '121,122', '之后从 121 接着出,不漏不补', p.danmaku.drawn);
    }
    // 线路 A 还没起播就失败(t=0)、自动换到存过 +300 的线路(审查复现:每秒 4 条时一帧 1200 条)
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|B|29', false); e.t.setManual(300);
        e.t.begin(2, '剧|A|29', false); p.danmaku.seek();
        ok(atPointer(p) === 0, '线路 A 起播失败:读指针在 0', atPointer(p));
        switchLine(p, e, 3, '剧|B|29');
        ok(p.danmaku.frame().length === 0, 't=0 换到 +300:第一帧一条都不画', p.danmaku.drawn.length);
        firstUpdate(p, 0.5);
        ok(atPointer(p) === 300, 't=0 换到 +300:读指针已在 300,差半秒在容差内,第一个 timeupdate 不多对齐一次', atPointer(p));
        ok(p.danmaku.frame().join() === '300', 't=0 换到 +300:接着只出刚走过的这一条', p.danmaku.drawn);
    }
    // 从负偏移换到正偏移
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|B|29', false); e.t.setManual(120);
        e.t.begin(2, '剧|A|29', false); e.t.setManual(-120);
        p.video.currentTime = 30; p.danmaku.seek();
        ok(atPointer(p) === 0, '线路 A 推后 120:t=30 弹幕时间封底 0', atPointer(p));
        switchLine(p, e, 3, '剧|B|29');
        ok(p.danmaku.frame().length === 0, '负偏移换到正偏移:第一帧一条都不画', p.danmaku.drawn.length);
    }
    // 只差一点也算偏移变了:读指针刚好等于旧弹幕时间,新偏移多 1 秒就能多画一批
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|B|29', false); e.t.setManual(1);
        e.t.begin(2, '剧|A|29', false); p.danmaku.seek();
        switchLine(p, e, 3, '剧|B|29');
        ok(p.danmaku.frame().length === 0, '差 1 秒:第一帧也不补画', p.danmaku.drawn.length);
    }
    // 换到偏移更小的线路:读指针跑到前面,只是空一下,第一个 timeupdate 拉回来,开头的弹幕不丢
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|A|29', false); e.t.setManual(120);
        p.video.currentTime = 30; p.danmaku.seek();
        ok(atPointer(p) === 150, '线路 A 提前 120:读指针在 150', atPointer(p));
        switchLine(p, e, 2, '剧|B|29');
        ok(p.danmaku.frame().length === 0, '偏移变小:第一帧不画', p.danmaku.drawn.length);
        firstUpdate(p, 0.5);
        ok(atPointer(p) === 1, '偏移变小:第一个 timeupdate 读指针回到开头', atPointer(p));
        p.video.currentTime = 2.5;
        ok(p.danmaku.frame().join() === '1,2', '偏移变小:开头的弹幕照常出', p.danmaku.drawn);
    }
    // 偏移没变:begin 不多清一次屏,读指针不动,第一个 timeupdate 才看一眼
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|A|29', false);
        p.video.currentTime = 30; p.danmaku.seek(); p.video.fire('timeupdate');
        const c = p.danmaku.clears;
        e.t.begin(2, '剧|B|29', false);
        ok(p.danmaku.clears === c && atPointer(p) === 30, '两条线路都没偏移:begin 不清屏', [p.danmaku.clears - c, atPointer(p)]);
        const e2 = makeEnv(), p2 = makePlayer(everySecond); e2.cur = p2;
        e2.t.begin(1, '剧|B|29', false); e2.t.setManual(50);
        e2.t.begin(2, '剧|A|29', false); e2.t.setManual(50);
        p2.video.currentTime = 30; p2.danmaku.seek();
        const c2 = p2.danmaku.clears;
        switchLine(p2, e2, 3, '剧|B|29');
        ok(p2.danmaku.clears === c2 && atPointer(p2) === 80, '两条线路偏移一样:begin 不清屏', [p2.danmaku.clears - c2, atPointer(p2)]);
        ok(p2.danmaku.frame().length === 0, '两条线路偏移一样:第一帧不画', p2.danmaku.drawn.length);
    }
    // 偏移没变,但上一条线路扣过插播:读指针落在 t−累计,不小于新视频 t=0 的弹幕时间;恢复进度走 dp.seek(弹幕同步对齐),也不爆
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|A|29', false); e.t.runs = [100, 220];
        p.video.currentTime = 1000; p.danmaku.seek();
        ok(atPointer(p) === 880, '线路 A 扣了 120 秒插播:读指针在 880', atPointer(p));
        const c = p.danmaku.clears;
        switchLine(p, e, 2, '剧|B|29');
        ok(p.danmaku.clears === c && e.t.runs.length === 0, '偏移没变:begin 不清屏,插播段清零', [p.danmaku.clears - c, e.t.runs.length]);
        ok(p.danmaku.frame().length === 0, '上一条线路有插播段:第一帧不画', p.danmaku.drawn.length);
        p.video.currentTime = 1000; p.danmaku.seek();
        ok(p.danmaku.frame().length === 0 && atPointer(p) === 1000, '恢复进度:读指针对到新线路的 1000', atPointer(p));
    }
    // 换集走 reload:列表清空,偏移变了也只是多清一次,列表到达时按新弹幕时间对齐
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|B|30', false); e.t.setManual(120);
        e.t.begin(2, '剧|B|29', false);
        p.video.currentTime = 30; p.danmaku.seek();
        e.t.begin(3, '剧|B|30', false);
        p.danmaku.reload(everySecond);
        p.video.currentTime = 0; p.video.readyState = 0; p.video.fire('timeupdate'); p.video.readyState = 1;
        p.danmaku.loaded();
        ok(dmAlignAfterLoad(p) === true && p.danmaku.frame().length === 0, '换集:列表到达对齐,第一帧不画', p.danmaku.drawn.length);
    }
    // 回到直播:弹幕时间就是 currentTime,旧列表留着也不爆
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|A|29', false); e.t.setManual(120);
        p.video.currentTime = 30; p.danmaku.seek();
        e.t.begin(2, '', true);
        p.video.currentTime = 0;
        ok(e.t.offset === 0 && p.danmaku.options.time() === 0 && p.danmaku.frame().length === 0, '从有偏移的点播进直播:不画', p.danmaku.drawn.length);
    }
    // 对齐失败不能拖垮 begin:play() 里还有后面一大段要跑
    {
        const e = makeEnv(), p = makePlayer(everySecond); e.cur = p;
        e.t.begin(1, '剧|B|29', false); e.t.setManual(120);
        e.t.begin(2, '剧|A|29', false);
        p.danmaku.seek = () => { throw new Error('boom'); };
        let threw = false;
        try { e.t.begin(3, '剧|B|29', false); } catch (x) { threw = true; }
        ok(!threw && e.t.offset === 120 && e.t.tok === 3, 'seek 抛错:begin 不抛,偏移照常换上', [threw, e.t.offset, e.t.tok]);
        // 还没有弹幕模块 / 还没有播放器:偏移变了也什么都不做
        const e2 = makeEnv(); e2.cur = { video: makeVideo(), danmaku: null };
        e2.t.begin(1, '剧|B|29', false); e2.t.setManual(120);
        e2.t.begin(2, '剧|A|29', false);
        ok(e2.t.offset === 0, '没有弹幕模块:照常换偏移');
        e2.cur = null;
        e2.t.begin(3, '剧|B|29', false);
        ok(e2.t.offset === 120, '没有播放器:照常换偏移');
    }
}

console.log('⑪ dmResync 读到的是映射后的时间');
{
    const e = makeEnv(), p = makePlayer(everySecond); e.cur = p; e.t.begin(1, 'k', false);
    dmResync(p);
    e.t.runs = [100, 120];
    p.video.currentTime = 90.5; p.danmaku.frame();
    // 绕过 dp.seek 跳过插播:95 → 130,弹幕时间 95 → 110
    p.video.currentTime = 130;
    const c = p.danmaku.clears; p.video.fire('seeking');
    ok(p.danmaku.clears === c + 1 && p.danmaku.dan[p.danmaku.danIndex].time === 110, '跳过插播:对到映射后的 110,不是 130', p.danmaku.dan[p.danmaku.danIndex]);
    // adClipSkip 静默跳过:落点映射后只前进 0.1 秒,dmResync 判出没差,不多清一次屏
    const e2 = makeEnv(), p2 = makePlayer(everySecond); e2.cur = p2; e2.t.begin(1, 'k', false);
    dmResync(p2);
    e2.t.runs = [100, 120];
    p2.video.currentTime = 99.9; p2.danmaku.frame();
    const c2 = p2.danmaku.clears;
    p2.video.currentTime = 120.1; p2.video.fire('seeking');
    ok(p2.danmaku.clears === c2, '映射后没差:不清屏');
    // 手动偏移下的快退
    const e3 = makeEnv(), p3 = makePlayer(everySecond); e3.cur = p3; e3.t.begin(1, 'k', false); e3.t.setManual(120);
    dmResync(p3);
    p3.video.currentTime = 100; p3.danmaku.seek(); p3.danmaku.frame();
    p3.video.currentTime = 50; p3.video.fire('seeking');
    ok(p3.danmaku.dan[p3.danmaku.danIndex].time === 170, '有偏移时快退:对到 50+120', p3.danmaku.dan[p3.danmaku.danIndex]);
    // frame 走映射:播广告期间不出弹幕
    const e4 = makeEnv(), p4 = makePlayer(everySecond); e4.cur = p4; e4.t.begin(1, 'k', false); e4.t.runs = [100, 120];
    p4.video.currentTime = 99.5; p4.danmaku.seek(); p4.danmaku.frame(); p4.danmaku.drawn = [];
    for (let t = 100; t < 120; t += 0.25) { p4.video.currentTime = t; p4.danmaku.frame(); }
    ok(p4.danmaku.drawn.length <= 1, '放弃跳过照常播广告:这 20 秒不出弹幕', p4.danmaku.drawn);
    p4.video.currentTime = 122; p4.danmaku.frame();
    ok(p4.danmaku.drawn.includes(101), '广告放完从段前接着出');
}

console.log('⑫ 环境接线(真跑 dmTimeCreate 那段)');
{
    const m = /const dmTime = dmTimeCreate\(\{[\s\S]*?\n        \}\);/.exec(HTML);
    ok(!!m, '有 dmTime 实例');
    // 假 DOM:够 render 用
    const makeEl = () => ({ set: new Set(), textContent: '', classList: { toggle(c, on) { if (on) this.o.add(c); else this.o.delete(c); }, o: null } });
    const block = makeEl(), row = makeEl(), val = makeEl(), mobVal = makeEl(), reset = makeEl();
    [block, row, val, mobVal, reset].forEach(x => { x.classList.o = x.set; });
    const box = {
        querySelectorAll(sel) {
            if (sel === '.dm-off-block, .dg-mob-row[data-dg="dmoffset"]') return [block, row];
            if (sel === '.dm-off-val') return [val];
            if (sel === '.dg-dmoff-val') return [mobVal];
            return [];
        },
        querySelector(sel) { return sel === '.dm-off-reset' ? reset : null; },
    };
    const p = makePlayer();
    const store = makeStore();
    const win = { localStorage: store, AdClipCore: C, adClipSkip: null };
    const ctx = { window: win, dp: p, document: { getElementById: id => (id === 'dplayer' ? box : null) } };
    const dmTime = vm.runInNewContext(RESYNC + '\n' + CORE + '\n' + m[0] + '\n;dmTime;', ctx);
    dmTime.begin(3, '剧|线|1', false);
    ok(p.danmaku._dgTime === true, 'begin 挂上当前 dp');
    ok(!block.set.has('dg-dmoff-off') && !row.set.has('dg-dmoff-off'), '有弹幕模块:显示');
    ok(val.textContent === '未调整' && reset.set.has('dm-off-na'), '没调过:显示未调整,重置不可点');
    dmTime.step(10);
    ok(val.textContent === '弹幕提前 10 秒' && mobVal.textContent === '提前 10 秒', '面板和菜单行都更新(菜单行短文案)', [val.textContent, mobVal.textContent]);
    ok(!reset.set.has('dm-off-na'), '调过:重置可点');
    ok(JSON.parse(store.getItem('donggua_dm_offset'))['k:剧|线|1'].v === 10, '存进 localStorage');
    dmTime.begin(4, '', true);
    ok(block.set.has('dg-dmoff-off') && row.set.has('dg-dmoff-off'), '直播:隐藏');

    // adState 的门
    const st = ruyi(); st.tok = 9;
    let enabled = true;
    win.adClipSkip = { vue: { _playToken: 9 }, OPT: null, enabled: () => enabled, _cur: () => st };
    dmTime.begin(9, '剧|线|1', false);
    p.video.currentTime = 100; p.video.fire('timeupdate');
    ok(dmTime.runs.length === 4, '当前播放的状态:读到', dmTime.runs);
    st.tok = 8; p.video.fire('timeupdate');
    ok(dmTime.runs.length === 0, '上一次播放留下的状态:不算');
    st.tok = 9; st.live = true; p.video.fire('timeupdate');
    ok(dmTime.runs.length === 0, 'adClipSkip 判是直播:不算');
    st.live = false; st.multi = true; p.video.fire('timeupdate');
    ok(dmTime.runs.length === 0, '多码率:不算');
    st.multi = false; p.video.fire('timeupdate');
    ok(dmTime.runs.length === 4, '恢复:读到');
    enabled = false; p.video.fire('timeupdate');
    ok(dmTime.runs.length === 0, '去插播关了:不算');
    enabled = true; win.adClipSkip._cur = () => null; p.video.fire('timeupdate');
    ok(dmTime.runs.length === 0, '没有活动状态:不算');
    // dp 换了
    const p2 = makePlayer(); ctx.dp = p2;
    dmTime.begin(10, '剧|线|1', false);
    ok(p2.danmaku._dgTime === true, '换 dp:begin 挂到新实例');
    ctx.dp = null;
    let threw = false;
    try { dmTime.begin(11, '剧|线|1', false); } catch (e) { threw = true; }
    ok(!threw, 'dp 为空:begin 不抛');
}

console.log('⑬ 接线');
{
    const read = /_dmBackend = \{[\s\S]*?\n        \};/.exec(HTML)[0];
    ok(/o\.success\([\s\S]{0,300}dmAlignAfterLoad\(dp\)/.test(read), '列表到达:o.success 之后看弹幕时间对齐');
    ok(!/currentTime \|\| 0\) > 1/.test(read), '_dmBackend.read 不再看 currentTime > 1');
    const playSrc = HTML.slice(HTML.indexOf('                play(url) {'));
    const tokAt = playSrc.indexOf('const playToken = (this._playToken = (this._playToken || 0) + 1);');
    const begAt = playSrc.indexOf('this._dmTimeBegin();', tokAt);
    const newAt = playSrc.indexOf('dp = new DPlayer({');
    const swAt = playSrc.indexOf('this._dpSwitchHls(finalUrl');
    ok(tokAt > 0 && begAt > tokAt && begAt - tokAt < 400, 'play():令牌递增后马上 begin');
    ok(begAt < newAt && begAt < swAt, 'begin 早于 new DPlayer 和 switchVideo 两条路');
    const kz = playSrc.slice(0, tokAt);
    const kzTok = kz.indexOf('this._playToken = (this._playToken || 0) + 1;');
    ok(kzTok > 0 && kz.indexOf('this._dmTimeBegin();', kzTok) > kzTok, 'Kazumi 解析中令牌已递增:也 begin');
    const create = HTML.slice(HTML.indexOf('dp = new DPlayer({'), HTML.indexOf('// ========== 🔧 设置菜单修复 =========='));
    ok(/\n\s*dmTime\.install\(dp\);/.test(create), '新建播放器(含先看直播后重建)时 install');
    ok((HTML.match(/new DPlayer\(/g) || []).length === 1, '全站只有一处 new DPlayer(多了要一起挂)');
    ok(/_dmTimeBegin\(\) \{[\s\S]{0,400}_liveActive[\s\S]{0,100}_isLive[\s\S]{0,400}dmTime\.begin\(tok, key, live\)/.test(HTML), '_dmTimeBegin 判直播、键 = 剧|线路|集');
    ok(!/data\(\) \{[\s\S]{0,200000}dmTime/.test(HTML.slice(HTML.indexOf('createApp({'), HTML.indexOf('methods: {', HTML.indexOf('createApp({')))), '状态不进 Vue data');

    // 面板:按钮不是文本框、方向、stopPropagation、白名单
    const block = /<div class="dm-off-block">([\s\S]*?)<div class="dm-off-hint">/.exec(HTML);
    ok(!!block && !/<input/.test(block[1]), '面板里没有输入框(手机会弹键盘)');
    ok(!!block && /data-d="-10">推后10</.test(block[1]) && /data-d="-1">推后1</.test(block[1]) && /data-d="1">提前1</.test(block[1]) && /data-d="10">提前10</.test(block[1]), '±1 / ±10,提前是正数');
    ok(!!block && /dm-off-reset/.test(block[1]) && /dm-off-val/.test(block[1]), '有当前值、有重置');
    ok(/querySelectorAll\('\.dm-off-btn'\)\.forEach\(b => b\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);\s*dmTime\.step\(\+b\.getAttribute\('data-d'\)\);/.test(HTML), '按钮 stopPropagation 后 step');
    ok(/offReset\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); dmTime\.resetManual\(\); \}\)/.test(HTML), '重置 stopPropagation');
    ok(/#dplayer \.dm-off-btn \{[\s\S]{0,400}touch-action: manipulation/.test(HTML), '连点不被当成双击缩放');
    ok(/e\.target\.closest\('\.dm-settings-panel'\)/.test(HTML) && /closest\('\.dplayer-controller, \.dplayer-setting-box, \.dplayer-menu, \.dplayer-comment-box, \.dm-settings-panel/.test(HTML), '面板在点击和触摸两处白名单里(点按钮不会关面板、不会被吃掉)');
    ok(/class="dm-settings-panel"[\s\S]{0,2000}dm-off-block/.test(HTML), '块在弹幕设置面板里');
    // 手机:菜单行 + 打开面板;行本身 stopPropagation(沿用 .dg-mob-row 的处理)
    ok(/row\('dmoffset', '弹幕时间'/.test(HTML), '手机齿轮菜单有入口(.dg-mob-row)');
    ok(/key === 'dmoffset'\) \{[\s\S]{0,300}panel\.style\.display = 'block'[\s\S]{0,300}panel\.scrollTop/.test(HTML), '菜单行打开面板并滚到这一块(竖屏内联面板要滚)');
    ok(/if \(hasDm\) \{[\s\S]{0,800}row\('dmoffset'/.test(HTML), '没有弹幕模块不加菜单行');
    ok(/#dplayer \.dg-mob-row\.dg-dmoff-off \{|#dplayer \.dg-mob-row\.dg-dmoff-off[\s\S]{0,40}display: none !important/.test(HTML), '菜单行能被隐藏(压过手机的 display:flex !important)');
    ok(/\.dm-settings-panel \{[\s\S]{0,900}overflow-y: auto/.test(HTML), '面板内部滚动还在');
    ok(/dmTime\.render\(\);/.test(HTML), '面板挂好后写一次当前值');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
