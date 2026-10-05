// Kazumi 规则站(7sefun / DM84 …)的服务端适配层:对前端伪装成普通 maccms 资源站。
//
// 公共 API(server.js 与 api/index.js 共用同一模块,避免两后端漂移):
//   getSites(opts?)                 → [{key,name,kazumi:true,active:true,api:''}]   (KAZUMI_DISABLE / KAZUMI_SITES 控制)
//   isKzSite(site)                  → boolean
//   search(siteKey, keyword, orig?) → {list:[maccms 形条目 + _kz/_gk/_season/_kind]}
//   detail(siteKey, vid, {fresh}?)  → {list:[maccms 形详情]},vod_play_url 里的集地址是同源【相对】/api/kz/ep/...
//   resolve(siteKey, tok, {fresh})  → {type:'hls'|'mp4', url, expiresAt(ms)|null, road:sid}   (带线路回退)
//   playlist(siteKey, tok)          → 绝对化后的 m3u8 文本(master 自动拍平到最高码率)
//   registerRoutes(app)             → /api/kz/ep|m3u8|mp4(m3u8 在重解析变成 mp4 时回 409 {type:'mp4',url};失败 502 只给泛化文案)
//                                     必须在 server.js 的 app.use(apiLimiter) 之后注册,api/index.js 同理
//   check(siteKey)                  → {latency}(只 GET 站点首页,绝不碰媒体)
//   titleKey / coreKeyword          → 来自 kz-titlematch.js
//
// 数据流:规则 JSON 的 Kazumi 原生字段(searchList/searchName/searchResult/chapterRoads/chapterResult)经 rule-xpath
// 驱动搜索与详情;"dg" 扩展块补上 Kazumi 靠 WebView 才拿到的东西(解析器、ID 提取、封面/年份/线路名)。
'use strict';

const fs = require('fs');
const path = require('path');
const X = require('./rule-xpath');
const R = require('./resolvers');
const T = require('./titlematch');

// 内置规则用静态 require(Vercel nft 能追踪到);rules/ 目录里额外放的 *.json 运行时再扫一遍
const BUILTIN = { '7sefun.json': require('./rules/7sefun.json'), 'dm84.json': require('./rules/dm84.json') };

const HOUR = 3600 * 1000;
const RESOLVE_MAX_TTL = 10 * 60 * 1000;
const EXPIRY_MARGIN = 90 * 1000;
const PLAYLIST_TTL = 60 * 1000;      // 清单文本微缓存:resolve 时已预取过,紧接着的 /api/kz/m3u8 直接用,不再打上游
const FRESH_GAP = 15 * 1000;         // 同一集 ?fresh=1 最多每 15 秒生效一次(否则任何人都能让我们反复跑整条上游解析链)
const FALLBACK_BUDGET = 25 * 1000;   // 线路回退总预算:超过就不再开新尝试,别让 /api/kz/ep 挂一分钟
const TOK_RE = /^(\d+)-(\d+)-(\d+)$/;

