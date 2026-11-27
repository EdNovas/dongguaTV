'use strict';
// 🗂️ 本地片名索引(片库):资源站把关键词搜索关了(?wd= 回「暂不支持搜索」),但列表 / 详情接口还开着
//   → 把它的片名表(vod_id + 片名)爬进本地 SQLite,搜索时本地查出 vod_id,再 ?ac=detail&ids= 拿详情。
//   这样这类站的线路也能出现在搜索结果里(实测 2026-11 主站 9 个这样的站:闪电/天涯/索尼/牛牛/快车/鸭鸭/OK/纯净/无尽无水印)。
//
// createTitleIndex({ dbFile, sites, prepare?, httpGet, enabled?, log?, now?, opts? })
//   sites    () → [{key, name, api, search?}]  只给 maccms 站(番剧规则站不要传);search:false 强制走索引,search:true 强制不走
//   prepare  async () → bool   每轮开始前调一次(配了 REMOTE_DB_URL 时先把远程站点表拉到);返回 false = 本轮跳过
//   httpGet  async (url, timeoutMs) → 响应体(字符串或已解析对象)。只直连,不走 CORS 代理(全量爬几万页不能烧 Worker 额度)
// → { start(), stop(), tick(), useFor(site), lookup(siteKey, kw, limit) → Promise<vod_id[]>, status(), action(name, siteKey) }
//
// 规则:
//   · 探测:每站每 24h 用 ?ac=list&wd=爱 试一次。回 JSON 列表 = 搜索正常(ok,不建索引);回文字且像「暂不支持搜索」= nosearch;
//     其他(403 / 网页 / 超时)= unknown,2h 后再探,不建索引(可能只是限海外 IP)。后台可手动「强制走索引 / 不走索引」。
//   · 全量:?ac=list&pg=1→N 正着翻(翻的时候有新片插到第 1 页,旧片只会往后挤 → 重复不会漏);断点存 full_pg,重启从 pg−1 续。
//   · 增量:全量完成后每 6h 用 ?ac=list&h=<距上次+3 小时> 翻完;每 30 天重新全量一遍(只更新不删,删掉的片详情取不到自然不出)。
//   · 礼貌:同一站两页间隔 ≥700ms,每轮(60s)最多 3 个站、每站 ≤60 页;失败退避 5 分钟 / 30 分钟 / 2 小时。
//   · 查询:better-sqlite3 是同步的,1.1M 行子串扫描 ~90ms 会卡住主线程 → 放到 worker 线程(只读连接,WAL 下与写互不阻塞),
//     外加 1 小时 LRU;worker 起不来就退回主线程同步查。
const path = require('path');

const NOSEARCH_RE = /暂不支持搜索|不支持搜索|禁止搜索|搜索(?:已)?关闭|关闭了?搜索|not\s*(?:search|serarch|serach|seach)/i;
const DEF = Object.freeze({
    tickMs: 60e3, firstDelayMs: 90e3, pageGapMs: 700, pagesPerTick: 60, sitesPerTick: 3, probesPerTick: 12,
    probeTtlMs: 24 * 3600e3, probeRetryMs: 2 * 3600e3, incEveryMs: 6 * 3600e3, refreshAfterMs: 30 * 24 * 3600e3,
    goneDeleteMs: 7 * 24 * 3600e3, backoffMs: [5 * 60e3, 30 * 60e3, 2 * 3600e3], timeoutMs: 15000,
    lookupLimit: 20, lookupCacheMax: 500, lookupCacheMs: 3600e3, probeWord: '爱', maxIncHours: 24 * 20,
});

