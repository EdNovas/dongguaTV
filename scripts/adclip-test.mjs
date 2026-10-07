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

// 播放模拟。truth(g) -> { res, off, ad }。返回动作列表 + 误伤正片秒数 + 实际看到的广告秒数(watched)。
//   预加载窗口模型与运行时 _adjustBuffer 一致:平时 30s;刚学到"不像正片"的组(分辨率≠主 / PTS 重启)→ 75s;
//   播放头回到正片且前方没有未结的怪组 → 还原
function simulate(frags, truth, opts = {}) {
    const BASE = opts.look ?? 30, STEP = opts.step ?? 0.25;
    let LOOK = BASE, raised = false, mainRes = '';
    const groups = C.groupsFromFrags(frags);
    const total = groups[groups.length - 1].end;
    const res = Object.create(null), off = Object.create(null), overrides = Object.create(null), skipped = Object.create(null);
    const events = [];
    let t = opts.startAt ?? 0, bufFrom = t, guard = 0, userSeeked = !!opts.startAt;
    // opts.behind:原生 HLS 扫描器(iOS/Safari)自己取分片头,播放头所在组之前的 N 组也会探(hls.js 不会加载播放头之前的分片)
    const learn = () => {
        const front = t + LOOK;
        const gi = opts.behind ? C.findGroup(groups, t) : -1;
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            if (g.end <= bufFrom && !(t >= g.start && t < g.end) && !(gi >= 0 && i >= gi - opts.behind && i < gi)) continue;
            if (g.start > front) break;
            const tr = truth(g);
            if (tr.res) res[g.cc] = tr.res;
            if (tr.off != null) off[g.cc] = tr.off;
            if (!opts.noRaise && !raised && isOdd(g)) { raised = true; LOOK = Math.max(75, BASE); }
        }
    };
    const isOdd = g => {
        const r = res[g.cc], o = off[g.cc];
        return !!((r && mainRes && !C.sameRes(r, mainRes)) || (o != null && g.start > 30 && o + g.start < 5));
    };
    const watched = Object.create(null);
    const plan = (opts.userSeeks || []).slice().sort((a, b) => a.at - b.at);
    while (t < total && guard++ < 400000) {
        if (plan.length && t >= plan[0].at) {
            const p = plan.shift();
            userSeeked = true;
            const gi = C.findGroup(groups, p.to);
            let to = p.to;
            // 与运行时 _onSeeking 一致:广告绝不放行;刚跳过(段后 30s 内)往回拖进广告 → 按"广告时长为 0"换算到广告之前
            if (gi >= 0 && skipped[groups[gi].cc] && p.to < t) {
                const ccs = skipped[groups[gi].cc];
                const a = groups.find(g => g.cc === ccs[0]), b = groups.find(g => g.cc === ccs[ccs.length - 1]);
                if (t >= b.end && t - b.end < 30) { to = Math.max(0, a.start - (b.end - p.to)); events.push({ type: 'remap', t: p.to, to }); }
            }
            t = to; bufFrom = t;
        }
        learn();
        const d = C.decide(groups, cc => res[cc], t, opts.core, {
            offOf: cc => off[cc], overridden: g => !!overrides[g.cc], freshStart: !userSeeked, rate: opts.rate || 1
        });
        if (d.main && d.main.res) mainRes = d.main.res;
        if (raised && d.why === 'main' && !groups.some(g => g.start > t && (res[g.cc] || off[g.cc] != null) && isOdd(g))) { raised = false; LOOK = BASE; }
        if (d.act === 'seek') {
            events.push({ type: 'seek', t, to: d.to, run: d.run, why: d.why });
            const ccs = [];
            for (let i = d.run.g0; i <= d.run.g1; i++) ccs.push(groups[i].cc);
            for (const cc of ccs) skipped[cc] = ccs;
            t = d.to; bufFrom = t;
            continue;
        }
        if (d.act === 'ended') { events.push({ type: 'ended', t, run: d.run, why: d.why }); break; }
        const gw = C.findGroup(groups, t);
        if (gw >= 0 && truth(groups[gw]).ad) watched[groups[gw].cc] = (watched[groups[gw].cc] || 0) + STEP * (opts.rate || 1);
        t += STEP * (opts.rate || 1);
    }
    // 误伤 = 动作跳过的非广告时长;漏看 = 播放头实际走过的广告时长(粗算:被跳过的广告不计)
    let contentLost = 0, adsCaught = new Set();
    for (const e of events) {
        if (e.type === 'override' || e.type === 'remap') continue;
        const from = e.t, to = e.type === 'ended' ? total : e.to;
        for (const g of groups) {
            const a = Math.max(from, g.start), b = Math.min(to, g.end);
            if (b <= a) continue;
            if (truth(g).ad) adsCaught.add(g.cc); else contentLost += b - a;
        }
    }
    const maxWatched = Math.max(0, ...Object.values(watched));
    return { groups, events, total, contentLost, adsCaught, watched, maxWatched };
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
    ok(r.maxWatched <= 0.5, ep.key + ' 每段广告实际看到 <= 0.5s', r.watched);
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
    ok(r.events.some(x => x.type === 'remap') && r.events.filter(x => x.type === 'seek').length === 2 && r.maxWatched <= 0.5, 'S1E01 跳过后用户往回拖进广告 → 换算到广告之前(广告当 0 秒),再播到时照样跳,绝不放行', r.events.map(x => [x.type, +x.t.toFixed(1), x.to != null ? +x.to.toFixed(1) : '']));
    r = simulate(frags, truth, { userSeeks: [{ at: 1000, to: 570 }] });
    ok(r.events.filter(x => x.type === 'seek').length >= 1 && r.maxWatched <= 0.5 && !r.events.some(x => x.type === 'override'), 'S1E01 从很远处拖回广告中段 → 立即跳到段后(不放行)', r.events.map(x => [x.type, +x.t.toFixed(1)]));
    r = simulate(frags, truth, { userSeeks: [{ at: 600, to: 540 }, { at: 620, to: 540 }, { at: 640, to: 540 }, { at: 660, to: 540 }] });
    ok(r.events.filter(x => x.type === 'seek').length === 5 && !r.events.some(x => x.type === 'override'), 'S1E01 四次拖回广告之前重看 → 每次都照样跳(成功的跳过不算"失败尝试")', r.events.map(x => [x.type, +x.t.toFixed(1)]));
    r = simulate(frags, truth, { startAt: 1000 });
    ok(r.events.length === 1 && r.events[0].type === 'ended', 'S1E01 从 1000s 续看 → 只结束片尾广告', r.events.map(x => [x.type, x.t]));
    for (const at of [563, 565, 570, 575]) {
        r = simulate(frags, truth, { startAt: at });
        e = r.events.find(x => x.type === 'seek');
        ok(e && Math.abs(e.to - 581.3) < 0.06 && r.maxWatched <= 0.5, 'S1E01 续看直接落在广告中段 @' + at + ' → 立即跳(PTS 重启 + 右侧正片)', { ev: r.events.map(x => [x.type, x.t]), watched: r.watched });
    }
    r = simulate(frags, truth, { userSeeks: [{ at: 5, to: 566 }] });
    e = r.events.find(x => x.type === 'seek');
    ok(e && e.t < 567 && r.maxWatched <= 1, 'S1E01 开播 5s 就拖进广告中段 → 立即跳', { ev: r.events.map(x => [x.type, x.t]), watched: r.watched });
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
    let ads = 0, caught = 0, lostTotal = 0, fpEps = [], watchedTotal = 0, lateEps = [];
    const bySrc = {};
    for (const ep of MS) {
        const frags = fragsFromDurs(ep.g.map(x => x[0]));
        const groups = C.groupsFromFrags(frags);
        const truth = g => { const x = ep.g[g.cc]; return { res: x[1] || undefined, off: x[2] == null ? undefined : x[2] - g.start, ad: !!x[3] }; };
        const r = simulate(frags, truth);
        const nAds = ep.g.filter(x => x[3]).length;
        ads += nAds; caught += r.adsCaught.size; lostTotal += r.contentLost;
        watchedTotal += Object.values(r.watched).reduce((a, b) => a + b, 0);
        if (r.maxWatched > 1) lateEps.push([ep.key, r.watched]);
        const s = bySrc[ep.src] = bySrc[ep.src] || { ads: 0, caught: 0 };
        s.ads += nAds; s.caught += r.adsCaught.size;
        // 每次动作最多吃 landPad(0.1s)+提前量的正片;超过 0.5s 就是误跳了一段正片
        if (r.contentLost > 0.5 * Math.max(1, r.events.length)) fpEps.push([ep.key, +r.contentLost.toFixed(2), r.events.map(e => [e.type, +e.t.toFixed(1), e.why, e.run && +e.run.dur.toFixed(1)])]);
    }
    ok(fpEps.length === 0, '117 集里没有任何一集误跳正片', fpEps.slice(0, 5));
    const recall = caught / ads;
    ok(recall >= 0.9, '插播召回 >= 90%(只靠分辨率是 69%)', { caught, ads, recall: +recall.toFixed(3), bySrc });
    ok(lateEps.length === 0, '每段插播实际看到 <= 1s(右侧封口靠 75s 预加载及时到位)', lateEps.slice(0, 5));
    console.log(`    插播 ${caught}/${ads} 被跳过(${(recall * 100).toFixed(1)}%),实际看到广告共 ${watchedTotal.toFixed(1)}s,正片总误伤 ${lostTotal.toFixed(1)}s(只算落点余量)`);
    console.log('    按源:', Object.entries(bySrc).map(([k, v]) => k + ' ' + v.caught + '/' + v.ads).join(' | '));
}

