#!/usr/bin/env node
'use strict';
// Telegram 频道视频中转(给成人站用;单独部署在流量不限的服务器上)
//   GET  /v/<频道>/<消息id>?e=&s=   视频,支持 Range(拖动进度条);签名地址只有成人站能生成
//   GET  /t/<频道>/<消息id>?e=&s=   封面(视频自带的缩略图)
//   GET  /p/<频道>/<消息id>?e=&s=   卡片预览片(几段 2.5 秒拼成的 360p 静音 MP4,第一次要时用 ffmpeg 做、存磁盘;没装 ffmpeg → 501)
//   GET  /api/list?ch=&after=&limit=&info=1   频道里的视频消息(成人站抓取用,要 Authorization: Bearer <RELAY_SECRET>)
//   GET  /api/msg?ch=&id=           单条视频消息(同上要密钥)
//   GET  /api/health                账号 / 缓存状态(同上要密钥)
//   GET  /healthz                   存活检查
// 账号:node login.js 登录(可以登录多个,读频道和下载会分摊到各个账号上)
const http = require('http');
const path = require('path');
const { loadEnv, verify, sameSecret, log, parseRange, CH_RE, sign } = require('./lib/common');

loadEnv(__dirname);
const { Pool, videoOf, errName } = require('./lib/pool');
const { ChunkCache, Media, CHUNK } = require('./lib/media');
const { Previews } = require('./lib/preview');

const ENV = process.env;
const SECRET = String(ENV.RELAY_SECRET || '');
const DATA = path.resolve(__dirname, ENV.RELAY_DATA || 'data');
const PORT = Number(ENV.RELAY_PORT || 8790);
const HOST = ENV.RELAY_HOST || '0.0.0.0';
const CACHE_BYTES = Math.round(Number(ENV.RELAY_CACHE_GB || 20) * 1073741824);
const ALLOW_ORIGIN = ENV.RELAY_ALLOW_ORIGIN || '*';
const MAX_STREAMS = Math.max(1, Number(ENV.RELAY_MAX_STREAMS || 60));

if (SECRET.length < 16) { console.error('RELAY_SECRET 没设或太短(至少 16 位):成人站要用同一个值(ADULT_TG_SECRET)'); process.exit(1); }
if (!ENV.TG_API_ID || !ENV.TG_API_HASH) { console.error('缺 TG_API_ID / TG_API_HASH(在 https://my.telegram.org 的 API development tools 里申请)'); process.exit(1); }

const pool = new Pool({ apiId: ENV.TG_API_ID, apiHash: ENV.TG_API_HASH, dataDir: DATA });
const cache = new ChunkCache(path.join(DATA, 'cache'), CACHE_BYTES);
const media = new Media(pool, cache, path.join(DATA, 'thumbs'));
let streams = 0;

const nowSec = () => Math.floor(Date.now() / 1000);
// 预览片:ffmpeg 从本机自己的 /v/ 读源视频(走同一套分块缓存)
const LOOP_HOST = /^(0\.0\.0\.0|::|)$/.test(HOST) ? '127.0.0.1' : (HOST.indexOf(':') >= 0 ? '[' + HOST + ']' : HOST);
const previews = new Previews({
    dir: path.join(DATA, 'previews'),
    capBytes: Math.round(Number(ENV.RELAY_PREVIEW_GB || 10) * 1073741824),
    par: Math.max(1, Number(ENV.RELAY_PREVIEW_PAR || 2)),
    ffmpeg: ENV.RELAY_FFMPEG || 'ffmpeg',
    meta: (ch, id) => pool.videoMeta(ch, id),
    srcUrl: (ch, id) => { const e = nowSec() + 3600; return 'http://' + LOOP_HOST + ':' + PORT + '/v/' + ch + '/' + id + '?e=' + e + '&s=' + sign(SECRET, 'v', ch, id, e); },
    warm: (ch, id, meta, clips) => warmClips(ch, id, meta, clips),
});
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}
function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}
function fail(res, code, msg) {
    if (res.headersSent) { res.destroy(); return; }
    json(res, code, { error: msg });
}
const httpCodeOf = (e) => {
    const n = errName(e);
    if (/not-found|not-video|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|MSG_ID_INVALID|CHANNEL_INVALID/.test(n)) return 404;
    if (/CHANNEL_PRIVATE|CHAT_FORBIDDEN/.test(n)) return 403;
    return 502;
};

