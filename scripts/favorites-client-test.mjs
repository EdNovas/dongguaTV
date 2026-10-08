// 收藏 / 推送 前端逻辑回归:node scripts/favorites-client-test.mjs
//  ① 从 public/index.html 抽出收藏相关方法(假 localStorage/fetch):fav_id 口径、角标文字、集数口径、条目瘦身(检查线路不用 kz)、
//     本机列表增删/上限 100、服务器状态合并(基线、原型键)、按检查线路认同名拆卡、seen 清红点(取较大集数)、同步/本机两条加载路径、♥ 满额提示
//  ② 推送辅助:base64url → 字节、公钥比对
//  ③ public/sw.js:v38、收藏/推送接口不缓存、push 弹通知(tag→renotify、坏 JSON 兜底)、notificationclick(切到已开窗口并跳转 / 开新窗口 / 外站地址回首页)、
//     pushsubscriptionchange(用旧选项重新订阅 + 通知页面补报)
//  ④ 审查修复回归(C1–C7):方法名冲突、同步未确认时 ♥ 不写、online/回首页重试、本机收藏迁移、v2board 重新登记、启动补报/退掉推送、
//     番剧线路收藏提示、深链作废、大家都在看只上 TMDB 认得的片
//     第二轮(K1–K3):本机收藏查更新带登录 token(假服务器按私密站契约没 token 回 401)、被动登出只清登录态(收藏/推送留着,
//     只有主动退出全量清,换号登录靠推送归属检查 + 收藏缓存按账号认)、v2board 面板连不上(unreachable)时放行不登出
//     第三轮(W1–W2):大家都在看缓存按账号认(换号不复用上个账号扣掉了自己那一票的列表,主动退出清掉,401 等失败回包不缓存)、
//     服务器不再落盘 v2board token 后,重启靠"sync_enabled:false → 本页补验证一次 → 重读配置"恢复:端到端(沙箱里真实 auth 脚本 +
//     真实的历史同步/设置拉取/收藏方法)验证恢复成同步模式;面板连不上照常进、收藏只显示、什么都不删;每页最多验证一次(启动验证问过就不再问)
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const norm = t => t.split('\r\n').join('\n');
const HTML = norm(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));
// 抽 Vue 方法:从 "    name(" 起数大括号到配平(跳过字符串里的括号;正则字面量里的括号不能不配平——这里的方法都满足)
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
    return { async: !!m[1], args: m[2], body: HTML.slice(m.index + m[0].length, i - 1) };
}
const mk = (name) => { const m = method(name); const F = m.async ? Object.getPrototypeOf(async function () { }).constructor : Function; return new F(...m.args.split(',').map(s => s.trim().replace(/\s*=.*$/, '')).filter(Boolean), m.body); };

const FAV_METHODS = ['_favIdOf', '_favWorkSig', '_favIsSync', '_favFind', 'favHasUpdate', 'favBadgeText', 'favSubText', '_favEpCountOf', '_favBuildItem',
    '_favLocalAdd', '_favMergeStatus', '_favLocalLoad', '_favLocalSave', '_favCacheLoad', '_favCacheSave', '_favBoot', 'loadFavorites', '_favLocalStatus',
    'toggleFavorite', 'removeFavorite', '_favOnPlay', '_favMarkSeen', '_b64uToU8', '_pushSameKey', '_pushErrText',
    'onFavPopRowScroll', '_favRetryBoot', '_favMigrateLocal', '_favRefreshMaybe', 'initHistorySync', '_syncConfigFetch',
    '_pushSupport', '_swReady', '_pushPost', '_pushKey', '_pushOwnerTag', '_pushOwnedByMe', '_pushStartupSync', '_pushRefreshState', 'pushSubscribe',
    'fetchPopular', '_popularPosters', 'confirmLogout', 'refreshV2boardInfo'];

// 历史同步 / 设置拉取的真实方法(opts.realSync:端到端用例里不用桩)
const SYNC_METHODS = ['syncHistory', 'pullAndMergeHistory', '_doPushHistory', '_histPending', '_histSyncLoad', '_histSyncSave', '_slimHistoryItem',
    '_loadTombstones', '_saveTombstones', '_isTombstoned', 'pullUserSettings'];

// opts.store:与沙箱里的 auth 脚本(mkAuth)共用同一份 localStorage
function makeVm(opts) {
    opts = opts || {};
    const store = opts.store || new Map();
    const ls = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), _m: store };
    const calls = [], toasts = [], winEv = {};
    const net = { status: 200, handler: null };
    const g = globalThis;
    g.localStorage = ls;
    const fakeFetch = async (url, o) => {
        const body = o && o.body ? JSON.parse(o.body) : null;
        calls.push({ url: String(url), body, opts: o || null });
        if (net.throwFor && net.throwFor(String(url), body)) throw new TypeError('Failed to fetch');
        const res = net.handler ? net.handler(String(url), body) : { status: 200, json: {} };
        return { ok: (res.status || 200) < 400, status: res.status || 200, json: async () => res.json };
    };
    g.fetch = fakeFetch;
    g.fetchT = (url, o, ms) => { calls.push({ fetchT: String(url), ms }); return fakeFetch(url, o); };
    g.atob = s => Buffer.from(s, 'base64').toString('binary');
    g.window = { addEventListener: (t, f) => { (winEv[t] = winEv[t] || []).push(f); }, matchMedia: () => ({ matches: false }), PushManager: function () { }, Notification: function () { } };
    delete g.revalidateV2boardSession; delete g.v2boardAnsweredThisLoad;
    const vmObj = {
        favoritesEnabled: true, favList: [], favLimit: 100, favBusy: false, syncEnabled: !!opts.sync, syncToken: opts.sync ? 'tok_abcdef0123456789xyz' : (opts.token || ''),
        currentGroup: null, currentSource: null, episodeList: [], imageMap: {}, watchHistory: [], _liveActive: false,
        pushEnabled: !!opts.push, isNativeApp: false, pushSubscribed: false, pushBusy: false, pushMsg: '',
        _favBooted: opts.booted !== false,
        showMiniToast: m => toasts.push(m),
        $refs: {}, $nextTick: f => f && f(),
        syncHistory: async () => { vmObj._synced = (vmObj._synced || 0) + 1; }, pullUserSettings: async () => { },
        _isKzSource: s => !!(s && (s._kz || /^kz_/.test(s.site_key || ''))),
        posterKey: gg => (gg && gg.name || '') + (gg && gg._workLabel && gg._workSig ? '|' + gg._workSig : ''),
    };
    for (const n of FAV_METHODS.concat(opts.realSync ? SYNC_METHODS : [])) { let f; try { f = mk(n); } catch (e) { f = () => { throw new Error('index.html 里没有方法 ' + n); }; } vmObj[n] = f.bind(vmObj); }
    if (opts.realSync) { vmObj.fetchRecommendations = () => { }; vmObj.applyCoverScale = () => { vmObj._coverApplied = (vmObj._coverApplied || 0) + 1; }; vmObj.coverScale = 1; vmObj.liveRecentChannels = []; }
    // curFav / pushUi 是 computed:测试里按同一实现现算
    Object.defineProperty(vmObj, 'curFav', { get() { return this.currentGroup ? this._favFind(this.currentGroup) : null; } });
    Object.defineProperty(vmObj, 'pushUi', {
        get() {
            if (!this.pushEnabled || this.isNativeApp) return 'hidden';
            const sup = this._pushSupport();
            if (sup === 'ios-browser') return 'ios-hint';
            if (sup !== 'ok') return 'hidden';
            return (this.syncEnabled && this.syncToken) ? 'ok' : 'need-sync';
        }
    });
    return { vm: vmObj, ls, calls, toasts, net, winEv };
}

const pu = n => Array.from({ length: n }, (_, i) => `第${String(i + 1).padStart(2, '0')}集$https://cdn.example.com/${i}/index.m3u8`).join('#');

// 假 /api/favorites/status,与 lib/favorites 同契约:有密码的站(tokens 非空 = authRequired)只认 body.token(也认 ?token=)里的
//   已登录 token,没有/不认识 → 401 {ok:false,error:'Invalid token'};公开站(tokens 空)不看 token。
//   (K1:客户端曾不带 token,私密站上本机收藏永远 401、永远没有更新角标,旧的假服务器对没 token 的请求也回 200 才没测出来)
function statusServer(tokens, st) {
    const valid = new Set(tokens || []);
    return (url, body) => {
        if (!String(url).startsWith('/api/favorites/status')) return null;
        if (valid.size) {
            let t = (body && typeof body.token === 'string' && body.token) ? body.token : '';
            if (!t) { try { t = new URL('http://x' + url).searchParams.get('token') || ''; } catch (e) { } }
            if (!valid.has(t)) return { status: 401, json: { ok: false, error: 'Invalid token' } };
        }
        const out = {};
        for (const it of (body && body.items) || []) out[it.site_key + '|' + it.vod_id] = Object.assign({ ep_count: 20, latest_ep: '第20集', remarks: '更新至第20集', finished: 0, changed_at: 5 }, st || {});
        return { status: 200, json: { status: out } };
    };
}

// ---------- ① 收藏纯逻辑 ----------
console.log('① 收藏逻辑');
{
    const { vm } = makeVm();
    ok(vm._favIdOf('庆余年', '') === '庆余年' && vm._favIdOf(' 遮天 ', 'y2023s') === '遮天|w:y2023s', 'fav_id = 剧名;同名多部带 |w:签名');
    ok(vm._favWorkSig({ name: 'x', _workSig: 'y2023s', _workLabel: '' }) === '' && vm._favWorkSig({ name: 'x', _workSig: 'y2023s', _workLabel: '2023·剧集' }) === 'y2023s', '只有拆了卡(_workLabel)才带签名(与分享深链/海报键同口径)');

    // 角标
    const it = (latest, n, seen) => ({ seen_count: seen, status: { ep_count: n, latest_ep: latest } });
    ok(vm.favBadgeText(it('第12集', 12, 10)) === '更新至第12集', '第12集 → 更新至第12集');
    ok(vm.favBadgeText(it('第05集', 5, 4)) === '更新至第5集', '去前导 0');
    ok(vm.favBadgeText(it('12', 12, 11)) === '更新至第12集', '纯数字集名');
    ok(vm.favBadgeText(it('20240105', 30, 29)) === '更新至01-05', '综艺日期集名');
    ok(vm.favBadgeText(it('2024-01-05期', 30, 29)) === '更新至01-05', '带横杠日期');
    ok(vm.favBadgeText(it('第三期', 3, 2)) === '更新至第三期', '中文期数');
    ok(vm.favBadgeText(it('HD中字', 9, 8)) === '更新至第9集', '认不出的集名用集数');
    ok(vm.favBadgeText(it('第12集', 12, 12)) === '' && !vm.favHasUpdate(it('第12集', 12, 12)), '没有更新:无角标');
    ok(!vm.favHasUpdate({ seen_count: 3, status: null }) && !vm.favHasUpdate(null), '没有状态:无更新');
    ok(vm.favSubText({ status: { remarks: '更新至第20集', ep_count: 20 } }) === '更新至第20集' && vm.favSubText({ status: { finished: 1, ep_count: 3 } }) === '已完结'
        && vm.favSubText({ data: { workLabel: '2023·剧集' }, status: null }) === '2023·剧集', '卡片副标题优先级');

    // 集数口径
    ok(vm._favEpCountOf({ vod_play_url: pu(24) }) === 24, '按 # 数集');
    ok(vm._favEpCountOf({ vod_play_url: '第1集$http://a/1.mp4#第2集$http://a/2.mp4$$$' + pu(30) }) === 30, '$$$ 分路取含 m3u8 的一路');
    ok(vm._favEpCountOf({ _cachedDetail: { vod_play_url: pu(7) } }) === 7 && vm._favEpCountOf({}) === 0, '回退 _cachedDetail;没有选集=0');

    // 条目瘦身
    const g = {
        name: '凡人修仙传', pic: 'https://img/x.jpg', _workSig: '', _workLabel: '', sources: [
            { site_key: 'kz_qisefan', vod_id: '88', site_name: '七色番', vod_play_url: pu(100) },
            ...Array.from({ length: 14 }, (_, i) => ({ site_key: 'site' + i, vod_id: 100 + i, site_name: '站' + i, vod_play_url: pu(150 + i), vod_content: 'x'.repeat(500), latency: 300 }))
        ]
    };
    const item = vm._favBuildItem(g, g.sources[3], [1, 2, 3]);
    ok(item.checkSource && item.checkSource.site_key === 'site2' && item.checkSource.vod_id === '102', '检查线路 = 当前线路');
    ok(item.addedEpCount === 152, '收藏时集数 = 检查线路集数(与服务器同口径)');
    ok(item.sources.length === 10 && item.sources[0].site_key === 'site2' && item.sources.every(s => !/^kz_/.test(s.site_key)), '最多 10 条线路、检查线路排第一、不含 kz');
    ok(Object.keys(item.sources[1]).sort().join() === 'site_key,site_name,vod_id' && item.kind === 'vod' && item.poster === 'https://img/x.jpg', '线路只留 site_key/vod_id/site_name');
    const kzItem = vm._favBuildItem(g, g.sources[0], []);
    ok(kzItem.checkSource.site_key === 'site0', '正在用番剧 kz_* 线路 → 换第一条 maccms 线路检查');
    vm.imageMap = { '遮天|y2023s': 'https://tmdb/p.jpg' };
    const split = vm._favBuildItem({ name: '遮天', pic: '', _workSig: 'y2023s', _workLabel: '2023·剧集', sources: [{ site_key: 'a', vod_id: 1 }] }, null, []);
    ok(split.workSig === 'y2023s' && split.workLabel === '2023·剧集' && split.poster === 'https://tmdb/p.jpg' && split.addedEpCount === 0, '同名拆卡:带签名/标注,海报用 TMDB 补的');
    vm.imageMap = {};

    // 本机增删/上限
    const e = (id) => ({ fav_id: id, data: { name: id }, added_at: 1, seen_count: 0, status: null });
    let r = vm._favLocalAdd([], e('A'), 100);
    ok(r.ok && r.list.length === 1, '加一条');
    r = vm._favLocalAdd(r.list, Object.assign(e('A'), { data: { name: 'A', poster: 'p' } }), 100);
    ok(r.ok && r.list.length === 1 && r.list[0].data.poster === 'p', '重复添加 = 更新 data');
    const full = Array.from({ length: 100 }, (_, i) => e('x' + i));
    r = vm._favLocalAdd(full, e('B'), 100);
    ok(!r.ok && r.error === 'limit' && r.list.length === 100, '满 100 部拒绝');
    ok(vm._favLocalAdd(full, e('x5'), 100).ok, '满了也能更新已有的');

    // 状态合并
    const list = [
        { fav_id: 'A', data: { name: 'A', checkSource: { site_key: 's1', vod_id: '1' } }, seen_count: 10, status: null },
        { fav_id: 'B', data: { name: 'B', checkSource: { site_key: 's2', vod_id: '2' } }, seen_count: 0, status: null },
        { fav_id: 'C', data: { name: 'C', checkSource: null }, seen_count: 0, status: null },
        { fav_id: 'D', data: { name: 'D', checkSource: { site_key: '__proto__', vod_id: 'x' } }, seen_count: 0, status: null },
    ];
    const map = JSON.parse('{"s1|1":{"ep_count":12,"latest_ep":"第12集"},"s2|2":{"ep_count":8,"latest_ep":"第8集"}}');
    const merged = vm._favMergeStatus(list, map);
    ok(merged[0].status.ep_count === 12 && merged[0].seen_count === 10 && vm.favHasUpdate(merged[0]), '有新集 → 亮红点');
    ok(merged[1].seen_count === 8 && !vm.favHasUpdate(merged[1]), '收藏时集数未知(0) → 第一次查到的当基线,不亮');
    ok(merged[2] === list[2] && merged[3] === list[3] && list[0].status === null, '没有检查线路/原型键不受影响,不改原数组');

    // 按检查线路认同名拆卡
    vm.favList = [{ fav_id: '遮天', data: { name: '遮天', checkSource: { site_key: 's9', vod_id: '9' } }, seen_count: 1, status: null }];
    ok(vm._favFind({ name: '遮天', _workSig: 'y2023s', _workLabel: '2023', sources: [{ site_key: 's9', vod_id: 9 }] }) === vm.favList[0], '收藏时没拆卡、现在拆了:按检查线路认出');
    ok(vm._favFind({ name: '遮天', _workSig: 'y2025m', _workLabel: '2025', sources: [{ site_key: 's1', vod_id: 1 }] }) === null, '同名另一部:不认');
    ok(vm._favFind({ name: '遮天', sources: [] }) === vm.favList[0], '没拆卡:按剧名');
}