// ============ 2b) 电影天堂(dytt)21 集:一段插播切成两组(PTS 重启组 + 同一时钟组) ============
console.log('[2b] 电影天堂 21 集(插播跨两组;1080p 剧集只能靠时间戳)');
{
    const DY = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/dytt.json'), 'utf8')).episodes;
    ok(DY.length >= 20, 'dytt 夹具 >= 20 集', DY.length);
    let ads = 0, runs = 0, caught = 0, fp = [], late = [], lostMax = 0, pRuns = 0;
    for (const ep of DY) {
        const frags = fragsFromDurs(ep.g.map(x => x[0]));
        for (const forceSame of [false, true]) {   // forceSame:把 720p 综艺也当成"全片同分辨率",逼 P 模式跨两组判
            const truth = g => { const x = ep.g[g.cc]; return { res: forceSame ? '1920x1080' : (x[1] || undefined), off: x[2] == null ? undefined : x[2] - g.start, ad: !!x[3] }; };
            const r = simulate(frags, truth);
            const nAd = ep.g.filter(x => x[3]).length;
            const nRun = ep.g.filter((x, i) => x[3] && !(i > 0 && ep.g[i - 1][3])).length;
            ads += nAd; runs += nRun; caught += r.adsCaught.size;
            const seeks = r.events.filter(e => e.type === 'seek');
            if (seeks.length !== nRun) fp.push([ep.key, forceSame, seeks.length, nRun, r.events.map(e => [e.type, +e.t.toFixed(1), e.why])]);
            if (r.maxWatched > 0.5) late.push([ep.key, forceSame, r.watched]);
            lostMax = Math.max(lostMax, r.contentLost / Math.max(1, seeks.length));
            pRuns += seeks.filter(e => e.run.mode === 'pts').length;
            ok(seeks.every(e => e.run.g1 === e.run.g0 + 1), ep.key + (forceSame ? '(同分辨率)' : '') + ' 每段都是两组一起跳', seeks.map(e => [e.run.g0, e.run.g1]));
        }
    }
    ok(caught === ads, 'dytt 插播组全部跳过', { caught, ads });
    ok(fp.length === 0, 'dytt 每集跳转次数 = 插播段数(无多余/遗漏)', fp.slice(0, 3));
    ok(late.length === 0, 'dytt 每段插播实际看到 <= 0.5s', late.slice(0, 3));
    ok(lostMax <= 0.26, 'dytt 每次跳转误伤正片 <= 0.26s', lostMax);
    ok(pRuns >= runs / 2, '同分辨率那一轮全部靠 P 模式(跨两组)跳', { pRuns, runs });
    console.log(`    插播 ${runs / 2} 段 / ${ads / 2} 组全跳(按实际分辨率一轮 + 全当同分辨率一轮;P 模式共 ${pRuns} 段),每次最多误伤正片 ${lostMax.toFixed(2)}s`);
}
// P 模式多组的对抗
{
    const mk = (spec) => {   // spec: [dur, kind] kind: 'c' 正片(接着主时钟)/'a' 插播首组(重启)/'b' 接着上一支插播的时钟/'e' 合集下一集(重启,后面正片接着它)
        const frags = fragsFromDurs(spec.map(s => s[0]));
        const groups = C.groupsFromFrags(frags);
        let mainShift = 0, adStart = null, epBase = null;
        const off = groups.map((g, i) => {
            const k = spec[i][1];
            if (k === 'a') { adStart = g.start; mainShift += g.dur; return 1.4667 - g.start; }
            if (k === 'b') { mainShift += g.dur; return 1.4667 + (g.start - adStart) - g.start; }
            if (k === 'e') { epBase = g.start; mainShift = 0; return 1.48 - g.start; }
            return epBase != null ? 1.48 - epBase - mainShift : 1.48 - mainShift;
        });
        return { frags, groups, truth: g => ({ res: '1920x1080', off: off[g.cc], ad: 'ab'.includes(spec[g.cc][1]) }) };
    };
    const C20 = n => Array.from({ length: n }, () => [20, 'c']);
    let m = mk([].concat(C20(15), [[8.5, 'a'], [10.566, 'b']], C20(30)));
    let r = simulate(m.frags, m.truth);
    ok(r.events.length === 1 && r.events[0].run.g0 === 15 && r.events[0].run.g1 === 16 && r.maxWatched <= 0.5, '两组插播(重启 + 同时钟)→ 一次跳过两组', r.events.map(e => [e.type, e.t, e.why, e.run.g0, e.run.g1]));
    // 续看/拖进第二组中间:hls.js 不加载播放头之前的分片 → 左侧未知,P 模式宁可不跳;
    //   原生扫描器会探播放头之前两组 → 往回认出重启组,整段一起判、立即跳到段尾
    r = simulate(m.frags, m.truth, { startAt: 15 * 20 + 8.5 + 3 });
    ok(r.events.length === 0, '落在插播第二组中间(hls.js:左侧未知)→ 不跳(宁可漏跳)', r.events.map(e => [e.type, e.t, e.why]));
    r = simulate(m.frags, m.truth, { startAt: 15 * 20 + 8.5 + 3, behind: 2 });
    ok(r.events.length === 1 && r.events[0].run.g0 === 15 && r.events[0].run.g1 === 16 && r.maxWatched <= 0.5, '落在插播第二组中间(原生扫描器探了前两组)→ 往回认出重启组,立即跳到段尾', r.events.map(e => [e.type, e.t, e.why, e.run.g0, e.run.g1]));
    r = simulate(m.frags, m.truth, { startAt: 15 * 20 + 2, behind: 2 });
    ok(r.events.length === 1 && r.events[0].run.g1 === 16 && r.maxWatched <= 0.5, '落在插播第一组中间(原生)→ 两组一起跳', r.events.map(e => [e.type, e.t, e.why, e.run.g0, e.run.g1]));
    // 背靠背两支(各自重启)
    m = mk([].concat(C20(15), [[8.5, 'a'], [6, 'b'], [10, 'a'], [5, 'b']], C20(30)));
    r = simulate(m.frags, m.truth);
    ok(r.events.length === 1 && r.events[0].run.g0 === 15 && r.events[0].run.g1 === 18, '背靠背两支插播(各自重启)→ 并成一段跳', r.events.map(e => [e.type, e.t, e.why, e.run.g0, e.run.g1]));
    // 链超过 45s → 不跳
    m = mk([].concat(C20(15), [[20, 'a'], [20, 'b'], [10, 'b']], C20(30)));
    r = simulate(m.frags, m.truth);
    ok(r.events.length === 0, '重启后同一时钟超过 45s → 不跳(不是插播,是正片换了时钟)', r.events.map(e => [e.type, e.t, e.why]));
    // 合集:第二集从 1.48s 重新开始,后面正片都接着它 → 不跳
    m = mk([].concat(C20(30), [[20, 'e']], C20(30)));
    r = simulate(m.frags, m.truth);
    ok(r.events.length === 0, '合集下一集时钟重新开始(后面一路同时钟)→ 不跳', r.events.map(e => [e.type, e.t, e.why]));
    // 合集第二集开头 20s 后紧跟一段插播:最早的重启组(下一集)架不上桥 → 改用插播自己的重启组
    m = mk([].concat(C20(30), [[20, 'e'], [8.5, 'a'], [10.566, 'b']], C20(30)));
    r = simulate(m.frags, m.truth);
    ok(r.events.length === 1 && r.events[0].run.g0 === 31 && r.events[0].run.g1 === 32 && r.contentLost <= 0.26, '合集下一集开头 20s 后的插播 → 只跳插播两组', r.events.map(e => [e.type, e.t, e.why, e.run.g0, e.run.g1]));
    // 审查构造(年轻时钟巧合架桥):广告 20s | 下一集开头 20s(重启)| 两组插播 | 下一集继续 → 只能跳插播两组,不能把下一集开头一起跳掉
    m = mk([].concat(C20(30), [[20, 'a'], [20, 'e'], [8.5, 'a'], [10.566, 'b']], C20(30)));
    r = simulate(m.frags, m.truth);
    ok(r.events.filter(e => e.type === 'seek').every(e => e.run.g0 === 32 && e.run.g1 === 33) && r.contentLost <= 0.26, '年轻时钟巧合架桥:不吃下一集开头(只跳插播两组)', { ev: r.events.map(e => [e.type, e.t, e.why, e.run.g0, e.run.g1]), lost: r.contentLost });
    r = simulate(m.frags, m.truth, { behind: 2, look: 75, noRaise: true });
    ok(r.contentLost <= 0.26, '年轻时钟巧合架桥(原生模式)也不吃正片', { ev: r.events.map(e => [e.type, e.t, e.why, e.run.g0, e.run.g1]), lost: r.contentLost });
    // 片头卡(单独编码、重启)→ 正片又重启 → 20s 后插播
    m = mk([].concat(C20(10), [[20, 'e'], [20, 'e'], [8.5, 'a'], [10.566, 'b']], C20(30)));
    r = simulate(m.frags, m.truth);
    ok(r.contentLost <= 0.26, '片头卡 + 重启正片 + 紧跟插播:不吃正片', { ev: r.events.map(e => [e.type, e.t, e.why, e.run.g0, e.run.g1]), lost: r.contentLost });
    // 片尾:单独编码的彩蛋被切成两组(重启 + 同时钟)→ 不能当片尾广告结束整集(片尾 P 模式只认单组)
    m = mk([].concat(C20(60), [[12, 'a'], [10, 'b']]));
    r = simulate(m.frags, g => Object.assign(m.truth(g), { ad: false }));
    ok(r.events.length === 0, '片尾两组重启片段(彩蛋/预告)→ 不结束整集', r.events.map(e => [e.type, e.t, e.why]));
    // 重启组后面接的组时间戳还没到 → 等,不先跳一半
    const F20 = n => Array.from({ length: n }, () => 20);
    const g4 = C.groupsFromFrags(fragsFromDurs([].concat(F20(15), [8.5, 10.566], F20(30))));
    const offs = g4.map((g, i) => i < 15 ? 1.48 : i === 15 ? 1.4667 - g.start : i === 16 ? 1.4667 + 8.5 - g.start : 1.48 - 19.066);
    let d = C.decide(g4, () => '1920x1080', g4[15].start + 1, null, { offOf: cc => cc === 16 ? undefined : offs[cc] });
    ok(d.act === 'wait', '插播第二组时间戳未到 → 等(不只跳第一组)', [d.act, d.why]);
    d = C.decide(g4, () => '1920x1080', g4[15].start + 1, null, { offOf: cc => offs[cc] });
    ok(d.act === 'seek' && d.run.g1 === 16 && Math.abs(d.run.bridge) < 0.01 && Math.abs(d.to - (g4[17].start + 0.1)) < 1e-6, '时间戳齐了 → 跳到两组之后', d);
}

