'use strict';
// 多账号池:每个账号一个 MTProto 连接;读频道 / 下载分摊到空闲的账号上,
// 某个账号被限流(FLOOD_WAIT)就先歇着,被封 / 登出就停用(不影响其它账号)。
const fs = require('fs');
const path = require('path');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { readJson, writeJson, log } = require('./common');

const MSG_TTL = 40 * 60e3;        // 消息对象(里面的 file_reference 会过期)缓存多久
const MSG_CAP = 4000;
const META_CAP = 20000;
const READ_GAP = 1100;            // 同一账号两次读频道请求至少隔多久(下载不受这个限制)
const DEAD_ERR = /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|USER_DEACTIVATED_BAN|PHONE_NUMBER_BANNED/;
const NOT_ACCOUNT_ERR = /CHANNEL_PRIVATE|CHANNEL_INVALID|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|CHAT_FORBIDDEN|MSG_ID_INVALID|not-found|not-video/;

const errName = (e) => String((e && (e.errorMessage || e.code || e.message)) || e);
function floodSeconds(e) {
    if (e && typeof e.seconds === 'number') return e.seconds;
    const m = String((e && (e.errorMessage + ' ' + e.message)) || '').match(/FLOOD(?:_PREMIUM)?_WAIT_?(\d+)|SLOWMODE_WAIT_?(\d+)/);
    return m ? Number(m[1] || m[2]) : null;
}

// 消息里的视频(圆形视频消息不算);size 是大整数,转成 Number(< 4GB 没问题)
function videoOf(msg) {
    const d = msg && msg.media && msg.media.document;
    if (!(d instanceof Api.Document)) return null;
    const va = (d.attributes || []).find((a) => a instanceof Api.DocumentAttributeVideo);
    if (!va || va.roundMessage) return null;
    const fn = (d.attributes || []).find((a) => a instanceof Api.DocumentAttributeFilename);
    const thumbs = (d.thumbs || []).filter((t) => t instanceof Api.PhotoSize || t instanceof Api.PhotoSizeProgressive);
    return {
        id: d.id, accessHash: d.accessHash, fileReference: d.fileReference, dcId: d.dcId,
        docId: d.id.toString(), size: Number(d.size.toString()), mime: String(d.mimeType || ''),
        dur: Math.round(Number(va.duration) || 0), w: va.w | 0, h: va.h | 0, stream: !!va.supportsStreaming,
        name: fn ? String(fn.fileName || '') : '', thumbs,
    };
}

class Pool {
    constructor({ apiId, apiHash, dataDir }) {
        this.apiId = Number(apiId);
        this.apiHash = String(apiHash);
        this.dataDir = dataDir;
        this.file = path.join(dataDir, 'sessions.json');
        this.entFile = path.join(dataDir, 'entities.json');
        this.accts = new Map();      // name -> acct
        this.meta = new Map();       // 'ch/id' -> video meta(不带 file_reference,任何账号都能用)
        this.ents = readJson(this.entFile, {});   // { 账号名: { 频道(小写): { id, hash, title } } }
        this._rr = 0;
        this._mtime = 0;
        this._entSaveT = null;
    }

    async start() {
        await this.sync();
        this._watch = setInterval(() => { this.sync().catch((e) => log('[pool] 读账号文件失败', errName(e))); }, 30e3);
        this._watch.unref();
    }

    // sessions.json 变了(login.js 加了 / 删了账号)就增减连接,不用重启
    async sync() {
        let st;
        try { st = fs.statSync(this.file); } catch (_) { if (!this.accts.size) log('[pool] 还没有账号:先运行 node login.js'); return; }
        if (st.mtimeMs === this._mtime) return;
        this._mtime = st.mtimeMs;
        const list = readJson(this.file, []);
        const want = new Map((Array.isArray(list) ? list : []).filter((s) => s && s.name && s.session).map((s) => [String(s.name), s]));
        for (const [name, a] of this.accts) {
            if (!want.has(name) || want.get(name).session !== a.session) {
                this.accts.delete(name);
                a.client.disconnect().catch(() => {});
                log('[pool] 移除账号', name);
            }
        }
        for (const [name, s] of want) if (!this.accts.has(name)) await this._connect(name, s.session);
    }

    async _connect(name, session) {
        const client = new TelegramClient(new StringSession(session), this.apiId, this.apiHash, { connectionRetries: 5, retryDelay: 2000, autoReconnect: true });
        client.setLogLevel('error');
        const a = { name, session, client, ok: false, dead: '', floodUntil: 0, active: 0, served: 0, errors: 0, lastErr: '', readAt: 0, msgs: new Map(), ents: new Map(Object.entries(this.ents[name] || {})) };
        this.accts.set(name, a);
        try {
            await client.connect();
            const me = await client.getMe();
            if (!me) throw new Error('getMe-empty');
            a.ok = true;
            log('[pool] 账号已连接', name);
        } catch (e) {
            a.lastErr = errName(e);
            if (DEAD_ERR.test(a.lastErr)) a.dead = a.lastErr;
            log('[pool] 账号连接失败', name, a.lastErr);
        }
    }

    usable(now) {
        const t = now || Date.now();
        return [...this.accts.values()].filter((a) => a.ok && !a.dead && a.floodUntil <= t);
    }

    _pick(skip, now) {
        const list = this.usable(now).filter((a) => !skip.has(a.name));
        if (!list.length) return null;
        let min = Infinity;
        for (const a of list) min = Math.min(min, a.active);
        const low = list.filter((a) => a.active === min);
        return low[(this._rr++) % low.length];
    }