// seen / 加载 / ♥(本机)
console.log('① 本机收藏:加载 / ♥ / seen(有密码的站,主密码 = 非同步用户)');
{
    const PW = 'pw_main_hash_0123456789abcdef';
    const { vm, ls, calls, toasts, net } = makeVm({ token: PW });
    const status = statusServer([PW]);
    net.handler = (url, body) => status(url, body) || { status: 404, json: {} };
    vm.currentGroup = { name: '庆余年', pic: 'p.jpg', sources: [{ site_key: 's1', vod_id: 7, site_name: '站1', vod_play_url: pu(18) }] };
    vm.currentSource = vm.currentGroup.sources[0];
    await vm.toggleFavorite();
    const saved = JSON.parse(ls.getItem('donggua_favorites'));
    ok(saved.length === 1 && saved[0].fav_id === '庆余年' && saved[0].seen_count === 18, '♥:写本机列表,seen 基线 = 收藏时集数');
    ok(toasts.length === 1 && /已收藏/.test(toasts[0]), '♥ 提示');
    await new Promise(r => setTimeout(r, 0));
    ok(calls.some(c => c.url === '/api/favorites/status' && c.body.items.length === 1 && c.body.items[0].site_key === 's1' && c.body.items[0].vod_id === '7'), '立刻问服务器这部的状态(登记进检查队列)');
    ok(calls.some(c => c.url === '/api/favorites/status' && c.body.token === PW), 'K1:状态请求带登录 token(私密站服务器只认已登录的)');
    ok(vm.favList[0].status && vm.favHasUpdate(vm.favList[0]) && vm.favBadgeText(vm.favList[0]) === '更新至第20集', '状态合并后亮红点');
    ok(!!vm.curFav, '详情页 ♥ 实心');
    // seen:当前线路只有 18 集,检查线路 20 集 → 取较大者,红点清掉
    vm.episodeList = Array.from({ length: 18 }, (_, i) => ({ name: '第' + (i + 1) + '集', url: 'u' + i }));
    vm._favOnPlay();
    ok(vm.favList[0].seen_count === 20 && !vm.favHasUpdate(vm.favList[0]), '起播清红点(取当前线路与检查线路集数较大者)');
    ok(JSON.parse(ls.getItem('donggua_favorites'))[0].seen_count === 20, 'seen 写回本机');
    // 再点 ♥ = 取消
    await vm.toggleFavorite();
    ok(vm.favList.length === 0 && JSON.parse(ls.getItem('donggua_favorites')).length === 0, '再点 ♥:取消收藏');
    // 满额
    const many = Array.from({ length: 100 }, (_, i) => ({ fav_id: 'x' + i, data: { name: 'x' + i }, added_at: i, seen_count: 0, status: null }));
    ls.setItem('donggua_favorites', JSON.stringify(many));
    await vm.loadFavorites();
    ok(vm.favList.length === 100, '加载本机列表');
    const n0 = toasts.length;
    await vm.toggleFavorite();
    ok(toasts.length === n0 + 1 && /收藏已满 100 部/.test(toasts[n0]) && JSON.parse(ls.getItem('donggua_favorites')).length === 100, '满 100 部:提示且不加');
    // 限流/失败不改列表
    net.handler = () => ({ status: 429, json: { error: 'rate' } });
    await vm._favLocalStatus();
    ok(vm.favList.length === 100, '状态接口 429:列表不变');
}

console.log('① 同步用户:服务器接口');
{
    const { vm, ls, calls, toasts, net } = makeVm({ sync: true });
    const server = [{ fav_id: 'A', data: { name: 'A', checkSource: { site_key: 's1', vod_id: '1' } }, added_at: 2, seen_count: 3, status: { ep_count: 5, latest_ep: '第5集' }, has_update: true }];
    net.handler = (url, body) => {
        if (url.startsWith('/api/favorites?token=')) return { status: 200, json: { enabled: true, limit: 100, items: server } };
        if (url === '/api/favorites/add') return body.item.name === 'FULL' ? { status: 200, json: { ok: false, error: 'limit', limit: 100 } } : { status: 200, json: { ok: true, fav_id: body.item.name } };
        if (url === '/api/favorites/remove') return { status: 500, json: { error: 'db' } };
        return { status: 200, json: { ok: true } };
    };
    await vm.loadFavorites();
    ok(vm.favList.length === 1 && vm.favHasUpdate(vm.favList[0]), '拉服务器列表');
    ok(JSON.parse(ls.getItem('donggua_fav_cache')).items.length === 1, '服务器列表缓存一份(冷启动/断网秒显)');
    ok(!calls.some(c => c.url === '/api/favorites/status'), '同步用户不调本机状态接口');
    vm.currentGroup = { name: 'B', pic: '', sources: [{ site_key: 's2', vod_id: 2, vod_play_url: pu(3) }] };
    vm.currentSource = vm.currentGroup.sources[0];
    await vm.toggleFavorite();
    const add = calls.find(c => c.url === '/api/favorites/add');
    ok(add && add.body.token === vm.syncToken && add.body.item.name === 'B' && add.body.item.checkSource.vod_id === '2', '♥ → POST /api/favorites/add {token,item}');
    ok(vm.favList.length === 2 && vm.favList[0].fav_id === 'B' && !ls.getItem('donggua_favorites'), '加进列表,不写本机列表');
    vm.currentGroup = { name: 'FULL', pic: '', sources: [{ site_key: 's3', vod_id: 3 }] }; vm.currentSource = null;
    await vm.toggleFavorite();
    ok(/收藏已满/.test(toasts[toasts.length - 1]) && vm.favList.length === 2, '服务器说满了:提示');
    // seen
    vm.currentGroup = { name: 'A', sources: [] };
    vm.episodeList = [1, 2, 3, 4];
    vm._favOnPlay();
    const seen = calls.find(c => c.url === '/api/favorites/seen');
    ok(seen && seen.body.fav_id === 'A' && seen.body.count === 5 && !vm.favHasUpdate(vm.favList.find(x => x.fav_id === 'A')), 'seen → POST /api/favorites/seen(count 取较大者 5)');
    // 删除失败回滚
    await vm.removeFavorite(vm.favList.find(x => x.fav_id === 'B'));
    ok(vm.favList.length === 2 && /取消收藏失败/.test(toasts[toasts.length - 1]), '服务器删除失败:放回并提示');
    // 服务器没开
    net.handler = () => ({ status: 200, json: { enabled: false, items: [] } });
    await vm.loadFavorites();
    ok(vm.favoritesEnabled === false && vm.favList.length === 0, 'enabled:false → 整个隐藏');
}

// ---------- ② 推送辅助 ----------
console.log('② 推送辅助');
{
    const { vm } = makeVm();
    const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    const u8 = vm._b64uToU8(key);
    ok(u8 instanceof Uint8Array && u8.length === 65 && u8[0] === 4, 'VAPID 公钥 base64url → 65 字节(0x04 开头)');
    ok(vm._pushSameKey({ options: { applicationServerKey: u8.buffer } }, key), '同一把公钥');
    const other = new Uint8Array(u8); other[10] ^= 1;
    ok(!vm._pushSameKey({ options: { applicationServerKey: other.buffer } }, key), '换过钥匙 → 不一致');
    ok(vm._pushSameKey({ options: {} }, key) && vm._pushSameKey(null, key), '拿不到 applicationServerKey 时当一致');
    ok(vm._pushErrText({ status: 429, d: { ok: false, error: 'rate' } }).includes('每分钟') && vm._pushErrText({ status: 401, d: { error: 'auth' } }).includes('重新登录')
        && vm._pushErrText({ status: 200, d: { ok: false, sent: 0, failed: 1 } }).includes('没有接收') && vm._pushErrText({ status: 200, d: { error: 'constructor' } }) === '失败：constructor', '推送错误码 → 中文提示(原型键不误命中)');
}

// ---------- ③ sw.js ----------
console.log('③ sw.js');
{
    const src = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
    ok(/const CACHE_VERSION = 'v38'/.test(src), 'CACHE_VERSION v38');
    const handlers = {};
    const shown = [];
    const wins = [];
    const opened = [];
    const resubs = [], posted = [];
    const self = {
        location: new URL('https://ednovas.video/sw.js'),
        addEventListener: (t, f) => { handlers[t] = f; },
        registration: {
            showNotification: async (title, opts) => { shown.push({ title, opts }); },
            pushManager: { subscribe: async (o) => { resubs.push(o); if (o.applicationServerKey === 'BAD') throw new Error('denied'); return { endpoint: 'https://fcm.googleapis.com/new' }; } }
        },
        clients: {
            matchAll: async () => wins,
            openWindow: async (u) => { opened.push(u); },
            claim: async () => { }
        },
        skipWaiting: () => { }
    };
    const ctx = vm.createContext({ self, URL, caches: {}, fetch: () => { throw new Error('no fetch'); }, Response: class { }, console, setTimeout });
    vm.runInContext(src, ctx);
    ok(typeof handlers.push === 'function' && typeof handlers.notificationclick === 'function', '注册了 push / notificationclick');

    // fetch 豁免:收藏/推送接口 SW 一律不接(不调 respondWith)
    const fetchEv = (u, method) => {
        let responded = false;
        handlers.fetch({ request: { url: u, method: method || 'GET', destination: '', mode: 'cors', headers: { has: () => false } }, respondWith: (p) => { responded = true; Promise.resolve(p).catch(() => { }); }, waitUntil: () => { } });
        return responded;
    };
    ok(!fetchEv('https://ednovas.video/api/favorites?token=abc') && !fetchEv('https://ednovas.video/api/favorites') && !fetchEv('https://ednovas.video/api/favorites/status', 'POST')
        && !fetchEv('https://ednovas.video/api/push/key') && !fetchEv('https://ednovas.video/api/requests/mine?token=t'), '收藏/推送/求片接口不进缓存');
    ok(fetchEv('https://ednovas.video/api/popular?window=7d') && fetchEv('https://ednovas.video/api/favoritesx'), '公开的 /api/popular 照常走缓存策略;前缀不误伤');

    const wait = [];
    const pushEv = (data) => handlers.push({ data, waitUntil: p => wait.push(p) });
    pushEv({ json: () => ({ title: '《庆余年》更新了', body: '更新至第20集', url: '/?play=%E5%BA%86%E4%BD%99%E5%B9%B4&ep=%E7%AC%AC20%E9%9B%86', tag: 'fav:庆余年' }) });
    await Promise.all(wait);
    const n1 = shown[0];
    ok(n1 && n1.title === '《庆余年》更新了' && n1.opts.body === '更新至第20集' && n1.opts.icon === '/icon.png' && n1.opts.badge === '/icon.png', 'push → showNotification(标题/正文/图标)');
    ok(n1.opts.tag === 'fav:庆余年' && n1.opts.renotify === true && n1.opts.data.url.startsWith('https://ednovas.video/?play='), 'tag 合并 + renotify,data.url 是站内绝对地址');
    pushEv({ json: () => ({ title: '测试通知', body: 'hi', url: '/' }) });
    pushEv({ json: () => { throw new Error('bad json'); }, text: () => 'plain text' });
    pushEv({ json: () => ({ title: 'x', url: 'https://evil.example/phish' }) });
    await Promise.all(wait);
    ok(!('renotify' in shown[1].opts) && !('tag' in shown[1].opts), '没有 tag 时不设 renotify(否则 showNotification 抛 TypeError)');
    ok(shown[2].title === 'E视界' && shown[2].opts.body === 'plain text', '坏 JSON 也弹兜底通知(userVisibleOnly 要求)');
    ok(shown[3].opts.data.url === 'https://ednovas.video/', '外站地址 → 回首页');

    // notificationclick
    const clickEv = (url) => { let closed = false; const p = []; handlers.notificationclick({ notification: { data: { url }, close: () => { closed = true; } }, waitUntil: x => p.push(x) }); return Promise.all(p).then(() => closed); };
    const nav = [];
    wins.push({ url: 'https://other.site/', focus: async () => { }, navigate: async () => { nav.push('wrong'); } });
    wins.push({ url: 'https://ednovas.video/?play=x', focused: false, focus: async function () { this.focused = true; }, navigate: async (u) => { nav.push(u); } });
    const closed = await clickEv('https://ednovas.video/?requests=1');
    ok(closed && wins[1].focused && nav.length === 1 && nav[0] === 'https://ednovas.video/?requests=1' && !opened.length, '有本站窗口:关通知 → 切过去并跳到目标页');
    wins.length = 0;
    await clickEv('https://ednovas.video/?play=abc');
    ok(opened.length === 1 && opened[0] === 'https://ednovas.video/?play=abc', '没有窗口:开新窗口');
    wins.push({ url: 'https://ednovas.video/', focus: async () => { }, navigate: async () => { throw new Error('not controlled'); } });
    await clickEv('/?requests=1');
    ok(opened.length === 2 && opened[1] === 'https://ednovas.video/?requests=1', '窗口不受本 SW 控制(navigate 失败):开新窗口');

    // pushsubscriptionchange(C3):用旧订阅的选项(同一把公钥)重新订阅,通知已打开的页面补报;失败一律吞掉
    ok(typeof handlers.pushsubscriptionchange === 'function', '注册了 pushsubscriptionchange');
    wins.length = 0;
    wins.push({ url: 'https://ednovas.video/', postMessage: (m) => posted.push(m) });
    const subEv = async (ev) => { if (typeof handlers.pushsubscriptionchange !== "function") return 0; const p = []; handlers.pushsubscriptionchange(Object.assign({ waitUntil: x => p.push(x) }, ev)); await Promise.all(p); return p.length; };
    const key = new Uint8Array([4, 1, 2]).buffer;
    ok(await subEv({ oldSubscription: { options: { applicationServerKey: key } } }) === 1 && resubs.length === 1
        && resubs[0].userVisibleOnly === true && resubs[0].applicationServerKey === key, '用旧选项(userVisibleOnly + 同一把公钥)重新订阅(event.waitUntil)');
    ok(posted.length === 1 && posted[0] === 'dg-push-resub', '重新订阅后通知已打开的页面立刻补报新地址');
    await subEv({ oldSubscription: null, newSubscription: { endpoint: 'https://fcm.googleapis.com/n2' } });
    ok(resubs.length === 1 && posted.length === 2, '浏览器已给了新订阅:不再重复订阅,只通知页面');
    await subEv({ oldSubscription: null, newSubscription: null });
    ok(resubs.length === 1 && posted.length === 2, '没有旧选项:什么也不做');
    let threw = false;
    try { await subEv({ oldSubscription: { options: { applicationServerKey: 'BAD' } } }); } catch (e) { threw = true; }
    ok(!threw && posted.length === 2, '重新订阅失败:吞掉,不通知');
}

