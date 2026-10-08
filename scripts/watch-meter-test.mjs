// watchMeter 单元测试(桩 document/window/localStorage/fetch/navigator/时钟)
// 观看时长计时器(window.watchMeter)回归:node scripts/watch-meter-test.mjs —— 从 public/index.html 抽出模块,假时钟/假 video/假 fetch 下验证
// 只在真的在播时计时、离线合并成一批、tx 只记第一次发送、批次过期、换账号不合并等。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const html = fs.readFileSync(process.env.WM_HTML || path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html'), 'utf8').split('\r\n').join('\n');
const a = html.indexOf('window.watchMeter = {'), b = html.indexOf('let _lastProgressSaveTime');
const src = html.slice(a, b);
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x !== undefined ? JSON.stringify(x) : ''); } };

function env(opts = {}) {
    let now = 1_700_000_000_000;
    const store = new Map(opts.ls || []);
    const ls = {
        getItem: k => { if (opts.lsThrow) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
        setItem: (k, v) => { if (opts.lsThrow) throw new Error('blocked'); store.set(k, String(v)); },
        removeItem: k => store.delete(k)
    };
    const listeners = {};
    const video = { currentTime: 0, currentSrc: 'blob:x1', src: '', paused: false, ended: false, readyState: 4, duration: 2700, playbackRate: 1 };
    const doc = { hidden: false, visibilityState: 'visible', pictureInPictureElement: null, querySelector: () => opts.noVideo ? null : video, addEventListener: (t, f) => (listeners['d:' + t] = listeners['d:' + t] || []).push(f) };
    const posts = [], beacons = [];
    let fetchMode = opts.fetchMode || 'ok'; const held = [];
    const fetchStub = async (url, o) => {
        posts.push({ url, body: JSON.parse(o.body), keepalive: o.keepalive });
        if (fetchMode === 'net') throw new TypeError('Failed to fetch');
        if (fetchMode === 'hold') return new Promise(res => held.push(() => res({ ok: true, status: 200 })));
        if (fetchMode === '500') return { ok: false, status: 500 };
        if (fetchMode === '400') return { ok: false, status: 400 };
        return { ok: true, status: 200 };
    };
    const win = { addEventListener: (t, f) => (listeners['w:' + t] = listeners['w:' + t] || []).push(f), vueApp: { currentGroup: { name: '兰香如故' }, episodeList: [{ name: '第1集', url: 'u1' }, { name: '第2集', url: 'u2' }], currentUrl: 'u1', _liveActive: false } };
    const nav = { onLine: true, sendBeacon: (u, blob) => { beacons.push({ u, blob }); return true; } };
    const DateStub = { now: () => now };
    let intervalFn = null;
    const f = new Function('window', 'document', 'localStorage', 'fetch', 'navigator', 'Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'crypto', 'Blob',
        src + '\nreturn window.watchMeter;');
    const wm = f(win, doc, ls, fetchStub, nav, DateStub, (fn) => { intervalFn = fn; return 1; }, () => { }, setTimeout, clearTimeout, globalThis.crypto, Blob);
    if (!opts.noToken) store.set('emax_auth_hash', 'tok123');
    const tick = async (n = 1, advance = 1) => {
        for (let i = 0; i < n; i++) { now += 1000; if (!video.paused && video.readyState >= 2) video.currentTime += advance * video.playbackRate; intervalFn(); await new Promise(r => setImmediate(r)); }
    };
    return { wm, video, doc, win, store, posts, beacons, listeners, tick, held, setNow: x => now = x, getNow: () => now, setFetch: m => fetchMode = m, nav };
}
const pend = e => JSON.parse(e.store.get('donggua_watch_pending') || '[]');

// 1) 基本:播放 30s → 计 ~29s(首 tick dt=0 + new-src)
{
    const e = env(); e.wm.enable();
    await e.tick(31);
    const s = e.wm.status();
    ok(s.acc.length === 1 && s.acc[0].k === 'vod' && s.acc[0].t === '兰香如故' && s.acc[0].e === '第1集', '按 剧/集 累加', s.acc);
    ok(s.acc[0].s >= 28 && s.acc[0].s <= 30, '30 秒播放计 ~29s', s.acc[0].s);
    const S = () => e.wm.status().sessionSeconds;
    let base = S();
    // 暂停 20s 不计
    e.video.paused = true; await e.tick(20);
    ok(S() === base && e.wm.status().why === 'paused', '暂停不计');
    e.video.paused = false; e.video.readyState = 1; await e.tick(5);
    ok(e.wm.status().why === 'buffering' && S() === base, '缓冲不计');
    e.video.readyState = 4;
    // 卡住(currentTime 不动)
    e.video.playbackRate = 0.0000001; await e.tick(3); e.video.playbackRate = 1;
    ok(S() === base && e.wm.status().why === 'stalled', 'currentTime 不前进不计', e.wm.status());
    // 隐藏不计
    e.doc.hidden = true; await e.tick(5);
    ok(e.wm.status().why === 'hidden' && S() === base, '隐藏不计');
    // 画中画:隐藏也计
    e.doc.pictureInPictureElement = e.video; await e.tick(5);
    ok(S() >= base + 4, '画中画隐藏照计', S() - base);
    e.doc.hidden = false; e.doc.pictureInPictureElement = null;
}
// 2) 60s flush → pending → POST,2xx 删;payload 形状
{
    const e = env(); e.wm.enable();
    await e.tick(62);
    await new Promise(r => setTimeout(r, 10));
    const p = e.posts.filter(x => x.url === '/api/stats/watch');
    ok(p.length === 1, '60s flush 一次 POST', e.posts.length);
    const body = p[0] && p[0].body;
    ok(body && body.token === 'tok123' && /^[A-Za-z0-9_-]{8,40}$/.test(body.batch) && Array.isArray(body.items) && body.items.length === 1, 'payload 形状', body);
    const it = body.items[0];
    ok(it.k === 'vod' && it.t === '兰香如故' && it.e === '第1集' && Number.isInteger(it.s) && it.s >= 55 && it.s <= 60 && it.c === 0, 'item 形状', it);
    ok(p[0].keepalive === true, 'keepalive');
    ok(pend(e).length === 0, '2xx 后删除待发');
}
// 3) 网络失败 → 留在 pending,退避;恢复后补发
{
    const e = env({ fetchMode: 'net' }); e.wm.enable();
    await e.tick(62); await new Promise(r => setTimeout(r, 10));
    ok(pend(e).length === 1 && pend(e)[0].tx, '失败留在待发(标 tx)');
    ok(e.wm.status().retryIn > 0, '退避', e.wm.status());
    e.setFetch('ok');
    e.listeners['w:online'][0]();
    await new Promise(r => setTimeout(r, 10));
    ok(pend(e).length === 0, 'online 补发成功后清空');
}
// 4) 4xx 永久拒收 → 删
{
    const e = env({ fetchMode: '400' }); e.wm.enable();
    await e.tick(62); await new Promise(r => setTimeout(r, 10));
    ok(pend(e).length === 0, '400 删除不重试');
}
// 5) pagehide → beacon 不删;下次启动补发
{
    const e = env({ fetchMode: 'net' }); e.wm.enable();
    await e.tick(20);
    e.listeners['w:pagehide'][0]();
    ok(e.beacons.length === 1 && pend(e).length === 1 && pend(e)[0].tx, 'pagehide beacon 一批且不删');
    const blob = e.beacons[0].blob;
    ok(blob.type === 'application/json', 'beacon Blob 类型 application/json', blob.type);
    const txt = JSON.parse(await blob.text());
    ok(txt.token === 'tok123' && txt.items[0].s >= 17, 'beacon body', txt);
    // 下次启动(新页面)用同一 localStorage
    const e2 = env({ ls: [...e.store.entries()] }); e2.wm.enable();
    await new Promise(r => setTimeout(r, 10));
    ok(e2.posts.length === 1 && e2.posts[0].body.batch === txt.batch, '启动补发同一批次 id(服务器去重)');
    ok(pend(e2).length === 0, '补发成功删');
}
// 6) 过期:发过(tx)且 >2 天 → 不补发;没发过 >7 天 → 丢
{
    const old = 1_700_000_000_000 - 3 * 86400e3;
    const e = env({ ls: [['donggua_watch_pending', JSON.stringify([{ id: 'wold_aaaaaaaa', token: 't', items: [{ k: 'vod', t: 'x', e: '', s: 5, c: 0 }], at: old, tx: old }, { id: 'wnew_bbbbbbbb', token: 't', items: [{ k: 'vod', t: 'y', e: '', s: 5, c: 0 }], at: old }])]] });
    e.wm.enable(); await new Promise(r => setTimeout(r, 10));
    ok(e.posts.length === 1 && e.posts[0].body.batch === 'wnew_bbbbbbbb', '发过且超 2 天的不补发,没发过 3 天的照发', e.posts.map(p => p.body.batch));
}
// 7) 4 小时无操作不计;操作后恢复
{
    const e = env(); e.wm.enable();
    await e.tick(3);
    e.setNow(e.getNow() + 4 * 3600e3 + 1000);
    await e.tick(5);
    ok(e.wm.status().why === 'idle', '4h 无操作不计', e.wm.status().why);
    e.listeners['w:keydown'][0]();
    await e.tick(3);
    ok(e.wm.status().why === 'counting', '按键后恢复计');
}
// 8) 换源重设基线;直播
{
    const e = env(); e.wm.enable();
    await e.tick(5);
    e.video.currentSrc = 'blob:x2'; e.video.currentTime = 1000;   // 换源 + 跳到很后面
    await e.tick(1);
    ok(e.wm.status().why === 'new-src', '换源当秒不计');
    const s0 = e.wm.status().sessionSeconds;
    await e.tick(1);
    ok(e.wm.status().sessionSeconds - s0 <= 1.5, '换源后从新基线起算');
    e.win.vueApp.currentGroup = { name: 'CCTV-1', _isLive: true }; e.win.vueApp._liveActive = true; e.video.currentSrc = 'blob:lv';
    await e.tick(4);
    const live = e.wm.status().acc.find(x => x.k === 'live');
    ok(live && live.t === 'CCTV-1' && live.e === '', '直播 kind=live 集名空', e.wm.status().acc);
}
// 9) 看完:≥90% 且本页看了 ≥30s
{
    const e = env(); e.wm.enable();
    e.video.duration = 100; e.video.currentTime = 89;
    await e.tick(5);
    ok(e.wm.status().acc[0].c === 0, '拖到结尾只看几秒不算看完');
    e.video.currentTime = 50; e.video.currentSrc = 'blob:z';
    await e.tick(45);
    ok(e.wm.status().acc[0] && e.wm.status().acc[0].c === 1, '真看 ≥30s 且到 90% → c=1', e.wm.status().acc);
}
// 10) 无 token 不计;无视频;存储抛错不炸
{
    const e = env({ noToken: true }); e.wm.enable(); await e.tick(5);
    ok(e.wm.status().why === 'no-token' && e.wm.status().acc.length === 0, '无 token 不计');
    const e2 = env({ noVideo: true }); e2.wm.enable(); await e2.tick(3);
    ok(e2.wm.status().why === 'no-video', '无视频');
    const e3 = env({ lsThrow: true }); let threw = false;
    try { e3.wm.enable(); await e3.tick(3); e3.wm.flush('x'); e3.wm.status(); } catch (x) { threw = true; console.log(x); }
    ok(!threw, '存储全抛错也不抛出');
}
// 11) 休眠唤醒:一次 tick 墙钟跳 3 小时 → 最多计 5s
{
    const e = env(); e.wm.enable(); await e.tick(3);
    const s0 = e.wm.status().sessionSeconds;
    e.setNow(e.getNow() + 3 * 3600e3); e.video.currentTime += 3 * 3600;
    await e.tick(1);
    ok(e.wm.status().sessionSeconds - s0 <= 6, '休眠唤醒封顶 5s', e.wm.status().sessionSeconds - s0);
}
// 12) 待发上限 40
{
    const many = Array.from({ length: 45 }, (_, i) => ({ id: 'wbatch_' + String(i).padStart(4, '0'), token: 't', items: [{ k: 'vod', t: 'x', e: '', s: 1, c: 0 }], at: 1_700_000_000_000 }));
    const e = env({ fetchMode: 'net', ls: [['donggua_watch_pending', JSON.stringify(many)]] });
    e.wm.enable(); await new Promise(r => setTimeout(r, 10));
    ok(pend(e).length === 40 && pend(e)[0].id === 'wbatch_0005', '超 40 批丢最旧', pend(e).length);
}
// 13) 钉在媒体源上:换台时 currentGroup 先变、旧源还在播 → 仍记旧剧;换源后才记新频道
{
    const e = env(); e.wm.enable();
    await e.tick(4);
    e.win.vueApp.currentGroup = { name: 'CCTV-1', _isLive: true }; e.win.vueApp._liveActive = true;
    await e.tick(3);
    let acc = e.wm.status().acc;
    ok(acc.length === 1 && acc[0].t === '兰香如故' && acc[0].s >= 5, '测线路期间旧源照记旧剧', acc);
    e.video.currentSrc = 'blob:live'; await e.tick(3);
    acc = e.wm.status().acc;
    const lv = acc.find(x => x.k === 'live');
    ok(lv && lv.t === 'CCTV-1' && lv.s >= 1.5 && lv.s <= 2.5, '换源后记新频道', acc);
}
// 14) 集名归一
{
    const e = env(); const L = x => e.wm.epLabel(x);
    ok(L('第06集') === '第6集' && L('06') === '第6集' && L('EP6') === '第6集' && L('ep.06') === '第6集' && L('第 6 话') === '第6集', '集号写法归一', [L('第06集'), L('06'), L('EP6'), L('ep.06'), L('第 6 话')]);
    ok(L('第03期') === '第3期' && L('第0624期') === '第0624期' && L('20240624') === '20240624' && L('第1期上') === '第1期上' && L('HD中字') === 'HD中字' && L(null) === '' && L(' 正片 ') === '正片', '后缀/日期/非集号原样', [L('第03期'), L('第0624期'), L('20240624'), L('第1期上')]);
}
// ===== 回归:离线/长时间发不出去 → 并批(审查 #离线只留 40 分钟)、tx 只记第一次(审查 #重试刷新 tx) =====
const sumPend = e => pend(e).reduce((n, b) => n + b.items.reduce((m, x) => m + x.s, 0), 0);
const settle = () => new Promise(r => setTimeout(r, 10));
// 15) 真离线 100 分钟(每 10 分钟碰一下屏幕)→ 只有 1 批、秒数全在;联网后一次 POST 送达全部
{
    const e = env(); e.nav.onLine = false; e.wm.enable();
    for (let i = 0; i < 100; i++) { e.listeners['w:pointerdown'][0](); await e.tick(60); }
    const S = e.wm.status().sessionSeconds;
    ok(pend(e).length === 1 && Math.abs(sumPend(e) - S) <= 1 && S >= 5990, '离线 100 分钟并成 1 批、秒数不丢', { n: pend(e).length, sum: sumPend(e), S });
    ok(!pend(e)[0].tx, '离线没发过 → 无 tx');
    // 离线关页:不 beacon、不打 tx(否则 2 天后会被当成"已到服务器"丢掉)
    e.listeners['w:pagehide'][0]();
    ok(e.beacons.length === 0 && !pend(e)[0].tx && pend(e).length === 1, '离线 pagehide 不 beacon 也不打 tx', { b: e.beacons.length, p: pend(e) });
    // 下次离线打开接着并进同一批
    const e2 = env({ ls: [...e.store.entries()] }); e2.nav.onLine = false; e2.wm.enable();
    await e2.tick(62);
    ok(pend(e2).length === 1 && pend(e2)[0].id === pend(e)[0].id && sumPend(e2) > sumPend(e) + 50, '下次离线打开继续并进同一批', { n: pend(e2).length, a: sumPend(e), b: sumPend(e2) });
    const total = sumPend(e2);
    e2.nav.onLine = true; e2.listeners['w:online'][0](); await settle();
    const sent = e2.posts.reduce((n, p) => n + p.body.items.reduce((m, x) => m + x.s, 0), 0);
    ok(e2.posts.length === 1 && sent === total && pend(e2).length === 0, '联网后一次 POST 送达全部离线时长', { posts: e2.posts.length, sent, total });
}
// 16) 在线但站点不通(fetch 抛错 + 退避):第一批打 tx 后不再变;之后的累计并进第二批;重试不刷新 tx;恢复后各发一次
{
    const e = env({ fetchMode: 'net' }); e.wm.enable();
    await e.tick(62); await settle();
    const p1 = pend(e);
    ok(p1.length === 1 && p1[0].tx, '第一批发送失败,打了 tx', p1);
    const tx0 = p1[0].tx, s1 = sumPend(e);
    for (let i = 0; i < 30; i++) { e.listeners['w:pointerdown'][0](); await e.tick(60); await settle(); }   // 30 分钟,其间退避到期会重试
    const p2 = pend(e);
    ok(p2.length === 2, '发过的批次不再往里并,新累计全在第二批(不是每分钟一批)', p2.length);
    ok(p2[0].tx === tx0 && p2[0].items[0].s === p1[0].items[0].s, '重试不刷新 tx、发过的批次内容不变', { tx0, tx: p2[0].tx });
    ok(!p2[1].tx, '第二批一次都没发出去 → 无 tx(还能继续并)');
    ok(e.posts.length >= 2 && e.posts.every(p => p.body.batch === p1[0].id), '重试只发队头那批', e.posts.map(p => p.body.batch));
    const total = sumPend(e);
    const accS = e.wm.status().acc.reduce((n, x) => n + x.s, 0);
    ok(Math.abs(total + accS - e.wm.status().sessionSeconds) <= 1, '30 分钟不丢秒(待发 + 未满一批的累计 = 本页总计)', { total, accS, S: e.wm.status().sessionSeconds });
    e.setFetch('ok'); e.posts.length = 0; e.listeners['w:online'][0](); await settle();
    ok(pend(e).length === 0 && e.posts.length === 2 && new Set(e.posts.map(p => p.body.batch)).size === 2, '恢复后两批各发一次', e.posts.map(p => p.body.batch));
}
// 17) tx 从第一次发送起算:每天打开都发不出去,2 天后不再补发(落在服务器 3 天去重窗口内)
{
    const T0 = 1_700_000_000_000;
    const seed = [{ id: 'wtx_aaaaaaaa', token: 'tok123', items: [{ k: 'vod', t: '剧Z', e: '第1集', s: 29, c: 0 }], at: T0, tx: T0 }];
    let ls = [['donggua_watch_pending', JSON.stringify(seed)]];
    for (const d of [0.5, 1, 1.9]) {
        const e = env({ fetchMode: 'net', ls }); e.setNow(T0 + d * 86400e3); e.wm.enable(); await settle();
        ok(pend(e).length === 1 && pend(e)[0].tx === T0, `第 ${d} 天重试:tx 仍是第一次发送时间`, pend(e)[0]);
        e.listeners['w:pagehide'][0]();   // 在线 beacon 也不刷新 tx
        ok(pend(e)[0].tx === T0, `第 ${d} 天关页 beacon:tx 不刷新`, pend(e)[0]);
        ls = [...e.store.entries()];
    }
    const e = env({ ls }); e.setNow(T0 + 2.1 * 86400e3); e.wm.enable(); await settle();
    ok(e.posts.length === 0 && pend(e).length === 0, '第一次发送 2 天后不再补发(服务器 3 天后忘了 id,补发会重复计)', { posts: e.posts.length, p: pend(e) });
}
// 18) 并批的边界:换 token / 队尾已发过 / 队尾超过 1 天 → 另起新批;满 60 项:同剧集照并、新剧集另起;单条封顶 4h,余数另起
{
    const T0 = 1_700_000_000_000;
    const mk = (b) => [['donggua_watch_pending', JSON.stringify(b)]];
    const it = (t, s) => ({ k: 'vod', t, e: '第1集', s, c: 0 });
    // 换 token
    let e = env({ fetchMode: 'net', ls: mk([{ id: 'wtok_aaaaaaaa', token: 'other', items: [it('兰香如故', 10)], at: T0 }]) });
    e.nav.onLine = false; e.wm.enable(); await e.tick(62);
    ok(pend(e).length === 2 && pend(e)[0].items[0].s === 10 && pend(e)[1].token === 'tok123', '换 token 不并', pend(e));
    // 队尾有 tx
    e = env({ ls: mk([{ id: 'wtxd_aaaaaaaa', token: 'tok123', items: [it('兰香如故', 10)], at: T0, tx: T0 }]) });
    e.nav.onLine = false; e.wm.enable(); await e.tick(62);
    ok(pend(e).length === 2 && pend(e)[0].items[0].s === 10, '队尾发过(有 tx)不并', pend(e));
    // 队尾超过 1 天
    e = env({ ls: mk([{ id: 'wold_aaaaaaaa', token: 'tok123', items: [it('兰香如故', 10)], at: T0 - 1.5 * 86400e3 }]) });
    e.nav.onLine = false; e.wm.enable(); await e.tick(62);
    ok(pend(e).length === 2 && pend(e)[0].items[0].s === 10, '队尾建于 1 天前不并(防整批过期连新累计一起丢)', pend(e));
    // 队尾 1 天内:并,c 取或
    e = env({ ls: mk([{ id: 'wnew_aaaaaaaa', token: 'tok123', items: [it('兰香如故', 10)], at: T0 - 3600e3 }]) });
    e.nav.onLine = false; e.wm.enable(); await e.tick(62);
    ok(pend(e).length === 1 && pend(e)[0].items.length === 1 && pend(e)[0].items[0].s >= 65 && pend(e)[0].at === T0 - 3600e3, '同剧集秒数相加(批次建时不变)', pend(e));
    // 满 60 项
    const full = Array.from({ length: 59 }, (_, i) => it('剧' + i, 5)).concat([{ k: 'vod', t: '兰香如故', e: '第1集', s: 5, c: 0 }]);
    e = env({ ls: mk([{ id: 'wful_aaaaaaaa', token: 'tok123', items: full, at: T0 }]) });
    e.nav.onLine = false; e.wm.enable(); await e.tick(30);
    e.win.vueApp.currentUrl = 'u2'; e.video.currentSrc = 'blob:ep2'; await e.tick(35);   // 第 2 集 = 新剧集
    let p = pend(e);
    ok(p.length === 2 && p[0].items.length === 60 && p[0].items[59].s > 5 && p[1].items.length === 1 && p[1].items[0].e === '第2集', '满 60 项:同剧集照并,新剧集另起一批', p.map(b => b.items.length));
    // 单条封顶 4h
    e = env({ ls: mk([{ id: 'wcap_aaaaaaaa', token: 'tok123', items: [{ k: 'vod', t: '兰香如故', e: '第1集', s: 14390, c: 0 }], at: T0 }]) });
    e.nav.onLine = false; e.wm.enable(); await e.tick(62);
    p = pend(e);
    ok(p.length === 2 && p[0].items[0].s === 14400 && p[1].items[0].s >= 45 && Math.abs((14400 - 14390 + p[1].items[0].s) - e.wm.status().sessionSeconds) <= 3, '单条封顶 14400s,余数另起一批不丢', { s: p.map(b => b.items[0].s), S: e.wm.status().sessionSeconds });
}
// 19) 发送途中 flush:正在发的那批(已打 tx)不被并;快照里还没轮到的批次被并了 → 发出去的是并过的最新内容,不丢
{
    const T0 = 1_700_000_000_000;
    const it = (t, s) => ({ k: 'vod', t, e: '第1集', s, c: 0 });
    const e = env({ fetchMode: 'hold', ls: [['donggua_watch_pending', JSON.stringify([
        { id: 'wfly_aaaaaaaa', token: 'tok123', items: [it('甲', 7)], at: T0 },
        { id: 'wfly_bbbbbbbb', token: 'tok123', items: [it('兰香如故', 3)], at: T0 }])]] });
    e.wm.enable(); await settle();
    ok(e.held.length === 1 && pend(e)[0].tx && !pend(e)[1].tx, '第一批在途(有 tx),第二批还没轮到');
    await e.tick(62);   // flush:应并进第二批(无 tx),不碰在途的第一批
    const p = pend(e);
    ok(p.length === 2 && p[0].items[0].s === 7 && p[1].items[0].s > 50, '在途批次不被并;累计并进还没轮到的那批', p.map(b => b.items));
    const merged = p[1].items[0].s;
    e.held.shift()(); await settle();
    ok(e.posts.length === 2 && e.posts[1].body.batch === 'wfly_bbbbbbbb' && e.posts[1].body.items[0].s === merged, '轮到第二批时发的是并过的最新内容', e.posts.map(x => x.body.items));
    e.held.shift()(); await settle();
    ok(pend(e).length === 0, '两批 2xx 后都删掉', pend(e));
}

console.log(`watchMeter: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