// 片名归一化:全半角统一、小写、去空白和标点符号。查询词同样归一化后做子串匹配
function norm(s) {
    return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 200);
}
function parseBody(body) {
    if (body && typeof body === 'object') return body;
    const s = String(body == null ? '' : body).replace(/^﻿/, '').trim();
    if (s[0] === '{') { try { return JSON.parse(s); } catch (e) { /* 当文字 */ } }
    return s;
}
const isList = (d) => !!d && typeof d === 'object' && Array.isArray(d.list);
const apiUrl = (api, q) => api + (api.indexOf('?') >= 0 ? '&' : '?') + q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ti_titles (
    site   TEXT NOT NULL,
    vod_id TEXT NOT NULL,
    name   TEXT NOT NULL,
    norm   TEXT NOT NULL,
    tname  TEXT NOT NULL DEFAULT '',
    t      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site, vod_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ti_state (
    site        TEXT PRIMARY KEY,
    api         TEXT NOT NULL DEFAULT '',
    mode        TEXT NOT NULL DEFAULT 'unknown',
    override    TEXT NOT NULL DEFAULT 'auto',
    probed_at   INTEGER NOT NULL DEFAULT 0,
    probe_note  TEXT NOT NULL DEFAULT '',
    full_pg     INTEGER NOT NULL DEFAULT 0,
    pagecount   INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    full_start  INTEGER NOT NULL DEFAULT 0,
    full_done   INTEGER NOT NULL DEFAULT 0,
    inc_at      INTEGER NOT NULL DEFAULT 0,
    inc_pg      INTEGER NOT NULL DEFAULT 0,
    inc_h       INTEGER NOT NULL DEFAULT 0,
    inc_start   INTEGER NOT NULL DEFAULT 0,
    fails       INTEGER NOT NULL DEFAULT 0,
    next_at     INTEGER NOT NULL DEFAULT 0,
    last_err    TEXT NOT NULL DEFAULT '',
    gone_at     INTEGER NOT NULL DEFAULT 0,
    paused      INTEGER NOT NULL DEFAULT 0
);`;

function createTitleIndex(o) {
    const opts = Object.assign({}, DEF, (o && o.opts) || {});
    const log = (o && o.log) || (() => { });
    const now = (o && o.now) || Date.now;
    const enabled = (o && o.enabled) || (() => true);
    const sitesFn = o.sites;
    const prepare = o.prepare || (async () => true);
    const httpGet = o.httpGet;
    const dbFile = o.dbFile;

    let db = null, timer = null, running = false, stopped = false, firstTimer = null;
    let stmts = null, rowCounts = new Map(), worker = null, workerBad = false, reqSeq = 0;
    const pending = new Map();
    const cache = new Map();   // `${site}\u0001${norm}` → {ids, at}

    function open() {
        if (db) return db;
        const Database = require('better-sqlite3');
        db = new Database(dbFile);
        try { db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); db.pragma('wal_autocheckpoint = 1000'); } catch (e) { /* 只是优化 */ }
        db.exec(SCHEMA);
        stmts = {
            state: db.prepare('SELECT * FROM ti_state WHERE site = ?'),
            allState: db.prepare('SELECT * FROM ti_state'),
            ins: db.prepare('INSERT INTO ti_state (site, api) VALUES (?, ?) ON CONFLICT(site) DO NOTHING'),
            upsert: db.prepare(`INSERT INTO ti_titles (site, vod_id, name, norm, tname, t) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(site, vod_id) DO UPDATE SET name = excluded.name, norm = excluded.norm, tname = excluded.tname, t = excluded.t`),
            count: db.prepare('SELECT count(*) AS n FROM ti_titles WHERE site = ?'),
            delSite: db.prepare('DELETE FROM ti_titles WHERE site = ?'),
            delState: db.prepare('DELETE FROM ti_state WHERE site = ?'),
            look: db.prepare(`SELECT vod_id FROM ti_titles WHERE site = ? AND instr(norm, ?) > 0
                ORDER BY (norm = ?) DESC, (instr(norm, ?) = 1) DESC, length(norm), t DESC LIMIT ?`),
            sample: db.prepare(`SELECT vod_id, name, tname, t FROM ti_titles WHERE site = ? AND instr(norm, ?) > 0
                ORDER BY (norm = ?) DESC, (instr(norm, ?) = 1) DESC, length(norm), t DESC LIMIT ?`),
        };
        for (const r of stmts.allState.all()) rowCounts.set(r.site, stmts.count.get(r.site).n);
        return db;
    }
    function setState(site, fields) {
        const keys = Object.keys(fields);
        if (!keys.length) return;
        db.prepare(`UPDATE ti_state SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE site = ?`).run(...keys.map((k) => fields[k]), site);
    }

    // ---------- 哪些站走索引 ----------
    function effMode(st, site) {
        if (site && site.search === false) return 'nosearch';
        if (site && site.search === true) return 'ok';
        if (!st) return 'unknown';
        if (st.override === 'index') return 'nosearch';
        if (st.override === 'off') return 'ok';
        return st.mode;
    }
    function useFor(site) {
        if (!db || !site || !enabled()) return false;
        let st;
        try { st = stmts.state.get(site.key); } catch (e) { return false; }
        if (!st || st.api !== site.api || st.paused) return false;
        return effMode(st, site) === 'nosearch' && (rowCounts.get(site.key) || 0) > 0;
    }

    // ---------- 查询(worker 线程) ----------
    function startWorker() {
        if (worker || workerBad) return worker;
        try {
            const { Worker } = require('worker_threads');
            worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { dbFile } });
            worker.unref();
            worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.ids || []); });
            const fail = (e) => {
                log('查询线程退出,改主线程同步查:', e && e.message ? e.message : e);
                workerBad = true; worker = null;
                for (const [, p] of pending) p.reject(new Error('worker gone'));
                pending.clear();
            };
            worker.on('error', fail);
            worker.on('exit', (code) => { if (!stopped && code !== 0) fail(new Error('exit ' + code)); });
        } catch (e) { workerBad = true; worker = null; log('查询线程起不来,用主线程同步查:', e.message); }
        return worker;
    }
    function lookupSync(siteKey, k, limit) {
        return stmts.look.all(siteKey, k, k, k, limit).map((r) => r.vod_id);
    }
    async function lookup(siteKey, kw, limit) {
        const k = norm(kw);
        const lim = Math.max(1, Math.min(50, limit || opts.lookupLimit));
        if (!k || !db) return [];
        const ck = siteKey + '\u0001' + k + '\u0001' + lim;
        const hit = cache.get(ck);
        if (hit && now() - hit.at < opts.lookupCacheMs) return hit.ids;
        let ids;
        const w = startWorker();
        if (w) {
            try {
                ids = await new Promise((resolve, reject) => {
                    const id = ++reqSeq;
                    pending.set(id, { resolve, reject });
                    w.postMessage({ id, site: siteKey, k, limit: lim });
                    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('lookup timeout')); } }, 5000);
                });
            } catch (e) { ids = lookupSync(siteKey, k, lim); }
        } else ids = lookupSync(siteKey, k, lim);
        if (cache.size >= opts.lookupCacheMax) cache.delete(cache.keys().next().value);
        cache.set(ck, { ids, at: now() });
        return ids;
    }

    // ---------- 网络 ----------
    async function getJson(url) {
        const body = await httpGet(url, opts.timeoutMs);
        return parseBody(body);
    }
    function failed(site, st, err) {
        const fails = (st.fails || 0) + 1;
        const wait = opts.backoffMs[Math.min(fails - 1, opts.backoffMs.length - 1)];
        setState(site.key, { fails, next_at: now() + wait, last_err: String(err && err.message || err).slice(0, 200) });
    }

    // ---------- 探测 ----------
    async function probe(site) {
        let mode = 'unknown', note = '';
        try {
            const d = await getJson(apiUrl(site.api, 'ac=list&wd=' + encodeURIComponent(opts.probeWord)));
            const msg = d && typeof d === 'object' ? String(d.msg || d.message || d.error || '') : '';
            if (isList(d)) { mode = 'ok'; note = 'search ok'; }
            else if (typeof d === 'string' && NOSEARCH_RE.test(d.slice(0, 300))) { mode = 'nosearch'; note = d.slice(0, 60); }
            // 茅台这类回 JSON:{"code":1002,"msg":"Current API forbids keyword search."}
            else if (msg && (NOSEARCH_RE.test(msg) || /forbids?\s+(?:keyword\s+)?search|search\s+(?:is\s+)?(?:disabled|forbidden|not\s+(?:allowed|supported))/i.test(msg))) { mode = 'nosearch'; note = msg.slice(0, 60); }
            else note = 'unexpected: ' + String(typeof d === 'string' ? d : JSON.stringify(d)).replace(/\s+/g, ' ').slice(0, 60);
        } catch (e) { note = 'error: ' + String(e && e.message || e).slice(0, 80); }
        const prev = stmts.state.get(site.key);
        // 一次失败(超时 / 403)不能把已确认的 nosearch 打回 unknown —— 那样它的线路就从搜索里消失了
        const keep = mode === 'unknown' && prev && (prev.mode === 'nosearch' || prev.mode === 'ok');
        setState(site.key, { mode: keep ? prev.mode : mode, probed_at: now() - (mode === 'unknown' ? opts.probeTtlMs - opts.probeRetryMs : 0), probe_note: note });
        if (mode === 'ok' && prev && prev.mode === 'nosearch' && prev.override === 'auto') {
            log(`${site.key} 搜索恢复了,清掉索引`);
            stmts.delSite.run(site.key); rowCounts.set(site.key, 0);
            setState(site.key, { full_pg: 0, full_done: 0, full_start: 0, inc_at: 0, inc_pg: 0 });
        }
        if (mode !== (prev && prev.mode)) log(`${site.key} 探测:${mode}(${note})`);
        return mode;
    }

    // ---------- 爬 ----------
    const putPage = (siteKey, list) => {
        let n = 0;
        db.transaction(() => {
            for (const v of list) {
                if (!v || v.vod_id == null || !v.vod_name) continue;
                const t = Date.parse(String(v.vod_time || '').replace(' ', 'T')) || 0;
                stmts.upsert.run(siteKey, String(v.vod_id), String(v.vod_name).slice(0, 200), norm(v.vod_name), String(v.type_name || '').slice(0, 40), t);
                n++;
            }
        })();
        return n;
    };
    async function crawl(site) {
        let st = stmts.state.get(site.key);
        const t0 = now();
        // 该干哪种活
        let kind = null;
        if (!st.full_done) kind = 'full';
        else if (t0 - st.full_done > opts.refreshAfterMs) {
            setState(site.key, { full_done: 0, full_pg: 1, full_start: t0 });
            st = stmts.state.get(site.key); kind = 'full';
        } else if (st.inc_pg > 0 || t0 - st.inc_at > opts.incEveryMs) kind = 'inc';
        if (!kind) return;
        if (kind === 'full' && !st.full_start) setState(site.key, { full_start: t0, full_pg: Math.max(1, st.full_pg || 1) });
        if (kind === 'inc' && !st.inc_pg) {
            const base = st.inc_at || st.full_start || st.full_done;
            const h = Math.ceil((t0 - base) / 3600e3) + 3;
            if (h > opts.maxIncHours) {   // 停太久了,增量窗口不够 → 重新全量
                setState(site.key, { full_done: 0, full_pg: 1, full_start: t0, inc_pg: 0 });
                return;
            }
            setState(site.key, { inc_pg: 1, inc_h: h, inc_start: t0 });
        }
        st = stmts.state.get(site.key);
        let pg = kind === 'full' ? Math.max(1, st.full_pg - 1) : st.inc_pg;   // 全量断点从 pg−1 续(新片把旧片往后挤一位)
        for (let i = 0; i < opts.pagesPerTick && !stopped; i++) {
            const q = kind === 'full' ? `ac=list&pg=${pg}` : `ac=list&h=${st.inc_h}&pg=${pg}`;
            let d;
            try { d = await getJson(apiUrl(site.api, q)); }
            catch (e) { failed(site, stmts.state.get(site.key), e); return; }
            if (!isList(d)) { failed(site, stmts.state.get(site.key), new Error('不是 maccms 列表: ' + String(d).slice(0, 40))); return; }
            const n = putPage(site.key, d.list);
            const pc = Number(d.pagecount) || 0;
            const last = !d.list.length || (pc && pg >= pc);
            if (kind === 'full') {
                setState(site.key, { full_pg: pg + 1, pagecount: pc, total: Number(d.total) || 0, fails: 0, last_err: '' });
                if (last) {
                    setState(site.key, { full_done: now(), inc_at: stmts.state.get(site.key).full_start, inc_pg: 0 });
                    log(`${site.key} 全量完成:${stmts.count.get(site.key).n} 条`);
                    break;
                }
            } else {
                setState(site.key, { inc_pg: pg + 1, fails: 0, last_err: '' });
                if (last) { setState(site.key, { inc_at: stmts.state.get(site.key).inc_start, inc_pg: 0 }); break; }
            }
            if (n) rowCounts.set(site.key, (rowCounts.get(site.key) || 0) + n);   // 粗估,一轮结束再精算
            pg++;
            await sleep(opts.pageGapMs);
        }
        rowCounts.set(site.key, stmts.count.get(site.key).n);
        if (rowCounts.get(site.key) > 0) cache.clear();   // 新片进来了,旧的"没找到"缓存作废
    }

    // 这个站现在有没有要爬的(和 crawl() 开头选活的条件一致)
    function hasWork(st, t) {
        if (!st.full_done) return true;
        if (t - st.full_done > opts.refreshAfterMs) return true;
        return st.inc_pg > 0 || t - st.inc_at > opts.incEveryMs;
    }

    // ---------- 一轮 ----------
    async function tick() {
        if (running || stopped || !enabled()) return;
        running = true;
        try {
            open();
            if (!(await prepare())) return;
            const sites = (sitesFn() || []).filter((s) => s && s.key && /^https?:\/\//i.test(String(s.api || '')));
            const t = now();
            const byKey = new Map(sites.map((s) => [s.key, s]));
            // 同步站点表:新站建行;API 地址变了 = 换了片库,清空重来;站从配置里消失 7 天才删(远程配置拉失败时别误删)
            for (const s of sites) {
                stmts.ins.run(s.key, s.api);
                const st = stmts.state.get(s.key);
                if (st.api !== s.api) {
                    stmts.delSite.run(s.key); rowCounts.set(s.key, 0);
                    setState(s.key, { api: s.api, mode: 'unknown', probed_at: 0, full_pg: 0, full_done: 0, full_start: 0, inc_at: 0, inc_pg: 0, fails: 0, next_at: 0, last_err: '', gone_at: 0 });
                } else if (st.gone_at) setState(s.key, { gone_at: 0 });
            }
            for (const st of stmts.allState.all()) {
                if (byKey.has(st.site)) continue;
                if (!st.gone_at) setState(st.site, { gone_at: t });
                else if (t - st.gone_at > opts.goneDeleteMs) { stmts.delSite.run(st.site); stmts.delState.run(st.site); rowCounts.delete(st.site); }
            }
            // 探测(每轮最多 probesPerTick 个,4 个并发;每个最多等 timeoutMs)
            const toProbe = sites.filter((s) => s.search === undefined && t - (stmts.state.get(s.key).probed_at || 0) > opts.probeTtlMs).slice(0, opts.probesPerTick);
            for (let i = 0; i < toProbe.length && !stopped; i += 4) await Promise.all(toProbe.slice(i, i + 4).map((s) => probe(s)));
            if (stopped) return;
            // 爬
            const work = sites.filter((s) => {
                const st = stmts.state.get(s.key);
                return st && !st.paused && effMode(st, s) === 'nosearch' && (st.next_at || 0) <= t && hasWork(st, t);
            }).slice(0, opts.sitesPerTick);   // 只数真有活干的站:否则排在前面、已经爬完的站一直占着名额,后面的站永远轮不到
            await Promise.all(work.map((s) => crawl(s).catch((e) => log(`${s.key} 爬取出错:`, e.message))));
        } catch (e) {
            log('本轮出错:', e && e.message ? e.message : e);
        } finally { running = false; }
    }

    // ---------- 后台页 ----------
    function status() {
        open();
        const sites = new Map(((sitesFn && sitesFn()) || []).map((s) => [s.key, s]));
        const list = stmts.allState.all().map((st) => {
            const s = sites.get(st.site);
            const rows = rowCounts.has(st.site) ? rowCounts.get(st.site) : stmts.count.get(st.site).n;
            const mode = effMode(st, s);
            return {
                key: st.site, name: s ? s.name : st.site, api: st.api, configured: !!s, forced: s && s.search !== undefined ? (s.search === false ? 'index' : 'off') : '',
                mode, auto_mode: st.mode, override: st.override, paused: !!st.paused, probed_at: st.probed_at, probe_note: st.probe_note,
                rows, total: st.total, pagecount: st.pagecount, full_pg: st.full_pg, full_start: st.full_start, full_done: st.full_done,
                inc_at: st.inc_at, inc_pg: st.inc_pg, fails: st.fails, next_at: st.next_at, last_err: st.last_err, gone_at: st.gone_at,
                active: mode === 'nosearch' && !st.paused && rows > 0,
            };
        });
        list.sort((a, b) => (b.mode === 'nosearch') - (a.mode === 'nosearch') || b.rows - a.rows || a.key.localeCompare(b.key));
        return { enabled: !!enabled(), running, now: now(), sites: list, worker: worker ? 'thread' : (workerBad ? 'sync' : 'idle') };
    }
    // 试搜:后台页输入片名看能查到什么(只查本地,不请求资源站)
    function sample(siteKey, kw, limit) {
        open();
        const k = norm(kw);
        if (!k) return [];
        return stmts.sample.all(siteKey, k, k, k, Math.max(1, Math.min(50, limit || 20)));
    }
    async function action(name, siteKey) {
        open();
        const st = siteKey ? stmts.state.get(siteKey) : null;
        if (siteKey && !st) throw new Error('没有这个站');
        const keys = siteKey ? [siteKey] : stmts.allState.all().map((r) => r.site);
        switch (name) {
            case 'probe': for (const k of keys) setState(k, { probed_at: 0 }); break;
            case 'rebuild': for (const k of keys) { setState(k, { full_pg: 1, full_done: 0, full_start: now(), inc_pg: 0, fails: 0, next_at: 0, last_err: '' }); } break;
            case 'clear': for (const k of keys) { stmts.delSite.run(k); rowCounts.set(k, 0); setState(k, { full_pg: 0, full_done: 0, full_start: 0, inc_at: 0, inc_pg: 0, fails: 0, next_at: 0, last_err: '' }); } break;
            case 'pause': for (const k of keys) setState(k, { paused: 1 }); break;
            case 'resume': for (const k of keys) setState(k, { paused: 0, next_at: 0, fails: 0 }); break;
            case 'force-index': for (const k of keys) setState(k, { override: 'index', next_at: 0 }); break;
            case 'force-off': for (const k of keys) setState(k, { override: 'off' }); break;
            case 'auto': for (const k of keys) setState(k, { override: 'auto' }); break;
            case 'retry': for (const k of keys) setState(k, { next_at: 0, fails: 0 }); break;
            default: throw new Error('未知操作');
        }
        cache.clear();
        setTimeout(() => tick(), 50);   // 立刻跑一轮(不等它)
        return status();
    }

    function start() {
        if (timer || stopped) return;
        firstTimer = setTimeout(() => { tick(); }, opts.firstDelayMs);
        if (firstTimer.unref) firstTimer.unref();
        timer = setInterval(() => { tick(); }, opts.tickMs);
        if (timer.unref) timer.unref();
    }
    function stop() {
        stopped = true;
        clearInterval(timer); clearTimeout(firstTimer); timer = null;
        if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
        if (db) { try { db.close(); } catch (e) { /* ignore */ } db = null; }
    }

    try { open(); } catch (e) { log('打不开索引库:', e.message); throw e; }
    return { start, stop, tick, useFor, lookup, status, action, sample, _norm: norm, _db: () => db };
}

module.exports = { createTitleIndex, norm, NOSEARCH_RE };
