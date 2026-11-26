'use strict';
// 📚 片单(像豆瓣豆列):用户自己建的片子清单 —— 起名 + 一句话简介,往里加 / 删片子,可以设成公开拿分享链接 /?list=<id>。
//   server.js 用;Vercel 无 SQLite → 不挂(/api/config 不报 playlists_enabled,前端只存本机)。
//
// 为什么这样做:
//   · 只存"打开它要的东西":片名(站内搜索用的名字)、海报、年份、类型、可选 TMDB id / 原名 / 同名多部的作品签名。
//     打开 = 按片名搜索(和首页卡片一样),不存线路 / 集数(那些会变,收藏才管更新)。
//   · 上限:每人 50 个片单、每个 500 部、全部加起来 3000 部 —— 列表接口一次全给(首页拼封面、加片单弹窗要知道哪个单里已经有了),
//     总量封顶才不会一个人把一次 GET 撑到几 MB;所有字段都截长、类型 / 年份 / id 只认白名单格式。
//   · 片单 id = 12 位随机 base64url(72 bit),公开链接不可猜;设回私密后链接立刻失效,再公开还是同一个 id。
//     公开接口只给片单名 / 简介 / 片子,绝不给 user_token;不公开的和不存在的回同一个 not_found(不让人探测 id)。
//     配了访问密码(私密站)时看公开片单也要有效令牌(和大家都在看一样:不然互联网上谁都能读)。
//   · 同一部重复加 = 更新那条的海报 / 年份等,不重复、不挪位置。条目键 = 片名去空白小写(+ 作品签名),服务器自己算,不信前端给的。
//   · 写接口按令牌限速(每分钟 90 次,固定窗口,Map 有上限)+ server.js 注入的按 IP 限速;导入(登录时把本机片单并进账号)一次算一次。
//   · 用户输入当键的表一律 Map(PASSWORD_HASH_MAP 曾因原型键被绕过)。
// 所有入口都吞异常:片单坏了只是首页少一行,绝不能拖垮播放 / 首页。
const crypto = require('crypto');

const DEF = {
    maxLists: 50,            // 每人最多几个片单
    maxItems: 500,           // 每个片单最多几部
    maxTotal: 3000,          // 每人所有片单加起来最多几部
    nameMax: 40, descMax: 200,
    titleMax: 100, posterMax: 500, sigMax: 80,
    importMax: 50,           // 一次导入最多几个片单
    writePerMin: 90,         // 每个令牌每分钟最多写几次
    rateMapMax: 50000,
};
const ID_RE = /^[A-Za-z0-9_-]{12}$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/g;
const clean = (v, n) => String(v == null ? '' : v).replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const newId = () => crypto.randomBytes(9).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

