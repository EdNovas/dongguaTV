'use strict';
// 📊 观看/分享实测统计 + 站长后台查询(server.js 用;Vercel 的 api/index.js 无状态,只挂 204 桩)。
//
// 为什么重做:旧后台 GET /api/admin/users 同步 JSON.parse 最多 20 万行 user_history 去"估算"时长 → 阻塞事件循环,
//   全站跟着卡、后台永远"加载中";估出来的时长还只是按进度猜的。现在:
//   ① 实测观看:前端 watchMeter 只在"视频真在走 + 页面可见/画中画 + 近 4 小时有过操作"时计秒,按 (剧, 集) 攒批上报。
//      服务器按批次 id 去重(sendBeacon 与下次启动补发必然重复)、每 token 每天封顶 24h(防刷/防挂机灌水)。
//   ② 分享回流:分享链带 s=<分享码>;首页路由按 UA/Referer 认出是谁家 App 打开的(微信/QQ/Telegram…)还是平台在抓预览卡片,
//      打开的人登录后前端再报一次"带来登录"。
//   ③ 站长查询一律 SQL 聚合(GROUP BY),用户聚合结果内存缓存 20s;只有单用户详情里的旧同步历史(≤300 行)才逐行解析。
// 所有入口都吞异常:统计坏了只是少几条数据,绝不能拖垮播放/首页。
const crypto = require('crypto');

const DAY = 86400e3;
const DEF = {
    cacheMs: 20e3,                 // 用户聚合结果缓存(后台连点翻页/筛选不重复扫库)
    maxItems: 60,                  // 每批最多几条 (kind,title,episode)
    maxItemSec: 14400,             // 单条最多 4 小时(前端 60s 一批,这已经很宽)
    dayCap: 86400,                 // 每 token 每天最多计 24h,超出丢弃(挂机/伪造上报)
    dayCapShared: 20 * 86400,      // 主密码是多人共用一个 token → 按 20 人份封顶,否则几个人一起看就被截断
    titleMax: 200,
    epMax: 120,
    batchKeepMs: 3 * DAY,          // 批次 id 保留 3 天(前端 pending 最多 40 批,离线几天回来补发也能去重)
    openDedupMs: 30 * 60e3,        // 同一访客同一分享码 30 分钟内只记一次打开
    maxEventsPerCode: 5000,        // 每个分享码最多存 5000 条事件(防刷爆表;计数存在 share_links.events,不每次 COUNT(*))
    ipEventsPerHour: 30,           // 每 IP 每小时最多新记 30 条打开/预览:/?s=<码> 不用登录、首页不过限流,换 UA 就绕过 30 分钟去重
    ipMapMax: 50000,
    sharePerDay: 300,              // 每 token 每天最多建 300 个分享码
    sharePerDayShared: 20 * 300,   // 主密码多人共用 → 同 dayCapShared 按 20 人份,否则一个人刷满全体主密码用户当天都分享不了
    newKeysPerDay: 400,            // 每 token 每天最多新出现 400 个 (类型, 剧, 集):秒数封顶只限时长不限行数,伪造上报能无限造行/造集数
    newKeysPerDayShared: 20 * 400,
    touchMs: 5 * 60e3,             // 会话恢复写 last_active 的节流
    touchMapMax: 50000,
    doneSec: 120,                  // 一集看满 120 秒(或播到 90% 记 completed)才算"看过这一集"
    doneMinSec: 30,                // completed 标记只在这一集真看过 ≥30s 时才算(防"0 秒 + 看完"刷集数)
    pageDef: 30,
    pageMax: 100,
};
const BATCH_RE = /^[A-Za-z0-9_-]{8,40}$/;
const CODE_RE = /^[A-Za-z0-9]{6,16}$/;
const CHANNELS = new Set(['wechat', 'qq', 'telegram', 'whatsapp', 'facebook', 'x', 'instagram', 'native', 'copy']);
const REQ_STATUS = ['pending', 'need_info', 'fulfilled', 'rejected'];

// 北京时间(UTC+8,无夏令时)切日
const dayKey = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const lastDays = (n, now) => { const a = []; for (let i = n - 1; i >= 0; i--) a.push(dayKey(now - i * DAY)); return a; };
const cleanText = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
// 集名自然序。必须复用一个 Collator:localeCompare(…, 'zh-Hans-CN', opts) 每次比较都重建 ICU collator,
//   2 万集排序要几秒、同步卡住整个服务器;复用后快几十倍
const NAT_COLL = new Intl.Collator('zh-Hans-CN', { numeric: true });
const natCmp = (a, b) => NAT_COLL.compare(String(a), String(b));

// ---------- 来源 / 设备识别(纯函数,测试直接调) ----------
// App 内置浏览器(真人):顺序有讲究 —— 企业微信 UA 也带 MicroMessenger;安卓微信/QQ 的 X5 内核都带 MQQBrowser
const APP_RULES = [
    [/wxwork/i, '企业微信'],
    [/MicroMessenger/i, '微信'],
    [/(^|[^A-Za-z])QQ\/\d/i, 'QQ'],
    [/MQQBrowser|QQBrowser/i, 'QQ浏览器'],
    // 搜狗浏览器(手机 SogouMobileBrowser/SogouMSE、PC MetaSr):server.js 的 isSocialCrawler 按 /sogou/ 把它当爬虫,这里认成真人
    [/SogouMobileBrowser|SogouMSE|MetaSr/i, '搜狗浏览器'],
    [/Weibo/i, '微博'],
    [/DingTalk/i, '钉钉'],
    [/\bLark\/|Feishu/i, '飞书'],
    [/aweme|BytedanceWebview|musical_ly/i, '抖音/TikTok'],
    [/xhsdiscover|XiaoHongShu/i, '小红书'],
    [/baiduboxapp/i, '百度App'],
    [/Telegram(?!Bot)/i, 'Telegram'],
    [/FBAN|FBAV|FB_IAB|FB4A/i, 'Facebook'],
    [/Instagram/i, 'Instagram'],
    [/\bLine\/\d/i, 'LINE'],
    [/Twitter(?!bot)/i, 'X'],
];
// 抓预览卡片的爬虫:TelegramBot 的 UA 是 "TelegramBot (like TwitterBot)" → 必须排在 Twitterbot 前;
//   LINE 的抓取器 UA 里也带 facebookexternalhit → line-poker 排前。CUBOT 是手机牌子,别当成 bot。
const BOT_RULES = [
    [/TelegramBot/i, 'Telegram'],
    [/WhatsApp/i, 'WhatsApp'],
    [/line-poker/i, 'LINE'],
    [/facebookexternalhit|Facebot|meta-externalagent/i, 'Facebook'],
    [/Twitterbot/i, 'X'],
    [/Discordbot/i, 'Discord'],
    [/Slackbot|Slack-ImgProxy/i, 'Slack'],
    [/LinkedInBot/i, 'LinkedIn'],
    [/SkypeUriPreview/i, 'Skype'],
    [/(?<!cu)bot\b|bot\/|spider|crawl|slurp|headless|embedly|pinterest|python-|curl\/|wget|go-http-client|okhttp|axios\/|node-fetch|java\//i, '其它爬虫'],
];
const firstRule = (rules, s) => { for (const [re, name] of rules) if (re.test(s)) return name; return null; };
function appOf(ua) { return ua ? firstRule(APP_RULES, String(ua)) : null; }
function crawlerOf(ua) { return ua ? firstRule(BOT_RULES, String(ua)) : null; }
// Referer 主机 → 来源;自家站点(打开分享页后 JS 跳回 SPA)不算来源
function refererOf(referer, selfHost) {
    let h = '';
    try { h = new URL(String(referer || '')).hostname.toLowerCase(); } catch (e) { return null; }
    if (!h) return null;
    if (selfHost && h === String(selfHost).toLowerCase().replace(/:\d+$/, '')) return null;
    const is = (d) => h === d || h.endsWith('.' + d);
    if (is('t.co') || is('x.com') || is('twitter.com')) return 'X';
    if (is('facebook.com') || is('fb.com') || is('fb.me')) return 'Facebook';
    if (is('instagram.com')) return 'Instagram';
    if (is('t.me') || is('telegram.org') || is('telegram.me')) return 'Telegram';
    if (is('weibo.com') || is('weibo.cn') || is('t.cn')) return '微博';
    if (is('weixin.qq.com') || is('wx.qq.com')) return '微信';
    if (is('qq.com')) return 'QQ';
    if (/(^|\.)google\.[a-z.]+$/.test(h)) return 'Google';
    if (is('baidu.com')) return '百度';
    if (is('bing.com')) return 'Bing';
    return '其它网站';
}
// → '微信' / 'QQ' / 'Telegram' / … / '直接打开'
function sourceOf(ua, referer, selfHost) {
    return appOf(ua) || crawlerOf(ua) || refererOf(referer, selfHost) || '直接打开';
}
function browserOf(ua) {
    if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
    if (/OPR\/|Opera/.test(ua)) return 'Opera';
    if (/SamsungBrowser/.test(ua)) return '三星浏览器';
    if (/UCBrowser|UCWEB/.test(ua)) return 'UC';
    if (/Quark/.test(ua)) return '夸克';
    if (/MiuiBrowser/.test(ua)) return '小米浏览器';
    if (/HuaweiBrowser/.test(ua)) return '华为浏览器';
    if (/Firefox\/|FxiOS/.test(ua)) return 'Firefox';
    if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
    return '';
}
// → 'iPhone · 微信' / 'Windows · Chrome' / 'Android App'(本站 Capacitor 壳 = 安卓 WebView 且不是别家 App)/ '电视' / '其它'
function deviceOf(ua) {
    ua = String(ua || '');
    if (!ua) return '其它';
    const app = appOf(ua);
    let dev;
    if (/SmartTV|SMART-TV|Android TV|GoogleTV|\bAFT[A-Z]|Tizen|Web0S|WebOS|webOS|BRAVIA|HbbTV|NetCast|CrKey|AppleTV|\bTV\b/.test(ua)) dev = '电视';
    else if (/iPad/.test(ua)) dev = 'iPad';
    else if (/iPhone|iPod/.test(ua)) dev = 'iPhone';
    else if (/Android/i.test(ua)) dev = (!app && (/; wv\)/.test(ua) || /Capacitor/i.test(ua))) ? 'Android App' : 'Android';
    else if (/Windows/i.test(ua)) dev = 'Windows';
    else if (/Macintosh|Mac OS X/.test(ua)) dev = 'Mac';
    else if (/Linux|X11|CrOS/.test(ua)) dev = 'Linux';
    else dev = '其它';
    if (dev === 'Android App' || dev === '电视' || dev === '其它') return dev;
    const br = app || browserOf(ua);
    return br ? dev + ' · ' + br : dev;
}
// 求片片名归一化(判"多少人想看同一部"):全半角统一、去空白与标点
const normName = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

