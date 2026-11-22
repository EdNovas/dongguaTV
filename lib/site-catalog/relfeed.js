// [adult] 相关推荐 + 刷一刷(第四阶段,读线程;snapshot.js 用)。全部按快照的位图 / 列 / 演员 CSR 算,SQL 只取最后要出的那几行。
//
// 相关推荐 related(wk):
//   打分 = 3 × 共同 AVDB 演员(最多 3 位)+ 2 × 同片商或同厂牌前缀 + 精选标签 Jaccard(0..1)+ 1 × 同分区。
//   只用 featured 标签算(审查级标签永不当种子,也不参与打分);候选必须有演员 / 片商 / 标签之一的关联(只同分区不算),
//   标签那一路 Jaccard 至少 relatedMinJac。排除:作品自己、同一部片的一家子(番号作品同 ckey 的 正片 / ~N / #clip / #U,
//   片名作品同键的 ~N)、片段、带审查级标签或审查级 code 的作品;只出快照里的可见作品(vis=1、ELIG、启用站上有活线路)。
//   另给两行:她的其它作品(作品的演员里可见作品最多的那位,按发行日期)、同片商(按首见时间)。
// 刷一刷 feed:
//   快照建好时预算两条序列(buildFeed):全部(已知竖屏 → 方向未知 / 方形 → 横屏)与只竖屏;每层按天分槽、槽内按家族轮流、同家族连续 ≤ feedMaxRun。
//   入选:分区 short(时长知道时 8..300s),或 live / creators 且 已知竖屏 且 时长 8..180s;片段 / 审查级(作品审查级或带审查级标签)一律不进。
//   取一页时现查线路:启用站、没判死、播放地址 feedPlayTtlMs 内、第一集是 m3u8 → lines[{site, vod_id, vod_name, type_name, url, dur, orient}]
//   (每站一条,竖屏线路在前,≤ feedLines 条;vod_name / type_name 是这条线路自己的片名 / 分类名,闸门按它逐条复查);
//   一条能播的线路都没有的作品跳过。游标 = [快照 id, 位置, 上一个作品 id, vert];快照换了按上一个作品接着走,找不到 = 到底。
'use strict';

const U = require('./util');
const K = require('./common');

const { ELIG, ELIG_I } = K;

// 快照建好时:三层候选(下标数组)→ {feedA, feedV}(Int32Array,make(Ctor, n) 建共享数组)
function buildFeed({ tiers, fs, id, fam, C, make }) {
    const order = (arr) => {
        arr.sort((a, b) => (fs[b] - fs[a]) || (id[b] - id[a]));
        if (arr.length > C.feedPoolMax) arr.length = C.feedPoolMax;
        const famOf = (i) => fam[i];
        const slotOf = (i) => Math.floor(fs[i] / C.feedSlotMs);
        return U.interleave(U.slotRoundRobin(arr, famOf, slotOf), famOf, arr.length, C.feedMaxRun, true);
    };
    const v = order(tiers[0]);
    const rest = order(tiers[1]).concat(order(tiers[2]));
    const all = v.concat(rest).slice(0, C.feedPoolMax);
    const feedV = make(Int32Array, v.length);
    feedV.set(v);
    const feedA = make(Int32Array, all.length);
    feedA.set(all);
    return { feedA, feedV };
}

