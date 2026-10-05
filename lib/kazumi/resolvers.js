// Kazumi 规则站的"取真实媒体地址"解析器 + 共用 HTTP 层(净室实现)。
//
// Kazumi 本身靠 WebView 跑站点 JS、嗅探第一个像媒体的请求来拿地址;服务端(VPS / Vercel)跑不了浏览器,
// 所以这里按站点类型手写纯 HTTP 解析器,规则 JSON 的 dg.resolver 选用哪一个:
//   'maccms' —— 通用 maccms10:播放页 var player_xxx={from,encrypt,url} 解码 → 已是 http(s) .m3u8/.mp4 直接用;
//               否则走站点自带的服务端解析 art.php(dg.maccms.artphp)读 var config={"url":...}。
//               (7sefun 的 A 线 iframe 域名 dp.no3acg.com 已过期,lmm85.com 有 Cloudflare 质询 —— art.php 是唯一纯 HTTP 通路)
//   'hhjx'   —— DM84:播放页 iframe https://hhjx.hhplayer.com/?url=<密文> → 页内 __HHJX_BOOTSTRAP__ →
//               POST /api/parse(必须带 Origin: https://hhjx.hhplayer.com,浏览器伪造不了,所以只能服务端解析)。
//               bootstrap 的 key 约 5 分钟失效,因此每次都现取现用,绝不缓存 bootstrap。
//
// 铁律:
//   * 探测媒体(Range 嗅探)时【绝不带 Referer】:QQ groupvideo / v3.365yg.com 对任何 Referer(包括站点自己的)回 404/403。
//   * 只探头部 ≤2KB(Range 0-2047 + 流式读取后立即断开),服务器永不整段拉媒体(全站"VPS 不拉媒体"铁律)。
//   * 全部走 axios:server.js 已把 axios 默认 agent 换成限流的全局 Agent(maxSockets 96),这里再加每 host 最多 2 并发。
'use strict';

const axios = require('axios');
const net = require('net');
const dns = require('dns');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HTML_TIMEOUT = 8000;
const SLOW_TIMEOUT = 10000;   // art.php / hhjx:对方服务端还要去上游解析,给宽一点
const HOST_MAX = 2;
const HOST_QUEUE_MAX = 24;    // 单 host 排队上限:再多说明上游已经堵死,直接失败比让 Express 请求无限挂着强
const HOST_WAIT = 12000;      // 排队最长等待:axios 的 timeout 要拿到槽位才开始计时,排队本身必须另有期限
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busyError = (host) => Object.assign(new Error(`host busy: ${host}`), { code: 'EKZBUSY' });

// ---------- 每 host 并发闸门(这两个站都很小,别把人家打挂/被封) ----------
// 释放时把槽位【直接移交】给队首等待者(active 不减),而不是"先减再让等待者自增":
// 后者在两次微任务之间 active 会掉到 0 → 闸门被删 → 等待者在孤儿闸门上跑、新请求另起新闸门,实际并发可超过 2。
const hostGate = new Map();   // host -> {active, queue:[{grant, timer}]}
async function withHost(url, fn, { maxWait = HOST_WAIT } = {}) {
    let host = '';
    try { host = new URL(url).host; } catch (e) { }
    let g = hostGate.get(host);
    if (!g) { g = { active: 0, queue: [] }; hostGate.set(host, g); }
    if (g.active < HOST_MAX) g.active++;
    else {
        if (g.queue.length >= HOST_QUEUE_MAX) throw busyError(host);
        await new Promise((resolve, reject) => {
            const w = { grant: () => { clearTimeout(w.timer); resolve(); } };
            w.timer = setTimeout(() => {
                const i = g.queue.indexOf(w);
                if (i >= 0) g.queue.splice(i, 1);
                reject(busyError(host));
            }, maxWait);
            g.queue.push(w);
        });
        // 走到这里时槽位已由释放方移交,active 已计入本请求,不能再 ++
    }
    try { return await fn(); } finally {
        const next = g.queue.shift();
        if (next) next.grant();
        else { g.active--; if (!g.active) hostGate.delete(host); }
    }
}