// 与 server.js envFlag 同语义:'' / 0 / false / no / off(大小写不敏感)为假,其余非空为真
function envFlag(name, env) {
    const v = String(((env || process.env)[name]) == null ? '' : (env || process.env)[name]).trim().toLowerCase();
    return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

// ---------- 规则加载 ----------
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function compileSite(rule) {
    const dg = rule.dg || {};
    if (!dg.key || !/^kz_[a-z0-9_]+$/.test(dg.key) || !dg.resolver || !R.RESOLVERS[dg.resolver]) return null;   // 没有解析器的规则不暴露(搜得到却播不了)
    if (typeof dg.vidFrom !== 'string' || typeof dg.playPath !== 'string') return null;   // 缺 ID 提取规则:new RegExp(undefined) 会匹配一切
    if (!Object.prototype.hasOwnProperty.call(R.RESOLVERS, dg.resolver)) return null;     // "constructor" 之类原型键不算解析器
    const base = String(rule.baseURL || '').replace(/\/+$/, '');
    // playPath "/vodplay/{vid}-{sid}-{nid}.html" → 从集链接 href 反解 vid/sid/nid 的正则
    const order = [];
    const playRe = new RegExp(escRe(dg.playPath).replace(/\\\{(vid|sid|nid)\\\}/g, (m, k) => { order.push(k); return '(\\d+)'; }) + '(?:$|[?#])');
    return {
        key: dg.key, name: dg.name || rule.name, rule, dg, base,
        vidRe: new RegExp(dg.vidFrom), playRe, playOrder: order,
        kwMax: dg.kwMax || 0,
        ua: rule.userAgent || '',
    };
}
/**
 * 规则表 {文件名: 规则对象} → Map(key → 编译后的站点)。
 * 每条规则单独 try:额外放进 rules/ 的 JSON 只要有一个正则写坏(vidFrom/playPath)或结构不对,
 * 以前 compileSite 抛错会让 loadSites 整个抛出 → getSites() 抛 → server.js 合并站点列表处炸掉,内置站也一起消失。
 */
function buildSites(rules) {
    const m = new Map();
    for (const f of Object.keys(rules || {})) {
        let s = null;
        try { s = compileSite(rules[f] || {}); } catch (e) { console.warn('[Kazumi] 规则编译失败,已跳过', f, e && e.message); continue; }
        if (s && !m.has(s.key)) m.set(s.key, s);
    }
    return m;
}
let SITES = null;
function loadSites() {
    if (SITES) return SITES;
    const rules = Object.assign({}, BUILTIN);
    try {
        const dir = path.join(__dirname, 'rules');
        for (const f of fs.readdirSync(dir)) {
            if (!/\.json$/i.test(f) || rules[f]) continue;
            try { rules[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { console.warn('[Kazumi] 规则解析失败', f, e.message); }
        }
    } catch (e) { /* Vercel 打包后目录可能不可枚举:只用内置 */ }
    // 兜底:无论如何 SITES 都要落定(哪怕是空表),否则每次 getSites() 都会重跑并重复抛错
    try { SITES = buildSites(rules); } catch (e) { console.warn('[Kazumi] 规则加载失败', e && e.message); SITES = new Map(); }
    return SITES;
}

function enabledSites(env) {
    if (envFlag('KAZUMI_DISABLE', env)) return [];
    const all = [...loadSites().values()];
    const wl = String(((env || process.env).KAZUMI_SITES) || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        .map((s) => (s.startsWith('kz_') ? s : 'kz_' + s));
    return wl.length ? all.filter((s) => wl.includes(s.key)) : all;
}
function getSites(opts) {
    return enabledSites(opts && opts.env).map((s) => ({ key: s.key, name: s.name, kazumi: true, active: true, api: '' }));
}
// 只认显式 kazumi:true(getSites 产出的条目才带)。不按 'kz_' 键前缀判断:db.json / 远程 maccms 源的 key 恰好以 kz_ 开头时
// 必须仍走 maccms;db.json 里与内置同 key 的条目会覆盖内置站(server.js 合并时 have.has 跳过内置),那它就是普通 maccms 站。
function isKzSite(site) { return !!(site && site.kazumi === true); }
function siteOf(siteKey) {
    const s = enabledSites().find((x) => x.key === siteKey);
    if (!s) throw new Error('unknown kazumi site: ' + siteKey);
    return s;
}

// ---------- 小工具 ----------
// 带 TTL 的模块内缓存(插入序淘汰,够用;Vercel 冷启动即清空,可接受)
function ttlCache(max) {
    const m = new Map();
    return {
        get(k) { const e = m.get(k); if (!e) return undefined; if (e.exp <= Date.now()) { m.delete(k); return undefined; } return e.v; },
        // ttl<=0(如签名地址已临近过期)时也要删掉旧条目:否则 ?fresh=1 换来的新结果存不进去,旧的坏地址继续被命中
        set(k, v, ttl) { m.delete(k); if (!(ttl > 0)) return; m.set(k, { v, exp: Date.now() + ttl }); while (m.size > max) m.delete(m.keys().next().value); },
        delete(k) { m.delete(k); },
        clear() { m.clear(); },
    };
}
const searchCache = ttlCache(400);
const detailCache = ttlCache(300);
const resolveCache = ttlCache(1000);
const playlistCache = ttlCache(200);   // 键 = 解析出的 hls 地址(线路回退后真实地址可能属于另一个 tok)
const lastFresh = new Map();
/** fresh 节流:同一 site|tok 在 FRESH_GAP 内只放行一次;返回是否放行 */
function allowFresh(ck) {
    const now = Date.now(), t = lastFresh.get(ck);
    if (t && now - t < FRESH_GAP) return false;
    lastFresh.delete(ck); lastFresh.set(ck, now);
    while (lastFresh.size > 2000) lastFresh.delete(lastFresh.keys().next().value);
    return true;
}
const inflight = new Map();
function dedupe(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

const ZW = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
/** 展示名归一:去零宽、折叠空白、去掉"中文 第"之间的空格(DM84 "葬送的芙莉莲 第二季" → maccms 惯例 "葬送的芙莉莲第二季") */
function normName(s) {
    return String(s == null ? '' : s).replace(ZW, '').replace(/\s+/g, ' ').trim()
        .replace(/([㐀-鿿豈-﫿])\s+(?=第)/g, '$1');
}
function absUrl(site, u) {
    u = String(u || '').trim();
    if (!u || u === '/' || /^(data|javascript):/i.test(u)) return '';
    try { return new URL(u, site.base + '/').href; } catch (e) { return ''; }
}
function headers(site) { return site.ua ? { 'User-Agent': site.ua } : {}; }

// 封面:懒加载属性优先(data-original / data-bg / data-src),最后才 src
function coverOf(site, node, xpathAttr) {
    if (!node) return '';
    const cands = [xpathAttr, X.attr(node, 'data-original'), X.attr(node, 'data-bg'), X.attr(node, 'data-src'), X.attr(node, 'src')];
    for (const c of cands) { const u = absUrl(site, c); if (u) return u; }
    return '';
}

// dg.detail 字段取值:"re:<正则>" 对原始 HTML 取第 1 组(去标签+反转义);否则当 XPath(末步 @attr 取属性,否则取文本)
function fieldOf(spec, html, root) {
    if (!spec) return '';
    if (spec.startsWith('re:')) {
        const m = new RegExp(spec.slice(3)).exec(html);
        return m ? R.decodeEntities(String(m[1] == null ? m[0] : m[1]).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
    }
    try { return X.evalString(root, spec).replace(/\s+/g, ' ').trim(); } catch (e) { return ''; }
}

// ---------- 搜索 ----------
function buildSearchUrl(site, kw) { return String(site.rule.searchURL).split('@keyword').join(X.encodeQueryComponent(kw)); }

function parseSearchHtml(site, html) {
    const root = X.parseHtml(html);
    const out = [], seen = new Set();
    for (const node of X.evaluate(root, site.rule.searchList).nodes) {
        const name = X.textOf(X.evaluate(root, site.rule.searchName, node).node).trim();
        const rn = X.evaluate(root, site.rule.searchResult, node).node;
        const href = rn ? String(X.attr(rn, 'href') || '').trim() : '';
        if (!name || !href) continue;   // Kazumi:名字或链接缺一即跳过(7sefun 的列表 XPath 会多匹配几个空壳节点)
        const m = site.vidRe.exec(href);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        let pic = '', remarks = '';
        if (site.dg.searchCover) {
            const c = X.evaluate(root, site.dg.searchCover, node);
            pic = coverOf(site, c.node, typeof c.attr === 'string' ? c.attr : null);
        }
        if (site.dg.searchRemarks) remarks = X.textOf(X.evaluate(root, site.dg.searchRemarks, node).node).replace(/\s+/g, ' ').trim();
        out.push({ vid: m[1], name, pic, remarks });
    }
    return out;
}

function toSearchItem(r) {
    const vod_name = normName(r.name);
    const p = T.parseTitle(vod_name, { remarks: r.remarks });
    return {
        vod_id: String(r.vid), vod_name, vod_pic: r.pic, vod_remarks: r.remarks, vod_year: '', type_name: '动漫',
        vod_content: '', vod_play_from: '', vod_play_url: '',
        _kz: 1, _gk: p.key, _season: p.season, _kind: p.kind,
    };
}

async function searchOnce(site, kw) {
    if (site.kwMax) kw = Array.from(kw).slice(0, site.kwMax).join('');   // 7sefun 只认前 10 字
    const ck = site.key + '|' + kw;
    const hit = searchCache.get(ck);
    if (hit) return hit;
    return dedupe('s|' + ck, async () => {
        const html = await R.getHtml(site, buildSearchUrl(site, kw), { headers: headers(site) });
        const list = parseSearchHtml(site, html).map(toSearchItem);
        searchCache.set(ck, list, list.length ? HOUR : 10 * 60 * 1000);   // 0 结果只缓存 10 分钟
        return list;
    });
}

/**
 * 关键词策略(两站都很小、对空格敏感、7sefun 截断 10 字):只发一个 coreKeyword;
 * 仅当 0 结果时最多再发一个回退词 —— 核心词前 4 字(核心词 >4 字时),否则原名(original)。从不发带季号的变体。
 */
async function search(siteKey, keyword, original) {
    const site = siteOf(siteKey);
    const kw0 = String(keyword == null ? '' : keyword).trim();
    if (!kw0) return { list: [] };
    const core = T.coreKeyword(kw0) || kw0;
    let list = await searchOnce(site, core);
    if (!list.length) {
        // 比较也按站点实际会发出的词(kwMax 截断后)来比:截断后与核心词相同就别再白打一次上游
        const cut = (s) => (site.kwMax ? Array.from(s).slice(0, site.kwMax).join('') : s);
        const chars = Array.from(core);
        let fb = null;
        if (chars.length > 4) fb = chars.slice(0, 4).join('');
        else if (original && String(original).trim()) {
            // 原名也必须过 coreKeyword:原名常带季号/副标题("葬送のフリーレン 第2期"),原样发出去两站都搜 0,
            // 违背"从不发带季号变体"的策略;coreKeyword 同时把长度压到 ≤10 字
            const o = String(original).trim();
            fb = T.coreKeyword(o) || '';
        }
        if (fb) fb = cut(fb);
        if (fb && fb !== cut(core)) list = await searchOnce(site, fb);
    }
    return { list: list.map((x) => Object.assign({}, x)) };
}

// ---------- 详情 ----------
function epNumStrict(name) { const m = /^第?\s*(\d+)\s*[话集話]?$/.exec(name); return m ? parseInt(m[1], 10) : null; }

function parseDetailHtml(site, vid, html) {
    const root = X.parseHtml(html);
    const roads = [];
    for (const roadNode of X.evaluate(root, site.rule.chapterRoads).nodes) {
        const eps = [], seen = new Set();
        X.evaluate(root, site.rule.chapterResult, roadNode).nodes.forEach((a, i) => {
            const href = String(X.attr(a, 'href') || '').trim();
            const m = href && site.playRe.exec(href);
            if (!m) return;
            const ids = {}; site.playOrder.forEach((k, j) => { ids[k] = m[j + 1]; });
            if (String(ids.vid) !== String(vid)) return;
            const tok = `${ids.vid}-${ids.sid}-${ids.nid}`;
            if (seen.has(tok)) return;
            seen.add(tok);
            // Kazumi:集名去掉全部空白;空名回退"第N集";纯数字名统一成"第N集"(进度键/跨源对齐与 maccms 一致)
            let name = X.textOf(a).replace(ZW, '').replace(/\s+/g, '').replace(/[$#]/g, '');
            if (!name) name = `第${i + 1}集`;
            else if (/^\d+$/.test(name)) name = `第${parseInt(name, 10)}集`;
            eps.push({ name, sid: +ids.sid, nid: +ids.nid, tok });
        });
        roads.push(eps);
    }
    // 线路名:dg.roadNames 取到的标签数与非空线路数一致才用,否则"线路N"
    const nonEmpty = roads.filter((r) => r.length);
    let labels = [];
    if (site.dg.roadNames) {
        try { labels = X.evaluate(root, site.dg.roadNames).nodes.map((n) => X.textOf(n).replace(/\s+/g, ' ').trim()); } catch (e) { labels = []; }
    }
    // 7sefun 的 chapterRoads 会多匹配到不含集的标题 div(空线路),所以优先按"非空线路序"对齐标签
    const labelFor = labels.length === nonEmpty.length ? (i, k) => labels[k]
        : labels.length === roads.length ? (i) => labels[i] : () => '';
    const out = [];
    roads.forEach((eps, i) => {
        if (!eps.length) return;
        const label = labelFor(i, out.length) || '';
        // 排序:集名全是"第N集/N话"时按集号升序(DM84 长篇是倒序列出),否则按 nid
        // e.num 另作线路回退时的"同一集"对齐键
        const nums = eps.map((e) => epNumStrict(e.name));
        const allNum = nums.every((n) => n != null);
        eps.forEach((e, k) => { e.num = allNum ? nums[k] : (X.extractEpisodeNumber(e.name) || null); });
        eps.sort(allNum ? (a, b) => (a.num - b.num) || (a.nid - b.nid) : (a, b) => a.nid - b.nid);
        out.push({ sid: eps[0].sid, label: label || `线路${out.length + 1}`, eps });
    });
    const d = site.dg.detail || {};
    const yearStr = fieldOf(d.year, html, root);
    let isMovie = false;
    if (d.movie) {
        try { isMovie = d.movie.startsWith('re:') ? new RegExp(d.movie.slice(3)).test(html) : X.evaluate(root, d.movie).nodes.length > 0; } catch (e) { }
    }
    let content = fieldOf(d.content, html, root);
    if (/^\[db:/.test(content)) content = '';   // 7sefun 的简介是未替换的模板占位符
    return {
        name: normName(fieldOf(d.name, html, root)),
        pic: absUrl(site, fieldOf(d.cover, html, root)),
        content, remarks: fieldOf(d.remarks, html, root),
        year: /^(19|20)\d{2}$/.test(yearStr) ? yearStr : '',
        type: isMovie ? (d.movieType || '电影') : '动漫',
        roads: out,
    };
}

function toDetailItem(siteKey, vid, d) {
    const roads = d.roads;
    return {
        vod_id: String(vid), vod_name: d.name, vod_pic: d.pic, vod_content: d.content, vod_remarks: d.remarks,
        vod_year: d.year, type_name: d.type,
        vod_play_from: roads.map((r) => r.label.replace(/\$/g, '')).join('$$$'),
        // 相对地址:多域名部署(domains.json)下历史记录跨域同步也不失效
        vod_play_url: roads.map((r) => r.eps.map((e) => `${e.name}$/api/kz/ep/${siteKey}/${e.tok}`).join('#')).join('$$$'),
        _kz: 1,
    };
}

async function detailData(site, vid, fresh) {
    const ck = site.key + '|' + vid;
    const hit = fresh ? undefined : detailCache.get(ck);
    if (hit) return hit;
    return dedupe('d|' + ck, async () => {
        const url = site.base + String(site.dg.detailPath).replace('{vid}', vid);
        const html = await R.getHtml(site, url, { headers: headers(site) });
        const d = parseDetailHtml(site, vid, html);
        detailCache.set(ck, d, d.roads.length ? HOUR : 10 * 60 * 1000);
        return d;
    });
}

// opts.fresh:跳过 1 小时详情缓存(对应 /api/detail?nocache=1 的"刷新选集")
async function detail(siteKey, vid, opts) {
    const site = siteOf(siteKey);
    vid = String(vid == null ? '' : vid).trim();
    if (!/^\d+$/.test(vid)) throw new Error('bad vid');
    const d = await detailData(site, vid, !!(opts && opts.fresh));
    return { list: [toDetailItem(site.key, vid, d)] };
}

// ---------- 解析(带线路回退) ----------
async function resolveRoad(site, vid, sid, nid) {
    const playUrl = site.base + String(site.dg.playPath).replace('{vid}', vid).replace('{sid}', sid).replace('{nid}', nid);
    const r = await R.RESOLVERS[site.dg.resolver]({ site, vid, sid, nid, playUrl });
    if (!r || !r.url || (r.type !== 'hls' && r.type !== 'mp4')) throw new Error('resolver returned no media');
    const out = { type: r.type, url: r.url, expiresAt: r.expiresAt || null, road: +sid };
    // hls 必须在这里就确认清单取得到:否则 /api/kz/ep 先答"hls",浏览器去拉 /api/kz/m3u8 时才发现上游 403(地区封锁),
    // 那时已无从回退。取不到即视为本线路失败,交给回退逻辑;取到的文本进微缓存,紧接着的 m3u8 请求直接用。
    if (out.type === 'hls') {
        const text = await fetchPlaylistText(out.url, 0);
        playlistCache.set(out.url, text, Math.min(PLAYLIST_TTL, ttlFor(out)));
    }
    return out;
}
function ttlFor(r) {
    if (!r.expiresAt) return RESOLVE_MAX_TTL;
    return Math.min(r.expiresAt - EXPIRY_MARGIN - Date.now(), RESOLVE_MAX_TTL);
}

/**
 * 请求的线路解析失败(异常 / hhjx "url 解密失败" / art.php 无 url / hls 清单取不到)时的回退顺序:
 *   1. maccms:同一条再试一次 —— art.php 在多个上游间轮换(实测同一集这次给地区封锁的 dytt-hot m3u8,下次给可用的字节 mp4)
 *   2. 详情里同一集(按集号,否则按位置)在其它线路上的条目,最多 3 条
 *   3. 同线路里同名的兄弟条目(DM84 电影常见一条线路挂两个"高清"互为镜像),最多 2 条
 * 全部失败时抛【第一次】的错误(最能说明问题),后缀列出试过的线路。
 */
async function resolveWithFallback(site, vid, sid, nid) {
    const t0 = Date.now();
    let firstErr;
    try { return await resolveRoad(site, vid, sid, nid); } catch (e) { firstErr = e; }
    // 排队超时说明该 host 已经堵住:回退的线路多半同 host,再试只会加剧拥堵
    if (firstErr && firstErr.code === 'EKZBUSY') throw firstErr;
    const tried = [];
    const attempt = async (s, n, tag) => {
        if (Date.now() - t0 > FALLBACK_BUDGET) return null;
        tried.push(tag);
        try {
            const res = await resolveRoad(site, vid, s, n);
            resolveCache.set(`${site.key}|${vid}-${s}-${n}`, res, ttlFor(res));
            return res;
        } catch (e) { return null; }
    };
    if (site.dg.resolver === 'maccms') {
        const res = await attempt(sid, nid, `${sid}(retry)`);
        if (res) return res;
    }
    let d = null;
    try { d = await detailData(site, vid); } catch (e) { }
    if (d) {
        const road = d.roads.find((r) => r.sid === +sid);
        const idx = road ? road.eps.findIndex((e) => e.nid === +nid) : -1;
        const ep = idx >= 0 ? road.eps[idx] : null;
        const num = ep ? ep.num : null;
        let n = 0;
        for (const r of d.roads) {
            if (r.sid === +sid) continue;
            let cand = num != null ? r.eps.find((e) => e.num === num) : null;
            if (!cand && idx >= 0) cand = r.eps[idx];
            if (!cand) continue;
            if (n++ >= 3) break;
            const res = await attempt(cand.sid, cand.nid, String(cand.sid));
            if (res) return res;
        }
        if (ep) {
            for (const sib of road.eps.filter((e) => e.nid !== ep.nid && e.name === ep.name).slice(0, 2)) {
                const res = await attempt(sib.sid, sib.nid, `${sib.sid}#${sib.nid}`);
                if (res) return res;
            }
        }
    }
    if (tried.length) firstErr.message = `${firstErr.message} (fallback ${tried.join(',')} also failed)`;
    throw firstErr;
}

async function resolveInternal(siteKey, tok, fresh) {
    const site = siteOf(siteKey);
    const m = TOK_RE.exec(String(tok || ''));
    if (!m) throw new Error('bad tok');
    const ck = site.key + '|' + tok;
    if (!fresh) {
        const hit = resolveCache.get(ck);
        if (hit) return { val: hit, cached: true };
    }
    const val = await dedupe('r|' + ck, async () => {
        const r = await resolveWithFallback(site, m[1], m[2], m[3]);
        resolveCache.set(ck, r, ttlFor(r));
        return r;
    });
    return { val, cached: false };
}

// opts.fresh 来自客户端(?fresh=1),按 site|tok 节流;被节流时退化为普通(可命中缓存)解析
async function resolve(siteKey, tok, opts) {
    const fresh = !!(opts && opts.fresh) && allowFresh(siteKey + '|' + tok);
    const r = await resolveInternal(siteKey, tok, fresh);
    return Object.assign({}, r.val);
}

// ---------- m3u8 ----------
function absolutizeM3u8(text, baseUrl) {
    const abs = (u) => { try { return new URL(u, baseUrl).href; } catch (e) { return u; } };
    return String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t[0] !== '#') return abs(t);
        return line.replace(/URI="([^"]*)"/g, (mm, u) => `URI="${abs(u)}"`);
    }).join('\n');
}

// master playlist:取 BANDWIDTH 最高的变体
function pickVariant(text, baseUrl) {
    const lines = String(text).split(/\r?\n/);
    let best = null;
    for (let i = 0; i < lines.length; i++) {
        if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
        const bw = +((/BANDWIDTH=(\d+)/i.exec(lines[i]) || [])[1] || 0);
        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || lines[j].trim()[0] === '#')) j++;
        if (j >= lines.length) break;
        if (!best || bw > best.bw) best = { bw, url: new URL(lines[j].trim(), baseUrl).href };
    }
    return best && best.url;
}

async function fetchPlaylistText(url, depth) {
    // 不带 Referer:hhjx /playlist、jimxtc、sviptq 实测都不需要;QQ/365yg 系还会因 Referer 拒绝
    const r = await R.getText(url, { timeout: 10000, maxBytes: 16 * 1024 * 1024 });
    if (r.status !== 200) throw new Error(`playlist HTTP ${r.status}`);
    const body = r.text.replace(/^\uFEFF/, '');
    if (!/^\s*#EXTM3U/.test(body)) throw new Error('not an m3u8');
    if (/#EXT-X-STREAM-INF/i.test(body)) {
        if (depth >= 2) throw new Error('nested master playlist');
        const v = pickVariant(body, r.url);
        if (!v) throw new Error('master playlist without variants');
        return fetchPlaylistText(v, depth + 1);
    }
    if (!/#EXTINF/i.test(body)) throw new Error('playlist has no #EXTINF');
    return absolutizeM3u8(body, r.url);   // 以重定向后的最终地址为基准(dytt-tvs → jimxtc 等相对分片)
}

const notHlsError = () => Object.assign(new Error('not hls'), { code: 'KZ_NOT_HLS' });
async function playlistOf(url) {
    const hit = playlistCache.get(url);
    if (hit) return hit;
    const text = await fetchPlaylistText(url, 0);
    playlistCache.set(url, text, PLAYLIST_TTL);
    return text;
}

async function playlist(siteKey, tok) {
    const r = await resolveInternal(siteKey, tok, false);
    if (r.val.type !== 'hls') throw notHlsError();
    try {
        return await playlistOf(r.val.url);
    } catch (e1) {
        // 缓存的地址可能已被上游作废 / 轮换到了不可达的上游:重解析一次(同样受 fresh 节流)。
        // 重解析失败时报【第一次】的错误("playlist HTTP 403" 比回退链末端的错误更说明问题)。
        if (!allowFresh(siteKey + '|' + tok)) throw e1;
        let r2;
        try { r2 = await resolveInternal(siteKey, tok, true); } catch (e2) { throw e1; }
        // 重解析换成了 mp4:resolveCache 已更新,下次 /api/kz/ep 会直接答 mp4;本次让路由回 409 指路
        if (r2.val.type !== 'hls') throw notHlsError();
        return playlistOf(r2.val.url);
    }
}

// ---------- 可达性 ----------
async function check(siteKey) {
    let site;
    try { site = siteOf(siteKey); } catch (e) { return { latency: 9999 }; }
    const t0 = Date.now();
    try {
        const r = await R.getText(site.base + '/', { timeout: 4000, headers: Object.assign({ Referer: site.base + '/' }, headers(site)), maxBytes: 2 * 1024 * 1024 });
        if (r.status >= 200 && r.status < 400) return { latency: Date.now() - t0 };
    } catch (e) { }
    return { latency: 9999 };
}

// ---------- 路由 ----------
function registerRoutes(app) {
    const known = (s) => enabledSites().some((x) => x.key === s);
    const bad = (res, msg) => res.status(404).set('Cache-Control', 'no-store').json({ error: msg });
    // 详细原因只进服务器日志;客户端只拿泛化文案 —— 上游给的地址若指向内网,原始报错(ECONNREFUSED 127.0.0.1:x)会变成端口扫描回显
    const fail = (res, e, where) => {
        console.warn(`[Kazumi] ${where} 失败:`, e && e.message);
        const busy = e && e.code === 'EKZBUSY';
        res.status(502).set('Cache-Control', 'no-store').json({ error: busy ? 'upstream busy' : 'upstream resolve failed' });
    };

    // 集地址 → {type, url(同源), road, expiresAt}
    app.get('/api/kz/ep/:site/:tok', async (req, res) => {
        const { site, tok } = req.params;
        if (!known(site) || !TOK_RE.test(tok)) return bad(res, 'bad site or tok');
        try {
            const r = await resolve(site, tok, { fresh: req.query.fresh === '1' });
            const url = r.type === 'hls' ? `/api/kz/m3u8/${site}/${tok}.m3u8` : `/api/kz/mp4/${site}/${tok}`;
            res.set('Cache-Control', 'no-store').json({ type: r.type, url, road: r.road, expiresAt: r.expiresAt });
        } catch (e) { fail(res, e, `ep ${site}/${tok}`); }
    });

    // 伪 m3u8:服务器取上游清单并绝对化;分片仍由浏览器直连 CDN(绝不经本机转发媒体)
    app.get('/api/kz/m3u8/:site/:file', async (req, res) => {
        const { site, file } = req.params;
        const m = /^(\d+-\d+-\d+)\.m3u8$/.exec(file || '');
        if (!known(site) || !m) return bad(res, 'bad site or tok');
        try {
            const text = await playlist(site, m[1]);
            res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }).send(text);
        } catch (e) {
            res.set('Access-Control-Allow-Origin', '*');
            // 重解析后这一集变成了 mp4(art.php 轮换上游):409 + 指路,前端可据此改走 mp4 而不是当成整集坏掉
            if (e && e.code === 'KZ_NOT_HLS') return res.status(409).set('Cache-Control', 'no-store').json({ type: 'mp4', url: `/api/kz/mp4/${site}/${m[1]}` });
            fail(res, e, `m3u8 ${site}/${m[1]}`);
        }
    });

    // mp4:302 到签名直链;no-referrer 防止浏览器把本站 Referer 带给 QQ/365yg(带了就 404/403)
    app.get('/api/kz/mp4/:site/:tok', async (req, res) => {
        const { site, tok } = req.params;
        if (!known(site) || !TOK_RE.test(tok)) return bad(res, 'bad site or tok');
        try {
            const r = await resolve(site, tok, { fresh: req.query.fresh === '1' });
            const loc = r.type === 'mp4' ? r.url : `/api/kz/m3u8/${site}/${tok}.m3u8`;
            // 302 目标来自上游(解析器/art.php),浏览器会直接跟过去:挡掉指向本机/内网的地址。
            // 字面 IP 由 assertPublicHttpUrl 拦;域名再解析一次(按 host 缓存约 10 分钟)—— 否则 evil.example → 127.0.0.1
            // 这种 DNS 指向内网的地址会被我们 302 给浏览器,变成借本站跳板打用户本机/内网的跳转
            if (r.type === 'mp4') { R.assertPublicHttpUrl(loc); await R.assertPublicDns(loc); }
            res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).redirect(302, loc);
        } catch (e) { fail(res, e, `mp4 ${site}/${tok}`); }
    });
}

module.exports = {
    getSites, isKzSite, search, detail, resolve, playlist, registerRoutes, check,
    titleKey: T.titleKey, coreKeyword: T.coreKeyword,
    // 测试/调试用
    _internal: { envFlag, allowFresh, ttlCache, resolveWithFallback, normName, parseSearchHtml, parseDetailHtml, absolutizeM3u8, pickVariant, loadSites, buildSites, BUILTIN, siteOf, buildSearchUrl, caches: { searchCache, detailCache, resolveCache, playlistCache } },
};
