#!/usr/bin/env node
// 电视版数据层 public/tv/api.js 回归(离线、零网络):
//   node scripts/tv-api-test.mjs
//  ① 移植的纯函数和网页版原文逐条对比(从 public/index.html 原样抽出来跑,两边对不上就是漂移了):
//     splitSameNameWorks / groupedList / parseEpisodes / _epMatchKey / _sourceHasEpisode / getProgressKey(两处 + 拉取合并时的改写)/
//     _slimHistoryItem(+ lib/history-slim)/ DgCatalog.buildQuery + visible / _pickPreferred + _autoPick + availableSources(选线 / 线路顺序)
//  ② 在 vm 里装上真的 core.js + api.js(假 XHR / EventSource / localStorage):配置兜底、登录、扫码、退出、进度 / 历史 / 增量推送 / 拉取合并、
//     收藏、分类浏览、首页排序、流式搜索、测速、直播
//  ③ server.js 的 /api/tv/suggest:<tv-suggest-core> 那段解析 / 清洗函数(用录下来的接口回包),路由位置与 CRLF
// 改 api.js,或改 index.html 里上面那几个函数后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const CORE_JS = fs.readFileSync(path.join(ROOT, 'public/tv/core.js'), 'utf8');
const API_JS = fs.readFileSync(path.join(ROOT, 'public/tv/api.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra).slice(0, 600))); } };
const J = (x) => JSON.stringify(x);
const same = (a, b, msg) => ok(J(a) === J(b), msg, J(a) === J(b) ? undefined : { tv: a, web: b });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 从 index.html 抽原文 ----------
function matchBrace(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i], n = src[i + 1];
        if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
        if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
        if (c === '"' || c === "'" || c === '`') { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    throw new Error('unbalanced');
}
function extractMember(name) {
    const re = new RegExp('\\n\\s+(?:async\\s+)?' + name.replace(/\$/g, '\\$') + '\\(([^)]*)\\)\\s*\\{');
    const m = re.exec(HTML);
    if (!m) throw new Error('member not found: ' + name);
    const open = m.index + m[0].length - 1;
    return { params: m[1], body: HTML.slice(open, matchBrace(HTML, open) + 1) };
}
function sliceFrom(marker, from) {
    const a = HTML.indexOf(marker, from || 0);
    if (a < 0) throw new Error('marker not found: ' + marker);
    const open = HTML.indexOf('{', a);
    return { src: HTML.slice(a, matchBrace(HTML, open) + 1), at: a };
}
const cStart = HTML.indexOf('const SRC_TIER_RANK = {'), cEnd = HTML.indexOf('const EARLY_SETTLE_MS = 1200;');
const CONSTS = HTML.slice(cStart, cEnd + 'const EARLY_SETTLE_MS = 1200;'.length);
const WEB_RANK = new Function(CONSTS + '\nreturn SRC_TIER_RANK;')();
const webSplit = new Function('SRC_TIER_RANK', sliceFrom('function splitSameNameWorks(').src + '\nreturn splitSameNameWorks;')(WEB_RANK);
const mk = (n) => { const m = extractMember(n); return n + '(' + m.params + ') ' + m.body; };
const webEp = new Function('return {' + ['_epMatchKey', '_sourceHasEpisode', 'parseEpisodes', '_slimHistoryItem'].map(mk).join(',\n') + '};')();
const gl = extractMember('groupedList');
const webGrouped = (raw) => new Function('splitSameNameWorks', 'SRC_TIER_RANK', 'rawList', 'return ({ rawList, _kzSnapGroups(x) { return x; }, get groupedList() ' + gl.body + ' }).groupedList;')(webSplit, WEB_RANK, raw);
// getProgressKey:播放器初始化处(this.currentUrl)和换集处(闭包 url)各一份
const n1 = sliceFrom('const normalizeEpisodeName = (name) => {'), g1 = sliceFrom('const getProgressKey = () => {', n1.at);
const n2 = sliceFrom('const normalizeEpisodeName = (name) => {', g1.at), g2 = sliceFrom('const getProgressKey = () => {', n2.at);
const webGPK1 = (ctx) => new Function('ctx', 'return (function () { ' + n1.src + ';\n' + g1.src + ';\nreturn getProgressKey(); }).call(ctx);')(ctx);
const webGPK2 = (ctx, url) => new Function('ctx', 'url', 'return (function () { ' + n2.src + ';\n' + g2.src + ';\nreturn getProgressKey(); }).call(ctx);')(ctx, url);
// 拉取合并时按历史条目改写进度键的那段
const pm = extractMember('pullAndMergeHistory').body;
const pkA = pm.indexOf('let key;'), pkB = pm.indexOf('// 服务器优先：直接用服务器数据覆盖本地进度');
const webPullKey = new Function('item', 'name', pm.slice(pkA, pkB) + '\nreturn key;');
const catM = /\/\/ <dg-catalog-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-catalog-core>/.exec(HTML);
const WebCat = vm.runInNewContext(catM[1] + '\n;DgCatalog;', { Math, String, Array, Object, Number, Date, RegExp, JSON, parseInt });

// ---------- vm 里的电视页 ----------
function makeEnv(opt) {
    opt = opt || {};
    const store = Object.assign({}, opt.ls || {});
    const localStorage = {
        getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
        key: i => Object.keys(store)[i] == null ? null : Object.keys(store)[i], get length() { return Object.keys(store).length; }, clear() { for (const k of Object.keys(store)) delete store[k]; }
    };
    const env = { store, requests: [], routes: [], events: [], es: [], beacons: [] };
    env.route = (method, re, fn) => env.routes.unshift({ method, re, fn });
    const listeners = {};
    const target = (o) => Object.assign(o, {
        addEventListener(n, f) { (listeners[n] = listeners[n] || []).push(f); }, removeEventListener() { },
        dispatchEvent(ev) { env.events.push({ type: ev.type, detail: ev.detail }); (listeners[ev.type] || []).forEach(f => f(ev)); return true; }
    });
    class FakeXHR {
        open(m, u) { this.method = m; this.url = u; this.headers = {}; this.readyState = 1; }
        setRequestHeader(k, v) { this.headers[k] = v; }
        send(body) {
            let b = body; try { b = body ? JSON.parse(body) : null; } catch (e) { }
            const req = { method: this.method, url: this.url, body: b, headers: this.headers };
            env.requests.push(req);
            const r = env.routes.find(x => (!x.method || x.method === req.method) && (typeof x.re === 'string' ? req.url.indexOf(x.re) === 0 : x.re.test(req.url)));
            Promise.resolve(r ? r.fn(req) : { status: 404, body: { error: 'no route' } }).then(res => {
                res = res || { status: 0 };
                if (res.hang) return;
                setTimeout(() => {
                    if (this.aborted) return;
                    this.readyState = 4; this.status = res.status == null ? 200 : res.status;
                    this.responseText = typeof res.body === 'string' ? res.body : JSON.stringify(res.body == null ? null : res.body);
                    if (this.onreadystatechange) this.onreadystatechange();
                }, res.delay || 0);
            });
        }
        abort() { this.aborted = true; }
    }
    class FakeES {
        constructor(url) { this.url = url; this.ls = {}; this.closed = false; env.es.push(this); }
        addEventListener(n, f) { (this.ls[n] = this.ls[n] || []).push(f); }
        close() { this.closed = true; }
        msg(arr) { if (this.onmessage) this.onmessage({ data: JSON.stringify(arr) }); }
        done() { (this.ls.done || []).forEach(f => f({ data: '{}' })); }
        err() { if (this.onerror) this.onerror({}); }
    }
    const document = target({ hidden: false, documentElement: { style: {} }, body: { contains: () => true }, getElementById: () => null });
    const sb = target({
        innerWidth: opt.width || 1280, innerHeight: 720, devicePixelRatio: 1,
        location: Object.assign({ origin: 'https://tv.example.com', protocol: 'https:', host: 'tv.example.com', hostname: 'tv.example.com', search: '' }, opt.location || {}),
        navigator: { sendBeacon: (u, blob) => { env.beacons.push({ u, data: blob && blob.text }); return true; } },
        document, localStorage, sessionStorage: { getItem: () => null, setItem() { }, removeItem() { } },
        history: { pushState() { }, replaceState() { }, back() { } },
        XMLHttpRequest: FakeXHR, EventSource: opt.noES ? undefined : FakeES,
        CustomEvent: class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } },
        Blob: class { constructor(parts) { this.text = parts.join(''); } },
        getComputedStyle: () => ({ position: 'static' }), console: { log() { }, warn() { }, error() { } },
        setTimeout, clearTimeout, setInterval: (f, ms) => { const t = setInterval(f, ms); if (t.unref) t.unref(); return t; }, clearInterval
    });
    sb.window = sb; sb.self = sb;
    vm.createContext(sb);
    vm.runInContext(CORE_JS, sb, { filename: 'core.js' });
    vm.runInContext(API_JS, sb, { filename: 'api.js' });
    env.sb = sb; env.TV = sb.TV; env.api = sb.TV.api; env.P = sb.TV.api._pure;
    env.ev = (type) => env.events.filter(e => e.type === type);
    env.reqs = (re) => env.requests.filter(r => re.test(r.url));
    return env;
}
const base = makeEnv();
const P = base.P;

// ---------- 随机数(可复现) ----------
let seed = 20261127;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

