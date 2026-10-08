// 观看/分享统计 + 站长后台接口回归:node scripts/user-stats-test.mjs
//  ① lib/user-stats 单元(假时钟 + SQLite 内存库 + 假 app 直接调路由):sourceOf/deviceOf/userType、上报去重/封顶/校验、
//     分享码/打开/预览/登录事件(30 分钟去重、5000 条上限)、touchVisit 节流、后台聚合/筛选/排序/分页/缓存/求片批量
//  ②b 对抗审查修复:机场 token 重启后上报、主密码分享登录、搜狗/预览判定、0 秒条目与每日新键预算、?s= 每 IP 预算 + 计数列 + 覆盖索引、
//     2 万集自然序耗时、主密码建码上限、批量预期状态、老库迁移(events 回填/new_keys/索引替换)
//  ② 端到端:临时目录起真正的 server.js(CACHE_TYPE=sqlite,三个密码 + ADMIN_TOKEN),走真实 HTTP:
//     上报(JSON + text/plain、重复批次、封顶、非法/封禁 token)、分享 + 微信/Telegram 打开首页、share-open、
//     每个 /api/admin/* 的结构与数字、403、300 用户 × 50 集时 /api/admin/users 冷启动 <300ms、STATS_DISABLE
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };   // worktree 没有 node_modules 时走 NODE_PATH
const Database = dep('better-sqlite3');
const US = require(path.join(ROOT, 'lib/user-stats'));
const { createUserStats, sourceOf, deviceOf, crawlerOf, dayKey, DEF } = US;

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 600) : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAYMS = 86400e3;

const UA = {
    winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    iPadSafari: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    iPhoneWx: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003127) NetType/WIFI Language/zh_CN',
    androidWx: 'Mozilla/5.0 (Linux; Android 13; V2185A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160065 MMWEBSDK/20231202 MMWEBID/2247 MicroMessenger/8.0.47.2560(0x28002F30) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
    wxwork: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 wxwork/4.1.22 MicroMessenger/7.0.1 Language/zh ColorScheme/Light',
    androidQQ: 'Mozilla/5.0 (Linux; Android 12; PEGM00 Build/SKQ1.210216.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.72 MQQBrowser/6.2 TBS/046295 Mobile Safari/537.36 V1_AND_SQ_8.9.58_4108_YYB_D A_8095800 QQ/8.9.58.11175 NetType/WIFI WebP/0.3.0 AppId/537155547',
    mqqBrowser: 'Mozilla/5.0 (Linux; U; Android 13; zh-cn; 22081212C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.86 MQQBrowser/14.3 Mobile Safari/537.36',
    weibo: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Weibo (iPhone15,2__weibo__14.6.2__iphone__os17.5)',
    dingtalk: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AliApp(DingTalk/7.5.0) com.laiwang.DingTalk/1',
    lark: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Lark/7.10.5 Chrome/112.0.5615.165 Safari/537.36 LarkLocale/zh_CN',
    douyin: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 aweme_29.3.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/zh',
    xhs: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 xhsdiscover/8.40 NetType/WiFi',
    baidu: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SP-engine/2.94.0 main%2F1.0 baiduboxapp/13.62.0.10 (Baidu; P2 17.5)',
    tgApp: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 Telegram-Android/11.2.2 (Google Pixel 8; Android 14; SDK 34; HIGH)',
    fb: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/476.0.0.36.104;FBBV/123]',
    ig: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 345.0.4.20.86 (iPhone15,2; iOS 17_5; zh_CN)',
    line: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.12.0',
    tgBot: 'TelegramBot (like TwitterBot)',
    waBot: 'WhatsApp/2.24.20.80 A',
    fbBot: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    lineBot: 'facebookexternalhit/1.1;line-poker/1.0',
    twBot: 'Twitterbot/1.0',
    dcBot: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    slackBot: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    liBot: 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    skype: 'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5',
    google: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    cubot: 'Mozilla/5.0 (Linux; Android 10; CUBOT X30 Build/QP1A.190711.020) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    androidApp: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36',
    linuxFx: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    tizen: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36',
    webos: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager',
    fireTv: 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
};

// ---------------- ① 单元 ----------------
console.log('① 纯函数 sourceOf / deviceOf');
{
    const S = (ua, ref, self) => sourceOf(ua, ref, self);
    const cases = [
        [UA.iPhoneWx, '微信'], [UA.androidWx, '微信'], [UA.wxwork, '企业微信'], [UA.androidQQ, 'QQ'], [UA.mqqBrowser, 'QQ浏览器'],
        [UA.weibo, '微博'], [UA.dingtalk, '钉钉'], [UA.lark, '飞书'], [UA.douyin, '抖音/TikTok'], [UA.xhs, '小红书'], [UA.baidu, '百度App'],
        [UA.tgApp, 'Telegram'], [UA.fb, 'Facebook'], [UA.ig, 'Instagram'], [UA.line, 'LINE'],
        [UA.tgBot, 'Telegram'], [UA.waBot, 'WhatsApp'], [UA.fbBot, 'Facebook'], [UA.lineBot, 'LINE'], [UA.twBot, 'X'], [UA.dcBot, 'Discord'],
        [UA.slackBot, 'Slack'], [UA.liBot, 'LinkedIn'], [UA.skype, 'Skype'], [UA.google, '其它爬虫'],
    ];
    for (const [ua, want] of cases) ok(S(ua, '') === want, `sourceOf UA → ${want}`, S(ua, ''));
    const refs = [
        ['https://t.co/abc', 'X'], ['https://x.com/u/status/1', 'X'], ['https://www.facebook.com/', 'Facebook'], ['https://l.instagram.com/?u=1', 'Instagram'],
        ['https://web.telegram.org/k/', 'Telegram'], ['https://t.me/s/ch', 'Telegram'], ['https://weibo.com/123', '微博'], ['https://weixin.qq.com/x', '微信'],
        ['https://mail.qq.com/', 'QQ'], ['https://www.google.com.hk/', 'Google'], ['https://www.baidu.com/s?wd=1', '百度'], ['https://cn.bing.com/', 'Bing'],
        ['https://reddit.com/r/x', '其它网站'], ['', '直接打开'], ['not a url', '直接打开'],
    ];
    for (const [ref, want] of refs) ok(S(UA.winChrome, ref) === want, `sourceOf Referer ${ref || '(空)'} → ${want}`, S(UA.winChrome, ref));
    ok(S(UA.winChrome, 'https://my.site/?play=1', 'my.site:443') === '直接打开', '自家站点 Referer 不算来源');
    ok(S(UA.iPhoneWx, 'https://t.co/x') === '微信', 'App 内置浏览器优先于 Referer');
    ok(crawlerOf(UA.cubot) === null && S(UA.cubot, '') === '直接打开', 'CUBOT 手机不被当成爬虫');
    ok(crawlerOf(UA.iPhoneWx) === null && crawlerOf(UA.androidQQ) === null && crawlerOf(UA.weibo) === null, '微信/QQ/微博真人不是爬虫');
    const devs = [
        [UA.iPhoneWx, 'iPhone · 微信'], [UA.winChrome, 'Windows · Chrome'], [UA.winEdge, 'Windows · Edge'], [UA.macSafari, 'Mac · Safari'],
        [UA.iPadSafari, 'iPad · Safari'], [UA.androidChrome, 'Android · Chrome'], [UA.androidApp, 'Android App'], [UA.androidWx, 'Android · 微信'],
        [UA.linuxFx, 'Linux · Firefox'], [UA.tizen, '电视'], [UA.webos, '电视'], [UA.fireTv, '电视'], ['', '其它'], ['SomethingWeird/1.0', '其它'],
    ];
    for (const [ua, want] of devs) ok(deviceOf(ua) === want, `deviceOf → ${want}`, deviceOf(ua));
    ok(dayKey(Date.UTC(2026, 9, 6, 16, 30)) === '2026-10-07' && dayKey(Date.UTC(2026, 9, 6, 15, 59)) === '2026-10-06', '按北京时间切日');
}

// 假 app:收集路由,直接调 handler 链
function mkApp() {
    const routes = new Map();
    const reg = (m) => (p, ...hs) => { routes.set(m + ' ' + p, hs); };
    return { routes, get: reg('GET'), post: reg('POST') };
}
async function call(app, method, p, o) {
    o = o || {};
    const hs = app.routes.get(method + ' ' + p);
    if (!hs) throw new Error('no route ' + method + ' ' + p);
    const req = { method, body: o.body || {}, query: o.query || {}, headers: Object.assign({ 'user-agent': UA.winChrome, host: 'my.site' }, o.headers || {}), _body: true };
    const res = {
        statusCode: 200, body: undefined, headers: {}, headersSent: false,
        status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; },
        json(x) { this.body = x; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; }
    };
    let i = 0;
    const next = () => { const h = hs[i++]; if (h) return h(req, res, next); };
    await next();
    return res;
}

