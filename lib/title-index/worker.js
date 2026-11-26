'use strict';
// 片名索引的查询线程:只读连接,收 {id, site, k(已归一化), limit},回 {id, ids}。主线程那边有 5s 超时与同步兜底
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

const db = new Database(workerData.dbFile, { readonly: true, fileMustExist: true });
const look = db.prepare(`SELECT vod_id FROM ti_titles WHERE site = ? AND instr(norm, ?) > 0
    ORDER BY (norm = ?) DESC, (instr(norm, ?) = 1) DESC, length(norm), t DESC LIMIT ?`);

parentPort.on('message', (m) => {
    try {
        const ids = look.all(m.site, m.k, m.k, m.k, m.limit).map((r) => r.vod_id);
        parentPort.postMessage({ id: m.id, ids });
    } catch (e) {
        parentPort.postMessage({ id: m.id, error: String(e && e.message || e) });
    }
});
