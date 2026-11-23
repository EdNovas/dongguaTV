'use strict';
// 视频按 1MB 一块从 Telegram 拉(块对齐 1MB 正好满足 upload.getFile 的偏移规则),
// 拉到的块存磁盘(LRU,总量有上限),同一块同时被要只拉一次;Range 请求按块拼出来。
const fs = require('fs');
const path = require('path');
const { Api } = require('telegram');
const { videoOf, errName } = require('./pool');
const { log } = require('./common');

const CHUNK = 1024 * 1024;
const PART = 512 * 1024;            // 一次 getFile 拿多少(两次凑一块,并行)

class ChunkCache {
    constructor(dir, capBytes) {
        this.dir = dir;
        this.cap = Math.max(8 * CHUNK, Number(capBytes) || 20 * 1024 * CHUNK);   // 别用 |0:20GB 超过 32 位会截坏
        this.idx = new Map();         // 'docId/n' -> size;Map 的顺序 = 最近使用顺序(用到就挪到最后)
        this.total = 0;
    }
    init() {
        fs.mkdirSync(this.dir, { recursive: true });
        const rows = [];
        for (const d of fs.readdirSync(this.dir)) {
            const sub = path.join(this.dir, d);
            let names = [];
            try { names = fs.readdirSync(sub); } catch (_) { continue; }
            for (const n of names) {
                if (!/^\d+$/.test(n)) { try { fs.unlinkSync(path.join(sub, n)); } catch (_) { /* 残留的临时文件 */ } continue; }
                try { const st = fs.statSync(path.join(sub, n)); rows.push([d + '/' + n, st.size, st.mtimeMs]); } catch (_) { /* 刚被删 */ }
            }
        }
        rows.sort((a, b) => a[2] - b[2]);
        for (const [k, size] of rows) { this.idx.set(k, size); this.total += size; }
        this._evict();
        log('[cache] 已有', this.idx.size, '块,', (this.total / 1073741824).toFixed(2), 'GB / 上限', (this.cap / 1073741824).toFixed(1), 'GB');
    }
    _file(k) { return path.join(this.dir, k); }
    async get(docId, n) {
        const k = docId + '/' + n;
        if (!this.idx.has(k)) return null;
        try {
            const buf = await fs.promises.readFile(this._file(k));
            const size = this.idx.get(k);
            this.idx.delete(k); this.idx.set(k, size);
            return buf;
        } catch (_) {
            this.total -= this.idx.get(k) || 0;
            this.idx.delete(k);
            return null;
        }
    }
    async put(docId, n, buf) {
        const k = docId + '/' + n;
        if (this.idx.has(k)) return;
        const f = this._file(k);
        await fs.promises.mkdir(path.dirname(f), { recursive: true });
        const tmp = f + '.' + process.pid + '.tmp';
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, f);
        this.idx.set(k, buf.length);
        this.total += buf.length;
        this._evict();
    }
    _evict() {
        if (this.total <= this.cap) return;
        const goal = this.cap * 0.9;
        for (const [k, size] of this.idx) {
            if (this.total <= goal) break;
            this.idx.delete(k);
            this.total -= size;
            fs.promises.unlink(this._file(k)).catch(() => {});
            const dir = path.dirname(this._file(k));
            fs.promises.rmdir(dir).catch(() => {});   // 空了才删得掉
        }
    }
    stat() { return { chunks: this.idx.size, bytes: this.total, cap: this.cap }; }
}

class Media {
    constructor(pool, cache, thumbDir) {
        this.pool = pool;
        this.cache = cache;
        this.thumbDir = thumbDir;
        this.inflight = new Map();
        this.thumbInflight = new Map();
        this.bytesFromTg = 0;
        this.bytesFromCache = 0;
    }

    // 用某个账号拉 [off, off+len) —— 偏移必须是 PART 的整数倍
    async _download(a, ch, id, off, len) {
        let msg = await this.pool.message(a, ch, id);
        for (let attempt = 0; ; attempt++) {
            const v = videoOf(msg);
            if (!v) { const err = new Error('not-video'); err.errorMessage = 'not-video'; throw err; }
            const loc = new Api.InputDocumentFileLocation({ id: v.id, accessHash: v.accessHash, fileReference: v.fileReference, thumbSize: '' });
            try {
                const parts = [];
                for (let p = off; p < off + len && p < v.size; p += PART) parts.push(this._getFile(a, loc, v.dcId, p));
                const bufs = await Promise.all(parts);
                return Buffer.concat(bufs);
            } catch (e) {
                if (attempt === 0 && /FILE_REFERENCE_(EXPIRED|INVALID)|FILEREF_UPGRADE_NEEDED/.test(errName(e))) {
                    msg = await this.pool.message(a, ch, id, true);   // file_reference 过期:重新取一次消息
                    continue;
                }
                throw e;
            }
        }
    }
    async _getFile(a, loc, dcId, offset) {
        let dc = dcId;
        for (let i = 0; i < 3; i++) {
            const sender = await a.client.getSender(dc);
            try {
                const r = await a.client.invokeWithSender(new Api.upload.GetFile({ location: loc, offset: require('big-integer')(offset), limit: PART, precise: false, cdnSupported: false }), sender);
                if (!(r instanceof Api.upload.File)) throw new Error('cdn-redirect');
                return Buffer.from(r.bytes);
            } catch (e) {
                if (e && e.newDc && i < 2) { dc = e.newDc; continue; }   // FILE_MIGRATE_X
                throw e;
            }
        }
        throw new Error('dc-loop');
    }

    // 第 n 块(1MB);磁盘有就直接用,同一块同时只拉一次
    chunk(ch, id, meta, n) {
        const k = meta.docId + '/' + n;
        let p = this.inflight.get(k);
        if (p) return p;
        p = (async () => {
            const hit = await this.cache.get(meta.docId, n);
            if (hit) { this.bytesFromCache += hit.length; return hit; }
            const len = Math.min(CHUNK, meta.size - n * CHUNK);
            const buf = await this.pool.run((a) => this._download(a, ch, id, n * CHUNK, len));
            if (buf.length !== len) throw new Error('short-chunk ' + buf.length + '/' + len);
            this.bytesFromTg += buf.length;
            this.cache.put(meta.docId, n, buf).catch((e) => log('[cache] 写入失败', errName(e)));
            return buf;
        })().finally(() => this.inflight.delete(k));
        this.inflight.set(k, p);
        return p;
    }

    // 封面:视频自带的缩略图(最大那张),存磁盘
    async thumb(ch, id) {
        const f = path.join(this.thumbDir, String(ch).toLowerCase() + '_' + id + '.jpg');
        try { return await fs.promises.readFile(f); } catch (_) { /* 没缓存 */ }
        let p = this.thumbInflight.get(f);
        if (!p) {
            p = (async () => {
                const buf = await this.pool.run(async (a) => {
                    const msg = await this.pool.message(a, ch, id);
                    const v = videoOf(msg);
                    if (!v || !v.thumbs.length) return null;
                    const area = (t) => (t.w | 0) * (t.h | 0);
                    const best = v.thumbs.slice().sort((x, y) => area(y) - area(x))[0];
                    return await a.client.downloadMedia(msg, { thumb: best });
                });
                if (!buf || !buf.length) return null;
                await fs.promises.mkdir(this.thumbDir, { recursive: true });
                await fs.promises.writeFile(f, buf);
                return buf;
            })().finally(() => this.thumbInflight.delete(f));
            this.thumbInflight.set(f, p);
        }
        return p;
    }
}

module.exports = { ChunkCache, Media, CHUNK, PART };
