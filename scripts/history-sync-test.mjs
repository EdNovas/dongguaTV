// 观看历史增量同步回归:node scripts/history-sync-test.mjs
//  ① lib/history-slim 瘦身规则  ② 前端 _slimHistoryItem 与服务器逐条结果一致
//  ③ 前端增量推送逻辑(从 public/index.html 抽出方法,假 localStorage/fetch/sendBeacon):只推变化的、没变化不发请求、
//     失败/服务器没存不记确认、墓碑只推一次、换账号重来、beacon 不超 60KB、拉取后记下服务器版本、同版本留本地完整快照
//  ④ 端到端:临时目录跑真正的 server.js(sqlite):入库瘦身、同版本跳过、旧版本不覆盖、下发最多 100 条、旧胖条目下发时瘦身并写回
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };
const { slimHistoryItem } = require(path.join(ROOT, 'lib/history-slim'));
const realFetch = globalThis.fetch;   // ③ 会把 fetch 换成假的,④ 要用真的

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

// 一条"胖"历史条目:20 条线路,每条带完整选集串/简介/测速字段
const playUrl = n => Array.from({ length: n }, (_, i) => `第${String(i + 1).padStart(2, '0')}集$https://cdn.example.com/v/${'x'.repeat(40)}/${i}/index.m3u8`).join('#');
function fatItem(name, watchedAt, lastKey) {
    return {
        name, poster: '/p.jpg', episode: '第05集', progress: 40, progressTime: 1200, progressDuration: 2700,
        watchedAt, lastSourceKey: lastKey || 'site3',
        groupData: {
            name, pic: '/pic.jpg', _work: '', _workSig: '', _workLabel: '', sourcesTestedAt: Date.now(),
            sources: Array.from({ length: 20 }, (_, i) => ({
                vod_id: 100 + i, vod_name: name, vod_pic: '/v' + i + '.jpg', vod_play_url: playUrl(40), vod_content: '剧情'.repeat(300),
                site_name: '站' + i, site_key: 'site' + i, type_name: '国产剧', vod_year: '2025',
                latency: 300 + i, _testType: 'direct', _srvOnly: false, _useProxy: false, _proxyUrl: null,
            })),
        },
    };
}

// ---------- ① 瘦身规则 ----------
console.log('① lib/history-slim');
{
    const fat = fatItem('兰香如故', '2026-10-08T01:00:00.000Z', 'site3');
    const slim = slimHistoryItem(fat);
    const fatLen = JSON.stringify(fat).length, slimLen = JSON.stringify(slim).length;
    ok(slimLen < fatLen / 8, `瘦身后显著变小(${fatLen} → ${slimLen})`);
    const srcs = slim.groupData.sources;
    ok(srcs.length === 20 && srcs.filter(s => s.vod_play_url).length === 1 && srcs.find(s => s.vod_play_url).site_key === 'site3', '只保留上次线路(site3)的选集串');
    ok(srcs.every(s => !('latency' in s) && !('_testType' in s) && !('vod_content' in s) && !('vod_pic' in s) && !('_useProxy' in s)), '去掉简介/海报/本机测速字段');
    ok(srcs.every(s => s.type_name === '国产剧' && s.vod_year === '2025' && s.vod_id && s.site_key), '保留 vod_id/站点/分类/年份(切线路、弹幕提示要用)');
    ok(!('sourcesTestedAt' in slim.groupData) && slim.progressTime === 1200 && slim.episode === '第05集' && slim.watchedAt === fat.watchedAt, '保留进度/集数/时间,去掉 sourcesTestedAt');
    const noLast = slimHistoryItem(Object.assign({}, fat, { lastSourceKey: null }));
    ok(noLast.groupData.sources.filter(s => s.vod_play_url).length === 1 && noLast.groupData.sources[0].vod_play_url, '没有 lastSourceKey 时留第一条有选集的');
    ok(JSON.stringify(slimHistoryItem(slim)) === JSON.stringify(slim), '瘦身幂等');
    ok(slimHistoryItem(null) === null && slimHistoryItem({ name: 'x' }).name === 'x', '没有 groupData 原样返回');
}

