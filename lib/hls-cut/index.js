'use strict';
// ✂️ 剪掉插播后的 HLS 清单托管(server.js 用;Vercel 的 api/index.js 无状态,只挂 501 桩)。
//
// 为什么要服务器:用户要求插播广告"整片去掉、进度条里都不能有"。hls.js 通道(电脑/安卓)在浏览器里换掉清单文本即可,
//   但 Safari 原生 HLS(iPad/iPhone/Mac)只认 http(s) 清单地址(iOS 上 blob:/data: 清单播不了),AirPlay/Chromecast 的接收端
//   也是自己去拉地址 —— 剪好的清单必须有一个本站地址。服务器只存客户端交上来的清单文本,自己绝不去拉 m3u8/分片
//   (守"VPS 绝不拉 m3u8"铁律;资源站也多封机房 IP)。
//
// 两个用法:
//   ① 先占位再交付(Safari 原生):前端在 DPlayer 设好 src 的同一刻把 video.src 换成 /api/hls/cut/<自己生成的 id>.m3u8,
//      Safari 来拉时如果客户端还在扫描,GET 最多等 WAIT_MS 毫秒,等 POST 交上来立刻返回 —— src 只设一次,
//      不碰 iOS 的自动播放/AbortError(换 src 才会有的那些坑)。
//   ② 直接交付(投屏):POST 不带 id,服务器生成一个,返回地址。
// 安全:
//   · 不回显客户端文本:逐行解析后按白名单重建(只留 VERSION/TARGETDURATION/MEDIA-SEQUENCE/DISCONTINUITY-SEQUENCE/
//     PLAYLIST-TYPE/INDEPENDENT-SEGMENTS/DISCONTINUITY/EXTINF/GAP/ENDLIST);分片地址必须是公网绝对 http(s);
//     拒绝主清单/加密/fMP4/BYTERANGE/直播/变量替换;响应带 nosniff + CSP sandbox。
//   · id 是 144 位随机数(客户端 crypto.getRandomValues 或服务器 randomBytes),GET 不鉴权(AirPlay/投屏接收端没有登录态)。
//   · 内存按字节 LRU(默认 64MB/4000 条)、空闲 6h/最长 24h 过期;每个来源最多 MAX_PER_OWNER 条;POST 每 IP 限流 + 全站预算;
//     占位等待的 GET 全站/每 IP 都有并发上限(防止有人拿随机 id 挂住连接)。
const crypto = require('crypto');
const zlib = require('zlib');
let assertPublicHttpUrl = null;
try { ({ assertPublicHttpUrl } = require('../kazumi/resolvers')); } catch (e) { /* 依赖缺失时退化为只校验协议 */ }

const ID_RE = /^[A-Za-z0-9_-]{24}$/;
const DEF = {
    maxBytes: 64 * 1024 * 1024,      // 存储上限(压缩后字节)
    maxEntries: 4000,
    idleMs: 6 * 3600e3,              // 空闲过期(每次 GET 续期:AirPlay 接力/Safari 重连会再拉)
    hardMs: 24 * 3600e3,             // 创建后最长存活
    maxInput: 2 * 1024 * 1024,       // POST 清单文本上限
    maxSegs: 20000,
    maxDur: 6 * 3600,                // 总时长上限(与片头标记同口径)
    maxHosts: 16,
    maxPerOwner: 12,
    waitMs: 12000,                   // 占位 GET 最多等多久(前端自己的预算 ≤ 5s,留余量给慢网的 POST)
    maxWaiters: 300,
    maxWaitersPerIp: 8,
    globalPerMin: 600,               // 全站每分钟最多创建多少条(IP 限流可被伪造头绕过,兜一道总闸)
};

