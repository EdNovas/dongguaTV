'use strict';
// 📱 短剧竖屏刷的片库:每 30 分钟从资源站的短剧分类拉最新一页(?ac=detail&t=<分类>&pg=),每部只留一条 m3u8 选集,
//   按片名去重(几个站都有同一部 → 一部,带上各站的线路),存进 cache.db(没 sqlite 就放内存);首页「短剧」整屏刷读 /api/shorts/feed。
//
// createShortsFeed({ db, sites, httpGet, tierOf?, log?, now?, opts? })
//   db       () → better-sqlite3 连接或 null(null = 只放内存,重启清空)
//   sites    () → [{key, name, api}] 候选 maccms 站(server.js 过滤掉停用 / 番剧规则站)
//   httpGet  async (url, timeoutMs) → 响应体(对象或字符串)
//   tierOf   (siteKey) → 广告分级 'clean'|'noburn'|'insert'|'unknown'|'ads'(同一部的线路按它排先后,与播放页线路分组同一套档案)
// → { start(), stop(), tick(), kick(), feed(offset, limit), status() }
//
// 哪些站:自动认 —— ?ac=list 里名字像短剧的叶子分类(父分类 t= 查出来是 0 条,只能查子分类);擦边 / AI / 漫剧不收。
//   很多站把一整部短剧拼成一个「全集」文件(极速/红牛/暴风/最大…),竖屏刷要一集一集地刷 → 一页里有选集的不到 1/4 就当这个站不适合,3 天后再看。
//   SHORTS_SITES 可指定;PREFER 里的站先拉(冷启动十几秒内就有东西可刷)。
// 排序:最近更新在前;几个站都在更新的(更热)往前提 2 天/站,追剧日历里同一天好几个站都更新了的再提一点。
const DEF = Object.freeze({
    tickMs: 30 * 60e3, firstDelayMs: 75e3, pagesFirst: 5, pagesTick: 1, pageGapMs: 350, timeoutMs: 15000,
    classesTtlMs: 24 * 3600e3, minEps: 4, maxSrcs: 3, keepDays: 30, maxItems: 1200,
    sampleMin: 12, multiRatio: 0.25, singleSkipMs: 3 * 86400e3, noShortSkipMs: 7 * 86400e3, errSkipMs: 2 * 3600e3,
    hotBonusMs: 2 * 86400e3, calBonusMs: 86400e3,
});
const PREFER = ['rycj', 'ffzy', 'lzi', 'ikun', 'lzcaiji'];
const SHORT_RE = /短剧|爽文|爽剧|古装仙侠|现代都市|穿越年代|年代穿越|言情总裁|重生民国|脑洞悬疑|女频恋爱|反转/;
const BLOCK_RE = /擦边|伦理|三级|写真|福利|情色|成人|漫剧|动漫|动画|ai/i;
const NSFW_TITLE = /玉蒲团|蜜桃成熟|色欲|淫|情色|艳情|春宫|三级|性爱|乱伦|走肾|裸|小姨子|嫂子的|继母的/;
const AI_TITLE = /[(（\[【]\s*ai\s*[)）\]】]|ai短剧|ai漫/i;
const TIER_RANK = { clean: 0, noburn: 1, insert: 2, ads: 3, unknown: 4 };   // 与前端 SRC_TIER_RANK 同序(未评测排在有水印后面)
// 与 lib/update-calendar 同一个片名键(两边 nk 对得上,才能按日历加热度)
const norm = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 120);
const parse = (b) => {
    if (b && typeof b === 'object') return b;
    const s = String(b == null ? '' : b).replace(/^﻿/, '').trim();
    try { return JSON.parse(s); } catch (e) { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiUrl = (api, q) => api + (api.indexOf('?') >= 0 ? '&' : '?') + q;
// 资源站的 vod_time 是北京时间
function timeOf(vodTime) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(vodTime || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 8 * 3600e3 : 0;
}
const cleanText = (s, n) => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&amp;nbsp;/gi, ' ').replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^(暂无简介|暂无剧情介绍|暂无|无)$/, '').slice(0, n);
// 有的站把简介写成一串 SEO 关键词(「艾旦影视,海外影院,海外影视,海外YY…」):这种不要
const spammy = (b) => (String(b).match(/影视|影院|观看|APP|网站|资源|在线|高清/gi) || []).length >= 3;
// 「全集」(整部拼成一个文件)/ 合集 / 完整版:同一路里还有一集一集的就不要它(否则竖屏刷从一个一两小时的文件开始)
const MERGED_EP = /^(全集|合集|完整版|全\s*\d+\s*集|全集完结)$/;