// ---------- 出网目的地校验(防 SSRF) ----------
// 我们会去取上游给出的地址(art.php 的 config.url、hhjx /api/parse 的 url、302 Location、master 清单里的变体),
// 上游被黑或恶意时可以把它指向 127.0.0.1 / 内网 / 169.254.169.254 元数据,路由的报错就成了内网端口扫描器。
// 三道关:URL 字面量(协议 + 字面 IP + localhost)、每次重定向再验一次、DNS 解析结果(自定义 lookup,连接用的就是验过的地址)。
function ipv4Private(ip) {
    const p = ip.split('.').map(Number);
    const a = p[0], b = p[1];
    return a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)        // CGNAT
        || (a === 169 && b === 254)                  // 链路本地 / 云元数据
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 192 && b === 0 && p[2] === 0)
        || (a === 198 && (b === 18 || b === 19));
}
/**
 * IPv6 文本 → 8 个 16 位整数;非法返回 null。
 * 必须先展开再判:正则只认得 "::ffff:1.2.3.4" 这类固定写法,同一地址可以写成 "0:0:0:0:0:ffff:7f00:1"、
 * "::ffff:0:127.0.0.1"、"64:ff9b::7f00:1"…… 逐个写正则总会漏一种。
 */
function expandIpv6(ip) {
    ip = String(ip).replace(/%.*$/, '');   // 去 zone id(fe80::1%eth0)
    let tail = [];
    const m4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);   // 末尾内嵌点分 IPv4 占 2 组
    if (m4) {
        const p = [m4[2], m4[3], m4[4], m4[5]].map(Number);
        if (p.some((x) => x > 255)) return null;
        tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
        ip = m4[1];
        if (!/::$/.test(ip)) ip = ip.slice(0, -1);   // "1:2:3:4:5:6:" → 去掉与 IPv4 之间的那个冒号;"::" 要保留
    }
    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const groups = (s) => (s ? s.split(':') : []);
    const head = groups(halves[0]), rest = halves.length === 2 ? groups(halves[1]) : [];
    const need = 8 - tail.length;
    let all;
    if (halves.length === 2) {
        const fill = need - head.length - rest.length;
        if (fill < 1) return null;
        all = head.concat(new Array(fill).fill('0'), rest);
    } else {
        if (head.length !== need) return null;
        all = head;
    }
    const out = [];
    for (const g of all) { if (!/^[0-9a-f]{1,4}$/i.test(g)) return null; out.push(parseInt(g, 16)); }
    return out.concat(tail);
}
const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
function isPrivateIp(ip) {
    ip = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
    const v = net.isIP(ip);
    if (v === 4) return ipv4Private(ip);
    if (v !== 6) return false;
    const h = expandIpv6(ip);
    if (!h) return true;   // net 认它是 IPv6 我们却展不开:宁可错拦(fail closed)
    const zero = (from, to) => { for (let i = from; i < to; i++) if (h[i] !== 0) return false; return true; };
    // ::/128、::1 以及 IPv4 兼容 ::a.b.c.d(已废弃,但部分栈仍会按内嵌 IPv4 路由)::: → 0.0.0.0、::1 → 0.0.0.1 都落在 0/8
    if (zero(0, 6)) return ipv4Private(v4Of(h[6], h[7]));
    // IPv4 映射 ::ffff:a.b.c.d(含 ::ffff:7f00:1 写法)
    if (zero(0, 5) && h[5] === 0xffff) return ipv4Private(v4Of(h[6], h[7]));
    // SIIT IPv4 转换地址 ::ffff:0:a.b.c.d
    if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) return ipv4Private(v4Of(h[6], h[7]));
    // NAT64 熟知前缀 64:ff9b::/96:在 NAT64 网络里它就是被转换到内嵌的 IPv4(64:ff9b::7f00:1 → 127.0.0.1)
    if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return ipv4Private(v4Of(h[6], h[7]));
    // 本地用途 NAT64 64:ff9b:1::/48(RFC 8215):只在运营商内部有意义,一律当内网
    if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true;
    // 6to4 2002::/16:第 2、3 组是内嵌 IPv4(2002:7f00:1:: → 127.0.0.1)
    if (h[0] === 0x2002) return ipv4Private(v4Of(h[1], h[2]));
    return (h[0] & 0xfe00) === 0xfc00      // ULA fc00::/7
        || (h[0] & 0xffc0) === 0xfe80      // 链路本地 fe80::/10
        || (h[0] & 0xffc0) === 0xfec0      // 已废弃的站点本地 fec0::/10
        || (h[0] & 0xff00) === 0xff00;     // 组播 ff00::/8
}
const blockedError = (what) => Object.assign(new Error(`blocked destination: ${what}`), { code: 'EKZBLOCKED' });
/** 只放行公网 http(s);返回规范化后的 href,否则抛错 */
function assertPublicHttpUrl(u) {
    let url;
    try { url = new URL(String(u)); } catch (e) { throw blockedError('bad url'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw blockedError(url.protocol);
    const h = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!h || h === 'localhost' || h.endsWith('.localhost') || isPrivateIp(h)) throw blockedError(h || 'empty host');
    return url.href;
}
// axios 的 lookup 钩子:DNS 解析出的任一地址落在内网就拒绝(字面 IP 不走 lookup,由 assertPublicHttpUrl 拦)
function safeLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, Object.assign({}, options, { all: true }), (err, addrs) => {
        if (err) return cb(err);
        if (!addrs || !addrs.length) return cb(Object.assign(new Error('ENOTFOUND ' + hostname), { code: 'ENOTFOUND' }));
        if (addrs.some((a) => isPrivateIp(a.address))) return cb(blockedError(hostname));
        if (options && options.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
    });
}
// 每一跳重定向前再验一次(follow-redirects 会把这里抛的错转成请求错误,不会变成未捕获异常)
function guardRedirect(opts) {
    assertPublicHttpUrl(`${opts.protocol || 'http:'}//${opts.hostname || opts.host}/`);
}
const guard = { lookup: safeLookup, beforeRedirect: guardRedirect };

