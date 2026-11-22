'use strict';
// [adult] p4 镜像探测的 SSRF 闸门(lib/adult-mirror 专用,零依赖)
//   只许 http(s)、不许 URL 里带账号密码、主机必须解析到【全部】公网地址(内网/回环/链路本地/CGNAT/组播/保留/文档段一律拒)。
//   地址判定只认 WHATWG URL 归一化之后的主机名:http://2130706433/、http://0177.0.0.1/、http://0x7f.1/、http://127.1/
//   都会被 URL 解析成 127.0.0.1;IPv6 字面量去掉方括号后按 8 组解析(IPv4 映射 / 兼容 / NAT64 / 6to4 取内嵌的 IPv4 再判)。
//   safeLookup:给 http(s).Agent 用的 lookup —— 连接那一刻再解析一次、再判一次(防 DNS 重绑定:预检时公网、连接时内网)。
const net = require('net');
const dns = require('dns');

function v4Num(ip) {
    const p = String(ip).split('.');
    if (p.length !== 4) return null;
    let n = 0;
    for (const x of p) {
        if (!/^\d{1,3}$/.test(x)) return null;
        const v = +x;
        if (v > 255) return null;
        n = n * 256 + v;
    }
    return n;
}
// [起始, 前缀长度]:不可路由 / 内网 / 保留 / 文档 / 组播
const V4_DENY = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([a, len]) => [v4Num(a), len]);
function isPublicV4(ip) {
    const n = v4Num(ip);
    if (n == null) return false;
    for (const [base, len] of V4_DENY) {
        const size = 2 ** (32 - len);
        if (n >= base && n < base + size) return false;
    }
    return true;
}
// IPv6 → 8 个 16 位组;认不出 → null
function v6Groups(s) {
    let x = String(s || '').toLowerCase().replace(/^\[|\]$/g, '');
    const z = x.indexOf('%');
    if (z >= 0) x = x.slice(0, z);
    if (!x || /[^0-9a-f:.]/.test(x)) return null;
    let tail = [];
    const m4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(x);
    if (m4) {
        const n = v4Num(m4[2]);
        if (n == null) return null;
        tail = [Math.floor(n / 65536), n % 65536];
        x = m4[1].endsWith('::') ? m4[1] : m4[1].slice(0, -1);
    }
    const parts = x.split('::');
    if (parts.length > 2) return null;
    const conv = (str) => (str === '' ? [] : str.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
    const head = conv(parts[0]);
    let g;
    if (parts.length === 2) {
        const rest = conv(parts[1]).concat(tail);
        const fill = 8 - head.length - rest.length;
        if (fill < 1) return null;
        g = head.concat(new Array(fill).fill(0), rest);
    } else g = head.concat(tail);
    if (g.length !== 8 || g.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
    return g;
}
const v4Of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
function isPublicV6(ip) {
    const g = v6Groups(ip);
    if (!g) return false;
    const zero = (from, to) => { for (let i = from; i < to; i++) if (g[i] !== 0) return false; return true; };
    if (zero(0, 5) && g[5] === 0xffff) return isPublicV4(v4Of(g[6], g[7]));          // ::ffff:a.b.c.d 映射
    if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return false;                     // ::ffff:0:a.b.c.d SIIT
    if (zero(0, 6)) return false;                                                     // :: / ::1 / ::a.b.c.d(已废弃的兼容写法)
    if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPublicV4(v4Of(g[6], g[7]));   // 64:ff9b::/96 NAT64
    if (g[0] === 0x2002) return isPublicV4(v4Of(g[1], g[2]));                         // 2002::/16 6to4
    if ((g[0] & 0xe000) !== 0x2000) return false;                                     // 只认 2000::/3 全球单播(fc00::/7、fe80::/10、ff00::/8、100::/64 … 全在外面)
    if (g[0] === 0x2001 && g[1] < 0x200) return false;                                // 2001::/23 IANA 特殊用途(Teredo 2001::/32、基准测试、ORCHID…)
    if (g[0] === 0x2001 && g[1] === 0xdb8) return false;                              // 2001:db8::/32 文档
    if (g[0] === 0x3fff && g[1] < 0x1000) return false;                               // 3fff::/20 文档(RFC 9637)
    return true;
}
function isPublicIp(ip) {
    const s = String(ip == null ? '' : ip).trim().replace(/^\[|\]$/g, '');
    if (net.isIPv4(s)) return isPublicV4(s);
    if (net.isIPv6(s)) return isPublicV6(s);
    return false;   // 认不出的写法 = 不放行
}

const BAD_HOST = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|invalid|test|example|onion)$/i;
// 静态检查(不解析 DNS):→ { ok, reason, url:URL, host, ip:bool }
function checkUrlStatic(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s.length > 2000) return { ok: false, reason: 'bad-url' };
    if (/[\u0000- \u007f\\]/.test(s)) return { ok: false, reason: 'bad-url' };
    let u;
    try { u = new URL(s); } catch (e) { return { ok: false, reason: 'bad-url' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
    if (u.username || u.password || /^[a-z]+:\/\/[^/?#]*@/i.test(s)) return { ok: false, reason: 'userinfo' };
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!host) return { ok: false, reason: 'bad-host' };
    if (net.isIP(host)) return isPublicIp(host) ? { ok: true, url: u, host, ip: true } : { ok: false, reason: 'private-ip' };
    if (host.indexOf('.') < 0 || BAD_HOST.test(host) || !/^[a-z0-9.-]+$/.test(host) || host.length > 253) return { ok: false, reason: 'bad-host' };
    return { ok: true, url: u, host, ip: false };
}
const defaultResolve = (host) => dns.promises.lookup(host, { all: true, verbatim: true }).then((a) => a.map((x) => x.address));
// 完整检查:静态 + DNS(全部地址都得是公网;解析不到 = 拒)
async function checkUrl(raw, resolve) {
    const r = checkUrlStatic(raw);
    if (!r.ok || r.ip) return r;
    let addrs;
    try { addrs = await (typeof resolve === 'function' ? resolve : defaultResolve)(r.host); } catch (e) { return { ok: false, reason: 'dns' }; }
    if (!Array.isArray(addrs) || !addrs.length) return { ok: false, reason: 'dns' };
    for (const a of addrs) if (!isPublicIp(typeof a === 'string' ? a : (a && a.address))) return { ok: false, reason: 'private-ip' };
    return r;
}
// http(s).Agent 的 lookup:连接时再解析、再判(任何一个地址不是公网 → EPRIVATE)
function safeLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    const o = Object.assign({}, typeof options === 'object' && options ? options : { family: options }, { all: true });
    dns.lookup(hostname, o, (err, list) => {
        if (err) return cb(err);
        const arr = Array.isArray(list) ? list : [];
        if (!arr.length || arr.some((a) => !isPublicIp(a && a.address))) return cb(Object.assign(new Error('refused: non-public address'), { code: 'EPRIVATE' }));
        if (options && options.all) return cb(null, arr);
        return cb(null, arr[0].address, arr[0].family);
    });
}

// axios 请求配置加固(server.js 直连【换上去的镜像源站】时用):连接那一刻 safeLookup;跟随跳转时每一跳都先按 checkUrlStatic 再判
//   (Node 对 IP 字面量主机根本不调 lookup —— 镜像 302 到 http://127.0.0.1/ 或 169.254.169.254 只有这里拦得住;主机名的跳转仍由 lookup 判);
//   最多跟 3 跳。不合格 → 抛 EPRIVATE(follow-redirects 把它变成请求错误,axios reject)
const MAX_GUARD_REDIRECTS = 3;
function axiosGuard(opts) {
    const o = Object.assign({}, opts || {});
    const prev = typeof o.beforeRedirect === 'function' ? o.beforeRedirect : null;
    o.lookup = safeLookup;
    const mr = Number(o.maxRedirects);
    o.maxRedirects = Number.isFinite(mr) && mr >= 0 ? Math.min(mr, MAX_GUARD_REDIRECTS) : MAX_GUARD_REDIRECTS;
    o.beforeRedirect = (ro, res, req) => {
        const href = ro && typeof ro.href === 'string' && ro.href
            ? ro.href
            : (ro ? String(ro.protocol || '') + '//' + (ro.hostname && ro.hostname.indexOf(':') >= 0 ? '[' + ro.hostname + ']' : String(ro.hostname || ro.host || '')) + (ro.port ? ':' + ro.port : '') + String(ro.path || '/') : '');
        const c = checkUrlStatic(href);
        if (!c.ok) throw Object.assign(new Error('mirror redirect refused: ' + c.reason), { code: 'EPRIVATE' });
        if (prev) prev(ro, res, req);
    };
    return o;
}

module.exports = { isPublicIp, isPublicV4, isPublicV6, v6Groups, checkUrlStatic, checkUrl, safeLookup, defaultResolve, axiosGuard };
