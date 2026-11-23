// [adult] 相关推荐 + 刷一刷(第四阶段,读线程;snapshot.js 用)。全部按快照的位图 / 列 / 演员 CSR 算,SQL 只取最后要出的那几行。
//
// 相关推荐 related(wk):
//   打分 = 3 × 共同 AVDB 演员(最多 3 位)+ 2 × 同片商或同厂牌前缀 + 精选标签 Jaccard(0..1)+ 1 × 同分区。
//   只用 featured 标签算(审查级标签永不当种子,也不参与打分);候选必须有演员 / 片商 / 标签之一的关联(只同分区不算),
//   标签那一路 Jaccard 至少 relatedMinJac。排除:作品自己、同一部片的一家子(番号作品同 ckey 的 正片 / ~N / #clip / #U,
//   片名作品同键的 ~N)、片段、一切审查级作品(rvl ≠ 0 = 审查级 code / hide、带审查级标签、分类审查级 filter —— 和刷一刷、
//   「猜你喜欢」browse nr=1 同一口径:审查级只能筛选,永不被推荐);只出快照里的可见作品(vis=1、ELIG、启用站上有活线路)。
//   另给两行:她的其它作品(作品的演员里可见作品最多的那位,按发行日期)、同片商(按首见时间),两行同样不出审查级作品。
// 刷一刷 feed:
//   快照建好时预算两条序列(buildFeed):全部(已知竖屏 → 方向未知 / 方形 → 横屏)与只竖屏;每层按天分槽、槽内按家族轮流、同家族连续 ≤ feedMaxRun。
//   有线路来自「烧了水印」来源(C.feedWm,common.js FEED_WM)的作品另成三层(3..5),整体排在所有干净作品后面(不删)。
//   入选:分区 short(时长知道时 8..300s),或 live / creators 且 已知竖屏 且 时长 8..180s;片段 / 审查级(作品审查级或带审查级标签)一律不进。
//   取一页时现查线路:启用站、没判死、播放地址 feedPlayTtlMs 内、第一集是 m3u8 → lines[{site, vod_id, vod_name, type_name, url, dur, orient}]
//   (每站一条,竖屏线路在前,≤ feedLines 条;vod_name / type_name 是这条线路自己的片名 / 分类名,闸门按它逐条复查);
//   一条能播的线路都没有的作品跳过。
//   游标 = [快照 id, 位置, 上一个作品 id, vert, 它的层, 它的首见时间, 它的家族标签(家族名的哈希)](上一个 = 这一页扫到的最后一个)。快照换了(每 homeMs 重建,
//   方向学习 / 隐藏 / 线路判死都会让作品换层或离开)不靠"找到上一个作品":它还在、层 / 首见 / 家族都没变 → 紧接着它;否则按 (层, 首见, id)
//   在新序列里找回分界(resumeAt:把它虚插回它那一层、按 buildFeed 的顺序重放一遍),宁可重给几张(客户端去重)也不跳过没看过的;
//   不会因为它不见了就当到底。旧的 4 元游标:作品还在就接着它,不在就按旧位置。
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
    const tier = (k) => order(Array.isArray(tiers[k]) ? tiers[k] : []);
    // 干净的三层在前,烧了水印的三层(下标 3..5)排在所有干净作品后面。
    //   竖屏序列 = 已知竖屏 + 方向还没量过 / 方形的(2026-11-23 用户:竖屏只有不到 10 个 —— 方向只有被人播过、量到宽高报回来才知道,
    //   以前只收已知竖屏,短视频分区绝大多数没量过就一条都进不来);已知横屏的不进。没量过的里头真是横屏的,刷短片放的时候量到就跳过并上报,
    //   下一次快照就排除了。顺序:已知竖屏 → 没量过 → 带水印的已知竖屏 → 带水印没量过
    const v = tier(0), u = tier(1), hz = tier(2), vW = tier(3), uW = tier(4), hzW = tier(5);
    const all = v.concat(u, hz, vW, uW, hzW).slice(0, C.feedPoolMax);
    const vAll = v.concat(u, vW, uW).slice(0, C.feedPoolMax);
    const feedV = make(Int32Array, vAll.length);
    feedV.set(vAll);
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
// [sid, pos, 作品 id|null, vert] 或 [… , 层 0..5(3..5 = 烧了水印的),首见(ms), 家族|null];形状不对 = null(从头)
function decCursor(x) {
    try {
        const c = JSON.parse(Buffer.from(String(x), 'base64url').toString('utf8'));
        if (!Array.isArray(c) || (c.length !== 4 && c.length !== 7)) return null;
        if (c[2] != null && !Number.isInteger(c[2])) return null;
        if (c.length === 7 && !(Number.isInteger(c[4]) && c[4] >= 0 && c[4] <= 5 && Number.isFinite(c[5]) && (c[6] == null || (typeof c[6] === 'string' && c[6].length <= 64)))) return null;
        return c;
    } catch (_) { return null; }
}
// 刷一刷的层:0 已知竖屏 / 1 方向未知或方形 / 2 横屏(和 snapshot.js 建 feedTiers 同口径:ori 1 竖 2 横 3 方 0 未知)
const tierOfOri = (o) => (o === 1 ? 0 : o === 2 ? 2 : 1);
// 刷一刷里的层:方向层,烧了水印的(快照 col.wm)再 +3(排在所有干净作品后面;游标存的就是它,数字大小 = 先后)
const tierOf = (col, i) => tierOfOri(col.ori[i]) + (col.wm && col.wm[i] ? 3 : 0);

