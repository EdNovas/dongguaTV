'use strict';
// 🗨️ 服务器端弹幕缓存(server.js 用;Vercel 无状态不用)。
//
// 为什么:弹幕近乎静态,但旧版服务器只在内存里存 30 分钟 —— 热剧(大家都在看的那几集)每 30 分钟、每次重启都要
//   重新打 danmu_api(它要现抓爱奇艺/腾讯,慢且会被上游限流)。CF 边缘的 7 天缓存是按节点的,冷节点照样回源。
// 怎么存:
//   · 持久层:SQLite 表 danmaku_store,gzip 后存(单集上限 1.2w 条 ≈ 1MB JSON → 压缩后 ~200KB)。
//     只存【高贴合、非空】的结果;空结果/低置信(包含档)仍走调用方的短期内存缓存,不落盘。
//   · 热层:内存按字节 LRU(直接存好的响应 JSON 字符串,命中零序列化)。
//   · 新鲜期 freshMs(默认 7 天):期内直接回;过期后仍立刻回旧的,同时后台重抓(stale-while-revalidate),
//     重抓拿到空/低置信 → 保留旧的(上游瞬时空不能把好弹幕冲掉),freshMs 后再试。
//   · 同一集并发请求合并成一次上游抓取(热剧新集刚出时几十人同时点开)。
//   · 容量:按 accessed_at 淘汰到 maxBytes(压缩后)以内;accessed_at 一天最多写一次,不让每个请求都写盘。
// 键里带 ver:改了弹幕匹配逻辑(会改变"哪集配哪份弹幕")时 bump,旧的持久结果整体作废、不会再挂几个月。
const zlib = require('zlib');

const DEF = {
    freshMs: 7 * 86400e3,
    memBytes: 64 * 1024 * 1024,
    maxBytes: 1024 * 1024 * 1024,     // 持久层(压缩后)总上限
    touchEveryMs: 86400e3,
    pruneEveryMs: 3600e3,
    refreshRetryMs: 3600e3,           // 后台重抓失败(空/低置信/出错)后,多久内不再重试同一集
};

