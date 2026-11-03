#!/usr/bin/env node
// 线路时长比较(内嵌广告的唯一线索)回归 —— 离线、零网络:
//   node scripts/src-len-test.mjs
// 被测:public/index.html 的 <dg-src-len-core>(净时长 / 判定)、_srcLen* 方法、标签文案、sourceGroups 的排序。
// 数据:fixtures/sources/src-len.json —— 2026-11 实抓 23 部剧 93 集各线路清单结构和线上口径的票(不含地址,见 _doc);fixtures/worker —— 真实清单对照 CF Worker。
// 规则改动时这里的数字必须显式更新:判长多少条是产品决定,不是实现细节。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const C = require(path.join(root, 'public/libs/js/ad-clip-core.js'));

let pass = 0, fail = 0;
const fails = [];
const ok = (c, name, extra) => { if (c) pass++; else { fail++; fails.push(name + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 600) : '')); } };
const eq = (a, b, name) => ok(a === b, name, { got: a, want: b });

// ---------- 抽取(与 source-list-test 同法) ----------
function matchBrace(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i], n = src[i + 1];
        if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
        if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
        if (c === '"' || c === "'" || c === '`') {
            for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    throw new Error('unbalanced');
}
function extractMember(name) {
    const re = new RegExp('\\n\\s+(?:async\\s+)?' + name.replace(/\$/g, '\\$') + '\\(([^)]*)\\)\\s*\\{');
    const m = re.exec(html);
    if (!m) throw new Error('member not found: ' + name);
    const open = m.index + m[0].length - 1;
    const isAsync = /async\s+[\w$]+\($/.test(m[0].slice(0, m[0].indexOf('(') + 1));
    return { params: m[1], body: html.slice(open, matchBrace(html, open) + 1), isAsync };
}
const cStart = html.indexOf('const SRC_TIER_RANK = {'), cEnd = html.indexOf('const EARLY_SETTLE_MS = 1200;');
const consts = html.slice(cStart, cEnd + 'const EARLY_SETTLE_MS = 1200;'.length);
const coreM = /\/\/ <dg-src-len-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-src-len-core>/.exec(html);
ok(coreM, 'index.html 有 <dg-src-len-core> 段');
const CORE = new Function(coreM[1] + '\nreturn { SRC_LEN, dgSrcLenNet, dgSrcLenVote, dgSrcLenJudge };')();
const { SRC_LEN, dgSrcLenNet, dgSrcLenVote, dgSrcLenJudge } = CORE;

const METHODS = ['srcProfile', '_srcFilterOn', '_srcClipOn', '_clipNativeBadMap', '_clipNativeBad', '_clipNativeSet', '_srcUnreach', '_kzWorkerOk', 'srcGroupOf', '_srcAdBad', 'srcTierRank', '_srcResRankOf', 'srcResRank', 'srcResLabel', 'srcTierLabel', 'srcTitle', '_resTagOf', '_srcResMemo', '_srcRealRes', '_srcResOf', '_srcSetRes', '_srcNoteRes',
    '_srcReachClass', '_pickPreferred', '_autoPick', '_earlyPick', '_srcLogTag', '_failoverNext', '_isKzSource', '_epMatchKey',
    '_srcLenId', '_srcLenPub', 'srcLongSec', 'srcLenNote', '_srcLenArm', '_srcLenTick', '_srcLenStable', '_srcLenEpUrl', '_srcLenPlan', '_srcLenFetch', '_srcLenFinish', '_srcLenUiBusy', '_srcLenPin', '_srcLenPublish', '_srcLenDem', '_srcLenKeep'];
const COMPUTED = ['playableSources', 'sourceGroups', 'availableSources', 'fastSources', 'slowSources'];
let objSrc = '{\n';
METHODS.forEach(n => { const m = extractMember(n); objSrc += '  ' + (m.isAsync ? 'async ' : '') + n + '(' + m.params + ') ' + m.body + ',\n'; });
COMPUTED.forEach(n => { const m = extractMember(n); objSrc += '  get ' + n + '() ' + m.body + ',\n'; });
objSrc += '}';
const factory = new Function('stubs', 'window', 'localStorage', 'location', 'dp', 'AdClipCore', 'document', 'navigator', 'fetch', 'performance', 'setTimeout', 'clearTimeout', 'console',
    consts + '\nlet _navSeq = 1;\nconst vm = Object.assign(' + objSrc + ', stubs);\nreturn { vm, setNav(v) { _navSeq = v; }, getNav() { return _navSeq; } };');

function mkVm(o = {}) {
    const lsMap = new Map(Object.entries(o.ls || {}));
    const ls = { getItem: k => (lsMap.has(k) ? lsMap.get(k) : null), setItem: (k, v) => lsMap.set(k, v), removeItem: k => lsMap.delete(k) };
    const env = {
        clock: 1000, reqs: [], routes: o.routes || {}, inflight: 0, maxInflight: 0,
        video: { paused: false, seeking: false, readyState: 4, duration: 3000, currentTime: 100, buffered: { length: 1, start: () => 90, end: () => 130 } },
        doc: {
            hidden: false, hover: false, activeElement: null, sels: [], listeners: {},
            addEventListener(k, f, op) { (env.doc.listeners[k] = env.doc.listeners[k] || []).push({ f, op }); },
            querySelector(sel) {
                if (o.selectorThrows) throw new Error('bad selector');
                env.doc.sels.push(sel);
                if (sel === '.source-list:hover') return env.doc.hover ? {} : null;   // 选择器写错就拦不住,下面的用例会挂
                if (sel === '.ep-grid') return env.layout.grid;
                if (sel === '.detail-overlay') return env.layout.ov;
                if (sel === '.player-box') return env.layout.player;
                return null;
            },
        },
        layout: { grid: null, ov: null, player: null },
        nav: { onLine: true, connection: o.connection },
        fake: [], signals: [], pending: [],
    };
    const setT = o.fakeTimers ? ((fn, ms) => { const t = { fn, ms, on: true }; env.fake.push(t); return t; }) : setTimeout;
    const clearT = o.fakeTimers ? (t => { if (t) t.on = false; }) : clearTimeout;
    const fetchStub = async (url, op) => {
        env.reqs.push([url, op]);
        if (op && op.signal) env.signals.push(op.signal);
        env.inflight++; env.maxInflight = Math.max(env.maxInflight, env.inflight);
        await new Promise(r => {
            if (o.slow) env.pending.push(r);   // 由用例放行
            if ((o.hold || o.slow) && op && op.signal) op.signal.addEventListener('abort', r);
            if (!o.hold && !o.slow) setImmediate(r);
        });
        env.inflight--;
        if (op && op.signal && op.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        let x = env.routes[url], finalUrl = url;
        if (x && x.redirect) { finalUrl = x.redirect; x = env.routes[finalUrl]; }
        if (x == null) throw new TypeError('Failed to fetch');
        if (x.status) return { ok: false, status: x.status, headers: { get: () => null }, url: finalUrl, text: async () => x.body || '' };   // 错误页也可能是合法清单
        const body = typeof x === 'string' ? x : x.body;
        return { ok: true, status: 200, url: finalUrl, headers: { get: k => (k === 'content-length' && x.len ? String(x.len) : null) }, text: async () => body };
    };
    let made;
    made = factory(Object.assign({
        siteProfiles: o.profiles || {}, corsProxyUrl: 'https://w.example', srcRev: 0,
        currentGroup: { sources: o.sources || [] }, episodeList: o.episodeList || [{ name: '第5集', url: 'u5' }, { name: '第6集', url: 'u6' }], currentUrl: 'u5',
        currentSource: o.current || null, isTestingSources: false, previewLocked: false, trial: { on: false },
        _adProxyBad: () => false, _sourceHasEpisode: () => null, _srcHevcOk: () => o.hevc !== false, _isCasting: () => false,
        $nextTick(f) { env.afterTick = f; env.tickAtRev = made.vm.srcRev; },
    }, o.vm || {}), { AdFilter: { isEnabled: () => true }, Hls: { isSupported: () => true }, AdClipCore: { probeTs() { } }, adClipSkip: {}, adCut: { busy: () => !!o.adCutBusy }, afpOffline: o.afp, _dgPreferNativeHls: false, fetch: fetchStub, innerHeight: 800, matchMedia: q => ({ matches: q === '(hover: hover)' ? o.noHover !== true : o.noHover === true }) },
        ls, { protocol: o.protocol || 'https:', hostname: 'ednovas.video' }, { video: env.video }, C, env.doc, env.nav, fetchStub, { now: () => env.clock }, setT, clearT, { log() { }, warn() { } });
    return Object.assign(made, { env, lsMap });
}
const Src = (key, type, latency, tier, res, extra) => Object.assign({ site_key: key, site_name: key, vod_id: 7, latency, _testType: type, site_profile: tier ? { tier, res: res || '', geo: 0, note: '', codec: '' } : null, vod_play_url: '第5集$https://cdn.example/' + key + '/5.m3u8#第6集$https://cdn.example/' + key + '/6.m3u8' }, extra || {});
const keys = a => a.map(s => s.site_key).join(',');
const tick = () => new Promise(r => setImmediate(r));
const GRP = (gl, gn) => gl.map((dur, i) => ({ dur, n: gn[i] }));

// ============ 1) 净时长 ============
console.log('[1] 只看清单文本的净时长');
const VOTE_PIN = '5-73e358d5';
{
    eq(dgSrcLenNet([], 0), null, '空 → 无数据');
    let x = dgSrcLenNet(GRP([2795.52], [932]), 2795.52);
    ok(x && x.d === 2795.52 && x.cut === 0, '全集一组:d = tot', x);
    x = dgSrcLenNet(GRP([300, 25.76, 2100, 25.76, 487], [100, 9, 701, 9, 162]), 2938.52);
    ok(x && Math.abs(x.d - 2887) < 0.01, '非切块:减掉所有短组(暴风型 2 段 25.76s)', x);
    x = dgSrcLenNet(GRP([1000, 120.5, 1000], [300, 10, 300]), 2120.5);
    ok(x && x.d === 2120.5, '超过 120s 的组不算短组', x);
    x = dgSrcLenNet(GRP([1000, 100, 1000], [300, 15, 300]), 2100);
    ok(x && x.d === 2100, '15 片及以上的组不算短组', x);
    x = dgSrcLenNet(GRP([500, 2.5, 500], [100, 1, 100]), 1002.5);
    ok(x && x.d === 1002.5, '不足 3s 的组不算短组', x);
    eq(dgSrcLenNet(GRP([100, 30, 30, 30], [100, 5, 5, 5]), 190), null, '减掉超过 20% → 无数据');
    // 切块(每 5 片一组):规则与 worker 相同。chunk 在 20 个整组后接一段非整 N 组
    const chunk = (mid, tail = 0) => { const gl = [], gn = []; for (let i = 0; i < 20; i++) { gl.push(20); gn.push(5); } mid.forEach(([d, n]) => { gl.push(d); gn.push(n); }); for (let i = 0; i < tail; i++) { gl.push(20); gn.push(5); } const tot = gl.reduce((a, v) => a + v, 0); return [GRP(gl, gn), tot]; };
    let [g, tot] = chunk([[16, 4], [17.6, 3], [8, 2]], 2);
    x = dgSrcLenNet(g, tot);
    ok(x && Math.abs(x.d - (tot - 17.6 - 8)) < 0.01 && x.skip.join() === '21,22', '切块:连续段首组是被打断的正片,其后的才减(dytt 型 4 | 3,2)', x);
    [g, tot] = chunk([[16, 3], [17.6, 9], [8, 2]], 2);
    x = dgSrcLenNet(g, tot);
    ok(x && Math.abs(x.d - (tot - 17.6)) < 0.01 && x.skip.join() === '21', '切块:首尾片数凑成整 N → 只减中间(模都型 3|9|2)', x);
    [g, tot] = chunk([[12.01, 4]], 3);
    x = dgSrcLenNet(g, tot);
    ok(x && x.skip.length === 0, '切块:单独一个非整 N 组视为正片', x);
    { const gl = [], gn = []; for (let i = 0; i < 20; i++) { gl.push(20); gn.push(5); if (i === 5 || i === 12) { gl.push(12.01); gn.push(4); } }   // 正片余数恰好等长(国色芳华 / 大奉 mdzy)旧规则会误减
        const t = gl.reduce((a, v) => a + v, 0); x = dgSrcLenNet(GRP(gl, gn), t); ok(x && x.skip.length === 0 && x.d === t, '切块:等长的正片余数不减', x); }
    { const gl = [16, 17.6], gn = [4, 3]; for (let i = 0; i < 20; i++) { gl.push(20); gn.push(5); }
        const t = gl.reduce((a, v) => a + v, 0); x = dgSrcLenNet(GRP(gl, gn), t); ok(x && x.skip.length === 0, '切块:开头的连续段不动(同 worker)', x); }
    [g, tot] = chunk([[16, 4], [130, 3]], 2);
    x = dgSrcLenNet(g, tot);
    ok(x && x.skip.length === 0, '切块:超过 120s 的组不算短组', x);
    // 经典 SSAI:广告位是几条等长小广告背靠背,组数一多会冒充"每 3 片切块";整 N 组扛不起 70% 片长就不算切块(条件与 worker 相同)
    { const gl = [], gn = []; for (let s = 0; s < 3; s++) { gl.push(900); gn.push(451); for (let k = 0; k < 6; k++) { gl.push(15); gn.push(3); } } gl.push(900); gn.push(451);
        const t = gl.reduce((a, v) => a + v, 0); x = dgSrcLenNet(GRP(gl, gn), t); ok(x && Math.abs(x.d - 3600) < 0.01, '经典 SSAI 不冒充切块:18 条小广告全减', x); }
    // 票的算法变了,夹具里的 fp 要跟着重新生成:这里钉一个具体值
    { const fr = [2.002, 2.002, 4.004, 1.96].map(d => ({ cc: 0, duration: d })).concat([5, 5].map(d => ({ cc: 1, duration: d }))).concat([3.003].map(d => ({ cc: 2, duration: d })));
        const gs = [{ cc: 0 }, { cc: 1 }, { cc: 2 }];
        eq(dgSrcLenVote(fr, gs, [1]), VOTE_PIN, '票的算法钉死(改了要重新生成夹具)');
        ok(dgSrcLenVote(fr, gs, []) !== VOTE_PIN, '被减的组不进票'); }
    // 组数不到 10 不算切块,所有短组都减
    x = dgSrcLenNet(GRP([20, 20, 20, 20, 20, 20, 13.2], [5, 5, 5, 5, 5, 5, 3]), 133.2);
    eq(x, null, '不足 10 组不算切块:短组全减,超 20% → 无数据');
}

// ============ 2) 与真实 CF Worker 对照 ============
console.log('[2] 净时长对照 worker');
{
    const src = fs.readFileSync(path.join(root, 'cloudflare-cors-proxy.js'), 'utf8').split('\r').join('').replace('export default {', 'const __workerDefault = {');
    const W = new Function('console', src + '\nreturn { rewriteM3u8 };')({ log() { }, warn() { }, error() { } });
    const BASE = new URL('https://example.com/a/b/index.m3u8');
    const sumT = t => t.split(/\r?\n/).filter(l => l.startsWith('#EXTINF:')).reduce((a, l) => a + (parseFloat(l.slice(8)) || 0), 0);
    const FIX = path.join(root, 'scripts/fixtures/worker');
    const CLOSE = ['1080zyk_dune', 'aqyzy_boys1', 'bf13_e1', 'dynet_e1', 'ffzy_v1', 'hongniu_lx1', 'huya_lx1', 'ikun_e3', 'kz_dm84_5772_dytt', 'kz_moonci_335_hls', 'mdzy_chunk20_e3', 'rycj_hp1', 'rycj_lx1', 'rycj_lx24', 'wujin_e1', 'yinghua_e1', 'yinghua_e3', 'z360_e1'];
    const NODATA = ['qwe_zuid_e1', 'qwe_zuid_e2', 'wsyzy_fhl1'];
    const out = {};
    for (const f of fs.readdirSync(FIX).filter(x => x.endsWith('.m3u8'))) {
        const t = fs.readFileSync(path.join(FIX, f), 'utf8');
        const p = C.parseMedia(t, BASE.href);
        const net = dgSrcLenNet(p.groups, p.frags.reduce((a, s) => a + s.duration, 0));
        out[f.replace('.m3u8', '')] = net ? net.d - sumT(W.rewriteM3u8(t, BASE, 'https://w.example')) : null;
    }
    CLOSE.forEach(k => ok(out[k] != null && Math.abs(out[k]) < 0.5, k + ':与 worker 剪后时长差 <0.5s', out[k]));
    NODATA.forEach(k => eq(out[k], null, k + ':清单结构看不懂 → 无数据'));
    eq(Object.keys(out).length, CLOSE.length + NODATA.length, '夹具全部覆盖,没有漏算的清单');
}

// ============ 3) 判定 ============
console.log('[3] 判定规则');
const R = (id, d, fp, cut) => ({ id, d, fp: fp || id, cut: cut || 0 });
// 夹具一行 → 线上的一行。same = 这条线路和本集第 same 条同地址(线上只拉一次,结果写给两条线路)
const rowOf = (e, l, sm) => { const b = l.same != null ? e.lines[l.same] : l, x = sm || b; const g = x.g <= 1 ? [{ dur: x.tot, n: 1 }] : GRP(x.gl, x.gn); const net = dgSrcLenNet(g, x.tot); return net ? { id: l.k, d: net.d, cut: net.cut, fp: x.fp } : null; };
const rowsOf = e => e.lines.filter(l => !l.clip).map(l => rowOf(e, l)).filter(Boolean);
{
    eq(dgSrcLenJudge([R('a', 2800), R('b', 2800, 'a')]).long.size, 0, '不足 3 票 → 不判');
    eq(dgSrcLenJudge([R('a', 400), R('b', 400), R('c', 500)]).base, null, '中位数 <600s → 不判');
    eq(dgSrcLenJudge([R('a', 2800), R('b', 2850), R('c', 2900)]).base, null, '没有 2 票簇 → 不判');
    let j = dgSrcLenJudge([R('a', 2800, 'x'), R('b', 2800, 'x'), R('c', 2900), R('d', 2950)]);
    eq(j.base, null, '多条线路同一指纹只算 1 票');
    j = dgSrcLenJudge([R('a', 2795.5, 'x'), R('b', 2795.5, 'y'), R('c', 2923.6), R('d', 2923.6, 'c2')]);
    ok(j.base === 2795.5 && j.long.size === 2 && Math.round(j.long.get('c')) === 128 && j.clean.has('a') && j.clean.has('b'), '秒数相同但指纹不同算 2 票(大奉 e5 百度 / 无尽),众数带广告也不影响', { base: j.base, long: [...j.long] });
    j = dgSrcLenJudge([R('ry', 2650), R('a', 2795, 'x'), R('b', 2795, 'y'), R('c', 2923)]);
    ok(j.base === 2795 && j.clean.has('ry') && !j.long.has('ry'), '单独一条最短的不当基准(如意常去掉片头),它自己算不长', { base: j.base });
    j = dgSrcLenJudge([R('m1', 700), R('m2', 700, 'm2b'), R('a', 2795, 'x'), R('b', 2795, 'y'), R('c', 2923)]);
    ok(j.base === 2795 && !j.long.has('m1') && !j.clean.has('m1'), '中位数 75% 以下的残片(芒果试看)不做基准,也不判长', { base: j.base });
    j = dgSrcLenJudge([R('a', 2700, 'x', 0.1), R('b', 2700, 'y', 0.1), R('c', 2795, 'c1'), R('d', 2795, 'd1'), R('e', 2930)]);
    ok(j.base === 2795 && !j.long.has('a'), 'cut>6% 的线路不当基准', { base: j.base });
    j = dgSrcLenJudge([R('c', 2795, 'c1'), R('d', 2795, 'd1'), R('e', 2930, 'e1', 0.1)]);
    ok(j.long.has('e'), '…但可以被判长');
    j = dgSrcLenJudge([R('a', 2000, 'x'), R('b', 2000, 'y'), R('c', 2029.9), R('d', 2030)]);
    ok(!j.long.has('c') && j.clean.has('c') && j.long.has('d'), '阈值 30s:29.9 不判,30 判');
    // 带种子抽样:少拉线路只会少判,不会多判,基准不会低于全量
    let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const EP = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/sources/src-len.json'), 'utf8')).episodes;
    let viol = [];
    for (const e of EP) {
        const all = rowsOf(e), full = dgSrcLenJudge(all);
        for (const keep of [0.3, 0.5, 0.7, 0.9]) for (let k = 0; k < 15; k++) {
            const sub = all.filter(() => rnd() < keep), v = dgSrcLenJudge(sub);
            if (v.base != null && full.base != null && v.base < full.base - 0.01) viol.push([e.key, 'base', v.base, full.base]);
            if (v.base != null && full.base == null) viol.push([e.key, 'new-base']);
        }
    }
    ok(viol.length === 0, '抽样线路:基准不会低于全量基准', viol.slice(0, 5));
}

// ============ 4) 真实数据 ============
console.log('[4] 93 集真实数据');
const FLIP_MAX = 2;
{
    const EP = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/sources/src-len.json'), 'utf8')).episodes;
    const J = {}; let totalLong = 0, epsLong = 0, noZ = 0;
    for (const e of EP) {
        const v = dgSrcLenJudge(rowsOf(e));
        J[e.key] = v; totalLong += v.long.size; if (v.long.size) epsLong++;
        for (const l of e.lines) if (!l.clip && (l.k === 'zuid' || l.k === 'zuidadb') && !rowOf(e, l)) noZ++;
    }
    console.log('    判长 ' + totalLong + ' 条,' + epsLong + '/' + EP.length + ' 集有判长,最大无数据 ' + noZ + ' 条');
    const CASES = [
        ['大奉打更人|1', 2872, 0], ['大奉打更人|5', 2796, 14], ['大奉打更人|10', 2635, 14], ['大奉打更人|20', 2586, 14],
        ['庆余年第二季|5', 2730, 9], ['庆余年第二季|20', 2727, 4], ['折腰|10', 2835, 18], ['长相思第二季|20', 2725, 17],
        ['玫瑰的故事|5', 2817, 0],   // 短版 2733 只有 360 一个上游(zy360 / zy360b 同一票),单票不当基准
        ['恋爱博士|5', 3982, 11], ['凡人修仙传|10', 1175, 16],   // 这两集多出来的已知不是广告(片尾字幕、小剧场):所以标签只能说"可能"
        ['白月梵星|5', 2834, 0], ['永夜星河|5', 2760, 0], ['九重紫|10', 2743, 0], ['伟大的长征|10', 2749, 0], ['尚公主|5', 2890, 0], ['嫁金钗|13', 3200, 0], ['嫁金钗|16', 3440, 0],
    ];
    for (const [k, base, n] of CASES) {
        const v = J[k];
        ok(v && v.base != null && Math.abs(v.base - base) <= 1, k + ':基准 ' + base, v && v.base);
        ok(v && v.long.size === n, k + ':判长 ' + n + ' 条', v && [...v.long.keys()]);
    }
    const d5 = J['大奉打更人|5'];
    ok([...d5.long.values()].every(s => Math.abs(s - 128) < 1.5), '大奉 e5:判长的都是 +128s', [...d5.long.values()]);
    ok(d5.long.has('jisu') && !d5.long.has('rycj') && !d5.long.has('wujinys') && !d5.long.has('bdzy'), '大奉 e5:极速判长,无尽/百度不判,如意不参与');
    const e2 = J['嫁金钗|2'];
    ok(e2 && Math.abs(e2.base - 2984) <= 1 && e2.long.size === 1 && e2.long.has('bfzy') && Math.round(e2.long.get('bfzy')) === 235, '嫁金钗 e2:只判暴风 +235(站方挂错集,后排有利)', e2 && [...e2.long]);
    eq(totalLong, 209, '全量判长总数(规则变了要显式更新)');
    eq(epsLong, 29, '有判长的集数');
    eq(noZ, 164, '最大:清单按镜头乱切,全部无数据');
    // 尚公主 e10:百度 / 无尽同一次切片、文件名不同,以前算 2 票,短的这份单独决定了基准;现在算 1 票,这集不判(多出的 35s 没抽帧确认过,未必不是真内容)
    const sg = J['尚公主|10'];
    ok(sg && Math.abs(sg.base - 2893) <= 1 && sg.long.size === 0, '尚公主 e10:同一次切片改文件名只算 1 票', sg && [sg.base, sg.long.size]);
    // 和 worker 剪后时长对照:切块清单只剩 3 条差 17.6s(worker 还按目录认外来短组,这里只看文本),其余 22 条是非切块的随机插广告清单
    const wdiff = []; let wAll = 0;
    for (const e of EP) for (const l of e.lines) { if (l.clip || l.w == null) continue; wAll++; const x = rowOf(e, l); if (x && Math.abs(x.d - l.w) >= 2) wdiff.push([e.key, l.k, +(x.d - l.w).toFixed(1)]); }
    console.log('    对照 worker ' + wAll + ' 条,差 >=2s 的 ' + wdiff.length + ' 条');
    eq(wdiff.length, 25, '与 worker 差 2s 以上的条数', wdiff);
    ok(wdiff.every(x => x[0] !== '大奉打更人|20' && x[0] !== '与凤行|10'), '大奉 e20 mdzy、与凤行 e10 ikun:被打断的正片余数恰好等长,不再多减 / 少减', wdiff);
    // 同一上游多次抽样:判定不翻转(zy360 / aqyzy 每拉一次清单都不同)。带种子重放,每条线路随机抽一次结果
    let seed = 42; const rnd = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const flip = [];
    for (const e of EP) {
        const seen = new Set(), bases = new Set();
        for (let t = 0; t < 200; t++) {
            const pick = new Map();
            const rows = e.lines.filter(l => !l.clip).map(l => { const b = l.same != null ? e.lines[l.same] : l; if (!pick.has(b)) { const all = [b].concat(b.alt || []); pick.set(b, all[rnd(all.length)]); } return rowOf(e, l, pick.get(b)); }).filter(Boolean);
            const v = dgSrcLenJudge(rows);
            seen.add(v.long.size); bases.add(v.base == null ? 'null' : Math.round(v.base));
        }
        if (Math.max(...seen) - Math.min(...seen) >= 2 || (Math.min(...seen) === 0 && Math.max(...seen) > 0)) flip.push([e.key, [...bases], [...seen]]);
    }
    console.log('    多次抽样判定会翻转的集:' + flip.length + ' ' + JSON.stringify(flip).slice(0, 400));
    ok(flip.length <= FLIP_MAX, '多次抽样判定翻转的集数不超过 ' + FLIP_MAX, flip);
}

// ============ 5) 标签 ============
console.log('[5] 标签');
{
    // 观众一眼要懂:说结论、留余地,不写秒数(秒数在悬停说明里);判过的 11 组抽帧 7 组是广告,所以不能写死
    const pill = /<span v-if="srcLongSec\(source\)" class="src-geo">([^<]*)<\/span>/.exec(html);
    eq(pill && pill[1], '可能有广告', '标签文字');
    ok(!/偏长/.test(html.slice(html.indexOf('<div class="controls-area"'), html.indexOf('<!-- 全部不可用提示 -->'))), '模板里不再出现"偏长"');
}

// ============ 6) 排序 ============
console.log('[6] sourceGroups 排序');
const PUB = (vm, setL, long, clean, keep) => { vm._srcLen = { nav: setL, key: 'k', done: true, ctrls: new Set(), pub: { long: new Map(long), clean: new Set(clean), keep: keep || '' } }; vm.srcRev++; };
const ID = k => k + '|7';
const groupsOf = vm => vm.sourceGroups.map(g => g.tier + ':' + keys(g.items)).join(' ; ');
{
    const list = () => [Src('long1080', 'direct', 200, 'ads', '1080p'), Src('clean1080', 'direct', 900, 'ads', '1080p'), Src('clean720', 'direct', 100, 'ads', '720p'), Src('fast', 'direct', 150, 'noburn', '1080p'), Src('u', 'server', 300, null)];
    let E = mkVm({ sources: list() }); const before = groupsOf(E.vm);
    ok(before.includes('ads:long1080,clean720,clean1080'), '没有发布结果时:按原规则(快线优先)', before);
    PUB(E.vm, 1, [[ID('long1080'), 128]], [ID('clean1080'), ID('clean720')]);
    let after = groupsOf(E.vm);
    ok(after.includes('ads:clean1080,long1080,clean720'), '有判定:同分辨率内不长的排前,1080P 长线路仍在 720P 之前(不降分辨率)', after);
    ok(after.includes('clean:fast') && after.includes('unreach:u'), '分组成员不变', after);
    eq(E.vm.availableSources.length, 5, '线路总数不变');
    // 打乱输入顺序结果相同
    E = mkVm({ sources: list().reverse() }); PUB(E.vm, 1, [[ID('long1080'), 128]], [ID('clean1080'), ID('clean720')]);
    eq(groupsOf(E.vm), after, '打乱输入顺序结果相同');
    // 导航变了立即失效
    E = mkVm({ sources: list() }); PUB(E.vm, 1, [[ID('long1080'), 128]], [ID('clean1080')]); E.setNav(2); E.vm.srcRev++;
    eq(groupsOf(E.vm), before, '_navSeq 变了:结果作废,回到原排序');
    eq(E.vm.srcLongSec(E.vm.currentGroup.sources[0]), 0, '…角标也没了');
    // 没有分辨率足够的替代:不后排
    E = mkVm({ sources: [Src('long1080', 'direct', 200, 'ads', '1080p'), Src('clean720', 'direct', 100, 'ads', '720p')] });
    let b0 = groupsOf(E.vm); PUB(E.vm, 1, [[ID('long1080'), 128]], [ID('clean720')]);
    eq(groupsOf(E.vm), b0, '替代线路分辨率更低:不后排');
    ok(E.vm.srcLongSec(E.vm.currentGroup.sources[0]) === 128, '…角标照标');
    // 替代太慢 / 本次导航失败过 / 不能解码:不算替代
    E = mkVm({ sources: [Src('long', 'direct', 200, 'ads', '1080p'), Src('slow', 'direct', 3100, 'ads', '1080p')] });
    b0 = groupsOf(E.vm); PUB(E.vm, 1, [[ID('long'), 128]], [ID('slow')]); eq(groupsOf(E.vm), b0, '替代 >=3000ms 不算');
    E = mkVm({ sources: [Src('long', 'direct', 200, 'ads', '1080p'), Src('dead', 'direct', 900, 'ads', '1080p', { _failNav: 1 })] });
    b0 = groupsOf(E.vm); PUB(E.vm, 1, [[ID('long'), 128]], [ID('dead')]); eq(groupsOf(E.vm), b0, '替代本次导航播放失败过不算');
    const hv = Src('h265', 'direct', 900, 'ads', '1080p'); hv.site_profile.codec = 'hevc';
    E = mkVm({ sources: [Src('long', 'direct', 200, 'ads', '1080p'), hv], hevc: false });
    b0 = groupsOf(E.vm); PUB(E.vm, 1, [[ID('long'), 128]], [ID('h265')]); eq(groupsOf(E.vm), b0, '替代本机解不了 HEVC 不算');
    // >=3000ms 的线路不压在长线路之前
    E = mkVm({ sources: [Src('long', 'direct', 200, 'ads', '1080p'), Src('c', 'direct', 500, 'ads', '1080p'), Src('slow', 'direct', 3500, 'ads', '1080p')] });
    PUB(E.vm, 1, [[ID('long'), 128]], [ID('c'), ID('slow')]);
    ok(groupsOf(E.vm).includes('ads:c,long,slow'), '>=3000ms 的线路不压在长线路之前', groupsOf(E.vm));
    // 在播线路不挪位
    E = mkVm({ sources: [Src('long', 'direct', 200, 'ads', '1080p'), Src('c', 'direct', 500, 'ads', '1080p')] });
    b0 = groupsOf(E.vm); PUB(E.vm, 1, [[ID('long'), 128]], [ID('c')], ID('long'));
    eq(groupsOf(E.vm), b0, '发布时的在播线路不挪位');
    ok(E.vm.srcLongSec(E.vm.currentGroup.sources[0]) === 128, '…角标照标');
    // 组内还有别的后排线路:在播线路照样留在原下标;失败换源的下一条不因发布而变
    const order = (srcs, long, clean, keep) => { const X = mkVm({ sources: srcs }); const pre = keys(X.vm.sourceGroups[0].items); PUB(X.vm, 1, long.map(k => [ID(k), 128]), clean.map(ID), keep ? ID(keep) : ''); return [pre, keys(X.vm.sourceGroups[0].items), X]; };
    let pre, post, X;
    [pre, post] = order([Src('play720', 'direct', 100, 'ads', '720p'), Src('long1080', 'direct', 200, 'ads', '1080p'), Src('slow1080', 'direct', 1500, 'ads', '1080p')], ['long1080'], ['play720', 'slow1080'], 'play720');
    eq(pre, 'long1080,play720,slow1080', '#19 发布前');
    eq(post, 'long1080,play720,slow1080', '#19 长线路不跨过在播线路(跨过去它就成了失败换源的下一条)');
    [pre, post, X] = order([Src('play720', 'direct', 100, 'ads', '720p'), Src('long1080', 'direct', 200, 'ads', '1080p'), Src('slow1080', 'direct', 1500, 'ads', '1080p')], ['long1080'], ['play720', 'slow1080'], 'play720');
    eq(X.vm._failoverNext(X.vm.availableSources, X.vm.currentGroup.sources[0], '').site_key, 'slow1080', '#19 从在播线路失败:下一跳是不长的那条');
    [pre, post] = order([Src('l1', 'direct', 100, 'ads', '1080p'), Src('a1', 'direct', 150, 'ads', '1080p'), Src('play', 'direct', 200, 'ads', '1080p'), Src('l2', 'direct', 300, 'ads', '1080p'), Src('a2', 'direct', 400, 'ads', '1080p')], ['l1', 'l2'], ['a1', 'a2'], 'play');
    eq(pre, 'l1,a1,play,l2,a2', '两侧各有一对 发布前');
    eq(post, 'a1,l1,play,a2,l2', '在播线路两侧各自调整');
    [pre, post] = order([Src('c720', 'direct', 1000, 'ads', '720p'), Src('l1080', 'direct', 1000, 'ads', '1080p'), Src('c1080', 'direct', 1100, 'ads', '1080p'), Src('u', 'server', 300, null)], ['l1080'], ['c720', 'c1080'], 'l1080');
    eq(post, pre, '在播线路自己偏长:不动');
    [pre, post, X] = order([Src('k1080', 'direct', 3200, 'ads', '1080p'), Src('c720', 'direct', 1700, 'ads', '720p'), Src('l720', 'direct', 1800, 'ads', '720p')], ['l720'], ['c720', 'k1080'], 'k1080');
    eq(post, pre, '#6 D:慢的在播线路不被挪到后面,长线路后面没替代也不动');
    [pre, post, X] = order([Src('c720', 'direct', 100, 'ads', '720p'), Src('l1080', 'direct', 1000, 'ads', '1080p'), Src('c1080', 'direct', 1100, 'ads', '1080p'), Src('u', 'server', 300, null)], ['l1080'], ['c720', 'c1080'], 'c720');
    eq(post, 'c720,c1080,l1080', '#6 E:在播线路留在组首');
    eq(X.vm._failoverNext(X.vm.availableSources, X.vm.currentGroup.sources[0], '').site_key, 'c1080', '#6 E:从在播线路失败,下一跳留在本组');
    // 在播线路失败:下一条接替,长线路不会排到还没试过的线路前面
    {
        const ls = [Src('a', 'direct', 100, 'ads', '1080p'), Src('L', 'direct', 200, 'ads', '1080p'), Src('keep', 'direct', 300, 'ads', '1080p'), Src('b', 'direct', 400, 'ads', '1080p')];
        const Y = mkVm({ sources: ls });
        PUB(Y.vm, 1, [[ID('L'), 120]], [ID('a'), ID('b')], ID('keep'));
        eq(keys(Y.vm.sourceGroups[0].items), 'a,L,keep,b', '发布后:在播线路是屏障');
        const kp = ls[2], rb = ls[3], rev = Y.vm.srcRev;
        const nx = Y.vm._failoverNext(Y.vm.availableSources, kp, '');
        eq(nx.site_key, 'b', '在播线路失败,下一跳是 b');
        kp.latency = 9998; kp._failNav = 1;
        Y.vm._srcLenKeep(nx);
        eq(Y.vm.srcRev, rev + 1, '接替要通知重排');
        eq(keys(Y.vm.sourceGroups[0].items), 'a,L,b', '接替后 b 留在原位,L 没跨过它');
        eq(Y.vm._failoverNext(Y.vm.availableSources, rb, '').site_key, 'a', '再失败:下一跳是没试过的 a,不是偏长的 L');
        const Z = mkVm({ sources: [Src('a', 'direct', 100, 'ads', '1080p')] }), r0 = Z.vm.srcRev;
        Z.vm._srcLenKeep(Z.vm.currentGroup.sources[0]);
        eq(Z.vm.srcRev, r0, '没有发布结果:什么都不做');
    }
    // 无关线路不被打乱
    [pre, post] = order([Src('nb_long1080', 'direct', 300, 'noburn', '1080p'), Src('nb_fast1080', 'direct', 400, 'noburn', '1080p'), Src('nb_fast1080b', 'direct', 500, 'noburn', '1080p'), Src('clean_slow480', 'direct', 1000, 'clean', '480p')], ['nb_long1080'], ['nb_fast1080', 'nb_fast1080b', 'clean_slow480']);
    eq(pre, 'nb_long1080,nb_fast1080,nb_fast1080b,clean_slow480', '#2 A 发布前');
    eq(post, 'nb_fast1080,nb_fast1080b,nb_long1080,clean_slow480', '#2 A:慢的低分辨率线路不被提到组首');
    [pre, post] = order([Src('fast1080b', 'direct', 100, 'ads', '1080p'), Src('fast720', 'direct', 150, 'ads', '720p'), Src('slow1080', 'direct', 2900, 'ads', '1080p'), Src('long1080', 'direct', 2000, 'ads', '1080p')], ['long1080'], ['fast1080b', 'fast720', 'slow1080']);
    eq(pre, 'fast1080b,fast720,long1080,slow1080', '#2 B 发布前');
    eq(post, 'fast1080b,fast720,slow1080,long1080', '#2 B:快线顺序不变,只有长线路和替代互换');
    [pre, post] = order([Src('kz_7sefun', 'direct', 1500, 'clean', '1080p'), Src('rycj', 'direct', 100, 'noburn', '1080p'), Src('bfzy', 'direct', 200, 'noburn', '1080p'), Src('wolong', 'direct', 300, 'noburn', '1080p')], ['bfzy'], ['wolong']);
    eq(pre, 'rycj,bfzy,wolong,kz_7sefun', '#2 kz 发布前');
    eq(post, 'rycj,wolong,bfzy,kz_7sefun', '#2 kz:1500ms 的 kz 不跳到组首');
    [pre, post] = order([Src('kz_moonci', 'direct', 800, 'clean', '1080p'), Src('bfzy', 'direct', 120, 'noburn', '1080p'), Src('rycj', 'direct', 300, 'noburn', '1080p'), Src('wsyzy', 'direct', 400, 'noburn', '1080p')], ['bfzy'], ['wsyzy']);
    eq(pre, 'bfzy,rycj,wsyzy,kz_moonci', '#5 B 发布前');
    eq(post, 'wsyzy,bfzy,rycj,kz_moonci', '#5 B:没比过的 rycj 和 kz 不动,kz 不跳组首');
    [pre, post] = order([Src('c720', 'direct', 900, 'clean', '720p'), Src('nb1080', 'direct', 100, 'noburn', '1080p'), Src('l1080', 'direct', 200, 'noburn', '1080p'), Src('alt1080', 'direct', 300, 'noburn', '1080p')], ['l1080'], ['c720', 'nb1080', 'alt1080']);
    eq(pre, 'nb1080,l1080,alt1080,c720', '#5 C 发布前');
    eq(post, 'nb1080,alt1080,l1080,c720', '#5 C:组首分辨率不掉');
    // 多条偏长
    [pre, post] = order([Src('l1', 'direct', 100, 'ads', '1080p'), Src('l2', 'direct', 200, 'ads', '1080p'), Src('a1', 'direct', 300, 'ads', '1080p'), Src('a2', 'direct', 400, 'ads', '1080p'), Src('z', 'direct', 500, 'ads', '720p')], ['l1', 'l2'], ['a1', 'a2', 'z']);
    eq(post, 'a1,a2,l1,l2,z', '多条偏长:都排到替代后面,彼此顺序不变,低分辨率线路仍垫底');
    // 性质:成员不变 / 在播下标不变 / 组首分辨率不掉 / 长线路后面没有合格替代 / 其余线路相对顺序不变
    let ps = 23; const pr = n => { ps = (ps * 1664525 + 1013904223) >>> 0; return ps % n; };
    const RES = { '1080p': 3, '720p': 2, '480p': 1 }; const bad = [];
    let walks = 0;
    for (let k = 0; k < 400; k++) {
        const ls = Array.from({ length: 3 + pr(9) }, (_, i) => Src('s' + i, 'direct', 60 + pr(3400), 'ads', ['1080p', '720p', '480p'][pr(3)]));
        const long = ls.filter(() => pr(3) === 0), clean = ls.filter(x => !long.includes(x) && pr(4) > 0), keep = pr(2) ? ls[pr(ls.length)] : null;
        const Y = mkVm({ sources: ls }), b = Y.vm.sourceGroups[0].items.slice();
        PUB(Y.vm, 1, long.map(x => [ID(x.site_key), 60]), clean.map(x => ID(x.site_key)), keep ? ID(keep.site_key) : '');
        const a = Y.vm.sourceGroups[0].items, rs = x => RES[x.site_profile.res];
        const isAlt = (x, r) => clean.includes(x) && x !== keep && x.latency < 3000 && rs(x) >= rs(r);
        if (a.length !== b.length || keys(a.slice().sort((p, q) => p.site_key < q.site_key ? -1 : 1)) !== keys(b.slice().sort((p, q) => p.site_key < q.site_key ? -1 : 1))) bad.push(['members', k]);
        if (keep && a.indexOf(keep) !== b.indexOf(keep)) bad.push(['keep', k, keys(b), keys(a), keep.site_key]);
        if (rs(a[0]) < rs(b[0])) bad.push(['head', k, keys(b), keys(a)]);
        const kp = keep ? a.indexOf(keep) : -1;
        a.forEach((r, i) => { if (long.includes(r) && r !== keep && a.slice(i + 1).some(x => isAlt(x, r) && !(kp >= 0 && i < kp && a.indexOf(x) > kp))) bad.push(['alt-after', k, keys(a), r.site_key]); });
        if (keep) {   // 在播线路之后的那段成员不变:长线路和替代都不跨过它
            if (keys(a.slice(kp + 1).slice().sort((p, q) => p.site_key < q.site_key ? -1 : 1)) !== keys(b.slice(kp + 1).slice().sort((p, q) => p.site_key < q.site_key ? -1 : 1))) bad.push(['barrier', k, keys(b), keys(a), keep.site_key]);
            // 从在播线路失败,发布前下一条不是长线路的,发布后也不能变成长线路
            const n0 = b[(kp + 1) % b.length], n1 = a[(kp + 1) % a.length];
            walks++;
            if (b.length > 1 && !long.includes(n0) && long.includes(n1)) bad.push(['next-long', k, keys(b), keys(a), keep.site_key]);
        }
        const rest = l => keys(l.filter(x => !long.includes(x) && !clean.includes(x) && x !== keep));
        if (rest(a) !== rest(b)) bad.push(['rest', k, keys(b), keys(a)]);
    }
    ok(bad.length === 0 && walks > 100, '400 组随机线路:成员、在播下标、组首分辨率、长线路位置、无关线路顺序、在播线路的下一条都成立', bad.slice(0, 3));
    // 可能无法播放组:永远旧比较器
    E = mkVm({ sources: [Src('a', 'direct', 200, null, '1080p'), Src('b', 'direct', 900, null, '1080p')] });
    b0 = groupsOf(E.vm); PUB(E.vm, 1, [[ID('a'), 128]], [ID('b')]); eq(groupsOf(E.vm), b0, '"可能无法播放"组不动');
    // 随机线路:没有 dem 的分组与旧比较器逐条相同(新键不引入任何差异)
    let seed = 11; const rnd = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    let diff = 0;
    for (let k = 0; k < 200; k++) {
        const ls = Array.from({ length: 2 + rnd(8) }, (_, i) => Src('s' + i, ['direct', 'proxy'][rnd(2)], 50 + rnd(4000), ['ads', 'noburn', 'clean', null][rnd(4)], ['1080p', '720p', ''][rnd(3)]));
        const a = mkVm({ sources: ls }), g0 = groupsOf(a.vm);
        a.vm._srcLen = { nav: 1, key: 'k', done: true, ctrls: new Set(), pub: { long: new Map(), clean: new Set(), keep: '' } }; a.vm.srcRev++;
        if (groupsOf(a.vm) !== g0) diff++;
    }
    eq(diff, 0, '没人判长时:200 组随机线路与原排序逐条相同');
    // 真实 Vue 依赖追踪:结果在非响应式的 this._srcLen 里,只有 srcRev++ 能让 computed 重算(桩里的 getter 每次都重算,测不出这一点)
    const Vue = new Function(fs.readFileSync(path.join(root, 'public/libs/js/vue.global.prod.min.js'), 'utf8') + '\nreturn Vue;')();
    const R1 = mkVm({ sources: [Src('long', 'direct', 200, 'ads', '1080p'), Src('c', 'direct', 500, 'ads', '1080p')], routes: {} });
    const rx = Vue.reactive({ srcRev: 0, currentGroup: R1.vm.currentGroup });
    Object.defineProperty(R1.vm, 'srcRev', { get: () => rx.srcRev, set: v => { rx.srcRev = v; } });
    Object.defineProperty(R1.vm, 'currentGroup', { get: () => rx.currentGroup });
    const cg = Vue.computed(() => keys(R1.vm.sourceGroups[0].items));
    eq(cg.value, 'long,c', '真实 computed:发布前');
    R1.vm._srcLen = { nav: 1, key: 'k', done: false, ctrls: new Set(), res: { long: new Map([[ID('long'), 128]]), clean: new Set([ID('c')]), base: 2800 }, pub: null };
    eq(cg.value, 'long,c', '真实 computed:还没发布,不重算');
    R1.vm._srcLenPublish(R1.vm._srcLen);
    eq(cg.value, 'c,long', '真实 computed:发布(srcRev++)后才重排');
}

// ============ 7) 选源隔离 ============
console.log('[7] 选源隔离');
{
    // 发布前后都选长线路才说明没跟着显示顺序走:这几组输入里长线路最快
    for (const [name, mk, ms] of [
        ['全快线', () => [Src('long', 'direct', 120, 'ads', '1080p'), Src('c', 'direct', 500, 'ads', '1080p'), Src('d', 'direct', 550, 'ads', '1080p')], 2000],
        ['全慢线', () => [Src('long', 'direct', 650, 'ads', '1080p'), Src('c', 'direct', 800, 'ads', '1080p'), Src('d', 'direct', 900, 'ads', '1080p')], 2000],
    ]) {
        const a0 = mkVm({ sources: mk() }), b0 = mkVm({ sources: mk() });
        PUB(b0.vm, 1, [[ID('long'), 128]], [ID('c'), ID('d')]);
        eq(keys(b0.vm.sourceGroups[0].items).split(',').pop(), 'long', name + ':发布后显示顺序里长线路在最后');
        const S0 = a0.vm.currentGroup.sources, S1 = b0.vm.currentGroup.sources;
        eq(a0.vm._pickPreferred(S0).site_key, 'long', name + ':发布前 _pickPreferred 选它');
        eq(b0.vm._pickPreferred(S1).site_key, 'long', name + ':发布后 _pickPreferred 还选它');
        eq((b0.vm._autoPick(S1, 2) || {}).site_key, (a0.vm._autoPick(S0, 2) || {}).site_key, name + ':_autoPick 不变');
        eq((b0.vm._autoPick(S1, 2) || {}).site_key, 'long', name + ':_autoPick 还选它');
        eq((b0.vm._earlyPick(S1, ms) || { src: {} }).src.site_key, (a0.vm._earlyPick(S0, ms) || { src: {} }).src.site_key, name + ':_earlyPick 不变');
        eq((b0.vm._earlyPick(S1, ms) || { src: {} }).src.site_key, 'long', name + ':_earlyPick 还选它');
    }
    const list = () => [Src('long', 'direct', 120, 'ads', '1080p'), Src('c', 'direct', 500, 'ads', '1080p'), Src('nb', 'direct', 1100, 'noburn', '1080p'), Src('p', 'proxy', 90, 'ads', '1080p')];
    const a = mkVm({ sources: list() }), b = mkVm({ sources: list() });
    PUB(b.vm, 1, [[ID('long'), 128]], [ID('c'), ID('nb')]);
    const A = a.vm.currentGroup.sources, B = b.vm.currentGroup.sources;
    eq(a.vm._pickPreferred(A).site_key, b.vm._pickPreferred(B).site_key, '_pickPreferred 不受影响');
    eq((a.vm._autoPick(A, 2) || {}).site_key, (b.vm._autoPick(B, 2) || {}).site_key, '_autoPick 不受影响');
    eq((a.vm._earlyPick(A, 2000) || { src: {} }).src.site_key, (b.vm._earlyPick(B, 2000) || { src: {} }).src.site_key, '_earlyPick 不受影响');
    eq(A.map(s => a.vm._srcReachClass(s)).join(), B.map(s => b.vm._srcReachClass(s)).join(), '_srcReachClass 不受影响');
    eq(A.map(s => a.vm._srcUnreach(s)).join(), B.map(s => b.vm._srcUnreach(s)).join(), '_srcUnreach 不受影响');
    eq(a.vm.playableSources.length, b.vm.playableSources.length, 'playableSources 不受影响');
    eq(A.map(s => a.vm.srcProfile(s).tier).join(), B.map(s => b.vm.srcProfile(s).tier).join(), 'srcProfile 档位不受影响');
    const seen = new Set(); let cur = b.vm.availableSources[0];
    for (let i = 0; i < 6 && cur; i++) { seen.add(cur.site_key); cur = b.vm._failoverNext(b.vm.availableSources, cur, ''); }
    ok(['long', 'c', 'nb', 'p'].every(k => seen.has(k)), '_failoverNext 仍能走到每一条线路(含被后排的)', [...seen]);
    const title = b.vm.srcTitle(B[0]);
    ok(title.includes('本集比其他线路长约 128 秒') && !title.includes('含广告'), '悬停说明给出秒数,不写死"含广告"', title);
    // 换线进度偏差看的是和当前线路差多少,不是自己长不长
    {
        const mk = cur => { const E = mkVm({ sources: [Src('l1', 'direct', 100, 'ads', '1080p'), Src('l2', 'direct', 200, 'ads', '1080p'), Src('n', 'direct', 300, 'ads', '1080p'), Src('nodata', 'direct', 400, 'ads', '1080p')] }); const S = E.vm.currentGroup.sources; E.vm.currentSource = cur === null ? null : S.find(x => x.site_key === cur); PUB(E.vm, 1, [[ID('l1'), 120], [ID('l2'), 120.4]], [ID('n')]); return { E, get: k => E.vm.srcTitle(S.find(x => x.site_key === k)) }; };
        const WARN = '从当前线路换过去，进度可能相差约';
        let t = mk('l1');
        ok(t.get('n').includes(WARN + ' 120 秒'), '当前偏长 → 换到正常线路:提示', t.get('n'));
        ok(!t.get('l2').includes(WARN), '当前偏长 → 换到同样偏长的:不提示', t.get('l2'));
        ok(!t.get('l1').includes(WARN), '当前线路自己:不提示', t.get('l1'));
        t = mk('n');
        ok(t.get('l1').includes(WARN + ' 120 秒'), '当前正常 → 换到偏长线路:提示', t.get('l1'));
        ok(!t.get('nodata').includes(WARN), '当前正常 → 换到没比过的线路:不提示(不知道多长)', t.get('nodata'));
        t = mk('nodata');
        ok(!t.get('l1').includes(WARN) && !t.get('n').includes(WARN), '当前线路没比过(如意这类):不提示,不把它当基准长度', t.get('l1'));
        t = mk(null);
        ok(!t.get('l1').includes(WARN), '还没有当前线路:不提示');
    }
    { const c = mkVm({ sources: [Src('bf', 'direct', 120, 'noburn', '1080p')] }); PUB(c.vm, 1, [[ID('bf'), 235]], []);
        const t = c.vm.srcTitle(c.vm.currentGroup.sources[0]);
        ok(t.includes('多出约 235 秒') && t.includes('不在自动去除范围内') && !t.includes('广告或额外内容'), '"无广告"线路判长:不和同一条说明里的"无广告"打架', t); }
    eq(b.vm.srcLenNote(), true, '有角标才显示说明行');
    eq(a.vm.srcLenNote(), false, '没有判定不显示说明行');
}

// ============ 8) 后台拉取 ============
console.log('[8] 后台拉取:闸门 / 并发 / 范围');
const M3U = (segs, extra = '') => '#EXTM3U\n#EXT-X-TARGETDURATION:10\n' + extra + segs.map((d, i) => '#EXTINF:' + d + ',\ns' + i + '.ts\n').join('') + '#EXT-X-ENDLIST\n';
const lenList = sec => { const a = []; for (let t = 0; t < sec; t += 4) a.push(Math.min(4, sec - t)); return a; };
const routesFor = (m) => { const r = {}; for (const [k, sec] of Object.entries(m)) r['https://cdn.example/' + k + '/5.m3u8'] = M3U(lenList(sec)); return r; };
async function drive(E, ms) {   // 模拟 timeupdate:每 250ms 一拍
    for (let t = 0; t < ms; t += 250) { E.vm._srcLenTick(); E.env.clock += 250; await tick(); await tick(); }
}
function armed(o) {
    const E = mkVm(o);
    E.vm.playableSources;   // 触发一次分组
    E.vm._srcLenArm();
    return E;
}
const TOTAL = { a: 2795, b: 2796, c: 2923, d: 2923.2 };
const baseSrcs = () => [Src('a', 'direct', 500, 'ads', '1080p'), Src('b', 'direct', 400, 'ads', '1080p'), Src('c', 'direct', 100, 'ads', '1080p'), Src('d', 'direct', 200, 'ads', '1080p')];
{
    let E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL), current: null });
    await drive(E, 19000);
    eq(E.env.reqs.length, 0, '未满 20s 稳定:0 请求');
    await drive(E, 3000);
    await drive(E, 3000);
    ok(E.env.reqs.length === 4, '满 20s 后拉 4 条', E.env.reqs.map(x => x[0]));
    ok(E.env.maxInflight <= 2, '并发不超过 2', E.env.maxInflight);
    ok(E.env.reqs.every(x => /^https:\/\/cdn\.example\//.test(x[0])), '只直连,没有 /api 和 worker', E.env.reqs.map(x => x[0]));
    ok(E.env.reqs.every(x => x[1].credentials === 'omit' && x[1].priority === 'low'), '低优先级,不带凭据');
    ok(E.env.reqs.every(x => /\/5\.m3u8$/.test(x[0])), '比的是当前集,不是首集', E.env.reqs[0][0]);
    const v0 = E.vm.srcRev; await drive(E, 500); eq(E.vm.srcRev, v0, '发布只有一次');
    eq(v0, 1, '一轮最多 srcRev+1');
    const c = E.vm.currentGroup.sources.find(s => s.site_key === 'c');
    ok(Math.round(E.vm.srcLongSec(c)) === 128, '判长写进结果', E.vm.srcLongSec(c));
    eq(E.vm._srcLen.diag.ok, 4, 'diag:成功 4');

    // 慢网:请求没回来不能下结论;播放不稳了队列也要停
    const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
    const beat = async (E2, n = 1) => { for (let i = 0; i < n; i++) { E2.vm._srcLenTick(); E2.env.clock += 250; await settle(); } };
    const open = async E2 => { const r = E2.env.pending.splice(0); r.forEach(f => f()); await settle(); return r.length; };
    {
        const S = armed({ sources: baseSrcs(), routes: routesFor(TOTAL), slow: true });
        await beat(S, 84);
        eq(S.env.reqs.length, 2, '慢网:并发 2,先发 2 条');
        eq(S.vm._srcLen.busy, 2, '…都在途');
        await beat(S, 40);
        eq(S.env.reqs.length, 2, '…不回来就不发新的');
        eq(await open(S), 2, '…放行 2 条');
        await beat(S, 1);
        eq(S.env.reqs.length, 4, '…再发 2 条');
        eq(S.vm._srcLen.q.length, 0, '…队列空了');
        await beat(S, 12);
        ok(!S.vm._srcLen.res && S.vm._srcLen.busy === 2, '队列空但请求还在途:不下结论', S.vm._srcLen.busy);
        await open(S);
        await beat(S, 2);
        ok(S.vm._srcLen.res && Math.round(S.vm._srcLen.res.base) === 2795 && S.vm._srcLen.res.long.size === 2, '全回来后才判定,用的是全部结果', S.vm._srcLen.diag);
    }
    {
        const manySrc = Array.from({ length: 8 }, (_, i) => Src('s' + i, 'direct', 100 + i, 'ads', '1080p'));
        const r2 = {}; manySrc.forEach(x => { r2['https://cdn.example/' + x.site_key + '/5.m3u8'] = M3U(lenList(2800)); });
        const S = armed({ sources: manySrc, routes: r2, slow: true });
        await beat(S, 84);
        eq(S.env.reqs.length, 2, '队列 8 条:先发 2 条');
        S.env.video.paused = true;
        await open(S);
        await beat(S, 40);
        eq(S.env.reqs.length, 2, '暂停了:队列停住');
        S.env.video.paused = false;
        await beat(S, 40);
        eq(S.env.reqs.length, 2, '恢复后要重新稳定满 20s');
        await beat(S, 45);
        eq(S.env.reqs.length, 4, '…满了才继续');
        S.vm.currentUrl = 'u6';
        const inflight = S.env.signals.slice(-2);
        S.vm._srcLenArm();
        ok(inflight.every(x => x.aborted), '换集:在途请求立刻中止', inflight.map(x => x.aborted));
    }
    // 边界:片尾 180s、前向缓冲 15s
    const gateEdge = async (name, mut, want) => { const E2 = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) }); mut(E2); eq(E2.vm._srcLenStable(), want, name); };
    await gateEdge('距片尾 180s 整:不算稳定', x => { x.env.video.currentTime = 2820; x.env.video.buffered = { length: 1, start: () => 2800, end: () => 2900 }; }, false);
    await gateEdge('距片尾 181s:算稳定', x => { x.env.video.currentTime = 2819; x.env.video.buffered = { length: 1, start: () => 2800, end: () => 2900 }; }, true);
    await gateEdge('前向缓冲 14.9s:不算', x => { x.env.video.currentTime = 100; x.env.video.buffered = { length: 1, start: () => 90, end: () => 114.9 }; }, false);
    await gateEdge('前向缓冲 15s:算', x => { x.env.video.currentTime = 100; x.env.video.buffered = { length: 1, start: () => 90, end: () => 115 }; }, true);

    // 判定为空:srcRev 不动
    E = armed({ sources: baseSrcs(), routes: routesFor({ a: 2795, b: 2796, c: 2797, d: 2798 }) });
    await drive(E, 26000);
    eq(E.vm.srcRev, 0, '没人判长:srcRev 不变');
    ok(E.vm._srcLen.done, '…本集结束');

    // 闸门:任一不满足 0 请求 / 计时清零
    const gate = async (name, mut, o) => {
        const E2 = armed(Object.assign({ sources: baseSrcs(), routes: routesFor(TOTAL) }, o || {}));
        mut(E2);
        await drive(E2, 30000);
        eq(E2.env.reqs.length, 0, '闸门 ' + name + ':0 请求');
    };
    await gate('暂停', x => { x.env.video.paused = true; });
    await gate('seek 中', x => { x.env.video.seeking = true; });
    await gate('缓冲不足', x => { x.env.video.buffered = { length: 1, start: () => 90, end: () => 110 }; });
    await gate('readyState<3', x => { Object.defineProperty(x.env.video, 'readyState', { value: 2 }); });
    await gate('页面隐藏', x => { x.env.doc.hidden = true; });
    await gate('离线', x => { x.env.nav.onLine = false; });
    await gate('saveData', () => { }, { connection: { saveData: true } });
    await gate('2g', () => { }, { connection: { effectiveType: 'slow-2g' } });
    await gate('afp 分析中', () => { }, { afp: { _busy: true } });
    await gate('预剪扫描中', () => { }, { adCutBusy: true });
    await gate('正在测速', x => { x.vm.isTestingSources = true; });
    await gate('预览锁', x => { x.vm.previewLocked = true; });
    await gate('试看', x => { x.vm.trial = { on: true }; });
    await gate('直播', x => { x.vm._liveActive = true; });
    await gate('离线副本', x => { x.vm._activeOffCached = true; });
    await gate('kz', x => { x.vm._activeKz = { type: 'hls' }; });
    await gate('投屏', x => { x.vm._isCasting = () => true; });
    await gate('片尾 180s 内', x => { x.env.video.currentTime = 2900; x.env.video.buffered = { length: 1, start: () => 2890, end: () => 2960 }; });
    await gate('总开关', () => { }, { ls: { donggua_srclen_off: '1' } });

    // 稳定中断后计时清零
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
    await drive(E, 15000);
    E.env.video.paused = true; await drive(E, 1000); E.env.video.paused = false;
    await drive(E, 15000);
    eq(E.env.reqs.length, 0, '稳定中断后重新计时(15s + 中断 + 15s 还不够)');
    await drive(E, 6000);
    ok(E.env.reqs.length > 0, '…连续满 20s 才开始');

    // 集名不干净:不武装
    for (const name of ['第5集上', '第5集国语', 'HD中字', '20261102', '']) {
        const X = mkVm({ sources: baseSrcs(), routes: routesFor(TOTAL), episodeList: [{ name, url: 'u5' }] });
        X.vm._srcLenArm();
        if (name === '第5集国语') continue;   // _epMatchKey 对"国语"得到 N5|,靠撞键规则兜(见下)
        ok(!X.vm._srcLen, '集名 ' + JSON.stringify(name) + ':不比');
    }

    // 线路范围
    const scope = [
        Src('kz_x', 'kz', 300, 'ads', '1080p', { _isKz: true }),
        Src('mis', 'direct', 300, 'ads', '1080p', { _kzMismatch: true }),
        Src('prox', 'proxy', 300, 'ads', '1080p'),
        Src('srv', 'server', 300, 'ads', '1080p'),
        Src('dead', 'direct', 9999, 'ads', '1080p'),
        Src('pend', 'direct', '...', 'ads', '1080p'),
        Src('none', 'direct', 300, 'ads', '1080p', { vod_play_url: '' }),
        Src('mp4', 'direct', 300, 'ads', '1080p', { vod_play_url: '第5集$https://cdn.example/x/5.mp4' }),
        Src('mix', 'direct', 300, 'ads', '1080p', { vod_play_url: '第5集$http://cdn.example/x/5.m3u8' }),
        Src('dup', 'direct', 300, 'ads', '1080p', { vod_play_url: '第5集国语$https://cdn.example/x/a.m3u8#第5集粤语$https://cdn.example/x/b.m3u8' }),
        Src('clipS', 'direct', 300, 'noburn', '1080p'),
        Src('ok', 'direct', 300, 'ads', '1080p'),
        Src('cached', 'direct', 300, 'ads', '1080p', { vod_play_url: '第5集$https://cdn.example/stale/5.mp4', _cachedDetail: { vod_play_url: '第5集$https://cdn.example/share/x$$$第5集$https://cdn.example/cached/5.m3u8' } }),
    ];
    scope.find(s => s.site_key === 'clipS').site_profile.clip = 1;
    E = armed({ sources: scope, routes: {}, vm: { _isKzSource: s => s.site_key === 'kz_x' } });
    const plan = E.vm._srcLenPlan(E.vm._srcLen).map(x => x.ids.join('+'));
    eq(plan.join(), 'ok|7,cached|7', '只拉直连测通、有干净集名、非 clip、非 kz、非 MP4、非混合内容的线路', plan);

    const many = Array.from({ length: 30 }, (_, i) => Src('s' + i, 'direct', 100 + i, 'ads', '1080p'));
    E = armed({ sources: many });
    eq(E.vm._srcLenPlan(E.vm._srcLen).length, 20, '最多 20 个地址');
    // 别名线路(同地址)不占名额,结果写给每一条
    const shared = u => '第5集$https://cdn.example/' + u + '/5.m3u8';
    const alias = [Src('a', 'direct', 100, 'ads', '1080p', { vod_play_url: shared('x') }), Src('a2', 'direct', 110, 'ads', '1080p', { vod_play_url: shared('x') })].concat(Array.from({ length: 22 }, (_, i) => Src('s' + i, 'direct', 200 + i, 'ads', '1080p')));
    E = armed({ sources: alias });
    let pl = E.vm._srcLenPlan(E.vm._srcLen);
    eq(pl.length, 20, '别名去重后仍是最多 20 个地址');
    eq(pl[0].ids.join(), 'a|7,a2|7', '同地址的线路归到一行', pl[0]);
    ok(pl.some(r => r.ids[0] === 's18|7') && !pl.some(r => r.ids[0] === 's19|7'), '别名没有挤掉第 20 个地址', pl.map(r => r.ids[0]));
    E = armed({ sources: [Src('a', 'direct', 100, 'ads', '1080p', { vod_play_url: shared('x') }), Src('a2', 'direct', 110, 'ads', '1080p', { vod_play_url: shared('x') }), Src('b', 'direct', 120, 'ads', '1080p'), Src('c', 'direct', 130, 'ads', '1080p')], routes: Object.assign(routesFor({ x: 2923, b: 2795, c: 2796 })) });
    await drive(E, 27000);
    eq(E.env.reqs.length, 3, '同地址只拉一次');
    eq(E.vm._srcLen.rows.filter(r => r.id.startsWith('a')).length, 2, '…结果写给两条线路');

    // 票:真实清单。同一上游换 CDN / 改文件名 / 随机插广告都还是一票,独立的另一次切片是另一票
    const mainA = lenList(2800).map((d, i) => d - (i % 3) * 0.04), mainB = lenList(2800).map((d, i) => d - (i % 5) * 0.03);
    const seq = (segs, tag) => segs.map((d, i) => '#EXTINF:' + d.toFixed(3) + ',\n' + tag + i + '.ts\n').join('');
    const hdr = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n', end = '#EXT-X-ENDLIST\n', dc = '#EXT-X-DISCONTINUITY\n';
    const ad = seq([5, 5, 5, 2.567], 'adv');
    const withAd = (segs, at, tag) => hdr + seq(segs.slice(0, at), tag) + dc + ad + dc + seq(segs.slice(at), tag + 'x') + end;
    const V = { plain: hdr + seq(mainA, 's') + end, cdn2: hdr + seq(mainA, 's') + end, renamed: hdr + seq(mainA, 'hash_') + end, ad1: withAd(mainA, 100, 's'), ad2: withAd(mainA, 400, 'r'), other: hdr + seq(mainB, 's') + end };
    const vr = {}, vs = Object.keys(V).map((k, i) => { vr['https://cdn' + i + '.example/' + k + '/5.m3u8'] = V[k]; return Src(k, 'direct', 100 + i, 'ads', '1080p', { vod_play_url: '第5集$https://cdn' + i + '.example/' + k + '/5.m3u8' }); });
    E = armed({ sources: vs, routes: vr });
    await drive(E, 30000);
    const fps = Object.fromEntries(E.vm._srcLen.rows.map(r => [r.id, r.fp]));
    eq(Object.keys(fps).length, 6, '6 条都有票');
    ok(fps['plain|7'] === fps['cdn2|7'] && fps['plain|7'] === fps['renamed|7'], '换 CDN、改文件名:同一票', fps);
    ok(fps['plain|7'] === fps['ad1|7'] && fps['plain|7'] === fps['ad2|7'], '随机位置插广告:同一票', fps);
    ok(fps['plain|7'] !== fps['other|7'], '另一次切片:另一票', fps);
    eq(new Set(Object.values(fps)).size, 2, '6 条线路只有 2 票');
    { const parsed = C.parseMedia(V.ad1, 'https://x/a.m3u8'); const n = dgSrcLenNet(parsed.groups, parsed.frags.reduce((a, f) => a + f.duration, 0)); eq(dgSrcLenVote(parsed.frags, parsed.groups, n.skip), fps['plain|7'], 'dgSrcLenVote 直接算出同一票'); }

    // 集键匹配:第05集 / 05 算同一集;只有"第5集上"的线路不算有这一集
    E = armed({ sources: [] });
    eq(E.vm._srcLenEpUrl(Src('x', 'direct', 1, 'ads', '', { vod_play_url: '第05集$https://a/5.m3u8' }), 'N5|'), 'https://a/5.m3u8', '第05集 → N5|');
    eq(E.vm._srcLenEpUrl(Src('x', 'direct', 1, 'ads', '', { vod_play_url: '第5集上$https://a/5.m3u8' }), 'N5|'), '', '第5集上不算第 5 集');
    eq(E.vm._srcLenEpUrl(Src('x', 'direct', 1, 'ads', '', { vod_play_url: 'feifan$$$第5集$https://a/share$$$ffm3u8' }), 'N5|'), '', '$$$:只认含 m3u8 的那组,分享页那组不算');
}

