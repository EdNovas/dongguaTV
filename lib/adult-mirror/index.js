'use strict';
// [adult] p4 资源站换域名自动跟随(server.js 用;目录爬虫 catalogSites + 闸门搜索/详情都经 apiFor() 取当前地址)
//
// 为什么要:成人资源站换皮域名极频繁(调研:老色逼/奶香香各 ~30 个域名),旧域名过期后常被停放页/别家站抢注。
//   旧做法 = 运维手改 db.json;这里在【连续失败】时自己找新地址,而且必须证明新地址是【同一个片库】才切过去。
//
// createMirror({ sites, httpGet?, store?, log?, now?, resolve? })
//   sites    [{key, api, mirrors?:[url]}] 或返回它的函数(server.js 传站点表;30 s 内复用一次读取)
//   httpGet  (url, {timeout}) → Promise<{status, headers, data}>:原始 GET,不跟随跳转,有大小上限(默认 makeSafeHttpGet:
//            连接时再判公网地址、1 MB、8 s)。测试注入假实现
//   store    {load():obj, save(obj)}(默认不落盘;server.js 用 fileStore(cache.db 旁边的 adult-mirror.json,已 gitignore))
//   resolve  host → Promise<[ip]>(SSRF 预检的 DNS;测试注入)
//   now      () → ms(测试注入)
// → { apiFor(key), report(key, ok, kind, info?), status(), probe(key), reset(key), start(), stop(), tick() }
//
// 规则(契约 P4 B2):
//   · 计数:report(key,false,kind) 里 kind ∈ timeout / dns / 5xx / body(不是 maccms JSON)/ conn(拒连、重置、证书坏)才算;
//     30 分钟内连续 ≥3 次 → 换源(成功一次清零;其它 kind 不计也不清)。info.url 不是当前地址的上报 = 过期,忽略。
//   · 换源顺序:db 条目的 mirrors(按游标轮转,跨轮接着往下试)→ 主地址(当前在镜像上时)→ 发现:
//       旧 api 地址 / 旧站根页 的 3xx Location(任意主机);根页 HTML 里的链接(绝对 URL、//host)与正文裸域名 ——
//       复核 SEC-2:链接 / 裸域名只收【和旧域名同前缀】(similar())的主机,一律拼【同一个 api 路径】。
//       复核 SEC-1:扫 HTML 全部线性(不用会回溯成平方的正则),只看前 256 KB(htmlScanBytes)。
//   · 每个候选:SSRF 闸门(ssrf.js)→ GET <候选>?ac=list → 必须是 maccms JSON(list 非空)→ 指纹对得上【主地址】的快照:
//       最新 8 条片名(归一化)与快照重合 ≥3;或"太新"(快照不足 3 条 / 候选这 8 条全比快照最新的还新)时:
//         db 配置的镜像 / 主地址 = 分类表 (type_id:名) 集合 Jaccard ≥0.8 即可;
//         发现来的候选(复核 SEC-2)= 分类表不算数(公开的,谁都能抄),必须再按快照记下的 vod_id 回查一次
//           (?ac=detail&ids=…,多花 1 个请求),这些 id 的片名对上 ≥3 条才收。
//       没有快照:只认 db 里配置的镜像(站长给的,maccms 有效即可),发现的候选一律拒。
//   · 快照只来自【主地址】成功上报的样本(report 的 info.data):ac=list / 不带筛选的第一页 ac=detail(爬虫 &h= 增量页、闸门拉分类图)。零额外请求。
//       复核 SEC-2:换到镜像以后镜像回的样本不进快照 —— 快照一直是换源前主地址的那份,回切和之后再换源都拿它比
//       (否则换上去的地址自己写快照,主地址恢复了也"指纹对不上"、永远切不回来)。
//   · 每站每小时 ≤10 个出网请求(发现 + 验证 + 回切都算),持久化(重启不清零)。
//   · 当前在镜像上:每 6 小时回头验一次主地址,验过(maccms + 指纹)就切回去。后台 reset(key) = 立刻回主地址(正在跑的换源作废)。
const ssrf = require('./ssrf');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const COUNTED = new Set(['timeout', 'dns', '5xx', 'body', 'conn']);
const DEF = Object.freeze({
    failN: 3, failWindowMs: 30 * 60e3, retryMs: 30 * 60e3, budget: 10, budgetWindowMs: 3600e3,
    failbackMs: 6 * 3600e3, tickMs: 5 * 60e3, timeoutMs: 8000, maxBytes: 1024 * 1024, sitesTtlMs: 30e3,
    nameN: 8, overlapMin: 3, jaccardMin: 0.8, classMin: 3, htmlCands: 6, persistMs: 10 * 60e3, triedKeep: 12,
    htmlScanBytes: 256 * 1024,   // 发现时每页只扫前这么多字符(复核 SEC-1)
});

