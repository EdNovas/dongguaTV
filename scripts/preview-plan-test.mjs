#!/usr/bin/env node
// [adult] p4 封面悬停预览回归(离线、零网络):node scripts/preview-plan-test.mjs
//  ① previewPlan 边界(全用合成清单,不含任何真实 CDN 地址):隐式 IV → 显式 IV(原媒体序号)、BYTERANGE、MAP、master 选档、
//     直播 / DRM 拒绝、重复插播 / 明文插播 / 外来目录不选、只有插播 → 不出清单、预算缩段但不少于 3 段、超大媒体序号(不用 BigInt)
//  ② 浏览器胶水的纯函数:码率表、http→https 白名单、混合内容判定、选线路(第一集 .m3u8、跳过失效)、禁用条件、每日 / 会话预算、清单缓存
//  ③ 沙箱里跑一次真流程(假 DOM + 假 Hls + 假 fetch):停留 600ms 才开始、直连失败走 Worker 一次、第一帧才淡入、5MB 硬顶、离开就停、
//     蜂窝 / 主播放器在放 / 刷短片开着时不预览
//  ④ 调研机上有 .adult-research/data/playlists(128 份真实清单)时额外跑一遍全量评估:原始清单与 Worker 输出两种模式都要 ≥127/128 干净;
//     没有这份数据就跳过(不报错)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_FILE = path.join(ROOT, 'public/adult/preview.js');
const PV = require(SRC_FILE);
const { previewPlan, parsePlaylist } = PV;

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const seg = (n, d = 3, pre = 'c') => Array.from({ length: n }, (_, i) => `#EXTINF:${d},\n${pre}${i}.ts`).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

