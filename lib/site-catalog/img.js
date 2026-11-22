// [adult] 可选封面代理:GET /api/img?k=<wk>&s=<site_key>(只在 ADULT_IMG_PROXY=1 时由 lib/adult-gate 挂上;默认关 = 封面 no-referrer 直链)
//
// 为什么这样做(调研 verdict §8):直链封面不占 VPS 流量,但观众 IP 会暴露给封面 CDN;代理 = 站长选择用流量换隐私。
//   · SSRF 安全:客户端只能给 作品键 + 站 key,封面地址由 resolve(k, s) 从索引里查(爬虫写进去的 vod_pic),
//     请求里的 url= 之类参数一律不看。索引里的地址本身也可能被资源站投毒(写成 127.0.0.1 / 内网),所以:
//     只许 http/https、IP 字面量是内网/回环/链路本地 → 拒(含 IPv4 嵌在 IPv6 里的各种写法:[::ffff:7f00:1]、NAT64、6to4…,
//     Node 对 IP 字面量不走 lookup,所以必须在这里先拆出来判);域名在连接时用自己的 lookup 解析,解析到内网地址 → 拒
//     (连接用的就是检查过的地址,没有 DNS rebinding 窗口);跳转最多 3 次,每一跳同样检查;回包时再看一眼实际对端地址。
//   · 超时 + 大小上限(默认 8s / 5MB);按魔数认图片类型(很多封面 CDN 回 application/octet-stream),认不出 = 不是图片 → 拒
//     (SVG 不认:里面能带脚本)。
//   · 磁盘缓存 <dir>/<sha256(url) 前 40 位>.<ext>,LRU 按总字节数(ADULT_IMG_CACHE_MB,默认 1024)。
//     dir 由 adult-gate 给:ADULT_IMG_CACHE_DIR,默认 cache.db 同目录下的 adult-img-cache —— 不在 public/ 下(公开静态目录的
//     路径归一化能绕过挂载点拦截),缓存文件只能经 /api/img(要鉴权)取。
//   · 同一地址并发合并、全局同时 ≤6 个出网、失败的地址 1h 内不再试(回 502,前端退回别的线路封面 / 占位)。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { Sem } = require('./util');

const DEF = {
    timeoutMs: 8000,
    maxBytes: 5 * 1024 * 1024,
    maxRedirects: 3,
    concurrency: 6,
    negMs: 3600e3,
    negMax: 5000,
    capMb: 1024,
    maxAgeSec: 86400,
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const EXT_TYPE = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };

