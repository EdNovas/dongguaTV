#!/usr/bin/env node
'use strict';
// Telegram 频道视频中转(给成人站用;单独部署在流量不限的服务器上)
//   GET  /v/<频道>/<消息id>?e=&s=   视频,支持 Range(拖动进度条);签名地址只有成人站能生成
//   GET  /t/<频道>/<消息id>?e=&s=   封面(视频自带的缩略图)
//   GET  /api/list?ch=&after=&limit=&info=1   频道里的视频消息(成人站抓取用,要 Authorization: Bearer <RELAY_SECRET>)
//   GET  /api/msg?ch=&id=           单条视频消息(同上要密钥)
//   GET  /api/health                账号 / 缓存状态(同上要密钥)
//   GET  /healthz                   存活检查
// 账号:node login.js 登录(可以登录多个,读频道和下载会分摊到各个账号上)
const http = require('http');
const path = require('path');
const { once } = require('events');
const { loadEnv, verify, sameSecret, log, parseRange, CH_RE } = require('./lib/common');

loadEnv(__dirname);
const { Pool, videoOf, errName } = require('./lib/pool');
const { ChunkCache, Media, CHUNK } = require('./lib/media');

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
    streams++;
    try {
        for (let n = first; n <= last && !gone; n++) {
            // 预取后面两块(播放器是顺着读的,省掉每块之间的等待)
            for (let k = n + 1; k <= Math.min(n + 2, last); k++) media.chunk(ch, id, meta, k).catch(() => {});
            const buf = await media.chunk(ch, id, meta, n);
            if (gone) break;
            const s = n === first ? start - n * CHUNK : 0;
            const e = n === last ? end - n * CHUNK + 1 : buf.length;
            if (!res.write(buf.subarray(s, e)) && !gone) await Promise.race([once(res, 'drain'), once(res, 'close')]);
        }
        if (!gone) res.end();
    } finally {
        streams--;
    }
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
    if (!CH_RE.test(ch) || !/^[1-9]d{0,11}$/.test(id)) { fail(res, 400, 'BAD_INPUT'); return; }
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
        const m = /^\/([vt])\/([A-Za-z][A-Za-z0-9_]{3,31})\/([1-9]\d{0,11})(?:\.(?:mp4|jpg))?$/.exec(u.pathname);
        if (m) {
            const [, kind, ch, id] = m;
            if (!verify(SECRET, kind, ch, id, u.searchParams.get('e'), u.searchParams.get('s'), nowSec())) { fail(res, 403, 'BAD_SIGNATURE'); return; }
            if (kind === 'v') {
                if (streams >= MAX_STREAMS) { res.setHeader('Retry-After', '5'); fail(res, 503, 'BUSY'); return; }
                await serveVideo(req, res, ch, id);
            } else await serveThumb(req, res, ch, id);
            return;
        }
        if (u.pathname.startsWith('/api/')) {
            const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (!sameSecret(auth, SECRET)) { fail(res, 401, 'UNAUTHORIZED'); return; }
            if (u.pathname === '/api/list') { await apiList(u, res); return; }
            if (u.pathname === '/api/msg') { await apiMsg(u, res); return; }
            if (u.pathname === '/api/health') {
                json(res, 200, { ok: true, accounts: pool.status(), usable: pool.usable().length, streams, cache: cache.stat(), fromTg: media.bytesFromTg, fromCache: media.bytesFromCache });
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