console.log('① 移植的纯函数 ↔ index.html 原文');
{
    // splitSameNameWorks:真实搜索结果(遮天)+ 合成 + 随机
    const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/sources/zhetian-search.json'), 'utf8')).items;
    const SEP = '$' + '$' + '$';
    const rebuild = x => ({
        site_key: x.site_key, site_name: x.site_name, vod_id: x.vod_id, vod_name: x.vod_name, vod_year: x.vod_year, vod_remarks: x.vod_remarks,
        site_profile: x.tier ? { tier: x.tier } : null, vod_pic: 'https://img.example/' + x.site_key + '.jpg',
        vod_play_url: x.roads.map(r => [r.first].concat(Array.from({ length: Math.max(0, r.n - 1) }, (_, i) => '第' + (i + 2) + '集$https://e.example/' + x.site_key + '/' + i + '.m3u8')).join('#')).join(SEP)
    });
    const view = ws => ws.map(w => ({ work: w.work, sig: w.sig, label: w.label, items: w.items.map(i => i.site_key + '#' + i.vod_id), all: w.all.map(i => i.site_key + '#' + i.vod_id) }));
    const real = fx.map(rebuild);
    const names = [...new Set(real.map(x => x.vod_name))];
    let diff = 0;
    for (const n of names) {
        const items = real.filter(x => x.vod_name === n);
        for (const order of [items, items.slice().reverse()]) if (J(view(P.splitSameNameWorks(order))) !== J(view(webSplit(order)))) diff++;
    }
    ok(diff === 0, 'splitSameNameWorks:遮天等真实搜索结果(正反两种到达顺序)与网页版一致', diff);
    const mk1 = (k, eps, y, tag, extra) => Object.assign({
        site_key: k, site_name: k, vod_id: k + eps + (tag || ''), vod_year: y || '', vod_name: 'X',
        vod_play_url: Array.from({ length: eps }, (_, i) => '第' + (i + 1) + '集$https://' + (tag ? 'cdn' + (i % 2) : k) + '.example/' + (tag || eps) + '/' + i + '.m3u8').join('#')
    }, extra || {});
    let fz = 0, total = 0, splitCases = 0, dedupCases = 0;
    for (let t = 0; t < 400; t++) {
        const n = 1 + Math.floor(rnd() * 14), arr = [];
        for (let i = 0; i < n; i++) {
            const eps = pick([0, 1, 1, 2, 12, 24, 30, 40, 40, 46, 80, 100, 183]);
            const it = mk1(pick(['a', 'b', 'c', 'd', 'e', 'f', 'kz_x']), eps, pick(['', '2019', '2023', '2024', '2024', '2025']), pick(['', '', 'p', 'q']),
                { site_profile: pick([null, { tier: 'clean' }, { tier: 'ads' }, { tier: 'noburn' }, { t: 'insert' }]), vod_remarks: eps ? '' : pick(['', 'HD', '更新至12集', '全40集']) });
            arr.push(it);
        }
        total++;
        const wv = webSplit(arr);
        if (wv.length > 1) splitCases++;
        if (wv.reduce((n, w) => n + w.items.length, 0) < arr.length) dedupCases++;
        if (J(view(P.splitSameNameWorks(arr))) !== J(view(wv))) fz++;
    }
    ok(fz === 0, 'splitSameNameWorks:' + total + ' 组随机同名结果与网页版一致', fz);
    ok(splitCases > 40 && dedupCases > 100, '随机用例里确实有拆成多部 / 去重的情况(不是空跑)', { splitCases, dedupCases });

    // groupedList:按片名分组 + 拆作品 + 海报回退 + 线路多的在前
    const raw = real.concat([mk1('a', 40, '2024', '', { vod_name: '1917', vod_pic: '' }), mk1('b', 1, '2019', '', { vod_name: '1917', vod_pic: 'https://p/x.jpg' }), mk1('c', 30, '2024', '', { vod_name: '庆余年', vod_pic: 'mac_default.png' })]);
    const gv = gs => gs.map(g => [g.name, g.pic, g._work, g._workSig, g._workLabel, g.sources.map(s => s.site_key + '#' + s.vod_id + '#' + s.latency)]);
    same(gv(P.groupList(raw)), gv(webGrouped(raw)), 'groupedList:分组 / 海报 / 签名 / 线路顺序与网页版一致');

    // 选集解析 / 集名匹配
    const EPN = ['第1集', '第01集', '第001集', '01', '1', '第10集', 'EP05', 'ep.5', 'Ep 05', '第5话', '第05話', '第20260809期', '20260809加更', '20260809下', '2026-08-09', '2026.08.09上',
        '第5集(上)', '第5集下', '正片', 'HD中字', 'HD', '预告', '花絮', '第12期纯享', 'Plus版', '先导片', '', '  第3集  ', '第三集', '大结局', '第99集', '13', '2024', '19991231', '第0集'];
    let mkd = 0;
    EPN.forEach(n => { if (P.epMatchKey(n) !== webEp._epMatchKey(n)) mkd++; });
    ok(mkd === 0, '_epMatchKey:' + EPN.length + ' 种集名写法与网页版一致', mkd);
    const PU = [
        '第1集$https://a/1.m3u8#第2集$https://a/2.m3u8#第3集$https://a/3.m3u8',
        'HD$https://a/x.mp4$$$第01集$https://b/1.m3u8#第02集$https://b/2.m3u8',
        'https://a/only.m3u8', '正片$https://a/z.m3u8#', '20260809$u1#20260809加更$u2#20260810$u3', '第5集上$u1#第5集下$u2#第6集$u3',
        'EP01$u1#EP02$u2', 'a$b$c#d', ''
    ];
    let pd = 0, hd = 0;
    const realLog = console.log;
    console.log = () => { };   // 网页版 parseEpisodes 每次都打日志
    PU.forEach(pu => {
        EPN.concat([undefined]).forEach(t => {
            const ctx = { _epMatchKey: webEp._epMatchKey, play(u) { this.played = u; } };
            if (pu) webEp.parseEpisodes.call(ctx, pu, t);
            const eps = pu ? P.parseEps(pu) : [];
            if (pu && (J(eps) !== J(ctx.episodeList) || (eps[P.matchEpIn(eps, t, 0)] || {}).url !== ctx.played)) pd++;
            const src = { vod_play_url: pu };
            if (P.hasEpIn(pu, t) !== webEp._sourceHasEpisode.call({ _epMatchKey: webEp._epMatchKey }, src, t)) hd++;
        });
    });
    console.log = realLog;
    ok(pd === 0, 'parseEpisodes:选集解析 + 换线后选中的那一集与网页版一致', pd);
    ok(hd === 0, '_sourceHasEpisode:线路有没有这一集与网页版一致', hd);
    ok(P.matchEpIn([{ name: '第1集' }, { name: '第2集' }], '第9集', -1) === -1 && P.matchEpIn([{ name: '第1集' }, { name: '第2集' }], '第9集', 1) === 1 &&
        P.matchEpIn([{ name: '第1集' }], '第9集', 5) === 0 && P.matchEpIn([], '第1集', 0) === -1, 'matchEp:找不到时按 fallbackIdx(负数 = -1,超出 = 第一集)');

    // 进度键:播放器两处 + 拉取合并改写的那段,全都对得上
    let kd = 0;
    const NAMES = ['庆余年', '庆余年 第二季', 'Friends', '名侦探柯南(TV版)', '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', 'a/b?c'];
    NAMES.forEach(name => EPN.forEach(ep => [true, false].forEach(single => {
        const list = single ? [{ name: ep, url: 'u0' }] : [{ name: ep, url: 'u0' }, { name: 'x', url: 'u1' }];
        const ctx = { currentGroup: { name }, episodeList: list, currentUrl: 'u0', _offlineEpisodic: () => false };
        const tv = P.progressKey(name, ep, single);
        if (tv !== webGPK1(ctx) || tv !== webGPK2(ctx, 'u0')) kd++;
        if (!single && ep && P.progressKey(name, ep, false) !== webPullKey({ episode: ep }, name)) kd++;
        if (single && P.progressKey(name, null, true) !== webPullKey({ episode: null }, name)) kd++;
    })));
    ok(kd === 0, 'getProgressKey:电影 / 剧集 × 各种集名,与播放器两处 + 拉取合并改写的键完全一致', kd);

    // 同步瘦身
    const { slimHistoryItem } = require(path.join(ROOT, 'lib/history-slim'));
    const fat = {
        name: '剧', poster: '/p.jpg', episode: '第05集', progress: 40, progressTime: 1200, progressDuration: 2700, watchedAt: '2026-11-01T00:00:00.000Z', lastSourceKey: 's3',
        groupData: {
            name: '剧', pic: '/pic.jpg', _work: '', _workSig: 'y2025s', _workLabel: '2025 · 40集', sourcesTestedAt: 1,
            sources: Array.from({ length: 45 }, (_, i) => ({ vod_id: i, vod_name: '剧', vod_pic: '/v.jpg', vod_play_url: i % 3 ? 'x'.repeat(70000) : '', vod_content: '简介', site_name: '站' + i, site_key: 's' + i, type_name: i % 2 ? '国产剧' : '', vod_year: '2025', latency: 300, _testType: 'direct' }))
        }
    };
    [fat, Object.assign({}, fat, { lastSourceKey: 'nope' }), { name: 'x' }, null, Object.assign({}, fat, { groupData: { sources: 'bad' } })].forEach((it, i) => {
        same(P.slimHistoryItem(it), webEp._slimHistoryItem(it), '_slimHistoryItem 与网页版一致 #' + i);
        same(P.slimHistoryItem(it), slimHistoryItem(it), '_slimHistoryItem 与 lib/history-slim 一致 #' + i);
    });

    // 分类浏览查询参数 / 显示过滤
    const NOW = new Date(2026, 9, 9, 12, 0, 0);
    let qd = 0, qn = 0;
    for (const T of WebCat.TYPES) {
        const sels = [{}];
        T.groups.forEach(g => g.opts.forEach(o => { const s = {}; s[g.k] = o.k; sels.push(s); }));
        sels.push({ region: 'cn', genre: 'costume' }, { form: 'movie', genre: 'history' }, { region: 'kr', lang: 'ko', year: '2020s' }, { year: '2026' }, { year: 'old' }, { year: '1990s' }, { region: 'bogus' });
        for (const s of sels) for (const sort of ['hot', 'new', 'top', undefined]) for (const nsfw of [true, false]) {
            const sel = Object.assign({}, s, sort ? { sort } : {});
            qn++;
            if (J(P.catalog.buildQuery(T.k, sel, 3, { now: NOW, nsfw })) !== J(WebCat.buildQuery(T.k, sel, 3, { now: NOW, nsfw }))) qd++;
        }
    }
    ok(qd === 0, 'DgCatalog.buildQuery:' + qn + ' 种 大类 × 筛选 × 排序 × 成人过滤 与网页版一致', qd);
    const VIS = [{ poster_path: '/a.jpg', title: '庆余年' }, { poster_path: '', title: '庆余年' }, { poster_path: '/a.jpg', name: '오징어 게임' }, { poster_path: '/a.jpg', name: 'Friends', original_name: 'Friends', original_language: 'en' },
        { poster_path: '/a.jpg', title: 'La Haine', original_title: 'La Haine', original_language: 'fr' }, { poster_path: '/a.jpg', title: '玉蒲团之偷情宝鉴', vote_count: 20 }, { poster_path: '/a.jpg', title: '性爱自修室', vote_count: 8000 }, null];
    same(VIS.map(v => [P.catalog.visible(v, true), P.catalog.visible(v, false)]), VIS.map(v => [WebCat.visible(v, true), WebCat.visible(v, false)]), 'DgCatalog.visible 与网页版一致');

    // 选线 / 线路顺序:网页版的 _pickPreferred / _autoPick / availableSources 装进桩对象,和电视版跑同一批线路
    const methods = ['srcProfile', '_srcFilterOn', '_srcClipOn', '_clipNativeBadMap', '_clipNativeBad', '_srcUnreach', '_kzWorkerOk', '_srcAdBad', 'srcTierRank', '_srcResRankOf', '_resTagOf', '_srcResMemo', '_srcRealRes', '_srcResOf', '_srcReachClass', '_pickPreferred', '_autoPick', '_isKzSource'];
    let objSrc = '{\n' + methods.map(n => { const m = extractMember(n); return '  ' + n + '(' + m.params + ') ' + m.body; }).join(',\n');
    objSrc += ',\n' + ['playableSources', 'sourceGroups', 'availableSources'].map(n => '  get ' + n + '() ' + extractMember(n).body).join(',\n') + '\n}';
    const factory = new Function('stubs', 'window', 'localStorage', 'location', CONSTS + '\nlet _navSeq = 1;\nreturn Object.assign(' + objSrc + ', stubs);');
    const webVm = (o) => factory({
        siteProfiles: o.profiles, corsProxyUrl: 'https://w.example', currentGroup: { sources: o.sources }, _adProxyBad: () => false, _srcHevcOk: () => o.hevc, _srcLenPub: () => null, srcRev: 0
    }, { AdFilter: { isEnabled: () => o.filter }, Hls: { isSupported: () => true }, AdClipCore: { probeTs() { } }, adClipSkip: {}, _dgPreferNativeHls: false, fetch: () => null, Uint8Array },
        { getItem: () => null, setItem() { }, removeItem() { } }, { hostname: 'tv.example.com' });
    let pk = 0, ap = 0, od = 0, cases = 0;
    const picked = new Set(), firstOf = new Set();
    for (let t = 0; t < 300; t++) {
        const n = 1 + Math.floor(rnd() * 12), sources = [], profiles = {};
        for (let i = 0; i < n; i++) {
            const key = (rnd() < 0.15 ? 'kz_' : 's') + i;
            const prof = pick([null, { tier: 'clean', res: '1080p' }, { tier: 'noburn', res: '4k' }, { tier: 'noburn', clip: 1 }, { tier: 'insert' }, { tier: 'ads', res: '720' }, { tier: 'clean', codec: 'hevc' }, { tier: 'weird' }]);
            const viaTable = rnd() < 0.5;
            if (viaTable && prof) profiles[key] = prof;
            sources.push({
                site_key: key, site_name: key, vod_id: i, latency: pick([45, 120, 380, 599, 600, 610, 900, 1400, 1999, 2100, 2900, 3100, 5000, 8999, 9998, 9999, 999]),
                _testType: pick(['direct', 'direct', 'proxy', 'server', null, 'kz']), _srvOnly: rnd() < 0.2, _useProxy: rnd() < 0.2, _kzMismatch: rnd() < 0.1,
                site_profile: viaTable ? null : prof
            });
        }
        const o = { sources, profiles, filter: rnd() < 0.7, hevc: rnd() < 0.5 };
        const w = webVm(o);
        const envT = { profiles, filterOn: (l) => !!l.useProxy || o.filter, clipOn: () => o.filter, hevcOk: () => o.hevc };
        const lines = sources.map(s => P.buildLine(s));
        const byKey = (x) => x ? (x.site_key || x.key) : null;
        cases++;
        const c0 = sources.filter(s => typeof s.latency === 'number' && s.latency < 9000);
        if (c0.length && byKey(P.pickPreferred(lines.filter(l => l.latency < 9000), envT)) !== byKey(w._pickPreferred(c0))) pk++;
        if (byKey(P.autoPick(lines, 2, undefined, envT)) !== byKey(w._autoPick(sources, 2))) ap++;
        if (byKey(P.autoPick(lines, 2, 3000, envT)) !== byKey(w._autoPick(sources, 2, 3000))) ap++;
        const tvOrder = P.orderList(lines, envT).filter(l => l.latency < 9000).map(byKey).join(',');
        if (tvOrder !== w.availableSources.map(byKey).join(',')) od++;
        const ap0 = w._autoPick(sources, 2);
        if (ap0) picked.add(sources.indexOf(ap0) + '/' + n);
        if (w.availableSources[0]) firstOf.add(w.sourceGroups[0].tier);
    }
    ok(picked.size > 40 && firstOf.size >= 3, '随机线路的选中结果 / 首组分布足够分散(不是空跑)', { picked: picked.size, groups: [...firstOf] });
    ok(pk === 0, '_pickPreferred:' + cases + ' 组随机线路与网页版选中同一条', pk);
    ok(ap === 0, '_autoPick(含历史回放的 3000ms 上限)与网页版一致', ap);
    ok(od === 0, 'availableSources:线路显示顺序 / 自动换线顺序与网页版一致', od);
    same([[3840, 1600], [1920, 800], [1080, 1920], [1280, 720], [640, 360], [0, 0]].map(x => P.resTagOf(x[0], x[1])), [[3840, 1600], [1920, 800], [1080, 1920], [1280, 720], [640, 360], [0, 0]].map(x => webVm({ sources: [] })._resTagOf(x[0], x[1])), '_resTagOf 与网页版一致');
}

