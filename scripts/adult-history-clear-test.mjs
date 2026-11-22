#!/usr/bin/env node
// [adult] 隐私「一键清除」的云端部分(PRIV-2)回归:node scripts/adult-history-clear-test.mjs   (零外网;片名全是合成的)
//  server.js 子进程(CACHE_DB_PATH=临时目录,ACCESS_PASSWORD=test,alice,bob → alice / bob 开同步):
//  ① 主线「清除观看历史」(POST /api/history/clear {token},不带标记)照旧:只删历史,删除墓碑留着(它接着推墓碑让别的设备不把记录推回来)
//  ② 隐私一键清除(public/adult/privacy.js 发 {token, all:true}):历史 + 删除墓碑(按片名存、留 120 天)一起删 →
//     清完拉取 deleted 为空,客户端刷新后不会再把「删过的片名」写回本机 donggua_history_deleted
//  ③ 只认布尔 true;只删自己的(别的账号的历史 / 墓碑不动);令牌不对 401、什么都不删
//  端口:默认向系统要一个空闲端口;TEST_PORT=xxxx 指定
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const gate = require(path.join(ROOT, 'lib/adult-gate'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
    if (c) { pass++; return true; }
    fail++;
    console.log('  ✗ ' + msg + (extra !== undefined ? '  →  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600) : ''));
    return false;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adult-hclear-'));
const DB_FILE = path.join(tmp, 'db.json');
fs.writeFileSync(DB_FILE, JSON.stringify({ sites: [{ key: 'a', name: '站A', api: 'http://127.0.0.1:9/api.php/provide/vod/', active: true }] }));
function childEnv(extra) {
    const e = Object.assign({}, process.env);
    for (const k of Object.keys(gate.ADULT_ENV_DEFAULTS)) delete e[k];
    for (const k of ['STATS_DISABLE', 'CATALOG_MAX_SITES', 'CATALOG_FIRST_DELAY_MS', 'ADULT_TEST_CATALOG_STUB', 'ADULT_TEST_CATALOG_LOG', 'VERCEL', 'SITES_JSON', 'CATALOG_DB_PATH',
        'ADULT_IMG_PROXY', 'ADULT_IMG_CACHE_DIR', 'ADULT_CLIENT_IP_HEADER']) delete e[k];
    return Object.assign(e, {
        TMDB_API_KEY: '', TMDB_PROXY_URL: '', CORS_PROXY_URL: '', DANMU_API_URL: '', DANMU_API_TOKEN: '', ADMIN_TOKEN: '', ADULT_ADMIN_TOKEN: '', REMOTE_DB_URL: '',
        LIVE_M3U_ADULT: '', SITE_URL: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '', DB_FILE, CATALOG_DISABLE: '1',
    }, extra || {});
}
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let srv = null, port = 0, srvLog = '';
async function startServer(extra) {
    port = Number(process.env.TEST_PORT) || await freePort();
    srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: tmp, env: childEnv(Object.assign({ PORT: String(port) }, extra)), stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => { srvLog += d; });
    srv.stderr.on('data', d => { srvLog += d; });
    for (let i = 0; i < 150; i++) {
        await sleep(100);
        try { const r = await fetch(`http://127.0.0.1:${port}/api/debug`); if (r.ok) return; } catch (e) { }
        if (srv.exitCode != null) break;
    }
    throw new Error('server.js 没起来:\n' + srvLog.slice(-3000));
}
async function stopServer() {
    if (!srv) return;
    const p = new Promise(r => srv.once('exit', r));
    srv.kill(); await p; srv = null;
}
async function api(method, p, json) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: json !== undefined ? { 'Content-Type': 'application/json' } : {}, body: json !== undefined ? JSON.stringify(json) : undefined });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) { }
    return { status: r.status, j };
}