// ---------- 小工具 ----------
const normName = (s) => String(s == null ? '' : s).slice(0, 300).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
// 快照里只存归一化片名 / 分类名的短哈希(状态文件里不留上游原始片名)
const fp = (s) => (s ? crypto.createHash('sha1').update(s).digest('hex').slice(0, 16) : '');
function parseTime(v) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
    const s = String(v == null ? '' : v).trim();
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) return 0;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    return Number.isFinite(t) ? t : 0;
}
// 回包 → 对象(BOM / 前后空白都认;不是 JSON 对象 = null)
function toObj(body) {
    let o = body;
    if (Buffer.isBuffer(o)) o = o.toString('utf8');
    if (typeof o === 'string') {
        const s = o.replace(/^﻿/, '').trim();
        if (s[0] !== '{') return null;
        try { o = JSON.parse(s); } catch (e) { return null; }
    }
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
}
const vodItems = (o) => o.list.filter((x) => x && typeof x === 'object' && typeof x.vod_name === 'string' && x.vod_name.trim());
// vod_id 只收短的数字 / 字母串(拼进 ?ids= 用)
function vodIdOf(v) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e15) return String(v);
    if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v)) return v;
    return '';
}
// maccms JSON → {ok, names[], ids[[vod_id, 片名哈希]], minTime, maxTime, classes[]|null, reason}
function parseMaccms(body) {
    const o = toObj(body);
    if (!o) return { ok: false, reason: 'not-json' };
    if (!Array.isArray(o.list)) return { ok: false, reason: 'no-list' };
    const items = vodItems(o);
    const head = items.slice(0, DEF.nameN);
    const names = head.map((x) => fp(normName(x.vod_name))).filter(Boolean);
    const ids = [];
    for (const x of head) { const id = vodIdOf(x.vod_id), h = fp(normName(x.vod_name)); if (id && h && !ids.some((y) => y[0] === id)) ids.push([id, h]); }
    const times = head.map((x) => parseTime(x.vod_time)).filter((t) => t > 0);
    const classes = Array.isArray(o.class) && o.class.length
        ? [...new Set(o.class.filter((c) => c && typeof c === 'object' && c.type_name != null).map((c) => String(c.type_id == null ? '' : c.type_id) + ':' + fp(normName(c.type_name))))].slice(0, 400)
        : null;
    return { ok: true, names, ids, n: items.length, minTime: times.length ? Math.min(...times) : 0, maxTime: times.length ? Math.max(...times) : 0, classes };
}
// ?ac=detail&ids= 的回包:快照记下的 (vod_id → 片名哈希) 有几条对得上(同一个 id、同一个片名;每个 id 只算一次)
function idsOverlap(body, pairs) {
    const o = toObj(body);
    if (!o || !Array.isArray(o.list)) return -1;
    const want = new Map((Array.isArray(pairs) ? pairs : []).filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string').map((p) => [p[0], p[1]]));
    const hit = new Set();
    for (const x of vodItems(o).slice(0, 200)) {
        const id = vodIdOf(x.vod_id);
        if (id && want.get(id) === fp(normName(x.vod_name))) hit.add(id);
    }
    return hit.size;
}
function jaccard(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
}
// 指纹:候选(ac=list 解析结果)对快照。now = 现在(毫秒;不传 = Date.now())
function fingerprint(snap, cand, now) {
    const sn = snap && Array.isArray(snap.names) ? snap.names : [];
    const sc = snap && Array.isArray(snap.classes) ? snap.classes : [];
    if (!sn.length && !sc.length) return { ok: false, reason: 'no-snapshot' };
    const set = new Set(sn);
    const overlap = cand.names.filter((n) => set.has(n)).length;
    if (overlap >= DEF.overlapMin) return { ok: true, how: 'names', overlap };
    // "太新"(候选最新 8 条全比快照最新那条晚)才退到分类表比对。上架时间是候选自己报的:报到未来(超过现在 10 小时)的不认。
    //   容差 10 小时:maccms 的 vod_time 是北京时间(parseTime 按 UTC 读 = 看起来晚 8 小时)。
    //   复核 SEC-2:这道只挡"写远未来";写成"现在"一样算太新 —— 所以分类表这一档只给 db 配置的镜像 / 主地址用(validate 的 trusted),
    //   发现来的候选拿到 how:'classes' 也不算数,要再按 vod_id 回查片名(validate;fresh / cmp 给它判断要不要回查)
    const t = Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
    if (cand.maxTime > t + 10 * 3600e3) return { ok: false, reason: 'future-times', overlap };
    const tooFresh = sn.length < DEF.overlapMin || (cand.minTime > 0 && snap.maxTime > 0 && cand.minTime > snap.maxTime);
    if (tooFresh) {
        const cmp = sc.length >= DEF.classMin && Array.isArray(cand.classes) && cand.classes.length > 0;   // 两边都有分类表、比得了
        const j = cmp ? jaccard(sc, cand.classes) : 0;
        if (j >= DEF.jaccardMin) return { ok: true, how: 'classes', overlap, jaccard: Math.round(j * 100) / 100, fresh: true, cmp };
        return { ok: false, reason: 'classes-mismatch', overlap, jaccard: Math.round(j * 100) / 100, fresh: true, cmp };
    }
    return { ok: false, reason: 'names-mismatch', overlap };
}
// 当前地址的"最新一页"样本才进快照:ac=list,或不带任何筛选的 ac=detail / ac=videolist 第一页(h / pg=1 / pagesize / limit 可以有)
function isNewestUrl(url, api) {
    if (typeof url !== 'string' || typeof api !== 'string' || url.indexOf(api) !== 0) return false;
    const rest = url.slice(api.length);
    if (rest && rest[0] !== '?' && rest[0] !== '&') return false;
    let q;
    try { q = new URLSearchParams(rest.replace(/^[?&]/, '')); } catch (e) { return false; }
    const ac = q.get('ac');
    if (ac !== 'list' && ac !== 'detail' && ac !== 'videolist') return false;
    for (const k of q.keys()) if (!/^(ac|h|pg|page|pagesize|limit)$/.test(k)) return false;
    const pg = q.get('pg') || q.get('page');
    return !pg || pg === '1';
}
const originOf = (u) => { try { const x = new URL(u); return x.protocol + '//' + x.host; } catch (e) { return ''; } };
const apiPathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch (e) { return ''; } };
const normUrl = (u) => { try { const x = new URL(String(u).trim()); x.hash = ''; return x.toString().replace(/\/+$/, ''); } catch (e) { return ''; } };
const sameApi = (a, b) => !!a && !!b && normUrl(a) === normUrl(b);
// 主地址 https、候选 http = 降级(明文可被中途改写)
const isDowngrade = (primary, cand) => /^https:/i.test(String(primary || '')) && /^http:/i.test(String(cand || ''));
const withQs = (api, qs) => api + (api.indexOf('?') >= 0 ? '&' : '?') + qs;
// 主机名的"主标签"(去掉 www/api 之类的前缀和顶级域)——裸域名候选要和旧站同前缀才收
function mainLabel(host) {
    const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
    if (parts.length < 2) return parts[0] || '';
    const sld = parts[parts.length - 2];
    return /^(com|net|org|co|gov|edu)$/.test(sld) && parts.length >= 3 ? parts[parts.length - 3] : sld;
}
// 根页里常见、但绝不会是新地址的主机(CDN / 统计 / 社交 / 域名停放商):不浪费探测预算
const JUNK_HOST = /(^|\.)(w3\.org|schema\.org|googleapis\.com|gstatic\.com|google\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|cloudflare\.com|cloudflareinsights\.com|jsdelivr\.net|unpkg\.com|jquery\.com|bootcdn\.cn|bootcss\.com|staticfile\.org|baidu\.com|bdstatic\.com|cnzz\.com|51\.la|umeng\.com|facebook\.com|twitter\.com|x\.com|t\.me|telegram\.org|github\.com|youtube\.com|apple\.com|microsoft\.com|sedo\.com|sedoparking\.com|godaddy\.com|dan\.com|afternic\.com|namecheap\.com|bodis\.com|parkingcrew\.net|above\.com|hugedomains\.com)$/i;
function similar(a, b) {
    const x = mainLabel(a).replace(/\d+$/, ''), y = mainLabel(b).replace(/\d+$/, '');
    const n = Math.min(x.length, y.length, 6);
    return n >= 4 && x.slice(0, n) === y.slice(0, n);
}

