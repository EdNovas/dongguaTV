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

// 远程配置URL
const REMOTE_DB_URL = process.env['REMOTE_DB_URL'] || '';

// CORS 代理 URL（用于中转无法直接访问的资源站 API）
const CORS_PROXY_URL = process.env['CORS_PROXY_URL'] || '';

// 环境变量加载状态日志（用于 Vercel 调试）
console.log(`[System] Environment: ${process.env.VERCEL ? 'Vercel Serverless' : 'Local/VPS'}`);
console.log(`[System] TMDB_API_KEY: ${process.env.TMDB_API_KEY ? '✓ Configured' : '✗ Missing'}`);
console.log(`[System] TMDB_PROXY_URL: ${process.env['TMDB_PROXY_URL'] || '(not set)'}`);
console.log(`[System] CORS_PROXY_URL: ${CORS_PROXY_URL || '(not set)'}`);
console.log(`[System] REMOTE_DB_URL: ${REMOTE_DB_URL ? '✓ Configured' : '(not set)'}`);



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
 * 检测 IP 是否来自中国大陆
 * 使用 ip.sb API，带缓存
 * @param {string} ip - IP 地址
 * @returns {Promise<boolean>} - 是否是中国大陆 IP
 */
async function isChineseIP(ip) {
    if (!ip || ip === '127.0.0.1' || ip === '::1') {
        return false; // 本地 IP 不认为是国内
    }

    // 检查缓存
    const cached = ipLocationCache.get(ip);
    if (cached && (Date.now() - cached.time < IP_CACHE_TTL)) {
        return cached.isCN;
    }

    try {
        const response = await axios.get(`https://api.ip.sb/geoip/${ip}`, {
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
        ipLocationCache.set(ip, { isCN, time: Date.now() });
        console.log(`[IP Detection] ${ip} -> ${isCN ? '中国大陆' : '海外'}`);
        return isCN;

    } catch (error) {
        // API 调用失败，默认不使用代理
        console.error(`[IP Detection Error] ${ip}:`, error.message);
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
        } else if (this.type === 'sqlite') {
            try {
                const Database = require('better-sqlite3');
                this.db = new Database(CACHE_DB_FILE);

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

                // 创建索引加速过期查询
                this.db.exec(`CREATE INDEX IF NOT EXISTS idx_expire ON cache(expire)`);
                this.db.exec(`CREATE INDEX IF NOT EXISTS idx_history_user ON user_history(user_token)`);

                // 清理过期数据
                this.db.prepare('DELETE FROM cache WHERE expire < ?').run(Date.now());

                console.log(`[SQLite Cache] Database initialized: ${CACHE_DB_FILE}`);
            } catch (e) {
                console.error('[SQLite Cache] Init failed, falling back to memory:', e.message);
                this.type = 'memory';
            }
        }
    }

    get(category, key) {
        if (this.type === 'memory') {
            const data = category === 'search' ? this.searchCache[key] : this.detailCache[key];
            if (data && data.expire > Date.now()) return data.value;
            return null;
        } else if (this.type === 'json') {
            const data = category === 'search' ? this.searchCache[key] : this.detailCache[key];
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
            const item = { value, expire };
            if (category === 'search') this.searchCache[key] = item;
            else this.detailCache[key] = item;
        } else if (this.type === 'json') {
            const item = { value, expire };
            if (category === 'search') this.searchCache[key] = item;
            else this.detailCache[key] = item;
            this.saveDisk();
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

    saveDisk() {
        if (this.type === 'json') {
            fs.writeFileSync(SEARCH_CACHE_JSON, JSON.stringify(this.searchCache));
            fs.writeFileSync(DETAIL_CACHE_JSON, JSON.stringify(this.detailCache));
        }
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
app.use(bodyParser.json());

// ========== API 速率限制 ==========
const rateLimit = require('express-rate-limit');

// 通用 API 限流：每 IP 每分钟最多 600 次请求
// 注意：页面加载时会发送大量图片和 API 请求，需要足够高的限制
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 分钟窗口
    max: 600, // 每 IP 最多 600 次（约 10 次/秒）
    standardHeaders: true, // 返回 RateLimit-* 标准头
    legacyHeaders: false, // 禁用 X-RateLimit-* 旧头
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
    message: { error: '搜索请求过于频繁，请稍后再试' }
});

// 应用通用限流
app.use(apiLimiter);

// 对搜索 API 应用更严格的限流
app.use('/api/search', searchLimiter);

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

// ⚠️ 关键：HTML 和 Service Worker 不缓存，确保用户获取最新版本
app.get(['/', '/index.html', '/sw.js'], (req, res, next) => {
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
        multi_user_mode: ACCESS_PASSWORDS.length > 1
    });
});

// 诊断端点：检查环境变量配置状态（用于 Vercel 调试）
app.get('/api/debug', (req, res) => {
    res.json({
        environment: IS_VERCEL ? 'Vercel Serverless' : 'Local/VPS',
        node_version: process.version,
        env_status: {
            TMDB_API_KEY: process.env.TMDB_API_KEY ? 'configured' : 'missing',
            TMDB_PROXY_URL: process.env['TMDB_PROXY_URL'] ? 'configured' : 'not_set',
            ACCESS_PASSWORD: ACCESS_PASSWORDS.length > 0 ? `${ACCESS_PASSWORDS.length} password(s)` : 'not_set',
            REMOTE_DB_URL: REMOTE_DB_URL ? 'configured' : 'not_set',
            CACHE_TYPE: process.env.CACHE_TYPE || 'json (default)'
        },
        cache_type: cacheManager.type,
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
    if (!userInfo.syncEnabled) {
        return res.json({ sync_enabled: false, history: [] });
    }

    // 从 SQLite 获取历史记录
    if (cacheManager.type !== 'sqlite' || !cacheManager.db) {
        return res.json({ sync_enabled: true, history: [], message: 'SQLite not available' });
    }

    try {
        const stmt = cacheManager.db.prepare('SELECT item_id, item_data, updated_at FROM user_history WHERE user_token = ?');
        const rows = stmt.all(userToken);

        const history = rows.map(row => ({
            id: row.item_id,
            data: JSON.parse(row.item_data),
            updated_at: row.updated_at
        }));

        res.json({ sync_enabled: true, history: history });
    } catch (e) {
        console.error('[History Pull Error]', e.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// 推送历史记录到服务器
app.post('/api/history/push', (req, res) => {
    const { token, history } = req.body;

    if (!token || !Array.isArray(history)) {
        return res.status(400).json({ error: 'Missing token or history' });
    }

    // 验证 token
    const userInfo = PASSWORD_HASH_MAP[token];
    if (!userInfo) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    if (!userInfo.syncEnabled) {
        return res.json({ sync_enabled: false, saved: 0 });
    }

    // 保存到 SQLite
    if (cacheManager.type !== 'sqlite' || !cacheManager.db) {
        return res.json({ sync_enabled: true, saved: 0, message: 'SQLite not available' });
    }

    try {
        const insertStmt = cacheManager.db.prepare(`
            INSERT OR REPLACE INTO user_history (user_token, item_id, item_data, updated_at)
            VALUES (?, ?, ?, ?)
        `);

        let saved = 0;
        const transaction = cacheManager.db.transaction((items) => {
            for (const item of items) {
                if (item.id && item.data) {
                    insertStmt.run(
                        token,
                        item.id,
                        JSON.stringify(item.data),
                        item.updated_at || Date.now()
                    );
                    saved++;
                }
            }
        });

        transaction(history);

        res.json({ sync_enabled: true, saved: saved });
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
        // 获取用户 IP 并判断是否来自中国大陆
        const clientIP = getClientIP(req);
        const TMDB_PROXY_URL = process.env['TMDB_PROXY_URL'];

        // 只有配置了代理 URL 且用户来自中国大陆时，才使用代理
        let useProxy = false;
        if (TMDB_PROXY_URL) {
            useProxy = await isChineseIP(clientIP);
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
        // 非流式模式：返回普通 JSON
        return res.json({ error: 'Use stream=true for GET requests' });
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
    const sites = getDB().sites;
    const site = sites.find(s => s.key === siteKey);

    if (!site) return res.status(404).json({ error: 'Site not found' });

    const cacheKey = `${siteKey}_detail_${id}`;
    const cached = cacheManager.get('detail', cacheKey);
    if (cached) {
        console.log(`[Cache] Hit detail: ${cacheKey}`);
        // 返回格式：{ list: [detail] }，与前端期望一致
        return res.json({ list: [cached] });
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

    // 安全检查
    if (!allowSizes.includes(size) || !/^[a-zA-Z0-9_\-\.]+$/.test(filename)) {
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

    // 2. 下载并缓存
    if (!fs.existsSync(localDir)) {
        try {
            fs.mkdirSync(localDir, { recursive: true });
        } catch (e) {
            console.error('[Cache Mkdir Error]', e.message);
            // 如果创建目录失败，降级为直接流式转发
            try {
                const response = await axios({ url: tmdbUrl, method: 'GET', responseType: 'stream' });
                return response.data.pipe(res);
            } catch (err) { return res.status(404).send('Image not found'); }
        }
    }

    try {
        console.log(`[Image Proxy] Fetching: ${tmdbUrl}`);
        const response = await axios({
            url: tmdbUrl,
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
        console.error(`[Image Proxy Error] ${tmdbUrl}:`, error.message);
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
        const siteUrl = process.env.SITE_URL || 'https://ednovas.video';

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

        // 生成完整的 HTML 页面
        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} (${year}) - 在线观看 | E视界</title>
    <meta name="description" content="${overview.substring(0, 160)}">
    <meta name="keywords" content="${title},${year},在线观看,免费电影,高清${mediaType === 'movie' ? '电影' : '电视剧'}">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${siteUrl}/${mediaType}/${id}">
    
    <!-- Open Graph -->
    <meta property="og:type" content="${mediaType === 'movie' ? 'video.movie' : 'video.tv_show'}">
    <meta property="og:url" content="${siteUrl}/${mediaType}/${id}">
    <meta property="og:title" content="${title} (${year}) - 在线观看">
    <meta property="og:description" content="${overview.substring(0, 200)}">
    <meta property="og:image" content="${posterPath}">
    <meta property="og:locale" content="zh_CN">
    
    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title} (${year})">
    <meta name="twitter:description" content="${overview.substring(0, 200)}">
    <meta name="twitter:image" content="${backdropPath || posterPath}">
    
    <!-- JSON-LD 结构化数据 -->
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    
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
    <div class="hero" style="background-image: url('${backdropPath}')"></div>
    <div class="content">
        ${posterPath ? `<img src="${posterPath}" alt="${title}" class="poster">` : ''}
        <div class="info">
            <h1>${title}</h1>
            <div class="meta">
                <span>${year}</span>
                ${runtime ? `<span>${runtime} 分钟</span>` : ''}
                <span class="rating">★ ${rating}</span>
                ${genres ? `<span>${genres}</span>` : ''}
            </div>
            <p class="overview">${overview}</p>
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
    const siteUrl = process.env.SITE_URL || 'https://ednovas.video';
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
