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
//   · 关掉的功能:TMDB(代理/图片/分享预览/SEO 页/站点地图)恒 404;推送/求片/片头学习/弹幕 由 *_DISABLE 控制,本分支默认关。
//   · CORS 代理只用成人版自己的 Worker:ADULT_CORS_PROXY_URL(设了就覆盖 CORS_PROXY_URL);只配了 CORS_PROXY_URL 的(多半是从主站拷来的 .env,
//       指向主站 Worker)一律忽略 —— 否则成人站的资源站请求、代理记忆都会记在主站的 Worker 账号上(见 applyAdultProxyEnv)
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
const CONTENT_PATHS = ['/api/search', '/api/detail', '/api/check', '/api/sites', '/api/catalog', '/api/popular', '/api/kz'];
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

    const sitesOf = () => { try { return (deps.allSites && deps.allSites()) || []; } catch (e) { warnOnce('allSites', e); return []; } };
    const getCatalog = () => { try { return deps.catalog ? (deps.catalog() || null) : null; } catch (e) { return null; } };
    const kz = () => { try { return deps.kazumi ? deps.kazumi() : null; } catch (e) { return null; } };
    const isKz = (site) => { const k = kz(); try { return !!(k && site && k.isKzSite(site)); } catch (e) { return false; } };
    const profOf = (s) => { try { return deps.profOf ? deps.profOf(s) : undefined; } catch (e) { return undefined; } };
    const ownToken = (t) => { try { return !!(t && deps.ownToken && deps.ownToken(t)); } catch (e) { return false; } };
    const banned = (t) => { try { return !!(deps.isBanned && deps.isBanned(t)); } catch (e) { return false; } };
    // 判不出来 = 当作配了(宁可多拦)
    const authConfigured = () => { try { return !!deps.authConfigured(); } catch (e) { return true; } };
    // API_REQUIRE_AUTH=1(规格 §1):内容接口一律要有效令牌,不管配没配访问密码;没配密码 = 谁都拿不到令牌 = 全部 401(fail-closed,启动时告警)
    const apiRequireAuth = envOn(env, 'API_REQUIRE_AUTH');
    const authRequired = () => apiRequireAuth || authConfigured();
    const cacheGet = (c, k) => { try { return deps.cache ? deps.cache.get(c, k) : null; } catch (e) { return null; } };
    const cacheSet = (c, k, v, t) => { try { if (deps.cache) deps.cache.set(c, k, v, t); } catch (e) { } };
    const ipOf = (req) => { try { return deps.ipKey ? deps.ipKey(req) : (req.ip || ''); } catch (e) { return ''; } };
    async function fetchJson(site, url, timeout) {
        let data = await deps.fetchJson(site, url, timeout);
        if (typeof data === 'string') { try { data = JSON.parse(data.replace(/^\uFEFF/, '')); } catch (e) { data = null; } }
        return data && typeof data === 'object' ? data : null;
    }

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
            const codeOk = title.codeOk(parsed, { siteTrust });
            const r = policy.checkItem(item, { parentName: (info && info.parentName) || '', codeOk, siteTrust });
            const out = Object.assign({ parsed, codeOk, siteTrust }, r);
            if (!r.ok) return out;
            if (info && (info.review === 'hide' || (info.review === 'code' && !codeOk))) return Object.assign(out, { ok: false, reason: 'review:class' });
            if (dropBuckets.has(r.bucket)) return Object.assign(out, { ok: false, reason: 'bucket:' + r.bucket });
            return out;
        } catch (e) {
            warnOnce('checkRaw', e);
            return { ok: false, reason: 'error' };
        }
    }
    const emitOk = (site, m) => checkRaw(site, m).ok;
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
    function storedItemOk(d, depth) {
        const dep = depth | 0;
        if (d == null || d === '') return true;
        if (dep > 3) return false;   // 套娃太深:不放行(fail-closed),也防递归爆栈
        // 字符串(客户端把整条 JSON 塞成字符串):能解析成对象/数组/字符串就按那个查,否则当片名查 —— 不能因为"不是对象"就跳过片名过滤
        if (typeof d === 'string') {
            let j;
            try { j = JSON.parse(d); } catch (_) { j = undefined; }
            if (j !== null && (typeof j === 'object' || (typeof j === 'string' && j !== d))) return storedItemOk(j, dep + 1);
            return nameOk(d.slice(0, 400));
        }
        if (Array.isArray(d)) return d.slice(0, 60).every((x) => storedItemOk(x, dep + 1));
        if (typeof d !== 'object') return true;   // 数字/布尔:没有可露的文字
        const g = d.groupData && typeof d.groupData === 'object' ? d.groupData : null;
        const srcs = g && Array.isArray(g.sources) ? g.sources : (Array.isArray(d.sources) ? d.sources : []);
        const firstType = (srcs.find(s => s && s.type_name) || {}).type_name || d.type_name || '';
        if (!nameOk(d.name, firstType)) return false;
        if (g && g.name && g.name !== d.name && !nameOk(g.name, firstType)) return false;
        for (const s of srcs.slice(0, 60)) if (s && typeof s === 'object' && s.vod_name && !nameOk(s.vod_name, s.type_name)) return false;
        return true;
    }

    // ---------- 作品身份 ----------
    function identity(item, chk) {
        const p = chk.parsed || {};
        let wk = title.workKey(p, { siteTrust: chk.siteTrust });
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
        return sv.kind === 'code' ? { kind: 'code', key: sv.key, variants: sv.variants.slice(0, 2), raw: String(q) } : { kind: 'text', variants: sv.variants.slice(0, 2), raw: String(q) };
    }
    // 闸门只由发出去的这一个写法决定(同一写法不管来自哪个查询,结论都一样 → 能和结果一起缓存)
    function gateFor(kw) {
        const sv = title.searchVariants(kw);
        if (sv && sv.kind === 'code') return { kind: 'code', key: sv.key };
        const toks = String(kw).split(/\s+/).filter(Boolean);
        return { kind: 'text', toks: toks.map(t => title.titleKey(t)).filter(Boolean), ctoks: toks.map(compact).filter(Boolean) };
    }
    function relevant(g, it, parsed) {
        if (!g) return true;
        // 番号查询:键相等之外还要不是"可疑番号"(假番号站给国产/动漫/欧美片硬塞 [CODE] 前缀,键能撞上但不是这部片)
        if (g.kind === 'code') return !!(parsed && parsed.key && parsed.key === g.key && (!parsed.suspect || parsed.placeholder));   // 占位番号(JUL-123)照常返回,身份按片名分组
        const fields = [it.vod_name, it.vod_sub, it.vod_actor].filter(f => f != null && f !== '');
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
            const ck = `adult:${RV}:${site.key}_${kw}`;
            const cached = cacheGet('search', ck);
            let list = cached && Array.isArray(cached.list) ? cached.list : null;
            if (!list) {
                let data;
                try { data = await fetchJson(site, `${site.api}?ac=detail&wd=${encodeURIComponent(kw)}`, 8000); }
                catch (e) { warnOnce('search:' + site.key, e); continue; }
                await classP;   // 分类图到了再过滤(拉不到也照走:只是少了父分类这一层)
                const raw = data && Array.isArray(data.list) ? data.list : [];
                const g = gateFor(kw);
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
    const withSite = (site, m) => Object.assign({}, m, { site_key: site.key, site_name: site.name, site_profile: profOf(site) });

    // GET /api/search?wd=&stream=true|…[&site_key=]
    async function searchGet(req, res) {
        const keyword = typeof req.query.wd === 'string' ? req.query.wd : '';
        const stream = req.query.stream === 'true';
        if (!keyword.trim()) return res.status(400).json({ error: 'Missing keyword' });
        const plan = queryBlocked(keyword) ? null : makePlan(keyword);   // 查询硬拦:不打任何资源站
        if (!stream) {
            if (!plan) return res.json({ list: [] });
            const sites = sitesOf();
            const sk = typeof req.query.site_key === 'string' ? req.query.site_key : '';
            const targets = sk ? sites.filter(s => s && s.key === sk && (isKz(s) || s.api)) : fanout(sites, plan);
            const all = [];
            await Promise.all(targets.map(async (site) => {
                let list = [];
                try { list = await siteSearch(site, plan); } catch (e) { warnOnce('search', e); }
                for (const m of list) if (emitOk(site, m)) all.push(withSite(site, m));
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
            for (const m of list) {
                const gk = site.key + '_' + (m && m.vod_id);
                if (sent.has(gk) || !emitOk(site, m)) continue;   // 出口再查一遍
                sent.add(gk);
                items.push(withSite(site, m));
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
        try { res.json({ list: (await siteSearch(site, plan)).filter(m => emitOk(site, m)) }); }
        catch (e) { warnOnce('searchPost', e); res.status(500).json({ error: 'Search failed' }); }
    }

    // ---------- 详情 ----------
    async function loadDetail(site, id, nocache) {
        if (isKz(site)) {
            const r = await kz().detail(site.key, id, nocache ? { fresh: true } : undefined);
            const d = r && Array.isArray(r.list) ? r.list[0] : null;
            return d && checkRaw(site, d).ok ? d : null;
        }
        if (!site.api) return null;
        const classP = ensureClassMap(site);
        const ck = `adult:${RV}:${site.key}_detail_${id}`;
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
    // GET /api/detail?id=&site_key=[&nocache=1] → {list:[detail]};被拦/没有 → 404
    async function detailGet(req, res) {
        const site = sitesOf().find(s => s && s.key === req.query.site_key);
        if (!site) return res.status(404).json({ error: 'Site not found' });
        if (!idOk(req.query.id)) return res.status(404).json({ error: 'Not found', list: [] });
        try {
            const d = await loadDetail(site, String(req.query.id), req.query.nocache === '1');
            if (!d) return res.status(404).json({ error: 'Not found', list: [] });
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
            if (!d) return res.status(404).json({ error: 'Not found' });
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
    const cardOk = (c) => !!c && typeof c === 'object' && nameOk(c.name, '', c.bucket);
    let homeMemo = null;
    function filterHome(h) {
        if (!h || typeof h !== 'object' || !Array.isArray(h.rows)) return { generatedAt: (h && h.generatedAt) || 0, rows: [] };
        if (homeMemo && homeMemo.src === h && homeMemo.at === h.generatedAt) return homeMemo.out;
        const out = Object.assign({}, h, { rows: h.rows.filter(r => r && typeof r === 'object').map(r => Object.assign({}, r, { items: (Array.isArray(r.items) ? r.items : []).filter(cardOk) })) });
        homeMemo = { src: h, at: h.generatedAt, out };
        return out;
    }
    function filterPage(r, page) {
        if (!r || typeof r !== 'object') return { page, total_pages: 0, total_results: 0, results: [] };
        return Object.assign({}, r, { results: (Array.isArray(r.results) ? r.results : []).filter(cardOk) });
    }
    function browseQuery(q) {
        const pick = (v, ok, d) => (typeof v === 'string' && ok.indexOf(v) >= 0) ? v : d;
        // 没给 = '';给了但不合法(../../etc、数组…)→ '!bad':交给目录 normBrowse 判 bad 回空页,不能悄悄变成"全部分区"
        const word = (v) => (v == null || v === '') ? '' : ((typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v)) ? v : '!bad');
        return {
            b: word(q.b), tag: word(q.tag),
            sort: pick(q.sort, ['new', 'dur', 'random', 'lines'], 'new'),
            dur: pick(q.dur, ['', 's', 'm', 'l'], ''),
            flag: pick(q.flag, ['', 'zh', 'unc', 'multi'], ''),
            page: Math.min(500, Math.max(1, parseInt(q.page, 10) || 1)),
        };
    }
    // 线路补上站名/档案;不在站点表里(停用/删除)的线路、片名被拦的线路丢掉;片名被拦或一条线路都不剩 → null(404)
    function filterGroup(g) {
        if (!g || typeof g !== 'object' || !nameOk(g.name, '', g._meta && g._meta.bucket)) return null;
        const byKey = new Map(sitesOf().filter(s => s && s.key).map(s => [s.key, s]));
        const sources = [];
        for (const s of (Array.isArray(g.sources) ? g.sources : [])) {
            if (!s || typeof s !== 'object') continue;
            const site = byKey.get(s.site_key);
            if (!site || !checkRaw(site, { vod_name: s.vod_name, type_name: s.type_name }).ok) continue;
            sources.push(Object.assign({}, s, { site_name: site.name, site_profile: profOf(site) }));
        }
        return sources.length ? Object.assign({}, g, { sources }) : null;
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
            const out = filterGroup(await cat.work(k, { expand }));
            if (!out) { res.set('Cache-Control', 'no-store'); return res.status(404).json({ error: 'NOT_FOUND' }); }
            res.set('Cache-Control', expand ? 'no-store' : 'private, max-age=60');
            res.json(out);
        }));
    }

    // ---------- /api/config 附加字段(放在原对象最后,覆盖同名键) ----------
    function configFields() {
        const o = {
            adult: true, catalog: !!getCatalog(), age_gate: true,
            site_name: String(env.SITE_NAME || 'DGX').slice(0, 40),
            auth_required: authRequired(), rules_version: RV,
            tmdb_api_key: null, tmdb_proxy_url: null,   // 前端不许直连 TMDB
            intro_enabled: !off.intro,
        };
        if (off.danmaku) o.danmaku_enabled = false;
        if (off.requests) o.requests_enabled = false;
        if (off.push) o.push_enabled = false;
        return o;
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
        app.get('/api/history/pull', jsonFilter((b) => (b && Array.isArray(b.history)) ? Object.assign({}, b, { history: b.history.filter(h => h && storedItemOk(h.data)) }) : b));
        app.post('/api/history/push', (req, res, next) => {
            const b = req.body;
            if (b && typeof b === 'object' && Array.isArray(b.history)) b.history = b.history.filter(h => !h || typeof h !== 'object' || storedItemOk(h.data));
            next();
        });
        app.get('/api/popular', jsonFilter((b) => (b && Array.isArray(b.items)) ? Object.assign({}, b, { items: b.items.filter(x => x && nameOk(x.title)) }) : b));
        app.get('/api/favorites', jsonFilter((b) => (b && Array.isArray(b.items)) ? Object.assign({}, b, { items: b.items.filter(x => x && storedItemOk(x.data)) }) : b));
        app.post('/api/favorites/add', (req, res, next) => {
            const it = req.body && typeof req.body === 'object' ? req.body.item : null;
            if (it && typeof it === 'object' && !storedItemOk(it)) return res.status(400).json({ ok: false, error: 'item' });
            next();
        });
        app.get('/api/sites', jsonFilter((b) => (b && Array.isArray(b.sites)) ? Object.assign({}, b, { sites: b.sites.filter(s => s && s.active !== false) }) : b));
        app.get('/api/search', searchGet);
        app.post('/api/search', searchPost);
        app.get('/api/detail', detailGet);
        app.post('/api/detail', detailPost);
        registerCatalog(app);
        logFn(`[adult] 内容闸门已挂载 · 规则 ${RV} · 关闭: ${Object.keys(off).filter(k => off[k]).join('/') || '无'} · TMDB 恒关`);
    }

    return {
        register, requireAuth, loginCookieTap, logout, jsonFilter, configFields,
        searchGet, searchPost, detailGet, detailPost,
        checkRaw, nameOk, storedItemOk, makePlan, gateFor, relevant, fanout, identity,
        off, RULES_VERSION: RV,
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
                const extra = { adult: true, catalog: false, age_gate: true, site_name: String(env.SITE_NAME || 'DGX').slice(0, 40), rules_version: RV, tmdb_api_key: null, tmdb_proxy_url: null, intro_enabled: false, vercel_unsupported: true };
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
    ADULT_ENV_DEFAULTS, COOKIE_NAME, AGE_COOKIE, COOKIE_MAX_AGE, CONTENT_PATHS,
};