// ---------- 清单规范化(纯函数,测试直接调) ----------
// 返回 { ok:true, text, segs, dur } 或 { ok:false, why }
function canonicalize(input, opts) {
    const o = Object.assign({}, DEF, opts || {});
    if (typeof input !== 'string') return { ok: false, why: 'not_string' };
    if (Buffer.byteLength(input) > o.maxInput) return { ok: false, why: 'too_large' };
    const text = input.replace(/^﻿/, '');
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) return { ok: false, why: 'control_chars' };
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length || lines[i].trim() !== '#EXTM3U') return { ok: false, why: 'no_extm3u' };
    let version = 3, target = 0, mseq = null, dseq = null, indep = false, ended = false;
    const segs = [];
    let pendInf = null, pendDisc = false, pendGap = false, maxInf = 0, total = 0;
    const hosts = new Set();
    for (i = i + 1; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l) continue;
        if (l.length > 8192) return { ok: false, why: 'line_too_long' };
        if (l[0] === '#') {
            const tag = (/^#([A-Z0-9-]+)/i.exec(l) || [])[1];
            const up = tag ? tag.toUpperCase() : '';
            const val = l.slice(up.length + 2);
            switch (up) {
                case 'EXT-X-STREAM-INF': case 'EXT-X-I-FRAME-STREAM-INF': case 'EXT-X-MEDIA':
                    return { ok: false, why: 'master' };
                case 'EXT-X-MAP': case 'EXT-X-BYTERANGE': case 'EXT-X-SESSION-KEY': case 'EXT-X-SESSION-DATA': case 'EXT-X-DEFINE':
                    return { ok: false, why: 'unsupported_' + up.toLowerCase() };
                case 'EXT-X-KEY':
                    if (!/METHOD=NONE/i.test(val)) return { ok: false, why: 'encrypted' };
                    break;
                case 'EXT-X-PLAYLIST-TYPE':
                    if (/EVENT/i.test(val)) return { ok: false, why: 'live' };
                    break;
                case 'EXT-X-VERSION': { const v = parseInt(val, 10); if (v >= 1 && v <= 10) version = v; break; }
                case 'EXT-X-TARGETDURATION': { const v = parseInt(val, 10); if (v > 0 && v <= 600) target = v; break; }
                case 'EXT-X-MEDIA-SEQUENCE': { const v = parseInt(val, 10); if (v >= 0 && v < 1e12) mseq = v; break; }
                case 'EXT-X-DISCONTINUITY-SEQUENCE': { const v = parseInt(val, 10); if (v >= 0 && v < 1e12) dseq = v; break; }
                case 'EXT-X-INDEPENDENT-SEGMENTS': indep = true; break;
                case 'EXT-X-DISCONTINUITY': pendDisc = true; break;
                case 'EXT-X-GAP': pendGap = true; break;
                case 'EXT-X-ENDLIST': ended = true; break;
                case 'EXTINF': {
                    const d = parseFloat(val);
                    if (!isFinite(d) || d < 0 || d > 600) return { ok: false, why: 'bad_extinf' };
                    if (pendInf != null) return { ok: false, why: 'extinf_twice' };
                    pendInf = d;
                    break;
                }
                default: break;   // 其余标签(含 DATERANGE 插播、PROGRAM-DATE-TIME、LL-HLS)一律丢弃
            }
            continue;
        }
        if (ended) return { ok: false, why: 'after_endlist' };
        if (pendInf == null) return { ok: false, why: 'uri_without_extinf' };
        let url;
        try { url = new URL(l); } catch (e) { return { ok: false, why: 'relative_or_bad_uri' }; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, why: 'bad_scheme' };
        if (url.username || url.password) return { ok: false, why: 'userinfo' };
        if (assertPublicHttpUrl) { try { assertPublicHttpUrl(url.href); } catch (e) { return { ok: false, why: 'private_host' }; } }
        hosts.add(url.host);
        if (hosts.size > o.maxHosts) return { ok: false, why: 'too_many_hosts' };
        segs.push({ d: pendInf, u: url.href, disc: pendDisc, gap: pendGap });
        if (segs.length > o.maxSegs) return { ok: false, why: 'too_many_segments' };
        maxInf = Math.max(maxInf, pendInf);
        total += pendInf;
        pendInf = null; pendDisc = false; pendGap = false;
    }
    if (!ended) return { ok: false, why: 'no_endlist' };
    if (!segs.length) return { ok: false, why: 'empty' };
    if (total > o.maxDur) return { ok: false, why: 'too_long' };
    // Safari 要求每个分片的 EXTINF 四舍五入后 ≤ TARGETDURATION
    target = Math.max(target, Math.ceil(maxInf - 1e-9), 1);
    const out = ['#EXTM3U', '#EXT-X-VERSION:' + version, '#EXT-X-TARGETDURATION:' + target];
    if (mseq != null) out.push('#EXT-X-MEDIA-SEQUENCE:' + mseq);
    if (dseq != null) out.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + dseq);
    out.push('#EXT-X-PLAYLIST-TYPE:VOD');
    if (indep) out.push('#EXT-X-INDEPENDENT-SEGMENTS');
    for (const s of segs) {
        if (s.disc) out.push('#EXT-X-DISCONTINUITY');
        if (s.gap) out.push('#EXT-X-GAP');
        out.push('#EXTINF:' + (+s.d.toFixed(6)) + ',');
        out.push(s.u);
    }
    out.push('#EXT-X-ENDLIST');
    return { ok: true, text: out.join('\n') + '\n', segs: segs.length, dur: total };
}

