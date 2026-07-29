// Vercel 环境会自动注入环境变量，无需加载 .env 文件
if (!process.env.VERCEL) {
    require('dotenv').config();
}

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'db.json');
const TEMPLATE_FILE = path.join(__dirname, 'db.template.json');

// 图片缓存目录 (仅本地/Docker 环境)
const IMAGE_CACHE_DIR = path.join(__dirname, 'public/cache/images');
if (!process.env.VERCEL && !fs.existsSync(IMAGE_CACHE_DIR)) {
    fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
}

// 访问密码配置（支持多密码）
// 格式：ACCESS_PASSWORD=password1 或 ACCESS_PASSWORD=password1,password2,password3
const ACCESS_PASSWORD_RAW = process.env['ACCESS_PASSWORD'] || '';
const ACCESS_PASSWORDS = ACCESS_PASSWORD_RAW ? ACCESS_PASSWORD_RAW.split(',').map(p => p.trim()).filter(p => p) : [];

// 第一个密码的哈希（兼容旧逻辑）
const PASSWORD_HASH = ACCESS_PASSWORDS.length > 0
    ? crypto.createHash('sha256').update(ACCESS_PASSWORDS[0]).digest('hex')
    : '';

// 生成密码到哈希的映射（用于历史同步）
const PASSWORD_HASH_MAP = {};
ACCESS_PASSWORDS.forEach((pwd, index) => {
    const hash = crypto.createHash('sha256').update(pwd).digest('hex');
    PASSWORD_HASH_MAP[hash] = {
        index: index,
        // 第一个密码不启用同步（保持现有设计），其他密码启用同步
        syncEnabled: index > 0
    };
});

console.log(`[System] Password mode: ${ACCESS_PASSWORDS.length > 1 ? 'Multi-user' : 'Single'} (${ACCESS_PASSWORDS.length} passwords)`);

// 反查：token(=SHA256(独立密码)) → 原始独立密码。仅用于站长后台辨认"是哪个独立密码用户"。
// 只在 ADMIN_TOKEN 鉴权后的后台接口里用到，不外泄。
const HASH_TO_PASSWORD = {};
ACCESS_PASSWORDS.forEach(pwd => { HASH_TO_PASSWORD[crypto.createHash('sha256').update(pwd).digest('hex')] = pwd; });
// 求片/统计后台展示用：把 token 翻成人能认的身份
function userIdentity(token, label) {
    if (label && String(label).trim()) return String(label).trim();
    if (token && HASH_TO_PASSWORD[token]) return '独立密码: ' + HASH_TO_PASSWORD[token];
    if (token && String(token).startsWith('v2board_')) return 'v2board用户#' + String(token).slice(8, 16);
    return (token ? String(token).slice(0, 12) : '匿名');
}

// 远程配置URL
const REMOTE_DB_URL = process.env['REMOTE_DB_URL'] || '';

// CORS 代理 URL（用于中转无法直接访问的资源站 API）
const CORS_PROXY_URL = process.env['CORS_PROXY_URL'] || '';

// 📺 直播(IPTV)：上游 M3U 源(vbskycn/iptv，每6h更新)。可用 LIVE_M3U_URL 覆盖主源、LIVE_M3U_FALLBACK 覆盖备源；
//    设 LIVE_TV_DISABLED=1 整体关闭(前端隐藏直播区、后端 /api/live/channels 返回 enabled:false)。
const LIVE_M3U_URL = process.env['LIVE_M3U_URL'] || 'https://live.zbds.top/tv/iptv4.m3u';
const LIVE_M3U_FALLBACK = process.env['LIVE_M3U_FALLBACK'] || 'https://gh-proxy.com/raw.githubusercontent.com/vbskycn/iptv/refs/heads/master/tv/iptv4.m3u';
// 第二上游(iptv-org cn)：补 CDN 域名源——vbskycn 的 CCTV 多是运营商 IP(封 Cloudflare 放不了)，iptv-org 有 cctvplus 等 CDN 源。
const LIVE_M3U_IPTVORG = process.env['LIVE_M3U_IPTVORG'] || 'https://iptv-org.github.io/iptv/countries/cn.m3u';
// 第三上游(iptv-org 中文语言表)：countries/cn 多是运营商 IP；languages/zho 反而收录大量【海外 CDN】华语源——
// CCTV-1~17 完整 + CGTN 全家(News/Doc/西/阿/俄/法,多带 ACAO:*) + CCTV-4 America/Europe/Asia + 卫视。实测海外可播的关键补充。
const LIVE_M3U_ZHO = process.env['LIVE_M3U_ZHO'] || 'https://iptv-org.github.io/iptv/languages/zho.m3u';
// 自定义上游(可选)：用户有付费 IPTV 的 m3u 可设 LIVE_M3U_EXTRA(逗号分隔多个)，并入合并 → 能播什么由它决定。
const LIVE_M3U_EXTRA = (process.env['LIVE_M3U_EXTRA'] || '').split(',').map(s => s.trim()).filter(Boolean);
// 🏀 免费 CCTV5 / CCTV5+：第三方 redirector → 咪咕(migu)源。https + ACAO:*，海外【直连】可播
//    (实测返回真 TS 分段、media-seq 实时递增，非 catvod 那种 backup 待机台)。仅这两个体育频道稳定可用——其余 /cctv/N 皆 404。
//    放在合并最前 → 与上游同名 CCTV5/CCTV5+ 归并时其 https 线路(rank0)排第一被优先播，运营商死源退为兜底。源失效用 LIVE_M3U_DISABLE 连内置一起关。
const LIVE_KAFEI_GEN = [
    { name: 'CCTV5', group: '体育', url: 'https://live.666666.zip/cctv/5.m3u8' },
    { name: 'CCTV5+', group: '体育', url: 'https://live.666666.zip/cctv/5p.m3u8' },
];
// 布尔型环境变量：0/false/no/off/空 都算"未开启"——JS 里 "0"/"false" 是 truthy，
// 用户把 LIVE_TV_DISABLED=0 当"不禁用"填时曾把整个直播关掉(线上事故:首页直播频道消失)。
const envFlag = (name) => { const v = String(process.env[name] ?? '').trim().toLowerCase(); return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'; };
const LIVE_TV_ENABLED = !envFlag('LIVE_TV_DISABLED');
// LIVE_M3U_DISABLE=1：关掉所有内置上游(vbskycn/iptv-org/国际/内置CCTV5源)，只用 LIVE_M3U_EXTRA 自定义源。
const LIVE_BUILTIN = !envFlag('LIVE_M3U_DISABLE');
// 后台验证：每次刷新后通过 worker(http源)/直连(https源)实测每个频道首条线路能否播，标 ok 并把能播的排前。
// 不删频道(全列出),只标记+排序。设 LIVE_NO_VALIDATE=1 关闭(纯全列出、不打 worker)。
const LIVE_VALIDATE = !envFlag('LIVE_NO_VALIDATE');

// 环境变量加载状态日志（用于 Vercel 调试）
console.log(`[System] Environment: ${process.env.VERCEL ? 'Vercel Serverless' : 'Local/VPS'}`);
console.log(`[System] TMDB_API_KEY: ${process.env.TMDB_API_KEY ? '✓ Configured' : '✗ Missing'}`);
console.log(`[System] TMDB_PROXY_URL: ${process.env['TMDB_PROXY_URL'] || '(not set)'}`);
console.log(`[System] CORS_PROXY_URL: ${CORS_PROXY_URL || '(not set)'}`);
console.log(`[System] REMOTE_DB_URL: ${REMOTE_DB_URL ? '✓ Configured' : '(not set)'}`);
console.log(`[System] 直播(IPTV): ${LIVE_TV_ENABLED ? '✓ 启用 (' + LIVE_M3U_URL + ')' : '✗ 已禁用 (LIVE_TV_DISABLED)'}`);



// 远程配置缓存
let remoteDbCache = null;
let remoteDbLastFetch = 0;
const REMOTE_DB_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 记录需要使用代理的站点（自动学习，带过期时间）
// 格式：{ siteKey: expireTimestamp }
const proxyRequiredSites = new Map();
const PROXY_MEMORY_TTL = 24 * 60 * 60 * 1000; // 24小时后重新尝试直连
const SLOW_THRESHOLD_MS = 1500; // 直连延迟超过此值视为慢速，尝试代理

// IP 地理位置缓存 (避免频繁调用外部 API)
const ipLocationCache = new Map();
const IP_CACHE_TTL = 3600 * 1000; // 缓存1小时

/**
 * 获取请求者的真实 IP 地址
 * 支持 Cloudflare, Nginx 等反向代理
 */
function getClientIP(req) {
    return req.headers['cf-connecting-ip'] ||  // Cloudflare
        req.headers['x-real-ip'] ||          // Nginx
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        '';
}

/**
 * HTML 转义：用于把不可信数据(如 TMDB 标题/简介)安全地插入服务端渲染的 HTML/属性，
 * 防止 XSS。覆盖 & < > " ' 五个字符。
 */
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    if (cached && (Date.now() - cached.time < IP_CACHE_TTL)) {
        return cached.isCN;
    }

    try {
        const response = await axios.get(`https://api.ip.sb/geoip/${effectiveIP}`, {
            timeout: 3000,
            headers: { 'User-Agent': 'DongguaTV/1.0' }
        });

        const data = response.data;
        // 检查是否是中国大陆 (排除港澳台)
        let isCN = false;
        if (data.country_code === 'CN') {
            const excludeRegions = ['Hong Kong', 'Macau', 'Taiwan', '香港', '澳门', '台湾'];
            const region = data.region || data.city || '';
            if (!excludeRegions.some(r => region.includes(r))) {
                isCN = true;
            }
        }

        // 缓存结果
        ipLocationCache.set(effectiveIP, { isCN, time: Date.now() });
        console.log(`[IP Detection] ${effectiveIP} -> ${isCN ? '中国大陆' : '海外'}${clientProvidedIP ? ' (client-provided)' : ''}`);
        return isCN;

    } catch (error) {
        // API 调用失败，默认不使用代理
        console.error(`[IP Detection Error] ${effectiveIP}:`, error.message);
        return false;
    }
}

/**
 * 检测字符串是否主要包含英文字符（用于判断是否需要翻译）
 * @param {string} text - 待检测文本
 * @returns {boolean} - 是否主要是英文
 */
function isMainlyEnglish(text) {
    if (!text) return false;
    // 去除空格和标点后检测
    const cleaned = text.replace(/[\s\d\-\_\:\.\,\!\?\'\"\(\)\[\]]/g, '');
    if (cleaned.length === 0) return false;

    // 计算英文字母占比
    const englishChars = (cleaned.match(/[a-zA-Z]/g) || []).length;
    const ratio = englishChars / cleaned.length;

    // 如果英文字符占比超过 70%，认为是英文
    return ratio > 0.7;
}

/**
 * 通过 TMDB 搜索获取影片的中文名称
 * 利用 TMDB 的多语言支持，查询英文标题对应的中文翻译
 * 注意：会自动使用 TMDB_PROXY_URL 代理（如果配置）
 * @param {string} englishTitle - 英文标题
 * @returns {Promise<string[]>} - 找到的中文标题数组
 */
async function fetchChineseTitleFromTMDB(englishTitle) {
    const TMDB_API_KEY = process.env.TMDB_API_KEY;
    const TMDB_PROXY_URL = process.env['TMDB_PROXY_URL'];
    if (!TMDB_API_KEY) return [];

    // 构建 TMDB API 基础 URL（支持代理）
    // cloudflare-tmdb-proxy.js 需要 /api/3/ 前缀
    const TMDB_BASE = TMDB_PROXY_URL
        ? `${TMDB_PROXY_URL.replace(/\/$/, '')}/api/3`  // 代理需要 /api/3 前缀
        : 'https://api.themoviedb.org/3';

    try {
        // 先用英文搜索找到影片 ID
        const searchUrl = `${TMDB_BASE}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(englishTitle)}&language=en-US`;
        const searchResponse = await axios.get(searchUrl, { timeout: 8000 });

        if (!searchResponse.data.results || searchResponse.data.results.length === 0) {
            return [];
        }

        const firstResult = searchResponse.data.results[0];
        const mediaType = firstResult.media_type;  // movie 或 tv
        const id = firstResult.id;

        if (!id || (mediaType !== 'movie' && mediaType !== 'tv')) {
            return [];
        }

        // 用中文语言获取详情，TMDB 会返回中文标题
        const detailUrl = `${TMDB_BASE}/${mediaType}/${id}?api_key=${TMDB_API_KEY}&language=zh-CN`;
        const detailResponse = await axios.get(detailUrl, { timeout: 8000 });

        const chineseTitles = [];
        const chineseTitle = detailResponse.data.title || detailResponse.data.name;

        if (chineseTitle && chineseTitle !== englishTitle) {
            chineseTitles.push(chineseTitle);
            console.log(`[TMDB Translation] "${englishTitle}" => "${chineseTitle}"`);
        }

        // 尝试获取更多别名（alternative_titles）- 使用较短超时，失败不影响主流程
        try {
            const altUrl = `${TMDB_BASE}/${mediaType}/${id}/alternative_titles?api_key=${TMDB_API_KEY}`;
            const altResponse = await axios.get(altUrl, { timeout: 5000 });

            // 电影用 titles，电视剧用 results
            const alternatives = altResponse.data.titles || altResponse.data.results || [];

            // 查找中文地区的别名 (CN, TW, HK)
            for (const alt of alternatives) {
                const country = alt.iso_3166_1;
                if (['CN', 'TW', 'HK'].includes(country) && alt.title) {
                    if (!chineseTitles.includes(alt.title) && alt.title !== englishTitle) {
                        chineseTitles.push(alt.title);
                    }
                }
            }
        } catch (e) {
            // 别名获取失败不影响主流程
        }

        return chineseTitles;
    } catch (error) {
        // 翻译失败不阻塞搜索，静默返回空数组
        if (error.code !== 'ECONNABORTED') {
            console.error(`[TMDB Translation Error] ${englishTitle}:`, error.message);
        }
        return [];
    }
}

/**
 * 智能生成搜索关键词变体
 * 用于提高搜索命中率，解决 TMDB 标题与资源站标题不匹配的问题
 * 例如："利刃出鞘3：亡者归来" -> ["利刃出鞘3：亡者归来", "利刃出鞘3", "利刃出鞘"]
 * @param {string} keyword - 原始搜索关键词
 * @param {string} originalTitle - 可选的原始标题（如英文名）
 * @returns {string[]} - 关键词变体数组（已去重）
 */
function generateSearchKeywords(keyword, originalTitle = '') {
    const keywords = new Set();

    if (!keyword) return [];

    // 1. 原始关键词
    keywords.add(keyword.trim());

    // 2. 如果有原始标题（英文名），也加入
    if (originalTitle && originalTitle.trim() && originalTitle !== keyword) {
        keywords.add(originalTitle.trim());
    }

    // 3. 去除常见分隔符后的主标题
    // 常见分隔符：：、:、-、—、·、|、/
    const separators = ['：', ':', '–', '—', '-', '·', '|', '/', '~'];
    for (const sep of separators) {
        if (keyword.includes(sep)) {
            const mainTitle = keyword.split(sep)[0].trim();
            if (mainTitle && mainTitle.length >= 2) {
                keywords.add(mainTitle);
            }
        }
    }

    // 4. 去除括号内容：《》、()、（）、【】、[]
    const bracketPatterns = [
        /《[^》]*》/g,
        /\([^)]*\)/g,
        /（[^）]*）/g,
        /\[[^\]]*\]/g,
        /【[^】]*】/g
    ];
    let cleanedKeyword = keyword;
    for (const pattern of bracketPatterns) {
        cleanedKeyword = cleanedKeyword.replace(pattern, '').trim();
    }
    if (cleanedKeyword && cleanedKeyword !== keyword && cleanedKeyword.length >= 2) {
        keywords.add(cleanedKeyword);
    }

    // 5. 对于带数字续集的影片，尝试只保留数字前面的部分
    // 例如："利刃出鞘3" -> "利刃出鞘"  (但不移除如 "007" 这样的数字标题)
    const numericMatch = keyword.match(/^(.+?)\d+$/);
    if (numericMatch && numericMatch[1] && numericMatch[1].length >= 2) {
        // 只有当前面有足够长的标题时才添加
        const baseTitle = numericMatch[1].trim();
        if (baseTitle.length >= 2) {
            keywords.add(baseTitle);
        }
    }

    // 6. 去除 "第X季"、"第X部"、"Season X" 等后缀
    const seasonPatterns = [
        /第[一二三四五六七八九十\d]+季$/,
        /第[一二三四五六七八九十\d]+部$/,
        /Season\s*\d+$/i,
        /S\d+$/i
    ];
    let noSeasonKeyword = keyword;
    for (const pattern of seasonPatterns) {
        noSeasonKeyword = noSeasonKeyword.replace(pattern, '').trim();
    }
    if (noSeasonKeyword && noSeasonKeyword !== keyword && noSeasonKeyword.length >= 2) {
        keywords.add(noSeasonKeyword);
    }

    return Array.from(keywords);
}


/**
 * 检查站点是否需要使用代理（未过期）
 */
function shouldUseProxy(siteKey) {
    if (!proxyRequiredSites.has(siteKey)) return false;
    const expireTime = proxyRequiredSites.get(siteKey);
    if (Date.now() > expireTime) {
        // 已过期，移除记录，下次会重新尝试直连
        proxyRequiredSites.delete(siteKey);
        console.log(`[Proxy Memory] ${siteKey} 代理记录已过期，将重新尝试直连`);
        return false;
    }
    return true;
}

/**
 * 标记站点需要使用代理
 */