// 背压:等 drain 或连接关掉;两个监听一起摘(旧写法 Promise.race 两个 once(),赢的那个摘了、输的那个留在 res 上,
//   长视频几千块写下来监听越积越多 → MaxListenersExceededWarning)
function waitWritable(res) {
    return new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); res.off('error', done); resolve(); };
        res.on('drain', done); res.on('close', done); res.on('error', done);
    });
}
// 很多 TG 长视频的 MP4 是 ftyp → mdat(几 GB)→ moov(几 MB~十几 MB)。浏览器先读开头、发现是 mdat 就跳到文件尾读完整个 moov
//   才能起播;尾巴一块一块顺着拉(只预取 2 块)要十几秒,播放器的起播看门狗先判死。
//   ① 第 0 块一到手就看顶层 box:先是 mdat → 把 mdat 后面的尾巴(≤ TAIL_MAX 块)后台并发拉进缓存
//   ② 读到文件尾的短区间(就是浏览器读 moov 那一下)整段并发取,不再 2 块 2 块地等
const TAIL_MAX = 32, TAIL_PAR = 6;
const tailDone = new Map();   // ch/id -> 时间(10 分钟内不重复排)
function tailStartOf(buf, size) {
    let off = 0;
    while (off + 8 <= buf.length) {
        let sz = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (sz === 1) { if (off + 16 > buf.length) return -1; sz = Number(buf.readBigUInt64BE(off + 8)); } else if (sz === 0) sz = size - off;
        if (sz < 8) return -1;
        if (type === 'moov') return -1;                       // moov 在前面(faststart)
        if (type === 'mdat') return off + sz < size ? off + sz : -1;
        off += sz;
    }
    return -1;
}
function prefetchChunks(ch, id, meta, a, b) {
    let next = a;
    const worker = async () => { while (next <= b) { const k = next++; try { await media.chunk(ch, id, meta, k); } catch (_) { return; } } };
    for (let i = 0; i < Math.min(TAIL_PAR, b - a + 1); i++) worker();
}
function prefetchTail(ch, id, meta, buf0) {
    const key = ch + '/' + id, now = Date.now();
    if ((tailDone.get(key) || 0) > now - 600e3) return;
    const at = tailStartOf(buf0, meta.size);
    if (at < 0) return;
    const a = Math.floor(at / CHUNK), b = Math.floor((meta.size - 1) / CHUNK);
    if (b - a + 1 > TAIL_MAX) return;
    tailDone.set(key, now);
    if (tailDone.size > 2000) tailDone.delete(tailDone.keys().next().value);
    prefetchChunks(ch, id, meta, a, b);
}
// 做预览片之前:文件头、文件尾(moov 在尾巴上的那种)、每段按"时间比例 ≈ 字节比例"估的位置前后各一块,一起并发拉进缓存。
//   估得不准也没关系(只是预热):ffmpeg 真要哪块自己会去要
function warmClips(ch, id, meta, clips) {
    const size = Number(meta.size) || 0, dur = Number(meta.dur) || 0;
    if (!(size > 0 && dur > 0)) return;
    const last = Math.floor((size - 1) / CHUNK), want = new Set([0]);
    for (const c of clips) {
        const n = Math.floor(size * Math.min(1, c.ss / dur) / CHUNK);
        for (let k = n - 1; k <= n + 1 + Math.ceil(c.t / 4); k++) if (k >= 0 && k <= last) want.add(k);
    }
    const list = [...want].sort((x, y) => x - y);
    let i = 0;
    const worker = async () => {
        while (i < list.length) {
            const k = list[i++];
            try { const buf = await media.chunk(ch, id, meta, k); if (k === 0) prefetchTail(ch, id, meta, buf); } catch (_) { return; }
        }
    };
    for (let w = 0; w < Math.min(TAIL_PAR, list.length); w++) worker();
}