// ---------- 存储(按字节的 LRU + 过期 + 占位等待) ----------
function createStore(opts) {
    const o = Object.assign({}, DEF, opts || {});
    const map = new Map();              // id -> { gz, raw, sha, owner, at, seen, exp }(插入/访问序 = LRU 序)
    const waiters = new Map();          // id -> [{ resolve, ip }]
    let bytes = 0, waitN = 0;
    const waitPerIp = new Map();
    const now = () => Date.now();
    const drop = (id) => { const e = map.get(id); if (!e) return; bytes -= e.gz.length; map.delete(id); };
    const live = (e, t) => e && t - e.seen < o.idleMs && t - e.at < o.hardMs;
    function evict() {
        const t = now();
        for (const [id, e] of map) { if (!live(e, t)) drop(id); }
        while ((bytes > o.maxBytes || map.size > o.maxEntries) && map.size) drop(map.keys().next().value);
    }
    function get(id) {
        const e = map.get(id);
        if (!e) return null;
        const t = now();
        if (!live(e, t)) { drop(id); return null; }
        e.seen = t;
        map.delete(id); map.set(id, e);    // 访问即续到队尾
        return e;
    }
    // 交付:id 已被别的来源占了 → 拒绝(防止猜到别人的 id 后覆盖);同一来源同一内容 → 幂等返回
    function put(id, owner, text) {
        const sha = crypto.createHash('sha256').update(text).digest('hex');
        const old = map.get(id);
        if (old) {
            if (old.owner !== owner) return { ok: false, why: 'taken' };
            if (old.sha === sha) { old.seen = now(); return { ok: true, id }; }
            drop(id);
        }
        // 同一来源最多 maxPerOwner 条,超了挤掉它自己最老的
        const mine = [];
        for (const [k, e] of map) if (e.owner === owner) mine.push(k);
        while (mine.length >= o.maxPerOwner) drop(mine.shift());
        const gz = zlib.gzipSync(Buffer.from(text), { level: 6 });
        const t = now();
        map.set(id, { gz, raw: Buffer.byteLength(text), sha, owner, at: t, seen: t });
        bytes += gz.length;
        evict();
        const ws = waiters.get(id);
        if (ws) { waiters.delete(id); ws.forEach(w => w.resolve(true)); }
        return { ok: true, id };
    }
    // 占位等待:id 还没交付时挂起,交付或超时后返回。并发等待数有全站/每 IP 上限
    function waitFor(id, ip, ms) {
        if (map.has(id)) return Promise.resolve(true);
        const perIp = waitPerIp.get(ip) || 0;
        if (waitN >= o.maxWaiters || perIp >= o.maxWaitersPerIp) return Promise.resolve(false);
        waitN++; waitPerIp.set(ip, perIp + 1);
        return new Promise((resolve) => {
            let done = false;
            const fin = (v) => {
                if (done) return; done = true;
                clearTimeout(timer);
                waitN--; const n = (waitPerIp.get(ip) || 1) - 1; if (n > 0) waitPerIp.set(ip, n); else waitPerIp.delete(ip);
                const ws = waiters.get(id);
                if (ws) { const k = ws.indexOf(w); if (k >= 0) ws.splice(k, 1); if (!ws.length) waiters.delete(id); }
                resolve(v);
            };
            const w = { resolve: fin, ip };
            if (!waiters.has(id)) waiters.set(id, []);
            waiters.get(id).push(w);
            const timer = setTimeout(() => fin(false), ms);
            if (timer.unref) timer.unref();
        });
    }
    const sweep = setInterval(evict, 10 * 60e3);
    if (sweep.unref) sweep.unref();
    return { get, put, waitFor, evict, stats: () => ({ entries: map.size, bytes, waiting: waitN }), _close: () => clearInterval(sweep) };
}

