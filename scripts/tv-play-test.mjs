#!/usr/bin/env node
// 电视版播放链路回归(离线、零网络):public/tv/play.js
//   node scripts/tv-play-test.mjs
//  ① 和网页版同源的纯函数逐个对照 public/index.html 的原件(从页面里抽出来跑):集名结构 IntroCore.parseEpName/epInfos、
//     片头标记闸门 opAuto/bumpAuto/bumpShow/curOf、skipManager 的区间选择、缓冲小洞 dgHoleTarget、worker 探测分类 classify、
//     _kzWorkerOk、watchMeter.epLabel;另钉住几行规则原文(路由条件 / 通道 / 记账 12h·60 站 / 续播条件 / 看门狗判据 / hls 配置),改了网页这边会报
//  ② 纯函数自己的表:地址解析(对照 Node URL)、路由、分诊结论、换线顺序、直播源
//  ③ 整条链在沙箱里真跑(假 Hls / 假 <video> / 假 XHR / 假时钟):worker 路由、封 worker 记账直连、http 走 worker、线路代理、
//     0 分片 → 无过滤通道、worker 故障 → 备用 worker、源站封 worker → 直连 / 换线、没播起来换线 / 没这一集的跳过 / 全挂、
//     播起来后断了原地重来一次再报失败(不换线)、续播 seek、页面隐藏不判、Kazumi mp4/hls、片头自动跳 / 片尾只提示、
//     去插播 seek、小洞跳过、观看时长上报、销毁后不再动作、成对错误只换一次线;直播按顺序试源、卡住换源、全挂报错、手动换源
// 改 play.js 的路由 / 分诊 / 换线 / 片头逻辑后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const PLAY = fs.readFileSync(path.join(ROOT, 'public/tv/play.js'), 'utf8');
const CLIPCORE = fs.readFileSync(path.join(ROOT, 'public/libs/js/ad-clip-core.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b });

// ---------- 从 index.html 抽原件 ----------
function braceAt(src, open) {
    let depth = 0, q = null;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return null;
}
function member(marker) {
    const i = HTML.indexOf(marker);
    if (i < 0) return null;
    return braceAt(HTML, HTML.indexOf('{', i + marker.length - 1));
}
const introM = /\/\/ <dg-intro-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-intro-core>/.exec(HTML);
const holeM = /\/\/ <dg-hole-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-hole-core>/.exec(HTML);
if (!introM || !holeM) { console.log('✗ index.html 里找不到 <dg-intro-core> / <dg-hole-core>'); process.exit(1); }
const orig = {};
{
    const c1 = vm.createContext({});
    vm.runInContext(introM[1] + '\n;globalThis.__core = IntroCore;', c1);
    orig.Intro = c1.__core;
    const c2 = vm.createContext({ performance: { now: () => 0 } });
    vm.runInContext(holeM[1] + '\n;globalThis.__t = dgHoleTarget;', c2);
    orig.holeTarget = c2.__t;
    const cls = member('const classify = (pr) => {');
    orig.classify = new Function('pr', cls.slice(1, -1));
    const kz = member('_kzWorkerOk() {');
    orig.kzWorkerOk = new Function('location', kz.slice(1, -1));
    const el = member('epLabel(name) {');
    orig.epLabel = new Function('name', el.slice(1, -1));
    const sm = HTML.indexOf('window.skipManager = {'), r0 = HTML.indexOf('let reg = null;', sm), r1 = HTML.indexOf('if (reg) {', r0);
    orig.region = new Function('cur', 'time', 'dur', 'v', 'IntroCore', 'const L = 6;\n' + HTML.slice(r0, r1) + '\nreturn reg;');
}

// ---------- 沙箱 ----------
const BASE = Date.UTC(2026, 10, 27, 4, 0, 0);
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const ranges = (arr) => ({ length: arr.length, start: i => arr[i][0], end: i => arr[i][1] });
const EV = {
    MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError', DESTROYING: 'hlsDestroying', FRAG_LOADING: 'hlsFragLoading', LEVEL_LOADED: 'hlsLevelLoaded',
    FRAG_PARSED: 'hlsFragParsed', FRAG_PARSING_INIT_SEGMENT: 'hlsFragParsingInitSegment', INIT_PTS_FOUND: 'hlsInitPtsFound',
    BUFFER_FLUSHING: 'hlsBufferFlushing', BUFFER_FLUSHED: 'hlsBufferFlushed'
};
const M3U8_OK = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n#EXT-X-ENDLIST\n';
const M3U8_EMPTY = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST\n';

function makeEnv(o = {}) {
    const env = { clock: 0, timers: new Map(), seq: 0, hls: [], xhrs: [], http: [], status: [], fails: [], switches: [], skips: [], started: 0, sources: [], ended: 0 };
    const store = new Map(Object.entries(o.ls || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    env.store = store;
    const localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(BASE + env.clock); } static now() { return BASE + env.clock; } }
    const setTimeout_ = (f, ms) => { const id = ++env.seq; env.timers.set(id, { f, at: env.clock + Math.max(0, +ms || 0), every: 0 }); return id; };
    const setInterval_ = (f, ms) => { const id = ++env.seq; env.timers.set(id, { f, at: env.clock + ms, every: ms }); return id; };
    const clear_ = id => { env.timers.delete(id); };
    const net = o.net || (() => ({ status: 200, txt: M3U8_OK }));
    class FakeXHR {
        open(m, u) { this.method = m; this.url = u; this.readyState = 1; }
        setRequestHeader() { }
        abort() { this.aborted = true; }
        send() {
            env.xhrs.push(this.url);
            const r = net(this.url);
            if (r === 'hang') return;
            setImmediate(() => {
                if (this.aborted) return;
                this.readyState = 4; this.status = r === 'neterr' ? 0 : r.status; this.responseText = (r && r.txt) || ''; this.responseURL = (r && r.url) || this.url;
                if (this.onreadystatechange) this.onreadystatechange();
            });
        }
    }
    class FakeHls {
        static isSupported() { return o.mse !== false; }
        constructor(cfg) { this.config = Object.assign({ maxBufferLength: 30 }, cfg); this.h = {}; this.media = null; this.levels = []; this.currentLevel = 0; env.hls.push(this); }
        on(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); }
        off(ev, f) { const a = this.h[ev] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
        trigger(ev, d) {
            (this.h[ev] || []).slice().forEach(f => f(ev, d));
            if (ev === EV.BUFFER_FLUSHING) { this.flushed = d; this.trigger(EV.BUFFER_FLUSHED, { type: 'audio' }); this.trigger(EV.BUFFER_FLUSHED, { type: 'video' }); }
        }
        loadSource(u) { this.url = u; }
        attachMedia(v) { this.media = v; v.setAttribute('src', 'blob:hls' + env.hls.length); }
        destroy() { this.trigger(EV.DESTROYING); this.destroyed = true; if (this.media) { this.media.removeAttribute('src'); } this.media = null; }
        stopLoad() { this.stopped = true; }
    }
    FakeHls.Events = EV;
    class FakeVideo {
        constructor() { this.ls = {}; this.attrs = {}; this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.paused = true; this.muted = false; this.error = null; this.seeking = false; this.ended = false; this.playbackRate = 1; this.buffered = ranges([]); }
        addEventListener(ev, f) { (this.ls[ev] = this.ls[ev] || []).push(f); }
        removeEventListener(ev, f) { const a = this.ls[ev] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
        dispatchEvent(e) { this.fire(e.type); return true; }
        fire(type) { (this.ls[type] || []).slice().forEach(f => f({ type })); }
        get src() { return this.attrs.src || ''; }
        set src(v) { this.attrs.src = String(v); this.readyState = 0; this.error = null; }
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
        setAttribute(k, v) { this.attrs[k] = String(v); }
        removeAttribute(k) { delete this.attrs[k]; }
        load() { this.readyState = 0; this.currentTime = 0; this.duration = NaN; this.error = null; this.buffered = ranges([]); }
        play() { this.paused = false; return Promise.resolve(); }
        pause() { this.paused = true; }
        listenerCount() { return Object.values(this.ls).reduce((a, b) => a + b.length, 0); }
    }
    const doc = { hidden: false, ls: {}, addEventListener(ev, f) { (this.ls[ev] = this.ls[ev] || []).push(f); }, removeEventListener() { }, createEvent: () => ({ initEvent(t) { this.type = t; } }) };
    const httpStub = (url, opt) => {
        env.http.push({ url, opt });
        const r = o.http ? o.http(url, opt) : null;
        if (r instanceof Error) return Promise.reject(r);
        if (r === 'hang') return new Promise(() => { });
        return Promise.resolve(r == null ? {} : r);
    };
    const proxies = o.proxies || ['https://w1.example', 'https://w2.example'];
    const api = Object.assign({
        cfg: o.cfg || {},
        proxy: () => proxies[0] || '', proxies: () => proxies.slice(),
        adFilterOn: () => o.adOn !== false,
        loadEps: (line) => Promise.resolve(line.eps || []),
        matchEp: (line, name, fb) => { const i = (line.eps || []).findIndex(e => e.name === name); return i >= 0 ? i : fb; },
        token: () => o.token || ''
    }, o.api || {});
    const TV = {
        store: {
            get(k, def) { const v = localStorage.getItem(k); if (v == null) return def; try { return JSON.parse(v); } catch (e) { return v; } },
            raw: k => localStorage.getItem(k), set(k, v) { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); }, del: k => localStorage.removeItem(k)
        },
        each(arr, fn) { for (let i = 0; i < (arr ? arr.length : 0); i++) fn(arr[i], i); },
        log() { }, http: httpStub, api
    };
    const host = o.host || 'ednovas.video', proto = o.proto || 'https:';
    const sb = {
        TV, localStorage, Date: FakeDate, setTimeout: setTimeout_, setInterval: setInterval_, clearTimeout: clear_, clearInterval: clear_,
        performance: { now: () => env.clock }, XMLHttpRequest: FakeXHR, Hls: FakeHls, document: doc, console,
        navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 7.1.2; Phicomm T1 Build/NHG47K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/52.0.2743.100 Safari/537.36', onLine: true },
        location: { protocol: proto, hostname: host, href: proto + '//' + host + '/tv/', origin: proto + '//' + host },
        addEventListener() { }, removeEventListener() { }
    };
    sb.window = sb;
    const ctx = vm.createContext(sb);
    if (o.clip) vm.runInContext(CLIPCORE, ctx, { filename: 'ad-clip-core.js' });
    vm.runInContext(PLAY, ctx, { filename: 'play.js' });
    env.ctx = ctx; env.TV = TV; env.P = TV.play; env.doc = doc; env.api = api;
    env.video = new FakeVideo();
    env.FakeVideo = FakeVideo;
    env.advance = async (ms) => {
        const end = env.clock + ms;
        for (; ;) {
            let best = null, bid = 0;
            for (const [id, t] of env.timers) if (t.at <= end && (!best || t.at < best.at || (t.at === best.at && id < bid))) { best = t; bid = id; }
            if (!best) break;
            env.clock = best.at;
            if (best.every) best.at += best.every; else env.timers.delete(bid);
            best.f();
            await settle(3);
        }
        env.clock = end;
        await settle();
    };
    env.opts = (extra) => Object.assign({
        onStatus: t => env.status.push(t), onFail: m => env.fails.push(m), onSwitchLine: (i, m, e) => env.switches.push([i, m, e]),
        onStarted: () => env.started++, onSkip: s => env.skips.push(s), onSource: (i, n) => env.sources.push([i, n])
    }, extra || {});
    env.lastHls = () => env.hls[env.hls.length - 1];
    // 让当前 <video> 像是真的播起来了
    env.play = (t, dur) => { const v = env.video; v.duration = dur || 2600; v.readyState = 4; v.currentTime = t || 0; v.paused = false; v.buffered = ranges([[0, v.duration]]); v.fire('loadedmetadata'); v.fire('playing'); };
    return env;
}
const enc = encodeURIComponent;
const lsGet = (e, k) => { const v = e.store.get(k); try { return v == null ? null : JSON.parse(v); } catch (x) { return v; } };
const mkWork = () => ({
    title: '测试剧',
    lines: [
        { name: '线路A', key: 'siteA', test: 'direct', latency: 300, eps: [{ name: '第1集', url: 'https://cdn-a.example/1/index.m3u8' }, { name: '第2集', url: 'https://cdn-a.example/2/index.m3u8' }] },
        { name: '线路B', key: 'siteB', test: 'proxy', latency: 400, eps: [{ name: '第1集', url: 'https://cdn-b.example/1.m3u8' }, { name: '第2集', url: 'https://cdn-b.example/2.m3u8' }] },
        { name: '线路C', key: 'siteC', test: 'direct', latency: 500, eps: [{ name: '第2集', url: 'https://cdn-c.example/2.m3u8' }] }
    ]
});
const W1 = 'https://w1.example', W2 = 'https://w2.example';
const RAW_A1 = 'https://cdn-a.example/1/index.m3u8';

// ======================================================================
console.log('① 和 index.html 原件对照');
const P0 = makeEnv().P._pure;
{
    const lists = [
        ['第1集', '第2集', '第3集', '第12集大结局'],
        ['01', '02', '03', '10'], ['EP01', 'EP02', 'ep 3'], ['HD中字'], ['正片'], ['HD', 'TC'], ['第一集', '第二集', '第十集', '第二十一集', '第一百集'],
        ['第1集 幕后黑手', '第2集', '第3集'], ['上', '下'], ['第5期加更', '第5期', '第6期'],
        ['20250927日常篇', '20250927', '20251004', '20251011'],
        ['第1期上', '第1期下', '第1期纯享版', '第2期上', '第2期下', '先导片'],
        ['20220819(第1期上)', '20220819(第1期下)', '20220826(第2期上)'],
        ['第20201217(上)期', '第20201217(下)期', '第20201224(上)期'],
        ['披荆斩棘的哥哥20210813下', '披荆斩棘的哥哥20210813上', '披荆斩棘的哥哥20210820上'],
        ['2021-08-12期', '2021-08-12期', '2021-08-19期'],
        ['第1期 喜人夜聊', '第1期', '第2期'], ['20251127陈伟霆', '20251127', '20251204'], ['第2023012期', '2024110上', '240906上'],
        ['会员版第3集', '第3集', '第4集'], ['第1话', '第2話', '第3话 特别篇'], ['先导片', '第1集', '第2集', '预告'],
        ['2024年8月12日', '2024年8月19日'], ['歌手2025第1期', '歌手2025第2期'], ['​第1集 ', '第2集'], ['plus版', 'Reaction', '彩蛋']
    ];
    let n = 0, bad = [];
    for (const names of lists) {
        const list = names.map((name, i) => ({ name, url: (names[0] === '2021-08-12期' && i < 2) ? 'u' + i : 'u' + i }));
        const a = JSON.stringify(P0.epInfos(list)), b = JSON.stringify(orig.Intro.epInfos(list));
        n++; if (a !== b) bad.push({ names, mine: a, orig: b });
        for (const nm of names) { const x = JSON.stringify(P0.parseEpName(nm)), y = JSON.stringify(orig.Intro.parseEpName(nm)); n++; if (x !== y) bad.push({ nm, mine: x, orig: y }); }
    }
    // 同一集号两个地址:都不当正片
    const dup = [{ name: '第1集', url: 'a' }, { name: '第1集', url: 'b' }, { name: '第2集', url: 'c' }];
    n++; if (JSON.stringify(P0.epInfos(dup)) !== JSON.stringify(orig.Intro.epInfos(dup))) bad.push('dup');
    ok(!bad.length, `epInfos / parseEpName 与 IntroCore 一致(${n} 组)`, bad.slice(0, 3));
    const marks = [{}, { mv: 2 }, { mv: 2, pend: 1 }, { mv: 2, miss: 1 }, { mv: 1 }, { src: 'afp' }, { mv: 2, bmv: 3, bs: 0, be: 8 }, { mv: 2, bmv: 2, bs: 0, be: 8 }, { mv: 2, bmv: 3, bs: 40, be: 50 }, { bs: 5, be: 5 }, null, { os: 10, oe: 90, ed: 2400, emv: 2 }];
    let bad2 = [];
    for (const m of marks) for (const f of ['opAuto', 'bumpAuto', 'bumpShow']) if (P0[f](m) !== orig.Intro[f](m)) bad2.push([f, m]);
    for (const m of marks) if (m && JSON.stringify(P0.curOf(m)) !== JSON.stringify(orig.Intro.curOf(m))) bad2.push(['curOf', m]);
    ok(!bad2.length, 'opAuto / bumpAuto / bumpShow / curOf 与 IntroCore 一致', bad2.slice(0, 3));
}
{
    // skipManager.check 的区间选择(提前 6s、三个区间各一次、片尾只按钮)
    const curs = [
        { os: 60, oe: 150, mv: 2, bs: 0, be: 0, ed: 2500 }, { os: 60, oe: 150, mv: 2, pend: 1, bs: 0, be: 0, ed: 0 }, { os: 0, oe: 0, bs: 2, be: 12, bmv: 3, mv: 2, ed: 0 },
        { os: 20, oe: 110, bs: 0, be: 8, bmv: 2, mv: 2, ed: 2400 }, { os: 0, oe: 0, bs: 40, be: 52, bmv: 3, mv: 2, ed: 0 }, { os: 300, oe: 380, mv: 1, ed: 0 }
    ];
    let bad = [], n = 0;
    for (const raw of curs) {
        const cur = orig.Intro.curOf(raw);
        for (const fl of [{}, { bump: true }, { op: true }, { outro: true }, { bump: true, op: true }]) {
            const v = { _bumpSkipped: !!fl.bump, _introSkipped: !!fl.op, _outroSkipped: !!fl.outro, _outroNextEp: () => true };
            for (let t = 0; t <= 2600; t += (t < 400 ? 0.5 : 7)) {
                const a = orig.region(cur, t, 2600, v, orig.Intro), b = P0.skipRegion(cur, t, 2600, fl);
                const A = a ? [a.kind, a.start, a.to, !!a.ok, !!a.in] : null, B = b ? [b.kind, b.start, b.to, !!b.ok, !!b.inside] : null;
                n++; if (JSON.stringify(A) !== JSON.stringify(B)) { bad.push({ raw, fl, t, A, B }); break; }
            }
        }
    }
    ok(!bad.length, `skipRegion 与 skipManager.check 的区间选择一致(${n} 点)`, bad.slice(0, 2));
}
{
    let bad = [], n = 0;
    const rnd = (s => () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)(7);
    for (let k = 0; k < 3000; k++) {
        const segs = [], cnt = 1 + Math.floor(rnd() * 4);
        let x = rnd() * 3;
        for (let i = 0; i < cnt; i++) { const s = x, e = s + rnd() * 4; segs.push([+s.toFixed(3), +e.toFixed(3)]); x = e + (rnd() < 0.5 ? rnd() * 0.4 : rnd() * 3); }
        const t = +(rnd() * (x + 1)).toFixed(3);
        const a = P0.holeTarget(t, ranges(segs)), b = orig.holeTarget(t, ranges(segs));
        n++; if (a !== b) bad.push({ t, segs, a, b });
    }
    for (const t of [NaN, Infinity, undefined]) { n++; if (P0.holeTarget(t, ranges([[0, 1]])) !== orig.holeTarget(t, ranges([[0, 1]]))) bad.push(t); }
    ok(!bad.length, `holeTarget 与 dgHoleTarget 一致(${n} 例)`, bad.slice(0, 2));
    eq(P0.HOLE, { POLL: 250, STILL: 350, TAIL: 0.3, NEAR: 1, PAD: 0.01 }, '小洞参数与 DG_HOLE 相同');
    ok(holeM[1].includes('const DG_HOLE = { POLL: 250, STILL: 350, TAIL: 0.3, NEAR: 1, PAD: 0.01 };'), 'index.html 的 DG_HOLE 没变');
}
{
    const prs = [{ status: 200, ok: true, txt: M3U8_OK }, { status: 200, ok: true, txt: M3U8_EMPTY }, { status: 200, ok: true, txt: '<html>' }, { status: 503, ok: false, txt: '' },
        { status: 429, ok: false, txt: '' }, { status: 403, ok: false, txt: '' }, { status: 404, ok: false, txt: '' }, { status: 451, ok: false, txt: '' }, { status: 400, ok: false, txt: '' }, { status: 302, ok: false, txt: '' }, { status: 500, ok: false, txt: '' }];
    ok(prs.every(p => P0.classify(p) === orig.classify(p)), 'classify 与播放页分诊一致', prs.map(p => [P0.classify(p), orig.classify(p)]));
    const hosts = ['ednovas.video', 'localhost', '127.0.0.1', '10.0.0.2', '192.168.1.5', '172.16.0.1', '172.32.0.1', '0.0.0.0', '[::1]', 'box.local', 'nas.lan', 'a.internal', 'LOCALHOST', '', 'tv.example.com'];
    ok(hosts.every(h => P0.kzWorkerOk(h) === orig.kzWorkerOk({ hostname: h })), '_kzWorkerOk 一致', hosts.map(h => [h, P0.kzWorkerOk(h), orig.kzWorkerOk({ hostname: h })]));
    const names = ['第06集', '第6集', '06', 'EP6', 'ep.12', '第3期', '0624', '20240624期', '第1集上', '正片', '', null, ' 第 7 话 ', '第1234集'];
    ok(names.every(x => P0.epLabel(x) === orig.epLabel(x)), 'epLabel 与 watchMeter 一致', names.map(x => [x, P0.epLabel(x), orig.epLabel(x)]));
}
{
    // 规则原文:网页这边改了就提醒电视版跟着改
    const pins = [
        ["const isDirectM3U8 = ((url && url.includes('.m3u8')) || kzHls) && !(this.currentSource && this.currentSource._useProxy)", '路由:m3u8 或 kz hls、线路没走代理才套 worker'],
        ["return (/[?&]url=/.test(u) && !/[?&]nofilter=1/.test(u)) ? 'f' : 'r';", '时间轴通道 f / r'],
        ['return !!(m[siteKey] && Date.now() - m[siteKey] < 12 * 3600 * 1000);', '源站封 worker 记账 12h'],
        ['if (ks.length > 60) ks.sort((a, b) => m[a] - m[b]).slice(0, ks.length - 60).forEach(k => delete m[k]);', '记账最多 60 站'],
        ['const hasContent = !v.error && (v.readyState >= 3 || (v.currentTime || 0) > 0.1 || (v.buffered && v.buffered.length > 0));', '起播看门狗判据'],
        ['if (t > 1 && (!isFinite(v.duration) || t < v.duration - 3))', '续播 seek 条件'],
        ['fragLoadingMaxRetry: 2, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2', '快速失败的重试次数'],
        ['backBufferLength: 90, maxMaxBufferLength: 120', 'hls 缓冲配置'],
        ['COOLDOWN: 1500, MAX_ACTIONS: 30, MAX_ATTEMPTS: 2, BIG_BUFFER: 75', '去插播常量'],
        ['return m[this._introMarkKey(ep, part)] || (part ? null : m[ep]) || null;', '片头标记键:没有部分才退回裸集号'],
        ['if (mk && (mk.oe > mk.os || mk.ed > 0)) this._introCur = IntroCore.curOf(mk);', '标记要有片头或片尾才用'],
        ["if (source === 'emptyPlaylist' && cls === 'ok') cls = 'stripped';", '0 分片 + 探测正常 = 清空'],
        ["else if (d.details === 'levelEmptyError') this._onErr(tok, 'empty');", '0 分片清单的非致命错要接']
    ];
    for (const [s, what] of pins) ok(HTML.includes(s), 'index.html 仍是:' + what);
    ok(PLAY.includes('backBufferLength: 90, maxMaxBufferLength: 120, fragLoadingMaxRetry: 2, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2'), 'play.js 的 hls 配置同值');
    ok(PLAY.includes('COOLDOWN: 1500, MAX_ACTIONS: 30, MAX_ATTEMPTS: 2, BIG_BUFFER: 75'), 'play.js 的去插播常量同值');
    ok(!/canPlayType/.test(PLAY.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'play.js 不靠 canPlayType 选通道');
    ok(PLAY.includes("'donggua_adproxy_bad2'") && PLAY.includes("'donggua_site_health2'") && PLAY.includes("'donggua_adclip_off'"), '和网页共用同一批 localStorage 键');
}

// ======================================================================
console.log('② 纯函数表');
{
    const bases = ['https://a.example/x/y/index.m3u8?k=1', 'https://a.example/', 'http://b.example:8080/p/q.m3u8', 'https://c.example/a/b/c'];
    const rels = ['seg.ts', '/abs/seg.ts', '../up.ts', './here.ts', '//cdn.example/z.ts', 'https://full.example/f.ts', '?q=2', 'a/../../b.ts', 'sub/dir/file.m3u8?x=1#h', '../../../../x.ts'];
    const bad = [];
    for (const b of bases) for (const r of rels) { const mine = P0.resolveUrl(r, b), want = new URL(r, b).href; if (mine !== want) bad.push({ r, b, mine, want }); }
    ok(!bad.length, 'resolveUrl 和 Node 的 URL 一致', bad.slice(0, 3));
    eq(P0.resolveUrl('/api/kz/mp4/a/b', 'https://ednovas.video/tv/'), 'https://ednovas.video/api/kz/mp4/a/b', 'Kazumi 相对地址补全成本站');
}
{
    const R = (o) => P0.routeOf(Object.assign({ raw: RAW_A1, kz: '', line: { key: 's' }, proxy: W1, adOn: true, adBad: false, kzOk: true, https: true }, o));
    eq(R({}), { route: 'worker', url: W1 + '/?url=' + enc(RAW_A1) }, 'm3u8 + 去广告开 + 有 worker → worker');
    eq(R({ adBad: true }).route, 'direct', '源站封 worker 的站 → 直连');
    eq(R({ adOn: false }).route, 'direct', '去广告关 → 直连');
    eq(R({ proxy: '' }).route, 'direct', '没 worker → 直连');
    eq(R({ raw: 'https://a.example/v.mp4' }).route, 'direct', '不是 m3u8 不套 worker');
    eq(R({ line: { useProxy: true, proxyUrl: 'https://lp.example' } }), { route: 'lineproxy', url: 'https://lp.example/?url=' + enc(RAW_A1) }, '线路要代理 → proxyUrl/?url=,不再套 worker');
    eq(R({ raw: 'http://h.example/v.m3u8' }), { route: 'worker', url: W1 + '/?url=' + enc('http://h.example/v.m3u8') }, 'https 页的 http m3u8 → worker');
    eq(R({ raw: 'http://h.example/v.m3u8', adOn: false }), { route: 'nofilter', url: W1 + '/?nofilter=1&url=' + enc('http://h.example/v.m3u8') }, 'https 页的 http 地址、去广告关 → worker 无过滤通道');
    eq(R({ raw: 'http://h.example/v.mp4' }).route, 'nofilter', 'https 页的 http mp4 → worker 无过滤通道');
    eq(R({ raw: 'http://h.example/v.m3u8', https: false, adOn: false }).route, 'direct', 'http 页上的 http 地址照常直连');
    eq(R({ raw: 'https://ednovas.video/api/kz/m3u8/s/t.m3u8', kz: 'hls' }).route, 'worker', 'Kazumi hls 套 worker');
    eq(R({ raw: 'https://ednovas.video/api/kz/m3u8/s/t.m3u8', kz: 'hls', kzOk: false }).route, 'direct', '本地开发 worker 拉不到本站:Kazumi hls 不套');
    eq(R({ raw: 'https://ednovas.video/api/kz/mp4/s/t', kz: 'mp4' }).route, 'direct', 'Kazumi mp4 不套');
    eq([P0.channelOf(W1 + '/?url=x'), P0.channelOf(W1 + '/?nofilter=1&url=x'), P0.channelOf(RAW_A1), P0.channelOf('https://lp.example/?url=x')], ['f', 'r', 'r', 'f'], '时间轴通道');
}
{
    const D = (cls, why, c) => P0.decideTriage(cls, why, Object.assign({ retried: false, directOK: true, canDirect: true }, c));
    eq(D('ok', 'hls:x').act, 'retry', '正常 → 经 worker 重试一次');
    eq(D('ok', 'empty').act, 'nofilter', 'hls 看到 0 分片而探测正常 → 按清空');
    eq(D('ok', 'hls:x', { retried: true }).act, 'direct', '重试过还不行 → 直连');
    eq(D('ok', 'hls:x', { retried: true, directOK: false }).act, 'next', '重试过、直连本来就不通 → 换线');
    eq(D('stripped', 'x').act, 'nofilter', '清空 → 无过滤通道');
    ok(!D('stripped', 'x').mark && !D('workerdown', 'x').mark, '清空 / worker 故障都不记账');
    eq(D('workerdown', 'x').act, 'backup', 'worker 故障 → 备用 worker');
    eq([D('siteblock', 'x').act, D('siteblock', 'x').mark], ['direct', true], '源站封 worker + 直连可达 → 记账直连');
    eq([D('siteblock', 'x', { directOK: false }).act, D('siteblock', 'x', { directOK: false }).mark], ['next', true], '源站封 worker + 直连不通 → 记账换线');
    eq(D('siteblock', 'x', { canDirect: false }).act, 'next', 'https 页上的 http 源不能直连 → 换线');
    eq(P0.failoverOrder(5, 2, { 3: 1 }), [4, 0, 1], '换线绕一圈、跳过失败的');
    eq(P0.failoverOrder(1, 0, {}), [], '只有一条线路');
    const t0 = 1e12;
    ok(P0.adBadGet({ s: t0 - 3600e3 }, 's', t0) && !P0.adBadGet({ s: t0 - 13 * 3600e3 }, 's', t0) && !P0.adBadGet(null, 's', t0), '记账 12h 内有效');
    const big = {}; for (let i = 0; i < 70; i++) big['k' + i] = t0 + i;
    const after = P0.adBadMark(big, 'new', t0 + 1000);
    ok(Object.keys(after).length === 60 && after.new && !after.k0 && after.k69, '记账超 60 站剪掉最旧的', Object.keys(after).length);
    eq(P0.liveTarget('https://l.example/a.m3u8', W1, true), { url: 'https://l.example/a.m3u8', test: false }, '直播 https 直接放');
    eq(P0.liveTarget('http://l.example/a.m3u8', W1, true), { url: W1 + '/?url=' + enc('http://l.example/a.m3u8'), test: true }, '直播 http 经 worker,先测');
    eq(P0.liveTarget('http://l.example/a.m3u8', '', true), null, '直播 http、没 worker、https 页 → 放不了');
    ok(P0.shouldSeek(100, 2000) && !P0.shouldSeek(1998, 2000) && P0.shouldSeek(100, NaN) && !P0.shouldSeek(0.5, 2000), '续播条件');
    const mk = { '3|f': { os: 1, oe: 80, mv: 2 }, '3|r': { os: 5, oe: 70 }, '4': { os: 2, oe: 60 }, '5|f|1': { os: 3, oe: 50 }, '5': { os: 9, oe: 99 }, '6|f': { ed: 2000 } };
    eq([P0.markFor(mk, 3, 'f', 0).oe, P0.markFor(mk, 3, 'r', 0).oe, P0.markFor(mk, 4, 'f', 0).oe, P0.markFor(mk, 5, 'f', 1).oe, P0.markFor(mk, 5, 'f', 2), P0.markFor(mk, 6, 'f', 0).ed], [80, 70, 60, 50, null, 2000], '标记按 集|通道|部分 取;有部分的不退回裸集号');
}

// ======================================================================
console.log('③ 沙箱里整条链');
const tests = [];
const T = (name, fn) => tests.push([name, fn]);

T('默认走 worker,通道 f', async () => {
    const e = makeEnv(); const w = mkWork();
    const s = e.P.open(e.video, e.opts({ work: w, line: w.lines[0], lineIdx: 0, ep: 0 }));
    await settle();
    eq(e.lastHls().url, W1 + '/?url=' + enc(RAW_A1), 'hls 拉的是 worker 地址');
    eq([s.route(), s.channel()], ['worker', 'f'], '会话报 worker / f');
    eq(e.lastHls().config.backBufferLength, 90, 'hls 配置带 backBufferLength 90');
    ok(e.lastHls().media === e.video, 'attachMedia 到同一个 <video>');
});
T('源站封 worker 的站直连', async () => {
    const e = makeEnv({ ls: { donggua_adproxy_bad2: { siteA: BASE - 3600e3 } } }); const w = mkWork();
    const s = e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    eq([e.lastHls().url, s.channel()], [RAW_A1, 'r'], '直连、通道 r');
});
T('https 页的 http 分片在 xhrSetup 里改走 worker', async () => {
    const e = makeEnv(); const w = mkWork();
    w.lines[0].eps[0].url = 'http://cdn-h.example/1.m3u8';
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    const cfg = e.lastHls().config, x1 = { readyState: 0, open(m, u) { this.u = u; this.readyState = 1; } }, x2 = { readyState: 0, open(m, u) { this.u = u; } };
    cfg.xhrSetup(x1, 'http://cdn-h.example/seg1.ts');
    cfg.xhrSetup(x2, 'https://cdn-s.example/seg1.ts');
    eq([x1.u, x2.u], [W1 + '/?nofilter=1&url=' + enc('http://cdn-h.example/seg1.ts'), undefined], 'http 分片改走 worker,https 不动');
    eq(e.lastHls().url, W1 + '/?url=' + enc('http://cdn-h.example/1.m3u8'), 'http 清单经 worker(去广告)');
});
T('线路代理', async () => {
    const e = makeEnv(); const w = mkWork();
    Object.assign(w.lines[0], { useProxy: true, proxyUrl: 'https://lp.example' });
    const s = e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    eq([e.lastHls().url, s.route()], ['https://lp.example/?url=' + enc(RAW_A1), 'lineproxy'], 'proxyUrl/?url=');
});
T('0 分片清单 → 无过滤通道(不记账)', async () => {
    const e = makeEnv({ net: u => u.startsWith(W1 + '/?url=') ? { status: 200, txt: M3U8_EMPTY } : { status: 200, txt: M3U8_OK } });
    const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.lastHls().trigger(EV.MANIFEST_PARSED, { levels: [{}] });
    e.lastHls().trigger(EV.ERROR, { fatal: false, details: 'levelEmptyError' });
    e.lastHls().trigger(EV.ERROR, { fatal: false, details: 'levelEmptyError' });
    await settle(20);
    eq(e.hls.length, 2, '只换了一次地址');
    eq(e.lastHls().url, W1 + '/?nofilter=1&url=' + enc(RAW_A1), '换到 nofilter');
    ok(!lsGet(e, 'donggua_adproxy_bad2'), '没记账');
    ok(e.hls[0].destroyed, '旧实例已销毁');
    eq(e.switches.length, 0, '没换线');
});
T('worker 故障 → 备用 worker,本次会话换过去', async () => {
    const e = makeEnv({ net: u => u.startsWith(W1) ? { status: 503, txt: '' } : { status: 200, txt: M3U8_OK } });
    const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.lastHls().trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    await settle(20);
    eq(e.lastHls().url, W2 + '/?url=' + enc(RAW_A1), '走备用 worker');
    eq(e.P.status().proxy, W2, '之后都用备用的');
    ok(!lsGet(e, 'donggua_adproxy_bad2'), 'worker 自己的故障不记账');
});
T('worker 故障、没有备用 → 直连(不记账)', async () => {
    const e = makeEnv({ proxies: [W1], net: u => u.startsWith(W1) ? 'neterr' : { status: 200, txt: M3U8_OK } });
    const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.lastHls().trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    await settle(20);
    eq(e.lastHls().url, RAW_A1, '直连兜底');
    ok(!lsGet(e, 'donggua_adproxy_bad2'), '不记账');
});
T('源站封 worker + 直连可达 → 记账直连', async () => {
    const e = makeEnv({ net: u => u.startsWith(W1) ? { status: 403, txt: '' } : { status: 200, txt: M3U8_OK } });
    const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.lastHls().trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    await settle(20);
    eq(e.lastHls().url, RAW_A1, '直连');
    ok(!!(lsGet(e, 'donggua_adproxy_bad2') || {}).siteA, '记了 siteA');
    eq(e.switches.length, 0, '没换线');
});
T('源站封 worker + 直连不通 → 换线(记账),新线路对上同一集', async () => {
    const e = makeEnv({ net: u => u.indexOf(enc('https://cdn-b.example')) >= 0 ? { status: 403, txt: '' } : { status: 200, txt: M3U8_OK } });
    const w = mkWork();
    const s = e.P.open(e.video, e.opts({ work: w, lineIdx: 1, ep: 1 }));
    await settle();
    e.lastHls().trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    await settle(20);
    eq(e.switches, [[2, '「线路B」放不了,换到「线路C」', 0]], '换到线路C 的第2集(下标 0)');
    eq([s.lineIdx(), s.epIdx()], [2, 0], '会话的线路 / 集跟着变');
    ok(!!(lsGet(e, 'donggua_adproxy_bad2') || {}).siteB, '记了 siteB');
    eq(e.lastHls().url, W1 + '/?url=' + enc('https://cdn-c.example/2.m3u8'), '新线路照常走 worker');
});
T('没播起来:看门狗 14s → 换线;没有这一集的线路跳过;都不行报全挂', async () => {
    const e = makeEnv(); const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.lastHls().trigger(EV.MANIFEST_PARSED, { levels: [{}] });
    await e.advance(13000);
    eq(e.switches.length, 0, '13s 还不判');
    await e.advance(1500);
    eq(e.switches.map(x => x[0]), [1], '14s 换到线路B');
    eq(w.lines[0].latency, 9998, '失败线路记 9998');
    e.lastHls().trigger(EV.MANIFEST_PARSED, { levels: [{}] });
    await e.advance(15000);
    eq(e.switches.map(x => x[0]), [1], '线路C 没有第1集,不换过去');
    eq(e.fails, ['所有线路都放不了'], '报全挂');
});
T('播起来后断了:原地重来一次,再断报失败,不换线', async () => {
    const e = makeEnv(); const w = mkWork();
    const s = e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0, at: 0 }));
    await settle();
    const h0 = e.lastHls();
    h0.trigger(EV.MANIFEST_PARSED, { levels: [{}] });
    e.play(300, 2600);
    eq(e.started, 1, 'onStarted 一次');
    h0.trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadError' });
    e.video.fire('error');   // video 没 error 对象:忽略
    await settle();
    eq(e.hls.length, 2, '重来了一次');
    eq(e.lastHls().url, h0.url, '同一条路由');
    e.video.duration = 2600; e.video.readyState = 1; e.video.fire('loadedmetadata');
    eq(e.video.currentTime, 300, '回到断的位置');
    e.lastHls().trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadError' });
    await settle();
    eq(e.fails, ['播放中断了,网络可能不太好'], '报失败');
    eq(e.switches.length, 0, '没悄悄换线');
    ok(e.lastHls().stopped && !e.lastHls().destroyed, '停止加载但不摘地址(重试要读位置)');
    ok(s.time() >= 299, '会话 time() 给出断点', s.time());
});
T('续播:loadedmetadata 时 seek,快到结尾不 seek', async () => {
    const e = makeEnv(); const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0, at: 100 }));
    await settle();
    e.video.duration = 2000; e.video.readyState = 1; e.video.fire('loadedmetadata');
    eq(e.video.currentTime, 100, '跳到 100s');
    const e2 = makeEnv(); const w2 = mkWork();
    e2.P.open(e2.video, e2.opts({ work: w2, lineIdx: 0, ep: 0, at: 1998.5 }));
    await settle();
    e2.video.duration = 2000; e2.video.readyState = 1; e2.video.fire('loadedmetadata');
    eq(e2.video.currentTime, 0, '离结尾 3s 内不跳');
});
T('页面隐藏时看门狗只等不判,回来再给满 14s', async () => {
    const e = makeEnv(); const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.doc.hidden = true;
    await e.advance(40000);
    eq([e.hls.length, e.switches.length, e.xhrs.length], [1, 0, 0], '隐藏 40s:没动作');
    e.doc.hidden = false;
    await e.advance(4000);
    eq(e.xhrs.length, 0, '回来后不立刻判');
    await e.advance(14000);
    ok(e.xhrs.length >= 1 && e.hls.length === 2, '满 14s 才分诊(探测正常 → 重试)', [e.xhrs.length, e.hls.length]);
});
T('Kazumi mp4:先解析,再用原生 <video> 播', async () => {
    const e = makeEnv({ http: u => u.indexOf('/api/kz/ep/') >= 0 ? { type: 'mp4', url: '/api/kz/mp4/qsf/t1' } : null });
    const w = { title: '番', lines: [{ name: '七色番', key: 'kz_qsf', eps: [{ name: '第1集', url: '/api/kz/ep/qsf/t1' }] }] };
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    eq(e.http[0].url, 'https://ednovas.video/api/kz/ep/qsf/t1', '问解析端点');
    eq(e.http[0].opt.timeout, 45000, '45s');
    eq([e.video.src, e.hls.length], ['https://ednovas.video/api/kz/mp4/qsf/t1', 0], 'mp4 直接 src,不建 hls');
});
T('Kazumi hls:解析出的清单套 worker;出错先强制重解析一次', async () => {
    let n = 0;
    const e = makeEnv({ http: u => u.indexOf('/api/kz/ep/') >= 0 ? (n++, { type: 'hls', url: '/api/kz/m3u8/dytt/t2.m3u8' }) : null });
    const w = { title: '番', lines: [{ name: '动漫巴士', key: 'kz_dm', eps: [{ name: '第1集', url: '/api/kz/ep/dm/t2' }] }] };
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    eq(e.lastHls().url, W1 + '/?url=' + enc('https://ednovas.video/api/kz/m3u8/dytt/t2.m3u8'), 'kz hls 经 worker');
    e.lastHls().trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    await settle();
    ok(n === 2 && /fresh=1/.test(e.http[1].url), '带 fresh=1 重解析', e.http.map(x => x.url));
});
T('片头:新算法标记到点自动跳;片尾只提示一次', async () => {
    const e = makeEnv({ http: u => u.startsWith('/api/intro/marks') ? { marks: { '1|f': { os: 60, oe: 150, mv: 2, ed: 2500 } } } : null });
    const w = mkWork();
    const s = e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.play(30, 2600);
    e.video.fire('timeupdate');
    await settle();
    ok(/^\/api\/intro\/marks\?title=%E6%B5%8B%E8%AF%95%E5%89%A7&site=siteA$/.test(e.http[0].url), '按 剧名 + 线路 取标记', e.http[0] && e.http[0].url);
    e.video.currentTime = 56; e.video.fire('timeupdate');
    eq(e.video.currentTime, 56, '提前期不跳');
    e.video.currentTime = 60.5; e.video.fire('timeupdate');
    eq(e.video.currentTime, 150, '进区间跳到片头结尾');
    eq(e.skips[0], { text: '已跳过片头', done: true, kind: 'op', to: 150 }, 'onSkip 已跳过');
    e.video.currentTime = 2497; e.video.fire('timeupdate');
    e.video.currentTime = 2500.5; e.video.fire('timeupdate');
    e.video.currentTime = 2502; e.video.fire('timeupdate');
    eq(e.skips.slice(1), [{ text: '片尾:按 ▶▶ 下一集', done: false, kind: 'outro' }], '片尾只提示一次、不跳');
    eq([e.video.currentTime, s.skipIntroNow()], [2502, 'outro'], 'skipIntroNow 在片尾区间回 outro');
    eq(e.http.filter(x => x.url.startsWith('/api/intro/marks')).length, 1, '标记只取一次');
});
T('片头:关了自动跳 / 待确认的标记只提示,skipIntroNow 手动跳', async () => {
    for (const [ls, mark, why] of [[{ tv_skip_intro: false }, { os: 60, oe: 150, mv: 2 }, '设置关'], [{}, { os: 60, oe: 150, mv: 2, pend: 1 }, '待确认']]) {
        const e = makeEnv({ ls, http: u => u.startsWith('/api/intro/marks') ? { marks: { '1|f': mark } } : null });
        const w = mkWork();
        const s = e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
        await settle();
        e.play(30, 2600); e.video.fire('timeupdate'); await settle();
        e.video.currentTime = 60.5; e.video.fire('timeupdate'); e.video.fire('timeupdate');
        eq([e.video.currentTime, e.skips], [60.5, [{ text: '片头:按 ▶▶ 跳过', done: false, kind: 'op', to: 150 }]], why + ':不自动跳,提示一次');
        eq([s.skipIntroNow(), e.video.currentTime], ['op', 150], why + ':手动跳过');
    }
});
T('片头:换源瞬间 t≈0 / 时长 NaN 不跳;变体集(纯享)不取标记', async () => {
    const e = makeEnv({ http: u => u.startsWith('/api/intro/marks') ? { marks: { '1|f': { os: 0, oe: 90, mv: 2 } } } : null });
    const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.play(0.5, 2600); e.video.fire('timeupdate'); await settle();
    e.video.currentTime = 0.8; e.video.fire('timeupdate');
    e.video.duration = NaN; e.video.currentTime = 5; e.video.fire('timeupdate');
    eq(e.video.currentTime, 5, 'NaN 时长不跳');
    const e2 = makeEnv({ http: () => ({ marks: { '1|f': { os: 0, oe: 90, mv: 2 } } }) });
    const w2 = { title: '综艺', lines: [{ name: 'A', key: 'sA', eps: [{ name: '第1期纯享版', url: 'https://a/1.m3u8' }, { name: '第1期', url: 'https://a/2.m3u8' }] }] };
    e2.P.open(e2.video, e2.opts({ work: w2, lineIdx: 0, ep: 0 }));
    await settle();
    e2.play(10, 2600); e2.video.fire('timeupdate'); await settle();
    eq(e2.http.length, 0, '纯享版不取标记');
});
T('去插播:分辨率突变的中插到点静默跳过(先删缓冲再 seek)', async () => {
    const e = makeEnv({ clip: true }); const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    const h = e.lastHls();
    const frags = []; let t = 0, sn = 0;
    for (const [cc, n, d] of [[0, 120, 5], [1, 4, 5], [2, 116, 5]]) for (let i = 0; i < n; i++) { frags.push({ sn: sn++, cc, start: t, duration: d }); t += d; }
    h.trigger(EV.MANIFEST_PARSED, { levels: [{}] });
    h.trigger(EV.LEVEL_LOADED, { details: { live: false, fragments: frags } });
    const res = { 0: [1080, 810], 1: [1280, 720], 2: [1080, 810] }, off = { 0: 1.4, 1: 1.45 - 600, 2: 1.4 - 20 };
    for (const cc of [0, 1, 2]) {
        const f = frags.find(x => x.cc === cc);
        h.trigger(EV.FRAG_LOADING, { frag: f });
        h.trigger(EV.FRAG_PARSING_INIT_SEGMENT, { id: 'main', frag: f, tracks: { video: { metadata: { width: res[cc][0], height: res[cc][1] } } } });
        h.trigger(EV.INIT_PTS_FOUND, { id: 'main', frag: f, initPTS: off[cc] * 90000, timescale: 90000 });
    }
    e.play(10, 1200);
    for (let x = 500; x <= 601; x += 0.25) { if (e.video.currentTime > x + 1) break; e.video.currentTime = x; e.video.fire('timeupdate'); }
    ok(e.video.currentTime >= 620 && e.video.currentTime < 621, '跳过 600~620 的中插', e.video.currentTime);
    ok(!!h.flushed && h.flushed.startOffset === 600 && h.flushed.endOffset === 620, '跳之前删掉那段缓冲', h.flushed);
    eq(e.skips.length, 0, '静默(不提示)');
});
T('缓冲小洞:卡在洞前 → 跳到下一段开头', async () => {
    const e = makeEnv(); const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.play(10, 2600);
    const v = e.video;
    v.readyState = 2; v.currentTime = 10.0; v.buffered = ranges([[0, 10.1], [10.25, 30]]);
    await e.advance(1000);
    eq(+v.currentTime.toFixed(2), 10.26, '跳到 10.26');
    v.currentTime = 20; v.readyState = 2; v.buffered = ranges([[0, 20.1], [25, 30]]);
    await e.advance(1000);
    eq(v.currentTime, 20, '下一段在 1s 外(网络欠载)不跳');
});
T('观看时长:watch_stats 开着才报,60s 一批', async () => {
    const e = makeEnv({ cfg: { watch_stats: true }, token: 'tok123' }); const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.play(100, 2600);
    for (let i = 0; i < 62; i++) { e.video.currentTime += 1; await e.advance(1000); }
    const post = e.http.find(x => x.url === '/api/stats/watch');
    ok(!!post, '发了 /api/stats/watch');
    const b = post && post.opt.body;
    ok(b && b.token === 'tok123' && /^[A-Za-z0-9_-]{8,40}$/.test(b.batch), 'token + 批次号格式', b && b.batch);
    ok(b && b.items.length === 1 && b.items[0].k === 'vod' && b.items[0].t === '测试剧' && b.items[0].e === '第1集' && b.items[0].s >= 55 && b.items[0].s <= 61, '一条:剧名 / 第1集 / ~60s', b && b.items);
    const e2 = makeEnv({ cfg: {}, token: 'tok' }); const w2 = mkWork();
    e2.P.open(e2.video, e2.opts({ work: w2, lineIdx: 0, ep: 0 }));
    await settle();
    e2.play(100, 2600);
    for (let i = 0; i < 62; i++) { e2.video.currentTime += 1; await e2.advance(1000); }
    ok(!e2.http.some(x => x.url === '/api/stats/watch'), '没开 watch_stats 不报');
});
T('销毁后:旧实例的错误 / 定时器都不再动作,监听全摘', async () => {
    const e = makeEnv(); const w = mkWork();
    const n0 = e.video.listenerCount();
    const s = e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    const h = e.lastHls();
    s.destroy();
    ok(h.destroyed, 'hls 销毁');
    h.trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    await e.advance(30000);
    eq([e.hls.length, e.switches.length, e.fails.length, e.xhrs.length], [1, 0, 0, 0], '没有任何后续动作');
    eq(e.video.listenerCount(), n0, '<video> 上的监听全摘了');
    eq(e.video.getAttribute('src'), null, 'src 摘掉');
});
T('hls 致命错 + video error 成对到达:只换一次线', async () => {
    const e = makeEnv({ ls: { donggua_adproxy_bad2: { siteA: BASE } } }); const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    e.lastHls().trigger(EV.ERROR, { fatal: true, type: 'mediaError', details: 'bufferAppendError' });
    e.video.error = { code: 3 }; e.video.fire('error');
    await settle();
    eq(e.switches.map(x => x[0]), [1], '只换到线路B 一次');
});
T('直播:https 直接放、http 经 worker 先测、出错 / 起不来换源、全挂报错、手动换源', async () => {
    const e = makeEnv({ net: u => ({ status: 200, txt: M3U8_OK }) });
    const ch = { name: 'CCTV-测试', sources: [{ url: 'https://live-a.example/a.m3u8' }, { url: 'http://live-b.example/b.m3u8' }, { url: 'https://live-c.example/c.m3u8' }] };
    const s = e.P.openLive(e.video, ch, e.opts());
    await settle();
    eq([e.lastHls().url, e.xhrs.length], ['https://live-a.example/a.m3u8', 0], 'https 源不测直接放');
    e.lastHls().trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    await settle();
    eq(e.xhrs, [W1 + '/?url=' + enc('http://live-b.example/b.m3u8')], 'http 源经 worker 先测');
    eq(e.lastHls().url, W1 + '/?url=' + enc('http://live-b.example/b.m3u8'), '测通了经 worker 放');
    await e.advance(12500);
    eq(e.lastHls().url, 'https://live-c.example/c.m3u8', '12s 起不来换下一条');
    eq(e.sources, [[0, 3], [1, 3], [2, 3]], 'onSource 依次报');
    e.lastHls().trigger(EV.ERROR, { fatal: true, type: 'networkError', details: 'fragLoadError' });
    await settle();
    eq(e.fails, ['这个台现在放不了'], '都不行报错');
    s.nextSource(1);
    await settle();
    eq(e.lastHls().url, 'https://live-a.example/a.m3u8', '手动换源从头再试');
    e.play(0, Infinity);
    eq(e.started, 1, 'onStarted');
    for (let i = 0; i < 3; i++) { e.video.currentTime += 2; e.video.fire('timeupdate'); await e.advance(2000); }
    const before = e.hls.length;
    await e.advance(14000);
    ok(e.hls.length === before + 1, '播着卡住 12s → 换源', [before, e.hls.length]);
    s.destroy();
    const n = e.hls.length;
    await e.advance(30000);
    eq(e.hls.length, n, '销毁后不再换源');
});
T('直播:https 页上没有 worker 的 http 源跳过', async () => {
    const e = makeEnv({ proxies: [] });
    e.api.proxy = () => '';
    const ch = { name: 'X', sources: [{ url: 'http://live-b.example/b.m3u8' }, { url: 'https://live-c.example/c.m3u8' }] };
    e.P.openLive(e.video, ch, e.opts());
    await settle();
    eq([e.lastHls().url, e.sources], ['https://live-c.example/c.m3u8', [[1, 2]]], '直接从第二条开始');
});
T('没有 MSE:原生 <video> 播 worker 地址', async () => {
    const e = makeEnv({ mse: false }); const w = mkWork();
    e.P.open(e.video, e.opts({ work: w, lineIdx: 0, ep: 0 }));
    await settle();
    eq([e.hls.length, e.video.src], [0, W1 + '/?url=' + enc(RAW_A1)], 'video.src = worker 地址');
});

for (const [name, fn] of tests) {
    const p0 = pass, f0 = fail;
    try { await fn(); } catch (err) { fail++; console.log('  ✗ ' + name + ' 抛错: ' + (err && err.stack || err)); }
    if (fail > f0) console.log('    ↑ ' + name);
    void p0;
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