// 302 交给浏览器的地址(/api/kz/mp4)不经过我们的 axios,上面的 safeLookup 管不到:路由在 302 前自己解析一次域名。
// 按 host 缓存结论约 10 分钟(上限 500 条,插入序淘汰):mp4 直链多是同几个 CDN host,没必要每次点播都查 DNS。
// 查询失败/超时不缓存(可能只是一时的解析抖动),本次照样拒绝 —— 宁可这一下播不了也不把未验证的地址 302 出去。
const DNS_VERDICT_TTL = 10 * 60 * 1000;
const DNS_VERDICT_MAX = 500;
const DNS_TIMEOUT = 5000;
const dnsVerdicts = new Map();   // host -> {ok, exp}
const dnsInflight = new Map();   // host -> Promise<boolean>
const dnsImpl = { lookup: (host) => dns.promises.lookup(host, { all: true }) };   // 测试可替换
async function hostIsPublic(host) {
    const c = dnsVerdicts.get(host);
    if (c && c.exp > Date.now()) return c.ok;
    if (c) dnsVerdicts.delete(host);
    if (dnsInflight.has(host)) return dnsInflight.get(host);
    const p = (async () => {
        let timer;
        try {
            const addrs = await Promise.race([
                dnsImpl.lookup(host),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('dns timeout')), DNS_TIMEOUT); }),
            ]);
            const list = Array.isArray(addrs) ? addrs : [addrs];
            const ok = list.length > 0 && !list.some((a) => isPrivateIp(a && typeof a === 'object' ? a.address : a));
            dnsVerdicts.delete(host); dnsVerdicts.set(host, { ok, exp: Date.now() + DNS_VERDICT_TTL });
            while (dnsVerdicts.size > DNS_VERDICT_MAX) dnsVerdicts.delete(dnsVerdicts.keys().next().value);
            return ok;
        } catch (e) { return false; } finally { clearTimeout(timer); dnsInflight.delete(host); }
    })();
    dnsInflight.set(host, p);
    return p;
}
/** 域名解析结果全部是公网才放行;字面 IP 直接交给 assertPublicHttpUrl 的结论(这里不再解析) */
async function assertPublicDns(u) {
    const href = assertPublicHttpUrl(u);
    const h = new URL(href).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIP(h)) return href;
    if (!(await hostIsPublic(h))) throw blockedError(h);
    return href;
}