// ============ 9) 清单解析路径 ============
console.log('[9] 拉取失败路径');
{
    const one = async (route, extra) => {
        const r = {}; r['https://cdn.example/a/5.m3u8'] = route; Object.assign(r, extra || {});
        const E = armed({ sources: [Src('a', 'direct', 100, 'ads')], routes: r });
        await E.vm._srcLenFetch(E.vm._srcLen, { ids: ['a|7'], url: 'https://cdn.example/a/5.m3u8' });
        E.vm._srcLen.signals = E.env.signals;
        return E.vm._srcLen;
    };
    let L = await one(M3U(lenList(2800), '#EXT-X-KEY:METHOD=AES-128,URI="k"\n'));
    ok(L.rows.length === 1 && Math.abs(L.rows[0].d - 2800) < 1, '加密清单照算时长', L.rows);
    L = await one(M3U(lenList(2800), '#EXT-X-MAP:URI="init.mp4"\n'));
    ok(L.rows.length === 1, 'fMP4 清单照算时长');
    L = await one(M3U(lenList(2800)).replace('#EXT-X-ENDLIST\n', ''));
    ok(L.rows.length === 0 && L.diag.nodata === 1, '没有 ENDLIST(直播/未完结):无数据', L.diag);
    L = await one('#EXTM3U\n#EXT-X-ENDLIST\n');
    ok(L.rows.length === 0 && L.diag.nodata === 1, '0 分片:无数据', L.diag);
    L = await one('<html>403</html>');
    ok(L.rows.length === 0 && L.diag.nodata === 1, 'HTML:无数据', L.diag);
    L = await one({ status: 404, body: M3U(lenList(2800)) });
    ok(L.rows.length === 0 && L.diag.nodata === 1, 'HTTP 404(错误页是合法清单):无数据', L.diag);
    L = await one({ body: M3U(lenList(2800)), len: 2000000 });
    ok(L.rows.length === 0 && L.diag.nodata === 1, 'content-length 超限:丢弃', L.diag);
    ok(L.signals.length === 1 && L.signals[0].aborted === true, '…并中止下载(否则连接占到 GC)');
    L = await one(M3U(lenList(2800), '#' + 'x'.repeat(1600000) + '\n'));
    ok(L.rows.length === 0 && L.diag.nodata === 1, '正文超限(合法清单):丢弃', L.diag);
    ok(L.signals[0].aborted === true, '…并中止');
    const masterTxt = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhls/index.m3u8\n';
    L = await one(masterTxt, { 'https://cdn.example/a/hls/index.m3u8': M3U(lenList(2800)) });
    ok(L.rows.length === 1, 'master 跟一层到子清单', L.rows);
    L = await one({ redirect: 'https://cdn2.example/z/master.m3u8' }, { 'https://cdn2.example/z/master.m3u8': masterTxt, 'https://cdn2.example/z/hls/index.m3u8': M3U(lenList(2800)) });
    ok(L.rows.length === 1, 'master 被重定向:子清单按最终地址解析', L);
    { // 超时:5s 中止,busy 归零,记失败
        const H = armed({ sources: [Src('a', 'direct', 100, 'ads')], routes: {}, hold: true, fakeTimers: true });
        const LL = H.vm._srcLen, pr = H.vm._srcLenFetch(LL, { ids: ['a|7'], url: 'https://cdn.example/a/5.m3u8' });
        await tick();
        eq(LL.busy, 1, '请求挂着:busy=1');
        const t5 = H.env.fake.find(t => t.ms === 5000);
        ok(t5 && t5.on, '有 5s 超时');
        t5.fn(); await pr;
        ok(LL.busy === 0 && LL.diag.fail === 1 && LL.ctrls.size === 0 && !t5.on === true, '超时:busy 归零、记失败、清理完', LL.diag);
    }
    L = await one(masterTxt, { 'https://cdn.example/a/hls/index.m3u8': masterTxt });
    ok(L.rows.length === 0 && L.diag.nodata === 1, '子清单还是 master:无数据', L.diag);
    L = await one(undefined);
    ok(L.rows.length === 0 && L.diag.fail === 1, '网络失败:记失败,不抛错', L.diag);

    // 全部失败:不判、srcRev 不动
    const E = armed({ sources: baseSrcs(), routes: {} });
    await drive(E, 27000);
    eq(E.vm.srcRev, 0, '全部失败:srcRev 不变');
    ok(E.vm._srcLen.done && E.vm._srcLen.diag.fail === 4, '…本集结束,diag 记 4 次失败', E.vm._srcLen.diag);
}

