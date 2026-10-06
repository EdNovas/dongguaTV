#!/usr/bin/env node
// 去插播(分辨率突变 + 时间戳重启)判定回归 —— 离线、零网络:
//   node scripts/adclip-test.mjs
// 被测:public/libs/js/ad-clip-core.js(判定核心)+ public/index.html 里 window.adClipSkip 的接线(静态检查)。
// 数据(全部是 2026-10-05 实抓):
//   1) fixtures/adclip/jackie-rycj.json —— 如意(rycj)成龙历险记 S1-S5 全 95 集:按 cc 分组的 EXTINF + 逐组 ffprobe 分辨率
//      + 逐组 PTS 偏移(首帧 PTS - 清单时间)。每集一段 20-22s 中插 + 12.16s 片尾,1280x720;正片 1080x810
//   2) fixtures/adclip/multi-source.json —— 11 个源 117 集、13661 组:分辨率 + 首帧 PTS + 是否插播(逐类抽帧确认)。
//      含同分辨率插播(只能靠时间戳抓)。硬指标:正片组 0 误跳
//   3) fixtures/worker/*.m3u8 + 合成分辨率/时间戳 —— 全主分辨率零动作;1080zyk 型 / wsyzy 型必须跳掉
//   4) 对抗(审查清单):±8px 怪组 / 合集里另一集换分辨率 / 89s OP / 冷开场后的 OP / 片尾 60s 彩蛋 / 回到开头 / 倍速 ...
// 模拟方式与 hls.js 1.1.5 一致:#EXT-X-DISCONTINUITY 让下一个分片 cc+1;一组的分辨率和 PTS 偏移在它的首个分片被转封装时
//   (FRAG_PARSING_INIT_SEGMENT / INIT_PTS_FOUND)才知道 = 组起点进入"播放头 + 预加载窗口"时;seek 后从落点重新往前加载,已学到的保留。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = require(path.join(ROOT, 'public/libs/js/ad-clip-core.js'));
const FIX = path.join(ROOT, 'scripts/fixtures/worker');

let pass = 0, fail = 0;
const fails = [];
const ok = (c, name, extra) => { if (c) pass++; else { fail++; fails.push(name + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 500) : '')); } };

function parseM3u8(text) {
    const frags = [];
    let cc = 0, t = 0, dur = null, sn = 0;
    const m = text.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/);
    if (m) cc = +m[1];
    for (const raw of text.split(/\r?\n/)) {
        const l = raw.trim();
        if (!l) continue;
        if (l.startsWith('#EXT-X-DISCONTINUITY') && !l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) { cc++; continue; }
        if (l.startsWith('#EXTINF:')) { dur = parseFloat(l.slice(8)); continue; }
        if (l.startsWith('#') || dur == null) continue;
        frags.push({ sn: sn++, cc, start: t, duration: dur }); t += dur; dur = null;
    }
    return frags;
}
// 每组一个 cc、组内一片(只用于时长/分辨率/偏移的模拟,分片粒度不影响判定)
function fragsFromDurs(durs) {
    const frags = [];
    let t = 0;
    durs.forEach((d, i) => { frags.push({ sn: i, cc: i, start: t, duration: d }); t += d; });
    return frags;
}
function fragsFromGroups(g) {
    const frags = [];
    let t = 0, sn = 0;
    for (const [cc, ds] of g) for (const d of String(ds).split(',').map(Number)) { frags.push({ sn: sn++, cc, start: t, duration: d }); t += d; }
    return frags;
}

