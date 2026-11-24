'use strict';
// [adult] 成人分支的服务端闸门(server.js 整套用;api/index.js 只用 applyAdultEnvDefaults + vercelGuard)
//
// 为什么单独成文件:上游(v2board-integration)几乎每周都改 server.js。成人分支的逻辑尽量收在新文件里,
//   server.js 只留几处一行接线(全文搜 "[adult]"),合并上游时冲突最少。原有的搜索/详情等实现一行没删:
//   这里的路由先注册、先应答,原实现留在后面不再执行(上游改它照常合得进来)。
//
// 管什么:
//   · 服务端鉴权(原来登录墙只在前端):令牌 = Cookie dg_t(登录/验证成功的回包顺手下发,HttpOnly)
//       || x-dg-token 头 || ?token= || body.token。配了访问密码(ACCESS_PASSWORD;机场登录也只在这道墙后面出现)
//       才拦:内容接口没有有效令牌 → 401 {error:'AUTH_REQUIRED'},被封禁 → 403。没配密码 = 公开站,启动时告警一次;
//       公开站的内容接口仍要过年龄确认:Cookie dg_age=1(前端年龄门点「进入」时种下)或 x-dg-age: 1 头,没有 → 401 {error:'AGE_REQUIRED'}。
//       配了密码时有效令牌即可(登录框本身在年龄门之后才出现)。API_REQUIRE_AUTH=1:不管配没配密码,内容接口都要有效令牌(年龄 Cookie 不够)。
//   · 搜索 / 详情(内容硬过滤,fail-closed):
//       查询命中硬拦词 → 直接空结果,一个资源站都不打;
//       上游原始条目【先】过 lib/adult 内容策略(带 vod_tag/vod_class/简介等全部字段)再映射,每个出口(SSE / JSON)再查一遍;
//       番号查询只发 [带横线, 不带横线] 两种写法(绝不发裸厂牌前缀,原来的 generateSearchKeywords 会把 SSIS-001 拆出 'SSIS');
//       不再找 TMDB 翻译;文本查询的相关性闸门挡掉"无视 wd 直接回整页片库"的站;番号查询只留解析出同一番号的条目;
//       结果带 _wk(作品键)/_wt(规范显示名)/_b(分区)/_dur(秒)/_variant;搜索/详情缓存键带 RULES_VERSION(规则一变旧缓存全作废)。
//   · 历史下发 / 热门 / 收藏 的回包按片名再过一遍策略;历史上报、收藏添加也不收被拦的片名。
//   · 首页目录 /api/catalog/*(lib/site-catalog 的只读快照,每个出口再按片名过一遍策略)。
//       第二阶段:/api/catalog/tags(标签计数,审查级 featured:false)、/api/catalog/suggest(本地联想,被拦的查询不进目录)、
//       POST /api/catalog/beacon(播放结果上报 → 204;每个客户端每分钟 ≤60,超了 429;零上游;上报者 = 有效令牌 + 可信客户端网络,
//         反代后面请设 ADULT_CLIENT_IP_HEADER=cf-connecting-ip / x-real-ip,否则共享密码的站判不了"失效",见 trustedClientNet)、
//       /api/img?k=&s=(ADULT_IMG_PROXY=1 才开的封面代理,地址只从索引查;磁盘缓存在 public/ 之外:ADULT_IMG_CACHE_DIR,
//         默认 cache.db 同目录的 adult-img-cache,没配 CACHE_DB_PATH 时 node_modules/.cache/adult-img-cache;旧位置 /cache/adult-img 直接访问一律 404)。
//       站点表 strict:true → policy.checkItem 的 ctx.strict;codeTrust:false → siteTrust:false;nativeHls:false → 线路 _native:'risky'。
//   · 第二阶段新增的环境变量(README / .env.example 还没写,部署说明照这里):
//       ADULT_CLIENT_IP_HEADER  反代写进去的可信客户端 IP 头(cf-connecting-ip / x-real-ip / x-forwarded-for 取最右)。
//                               反代后面的共享密码站必须配:不配时所有人令牌相同、对端都是反代 → 永远凑不够 3 个不同上报者,线路不会被判失效,
//                               播放上报也全站共用每分钟 60 次。只在反代确实会覆盖写这个头时才配(否则客户端能伪造)
//       ADULT_IMG_PROXY=1       开封面代理 /api/img(默认关 = 海报直链 + no-referrer);/api/config 报 img_proxy:true
//       ADULT_IMG_CACHE_MB      封面磁盘缓存上限(MB,LRU,默认 1024)
//       ADULT_IMG_CACHE_DIR     封面缓存目录(默认见上;不许在 public/ 里)
//       CATALOG_EXT_HOT_SITE    「外站热门」行取哪个站的周点击(默认 av_s31;取不到/信任检查不过 → 不出这一行)
//   · 第三阶段(lib/site-catalog v2 + lib/adult-tags + lib/adult-avdb):
//       /api/catalog/browse 多了 t / x(标签 id,逗号 ≤3)/ v / dur(6 档)/ studio / actress / sort(7 种)/ cursor / facets=1;
//       /api/catalog/tags 改成 {groups, tags}(只 featured);新路由 /api/catalog/tag/:id、/api/catalog/actress(?q=)、/api/catalog/actress/:aid、/api/catalog/studios;
//       搜索 / 详情 / 作品线路过 AVDB 政策(pol=block / review_hide 不出,review_code 只在番号可信时出;cat.avdbPol 查本地表,零上游);
//       ADULT_IMG_PROXY=1 时搜索结果里已入索引的条目封面也走 /api/img(cat.indexedWks)。
//       新环境变量:CATALOG_DB_PATH(目录库,默认 cache.db 旁边的 catalog.db)/ CATALOG_BACKFILL=0(关全量历史回填)/
//         CATALOG_WORKERS=0(目录不开工作线程,全在主线程)/ CATALOG_MMAP_MB / AVDB_DISABLE=1 / AVDB_FIRST_DELAY_MS / AVDB_MAX_PAGES
//   · 第四阶段(routes-p4.js / admin-state.js / lib/adult-mirror):
//       /api/catalog/related/:wk、/api/catalog/feed、GET|POST /api/catalog/heat(见 routes-p4.js 顶部);beacon 多收 orient;
//       后台 /admin/adult + /api/adult/admin/*(X-Admin-Token = ADULT_ADMIN_TOKEN,没配就用 ADMIN_TOKEN;ADULT_ADMIN_TOKEN=off 或都没配 = 全 404;同一客户端 10 分钟 5 次错令牌锁 10 分钟);
//       后台停用的站 / 后台隐藏的作品 / 追加屏蔽词(只会更严)在这里的每个出口生效;搜索 / 详情缓存键改用 policy.rulesKey()。
//       资源站换域名跟随:deps.mirror.apiFor() 给当前地址(sitesOf / /api/sites / /api/check),每次打资源站的结果 report() 回去。
//       新环境变量:ADULT_MIRROR_DISABLE=1(关跟随);状态文件 adult-mirror.json / adult-admin.json 在 cache.db 旁边
//         ADULT_ADMIN_TOKEN   成人站后台令牌(≥16 字符随机串);没配就用 ADMIN_TOKEN;=off(0/false/no)= 不开成人后台(只留主站求片后台)
//         ADULT_CLIENT_IP_HEADER 也管两件第四阶段的事:①后台错令牌锁定按客户端算 —— 反代后面没配时所有人共用一个客户端键,
//                             任何人连发 5 次错令牌就能把站长锁在外面 10 分钟(不带令牌的请求不算错);
//                             ②热度条:配了(或公网直连)时同一网络同一部片当天只收第一台设备;没配时按设备算(只靠限流防刷)
//                             复核 SEC-3:公网直连时客户端自己加 X-Forwarded-For 之类的头不再改变它的键(以前一加就退到按单个地址算:
//                             热度扇出上限没了、IPv6 不按 /64);认不出网络时的键也按对端网络(IPv6 /64)。对端是 Cloudflare 回源地址 = 认不出(要配头)
//         CATALOG_SHORT_BACKFILL=0 关掉短视频分类的慢速补库(刷短片的片源池;默认开,每个短视频分类每天 ≤10 页)
//   · 关掉的功能:TMDB(代理/图片/分享预览/SEO 页/站点地图)恒 404;推送/求片/片头学习/弹幕 由 *_DISABLE 控制,本分支默认关。
//   · CORS 代理只用成人版自己的 Worker:ADULT_CORS_PROXY_URL(设了就覆盖 CORS_PROXY_URL);只配了 CORS_PROXY_URL 的(多半是从主站拷来的 .env,
//       指向主站 Worker)一律忽略 —— 否则成人站的资源站请求、代理记忆都会记在主站的 Worker 账号上(见 applyAdultProxyEnv)
const crypto = require('crypto');
const path = require('path');
const net = require('net');
const imgLib = require('../site-catalog/img');   // isPrivateAddr / v6Groups(上报者身份判对端是不是内网反代)
// [adult] p4:后台持久状态(站点停用 / 追加屏蔽词 / 热度盐种子)+ 新路由(相关 / 短片流 / 热度 / 后台)
const adminStateLib = require('./admin-state');
const routesP4 = require('./routes-p4');
const tgLib = require('../adult/tg');   // [adult] TG 频道(详情现问中转、线路地址签名)
let mirrorLib = null;
try { mirrorLib = require('../adult-mirror'); } catch (e) { mirrorLib = null; }   // 只用它的 classifyError;没有 = 失败一律记 'other'(不触发换源)
const ADULT_ENV_DEFAULTS = Object.freeze({
    KAZUMI_DISABLE: '1',        // 番剧规则站(HTML 刮削)
    LIVE_TV_DISABLED: '1',      // 直播
    FAV_CHECK_DISABLE: '1',     // 收藏更新后台检查(收藏本身照常)
    SHARE_TRIAL_MINUTES: '0',   // 分享链接免登录试看
    PUSH_DISABLE: '1',          // Web Push(锁屏通知会露片名)
    REQUESTS_DISABLE: '1',      // 求片
    INTRO_DISABLE: '1',         // 跳过片头的共享标记/包络
    DANMAKU_DISABLE: '1',       // 弹幕(会把片名发给第三方 danmu_api)
    SHARE_PAGE_DISABLE: '1',    // 给社交爬虫的分享卡片页(片名/海报进聊天软件预览)
});
const COOKIE_NAME = 'dg_t';
const AGE_COOKIE = 'dg_age';   // 年龄确认(前端 public/adult/adult.js 种;值 '1')
const COOKIE_MAX_AGE = 30 * 86400;
const SEARCH_TTL = 3600, DETAIL_TTL = 3600;
const DROP_BUCKETS_DEFAULT = ['x_mainstream', 'x_nonvideo', 'x_container'];
// 需要登录的接口:返回片库内容、或会替用户去打资源站的
const CONTENT_PATHS = ['/api/search', '/api/detail', '/api/check', '/api/sites', '/api/catalog', '/api/popular', '/api/kz', '/api/img'];
const KANA = /[\u3040-\u30ff]/;

// 环境变量默认值:只在【没设置】(undefined)时填。显式设成空串/0 = 运维/测试明确要开,尊重它
function applyAdultEnvDefaults(env) {
    const e = env || process.env;
    const applied = [];
    for (const k of Object.keys(ADULT_ENV_DEFAULTS)) {
        if (e[k] === undefined) { e[k] = ADULT_ENV_DEFAULTS[k]; applied.push(k); }
    }
    return applied;
}
// CORS 代理:只认 ADULT_CORS_PROXY_URL(可逗号分隔多个,空串 = 明确不用代理)。返回要打的日志(没有就 null)。必须在 server.js 读 CORS_PROXY_URL 之前调用
function applyAdultProxyEnv(env) {
    const e = env || process.env;
    if (e.ADULT_CORS_PROXY_URL !== undefined) {
        e.CORS_PROXY_URL = String(e.ADULT_CORS_PROXY_URL);
        return null;
    }
    if (String(e.CORS_PROXY_URL || '').trim()) {
        delete e.CORS_PROXY_URL;
        return '[adult] 已忽略 CORS_PROXY_URL(可能是主站的 Worker):成人站请部署自己的 Worker(cloudflare-cors-proxy.js)并设 ADULT_CORS_PROXY_URL';
    }
    return null;
}
// 不改 env 的视图:没设置的键按本分支默认值看(api/index.js 在别人的进程里被 require 时用,不能污染调用方的 process.env)
function withAdultDefaults(env) {
    const e = env || process.env;
    const v = Object.assign({}, e);
    for (const k of Object.keys(ADULT_ENV_DEFAULTS)) if (e[k] === undefined) v[k] = ADULT_ENV_DEFAULTS[k];
    return v;
}
// 0/false/no/off/空 = 没开(与 server.js 的 envFlag 同一口径)
function envOn(env, name) {
    const v = String((env || process.env)[name] == null ? '' : (env || process.env)[name]).trim().toLowerCase();
    return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}
function offFlags(env) {
    return { push: envOn(env, 'PUSH_DISABLE'), requests: envOn(env, 'REQUESTS_DISABLE'), intro: envOn(env, 'INTRO_DISABLE'), danmaku: envOn(env, 'DANMAKU_DISABLE'), sharePage: envOn(env, 'SHARE_PAGE_DISABLE') };
}