async function serveVideo(req, res, ch, id) {
    const meta = await pool.videoMeta(ch, id);
    const size = meta.size;
    // Chrome 能直接放 .mov 里的 H.264;按 mp4 报类型
    const mime = /quicktime/i.test(meta.mime) || !meta.mime ? 'video/mp4' : meta.mime;
    const rg = req.headers.range ? parseRange(req.headers.range, size) : null;
    if (rg === false) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); res.end(); return; }
    const [start, end] = rg || [0, size - 1];
    res.writeHead(rg ? 206 : 200, Object.assign({
        'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
        'Cache-Control': 'private, max-age=3600',
    }, rg ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size } : {}));
    if (req.method === 'HEAD') { res.end(); return; }
    let gone = false;
    res.on('close', () => { gone = true; });
    const first = Math.floor(start / CHUNK), last = Math.floor(end / CHUNK);
    // 本机 ffmpeg 做预览片的读(只从环回地址来才认):每段只读几秒,不顺着往后预取
    const pv = req.headers['x-relay-preview'] === '1' && /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket && req.socket.remoteAddress));
    if (end === size - 1 && first > 0 && last - first + 1 <= TAIL_MAX) prefetchChunks(ch, id, meta, first, last);   // ② 读 moov 的那一下
    streams++;
    try {
        for (let n = first; n <= last && !gone; n++) {
            // 预取后面两块(播放器是顺着读的,省掉每块之间的等待)
            if (!pv) for (let k = n + 1; k <= Math.min(n + 2, last); k++) media.chunk(ch, id, meta, k).catch(() => {});
            const buf = await media.chunk(ch, id, meta, n);
            if (n === 0) prefetchTail(ch, id, meta, buf);   // ①
            if (gone) break;
            const s = n === first ? start - n * CHUNK : 0;
            const e = n === last ? end - n * CHUNK + 1 : buf.length;
            if (!res.write(buf.subarray(s, e)) && !gone) await waitWritable(res);
        }
        if (!gone) res.end();
    } finally {
        streams--;
    }
}

async function servePreview(req, res, ch, id) {
    let buf;
    try { buf = await previews.get(ch, id); } catch (e) {
        if (e && e.pvCode === 'no-ffmpeg') { fail(res, 501, 'NO_FFMPEG'); return; }
        if (e && e.pvCode === 'busy') { res.setHeader('Retry-After', '10'); fail(res, 503, 'BUSY'); return; }
        if (e && e.pvCode === 'failed') { fail(res, 422, 'NO_PREVIEW'); return; }
        throw e;
    }
    const rg = req.headers.range ? parseRange(req.headers.range, buf.length) : null;
    if (rg === false) { res.writeHead(416, { 'Content-Range': 'bytes */' + buf.length }); res.end(); return; }
    const [a, b] = rg || [0, buf.length - 1];
    res.writeHead(rg ? 206 : 200, Object.assign({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1, 'Cache-Control': 'private, max-age=86400' },
        rg ? { 'Content-Range': 'bytes ' + a + '-' + b + '/' + buf.length } : {}));
    res.end(req.method === 'HEAD' ? undefined : buf.subarray(a, b + 1));
}