// ---------- 发现时扫 HTML(复核 SEC-1)----------
// 上游 HTML 是不可信输入、在主线程上扫:以前的 /<script[\s\S]*?<\/script>/、/<[^>]+>/、/\b((?:[a-z0-9-]+\.)+…)\b/ 遇到
//   一长串 '<'、没闭合的 <script、'1.1.1.…' 会回溯成平方(1 MB 一页要几分钟,整站卡死)。这里全用 indexOf / 逐字扫描:
//   每个字符只看常数次;各处都有上限(每页只扫前 htmlScanBytes、主机名 ≤253 字符、收到的候选有数)。
const isHostCh = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 46;   // a-z A-Z 0-9 - .
// 主机名:2..11 段,每段 1..63 个 [a-z0-9-],顶级域 2..24 个字母。只拿 ≤253 字符的串来试(有界)
const DOMAIN_RE = /^(?:[a-z0-9-]{1,63}\.){1,10}[a-z]{2,24}$/i;
function trimDots(s) {
    let a = 0, b = s.length;
    while (a < b && (s.charCodeAt(a) === 46 || s.charCodeAt(a) === 45)) a++;
    while (b > a && (s.charCodeAt(b - 1) === 46 || s.charCodeAt(b - 1) === 45)) b--;
    return a === 0 && b === s.length ? s : s.slice(a, b);
}
const hostOf = (s) => { const t = trimDots(s); return t.length >= 4 && t.length <= 253 && DOMAIN_RE.test(t) ? t.toLowerCase() : ''; };
// HTML → 正文:<script>/<style> 整块去掉(没闭合 = 后面全丢);标签('<' 到下一个 '>',中间没有别的 '<',同 /<[^<>]*>/)→ 空格;
//   孤立的 '<' 也当空格。只动 ASCII 大小写(长度不变,下标对得上)
function htmlText(html) {
    const s = String(html == null ? '' : html);
    const lo = s.replace(/[A-Z]+/g, (x) => x.toLowerCase());
    const n = s.length, out = [];
    let i = 0, gt = -2;   // gt:缓存的"下一个 '>'"(-1 = 后面再也没有;-2 = 还没找)
    while (i < n) {
        const lt = s.indexOf('<', i);
        if (lt < 0) { out.push(s.slice(i)); break; }
        if (lt > i) out.push(s.slice(i, lt));
        out.push(' ');
        const close = lo.startsWith('<script', lt) ? '</script' : lo.startsWith('<style', lt) ? '</style' : '';
        if (close) {
            const k = lo.indexOf(close, lt + 1);
            const e = k < 0 ? -1 : s.indexOf('>', k + close.length);
            if (e < 0) break;
            i = e + 1;
            continue;
        }
        if (gt !== -1 && gt <= lt) gt = s.indexOf('>', lt + 1);
        if (gt < 0) { i = lt + 1; continue; }
        const nextLt = s.indexOf('<', lt + 1);
        i = nextLt >= 0 && nextLt < gt ? lt + 1 : gt + 1;   // 中间又有 '<' = 这个 '<' 不是标签开头
    }
    return out.join('');
}
// 页面里 "//主机[:端口]"(绝对 URL / 协议相对的 //host)→ [{scheme:'http:'|'https:'|'', host, port}];只收 keep(host) 为真的、最多 max 个
function linkHosts(html, keep, max) {
    const s = String(html == null ? '' : html), n = s.length, out = [], seen = new Set();
    let i = 0;
    while (out.length < max) {
        const p = s.indexOf('//', i);
        if (p < 0) break;
        let j = p + 2;
        while (j < n && j - p - 2 <= 253 && isHostCh(s.charCodeAt(j))) j++;
        if (j === p + 2) { i = p + 1; continue; }   // "///host":从下一个 '/' 再找
        i = j;
        const host = j - p - 2 <= 253 ? hostOf(s.slice(p + 2, j)) : '';
        if (!host) continue;
        let port = '';
        if (s.charCodeAt(j) === 58) {   // ':'
            let k = j + 1;
            while (k < n && k - j <= 5 && s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) k++;
            if (k > j + 1 && k - j <= 6) port = s.slice(j + 1, k);
        }
        const pre = s.slice(Math.max(0, p - 6), p).toLowerCase();
        const scheme = pre.endsWith('https:') ? 'https:' : pre.endsWith('http:') ? 'http:' : '';
        const key = scheme + '//' + host + ':' + port;
        if (seen.has(key)) continue;
        seen.add(key);
        if (keep(host)) out.push({ scheme, host, port });
    }
    return out;
}
// 正文里的裸域名("最新地址:xxx.com")→ 只收 keep(host) 为真的、最多 max 个(去重)
function bareHosts(text, keep, max) {
    const s = String(text == null ? '' : text), n = s.length, out = [], seen = new Set();
    let i = 0;
    while (i < n && out.length < max) {
        while (i < n && !isHostCh(s.charCodeAt(i))) i++;
        const a = i;
        while (i < n && isHostCh(s.charCodeAt(i))) i++;
        if (i - a < 4 || i - a > 253) continue;
        const h = hostOf(s.slice(a, i));
        if (!h || seen.has(h)) continue;
        seen.add(h);
        if (keep(h)) out.push(h);
    }
    return out;
}