// ---------- ④ 审查修复回归 ----------
// 每个用例块包一层:抛异常 = 失败(修复前缺方法/行为不同也只记失败,不中断后面的用例);方法里的日志不刷屏
const T = async (fn) => { try { await fn(); } catch (e) { fail++; console.log('  ✗ 抛异常: ' + ((e && e.message) || e)); } };
{
    const _log = console.log;
    console.error = () => { }; console.warn = () => { };
    console.log = (...a) => { if (typeof a[0] === 'string' && /^\[/.test(a[0])) return; _log(...a); };
}
const flush = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise(r => setTimeout(r, 0)); };
const NAV0 = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const restoreNav = () => { Object.defineProperty(globalThis, 'navigator', NAV0); delete globalThis.Notification; };

console.log('④ C1 收藏/大家都在看 行滚动不再顶掉分类榜单的 onRowScroll');
await T(async () => {
    ok((HTML.match(/\n {16}onRowScroll\(/g) || []).length === 1 && /\n {16}onRowScroll\(key\) \{/.test(HTML), 'methods 里只有一个 onRowScroll(key)(分类榜单的)');
    const { vm } = makeVm();
    vm.$refs.favRow = { scrollLeft: 0, clientWidth: 400, scrollWidth: 1200 };
    vm.favCanScrollLeft = true; vm.favCanScrollRight = false;
    vm.onFavPopRowScroll('favRow', 'fav');
    ok(vm.favCanScrollLeft === false && vm.favCanScrollRight === true, 'onFavPopRowScroll 按滚动位置写收藏行箭头');
    ok(/@scroll="onFavPopRowScroll\('favRow', 'fav'\)"/.test(HTML) && /@scroll="onFavPopRowScroll\('popularRow', 'popular'\)"/.test(HTML) && /@scroll="onRowScroll\(key\)"/.test(HTML),
        '模板:收藏/大家都在看用 onFavPopRowScroll,分类榜单仍是 onRowScroll(key)');
});

console.log('④ C2 同步状态没确认之前收藏不写;确认失败后重试;本机收藏迁移;v2board 重新登记');
await T(async () => {
    // (a) /api/config?token= 带超时;确认成功 → 同步模式启动
    const { vm, ls, calls, net } = makeVm({ booted: false });
    ls.setItem('emax_auth_hash', 'tok_sync_0123456789abcdef');
    net.handler = (url) => url.startsWith('/api/config?token=') ? { status: 200, json: { sync_enabled: true, push_enabled: false } }
        : url.startsWith('/api/favorites?token=') ? { status: 200, json: { enabled: true, limit: 100, items: [] } } : { status: 200, json: {} };
    await vm.initHistorySync(); await flush();
    const cfg = calls.find(c => c.fetchT && c.fetchT.startsWith('/api/config?token='));
    ok(cfg && cfg.ms > 0 && cfg.ms <= 10000 && !calls.some(c => !c.fetchT && c.url.startsWith('/api/config') && !calls.some(d => d.fetchT === c.url)), '/api/config?token= 走 fetchT 带超时(不再是裸 fetch)');
    ok(vm.syncEnabled && vm._favBooted && !vm._favDisplayOnly && calls.some(c => (c.url || "").startsWith('/api/favorites?token=')) && vm._synced === 1, '确认成功:同步模式启动收藏 + 首次历史同步');
});
await T(async () => {
    // (b) 确认失败(断网/5xx):只显示上次的服务器列表,♥/删除/seen 一律不写;(c) 回首页 / online 重试
    const { vm, ls, calls, toasts, net, winEv } = makeVm({ booted: false });
    ls.setItem('emax_auth_hash', 'tok_sync_0123456789abcdef');
    ls.setItem('donggua_fav_cache', JSON.stringify({ t: 'tok_sync_0123456', items: [{ fav_id: 'A', data: { name: 'A', checkSource: { site_key: 's1', vod_id: '1' } }, seen_count: 1, status: null }] }));
    const server = [{ fav_id: 'A', data: { name: 'A', checkSource: { site_key: 's1', vod_id: '1' } }, added_at: 2, seen_count: 1, status: null },
    { fav_id: 'B', data: { name: 'B', checkSource: { site_key: 's2', vod_id: '2' } }, added_at: 1, seen_count: 0, status: null }];
    let down = true;
    net.throwFor = (url) => down && url.startsWith('/api/config');
    net.handler = (url) => url.startsWith('/api/config?token=') ? { status: 200, json: { sync_enabled: true, push_enabled: false } }
        : url.startsWith('/api/favorites?token=') ? { status: 200, json: { enabled: true, limit: 100, items: server } } : { status: 200, json: { ok: true } };
    await vm.initHistorySync(); await flush();
    ok(!vm._favBooted && vm._favDisplayOnly && vm.favList.length === 1 && vm.favList[0].fav_id === 'A', '确认失败:只显示上次缓存的服务器列表');
    vm.currentGroup = { name: 'C', pic: '', sources: [{ site_key: 's3', vod_id: 3, vod_play_url: pu(5) }] };
    vm.currentSource = vm.currentGroup.sources[0];
    const n0 = calls.length;
    await vm.toggleFavorite();
    ok(toasts[toasts.length - 1] === '网络异常，稍后再试' && ls.getItem('donggua_favorites') === null && !calls.slice(n0).some(c => c.url && /^\/api\/favorites/.test(c.url)),
        '只显示态:♥ 提示「网络异常，稍后再试」,本机/服务器都不写');
    ok(vm.favList.length === 1 && vm.favList[0].fav_id === 'A', '只显示态:账号的收藏行不被本机列表顶掉');
    await vm.removeFavorite(vm.favList[0]);
    ok(vm.favList.length === 1 && toasts[toasts.length - 1] === '网络异常，稍后再试' && !calls.some(c => c.url === '/api/favorites/remove'), '只显示态:删除也不写');
    vm.favList[0].status = { ep_count: 5 }; vm.currentGroup = { name: 'A', sources: [] }; vm.episodeList = [1, 2, 3, 4, 5];
    vm._favOnPlay();
    ok(!calls.some(c => c.url === '/api/favorites/seen') && ls.getItem('donggua_favorites') === null, '只显示态:seen 不写(不会写进本机列表丢掉)');
    // 回首页:重试(最多 30s 一次;上面点 ♥ 时已经重试过一次,这里当 30s 已过)
    await flush();
    const cfgN = () => calls.filter(c => c.fetchT && c.fetchT.startsWith('/api/config?token=')).length;
    vm._favRetryAt = 0;
    const c0 = cfgN();
    vm._favRefreshMaybe(); await flush();
    ok(cfgN() === c0 + 1 && !vm._favBooted, '回首页(_favRefreshMaybe):重试确认同步状态(还没网:仍只显示)');
    vm._favRefreshMaybe(); await flush();
    ok(cfgN() === c0 + 1, '回首页重试 30s 内不重复');
    ok((winEv.online || []).length === 1, '只挂一次 online 监听');
    down = false;
    winEv.online[0](); await flush();
    ok(vm._favBooted && !vm._favDisplayOnly && vm.syncEnabled && vm.favList.length === 2 && vm._synced === 1, 'online:重试成功 → 同步模式启动(拉到服务器的完整列表)+ 补做首次历史同步');
    await vm.toggleFavorite();   // currentGroup A 已收藏 → 取消
    ok(calls.some(c => c.url === '/api/favorites/remove'), '确认后 ♥ 正常写服务器');
});
await T(async () => {
    // (b) 启动检查还没回来就点 ♥
    const { vm, ls, toasts } = makeVm({ booted: false });
    vm.currentGroup = { name: 'X', sources: [{ site_key: 's', vod_id: 1 }] };
    await vm.toggleFavorite();
    ok(toasts[0] === '网络异常，稍后再试' && ls.getItem('donggua_favorites') === null, '同步检查还在路上:♥ 不写');
});
await T(async () => {
    // (d) 一次性迁移:本机收藏 → 账号
    const { vm, ls, calls, net } = makeVm({ sync: true });
    const loc = (id, seen) => ({ fav_id: id, data: { name: id, checkSource: { site_key: 's', vod_id: id }, sources: [], addedEpCount: 2, kind: 'vod' }, added_at: 1, seen_count: seen, status: null });
    ls.setItem('donggua_favorites', JSON.stringify([loc('L1', 7), loc('S1', 3), loc('L2', 0)]));
    const server = [{ fav_id: 'S1', data: { name: 'S1' }, added_at: 1, seen_count: 3, status: null }];
    net.handler = (url, body) => {
        if (url.startsWith('/api/favorites?token=')) return { status: 200, json: { enabled: true, limit: 100, items: server.slice() } };
        if (url === '/api/favorites/add') { server.unshift({ fav_id: body.item.name, data: body.item, added_at: 2, seen_count: body.item.addedEpCount, status: null }); return { status: 200, json: { ok: true, fav_id: body.item.name } }; }
        return { status: 200, json: {} };
    };
    await vm.loadFavorites();
    const adds = calls.filter(c => c.url === '/api/favorites/add');
    ok(adds.length === 2 && adds[0].body.item.name === 'L1' && adds[1].body.item.name === 'L2' && adds.every(a => a.body.token === vm.syncToken), '本机收藏逐条 add 进账号(服务器已有的跳过)');
    ok(adds[0].body.item.addedEpCount === 7 && adds[1].body.item.addedEpCount === 2, 'seen 基线随迁移带过去(取较大者)');
    ok(ls.getItem('donggua_favorites') === null && vm.favList.length === 3, '迁完删掉本机列表,并重新拉服务器列表');
    const n = calls.length;
    await vm.loadFavorites();
    ok(!calls.slice(n).some(c => c.url === '/api/favorites/add'), '只迁一次');
});
await T(async () => {
    // 满 100 部:停下,删本机列表,提示没迁过去的
    const { vm, ls, calls, toasts, net } = makeVm({ sync: true });
    const loc = (id) => ({ fav_id: id, data: { name: id, checkSource: { site_key: 's', vod_id: id } }, added_at: 1, seen_count: 0, status: null });
    ls.setItem('donggua_favorites', JSON.stringify([loc('L1'), loc('L2'), loc('L3')]));
    const server = Array.from({ length: 99 }, (_, i) => ({ fav_id: 'x' + i, data: { name: 'x' + i }, added_at: 1, seen_count: 0, status: null }));
    net.handler = (url, body) => {
        if (url.startsWith('/api/favorites?token=')) return { status: 200, json: { enabled: true, limit: 100, items: server.slice() } };
        if (url === '/api/favorites/add') { if (server.length >= 100) return { status: 200, json: { ok: false, error: 'limit', limit: 100 } }; server.push({ fav_id: body.item.name, data: body.item }); return { status: 200, json: { ok: true, fav_id: body.item.name } }; }
        return { status: 200, json: {} };
    };
    await vm.loadFavorites();
    ok(calls.filter(c => c.url === '/api/favorites/add').length === 1 && ls.getItem('donggua_favorites') === null, '满 100 部:迁到满为止,删本机列表');
    ok(toasts.some(t => /收藏已满 100 部/.test(t) && /2 部没能同步/.test(t)), '提示有几部没能迁过去');
});
await T(async () => {
    // 中途断网 / 服务器 5xx:迁过去的不重复,剩下的留在本机下次再迁
    const { vm, ls, calls, net } = makeVm({ sync: true });
    const loc = (id) => ({ fav_id: id, data: { name: id, checkSource: { site_key: 's', vod_id: id } }, added_at: 1, seen_count: 0, status: null });
    ls.setItem('donggua_favorites', JSON.stringify([loc('L1'), loc('L2'), loc('L3')]));
    const server = [];
    let bad = 'L2';
    net.throwFor = (url, body) => url === '/api/favorites/add' && body.item.name === bad;
    net.handler = (url, body) => {
        if (url.startsWith('/api/favorites?token=')) return { status: 200, json: { enabled: true, limit: 100, items: server.slice() } };
        if (url === '/api/favorites/add') { server.push({ fav_id: body.item.name, data: body.item }); return { status: 200, json: { ok: true, fav_id: body.item.name } }; }
        return { status: 200, json: {} };
    };
    await vm.loadFavorites();
    ok(JSON.parse(ls.getItem('donggua_favorites')).map(x => x.fav_id).join() === 'L2,L3' && server.length === 1, '断网:L1 迁过去,L2/L3 留在本机');
    bad = '';
    vm._favLoading = false;
    await vm.loadFavorites();
    ok(ls.getItem('donggua_favorites') === null && server.map(x => x.fav_id).join() === 'L1,L2,L3', '下次加载:迁完剩下的,不重复');
    // 5xx
    ls.setItem('donggua_favorites', JSON.stringify([loc('L9')]));
    const h0 = net.handler;
    net.handler = (url, body) => url === '/api/favorites/add' ? { status: 503, json: { ok: false } } : h0(url, body);
    await vm.loadFavorites();
    ok(JSON.parse(ls.getItem('donggua_favorites')).length === 1, '服务器 5xx:留在本机');
});
await T(async () => {
    // (e) v2board:服务器说 sync_enabled:false(重启后 token 还没重新登记)→ 本页补做一次套餐验证,再读配置
    const { vm, ls, calls, net } = makeVm({ booted: false });
    ls.setItem('emax_auth_hash', 'v2board_aaaaaaaabbbbbbbb'); ls.setItem('emax_auth_type', 'v2board');
    let registered = false, rechecks = 0;
    globalThis.revalidateV2boardSession = async () => { rechecks++; registered = true; return true; };
    net.handler = (url) => url.startsWith('/api/config?token=') ? { status: 200, json: { sync_enabled: registered, push_enabled: false } }
        : url.startsWith('/api/favorites?token=') ? { status: 200, json: { enabled: true, limit: 100, items: [] } } : { status: 200, json: {} };
    await vm.initHistorySync(); await flush();
    ok(rechecks === 1 && calls.filter(c => c.fetchT && c.fetchT.startsWith('/api/config?token=')).length === 2 && vm.syncEnabled && vm._favBooted && vm._synced === 1,
        'v2board:sync_enabled:false → revalidateV2boardSession 一次 → 再读配置 → 同步模式');
});
await T(async () => {
    const { vm, ls, toasts, net } = makeVm({ booted: false });
    ls.setItem('emax_auth_hash', 'v2board_aaaaaaaabbbbbbbb'); ls.setItem('emax_auth_type', 'v2board');
    let rechecks = 0;
    globalThis.revalidateV2boardSession = async () => { rechecks++; return true; };
    net.handler = (url) => url.startsWith('/api/config?token=') ? { status: 200, json: { sync_enabled: false } } : { status: 200, json: {} };
    await vm.initHistorySync(); await flush();
    ok(rechecks === 1 && !vm._favBooted && vm._favDisplayOnly && !vm.syncEnabled, 'v2board 验证后仍没登记:只显示,不落本机列表');
    vm.currentGroup = { name: 'X', sources: [{ site_key: 's', vod_id: 1 }] };
    await vm.toggleFavorite();
    ok(toasts[toasts.length - 1] === '网络异常，稍后再试' && ls.getItem('donggua_favorites') === null, 'v2board 未确认:♥ 不写');
    vm._favRetryBoot(true); await flush();
    ok(rechecks === 1, '套餐验证每次页面加载只补一次(之后重试只重读配置)');
});
await T(async () => {
    // 普通密码用户 sync_enabled:false → 确定是本机模式,不补验证
    const { vm, ls, net } = makeVm({ booted: false });
    ls.setItem('emax_auth_hash', 'pw_hash_0123456789'); ls.setItem('emax_auth_type', 'password');
    let rechecks = 0;
    globalThis.revalidateV2boardSession = async () => { rechecks++; return true; };
    net.handler = (url) => url.startsWith('/api/config?token=') ? { status: 200, json: { sync_enabled: false } } : { status: 200, json: { status: {} } };
    await vm.initHistorySync(); await flush();
    ok(rechecks === 0 && vm._favBooted && !vm.syncEnabled, '非 v2board 的不同步账号:本机模式,不补验证');
    delete globalThis.revalidateV2boardSession;
});

console.log('④ C3 启动补报推送订阅 / 不该有的订阅退掉');
await T(async () => {
    const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    const env = (o) => {
        o = o || {};
        const ev = [], swl = [];
        const sub = o.noSub ? null : {
            endpoint: 'https://fcm.googleapis.com/fcm/send/abc', options: {},
            toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; },
            unsubscribe: async () => { ev.push('unsub'); return true; }
        };
        const reg = { pushManager: { getSubscription: async () => sub } };
        Object.defineProperty(globalThis, 'navigator', {
            value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', platform: 'Win32', maxTouchPoints: 0, serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg, addEventListener: (t, f) => swl.push([t, f]) } },
            configurable: true, writable: true
        });
        globalThis.Notification = { permission: o.perm || 'granted' };
        return { ev, sub, swl };
    };
    const mkPush = (o) => {
        const r = makeVm({ sync: o.sync, token: o.token, push: true });
        r.net.handler = (url) => url === '/api/push/key' ? { status: 200, json: { enabled: true, publicKey: KEY } } : { status: 200, json: { ok: true } };
        return r;
    };
    // 同步用户 + 已授权 + 浏览器有订阅 + 是这个账号开的 → 启动就补报(不用等打开偏好设置)
    {
        const { ev } = env();
        const { vm, ls, calls } = mkPush({ sync: true });
        ls.setItem('donggua_push_on', vm.syncToken.slice(0, 16));
        await vm._pushStartupSync(true);
        const s = calls.find(c => c.url === '/api/push/subscribe');
        ok(s && s.body.token === vm.syncToken && s.body.subscription.endpoint === 'https://fcm.googleapis.com/fcm/send/abc' && vm.pushSubscribed && !ev.includes('unsub'), '同步用户:启动补报订阅(幂等 subscribe)');
        const n = calls.length;
        await vm._pushStartupSync(true);
        ok(calls.length === n, '启动补报只跑一次');
    }
    // 旧版的 '1' 当作当前账号,并升级成账号标记
    {
        env();
        const { vm, ls, calls } = mkPush({ sync: true });
        ls.setItem('donggua_push_on', '1');
        await vm._pushStartupSync(true);
        ok(calls.some(c => c.url === '/api/push/subscribe') && ls.getItem('donggua_push_on') === vm.syncToken.slice(0, 16), '旧版标记 1:照样补报,升级成账号标记');
    }
    // 别的账号开的(被动登出没退干净)→ 退掉,不过户给现在的账号
    {
        const { ev } = env();
        const { vm, ls, calls } = mkPush({ sync: true });
        ls.setItem('donggua_push_on', 'someone_else_tok');
        await vm._pushStartupSync(true);
        ok(ev.includes('unsub') && !calls.some(c => c.url === '/api/push/subscribe') && !vm.pushSubscribed, '上个账号开的订阅:退掉,不悄悄过户');
        ok(ls.getItem('donggua_push_on') === null, '上个账号开的订阅退掉后,它的账号标记也清掉');
    }
    // 不是同步用户:退掉 + 尽量通知服务器
    {
        const { ev } = env();
        const { vm, ls, calls } = mkPush({ sync: false, token: 'pw_token_nosync_123' });
        ls.setItem('donggua_push_on', '1');
        await vm._pushStartupSync(true);
        const u = calls.find(c => c.url === '/api/push/unsubscribe');
        ok(ev.includes('unsub') && u && u.body.token === 'pw_token_nosync_123' && u.body.endpoint === 'https://fcm.googleapis.com/fcm/send/abc' && ls.getItem('donggua_push_on') === null,
            '不是同步用户:浏览器退订 + POST /api/push/unsubscribe + 清开关');
    }
    // 服务器关了推送:退掉
    {
        const { ev } = env();
        const { vm, ls, calls } = mkPush({ sync: true });
        ls.setItem('donggua_push_on', vm.syncToken.slice(0, 16));
        await vm._pushStartupSync(false);
        ok(ev.includes('unsub') && !calls.some(c => c.url === '/api/push/subscribe'), '服务器关了推送:退掉浏览器订阅');
    }
    // 没订阅 / 没授权:什么也不做
    {
        env({ noSub: true });
        const { vm, calls } = mkPush({ sync: true });
        await vm._pushStartupSync(true);
        ok(!calls.some(c => /\/api\/push\//.test(c.url || '')), '没有订阅:不发任何请求');
        const e2 = env({ perm: 'denied' });
        const r2 = mkPush({ sync: true });
        r2.ls.setItem('donggua_push_on', r2.vm.syncToken.slice(0, 16));
        await r2.vm._pushStartupSync(true);
        ok(!r2.calls.some(c => c.url === '/api/push/subscribe') && !e2.ev.includes('unsub'), '同步用户但没授权:不补报也不退');
    }
    // 走 initHistorySync 启动:同步确认后自动补报;SW 发来 dg-push-resub → 再补报一次
    {
        const { swl } = env();
        const { vm, ls, calls, net } = mkPush({ sync: false });
        vm._favBooted = false;
        ls.setItem('emax_auth_hash', 'tok_sync_0123456789abcdef');
        ls.setItem('donggua_push_on', 'tok_sync_0123456');
        const h0 = net.handler;
        net.handler = (url, b) => url.startsWith('/api/config?token=') ? { status: 200, json: { sync_enabled: true, push_enabled: true } }
            : url.startsWith('/api/favorites?token=') ? { status: 200, json: { enabled: true, limit: 100, items: [] } } : h0(url, b);
        await vm.initHistorySync(); await flush(10);
        ok(calls.filter(c => c.url === '/api/push/subscribe').length === 1, '启动(initHistorySync 确认同步后)自动补报,不依赖打开偏好设置');
        const msg = swl.find(x => x[0] === 'message');
        ok(!!msg, '监听 SW 消息');
        msg[1]({ data: 'dg-push-resub' }); await flush(10);
        ok(calls.filter(c => c.url === '/api/push/subscribe').length === 2, 'SW 重新订阅后(dg-push-resub)立刻补报新地址');
    }
    // 没登录(没 token):残留订阅退掉
    {
        const { ev } = env();
        const { vm } = mkPush({ sync: false });
        await vm.initHistorySync(); await flush(10);
        ok(ev.includes('unsub'), '没登录:残留的推送订阅退掉');
    }
    restoreNav();
});

console.log('④ K1 本机收藏查更新带登录 token(私密站服务器只认已登录的)');
await T(async () => {
    const PW = 'pw_main_hash_0123456789abcdef';
    const fav = (id, sk, vid) => ({ fav_id: id, data: { name: id, checkSource: { site_key: sk, vod_id: vid } }, added_at: 1, seen_count: 0, status: null });
    // syncToken 还没填(initHistorySync 没跑完)→ 读本地登录 token
    {
        const { vm, ls, calls, net } = makeVm({ token: '' });
        ls.setItem('emax_auth_hash', PW);
        ls.setItem('donggua_favorites', JSON.stringify([fav('A', 's1', '1'), fav('B', 's2', '2')]));
        net.handler = (url, body) => statusServer([PW])(url, body) || { status: 404, json: {} };
        await vm._favLocalStatus();
        const c = calls.find(x => x.url === '/api/favorites/status');
        ok(c && c.body.token === PW && c.body.items.length === 2, 'syncToken 为空时用本地登录 token(emax_auth_hash)');
        const saved = JSON.parse(ls.getItem('donggua_favorites'));
        ok(saved.every(x => x.status && x.status.ep_count === 20) && vm.favList.length === 2, '私密站 + 带 token:拿到状态并写回本机');
    }
    // 10 分钟刷新路径(loadFavorites 非同步分支)同样带 token
    {
        const { vm, ls, calls, net } = makeVm({ token: PW });
        ls.setItem('donggua_favorites', JSON.stringify([fav('A', 's1', '1')]));
        net.handler = (url, body) => statusServer([PW])(url, body) || { status: 404, json: {} };
        await vm.loadFavorites();
        ok(calls.some(x => x.url === '/api/favorites/status' && x.body.token === PW) && vm.favList[0].status && vm.favList[0].status.ep_count === 20, 'loadFavorites(启动/每 10 分钟)的状态请求也带 token');
    }
    // 假服务器确实按私密站契约拒绝没 token 的请求(契约漂移时这里先红)
    {
        const { vm, ls, calls, net } = makeVm({ token: '' });
        ls.setItem('donggua_favorites', JSON.stringify([fav('A', 's1', '1')]));
        net.handler = (url, body) => statusServer([PW])(url, body) || { status: 404, json: {} };
        await vm._favLocalStatus();
        const c = calls.find(x => x.url === '/api/favorites/status');
        ok(c && !c.body.token && JSON.parse(ls.getItem('donggua_favorites'))[0].status === null, '没有任何登录 token:私密站回 401,本机列表不变(不抛)');
    }
    // 公开站(没密码):服务器不看 token,照常
    {
        const { vm, ls, net } = makeVm({ token: '' });
        ls.setItem('donggua_favorites', JSON.stringify([fav('A', 's1', '1')]));
        net.handler = (url, body) => statusServer([])(url, body) || { status: 404, json: {} };
        await vm._favLocalStatus();
        ok(JSON.parse(ls.getItem('donggua_favorites'))[0].status.ep_count === 20, '公开站:不带 token 也照常拿状态');
    }
});

restoreNav();
console.log('④ K2 被动登出只清登录态(收藏/推送留着);只有主动退出全量清;换号登录由推送归属检查退订');
const AUTH_SRC = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('function clearAuthState'));
// 在沙箱里跑真实的 auth 脚本(不依赖 Vue)。session = 同一个标签页的 sessionStorage(跨"页面加载"共享)
const mkAuth = (o) => {
    o = o || {};
    const store = o.store || new Map();
    const ls = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), _m: store };
    const sess = o.session || new Map();
    const ev = [], fetches = [], timers = [], intervals = [], notes = [];
    let release = null;
    const sub = o.noSub ? null : {
        endpoint: 'https://fcm.googleapis.com/x',
        unsubscribe: () => { ev.push('unsub-start'); return o.hang ? new Promise(() => { }) : (o.manual ? new Promise(r => { release = () => { ev.push('unsub-done'); r(true); }; }) : (ev.push('unsub-done'), Promise.resolve(true))); }
    };
    const reg = o.noReg ? undefined : { pushManager: { getSubscription: async () => sub } };
    const el = () => ({ classList: { add() { }, remove() { }, contains() { return false; } }, style: {}, focus() { }, set textContent(v) { }, set innerHTML(v) { } });
    const reply = o.reply || (() => ({}));
    const g = {
        console: { log() { }, warn() { }, error() { }, info() { } }, localStorage: ls,
        sessionStorage: { getItem: k => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)), removeItem: k => sess.delete(k) },
        location: { search: '', reload: () => ev.push('reload') },
        document: {
            addEventListener() { }, getElementById: () => el(),
            createElement: () => { const n = { style: {}, textContent: '', className: '', remove() { } }; return n; },
            body: { appendChild: (n) => { notes.push(n.textContent); ev.push('notice'); } }
        },
        navigator: o.noSW ? {} : { serviceWorker: { getRegistration: async () => reg } },
        fetch: (url, opt) => {
            ev.push('fetch:' + url); fetches.push({ url, opt, body: opt && opt.body ? JSON.parse(opt.body) : null });
            if (o.throwFor && o.throwFor(url)) return Promise.reject(new TypeError('Failed to fetch'));
            return Promise.resolve({ status: 200, ok: true, json: async () => reply(url) });
        },
        alert: () => ev.push('alert'),
        setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() { },
        setInterval: (f, ms) => { intervals.push(f); return 7; }, clearInterval() { },
        URLSearchParams, JSON, Date, Promise, parseInt, Error
    };
    g.fetchT = (u, opt) => g.fetch(u, opt);
    g.window = g;
    g.startApp = () => { ev.push('startApp'); };
    vm.createContext(g);
    vm.runInContext(AUTH_SRC, g);
    return { g, ls, ev, fetches, timers, intervals, notes, sess, release: () => release && release() };
};
const LOCAL_FAVS = '[{"fav_id":"A","data":{"name":"A"}}]';
const seedAcct = (ls, tok) => {
    ls.setItem('emax_auth_hash', tok); ls.setItem('emax_auth_expiry', String(Date.now() + 1e9));
    ls.setItem('donggua_favorites', LOCAL_FAVS); ls.setItem('donggua_fav_cache', JSON.stringify({ t: tok.slice(0, 16), items: [{ fav_id: 'S', data: { name: 'S' } }] }));
    ls.setItem('donggua_push_on', tok.slice(0, 16)); ls.setItem('donggua_watch_history', '[{"name":"x"}]');
    ls.setItem('donggua_popular_cache3', JSON.stringify({ t: tok.slice(0, 16), ts: Date.now(), list: [] }));
};
const keptAll = (ls, tok) => ls.getItem('donggua_favorites') === LOCAL_FAVS && !!ls.getItem('donggua_fav_cache') && ls.getItem('donggua_push_on') === tok.slice(0, 16) && !!ls.getItem('donggua_watch_history');
const noUnsub = (r) => !r.fetches.some(f => f.url === '/api/push/unsubscribe') && !r.ev.includes('unsub-start');
await T(async () => {
    ok(!!AUTH_SRC && !/\bVue\b|vueApp\.|createApp/.test(AUTH_SRC.slice(AUTH_SRC.indexOf('function clearAccountLocalData'), AUTH_SRC.indexOf('function reloadAfterCleanup'))), 'clearAccountLocalData 在 auth 脚本里、不依赖 Vue');
    {
        // clearAuthState 只清登录态
        const r = mkAuth();
        const tok = 'v2board_tokA0123456789abcdef';
        seedAcct(r.ls, tok);
        r.ls.setItem('emax_auth_type', 'v2board'); r.ls.setItem('emax_v2board_token', 'vt'); r.ls.setItem('emax_v2board_email', 'a@x'); r.ls.setItem('emax_v2board_last_check', '1');
        r.g.clearAuthState(); await flush();
        ok(['emax_auth_hash', 'emax_auth_expiry', 'emax_auth_type', 'emax_v2board_token', 'emax_v2board_email', 'emax_v2board_last_check'].every(k => r.ls.getItem(k) === null), 'clearAuthState:清登录态');
        ok(keptAll(r.ls, tok), 'clearAuthState:本机收藏 / 收藏缓存 / 推送开关 / 历史都留着');
        ok(noUnsub(r), 'clearAuthState:不退订推送(浏览器、服务器都不动)');
    }
    {
        // v2board 套餐到期定时器(API 确认 expired)→ 清登录 → 提示 → 刷新;收藏/推送留着
        const tok = 'v2board_tokC0123456789abcdef';
        const r = mkAuth({ reply: (u) => u === '/api/auth/v2board/check' ? { success: false, expired: true, message: '已到期' } : {} });
        seedAcct(r.ls, tok);
        r.ls.setItem('emax_auth_type', 'v2board'); r.ls.setItem('emax_v2board_token', 'vt'); r.ls.setItem('emax_v2board_expires', String(Date.now() - 1000));
        r.g.startV2boardExpiryTimer();
        ok(r.intervals.length === 1, '到期检测定时器已挂');
        await r.intervals[0](); await flush();
        ok(r.ev.includes('alert') && r.ev.indexOf('reload') > r.ev.indexOf('alert') && r.ls.getItem('emax_auth_hash') === null, '套餐到期:清登录 → 提示 → 刷新');
        ok(keptAll(r.ls, tok) && noUnsub(r), '套餐到期(被动登出):收藏/推送留着,不退订');
    }
    {
        // 启动验证失败(独立密码校验不过)→ 登录页;收藏/推送留着
        const tok = 'tokE_0123456789abcdef';
        const r = mkAuth({ reply: (u) => u === '/api/auth/check' ? { requirePassword: true } : u === '/api/auth/verify' ? { success: false } : {} });
        seedAcct(r.ls, tok); r.ls.setItem('emax_auth_type', 'password');
        await r.g.checkAuthStatus(); await flush();
        ok(r.ls.getItem('emax_auth_hash') === null && keptAll(r.ls, tok) && noUnsub(r) && !r.ev.includes('reload') && !r.ev.includes('startApp'), '启动验证失败:只清登录态,收藏/推送留着');
    }
    {
        // 不勾"记住密码"的 24h 到期:同一个人第二天回来,本机收藏(非同步用户唯一一份)不能没
        const tok = 'f'.repeat(64);
        const r = mkAuth({ reply: (u) => u === '/api/auth/check' ? { requirePassword: true } : { success: true } });
        seedAcct(r.ls, tok); r.ls.setItem('emax_auth_type', 'password'); r.ls.setItem('emax_auth_expiry', String(Date.now() - 1000));
        await r.g.checkAuthStatus(); await flush();
        ok(r.ls.getItem('emax_auth_hash') === null && r.ls.getItem('donggua_favorites') === LOCAL_FAVS && noUnsub(r), '登录 24h 到期:要重新登录,本机收藏还在、推送不退');
    }
    {
        // v2board 启动验证:token 失效(不是连不上)→ 照旧登出,但收藏/推送留着
        const tok = 'v2board_' + 'a'.repeat(64);
        const r = mkAuth({ reply: (u) => u === '/api/auth/check' ? { requirePassword: true } : { success: false, message: 'Token 已过期，请重新登录', tokenExpired: true } });
        seedAcct(r.ls, tok);
        r.ls.setItem('emax_auth_type', 'v2board'); r.ls.setItem('emax_v2board_token', 'v2tok'); r.ls.setItem('emax_v2board_last_check', String(Date.now() - 6 * 864e5));
        await r.g.checkAuthStatus(); await flush();
        ok(r.ls.getItem('emax_auth_hash') === null && !r.ev.includes('startApp') && keptAll(r.ls, tok) && noUnsub(r), 'v2board token 失效:登出(登录页),收藏/推送留着');
    }
    {
        // 主动退出(confirmLogout 用的 clearAccountLocalData):全量清 + 浏览器退订 + 带旧 token 的 keepalive 退订;等退订做完(≤2s)再刷新
        const tok = 'tokA_0123456789abcdef';
        const r = mkAuth({ manual: true });
        seedAcct(r.ls, tok);
        r.g.reloadAfterCleanup(r.g.clearAccountLocalData(tok));
        await flush();
        ok(['donggua_favorites', 'donggua_fav_cache', 'donggua_push_on'].every(k => r.ls.getItem(k) === null), '主动退出:清本机收藏 + 收藏缓存 + 推送开关');
        ok(r.ls.getItem('donggua_popular_cache3') === null, '主动退出:清大家都在看缓存(W1)');
        const f = r.fetches.find(x => x.url === '/api/push/unsubscribe');
        ok(f && f.body.token === tok && f.body.endpoint === 'https://fcm.googleapis.com/x' && f.opt.keepalive === true, '主动退出:带旧 token 的 keepalive POST /api/push/unsubscribe');
        ok(!r.ev.includes('reload'), '主动退出:退订没做完先不刷新');
        r.release(); await flush();
        ok(r.ev.indexOf('reload') > r.ev.indexOf('unsub-done') && r.ev.indexOf('unsub-done') > 0, '主动退出:退订做完才刷新');
        const h = mkAuth({ hang: true }); seedAcct(h.ls, tok);
        h.g.reloadAfterCleanup(h.g.clearAccountLocalData(tok)); await flush();
        const cap = h.timers.find(t => t.ms === 2000);
        ok(!h.ev.includes('reload') && !!cap, '退订挂起:先等,最多 2s');
        cap && cap.f(); await flush();
        ok(h.ev.includes('reload'), '2s 到了照样刷新(绝不卡住)');
        const a = mkAuth({ noReg: true }); seedAcct(a.ls, tok); await a.g.clearAccountLocalData(tok);
        const b = mkAuth({ noSW: true }); seedAcct(b.ls, tok); await b.g.clearAccountLocalData(tok);
        ok(!a.fetches.length && !b.fetches.length && a.ls.getItem('donggua_favorites') === null && b.ls.getItem('donggua_push_on') === null, '没注册 SW / 不支持 SW:照样清本机数据,不报错不挂起');
    }
    {
        // Vue 的 confirmLogout:clearAccountLocalData(旧 token) → reloadAfterCleanup;设置里刷新订阅发现过期:只 clearAuthState → 登录页 → 刷新
        const { vm, ls } = makeVm({ sync: true });
        ls.setItem('emax_auth_hash', vm.syncToken);
        const got = [];
        const cleanupP = Promise.resolve('done');
        globalThis.confirm = () => true;
        globalThis.sessionStorage = { getItem: () => null, setItem() { }, removeItem() { } };
        globalThis.clearAccountLocalData = (t) => { got.push(['clear', t]); return cleanupP; };
        globalThis.reloadAfterCleanup = (p) => { got.push(['reloadAfter', p]); };
        vm.favList = [{ fav_id: 'A' }];
        vm.confirmLogout();
        ok(got.length === 2 && got[0][0] === 'clear' && got[0][1] === 'tok_abcdef0123456789xyz' && got[1][0] === 'reloadAfter' && got[1][1] === cleanupP && !vm.favList.length && !vm.syncToken,
            'confirmLogout:clearAccountLocalData(旧 token) → reloadAfterCleanup');
        const tq = [];
        const st0 = globalThis.setTimeout;
        let directReload = 0;
        globalThis.location = { reload: () => { directReload++; got.push(['reload']); } };
        globalThis.clearAuthState = () => { got.push(['cas']); };
        globalThis.showLoginScreen = () => { got.push(['login']); };
        got.length = 0;
        ls.setItem('emax_v2board_token', 'vt');
        globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ success: false, expired: true, message: '套餐已到期' }) });
        globalThis.setTimeout = (f, ms) => { tq.push({ f, ms }); return 0; };
        try { await vm.refreshV2boardInfo(); } finally { globalThis.setTimeout = st0; }
        const t3 = tq.find(t => t.ms === 3000);
        ok(!!t3, '设置刷新发现过期:3 秒后登出');
        t3 && t3.f();
        ok(got.map(x => x[0]).join() === 'cas,login,reload' && directReload === 1, '设置刷新过期:clearAuthState → 登录页 → 刷新(不清收藏/推送)');
        // 面板连不上:不登出,只提示
        got.length = 0; tq.length = 0;
        globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ success: false, unreachable: true, message: 'connect ETIMEDOUT' }) });
        globalThis.setTimeout = (f, ms) => { tq.push({ f, ms }); return 0; };
        try { await vm.refreshV2boardInfo(); } finally { globalThis.setTimeout = st0; }
        ok(!tq.some(t => t.ms === 3000) && !got.length && /连不上/.test(vm.v2bRefreshMsg) && vm.v2bRefreshOk === false, '设置刷新遇上面板连不上(unreachable):不登出,提示稍后再试');
        delete globalThis.confirm; delete globalThis.sessionStorage; delete globalThis.clearAccountLocalData; delete globalThis.reloadAfterCleanup; delete globalThis.clearAuthState; delete globalThis.showLoginScreen; delete globalThis.location;
    }
    ok(!/function clearAuthState\(\) \{[^}]*clearAccountLocalData/.test(AUTH_SRC) && (HTML.match(/clearAccountLocalData\(/g) || []).length === 2, 'clearAccountLocalData 只有主动退出在用(定义 + confirmLogout 一处调用)');
});
await T(async () => {
    // 换号登录:A(同步,开了推送)被动登出 → B(另一个同步账号)在同一台设备登录
    const A = 'tok_abcdef0123456789xyz', B = 'tokB_9999999999999999zz';
    const r = mkAuth();
    seedAcct(r.ls, A);
    r.ls.setItem('donggua_favorites', '[]');   // 同步账号的本机列表早迁完了
    r.g.clearAuthState(); await flush();
    const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    const login = (tok) => {
        const ev = [];
        const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', options: {}, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, unsubscribe: async () => { ev.push('unsub'); return true; } };
        const reg = { pushManager: { getSubscription: async () => sub } };
        Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', platform: 'Win32', maxTouchPoints: 0, serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg, addEventListener() { } } }, configurable: true, writable: true });
        globalThis.Notification = { permission: 'granted' };
        const x = makeVm({ sync: true, push: true });
        for (const [k, v] of r.ls._m) x.ls.setItem(k, v);
        x.ls.setItem('emax_auth_hash', tok);
        x.vm.syncToken = tok;
        x.net.handler = (url) => url === '/api/push/key' ? { status: 200, json: { enabled: true, publicKey: KEY } }
            : url.startsWith('/api/favorites?token=') ? { status: 200, json: { enabled: true, limit: 100, items: [{ fav_id: 'mine:' + tok.slice(0, 4), data: { name: 'mine' }, added_at: 1, seen_count: 0, status: null }] } }
                : { status: 200, json: { ok: true } };
        return Object.assign(x, { ev });
    };
    {
        const b = login(B);
        await b.vm._pushStartupSync(true);
        ok(b.ev.includes('unsub') && !b.calls.some(c => c.url === '/api/push/subscribe') && !b.vm.pushSubscribed && b.ls.getItem('donggua_push_on') === null,
            '换号登录:上个账号的推送订阅被归属检查退掉(不过户给新账号),清掉旧标记');
        b.vm._favBooted = false;
        b.net.throwFor = (url) => url.startsWith('/api/favorites?token=');
        b.vm._favBoot();
        ok(!b.vm.favList.some(x => x.fav_id === 'S'), '换号登录:上个账号的收藏缓存不显示(按账号认)');
        b.net.throwFor = null; b.vm._favLoading = false;
        await b.vm.loadFavorites();
        ok(b.vm.favList.length === 1 && b.vm.favList[0].fav_id === 'mine:tokB', '换号登录:只显示这个账号自己的服务器收藏');
    }
    {
        const a = login(A);
        await a.vm._pushStartupSync(true);
        ok(!a.ev.includes('unsub') && a.calls.some(c => c.url === '/api/push/subscribe' && c.body.token === A) && a.vm.pushSubscribed, '同一个人重新登录:推送照旧(补报订阅,不用重新打开开关)');
        a.vm._favBooted = false;
        a.net.throwFor = () => true;
        a.vm._favBoot();
        ok(a.vm.favList.length === 1 && a.vm.favList[0].fav_id === 'S', '同一个人重新登录:收藏缓存照旧秒显');
    }
    restoreNav();
});
await T(async () => {
    // 本机列表 donggua_favorites 只在非同步模式显示/使用
    const LOCAL = JSON.stringify([{ fav_id: 'L', data: { name: 'L', checkSource: { site_key: 's', vod_id: '1' } }, added_at: 1, seen_count: 0, status: null }]);
    {
        const { vm, ls } = makeVm({ booted: false, token: 'v2board_aaaaaaaabbbbbbbbcc' });
        ls.setItem('emax_auth_type', 'v2board'); ls.setItem('donggua_favorites', LOCAL);
        vm._favBoot(true);
        ok(vm._favDisplayOnly && vm.favList.length === 0, '只显示态 + v2board(一定是同步账号):不拿本机列表充数');
    }
    {
        const { vm, ls } = makeVm({ booted: false, token: 'pw_hash_0123456789' });
        ls.setItem('emax_auth_type', 'password'); ls.setItem('donggua_favorites', LOCAL);
        vm._favBoot(true);
        ok(vm.favList.length === 1 && vm.favList[0].fav_id === 'L', '只显示态 + 密码账号(多半是主密码 = 本机模式):显示本机列表');
    }
    {
        // 只显示态摆出了本机列表,之后确认是同步账号 → 换成本账号缓存/空,拉服务器失败也不会把本机列表当账号收藏
        const { vm, ls, net } = makeVm({ booted: false, sync: true });
        ls.setItem('donggua_favorites', LOCAL);
        vm.favList = JSON.parse(LOCAL);
        net.throwFor = () => true;
        vm._favBoot();
        await flush();
        ok(vm._favBooted && !vm.favList.some(x => x.fav_id === 'L'), '确认是同步账号:本机列表不显示(只等迁移)');
        net.throwFor = null; vm._favLoading = false;
        net.handler = (url, body) => url.startsWith('/api/favorites?token=') ? { status: 200, json: { enabled: true, limit: 100, items: [] } }
            : url === '/api/favorites/add' ? { status: 200, json: { ok: true, fav_id: body.item.name } } : { status: 200, json: {} };
        await vm.loadFavorites();
        ok(ls.getItem('donggua_favorites') === null, '同步模式照旧把本机列表一次性迁进账号');
    }
});