// ---------- 纯函数(测试直接调) ----------
// 海报只认 http(s) 绝对地址或站内相对路径(/...;不认 //host 协议相对、data:、javascript:)
function cleanPoster(v) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s || s.length > DEF.posterMax || /[\s"'<>\\]/.test(s)) return '';
    if (/^https?:\/\/[^/]/i.test(s)) return s;
    if (/^\/(?!\/)/.test(s)) return s;
    return '';
}
// 条目键:片名去空白、小写(+ 同名多部的作品签名)。前端用同一规则算(_plKeyOf),对不上也没事 —— 服务器回包里带 k
function itemKey(title, sig) {
    const t = String(title || '').replace(/\s+/g, '').toLowerCase();
    return t ? t + (sig ? '|w:' + sig : '') : '';
}
// 前端给的条目 → 存的条目;不合格 → null
function normItem(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const t = clean(raw.t, DEF.titleMax);
    if (!t) return null;
    const out = { t };
    const p = cleanPoster(raw.p);
    if (p) out.p = p;
    const y = String(raw.y == null ? '' : raw.y).trim();
    if (/^(19|20)\d{2}$/.test(y)) out.y = y;
    if (typeof raw.ty === 'string' && /^[a-z]{1,12}$/.test(raw.ty)) out.ty = raw.ty;
    const tm = Number(raw.tm);
    if (Number.isInteger(tm) && tm > 0 && tm < 1e9) out.tm = tm;
    const ot = clean(raw.ot, DEF.titleMax);
    if (ot && ot !== t) out.ot = ot;
    const w = clean(raw.w, DEF.sigMax);
    if (w) out.w = w;
    out.k = itemKey(t, out.w);
    return out;
}
const normName = (v) => clean(v, DEF.nameMax);
const normDesc = (v) => clean(v, DEF.descMax);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_playlists (
    id TEXT PRIMARY KEY, user_token TEXT NOT NULL, name TEXT NOT NULL, descr TEXT NOT NULL DEFAULT '',
    pub INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upl_user ON user_playlists(user_token);
CREATE TABLE IF NOT EXISTS user_playlist_items (
    list_id TEXT NOT NULL, k TEXT NOT NULL, data TEXT NOT NULL, added_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, k)
);
`;

function createPlaylists(deps) {
    deps = deps || {};
    const C = Object.assign({}, DEF, deps.opts || {});
    const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;
    const dbOf = () => { try { return deps.db ? (deps.db() || null) : null; } catch (e) { return null; } };
    const enabled = () => { try { return !!dbOf() && (deps.enabled ? !!deps.enabled() : true); } catch (e) { return false; } };
    const tokenOk = (t) => { try { return typeof t === 'string' && !!t && !!(deps.tokenOk && deps.tokenOk(t)); } catch (e) { return false; } };
    const isBanned = (t) => { try { return !!(deps.isBanned && deps.isBanned(t)); } catch (e) { return false; } };
    // 配了访问密码(私密站)→ 看公开片单也要有效令牌;依赖缺省 = 私密(保守)
    const authRequired = () => { try { return deps.authRequired ? !!deps.authRequired() : true; } catch (e) { return true; } };

    const warnAt = {};
    const warn = (tag, e) => { const t = Date.now(); if (!warnAt[tag] || t - warnAt[tag] > 60e3) { warnAt[tag] = t; console.warn('[Playlists] ' + tag + ':', e && e.message || e); } };

    const inited = new WeakSet();
    let stmtDb = null;
    const stmts = new Map();
    const q = (d, sql) => {
        if (d !== stmtDb) { stmts.clear(); stmtDb = d; }
        let s = stmts.get(sql);
        if (!s) { s = d.prepare(sql); stmts.set(sql, s); }
        return s;
    };
    function getDb() {
        const d = dbOf();
        if (d && !inited.has(d)) { d.exec(SCHEMA); inited.add(d); }
        return d;
    }
    setImmediate(() => { try { if (enabled()) getDb(); } catch (e) { warn('schema', e); } });

    // 每个令牌每分钟写几次(固定窗口)
    const rate = new Map();
    function rateOk(token) {
        const now = nowFn();
        let e = rate.get(token);
        if (!e || now - e.start >= 60e3) {
            if (!e && rate.size >= C.rateMapMax) rate.clear();
            e = { start: now, n: 0 };
            rate.set(token, e);
        }
        return ++e.n <= C.writePerMin;
    }

    const parse = (s) => { try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } };
    function itemsOf(d, id) {
        return q(d, 'SELECT k, data, added_at FROM user_playlist_items WHERE list_id = ? ORDER BY added_at DESC, rowid DESC').all(id)
            .map(r => { const o = parse(r.data); return o ? Object.assign(o, { k: r.k, a: r.added_at }) : null; })
            .filter(Boolean);
    }
    function view(d, row, withItems) {
        const items = itemsOf(d, row.id);
        const v = { id: row.id, name: row.name, desc: row.descr || '', pub: !!row.pub, created_at: row.created_at, updated_at: row.updated_at, count: items.length };
        if (withItems !== false) v.items = items;
        return v;
    }
    const ownRow = (d, token, id) => (typeof id === 'string' && ID_RE.test(id))
        ? q(d, 'SELECT * FROM user_playlists WHERE id = ? AND user_token = ?').get(id, token) || null : null;
    const listCount = (d, token) => q(d, 'SELECT COUNT(*) n FROM user_playlists WHERE user_token = ?').get(token).n;
    const totalCount = (d, token) => q(d, `SELECT COUNT(*) n FROM user_playlist_items i JOIN user_playlists p ON p.id = i.list_id WHERE p.user_token = ?`).get(token).n;
    const itemCount = (d, id) => q(d, 'SELECT COUNT(*) n FROM user_playlist_items WHERE list_id = ?').get(id).n;
    const limits = () => ({ lists: C.maxLists, items: C.maxItems, total: C.maxTotal });
    const touch = (d, id, now) => q(d, 'UPDATE user_playlists SET updated_at = ? WHERE id = ?').run(now, id);
    // 往片单里写一条:已有 = 更新内容(不挪位置、不占名额);新的要过单个 / 总量上限。返回 'added' | 'updated' | 'limit' | 'total'
    function putItem(d, id, it, now, budget) {
        const has = q(d, 'SELECT data FROM user_playlist_items WHERE list_id = ? AND k = ?').get(id, it.k);
        const data = Object.assign({}, it);
        delete data.k;
        // 已有:这次给了的字段覆盖、没给的留着(从播放页加过一次有海报,再从别处加没海报也不丢)
        if (has) { q(d, 'UPDATE user_playlist_items SET data = ? WHERE list_id = ? AND k = ?').run(JSON.stringify(Object.assign(parse(has.data) || {}, data)), id, it.k); return 'updated'; }
        if (itemCount(d, id) >= C.maxItems) return 'limit';
        if (budget.used >= C.maxTotal) return 'total';
        q(d, 'INSERT INTO user_playlist_items (list_id, k, data, added_at) VALUES (?, ?, ?, ?)').run(id, it.k, JSON.stringify(data), now);
        budget.used++;
        return 'added';
    }

    // ---------- 操作(返回 { status, body }) ----------
    function list(token) {
        const d = getDb();
        const rows = q(d, 'SELECT * FROM user_playlists WHERE user_token = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(token, C.maxLists * 2);
        return { status: 200, body: { enabled: true, limits: limits(), lists: rows.map(r => view(d, r)) } };
    }
    function create(token, b) {
        const d = getDb();
        const name = normName(b.name);
        if (!name) return { status: 400, body: { ok: false, error: 'name' } };
        const now = nowFn();
        let out;
        d.transaction(() => {
            if (listCount(d, token) >= C.maxLists) { out = { status: 200, body: { ok: false, error: 'limit', limits: limits() } }; return; }
            let id = newId();
            while (q(d, 'SELECT 1 FROM user_playlists WHERE id = ?').get(id)) id = newId();
            q(d, 'INSERT INTO user_playlists (id, user_token, name, descr, pub, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(id, token, name, normDesc(b.desc), b.pub === true ? 1 : 0, now, now);
            // 建的时候顺手加第一部(「新建片单并加入」)
            const it = normItem(b.item);
            if (it) putItem(d, id, it, now, { used: totalCount(d, token) });
            out = { status: 200, body: { ok: true, list: view(d, q(d, 'SELECT * FROM user_playlists WHERE id = ?').get(id)) } };
        })();
        return out;
    }
    function update(token, b) {
        const d = getDb();
        const row = ownRow(d, token, b.id);
        if (!row) return { status: 404, body: { ok: false, error: 'not_found' } };
        const set = {};
        if (b.name !== undefined) { const n = normName(b.name); if (!n) return { status: 400, body: { ok: false, error: 'name' } }; set.name = n; }
        if (b.desc !== undefined) set.descr = normDesc(b.desc);
        if (b.pub !== undefined) set.pub = b.pub === true ? 1 : 0;
        const now = nowFn();
        q(d, 'UPDATE user_playlists SET name = ?, descr = ?, pub = ?, updated_at = ? WHERE id = ?')
            .run(set.name !== undefined ? set.name : row.name, set.descr !== undefined ? set.descr : row.descr,
                set.pub !== undefined ? set.pub : row.pub, now, row.id);
        return { status: 200, body: { ok: true, list: view(d, q(d, 'SELECT * FROM user_playlists WHERE id = ?').get(row.id), false) } };
    }
    function remove(token, b) {
        const d = getDb();
        const row = ownRow(d, token, b.id);
        if (!row) return { status: 200, body: { ok: true, removed: 0 } };   // 已经没了 = 删成功(另一台设备先删了)
        d.transaction(() => {
            q(d, 'DELETE FROM user_playlist_items WHERE list_id = ?').run(row.id);
            q(d, 'DELETE FROM user_playlists WHERE id = ?').run(row.id);
        })();
        return { status: 200, body: { ok: true, removed: 1 } };
    }
    function addItem(token, b) {
        const d = getDb();
        const it = normItem(b.item);
        if (!it) return { status: 400, body: { ok: false, error: 'item' } };
        const row = ownRow(d, token, b.id);
        if (!row) return { status: 404, body: { ok: false, error: 'not_found' } };
        const now = nowFn();
        let r;
        d.transaction(() => {
            r = putItem(d, row.id, it, now, { used: totalCount(d, token) });
            if (r === 'added' || r === 'updated') touch(d, row.id, now);
        })();
        if (r === 'limit' || r === 'total') return { status: 200, body: { ok: false, error: r, limits: limits() } };
        const data = Object.assign({}, it, { a: now });
        if (r === 'updated') { const x = q(d, 'SELECT added_at FROM user_playlist_items WHERE list_id = ? AND k = ?').get(row.id, it.k); if (x) data.a = x.added_at; }
        return { status: 200, body: { ok: true, k: it.k, item: data, added: r === 'added' } };
    }
    function removeItem(token, b) {
        const d = getDb();
        const row = ownRow(d, token, b.id);
        if (!row) return { status: 404, body: { ok: false, error: 'not_found' } };
        if (typeof b.k !== 'string' || !b.k || b.k.length > C.titleMax + C.sigMax + 8) return { status: 400, body: { ok: false, error: 'k' } };
        const n = q(d, 'DELETE FROM user_playlist_items WHERE list_id = ? AND k = ?').run(row.id, b.k).changes;
        if (n) touch(d, row.id, nowFn());
        return { status: 200, body: { ok: true, removed: n } };
    }
    // 登录后把本机片单并进账号:同名片单合并(已有的片子不重复),没有的新建;超上限的部分丢掉并在回包里报 skipped
    function importLists(token, b) {
        const d = getDb();
        const src = Array.isArray(b.lists) ? b.lists.slice(0, C.importMax) : null;
        if (!src) return { status: 400, body: { ok: false, error: 'lists' } };
        const now = nowFn();
        let skipped = 0, merged = 0, created = 0;
        d.transaction(() => {
            const budget = { used: totalCount(d, token) };
            let n = listCount(d, token);
            for (const x of src) {
                if (!x || typeof x !== 'object') continue;
                const name = normName(x.name);
                if (!name) continue;
                const items = (Array.isArray(x.items) ? x.items.slice(0, C.maxItems) : [])
                    .map(r => { const it = normItem(r); return it ? { it, a: Number(r.a) } : null; }).filter(Boolean);
                let row = q(d, 'SELECT * FROM user_playlists WHERE user_token = ? AND name = ? ORDER BY created_at LIMIT 1').get(token, name);
                if (!row) {
                    if (n >= C.maxLists) { skipped += items.length || 1; continue; }
                    let id = newId();
                    while (q(d, 'SELECT 1 FROM user_playlists WHERE id = ?').get(id)) id = newId();
                    const t0 = Number(x.created_at) > 0 && Number(x.created_at) <= now ? Math.floor(Number(x.created_at)) : now;
                    q(d, 'INSERT INTO user_playlists (id, user_token, name, descr, pub, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
                        .run(id, token, name, normDesc(x.desc), t0, now);
                    row = { id };
                    n++; created++;
                } else merged++;
                // 本机列表是新的在前:倒着插,加入时间沿用本机的(没有就按顺序排),合并后顺序不乱
                for (let i = items.length - 1; i >= 0; i--) {
                    const { it, a } = items[i];
                    const at = a > 0 && a <= now ? Math.floor(a) : now - i;
                    const r = putItem(d, row.id, it, at, budget);
                    if (r === 'limit' || r === 'total') skipped++;
                }
                touch(d, row.id, now);
            }
        })();
        const out = list(token).body;
        return { status: 200, body: Object.assign({ ok: true, created, merged, skipped }, out) };
    }
    // 公开片单(分享链接):只给公开的;自己的不公开片单也能看(mine:true,前端据此显示可编辑的那份)
    function publicView(id, token) {
        const d = getDb();
        if (typeof id !== 'string' || !ID_RE.test(id)) return { status: 404, body: { ok: false, error: 'not_found' } };
        const row = q(d, 'SELECT * FROM user_playlists WHERE id = ?').get(id);
        const mine = !!row && typeof token === 'string' && !!token && row.user_token === token;
        if (!row || (!row.pub && !mine) || (!mine && isBanned(row.user_token))) return { status: 404, body: { ok: false, error: 'not_found' } };
        return { status: 200, body: { ok: true, mine, list: view(d, row) } };
    }

    // ---------- 路由 ----------
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    function guard(res, token) {
        if (!tokenOk(token)) { res.status(401).json({ ok: false, error: 'Invalid token' }); return true; }
        if (isBanned(token)) { res.status(403).json({ ok: false, error: 'banned', banned: true }); return true; }
        return false;
    }
    const wrap = (fn) => (req, res) => {
        noStore(res);
        try { fn(req, res); }
        catch (e) { warn('route', e); if (!res.headersSent) res.status(500).json({ ok: false, error: 'Database error' }); }
    };
    function registerRoutes(app) {
        const wl = deps.writeLimiter ? [deps.writeLimiter] : [];
        const rl = deps.readLimiter ? [deps.readLimiter] : [];
        app.get('/api/playlists', wrap((req, res) => {
            if (!enabled()) return res.json({ enabled: false, limits: limits(), lists: [] });
            const token = String((req.query && req.query.token) || '');
            if (guard(res, token)) return;
            const r = list(token);
            res.status(r.status).json(r.body);
        }));
        const post = (path, fn) => app.post(path, ...wl, wrap((req, res) => {
            if (!enabled()) return res.json({ ok: false, enabled: false });
            const b = bodyOf(req);
            if (guard(res, b.token)) return;
            if (!rateOk(b.token)) return res.status(429).json({ ok: false, error: 'rate' });
            const r = fn(b.token, b);
            res.status(r.status).json(r.body);
        }));
        post('/api/playlists/create', create);
        post('/api/playlists/update', update);
        post('/api/playlists/delete', remove);
        post('/api/playlists/add', addItem);
        post('/api/playlists/remove', removeItem);
        post('/api/playlists/import', importLists);
        app.get('/api/playlists/public/:id', ...rl, wrap((req, res) => {
            if (!enabled()) return res.status(404).json({ ok: false, error: 'not_found', enabled: false });
            const token = String((req.query && req.query.token) || '');
            if (authRequired() && guard(res, token)) return;
            const r = publicView(String(req.params.id || ''), token);
            res.status(r.status).json(r.body);
        }));
    }

    return { registerRoutes, enabled, _ops: { list, create, update, remove, addItem, removeItem, importLists, publicView } };
}

module.exports = { createPlaylists, normItem, itemKey, cleanPoster, DEF };
