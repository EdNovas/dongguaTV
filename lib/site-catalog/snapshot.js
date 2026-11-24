// [adult] 目录的读取端(第三阶段):每 10 分钟一次的位图快照 + 浏览 / 分面 / 首页行 / 本地查找。
//
//   生产:跑在 lib/site-catalog/worker.js 的两个读线程里(各自一条 query_only 连接)。快照由其中一个读线程建好,
//     大数组放在 SharedArrayBuffer 里交给另一个读线程(零拷贝);主线程只拿 JSON 部分(首页行 / 分区计数 / 标签云 / 片商 / 标签页)。
//     浏览、分面、联想、本地查找都在读线程里算,主线程只收发消息 —— 20 万作品的分面计数也不会卡主线程(调研 §2.2:池 0.5 ms vs 主线程 26–1449 ms)。
//   测试 / inline:同一份代码在主线程上直接跑。
//
// 快照内容(只含 vis=1、审查通过、至少一条活线路在启用站上的作品,N 个):
//   位图(每个 ⌈N/32⌉ 个 Uint32):全部 / 片段 / 线路≥3 / 有发行日期 / 有热度 / 17 个分区 / 6 档时长 / 6 种版本 / 每个非 blocked 标签;
//   列:作品 id / 首见 / 最近一条线路的首见 / 时长 / 线路数 / 分区 / 家族 / 片商 / 厂牌前缀 / 发行日 / 热度 / 随机键;
//   排序:new(按小时槽轮流 + 同家族连续 ≤4,全局一份 + 每个分区一份)/ updated / released / hot / dur / lines / rand(北京时间日种子);
//   演员:作品→演员 与 演员→作品 两份 CSR。
//   第四阶段:列 nft(精选标签数)/ rvl(审查级:1 = code 或带审查级标签,2 = 分类 filter;rvl ≠ 0 只能筛选,首页各行(含大类行)/ 相关 /
//   演员行 / 片商行 / 刷一刷 / 猜你喜欢 nr=1 一律不出)/ ori(方向);刷一刷两条预算序列 feedA / feedV
//   (relfeed.js buildFeed);相关推荐 / 刷一刷的读取也在 relfeed.js(读线程,OPS related / feed)。
//   预算好:每个分区(含全部)不带别的筛选时的分面、标签云、片商榜、每个标签的分区分布与相关标签(lift,只 featured,支持度 ≥5)。
// 浏览:筛选 = 位图按位与(包含标签 AND、排除标签 AND NOT、时长 / 版本单选、片商 / 演员 / 厂牌前缀),
//   一页 = 选定排序数组里前 24 个命中;标签分面计数 = 当前筛选再"且"上这个标签(和点进去的结果数一致;同组标签也是"且");
//   分区 / 时长 / 版本 / 片商 / 演员这些单选维度仍按析取算(不套本维度自己的选择:换一个选项的结果数)。
//   未知 / blocked 的标签 id、未知片商 / 演员 → 空结果(不回显)。
'use strict';

const U = require('./util');
const K = require('./common');
const RF = require('./relfeed');

const { DAY, HOUR } = U;
const { ELIG, F_ZH, F_UNC, F_LEAK, F_UHD } = K;
const PAGE = 24;

// ---------- 位运算 ----------
function pc32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
function popAnd(a, b, bOff, W) { let n = 0; for (let w = 0; w < W; w++) n += pc32(a[w] & b[bOff + w]); return n; }
function popAll(a, W) { let n = 0; for (let w = 0; w < W; w++) n += pc32(a[w]); return n; }
const sab = (Ctor, n) => new Ctor(new SharedArrayBuffer(Math.max(1, n) * Ctor.BYTES_PER_ELEMENT));
const CTORS = { Int32Array, Uint32Array, Uint16Array, Uint8Array, Float64Array };
function share(a) { return { c: a.constructor.name, b: a.buffer, n: a.length }; }
function unshare(x) { return new CTORS[x.c](x.b, 0, x.n); }