// ---------- ② 前端与服务器一致 ----------
const norm = t => t.split('\r\n').join('\n');
const HTML = norm(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));
// 抽 Vue 方法:从 "    name(" 起数大括号到配平(跳过字符串里的括号)
function method(name) {
    const re = new RegExp('\\n {16}(async )?' + name + '\\(([^)]*)\\) \\{');
    const m = re.exec(HTML);
    if (!m) throw new Error('method not found: ' + name);
    let i = m.index + m[0].length, depth = 1, q = null;
    for (; i < HTML.length && depth > 0; i++) {
        const c = HTML[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
        if (c === '{') depth++; else if (c === '}') depth--;
    }
    const body = HTML.slice(m.index + m[0].length, i - 1);
    return { async: !!m[1], args: m[2], body };
}
const mk = (name) => { const m = method(name); const F = m.async ? Object.getPrototypeOf(async function () { }).constructor : Function; return new F(...m.args.split(',').map(s => s.trim().replace(/\s*=.*$/, '')).filter(Boolean), m.body); };
console.log('② 前端瘦身与服务器一致');
{
    const cli = mk('_slimHistoryItem');
    const cases = [fatItem('A', '2026-10-08T01:00:00.000Z', 'site7'), fatItem('B', '2026-10-08T02:00:00.000Z', 'nope'), { name: 'C', watchedAt: 'x' }, Object.assign(fatItem('D', 't'), { groupData: Object.assign(fatItem('D', 't').groupData, { sources: [] }) })];
    ok(cases.every(c => JSON.stringify(cli.call({}, c)) === JSON.stringify(slimHistoryItem(c))), '前端 _slimHistoryItem 与 lib/history-slim 结果逐字一致');
}

// ---------- ③ 前端增量推送逻辑 ----------
console.log('③ 前端增量推送');
function makeVm(token) {
    const store = new Map();
    const ls = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const calls = [];
    const net = { status: 200, body: { sync_enabled: true, saved: 1, deleted: 0 }, beacons: [] };
    const vm = { syncEnabled: true, syncToken: token, watchHistory: [], _lastPushTime: 0 };
    const names = ['_histSyncLoad', '_histSyncSave', '_slimHistoryItem', '_histPending', '_doPushHistory', 'pushHistoryBeacon', '_loadTombstones', '_saveTombstones', '_isTombstoned', 'pullAndMergeHistory'];
    const g = globalThis;
    g.localStorage = ls;
    g.fetch = async (url, opts) => {
        calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
        if (String(url).includes('/api/history/pull')) return { ok: true, status: 200, json: async () => net.pull };
        return { ok: net.status < 400, status: net.status, json: async () => net.body };
    };
    Object.defineProperty(g, 'navigator', { value: { sendBeacon: (u, blob) => { net.beacons.push(blob); return true; } }, configurable: true, writable: true });
    g.Blob = class { constructor(parts) { this.text = parts.join(''); this.size = this.text.length; } };
    for (const n of names) vm[n] = mk(n).bind(vm);
    vm.fetchRecommendations = () => { };
    return { vm, ls, calls, net };
}
{
    const tk = crypto.createHash('sha256').update('alice').digest('hex');
    const { vm, ls, calls, net } = makeVm(tk);
    vm.watchHistory = [fatItem('剧1', '2026-10-08T01:00:00.000Z'), fatItem('剧2', '2026-10-08T02:00:00.000Z')];
    await vm._doPushHistory();
    ok(calls.length === 1 && calls[0].body.history.length === 2, '第一次:两条都推(还没有服务器确认记录)');
    ok(JSON.stringify(calls[0].body).length < 20000, `推送体积小(瘦身后 ${JSON.stringify(calls[0].body).length} 字)`);
    await vm._doPushHistory();
    ok(calls.length === 1, '没有变化:不发请求');
    vm.watchHistory[0] = Object.assign({}, vm.watchHistory[0], { watchedAt: '2026-10-08T03:00:00.000Z', progressTime: 1500 });
    await vm._doPushHistory();
    ok(calls.length === 2 && calls[1].body.history.length === 1 && calls[1].body.history[0].id === '剧1', '只推变了的那一条');
    // 失败不记确认
    vm.watchHistory[1] = Object.assign({}, vm.watchHistory[1], { watchedAt: '2026-10-08T04:00:00.000Z' });
    net.status = 500;
    await vm._doPushHistory();
    net.status = 200;
    await vm._doPushHistory();
    ok(calls.length === 4 && calls[3].body.history.length === 1 && calls[3].body.history[0].id === '剧2', 'HTTP 500 不记确认,下次重推');
    // 服务器没存(没有 SQLite)不记确认
    vm.watchHistory[1] = Object.assign({}, vm.watchHistory[1], { watchedAt: '2026-10-08T05:00:00.000Z' });
    net.body = { sync_enabled: true, saved: 0, message: 'SQLite not available' };
    await vm._doPushHistory();
    net.body = { sync_enabled: true, saved: 1, deleted: 0 };
    await vm._doPushHistory();
    ok(calls.length === 6 && calls[5].body.history[0].id === '剧2', '服务器没存下(无 SQLite)不记确认');
    // 墓碑只推一次
    vm._saveTombstones({ 旧剧: 1790000000000 });
    await vm._doPushHistory();
    ok(calls.length === 7 && calls[6].body.deleted.length === 1 && calls[6].body.history.length === 0, '新墓碑推一次');
    await vm._doPushHistory();
    ok(calls.length === 7, '墓碑确认后不再推');
    // 推送期间又看了:确认的是发出那一刻的版本
    vm.watchHistory[0] = Object.assign({}, vm.watchHistory[0], { watchedAt: '2026-10-08T06:00:00.000Z' });
    const p = vm._doPushHistory();
    vm.watchHistory[0] = Object.assign({}, vm.watchHistory[0], { watchedAt: '2026-10-08T06:01:00.000Z' });
    await p;
    await vm._doPushHistory();
    ok(calls.length === 9 && calls[8].body.history[0].updated_at === Date.parse('2026-10-08T06:01:00.000Z'), '推送期间的新版本下次还会推');
    // 换账号:确认记录不串
    const st = JSON.parse(ls.getItem('donggua_hist_synced'));
    vm.syncToken = crypto.createHash('sha256').update('bob').digest('hex');
    await vm._doPushHistory();
    ok(st.t === tk.slice(0, 16) && calls.length === 10 && calls[9].body.history.length === 2, '换账号后按新账号重新确认(全推一次)');
    // beacon:只发变化的、不超过 60KB
    const big = makeVm(tk);
    big.vm.watchHistory = Array.from({ length: 50 }, (_, i) => fatItem('大剧' + i, new Date(Date.parse('2026-10-08T00:00:00Z') + i * 60000).toISOString()));
    big.vm.pushHistoryBeacon();
    const b = big.net.beacons[0];
    ok(b && b.size <= 60000 && JSON.parse(b.text).history.length > 3, `beacon 不超 60KB(${b && b.size} 字,${b && JSON.parse(b.text).history.length} 条,最近的优先)`);
    ok(b && JSON.parse(b.text).history[0].id === '大剧49', 'beacon 先装最近看的');
    big.vm.watchHistory.length = 0;
    big.net.beacons.length = 0;
    big.vm.pushHistoryBeacon();
    ok(big.net.beacons.length === 0, '没有变化:beacon 不发');
}
{
    // 拉取:记下服务器版本;同版本留本地完整快照;本地更新的才推
    const tk = crypto.createHash('sha256').update('carol').digest('hex');
    const { vm, calls, net } = makeVm(tk);
    const local = fatItem('同步剧', '2026-10-08T01:00:00.000Z');
    const newer = fatItem('本地更新的', '2026-10-08T09:00:00.000Z');
    vm.watchHistory = [local, newer];
    net.pull = {
        sync_enabled: true,
        history: [
            { id: '同步剧', data: slimHistoryItem(local), updated_at: Date.parse(local.watchedAt) },
            { id: '本地更新的', data: slimHistoryItem(Object.assign({}, newer, { watchedAt: '2026-10-08T08:00:00.000Z' })), updated_at: 0 },
            { id: '别的设备的', data: slimHistoryItem(fatItem('别的设备的', '2026-10-08T07:00:00.000Z')), updated_at: 0 },
        ],
        deleted: [{ id: '删掉的', deleted_at: 1790000000000 }],
    };
    await vm.pullAndMergeHistory();
    const same = vm.watchHistory.find(x => x.name === '同步剧');
    ok(same && same.groupData.sources.filter(s => s.vod_play_url).length === 20, '同一个版本:保留本地完整快照(不被服务器瘦身版替换)');
    ok(vm.watchHistory.some(x => x.name === '别的设备的'), '别的设备的条目合并进来');
    await vm._doPushHistory();
    const push = calls.find(c => String(c.url).includes('/api/history/push'));
    ok(push && push.body.history.length === 1 && push.body.history[0].id === '本地更新的' && push.body.deleted.length === 0, '拉取后只推本地更新的那一条,服务器已有的墓碑不再推');
}

// ---------- ④ 端到端 ----------
console.log('④ server.js 端到端');
globalThis.fetch = realFetch;
const Database = dep('better-sqlite3');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-sync-'));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));
const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
const port = 20000 + Math.floor(Math.random() * 20000);
const srv = spawn(process.execPath, ['server.js'], { cwd: tmp, env: Object.assign({}, process.env, { NODE_PATH, PORT: String(port), CACHE_TYPE: 'sqlite', ACCESS_PASSWORD: 'mainpw,alice', ADMIN_TOKEN: '', KAZUMI_DISABLE: '1', LIVE_TV_DISABLED: '1', DANMU_API_URL: '', CORS_PROXY_URL: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
const B = `http://127.0.0.1:${port}`;
const tok = crypto.createHash('sha256').update('alice').digest('hex');
const push = async (history, deleted) => { const r = await fetch(B + '/api/history/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, history, deleted: deleted || [] }) }); return r.json(); };
try {
    for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 100)); try { if ((await fetch(B + '/api/debug')).ok) break; } catch (e) { } }
    const fat = fatItem('端到端剧', '2026-10-08T01:00:00.000Z', 'site5');
    const at = Date.parse(fat.watchedAt);
    let r = await push([{ id: fat.name, data: fat, updated_at: at }]);
    ok(r.saved === 1, '入库 ' + JSON.stringify(r));
    const db = new Database(path.join(tmp, 'cache.db'), { fileMustExist: true });
    const row = db.prepare('SELECT item_data FROM user_history WHERE user_token = ? AND item_id = ?').get(tok, fat.name);
    ok(row && row.item_data.length < JSON.stringify(fat).length / 8 && JSON.parse(row.item_data).groupData.sources.filter(s => s.vod_play_url).length === 1, `老客户端推的胖条目入库时瘦身(${JSON.stringify(fat).length} → ${row && row.item_data.length})`);
    r = await push([{ id: fat.name, data: fat, updated_at: at }]);
    ok(r.saved === 0, '同一版本再推:跳过,不重写');
    r = await push([{ id: fat.name, data: Object.assign({}, fat, { progressTime: 1 }), updated_at: at - 1000 }]);
    ok(r.saved === 0, '旧版本不覆盖新版本');
    // 下发最多 100 条
    await push(Array.from({ length: 150 }, (_, i) => ({ id: '批量' + i, data: { name: '批量' + i, watchedAt: new Date(at + i * 1000).toISOString() }, updated_at: at + i * 1000 })));
    const pull = await (await fetch(B + '/api/history/pull?token=' + tok)).json();
    ok(pull.history.length === 100 && pull.history[0].id === '批量149', `下发最近 100 条(${pull.history.length})`);
    db.close();
    // 旧胖条目(升级前存的)下发时瘦身并写回
    const w = new Database(path.join(tmp, 'cache.db'));
    const legacy = fatItem('旧胖条目', new Date(at + 999999).toISOString());
    w.prepare('INSERT OR REPLACE INTO user_history (user_token, item_id, item_data, updated_at) VALUES (?, ?, ?, ?)').run(tok, legacy.name, JSON.stringify(legacy), at + 999999);
    w.close();
    const pull2 = await (await fetch(B + '/api/history/pull?token=' + tok)).json();
    const got = pull2.history.find(h => h.id === '旧胖条目');
    ok(got && got.data.groupData.sources.filter(s => s.vod_play_url).length === 1, '旧胖条目下发时已瘦身');
    const r2 = new Database(path.join(tmp, 'cache.db'), { fileMustExist: true });
    const after = r2.prepare('SELECT item_data FROM user_history WHERE user_token = ? AND item_id = ?').get(tok, legacy.name);
    r2.close();
    ok(after && after.item_data.length < 20000, `并写回数据库(${JSON.stringify(legacy).length} → ${after && after.item_data.length})`);
    // 两台设备:前端真方法 + 真服务器(fetch 转到测试服务器)
    {
        const dev = (name) => { const d = makeVm(tok); globalThis.fetch = (u, o) => realFetch(B + u, o); return d; };
        const A = dev('A');
        A.vm.watchHistory = [fatItem('双端剧1', '2026-10-09T01:00:00.000Z'), fatItem('双端剧2', '2026-10-09T02:00:00.000Z')];
        let sent = 0; const f0 = globalThis.fetch; globalThis.fetch = (u, o) => { if (String(u).includes('/push')) sent++; return f0(u, o); };
        await A.vm._doPushHistory();
        await A.vm._doPushHistory();
        ok(sent === 1, '设备 A:推一次后没有变化就不再发请求');
        A.vm.watchHistory[0] = Object.assign({}, A.vm.watchHistory[0], { watchedAt: '2026-10-09T03:00:00.000Z', episode: '第06集' });
        await A.vm._doPushHistory();
        ok(sent === 2, '设备 A:看了一集后只推这一条');
        const Bd = dev('B');
        Bd.vm.watchHistory = [];
        await Bd.vm.pullAndMergeHistory();
        const got = Bd.vm.watchHistory.find(x => x.name === '双端剧1');
        ok(got && got.episode === '第06集' && got.groupData.sources.filter(s => s.vod_play_url).length === 1, '设备 B 拉到最新集数(瘦身版,上次线路的选集串在)');
        let sentB = 0; const fb = globalThis.fetch; globalThis.fetch = (u, o) => { if (String(u).includes('/push')) sentB++; return fb(u, o); };
        await Bd.vm._doPushHistory();
        ok(sentB === 0, '设备 B 拉完不把拉来的再推回去');
        globalThis.fetch = realFetch;
    }
    // 墓碑照常生效
    r = await push([], [{ id: fat.name, deleted_at: at + 5000 }]);
    const pull3 = await (await fetch(B + '/api/history/pull?token=' + tok)).json();
    ok(!pull3.history.some(h => h.id === fat.name) && pull3.deleted.some(d => d.id === fat.name), '只推墓碑也能删除');
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e) + '\n' + log.slice(-1500));
} finally {
    srv.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
