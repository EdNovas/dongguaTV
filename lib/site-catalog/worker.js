// [adult] lib/site-catalog 的工作线程入口(node:worker_threads)。workerData.role:
//   'writer':自己一条 catalog.db 连接,跑 writer.js 的全部写操作;AVDB(lib/adult-avdb)也住这里(同一条写连接,不和目录抢写锁),
//             它要出网时经主线程的 httpGet(rpc 'http')—— 代理回退 / 出网限流都还是 server.js 那一套。
//   'reader':query_only 连接,跑 snapshot.js(建快照 / 浏览 / 分面 / 联想 / 查找);建好的快照经 MessagePort 直接交给另一个读线程。
// 协议:主线程 → {id, op, args};回 {id, ok, result|error}。线程 → 主线程:{log}、{rpc, op, args}(主线程回 {rpcReply, ok, result|error})、{ready}。
'use strict';

const { parentPort, workerData } = require('worker_threads');
const SCH = require('./schema');

const wd = workerData || {};
const log = (m) => { try { parentPort.postMessage({ log: String(m) }); } catch (_) { /* 主线程走了 */ } };
let rpcSeq = 0;
const rpcWait = new Map();
function rpc(op, args) {
    return new Promise((resolve, reject) => {
        const id = ++rpcSeq;
        rpcWait.set(id, { resolve, reject });
        parentPort.postMessage({ rpc: id, op, args });
    });
}

let handler = null;
let initErr = null;
const peers = [];
try {
    const adult = require(wd.adultModule);
    const tags = wd.tagsModule ? require(wd.tagsModule) : null;
    const db = SCH.openDb(wd.dbPath, wd.role, wd.env);
    if (wd.role === 'writer') {
        const { createWriter } = require('./writer');
        let avdb = null;
        const w = createWriter({ db, adult, tags, C: wd.C, rules: wd.rules, log, avdb: () => avdb });
        const initAvdb = () => {
            if (avdb) return true;
            if (!wd.avdbModule) return false;
            try {
                const mod = require(wd.avdbModule);
                avdb = mod.createAvdb({ db, httpGet: (url, o) => rpc('http', { url: String(url), timeout: o && o.timeout, siteKey: (o && o.siteKey) || 'avdb' }), log, env: wd.env || {}, adult });
                return !!avdb;
            } catch (e) { log('AVDB 不可用(目录照常,只是没有 AVDB 数据): ' + (e && e.message)); avdb = null; return false; }
        };
        handler = (op, args) => {
            if (op === 'avdbInit') return initAvdb();
            if (op === 'avdbStart') { if (avdb && typeof avdb.start === 'function') avdb.start(); return !!avdb; }
            if (op === 'avdbStop') { if (avdb && typeof avdb.stop === 'function') avdb.stop(); return true; }
            if (op === 'avdbSearch') { try { return avdb && typeof avdb.searchActress === 'function' ? avdb.searchActress(String(args && args.q || '')) || [] : []; } catch (e) { log('AVDB searchActress: ' + e.message); return []; } }
            if (op === 'close') { try { if (avdb && typeof avdb.stop === 'function') avdb.stop(); } catch (_) { /* */ } try { db.close(); } catch (_) { /* */ } return true; }
            return w.handle(op, args);
        };
    } else {
        const { createReader } = require('./snapshot');
        const r = createReader({ db, adult, tags, C: wd.C, log });
        handler = (op, args) => {
            if (op === 'build') {
                const out = r.handle('build', args);
                for (const p of peers) { try { p.postMessage({ install: out.desc }); } catch (e) { log('snapshot share: ' + e.message); } }
                const j = out.json;
                // 主线程只要 JSON 部分(大数组留在读线程之间共享)
                const actorPairs = Array.isArray(j.actors) && Array.isArray(j.actorN) ? j.actors.map((a, i) => [a[0], j.actorN[i] || 0]) : null;   // 只给 aid → 部数
                return { sid: out.sid, N: out.N, json: { home: j.home, buckets: j.buckets, pre: { tags: j.pre.tags, studios: j.pre.studios, tagInfo: j.pre.tagInfo }, trust: j.trust, ms: j.ms, actorPairs } };
            }
            if (op === 'close') { try { db.close(); } catch (_) { /* */ } return true; }
            return r.handle(op, args);
        };
        handler.install = (desc) => r.handle('install', { desc });
    }
} catch (e) { initErr = e; }

parentPort.on('message', async (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.rpcReply != null) {
        const w = rpcWait.get(m.rpcReply);
        if (w) { rpcWait.delete(m.rpcReply); if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error || 'rpc failed')); }
        return;
    }
    if (m.peer) {
        const port = m.peer;
        peers.push(port);
        port.on('message', (x) => { if (x && x.install && handler && handler.install) { try { handler.install(x.install); } catch (e) { log('snapshot install: ' + e.message); } } });
        return;
    }
    if (m.id == null) return;
    try {
        if (initErr) throw initErr;
        let res = handler(m.op, m.args);
        if (res && typeof res.then === 'function') res = await res;
        parentPort.postMessage({ id: m.id, ok: true, result: res === undefined ? null : res });
    } catch (e) {
        parentPort.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) });
    }
});
parentPort.postMessage({ ready: true, error: initErr ? String(initErr.message || initErr) : null });