function markSiteNeedsProxy(siteKey, reason = '') {
    const expireTime = Date.now() + PROXY_MEMORY_TTL;
    proxyRequiredSites.set(siteKey, expireTime);
    const expireDate = new Date(expireTime).toLocaleString('zh-CN');
    console.log(`[Proxy Memory] ${siteKey} 已标记为需要代理${reason ? ` (${reason})` : ''}，有效期至 ${expireDate}`);
}

/**
 * 带代理回退的请求函数
 * 先尝试直接请求，失败或太慢时通过 CORS 代理重试
 * @param {string} url - 请求 URL
 * @param {object} options - axios 配置
 * @param {string} siteKey - 站点标识（用于记忆）
 * @returns {Promise<object>} - { data, usedProxy, latency }
 */
async function fetchWithProxyFallback(url, options = {}, siteKey = '') {
    const timeout = options.timeout || 8000;

    // 如果该站点之前需要代理且未过期，直接使用代理
    if (CORS_PROXY_URL && siteKey && shouldUseProxy(siteKey)) {
        try {
            const startTime = Date.now();
            const proxyUrl = `${CORS_PROXY_URL}/?url=${encodeURIComponent(url)}`;
            const response = await axios.get(proxyUrl, { ...options, timeout });
            const latency = Date.now() - startTime;
            return { data: response.data, usedProxy: true, latency };
        } catch (proxyError) {
            // 代理也失败，移除记忆，下次重新尝试直连
            proxyRequiredSites.delete(siteKey);
            console.log(`[Proxy Fallback] ${siteKey} 代理失败，已清除记录`);
            throw proxyError;
        }
    }

    // 尝试直接请求
    const startTime = Date.now();
    try {
        const response = await axios.get(url, { ...options, timeout });
        const directLatency = Date.now() - startTime;

        // 检查是否太慢，如果配置了代理，尝试代理看是否更快
        if (CORS_PROXY_URL && directLatency > SLOW_THRESHOLD_MS) {
            console.log(`[Proxy Fallback] ${siteKey || url} 直连较慢 (${directLatency}ms)，尝试代理对比...`);

            try {
                const proxyStartTime = Date.now();
                const proxyUrl = `${CORS_PROXY_URL}/?url=${encodeURIComponent(url)}`;
                const proxyResponse = await axios.get(proxyUrl, { ...options, timeout: timeout + 2000 });
                const proxyLatency = Date.now() - proxyStartTime;

                // 如果代理更快（至少快 30%），使用代理结果并记住
                if (proxyLatency < directLatency * 0.7) {
                    console.log(`[Proxy Fallback] ${siteKey || url} 代理更快 (${proxyLatency}ms vs ${directLatency}ms)，使用代理`);
                    if (siteKey) {
                        markSiteNeedsProxy(siteKey, `代理更快: ${proxyLatency}ms vs 直连 ${directLatency}ms`);
                    }
                    return { data: proxyResponse.data, usedProxy: true, latency: proxyLatency };
                } else {
                    console.log(`[Proxy Fallback] ${siteKey || url} 直连仍更快 (${directLatency}ms vs ${proxyLatency}ms)，继续使用直连`);
                }
            } catch (proxyError) {
                // 代理失败，继续使用直连结果
                console.log(`[Proxy Fallback] ${siteKey || url} 代理测试失败，继续使用直连`);
            }
        }

        return { data: response.data, usedProxy: false, latency: directLatency };
    } catch (directError) {
        // 直接请求失败，如果配置了代理，尝试通过代理
        if (CORS_PROXY_URL) {
            try {
                console.log(`[Proxy Fallback] ${siteKey || url} 直连失败，尝试代理...`);
                const proxyStartTime = Date.now();
                const proxyUrl = `${CORS_PROXY_URL}/?url=${encodeURIComponent(url)}`;
                const response = await axios.get(proxyUrl, { ...options, timeout: timeout + 2000 });
                const proxyLatency = Date.now() - proxyStartTime;

                // 记住该站点需要代理（带过期时间）
                if (siteKey) {
                    markSiteNeedsProxy(siteKey, '直连失败');
                }

                return { data: response.data, usedProxy: true, latency: proxyLatency };
            } catch (proxyError) {
                console.error(`[Proxy Fallback] ${siteKey || url} 代理请求也失败:`, proxyError.message);
                throw proxyError;
            }
        }
        throw directError;
    }
}

// 缓存配置
const CACHE_TYPE = process.env.CACHE_TYPE || 'json'; // json, sqlite, memory, none
const SEARCH_CACHE_JSON = path.join(__dirname, 'cache_search.json');
const DETAIL_CACHE_JSON = path.join(__dirname, 'cache_detail.json');
const INTRO_CACHE_JSON = path.join(__dirname, 'cache_intro.json');
const INTRO_ENV_CACHE_JSON = path.join(__dirname, 'cache_intro_env.json');
const CACHE_DB_FILE = path.join(__dirname, 'cache.db');

console.log(`[System] Cache Type: ${CACHE_TYPE}`);

// 初始化数据库文件 (仅本地/Docker 环境)
if (!process.env.VERCEL && !fs.existsSync(DATA_FILE)) {
    if (fs.existsSync(TEMPLATE_FILE)) {
        fs.copyFileSync(TEMPLATE_FILE, DATA_FILE);
        console.log('[Init] 已从模板创建 db.json');
    } else {
        const initialData = { sites: [] };
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
        console.log('[Init] 已创建默认 db.json');
    }
}

// ========== 缓存抽象层 ==========
class CacheManager {
    constructor(type) {
        this.type = type;
        this.searchCache = {};
        this.detailCache = {};
        this.introCache = {};   // ⏭️ 片头/片尾标记(json/memory 模式):独立命名空间,不与 VOD 详情缓存串味/共用淘汰
        this.introEnvCache = {}; // 🎵 片头/片尾音频响度包络(客户端学习成果的云备份,跨设备/跨线路复用)
        this.db = null;
        this.init();
    }

    init() {
        if (this.type === 'json') {
            if (fs.existsSync(SEARCH_CACHE_JSON)) {
                try { this.searchCache = JSON.parse(fs.readFileSync(SEARCH_CACHE_JSON)); } catch (e) { }
            }
            if (fs.existsSync(DETAIL_CACHE_JSON)) {
                try { this.detailCache = JSON.parse(fs.readFileSync(DETAIL_CACHE_JSON)); } catch (e) { }
            }
            if (fs.existsSync(INTRO_CACHE_JSON)) {
                try { this.introCache = JSON.parse(fs.readFileSync(INTRO_CACHE_JSON)); } catch (e) { }
            }
            if (fs.existsSync(INTRO_ENV_CACHE_JSON)) {
                try { this.introEnvCache = JSON.parse(fs.readFileSync(INTRO_ENV_CACHE_JSON)); } catch (e) { }
            }
        } else if (this.type === 'sqlite') {
            try {
                const Database = require('better-sqlite3');
                this.db = new Database(CACHE_DB_FILE);

                // WAL 模式 + 自动 checkpoint：之前 DB 处于 WAL 但无自动 checkpoint，
                // WAL 文件会无限增长(已观测到 4MB)占满磁盘。这里显式开启并限制 WAL 大小。
                try {
                    this.db.pragma('journal_mode = WAL');
                    this.db.pragma('wal_autocheckpoint = 1000'); // 约累计 4MB 自动 checkpoint
                    this.db.pragma('synchronous = NORMAL');
                } catch (e) { console.warn('[Cache] 设置 WAL pragma 失败:', e.message); }

                // 创建缓存表
                this.db.exec(`
                    CREATE TABLE IF NOT EXISTS cache (
                        category TEXT NOT NULL,
                        key TEXT NOT NULL,
                        value TEXT NOT NULL,
                        expire INTEGER NOT NULL,
                        PRIMARY KEY (category, key)
                    )
                `);

                // 创建用户历史记录表（用于多用户同步）
                this.db.exec(`
                    CREATE TABLE IF NOT EXISTS user_history (
                        user_token TEXT NOT NULL,
                        item_id TEXT NOT NULL,
                        item_data TEXT NOT NULL,
                        updated_at INTEGER NOT NULL,
                        PRIMARY KEY (user_token, item_id)
                    )
                `);

                // 创建用户设置表（多用户同步：弹幕开关等个性化偏好，跨设备记住）
                this.db.exec(`
                    CREATE TABLE IF NOT EXISTS user_settings (
                        user_token TEXT PRIMARY KEY,
                        settings_data TEXT NOT NULL,
                        updated_at INTEGER NOT NULL
                    )
                `);

                // 历史删除墓碑：记录"某条历史在何时被删"，跨设备同步删除，防止别的设备/旧会话把已删记录复活
                this.db.exec(`
                    CREATE TABLE IF NOT EXISTS user_history_deleted (
                        user_token TEXT NOT NULL,
                        item_id TEXT NOT NULL,
                        deleted_at INTEGER NOT NULL,
                        PRIMARY KEY (user_token, item_id)
                    )
                `);

                // 求片：用户提交想看但站内没有的剧；站长在站内后台贴磁力/下载链接履行，用户在"我的求片"看链接自取
                this.db.exec(`
                    CREATE TABLE IF NOT EXISTS content_requests (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_token TEXT NOT NULL,
                        user_label TEXT,
                        name TEXT NOT NULL,
                        tmdb_id TEXT,
                        poster TEXT,
                        note TEXT,
                        year TEXT,
                        aka TEXT,
                        cast_info TEXT,
                        status TEXT NOT NULL DEFAULT 'pending',
                        fulfill_link TEXT,
                        fulfill_note TEXT,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL
                    )
                `);
                // 求片：为帮站长准确找片新增的可选字段(年份/外文名又名/导演主演)。
                // 用幂等 ALTER 给【已存在】的旧表补列(SQLite 列已存在会抛错→吞掉即可)，免破坏旧数据。
                for (const col of ['year', 'aka', 'cast_info']) {
                    try { this.db.exec(`ALTER TABLE content_requests ADD COLUMN ${col} TEXT`); } catch (e) { /* 列已存在 */ }
                }

                // 用户统计/封禁：站长后台据此看每个用户的活跃/封禁。观看数据另从 user_history 现算。
                this.db.exec(`
                    CREATE TABLE IF NOT EXISTS user_stats (
                        user_token TEXT PRIMARY KEY,
                        label TEXT,
                        first_seen INTEGER,
                        last_login INTEGER,
                        last_active INTEGER,
                        banned INTEGER NOT NULL DEFAULT 0,
                        banned_at INTEGER
                    )
                `);

                // 创建索引加速过期查询
                this.db.exec(`CREATE INDEX IF NOT EXISTS idx_expire ON cache(expire)`);
                this.db.exec(`CREATE INDEX IF NOT EXISTS idx_history_user ON user_history(user_token)`);
                this.db.exec(`CREATE INDEX IF NOT EXISTS idx_req_user ON content_requests(user_token)`);
                this.db.exec(`CREATE INDEX IF NOT EXISTS idx_req_status ON content_requests(status)`);
                this.db.exec(`CREATE INDEX IF NOT EXISTS idx_stats_active ON user_stats(last_active)`);

                // 清理过期数据
                this.db.prepare('DELETE FROM cache WHERE expire < ?').run(Date.now());

                console.log(`[SQLite Cache] Database initialized: ${CACHE_DB_FILE}`);
            } catch (e) {
                console.error('[SQLite Cache] Init failed, falling back to memory:', e.message);
                this.type = 'memory';
            }
        }
    }

    _bucket(category) { return category === 'search' ? this.searchCache : category === 'intro' ? this.introCache : category === 'introenv' ? this.introEnvCache : this.detailCache; }
    get(category, key) {
        if (this.type === 'memory' || this.type === 'json') {
            const data = this._bucket(category)[key];
            if (data && data.expire > Date.now()) return data.value;
            return null;
        } else if (this.type === 'sqlite' && this.db) {
            try {
                const row = this.db.prepare(
                    'SELECT value FROM cache WHERE category = ? AND key = ? AND expire > ?'
                ).get(category, key, Date.now());
                return row ? JSON.parse(row.value) : null;
            } catch (e) {
                console.error('[SQLite Cache] Get error:', e.message);
                return null;
            }
        }
        return null;
    }

    set(category, key, value, ttlSeconds = 600) {
        const expire = Date.now() + ttlSeconds * 1000;

        if (this.type === 'memory') {
            this._bucket(category)[key] = { value, expire };
        } else if (this.type === 'json') {
            this._bucket(category)[key] = { value, expire };
            this.saveDisk(category);
        } else if (this.type === 'sqlite' && this.db) {
            try {
                this.db.prepare(`
                    INSERT OR REPLACE INTO cache (category, key, value, expire)
                    VALUES (?, ?, ?, ?)
                `).run(category, key, JSON.stringify(value), expire);
            } catch (e) {
                console.error('[SQLite Cache] Set error:', e.message);
            }
        }
    }

    saveDisk(only) {
        if (this.type !== 'json') return;
        // 只写被改动的桶(片头/片尾提交别每次重写整个详情缓存文件)
        if (!only || only === 'search') fs.writeFileSync(SEARCH_CACHE_JSON, JSON.stringify(this.searchCache));
        if (!only || only === 'intro') fs.writeFileSync(INTRO_CACHE_JSON, JSON.stringify(this.introCache));
        if (!only || only === 'introenv') fs.writeFileSync(INTRO_ENV_CACHE_JSON, JSON.stringify(this.introEnvCache));
        if (!only || (only !== 'search' && only !== 'intro' && only !== 'introenv')) fs.writeFileSync(DETAIL_CACHE_JSON, JSON.stringify(this.detailCache));
    }

    // 按 key 前缀列出某类别下的未过期条目(音频包络"跨线路借用"查同剧其它线路用)。上限截断防大扫描。
    list(category, prefix, limit = 20) {
        const out = [];
        if (this.type === 'memory' || this.type === 'json') {
            const bucket = this._bucket(category), now = Date.now();
            for (const k of Object.keys(bucket)) {
                if (k.indexOf(prefix) !== 0) continue;
                const data = bucket[k];
                if (data && data.expire > now) { out.push({ key: k, value: data.value }); if (out.length >= limit) break; }
            }
        } else if (this.type === 'sqlite' && this.db) {
            try {
                // LIKE 通配符注入防护:剧名归一化不会剥掉 % ,必须转义(否则含 % 的标题会匹配到别的剧)
                const esc = prefix.replace(/[\\%_]/g, ch => '\\' + ch);
                const rows = this.db.prepare(
                    "SELECT key, value FROM cache WHERE category = ? AND key LIKE ? ESCAPE '\\' AND expire > ? LIMIT ?"
                ).all(category, esc + '%', Date.now(), limit);
                for (const r of rows) { try { out.push({ key: r.key, value: JSON.parse(r.value) }); } catch (e) { } }
            } catch (e) {
                console.error('[SQLite Cache] List error:', e.message);
            }
        }
        return out;
    }

    // 定期清理过期缓存 (SQLite)
    cleanup() {
        if (this.type === 'sqlite' && this.db) {
            try {
                const result = this.db.prepare('DELETE FROM cache WHERE expire < ?').run(Date.now());
                if (result.changes > 0) {
                    console.log(`[SQLite Cache] Cleaned ${result.changes} expired entries`);
                }
            } catch (e) {
                console.error('[SQLite Cache] Cleanup error:', e.message);
            }
        }
    }
}

const cacheManager = new CacheManager(CACHE_TYPE);

// 定期清理过期缓存 (每小时执行一次)
setInterval(() => {
    cacheManager.cleanup();
}, 60 * 60 * 1000);

// ========== 中间件配置 ==========

// 启用 Gzip/Brotli 压缩
const compression = require('compression');
app.use(compression({
    level: 6,  // 压缩级别 1-9，6 是性能与压缩率的平衡点
    threshold: 1024,  // 只压缩大于 1KB 的响应
    filter: (req, res) => {
        // 不压缩 SSE 事件流
        if (req.headers['accept'] === 'text/event-stream') {
            return false;
        }
        return compression.filter(req, res);
    }
}));

app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));  // 增大限制以支持历史记录同步

// ========== API 速率限制 ==========
const rateLimit = require('express-rate-limit');
// ipKeyGenerator：把 IP 归一化为限流 key（IPv6 归并到子网前缀，避免同一 /64 轮换绕过限流）
const { ipKeyGenerator } = require('express-rate-limit');
const ipKey = (req) => ipKeyGenerator(getClientIP(req) || req.ip || '0.0.0.0');

// 通用 API 限流：每 IP 每分钟最多 600 次请求
// 注意：页面加载时会发送大量图片和 API 请求，需要足够高的限制
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 分钟窗口
    max: 600, // 每 IP 最多 600 次（约 10 次/秒）
    standardHeaders: true, // 返回 RateLimit-* 标准头
    legacyHeaders: false, // 禁用 X-RateLimit-* 旧头
    // 用真实客户端 IP 计数（CF-Connecting-IP/X-Real-IP），否则反代后会把所有用户算作同一个 IP
    keyGenerator: ipKey,
    message: { error: '请求过于频繁，请稍后再试 (Rate limit exceeded)' },
    skip: (req) => {
        // 跳过静态资源请求
        if (!req.path.startsWith('/api/')) return true;
        // 配置、认证、站点列表请求不限流（页面加载必需）
        if (req.path === '/api/config' || req.path.startsWith('/api/auth/') || req.path === '/api/sites') return true;
        // 图片代理请求不限流（前端有大量图片）
        if (req.path.startsWith('/api/tmdb-image/')) return true;
        // TMDB 代理请求不限流
        if (req.path === '/api/tmdb-proxy') return true;
        return false;
    }
});

// 搜索 API 更严格的限流：每 IP 每分钟最多 120 次搜索
const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    keyGenerator: ipKey,
    message: { error: '搜索请求过于频繁，请稍后再试' }
});

// 分享深链预览(/api/preview)更严格的限流：未登录可访问的公开接口，会打 TMDB，需防刷
const previewLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40, // 每 IP 每分钟最多 40 次（真实用户一次开链只调一次，足够宽松）
    keyGenerator: ipKey,
    message: { error: '预览请求过于频繁，请稍后再试' }
});