// ============ 2d) 原生 HLS 扫描器的知识模型(往前固定探 75s、往回探两组)跑全部真实夹具:召回不降、0 误跳 ============
console.log('[2d] 原生扫描器模式(behind 2 / look 75)跑 rycj 95 集 + 11 源 117 集 + dytt 21 集');
{
    const NAT = { behind: 2, look: 75, noRaise: true };
    let bad = [], mids = 0, midHit = 0, tails = 0, tailHit = 0;
    for (const ep of JK) {
        const { frags, truth } = jkTruth(ep);
        const r = simulate(frags, truth, NAT);
        for (const m of ep.ads) {
            if (m.tail) { tails++; if (r.events.some(x => x.type === 'ended' && Math.abs(x.run.start - m.start) < 0.05)) tailHit++; }
            else { mids++; if (r.events.some(x => x.type === 'seek' && Math.abs(x.run.start - m.start) < 0.05)) midHit++; }
        }
        if (r.contentLost > 0.26 * Math.max(1, r.events.length) || r.maxWatched > 0.5) bad.push([ep.key, r.contentLost, r.watched]);
    }
    ok(midHit === mids && tailHit === tails, '原生模式 rycj 中插/片尾全中', { midHit, mids, tailHit, tails });
    const MS2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/multi-source.json'), 'utf8')).episodes;
    const DY2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/dytt.json'), 'utf8')).episodes;
    let ads = 0, caught = 0;
    for (const ep of MS2.concat(DY2)) {
        const frags = fragsFromDurs(ep.g.map(x => x[0]));
        const r = simulate(frags, g => { const x = ep.g[g.cc]; return { res: x[1] || undefined, off: x[2] == null ? undefined : x[2] - g.start, ad: !!x[3] }; }, NAT);
        ads += ep.g.filter(x => x[3]).length; caught += r.adsCaught.size;
        if (r.contentLost > 0.5 * Math.max(1, r.events.length) || r.maxWatched > 1) bad.push([ep.key, +r.contentLost.toFixed(2), r.events.map(e => [e.type, +e.t.toFixed(1), e.why])]);
    }
    ok(bad.length === 0, '原生模式:没有任何一集误跳正片 / 漏看 >1s', bad.slice(0, 4));
    ok(caught / ads >= 0.98, '原生模式插播召回 >= 98%', { caught, ads });
    console.log(`    rycj 中插 ${midHit}/${mids}、片尾 ${tailHit}/${tails};其余 ${caught}/${ads} 组`);
}

