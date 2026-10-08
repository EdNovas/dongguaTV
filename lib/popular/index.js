'use strict';
// 🔥 大家都在看(server.js 用;Vercel 无统计 → api/index.js 返回空)。
//
// 为什么这样做:首页轮播是 TMDB 热门,不是"本站用户真在看的";这里按 watch_stats(lib/user-stats 的实测观看)汇总。
//   · 只给片名:除了调用者自己,至少还有 2 个不同用户看过才上榜;每人对这部剧累计不到 120 秒的不算(点开就走/随手上报一条不算"在看")。
//     为什么排除调用者:以前按"含调用者在内 ≥2 人",任何有效令牌给某片上报一条 120s,这部片上没上榜就等于告诉他
//     "另外有没有人看过它"(小站 = 指名道姓,审查实锤)。现在调用者自己的观看对他看到的榜单不起任何作用,
//     想探测就得另外凑齐 2 个"别人"。认不出调用者(公开站不带令牌)就当他也看过,即至少 3 人。
//     绝不返回人数/秒数/集数(以前返回过,seconds 差值能读出别人看了多久)。
//   · 只有 7 天窗口:1 天窗口人少,"谁今天看了什么"更容易对号入座;window 参数照收照忽略,回包固定 window:'7d'。
//   · 配了访问密码(私密站)→ 要有效令牌(?token=,401/封禁 403):不然互联网上任何人都能读这个站的观看榜;没配密码的公开站照旧公开。
//   · 被封禁用户不计入;全站共用一份候选缓存 10 分钟:人数/时长前 ~100 部,每部记"贡献者令牌 → 秒数"(只在内存,绝不出接口),
//     每个请求在这份缓存上扣掉调用者自己再筛 ≥2、排序、取前 20 —— 不为每个调用者重查库。
//     一部剧的贡献者超过 maxTrack 个就不逐个记(省内存):这种剧扣掉谁都还远超门槛,按"调用者也在里面"保守少算 1 人排序。
//   · 查询只扫 idx_ws_recent(kind, last_at, …)那一段;watch_stats 是 WITHOUT ROWID 表,二级索引自带主键列 user_token → 不回表。
const DAY = 86400e3;
const DEF = {
    cacheMs: 10 * 60e3,
    limit: 20,
    minUsers: 2,          // 调用者以外至少几个不同用户
    minUserSec: 120,
    windowDays: 7,
    candidates: 100,      // 缓存前多少部候选(按全体人数/时长排)
    maxTrack: 500,        // 每部最多逐个记多少个贡献者令牌
};
const WINDOW = '7d';
// 候选:每人每部累计 ≥minUserSec 才算一个"在看"的人;按人数、再按总时长取前 N 部,连同各自的贡献者一起取出
const SQL = `WITH per AS (
        SELECT title, user_token, SUM(seconds) s
        FROM watch_stats
        WHERE kind = 'vod' AND last_at >= ?
            AND user_token NOT IN (SELECT user_token FROM user_stats WHERE banned = 1)
        GROUP BY title, user_token HAVING s >= ?
    ), top AS (
        SELECT title, COUNT(*) users, SUM(s) seconds FROM per GROUP BY title HAVING COUNT(*) >= ?
        ORDER BY users DESC, seconds DESC, title LIMIT ?
    )
    SELECT top.title, top.users, top.seconds, per.user_token, per.s
    FROM top JOIN per ON per.title = top.title`;