    // 找一个空闲账号执行 fn(acct);限流 / 被封就换下一个账号再试
    async run(fn, opts) {
        const tries = (opts && opts.tries) || 4;
        const skip = new Set();
        let last = null;
        for (let i = 0; i < tries; i++) {
            const a = this._pick(skip);
            if (!a) break;
            a.active++;
            try {
                const r = await fn(a);
                a.served++;
                return r;
            } catch (e) {
                const name = errName(e);
                last = e;
                a.lastErr = name;
                const fw = floodSeconds(e);
                if (fw != null) {
                    // FLOOD_WAIT_X / SLOWMODE_WAIT_X;非会员下载太快还会收到 FLOOD_PREMIUM_WAIT_X(限速)—— 一样先歇着,换别的账号
                    a.floodUntil = Date.now() + (fw + 2) * 1000;
                    log('[pool] 账号限流', a.name, fw + 's', name);
                } else if (DEAD_ERR.test(name)) {
                    a.dead = name;
                    log('[pool] 账号失效,停用', a.name, name);
                } else if (NOT_ACCOUNT_ERR.test(name)) {
                    throw e;   // 频道 / 消息本身的问题,换账号也一样
                } else {
                    a.errors++;
                }
                skip.add(a.name);
            } finally {
                a.active--;
            }
        }
        if (last) throw last;
        const err = new Error('no-account');
        err.code = 'no-account';
        throw err;
    }

    // 读频道类请求(不是下载)在同一账号上排开,少吃 FLOOD_WAIT
    async readGate(a) {
        const wait = a.readAt + READ_GAP - Date.now();
        a.readAt = Math.max(Date.now(), a.readAt + READ_GAP);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    // 频道的 access_hash 每个账号不一样:各自解析一次后记下来(解析用户名限流很严)
    async entity(a, ch) {
        const key = String(ch).toLowerCase();
        let e = a.ents.get(key);
        if (!e) {
            await this.readGate(a);
            const r = await a.client.invoke(new Api.contacts.ResolveUsername({ username: key }));
            const c = (r.chats || []).find((x) => x instanceof Api.Channel && String(x.username || '').toLowerCase() === key)
                || (r.chats || []).find((x) => x instanceof Api.Channel && (x.usernames || []).some((u) => String(u.username).toLowerCase() === key));
            if (!c) { const err = new Error('not-found'); err.errorMessage = 'USERNAME_NOT_OCCUPIED'; throw err; }
            e = { id: c.id.toString(), hash: c.accessHash.toString(), title: String(c.title || '') };
            a.ents.set(key, e);
            this._saveEnts();
        }
        return e;
    }
    async peer(a, ch) {
        const e = await this.entity(a, ch);
        return new Api.InputPeerChannel({ channelId: bigInt(e.id), accessHash: bigInt(e.hash) });
    }
    async inputChannel(a, ch) {
        const e = await this.entity(a, ch);
        return new Api.InputChannel({ channelId: bigInt(e.id), accessHash: bigInt(e.hash) });
    }
    _saveEnts() {
        if (this._entSaveT) return;
        this._entSaveT = setTimeout(() => {
            this._entSaveT = null;
            const out = {};
            for (const [name, a] of this.accts) out[name] = Object.fromEntries(a.ents);
            for (const k of Object.keys(this.ents)) if (!out[k]) out[k] = this.ents[k];
            this.ents = out;
            try { writeJson(this.entFile, out); } catch (e) { log('[pool] 写 entities.json 失败', errName(e)); }
        }, 2000);
    }

    // 某个账号视角下的消息(file_reference 要用同一个账号拿到的)
    async message(a, ch, id, fresh) {
        const k = String(ch).toLowerCase() + '/' + id;
        const hit = a.msgs.get(k);
        if (hit && !fresh && Date.now() - hit.at < MSG_TTL) return hit.msg;
        const peer = await this.peer(a, ch);
        const r = await a.client.getMessages(peer, { ids: [Number(id)] });
        const msg = r && r[0];
        if (!msg || !msg.id) { const err = new Error('not-found'); err.errorMessage = 'MSG_ID_INVALID'; throw err; }
        a.msgs.delete(k);
        a.msgs.set(k, { msg, at: Date.now() });
        if (a.msgs.size > MSG_CAP) a.msgs.delete(a.msgs.keys().next().value);
        return msg;
    }

    // 视频基本信息(大小 / 类型 / 文件 id);不依赖哪个账号
    async videoMeta(ch, id) {
        const k = String(ch).toLowerCase() + '/' + id;
        const hit = this.meta.get(k);
        if (hit) return hit;
        const v = await this.run(async (a) => videoOf(await this.message(a, ch, id)));
        if (!v) { const err = new Error('not-video'); err.errorMessage = 'not-video'; throw err; }
        const m = { docId: v.docId, size: v.size, mime: v.mime, dur: v.dur, w: v.w, h: v.h };
        this.meta.set(k, m);
        if (this.meta.size > META_CAP) this.meta.delete(this.meta.keys().next().value);
        return m;
    }

    status() {
        const now = Date.now();
        return [...this.accts.values()].map((a) => ({
            name: a.name, ok: a.ok && !a.dead, dead: a.dead || undefined,
            floodSec: a.floodUntil > now ? Math.ceil((a.floodUntil - now) / 1000) : 0,
            active: a.active, served: a.served, errors: a.errors, lastErr: a.lastErr || undefined, channels: a.ents.size,
        }));
    }

    async stop() {
        clearInterval(this._watch);
        await Promise.all([...this.accts.values()].map((a) => a.client.disconnect().catch(() => {})));
    }
}

module.exports = { Pool, videoOf, errName, floodSeconds };