console.log('② lib/user-stats 存储与后台查询(内存库 + 假时钟)');
{
    let T = Date.UTC(2026, 9, 7, 4, 0, 0);   // 北京时间 12:00
    const db = new Database(':memory:');
    const tk = { main: sha('mainpw'), alice: sha('alice'), bob: sha('bob'), carol: sha('carol'), air: 'v2board_abcdef0123456789' };
    const MAP = { [tk.main]: { index: 0 }, [tk.alice]: { index: 1 }, [tk.bob]: { index: 2 }, [tk.carol]: { index: 3 }, [tk.air]: { index: -1 } };
    const NAMES = { [tk.main]: 'mainpw', [tk.alice]: 'alice', [tk.bob]: 'bob', [tk.carol]: 'carol' };
    let enabledFlag = true;
    const st = createUserStats({
        db: () => db,
        enabled: () => enabledFlag,
        tokenInfo: (t) => Object.prototype.hasOwnProperty.call(MAP, t) ? MAP[t] : null,
        isBanned: (t) => { const r = db.prepare('SELECT banned FROM user_stats WHERE user_token = ?').get(t); return !!(r && r.banned); },
        identity: (t, l) => l || (NAMES[t] ? '独立密码: ' + NAMES[t] : String(t).slice(0, 12)),
        adminAuthed: (req) => req.headers['x-admin-token'] === 'adm',
        ipKey: (req) => req.headers['x-ip'] || '9.9.9.9',
        now: () => T,
    });
    ok(st._ensureSchema() === true, '建表成功');
    st._ensureSchema();   // 幂等
    const app = mkApp();
    st.registerRoutes(app);
    ok(['POST /api/stats/watch', 'POST /api/stats/share', 'POST /api/stats/share-open', 'GET /api/admin/overview', 'GET /api/admin/users', 'GET /api/admin/user',
        'GET /api/admin/shares', 'GET /api/admin/requests', 'POST /api/admin/requests/bulk'].every(k => app.routes.has(k)), '全部路由已注册');
    ok(st.userType(tk.main) === 'primary' && st.userType(tk.alice) === 'independent' && st.userType(tk.air) === 'airport' && st.userType('deadbeef') === 'unknown' && st.userType('') === 'unknown', 'userType 四类');

    const W = (token, batch, items, headers) => call(app, 'POST', '/api/stats/watch', { body: { token, batch, items }, headers });
    let r = await W(tk.alice, 'batch-0001', [{ k: 'vod', t: '剧A', e: '第1集', s: 600, c: 1 }, { k: 'vod', t: '剧A', e: '第2集', s: 100, c: 0 }, { k: 'live', t: 'CCTV-1', e: '不该存', s: 300 }]);
    ok(r.statusCode === 200 && r.body.ok === true && !r.body.dup, '上报成功', r.body);
    r = await W(tk.alice, 'batch-0001', [{ k: 'vod', t: '剧A', e: '第1集', s: 600, c: 1 }]);
    ok(r.body.ok === true && r.body.dup === true, '重复批次 → dup', r.body);
    const ws = (t, k, title, ep) => db.prepare('SELECT * FROM watch_stats WHERE user_token = ? AND kind = ? AND title = ? AND episode = ?').get(t, k, title, ep);
    ok(ws(tk.alice, 'vod', '剧A', '第1集').seconds === 600 && ws(tk.alice, 'vod', '剧A', '第1集').completed === 1, '重复批次不重复计秒');
    ok(ws(tk.alice, 'live', 'CCTV-1', '') && ws(tk.alice, 'live', 'CCTV-1', '').seconds === 300, '直播 episode 存空串');
    ok(db.prepare('SELECT seconds FROM watch_daily WHERE user_token = ? AND day = ?').get(tk.alice, dayKey(T)).seconds === 1000, 'watch_daily 累计 1000s');
    const us = db.prepare('SELECT * FROM user_stats WHERE user_token = ?').get(tk.alice);
    ok(us && us.first_seen === T && us.last_active === T && us.last_device === 'Windows · Chrome', 'user_stats 插入 first_seen/last_active/last_device', us);

    // 校验
    ok((await W('nope', 'batch-0002', [{ k: 'vod', t: 'x', e: '1', s: 5 }])).body.ok === false, '非法 token → ok:false');
    ok((await W(tk.alice, 'bad id!', [{ k: 'vod', t: 'x', e: '1', s: 5 }])).body.ok === false, '非法批次 id → ok:false');
    ok((await W(tk.alice, 'short', [{ k: 'vod', t: 'x', e: '1', s: 5 }])).body.ok === false, '批次 id 太短 → ok:false');
    ok((await W(tk.alice, 'batch-0003', [{ k: 'zzz', t: 'x', s: 5 }, { k: 'vod', t: '', s: 5 }, { k: 'vod', t: 'y', s: 0 }])).body.empty === true, '全是无效条目 → empty');
    T += 1000;
    r = await W(tk.alice, 'batch-0004', [
        { k: 'vod', t: 'T'.repeat(300), e: 'E'.repeat(200), s: 99999 },
        { k: 'vod', t: '剧B', e: '第2集', s: 30 }, { k: 'vod', t: '剧B', e: '第2集', s: 40 },
        ...Array.from({ length: 70 }, (_, i) => ({ k: 'vod', t: '刷子', e: 'e' + i, s: 1 }))
    ]);
    ok(r.body.ok === true, '超长/超量批次被截断后照收', r.body);
    const long = db.prepare("SELECT title, episode, seconds FROM watch_stats WHERE title LIKE 'TTT%'").get();
    ok(long && long.title.length === 200 && long.episode.length === 120 && long.seconds === 14400, '剧名截 200、集名截 120、单条 4 小时封顶', long);
    ok(ws(tk.alice, 'vod', '剧B', '第2集').seconds === 70, '同批同集合并', ws(tk.alice, 'vod', '剧B', '第2集'));
    ok(db.prepare("SELECT COUNT(*) n FROM watch_stats WHERE title = '刷子'").get().n === 57, '每批最多 60 条', db.prepare("SELECT COUNT(*) n FROM watch_stats WHERE title = '刷子'").get().n);

    // 每天封顶
    const bobItems = (n) => Array.from({ length: n }, (_, i) => ({ k: 'vod', t: '挂机剧', e: '第' + (i + 1) + '集', s: 14400 }));
    r = await W(tk.bob, 'bob-batch-1', bobItems(7));
    ok(r.body.ok === true && r.body.capped === true, '独立用户一天超 24h → capped', r.body);
    const bobDay = () => db.prepare('SELECT seconds FROM watch_daily WHERE user_token = ? AND day = ?').get(tk.bob, dayKey(T)).seconds;
    ok(bobDay() === 86400, '当天封顶 86400s', bobDay());
    r = await W(tk.bob, 'bob-batch-2', bobItems(1));
    ok(r.body.capped === true && !db.prepare("SELECT 1 FROM stats_batches WHERE id = 'bob-batch-2'").get(), '已封顶的批次整批丢弃、不登记批次');
    r = await W(tk.main, 'main-batch-1', bobItems(7));
    ok(r.body.ok === true && !r.body.capped && db.prepare('SELECT seconds FROM watch_daily WHERE user_token = ?').get(tk.main).seconds === 100800, '主密码(多人共用)封顶更高', r.body);
    T += DAYMS;
    r = await W(tk.bob, 'bob-batch-3', [{ k: 'vod', t: '挂机剧', e: '第1集', s: 100 }]);
    ok(r.body.ok === true && !r.body.capped && bobDay() === 100, '第二天重新计', bobDay());
    ok(ws(tk.bob, 'vod', '挂机剧', '第1集').seconds === 14500 && ws(tk.bob, 'vod', '挂机剧', '第1集').first_at === T - DAYMS, 'first_at 保留最早、秒数累加');

    // 封禁
    db.prepare('UPDATE user_stats SET banned = 1, banned_at = ? WHERE user_token = ?').run(T, tk.bob);
    r = await W(tk.bob, 'bob-batch-4', [{ k: 'vod', t: '挂机剧', e: '第9集', s: 100 }]);
    ok(r.body.ok === false && r.body.banned === true, '封禁 token → ok:false banned');

    // 未启用 → 204
    enabledFlag = false;
    r = await W(tk.alice, 'batch-dis-1', [{ k: 'vod', t: 'x', e: '1', s: 5 }]);
    ok(r.statusCode === 204 && r.body === undefined, '未启用 → 204');
    ok(st.recordShareOpen({ query: { s: 'whatever1' }, headers: {} }, {}) === false, '未启用不记分享打开');
    enabledFlag = true;

    // 批次 3 天后清理
    T += 4 * DAYMS;
    await W(tk.carol, 'carol-batch-1', [{ k: 'vod', t: '剧C', e: '第1集', s: 10 }]);
    ok(!db.prepare("SELECT 1 FROM stats_batches WHERE id = 'batch-0001'").get() && db.prepare("SELECT 1 FROM stats_batches WHERE id = 'carol-batch-1'").get(), '超过 3 天的批次 id 被清理');

    // 分享
    const SH = (token, code, extra) => call(app, 'POST', '/api/stats/share', { body: Object.assign({ token, code, channel: 'wechat', kind: 'vod', title: '剧A', episode: '第1集', t: 30 }, extra || {}) });
    ok((await SH(tk.alice, 'ab')).body.ok === false, '分享码太短 → ok:false');
    ok((await SH(tk.alice, 'abc-def-12')).body.ok === false, '分享码含非法字符 → ok:false');
    ok((await SH('nope', 'Code0001')).body.ok === false, '分享非法 token → ok:false');
    ok((await SH(tk.alice, 'Code0001')).body.ok === true, '分享登记');
    ok((await SH(tk.alice, 'Code0001')).body.dup === true, '同人同码 → dup');
    ok((await SH(tk.carol, 'Code0001')).body.error === 'taken', '别人占用的码 → taken');
    ok((await SH(tk.alice, 'Code0002', { channel: 'telegram', kind: 'live', title: 'CCTV-5', episode: '忽略', t: -3 })).body.ok === true, '直播分享');
    ok((await SH(tk.alice, 'Code0003', { channel: 'weird' })).body.ok === true, '未知渠道照收');
    const link2 = db.prepare("SELECT * FROM share_links WHERE code = 'Code0002'").get();
    const link3 = db.prepare("SELECT * FROM share_links WHERE code = 'Code0003'").get();
    ok(link2.kind === 'live' && link2.episode === '' && link2.t === null && link3.channel === 'other', '直播 episode 为空/负时间丢弃/未知渠道归 other', [link2, link3]);

    // 打开/预览
    const open = (code, ua, ip, opts, ref) => st.recordShareOpen({ query: { s: code }, headers: Object.assign({ 'user-agent': ua, 'x-ip': ip, host: 'my.site' }, ref ? { referer: ref } : {}) }, opts || {});
    ok(open('Code0001', UA.iPhoneWx, '1.1.1.1', { preview: true }) === true, '微信真人(isSocialCrawler=true)也记为打开');
    ok(open('Code0001', UA.iPhoneWx, '1.1.1.1', { preview: false }) === false, '同访客 30 分钟内不重复(爬虫页 → SPA 跳转)');
    ok(open('Code0001', UA.iPhoneWx, '1.1.1.2', { preview: false }) === true, '换 IP = 新访客');
    ok(open('Code0001', UA.tgBot, '5.5.5.5', { preview: true }) === true, 'TelegramBot 记预览');
    ok(open('Code0001', UA.google, '5.5.5.6', { preview: false }) === true, 'SPA 分支来的 Googlebot 也记预览(不当真人)');
    ok(open('Code0001', UA.winChrome, '2.2.2.2', {}, 'https://t.co/xyz') === true, 'Chrome + t.co Referer');
    ok(open('NoSuchCode1', UA.winChrome, '2.2.2.3', {}) === false, '不存在的分享码不记');
    ok(open('<script>', UA.winChrome, '2.2.2.3', {}) === false, '非法分享码不记');
    ok(open('Code0001', 'facebookexternalhit/1.1', '6.6.6.6', { preview: true }) === true && open('Code0001', 'facebookexternalhit/1.1', '6.6.6.6', { preview: true }) === false, '预览也按访客 30 分钟去重');
    const evs = db.prepare("SELECT type, source, device FROM share_events WHERE code = 'Code0001' ORDER BY id").all();
    ok(JSON.stringify(evs.map(e => [e.type, e.source])) === JSON.stringify([['open', '微信'], ['open', '微信'], ['preview', 'Telegram'], ['preview', '其它爬虫'], ['open', 'X'], ['preview', 'Facebook']]), '事件类型/来源', evs);
    ok(evs[0].device === 'iPhone · 微信' && evs[2].device === null, '真人记设备,预览不记');
    T += 31 * 60e3;
    ok(open('Code0001', UA.iPhoneWx, '1.1.1.1', {}) === true, '30 分钟后同访客再记');

    // share-open(登录)
    const SO = (token, code, ua) => call(app, 'POST', '/api/stats/share-open', { body: { token, code }, headers: { 'user-agent': ua || UA.iPhoneWx } });
    ok((await SO(tk.carol, 'Code0001')).body.ok === true, '别人登录 → 记 login');
    ok((await SO(tk.carol, 'Code0001')).body.dup === true, '同 (码, token) 只记一次');
    ok((await SO(tk.alice, 'Code0001')).body.self === true, '分享者本人不记');
    ok((await SO(tk.main, 'NoSuch0001')).body.ok === false, '未知分享码 → ok:false');
    ok((await SO('nope', 'Code0001')).body.ok === false, '非法 token → ok:false');
    ok((await SO(tk.main, 'Code0001')).body.ok === true, '主密码登录也记');
    const lg = db.prepare("SELECT visitor_token, source FROM share_events WHERE code = 'Code0001' AND type = 'login' ORDER BY id").all();
    ok(lg.length === 2 && lg[0].visitor_token === tk.carol && lg[0].source === '微信', 'login 事件带 visitor_token/source', lg);

    // 5000 条上限(看 share_links.events 计数列,不再每次 COUNT(*))
    const evCnt = (code) => [db.prepare('SELECT events FROM share_links WHERE code = ?').get(code).events, db.prepare('SELECT COUNT(*) n FROM share_events WHERE code = ?').get(code).n];
    ok(evCnt('Code0001')[0] === evCnt('Code0001')[1] && evCnt('Code0001')[0] === 9, '事件计数列与实际事件数一致(打开/预览/登录都算)', evCnt('Code0001'));
    db.prepare("UPDATE share_links SET events = ? WHERE code = 'Code0003'").run(DEF.maxEventsPerCode);
    ok(open('Code0003', UA.winChrome, '7.7.7.7', {}) === false && evCnt('Code0003')[1] === 0, '每码 5000 条事件封顶');
    db.prepare("UPDATE share_links SET events = 0 WHERE code = 'Code0003'").run();

    // touchVisit 节流
    ok(st.touchVisit(tk.carol, { headers: { 'user-agent': UA.androidApp } }) === true, 'touchVisit 首次写');
    ok(db.prepare('SELECT last_device FROM user_stats WHERE user_token = ?').get(tk.carol).last_device === 'Android App', 'touchVisit 记设备');
    ok(st.touchVisit(tk.carol, { headers: {} }) === false, '5 分钟内不再写');
    T += 5 * 60e3 + 1;
    ok(st.touchVisit(tk.carol, { headers: {} }) === true, '5 分钟后再写');
    ok(st.touchVisit('constructor', { headers: {} }) === false && st.touchVisit('nope', { headers: {} }) === false, '非法 token 不写');
    ok(db.prepare('SELECT last_device FROM user_stats WHERE user_token = ?').get(tk.carol).last_device === 'Android App', '没 UA 时保留旧设备');

    // 旧同步历史 + 求片 + 机场/未知用户
    db.prepare('INSERT INTO user_history (user_token, item_id, item_data, updated_at) VALUES (?, ?, ?, ?)')
        .run(tk.alice, 'h1', JSON.stringify({ name: '旧剧', episode: '第3集', progressTime: 600, progressDuration: 2400, progress: 25 }), T - 10 * DAYMS);
    db.prepare('INSERT INTO user_history (user_token, item_id, item_data, updated_at) VALUES (?, ?, ?, ?)').run('legacyonly', 'h1', '{bad json', T - 40 * DAYMS);
    const insReq = db.prepare(`INSERT INTO content_requests (user_token, user_label, name, tmdb_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const rq = {
        a: insReq.run(tk.alice, '', '流浪地球', '535167', 'pending', T - 3 * DAYMS, T - 3 * DAYMS).lastInsertRowid,
        b: insReq.run(tk.main, '', '流浪 地球！', '', 'pending', T - 2 * DAYMS, T - 2 * DAYMS).lastInsertRowid,
        c: insReq.run('unknowntoken01', 'someone@mail.com', '流浪地球2', '535167', 'need_info', T - DAYMS, T - DAYMS).lastInsertRowid,
        d: insReq.run(tk.main, '', '三体', '', 'fulfilled', T - 5 * DAYMS, T - 4 * DAYMS).lastInsertRowid,
        e: insReq.run(tk.carol, '', '三体', '', 'pending', T - 1000, T - 1000).lastInsertRowid,
    };
    db.prepare('INSERT INTO user_stats (user_token, label, first_seen, last_login, last_active, banned) VALUES (?, ?, ?, ?, ?, 0)').run(tk.air, 'pilot@air.com', T - 60 * DAYMS, T - 50 * DAYMS, T - 45 * DAYMS);

    const A = (p, query, hdr) => call(app, 'GET', p, { query, headers: hdr === undefined ? { 'x-admin-token': 'adm' } : hdr });
    for (const p of ['/api/admin/overview', '/api/admin/users', '/api/admin/user', '/api/admin/shares', '/api/admin/requests']) {
        ok((await A(p, { token: tk.alice }, {})).statusCode === 403, p + ' 无令牌 403');
    }
    ok((await call(app, 'POST', '/api/admin/requests/bulk', { body: { ids: [1], action: 'delete' } })).statusCode === 403, 'bulk 无令牌 403');

    st.invalidate();
    let ul = (await A('/api/admin/users', { size: '100' })).body;
    const byTok = (list) => Object.fromEntries(list.users.map(u => [u.token, u]));
    let U = byTok(ul);
    ok(ul.stats_available === true && ul.total === 7, '用户全集 = user_stats ∪ watch ∪ history ∪ 求片 ∪ 分享(7 人)', ul.users.map(u => u.identity));
    const al = U[tk.alice];
    ok(al && al.watch_seconds === 600 + 100 + 300 + 14400 + 70 + 57 && al.live_seconds === 300, 'alice 时长(含直播)/直播时长', al);
    ok(al.episodes === 2 && al.episodes_done === 1 && al.shows === 2, 'alice 集数(≥120s 或看完)/看完数/剧数(剧A + 超长剧名)', al);
    ok(al.legacy_shows === 1 && al.requests === 1 && al.shares === 3 && al.share_opens === 4 && al.share_logins === 2, 'alice 旧历史/求片/分享/打开/带来登录', al);
    ok(al.type === 'independent' && al.identity === '独立密码: alice' && al.last_device === 'Windows · Chrome', 'alice 类型/身份/设备', al);
    ok(U[tk.bob].banned === true && U[tk.bob].watch_seconds === 86400 + 100 && U[tk.bob].episodes === 6 && U[tk.bob].active_days_30 === 2, 'bob 封禁/封顶后的时长/集数/活跃天数', U[tk.bob]);
    ok(U[tk.air].type === 'airport' && U[tk.air].identity === 'pilot@air.com', '机场用户 + label 身份');
    ok(U.unknowntoken01 && U.unknowntoken01.type === 'unknown' && U.unknowntoken01.identity === 'someone@mail.com' && U.unknowntoken01.requests === 1, '只有求片的未知用户(身份取求片 label)');
    ok(U.legacyonly && U.legacyonly.legacy_shows === 1 && U.legacyonly.last_active === T - 40 * DAYMS, '只有旧同步历史的用户,last_active 取历史时间');
    ok(!Object.keys(al).some(k => k.startsWith('_')), 'ROW 不带内部字段');
    const ROW_KEYS = ['token', 'identity', 'type', 'banned', 'banned_at', 'watch_seconds', 'live_seconds', 'episodes', 'episodes_done', 'shows', 'active_days_30',
        'last_watch_at', 'last_title', 'last_episode', 'first_seen', 'last_login', 'last_active', 'last_device', 'shares', 'share_opens', 'share_logins', 'requests', 'legacy_shows'];
    ok(ROW_KEYS.every(k => k in al), 'ROW 字段齐全', ROW_KEYS.filter(k => !(k in al)));

    // 缓存:新数据 20s 内不出现,invalidate 后出现
    await W(tk.carol, 'carol-batch-2', [{ k: 'vod', t: '剧C', e: '第2集', s: 500 }]);
    ok(byTok((await A('/api/admin/users', { size: '100' })).body)[tk.carol].watch_seconds === 10, '20s 缓存内不重扫');
    st.invalidate();
    ok(byTok((await A('/api/admin/users', { size: '100' })).body)[tk.carol].watch_seconds === 510, 'invalidate 后重算');

    // 排序/筛选/分页
    const order = async (query) => (await A('/api/admin/users', Object.assign({ size: '100' }, query))).body.users.map(u => u.token);
    let o = await order({ sort: 'watch' });
    ok(o[0] === tk.main && o[1] === tk.bob && o[2] === tk.alice, '按观看时长降序', o.slice(0, 3));
    o = await order({ sort: 'watch', order: 'asc' });
    ok(o[o.length - 1] === tk.main, '升序', o);
    o = await order({ sort: 'last_login', order: 'asc' });
    ok(o[0] === tk.air && o.slice(1).every(t => t !== tk.air), '空值永远排最后(升序时有值的在前)', o);
    o = await order({ sort: 'last_login' });
    ok(o[0] === tk.air, '降序也只把有值的排前');
    o = await order({ sort: 'episodes' });
    ok(o[0] === tk.main && o[1] === tk.bob && o[2] === tk.alice, '按集数');
    o = await order({ sort: 'requests' });
    ok(o[0] === tk.main, '按求片数(主密码 2 条)');
    o = await order({ sort: 'share_opens' });
    ok(o[0] === tk.alice, '按分享带来打开');
    o = await order({ type: 'independent' });
    ok(o.length === 3 && [tk.alice, tk.bob, tk.carol].every(t => o.includes(t)), '类型筛选:独立密码', o);
    o = await order({ type: 'airport' });
    ok(o.length === 1 && o[0] === tk.air, '类型筛选:机场');
    o = await order({ status: 'banned' });
    ok(o.length === 1 && o[0] === tk.bob, '状态:已封禁');
    o = await order({ status: 'never' });
    ok(o.length === 2 && o.includes(tk.air) && o.includes('unknowntoken01'), '状态:从未观看(无实测也无旧历史)', o);
    o = await order({ status: 'dormant' });
    ok(o.length === 3 && o.includes(tk.air) && o.includes('legacyonly') && o.includes('unknowntoken01'), '状态:沉睡 30 天+(从没活跃记录的也算)', o);
    o = await order({ status: 'active1' });
    ok(o.includes(tk.alice) && o.includes(tk.carol) && !o.includes(tk.air), '状态:今日活跃', o);
    o = await order({ status: 'requests' });
    ok(o.length === 4, '状态:有求片', o);
    o = await order({ status: 'shares' });
    ok(o.length === 1 && o[0] === tk.alice, '状态:有分享');
    o = await order({ q: 'ALICE' });
    ok(o.length === 1 && o[0] === tk.alice, '搜索身份(不区分大小写)');
    o = await order({ q: tk.bob.slice(5, 15) });
    ok(o.length === 1 && o[0] === tk.bob, '搜索 token 子串');
    let pg = (await A('/api/admin/users', { size: '3', page: '3' })).body;
    ok(pg.total === 7 && pg.page === 3 && pg.size === 3 && pg.users.length === 1, '分页', [pg.total, pg.page, pg.size, pg.users.length]);
    pg = (await A('/api/admin/users', { size: '1000' })).body;
    ok(pg.size === 100, 'size 最大 100');

    // 用户详情
    const ud = (await A('/api/admin/user', { token: tk.alice })).body;
    ok(ud.user && ud.user.token === tk.alice && ud.user.watch_seconds === al.watch_seconds, '详情 user = ROW');
    const showA = ud.shows.find(s => s.title === '剧A');
    ok(showA && showA.seconds === 700 && showA.episodes === 1 && showA.episodes_done === 1 && showA.eps.map(e => e.episode).join() === '第1集,第2集', '详情:剧A 时长/集数/逐集', showA);
    const showB = ud.shows.find(s => s.title === '剧B');
    ok(showB && showB.episodes === 0 && showB.eps[0].seconds === 70, '不满 120s 的集不算看过');
    ok(ud.shows.find(s => s.kind === 'live' && s.title === 'CCTV-1'), '直播也在看过列表里(kind=live)');
    ok(ud.shows.every((s, i, a) => i === 0 || (a[i - 1].last_at || 0) >= (s.last_at || 0)), '按最后观看降序');
    ok(ud.daily.length === 60 && ud.daily[59].day === dayKey(T) && ud.daily.some(x => x.seconds > 0), '近 60 天每日(补 0)');
    const sh1 = ud.shares.find(s => s.code === 'Code0001');
    ok(sh1 && sh1.opens === 4 && sh1.uniq === 3 && sh1.previews === 3 && sh1.logins === 2, '分享:打开/去重/预览/登录', sh1);
    ok(sh1.sources['微信'] === 3 && sh1.sources.X === 1 && sh1.preview_sources.Telegram === 1 && sh1.preview_sources.Facebook === 1, '分享:来源分布', sh1);
    ok(sh1.login_users.join() === '独立密码: carol,独立密码: mainpw', '分享:带来登录的用户', sh1.login_users);
    ok(ud.shares.length === 3 && ud.shares[0].created_at >= ud.shares[2].created_at, '分享按时间降序');
    ok(ud.requests.length === 1 && ud.requests[0].name === '流浪地球', '详情:求片');
    ok(ud.history.length === 1 && ud.history[0].name === '旧剧' && ud.history[0].est_seconds === 5400, '详情:旧同步历史 + 估算时长', ud.history);
    const lo = (await A('/api/admin/user', { token: 'legacyonly' })).body;
    ok(lo.history.length === 1 && lo.history[0].name === 'h1' && lo.history[0].est_seconds === 0, '坏 JSON 的历史不崩');
    const nobody = (await A('/api/admin/user', { token: 'never-seen' })).body;
    ok(nobody.user && nobody.user.watch_seconds === 0 && nobody.shows.length === 0, '不存在的用户给空 ROW');
    ok((await A('/api/admin/user', {})).statusCode === 400, '缺 token → 400');

    // 概览(先塞一部 40 天前看的老剧:不该进热门)
    db.prepare('INSERT INTO watch_stats (user_token, kind, title, episode, seconds, completed, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(tk.carol, 'vod', '老剧', '第1集', 50, 0, T - 40 * DAYMS, T - 40 * DAYMS);
    const ov = (await A('/api/admin/overview', {})).body;
    ok(ov.stats_available === true && ov.users.total === 7, '概览:用户总数');
    ok(ov.users.by_type.independent === 3 && ov.users.by_type.primary === 1 && ov.users.by_type.airport === 1 && ov.users.by_type.unknown === 2, '概览:按类型', ov.users.by_type);
    ok(ov.users.banned === 1 && ov.users.active_30d === 4 && ov.users.new_7d === 4, '概览:封禁/30日活跃/7日新增', ov.users);
    ok(ov.daily.length === 30 && ov.daily[29].day === dayKey(T) && ov.daily.every((x, i, a) => i === 0 || a[i - 1].day < x.day), '概览:30 天升序补 0');
    const sumDaily = db.prepare('SELECT SUM(seconds) s FROM watch_daily').get().s;
    const sumStats = db.prepare('SELECT SUM(seconds) s FROM watch_stats').get().s;
    ok(ov.watch.total_seconds === sumStats && ov.watch.d30_seconds === sumDaily && ov.watch.live_seconds === 300, '概览:累计/30 天/直播时长', ov.watch);
    ok(ov.watch.today_seconds === 510 && ov.daily[29].users === 1, '概览:今日时长/人数', [ov.watch.today_seconds, ov.daily[29]]);
    ok(ov.top_shows.length > 0 && ov.top_shows.every((s, i, a) => i === 0 || a[i - 1].seconds >= s.seconds) && ov.top_shows.find(s => s.title === '剧C'), '概览:热门剧降序', ov.top_shows);
    ok(!ov.top_shows.find(s => s.title === '老剧'), '概览:热门剧只要近 30 天有人看的');
    ok(ov.shares.total === 3 && ov.shares.opens === 4 && ov.shares.uniq_visitors === 3 && ov.shares.logins === 2 && ov.shares.previews === 3, '概览:分享数字', ov.shares);
    ok(ov.shares.by_channel.wechat === 1 && ov.shares.by_channel.telegram === 1 && ov.shares.by_channel.other === 1 && ov.shares.by_source['微信'] === 3 && ov.shares.by_source.X === 1, '概览:渠道/来源分布', ov.shares);
    ok(ov.requests.total === 5 && ov.requests.pending === 3 && ov.requests.need_info === 1 && ov.requests.fulfilled === 1 && ov.requests.rejected === 0, '概览:求片', ov.requests);
    ok(typeof ov.tracking_since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ov.tracking_since), '概览:实测起始日', ov.tracking_since);

    // 分享列表
    let sl = (await A('/api/admin/shares', {})).body;
    ok(sl.total === 3 && sl.shares.length === 3 && sl.shares[0].sharer_token === tk.alice && sl.shares[0].sharer_identity === '独立密码: alice' && sl.shares[0].sharer_type === 'independent', '分享列表 + 分享人', sl.shares[0]);
    sl = (await A('/api/admin/shares', { channel: 'telegram' })).body;
    ok(sl.total === 1 && sl.shares[0].code === 'Code0002', '渠道筛选');
    sl = (await A('/api/admin/shares', { source: 'X' })).body;
    ok(sl.total === 1 && sl.shares[0].code === 'Code0001', '来源筛选');
    sl = (await A('/api/admin/shares', { size: '1', page: '2' })).body;
    ok(sl.total === 3 && sl.shares.length === 1 && sl.page === 2, '分享分页');

    // 求片
    let rl = (await A('/api/admin/requests', {})).body;
    ok(rl.counts.all === 5 && rl.counts.pending === 3 && rl.counts.need_info === 1 && rl.counts.fulfilled === 1, '求片计数', rl.counts);
    const R = Object.fromEntries(rl.requests.map(x => [x.id, x]));
    ok(R[rq.a].dup_count === 3 && R[rq.b].dup_count === 2 && R[rq.c].dup_count === 2 && R[rq.d].dup_count === 2 && R[rq.e].dup_count === 2, '想看人数 = 同 tmdb ∪ 同归一化片名', rl.requests.map(x => [x.name, x.dup_count]));
    ok(R[rq.a].wait_days === 3 && R[rq.d].wait_days === 1 && R[rq.a].identity === '独立密码: alice' && R[rq.a].user_type === 'independent', '等待天数/身份/类型');
    ok(rl.requests.slice(0, 4).every(x => x.status === 'pending' || x.status === 'need_info') && rl.requests[4].status === 'fulfilled', '默认:待处理/需补充在前');
    ok(rl.requests[0].id === rq.e, '默认:同档按时间降序');
    rl = (await A('/api/admin/requests', { sort: 'hot' })).body;
    ok(rl.requests[0].id === rq.a, '最多人想看在前');
    rl = (await A('/api/admin/requests', { sort: 'old' })).body;
    ok(rl.requests[0].id === rq.a, '最早(待处理里最早的在前)');
    rl = (await A('/api/admin/requests', { status: 'pending', q: '地球' })).body;
    ok(rl.requests.length === 2 && rl.counts.all === 5, '状态 + 搜索片名(计数不受筛选影响)');
    rl = (await A('/api/admin/requests', { q: 'mail.com' })).body;
    ok(rl.requests.length === 1 && rl.requests[0].id === rq.c, '搜索提交人');
    const BULK = (body, hdr) => call(app, 'POST', '/api/admin/requests/bulk', { body, headers: hdr === undefined ? { 'x-admin-token': 'adm' } : hdr });
    r = await BULK({ ids: [rq.a, rq.b, rq.b, 'x', -1], action: 'fulfilled', fulfill_link: 'magnet:?xt=urn:btih:1', fulfill_note: '已上架' });
    ok(r.statusCode === 200 && r.body.ok === true && r.body.changed === 2, '批量标记已提供', r.body);
    const ra = db.prepare('SELECT * FROM content_requests WHERE id = ?').get(rq.a);
    ok(ra.status === 'fulfilled' && ra.fulfill_link === 'magnet:?xt=urn:btih:1' && ra.fulfill_note === '已上架' && ra.updated_at === T, '批量写链接/说明/时间');
    r = await BULK({ ids: [rq.a], action: 'need_info' });
    ok(r.body.changed === 1 && db.prepare('SELECT fulfill_link FROM content_requests WHERE id = ?').get(rq.a).fulfill_link === 'magnet:?xt=urn:btih:1', '批量改状态不清空已有链接');
    r = await BULK({ ids: [rq.e], action: 'delete' });
    ok(r.body.changed === 1 && !db.prepare('SELECT 1 FROM content_requests WHERE id = ?').get(rq.e), '批量删除');
    ok((await BULK({ ids: [rq.a], action: 'bogus' })).statusCode === 400, '非法动作 400');
    ok((await BULK({ ids: Array.from({ length: 201 }, (_, i) => i + 1), action: 'rejected' })).statusCode === 400, '超过 200 条 400');
    ok((await BULK({ ids: [], action: 'rejected' })).statusCode === 400, '空 ids 400');
    st.invalidate();
    ok(byTok((await A('/api/admin/users', { size: '100' })).body)[tk.carol].requests === 0, '删除求片后用户求片数更新');

    // 没有数据库 → 空结构、stats_available:false
    const st0 = createUserStats({ db: () => null, adminAuthed: () => true });
    const app0 = mkApp();
    st0.registerRoutes(app0);
    const e1 = (await call(app0, 'GET', '/api/admin/overview')).body;
    const e2 = (await call(app0, 'GET', '/api/admin/users')).body;
    const e3 = (await call(app0, 'GET', '/api/admin/requests')).body;
    const e4 = (await call(app0, 'POST', '/api/stats/watch', { body: { token: 'x' } }));
    ok(e1.stats_available === false && e1.users.total === 0 && e2.stats_available === false && e2.users.length === 0 && e3.requests.length === 0 && e4.statusCode === 204, '无数据库时全是空结构/204');
    ok(st0.recordShareOpen({ query: { s: 'Code0001' }, headers: {} }, {}) === false && st0.touchVisit('x', null) === false, '无数据库时打开/触达静默');
    db.close();
}

// ---------------- ②b 对抗审查修复回归 ----------------
console.log('②b 审查修复回归(机场重启/主密码分享登录/搜狗/刷行/刷事件/排序/建码上限/批量预期状态/老库迁移)');
{
    let T = Date.UTC(2026, 9, 7, 4, 0, 0);
    const db = new Database(':memory:');
    const airEmail = 'pilot@air.com';
    const tk = { main: sha('mainpw'), alice: sha('alice'), bob: sha('bob'), air: 'v2board_' + sha(airEmail), air2: 'v2board_' + sha('banned@air.com'), air3: 'v2board_' + sha('adminrow@air.com'), airNew: 'v2board_' + sha('never@air.com'), gone: sha('removedpw') };
    // 机场 token 都不在内存表里 = 服务器刚重启、用户还没 /api/auth/v2board/check
    const MAP = { [tk.main]: { index: 0 }, [tk.alice]: { index: 1 }, [tk.bob]: { index: 2 } };
    const st = createUserStats({
        db: () => db,
        tokenInfo: (t) => Object.prototype.hasOwnProperty.call(MAP, t) ? MAP[t] : null,
        isBanned: (t) => { const r = db.prepare('SELECT banned FROM user_stats WHERE user_token = ?').get(t); return !!(r && r.banned); },
        identity: (t, l) => l || String(t).slice(0, 12),
        adminAuthed: (req) => req.headers['x-admin-token'] === 'adm',
        ipKey: (req) => req.headers['x-ip'] || '9.9.9.9',
        now: () => T,
    });
    st._ensureSchema();
    const app = mkApp();
    st.registerRoutes(app);
    const W = (token, batch, items, headers) => call(app, 'POST', '/api/stats/watch', { body: { token, batch, items }, headers });
    const SH = (token, code, extra) => call(app, 'POST', '/api/stats/share', { body: Object.assign({ token, code, channel: 'wechat', kind: 'vod', title: '剧A', episode: '第1集' }, extra || {}) });
    const SO = (token, code) => call(app, 'POST', '/api/stats/share-open', { body: { token, code }, headers: { 'user-agent': UA.iPhoneWx } });
    const A = (p, query) => call(app, 'GET', p, { query, headers: { 'x-admin-token': 'adm' } });
    const open = (code, ua, ip) => st.recordShareOpen({ query: { s: code }, headers: { 'user-agent': ua, 'x-ip': ip, host: 'my.site' } }, { preview: true });
    const nRows = (t) => db.prepare('SELECT COUNT(*) n FROM watch_stats WHERE user_token = ?').get(t).n;
    const insUser = db.prepare('INSERT INTO user_stats (user_token, label, first_seen, last_login, last_active, banned) VALUES (?, ?, ?, ?, ?, ?)');

    // 1. 机场 token 重启后:有登录记录且没封 → 三个上报接口照收;其它情况仍拒
    ok((await W(tk.air, 'air-batch-01', [{ k: 'vod', t: '剧A', e: '第1集', s: 60 }])).body.error === 'auth', '机场 token 没有任何登录记录 → auth');
    insUser.run(tk.air, airEmail, T - 30 * DAYMS, T - 3 * DAYMS, T - 3 * DAYMS, 0);
    insUser.run(tk.air2, 'banned@air.com', T - 30 * DAYMS, T - 3 * DAYMS, T - 3 * DAYMS, 1);
    db.prepare('INSERT INTO user_stats (user_token, banned) VALUES (?, 0)').run(tk.air3);   // 后台解封时插的空行:不算登录过
    insUser.run(tk.gone, '', T - 30 * DAYMS, T - 3 * DAYMS, T - 3 * DAYMS, 0);              // 配置里删掉的旧密码:不是机场 token,不放宽
    let r = await W(tk.air, 'air-batch-01', [{ k: 'vod', t: '剧A', e: '第1集', s: 60 }]);
    ok(r.body.ok === true && !r.body.dup && nRows(tk.air) === 1, '重启后未 /check 的机场 token:观看上报照收', r.body);
    ok(db.prepare('SELECT last_active FROM user_stats WHERE user_token = ?').get(tk.air).last_active === T, '…并刷新最近活跃');
    ok((await W(tk.air2, 'air-batch-02', [{ k: 'vod', t: '剧A', e: '第1集', s: 60 }])).body.ok === false, '被封的机场 token 仍拒');
    ok((await W(tk.air3, 'air-batch-03', [{ k: 'vod', t: '剧A', e: '第1集', s: 60 }])).body.error === 'auth', '没登录过(只有后台插的空行)的机场 token 仍拒');
    ok((await W(tk.airNew, 'air-batch-04', [{ k: 'vod', t: '剧A', e: '第1集', s: 60 }])).body.error === 'auth', '库里没有的机场 token 仍拒');
    ok((await W(tk.gone, 'gone-batch-1', [{ k: 'vod', t: '剧A', e: '第1集', s: 60 }])).body.error === 'auth', '非机场的未知 token 不放宽');
    ok((await W('v2board_' + 'x'.repeat(300), 'air-batch-05', [{ k: 'vod', t: '剧A', e: '第1集', s: 60 }])).body.error === 'auth', '超长的伪机场 token 直接拒');
    ok((await SH(tk.air, 'AirCode001')).body.ok === true, '重启后机场用户分享照登记');
    ok((await SH(tk.alice, 'AliCode001')).body.ok === true, 'alice 分享');
    r = await SO(tk.air, 'AliCode001');
    ok(r.body.ok === true && !r.body.dup && (await SO(tk.air, 'AliCode001')).body.dup === true, '重启后机场用户 share-open 照记(仍只记一次)', r.body);
    ok(st.touchVisit(tk.air, { headers: {} }) === false, '其它路径(会话恢复 touchVisit)的鉴权不变:只认内存表');
    ok(st.userType(tk.air) === 'airport', '机场类型不变');

    // 2. 主密码多人共用:同用主密码的人登录进来要记,同 (码, token) 只记一次;独立密码本人仍不记
    ok((await SH(tk.main, 'MainCode01')).body.ok === true, '主密码分享');
    r = await SO(tk.main, 'MainCode01');
    ok(r.body.ok === true && !r.body.self && !r.body.dup, '主密码的另一个人登录 → 记 login', r.body);
    ok((await SO(tk.main, 'MainCode01')).body.dup === true, '主密码同码只记一次');
    ok((await SO(tk.alice, 'AliCode001')).body.self === true, '独立密码分享者本人仍不记');

    // 4. 预览/打开只按模块自己的爬虫识别(不看 server.js 的 isSocialCrawler);搜狗浏览器是真人
    const sogouM = 'Mozilla/5.0 (Linux; Android 10; V1916A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.141 Mobile Safari/537.36 SogouMSE,SogouMobileBrowser/5.30.30';
    const sogouPC = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36 SE 2.X MetaSr 1.0';
    const sogouSpider = 'Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)';
    ok(sourceOf(sogouM, '') === '搜狗浏览器' && sourceOf(sogouPC, '') === '搜狗浏览器' && crawlerOf(sogouM) === null, '搜狗浏览器 = App 来源,不是爬虫');
    ok(deviceOf(sogouM) === 'Android · 搜狗浏览器' && deviceOf(sogouPC) === 'Windows · 搜狗浏览器', '搜狗浏览器设备名', [deviceOf(sogouM), deviceOf(sogouPC)]);
    ok(crawlerOf(sogouSpider) === '其它爬虫', '搜狗蜘蛛仍是爬虫');
    ok(open('AliCode001', sogouM, '3.3.3.1') === true && open('AliCode001', UA.winChrome, '3.3.3.2') === true && open('AliCode001', sogouSpider, '3.3.3.3') === true, '三种访问都记了');
    const ev4 = db.prepare("SELECT type, source FROM share_events WHERE code = 'AliCode001' AND type != 'login' ORDER BY id").all();
    ok(JSON.stringify(ev4.map(e => [e.type, e.source])) === JSON.stringify([['open', '搜狗浏览器'], ['open', '直接打开'], ['preview', '其它爬虫']]), '搜狗真人/被 isSocialCrawler 误判的真人 = 打开;搜狗蜘蛛 = 预览', ev4);

    // 6. 0 秒条目不收;"看完"要 ≥30s 才算;每天新 (类型, 剧, 集) 有预算
    r = await W(tk.bob, 'bob-zero-01', Array.from({ length: 60 }, (_, i) => ({ k: 'vod', t: '刷子剧' + i, e: '第' + i + '集', s: 0, c: 1 })));
    ok(r.body.empty === true && nRows(tk.bob) === 0 && !db.prepare("SELECT 1 FROM stats_batches WHERE id = 'bob-zero-01'").get(), '{s:0,c:1} 条目一律不收(不造行、不登记批次)', r.body);
    ok((await W(tk.bob, 'bob-frac-01', [{ k: 'vod', t: '剧Z', e: '第1集', s: 0.4, c: 1 }, { k: 'vod', t: '剧Z', e: '第2集', s: -5 }, { k: 'vod', t: '剧Z', e: '第3集', s: 'abc' }])).body.empty === true, '不足 1 秒/负数/非数字都不收');
    await W(tk.bob, 'bob-done-01', [{ k: 'vod', t: '剧D', e: '第1集', s: 10, c: 1 }, { k: 'vod', t: '剧D', e: '第2集', s: 29, c: 1 }, { k: 'vod', t: '剧D', e: '第3集', s: 30, c: 1 }]);
    st.invalidate();
    let bu = (await A('/api/admin/users', { size: '100' })).body.users.find(u => u.token === tk.bob);
    ok(bu && bu.episodes === 1 && bu.episodes_done === 1 && bu.shows === 1, '看完标记只在该集 ≥30s 时算(列表)', bu);
    let bd = (await A('/api/admin/user', { token: tk.bob })).body.shows.find(s => s.title === '剧D');
    ok(bd && bd.episodes === 1 && bd.episodes_done === 1 && bd.eps.map(e => e.completed).join() === '0,0,1', '看完标记只在该集 ≥30s 时算(详情逐集)', bd);
    await W(tk.bob, 'bob-done-02', [{ k: 'vod', t: '剧D', e: '第1集', s: 25 }]);   // 累计 35s 后,之前的"看完"才算
    st.invalidate();
    bu = (await A('/api/admin/users', { size: '100' })).body.users.find(u => u.token === tk.bob);
    ok(bu.episodes === 2 && bu.episodes_done === 2, '同一集累计到 ≥30s 后看完标记生效', bu);
    const ov6 = (await A('/api/admin/overview', {})).body;
    ok(ov6.watch.episodes === 2, '概览集数同口径(bob 剧D 2 集;机场那条 60s 没看完不算)', ov6.watch);

    const keys = (pfx, n, s) => Array.from({ length: n }, (_, i) => ({ k: 'vod', t: pfx, e: '第' + (i + 1) + '集', s: s || 1 }));
    for (let b = 0; b < 7; b++) r = await W(tk.bob, 'bob-keys-0' + b, keys('刷行剧' + b, 60));   // 3 + 7×60 > 400
    ok(r.body.capped === true && nRows(tk.bob) === DEF.newKeysPerDay, `独立用户每天最多新建 ${DEF.newKeysPerDay} 个 (类型, 剧, 集)`, nRows(tk.bob));
    ok(db.prepare('SELECT new_keys FROM watch_daily WHERE user_token = ? AND day = ?').get(tk.bob, dayKey(T)).new_keys === DEF.newKeysPerDay, 'watch_daily.new_keys 记账');
    r = await W(tk.bob, 'bob-keys-07', keys('刷行剧7', 60));
    ok(r.body.capped === true && nRows(tk.bob) === DEF.newKeysPerDay && !db.prepare("SELECT 1 FROM stats_batches WHERE id = 'bob-keys-07'").get(), '预算用完后整批新键丢弃、不登记批次', r.body);
    r = await W(tk.bob, 'bob-keys-old', [{ k: 'vod', t: '剧D', e: '第1集', s: 100 }, { k: 'vod', t: '又一部新剧', e: '第1集', s: 100 }]);
    ok(r.body.ok === true && r.body.capped === true && db.prepare("SELECT seconds FROM watch_stats WHERE user_token = ? AND title = '剧D' AND episode = '第1集'").get(tk.bob).seconds === 135
        && !db.prepare("SELECT 1 FROM watch_stats WHERE user_token = ? AND title = '又一部新剧'").get(tk.bob), '预算用完后已有的集照常累加、新集丢弃', r.body);
    for (let b = 0; b < 7; b++) await W(tk.main, 'main-keys-0' + b, keys('主密码剧' + b, 60));
    ok(nRows(tk.main) === 420, '主密码(多人共用)新键预算按 20 人份', nRows(tk.main));
    T += DAYMS;
    r = await W(tk.bob, 'bob-keys-day2', keys('第二天的剧', 5));
    ok(r.body.ok === true && !r.body.capped && nRows(tk.bob) === DEF.newKeysPerDay + 5, '第二天预算重置', r.body);

    // 7. ?s= 刷事件:每 IP 每小时新记 ≤30 条;去重掉的不占预算;计数列;覆盖索引;Map 有上限
    ok((await SH(tk.alice, 'FloodCode1')).body.ok === true, '被刷的分享码');
    let got = 0;
    for (let i = 0; i < 5; i++) if (open('FloodCode1', UA.winChrome, '4.4.4.4')) got++;   // 同访客:只记 1 条
    for (let i = 0; i < 40; i++) if (open('FloodCode1', UA.winChrome + ' r' + i, '4.4.4.4')) got++;   // 换 UA 刷
    ok(got === DEF.ipEventsPerHour, `同一 IP 一小时最多新记 ${DEF.ipEventsPerHour} 条(去重掉的不占预算)`, got);
    ok(open('FloodCode1', UA.iPhoneWx, '4.4.4.5') === true, '别的 IP 不受影响');
    T += 3600e3 + 1;
    ok(open('FloodCode1', UA.winChrome + ' later', '4.4.4.4') === true, '一小时后同 IP 恢复');
    const fc = db.prepare("SELECT events FROM share_links WHERE code = 'FloodCode1'").get().events;
    ok(fc === DEF.ipEventsPerHour + 2 && fc === db.prepare("SELECT COUNT(*) n FROM share_events WHERE code = 'FloodCode1'").get().n, '事件计数列 = 实际事件数', fc);
    const plan = (sql, ...args) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(x => x.detail).join(' | ');
    const pDedup = plan('SELECT 1 FROM share_events WHERE code = ? AND type = ? AND visitor = ? AND at > ? LIMIT 1', 'x', 'open', 'v', 0);
    ok(/COVERING INDEX idx_se_dedup/.test(pDedup), '访客去重走覆盖索引 idx_se_dedup', pDedup);
    const ipMax0 = DEF.ipMapMax;
    DEF.ipMapMax = 2;
    for (let i = 0; i < 40; i++) open('FloodCode1', UA.winChrome + ' m' + i, '8.8.8.1');   // 8.8.8.1 用满
    ok(open('FloodCode1', UA.winChrome + ' m-x', '8.8.8.1') === false, '用满后拒');
    open('FloodCode1', UA.winChrome, '8.8.8.2'); open('FloodCode1', UA.winChrome, '8.8.8.3');   // 表满 → 清掉过期的,仍满就整表清
    ok(open('FloodCode1', UA.winChrome + ' m-y', '8.8.8.1') === true, 'IP 表有上限(满了整表清,不无限增长)');
    DEF.ipMapMax = ipMax0;

    // 8. 集名自然序复用 Collator:2 万集的详情排序不能卡住事件循环
    {
        const ins = db.prepare("INSERT INTO watch_stats (user_token, kind, title, episode, seconds, completed, first_at, last_at) VALUES (?, 'vod', '超长剧', ?, 200, 0, ?, ?)");
        const N = 20000;
        db.transaction(() => { for (let i = 0; i < N; i++) { const n = (i * 7919) % N + 1; ins.run('natsort-user', '第' + n + '集', T, T); } })();
        const t0 = performance.now();
        const det = (await A('/api/admin/user', { token: 'natsort-user' })).body;
        const ms = performance.now() - t0;
        const eps = det.shows[0].eps.map(e => e.episode);
        ok(eps.length === N && eps[0] === '第1集' && eps[1] === '第2集' && eps[9] === '第10集' && eps[N - 1] === '第' + N + '集', '集名自然序', eps.slice(0, 3));
        ok(ms < 1500, `2 万集详情 ${ms.toFixed(0)}ms < 1500ms(localeCompare 每次比较建 collator 要好几秒)`);
    }

    // 9. 每天建码上限:主密码按 20 人份;计数走 (user_token, created_at) 索引区间
    {
        let lastMain = null, lastAlice = null;
        for (let i = 0; i < DEF.sharePerDay + 1; i++) {
            lastMain = (await SH(tk.main, 'Lm' + String(i).padStart(6, '0'))).body;
            lastAlice = (await SH(tk.alice, 'La' + String(i).padStart(6, '0'))).body;
        }
        ok(lastMain.ok === true, `主密码第 ${DEF.sharePerDay + 1} 个分享码照收(上限 ${DEF.sharePerDayShared})`, lastMain);
        ok(lastAlice.ok === false && lastAlice.error === 'limit' && db.prepare('SELECT COUNT(*) n FROM share_links WHERE user_token = ? AND created_at > ?').get(tk.alice, T - DAYMS).n === DEF.sharePerDay,
            `独立用户 24 小时内最多 ${DEF.sharePerDay} 个 → limit`, lastAlice);
        const pCnt = plan('SELECT COUNT(*) n FROM share_links WHERE user_token = ? AND created_at > ?', 't', 0);
        ok(/idx_sl_user_created \(user_token=\? AND created_at>\?\)/.test(pCnt), '建码计数走索引区间', pCnt);
    }

    // 10. 批量处理可带预期状态,只改仍处于该状态的
    {
        const ins = db.prepare("INSERT INTO content_requests (user_token, user_label, name, status, fulfill_note, created_at, updated_at) VALUES (?, '', ?, ?, ?, ?, ?)");
        const p1 = ins.run(tk.alice, '片1', 'pending', null, T, T).lastInsertRowid;
        const p2 = ins.run(tk.alice, '片2', 'pending', null, T, T).lastInsertRowid;
        const f1 = ins.run(tk.alice, '片3', 'fulfilled', '已上架', T, T).lastInsertRowid;   // 刚单条处理过、卡片还留在"待处理"列表里
        const n1 = ins.run(tk.alice, '片4', 'need_info', null, T, T).lastInsertRowid;
        const BULK = (body) => call(app, 'POST', '/api/admin/requests/bulk', { body, headers: { 'x-admin-token': 'adm' } });
        const stOf = (id) => db.prepare('SELECT status, fulfill_note FROM content_requests WHERE id = ?').get(id);
        r = await BULK({ ids: [p1, f1], action: 'rejected', fulfill_note: '暂无资源', expect: 'pending' });
        ok(r.body.ok === true && r.body.changed === 1 && r.body.skipped === 1 && stOf(p1).status === 'rejected' && stOf(f1).status === 'fulfilled' && stOf(f1).fulfill_note === '已上架', 'expect=pending:已离开待处理的那条不被改', r.body);
        r = await BULK({ ids: [p2, f1, n1], action: 'delete', from: ['pending', 'need_info'] });
        ok(r.body.changed === 2 && !stOf(p2) && !stOf(n1) && stOf(f1), 'from 数组 + 删除:只删仍在这些状态的', r.body);
        ok((await BULK({ ids: [f1], action: 'pending', expect: 'bogus' })).statusCode === 400 && stOf(f1).status === 'fulfilled', '非法预期状态 400 且不改');
        r = await BULK({ ids: [f1], action: 'pending', expect: 'all' });
        ok(r.body.changed === 1 && stOf(f1).status === 'pending', "expect='all' = 不限(兼容不带预期的调用)", r.body);
    }
    db.close();

    // 老库迁移:share_links 补 events 列并按已有事件回填;watch_daily 补 new_keys;旧索引换新
    {
        const old = new Database(':memory:');
        old.exec(`
            CREATE TABLE watch_daily (user_token TEXT NOT NULL, day TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_token, day)) WITHOUT ROWID;
            CREATE TABLE share_links (code TEXT PRIMARY KEY, user_token TEXT NOT NULL, kind TEXT, title TEXT, episode TEXT, t INTEGER, channel TEXT, created_at INTEGER);
            CREATE INDEX idx_sl_user ON share_links(user_token);
            CREATE TABLE share_events (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, at INTEGER, type TEXT, source TEXT, device TEXT, visitor TEXT, visitor_token TEXT);
            CREATE INDEX idx_se_code ON share_events(code);
            INSERT INTO watch_daily VALUES ('u1', '2026-10-01', 100);
            INSERT INTO share_links (code, user_token, created_at) VALUES ('OldCode001', 'u1', 1), ('OldCode002', 'u1', 2);
            INSERT INTO share_events (code, at, type, visitor) VALUES ('OldCode001', 1, 'open', 'a'), ('OldCode001', 2, 'open', 'b'), ('OldCode001', 3, 'preview', 'c');`);
        const st2 = createUserStats({ db: () => old });
        ok(st2._ensureSchema() === true, '老库建表/迁移不报错');
        const ev = Object.fromEntries(old.prepare('SELECT code, events FROM share_links').all().map(x => [x.code, x.events]));
        ok(ev.OldCode001 === 3 && ev.OldCode002 === 0, '老库 events 按已有事件回填', ev);
        ok(old.prepare('SELECT new_keys FROM watch_daily').get().new_keys === 0, '老库 watch_daily 补 new_keys 列');
        const idx = old.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(x => x.name);
        ok(idx.includes('idx_sl_user_created') && idx.includes('idx_se_dedup') && !idx.includes('idx_sl_user') && !idx.includes('idx_se_code'), '老索引换成新索引', idx);
        old.close();
    }
}

// ---------------- ③ 端到端 ----------------
console.log('③ server.js 端到端');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-stats-'));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));

const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
let srv = null, port = 0, srvLog = '', allLog = '';
async function startServer(extraEnv) {
    port = 20000 + Math.floor(Math.random() * 20000);
    srvLog = '';
    srv = spawn(process.execPath, ['server.js'], {
        cwd: tmp,
        env: Object.assign({}, process.env, {
            NODE_PATH, PORT: String(port), CACHE_TYPE: 'sqlite', ACCESS_PASSWORD: 'mainpw,alice,bob', ADMIN_TOKEN: 'adm',
            LIVE_TV_DISABLED: '1', KAZUMI_DISABLE: '1', CORS_PROXY_URL: '', REMOTE_DB_URL: '', TMDB_API_KEY: '', DANMU_API_URL: '', STATS_DISABLE: '', SITE_URL: ''
        }, extraEnv || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', d => { srvLog += d; allLog += d; });
    srv.stderr.on('data', d => { srvLog += d; allLog += d; });
    for (let i = 0; i < 100; i++) {
        await sleep(100);
        try { const r = await fetch(`http://127.0.0.1:${port}/api/debug`); if (r.ok) return; } catch (e) { }
    }
    throw new Error('server did not start:\n' + srvLog.slice(-2000));
}
async function stopServer() {
    if (!srv) return;
    const p = new Promise(r => srv.once('exit', r));
    srv.kill(); await p; srv = null;
}
const base = () => `http://127.0.0.1:${port}`;
async function api(method, p, o) {
    o = o || {};
    const headers = Object.assign({ 'user-agent': UA.winChrome }, o.headers || {});
    let body;
    if (o.text !== undefined) { body = o.text; headers['content-type'] = 'text/plain;charset=UTF-8'; }
    else if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
    const r = await fetch(base() + p, { method, headers, body, redirect: 'manual' });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { }
    return { status: r.status, j, txt, h: r.headers };
}
const ADM = { 'x-admin-token': 'adm' };
const adm = (p) => api('GET', p, { headers: ADM });
const TK = { main: sha('mainpw'), alice: sha('alice'), bob: sha('bob') };

