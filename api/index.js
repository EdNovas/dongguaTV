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
const DANMAKU_MISS_TTL = 5 * 60 * 1000;
const DANMAKU_CACHE_MAX = 1000;
const DANMAKU_MAX = 6000; // 单集弹幕上限(超出按时间均匀采样)，控制 payload 体积与渲染压力
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
function danmakuEpNum(s) {
    const m = String(s || '').match(/第\s*0*(\d+)\s*[集话話期]/);
    if (m) return parseInt(m[1], 10);
    const m2 = String(s || '').match(/\d+/);
    return m2 ? parseInt(m2[0], 10) : null;
}
function pickDanmakuEpisode(episodes, epName) {
    if (!episodes || !episodes.length) return null;
    const n = epName ? danmakuEpNum(epName) : null;
    if (n != null) {
        const byTitle = episodes.find(e => danmakuEpNum(e.episodeTitle) === n);
        if (byTitle) return byTitle;
        if (episodes[n - 1]) return episodes[n - 1];
    }
    return episodes[0];
}
app.get('/api/danmaku/v3/', async (req, res) => {
    const empty = { code: 0, version: 3, data: [], msg: '' };
    // 默认短缓存(空/出错 5min)；非空弹幕→7天新鲜+30天 stale-while-revalidate(过期先回旧缓存、后台重抓)。
    // 缓存加在本接口(键=?id=剧名|集名,稳定)，勿缓存 danmu_api 的 comment/{id}(id会过期)
    const LONG_CACHE = 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=2592000';
    res.set('Cache-Control', 'public, max-age=300');
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
        const base = DANMU_API_URL.replace(/\/$/, '');
        const token = process.env.DANMU_API_TOKEN || '';
        const prefix = token ? `/${encodeURIComponent(token)}` : '';
        const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
        const core = s => norm(String(s || '').split(/[(（【\[]/)[0]);
        const nt = norm(title), ct = core(title);
        // 搜索结果按剧名缓存：同剧各集复用，省去每集 ~6s 搜索(对 Vercel 10s 函数上限尤为关键)
        let animes;
        const sc = danmakuSearchCache.get(nt);
        if (sc && sc.expiry > Date.now()) { animes = sc.animes; }
        else {
            const sr = await axios.get(`${base}${prefix}/api/v2/search/episodes`, { params: { anime: title }, timeout: 20000 });
            animes = (sr.data && sr.data.animes) || [];
            if (danmakuSearchCache.size >= 500) { const k = danmakuSearchCache.keys().next().value; if (k !== undefined) danmakuSearchCache.delete(k); }
            danmakuSearchCache.set(nt, { animes, expiry: Date.now() + DANMAKU_SEARCH_TTL });
        }
        // 同剧多平台：收集所有匹配的 anime，按平台弹幕量排序(migu 常返 0 且慢→最后)，逐个取直到非空(限3次)
        let candidates = animes.filter(a => core(a.animeTitle) === ct);
        if (!candidates.length) candidates = animes.filter(a => norm(a.animeTitle) === nt);
        if (!candidates.length) candidates = animes.filter(a => core(a.animeTitle).includes(ct) || ct.includes(core(a.animeTitle)));
        if (!candidates.length && animes.length) candidates = [animes[0]];
        const platOf = s => { const m = String(s || '').match(/from\s+([a-z0-9]+)/i); return m ? m[1].toLowerCase() : ''; };
        const PLAT_RANK = { iqiyi: 0, qq: 1, tencent: 1, youku: 2, bilibili: 3, mango: 4, imgo: 4, '360': 5, migu: 9 };
        candidates.sort((a, b) => (PLAT_RANK[platOf(a.animeTitle)] ?? 6) - (PLAT_RANK[platOf(b.animeTitle)] ?? 6));
        let data = [];
        for (let tries = 0; tries < candidates.length && tries < 3; tries++) {
            const episode = pickDanmakuEpisode(candidates[tries].episodes, ep);
            if (!episode || !episode.episodeId) continue;
            try {
                const cr = await axios.get(`${base}${prefix}/api/v2/comment/${episode.episodeId}`, { params: { withRelated: 'true', chConvert: '0' }, timeout: 25000 });
                const d = dandanToDplayer((cr.data && cr.data.comments) || []);
                if (d.length) { data = d; break; }
            } catch (e) { /* 该平台失败，试下一个 */ }
        }
        data.sort((a, b) => a[0] - b[0]); // 先按时间升序，保证下面按索引均匀采样=按时间均匀采样(后半段不丢)
        if (data.length > DANMAKU_MAX) { const step = data.length / DANMAKU_MAX, s = []; for (let i = 0; i < DANMAKU_MAX; i++) s.push(data[Math.floor(i * step)]); data = s; }
        if (danmakuCache.size >= DANMAKU_CACHE_MAX) { const k = danmakuCache.keys().next().value; if (k !== undefined) danmakuCache.delete(k); }
        danmakuCache.set(cacheKey, { data, expiry: Date.now() + (data.length ? DANMAKU_CACHE_TTL : DANMAKU_MISS_TTL) });
        if (data.length) res.set('Cache-Control', LONG_CACHE);
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
        danmaku_enabled: !!process.env.DANMU_API_URL  // 🗨️ 弹幕开关
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