console.log('④ K3 v2board 启动验证遇上机场面板连不上:登录没过期就放行(不更新上次验证时间,本会话只提示一次)');
await T(async () => {
    const tok = 'v2board_' + 'b'.repeat(64);
    const seedV2b = (ls, o) => {
        o = o || {};
        ls.setItem('emax_auth_hash', tok); ls.setItem('emax_auth_type', 'v2board'); ls.setItem('emax_v2board_token', 'v2tok');
        ls.setItem('emax_auth_expiry', String(o.loginExpired ? Date.now() - 1000 : Date.now() + 1e10));
        ls.setItem('emax_v2board_last_check', String(LAST));
        ls.setItem('emax_v2board_expires', String(Date.now() + 30 * 864e5));
        ls.setItem('donggua_favorites', LOCAL_FAVS); ls.setItem('donggua_push_on', tok.slice(0, 16));
    };
    const LAST = Date.now() - 6 * 864e5;
    const UNREACH = { success: false, unreachable: true, message: 'connect ETIMEDOUT' };
    const replyWith = (v) => (u) => u === '/api/auth/check' ? { requirePassword: true } : v;
    const session = new Map();
    {
        const r = mkAuth({ session, reply: replyWith(UNREACH) });
        seedV2b(r.ls);
        await r.g.checkAuthStatus(); await flush();
        ok(r.ev.includes('startApp') && r.ls.getItem('emax_auth_hash') === tok, '面板连不上 + 登录没过期:照常进(不登出)');
        ok(r.ls.getItem('emax_v2board_last_check') === String(LAST), '不更新上次验证时间(下次打开页面再验)');
        ok(r.intervals.length === 1, '套餐到期检测定时器照常挂上');
        ok(r.notes.length === 1 && /连不上/.test(r.notes[0]), '给一条不挡操作的提示');
        ok(r.fetches.filter(f => f.url === '/api/auth/v2board/check').length === 1 && r.ls.getItem('donggua_favorites') === LOCAL_FAVS && r.ls.getItem('donggua_push_on') === tok.slice(0, 16) && noUnsub(r), '只验证一次;收藏/推送不动');
        // 同一个标签页再打开(新页面加载,sessionStorage 还在):还是放行,但不再提示
        const r2 = mkAuth({ session, store: r.ls._m, reply: replyWith(UNREACH) });
        await r2.g.checkAuthStatus(); await flush();
        ok(r2.ev.includes('startApp') && r2.notes.length === 0 && r2.fetches.some(f => f.url === '/api/auth/v2board/check'), '同一会话再次加载:照样重验、照样放行,提示不重复');
    }
    {
        // 新会话:再提示一次
        const r = mkAuth({ reply: replyWith(UNREACH) });
        seedV2b(r.ls);
        await r.g.checkAuthStatus(); await flush();
        ok(r.notes.length === 1, '新会话:提示一次');
    }
    {
        // 登录本身已过期 + 面板连不上:照旧登出(不能无限续命)
        const r = mkAuth({ reply: replyWith(UNREACH) });
        seedV2b(r.ls, { loginExpired: true });
        await r.g.checkAuthStatus(); await flush();
        ok(!r.ev.includes('startApp') && r.ls.getItem('emax_auth_hash') === null && r.notes.length === 0, '登录已过期 + 面板连不上:照旧登出');
    }
    {
        // 其它失败(没有 unreachable 标记)照旧登出
        for (const v of [{ success: false, message: '获取订阅信息失败' }, { success: false, expired: true, message: '您的套餐已过期' }, { success: false, tokenExpired: true, message: 'Token 已过期' }, { success: false, unreachable: 'yes', message: 'x' }]) {
            const r = mkAuth({ reply: replyWith(v) });
            seedV2b(r.ls);
            await r.g.checkAuthStatus(); await flush();
            ok(!r.ev.includes('startApp') && r.ls.getItem('emax_auth_hash') === null && r.notes.length === 0, '没有 unreachable:true 的失败照旧登出:' + JSON.stringify(v));
        }
    }
    {
        // 请求本身失败(断网/超时):原来的 fail-open 不变
        const r = mkAuth({ reply: replyWith({}), throwFor: (u) => u === '/api/auth/v2board/check' });
        seedV2b(r.ls);
        await r.g.checkAuthStatus(); await flush();
        ok(r.ev.includes('startApp') && r.ls.getItem('emax_auth_hash') === tok && r.ls.getItem('emax_v2board_last_check') === String(LAST), '请求失败(断网/超时):照旧放行,不更新上次验证时间');
    }
    {
        // 2 小时到期检测定时器:套餐本地已到期、API 说面板连不上 → 不登出(2 小时后再确认)
        const r = mkAuth({ reply: (u) => u === '/api/auth/v2board/check' ? UNREACH : {} });
        seedV2b(r.ls);
        r.ls.setItem('emax_v2board_expires', String(Date.now() - 1000));
        r.g.startV2boardExpiryTimer();
        await r.intervals[0](); await flush();
        ok(!r.ev.includes('alert') && !r.ev.includes('reload') && r.ls.getItem('emax_auth_hash') === tok, '到期检测遇上面板连不上:不登出');
    }
});