function createReader(o) {
    const d = o.db;
    const A = o.adult;
    const T = A.title, P = A.policy, X = A.taxonomy;
    const TG = K.tagsOf(A, o.tags);
    const C = o.C;
    const logFn = typeof o.log === 'function' ? o.log : () => {};
    const NAVB = X.NAV_BUCKETS.slice();
    const NAV = new Set(NAVB);
    const NB = NAVB.length;
    const BIDX = new Map(NAVB.map((b, i) => [b, i]));
    const TAGS = TG.VOCAB.filter((t) => t.kind !== 'blocked').map((t) => t.id);
    const TIDX = new Map(TAGS.map((id, i) => [id, i]));
    const FEAT = TAGS.filter((id) => TG.isFeatured(id));
    const FEATSET = new Set(FEAT);
    const REVIEW = TAGS.filter((id) => TG.isReview(id));
    const REVSET = new Set(REVIEW);
    const GROUP_OF = new Map(TAGS.map((id) => [id, TG.group(id) || '']));
    const GROUP_ROWS = (TG.GROUPS || []).map((g) => ({ id: g.id, label: g.label }));
    const DURS = K.DUR_CLASSES;
    const DIDX = new Map(DURS.map((x, i) => [x[0], i]));
    const VARS = K.VARIANTS;
    const VIDX = new Map(VARS.map((x, i) => [x[0], i]));
    // 位图布局
    const B_ALL = 0, B_CLIP = 1, B_MULTI = 2, B_REL = 3, B_HOT = 4, B_BUCKET = 5, B_DUR = B_BUCKET + NB, B_VAR = B_DUR + DURS.length, B_TAG = B_VAR + VARS.length;
    const NBITS = B_TAG + TAGS.length;
    const stmts = new Map();
    const q = (sql) => { let s = stmts.get(sql); if (!s) { s = d.prepare(sql); stmts.set(sql, s); } return s; };
    const warnAt = new Map();
    const warn = (tag, m) => { const t = Date.now(); if ((warnAt.get(tag) || 0) + 60e3 > t) return; warnAt.set(tag, t); try { logFn(tag + ': ' + m); } catch (_) { /* */ } };
    let S = null;               // 当前快照
    const fcache = new Map();   // 分面 LRU(按筛选键;换快照清空)
    // 第四阶段:相关推荐 / 刷一刷(relfeed.js)
    const RFX = RF.createRelFeed({ q, C, getS: () => S, L: { B_ALL, B_CLIP, B_TAG, FEATI: FEAT.map((id) => TIDX.get(id)), REV: REVSET } });
    // 站长追加屏蔽词:本线程的 policy 实例按库里的词表来(写线程改了会再发 setExtraBlock 过来);坏了 = 保持现状并告警
    try {
        const r = d.prepare("SELECT v FROM adult_meta WHERE k='admin:block'").get();
        if (r && r.v != null && typeof P.setExtraBlock === 'function') P.setExtraBlock(JSON.parse(r.v));
    } catch (e) { warn('admin:block', e.message); }

    // ---------- 建快照 ----------
    // req = {t, sites:[启用站 normSite], imgProxy, extHotKey}
    function build(req) {
        const t0 = Date.now();
        const t = req.t;
        const act = new Map((req.sites || []).map((s) => [s.key, s]));
        const famIdx = new Map();
        const famOfSite = (k) => { const s = act.get(k); const f = (s && s.family) || k || ''; let i = famIdx.get(f); if (i == null) { i = famIdx.size; famIdx.set(f, i); } return i; };
        const nMax = q(`SELECT COUNT(*) n FROM adult_works w WHERE w.vis=1 AND ${ELIG}`).get().n;
        const W = Math.max(1, Math.ceil(nMax / 32));
        const bits = sab(Uint32Array, NBITS * W);
        const id = sab(Int32Array, nMax), fs = sab(Float64Array, nMax), la = sab(Float64Array, nMax), dur = sab(Int32Array, nMax);
        const ns = sab(Uint16Array, nMax), bk = sab(Uint8Array, nMax), fam = sab(Uint16Array, nMax), st = sab(Int32Array, nMax), lb = sab(Int32Array, nMax);
        const rel = sab(Int32Array, nMax), hot = sab(Int32Array, nMax), rnd = sab(Uint32Array, nMax);
        // 第四阶段:精选标签数(相关推荐的 Jaccard 分母)/ 审查级(1 = 审查级 code 或带审查级标签,2 = 分类审查级 filter)/ 方向(0 未知 1 竖 2 横 3 方)
        const nft = sab(Uint8Array, nMax), rvl = sab(Uint8Array, nMax), ori = sab(Uint8Array, nMax);
        const feedTiers = [[], [], [], [], [], []];   // 刷一刷候选:已知竖屏 / 未知或方形 / 横屏;后三层 = 同样三种但有线路来自烧了水印的来源(C.feedWm)
        // 有线路来自「烧了水印」来源的作品(水印在视频本身,别站转载的同一段也有):刷一刷排到所有干净作品后面
        const wmWks = new Set();
        for (const r0 of (Array.isArray(C.feedWm) ? C.feedWm : [])) {
            if (!r0 || typeof r0.site !== 'string' || typeof r0.type !== 'string') continue;
            const minId = Number(r0.minId) > 0 ? Number(r0.minId) : null;
            const sqlWm = 'SELECT DISTINCT wk FROM adult_items WHERE site = ? AND type_name = ?' + (minId ? ' AND CAST(vod_id AS INTEGER) >= ?' : '');
            try { for (const x of d.prepare(sqlWm).all(...(minId ? [r0.site, r0.type, minId] : [r0.site, r0.type]))) wmWks.add(x.wk); } catch (_) { /* 查不到 = 不降级 */ }
        }
        const wm = sab(Uint8Array, nMax);
        const set = (k, i) => { bits[k * W + (i >>> 5)] |= (1 << (i & 31)); };
        const studios = new Map(), labels = new Map(), actors = new Map();
        const studioNames = [], labelNames = [], actorRows = [];
        const workActs = [];
        const tagBucket = new Uint32Array(TAGS.length * NB);
        const co = new Uint32Array(FEAT.length * FEAT.length);
        const fIdx = new Map(FEAT.map((x, i) => [x, i]));
        const todayB = new Array(NB).fill(0);
        let todayAll = 0;
        const today = U.dayNo(t), dayStart = t - DAY;
        const seed = U.hash31('rand:' + today);
        let N = 0, NL = 0;
        const perL = [];   // 每位演员能列出来的作品数(有活封面、不是片段 —— 演员页 = browse({actress}) 不出片段;演员搜索的部数和它一致)
        const sql = `SELECT w.id, w.wk, w.bucket, w.tags, w.flags, w.is_clip, w.first_seen, w.line_at, w.dur, w.n_sites, w.live_sites, w.first_site, w.released,
                            w.studio, w.hot, w.rand, w.actress, w.ckey, w.orient, w.review, w.cov FROM adult_works w WHERE w.vis=1 AND ${ELIG}`;
        for (const r of d.prepare(sql).raw(true).iterate()) {
            const [wid, wk, bucket, tags, flags, isClip, first, lineAt, du, nsites, liveSites, firstSite, released, studio, hotv, rand, actress, ckey, orient, review, cov] = r;
            if (N >= nMax) break;
            const b = BIDX.get(bucket);
            if (b == null || !K.liveCount(liveSites, act)) continue;
            const i = N++;
            id[i] = wid; fs[i] = first; la[i] = lineAt || first; dur[i] = du || 0; ns[i] = Math.min(65535, nsites || 0); bk[i] = b;
            fam[i] = famOfSite(firstSite);
            hot[i] = hotv || 0;
            rnd[i] = Math.imul((rand ^ seed) >>> 0, 0x9e3779b1) >>> 0;
            // 封面域名健康:没有活封面的作品(cov=0)不进"全部"位图 —— 浏览 / 分面计数 / 首页各行 / 相关 / 演员页 / 标签页都从它出发,
            //   一起不出(计数和列表一致);其余位 / 列照常(作品页打开它时相关推荐还能拿它当种子;刷一刷要播放、不看封面,照常入选)
            const listed = cov !== 0;
            // 能在不分区的列表里出现的(有活封面、不是片段):标签页总数 / 相关标签的 lift / 演员部数都按它数(和点进去的列表一致)
            const listedNc = listed && !isClip;
            if (listed) set(B_ALL, i);
            if (listedNc) NL++;
            set(B_BUCKET + b, i);
            if (isClip) set(B_CLIP, i);
            if (nsites >= 3) set(B_MULTI, i);
            if (hotv > 0) set(B_HOT, i);
            const rd = K.relDay(released);
            rel[i] = rd;
            if (rd) set(B_REL, i);
            let dc = DURS.length - 1;
            if (du > 0) for (let k = 0; k < DURS.length - 1; k++) if (du >= DURS[k][1] && du <= DURS[k][2]) { dc = k; break; }
            set(B_DUR + dc, i);
            const tl = String(tags || '').split(',').filter(Boolean);
            const has = (x) => tl.indexOf(x) >= 0;
            if ((flags & F_ZH) || bucket === 'jp_subbed' || has('subbed')) set(B_VAR + VIDX.get('zh'), i);
            if ((flags & F_UNC) || bucket === 'jp_uncensored' || has('uncensored')) set(B_VAR + VIDX.get('unc'), i);
            if ((flags & F_LEAK) || /#U(?=$|[#~])/.test(wk) || has('leak_unc')) set(B_VAR + VIDX.get('leak'), i);
            if (has('vr')) set(B_VAR + VIDX.get('vr'), i);
            if ((flags & F_UHD) || has('uhd')) set(B_VAR + VIDX.get('4k'), i);
            if (bucket === 'short' || has('vertical')) set(B_VAR + VIDX.get('vertical'), i);
            const fl = [];
            let revTag = false;
            for (const x of tl) {
                const ti = TIDX.get(x);
                if (ti == null) continue;
                set(B_TAG + ti, i);
                // 标签页的分区计数 = 点进去的 browse({t, b}):片段只在「AV解说」里算(makeSet 的 andNot(B_CLIP))
                if (listed && (!isClip || bucket === 'commentary')) tagBucket[ti * NB + b]++;
                const fi = fIdx.get(x);
                if (fi != null) fl.push(fi);
                if (REVSET.has(x)) revTag = true;
            }
            nft[i] = Math.min(255, fl.length);
            rvl[i] = (review === 'code' || revTag ? 1 : 0) | (review === 'filter' ? 2 : 0);
            const oc = orient === 'v' ? 1 : orient === 'h' ? 2 : orient === 'sq' ? 3 : 0;
            ori[i] = oc;
            // 刷一刷:short(时长知道时 8..300s)/ live·creators 已知竖屏且 8..180s;片段、审查级一律不进
            if (!isClip && !rvl[i]) {
                let fe = false;
                if (bucket === 'short') fe = !(du > 0) || (du >= C.feedMinDur && du <= C.feedMaxDur);
                else if (bucket === 'live' || bucket === 'creators') fe = oc === 1 && du >= C.feedMinDur && du <= C.feedMaxDurLive;
                if (fe) { wm[i] = wmWks.has(wk) ? 1 : 0; feedTiers[(oc === 1 ? 0 : oc === 2 ? 2 : 1) + (wm[i] ? 3 : 0)].push(i); }
            }
            if (listedNc) for (let a2 = 0; a2 < fl.length; a2++) for (let b2 = a2 + 1; b2 < fl.length; b2++) { co[fl[a2] * FEAT.length + fl[b2]]++; co[fl[b2] * FEAT.length + fl[a2]]++; }
            if (studio) { let si = studios.get(studio); if (si == null) { si = studioNames.length; studios.set(studio, si); studioNames.push(studio); } st[i] = si; } else st[i] = -1;
            const lp = typeof wk === 'string' && wk.indexOf('c:') === 0 && ckey && !/^UNC-/.test(ckey) ? String(ckey).split('-')[0] : '';
            if (lp) { let li = labels.get(lp); if (li == null) { li = labelNames.length; labels.set(lp, li); labelNames.push(lp); } lb[i] = li; } else lb[i] = -1;
            let al = null;
            // 国产自拍 / 约炮 / 直播 / 创作者分区的作品页不显示演员(index.js actressOf),演员索引 / 分面 / 演员页计数也不能算它们
            if (actress && !K.NO_ACTRESS_BUCKETS.has(bucket)) { try { al = JSON.parse(actress); } catch (_) { al = null; } }
            const ai = [];
            if (Array.isArray(al)) for (const p of al) {
                if (!Array.isArray(p) || p[0] == null || typeof p[1] !== 'string') continue;
                const key = String(p[0]);
                let x = actors.get(key);
                if (x == null) { x = actorRows.length; actors.set(key, x); actorRows.push([p[0], p[1]]); }
                if (ai.indexOf(x) < 0) ai.push(x);
            }
            workActs.push(ai);
            if (listedNc) for (const x of ai) perL[x] = (perL[x] || 0) + 1;
            if (listed && !isClip && first >= dayStart) { todayAll++; todayB[b]++; }
        }
        // 演员 CSR(作品→演员 / 演员→作品)
        let tot = 0;
        for (const a of workActs) tot += a.length;
        const aOff = sab(Int32Array, N + 1), aVal = sab(Int32Array, tot), iOff = sab(Int32Array, actorRows.length + 1), iVal = sab(Int32Array, tot);
        const per = new Int32Array(actorRows.length);
        for (let i = 0, p = 0; i < N; i++) { aOff[i] = p; for (const x of workActs[i]) { aVal[p++] = x; per[x]++; } aOff[i + 1] = p; }
        for (let x = 0, p = 0; x < actorRows.length; x++) { iOff[x] = p; p += per[x]; iOff[x + 1] = p; }
        const fill = new Int32Array(actorRows.length);
        for (let i = 0; i < N; i++) for (let p = aOff[i]; p < aOff[i + 1]; p++) { const x = aVal[p]; iVal[iOff[x] + fill[x]++] = i; }
        // 排序
        const idx = () => { const a = sab(Int32Array, N); for (let i = 0; i < N; i++) a[i] = i; return a; };
        const tie = (a, b) => (fs[b] - fs[a]) || (id[b] - id[a]);
        const byNew = idx().sort(tie);
        const famOf = (i) => fam[i];
        const slotOf = (i) => Math.floor(fs[i] / C.slotMs);
        const inter = (arr) => U.interleave(U.slotRoundRobin(arr, famOf, slotOf), famOf, arr.length, C.maxRun, true);
        const ordNew = sab(Int32Array, N);
        ordNew.set(inter(Array.from(byNew)));
        const ordNewB = sab(Int32Array, N), offB = sab(Int32Array, NB + 1);
        {
            const parts = Array.from({ length: NB }, () => []);
            for (let k = 0; k < N; k++) { const i = byNew[k]; parts[bk[i]].push(i); }
            let p = 0;
            for (let b = 0; b < NB; b++) { offB[b] = p; const arr = inter(parts[b]); ordNewB.set(arr, p); p += arr.length; }
            offB[NB] = p;
        }
        const ord = {
            new: ordNew,
            updated: idx().sort((a, b) => (la[b] - la[a]) || tie(a, b)),
            released: idx().sort((a, b) => (rel[b] - rel[a]) || tie(a, b)),
            hot: idx().sort((a, b) => (hot[b] - hot[a]) || tie(a, b)),
            dur: idx().sort((a, b) => (dur[b] - dur[a]) || tie(a, b)),
            lines: idx().sort((a, b) => (ns[b] - ns[a]) || tie(a, b)),
            rand: idx().sort((a, b) => (rnd[a] - rnd[b]) || (id[a] - id[b])),
        };
        const feed = RF.buildFeed({ tiers: feedTiers, fs, id, fam, C, make: sab });
        const snap = {
            sid: 'S' + t.toString(36) + '.' + U.hash31(String(t0) + ':' + N).toString(36), at: t, N, W,
            bits, col: { id, fs, la, dur, ns, bk, fam, st, lb, rel, hot, nft, rvl, ori, wm }, ord, newB: ordNewB, offB, aOff, aVal, iOff, iVal,
            feedA: feed.feedA, feedV: feed.feedV,
            json: {
                act: [...act.keys()], imgProxy: !!req.imgProxy, studios: studioNames, labels: labelNames, actors: actorRows,
                actorN: Array.from(per, (_, x) => perL[x] || 0),   // 每位演员能列出来的作品数(可见、有活封面、不是片段 = 演员页的总数),与 actors 对齐(女优搜索按它排、去掉目录里没片的)
                fams: [...famIdx.keys()],  // 家族名,下标 = col.fam(刷一刷游标跨快照接着走要按家族重放轮流顺序,见 relfeed.js resumeAt)
            },
        };
        install(snap);   // 本线程立刻用上(下面的预计算要用)
        // ---------- 预计算(JSON):首页、分区计数、每个分区的分面 / 标签云 / 片商榜、标签页 ----------
        const pre = { facets0: {}, tags: {}, studios: {}, tagInfo: {} };
        for (const b of [''].concat(NAVB)) {
            const F = parseF({ b });
            const fc = facetsFor(F);
            pre.facets0[b] = fc;
            const tagsOut = [];
            for (const g of fc.groups) for (const x of g.tags) if (x.count > 0) tagsOut.push({ id: x.id, label: x.label, count: x.count, featured: true, group: g.id });
            tagsOut.sort((a, c) => c.count - a.count || (a.id < c.id ? -1 : 1));
            pre.tags[b] = { groups: GROUP_ROWS.filter((g) => tagsOut.some((x) => x.group === g.id)), tags: tagsOut };
            pre.studios[b] = studioCounts(F, 100);
        }
        const tagCount = new Uint32Array(TAGS.length);
        // 只数能列出来的(有活封面、不是片段):和点进去的标签页 browse({t}) 一致(不分区的列表不出片段)
        const allRow = new Uint32Array(W);
        for (let w = 0; w < W; w++) allRow[w] = bits[B_ALL * W + w] & ~bits[B_CLIP * W + w];
        for (let ti = 0; ti < TAGS.length; ti++) tagCount[ti] = popAnd(allRow, bits, (B_TAG + ti) * W, W);
        for (let ti = 0; ti < TAGS.length; ti++) {
            const tid = TAGS[ti];
            const featured = FEATSET.has(tid);
            const info = { id: tid, label: TG.label(tid), group: GROUP_OF.get(tid) || '', count: tagCount[ti], featured, review: !featured };
            info.buckets = featured ? NAVB.map((b, k) => ({ id: b, label: X.bucketLabel(b), count: tagBucket[ti * NB + k] })).filter((x) => x.count > 0).sort((a, c) => c.count - a.count) : [];
            info.related = [];
            const fi = fIdx.get(tid);
            if (fi != null && NL > 0 && tagCount[ti] > 0) {
                const rel2 = [];
                for (let fj = 0; fj < FEAT.length; fj++) {
                    if (fj === fi) continue;
                    const nab = co[fi * FEAT.length + fj];
                    if (nab < C.relatedSupport) continue;
                    const nb = tagCount[TIDX.get(FEAT[fj])];
                    if (!nb) continue;
                    rel2.push({ id: FEAT[fj], label: TG.label(FEAT[fj]), lift: Math.round((nab * NL / (tagCount[ti] * nb)) * 10) / 10 });
                }
                rel2.sort((a, c) => c.lift - a.lift || (a.id < c.id ? -1 : 1));
                info.related = rel2.slice(0, 8);
            }
            pre.tagInfo[tid] = info;
        }
        const home = buildHome(req, { byNew, todayAll, todayB });
        snap.json.pre = pre;
        snap.json.home = home.home;
        snap.json.buckets = NAVB.map((b, k) => ({ id: b, label: X.bucketLabel(b), nav: true, today: todayB[k] }));
        snap.json.trust = home.trust;
        snap.json.ms = Date.now() - t0;
        return snap;
    }
    // 结构化克隆用的描述(大数组只传 SharedArrayBuffer 引用)
    function describe(s) {
        const ord = {};
        for (const k of Object.keys(s.ord)) ord[k] = share(s.ord[k]);
        const col = {};
        for (const k of Object.keys(s.col)) col[k] = share(s.col[k]);
        return {
            sid: s.sid, at: s.at, N: s.N, W: s.W, bits: share(s.bits), col, ord, newB: share(s.newB), offB: share(s.offB),
            aOff: share(s.aOff), aVal: share(s.aVal), iOff: share(s.iOff), iVal: share(s.iVal), json: s.json,
            feedA: share(s.feedA), feedV: share(s.feedV),
        };
    }
    function fromDesc(x) {
        const ord = {};
        for (const k of Object.keys(x.ord)) ord[k] = unshare(x.ord[k]);
        const col = {};
        for (const k of Object.keys(x.col)) col[k] = unshare(x.col[k]);
        return { sid: x.sid, at: x.at, N: x.N, W: x.W, bits: unshare(x.bits), col, ord, newB: unshare(x.newB), offB: unshare(x.offB),
            aOff: unshare(x.aOff), aVal: unshare(x.aVal), iOff: unshare(x.iOff), iVal: unshare(x.iVal), json: x.json,
            feedA: x.feedA ? unshare(x.feedA) : null, feedV: x.feedV ? unshare(x.feedV) : null };
    }
    function install(s) {
        const snap = s && s.bits && !(s.bits instanceof Uint32Array) ? fromDesc(s) : s;
        snap.studioIdx = new Map(snap.json.studios.map((n, i) => [n, i]));
        snap.labelIdx = new Map(snap.json.labels.map((n, i) => [n, i]));
        snap.actorIdx = new Map(snap.json.actors.map((a, i) => [String(a[0]), i]));
        snap.act = new Set(snap.json.act);
        S = snap;
        fcache.clear();
        return true;
    }

    // ---------- 首页行 ----------
    // nr:推荐位(首页各行 / 猜你喜欢 nr=1)—— 按库里【现在】的 review / tags 再判一次审查级(快照之后才变成审查级的也不出,和 relfeed rvlNow 同口径)
    const NR_COLS = K.WCOLS + ', w.tags AS rtags, w.review AS rreview';
    function cardsByIds(ids, ctx, nr) {
        const out = new Map();
        for (let k = 0; k < ids.length; k += 500) {
            const part = ids.slice(k, k + 500);
            for (const r of q(`SELECT ${nr ? NR_COLS : K.WCOLS} FROM adult_works w WHERE w.id IN (${part.map(() => '?').join(',')}) AND ${ELIG}`).all(...part)) {
                if (nr && K.rvlOf(r.rreview, r.rtags, REVSET) !== 0) continue;
                out.set(r.id, r);
            }
        }
        return out;
    }
    function extTrust(site, t) {
        let m = null;
        try { const r = q("SELECT v FROM adult_meta WHERE k='exthot:trust'").get(); m = r ? JSON.parse(r.v) : null; } catch (_) { m = null; }
        if (m && m.site === site.key && m.decided && t >= m.at && t - m.at < C.trustEveryMs) return { r: m, write: false };
        const rows = q('SELECT day, week, month, total, at, prev_total, prev_at FROM adult_hits WHERE site=? AND at >= ?').all(site.key, t - C.trustEveryMs);
        const r = Object.assign({ site: site.key, at: t }, U.hitsTrust(rows, { minN: C.trustMinN, minPairs: C.trustMinPairs, orderFrac: C.trustOrderFrac, growFrac: C.trustGrowFrac, gapMs: C.trustGapMs }));
        return { r, write: true };
    }
    function buildHome(req, x) {
        const s = S, t = req.t;
        const act = new Map((req.sites || []).map((v) => [v.key, v]));
        const ctx = { t, act: s.act, imgProxy: !!req.imgProxy };
        const isClip = (i) => (s.bits[B_CLIP * s.W + (i >>> 5)] >>> (i & 31)) & 1;
        const listed = (i) => (s.bits[B_ALL * s.W + (i >>> 5)] >>> (i & 31)) & 1;   // 有活封面(cov ≠ 0)
        // 首页每一行都是推荐位:审查级(rvl ≠ 0:审查级 code、带审查级标签、分类审查级 filter)一律不上首页 —— 新上架 / 本站·外站热门 / 新片速递 /
        //   大类行 / 随机发现 全都一样(只能在浏览里筛到;和相关、刷一刷、猜你喜欢 nr=1 同口径)。没有 rvl 列 = 一个不给(fail-closed)。
        //   卡片行(cardsByIds nr)再按库里现在的 review / tags 判一次。片段也不上首页
        const rv = s.col.rvl;
        const skip = (i) => !listed(i) || isClip(i) || !rv || rv[i] !== 0;   // 没有活封面的也不上首页
        const famOf = (i) => s.col.fam[i];
        const slotOf = (i) => Math.floor(s.col.fs[i] / C.slotMs);
        const rowsOut = [];
        const want = new Set();
        const plan = [];
        // 新上架:作品去重、1h 一槽轮流、同站连续 ≤4(宁可少几张)
        const pool = [];
        for (let k = 0; k < x.byNew.length && pool.length < C.poolSize; k++) { const i = x.byNew[k]; if (!skip(i)) pool.push(i); }
        const fresh = U.interleave(U.slotRoundRobin(pool, famOf, slotOf), famOf, C.rowSize, C.maxRun);
        if (fresh.length) plan.push({ id: 'new', title: '新上架', more: { sort: 'new' }, today: x.todayAll, list: fresh });
        // 热门(本站 → 外站 → 不显示),紧跟新上架
        let trust = null;
        const hotL = [];
        for (let k = 0; k < s.ord.hot.length && hotL.length < C.rowSize; k++) { const i = s.ord.hot[k]; if (s.col.hot[i] <= 0) break; if (!skip(i)) hotL.push(i); }
        if (hotL.length >= C.hotMin) plan.push({ id: 'hot', title: '本站热门', source: 'local', more: null, list: hotL });
        else {
            let site = null;
            for (const v of act.values()) if (v.extHot) { site = v; break; }
            if (!site && req.extHotKey) site = act.get(req.extHotKey) || null;
            if (site) {
                try {
                    const tr = extTrust(site, t);
                    if (tr.write) trust = tr.r;
                    if (tr.r.ok) {
                        const byId = new Map();
                        for (let i = 0; i < s.N; i++) byId.set(s.col.id[i], i);
                        const rows = q(`SELECT w.id, MAX(h.week) AS hw FROM adult_hits h
                                           JOIN adult_items i ON i.site = h.site AND i.vod_id = h.vod_id
                                           JOIN adult_works w ON w.wk = i.wk
                                           WHERE h.site=? AND h.at >= ? AND i.dead=0 AND COALESCE(i.review,'') <> 'hide' AND (COALESCE(i.review,'') <> 'code' OR i.code_ok = 1) AND w.is_clip=0
                                           GROUP BY w.id ORDER BY hw DESC, w.first_seen DESC LIMIT ?`).all(site.key, t - C.hitsFreshMs, C.hitsTop);
                        const ext = [];
                        for (const r of rows) { const i = byId.get(r.id); if (i != null && !skip(i)) ext.push(i); if (ext.length >= C.rowSize) break; }
                        if (ext.length >= Math.max(1, C.extHotMin)) plan.push({ id: 'hot', title: '外站热门', source: 'ext', more: null, list: ext });
                    }
                } catch (e) { warn('exthot', e.message); }
            }
        }
        // 新片速递:AVDB 发行日期在最近 60 天内、能播;不足 12 部不出
        {
            const dayNow = Math.floor((t + 8 * HOUR) / DAY);
            const list = [];
            for (let k = 0; k < s.ord.released.length; k++) {
                const i = s.ord.released[k];
                const r = s.col.rel[i];
                if (!r || r < dayNow - C.freshDays) break;
                if (r > dayNow + 1 || skip(i)) continue;
                list.push(i);
            }
            if (list.length >= C.freshMin) plan.push({ id: 'fresh', title: '新片速递', more: { sort: 'released' }, list: U.interleave(list, famOf, C.rowSize, C.maxRun, true) });
        }
        // 13 个大类行:最新一部超过 72h 或不足 12 部 → 不显示(候选池 = 这个分区最新的 400 部,按时间倒序)
        const pools = Array.from({ length: NB }, () => []);
        for (let k = 0; k < x.byNew.length; k++) { const i = x.byNew[k]; if (skip(i)) continue; const pl = pools[s.col.bk[i]]; if (pl.length < C.poolSize) pl.push(i); }
        for (const b of K.HOME_BUCKETS) {
            const bi = BIDX.get(b);
            if (bi == null) continue;
            const list = pools[bi];
            if (list.length < C.rowMin) continue;
            if (t - s.col.fs[list[0]] > C.rowStaleMs) continue;
            const items = U.interleave(U.slotRoundRobin(list, famOf, slotOf), famOf, C.rowSize, C.maxRun, true);
            plan.push({ id: b, title: X.bucketLabel(b), more: { b }, today: x.todayB[bi], list: items });
        }
        // 随机发现:北京时间日种子,同一天顺序不变
        {
            const list = [];
            for (let k = 0; k < s.ord.rand.length && list.length < C.rowSize; k++) { const i = s.ord.rand[k]; if (!skip(i)) list.push(i); }
            if (list.length >= C.rowMin) plan.push({ id: 'random', title: '随机发现', more: { sort: 'rand' }, list });
        }
        for (const p of plan) for (const i of p.list) want.add(s.col.id[i]);
        const rowsById = cardsByIds([...want], ctx, true);
        for (const p of plan) {
            const items = p.list.map((i) => rowsById.get(s.col.id[i])).filter(Boolean).map((w) => K.card(w, ctx));
            if (!items.length) continue;
            const row = { id: p.id, title: p.title };
            if ('source' in p) row.source = p.source;
            row.more = p.more;
            if (p.today != null) row.today = p.today;
            row.items = items;
            rowsOut.push(row);
        }
        return { home: { generatedAt: t, rows: rowsOut }, trust };
    }

    // ---------- 浏览 ----------
    const badF = { bad: true };
    // p:主线程整理好的参数 → 筛选(F)。不认识的 → {bad:true}
    function parseF(p) {
        const s = S;
        if (!s) return badF;
        // nr(复核 r3):不要审查级作品(rvl ≠ 0:code / 带审查级标签 / 分类 filter)—— 「猜你喜欢」这种推荐位用,审查级永不被推荐
        const F = { b: -1, bl: [], inc: [], exc: [], dur: -1, v: -1, st: -1, ac: -1, lp: -1, multi: !!p.multi, commentary: false, nr: !!p.nr };
        // b 可以是逗号分隔的几个分区(前端「日本」「国产」整类浏览 = 这一类的几个分区取并集);一个分区时照旧走 F.b(「最新」有分区内的现成顺序)
        if (p.b) {
            const parts = String(p.b).split(',');
            if (parts.length > 6) return badF;
            const idx = [];
            for (const x of parts) { const b = BIDX.get(x); if (b == null) return badF; if (idx.indexOf(b) < 0) idx.push(b); }
            if (idx.length === 1) { F.b = idx[0]; F.commentary = NAVB[idx[0]] === 'commentary'; }
            else F.bl = idx.sort((a, c) => a - c);   // 多个分区:片段照旧不出(「AV解说」不和别的分区合并浏览)
        }
        const tagIds = (arr) => {
            const out = [];
            for (const raw of Array.isArray(arr) ? arr.slice(0, 3) : []) {
                const r = typeof TG.resolve === 'function' ? TG.resolve(String(raw)) : (TIDX.has(raw) ? raw : '');
                const ti = r ? TIDX.get(r) : null;
                if (ti == null) return null;
                if (out.indexOf(ti) < 0) out.push(ti);
            }
            return out;
        };
        const inc = tagIds(p.t), exc = tagIds(p.x);
        if (!inc || !exc) return badF;
        F.inc = inc; F.exc = exc;
        if (p.dur) { const k = DIDX.get(p.dur); if (k == null) return badF; F.dur = k; }
        if (p.v) { const k = VIDX.get(p.v); if (k == null) return badF; F.v = k; }
        if (p.studio) { const k = s.studioIdx.get(p.studio); if (k == null) return badF; F.st = k; }
        if (p.actress != null && p.actress !== '') { const k = s.actorIdx.get(String(p.actress)); if (k == null) return badF; F.ac = k; }
        if (p.lp) { const k = s.labelIdx.get(p.lp); if (k == null) return badF; F.lp = k; }
        return F;
    }
    // skip:不套的那一维('b' / 'dur' / 'v' / 'st' / 'ac' / 'g:<组>')
    function makeSet(F, skip) {
        const s = S, W = s.W, bits = s.bits;
        const R = new Uint32Array(W);
        R.set(bits.subarray(B_ALL * W, (B_ALL + 1) * W));
        const and = (k) => { const o2 = k * W; for (let w = 0; w < W; w++) R[w] &= bits[o2 + w]; };
        const andNot = (k) => { const o2 = k * W; for (let w = 0; w < W; w++) R[w] &= ~bits[o2 + w]; };
        if (F.b >= 0 && skip !== 'b') and(B_BUCKET + F.b);
        if (F.bl.length && skip !== 'b') {
            const M = new Uint32Array(W);
            for (const b of F.bl) { const o2 = (B_BUCKET + b) * W; for (let w = 0; w < W; w++) M[w] |= bits[o2 + w]; }
            for (let w = 0; w < W; w++) R[w] &= M[w];
        }
        if (!(F.commentary && skip !== 'b')) andNot(B_CLIP);   // 片段只在「AV解说」里出
        if (F.multi) and(B_MULTI);
        const g = skip && skip.indexOf('g:') === 0 ? skip.slice(2) : null;
        for (const ti of F.inc) if (g == null || GROUP_OF.get(TAGS[ti]) !== g) and(B_TAG + ti);
        for (const ti of F.exc) andNot(B_TAG + ti);
        if (F.dur >= 0 && skip !== 'dur') and(B_DUR + F.dur);
        if (F.v >= 0 && skip !== 'v') and(B_VAR + F.v);
        const keep = (pred) => { for (let w = 0; w < W; w++) { let x = R[w]; while (x) { const lo = x & -x; const i = (w << 5) | (31 - Math.clz32(lo)); if (!pred(i)) R[w] &= ~lo; x ^= lo; } } };
        if (F.st >= 0 && skip !== 'st') keep((i) => s.col.st[i] === F.st);
        if (F.lp >= 0) keep((i) => s.col.lb[i] === F.lp);
        if (F.nr) { const rv = s.col.rvl; keep((i) => !!rv && !rv[i]); }   // 没有 rvl 列 = 一个不给(fail-closed)
        if (F.ac >= 0 && skip !== 'ac') {
            const M = new Uint32Array(W);
            for (let p = s.iOff[F.ac]; p < s.iOff[F.ac + 1]; p++) { const i = s.iVal[p]; M[i >>> 5] |= (1 << (i & 31)); }
            for (let w = 0; w < W; w++) R[w] &= M[w];
        }
        return R;
    }
    const fkey = (F) => [F.b, F.bl.join('.'), F.inc.join('.'), F.exc.join('.'), F.dur, F.v, F.st, F.ac, F.lp, F.multi ? 1 : 0, F.nr ? 1 : 0].join('|');
    function studioCounts(F, top) {
        const s = S, W = s.W;
        const R = makeSet(F, 'st');
        const cnt = new Uint32Array(s.json.studios.length);
        for (let w = 0; w < W; w++) { let x = R[w]; while (x) { const lo = x & -x; const i = (w << 5) | (31 - Math.clz32(lo)); const k = s.col.st[i]; if (k >= 0) cnt[k]++; x ^= lo; } }
        const out = [];
        for (let k = 0; k < cnt.length; k++) if (cnt[k]) out.push({ id: s.json.studios[k], label: s.json.studios[k], count: cnt[k] });
        out.sort((a, c) => c.count - a.count || (a.id < c.id ? -1 : 1));
        return out.slice(0, top);
    }
    function facetsFor(F) {
        const k = fkey(F);
        const hit = fcache.get(k);
        if (hit) { fcache.delete(k); fcache.set(k, hit); return hit; }
        const s = S, W = s.W, bits = s.bits;
        const R = makeSet(F, '');
        const out = { buckets: [], groups: [], more: [], dur: [], variant: [], studio: [], actress: [], sorts: [] };
        // 分区(不套分区这一维;片段只在「AV解说」里算)
        const RnoB = makeSet(F, 'b');
        for (let b = 0; b < NB; b++) {
            let n;
            if (NAVB[b] === 'commentary') n = popAll(makeSet(Object.assign({}, F, { b, commentary: true }), ''), W);
            else n = popAnd(RnoB, bits, (B_BUCKET + b) * W, W);
            if (n > 0) out.buckets.push({ id: NAVB[b], label: X.bucketLabel(NAVB[b]), count: n });
        }
        // 标签组(只 featured)。计数 = 在当前筛选(含本组已选的标签)上再加这个标签的结果数:浏览的 t= 是"且"(同组也是),
        //   按析取算(不套本组已选)的数会比点进去多(选了 人妻 后 骚货 显示 192、点进去 26)。已选的标签计数 = 当前总数
        for (const g of GROUP_ROWS) {
            const tags = [];
            for (const id of FEAT) {
                if (GROUP_OF.get(id) !== g.id) continue;
                const n = popAnd(R, bits, (B_TAG + TIDX.get(id)) * W, W);
                tags.push({ id, label: TG.label(id), count: n });
            }
            if (tags.some((x) => x.count > 0)) out.groups.push({ id: g.id, label: g.label, tags: tags.filter((x) => x.count > 0 || F.inc.indexOf(TIDX.get(x.id)) >= 0) });
        }
        // 审查级标签:只列名字不给计数(本筛选里有的才列)
        for (const id of REVIEW) if (popAnd(R, bits, (B_TAG + TIDX.get(id)) * W, W) > 0) out.more.push({ id, label: TG.label(id) });
        const Rd = F.dur >= 0 ? makeSet(F, 'dur') : R;
        for (let k = 0; k < DURS.length; k++) out.dur.push({ id: DURS[k][0], label: DURS[k][3], count: popAnd(Rd, bits, (B_DUR + k) * W, W) });
        const Rv = F.v >= 0 ? makeSet(F, 'v') : R;
        for (let k = 0; k < VARS.length; k++) { const n = popAnd(Rv, bits, (B_VAR + k) * W, W); if (n > 0 || F.v === k) out.variant.push({ id: VARS[k][0], label: VARS[k][1], count: n }); }
        out.studio = studioCounts(F, 20);
        {
            const Ra = F.ac >= 0 ? makeSet(F, 'ac') : R;
            const cnt = new Uint32Array(s.json.actors.length);
            for (let w = 0; w < W; w++) { let x = Ra[w]; while (x) { const lo = x & -x; const i = (w << 5) | (31 - Math.clz32(lo)); for (let p = s.aOff[i]; p < s.aOff[i + 1]; p++) cnt[s.aVal[p]]++; x ^= lo; } }
            const list = [];
            for (let a = 0; a < cnt.length; a++) if (cnt[a]) list.push({ aid: s.json.actors[a][0], name: s.json.actors[a][1], count: cnt[a] });
            list.sort((a, c) => c.count - a.count || String(a.name).localeCompare(String(c.name)));
            out.actress = list.slice(0, 20);
        }
        const nRel = popAnd(R, bits, B_REL * W, W), nHot = popAnd(R, bits, B_HOT * W, W);
        out.sorts = K.SORTS.map(([id, label]) => ({ id, label, available: id === 'released' ? nRel >= C.sortMin : id === 'hot' ? nHot >= C.sortMin : true }));
        out.total = popAll(R, W);
        fcache.set(k, out);
        while (fcache.size > C.facetCacheMax) fcache.delete(fcache.keys().next().value);
        return out;
    }
    function encCursor(c) { return Buffer.from(JSON.stringify(c)).toString('base64url'); }
    function decCursor(x) {
        try { const c = JSON.parse(Buffer.from(String(x), 'base64url').toString('utf8')); return Array.isArray(c) && c.length === 4 ? c : null; } catch (_) { return null; }
    }
    function browse(p) {
        const pg = Math.min(C.maxPages, Math.max(1, parseInt(p.page, 10) || 1));
        const out = { page: pg, total_pages: 0, total_results: 0, cursor_next: null, results: [] };
        const s = S;
        if (!s || !s.N) { if (p.facets && s) out.facets = emptyFacets(); return out; }
        const F = parseF(p);
        if (F.bad) { if (p.facets) out.facets = emptyFacets(); return out; }
        const R = makeSet(F, '');
        const total = popAll(R, s.W);
        out.total_results = total;
        // 按页号跳最多 maxPages 页(页号要从头数,深了贵);游标是位置续翻,不封顶(游标请求回真实总页数)
        const allPages = Math.ceil(total / PAGE);
        out.total_pages = Math.min(C.maxPages, allPages);
        let sort = K.SORT_IDS.has(p.sort) ? p.sort : 'new';
        let order, from = 0, to;
        if (sort === 'new' && F.b >= 0) { order = s.newB; from = s.offB[F.b]; to = s.offB[F.b + 1]; }
        else { order = s.ord[sort] || s.ord.new; to = order.length; }
        const has = (i) => (R[i >>> 5] >>> (i & 31)) & 1;
        let skip = (pg - 1) * PAGE, pos = from, page = pg;
        if (p.cursor) {
            const c = decCursor(p.cursor);
            if (c) {
                out.total_pages = allPages;
                page = Math.min(allPages + 1, Math.max(1, Math.floor(Number(c[2]) || 0) + 1));
                out.page = page;
                skip = 0;
                if (c[0] === s.sid && Number.isInteger(c[1]) && c[1] >= from && c[1] <= to) pos = c[1];
                else {   // 快照换了:从上一页最后一部作品之后接着翻;找不到 = 到底了
                    pos = -1;
                    for (let k = from; k < to; k++) if (s.col.id[order[k]] === c[3]) { pos = k + 1; break; }
                    if (pos < 0) return out;
                }
            }
        }
        if (page > out.total_pages) return out;
        const picked = [];
        for (; pos < to && picked.length < PAGE; pos++) {
            const i = order[pos];
            if (!has(i)) continue;
            if (skip > 0) { skip--; continue; }
            picked.push(i);
        }
        if (picked.length === PAGE && page < allPages) {
            let more = false;
            for (let k = pos; k < to; k++) if (has(order[k])) { more = true; break; }
            if (more) out.cursor_next = encCursor([s.sid, pos, page, s.col.id[picked[picked.length - 1]]]);
        }
        const ctx = { t: s.at, act: s.act, imgProxy: s.json.imgProxy };
        // nr(猜你喜欢):快照之后才变成审查级的,卡片行按库里现在的 review / tags 再判一次(这一页宁可少几张)
        const rows = cardsByIds(picked.map((i) => s.col.id[i]), ctx, F.nr);
        out.results = picked.map((i) => rows.get(s.col.id[i])).filter((w) => w && K.liveCount(w.sites, s.act) > 0).map((w) => K.card(w, ctx));
        if (p.facets) {
            const fc = facetsFor(F);
            const f2 = {};
            for (const k2 of ['buckets', 'groups', 'more', 'dur', 'variant', 'studio', 'actress', 'sorts']) f2[k2] = fc[k2];
            out.facets = f2;
        }
        return out;
    }
    function emptyFacets() {
        return { buckets: [], groups: [], more: [], dur: DURS.map((x) => ({ id: x[0], label: x[3], count: 0 })), variant: [], studio: [], actress: [],
            sorts: K.SORTS.map(([id, label]) => ({ id, label, available: id !== 'released' && id !== 'hot' })) };
    }

    // ---------- 本地查找 / 联想(零上游) ----------
    const LCOLS = K.WCOLS + ', w.live_sites, w.is_clip, w.tags AS stags';
    function liveRow(w) { return S ? K.liveCount(w.live_sites, S.act) > 0 : false; }
    function codeRows(key, n) {
        return q(`SELECT ${LCOLS} FROM adult_works w WHERE w.ckey=? AND substr(w.wk, 1, 2)='c:' AND w.vis=1 AND ${ELIG} ORDER BY w.is_clip, w.n_sites DESC, w.first_seen DESC LIMIT ?`).all(key, n);
    }
    let ftsOk = null, bigramOk = null;
    function probe() {
        if (ftsOk == null) { ftsOk = !!q("SELECT 1 FROM sqlite_master WHERE name='adult_fts'").get(); bigramOk = !!q("SELECT 1 FROM sqlite_master WHERE name='adult_fts2'").get(); }
    }
    const rank = (a, b) => (b.n_sites - a.n_sites) || (b.first_seen - a.first_seen);
    // 多个关键词(空格分开,最多 5 个;用户 2026-11-24「黑丝 女同」):每个词都要对上 ——
    //   片名里有(繁简 / 大小写 / 空格不计),或者这个词是分类 / 标签词(ALIAS)、作品就在那个分区 / 带那个标签。
    //   候选从"不是分类标签词的词里最长的那个"按片名取(都是分类标签词就用最长的),再逐条核其余的词。
    function splitTerms(s) {
        const out = [];
        for (const t of String(s).split(' ')) { const k = normQ(t); if (k && !out.some((x) => x.k === k)) out.push({ t, k, al: null }); }
        for (const x of out) x.al = ALIAS.get(x.k) || null;
        return out.slice(0, 5);
    }
    function termOk(w, x) {
        if (normQ(w.name).indexOf(x.k) >= 0) return true;
        const a = x.al;
        if (a && a.tag) return String(w.stags || '').indexOf(',' + a.tag + ',') >= 0;
        if (a && a.b) return w.bucket === a.b;
        return false;
    }
    function textRows(s, n) {
        const terms = splitTerms(s);
        if (terms.length < 2) return textRows1(s, n);
        const free = terms.filter((x) => !x.al);
        const seed = (free.length ? free : terms).slice().sort((a, b) => [...b.t].length - [...a.t].length)[0];
        let rows = textRows1(seed.t, C.textScan);
        const s2 = T.t2s(seed.t);
        if (!rows.length && s2 !== seed.t) rows = textRows1(s2, C.textScan);
        return rows.filter((w) => terms.every((x) => x === seed || termOk(w, x))).slice(0, n);
    }
    // 全是分类 / 标签词(≤1 个分区、≤3 个标签)→ 合成一个"别名":回车开浏览页,按这几个一起筛
    function multiAlias(s) {
        const terms = splitTerms(s);
        if (terms.length < 2 || !terms.every((x) => x.al)) return null;
        const bs = [...new Set(terms.filter((x) => x.al.b).map((x) => x.al.b))];
        const tags = [];
        for (const x of terms) if (x.al.tag && !tags.some((y) => y.tag === x.al.tag)) tags.push({ tag: x.al.tag, label: x.al.label });
        if (bs.length > 1 || tags.length > 3 || (!bs.length && !tags.length)) return null;
        return Object.assign({ label: terms.map((x) => x.al.label).join(' · ') }, bs[0] ? { b: bs[0] } : {}, tags.length ? { tag: tags[0].tag, tags } : {});
    }
    function textRows1(s, n) {
        probe();
        const len = [...s].length;
        const cjk2 = len === 2 && /^[぀-ヿ㐀-鿿豈-﫿]{2}$/.test(s);
        let rows;
        if (ftsOk && len >= 3) {
            rows = q(`SELECT ${LCOLS} FROM adult_fts f JOIN adult_works w ON w.id = f.rowid WHERE adult_fts MATCH ? AND w.vis=1 AND ${ELIG} ORDER BY f.rowid DESC LIMIT ?`)
                .all('"' + s.replace(/"/g, '""') + '"', C.textScan);
        } else if (bigramOk && cjk2) {
            rows = q(`SELECT ${LCOLS} FROM adult_fts2 f JOIN adult_works w ON w.id = f.rowid WHERE adult_fts2 MATCH ? AND w.vis=1 AND ${ELIG} ORDER BY f.rowid DESC LIMIT ?`)
                .all('"' + s + '"', C.textScan).filter((w) => w.name.indexOf(s) >= 0);
        } else {
            rows = q(`SELECT ${LCOLS} FROM adult_works w WHERE w.vis=1 AND w.name LIKE ? ESCAPE '\\' AND ${ELIG} ORDER BY w.id DESC LIMIT ?`)
                .all('%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%', C.textScan);
        }
        return rows.sort(rank).slice(0, n);
    }
    function lookup({ q: query, limit, t }) {
        const lim = Math.max(1, Math.min(24, parseInt(limit, 10) || 8));
        if (!S) return [];
        const s = String(query == null ? '' : query).normalize('NFKC').trim().slice(0, 100);
        if (!s || P.checkQuery(s)) return [];
        const sv = T.searchVariants(s);
        const rows = sv.kind === 'code' && sv.key ? codeRows(sv.key, lim * 2) : textRows(s, lim * 2);
        const ctx = { t, act: S.act, imgProxy: S.json.imgProxy };
        return rows.filter(liveRow).slice(0, lim).map((w) => K.card(w, ctx));
    }
    const normQ = (v) => T.t2s(String(v == null ? '' : v).normalize('NFKC')).toLowerCase().replace(/[\s​-‏﻿]+/g, '');
    const ALIAS = new Map();
    (function buildAlias() {
        const add = (w, v) => { const k = normQ(w); if (k && v && !ALIAS.has(k)) ALIAS.set(k, v); };
        const Bk = (b) => (NAV.has(b) ? { b, label: X.bucketLabel(b) } : null);
        const Tg = (id) => { const r = typeof TG.resolve === 'function' ? TG.resolve(id) : id; return r && FEATSET.has(r) ? { tag: r, label: TG.label(r) } : null; };   // 审查级标签不做别名
        const manual = [
            ['无码', Bk('jp_uncensored')], ['無碼', Bk('jp_uncensored')], ['有码', Bk('jp_censored')], ['日本', Bk('jp_censored')], ['中字', Bk('jp_subbed')], ['中文字幕', Bk('jp_subbed')], ['字幕', Bk('jp_subbed')],
            ['探花', Bk('cn_hookup')], ['约炮', Bk('cn_hookup')], ['里番', Bk('anime')], ['动漫', Bk('anime')], ['动画', Bk('anime')], ['欧美', Bk('western')],
            ['国产', Bk('cn_amateur')], ['自拍', Bk('cn_amateur')], ['传媒', Bk('cn_studio')], ['主播', Bk('live')], ['直播', Bk('live')],
            ['网红', Bk('creators')], ['福利姬', Bk('creators')], ['短视频', Bk('short')], ['抖音', Bk('short')], ['竖屏', Bk('short')],
            ['三级', Bk('softcore')], ['伦理', Bk('softcore')], ['解说', Bk('commentary')], ['sm', Bk('fetish')], ['重口', Bk('fetish')],
            ['同性', Bk('lgbt')], ['ts', Tg('trans')], ['人妖', Tg('trans')], ['男同', Tg('gay')], ['女同', Tg('lesbian')],   // 同性分区 ~86% 是女同:具体的词指到具体标签 ['韩国', Bk('asia')], ['东南亚', Bk('asia')], ['ai短剧', Bk('ai_drama')],
            ['人妻', Tg('milf')], ['熟女', Tg('milf')], ['巨乳', Tg('busty')], ['制服', Tg('uniform')], ['丝袜', Tg('legs')], ['cosplay', Tg('cosplay')], ['群交', Tg('group')], ['ntr', Tg('ntr')],
        ];
        for (const [w, v] of manual) add(w, v);
        for (const b of NAVB) { const v = Bk(b); add(v.label, v); for (const part of v.label.split(/[·・]/)) if ([...part].length >= 2) add(part, v); }
        for (const t of TG.VOCAB) {
            if (!FEATSET.has(t.id)) continue;
            const v = { tag: t.id, label: t.label };
            add(t.label, v);
            for (const sy of Array.isArray(t.syn) ? t.syn : []) if (typeof sy === 'string' && [...sy].length >= 2) add(sy, v);
        }
    })();
    function suggest({ q: query, t }) {
        const out = { kind: 'empty', alias: null, exact: null, items: [] };
        const s = String(query == null ? '' : query).normalize('NFKC').replace(/[​-‏﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!s) return out;
        let blocked = true;
        try { blocked = !!P.checkQuery(s); } catch (_) { blocked = true; }
        if (blocked) { out.kind = 'blocked'; return out; }
        const ctx = { t, act: S ? S.act : new Set(), imgProxy: S ? S.json.imgProxy : false };
        const sv = T.searchVariants(s);
        if (sv.kind === 'code' && sv.key) {
            out.kind = 'code';
            if (!S) return out;
            const rows = codeRows(sv.key, 16).filter(liveRow);
            const mains = rows.filter((w) => K.kindOfWk(w.wk) === 'main');
            // 恰好一部正片才直接开:同番号按时长拆出来的 '~2' / '~d<秒>' 是另一部片(第二阶段把它们当同一部是错的)
            if (mains.length === 1) out.exact = mains[0].wk;
            const rk = (w) => ({ main: 0, U: 1, clip: 2 })[K.kindOfWk(w.wk)];
            out.items = rows.sort((a, b) => rk(a) - rk(b)).slice(0, 8).map((w) => K.card(w, ctx));
            return out;
        }
        const al = ALIAS.get(normQ(s)) || multiAlias(s);
        out.kind = al ? 'alias' : 'text';
        if (al) out.alias = Object.assign({}, al);
        if (!S) return out;
        let rows = textRows(s, 16);
        const s2 = T.t2s(s);
        if (!rows.length && s2 !== s) rows = textRows(s2, 16);
        out.items = rows.filter((w) => liveRow(w) && w.wk.indexOf('#clip') < 0).slice(0, 8).map((w) => K.card(w, ctx));
        return out;
    }

    const OPS = {
        build: (a) => { const s = build(a); return { desc: describe(s), json: s.json, sid: s.sid, N: s.N }; },
        install: (a) => install(a.desc),
        browse, lookup, suggest,
        sid: () => (S ? S.sid : null),
        // 第四阶段
        related: (a) => RFX.related(a),
        feed: (a) => RFX.feed(a),
        setExtraBlock: (a) => { if (typeof P.setExtraBlock !== 'function') return false; P.setExtraBlock(a && a.words); return true; },
    };
    function handle(op, args) {
        const fn = OPS[op];
        if (!fn) throw new Error('unknown reader op ' + op);
        return fn(args || {});
    }
    return { handle, snap: () => S, NBITS };
}

module.exports = { createReader, pc32 };
