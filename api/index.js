/**
 * Vercel Serverless API 入口
 * 这是专为 Vercel 优化的精简版 API，移除了所有文件系统依赖
 */

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ========== 环境变量 ==========
const REMOTE_DB_URL = process.env['REMOTE_DB_URL'] || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || ''; // Keep Required
const TMDB_PROXY_URL = process.env['TMDB_PROXY_URL'] || '';
const ACCESS_PASSWORDS = (process.env['ACCESS_PASSWORD'] || '').split(',').map(p => p.trim()).filter(Boolean);

// 新增：直接嵌入站点配置 JSON（优先于 REMOTE_DB_URL）
// 格式：SITES_JSON = '{"sites":[{"key":"xxx","name":"xxx","api":"https://..."}]}'
// 或 Base64 编码的 JSON
let EMBEDDED_SITES = null;
const SITES_JSON_RAW = process.env['SITES_JSON'] || '';
if (SITES_JSON_RAW) {
    try {
        // 尝试直接解析 JSON
        EMBEDDED_SITES = JSON.parse(SITES_JSON_RAW);
        console.log(`[Vercel API] SITES_JSON: ✓ Loaded ${EMBEDDED_SITES.sites?.length || 0} sites (direct JSON)`);
    } catch (e1) {
        // 尝试 Base64 解码后解析
        try {
            const decoded = Buffer.from(SITES_JSON_RAW, 'base64').toString('utf-8');
            EMBEDDED_SITES = JSON.parse(decoded);
            console.log(`[Vercel API] SITES_JSON: ✓ Loaded ${EMBEDDED_SITES.sites?.length || 0} sites (Base64)`);
        } catch (e2) {
            console.error('[Vercel API] SITES_JSON: ✗ Invalid format (must be JSON or Base64)');
        }
    }
}

// ========== 密码哈希映射 ==========
const PASSWORD_HASH_MAP = {};
ACCESS_PASSWORDS.forEach((pwd, index) => {
    const hash = crypto.createHash('sha256').update(pwd).digest('hex');
    PASSWORD_HASH_MAP[hash] = { index, syncEnabled: index > 0 };
});

// ========== 内存缓存 ==========
let remoteDbCache = EMBEDDED_SITES;  // 如果有嵌入配置，直接用作初始缓存
let remoteDbLastFetch = EMBEDDED_SITES ? Date.now() : 0;
const REMOTE_DB_CACHE_TTL = 5 * 60 * 1000; // 5分钟

// TMDB 请求缓存
const tmdbCache = new Map();
const TMDB_CACHE_TTL = 3600 * 1000; // 1小时

// ========== 调试日志 ==========
console.log('[Vercel API] Initializing...');
console.log(`[Vercel API] TMDB_API_KEY: ${TMDB_API_KEY ? '✓ Configured' : '✗ Missing'}`);
console.log(`[Vercel API] TMDB_PROXY_URL: ${TMDB_PROXY_URL || '(not set)'}`);
console.log(`[Vercel API] REMOTE_DB_URL: ${REMOTE_DB_URL ? '✓ Configured' : '(not set)'}`);
console.log(`[Vercel API] SITES_JSON: ${EMBEDDED_SITES ? `✓ ${EMBEDDED_SITES.sites?.length} sites embedded` : '(not set)'}`);
console.log(`[Vercel API] ACCESS_PASSWORD: ${ACCESS_PASSWORDS.length} password(s)`);

// ========== IP 检测 (与 server.js 保持一致) ==========
const ipLocationCache = new Map();
const IP_CACHE_TTL = 3600 * 1000; // 缓存1小时

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.headers['cf-connecting-ip'] ||
        req.socket?.remoteAddress ||
        '';
}

/**
 * 检测是否为私有/内网 IP 地址
 * @param {string} ip - IP 地址
 * @returns {boolean} - 是否是私有 IP
 */
function isPrivateIP(ip) {
    if (!ip) return false;
    // IPv4 私有地址
    if (/^127\./.test(ip)) return true;  // 127.0.0.0/8 (loopback)
    if (/^10\./.test(ip)) return true;   // 10.0.0.0/8
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;  // 172.16.0.0/12
    if (/^192\.168\./.test(ip)) return true;  // 192.168.0.0/16
    if (/^169\.254\./.test(ip)) return true;  // 169.254.0.0/16 (link-local)
    // IPv6 私有/特殊地址
    if (ip === '::1') return true;  // loopback
    if (/^fe80:/i.test(ip)) return true;  // link-local
    if (/^fc00:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) return true;  // unique local
    return false;
}

/**
 * 检测 IP 是否来自中国大陆（需要使用代理）
 * 支持从 X-Client-Public-IP 头获取客户端提供的公网 IP
 * 私有 IP 默认视为需要代理（假设部署在中国大陆内网环境）
 * @param {object} req - Express 请求对象
 * @returns {Promise<boolean>} - 是否需要使用代理
 */
async function isChineseIP(req) {
    // 1. 优先使用客户端提供的公网 IP (由前端从 api.ip.sb 获取)
    const clientProvidedIP = req.headers['x-client-public-ip'];
    // 2. 回退到服务端检测的 IP
    const detectedIP = getClientIP(req);

    // 使用客户端提供的 IP（如果有效且非私有）
    let effectiveIP = clientProvidedIP && !isPrivateIP(clientProvidedIP) ? clientProvidedIP : detectedIP;

    // 3. 如果有效 IP 仍然是私有的，直接返回 true（视为需要代理）
    if (!effectiveIP || isPrivateIP(effectiveIP)) {
        console.log(`[IP Detection] Private/LAN IP detected (${detectedIP}), treating as CN (proxy required)`);
        return true;
    }

    // 检查缓存
    const cached = ipLocationCache.get(effectiveIP);
    if (cached && (Date.now() - cached.time < IP_CACHE_TTL)) return cached.isCN;

    try {
        const response = await axios.get(`https://api.ip.sb/geoip/${effectiveIP}`, {
            timeout: 3000,
            headers: { 'User-Agent': 'DongguaTV/1.0' }
        });
        let isCN = false;
        if (response.data.country_code === 'CN') {
            const excludeRegions = ['Hong Kong', 'Macau', 'Taiwan', '香港', '澳门', '台湾'];
            const region = response.data.region || response.data.city || '';
            if (!excludeRegions.some(r => region.includes(r))) isCN = true;
        }
        ipLocationCache.set(effectiveIP, { isCN, time: Date.now() });
        console.log(`[IP Detection] ${effectiveIP} -> ${isCN ? '中国大陆' : '海外'}${clientProvidedIP ? ' (client-provided)' : ''}`);
        return isCN;
    } catch (error) {
        console.error(`[IP Detection Error] ${effectiveIP}:`, error.message);
        return false;
    }
}

// ========== API: /api/sites ==========
app.get('/api/sites', async (req, res) => {
    try {
        // 优先使用嵌入的站点配置（不过期）
        if (EMBEDDED_SITES) {
            return res.json(EMBEDDED_SITES);
        }

        // 使用远程配置（带缓存）
        const now = Date.now();
        if (remoteDbCache && now - remoteDbLastFetch < REMOTE_DB_CACHE_TTL) {
            return res.json(remoteDbCache);
        }
        if (REMOTE_DB_URL) {
            const response = await axios.get(REMOTE_DB_URL, { timeout: 5000 });
            if (response.data && Array.isArray(response.data.sites)) {
                remoteDbCache = response.data;
                remoteDbLastFetch = now;
                return res.json(remoteDbCache);
            }
        }
        // Vercel 环境下没有本地 db.json，返回空
        return res.json({ sites: [] });
    } catch (err) {
        console.error('[Remote DB Error]', err.message);
        return res.json({ sites: [] });
    }
});

