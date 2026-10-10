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

// 🎌 Kazumi 规则源(七色番/动漫巴士):与 server.js 共用 lib/kazumi(同一份实现,勿在此另抄一份)。
//    加载失败只禁用这批源;KAZUMI_DISABLE=1 整体关闭。Serverless 下模块内缓存按实例存活,冷启动会重抓(可接受)。
let kazumi = null;
try { kazumi = require('../lib/kazumi'); } catch (e) { console.warn('[Kazumi] 模块加载失败,规则源已禁用:', e.message); }
const withKzSites = (sites) => {
    if (!kazumi) return sites || [];
    const base = sites || [];
    let kz = [];
    try { kz = kazumi.getSites(); } catch (e) { console.warn('[Kazumi] getSites 失败,本次只用 maccms 站:', e.message); }
    const have = new Set(base.map(x => x.key));
    return base.concat(kz.filter(x => !have.has(x.key)));
};
if (kazumi) { try { kazumi.registerRoutes(app); } catch (e) { console.warn('[Kazumi] 路由注册失败:', e.message); } }
// ✂️ 剪掉插播后的清单托管:无状态函数存不住(POST 与之后的 GET 可能落在不同实例)→ 只挂 501 桩;/api/config 报 hls_cut:false,
//    前端在 Safari 原生 HLS 上退回"播放中静默跳过"(hls.js 通道在浏览器里剪,不需要服务器)
try { require('../lib/hls-cut').registerStub(app); } catch (e) { console.warn('[HlsCut] 桩注册失败:', e.message); }
// 🏷️ 资源站档案(徽章/选源偏好):与 server.js 共用 lib/site-profiles(静态 require,Vercel 才会把 profiles.json 打包)。
//    加载失败/查询抛错只是不带徽章,绝不影响搜索与播放。
let siteProfiles = null;
try { siteProfiles = require('../lib/site-profiles'); } catch (e) { console.warn('[SiteProfiles] 模块加载失败,线路徽章已禁用:', e.message); }
const profOf = (site) => {
    if (!siteProfiles) return undefined;   // undefined → JSON 里没有 site_profile 字段,前端回退 /api/sites 的 profiles 表
    try { return siteProfiles.profileFor(site); } catch (e) { return undefined; }
};
// /api/sites 附带 {key: 档案} 表(含内置规则站)。返回新对象,绝不改 EMBEDDED_SITES/remoteDbCache
const withSiteProfiles = (d) => {
    if (!siteProfiles || !d || typeof d !== 'object') return d;
    try {
        const base = Array.isArray(d.sites) ? d.sites : [];
        return Object.assign({}, d, { profiles: siteProfiles.profileMap(withKzSites(base)), profiles_version: siteProfiles.version });
    } catch (e) { console.warn('[SiteProfiles] profileMap 失败,本次不带徽章:', e.message); return d; }
};

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
// ⚠️ 必须无原型:普通 {} 上 PASSWORD_HASH_MAP['constructor'] / ['__proto__'] / ['toString'] 都是真值,
//    passwordHash:'constructor' 就能通过 /api/auth/verify 和各接口的 !PASSWORD_HASH_MAP[token] 校验(审查实锤)
const PASSWORD_HASH_MAP = Object.create(null);
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
    // 所有出口统一走 send:附带档案表(空站点也带内置规则站的档案)
    const send = (d) => res.json(withSiteProfiles(d));
    try {
        // 优先使用嵌入的站点配置（不过期）
        if (EMBEDDED_SITES) {
            return send(EMBEDDED_SITES);
        }

        // 使用远程配置（带缓存）
        const now = Date.now();
        if (remoteDbCache && now - remoteDbLastFetch < REMOTE_DB_CACHE_TTL) {
            return send(remoteDbCache);
        }
        if (REMOTE_DB_URL) {
            const response = await axios.get(REMOTE_DB_URL, { timeout: 5000 });
            if (response.data && Array.isArray(response.data.sites)) {
                remoteDbCache = response.data;
                remoteDbLastFetch = now;
                return send(remoteDbCache);
            }
        }
        // Vercel 环境下没有本地 db.json，返回空
        return send({ sites: [] });
    } catch (err) {
        console.error('[Remote DB Error]', err.message);
        return send({ sites: [] });
    }
});