// 应用通用限流
app.use(apiLimiter);

// 对搜索 API 应用更严格的限流
app.use('/api/search', searchLimiter);

// 对分享预览 API 应用更严格的限流
app.use('/api/preview', previewLimiter);

// ========== 静态资源配置 ==========

// 静态资源 30天缓存 (libs 目录 - CSS/JS) - 这些文件不会变化
app.use('/libs', express.static('public/libs', {
    maxAge: '30d',
    immutable: true,
    etag: true,
    lastModified: true
}));

// 图片缓存目录 - 30天缓存
app.use('/cache', express.static('public/cache', {
    maxAge: '30d',
    immutable: true,
    etag: true
}));

// ========== 自动识别站点 URL ==========

/**
 * 从请求自动识别当前站点的 URL
 * 优先级：SITE_URL 环境变量 > 请求头自动检测
 * @param {object} req - Express 请求对象
 * @returns {string} - 站点 URL，如 https://mysite.com（不带尾部斜杠）
 */
function getSiteUrl(req) {
    // 1. 优先使用环境变量（用户显式配置的优先级最高）
    if (process.env.SITE_URL) {
        return process.env.SITE_URL.replace(/\/$/, '');
    }
    // 2. 从请求头自动检测
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    if (host) {
        return `${protocol}://${host}`;
    }
    // 3. 兜底默认值
    return 'https://ednovas.video';
}

// 缓存读取的 index.html 原始内容（避免每次请求都读磁盘）
let indexHtmlTemplate = null;
let robotsTxtTemplate = null;

const DEFAULT_SITE_URL = 'https://ednovas.video';

// 🔗 社交平台抓取卡片的爬虫 UA（微信/Twitter/FB/Telegram/Google 等）
function isSocialCrawler(req) {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    return /bot|crawl|spider|facebookexternalhit|twitterbot|whatsapp|telegram|slackbot|discordbot|linkedinbot|embedly|pinterest|redditbot|googlebot|bingbot|baiduspider|bytespider|sogou|yisou|360spider|micromessenger|qqbrowser|qq\/|weibo|line-poker|skypeuripreview/i.test(ua);
}

// 🔗 分享深链富预览页：按剧名输出 OG/Twitter 卡片，再 JS 跳转回 SPA。
//    只给社交爬虫返回此页；真实用户照常拿 SPA（SPA 自己解析 ?play= 打开剧）。
async function renderSharePage(req, res, rawName) {
    const name = String(rawName || '').slice(0, 100);
    const siteUrl = getSiteUrl(req);
    let poster = `${siteUrl}/icon.png`;
    // 尽力用 TMDB 搜一张海报作为卡片大图（失败/超时则用站点图标，不阻塞）
    try {
        const TMDB_API_KEY = process.env.TMDB_API_KEY;
        if (TMDB_API_KEY && name) {
            const TMDB_PROXY_URL = process.env['TMDB_PROXY_URL'];
            const serverInChina = process.env['SERVER_IN_CHINA'] === 'true';
            const base = (TMDB_PROXY_URL && serverInChina) ? `${TMDB_PROXY_URL.replace(/\/$/, '')}/api/3` : 'https://api.themoviedb.org/3';
            const r = await axios.get(`${base}/search/multi`, { params: { api_key: TMDB_API_KEY, language: 'zh-CN', query: name }, timeout: 2500 });
            const hit = ((r.data && r.data.results) || []).find(x => x.poster_path || x.backdrop_path);
            if (hit) poster = `https://image.tmdb.org/t/p/w500${hit.poster_path || hit.backdrop_path}`;
        }
    } catch (e) { /* 忽略，用站点图标 */ }

    const eName = escapeHtml(name);
    const ePoster = escapeHtml(poster);
    const desc = escapeHtml(`在 E视界 免费在线观看《${name}》，多线路高清播放。`);
    const playUrl = `${siteUrl}/?play=${encodeURIComponent(name)}`;
    const spaUrl = `/?play=${encodeURIComponent(name)}&_spa=1`;
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${eName} - 在线观看 | E视界</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${escapeHtml(playUrl)}">
<meta property="og:type" content="video.other">
<meta property="og:title" content="${eName} - 在线观看">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${ePoster}">
<meta property="og:url" content="${escapeHtml(playUrl)}">
<meta property="og:site_name" content="E视界">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${eName} - 在线观看">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${ePoster}">
<meta http-equiv="refresh" content="0;url=${escapeHtml(spaUrl)}">
<script>location.replace(${JSON.stringify(spaUrl)});</script>
</head>
<body style="background:#141414;color:#fff;font-family:-apple-system,sans-serif;text-align:center;padding:40px;">
<h1>${eName}</h1>
<p>正在进入播放页…若未自动跳转，请 <a href="${escapeHtml(spaUrl)}" style="color:#e50914;">点此进入</a></p>
</body>
</html>`;
    res.set('Cache-Control', 'public, max-age=600');
    res.type('html').send(html);
}

// ⚠️ 关键：动态注入站点 URL 到 index.html
// 自动将 meta 标签中的 ednovas.video 替换为当前访问的网站地址
app.get(['/', '/index.html'], async (req, res) => {
    // 🔗 分享深链：社交爬虫请求 /?play=剧名 时返回富预览卡片；真实用户(无 bot UA 或带 _spa)照常拿 SPA
    if (req.query.play && !req.query._spa && isSocialCrawler(req)) {
        try { return await renderSharePage(req, res, req.query.play); }
        catch (e) { console.error('[SharePage] error:', e.message); /* 失败则继续返回 SPA */ }
    }

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    try {
        // 懒加载模板
        if (!indexHtmlTemplate) {
            indexHtmlTemplate = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf-8');
        }

        const siteUrl = getSiteUrl(req);

        // 如果当前就是默认地址，不需要替换
        if (siteUrl === DEFAULT_SITE_URL) {
            res.type('html').send(indexHtmlTemplate);
            return;
        }

        // 替换所有 hardcoded 的默认 URL
        const html = indexHtmlTemplate.replace(
            new RegExp(DEFAULT_SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
            siteUrl
        );
        res.type('html').send(html);
    } catch (err) {
        console.error('[Dynamic HTML] Error:', err.message);
        // 回退到静态文件
        res.sendFile(path.join(__dirname, 'public/index.html'));
    }
});

// 站长后台：独立页面(非首页弹窗)。鉴权在前端输入 ADMIN_TOKEN 后由 /api/admin/* 服务端校验。
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// 动态注入站点 URL 到 robots.txt
app.get('/robots.txt', (req, res) => {
    try {
        if (!robotsTxtTemplate) {
            robotsTxtTemplate = fs.readFileSync(path.join(__dirname, 'public/robots.txt'), 'utf-8');
        }

        const siteUrl = getSiteUrl(req);

        if (siteUrl === DEFAULT_SITE_URL) {
            res.type('text').send(robotsTxtTemplate);
            return;
        }

        const txt = robotsTxtTemplate.replace(
            new RegExp(DEFAULT_SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
            siteUrl
        );
        res.type('text').send(txt);
    } catch (err) {
        console.error('[Dynamic robots.txt] Error:', err.message);
        res.sendFile(path.join(__dirname, 'public/robots.txt'));
    }
});

// Service Worker 不缓存
app.get('/sw.js', (req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// 其他静态文件 - 1小时缓存
app.use(express.static('public', {
    maxAge: '1h',
    etag: true,
    lastModified: true
}));

// ========== 路由定义 ==========

const IS_VERCEL = !!process.env.VERCEL;

// ========== 📺 直播(IPTV)频道：拉取上游 M3U → 解析 → 精选 → 缓存(6h) ==========
// 服务器只负责"拉取+精选+缓存+定时更新"；真正的"测速/线路选择/可用性"放在客户端做——
// 直播多为 http:// 运营商源(混合内容)，实际播放走 CF Worker 代理，客户端在自己网络上测才准。
const LIVE_CACHE_TTL = 6 * 60 * 60 * 1000;
let _liveCache = { at: 0, data: [], ok: false };
let _liveInflight = null;

// 分类映射 + 展示顺序。用户选"全列出不验证"：上游全部频道按分类下发，主页行显示前几类，
// 播放页"快速换台"出 grid + 分类筛选。客户端测线路挑能播的(运营商 IP 源封 CF，放不了)。
const LIVE_GROUP_MAP = {
    '央视频道': '央视', '卫视频道': '卫视', '体育频道': '体育', '电影频道': '影视',
    '纪录频道': '纪实', '儿童频道': '少儿', '音乐频道': '音乐', '春晚频道': '专题',
    '地方频道': '地方', '直播中国': '地方', '数字频道': '数字', '解说频道': '体育'
};
const LIVE_GROUP_ORDER = ['央视', '卫视', '体育', '影视', '电影', '电视剧', '综艺', '新闻', '纪实', '少儿', '音乐', '文化', '教育', '科教', '财经', '生活', '宗教', '购物', '专题', '数字', '地方', '成人', '其他'];
// 主页一行显示的分类(其余靠播放页 grid + 分类浏览)
const LIVE_HOME_GROUPS = new Set(['央视', '卫视', '体育']);

// 🌍 国际频道：iptv-org 按语言的播放列表(每种封顶，控制总量/内存)。lang 从播放列表来，genre 从 group-title。
const LIVE_LANGS = [
    { code: 'eng', name: 'English', cap: 150 }, { code: 'spa', name: 'Español', cap: 150 },
    { code: 'fra', name: 'Français', cap: 150 }, { code: 'deu', name: 'Deutsch', cap: 120 },
    { code: 'rus', name: 'Русский', cap: 120 }, { code: 'ara', name: 'العربية', cap: 120 },
    { code: 'por', name: 'Português', cap: 120 }, { code: 'ita', name: 'Italiano', cap: 100 },
    { code: 'jpn', name: '日本語', cap: 80 }, { code: 'kor', name: '한국어', cap: 80 },
    { code: 'hin', name: 'हिन्दी', cap: 80 }, { code: 'vie', name: 'Tiếng Việt', cap: 80 }
];
const LIVE_LANG_URL = (code) => `https://iptv-org.github.io/iptv/languages/${code}.m3u`;
// 🔞 成人直播源(可选)：由站长用 LIVE_M3U_ADULT(逗号分隔)注入；归入"成人"分类，受前端 NSFW 过滤开关控制显隐。
const LIVE_M3U_ADULT = (process.env['LIVE_M3U_ADULT'] || '').split(',').map(s => s.trim()).filter(Boolean);

// iptv-org group-title(英文 genre) → 中文分类
const LIVE_INTL_GENRE = {
    general: '综艺', news: '新闻', movies: '电影', movie: '电影', series: '电视剧', drama: '电视剧',
    music: '音乐', entertainment: '综艺', sports: '体育', sport: '体育', kids: '少儿', animation: '少儿',
    documentary: '纪实', culture: '文化', education: '教育', science: '科教', business: '财经',
    religious: '宗教', shop: '购物', lifestyle: '生活', cooking: '生活', travel: '生活', comedy: '综艺',
    classic: '电影', family: '综艺', outdoor: '生活', auto: '生活', relax: '生活', weather: '其他', legislative: '新闻'
};
function liveIntlGenre(groupTitle) {
    const g = String(groupTitle || '').toLowerCase().split(';')[0].trim();
    return LIVE_INTL_GENRE[g] || '其他';
}

// 名称归一(合并/去重 key)：去掉清晰度/HD/台/频道等噪声、空格横杠，大写
function liveNormName(name) {
    return String(name || '')
        .replace(/\((?:\d{3,4}[pi]|[^)]*?)\)/gi, '')   // (1080p)/(720p)/(...)
        .replace(/\[[^\]]*\]/g, '')                     // [Not 24/7]
        .replace(/(高清|超清|蓝光|频道|台|HD|FHD|UHD|4K|8K|IPV6|IPV4)/gi, '')
        .replace(/[\s\-_·｜|]/g, '')
        .toUpperCase();
}
// 展示名清理(去清晰度/方括号噪声，保留中文台名)
function liveCleanName(name) {
    return String(name || '').replace(/\s*\((?:\d{3,4}[pi])\)\s*/gi, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}
function liveHostIsIP(u) { try { return /^\d{1,3}(\.\d{1,3}){3}$/.test(new URL(u).hostname); } catch (e) { return true; } }
// 线路可达性打分(越小越靠前)。关键：CF Worker 的 fetch() 只允许标准端口(80/443/8080…)，
// 运营商源多在 :9901/:82 等非标端口 → worker 取不到(403)；裸 IP 也常被封。域名+标准端口才能过。
const LIVE_STD_PORTS = new Set([80, 443, 8080, 8443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8880]);
function liveSrcRank(u) {
    try {
        const url = new URL(u);
        const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
        const https = url.protocol === 'https:';
        const port = url.port ? parseInt(url.port, 10) : (https ? 443 : 80);
        const stdPort = LIVE_STD_PORTS.has(port);
        // 智能路由后的可达性：
        //   ① 域名 https → rank 0：客户端【直连】(原生 HLS 免 CORS；hls.js 若带 CORS)，不经 worker，端口/CF 限制都绕开。
        //   ② 域名 http + 标准端口 → rank 1：http 在 https 页是混合内容，必须经 worker 升 https；worker 又只接标准端口。
        //   ③ 裸 IP / 非标端口 http → rank 10+：worker 取不到 + 直连又是混合内容 → 基本放不了。
        if (!ip && https) return 0;
        if (!ip && stdPort) return 1;
        return 10 + (ip ? 2 : 0) + (stdPort ? 0 : 4) + (https ? 0 : 1);
    } catch (e) { return 99; }
}
// 分类判定：先看名字(跨两个上游更稳)，再回退 group-title 映射
function liveCategoryOf(name, groupTitle) {
    const n = String(name || '');
    if (/CCTV|央视|CGTN/i.test(n)) return /(CCTV-?5($|[^0-9])|5\s*[＋+]|体育|赛事|高尔夫|网球|台球|风云足球|斯诺克)/.test(n) ? '体育' : '央视';
    if (/卫视/.test(n)) return '卫视';
    if (/(体育|赛事|足球|篮球|网球|高尔夫|台球|斯诺克|搏击|NBA|ESPN)/i.test(n)) return '体育';
    if (/(电影|影院|剧场|影视|院线)/.test(n)) return '影视';
    if (/(少儿|动画|卡通|动漫|儿童|宝贝|金鹰卡通|嘉佳)/.test(n)) return '少儿';
    if (/(纪录|纪实|探索|科教|地理|discovery)/i.test(n)) return '纪实';
    if (/(新闻|资讯|凤凰)/.test(n)) return '新闻';
    if (/(音乐|MTV|演唱)/i.test(n)) return '音乐';
    return LIVE_GROUP_MAP[groupTitle] || '其他';
}

function parseM3U(text) {
    const out = [];
    const lines = String(text).split(/\r?\n/);
    let cur = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#EXTINF')) {
            const name = line.includes(',') ? line.slice(line.lastIndexOf(',') + 1).trim() : '';
            const logo = (line.match(/tvg-logo="([^"]*)"/i) || [])[1] || '';
            const group = (line.match(/group-title="([^"]*)"/i) || [])[1] || '';
            const tvgId = (line.match(/tvg-id="([^"]*)"/i) || [])[1] || '';
            cur = { name, logo, group, tvgId };
        } else if (line[0] !== '#') {
            if (cur) { cur.url = line; out.push(cur); cur = null; }
        }
    }
    return out;
}

