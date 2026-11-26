'use strict';
// 💬 评论 + 用户弹幕(server.js 用;Vercel 没有 SQLite → api/index.js 只回空/关闭)
//
// 为什么这样做:
//   · 平台弹幕是借 danmu_api 的(/api/danmaku/v3/),播放器以前发的弹幕哪都不存。这里把登录用户发的弹幕存下来,
//     按"剧 + 集"(public/libs/js/ucomm-key.js,与播放页 _danmakuKey 同一套归一)给所有人:同一集换哪条线路都是同一批。
//     播放器经 DPlayer 的 danmaku.addition 第二个端点取(/api/udanmaku/v3/),和平台弹幕合进同一个列表、按时间排序。
//   · 时间:存的是 DPlayer 发送时的 danmaku.options.time() —— 这本来就是弹幕列表的时间轴(播放页的映射已经扣掉插播、加上偏移),
//     取回来原样放进同一个列表,不再做任何偏移;发的人和平台弹幕在同一个时间轴上,别人那条线路的映射会把它对到同一个画面。
//   · 只有同步账号(PASSWORD_HASH_MAP 里 syncEnabled 的令牌:机场账号 / 独立密码)能发;被封禁的发不了,
//     而且他发过的一律不再给别人看(按 user_stats.banned 现查,解封就回来)。
//   · 防刷:每账号短时间窗口限速(内存)+ 每天上限(按库里现数,重启不清零);同一账号 10 分钟内同样的话不收;长度上限;
//     屏蔽词(站长后台可改,存 uc_meta)+ 不收网址/长串数字;之后是可插拔的 reviewText(text, ctx)(默认放行,
//     父会话会接 Cloudflare Workers AI:回 { action:'reject' } 拒收、{ action:'hold' } 收下但只给作者自己看,出错/超时一律放行)。
//   · 举报:不同账号举报满 reportHide(默认 3)次自动收起(只作者自己还看得见),等站长在后台决定恢复还是删除。
//   · 作者在评论区显示成"观众XXXX"(HMAC(本站随机盐, 令牌) 取 4 位),绝不出令牌 / 邮箱。
//   · 读:配了访问密码的站要有效令牌(?token=,和 /api/popular 一样);公开站谁都能读。
//     GET 地址一律带 token 参数(可以是空的):站点 Service Worker 对带 token 的 /api 请求直达、不进缓存(sw.js ⑧)。
const crypto = require('crypto');
const K = require('../../public/libs/js/ucomm-key.js');

const DAY = 86400e3;
const DEF = {
    dmMaxLen: 40,            // 播放器输入框 maxlength 是 30,留点余量
    cmMaxLen: 500,
    dmRate: [[4e3, 1], [60e3, 12]],          // [窗口 ms, 最多几条](内存)
    cmRate: [[15e3, 1], [10 * 60e3, 10]],
    likeRate: [[60e3, 60]],
    reportRate: [[60e3, 10]],
    dmPerDay: 300,           // 每账号 24 小时(查库)
    cmPerDay: 60,
    reportPerDay: 100,
    dupWindowMs: 10 * 60e3,  // 同一账号这么久内同样的话不收
    reportHide: 3,           // 不同账号举报满几次自动收起
    epMax: 3000,             // 一集最多回多少条用户弹幕(最新的)
    pageSize: 20,
    replyPreview: 3,
    dmListMax: 100,          // 评论区"弹幕"页一页几条
    reviewTimeoutMs: 4000,
    maxWords: 500,
};
// 默认屏蔽词:只放几乎不会出现在正常观影聊天里的引流 / 赌博 / 色情招揽说法;站长在后台增删(存进库后以库为准)
const DEFAULT_WORDS = ['加微信', '加我微信', '加v', '加薇', '薇信', '威信号', 'vx号', '加qq', 'qq群', '扣扣群', '博彩', '菠菜', '棋牌', '赌场', '裸聊', '约炮', '刷单', '网赚', '兼职日结', '色情网', '黄网', '成人网站'];
// 状态:0 正常 / 1 站长隐藏 / 2 举报过多自动收起 / 3 审核拦下(只作者可见)
const ST_OK = 0, ST_HIDDEN = 1, ST_AUTO = 2, ST_HOLD = 3;