console.log('④ C5 只有番剧 kz_* 线路时的收藏');
await T(async () => {
    const { vm, ls, toasts, net, calls } = makeVm();
    net.handler = () => ({ status: 200, json: { status: {} } });
    vm.currentGroup = { name: '某番', pic: '', sources: [{ site_key: 'kz_qisefan', vod_id: '9', site_name: '七色番', vod_play_url: pu(12), _kz: true }] };
    vm.currentSource = vm.currentGroup.sources[0];
    await vm.toggleFavorite();
    const saved = JSON.parse(ls.getItem('donggua_favorites') || '[]');
    ok(saved.length === 1 && saved[0].data.checkSource === null, 'kz-only:照样收藏(当书签)');
    ok(toasts[toasts.length - 1] === '❤️ 已收藏（该线路不支持更新提醒）', 'kz-only:提示「已收藏（该线路不支持更新提醒）」,不承诺更新提醒');
    ok(vm.favSubText(saved[0]) === '不支持更新提醒', 'kz-only 卡片副标题「不支持更新提醒」');
    ok(vm.favSubText({ data: { checkSource: { site_key: 's', vod_id: '1' } }, status: null }) === '', '普通收藏没状态时副标题仍为空');
    const s = makeVm({ sync: true });
    s.net.handler = (url) => url === '/api/favorites/add' ? { status: 200, json: { ok: true, fav_id: '某番' } } : { status: 200, json: {} };
    s.vm.currentGroup = vm.currentGroup; s.vm.currentSource = vm.currentSource;
    await s.vm.toggleFavorite();
    const add = s.calls.find(c => c.url === '/api/favorites/add');
    ok(add && add.body.item.checkSource === null && s.toasts[s.toasts.length - 1] === '❤️ 已收藏（该线路不支持更新提醒）', '同步用户 kz-only:同样收藏 + 同样提示');
    const normal = makeVm();
    normal.net.handler = () => ({ status: 200, json: { status: {} } });
    normal.vm.currentGroup = { name: '庆余年', pic: '', sources: [{ site_key: 's1', vod_id: 7, vod_play_url: pu(3) }] };
    normal.vm.currentSource = normal.vm.currentGroup.sources[0];
    await normal.vm.toggleFavorite();
    ok(/有更新会在首页/.test(normal.toasts[0]), '普通线路:原来的提示');
});