// 合并多路上游 → 按归一名去重 → 分类(语言+种类) → 线路域名优先排序。返回 { channels, groups, langs }。
// 每条上游频道可带 lang(语言显示名)/intl(国际,用 group-title 映射种类)/adult(成人) 标记。
function buildLiveChannels(lists) {
    const map = new Map();   // 归一名 → bucket
    for (const list of lists) {
        for (const c of (list || [])) {
            const u = (c.url || '').trim();
            if (!/^https?:\/\//i.test(u)) continue;   // 浏览器只能播 http(s) m3u8
            const key = liveNormName(c.name);
            if (!key) continue;
            if (/支持作者|更新时间|请刷新|公众号|演示频道|测试频道|^熊猫直播$/.test(c.name)) continue;   // 过滤上游推广/占位条目
            let b = map.get(key);
            if (!b) {
                const adult = !!c.adult;
                const group = adult ? '成人' : (c.intl ? liveIntlGenre(c.group) : liveCategoryOf(c.name, c.group));
                b = { name: liveCleanName(c.name) || c.name, group, lang: c.lang || '中文', adult, logo: '', seen: new Set(), sources: [] };
                map.set(key, b);
            } else {
                const cn = liveCleanName(c.name);
                if (cn && cn.length < b.name.length) b.name = cn;   // 取更短更干净的展示名
            }
            // 台标只收 https(挡混合内容 + 恶意上游 data:/追踪像素)
            if (!b.logo && c.logo && /^https:\/\//i.test(c.logo)) b.logo = c.logo;
            if (!b.seen.has(u) && b.sources.length < 12) {
                b.seen.add(u);
                b.sources.push({ url: u, rank: liveSrcRank(u) });
            }
        }
    }
    const channels = [];
    for (const [key, b] of map) {
        // 线路排序：可达性打分(域名+标准端口 worker 才取得到；运营商非标端口/裸 IP 排最后)
        b.sources.sort((a, z) => a.rank - z.rank);
        channels.push({
            // 保留 '+' —— 否则 "CCTV+1"(归一名 CCTV+1)和 "CCTV1" 去掉加号都成 lv_CCTV1、id 撞车 → 多个频道同时高亮
            id: 'lv_' + key.replace(/[^a-zA-Z0-9一-龥+]/g, '').slice(0, 40),
            name: b.name, group: b.group, lang: b.lang, adult: b.adult, logo: b.logo,
            rank: b.sources.length ? b.sources[0].rank : 99,   // 最优线路可达性(前端把可能能播的排前面)
            sources: b.sources.slice(0, 8).map(s => ({ url: s.url }))
        });
    }
    const langOrder = ['中文', ...LIVE_LANGS.map(l => l.name)];
    const li = (l) => { const i = langOrder.indexOf(l); return i < 0 ? 999 : i; };
    const gi = (g) => { const i = LIVE_GROUP_ORDER.indexOf(g); return i < 0 ? 999 : i; };
    channels.sort((a, z) => li(a.lang) - li(z.lang) || gi(a.group) - gi(z.group) || a.name.localeCompare(z.name, 'zh'));
    const groups = LIVE_GROUP_ORDER.filter(g => channels.some(c => c.group === g));
    const langs = langOrder.filter(l => channels.some(c => c.lang === l));
    return { channels, groups, langs };
}

// 实测一条线路能否播：http 走 worker(=客户端播放路径)、https 直连(≈客户端直连)。拿到 #EXTM3U 即活。
async function probeLiveSource(url) {
    const https = /^https:\/\//i.test(url);
    const target = https ? url : (CORS_PROXY_URL ? `${CORS_PROXY_URL}/?url=${encodeURIComponent(url)}` : null);
    if (!target) return false;   // http 源无 worker 没法验证(也没法播)
    try {
        const r = await axios.get(target, { timeout: 8000, maxContentLength: 8000, responseType: 'text', validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-5000' } });
        if (!(r.status === 200 || r.status === 206)) return false;
        const body = String(r.data || '');
        if (!body.includes('#EXTM3U')) return false;
        // 待机/占位/死台不算"能播"(如 catvod 的 backup.m3u8、无信号轮播)——它们返回 200+m3u8 但放不出实际频道
        if (/backup\.m3u8|backup_\d|无\s*信\s*号|no[\s_-]?signal|maintain|stand.?by|占位|轮播图/i.test(body)) return false;
        return true;
    } catch (e) { return false; }
}

// 后台验证：标 ch.ok(首条线路能否播)，能播的在组内排前。不删频道。原地 mutate channels。
async function validateLiveChannels(channels) {
    let i = 0;
    const CONC = 32;
    await Promise.all(Array.from({ length: CONC }, async () => {
        while (i < channels.length) {
            const ch = channels[i++];
            let ok = false;
            for (const s of (ch.sources || []).slice(0, 2)) { if (await probeLiveSource(s.url)) { ok = true; break; } }
            ch.ok = ok;
        }
    }));
    const langOrder = ['中文', ...LIVE_LANGS.map(l => l.name)];
    const li = (l) => { const x = langOrder.indexOf(l); return x < 0 ? 999 : x; };
    const gi = (g) => { const x = LIVE_GROUP_ORDER.indexOf(g); return x < 0 ? 999 : x; };
    // 语言 → 分类 → 能播优先 → rank → 名称
    channels.sort((a, z) => li(a.lang) - li(z.lang) || gi(a.group) - gi(z.group) || ((z.ok ? 1 : 0) - (a.ok ? 1 : 0)) || (a.rank - z.rank) || a.name.localeCompare(z.name, 'zh'));
    return channels;
}

async function fetchLiveUpstream() {
    const get = async (urls) => {
        for (const u of urls) {
            try {
                const r = await axios.get(u, { timeout: 12000, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (r.data && String(r.data).includes('#EXTINF')) return String(r.data);
            } catch (e) { /* 试下一个 */ }
        }
        return '';
    };
    // LIVE_M3U_DISABLE=1 时只拉 LIVE_M3U_EXTRA，关掉所有内置上游(vbskycn/iptv-org/国际/内置CCTV5源)
    const [vbText, orgText, zhoText, ...extraTexts] = await Promise.all([
        LIVE_BUILTIN ? get([LIVE_M3U_URL, LIVE_M3U_FALLBACK].filter(Boolean)) : Promise.resolve(''),
        LIVE_BUILTIN ? get([LIVE_M3U_IPTVORG].filter(Boolean)) : Promise.resolve(''),
        LIVE_BUILTIN ? get([LIVE_M3U_ZHO].filter(Boolean)) : Promise.resolve(''),
        ...LIVE_M3U_EXTRA.map(u => get([u]))
    ]);
    if (!vbText && !orgText && !zhoText && !extraTexts.some(Boolean) && LIVE_BUILTIN) throw new Error('upstream M3U fetch failed');
    const vbList = parseM3U(vbText), orgList = parseM3U(orgText), zhoList = parseM3U(zhoText);   // 中文(lang 默认中文)；zho 含海外 CDN 华语源
    const extraLists = extraTexts.map(t => parseM3U(t));           // 用户自定义付费源(LIVE_M3U_EXTRA)优先
    // 🌍 国际：按语言拉 iptv-org，每种封顶；intl 标记 → 用 group-title 映射种类
    const langLists = LIVE_BUILTIN ? await Promise.all(LIVE_LANGS.map(async lg => {
        const t = await get([LIVE_LANG_URL(lg.code)]);
        return parseM3U(t).slice(0, lg.cap).map(c => ({ ...c, lang: lg.name, intl: true }));
    })) : [];
    // 🔞 成人(站长用 LIVE_M3U_ADULT 注入)：归入"成人"分类，受前端 NSFW 过滤控制
    const adultTexts = await Promise.all(LIVE_M3U_ADULT.map(u => get([u])));
    const adultList = adultTexts.flatMap(t => parseM3U(t).map(c => ({ ...c, adult: true })));
    // 内置免费 CCTV5/5+ 放在最前：与上游同名归并时其 https 线路被优先播(LIVE_M3U_DISABLE 时一并关掉)
    const kafeiList = LIVE_BUILTIN ? LIVE_KAFEI_GEN : [];
    const built = buildLiveChannels([kafeiList, ...extraLists, vbList, orgList, zhoList, ...langLists, adultList]);
    const intlN = langLists.reduce((s, l) => s + l.length, 0);
    console.log(`[直播] 上游拉取：中文 ${vbList.length + orgList.length}${zhoList.length ? '+zho' + zhoList.length : ''}${kafeiList.length ? '+kafei' + kafeiList.length : ''}${LIVE_M3U_EXTRA.length ? '+extra' + extraLists.reduce((s, l) => s + l.length, 0) : ''} + 国际 ${intlN}(${LIVE_LANGS.length}语) + 成人 ${adultList.length} → 合并 ${built.channels.length} 频道 / ${built.groups.length} 类 / ${built.langs.length} 语`);
    // 后台验证(不阻塞返回)：完成后原地标 ok + 重排，并刷新缓存时间戳让客户端 SWR 取到新版
    if (LIVE_VALIDATE && CORS_PROXY_URL) {
        validateLiveChannels(built.channels).then(() => {
            _liveCache.at = Date.now();
            console.log(`[直播] 验证完成：${built.channels.filter(c => c.ok).length}/${built.channels.length} 可播`);
        }).catch(e => console.error('[直播] 验证失败:', e.message));
    }
    return built;
}

// 取直播频道(带 6h 缓存 + 并发合并 + 旧缓存兜底)
async function getLiveChannels(force = false) {
    if (!force && _liveCache.ok && (Date.now() - _liveCache.at) < LIVE_CACHE_TTL) return _liveCache.data;
    if (_liveInflight) return _liveInflight;
    _liveInflight = (async () => {
        try {
            const data = await fetchLiveUpstream();
            _liveCache = { at: Date.now(), data, ok: true };
            return data;
        } catch (e) {
            console.error('[直播] 刷新失败:', e.message);
            if (_liveCache.ok) return _liveCache.data;   // 拉取失败时沿用旧缓存
            _liveCache = { at: Date.now(), data: { channels: [], groups: [], langs: [] }, ok: false };
            return _liveCache.data;
        } finally { _liveInflight = null; }
    })();
    return _liveInflight;
}

// 📺 直播频道列表(精选 + 6h 缓存)。前端再本地缓存。
app.get('/api/live/channels', async (req, res) => {
    if (!LIVE_TV_ENABLED) return res.json({ enabled: false, channels: [], groups: [], langs: [] });
    try {
        const data = await getLiveChannels(false);
        res.set('Cache-Control', 'public, max-age=1800');   // 客户端/CDN 缓存 30 分钟
        res.json({ enabled: true, updatedAt: _liveCache.at, count: data.channels.length, channels: data.channels, groups: data.groups, langs: data.langs });
    } catch (e) {
        res.json({ enabled: true, channels: [], groups: [], langs: [], error: 'fetch_failed' });
    }
});

// 启动后预热缓存(非阻塞)，让首位用户也能秒开直播区
if (LIVE_TV_ENABLED && !IS_VERCEL) { getLiveChannels(false).catch(() => {}); }

app.get('/api/config', (req, res) => {
    // 检查请求中的 token 是否支持同步
    const userToken = req.query.token || '';
    const userInfo = PASSWORD_HASH_MAP[userToken];
    const syncEnabled = userInfo ? userInfo.syncEnabled : false;

    res.json({
        tmdb_api_key: process.env.TMDB_API_KEY,
        tmdb_proxy_url: process.env['TMDB_PROXY_URL'],
        // CORS 代理 URL（用于中转无法直接访问的资源站 API）
        cors_proxy_url: CORS_PROXY_URL || null,
        // Vercel 环境下禁用本地图片缓存，防止写入报错
        enable_local_image_cache: !IS_VERCEL,
        // 多用户同步功能
        sync_enabled: syncEnabled,
        multi_user_mode: ACCESS_PASSWORDS.length > 1,
        // 🗨️ 弹幕：配置了 DANMU_API_URL 才开启(前端据此决定是否给播放器挂弹幕)
        danmaku_enabled: !!process.env.DANMU_API_URL,
        // 📮 求片：必须配置 ADMIN_TOKEN(站长才能履行)才开启;否则前端整个隐藏入口、后端拒收
        requests_enabled: !!process.env.ADMIN_TOKEN,
        // 📺 直播(IPTV)：默认开启，设 LIVE_TV_DISABLED=1 关闭 → 前端隐藏直播区
        live_enabled: LIVE_TV_ENABLED,
        // 🚫 封禁：站长在后台封了这个用户 → 前端锁屏
        banned: isBanned(userToken)
    });
});

// 健康检查端点（不泄露环境配置：原先会暴露密码数量、各 env 是否配置，便于攻击者侦察）
app.get('/api/debug', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// ========== 历史记录同步 API ==========

// 获取服务器上的历史记录
app.get('/api/history/pull', (req, res) => {
    const userToken = req.query.token;

    if (!userToken) {
        return res.status(400).json({ error: 'Missing token' });
    }

    // 验证 token 是否有效且启用同步
    const userInfo = PASSWORD_HASH_MAP[userToken];
    if (!userInfo) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    if (isBanned(userToken)) return res.status(403).json({ error: 'banned', banned: true });
    if (!userInfo.syncEnabled) {
        return res.json({ sync_enabled: false, history: [] });
    }

    // 从 SQLite 获取历史记录
    if (cacheManager.type !== 'sqlite' || !cacheManager.db) {
        return res.json({ sync_enabled: true, history: [], message: 'SQLite not available' });
    }
    touchUser(userToken);  // 记录活跃

    try {
        const stmt = cacheManager.db.prepare('SELECT item_id, item_data, updated_at FROM user_history WHERE user_token = ?');
        const rows = stmt.all(userToken);

        const history = rows.map(row => ({
            id: row.item_id,
            data: JSON.parse(row.item_data),
            updated_at: row.updated_at
        }));

        // 删除墓碑：让其它设备据此压制"已删但本地还在"的记录,不再复活
        const deleted = cacheManager.db.prepare('SELECT item_id, deleted_at FROM user_history_deleted WHERE user_token = ?').all(userToken).map(r => ({ id: r.item_id, deleted_at: r.deleted_at }));

        res.json({ sync_enabled: true, history: history, deleted: deleted });
    } catch (e) {
        console.error('[History Pull Error]', e.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// 推送历史记录到服务器
app.post('/api/history/push', (req, res) => {
    const { token, history, deleted, label } = req.body;

    if (!token || !Array.isArray(history)) {
        return res.status(400).json({ error: 'Missing token or history' });
    }

    // 验证 token
    const userInfo = PASSWORD_HASH_MAP[token];
    if (!userInfo) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    if (isBanned(token)) return res.status(403).json({ error: 'banned', banned: true });
    if (!userInfo.syncEnabled) {
        return res.json({ sync_enabled: false, saved: 0 });
    }

    // 保存到 SQLite
    if (cacheManager.type !== 'sqlite' || !cacheManager.db) {
        return res.json({ sync_enabled: true, saved: 0, message: 'SQLite not available' });
    }
    touchUser(token, { label });  // 记录活跃 + 邮箱身份(后台显示用)

    try {
        const insertStmt = cacheManager.db.prepare(`
            INSERT OR REPLACE INTO user_history (user_token, item_id, item_data, updated_at)
            VALUES (?, ?, ?, ?)
        `);
        const deleteHist = cacheManager.db.prepare('DELETE FROM user_history WHERE user_token = ? AND item_id = ?');
        const upsertTomb = cacheManager.db.prepare('INSERT OR REPLACE INTO user_history_deleted (user_token, item_id, deleted_at) VALUES (?, ?, ?)');

        // 现有墓碑 + 本次上报的墓碑(取较新的 deleted_at)
        const tomb = new Map(cacheManager.db.prepare('SELECT item_id, deleted_at FROM user_history_deleted WHERE user_token = ?').all(token).map(r => [r.item_id, r.deleted_at]));
        for (const d of (Array.isArray(deleted) ? deleted : [])) {
            if (!d || !d.id) continue;
            const at = Number(d.deleted_at) || Date.now();
            if (!(tomb.get(d.id) >= at)) tomb.set(d.id, at);
        }

        // 取每条现有的 updated_at，用于"更新者胜"——防陈旧设备用旧进度覆盖服务器上更新的进度
        const existingUpd = new Map(cacheManager.db.prepare('SELECT item_id, updated_at FROM user_history WHERE user_token = ?').all(token).map(row => [row.item_id, row.updated_at]));
        const PRUNE_MS = 120 * 24 * 60 * 60 * 1000;  // 墓碑保留 120 天，过期剪枝避免无限增长

        let saved = 0;
        const transaction = cacheManager.db.transaction(() => {
            // 1. 插入历史，但被【更新的删除墓碑】压制的不入库(防复活)；若该条比墓碑更新=重新观看,清墓碑后入库
            for (const item of history) {
                if (!item.id || !item.data) continue;
                const upd = item.updated_at || Date.now();
                const td = tomb.get(item.id);
                if (td != null && td >= upd) { deleteHist.run(token, item.id); continue; }  // 删除比这次观看新 → 压制
                if (td != null) tomb.delete(item.id);  // 这次观看更新 → 重新观看,墓碑作废
                // ⏱️ 更新者胜(last-writer-wins)：服务器已有更新的版本(别的设备看到了更靠后的集/进度) → 不被旧推送覆盖。
                //    根治"iPad 看到16集、手机却把进度压回14集"——陈旧设备的旧 updated_at 推送不再 INSERT OR REPLACE 掉新数据。
                const cur = existingUpd.get(item.id);
                if (cur != null && cur > upd) continue;
                insertStmt.run(token, item.id, JSON.stringify(item.data), upd);
                saved++;
            }
            // 2. 墓碑驱动删除（替代危险的"服务器有、推送里没有就删"隐式删除——那会在多设备/本地条数上限不一致
            //    (本地50 vs 服务器50)/配额降级时，把别的设备刚加/刚续看的剧误删，是经典多端同步反模式）。
            //    现在只删【显式打了墓碑】的项(removeFromHistory/clearWatchHistory 都打墓碑)：墓碑不早于服务器版本才删，
            //    re-watch(td<upd, 步骤1已 tomb.delete)的不在此列、别的设备没墓碑的剧一律不动。
            for (const [id, at] of tomb) {
                const cur = existingUpd.get(id);
                if (cur != null && cur <= at) deleteHist.run(token, id);
            }
            // 3. 持久化墓碑(剪枝过期)
            cacheManager.db.prepare('DELETE FROM user_history_deleted WHERE user_token = ?').run(token);
            const cutoff = Date.now() - PRUNE_MS;
            for (const [id, at] of tomb) { if (at >= cutoff) upsertTomb.run(token, id, at); }
        });
        transaction();

        res.json({ sync_enabled: true, saved: saved, deleted: 0 });
    } catch (e) {
        console.error('[History Push Error]', e.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// 清除用户历史记录 (服务器端)
app.post('/api/history/clear', (req, res) => {
    const { token } = req.body;

    if (!token) {
        return res.status(400).json({ error: 'Missing token' });
    }

    // 验证 token
    const userInfo = PASSWORD_HASH_MAP[token];
    if (!userInfo) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    if (isBanned(token)) return res.status(403).json({ error: 'banned', banned: true });

    // 从 SQLite 删除该用户的所有历史
    if (cacheManager.type !== 'sqlite' || !cacheManager.db) {
        return res.json({ success: true, message: 'SQLite not available' });
    }

    try {
        const deleteStmt = cacheManager.db.prepare(`
            DELETE FROM user_history WHERE user_token = ?
        `);
        const result = deleteStmt.run(token);
        console.log(`[History Clear] 用户 ${token.substring(0, 8)}... 删除了 ${result.changes} 条记录`);
        res.json({ success: true, deleted: result.changes });
    } catch (e) {
        console.error('[History Clear Error]', e.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// ========== 用户设置同步 API（跨设备记住偏好，如弹幕开关）==========

// 拉取用户设置
app.get('/api/settings/pull', (req, res) => {
    const userToken = req.query.token;
    if (!userToken) return res.status(400).json({ error: 'Missing token' });
    const userInfo = PASSWORD_HASH_MAP[userToken];
    if (!userInfo) return res.status(401).json({ error: 'Invalid token' });
    if (isBanned(userToken)) return res.status(403).json({ error: 'banned', banned: true });
    if (!userInfo.syncEnabled) return res.json({ sync_enabled: false, settings: {} });
    if (cacheManager.type !== 'sqlite' || !cacheManager.db) {
        return res.json({ sync_enabled: true, settings: {}, message: 'SQLite not available' });
    }
    try {
        const row = cacheManager.db.prepare('SELECT settings_data FROM user_settings WHERE user_token = ?').get(userToken);
        let settings = {};
        if (row && row.settings_data) { try { settings = JSON.parse(row.settings_data) || {}; } catch (e) { } }
        res.json({ sync_enabled: true, settings });
    } catch (e) {
        console.error('[Settings Pull Error]', e.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// 推送用户设置（整体合并保存；前端只传变化的键也可，这里做浅合并）
app.post('/api/settings/push', (req, res) => {
    const { token, settings } = req.body;
    if (!token || typeof settings !== 'object' || settings === null) {
        return res.status(400).json({ error: 'Missing token or settings' });
    }
    const userInfo = PASSWORD_HASH_MAP[token];
    if (!userInfo) return res.status(401).json({ error: 'Invalid token' });
    if (isBanned(token)) return res.status(403).json({ error: 'banned', banned: true });
    if (!userInfo.syncEnabled) return res.json({ sync_enabled: false, saved: 0 });
    if (cacheManager.type !== 'sqlite' || !cacheManager.db) {
        return res.json({ sync_enabled: true, saved: 0, message: 'SQLite not available' });
    }
    try {
        // 浅合并已存在的设置，避免一次只传一个键时把其它键覆盖丢失
        const existing = cacheManager.db.prepare('SELECT settings_data FROM user_settings WHERE user_token = ?').get(token);
        let merged = {};
        if (existing && existing.settings_data) { try { merged = JSON.parse(existing.settings_data) || {}; } catch (e) { } }
        merged = { ...merged, ...settings };
        cacheManager.db.prepare(`
            INSERT OR REPLACE INTO user_settings (user_token, settings_data, updated_at) VALUES (?, ?, ?)
        `).run(token, JSON.stringify(merged), Date.now());
        res.json({ sync_enabled: true, saved: 1, settings: merged });
    } catch (e) {
        console.error('[Settings Push Error]', e.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// ========== ⏭️ 跳过片头 API：共享的片头/片尾时间标记(众包 + 客户端音频指纹自动学习上报) ==========
// 存储走 cacheManager KV(category='intro')——json/sqlite/memory 全兼容,不像历史同步只限 sqlite。
// 键 = 归一剧名|线路site_key(不同线路时间轴不同,不能混用);值 = { "<集号>": {os,oe,ed,v,ev,src,at,bs,be,bv} } 整剧一条。
// 必须按【集】存:每集冷开场长度不同,片头起点不同;不能按剧存一个时间。
// bs/be = 可选"开头贴片"区间(网络视听许可证/平台方片头贴片,与片头曲是两个独立可跳区间),bv = 其票数。
const INTRO_TTL = 365 * 24 * 3600;   // 秒。每次写入续期
function introNormTitle(s) {
    // 与前端 _introTitleKey 保持一致：去括号内容/空格/标点,小写。改这里必须同步改前端。
    return String(s || '').replace(/[(（【\[][^)）】\]]*[)）】\]]/g, '').replace(/[\s·:：\-—_~～!！?？"'「」『』]/g, '').toLowerCase().slice(0, 60);
}
function introKey(title, site) { return introNormTitle(title) + '|' + String(site || '').slice(0, 40); }
const introLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, keyGenerator: ipKey, message: { error: '请求过于频繁' } });

// 拉取某剧某线路的全部片头/片尾标记
app.get('/api/intro/marks', introLimiter, (req, res) => {
    const title = String(req.query.title || '').trim();
    if (!title) return res.json({ marks: {} });
    const map = cacheManager.get('intro', introKey(title, req.query.site)) || {};
    res.json({ marks: map });
});

// 提交一集的片头/片尾标记(手动标记或客户端音频指纹/包络自动学习)。登录站点即可提交(限流防刷)。
app.post('/api/intro/mark', introLimiter, (req, res) => {
    try {
        const b = req.body || {};
        // 站点配置了密码时要求有效 token(与历史同步同一套);未配密码的开放站不强求
        if (Object.keys(PASSWORD_HASH_MAP).length) {
            const u = PASSWORD_HASH_MAP[b.token];
            if (!u) return res.status(401).json({ error: 'Invalid token' });
            if (isBanned(b.token)) return res.status(403).json({ error: 'banned' });
        }
        const title = String(b.title || '').trim();
        const site = String(b.site || '').trim();
        const ep = parseInt(b.ep, 10);
        const opProvided = b.op_start != null || b.op_end != null;
        let os = Math.round(Number(b.op_start) * 10) / 10, oe = Math.round(Number(b.op_end) * 10) / 10;
        const hasOp = opProvided && isFinite(os) && isFinite(oe);
        let ed = b.ed_start == null ? null : Math.round(Number(b.ed_start) * 10) / 10;
        const dur = b.duration == null ? null : Math.round(Number(b.duration) * 10) / 10;
        const src = b.src === 'manual' ? 'manual' : 'auto';
        // 校验：ep 放宽到 8 位(综艺用日期做集号,如 20240105);片头起点前 25 分钟内、时长 10~150s(挡"整段5分钟片头"的滥用载荷)
        if (!title || !site || !Number.isInteger(ep) || ep < 0 || ep > 99999999) return res.status(400).json({ error: 'bad params' });
        if (opProvided && (!hasOp || os < 0 || oe <= os || os > 1500 || (oe - os) < 10 || (oe - os) > 150)) return res.status(400).json({ error: 'bad range' });
        const validDur = isFinite(dur) && dur > 0 && dur <= 6 * 3600 ? dur : null;
        if (ed != null && (!isFinite(ed) || ed <= 0 || ed > 6 * 3600 || (hasOp && ed <= oe) || (validDur && (ed < validDur * 0.45 || ed > validDur - 2)))) ed = null;
        // 可选"开头贴片"区间(网络视听许可证/平台方片头贴片):必须贴近片头部(起点≤120s)、3~90s、且在片头曲之前;非法就静默丢弃不拒整单
        let bs = b.b_start == null ? null : Math.round(Number(b.b_start) * 10) / 10;
        let be = b.b_end == null ? null : Math.round(Number(b.b_end) * 10) / 10;
        if (!hasOp || bs == null || be == null || !isFinite(bs) || !isFinite(be) || bs < 0 || bs > 120 || be <= bs || (be - bs) < 3 || (be - bs) > 90 || be > os + 5) { bs = null; be = null; }
        const key = introKey(title, site);
        const map = cacheManager.get('intro', key) || {};
        const old = map[ep];
        if (ed != null && !hasOp && old && old.oe > old.os && ed <= old.oe) ed = null;
        if (!hasOp && ed == null) return res.status(400).json({ error: 'bad range' });
        // 贴片区间独立计票收敛(和 os/oe 同一套 ±5s 加权/削票模型)
        const mergeBump = (rec, oldRec) => {
            const obs = oldRec && oldRec.be > oldRec.bs ? oldRec : null;
            if (bs == null) { if (obs) { rec.bs = obs.bs; rec.be = obs.be; rec.bv = obs.bv || 1; } return rec; }
            if (obs && Math.abs(obs.bs - bs) <= 5 && Math.abs(obs.be - be) <= 5) {
                const w = Math.min(obs.bv || 1, 9);
                rec.bs = Math.round((obs.bs * w + bs) / (w + 1) * 10) / 10; rec.be = Math.round((obs.be * w + be) / (w + 1) * 10) / 10; rec.bv = Math.min((obs.bv || 1) + 1, 99);
            } else if (!obs || (obs.bv || 1) <= 1) { rec.bs = bs; rec.be = be; rec.bv = 1; }
            else { rec.bs = obs.bs; rec.be = obs.be; rec.bv = (obs.bv || 1) - 1; }
            return rec;
        };
        const mergeOutro = (rec, oldRec) => {
            const obs = oldRec && oldRec.ed > 0 ? oldRec : null;
            if (ed == null) { if (obs) { rec.ed = obs.ed; rec.ev = obs.ev || 1; } return rec; }
            if (obs && Math.abs(obs.ed - ed) <= 8) {
                const w = Math.min(obs.ev || 1, 9);
                rec.ed = Math.round((obs.ed * w + ed) / (w + 1) * 10) / 10;
                rec.ev = Math.min((obs.ev || 1) + 1, 99);
            } else if (!obs || (obs.ev || 1) <= 1) { rec.ed = ed; rec.ev = 1; }
            else { rec.ed = obs.ed; rec.ev = (obs.ev || 1) - 1; }
            return rec;
        };
        if (!hasOp) {
            map[ep] = mergeOutro(mergeBump({ ...(old || {}), os: old?.os || 0, oe: old?.oe || 0, v: old?.v || 0, src: old?.src || src, at: Date.now() }, old), old);
        } else if (old && Math.abs(old.os - os) <= 5 && Math.abs(old.oe - oe) <= 5) {
            // 与现值一致(±5s)：加权平均收敛 + 计票(封顶防溢出)
            const w = Math.min(old.v || 1, 9);
            map[ep] = mergeOutro(mergeBump({ os: Math.round((old.os * w + os) / (w + 1) * 10) / 10, oe: Math.round((old.oe * w + oe) / (w + 1) * 10) / 10, v: Math.min((old.v || 1) + 1, 99), src: old.src === 'manual' ? 'manual' : src, at: Date.now() }, old), old);
        } else if (!old || (old.v || 1) <= 1 || (src === 'manual' && old.src !== 'manual' && (old.v || 1) <= 2)) {
            // 无旧值 / 旧值只有 1 票 / 人工标记纠正低票自动值 → 覆盖
            map[ep] = mergeOutro(mergeBump({ os, oe, v: 1, src, at: Date.now() }, old), old);
        } else {
            // 与多票旧值冲突：削旧值一票(不直接推翻共识,但也不让先到的错值/被刷值永久钉死——
            // 诚实多数持续提交正确值会把错值削到 1 票后取而代之,eventual 纠偏)
            const nv = (old.v || 1) - 1;
            if (nv <= 1) map[ep] = mergeOutro(mergeBump({ os, oe, v: 1, src, at: Date.now() }, old), old);
            else { old.v = nv; old.at = Date.now(); map[ep] = mergeOutro(mergeBump(old, old), old); }
        }
        // 单剧集数上限(防灌爆一条 KV)
        const keys = Object.keys(map);
        if (keys.length > 500) { keys.sort((a, z) => (map[a].at || 0) - (map[z].at || 0)); for (const k of keys.slice(0, keys.length - 500)) delete map[k]; }
        cacheManager.set('intro', key, map, INTRO_TTL);
        res.json({ ok: true, mark: map[ep] || null });
    } catch (e) {
        console.error('[Intro Mark Error]', e.message);
        res.status(500).json({ error: 'server error' });
    }
});

// ========== 🎵 片头/片尾音频包络云备份：客户端学习成果(10Hz响度包络,量化Uint8→base64,约1~2KB/段)存服务器 ==========
// 为什么值得存:marks 是"时间坐标",绑死线路时间轴,不能跨线路;包络是"剧集内容音频的形状",与时间轴无关——
//   A线路学出的片头曲包络,在B线路上滑动互相关(Pearson≥0.6 实测校验)就能"定位"出 B 自己的时间点。
//   于是①新设备/清了 localStorage 免两集冷启动(只抓本集定位,流量约减半);②资源站再多,一部剧全站只需学一次。
// 键 = 归一剧名|线路(每线路一条自洽记录:开头贴片是线路特有的,跟着记录走);GET 本线路没有→借同剧其它线路(borrowed),
//   借用的包络客户端必须实测定位命中才会转正回传登记到本线路,失配自动回退冷启动学习——坏/不匹配数据自灭,不会长期占坑。
const INTRO_ENV_TTL = 365 * 24 * 3600;   // 秒。每次写入/被采用回传都会续期
const INTRO_ENV_B64 = /^[A-Za-z0-9+/]+={0,2}$/;

// 拉取某剧某线路的包络;本线路没有时借同剧其它线路最新一条(borrowed=true)
app.get('/api/intro/env', introLimiter, (req, res) => {
    const title = String(req.query.title || '').trim();
    if (!title) return res.json({ env: null });
    const norm = introNormTitle(title);
    if (!norm) return res.json({ env: null });
    const site = String(req.query.site || '').slice(0, 40);
    const exact = cacheManager.get('introenv', norm + '|' + site);
    if (exact) return res.json({ env: exact, from: site, borrowed: false });
    let best = null, bestKey = '';
    for (const { key, value } of cacheManager.list('introenv', norm + '|')) {
        if (value && value.v === 2 && (value.at || 0) > (best ? best.at || 0 : -1)) { best = value; bestKey = key; }
    }
    if (!best) return res.json({ env: null });
    res.json({ env: best, from: bestKey.slice(norm.length + 1), borrowed: true });
});

// 上传学习成果包络。env 字段与客户端本地记录同构:{v:2, d,sec,dur,maxStart, bd,bdur, od,odur}
//   d=片头曲包络 bd=开头贴片包络 od=片尾包络(都是 base64(Uint8) 10Hz 采样;量化不损 Pearson——尺度无关)。
// 组件级合并:来的组件覆盖,没带的组件保留旧值(先学出片头、后学出片尾的两次上传互不 clobber)。
app.post('/api/intro/env', introLimiter, (req, res) => {
    try {
        const b = req.body || {};
        if (Object.keys(PASSWORD_HASH_MAP).length) {
            const u = PASSWORD_HASH_MAP[b.token];
            if (!u) return res.status(401).json({ error: 'Invalid token' });
            if (isBanned(b.token)) return res.status(403).json({ error: 'banned' });
        }
        const title = String(b.title || '').trim();
        const site = String(b.site || '').trim().slice(0, 40);
        const e = b.env || {};
        if (!title || !introNormTitle(title) || !site || e.v !== 2) return res.status(400).json({ error: 'bad params' });
        // 逐组件校验:base64 字符集 + 长度上限(10Hz 包络≈10B/s;片头包络经跨空洞续接可到几百秒,给到 400s)
        //   + 秒数与包络字节数一致性(声称 150s 却只有 10s 数据的畸形载荷直接拒)
        const num = (x, lo, hi) => { const n = Math.round(Number(x) * 10) / 10; return isFinite(n) && n >= lo && n <= hi ? n : null; };
        const bytesOf = s => Math.floor(s.length * 3 / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
        const b64 = (s, max, sec) => (typeof s === 'string' && s.length >= 40 && s.length <= max && INTRO_ENV_B64.test(s) && sec != null && Math.abs(bytesOf(s) / 10 - sec) <= 3) ? s : null;
        const rec = { v: 2, at: Date.now() };
        const sec = num(e.sec, 10, 400), dur = num(e.dur, 10, 160), d = b64(e.d, 5600, sec);
        if (d && dur) { rec.d = d; rec.sec = sec; rec.dur = dur; rec.maxStart = num(e.maxStart, 0, 1500) || 0; }
        const bdur = num(e.bdur, 3, 90), bd = b64(e.bd, 1200, bdur);
        if (bd) { rec.bd = bd; rec.bdur = bdur; }
        const odur = num(e.odur, 10, 160), od = b64(e.od, 2400, odur);
        if (od) { rec.od = od; rec.odur = odur; }
        if (!rec.d && !rec.od) return res.status(400).json({ error: 'no payload' });
        const key = introNormTitle(title) + '|' + site;
        const old = cacheManager.get('introenv', key);
        if (old && old.v === 2) {
            if (!rec.d && old.d) { rec.d = old.d; rec.sec = old.sec; rec.dur = old.dur; rec.maxStart = old.maxStart || 0; }
            if (!rec.bd && old.bd) { rec.bd = old.bd; rec.bdur = old.bdur; }
            if (!rec.od && old.od) { rec.od = old.od; rec.odur = old.odur; }
        }
        cacheManager.set('introenv', key, rec, INTRO_ENV_TTL);
        res.json({ ok: true });
    } catch (e) {
        console.error('[Intro Env Error]', e.message);
        res.status(500).json({ error: 'server error' });
    }
});

// ========== 求片 API（用户提交想看的剧；站长后台贴磁力/下载链接履行）==========
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const REQ_DB_OK = () => cacheManager.type === 'sqlite' && cacheManager.db;

// ========== 用户统计/封禁 助手 ==========
// 记录用户活跃(last_active)、登录(last_login)、身份标签(label=email)。在历史同步/求片/登录处调用。
function touchUser(token, opts) {
    opts = opts || {};
    if (!REQ_DB_OK() || !token) return;
    try {
        const now = Date.now();
        const exists = cacheManager.db.prepare('SELECT 1 FROM user_stats WHERE user_token = ?').get(token);
        if (exists) {
            cacheManager.db.prepare('UPDATE user_stats SET last_active = ?, last_login = COALESCE(?, last_login), label = COALESCE(?, label) WHERE user_token = ?')
                .run(now, opts.login ? now : null, (opts.label && String(opts.label).trim()) ? String(opts.label).trim() : null, token);
        } else {
            cacheManager.db.prepare('INSERT INTO user_stats (user_token, label, first_seen, last_login, last_active, banned) VALUES (?, ?, ?, ?, ?, 0)')
                .run(token, (opts.label && String(opts.label).trim()) ? String(opts.label).trim() : null, now, opts.login ? now : null, now);
        }
    } catch (e) { /* 统计失败不影响主流程 */ }
}
function isBanned(token) {
    if (!REQ_DB_OK() || !token) return false;
    try { const r = cacheManager.db.prepare('SELECT banned FROM user_stats WHERE user_token = ?').get(token); return !!(r && r.banned); }
    catch (e) { return false; }
}
// 恒定时间比较 ADMIN_TOKEN（后台接口会吐出全站独立密码明文，避免计时侧信道猜令牌）
function adminTokenMatch(provided) {
    if (!ADMIN_TOKEN || !provided) return false;
    const a = Buffer.from(String(provided)), b = Buffer.from(ADMIN_TOKEN);
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

// 提交求片（需登录账号）
app.post('/api/requests', (req, res) => {
    if (!ADMIN_TOKEN) return res.status(403).json({ error: '求片功能未开启' });  // 未配 ADMIN_TOKEN = 功能关闭
    const { token, name, tmdb_id, poster, note, label, year, aka, cast } = req.body || {};
    if (!token || !name || !String(name).trim()) return res.status(400).json({ error: 'Missing token or name' });
    if (!PASSWORD_HASH_MAP[token]) return res.status(401).json({ error: 'Invalid token' });
    if (isBanned(token)) return res.status(403).json({ error: 'banned', banned: true });
    if (!REQ_DB_OK()) return res.json({ ok: false, message: 'SQLite not available' });
    touchUser(token, { label });  // 记录活跃 + 身份标签(email)
    try {
        // 防刷：单用户待处理(pending)上限 3
        const pending = cacheManager.db.prepare("SELECT COUNT(*) c FROM content_requests WHERE user_token = ? AND status = 'pending'").get(token).c;
        if (pending >= 3) return res.status(429).json({ error: '最多同时有 3 条待处理的求片，请等已有的处理完或先撤销' });
        const now = Date.now();
        const info = cacheManager.db.prepare(`INSERT INTO content_requests (user_token, user_label, name, tmdb_id, poster, note, year, aka, cast_info, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
            token, String(label || '').slice(0, 120), String(name).trim().slice(0, 200),
            String(tmdb_id || '').slice(0, 40), String(poster || '').slice(0, 400), String(note || '').slice(0, 500),
            String(year || '').slice(0, 20), String(aka || '').slice(0, 200), String(cast || '').slice(0, 200), now, now);
        res.json({ ok: true, id: info.lastInsertRowid });
    } catch (e) { console.error('[求片提交]', e.message); res.status(500).json({ error: 'Database error' }); }
});

// 撤销自己的求片（仅限本人；pending 或 need_info 可撤销）→ 让"上限 3"不至于把人卡死，
// 也用于 need_info 补充重提时清掉旧的那条（避免同片堆积孤儿记录）。已履行/已拒绝的不可删。
app.post('/api/requests/cancel', (req, res) => {
    const { token, id } = req.body || {};
    if (!token || !PASSWORD_HASH_MAP[token]) return res.status(401).json({ error: 'Invalid token' });
    if (isBanned(token)) return res.status(403).json({ error: 'banned', banned: true });
    if (!REQ_DB_OK() || !id) return res.status(400).json({ error: 'Bad request' });
    try {
        const info = cacheManager.db.prepare("DELETE FROM content_requests WHERE id = ? AND user_token = ? AND status IN ('pending', 'need_info')").run(id, token);
        res.json({ ok: true, deleted: info.changes });
    } catch (e) { res.status(500).json({ error: 'Database error' }); }
});

// 我的求片
app.get('/api/requests/mine', (req, res) => {
    const token = req.query.token;
    if (!token || !PASSWORD_HASH_MAP[token]) return res.status(401).json({ error: 'Invalid token' });
    if (isBanned(token)) return res.status(403).json({ error: 'banned', banned: true });
    if (!REQ_DB_OK()) return res.json({ requests: [] });
    try {
        const rows = cacheManager.db.prepare(`SELECT id, name, tmdb_id, poster, note, year, aka, cast_info, status, fulfill_link, fulfill_note, created_at, updated_at
            FROM content_requests WHERE user_token = ? ORDER BY created_at DESC LIMIT 100`).all(token);
        res.json({ requests: rows });
    } catch (e) { res.status(500).json({ error: 'Database error' }); }
});

// 站长：列出全部求片（用 ADMIN_TOKEN 鉴权）
app.get('/api/requests/admin', (req, res) => {
    // 优先从请求头取令牌(避免 ADMIN_TOKEN 落入访问日志/Referer/浏览器历史)；兼容旧的 query 传参
    const admin = req.headers['x-admin-token'] || req.query.admin;
    if (!adminTokenMatch(admin)) return res.status(403).json({ error: 'Forbidden' });
    if (!REQ_DB_OK()) return res.json({ requests: [] });
    try {
        const status = req.query.status;
        const rows = status
            ? cacheManager.db.prepare(`SELECT * FROM content_requests WHERE status = ? ORDER BY created_at DESC LIMIT 500`).all(status)
            : cacheManager.db.prepare(`SELECT * FROM content_requests ORDER BY (status='pending') DESC, created_at DESC LIMIT 500`).all();
        // 加上求片人身份(邮箱/独立密码/token前缀)，方便站长确认是谁提的
        rows.forEach(r => { r.identity = userIdentity(r.user_token, r.user_label); });
        res.json({ requests: rows });
    } catch (e) { res.status(500).json({ error: 'Database error' }); }
});

// 站长：履行/更新求片（贴链接、改状态、删除）
app.post('/api/requests/admin', (req, res) => {
    const { admin, id, action, status, fulfill_link, fulfill_note } = req.body || {};
    if (!adminTokenMatch(admin)) return res.status(403).json({ error: 'Forbidden' });
    if (!REQ_DB_OK() || !id) return res.status(400).json({ error: 'Bad request' });
    try {
        if (action === 'delete') {
            cacheManager.db.prepare('DELETE FROM content_requests WHERE id = ?').run(id);
            return res.json({ ok: true, deleted: true });
        }
        const st = ['pending', 'fulfilled', 'rejected', 'need_info'].includes(status) ? status : 'fulfilled';
        cacheManager.db.prepare(`UPDATE content_requests SET status = ?, fulfill_link = ?, fulfill_note = ?, updated_at = ? WHERE id = ?`)
            .run(st, String(fulfill_link || '').slice(0, 2000), String(fulfill_note || '').slice(0, 500), Date.now(), id);
        res.json({ ok: true });
    } catch (e) { console.error('[求片履行]', e.message); res.status(500).json({ error: 'Database error' }); }
});

// ========== 站长后台：用户统计 / 封禁（均 ADMIN_TOKEN 鉴权，仅 网址#admin 用得到）==========
const adminAuthed = (req) => {
    const t = req.headers['x-admin-token'] || req.query.admin || (req.body && req.body.admin);
    return adminTokenMatch(t);
};

// 用户统计列表 + 聚合（观看数据从 user_history 现算；活跃/登录/封禁从 user_stats）
app.get('/api/admin/users', (req, res) => {
    if (!adminAuthed(req)) return res.status(403).json({ error: 'Forbidden' });
    if (!REQ_DB_OK()) return res.json({ users: [], aggregates: {} });
    try {
        const now = Date.now(), DAY = 86400000;
        // 1. 每用户观看聚合(数量/最近观看)
        const hist = {};
        for (const r of cacheManager.db.prepare('SELECT user_token, COUNT(*) cnt, MAX(updated_at) last FROM user_history GROUP BY user_token').all()) {
            hist[r.user_token] = { watch_count: r.cnt, last_watch: r.last, watch_seconds: 0 };
        }
        // 2. 估算观看时长：每剧 ≈ (当前集序号-1)*单集时长 + 当前集已看进度。
        //    比只算"当前集位置"更接近真实(老办法严重低估多集剧)，但仍是估算(前面集未必真看完/快进)→ 前端标"估"。
        //    ORDER BY 使限量扫描确定(取最近 N 条)，避免无序 LIMIT 的不确定取样。
        for (const row of cacheManager.db.prepare('SELECT user_token, item_data FROM user_history ORDER BY updated_at DESC LIMIT 200000').all()) {
            const a = hist[row.user_token]; if (!a) continue;
            try {
                const d = JSON.parse(row.item_data) || {};
                const pt = Number(d.progressTime) || 0;       // 当前集已看秒数
                const pd = Number(d.progressDuration) || 0;   // 当前集时长
                const em = String(d.episode || '').match(/(\d+)/);
                const epIdx = em ? parseInt(em[1]) : 1;
                let secs = pt;
                if (epIdx > 1 && pd > 0 && pd < 86400) secs = (epIdx - 1) * pd + pt;  // 前面整集 + 当前进度
                if (secs > 0 && secs < 200 * 86400) a.watch_seconds += secs;          // 上限防脏数据
            } catch (e) { }
        }
        // 3. 求片数 + 身份标签兜底(email 来自求片记录)
        const reqCnt = {}, labelMap = {};
        for (const r of cacheManager.db.prepare('SELECT user_token, COUNT(*) cnt FROM content_requests GROUP BY user_token').all()) reqCnt[r.user_token] = r.cnt;
        for (const r of cacheManager.db.prepare("SELECT user_token, MAX(user_label) lbl FROM content_requests WHERE user_label IS NOT NULL AND user_label != '' GROUP BY user_token").all()) labelMap[r.user_token] = r.lbl;
        // 4. user_stats 行
        const statMap = {};
        for (const s of cacheManager.db.prepare('SELECT * FROM user_stats').all()) statMap[s.user_token] = s;
        // 5. 全量 token = 观看者 ∪ 求片者 ∪ 已追踪
        const tokens = new Set([...Object.keys(hist), ...Object.keys(reqCnt), ...Object.keys(statMap)]);
        const users = [];
        for (const tk of tokens) {
            const st = statMap[tk] || {}, h = hist[tk] || {};
            users.push({
                token: tk,
                identity: userIdentity(tk, st.label || labelMap[tk] || ''),
                is_v2board: String(tk).startsWith('v2board_'),
                watch_count: h.watch_count || 0,
                last_watch: h.last_watch || null,
                watch_minutes: Math.round((h.watch_seconds || 0) / 60),
                request_count: reqCnt[tk] || 0,
                first_seen: st.first_seen || null,
                last_login: st.last_login || null,
                last_active: st.last_active || h.last_watch || null,
                banned: !!st.banned,
                banned_at: st.banned_at || null
            });
        }
        users.sort((a, b) => (b.last_active || 0) - (a.last_active || 0));
        const aggregates = {
            total_users: users.length,
            active_1d: users.filter(u => u.last_active && now - u.last_active < DAY).length,
            active_7d: users.filter(u => u.last_active && now - u.last_active < 7 * DAY).length,
            active_30d: users.filter(u => u.last_active && now - u.last_active < 30 * DAY).length,
            banned_count: users.filter(u => u.banned).length,
            v2board_users: users.filter(u => u.is_v2board).length,
            total_watch_count: users.reduce((s, u) => s + u.watch_count, 0),
            total_watch_hours: Math.round(users.reduce((s, u) => s + u.watch_minutes, 0) / 60),
            total_requests: users.reduce((s, u) => s + u.request_count, 0)
        };
        res.json({ users: users.slice(0, 1000), aggregates });
    } catch (e) { console.error('[Admin Users]', e.message); res.status(500).json({ error: 'Database error' }); }
});

// 封禁 / 解封（被封用户：/api/config 返回 banned→前端锁屏；历史同步/求片接口一律 403）
app.post('/api/admin/ban', (req, res) => {
    if (!adminAuthed(req)) return res.status(403).json({ error: 'Forbidden' });
    if (!REQ_DB_OK()) return res.status(400).json({ error: 'SQLite not available' });
    const { token, banned } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing token' });
    try {
        const b = banned ? 1 : 0, now = Date.now();
        const exists = cacheManager.db.prepare('SELECT 1 FROM user_stats WHERE user_token = ?').get(token);
        if (exists) cacheManager.db.prepare('UPDATE user_stats SET banned = ?, banned_at = ? WHERE user_token = ?').run(b, b ? now : null, token);
        else cacheManager.db.prepare('INSERT INTO user_stats (user_token, first_seen, last_active, banned, banned_at) VALUES (?, ?, ?, ?, ?)').run(token, now, now, b, b ? now : null);
        res.json({ ok: true, banned: !!b });
    } catch (e) { res.status(500).json({ error: 'Database error' }); }
});

// 某用户的观看记录（站长 drill-in 看详情）
app.get('/api/admin/user-history', (req, res) => {
    if (!adminAuthed(req)) return res.status(403).json({ error: 'Forbidden' });
    if (!REQ_DB_OK()) return res.json({ history: [] });
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    try {
        const rows = cacheManager.db.prepare('SELECT item_id, item_data, updated_at FROM user_history WHERE user_token = ? ORDER BY updated_at DESC LIMIT 300').all(token);
        const history = rows.map(r => {
            let d = {}; try { d = JSON.parse(r.item_data) || {}; } catch (e) { }
            return {
                name: d.name || r.item_id, episode: d.episode || null, progress: d.progress || 0,
                progressTime: d.progressTime || 0, progressDuration: d.progressDuration || 0,
                watchedAt: d.watchedAt || null, updated_at: r.updated_at
            };
        });
        res.json({ history });
    } catch (e) { res.status(500).json({ error: 'Database error' }); }
});

// TMDB 通用代理与缓存 API
const TMDB_CACHE_TTL = 3600 * 10; // 缓存 10 小时
app.get('/api/tmdb-proxy', async (req, res) => {
    const { path: tmdbPath, ...params } = req.query;

    if (!tmdbPath) return res.status(400).json({ error: 'Missing path' });

    const TMDB_API_KEY = process.env.TMDB_API_KEY;
    if (!TMDB_API_KEY) return res.status(500).json({ error: 'API Key not configured' });

    // 构建唯一的缓存 Key (排序参数以确保 Key 稳定)
    const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const cacheKey = `tmdb_proxy_${tmdbPath}_${sortedParams}`;

    const cached = cacheManager.get('detail', cacheKey);
    if (cached) {
        // console.log(`[TMDB Proxy] Cache Hit: ${cacheKey}`);
        return res.json(cached);
    }

    try {
        // 判断是否来自中国大陆（支持 X-Client-Public-IP 头和私有 IP 检测）
        const TMDB_PROXY_URL = process.env['TMDB_PROXY_URL'];

        // 只有配置了代理 URL 且用户来自中国大陆时，才使用代理
        let useProxy = false;
        if (TMDB_PROXY_URL) {
            useProxy = await isChineseIP(req);
        }

        const TMDB_BASE = useProxy
            ? `${TMDB_PROXY_URL.replace(/\/$/, '')}/api/3`  // 代理需要 /api/3 前缀
            : 'https://api.themoviedb.org/3';  // 海外用户直连官方 API

        // tmdbPath 格式如 /trending/all/week, /discover/movie 等
        const finalUrl = `${TMDB_BASE}${tmdbPath}`;

        const response = await axios.get(finalUrl, {
            params: {
                ...params,
                api_key: TMDB_API_KEY,
                language: 'zh-CN'
            },
            timeout: 15000  // 增加超时时间到 15 秒（代理可能较慢）
        });

        // 缓存结果
        cacheManager.set('detail', cacheKey, response.data, TMDB_CACHE_TTL);
        res.json(response.data);
    } catch (error) {
        console.error(`[TMDB Proxy Error] ${tmdbPath}:`, error.message);
        res.status(error.response?.status || 500).json({ error: 'Proxy request failed' });
    }
});

// M3U8 代理 - 用于广告过滤分析（绕过 CORS 限制）
app.get('/api/m3u8-proxy', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    // 安全检查：只允许 .m3u8 URL
    try {
        const parsedUrl = new URL(url);
        if (!parsedUrl.pathname.endsWith('.m3u8') && !parsedUrl.pathname.includes('.m3u8')) {
            return res.status(400).json({ error: 'Only .m3u8 URLs are allowed' });
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).json({ error: 'Invalid protocol' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    try {
        const response = await axios.get(url, {
            timeout: 8000,
            responseType: 'text',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.set('Cache-Control', 'no-cache');
        res.send(response.data);
    } catch (err) {
        console.error(`[M3U8 Proxy] Failed: ${url.substring(0, 80)}`, err.message);
        res.status(502).json({ error: 'Failed to fetch M3U8', details: err.message });
    }
});

// 1. 获取站点列表
app.get('/api/sites', async (req, res) => {
    let sitesData = null;

    // 尝试从远程加载
    if (REMOTE_DB_URL) {
        const now = Date.now();
        if (remoteDbCache && now - remoteDbLastFetch < REMOTE_DB_CACHE_TTL) {
            sitesData = remoteDbCache;
        } else {
            try {
                const response = await axios.get(REMOTE_DB_URL, { timeout: 5000 });
                if (response.data && Array.isArray(response.data.sites)) {
                    sitesData = response.data;
                    remoteDbCache = sitesData;
                    remoteDbLastFetch = now;
                    console.log('[Remote] Config loaded successfully');
                }
            } catch (err) {
                console.error('[Remote] Failed to load config:', err.message);
            }
        }
    }

    // 回退到本地
    if (!sitesData) {
        sitesData = JSON.parse(fs.readFileSync(DATA_FILE));
    }

    res.json(sitesData);
});

// 服务器端测速兜底：客户端直连+代理都失败时(混合内容/CORS)由服务器测资源站 API 延迟。
// 注：此接口在早期重构中丢失，前端一直调用导致 404 → 服务器测速这条兜底失效，已恢复。
app.get('/api/check', async (req, res) => {
    const { key } = req.query;
    try {
        const db = getDB();
        const sites = (db && db.sites) || [];
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

// 🔗 分享深链预览：未登录用户打开 /?play=剧名 时，前端用本接口拿 TMDB 简介+海报渲染"锁定框架"
//   （标题+简介+黑屏播放器+登录提示），全程不碰任何资源站(不搜索/不取播放地址)。带内存缓存+限流防刷。
const previewCache = new Map(); // name -> { data, expiry }
const PREVIEW_CACHE_TTL = 6 * 60 * 60 * 1000;   // 命中(有简介/海报)缓存 6 小时
const PREVIEW_MISS_TTL = 10 * 60 * 1000;        // 未命中(降级)缓存 10 分钟，便于稍后重试
const PREVIEW_CACHE_MAX = 2000;                  // FIFO 容量上限，防止无限增长
// 全站 TMDB 调用封顶：即使有人伪造 X-Forwarded-For 绕过单 IP 限流 + 用不同 name 绕过缓存，
// 也无法把 /api/preview 变成无限的 TMDB 放大器(超额则只返回降级的"仅剧名"数据)。
let previewTmdbWindowStart = 0, previewTmdbCount = 0;
const PREVIEW_TMDB_WINDOW = 60 * 1000;
const PREVIEW_TMDB_MAX = 300;                     // 全站每分钟最多 300 次 TMDB 查询
function previewTmdbBudgetOk() {
    const now = Date.now();
    if (now - previewTmdbWindowStart > PREVIEW_TMDB_WINDOW) { previewTmdbWindowStart = now; previewTmdbCount = 0; }
    if (previewTmdbCount >= PREVIEW_TMDB_MAX) return false;
    previewTmdbCount++;
    return true;
}
app.get('/api/preview', async (req, res) => {
    const name = String(req.query.name || '').slice(0, 100).trim();
    if (!name) return res.json({ name: '', title: '', synopsis: '', poster: '', year: '' });

    const cached = previewCache.get(name);
    if (cached && cached.expiry > Date.now()) {
        res.set('Cache-Control', 'public, max-age=3600');
        return res.json(cached.data);
    }

    const data = { name, title: name, synopsis: '', poster: '', year: '' };
    try {
        const TMDB_API_KEY = process.env.TMDB_API_KEY;
        if (TMDB_API_KEY && previewTmdbBudgetOk()) {
            const TMDB_PROXY_URL = process.env['TMDB_PROXY_URL'];
            const serverInChina = process.env['SERVER_IN_CHINA'] === 'true';
            const base = (TMDB_PROXY_URL && serverInChina) ? `${TMDB_PROXY_URL.replace(/\/$/, '')}/api/3` : 'https://api.themoviedb.org/3';
            const r = await axios.get(`${base}/search/multi`, { params: { api_key: TMDB_API_KEY, language: 'zh-CN', query: name }, timeout: 2500 });
            const results = (r.data && r.data.results) || [];
            // 优先选既有海报又有简介的，其次有海报的，最后第一个
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

    // 写缓存(含降级结果，FIFO 容量上限)；命中与未命中用不同 TTL
    if (previewCache.size >= PREVIEW_CACHE_MAX) {
        const firstKey = previewCache.keys().next().value;
        if (firstKey !== undefined) previewCache.delete(firstKey);
    }
    const ttl = (data.synopsis || data.poster) ? PREVIEW_CACHE_TTL : PREVIEW_MISS_TTL;
    previewCache.set(name, { data, expiry: Date.now() + ttl });

    res.set('Cache-Control', 'public, max-age=3600');
    return res.json(data);
});

// 🗨️ 弹幕代理：把"剧名+集名"映射到自建第三方弹幕聚合服务(danmu_api，兼容弹弹play，聚合爱优腾芒B等平台弹幕)，
//   再转成 DPlayer v3 格式。按 DPlayer 约定 danmaku.api='/api/danmaku/'，它会 GET /api/danmaku/v3/?id=<剧名|集名>。
//   需配置环境变量 DANMU_API_URL(你部署的 danmu_api 地址)；未配置则返回空弹幕(功能优雅降级，不报错)。
const danmakuCache = new Map(); // "剧名|集名" -> { data, expiry }
const danmakuSearchCache = new Map(); // norm(剧名) -> { animes, expiry } 同剧各集复用搜索结果
const DANMAKU_CACHE_TTL = 30 * 60 * 1000;
const DANMAKU_MISS_TTL = 90 * 1000; // 空结果只缓存 90s：弹幕空多为 danmu_api 被上游(iqiyi)限流的瞬时失败，短缓存让下次很快重试成功(成功后再长缓存)
const DANMAKU_CACHE_MAX = 1000;
const DANMAKU_MAX = 12000; // 单集弹幕上限(超出按时间均匀采样)。提到 1.2w 让峰值更密、"海量弹幕"开关效果明显；unlimited 关时 DPlayer 仍按轨道限并发渲染，不会卡
const DANMAKU_SEARCH_TTL = 3 * 60 * 1000; // danmu_api 的 episodeId 会过期(实测<10min)，搜索结果只短存，防复用过期id取到空弹幕
let danmakuWinStart = 0, danmakuWinCount = 0;
function danmakuBudgetOk() { // 全站每分钟最多 300 次上游弹幕查询，防刷
    const now = Date.now();
    if (now - danmakuWinStart > 60000) { danmakuWinStart = now; danmakuWinCount = 0; }
    if (danmakuWinCount >= 300) return false;
    danmakuWinCount++;
    return true;
}
function dandanToDplayer(comments) {
    // dandanplay: { p:"秒,模式,颜色,uid", m:"文本" } → DPlayer: [时间, 类型(0滚/1顶/2底), 颜色, 作者, 文本]
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
    // 缓存策略：空/出错一律 no-store——绝不让 CDN/浏览器缓存"暂时为空"的弹幕。
    //   (事故：CF 的"浏览器缓存TTL=1年"会把空响应在每个用户浏览器冻结一年 → 某集偶发一次取空就永久没弹幕。
    //    服务器侧另有 90s miss 缓存护住上游，所以 no-store 不会反复打 danmu_api。)
    // 取到非空弹幕才长缓存：弹幕近乎静态 → 7 天新鲜 + 30 天 stale-while-revalidate(过期先回旧缓存秒开、后台重抓)。
    // 注意：缓存键 = ?id=剧名|集名(稳定)；不要去缓存 danmu_api 的 comment/{id}(id 会过期、键永远变)。
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
        // 多源回退：DANMU_API_URL 支持逗号分隔多个实例(不同主机/区域=不同出口IP,绕开单实例被上游限流)；
        //   DANMU_API_TOKEN 逗号分隔则按序与各实例配对，单个则全部实例共用。
        const bases = String(DANMU_API_URL).split(',').map(s => s.trim()).filter(Boolean);
        const tokens = String(process.env.DANMU_API_TOKEN || '').split(',').map(s => s.trim());
        const instances = bases.map((b, i) => ({ base: b, token: tokens.length > 1 ? (tokens[i] || '') : (tokens[0] || '') }));
        // 🏁 并行赛跑：所有实例同时查，第一个返回【高贴合(_tier≤1)非空】的立即采用——一个实例卡死/401 不再拖累其它。
        //    包含档(_tier≥2)结果不立即定音:压 1.5s 等高贴合结果到来——防"降级实例的杂牌错弹幕抢跑赢过健康实例的
        //    正主弹幕"(对抗审查实锤:多实例冗余反成投毒面)。1.5s 内没有更好的才用它。
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
        // 全空 → 多为上游(iqiyi)限流的瞬时空(实测同集隔几秒重试即满)：等 3s 再赛一轮。
        //   (搜索级空快照已不再缓存,这轮重试会真正重新搜索。)
        //   超出集数时 pickDanmakuEpisode 返回 null → 各实例本就返回空、这里也取不到，保持空。
        if (!data.length && instances.length) {
            await new Promise(r => setTimeout(r, 3000));
            data = await raceInstances();
        }
        // 包含档(杂牌名字沾边)结果置信低:服务器只缓存 10 分钟、CDN/浏览器只给 10 分钟——错了也只错一阵,
        // 不再被 7 天 LONG_CACHE 固化(对抗审查实锤:史莱姆事故的错弹幕曾三层缓存一周)。
        const lowConf = !!(data && data.length && (data._tier ?? 9) >= 2);
        // 上游不保证按时间排序：先按时间[0]升序，确保下面"按索引均匀采样"=="按时间均匀采样"(后半段不丢)
        data.sort((a, b) => a[0] - b[0]);
        // 热门剧单集可达 1.5w+ 条(payload~1.5MB)：按时间均匀采样到上限，控制体积与前端渲染压力
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
// 借来的弹幕只读：DPlayer 发送弹幕会 POST 到此，直接成功返回不持久化(避免报错)
app.post('/api/danmaku/v3/', (req, res) => res.json({ code: 0, msg: '' }));

// 2. 搜索 API - SSE 流式版本 (GET, 用于实时搜索)
// 支持智能多关键词搜索：自动生成关键词变体提高搜索命中率
app.get('/api/search', async (req, res) => {
    const keyword = req.query.wd;
    const originalTitle = req.query.original || '';  // 可选：原始标题（如英文名）
    const stream = req.query.stream === 'true';
    const smartSearch = req.query.smart !== 'false';  // 默认启用智能搜索

    if (!keyword) {
        return res.status(400).json({ error: 'Missing keyword' });
    }

    const sites = getDB().sites;

    if (!stream) {
        // 非流式模式：返回聚合的 JSON 结果（用于 refreshEpisodes 查找 vod_id）
        const siteKey = req.query.site_key;  // 可选：只搜索指定站点
        const targetSites = siteKey ? sites.filter(s => s.key === siteKey) : sites;

        const allResults = [];
        const searchPromises = targetSites.map(async (site) => {
            const cacheKey = `${site.key}_${keyword}`;
            const cached = cacheManager.get('search', cacheKey);
            if (cached && cached.list) {
                cached.list.forEach(item => {
                    allResults.push({ ...item, site_key: site.key, site_name: site.name });
                });
                return;
            }
            try {
                const searchUrl = `${site.api}?ac=detail&wd=${encodeURIComponent(keyword)}`;
                const { data } = await fetchWithProxyFallback(searchUrl, { timeout: 8000 }, site.key);
                const list = data.list ? data.list.map(item => ({
                    vod_id: item.vod_id,
                    vod_name: item.vod_name,
                    vod_pic: item.vod_pic,
                    vod_play_url: item.vod_play_url,
                    site_key: site.key,
                    site_name: site.name
                })) : [];
                cacheManager.set('search', cacheKey, { list }, 3600);
                allResults.push(...list);
            } catch (err) {
                console.error(`[Search JSON] ${site.name}:`, err.message);
            }
        });
        await Promise.all(searchPromises);
        return res.json({ list: allResults });
    }

    // SSE 流式模式
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲

    // 生成搜索关键词变体
    let searchKeywords = smartSearch
        ? generateSearchKeywords(keyword, originalTitle)
        : [keyword];

    // 智能翻译：如果关键词是英文，尝试通过 TMDB 获取中文名
    if (smartSearch && isMainlyEnglish(keyword)) {
        console.log(`[Smart Search] 检测到英文关键词，尝试获取中文翻译: ${keyword}`);
        const chineseTitles = await fetchChineseTitleFromTMDB(keyword);
        if (chineseTitles.length > 0) {
            // 将中文标题加入搜索列表，并对中文标题也生成变体
            for (const cn of chineseTitles) {
                const cnVariants = generateSearchKeywords(cn);
                for (const v of cnVariants) {
                    if (!searchKeywords.includes(v)) {
                        searchKeywords.push(v);
                    }
                }
            }
        }
    }

    if (searchKeywords.length > 1) {
        console.log(`[Smart Search] 生成关键词变体: ${searchKeywords.join(' | ')}`);
    }

    // 用于跟踪已发送的结果，避免重复
    const sentVodIds = new Map(); // key: site_key_vod_id, value: true

    // 并行搜索所有站点
    const searchPromises = sites.map(async (site) => {
        // 对每个站点，尝试所有关键词变体
        const allResults = [];

        for (const kw of searchKeywords) {
            const cacheKey = `${site.key}_${kw}`;
            const cached = cacheManager.get('search', cacheKey);

            if (cached && cached.list) {
                // 命中缓存
                allResults.push(...cached.list);
            } else {
                try {
                    // 只在第一个关键词时打印日志，避免日志刷屏
                    if (kw === searchKeywords[0]) {
                        console.log(`[SSE Search] ${site.name} -> ${searchKeywords.length > 1 ? searchKeywords.join(' | ') : kw}`);
                    }

                    // 构建请求 URL（带参数）
                    const searchUrl = `${site.api}?ac=detail&wd=${encodeURIComponent(kw)}`;

                    // 使用带代理回退的请求
                    const { data, usedProxy } = await fetchWithProxyFallback(searchUrl, { timeout: 8000 }, site.key);

                    if (usedProxy && kw === searchKeywords[0]) {
                        console.log(`[SSE Search] ${site.name} 通过代理获取结果`);
                    }

                    const list = data.list ? data.list.map(item => ({
                        vod_id: item.vod_id,
                        vod_name: item.vod_name,
                        vod_pic: item.vod_pic,
                        vod_remarks: item.vod_remarks,
                        vod_year: item.vod_year,
                        type_name: item.type_name,
                        vod_content: item.vod_content,
                        vod_play_from: item.vod_play_from,
                        vod_play_url: item.vod_play_url
                    })) : [];

                    // 缓存结果 (1小时)
                    cacheManager.set('search', cacheKey, { list }, 3600);

                    allResults.push(...list);
                } catch (error) {
                    // 单个关键词失败不影响其他
                    if (kw === searchKeywords[0]) {
                        console.error(`[SSE Search Error] ${site.name}:`, error.message);
                    }
                }
            }
        }

        // 对该站点的结果去重（基于 vod_id）
        const uniqueResults = [];
        const seenIds = new Set();

        for (const item of allResults) {
            if (!seenIds.has(item.vod_id)) {
                seenIds.add(item.vod_id);
                uniqueResults.push({
                    ...item,
                    site_key: site.key,
                    site_name: site.name
                });
            }
        }

        // 发送结果到客户端（检查全局去重）
        const newItems = uniqueResults.filter(item => {
            const globalKey = `${item.site_key}_${item.vod_id}`;
            if (!sentVodIds.has(globalKey)) {
                sentVodIds.set(globalKey, true);
                return true;
            }
            return false;
        });

        if (newItems.length > 0) {
            res.write(`data: ${JSON.stringify(newItems)}\n\n`);
        }

        return newItems;
    });

    // 等待所有搜索完成
    await Promise.all(searchPromises);

    // 发送完成事件
    res.write('event: done\ndata: {}\n\n');
    res.end();
});


// 2b. 搜索 API - POST 版本 (用于单站点搜索)
app.post('/api/search', async (req, res) => {
    const { keyword, siteKey } = req.body;
    const sites = getDB().sites;
    const site = sites.find(s => s.key === siteKey);

    if (!site) return res.status(404).json({ error: 'Site not found' });

    const cacheKey = `${siteKey}_${keyword}`;
    const cached = cacheManager.get('search', cacheKey);
    if (cached) {
        console.log(`[Cache] Hit search: ${cacheKey}`);
        return res.json(cached);
    }

    try {
        console.log(`[Search] ${site.name} -> ${keyword}`);

        // 构建请求 URL
        const searchUrl = `${site.api}?ac=detail&wd=${encodeURIComponent(keyword)}`;
        const { data } = await fetchWithProxyFallback(searchUrl, { timeout: 8000 }, site.key);

        // 简单的数据清洗
        const result = {
            list: data.list ? data.list.map(item => ({
                vod_id: item.vod_id,
                vod_name: item.vod_name,
                vod_pic: item.vod_pic,
                vod_remarks: item.vod_remarks,
                vod_year: item.vod_year,
                type_name: item.type_name
            })) : []
        };

        cacheManager.set('search', cacheKey, result, 3600); // 缓存1小时
        res.json(result);
    } catch (error) {
        console.error(`[Search Error] ${site.name}:`, error.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

// 3. 详情 API (带缓存) - GET 版本
app.get('/api/detail', async (req, res) => {
    const id = req.query.id;
    const siteKey = req.query.site_key;
    const nocache = req.query.nocache === '1';
    const sites = getDB().sites;
    const site = sites.find(s => s.key === siteKey);

    if (!site) return res.status(404).json({ error: 'Site not found' });

    const cacheKey = `${siteKey}_detail_${id}`;
    if (!nocache) {
        const cached = cacheManager.get('detail', cacheKey);
        if (cached) {
            console.log(`[Cache] Hit detail: ${cacheKey}`);
            // 返回格式：{ list: [detail] }，与前端期望一致
            return res.json({ list: [cached] });
        }
    } else {
        console.log(`[Detail] nocache=1, 跳过缓存: ${cacheKey}`);
    }

    try {
        console.log(`[Detail] ${site.name} -> ID: ${id}`);

        // 构建请求 URL
        const detailUrl = `${site.api}?ac=detail&ids=${encodeURIComponent(id)}`;
        const { data } = await fetchWithProxyFallback(detailUrl, { timeout: 8000 }, site.key);

        if (data.list && data.list.length > 0) {
            const detail = data.list[0];
            cacheManager.set('detail', cacheKey, detail, 3600); // 缓存1小时
            // 返回格式：{ list: [detail] }，与前端期望一致
            res.json({ list: [detail] });
        } else {
            res.status(404).json({ error: 'Not found', list: [] });
        }
    } catch (error) {
        console.error(`[Detail Error] ${site.name}:`, error.message);
        res.status(500).json({ error: 'Detail fetch failed', list: [] });
    }
});

// 3b. 详情 API (带缓存) - POST 版本
app.post('/api/detail', async (req, res) => {
    const { id, siteKey } = req.body;
    const sites = getDB().sites;
    const site = sites.find(s => s.key === siteKey);

    if (!site) return res.status(404).json({ error: 'Site not found' });

    const cacheKey = `${siteKey}_detail_${id}`;
    const cached = cacheManager.get('detail', cacheKey);
    if (cached) {
        console.log(`[Cache] Hit detail: ${cacheKey}`);
        return res.json(cached);
    }

    try {
        console.log(`[Detail] ${site.name} -> ID: ${id}`);

        // 构建请求 URL
        const detailUrl = `${site.api}?ac=detail&ids=${encodeURIComponent(id)}`;
        const { data } = await fetchWithProxyFallback(detailUrl, { timeout: 8000 }, siteKey);

        if (data.list && data.list.length > 0) {
            const detail = data.list[0];
            cacheManager.set('detail', cacheKey, detail, 3600); // 缓存1小时
            res.json(detail);
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    } catch (error) {
        console.error(`[Detail Error] ${site.name}:`, error.message);
        res.status(500).json({ error: 'Detail fetch failed' });
    }
});

// 4. 图片代理与缓存 API (Server-Side Image Caching)
app.get('/api/tmdb-image/:size/:filename', async (req, res) => {
    const { size, filename } = req.params;
    const allowSizes = ['w300', 'w342', 'w500', 'w780', 'w1280', 'original'];

    // 安全检查：size 走白名单；filename 只允许 TMDB 实际格式 <字母数字>.<jpg/png/webp>，
    // 收紧后不再放过 '..' 或多段点，杜绝任何路径穿越尝试
    if (!allowSizes.includes(size) || !/^[A-Za-z0-9]+\.(jpg|jpeg|png|webp)$/i.test(filename)) {
        return res.status(400).send('Invalid parameters');
    }

    const tmdbUrl = `https://image.tmdb.org/t/p/${size}/${filename}`;

    // Vercel环境或Serverless环境：不可写文件系统，直接转发流
    if (process.env.VERCEL) {
        try {
            // 支持自定义反代 URL
            let targetUrl = tmdbUrl;
            if (process.env['TMDB_PROXY_URL']) {
                const proxyBase = process.env['TMDB_PROXY_URL'].replace(/\/$/, '');
                targetUrl = `${proxyBase}/t/p/${size}/${filename}`;
            }

            console.log(`[Vercel Image] Proxying: ${targetUrl}`);
            const response = await axios({
                url: targetUrl,
                method: 'GET',
                responseType: 'stream',
                timeout: 10000
            });
            // 缓存控制：公共缓存，有效期1天
            res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
            response.data.pipe(res);
        } catch (error) {
            console.error(`[Vercel Image Error] ${tmdbUrl}:`, error.message);
            res.status(404).send('Image not found');
        }
        return;
    }

    // --- 本地/VPS 环境下启用磁盘缓存 ---
    const localPath = path.join(IMAGE_CACHE_DIR, size, filename);
    const localDir = path.dirname(localPath);

    // 1. 如果本地存在且文件大小 > 0，更新访问时间并返回
    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
        // 更新文件的访问时间 (atime) 和修改时间 (mtime)，用于 LRU 清理
        try {
            const now = new Date();
            fs.utimesSync(localPath, now, now);
        } catch (e) { } // 忽略权限错误
        return res.sendFile(localPath);
    }

    // 2. 下载并缓存（支持 TMDB_PROXY_URL 代理）
    let fetchUrl = tmdbUrl;
    if (process.env['TMDB_PROXY_URL']) {
        const proxyBase = process.env['TMDB_PROXY_URL'].replace(/\/$/, '');
        fetchUrl = `${proxyBase}/t/p/${size}/${filename}`;
    }

    if (!fs.existsSync(localDir)) {
        try {
            fs.mkdirSync(localDir, { recursive: true });
        } catch (e) {
            console.error('[Cache Mkdir Error]', e.message);
            // 如果创建目录失败，降级为直接流式转发
            try {
                const response = await axios({ url: fetchUrl, method: 'GET', responseType: 'stream' });
                return response.data.pipe(res);
            } catch (err) { return res.status(404).send('Image not found'); }
        }
    }

    try {
        console.log(`[Image Proxy] Fetching: ${fetchUrl}`);
        const response = await axios({
            url: fetchUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 10000
        });

        const writer = fs.createWriteStream(localPath);

        // 使用 pipeline 处理流
        await pipeline(response.data, writer);

        // 下载完成后，检查缓存总大小并清理
        cleanCacheIfNeeded();

        // 发送文件
        res.sendFile(localPath);
    } catch (error) {
        console.error(`[Image Proxy Error] ${fetchUrl}:`, error.message);
        if (fs.existsSync(localPath)) {
            try { fs.unlinkSync(localPath); } catch (e) { }
        }
        res.status(404).send('Image not found');
    }
});

// ========== 缓存清理逻辑 ==========
const MAX_CACHE_SIZE_MB = 1024; // 1GB 缓存上限
const CLEAN_TRIGGER_THRESHOLD = 50; // 每添加50张新图检查一次 (减少IO压力)
let newItemCount = 0;

function cleanCacheIfNeeded() {
    newItemCount++;
    if (newItemCount < CLEAN_TRIGGER_THRESHOLD) return;
    newItemCount = 0;

    // 异步执行清理，不阻塞主线程
    setTimeout(() => {
        try {
            let totalSize = 0;
            let files = [];

            // 递归遍历缓存目录
            function traverseDir(dir) {
                if (!fs.existsSync(dir)) return;
                const items = fs.readdirSync(dir);
                items.forEach(item => {
                    const fullPath = path.join(dir, item);
                    const stats = fs.statSync(fullPath);
                    if (stats.isDirectory()) {
                        traverseDir(fullPath);
                    } else {
                        totalSize += stats.size;
                        files.push({ path: fullPath, size: stats.size, time: stats.mtime.getTime() });
                    }
                });
            }

            traverseDir(IMAGE_CACHE_DIR);

            const maxBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;
            console.log(`[Cache Trim] Current size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

            if (totalSize > maxBytes) {
                // 按时间排序，最旧的在前
                files.sort((a, b) => a.time - b.time);

                let deletedSize = 0;
                let targetDelete = totalSize - (maxBytes * 0.9); // 清理到 90%

                for (const file of files) {
                    if (deletedSize >= targetDelete) break;
                    try {
                        fs.unlinkSync(file.path);
                        deletedSize += file.size;
                    } catch (e) { console.error('Delete failed:', e); }
                }
                console.log(`[Cache Trim] Cleaned ${(deletedSize / 1024 / 1024).toFixed(2)} MB`);
            }
        } catch (err) {
            console.error('[Cache Trim Error]', err);
        }
    }, 100);
}

// 5. 认证检查 API
app.get('/api/auth/check', (req, res) => {
    // 检查是否需要密码
    res.json({
        requirePassword: ACCESS_PASSWORDS.length > 0,
        multiUserMode: ACCESS_PASSWORDS.length > 1
    });
});

// 6. 验证密码 API（支持多密码）
app.post('/api/auth/verify', (req, res) => {
    const { password, passwordHash } = req.body;

    // 无密码保护时直接通过
    if (ACCESS_PASSWORDS.length === 0) {
        return res.json({ success: true, syncEnabled: false });
    }

    // 计算输入的哈希值
    let inputHash;
    if (passwordHash) {
        inputHash = passwordHash;
    } else if (password) {
        inputHash = crypto.createHash('sha256').update(password).digest('hex');
    } else {
        return res.json({ success: false });
    }

    // 检查是否匹配任一密码
    const userInfo = PASSWORD_HASH_MAP[inputHash];
    if (userInfo !== undefined) {
        // 密码有效
        res.json({
            success: true,
            passwordHash: inputHash,
            // 同步功能状态
            syncEnabled: userInfo.syncEnabled,
            userIndex: userInfo.index
        });
    } else {
        res.json({ success: false });
    }
});

// ==================== SEO 优化：影片详情页 ====================

/**
 * 生成 SEO 友好的影片/剧集详情页
 * 路由格式：/movie/:id 或 /tv/:id
 * 包含完整的 meta 标签和 JSON-LD 结构化数据
 */
app.get('/movie/:id', async (req, res) => {
    await renderMediaPage(req, res, 'movie');
});

app.get('/tv/:id', async (req, res) => {
    await renderMediaPage(req, res, 'tv');
});

async function renderMediaPage(req, res, mediaType) {
    const id = req.params.id;
    const TMDB_API_KEY = process.env.TMDB_API_KEY;

    // 🔒 TMDB ID 必须是纯数字，拒绝任何含特殊字符的 id（防注入到 TMDB URL 与 HTML）
    if (!/^\d+$/.test(id)) {
        return res.redirect('/');
    }

    if (!TMDB_API_KEY) {
        return res.redirect('/');
    }

    try {
        // 服务器端调用：根据 SERVER_IN_CHINA 环境变量决定是否使用代理
        const TMDB_PROXY_URL = process.env['TMDB_PROXY_URL'];
        const serverInChina = process.env['SERVER_IN_CHINA'] === 'true';

        const baseUrl = (TMDB_PROXY_URL && serverInChina)
            ? `${TMDB_PROXY_URL.replace(/\/$/, '')}/api/3`  // 国内服务器使用代理
            : 'https://api.themoviedb.org/3';  // 海外服务器直连

        const detailUrl = `${baseUrl}/${mediaType}/${id}?api_key=${TMDB_API_KEY}&language=zh-CN`;

        const response = await axios.get(detailUrl, { timeout: 10000 });
        const data = response.data;

        const title = data.title || data.name || '未知影片';
        const overview = data.overview || '暂无简介';
        const posterPath = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : '';
        const backdropPath = data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : '';
        const releaseDate = data.release_date || data.first_air_date || '';
        const year = releaseDate ? releaseDate.split('-')[0] : '';
        const rating = data.vote_average ? data.vote_average.toFixed(1) : 'N/A';
        const genres = (data.genres || []).map(g => g.name).join(', ');
        const runtime = data.runtime || (data.episode_run_time && data.episode_run_time[0]) || 0;
        const siteUrl = getSiteUrl(req);

        // JSON-LD 结构化数据（让 Google 理解这是电影/电视剧）
        const jsonLd = {
            "@context": "https://schema.org",
            "@type": mediaType === 'movie' ? "Movie" : "TVSeries",
            "name": title,
            "description": overview,
            "image": posterPath,
            "datePublished": releaseDate,
            "aggregateRating": data.vote_average ? {
                "@type": "AggregateRating",
                "ratingValue": rating,
                "bestRating": "10",
                "ratingCount": data.vote_count || 0
            } : undefined,
            "genre": genres
        };

        // 🔒 预先 HTML 转义所有要插入页面的不可信文本（TMDB 数据可被社区编辑）
        const eTitle = escapeHtml(title);
        const eOverview = escapeHtml(overview);
        const eOverview160 = escapeHtml(overview.substring(0, 160));
        const eOverview200 = escapeHtml(overview.substring(0, 200));
        const eGenres = escapeHtml(genres);
        const eYear = escapeHtml(year);
        const eRating = escapeHtml(rating);
        const eRuntime = escapeHtml(runtime);
        const ePoster = escapeHtml(posterPath);
        const eBackdrop = escapeHtml(backdropPath || posterPath);
        // JSON-LD 注入 <script> 时必须转义 '<'，否则简介里的 </script> 可闭合标签造成 XSS
        const jsonLdSafe = JSON.stringify(jsonLd).replace(/</g, '\\u003c');

        // 生成完整的 HTML 页面
        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${eTitle} (${eYear}) - 在线观看 | E视界</title>
    <meta name="description" content="${eOverview160}">
    <meta name="keywords" content="${eTitle},${eYear},在线观看,免费电影,高清${mediaType === 'movie' ? '电影' : '电视剧'}">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${siteUrl}/${mediaType}/${id}">
    
    <!-- Open Graph -->
    <meta property="og:type" content="${mediaType === 'movie' ? 'video.movie' : 'video.tv_show'}">
    <meta property="og:url" content="${siteUrl}/${mediaType}/${id}">
    <meta property="og:title" content="${eTitle} (${eYear}) - 在线观看">
    <meta property="og:description" content="${eOverview200}">
    <meta property="og:image" content="${ePoster}">
    <meta property="og:locale" content="zh_CN">

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${eTitle} (${eYear})">
    <meta name="twitter:description" content="${eOverview200}">
    <meta name="twitter:image" content="${eBackdrop}">

    <!-- JSON-LD 结构化数据 -->
    <script type="application/ld+json">${jsonLdSafe}</script>
    
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #141414; color: #fff; min-height: 100vh; }
        .hero { position: relative; height: 60vh; background-size: cover; background-position: center; }
        .hero::after { content: ''; position: absolute; inset: 0; background: linear-gradient(to top, #141414 0%, transparent 50%, rgba(0,0,0,0.5) 100%); }
        .content { position: relative; z-index: 1; max-width: 1200px; margin: 0 auto; padding: 20px; margin-top: -200px; display: flex; gap: 40px; }
        .poster { width: 300px; flex-shrink: 0; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .info { flex: 1; }
        h1 { font-size: 2.5rem; margin-bottom: 10px; }
        .meta { color: #aaa; margin-bottom: 20px; }
        .meta span { margin-right: 20px; }
        .rating { color: #ffd700; }
        .overview { line-height: 1.8; color: #ccc; margin-bottom: 30px; }
        .btn-play { background: #e50914; color: #fff; border: none; padding: 15px 40px; font-size: 1.2rem; border-radius: 5px; cursor: pointer; text-decoration: none; display: inline-block; }
        .btn-play:hover { background: #f40612; }
        @media (max-width: 768px) { .content { flex-direction: column; margin-top: -100px; } .poster { width: 200px; margin: 0 auto; } h1 { font-size: 1.5rem; text-align: center; } }
    </style>
</head>
<body>
    <div class="hero" style="background-image: url('${eBackdrop}')"></div>
    <div class="content">
        ${posterPath ? `<img src="${ePoster}" alt="${eTitle}" class="poster">` : ''}
        <div class="info">
            <h1>${eTitle}</h1>
            <div class="meta">
                <span>${eYear}</span>
                ${runtime ? `<span>${eRuntime} 分钟</span>` : ''}
                <span class="rating">★ ${eRating}</span>
                ${genres ? `<span>${eGenres}</span>` : ''}
            </div>
            <p class="overview">${eOverview}</p>
            <a href="/?search=${encodeURIComponent(title)}" class="btn-play">▶ 立即观看</a>
        </div>
    </div>
    
    <!-- 自动跳转到主站搜索 (3秒后) -->
    <script>
        // 用户点击播放按钮或等待3秒后跳转到主站
        setTimeout(function() {
            // 不自动跳转，让用户主动点击
        }, 3000);
    </script>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 缓存1天
        res.send(html);

    } catch (error) {
        console.error(`[SEO Page Error] ${mediaType}/${id}:`, error.message);
        res.redirect('/');
    }
}

/**
 * 动态生成 sitemap.xml
 * 包含热门电影和电视剧的 URL
 */
app.get('/sitemap.xml', async (req, res) => {
    const TMDB_API_KEY = process.env.TMDB_API_KEY;
    const siteUrl = getSiteUrl(req);
    const today = new Date().toISOString().split('T')[0];

    let urls = [
        // 首页
        `<url><loc>${siteUrl}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`
    ];

    if (TMDB_API_KEY) {
        try {
            // 服务器端调用：根据 SERVER_IN_CHINA 环境变量决定是否使用代理
            // 如果服务器在国内，设置 SERVER_IN_CHINA=true
            const TMDB_PROXY_URL = process.env['TMDB_PROXY_URL'];
            const serverInChina = process.env['SERVER_IN_CHINA'] === 'true';

            const baseUrl = (TMDB_PROXY_URL && serverInChina)
                ? `${TMDB_PROXY_URL.replace(/\/$/, '')}/api/3`  // 国内服务器使用代理
                : 'https://api.themoviedb.org/3';  // 海外服务器直连

            // 获取热门电影 (前 40 部)
            const movieUrl = `${baseUrl}/movie/popular?api_key=${TMDB_API_KEY}&language=zh-CN&page=1`;
            const movieUrl2 = `${baseUrl}/movie/popular?api_key=${TMDB_API_KEY}&language=zh-CN&page=2`;

            const [movieRes1, movieRes2] = await Promise.all([
                axios.get(movieUrl, { timeout: 10000 }).catch(() => ({ data: { results: [] } })),
                axios.get(movieUrl2, { timeout: 10000 }).catch(() => ({ data: { results: [] } }))
            ]);

            const movies = [...(movieRes1.data.results || []), ...(movieRes2.data.results || [])];
            movies.forEach(m => {
                urls.push(`<url><loc>${siteUrl}/movie/${m.id}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
            });

            // 获取热门电视剧 (前 40 部)
            const tvUrl = `${baseUrl}/tv/popular?api_key=${TMDB_API_KEY}&language=zh-CN&page=1`;
            const tvUrl2 = `${baseUrl}/tv/popular?api_key=${TMDB_API_KEY}&language=zh-CN&page=2`;

            const [tvRes1, tvRes2] = await Promise.all([
                axios.get(tvUrl, { timeout: 10000 }).catch(() => ({ data: { results: [] } })),
                axios.get(tvUrl2, { timeout: 10000 }).catch(() => ({ data: { results: [] } }))
            ]);

            const tvShows = [...(tvRes1.data.results || []), ...(tvRes2.data.results || [])];
            tvShows.forEach(t => {
                urls.push(`<url><loc>${siteUrl}/tv/${t.id}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
            });

            console.log(`[Sitemap] Generated with ${movies.length} movies and ${tvShows.length} TV shows`);

        } catch (error) {
            console.error('[Sitemap Error]', error.message);
        }
    }

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 缓存1小时
    res.send(sitemap);
});

// Helper: Get DB data (Local or Remote)
function getDB() {
    if (remoteDbCache) return remoteDbCache;
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

// 本地/Docker 环境：启动服务器监听
// Vercel 环境下不需要调用 listen()，它会自动处理
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`Image Cache Directory: ${IMAGE_CACHE_DIR}`);
    });
}

// 始终导出 app 模块 (Vercel Serverless 需要)
module.exports = app;