// IPv6 字面量 → 8 个 16 位组(含 :: 缩写、结尾点分 IPv4、%zone);认不出 → null
function v6Groups(s) {
    let x = String(s || '').toLowerCase();
    const z = x.indexOf('%');
    if (z >= 0) x = x.slice(0, z);
    let tail = [];
    const m4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(x);
    if (m4) {
        if (!net.isIPv4(m4[2])) return null;
        const p = m4[2].split('.').map(Number);
        tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
        x = m4[1].endsWith('::') ? m4[1] : m4[1].slice(0, -1);
    }
    const parts = x.split('::');
    if (parts.length > 2) return null;
    const conv = (str) => (str === '' ? [] : str.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
    const head = conv(parts[0]);
    const rest = parts.length === 2 ? conv(parts[1]).concat(tail) : null;
    let g;
    if (rest) {
        const fill = 8 - head.length - rest.length;
        if (fill < 1) return null;
        g = head.concat(new Array(fill).fill(0), rest);
    } else g = head.concat(tail);
    if (g.length !== 8 || g.some((n) => !Number.isFinite(n))) return null;
    return g;
}
const v4Of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
// 内网 / 回环 / 链路本地 / 组播 / 保留地址(IPv4、IPv6,以及所有把 IPv4 嵌在 IPv6 里的写法:
//   ::ffff:a.b.c.d / ::ffff:7f00:1(WHATWG URL 会把点分改写成十六进制)/ ::a.b.c.d(IPv4 兼容)/ ::ffff:0:a.b.c.d(SIIT)/
//   64:ff9b::/96(NAT64)/ 2002::/16(6to4)→ 取出里面的 IPv4 再判;64:ff9b:1::/48(本地 NAT64)、2001::/32(Teredo,内嵌地址是混淆过的)一律拒)
function isPrivateAddr(ip) {
    const s = String(ip || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIPv4(s)) {
        const p = s.split('.').map(Number);
        const [a, b] = p;
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) || (a === 198 && (b === 18 || b === 19))
            || (a === 198 && b === 51 && p[2] === 100) || (a === 203 && b === 0 && p[2] === 113) || (a === 192 && b === 88 && p[2] === 99);
    }
    if (net.isIPv6(s)) {
        const g = v6Groups(s);
        if (!g) return true;   // 解析不了 = 不放行
        const zero = (from, to) => { for (let i = from; i < to; i++) if (g[i] !== 0) return false; return true; };
        if (zero(0, 8)) return true;                                              // ::
        if (zero(0, 7) && g[7] === 1) return true;                                // ::1
        if (zero(0, 5) && g[5] === 0xffff) return isPrivateAddr(v4Of(g[6], g[7]));               // ::ffff:0:0/96 映射
        if (zero(0, 6)) return isPrivateAddr(v4Of(g[6], g[7]));                                  // ::/96 IPv4 兼容(已废弃)
        if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return isPrivateAddr(v4Of(g[6], g[7]));  // ::ffff:0:0:0/96 SIIT
        if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPrivateAddr(v4Of(g[6], g[7]));   // 64:ff9b::/96 NAT64
        if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;          // 64:ff9b:1::/48 本地 NAT64
        if (g[0] === 0x2002) return isPrivateAddr(v4Of(g[1], g[2]));             // 2002::/16 6to4
        if (g[0] === 0x2001 && g[1] === 0) return true;                           // 2001::/32 Teredo
        if (g[0] === 0x2001 && g[1] === 0xdb8) return true;                       // 2001:db8::/32 文档地址
        if (g[0] === 0x100 && zero(1, 4)) return true;                            // 100::/64 丢弃
        if (zero(0, 1) && !zero(0, 6)) return true;                               // 其余 ::/16 保留段(含 ::x:y:z 之类的怪写法)
        if ((g[0] & 0xfe00) === 0xfc00) return true;   // fc00::/7 唯一本地
        if ((g[0] & 0xffc0) === 0xfe80) return true;   // fe80::/10 链路本地
        if ((g[0] & 0xffc0) === 0xfec0) return true;   // fec0::/10 站点本地(已废弃)
        if ((g[0] & 0xff00) === 0xff00) return true;   // ff00::/8 组播
        return false;
    }
    return true;   // 认不出的地址形式 = 不放行
}

// 魔数 → {ext, type};不是认识的位图格式 → null
function sniff(buf) {
    if (!buf || buf.length < 12) return null;
    const b = buf;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: EXT_TYPE.jpg };
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { ext: 'png', type: EXT_TYPE.png };
    const head = b.slice(0, 12).toString('latin1');
    if (/^GIF8[79]a/.test(head)) return { ext: 'gif', type: EXT_TYPE.gif };
    if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return { ext: 'webp', type: EXT_TYPE.webp };
    if (head.slice(4, 8) === 'ftyp' && /^(avif|avis)$/.test(head.slice(8, 12))) return { ext: 'avif', type: EXT_TYPE.avif };
    if (head.slice(0, 2) === 'BM' && b.length > 26) return { ext: 'bmp', type: EXT_TYPE.bmp };
    return null;
}

// 只连公网地址的 lookup(http.request 的 lookup 选项;Node 新版会带 {all:true} 调用)
function safeLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    const o = options && typeof options === 'object' ? options : {};
    dns.lookup(hostname, { all: true, family: o.family || 0, hints: o.hints }, (err, addrs) => {
        if (err) return cb(err);
        const list = Array.isArray(addrs) ? addrs : [];
        if (!list.length) return cb(new Error('no address'));
        if (list.some((a) => isPrivateAddr(a.address))) return cb(Object.assign(new Error('refused: private address'), { code: 'EPRIVATE' }));
        if (o.all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
    });
}