// ========== API: /api/check ==========
// 服务器端测速兜底：客户端直连+代理都失败时(混合内容/CORS)由服务器测资源站 API 延迟。
// 注：此接口在早期重构中丢失，前端一直调用导致 404 → 服务器测速这条兜底失效，已恢复。
app.get('/api/check', async (req, res) => {
    const { key } = req.query;
    try {
        let sitesData = EMBEDDED_SITES;
        if (!sitesData) {
            const now = Date.now();
            if (remoteDbCache && now - remoteDbLastFetch < REMOTE_DB_CACHE_TTL) {
                sitesData = remoteDbCache;
            } else if (REMOTE_DB_URL) {
                const response = await axios.get(REMOTE_DB_URL, { timeout: 5000 });
                if (response.data && Array.isArray(response.data.sites)) {
                    remoteDbCache = response.data;
                    remoteDbLastFetch = now;
                    sitesData = remoteDbCache;
                }
            }
        }
        const sites = (sitesData && sitesData.sites) || [];
        const site = sites.find(s => s.key === key);
        if (!site || !site.api) return res.json({ latency: 9999 });
        const start = Date.now();
        try {
            await axios.get(`${site.api}?ac=list&pg=1`, { timeout: 3000 });
            return res.json({ latency: Date.now() - start, _testType: 'server' });
        } catch (e) {
            return res.json({ latency: 9999 });
        }
    } catch (e) {
        return res.json({ latency: 9999 });
    }
});

// ========== API: /api/preview ==========
// 🔗 分享深链预览：未登录用户打开 /?play=剧名 时，前端用本接口拿 TMDB 简介+海报渲染"锁定框架"
//   （标题+简介+黑屏播放器+登录提示），全程不碰任何资源站。带内存缓存 + 轻量限流防刷。
const previewCache = new Map(); // name -> { data, expiry }
const PREVIEW_CACHE_TTL = 6 * 60 * 60 * 1000;   // 命中缓存 6 小时
const PREVIEW_MISS_TTL = 10 * 60 * 1000;        // 降级缓存 10 分钟
const PREVIEW_CACHE_MAX = 2000;
const previewRate = new Map();                   // ip -> [timestamps] 滑动窗口限流(serverless 内best-effort)
const PREVIEW_RATE_WINDOW = 60 * 1000;
const PREVIEW_RATE_MAX = 40;                      // 每 IP 每分钟最多 40 次
// 全站 TMDB 调用封顶：即使伪造 X-Forwarded-For 绕过单 IP 限流 + 用不同 name 绕过缓存，也无法无限放大 TMDB 调用
let previewTmdbWindowStart = 0, previewTmdbCount = 0;
const PREVIEW_TMDB_WINDOW = 60 * 1000;
const PREVIEW_TMDB_MAX = 300;
function previewTmdbBudgetOk() {
    const now = Date.now();
    if (now - previewTmdbWindowStart > PREVIEW_TMDB_WINDOW) { previewTmdbWindowStart = now; previewTmdbCount = 0; }
    if (previewTmdbCount >= PREVIEW_TMDB_MAX) return false;
    previewTmdbCount++;
    return true;
}
app.get('/api/preview', async (req, res) => {
    // 轻量限流：每 IP 每分钟 40 次
    try {
        const ip = getClientIP(req) || req.ip || '0.0.0.0';
        const now = Date.now();
        const arr = (previewRate.get(ip) || []).filter(t => now - t < PREVIEW_RATE_WINDOW);
        if (arr.length >= PREVIEW_RATE_MAX) {
            return res.status(429).json({ error: '预览请求过于频繁，请稍后再试' });
        }
        arr.push(now);
        previewRate.set(ip, arr);
        if (previewRate.size > 5000) { const k = previewRate.keys().next().value; if (k !== undefined) previewRate.delete(k); }
    } catch (e) { /* 限流失败不阻断 */ }

    const name = String(req.query.name || '').slice(0, 100).trim();
    if (!name) return res.json({ name: '', title: '', synopsis: '', poster: '', year: '' });

    const cached = previewCache.get(name);
    if (cached && cached.expiry > Date.now()) {
        res.set('Cache-Control', 'public, max-age=3600');
        return res.json(cached.data);
    }

    const data = { name, title: name, synopsis: '', poster: '', year: '' };
    try {
        if (TMDB_API_KEY && previewTmdbBudgetOk()) {
            // 预览为非关键路径：按是否配置代理决定 base，跳过逐请求 geo-IP 查询(可达 3s)，避免拖慢/函数超时
            const TMDB_BASE = TMDB_PROXY_URL
                ? `${TMDB_PROXY_URL.replace(/\/$/, '')}/api/3`
                : 'https://api.themoviedb.org/3';
            const r = await axios.get(`${TMDB_BASE}/search/multi`, {
                params: { api_key: TMDB_API_KEY, language: 'zh-CN', query: name },
                timeout: 2500
            });
            const results = (r.data && r.data.results) || [];
            const hit = results.find(x => (x.poster_path || x.backdrop_path) && x.overview)
                || results.find(x => x.poster_path || x.backdrop_path)
                || results[0];
            if (hit) {
                data.title = hit.title || hit.name || name;
                data.synopsis = hit.overview || '';
                if (hit.poster_path || hit.backdrop_path) data.poster = `https://image.tmdb.org/t/p/w500${hit.poster_path || hit.backdrop_path}`;
                const d = hit.release_date || hit.first_air_date || '';
                data.year = d ? String(d).slice(0, 4) : '';
            }
        }
    } catch (e) { /* 忽略，返回降级数据(仅剧名) */ }

    if (previewCache.size >= PREVIEW_CACHE_MAX) {
        const firstKey = previewCache.keys().next().value;
        if (firstKey !== undefined) previewCache.delete(firstKey);
    }
    const ttl = (data.synopsis || data.poster) ? PREVIEW_CACHE_TTL : PREVIEW_MISS_TTL;
    previewCache.set(name, { data, expiry: Date.now() + ttl });

    res.set('Cache-Control', 'public, max-age=3600');
    return res.json(data);
});