// ============ 2e) 播放前整份剪掉:planCuts(全知识)/ cutPlaylist / 时间轴换算 ============
console.log('[2e] planCuts / cutPlaylist / toCutTime');
{
    // 全部真实夹具:每组分辨率/偏移都已知时,剪掉的组 = 真值插播组,一个正片组都不剪
    let ads = 0, hit = 0, fpG = [];
    const chk = (key, groups, resOf, offOf, isAd) => {
        const cuts = C.planCuts(groups, resOf, null, { offOf });
        const cs = new Set(); cuts.forEach(c => { for (let i = c.g0; i <= c.g1; i++) cs.add(i); });
        groups.forEach((g, i) => { if (isAd(i)) { ads++; if (cs.has(i)) hit++; } else if (cs.has(i)) fpG.push([key, i]); });
        return cuts;
    };
    for (const ep of JK) {
        const { groups } = jkTruth(ep);
        const byCc = new Map(groups.map((g, i) => [g.cc, i]));
        const adIdx = new Set(groups.map((g, i) => ep.ads.some(a => Math.abs(a.start - g.start) < 0.05) ? i : -1).filter(i => i >= 0));
        chk(ep.key, groups, cc => { const i = byCc.get(cc); const a = ep.ads.find(x => Math.abs(x.start - groups[i].start) < 0.05); return a ? a.res : ep.main; }, cc => ep.off[byCc.get(cc)], i => adIdx.has(i));
    }
    for (const f of ['multi-source', 'dytt']) {
        for (const ep of JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/' + f + '.json'), 'utf8')).episodes) {
            const groups = C.groupsFromFrags(fragsFromDurs(ep.g.map(x => x[0])));
            chk(ep.key, groups, cc => ep.g[cc][1] || undefined, cc => ep.g[cc][2] == null ? undefined : ep.g[cc][2] - groups[cc].start, i => !!ep.g[i][3]);
        }
    }
    ok(hit === ads && fpG.length === 0, 'planCuts:233 集全知识下剪掉的组 = 全部插播组,0 个正片组', { hit, ads, fp: fpG.slice(0, 5) });
    console.log(`    剪掉插播组 ${hit}/${ads},误剪正片组 ${fpG.length}`);
    // 安全阀:剪掉超过 15% → 一段都不剪
    {
        const F20 = n => Array.from({ length: n }, () => 20);
        const durs = [].concat(F20(10), [20], F20(5), [20], F20(5));   // 2 段 20s 广告 / 全片 440s(9%)
        const g = C.groupsFromFrags(fragsFromDurs(durs));
        let shift = 0;
        const offs = g.map((x, i) => (i === 10 || i === 16) ? (shift += 20, 1.4667 - x.start) : 1.48 - shift);
        const resOf = cc => (cc === 10 || cc === 16) ? '1280x720' : '1920x1080';
        ok(C.planCuts(g, resOf, null, { offOf: cc => offs[cc] }).length === 2, 'planCuts:证据够 → 剪两段');
        ok(C.planCuts(g, resOf, { maxCutShare: 0.05 }, { offOf: cc => offs[cc] }).length === 0, 'planCuts:剪掉总长超过 maxCutShare → 一段都不剪');
        // 正片只有 30s、广告 20s:主分辨率证据不足(要 ≥ 2× 段长)→ 不剪
        const gs = C.groupsFromFrags(fragsFromDurs([15, 20, 15]));
        ok(C.planCuts(gs, cc => cc === 1 ? '1280x720' : '1920x1080', null, { offOf: cc => cc === 1 ? 1.4667 - 15 : (cc === 0 ? 1.48 : 1.48 - 20) }).length === 0, 'planCuts:主分辨率证据不足 → 宁可不剪');
        ok(C.planCuts([], () => '', null, {}).length === 0, 'planCuts:空 → 空');
    }
    // cutPlaylist:真实的兰香如故第 1 集清单(分片名脱敏)
    const raw = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/dytt-lxrg1.m3u8'), 'utf8');
    const BASE = 'https://cdn.example/20260911/x/3000k/hls/mixed.m3u8';
    const fr = parseM3u8(raw), gg = C.groupsFromFrags(fr);
    const lx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/dytt.json'), 'utf8')).episodes.find(e => e.key === 'dytt_lxrg_0');
    ok(lx.g.length === gg.length && lx.g.every((x, i) => Math.abs(x[0] - gg[i].dur) < 0.01), '清单夹具与 dytt 夹具逐组对齐');
    const cuts = C.planCuts(gg, cc => { const i = gg.findIndex(x => x.cc === cc); return lx.g[i][1]; }, null, { offOf: cc => { const i = gg.findIndex(x => x.cc === cc); return lx.g[i][2] - gg[i].start; } });
    ok(cuts.length === 2 && Math.abs(cuts[0].start - 298) < 0.01 && Math.abs(cuts[0].dur - 19.066) < 0.01 && Math.abs(cuts[1].dur - 15.766) < 0.01, '兰香如故:剪 298s+19.07 与 1515.9s+15.77 两段', cuts.map(c => [c.start, c.dur]));
    const ccs = []; cuts.forEach(c => { for (let k = c.cc0; k <= c.cc1; k++) ccs.push(k); });
    const cut = C.cutPlaylist(raw, BASE, ccs);
    ok(cut && cut.kept === 699 && cut.removed === 9 && Math.abs(cut.removedDur - 34.832) < 0.01, 'cutPlaylist:删 9 片 34.83s,留 699 片', cut && [cut.kept, cut.removed, cut.removedDur]);
    const cf = parseM3u8(cut.text);
    const total0 = fr.reduce((a, f) => a + f.duration, 0), total1 = cf.reduce((a, f) => a + f.duration, 0);
    ok(Math.abs(total0 - total1 - 34.832) < 0.01, '剪后总时长 = 原时长 - 广告');
    ok(cut.text.split('\n').filter(l => l && l[0] !== '#').every(l => /^https:\/\/cdn\.example\/20260911\/x\/3000k\/hls\/seg\d+\.ts\?hash=x$/.test(l)), '分片地址全部变成绝对地址(保留查询串)');
    ok(/#EXT-X-ENDLIST\n$/.test(cut.text) && /^#EXTM3U\n#EXT-X-VERSION:3\n/.test(cut.text) && !/\n\n/.test(cut.text), '清单头/ENDLIST 保留,无空行');
    ok((cut.text.match(/#EXT-X-DISCONTINUITY\n/g) || []).length === (raw.match(/#EXT-X-DISCONTINUITY\r?\n/g) || []).length - 4, 'DISCONTINUITY 随被删的 4 组一起删掉,剩下的组之间仍各有一个');
    ok(!/seg5[0-9]\.ts/.test('') && !cut.text.includes('/seg' + fr.find(f => f.cc === cuts[0].cc0).sn + '.ts'), '被剪组的分片不在新清单里');
    // 剪后再分组:与"原分组去掉被剪组"一致
    const g2 = C.groupsFromFrags(cf);
    ok(g2.length === gg.length - 4 && Math.abs(g2[9].start - gg[11].start + 19.066) < 0.01, '剪后分组 = 原分组去掉 4 组,后面整体前移');
    // 拒绝:加密 / fMP4 / BYTERANGE / 非 VOD / 全剪光
    ok(C.cutPlaylist(raw.replace('#EXT-X-TARGETDURATION', '#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXT-X-TARGETDURATION'), BASE, ccs) === null, 'cutPlaylist:加密清单不处理');
    ok(C.cutPlaylist(raw.replace('#EXT-X-TARGETDURATION', '#EXT-X-MAP:URI="i.mp4"\n#EXT-X-TARGETDURATION'), BASE, ccs) === null, 'cutPlaylist:fMP4 不处理');
    ok(C.cutPlaylist(raw.replace('#EXT-X-ENDLIST', ''), BASE, ccs) === null, 'cutPlaylist:没有 ENDLIST(直播/未完)不处理');
    ok(C.cutPlaylist(raw, BASE, gg.map(g => g.cc)) === null, 'cutPlaylist:绝不交出 0 分片清单');
    const same = C.cutPlaylist(raw, BASE, []);
    ok(same && same.kept === 708 && same.removed === 0, 'cutPlaylist:没有要剪的 → 原样(只改绝对地址)');
    // 时间轴换算
    ok(Math.abs(C.toCutTime(100, cuts) - 100) < 1e-9 && Math.abs(C.toCutTime(305, cuts) - 298) < 1e-9 && Math.abs(C.toCutTime(1600, cuts) - (1600 - 34.832)) < 0.01, 'toCutTime:剪点前不变 / 落在广告里 → 广告起点 / 之后整体前移');
    ok([0, 100, 297.9, 298, 400, 1500, 1515.9, 1600, 2700].every(x => Math.abs(C.fromCutTime(C.toCutTime(x, cuts), cuts) - x) < 1e-6 || (x >= cuts[0].start && x < cuts[0].end)), 'fromCutTime ∘ toCutTime = 恒等(广告内除外)');
    ok(Math.abs(C.fromCutTime(298, cuts) - (298 + 19.066)) < 0.01, 'fromCutTime:剪后 298s = 原 317.07s(广告后第一帧)');
}

// ============ 2c) probeTs:从分片开头读首帧 PTS + 分辨率(原生 HLS 用) ============
console.log('[2c] probeTs');
{
    const TS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/ts-heads.json'), 'utf8')).samples;
    for (const s of TS) {
        const b = Buffer.from(s.b64, 'base64');
        const p = C.probeTs(new Uint8Array(b));
        ok(p && Math.abs(p.pts - s.pts) < 1e-6 && p.width === s.width && p.height === s.height && p.codec === 'avc', 'probeTs ' + s.label, p);
        // 伪装头(分片前面垫 PNG 文件头等)
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(112, 7), b]);
        const p2 = C.probeTs(new Uint8Array(png));
        ok(p2 && Math.abs(p2.pts - s.pts) < 1e-6 && p2.width === s.width, 'probeTs 伪装头 + ' + s.label, p2);
        // ArrayBuffer 输入
        const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
        ok(C.probeTs(ab) && C.probeTs(ab).width === s.width, 'probeTs 接受 ArrayBuffer ' + s.label);
    }
    const b0 = Buffer.from(TS[0].b64, 'base64');
    ok(C.probeTs(new Uint8Array(b0.subarray(0, 188 * 2))) === null, '只有 PAT/PMT、没有视频包 → null');
    const rnd = new Uint8Array(16384); for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 2654435761 >>> 13) & 255;
    ok(C.probeTs(rnd) === null, '加密/非 TS 数据 → null');
    ok(C.probeTs(new Uint8Array(0)) === null && C.probeTs(new Uint8Array(100)) === null, '空 / 过短 → null');
    // HEVC:PMT 里的 stream_type 改成 0x24 → 只给 PTS,不给宽高(不解析 HEVC SPS)
    const hv = Buffer.from(b0);
    const pmtAt = 188;
    const idx = hv.indexOf(0x1b, pmtAt + 4);
    ok(idx > 0 && idx < pmtAt + 188, 'PMT 里找到 H.264 stream_type');
    hv[idx] = 0x24;
    const ph = C.probeTs(new Uint8Array(hv));
    ok(ph && ph.codec === 'hevc' && ph.width === 0 && Math.abs(ph.pts - TS[0].pts) < 1e-6, 'HEVC → 只有 PTS', ph);
    // 第一个视频 PES 的包带很长的适配域,PES 头跨到下一个包 → null(不抛、不改读下一帧)
    {
        const bb = Buffer.from(b0);
        let vp = -1;
        for (let p = 0; p + 188 <= bb.length; p += 188) { const pu = bb[p + 1] & 0x40, af = (bb[p + 3] >> 4) & 3; const o2 = p + 4 + (af === 3 ? 1 + bb[p + 4] : 0); if (pu && bb[o2] === 0 && bb[o2 + 1] === 0 && bb[o2 + 2] === 1 && bb[o2 + 3] >= 0xe0) { vp = p; break; } }
        ok(vp > 0, '找到首个视频 PES 包');
        for (const L of [172, 176, 182]) {
            const pk = Buffer.from(bb.subarray(vp, vp + 188));
            const af = (pk[3] >> 4) & 3, o2 = 4 + (af === 3 ? 1 + pk[4] : 0);
            const payload = Buffer.from(pk.subarray(o2));
            const out = Buffer.alloc(188, 0xff);
            out[0] = 0x47; out[1] = pk[1]; out[2] = pk[2]; out[3] = (pk[3] & 0xcf) | 0x30; out[4] = L; out[5] = 0;
            payload.copy(out, 5 + L, 0, 188 - 5 - L);
            const t2 = Buffer.concat([bb.subarray(0, vp), out, bb.subarray(vp + 188)]);
            let th = false, pr;
            try { pr = C.probeTs(new Uint8Array(t2)); } catch (e) { th = true; }
            ok(!th && pr === null, 'PES 头跨包(适配域 ' + L + ')→ null 不抛', { th, pr });
        }
    }
    // SPS 读坏(全 0)→ 不出假分辨率、不卡死
    {
        const bz = Buffer.from(b0);
        const at = bz.indexOf(Buffer.from([0, 0, 1, 0x67]));
        ok(at > 0, '样本里找到 SPS');
        bz.fill(0, at + 4, Math.min(bz.length, at + 4 + 60));
        const t0 = Date.now();
        const pz = C.probeTs(new Uint8Array(bz));
        ok(pz && pz.width === 0 && Date.now() - t0 < 200, '坏 SPS → 只给 PTS、宽高 0(不拼假分辨率)', pz);
    }
    // 截断在 SPS 中间:宽高读不出来不能抛
    let threw = false, pt = null;
    try { pt = C.probeTs(new Uint8Array(b0.subarray(0, 188 * 2 + 40))); } catch (e) { threw = true; }
    ok(!threw, '截断的视频包不抛异常', pt);
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
    // 早段插播不能被熔断挡掉(熔断不计正在判的段、也不计已架桥确认的插播)
    {
        const mkAds = (adList, n) => {
            const d = [];
            let tt = 0;
            const isAd = [];
            while (tt < 1300) {
                const a = adList.find(x => Math.abs(x.at - tt) < 10 && !x.used);
                if (a) { a.used = true; d.push(a.dur); isAd.push(true); tt += a.dur; continue; }
                d.push(20); isAd.push(false); tt += 20;
            }
            const frags = fragsFromDurs(d);
            const groups = C.groupsFromFrags(frags);
            let shift = 0;
            const offs = groups.map((g, i) => { if (isAd[i]) { shift += g.dur; return 1.45 - g.start; } return 1.4 - shift; });
            return simulate(frags, g => ({ res: isAd[g.cc] ? '1920x1080' : '1920x800', off: offs[g.cc], ad: isAd[g.cc] }));
        };
        let r = mkAds([{ at: 240, dur: 44 }]);
        ok(r.adsCaught.size === 1 && r.maxWatched <= 0.5, '250s 处 44s 长插播(最大资源型)→ 及时跳过', { ev: r.events.map(e => [e.type, e.t, e.why]), watched: r.watched });
        r = mkAds([{ at: 140, dur: 25 }, { at: 260, dur: 25 }]);
        ok(r.adsCaught.size === 2 && r.maxWatched <= 0.5, '150s/260s 两段 25s 插播 → 都跳过(熔断不误伤)', { ev: r.events.map(e => [e.type, e.t, e.why]), watched: r.watched });
    }
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
    ok(!/sessionStorage/.test(body) && !/看广告/.test(html) && !/dg-adclip-undo/.test(html), '广告不能被放行:没有"看广告"按钮、没有跨实例放行记录');
    ok(!/dp\.notice\(/.test(body) && !/dp\.seek\(to\)/.test(body.replace(/catch \(e\) \{ try \{ dp\.seek\(to\)/, '')), '跳过是静默的:不弹提示、不走 DPlayer.seek(它自带"快进 N 秒"提示)');
    ok(/buffered/.test(body), '落点必须已缓冲才 seek(不卡 2s)');
    ok(/maxBufferLength/.test(body), '发现候选段时临时加大预加载(长插播也能在播到前封口)');
}

// ============ 6) 原生 HLS 扫描器端到端(从 index.html 抽出 window.adClipSkip,桩 video/dp/fetch) ============
console.log('[6] 原生 HLS 扫描器端到端');
{
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
    const body = html.slice(html.indexOf('window.adClipSkip = {'), html.indexOf('let _lastProgressSaveTime'));
    const TS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/ts-heads.json'), 'utf8')).samples;
    const DY = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/dytt.json'), 'utf8')).episodes;
    // 真实分片头(PAT/PMT/SPS)+ 改写首个视频 PES 的 PTS
    const tsWith = (sample, pts) => {
        const b = Buffer.from(sample.b64, 'base64');
        const want = Math.round(pts * 90000);
        const p0 = C.probeTs(new Uint8Array(b));
        for (let p = 0; p + 188 <= b.length; p += 188) {
            const pusi = b[p + 1] & 0x40, afc = (b[p + 3] >> 4) & 3;
            let off = p + 4; if (afc === 3) off += 1 + b[p + 4];
            if (!pusi || b[off] !== 0 || b[off + 1] !== 0 || b[off + 2] !== 1 || !(b[off + 3] >= 0xe0 && b[off + 3] <= 0xef)) continue;
            const x = off + 9;
            b[x] = (b[x] & 0xf0) | ((Math.floor(want / 1073741824) & 7) << 1) | 1;
            b[x + 1] = Math.floor(want / 4194304) & 0xff;
            b[x + 2] = ((Math.floor(want / 32768) & 0x7f) << 1) | 1;
            b[x + 3] = Math.floor(want / 128) & 0xff;
            b[x + 4] = ((want & 0x7f) << 1) | 1;
            break;
        }
        const p1 = C.probeTs(new Uint8Array(b));
        if (!p1 || Math.abs(p1.pts - pts) > 1e-4 || p1.width !== p0.width) throw new Error('tsWith 改写失败');
        return new Uint8Array(b);
    };
    const S1080 = TS.find(s => s.width === 1920), S720 = TS.find(s => s.width === 1280);
    async function runNative(ep, opts = {}) {
        // 清单:每组一片(分片粒度不影响判定),主清单单码率 → 媒体清单
        let m3u = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:60\n#EXT-X-PLAYLIST-TYPE:VOD\n';
        const segs = new Map();
        let t = 0;
        ep.g.forEach((x, i) => {
            if (i > 0) m3u += '#EXT-X-DISCONTINUITY\n';
            m3u += '#EXTINF:' + x[0].toFixed(3) + ',\nseg' + i + '.ts?hash=abc\n';
            segs.set('https://cdn.example/hls/seg' + i + '.ts?hash=abc', tsWith(x[1] === '1280x720' ? S720 : S1080, x[2]));
            t += x[0];
        });
        m3u += '#EXT-X-ENDLIST\n';
        const total = t;
        const MASTER = 'https://vip.example/ep/index.m3u8', MEDIA = 'https://cdn.example/hls/mixed.m3u8';
        const reqs = [];
        const fetchStub = async (url, o) => {
            reqs.push([url, o && o.headers && o.headers.Range]);
            if (opts.failPlaylist && !/\.ts/.test(url)) throw new TypeError('Failed to fetch');
            if (opts.rejectRange && o && o.headers && o.headers.Range) throw new TypeError('Preflight response is not successful');   // Safari ≤15:Range 要预检,CDN 预检不放行
            if (url === MASTER) return { ok: true, status: 200, url: MASTER, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1920x1080\nhttps://cdn.example/hls/mixed.m3u8\n' };
            if (url === MEDIA) return { ok: true, status: 200, url: MEDIA, text: async () => m3u };
            const s = segs.get(url);
            if (!s || opts.failSegs) throw new TypeError('Failed to fetch');
            const n = o && o.headers && o.headers.Range ? +o.headers.Range.split('-')[1] + 1 : s.length;
            const data = s.subarray(0, n);
            if (opts.noReader) return { ok: true, status: 206, url, body: null, arrayBuffer: async () => data.slice().buffer };
            let pos = 0;   // 分块读(模拟流式),读够即 cancel
            return { ok: true, status: 206, url, body: { getReader: () => ({ read: async () => pos >= data.length ? { done: true } : { done: false, value: data.subarray(pos, (pos += 500)) }, cancel: () => Promise.resolve() }) } };
        };
        let clock = 0;
        const seeks = [], notices = [], dpSeeks = [];
        // 播放器之外的 currentTime 赋值 = adClipSkip 的静默 seek(循环推进时间走 _t)
        const video = { src: MASTER, _t: opts.startAt || 0, get currentTime() { return this._t; }, set currentTime(x) { seeks.push([+this._t.toFixed(2), +x.toFixed(2)]); this._t = x; }, paused: false, seeking: false, ended: false, readyState: 4, duration: total, playbackRate: 1, _adClipSeekHooked: false, addEventListener() { } };
        const dpStub = { video, plugins: {}, container: null, seek(x) { dpSeeks.push(x); video.currentTime = x; }, notice(m) { notices.push(m); }, events: { trigger() { } }, bar: { set() { } }, danmaku: { seek() { } } };
        const win = { AdClipCore: C, AdFilter: { isEnabled: () => true }, fetch: fetchStub };
        const store = new Map();
        const ls = { getItem: k => (k === 'donggua_adclip_off' && opts.off) ? '1' : null };
        const ss = { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v) };
        const make = new Function('window', 'AdClipCore', 'dp', 'localStorage', 'sessionStorage', 'performance', 'fetch', '_navSeq', 'URL', 'AbortController', 'console',
            body + '\nreturn window.adClipSkip;');
        const quiet = { log() { }, warn() { } };
        const skip = make(win, C, dpStub, ls, ss, { now: () => clock }, fetchStub, 1, URL, AbortController, quiet);
        const marks = [];
        skip.vue = { _playToken: 1, _activePlaySeq: 1, _liveActive: false, _activeKz: null, _isCasting: () => false, _outroSkipped: false, currentSource: { site_key: 'dyttzy' }, _clipNativeSet: (k, bad) => marks.push([k, bad]) };
        const tick = () => new Promise(r => setImmediate(r));
        skip.attachNative(video, { events: { on() { } } });
        for (let k = 0; k < 6; k++) await tick();
        let watchedAd = 0, maxRun = 0;
        const adAt = x => { let s = 0; for (const g of ep.g) { if (x >= s && x < s + g[0]) return !!g[3]; s += g[0]; } return false; };
        while (video.currentTime < total - 0.3) {
            skip.check(video.currentTime);
            for (let k = 0; k < 3; k++) await tick();
            if (adAt(video.currentTime)) { watchedAd += 0.25; maxRun = Math.max(maxRun, watchedAd); } else watchedAd = 0;
            video._t += 0.25; clock += 250;
        }
        const st = video._adClipNative;
        return { seeks, notices, dpSeeks, reqs, st, maxRun, marks, status: skip.status && (dpStub.video = video, skip.status()) };
    }
    const lx = DY.find(e => e.key === 'dytt_lxrg_0');   // 1080p 剧集:同分辨率,只能靠时间戳(P 模式跨两组)
    let r = await runNative(lx);
    const adStarts = []; { let s = 0; lx.g.forEach((g, i) => { if (g[3] && !(i > 0 && lx.g[i - 1][3])) adStarts.push(s); s += g[0]; }); }
    ok(r.seeks.length === adStarts.length && r.seeks.every((s, i) => s[0] >= adStarts[i] - 0.3 && s[0] <= adStarts[i] + 0.3), '原生:兰香如故两段 1080p 插播都在开头就跳', { seeks: r.seeks, adStarts });
    ok(r.maxRun <= 0.5, '原生:每段广告实际看到 <= 0.5s', r.maxRun);
    ok(r.notices.length === 0 && r.dpSeeks.length === 0, '原生:静默跳过 —— 不弹提示、不走 dp.seek(它会弹"快进 N 秒")', { notices: r.notices, dpSeeks: r.dpSeeks });
    const segReqs = r.reqs.filter(x => /\.ts/.test(x[0]));
    ok(segReqs.every(x => x[1] === 'bytes=0-16383'), '原生:分片请求全是 Range 前 16KB', segReqs.slice(0, 3));
    ok(new Set(segReqs.map(x => x[0])).size === segReqs.length, '原生:每组首片只探一次', segReqs.length);
    ok(segReqs.length <= lx.g.length, '原生:最多探全部组数(' + lx.g.length + ')', segReqs.length);
    const vr = DY.find(e => e.g.some(x => x[1] === '1280x720') && e.g.filter(x => x[3]).length >= 4);   // 720p 综艺 + 1080p 插播(R 模式)
    r = await runNative(vr, { noReader: true });
    const vStarts = []; { let s = 0; vr.g.forEach((g, i) => { if (g[3] && !(i > 0 && vr.g[i - 1][3])) vStarts.push(s); s += g[0]; }); }
    ok(r.seeks.length === vStarts.length && r.maxRun <= 0.5, '原生:' + vr.title + ' 分辨率突变的插播全跳(无 ReadableStream 也行)', { seeks: r.seeks, vStarts });
    // 续看落在插播第二组中间:原生会探往回两组 → 认出重启组 → 立即跳
    const second = (() => { let s = 0; for (let i = 0; i < lx.g.length; i++) { if (lx.g[i][3] && i > 0 && lx.g[i - 1][3]) return s + 2; s += lx.g[i][0]; } })();
    r = await runNative(lx, { startAt: second });
    ok(r.seeks.length >= 1 && Math.abs(r.seeks[0][0] - second) < 1 && r.maxRun <= 1, '原生:续看落在插播第二组中间 → 立即跳到段尾', { seeks: r.seeks.slice(0, 2), second });
    // 清单跨域拿不到 / 分片读不到 / 用户关掉 → 不跳、不抛
    r = await runNative(lx, { failPlaylist: true });
    ok(r.seeks.length === 0 && r.st && r.st.failed, '原生:清单拿不到 → 本集不跳', { seeks: r.seeks.length, failed: r.st && r.st.failed });
    r = await runNative(lx, { failSegs: true });
    ok(r.seeks.length === 0 && r.st && r.st.failed, '原生:分片头读不到 → 连续失败后停探、不跳', { seeks: r.seeks.length, failed: r.st && r.st.failed });
    ok(r.reqs.filter(x => /\.ts/.test(x[0])).length <= 14, '原生:分片头读不到时不会无限重试', r.reqs.filter(x => /\.ts/.test(x[0])).length);
    // Safari ≤15:带 Range 的跨域请求预检失败 → 去掉 Range 重试(读够 16KB 即断),之后本集分片直接不带 Range
    r = await runNative(lx, { rejectRange: true });
    ok(r.seeks.length === adStarts.length && r.maxRun <= 0.5, '原生:Range 被拒(Safari ≤15)→ 去掉 Range 重试,照样全跳', { seeks: r.seeks, adStarts });
    const rr = r.reqs.filter(x => /\.ts/.test(x[0]));
    ok(rr.filter(x => x[1]).length <= 2 && rr.slice(2).every(x => !x[1]), '原生:Range 最多试并发数那么多次,之后本集分片直接不带 Range', rr.slice(0, 4));
    // 记账:扫描成功 → 消账(bad=false);清单/分片读不到 → 记账(bad=true)
    r = await runNative(lx);
    ok(r.marks.length === 1 && r.marks[0][0] === 'dyttzy' && r.marks[0][1] === false, '原生:扫描成功 → 该站消账(只报一次)', r.marks);
    r = await runNative(lx, { failPlaylist: true });
    ok(r.marks.length === 1 && r.marks[0][1] === true, '原生:清单拿不到 → 该站记账(线路改标有插播)', r.marks);
    r = await runNative(lx, { failSegs: true });
    ok(r.marks.some(m => m[1] === true) && !r.marks.some(m => m[1] === false), '原生:分片头一直读不到 → 记账', r.marks);
    r = await runNative(lx, { off: true });
    ok(r.seeks.length === 0 && r.reqs.length === 0, '原生:donggua_adclip_off=1 → 完全不拉', r.reqs.length);
}

// ============ 6b) 播放前剪清单端到端(window.adCut + _CutHlsLoader + 原生占位交付,桩 fetch) ============
console.log('[6b] 播放前剪清单端到端');
{
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
    const body = html.slice(html.indexOf('window.adClipSkip = {'), html.indexOf('let _lastProgressSaveTime'));
    const ctSrc = html.slice(html.indexOf('window._dgHlsCustomType = function'), html.indexOf('// 🛡️ 去插播:按"分辨率突变"跳过藏在正片里的插播广告'));
    const TS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/ts-heads.json'), 'utf8')).samples;
    const DY = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/dytt.json'), 'utf8')).episodes;
    const lx = DY.find(e => e.key === 'dytt_lxrg_0');
    const RAW = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adclip/dytt-lxrg1.m3u8'), 'utf8');
    const MEDIA = 'https://cdn.example/20260911/x/3000k/hls/mixed.m3u8';
    const pm = C.parseMedia(RAW, MEDIA);
    const S1080 = TS.find(s => s.width === 1920), S720 = TS.find(s => s.width === 1280);
    const tsWith = (sample, pts) => {   // 真实 PAT/PMT/SPS + 改写首个视频 PES 的 PTS
        const b = Buffer.from(sample.b64, 'base64'), want = Math.round(pts * 90000);
        for (let p = 0; p + 188 <= b.length; p += 188) {
            const pusi = b[p + 1] & 0x40, afc = (b[p + 3] >> 4) & 3; let off = p + 4; if (afc === 3) off += 1 + b[p + 4];
            if (!pusi || b[off] !== 0 || b[off + 1] !== 0 || b[off + 2] !== 1 || !(b[off + 3] >= 0xe0 && b[off + 3] <= 0xef)) continue;
            const x = off + 9;
            b[x] = (b[x] & 0xf0) | ((Math.floor(want / 1073741824) & 7) << 1) | 1; b[x + 1] = Math.floor(want / 4194304) & 0xff;
            b[x + 2] = ((Math.floor(want / 32768) & 0x7f) << 1) | 1; b[x + 3] = Math.floor(want / 128) & 0xff; b[x + 4] = ((want & 0x7f) << 1) | 1;
            break;
        }
        return new Uint8Array(b);
    };
    // 每个分片:所在组的首帧 PTS + 组内前面分片时长之和;分辨率按组(夹具)
    const segData = new Map(), mixBad = new Set();
    pm.groups.forEach((g, gi) => {
        let acc = 0;
        for (let s = g.sn0; s < g.sn0 + g.n; s++) {
            const f = pm.frags[s];
            segData.set(f.url, () => tsWith(lx.g[gi][1] === '1280x720' ? S720 : S1080, lx.g[gi][2] + acc + (mixBad.has(gi) && s === g.sn0 + g.n - 1 ? 250 : 0)));
            acc += f.duration;
        }
    });
    const mkEnv = (opts = {}) => {
        const reqs = [], posts = [], lsMap = new Map(opts.ls || []);
        const fetchStub = async (url, o) => {
            reqs.push([url, o && o.headers && o.headers.Range, o && o.method]);
            if (o && o.method === 'POST') {
                posts.push(JSON.parse(o.body));
                if (opts.postFail) return { ok: false, status: 503, json: async () => ({}) };
                return { ok: true, status: 200, json: async () => ({ id: 'x', url: '/api/hls/cut/x.m3u8' }) };
            }
            if (url === MEDIA) { if (opts.playlistFail) throw new TypeError('Failed to fetch'); return { ok: true, status: 200, url: MEDIA, text: async () => RAW }; }
            const s = segData.get(url);
            if (!s) throw new TypeError('Failed to fetch');
            if (opts.cdn403) return { ok: false, status: 403 };
            const data = s();
            const n = o && o.headers && o.headers.Range ? +o.headers.Range.split('-')[1] + 1 : data.length;
            return { ok: true, status: 206, url, body: null, arrayBuffer: async () => data.slice(0, n).buffer };
        };
        const win = { AdClipCore: C, AdFilter: { isEnabled: () => true }, fetch: fetchStub };
        const ls = { getItem: k => lsMap.has(k) ? lsMap.get(k) : null, setItem: (k, v) => lsMap.set(k, String(v)) };
        let clock = 0;
        const make = new Function('window', 'AdClipCore', 'dp', 'localStorage', 'sessionStorage', 'performance', 'fetch', '_navSeq', 'URL', 'AbortController', 'console', 'Hls', 'crypto', 'location', 'btoa',
            body + '\nreturn window;');
        const quiet = process.env.ADCUT_DEBUG ? console : { log() { }, warn() { } };
        const cut = [];
        const vue = {
            _playToken: 1, _activePlaySeq: 1, currentSource: { site_key: 'dyttzy' }, hlsCutEnabled: opts.hlsCut !== false,
            srcProfile: () => ({ clip: opts.clip !== false }), _clipNativeBad: () => false, _clipNativeSet() { },
            _setActiveCut(st) { cut.push(st); this._activeCut = st; }
        };
        const Hls = { Events: { LEVEL_LOADED: 'l', DESTROYING: 'd' } };
        const cryptoStub = { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (i * 37 + 11) & 255; return b; } };
        win.crypto = cryptoStub;
        const w = make(win, C, null, ls, ls, { now: () => (clock += 3) }, fetchStub, 1, URL, AbortController, quiet, Hls, cryptoStub, { origin: 'https://tv.example' }, (s) => Buffer.from(s, 'binary').toString('base64'));
        w.adClipSkip.vue = vue;
        return { adCut: w.adCut, adClipSkip: w.adClipSkip, reqs, posts, lsMap, vue, cut, fetchStub, win };
    };
    // 1) 全扫描 → 剪两段;第二次同清单 → 会话缓存,不再发请求;换一个页面(新实例)带着本机缓存 → 不发任何分片请求
    let E = mkEnv();
    let r = await E.adCut.plan(RAW, MEDIA, 'dyttzy');
    ok(r && r.cuts.length === 2 && Math.abs(r.removedDur - 34.832) < 0.01 && r.text && C.parseMedia(r.text, MEDIA).frags.length === 699, 'plan:兰香如故扫描后剪两段 34.83s', r && { cuts: r.cuts.map(c => [c.start, c.dur]), known: r.known });
    const segReq1 = E.reqs.filter(x => /\.ts/.test(x[0])).length;
    ok(segReq1 >= pm.groups.length && segReq1 <= pm.groups.length + 6, '每组首片一次 + 被剪组末片复核(≤6)', segReq1);
    ok(E.reqs.filter(x => /\.ts/.test(x[0])).every(x => x[1] === 'bytes=0-16383'), '分片请求全是 Range 前 16KB');
    r = await E.adCut.plan(RAW, MEDIA, 'dyttzy');
    ok(r && r.cuts.length === 2 && E.reqs.filter(x => /\.ts/.test(x[0])).length === segReq1, '同一清单第二次:会话缓存,零请求');
    const E2 = mkEnv({ ls: E.lsMap });
    r = await E2.adCut.plan(RAW, MEDIA, 'dyttzy');
    ok(r && r.cuts.length === 2 && r.cached === 'local' && E2.reqs.length === 0, '换页面重开:本机缓存命中,零请求', r && r.cached);
    // 2) 复核:插播组的末片 PTS 不连续(组内后半其实接着正片)→ 这一段不剪
    mixBad.add(9);
    E = mkEnv();
    r = await E.adCut.plan(RAW, MEDIA, 'dyttzy');
    ok(r && r.cuts.length === 1 && Math.abs(r.cuts[0].start - 1515.946) < 0.01, '复核没通过的一段不剪,另一段照剪', r && r.cuts.map(c => [c.start, c.dur]));
    mixBad.clear();
    // 3) CDN 403 → 立刻停扫、本站 30 分钟不再扫,不剪
    E = mkEnv({ cdn403: true });
    r = await E.adCut.plan(RAW, MEDIA, 'dyttzy');
    ok(r && r.cuts.length === 0 && !r.text && E.reqs.filter(x => /\.ts/.test(x[0])).length <= 6 && E.adCut._blocked.dyttzy > 0, 'CDN 403 → 停扫(≤并发数个请求)且本站暂停扫描', E.reqs.length);
    // 4) 非 clip 站、也没学会 → 不剪;学会后 → 剪
    E = mkEnv({ clip: false });
    ok(E.adCut.want() === null, '非 clip、没学会的站 → 不剪');
    E.adClipSkip._learn(E.vue);
    ok(E.adCut.want() && E.adCut.want().site === 'dyttzy', '播放中真跳到插播后 → 学会,以后剪');
    // 5) hls.js 清单 loader:原地址不变、数据换成剪后的;主清单记下码率数,多码率不剪
    {
        const make2 = new Function('window', 'Hls', 'offlineDB', 'offlineKey', '_navSeq', 'AdClipCore', ctSrc + '\nreturn buildOfflineHlsConfig;');
        class XhrStub {
            constructor(cfg) { this.cfg = cfg; this.stats = { loading: {} }; }
            load(ctx, cfg, cb) { setTimeout(() => cb.onSuccess({ url: ctx.url, data: ctx.url === 'master' ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nb.m3u8\n' : RAW }, this.stats, ctx, null), 0); }
            abort() { } destroy() { }
        }
        E = mkEnv();
        const HlsStub = { DefaultConfig: { loader: XhrStub } };
        const win2 = { adCut: E.adCut, AdClipCore: C, Hls: HlsStub };
        const build = make2(win2, HlsStub, { get: () => Promise.resolve(null) }, (u) => u, 1, C);
        const cfg = build();
        ok(cfg.pLoader === win2._CutHlsLoader && Object.getPrototypeOf(cfg.pLoader.prototype) === win2._OfflineHlsLoader.prototype, 'pLoader = CutLoader 且继承 OfflineLoader');
        const sess = E.adCut.session();
        const L = new cfg.pLoader(Object.assign({}, cfg, { _dgCut: sess }));
        const got = await new Promise(res => L.load({ type: 'level', url: MEDIA }, {}, { onSuccess: (resp) => res(resp), onError: () => res(null) }));
        ok(got && got.url === MEDIA && C.parseMedia(got.data, MEDIA).frags.length === 699 && sess.result && sess.result.cuts.length === 2, 'level 清单:地址不变、内容换成剪后的(699 片)', got && got.url);
        const sess2 = E.adCut.session();
        const L2 = new cfg.pLoader(Object.assign({}, cfg, { _dgCut: sess2 }));
        await new Promise(res => L2.load({ type: 'manifest', url: 'master' }, {}, { onSuccess: res }));
        const L3 = new cfg.pLoader(Object.assign({}, cfg, { _dgCut: sess2 }));
        const got3 = await new Promise(res => L3.load({ type: 'level', url: MEDIA }, {}, { onSuccess: res }));
        ok(sess2.variants === 2 && got3.data === RAW, '多码率主清单 → 子清单不剪(原样)');
        const L4 = new cfg.pLoader(Object.assign({}, cfg, { _dgCut: E.adCut.session() }));
        let late = false;
        L4.load({ type: 'level', url: MEDIA }, {}, { onSuccess: () => { late = true; } });
        L4.destroy();
        await new Promise(res => setTimeout(res, 50));
        ok(!late, 'loader 销毁后不再回调(剪完也不迟到交付)');
        const L5 = new cfg.pLoader(Object.assign({}, cfg));
        const got5 = await new Promise(res => L5.load({ type: 'level', url: MEDIA }, {}, { onSuccess: res }));
        ok(got5.data === RAW, '不需要剪的实例(没有会话)→ 原样');
    }
    // 6) 原生占位交付:src 同步换成本站占位地址;扫描后 POST 剪后清单(带同一个 id);时间轴剪段就位
    {
        E = mkEnv();
        const video = { src: MEDIA, paused: false, play() { this.played = (this.played || 0) + 1; return Promise.resolve(); } };
        ok(E.adCut.attachNative(video, {}) === true && /^https:\/\/tv\.example\/api\/hls\/cut\/[A-Za-z0-9_-]{24}\.m3u8$/.test(video.src), '原生:src 同步换成本站占位地址', video.src);
        const id = /cut\/([^.]+)\.m3u8/.exec(video.src)[1];
        await new Promise(res => setTimeout(res, 50)); for (let k = 0; k < 40 && !E.posts.length; k++) await new Promise(res => setTimeout(res, 20));
        ok(E.posts.length === 1 && E.posts[0].id === id && C.parseMedia(E.posts[0].m3u8, MEDIA).frags.length === 699, '扫描完把剪后清单(699 片)交给服务器,id 一致', E.posts.length);
        ok(E.cut.length === 1 && E.cut[0].owner === 'native' && E.cut[0].src === video.src && E.cut[0].cuts.length === 2, '原生:剪段交给 vue 做时间轴换算');
        ok(video.src.includes('/api/hls/cut/') && !video.played, '交付成功:src 不再变、不额外 play()');
        // 交付失败 → 换回原地址并继续播
        E = mkEnv({ postFail: true });
        const v2 = { src: MEDIA, paused: false, play() { this.played = (this.played || 0) + 1; return Promise.resolve(); } };
        E.adCut.attachNative(v2, {});
        for (let k = 0; k < 60 && v2.src !== MEDIA; k++) await new Promise(res => setTimeout(res, 20));
        ok(v2.src === MEDIA && v2.played === 1 && !E.vue._activeCut, '交付失败 → 换回原地址、继续播、不留剪段', { src: v2.src, played: v2.played });
        // 原清单读不到(跨域)→ 换回原地址
        E = mkEnv({ playlistFail: true });
        const v3 = { src: MEDIA, paused: true, play() { this.played = 1; return Promise.resolve(); } };
        E.adCut.attachNative(v3, {});
        for (let k = 0; k < 60 && v3.src !== MEDIA; k++) await new Promise(res => setTimeout(res, 20));
        ok(v3.src === MEDIA && !v3.played && E.posts.length === 0, '原清单读不到 → 换回原地址(没在播就不自动播)');
        // 服务器不支持(Vercel)/ 没开 → 不接管
        E = mkEnv({ hlsCut: false });
        const v4 = { src: MEDIA };
        ok(E.adCut.attachNative(v4, {}) === false && v4.src === MEDIA, '服务器不能托管(hls_cut:false)→ 不接管 src');
    }
}

// ============ 7) 接线:原生通道 + SW 更新策略(静态) ============
console.log('[7] 原生通道 / SW 接线');
{
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
    const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
    const ct = html.slice(html.indexOf('window._dgHlsCustomType = function'), html.indexOf('function buildOfflineHlsConfig()'));
    ok(/_dgPreferNativeHls \|\| !window\.Hls \|\| !Hls\.isSupported\(\)\) \{[\s\S]{0,120}adCut\.attachNative\(video, player\)[\s\S]{0,200}adClipSkip\.attachNative\(video, player\)[\s\S]{0,160}return;/.test(ct), '原生通道:先 adCut 换占位地址(播放前剪),再挂 adClipSkip 静默跳过兜底');
    ok(/_dgCut: cutSess/.test(ct) && /adCut\.hook\(hls, cutSess\)/.test(ct) && ct.indexOf('adCut.hook(hls, cutSess)') < ct.indexOf('hls.loadSource(video.src)'), 'hls.js:每个实例一个剪清单会话(挂 config),在 loadSource 之前挂好');
    ok(/class CutLoader extends window\._OfflineHlsLoader/.test(html) && /pLoader: window\._CutHlsLoader \|\| window\._OfflineHlsLoader/.test(html), 'pLoader 继承离线 loader(离线播放的清单照样走本地库)');
    const ab = html.slice(html.indexOf('window.adCut = {'), html.indexOf('let _lastProgressSaveTime'));
    ok(ab.length > 1000 && /prof && prof\.clip\) && !this\.learned\(site\)/.test(ab), 'adCut 只对档案 clip 站 + 学会的站剪');
    ok(/_activeOffCached/.test(ab) && /_liveActive/.test(ab) && /_isCasting/.test(ab), 'adCut:离线副本 / 直播 / 投屏不剪');
    ok(/e\.status === 403 \|\| e\.status === 429/.test(ab), 'adCut:CDN 403/429 立刻停扫(不连累真实播放)');
    ok(/groupConsistent/.test(ab), 'adCut:动刀前逐组复核');
    const body0 = html.slice(html.indexOf('window.adClipSkip = {'), html.indexOf('window.adCut = {'));
    ok(/adCut\.learn\(s\.site_key\)/.test(body0) && (body0.match(/this\._learn\(vue\)/g) || []).length === 2, '播放中真跳到插播(seek / 片尾)→ 学会该站');
    ok(/window\.adCut && window\.adCut\.busy\(\)\) \{ this\._startWdCut = true/.test(html) && /window\.adCut && window\.adCut\.busy\(\)\) \{ wdWasHidden = true; armFallbackWd\(2000\)/.test(html), '两个看门狗在扫描期间不判死');
    const body = html.slice(html.indexOf('window.adClipSkip = {'), html.indexOf('let _lastProgressSaveTime'));
    ok(/const ns = v\._adClipNative;\s*\n\s*if \(ns && !ns\.dead && v\.src === ns\.src\) return ns;/.test(body), '_cur:原生状态(video.src 必须还是挂载时那个)优先于 dp.plugins.hls 上残留的状态');
    ok(/if \(st\.native\) this\._nativePump\(st\)/.test(body), 'check 里驱动原生探测');
    ok(/st\.native \? d\.to : this\._landing/.test(body), '原生通道不等缓冲直接 seek');
    const ci = html.indexOf('_srcClipOn(s) {');
    const clipOn = ci > 0 ? html.slice(ci, html.indexOf('_srcFilterOn(s) {', ci)) : '';
    ok(/window\.fetch/.test(clipOn) && !/_dgPreferNativeHls \|\| !window\.Hls/.test(clipOn) && /probeTs !== 'function'/.test(clipOn) && /_clipNativeBad\(s\.site_key\)/.test(clipOn),
        '_srcClipOn:原生 HLS 有 fetch 也算能跳;要求 v3 核心;该站原生扫描失败过则不算');
    ok(/clip \? !this\._srcClipOn\(s\) : !this\._srcFilterOn\(s\)/.test(html), 'clip 站只看播放器能不能跳(电影天堂源站封 worker)');
    const s2 = sw.slice(sw.indexOf('// 策略2'), sw.indexOf('// 策略3'));
    ok(/setTimeout\(\(\) => resolve\(null\), 4000\)/.test(s2) && /r\.clone\(\)\.arrayBuffer\(\)\.then\(\(\) => r\)/.test(s2) && !/后台静默更新/.test(s2), 'SW:页面网络优先(4s,算到整页下载完),不再先回缓存');
    ok(/const mayBeSharePage = isSpaRoot && url\.searchParams\.has\('play'\) && !url\.searchParams\.has\('_spa'\);/.test(s2) && /!mayBeSharePage\)/.test(s2), 'SW:分享预览页(/?play= 不带 _spa)不写外壳');
    ok(/url\.pathname === '\/sw\.js'\) return;/.test(sw), 'SW:sw.js 自身直达不缓存');
    ok(/r\.status < 500/.test(s2), 'SW:服务器 5xx(重启中)回缓存页面');
    ok(/const key = isSpaRoot \? '\.\/' : event\.request/.test(s2), 'SW:深链统一存成一份外壳');
    const s3 = sw.slice(sw.indexOf('// 策略3'), sw.indexOf('// 策略4'));
    ok(/const exact = await cache\.match\(event\.request\);/.test(s3) && /ignoreSearch: true/.test(s3), 'SW:静态库先按完整 URL(含 ?v=)找,网络失败才回旧版本');
    for (const m of html.matchAll(/<script[^>]+src="(libs\/js\/[^"]+)"/g)) ok(sw.includes("'./" + m[1] + "'"), 'SW 预缓存键与页面引用一致:' + m[1]);
    {
        const a = html.indexOf('let swRefreshing = false;');
        const swh = a > 0 ? html.slice(a, html.indexOf('window.location.reload();', a)) : '';
        ok(/const hadController = !!navigator\.serviceWorker\.controller;/.test(swh) && /if \(swRefreshing \|\| !hadController\) return;/.test(swh) &&
            /!dp\.video\.paused && !dp\.video\.ended\)\s*\{[^}]*return;/.test(swh), '新 SW 接管:首次安装/正在播放时不自动刷新(守卫在刷新之前)');
    }
    ok(!/REQUIRED_SW_VERSION/.test(html), '旧的 SW 版本检测脚本(每次加载拉 sw.js?check=)已删除');
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'}: ${pass} passed, ${fail} failed`);
if (fail) { console.log(fails.slice(0, 40).join('\n')); process.exitCode = 1; }
