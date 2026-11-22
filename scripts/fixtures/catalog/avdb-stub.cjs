'use strict';
// [adult] scripts/site-catalog-test.mjs 用的 lib/adult-avdb 替身(契约 B 的接口形状)。数据放在同一个库的 avdb_stub 表里,
//   这样写线程里的实例(worker 模式按模块路径 require 本文件)和主线程只读实例看到的是同一份。番号 / 演员名全是合成的。
//   测试往 avdb_stub 写行:key → JSON {runtime, released, poster, actors:[{aid,name}], tags:[{id,src:'avdb'}], maker, label, pol}
//   特殊行 key='__meta':{polv, polchg} → stats() 的政策规则版本 / 政策戳(测"规则版本变了要复核")
function createAvdb(deps) {
    const db = typeof deps.db === 'function' ? deps.db() : deps.db;
    if (!db || typeof db.prepare !== 'function') throw new Error('avdb-stub: no db');
    try { db.exec('CREATE TABLE IF NOT EXISTS avdb_stub (key TEXT PRIMARY KEY, j TEXT NOT NULL)'); } catch (e) { if (!/readonly/i.test(e.message)) throw e; }
    let started = 0;
    const get = (key) => { try { const r = db.prepare('SELECT j FROM avdb_stub WHERE key=?').get(key); return r ? JSON.parse(r.j) : null; } catch (_) { return null; } };
    function lookup(key, opts) {
        const a = get(String(key || ''));
        if (!a) return null;
        if (a.pol === 'block') return { key, variants: ['main'], tags: [], tags_en: [], actors: [], maker: '', label: a.label || '', released: '', runtime: a.runtime || 0, poster: '', pol: 'block' };
        return {
            key, variants: ['main'], tags: a.tags || [], tags_en: [], actors: a.actors || [], maker: a.maker || '', label: a.label || '',
            released: a.released || '', runtime: a.runtime || 0, poster: a.poster || '', pol: a.pol || null, _dur: opts && opts.dur,
        };
    }
    function all() { try { return db.prepare('SELECT key, j FROM avdb_stub').all().map((r) => [r.key, JSON.parse(r.j)]); } catch (_) { return []; } }
    return {
        start() { started++; }, stop() { },
        lookup,
        lookupMany(keys) { const m = new Map(); for (const k of keys || []) { const r = lookup(k); if (r) m.set(k, r); } return m; },
        recent(days) { const lim = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10); return all().filter(([, a]) => a.released && a.released >= lim && a.pol !== 'block').map(([k]) => k); },
        actress(aid) {
            const n = Number(aid);
            for (const [, a] of all()) for (const x of a.actors || []) if (x.aid === n) return { aid: n, name: x.name, aliases: x.aliases || [], n: 1 };
            return null;
        },
        searchActress(q) {
            const s = String(q || '').toLowerCase();
            const out = new Map();
            for (const [, a] of all()) for (const x of a.actors || []) if (x.name.toLowerCase().includes(s)) out.set(x.aid, { aid: x.aid, name: x.name, n: (out.get(x.aid) || { n: 0 }).n + 1 });
            return [...out.values()].slice(0, 10);
        },
        stats() {
            let rows = 0, ver = '';
            try { rows = db.prepare("SELECT COUNT(*) n FROM avdb_stub WHERE key <> '__meta'").get().n; ver = (db.prepare("SELECT group_concat(key || length(j), ',') v FROM avdb_stub WHERE key <> '__meta'").get() || {}).v || ''; } catch (_) { /* */ }
            const meta = get('__meta') || {};
            return { rows, lastFull: ver, lastDelta: null, crawling: false, cursor: null, started, polv: meta.polv || 'stub', polchg: meta.polchg || 0 };
        },
    };
}
module.exports = { createAvdb };