// o = {q, C, getS, L:{B_CLIP, B_TAG, FEATI, REV:Set(审查级标签 id)}}
function createRelFeed(o) {
    const { q, C, getS, L } = o;
    const FEATI = L.FEATI;
    // 审查级复查:快照的 col.rvl 是建快照那一刻的;快照之后爬虫 / 回填 / 搜索回写给作品加了带审查级标签的线路(或 review 变成 code)
    //   要马上不出 —— 卡片行是现读的,这里按库里【现在】的 tags / review 再判一次(和 snapshot.js rvl 同口径:1 = code 或带审查级标签,2 = filter);
    //   相关 / 演员行 / 片商行 / 刷一刷 一律要 rvlNow = 0(任何一位都不行)
    const REV = L.REV instanceof Set && L.REV.size ? L.REV : K.NONFEATURED_LEGACY;
    const RCOLS = K.WCOLS + ', w.ckey, w.orient, w.tags AS rtags, w.review AS rreview';
    const rvlNow = (r) => K.rvlOf(r.rreview, r.rtags, REV);
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
        // 没有活封面的作品(cov=0:快照里不在"全部"位图)不当相关 / 演员行 / 片商行(和首页 / 浏览同口径);种子自己没封面不影响找相关
        const BA = L.B_ALL == null ? 0 : L.B_ALL;
        const listed = (j) => (bits[BA * W + (j >>> 5)] >>> (j & 31)) & 1;
        // 审查级(rvl 任何一位:code / hide / 审查级标签 / 分类 filter)既不打分也不进演员行 / 片商行;没有 rvl 列 = 一个不给(fail-closed)
        const bad = (j) => j === i || !listed(j) || isClip(j) || !col.rvl || col.rvl[j] !== 0;
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
                if (rvlNow(r)) continue;   // 快照之后才变成审查级的(含分类 filter):不当相关推荐
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
    // 家族的短标签(游标里带它而不带家族名:家族名不出服务器、长度有界);没有家族名 = null(按自成一家算)
    const famName = (s, i) => { const f = s.json && s.json.fams; const v = f ? f[s.col.fam[i]] : null; return typeof v === 'string' ? U.hash31('fam:' + v).toString(36) : null; };
    // 快照换了(或换了竖屏开关)的游标 → 在新序列 arr 里从哪接着走。c 见 decCursor。
    //   上一个作品(锚)还在、层 / 首见 / 家族都没变 → 紧接着它(和原来一样,0 重 0 漏)。
    //   否则按锚在旧快照里的 (层, 首见, id, 家族) 判每个元素"之前给过没有":别的层按层先后定;
    //   锚那一层按 buildFeed 的顺序(首见倒序 → 天槽里家族轮流 → 同家族连续 ≤ feedMaxRun)把锚虚插回去重放一遍,排在它前面的算给过
    //   (O(层大小 × 家族数),只在快照换了之后的第一页算一次);
    //   锚自己(换了层还在的)算给过。再挑分界 p 使 重给(p 之后给过的)+ 3 × 漏掉(p 之前没给过的)最小(同分取前面:宁可重给,客户端去重;
    //   漏掉的这一轮就再也刷不到了)。
    //   全都给过 → 到底(真的到底);绝不因为锚不见了就到底。旧的 4 元游标(没有层 / 首见):锚在就接着它,不在就按旧位置。
    function resumeAt(s, arr, c) {
        const col = s.col, n = arr.length, aid = c[2];
        let at = -1;
        if (aid != null) for (let k = 0; k < n; k++) if (col.id[arr[k]] === aid) { at = k; break; }
        if (c.length < 7) return at >= 0 ? at + 1 : (Number.isInteger(c[1]) ? Math.max(0, Math.min(n, c[1])) : 0);
        const tA = c[4], fsA = c[5], famA = c[6] == null ? null : c[6];
        // 快捷路:锚的层、首见、家族都没变才紧接着它。家族也要比:首见站的线路被保留期删了 / 重新归键、首见站停用了(退回按站 key 算)、
        //   家族配置改了 → 锚在它那个天槽里的轮流位置变了,紧接着它会整批重给或漏掉(复核:真实刷一刷 5188 条,重给 6..772 张)→ 走下面的重放
        if (at >= 0 && tierOf(col, arr[at]) === tA && col.fs[arr[at]] === fsA && famName(s, arr[at]) === famA) return at + 1;
        const before = new Uint8Array(n);
        const same = [];
        for (let k = 0; k < n; k++) {
            const i = arr[k];
            if (aid != null && col.id[i] === aid) { before[k] = 1; continue; }   // 锚自己(换了层 / 首见还在序列里):给过了
            const t = tierOf(col, i);
            if (t !== tA) { before[k] = t < tA ? 1 : 0; continue; }
            same.push(k);
        }
        if (same.length) {
            // 锚那一层:按 buildFeed 的顺序原样重放一遍(首见倒序 → 天槽里家族轮流 → 同家族连续 ≤ feedMaxRun 时把后面别家的提上来,
            //   会跨天槽),锚按旧的 (首见, id, 家族) 虚插进去;排在它前面的 = 旧序列里它前面的(给过了)
            const ent = same.map((k) => { const i = arr[k]; return { f: col.fs[i], id: col.id[i], fam: famName(s, i), k }; });
            const A = { f: fsA, id: aid == null ? -1 : aid, fam: famA, k: -1 };
            ent.push(A);
            ent.sort((x, y) => (y.f - x.f) || (y.id - x.id));
            const famOf = (e) => (e.fam == null ? '\u0000' + e.id : e.fam);   // 家族不知道 = 自成一家
            const slotOf = (e) => Math.floor(e.f / C.feedSlotMs);
            const seq = U.interleave(U.slotRoundRobin(ent, famOf, slotOf), famOf, ent.length, C.feedMaxRun, true);
            const pa = seq.indexOf(A);
            for (let q = 0; q < seq.length; q++) if (seq[q].k >= 0) before[seq[q].k] = q < pa ? 1 : 0;
        }
        let dups = 0;
        for (let k = 0; k < n; k++) dups += before[k];
        let best = 0, bestCost = dups, skips = 0;
        for (let p = 1; p <= n; p++) {
            if (before[p - 1]) dups--; else skips++;
            const cost = dups + 3 * skips;
            if (cost < bestCost) { bestCost = cost; best = p; }
        }
        return best;
    }
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
            else pos = resumeAt(s, arr, c);   // 快照换了 / 换了竖屏开关:按 (层, 首见, id) 找回分界接着走(见 resumeAt)
        } else if (a && a.rand && arr.length > 1) {
            // 随机起点(每次打开 / 换一批不一样):只在前面干净作品那段里挑(烧了水印的排在最后,别一开头就落进去)
            let clean = 0;
            const wm = s.col.wm;
            while (clean < arr.length && !(wm && wm[arr[clean]])) clean++;
            const span = clean > 1 ? clean : arr.length;
            pos = Math.floor(Math.random() * Math.max(1, span - Math.min(lim, Math.floor(span / 2))));
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
        if (next < arr.length) {
            if (next > 0) {
                const i = arr[next - 1];
                out.cursor_next = encCursor([s.sid, next, s.col.id[i], vert ? 1 : 0, tierOf(s.col, i), s.col.fs[i], famName(s, i)]);
            } else out.cursor_next = encCursor([s.sid, 0, null, vert ? 1 : 0]);
        }
        return out;
    }

    return { related, feed };
}

module.exports = { buildFeed, createRelFeed, firstM3u8, encCursor, decCursor, tierOfOri, tierOf };