const finalUrlOf = (res, fallback) => (res && res.request && res.request.res && res.request.res.responseUrl) || fallback;

/** 取文本(HTML / JSON / m3u8)。返回 {status, text, url(重定向后), headers} */
async function getText(url, opts = {}) {
    url = assertPublicHttpUrl(url);
    const headers = Object.assign({ 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, opts.headers || {});
    return withHost(url, async () => {
        const res = await axios.request({
            ...guard, url, method: opts.method || 'GET', headers, data: opts.data,
            timeout: opts.timeout || HTML_TIMEOUT,
            responseType: 'text', transformResponse: [(d) => d],
            maxRedirects: opts.maxRedirects == null ? 5 : opts.maxRedirects,
            maxContentLength: opts.maxBytes || 8 * 1024 * 1024,
            validateStatus: () => true,
        });
        return { status: res.status, text: typeof res.data === 'string' ? res.data : String(res.data || ''), url: finalUrlOf(res, url), headers: res.headers || {} };
    });
}

/** 站点 HTML:带 Referer = 站点根(与 Kazumi 一致,它发 baseURL+'/') */
async function getHtml(site, url, opts = {}) {
    const r = await getText(url, Object.assign({}, opts, { headers: Object.assign({ Referer: site.base + '/' }, opts.headers || {}) }));
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${url}`);
    return r.text;
}

/**
 * 媒体头嗅探:Range 0-2047、无 Referer、流式读到 2KB 立刻断开。
 * 返回 {status, ctype, head(Buffer), url(重定向后)};失败抛错。
 */
async function sniffHead(url, { timeout = HTML_TIMEOUT, maxRedirects = 5 } = {}) {
    url = assertPublicHttpUrl(url);
    return withHost(url, async () => {
        const res = await axios.request({
            ...guard, url, method: 'GET', responseType: 'stream', timeout, maxRedirects,
            headers: { 'User-Agent': UA, Range: 'bytes=0-2047', Accept: '*/*' },   // 刻意不带 Referer(QQ/365yg 防盗链)
            validateStatus: () => true,
        });
        const stream = res.data;
        const chunks = []; let n = 0;
        await new Promise((resolve) => {
            const done = () => { try { stream.destroy(); } catch (e) { } resolve(); };
            const t = setTimeout(done, timeout);
            stream.on('data', (c) => { chunks.push(c); n += c.length; if (n >= 2048) { clearTimeout(t); done(); } });
            stream.on('end', () => { clearTimeout(t); resolve(); });
            stream.on('error', () => { clearTimeout(t); resolve(); });
        });
        return { status: res.status, ctype: String((res.headers && res.headers['content-type']) || ''), head: Buffer.concat(chunks).slice(0, 2048), url: finalUrlOf(res, url) };
    });
}

/** 只取一次 302 的 Location(不跟随、不读 body)。非 3xx 返回 {status, location:null} */
async function peekRedirect(url, { timeout = HTML_TIMEOUT } = {}) {
    url = assertPublicHttpUrl(url);
    return withHost(url, async () => {
        const res = await axios.request({
            ...guard, url, method: 'GET', responseType: 'stream', timeout, maxRedirects: 0,
            headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
            validateStatus: () => true,
        });
        try { res.data.destroy(); } catch (e) { }
        const loc = res.headers && res.headers.location;
        return { status: res.status, location: res.status >= 300 && res.status < 400 && loc ? new URL(loc, url).href : null };
    });
}

// ---------- 纯解析函数(离线可测) ----------
function decodeEntities(s) {
    return String(s == null ? '' : s)
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
        .replace(/&amp;/g, '&');
}

// 从 "{" 起扫到配对的 "}"(跳过字符串内的括号),比非贪婪正则稳:player 数据里 vod_data 是嵌套对象
function balancedObject(src, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
    }
    return null;
}

/** maccms 的 url 编码:encrypt 1 = escape();2 = base64(escape());0 = 原文 */
function decodeMaccmsUrl(s, encrypt) {
    if (!s) return '';
    const e = String(encrypt == null ? '0' : encrypt);
    try {
        if (e === '2') return unescape(Buffer.from(String(s), 'base64').toString('latin1'));
        if (e === '1') return unescape(String(s));
    } catch (err) { }
    return String(s);
}

/** 播放页 var player_xxx = {...} → {from, id, sid, nid, encrypt, url(已解码), url_next, raw};找不到返回 null */
function parsePlayerData(html) {
    const m = /var\s+player_[a-z0-9_]+\s*=\s*\{/i.exec(String(html || ''));
    if (!m) return null;
    const objStr = balancedObject(html, m.index + m[0].length - 1);
    if (!objStr) return null;
    let p; try { p = JSON.parse(objStr); } catch (e) { return null; }
    return {
        from: p.from == null ? '' : String(p.from), id: p.id == null ? '' : String(p.id), sid: p.sid, nid: p.nid, encrypt: p.encrypt,
        url: decodeMaccmsUrl(p.url, p.encrypt), url_next: decodeMaccmsUrl(p.url_next, p.encrypt), raw: p,
    };
}

/** art.php 返回页里的 var config = {"url":"..."} → 媒体 URL(按 JSON 字符串规则反转义) */
function parseArtConfig(html) {
    const m = /var\s+config\s*=\s*\{[\s\S]*?["']url["']\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(html || ''));
    if (!m) return null;
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1].replace(/\\\//g, '/'); }
}

/** DM84 播放页 → hhjx iframe 地址 */
function parseHhjxIframe(html) {
    const h = String(html || '');
    const m = /<iframe[^>]+src="(https?:\/\/[^"]*hhplayer\.com[^"]*)"/i.exec(h) || /<div class="p_box"><iframe src="([^"]+)"/.exec(h);
    return m ? decodeEntities(m[1]) : null;
}

/** hhjx 解析页 → window.__HHJX_BOOTSTRAP__ 对象 */
function parseHhjxBootstrap(html) {
    const h = String(html || '');
    const m = /window\.__HHJX_BOOTSTRAP__\s*=\s*\{/.exec(h);
    if (!m) return null;
    const s = balancedObject(h, m.index + m[0].length - 1);
    try { return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

/** 从签名 URL 推出过期时间(毫秒时间戳);不认识返回 null */
function expiryOf(u) {
    let url; try { url = new URL(u); } catch (e) { return null; }
    const q = url.searchParams;
    const sec = (v) => { const n = Number(v); if (!isFinite(n) || n <= 0) return null; return n > 1e12 ? n : n * 1000; };
    for (const k of ['expires', 'Expires', 'deadline', 'x-expires', 'e']) {
        const v = q.get(k); if (v && /^\d{9,13}$/.test(v)) return sec(v);
    }
    const ad = q.get('X-Amz-Date') || q.get('x-amz-date');
    const ae = q.get('X-Amz-Expires') || q.get('x-amz-expires');
    if (ad && ae) {
        const t = Date.parse(ad.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
        if (isFinite(t)) return t + Number(ae) * 1000;
    }
    // 字节系 CDN(akamaized / 365yg):路径 /<md5>/<8位十六进制过期时间>/video/tos/...
    const tos = /^\/[0-9a-f]{32}\/([0-9a-f]{8})\/video\/tos\//.exec(url.pathname);
    if (tos) return parseInt(tos[1], 16) * 1000;
    return null;
}

const pathOf = (u) => { try { return new URL(u).pathname; } catch (e) { return ''; } };
const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));
const isDirectMedia = (u) => isHttp(u) && /\.(m3u8|mp4)$/i.test(pathOf(u));

/**
 * 判定媒体类型 'hls' | 'mp4'。路径以 .m3u8/.mp4 结尾直接定;否则(字节系/QQ 等无扩展名)无 Referer 嗅探头 2KB。
 * 返回 {type, url}(url 可能因嗅探时的重定向而更新为最终地址)。
 */
async function classifyMedia(url) {
    const p = pathOf(url);
    if (/\.m3u8$/i.test(p)) return { type: 'hls', url };
    if (/\.mp4$/i.test(p)) return { type: 'mp4', url };
    const r = await sniffHead(url);
    if (r.status >= 400) throw new Error(`media HTTP ${r.status}`);
    const headTxt = r.head.toString('latin1');
    if (/^\uFEFF?\s*#EXTM3U/.test(r.head.toString('utf8'))) return { type: 'hls', url };
    if (/mpegurl/i.test(r.ctype)) return { type: 'hls', url };
    if (headTxt.indexOf('ftyp') >= 0 || /^video\//i.test(r.ctype)) return { type: 'mp4', url };
    if (/octet-stream/i.test(r.ctype) && r.head.length > 0 && !/^\s*</.test(headTxt)) return { type: 'mp4', url };
    throw new Error(`unknown media type (${r.ctype || 'no content-type'})`);
}

// ---------- 解析器:maccms(通用 maccms10) ----------
async function resolveMaccms(ctx, playHtml) {
    const { site, vid } = ctx;
    const mc = (site.dg && site.dg.maccms) || {};
    const html = playHtml || await getHtml(site, ctx.playUrl);
    const p = parsePlayerData(html);
    if (!p) throw new Error('player_aaaa not found');
    let url = null, via = null;
    if (isDirectMedia(p.url)) { url = p.url; via = 'direct'; }
    else if (mc.artphp) {
        // 站点自己的服务端解析:对 lmm(第三方 HTML 页)、ndx 的 ali_xxx id、直链都统一有效,无需 Referer/Cookie
        const art = `${site.base}${mc.artphp}?key=0&from=${encodeURIComponent(p.from)}&id=${encodeURIComponent(p.id || vid)}&uid=0&url=${encodeURIComponent(p.url)}&jump=`;
        const r = await getText(art, { timeout: SLOW_TIMEOUT, headers: { Referer: site.base + mc.artphp.replace(/[^/]*$/, 'index.php') } });
        const u = r.status === 200 ? parseArtConfig(r.text) : null;
        if (u && isHttp(u)) { url = u; via = 'art.php'; }
        else throw new Error(`art.php no url (HTTP ${r.status}, from=${p.from})`);
    } else throw new Error(`unresolvable from=${p.from}`);
    // 已知"跳转到签名地址"的直链(7sefun ndx: mao6.jxdunrui.top/d/file → 天翼云签名 URL):跟一次 302,拿到带过期时间的最终地址
    const follow = (mc.followRedirect || []).some((re) => { try { return new RegExp(re, 'i').test(url); } catch (e) { return false; } });
    if (follow) {
        const r = await peekRedirect(url).catch(() => null);
        if (r && r.location) url = r.location;
    }
    const c = await classifyMedia(url);
    return { type: c.type, url: c.url, expiresAt: expiryOf(c.url), via, from: p.from };
}

// ---------- 解析器:hhjx(DM84) ----------
const isM3u8Url = (u) => /(?:\.m3u8|\/m3u8)(?:$|[?#])/i.test(String(u || ''));
async function resolveHhjx(ctx) {
    const { site } = ctx;
    const html = await getHtml(site, ctx.playUrl);
    const iframe = parseHhjxIframe(html);
    if (!iframe) {
        // 模板若换回 maccms 的 player_aaaa,走通用解析
        if (parsePlayerData(html)) return resolveMaccms(ctx, html);
        throw new Error('hhjx iframe not found');
    }
    const origin = new URL(iframe).origin;
    const page = await getText(iframe, { timeout: SLOW_TIMEOUT, headers: { Referer: ctx.playUrl } });
    const boot = parseHhjxBootstrap(page.text);
    if (!boot) throw new Error(`hhjx: no bootstrap (HTTP ${page.status})`);
    if (boot.error) throw new Error('hhjx bootstrap error: ' + JSON.stringify(boot.error).slice(0, 120));
    const call = async (clientFallback) => {
        const body = { url: boot.url, t: boot.t, key: boot.key, client_fallback: clientFallback };
        if (boot.act === 99) body.act = 99;
        // /api/parse 只认 Origin/Referer = hhjx 自己(否则 403"非法来源")
        const r = await getText(origin + '/api/parse', {
            method: 'POST', data: JSON.stringify(body), timeout: SLOW_TIMEOUT,
            headers: { 'Content-Type': 'application/json', Origin: origin, Referer: iframe },
        });
        try { return JSON.parse(r.text); } catch (e) { throw new Error(`hhjx /api/parse non-JSON HTTP ${r.status}`); }
    };
    let j = await call(false);
    let ext = (j && j.ext) || '';
    // youku:页面是浏览器侧走 ups.youku.com,失败后才 client_fallback;我们直接要回退结果
    if (j && j.code === 200 && ext === 'youku') { j = await call(true); ext = (j && j.ext) || ''; }
    if (!j || j.code !== 200 || !j.url) throw new Error('hhjx /api/parse failed: ' + String((j && (j.msg || j.code)) || 'empty').slice(0, 80));
    let url = String(j.url).replace(/^http:\/\//i, 'https://');
    let forcedHls = false;
    if (ext === 'hls_rewrite' && isM3u8Url(url)) {
        url = `${origin}/getts?url=${encodeURIComponent(url)}&t=${encodeURIComponent(String(boot.t))}&key=${encodeURIComponent(String(boot.ts_key || ''))}`;
        forcedHls = true;
    }
    // cibn-edge-5g.1ljx.com 的 auth_key 链接寿命 <30s,且约每 30s 在"好 302"与"302 到 aibox.eu.org/110"间交替:
    // 必须立刻跟 302 把 Location 交给播放端;落到 aibox 时等一下再试一次。
    let host = ''; try { host = new URL(url).hostname; } catch (e) { }
    if (/(^|\.)1ljx\.com$/i.test(host) || (/cibn/i.test(host) && /[?&]auth_key=/.test(url))) {
        let got = null;
        for (let attempt = 0; attempt < 2 && !got; attempt++) {
            if (attempt) await sleep(1500);
            const r = await peekRedirect(url);
            if (r.location && !/aibox\.eu\.org/i.test(r.location)) got = r.location.replace(/^http:\/\//i, 'https://');
            else if (r.status === 200 || r.status === 206) got = url;
        }
        if (!got) throw new Error('1ljx short-lived link rejected (aibox redirect)');
        url = got;
    }
    if (forcedHls) return { type: 'hls', url, expiresAt: expiryOf(url), via: 'hhjx-getts' };
    const c = await classifyMedia(url);
    return { type: c.type, url: c.url, expiresAt: expiryOf(c.url), via: 'hhjx' + (ext ? ':' + ext : '') };
}

const RESOLVERS = { maccms: resolveMaccms, hhjx: resolveHhjx };

module.exports = {
    RESOLVERS, UA,
    // HTTP 层(index.js 复用,共享同一套每 host 闸门)
    getText, getHtml, sniffHead, peekRedirect, withHost, assertPublicHttpUrl, assertPublicDns, isPrivateIp, _expandIpv6: expandIpv6, _safeLookup: safeLookup, _guardRedirect: guardRedirect,
    _dnsImpl: dnsImpl, _dnsVerdicts: dnsVerdicts,
    // 纯函数(离线测试)
    parsePlayerData, decodeMaccmsUrl, parseArtConfig, parseHhjxIframe, parseHhjxBootstrap, expiryOf, classifyMedia, decodeEntities,
};