// ============ 10) 发布与失效 ============
console.log('[10] 发布与失效');
{
    // 指针在线路上不发布(它们会换位),离开后的 tick 再发
    let E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
    E.env.doc.hover = true;
    await drive(E, 27000);
    eq(E.vm.srcRev, 0, '指针在线路上:先不发布');
    ok(E.vm._srcLen.res && !E.vm._srcLen.pub, '…结果等着');
    E.env.doc.hover = false;
    await drive(E, 500);
    eq(E.vm.srcRev, 1, '离开后下一拍发布');

    // 没有 hover 的设备:粘住的 :hover 不算,看最近有没有碰过页面
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL), noHover: true });
    E.env.doc.hover = true;
    await drive(E, 27000);
    eq(E.vm.srcRev, 1, '手机点过一次留下的粘滞 :hover 不挡发布');
    ok(E.env.doc.listeners.touchstart && E.env.doc.listeners.scroll && E.env.doc.listeners.touchstart[0].op.passive && E.env.doc.listeners.scroll[0].op.capture, '触屏 / 滚动监听是 passive,滚动走捕获(scroll 不冒泡)');
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL), noHover: true });
    await drive(E, 19500);
    const touch = E.env.doc.listeners.touchstart[0].f, scroll = E.env.doc.listeners.scroll[0].f;
    touch();
    await drive(E, 2500);
    eq(E.vm.srcRev, 0, '3 秒内碰过页面:先不发布');
    scroll();
    await drive(E, 2500);
    eq(E.vm.srcRev, 0, '滚动也算');
    await drive(E, 1000);
    eq(E.vm.srcRev, 1, '停手 3 秒后发布');
    E.vm.currentUrl = 'u6'; E.vm._srcLenArm();
    eq(E.env.doc.listeners.touchstart.length, 1, '监听只装一次');

    // 指针在选集这一块:网格留得住才发布,留不住先等(简介在列表上方,不拦)
    const rect = (top, h = 100) => ({ top, bottom: top + h, height: h });
    const layoutOf = (gridTop, ovTop, playerTop, opt = {}) => {
        const hoverBlock = { v: !!opt.hoverBlock };
        const ov = { scrollTop: ovTop, scrollHeight: opt.noScroll ? 800 : 3000, clientHeight: 800 };
        const grid = { top: gridTop, getBoundingClientRect() { return rect(this.top); }, parentElement: { matches: q => q === ':hover' && hoverBlock.v } };
        const player = playerTop == null ? null : { getBoundingClientRect: () => rect(playerTop, 400) };
        return { ov, grid, player, hoverBlock };
    };
    {
        const E2 = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
        E2.env.layout = layoutOf(500, 700, -700, { hoverBlock: true });
        await drive(E2, 27000);
        eq(E2.vm.srcRev, 1, '指针停在选集、视频已滚走(网格能留住):照常发布');
        E2.env.layout.grid.top = 581; E2.env.afterTick();
        eq(E2.env.layout.ov.scrollTop, 781, '…网格没动');
        const E3 = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
        E3.env.layout = layoutOf(500, 0, 0, { hoverBlock: true });
        await drive(E3, 27000);
        eq(E3.vm.srcRev, 0, '指针停在选集、观众看着视频(网格留不住):先不发布');
        E3.env.layout.hoverBlock.v = false;
        await drive(E3, 500);
        eq(E3.vm.srcRev, 1, '…指针离开后发布');
        const E4 = armed({ sources: baseSrcs(), routes: routesFor(TOTAL), noHover: true });
        E4.env.layout = layoutOf(500, 0, 0, { hoverBlock: true });
        await drive(E4, 27000);
        eq(E4.vm.srcRev, 1, '没有 hover 的设备:粘住的选集 :hover 不拦');
    }

    // 焦点:鼠标点过的线路(focus 但不 focus-visible)不挡,遥控器 / 键盘挡;不支持 :focus-visible 的浏览器当作有焦点
    const focusEl = (inList, vis) => ({ closest: s => (inList && (s === '.source-list' || s === '.source-pill') ? {} : null), matches: q => { if (vis === 'throw') throw new SyntaxError('bad'); return q === ':focus-visible' ? vis : !vis; } });
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
    E.env.doc.activeElement = focusEl(true, false);
    await drive(E, 27000);
    eq(E.vm.srcRev, 1, '鼠标点过线路:焦点留着也发布(否则这一集和连播都拿不到结果)');
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
    E.env.doc.activeElement = focusEl(true, true);
    await drive(E, 27000);
    eq(E.vm.srcRev, 0, '遥控器 / 键盘焦点在线路上:不发布');
    E.env.doc.activeElement = focusEl(true, 'throw');
    await drive(E, 500);
    ok(E.vm.srcRev === 0 && !E.vm._srcLenOff, '老浏览器 matches 抛错:当作有焦点,不关功能');
    E.env.doc.activeElement = focusEl(false, true);
    await drive(E, 500);
    eq(E.vm.srcRev, 1, '焦点在线路列表外(如选集):不挡');
    // 鼠标点中线路后按了空格:Chrome 把它算成 :focus-visible,但这不是遥控器在选线
    {
        const E2 = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
        const pill = focusEl(true, true), other = focusEl(true, true);
        pill.isPill = true;
        const down = E2.env.doc.listeners.pointerdown[0].f, fin = E2.env.doc.listeners.focusin[0].f;
        down({ target: { closest: q => (q === '.source-pill' ? pill : null) } }); fin({ target: pill });
        E2.env.doc.activeElement = pill;
        ok(!E2.vm._srcLenUiBusy(), '鼠标点中的线路按过键:不算在操作');
        fin({ target: other }); E2.env.doc.activeElement = other;
        ok(E2.vm._srcLenUiBusy(), 'Tab 到别的线路:算在操作');
        fin({ target: pill }); E2.env.doc.activeElement = pill;
        ok(E2.vm._srcLenUiBusy(), 'Tab 走又 Tab 回来:算在操作');
        down({ target: { closest: () => null } });
        ok(E2.env.doc.listeners.pointerdown[0].op.passive && E2.env.doc.listeners.focusin[0].op.capture, 'pointerdown / focusin 监听 passive + 捕获');
        ok(E2.vm._srcLenUiBusy(), '点到页面别处但焦点还在线路上(如脚本 focus):算在操作');
        down({ target: null });
        ok(E2.vm._srcLenUi.ptr === null, 'target 为空不抛错');
        // 按页面滚动条:pointerdown 落在页面上,焦点没动,还算鼠标点中的;之后按键不挡发布
        const wait = () => new Promise(r => setTimeout(r, 5));
        const pill2 = focusEl(true, true), hit = { target: { closest: q => (q === '.source-pill' ? pill2 : null) } }, page = { target: { closest: () => null } };
        down(hit); fin({ target: pill2 }); E2.env.doc.activeElement = pill2;
        down(page); await wait();
        ok(E2.vm._srcLenUi.ptr === pill2 && !E2.vm._srcLenUiBusy(), '按滚动条(焦点没动):还算鼠标点中的');
        E2.env.doc.activeElement = null; down(page); await wait();
        ok(E2.vm._srcLenUi.ptr === null, '点到别处、焦点真的离开:清掉');
        // 第一次起播前就手点了线路
        const seed = el => { const X = mkVm({ sources: baseSrcs(), routes: routesFor(TOTAL) }); X.env.doc.activeElement = el; X.vm._srcLenArm(); return X; };
        const mouseFocused = focusEl(true, false);
        eq(seed(mouseFocused).vm._srcLenUi.ptr, mouseFocused, '起播前鼠标点过的线路:接上');
        eq(seed(focusEl(true, true)).vm._srcLenUi.ptr, null, '键盘选的线路:不接(遥控器要继续挡发布)');
        const Xt = seed(focusEl(true, 'throw'));
        ok(Xt.vm._srcLenUi.ptr === null && Xt.vm._srcLen, '老浏览器不认 :focus-visible:不接、不影响武装');
        eq(seed(focusEl(false, false)).vm._srcLenUi.ptr, null, '焦点不在线路上:不接');
    }

    // 发布后选集网格留在原位(视频已滚走时),观众看着视频时不补偿
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
    E.env.layout = layoutOf(500, 700, -700);
    await drive(E, 27000);
    eq(E.vm.srcRev, 1, '发布了');
    E.env.layout.grid.top = 580;   // 列表变高,网格下移 80
    ok(typeof E.env.afterTick === 'function', '视频已滚走:发布后约好 nextTick 补偿');
    eq(E.env.tickAtRev, 1, '…是在 srcRev++ 之后约的(否则量到的是变高之前)');
    E.env.afterTick();
    eq(E.env.layout.ov.scrollTop, 780, '…网格在视口内:滚动补偿 80px');
    const noPin = async (name, lay) => { const E2 = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) }); E2.env.layout = lay; await drive(E2, 27000); eq(E2.vm.srcRev, 1, name + ':照常发布'); eq(E2.env.afterTick, undefined, name + ':不动滚动'); };
    await noPin('网格在视口下方', layoutOf(1200, 100, -500));
    await noPin('视频在顶部完整露出', layoutOf(500, 0, 0));
    await noPin('视频被遮掉不到一半', layoutOf(500, 100, -100));
    await noPin('视频下半截在视口外但过半露出', layoutOf(500, 0, 500));
    await noPin('页面不能滚', layoutOf(500, 0, -700, { noScroll: true }));
    {
        // 视频刚好只露一半以内:补偿
        const E2 = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
        E2.env.layout = layoutOf(500, 300, -250);
        await drive(E2, 27000);
        ok(typeof E2.env.afterTick === 'function', '视频只露 150/400:补偿');
        const E5 = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
        E5.env.layout = layoutOf(500, 300, 600);
        await drive(E5, 27000);
        ok(typeof E5.env.afterTick === 'function', '视频下半截在视口外、只露 200/400:补偿(可见量要算视口下沿)');
    }
    {
        // 换集 → 发布 → 换集 → 发布:观众看着视频时滚动位置不累积
        const both = routesFor(TOTAL); Object.keys(both).forEach(k => { both[k.replace('/5.m3u8', '/6.m3u8')] = both[k]; });
        const E2 = armed({ sources: baseSrcs(), routes: both });
        E2.env.layout = layoutOf(500, 100, 83);
        await drive(E2, 27000);
        for (let k = 0; k < 3; k++) { E2.vm.currentUrl = k % 2 ? 'u5' : 'u6'; E2.vm._srcLenArm(); await drive(E2, 27000); }
        eq(E2.env.layout.ov.scrollTop, 100, '连着换 3 集:视频位置一点没动');
        eq(E2.vm.srcRev, 7, '…每集都发布、清除了(1 + 3×2)');
    }

    // 同集换线路:不重跑、结果和 keep 都保留
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL), current: { site_key: 'c', vod_id: 7 } });
    await drive(E, 27000);
    const n = E.env.reqs.length, rev = E.vm.srcRev, keep = E.vm._srcLen.pub.keep;
    E.vm.episodeList = [{ name: '第05集', url: 'b5' }]; E.vm.currentUrl = 'b5'; E.vm._srcLenArm();
    await drive(E, 1000);
    eq(E.env.reqs.length, n, '同集换线路:不重拉');
    eq(E.vm.srcRev, rev, '…srcRev 不变');
    ok(E.vm._srcLen.pub && E.vm._srcLen.pub.keep === keep, '…结果和不挪位的线路都保留');
    eq(keep, 'c|7', '发布时记下在播线路');

    // 换集:清除、srcRev+1、重新武装;晚到结果丢弃
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
    await drive(E, 27000);
    const old = E.vm._srcLen, r0 = E.vm.srcRev;
    E.vm.currentUrl = 'u6'; E.vm._srcLenArm();
    ok(E.vm._srcLen !== old && !E.vm._srcLen.pub, '换集:换新状态');
    eq(E.vm.srcRev, r0 + 1, '旧结果非空:srcRev+1');
    eq(E.vm.srcLongSec(E.vm.currentGroup.sources[2]), 0, '角标立刻没了');
    // 旧结果为空时换集不动 srcRev
    E = armed({ sources: baseSrcs(), routes: routesFor({ a: 2795, b: 2796, c: 2797, d: 2798 }) });
    await drive(E, 27000);
    const r1 = E.vm.srcRev;
    E.vm.currentUrl = 'u6'; E.vm._srcLenArm();
    eq(E.vm.srcRev, r1, '旧结果为空:换集 srcRev 不变');

    // 请求在途时换集:abort,晚到结果不写进新状态
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
    const L0 = E.vm._srcLen;
    const p = E.vm._srcLenFetch(L0, { ids: ['a|7'], url: 'https://cdn.example/a/5.m3u8' });
    E.vm.currentUrl = 'u6'; E.vm._srcLenArm();
    await p; await tick();
    eq(E.vm._srcLen.rows.length, 0, '在途结果不写进新状态(落在没人读的旧状态里)');
    eq(L0.ctrls.size, 0, '在途请求收尾清理');

    // 换剧
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL) });
    await drive(E, 27000);
    E.setNav(2);
    eq(E.vm.srcLongSec(E.vm.currentGroup.sources[2]), 0, '_navSeq 变了:srcLongSec 返回 0');
    const n0 = E.env.reqs.length, old2 = E.vm._srcLen;
    E.vm._srcLenTick();
    ok(E.vm._srcLen !== old2 && E.vm._srcLen.nav === 2 && E.vm._srcLen.done === false, '已完成的旧状态:导航变了下一拍重新武装(关掉后从"继续观看"回到同一集,currentUrl 没变,watch 不触发)', E.vm._srcLen && E.vm._srcLen.nav);
    await drive(E, 30000);
    ok(E.env.reqs.length > n0, '…满 20s 稳定后重新比一次', E.env.reqs.length - n0);
    ok(Math.round(E.vm.srcLongSec(E.vm.currentGroup.sources[2])) === 128, '…角标回来了');
    // 关掉留在首页:不再有请求
    E.setNav(3); E.env.video.paused = true;
    const n1 = E.env.reqs.length; await drive(E, 30000);
    eq(E.env.reqs.length, n1, '关掉详情(视频暂停):不再拉');

    // tick 抛错:本会话关闭,不影响播放
    E = armed({ sources: baseSrcs(), routes: routesFor(TOTAL), selectorThrows: true });
    let threw = false;
    try { await drive(E, 27000); } catch (e) { threw = true; }
    ok(!threw, 'querySelector 抛错(老 WebView 不认 :focus-within):tick 不向外抛');
    eq(E.vm.srcRev, 0, '…srcRev 不变');
    ok(E.vm._srcLenOff === true, '…本会话关闭');
    E.vm.currentUrl = 'u6'; E.vm._srcLenArm();
    ok(!E.vm._srcLen, '…之后不再武装');
}

