'use strict';
// 📅 全站追剧周表:每 30 分钟从几个大资源站拉「最近 N 小时更新」(?ac=detail&h=),按资源站自己的更新日期(vod_time,北京时间)
//   归到哪一天、按片名去重,分 电视剧 / 动漫 / 综艺 / 电影 / 纪录片 / 短剧 存进 cache.db;首页「追剧日历」读它。
//   资源站只知道「已经更新了什么」,今天以后的日子靠两样补(都标「待播」,资源站真更新了就换成真的那条):
//   · TMDB 排期:每 6 小时按「最近两周有新集播出」从 TMDB 拉 大陆/港台/日韩/欧美 的剧、动漫、综艺,逐部查这一季每集的播出日(cal_sched)
//   · 按规律预计:TMDB 没有的(国产真人剧大多没有),前一周、前两周的同一天资源站都更新过 → 这周这天大概也更新(只猜 6 天内)
//
// createCalendar({ db, sites, httpGet, tmdbGet?, log?, now?, opts? })
//   db       () → better-sqlite3 连接或 null(没 sqlite 就整块关掉)
//   sites    () → [{key, name, api}] 拿来当更新源的 maccms 站(server.js 按 CALENDAR_SITES / 默认挑 3 个)
//   httpGet  async (url, timeoutMs) → 响应体(对象或字符串)
//   tmdbGet  async (path, params) → TMDB JSON(没配 TMDB_API_KEY 时不传 → 未来只有「按规律预计」)
//   opts.tmdbImg  TMDB 图片前缀(…/t/p,有 TMDB_PROXY_URL 时走代理)
// → { start(), stop(), tick(), week(day, limit, tz, tzo), list(day, cat, offset, limit, tz, tzo), status() }
//
// 「哪一天」按看的人浏览器的时区(tz = IANA 名,如 America/Vancouver;tzo = 浏览器此刻的 UTC 偏移分钟;都不传 = 北京时间)现算:
//   资源站的每条都有更新时刻 t,按 t 落到当地哪天;TMDB 只给播出日期 → 按产地时区 + 当地黄金档估一个时刻(AIR)再落天。
//   存的 day 列仍是北京日期 / 产地播出日,只用来去重和判「新上」。
//
// 分类:优先看父分类(详情里的 type_id_1 → 分类表里的名字),再看子分类名;伦理 / 三级 / 写真 / 擦边 / 体育 / 预告 / 解说一律不收。
// 电影只收近两年的(老片重新上架会把「本周更新」刷满);同一部在几个站都更新了只算一条(n = 几个站),展示用集数最大的那条备注。
const DEF = Object.freeze({
    tickMs: 30 * 60e3, firstDelayMs: 2 * 60e3, maxPages: 30, firstMaxPages: 150, pageGapMs: 400, timeoutMs: 15000,
    classesTtlMs: 24 * 3600e3, keepDays: 63, firstHours: 72, maxHours: 72,
    // TMDB 排期:每 6 小时一轮(失败 1 小时后再试);看今天起 14 天;每个产地按热度拉前几页(一页 20 部),逐部查详情 + 这一季
    schedEveryMs: 6 * 3600e3, schedRetryMs: 3600e3, schedDays: 14, schedGapMs: 150, guessDays: 6, tmdbImg: 'https://image.tmdb.org/t/p',
    schedCountries: [['CN', 5], ['HK', 1], ['TW', 1], ['KR', 2], ['JP', 3], ['US', 3], ['GB', 1]],
});
const AREA = { CN: '大陆', HK: '香港', TW: '台湾', KR: '韩国', JP: '日本', US: '美国', GB: '英国', CA: '加拿大', AU: '澳大利亚' };
// 排序:先华语、再日韩、再欧美,同一档里按 TMDB 热度(各产地热度量级差十倍,不能直接比)
const TIER = { CN: 2, HK: 2, TW: 2, KR: 1, JP: 1 };
const tierOfArea = (a) => (/大陆|内地|中国|香港|台湾/.test(String(a || '')) ? 2 : /韩|日/.test(String(a || '')) ? 1 : 0);
// TMDB 只有播出日期:按 [产地 UTC 偏移, 当地几点] 估「什么时候能看到」(资源站一般播出后一两个小时就有),只拿来落到当地哪一天,
//   具体几点不显示。美剧当地 21 点播 = 北京第二天上午、温哥华当天傍晚;国产剧北京 20 点 = 温哥华当天清早
const AIR = { CN: [8, 20], HK: [8, 21], TW: [8, 21], KR: [9, 22], JP: [9, 23], US: [-5, 21], CA: [-5, 21], GB: [0, 21], AU: [10, 20] };
const airT = (day, oc) => { const a = AIR[oc] || AIR.CN; return Date.parse(day + 'T00:00:00Z') + (a[1] - a[0]) * 3600e3; };
const SCHED_BLOCK = /教程|教学|儿歌|早教|singsing|摔跤|WWE|AEW|[\u3040-\u30ff]/i;   // 少儿英语 / 方言教学片、摔跤节目、没译名的日文片名(资源站搜不到)
const DONE_RE = /全\s*\d+\s*[集话話期]|\d+\s*[集话話期]\s*全|完结|大结局|已完/;
const BLOCK_RE = /伦理|三级|写真|两性|擦边|福利|情色|成人|体育|赛事|篮球|足球|台球|斯诺克|网球|排球|NBA|CBA|F1|预告|花絮|解说|演唱会|有声|课堂|学习/i;
const NSFW_TITLE = /玉蒲团|蜜桃成熟|色欲|淫|情色|艳情|春宫|三级|性爱|乱伦|走肾|裸|小姨子|嫂子的|继母的/;
const SHORT_RE = /短剧|爽文|爽剧|漫剧|古装仙侠|现代都市|穿越年代|年代穿越|言情总裁|重生民国|脑洞悬疑|女频恋爱|反转/;
function catOf(parentName, typeName) {
    const p = String(parentName || ''), t = String(typeName || '');
    if (BLOCK_RE.test(t) || BLOCK_RE.test(p)) return null;
    if (SHORT_RE.test(t) || SHORT_RE.test(p)) return 'short';
    const by = (s) => {
        if (/动漫|动画|番剧/.test(s)) return 'anime';
        if (/综艺|真人秀|晚会|脱口秀/.test(s)) return 'variety';
        if (/纪录|记录/.test(s)) return 'doc';
        if (/连续剧|电视剧|剧集|剧$/.test(s)) return 'tv';
        if (/电影|片$/.test(s)) return 'movie';
        return null;
    };
    // 「动漫电影」在父分类「电影」下 → 先看子分类名里有没有更具体的
    return by(t) || by(p);
}
const norm = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 120);
// 备注 → 集数:更新至第16集 / 更新至16集 / 全30集 / 第20261126期 / 16集全
function epOf(remarks) {
    const s = String(remarks || '');
    let m = /第?(\d{8})期/.exec(s); if (m) return Number(m[1]);
    m = /(?:更新至|更至|连载至|全|第)?\s*(\d{1,4})\s*[集话話期]/.exec(s); if (m) return Number(m[1]);
    return 0;
}
// 资源站的 vod_time 是北京时间字符串;day = 日期部分,t = 对应的毫秒
function timeOf(vodTime) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(vodTime || ''));
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 8 * 3600e3;
    return { day: `${m[1]}-${m[2]}-${m[3]}`, t };
}
// 北京时间的日期 / 星期一
function cnDay(ms) { return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10); }
function mondayOf(day) {
    const d = new Date(day + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;   // 周一 = 0
    return new Date(d.getTime() - dow * 86400e3).toISOString().slice(0, 10);
}
const addDays = (day, n) => new Date(new Date(day + 'T00:00:00Z').getTime() + n * 86400e3).toISOString().slice(0, 10);
// 时区:IANA 名 → 某一时刻比 UTC 快多少毫秒(夏令时自动对);北京时间直接 +8 不走 Intl
const TZ_CN = 'Asia/Shanghai';
const tzFmts = new Map();
function tzFmt(tz) {
    let f = tzFmts.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        if (tzFmts.size > 100) tzFmts.clear();
        tzFmts.set(tz, f);
    }
    return f;
}
// tz = 浏览器的 IANA 时区名;off = 浏览器此刻真实的 UTC 偏移(分钟,东正西负)。
//   服务器 Node 的时区库和浏览器不一致时(比如卑诗省改成全年 UTC-7,旧时区库还按冬令时 UTC-8)按浏览器的偏移,
//   用固定偏移「@分钟」:今天 / 每条落哪天跟浏览器显示的时刻对得上
function tzOf(tz, off, nowMs) {
    const s = String(tz || '');
    let z = TZ_CN;
    if (s && s !== TZ_CN && s.length <= 64 && /^[-A-Za-z0-9_+/]+$/.test(s)) { try { tzFmt(s); z = s; } catch (e) { /* 不认识 */ } }
    const o = off === undefined || off === null || off === '' ? NaN : Number(off);
    if (Number.isInteger(o) && Math.abs(o) <= 14 * 60 && o % 15 === 0 && Math.round(tzOff(z, nowMs) / 60e3) !== o) return '@' + o;
    return z;
}
function tzOff(tz, ms) {
    if (tz === TZ_CN) return 8 * 3600e3;
    if (tz.charAt(0) === '@') return Number(tz.slice(1)) * 60e3;
    const p = {};
    for (const x of tzFmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
const dayIn = (tz, ms) => new Date(ms + tzOff(tz, ms)).toISOString().slice(0, 10);
// 当地 day 这一天 = [0 点, 第二天 0 点) 的 UTC 毫秒
function dayRange(tz, day) {
    const at = (d) => { const b = Date.parse(d + 'T00:00:00Z'); return b - tzOff(tz, b - tzOff(tz, b)); };
    return [at(day), at(addDays(day, 1))];
}
const parse = (b) => {
    if (b && typeof b === 'object') return b;
    const s = String(b == null ? '' : b).replace(/^﻿/, '').trim();
    try { return JSON.parse(s); } catch (e) { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiUrl = (api, q) => api + (api.indexOf('?') >= 0 ? '&' : '?') + q;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cal_items (
    day     TEXT NOT NULL,
    nk      TEXT NOT NULL,
    title   TEXT NOT NULL,
    cat     TEXT NOT NULL,
    remarks TEXT NOT NULL DEFAULT '',
    ep      INTEGER NOT NULL DEFAULT 0,
    pic     TEXT NOT NULL DEFAULT '',
    year    INTEGER NOT NULL DEFAULT 0,
    area    TEXT NOT NULL DEFAULT '',
    t       INTEGER NOT NULL DEFAULT 0,
    sites   TEXT NOT NULL DEFAULT '',
    n       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (day, nk)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cal_items_day_cat ON cal_items (day, cat);
CREATE INDEX IF NOT EXISTS cal_items_nk ON cal_items (nk, day);
CREATE INDEX IF NOT EXISTS cal_items_t ON cal_items (t);
CREATE TABLE IF NOT EXISTS cal_sched (
    t      INTEGER NOT NULL DEFAULT 0,
    day    TEXT NOT NULL,
    nk     TEXT NOT NULL,
    title  TEXT NOT NULL,
    cat    TEXT NOT NULL,
    ep     INTEGER NOT NULL DEFAULT 0,
    ep2    INTEGER NOT NULL DEFAULT 0,
    season INTEGER NOT NULL DEFAULT 0,
    tag    TEXT NOT NULL DEFAULT '',
    pic    TEXT NOT NULL DEFAULT '',
    year   INTEGER NOT NULL DEFAULT 0,
    area   TEXT NOT NULL DEFAULT '',
    score  REAL NOT NULL DEFAULT 0,
    tmdb   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, nk)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cal_seen (nk TEXT PRIMARY KEY, first_day TEXT NOT NULL, last_day TEXT NOT NULL DEFAULT '') WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cal_state (site TEXT PRIMARY KEY, api TEXT NOT NULL DEFAULT '', last_ok INTEGER NOT NULL DEFAULT 0,
    classes TEXT NOT NULL DEFAULT '{}', classes_at INTEGER NOT NULL DEFAULT 0, last_err TEXT NOT NULL DEFAULT '', items INTEGER NOT NULL DEFAULT 0);`;
const CATS = ['tv', 'anime', 'variety', 'movie', 'doc', 'short'];

function createCalendar(o) {
    const opts = Object.assign({}, DEF, (o && o.opts) || {});
    const log = o.log || (() => { });
    const now = o.now || Date.now;
    let timer = null, first = null, running = false, stopped = false, ready = null;
    const memo = new Map();   // 读接口 60s 缓存

    function dbOk() {
        const db = o.db();
        if (!db) return null;
        if (ready !== db) {
            db.exec(SCHEMA);
            // 早期版本的 cal_seen 没有 last_day(只在开发机上跑过)
            if (!db.prepare('PRAGMA table_info(cal_seen)').all().some((c) => c.name === 'last_day')) db.exec("ALTER TABLE cal_seen ADD COLUMN last_day TEXT NOT NULL DEFAULT ''");
            // 第一版 cal_sched 没有 t(按北京日期存的):补列、清掉、让下一轮马上重拉 TMDB
            if (!db.prepare('PRAGMA table_info(cal_sched)').all().some((c) => c.name === 't')) {
                db.exec("ALTER TABLE cal_sched ADD COLUMN t INTEGER NOT NULL DEFAULT 0; DELETE FROM cal_sched; UPDATE cal_state SET last_ok = 0, classes_at = 0 WHERE site = '@tmdb';");
            }
            db.exec('CREATE INDEX IF NOT EXISTS cal_sched_t ON cal_sched (t)');
            ready = db;
        }
        return db;
    }

    async function getJson(url) { return parse(await o.httpGet(url, opts.timeoutMs)); }

    async function classesOf(db, site, st) {
        if (st && st.api === site.api && now() - st.classes_at < opts.classesTtlMs) {
            try { return JSON.parse(st.classes); } catch (e) { /* 重拉 */ }
        }
        const d = await getJson(apiUrl(site.api, 'ac=list'));
        const map = {};
        for (const c of (d && Array.isArray(d.class) ? d.class : [])) map[String(c.type_id)] = { n: String(c.type_name || ''), p: String(c.type_pid || '') };
        db.prepare(`INSERT INTO cal_state (site, api, classes, classes_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(site) DO UPDATE SET api = excluded.api, classes = excluded.classes, classes_at = excluded.classes_at`).run(site.key, site.api, JSON.stringify(map), now());
        return map;
    }

    function put(db, site, v, classes, thisYear, seeding) {
        const title = String(v.vod_name || '').trim();
        if (!title || NSFW_TITLE.test(title)) return false;
        const tm = timeOf(v.vod_time);
        if (!tm) return false;
        const c = classes[String(v.type_id)] || {};
        const parentId = String(v.type_id_1 || c.p || '');
        const parent = (classes[parentId] || {}).n || '';
        const cat = catOf(parent, v.type_name || c.n);
        if (!cat) return false;
        const year = Number(v.vod_year) || 0;
        if (cat === 'movie' && (!year || year < thisYear - 1)) return false;   // 老电影重新上架不算「本周更新」
        const nk = norm(title);
        if (!nk) return false;
        const remarks = String(v.vod_remarks || '').slice(0, 40);
        const ep = epOf(remarks);
        const pic = /^https?:\/\//i.test(String(v.vod_pic || '')) ? String(v.vod_pic).slice(0, 400) : '';
        const old = db.prepare('SELECT * FROM cal_items WHERE day = ? AND nk = ?').get(tm.day, nk);
        if (!old) {
            db.prepare(`INSERT INTO cal_items (day, nk, title, cat, remarks, ep, pic, year, area, t, sites, n) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`)
                .run(tm.day, nk, title.slice(0, 80), cat, remarks, ep, pic, year, String(v.vod_area || '').slice(0, 20), tm.t, site.key);
        } else {
            const sites = old.sites.split(',').filter(Boolean);
            if (sites.indexOf(site.key) < 0) sites.push(site.key);
            const better = ep > old.ep;
            db.prepare(`UPDATE cal_items SET remarks = ?, ep = ?, pic = ?, t = ?, sites = ?, n = ? WHERE day = ? AND nk = ?`).run(
                better ? remarks : old.remarks, Math.max(ep, old.ep), old.pic || pic, Math.max(old.t, tm.t), sites.join(','), sites.length, tm.day, nk);
        }
        // 第一次跑(cal_seen 还是空的):这一批全记成「以前就有」,不然头一周满屏都是「新」。
        //   last_day = 最近一次看到它更新;清理按它(按 first_day 清的话,首轮那批 1970 当场就被清掉、播了半年的长剧也会又变「新上」)
        db.prepare(`INSERT INTO cal_seen (nk, first_day, last_day) VALUES (?, ?, ?)
            ON CONFLICT(nk) DO UPDATE SET first_day = min(first_day, excluded.first_day), last_day = max(last_day, excluded.last_day)`).run(nk, seeding ? '1970-01-01' : tm.day, tm.day);
        return true;
    }

    async function pullSite(db, site, seeding) {
        let st = db.prepare('SELECT * FROM cal_state WHERE site = ?').get(site.key);
        const classes = await classesOf(db, site, st);
        st = db.prepare('SELECT * FROM cal_state WHERE site = ?').get(site.key);
        const since = st && st.api === site.api && st.last_ok ? now() - st.last_ok : opts.firstHours * 3600e3;
        const hours = Math.max(1, Math.min(opts.maxHours, Math.ceil(since / 3600e3) + 1));
        const thisYear = new Date(now() + 8 * 3600e3).getUTCFullYear();
        const firstRun = !(st && st.api === site.api && st.last_ok);
        let n = 0;
        for (let pg = 1; pg <= (firstRun ? opts.firstMaxPages : opts.maxPages) && !stopped; pg++) {
            const d = await getJson(apiUrl(site.api, `ac=detail&h=${hours}&pg=${pg}`));
            if (!d || !Array.isArray(d.list)) throw new Error('不是 maccms 列表');
            db.transaction(() => { for (const v of d.list) if (put(db, site, v, classes, thisYear, seeding)) n++; })();
            const pc = Number(d.pagecount) || 0;
            if (!d.list.length || !pc || pg >= pc) break;
            await sleep(opts.pageGapMs);
        }
        db.prepare('UPDATE cal_state SET last_ok = ?, last_err = \'\', items = ? WHERE site = ?').run(now(), n, site.key);
        return n;
    }

    // TMDB 排期 → cal_sched(整张表换掉;中途出错 / 一半以上的剧查失败就留着旧的)。
    //   discover 的 air_date 只是粗筛(「这段时间前后都有集」也算),每部都要查 next_episode_to_air + 那一季每集的播出日才作数
    async function pullSched(db) {
        // 估的时刻在 [36 小时前, 14 天后] 的才收(西半球的「今天」比北京晚一天,昨天播的对他们可能还是今天)
        const from = now() - 36 * 3600e3, to = now() + opts.schedDays * 86400e3;
        const today = cnDay(from), end = cnDay(to);
        const cands = new Map();
        for (const [c, pages] of opts.schedCountries) {
            for (let pg = 1; pg <= pages && !stopped; pg++) {
                const d = await o.tmdbGet('/discover/tv', { 'air_date.gte': today, 'air_date.lte': end, with_origin_country: c, language: 'zh-CN',
                    timezone: 'Asia/Shanghai', sort_by: 'popularity.desc', without_genres: '10763,10767', page: pg });
                if (!d || !Array.isArray(d.results)) throw new Error('TMDB discover 没回列表');
                for (const x of d.results) if (x && x.id && !cands.has(x.id)) cands.set(x.id, c);
                if (pg >= (Number(d.total_pages) || 0)) break;
                await sleep(opts.schedGapMs);
            }
        }
        const rows = new Map();
        let good = 0, bad = 0;
        for (const [id, c0] of cands) {
            if (stopped) return 0;
            try {
                const t = await o.tmdbGet('/tv/' + id, { language: 'zh-CN' });
                if (!t || !t.id) throw new Error('no detail');
                good++;
                const nx = t.next_episode_to_air;
                const oc = (Array.isArray(t.origin_country) && t.origin_country[0]) || c0;
                if (!nx || !/^\d{4}-\d{2}-\d{2}/.test(String(nx.air_date || '')) || !(nx.season_number > 0) || airT(String(nx.air_date).slice(0, 10), oc) > to) continue;
                const title = String(t.name || '').trim();
                if (!/[\u3400-\u9fff]/.test(title) || NSFW_TITLE.test(title) || BLOCK_RE.test(title) || SCHED_BLOCK.test(title)) continue;   // 没中文译名的资源站也搜不到
                const g = (Array.isArray(t.genres) ? t.genres : []).map((x) => x && x.id);
                if (!AREA[oc] || g.includes(10763) || g.includes(10767)) continue;   // 别的产地 / 新闻 / 脱口秀
                if (g.includes(10766) && !TIER[oc]) continue;   // 欧美日更肥皂剧(加冕街、东区人、拉美电视小说)几十年几千集,资源站基本没有
                const cat = g.includes(16) ? 'anime' : g.includes(99) ? 'doc' : g.includes(10764) ? 'variety' : 'tv';
                const nk = norm(title);
                if (!nk) continue;
                let eps = [nx];
                await sleep(opts.schedGapMs);
                try {
                    const s = await o.tmdbGet(`/tv/${id}/season/${nx.season_number}`, { language: 'zh-CN' });
                    if (s && Array.isArray(s.episodes) && s.episodes.length) eps = s.episodes;
                } catch (e) { /* 只用 next_episode_to_air 那一集 */ }
                const base = {
                    title: title.slice(0, 80), cat, season: Number(nx.season_number) || 0,
                    pic: t.poster_path ? opts.tmdbImg + '/w342' + t.poster_path : '', year: Number(String(t.first_air_date || '').slice(0, 4)) || 0,
                    area: AREA[oc], score: (TIER[oc] || 0) * 1e5 + Math.min(99999, Number(t.popularity) || 0), tmdb: Number(t.id) || 0,
                };
                for (const e of eps) {
                    const ad = /^\d{4}-\d{2}-\d{2}/.test(String((e && e.air_date) || '')) ? String(e.air_date).slice(0, 10) : '';
                    const ep = Number(e && e.episode_number) || 0;
                    const at = ad ? airT(ad, oc) : 0;
                    if (!ad || at < from || at > to) continue;
                    const k = ad + '|' + nk, r = rows.get(k);
                    if (r && r.tmdb !== base.tmdb) { if (r.score >= base.score) continue; rows.delete(k); }   // 同名两部:留热的那部
                    const cur = rows.get(k);
                    if (cur) { cur.ep = Math.min(cur.ep || ep, ep || cur.ep); cur.ep2 = Math.max(cur.ep2, ep); if (ep === 1) cur.tag = base.season === 1 ? '首播' : '新季'; continue; }
                    rows.set(k, Object.assign({ t: at, day: ad, nk, ep, ep2: ep, tag: ep === 1 ? (base.season === 1 ? '首播' : '新季') : '' }, base));
                }
            } catch (e) { bad++; }
            await sleep(opts.schedGapMs);
        }
        if (stopped) return 0;
        if (!good || bad > good) throw new Error(`TMDB 查详情失败太多(${bad}/${good + bad}),留着上一轮的排期`);
        const ins = db.prepare(`INSERT INTO cal_sched (t, day, nk, title, cat, ep, ep2, season, tag, pic, year, area, score, tmdb)
            VALUES (@t, @day, @nk, @title, @cat, @ep, @ep2, @season, @tag, @pic, @year, @area, @score, @tmdb)`);
        db.transaction(() => {
            db.prepare('DELETE FROM cal_sched').run();
            for (const r of rows.values()) ins.run(r);
        })();
        return rows.size;
    }

    async function tick() {
        if (running || stopped) return;
        const db = dbOk();
        if (!db) return;
        running = true;
        try {
            const seeding = !db.prepare('SELECT 1 FROM cal_seen LIMIT 1').get();
            for (const site of (o.sites() || [])) {
                if (stopped) break;
                try { const n = await pullSite(db, site, seeding); log(`${site.key} 收了 ${n} 条`); }
                catch (e) {
                    try { db.prepare(`INSERT INTO cal_state (site, api, last_err) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET last_err = excluded.last_err`).run(site.key, site.api, String(e.message || e).slice(0, 200)); } catch (e2) { /* ignore */ }
                    log(`${site.key} 拉取失败:`, e.message);
                }
            }
            // TMDB 排期:6 小时一轮(上次失败的 1 小时后再试);状态记在 cal_state 的 @tmdb 行(classes_at = 上次尝试)
            if (o.tmdbGet && !stopped) {
                const st = db.prepare("SELECT * FROM cal_state WHERE site = '@tmdb'").get();
                if (!st || (now() - st.last_ok >= opts.schedEveryMs && now() - st.classes_at >= opts.schedRetryMs)) {
                    db.prepare(`INSERT INTO cal_state (site, api, classes_at) VALUES ('@tmdb', 'tmdb', ?) ON CONFLICT(site) DO UPDATE SET classes_at = excluded.classes_at`).run(now());
                    try {
                        const n = await pullSched(db);
                        if (!stopped) { db.prepare("UPDATE cal_state SET last_ok = ?, last_err = '', items = ? WHERE site = '@tmdb'").run(now(), n); log(`TMDB 排期 ${n} 条`); }
                    } catch (e) {
                        db.prepare("UPDATE cal_state SET last_err = ? WHERE site = '@tmdb'").run(String(e.message || e).slice(0, 200));
                        log('TMDB 排期拉取失败:', e.message);
                    }
                }
            }
            db.prepare('DELETE FROM cal_sched WHERE t < ?').run(now() - 2 * 86400e3);
            const cut = addDays(cnDay(now()), -opts.keepDays);
            db.prepare('DELETE FROM cal_items WHERE day < ?').run(cut);
            db.prepare('DELETE FROM cal_seen WHERE last_day < ?').run(addDays(cut, -120));   // 半年多没再更新过的才忘掉(再出现算新一季)
            memo.clear();
        } finally { running = false; }
    }

    function cached(key, fn) {
        const hit = memo.get(key);
        if (hit && now() - hit.at < 60e3) return hit.v;
        const v = fn();
        if (memo.size > 200) memo.clear();
        memo.set(key, { v, at: now() });
        return v;
    }
    // 「新上」= 这条就是它头一回出现的那条(按存的北京日期比,跟看的人在哪个时区无关)
    const itemOut = (r) => ({
        title: r.title, cat: r.cat, remarks: r.remarks, ep: r.ep, pic: r.pic, year: r.year, area: r.area, t: r.t, n: r.n,
        isNew: r._new != null ? r._new : r.first_day === r.day,
    });
    // 当地这天资源站更新了的:按 t 落天;同一部在北京时间两天各有一条、到这个时区落进同一天 → 只留集数大(晚)的那条
    function actual(db, z, day, cat) {
        const [a, b] = dayRange(z, day);
        const rows = db.prepare(`SELECT i.*, s.first_day FROM cal_items i LEFT JOIN cal_seen s ON s.nk = i.nk
            WHERE i.t >= ? AND i.t < ?${cat ? ' AND i.cat = ?' : ''} ORDER BY i.t DESC`).all(...(cat ? [a, b, cat] : [a, b]));
        const by = new Map();
        for (const r of rows) {
            r._new = r.first_day === r.day;
            const o0 = by.get(r.nk);
            if (!o0) by.set(r.nk, r);
            else { o0.n = Math.max(o0.n, r.n); o0._new = o0._new || r._new; }
        }
        return [...by.values()].sort((x, y) => y.n - x.n || y.t - x.t);
    }
    // 今天起还没更新的:plan = 'tmdb'(TMDB 排期)/ 'guess'(按规律预计);tag = 首播 / 新季
    const schedOut = (r) => ({
        title: r.title, cat: r.cat, remarks: r.cat === 'variety' || !r.ep ? '' : r.ep2 > r.ep ? `第${r.ep}-${r.ep2}集` : `第${r.ep}集`,
        ep: r.ep2 || r.ep, pic: r.pic, year: r.year, area: r.area, t: 0, n: 0, isNew: false, plan: 'tmdb', tag: r.tag || '', _s: r.score,
    });
    // 预计的跟排期混排:同一档(华语 / 日韩 / 欧美)里算中等热度(几个站在更新 × 10)
    const guessOut = (r) => ({ title: r.title, cat: r.cat, remarks: '', ep: 0, pic: r.pic, year: r.year, area: r.area, t: 0, n: 0, isNew: false, plan: 'guess', tag: '',
        _s: tierOfArea(r.area) * 1e5 + 10 * (r.n || 1) });
    // 按规律预计:前一周、前两周的同一天(当地)资源站都更新过(日更 / 周更都对得上),最近一次的备注没写「全 N 集 / 完结」
    function guesses(db, z, day, today) {
        if (day < today || day > addDays(today, opts.guessDays)) return [];
        const [a1, b1] = dayRange(z, addDays(day, -7)), [a2, b2] = dayRange(z, addDays(day, -14));
        return db.prepare(`SELECT a.nk, a.title, a.cat, a.pic, a.year, a.area, max(a.n) AS n,
                (SELECT x.remarks FROM cal_items x WHERE x.nk = a.nk ORDER BY x.t DESC LIMIT 1) AS last_rm
            FROM cal_items a
            WHERE a.t >= ? AND a.t < ? AND a.cat IN ('tv', 'anime', 'variety')
                AND EXISTS (SELECT 1 FROM cal_items b WHERE b.nk = a.nk AND b.t >= ? AND b.t < ?)
            GROUP BY a.nk ORDER BY n DESC`).all(a1, b1, a2, b2)
            .filter((r) => !DONE_RE.test(r.last_rm || ''));
    }
    // 当地这天还没更新、但排着要播的(TMDB 排期和预计的一起按档位 + 热度排;同一部两边都有算 TMDB 的;资源站这天已经有的不重复)
    function planned(db, z, day, today) {
        if (day < today) return [];
        const [a, b] = dayRange(z, day);
        const sch = new Map();
        for (const r of db.prepare('SELECT * FROM cal_sched WHERE t >= ? AND t < ? ORDER BY score DESC, t').all(a, b)) {
            const c = sch.get(r.nk);   // 同一部两天的集落进当地同一天 → 合成「第 x-y 集」
            if (!c) sch.set(r.nk, Object.assign({}, r));
            else if (c.tmdb === r.tmdb) { c.ep = Math.min(c.ep || r.ep, r.ep || c.ep); c.ep2 = Math.max(c.ep2, r.ep2); c.tag = c.tag || r.tag; }
        }
        const out = new Map();
        for (const [nk, r] of sch) out.set(nk, schedOut(r));
        for (const r of guesses(db, z, day, today)) if (!out.has(r.nk)) out.set(r.nk, guessOut(r));
        if (out.size) for (const r of db.prepare('SELECT DISTINCT nk FROM cal_items WHERE t >= ? AND t < ?').all(a, b)) out.delete(r.nk);
        return [...out.values()].sort((x, y) => y._s - x._s).map((x) => { const { _s, ...it } = x; return it; });
    }
    const dayOk = (day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) && !isNaN(Date.parse(day + 'T00:00:00Z'));
    // 一周:每天各分类多少部 + 选中那天每类前 limit 部(tz = 看的人的时区)
    function week(day, limit, tz, tzo) {
        const db = dbOk();
        if (!db) return null;
        const z = tzOf(tz, tzo, now());
        const today = dayIn(z, now());
        const d = dayOk(day) ? String(day) : today;
        const lim = Math.max(0, Math.min(60, Number(limit) || 12));
        return cached(`w|${z}|${d}|${lim}`, () => {
            const mon = mondayOf(d);
            const days = [];
            const cnt = db.prepare('SELECT cat, count(DISTINCT nk) AS c FROM cal_items WHERE t >= ? AND t < ? GROUP BY cat');
            let plan = [];
            // total / counts = 已更新 + 待播;real = 只算资源站真更新了的(前端「今天太少先看昨天」按它)
            for (let i = 0; i < 7; i++) {
                const dd = addDays(mon, i);
                const counts = {};
                let total = 0;
                for (const r of cnt.all(...dayRange(z, dd))) { counts[r.cat] = r.c; if (r.cat !== 'short') total += r.c; }
                const real = total;
                const p = planned(db, z, dd, today);
                if (dd === d) plan = p;
                for (const it of p) { counts[it.cat] = (counts[it.cat] || 0) + 1; if (it.cat !== 'short') total++; }
                days.push({ day: dd, dow: i, total, real, plan: p.length, counts, future: dd > today });
            }
            const cats = {};
            const got = lim ? actual(db, z, d) : [];
            for (const c of CATS) {
                const n = (days.find((x) => x.day === d) || { counts: {} }).counts[c] || 0;
                const items = got.filter((r) => r.cat === c).slice(0, lim).map(itemOut);
                for (const it of plan) { if (items.length >= lim) break; if (it.cat === c) items.push(it); }
                cats[c] = { n, items };
            }
            // oldest = 最早有数据的那天(刚部署时只有两三天),「上一周」按它停,不会翻到一整周空白;last = 排期排到哪天(「下一周」按它停)
            const keep = addDays(today, -opts.keepDays + 1), ft = (db.prepare('SELECT min(t) AS t FROM cal_items').get() || {}).t;
            const first = ft ? dayIn(z, ft) : '';
            const st = (db.prepare('SELECT max(t) AS t FROM cal_sched').get() || {}).t;
            const sm = st ? dayIn(z, st) : '';
            return { today, tz: z, day: d, monday: mon, prev: addDays(mon, -7), next: addDays(mon, 7), days, cats, oldest: first && first > keep ? first : keep,
                last: sm && sm > today ? sm : today };
        });
    }
    function list(day, cat, offset, limit, tz, tzo) {
        const db = dbOk();
        if (!db) return null;
        if (!dayOk(day) || CATS.indexOf(cat) < 0) return { items: [], total: 0 };
        const z = tzOf(tz, tzo, now());
        const off = Math.max(0, Number(offset) || 0), lim = Math.max(1, Math.min(60, Number(limit) || 30));
        return cached(`l|${z}|${day}|${cat}|${off}|${lim}`, () => {
            const got = actual(db, z, day, cat);
            const items = got.slice(off, off + lim).map(itemOut);
            // 已更新的排完接着排待播的
            const plan = planned(db, z, day, dayIn(z, now())).filter((x) => x.cat === cat);
            const from = Math.max(0, off - got.length);
            items.push(...plan.slice(from, from + lim - items.length));
            return { items, total: got.length + plan.length, offset: off };
        });
    }
    function status() {
        const db = dbOk();
        if (!db) return { enabled: false };
        return { enabled: true, running, sites: db.prepare('SELECT site, last_ok, last_err, items FROM cal_state').all() };
    }
    function start() {
        if (timer || stopped) return;
        first = setTimeout(() => tick(), opts.firstDelayMs); if (first.unref) first.unref();
        timer = setInterval(() => tick(), opts.tickMs); if (timer.unref) timer.unref();
    }
    function stop() { stopped = true; clearInterval(timer); clearTimeout(first); }
    return { start, stop, tick, week, list, status, _catOf: catOf, _epOf: epOf, _mondayOf: mondayOf, _dayRange: dayRange, _dayIn: dayIn };
}

module.exports = { createCalendar, catOf, epOf, mondayOf, CATS };