const ALICE = sha('alice'), BOB = sha('bob');
const T0 = Date.now() - 3600e3;
const item = (name, at) => ({ id: name, data: { name, watchedAt: new Date(at).toISOString(), progress: 10 }, updated_at: at });
const pull = async (tok) => { const r = await api('GET', '/api/history/pull?token=' + tok); return { history: ((r.j && r.j.history) || []).map(h => h.id).sort(), deleted: ((r.j && r.j.deleted) || []).map(d => d.id).sort(), j: r.j }; };
// 一个看着的 + 一个删掉的(墓碑)
async function seed(tok, tag) {
    const r = await api('POST', '/api/history/push', { token: tok, history: [item('合成作品-在看-' + tag, T0)], deleted: [{ id: '合成作品-已删-' + tag, deleted_at: T0 + 1000 }] });
    return r.j && r.j.sync_enabled === true;
}

try {
    await startServer({ ACCESS_PASSWORD: 'test,alice,bob', CACHE_TYPE: 'sqlite', CACHE_DB_PATH: path.join(tmp, 'cache.db') });

    console.log('① 主线清除(不带标记):只删历史,墓碑留着');
    ok(await seed(ALICE, 'A') && await seed(BOB, 'B'), '准备:alice / bob 各有一条历史 + 一个删除墓碑');
    let p = await pull(ALICE);
    ok(JSON.stringify(p.history) === JSON.stringify(['合成作品-在看-A']) && JSON.stringify(p.deleted) === JSON.stringify(['合成作品-已删-A']), '拉取:历史和墓碑都在', p);
    let r = await api('POST', '/api/history/clear', { token: ALICE });
    ok(r.status === 200 && r.j && r.j.success === true && r.j.deleted === 1 && !('tombstones' in r.j), '主线清除:删 1 条历史,回包形状不变', r.j);
    p = await pull(ALICE);
    ok(p.history.length === 0 && JSON.stringify(p.deleted) === JSON.stringify(['合成作品-已删-A']), '主线清除:墓碑照旧留着(别的设备靠它压制复活)', p);

    console.log('② 隐私一键清除(all:true):历史 + 墓碑一起删');
    await seed(ALICE, 'A');
    r = await api('POST', '/api/history/clear', { token: ALICE, all: true });
    ok(r.status === 200 && r.j && r.j.success === true && r.j.deleted === 1 && r.j.tombstones === 1, 'all:true:删 1 条历史 + 1 个墓碑', r.j);
    p = await pull(ALICE);
    ok(p.history.length === 0 && p.deleted.length === 0, 'PRIV-2:清完拉取 deleted 为空(删过的片名不会再被拉回本机)', p.j);

    console.log('③ 只认 true、只删自己的、令牌不对 401');
    await seed(ALICE, 'A2');
    for (const v of ['true', 1, 'all']) {
        await api('POST', '/api/history/clear', { token: ALICE, all: v });
        p = await pull(ALICE);
        ok(JSON.stringify(p.deleted) === JSON.stringify(['合成作品-已删-A2']), `all:${JSON.stringify(v)} 不算(只认布尔 true):墓碑留着`, p);
    }
    p = await pull(BOB);
    ok(JSON.stringify(p.history) === JSON.stringify(['合成作品-在看-B']) && JSON.stringify(p.deleted) === JSON.stringify(['合成作品-已删-B']), 'alice 的清除不碰 bob 的历史 / 墓碑', p);
    r = await api('POST', '/api/history/clear', { token: sha('nobody'), all: true });
    ok(r.status === 401, '令牌不对:401', r);
    r = await api('POST', '/api/history/clear', { all: true });
    ok(r.status === 400, '没令牌:400', r);
    p = await pull(BOB);
    ok(p.history.length === 1 && p.deleted.length === 1, '坏请求什么都没删', p);
    r = await api('POST', '/api/history/clear', { token: BOB, all: true });
    p = await pull(BOB);
    ok(r.j && r.j.tombstones === 1 && p.history.length === 0 && p.deleted.length === 0, 'bob 自己一键清除:历史 + 墓碑都没了', [r.j, p]);
} catch (e) {
    fail++;
    console.log('  ✗ 运行出错: ' + (e && e.stack || e));
} finally {
    await stopServer();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