// ---------- 路由 ----------
// opts: { enabled, ownerOf(req) -> string, authorize(token) -> 'ok'|'unauth'|'banned', postLimiter, store, ipOf(req) }
function registerRoutes(app, opts) {
    opts = opts || {};
    const store = opts.store || createStore(opts.storeOpts);
    const ipOf = opts.ipOf || ((req) => req.ip || '0.0.0.0');
    const ownerOf = opts.ownerOf || ipOf;
    const authorize = opts.authorize || (() => 'ok');
    let winStart = 0, winCount = 0;
    const budgetOk = () => {
        const t = Date.now();
        if (t - winStart > 60e3) { winStart = t; winCount = 0; }
        return ++winCount <= (opts.globalPerMin || DEF.globalPerMin);
    };
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    const mw = opts.postLimiter ? [opts.postLimiter] : [];
    app.post('/api/hls/cut', ...mw, (req, res) => {
        noStore(res);
        if (opts.enabled === false) return res.status(501).json({ error: 'disabled' });
        const b = req.body || {};
        const auth = authorize(typeof b.token === 'string' ? b.token : '');
        if (auth === 'banned') return res.status(403).json({ error: 'banned' });
        if (auth !== 'ok') return res.status(401).json({ error: 'Invalid token' });
        if (!budgetOk()) return res.status(429).json({ error: 'busy' });
        let id = b.id;
        if (id != null && (typeof id !== 'string' || !ID_RE.test(id))) return res.status(400).json({ error: 'bad_id' });
        const c = canonicalize(b.m3u8);
        if (!c.ok) return res.status(c.why === 'too_large' ? 413 : 400).json({ error: 'bad_m3u8', why: c.why });
        if (!id) id = crypto.randomBytes(18).toString('base64url');
        const r = store.put(id, ownerOf(req, b), c.text);
        if (!r.ok) return res.status(409).json({ error: r.why });
        res.json({ id, url: '/api/hls/cut/' + id + '.m3u8', segs: c.segs, dur: +c.dur.toFixed(3) });
    });
    app.get('/api/hls/cut/:file', async (req, res) => {
        noStore(res);
        const m = /^([A-Za-z0-9_-]{24})\.m3u8$/.exec(String(req.params.file || ''));
        if (!m || opts.enabled === false) return res.status(404).json({ error: 'gone' });
        const id = m[1];
        let e = store.get(id);
        // 还没交付 = 占位地址:等客户端交付(地址里不能带查询串标记 —— WebKit 可能把清单地址的查询串抄到分片请求上;
        //   随便拿个 id 来挂连接的,受全站/每 IP 等待并发上限约束)
        if (!e) {
            const ok = await store.waitFor(id, ipOf(req), opts.waitMs || DEF.waitMs);
            if (ok) e = store.get(id);
        }
        if (!e) return res.status(404).json({ error: 'gone' });
        res.set({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Referrer-Policy': 'no-referrer',
            'Vary': 'Accept-Encoding'
        });
        if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
            res.set('Content-Encoding', 'gzip');
            return res.end(e.gz);
        }
        res.end(zlib.gunzipSync(e.gz));
    });
    return store;
}

// Vercel 等无状态后端:同一路径回 501(前端据 /api/config 的 hls_cut:false 根本不会来,这里只是兜底)
function registerStub(app) {
    app.all(['/api/hls/cut', '/api/hls/cut/:file'], (req, res) => res.status(501).set('Cache-Control', 'no-store').json({ error: 'unsupported', reason: 'stateless' }));
}

module.exports = { canonicalize, createStore, registerRoutes, registerStub, ID_RE, DEF };