function nfkc(s) { s = String(s == null ? '' : s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
// 屏蔽词比对用:全角转半角、小写、去掉空白和常见分隔符("加 微 信"/"加-微-信" 也认)
function normMatch(s) { return nfkc(s).toLowerCase().replace(/[\s​-‏⁠﻿`~!@#$%^&*()_\-+=\[\]{}|\\:;"'<>,.?/·！￥…（）—【】、；：‘’“”《》，。？~～・]+/g, ''); }
function hasLink(s) {
    const t = nfkc(s).toLowerCase();
    return /https?:\/\/|www\.|[a-z0-9-]{2,}\.(com|net|cn|org|top|xyz|cc|me|io|vip|tv|co|info|club|site|online|app|link|live)(?![a-z])/.test(t);
}
// 控制字符去掉、空白折叠;评论保留换行(最多连续 2 个、最多 20 行),弹幕单行。
//   存原文,不做 NFKC(会把中文全角标点"，"改成半角",");全角转半角只在比对屏蔽词时做(normMatch)
function cleanText(s, max, multiline) {
    let t = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g, '');
    if (multiline) {
        t = t.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t　]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
        const lines = t.split('\n'); if (lines.length > 20) t = lines.slice(0, 20).join('\n');
    } else t = t.replace(/\s+/g, ' ').trim();
    return Array.from(t).slice(0, max).join('');
}
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
const NICK_ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// 默认的审核钩子:什么都不管,全部放行(父会话接 Workers AI 时替换,见 server.js reviewText)
async function reviewTextStub() { return { action: 'allow' }; }

function createComments(deps) {
    deps = deps || {};
    const C = Object.assign({}, DEF, deps.opts || {});
    const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;
    const dbOf = () => { try { return deps.db ? (deps.db() || null) : null; } catch (e) { return null; } };
    const authRequired = () => { try { return !!(deps.authRequired && deps.authRequired()); } catch (e) { return true; } };
    const tokenOk = (t) => { try { return typeof t === 'string' && !!t && !!(deps.tokenOk && deps.tokenOk(t)); } catch (e) { return false; } };
    // 能发言 = 有效令牌 + 同步账号
    const canPost = (t) => {
        if (!tokenOk(t)) return false;
        try { const info = deps.tokenInfo ? deps.tokenInfo(t) : null; return !!(info && info.syncEnabled); } catch (e) { return false; }
    };
    const isBanned = (t) => { try { return !!(deps.isBanned && deps.isBanned(t)); } catch (e) { return false; } };
    const adminAuthed = (req) => { try { return !!(deps.adminAuthed && deps.adminAuthed(req)); } catch (e) { return false; } };
    const identity = (t, label) => { try { return deps.identity ? String(deps.identity(t, label) || '') : String(t || '').slice(0, 12); } catch (e) { return ''; } };
    let reviewer = typeof deps.reviewText === 'function' ? deps.reviewText : reviewTextStub;
    const warnAt = {};
    const warn = (tag, e) => { const t = Date.now(); if (!warnAt[tag] || t - warnAt[tag] > 60e3) { warnAt[tag] = t; console.warn('[Comments] ' + tag + ':', e && e.message || e); } };

    // ---------- 表 ----------
    let schemaDb = null, bannedSql = '', bannedCheckedAt = 0;
    function ensureSchema(d) {
        d.exec(`
            CREATE TABLE IF NOT EXISTS uc_danmaku (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                show_key TEXT NOT NULL, ep_key TEXT NOT NULL, ep_label TEXT, title TEXT,
                t REAL NOT NULL, text TEXT NOT NULL, color INTEGER NOT NULL DEFAULT 16777215, type INTEGER NOT NULL DEFAULT 0,
                user_token TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_ucd_ep ON uc_danmaku(show_key, ep_key, id);
            CREATE INDEX IF NOT EXISTS idx_ucd_show ON uc_danmaku(show_key, created_at);
            CREATE INDEX IF NOT EXISTS idx_ucd_user ON uc_danmaku(user_token, created_at);
            CREATE INDEX IF NOT EXISTS idx_ucd_time ON uc_danmaku(created_at);
            CREATE TABLE IF NOT EXISTS uc_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                show_key TEXT NOT NULL, title TEXT, parent_id INTEGER NOT NULL DEFAULT 0,
                ep_key TEXT, ep_label TEXT, text TEXT NOT NULL, user_token TEXT NOT NULL,
                likes INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
                status INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_ucc_show ON uc_comments(show_key, parent_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_ucc_parent ON uc_comments(parent_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_ucc_user ON uc_comments(user_token, created_at);
            CREATE INDEX IF NOT EXISTS idx_ucc_time ON uc_comments(created_at);
            CREATE TABLE IF NOT EXISTS uc_likes (comment_id INTEGER NOT NULL, user_token TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (comment_id, user_token)) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS uc_reports (kind TEXT NOT NULL, item_id INTEGER NOT NULL, user_token TEXT NOT NULL, reason TEXT, created_at INTEGER, PRIMARY KEY (kind, item_id, user_token)) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_ucr_user ON uc_reports(user_token, created_at);
            CREATE TABLE IF NOT EXISTS uc_meta (k TEXT PRIMARY KEY, v TEXT);
        `);
    }
    function db() {
        const d = dbOf();
        if (!d) return null;
        if (schemaDb !== d) {
            try { ensureSchema(d); schemaDb = d; bannedCheckedAt = 0; }
            catch (e) { warn('schema', e); return null; }
        }
        // 封禁用户发的不给别人看:user_stats 是 server.js 建的表;还没有就不加这个条件(每分钟再看一次)
        if (!bannedSql || Date.now() - bannedCheckedAt > 60e3) {
            if (!bannedSql) {
                try { bannedSql = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_stats'").get() ? ' AND NOT EXISTS (SELECT 1 FROM user_stats us WHERE us.user_token = x.user_token AND us.banned = 1)' : ''; }
                catch (e) { bannedSql = ''; }
            }
            bannedCheckedAt = Date.now();
        }
        return d;
    }
    const enabled = () => !!db();

    // ---------- 本站随机盐 / 屏蔽词 ----------
    let salt = null, words = null;
    function meta(d, k) { const r = d.prepare('SELECT v FROM uc_meta WHERE k = ?').get(k); return r ? r.v : null; }
    function setMeta(d, k, v) { d.prepare('INSERT INTO uc_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v); }
    function saltOf(d) {
        if (salt) return salt;
        let s = meta(d, 'salt');
        if (!s) { s = crypto.randomBytes(16).toString('hex'); setMeta(d, 'salt', s); }
        return (salt = s);
    }
    function nickOf(d, token) {
        const h = crypto.createHmac('sha256', saltOf(d)).update(String(token)).digest();
        let s = ''; for (let i = 0; i < 4; i++) s += NICK_ABC[h[i] % NICK_ABC.length];
        return '观众' + s;
    }
    function wordList(d) {
        if (words) return words;
        let list = null;
        try { const v = meta(d, 'words'); if (v) list = JSON.parse(v); } catch (e) { list = null; }
        if (!Array.isArray(list)) list = DEFAULT_WORDS.slice();
        words = { raw: list, norm: list.map(normMatch).filter(Boolean) };
        return words;
    }
    function normWords(list) {
        const out = [], seen = new Set();
        for (const w of (Array.isArray(list) ? list : String(list || '').split(/\r?\n|,|，/))) {
            const s = cleanText(w, 30, false);
            const n = normMatch(s);
            if (!n || seen.has(n)) continue;
            seen.add(n); out.push(s);
            if (out.length >= C.maxWords) break;
        }
        return out;
    }
    // 内容检查:返回 null = 没问题,否则是给用户看的原因
    function badReason(d, text, what) {
        if (hasLink(text)) return what + '里不能带网址';
        const n = normMatch(text);
        if (/\d{9,}/.test(n)) return what + '里不能带联系方式';
        for (const w of wordList(d).norm) if (n.indexOf(w) >= 0) return what + '里有不允许发的词';
        return null;
    }
    async function review(text, ctx) {
        let timer = null;
        try {
            const r = await Promise.race([
                Promise.resolve().then(() => reviewer(text, ctx)),
                new Promise(res => { timer = setTimeout(() => res({ action: 'allow', timeout: true }), C.reviewTimeoutMs); })
            ]);
            if (r && r.timeout) warn('review', 'timeout');
            const a = r && typeof r === 'object' ? String(r.action || 'allow') : (r === false ? 'reject' : 'allow');
            return (a === 'reject' || a === 'hold') ? a : 'allow';
        } catch (e) { warn('review', e); return 'allow'; }
        finally { clearTimeout(timer); }
    }

    // ---------- 限速(内存短窗口)----------
    const hits = new Map();
    function rateOk(kind, token, rules) {
        const k = kind + '|' + token, now = Date.now();
        const maxW = Math.max.apply(null, rules.map(r => r[0]));
        const a = (hits.get(k) || []).filter(t => now - t < maxW);
        for (const [w, max] of rules) { let n = 0; for (const t of a) if (now - t < w) n++; if (n >= max) { hits.set(k, a); return false; } }
        return true;
    }
    function rateHit(kind, token, rules) {
        const k = kind + '|' + token, now = Date.now();
        const maxW = Math.max.apply(null, rules.map(r => r[0]));
        const a = (hits.get(k) || []).filter(t => now - t < maxW);
        a.push(now); hits.delete(k); hits.set(k, a);
        if (hits.size > 20000) { const it = hits.keys(); for (let i = 0; i < 2000; i++) hits.delete(it.next().value); }
    }

    // 读接口的令牌闸门:配了访问密码的站要有效令牌
    function readGate(req, res) {
        const token = String((req.query && req.query.token) || '');
        res.set('Cache-Control', 'no-store');
        if (authRequired() && !tokenOk(token)) { res.status(401).json({ ok: false, error: 'auth' }); return null; }
        if (token && tokenOk(token) && isBanned(token)) { res.status(403).json({ ok: false, error: 'banned', banned: true }); return null; }
        return { me: tokenOk(token) ? token : '' };
    }
    // 写接口:同步账号 + 没被封;不行返回给用户看的原因
    function writeGate(token) {
        if (!canPost(token)) return { status: 401, error: 'login', msg: '登录同步账号后才能发言' };
        if (isBanned(token)) return { status: 403, error: 'banned', msg: '你的账号已被限制发言' };
        return null;
    }

    // ---------- 用户弹幕 ----------
    // 给播放器:DPlayer v3 格式 [时间, 类型, 颜色, 作者, 文字]。文字转义 —— DPlayer 用 innerHTML 画弹幕
    function episodeDanmaku(sk, ek, me) {
        const d = db();
        if (!d || !sk || !ek) return [];
        const rows = d.prepare(`SELECT id, t, type, color, text FROM uc_danmaku x
            WHERE show_key = ? AND ep_key = ? AND (status = 0${bannedSql}${me ? ' OR (user_token = ? AND status != 1)' : ''})
            ORDER BY id DESC LIMIT ?`).all(...me ? [sk, ek, me, C.epMax] : [sk, ek, C.epMax]);
        rows.sort((a, b) => a.t - b.t || a.id - b.id);
        return rows.map(r => [Math.round(r.t * 10) / 10, r.type, r.color, 'uc' + r.id, escHtml(r.text)]);
    }
    async function postDanmaku(body) {
        body = body || {};
        const token = String(body.token || '');
        const g = writeGate(token);
        if (g) return g;
        const d = db();
        if (!d) return { status: 503, error: 'disabled', msg: '弹幕暂时发不了' };
        let id = String(body.id || '');
        try { if (/%[0-9a-f]{2}/i.test(id)) id = decodeURIComponent(id); } catch (e) { }
        const p = K.parseDmId(id);
        const sk = K.showKey(p.title, body.w), ek = K.epKey(p.ep, p.n);
        if (!sk || !ek) return { status: 400, error: 'bad', msg: '没认出是哪一集' };
        const text = cleanText(body.text, C.dmMaxLen, false);
        if (!text) return { status: 400, error: 'empty', msg: '弹幕不能是空的' };
        const t = Number(body.time);
        if (!isFinite(t) || t < 0 || t > 86400) return { status: 400, error: 'bad', msg: '时间不对' };
        const type = [0, 1, 2].indexOf(Number(body.type)) >= 0 ? Number(body.type) : 0;
        let color = Math.floor(Number(body.color));
        if (!isFinite(color) || color < 0 || color > 0xffffff) color = 0xffffff;
        const bad = badReason(d, text, '弹幕');
        if (bad) return { status: 400, error: 'word', msg: bad };
        if (!rateOk('d', token, C.dmRate)) return { status: 429, error: 'rate', msg: '发得太快了,歇一会儿再发' };
        const now = nowFn();
        if (d.prepare('SELECT COUNT(*) n FROM uc_danmaku WHERE user_token = ? AND created_at > ?').get(token, now - DAY).n >= C.dmPerDay) return { status: 429, error: 'day', msg: '今天发的弹幕太多了,明天再来' };
        if (d.prepare('SELECT 1 FROM uc_danmaku WHERE user_token = ? AND created_at > ? AND text = ? LIMIT 1').get(token, now - C.dupWindowMs, text)) return { status: 429, error: 'dup', msg: '同样的话刚发过了' };
        rateHit('d', token, C.dmRate);
        const verdict = await review(text, { kind: 'danmaku', token, title: p.title, ep: p.ep });
        if (verdict === 'reject') return { status: 400, error: 'review', msg: '这条弹幕没通过审核' };
        const info = d.prepare(`INSERT INTO uc_danmaku (show_key, ep_key, ep_label, title, t, text, color, type, user_token, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sk, ek, p.ep.slice(0, 60), p.title.slice(0, 100), Math.round(t * 10) / 10, text, color, type, token, verdict === 'hold' ? ST_HOLD : ST_OK, now);
        return { ok: true, id: Number(info.lastInsertRowid), held: verdict === 'hold' };
    }
    // 评论区"弹幕"页:这部剧最近的用户弹幕(全部集)
    function showDanmaku(sk, me, page) {
        const d = db();
        if (!d || !sk) return { items: [], total: 0 };
        const vis = `(status = 0${bannedSql}${me ? ' OR (user_token = ? AND status != 1)' : ''})`;
        const args = me ? [sk, me] : [sk];
        const total = d.prepare(`SELECT COUNT(*) n FROM uc_danmaku x WHERE show_key = ? AND ${vis}`).get(...args).n;
        const off = Math.max(0, (page - 1) * C.dmListMax);
        const rows = d.prepare(`SELECT id, ep_key, ep_label, t, text, user_token, status, created_at FROM uc_danmaku x WHERE show_key = ? AND ${vis}
            ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args.concat([C.dmListMax, off]));
        return {
            total, page, pages: Math.max(1, Math.ceil(total / C.dmListMax)),
            items: rows.map(r => ({ id: r.id, epKey: r.ep_key, ep: K.epText(r.ep_key, r.ep_label), t: Math.round(r.t * 10) / 10, text: r.text, nick: nickOf(d, r.user_token), mine: !!me && r.user_token === me, hidden: r.status !== ST_OK, at: r.created_at }))
        };
    }

    // ---------- 评论 ----------
    function shapeComment(d, r, me, liked) {
        return {
            id: r.id, nick: nickOf(d, r.user_token), mine: !!me && r.user_token === me, text: r.text,
            ep: r.ep_key ? K.epText(r.ep_key, r.ep_label) : '', epKey: r.ep_key || '',
            likes: r.likes, liked: !!(liked && liked.has(r.id)), hidden: r.status !== ST_OK, at: r.created_at
        };
    }
    function visClause(me) { return `(x.status = 0${bannedSql}${me ? ' OR (x.user_token = ? AND x.status != 1)' : ''})`; }
    function likedSet(d, me, ids) {
        if (!me || !ids.length) return new Set();
        return new Set(d.prepare(`SELECT comment_id FROM uc_likes WHERE user_token = ? AND comment_id IN (${ids.map(() => '?').join(',')})`).all(...[me].concat(ids)).map(r => r.comment_id));
    }
    function listComments(sk, me, sort, page) {
        const d = db();
        if (!d || !sk) return { items: [], total: 0, page: 1, pages: 1 };
        const vis = visClause(me), va = me ? [me] : [];
        const total = d.prepare(`SELECT COUNT(*) n FROM uc_comments x WHERE x.show_key = ? AND x.parent_id = 0 AND ${vis}`).get(...[sk].concat(va)).n;
        const all = d.prepare(`SELECT COUNT(*) n FROM uc_comments x WHERE x.show_key = ? AND ${vis}`).get(...[sk].concat(va)).n;
        const order = sort === 'hot' ? 'x.likes * 2 + x.replies DESC, x.created_at DESC' : 'x.created_at DESC';
        const rows = d.prepare(`SELECT * FROM uc_comments x WHERE x.show_key = ? AND x.parent_id = 0 AND ${vis} ORDER BY ${order}, x.id DESC LIMIT ? OFFSET ?`)
            .all(...[sk].concat(va, [C.pageSize, Math.max(0, (page - 1) * C.pageSize)]));
        const ids = rows.map(r => r.id);
        const rep = new Map(), repN = new Map();
        if (ids.length) {
            const ph = ids.map(() => '?').join(',');
            for (const r of d.prepare(`SELECT parent_id, COUNT(*) n FROM uc_comments x WHERE x.parent_id IN (${ph}) AND ${vis} GROUP BY parent_id`).all(...ids.concat(va))) repN.set(r.parent_id, r.n);
            const rr = d.prepare(`SELECT * FROM (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.parent_id ORDER BY x.created_at, x.id) rn FROM uc_comments x WHERE x.parent_id IN (${ph}) AND ${vis}) WHERE rn <= ?`)
                .all(...ids.concat(va, [C.replyPreview]));
            for (const r of rr) { if (!rep.has(r.parent_id)) rep.set(r.parent_id, []); rep.get(r.parent_id).push(r); }
        }
        const liked = likedSet(d, me, ids.concat([].concat.apply([], [...rep.values()]).map(r => r.id)));
        return {
            total, all, page, pages: Math.max(1, Math.ceil(total / C.pageSize)),
            items: rows.map(r => Object.assign(shapeComment(d, r, me, liked), {
                replyN: repN.get(r.id) || 0,
                replies: (rep.get(r.id) || []).map(x => shapeComment(d, x, me, liked))
            }))
        };
    }
    function listReplies(pid, me, offset) {
        const d = db();
        if (!d || !pid) return { items: [] };
        const vis = visClause(me), va = me ? [me] : [];
        const rows = d.prepare(`SELECT * FROM uc_comments x WHERE x.parent_id = ? AND ${vis} ORDER BY x.created_at, x.id LIMIT 50 OFFSET ?`).all(...[pid].concat(va, [Math.max(0, offset || 0)]));
        const liked = likedSet(d, me, rows.map(r => r.id));
        return { items: rows.map(r => shapeComment(d, r, me, liked)) };
    }
    async function postComment(body) {
        body = body || {};
        const token = String(body.token || '');
        const g = writeGate(token);
        if (g) return g;
        const d = db();
        if (!d) return { status: 503, error: 'disabled', msg: '评论暂时用不了' };
        const text = cleanText(body.text, C.cmMaxLen, true);
        if (!text) return { status: 400, error: 'empty', msg: '评论不能是空的' };
        let sk, title, parent = 0, ek = '', el = '';
        const pid = Math.floor(Number(body.parent) || 0);
        if (pid > 0) {
            // 回复只有一层:回复的回复挂到同一条顶层评论下
            let p = d.prepare('SELECT id, parent_id, show_key, title, status FROM uc_comments WHERE id = ?').get(pid);
            if (p && p.parent_id) p = d.prepare('SELECT id, parent_id, show_key, title, status FROM uc_comments WHERE id = ?').get(p.parent_id);
            if (!p || p.status === ST_HIDDEN) return { status: 404, error: 'gone', msg: '这条评论已经不在了' };
            sk = p.show_key; title = p.title || ''; parent = p.id;
        } else {
            title = cleanText(body.title, 100, false);
            sk = K.showKey(title, body.w);
            if (!sk) return { status: 400, error: 'bad', msg: '没认出是哪部剧' };
            if (body.ep) { el = cleanText(body.ep, 60, false); ek = el ? K.epKey(el, Number(body.n) || 0) : ''; }
        }
        const bad = badReason(d, text, '评论');
        if (bad) return { status: 400, error: 'word', msg: bad };
        if (!rateOk('c', token, C.cmRate)) return { status: 429, error: 'rate', msg: '发得太快了,歇一会儿再发' };
        const now = nowFn();
        if (d.prepare('SELECT COUNT(*) n FROM uc_comments WHERE user_token = ? AND created_at > ?').get(token, now - DAY).n >= C.cmPerDay) return { status: 429, error: 'day', msg: '今天发的评论太多了,明天再来' };
        if (d.prepare('SELECT 1 FROM uc_comments WHERE user_token = ? AND created_at > ? AND text = ? LIMIT 1').get(token, now - C.dupWindowMs, text)) return { status: 429, error: 'dup', msg: '同样的话刚发过了' };
        rateHit('c', token, C.cmRate);
        const verdict = await review(text, { kind: parent ? 'reply' : 'comment', token, title });
        if (verdict === 'reject') return { status: 400, error: 'review', msg: '这条评论没通过审核' };
        const ins = d.transaction(() => {
            const info = d.prepare(`INSERT INTO uc_comments (show_key, title, parent_id, ep_key, ep_label, text, user_token, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sk, title, parent, ek || null, el || null, text, token, verdict === 'hold' ? ST_HOLD : ST_OK, now);
            if (parent && verdict !== 'hold') d.prepare('UPDATE uc_comments SET replies = replies + 1 WHERE id = ?').run(parent);
            return Number(info.lastInsertRowid);
        });
        const id = ins();
        const row = d.prepare('SELECT * FROM uc_comments WHERE id = ?').get(id);
        return { ok: true, held: verdict === 'hold', item: Object.assign(shapeComment(d, row, token, null), parent ? { parent } : { replyN: 0, replies: [] }) };
    }
    function like(body) {
        body = body || {};
        const token = String(body.token || '');
        const g = writeGate(token);
        if (g) return g;
        const d = db();
        if (!d) return { status: 503, error: 'disabled', msg: '暂时用不了' };
        const id = Math.floor(Number(body.id) || 0);
        const row = id > 0 ? d.prepare('SELECT id, status FROM uc_comments WHERE id = ?').get(id) : null;
        if (!row || row.status === ST_HIDDEN) return { status: 404, error: 'gone', msg: '这条评论已经不在了' };
        if (!rateOk('l', token, C.likeRate)) return { status: 429, error: 'rate', msg: '点得太快了' };
        rateHit('l', token, C.likeRate);
        const out = d.transaction(() => {
            const has = d.prepare('SELECT 1 FROM uc_likes WHERE comment_id = ? AND user_token = ?').get(id, token);
            if (has) { d.prepare('DELETE FROM uc_likes WHERE comment_id = ? AND user_token = ?').run(id, token); d.prepare('UPDATE uc_comments SET likes = MAX(0, likes - 1) WHERE id = ?').run(id); }
            else { d.prepare('INSERT INTO uc_likes (comment_id, user_token, created_at) VALUES (?, ?, ?)').run(id, token, nowFn()); d.prepare('UPDATE uc_comments SET likes = likes + 1 WHERE id = ?').run(id); }
            return { ok: true, liked: !has, likes: d.prepare('SELECT likes FROM uc_comments WHERE id = ?').get(id).likes };
        });
        return out();
    }
    const KIND_TABLE = { c: 'uc_comments', d: 'uc_danmaku' };
    function report(body) {
        body = body || {};
        const token = String(body.token || '');
        const g = writeGate(token);
        if (g) return g;
        const d = db();
        if (!d) return { status: 503, error: 'disabled', msg: '暂时用不了' };
        const kind = body.kind === 'd' ? 'd' : 'c', tbl = KIND_TABLE[kind];
        const id = Math.floor(Number(body.id) || 0);
        const row = id > 0 ? d.prepare(`SELECT id, status, user_token FROM ${tbl} WHERE id = ?`).get(id) : null;
        if (!row) return { status: 404, error: 'gone', msg: '这条已经不在了' };
        if (row.user_token === token) return { ok: true };   // 举报自己的:不算数
        if (!rateOk('r', token, C.reportRate)) return { status: 429, error: 'rate', msg: '举报得太频繁了' };
        const now = nowFn();
        if (d.prepare('SELECT COUNT(*) n FROM uc_reports WHERE user_token = ? AND created_at > ?').get(token, now - DAY).n >= C.reportPerDay) return { status: 429, error: 'day', msg: '今天举报得太多了' };
        rateHit('r', token, C.reportRate);
        d.transaction(() => {
            const info = d.prepare('INSERT OR IGNORE INTO uc_reports (kind, item_id, user_token, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(kind, id, token, cleanText(body.reason, 100, false), now);
            if (!info.changes) return;
            d.prepare(`UPDATE ${tbl} SET reports = reports + 1 WHERE id = ?`).run(id);
            d.prepare(`UPDATE ${tbl} SET status = ? WHERE id = ? AND status = 0 AND reports >= ?`).run(ST_AUTO, id, C.reportHide);
        })();
        return { ok: true };
    }
    // 删一条评论(连同它的回复、赞、举报);回复则给顶层评论的回复数减一
    function deleteComment(d, id) {
        const row = d.prepare('SELECT id, parent_id, status FROM uc_comments WHERE id = ?').get(id);
        if (!row) return 0;
        const ids = [id].concat(row.parent_id ? [] : d.prepare('SELECT id FROM uc_comments WHERE parent_id = ?').all(id).map(r => r.id));
        const ph = ids.map(() => '?').join(',');
        d.prepare(`DELETE FROM uc_likes WHERE comment_id IN (${ph})`).run(...ids);
        d.prepare(`DELETE FROM uc_reports WHERE kind = 'c' AND item_id IN (${ph})`).run(...ids);
        d.prepare(`DELETE FROM uc_comments WHERE id IN (${ph})`).run(...ids);
        if (row.parent_id && row.status !== ST_HOLD) d.prepare('UPDATE uc_comments SET replies = MAX(0, replies - 1) WHERE id = ?').run(row.parent_id);
        return ids.length;
    }
    function deleteDanmaku(d, id) {
        d.prepare("DELETE FROM uc_reports WHERE kind = 'd' AND item_id = ?").run(id);
        return d.prepare('DELETE FROM uc_danmaku WHERE id = ?').run(id).changes;
    }
    function removeOwn(body) {
        body = body || {};
        const token = String(body.token || '');
        if (!tokenOk(token)) return { status: 401, error: 'login', msg: '请先登录' };
        const d = db();
        if (!d) return { status: 503, error: 'disabled', msg: '暂时用不了' };
        const kind = body.kind === 'd' ? 'd' : 'c', id = Math.floor(Number(body.id) || 0);
        const row = id > 0 ? d.prepare(`SELECT user_token FROM ${KIND_TABLE[kind]} WHERE id = ?`).get(id) : null;
        if (!row || row.user_token !== token) return { status: 404, error: 'gone', msg: '这条已经不在了' };
        d.transaction(() => (kind === 'c' ? deleteComment(d, id) : deleteDanmaku(d, id)))();
        return { ok: true };
    }

    // ---------- 站长 ----------
    function adminList(q) {
        const d = db();
        if (!d) return { available: false, items: [], total: 0 };
        const kind = q.kind === 'd' ? 'd' : 'c', tbl = KIND_TABLE[kind];
        const filter = ['reported', 'hidden', 'all'].indexOf(q.filter) >= 0 ? q.filter : 'all';
        const size = Math.min(100, Math.max(10, Math.floor(Number(q.size) || 30)));
        const page = Math.max(1, Math.min(1000, Math.floor(Number(q.page) || 1)));
        const where = [], args = [];
        if (filter === 'reported') where.push('x.reports > 0');
        else if (filter === 'hidden') where.push('x.status != 0');
        const s = String(q.q || '').trim().slice(0, 60);
        if (s) { where.push('(instr(x.text, ?) > 0 OR instr(x.title, ?) > 0)'); args.push(s, s); }
        if (q.token) { where.push('x.user_token = ?'); args.push(String(q.token)); }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const hasStats = !!bannedSql;
        const total = d.prepare(`SELECT COUNT(*) n FROM ${tbl} x ${w}`).get(...args).n;
        const order = filter === 'reported' ? 'x.reports DESC, x.created_at DESC' : 'x.created_at DESC';
        const rows = d.prepare(`SELECT x.*${hasStats ? ', us.label AS us_label, us.banned AS us_banned' : ''} FROM ${tbl} x
            ${hasStats ? 'LEFT JOIN user_stats us ON us.user_token = x.user_token' : ''} ${w} ORDER BY ${order}, x.id DESC LIMIT ? OFFSET ?`)
            .all(...args.concat([size, (page - 1) * size]));
        const cnt = (t, cond) => d.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${cond}`).get().n;
        return {
            available: true, kind, filter, page, size, total, pages: Math.max(1, Math.ceil(total / size)),
            counts: {
                c: { all: cnt('uc_comments', '1'), reported: cnt('uc_comments', 'reports > 0'), hidden: cnt('uc_comments', 'status != 0') },
                d: { all: cnt('uc_danmaku', '1'), reported: cnt('uc_danmaku', 'reports > 0'), hidden: cnt('uc_danmaku', 'status != 0') }
            },
            items: rows.map(r => ({
                kind, id: r.id, title: r.title || '', ep: r.ep_key ? K.epText(r.ep_key, r.ep_label) : '', epLabel: r.ep_label || '',
                t: kind === 'd' ? r.t : null, parent: kind === 'c' ? r.parent_id : 0, text: r.text,
                token: r.user_token, who: identity(r.user_token, r.us_label || null), nick: nickOf(d, r.user_token), banned: !!r.us_banned,
                status: r.status, reports: r.reports, likes: kind === 'c' ? r.likes : 0, replies: kind === 'c' ? r.replies : 0, at: r.created_at
            }))
        };
    }
    function adminAction(body) {
        const d = db();
        if (!d) return { status: 400, error: '评论功能没启用(需要 SQLite)' };
        body = body || {};
        const kind = body.kind === 'd' ? 'd' : 'c', tbl = KIND_TABLE[kind];
        const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(x => Math.floor(Number(x) || 0)).filter(x => x > 0).slice(0, 200);
        if (!ids.length) return { status: 400, error: '没选中' };
        const action = String(body.action || '');
        if (['hide', 'show', 'delete'].indexOf(action) < 0) return { status: 400, error: '不认识的操作' };
        let changed = 0;
        d.transaction(() => {
            for (const id of ids) {
                if (action === 'delete') changed += kind === 'c' ? deleteComment(d, id) : deleteDanmaku(d, id);
                else if (action === 'hide') changed += d.prepare(`UPDATE ${tbl} SET status = ? WHERE id = ? AND status != ?`).run(ST_HIDDEN, id, ST_HIDDEN).changes;
                else {
                    // 恢复 = 站长看过了:清掉举报记录(不然下一个举报又立刻把它收起来)
                    changed += d.prepare(`UPDATE ${tbl} SET status = 0, reports = 0 WHERE id = ?`).run(id).changes;
                    d.prepare('DELETE FROM uc_reports WHERE kind = ? AND item_id = ?').run(kind, id);
                }
            }
            // 回复数按现在真正看得见的重算(隐藏/恢复/删除回复都会动它)
            if (kind === 'c') d.prepare(`UPDATE uc_comments SET replies = (SELECT COUNT(*) FROM uc_comments r WHERE r.parent_id = uc_comments.id AND r.status = 0)
                WHERE id IN (SELECT parent_id FROM uc_comments WHERE id IN (${ids.map(() => '?').join(',')}) AND parent_id > 0) OR id IN (${ids.map(() => '?').join(',')})`).run(...ids.concat(ids));
        })();
        return { ok: true, changed };
    }
    function getWords() { const d = db(); return d ? { available: true, words: wordList(d).raw, defaults: DEFAULT_WORDS } : { available: false, words: [], defaults: DEFAULT_WORDS }; }
    function setWords(list) {
        const d = db();
        if (!d) return { status: 400, error: '评论功能没启用(需要 SQLite)' };
        const w = normWords(list);
        setMeta(d, 'words', JSON.stringify(w));
        words = null;
        return { ok: true, words: wordList(d).raw };
    }

    // ---------- 路由 ----------
    function send(res, r) {
        if (r && r.status && !r.ok) return res.status(r.status).json({ ok: false, error: r.error, msg: r.msg });
        return res.json(r);
    }
    const intOf = (v, def) => { const n = Math.floor(Number(v)); return isFinite(n) && n > 0 ? n : def; };
    function registerRoutes(app) {
        // 播放器(DPlayer danmaku.addition):?id= 与平台弹幕同一个 id,&w= 作品签名。
        //   不要令牌(和平台弹幕 /api/danmaku/v3/ 一样):分享链接试看的人在看片就该看到弹幕;试看中登录,播放器不重建、
        //   不会带着令牌再要一次 —— 要令牌的话登录前那次空列表就一直空着。令牌只用来让作者看到自己被收起 / 审核中的那几条
        app.get('/api/udanmaku/v3/', (req, res) => {
            res.set('Cache-Control', 'no-store');
            const empty = { code: 0, version: 3, data: [], msg: '' };
            if (!enabled()) return res.json(empty);
            const token = String(req.query.token || '');
            const p = K.parseDmId(req.query.id);
            try { res.json({ code: 0, version: 3, data: episodeDanmaku(K.showKey(p.title, req.query.w), K.epKey(p.ep, p.n), tokenOk(token) ? token : ''), msg: '' }); }
            catch (e) { warn('udanmaku', e); res.json(empty); }
        });
        app.post('/api/udanmaku/v3/', async (req, res) => {
            res.set('Cache-Control', 'no-store');
            try {
                const r = await postDanmaku(req.body);
                // DPlayer:code 0 = 成功,否则把 msg 当提示显示出来
                if (r.ok) return res.json({ code: 0, msg: '', id: r.id, held: r.held });
                return res.status(r.status === 401 || r.status === 403 ? r.status : 200).json({ code: 1, error: r.error, msg: r.msg });
            } catch (e) { warn('post danmaku', e); res.json({ code: 1, msg: '弹幕没发出去,稍后再试' }); }
        });
        app.get('/api/comments', (req, res) => {
            const g = readGate(req, res); if (!g) return;
            if (!enabled()) return res.json({ enabled: false, items: [], total: 0, page: 1, pages: 1 });
            try { res.json(Object.assign({ enabled: true }, listComments(K.showKey(req.query.title, req.query.w), g.me, req.query.sort === 'hot' ? 'hot' : 'new', Math.min(500, intOf(req.query.page, 1))))); }
            catch (e) { warn('list', e); res.status(500).json({ ok: false, error: 'db' }); }
        });
        app.get('/api/comments/replies', (req, res) => {
            const g = readGate(req, res); if (!g) return;
            if (!enabled()) return res.json({ items: [] });
            try { res.json(listReplies(intOf(req.query.id, 0), g.me, intOf(req.query.offset, 0))); }
            catch (e) { warn('replies', e); res.status(500).json({ ok: false, error: 'db' }); }
        });
        app.get('/api/comments/danmaku', (req, res) => {
            const g = readGate(req, res); if (!g) return;
            if (!enabled()) return res.json({ items: [], total: 0 });
            try { res.json(showDanmaku(K.showKey(req.query.title, req.query.w), g.me, Math.min(200, intOf(req.query.page, 1)))); }
            catch (e) { warn('show danmaku', e); res.status(500).json({ ok: false, error: 'db' }); }
        });
        app.post('/api/comments', async (req, res) => {
            res.set('Cache-Control', 'no-store');
            try { send(res, await postComment(req.body)); } catch (e) { warn('post', e); res.status(500).json({ ok: false, msg: '没发出去,稍后再试' }); }
        });
        app.post('/api/comments/like', (req, res) => { try { send(res, like(req.body)); } catch (e) { warn('like', e); res.status(500).json({ ok: false }); } });
        app.post('/api/comments/report', (req, res) => { try { send(res, report(req.body)); } catch (e) { warn('report', e); res.status(500).json({ ok: false }); } });
        app.post('/api/comments/delete', (req, res) => { try { send(res, removeOwn(req.body)); } catch (e) { warn('delete', e); res.status(500).json({ ok: false }); } });
        // 站长(X-Admin-Token)
        app.get('/api/admin/ucomm', (req, res) => {
            if (!adminAuthed(req)) return res.status(403).json({ error: 'Forbidden' });
            try { res.json(adminList(req.query || {})); } catch (e) { warn('admin list', e); res.status(500).json({ error: e.message }); }
        });
        app.post('/api/admin/ucomm/action', (req, res) => {
            if (!adminAuthed(req)) return res.status(403).json({ error: 'Forbidden' });
            try { const r = adminAction(req.body); if (r.status) return res.status(r.status).json({ error: r.error }); res.json(r); }
            catch (e) { warn('admin action', e); res.status(500).json({ error: e.message }); }
        });
        app.get('/api/admin/ucomm/words', (req, res) => {
            if (!adminAuthed(req)) return res.status(403).json({ error: 'Forbidden' });
            try { res.json(getWords()); } catch (e) { res.status(500).json({ error: e.message }); }
        });
        app.post('/api/admin/ucomm/words', (req, res) => {
            if (!adminAuthed(req)) return res.status(403).json({ error: 'Forbidden' });
            try { const r = setWords((req.body || {}).words); if (r.status) return res.status(r.status).json({ error: r.error }); res.json(r); }
            catch (e) { res.status(500).json({ error: e.message }); }
        });
    }

    return {
        registerRoutes, enabled,
        setReviewer(fn) { reviewer = typeof fn === 'function' ? fn : reviewTextStub; },
        // 给测试 / 内部用
        episodeDanmaku, postDanmaku, showDanmaku, listComments, listReplies, postComment, like, report, removeOwn,
        adminList, adminAction, getWords, setWords
    };
}

module.exports = { createComments, reviewTextStub, DEF, DEFAULT_WORDS, normMatch, hasLink, cleanText, escHtml };