async function serveThumb(req, res, ch, id) {
    const buf = await media.thumb(ch, id);
    if (!buf) { fail(res, 404, 'NO_THUMB'); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=2592000, immutable' });
    res.end(req.method === 'HEAD' ? undefined : buf);
}

// 一条视频消息给成人站的样子(配文为空时用同一相册里别的消息的配文)
function itemOf(m, v, groupCaption) {
    return {
        id: m.id, date: m.date | 0, text: String(m.message || groupCaption || '').slice(0, 4000), gid: m.groupedId ? m.groupedId.toString() : '',
        dur: v.dur, w: v.w, h: v.h, size: v.size, mime: v.mime, stream: v.stream, thumb: v.thumbs.length > 0, name: v.name,
        views: m.views | 0, fwd: !!m.fwdFrom,
    };
}

// 单条消息(成人站详情页 / 继续观看用)
async function apiMsg(u, res) {
    const ch = String(u.searchParams.get('ch') || '');
    const id = String(u.searchParams.get('id') || '');
    if (!CH_RE.test(ch) || !/^[1-9]\d{0,11}$/.test(id)) { fail(res, 400, 'BAD_INPUT'); return; }
    const item = await pool.run(async (a) => {
        const m = await pool.message(a, ch, id);
        const v = videoOf(m);
        if (!v) return null;
        let cap = '';
        if (!m.message && m.groupedId) {
            // 相册:配文在同组别的消息上(同组消息 id 相邻)
            const peer = await pool.peer(a, ch);
            const near = await a.client.getMessages(peer, { ids: [-9, -8, -7, -6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => Number(id) + d).filter((x) => x > 0) });
            const g = (near || []).find((x) => x && x.groupedId && x.groupedId.toString() === m.groupedId.toString() && x.message);
            cap = g ? g.message : '';
        }
        return itemOf(m, v, cap);
    });
    if (!item) { fail(res, 404, 'NOT_VIDEO'); return; }
    json(res, 200, { ok: true, ch, item });
}

async function apiList(u, res) {
    const ch = String(u.searchParams.get('ch') || '');
    if (!CH_RE.test(ch)) { fail(res, 400, 'BAD_CHANNEL'); return; }
    const after = Math.max(0, Number(u.searchParams.get('after')) | 0);
    const limit = Math.min(100, Math.max(1, Number(u.searchParams.get('limit')) || 100));
    const wantInfo = u.searchParams.get('info') === '1';
    const out = await pool.run(async (a) => {
        await pool.readGate(a);
        const peer = await pool.peer(a, ch);
        const msgs = await a.client.getMessages(peer, { limit, minId: after, reverse: true });
        let info = null;
        if (wantInfo) {
            await pool.readGate(a);
            const { Api } = require('telegram');
            const full = await a.client.invoke(new Api.channels.GetFullChannel({ channel: await pool.inputChannel(a, ch) }));
            const e = await pool.entity(a, ch);
            const chat = (full.chats || []).find((c) => c.id && c.id.toString() === e.id) || {};
            const top = await a.client.getMessages(peer, { limit: 1 });
            info = {
                title: String(chat.title || e.title || ''), about: String((full.fullChat && full.fullChat.about) || ''),
                members: (full.fullChat && full.fullChat.participantsCount) || 0, top: (top && top[0] && top[0].id) || 0,
                noforwards: !!chat.noforwards,
            };
        }
        // 相册(一组多条消息)的配文常只写在其中一条上:同组的视频共用它
        const capOf = new Map();
        for (const m of msgs) if (m && m.groupedId && m.message) capOf.set(m.groupedId.toString(), m.message);
        const items = [];
        let next = after;
        for (const m of msgs) {
            if (!m || !m.id) continue;
            next = Math.max(next, m.id);
            const v = videoOf(m);
            if (!v) continue;
            const gid = m.groupedId ? m.groupedId.toString() : '';
            items.push(itemOf(m, v, gid && capOf.get(gid)));
        }
        return { ok: true, ch, info, next, done: msgs.length < limit, items };
    });
    json(res, 200, out);
}

const server = http.createServer(async (req, res) => {
    cors(res);
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (_) { fail(res, 400, 'BAD_URL'); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'METHOD'); return; }
    try {
        if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
        const m = /^\/([vtp])\/([A-Za-z][A-Za-z0-9_]{3,31})\/([1-9]\d{0,11})(?:\.(?:mp4|jpg))?$/.exec(u.pathname);
        if (m) {
            const [, kind, ch, id] = m;
            if (!verify(SECRET, kind, ch, id, u.searchParams.get('e'), u.searchParams.get('s'), nowSec())) { fail(res, 403, 'BAD_SIGNATURE'); return; }
            if (kind === 'v') {
                if (streams >= MAX_STREAMS) { res.setHeader('Retry-After', '5'); fail(res, 503, 'BUSY'); return; }
                await serveVideo(req, res, ch, id);
            } else if (kind === 'p') await servePreview(req, res, ch, id);
            else await serveThumb(req, res, ch, id);
            return;
        }
        if (u.pathname.startsWith('/api/')) {
            const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (!sameSecret(auth, SECRET)) { fail(res, 401, 'UNAUTHORIZED'); return; }
            if (u.pathname === '/api/list') { await apiList(u, res); return; }
            if (u.pathname === '/api/msg') { await apiMsg(u, res); return; }
            if (u.pathname === '/api/health') {
                json(res, 200, { ok: true, accounts: pool.status(), usable: pool.usable().length, streams, cache: cache.stat(), fromTg: media.bytesFromTg, fromCache: media.bytesFromCache, previews: previews.stat() });
                return;
            }
        }
        fail(res, 404, 'NOT_FOUND');
    } catch (e) {
        const code = e && e.code === 'no-account' ? 503 : httpCodeOf(e);
        if (code >= 500) log('[http]', req.method, u.pathname, errName(e));
        fail(res, code, code === 503 ? 'NO_ACCOUNT' : errName(e).slice(0, 80));
    }
});
server.requestTimeout = 0;          // 视频流可能放很久
server.headersTimeout = 30e3;
server.keepAliveTimeout = 65e3;

(async () => {
    cache.init();
    previews.init();
    await pool.start();
    server.listen(PORT, HOST, () => log('[relay] 监听', HOST + ':' + PORT, '账号', pool.usable().length, '个可用'));
})().catch((e) => { console.error(e); process.exit(1); });

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
        if (stopping) process.exit(1);
        stopping = true;
        log('[relay] 退出中…');
        server.close();
        await pool.stop().catch(() => {});
        process.exit(0);
    });
}

