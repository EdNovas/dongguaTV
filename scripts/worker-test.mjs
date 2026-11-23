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
// [adult] fixtures/worker/adult/*.m3u8 是 2026-11-21 成人站实抓清单(128 份里挑 11 份,只有分段地址、不含片名),
//   放子目录是因为 adclip-test / src-len-test 会遍历 fixtures/worker/*.m3u8 并核对夹具总数。期望秒数来自逐组人工核对
//   (同一素材重复插 = 贴片、AES 清单里的明文短组 = 贴片),每份都按真实 m3u8 地址做 base 解析相对路径。
//   v2.5 规则 D/E/F/G 修的两类事故:短片(1-3 分钟)广告占 27-78% 被 20% 保险丝整份放行;极品两条贴片之间的正片被删。
//   全部夹具(含主线)都额外断言:输出是原清单的有序子序列、每个保留分段的 #EXT-X-KEY(METHOD+URI+IV)不变。
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
function resolve(u, base = BASE) {
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    return new URL(u, base).href;
}
// [adult] 分段的生效密钥:METHOD|绝对 URI|IV(worker 输出里的 URI 是 `${PROXY}/?url=<编码>`,还原后比较)
function keyOf(tag, base) {
    const method = (/METHOD=([A-Z0-9-]+)/.exec(tag) || [])[1] || '';
    if (method === 'NONE') return 'NONE';
    let uri = (/URI="([^"]+)"/.exec(tag) || [])[1] || '';
    if (uri.startsWith(PROXY + '/?url=')) uri = decodeURIComponent(uri.slice(PROXY.length + 6));
    if (uri) uri = new URL(resolve(uri, base)).href;
    return `${method}|${uri}|${((/IV=(0x[0-9a-f]+)/i.exec(tag) || [])[1] || '').toLowerCase()}`;
}
function segments(text, base = BASE) {
    const out = [];
    const L = text.split(/\r?\n/);
    let key = 'NONE';
    for (let i = 0; i < L.length; i++) {
        const t = L[i].trim();
        if (t.startsWith('#EXT-X-KEY:')) { key = keyOf(t, base); continue; }
        if (!t.startsWith('#EXTINF:')) continue;
        const d = parseFloat(t.slice(8)) || 0;
        let j = i + 1;
        while (j < L.length && (L[j].trim() === '' || L[j].trim().startsWith('#'))) {
            if (L[j].trim().startsWith('#EXT-X-KEY:')) key = keyOf(L[j].trim(), base);
            j++;
        }
        // Worker 把 vfile.meituan.net 的 http 分片写成 https(混合内容);比对时两边按同一地址算
        if (j < L.length) out.push({ d, url: resolve(L[j].trim(), base).replace(/^http:\/\/((?:[^\/?#:]+\.)?vfile\.meituan\.net)(?=[\/?#:]|$)/i, 'https://$1'), key });
        i = j;
    }
    return out;
}
const sum = arr => arr.reduce((a, s) => a + s.d, 0);

function run(text, base = BASE) {
    logs.length = 0;
    const t0 = process.hrtime.bigint();
    const out = W.rewriteM3u8(text, base, PROXY);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const inS = segments(text, base), outS = segments(out, base);
    // [adult] 按顺序对齐(贴片同一 URL 会出现多次,不能按 URL 集合算"被删了哪些"):输出必须是输入的有序子序列
    let oi = 0;
    const removed = [], keyDiff = [];
    for (const s of inS) {
        if (oi < outS.length && outS[oi].url === s.url) {
            if (outS[oi].key !== s.key) keyDiff.push({ url: s.url.slice(-48), in: s.key.slice(0, 80), out: outS[oi].key.slice(0, 80) });
            oi++;
        } else removed.push(s);
    }
    return { out, ms, inS, outS, removed, removedSec: sum(removed), subseq: oi === outS.length, keyDiff, log: logs.slice() };
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

    // [adult] —— 成人站(v2.5 确证贴片 D/E/F/G)。base = 实抓时的子清单地址;期望值逐组人工核对过 ——
    // 短片:贴片占比远超 20%,旧 worker 走保险丝整份放行(一秒都没删)
    { f: 'adult/2609_short_lebo.m3u8', base: 'https://lbpl26.com/20261121/AehO3lLM/1500kb/hls/index.m3u8',
      removed: 51.52, segs: 18, outN: 11, keepRest: true, drop: s => s.url.includes('/20261009/RCP0FQBQ/'),
      why: '2609 系(乐播)82.8s 短片:同一条 25.76s 贴片片头 + 片中(占 62%,规则 D)' },
    { f: 'adult/2609_short_senlin.m3u8', base: 'https://2609.senlin2026.com/20261120/CXVJq4v3/1500kb/hls/index.m3u8',
      removed: 51.52, segs: 18, keepRest: true, drop: s => s.url.includes('/20261009/RCP0FQBQ/'),
      why: '2609 系(森林)191s:同上,占 27% 刚过保险丝' },
    { f: 'adult/jkun_short.m3u8', base: 'https://sryndbsfvd.com/20261119/Uf8qwWGC/2000kb/hls/index.m3u8',
      removed: 52.92, segs: 18, outN: 5, keepRest: true, drop: s => s.url.includes('/20261102/dM2Naznj/'),
      why: 'JKUN 67.7s 短片:3 × 17.64s 同一素材 [3,3,5,3,3,0.64](占 78%),只剩 14.76s 正片' },
    { f: 'adult/taohua_short.m3u8', base: 'https://thm3u8.co/20261120/6f8c8b38cf827611/index.m3u8',
      removed: 30.00, segs: 8, outN: 8, keepRest: true, drop: s => s.url.startsWith('https://thm3u8.co/'),
      why: '桃花 81s 短片:AES 正片(thts4.top)夹两条【不同】的 15s 明文贴片(规则 E,没有重复)' },
    // 极品:14s 贴片插 6 次;两条贴片之间 39.34s/6 片的正片旧规则会被当广告删(规则 F)
    { f: 'adult/jipin.m3u8', base: 'https://m2.jipinvipplay.com/20261122/g5qjEUdC/hls/index.m3u8',
      removed: 84.00, segs: 18, keepRest: true, drop: s => s.url.includes('/20261011/9gWW64MM/'),
      why: '极品:6 × 14s 贴片照删,中间 39.34s 正片一秒不少' },
    // souav:场景切块(全 2.000s、54 个 DISCONTINUITY)+ 同目录 10.48s 内嵌插播 —— 没有确证贴片,走旧规则
    { f: 'adult/souav_scenecut.m3u8', base: 'https://bf4.qrtuv.com/202511/21/BA40RvanzN2/video/2000k_1080/hls/index.m3u8',
      removed: 10.48, segs: 6, keepRest: true, rmDurs: [2, 2, 2, 2, 2, 0.48],
      why: 'souav 场景切块 + 同目录 10.48s 插播:只删插播,27 个短场景组保留' },
    // jpg-seg 长片:正片 AES seg_*.jpg 在 .top CDN 上,贴片明文在清单 host;最后一片 0.47s .jpg 是正片余数(追踪像素豁免)
    { f: 'adult/jpgseg_ckbh.m3u8', base: 'https://thm3u8.co/20261120/0550ab81d7335e40/index.m3u8',
      removed: 74.90, segs: 20, keepRest: true, keepLast: true, drop: s => s.url.startsWith('https://thm3u8.co/'),
      why: 'jpg-seg(CK百货)59 分钟:5 × 15s 明文贴片;末片 0.47s .jpg 正片保留' },
    { f: 'adult/jpgseg_fanqie.m3u8', base: 'https://fqm3u8.cc/20261030/17b64825d1207f50/index.m3u8',
      removed: 89.87, segs: 24, keepRest: true, drop: s => s.url.startsWith('https://fqm3u8.cc/'),
      why: 'jpg-seg(番茄)78 分钟:片头独立 15.03s + 同一 14.97s 素材插 5 次' },
    // AES 正片 + 明文贴片(fdc 系):片头一条独立素材 + 片中/片尾同一素材;密钥切换(NONE ↔ AES)必须原样跟着分段走
    { f: 'adult/fdc_aes_doudou.m3u8', base: 'https://v.didibo2.com/20261118/44we0ibR/1000kb/hls/index.m3u8',
      removed: 29.76, segs: 12, keepRest: true, drop: s => !s.url.includes('/20261118/44we0ibR/'),
      why: 'fdc(豆豆)AES 正片 + 3 × 9.92s 明文贴片' },
    // hsck:片头 20.48s + 片尾 19.16s 外站贴片;正片里有 40 个夹在 EXTINF 与 URL 之间的 DISCONTINUITY(worker 不当分组,原样输出)
    { f: 'adult/hsck_prepost.m3u8', base: 'https://hsm3.hwzcfz.com/a3/20261121/eCFnUg6k/2000kb/hls/index.m3u8',
      removed: 39.64, segs: 14, keepRest: true, disc: 40, drop: s => s.url.includes('://dpew.erlgnf.com/'),
      why: 'hsck 片头 + 片尾贴片(AES,不同目录各一条)' },
    // 干净源:无 DISCONTINUITY、.png 伪装分段(http)—— 一片都不能动
    { f: 'adult/clean_honglou_png.m3u8', base: 'https://m3u8.doyinapi.com/play/d8a6162dd18119808411deee20909855.m3u8',
      removed: 0, keepAll: true, why: '红楼 单组 .png 分段 → 零删除' },
];

const table = [];
for (const fx of FIXTURES) {
    const text = fs.readFileSync(path.join(FIX, fx.f), 'utf8');
    const r = run(text, fx.base ? new URL(fx.base) : BASE);
    table.push({ f: fx.f, inSec: sum(r.inS), inN: r.inS.length, outN: r.outS.length, rm: r.removedSec, want: fx.removed, ms: r.ms });
    if (COMPARE_ONLY) continue;
    const n = fx.f;
    ok(Math.abs(r.removedSec - fx.removed) <= 0.15, `${n}: 删除 ${fx.removed}s(${fx.why})`, { got: +r.removedSec.toFixed(2) });
    ok(r.outS.length > 0, `${n}: 输出不得为 0 分片`);
    ok(r.outS.every(s => r.inS.some(x => x.url === s.url)), `${n}: 输出分段必须都来自原清单`);
    // [adult] 全部夹具:有序子序列 + 每个保留分段的生效密钥不变(删掉的贴片组里常带 KEY 切换行)
    ok(r.subseq, `${n}: 输出是原清单的有序子序列`);
    ok(r.keyDiff.length === 0, `${n}: 保留分段的 #EXT-X-KEY 不变`, r.keyDiff.slice(0, 2));
    if (fx.outN !== undefined) ok(r.outS.length === fx.outN, `${n}: 输出 ${fx.outN} 个分段`, { got: r.outS.length });
    if (fx.keepLast) ok(r.outS.length > 0 && r.outS[r.outS.length - 1].url === r.inS[r.inS.length - 1].url,
        `${n}: 最后一片(${r.inS[r.inS.length - 1].d}s 正片余数)保留`);
    if (fx.disc !== undefined) {
        const disc = r.out.split('\n').filter(l => l.trim() === '#EXT-X-DISCONTINUITY').length;
        ok(disc === fx.disc, `${n}: 输出 ${fx.disc} 个 DISCONTINUITY`, { got: disc });
    }
    if (fx.rmDurs) ok(JSON.stringify(r.removed.map(s => +s.d.toFixed(3))) === JSON.stringify(fx.rmDurs),
        `${n}: 删的是 ${fx.rmDurs.join(',')}`, r.removed.map(s => s.d));
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

// ============ [adult] v2.5 确证贴片(D/E/F/G)+ 追踪像素豁免:合成边界 ============
if (!COMPARE_ONLY) {
    const CR = [[5, 'https://ad.cdn-b.com/c/a0.ts'], [5, 'https://ad.cdn-b.com/c/a1.ts'], [4.2, 'https://ad.cdn-b.com/c/a2.ts']];
    // A1 "整份清单被重复列了两遍"(20 种不同的重复短组)→ 不像"同一条贴片反复插",D 不可信,走旧逻辑(这里保险丝整份放行)
    {
        const R = rng(25);
        const longG = [];
        for (let i = 0; i < 30; i++) longG.push([4, `https://v.cdn-a.com/m/x/L${i}.ts`]);
        const shorts = [];
        let n = 0;
        for (let k = 0; k < 20; k++) {
            const g = [];
            const c = 3 + Math.floor(R() * 8);
            for (let j = 0; j < c; j++) g.push([1 + R() * 3, `https://v.cdn-a.com/m/x/s${n++}.ts`]);
            shorts.push(g);
        }
        const r = run(build([longG, ...shorts, ...shorts]));
        ok(r.removed.length === 0 && r.outS.length === r.inS.length && !r.log.some(l => l.includes('confirmed creatives')),
            'v2.5: 整份清单重复两遍(20 种重复短组)→ 不当贴片删', { out: r.outS.length, in: r.inS.length });
    }
    // A2 全清单只有同一条素材反复出现(没有非确证组)→ 认不出结构,整份放行,绝不出 0 片
    {
        const r = run(build([CR, CR, CR]));
        ok(r.outS.length === 9 && r.removed.length === 0, 'v2.5: 全是同一素材 → 整份放行', { out: r.outS.length });
    }
    // A3 规则 G:确证贴片 + 第二个正片目录被切成 10 个 16s 短组(F 判外来,占 27% 触发保险丝)→ 只删确证贴片,其余全留
    {
        const A1 = [], A2 = [], Bs = [];
        for (let i = 0; i < 50; i++) { A1.push([4, `https://v.cdn-y.com/m/A/a${i}.ts`]); A2.push([4, `https://v.cdn-y.com/m/A/b${i}.ts`]); }
        for (let k = 0; k < 10; k++) { const g = []; for (let j = 0; j < 8; j++) g.push([2, `https://v.cdn-y.com/m/B/k${k}_${j}.ts`]); Bs.push(g); }
        const r = run(build([CR, A1, CR, ...Bs, A2]));
        ok(Math.abs(r.removedSec - 28.4) < 0.01 && r.removed.every(s => s.url.includes('ad.cdn-b.com')) && r.log.some(l => l.includes('fuse on unconfirmed')),
            'v2.5 G: 未确证删除触发保险丝 → 只删确证贴片(不再整份放行)', { rm: +r.removedSec.toFixed(2), log: r.log });
    }
    // A4 D 只认短组:正片(≥15 片)被列了两遍不算贴片;中间那条独立短插播照旧规则删
    {
        const X = [];
        for (let i = 0; i < 40; i++) X.push([4, `https://v.cdn-y.com/m/X/x${i}.ts`]);
        const ad = [0, 1, 2, 3, 4].map(i => [3, `https://v.cdn-y.com/ad/z${i}.ts`]);
        const r = run(build([X, ad, X]));
        ok(Math.abs(r.removedSec - 15) < 0.01 && r.outS.length === 80 && !r.log.some(l => l.includes('confirmed creatives')),
            'v2.5: 长组重复不算确证贴片', { rm: r.removedSec, out: r.outS.length });
    }
    // A5 F:有确证贴片时,正片目录里的短组(两条贴片之间 39.3s、分段时长不规则 —— 场景切块豁免认不出)保留;
    //    整组在外来目录的短组照删
    {
        const c = (tag, n) => Array.from({ length: n }, (_, i) => [4, `https://v.cdn-y.com/m/A/${tag}${i}.ts`]);
        const mid = [7.2, 10.4, 10.1, 4.3, 2.8, 4.5].map((d, i) => [d, `https://v.cdn-y.com/m/A/mid${i}.ts`]);
        const foreign = [[5, 'https://x.cdn-k.com/p/f0.ts'], [5, 'https://x.cdn-k.com/p/f1.ts'], [2.5, 'https://x.cdn-k.com/p/f2.ts']];
        const r = run(build([CR, c('a', 60), CR, mid, CR, c('c', 60), foreign, c('d', 40)]));
        ok(Math.abs(r.removedSec - (3 * 14.2 + 12.5)) < 0.01 && r.outS.length === 166 && r.removed.every(s => !s.url.includes('/m/A/')),
            'v2.5 F: 贴片之间 39.3s 正片保留,外来目录短组照删', { rm: +r.removedSec.toFixed(2), out: r.outS.length });
    }
    // A6 确证贴片不计入保险丝占比:81s 短片,同一贴片 ×2(28.4s)+ 外来目录 12.5s 插播(15%)→ 两样都删
    //    (要是把确证贴片也算进占比,51% 会触发 G,外来插播就漏了)
    {
        const c1 = [4.1, 3.9, 4.2, 3.8, 4.0, 4.0].map((d, i) => [d, `https://v.cdn-y.com/m/A/p${i}.ts`]);
        const c2 = [4.4, 3.6, 4.0, 4.0].map((d, i) => [d, `https://v.cdn-y.com/m/A/q${i}.ts`]);
        const foreign = [[5, 'https://x.cdn-k.com/p/f0.ts'], [5, 'https://x.cdn-k.com/p/f1.ts'], [2.5, 'https://x.cdn-k.com/p/f2.ts']];
        const r = run(build([CR, c1, foreign, CR, c2]));
        ok(Math.abs(r.removedSec - (2 * 14.2 + 12.5)) < 0.01 && r.outS.length === 10 && !r.log.some(l => l.includes('fuse')),
            'v2.5: 确证贴片不计入保险丝占比 → 短片里的外来插播也删', { rm: +r.removedSec.toFixed(2), out: r.outS.length, log: r.log });
    }
    // T1 追踪像素豁免(rewriteUrlsOnly 路径):.jpg 正片在 .top 主 host 上,最后一片 0.3s 余数保留
    const jpg = [];
    for (let i = 0; i < 100; i++) jpg.push([4, `https://img.cdn-z.top/v/seg_${i}.jpg`]);
    jpg.push([0.3, 'https://img.cdn-z.top/v/seg_100.jpg']);
    {
        const r = run(build([jpg]));
        ok(r.outS.length === 101 && r.removed.length === 0, '像素豁免: 主 host + 主导扩展名(.jpg)的 0.3s 末片保留', { out: r.outS.length });
    }
    // T2 同一份清单里外站 0.01s .jpg 追踪像素照删(扩展名一样也不行:host 不是主 host)
    {
        const g = jpg.slice();
        g.splice(50, 0, [0.01, 'https://px.track-w.com/p.jpg']);
        const r = run(build([g]));
        ok(r.outS.length === 101 && r.removed.length === 1 && r.removed[0].url.includes('track-w'), '像素豁免: 外站 .jpg 像素照删', { rm: r.removed.map(s => s.url) });
    }
    // T3 主 host 上、扩展名不是主导扩展名的像素(.ts 清单里的 .gif)照删
    {
        const g = [];
        for (let i = 0; i < 100; i++) g.push([3, `s${i}.ts`]);
        g.push([0.01, 'https://example.com/a/b/t.gif']);
        const r = run(build([g]));
        ok(r.outS.length === 100 && r.removed.length === 1 && r.removed[0].url.endsWith('t.gif'), '像素豁免: 主 host 上的 .gif 像素照删');
    }
    // T4 过滤路径:确证贴片删掉后,主 host/主导扩展名按正片算;正片 .jpg 末片保留、外站像素照删
    {
        const cr = [0, 1, 2, 3].map(i => [3, `ad/c${i}.jpg`]).concat([[3.04, 'ad/c4.jpg']]);
        const c1 = [], c2 = [];
        for (let i = 0; i < 60; i++) c1.push([4, `https://v.cdn-q.top/20261120/abc/seg_${i}.jpg`]);
        for (let i = 60; i < 120; i++) c2.push([4, `https://v.cdn-q.top/20261120/abc/seg_${i}.jpg`]);
        c2.splice(30, 0, [0.01, 'https://px.track-w.com/p.jpg']);
        c2.push([0.27, 'https://v.cdn-q.top/20261120/abc/seg_120.jpg']);
        const r = run(build([cr, c1, cr, c2]));
        ok(Math.abs(r.removedSec - (2 * 15.04 + 0.01)) < 0.01 && r.outS.length === 121 && r.outS[r.outS.length - 1].url.endsWith('seg_120.jpg'),
            '像素豁免(过滤路径): 贴片 ×2 + 外站像素删,0.27s .jpg 末片保留', { rm: +r.removedSec.toFixed(2), out: r.outS.length });
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