// 播放模拟。truth(g) -> { res, off, ad }。返回动作列表 + 误伤正片秒数 + 看到广告秒数
function simulate(frags, truth, opts = {}) {
    const LOOK = opts.look ?? 30, STEP = opts.step ?? 0.25;
    const groups = C.groupsFromFrags(frags);
    const total = groups[groups.length - 1].end;
    const res = Object.create(null), off = Object.create(null), overrides = Object.create(null), skipped = Object.create(null);
    const events = [];
    let t = opts.startAt ?? 0, bufFrom = t, guard = 0, userSeeked = !!opts.startAt;
    const learn = () => {
        const front = t + LOOK;
        for (const g of groups) {
            if (g.end <= bufFrom && !(t >= g.start && t < g.end)) continue;
            if (g.start > front) break;
            const tr = truth(g);
            if (tr.res) res[g.cc] = tr.res;
            if (tr.off != null) off[g.cc] = tr.off;
        }
    };
    const plan = (opts.userSeeks || []).slice().sort((a, b) => a.at - b.at);
    while (t < total && guard++ < 400000) {
        if (plan.length && t >= plan[0].at) {
            const p = plan.shift();
            userSeeked = true;
            const gi = C.findGroup(groups, p.to);
            if (gi >= 0 && skipped[groups[gi].cc] && p.to < t) { for (const cc of skipped[groups[gi].cc]) overrides[cc] = 1; events.push({ type: 'override', t: p.to }); }
            t = p.to; bufFrom = t;
        }
        learn();
        const d = C.decide(groups, cc => res[cc], t, opts.core, {
            offOf: cc => off[cc], overridden: g => !!overrides[g.cc], freshStart: !userSeeked, rate: opts.rate || 1
        });
        if (d.act === 'seek') {
            events.push({ type: 'seek', t, to: d.to, run: d.run, why: d.why });
            const ccs = [];
            for (let i = d.run.g0; i <= d.run.g1; i++) ccs.push(groups[i].cc);
            for (const cc of ccs) skipped[cc] = ccs;
            t = d.to; bufFrom = t;
            continue;
        }
        if (d.act === 'ended') { events.push({ type: 'ended', t, run: d.run, why: d.why }); break; }
        t += STEP * (opts.rate || 1);
    }
    // 误伤 = 动作跳过的非广告时长;漏看 = 播放头实际走过的广告时长(粗算:被跳过的广告不计)
    let contentLost = 0, adsCaught = new Set();
    for (const e of events) {
        if (e.type === 'override') continue;
        const from = e.t, to = e.type === 'ended' ? total : e.to;
        for (const g of groups) {
            const a = Math.max(from, g.start), b = Math.min(to, g.end);
            if (b <= a) continue;
            if (truth(g).ad) adsCaught.add(g.cc); else contentLost += b - a;
        }
    }
    return { groups, events, total, contentLost, adsCaught };
}

// ============ 1) 成龙历险记 95 集真实数据 ============
console.log('[1] rycj 成龙历险记 S1-S5:真实清单 + 真实分辨率 + 真实 PTS 偏移');
const JK = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/jackie-rycj.json'), 'utf8')).episodes;
ok(JK.length === 95, '夹具 95 集', JK.length);
const jkTruth = ep => {
    const frags = fragsFromGroups(ep.g);
    const groups = C.groupsFromFrags(frags);
    const byCc = new Map(groups.map((g, i) => [g.cc, i]));
    return { frags, groups, truth: g => { const i = byCc.get(g.cc); const ad = ep.ads.find(x => Math.abs(x.start - g.start) < 0.05); return { res: ad ? ad.res : ep.main, off: ep.off[i], ad: !!ad }; } };
};
let midSk = 0, tailEnd = 0, maxLate = 0, maxLost = 0;
for (const ep of JK) {
    const { frags, groups, truth } = jkTruth(ep);
    ok(ep.off.length === groups.length, ep.key + ' PTS 偏移逐组对齐');
    const r = simulate(frags, truth);
    const mids = ep.ads.filter(m => !m.tail), tails = ep.ads.filter(m => m.tail);
    for (const m of mids) {
        const e = r.events.find(x => x.type === 'seek' && Math.abs(x.run.start - m.start) < 0.05);
        ok(!!e, ep.key + ' 中插 @' + m.start + ' 被跳过', r.events.map(x => [x.type, +x.t.toFixed(2), x.why]));
        if (e) { midSk++; maxLate = Math.max(maxLate, e.t - m.start); ok(Math.abs(e.to - (m.start + m.dur + 0.1)) < 0.06, ep.key + ' 落点 = 段尾 + 0.1s', [e.to, m.start + m.dur]); }
    }
    for (const m of tails) {
        const e = r.events.find(x => x.type === 'ended');
        ok(!!e && Math.abs(e.run.start - m.start) < 0.05, ep.key + ' 片尾广告 → ended', r.events.map(x => [x.type, x.t, x.why]));
        if (e) tailEnd++;
    }
    ok(r.events.filter(e => e.type === 'seek').length === mids.length, ep.key + ' 没有多余的跳转', r.events.map(e => [e.type, e.t, e.run && e.run.dur]));
    maxLost = Math.max(maxLost, r.contentLost);
    ok(r.contentLost <= 0.26 * r.events.length, ep.key + ' 每次动作误伤正片 <= 0.26s', r.contentLost);
}
ok(midSk === 95 && tailEnd === 95, '95 段中插全跳、95 段片尾全结束', { midSk, tailEnd });
console.log(`    中插跳过 ${midSk}/95,片尾结束 ${tailEnd}/95,最晚 ${maxLate.toFixed(2)}s 后起跳,单集最多误伤正片 ${maxLost.toFixed(2)}s`);