// ========== API: /api/danmaku ==========
// 🗨️ 弹幕代理：剧名+集名 → 自建 danmu_api(兼容弹弹play，聚合主流平台弹幕) → 转 DPlayer v3 格式。
//   DPlayer 会 GET /api/danmaku/v3/?id=<剧名|集名>。需配置 DANMU_API_URL；未配置则返回空弹幕(优雅降级)。
const danmakuCache = new Map();
const danmakuSearchCache = new Map(); // norm(剧名) -> { animes, expiry } 同剧各集复用搜索结果
const DANMAKU_CACHE_TTL = 30 * 60 * 1000;
const DANMAKU_MISS_TTL = 90 * 1000; // 空结果只缓存 90s：弹幕空多为上游限流瞬时失败，短缓存让下次很快重试成功
const DANMAKU_CACHE_MAX = 1000;
const DANMAKU_MAX = 12000; // 单集弹幕上限(超出按时间均匀采样)。提到 1.2w 让峰值更密、"海量弹幕"开关效果明显
const DANMAKU_SEARCH_TTL = 3 * 60 * 1000; // danmu_api 的 episodeId 会过期(实测<10min)，搜索结果只短存，防复用过期id取到空弹幕
let danmakuWinStart = 0, danmakuWinCount = 0;
function danmakuBudgetOk() {
    const now = Date.now();
    if (now - danmakuWinStart > 60000) { danmakuWinStart = now; danmakuWinCount = 0; }
    if (danmakuWinCount >= 300) return false;
    danmakuWinCount++;
    return true;
}
function dandanToDplayer(comments) {
    const modeMap = { '1': 0, '6': 0, '5': 1, '4': 2 };
    const out = [];
    for (const c of (comments || [])) {
        const p = String(c.p || '').split(',');
        if (p.length < 3) continue;
        const t = parseFloat(p[0]);
        if (!isFinite(t)) continue;
        out.push([t, (modeMap[p[1]] != null ? modeMap[p[1]] : 0), parseInt(p[2], 10) || 16777215, '', String(c.m || '')]);
    }
    return out;
}
// ⬇️ 弹幕匹配函数群与 server.js 完全同源(从 server.js 移植,修一处必须两处同步)——此前 Vercel 版是远古匹配器,
//    盲取 animes[0] + 裸数字匹配,零防线(对抗审查实锤:零名字交集的节目直接按集号命中)。
function danmakuCn2Num(t) {
    // 中文数字/阿拉伯数字 → int("一/十二/二十三/一百零五"，集数场景到几百足够)
    t = String(t || '');
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let n = 0, cur = 0, any = false;
    for (const ch of t) {
        if (D[ch] != null) { cur = D[ch]; any = true; }
        else if (ch === '十') { n += (cur || 1) * 10; cur = 0; any = true; }
        else if (ch === '百') { n += (cur || 1) * 100; cur = 0; any = true; }
        else return null;
    }
    return any ? n + cur : null;
}
function danmakuEpNum(s) {
    // 优先取"第N集/话/期"里的 N(支持中文数字"第一集"；忽略"破事精英2第17集"里的剧名数字2)；取不到再退回第一个数字
    const str = String(s || '');
    let m = str.match(/第\s*0*(\d+)\s*[集话話期]/);
    if (m) return parseInt(m[1], 10);
    m = str.match(/第\s*([一二两三四五六七八九十百零]+)\s*[集话話期]/);
    if (m) { const n = danmakuCn2Num(m[1]); if (n != null) return n; }
    const m2 = str.match(/\d+/);
    return m2 ? parseInt(m2[0], 10) : null;
}
// 集名先剥离【同内容标签】(语言/画质/权益标注，不改变内容本体)——"第24集(会员版)"就是第24集、"第10期 中字"就是第10期，
//   拉丁标签(HD/BD/1080P/HDR…)要求【词边界】且允许连写，防误剥 BTS/HDTV/CATCH；剥后残留仅剩数字(+版/帧)且【确实剥过标签】视同全标签(电影 "BD1280高清";裸集号 02/03 不清)。
const DANMAKU_LABEL_LATIN = /(?<![A-Za-z0-9])(?:HDR|HD|BD|TC|TS|HC|UHD|SD|DVD|WEB-?DL|WEBRip|BluRay|REMUX|\d{3,4}[Pp]|[48][Kk])+(?![A-Za-z])/gi;
const DANMAKU_LABEL_CN = /(中文字幕|中字|双字|双语|国语|粤语|台配|日语|韩语|英语|无水印|完整版|会员加长版|加长版|未删减|超清|高清|蓝光|标清|修复版|导演剪辑版|杜比视界|会员版|超前点播|超前版|抢先版|点映版|点映|VIP版?)/g;
function danmakuCleanEpName(s) {
    const orig = String(s || '');
    let r = orig.replace(DANMAKU_LABEL_LATIN, '').replace(DANMAKU_LABEL_CN, '');
    if (r !== orig && !/[集话話期]/.test(r) && /^[\s·]*\d{2,4}[\s·]*(?:版|帧|周年?)?[\s·]*$/.test(r)) r = '';
    return r;
}
// 变体词(正片的不同剪辑/子场,时间轴不同 → 须精确匹配,不回落正片)；额外内容(与正片时间轴完全无关 → 只配同类)。
//   刻意【不含】会员/超前/抢先(会员版/超前点播/抢先版是标签,已由 DANMAKU_LABEL_CN 剥掉;裸"会员福利"是看点)、
//   【不含】幕后/反应(连锁反应/幕后玩家是真实片名/剧名,极易误判)——对抗审查三轮抓出的高频误伤词。
const DM_VARIANT = '纯享|加更|特辑|发布会|见面会|专场|访谈|饭局|plus';
const DM_EXTRA = '先导|预告|彩蛋|花絮|片花|直拍|reaction|repo';
const DM_VAR_RE = new RegExp('^(?:' + DM_VARIANT + ')', 'i');
const DM_EXTRA_RE = new RegExp('^(?:' + DM_EXTRA + ')', 'i');
const DM_TOK_VAR = new RegExp('^(?:' + DM_VARIANT + ')$', 'i');
// 额外内容【标签形态】：可选短前缀(独家/幕后/正片…) + 额外词 + 可选后缀(片/版/集锦…)。用于识别 "独家花絮"/"第5集独家花絮"/"预告片",
//   但不误判 "末日预告"/"连锁反应"(内容词+关键词,前缀不在白名单)。
const DM_EXTRA_LABEL = new RegExp('^(?:独家|幕后|正片|精彩|完整|删减|未播|拍摄|花絮|片花)?(?:' + DM_EXTRA + ')(?:片|版|集锦|合集|篇|特辑)?$', 'i');
const dmExtraKw = str => { const km = String(str).match(new RegExp('(?:' + DM_EXTRA + ')', 'i')); return km ? km[0].toLowerCase() : ''; };
const DM_SEP = /[\s:：,，、;；。•‧＆&|/·\-—~～!！?？()（）【】\[\]「」『』"']/;
// 🎪 集名 → { num, date, split, variant, extra, extraKw, bare, residual }。
//   **关键(对抗审查三轮的核心)**:标记(上中下/纯享/预告/幕后…)只从【结构位置】认——紧贴集号/期号 token(glued)或独立成 token(分隔围起的纯标记),
//   绝不从自由文本副标题里扫。所以"第6集 幕后黑手"/"第5期 聊聊人生"/"幕后玩家"(电影) 的关键词都是内容,不当额外/变体 → 照常按集号/正片匹配,不丢弹幕。
function danmakuMarkers(s) {
    const raw = danmakuCleanEpName(s);
    const isDrama = /第\s*(?:\d+|[一二两三四五六七八九十百零]+)\s*[集话話]/.test(raw);
    const mdOk = (mm, dd) => +mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31;
    const pad = v => String(v).padStart(2, '0');
    let date = null, tokEnd = -1, dateStart = -1, dateEnd = -1, m;
    // dateStart 取【首个数字】位置(带 (?:^|\D) 前缀的规则 m.index 会多含一个非数字字符);dateEnd=日期 token 终点,供 num 去污染判独立性
    const dSpan = () => { dateStart = m.index + m[0].indexOf(m[1]); dateEnd = m.index + m[0].length; };
    if (isDrama) { const um = raw.match(/第\s*(?:\d+|[一二两三四五六七八九十百零]+)\s*[集话話]/); tokEnd = um.index + um[0].length; }
    else {
        if ((m = raw.match(/(?:^|\D)(\d{4})(\d{2})(\d{2})(?=\D|$)/)) && mdOk(m[2], m[3])) { date = m[1] + m[2] + m[3]; dSpan(); tokEnd = dateEnd; }
        else if ((m = raw.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})(?=\D|$)/)) && mdOk(m[2], m[3])) { date = m[1] + m[2] + m[3]; dSpan(); tokEnd = dateEnd; }
        else if ((m = raw.match(/(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/)) && mdOk(m[2], m[3])) { date = m[1] + pad(m[2]) + pad(m[3]); dSpan(); tokEnd = dateEnd; }
        // "2017年7月1日"式:必须排在纯月日规则【之前】——否则年份被丢、date 只剩4位月日,绕过②的年份门禁(对抗审查实锤:事故B机制原样复活)
        else if ((m = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/)) && mdOk(m[2], m[3])) { date = m[1] + pad(m[2]) + pad(m[3]); dSpan(); tokEnd = dateEnd; }
        else if ((m = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/)) && mdOk(m[1], m[2])) { date = pad(m[1]) + pad(m[2]); dSpan(); tokEnd = dateEnd; }
        else if ((m = raw.match(/(?:^|\D)(\d{2})(\d{2})\s*期/)) && mdOk(m[1], m[2])) { date = m[1] + m[2]; dSpan(); tokEnd = dateEnd; }
        // "2026-03期"月刊式:date=YYYYMM(6位,自然纳入②的年份门禁,只与同为YYYYMM的条目相等)。
        //   不识别的话 danmakuEpNum 回退首数字=年份2026,同年所有月份塌缩同号→固定串到第一期(对抗审查实锤)
        else if ((m = raw.match(/(\d{4})\s*[-./年]\s*(\d{1,2})\s*期/)) && +m[2] >= 1 && +m[2] <= 12) { date = m[1] + pad(m[2]); dSpan(); tokEnd = dateEnd; }
        const qi = raw.match(/第?\s*(?:\d{1,8}|[一二两三四五六七八九十百零]+)\s*期/);
        if (qi) tokEnd = Math.max(tokEnd, qi.index + qi[0].length);   // 期与日期并存(第5期20260101)取靠后者,别把日期当 residual
    }
    // 合集/连播条目(第1-2集 / 第2、3集 / 第1-2期)：时间轴=两集拼接,绝不能被单集号命中(错配)。num 置空 → 只能靠 ①a 原文全等(归一保留连字符)匹配同款合集。
    // 合集范围:两侧集/期号≤3位(4位是年份,"2026-01期"是月刊不是合集,别误判)
    const isRange = /(?<!\d)(?:\d{1,3}|[一二两三四五六七八九十百零]+)\s*[-—~～、,，]\s*(?:\d{1,3}|[一二两三四五六七八九十百零]+)\s*[集话話期]/.test(raw);
    let num = isRange ? null : danmakuEpNum(raw);
    // 🚨 num 去污染:集名带日期 token 时,num 只认【日期 token 之外】的独立 第N期/集 号。否则"6月24日"的 num=6(月份)
    //   会在源候选是纯期号式(日期配不上,②按设计不终结)时经③系统性撞上"第6期";"2026-03期"同理(num=年份)。
    //   "第5期20260101"/"20260101第5期"混合式的 5 来自日期 span 之外的独立 token,不受影响。
    if (num != null && date && dateStart >= 0 && !isDrama) {
        const indep = [...raw.matchAll(/第?\s*(?:0*\d{1,8}|[一二两三四五六七八九十百零]+)\s*[集话話期]/g)]
            .some(mm => mm.index >= dateEnd || mm.index + mm[0].length <= dateStart);
        if (!indep) num = null;
    }
    let split = '', variant = '', extra = false, extraKw = '', residual = false;
    if (tokEnd >= 0) {
        // 有 num/date/期/集 token：① glued run(token 紧贴其后到首分隔符,逐段剥前导标记) ② 独立 token(纯标记才认,否则 residual)
        const after = raw.slice(tokEnd), sepIdx = after.search(DM_SEP);
        let g = sepIdx < 0 ? after : after.slice(0, sepIdx);
        for (; g;) {
            if ((m = g.match(DM_VAR_RE))) { variant += m[0].toLowerCase(); g = g.slice(m[0].length); continue; }
            if ((m = g.match(DM_EXTRA_RE))) { extra = true; extraKw += m[0].toLowerCase(); g = g.slice(m[0].length); continue; }
            if ((m = g.match(/^([上中下])(?=$|[上中下]|[^一-龥])/))) { split += m[1]; g = g.slice(1); continue; }
            break;
        }
        const toks = ((g ? g + ' ' : '') + (sepIdx < 0 ? '' : after.slice(sepIdx))).split(DM_SEP).map(t => t.trim()).filter(Boolean);
        for (const tok of toks) {
            const core = tok.replace(/[集部篇赛场]+$/, '');
            if (/^[上中下]+$/.test(core)) split += core;
            else if (DM_TOK_VAR.test(core)) variant += core.toLowerCase();
            else if (DM_EXTRA_LABEL.test(tok) || DM_EXTRA_LABEL.test(core)) { extra = true; extraKw += dmExtraKw(tok); }   // "独家花絮"/"预告片" 等标签形态也认(修 第5集独家花絮 被当正片)
            else residual = true;
        }
    } else {
        // 无 num/date/期/集 token：纯 上集/下集(→split)、纯变体(→variant)、【标签形态】的额外内容(→extra)。
        //   额外只认"预告片/独家花絮/幕后花絮/花絮/彩蛋合集"这类【(可选短前缀)+额外词+(可选 片/版/集锦)】,
        //   绝不把"末日预告/终极预告/连锁反应"这种正常片名(内容词+关键词结尾)误判(对抗审查抓出的电影丢弹幕)。
        const w = raw.replace(/[集部篇赛场]+$/, '');
        if (/^[上中下]+$/.test(w)) split = w;
        else if (DM_TOK_VAR.test(w)) variant = w.toLowerCase();
        else if (DM_EXTRA_LABEL.test(raw) || DM_EXTRA_LABEL.test(w)) { extra = true; extraKw = dmExtraKw(raw); }
    }
    const bare = tokEnd >= 0 && !split && !variant && !extra && !residual;
    return { num, date, split, variant, extra, extraKw, bare, residual, range: isRange };
}
// 归一集名：去空格/括号/标点(小写)。数字间的连字符保留——"第1-2集"(合集)不能归一成"第12集"(对抗审查抓出的假命中)
function danmakuNormEp(s) { return String(s || '').replace(/[-—_](?!\d)|(?<!\d)[-—_]|[\s()（）\[\]【】·:：~～!！?？"'「」『』]/g, '').toLowerCase(); }
function danmakuDateEq(a, b) { return !!a && !!b && (a === b || a.endsWith(b) || b.endsWith(a)); }
function danmakuSufEq(a, b) { return a === b || (!!a && !!b && (a.includes(b) || b.includes(a))); }
// episodes: [{episodeId,episodeTitle}]。epName=资源站集名。preferYear='2026'(可选,跨年同月日消歧)。
function pickDanmakuEpisode(episodes, epName, preferYear) {
    if (!episodes || !episodes.length) return null;
    const rawNorm = danmakuNormEp(epName || '');
    const cleaned = danmakuCleanEpName(epName || '').trim();
    const parts = episodes.map(e => ({ e, m: danmakuMarkers(e.episodeTitle), raw: danmakuNormEp(e.episodeTitle), n: danmakuNormEp(danmakuCleanEpName(e.episodeTitle)) }));
    // ①a 原文归一全等(不剥标签)：'第8期'配'第8期'不配'第8期会员版'；双语电影'粤语'配'粤语'不配'国语'
    let hit = rawNorm && parts.find(x => x.raw === rawNorm);
    if (hit) return hit.e;
    // ①b 剥标签后归一全等：跨写法('第10期(下)'↔'第10期下')、剥标签后同名
    const wn = danmakuNormEp(cleaned);
    hit = wn && parts.find(x => x.n && x.n === wn);
    if (hit) return hit.e;
    const want = danmakuMarkers(epName);
    want._norm = wn;   // 供 danmakuMoviePick 对多影片捆绑做模糊命中
    // 合集(第1-2期/第1-2集):时间轴=多集拼接,①a/①b 全等没配上就到此为止——绝不落入 moviePick,
    // 否则回退候选(同名电影/衍生片)的"正片"/唯一条目会被合集集名直接拿下(对抗审查实锤:两期综艺合集铺电影弹幕)
    if (want.range) return null;
    if (!epName || !cleaned) return danmakuMoviePick(parts, want);
    if (want.num == null && want.date == null) {
        if (want.split && !want.variant && !want.extra && !want.residual) {   // 纯"上集/下集/中集"→ 序数映射到正片
            const mains = parts.filter(x => !x.m.extra), bs = mains.find(x => x.m.split === want.split);
            if (bs) return bs.e;
            if (want.split === '中') return mains.length === 3 ? mains[1].e : null;
            if (mains.length >= 2 && mains.length <= 3) return want.split === '上' ? mains[0].e : mains[mains.length - 1].e;
            return null;
        }
        return danmakuMoviePick(parts, want);   // 电影/无结构
    }
    // 同号/同期候选池里按 变体/拆分/额外 挑
    const pick = (pool) => {
        const nonExtra = pool.filter(x => !x.m.extra), extras = pool.filter(x => x.m.extra);
        if (want.extra) {   // 我方是额外内容：只在额外条目里按子类型(花絮/预告/彩蛋)配
            if (!extras.length) return null;
            const same = extras.find(x => x.m.extraKw && want.extraKw && danmakuSufEq(want.extraKw, x.m.extraKw));
            if (same) return same.e;
            return (extras.length === 1 && !want.extraKw) ? extras[0].e : null;
        }
        if (want.variant) {   // 我方是变体(纯享/特辑…)：须同变体(精确/包含),缺则 null(绝不回落正片,时间轴不同)
            let h = nonExtra.find(x => x.m.variant === want.variant && x.m.split === want.split);
            if (h) return h.e;
            const compat = nonExtra.filter(x => x.m.variant && danmakuSufEq(want.variant, x.m.variant) && x.m.split === want.split);
            if (compat.length) { compat.sort((a, b) => b.m.variant.length - a.m.variant.length); return compat[0].e; }
            return null;
        }
        const bareSrc = nonExtra.find(x => x.m.bare);   // 源里【干净整集】条目(无拆分/变体/副标题) → 回落只认它,不认 上期回顾/下期精选 这种带副标题的异内容
        if (want.split) {   // 我方是 上/中/下 拆分
            const h = nonExtra.find(x => x.m.split === want.split && !x.m.variant);
            if (h) return h.e;
            if (nonExtra.some(x => x.m.split && !x.m.variant)) return null;   // 源本身按上中下拆分,但没我方这半 → 宁可没有
            // 源没拆分只有干净整集:仅"上"(与整集开头对齐)回落整集;"中/下"整集弹幕会整体前移半集偏移 → 宁可没有不错配
            return (want.split === '上' && bareSrc) ? bareSrc.e : null;
        }
        // 我方无标记：优先干净整集 → 同号唯一非拆分条目(可能带看点副标题,同集) → 纯期号(bare)时容忍源的 上/中/下 拆分取上
        if (bareSrc) return bareSrc.e;
        const plainish = nonExtra.filter(x => !x.m.split && !x.m.variant);
        if (plainish.length === 1) return plainish[0].e;
        if (want.bare) { const sp = nonExtra.filter(x => x.m.split && !x.m.variant); if (sp.length) { sp.sort((a, b) => '上中下'.indexOf(a.m.split[0]) - '上中下'.indexOf(b.m.split[0])); return sp[0].e; } }
        return null;
    };
    // ② 日期式期号(综艺)：同月日跨年 → 优先 preferYear、否则取最新一年；日期配不上【不终结】继续走 ③
    if (want.date) {
        let sd = parts.filter(x => danmakuDateEq(want.date, x.m.date));
        // 🚨 我方带明确年份(6/8位,如"第20170624期")：只认同样带年份且【同年同月日】(yymmdd 后缀相等)的集。
        //   纯月日式("0624期")一概不配——dateEq 的 endsWith 会让【任意年份】的同月日撞上;实测事故:
        //   iqiyi 正主瞬时限流返回空 → 候选回退到杂牌同名条目 → 其"0701期"式集名撞月日 → 拿到完全无关
        //   节目(转生史莱姆日记)的弹幕,再被 服务器+CDN+浏览器 三层缓存固化 7 天。宁可没有不错配。
        //   (纯月日 want——源站本来就只写"0624期"——保持原宽松逻辑,preferYear/最新年消歧。)
        if (sd.length && want.date.length >= 6) {
            const w6 = want.date.slice(-6);
            sd = sd.filter(x => x.m.date.length >= 6 && x.m.date.slice(-6) === w6);
        }
        if (sd.length) {
            const py = String(preferYear || ''), yy = py.slice(2);
            const byYear = py ? sd.filter(x => (x.m.date.length >= 8 && x.m.date.startsWith(py)) || (x.m.date.length === 6 && yy && x.m.date.startsWith(yy))) : [];
            if (byYear.length) sd = byYear;
            else { sd.sort((a, b) => (b.m.date.length - a.m.date.length) || b.m.date.localeCompare(a.m.date)); const latest = sd[0].m.date; sd = sd.filter(x => x.m.date === latest); }
            const r = pick(sd);
            if (r) return r;
            if (want.split || want.variant || want.extra) return null;
        }
    }
    // ③ 数字期/集号
    if (want.num != null) {
        const r = pick(parts.filter(x => x.m.num === want.num && !x.m.date));
        if (r) return r;
        if (want.split || want.variant || want.extra) return null;
        // 索引兜底：纯数字/第N集话/EP 且弹幕源集标题全无数字/日期,按序取第 N 个(目标位非额外内容)
        const numericSelf = (/[集话話]/.test(cleaned) || /^\s*(?:ep\.?\s*)?0*\d+\s*$/i.test(cleaned)) && !/期/.test(cleaned);
        if (numericSelf && !parts.some(x => x.m.num != null || x.m.date || x.m.range)) {
            // 按序取第 N 个,但索引到【剔除额外条目后】的数组(修:源开头挂预告片时 parts[n-1] 整体错位一集)
            const mains = parts.filter(x => !x.m.extra);
            if (want.num >= 1 && want.num <= mains.length) return mains[want.num - 1].e;
        }
        return null;
    }
    // 日期式集名(want.date)走到这=②年份门禁/日期匹配全拒——绝不落 moviePick:其"唯一条目/正片"兜底会把
    // 刚被门禁拒掉的异年候选原样捡回(对抗审查回归测试抓出的交互回归)。日期集名不是电影,宁空。
    return want.date ? null : danmakuMoviePick(parts, want);
}
// 电影/无集号兜底：我方额外内容→只配同子类型;否则 认准"正片"→唯一非额外条目→单条目。参数 parts 已含 marker。
function danmakuMoviePick(parts, want) {
    if (want && want.extra) {
        const extras = parts.filter(x => x.m.extra);
        if (!extras.length) return null;
        const same = extras.find(x => x.m.extraKw && want.extraKw && danmakuSufEq(want.extraKw, x.m.extraKw));
        if (same) return same.e;
        return (extras.length === 1 && !want.extraKw) ? extras[0].e : null;
    }
    const mains = parts.filter(x => !x.m.extra);
    const zheng = mains.find(x => /正片/.test(String(x.e.episodeTitle || '')));
    if (zheng) return zheng.e;
    if (mains.length === 1) return mains[0].e;
    if (mains.length > 1) {
        // 多条:先按 epName 模糊命中(不同影片被 danmu_api 捆在一个 anime 时,认准我方那部)
        const wn = want && want._norm;
        if (wn && wn.length >= 2) { const fz = mains.find(x => x.n && (x.n.includes(wn) || wn.includes(x.n))); if (fz) return fz.e; }
        // 剥标签后都为空/彼此相同 → 同片的版本(国语/粤语/画质,时间轴一致)取任一;否则是不同影片 → 宁可没有不错配
        const names = mains.map(x => danmakuCleanEpName(x.e.episodeTitle).trim());
        return names.every(n => !n || n === names[0]) ? mains[0].e : null;
    }
    return null;   // 源全是额外条目(预告/花絮),我方要正片 → 宁可没有(不拿预告弹幕铺正片)
}
// 从【一个 danmu_api 实例】取某剧某集弹幕：搜索 → 同剧多平台(iqiyi/360/...)回退 → 返回 DPlayer 数组(空=该实例没取到)
async function fetchDanmakuFromInstance(base, token, title, ep) {
    base = String(base).replace(/\/$/, '');
    const prefix = token ? `/${encodeURIComponent(token)}` : '';
    const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
    // 🏷️ danmu_api 的 animeTitle 常带 " from 平台" 尾巴——不剥掉的话 core/norm 精确档【永远打不中】,
    //    一切都掉进包含档(对抗审查实锤:韩国版/杂牌因此与正主同档,平台排序反而让错剧排前)。
    const stripFrom = s => String(s || '').replace(/\s+from\s+[a-z0-9_]+\s*$/i, '');
    const core = s => norm(String(stripFrom(s)).split(/[(（【\[]/)[0]);
    const normT = s => norm(stripFrom(s));
    const nt = norm(title), ct = core(title);
    // 搜索结果按【实例+剧名】缓存：不同实例的 episodeId 体系不同，key 必须带 base，否则串实例取到失效 id
    let animes;
    const skey = base + '||' + nt;
    const sc = danmakuSearchCache.get(skey);
    if (sc && sc.expiry > Date.now()) { animes = sc.animes; }
    else {
        const _s0 = Date.now();
        try {
            const sr = await axios.get(`${base}${prefix}/api/v2/search/episodes`, { params: { anime: title }, timeout: 20000 });
            animes = (sr.data && sr.data.animes) || [];
            console.log(`[弹幕诊断] search "${title}" @${base} → ${animes.length} animes (${Date.now() - _s0}ms)`);
        } catch (e) {
            // ECONNABORTED=超时, ECONNREFUSED=拒连, ETIMEDOUT=连不上, ENOTFOUND=DNS, 或 HTTP 4xx/5xx(被WAF/限流拦)
            console.warn(`[弹幕诊断] search "${title}" @${base} 失败: ${e.code || ''} ${e.response ? 'HTTP' + e.response.status : e.message} (${Date.now() - _s0}ms)`);
            throw e;
        }
        // ⚠️ 空 animes 不写缓存:上游限流的瞬时空若被缓存(旧 TTL 3min),外层 3s 重试和后续请求全被空快照挡住,
        //    实测全丢窗口超 3 分钟(对抗审查实锤)。不缓存空,重试才是真重试。
        if (animes.length) {
            if (danmakuSearchCache.size >= 500) { const k = danmakuSearchCache.keys().next().value; if (k !== undefined) danmakuSearchCache.delete(k); }
            danmakuSearchCache.set(skey, { animes, expiry: Date.now() + DANMAKU_SEARCH_TTL });
        }
    }
    // 季号解析成数字：认"第N季/Season N/SN" + 剧名尾部裸数字("庆余年2"/"斗破苍穹4",排除 19xx/20xx 年份)。"第2季"="第二季"=Season2=S2。
    //   注意对 animeTitle 先 stripFrom——"庆余年2 from qq" 的尾裸数字判定会被 from 尾巴击穿(对抗审查实锤)。
    const yearM = String(title).match(/(?:19|20)\d{2}/);
    const seasonOf = s => { s = stripFrom(s); const m = s.match(/第\s*([0-9一二两三四五六七八九十]+)\s*季|season\s*0*(\d+)|\bS0*(\d{1,2})\b/i); if (m) return danmakuCn2Num(m[1] || m[2] || m[3]); const t = s.match(/(?<![0-9])([2-9]|1[0-9])\s*$/); return t ? parseInt(t[1], 10) : null; };
    const wantSeason = seasonOf(title);
    // 尾裸数字季号(庆余年2)去掉后用于包含匹配——否则弹幕源的"庆余年 第二季"(核心名不含"2")进不了候选,只剩第一季页 → 整季错配。
    const ctBase = wantSeason != null ? ct.replace(/([2-9]|1\d)$/, '') : ct;
    // 尾缀年份综艺名(王牌对王牌2024):去年份后才可能与"王牌对王牌 第九季"互相包含(否则正主进不了候选、只剩裸基名=第一季 → 整季串台,对抗审查实锤)
    const ctNoYear = ct.replace(/((?:19|20)\d{2})\s*$/, '');
    // 🏅 名字贴合度分档:0=精确 1=去年份精确(裸基名,弱于精确) 2=包含。排序先档后平台,回退只在最佳档内。
    const fitTier = a => {
        const c = core(a.animeTitle);
        if (!c) return 9;
        if (c === ct || normT(a.animeTitle) === nt) return 0;
        if (ctNoYear && ctNoYear !== ct && c === ctNoYear) return 1;
        if (c.includes(ct) || ct.includes(c)
            || (ctBase !== ct && ctBase && c.includes(ctBase))
            || (ctNoYear !== ct && ctNoYear && (c.includes(ctNoYear) || ctNoYear.includes(c)))) return 2;
        return 9;
    };
    let candidates = animes.filter(a => fitTier(a) < 9);
    // 🗓️ 年份偏好(在分档之前——标题带年份时,含该年份的候选是最强信号:"王牌对王牌2024"该选"第九季(2024)"而不是裸基名第一季页)
    if (candidates.length > 1 && yearM) { const withYear = candidates.filter(a => String(a.animeTitle || '').includes(yearM[0])); if (withYear.length) candidates = withYear; }
    // 🗓️ 季号/续集号：先取精确同季；没有精确同季时【无论单/多候选】剔除 裸基名(第一部/第一季)和季号明确不同的——
    //    它们是不同作品,宁可没弹幕不错配。(单候选旁路已修:明确异季的唯一候选此前会被原样保留,对抗审查实锤)
    if (wantSeason != null && candidates.length) {
        const exact = candidates.filter(a => seasonOf(a.animeTitle) === wantSeason);
        if (exact.length) candidates = exact;
        else candidates = candidates.filter(a => { const s = seasonOf(a.animeTitle); return (s == null || s === wantSeason) && core(a.animeTitle) !== ctBase; });
    }
    const platOf = s => { const m = String(s || '').match(/from\s+([a-z0-9]+)/i); return m ? m[1].toLowerCase() : ''; };
    const PLAT_RANK = { iqiyi: 0, qq: 1, tencent: 1, youku: 2, bilibili: 3, mango: 4, imgo: 4, '360': 5, migu: 9 };
    // 排序:贴合档优先,同档才比平台弹幕量;回退循环只在【最佳档】内轮换——iqiyi 正主瞬时空 → 同档 qq 接棒(合法多平台回退),
    // 绝不落到包含档杂牌(对抗审查实锤:正主瞬时空时杂牌错弹幕被回退捡走并 LONG_CACHE 固化 7 天)。
    candidates.sort((a, b) => (fitTier(a) - fitTier(b)) || ((PLAT_RANK[platOf(a.animeTitle)] ?? 6) - (PLAT_RANK[platOf(b.animeTitle)] ?? 6)));
    const bestTier = candidates.length ? fitTier(candidates[0]) : 9;
    const pool = candidates.filter(a => fitTier(a) === bestTier);
    const preferYear = yearM ? yearM[0] : null;   // 跨年同月日消歧(回看旧季不误取新季)
    for (let tries = 0; tries < pool.length && tries < 3; tries++) {
        const episode = pickDanmakuEpisode(pool[tries].episodes, ep, preferYear);
        if (!episode || !episode.episodeId) continue;
        const _c0 = Date.now();
        try {
            const cr = await axios.get(`${base}${prefix}/api/v2/comment/${episode.episodeId}`, { params: { withRelated: 'true', chConvert: '0' }, timeout: 25000 });
            const d = dandanToDplayer((cr.data && cr.data.comments) || []);
            console.log(`[弹幕诊断] comment/${episode.episodeId} (${platOf(pool[tries].animeTitle) || '?'}) → ${d.length} 条 (${Date.now() - _c0}ms)`);
            if (d.length) { d._tier = bestTier; return d; }   // _tier 供端点分级缓存:包含档结果不给 7 天长缓存
        } catch (e) { console.warn(`[弹幕诊断] comment/${episode.episodeId} 失败: ${e.code || ''} ${e.response ? 'HTTP' + e.response.status : e.message} (${Date.now() - _c0}ms)`); }
    }
    return [];
}
app.get('/api/danmaku/v3/', async (req, res) => {
    const empty = { code: 0, version: 3, data: [], msg: '' };
    // 空/出错一律 no-store：绝不让 CDN/浏览器缓存"暂时为空"的弹幕(防 CF 1年TTL 把空响应永久冻结)；
    //   服务器侧 90s miss 缓存护住上游。非空弹幕→7天新鲜+30天 stale-while-revalidate(过期先回旧缓存、后台重抓)。
    // 缓存键=?id=剧名|集名(稳定)；勿缓存 danmu_api 的 comment/{id}(id会过期)
    const LONG_CACHE = 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=2592000';
    res.set('Cache-Control', 'no-store');
    const DANMU_API_URL = process.env.DANMU_API_URL;
    if (!DANMU_API_URL) return res.json(empty);

    let title = '', ep = '';
    try { const parts = String(req.query.id || '').split('|'); title = (parts[0] || '').trim(); ep = (parts[1] || '').trim(); } catch (e) { }
    if (!title) return res.json(empty);

    const cacheKey = title + '|' + ep;
    const cached = danmakuCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) { if (cached.data.length) res.set('Cache-Control', LONG_CACHE); return res.json({ code: 0, version: 3, data: cached.data, msg: '' }); }
    if (!danmakuBudgetOk()) return res.json(empty);

    try {
        // 多源回退：DANMU_API_URL 逗号分隔多个实例(不同出口IP绕开限流)；DANMU_API_TOKEN 逗号分隔配对或单 token 共用
        const bases = String(DANMU_API_URL).split(',').map(s => s.trim()).filter(Boolean);
        const tokens = String(process.env.DANMU_API_TOKEN || '').split(',').map(s => s.trim());
        const instances = bases.map((b, i) => ({ base: b, token: tokens.length > 1 ? (tokens[i] || '') : (tokens[0] || '') }));
        // 🏁 并行赛跑：第一个【高贴合(_tier≤1)非空】立即采用；包含档(_tier≥2)结果压 1.5s 等更好的——
        //    防降级实例的杂牌错弹幕抢跑赢过健康实例的正主弹幕(与 server.js 同源修复)。
        const raceInstances = () => new Promise(resolve => {
            if (!instances.length) return resolve([]);
            let pending = instances.length, held = null, timer = null, done = false;
            const finish = v => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(v); };
            for (const inst of instances) {
                fetchDanmakuFromInstance(inst.base, inst.token, title, ep)
                    .then(d => {
                        if (d && d.length) {
                            if ((d._tier ?? 9) <= 1) return finish(d);
                            if (!held) { held = d; timer = setTimeout(() => finish(held), 1500); }
                        }
                    })
                    .catch(() => { })
                    .finally(() => { if (--pending === 0) finish(held || []); });
            }
        });
        let data = await raceInstances();
        // 全部实例空 → 多为上游限流瞬时空：等 3s 再赛一轮(Vercel 有 10s 函数上限，谨慎;搜索级空快照已不缓存,重试是真重试)
        if (!data.length && instances.length) {
            await new Promise(r => setTimeout(r, 3000));
            data = await raceInstances();
        }
        // 包含档(杂牌名字沾边)结果置信低:只缓存 10 分钟,不给 7 天长缓存(错了也只错一阵)
        const lowConf = !!(data && data.length && (data._tier ?? 9) >= 2);
        data.sort((a, b) => a[0] - b[0]); // 先按时间升序，保证下面按索引均匀采样=按时间均匀采样(后半段不丢)
        if (data.length > DANMAKU_MAX) { const step = data.length / DANMAKU_MAX, s = []; for (let i = 0; i < DANMAKU_MAX; i++) s.push(data[Math.floor(i * step)]); data = s; }
        if (danmakuCache.size >= DANMAKU_CACHE_MAX) { const k = danmakuCache.keys().next().value; if (k !== undefined) danmakuCache.delete(k); }
        danmakuCache.set(cacheKey, { data, expiry: Date.now() + (data.length ? (lowConf ? 10 * 60 * 1000 : DANMAKU_CACHE_TTL) : DANMAKU_MISS_TTL) });
        if (data.length) res.set('Cache-Control', lowConf ? 'public, max-age=600, s-maxage=600' : LONG_CACHE);
        return res.json({ code: 0, version: 3, data, msg: '' });
    } catch (e) {
        console.error('[弹幕] 获取失败:', e.message);
        return res.json(empty);
    }
});
app.post('/api/danmaku/v3/', (req, res) => res.json({ code: 0, msg: '' }));

// ========== API: /api/config ==========
app.get('/api/config', (req, res) => {
    const userToken = req.query.token || '';
    const userInfo = PASSWORD_HASH_MAP[userToken];
    const syncEnabled = userInfo ? userInfo.syncEnabled : false;

    res.json({
        tmdb_api_key: TMDB_API_KEY,
        tmdb_proxy_url: TMDB_PROXY_URL,
        enable_local_image_cache: false, // Vercel 不支持本地缓存
        sync_enabled: syncEnabled,
        multi_user_mode: ACCESS_PASSWORDS.length > 1,
        danmaku_enabled: !!process.env.DANMU_API_URL,  // 🗨️ 弹幕开关
        // 📮 求片：Vercel 无持久 SQLite、不适合求片(需站长长期履行)→ 始终关闭，仅 VPS(server.js) 支持
        requests_enabled: false
    });
});

// ========== API: /api/debug (健康检查；不再泄露 env 状态/密钥/REMOTE_DB_URL 等敏感信息) ==========
app.get('/api/debug', (req, res) => {
    res.json({
        status: 'ok',
        environment: 'Vercel Serverless',
        timestamp: new Date().toISOString()
    });
});

// 注：原 /api/env-test 诊断端点会泄露密码长度、环境变量 key 列表等敏感信息，已移除。

// ========== API: /api/auth/check ==========
app.get('/api/auth/check', (req, res) => {
    res.json({
        requirePassword: ACCESS_PASSWORDS.length > 0,
        multiUserMode: ACCESS_PASSWORDS.length > 1
    });
});

// ========== API: /api/auth/verify ==========
app.post('/api/auth/verify', (req, res) => {
    const { password, passwordHash } = req.body;

    if (ACCESS_PASSWORDS.length === 0) {
        return res.json({ success: true, syncEnabled: false });
    }

    const hash = passwordHash || crypto.createHash('sha256').update(password || '').digest('hex');
    const userInfo = PASSWORD_HASH_MAP[hash];

    if (userInfo) {
        return res.json({
            success: true,
            passwordHash: hash,
            syncEnabled: userInfo.syncEnabled,
            userIndex: userInfo.index
        });
    } else {
        return res.json({ success: false });
    }
});

// ========== API: /api/tmdb-proxy ==========
app.get('/api/tmdb-proxy', async (req, res) => {
    const { path: tmdbPath, ...params } = req.query;

    if (!tmdbPath) {
        return res.status(400).json({ error: 'Missing path' });
    }

    if (!TMDB_API_KEY) {
        return res.status(500).json({ error: 'TMDB API Key not configured' });
    }

    // 构建缓存 Key
    const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const cacheKey = `${tmdbPath}_${sortedParams}`;

    // 检查缓存
    const cached = tmdbCache.get(cacheKey);
    if (cached && Date.now() - cached.time < TMDB_CACHE_TTL) {
        return res.json(cached.data);
    }

    try {
        // 判断是否来自中国大陆（支持 X-Client-Public-IP 头和私有 IP 检测）
        let useProxy = false;
        if (TMDB_PROXY_URL) {
            useProxy = await isChineseIP(req);
        }

        const TMDB_BASE = useProxy
            ? `${TMDB_PROXY_URL.replace(/\/$/, '')}/api/3`  // 代理需要 /api/3 前缀
            : 'https://api.themoviedb.org/3';  // 海外用户直连官方 API

        const response = await axios.get(`${TMDB_BASE}${tmdbPath}`, {
            params: {
                ...params,
                api_key: TMDB_API_KEY,
                language: 'zh-CN'
            },
            timeout: 15000  // 增加超时时间（代理可能较慢）
        });

        // 缓存结果
        tmdbCache.set(cacheKey, { data: response.data, time: Date.now() });

        // 限制缓存大小 (防止内存溢出)
        if (tmdbCache.size > 1000) {
            const firstKey = tmdbCache.keys().next().value;
            tmdbCache.delete(firstKey);
        }

        res.json(response.data);
    } catch (err) {
        console.error('[TMDB Proxy Error]', err.message);
        res.status(err.response?.status || 500).json({ error: 'Proxy request failed' });
    }
});

// ========== API: /api/tmdb-image (图片代理 - 仅流式转发) ==========
app.get('/api/tmdb-image/:size/:filename', async (req, res) => {
    const { size, filename } = req.params;
    const allowSizes = ['w300', 'w342', 'w500', 'w780', 'w1280', 'original'];

    // 安全检查：size 走白名单；filename 只允许 TMDB 实际格式 <字母数字>.<jpg/png/webp>，杜绝 '..' 路径穿越
    if (!allowSizes.includes(size) || !/^[A-Za-z0-9]+\.(jpg|jpeg|png|webp)$/i.test(filename)) {
        return res.status(400).send('Invalid parameters');
    }

    try {
        // 判断是否来自中国大陆（支持 X-Client-Public-IP 头和私有 IP 检测）
        let useProxy = false;
        if (TMDB_PROXY_URL) {
            useProxy = await isChineseIP(req);
        }

        const targetUrl = useProxy
            ? `${TMDB_PROXY_URL.replace(/\/$/, '')}/t/p/${size}/${filename}`  // 代理
            : `https://image.tmdb.org/t/p/${size}/${filename}`;  // 直连官方

        const response = await axios({
            url: targetUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 15000  // 增加超时时间
        });

        // 缓存控制：公共缓存，有效期1天
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        response.data.pipe(res);
    } catch (error) {
        console.error(`[Vercel Image Error] ${size}/${filename}:`, error.message);
        res.status(404).send('Image not found');
    }
});

// ========== API: /api/search (SSE 流式搜索) ==========
app.get('/api/search', async (req, res) => {
    const keyword = req.query.wd;
    const stream = req.query.stream === 'true';

    if (!keyword) {
        return res.status(400).json({ error: 'Missing keyword' });
    }

    // 获取站点配置
    let sites = [];
    try {
        // 优先使用嵌入的站点配置
        if (EMBEDDED_SITES && EMBEDDED_SITES.sites) {
            sites = EMBEDDED_SITES.sites;
        } else if (REMOTE_DB_URL) {
            const now = Date.now();
            if (remoteDbCache && now - remoteDbLastFetch < REMOTE_DB_CACHE_TTL) {
                sites = remoteDbCache.sites || [];
            } else {
                const response = await axios.get(REMOTE_DB_URL, { timeout: 5000 });
                if (response.data && Array.isArray(response.data.sites)) {
                    remoteDbCache = response.data;
                    remoteDbLastFetch = now;
                    sites = response.data.sites;
                }
            }
        }
    } catch (err) {
        console.error('[Search] Failed to load sites:', err.message);
    }

    if (sites.length === 0) {
        // 即使没有站点也要返回 SSE 格式，否则 EventSource 会报错
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.write(`data: ${JSON.stringify({ error: '未配置资源站点，请在环境变量中设置 REMOTE_DB_URL' })}\n\n`);
            res.write('event: done\ndata: {}\n\n');
            return res.end();
        }
        return res.json({ error: 'No sites configured. Please set REMOTE_DB_URL.' });
    }

    if (!stream) {
        // 非流式模式：返回聚合的 JSON 结果（用于 refreshEpisodes 查找 vod_id）
        const siteKey = req.query.site_key;  // 可选：只搜索指定站点
        const targetSites = siteKey ? sites.filter(s => s.key === siteKey) : sites;

        const allResults = [];
        const searchPromises = targetSites.map(async (site) => {
            try {
                const response = await axios.get(site.api, {
                    params: { ac: 'detail', wd: keyword },
                    timeout: 8000
                });
                const data = response.data;
                if (data.list) {
                    data.list.forEach(item => {
                        allResults.push({
                            vod_id: item.vod_id,
                            vod_name: item.vod_name,
                            vod_pic: item.vod_pic,
                            vod_play_url: item.vod_play_url,
                            site_key: site.key,
                            site_name: site.name
                        });
                    });
                }
            } catch (err) {
                console.error(`[Search JSON] ${site.name}:`, err.message);
            }
        });
        await Promise.all(searchPromises);
        return res.json({ list: allResults });
    }

    // SSE 流式响应
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const searchPromises = sites.map(async (site) => {
        try {
            const response = await axios.get(site.api, {
                params: { ac: 'detail', wd: keyword },
                timeout: 8000
            });

            const data = response.data;
            const list = data.list ? data.list.map(item => ({
                vod_id: item.vod_id,
                vod_name: item.vod_name,
                vod_pic: item.vod_pic,
                vod_remarks: item.vod_remarks,
                vod_year: item.vod_year,
                type_name: item.type_name,
                vod_content: item.vod_content,
                vod_play_from: item.vod_play_from,
                vod_play_url: item.vod_play_url,
                site_key: site.key,
                site_name: site.name
            })) : [];

            if (list.length > 0) {
                res.write(`data: ${JSON.stringify(list)}\n\n`);
            }
            return list;
        } catch (err) {
            console.error(`[Search Error] ${site.name}:`, err.message);
            return [];
        }
    });

    await Promise.all(searchPromises);
    res.write('event: done\ndata: {}\n\n');
    res.end();
});

// ========== API: /api/detail ==========
app.get('/api/detail', async (req, res) => {
    const id = req.query.id;
    const siteKey = req.query.site_key;

    if (!id || !siteKey) {
        return res.status(400).json({ error: 'Missing id or site_key' });
    }

    // 获取站点配置
    let sites = [];
    try {
        // 优先使用嵌入的站点配置
        if (EMBEDDED_SITES && EMBEDDED_SITES.sites) {
            sites = EMBEDDED_SITES.sites;
        } else if (remoteDbCache) {
            sites = remoteDbCache.sites || [];
        } else if (REMOTE_DB_URL) {
            const response = await axios.get(REMOTE_DB_URL, { timeout: 5000 });
            if (response.data && Array.isArray(response.data.sites)) {
                remoteDbCache = response.data;
                remoteDbLastFetch = Date.now();
                sites = response.data.sites;
            }
        }
    } catch (err) {
        console.error('[Detail] Failed to load sites:', err.message);
    }

    const site = sites.find(s => s.key === siteKey);
    if (!site) {
        return res.status(404).json({ error: 'Site not found' });
    }

    try {
        const response = await axios.get(site.api, {
            params: { ac: 'detail', ids: id },
            timeout: 8000
        });

        const data = response.data;
        if (data.list && data.list.length > 0) {
            res.json({ list: [data.list[0]] });
        } else {
            res.status(404).json({ error: 'Not found', list: [] });
        }
    } catch (err) {
        console.error('[Detail Error]', err.message);
        res.status(500).json({ error: 'Detail fetch failed', list: [] });
    }
});

// ========== 历史同步相关 API (Vercel 不支持 SQLite，返回空) ==========
app.get('/api/history/pull', (req, res) => {
    res.json({
        sync_enabled: false,
        history: [],
        message: 'History sync not available in Vercel (no persistent storage)'
    });
});

app.post('/api/history/push', (req, res) => {
    res.json({
        sync_enabled: false,
        saved: 0,
        message: 'History sync not available in Vercel (no persistent storage)'
    });
});

// ========== Vercel Serverless 导出 ==========
module.exports = app;