// 第一集的 m3u8 地址(maccms:多个播放源 $$$ 分隔,集 # 分隔,"集名$地址");没有 → ''
function firstM3u8(pu) {
    for (const g of String(pu || '').split('$$$')) {
        const ep = g.split('#')[0];
        const j = ep.lastIndexOf('$');
        const u = (j >= 0 ? ep.slice(j + 1) : ep).trim();
        if (u.length <= 2000 && /^https?:\/\/[^\s$#]+$/i.test(u) && /m3u8/i.test(u)) return u;
    }
    return '';
}

function encCursor(c) { return Buffer.from(JSON.stringify(c)).toString('base64url'); }
function decCursor(x) {
    try { const c = JSON.parse(Buffer.from(String(x), 'base64url').toString('utf8')); return Array.isArray(c) && c.length === 4 ? c : null; } catch (_) { return null; }
}

// o = {q, C, getS, L:{B_CLIP, B_TAG, FEATI, REV:Set(审查级标签 id)}}
function createRelFeed(o) {
    const { q, C, getS, L } = o;
    const FEATI = L.FEATI;
    // 审查级复查:快照的 col.rvl 是建快照那一刻的;快照之后爬虫 / 回填 / 搜索回写给作品加了带审查级标签的线路(或 review 变成 code)
    //   要马上不出 —— 卡片行是现读的,这里按库里【现在】的 tags / review 再判一次(和 snapshot.js rvl 同口径:1 = code 或带审查级标签,2 = filter)
    const REV = L.REV instanceof Set && L.REV.size ? L.REV : K.NONFEATURED_LEGACY;
    const RCOLS = K.WCOLS + ', w.ckey, w.orient, w.tags AS rtags, w.review AS rreview';
    function rvlNow(r) {
        let v = r.rreview === 'code' || r.rreview === 'hide' ? 1 : r.rreview === 'filter' ? 2 : 0;
        if (!(v & 1)) for (const x of String(r.rtags || '').split(',')) if (x && REV.has(x)) { v |= 1; break; }
        return v;
    }
    function rowsByIds(ids) {
        const out = new Map();
        for (let k = 0; k < ids.length; k += 500) {
            const part = ids.slice(k, k + 500);
            if (!part.length) continue;
            for (const r of q(`SELECT ${RCOLS} FROM adult_works w WHERE w.id IN (${part.map(() => '?').join(',')}) AND ${ELIG}`).all(...part)) out.set(r.id, r);
        }
        return out;
    }
    // 快照下标:作品 id → i(每个快照第一次用时建一次)
    function idxOf(s, wid) {
        if (!s.idIdx) {
            const m = new Map();
            for (let i = 0; i < s.N; i++) m.set(s.col.id[i], i);
            s.idIdx = m;
        }
        const i = s.idIdx.get(wid);
        return i == null ? -1 : i;
    }
    let scr = null;   // 打分用的临时数组(按快照大小复用,用完清零)
    function scratch(N) {
        if (!scr || scr.tag.length < N) scr = { tag: new Uint8Array(N), act: new Uint8Array(N) };
        return scr;
    }
    const clamp = (v, lo, hi, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };

    // ---------- 相关推荐 ----------
    function related(a) {
        const wk = a && typeof a.wk === 'string' ? a.wk : '';
        if (!wk || wk.length > 300) return null;
        const w = q(`SELECT w.id, w.wk, w.ckey FROM adult_works w WHERE w.wk=? AND w.vis=1 AND ${ELIG}`).get(wk);
        if (!w) return null;
        const empty = { items: [], actress: null, studio: null };
        const s = getS();
        if (!s || !s.N) return empty;
        const i = idxOf(s, w.id);
        if (i < 0) return empty;   // 新作品(快照之后才上架):作品在,还没有可比的数据
        const lim = clamp(a.limit, 1, 48, 24);
        const rowLim = C.relatedRow;
        const N = s.N, W = s.W, bits = s.bits, col = s.col;
        const isClip = (j) => (bits[L.B_CLIP * W + (j >>> 5)] >>> (j & 31)) & 1;
        const bad = (j) => j === i || isClip(j) || (col.rvl[j] & 1);
        // 种子:只 featured 标签
        const A = [];
        for (const ti of FEATI) if ((bits[(L.B_TAG + ti) * W + (i >>> 5)] >>> (i & 31)) & 1) A.push(ti);
        const sc = scratch(N);
        const tag = sc.tag, act = sc.act;
        for (const ti of A) {
            const off = (L.B_TAG + ti) * W;
            for (let w2 = 0; w2 < W; w2++) { let x = bits[off + w2]; while (x) { const lo = x & -x; const j = (w2 << 5) | (31 - Math.clz32(lo)); if (tag[j] < 255) tag[j]++; x ^= lo; } }
        }
        const acts = [];
        for (let p = s.aOff[i]; p < s.aOff[i + 1]; p++) acts.push(s.aVal[p]);
        for (const x of acts) for (let p = s.iOff[x]; p < s.iOff[x + 1]; p++) { const j = s.iVal[p]; if (act[j] < 255) act[j]++; }
        const st0 = col.st[i], lb0 = col.lb[i], bk0 = col.bk[i], nA = A.length;
        // 前 KP 名(分数降序、首见降序)
        const KP = lim * 2 + 16;
        const topS = new Float64Array(KP), topJ = new Int32Array(KP);
        let len = 0;
        const better = (sa, ja, sb, jb) => (sa !== sb ? sa > sb : col.fs[ja] !== col.fs[jb] ? col.fs[ja] > col.fs[jb] : col.id[ja] > col.id[jb]);
        const stList = [];
        try {
            for (let j = 0; j < N; j++) {
                const sameSt = st0 >= 0 && col.st[j] === st0;
                const ss = sameSt || (lb0 >= 0 && col.lb[j] === lb0);
                const ct = tag[j], ca = act[j];
                if (!ct && !ca && !ss) continue;
                if (bad(j)) continue;
                if (sameSt) stList.push(j);
                const jac = ct ? ct / (nA + col.nft[j] - ct) : 0;
                if (!ca && !ss && jac < C.relatedMinJac) continue;
                const score = 3 * Math.min(ca, 3) + (ss ? 2 : 0) + jac + (col.bk[j] === bk0 ? 1 : 0);
                if (len === KP && !better(score, j, topS[len - 1], topJ[len - 1])) continue;
                let p = len < KP ? len++ : len - 1;
                while (p > 0 && better(score, j, topS[p - 1], topJ[p - 1])) { topS[p] = topS[p - 1]; topJ[p] = topJ[p - 1]; p--; }
                topS[p] = score; topJ[p] = j;
            }
        } finally { tag.fill(0, 0, N); act.fill(0, 0, N); }
        // 演员行:作品的演员里可见作品(除去自己 / 片段 / 审查级)最多的那位
        let actX = -1, actList = null;
        for (const x of acts) {
            const list = [];
            for (let p = s.iOff[x]; p < s.iOff[x + 1]; p++) { const j = s.iVal[p]; if (!bad(j)) list.push(j); }
            if (list.length && (!actList || list.length > actList.length)) { actX = x; actList = list; }
        }
        const byRel = (x, y) => (col.rel[y] - col.rel[x]) || (col.fs[y] - col.fs[x]) || (col.id[y] - col.id[x]);
        const byNew = (x, y) => (col.fs[y] - col.fs[x]) || (col.id[y] - col.id[x]);
        const over = rowLim * 2 + 8;
        if (actList) actList = actList.sort(byRel).slice(0, over);
        const stTop = st0 >= 0 && stList.length ? stList.sort(byNew).slice(0, over) : null;
        const main = Array.from(topJ.subarray(0, len));
        const want = new Set();
        for (const arr of [main, actList || [], stTop || []]) for (const j of arr) want.add(col.id[j]);
        const rows = rowsByIds([...want]);
        const fam0 = K.familyOf(w.wk, w.ckey);
        const ctx = { t: s.at, act: s.act, imgProxy: s.json.imgProxy };
        const cards = (arr, n) => {
            const out = [];
            for (const j of arr) {
                if (out.length >= n) break;
                const r = rows.get(col.id[j]);
                if (!r || K.liveCount(r.sites, s.act) <= 0 || K.familyOf(r.wk, r.ckey) === fam0) continue;
                if (rvlNow(r) & 1) continue;   // 快照之后才变成审查级的:不当相关推荐
                out.push(K.card(r, ctx));
            }
            return out;
        };
        const out = { items: cards(main, lim), actress: null, studio: null };
        if (actList) {
            const items = cards(actList, rowLim);
            const a2 = s.json.actors[actX];
            if (items.length && a2) out.actress = { aid: a2[0], name: a2[1], items };
        }
        if (stTop) {
            const items = cards(stTop, rowLim);
            const name = s.json.studios[st0];
            if (items.length && name) out.studio = { id: name, label: name, items };
        }
        return out;
    }

    // ---------- 刷一刷 ----------
    function feed(a) {
        const out = { items: [], cursor_next: null };
        const s = getS();
        if (!s || !s.feedA) return out;
        const vert = !!(a && a.vert);
        const arr = vert ? s.feedV : s.feedA;
        const lim = clamp(a && a.limit, 1, 30, 10);
        let pos = 0;
        const c = a && a.cursor ? decCursor(a.cursor) : null;
        if (c) {
            if (c[0] === s.sid && c[3] === (vert ? 1 : 0) && Number.isInteger(c[1]) && c[1] >= 0 && c[1] <= arr.length) pos = c[1];
            else {   // 快照换了 / 换了竖屏开关:从上一个作品之后接着走;找不到 = 到底
                pos = -1;
                for (let k = 0; k < arr.length; k++) if (s.col.id[arr[k]] === c[2]) { pos = k + 1; break; }
                if (pos < 0) return out;
            }
        }
        const now = Number(a && a.t) || Date.now();
        const ctx = { t: s.at, act: s.act, imgProxy: s.json.imgProxy };
        let scanned = 0, next = pos;
        while (next < arr.length && out.items.length < lim && scanned < C.feedScanMax) {
            const batch = [];
            for (let k = next; k < arr.length && batch.length < 32 && scanned + batch.length < C.feedScanMax; k++) batch.push(k);
            if (!batch.length) break;
            const ids = batch.map((k) => s.col.id[arr[k]]);
            const rows = rowsByIds(ids);
            const wks = [...rows.values()].map((r) => r.wk);
            const lines = new Map();
            if (wks.length) {
                for (const r of q(`SELECT i.wk, i.site, i.vod_id, i.name, i.type_name, i.play_url, i.play_at, i.dur, i.dead, i.ok_at, i.last_seen, i.orient FROM adult_items i
                                     WHERE i.wk IN (${wks.map(() => '?').join(',')}) AND ${ELIG_I}`).all(...wks)) {
                    if (!lines.has(r.wk)) lines.set(r.wk, []);
                    lines.get(r.wk).push(r);
                }
            }
            for (const k of batch) {
                next = k + 1;
                scanned++;
                const r = rows.get(s.col.id[arr[k]]);
                if (!r || K.liveCount(r.sites, s.act) <= 0) continue;
                if (rvlNow(r)) continue;   // 快照之后才变成审查级(含 filter)的:不进刷一刷
                const maxDur = r.bucket === 'short' ? C.feedMaxDur : C.feedMaxDurLive;
                const best = new Map();
                for (const it of lines.get(r.wk) || []) {
                    if (it.dead || !s.act.has(it.site) || !it.play_url || !(it.play_at > 0) || now - it.play_at > C.feedPlayTtlMs) continue;
                    if (it.dur > 0 && (it.dur < C.feedMinDur || it.dur > maxDur)) continue;
                    const url = firstM3u8(it.play_url);
                    if (!url) continue;
                    const cand = { site: it.site, vod_id: it.vod_id, vod_name: it.name || '', type_name: it.type_name || '', url, dur: it.dur || 0, orient: K.ORIENTS.has(it.orient) ? it.orient : '', _ok: it.ok_at || 0, _seen: it.last_seen || 0 };
                    const b = best.get(it.site);
                    if (!b || cand._ok > b._ok || (cand._ok === b._ok && cand._seen > b._seen)) best.set(it.site, cand);
                }
                const rank = (x) => (x.orient === 'v' ? 0 : x.orient === '' || x.orient === 'sq' ? 1 : 2);
                const ls = [...best.values()].sort((x, y) => (rank(x) - rank(y)) || (y._ok - x._ok) || (y._seen - x._seen)).slice(0, C.feedLines)
                    .map((x) => ({ site: x.site, vod_id: x.vod_id, vod_name: x.vod_name, type_name: x.type_name, url: x.url, dur: x.dur, orient: x.orient }));
                if (!ls.length) continue;
                out.items.push(Object.assign(K.card(r, ctx), { orient: K.ORIENTS.has(r.orient) ? r.orient : '', dur: r.dur || r.dur_med || 0, lines: ls }));
                if (out.items.length >= lim) break;
            }
        }
        if (next < arr.length) out.cursor_next = encCursor([s.sid, next, next > 0 ? s.col.id[arr[next - 1]] : null, vert ? 1 : 0]);
        return out;
    }

    return { related, feed };
}

module.exports = { buildFeed, createRelFeed, firstM3u8, encCursor, decCursor };