// 用户场景(S1E01:中插 561.2+20,片尾 1240.24)
{
    const ep = JK.find(e => e.key === 'S1E01');
    const { frags, truth } = jkTruth(ep);
    let r = simulate(frags, truth, { userSeeks: [{ at: 100, to: 570 }] });
    let e = r.events.find(x => x.type === 'seek');
    ok(e && e.t >= 570 && e.t < 570.3 && Math.abs(e.to - 581.3) < 0.06, 'S1E01 第一次就拖进广告中段 → 时间戳重启确认后立即跳到段尾', r.events);
    r = simulate(frags, truth, { userSeeks: [{ at: 600, to: 565 }] });
    ok(r.events.filter(x => x.type === 'seek').length === 1 && r.events.some(x => x.type === 'override'), 'S1E01 跳过后用户往回拖进广告 → 放行不再跳', r.events.map(x => [x.type, x.t]));
    r = simulate(frags, truth, { userSeeks: [{ at: 600, to: 540 }, { at: 620, to: 540 }, { at: 640, to: 540 }, { at: 660, to: 540 }] });
    ok(r.events.filter(x => x.type === 'seek').length === 5 && !r.events.some(x => x.type === 'override'), 'S1E01 四次拖回广告之前重看 → 每次都照样跳(成功的跳过不算"失败尝试")', r.events.map(x => [x.type, +x.t.toFixed(1)]));
    r = simulate(frags, truth, { startAt: 1000 });
    ok(r.events.length === 1 && r.events[0].type === 'ended', 'S1E01 从 1000s 续看 → 只结束片尾广告', r.events.map(x => [x.type, x.t]));
    r = simulate(frags, truth, { look: 10 });
    e = r.events.find(x => x.type === 'seek');
    ok(e && r.contentLost <= 0.2, 'S1E01 预加载只有 10s(弱网)仍正确', { ev: r.events.map(x => [x.type, +x.t.toFixed(2)]), lost: r.contentLost });
    r = simulate(frags, truth, { rate: 2 });
    e = r.events.find(x => x.type === 'seek');
    ok(e && e.t <= 561.2 + 0.05 && r.contentLost <= 1.0, 'S1E01 2 倍速:提前量随倍速加大,不会先放一截广告', { t: e && e.t, lost: r.contentLost });
}