// 选集串($$$ 分路)→ 只留一路 m3u8:{ line: '第01集$https://…/index.m3u8#…', n } 或 null。
//   优先 from 名里带 m3u8 的那一路,再看哪一路的地址是 .m3u8;只收 http(s) 的 .m3u8(分享页 / 云播页播不了)
function pickLine(playFrom, playUrl) {
    const sets = String(playUrl || '').split('$$$');
    const froms = String(playFrom || '').split('$$$');
    const order = sets.map((s, i) => i).sort((a, b) => (/m3u8/i.test(froms[b] || '') ? 1 : 0) - (/m3u8/i.test(froms[a] || '') ? 1 : 0));
    for (const i of order) {
        const eps = [];
        for (const raw of sets[i].split('#')) {
            const seg = raw.trim();
            if (!seg) continue;
            const k = seg.indexOf('$');
            const name = (k > 0 ? seg.slice(0, k) : '').trim().replace(/[#$]/g, '');
            const url = (k >= 0 ? seg.slice(k + 1) : seg).trim();
            if (!/^https?:\/\/[^\s#$]+\.m3u8(?:[?][^\s#$]*)?$/i.test(url)) { eps.length = 0; break; }   // 这一路混着别的地址:不用
            eps.push((name || ('第' + String(eps.length + 1).padStart(2, '0') + '集')) + '$' + url);
        }
        if (eps.length > 1) { const one = eps.filter((e) => !MERGED_EP.test(e.slice(0, e.indexOf('$')).trim())); if (one.length) eps.splice(0, eps.length, ...one); }
        if (eps.length) return { line: eps.join('#'), n: eps.length };
    }
    return null;
}
// 同名的是不是同一部:集数差不多(资源站之间常差一两集:预告 / 花絮 / 还在更新)
const sameWork = (a, b) => Math.abs(a - b) <= Math.max(3, Math.round(Math.max(a, b) * 0.25));

// 分类表 → 短剧叶子分类 id(父分类在多数站上 t= 查不出东西)
function shortLeaves(cls) {
    const list = Array.isArray(cls) ? cls : [];
    const hasKid = new Set(list.map((c) => String(c.type_pid == null ? '' : c.type_pid)));
    const byId = new Map(list.map((c) => [String(c.type_id), c]));
    const out = [];
    for (const c of list) {
        const id = String(c.type_id), name = String(c.type_name || '');
        if (hasKid.has(id)) continue;
        const parent = byId.get(String(c.type_pid == null ? '' : c.type_pid));
        const pn = parent ? String(parent.type_name || '') : '';
        if (BLOCK_RE.test(name)) continue;
        if (SHORT_RE.test(name) || (SHORT_RE.test(pn) && !BLOCK_RE.test(pn))) out.push(id);
    }
    return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shorts_items (
    nk     TEXT PRIMARY KEY,
    title  TEXT NOT NULL,
    pic    TEXT NOT NULL DEFAULT '',
    remarks TEXT NOT NULL DEFAULT '',
    blurb  TEXT NOT NULL DEFAULT '',
    year   INTEGER NOT NULL DEFAULT 0,
    area   TEXT NOT NULL DEFAULT '',
    type   TEXT NOT NULL DEFAULT '',
    eps    INTEGER NOT NULL DEFAULT 0,
    t      INTEGER NOT NULL DEFAULT 0,
    score  INTEGER NOT NULL DEFAULT 0,
    srcs   TEXT NOT NULL DEFAULT '[]'
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS shorts_items_score ON shorts_items (score);
CREATE TABLE IF NOT EXISTS shorts_state (site TEXT PRIMARY KEY, api TEXT NOT NULL DEFAULT '', leaves TEXT NOT NULL DEFAULT '[]',
    classes_at INTEGER NOT NULL DEFAULT 0, last_ok INTEGER NOT NULL DEFAULT 0, skip_until INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, multi INTEGER NOT NULL DEFAULT 0, last_err TEXT NOT NULL DEFAULT '');`;

// 内存版(没 sqlite):接口与下面 sqlite 版一致
function memStore() {
    const items = new Map(), state = new Map();
    return {
        get: (nk) => items.get(nk) || null,
        put: (r) => { items.set(r.nk, r); },
        del: (nk) => { items.delete(nk); },
        all: () => Array.from(items.values()),
        count: () => items.size,
        page: (off, lim) => Array.from(items.values()).sort((a, b) => b.score - a.score || (a.nk < b.nk ? -1 : 1)).slice(off, off + lim),
        prune: (cutT, max) => {
            for (const [k, r] of items) if (r.t < cutT) items.delete(k);
            if (items.size > max) Array.from(items.values()).sort((a, b) => a.score - b.score).slice(0, items.size - max).forEach((r) => items.delete(r.nk));
        },
        st: (site) => state.get(site) || null,
        setSt: (site, v) => { state.set(site, Object.assign({}, state.get(site) || {}, v, { site })); },
        sts: () => Array.from(state.values()),
        calHot: () => 0,
        tx: (fn) => fn(),
    };
}
function sqlStore(db) {
    db.exec(SCHEMA);
    const q = {
        get: db.prepare('SELECT * FROM shorts_items WHERE nk = ?'),
        put: db.prepare(`INSERT INTO shorts_items (nk, title, pic, remarks, blurb, year, area, type, eps, t, score, srcs) VALUES (@nk,@title,@pic,@remarks,@blurb,@year,@area,@type,@eps,@t,@score,@srcs)
            ON CONFLICT(nk) DO UPDATE SET title=excluded.title, pic=excluded.pic, remarks=excluded.remarks, blurb=excluded.blurb, year=excluded.year, area=excluded.area,
            type=excluded.type, eps=excluded.eps, t=excluded.t, score=excluded.score, srcs=excluded.srcs`),
        count: db.prepare('SELECT count(*) AS c FROM shorts_items'),
        page: db.prepare('SELECT * FROM shorts_items ORDER BY score DESC, nk LIMIT ? OFFSET ?'),
        pruneT: db.prepare('DELETE FROM shorts_items WHERE t < ?'),
        pruneN: db.prepare('DELETE FROM shorts_items WHERE nk IN (SELECT nk FROM shorts_items ORDER BY score ASC LIMIT ?)'),
        st: db.prepare('SELECT * FROM shorts_state WHERE site = ?'),
        sts: db.prepare('SELECT * FROM shorts_state'),
    };
    let calQ = null;
    try { calQ = db.prepare("SELECT max(n) AS n FROM cal_items WHERE nk = ? AND cat = 'short' AND day >= ?"); } catch (e) { calQ = null; }   // 追剧日历没开 = 没这张表
    const row = (r) => (r ? Object.assign({}, r, { srcs: (() => { try { return JSON.parse(r.srcs); } catch (e) { return []; } })() }) : null);
    return {
        get: (nk) => row(q.get.get(nk)),
        put: (r) => { q.put.run(Object.assign({}, r, { srcs: JSON.stringify(r.srcs || []) })); },
        count: () => q.count.get().c,
        page: (off, lim) => q.page.all(lim, off).map(row),
        prune: (cutT, max) => {
            q.pruneT.run(cutT);
            const n = q.count.get().c;
            if (n > max) q.pruneN.run(n - max);
        },
        st: (site) => q.st.get(site) || null,
        setSt: (site, v) => {
            const cur = q.st.get(site) || { site, api: '', leaves: '[]', classes_at: 0, last_ok: 0, skip_until: 0, total: 0, multi: 0, last_err: '' };
            const m = Object.assign({}, cur, v, { site });
            db.prepare(`INSERT INTO shorts_state (site, api, leaves, classes_at, last_ok, skip_until, total, multi, last_err) VALUES (@site,@api,@leaves,@classes_at,@last_ok,@skip_until,@total,@multi,@last_err)
                ON CONFLICT(site) DO UPDATE SET api=excluded.api, leaves=excluded.leaves, classes_at=excluded.classes_at, last_ok=excluded.last_ok,
                skip_until=excluded.skip_until, total=excluded.total, multi=excluded.multi, last_err=excluded.last_err`).run(m);
        },
        sts: () => q.sts.all(),
        calHot: (nk, sinceDay) => { try { return calQ ? (calQ.get(nk, sinceDay) || {}).n || 0 : 0; } catch (e) { return 0; } },
        tx: (fn) => db.transaction(fn)(),
    };
}

function createShortsFeed(o) {
    const opts = Object.assign({}, DEF, (o && o.opts) || {});
    const log = o.log || (() => { });
    const now = o.now || Date.now;
    const tierOf = o.tierOf || (() => 'unknown');
    let timer = null, first = null, running = null, stopped = false, mem = null, sq = null, sqDb = null, ver = 0;
    const memo = new Map();

    function store() {
        const db = o.db && o.db();
        if (db) {
            if (sqDb !== db) { sq = sqlStore(db); sqDb = db; }
            return sq;
        }
        return mem || (mem = memStore());
    }
    async function getJson(url) { return parse(await o.httpGet(url, opts.timeoutMs)); }
    const rankOf = (site) => (Object.prototype.hasOwnProperty.call(TIER_RANK, tierOf(site)) ? TIER_RANK[tierOf(site)] : TIER_RANK.unknown);
    const cnDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

    function scoreOf(st, r) {
        const hot = Math.max(0, (r.srcs || []).length - 1) * opts.hotBonusMs;
        const cal = Math.max(0, (st.calHot(r.nk, cnDay(now() - 7 * 86400e3)) | 0) - 1) * opts.calBonusMs;
        return Math.round(r.t + hot + cal);
    }

    // 一条资源站记录 → 并进片库。返回 true = 这条是能刷的多集短剧
    function put(st, site, v) {
        const title = String(v.vod_name || '').trim();
        if (!title || NSFW_TITLE.test(title) || AI_TITLE.test(title)) return false;
        const type = String(v.type_name || '');
        if (BLOCK_RE.test(type)) return false;
        const pl = pickLine(v.vod_play_from, v.vod_play_url);
        if (!pl || pl.n < opts.minEps) return false;
        const nk = norm(title);
        if (!nk) return false;
        const t = timeOf(v.vod_time) || now();
        const src = { s: site.key, id: String(v.vod_id), n: pl.n, t, u: pl.line };
        const old = st.get(nk);
        const pic = /^https?:\/\//i.test(String(v.vod_pic || '')) ? String(v.vod_pic).slice(0, 400) : '';
        const remarks = String(v.vod_remarks || '').slice(0, 30);
        let blurb = cleanText(v.vod_blurb || v.vod_content, 160);
        if (spammy(blurb)) blurb = '';
        let r;
        if (!old) {
            r = { nk, title: title.slice(0, 80), pic, remarks, blurb, year: Number(v.vod_year) || 0, area: String(v.vod_area || '').slice(0, 20), type: type.slice(0, 20), eps: pl.n, t, srcs: [src] };
        } else {
            const others = (old.srcs || []).filter((x) => x.s !== site.key);
            const head = (u) => String(u || '').split('#')[0].replace(/^[^$]*\$/, '');
            if (others.some((x) => head(x.u) === head(src.u))) {   // 镜像站(量子 / 量子2 同一个 CDN 地址):不算第二条线路,也不算更热
                if (others.length < (old.srcs || []).length) { const m = Object.assign({}, old, { srcs: others }); m.score = scoreOf(st, m); st.put(m); }   // 旧版本记进去的镜像线路顺手去掉
                return true;
            }
            const ref = others.length ? Math.max.apply(null, others.map((x) => x.n)) : pl.n;
            if (others.length && !sameWork(ref, pl.n)) return true;   // 同名不同部(集数对不上):不并,留先来的那部
            const srcs = others.concat([src]).sort((a, b) => (rankOf(a.s) - rankOf(b.s)) || (b.n - a.n) || (b.t - a.t)).slice(0, opts.maxSrcs);
            if (!srcs.some((x) => x.s === site.key) && others.length >= opts.maxSrcs) return true;
            const best = srcs.reduce((a, b) => (b.n > a.n ? b : a), srcs[0]);
            r = Object.assign({}, old, {
                pic: old.pic || pic, blurb: old.blurb || blurb, type: old.type || type.slice(0, 20),
                remarks: best === src ? remarks : old.remarks, eps: Math.max.apply(null, srcs.map((x) => x.n)),
                t: Math.max(old.t, t), srcs,
            });
        }
        r.score = scoreOf(st, r);
        st.put(r);
        return true;
    }

    async function leavesOf(st, site) {
        const s = st.st(site.key);
        if (s && s.api === site.api && now() - s.classes_at < opts.classesTtlMs) {
            try { return JSON.parse(s.leaves); } catch (e) { /* 重拉 */ }
        }
        const d = await getJson(apiUrl(site.api, 'ac=list'));
        if (!d || !Array.isArray(d.class)) throw new Error('不是 maccms 分类表');
        const leaves = shortLeaves(d.class);
        st.setSt(site.key, { api: site.api, leaves: JSON.stringify(leaves), classes_at: now() });
        return leaves;
    }

    async function pullSite(st, site) {
        const s0 = st.st(site.key);
        if (s0 && s0.api === site.api && s0.skip_until > now()) return 0;
        const firstRun = !(s0 && s0.api === site.api && s0.last_ok);
        const leaves = await leavesOf(st, site);
        if (!leaves.length) { st.setSt(site.key, { skip_until: now() + opts.noShortSkipMs, last_err: '没有短剧分类' }); return 0; }
        let total = 0, multi = 0;
        for (const leaf of leaves) {
            for (let pg = 1; pg <= (firstRun ? opts.pagesFirst : opts.pagesTick) && !stopped; pg++) {
                const d = await getJson(apiUrl(site.api, `ac=detail&t=${encodeURIComponent(leaf)}&pg=${pg}`));
                if (!d || !Array.isArray(d.list)) throw new Error('不是 maccms 列表');
                let m = 0;
                st.tx(() => { for (const v of d.list) { total++; if (put(st, site, v)) m++; } });
                multi += m;
                const pc = Number(d.pagecount) || 0;
                if (opts.pageGapMs) await sleep(opts.pageGapMs);
                if (!d.list.length || !pc || pg >= pc) break;
                if (d.list.length >= 10 && m === 0) break;   // 这一页全是「全集」单文件:这个分类不用往下翻
            }
            if (stopped) break;
        }
        const single = total >= opts.sampleMin && multi / total < opts.multiRatio;
        st.setSt(site.key, { last_ok: now(), total, multi, last_err: single ? '多为全集单文件' : '', skip_until: single ? now() + opts.singleSkipMs : 0 });
        return multi;
    }

    function orderSites(list) {
        const want = String(o.only || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (want.length) return want.map((k) => list.find((x) => x.key === k)).filter(Boolean);
        const pre = PREFER.map((k) => list.find((x) => x.key === k)).filter(Boolean);
        return pre.concat(list.filter((x) => pre.indexOf(x) < 0));
    }

    async function runTick() {
        const st = store();
        let got = 0;
        for (const site of orderSites((o.sites() || []).filter((x) => x && x.key && /^https?:\/\//i.test(String(x.api || ''))))) {
            if (stopped) break;
            try { const n = await pullSite(st, site); if (n) log(`${site.key} 收了 ${n} 部`); got += n; }
            catch (e) {
                try { st.setSt(site.key, { api: site.api, last_err: String(e.message || e).slice(0, 200), skip_until: now() + opts.errSkipMs }); } catch (e2) { /* ignore */ }
                log(`${site.key} 拉取失败:`, e.message);
            }
            if (got) { ver = now(); memo.clear(); }   // 拉到一点就能刷,不等整轮
        }
        st.prune(now() - opts.keepDays * 86400e3, opts.maxItems);
        ver = now();
        memo.clear();
    }
    function tick() {
        if (running || stopped) return running || Promise.resolve();
        running = runTick().catch((e) => log('本轮失败:', e.message)).finally(() => { running = null; });
        return running;
    }
    // 片库还是空的(刚启动)时有人来刷 → 立刻开一轮(PREFER 的站先拉,十几秒就有)
    function kick() { if (!running && !stopped && !store().count()) tick(); }

    const srcOut = (x) => ({ site_key: x.s, vod_id: x.id, n: x.n, t: x.t, url: x.u });
    function itemOut(r) {
        return { id: r.nk, title: r.title, pic: r.pic, remarks: r.remarks, blurb: r.blurb, year: r.year, area: r.area, type: r.type, eps: r.eps, t: r.t, srcs: (r.srcs || []).map(srcOut) };
    }
    function feed(offset, limit) {
        const st = store();
        const off = Math.max(0, Math.min(5000, Number(offset) || 0)), lim = Math.max(1, Math.min(20, Number(limit) || 8));
        const key = off + '|' + lim;
        const hit = memo.get(key);
        if (hit && now() - hit.at < 60e3) return hit.v;
        const total = st.count();
        const items = st.page(off, lim).map(itemOut);
        const v = { items, total, offset: off, next: off + items.length < total ? off + items.length : null, ver, warming: !total && !!running };
        if (!total) return v;   // 空片库不记:正在拉的那一轮随时会有东西
        if (memo.size > 200) memo.clear();
        memo.set(key, { v, at: now() });
        return v;
    }
    function status() {
        const st = store();
        return { running: !!running, items: st.count(), ver, sites: st.sts().map((s) => ({ site: s.site, leaves: s.leaves, last_ok: s.last_ok, skip_until: s.skip_until, total: s.total, multi: s.multi, last_err: s.last_err })) };
    }
    function start() {
        if (timer || stopped) return;
        first = setTimeout(() => tick(), opts.firstDelayMs); if (first.unref) first.unref();
        timer = setInterval(() => tick(), opts.tickMs); if (timer.unref) timer.unref();
    }
    function stop() { stopped = true; clearInterval(timer); clearTimeout(first); }
    return { start, stop, tick, kick, feed, status };
}

module.exports = { createShortsFeed, pickLine, shortLeaves, sameWork, norm, timeOf };