console.log('④ C6 深链(收藏卡片按片名打开)作废');
await T(async () => {
    const SCRIPTS = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    const MAIN = SCRIPTS.find(s => s.includes('createApp({'));
    function any() {
        const f = function () { return any(); };
        return new Proxy(f, {
            get(t, k) {
                if (k === Symbol.toPrimitive) return () => '';
                if (k === 'then') return undefined;
                if (k === Symbol.iterator) return function* () { };
                return any();
            },
            apply() { return any(); }, construct() { return any(); }, set() { return true; }, has() { return true; }
        });
    }
    class FakeES {
        constructor(url) { this.url = url; this.closed = false; this.ls = {}; FakeES.all.push(this); }
        addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
        close() { this.closed = true; }
        msg(items) { if (!this.closed && this.onmessage) this.onmessage({ data: JSON.stringify(items) }); }
        done() { if (!this.closed) (this.ls.done || []).forEach(f => f()); }
    }
    FakeES.all = [];
    let tid = 0;
    const tq = new Map();
    let captured = null;
    const ctxObj = {
        Vue: { createApp(o) { captured = o; return { mount() { return {}; }, use() { return this; }, config: {} }; } },
        console: { log() { }, warn() { }, error() { }, info() { } },
        setTimeout: (f) => { const id = ++tid; tq.set(id, f); return id; }, clearTimeout: (id) => { tq.delete(id); }, setInterval: () => 0, clearInterval() { },
        requestAnimationFrame: () => 0, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet, Symbol, Error, TypeError,
        URL, URLSearchParams, Uint8Array, ArrayBuffer, Proxy, Reflect, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, AbortController, TextEncoder, TextDecoder,
        EventSource: FakeES,
    };
    const ctx = new Proxy(ctxObj, {
        has() { return true; },
        get(t, k) { if (k in t) return t[k]; if (k === 'window' || k === 'self' || k === 'globalThis') return ctx; return any(); },
        set(t, k, v) { t[k] = v; return true; }
    });
    try { vm.runInNewContext(MAIN, ctx, { timeout: 5000 }); } catch (e) { }
    const M = captured.methods;
    tq.clear();
    const runTimers = () => { for (let i = 0; i < 5 && tq.size; i++) for (const [id, f] of [...tq]) { tq.delete(id); try { f(); } catch (e) { } } };
    const mkSelf = () => {
        const opened = [];
        const self = {
            showDetail: false, currentGroup: null, currentSource: null, episodeList: [], currentUrl: '', previewLocked: false, deepLinkLoading: false,
            isTestingSources: false, deepLinkSourceCount: 0, offlineList: [], groupedList: [], introBtn: { show: false }, _liveOpenSeq: 0,
            watchHistory: [], searched: false, keyword: '', rawList: [], loading: false, isTVMode: false, refreshingEpisodes: false, showOfflinePanel: false,
            liveChannelId: null, liveTesting: false, _liveActive: false,
            $nextTick(f) { if (f) f(); return Promise.resolve(); },
            handleImgError() { }, _introRenderBtn() { }, _openOfflineContext() { }, releaseWakeLock() { }, syncShareUrl() { },
        };
        for (const k of ['openFavorite', '_openWorkByName', 'closeDetail', 'tryOpenDeepLink', '_clearDeepLinkTimers', '_cancelDeepLink', 'doSearch', 'autoSearch', 'clearSearch', 'playFromHistory']) self[k] = M[k];
        // 真的 openDetail 跑一遍(它第一句就是作废深链),其余依赖整个 App 的部分不管;再把"已打开"状态补上
        self.openDetail = function (g) {
            try { const p = M.openDetail.call(this, g); if (p && p.catch) p.catch(() => { }); } catch (e) { }
            opened.push(g.name); this.currentGroup = g; this.showDetail = true; this.deepLinkLoading = false;
        };
        return { self, opened };
    };
    const lastES = () => FakeES.all[FakeES.all.length - 1];
    {
        // 审查原场景:点收藏《繁花》(没历史)→ 返回 → 搜《狂飙》并在结果还在流时打开 → 那次搜索 done / 定时器 都不能再动它
        const { self, opened } = mkSelf();
        self.openFavorite({ fav_id: '繁花', data: { name: '繁花', workSig: '' } });
        const es1 = lastES();
        ok(self.showDetail && self.deepLinkLoading && self._deepLink && !self._deepLink.done && es1.url.includes(encodeURIComponent('繁花')), '收藏卡片(没历史)→ 按片名搜索 + 加载帧');
        self.closeDetail();
        ok(self._deepLink.done === true, '返回:深链作废(done)');
        ok(es1.closed && self._evtSource === null, '返回:深链自己的搜索连接关掉');
        ok(self.searched === false && self.keyword === '', '返回:回到打开前的首页(那条搜索用户没看见过)');
        self.autoSearch('狂飙');
        const es2 = lastES();
        self.groupedList = [{ name: '狂飙', sources: [{ site_key: 'a', vod_id: '1' }] }, { name: '繁花(番外)', sources: [{ site_key: 'b', vod_id: '2' }] }];
        es2.msg([{ vod_name: '狂飙', vod_pic: 'x' }]);
        self.openDetail(self.groupedList[0]);
        es1.msg([{ vod_name: '繁花', vod_pic: 'x' }]); es1.done();
        es2.done();
        runTimers();
        ok(self.showDetail === true && self.currentGroup.name === '狂飙' && opened.join() === '狂飙', '之后的搜索 done/防抖/12s 兜底不再关掉或换掉用户打开的剧');
    }
    {
        // 加载帧还在时搜别的:作废 + 收起加载帧 + 关掉深链那条搜索
        const { self } = mkSelf();
        self.openFavorite({ data: { name: '繁花' } });
        const es1 = lastES();
        self.autoSearch('狂飙');
        ok(self._deepLink.done && es1.closed && !self.showDetail && !self.deepLinkLoading && self.searched && self.keyword === '狂飙', '搜别的:深链作废、加载帧收起、露出新搜索');
        self.groupedList = [{ name: '繁花', sources: [{ site_key: 'a', vod_id: '1' }] }];
        lastES().done(); runTimers();
        ok(!self.showDetail, '新搜索结束也不会再开《繁花》');
    }
    {
        // 同名重搜不算换目标:深链跟着新连接继续等,结果到了照样打开
        const { self, opened } = mkSelf();
        self.openFavorite({ data: { name: '繁花' } });
        const es1 = lastES();
        self.autoSearch('繁花');
        const es2 = lastES();
        ok(!self._deepLink.done && es1.closed && self._deepLink.es === es2, '同名重搜:深链继续,改认新连接');
        self.groupedList = [{ name: '繁花', sources: [{ site_key: 'a', vod_id: '1' }] }];
        es2.done();
        ok(opened.join() === '繁花' && self._deepLink.done, '结果到了照样打开');
        self.closeDetail();
        ok(self.searched === true && self.keyword === '繁花', '深链落地后再返回:留在搜索结果(正常行为)');
    }
    {
        // 普通搜索:返回不关用户自己的搜索连接
        const { self } = mkSelf();
        self.autoSearch('庆余年');
        const es = lastES();
        self.groupedList = [{ name: '庆余年', sources: [{ site_key: 'a', vod_id: '1' }] }];
        self.openDetail(self.groupedList[0]);
        self.closeDetail();
        ok(!es.closed && self.searched && self.keyword === '庆余年' && self._evtSource === es, '普通搜索:返回不关搜索连接、不清搜索');
    }
    {
        // 继续观看 / 打开别的剧:作废还在等的深链
        const { self } = mkSelf();
        self.openFavorite({ data: { name: '繁花' } });
        const es1 = lastES();
        try { const p = self.playFromHistory({ name: '狂飙' }); if (p && p.catch) p.catch(() => { }); } catch (e) { }
        ok(self._deepLink.done && es1.closed, '继续观看:深链作废并关掉它的搜索');
        const b = mkSelf();
        b.self.openFavorite({ data: { name: '繁花' } });
        const es3 = lastES();
        b.self.openDetail({ name: '狂飙', sources: [] });
        ok(b.self._deepLink.done && es3.closed, '打开别的剧(openDetail):深链作废');
        b.self.groupedList = [{ name: '繁花', sources: [{ site_key: 'a', vod_id: '1' }] }];
        runTimers();
        ok(b.opened.join() === '狂飙' && b.self.currentGroup.name === '狂飙', '兜底定时器不再开《繁花》');
        // 回首页(goHome)
        const c = mkSelf();
        c.self.goHome = M.goHome; c.self.scrollToTop = () => { };
        c.self.openFavorite({ data: { name: '繁花' } });
        const es4 = lastES();
        c.self.goHome();
        c.self.groupedList = [{ name: '繁花', sources: [{ site_key: 'a', vod_id: '1' }] }];
        runTimers();
        ok(c.self._deepLink.done && es4.closed && !c.self.showDetail && !c.opened.length, '回首页:深链作废,不会被兜底定时器开回来');
    }
});