function createStore(opts) {
    const o = Object.assign({}, DEF, opts || {});
    const getDb = typeof o.db === 'function' ? o.db : () => o.db || null;
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    let schemaOk = false, lastPrune = 0;

    function db() {
        const d = getDb();
        if (!d) return null;
        if (!schemaOk) {
            try {
                d.exec(`CREATE TABLE IF NOT EXISTS danmaku_store (
                    k TEXT PRIMARY KEY,
                    gz BLOB NOT NULL,
                    n INTEGER NOT NULL,
                    bytes INTEGER NOT NULL,
                    fetched_at INTEGER NOT NULL,
                    accessed_at INTEGER NOT NULL
                )`);
                d.exec('CREATE INDEX IF NOT EXISTS idx_dmstore_access ON danmaku_store(accessed_at)');
                schemaOk = true;
            } catch (e) { console.warn('[弹幕缓存] 建表失败,只用内存:', e.message); return null; }
        }
        return d;
    }

    // ---- 内存热层:k -> { json, n, fetchedAt, size } (Map 的插入序当 LRU)----
    const mem = new Map();
    let memSize = 0;
    function memGet(k) {
        const e = mem.get(k);
        if (!e) return null;
        mem.delete(k); mem.set(k, e);   // 提到最新
        return e;
    }
    function memPut(k, e) {
        const old = mem.get(k);
        if (old) { memSize -= old.size; mem.delete(k); }
        if (e.size > o.memBytes / 4) return;   // 单条太大不进热层(持久层照存)
        mem.set(k, e); memSize += e.size;
        while (memSize > o.memBytes && mem.size) {
            const fk = mem.keys().next().value;
            memSize -= mem.get(fk).size; mem.delete(fk);
        }
    }

    const toJson = (data) => JSON.stringify({ code: 0, version: 3, data, msg: '' });

    // 取:{ json, n, fetchedAt, fresh } 或 null
    function get(k) {
        const t = now();
        let e = memGet(k);
        if (!e) {
            const d = db();
            if (d) {
                try {
                    const row = d.prepare('SELECT gz, n, fetched_at, accessed_at FROM danmaku_store WHERE k = ?').get(k);
                    if (row) {
                        const json = zlib.gunzipSync(row.gz).toString('utf8');
                        e = { json, n: row.n, fetchedAt: row.fetched_at, size: json.length * 2 };
                        memPut(k, e);
                        if (t - row.accessed_at > o.touchEveryMs) d.prepare('UPDATE danmaku_store SET accessed_at = ? WHERE k = ?').run(t, k);
                    }
                } catch (err) { console.warn('[弹幕缓存] 读失败:', err.message); }
            }
        }
        if (!e) return null;
        return { json: e.json, n: e.n, fetchedAt: e.fetchedAt, fresh: t - e.fetchedAt < o.freshMs };
    }

    // 存(只该传入高贴合非空结果)。返回响应 JSON 字符串。
    function put(k, data) {
        const t = now();
        const json = toJson(data);
        const e = { json, n: data.length, fetchedAt: t, size: json.length * 2 };
        memPut(k, e);
        const d = db();
        if (d) {
            try {
                const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
                d.prepare('INSERT OR REPLACE INTO danmaku_store (k, gz, n, bytes, fetched_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(k, gz, data.length, gz.length, t, t);
            } catch (err) { console.warn('[弹幕缓存] 写失败:', err.message); }
            if (t - lastPrune > o.pruneEveryMs) { lastPrune = t; prune(); }
        }
        return json;
    }

    // 后台重抓没拿到更好的:不动旧数据,只记下"刚试过",refreshRetryMs 内不再重抓
    const refreshFailedAt = new Map();
    function refreshAllowed(k) {
        const f = refreshFailedAt.get(k);
        return !f || now() - f > o.refreshRetryMs;
    }
    function refreshFailed(k) {
        refreshFailedAt.set(k, now());
        if (refreshFailedAt.size > 5000) refreshFailedAt.delete(refreshFailedAt.keys().next().value);
    }

    // 按最近访问淘汰到容量以内
    function prune() {
        const d = db();
        if (!d) return 0;
        try {
            const tot = d.prepare('SELECT COALESCE(SUM(bytes), 0) s FROM danmaku_store').get().s;
            if (tot <= o.maxBytes) return 0;
            let over = tot - o.maxBytes * 0.9, removed = 0;   // 一次多删 10%,免得每次写都在边上来回删
            const rows = d.prepare('SELECT k, bytes FROM danmaku_store ORDER BY accessed_at ASC LIMIT 2000').all();
            const del = d.prepare('DELETE FROM danmaku_store WHERE k = ?');
            const tx = d.transaction((list) => { for (const r of list) del.run(r.k); });
            const victims = [];
            for (const r of rows) { if (over <= 0) break; victims.push(r); over -= r.bytes; }
            tx(victims);
            removed = victims.length;
            for (const r of victims) { const m = mem.get(r.k); if (m) { memSize -= m.size; mem.delete(r.k); } }
            if (removed) console.log(`[弹幕缓存] 超出容量,淘汰 ${removed} 集`);
            return removed;
        } catch (err) { console.warn('[弹幕缓存] 淘汰失败:', err.message); return 0; }
    }

    // 同键并发合并:同一集同时只有一个上游抓取,其余请求等它
    const inflight = new Map();
    function once(k, fn) {
        if (inflight.has(k)) return inflight.get(k);
        const p = Promise.resolve().then(fn).finally(() => inflight.delete(k));
        inflight.set(k, p);
        return p;
    }

    function stats() {
        const d = db();
        let rows = 0, bytes = 0;
        if (d) { try { const r = d.prepare('SELECT COUNT(*) c, COALESCE(SUM(bytes), 0) s FROM danmaku_store').get(); rows = r.c; bytes = r.s; } catch (e) { } }
        return { persistent: !!d, rows, bytes, memEntries: mem.size, memBytes: memSize, inflight: inflight.size };
    }

    return { get, put, once, prune, stats, refreshAllowed, refreshFailed, toJson, _opts: o };
}

module.exports = { createStore, DEF };
