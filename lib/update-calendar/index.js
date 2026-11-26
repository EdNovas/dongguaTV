'use strict';
// 📅 全站追剧周表:每 30 分钟从几个大资源站拉「最近 N 小时更新」(?ac=detail&h=),按资源站自己的更新日期(vod_time,北京时间)
//   归到哪一天、按片名去重,分 电视剧 / 动漫 / 综艺 / 电影 / 纪录片 / 短剧 存进 cache.db;首页「追剧日历」读它。
//
// createCalendar({ db, sites, httpGet, log?, now?, opts? })
//   db       () → better-sqlite3 连接或 null(没 sqlite 就整块关掉)
//   sites    () → [{key, name, api}] 拿来当更新源的 maccms 站(server.js 按 CALENDAR_SITES / 默认挑 3 个)
//   httpGet  async (url, timeoutMs) → 响应体(对象或字符串)
// → { start(), stop(), tick(), week(day), list(day, cat, offset, limit), status() }
//
// 分类:优先看父分类(详情里的 type_id_1 → 分类表里的名字),再看子分类名;伦理 / 三级 / 写真 / 擦边 / 体育 / 预告 / 解说一律不收。
// 电影只收近两年的(老片重新上架会把「本周更新」刷满);同一部在几个站都更新了只算一条(n = 几个站),展示用集数最大的那条备注。
const DEF = Object.freeze({
    tickMs: 30 * 60e3, firstDelayMs: 2 * 60e3, maxPages: 30, firstMaxPages: 150, pageGapMs: 400, timeoutMs: 15000,
    classesTtlMs: 24 * 3600e3, keepDays: 63, firstHours: 72, maxHours: 72,
});
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
    const itemOut = (r, day) => ({
        title: r.title, cat: r.cat, remarks: r.remarks, ep: r.ep, pic: r.pic, year: r.year, area: r.area, t: r.t, n: r.n,
        isNew: r.first_day === day,
    });
    // 一周:每天各分类多少部 + 选中那天每类前 limit 部
    function week(day, limit) {
        const db = dbOk();
        if (!db) return null;
        const today = cnDay(now());
        const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : today;
        const lim = Math.max(0, Math.min(60, Number(limit) || 12));
        return cached(`w|${d}|${lim}`, () => {
            const mon = mondayOf(d);
            const days = [];
            const cnt = db.prepare('SELECT cat, count(*) AS c FROM cal_items WHERE day = ? GROUP BY cat');
            for (let i = 0; i < 7; i++) {
                const dd = addDays(mon, i);
                const counts = {};
                let total = 0;
                for (const r of cnt.all(dd)) { counts[r.cat] = r.c; if (r.cat !== 'short') total += r.c; }
                days.push({ day: dd, dow: i, total, counts, future: dd > today });
            }
            const cats = {};
            const q = db.prepare(`SELECT i.*, s.first_day FROM cal_items i LEFT JOIN cal_seen s ON s.nk = i.nk
                WHERE i.day = ? AND i.cat = ? ORDER BY i.n DESC, i.t DESC LIMIT ?`);
            for (const c of CATS) {
                const n = (days.find((x) => x.day === d) || { counts: {} }).counts[c] || 0;
                cats[c] = { n, items: lim ? q.all(d, c, lim).map((r) => itemOut(r, d)) : [] };
            }
            return { today, day: d, monday: mon, prev: addDays(mon, -7), next: addDays(mon, 7), days, cats, oldest: addDays(today, -opts.keepDays + 1) };
        });
    }
    function list(day, cat, offset, limit) {
        const db = dbOk();
        if (!db) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) || CATS.indexOf(cat) < 0) return { items: [], total: 0 };
        const off = Math.max(0, Number(offset) || 0), lim = Math.max(1, Math.min(60, Number(limit) || 30));
        return cached(`l|${day}|${cat}|${off}|${lim}`, () => {
            const total = db.prepare('SELECT count(*) AS c FROM cal_items WHERE day = ? AND cat = ?').get(day, cat).c;
            const items = db.prepare(`SELECT i.*, s.first_day FROM cal_items i LEFT JOIN cal_seen s ON s.nk = i.nk
                WHERE i.day = ? AND i.cat = ? ORDER BY i.n DESC, i.t DESC LIMIT ? OFFSET ?`).all(day, cat, lim, off).map((r) => itemOut(r, day));
            return { items, total, offset: off };
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
    return { start, stop, tick, week, list, status, _catOf: catOf, _epOf: epOf, _mondayOf: mondayOf };
}

module.exports = { createCalendar, catOf, epOf, mondayOf, CATS };