// ---------- Cookie / 令牌 ----------
function parseCookies(header) {
    const out = Object.create(null);
    const s = String(header == null ? '' : header);
    if (!s) return out;
    for (const part of s.split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const k = part.slice(0, i).trim();
        if (!k || k in out) continue;   // 同名取第一个(浏览器把路径更具体的排前面)
        let v = part.slice(i + 1).trim();
        if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
        try { v = decodeURIComponent(v); } catch (e) { /* 保留原样 */ }
        out[k] = v;
    }
    return out;
}
const okTok = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 256) ? v : '';
function readToken(req) {
    if (!req) return '';
    const h = req.headers || {};
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    return okTok(parseCookies(h.cookie)[COOKIE_NAME]) || okTok(h['x-dg-token']) || okTok(req.query && req.query.token) || okTok(b.token) || '';
}
// 年龄确认:Cookie dg_age=1 或 x-dg-age: 1(前端 fetch 包装带头,EventSource 靠 Cookie)
function ageConfirmed(req) {
    if (!req) return false;
    const h = req.headers || {};
    return parseCookies(h.cookie)[AGE_COOKIE] === '1' || String(h['x-dg-age'] || '').trim() === '1';
}
function isHttps(req) {
    if (!req) return false;
    try { if (req.secure) return true; } catch (e) { }
    const h = req.headers || {};
    const xf = String(Array.isArray(h['x-forwarded-proto']) ? h['x-forwarded-proto'][0] : (h['x-forwarded-proto'] || '')).split(',')[0].trim().toLowerCase();
    if (xf === 'https') return true;
    return /"scheme"\s*:\s*"https"/i.test(String(h['cf-visitor'] || ''));
}
function tokenCookie(token, req) {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax` + (isHttps(req) ? '; Secure' : '');
}
function clearTokenCookie(req) {
    return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` + (isHttps(req) ? '; Secure' : '');
}

// ---------- 上报者身份(POST /api/catalog/beacon) ----------
// 可信的客户端网络(判"不同上报者"、按客户端限流用;IPv6 归并到 /64):
//   ADULT_CLIENT_IP_HEADER 配了(cf-connecting-ip / x-real-ip / x-forwarded-for …:运维声明自己的反代会覆盖写这个头)→ 只认它
//     (x-forwarded-for 取最右一个 = 最近一跳反代写进去的;多层反代请改用 cf-connecting-ip / x-real-ip);
//   没配 → 对端本身就是客户端网络:对端是公网地址、且不是 CDN 回源地址(CDN_RANGES)→ 对端的网络(IPv6 /64)。
//     复核 SEC-3:请求里带不带转发头(X-Forwarded-For / X-Real-IP …)都不影响 —— 那些头客户端自己就能写,以前"带了就认不出"
//     等于让任何直连的客户端自己关掉热度扇出上限、躲开 IPv6 /64 归并(后台锁定按单个 v6 地址算,换地址无限猜)。
//   其余(对端是本机 / 内网 = 前面是自己的反代;对端是 Cloudflare 回源地址 = 没配头的 CDN)→ ''(认不出:转发头一律不当身份)。
//   公网上自建的反代(不是 CDN)没配头时会被当成一个客户端网络(所有人共用:只会更严 —— 热度凑不够人、后台锁定共用),配上头就好
// Cloudflare 回源地址段(https://www.cloudflare.com/ips/):对端在这里 = 前面是 CDN 边缘节点,不是客户端
const CDN_RANGES = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
const v4Int = (ip) => ip.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const CDN_CIDRS = CDN_RANGES.map((c) => {
    const i = c.indexOf('/'), ip = c.slice(0, i), bits = Number(c.slice(i + 1));
    if (net.isIPv4(ip)) return { v: 4, mask: bits ? (0xffffffff << (32 - bits)) >>> 0 : 0, n: v4Int(ip) };
    const g = imgLib.v6Groups(ip);
    return g ? { v: 6, g, bits } : null;
}).filter(Boolean);
function isCdnAddr(ip) {
    if (net.isIPv4(ip)) {
        const n = v4Int(ip);
        return CDN_CIDRS.some((c) => c.v === 4 && ((n & c.mask) >>> 0) === ((c.n & c.mask) >>> 0));
    }
    const g = net.isIPv6(ip) ? imgLib.v6Groups(ip) : null;
    if (!g) return false;
    return CDN_CIDRS.some((c) => {
        if (c.v !== 6) return false;
        for (let k = 0, left = c.bits; left > 0; k++, left -= 16) {
            const m = left >= 16 ? 0xffff : (0xffff << (16 - left)) & 0xffff;
            if ((g[k] & m) !== (c.g[k] & m)) return false;
        }
        return true;
    });
}
function normIp(v) {
    let s = String(v == null ? '' : v).trim();
    if (s[0] === '[' && s.indexOf(']') > 0) s = s.slice(1, s.indexOf(']'));   // [v6]:port
    else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(s)) s = s.replace(/:\d+$/, '');   // v4:port
    s = s.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1');
    return net.isIP(s) ? s.toLowerCase() : '';
}
function netKeyOf(ip) {
    if (!ip || net.isIPv4(ip)) return ip || '';
    const g = imgLib.v6Groups(ip);
    return g ? g.slice(0, 4).map((n) => n.toString(16)).join(':') + '::/64' : '';
}
function ipHeaderOf(env) {
    const h = String((env || process.env).ADULT_CLIENT_IP_HEADER || '').trim().toLowerCase();
    return /^[a-z0-9-]{1,40}$/.test(h) ? h : '';
}
function trustedClientNet(req, hdr) {
    const h = (req && req.headers) || {};
    if (hdr) {
        let v = h[hdr];
        if (Array.isArray(v)) v = v[v.length - 1];
        if (typeof v !== 'string' || !v.trim()) return '';
        const parts = v.split(',').map((x) => x.trim()).filter(Boolean);
        return netKeyOf(normIp(hdr === 'x-forwarded-for' ? parts[parts.length - 1] : parts[0]));
    }
    const sock = req && (req.socket || req.connection);
    const peer = normIp(sock && sock.remoteAddress);
    if (!peer || imgLib.isPrivateAddr(peer) || isCdnAddr(peer)) return '';
    return netKeyOf(peer);   // 复核 SEC-3:客户端写的转发头不再把公网对端挪出可信网络键
}
// 客户端键(限流 / 后台错令牌锁定 / 热度扇出用):可信网络 → 'n:' + 网络;认不出 → 'p:' + 对端的网络(IPv6 一律按 /64 归并,
//   复核 SEC-3:以前这里用对端的完整地址,一个 /64 里换地址就是新键)。没配 ADULT_CLIENT_IP_HEADER 时只看对端,转发头带不带键都一样
function clientKeyOf(req, hdr) {
    const t = trustedClientNet(req, hdr);
    if (t) return 'n:' + t;
    const sock = req && (req.socket || req.connection);
    return 'p:' + (netKeyOf(normIp(sock && sock.remoteAddress)) || '-');
}

// ---------- 时长 ----------
// 资源站 vod_duration 的几种写法(抽样 8k 条):'01:59:30' / '58:38'(分:秒) / '120分钟' / '136'(纯数字 = 分钟)。认不出 = 0
function parseDur(v) {
    if (v == null) return 0;
    const s = String(v).trim();
    let m, sec = 0;
    if ((m = /^(\d{1,3}):([0-5]?\d):([0-5]\d)$/.exec(s))) sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    else if ((m = /^(\d{1,4}):([0-5]\d)$/.exec(s))) sec = (+m[1]) * 60 + (+m[2]);
    else if ((m = /(\d+(?:\.\d+)?)\s*(?:分钟|分鐘|min)/i.exec(s))) sec = Math.round(parseFloat(m[1]) * 60);
    else if ((m = /^(\d{1,6})$/.exec(s))) { const n = +m[1]; sec = n <= 600 ? n * 60 : n; }
    return sec > 0 && sec <= 12 * 3600 ? sec : 0;
}

// ---------- 作品身份 / 分区 ----------
const UNC_KINDS = /^(fc2|heyzo|uncen-date|tokyohot|h4610)$/;
// mixed/uncat 分类下的条目:番号可信(code_ok)或片名带假名才进日本区,否则一律国产自拍(与目录入库同一条规则)
function routeBucket(bucket, parsed, codeOk, name) {
    if (bucket !== 'mixed' && bucket !== 'uncat') return bucket;
    const p = parsed || {};
    const f = p.flags || {};
    if (codeOk && p.kind === 'cn') return 'cn_studio';
    const jp = (codeOk && /^(jav|jav-cid)$/.test(p.kind || '')) || (codeOk && UNC_KINDS.test(p.kind || '')) || KANA.test(String(name || ''));
    if (!jp) return 'cn_amateur';
    if (f.uncensored || UNC_KINDS.test(p.kind || '')) return 'jp_uncensored';
    if (f.chineseSub) return 'jp_subbed';
    return 'jp_censored';
}
function variantOf(parsed) {
    const f = (parsed && parsed.flags) || {};
    return f.leak ? '无码流出' : f.chineseSub ? '中字' : f.uncensored ? '无码' : f.clip ? '片段' : '';
}

