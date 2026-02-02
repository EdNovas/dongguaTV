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

async function isChineseIP(ip) {
    if (!ip || ip === '127.0.0.1' || ip === '::1') return false;
    const cached = ipLocationCache.get(ip);
    if (cached && (Date.now() - cached.time < IP_CACHE_TTL)) return cached.isCN;
    try {
        const response = await axios.get(`https://api.ip.sb/geoip/${ip}`, {
            timeout: 3000,
            headers: { 'User-Agent': 'DongguaTV/1.0' }
        });
        let isCN = false;
        if (response.data.country_code === 'CN') {
            const excludeRegions = ['Hong Kong', 'Macau', 'Taiwan', '香港', '澳门', '台湾'];
            const region = response.data.region || response.data.city || '';
            if (!excludeRegions.some(r => region.includes(r))) isCN = true;
        }
        ipLocationCache.set(ip, { isCN, time: Date.now() });
        console.log(`[IP Detection] ${ip} -> ${isCN ? '中国大陆' : '海外'}`);
        return isCN;
    } catch (error) {
        console.error(`[IP Detection Error] ${ip}:`, error.message);
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
        multi_user_mode: ACCESS_PASSWORDS.length > 1
    });
});

// ========== API: /api/debug ==========
app.get('/api/debug', async (req, res) => {
    // 尝试加载远程配置以显示状态
    let dbStatus = 'not_configured';
    let sitesCount = 0;
    let dbError = null;

    if (REMOTE_DB_URL) {
        try {
            if (remoteDbCache) {
                dbStatus = 'cached';
                sitesCount = remoteDbCache.sites?.length || 0;
            } else {
                const response = await axios.get(REMOTE_DB_URL, { timeout: 5000 });
                if (response.data && Array.isArray(response.data.sites)) {
                    dbStatus = 'loaded';
                    sitesCount = response.data.sites.length;
                    // 更新缓存
                    remoteDbCache = response.data;
                    remoteDbLastFetch = Date.now();
                } else {
                    dbStatus = 'invalid_format';
                }
            }
        } catch (err) {
            dbStatus = 'fetch_failed';
            dbError = err.message;
        }
    }

    res.json({
        environment: 'Vercel Serverless',
        node_version: process.version,
        env_status: {
            TMDB_API_KEY: TMDB_API_KEY ? 'configured' : 'missing',
            TMDB_PROXY_URL: TMDB_PROXY_URL ? 'configured' : 'not_set',
            ACCESS_PASSWORD: ACCESS_PASSWORDS.length > 0 ? `${ACCESS_PASSWORDS.length} password(s)` : 'not_set',
            REMOTE_DB_URL: REMOTE_DB_URL ? 'configured' : 'not_set',
            SITES_JSON: EMBEDDED_SITES ? `embedded (${EMBEDDED_SITES.sites?.length} sites)` : 'not_set'
        },
        remote_db: {
            status: dbStatus,
            sites_count: sitesCount,
            error: dbError,
            url_preview: REMOTE_DB_URL ? REMOTE_DB_URL.substring(0, 50) + '...' : null
        },
        cache_type: 'memory',
        timestamp: new Date().toISOString()
    });
});

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
        // 获取用户 IP 并判断是否来自中国大陆（与 server.js 逻辑一致）
        const clientIP = getClientIP(req);

        // 只有配置了代理 URL 且用户来自中国大陆时，才使用代理
        let useProxy = false;
        if (TMDB_PROXY_URL) {
            useProxy = await isChineseIP(clientIP);
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

    // 安全检查
    if (!allowSizes.includes(size) || !/^[a-zA-Z0-9_\-\.]+$/.test(filename)) {
        return res.status(400).send('Invalid parameters');
    }

    try {
        // 获取用户 IP 并判断是否来自中国大陆（与 TMDB API 代理逻辑一致）
        const clientIP = getClientIP(req);

        // 只有配置了代理 URL 且用户来自中国大陆时，才使用代理
        let useProxy = false;
        if (TMDB_PROXY_URL) {
            useProxy = await isChineseIP(clientIP);
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
        return res.json({ error: 'Use stream=true for search' });
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