// 错误 → kind(server.js 的 catalogHttpGet / 闸门 fetchJson 报失败时用)
function classifyError(e) {
    if (!e) return 'other';
    if (e instanceof SyntaxError) return 'body';
    const st = e.response && Number(e.response.status);
    if (st >= 500) return '5xx';
    if (st >= 400) return '4xx';
    const code = String(e.code || (e.cause && e.cause.code) || '');
    if (/^(ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(code) || /timeout/i.test(String(e.message || ''))) return 'timeout';
    if (/^(ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_NONAME|EAI_FAIL)$/.test(code)) return 'dns';
    if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|EPROTO|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_SSL_WRONG_VERSION_NUMBER)$/.test(code)) return 'conn';
    if (/^(bad body|not json|catalog: 空响应)/i.test(String(e.message || ''))) return 'body';
    return 'other';
}

// 默认 httpGet:原生 http(s),连接时 safeLookup 再判地址;不跟随跳转;解压后 >maxBytes 直接断开;总超时 timeout
function makeSafeHttpGet(opts) {
    const o = Object.assign({ maxBytes: DEF.maxBytes, timeoutMs: DEF.timeoutMs, lookup: ssrf.safeLookup }, opts || {});
    const agents = { 'http:': new http.Agent({ keepAlive: false, maxSockets: 8, lookup: o.lookup }), 'https:': new https.Agent({ keepAlive: false, maxSockets: 8, lookup: o.lookup }) };
    return function safeGet(url, ro) {
        const timeout = Math.min((ro && ro.timeout) || o.timeoutMs, 30000);
        return new Promise((resolve, reject) => {
            const st = ssrf.checkUrlStatic(url);
            if (!st.ok) return reject(Object.assign(new Error('refused: ' + st.reason), { code: 'EREFUSED' }));
            const u = st.url;
            const mod = u.protocol === 'https:' ? https : http;
            let done = false;
            const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); if (err) reject(err); else resolve(v); };
            const req = mod.request(u, {
                method: 'GET', agent: agents[u.protocol], lookup: o.lookup,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 'Accept': 'application/json,text/html;q=0.8,*/*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br' },
            }, (res) => {
                const enc = String(res.headers['content-encoding'] || '').toLowerCase();
                let stream = res;
                if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
                else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
                else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
                const chunks = [];
                let n = 0;
                stream.on('data', (c) => {
                    n += c.length;
                    if (n > o.maxBytes) { req.destroy(); finish(Object.assign(new Error('bad body: too large'), { code: 'ETOOLARGE' })); return; }
                    chunks.push(c);
                });
                stream.on('end', () => finish(null, { status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks).toString('utf8') }));
                stream.on('error', (e) => finish(e));
            });
            const timer = setTimeout(() => { req.destroy(); finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); }, timeout);
            if (timer.unref) timer.unref();
            req.on('error', (e) => finish(e));
            req.end();
        });
    };
}
// JSON 文件存储(原子写:临时文件 + rename;权限 600)
function fileStore(file) {
    return {
        file,
        load() {
            try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
            catch (e) { return {}; }
        },
        save(obj) {
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                const tmp = file + '.' + process.pid + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
                fs.renameSync(tmp, file);
                return true;
            } catch (e) { return false; }
        },
    };
}

