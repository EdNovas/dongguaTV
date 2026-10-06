#!/usr/bin/env node
// CF Worker(cloudflare-cors-proxy.js)去广告规则回归测试 —— 离线、零网络。
//   node scripts/worker-test.mjs                      跑全部断言,失败退出码非 0
//   node scripts/worker-test.mjs --worker=<旧版.js>    拿另一份 worker 跑同一批清单(只打印对照表,用于"改前/改后"比较)
//
// 为什么必须有它:去广告只在 worker 里做(客户端 ad-filter.js 是死代码),而 worker 规则改坏的代价是"全站播不了"
// 且 console 没有任何报错 —— v2.3 均匀切块被删成 0 片清单、v2.4 前 .vip/.top 规则删光无尽/稀饭正片、
// 场景切块(qwe132456 系)每集被砍掉一半,全是这类静默事故。改 rewriteM3u8 / rewriteUrlsOnly 后必跑。
//
// fixtures/worker/*.m3u8 是 2026-10 审计时抓的真实子清单(加拿大出口);"期望删除秒数"来自审计逐组核对 + 抽帧确认:
//   ffzy/360/1080zyk/爱奇艺/ikun/暴风/电影天堂 = 同站 SSAI 棋牌插播;樱花 = 外站成人贴片;如意 = 尾部 720p 棋牌片尾;
//   wsyzy = 同目录 12s 棋牌中插;模都黑袍 = 每 20 片切块 + 6 段 17.6s 棋牌插播;dytt(kz_dm84)= 每 5 片切块 + 19s 中插。
// 加载方式与审计脚本 sim.js 相同:把 worker 源码里的 `export default {` 换掉后用 new Function 取出内部函数。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'scripts/fixtures/worker');
const argWorker = (process.argv.find(a => a.startsWith('--worker=')) || '').slice('--worker='.length);
const WORKER = argWorker ? path.resolve(argWorker) : path.join(ROOT, 'cloudflare-cors-proxy.js');
const COMPARE_ONLY = !!argWorker;

// ============ 加载 worker 内部函数 ============
const logs = [];
const fakeConsole = { log: (...a) => logs.push(a.join(' ')), warn: () => {}, error: () => {} };
const src = fs.readFileSync(WORKER, 'utf8').split('\r').join('').replace('export default {', 'const __workerDefault = {');
const W = new Function('console', src + '\nreturn { rewriteM3u8, rewriteNoFilter };')(fakeConsole);