console.log('② 电视页里跑 api.js');
await (async () => {
    // 配置:成功写缓存、代理整理、图片地址;失败用 7 天内缓存;再旧 → reject
    {
        const e = makeEnv({ width: 1920 });
        e.route('GET', '/api/config', () => ({ body: { cors_proxy_urls: [' https://w1.example/ ', 'ftp://x', 'https://w2.example//'], enable_local_image_cache: true, sync_enabled: false, favorites_enabled: true } }));
        await e.api.init();
        same(e.api.proxies(), ['https://w1.example', 'https://w2.example'], '代理列表:trim、去结尾 /、只留 http(s)(同 index.html)');
        ok(e.api.proxy() === 'https://w1.example' && e.api.setProxy('https://w2.example') === 'https://w2.example' && e.api.setProxy('https://evil') === 'https://w2.example', 'proxy() 主用第一个;setProxy 只认列表里的');
        ok(JSON.parse(e.store.donggua_config_cache).config.cors_proxy_urls.length === 3, '成功后写 donggua_config_cache {ts, config}');
        ok(e.api.img('/abc.jpg') === '/api/tmdb-image/w500/abc.jpg', '1920 宽屏用 w500 海报', e.api.img('/abc.jpg'));
        ok(e.api.img('http://pic.site/a.jpg') === 'https://pic.site/a.jpg' && e.api.img('https://x/y.png') === 'https://x/y.png' && e.api.img('') === '' && e.api.img('/img/mac_default.png') === '' && e.api.img('/api/tmdb-image/w342/q.jpg') === '/api/tmdb-image/w342/q.jpg' && e.api.img('/abc.jpg', 'w780') === '/api/tmdb-image/w780/abc.jpg', 'img():资源站 http 图升 https、站内地址原样、默认图当没有、可换尺寸');
        const e2 = makeEnv({ ls: { donggua_config_cache: JSON.stringify({ ts: Date.now() - 86400e3, config: { cors_proxy_url: 'https://old.example/', enable_local_image_cache: false } }) } });
        e2.route('GET', '/api/config', () => ({ status: 0 }));
        await e2.api.init();
        ok(e2.api.proxy() === 'https://old.example' && e2.api.cfg._offline === true && e2.api.img('/a.jpg') === 'https://image.tmdb.org/t/p/w342/a.jpg', '连不上:用 1 天前的缓存配置;enable_local_image_cache:false → image.tmdb.org');
        const e3 = makeEnv({ ls: { donggua_config_cache: JSON.stringify({ ts: Date.now() - 8 * 86400e3, config: {} }) } });
        e3.route('GET', '/api/config', () => ({ status: 500, body: {} }));
        let rej = false; try { await e3.api.init(); } catch (x) { rej = true; }
        ok(rej, '缓存超过 7 天 → init() reject(让页面显示重试)');
    }

    // 登录检查
    {
        const e = makeEnv();
        e.route('GET', '/api/auth/check', () => ({ body: { requirePassword: false, qrLogin: false } }));
        let r = await e.api.authCheck();
        ok(r.need === false && e.store.donggua_auth_required === '0', '站点不要密码 → need:false,记 donggua_auth_required=0');
        const now = Date.now();
        const v2b = { emax_auth_hash: 'v2board_abc', emax_auth_expiry: String(now + 1e9), emax_auth_type: 'v2board', emax_v2board_token: 'T', emax_v2board_email: 'u@x.com', emax_v2board_last_check: String(now - 3600e3) };
        const e2 = makeEnv({ ls: v2b });
        e2.route('GET', '/api/auth/check', () => ({ body: { requirePassword: true, qrLogin: true } }));
        r = await e2.api.authCheck();
        ok(r.need === false && r.qrLogin === true && !e2.reqs(/v2board\/check/).length, 'v2board 5 天内验证过 → 直接进,不发验证请求');
        ok(e2.api.userLabel() === 'u@x.com', 'userLabel() = 机场邮箱');
        const e3 = makeEnv({ ls: Object.assign({}, v2b, { emax_v2board_last_check: String(now - 6 * 86400e3) }) });
        e3.route('GET', '/api/auth/check', () => ({ body: { requirePassword: true } }));
        e3.route('POST', '/api/auth/v2board/check', () => ({ body: { success: false, message: '套餐已过期', expired: true } }));
        r = await e3.api.authCheck();
        ok(r.need === true && /套餐已过期/.test(r.message) && !e3.store.emax_auth_hash && !e3.store.emax_v2board_token, '超过 5 天且面板说过期 → 清登录态、要求登录、带原因');
        const e4 = makeEnv({ ls: Object.assign({}, v2b, { emax_v2board_last_check: '0' }) });
        e4.route('GET', '/api/auth/check', () => ({ body: { requirePassword: true } }));
        e4.route('POST', '/api/auth/v2board/check', () => ({ body: { success: false, unreachable: true } }));
        r = await e4.api.authCheck();
        ok(r.need === false && e4.store.emax_auth_hash === 'v2board_abc', '面板连不上(unreachable)→ 按上次登录状态放行');
        const e5 = makeEnv({ ls: Object.assign({}, v2b, { emax_v2board_last_check: '0' }) });
        e5.route('GET', '/api/auth/check', () => ({ body: { requirePassword: true } }));
        e5.route('POST', '/api/auth/v2board/check', () => ({ status: 429, body: {} }));
        r = await e5.api.authCheck();
        ok(r.need === false, '验证被限流(429)→ 不阻断');
        const e6 = makeEnv({ ls: { donggua_auth_required: '1' } });
        e6.route('GET', '/api/auth/check', () => ({ status: 0 }));
        r = await e6.api.authCheck();
        ok(r.need === true && r.offline, '断网 + 已知要登录 + 没凭据 → 不放行');
        const e7 = makeEnv({ ls: { donggua_auth_required: '1', emax_auth_hash: 'h' } });
        e7.route('GET', '/api/auth/check', () => ({ status: 0 }));
        ok((await e7.api.authCheck()).need === false, '断网但有凭据 → 放行(能看缓存)');
        const e8 = makeEnv({ ls: { emax_auth_hash: 'h1', emax_auth_expiry: String(now + 1e9), emax_auth_type: 'password' } });
        e8.route('GET', '/api/auth/check', () => ({ body: { requirePassword: true } }));
        e8.route('POST', '/api/auth/verify', (req) => ({ body: { success: req.body.passwordHash === 'h1' } }));
        ok((await e8.api.authCheck()).need === false, '密码账号:passwordHash 复核通过 → 进');
        const e9 = makeEnv({ ls: { emax_auth_hash: 'old', emax_auth_expiry: String(now + 1e9), emax_auth_type: 'password' } });
        e9.route('GET', '/api/auth/check', () => ({ body: { requirePassword: true } }));
        e9.route('POST', '/api/auth/verify', () => ({ body: { success: false } }));
        ok((await e9.api.authCheck()).need === true && !e9.store.emax_auth_hash, '密码改了 → 清登录态要求登录');
    }

    // 登录 / 扫码 / 退出
    {
        const e = makeEnv();
        e.route('POST', '/api/auth/v2board', (req) => ({ body: req.body.password === 'p' ? { success: true, userToken: 'v2board_u', v2boardToken: 'PT', plan: { expiresAt: 1893456000000 } } : { success: false, message: '密码错误' } }));
        e.route('GET', '/api/config', () => ({ body: { sync_enabled: true } }));
        let r = await e.api.loginV2board(' u@x.com ', 'bad');
        ok(!r.ok && r.message === '密码错误' && !e.store.emax_auth_hash, '机场登录失败:回 message,不写登录态');
        r = await e.api.loginV2board(' u@x.com ', 'p');
        const exp = +e.store.emax_auth_expiry;
        ok(r.ok && e.store.emax_auth_hash === 'v2board_u' && e.store.emax_auth_type === 'v2board' && e.store.emax_v2board_email === 'u@x.com' && e.store.emax_v2board_token === 'PT' &&
            e.store.emax_v2board_expires === '1893456000000' && exp > Date.now() + 360 * 86400e3, '机场登录成功:同网页版的 8 个 emax_* 键,记住 1 年');
        ok(e.ev('tv:user').length > 0, '登录后发 tv:user');
        const q = makeEnv();
        q.route('POST', '/api/auth/qr/new', () => ({ body: { ok: true, code: 'C0DE', secret: 'S', ttl: 300 } }));
        q.route('POST', '/api/auth/qr/poll', (req) => ({ body: req.body.secret === 'S' ? { status: 'approved', auth: { type: 'password', hash: 'H' } } : { status: 'expired' } }));
        q.route('POST', '/api/auth/verify', (req) => ({ body: req.body.passwordHash === 'H' ? { success: true, passwordHash: 'H' } : { success: false } }));
        const n = await q.api.qrNew();
        ok(n.url === 'https://tv.example.com/?tvlogin=C0DE' && n.secret === 'S', 'qrNew:二维码内容 = origin + /?tvlogin=code');
        const p = await q.api.qrPoll(n.code, n.secret);
        ok(p.status === 'approved' && p.auth.hash === 'H', 'qrPoll 回 status + auth');
        ok(await q.api.qrApply(p.auth) === true && q.store.emax_auth_hash === 'H' && q.store.emax_auth_type === 'password' && +q.store.emax_auth_expiry > Date.now() + 360 * 86400e3, 'qrApply(密码):复核后存成本机登录(1 年)');
        let msg = ''; try { await q.api.qrApply({ type: 'password', hash: 'X' }); } catch (x) { msg = x.message; }
        ok(/失效/.test(msg), 'qrApply:手机给的密码失效 → 报错');
        const q2 = makeEnv({ ls: { emax_auth_hash: 'stale', emax_v2board_plan: '{}' } });
        q2.route('POST', '/api/auth/v2board/check', (req) => ({ body: req.body.v2boardToken === 'PT' && req.body.email === 'm@x' ? { success: true, userToken: 'v2board_m', plan: {} } : { success: false } }));
        await q2.api.qrApply({ type: 'v2board', v2boardToken: 'PT', email: 'm@x' });
        ok(q2.store.emax_auth_hash === 'v2board_m' && q2.store.emax_auth_type === 'v2board' && !q2.store.emax_v2board_plan.includes('expires'), 'qrApply(机场):先清旧登录态,拿面板令牌验证后写本站令牌');
        const q3 = makeEnv();
        q3.route('POST', '/api/auth/v2board/check', () => ({ status: 0 }));
        msg = ''; try { await q3.api.qrApply({ type: 'v2board', v2boardToken: 'PT' }); } catch (x) { msg = x.message; }
        ok(/连不上/.test(msg) && !q3.store.emax_auth_type, 'qrApply(机场):验证接口 fail-open 但没拿到令牌 → 当失败,登录态清掉');
        // 退出
        const lo = makeEnv({ ls: { emax_auth_hash: 'h', emax_auth_expiry: '1', emax_auth_type: 'v2board', emax_v2board_email: 'e', emax_v2board_token: 't', donggua_watch_history: '[]', donggua_hist_synced: '{}', donggua_progress_a: '{}', donggua_progress_b: '{}', donggua_favorites: '[]', donggua_fav_cache: '{}', donggua_popular_cache3: '{}', donggua_playlists: '[]', donggua_site_health2: '{}', donggua_ad_filter_enabled: 'false' } });
        lo.api.logout();
        const left = Object.keys(lo.store).sort();
        same(left, ['donggua_ad_filter_enabled', 'donggua_site_health2'], '退出:登录 / 历史 / 进度 / 收藏 / 片单 / 大家都在看缓存全清,设备级设置和测速缓存留着');
    }

    // revalidateOnce:一页一次;明确失败 → tv:logout
    {
        const ls = { emax_auth_hash: 'v2board_a', emax_auth_type: 'v2board', emax_v2board_token: 'T', emax_auth_expiry: String(Date.now() + 1e9) };
        const e = makeEnv({ ls });
        let calls = 0;
        e.route('POST', '/api/auth/v2board/check', () => { calls++; return { body: { success: true, userToken: 'v2board_b' } }; });
        await e.api.revalidateOnce(); await e.api.revalidateOnce();
        ok(calls === 1 && e.store.emax_auth_hash === 'v2board_b', 'revalidateOnce:本页只验证一次,成功写回令牌');
        const e2 = makeEnv({ ls });
        e2.route('POST', '/api/auth/v2board/check', () => ({ body: { success: false, tokenExpired: true, message: '令牌过期' } }));
        ok(await e2.api.revalidateOnce() === false && e2.ev('tv:logout').length === 1 && !e2.store.emax_auth_hash, '面板明确说失效 → 清登录态并发 tv:logout');
        const e3 = makeEnv({ ls });
        e3.route('POST', '/api/auth/v2board/check', () => ({ status: 502, body: { error: 'bad gateway' } }));
        ok(await e3.api.revalidateOnce() === true && !e3.ev('tv:logout').length && e3.store.emax_auth_hash === 'v2board_a', '5xx / 断网 → 照常用,不登出');
    }

    // 进度 / 历史 / 增量推送 / 拉取合并
    {
        const e = makeEnv({ ls: { emax_auth_hash: 'tok123', emax_auth_type: 'password' } });
        e.route('GET', '/api/config', () => ({ body: { sync_enabled: true, favorites_enabled: true } }));
        e.route('GET', '/api/history/pull', () => ({ body: { sync_enabled: true, history: [], deleted: [] } }));
        e.route('GET', '/api/favorites', () => ({ body: { enabled: true, items: [] } }));
        let pushes = [];
        e.route('POST', '/api/history/push', (req) => { pushes.push(req.body); return { body: { sync_enabled: true, saved: req.body.history.length } }; });
        await e.api.init();
        await sleep(30);
        const raw = [
            { vod_id: 1, vod_name: '测试剧', vod_pic: 'http://p/1.jpg', vod_year: '2025', type_name: '国产剧', site_key: 'a', site_name: 'A站', vod_play_url: '第01集$https://a/1.m3u8#第02集$https://a/2.m3u8', vod_content: '<p>简介</p>' },
            { vod_id: 7, vod_name: '测试剧', vod_pic: '', vod_year: '2025', site_key: 'b', site_name: 'B站', vod_play_url: '第1集$https://b/1.m3u8#第2集$https://b/2.m3u8' }
        ];
        const w = e.P.workFromGroup(e.P.groupList(raw)[0]);
        ok(w.title === '测试剧' && w.lines.length === 2 && w.lines[0].eps.length === 2 && w.desc === '简介' && w.key === '测试剧|', 'Work:片名 / 线路 / 选集 / 去标签简介 / key');
        e.api.saveProgress(w, 1, 0, 30, 2700);
        ok(!e.store.donggua_watch_history, '看了不到 1 分钟:不记进度、不进历史');
        w.lines[1].latency = 321; w.lines[1].test = 'proxy'; w.lines[1].useProxy = true; w.lines[1].proxyUrl = 'https://w';
        e.api.saveProgress(w, 1, 0, 754.6, 2700);
        const key = e.P.progressKey('测试剧', '第1集', false);
        const pv = JSON.parse(e.store[key]);
        ok(pv.time === 754 && !isNaN(Date.parse(pv.date)), '进度键 {time:floor(秒), date:ISO}(和网页版同一个键)');
        const h = JSON.parse(e.store.donggua_watch_history)[0];
        const s1 = h.groupData.sources[1];
        ok(h.name === '测试剧' && h.episode === '第1集' && h.progress === 28 && h.progressTime === 755 && h.progressDuration === 2700 && h.lastSourceKey === 'b' &&
            s1.latency === 321 && s1._testType === 'proxy' && s1._useProxy === true && s1._proxyUrl === 'https://w' && s1.vod_play_url.indexOf('第1集$') === 0 && h.groupData.sources[0].vod_content === '<p>简介</p>',
            '历史条目格式同 addToWatchHistory(进度 % / 秒 / 上次线路 / 线路快照带测速结果)', h);
        same(Object.keys(h), ['name', 'poster', 'episode', 'progress', 'progressTime', 'progressDuration', 'watchedAt', 'lastSourceKey', 'groupData'], '历史条目字段顺序同网页版');
        ok(e.api.getResume(w, '第1集', false) === 754 && e.api.getResume(w, '第1集', false, 800) === 0 && e.api.getResume(w, '第2集', false) === 0, 'getResume:30 天内 >60 秒;离结尾 2 分钟内不续播');
        const lw = e.api.lastWatch(w);
        ok(lw && lw.lineKey === 'b' && lw.epName === '第1集' && lw.time === 755, 'lastWatch:上次线路 / 集 / 秒');
        const cards = e.api.historyCards(10);
        ok(cards.length === 1 && cards[0].kind === 'hist' && cards[0].sub === '看到 第1集' && Math.abs(cards[0].progress - 0.28) < 1e-9 && cards[0].poster === 'https://p/1.jpg', 'historyCards:进度 0~1、「看到 第1集」、海报升 https', cards[0]);
        await e.api.flushHistory();
        ok(pushes.length === 1 && pushes[0].token === 'tok123' && pushes[0].history.length === 1 && pushes[0].history[0].id === '测试剧' &&
            pushes[0].history[0].data.groupData.sources[1].vod_play_url && !pushes[0].history[0].data.groupData.sources[0].vod_play_url && pushes[0].history[0].data.groupData.sources[0].latency === undefined,
            '推送:瘦身后只带上次线路的选集串、不带测速字段', pushes[0]);
        await e.api.flushHistory();
        ok(pushes.length === 1, '没变化不再推(donggua_hist_synced 记了服务器已确认的版本)');
        e.api.saveProgress(w, 1, 1, 2650, 2700);
        ok(!e.store[e.P.progressKey('测试剧', '第2集', false)] && JSON.parse(e.store.donggua_watch_history)[0].progress === 100, '看到最后 2 分钟 = 看完:不留进度,历史记 100%');
        e.api.removeHistory('测试剧');
        await sleep(20);
        const tomb = JSON.parse(e.store.donggua_history_deleted);
        ok(tomb['测试剧'] > 0 && !e.api.historyCards(10).length, 'removeHistory:删掉并打墓碑');
        ok(pushes.length >= 2 && pushes[pushes.length - 1].deleted.some(d => d.id === '测试剧'), '删除立刻推墓碑');
        // 单集电影的进度键不带集名
        const mv = e.P.workFromGroup(e.P.groupList([{ vod_id: 3, vod_name: '电影X', site_key: 'c', site_name: 'C', vod_play_url: 'HD中字$https://c/m.m3u8' }])[0]);
        e.api.saveProgress(mv, 0, 0, 600, 7200);
        ok(!!e.store[e.P.progressKey('电影X', null, true)] && e.api.getResume(mv, 'HD中字') === 600, '单集电影:进度键只用片名(换线路集名不同也续得上)');
    }
    {
        // 拉取合并:服务器新的胜、本机新的留下、墓碑压制、进度键改写、发 tv:hist
        const t0 = Date.now();
        const iso = (ms) => new Date(ms).toISOString();
        const local = [{ name: 'A', episode: '第2集', progressTime: 100, watchedAt: iso(t0 - 1000), groupData: { name: 'A', sources: [] } }, { name: 'B', episode: null, progressTime: 500, watchedAt: iso(t0 - 5000) }];
        const e = makeEnv({ ls: { emax_auth_hash: 'tok', donggua_watch_history: JSON.stringify(local) } });
        e.route('GET', '/api/config', () => ({ body: { sync_enabled: true } }));
        e.route('GET', '/api/favorites', () => ({ body: { enabled: true, items: [] } }));
        e.route('POST', '/api/history/push', () => ({ body: { sync_enabled: true } }));
        e.route('GET', '/api/history/pull', () => ({ body: { sync_enabled: true,
            history: [{ id: 'A', data: { name: 'A', episode: '第1集', progressTime: 50, watchedAt: iso(t0 - 9000) } }, { id: 'B', data: { name: 'B', episode: null, progressTime: 900, watchedAt: iso(t0 - 100) } }, { id: 'C', data: { name: 'C', episode: '第03集', progressTime: 1200, watchedAt: iso(t0 - 200) } }, { id: 'D', data: { name: 'D', episode: '第1集', progressTime: 70, watchedAt: iso(t0 - 300) } }],
            deleted: [{ id: 'D', deleted_at: t0 }] } }));
        await e.api.init();
        await e.api.pullHistory();
        const list = JSON.parse(e.store.donggua_watch_history);
        same(list.map(x => x.name + ':' + x.progressTime), ['B:900', 'C:1200', 'A:100'], '合并:逐条 watchedAt 新的胜,墓碑压住 D,按时间倒排');
        ok(JSON.parse(e.store[e.P.progressKey('C', '第03集', false)]).time === 1200 && JSON.parse(e.store[e.P.progressKey('B', null, true)]).time === 900, '合并后改写进度键(集名归一化同播放器)');
        ok(e.ev('tv:hist').some(x => x.detail && x.detail.remote), '有变化发 tv:hist');
        const st = JSON.parse(e.store.donggua_hist_synced);
        ok(st.t === 'tok' && st.items.C && st.tombs.D === t0, '记下服务器已有的版本和墓碑(之后只推本机更新的)');
    }

    // 收藏
    {
        const e = makeEnv({ ls: { emax_auth_hash: 'tk', emax_auth_type: 'password' } });
        e.route('GET', '/api/config', () => ({ body: { sync_enabled: false, favorites_enabled: true } }));
        e.route('POST', '/api/favorites/status', (req) => ({ body: { enabled: true, status: { 'a|1': { ep_count: 12, remarks: '更新至12集' } } } }));
        await e.api.init();
        const w = e.P.workFromGroup(e.P.groupList([{ vod_id: 1, vod_name: '收藏剧', vod_pic: 'https://p/c.jpg', site_key: 'a', site_name: 'A', vod_play_url: '1$u#2$u2#3$u3' }, { vod_id: 9, vod_name: '收藏剧', site_key: 'kz_q', site_name: 'K', vod_play_url: '' }])[0]);
        ok(await e.api.toggleFav(w) === true && e.api.isFav(w), '本机收藏:♥ 后 isFav');
        const f = JSON.parse(e.store.donggua_favorites)[0];
        ok(f.fav_id === '收藏剧' && f.data.checkSource.site_key === 'a' && f.data.addedEpCount === 3 && f.data.sources.length === 1 && f.data.kind === 'vod' && f.seen_count === 3, '收藏条目同 _favBuildItem(检查线路 / 集数 / 跳过 kz 线路)', f);
        await sleep(30);
        const fc = e.api.favoriteCards(10);
        ok(fc.length === 1 && fc[0].flag === '更新' && fc[0].sub === '更新至12集', '查到更新:卡片角标「更新」+ 备注', fc[0]);
        ok(await e.api.toggleFav(w) === false && !e.api.isFav(w) && JSON.parse(e.store.donggua_favorites).length === 0, '再按一次取消');
        ok(e.ev('tv:favs').length >= 2, '变化发 tv:favs');
        const s = makeEnv({ ls: { emax_auth_hash: 'tk2', emax_auth_type: 'v2board' } });
        let added = null;
        s.route('GET', '/api/config', () => ({ body: { sync_enabled: true, favorites_enabled: true } }));
        s.route('GET', '/api/history/pull', () => ({ body: { sync_enabled: true, history: [] } }));
        s.route('GET', '/api/favorites', () => ({ body: { enabled: true, limit: 100, items: [{ fav_id: 'Z', data: { name: 'Z', poster: '/z.jpg' }, has_update: true }] } }));
        s.route('POST', '/api/favorites/add', (req) => { added = req.body; return { body: { ok: true, fav_id: '收藏剧' } }; });
        await s.api.init();
        await sleep(30);
        ok(s.api.favoriteCards(5)[0].flag === '更新' && JSON.parse(s.store.donggua_fav_cache).t === 'tk2', '同步用户:读服务器收藏(has_update)并按 token 前缀缓存');
        await s.api.toggleFav(w);
        ok(added && added.token === 'tk2' && added.item.name === '收藏剧' && s.api.isFav(w), '同步用户:♥ 发 /api/favorites/add');
        const d = makeEnv({ ls: { emax_auth_hash: 'tk3', emax_auth_type: 'v2board', donggua_favorites: JSON.stringify([{ fav_id: 'L', data: { name: 'L' } }]) } });
        d.route('GET', '/api/config', () => ({ body: { sync_enabled: false, favorites_enabled: true } }));
        d.route('POST', '/api/auth/v2board/check', () => ({ status: 0 }));
        await d.api.init();
        let er = ''; try { await d.api.toggleFav(w); } catch (x) { er = x.message; }
        ok(!d.api.favoriteCards(5).length && /网络/.test(er), 'v2board 账号服务器还没确认同步:不拿本机列表充数,♥ 不写本机');
    }

    // 分类浏览 / 首页
    {
        const e = makeEnv();
        for (const c of ['movie', 'tv', 'variety', 'anime']) {
            const f = e.api.catFilters(c);
            ok(f.length <= 3 && f.length >= 2 && f.every(r => r.opts.length > 1 && typeof r.opts[0].v === 'string' && r.opts[0].t), 'catFilters(' + c + '):≤3 排,每排有默认第一项');
        }
        same(e.P.catSel('anime', { cls: 'movie', sort: 'new' }), { region: '', form: 'movie', genre: '', sort: 'new' }, '动漫「动画电影」= form:movie');
        let calls = [];
        e.route('GET', '/api/tmdb-proxy', (req) => {
            calls.push(req.url);
            const pg = +/[?&]page=(\d+)/.exec(req.url)[1];
            const res = pg === 1 ? [{ id: 1, title: '甲', poster_path: '/1.jpg' }, { id: 2, title: '乙', poster_path: '' }, { id: 3, title: '오', poster_path: '/3.jpg' }]
                : pg === 2 ? [{ id: 1, title: '甲', poster_path: '/1.jpg' }, { id: 9, name: '丙', poster_path: '/9.jpg', first_air_date: '2024-01-01', vote_average: 8.26 }] : [];
            return { body: { results: res, total_pages: 3 } };
        });
        const r1 = await e.api.browse('tv', { region: 'cn', sort: 'new' }, 1);
        const q = e.P.catalog.buildQuery('tv', { region: 'cn', genre: '', sort: 'new' }, 1, { nsfw: true });
        ok(r1.items.length === 1 && r1.items[0].title === '甲' && r1.items[0].kind === 'tmdb' && r1.items[0].media === 'tv' && r1.more, 'browse:没海报 / 外文名的不要');
        ok(calls[0].indexOf('/api/tmdb-proxy?path=%2Fdiscover%2Ftv&') === 0 && calls[0].indexOf('with_origin_country=CN') > 0 && calls[0].indexOf('include_adult=false') > 0 && q.params.sort_by === 'first_air_date.desc', 'browse:按 buildQuery 拼 /api/tmdb-proxy(默认带成人过滤)');
        const r2 = await e.api.browse('tv', { region: 'cn', sort: 'new' }, 2);
        ok(r2.items.length === 1 && r2.items[0].title === '丙' && r2.items[0].year === '2024' && r2.items[0].badge === '8.3', 'browse:翻页按 id 去重');
        // 首页:按固定顺序回调(哪怕后面的先回来)
        const h = makeEnv();
        h.route('GET', '/api/tmdb-proxy', (req) => {
            const isTrendTv = req.url.indexOf(encodeURIComponent('/trending/tv/week')) > 0;
            return { delay: isTrendTv ? 40 : 0, body: { results: Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: '剧' + i, poster_path: '/p' + i + '.jpg' })) } };
        });
        h.route('GET', '/api/popular', () => ({ body: { items: [] } }));
        const order = [];
        await h.api.homeRows(r => order.push(r.id + ':' + r.items.length));
        same(order, ['tvRow:20', 'movieRow:20', 'cnRow:20', 'usRow:20', 'krjpRow:20', 'animeRow:20', 'varietyRow:20', 'docRow:20'], '首页各排按固定顺序到(第一排慢也不乱),每排最多 20 张;大家都在看不足 4 部不出');
        const cn = h.reqs(/with_origin_country=CN/)[0].url;
        ok(cn.indexOf('sort_by=first_air_date.desc&vote_count.gte=10') > 0, '国产剧排:同网页版 newest(首播日期倒排 + 至少 10 票)');
        const bad = makeEnv();
        bad.route('GET', '/api/tmdb-proxy', () => ({ status: 0 }));
        bad.route('GET', '/api/popular', () => ({ status: 0 }));
        let rj = false; try { await bad.api.homeRows(() => { }); } catch (x) { rj = true; }
        ok(rj, '首页全失败 → reject(页面出重试)');
        // 大家都在看:≥4 部有海报才出,查海报的缓存同网页版
        const p = makeEnv({ ls: { emax_auth_hash: 'tkp' } });
        p.route('GET', '/api/tmdb-proxy?path=%2Ftrending', () => ({ body: { results: [] } }));
        p.route('GET', '/api/tmdb-proxy?path=%2Fdiscover', () => ({ body: { results: [] } }));
        p.route('GET', '/api/popular', (req) => ({ body: { items: ['甲第二季', '乙', '丙', '丁', '戊'].map(t => ({ title: t, kind: 'vod' })) } }));
        p.route('GET', '/api/tmdb-proxy?path=%2Fsearch%2Fmulti', (req) => {
            const qq = decodeURIComponent(/query=([^&]+)/.exec(req.url)[1]);
            return { body: { results: qq === '戊' ? [] : [{ media_type: 'tv', name: qq, poster_path: '/' + encodeURIComponent(qq) + '.jpg', first_air_date: '2023-01-01' }] } };
        });
        const pr = [];
        await p.api.homeRows(r => pr.push(r));
        ok(pr.length === 1 && pr[0].id === 'popular' && pr[0].items.length === 4 && pr[0].items[0].kind === 'title' && pr[0].items[0].title === '甲第二季', '大家都在看:按站内片名搜(去 第N季),没海报的不出', pr[0]);
        ok(p.reqs(/\/api\/popular/)[0].url.indexOf('token=tkp') > 0 && JSON.parse(p.store.donggua_popular_cache3).t === 'tkp' && JSON.parse(p.store.donggua_tmdb_title)['乙'].p, '带 token 拉、按账号缓存(donggua_popular_cache3 / donggua_tmdb_title 同网页版)');
        ok(J(await p.api.hotWords()) === J(['甲第二季', '乙', '丙', '丁', '戊']), 'hotWords:大家都在看的片名');
    }

    // 流式搜索
    {
        const e = makeEnv();
        const partials = [];
        const prom = e.api.searchWorks('遮天', (ws) => partials.push(ws.length), { original: 'Shrouding' });
        const es = e.es[0];
        ok(es && es.url === '/api/search?wd=%E9%81%AE%E5%A4%A9&stream=true&original=Shrouding', 'EventSource:/api/search?wd=&stream=true(&original=)');
        es.msg([{ vod_id: 1, vod_name: '遮天', site_key: 'a', site_name: 'A', vod_play_url: '1$u' }]);
        es.msg([{ vod_id: 2, vod_name: '遮天', site_key: 'b', site_name: 'B', vod_play_url: '1$v' }]);
        es.msg([{ vod_id: 3, vod_name: '遮天外传', site_key: 'b', site_name: 'B', vod_play_url: '1$x' }]);
        await sleep(10);
        ok(partials.length === 1, 'onPartial 节流(600ms 内只回调一次)', partials);
        es.done();
        const ws = await prom;
        ok(ws.length === 2 && ws[0].title === '遮天' && ws[0].lines.length === 2 && es.closed, 'done → resolve(按片名分组、线路多的在前),关掉连接');
        ok(e.api.workCard(ws[0]).badge === '2 线' && e.api.workCard(ws[0]).kind === 'work', 'workCard:角标「N 线」');
        const e2 = makeEnv();
        e2.route('GET', '/api/search?wd=', () => ({ body: { list: [{ vod_id: 5, vod_name: '庆余年', site_key: 'z', site_name: 'Z', vod_play_url: '1$u' }] } }));
        const p2 = e2.api.searchWorks('庆余年');
        e2.es[0].err();
        const ws2 = await p2;
        ok(ws2.length === 1 && ws2[0].lines[0].key === 'z', 'SSE 一开始就断 → 退回普通 GET /api/search?wd=');
        const e3 = makeEnv({ noES: true });
        e3.route('GET', '/api/search?wd=', () => ({ body: { list: [{ vod_id: 5, vod_name: 'X', site_key: 'z', vod_play_url: '' }] } }));
        ok((await e3.api.searchWorks('X')).length === 1, '没有 EventSource 的内核直接普通 GET');
        // findWork:片名一致 + 年份接近 + 线路多
        const e4 = makeEnv();
        const p4 = e4.api.findWork('庆余年', { year: '2019', media: 'tv' });
        e4.es[0].msg([
            { vod_id: 1, vod_name: '庆余年第二季', site_key: 'a', vod_year: '2024', vod_play_url: '1$u' }, { vod_id: 2, vod_name: '庆余年', site_key: 'b', vod_year: '2019', vod_play_url: '1$u#2$v#3$w' },
            { vod_id: 3, vod_name: '庆余年', site_key: 'c', vod_year: '2019', vod_play_url: '1$a#2$b#3$c' }
        ]);
        e4.es[0].done();
        const fw = await p4;
        ok(fw && fw.title === '庆余年' && fw.lines.length === 2, 'findWork:片名完全一致的优先(不挑第二季)');
        // 局部结果里同一部保持同一个对象
        const e5 = makeEnv();
        let first = null;
        const p5 = e5.api.searchWorks('A', (ws) => { if (!first) first = ws[0]; });
        e5.es[0].msg([{ vod_id: 1, vod_name: 'A', site_key: 'a', vod_play_url: '1$u' }]);
        await sleep(5);
        e5.es[0].msg([{ vod_id: 2, vod_name: 'A', site_key: 'b', vod_play_url: '1$v' }]);
        e5.es[0].done();
        const ws5 = await p5;
        ok(first && ws5[0] === first && first.lines.length === 2, '流式结果里同一部作品是同一个对象(早画出来的卡点开也是最新线路)');
    }

    // 测速
    {
        const e = makeEnv({ ls: { donggua_site_health2: JSON.stringify({ c: { latency: 222, testType: 'direct', useProxy: false, proxyUrl: null, srvOnly: false, ts: Date.now() } }) } });
        e.route('GET', '/api/config', () => ({ body: { cors_proxy_url: 'https://w.example' } }));
        await e.api.init();
        e.route('GET', 'https://a/', () => ({ body: '#EXTM3U\n#EXTINF:10,\nx.ts\n' }));
        e.route('GET', 'https://m/master.m3u8', () => ({ body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nhd/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=3840x2160\nuhd/index.m3u8\n' }));
        e.route('GET', 'https://m/hd/index.m3u8', () => ({ body: '#EXTM3U\n#EXTINF:5,\n0.ts' }));
        e.route('GET', 'https://dead/', () => ({ status: 403, body: 'no' }));
        e.route('GET', 'https://w.example/?url=' + encodeURIComponent('https://dead/1.m3u8'), () => ({ body: '#EXTM3U\n#EXTINF:3,\n1.ts' }));
        e.route('GET', '/api/check?key=h', () => ({ body: { latency: 800, _testType: 'server' } }));
        e.route('GET', 'https://empty/', () => ({ body: '#EXTM3U\n#EXT-X-ENDLIST\n' }));
        e.route('GET', '/api/check?key=n', () => ({ body: { latency: 9999, transient: true } }));
        const mkS = (k, url, prof) => ({ vod_id: 1, vod_name: 'T', site_key: k, site_name: k.toUpperCase(), vod_play_url: '第1集$' + url, site_profile: prof || { tier: 'clean' } });
        const w = e.P.workFromGroup({ name: 'T', sources: [mkS('a', 'https://a/1.m3u8'), mkS('m', 'https://m/master.m3u8'), mkS('d', 'https://dead/1.m3u8'), mkS('h', 'http://insecure/1.m3u8'), mkS('c', 'https://cached/1.m3u8'), mkS('n', 'https://empty/1.m3u8')].map(s => Object.assign(s, { latency: 999 })) });
        let updates = 0, finished = false;
        const t = e.api.testLines(w, (l, done) => { updates++; if (done) finished = true; });
        await t.done;
        const L = k => w.lines.find(l => l.key === k);
        ok(finished && updates >= 6, 'testLines:每条有结果回调,最后 done');
        ok(L('c').latency === 222 && L('c').test === 'direct' && !e.reqs(/cached/).length, '命中 donggua_site_health2 缓存:直接套用,不发请求');
        ok(L('a').test === 'direct' && L('a').latency < 9000, '直连 m3u8 有 #EXTINF → direct');
        ok(L('m').test === 'direct' && e.reqs(/m\/hd\/index/).length === 1 && L('m').res === '4K', '主清单跟进第一条子清单验分片;RESOLUTION 记成线路分辨率', L('m').res);
        ok(L('d').test === 'proxy' && L('d').useProxy && L('d').proxyUrl === 'https://w.example', '直连 403 → 代理能通 → proxy');
        ok(L('h').srvOnly && L('h').test === 'server' && L('h').latency === 800 && L('h').tag === '可能无法播放' && !e.reqs(/insecure/).length, 'https 页面上的 http 片源:不直连,问 /api/check,归「可能无法播放」');
        ok(L('n').latency === 9999 && L('n').srvOnly, '空清单(没有 #EXTINF)→ 直连代理都不算通 → 服务器也说不通 → 9999');
        const hc = JSON.parse(e.store.donggua_site_health2);
        ok(hc.a.testType === 'direct' && hc.d.useProxy === true && hc.d.proxyUrl === 'https://w.example' && !hc.n && !hc.h, '测通的写回健康缓存(同网页版格式);瞬态失败 / 只测了一部剧的服务器档不写');
        e.api.orderLines(w);
        ok(w.lines[w.lines.length - 1].key === 'n' && w.lines[0].latency < 600, 'orderLines:快线在前,测不通的垫底');
        const b = w.lines[e.api.bestLine(w)];
        ok(b && b.test === 'direct', 'bestLine:优先直连档');
        ok(JSON.parse(e.store.donggua_src_res)['m|1'].w === 3840, '实测分辨率记在 donggua_src_res(站点|vod_id)');
        // http 页面(本地部署)上的 http 片源照常直连测
        const e2 = makeEnv({ location: { protocol: 'http:' } });
        e2.route('GET', 'http://plain/', () => ({ body: '#EXTM3U\n#EXTINF:1,\na.ts' }));
        const w2 = e2.P.workFromGroup({ name: 'T', sources: [mkS('p', 'http://plain/1.m3u8')] });
        await e2.api.testLines(w2).done;
        ok(w2.lines[0].test === 'direct', 'http 页面:http 片源直连测');
        // Kazumi:解析一次,年份不符排最后
        const e3 = makeEnv();
        e3.route('GET', '/api/kz/ep/', () => ({ body: { type: 'hls', url: '/api/kz/m3u8/x/1.m3u8' } }));
        e3.route('GET', 'https://a/', () => ({ body: '#EXTM3U\n#EXTINF:1,\na.ts' }));
        const w3 = e3.P.workFromGroup({ name: 'K', sources: [mkS('a', 'https://a/1.m3u8'), Object.assign(mkS('a2', 'https://a/2.m3u8'), { vod_year: '2023' }), Object.assign(mkS('b', 'https://a/3.m3u8'), { vod_year: '2023' }), { vod_id: 'k1', vod_name: 'K', site_key: 'kz_x', site_name: 'KZ', _kz: 1, vod_year: '2020', vod_play_url: '' }] });
        e3.route('GET', '/api/detail?site_key=kz_x', () => ({ body: { list: [{ vod_play_url: '第1集$/api/kz/ep/x/tok1' }] } }));
        await e3.api.testLines(w3).done;
        const kz = w3.lines.find(l => l.kz);
        ok(kz.test === 'kz' && kz.kzMismatch && kz.latency === 8999 && kz.eps.length === 1 && kz.eps[0].url === '/api/kz/ep/x/tok1', 'Kazumi:拉详情拿选集(/api/kz/ep/ 原样保留),年份不符 → 8999 排最后');
    }

    // 选集 / 直播 / 联想
    {
        const e = makeEnv();
        e.route('GET', '/api/detail?site_key=s&id=5', () => ({ body: { list: [{ vod_play_url: '第1集$https://x/1.m3u8#第2集$https://x/2.m3u8' }] } }));
        const l = e.P.buildLine({ site_key: 's', site_name: 'S', vod_id: 5, vod_play_url: '' });
        ok(e.api.hasEp(l, '第1集') === null, 'hasEp:选集还没拉到 → null(未知)');
        const eps = await e.api.loadEps(l);
        ok(eps.length === 2 && l.playUrl && e.api.hasEp(l, '第02集') === true && e.api.hasEp(l, '第3集') === false && e.api.hasEp(l, 1) === true && e.api.hasEp(l, 2) === false, 'loadEps:拉详情(20s)并缓存在线路上;hasEp 按集名 / 下标');
        const bad = e.P.buildLine({ site_key: 'q', vod_id: 1 });
        e.route('GET', '/api/detail?site_key=q', () => ({ status: 500, body: {} }));
        ok(J(await e.api.loadEps(bad)) === '[]', 'loadEps 失败回 [](不 reject)');
        e.route('GET', '/api/live/channels', () => ({ body: { enabled: true, channels: [{ id: 'lv_1', name: 'CCTV1', group: '央视', sources: [{ url: 'u' }] }, { id: 'lv_2', name: 'X', group: '成人', adult: true, sources: [] }], groups: ['央视', '成人', '空组'] } }));
        const lc = await e.api.liveChannels();
        ok(lc.enabled && lc.channels.length === 1 && J(lc.groups) === J(['央视']) && JSON.parse(e.store.donggua_live_cache).channels.length === 2, '直播:成人频道默认藏起来,组只留有频道的;缓存原样存');
        e.store.donggua_filter_nsfw = 'false';
        ok((await e.api.liveChannels()).channels.length === 2 && e.reqs(/live\/channels/).length === 1, '关了过滤能看到;2 小时内走缓存');
        for (let i = 0; i < 14; i++) e.api.addLiveRecent({ id: 'c' + i, name: 'C' + i, sources: [{ url: 1 }, { url: 2 }, { url: 3 }, { url: 4 }, { url: 5 }, { url: 6 }, { url: 7 }] });
        const rec = e.api.liveRecent();
        ok(rec.length === 12 && rec[0].id === 'c13' && rec[0].sources.length === 6, '最近频道:最新在前、最多 12 个、每个最多 6 个源');
        let sug = 0;
        e.route('GET', '/api/tv/suggest', (req) => { sug++; return { body: { list: [{ title: '庆余年', year: '', kind: '电视剧' }] } }; });
        const [a, b2] = await Promise.all([e.api.suggest('Q'), e.api.suggest('QY')]);
        ok(sug === 1 && a.length === 0 && b2[0].title === '庆余年', 'suggest:连着打字只发最后一个词');
        await e.api.suggest('qy');
        ok(sug === 1, 'suggest:同一个词 10 分钟内走内存缓存(不分大小写)');
    }
})();

console.log('③ server.js /api/tv/suggest');
{
    const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok((SRV.match(/\r\n/g) || []).length === (SRV.match(/\n/g) || []).length, 'server.js 仍然全是 CRLF');
    const S = SRV.split('\r\n').join('\n');
    const m = /\/\/ <tv-suggest-core>\n([\s\S]*?)\n\/\/ <\/tv-suggest-core>/.exec(S);
    ok(!!m, '找到 <tv-suggest-core> 段');
    const C = new Function(m[1] + '\nreturn { tvSugClean, tvSugFromIqiyi, tvSugFrom360, tvSugMerge, tvSugQuery };')();
    const live = S.indexOf("app.get('/api/live/channels'"), sug = S.indexOf("app.get('/api/tv/suggest', tvSuggestLimiter");
    ok(live > 0 && sug > live && S.slice(live, sug).split('app.get(').length === 2, '路由紧跟在 /api/live/channels 后面,带限流');
    ok(/rateLimit\(\{ windowMs: 60 \* 1000, max: 60, keyGenerator: ipKey/.test(S.slice(sug - 3000, sug)), '每 IP 每分钟 60 次');
    // 2026-11 录下来的爱奇艺回包(qyn)
    const iq = { code: 'A00000', data: [
        { aid: 0, name: '庆余年', cid: 0, cname: '', year: 2010, presentation_element: { tags: [{ name: '电视剧' }] } },
        { aid: 0, name: '庆余年第二季', cname: '', year: 2026, presentation_element: { tags: [{ name: '电视剧' }] } },
        { aid: 0, name: '庆余年第3季免费全集', cname: '', year: 2026 }, { aid: 0, name: '庆余年第三季电视剧', year: 2026 },
        { aid: 8948661384860901, name: '凡人歌', cid: 2, cname: '电视剧', year: 2024, presentation_element: { tags: [{ name: '电视剧' }, { name: '第30届白玉兰奖提名' }] } },
        { aid: 0, name: '去有你的地方', year: 2010, presentation_element: { tags: [{ name: '短剧' }] } }, { aid: 0, name: '' }, null
    ] };
    same(C.tvSugFromIqiyi(iq), [
        { title: '庆余年', year: '', kind: '电视剧' }, { title: '庆余年第二季', year: '', kind: '电视剧' }, { title: '庆余年第3季', year: '', kind: '' }, { title: '庆余年第三季', year: '', kind: '' },
        { title: '凡人歌', year: '2024', kind: '电视剧' }, { title: '去有你的地方', year: '', kind: '短剧' }
    ], '爱奇艺:联想词(aid=0)不给假年份;类型取 cname / 白名单标签;剥 SEO 尾巴');
    const so = { result: [{ word: '庆余年第一季电视剧全集免费' }, { word: '庆余年2第二季电视剧免费观看完整版' }, { word: '庆余年演员表' }, { word: '庆余年第三季什么时候上映' }, { word: '庆余年第二季40集免费观看' }, { word: '庆余年小说免费阅读全文' }, { word: '庆余年1' }, { word: '延禧攻略电视连续剧' }] };
    same(C.tvSugFrom360(so).map(x => x.title), ['庆余年第一季', '庆余年2第二季', '庆余年第二季', '庆余年1', '延禧攻略'], '360:剥「电视剧全集免费观看」类尾巴,演员表 / 小说 / 什么时候上映 这类不是片名的丢掉');
    same(C.tvSugMerge([[{ title: '庆余年', year: '', kind: '' }, { title: '庆 余年', year: '2019', kind: '电视剧' }], Array.from({ length: 20 }, (_, i) => ({ title: 'T' + i }))], 12).map(x => x.title + x.year + x.kind).slice(0, 2), ['庆余年2019电视剧', 'T0'], '去重(忽略空格),补上缺的年份 / 类型');
    ok(C.tvSugMerge([Array.from({ length: 20 }, (_, i) => ({ title: 'T' + i }))], 12).length === 12, '最多 12 条');
    same(['qyn', ' 庆余年 ', '庆余年：第二季', 'a'.repeat(21), '<script>', '', null, ['x'], 'ABC123'].map(C.tvSugQuery), ['qyn', '庆余年', '庆余年第二季', '', '', '', '', '', 'ABC123'], '输入只认字母 / 数字 / 汉字,≤20 字(空格和常见标点先去掉)');
    ok(C.tvSugClean('<b>庆余年</b> 第二季 全集') === '庆余年 第二季' && C.tvSugClean('全集') === '全集', '清洗:去标签;整串都是"尾巴"时原样留着');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