console.log('④ C7 大家都在看');
await T(async () => {
    globalThis.runWithConcurrency = async (arr, n, fn) => { for (const x of arr) await fn(x); };
    const tmdb = {
        '庆余年': [{ media_type: 'tv', name: '庆余年', poster_path: '/a.jpg', first_air_date: '2019-11-26' }],
        '繁花': [{ media_type: 'tv', name: '繁花', poster_path: '/b.jpg', first_air_date: '2023-12-27' }],
        '狂飙': [{ media_type: 'tv', name: '狂飙', poster_path: '/c.jpg', first_air_date: '2023-01-14' }],
        '漫长的季节': [{ media_type: 'tv', name: '漫长的季节', poster_path: '/d.jpg' }],
        '赘婿 加V看全集': [{ media_type: 'tv', name: '赘婿', poster_path: '/z.jpg' }],
    };
    const queries = [];
    globalThis.tmdbFetch = async (u) => { const q = new URL('http://x' + u).searchParams.get('query'); queries.push(q); return { json: async () => ({ results: tmdb[q] || [] }) }; };
    const items = [{ title: '庆余年第二季', users: 9, seconds: 99999, episodes: 50 }, { title: '繁花' }, { title: '狂飙' }, { title: '加微信看片 xx' }, { title: '赘婿 加V看全集' }, { title: '漫长的季节' }];
    const { vm, calls, net } = makeVm({ token: 'tok_pw_0123456789abcdef' });
    net.handler = (url) => url.startsWith('/api/popular') ? { status: 200, json: { items } } : { status: 200, json: {} };
    await vm.fetchPopular();
    const pc = calls.find(c => (c.url || "").startsWith('/api/popular'));
    ok(pc && pc.url === '/api/popular?window=7d&token=' + encodeURIComponent('tok_pw_0123456789abcdef'), '/api/popular?window=7d&token=<登录 token>');
    const names = vm.popularList.map(x => x.name);
    ok(names.join() === '庆余年第二季,繁花,狂飙,赘婿,漫长的季节', 'TMDB 认不出的丢掉;不是精确同名的显示 TMDB 片名(任意文字上不了首页):' + names.join());
    ok(vm.popularList.every(x => !('users' in x) && !('seconds' in x) && !('episodes' in x) && x.poster_path), '不读人数/时长/集数,每张都有海报');
    ok(/autoSearch\(item\.name\)/.test(HTML) && !/item\.users/.test(HTML), '模板:不显示人数,点卡片搜显示的片名');
    // 过滤后不足 4 部:整行隐藏
    const r2 = makeVm({ token: '' });
    r2.ls.setItem('emax_auth_hash', 'tok_from_storage');
    r2.net.handler = (url) => url.startsWith('/api/popular') ? { status: 200, json: { items: [{ title: '繁花' }, { title: '狂飙' }, { title: '庆余年' }, { title: '垃圾1' }, { title: '垃圾2' }] } } : { status: 200, json: {} };
    await r2.vm.fetchPopular();
    ok(r2.calls.some(c => c.url === '/api/popular?window=7d&token=tok_from_storage'), '没有 syncToken 时用本地登录 token');
    ok(r2.vm.popularList.length === 0, '过滤后不足 4 部:整行隐藏');
    // 老缓存(含人数、没过滤)不再用
    const r3 = makeVm({ token: 't' });
    r3.ls.setItem('donggua_popular_cache', JSON.stringify({ ts: Date.now(), list: [{ title: '垃圾', users: 3 }, { title: 'b', users: 3 }, { title: 'c', users: 3 }, { title: 'd', users: 3 }] }));
    r3.net.handler = () => ({ status: 200, json: { items: [] } });
    await r3.vm.fetchPopular();
    ok(r3.vm.popularList.length === 0 && r3.ls.getItem('donggua_popular_cache') === null, '旧格式缓存作废');
    delete globalThis.runWithConcurrency; delete globalThis.tmdbFetch;
});

console.log('④ W1 大家都在看缓存按账号认:换号不复用上个账号的列表;主动退出清掉;失败回包不缓存');
{
    globalThis.runWithConcurrency = async (arr, n, fn) => { for (const x of arr) await fn(x); };
    const POSTER = { '繁花': '/b.jpg', '狂飙': '/c.jpg', '庆余年': '/a.jpg', '漫长的季节': '/d.jpg', '三体': '/e.jpg', '人世间': '/f.jpg' };
    globalThis.tmdbFetch = async (u) => { const q = new URL('http://x' + u).searchParams.get('query'); return { json: async () => ({ results: POSTER[q] ? [{ media_type: 'tv', name: q, poster_path: POSTER[q] }] : [] }) }; };
    const ALICE = 'tok_alice_0123456789abcdef', MAIN = 'tok_main_9876543210fedcba', LATE = 'v2board_' + 'd'.repeat(64);
    // 与 lib/popular 同契约:私密站认不出的 token → 401;每个账号的回包扣掉了他自己那一票(列表各不相同)
    const lists = { [ALICE]: ['繁花', '狂飙', '庆余年', '漫长的季节'], [MAIN]: ['三体', '人世间', '繁花', '狂飙'] };
    const popServer = (url) => {
        if (!url.startsWith('/api/popular')) return { status: 200, json: {} };
        const t = new URL('http://x' + url).searchParams.get('token') || '';
        if (!lists[t]) return { status: 401, json: { ok: false, error: 'auth' } };
        return { status: 200, json: { window: '7d', items: lists[t].map(title => ({ title, kind: 'vod' })) } };
    };
    const popCalls = (x) => x.calls.filter(c => (c.url || '').startsWith('/api/popular'));
    const store = new Map();
    const page = (tok) => { const x = makeVm({ store, token: tok }); if (tok) x.ls.setItem('emax_auth_hash', tok); else x.ls.removeItem('emax_auth_hash'); x.net.handler = popServer; return x; };
    const cached = () => { try { return JSON.parse(store.get('donggua_popular_cache3') || 'null'); } catch (e) { return null; } };
    const noCache = () => !store.has('donggua_popular_cache3') && !store.has('donggua_popular_cache2');
    await T(async () => {
        // 审查原场景:alice 打开首页(列表进缓存)→ 退出 → 主密码用户 30 分钟内在同一台设备登录
        store.clear();
        const a = page(ALICE);
        await a.vm.fetchPopular();
        ok(a.vm.popularList.map(x => x.name).join() === '繁花,狂飙,庆余年,漫长的季节', 'alice 拿到自己的列表');
        const c = cached();
        ok(c && c.t === ALICE.slice(0, 16) && c.list.length === 4, '缓存带账号标记 t = token 前 16 位(与收藏缓存同口径)');
        const a2 = page(ALICE);
        await a2.vm.fetchPopular();
        ok(!popCalls(a2).length && a2.vm.popularList.length === 4, '同一账号 30 分钟内:照旧用缓存,不发请求');
        // 被动登出(clearAuthState 不清缓存)后换人:按账号认,不复用
        const m = page(MAIN);
        await m.vm.fetchPopular();
        ok(popCalls(m).length === 1 && popCalls(m)[0].url === '/api/popular?window=7d&token=' + MAIN, '换号:上个账号的缓存不复用,重新请求 /api/popular(带自己的 token)');
        ok(m.vm.popularList.map(x => x.name).join() === '三体,人世间,繁花,狂飙', '换号:显示自己的列表,不是 alice 的');
        ok((cached() || {}).t === MAIN.slice(0, 16), '缓存换成当前账号的');
    });
    await T(async () => {
        // 主动退出(clearAccountLocalData,与 Vue 共用同一份 localStorage)→ 缓存清掉;下一个人必定重新请求
        store.clear();
        const a = page(ALICE);
        await a.vm.fetchPopular();
        const r = mkAuth({ store });
        await r.g.clearAccountLocalData(ALICE);
        ok(noCache(), '主动退出:大家都在看缓存清掉');
        const m = page(MAIN);
        await m.vm.fetchPopular();
        ok(popCalls(m).length === 1 && m.vm.popularList[0].name === '三体', '退出后下一个人:重新请求,看到自己的列表');
    });
    await T(async () => {
        // 旧版不分账号的缓存(donggua_popular_cache2,或 cache3 里没有 t)一律不用
        store.clear();
        const old = { ts: Date.now(), list: ['繁花', '狂飙', '庆余年', '漫长的季节'].map(n => ({ title: n, name: n, poster_path: POSTER[n] })) };
        store.set('donggua_popular_cache2', JSON.stringify(old));
        const m = page(MAIN);
        await m.vm.fetchPopular();
        ok(popCalls(m).length === 1 && m.vm.popularList[0].name === '三体' && store.get('donggua_popular_cache2') === undefined, '旧版不分账号的缓存(cache2)作废并删掉');
        store.set('donggua_popular_cache3', JSON.stringify(old));
        const m2 = page(MAIN);
        await m2.vm.fetchPopular();
        ok(popCalls(m2).length === 1, '缓存里没有账号标记:不用');
        // 公开站(没 token):匿名缓存只给匿名用;登录后的账号不用它
        store.clear();
        lists[''] = ['繁花', '狂飙', '庆余年', '漫长的季节'];
        const p = page('');
        await p.vm.fetchPopular();
        ok(popCalls(p).length === 1 && popCalls(p)[0].url === '/api/popular?window=7d' && (cached() || {}).t === '', '公开站:不带 token,缓存标记为空串');
        const p2 = page('');
        await p2.vm.fetchPopular();
        ok(!popCalls(p2).length && p2.vm.popularList.length === 4, '公开站再打开:用匿名缓存');
        const p3 = page(MAIN);
        await p3.vm.fetchPopular();
        ok(popCalls(p3).length === 1 && p3.vm.popularList[0].name === '三体', '登录的账号不用匿名缓存');
        delete lists[''];
    });
    await T(async () => {
        // 401(服务器重启后 v2board token 还没重新登记)不缓存:不然空行挂 30 分钟;下次打开(已登记)照常
        store.clear();
        const u = page(LATE);
        await u.vm.fetchPopular();
        ok(popCalls(u).length === 1 && u.vm.popularList.length === 0 && noCache(), '401:这次不显示,也不写缓存');
        lists[LATE] = ['三体', '人世间', '繁花', '狂飙'];
        const u2 = page(LATE);
        await u2.vm.fetchPopular();
        ok(popCalls(u2).length === 1 && u2.vm.popularList.length === 4, '下次打开(token 已重新登记):重新请求,照常显示');
        delete lists[LATE];
        store.clear();
        const u3 = makeVm({ store, token: LATE });
        u3.net.handler = () => ({ status: 503, json: null });
        await u3.vm.fetchPopular();
        ok(noCache(), '5xx:也不写缓存');
    });
    delete globalThis.runWithConcurrency; delete globalThis.tmdbFetch;
}