// ---------- 表结构(幂等;user_stats/user_history/content_requests 正常由 server.js 建,这里兜底给单测/全新库) ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS watch_stats (
    user_token TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, episode TEXT NOT NULL DEFAULT '',
    seconds INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, first_at INTEGER, last_at INTEGER,
    PRIMARY KEY (user_token, kind, title, episode)
) WITHOUT ROWID;
-- 热门剧/直播榜用的覆盖索引(按用户的查询走主键前缀,不用单独的 user_token 索引):
--   只扫"某类、近 30 天"那一段,不回表。实测 50 万行时单 title 索引要回表 300ms+,这个 <30ms。
CREATE INDEX IF NOT EXISTS idx_ws_recent ON watch_stats(kind, last_at, title, seconds, completed);
-- new_keys:当天新出现的 (类型, 剧, 集) 数,每 token 每天有预算
CREATE TABLE IF NOT EXISTS watch_daily (
    user_token TEXT NOT NULL, day TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, new_keys INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_token, day)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_wd_day ON watch_daily(day, seconds);
CREATE TABLE IF NOT EXISTS stats_batches (id TEXT PRIMARY KEY, user_token TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS idx_sb_at ON stats_batches(at);
-- events:该码已存的事件数(每码上限用它判,不在首页路由上每次 COUNT(*) 扫 5000 条索引)
CREATE TABLE IF NOT EXISTS share_links (
    code TEXT PRIMARY KEY, user_token TEXT NOT NULL, kind TEXT, title TEXT, episode TEXT, t INTEGER, channel TEXT, created_at INTEGER,
    events INTEGER NOT NULL DEFAULT 0
);
-- (user_token, created_at):每天建码上限的计数走索引区间,不再按 user_token 取出全部历史码逐行比时间
DROP INDEX IF EXISTS idx_sl_user;
CREATE INDEX IF NOT EXISTS idx_sl_user_created ON share_links(user_token, created_at);
CREATE INDEX IF NOT EXISTS idx_sl_created ON share_links(created_at);
CREATE TABLE IF NOT EXISTS share_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, at INTEGER, type TEXT, source TEXT, device TEXT,
    visitor TEXT, visitor_token TEXT
);
-- 30 分钟访客去重的覆盖索引(code, type, visitor, at):只读索引不回表;code 前缀也覆盖了原来的 idx_se_code
DROP INDEX IF EXISTS idx_se_code;
CREATE INDEX IF NOT EXISTS idx_se_dedup ON share_events(code, type, visitor, at);
CREATE INDEX IF NOT EXISTS idx_se_at ON share_events(at);
CREATE TABLE IF NOT EXISTS stats_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS user_stats (
    user_token TEXT PRIMARY KEY, label TEXT, first_seen INTEGER, last_login INTEGER, last_active INTEGER,
    banned INTEGER NOT NULL DEFAULT 0, banned_at INTEGER
);
CREATE TABLE IF NOT EXISTS user_history (
    user_token TEXT NOT NULL, item_id TEXT NOT NULL, item_data TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_token, item_id)
);
CREATE TABLE IF NOT EXISTS content_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_token TEXT NOT NULL, user_label TEXT, name TEXT NOT NULL, tmdb_id TEXT,
    poster TEXT, note TEXT, year TEXT, aka TEXT, cast_info TEXT, status TEXT NOT NULL DEFAULT 'pending',
    fulfill_link TEXT, fulfill_note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- 覆盖索引:后台按用户数旧同步历史 + 最近更新时间,只读索引不碰 item_data 大字段
