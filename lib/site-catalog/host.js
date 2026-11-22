// [adult] 主线程这一侧的工作线程管理:一个写线程 + 两个读线程(lib/site-catalog/worker.js)。
//   · 有请求在途才 ref() 线程,空闲就 unref():不拖住进程退出,也不会在 await 半路被 Node 当成"没事可做"直接退出。
//   · 线程意外退出:在途请求全部失败(调用方按"目录暂时不可用"处理),一小时内最多自动重启 5 次。
//   · 线程要出网(AVDB)走 onRpc('http') —— 由主线程的 httpGet 发,代理回退 / 连接限流都还是 server.js 那一套。
'use strict';

const path = require('path');
const { Worker, MessageChannel } = require('worker_threads');

function createHost(o) {
    const file = path.join(__dirname, 'worker.js');
    const log = typeof o.log === 'function' ? o.log : () => {};
    let w = null, seq = 0, closed = false, readyP = null, restarts = [];
    const pending = new Map();
    function spawn() {
        w = new Worker(file, { workerData: o.workerData });
        w.unref();
        let readyRes;
        readyP = new Promise((r) => { readyRes = r; });
        w.on('message', (m) => {
            if (!m || typeof m !== 'object') return;
            if (m.ready) { if (m.error) log(o.name + ' 启动失败: ' + m.error); readyRes(!m.error); return; }
            if (m.log != null) { log(m.log); return; }
            if (m.rpc != null) {
                const me = w;
                Promise.resolve().then(() => (typeof o.onRpc === 'function' ? o.onRpc(m.op, m.args) : Promise.reject(new Error('no rpc'))))
                    .then((result) => { try { me.postMessage({ rpcReply: m.rpc, ok: true, result }); } catch (_) { /* 线程已退出 */ } },
                        (e) => { try { me.postMessage({ rpcReply: m.rpc, ok: false, error: String((e && e.message) || e) }); } catch (_) { /* */ } });
                return;
            }
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            if (!pending.size && w) w.unref();
            if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'worker error'));
        });
        const fail = (why) => {
            const err = new Error(o.name + ' ' + why);
            for (const p of pending.values()) p.reject(err);
            pending.clear();
            readyRes(false);
        };
        w.on('error', (e) => { log(o.name + ' 出错: ' + (e && e.message)); });
        w.on('exit', (code) => {
            fail('exited (' + code + ')');
            w = null;
            if (closed) return;
            const now = Date.now();
            restarts = restarts.filter((x) => now - x < 3600e3);
            if (restarts.length >= 5) { log(o.name + ' 一小时内退出 5 次,不再重启'); return; }
            restarts.push(now);
            log(o.name + ' 退出(' + code + '),重启');
            spawn();
            if (typeof o.onRestart === 'function') readyP.then((ok) => { if (ok) o.onRestart(); });
        });
    }
    spawn();
    function call(op, args) {
        if (closed || !w) return Promise.reject(new Error(o.name + ' unavailable'));
        const id = ++seq;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject, op });
            w.ref();
            try { w.postMessage({ id, op, args }); } catch (e) { pending.delete(id); if (!pending.size) w.unref(); reject(e); }
        });
    }
    function post(msg, transfer) { if (w) w.postMessage(msg, transfer); }
    async function close() {
        closed = true;
        if (!w) return;
        try { await Promise.race([call('close', {}), new Promise((r) => setTimeout(r, 1000).unref())]); } catch (_) { /* */ }
        const ww = w;
        w = null;
        try { await ww.terminate(); } catch (_) { /* */ }
    }
    return { call, post, close, ready: () => readyP, load: () => pending.size, alive: () => !!w && !closed };
}

// 两个读线程之间的快照通道(建快照的那个直接把 SharedArrayBuffer 描述交给另一个)
function linkPeers(a, b) {
    const ch = new MessageChannel();
    a.post({ peer: ch.port1 }, [ch.port1]);
    b.post({ peer: ch.port2 }, [ch.port2]);
}

module.exports = { createHost, linkPeers };
