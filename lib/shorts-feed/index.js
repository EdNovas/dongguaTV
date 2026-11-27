'use strict';
// 📱 短剧片库:每 30 分钟从资源站的短剧分类拉最新一页(?ac=detail&t=<分类>&pg=),再每轮往后补几页老的(慢慢收全),
//   每部只留一条 m3u8 选集,按片名去重(几个站都有同一部 → 一部,带上各站的线路),存进 cache.db(没 sqlite 就放内存)。
//   两个出口:首页「刷短剧」整屏刷读 /api/shorts/feed(只要一集一集的);「短剧」分类页读 /api/shorts/list(全部,带题材标签)。
//
// createShortsFeed({ db, sites, httpGet, tierOf?, log?, now?, opts? })
//   db       () → better-sqlite3 连接或 null(null = 只放内存,重启清空)
//   sites    () → [{key, name, api}] 候选 maccms 站(server.js 过滤掉停用 / 番剧规则站,再加上只收短剧的站)
//   httpGet  async (url, timeoutMs) → 响应体(对象或字符串)
//   tierOf   (siteKey) → 广告分级 'clean'|'noburn'|'insert'|'unknown'|'ads'(同一部的线路按它排先后,与播放页线路分组同一套档案)
// → { start(), stop(), tick(), kick(), feed(offset, limit), list(params), item(id), cats(), status() }
//
// 哪些站:自动认 —— ?ac=list 里名字像短剧的叶子分类(父分类 t= 查出来是 0 条,只能查子分类);擦边 / AI / 漫剧不收。
//   很多站把一整部短剧拼成一个「全集」文件(极速/红牛/暴风/最大…):竖屏刷要一集一集地刷 → 这种只进分类页(标「全集」),不进竖屏刷;
//   同一部别的站有一集一集的,线路排在它们后面当备用。
//   SHORTS_SITES 可指定;PREFER 里的站先拉(冷启动十几秒内就有东西可刷)。
// 排序:最近更新在前;几个站都在更新的(更热)往前提 2 天/站,追剧日历里同一天好几个站都更新了的再提一点。
const DEF = Object.freeze({
    tickMs: 30 * 60e3, firstDelayMs: 75e3, pagesFirst: 5, pagesTick: 1, pageGapMs: 350, timeoutMs: 15000,
    classesTtlMs: 24 * 3600e3, minEps: 4, maxSrcs: 3, keepDays: 3650, maxItems: 60000,
    backfillPages: 12,   // 每轮每个站往后补几页老的(一个站几千部,一两天补完;对资源站很轻)
    noShortSkipMs: 7 * 86400e3, errSkipMs: 2 * 3600e3,
    hotBonusMs: 2 * 86400e3, calBonusMs: 86400e3,
});
const PREFER = ['rycj', 'ffzy', 'lzi', 'ikun', 'lzcaiji', 'mgzy', 'xgzy'];
const SHORT_RE = /短剧|爽文|爽剧|古装仙侠|现代都市|穿越年代|年代穿越|言情总裁|重生民国|脑洞悬疑|女频恋爱|反转/;
const BLOCK_RE = /擦边|伦理|三级|写真|福利|情色|成人|漫剧|动漫|动画|ai/i;
const NSFW_TITLE = /玉蒲团|蜜桃成熟|色欲|淫|情色|艳情|春宫|三级|性爱|乱伦|走肾|裸|小姨子|嫂子的|继母的/;
const AI_TITLE = /[(（\[【]\s*ai\s*[)）\]】]|ai短剧|ai漫/i;
const TIER_RANK = { clean: 0, noburn: 1, insert: 2, ads: 3, unknown: 4 };   // 与前端 SRC_TIER_RANK 同序(未评测排在有水印后面)
// 「短剧」分类页的题材标签:先看资源站的分类名 / vod_class,都没有再看片名。一部可以有几个标签。
const TAGS = [
    ['dushi', '都市', /都市|现代|总裁|职场|豪门|闪婚|婚恋|富豪|千金|霸总|首富/],
    ['guzhuang', '古装', /古装|仙侠|宫廷|宫斗|武侠|玄幻|修仙|王爷|皇后|皇上|太子|公主|王妃|侯府|嫡女|庶女|将军/],
    ['tianchong', '甜宠', /甜宠|恋爱|言情|女频|爱情|虐恋|追妻|宠妻|心动|甜蜜/],
    ['nixi', '逆袭', /逆袭|爽文|爽剧|反转|战神|赘婿|神豪|男频|打脸|龙王|至尊|无敌|下山|神医/],
    ['chuanyue', '重生穿越', /重生|穿越|年代|民国|系统|七零|八零|九零|六零|回到/],
    ['xuanyi', '悬疑', /悬疑|脑洞|惊悚|推理|奇幻|科幻|灵异|末世|悬念|探案/],
    ['jiating', '家庭', /家庭|萌宝|亲情|婆媳|奶爸|养娃|带娃|母亲|父亲|妈妈|爸爸/],
];
const TAG_KEYS = TAGS.map((t) => t[0]);
function tagsOf(type, cls, title) {
    const strong = String(type || '') + ' ' + String(cls || '');
    let out = TAGS.filter((t) => t[2].test(strong)).map((t) => t[0]);
    if (!out.length) out = TAGS.filter((t) => t[2].test(String(title || ''))).map((t) => t[0]);
    return out.length ? ',' + out.join(',') + ',' : '';
}
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
// 后加的列(老 cache.db 里的表没有,启动时补上):tags 题材标签 ',dushi,nixi,';whole 1 = 只有「全集」单文件;cursor 往后补到第几页
const MIGRATE = [
    ['shorts_items', 'tags', "TEXT NOT NULL DEFAULT ''"], ['shorts_items', 'whole', 'INTEGER NOT NULL DEFAULT 0'],
    ['shorts_state', 'cursor', "TEXT NOT NULL DEFAULT '{}'"], ['shorts_state', 'whole', 'INTEGER NOT NULL DEFAULT 0'],
];
const ST_COLS = ['site', 'api', 'leaves', 'classes_at', 'last_ok', 'skip_until', 'total', 'multi', 'last_err', 'cursor', 'whole'];
const ST_DEF = { api: '', leaves: '[]', classes_at: 0, last_ok: 0, skip_until: 0, total: 0, multi: 0, last_err: '', cursor: '{}', whole: 0 };
const likeEsc = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