try {
    await startServer();
    const cfg = await api('GET', '/api/config?token=' + TK.alice);
    ok(cfg.j && cfg.j.watch_stats === true, '/api/config.watch_stats = true', cfg.j && cfg.j.watch_stats);
    // 登录 / 会话恢复
    let v = await api('POST', '/api/auth/verify', { json: { password: 'alice' } });
    ok(v.j && v.j.success === true && v.j.passwordHash === TK.alice && v.j.syncEnabled === true && v.j.userIndex === 1 && Object.keys(v.j).length === 4, '登录返回值不变', v.j);
    v = await api('POST', '/api/auth/verify', { json: { passwordHash: TK.bob }, headers: { 'user-agent': UA.androidApp } });
    ok(v.j && v.j.success === true, '会话恢复');
    v = await api('POST', '/api/auth/verify', { json: { passwordHash: 'constructor' } });
    ok(v.status === 200, 'verify 异常 hash 不崩(原有行为)');

    // 观看上报
    const watch = (token, batch, items, o) => api('POST', '/api/stats/watch', Object.assign({ json: { token, batch, items } }, o || {}));
    let r = await watch(TK.alice, 'e2e-batch-01', [{ k: 'vod', t: '剧A', e: '第1集', s: 600, c: 1 }, { k: 'vod', t: '剧A', e: '第2集', s: 100 }, { k: 'live', t: 'CCTV-1', e: '', s: 300 }]);
    ok(r.status === 200 && r.j && r.j.ok === true, '上报 JSON', r);
    r = await watch(TK.alice, 'e2e-batch-01', [{ k: 'vod', t: '剧A', e: '第1集', s: 600, c: 1 }]);
    ok(r.j && r.j.dup === true, '重复批次 dup');
    r = await api('POST', '/api/stats/watch', { text: JSON.stringify({ token: TK.alice, batch: 'e2e-batch-02', items: [{ k: 'vod', t: '剧B', e: '第10集', s: 200 }, { k: 'vod', t: '剧B', e: '第2集', s: 60 }] }) });
    ok(r.status === 200 && r.j && r.j.ok === true && !r.j.dup, 'text/plain(sendBeacon)也收', r);
    await sleep(15);
    r = await watch(TK.alice, 'e2e-batch-03', [{ k: 'vod', t: '剧A', e: '第2集', s: 50 }]);
    ok(r.j && r.j.ok === true, '第三批');
    r = await api('POST', '/api/stats/watch', { text: 'not json at all' });
    ok(r.status === 200 && r.j && r.j.ok === false, '坏 body → ok:false 不 500', r);
    r = await watch('0'.repeat(64), 'e2e-batch-04', [{ k: 'vod', t: 'x', e: '1', s: 5 }]);
    ok(r.j && r.j.ok === false, '非法 token → ok:false');
    r = await watch('constructor', 'e2e-batch-05', [{ k: 'vod', t: 'x', e: '1', s: 5 }]);
    ok(r.j && r.j.ok === false, '原型链键当 token → ok:false');
    r = await watch(TK.main, 'e2e-main-01', [{ k: 'vod', t: '剧A', e: '第1集', s: 30 }]);
    ok(r.j && r.j.ok === true, '主密码上报');
    r = await watch(TK.bob, 'e2e-bob-01', Array.from({ length: 7 }, (_, i) => ({ k: 'vod', t: '挂机剧', e: '第' + (i + 1) + '集', s: 14400 })), { headers: { 'user-agent': UA.androidApp } });
    ok(r.j && r.j.ok === true && r.j.capped === true, '一天超 24h 封顶', r.j);

    // 分享 + 打开
    const share = (token, code, extra) => api('POST', '/api/stats/share', { json: Object.assign({ token, code, channel: 'wechat', kind: 'vod', title: '剧A', episode: '第1集', t: 0 }, extra || {}) });
    ok((await share(TK.alice, 'wxCode0001')).j.ok === true, '分享登记(微信)');
    ok((await share(TK.alice, 'tgCode0002', { channel: 'telegram' })).j.ok === true, '分享登记(Telegram)');
    let home = await api('GET', '/?play=' + encodeURIComponent('剧A') + '&s=wxCode0001', { headers: { 'user-agent': UA.iPhoneWx, 'cf-connecting-ip': '11.0.0.1' } });
    ok(home.status === 200 && /og:title/.test(home.txt) && /_spa=1&amp;s=wxCode0001|_spa=1&s=wxCode0001/.test(home.txt), '微信 UA 拿到卡片页,跳转地址带着分享码', home.txt.slice(0, 200));
    home = await api('GET', '/?play=' + encodeURIComponent('剧A') + '&_spa=1&s=wxCode0001', { headers: { 'user-agent': UA.iPhoneWx, 'cf-connecting-ip': '11.0.0.1' } });
    ok(home.status === 200 && /<html/i.test(home.txt) && !/og:type" content="video.other/.test(home.txt), '跳回 SPA');
    home = await api('GET', '/?play=' + encodeURIComponent('剧A') + '&s=tgCode0002', { headers: { 'user-agent': UA.tgBot, 'cf-connecting-ip': '149.154.161.1' } });
    ok(home.status === 200 && /og:title/.test(home.txt), 'TelegramBot 拿卡片页');
    home = await api('GET', '/?play=' + encodeURIComponent('剧A') + '&s=tgCode0002', { headers: { 'user-agent': UA.winChrome, 'cf-connecting-ip': '11.0.0.2', referer: 'https://t.co/abc' } });
    ok(home.status === 200, 'Chrome + t.co 打开');
    home = await api('GET', '/?live=CCTV-5&s=tgCode0002', { headers: { 'user-agent': UA.androidChrome, 'cf-connecting-ip': '11.0.0.3' } });
    ok(home.status === 200, '直播分享链打开');
    home = await api('GET', '/?s=NoSuchCode9', { headers: { 'cf-connecting-ip': '11.0.0.4' } });
    const home2 = await api('GET', '/?s=%3Cscript%3E', { headers: { 'cf-connecting-ip': '11.0.0.4' } });
    ok(home.status === 200 && home2.status === 200, '未知/非法分享码照常出页面');
    let so = await api('POST', '/api/stats/share-open', { json: { code: 'wxCode0001', token: TK.main }, headers: { 'user-agent': UA.iPhoneWx } });
    ok(so.j && so.j.ok === true && !so.j.dup, 'share-open 记登录');
    so = await api('POST', '/api/stats/share-open', { json: { code: 'wxCode0001', token: TK.main } });
    ok(so.j && so.j.dup === true, 'share-open 同人只记一次');
    so = await api('POST', '/api/stats/share-open', { text: JSON.stringify({ code: 'wxCode0001', token: TK.alice }) });
    ok(so.j && so.j.self === true, '分享者本人不记(text/plain)');

    // 求片(走真接口)
    const reqA = await api('POST', '/api/requests', { json: { token: TK.alice, name: '流浪地球', tmdb_id: '535167', year: '2019' } });
    const reqB = await api('POST', '/api/requests', { json: { token: TK.main, name: '流浪 地球！' } });
    const reqC = await api('POST', '/api/requests', { json: { token: TK.main, name: '三体' } });
    ok(reqA.j && reqA.j.ok && reqB.j && reqB.j.ok && reqC.j && reqC.j.ok, '提交求片', [reqA.j, reqB.j, reqC.j]);

    // 直接往库里补几类用户(机场/未知/旧同步历史)
    {
        const dbf = new Database(path.join(tmp, 'cache.db'));
        const now = Date.now();
        dbf.prepare('INSERT INTO user_stats (user_token, label, first_seen, last_login, last_active, banned) VALUES (?, ?, ?, ?, ?, 0)').run('v2board_e2e0000000000001', 'pilot@air.com', now - 90 * DAYMS, now - 80 * DAYMS, now - 70 * DAYMS);
        dbf.prepare("INSERT INTO content_requests (user_token, user_label, name, tmdb_id, status, created_at, updated_at) VALUES ('oldtoken00001', '', '流浪地球2', '535167', 'pending', ?, ?)").run(now - 2 * DAYMS, now - 2 * DAYMS);
        dbf.prepare('INSERT INTO user_history (user_token, item_id, item_data, updated_at) VALUES (?, ?, ?, ?)').run(TK.alice, 'old1', JSON.stringify({ name: '旧剧', episode: '第3集', progressTime: 600, progressDuration: 2400, progress: 25 }), now - DAYMS);
        dbf.close();
    }

    // 403
    for (const p of ['/api/admin/overview', '/api/admin/users', '/api/admin/user?token=' + TK.alice, '/api/admin/shares', '/api/admin/requests']) {
        const a = await api('GET', p);
        const b = await api('GET', p, { headers: { 'x-admin-token': 'wrong' } });
        ok(a.status === 403 && b.status === 403, p + ' 无/错令牌 403');
    }
    ok((await api('POST', '/api/admin/requests/bulk', { json: { ids: [1], action: 'delete' } })).status === 403, 'bulk 无令牌 403');

    // 用户列表
    let ul = await adm('/api/admin/users?size=100');
    ok(ul.status === 200 && ul.j && ul.j.stats_available === true && ul.j.total === 5 && !('aggregates' in ul.j), '新版 /api/admin/users(5 人)', ul.j && ul.j.users.map(u => u.identity));
    let U = Object.fromEntries(((ul.j || {}).users || []).map(u => [u.token, u]));
    const al = U[TK.alice] || {};
    ok(al.watch_seconds === 1310 && al.live_seconds === 300 && al.episodes === 3 && al.episodes_done === 1 && al.shows === 2, 'alice 时长/集数/剧数', al);
    ok(al.last_title === '剧A' && al.last_episode === '第2集' && al.last_login > 0 && al.last_device === 'Windows · Chrome', 'alice 最近在看/最近登录/设备', al);
    ok(al.shares === 2 && al.share_opens === 3 && al.share_logins === 1 && al.requests === 1 && al.legacy_shows === 1, 'alice 分享/求片/旧历史', al);
    ok(U[TK.bob] && U[TK.bob].watch_seconds === 86400 && U[TK.bob].episodes === 6 && U[TK.bob].last_device === 'Android App' && U[TK.bob].banned === false, 'bob 封顶/设备(会话恢复记的)', U[TK.bob]);
    ok(U[TK.main] && U[TK.main].type === 'primary' && U[TK.main].requests === 2 && U[TK.main].episodes === 0, '主密码用户', U[TK.main]);
    ok(U.v2board_e2e0000000000001 && U.v2board_e2e0000000000001.type === 'airport' && U.oldtoken00001 && U.oldtoken00001.type === 'unknown', '机场/未知用户');
    // 封禁 → 立刻反映(缓存被清)
    const ban = await api('POST', '/api/admin/ban', { json: { token: TK.bob, banned: true }, headers: ADM });
    ok(ban.j && ban.j.ok === true, '封禁 bob');
    ul = await adm('/api/admin/users?status=banned');
    ok(ul.j && ul.j.total === 1 && ul.j.users[0].token === TK.bob, '封禁后立刻能筛出来(invalidate)', ul.j);
    r = await watch(TK.bob, 'e2e-bob-02', [{ k: 'vod', t: '挂机剧', e: '第9集', s: 10 }]);
    ok(r.j && r.j.ok === false && r.j.banned === true, '封禁后上报被拒');
    const ids = async (qs) => ((await adm('/api/admin/users?size=100&' + qs)).j || { users: [] }).users.map(u => u.token);
    let o = await ids('sort=watch');
    ok(o[0] === TK.bob && o[1] === TK.alice && o[2] === TK.main, '按观看时长', o);
    o = await ids('sort=watch&order=asc');
    ok(o[0] !== TK.bob && o[o.length - 1] === TK.bob, '升序');
    o = await ids('type=primary');
    ok(o.length === 1 && o[0] === TK.main, '类型筛选');
    o = await ids('status=never');
    ok(o.length === 2 && o.includes('v2board_e2e0000000000001') && o.includes('oldtoken00001'), '从未观看', o);
    o = await ids('status=dormant');
    ok(o.length === 2, '沉睡', o);
    o = await ids('status=shares');
    ok(o.length === 1 && o[0] === TK.alice, '有分享');
    o = await ids('status=requests');
    ok(o.length === 3, '有求片', o);
    o = await ids('q=' + encodeURIComponent('独立密码: ali'));
    ok(o.length === 1 && o[0] === TK.alice, '搜索身份');
    o = await ids('sort=last_login');
    ok(o[0] === TK.alice || o[0] === 'v2board_e2e0000000000001', '按最近登录(有值的在前)', o);
    const pg = await adm('/api/admin/users?size=2&page=3');
    ok(pg.j && pg.j.total === 5 && pg.j.users.length === 1 && pg.j.page === 3 && pg.j.size === 2, '分页');

    // 用户详情
    const ud = (await adm('/api/admin/user?token=' + TK.alice)).j || {};
    const sA = (ud.shows || []).find(s => s.title === '剧A') || {};
    const sB = (ud.shows || []).find(s => s.title === '剧B') || {};
    ok(ud.user && ud.user.token === TK.alice && ud.shows[0].title === '剧A', '详情:最近看的剧在前', (ud.shows || []).map(s => s.title));
    ok(sA.seconds === 750 && sA.episodes === 2 && sA.episodes_done === 1 && sB.eps && sB.eps.map(e => e.episode).join() === '第2集,第10集', '详情:每剧时长/集数 + 集名自然序', [sA, sB]);
    ok(ud.daily && ud.daily.length === 60 && ud.daily[59].seconds === 1310, '详情:近 60 天', ud.daily && ud.daily[59]);
    const s1 = (ud.shares || []).find(s => s.code === 'wxCode0001') || {};
    const s2 = (ud.shares || []).find(s => s.code === 'tgCode0002') || {};
    ok(s1.opens === 1 && s1.uniq === 1 && s1.sources && s1.sources['微信'] === 1 && s1.logins === 1 && (s1.login_users || []).join() === '主密码: mainpw', '微信分享:爬虫页 + SPA 只算一次打开、带来 1 个登录', s1);
    ok(s2.opens === 2 && s2.uniq === 2 && s2.previews === 1 && s2.preview_sources && s2.preview_sources.Telegram === 1 && s2.sources.X === 1 && s2.sources['直接打开'] === 1, 'Telegram 分享:预览 1、X 来源 1、直接打开 1', s2);
    ok(ud.requests && ud.requests.length === 1 && ud.history && ud.history.length === 1 && ud.history[0].est_seconds === 5400, '详情:求片/旧历史');

    // 概览
    const ov = (await adm('/api/admin/overview')).j || {};
    ok(ov.stats_available === true && ov.tracking_enabled === true && ov.users && ov.users.total === 5 && ov.users.banned === 1, '概览:用户', ov.users);
    ok(ov.users.by_type.independent === 2 && ov.users.by_type.primary === 1 && ov.users.by_type.airport === 1 && ov.users.by_type.unknown === 1, '概览:类型拆分', ov.users.by_type);
    ok(ov.watch.today_seconds === 1310 + 30 + 86400 && ov.watch.total_seconds === 1310 + 30 + 86400 && ov.watch.live_seconds === 300 && ov.watch.episodes === 9 && ov.watch.shows === 3, '概览:观看', ov.watch);
    ok(ov.daily.length === 30 && ov.daily[29].users === 3, '概览:每日', ov.daily && ov.daily[29]);
    ok(ov.top_shows[0].title === '挂机剧' && ov.top_shows.find(s => s.title === '剧A' && s.users === 2 && s.episodes === 2), '概览:热门剧', ov.top_shows);
    ok(ov.top_live.length === 1 && ov.top_live[0].title === 'CCTV-1' && ov.top_live[0].seconds === 300, '概览:直播 Top', ov.top_live);
    ok(ov.shares.total === 2 && ov.shares.opens === 3 && ov.shares.uniq_visitors === 3 && ov.shares.logins === 1 && ov.shares.previews === 1, '概览:分享', ov.shares);
    ok(ov.shares.by_channel.wechat === 1 && ov.shares.by_channel.telegram === 1 && ov.shares.by_source['微信'] === 1 && ov.shares.by_source.X === 1 && ov.shares.by_source['直接打开'] === 1, '概览:渠道/来源', ov.shares);
    ok(ov.requests.total === 4 && ov.requests.pending === 4, '概览:求片', ov.requests);
    ok(ov.tracking_since === dayKey(Date.now()), '概览:实测起始日', ov.tracking_since);

    // 分享列表
    let sl = (await adm('/api/admin/shares')).j || {};
    ok(sl.total === 2 && sl.shares.length === 2 && sl.shares.every(s => s.sharer_token === TK.alice && s.sharer_identity === '独立密码: alice' && s.sharer_type === 'independent'), '分享列表', sl);
    sl = (await adm('/api/admin/shares?channel=wechat')).j || {};
    ok(sl.total === 1 && sl.shares[0].code === 'wxCode0001', '渠道筛选');
    sl = (await adm('/api/admin/shares?source=' + encodeURIComponent('X'))).j || {};
    ok(sl.total === 1 && sl.shares[0].code === 'tgCode0002', '来源筛选');

    // 求片
    let rl = (await adm('/api/admin/requests')).j || {};
    ok(rl.counts && rl.counts.all === 4 && rl.counts.pending === 4, '求片计数', rl.counts);
    const byName = Object.fromEntries((rl.requests || []).map(x => [x.name, x]));
    ok(byName['流浪地球'].dup_count === 3 && byName['流浪 地球！'].dup_count === 2 && byName['流浪地球2'].dup_count === 2 && byName['三体'].dup_count === 1, '想看人数', (rl.requests || []).map(x => [x.name, x.dup_count]));
    ok(byName['流浪地球'].identity === '独立密码: alice' && byName['流浪地球'].user_type === 'independent' && byName['流浪地球'].wait_days === 0 && byName['流浪地球2'].wait_days === 2, '身份/类型/等待天数');
    rl = (await adm('/api/admin/requests?sort=hot')).j || {};
    ok(rl.requests[0].name === '流浪地球', '最多人想看');
    rl = (await adm('/api/admin/requests?q=' + encodeURIComponent('三体'))).j || {};
    ok(rl.requests.length === 1, '搜索');
    const bulk = (body) => api('POST', '/api/admin/requests/bulk', { json: body, headers: ADM });
    r = await bulk({ ids: [byName['流浪地球'].id, byName['流浪 地球！'].id], action: 'fulfilled', fulfill_link: 'https://example.com/x', fulfill_note: '已上架，站内搜索片名即可观看' });
    ok(r.j && r.j.ok === true && r.j.changed === 2, '批量已提供', r.j);
    r = await bulk({ ids: [byName['三体'].id], action: 'delete' });
    ok(r.j && r.j.changed === 1, '批量删除');
    r = await bulk({ ids: [byName['流浪地球2'].id], action: 'rejected', expect: 'fulfilled' });
    ok(r.j && r.j.ok === true && r.j.changed === 0 && r.j.skipped === 1, '批量带预期状态:状态已不符的不改', r.j);
    rl = (await adm('/api/admin/requests?status=fulfilled')).j || {};
    ok(rl.counts.all === 3 && rl.counts.fulfilled === 2 && rl.requests.length === 2 && rl.requests.every(x => x.fulfill_link === 'https://example.com/x'), '批量结果', rl.counts);
    const mine = await api('GET', '/api/requests/mine?token=' + TK.alice);
    ok(mine.j && mine.j.requests[0].status === 'fulfilled' && mine.j.requests[0].fulfill_note === '已上架，站内搜索片名即可观看', '用户侧"我的求片"看到结果');

    // 单条处理(旧接口)/用户提交/撤销都要立刻清统计缓存:概览"待处理求片"不能停在 20s 前
    {
        const ovReq = async () => ((await adm('/api/admin/overview')).j || {}).requests || {};
        const rq0 = await ovReq();   // 先把概览缓存焐热
        const nr = await api('POST', '/api/requests', { json: { token: TK.alice, name: '缓存测试片' } });
        let rq1 = await ovReq();
        ok(nr.j && nr.j.ok && rq1.total === rq0.total + 1 && rq1.pending === rq0.pending + 1, '用户提交求片 → 概览立刻 +1', [rq0, rq1]);
        r = await api('POST', '/api/requests/admin', { json: { admin: 'adm', id: nr.j.id, status: 'need_info', fulfill_note: '请补充年份' } });
        rq1 = await ovReq();
        ok(r.j && r.j.ok && rq1.need_info === rq0.need_info + 1 && rq1.pending === rq0.pending, '单条改状态(POST /api/requests/admin)→ 概览立刻反映', rq1);
        r = await api('POST', '/api/requests/cancel', { json: { token: TK.alice, id: nr.j.id } });
        rq1 = await ovReq();
        ok(r.j && r.j.deleted === 1 && rq1.total === rq0.total && rq1.need_info === rq0.need_info, '用户撤销 → 概览立刻反映', rq1);
        const nr2 = await api('POST', '/api/requests', { json: { token: TK.alice, name: '删除测试片' } });
        const mid = await ovReq();
        r = await api('POST', '/api/requests/admin', { json: { admin: 'adm', id: nr2.j.id, action: 'delete' } });
        rq1 = await ovReq();
        ok(mid.total === rq0.total + 1 && r.j && r.j.deleted === true && rq1.total === rq0.total, '单条删除(旧接口)→ 概览立刻反映', [mid, rq1]);
        // 求片海报只收 TMDB 路径 / image.tmdb.org 地址(统一存路径),其它一律存空 —— 后台渲染海报不能去连提交者给的任意主机
        const posters = [
            ['https://evil.example/p.gif?id=me', ''], ['/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg', '/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg'],
            ['https://image.tmdb.org/t/p/w500/abcDEF123.png', '/abcDEF123.png'], ['https://image.tmdb.org.evil.example/t/p/w500/a.jpg', ''],
            ['javascript:alert(1)', ''], ['/../../etc/passwd.jpg', ''], ['//evil.example/x.jpg', ''], [{ x: 1 }, '']
        ];
        for (const [p, want] of posters) {
            const s = await api('POST', '/api/requests', { json: { token: TK.alice, name: '海报测试', poster: p } });
            const got = (((await api('GET', '/api/requests/mine?token=' + TK.alice)).j || {}).requests || []).find(x => x.id === (s.j && s.j.id));
            ok(got && got.poster === want, `求片海报 ${JSON.stringify(p)} → ${JSON.stringify(want)}`, got && got.poster);
            await api('POST', '/api/requests/cancel', { json: { token: TK.alice, id: s.j && s.j.id } });
        }
    }

    // 旧接口保留
    const uh = await adm('/api/admin/user-history?token=' + TK.alice);
    ok(uh.status === 200 && uh.j && uh.j.history.length === 1, '旧 /api/admin/user-history 保留');

    // 性能:300 用户 × 50 集(+ 每人 20 条旧同步历史)冷启动
    {
        const dbf = new Database(path.join(tmp, 'cache.db'));
        const now = Date.now();
        const iw = dbf.prepare('INSERT INTO watch_stats (user_token, kind, title, episode, seconds, completed, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        const idl = dbf.prepare('INSERT INTO watch_daily (user_token, day, seconds) VALUES (?, ?, ?)');
        const ius = dbf.prepare('INSERT INTO user_stats (user_token, label, first_seen, last_login, last_active, banned) VALUES (?, ?, ?, ?, ?, 0)');
        const ih = dbf.prepare('INSERT INTO user_history (user_token, item_id, item_data, updated_at) VALUES (?, ?, ?, ?)');
        const blob = JSON.stringify({ name: '某剧', episode: '第5集', progressTime: 1200, progressDuration: 2700, progress: 44, pic: 'x'.repeat(300) });
        dbf.transaction(() => {
            for (let u = 0; u < 300; u++) {
                const t = 'perfuser' + String(u).padStart(4, '0');
                ius.run(t, '', now - 60 * DAYMS, now - u * 3600e3, now - u * 600e3);
                for (let e = 0; e < 50; e++) iw.run(t, 'vod', '性能剧' + (e % 7), '第' + (e + 1) + '集', 300 + e * 10, e % 3 === 0 ? 1 : 0, now - 30 * DAYMS, now - (u * 50 + e) * 1000);
                for (let dd = 0; dd < 30; dd++) idl.run(t, dayKey(now - dd * DAYMS), 1000 + dd);
                for (let h = 0; h < 20; h++) ih.run(t, 'h' + h, blob, now - h * DAYMS);
            }
        })();
        dbf.close();
        await api('POST', '/api/admin/ban', { json: { token: TK.bob, banned: false }, headers: ADM });   // 顺便清缓存
        const t0 = performance.now();
        const big = await adm('/api/admin/users?sort=watch');
        const cold = performance.now() - t0;
        const t1 = performance.now();
        await adm('/api/admin/users?sort=episodes&page=2');
        const warm = performance.now() - t1;
        const t2 = performance.now();
        const bigOv = await adm('/api/admin/overview');
        const ovMs = performance.now() - t2;
        ok(big.j && big.j.total === 305 && big.j.users.length === 30, '300 用户数据量下列表正确', big.j && big.j.total);
        ok(cold < 300, `/api/admin/users 冷启动 ${cold.toFixed(0)}ms < 300ms`);
        ok(warm < 100, `/api/admin/users 缓存命中 ${warm.toFixed(0)}ms`);
        ok(bigOv.status === 200 && ovMs < 300 && bigOv.j.users.total === 305, `/api/admin/overview ${ovMs.toFixed(0)}ms`);
        console.log(`  · 性能:users 冷 ${cold.toFixed(0)}ms / 热 ${warm.toFixed(0)}ms,overview ${ovMs.toFixed(0)}ms`);
    }

    // 机场 token:服务器(刚)启动、内存表里没有,但库里有登录记录 → 三个统计上报照收;其它接口的鉴权不变
    r = await watch('v2board_e2e0000000000001', 'e2e-air-01', [{ k: 'vod', t: '剧A', e: '第1集', s: 60 }]);
    ok(r.j && r.j.ok === true && !r.j.dup, '未 /check 的机场 token(有登录记录):观看上报照收', r.j);
    r = await watch('v2board_e2e0000000000999', 'e2e-air-02', [{ k: 'vod', t: '剧A', e: '第1集', s: 60 }]);
    ok(r.j && r.j.ok === false && r.j.error === 'auth', '库里没有的机场 token 仍拒', r.j);
    r = await api('POST', '/api/requests', { json: { token: 'v2board_e2e0000000000001', name: 'x' } });
    ok(r.status === 401, '其它接口(求片)对未注册机场 token 的鉴权不变', r.status);

    // 搜狗浏览器真人 → 卡片页照出(isSocialCrawler 不变),但记"打开"不记"其它爬虫"预览;首页 ?s= 每 IP 每小时只新记 30 条
    {
        const sogouM = 'Mozilla/5.0 (Linux; Android 10; V1916A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.141 Mobile Safari/537.36 SogouMSE,SogouMobileBrowser/5.30.30';
        const tgShare = async () => ((((await adm('/api/admin/user?token=' + TK.alice)).j || {}).shares || []).find(s => s.code === 'tgCode0002')) || {};
        const before = await tgShare();
        home = await api('GET', '/?play=' + encodeURIComponent('剧A') + '&s=tgCode0002', { headers: { 'user-agent': sogouM, 'cf-connecting-ip': '12.0.0.1' } });
        ok(home.status === 200 && /og:title/.test(home.txt), '搜狗浏览器仍拿卡片页');
        let after = await tgShare();
        ok(after.opens === before.opens + 1 && after.sources && after.sources['搜狗浏览器'] === 1 && after.previews === before.previews, '搜狗浏览器真人记为打开(来源 搜狗浏览器)', after);
        for (let i = 0; i < 40; i++) await api('GET', '/?s=tgCode0002', { headers: { 'user-agent': UA.winChrome + ' flood' + i, 'cf-connecting-ip': '12.0.0.9' } });
        after = await tgShare();
        ok(after.opens === before.opens + 1 + 30, '首页 ?s= 换 UA 刷量:同 IP 一小时只新记 30 条', after.opens - before.opens);
    }

    // 封禁没有统计行的用户:不能把 first_seen/last_active 写成现在(否则沉睡用户被算成今日活跃/7 日新增)
    {
        const ovU = async () => ((await adm('/api/admin/overview')).j || {}).users || {};
        await api('POST', '/api/requests/admin', { json: { admin: 'adm', id: 999999, status: 'pending' } });   // 改个不存在的 id = 只清 20s 缓存,让 u0 是最新的
        const u0 = await ovU();
        const dbr = new Database(path.join(tmp, 'cache.db'), { readonly: true });
        const crAt = dbr.prepare("SELECT MIN(created_at) t FROM content_requests WHERE user_token = 'oldtoken00001'").get().t;
        dbr.close();
        ok((await api('POST', '/api/admin/ban', { json: { token: 'oldtoken00001', banned: true }, headers: ADM })).j.ok === true, '封禁只有求片记录的老用户');
        ok((await api('POST', '/api/admin/ban', { json: { token: 'ghosttoken0001', banned: true }, headers: ADM })).j.ok === true, '封禁什么记录都没有的 token');
        const dbr2 = new Database(path.join(tmp, 'cache.db'), { readonly: true });
        const s1 = dbr2.prepare("SELECT first_seen, last_active, banned FROM user_stats WHERE user_token = 'oldtoken00001'").get();
        const s2 = dbr2.prepare("SELECT first_seen, last_active, banned FROM user_stats WHERE user_token = 'ghosttoken0001'").get();
        dbr2.close();
        ok(s1 && s1.banned === 1 && s1.first_seen === crAt && s1.last_active === null, 'first_seen 取最早求片时间、last_active 留空', [s1, crAt]);
        ok(s2 && s2.banned === 1 && s2.first_seen === null && s2.last_active === null, '什么都没有的 token:first_seen/last_active 都留空', s2);
        const u1 = await ovU();
        ok(u1.active_1d === u0.active_1d && u1.active_7d === u0.active_7d && u1.new_7d === u0.new_7d + 1 && u1.banned === u0.banned + 2 && u1.total === u0.total + 1,
            '封禁后不被算成今日/7 日活跃(老用户按 2 天前首次出现算新增)', [u0, u1]);
        const ul2 = await adm('/api/admin/users?size=100&status=active1&q=oldtoken');
        ok(ul2.j && ul2.j.total === 0, '封禁的老用户不在"今日活跃"里');
    }

    // STATS_DISABLE=1:不采集,但后台照样能看旧数据
    await stopServer();
    await startServer({ STATS_DISABLE: '1' });
    const cfg2 = await api('GET', '/api/config?token=' + TK.alice);
    ok(cfg2.j && cfg2.j.watch_stats === false, 'STATS_DISABLE → watch_stats:false');
    r = await watch(TK.alice, 'e2e-dis-01', [{ k: 'vod', t: '剧A', e: '第1集', s: 10 }]);
    ok(r.status === 204, 'STATS_DISABLE → 上报 204');
    r = await api('POST', '/api/stats/share', { json: { token: TK.alice, code: 'disCode001', channel: 'qq', title: 'x' } });
    ok(r.status === 204, 'STATS_DISABLE → 分享 204');
    const ov2 = (await adm('/api/admin/overview')).j || {};
    ok(ov2.stats_available === true && ov2.tracking_enabled === false && ov2.users.total === 306, 'STATS_DISABLE 后台仍可查', [ov2.stats_available, ov2.tracking_enabled, ov2.users.total]);
    ok(!/\[UserStats\]|TypeError|ReferenceError/.test(allLog), '服务端日志无统计模块告警/异常', allLog.slice(-1500));
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e) + '\n' + srvLog.slice(-1500));
} finally {
    await stopServer();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

// 静态:旧的重型实现确实删了,Vercel 有桩
{
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const vsrc = fs.readFileSync(path.join(ROOT, 'api/index.js'), 'utf8');
    ok(!/LIMIT 200000/.test(src) && !/app\.get\('\/api\/admin\/users'/.test(src), 'server.js 里旧的 /api/admin/users 已删除');
    ok(/watch_stats:\s*false/.test(vsrc) && /\/api\/stats\/watch/.test(vsrc) && /\/api\/stats\/share-open/.test(vsrc), 'api/index.js 有 watch_stats:false 与 204 桩');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