function createAdultGate(deps) {
    deps = deps || {};
    const adult = deps.adult;
    // fail-closed:没有内容策略就不许起
    if (!adult || !adult.policy || !adult.title || !adult.taxonomy || typeof adult.RULES_VERSION !== 'string') throw new Error('[adult-gate] 缺少 lib/adult,拒绝启动');
    const { policy, title, taxonomy } = adult;
    const RV = adult.RULES_VERSION;
    const env = deps.env || process.env;
    const off = Object.assign({ push: false, requests: false, intro: false, danmaku: false, sharePage: false }, deps.off || offFlags(env));
    const logFn = typeof deps.log === 'function' ? deps.log : (m) => console.log(m);
    const warnAt = Object.create(null);
    const warnOnce = (tag, e) => { const t = Date.now(); if (!warnAt[tag] || t - warnAt[tag] > 60e3) { warnAt[tag] = t; console.warn('[adult] ' + tag + ':', (e && e.message) || e); } };
    const dropBuckets = new Set(Array.isArray(taxonomy.DROP_BUCKETS) ? taxonomy.DROP_BUCKETS : DROP_BUCKETS_DEFAULT);

    // [adult] p4:站长在后台停用的站(deps.adminState;没给 = 只在内存里)、资源站换域名跟随(deps.mirror:对象或返回它的函数)
    const adminState = deps.adminState && typeof deps.adminState.siteOff === 'function' ? deps.adminState : adminStateLib.createAdminState({});
    const getMirror = () => { try { const m = typeof deps.mirror === 'function' ? deps.mirror() : deps.mirror; return m && typeof m.apiFor === 'function' ? m : null; } catch (e) { return null; } };
    // 站点表(在用的):去掉后台停用的;有镜像在用的站把 api 换成当前地址(_api0 留着主地址:档案徽章按主地址查)
    const sitesOf = () => {
        let list;
        try { list = (deps.allSites && deps.allSites()) || []; } catch (e) { warnOnce('allSites', e); return []; }
        const mir = getMirror();
        const out = [];
        for (const s of list) {
            if (!s || typeof s !== 'object') continue;
            if (typeof s.key === 'string' && adminState.siteOff(s.key)) continue;
            if (mir && typeof s.api === 'string' && s.api && !isKz(s)) {
                let a = null;
                try { a = mir.apiFor(s.key); } catch (e) { a = null; }
                if (typeof a === 'string' && a && a !== s.api) { out.push(Object.assign({}, s, { api: a, _api0: s.api })); continue; }
            }
            out.push(s);
        }
        return out;
    };
    const getCatalog = () => { try { return deps.catalog ? (deps.catalog() || null) : null; } catch (e) { return null; } };
    const kz = () => { try { return deps.kazumi ? deps.kazumi() : null; } catch (e) { return null; } };
    const isKz = (site) => { const k = kz(); try { return !!(k && site && k.isKzSite(site)); } catch (e) { return false; } };
    const profOf = (s) => { try { return deps.profOf ? deps.profOf(s && s._api0 ? Object.assign({}, s, { api: s._api0 }) : s) : undefined; } catch (e) { return undefined; } };
    const ownToken = (t) => { try { return !!(t && deps.ownToken && deps.ownToken(t)); } catch (e) { return false; } };
    const banned = (t) => { try { return !!(deps.isBanned && deps.isBanned(t)); } catch (e) { return false; } };
    // 判不出来 = 当作配了(宁可多拦)
    const authConfigured = () => { try { return !!deps.authConfigured(); } catch (e) { return true; } };
    // API_REQUIRE_AUTH=1(规格 §1):内容接口一律要有效令牌,不管配没配访问密码;没配密码 = 谁都拿不到令牌 = 全部 401(fail-closed,启动时告警)
    const apiRequireAuth = envOn(env, 'API_REQUIRE_AUTH');
    const authRequired = () => apiRequireAuth || authConfigured();
    const ipHeader = ipHeaderOf(env);   // ADULT_CLIENT_IP_HEADER:反代写的可信客户端 IP 头(上报者身份用;没配 = 只信直连)
    const cacheGet = (c, k) => { try { return deps.cache ? deps.cache.get(c, k) : null; } catch (e) { return null; } };
    const cacheSet = (c, k, v, t) => { try { if (deps.cache) deps.cache.set(c, k, v, t); } catch (e) { } };
    const ipOf = (req) => { try { return deps.ipKey ? deps.ipKey(req) : (req.ip || ''); } catch (e) { return ''; } };
    // [adult] p4:每次打资源站的结果报给镜像模块(连续失败 → 换域名;成功的"最新一页"样本 → 指纹快照)
    const classifyErr = (e) => { try { return mirrorLib ? mirrorLib.classifyError(e) : 'other'; } catch (_) { return 'other'; } };
    function mirrorReport(site, ok, kind, url, data) {
        const mir = getMirror();
        if (!mir || typeof mir.report !== 'function' || !site || typeof site.key !== 'string') return;
        try { mir.report(site.key, ok, kind, { url, data: ok ? data : undefined }); } catch (e) { warnOnce('mirror.report', e); }
    }
    async function fetchJson(site, url, timeout) {
        let data;
        try { data = await deps.fetchJson(site, url, timeout); }
        catch (e) { mirrorReport(site, false, classifyErr(e), url); throw e; }
        if (typeof data === 'string') { try { data = JSON.parse(data.replace(/^\uFEFF/, '')); } catch (e) { data = null; } }
        const okBody = !!data && typeof data === 'object' && !Array.isArray(data) && (Array.isArray(data.list) || Array.isArray(data.class) || data.code != null);
        mirrorReport(site, okBody, okBody ? 'ok' : 'body', url, data);
        return data && typeof data === 'object' ? data : null;
    }
    // 生效的规则键:RULES_VERSION + 站长追加屏蔽词的哈希(policy.rulesKey;没有追加词 = RULES_VERSION)。搜索 / 详情缓存键用它
    const RK = () => { try { return typeof policy.rulesKey === 'function' ? String(policy.rulesKey()) : RV; } catch (e) { return RV + '+x?'; } };

    // ---------- 分类图(父子关系) ----------
    // 子分类名字无害、父分类是偷拍之类的站不少(如"精品视频"挂在"自拍偷拍"下)。目录(lib/site-catalog)有每站的 ac=list 分类图;
    //   目录不在(非 sqlite)、还没爬到、或不认识这个 type_id 时,闸门自己按站拉一次 ac=list(每站每天一次,失败 10 分钟后再试),
    //   用 taxonomy.buildClassMap 建图(拦截沿整条祖先链)。两边都有时取更严的。
    const CLASS_TTL = 24 * 3600e3, CLASS_FAIL_TTL = 10 * 60e3;
    const classMaps = new Map();   // site.key → { at, map: Map|null, api, inflight }
    function ensureClassMap(site) {
        if (!site || !site.api || isKz(site)) return Promise.resolve(null);
        const e = classMaps.get(site.key);
        if (e && e.inflight) return e.inflight;
        if (e && e.api === site.api && e.at && Date.now() - e.at < (e.map ? CLASS_TTL : CLASS_FAIL_TTL)) return Promise.resolve(e.map);
        const p = (async () => {
            let map = null;
            try {
                const data = await fetchJson(site, `${site.api}?ac=list`, 8000);
                const cls = data && Array.isArray(data.class) ? data.class : null;
                if (cls && cls.length) map = taxonomy.buildClassMap(cls, { host: site.api });
            } catch (err) { warnOnce('ac=list:' + site.key, err); }
            classMaps.set(site.key, { at: Date.now(), map, api: site.api, inflight: null });
            return map;
        })();
        classMaps.set(site.key, Object.assign({}, e || {}, { inflight: p }));
        return p;
    }
    function localClass(site, typeId) {
        const e = classMaps.get(site.key);
        if (!e || !e.map || e.api !== site.api) return null;
        return e.map.get(Number(typeId)) || null;
    }
    const REVIEW_RANK = { hide: 3, code: 2, filter: 1 };
    function classInfoOf(site, item) {
        if (!site || item.type_id == null || item.type_id === '') return null;
        let a = null;
        const cat = getCatalog();
        if (cat && typeof cat.classInfo === 'function') {
            try { a = cat.classInfo(site.key, item.type_id) || null; } catch (e) { warnOnce('classInfo', e); a = null; }
        }
        const b = localClass(site, item.type_id);
        if (!a || !b) return a || b;
        const review = (REVIEW_RANK[b.review] || 0) > (REVIEW_RANK[a.review] || 0) ? b.review : a.review;
        return { name: a.name || b.name, parentName: a.parentName || b.parentName || '', block: !!(a.block || b.block), review: review || null };
    }

    // ---------- 内容策略 ----------
    // 一条资源站原始条目(或映射后的条目)能不能出:分类图(目录的 ac=list 父子关系)→ lib/adult.checkItem → 分类审查级 → 非成人分区丢弃。
    // 任何异常 = 不放行
    function checkRaw(site, item) {
        try {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: 'invalid' };
            const siteTrust = !(site && site.codeTrust === false);
            const info = classInfoOf(site, item);
            if (info && info.block) return { ok: false, reason: 'category:map' };
            const parsed = title.parseTitle(item.vod_name == null ? '' : String(item.vod_name), item.type_name == null ? '' : String(item.type_name));
            // [adult] 第三阶段:AVDB 政策(番号 + 它在各站的每条线路):block / review_hide 一律不出,review_code 只在番号可信时出
            const pol = avdbPolOf(parsed);
            if (pol === 'block' || pol === 'review_hide') return { ok: false, reason: 'avdb:' + pol, parsed, siteTrust };
            const codeOk = title.codeOk(parsed, { siteTrust });
            // 站点表 strict:true → ctx.strict(语义由 lib/adult/policy.js 定);codeTrust:false → 番号一律不可信
            const r = policy.checkItem(item, { parentName: (info && info.parentName) || '', codeOk, siteTrust, strict: !!(site && site.strict === true), strictFloor: !(site && site.strictFloor === false) });
            // p5:政策实际采用的番号可信度只会更严(严格站);审查兜底、分区路由、作品键都用它(codeVeto → identity 不给 c: 键)
            const eff = codeOk && r.codeOk !== false;
            const out = Object.assign({ parsed, siteTrust }, r, { codeOk: eff, codeVeto: codeOk && !eff });
            if (!r.ok) return out;
            if (info && (info.review === 'hide' || (info.review === 'code' && !eff))) return Object.assign(out, { ok: false, reason: 'review:class' });
            if (pol === 'review_code' && !eff) return Object.assign(out, { ok: false, reason: 'avdb:review_code' });
            if (dropBuckets.has(r.bucket)) return Object.assign(out, { ok: false, reason: 'bucket:' + r.bucket });
            return out;
        } catch (e) {
            warnOnce('checkRaw', e);
            return { ok: false, reason: 'error' };
        }
    }
    // [adult] p4:后台隐藏的作品(目录 adminHidden();每 5 分钟 / 隐藏操作后刷新)—— 现搜结果 / 详情 / 相关 / 短片流 / 热度 都不出。
    //   精确键或去掉 #… / ~N 后缀的主键在表里都算(隐藏主作品 = 它的 #U / #clip / ~N 兄弟一起不出)
    const hidden = { set: new Set(), at: 0, inflight: null };
    function refreshHidden(force) {
        const cat = getCatalog();
        if (!cat || typeof cat.adminHidden !== 'function') return Promise.resolve();
        if (hidden.inflight) return hidden.inflight;
        if (!force && Date.now() - hidden.at < 5 * 60e3) return Promise.resolve();
        hidden.inflight = Promise.resolve().then(() => cat.adminHidden()).then((list) => {
            const s = new Set();
            for (const x of Array.isArray(list) ? list : []) if (x && typeof x.wk === 'string') s.add(x.wk);
            hidden.set = s; hidden.at = Date.now();
        }).catch((e) => { warnOnce('adminHidden', e); hidden.at = Date.now() - 4 * 60e3; }).finally(() => { hidden.inflight = null; });
        return hidden.inflight;
    }
    function isHidden(wk) {
        if (Date.now() - hidden.at >= 5 * 60e3 && !hidden.inflight) refreshHidden(false);   // 过期了后台刷(不等)
        if (typeof wk !== 'string' || !wk) return false;
        // [integ] 目录主线程自己的隐藏表(cat.isHidden:同步、Set 查找)也算 —— 不等这里 5 分钟一刷
        try { const cat = getCatalog(); if (cat && typeof cat.isHidden === 'function' && (cat.isHidden(wk) || cat.isHidden(wk.replace(/[#~].*$/, '')))) return true; } catch (e) { }
        if (!hidden.set.size) return false;
        return hidden.set.has(wk) || hidden.set.has(wk.replace(/[#~].*$/, ''));
    }
    const emitOk = (site, m) => checkRaw(site, m).ok && !isHidden(m && m._wk);
    // [adult] 第三阶段:目录里的 AVDB 只读实例(本地表,零上游)。没有目录 = 没配 AVDB(和没收录一样);
    //   配了但主线程实例建不起来,cat.avdbPol 自己回 'block'(fail-closed);这里抛异常也当被拦
    function avdbPolOf(parsed) {
        const key = parsed && parsed.key;
        if (!key) return null;
        const cat = getCatalog();
        if (!cat || typeof cat.avdbPol !== 'function') return null;
        try { const v = cat.avdbPol(key); return typeof v === 'string' ? v : null; } catch (e) { warnOnce('avdbPol', e); return 'block'; }
    }
    // 只有片名(大家都在看):片名里的番号过 AVDB 政策(block / review_hide 不出;review_code 只在番号可信时出)。异常 = 不放行
    function titleAvdbOk(name) {
        if (name == null || String(name).trim() === '') return true;
        try {
            const parsed = title.parseTitle(String(name).slice(0, 400), '');
            const pol = avdbPolOf(parsed);
            if (pol === 'block' || pol === 'review_hide') return false;
            return pol !== 'review_code' || !!title.codeOk(parsed, { siteTrust: true });
        } catch (e) { warnOnce('titleAvdbOk', e); return false; }
    }
    function queryBlocked(q) { try { return !!policy.checkQuery(q); } catch (e) { warnOnce('checkQuery', e); return true; } }
    // 只有片名(历史/收藏/热门/目录卡片):硬拦词 + 条目级审查。
    //   bucket:目录卡片/作品自带的分区(入库时按分类图定的)。给了就按它判(三级片/日本片里的"前男友"是剧情,不该在出口被当成报复性内容丢掉)
    const NAV_IDS = new Set((Array.isArray(taxonomy.BUCKETS) ? taxonomy.BUCKETS : []).filter(b => b && b.nav).map(b => b.id));
    function nameOk(name, typeName, bucket) {
        if (name == null || String(name).trim() === '') return true;   // 没有片名 = 没有可露的东西
        try {
            const n = String(name).slice(0, 400);
            if (policy.checkQuery(n)) return false;
            const ctx = (typeof bucket === 'string' && NAV_IDS.has(bucket)) ? { cls: { bucket, tags: [], review: null, block: false } } : {};
            return policy.checkItem({ vod_name: n, type_name: typeName == null ? '' : String(typeName) }, ctx).ok;
        } catch (e) { warnOnce('nameOk', e); return false; }
    }
    // chk:片名检查(默认 nameOk)。读出口(历史拉取 / 收藏列表 / 加收藏)用 storedReadOk:再加 AVDB 政策 ——
    //   用户存下之后 AVDB 才拦掉的番号,不能还留在历史 / 收藏里露出来(历史上传不加 AVDB:那只是"存不存",露不露由读出口管;
    //   AVDB 只读实例启动前那几秒按 fail-closed 一律当拦,上传时套它会把用户的番号历史悄悄丢掉)
    function storedItemOk(d, depth, chk) {
        const dep = depth | 0;
        const ck = typeof chk === 'function' ? chk : nameOk;
        if (d == null || d === '') return true;
        if (dep > 3) return false;   // 套娃太深:不放行(fail-closed),也防递归爆栈
        // 字符串(客户端把整条 JSON 塞成字符串):能解析成对象/数组/字符串就按那个查,否则当片名查 —— 不能因为"不是对象"就跳过片名过滤
        if (typeof d === 'string') {
            let j;
            try { j = JSON.parse(d); } catch (_) { j = undefined; }
            if (j !== null && (typeof j === 'object' || (typeof j === 'string' && j !== d))) return storedItemOk(j, dep + 1, ck);
            return ck(d.slice(0, 400));
        }
        if (Array.isArray(d)) return d.slice(0, 60).every((x) => storedItemOk(x, dep + 1, ck));
        if (typeof d !== 'object') return true;   // 数字/布尔:没有可露的文字
        const g = d.groupData && typeof d.groupData === 'object' ? d.groupData : null;
        const srcs = g && Array.isArray(g.sources) ? g.sources : (Array.isArray(d.sources) ? d.sources : []);
        const firstType = (srcs.find(s => s && s.type_name) || {}).type_name || d.type_name || '';
        if (!ck(d.name, firstType)) return false;
        if (g && g.name && g.name !== d.name && !ck(g.name, firstType)) return false;
        for (const s of srcs.slice(0, 60)) if (s && typeof s === 'object' && s.vod_name && !ck(s.vod_name, s.type_name)) return false;
        return true;
    }
    const nameAvdbOk = (n, t) => nameOk(n, t) && titleAvdbOk(n);
    const storedReadOk = (d) => storedItemOk(d, 0, nameAvdbOk);

    // ---------- 作品身份 ----------
    function identity(item, chk) {
        const p = chk.parsed || {};
        let wk = title.workKey(p, chk.codeVeto ? { codeOk: false } : { siteTrust: chk.siteTrust });   // 政策不信这个番号(严格站)→ 按片名分组
        const isCode = wk.indexOf('c:') === 0;
        if (isCode && p.flags && p.flags.clip) wk += '#clip';   // 解说/片段 不和正片并组
        let wt;
        if (isCode) {
            wt = (String(p.code || '') + ' ' + String(p.cleanTitle || '')).trim();
            if (wk.indexOf('#U') > 0) wt += ' · 无码流出';
            if (wk.indexOf('#clip') > 0) wt += ' · 片段';
        } else wt = String(p.cleanTitle || item.vod_name || '').trim();
        return { _wk: wk, _wt: wt.slice(0, 200), _b: routeBucket(chk.bucket, p, chk.codeOk, item.vod_name), _dur: parseDur(item.vod_duration), _variant: variantOf(p) };
    }
    function mapItem(it, chk) {
        return Object.assign({
            vod_id: it.vod_id, vod_name: it.vod_name, vod_pic: it.vod_pic, vod_remarks: it.vod_remarks, vod_year: it.vod_year,
            type_id: it.type_id, type_name: it.type_name, vod_content: it.vod_content, vod_play_from: it.vod_play_from, vod_play_url: it.vod_play_url,
        }, identity(it, chk));
    }

    // ---------- 搜索计划 / 相关性 ----------
    const compact = (s) => title.t2s(String(s == null ? '' : s).slice(0, 400).normalize('NFKC')).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    function makePlan(q) {
        const sv = title.searchVariants(q);
        if (!sv || !Array.isArray(sv.variants) || !sv.variants.length) return null;
        // 多个关键词(用户 2026-11-24「黑丝 女同」):资源站的搜索只认整串(片名里要连着有这串字),整串发出去几乎搜不到 →
        //   只把最长的那个词发给资源站,回来的结果按【全部】词过滤(片名 / 副名 / 演员 / 分类 / 标签里都算,见 relevant)
        const toks = sv.kind === 'code' ? [] : String(q).normalize('NFKC').trim().split(/\s+/).filter(Boolean).slice(0, 5);
        if (toks.length >= 2) {
            const seed = toks.slice().sort((a, b) => [...b].length - [...a].length)[0];
            const v = [seed];
            const s2 = title.t2s(seed);
            if (s2 && s2 !== seed) v.push(s2);
            return { kind: 'text', variants: v, raw: String(q), gateQ: toks.join(' ') };
        }
        return sv.kind === 'code' ? { kind: 'code', key: sv.key, variants: sv.variants.slice(0, 2), raw: String(q) } : { kind: 'text', variants: sv.variants.slice(0, 2), raw: String(q) };
    }
    // 闸门只由发出去的这一个写法决定(同一写法不管来自哪个查询,结论都一样 → 能和结果一起缓存)
    function gateFor(kw) {
        const sv = title.searchVariants(kw);
        if (sv && sv.kind === 'code') return { kind: 'code', key: sv.key };
        const toks = String(kw).split(/\s+/).filter(Boolean);
        // wide:多个词时分类名 / 标签也算(「黑丝 女同」里的 女同 常常只在分类里)
        return { kind: 'text', toks: toks.map(t => title.titleKey(t)).filter(Boolean), ctoks: toks.map(compact).filter(Boolean), wide: toks.length > 1 };
    }
    function relevant(g, it, parsed) {
        if (!g) return true;
        // 番号查询:键相等之外还要不是"可疑番号"(假番号站给国产/动漫/欧美片硬塞 [CODE] 前缀,键能撞上但不是这部片)
        if (g.kind === 'code') return !!(parsed && parsed.key && parsed.key === g.key && (!parsed.suspect || parsed.placeholder));   // 占位番号(JUL-123)照常返回,身份按片名分组
        const fields = (g.wide ? [it.vod_name, it.vod_sub, it.vod_actor, it.type_name, it.vod_class, it.vod_tag] : [it.vod_name, it.vod_sub, it.vod_actor]).filter(f => f != null && f !== '');
        if (g.toks.length) {
            const hay = fields.map(f => title.titleKey(String(f))).join('|');
            return g.toks.every(t => hay.includes(t));
        }
        if (g.ctoks.length) {
            const hay = fields.map(compact).join('|');
            return g.ctoks.every(t => hay.includes(t));
        }
        return true;   // 查询归一化后什么都不剩:不拦
    }
    // 同一个站、同一个番号作品只留一条(优先中字);无番号的作品不合(可能是同名不同片)
    function onePerWork(list) {
        const at = new Map(), out = [];
        for (const m of list) {
            if (!m || typeof m._wk !== 'string' || m._wk.indexOf('c:') !== 0) { out.push(m); continue; }
            const i = at.get(m._wk);
            if (i == null) { at.set(m._wk, out.length); out.push(m); }
            else if (m._variant === '中字' && out[i]._variant !== '中字') out[i] = m;
        }
        return out;
    }
    function fanout(sites, plan) {
        return sites.filter(s => s && s.search !== false && !(plan.kind === 'code' && s.codeTrust === false) && (isKz(s) ? plan.kind !== 'code' : !!s.api));
    }
    function ingest(site, items) {
        const cat = getCatalog();
        if (!cat || typeof cat.ingestSearchItems !== 'function' || !items.length) return;
        setImmediate(() => {
            try {
                const r = cat.ingestSearchItems(site.key, items);
                if (r && typeof r.catch === 'function') r.catch(e => warnOnce('ingestSearchItems', e));
            } catch (e) { warnOnce('ingestSearchItems', e); }
        });
    }
    async function siteSearch(site, plan) {
        if (isKz(site)) {   // 🎌 规则站(本分支默认关):模块自带关键词策略,这里只过内容策略
            let list = [];
            try { list = ((await kz().search(site.key, plan.raw, '')) || {}).list || []; } catch (e) { warnOnce('kz:' + site.key, e); }
            const out = [];
            for (const it of list) { const chk = checkRaw(site, it); if (chk.ok) out.push(Object.assign({}, it, identity(it, chk))); }
            return out;
        }
        const out = [], seen = new Set();
        const classP = ensureClassMap(site);   // 与第一个搜索请求并行;每站每天一次,永不 reject
        for (const kw of plan.variants) {
            const ck = `adult:${RK()}:${site.key}_${kw}` + (plan.gateQ ? '|' + plan.gateQ : '');
            const cached = cacheGet('search', ck);
            let list = cached && Array.isArray(cached.list) ? cached.list : null;
            if (!list) {
                let data;
                try { data = await fetchJson(site, `${site.api}?ac=detail&wd=${encodeURIComponent(kw)}`, 8000); }
                catch (e) { warnOnce('search:' + site.key, e); continue; }
                await classP;   // 分类图到了再过滤(拉不到也照走:只是少了父分类这一层)
                const raw = data && Array.isArray(data.list) ? data.list : [];
                const g = gateFor(plan.gateQ || kw);   // 多个词:按全部词过滤(发出去的只是其中一个)
                const keptRaw = [];
                list = [];
                for (const it of raw) {
                    const chk = checkRaw(site, it);   // 先过策略(原始条目,全部字段)
                    if (!chk.ok || !relevant(g, it, chk.parsed)) continue;
                    keptRaw.push(it);
                    list.push(mapItem(it, chk));
                }
                cacheSet('search', ck, { list }, SEARCH_TTL);
                ingest(site, keptRaw);   // 写穿到目录(fire-and-forget)
            }
            for (const m of list) { const k = String(m && m.vod_id); if (seen.has(k)) continue; seen.add(k); out.push(m); }
        }
        await classP;   // 全走缓存时也等分类图,出口复查才有父分类可用
        return onePerWork(out);
    }
    function sseHead(res) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
    }
    const sseDone = (res) => { if (!res.writableEnded) { res.write('event: done\ndata: {}\n\n'); res.end(); } };
    // 线路名:站名 + 版本(中字 / 无码 / 无码流出 / 片段 …,线路标签上就看得出哪条是中字)
    const lineName = (site, variant) => site.name + (typeof variant === 'string' && variant ? ' · ' + variant.slice(0, 8) : '');
    // 搜索结果也带站点表的 _family(前端:同家镜像收成一张「+N 备用」、③ 首集地址去重不把它们并掉、换源先试同家)
    //   和 _native:'risky'(nativeHls:false);没有就不带这两个键(与旧对象逐字相同)
    const withSite = (site, m, wks) => Object.assign({}, m, { site_key: site.key, site_name: lineName(site, m && m._variant), site_profile: profOf(site) },
        typeof site.family === 'string' && site.family ? { _family: site.family.slice(0, 40) } : {},
        site.nativeHls === false ? { _native: 'risky' } : {},
        // [adult] 第三阶段:封面代理开着、这条已经在目录索引里 → 搜索结果的封面也走 /api/img(地址由服务器查,客户端给不了)
        wks && m && wks.has(String(m.vod_id)) ? { vod_pic: imgPath(wks.get(String(m.vod_id)), site.key) } : {});
    const imgPath = (wk, siteKey) => '/api/img?k=' + encodeURIComponent(wk) + '&s=' + encodeURIComponent(siteKey);
    function indexedOf(site, list) {
        if (!imgOn || !Array.isArray(list) || !list.length) return null;
        const cat = getCatalog();
        if (!cat || typeof cat.indexedWks !== 'function') return null;
        try { const m = cat.indexedWks(site.key, list.map((x) => x && x.vod_id)); return m instanceof Map && m.size ? m : null; } catch (e) { warnOnce('indexedWks', e); return null; }
    }

    // GET /api/search?wd=&stream=true|…[&site_key=]
    async function searchGet(req, res) {
        const keyword = typeof req.query.wd === 'string' ? req.query.wd : '';
        const stream = req.query.stream === 'true';
        if (!keyword.trim()) return res.status(400).json({ error: 'Missing keyword' });
        const plan = queryBlocked(keyword) ? null : makePlan(keyword);   // 查询硬拦:不打任何资源站
        if (plan) await refreshHidden(false);   // [adult] p4:后台隐藏表过期了先刷(每 5 分钟一次,读线程毫秒级)
        if (!stream) {
            if (!plan) return res.json({ list: [] });
            const sites = sitesOf();
            const sk = typeof req.query.site_key === 'string' ? req.query.site_key : '';
            const targets = sk ? sites.filter(s => s && s.key === sk && (isKz(s) || s.api)) : fanout(sites, plan);
            const all = [];
            await Promise.all(targets.map(async (site) => {
                let list = [];
                try { list = await siteSearch(site, plan); } catch (e) { warnOnce('search', e); }
                const wks = indexedOf(site, list);
                for (const m of list) if (emitOk(site, m)) all.push(withSite(site, m, wks));
            }));
            return res.json({ list: all });
        }
        sseHead(res);
        if (!plan) return sseDone(res);
        const sent = new Set();
        await Promise.all(fanout(sitesOf(), plan).map(async (site) => {
            let list = [];
            try { list = await siteSearch(site, plan); } catch (e) { warnOnce('search', e); }
            const items = [];
            const wks = indexedOf(site, list);
            for (const m of list) {
                const gk = site.key + '_' + (m && m.vod_id);
                if (sent.has(gk) || !emitOk(site, m)) continue;   // 出口再查一遍
                sent.add(gk);
                items.push(withSite(site, m, wks));
            }
            if (items.length && !res.writableEnded) res.write(`data: ${JSON.stringify(items)}\n\n`);
        }));
        sseDone(res);
    }
    // POST /api/search {keyword, siteKey}
    async function searchPost(req, res) {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const site = sitesOf().find(s => s && s.key === b.siteKey);
        if (!site) return res.status(404).json({ error: 'Site not found' });
        const keyword = typeof b.keyword === 'string' ? b.keyword : '';
        const plan = keyword.trim() && !queryBlocked(keyword) ? makePlan(keyword) : null;
        if (!plan) return res.json({ list: [] });
        await refreshHidden(false);
        try {
            const list = (await siteSearch(site, plan)).filter(m => emitOk(site, m));
            const wks = indexedOf(site, list);
            res.json({ list: wks ? list.map((m) => (wks.has(String(m.vod_id)) ? Object.assign({}, m, { vod_pic: imgPath(wks.get(String(m.vod_id)), site.key) }) : m)) : list });
        }
        catch (e) { warnOnce('searchPost', e); res.status(500).json({ error: 'Search failed' }); }
    }

    // ---------- 详情 ----------
    // [adult] TG 频道(deps.tg):详情现问中转要这一条,按同一套整理 / 过滤,播放地址当场签名(不进缓存:签名会过期)
    const tgOf = () => (deps.tg && typeof deps.tg.config === 'function' ? deps.tg : null);
    const isTgSite = (site) => !!(site && site.family === 'tg' && tgOf());
    async function loadTgDetail(site, id) {
        const tg = tgOf();
        const cfg = tg.config();
        const chan = cfg.on ? cfg.channels.find((c) => c.key === site.key) : null;
        if (!chan || tg.killedOf(chan.key) || !/^[1-9]\d{0,11}$/.test(id)) return null;
        const j = await tgLib.relayGet(cfg, '/api/msg?ch=' + encodeURIComponent(chan.ch) + '&id=' + id, { timeout: 15000 }).catch((e) => { if (e.status !== 404) warnOnce('tg-detail', e); return null; });
        if (!j || !j.item) return null;
        const cat = getCatalog();
        let ci = null;
        try { ci = cat && typeof cat.classInfo === 'function' ? cat.classInfo(site.key, 1) : null; } catch (_) { ci = null; }
        const v = tgLib.toVod(cfg, chan, j.item, (ci && ci.name) || chan.cls || chan.ch);
        if (!v.ok || !checkRaw(site, v.vod).ok) return null;
        return Object.assign({}, v.vod, { vod_play_url: tg.signPlayUrls(v.vod.vod_play_url) });
    }
    async function loadDetail(site, id, nocache) {
        if (isTgSite(site)) return loadTgDetail(site, id);
        if (isKz(site)) {
            const r = await kz().detail(site.key, id, nocache ? { fresh: true } : undefined);
            const d = r && Array.isArray(r.list) ? r.list[0] : null;
            return d && checkRaw(site, d).ok ? d : null;
        }
        if (!site.api) return null;
        const classP = ensureClassMap(site);
        const ck = `adult:${RK()}:${site.key}_detail_${id}`;
        if (!nocache) {
            const c = cacheGet('detail', ck);
            if (c && typeof c === 'object') { await classP; return checkRaw(site, c).ok ? c : null; }
        }
        const data = await fetchJson(site, `${site.api}?ac=detail&ids=${encodeURIComponent(id)}`, 8000);
        await classP;
        const list = data && Array.isArray(data.list) ? data.list : [];
        // 只认 vod_id 对得上的那条:有的站不认 ids 直接回第一页,list[0] 就成了别的片
        const d = list.find(v => v && v.vod_id != null && String(v.vod_id) === id) || (list.length === 1 && list[0] && list[0].vod_id == null ? list[0] : null);
        if (!d || !checkRaw(site, d).ok) return null;   // 被拦的不进缓存
        cacheSet('detail', ck, d, DETAIL_TTL);
        return d;
    }
    const idOk = (id) => (typeof id === 'string' || typeof id === 'number') && String(id) !== '' && String(id).length <= 200;
    // [adult] p4:详情按作品键查后台隐藏表(隐藏的作品详情也 404)
    async function detailHidden(site, d) {
        await refreshHidden(false);
        // 复核:不能因为闸门自己的隐藏表空就早退 —— isHidden 还查目录主线程的隐藏表(adminHidden() 没载到时只有它有)
        const chk = checkRaw(site, d);
        return !chk.ok || isHidden(identity(d, chk)._wk);
    }
    // GET /api/detail?id=&site_key=[&nocache=1] → {list:[detail]};被拦/没有 → 404
    async function detailGet(req, res) {
        const site = sitesOf().find(s => s && s.key === req.query.site_key);
        if (!site) return res.status(404).json({ error: 'Site not found' });
        if (!idOk(req.query.id)) return res.status(404).json({ error: 'Not found', list: [] });
        try {
            const d = await loadDetail(site, String(req.query.id), req.query.nocache === '1');
            if (!d || await detailHidden(site, d)) return res.status(404).json({ error: 'Not found', list: [] });
            res.json({ list: [d] });
        } catch (e) { warnOnce('detail:' + site.key, e); res.status(500).json({ error: 'Detail fetch failed', list: [] }); }
    }
    // POST /api/detail {id, siteKey} → detail;被拦/没有 → 404
    async function detailPost(req, res) {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const site = sitesOf().find(s => s && s.key === b.siteKey);
        if (!site) return res.status(404).json({ error: 'Site not found' });
        if (!idOk(b.id)) return res.status(404).json({ error: 'Not found' });
        try {
            const d = await loadDetail(site, String(b.id), false);
            if (!d || await detailHidden(site, d)) return res.status(404).json({ error: 'Not found' });
            res.json(d);
        } catch (e) { warnOnce('detail:' + site.key, e); res.status(500).json({ error: 'Detail fetch failed' }); }
    }

    // ---------- 鉴权 ----------
    function requireAuth(req, res, next) {
        if (!authRequired()) {
            if (ageConfirmed(req)) return next();
            res.set('Cache-Control', 'no-store');
            return res.status(401).json({ error: 'AGE_REQUIRED' });
        }
        const t = readToken(req);
        if (ownToken(t)) {
            if (banned(t)) { res.set('Cache-Control', 'no-store'); return res.status(403).json({ error: 'BANNED', banned: true }); }
            return next();
        }
        res.set('Cache-Control', 'no-store');
        return res.status(401).json({ error: 'AUTH_REQUIRED' });
    }
    // 登录/验证/续期/扫码取凭据 成功的回包 → 顺手下发 dg_t(只认令牌表里真有的令牌)
    function loginCookieTap(req, res, next) {
        if (res.__dgCookieTap) return next();
        res.__dgCookieTap = true;
        const orig = res.json;
        res.json = function (b) {
            try {
                let t = '';
                if (b && typeof b === 'object') {
                    if (b.success === true) t = okTok(b.passwordHash) || okTok(b.userToken);
                    else if (b.status === 'approved' && b.auth && b.auth.type === 'password') t = okTok(b.auth.hash);
                }
                if (t && ownToken(t) && !banned(t) && !res.headersSent) res.append('Set-Cookie', tokenCookie(t, req));
            } catch (e) { warnOnce('cookie', e); }
            return orig.call(this, b);
        };
        next();
    }
    function logout(req, res) {
        res.append('Set-Cookie', clearTokenCookie(req));
        res.set('Cache-Control', 'no-store');
        res.json({ ok: true });
    }
    // 回包过滤:原路由照常跑,它的 res.json 先经过 fn。fn 抛错 = 不出内容(500)
    function jsonFilter(fn) {
        return (req, res, next) => {
            const orig = res.json;
            res.json = function (body) {
                let out;
                try { out = fn(body, req); }
                catch (e) { warnOnce('filter', e); res.status(500); out = { error: 'FILTER_ERROR' }; }
                return orig.call(this, out);
            };
            next();
        };
    }

    // ---------- 关掉的功能 ----------
    function registerOff(app) {
        const notFound = (req, res) => {
            res.set('Cache-Control', 'no-store');
            if (req.originalUrl.indexOf('/api/') === 0) return res.status(404).json({ error: 'NOT_AVAILABLE' });
            res.status(404).type('text').send('Not Found');
        };
        // TMDB 一律不碰(不管配没配 TMDB_API_KEY):代理/图片/分享预览/SEO 详情页/站点地图
        app.use(['/api/tmdb-proxy', '/api/tmdb-image', '/api/preview', '/sitemap.xml', '/movie', '/tv'], notFound);
        // 封面代理的磁盘缓存不在 public/ 下(见 imgCacheDir);旧版本放过 public/cache/adult-img,那里留下的文件仍拦成 404。
        //   按解码 + 归一化后的路径拦:express 挂载点只比字面路径,serve-static 会把 //、/./、x/../、%2f、Windows 的 \ 和结尾的点归一化掉
        app.use('/cache', (req, res, next) => {
            let p = String(req.path || '');
            try { p = decodeURIComponent(p); } catch (e) { return notFound(req, res); }
            const segs = p.replace(/\\/g, '/').split('/').map((s) => s.replace(/[. ]+$/, '').toLowerCase());
            if (segs.some((s) => s.indexOf('adult-img') === 0 || /^adult-~\d/.test(s))) return notFound(req, res);
            next();
        });
        if (off.push) app.use('/api/push', (req, res) => { res.set('Cache-Control', 'no-store'); res.status(404).json({ enabled: false, error: 'disabled' }); });
        if (off.requests) app.use('/api/requests', (req, res) => res.status(403).json({ error: '求片功能未开启' }));
        if (off.intro) app.use('/api/intro', (req, res) => {
            if (req.method === 'GET' && req.path === '/marks') return res.json({ marks: {} });
            if (req.method === 'GET' && req.path === '/env') return res.json({ env: null });
            res.status(403).json({ error: 'disabled' });
        });
        if (off.danmaku) app.use('/api/danmaku', (req, res) => {
            res.set('Cache-Control', 'no-store');
            res.json(req.method === 'GET' ? { code: 0, version: 3, data: [], msg: '' } : { code: 0, msg: '' });
        });
    }

    // ---------- 首页目录 ----------
    const expandHits = new Map();
    function expandAllowed(key) {   // 每令牌(没令牌按 IP)每分钟最多 10 次现搜补线路
        const now = Date.now();
        const a = (expandHits.get(key) || []).filter(t => now - t < 60e3);
        if (a.length >= 10) { expandHits.set(key, a); return false; }
        a.push(now);
        if (expandHits.size >= 5000) expandHits.clear();
        expandHits.set(key, a);
        return true;
    }
    // [adult] p4:后台隐藏的作品也不出(目录自己也滤;这里是出口兜底)
    const cardOk = (c) => !!c && typeof c === 'object' && nameOk(c.name, '', c.bucket) && !isHidden(c.wk);
    let homeMemo = null;
    function filterHome(h) {
        if (!h || typeof h !== 'object' || !Array.isArray(h.rows)) return { generatedAt: (h && h.generatedAt) || 0, rows: [] };
        const rk = RK();   // [adult] p4:追加屏蔽词改了 = 规则键变了,旧的过滤结果作废
        if (homeMemo && homeMemo.src === h && homeMemo.at === h.generatedAt && homeMemo.rk === rk && homeMemo.hv === hidden.at) return homeMemo.out;
        const out = Object.assign({}, h, { rows: h.rows.filter(r => r && typeof r === 'object').map(r => Object.assign({}, r, { items: (Array.isArray(r.items) ? r.items : []).filter(cardOk) })) });
        homeMemo = { src: h, at: h.generatedAt, rk, hv: hidden.at, out };
        return out;
    }
    function filterPage(r, page) {
        if (!r || typeof r !== 'object') return { page, total_pages: 0, total_results: 0, results: [] };
        const out = Object.assign({}, r, { results: (Array.isArray(r.results) ? r.results : []).filter(cardOk) });
        // 第三阶段分面:演员名 / 片商名再过一遍查询硬拦词(标签名来自词表)
        if (r.facets && typeof r.facets === 'object') {
            const f = Object.assign({}, r.facets);
            if (Array.isArray(f.actress)) f.actress = f.actress.filter(a => a && typeof a.name === 'string' && !queryBlocked(a.name));
            if (Array.isArray(f.studio)) f.studio = f.studio.filter(x => x && typeof x.label === 'string' && !queryBlocked(x.label));
            out.facets = f;
        }
        return out;
    }
    function browseQuery(q) {
        const pick = (v, ok, d) => (typeof v === 'string' && ok.indexOf(v) >= 0) ? v : d;
        // 没给 = '';给了但不合法(../../etc、数组…)→ '!bad':交给目录 normBrowse 判 bad 回空页,不能悄悄变成"全部分区"
        const word = (v) => (v == null || v === '') ? '' : ((typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v)) ? v : '!bad');
        // b:一个分区,或逗号分隔 ≤6 个(前端「日本」「国产」整类浏览);每一段都按 word 验
        const bList = (v) => (typeof v === 'string' && v.indexOf(',') > 0 && v.length <= 250) ? (v.split(',').length <= 6 && v.split(',').every((x) => word(x) === x) ? v : '!bad') : word(v);
        const out = {
            b: bList(q.b), tag: word(q.tag),
            sort: pick(q.sort, ['new', 'updated', 'released', 'hot', 'dur', 'lines', 'rand', 'random'], 'new'),
            // dur / v 给了但不认识 → '!bad'(和 t / x / b / studio / actress / lp 一样回空页,不再悄悄变成"不筛")
            dur: (q.dur == null || q.dur === '') ? '' : pick(q.dur, ['s', 'm', 'l', 'xl', 'xxl', 'unk'], '!bad'),
            flag: pick(q.flag, ['', 'zh', 'unc', 'multi'], ''),
            page: Math.min(500, Math.max(1, parseInt(q.page, 10) || 1)),
        };
        // lp:厂牌前缀(作品页「SSIS」按钮 → 这个厂牌的番号作品);没给就不带这个键,给了但非法 → '!bad'(目录回空页)
        if (q.lp != null && q.lp !== '') out.lp = (typeof q.lp === 'string' && /^[A-Za-z0-9]{2,10}$/.test(q.lp)) ? q.lp.toUpperCase() : '!bad';
        // [adult] 第三阶段(契约 C):t / x(标签 id,逗号分隔 ≤3)、v(版本)、studio、actress、cursor、facets。同样:没给不带键,非法 → '!bad'
        const ids = (v) => (typeof v === 'string' && v.length <= 130 && v.split(',').length <= 3 && v.split(',').every((x) => /^[A-Za-z0-9_]{1,40}$/.test(x))) ? v : '!bad';
        if (q.t != null && q.t !== '') out.t = ids(q.t);
        if (q.x != null && q.x !== '') out.x = ids(q.x);
        if (q.v != null && q.v !== '') out.v = pick(q.v, ['zh', 'unc', 'leak', 'vr', '4k', 'vertical'], '!bad');
        // 片商名可以带单引号(M's video);双引号 / 反引号 / 反斜杠 / 尖括号 / 控制字符仍然 !bad(值只进参数化查询和快照里的 Map 键)
        if (q.studio != null && q.studio !== '') out.studio = (typeof q.studio === 'string' && q.studio.length <= 80 && !/[\u0000-\u001f<>"`\\]/.test(q.studio)) ? q.studio : '!bad';
        if (q.actress != null && q.actress !== '') out.actress = (typeof q.actress === 'string' && /^[A-Za-z0-9_:.-]{1,40}$/.test(q.actress)) ? q.actress : '!bad';
        if (q.cursor != null && q.cursor !== '') out.cursor = (typeof q.cursor === 'string' && /^[A-Za-z0-9_-]{1,400}$/.test(q.cursor)) ? q.cursor : '';
        if (q.facets === '1' || q.facets === 'true') out.facets = true;
        if (q.nr === '1') out.nr = true;   // 复核 r3:不要审查级作品(「猜你喜欢」推荐位;只会更严)
        return out;
    }
    // 线路补上站名/档案;不在站点表里(停用/删除)的线路、片名被拦的线路丢掉;片名被拦或一条线路都不剩 → null(404)
    //   第二阶段字段(_family/_native)按站点表重算一遍(站点表才是准的);_dead/_res/_same 照目录给的;
    //   _meta.actress 再过一遍查询硬拦词,_meta.siblings 按片名再过一遍
    function filterGroup(g) {
        if (!g || typeof g !== 'object' || !nameOk(g.name, '', g._meta && g._meta.bucket)) return null;
        const byKey = new Map(sitesOf().filter(s => s && s.key).map(s => [s.key, s]));
        const sources = [];
        for (const s of (Array.isArray(g.sources) ? g.sources : [])) {
            if (!s || typeof s !== 'object') continue;
            const site = byKey.get(s.site_key);
            if (!site || !checkRaw(site, { vod_name: s.vod_name, type_name: s.type_name }).ok) continue;
            // [adult] TG 线路:库里存的 tg://频道/id 到这里才换成签名的中转地址
            //   _pv:卡片预览片(中转现做的几秒 360p MP4;preview.js 悬停 / 长按时用,iPhone 没有 MSE 也能放)
            let tgSigned = null;
            if (isTgSite(site) && typeof s.vod_play_url === 'string') {
                const T = tgOf(), pv = typeof T.previewOf === 'function' ? T.previewOf(s.vod_play_url) : '';
                tgSigned = Object.assign({ vod_play_url: T.signPlayUrls(s.vod_play_url) }, pv ? { _pv: pv } : {});
            }
            sources.push(Object.assign({}, s, tgSigned, {
                site_name: lineName(site, s._variant), site_profile: profOf(site),
                _family: typeof site.family === 'string' ? site.family.slice(0, 40) : '',
                _dead: s._dead === true, _res: typeof s._res === 'string' ? s._res : '', _same: typeof s._same === 'string' ? s._same : '',
                _native: site.nativeHls === false ? 'risky' : 'ok',
            }));
        }
        if (!sources.length) return null;
        const out = Object.assign({}, g, { sources });
        if (g._meta && typeof g._meta === 'object') {
            const m = Object.assign({}, g._meta);
            m.n_sites = new Set(sources.map(s => s.site_key)).size;   // 闸门丢掉的线路(停用站/片名被拦)不算「上架 N 站」
            // 第三阶段:演员是 {aid, name}(aid 只有 AVDB 认得的才有);旧形状的字符串也认
            if (Array.isArray(m.actress)) m.actress = m.actress.map(a => (typeof a === 'string' ? { aid: null, name: a } : a))
                .filter(a => a && typeof a === 'object' && typeof a.name === 'string' && a.name && !queryBlocked(a.name))
                .map(a => ({ aid: (typeof a.aid === 'number' || typeof a.aid === 'string') ? a.aid : null, name: a.name }));
            if (Array.isArray(m.tags)) m.tags = m.tags.filter(x => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.label === 'string');
            for (const k of ['maker', 'label', 'studio']) if (typeof m[k] === 'string' && m[k] && queryBlocked(m[k])) m[k] = '';
            if (Array.isArray(m.siblings)) m.siblings = m.siblings.filter(x => x && typeof x === 'object' && nameOk(x.name, '', m.bucket) && !isHidden(x.wk));
            out._meta = m;
        }
        return out;
    }
    // 联想回包:kind 只认约定的几种;卡片按片名再过一遍,exact 指向的卡片被滤掉 → exact 也不给
    const SUGGEST_KINDS = new Set(['blocked', 'code', 'alias', 'text', 'empty']);
    function filterSuggest(r) {
        const o = r && typeof r === 'object' ? r : {};
        const items = (Array.isArray(o.items) ? o.items : []).filter(cardOk).slice(0, 8);
        const kind = SUGGEST_KINDS.has(o.kind) ? o.kind : 'text';
        const al = o.alias && typeof o.alias === 'object' ? o.alias : null;
        // 多词合成别名(「黑丝 伪娘」)还带 tags:[{tag,label}](≤3,只留字符串字段)
        const tags = al && Array.isArray(al.tags) ? al.tags.slice(0, 3).filter(x => x && typeof x.tag === 'string' && x.tag.length <= 40).map(x => ({ tag: x.tag, label: typeof x.label === 'string' ? x.label.slice(0, 20) : '' })) : [];
        const alias = al && typeof al.label === 'string' ? Object.assign({ label: al.label }, typeof al.b === 'string' ? { b: al.b } : {}, typeof al.tag === 'string' ? { tag: al.tag } : {}, tags.length ? { tags } : {}) : null;
        const exact = typeof o.exact === 'string' && items.some(c => c.wk === o.exact) ? o.exact : null;
        return { kind, alias, exact, items };
    }
    // 播放上报的请求体:JSON(fetch)或 text/plain 里的 JSON(navigator.sendBeacon 发字符串时)
    function beaconBody(req) {
        const b = req.body;
        if (b && typeof b === 'object' && !Buffer.isBuffer(b) && Object.keys(b).length) return Promise.resolve(b);
        if (req._body || req.readableEnded || typeof req.on !== 'function') return Promise.resolve(b && typeof b === 'object' ? b : {});
        return new Promise((resolve) => {
            let n = 0;
            const chunks = [];
            const done = (v) => { try { req.removeAllListeners('data'); } catch (e) { } resolve(v); };
            req.on('data', (c) => { n += c.length; if (n > 8192) { done({}); try { req.destroy(); } catch (e) { } return; } chunks.push(c); });
            req.on('end', () => { try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); done(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); } catch (e) { done({}); } });
            req.on('error', () => done({}));
        });
    }
    const hits60 = new Map();
    function perMinute(map, key, max) {
        const now = Date.now();
        const a = (map.get(key) || []).filter(t => now - t < 60e3);
        if (a.length >= max) { map.set(key, a); return false; }
        a.push(now);
        if (map.size >= 5000) map.clear();
        map.set(key, a);
        return true;
    }
    const hashId = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
    // 封面代理(ADULT_IMG_PROXY=1 才开;只认 1/true/yes/on)
    const imgOn = /^(1|true|yes|on)$/i.test(String(env.ADULT_IMG_PROXY == null ? '' : env.ADULT_IMG_PROXY).trim());
    let imgProxy = null;
    // 封面缓存目录:ADULT_IMG_CACHE_DIR,默认 cache.db(CACHE_DB_PATH)同目录下的 adult-img-cache;没配 CACHE_DB_PATH(cache.db 在仓库根)
    //   → node_modules/.cache/adult-img-cache(已被 .gitignore 的 node_modules/ 盖住,开发检出不会把缓存的封面提交进去)。
    //   绝不放进 public/(/cache 是公开静态目录,挂载点拦截能被路径归一化绕过;配到 public/ 里 → 告警并退回默认)
    function imgCacheDir() {
        if (deps.imgDir) return deps.imgDir;
        const root = path.join(__dirname, '..', '..');
        const db = String(env.CACHE_DB_PATH || '').trim();
        const def = db ? path.join(path.dirname(path.resolve(db)), 'adult-img-cache') : path.join(root, 'node_modules', '.cache', 'adult-img-cache');
        const want = String(env.ADULT_IMG_CACHE_DIR || '').trim();
        if (!want) return def;
        const abs = path.resolve(want);
        const rel = path.relative(path.join(root, 'public'), abs);
        if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) { warnOnce('imgdir', 'ADULT_IMG_CACHE_DIR 在 public/ 里(公开静态目录),已改用 ' + def); return def; }
        return abs;
    }
    function getImgProxy() {
        if (imgProxy) return imgProxy;
        const mb = parseInt(env.ADULT_IMG_CACHE_MB, 10);
        imgProxy = require('../site-catalog/img').createImgProxy({
            dir: imgCacheDir(),
            capMb: Number.isFinite(mb) && mb > 0 ? mb : 1024,
            fetchImage: typeof deps.imgFetch === 'function' ? deps.imgFetch : undefined,
            // 地址只从索引里查(作品要过审查过滤、片名要过策略);客户端给的任何地址都不看
            resolve: (k, s) => {
                const cat = getCatalog();
                if (!cat || typeof cat.picUrl !== 'function') return null;
                const r = cat.picUrl(k, s, { meta: true });
                if (!r || typeof r !== 'object' || typeof r.url !== 'string') return null;
                if (!nameOk(r.name, '', r.bucket)) return null;
                // 第三阶段:候选地址(线路封面 → AVDB 封面兜底),代理按顺序试
                return Array.isArray(r.urls) && r.urls.length ? r.urls.filter(u => typeof u === 'string') : r.url;
            },
            log: (m) => warnOnce('img', m),
        });
        return imgProxy;
    }
    function registerCatalog(app) {
        const withCat = (fn) => async (req, res) => {
            const cat = getCatalog();
            if (!cat) { res.set('Cache-Control', 'no-store'); return res.status(503).json({ error: 'CATALOG_UNAVAILABLE' }); }
            try { await fn(cat, req, res); }
            catch (e) { warnOnce('catalog', e); if (!res.headersSent) { res.set('Cache-Control', 'no-store'); res.status(500).json({ error: 'CATALOG_ERROR' }); } }
        };
        const cache60 = (res) => res.set('Cache-Control', 'private, max-age=60');
        app.get('/api/catalog/home', withCat(async (cat, req, res) => { const h = await cat.home(); cache60(res); res.json(filterHome(h)); }));
        app.get('/api/catalog/buckets', withCat(async (cat, req, res) => { const b = await cat.buckets(); cache60(res); res.json(Array.isArray(b) ? b : []); }));
        app.get('/api/catalog/browse', withCat(async (cat, req, res) => {
            const q = browseQuery(req.query || {});
            const r = await cat.browse(q);
            cache60(res);
            res.json(filterPage(r, q.page));
        }));
        // 本地即时查找(零上游,毫秒级):番号按 key 精确命中,文字走目录的 FTS/LIKE。查询命中硬拦词 → 空;每张卡片再按片名过一遍策略
        //   → {kind:'code'|'text', key, results:[card]}(前端:番号恰好命中一部作品就直接开作品页,不再全站扇出)
        app.get('/api/catalog/lookup', withCat(async (cat, req, res) => {
            const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
            res.set('Cache-Control', 'no-store');
            const plan = q.trim() && !queryBlocked(q) ? makePlan(q) : null;
            if (!plan || typeof cat.lookup !== 'function') return res.json({ kind: plan ? plan.kind : 'text', key: null, results: [] });
            const limit = Math.max(1, Math.min(24, parseInt(req.query.limit, 10) || 8));
            const rows = await cat.lookup(q, { limit });
            res.json({ kind: plan.kind, key: plan.kind === 'code' ? plan.key : null, results: (Array.isArray(rows) ? rows : []).filter(cardOk) });
        }));
        app.get('/api/catalog/work', withCat(async (cat, req, res) => {
            const k = typeof req.query.k === 'string' ? req.query.k : '';
            if (!/^[ct]:./.test(k) || k.length > 300) { res.set('Cache-Control', 'no-store'); return res.status(400).json({ error: 'BAD_KEY' }); }
            let expand = req.query.expand === '1' || req.query.expand === 'true';
            if (expand && !expandAllowed(readToken(req) || ('ip:' + ipOf(req)))) { expand = false; res.set('X-Expand-Limited', '1'); }
            // 复核 r3:后台隐藏主作品 = 它的 #U / #clip / ~N 兄弟一起不出(目录的 hid 只认精确键;直链 / 继续观看 / 分享链接也不能开)
            if (isHidden(k)) { res.set('Cache-Control', 'no-store'); return res.status(404).json({ error: 'NOT_FOUND' }); }
            const raw = await cat.work(k, { expand });
            const out = isHidden(k) ? null : filterGroup(raw);   // 等目录期间刚被隐藏的也不出
            if (!out) { res.set('Cache-Control', 'no-store'); return res.status(404).json({ error: 'NOT_FOUND' }); }
            res.set('Cache-Control', expand ? 'no-store' : 'private, max-age=60');
            res.json(out);
        }));
        // 标签云(当前快照,第三阶段契约 C):{groups:[{id,label}], tags:[{id,label,count,featured:true,group}]} —— 只出 featured(审查级永不做导航)
        app.get('/api/catalog/tags', withCat(async (cat, req, res) => {
            const b = browseQuery({ b: req.query.b }).b;
            const r = typeof cat.tags === 'function' ? await cat.tags(b) : null;
            const tags = (r && Array.isArray(r.tags) ? r.tags : []).filter(t => t && typeof t.id === 'string' && typeof t.label === 'string' && t.featured === true)
                .map(t => ({ id: t.id, label: t.label, count: Number(t.count) || 0, featured: true, group: typeof t.group === 'string' ? t.group : '' }));
            const groups = (r && Array.isArray(r.groups) ? r.groups : []).filter(g => g && typeof g.id === 'string' && typeof g.label === 'string').map(g => ({ id: g.id, label: g.label }));
            cache60(res);
            res.json({ groups, tags });
        }));
        // 标签页:{tag:{id,label,group}, count, buckets, related(只 featured), items};blocked / 未知 → 404(不回显)
        app.get('/api/catalog/tag/:id', withCat(async (cat, req, res) => {
            const id = typeof req.params.id === 'string' ? req.params.id : '';
            const r = /^[A-Za-z0-9_]{1,40}$/.test(id) && typeof cat.tagPage === 'function' ? await cat.tagPage(id) : null;
            if (!r || !r.tag) { res.set('Cache-Control', 'no-store'); return res.status(404).json({ error: 'NOT_FOUND' }); }
            cache60(res);
            res.json(Object.assign({}, r, { items: (Array.isArray(r.items) ? r.items : []).filter(cardOk) }));
        }));
        // 演员:按名字搜(AVDB 本地表,≤10)/ 演员页(按发行日期)。名字过查询硬拦词;没有 / 被拦 → 404
        app.get('/api/catalog/actress', withCat(async (cat, req, res) => {
            const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : '';
            res.set('Cache-Control', 'no-store');
            if (!q.trim() || queryBlocked(q) || typeof cat.actressSearch !== 'function') return res.json([]);
            const r = await cat.actressSearch(q);
            res.json((Array.isArray(r) ? r : []).filter(a => a && typeof a.name === 'string' && !queryBlocked(a.name)).slice(0, 10).map(a => ({ aid: a.aid, name: a.name, n: Number(a.n) || 0 })));
        }));
        app.get('/api/catalog/actress/:aid', withCat(async (cat, req, res) => {
            const aid = typeof req.params.aid === 'string' ? req.params.aid : '';
            const page = Math.min(500, Math.max(1, parseInt(req.query.page, 10) || 1));
            const r = /^[A-Za-z0-9_:.-]{1,40}$/.test(aid) && typeof cat.actress === 'function' ? await cat.actress(aid, { page }) : null;
            if (!r || !r.actress || typeof r.actress.name !== 'string' || queryBlocked(r.actress.name)) { res.set('Cache-Control', 'no-store'); return res.status(404).json({ error: 'NOT_FOUND' }); }
            cache60(res);
            res.json({ actress: { aid: r.actress.aid, name: r.actress.name, aliases: (Array.isArray(r.actress.aliases) ? r.actress.aliases : []).filter(x => typeof x === 'string' && !queryBlocked(x)) },
                page: r.page, total_pages: r.total_pages, results: (Array.isArray(r.results) ? r.results : []).filter(cardOk) });
        }));
        // 片商榜(当前快照):[{id,label,count}]
        app.get('/api/catalog/studios', withCat(async (cat, req, res) => {
            const b = browseQuery({ b: req.query.b }).b;
            const r = typeof cat.studios === 'function' ? await cat.studios(b) : [];
            cache60(res);
            res.json((Array.isArray(r) ? r : []).filter(x => x && typeof x.id === 'string' && typeof x.label === 'string' && !queryBlocked(x.label)).map(x => ({ id: x.id, label: x.label, count: Number(x.count) || 0 })));
        }));
        // 本地联想(零上游):被拦的查询不进目录
        app.get('/api/catalog/suggest', withCat(async (cat, req, res) => {
            const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
            res.set('Cache-Control', 'no-store');
            if (!q.trim()) return res.json({ kind: 'empty', alias: null, exact: null, items: [] });
            if (queryBlocked(q)) return res.json({ kind: 'blocked', alias: null, exact: null, items: [] });
            if (typeof cat.suggest !== 'function') return res.json({ kind: 'text', alias: null, exact: null, items: [] });
            res.json(filterSuggest(await cat.suggest(q)));
        }));
        // 播放结果上报(零上游);上报者在目录里只存哈希。
        //   身份 = 有效令牌(没配密码时令牌不算数:客户端随便写)+ 可信客户端网络(trustedClientNet)。共享一个访问密码时
        //   所有人令牌相同,靠网络区分;认不出网络(反代后面没配 ADULT_CLIENT_IP_HEADER)→ 只按令牌算(共享密码 = 一个上报者,
        //   永远凑不够"3 个不同上报者",宁可不判死);令牌、网络都没有 → 匿名:失败不计数(成功照收)。客户端伪造的转发头造不出新上报者。
        //   限流:每分钟 60 次,键 = 令牌 + 可信网络;认不出网络时 = 令牌 + 对端网络(IPv6 /64;不看客户端能写的转发头:
        //   伪造 X-Real-IP / XFF 开不出新的配额)。反代后面没配 ADULT_CLIENT_IP_HEADER 的共享密码站 = 全站共用这 60 次
        //   (那种部署本来就判不了"失效",丢掉的只是补时长/分辨率的上报;配上头就按客户端网络各算各的)
        app.post('/api/catalog/beacon', withCat(async (cat, req, res) => {
            res.set('Cache-Control', 'no-store');
            const t0 = readToken(req);
            const tok = authRequired() && ownToken(t0) ? t0 : '';
            const tnet = trustedClientNet(req, ipHeader);
            const sock = req.socket || req.connection;
            const k1 = tnet ? 'n:' + tok + '|' + tnet : 'p:' + tok + '|' + (netKeyOf(normIp(sock && sock.remoteAddress)) || '-');   // 复核 SEC-3:IPv6 按 /64
            if (!perMinute(hits60, k1, 60)) return res.status(429).json({ error: 'RATE_LIMITED' });
            const who = tnet ? hashId('r|' + tok + '|' + tnet) : (tok ? hashId('r|' + tok + '|') : '');
            const b = await beaconBody(req);
            const vid = b.vod_id;
            const okShape = typeof b.site_key === 'string' && b.site_key.length <= 64 && (typeof vid === 'string' || typeof vid === 'number') && String(vid).length <= 64 && typeof b.ok === 'boolean'
                && (b.wk == null || (typeof b.wk === 'string' && b.wk.length <= 300));
            if (!okShape) return res.status(400).json({ error: 'BAD_BEACON' });
            const site = sitesOf().find(s => s && s.key === b.site_key);
            if (site && typeof cat.beacon === 'function') {
                await cat.beacon({
                    wk: typeof b.wk === 'string' ? b.wk : '', site_key: b.site_key, vod_id: String(vid), ok: b.ok,
                    err: typeof b.err === 'string' ? b.err.slice(0, 200) : '', dur: Number(b.dur), w: Number(b.w), h: Number(b.h),
                    // [adult] p4:线路的画面方向(前端从 video.videoWidth/Height 算;目录据此记线路 + 推作品 orient)
                    orient: b.orient === 'v' || b.orient === 'h' || b.orient === 'sq' ? b.orient : '',
                }, who);   // who 为空 = 匿名(目录只收成功,不计失败)
            }
            res.status(204).end();
        }));
        // [adult] p4:相关推荐 / 竖屏短片流 / 热度条(routes-p4.js)
        routesP4.registerCatalogP4(app, withCat, p4ctx());
    }
    // 封面代理:开着才挂真实现;关着 /api/img 一律 404(前端据 /api/config img_proxy 决定用不用)
    function registerImg(app) {
        if (!imgOn) {
            app.get('/api/img', (req, res) => { res.set('Cache-Control', 'no-store'); res.status(404).json({ error: 'NOT_AVAILABLE' }); });
            return;
        }
        app.get('/api/img', (req, res) => {
            if (!getCatalog()) { res.set('Cache-Control', 'no-store'); return res.status(503).json({ error: 'CATALOG_UNAVAILABLE' }); }
            if (typeof req.query.k === 'string' && isHidden(req.query.k)) { res.set('Cache-Control', 'no-store'); return res.status(404).json({ error: 'NOT_FOUND' }); }   // 复核 r3:隐藏作品(含兄弟)的封面也不给
            Promise.resolve(getImgProxy().handle(req, res)).catch((e) => { warnOnce('img', e); if (!res.headersSent) res.status(500).json({ error: 'IMG_ERROR' }); });
        });
    }

    // ---------- /api/config 附加字段(放在原对象最后,覆盖同名键) ----------
    // 死封面域名:只收像域名的字符串、去重、≤200;目录没有 / 没这个接口 / 出错 → []
    function coverDeadHosts() {
        try {
            const cat = getCatalog();
            const l = cat && typeof cat.coverDeadHosts === 'function' ? cat.coverDeadHosts() : [];
            if (!Array.isArray(l)) return [];
            const out = [];
            for (const h of l) {
                if (typeof h !== 'string' || h.length > 253 || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(h) || out.indexOf(h) >= 0) continue;
                out.push(h);
                if (out.length >= 200) break;
            }
            return out;
        } catch (e) { warnOnce('coverDeadHosts', e); return []; }
    }
    // 这个请求能不能看目录(和 requireAuth 放行的条件一样):要登录的站 = 自己的令牌、没被封;公开站 = 确认过年龄。没给 req = 不能
    function catalogVisible(req) {
        if (!req) return false;
        try {
            if (!authRequired()) return ageConfirmed(req);
            const t = readToken(req);
            return !!ownToken(t) && !banned(t);
        } catch (_) { return false; }
    }
    // 登录页"购买/续费"地址:没配 / 配的不是 http(s) 地址 → 主站的 ednovas.me;0/off/none/false/no → 不显示
    const PURCHASE_DEFAULT = 'https://ednovas.me';
    function purchaseUrl() {
        const raw = String(env.PURCHASE_URL == null ? '' : env.PURCHASE_URL).trim();
        if (!raw) return PURCHASE_DEFAULT;
        if (/^(0|off|none|false|no)$/i.test(raw)) return '';
        return raw.length <= 300 && /^https?:\/\/[^\s"'<>]+$/i.test(raw) ? raw : PURCHASE_DEFAULT;
    }
    // req:/api/config 的请求(server.js 传进来)。只看得到 /api/config 的未登录访客不给 cover_dead_hosts(那是本站聚合的上游图床名单)
    function configFields(req) {
        const o = {
            adult: true, catalog: !!getCatalog(), age_gate: true,
            site_name: String(env.SITE_NAME || 'MEI.NU').slice(0, 40),
            auth_required: authRequired(), rules_version: RV,
            tmdb_api_key: null, tmdb_proxy_url: null,   // 前端不许直连 TMDB
            intro_enabled: !off.intro,
            img_proxy: imgOn && !!getCatalog(),   // 封面走 /api/img(ADULT_IMG_PROXY=1);false = 卡片 pic 是直链,前端 no-referrer
            // 封面域名健康(lib/site-catalog/cover-health.js):DNS 判定不存在的封面图床(≤200 个)。前端对资源站现搜来的 vod_pic
            //   也先跳过这些域名(目录卡片的 pic 服务器已经挑过);ADULT_COVER_HEALTH_DISABLE=1 / 没有目录 → []。
            //   /api/config 谁都能读(登录前也要拿站名):要登录的站只给带自己令牌的请求、公开站只给确认过年龄的(和目录接口同口径),其余 [] ——
            //   登录后应用启动(startApp)那次 /api/config 带着 dg_t Cookie,前端 adultApplyConfig 照常拿到
            cover_dead_hosts: catalogVisible(req) ? coverDeadHosts() : [],
            // 登录页"购买/续费"链接(2026-11-22 站长定:沿用主站的 ednovas.me):PURCHASE_URL 配了 http/https 地址就用它,
            //   配 0/off/none/false/no 就隐藏,没配 / 配错 = 主站地址
            purchase_url: purchaseUrl(),
        };
        if (off.danmaku) o.danmaku_enabled = false;
        if (off.requests) o.requests_enabled = false;
        if (off.push) o.push_enabled = false;
        return o;
    }

    // ---------- [adult] p4:后台 / 新路由要用的闭包 ----------
    // 客户端键(限流 / 后台锁定用):可信网络(trustedClientNet)或对端的网络(IPv6 /64);客户端自己写的转发头开不出新键(见 clientKeyOf)
    const clientKey = (req) => clientKeyOf(req, ipHeader);
    const ephemeralSecret = crypto.randomBytes(32).toString('hex');
    function siteForClient(s0) {
        let s = s0;
        if (s && typeof s === 'object' && 'mirrors' in s) { s = Object.assign({}, s); delete s.mirrors; }   // 备用域名表只给服务器用
        const mir = getMirror();
        if (!mir || !s || typeof s.key !== 'string' || typeof s.api !== 'string' || !s.api || isKz(s)) return s;
        let a = null;
        try { a = mir.apiFor(s.key); } catch (e) { a = null; }
        return typeof a === 'string' && a && a !== s.api ? Object.assign({}, s, { api: a }) : s;
    }
    const configuredSites = () => {
        try { if (typeof deps.configuredSites === 'function') { const l = deps.configuredSites(); if (Array.isArray(l)) return l; } } catch (e) { warnOnce('configuredSites', e); }
        return sitesOf().map((s) => (s && s._api0 ? Object.assign({}, s, { api: s._api0 }) : s));
    };
    // 追加屏蔽词:主线程 policy + 目录(写线程 / 读线程)。词表不合法 → {error}(旧词表不变);只会更严
    function applyExtraBlock(words) {
        const r = { main: false, catalog: false, words: null, error: '' };
        if (typeof policy.setExtraBlock !== 'function') { r.error = 'policy.setExtraBlock 不可用'; return r; }
        try { const x = policy.setExtraBlock(words); r.words = x && Array.isArray(x.words) ? x.words : words; r.main = true; }
        catch (e) { r.error = String((e && e.message) || e).slice(0, 200); return r; }
        const cat = getCatalog();
        if (cat && typeof cat.setExtraBlock === 'function') {
            // r.catalogP:目录那边的结果(Promise<{ok,…}|{ok:false,error}>);PUT block-words 等它,启动同步不等(失败只记日志)
            try {
                const p = cat.setExtraBlock(r.words);
                r.catalogP = Promise.resolve(p).then((x) => {
                    if (x && typeof x === 'object' && x.ok === false) warnOnce('catalog.setExtraBlock', new Error(String(x.error || 'failed')));
                    return x;
                }, (e) => { warnOnce('catalog.setExtraBlock', e); return { ok: false, error: String((e && e.message) || e) }; });
                r.catalog = true;
            }
            catch (e) { warnOnce('catalog.setExtraBlock', e); r.catalogP = Promise.resolve({ ok: false, error: String((e && e.message) || e) }); }
        }
        return r;
    }
    // 启动时:后台存的词表 ∪ 目录存的词表(目录有 extraBlock() 才读)→ 两边都设上(两份取并集 = 宁可多拦)
    function syncExtraBlock() {
        const mine = adminState.blockWords() || [];
        const cat = getCatalog();
        const fromCat = () => {
            try {
                const g = cat && (typeof cat.extraBlock === 'function' ? cat.extraBlock : (typeof cat.getExtraBlock === 'function' ? cat.getExtraBlock : null));
                return Promise.resolve(g ? g.call(cat) : null);
            } catch (e) { return Promise.resolve(null); }
        };
        return fromCat().then((x) => {
            const theirs = Array.isArray(x) ? x : (x && Array.isArray(x.words) ? x.words : []);
            // 坏词(手改 / 损坏的 adult-admin.json、旧版留下的超长词)单独丢掉:否则一个坏词让整张并集表 setExtraBlock 抛错,主线程一个追加词都没有
            const all = [...new Set(mine.concat(theirs).filter(extraWordOk))].slice(0, 500);
            if (!all.length) return;
            const r = applyExtraBlock(all);
            if (r.error) console.warn('[adult] 追加屏蔽词恢复失败(内置规则照常):' + r.error);
            else if (theirs.length && all.length !== mine.length) adminState.setBlockWords(r.words || all);
        }).catch((e) => warnOnce('syncExtraBlock', e));
    }
    // 启动时:资源站停用以 adult-admin.json(adminState)为准 —— 闸门出口、catalogSites 都按它;目录自己存的 admin:sites 覆盖跟着对齐。
    //   以前后台"启用"在目录那边没存上,会留下一个只有目录知道的停用(后台显示启用、目录一直停着),重启也不会自愈。
    //   逐个串行调,失败只记日志(下次重启再对齐);不等它(目录还没起来时 adminSite 自己会等 ensureReady)
    function syncSiteOverrides() {
        const cat = getCatalog();
        if (!cat || typeof cat.siteOverrides !== 'function' || typeof cat.adminSite !== 'function') return Promise.resolve();
        let theirs;
        try { theirs = cat.siteOverrides() || {}; } catch (e) { warnOnce('syncSiteOverrides', e); return Promise.resolve(); }
        const mine = typeof adminState.siteOverrides === 'function' ? (adminState.siteOverrides() || {}) : {};
        const jobs = [];
        for (const k of Object.keys(theirs)) if (!adminState.siteOff(k)) jobs.push([k, true]);
        for (const k of Object.keys(mine)) if (!Object.prototype.hasOwnProperty.call(theirs, k)) jobs.push([k, false]);
        if (!jobs.length) return Promise.resolve();
        return jobs.reduce((p, [k, on]) => p.then(() => Promise.resolve(cat.adminSite(k, on)).then((r) => {
            if (r && r.ok === false && r.reason !== 'unknown') warnOnce('syncSiteOverrides', new Error(k + ': ' + String(r.reason || 'failed')));
        }, (e) => warnOnce('syncSiteOverrides', e))), Promise.resolve()).catch((e) => warnOnce('syncSiteOverrides', e));
    }
    // 存下来的单个追加词是否合法(policy 有 extraWordOk 就按它;否则至少是 2..40 字的字符串)
    function extraWordOk(w) {
        if (typeof w !== 'string') return false;
        try { if (typeof policy.extraWordOk === 'function') return !!policy.extraWordOk(w); } catch (_) { return false; }
        const n = [...w.trim()].length;
        return n >= 2 && n <= 40;
    }
    // 后台存的追加词:建闸门时就先设到主线程 policy(第一个请求进来之前;坏词单独丢掉,其余照样生效)
    {
        const w0 = (adminState.blockWords() || []).filter(extraWordOk);
        if (w0.length && typeof policy.setExtraBlock === 'function') {
            try { policy.setExtraBlock(w0); } catch (e) { console.warn('[adult] 追加屏蔽词恢复失败(内置规则照常):' + ((e && e.message) || e)); }
        }
    }
    let p4ctxMemo = null;
    function p4ctx() {
        if (p4ctxMemo) return p4ctxMemo;
        p4ctxMemo = {
            env, adult, getCatalog, sitesOf, configuredSites, nameOk, titleAvdbOk, queryBlocked, checkRaw, avdbPolOf, lineName, warnOnce,
            perMinute, beaconBody, adminState, getMirror, isHidden, refreshHidden, applyExtraBlock, clientKey, ephemeralSecret,
            tokenKey: (req) => { const t = readToken(req); return authRequired() && ownToken(t) ? hashId('k|' + t) : ''; },
            // 复核 r3:一人一个的令牌(机场 v2board 用户)→ 热度扇出上限按人算(routes-p4 POST heat);共享访问密码的令牌认不出人 → ''
            personKey: (req) => { const t = readToken(req); return authRequired() && ownToken(t) && /^v2board_/.test(t) ? hashId('u|' + t) : ''; },
            publicDir: deps.publicDir || path.join(__dirname, '..', '..', 'public'),
        };
        return p4ctxMemo;
    }

    // ---------- 一次挂好(server.js 在通用限流/搜索限流之后、所有业务路由之前调用) ----------
    let warnedOpen = false;
    function register(app) {
        if (!authConfigured() && !warnedOpen) {
            warnedOpen = true;
            if (apiRequireAuth) console.warn('[adult] ⚠️ API_REQUIRE_AUTH=1 但没有配置 ACCESS_PASSWORD:没人拿得到令牌,搜索/详情/目录等内容接口对所有人 401');
            else console.warn('[adult] ⚠️ 没有配置 ACCESS_PASSWORD:搜索/详情/目录等内容接口对所有人开放,只靠年龄确认 Cookie(成人站强烈建议设访问密码;设 API_REQUIRE_AUTH=1 可强制要令牌)');
        }
        app.use((req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex'); next(); });
        registerOff(app);
        app.use(CONTENT_PATHS, requireAuth);
        app.use(['/api/auth/verify', '/api/auth/v2board', '/api/auth/qr/poll'], loginCookieTap);
        app.post('/api/auth/logout', logout);
        app.get('/api/history/pull', jsonFilter((b) => (b && Array.isArray(b.history)) ? Object.assign({}, b, { history: b.history.filter(h => h && storedReadOk(h.data)) }) : b));
        app.post('/api/history/push', (req, res, next) => {
            const b = req.body;
            if (b && typeof b === 'object' && Array.isArray(b.history)) b.history = b.history.filter(h => !h || typeof h !== 'object' || storedItemOk(h.data));
            next();
        });
        app.get('/api/popular', jsonFilter((b) => (b && Array.isArray(b.items)) ? Object.assign({}, b, { items: b.items.filter(x => x && nameOk(x.title) && titleAvdbOk(x.title)) }) : b));
        app.get('/api/favorites', jsonFilter((b) => (b && Array.isArray(b.items)) ? Object.assign({}, b, { items: b.items.filter(x => x && storedReadOk(x.data)) }) : b));
        app.post('/api/favorites/add', (req, res, next) => {
            const it = req.body && typeof req.body === 'object' ? req.body.item : null;
            if (it && typeof it === 'object' && !storedReadOk(it)) return res.status(400).json({ ok: false, error: 'item' });
            next();
        });
        // [adult] p4:后台停用的站也不列;有镜像在用的站报当前地址
        app.get('/api/sites', jsonFilter((b) => (b && Array.isArray(b.sites)) ? Object.assign({}, b, { sites: b.sites.filter(s => s && s.active !== false && !(typeof s.key === 'string' && adminState.siteOff(s.key))).map(siteForClient) }) : b));
        app.get('/api/search', searchGet);
        app.post('/api/search', searchPost);
        app.get('/api/detail', detailGet);
        app.post('/api/detail', detailPost);
        registerCatalog(app);
        registerImg(app);
        routesP4.registerAdmin(app, p4ctx());   // [adult] p4:成人站后台(/admin/adult + /api/adult/admin/*;ADULT_ADMIN_TOKEN / ADMIN_TOKEN 都没配 = 404)
        syncExtraBlock();
        syncSiteOverrides();
        logFn(`[adult] 内容闸门已挂载 · 规则 ${RV} · 关闭: ${Object.keys(off).filter(k => off[k]).join('/') || '无'} · TMDB 恒关`);
    }

    return {
        register, requireAuth, loginCookieTap, logout, jsonFilter, configFields,
        searchGet, searchPost, detailGet, detailPost,
        checkRaw, nameOk, storedItemOk, storedReadOk, makePlan, gateFor, relevant, fanout, identity, imgCacheDir,
        off, RULES_VERSION: RV,
        // [adult] p4
        sitesOf, isHidden, refreshHidden, siteOff: (k) => adminState.siteOff(k), applyExtraBlock, adminState,
    };
}

// ---------- Vercel(api/index.js):只留外壳接口 ----------
// 无状态函数没有 sqlite 目录、没有服务端令牌表(机场令牌只活在 server.js 进程内存),鉴权与审核无法与 server.js 对齐:
//   搜索/详情/目录/规则站 → 503;TMDB/预览 → 404;弹幕按 DANMAKU_DISABLE;/api/config 补成人站字段。其余(站点表/测速/登录)照旧。
function vercelGuard(opts) {
    const o = opts || {};
    const env = o.env || process.env;
    const off = offFlags(withAdultDefaults(env));
    const RV = o.adult && o.adult.RULES_VERSION;
    if (typeof RV !== 'string') throw new Error('[adult-gate] 缺少 lib/adult,拒绝启动');
    const BLOCK = /^\/api\/(search|detail|catalog|kz)(\/|$)/;
    const GONE = /^\/api\/(tmdb-proxy|tmdb-image|preview)(\/|$)/;
    return (req, res, next) => {
        const p = req.path || '';
        if (BLOCK.test(p)) { res.set('Cache-Control', 'no-store'); return res.status(503).json({ error: 'ADULT_VERCEL_UNSUPPORTED' }); }
        if (GONE.test(p)) { res.set('Cache-Control', 'no-store'); return res.status(404).json({ error: 'NOT_AVAILABLE' }); }
        if (off.danmaku && /^\/api\/danmaku(\/|$)/.test(p)) {
            res.set('Cache-Control', 'no-store');
            return res.json(req.method === 'GET' ? { code: 0, version: 3, data: [], msg: '' } : { code: 0, msg: '' });
        }
        if (p === '/api/config') {
            const orig = res.json;
            res.json = function (b) {
                const extra = { adult: true, catalog: false, age_gate: true, site_name: String(env.SITE_NAME || 'MEI.NU').slice(0, 40), rules_version: RV, tmdb_api_key: null, tmdb_proxy_url: null, intro_enabled: false, vercel_unsupported: true };
                if (off.danmaku) extra.danmaku_enabled = false;
                return orig.call(this, (b && typeof b === 'object') ? Object.assign({}, b, extra) : b);
            };
        }
        next();
    };
}

module.exports = {
    createAdultGate, vercelGuard, applyAdultEnvDefaults, applyAdultProxyEnv, withAdultDefaults, offFlags,
    parseCookies, readToken, ageConfirmed, isHttps, tokenCookie, clearTokenCookie, parseDur, routeBucket, variantOf,
    trustedClientNet, clientKeyOf, isCdnAddr, netKeyOf, normIp, ipHeaderOf,
    ADULT_ENV_DEFAULTS, COOKIE_NAME, AGE_COOKIE, COOKIE_MAX_AGE, CONTENT_PATHS,
};