// ============ 2) 11 个源 117 集:精度(0 误跳)与召回 ============
console.log('[2] 11 个源 117 集(含同分辨率插播)');
{
    const MS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/multi-source.json'), 'utf8')).episodes;
    let ads = 0, caught = 0, lostTotal = 0, fpEps = [];
    const bySrc = {};
    for (const ep of MS) {
        const frags = fragsFromDurs(ep.g.map(x => x[0]));
        const groups = C.groupsFromFrags(frags);
        const truth = g => { const x = ep.g[g.cc]; return { res: x[1] || undefined, off: x[2] == null ? undefined : x[2] - g.start, ad: !!x[3] }; };
        const r = simulate(frags, truth);
        const nAds = ep.g.filter(x => x[3]).length;
        ads += nAds; caught += r.adsCaught.size; lostTotal += r.contentLost;
        const s = bySrc[ep.src] = bySrc[ep.src] || { ads: 0, caught: 0 };
        s.ads += nAds; s.caught += r.adsCaught.size;
        // 每次动作最多吃 landPad(0.1s)+提前量的正片;超过 0.5s 就是误跳了一段正片
        if (r.contentLost > 0.5 * Math.max(1, r.events.length)) fpEps.push([ep.key, +r.contentLost.toFixed(2), r.events.map(e => [e.type, +e.t.toFixed(1), e.why, e.run && +e.run.dur.toFixed(1)])]);
    }
    ok(fpEps.length === 0, '117 集里没有任何一集误跳正片', fpEps.slice(0, 5));
    const recall = caught / ads;
    ok(recall >= 0.9, '插播召回 >= 90%(只靠分辨率是 69%)', { caught, ads, recall: +recall.toFixed(3), bySrc });
    console.log(`    插播 ${caught}/${ads} 被跳过(${(recall * 100).toFixed(1)}%),正片总误伤 ${lostTotal.toFixed(1)}s(只算落点余量)`);
    console.log('    按源:', Object.entries(bySrc).map(([k, v]) => k + ' ' + v.caught + '/' + v.ads).join(' | '));
}

// ============ 3) worker 真实清单 + 合成分辨率/时间戳 ============
console.log('[3] worker 夹具');
const fixture = name => parseM3u8(fs.readFileSync(path.join(FIX, name), 'utf8'));
for (const name of fs.readdirSync(FIX).filter(n => n.endsWith('.m3u8'))) {
    const r = simulate(fixture(name), () => ({ res: '1920x1080', off: 1.4 }), {});
    ok(r.events.length === 0, name + ' 全片同一分辨率、时钟连续 → 零动作', r.events.slice(0, 3));
}
// 时钟模型:正片连续(偏移 base - 之前插播总长);插播首帧 1.45s
const clock = (groups, isAd) => {
    let shift = 0;
    const off = new Map();
    groups.forEach(g => { if (isAd(g)) { off.set(g.cc, 1.45 - g.start); shift += g.dur; } else off.set(g.cc, 1.4 - shift); });
    return off;
};
{
    const frags = fixture('1080zyk_dune.m3u8');
    const groups = C.groupsFromFrags(frags);
    const isAd = g => g.dur > 15.5 && g.dur < 18.5;
    const ads = groups.filter(isAd);
    const off = clock(groups, isAd);
    const r = simulate(frags, g => ({ res: isAd(g) ? '1920x1080' : '1920x800', off: off.get(g.cc), ad: isAd(g) }));
    ok(ads.length > 0 && r.adsCaught.size === ads.length, '1080zyk 型(1920x800 正片 + 1920x1080 棋牌):' + ads.length + ' 段全处理', { ads: ads.map(a => +a.start.toFixed(1)), ev: r.events.map(e => [e.type, +e.t.toFixed(1), e.why]) });
    ok(r.contentLost <= 0.2 * ads.length, '1080zyk 型误伤正片很少', r.contentLost);
    // 同分辨率(兰香如故 1080p 正片里的 1080p 棋牌):只能靠时间戳
    const r2 = simulate(frags, g => ({ res: '1920x1080', off: off.get(g.cc), ad: isAd(g) }));
    ok(r2.adsCaught.size === ads.length && r2.contentLost <= 0.2 * ads.length, '同分辨率插播:时间戳重启 + 架桥照样全跳', { caught: r2.adsCaught.size, ads: ads.length, ev: r2.events.map(e => [e.type, +e.t.toFixed(1), e.why]) });
}
{
    const frags = fixture('wsyzy_fhl1.m3u8');
    const groups = C.groupsFromFrags(frags);
    const oddCc = new Set(frags.filter(f => Math.abs(f.duration - 2) > 0.02 && f.start > 250 && f.start < 320).map(f => f.cc));
    const isAd = g => oddCc.has(g.cc);
    // 插播被随机 DISCONTINUITY 切成多组:同一段广告内时钟连续(首组重启)
    let adStart = null;
    const off = new Map();
    let shift = 0;
    groups.forEach(g => { if (isAd(g)) { if (adStart == null) adStart = g.start; off.set(g.cc, 1.45 + (g.start - adStart) - g.start); shift += g.dur; } else off.set(g.cc, 1.4 - shift); });
    const r = simulate(frags, g => ({ res: isAd(g) ? '1920x1080' : '1920x960', off: off.get(g.cc), ad: isAd(g) }));
    ok(oddCc.size > 0 && r.events.length >= 1 && r.events.every(e => isAd(groups[e.run.g0])), 'wsyzy 型(随机切块里藏 12s 中插)只跳广告组', r.events.map(e => [e.type, e.t, e.why, e.run.dur]));
}