// 分类页查询参数 → 规整(cat 只认已知标签;q 去空白截 30 字)
function listArgs(p) {
    p = p || {};
    return {
        off: Math.max(0, Math.min(20000, Number(p.offset) || 0)), lim: Math.max(1, Math.min(60, Number(p.limit) || 30)),
        cat: TAG_KEYS.indexOf(String(p.cat || '')) >= 0 ? String(p.cat) : '',
        sort: p.sort === 'hot' ? 'hot' : 'new', q: String(p.q || '').replace(/\s+/g, '').slice(0, 30),
        eps: p.only === 'eps',
    };
}

// 内存版(没 sqlite):接口与下面 sqlite 版一致
function memStore() {
    const items = new Map(), state = new Map();
    const vals = () => Array.from(items.values());
    const order = (a, b) => b.score - a.score || (a.nk < b.nk ? -1 : 1);
    return {
        get: (nk) => items.get(nk) || null,
        put: (r) => { items.set(r.nk, r); },
        count: (feedOnly) => (feedOnly ? vals().filter((r) => !r.whole).length : items.size),
        page: (off, lim) => vals().filter((r) => !r.whole).sort(order).slice(off, off + lim),
        list: (a) => {
            let rs = vals();
            if (a.cat) rs = rs.filter((r) => (r.tags || '').indexOf(',' + a.cat + ',') >= 0);
            if (a.q) rs = rs.filter((r) => r.title.replace(/\s+/g, '').indexOf(a.q) >= 0);
            if (a.eps) rs = rs.filter((r) => !r.whole);
            rs.sort(a.sort === 'hot' ? order : (x, y) => y.t - x.t || (x.nk < y.nk ? -1 : 1));
            return { rows: rs.slice(a.off, a.off + a.lim), total: rs.length };
        },
        tagCount: (k) => vals().filter((r) => (r.tags || '').indexOf(',' + k + ',') >= 0).length,
        prune: (cutT, max) => {
            for (const [k, r] of items) if (r.t < cutT) items.delete(k);
            if (items.size > max) vals().sort((a, b) => a.score - b.score).slice(0, items.size - max).forEach((r) => items.delete(r.nk));
        },
        st: (site) => state.get(site) || null,
        setSt: (site, v) => { state.set(site, Object.assign({}, ST_DEF, state.get(site) || {}, v, { site })); },
        sts: () => Array.from(state.values()),
        calHot: () => 0,
        tx: (fn) => fn(),
    };
}
function sqlStore(db) {
    db.exec(SCHEMA);
    let added = false;
    for (const [tb, col, def] of MIGRATE) {
        const has = db.prepare(`PRAGMA table_info(${tb})`).all().some((c) => c.name === col);
        if (!has) { db.exec(`ALTER TABLE ${tb} ADD COLUMN ${col} ${def}`); if (col === 'tags') added = true; }
    }
    db.exec('CREATE INDEX IF NOT EXISTS shorts_items_t ON shorts_items (t); CREATE INDEX IF NOT EXISTS shorts_items_ws ON shorts_items (whole, score);');
    // 旧规则「几乎全是全集单文件 → 3 天不拉」已经没了(全集的现在进分类页):旧版记下的跳过作废
    db.prepare("UPDATE shorts_state SET skip_until = 0, last_err = '' WHERE last_err = '多为全集单文件'").run();
    if (added) {   // 老片库补上题材标签(只有分类名 + 片名可看)
        const up = db.prepare('UPDATE shorts_items SET tags = ? WHERE nk = ?');
        db.transaction(() => { for (const r of db.prepare('SELECT nk, title, type FROM shorts_items').all()) up.run(tagsOf(r.type, '', r.title), r.nk); })();
    }
    const q = {
        get: db.prepare('SELECT * FROM shorts_items WHERE nk = ?'),
        put: db.prepare(`INSERT INTO shorts_items (nk, title, pic, remarks, blurb, year, area, type, eps, t, score, srcs, tags, whole) VALUES (@nk,@title,@pic,@remarks,@blurb,@year,@area,@type,@eps,@t,@score,@srcs,@tags,@whole)
            ON CONFLICT(nk) DO UPDATE SET title=excluded.title, pic=excluded.pic, remarks=excluded.remarks, blurb=excluded.blurb, year=excluded.year, area=excluded.area,
            type=excluded.type, eps=excluded.eps, t=excluded.t, score=excluded.score, srcs=excluded.srcs, tags=excluded.tags, whole=excluded.whole`),
        count: db.prepare('SELECT count(*) AS c FROM shorts_items'),
        countFeed: db.prepare('SELECT count(*) AS c FROM shorts_items WHERE whole = 0'),
        page: db.prepare('SELECT * FROM shorts_items WHERE whole = 0 ORDER BY score DESC, nk LIMIT ? OFFSET ?'),
        tagCount: db.prepare("SELECT count(*) AS c FROM shorts_items WHERE tags LIKE ? ESCAPE '\\'"),
        pruneT: db.prepare('DELETE FROM shorts_items WHERE t < ?'),
        pruneN: db.prepare('DELETE FROM shorts_items WHERE nk IN (SELECT nk FROM shorts_items ORDER BY score ASC LIMIT ?)'),
        st: db.prepare('SELECT * FROM shorts_state WHERE site = ?'),
        sts: db.prepare('SELECT * FROM shorts_state'),
        setSt: db.prepare(`INSERT INTO shorts_state (${ST_COLS.join(', ')}) VALUES (${ST_COLS.map((c) => '@' + c).join(',')})
            ON CONFLICT(site) DO UPDATE SET ${ST_COLS.slice(1).map((c) => c + '=excluded.' + c).join(', ')}`),
    };
    let calQ = null;
    try { calQ = db.prepare("SELECT max(n) AS n FROM cal_items WHERE nk = ? AND cat = 'short' AND day >= ?"); } catch (e) { calQ = null; }   // 追剧日历没开 = 没这张表
    const row = (r) => (r ? Object.assign({}, r, { srcs: (() => { try { return JSON.parse(r.srcs); } catch (e) { return []; } })() }) : null);
    const listQ = new Map();
    return {
        get: (nk) => row(q.get.get(nk)),
        put: (r) => { q.put.run(Object.assign({ tags: '', whole: 0 }, r, { srcs: JSON.stringify(r.srcs || []), whole: r.whole ? 1 : 0 })); },
        count: (feedOnly) => (feedOnly ? q.countFeed : q.count).get().c,
        page: (off, lim) => q.page.all(lim, off).map(row),
        list: (a) => {
            const where = [], args = [];
            if (a.cat) { where.push("tags LIKE ? ESCAPE '\\'"); args.push('%,' + likeEsc(a.cat) + ',%'); }
            if (a.q) { where.push("replace(title, ' ', '') LIKE ? ESCAPE '\\'"); args.push('%' + likeEsc(a.q) + '%'); }
            if (a.eps) where.push('whole = 0');
            const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
            const ord = a.sort === 'hot' ? 'score DESC, nk' : 't DESC, nk';
            const key = w + '|' + ord;
            let s = listQ.get(key);
            if (!s) { s = { rows: db.prepare(`SELECT * FROM shorts_items${w} ORDER BY ${ord} LIMIT ? OFFSET ?`), n: db.prepare(`SELECT count(*) AS c FROM shorts_items${w}`) }; listQ.set(key, s); }
            return { rows: s.rows.all(...args, a.lim, a.off).map(row), total: s.n.get(...args).c };
        },
        tagCount: (k) => q.tagCount.get('%,' + likeEsc(k) + ',%').c,
        prune: (cutT, max) => {
            q.pruneT.run(cutT);
            const n = q.count.get().c;
            if (n > max) q.pruneN.run(n - max);
        },
        st: (site) => q.st.get(site) || null,
        setSt: (site, v) => { q.setSt.run(Object.assign({}, ST_DEF, q.st.get(site) || {}, v, { site })); },
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
    // 线路先后:一集一集的在「全集」单文件前面;同类按广告分级、集数多、更新近
    const srcOrder = (a, b) => ((a.w ? 1 : 0) - (b.w ? 1 : 0)) || (rankOf(a.s) - rankOf(b.s)) || (b.n - a.n) || (b.t - a.t);

    // 一条资源站记录 → 并进片库。返回 2 = 一集一集的短剧,1 = 「全集」单文件(只进分类页),0 = 不收
    function put(st, site, v) {
        const title = String(v.vod_name || '').trim();
        if (!title || NSFW_TITLE.test(title) || AI_TITLE.test(title)) return 0;
        const type = String(v.type_name || '');
        if (BLOCK_RE.test(type)) return 0;
        const pl = pickLine(v.vod_play_from, v.vod_play_url);
        if (!pl) return 0;
        const whole = pl.n < opts.minEps;
        if (whole && pl.n !== 1) return 0;   // 两三集的多半是预告 / 刚开始更:先不收
        const nk = norm(title);
        if (!nk) return 0;
        const t = timeOf(v.vod_time) || now();
        const src = { s: site.key, id: String(v.vod_id), n: pl.n, t, u: pl.line };
        if (whole) src.w = 1;
        const old = st.get(nk);
        const pic = /^https?:\/\//i.test(String(v.vod_pic || '')) ? String(v.vod_pic).slice(0, 400) : '';
        const remarks = String(v.vod_remarks || '').slice(0, 30);
        let blurb = cleanText(v.vod_blurb || v.vod_content, 160);
        if (spammy(blurb)) blurb = '';
        const tags = tagsOf(type, v.vod_class, title);
        const kind = whole ? 1 : 2;
        let r;
        if (!old) {
            r = { nk, title: title.slice(0, 80), pic, remarks, blurb, year: Number(v.vod_year) || 0, area: String(v.vod_area || '').slice(0, 20), type: type.slice(0, 20),
                eps: pl.n, t, srcs: [src], tags, whole: whole ? 1 : 0 };
        } else {
            const others = (old.srcs || []).filter((x) => x.s !== site.key);
            const head = (u) => String(u || '').split('#')[0].replace(/^[^$]*\$/, '');
            if (others.some((x) => head(x.u) === head(src.u))) {   // 镜像站(量子 / 量子2 同一个 CDN 地址):不算第二条线路,也不算更热
                if (others.length < (old.srcs || []).length) { const m = Object.assign({}, old, { srcs: others }); m.score = scoreOf(st, m); st.put(m); }   // 旧版本记进去的镜像线路顺手去掉
                return kind;
            }
            const epOthers = others.filter((x) => !x.w);
            if (!whole && epOthers.length && !sameWork(Math.max.apply(null, epOthers.map((x) => x.n)), pl.n)) return kind;   // 同名不同部(集数对不上):不并,留先来的那部
            const srcs = others.concat([src]).sort(srcOrder).slice(0, opts.maxSrcs);
            if (!srcs.some((x) => x.s === site.key)) return kind;
            const epSrcs = srcs.filter((x) => !x.w);
            const best = (epSrcs.length ? epSrcs : srcs).reduce((a, b) => (b.n > a.n ? b : a));
            r = Object.assign({}, old, {
                pic: old.pic || pic, blurb: old.blurb || blurb, type: old.type || type.slice(0, 20),
                remarks: best === src ? remarks : old.remarks, eps: epSrcs.length ? Math.max.apply(null, epSrcs.map((x) => x.n)) : 1,
                t: Math.max(old.t, t), srcs, whole: epSrcs.length ? 0 : 1,
                tags: old.tags && !tags ? old.tags : (tags || old.tags || ''),
            });
        }
        r.score = scoreOf(st, r);
        st.put(r);
        return kind;
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

    async function pullPage(st, site, leaf, pg, cnt) {
        const d = await getJson(apiUrl(site.api, `ac=detail&t=${encodeURIComponent(leaf)}&pg=${pg}`));
        if (!d || !Array.isArray(d.list)) throw new Error('不是 maccms 列表');
        let got = 0;
        st.tx(() => { for (const v of d.list) { cnt.total++; const k = put(st, site, v); if (k === 2) cnt.multi++; if (k === 1) cnt.whole++; if (k) got++; } });
        if (opts.pageGapMs) await sleep(opts.pageGapMs);
        return { n: d.list.length, got, pc: Number(d.pagecount) || 0 };
    }

    async function pullSite(st, site) {
        const s0 = st.st(site.key);
        if (s0 && s0.api === site.api && s0.skip_until > now()) return 0;
        const firstRun = !(s0 && s0.api === site.api && s0.last_ok);
        const leaves = await leavesOf(st, site);
        if (!leaves.length) { st.setSt(site.key, { skip_until: now() + opts.noShortSkipMs, last_err: '没有短剧分类' }); return 0; }
        const cnt = { total: 0, multi: 0, whole: 0 };
        let cur = {};
        try { cur = (!firstRun && s0 && JSON.parse(s0.cursor || '{}')) || {}; } catch (e) { cur = {}; }
        // ① 最新的几页(第一次跑 5 页,之后每轮 1 页)
        const head = firstRun ? opts.pagesFirst : opts.pagesTick;
        for (const leaf of leaves) {
            for (let pg = 1; pg <= head && !stopped; pg++) {
                const r = await pullPage(st, site, leaf, pg, cnt);
                if (!r.n || !r.pc || pg >= r.pc) { if (firstRun) cur[leaf] = -1; break; }   // 第一次就翻到底了:这个分类不用往后补
            }
            if (cur[leaf] == null) cur[leaf] = head + 1;
            if (stopped) break;
        }
        // ② 往后补老的:每轮每站最多 backfillPages 页,补到最后一页记 -1(以后只看最新那页)
        let budget = opts.backfillPages;
        for (const leaf of leaves) {
            while (budget > 0 && !stopped && cur[leaf] > 0) {
                const pg = cur[leaf];
                const r = await pullPage(st, site, leaf, pg, cnt);
                budget--;
                cur[leaf] = (!r.n || !r.pc || pg >= r.pc) ? -1 : pg + 1;
            }
            if (budget <= 0 || stopped) break;
        }
        st.setSt(site.key, { last_ok: now(), total: cnt.total, multi: cnt.multi, whole: cnt.whole, cursor: JSON.stringify(cur), last_err: '', skip_until: 0 });
        return cnt.multi + cnt.whole;
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
    function kick() { if (!running && !stopped && !store().count(true)) tick(); }

    const srcOut = (x) => Object.assign({ site_key: x.s, vod_id: x.id, n: x.n, t: x.t, url: x.u }, x.w ? { whole: true } : {});
    const tagList = (s) => String(s || '').split(',').filter(Boolean);
    function itemOut(r) {
        return { id: r.nk, title: r.title, pic: r.pic, remarks: r.remarks, blurb: r.blurb, year: r.year, area: r.area, type: r.type, eps: r.eps, t: r.t,
            whole: !!r.whole, tags: tagList(r.tags), srcs: (r.srcs || []).map(srcOut) };
    }
    // 分类页的卡片不带选集串(一页 30 部,带上就是几百 KB);full = 1 时带(竖屏刷接着往下刷要用)
    function cardOut(r) {
        return { id: r.nk, title: r.title, pic: r.pic, remarks: r.remarks, year: r.year, type: r.type, eps: r.eps, t: r.t, whole: !!r.whole, tags: tagList(r.tags), n: (r.srcs || []).length };
    }
    function cached(key, fn) {
        const hit = memo.get(key);
        if (hit && now() - hit.at < 60e3) return hit.v;
        const v = fn();
        if (memo.size > 300) memo.clear();
        memo.set(key, { v, at: now() });
        return v;
    }
    function feed(offset, limit) {
        const st = store();
        const off = Math.max(0, Math.min(5000, Number(offset) || 0)), lim = Math.max(1, Math.min(20, Number(limit) || 8));
        const total = st.count(true);
        if (!total) return { items: [], total: 0, offset: off, next: null, ver, warming: !!running };   // 空片库不记:正在拉的那一轮随时会有东西
        return cached('f|' + off + '|' + lim, () => {
            const items = st.page(off, lim).map(itemOut);
            return { items, total, offset: off, next: off + items.length < total ? off + items.length : null, ver, warming: false };
        });
    }
    function list(p) {
        const a = listArgs(p), full = !!(p && (p.full === 1 || p.full === '1' || p.full === true));
        return cached('l|' + JSON.stringify(a) + '|' + full, () => {
            const r = store().list(a);
            const items = r.rows.map(full ? itemOut : cardOut);
            return { items, total: r.total, offset: a.off, next: a.off + items.length < r.total ? a.off + items.length : null, ver, cat: a.cat, sort: a.sort, q: a.q };
        });
    }
    function item(id) {
        const r = store().get(String(id || '').slice(0, 130));
        return r ? itemOut(r) : null;
    }
    function cats() {
        return cached('c', () => {
            const st = store();
            return { total: st.count(false), eps: st.count(true), tags: TAGS.map(([k, l]) => ({ k, l, n: st.tagCount(k) })) };
        });
    }
    function status() {
        const st = store();
        return { running: !!running, items: st.count(false), eps: st.count(true), ver,
            sites: st.sts().map((s) => ({ site: s.site, leaves: s.leaves, last_ok: s.last_ok, skip_until: s.skip_until, total: s.total, multi: s.multi, whole: s.whole, cursor: s.cursor, last_err: s.last_err })) };
    }
    function start() {
        if (timer || stopped) return;
        first = setTimeout(() => tick(), opts.firstDelayMs); if (first.unref) first.unref();
        timer = setInterval(() => tick(), opts.tickMs); if (timer.unref) timer.unref();
    }
    function stop() { stopped = true; clearInterval(timer); clearTimeout(first); }
    return { start, stop, tick, kick, feed, list, item, cats, status };
}

module.exports = { createShortsFeed, pickLine, shortLeaves, sameWork, norm, timeOf, tagsOf, TAGS };