function createPopular(deps) {
    deps = deps || {};
    const C = Object.assign({}, DEF, deps.opts || {});
    // 逐个记的上限必须超过门槛:不记名单的剧扣掉调用者后仍 ≥ minUsers
    const maxTrack = Math.max(C.maxTrack, C.minUsers + 1);
    const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;
    const dbOf = () => { try { return deps.db ? (deps.db() || null) : null; } catch (e) { return null; } };
    const enabled = () => { try { return !!dbOf() && (deps.enabled ? !!deps.enabled() : true); } catch (e) { return false; } };
    // 私密站(配了访问密码)才要令牌;依赖缺省 = 公开
    const authRequired = () => { try { return !!(deps.authRequired && deps.authRequired()); } catch (e) { return true; } };
    const tokenOk = (t) => { try { return typeof t === 'string' && !!t && !!(deps.tokenOk && deps.tokenOk(t)); } catch (e) { return false; } };
    const isBanned = (t) => { try { return !!(deps.isBanned && deps.isBanned(t)); } catch (e) { return false; } };
    const warnAt = {};
    const warn = (tag, e) => { const t = Date.now(); if (!warnAt[tag] || t - warnAt[tag] > 60e3) { warnAt[tag] = t; console.warn('[Popular] ' + tag + ':', e && e.message || e); } };

    let cache = null;   // { at, list: [{ title, users, seconds, who: Map(token → 秒) | null }] }
    function compute() {
        const d = dbOf();
        if (!d) return [];
        const rows = d.prepare(SQL).all(nowFn() - C.windowDays * DAY, C.minUserSec, C.minUsers, C.candidates);
        const byTitle = new Map();
        for (const r of rows) {
            let e = byTitle.get(r.title);
            if (!e) { e = { title: r.title, users: r.users, seconds: r.seconds, who: r.users <= maxTrack ? new Map() : null }; byTitle.set(r.title, e); }
            if (e.who) e.who.set(r.user_token, r.s);
        }
        return [...byTitle.values()];
    }
    function candidates() {
        if (cache && Date.now() - cache.at < C.cacheMs) return cache.list;
        const list = compute();   // 抛错(表还没建好等)由调用方接住:不缓存,下次再试
        cache = { at: Date.now(), list };
        return list;
    }
    // caller:调用者令牌,他自己的观看不算人数也不算时长。
    //   认不出是谁(公开站不带令牌/令牌无效)→ 当他在每一部里都有份,一律少算 1 人:
    //   不然有令牌的人上报完观看、再不带令牌来看榜,自己那一票又算回去了,探测照样成立
    function get(caller) {
        if (!enabled()) return { window: WINDOW, items: [] };
        let list;
        try { list = candidates(); }
        catch (e) { warn('query', e); return { window: WINDOW, items: [] }; }
        const me = (typeof caller === 'string' && caller) ? caller : null;
        const view = [];
        for (const c of list) {
            let users = c.users, seconds = c.seconds;
            if (me && c.who) {
                if (c.who.has(me)) { users--; seconds -= c.who.get(me); }
            } else users--;   // 匿名调用者 / 名单太长没记:保守按"他也在里面"少算 1 人
            if (users >= C.minUsers) view.push({ title: c.title, users, seconds });
        }
        view.sort((a, b) => (b.users - a.users) || (b.seconds - a.seconds) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
        // 只出展示字段:片名 + 种类(查询只取 vod)。人数/秒数/集数/令牌一律不出
        return { window: WINDOW, items: view.slice(0, C.limit).map(x => ({ title: x.title, kind: 'vod' })) };
    }
    function registerRoutes(app) {
        app.get('/api/popular', (req, res) => {
            const token = String((req.query && req.query.token) || '');
            if (authRequired()) {
                if (!tokenOk(token)) { res.set('Cache-Control', 'no-store'); return res.status(401).json({ ok: false, error: 'auth' }); }
                if (isBanned(token)) { res.set('Cache-Control', 'no-store'); return res.status(403).json({ ok: false, error: 'banned', banned: true }); }
            }
            // 回包因调用者而异(扣掉他自己):只许浏览器私有缓存,URL 里带着令牌
            res.set('Cache-Control', 'private, max-age=300');
            res.json(get(tokenOk(token) ? token : ''));
        });
    }
    return { registerRoutes, get, enabled, invalidate: () => { cache = null; } };
}

module.exports = { createPopular, DEF };