function checkUrl(u) {
    if (typeof u !== 'string' || u.length > 2000 || !/^https?:\/\//i.test(u)) throw new Error('refused: not http(s)');
    let p;
    try { p = new URL(u); } catch (_) { throw new Error('refused: bad url'); }
    if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error('refused: not http(s)');
    if (p.username || p.password) throw new Error('refused: credentials in url');
    const host = p.hostname.replace(/^\[|\]$/g, '');
    if (!host) throw new Error('refused: no host');
    if (net.isIP(host) && isPrivateAddr(host)) throw new Error('refused: private address');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('refused: local name');
    return p;
}

// 默认的出网实现:手动跟跳转、每一跳都过 checkUrl + safeLookup;超时 / 超大 / 非 200 → throw
function defaultFetch(url, o) {
    const opt = Object.assign({}, DEF, o || {});
    return new Promise((resolve, reject) => {
        let hops = 0, done = false;
        const fin = (err, val) => { if (done) return; done = true; if (err) reject(err); else resolve(val); };
        const timer = setTimeout(() => fin(new Error('timeout')), opt.timeoutMs);
        const go = (u) => {
            let p;
            try { p = checkUrl(u); } catch (e) { clearTimeout(timer); return fin(e); }
            const mod = p.protocol === 'https:' ? https : http;
            const req = mod.request(p, { method: 'GET', lookup: opt.lookup || safeLookup, headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.5' } }, (res) => {
                // 兜底:实际连上的对端是内网地址(不管是怎么绕过上面两道检查的)→ 不读回包
                const peer = res.socket && res.socket.remoteAddress;
                if (!opt.lookup && peer && isPrivateAddr(peer)) { res.destroy(); clearTimeout(timer); return fin(Object.assign(new Error('refused: private peer'), { code: 'EPRIVATE' })); }
                const code = res.statusCode || 0;
                if (code >= 300 && code < 400 && res.headers.location) {
                    res.resume();
                    if (++hops > opt.maxRedirects) { clearTimeout(timer); return fin(new Error('too many redirects')); }
                    let next;
                    try { next = new URL(res.headers.location, p).toString(); } catch (_) { clearTimeout(timer); return fin(new Error('bad redirect')); }
                    return go(next);
                }
                if (code !== 200) { res.resume(); clearTimeout(timer); return fin(new Error('status ' + code)); }
                const len = Number(res.headers['content-length']);
                if (Number.isFinite(len) && len > opt.maxBytes) { res.destroy(); clearTimeout(timer); return fin(new Error('too large')); }
                const chunks = [];
                let n = 0;
                res.on('data', (c) => {
                    n += c.length;
                    if (n > opt.maxBytes) { res.destroy(); clearTimeout(timer); fin(new Error('too large')); return; }
                    chunks.push(c);
                });
                res.on('end', () => { clearTimeout(timer); fin(null, Buffer.concat(chunks)); });
                res.on('error', (e) => { clearTimeout(timer); fin(e); });
            });
            req.on('error', (e) => { clearTimeout(timer); fin(e); });
            req.setTimeout(opt.timeoutMs, () => req.destroy(new Error('timeout')));
            req.end();
        };
        go(url);
    });
}

function createImgProxy(deps) {
    deps = deps || {};
    const C = Object.assign({}, DEF, deps.opts || {});
    const dir = deps.dir;
    const capBytes = Math.max(1, Number(deps.capMb || C.capMb)) * 1024 * 1024;
    const resolve = typeof deps.resolve === 'function' ? deps.resolve : () => null;
    const fetchImage = typeof deps.fetchImage === 'function' ? deps.fetchImage : (u) => defaultFetch(u, C);
    const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const sem = new Sem(C.concurrency);
    const neg = new Map();
    const inflight = new Map();
    const st = { hits: 0, misses: 0, fetched: 0, errors: 0, refused: 0, evicted: 0, notFound: 0 };
    let idx = null, total = 0;   // file → {size, at};total = 字节数

    function loadIndex() {
        if (idx) return;
        idx = new Map();
        total = 0;
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* 写不了就每次现取 */ }
        let names = [];
        try { names = fs.readdirSync(dir); } catch (_) { names = []; }
        for (const f of names) {
            if (!/^[0-9a-f]{40}\.(jpg|png|gif|webp|avif|bmp)$/.test(f)) continue;
            try { const s = fs.statSync(path.join(dir, f)); idx.set(f, { size: s.size, at: s.mtimeMs }); total += s.size; } catch (_) { /* 并发删了 */ }
        }
    }
    const hashOf = (u) => crypto.createHash('sha256').update(u).digest('hex').slice(0, 40);
    function cached(h) {
        for (const ext of Object.keys(EXT_TYPE)) { const f = h + '.' + ext; if (idx.has(f)) return f; }
        return null;
    }
    function evict() {
        if (total <= capBytes) return;
        const list = [...idx.entries()].sort((a, b) => a[1].at - b[1].at);
        for (const [f, e] of list) {
            if (total <= capBytes * 0.9) break;
            try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* 已经没了 */ }
            idx.delete(f);
            total -= e.size;
            st.evicted++;
        }
    }
    function store(h, img) {
        const f = h + '.' + img.ext;
        const tmp = path.join(dir, f + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
        try {
            fs.writeFileSync(tmp, img.buf);
            fs.renameSync(tmp, path.join(dir, f));
            const old = idx.get(f);
            if (old) total -= old.size;
            idx.set(f, { size: img.buf.length, at: nowFn() });
            total += img.buf.length;
            evict();
        } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* 没写出来 */ } log('img cache write: ' + e.message); }
    }
    async function load(u) {
        let p = inflight.get(u);
        if (!p) {
            p = (async () => {
                await sem.acquire();
                try {
                    const buf = await fetchImage(u);
                    const b = Buffer.isBuffer(buf) ? buf : (buf && Buffer.isBuffer(buf.buf) ? buf.buf : null);
                    if (!b || b.length > C.maxBytes) throw new Error('too large or empty');
                    const kind = sniff(b);
                    if (!kind) throw new Error('not an image');
                    return { buf: b, ext: kind.ext, type: kind.type };
                } finally { sem.release(); }
            })().finally(() => inflight.delete(u));
            inflight.set(u, p);
        }
        return p;
    }
    function send(res, type, body) {
        res.set('Content-Type', type);
        res.set('Cache-Control', 'private, max-age=' + C.maxAgeSec);
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "default-src 'none'");
        res.status(200).end(body);
    }
    // Express 处理函数(鉴权由调用方挂在前面)。只看 k / s 两个参数
    async function handle(req, res) {
        const q = (req && req.query) || {};
        const k = typeof q.k === 'string' ? q.k : '';
        const s = typeof q.s === 'string' ? q.s : '';
        if (!/^[ct]:./.test(k) || k.length > 300 || (s && !/^[A-Za-z0-9_.:-]{1,64}$/.test(s))) { res.set('Cache-Control', 'no-store'); return res.status(400).json({ error: 'BAD_KEY' }); }
        let u = null;
        try { u = await resolve(k, s || ''); } catch (_) { u = null; }
        // 第三阶段:resolve 可以给几个候选(线路封面在前、AVDB 封面兜底):前一个取不到(死链 / 被拒)就试下一个
        const cands = (Array.isArray(u) ? u : [u]).filter((x) => typeof x === 'string' && x).slice(0, 3);
        if (!cands.length) { st.notFound++; res.set('Cache-Control', 'no-store'); return res.status(404).json({ error: 'NOT_FOUND' }); }
        loadIndex();
        let tried = 0;
        for (const url of cands) {
            try { checkUrl(url); } catch (e) { st.refused++; continue; }
            tried++;
            const h = hashOf(url);
            const f = cached(h);
            if (f) {
                const e = idx.get(f);
                let body = null;
                try { body = fs.readFileSync(path.join(dir, f)); } catch (_) { idx.delete(f); total -= e.size; }
                if (body) {
                    st.hits++;
                    e.at = nowFn();
                    const t = new Date();
                    fs.utimes(path.join(dir, f), t, t, () => {});
                    return send(res, EXT_TYPE[f.split('.').pop()], body);
                }
            }
            const until = neg.get(url);
            if (until && until > nowFn()) continue;
            st.misses++;
            try {
                const img = await load(url);
                st.fetched++;
                store(h, img);
                return send(res, img.type, img.buf);
            } catch (e) {
                if (/refused|private|EPRIVATE/i.test(String(e && (e.code || e.message)))) st.refused++; else st.errors++;
                if (neg.size >= C.negMax) neg.clear();
                neg.set(url, nowFn() + C.negMs);
            }
        }
        if (!res.headersSent) { res.set('Cache-Control', 'no-store'); res.status(502).json({ error: tried ? 'UPSTREAM' : 'REFUSED' }); }
    }
    function stats() { loadIndex(); return Object.assign({ files: idx.size, bytes: total, capBytes }, st); }
    return { handle, stats, _evict: evict };
}

module.exports = { createImgProxy, isPrivateAddr, v6Groups, sniff, checkUrl, safeLookup, defaultFetch, EXT_TYPE };