// ========== API: /api/check ==========
// 服务器端测速兜底：客户端直连+代理都失败时(混合内容/CORS)由服务器测资源站 API 延迟。
// 注：此接口在早期重构中丢失，前端一直调用导致 404 → 服务器测速这条兜底失效，已恢复。
// 🗄️ 内存缓存 + 同站并发合并(同 server.js;serverless 实例内 best-effort):通的 5 分钟、不通的 90 秒;
//    上游【超时】得出的 9999 带 transient:true 且不缓存,前端据此不写 12h 死亡缓存。
const checkCache = new Map();      // key -> { data, expiry }
const checkInflight = new Map();   // key -> Promise<data>
const CHECK_OK_TTL = 5 * 60 * 1000, CHECK_FAIL_TTL = 90 * 1000, CHECK_CACHE_MAX = 1000;
const isTimeoutErr = (e) => !!e && (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || /timeout/i.test(String(e.message || '')));
app.get('/api/check', async (req, res) => {
    const key = String(req.query.key || '');
    // 「刷新线路」带 nocache=1:跳过读缓存强制真测(结果照样写回、照样并发合并)
    const hit = req.query.nocache === '1' ? null : checkCache.get(key);
    // 缓存里的失败只当【瞬态】发给别的用户:一次上游抖动(502/连接重置)不能经 90s 缓存扩散成每个人本地 12h 的死亡记录;
    //   只有亲自跑了这次探测的那个请求拿到非 transient 的失败
    if (hit && hit.expiry > Date.now()) return res.json(hit.data.latency >= 9000 ? Object.assign({}, hit.data, { transient: true }) : hit.data);
    let p = checkInflight.get(key);
    const mine = !p;   // 这次请求亲自跑探测;并发合并进来的请求拿到失败时一律按瞬态(同缓存命中的规则)
    if (!p) {
        p = runSiteCheck(key).then((data) => {
            if (!data.transient) {
                if (checkCache.size >= CHECK_CACHE_MAX) checkCache.delete(checkCache.keys().next().value);
                checkCache.set(key, { data, expiry: Date.now() + (data.latency < 9000 ? CHECK_OK_TTL : CHECK_FAIL_TTL) });
            }
            return data;
        }).catch(() => ({ latency: 9999, transient: true })).finally(() => checkInflight.delete(key));
        checkInflight.set(key, p);
    }
    const d = await p;
    res.json(!mine && d.latency >= 9000 && !d.transient ? Object.assign({}, d, { transient: true }) : d);
});
async function runSiteCheck(key) {
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
        const sites = withKzSites((sitesData && sitesData.sites) || []);
        const site = sites.find(s => s.key === key);
        if (site && kazumi && kazumi.isKzSite(site)) return await kazumi.check(site.key);   // 🎌 只测首页可达,不拉媒体
        if (!site || !site.api) return { latency: 9999 };
        const start = Date.now();
        try {
            await axios.get(`${site.api}?ac=list&pg=1`, { timeout: 3000 });
            return { latency: Date.now() - start, _testType: 'server' };
        } catch (e) {
            return isTimeoutErr(e) ? { latency: 9999, transient: true } : { latency: 9999 };
        }
    } catch (e) {
        return { latency: 9999, transient: true };
    }
}

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
const danmakuUrlMode = new Map();    // danmu_api 实例 -> 发现它不认 comment?url=(老版本,只能按 id)的时间
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
// danmu_api 这边的配置问题(版本太旧、开着限流)在前台只表现为"没弹幕":每类每实例 10 分钟在日志里提醒一次怎么改
const danmakuWarnedAt = new Map();
function danmakuWarnOnce(key, msg) {
    if (Date.now() - (danmakuWarnedAt.get(key) || 0) < 600e3) return;
    danmakuWarnedAt.set(key, Date.now());
    console.warn(msg);
}
// danmu_api 自带按来源 IP 的取弹幕限流(RATE_LIMIT_MAX_REQUESTS,默认每分钟 3 次),本站替所有观众去取,在它看来只有一个 IP
function danmakuWarnRateLimited(base) {
    danmakuWarnOnce('429|' + base, `⚠️ [弹幕] ${base} 取弹幕返回 429 限流:多半是 danmu_api 没设 RATE_LIMIT_MAX_REQUESTS=0(它默认每个来源 IP 每分钟只放 3 次,本站替所有观众去取,在它看来只有一个 IP)。` +
        `给 danmu_api 设上这个环境变量再重启即可(Docker 要带 -e 重建容器,见 README「弹幕服务 danmu_api」)`);
}
// danmu_api v1.20.10 起搜索结果才带视频地址(url);更老的版本在多实例部署上按地址取不了、按 id 又会串剧
function danmakuWarnNoUrl(base) {
    danmakuWarnOnce('nourl|' + base, `⚠️ [弹幕] ${base} 的 danmu_api 太旧:搜索结果不带视频地址(url 字段 v1.20.10 起才有),本站按视频地址取弹幕,从这个实例一条都取不到。` +
        `请把 danmu_api 升级到最新版(自己服务器上只跑一个实例的,也可以设 DANMU_API_SINGLE_INSTANCE=1 改按 id 取)`);
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
// 🏅 弹幕候选排序(纯函数;scripts/danmaku-match-test.mjs 把它从 server.js / api/index.js 抽出来用真实候选回放,两份必须一致)。
//   danmu_api 按剧名搜出的候选 animeTitle 形如 "片名(年份)【类型】from 来源",这里挑出"就是我方这部"的那几个。
//   返回 { pool, bestTier, why }:pool = 最佳档内排好序的候选(调用方依次取集,最多试 3 个);bestTier 决定缓存多久。
//   贴合度分档:
//     0 精确同名(标点/繁体数字/罗马数字/海贼王↔航海王 已归一);
//     1 结构化等价 —— 去年份同名 / 季号写法不同(庆余年2↔第二季、仙剑奇侠传三↔第三部)/ 我方没写季号↔"第一季"、我方"第一季"↔裸名 /
//       年份式↔季号式 / 只差版本标签(未删减版、国语)/ "剧场版"位置不同 / 演员版本名且年份对得上 / 带[卫视版][全季]等标签的同名页;
//     2 只是名字互相包含(低置信:可能是续集/前传/同名别的作品,只短缓存);
//     9 不要:明确是别的季、电影↔非电影、路演/直播/花絮/纯享/小剧场等衍生内容、短剧撞名、年份差太多的翻拍。
//   hints(前端带来的我方信息;旧前端没有):type = 资源站分类(国产剧/大陆综艺/动作片/现代都市…),year = 资源站年份,eps = 我方集数。
//   规则全部用真实候选回放校过(scripts/fixtures/danmaku/real-cases.json:6 组约 200 例,读线上弹幕核对过内容)。原则:宁可没弹幕,不错配。
const DANMAKU_VERSION_ONLY = /^(?:(?:无删减|未删减|删减|完整|普通话|国语|粤语|沪语|闽南语|台语|原声|中字|中文字幕|双语|tv|加长|导演剪辑|会员|独播|4k|高清|蓝光|中配|日配|日语|英语|韩语|电视剧|剧集|hd|dvd)版?)+$/i;
// 衍生内容(不是这部作品本身的时间轴):路演直播、发布会、花絮、纯享/高光剪辑、解说、小剧场……
const DANMAKU_DERIVED = /路演|直播|发布会|特辑|幕后|花絮|预告|片花|采访|专访|访谈|解说|片段|混剪|剪辑|reaction|首映|彩蛋|纯享|精华|精编|高光|速看|浓缩|直拍|加更|plus|探班|看点|二创|赏析|盘点|vlog|回顾|小剧场|番外篇|周边|手办|制作特辑|合集/i;
// 我方自己就是剪辑版(纯享/精编/高光…):只有同样是这种剪辑的候选才对得上时间轴(held-out 实锤:纯享版配到了完整版)
const DANMAKU_EDIT = /纯享|精编|高光|精华|速看|浓缩|解说/;
function danmakuKindOfOurs(type, eps) {
    const t = String(type || '');
    let k = null;
    if (/综艺|真人秀|晚会|脱口秀/.test(t)) k = 'variety';
    else if (/动画片|动画电影|动漫电影|剧场版|电影版/.test(t)) k = 'movie';
    else if (/动漫|番剧|动画/.test(t)) k = 'anime';
    else if (/纪录|记录/.test(t)) k = null;                 // 纪录片既有单部也有系列,不判(弹幕源也常把纪录片标成综艺)
    else if (/片$|电影|影片/.test(t)) k = 'movie';          // 动作片/剧情片/喜剧片…(先于"剧":剧情片不是剧集)。信分类不信集数:有站把一部电影切成十几段
    else if (/短剧|现代都市|古装仙侠|穿越重生|女频|男频|爽剧|爽文|脑洞|战神|赘婿|甜宠|逆袭|萌宝|虐恋|总裁|神医|神豪|穿书/.test(t)) k = 'short';   // 短剧分类:常借名剧的名字(人世间/误杀/父母爱情1999);不放"年代/民国/宫斗"这类普通剧集也会用的词
    else if (/剧/.test(t)) k = 'tv';                        // 国产剧/韩剧/美剧/港剧/台剧/日剧/海外剧…
    if (!k && (Number(eps) || 0) >= 3) k = 'series';
    return k;
}
function danmakuKindOfCand(a) {
    const raw = String((a && a.animeTitle) || '');
    if (/剧场版|电影版|\bmovie\b|\bfilm\b/i.test(raw.replace(/【[^】]*】/g, ''))) return 'movie';   // 弹幕源常把动画电影标成【动漫】,看片名里的"剧场版"
    const m = raw.match(/【([^】]*)】/);
    const s = [a && a.typeDescription, a && a.type, m && m[1]].filter(Boolean).join(' ');
    if (/电影|movie/i.test(s)) return 'movie';
    if (/综艺/.test(s)) return 'variety';
    if (/动漫|动画|番剧|anime/i.test(s)) return 'anime';
    if (/电视剧|剧集|连续剧|\btv\b/i.test(s)) return 'tv';
    return null;
}
function danmakuRankCandidates(animes, title, hints) {
    hints = hints || {};
    const CN_DIGIT = { 壹: '一', 贰: '二', 叁: '三', 肆: '四', 伍: '五', 陆: '六', 柒: '七', 捌: '八', 玖: '九', 拾: '十' };
    const ROMAN = { Ⅰ: '1', Ⅱ: '2', Ⅲ: '3', Ⅳ: '4', Ⅴ: '5', Ⅵ: '6', Ⅶ: '7', Ⅷ: '8', Ⅸ: '9', Ⅹ: '10' };
    // 归一:去空白和标点(后宫·甄嬛传=后宫甄嬛传、神雕侠侣：问世间=神雕侠侣:问世间)、大写数字/罗马数字、海贼王=航海王
    const norm = s => String(s || '').replace(/[壹贰叁肆伍陆柒捌玖拾]/g, c => CN_DIGIT[c]).replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, c => ROMAN[c])
        .replace(/[\s·•・.。,，、:：;；!！?？'"‘’“”「」『』《》〈〉<>\-—–_~～/\\|]/g, '').toLowerCase().replace(/航海王/g, '海贼王');
    // 🏷️ danmu_api 的 animeTitle 常带 " from 平台" 尾巴——不剥掉的话 core/norm 精确档【永远打不中】,
    //    一切都掉进包含档(对抗审查实锤:韩国版/杂牌因此与正主同档,平台排序反而让错剧排前)。
    const stripFrom = s => String(s || '').replace(/\s+from\s+[a-z0-9_]+\s*$/i, '');
    const core = s => norm(String(stripFrom(s)).split(/[(（【\[]/)[0]);
    const normT = s => norm(stripFrom(s));
    const nt = norm(title), ct = core(title);
    // 片名后紧跟的 [..] / （..） 标签(长相思[全季]、漫长的季节[卫视版]、王牌对王牌（普通话）);年份括号不算
    const tagOf = a => { const m = stripFrom(a && a.animeTitle).match(/^[^(（【\[]*[\[（(]([^\]）)]*)[\]）)]/); return (m && !/^\s*(?:19|20)\d{2}\s*$/.test(m[1]) && !/^\s*0{3}\d\s*$/.test(m[1])) ? norm(m[1]) : ''; };
    // 季号解析成数字：认"第N季/第N部/Season N/SN" + 片名尾部裸数字("庆余年2"/"斗破苍穹4",排除 19xx/20xx 年份)。
    //   尾裸数字要看括号前的片名:候选是"庆余年2(2024)【电视剧】from 360",整串的结尾是"】"(旧版因此认不出候选的季号,
    //   "庆余年第二季"反而配到了"庆余年(2019)"= 第一季,真实数据回放实锤)
    // 片名里的年份:"天龙八部2003/快乐大本营2012"是版本/季的年份;但"请回答1988"(2015 年的剧)里 1988 是名字的一部分 ——
    //   比资源站年份早 2 年以上的当名字(不剥、不当年份用)。之后所有"剧名年份"都用 yearM(已排除名字里的年份)。
    const yearRaw = String(title).match(/(?:19|20)\d{2}/);
    const hintYear = Number(hints.year) > 1900 ? Number(hints.year) : 0;
    const yearInName = !!(yearRaw && hintYear && Number(yearRaw[0]) < hintYear - 1);
    const yearM = yearInName ? null : yearRaw;
    const seasonOf = s => { s = stripFrom(s); const m = s.match(/第\s*([0-9一二两三四五六七八九十]+)\s*[季部]|season\s*0*(\d+)|\bS0*(\d{1,2})\b/i); if (m) return danmakuCn2Num(m[1] || m[2] || m[3]); const t = s.split(/[(（【\[]/)[0].match(/(?<![0-9])([2-9]|1[0-9])\s*$/); return t ? parseInt(t[1], 10) : null; };
    const wantSeason = seasonOf(title);
    // 去掉季号后的名字(与 seasonOf 同口径):"庆余年第二季"/"庆余年2" → "庆余年"
    const SEASON_RE = /第[0-9一二两三四五六七八九十]+[季部]|season0*\d+|\bs0*\d{1,2}\b/gi;
    const unSeason = c => c.replace(SEASON_RE, '').replace(/(?<![0-9])([2-9]|1[0-9])$/, '');
    const baseOf = s => unSeason(core(s));
    const ctSeasonless = unSeason(ct);
    const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    // 尾裸数字季号(庆余年2)去掉后用于包含匹配——否则弹幕源的"庆余年 第二季"(核心名不含"2")进不了候选,只剩第一季页 → 整季错配。
    const ctBase = wantSeason != null ? ct.replace(/([2-9]|1\d)$/, '') : ct;
    // 尾缀年份综艺名(王牌对王牌2024):去年份后才可能与"王牌对王牌 第九季"互相包含(否则正主进不了候选、只剩裸基名=第一季 → 整季串台,对抗审查实锤)
    const ctNoYear = yearInName ? ct : ct.replace(/((?:19|20)\d{2})\s*$/, '');
    const unMovie = c => c.replace(/剧场版|电影版/g, '');
    // 我方年份:剧名里的年份(快乐大本营2012 / 天龙八部2003)比资源站 vod_year(常是开播年)更具体
    const ourYear = (yearM ? Number(yearM[0]) : 0) || hintYear;
    // 我方自己是剪辑版(纯享/精编…)时,候选也必须是同一种剪辑
    const ourEdit = (ct.match(DANMAKU_EDIT) || [])[0] || '';
    const ourEps = Number(hints.eps) || 0;
    const epCount = a => (a && Array.isArray(a.episodes)) ? a.episodes.length : null;
    const yearOf = a => { const m = String((a && a.animeTitle) || '').match(/[(（]((?:19|20)\d{2})[)）]/); return m ? Number(m[1]) : null; };
    const junkYear = a => /[(（]0{3}\d[)）]/.test(String((a && a.animeTitle) || ''));   // "海贼王系列(0001)"这类年份为 0 的杂项条目
    const yDist = a => { const y = yearOf(a); return (ourYear && y) ? Math.abs(y - ourYear) : null; };
    const remOf = (c, stem) => {   // 两名互相包含时,多出来的那截;不包含返回 null
        if (!stem || !c || c === stem) return null;
        return c.includes(stem) ? c.replace(stem, '') : (stem.includes(c) ? stem.replace(c, '') : null);
    };
    const derived = r => !!r && DANMAKU_DERIVED.test(r) && !DANMAKU_DERIVED.test(ct);
    // 🏅 名字贴合度分档(见函数头注释)
    const fitTier = a => {
        const c = core(a.animeTitle);
        if (!c) return 9;
        const tag = tagOf(a);
        if (ourEdit && !c.includes(ourEdit) && !tag.includes(ourEdit)) return 9;   // 我方纯享版/精编版 ≠ 完整版
        if (derived(tag)) return 9;
        const tagged = !!tag && !DANMAKU_VERSION_ONLY.test(tag);
        if (c === ct || normT(a.animeTitle) === nt) return tagged ? 1 : 0;
        const s = seasonOf(a.animeTitle), bc = baseOf(a.animeTitle);
        const r1 = remOf(c, ct), r2 = ctNoYear !== ct ? remOf(c, ctNoYear) : null;
        if (derived(r1) || derived(r2)) return 9;   // 路演直播/花絮/纯享/小剧场……不是这部作品的时间轴
        // "XX之YY" 多出来的是"之…"副标题 = 续作/衍生(爸爸去哪儿第三季之听爸爸的话、唐朝诡事录之西行、鬼吹灯之精绝古城)
        if ((r1 && /^之/.test(r1)) || (r2 && /^之/.test(r2))) return 9;
        if (ctNoYear && ctNoYear !== ct && c === ctNoYear) return 1;
        //   候选名自带年份尾巴("误杀 2019(2019)"):去掉后与我方同名、且这个年份就是它自己的年份
        { const cy = c.match(/((?:19|20)\d{2})$/); if (cy && c.slice(0, -4) === ct && yearOf(a) === Number(cy[1])) return 1; }
        //   同一部的不同版本名(知否…网络版 ↔ 知否… DVD版):两边各去掉结尾一个"XX版"后同名、年份对得上 → 结构化等价(再靠集数挑对剪辑)
        { // 逐个长度试"去掉结尾 1~6 字 + 版"(正则贪婪会多剥:知否…绿肥红瘦dvd版 会被剥成"知否知否应是绿")
          const stems = x => { const out = new Set([x]); if (/版$/.test(x)) for (let k = 1; k <= 6 && k < x.length - 1; k++) out.add(x.slice(0, x.length - 1 - k)); return out; };
          const sc = stems(c), dd = yDist(a);
          if (dd != null && dd <= 1 && !/剧场|电影/.test(c + ct) && [...stems(ct)].some(x => x.length >= 3 && sc.has(x) && (x !== c || x !== ct))) return 1; }
        // 明确是别的季:我方没写季号(=第一季/第一部),候选写着第 2 季以上(长相思 第二季、斗罗大陆2绝世唐门 动态漫画 第5季)→ 不同季,不要
        if (wantSeason == null && s != null && s >= 2 && (bc === ct || c.includes(ct))) return 9;
        // ① 季号写法不同:两边季号都认得出且相同、去掉季号后同名(庆余年2 ↔ 庆余年第二季;旧版"第二季→2"方向根本配不上)
        if (wantSeason != null && s === wantSeason && bc && bc === ctSeasonless) return 1;
        //   中文数字结尾 ↔ 第N部/季:仙剑奇侠传三 ↔ 仙剑奇侠传 第三部(两个方向)
        if (s != null && s >= 2 && s <= 10 && bc && (ct === bc + CN_NUM[s] || ct === bc + s)) return 1;
        if (wantSeason != null && wantSeason >= 2 && wantSeason <= 10 && s == null && (c === ctSeasonless + CN_NUM[wantSeason])) return 1;
        //   第一季 ↔ 裸名:我方没写季号 ↔ 候选"第一季";我方"第一季" ↔ 候选裸名
        if (wantSeason == null && s === 1 && bc === ct) return 1;
        if (wantSeason === 1 && s == null && (c === ctSeasonless || c === ctSeasonless + '1')) return 1;   // 爱情公寓第一季 ↔ 爱情公寓1
        // ② 年份式 ↔ 季号式:我方剧名带年份,候选标题带同一年份,去掉季号后同名
        if (yearM && ctNoYear !== ct && String(a.animeTitle).includes(yearM[0]) && bc === unSeason(ctNoYear)) return 1;
        // ③ 只差版本标签(未删减版/国语/粤语/TV版…);"剧场版"位置不同(咒术回战0 剧场版 ↔ 剧场版 咒术回战0)
        if ((r1 && DANMAKU_VERSION_ONLY.test(r1)) || (r2 && DANMAKU_VERSION_ONLY.test(r2) && String(a.animeTitle).includes(yearM[0]))) return 1;
        if (/剧场版|电影版/.test(c + ct) && unMovie(c) === unMovie(ct)) return 1;
        // ④ 演员/版本名("胡军版"/"黄日华版"):同名翻拍的版本标记,只有年份对得上才算这一部
        const d = yDist(a);
        if (((r1 && /^.{1,6}版$/.test(r1)) || (r2 && /^.{1,6}版$/.test(r2))) && d != null && d <= 1) return 1;
        // 名字互相包含(或去季号/去年份后包含)—— 低置信。两个字的名字太容易被包含(死神 ⊂ 死神少爷与黑女仆、狂飙 ⊂ 狂飙兄弟),不认
        const contains = c.includes(ct) || ct.includes(c)
            || (ctBase !== ct && ctBase && c.includes(ctBase))
            || (ctNoYear !== ct && ctNoYear && (c.includes(ctNoYear) || ctNoYear.includes(c)));
        if (contains && Math.min(c.length, (ctNoYear || ct).length) > 2) return 2;
        return 9;
    };
    // 🎬 类型:
    //   硬冲突只有"电影 ↔ 非电影"(综艺"王牌对王牌"绝不能拿 1998 年同名电影的弹幕);
    //   其它先找同类型(剧集≠动漫:苍兰诀/三体/大奉打更人 的电视剧与动画同名同年),没有同类型才放宽到相近类型(剧集~动漫~短剧)
    let ourKind = danmakuHintKind(hints);
    // 片名自带的版本标记比资源站分类可靠:"苍兰诀（动画版）"有站标成内地剧,"凡人修仙传真人版"有站标成动漫(实测)
    if (/动画版|动漫版/.test(String(title)) && ourKind !== 'movie') ourKind = 'anime';
    else if (/真人版|电视剧版/.test(String(title)) && (ourKind === 'anime' || ourKind === 'series' || !ourKind)) ourKind = 'tv';
    if (/剧场版|电影版/.test(String(title)) && ourKind !== 'variety') ourKind = 'movie';   // 我方片名自带"剧场版"(分类常写成国产动漫)
    const isMovie = k => k === 'movie';
    // 综艺 ↔ 非综艺 也是硬冲突(新西游记 第八季 ≠ 西游记(1986)电视剧;天龙八部(2009)【综艺】≠ 天龙八部电视剧)
    const isVariety = k => k === 'variety';
    const near = k => (ourKind === 'series' || ourKind === 'tv' || ourKind === 'anime' || ourKind === 'short') && (k === 'tv' || k === 'anime');
    // 动画电影(动画片/动漫电影/剧场版):弹幕源常把它标成【动漫】(熊出没·重启未来),名字精确/结构化等价时也认
    const animatedMovie = ourKind === 'movie' && (hints.kind === 'amovie' || /动画|动漫/.test(String(hints.type || '')) || /剧场版/.test(String(title)));
    let candidates = (animes || []).filter(a => {
        if (fitTier(a) >= 9) return false;
        const k = danmakuKindOfCand(a);
        if (!ourKind || !k) return true;
        if (ourKind === 'series') return !isMovie(k);   // 只知道是多集:排除电影即可
        if (animatedMovie && k === 'anime') { const n = epCount(a); return fitTier(a) === 0 && (n == null || n <= 3); }   // 鬼灭之刃 无限列车篇【动漫】是 7 集 TV 版,不是剧场版
        return isMovie(ourKind) === isMovie(k) && isVariety(ourKind) === isVariety(k);
    });
    if (ourKind && ourKind !== 'series') {
        const exactKind = ourKind === 'short' ? 'tv' : ourKind;
        if (candidates.some(a => danmakuKindOfCand(a) === exactKind)) candidates = candidates.filter(a => { const k = danmakuKindOfCand(a); return !k || k === exactKind; });
        else if (candidates.some(a => near(danmakuKindOfCand(a)))) candidates = candidates.filter(a => { const k = danmakuKindOfCand(a); return !k || near(k); });
    }
    // 🗓️ 年份偏好(在分档之前——标题带年份时,含该年份的候选是最强信号:"王牌对王牌2024"该选"第九季(2024)"而不是裸基名第一季页)
    if (candidates.length > 1 && yearM) { const withYear = candidates.filter(a => String(a.animeTitle || '').includes(yearM[0])); if (withYear.length) candidates = withYear; }
    // 🗓️ 季号/续集号：先取精确同季(我方"第一季"时裸名也算第一季);没有精确同季时【无论单/多候选】剔除 裸基名(第一部/第一季)和季号明确不同的——
    //    它们是不同作品,宁可没弹幕不错配。(单候选旁路已修:明确异季的唯一候选此前会被原样保留,对抗审查实锤)
    if (wantSeason != null && candidates.length) {
        const exact = candidates.filter(a => { const s = seasonOf(a.animeTitle); return s === wantSeason || (wantSeason === 1 && s == null && core(a.animeTitle) === ctSeasonless) || fitTier(a) <= 1; });
        if (exact.length) candidates = exact;
        // 裸基名(去掉季号后与我方同名、自己不带季号)= 第一季,要第 2 季以上时不要
        else candidates = candidates.filter(a => { const s = seasonOf(a.animeTitle); const c = core(a.animeTitle); return (s == null || s === wantSeason) && c !== ctBase && !(wantSeason >= 2 && s == null && c === ctSeasonless); });
    }
    const platOf = s => { const m = String(s || '').match(/from\s+([a-z0-9]+)/i); return m ? m[1].toLowerCase() : ''; };
    const PLAT_RANK = { iqiyi: 0, qq: 1, tencent: 1, youku: 2, bilibili: 3, mango: 4, imgo: 4, '360': 5, migu: 9 };
    // 排序:贴合档 → 不带标签的 → 年份接近 → 平台弹幕量;回退循环只在【最佳档】内轮换——iqiyi 正主瞬时空 → 同档 qq 接棒(合法多平台回退),
    // 绝不落到包含档杂牌(对抗审查实锤:正主瞬时空时杂牌错弹幕被回退捡走并 LONG_CACHE 固化 7 天)。
    const yKey = a => { const d = yDist(a); return d == null ? 50 : d; };
    const tagKey = a => { const t = tagOf(a); return (t && !DANMAKU_VERSION_ONLY.test(t)) ? 1 : 0; };
    candidates.sort((a, b) => (fitTier(a) - fitTier(b)) || (tagKey(a) - tagKey(b)) || (yKey(a) - yKey(b))
        || ((PLAT_RANK[platOf(a.animeTitle)] ?? 6) - (PLAT_RANK[platOf(b.animeTitle)] ?? 6)));
    // 🗓️ 翻拍/重名:我方有年份时,逐档找"年份对得上"的;某档全是差太多的就看下一档。容差:精确同名 ≤3 年(弹幕源有时写出品年,
    //    神雕侠侣:问世间 差 3 年),结构化/低置信 ≤1 年。综艺(一个页面跨很多年)与类型未知(纪录片常被标成综艺、年份是上架年)只排序不剔。
    //    年份未知的候选不因年份被剔。短剧只认精确/结构化且年份 ≤1(它们常借名剧的名字)。
    const yearStrict = ourYear && ourKind && ourKind !== 'variety';
    const exactKind = ourKind === 'short' ? 'tv' : ourKind;
    const isPlainName = a => { const c = core(a.animeTitle); return !tagKey(a) && (c === ct || c === ctNoYear); };
    let rejected = '';
    const epsOk = a => { const n = epCount(a); return n != null && Math.abs(n - ourEps) <= 1; };
    const epsMatchT1 = ourEps >= 3 && candidates.some(a => fitTier(a) === 1 && epsOk(a));
    for (const tier of [0, 1, 2]) {
        if (ourKind === 'short' && tier >= 2) break;
        let pool = candidates.filter(a => fitTier(a) === tier);
        // 年份为 0 的杂项条目("海贼王系列(0001)")只在名字精确时才认(短剧常就是 0001)
        if (tier >= 1 && ourYear) pool = pool.filter(a => !junkYear(a));
        // 低置信档只认同类型(封神榜2000 电视剧 ≠ 封神榜传奇(2000)动画)
        if (tier >= 2 && ourKind && ourKind !== 'series') pool = pool.filter(a => { const k = danmakuKindOfCand(a); return !k || k === exactKind; });
        // 年份式命名的综艺(花儿与少年2026):低置信档必须同一年(别的季常只差一年)
        if (tier >= 2 && ourKind === 'variety' && yearM) pool = pool.filter(a => yDist(a) === 0);
        if (!pool.length) continue;
        if (tier === 0 && epsMatchT1 && pool.every(a => epCount(a) != null && !epsOk(a))) continue;   // 少年神探狄仁杰 40 集 ↔ DVD版 40 集,不是 36 集播出版
        if (yearStrict) {
            const lim = ourKind === 'short' ? 1 : (tier === 0 ? 3 : 1);
            const ok = pool.filter(a => { const d = yDist(a); return d == null ? (ourKind !== 'short' || tier === 0) : d <= lim; });
            if (!ok.length) { rejected = 'year-mismatch'; continue; }
            pool = ok;
        }
        // 同一部的不同剪辑(少年神探狄仁杰 DVD版 40 集 / 播出版 36 集):集数对得上(±1)的优先,对不上的分集会错位
        const byEps = ourEps >= 3 ? pool.filter(epsOk) : [];
        if (byEps.length) pool = byEps;
        else {
            const plain = pool.filter(a => !tagKey(a));
            if (plain.length) pool = plain;   // 同档里有不带[卫视版][全季]标签的正片页就只用它(标签页常是不同剪辑/合集)
            const exact = pool.filter(isPlainName);
            if (exact.length) pool = exact;   // 有和我方同名的正片页就不要"XX字幕版/XX版"变体(天天向上2019 ↔ 天天向上 越南语字幕版)
        }
        // 只知道是多集(或完全没提示)时,同档里剧集/动漫/综艺/电影混在一起 = 分不出是哪部(苍兰诀 电视剧与动画同名同年)→ 宁可不选
        //   (从历史/离线续看时没有分类提示,旧版会随手挑一个并长缓存 7 天,审查实锤)
        if ((!ourKind && !hints.type && !hints.kind) || ourKind === 'series') {
            const kinds = new Set(pool.map(danmakuKindOfCand).filter(Boolean));
            if (kinds.size > 1) return { pool: [], bestTier: 9, why: 'ambiguous-kind' };
        }
        return { pool, bestTier: tier, why: `tier${tier}${ourKind ? ' kind=' + ourKind : ''}${ourYear ? ' year=' + ourYear : ''}` };
    }
    return { pool: [], bestTier: 9, why: rejected || (candidates.length ? 'filtered' : 'no-candidate') };
}
// 前端提示里的类型:v5 新前端直接送归一后的 k:(tv/anime/movie/amovie=动画电影/variety/short/series),旧的只送资源站分类 t:
function danmakuHintKind(hints) {
    if (hints && hints.kind) return hints.kind === 'amovie' ? 'movie' : hints.kind;
    return danmakuKindOfOurs(hints && hints.type, hints && hints.eps);
}
// 弹幕请求 id 解析(两后端共用,纯函数):剧名|集名|版本[|k:类型|t:资源站分类|y:年份|n:集数]。只认这几个前缀,其它段忽略。
//   缓存键只带真正影响匹配的部分(类型 + 年份):同名的综艺与电影、不同年份的翻拍各自缓存;集数会随更新变,不进键。
function danmakuParseId(id) {
    const hints = {};
    let title = '', ep = '';
    try {
        const parts = String(id || '').split('|'); title = (parts[0] || '').trim(); ep = (parts[1] || '').trim();
        for (const p of parts.slice(2)) {
            const m = String(p).match(/^([ktyn]):(.{1,40})$/);
            if (!m) continue;
            if (m[1] === 't') hints.type = m[2].trim();
            else if (m[1] === 'k' && /^(tv|anime|movie|amovie|variety|short|series)$/.test(m[2])) hints.kind = m[2];
            else if (m[1] === 'y' && /^(19|20)\d{2}$/.test(m[2])) hints.year = Number(m[2]);
            else if (m[1] === 'n' && /^\d{1,5}$/.test(m[2])) hints.eps = Number(m[2]);
        }
    } catch (e) { }
    const k = hints.kind || danmakuKindOfOurs(hints.type, hints.eps);
    const cacheKey = title + '|' + ep + (k ? '|k:' + k : '') + (hints.year ? '|y:' + hints.year : '');
    return { title, ep, hints, cacheKey };
}
// 从【一个 danmu_api 实例】取某剧某集弹幕：搜索 → 同剧多平台(iqiyi/360/...)回退 → 返回 DPlayer 数组(空=该实例没取到)
async function fetchDanmakuFromInstance(base, token, title, ep, hints) {
    base = String(base).replace(/\/$/, '');
    const prefix = token ? `/${encodeURIComponent(token)}` : '';
    const nt = String(title || '').replace(/\s+/g, '').toLowerCase();
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
    const singleInstance = /^(1|true|yes|on)$/i.test(String(process.env.DANMU_API_SINGLE_INSTANCE || '').trim());
    if (!singleInstance && animes.some(a => (a.episodes || []).length) && !animes.some(a => (a.episodes || []).some(e => e && e.url !== undefined))) danmakuWarnNoUrl(base);
    // 🏅 候选排序见 danmakuRankCandidates(分档 + 类型 + 年份 + 季号 + 平台)
    const { pool, bestTier, why } = danmakuRankCandidates(animes, title, hints);
    if (!pool.length) { console.log(`[弹幕诊断] "${title}" @${base}: ${animes.length} 个候选里没有可用的(${why})`); return []; }
    const platOf = s => { const m = String(s || '').match(/from\s+([a-z0-9]+)/i); return m ? m[1].toLowerCase() : ''; };
    const yearM = String(title).match(/(?:19|20)\d{2}/);
    // 跨年同月日消歧(回看旧季不误取新季):剧名里的年份优先,没有就用资源站年份
    const preferYear = yearM ? yearM[0] : ((hints && Number(hints.year) > 1900) ? String(Number(hints.year)) : null);
    for (let tries = 0; tries < pool.length && tries < 3; tries++) {
        const episode = pickDanmakuEpisode(pool[tries].episodes, ep, preferYear);
        if (!episode || (!episode.episodeId && !episode.url)) continue;
        const _c0 = Date.now();
        // 🔑 优先按【视频地址】取弹幕(comment?url=,无状态)。comment/<episodeId> 的 id 是 danmu_api【单个实例内存里】的自增号
        //    (globals.episodeNum):部署在 CF Workers 等多实例上、或重启后,搜索落在实例 A、取弹幕落在实例 B,同一个号在 B 上
        //    指向 B 最近搜过的别的剧 —— 真实回放实锤:三国演义拿到鬼灭之刃、庆余年第二季拿到刑侦剧、红楼梦拿到海贼王……
        //    再被我们长缓存 7 天。按地址取没有这个问题;老版本 danmu_api 不认 ?url= 时才退回按 id,且按 id 的结果一律当低置信(只短缓存)。
        //    按地址取只交给 danmu_api 的 getCommentByUrl 能处理的地址:http(s)(番组计划 bgm.tv / 巴哈 ani.gamer 的集地址它只在按 id 时特殊处理)
        //    与 local:。合并源("tencent:…<分隔>iqiyi:…")、renren:123 这类非 http 地址只能按 id。
        const rawUrl = String(episode.url || '');
        const url = (/^local:/.test(rawUrl) || (/^https?:\/\//i.test(rawUrl) && !/bgm\.tv|bangumi\.tv|ani\.gamer\.com\.tw/i.test(rawUrl))) ? rawUrl : '';
        let d = null, via = '';
        // 记下"这个 danmu_api 不认 ?url="的时间;1 小时后再试一次(站长升级了 danmu_api 不用重启本站)
        const urlUnsupported = () => { const t = danmakuUrlMode.get(base); return !!t && Date.now() - t < 3600e3; };
        if (url && !urlUnsupported()) {
            try {
                const cr = await axios.get(`${base}${prefix}/api/v2/comment`, { params: { url, chConvert: '0', format: 'json' }, timeout: 12000 });
                if (!cr.data || !Array.isArray(cr.data.comments)) throw new Error('bad body');
                d = dandanToDplayer(cr.data.comments);
                via = 'url';
                danmakuUrlMode.delete(base);
            } catch (e) {
                const st = e.response && e.response.status;
                // 只有"这个 danmu_api 根本不认 ?url="(老版本:404,或 400 缺参数)才记下、以后对它改走按 id;
                //   429/5xx/超时/网络错 是这一次失败 —— 跳过这个候选,绝不退回按 id(按 id 正是多实例串剧的那条路,审查实锤)
                const body = e.response && e.response.data;
                if (st === 404 || (st === 400 && /missing|commentid|url/i.test(JSON.stringify(body || '')))) danmakuUrlMode.set(base, Date.now());
                if (st === 429) danmakuWarnRateLimited(base);
                console.warn(`[弹幕诊断] comment?url 失败: ${e.code || ''} ${st ? 'HTTP' + st : e.message} (${Date.now() - _c0}ms)`);
                if (!urlUnsupported()) continue;
            }
        }
        // 按 id:只在 ①这个 danmu_api 不支持按地址取,或 ②这一集没有可按地址取的地址 且 站长声明 danmu_api 是单实例(DANMU_API_SINGLE_INSTANCE=1)时才用。
        //   多实例上按 id 会串到别的剧,所以按 id 的结果一律低置信、不缓存(见端点 viaId)。
        const idAllowed = urlUnsupported() || (!url && singleInstance);
        if (d === null && episode.episodeId && idAllowed) {
            try {
                const cr = await axios.get(`${base}${prefix}/api/v2/comment/${episode.episodeId}`, { params: { withRelated: 'true', chConvert: '0' }, timeout: 12000 });
                d = dandanToDplayer((cr.data && cr.data.comments) || []);
                via = 'id';
            } catch (e) {
                if (e.response && e.response.status === 429) danmakuWarnRateLimited(base);
                console.warn(`[弹幕诊断] comment/${episode.episodeId} 失败: ${e.code || ''} ${e.response ? 'HTTP' + e.response.status : e.message} (${Date.now() - _c0}ms)`);
            }
        }
        if (d === null) continue;
        console.log(`[弹幕诊断] comment(${via}) ${via === 'url' ? url : episode.episodeId} (${platOf(pool[tries].animeTitle) || '?'}) 《${pool[tries].animeTitle}》 ${why} → ${d.length} 条 (${Date.now() - _c0}ms)`);
        // _tier 供端点分级缓存:包含档、以及按 id 取到的(可能串到别的剧)都不给长缓存、不进持久层
        if (d.length) { d._tier = via === 'url' ? bestTier : Math.max(bestTier, 2); if (via === 'id') d._viaId = true; return d; }
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

    // id = 剧名|集名|版本[|k:类型|t:资源站分类|y:年份|n:集数](解析与缓存键见 danmakuParseId,两后端共用)
    const { title, ep, hints, cacheKey } = danmakuParseId(req.query.id);
    if (!title) return res.json(empty);

    const cached = danmakuCache.get(cacheKey);
    // 低置信结果命中短缓存时也只给 10 分钟(旧版这里一律给 7 天,包含档的错弹幕会被 CDN/浏览器固化)
    if (cached && cached.expiry > Date.now()) { if (cached.data.length && !cached.viaId) res.set('Cache-Control', cached.lowConf ? 'public, max-age=600, s-maxage=600' : LONG_CACHE); return res.json({ code: 0, version: 3, data: cached.data, msg: '' }); }
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
                fetchDanmakuFromInstance(inst.base, inst.token, title, ep, hints)
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
        const viaId = !!(data && data._viaId);   // 按 id 取的(多实例上可能是别的剧):no-store、只在内存放 90 秒
        data.sort((a, b) => a[0] - b[0]); // 先按时间升序，保证下面按索引均匀采样=按时间均匀采样(后半段不丢)
        if (data.length > DANMAKU_MAX) { const step = data.length / DANMAKU_MAX, s = []; for (let i = 0; i < DANMAKU_MAX; i++) s.push(data[Math.floor(i * step)]); data = s; }
        if (danmakuCache.size >= DANMAKU_CACHE_MAX) { const k = danmakuCache.keys().next().value; if (k !== undefined) danmakuCache.delete(k); }
        danmakuCache.set(cacheKey, { data, lowConf, viaId, expiry: Date.now() + (data.length && !viaId ? (lowConf ? 10 * 60 * 1000 : DANMAKU_CACHE_TTL) : DANMAKU_MISS_TTL) });
        if (data.length && !viaId) res.set('Cache-Control', lowConf ? 'public, max-age=600, s-maxage=600' : LONG_CACHE);
        return res.json({ code: 0, version: 3, data, msg: '' });
    } catch (e) {
        console.error('[弹幕] 获取失败:', e.message);
        return res.json(empty);
    }
});
app.post('/api/danmaku/v3/', (req, res) => res.json({ code: 0, msg: '' }));

// 📊 观看/分享统计:无状态后端没有 SQLite,/api/config 报 watch_stats:false 前端根本不会来;万一来了(旧缓存页面)一律 204 静默丢弃
app.post(['/api/stats/watch', '/api/stats/share', '/api/stats/share-open'], (req, res) => res.status(204).set('Cache-Control', 'no-store').end());
// 🔔 推送 / ❤️ 收藏 / 🔥 大家都在看:都要 SQLite(订阅、收藏、观看统计)+ 常驻进程(后台更新检查)→ 无状态后端一律关闭。
//    /api/config 报 push_enabled/favorites_enabled:false,前端走本机收藏、隐藏推送开关;万一来了(旧缓存页面)返回空桩
app.get('/api/push/key', (req, res) => res.set('Cache-Control', 'no-store').json({ enabled: false, publicKey: null }));
app.post(['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test'], (req, res) => res.status(204).set('Cache-Control', 'no-store').end());
app.get('/api/favorites', (req, res) => res.set('Cache-Control', 'no-store').json({ enabled: false, limit: 100, items: [] }));
app.post('/api/favorites/status', (req, res) => res.set('Cache-Control', 'no-store').json({ enabled: false, status: {} }));
app.post(['/api/favorites/add', '/api/favorites/remove', '/api/favorites/seen'], (req, res) => res.set('Cache-Control', 'no-store').json({ ok: false, enabled: false }));
app.get('/api/popular', (req, res) => res.set('Cache-Control', 'no-store').json({ window: '7d', items: [] }));

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
        requests_enabled: false,
        hls_cut: false,  // ✂️ 无状态后端托管不了剪后的清单(见 lib/hls-cut)
        watch_stats: false,  // 📊 观看/分享统计要 SQLite(见 lib/user-stats)→ 前端不计时、分享链不带 s=
        push_enabled: false,       // 🔔 推送订阅要 SQLite(见 lib/webpush)
        favorites_enabled: false   // ❤️ 服务器收藏/更新检查要 SQLite + 常驻进程(见 lib/favorites)→ 前端只用本机收藏
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
    sites = withKzSites(sites);   // 🎌 内置规则站
    const originalTitle = req.query.original || '';

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
            const site_profile = profOf(site);   // 🏷️ 发出时附加(与 server.js 同)
            if (kazumi && kazumi.isKzSite(site)) {
                try {
                    const r = await kazumi.search(site.key, keyword, originalTitle);
                    ((r && r.list) || []).forEach(item => allResults.push({ ...item, site_key: site.key, site_name: site.name, site_profile }));
                } catch (err) { console.error(`[Search JSON] ${site.name}:`, err.message); }
                return;
            }
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
                            vod_year: item.vod_year,
                            type_name: item.type_name,   // 弹幕匹配提示(分类)要用
                            vod_play_url: item.vod_play_url,
                            site_key: site.key,
                            site_name: site.name,
                            site_profile
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
        const site_profile = profOf(site);   // 🏷️ 发出时附加(与 server.js 同)
        if (kazumi && kazumi.isKzSite(site)) {   // 🎌 规则站:核心关键词 + 0 结果才回退一次(模块内实现)
            try {
                const r = await kazumi.search(site.key, keyword, originalTitle);
                const list = ((r && r.list) || []).map(item => ({ ...item, site_key: site.key, site_name: site.name, site_profile }));
                if (list.length > 0) res.write(`data: ${JSON.stringify(list)}\n\n`);
                return list;
            } catch (err) { console.error(`[Search Error] ${site.name}:`, err.message); return []; }
        }
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
                site_name: site.name,
                site_profile
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

    sites = withKzSites(sites);
    const site = sites.find(s => s.key === siteKey);
    if (!site) {
        return res.status(404).json({ error: 'Site not found' });
    }
    if (kazumi && kazumi.isKzSite(site)) {
        try {
            const r = await kazumi.detail(site.key, id, { fresh: req.query.nocache === '1' });
            if (r && r.list && r.list.length) return res.json({ list: [r.list[0]] });
            return res.status(404).json({ error: 'Not found', list: [] });
        } catch (err) { console.error('[Detail Error]', err.message); return res.status(500).json({ error: 'Detail fetch failed', list: [] }); }
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