// ============ 11) 静态守卫 ============
console.log('[11] 静态守卫');
{
    // 大方法里有带引号的正则,matchBrace 走不通:按缩进切(methods 统一 16 格缩进)
    const memberText = n => {
        const m = new RegExp('\\n {16}(?:async )?' + n.replace(/\$/g, '\\$') + '\\(').exec(html);
        if (!m) throw new Error('member not found: ' + n);
        const end = html.indexOf('\n                },', m.index);
        return html.slice(m.index, end);
    };
    for (const n of ['_earlyPick', '_autoPick', '_pickPreferred', 'srcProfile', '_srcReachClass', 'pickSourceManual', 'switchSource', 'play', '_failoverNext', '_srcTestOrder', '_srcUnreach']) {
        ok(!/_srcLen|srcLong/.test(memberText(n).replace('this._srcLenTick();', '')), n + ' 不读线路时长结果(play 里只有 timeupdate 的 tick 入口)');
    }
    const lenSrc = ['_srcLenArm', '_srcLenTick', '_srcLenStable', '_srcLenEpUrl', '_srcLenPlan', '_srcLenFetch', '_srcLenFinish', '_srcLenUiBusy', '_srcLenPin', '_srcLenPublish', '_srcLenDem', '_srcLenKeep'].map(n => extractMember(n).body).join('\n');
    ok(!/switchSource\(|\.play\(|localStorage\.setItem|\/api\/|corsProxyUrl|_proxyUrl|_srcNoteRes|_srcSetRes|hasAutoSelected/.test(lenSrc), '_srcLen* 不换线、不起播、不写存储、不走 /api 和 worker、不碰分辨率记账');
    ok((lenSrc.match(/srcRev\+\+/g) || []).length === 3, 'srcRev++ 只有发布、清除、失败换源接替三处');
    ok(/this\._srcLenKeep\(nextSource\);\s*this\.switchSource\(nextSource\);/.test(html), '失败换源:切线前让下一条接替在播线路');
    ok(!/<div v-if="srcLenNote\(\)"[^>]*>[^<]*含广告/.test(html), '说明行不写死"含广告"');
    // 选择器在模板里真的存在(类名改了,挡不住也没有报错);隔离:三个选源函数不读显示顺序
    ok(/<div class="controls-area" v-if="!\(currentGroup && currentGroup\._isLive\)">/.test(html), '模板:点播控制区');
    ok(/<div class="source-list" v-if="fastSources\.length > 0/.test(html), '模板:点播线路列表 .source-list(直播另有一个,不算)');
    ok(/<div v-for="\(source, i\) in g\.items" class="source-pill"/.test(html), '模板:线路 .source-pill');
    ok(/<div v-else class="ep-grid"/.test(html), '模板:选集 .ep-grid');
    ok(/<div class="detail-overlay"/.test(html) && /\.detail-overlay \{[^}]*overflow-y: auto/.test(html.replace(/\r/g, '')), '模板:滚动容器 .detail-overlay');
    ok(/<div class="player-box"/.test(html), '模板:播放器 .player-box');
    for (const n of ['_pickPreferred', '_autoPick', '_earlyPick']) ok(!/availableSources|sourceGroups|fastSources|slowSources/.test(memberText(n)), n + ' 不读显示顺序');
    const pillTpl = html.slice(html.indexOf('<div v-for="(source, i) in g.items" class="source-pill"'), html.indexOf('<div v-if="srcLenNote()"'));
    ok(/<span v-if="srcLongSec\(source\)" class="src-geo">可能有广告<\/span>/.test(pillTpl), '标签:每组都显示,只看 srcLongSec');
    const note = /<div v-if="srcLenNote\(\)"[^>]*>([^<]*)</.exec(html);
    ok(note && !/选没标|避开/.test(note[1]) && /没标不代表没有/.test(note[1]), '说明行不建议"选没标的"(没标的线路很多根本没比过),并写明这一点', note && note[1]);
    ok(/this\._srcResSniffPlay\(\);[^\n]*\n\s*this\._srcLenTick\(\);/.test(html), 'timeupdate 里挂 tick');
    ok(/currentUrl\(v\) \{ if \(v\) this\._favOnPlay\(\); this\._srcLenArm\(\); \}/.test(html), 'watch.currentUrl 里武装 / 失效');
    const tpl = html.slice(html.indexOf('class="source-pill"'), html.indexOf('<!-- 全部不可用提示 -->'));
    ok(/srcLongSec\(source\)/.test(tpl) && /srcLenNote\(\)/.test(tpl), '模板挂了角标和说明行');
    ok(!/_srcLen/.test(tpl), '模板不用下划线方法(Vue3 模板读不到)');
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'}: ${pass} passed, ${fail} failed`);
if (fail) { console.log(fails.slice(0, 40).join('\n')); process.exitCode = 1; }