console.log('① previewPlan(合成清单)');
t('implicit IV -> explicit IV from ORIGINAL media sequence', () => {
    const pl = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n${seg(400)}\n#EXT-X-ENDLIST`;
    const r = previewPlan(pl, 'https://cdn.example/v/index.m3u8');
    assert.ok(r.ok);
    const out = parsePlaylist(r.playlist, 'blob:x');
    assert.ok(out.segs.length >= 3);
    out.segs.forEach((s, k) => {
        const origSeq = 100 + r.picked[k];
        assert.equal(s.key.iv.toLowerCase(), '0x' + origSeq.toString(16).padStart(32, '0'));
        assert.equal(s.key.uri, 'https://cdn.example/v/k.key');
        assert.ok(s.url.startsWith('https://cdn.example/v/c'));
    });
});
t('huge media sequence: explicit IV without BigInt', () => {
    const pl = `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:4294967296\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n${seg(200)}\n#EXT-X-ENDLIST`;
    const r = previewPlan(pl, 'https://cdn.example/v/index.m3u8');
    const s0 = parsePlaylist(r.playlist, 'blob:x').segs[0];
    assert.equal(s0.key.iv, '0x' + (4294967296 + r.picked[0]).toString(16).padStart(32, '0'));
});
t('explicit IV is preserved; keyUrl mapper applied', () => {
    const pl = `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-KEY:METHOD=AES-128,URI="/k",IV=0x0000000000000000000000000000abcd\n${seg(300)}\n#EXT-X-ENDLIST`;
    const r = previewPlan(pl, 'https://cdn.example/v/i.m3u8', { keyUrl: (u) => 'https://w.example/?url=' + encodeURIComponent(u) });
    assert.match(r.playlist, /URI="https:\/\/w\.example\/\?url=https%3A%2F%2Fcdn\.example%2Fk",IV=0x0000000000000000000000000000abcd/);
    assert.equal((r.playlist.match(/#EXT-X-KEY/g) || []).length, 1, 'unchanged key emitted once');
});
t('BYTERANGE offsets made explicit', () => {
    const body = Array.from({ length: 200 }, () => `#EXTINF:3,\n#EXT-X-BYTERANGE:1000\nall.ts`).join('\n');
    const r = previewPlan(`#EXTM3U\n#EXT-X-TARGETDURATION:3\n${body}\n#EXT-X-ENDLIST`, 'https://c.example/a/b.m3u8');
    assert.ok(r.ok);
    const offs = [...r.playlist.matchAll(/#EXT-X-BYTERANGE:1000@(\d+)/g)].map((m) => +m[1]);
    assert.deepEqual(offs, r.picked.map((i) => i * 1000));
});
t('EXT-X-MAP carried after every DISCONTINUITY, version 6', () => {
    const r = previewPlan(`#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MAP:URI="init.mp4"\n${seg(300, 3, 'f').replace(/\.ts/g, '.m4s')}\n#EXT-X-ENDLIST`, 'https://c.example/x/p.m3u8');
    assert.match(r.playlist, /#EXT-X-VERSION:6/);
    assert.equal((r.playlist.match(/#EXT-X-MAP:URI="https:\/\/c\.example\/x\/init\.mp4"/g) || []).length, r.clips.length);
    assert.equal((r.playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length, r.clips.length - 1);
});
t('master -> lowest variant >=360p', () => {
    const m = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nhi/i.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\nlo/i.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720\nmid/i.m3u8`;
    const r = previewPlan(m, 'https://c.example/v/index.m3u8');
    assert.equal(r.reason, 'master'); assert.equal(r.variant.url, 'https://c.example/v/mid/i.m3u8');
});
t('live / SAMPLE-AES / invalid / empty rejected', () => {
    assert.equal(previewPlan(`#EXTM3U\n#EXT-X-TARGETDURATION:3\n${seg(50)}`, 'https://c.example/x.m3u8').reason, 'live');
    assert.equal(previewPlan(`#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n${seg(50)}\n#EXT-X-ENDLIST`, 'https://c.example/x.m3u8').reason, 'drm');
    assert.equal(previewPlan('<html>404</html>', 'https://c.example/x.m3u8').reason, 'invalid');
    assert.equal(previewPlan('#EXTM3U\n#EXT-X-ENDLIST', 'https://c.example/x.m3u8').reason, 'empty');
});
t('repeated creative never picked, pre-roll + mid-roll + clear-in-AES', () => {
    const ad = `#EXT-X-KEY:METHOD=NONE\n#EXTINF:3,\nhttps://ad.example/x/a0.ts\n#EXTINF:3,\nhttps://ad.example/x/a1.ts\n#EXTINF:2.5,\nhttps://ad.example/x/a2.ts`;
    const key = '#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x00000000000000000000000000000000';
    const pl = `#EXTM3U\n#EXT-X-TARGETDURATION:3\n${ad}\n#EXT-X-DISCONTINUITY\n${key}\n${seg(40)}\n#EXT-X-DISCONTINUITY\n${ad}\n#EXT-X-DISCONTINUITY\n${key}\n${seg(40, 3, 'd')}\n#EXT-X-ENDLIST`;
    const r = previewPlan(pl, 'https://cdn.example/v/i.m3u8');
    assert.ok(r.ok);
    assert.ok(!/ad\.example/.test(r.playlist));
    assert.ok(!/METHOD=NONE/.test(r.playlist));
});
t('foreign-dir short insert (other host) never picked', () => {
    const ins = `#EXTINF:5,\nhttps://other.example/ins/i0.ts\n#EXTINF:5,\nhttps://other.example/ins/i1.ts`;
    const pl = `#EXTM3U\n#EXT-X-TARGETDURATION:5\n${seg(300)}\n#EXT-X-DISCONTINUITY\n${ins}\n#EXT-X-DISCONTINUITY\n${seg(300, 3, 'e')}\n#EXT-X-ENDLIST`;
    const r = previewPlan(pl, 'https://cdn.example/v/i.m3u8');
    assert.ok(r.ok && !/other\.example/.test(r.playlist));
});
t('playlist that is only creatives -> no-safe-content (poster only)', () => {
    const ad = `#EXTINF:3,\nhttps://ad.example/x/a0.ts\n#EXTINF:3,\nhttps://ad.example/x/a1.ts`;
    const r = previewPlan(`#EXTM3U\n#EXT-X-TARGETDURATION:3\n${ad}\n#EXT-X-DISCONTINUITY\n${ad}\n#EXT-X-ENDLIST`, 'https://c.example/x.m3u8');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-safe-content');
});
t('budget shrinks clip count but not below 3', () => {
    const r = previewPlan(`#EXTM3U\n#EXT-X-TARGETDURATION:10\n${seg(1000, 10)}\n#EXT-X-ENDLIST`, 'https://c.example/x/y.m3u8', { bandwidth: 2e6, budgetBytes: 4 << 20 });
    assert.equal(r.clips.length, 3);
});
t('clips spread over the trimmed runtime, head/tail trimmed', () => {
    const r = previewPlan(`#EXTM3U\n#EXT-X-TARGETDURATION:3\n${seg(1200)}\n#EXT-X-ENDLIST`, 'https://c.example/x/y.m3u8');
    const T = r.stats.totalSec;
    assert.ok(r.clips.length >= 6 && r.clips[0].at >= Math.max(T * 0.06, 15) && r.clips[r.clips.length - 1].at <= T - Math.max(T * 0.06, 10));
});
t('preview.js has no ?. / ?? / BigInt / optional catch binding (old TV WebView)', () => {
    const src = fs.readFileSync(SRC_FILE, 'utf8').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\?\.[a-zA-Z_$[(]/.test(src) && !/[^?]\?\?[^?]/.test(src.replace(/'[^'\n]*'/g, "''")), '?. / ??');
    assert.ok(!/\bBigInt\b/.test(src), 'BigInt');
    assert.ok(!/catch\s*\{/.test(src), 'optional catch binding');
});

console.log('② 浏览器胶水的纯函数');
t('famBps / upgradeHttps / hasInsecure', () => {
    assert.equal(PV.famBps('tsbf:65'), 1.5e6);
    assert.equal(PV.famBps('souav'), 0.77e6);
    assert.equal(PV.famBps(''), 1.5e6);
    assert.equal(PV.upgradeHttps('http://vfile.meituan.net/a/b.png'), 'https://vfile.meituan.net/a/b.png');
    assert.equal(PV.upgradeHttps('http://x.vfile.meituan.net/a.ts'), 'https://x.vfile.meituan.net/a.ts');
    assert.equal(PV.upgradeHttps('http://evilvfile.meituan.net.example/a.ts'), 'http://evilvfile.meituan.net.example/a.ts');
    assert.equal(PV.upgradeHttps('http://other.example/a.ts'), 'http://other.example/a.ts');
    assert.equal(PV.upgradeHttps('https://other.example/a.ts'), 'https://other.example/a.ts');
    assert.ok(PV.hasInsecure('#EXTM3U\n#EXTINF:3,\nhttp://other.example/a.ts\n'));
    assert.ok(PV.hasInsecure('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://k.example/k",IV=0x0\n'));
    assert.ok(!PV.hasInsecure('#EXTM3U\n#EXTINF:3,\nhttps://other.example/a.ts\n'));
});
t('segUrl upgrade makes an allowlisted http playlist previewable', () => {
    const pl = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${Array.from({ length: 400 }, (_, i) => `#EXTINF:2,\nhttp://vfile.meituan.net/v/${i}.png`).join('\n')}\n#EXT-X-ENDLIST`;
    const r = previewPlan(pl, 'https://site.example/p.m3u8', { segUrl: PV.upgradeHttps });
    assert.ok(r.ok && !PV.hasInsecure(r.playlist) && /https:\/\/vfile\.meituan\.net\/v\//.test(r.playlist));
});
t('pickLines / firstM3u8', () => {
    assert.equal(PV.firstM3u8('正片$https://m.example/1/index.m3u8'), 'https://m.example/1/index.m3u8');
    assert.equal(PV.firstM3u8('第1集$https://m.example/a.mp4#第2集$https://m.example/b/index.m3u8'), 'https://m.example/b/index.m3u8');
    assert.equal(PV.firstM3u8('HD$https://x.example/share/abc$$$正片$https://m.example/2/index.m3u8?k=1'), 'https://m.example/2/index.m3u8?k=1');
    assert.equal(PV.firstM3u8(''), '');
    const w = { sources: [
        { site_key: 'a', _dead: true, vod_play_url: '正片$https://m.example/dead/index.m3u8' },
        { site_key: 'b', vod_play_url: '' },
        { site_key: 'c', _family: 'tsbf:65', _dur: 140, vod_play_url: '正片$https://m.example/c/index.m3u8' },
        { site_key: 'd', vod_play_url: '正片$https://m.example/d/index.m3u8' },
        { site_key: 'e', vod_play_url: '正片$https://m.example/e/index.m3u8' },
    ] };
    assert.deepEqual(PV.pickLines(w), [{ url: 'https://m.example/c/index.m3u8', site: 'c', fam: 'tsbf:65', dur: 140 }, { url: 'https://m.example/d/index.m3u8', site: 'd', fam: '', dur: 0 }]);
    assert.deepEqual(PV.pickLines(null), []);
    // TG 线路:_pv(中转的预览片)→ { mp4 };没有 MSE 时只要 mp4 的;_pv 不像中转预览地址的不认
    const PVU = 'https://relay.example.com/p/TS88158/123?e=1800000000&s=' + 'A'.repeat(24);
    const tw = { sources: [
        { site_key: 'tg_x', _pv: PVU, vod_play_url: '正片$https://relay.example.com/v/TS88158/123?e=1800000000&s=' + 'A'.repeat(24), _dur: 900 },
        { site_key: 'c', vod_play_url: '正片$https://m.example/c/index.m3u8' },
        { site_key: 'bad', _pv: 'javascript:alert(1)', vod_play_url: '' },
    ] };
    assert.deepEqual(PV.pickLines(tw), [{ mp4: PVU, site: 'tg_x', fam: '', dur: 900 }, { url: 'https://m.example/c/index.m3u8', site: 'c', fam: '', dur: 0 }]);
    assert.deepEqual(PV.pickLines(tw, { mse: false }), [{ mp4: PVU, site: 'tg_x', fam: '', dur: 900 }]);
    assert.deepEqual(PV.pickLines({ sources: [{ site_key: 'c', vod_play_url: '正片$https://m.example/c/index.m3u8' }] }, { mse: false }), []);
    // 多线路:前两条都不是 TG、后面有 TG 预览片 → 补成第三条兜底;前两条里已经有 TG 的不再补
    const many = { sources: [
        { site_key: 'a', vod_play_url: '正片$https://m.example/a/index.m3u8' },
        { site_key: 'b', vod_play_url: '正片$https://m.example/b/index.m3u8' },
        { site_key: 'c', vod_play_url: '正片$https://m.example/c/index.m3u8' },
        { site_key: 'tg_x', _pv: PVU, vod_play_url: '' },
    ] };
    assert.deepEqual(PV.pickLines(many).map((x) => x.site), ['a', 'b', 'tg_x']);
    assert.deepEqual(PV.pickLines(many, { mse: false }).map((x) => x.site), ['tg_x']);
    assert.deepEqual(PV.pickLines({ sources: [many.sources[0], many.sources[3], many.sources[1], many.sources[2]] }).map((x) => x.site), ['a', 'tg_x']);
    assert.ok(!PV.TG_PV_RE.test(PVU + '&x=1') && !PV.TG_PV_RE.test('https://relay.example.com/v/TS88158/123?e=1800000000&s=' + 'A'.repeat(24)));
});
t('blockReason covers every disable condition', () => {
    const ok = { on: true, tv: false, mse: true, reducedMotion: false, hidden: false, net: '', busy: false, feed: false, locked: false, sessionBytes: 0, dayBytes: 0 };
    assert.equal(PV.blockReason(ok), '');
    const cases = { on: [false, 'off'], tv: [true, 'tv'], mse: [false, ''], reducedMotion: [true, ''], hidden: [true, 'hidden'], net: ['cellular', 'cellular'], busy: [true, 'main-player'], feed: [true, 'feed'], locked: [true, 'locked'], sessionBytes: [PV.SESSION_CAP, 'session-budget'], dayBytes: [PV.DAY_CAP, 'day-budget'] };
    for (const k of Object.keys(cases)) assert.equal(PV.blockReason(Object.assign({}, ok, { [k]: cases[k][0] })), cases[k][1], k);
    assert.equal(PV.SESSION_CAP, 60 * 1048576); assert.equal(PV.DAY_CAP, 150 * 1048576); assert.equal(PV.HARD_CAP, 5 * 1048576); assert.equal(PV.PLAN_BUDGET, 4 * 1048576);
    assert.equal(PV.DWELL_MS, 600); assert.equal(PV.PRESS_MS, 450);
    // 系统「减少动态效果」不再拦(悬停 = 用户自己触发、静音);设置里关了照样不放,别的拦截照旧
    assert.equal(PV.blockReason(Object.assign({}, ok, { reducedMotion: true, force: false })), '');
    assert.equal(PV.blockReason(Object.assign({}, ok, { reducedMotion: true, on: false })), 'off');
    assert.equal(PV.blockReason(Object.assign({}, ok, { reducedMotion: true, busy: true })), 'main-player');
});
t('makeBudget: session + per-day (rolls over at midnight; storage errors ignored)', () => {
    const m = new Map();
    const ls = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
    let now = new Date(2026, 10, 22, 23, 59).getTime();
    const B = PV.makeBudget(ls, () => now);
    B.add(1000); B.add(500);
    assert.equal(B.session(), 1500); assert.equal(B.day(), 1500);
    now += 2 * 60e3;   // 第二天
    assert.equal(B.day(), 0);
    B.add(10);
    assert.equal(B.day(), 10); assert.equal(B.session(), 1510);
    const bad = PV.makeBudget({ getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } }, () => now);
    bad.add(5);
    assert.equal(bad.day(), 0); assert.equal(bad.session(), 5);
});
t('makePlanCache: 6h TTL, failures cached too, ≤50 entries', () => {
    const m = new Map();
    const ss = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
    let now = 1e12;
    const C = PV.makePlanCache(ss, () => now);
    C.put('c:A-1', { playlist: '#EXTM3U\n', clips: 3 });
    C.put('c:B-2', { fail: 'no-line' });
    assert.equal(C.get('c:A-1').playlist, '#EXTM3U\n'); assert.equal(C.get('c:B-2').fail, 'no-line');
    now += 6 * 3600e3 + 1;
    assert.equal(C.get('c:A-1'), null);
    for (let i = 0; i < 60; i++) C.put('c:X-' + i, { fail: 'x' });
    assert.equal(JSON.parse(m.get('dg_pv_plan')).length, 50);
    assert.ok(C.get('c:X-59') && !C.get('c:X-5'));
});
t('F6 makePlanCache: a record can carry a shorter ttl (transient failures); never longer than 6h', () => {
    const m = new Map();
    const ss = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
    let now = 1e12;
    const C = PV.makePlanCache(ss, () => now);
    C.put('c:F-1', { fail: 'fetch', ttl: PV.FAIL_TTL });
    C.put('c:F-2', { fail: 'no-line' });
    C.put('c:F-3', { fail: 'x', ttl: 48 * 3600e3 });
    assert.equal(PV.FAIL_TTL, 10 * 60e3);
    now += PV.FAIL_TTL - 1;
    assert.ok(C.get('c:F-1') && C.get('c:F-2'));
    now += 2;
    assert.equal(C.get('c:F-1'), null, 'short-ttl failure expired after 10 min');
    assert.equal(C.get('c:F-2').fail, 'no-line', 'normal failure still cached');
    now += 6 * 3600e3;
    assert.equal(C.get('c:F-3'), null, 'ttl longer than 6h is clamped to 6h');
});

console.log('③ 沙箱里跑一次流程');
function makeEnv(opts) {
    const o = opts || {};
    const listeners = {};
    const mkEl = (cls) => {
        const el = {
            className: cls || '', _cls: new Set(), children: [], parentNode: null, _ls: {}, attrs: {},
            classList: { add: (c) => el._cls.add(c), remove: (...cs) => cs.forEach((c) => el._cls.delete(c)), contains: (c) => el._cls.has(c) },
            addEventListener(t, f) { (el._ls[t] = el._ls[t] || []).push(f); },
            removeEventListener(t, f) { el._ls[t] = (el._ls[t] || []).filter((x) => x !== f); },
            dispatch(t) { (el._ls[t] || []).slice().forEach((f) => f({ type: t })); },
            appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
            removeChild(c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; },
            contains(x) { let n = x; while (n) { if (n === el) return true; n = n.parentNode; } return false; },
            setAttribute(k, v) { el.attrs[k] = v; }, removeAttribute(k) { delete el.attrs[k]; },
            querySelector(sel) { return sel === '.poster-wrap' ? el.children.find((c) => c.className === 'poster-wrap') || null : null; },
            play() { el._played = true; return Promise.resolve(); }, pause() { }, load() { },
        };
        return el;
    };
    const hlsInst = [];
    class FakeHls {
        static isSupported() { return o.mse !== false; }
        constructor(cfg) { this.cfg = cfg; this.h = {}; this.destroyed = false; hlsInst.push(this); }
        on(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); }
        emit(ev, d) { (this.h[ev] || []).forEach((f) => f(ev, d)); }
        loadSource(u) { this.src = u; }
        attachMedia(v) { this.media = v; }
        destroy() { this.destroyed = true; }
    }
    FakeHls.Events = { FRAG_LOADED: 'hlsFragLoaded', ERROR: 'hlsError' };
    const fetched = [];
    const aborted = [];
    const PL = `#EXTM3U\n#EXT-X-TARGETDURATION:3\n${Array.from({ length: 600 }, (_, i) => `#EXTINF:3,\nhttps://cdn.example/v/s${i}.ts`).join('\n')}\n#EXT-X-ENDLIST`;
    // o.hang:直连一直不回(只有被中止才结束,记进 aborted);o.fastTimeout:6 秒的取清单超时缩成 30ms
    const hangUntilAbort = (u, init) => new Promise((res, rej) => {
        const sig = init && init.signal;
        if (sig) sig.addEventListener('abort', () => { aborted.push(u); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    });
    const doc = {
        hidden: false,
        createElement: (tag) => mkEl(tag === 'video' ? '' : tag),
        getElementById: () => null, head: mkEl('head'), documentElement: mkEl('html'), querySelectorAll: () => (o.cards ? o.cards() : []),
        addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    };
    const store = new Map();
    const win = {
        document: doc, Hls: FakeHls, location: { protocol: 'https:' }, innerWidth: 390, innerHeight: 800,
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
        sessionStorage: (() => { const s = new Map(); return { getItem: (k) => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)) }; })(),
        matchMedia: (q) => ({ matches: /hover: hover/.test(q) ? o.hover !== false : false }),
        fetch: async (u, init) => {
            fetched.push(u);
            if (/\/p\/[A-Za-z]/.test(u)) {
                if (o.pvHang) return hangUntilAbort(u, init);
                const st = o.pvStatus || 200;
                return st === 200 ? new Response(new Uint8Array(300000), { status: 200, headers: { 'content-length': '300000' } }) : new Response('{}', { status: st });
            }
            const direct = !u.startsWith('https://w.example/');
            if (direct && o.hang) return hangUntilAbort(u, init);
            if (direct && o.directFails) return new Response('nope', { status: 403 });
            return new Response(PL, { status: 200 });
        },
        dgAdultHooks: { add() { } },
        DgAdult: {
            fetchWorkRaw: async (wk) => (o.work ? o.work(wk) : { sources: [{ site_key: 's1', vod_play_url: '正片$https://cdn.example/v/index.m3u8' }] }),
            searchSources: (wk) => (o.search ? o.search(wk) : null),
            proxyUrl: () => (o.noProxy ? '' : 'https://w.example'), netNow: () => o.net || '', isTV: () => false, mainBusy: () => !!o.busy, privLocked: () => false, cellOk: () => !!o.cell,
        },
        addEventListener() { },
        URL: { createObjectURL: () => 'blob:pv-1', revokeObjectURL() { } }, Blob: function () { }, Uint8Array,
        AbortController, Response, setTimeout: o.fastTimeout ? (f, ms) => setTimeout(f, ms >= 6000 ? 30 : ms) : setTimeout, clearTimeout, console, Promise, JSON, Math, Date, Map, Set, Object, Array, String, Number, RegExp, Error,
    };
    if (o.nav) win.navigator = o.nav;
    win.window = win; win.globalThis = win;
    const ctx = vm.createContext(win);
    vm.runInContext(fs.readFileSync(SRC_FILE, 'utf8'), ctx, { filename: 'preview.js' });
    const card = mkEl('hot-card');
    const box = mkEl('poster-wrap');
    card.appendChild(box);
    const fire = (t, ev) => (listeners[t] || []).slice().forEach((f) => f(ev));
    return { win, api: win.dgAdultPreview, card, box, hlsInst, fetched, aborted, store, fire, ss: win.sessionStorage, mkEl };
}
t('pure exports exist and the browser build boots', () => {
    const E = makeEnv();
    assert.equal(typeof E.api.boot, 'function');
    assert.equal(typeof E.api.status, 'function');
});
const asyncTests = [];
const at = (name, fn) => asyncTests.push([name, fn]);
at('dwell 600ms → plan → hls on blob; first frame fades in; 5MB hard cap stops & counts budget', async () => {
    const E = makeEnv();
    E.api._onHover({ _wk: 'c:SYN-001' }, E.card, { type: 'pointerover' });
    await sleep(300);
    assert.equal(E.hlsInst.length, 0, 'not before 600ms');
    await sleep(400);
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(E.hlsInst.length, 1, 'one hls instance');
    const h = E.hlsInst[0];
    assert.equal(h.src, 'blob:pv-1'); assert.ok(h.media && h.media.muted === true && h.media.loop === true && h.media.playsInline === true);
    assert.equal(h.cfg.maxBufferLength, 8);
    assert.ok(E.box.children.includes(h.media), 'video overlays the poster');
    assert.ok(!E.card.classList.contains('dg-pv-on'), 'poster stays until the first frame');
    h.media.dispatch('playing');
    assert.ok(E.card.classList.contains('dg-pv-on'));
    assert.deepEqual(E.fetched, ['https://cdn.example/v/index.m3u8'], 'direct fetch only');
    for (let i = 0; i < 6; i++) h.emit('hlsFragLoaded', { frag: { stats: { loaded: 1024 * 1024 } } });
    assert.ok(h.destroyed, 'destroyed after 5MB');
    assert.ok(!E.box.children.length && !E.card.classList.contains('dg-pv-on'), 'video removed, poster back');
    assert.equal(E.api.status().why, 'hard-cap');
    assert.ok(JSON.parse(E.store.get('dg_pv_day')).b >= 6 * 1048576);
});
at('direct fetch fails → one retry through the configured Worker (?url=)', async () => {
    const E = makeEnv({ directFails: true });
    E.api._onHover({ _wk: 'c:SYN-002' }, E.card, { type: 'pointerover' });
    await sleep(650);
    for (let i = 0; i < 20; i++) await tick();
    assert.deepEqual(E.fetched, ['https://cdn.example/v/index.m3u8', 'https://w.example/?url=' + encodeURIComponent('https://cdn.example/v/index.m3u8')]);
    assert.equal(E.hlsInst.length, 1);
});
at('mouse leaves before / after start → nothing / stop', async () => {
    const E = makeEnv();
    E.api._onHover({ _wk: 'c:SYN-003' }, E.card, { type: 'pointerover' });
    await sleep(200);
    E.card.dispatch('mouseleave');
    await sleep(600);
    assert.equal(E.hlsInst.length, 0, 'left before dwell');
    E.api._onHover({ _wk: 'c:SYN-003' }, E.card, { type: 'pointerover' });
    await sleep(650);
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(E.hlsInst.length, 1);
    E.card.dispatch('mouseleave');
    assert.ok(E.hlsInst[0].destroyed && E.api.status().why === 'leave');
});
at('blocked: cellular / main player playing / no hover device', async () => {
    for (const o of [{ net: 'cellular' }, { busy: true }, { hover: false }, { mse: false }]) {
        const E = makeEnv(o);
        E.api._onHover({ _wk: 'c:SYN-004' }, E.card, { type: 'pointerover' });
        await sleep(650);
        for (let i = 0; i < 10; i++) await tick();
        assert.equal(E.hlsInst.length, 0, JSON.stringify(o));
        assert.equal(E.fetched.length, 0, 'no network at all: ' + JSON.stringify(o));
    }
});
const DIRECT = 'https://cdn.example/v/index.m3u8', VIA_WORKER = 'https://w.example/?url=' + encodeURIComponent(DIRECT);
const settle = async (n) => { for (let i = 0; i < (n || 20); i++) await tick(); };
at('F5 stopped while the direct playlist fetch is in flight → aborted, no Worker retry; each preview cancels its own fetch', async () => {
    const E = makeEnv({ hang: true });
    E.api._onHover({ _wk: 'c:SYN-010' }, E.card, { type: 'pointerover' });
    await sleep(650); await settle();
    assert.deepEqual(E.fetched, [DIRECT], 'direct fetch in flight');
    E.card.dispatch('mouseleave');
    await settle();
    assert.deepEqual(E.aborted, [DIRECT], 'stop aborted the direct fetch');
    assert.deepEqual(E.fetched, [DIRECT], 'no Worker request for a preview nobody will see');
    // back to back: start(A) → stop → start(B) → stop(B)
    E.api.start({ _wk: 'c:SYN-011' }, E.card); await settle(); E.api.stop('leave');
    E.api.start({ _wk: 'c:SYN-012' }, E.card); await settle();
    E.api.stop('scroll'); await settle();
    assert.equal(E.fetched.filter((u) => u.startsWith('https://w.example/')).length, 0, 'never hit the Worker: ' + JSON.stringify(E.fetched));
    assert.equal(E.aborted.length, 3, 'every direct fetch (B too) aborted by its own stop: ' + JSON.stringify(E.aborted));
});
at('F5 a direct fetch that times out (preview still live) still gets its one Worker retry', async () => {
    const E = makeEnv({ hang: true, fastTimeout: true });
    E.api._onHover({ _wk: 'c:SYN-013' }, E.card, { type: 'pointerover' });
    await sleep(800); await settle();
    assert.deepEqual(E.fetched, [DIRECT, VIA_WORKER]);
    assert.equal(E.hlsInst.length, 1);
});
at('F6 a /api/catalog/work outage is not cached as "no line": after recovery the next hover fetches again and previews', async () => {
    let up = false, calls = 0;
    const E = makeEnv({ work: () => { calls++; return up ? { sources: [{ site_key: 's1', vod_play_url: '正片$' + DIRECT }] } : null; } });
    E.api._onHover({ _wk: 'c:SYN-020' }, E.card, { type: 'pointerover' });
    await sleep(650); await settle();
    assert.equal(E.hlsInst.length, 0);
    assert.ok(!/SYN-020/.test(E.ss.getItem('dg_pv_plan') || ''), 'nothing cached for a failed /work: ' + E.ss.getItem('dg_pv_plan'));
    E.card.dispatch('mouseleave');
    up = true;
    E.api._onHover({ _wk: 'c:SYN-020' }, E.card, { type: 'pointerover' });
    await sleep(650); await settle();
    assert.equal(calls, 2, '/work asked again');
    assert.equal(E.hlsInst.length, 1, 'previews once the server is back');
});
at('F6 a real work with no previewable line is cached (6h); a playlist that could not be fetched only for 10 min', async () => {
    const E = makeEnv({ work: (wk) => (wk === 'c:SYN-021' ? { sources: [] } : { sources: [{ site_key: 's1', vod_play_url: '正片$' + DIRECT }] }), directFails: true, noProxy: true });
    E.api._onHover({ _wk: 'c:SYN-021' }, E.card, { type: 'pointerover' });
    await sleep(650); await settle();
    E.card.dispatch('mouseleave');
    E.api._onHover({ _wk: 'c:SYN-022' }, E.card, { type: 'pointerover' });
    await sleep(650); await settle();
    const rec = Object.fromEntries(JSON.parse(E.ss.getItem('dg_pv_plan')).map((r) => [r.wk, r]));
    assert.equal(rec['c:SYN-021'].fail, 'no-line'); assert.equal(rec['c:SYN-021'].ttl, undefined);
    assert.equal(rec['c:SYN-022'].fail, 'fetch'); assert.equal(rec['c:SYN-022'].ttl, PV.FAIL_TTL);
});
at('search: work not in the catalog (/work 404) → previews from the search result\'s own lines; nothing there → nothing cached', async () => {
    const asked = [];
    const E = makeEnv({ work: () => null, search: (wk) => { asked.push(wk); return wk === 't:only-in-search' ? [{ site_key: 's9', vod_play_url: '正片$' + DIRECT }] : null; } });
    E.api._onHover({ _wk: 't:only-in-search' }, E.card, { type: 'pointerover' });
    await sleep(650); await settle();
    assert.deepEqual(asked, ['t:only-in-search']);
    assert.equal(E.hlsInst.length, 1, 'previews from the search lines');
    assert.deepEqual(E.fetched, [DIRECT]);
    E.card.dispatch('mouseleave');
    E.api._onHover({ _wk: 't:nowhere' }, E.card, { type: 'pointerover' });
    await sleep(650); await settle();
    assert.equal(E.hlsInst.length, 1, 'no second preview');
    assert.ok(!/t:nowhere/.test(E.ss.getItem('dg_pv_plan') || ''), 'not cached: ' + E.ss.getItem('dg_pv_plan'));
    // 搜索线路一条能预览的都没有(只有 mp4 地址):「没有线路」只记 10 分钟(搜索还在陆续出线路)
    const F = makeEnv({ work: () => null, search: () => [{ site_key: 's9', vod_play_url: '正片$https://cdn.example/a.mp4' }] });
    F.api._onHover({ _wk: 't:mp4-only' }, F.card, { type: 'pointerover' });
    await sleep(650); await settle();
    const rec = JSON.parse(F.ss.getItem('dg_pv_plan')).find((r) => r.wk === 't:mp4-only');
    assert.equal(rec.fail, 'no-line'); assert.equal(rec.ttl, PV.FAIL_TTL);
    // 目录里有这一部:不去问搜索结果
    const G = makeEnv({ search: () => { throw new Error('should not be asked'); } });
    G.api._onHover({ _wk: 'c:SYN-050' }, G.card, { type: 'pointerover' });
    await sleep(650); await settle();
    assert.equal(G.hlsInst.length, 1);
});
at('F7 Android long-press: the system contextmenu (400ms) arrives before our 450ms → prevented, preview starts right then', async () => {
    const E = makeEnv({ hover: false, nav: { connection: { type: 'wifi' } } });
    E.api._onHover({ _wk: 'c:SYN-030' }, E.card, { type: 'touchstart', touches: [{ clientX: 50, clientY: 60 }] });
    await sleep(400);
    let prevented = false;
    E.fire('contextmenu', { target: E.box, preventDefault() { prevented = true; } });
    await settle();
    assert.ok(prevented, 'image context menu suppressed while the long-press is pending');
    assert.equal(E.hlsInst.length, 1, 'preview started on the contextmenu');
    await sleep(100); await settle();
    assert.equal(E.hlsInst.length, 1, 'the 450ms timer does not start a second one');
    let p2 = false;
    E.fire('contextmenu', { target: E.mkEl('div'), preventDefault() { p2 = true; } });
    assert.ok(!p2, 'a contextmenu elsewhere is left alone');
    // 没有在按着的(电脑右键):不拦
    const D = makeEnv();
    let p3 = false;
    D.fire('contextmenu', { target: D.box, preventDefault() { p3 = true; } });
    assert.ok(!p3, 'right-click with no press pending is not touched');
});
at('F1 touch long-press with no navigator.connection = network unknown → no preview unless 移动网络也自动播放 is on', async () => {
    for (const [o, want] of [[{ hover: false }, 0], [{ hover: false, cell: true }, 1], [{ hover: false, nav: { connection: { type: 'wifi' } } }, 1], [{}, 1]]) {
        const E = makeEnv(o);
        if (o.hover === false) E.api._onHover({ _wk: 'c:SYN-040' }, E.card, { type: 'touchstart', touches: [{ clientX: 5, clientY: 5 }] });
        else E.api._onHover({ _wk: 'c:SYN-040' }, E.card, { type: 'pointerover' });
        await sleep(650); await settle();
        assert.equal(E.hlsInst.length, want, JSON.stringify(o));
        if (!want) { assert.equal(E.fetched.length, 0, 'no network at all'); assert.equal(E.api.status().block, 'net-unknown'); }
    }
});

const PVURL = 'https://relay.example.com/p/TS88158/77?e=1800000000&s=' + 'B'.repeat(24);
const tgWork = () => ({ sources: [{ site_key: 'tg_ts88158', _pv: PVURL, vod_play_url: '正片$https://relay.example.com/v/TS88158/77?e=1800000000&s=' + 'B'.repeat(24) }] });
at('TG: _pv 预览片整个拿下来直接放(不用 hls.js),计流量;没有 MSE(iPhone)也放', async () => {
    for (const mse of [true, false]) {
        const E = makeEnv({ work: tgWork, mse });
        E.api._onHover({ _wk: 't:tg-1' }, E.card, { type: 'pointerover' });
        await sleep(650); await settle(30);
        assert.deepEqual(E.fetched, [PVURL], 'only the preview clip: ' + JSON.stringify(E.fetched));
        assert.equal(E.hlsInst.length, 0, 'no hls.js for an mp4 clip');
        const v = E.box.children[0];
        assert.ok(v && v.src === 'blob:pv-1' && v.muted === true && v.loop === true && v.playsInline === true, 'video on the blob');
        v.dispatch('playing');
        assert.ok(E.card.classList.contains('dg-pv-on'));
        assert.ok(JSON.parse(E.store.get('dg_pv_day')).b >= 300000, 'bytes counted');
        assert.ok(/"mp4"/.test(E.ss.getItem('dg_pv_plan')), 'plan cached');
        E.card.dispatch('mouseleave');
        assert.ok(!E.box.children.length && E.api.status().why === 'leave');
    }
});
at('TG: 预览片做不了(422)记 6 小时;中转忙(503)/ 断网只记一分钟', async () => {
    for (const [st, ttl] of [[422, undefined], [503, 60e3]]) {
        const E = makeEnv({ work: tgWork, pvStatus: st });
        E.api._onHover({ _wk: 't:tg-2' }, E.card, { type: 'pointerover' });
        await sleep(650); await settle(30);
        assert.equal(E.box.children.length, 0);
        assert.ok(!E.card.classList.contains('dg-pv-load'), 'loading bar gone');
        const rec = JSON.parse(E.ss.getItem('dg_pv_plan')).find((r) => r.wk === 't:tg-2');
        assert.equal(rec.fail, 'pv-' + st); assert.equal(rec.ttl, ttl);
    }
});
at('TG: 预览片还在做时离开卡片 → 请求中止', async () => {
    const E = makeEnv({ work: tgWork, pvHang: true });
    E.api._onHover({ _wk: 't:tg-3' }, E.card, { type: 'pointerover' });
    await sleep(650); await settle(30);
    E.card.dispatch('mouseleave');
    await settle();
    assert.deepEqual(E.aborted, [PVURL]);
});
at('手机跟随:停稳后同一排两张一起放(以前只放左边那张);不在同一排的不放', async () => {
    const cards = [];
    const mkCard = (wk, left, top) => {
        const E0 = cards.env;
        const c = E0.mkEl('browse-card'), b = E0.mkEl('poster-wrap');
        c.appendChild(b);
        c.getAttribute = (k) => (k === 'data-wk' ? wk : null);
        b.getBoundingClientRect = () => ({ left, right: left + 170, top, bottom: top + 96, width: 170, height: 96 });
        return c;
    };
    const E = makeEnv({ work: tgWork, cards: () => cards.list });
    cards.env = E;
    cards.list = [mkCard('t:a', 15, 200), mkCard('t:b', 205, 200), mkCard('t:c', 15, 330), mkCard('t:d', 205, 330), mkCard('t:e', 15, 700)];
    E.api._state.follow = true;
    E.api._followPick();
    await settle(30);
    const st = E.api.status();
    assert.equal(st.n, 2, 'two at once: ' + JSON.stringify(st));
    assert.equal(JSON.stringify(st.wks.slice().sort()), JSON.stringify(['t:c', 't:d']), 'the row nearest the middle (y≈45%): ' + JSON.stringify(st.wks));
    assert.ok(cards.list[2].children[0].children.length === 1 && cards.list[3].children[0].children.length === 1, 'both have a video');
    // 一张出错只停它自己
    cards.list[2].children[0].children[0].dispatch('error');
    assert.equal(E.api.status().n, 1);
    assert.equal(cards.list[3].children[0].children.length, 1, 'the other keeps playing');
    // 滚动 → 全停
    E.fire('scroll', {});
    assert.equal(E.api.status().n, 0);
    assert.equal(E.api.FOLLOW_MAX, 2);
});

// ④ 全量评估(只在调研机上有数据时)
function fixtureEval() {
    const RES = path.join(ROOT, '.adult-research');
    const PLD = path.join(RES, 'data', 'playlists');
    const files = [path.join(PLD, 'index.json'), path.join(RES, 'sources.json'), path.join(ROOT, 'cloudflare-cors-proxy.js')];
    if (!files.every((f) => fs.existsSync(f))) return null;
    const idx = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    const src = fs.readFileSync(files[2], 'utf8').split('\r').join('').replace('export default {', 'const __workerDefault = {');
    const W = new Function('console', src + '\nreturn { rewriteM3u8 };')({ log() { }, warn() { }, error() { } });
    const PROXY = 'https://w.example';
    const items = [];
    for (const s of idx) for (const p of s.playlists || []) if (p.file && fs.existsSync(path.join(PLD, p.file))) {
        const text = fs.readFileSync(path.join(PLD, p.file), 'utf8');
        const P = parsePlaylist(text, p.mediaUrl);
        const c = {}; for (const x of P.segs) c[x.dir] = (c[x.dir] || 0) + x.dur;
        const mainDir = (Object.entries(c).sort((a, b) => b[1] - a[1])[0] || [])[0];
        items.push({ p, text, P, mainDir, dirs: new Set(P.segs.map((x) => x.dir)) });
    }
    if (!items.length) return null;
    // 广告真值:与 preview-eval.mjs / sim-worker v2 相同(跨视频复用的目录,或 <15 片的组签名在 ≥2 个视频里出现)
    const coSets = {};
    for (const it of items) for (const d of it.dirs) { const key = [...it.dirs].filter((x) => x !== d).sort().join('|'); (coSets[d] = coSets[d] || new Set()).add(key); }
    const adDirs = new Set(Object.entries(coSets).filter(([, set]) => set.size >= 2).map(([d]) => d));
    const groupSig = (S, g) => S.filter((x) => x.g === g).map((x) => x.dur.toFixed(2)).join(',');
    const sigVideos = {};
    for (const it of items) for (const g of new Set(it.P.segs.map((x) => x.g))) { const n = it.P.segs.filter((x) => x.g === g).length; if (n >= 15) continue; (sigVideos[groupSig(it.P.segs, g)] = sigVideos[groupSig(it.P.segs, g)] || new Set()).add(it.mainDir); }
    const adSigs = new Set(Object.entries(sigVideos).filter(([sig, v]) => v.size >= 2 && new Set(sig.split(',')).size >= 2).map(([s]) => s));
    for (const it of items) {
        const sigOf = {}; for (const g of new Set(it.P.segs.map((x) => x.g))) sigOf[g] = groupSig(it.P.segs, g);
        it.adUrl = new Map();
        for (const x of it.P.segs) { const ad = adDirs.has(x.dir) || adSigs.has(sigOf[x.g]); if (ad || !it.adUrl.has(x.url)) it.adUrl.set(x.url, ad || it.adUrl.get(x.url) || false); }
    }
    const keyStr = (k, seq) => { if (!k) return 'NONE'; let u = k.uri || ''; if (u.startsWith(PROXY + '/?url=')) u = decodeURIComponent(u.slice((PROXY + '/?url=').length)); return `${k.method} ${u} ${(k.iv || '0x' + seq.toString(16).padStart(32, '0')).toLowerCase()}`; };
    const clean = (it, text, plan) => {
        if (!plan.ok) return false;
        const sp = parsePlaylist(text, it.p.mediaUrl), out = parsePlaylist(plan.playlist, 'blob:x');
        const pick = plan.picked.map((i) => sp.segs[i]);
        if (pick.some((s) => it.adUrl.get(s.url))) return false;
        for (let k = 0; k < out.segs.length; k++) if (keyStr(out.segs[k].key, out.segs[k].seq) !== keyStr(pick[k].key, pick[k].seq)) return false;
        const disc = (plan.playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length;
        return out.kind === 'media' && out.header.endlist && out.segs.length === pick.length && out.segs.every((s, k) => /^https?:\/\//.test(s.url) && s.url === pick[k].url)
            && out.header.targetDuration >= Math.ceil(Math.max(...out.segs.map((s) => s.dur))) && disc === plan.clips.length - 1;
    };
    let raw = 0, wk = 0;
    for (const it of items) {
        if (clean(it, it.text, previewPlan(it.text, it.p.mediaUrl, {}))) raw++;
        let wt = null;
        try { wt = W.rewriteM3u8(it.text, new URL(it.p.mediaUrl), PROXY); } catch (e) { wt = null; }
        if (wt && clean(it, wt, previewPlan(wt, it.p.mediaUrl, {}))) wk++;
    }
    return { n: items.length, raw, worker: wk };
}

for (const [name, fn] of tests) {
    try { fn(); pass++; } catch (e) { fail++; console.log('  ✗ ' + name + '  ->  ' + (e && e.message)); }
}
for (const [name, fn] of asyncTests) {
    try { await fn(); pass++; } catch (e) { fail++; console.log('  ✗ ' + name + '  ->  ' + (e && e.message)); }
}
console.log('④ 128 份真实清单全量评估');
{
    let r = null;
    try { r = fixtureEval(); } catch (e) { fail++; console.log('  ✗ 全量评估出错  ->  ' + (e && e.message)); }
    if (!r) console.log('  (没有 .adult-research/data/playlists,跳过)');
    else {
        console.log(`  playlists=${r.n} clean raw=${r.raw} worker=${r.worker}`);
        const need = Math.max(0, r.n - 1);
        if (r.raw >= need && r.worker >= need) pass++;
        else { fail++; console.log(`  ✗ 干净的预览不足 ${need}/${r.n}`); }
    }
}
console.log(`\n${fail ? '✗' : '✓'} preview-plan-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