function createMirror(deps) {
    const d = deps || {};
    const nowFn = typeof d.now === 'function' ? d.now : Date.now;
    const log = typeof d.log === 'function' ? d.log : () => { };
    const httpGet = typeof d.httpGet === 'function' ? d.httpGet : makeSafeHttpGet();
    const store = d.store && typeof d.store.load === 'function' && typeof d.store.save === 'function' ? d.store : null;
    const resolve = typeof d.resolve === 'function' ? d.resolve : ssrf.defaultResolve;
    const C = Object.assign({}, DEF, d.config || {});

    // ---------- 站点配置(30 s 复用) ----------
    let cfgAt = -Infinity, cfg = new Map();
    function sitesMap() {
        const t = nowFn();
        if (t - cfgAt < C.sitesTtlMs && cfg.size) return cfg;
        let list = [];
        try { list = typeof d.sites === 'function' ? d.sites() : d.sites; } catch (e) { list = []; }
        const m = new Map();
        for (const s of Array.isArray(list) ? list : []) {
            if (!s || typeof s.key !== 'string' || !s.key || m.has(s.key) || typeof s.api !== 'string' || !/^https?:\/\//i.test(s.api.trim())) continue;
            const api = s.api.trim();
            const mirrors = [...new Set((Array.isArray(s.mirrors) ? s.mirrors : []).filter((x) => typeof x === 'string' && /^https?:\/\//i.test(x.trim())).map((x) => x.trim()))]
                .filter((x) => !sameApi(x, api)).slice(0, 50);
            m.set(s.key, { key: s.key, api, mirrors });
        }
        cfg = m; cfgAt = t;
        return m;
    }

    // ---------- 状态 ----------
    // key → { primary, current, since, fails, failTimes[], lastOk, lastProbe, lastPrimaryCheck, probeTimes[], cursor, snapshot, reason, tried[], nextTry, busy }
    const S = new Map();
    let dirty = false, lastPersist = 0;
    const PERSIST_KEYS = ['primary', 'current', 'since', 'lastProbe', 'lastPrimaryCheck', 'probeTimes', 'cursor', 'snapshot', 'reason', 'tried', 'nextTry'];
    (function load() {
        if (!store) return;
        let o = {};
        try { o = store.load() || {}; } catch (e) { o = {}; }
        const sites = o && typeof o.sites === 'object' && o.sites ? o.sites : {};
        for (const k of Object.keys(sites)) {
            const v = sites[k];
            if (!v || typeof v !== 'object' || typeof v.primary !== 'string' || typeof v.current !== 'string') continue;
            const st = { fails: 0, failTimes: [], busy: null };
            for (const f of PERSIST_KEYS) if (v[f] !== undefined) st[f] = v[f];
            if (!Array.isArray(st.probeTimes)) st.probeTimes = [];
            if (!Array.isArray(st.tried)) st.tried = [];
            // 复核 SEC-2:快照只认主地址那份(snapshot.api = 主地址)。旧版本存的快照可能是换上去的镜像自己写的(主地址恢复了也切不回来)→ 丢掉;
            //   在主地址上时下一次最新一页的上报就重建,在镜像上时回切按"配置的主地址、没快照 = maccms 有效即可"
            if (st.snapshot && (typeof st.snapshot !== 'object' || st.snapshot.api !== st.primary)) { st.snapshot = null; dirty = true; }
            // 复核:旧版本没快照时会把 https 站换到没验过指纹的 http 镜像(tried 里记 trusted-no-snapshot-http)—— 读到这种状态就回主地址,按新规则重来
            if (isDowngrade(st.primary, st.current) && st.tried.some((r) => r && r.url === st.current && r.reason === 'trusted-no-snapshot-http')) {
                st.current = st.primary; st.since = nowFn(); st.reason = 'reset-unverified-http'; dirty = true;
            }
            S.set(k, st);
        }
    })();
    function persist(force) {
        if (!store) return;
        const t = nowFn();
        if (!force && (!dirty || t - lastPersist < C.persistMs)) return;
        const out = { v: 1, at: t, sites: {} };
        for (const [k, st] of S) {
            const o = {};
            for (const f of PERSIST_KEYS) if (st[f] !== undefined) o[f] = st[f];
            out.sites[k] = o;
        }
        try { store.save(out); } catch (e) { log('[Mirror] 保存失败: ' + e.message); }
        dirty = false; lastPersist = t;
    }
    // 取状态;站点表里主地址变了(站长改了 db)→ 状态作废重来
    function stOf(key) {
        const site = sitesMap().get(key);
        if (!site) return null;
        let st = S.get(key);
        if (!st || st.primary !== site.api) {
            st = { primary: site.api, current: site.api, since: nowFn(), fails: 0, failTimes: [], probeTimes: [], cursor: 0, snapshot: null, reason: '', tried: [], busy: null };
            S.set(key, st);
            dirty = true;
        }
        return st;
    }
    function useBudget(st) {
        const t = nowFn();
        st.probeTimes = (st.probeTimes || []).filter((x) => t - x < C.budgetWindowMs);
        if (st.probeTimes.length >= C.budget) return false;
        st.probeTimes.push(t);
        st.lastProbe = t;
        dirty = true;
        return true;
    }
    function remember(st, rec) {
        st.tried = [rec].concat(st.tried || []).slice(0, C.triedKeep);
    }
    function switchTo(key, st, url, why) {
        const from = st.current;
        st.current = url; st.since = nowFn(); st.fails = 0; st.failTimes = []; st.reason = why; st.nextTry = 0;
        dirty = true;
        persist(true);
        log(`[Mirror] ${key}: ${from} → ${url} (${why})`);
    }

    // ---------- 一次受预算约束的 GET ----------
    async function budgetGet(st, url) {
        if (!useBudget(st)) return { err: 'rate-limited' };
        const chk = await ssrf.checkUrl(url, resolve);
        if (!chk.ok) return { err: 'ssrf:' + chk.reason };
        try {
            const r = await httpGet(url, { timeout: C.timeoutMs });
            if (!r || typeof r !== 'object') return { err: 'no-response' };
            let body = r.data;
            if (Buffer.isBuffer(body)) body = body.toString('utf8');
            if (typeof body === 'string' && body.length > C.maxBytes) return { err: 'too-large' };
            return { status: Number(r.status) || 0, headers: r.headers || {}, data: body };
        } catch (e) { return { err: classifyError(e) || 'error' }; }
    }
    // 候选验证:SSRF + maccms + 指纹。trusted = db 里配置的镜像/主地址(没快照时 maccms 有效即可;降级成 http 的没快照一律不收)。
    //   主地址是 https、候选是 http(降级):发现来的一律不认;db 配置的只在最后兜底时才试(见 probe ④),有快照时照样要指纹对得上
    async function validate(st, api, trusted) {
        const s0 = ssrf.checkUrlStatic(api);   // SSRF 的理由优先(内网字面 IP 的 http 链接报 ssrf:private-ip,不报 downgrade)
        if (!s0.ok) return { ok: false, reason: 'ssrf:' + s0.reason };
        if (isDowngrade(st.primary, api) && !trusted) return { ok: false, reason: 'downgrade' };
        const snap = st.snapshot;
        const hasSnap = snap && ((Array.isArray(snap.names) && snap.names.length) || (Array.isArray(snap.classes) && snap.classes.length));
        // 复核:没快照(没法比指纹)时,配置的降级镜像(https 主地址 → http)也不收、不连 —— 否则开机几秒内就可能把整站的搜索 / 详情 / 爬虫流量
        //   换到一个从没验过指纹的明文地址上(可被中间人改 m3u8 / 片名)。同协议的配置镜像没快照时照旧只验 maccms(站长配置的)
        if (!hasSnap && isDowngrade(st.primary, api)) return { ok: false, reason: 'downgrade-no-snapshot' };
        const r = await budgetGet(st, withQs(api, 'ac=list'));
        if (r.err) return { ok: false, reason: r.err };
        if (r.status !== 200) return { ok: false, reason: 'http-' + r.status };
        const p = parseMaccms(r.data);
        if (!p.ok) return { ok: false, reason: p.reason };
        if (!p.n) return { ok: false, reason: 'empty-list' };
        if (!hasSnap) return trusted ? { ok: true, how: 'trusted-no-snapshot', parsed: p } : { ok: false, reason: 'no-snapshot' };
        const f = fingerprint(snap, p, nowFn());
        if (trusted || (f.ok && f.how === 'names')) return f.ok ? Object.assign({ ok: true, parsed: p }, f) : f;
        // 复核 SEC-2:发现来的候选必须真有片名对上。最新 8 条全比快照新("太新")时,分类表对上(或比不了)不算数 ——
        //   按快照记下的 vod_id 回查一次(?ac=detail&ids=,同一个片库的镜像 id 一样),这些 id 的片名对上 ≥3 条才收
        if (!f.fresh || (f.cmp && !f.ok)) return f.ok ? { ok: false, reason: 'names-required', overlap: f.overlap } : f;
        const pairs = Array.isArray(snap.ids) ? snap.ids.filter((x) => Array.isArray(x) && vodIdOf(x[0]) && typeof x[1] === 'string').slice(0, DEF.nameN) : [];
        if (pairs.length < DEF.overlapMin) return { ok: false, reason: 'names-required', overlap: f.overlap };
        const r2 = await budgetGet(st, withQs(api, 'ac=detail&ids=' + pairs.map((x) => x[0]).join(',')));
        if (r2.err) return { ok: false, reason: r2.err };
        if (r2.status !== 200) return { ok: false, reason: 'ids-http-' + r2.status };
        const hit = idsOverlap(r2.data, pairs);
        if (hit >= DEF.overlapMin) return { ok: true, how: 'ids', overlap: hit, parsed: p };
        return { ok: false, reason: hit < 0 ? 'ids-not-json' : 'ids-mismatch', overlap: Math.max(0, hit) };
    }
    // 发现:旧 api 地址 / 旧站根页 的跳转 Location;根页(或 api 地址回的 HTML)里【和旧域名同前缀】的链接 / 裸域名 → 同一个 api 路径
    async function discover(st, fromApi, out) {
        const origin = originOf(fromApi), apiPath = apiPathOf(fromApi);
        if (!origin || !apiPath) return;
        let host0 = '', hostP = '', proto = 'https:';
        try { const u0 = new URL(fromApi); host0 = u0.hostname; proto = u0.protocol; } catch (e) { return; }
        try { hostP = new URL(st.primary).hostname; } catch (e) { hostP = ''; }
        // 复核 SEC-2:页面里的链接 / 裸域名只收和旧域名(这一页的域名或主地址的域名)同前缀的 —— 广告 / 友链 / 随便一个外链不再能当候选
        const near = (h) => !JUNK_HOST.test(h) && (similar(h, host0) || (!!hostP && similar(h, hostP)));
        // 候选一律 = 新源站 + 旧 api 路径(契约:只认"同一个 api 路径")
        const add = (u, src) => {
            const o = u ? originOf(u) : '';
            if (!o || o === origin) return;
            let h = '';
            try { h = new URL(o).hostname.toLowerCase(); } catch (e) { return; }
            if (JUNK_HOST.test(h)) return;
            out.push({ url: o + apiPath, src });
        };
        for (const page of [fromApi, origin + '/']) {
            const r = await budgetGet(st, page);
            if (r.err) { if (r.err === 'rate-limited') return; continue; }
            if (r.status >= 300 && r.status < 400) {
                let loc = r.headers && (r.headers.location || r.headers.Location);
                if (Array.isArray(loc)) loc = loc[0];
                if (typeof loc === 'string' && loc) { try { add(new URL(loc, page).toString(), 'redirect'); } catch (e) { } }
                continue;
            }
            if (r.status === 200 && typeof r.data === 'string' && !parseMaccms(r.data).ok) {
                // 复核 SEC-1:只扫前 htmlScanBytes(新地址公告都在页面前部),扫描全部线性
                const html = r.data.length > C.htmlScanBytes ? r.data.slice(0, C.htmlScanBytes) : r.data;
                const found = [];
                const seen = new Set();
                const push = (u) => {
                    const o = originOf(u);
                    if (!o || o === origin || seen.has(o)) return;
                    seen.add(o);
                    found.push(o + '/');
                };
                // 链接(绝对 URL、//host)先,正文裸域名后;都只收同前缀的主机
                for (const x of linkHosts(html, near, 50)) push((x.scheme || proto) + '//' + x.host + (x.port ? ':' + x.port : ''));
                if (found.length < C.htmlCands) for (const h of bareHosts(htmlText(html), near, 50)) push('https://' + h);
                for (const f of found.slice(0, C.htmlCands)) add(f, 'link');
            }
        }
    }
    // 换源一轮(单飞)
    async function failover(key, why) {
        const st = stOf(key);
        const site = sitesMap().get(key);
        if (!st || !site) return { key, ok: false, reason: 'unknown-site', tried: [] };
        if (st.busy) return st.busy;
        const epoch = st.epoch || 0;   // 后台 reset 会把它加一:这一轮的结果就不再切换
        st.busy = (async () => {
            const tried = [];
            const seen = new Set([normUrl(st.current)]);
            const attempt = async (url, src, trusted) => {
                const n = normUrl(url);
                if (!n || seen.has(n)) return null;
                seen.add(n);
                const v = await validate(st, url, trusted);
                const rec = { url, src, ok: !!v.ok, reason: v.ok ? (v.how || 'ok') : v.reason, at: nowFn() };
                tried.push(rec); remember(st, rec);
                return v.ok ? url : (v.reason === 'rate-limited' ? 'STOP' : null);
            };
            let got = null, stop = false;
            // ① db 配置的镜像(游标轮转);比主地址降级(https → http)的先跳过,放到最后兜底(④)
            const ms = site.mirrors;
            const insecure = [];
            const start = Number.isInteger(st.cursor) && st.cursor >= 0 ? st.cursor : 0;
            for (let i = 0; i < ms.length && !got && !stop; i++) {
                const idx = (start + i) % ms.length;
                if (isDowngrade(st.primary, ms[idx])) { insecure.push(ms[idx]); continue; }
                const r = await attempt(ms[idx], 'config', true);
                if (r === 'STOP') { stop = true; st.cursor = idx; dirty = true; break; }
                if (r) { got = r; st.cursor = (idx + 1) % ms.length; dirty = true; }
                else st.cursor = (idx + 1) % ms.length;
            }
            // ② 主地址(当前在镜像上时)
            if (!got && !stop && !sameApi(st.current, st.primary)) {
                const r = await attempt(st.primary, 'primary', true);
                if (r === 'STOP') stop = true; else if (r) got = r;
            }
            // ③ 发现
            if (!got && !stop) {
                const cands = [];
                for (const from of [st.current, st.primary].filter((x, i, a) => a.findIndex((y) => sameApi(x, y)) === i)) {
                    await discover(st, from, cands);
                }
                for (const c of cands) {
                    const r = await attempt(c.url, c.src, false);
                    if (r === 'STOP') { stop = true; break; }
                    if (r) { got = r; break; }
                }
            }
            // ④ 兜底:db 配置的降级镜像(http)—— 只有站长配置的才试(发现来的降级一律不认);有快照时照样要指纹对得上
            for (let i = 0; i < insecure.length && !got && !stop; i++) {
                const r = await attempt(insecure[i], 'config-http', true);
                if (r === 'STOP') stop = true; else if (r) got = r;
            }
            if ((st.epoch || 0) !== epoch) return { key, ok: false, switched: false, current: st.current, reason: 'reset', tried };
            if (got) { switchTo(key, st, got, why === 'manual' ? 'manual-probe' : 'failover'); return { key, ok: true, switched: true, current: got, reason: st.reason, tried }; }
            st.reason = stop ? 'rate-limited' : 'no-valid-mirror';
            st.nextTry = nowFn() + C.retryMs;
            dirty = true;
            persist(true);
            log(`[Mirror] ${key}: 没找到可用的新地址(${st.reason},试了 ${tried.length} 个)`);
            return { key, ok: false, switched: false, current: st.current, reason: st.reason, tried };
        })();
        try { return await st.busy; } finally { st.busy = null; }
    }
    // 回切:当前在镜像上、距上次检查 ≥6h → 验主地址(maccms + 指纹)
    async function failback(key, force) {
        const st = stOf(key);
        if (!st || sameApi(st.current, st.primary) || st.busy) return null;
        if (!force && nowFn() - (st.lastPrimaryCheck || st.since || 0) < C.failbackMs) return null;
        st.lastPrimaryCheck = nowFn();
        dirty = true;
        const v = await validate(st, st.primary, true);
        remember(st, { url: st.primary, src: 'failback', ok: !!v.ok, reason: v.ok ? (v.how || 'ok') : v.reason, at: nowFn() });
        if (v.ok) { switchTo(key, st, st.primary, 'failback'); return true; }
        persist(true);
        return false;
    }

    // ---------- 对外 ----------
    // isMirrorUrl(url) → true = 这个地址在某个站【换上去的】镜像源站上(和主地址不同源)。
    //   出网方(server.js 的 fetchWithProxyFallback / 测速)据此在连接那一刻再判地址(ssrf.safeLookup:防发现来的域名之后把 DNS 改到内网)
    function isMirrorUrl(url) {
        const o = originOf(String(url || ''));
        if (!o) return false;
        for (const st of S.values()) {
            if (!st || typeof st.current !== 'string' || !st.current || sameApi(st.current, st.primary)) continue;
            if (originOf(st.current) === o && originOf(st.primary) !== o) return true;
        }
        return false;
    }
    function apiFor(key) {
        const site = sitesMap().get(key);
        if (!site) return null;
        const st = S.get(key);
        return st && st.primary === site.api && typeof st.current === 'string' && st.current ? st.current : site.api;
    }
    function report(key, ok, kind, info) {
        try {
            if (typeof key !== 'string' || !key) return;
            const st = stOf(key);
            if (!st) return;
            const url = info && typeof info.url === 'string' ? info.url : '';
            if (url && url.indexOf(st.current) !== 0) return;   // 不是当前地址的结果(换源前发出的请求)→ 过期
            const t = nowFn();
            if (ok) {
                st.fails = 0; st.failTimes = []; st.lastOk = t;
                // 复核 SEC-2:只有【主地址】的样本进快照;换到镜像上以后,快照停在换源前主地址的那份(回切 / 再换源都拿它比)
                if (url && info && info.data && sameApi(st.current, st.primary) && isNewestUrl(url, st.current)) {
                    const p = parseMaccms(info.data);
                    if (p.ok) {
                        const prev = st.snapshot || {};
                        st.snapshot = {
                            at: t, api: st.primary,
                            names: p.names.length ? p.names : (prev.names || []),
                            maxTime: p.names.length ? p.maxTime : (prev.maxTime || 0),
                            classes: p.classes && p.classes.length ? p.classes : (prev.classes || []),
                            ids: p.ids.length ? p.ids : (prev.ids || []),
                        };
                        dirty = true;
                    }
                }
                return;
            }
            if (!COUNTED.has(kind)) return;
            st.fails = (st.fails || 0) + 1;
            st.failTimes = (st.failTimes || []).filter((x) => t - x < C.failWindowMs).concat([t]);
            if (st.failTimes.length >= C.failN && !st.busy && t >= (st.nextTry || 0)) {
                failover(key, 'auto').catch((e) => log('[Mirror] ' + key + ' 换源异常: ' + e.message));
            }
        } catch (e) { log('[Mirror] report 异常: ' + e.message); }
    }
    function status() {
        const out = [];
        for (const site of sitesMap().values()) {
            const st = S.get(site.key);
            const fresh = st && st.primary === site.api;
            out.push({
                key: site.key, primary: site.api, current: fresh ? st.current : site.api, since: fresh ? (st.since || 0) : 0,
                fails: fresh ? (st.fails || 0) : 0, lastProbe: fresh ? (st.lastProbe || 0) : 0, candidates: site.mirrors.length,
                reason: fresh ? (st.reason || '') : '', snapshot: !!(fresh && st.snapshot && ((st.snapshot.names || []).length || (st.snapshot.classes || []).length)),
                budgetLeft: fresh ? Math.max(0, C.budget - (st.probeTimes || []).filter((x) => nowFn() - x < C.budgetWindowMs).length) : C.budget,
                tried: fresh ? (st.tried || []).slice(0, 6) : [],
            });
        }
        return out;
    }
    // 手动探测:先验当前地址(maccms);不通 → 换源一轮;通且在镜像上 → 顺手试回切
    async function probe(key) {
        const st = stOf(key);
        if (!st) return { key, ok: false, reason: 'unknown-site', tried: [] };
        if (st.busy) return st.busy;
        const r = await budgetGet(st, withQs(st.current, 'ac=list'));
        const p = !r.err && r.status === 200 ? parseMaccms(r.data) : null;
        if (p && p.ok && p.n) {
            st.fails = 0; st.failTimes = []; st.lastOk = nowFn();
            if (!st.snapshot && sameApi(st.current, st.primary) && isNewestUrl(withQs(st.current, 'ac=list'), st.current)) { st.snapshot = { at: nowFn(), api: st.primary, names: p.names, maxTime: p.maxTime, classes: p.classes || [], ids: p.ids }; dirty = true; }
            let switched = false;
            if (!sameApi(st.current, st.primary)) switched = !!(await failback(key, true));
            persist(true);
            return { key, ok: true, switched, current: st.current, reason: switched ? 'failback' : 'current-ok', tried: [] };
        }
        if (r.err === 'rate-limited') return { key, ok: false, switched: false, current: st.current, reason: 'rate-limited', tried: [] };
        return failover(key, 'manual');
    }
    // 后台「回到主地址」(复核 SEC-2):立刻切回站点表里的主地址,不发请求、不用预算;正在跑的换源这一轮作废(不会再切走)。
    //   快照不动(它本来就只来自主地址)。主地址真不通的话,之后照常按"30 分钟连续 3 次"再换源
    function reset(key) {
        const st = stOf(key);
        if (!st) return { key, ok: false, switched: false, reason: 'unknown-site' };
        st.epoch = (st.epoch || 0) + 1;
        const t = nowFn();
        const from = st.current;
        const switched = !sameApi(st.current, st.primary);
        st.fails = 0; st.failTimes = []; st.nextTry = 0;
        if (switched) {
            st.current = st.primary; st.since = t; st.reason = 'admin-reset'; st.lastPrimaryCheck = t;
            log(`[Mirror] ${key}: ${from} → ${st.primary} (admin-reset)`);
        }
        remember(st, { url: st.primary, src: 'admin-reset', ok: true, reason: switched ? 'admin-reset' : 'already-primary', at: t });
        dirty = true;
        persist(true);
        return { key, ok: true, switched, from, current: st.current, reason: switched ? 'admin-reset' : 'already-primary' };
    }
    let timer = null;
    async function tick() {
        for (const key of sitesMap().keys()) {
            try { await failback(key, false); } catch (e) { log('[Mirror] 回切检查异常 ' + key + ': ' + e.message); }
        }
        persist(false);
    }
    function start() {
        if (timer) return;
        timer = setInterval(() => { tick().catch(() => { }); }, C.tickMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; persist(true); }

    return { apiFor, isMirrorUrl, report, status, probe, reset, start, stop, tick, _state: S, _config: C };
}

module.exports = { createMirror, classifyError, makeSafeHttpGet, fileStore, parseMaccms, fingerprint, idsOverlap, isNewestUrl, normName, similar, htmlText, linkHosts, bareHosts, COUNTED, DEF, ssrf };