// ============ 4) 对抗(宁可漏跳,绝不吃正片) ============
console.log('[4] 对抗');
const flat = (n, d) => Array.from({ length: n }, () => d);
const sim = (durs, resOf, offOf, opts) => {
    const frags = fragsFromDurs(durs);
    return simulate(frags, g => ({ res: resOf(g.cc, g), off: offOf ? offOf(g.cc, g) : 1.4, ad: false }), opts || {});
};
{
    // 正片里一组分辨率怪(1920x1088 编码 / 剪辑补丁),时钟连续 → 不跳(±5% 视为同一档;就算差很多,不架桥也不跳)
    let r = sim(flat(60, 20), cc => cc === 30 ? '1920x1088' : '1920x1080');
    ok(r.events.length === 0, '±8px 的怪组 → 同一档,不动', r.events);
    r = sim(flat(60, 20), cc => cc === 30 ? '1280x720' : '1920x1080');
    ok(r.events.length === 0, '正片里一组 720p、时钟连续(不架桥)→ 不动', r.events.map(e => [e.type, e.t, e.why]));
    // 合集:第 3 集 70s 换了分辨率、各集时钟各自从头开始(不架桥)
    const d = [].concat(flat(40, 30), [70], flat(40, 30));
    const starts = []; let t = 0; d.forEach(x => { starts.push(t); t += x; });
    r = sim(d, cc => cc === 40 ? '1280x720' : '1920x1080', cc => (cc <= 40 ? 1.4 : 1.4 + 0) - (cc >= 40 ? starts[40] : 0));
    ok(r.events.length === 0, '合集里一集换分辨率(>60s、各集时钟自立)→ 不动', r.events.map(e => [e.type, e.t, e.why]));
    // 片头 89s OP 换了分辨率 → 不跳(>15s);冷开场 30s 后的 89s OP → 不跳(不架桥、也 >60s)
    r = sim([89].concat(flat(60, 20)), cc => cc === 0 ? '1280x720' : '1920x1080');
    ok(r.events.length === 0, '片头 89s OP 换分辨率 → 不动(片头只跳 ≤15s 贴片)', r.events);
    r = sim([30, 89].concat(flat(60, 20)), cc => cc === 1 ? '1280x720' : '1920x1080');
    ok(r.events.length === 0, '冷开场后的 89s OP → 不动', r.events.map(e => [e.type, e.t, e.why]));
    // 片尾 60s 彩蛋 / 下集预告换分辨率,时钟连续 → 不结束整集
    r = sim(flat(60, 20).concat([60]), cc => cc === 60 ? '1280x720' : '1920x1080');
    ok(r.events.length === 0, '片尾 60s 彩蛋换分辨率 → 不结束整集', r.events.map(e => [e.type, e.t, e.why]));
    r = sim(flat(60, 20).concat([20]), cc => cc === 60 ? '1280x720' : '1920x1080');
    ok(r.events.length === 0, '片尾 20s 换分辨率但时钟连续(不是重启)→ 不结束整集', r.events.map(e => [e.type, e.t, e.why]));
    // 开头 6s 贴片(樱花型)→ 起播即跳;同样的段在续看/拖动后 → 不跳(只在刚开始播时)
    const pre = [6].concat(flat(80, 20));
    r = sim(pre, cc => cc === 0 ? '1854x1000' : '1280x720', cc => cc === 0 ? 1.45 : 1.4 - 6);
    ok(r.events.length === 1 && r.events[0].type === 'seek' && r.events[0].to < 6.2, '开头 6s 贴片 → 起播即跳', r.events.map(e => [e.type, e.t, e.to]));
    r = sim(pre, cc => cc === 0 ? '1854x1000' : '1280x720', cc => cc === 0 ? 1.45 : 1.4 - 6, { userSeeks: [{ at: 100, to: 2 }] });
    ok(!r.events.some(e => e.type === 'seek' && e.t >= 100), '拖回开头的贴片 → 不再自动跳(不是刚开始播)', r.events.map(e => [e.type, e.t]));
    // 片源分辨率花(非主分辨率占比大)→ 熔断
    r = sim(flat(60, 20), cc => (cc % 6 === 3) ? '1280x720' : '1920x1080', cc => 1.4);
    ok(r.events.length === 0, '每 6 组就有一组怪分辨率(片源本身花)→ 不动', r.events.slice(0, 3).map(e => [e.type, e.t, e.why]));
    // 同分辨率 + PTS 重启但不架桥(时间戳乱的片源)→ 不动
    r = sim(flat(60, 20), cc => '1920x1080', cc => cc === 30 ? 1.45 - 600 : 1.4);
    ok(r.events.length === 0, '同分辨率、PTS 重启但正片时钟没停(不架桥)→ 不动', r.events.map(e => [e.type, e.t, e.why]));
    // 偏移还没学到(INIT_PTS_FOUND 没来)→ 宁可不跳
    r = sim(flat(60, 20), cc => cc === 30 ? '1280x720' : '1920x1080', () => undefined);
    ok(r.events.length === 0, '时间戳未知 → 不跳(宁可漏跳)', r.events);
}
{
    const g4 = C.groupsFromFrags(fragsFromDurs(flat(40, 20)));
    const res = {};
    g4.forEach(g => { res[g.cc] = '1080x810'; });
    res[10] = '1280x720'; res[11] = 'mixed';
    const off = cc => cc < 10 ? 1.4 : cc === 10 ? 1.45 - 200 : 1.4 - 20;
    let d = C.decide(g4, res, g4[10].start + 1, null, { offOf: off });
    ok(d.act === 'none' && d.why === 'right-mixed', '邻组 mixed → 不动', d.why);
    res[11] = '1080x810';
    d = C.decide(g4, res, g4[10].start + 1, null, { offOf: off });
    ok(d.act === 'seek' && Math.abs(d.run.bridge) < 0.01, '右侧封口 + 架桥 → 跳', d);
    const res2 = Object.assign({}, res); delete res2[11];
    d = C.decide(g4, res2, g4[10].start + 1, null, { offOf: off });
    ok(d.act === 'wait' && d.why === 'open-right', '右侧组还没解析 → 等', d.why);
    d = C.decide(g4, res, g4[10].start + 1, null, { offOf: off, overridden: g => g.cc === 10 });
    ok(d.act === 'none' && d.why === 'user-override', '用户放行过的段 → 不动', d.why);
    d = C.decide(g4, res, g4[10].start + 1, null, { offOf: cc => cc === 11 ? undefined : off(cc) });
    ok(d.act === 'wait' && d.why === 'bridge-unknown', '后一组时间戳没到 → 等', d.why);
    ok(C.decide([], {}, 1).act === 'none' && C.decide(g4, res, NaN).act === 'none', '空数据 / NaN 时间 → 不动');
    ok(C.sameRes('1920x1080', '1920x1088') && !C.sameRes('1920x1080', '1920x960') && !C.sameRes('1926x1080', '1280x720'), 'sameRes:±5% 同档,宽银幕 960/800 与 1080 不同档');
}