const BASE = new URL('https://example.com/a/b/index.m3u8');
const PROXY = 'https://w.example';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) pass++;
    else { fail++; failures.push(name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}

// ============ 清单解析(与 worker 无关的独立实现) ============
function resolve(u) {
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    return new URL(u, BASE).href;
}
function segments(text) {
    const out = [];
    const L = text.split(/\r?\n/);
    for (let i = 0; i < L.length; i++) {
        const t = L[i].trim();
        if (!t.startsWith('#EXTINF:')) continue;
        const d = parseFloat(t.slice(8)) || 0;
        let j = i + 1;
        while (j < L.length && (L[j].trim() === '' || L[j].trim().startsWith('#'))) j++;
        if (j < L.length) out.push({ d, url: resolve(L[j].trim()) });
    }
    return out;
}
const sum = arr => arr.reduce((a, s) => a + s.d, 0);

function run(text) {
    logs.length = 0;
    const t0 = process.hrtime.bigint();
    const out = W.rewriteM3u8(text, BASE, PROXY);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const inS = segments(text), outS = segments(out);
    const outSet = new Set(outS.map(s => s.url));
    const removed = inS.filter(s => !outSet.has(s.url));
    return { out, ms, inS, outS, removed, removedSec: sum(removed), log: logs.slice() };
}

// ============ 真实清单 ============
// removed: 期望删除秒数(±0.15);segs: 期望删除分段数;drop: 被删分段必须全部满足的条件;keepHost: 该 host 的分段一个都不能少
const FIXTURES = [
    // —— 同站 SSAI 插播:必须照删(v2.3 已有能力,v2.4 不得回退)——
    { f: 'ffzy_v1.m3u8',         removed: 56.6, segs: 14, why: '非凡 3 段棋牌插播(同目录相对路径,另一编码节奏)' },
    { f: 'z360_e1.m3u8',         removed: 52.7, segs: 12, why: '360 3 段 17.57s 插播(vod.360zyx.vip 外站)' },
    { f: '1080zyk_dune.m3u8',    removed: 84.7, segs: 22, why: '1080 5 段插播' },
    { f: 'aqyzy_boys1.m3u8',     removed: 17.6, segs: 5,  why: '爱奇艺 1 段插播(另一目录)' },
    { f: 'ikun_e3.m3u8',         removed: 70.6, segs: 24, why: 'ikun 4 段 17.64s 插播' },
    { f: 'bf13_e1.m3u8',         removed: 26.0, segs: 9,  why: '暴风 /video/adjump/ 插播', drop: s => s.url.includes('/adjump/') },
    { f: 'dynet_e1.m3u8',        removed: 34.8, segs: 9,  why: '电影天堂 2 段插播' },
    // —— Bug A:正片本身在 .vip/.top CDN 上,必须一片不少 ——
    { f: 'wujin_e1.m3u8',        removed: 0, keepAll: true, why: '无尽 正片在 adfg8.vip(旧规则 → 0 片)' },
    { f: 'kz_moonci_335_hls.m3u8', removed: 0, keepAll: true, why: '月之祠/稀饭 HLS 在 dl.playxf.top(旧规则 → 0 片)' },
    { f: 'yinghua_e1.m3u8',      removed: 5.85, segs: 1, keepHost: 'v5.adfg8.vip', drop: s => s.url.includes('yhzybf.com'),
      why: '樱花:删开头外站成人贴片,adfg8.vip 正片全保留(旧规则:正片全删只剩贴片)' },
    { f: 'yinghua_e3.m3u8',      removed: 5.25, segs: 1, drop: s => s.url.includes('yhzybf.com'), keepRest: true, why: '樱花 后门 ep1 同上' },
    // —— Bug B①:场景切块(qwe132456 系)零删除 ——
    { f: 'qwe_zuid_e1.m3u8',     removed: 0, keepAll: true, why: '最大 ep1:短组占 49%(旧规则删掉 1400s)' },
    { f: 'qwe_zuid_e2.m3u8',     removed: 0, keepAll: true, why: '最大 ep24:短组占 57%(旧规则靠 50% 保险丝放行)' },
    { f: 'wsyzy_fhl1.m3u8',      removed: 11.77, segs: 6, keepRest: true, drop: s => true,
      why: 'wsyzy:场景切块 + 同目录 12s 棋牌中插(2.1,2,2,1.967…),只删那一段' },
    // —— 无 DISCONTINUITY 的干净源 ——
    { f: 'hongniu_lx1.m3u8',     removed: 0, keepAll: true, why: '红牛 单组' },
    { f: 'huya_lx1.m3u8',        removed: 0, keepAll: true, why: '虎牙 单组' },
    // —— Bug B②:定长切块 + 打断式插播 ——
    { f: 'rycj_lx1.m3u8',        removed: 12.16, segs: 3, keepRest: true, tail: [4, 5.48, 2.68],
      why: '如意 每 5 片切块:删尾部 720p 棋牌片尾,保留 4,4,4,1 片尾字幕' },
    { f: 'rycj_lx24.m3u8',       removed: 12.16, segs: 3, keepRest: true, tail: [4, 5.48, 2.68], why: '如意 ep24 同上(中间还有 6 片组也要保留)' },
    { f: 'rycj_hp1.m3u8',        removed: 12.16, segs: 3, keepRest: true, tail: [4, 5.48, 2.68], why: '如意 黑袍 ep1 场景切分时长 + 每 5 片切块' },
    { f: 'mdzy_chunk20_e3.m3u8', removed: 105.4, segs: 54, keepRest: true, drop: s => s.url.includes('/20260917/CXADHDMP/'),
      why: '模都 黑袍 每 20 片切块:6 段 17.57s 棋牌插播,被打断的 7|13、4|16 两截正片保留(旧规则误删 91s 正片)' },
    { f: 'kz_dm84_5772_dytt.m3u8', removed: 19.07, segs: 5, keepRest: true, why: 'dytt 每 5 片切块:4 | 3,2 中插 19s' },
];

const table = [];
for (const fx of FIXTURES) {
    const text = fs.readFileSync(path.join(FIX, fx.f), 'utf8');
    const r = run(text);
    table.push({ f: fx.f, inSec: sum(r.inS), inN: r.inS.length, outN: r.outS.length, rm: r.removedSec, want: fx.removed, ms: r.ms });
    if (COMPARE_ONLY) continue;
    const n = fx.f;
    ok(Math.abs(r.removedSec - fx.removed) <= 0.15, `${n}: 删除 ${fx.removed}s(${fx.why})`, { got: +r.removedSec.toFixed(2) });
    ok(r.outS.length > 0, `${n}: 输出不得为 0 分片`);
    ok(r.outS.every(s => r.inS.some(x => x.url === s.url)), `${n}: 输出分段必须都来自原清单`);
    if (fx.segs !== undefined) ok(r.removed.length === fx.segs, `${n}: 删除 ${fx.segs} 个分段`, { got: r.removed.length });
    if (fx.keepAll) ok(r.outS.length === r.inS.length, `${n}: 全部分段保留`, { in: r.inS.length, out: r.outS.length });
    if (fx.keepRest) ok(r.outS.length === r.inS.length - (fx.segs || 0), `${n}: 除广告外全部保留`, { in: r.inS.length, out: r.outS.length });
    if (fx.drop) ok(r.removed.every(fx.drop), `${n}: 被删的只能是广告分段`, r.removed.filter(s => !fx.drop(s)).slice(0, 3));
    if (fx.keepHost) {
        const want = r.inS.filter(s => s.url.includes('://' + fx.keepHost + '/')).length;
        const got = r.outS.filter(s => s.url.includes('://' + fx.keepHost + '/')).length;
        ok(want > 0 && want === got, `${n}: ${fx.keepHost} 正片一片不少`, { want, got });
    }
    if (fx.tail) {
        // 被删的正是最后 3 片(棋牌片尾),而且输出的最后一片是 4,4,4,1 / 2.002 这类正片余数
        const last = r.inS.slice(-fx.tail.length);
        ok(JSON.stringify(last.map(s => +s.d.toFixed(2))) === JSON.stringify(fx.tail) &&
            last.every(s => r.removed.includes(s)), `${n}: 删的是尾部 ${fx.tail.join(',')} 片尾广告`);
        ok(r.outS[r.outS.length - 1].url === r.inS[r.inS.length - 1 - fx.tail.length].url, `${n}: 片尾字幕组保留`);
    }
    if (/#EXT-X-ENDLIST/.test(text)) ok(/#EXT-X-ENDLIST/.test(r.out), `${n}: 保留 ENDLIST`);
    const td = /#EXT-X-TARGETDURATION:(\d+)/.exec(r.out);
    const maxSeg = Math.max(...r.outS.map(s => Math.round(s.d)));   // HLS 规范:四舍五入后的 EXTINF ≤ TARGETDURATION
    ok(td && +td[1] >= maxSeg, `${n}: TARGETDURATION ≥ 最长分段`, { td: td && +td[1], maxSeg });
}

// ============ 合成清单 ============
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const HDR = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n';
function build(groups, { endlist = true, header = HDR } = {}) {
    let t = header;
    groups.forEach((g, gi) => {
        if (gi > 0) t += '#EXT-X-DISCONTINUITY\n';
        for (const [d, u] of g) t += `#EXTINF:${d.toFixed(6)},\n${u}\n`;
    });
    return t + (endlist ? '#EXT-X-ENDLIST\n' : '');
}

if (!COMPARE_ONLY) {
    // S1 v2.3 事故原样复现:ryplay17 每 5 片一个 DISCONTINUITY,1724 片/345 组 —— 一片都不能删
    for (const variant of ['uniform', 'scenecut']) {
        const R = rng(17);
        const groups = [];
        for (let i = 0; i < 1724; i++) {
            if (i % 5 === 0) groups.push([]);
            const d = variant === 'uniform' ? 4 : 1 + R() * 6;
            groups[groups.length - 1].push([d, `seg${i}.ts`]);
        }
        const r = run(build(groups));
        ok(r.outS.length === 1724 && r.removedSec === 0, `合成: ryplay17 每 5 片切块(${variant})零删除`, { out: r.outS.length });
    }
    // S2 保险丝:不规则短组、时长杂乱、单 host(认不出打包方式)→ "广告"占比远超 20% → 整份放行
    {
        const R = rng(7);
        const groups = [];
        let n = 0;
        while (n < 900) {
            const c = 1 + Math.floor(R() * 14);
            const g = [];
            for (let k = 0; k < c; k++) g.push([0.8 + R() * 3, `p${n++}.ts`]);
            groups.push(g);
        }
        const r = run(build(groups));
        ok(r.outS.length === n && r.log.some(l => l.includes('SKIP')), '合成: 认不出的切块 → 保险丝整份放行', { out: r.outS.length, n });
    }
    // S3 Bug A 不能误伤本意:正片在 .vip 主 host,外来 .top/.bet 分段照删(单组走 rewriteUrlsOnly 路径)
    {
        const g = [];
        for (let i = 0; i < 300; i++) g.push([2, `https://v9.cdnfoo.vip/hls/c${i}.ts`]);
        g.splice(150, 0, [3, 'https://ad.spamhost.top/x/a1.ts']);
        g.push([2, 'https://track.casino777.bet/p.ts']);
        const r = run(build([g]));
        ok(r.outS.length === 300 && r.removed.length === 2 && r.removed.every(s => !s.url.includes('cdnfoo.vip')),
            '合成: 主 host 是 .vip 时正片全留,外来 .top/.bet 分段删除', { out: r.outS.length, removed: r.removed.map(s => s.url) });
    }
    // S4 同上走过滤路径:SSAI 插播组 + 正片组里夹一个外站 .vip 追踪片
    {
        const content1 = [], content2 = [];
        for (let i = 0; i < 200; i++) content1.push([4, `c1_${i}.ts`]);
        for (let i = 0; i < 200; i++) content2.push([4, `c2_${i}.ts`]);
        content2.splice(100, 0, [2, 'https://x.unibet666.vip/t.ts']);
        const ad = [[4.866667, 'ad0.ts'], [3.333333, 'ad1.ts'], [5.6, 'ad2.ts'], [2.866667, 'ad3.ts'], [2.966667, 'ad4.ts']];
        const r = run(build([content1, ad, content2]));
        ok(r.outS.length === 400 && Math.abs(r.removedSec - 21.633334) < 0.01, '合成: 插播组 + 外站 .vip 追踪片一起删', { out: r.outS.length, rm: r.removedSec });
    }
    // S5 极短追踪像素(0.01s、非 .ts 的绝对 URL)照删
    {
        const g = [];
        for (let i = 0; i < 100; i++) g.push([3, `s${i}.ts`]);
        g.push([0.01, 'https://pixel.example.org/t.gif']);
        const r = run(build([g]));
        ok(r.outS.length === 100 && r.removed.length === 1, '合成: 0.01s 追踪像素删除');
    }
    // S6 直播(无 ENDLIST):不做时长判定、不硬加 ENDLIST
    {
        const groups = [[[6, 'l1.ts'], [6, 'l2.ts']], [[5, 'l3.ts']], [[6, 'l4.ts'], [6, 'l5.ts']]];
        const r = run(build(groups, { endlist: false }));
        ok(r.outS.length === 5 && !/#EXT-X-ENDLIST/.test(r.out), '合成: 直播清单只改 URL、不加 ENDLIST');
    }
    // S7 过滤路径里头部 #EXT-X-KEY 的相对 URI 必须走代理(否则 hls.js 拿 worker 帮助页当密钥)
    {
        const hdr = HDR + '#EXT-X-KEY:METHOD=AES-128,URI="key.key"\n';
        const content = [];
        for (let i = 0; i < 100; i++) content.push([4, `k${i}.ts`]);
        const ad = [[5, 'ad0.ts'], [5, 'ad1.ts'], [5, 'ad2.ts'], [2.567, 'ad3.ts']];
        const r = run(build([content, ad, content.map(([d, u]) => [d, 'b' + u])], { header: hdr }));
        ok(r.out.includes(`URI="${PROXY}/?url=${encodeURIComponent('https://example.com/a/b/key.key')}"`) && r.removed.length === 4,
            '合成: 过滤路径头部 KEY URI 走代理');
    }
    // S8 主清单只改写子清单 URL(走代理)
    {
        const r = W.rewriteM3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n2000k/hls/index.m3u8', BASE, PROXY);
        ok(r.includes(`${PROXY}/?url=${encodeURIComponent('https://example.com/a/b/2000k/hls/index.m3u8')}`), '合成: 主清单子清单走代理');
    }
    // S9 ?nofilter=1 通道:一个都不删
    {
        const t = fs.readFileSync(path.join(FIX, 'yinghua_e1.m3u8'), 'utf8');
        const out = W.rewriteNoFilter(t, BASE, PROXY + '/?nofilter=1&url=');
        ok(segments(out).length === segments(t).length, '合成: nofilter 通道原样保留');
    }

    // —— 审查补丁(v2.4 复审)——
    const fx = f => fs.readFileSync(path.join(FIX, f), 'utf8').split('\r').join('');
    // 把清单里第 idx 个(从 0 数)分段 URL 交给 fn 改写
    const mapSegUrls = (text, fn) => {
        let idx = 0;
        const L = text.split('\n');
        for (let i = 0; i < L.length; i++) {
            if (L[i].startsWith('#EXTINF:') && i + 1 < L.length && !L[i + 1].startsWith('#')) { L[i + 1] = fn(L[i + 1], idx++); i++; }
        }
        return L.join('\n');
    };
    // R1 正片分散在同一注册域的多个子域(adfg8.vip 每集轮换子域,混用也合理):非"最多"子域的正片不能被 .vip 规则删
    {
        const t = mapSegUrls(fx('yinghua_e1.m3u8'), (u, i) => (i % 3 === 0 ? u.replace('://v5.adfg8.vip/', '://v7.adfg8.vip/') : u));
        const r = run(t);
        ok(Math.abs(r.removedSec - 5.85) < 0.05 && r.removed.length === 1 && r.removed[0].url.includes('yhzybf.com'),
            '复审: 樱花 e1 正片 1/3 在 v7.adfg8.vip → 只删外站贴片', { rm: +r.removedSec.toFixed(2), n: r.removed.length });
        // 只有 1/10 在兄弟子域:低于 20% 闸门,只能靠"比注册域"保住
        const t10 = mapSegUrls(fx('yinghua_e1.m3u8'), (u, i) => (i % 10 === 5 ? u.replace('://v5.adfg8.vip/', '://v7.adfg8.vip/') : u));
        const r10 = run(t10);
        ok(Math.abs(r10.removedSec - 5.85) < 0.05 && r10.removed.length === 1, '复审: 樱花 e1 正片 1/10 在 v7.adfg8.vip(闸门之下)→ 只删外站贴片',
            { rm: +r10.removedSec.toFixed(2), n: r10.removed.length });
        const w = mapSegUrls(fx('wujin_e1.m3u8'), (u, i) => (i % 2 ? u.replace('://v10.adfg8.vip/', '://v11.adfg8.vip/') : u));
        const rw = run(w);
        ok(rw.removedSec === 0 && rw.outS.length === rw.inS.length, '复审: 无尽 e1 正片一半在兄弟子域 → 零删除(rewriteUrlsOnly 路径)',
            { rm: rw.removedSec, out: rw.outS.length, in: rw.inS.length });
    }
    // R2 正片分散在两个不同注册域的 .vip CDN(没法靠注册域认出来)→ 单片删除超过 20% 的闸门:一片不删
    {
        const w = mapSegUrls(fx('wujin_e1.m3u8'), (u, i) => (i % 2 ? u.replace('://v10.adfg8.vip/', '://v1.otherc9.vip/') : u));
        const rw = run(w);
        ok(rw.removedSec === 0 && rw.outS.length === rw.inS.length, '复审: 正片 50/50 分在两个 .vip 注册域 → 闸门全保留(rewriteUrlsOnly)', { out: rw.outS.length });
        const y = mapSegUrls(fx('yinghua_e1.m3u8'), (u, i) => (i > 0 && i % 2 ? u.replace('://v5.adfg8.vip/', '://v3.cdnzz88.top/') : u));
        const ry = run(y);
        ok(Math.abs(ry.removedSec - 5.85) < 0.05 && ry.removed.length === 1, '复审: 樱花正片分在 .vip/.top 两域 → 只删贴片(过滤路径闸门)',
            { rm: +ry.removedSec.toFixed(2), n: ry.removed.length });
    }
    // R3 定长切块(模都 每 20 片)里的外来插播:放在开头 / 卡在两个整 20 片组之间 → 也要删
    {
        const t = fx('mdzy_chunk20_e3.m3u8');
        const parts = t.split('\n#EXT-X-DISCONTINUITY\n');      // parts[0] 含头部 + 第一组
        const segN = s => (s.match(/#EXTINF:/g) || []).length;
        const adIdx = parts.findIndex(p => p.includes('/CXADHDMP/'));
        const adGroup = tag => parts[adIdx].split('\n').map(l => (l && !l.startsWith('#') ? l + '?' + tag : l)).join('\n').replace(/\n+$/, '');
        const hdrEnd = parts[0].indexOf('#EXTINF:');
        // 开头贴片
        const pre = [parts[0].slice(0, hdrEnd) + adGroup('pre'), parts[0].slice(hdrEnd)].concat(parts.slice(1)).join('\n#EXT-X-DISCONTINUITY\n');
        const rp = run(pre);
        ok(Math.abs(rp.removedSec - (105.4 + 17.57)) < 0.2 && rp.removed.every(s => s.url.includes('/CXADHDMP/')),
            '复审: 模都 + 外来开头贴片 → 多删 17.57s', { rm: +rp.removedSec.toFixed(2) });
        // 两个整 20 片组之间
        let k = -1;
        for (let i = 2; i < parts.length - 1; i++) {
            if (segN(parts[i - 1]) === 20 && segN(parts[i]) === 20 && !parts[i - 1].includes('CXADHDMP') && !parts[i].includes('CXADHDMP')) { k = i; break; }
        }
        const mid = parts.slice(0, k).concat([adGroup('mid')], parts.slice(k)).join('\n#EXT-X-DISCONTINUITY\n');
        const rm = run(mid);
        ok(k > 0 && Math.abs(rm.removedSec - (105.4 + 17.57)) < 0.2 && rm.removed.every(s => s.url.includes('/CXADHDMP/')),
            '复审: 模都 + 卡在整 20 片边界上的外来插播 → 多删 17.57s', { k, rm: +rm.removedSec.toFixed(2) });
    }
    // R4 SSAI 广告位 = 3 条等长小广告背靠背(组数多到 ≥70% 都是 3 片)→ 不能被当成"每 3 片切块"全放过
    {
        const groups = [];
        let n = 0;
        for (let c = 0; c < 6; c++) {
            const g = [];
            for (let i = 0; i < 301; i++) g.push([4, `c${n++}.ts`]);
            groups.push(g);
            if (c < 5) for (let a = 0; a < 3; a++) groups.push([[5, `ad${c}_${a}_0.ts`], [5, `ad${c}_${a}_1.ts`], [5, `ad${c}_${a}_2.ts`]]);
        }
        const r = run(build(groups));
        ok(Math.abs(r.removedSec - 225) < 0.01 && r.removed.every(s => s.url.includes('ad')), '复审: 5 个广告位 × 3 条 × 3 片 → 225s 全删', { rm: r.removedSec });
    }
    // R5 按目录分桶的 CDN + 定长切块:最后一个小桶(<10%,连续多组)不能被"外来目录"规则误删
    {
        const groups = [];
        for (let i = 0; i < 1000; i++) {
            if (i % 5 === 0) groups.push([]);
            groups[groups.length - 1].push([4, `https://cdn.example.com/v/${i < 950 ? '0000' : '0001'}/s${i}.ts`]);
        }
        const r = run(build(groups));
        ok(r.removedSec === 0 && r.outS.length === 1000, '复审: 分桶 CDN 每 5 片切块,末尾小桶全保留', { out: r.outS.length });
    }
}

// ============ 输出 ============
console.log(`worker: ${path.relative(ROOT, WORKER) || WORKER}`);
console.log('fixture'.padEnd(26), 'in'.padStart(9), 'segs in→out'.padStart(13), 'removed'.padStart(9), 'expect'.padStart(8), '  ms');
for (const t of table) {
    const mark = Math.abs(t.rm - t.want) <= 0.15 ? ' ' : '✗';
    console.log(t.f.padEnd(26), (t.inSec.toFixed(0) + 's').padStart(9), `${t.inN}→${t.outN}`.padStart(13),
        (t.rm.toFixed(1) + 's').padStart(9), (t.want.toFixed(1) + 's').padStart(8), mark, t.ms.toFixed(1));
}
if (COMPARE_ONLY) process.exit(0);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
}