CREATE INDEX IF NOT EXISTS idx_history_user_upd ON user_history(user_token, updated_at);
`;

// 观看 upsert:秒数累加、completed 取大、first_at 保留最早
const SQL_UPSERT_WATCH = `INSERT INTO watch_stats (user_token, kind, title, episode, seconds, completed, first_at, last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_token, kind, title, episode) DO UPDATE SET
        seconds = seconds + excluded.seconds, completed = MAX(completed, excluded.completed),
        first_at = COALESCE(first_at, excluded.first_at), last_at = excluded.last_at`;
const SQL_UPSERT_DAILY = `INSERT INTO watch_daily (user_token, day, seconds, new_keys) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_token, day) DO UPDATE SET seconds = seconds + excluded.seconds, new_keys = new_keys + excluded.new_keys`;
// first_seen 为空(后台封禁时给没记录的 token 插的行)就补上
const SQL_TOUCH_USER = `INSERT INTO user_stats (user_token, first_seen, last_active, last_device, banned) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(user_token) DO UPDATE SET last_active = excluded.last_active,
        first_seen = COALESCE(user_stats.first_seen, excluded.first_seen),
        last_device = COALESCE(excluded.last_device, user_stats.last_device)`;
// "看完"只在这一集真看过 ≥30s 时才算;"看过这一集" = 满 120s 或 看完
const DONE = `(completed = 1 AND seconds >= ${DEF.doneMinSec})`;
const COUNTED = `(seconds >= ${DEF.doneSec} OR ${DONE})`;
const isDone = (r) => !!r.completed && (r.seconds || 0) >= DEF.doneMinSec;

function createUserStats(deps) {
    deps = deps || {};
    const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;
    // 依赖一律在调用时才取(server.js 里 REQ_DB_OK/adminAuthed 定义在注册点之后,构造时碰它们会撞 TDZ)
    const dbOf = () => { try { return deps.db ? (deps.db() || null) : null; } catch (e) { return null; } };
    const tokenInfo = (t) => { try { return (typeof t === 'string' && t && deps.tokenInfo) ? (deps.tokenInfo(t) || null) : null; } catch (e) { return null; } };
    const isBanned = (t) => { try { return !!(deps.isBanned && deps.isBanned(t)); } catch (e) { return false; } };
    const identity = (t, l) => { try { return deps.identity ? deps.identity(t, l) : (l || String(t || '').slice(0, 12)); } catch (e) { return String(t || '').slice(0, 12); } };
    const adminOk = (req) => { try { return !!(deps.adminAuthed && deps.adminAuthed(req)); } catch (e) { return false; } };
    const ipOf = (req) => { try { return String(deps.ipKey ? deps.ipKey(req) : (req.ip || '')); } catch (e) { return ''; } };
    const enabled = () => { try { return !!dbOf() && (deps.enabled ? !!deps.enabled() : true); } catch (e) { return false; } };

    // 日志节流:同一类错误一分钟最多打一条,坏库/坏盘时不刷屏
    const warnAt = {};
    const warn = (tag, e) => { const t = Date.now(); if (!warnAt[tag] || t - warnAt[tag] > 60e3) { warnAt[tag] = t; console.warn('[UserStats] ' + tag + ':', e && e.message || e); } };

    const inited = new WeakSet();
    let stmtDb = null;
    const stmts = new Map();
    let salt = '', since = null;
    function ensure(d) {
        if (inited.has(d)) return;
        d.exec(SCHEMA);
        try { d.exec('ALTER TABLE user_stats ADD COLUMN last_device TEXT'); } catch (e) { /* 列已存在 */ }
        try { d.exec('ALTER TABLE watch_daily ADD COLUMN new_keys INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* 列已存在 */ }
        // 老库补 events 计数列:只在这次 ALTER 成功(=第一次)时按已有事件回填一次
        try {
            d.exec('ALTER TABLE share_links ADD COLUMN events INTEGER NOT NULL DEFAULT 0');
            d.exec('UPDATE share_links SET events = (SELECT COUNT(*) FROM share_events e WHERE e.code = share_links.code)');
        } catch (e) { /* 列已存在 */ }
        const ins = d.prepare('INSERT OR IGNORE INTO stats_meta (k, v) VALUES (?, ?)');
        ins.run('salt', crypto.randomBytes(16).toString('hex'));   // 访客指纹的盐:持久化,重启后 30 分钟去重/独立访客数仍连续
        if (enabled()) ins.run('since', dayKey(nowFn()));
        const meta = {};
        for (const r of d.prepare('SELECT k, v FROM stats_meta').all()) meta[r.k] = r.v;
        salt = meta.salt || '';
        since = meta.since || null;
        inited.add(d);
    }
    const getDb = () => { const d = dbOf(); if (d) ensure(d); return d; };
    const q = (d, sql) => {
        if (d !== stmtDb) { stmts.clear(); stmtDb = d; }
        let s = stmts.get(sql);
        if (!s) { s = d.prepare(sql); stmts.set(sql, s); }
        return s;
    };
    // 启动后尽早建表/建索引(放到下一轮事件循环:此刻 server.js 还没执行完,deps 里的 const 还在 TDZ)
    setImmediate(() => { try { if (dbOf()) getDb(); } catch (e) { warn('schema', e); } });

    function userType(token) {
        if (!token) return 'unknown';
        if (String(token).startsWith('v2board_')) return 'airport';
        const info = tokenInfo(token);
        if (info && info.index === 0) return 'primary';
        if (info && info.index > 0) return 'independent';
        return 'unknown';
    }
    const uaOf = (req) => String((req.headers && req.headers['user-agent']) || '').slice(0, 512);
    // 没有 UA(脚本/测试调用)就不动最近设备,别把'其它'盖上去
    const devOf = (req) => { const ua = req ? uaOf(req) : ''; return ua ? deviceOf(ua) : null; };
    const hostOf = (req) => String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
    const visitorOf = (req, ua) => crypto.createHash('sha256').update(salt + '|' + ipOf(req) + '|' + ua).digest('hex').slice(0, 16);
    // 上报接口(只这三个)认的 token:配置里的密码 / 已注册的机场 token;
    //   外加"以前真登录过(有 last_login 或邮箱 label)且没被封"的机场 token —— 机场 token 只活在内存 PASSWORD_HASH_MAP,
    //   服务器一重启就没了,要等用户下次 /api/auth/v2board/check(前端最长 5 天才查一次)才回来;这期间的观看/分享全被当非法丢掉。
    //   不往 PASSWORD_HASH_MAP 里补注册:别的接口(历史同步/求片)的鉴权不变。
    const V2B_RE = /^v2board_[A-Za-z0-9]{8,128}$/;
    function statsAuth(d, token) {
        if (tokenInfo(token)) return true;
        if (!d || !V2B_RE.test(token)) return false;
        const r = q(d, 'SELECT banned, last_login, label FROM user_stats WHERE user_token = ?').get(token);
        return !!(r && !r.banned && (r.last_login != null || (r.label && String(r.label).trim())));
    }

    // ---------- 写入 ----------
    let lastSweep = 0;
    function sweepBatches(d, now) {
        if (now - lastSweep < 3600e3) return;
        lastSweep = now;
        try { q(d, 'DELETE FROM stats_batches WHERE at < ?').run(now - DEF.batchKeepMs); } catch (e) { warn('sweep', e); }
    }
    function normItems(raw) {
        if (!Array.isArray(raw)) return [];
        const m = new Map();
        for (const x of raw.slice(0, DEF.maxItems)) {
            if (!x || typeof x !== 'object') continue;
            const k = x.k === 'live' ? 'live' : (x.k === 'vod' ? 'vod' : null);
            if (!k) continue;
            const t = cleanText(x.t, DEF.titleMax);
            if (!t) continue;
            const e = k === 'live' ? '' : cleanText(x.e, DEF.epMax);
            let s = Math.round(Number(x.s));
            // 不到 1 秒的条目一律不收:正常前端从不发(watchMeter.flush 里 s<1 就跳过);
            //   以前放过 {s:0,c:1} —— 秒数不涨、日封顶永远不触发,能无限造行/刷"看完集数"
            if (!Number.isFinite(s) || s < 1) continue;
            if (s > DEF.maxItemSec) s = DEF.maxItemSec;
            const c = (x.c === 1 || x.c === true || x.c === '1') ? 1 : 0;
            const key = k + '\u0001' + t + '\u0001' + e;
            const o = m.get(key);
            if (o) { o.s = Math.min(DEF.maxItemSec, o.s + s); o.c = Math.max(o.c, c); }
            else m.set(key, { k, t, e, s, c });
        }
        return [...m.values()];
    }
    function ingestWatch(req, b) {
        const token = typeof b.token === 'string' ? b.token : '';
        const d = getDb();
        if (!statsAuth(d, token)) return { ok: false, error: 'auth' };
        if (isBanned(token)) return { ok: false, banned: true };
        const batch = typeof b.batch === 'string' ? b.batch : '';
        if (!BATCH_RE.test(batch)) return { ok: false, error: 'batch' };
        const items = normItems(b.items);
        if (!items.length) return { ok: true, empty: true };
        const now = nowFn(), day = dayKey(now);
        const shared = userType(token) === 'primary';
        const cap = shared ? DEF.dayCapShared : DEF.dayCap;
        const keyCap = shared ? DEF.newKeysPerDayShared : DEF.newKeysPerDay;
        const dev = devOf(req);
        let out = null;
        d.transaction(() => {
            if (q(d, 'SELECT 1 FROM stats_batches WHERE id = ?').get(batch)) { out = { ok: true, dup: true }; return; }
            const today = q(d, 'SELECT seconds, new_keys FROM watch_daily WHERE user_token = ? AND day = ?').get(token, day) || {};
            let left = Math.max(0, cap - (today.seconds || 0));
            let keysLeft = Math.max(0, keyCap - (today.new_keys || 0));
            // 先挑出能收的条目:秒数日封顶 + 当天"新 (类型, 剧, 集)"预算(已有的行照常累加,不占预算)
            const has = q(d, 'SELECT 1 FROM watch_stats WHERE user_token = ? AND kind = ? AND title = ? AND episode = ?');
            const take = [];
            let added = 0, want = 0, fresh = 0;
            for (const it of items) {
                want += it.s;
                if (left <= 0) continue;
                const isNew = !has.get(token, it.k, it.t, it.e);
                if (isNew && keysLeft <= 0) continue;
                const s = Math.min(it.s, left);
                left -= s; added += s;
                if (isNew) { keysLeft--; fresh++; }
                take.push([it, s]);
            }
            // 一条都收不了(封顶/预算用完):整批丢弃,也不登记批次(否则刷子可以无限灌 stats_batches)
            if (!take.length) { out = { ok: true, capped: true }; return; }
            q(d, 'INSERT INTO stats_batches (id, user_token, at) VALUES (?, ?, ?)').run(batch, token, now);
            const up = q(d, SQL_UPSERT_WATCH);
            for (const [it, s] of take) up.run(token, it.k, it.t, it.e, s, it.c, now, now);
            q(d, SQL_UPSERT_DAILY).run(token, day, added, fresh);
            q(d, SQL_TOUCH_USER).run(token, now, now, dev);
            out = added < want ? { ok: true, capped: true } : { ok: true };
        })();
        sweepBatches(d, now);
        return out;
    }
    function ingestShare(req, b) {
        const token = typeof b.token === 'string' ? b.token : '';
        const d = getDb();
        if (!statsAuth(d, token)) return { ok: false, error: 'auth' };
        if (isBanned(token)) return { ok: false, banned: true };
        const code = typeof b.code === 'string' ? b.code : '';
        if (!CODE_RE.test(code)) return { ok: false, error: 'code' };
        const kind = b.kind === 'live' ? 'live' : 'vod';
        const title = cleanText(b.title, DEF.titleMax);
        if (!title) return { ok: false, error: 'title' };
        const episode = kind === 'live' ? '' : cleanText(b.episode, DEF.epMax);
        let t = Math.round(Number(b.t));
        t = (Number.isFinite(t) && t > 0) ? Math.min(t, 86400) : null;
        const ch = String(b.channel || '').toLowerCase();
        const channel = CHANNELS.has(ch) ? ch : 'other';
        const now = nowFn();
        const lim = userType(token) === 'primary' ? DEF.sharePerDayShared : DEF.sharePerDay;
        const n = q(d, 'SELECT COUNT(*) n FROM share_links WHERE user_token = ? AND created_at > ?').get(token, now - DAY).n;   // idx_sl_user_created 区间
        if (n >= lim) return { ok: false, error: 'limit' };
        const r = q(d, 'INSERT OR IGNORE INTO share_links (code, user_token, kind, title, episode, t, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(code, token, kind, title, episode, t, channel, now);
        if (!r.changes) {
            const own = q(d, 'SELECT user_token FROM share_links WHERE code = ?').get(code);
            if (!own || own.user_token !== token) return { ok: false, error: 'taken' };
            return { ok: true, dup: true };
        }
        q(d, SQL_TOUCH_USER).run(token, now, now, devOf(req));
        return { ok: true };
    }
    // 记一条分享事件(每码 5000 条上限 / 30 分钟访客去重 / 登录事件每 (码, token) 一次)。码不存在 → false
    function addEvent(d, ev) {
        let added = false;
        d.transaction(() => {
            const link = q(d, 'SELECT events FROM share_links WHERE code = ?').get(ev.code);
            if (!link || (link.events || 0) >= DEF.maxEventsPerCode) return;
            if (ev.type === 'login') {
                if (q(d, "SELECT 1 FROM share_events WHERE code = ? AND type = 'login' AND visitor_token = ? LIMIT 1").get(ev.code, ev.visitor_token)) return;
            } else if (q(d, 'SELECT 1 FROM share_events WHERE code = ? AND type = ? AND visitor = ? AND at > ? LIMIT 1').get(ev.code, ev.type, ev.visitor, ev.at - DEF.openDedupMs)) return;
            q(d, 'INSERT INTO share_events (code, at, type, source, device, visitor, visitor_token) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(ev.code, ev.at, ev.type, ev.source, ev.device, ev.visitor, ev.visitor_token || null);
            q(d, 'UPDATE share_links SET events = events + 1 WHERE code = ?').run(ev.code);
            added = true;
        })();
        return added;
    }
    function ingestShareOpen(req, b) {
        const token = typeof b.token === 'string' ? b.token : '';
        const d = getDb();
        if (!statsAuth(d, token)) return { ok: false, error: 'auth' };
        if (isBanned(token)) return { ok: false, banned: true };
        const code = typeof b.code === 'string' ? b.code : '';
        if (!CODE_RE.test(code)) return { ok: false, error: 'code' };
        const link = q(d, 'SELECT user_token FROM share_links WHERE code = ?').get(code);
        if (!link) return { ok: false, error: 'unknown' };
        // 分享者自己点开自己的链接不算。主密码例外:它是多人共用一个 token,同用主密码的朋友登录进来 token 也"等于"分享者 ——
        //   照记,每 (码, token) 仍只记一次
        if (link.user_token === token && userType(token) !== 'primary') return { ok: true, self: true };
        const ua = uaOf(req);
        const added = addEvent(d, {
            code, at: nowFn(), type: 'login',
            source: sourceOf(ua, req.headers && req.headers.referer, hostOf(req)),
            device: deviceOf(ua), visitor: visitorOf(req, ua), visitor_token: token
        });
        return added ? { ok: true } : { ok: true, dup: true };
    }
    // 每 IP 每小时最多新记 ipEventsPerHour 条打开/预览(固定窗口,内存 Map 有上限):首页不过 /api 限流、不用登录,
    //   换 UA 就是新访客 → 不限的话一个 IP 能把任何人的分享刷到 5000 条上限,之后真打开一条都记不上
    const ipEv = new Map();
    const ipLive = (e, now) => e && now - e.start < 3600e3;
    function ipSpend(ip, now) {
        let e = ipEv.get(ip);
        if (!ipLive(e, now)) {
            if (!e && ipEv.size >= DEF.ipMapMax) {
                for (const [k, v] of ipEv) if (!ipLive(v, now)) ipEv.delete(k);
                if (ipEv.size >= DEF.ipMapMax) ipEv.clear();
            }
            e = { start: now, n: 0 };
            ipEv.set(ip, e);
        }
        e.n++;
    }
    // 首页路由收到 ?s=<分享码> 时调用(同步、几次走索引的小查询;任何异常都吞掉,绝不影响页面返回)
    //   预览/打开只按本模块的 crawlerOf 判:server.js 的 isSocialCrawler 为了给微信/QQ/微博/搜狗出 OG 卡片页,把这些【真人】浏览器也算进去了,
    //   拿它判会把真人打开记成"其它爬虫"预览。第二个参数(旧的 {preview})不再使用。
    function recordShareOpen(req) {
        try {
            if (!enabled()) return false;
            const code = String((req.query && req.query.s) || '');
            if (!CODE_RE.test(code)) return false;
            const now = nowFn(), ip = ipOf(req);
            const cur = ipEv.get(ip);
            if (ipLive(cur, now) && cur.n >= DEF.ipEventsPerHour) return false;   // 超预算:连库都不碰
            const d = getDb();
            const ua = uaOf(req);
            const bot = crawlerOf(ua);
            const ref = req.headers && (req.headers.referer || req.headers.referrer);
            const added = addEvent(d, {
                code, at: now,
                type: bot ? 'preview' : 'open',
                source: bot || sourceOf(ua, ref, hostOf(req)),
                device: bot ? null : deviceOf(ua),
                visitor: visitorOf(req, ua)
            });
            if (added) ipSpend(ip, now);
            return added;
        } catch (e) { warn('share-open', e); return false; }
    }
    // 会话恢复(/api/auth/verify 带 passwordHash)也算一次活跃:同 token 5 分钟内只写一次
    const touchAt = new Map();
    function touchVisit(token, req) {
        try {
            if (!tokenInfo(token)) return false;
            const now = nowFn();
            const last = touchAt.get(token);
            if (last && now - last < DEF.touchMs) return false;
            const d = getDb();
            if (!d) return false;
            if (touchAt.size >= DEF.touchMapMax) touchAt.clear();
            touchAt.set(token, now);
            q(d, SQL_TOUCH_USER).run(token, now, now, devOf(req));
            return true;
        } catch (e) { warn('touch', e); return false; }
    }

    // ---------- 站长查询(纯 SQL 聚合) ----------
    let usersCache = null, overviewCache = null;
    function invalidate() { usersCache = null; overviewCache = null; }
    const maxOf = (...a) => { let m = null; for (const v of a) if (v != null && (m == null || v > m)) m = v; return m; };
    function blankRow(token) {
        return {
            token, identity: '', type: 'unknown', banned: false, banned_at: null,
            watch_seconds: 0, live_seconds: 0, episodes: 0, episodes_done: 0, shows: 0, active_days_30: 0,
            last_watch_at: null, last_title: null, last_episode: null, last_kind: null,
            first_seen: null, last_login: null, last_active: null, last_device: null,
            shares: 0, share_opens: 0, share_logins: 0, requests: 0, legacy_shows: 0
        };
    }
    function buildUsers(d) {
        const now = nowFn();
        const m = new Map(), aux = new Map();
        const row = (tk) => {
            let r = m.get(tk);
            if (!r) { r = blankRow(tk); m.set(tk, r); aux.set(tk, { label: '', reqLabel: '', active: null, histLast: null, watched: false }); }
            return r;
        };
        for (const s of q(d, 'SELECT user_token, label, first_seen, last_login, last_active, last_device, banned, banned_at FROM user_stats').all()) {
            if (!s.user_token) continue;
            const r = row(s.user_token), a = aux.get(s.user_token);
            a.label = s.label || ''; a.active = s.last_active || null;
            r.first_seen = s.first_seen || null; r.last_login = s.last_login || null; r.last_device = s.last_device || null;
            r.banned = !!s.banned; r.banned_at = s.banned_at || null;
        }
        // 只有一个 MAX() 聚合 → SQLite 保证裸列 title/episode/kind 取自 last_at 最大的那一行(= 最近在看)
        for (const w of q(d, `SELECT user_token, MAX(last_at) la, title, episode, kind,
                SUM(seconds) secs,
                SUM(CASE WHEN kind = 'live' THEN seconds ELSE 0 END) live,
                SUM(CASE WHEN kind = 'vod' AND ${COUNTED} THEN 1 ELSE 0 END) eps,
                SUM(CASE WHEN kind = 'vod' AND ${DONE} THEN 1 ELSE 0 END) done,
                COUNT(DISTINCT CASE WHEN kind = 'vod' AND ${COUNTED} THEN title END) shows
                FROM watch_stats GROUP BY user_token`).all()) {
            if (!w.user_token) continue;
            const r = row(w.user_token);
            aux.get(w.user_token).watched = true;
            r.watch_seconds = w.secs || 0; r.live_seconds = w.live || 0;
            r.episodes = w.eps || 0; r.episodes_done = w.done || 0; r.shows = w.shows || 0;
            r.last_watch_at = w.la || null; r.last_title = w.title || null; r.last_episode = w.episode || ''; r.last_kind = w.kind || null;
        }
        for (const a of q(d, 'SELECT user_token, COUNT(*) n FROM watch_daily WHERE day >= ? GROUP BY user_token').all(dayKey(now - 29 * DAY))) {
            if (a.user_token) row(a.user_token).active_days_30 = a.n;
        }
        for (const h of q(d, 'SELECT user_token, COUNT(*) n, MAX(updated_at) la FROM user_history GROUP BY user_token').all()) {
            if (!h.user_token) continue;
            row(h.user_token).legacy_shows = h.n;
            aux.get(h.user_token).histLast = h.la || null;
        }
        for (const c of q(d, `SELECT user_token, COUNT(*) n, MAX(CASE WHEN user_label IS NOT NULL AND user_label != '' THEN user_label END) lbl
                FROM content_requests GROUP BY user_token`).all()) {
            if (!c.user_token) continue;
            row(c.user_token).requests = c.n;
            aux.get(c.user_token).reqLabel = c.lbl || '';
        }
        for (const s of q(d, 'SELECT user_token, COUNT(*) n FROM share_links GROUP BY user_token').all()) {
            if (s.user_token) row(s.user_token).shares = s.n;
        }
        for (const s of q(d, `SELECT l.user_token, SUM(CASE WHEN e.type = 'open' THEN 1 ELSE 0 END) opens,
                COUNT(DISTINCT CASE WHEN e.type = 'login' THEN e.visitor_token END) logins
                FROM share_events e JOIN share_links l ON l.code = e.code GROUP BY l.user_token`).all()) {
            if (!s.user_token) continue;
            const r = row(s.user_token);
            r.share_opens = s.opens || 0; r.share_logins = s.logins || 0;
        }
        const rows = [];
        for (const r of m.values()) {
            const a = aux.get(r.token);
            r.identity = identity(r.token, a.label || a.reqLabel || '');
            r.type = userType(r.token);
            r.last_active = maxOf(a.active, r.last_watch_at, a.histLast);
            r._never = !a.watched && !r.legacy_shows;
            rows.push(r);
        }
        return { at: Date.now(), rows, map: m };
    }
    function getUsers(d) {
        if (usersCache && Date.now() - usersCache.at < DEF.cacheMs) return usersCache;
        usersCache = buildUsers(d);
        return usersCache;
    }
    const pub = (r) => { const o = Object.assign({}, r); delete o._never; return o; };

    const SORTS = {
        last_active: 'last_active', last_login: 'last_login', watch: 'watch_seconds', episodes: 'episodes', shows: 'shows',
        last_watch: 'last_watch_at', first_seen: 'first_seen', shares: 'shares', share_opens: 'share_opens', requests: 'requests'
    };
    function listUsers(d, query) {
        const now = nowFn();
        const { rows } = getUsers(d);
        const type = String(query.type || 'all');
        const status = String(query.status || 'all');
        const qs = String(query.q || '').trim().toLowerCase();
        const within = (ts, days) => ts != null && now - ts < days * DAY;
        const list = rows.filter(r => {
            if (type !== 'all' && r.type !== type) return false;
            switch (status) {
                case 'active1': if (!within(r.last_active, 1)) return false; break;
                case 'active7': if (!within(r.last_active, 7)) return false; break;
                case 'active30': if (!within(r.last_active, 30)) return false; break;
                case 'dormant': if (within(r.last_active, 30)) return false; break;
                case 'never': if (!r._never) return false; break;
                case 'banned': if (!r.banned) return false; break;
                case 'requests': if (!r.requests) return false; break;
                case 'shares': if (!r.shares) return false; break;
            }
            if (qs && !String(r.identity || '').toLowerCase().includes(qs) && !String(r.token).toLowerCase().includes(qs)) return false;
            return true;
        });
        const key = SORTS[query.sort] || 'last_active';
        const dir = String(query.order || 'desc') === 'asc' ? 1 : -1;
        // 空值永远排最后(不随升降序翻转);同值按最近活跃、再按 token 稳定排序
        const cmpNull = (a, b, d0) => (a == null && b == null) ? 0 : (a == null ? 1 : (b == null ? -1 : d0 * (a - b)));
        list.sort((a, b) => cmpNull(a[key], b[key], dir) || cmpNull(a.last_active, b.last_active, -1) || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
        let size = parseInt(query.size, 10);
        if (!(size > 0)) size = DEF.pageDef;
        size = Math.min(size, DEF.pageMax);
        let page = parseInt(query.page, 10);
        if (!(page > 0)) page = 1;
        return { stats_available: true, tracking_enabled: enabled(), total: list.length, page, size, users: list.slice((page - 1) * size, page * size).map(pub) };
    }

    function emptyOverview() {
        return {
            stats_available: false, tracking_enabled: false, tracking_since: null,
            users: { total: 0, by_type: { independent: 0, primary: 0, airport: 0, unknown: 0 }, active_1d: 0, active_7d: 0, active_30d: 0, new_7d: 0, banned: 0 },
            watch: { today_seconds: 0, d7_seconds: 0, d30_seconds: 0, total_seconds: 0, live_seconds: 0, episodes: 0, shows: 0 },
            daily: [], top_shows: [], top_live: [],
            shares: { total: 0, d30: 0, opens: 0, uniq_visitors: 0, logins: 0, previews: 0, by_channel: {}, by_source: {} },
            requests: { total: 0, pending: 0, need_info: 0, fulfilled: 0, rejected: 0 }
        };
    }
    function buildOverview(d) {
        const now = nowFn();
        const o = emptyOverview();
        o.stats_available = true;
        o.tracking_enabled = enabled();
        const { rows } = getUsers(d);
        const u = o.users;
        u.total = rows.length;
        for (const r of rows) {
            u.by_type[r.type] = (u.by_type[r.type] || 0) + 1;
            if (r.last_active != null) {
                const age = now - r.last_active;
                if (age < DAY) u.active_1d++;
                if (age < 7 * DAY) u.active_7d++;
                if (age < 30 * DAY) u.active_30d++;
            }
            if (r.first_seen != null && now - r.first_seen < 7 * DAY) u.new_7d++;
            if (r.banned) u.banned++;
        }
        const days = lastDays(30, now);
        const per = new Map();
        for (const x of q(d, 'SELECT day, SUM(seconds) s, COUNT(*) u FROM watch_daily WHERE day >= ? GROUP BY day').all(days[0])) per.set(x.day, x);
        o.daily = days.map(day => ({ day, seconds: (per.get(day) || {}).s || 0, users: (per.get(day) || {}).u || 0 }));
        const w = o.watch;
        w.today_seconds = o.daily[o.daily.length - 1].seconds;
        w.d7_seconds = o.daily.slice(-7).reduce((s, x) => s + x.seconds, 0);
        w.d30_seconds = o.daily.reduce((s, x) => s + x.seconds, 0);
        const t = q(d, `SELECT SUM(seconds) total, SUM(CASE WHEN kind = 'live' THEN seconds ELSE 0 END) live,
                SUM(CASE WHEN kind = 'vod' AND ${COUNTED} THEN 1 ELSE 0 END) eps,
                COUNT(DISTINCT CASE WHEN kind = 'vod' AND ${COUNTED} THEN title END) shows FROM watch_stats`).get() || {};
        w.total_seconds = t.total || 0; w.live_seconds = t.live || 0; w.episodes = t.eps || 0; w.shows = t.shows || 0;
        const since30 = now - 30 * DAY;
        // 热门剧/直播:只统计近 30 天还在看的 (人, 集) 行 —— 秒数/人数/集次(人×集,达到"看过"口径)都是这些行的累计。
        //   不用"整部剧历史总量 + HAVING 近 30 天":那样一部老剧最近有一个人点开,就会带着全部历史时长冲上榜首;也走不了索引区间。
        o.top_shows = q(d, `SELECT title, SUM(seconds) seconds, COUNT(DISTINCT user_token) users,
                SUM(CASE WHEN ${COUNTED} THEN 1 ELSE 0 END) episodes
                FROM watch_stats WHERE kind = 'vod' AND last_at >= ? GROUP BY title ORDER BY seconds DESC LIMIT 15`).all(since30);
        o.top_live = q(d, `SELECT title, SUM(seconds) seconds, COUNT(DISTINCT user_token) users
                FROM watch_stats WHERE kind = 'live' AND last_at >= ? GROUP BY title ORDER BY seconds DESC LIMIT 8`).all(since30);
        const sl = q(d, 'SELECT COUNT(*) total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) d30 FROM share_links').get(since30) || {};
        const se = q(d, `SELECT SUM(CASE WHEN type = 'open' THEN 1 ELSE 0 END) opens,
                COUNT(DISTINCT CASE WHEN type = 'open' THEN visitor END) uniq,
                SUM(CASE WHEN type = 'login' THEN 1 ELSE 0 END) logins,
                SUM(CASE WHEN type = 'preview' THEN 1 ELSE 0 END) previews FROM share_events`).get() || {};
        const sh = o.shares;
        sh.total = sl.total || 0; sh.d30 = sl.d30 || 0;
        sh.opens = se.opens || 0; sh.uniq_visitors = se.uniq || 0; sh.logins = se.logins || 0; sh.previews = se.previews || 0;
        for (const x of q(d, 'SELECT channel, COUNT(*) n FROM share_links GROUP BY channel ORDER BY n DESC').all()) sh.by_channel[x.channel || 'other'] = x.n;
        for (const x of q(d, "SELECT source, COUNT(*) n FROM share_events WHERE type = 'open' GROUP BY source ORDER BY n DESC").all()) sh.by_source[x.source || '未知'] = x.n;
        for (const x of q(d, 'SELECT status, COUNT(*) n FROM content_requests GROUP BY status').all()) {
            o.requests.total += x.n;
            if (Object.prototype.hasOwnProperty.call(o.requests, x.status) && x.status !== 'total') o.requests[x.status] = x.n;
        }
        const minDay = (q(d, 'SELECT MIN(day) d FROM watch_daily').get() || {}).d || null;
        o.tracking_since = since || minDay;
        return o;
    }

    // 分享明细:每条分享的打开/去重访客/登录/预览 + 来源分布 + 带来登录的用户
    function shareItems(d, links, umap) {
        if (!links.length) return [];
        const codes = JSON.stringify(links.map(l => l.code));
        const by = new Map();
        for (const l of links) {
            by.set(l.code, {
                code: l.code, kind: l.kind || 'vod', title: l.title || '', episode: l.episode || '', t: l.t || null,
                channel: l.channel || 'other', created_at: l.created_at || null,
                opens: 0, uniq: 0, logins: 0, previews: 0, sources: {}, preview_sources: {}, login_users: []
            });
        }
        const IN = 'code IN (SELECT value FROM json_each(?))';
        for (const a of q(d, `SELECT code, type, source, COUNT(*) n FROM share_events WHERE ${IN} GROUP BY code, type, source`).all(codes)) {
            const o = by.get(a.code);
            if (!o) continue;
            const src = a.source || '未知';
            if (a.type === 'open') { o.opens += a.n; o.sources[src] = (o.sources[src] || 0) + a.n; }
            else if (a.type === 'preview') { o.previews += a.n; o.preview_sources[src] = (o.preview_sources[src] || 0) + a.n; }
            else if (a.type === 'login') o.logins += a.n;
        }
        for (const a of q(d, `SELECT code, COUNT(DISTINCT visitor) u FROM share_events WHERE type = 'open' AND ${IN} GROUP BY code`).all(codes)) {
            const o = by.get(a.code);
            if (o) o.uniq = a.u;
        }
        for (const a of q(d, `SELECT code, visitor_token FROM share_events WHERE type = 'login' AND ${IN} ORDER BY at`).all(codes)) {
            const o = by.get(a.code);
            if (!o || !a.visitor_token || o.login_users.length >= 50) continue;
            const r = umap.get(a.visitor_token);
            o.login_users.push(r ? r.identity : identity(a.visitor_token, ''));
        }
        return links.map(l => by.get(l.code));
    }
    // 旧同步历史的估算时长(只在单用户详情里用,≤300 行):前面整集 + 当前集进度 —— 仍是估算,前端标"估"
    function estSeconds(dd) {
        const pt = Number(dd.progressTime) || 0, pd = Number(dd.progressDuration) || 0;
        const em = String(dd.episode || '').match(/(\d+)/);
        const idx = em ? parseInt(em[1], 10) : 1;
        let secs = pt;
        if (idx > 1 && pd > 0 && pd < 86400) secs = (idx - 1) * pd + pt;
        return (secs > 0 && secs < 200 * 86400) ? Math.round(secs) : 0;
    }
    function userDetail(d, token) {
        const now = nowFn();
        const { map } = getUsers(d);
        let user = map.get(token);
        if (user) user = pub(user);
        else { user = blankRow(token); user.identity = identity(token, ''); user.type = userType(token); }
        const showMap = new Map();
        for (const r of q(d, 'SELECT kind, title, episode, seconds, completed, first_at, last_at FROM watch_stats WHERE user_token = ? LIMIT 20000').all(token)) {
            const k = r.kind + '\u0001' + r.title;
            let s = showMap.get(k);
            if (!s) { s = { title: r.title, kind: r.kind, seconds: 0, episodes: 0, episodes_done: 0, first_at: null, last_at: null, eps: [] }; showMap.set(k, s); }
            s.seconds += r.seconds || 0;
            const done = isDone(r);   // 与 SQL 的 DONE/COUNTED 同口径
            if (r.kind === 'vod' && ((r.seconds || 0) >= DEF.doneSec || done)) s.episodes++;
            if (r.kind === 'vod' && done) s.episodes_done++;
            if (r.first_at != null && (s.first_at == null || r.first_at < s.first_at)) s.first_at = r.first_at;
            if (r.last_at != null && (s.last_at == null || r.last_at > s.last_at)) s.last_at = r.last_at;
            s.eps.push({ episode: r.episode || '', seconds: r.seconds || 0, completed: done ? 1 : 0, last_at: r.last_at || null });
        }
        const shows = [...showMap.values()].sort((a, b) => (b.last_at || 0) - (a.last_at || 0));
        for (const s of shows) s.eps.sort((a, b) => natCmp(a.episode, b.episode));
        const days = lastDays(60, now);
        const per = new Map(q(d, 'SELECT day, seconds FROM watch_daily WHERE user_token = ? AND day >= ?').all(token, days[0]).map(x => [x.day, x.seconds]));
        const daily = days.map(day => ({ day, seconds: per.get(day) || 0 }));
        const links = q(d, 'SELECT * FROM share_links WHERE user_token = ? ORDER BY created_at DESC LIMIT 100').all(token);
        const shares = shareItems(d, links, map);
        const requests = q(d, 'SELECT * FROM content_requests WHERE user_token = ? ORDER BY created_at DESC LIMIT 200').all(token);
        const history = q(d, 'SELECT item_id, item_data, updated_at FROM user_history WHERE user_token = ? ORDER BY updated_at DESC LIMIT 300').all(token).map(r => {
            let dd = {};
            try { dd = JSON.parse(r.item_data) || {}; } catch (e) { }
            return {
                name: dd.name || r.item_id, episode: dd.episode || null, progress: dd.progress || 0,
                progressTime: dd.progressTime || 0, progressDuration: dd.progressDuration || 0,
                updated_at: r.updated_at, est_seconds: estSeconds(dd)
            };
        });
        return { stats_available: true, user, shows, daily, shares, requests, history };
    }
    function listShares(d, query) {
        let size = parseInt(query.size, 10);
        if (!(size > 0)) size = DEF.pageDef;
        size = Math.min(size, DEF.pageMax);
        let page = parseInt(query.page, 10);
        if (!(page > 0)) page = 1;
        const channel = String(query.channel || '').trim();
        const source = String(query.source || '').trim();
        const ch = channel && channel !== 'all' ? channel : '';
        const src = source && source !== 'all' ? source : '';
        const where = `WHERE (? = '' OR channel = ?) AND (? = '' OR code IN (SELECT code FROM share_events WHERE type = 'open' AND source = ?))`;
        const total = q(d, `SELECT COUNT(*) n FROM share_links ${where}`).get(ch, ch, src, src).n;
        const links = q(d, `SELECT * FROM share_links ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(ch, ch, src, src, size, (page - 1) * size);
        const { map } = getUsers(d);
        const items = shareItems(d, links, map);
        items.forEach((it, i) => {
            const tk = links[i].user_token;
            const r = map.get(tk);
            it.sharer_token = tk;
            it.sharer_identity = r ? r.identity : identity(tk, '');
            it.sharer_type = userType(tk);
        });
        return { stats_available: true, total, page, size, shares: items };
    }
    function listRequests(d, query) {
        const now = nowFn();
        const counts = { all: 0, pending: 0, need_info: 0, fulfilled: 0, rejected: 0 };
        for (const x of q(d, 'SELECT status, COUNT(*) n FROM content_requests GROUP BY status').all()) {
            counts.all += x.n;
            if (REQ_STATUS.includes(x.status)) counts[x.status] = x.n;
        }
        // "多少人想看":同 tmdb_id 或归一化片名(两者取并集,含自己)
        const byTmdb = new Map(), byName = new Map();
        const push = (mp, k, id) => { let a = mp.get(k); if (!a) { a = []; mp.set(k, a); } a.push(id); };
        for (const r of q(d, 'SELECT id, tmdb_id, name FROM content_requests ORDER BY id DESC LIMIT 20000').all()) {
            const t = String(r.tmdb_id || '').trim();
            if (t) push(byTmdb, t, r.id);
            const n = normName(r.name);
            if (n) push(byName, n, r.id);
        }
        const status = String(query.status || 'all');
        const rows = REQ_STATUS.includes(status)
            ? q(d, 'SELECT * FROM content_requests WHERE status = ? ORDER BY created_at DESC LIMIT 5000').all(status)
            : q(d, 'SELECT * FROM content_requests ORDER BY created_at DESC LIMIT 5000').all();
        const qs = String(query.q || '').trim().toLowerCase();
        const list = [];
        for (const r of rows) {
            r.identity = identity(r.user_token, r.user_label);
            if (qs && ![r.name, r.aka, r.user_label, r.identity, r.cast_info].some(v => String(v || '').toLowerCase().includes(qs))) continue;
            r.user_type = userType(r.user_token);
            const t = String(r.tmdb_id || '').trim(), n = normName(r.name);
            const ids = new Set([...(t ? byTmdb.get(t) || [] : []), ...(n ? byName.get(n) || [] : [])]);
            ids.add(r.id);
            r.dup_count = ids.size;
            const open = r.status === 'pending' || r.status === 'need_info';
            const end = open ? now : (r.updated_at || now);
            r.wait_days = r.created_at ? Math.max(0, Math.floor((end - r.created_at) / DAY)) : 0;
            list.push(r);
        }
        const sort = String(query.sort || 'new');
        const rank = (r) => (r.status === 'pending' || r.status === 'need_info') ? 0 : 1;
        if (sort === 'hot') list.sort((a, b) => (b.dup_count - a.dup_count) || ((b.created_at || 0) - (a.created_at || 0)));
        else if (sort === 'old') list.sort((a, b) => (rank(a) - rank(b)) || ((a.created_at || 0) - (b.created_at || 0)));
        else list.sort((a, b) => (rank(a) - rank(b)) || ((b.created_at || 0) - (a.created_at || 0)));
        return { stats_available: true, counts, requests: list.slice(0, 500) };
    }
    function bulkRequests(d, b) {
        const raw = Array.isArray(b.ids) ? b.ids : [];
        const ids = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && n > 0))];
        if (!ids.length) return { status: 400, body: { ok: false, error: 'Missing ids' } };
        if (ids.length > 200) return { status: 400, body: { ok: false, error: 'Too many ids (max 200)' } };
        const action = String(b.action || '');
        // 可选"预期当前状态"(expect 或 from;字符串或数组;'all'/空 = 不限):只改仍处于该状态的行。
        //   防"全选 + 批量"把刚单条处理过(已离开该状态、但卡片还留在列表里)的求片又改掉/删掉
        let expect = b.expect != null ? b.expect : b.from;
        if (expect === '' || expect === 'all') expect = null;
        if (expect != null) {
            const list = (Array.isArray(expect) ? expect : [expect]).map(String);
            if (!list.length || !list.every(s => REQ_STATUS.includes(s))) return { status: 400, body: { ok: false, error: 'Bad expect' } };
            expect = JSON.stringify([...new Set(list)]);
        }
        const IN = 'id IN (SELECT value FROM json_each(?))';
        const GUARD = ' AND (? IS NULL OR status IN (SELECT value FROM json_each(?)))';
        const idsJson = JSON.stringify(ids);
        let changed = 0;
        if (action === 'delete') {
            changed = q(d, `DELETE FROM content_requests WHERE ${IN}${GUARD}`).run(idsJson, expect, expect || '[]').changes;
        } else if (REQ_STATUS.includes(action)) {
            // 只在传了链接/说明时才覆盖(批量标状态不该把各条已填的链接清空)
            const link = typeof b.fulfill_link === 'string' ? b.fulfill_link.slice(0, 2000) : null;
            const note = typeof b.fulfill_note === 'string' ? b.fulfill_note.slice(0, 500) : null;
            changed = q(d, `UPDATE content_requests SET status = ?, fulfill_link = COALESCE(?, fulfill_link), fulfill_note = COALESCE(?, fulfill_note), updated_at = ? WHERE ${IN}${GUARD}`)
                .run(action, link, note, nowFn(), idsJson, expect, expect || '[]').changes;
        } else return { status: 400, body: { ok: false, error: 'Bad action' } };
        invalidate();
        // skipped = 没改到的(状态已变/已删/不存在),前端可据此提示
        return { status: 200, body: { ok: true, changed, skipped: ids.length - changed } };
    }

    // ---------- 路由 ----------
    // sendBeacon 兜底:Content-Type 可能是 text/plain(或 Blob 类型被丢);全局 bodyParser.json 没解析过的,自己读 ≤64KB 再 JSON.parse
    function rawJson(req, res, next) {
        if (req._body || (req.body && typeof req.body === 'object' && Object.keys(req.body).length)) return next();
        const chunks = [];
        let size = 0, done = false;
        const finish = (body) => { if (done) return; done = true; req.body = body; next(); };
        req.on('data', (c) => {
            if (done) return;
            size += c.length;
            if (size > 64 * 1024) { done = true; res.status(413).json({ ok: false, error: 'too_large' }); req.resume(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (done) return;
            let b = {};
            try { b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') || {}; } catch (e) { b = {}; }
            finish(typeof b === 'object' ? b : {});
        });
        req.on('error', () => finish({}));
    }
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    // 上报接口:未启用 → 204;参数/令牌不对 → 200 {ok:false}(前端收到 2xx 就丢掉这批,不会无限重发);库异常 → 503 让前端留着下次再发(批次 id 去重)
    function ingestRoute(fn) {
        return (req, res) => {
            noStore(res);
            if (!enabled()) return res.status(204).end();
            try { res.json(fn(req, (req.body && typeof req.body === 'object') ? req.body : {})); }
            catch (e) { warn('ingest', e); res.status(503).json({ ok: false, retry: true }); }
        };
    }
    function adminRoute(fn, empty) {
        return (req, res) => {
            noStore(res);
            if (!adminOk(req)) return res.status(403).json({ error: 'Forbidden' });
            let d = null;
            try { d = getDb(); } catch (e) { warn('schema', e); }
            if (!d) return res.json(empty(req));
            try { fn(d, req, res); }
            catch (e) { warn('admin', e); if (!res.headersSent) res.status(500).json({ error: 'Database error', message: String(e && e.message || e).slice(0, 200) }); }
        };
    }
    const pageOf = (req) => { const p = parseInt(req.query.page, 10); return p > 0 ? p : 1; };
    const sizeOf = (req) => { const s = parseInt(req.query.size, 10); return Math.min(s > 0 ? s : DEF.pageDef, DEF.pageMax); };

    function registerRoutes(app) {
        app.post('/api/stats/watch', rawJson, ingestRoute(ingestWatch));
        app.post('/api/stats/share', rawJson, ingestRoute(ingestShare));
        app.post('/api/stats/share-open', rawJson, ingestRoute(ingestShareOpen));

        app.get('/api/admin/overview', adminRoute((d, req, res) => {
            if (!overviewCache || Date.now() - overviewCache.at >= DEF.cacheMs) overviewCache = { at: Date.now(), data: buildOverview(d) };
            res.json(overviewCache.data);
        }, () => emptyOverview()));
        app.get('/api/admin/users', adminRoute((d, req, res) => res.json(listUsers(d, req.query || {})),
            (req) => ({ stats_available: false, tracking_enabled: false, total: 0, page: pageOf(req), size: sizeOf(req), users: [] })));
        app.get('/api/admin/user', adminRoute((d, req, res) => {
            const token = String(req.query.token || '');
            if (!token) return res.status(400).json({ error: 'Missing token' });
            res.json(userDetail(d, token));
        }, () => ({ stats_available: false, user: null, shows: [], daily: [], shares: [], requests: [], history: [] })));
        app.get('/api/admin/shares', adminRoute((d, req, res) => res.json(listShares(d, req.query || {})),
            (req) => ({ stats_available: false, total: 0, page: pageOf(req), size: sizeOf(req), shares: [] })));
        app.get('/api/admin/requests', adminRoute((d, req, res) => res.json(listRequests(d, req.query || {})),
            () => ({ stats_available: false, counts: { all: 0, pending: 0, need_info: 0, fulfilled: 0, rejected: 0 }, requests: [] })));
        app.post('/api/admin/requests/bulk', adminRoute((d, req, res) => {
            const r = bulkRequests(d, req.body || {});
            res.status(r.status).json(r.body);
        }, () => ({ ok: false, error: 'SQLite not available' })));
    }

    return { registerRoutes, recordShareOpen, touchVisit, userType, invalidate, enabled, _ensureSchema: () => { const d = dbOf(); if (d) ensure(d); return !!d; } };
}

module.exports = { createUserStats, sourceOf, deviceOf, appOf, crawlerOf, normName, dayKey, DEF };