// ============ 5) index.html / sw.js 接线(静态) ============
console.log('[5] 接线');
{
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
    const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
    const tag = html.match(/<script[^>]+src="libs\/js\/ad-clip-core\.js\?v=([^"]+)"[^>]*defer><\/script>/);
    ok(!!tag, 'index.html 以 defer 引入 ad-clip-core.js?v=');
    ok(tag && sw.indexOf("'./libs/js/ad-clip-core.js?v=" + tag[1] + "'") > 0, 'sw.js 预缓存同一个 ?v=(改库必须同步升版)');
    const ct = html.slice(html.indexOf('window._dgHlsCustomType = function'), html.indexOf('function buildOfflineHlsConfig()'));
    ok(/adClipSkip\.attach\(hls, video\)[\s\S]*hls\.loadSource\(video\.src\)/.test(ct), '唯一的 new Hls 处在 loadSource 之前挂 attach(要收 MANIFEST_PARSED)');
    ok(/window\.adClipSkip\.check\(dp\.video\.currentTime\)\) return;\s*\n\s*if \(dp\.video && window\.skipManager\) window\.skipManager\.check/.test(html), 'timeupdate 里去插播先于跳片头,动作了本 tick 直接 return');
    ok(/const playToken = \(this\._playToken = \(this\._playToken \|\| 0\) \+ 1\);\s*\n\s*try \{ if \(window\.adClipSkip\) window\.adClipSkip\.vue = this;/.test(html), 'play() 递增令牌后立刻交 vue(attach 读本次 _playToken)');
    const body = html.slice(html.indexOf('window.adClipSkip = {'), html.indexOf('let _lastProgressSaveTime'));
    ok(/E\.INIT_PTS_FOUND/.test(body) && /initPTS \/ d\.timescale/.test(body), '收 INIT_PTS_FOUND 记每组 PTS 偏移');
    ok(/vue\._outroSkipped = true/.test(body) && /st\.endedFired \|\| vue\._outroSkipped/.test(body), '片尾广告与跳片尾共用 _outroSkipped 闸门(不会连跳两集)');
    ok(/AdFilter\.isEnabled\(\)/.test(body), '跟随广告过滤开关');
    ok(/vue\._liveActive/.test(body) && /_activeKz\.type === 'mp4'/.test(body) && /_isCasting/.test(body) && /st\.live \|\| st\.multi/.test(body), '直播 / Kazumi MP4 / 投屏 / 多码率 不生效');
    ok(/st\.tok !== vue\._playToken \|\| vue\._activePlaySeq !== _navSeq/.test(body), '令牌守卫(旧实例/旧剧不动作)');
    ok(/sessionStorage/.test(body), '用户放行的段跨实例记住(切源/分诊/重开同一集不再跳)');
    ok(/buffered/.test(body), '落点必须已缓冲才 seek(不卡 2s)');
    ok(/maxBufferLength/.test(body), '发现候选段时临时加大预加载(长插播也能在播到前封口)');
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'}: ${pass} passed, ${fail} failed`);
if (fail) { console.log(fails.slice(0, 40).join('\n')); process.exitCode = 1; }
