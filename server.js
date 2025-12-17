require('dotenv').config();
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

// 图片缓存目录
const IMAGE_CACHE_DIR = path.join(__dirname, 'public/cache/images');
if (!fs.existsSync(IMAGE_CACHE_DIR)) {
    fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
}

// 访问密码配置
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const PASSWORD_HASH = ACCESS_PASSWORD ? crypto.createHash('sha256').update(ACCESS_PASSWORD).digest('hex') : '';

// 远程配置URL
const REMOTE_DB_URL = process.env.REMOTE_DB_URL || '';

// 远程配置缓存
let remoteDbCache = null;
let remoteDbLastFetch = 0;
const REMOTE_DB_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 缓存配置
const CACHE_TYPE = process.env.CACHE_TYPE || 'json'; // json, sqlite, memory, none
const SEARCH_CACHE_JSON = path.join(__dirname, 'cache_search.json');
const DETAIL_CACHE_JSON = path.join(__dirname, 'cache_detail.json');
const CACHE_DB_FILE = path.join(__dirname, 'cache.db');

console.log(`[System] Cache Type: ${CACHE_TYPE}`);

// 初始化数据库文件
if (!fs.existsSync(DATA_FILE)) {
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
            // (SQLite implementation simplified for brevity)
        }
    }

    get(category, key) {
        if (this.type === 'memory') {
            return category === 'search' ? this.searchCache[key] : this.detailCache[key];
        } else if (this.type === 'json') {
            const data = category === 'search' ? this.searchCache[key] : this.detailCache[key];
            if (data && data.expire > Date.now()) return data.value;
            return null;
        }
        return null;
    }

    set(category, key, value, ttlSeconds = 600) {
        const expire = Date.now() + ttlSeconds * 1000;
        const item = { value, expire };
        if (this.type === 'memory' || this.type === 'json') {
            if (category === 'search') this.searchCache[key] = item;
            else this.detailCache[key] = item;

            if (this.type === 'json') {
                this.saveDisk(); // Simple impl: save on every set (optimize for production!)
            }
        }
    }

    saveDisk() {
        if (this.type === 'json') {
            fs.writeFileSync(SEARCH_CACHE_JSON, JSON.stringify(this.searchCache));
            fs.writeFileSync(DETAIL_CACHE_JSON, JSON.stringify(this.detailCache));
        }
    }
}

const cacheManager = new CacheManager(CACHE_TYPE);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ========== 路由定义 ==========

const IS_VERCEL = !!process.env.VERCEL;

app.get('/api/config', (req, res) => {
    res.json({
        tmdb_api_key: process.env.TMDB_API_KEY,
        tmdb_proxy_url: process.env.TMDB_PROXY_URL,
        // Vercel 环境下禁用本地图片缓存，防止写入报错
        enable_local_image_cache: !IS_VERCEL
    });
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

// 2. 搜索 API (带缓存)
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
        const response = await axios.get(site.api, {
            params: { ac: 'detail', wd: keyword },
            timeout: 8000
        });

        const data = response.data;
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

        cacheManager.set('search', cacheKey, result, 600); // 缓存10分钟
        res.json(result);
    } catch (error) {
        console.error(`[Search Error] ${site.name}:`, error.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

// 3. 详情 API (带缓存)
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
        const response = await axios.get(site.api, {
            params: { ac: 'detail', ids: id },
            timeout: 8000
        });

        const data = response.data;
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

    const localPath = path.join(IMAGE_CACHE_DIR, size, filename);
    const localDir = path.dirname(localPath);

    // 1. 如果本地存在且文件大小 > 0，更新访问时间并返回
    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
        // 更新文件的访问时间 (atime) 和修改时间 (mtime)，用于 LRU 清理
        const now = new Date();
        fs.utimesSync(localPath, now, now);
        return res.sendFile(localPath);
    }

    // 2. 下载并缓存
    if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
    }

    const tmdbUrl = `https://image.tmdb.org/t/p/${size}/${filename}`;

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
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
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
    // 简单检查 header 中的 token (示例：实际需更强验证)
    // 这里简单返回是否需要密码
    res.json({ requirePassword: !!ACCESS_PASSWORD });
});

// 6. 验证密码 API
app.post('/api/auth/verify', (req, res) => {
    const { password, passwordHash } = req.body;
    if (!ACCESS_PASSWORD) return res.json({ success: true });

    // 支持两种验证方式：
    // 1. 前端发送原始密码 (password) - 后端哈希后比较
    // 2. 前端发送哈希值 (passwordHash) - 直接比较
    let inputHash;
    if (passwordHash) {
        inputHash = passwordHash;
    } else if (password) {
        inputHash = crypto.createHash('sha256').update(password).digest('hex');
    } else {
        return res.json({ success: false });
    }

    if (inputHash === PASSWORD_HASH) {
        res.json({ success: true, token: 'session_token_placeholder' });
    } else {
        res.json({ success: false });
    }
});

// Helper: Get DB data (Local or Remote)
function getDB() {
    if (remoteDbCache) return remoteDbCache;
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Image Cache Directory: ${IMAGE_CACHE_DIR}`);
});