console.log('④ W2 服务器重启后 v2board 同步靠本页补验证恢复(端到端:沙箱里真实 auth 脚本 + 真实历史同步/设置拉取/收藏方法)');
{
    const TOK = 'v2board_' + 'c'.repeat(64);
    const DAY = 864e5;
    const LOCAL_FAV = JSON.stringify([{ fav_id: 'L1', data: { name: 'L1', checkSource: { site_key: 's9', vod_id: '9' } }, added_at: 1, seen_count: 2, status: null }]);
    const FAV_CACHE = JSON.stringify({ t: TOK.slice(0, 16), items: [{ fav_id: '繁花', data: { name: '繁花', checkSource: { site_key: 's1', vod_id: '1' } }, added_at: 2, seen_count: 1, status: null }] });
    const LOCAL_HIST = JSON.stringify([{ name: '人世间', watchedAt: '2026-10-07T00:00:00.000Z', episode: '第5集' }]);
    // 假服务器:重启后内存里没有这个 v2board token(不落盘),只有 /api/auth/v2board/check 成功才重新登记
    const mkServer = (mode) => {
        const srv = { registered: false, mode, checks: 0, favs:JSON.parse(FAV_CACHE).items.map(x => Object.assign({}, x)), histPushed: [] };
        srv.fn = (url, body) => {
            let t = (body && typeof body.token === 'string') ? body.token : '';
            if (!t) { try { t = new URL('http://x' + url).searchParams.get('token') || ''; } catch (e) { } }
            const known = srv.registered && t === TOK;
            if (url === '/api/auth/check') return { status: 200, json: { requirePassword: true } };
            if (url === '/api/auth/v2board/check') {
                srv.checks++;
                if (srv.mode === 'unreachable') return { status: 200, json: { success: false, unreachable: true, message: 'connect ETIMEDOUT' } };
                srv.registered = true;
                return { status: 200, json: { success: true, userToken: TOK, plan: { name: 'P', expiresAt: Date.now() + 30 * DAY } } };
            }
            if (url.startsWith('/api/config?token=')) return { status: 200, json: { sync_enabled: known, push_enabled: false } };
            if (url.startsWith('/api/favorites?token=')) return known ? { status: 200, json: { enabled: true, limit: 100, items: srv.favs.slice() } } : { status: 401, json: { ok: false, error: 'Invalid token' } };
            if (url === '/api/favorites/add') {
                if (!known) return { status: 401, json: { ok: false, error: 'Invalid token' } };
                srv.favs.unshift({ fav_id: body.item.name, data: body.item, added_at: 3, seen_count: body.item.addedEpCount | 0, status: null });
                return { status: 200, json: { ok: true, fav_id: body.item.name } };
            }
            if (url.startsWith('/api/history/pull?token=')) return { status: 200, json: known ? { sync_enabled: true, history: [{ id: '狂飙', data: { name: '狂飙', watchedAt: '2026-10-06T00:00:00.000Z', episode: '第3集' } }], deleted: [] } : { sync_enabled: false, history: [] } };
            if (url === '/api/history/push') {
                if (!known) return { status: 200, json: { sync_enabled: false, saved: 0 } };
                srv.histPushed.push(...body.history.map(h => h.id));
                return { status: 200, json: { sync_enabled: true, saved: body.history.length, deleted: 0 } };
            }
            if (url.startsWith('/api/settings/pull?token=')) return { status: 200, json: known ? { sync_enabled: true, settings: { coverScale: 1.25 } } : { sync_enabled: false, settings: {} } };
            return { status: 200, json: {} };
        };
        return srv;
    };
    const seed = (ls, lastCheck) => {
        ls.setItem('emax_auth_hash', TOK); ls.setItem('emax_auth_type', 'v2board'); ls.setItem('emax_auth_expiry', String(Date.now() + 300 * DAY));
        ls.setItem('emax_v2board_token', 'v2tok'); ls.setItem('emax_v2board_email', 'a@x.com');
        ls.setItem('emax_v2board_last_check', String(lastCheck)); ls.setItem('emax_v2board_expires', String(Date.now() + 30 * DAY));
        ls.setItem('donggua_favorites', LOCAL_FAV); ls.setItem('donggua_fav_cache', FAV_CACHE);
        ls.setItem('donggua_watch_history', LOCAL_HIST); ls.setItem('donggua_push_on', TOK.slice(0, 16));
    };
    // 一次页面加载:真实 checkAuthStatus(沙箱)→ 进了 App 就跑真实 initHistorySync(同一份 localStorage、同一个假服务器)
    const pageLoad = async (srv, store, session) => {
        const r = mkAuth({ store, session, reply: (u) => srv.fn(u, null).json });
        await r.g.checkAuthStatus(); await flush();
        const x = makeVm({ store, booted: false, realSync: true });
        x.net.handler = srv.fn;
        x.vm.watchHistory = JSON.parse(x.ls.getItem('donggua_watch_history') || '[]');   // loadHistory 读本机历史
        globalThis.revalidateV2boardSession = r.g.revalidateV2boardSession;
        globalThis.v2boardAnsweredThisLoad = r.g.v2boardAnsweredThisLoad;
        if (r.ev.includes('startApp')) { await x.vm.initHistorySync(); await flush(12); }
        return Object.assign(x, { r });
    };
    const checksIn = (p) => p.r.fetches.filter(f => f.url === '/api/auth/v2board/check');
    const cfgN = (p) => p.calls.filter(c => c.fetchT && c.fetchT.startsWith('/api/config?token=')).length;
    const AUTH_KEYS = ['emax_auth_hash', 'emax_auth_type', 'emax_auth_expiry', 'emax_v2board_token', 'emax_v2board_email', 'emax_v2board_expires'];

    await T(async () => {
        // ① 面板正常:5 天内验证过(启动不验)→ 服务器重启后 sync_enabled:false → 补验证一次 → 重读配置 → 同步全部恢复
        const srv = mkServer('ok'), store = new Map(), LAST = Date.now() - DAY;
        const tmp = makeVm({ store }); seed(tmp.ls, LAST);
        const p = await pageLoad(srv, store);
        ok(p.r.ev.includes('startApp') && checksIn(p).length === 1 && srv.checks === 1, '启动不验证(5 天内验过);同步检查补验证正好一次');
        ok(checksIn(p)[0].body && checksIn(p)[0].body.v2boardToken === 'v2tok' && checksIn(p)[0].body.email === 'a@x.com', '补验证带本机的 v2board token + 邮箱(真实 revalidateV2boardSession)');
        ok(cfgN(p) === 2 && p.vm.syncEnabled === true && p.vm.syncToken === TOK, '重读配置:sync_enabled:true,进同步模式');
        ok(Number(p.ls.getItem('emax_v2board_last_check')) > LAST, '验证成功:更新上次验证时间');
        // 历史同步
        ok(p.calls.some(c => c.url === '/api/history/pull?token=' + TOK) && p.vm.watchHistory.map(h => h.name).sort().join() === '人世间,狂飙', '历史:拉服务器历史并与本机合并');
        ok(srv.histPushed.join() === '人世间' && JSON.parse(p.ls.getItem('donggua_hist_synced')).t === TOK.slice(0, 16), '历史:本机新的那部推上去,记下服务器已确认版本(按账号)');
        // 设置
        ok(p.calls.some(c => c.url === '/api/settings/pull?token=' + TOK) && p.vm.coverScale === 1.25 && p.ls.getItem('donggua_cover_scale') === '1.25', '设置:拉服务器偏好并应用');
        // 收藏
        ok(p.vm._favBooted && !p.vm._favDisplayOnly && p.calls.some(c => c.fetchT === '/api/favorites?token=' + encodeURIComponent(TOK)), '收藏:按同步模式启动,读服务器列表');
        const adds = p.calls.filter(c => c.url === '/api/favorites/add');
        ok(adds.length === 1 && adds[0].body.token === TOK && adds[0].body.item.name === 'L1' && p.ls.getItem('donggua_favorites') === null, '收藏:本机收藏一次性迁进账号');
        ok(p.vm.favList.map(x => x.fav_id).join() === 'L1,繁花' && JSON.parse(p.ls.getItem('donggua_fav_cache')).items.length === 2, '收藏:显示账号的完整列表并更新缓存');
        // 不循环:之后的重试 / 回首页都不再验证
        p.vm._favRetryAt = 0; p.vm._favRefreshMaybe(); p.vm._favRetryBoot(true); (p.winEv.online || []).forEach(f => f());
        await p.vm.initHistorySync(); await flush();
        ok(srv.checks === 1, '之后再走同步检查(已登记):不再验证');
    });

    await T(async () => {
        // ② 面板连不上:同样场景,补验证回 unreachable:true → App 照常(启动时已经进了),收藏只显示、不写本机,什么都不删,不循环
        const srv = mkServer('unreachable'), store = new Map(), LAST = Date.now() - DAY, session = new Map();
        const tmp = makeVm({ store }); seed(tmp.ls, LAST);
        const before = new Map(store);
        const p = await pageLoad(srv, store, session);
        ok(p.r.ev.includes('startApp') && srv.checks === 1 && cfgN(p) === 2, 'App 照常启动;补验证一次 → 再读一次配置');
        ok(!p.vm.syncEnabled && !p.vm._favBooted && p.vm._favDisplayOnly, '收藏:只显示态(同步与否没确认)');
        ok(p.vm.favList.map(x => x.fav_id).join() === '繁花', '只显示:这个账号上次缓存的服务器列表(不拿本机列表充数)');
        ok(!p.calls.some(c => /^\/api\/(history|settings)\//.test(c.url || '')), '没确认同步:历史/设置不拉不推');
        p.vm.currentGroup = { name: '新剧', sources: [{ site_key: 's2', vod_id: 2, vod_play_url: pu(3) }] };
        p.vm.currentSource = p.vm.currentGroup.sources[0];
        await p.vm.toggleFavorite();
        await p.vm.removeFavorite(p.vm.favList[0]);
        ok(p.toasts.filter(t => t === '网络异常，稍后再试').length === 2 && !p.calls.some(c => /^\/api\/favorites\/(add|remove|seen)/.test(c.url || '')), '♥ / 删除:提示网络异常,服务器不写');
        ok([...before].every(([k, v]) => store.get(k) === v), '本机什么都没删也没改:登录态/上次验证时间/本机收藏/收藏缓存/历史/推送开关原样');
        ok(!p.r.fetches.some(f => f.url === '/api/push/unsubscribe') && !p.calls.some(c => c.url === '/api/push/unsubscribe'), '推送不退订');
        // 不循环:online / 回首页的重试只重读配置,不再验证
        const c0 = cfgN(p);
        p.vm._favRetryAt = 0; p.vm._favRefreshMaybe(); await flush();
        (p.winEv.online || []).forEach(f => f()); await flush();
        p.vm._favRetryBoot(true); await flush();
        ok(srv.checks === 1 && cfgN(p) > c0 && p.vm._favDisplayOnly, '重试(回首页 / online)只重读配置,本页不再验证');
        // 下一次页面加载:再验证一次(每页一次,不是永远不验);这时面板恢复了 → 同步模式
        srv.mode = 'ok';
        const p2 = await pageLoad(srv, store, session);
        ok(srv.checks === 2 && p2.vm.syncEnabled && p2.vm._favBooted && p2.calls.some(c => c.url === '/api/history/pull?token=' + TOK), '下次打开页面:再补验证一次,面板恢复 → 同步模式');
    });

    await T(async () => {
        // ③ 启动时的 5 天验证本页已经问过(面板连不上 → K3 放行):同步检查不再问第二遍
        const srv = mkServer('unreachable'), store = new Map(), LAST = Date.now() - 6 * DAY;
        const tmp = makeVm({ store }); seed(tmp.ls, LAST);
        const p = await pageLoad(srv, store);
        ok(p.r.ev.includes('startApp') && p.r.notes.length === 1, '启动验证遇上面板连不上:照常进 + 提示一次');
        ok(srv.checks === 1 && checksIn(p).length === 1, '同一页只验证一次(启动验证问过,同步检查不再问)');
        ok(!p.vm.syncEnabled && p.vm._favDisplayOnly && p.ls.getItem('emax_auth_hash') === TOK && p.ls.getItem('donggua_favorites') === LOCAL_FAV && p.ls.getItem('emax_v2board_last_check') === String(LAST), '收藏只显示;登录态/本机收藏/上次验证时间都不动');
    });

    await T(async () => {
        // ④ 启动时的 5 天验证成功(已重新登记):同步检查直接是 sync_enabled:true,不再补验证
        const srv = mkServer('ok'), store = new Map();
        const tmp = makeVm({ store }); seed(tmp.ls, Date.now() - 6 * DAY);
        const p = await pageLoad(srv, store);
        ok(srv.checks === 1 && cfgN(p) === 1 && p.vm.syncEnabled && p.vm._favBooted, '启动验证已登记:配置读一次就是同步模式,不重复验证');
    });

    await T(async () => {
        // ⑤ 补验证的请求本身失败(断网/超时 → fail-open):只显示,什么都不删;本页之后也不再验证
        const srv = mkServer('ok'), store = new Map(), LAST = Date.now() - DAY;
        const tmp = makeVm({ store }); seed(tmp.ls, LAST);
        const before = new Map(store);
        const r = mkAuth({ store, reply: (u) => srv.fn(u, null).json });
        await r.g.checkAuthStatus(); await flush();
        const x = makeVm({ store, booted: false, realSync: true });
        x.net.handler = srv.fn;
        const r2 = mkAuth({ store, reply: (u) => srv.fn(u, null).json, throwFor: (u) => u === '/api/auth/v2board/check' });
        globalThis.revalidateV2boardSession = r2.g.revalidateV2boardSession;
        globalThis.v2boardAnsweredThisLoad = r2.g.v2boardAnsweredThisLoad;
        await x.vm.initHistorySync(); await flush(12);
        ok(r2.fetches.filter(f => f.url === '/api/auth/v2board/check').length === 1 && !x.vm.syncEnabled && x.vm._favDisplayOnly, '验证请求失败:只显示');
        ok([...before].every(([k, v]) => store.get(k) === v), '验证请求失败:本机什么都不删不改');
        x.vm._favRetryBoot(true); await flush();
        ok(r2.fetches.filter(f => f.url === '/api/auth/v2board/check').length === 1, '之后的重试不再验证');
    });

    await T(async () => {
        // ⑥ 点「求片有结果了」推送进来(?requests=1):求片弹窗、大家都在看都比补验证先发请求 → 先吃 401;
        //    以前列表被清成「还没有求片记录」、大家都在看整页不显示(第三轮审查实锤)。现在 401 不清空,登记确认后自动重拉
        const srv = mkServer('ok'), store = new Map();
        const tmp = makeVm({ store }); seed(tmp.ls, Date.now() - DAY);
        const r = mkAuth({ store, reply: (u) => srv.fn(u, null).json });
        await r.g.checkAuthStatus(); await flush();
        const x = makeVm({ store, booted: false, realSync: true });
        x.net.handler = (url, body) => {
            if (url.startsWith('/api/requests/mine')) return srv.registered ? { status: 200, json: { requests: [{ id: 1, name: '求的片', status: 'fulfilled' }] } } : { status: 401, json: { error: 'Invalid token' } };
            if (url.startsWith('/api/popular')) return srv.registered ? { status: 200, json: { window: '7d', items: [1, 2, 3, 4, 5].map(i => ({ title: '热剧' + i, kind: 'vod' })) } } : { status: 401, json: { ok: false, error: 'auth' } };
            return srv.fn(url, body);
        };
        for (const n of ['loadMyRequests', 'openRequestModal', 'fetchPopular']) x.vm[n] = mk(n).bind(x.vm);
        x.vm._popularPosters = async (l) => l.map(i => Object.assign({}, i, { name: i.title, poster_path: '/p.jpg' }));
        Object.assign(x.vm, { requestsEnabled: true, showRequestModal: false, myRequests: [{ id: 0, name: '旧的' }], reqForm: {}, popularList: [], _popLoaded: false });
        globalThis.revalidateV2boardSession = r.g.revalidateV2boardSession;
        globalThis.v2boardAnsweredThisLoad = r.g.v2boardAnsweredThisLoad;
        x.vm.syncToken = TOK;
        x.vm.openRequestModal('');   // 深链比同步检查先到
        await x.vm.fetchPopular(); await flush();
        ok(x.vm.showRequestModal && x.vm.myRequests.map(q => q.name).join() === '旧的', '求片 401:列表不被清空');
        ok(x.vm.popularList.length === 0 && x.vm._popAuthFailed === true && x.ls.getItem('donggua_popular_cache3') === null, '大家都在看 401:不显示、不缓存、记下待重拉');
        await x.vm.initHistorySync(); await flush(12);
        ok(x.vm.syncEnabled && x.vm.myRequests.map(q => q.name).join() === '求的片', '补验证登记后:求片列表自动重拉,显示真实记录');
        ok(x.vm.popularList.length === 5 && x.vm._popAuthFailed === false, '补验证登记后:大家都在看自动重拉');
    });
    delete globalThis.revalidateV2boardSession; delete globalThis.v2boardAnsweredThisLoad;
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
