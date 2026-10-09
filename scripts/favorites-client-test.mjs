// 收藏 / 推送 前端逻辑回归:node scripts/favorites-client-test.mjs
//  ① 从 public/index.html 抽出收藏相关方法(假 localStorage/fetch):fav_id 口径、角标文字、集数口径、条目瘦身(检查线路不用 kz)、
//     本机列表增删/上限 100、服务器状态合并(基线、原型键)、按检查线路认同名拆卡、seen 清红点(取较大集数)、同步/本机两条加载路径、♥ 满额提示
//  ② 推送辅助:base64url → 字节、公钥比对
//  ③ public/sw.js:v39、收藏/推送接口不缓存、push 弹通知(tag→renotify、坏 JSON 兜底)、notificationclick(切到已开窗口并跳转 / 开新窗口 / 外站地址回首页)、
//     pushsubscriptionchange(用旧选项重新订阅 + 通知页面补报)
//  ④ 审查修复回归(C1–C7):方法名冲突、同步未确认时 ♥ 不写、online/回首页重试、本机收藏迁移、v2board 重新登记、启动补报/退掉推送、
//     番剧线路收藏提示、深链作废、大家都在看只上 TMDB 认得的片
//     第二轮(K1–K3):本机收藏查更新带登录 token(假服务器按私密站契约没 token 回 401)、被动登出只清登录态(收藏/推送留着,
//     只有主动退出全量清,换号登录靠推送归属检查 + 收藏缓存按账号认)、v2board 面板连不上(unreachable)时放行不登出
//     第三轮(W1–W2):大家都在看缓存按账号认(换号不复用上个账号扣掉了自己那一票的列表,主动退出清掉,401 等失败回包不缓存)、
//     服务器不再落盘 v2board token 后,重启靠"sync_enabled:false → 本页补验证一次 → 重读配置"恢复:端到端(沙箱里真实 auth 脚本 +
//     真实的历史同步/设置拉取/收藏方法)验证恢复成同步模式;面板连不上照常进、收藏只显示、什么都不删;每页最多验证一次(启动验证问过就不再问)
//  ⑤ 追更日历:<dg-fav-sched-core> 纯函数(相对日期文字/更新规律文字/卡片一行的拼法与缩短/7 天分桶/TMDB 认片(TMDB 顺序、季号、b)/
//     下一集是不是收藏的那一季(nextFits)/缓存与查询计划)+ 真实 Vue 方法 _favSchedRun 对假 TMDB:只走 tmdbFetch → /api/tmdb-proxy、并发 ≤3、
//     额度 30 部每 6 小时补满、用完后新收藏的每轮补查 3 部、同名多部在播的优先、缓存命中不发请求、失败不写缓存、详情页/搜索时不查、
//     收藏清空/主动退出清掉片名表;模板/样式接线
//     第二轮审查回归:北京日历(TMDB 国产剧日期 / 规律星期几 + cadence.clock)换成本地日历(美西周五晚北京周六 10:00 的 = 今天;国内不变;
//     外国剧不换)、TMDB 下一集停在北京昨天 → 查这季集表换成 ≥ 今天的(集表失败照存,过去的日期 1 小时后重查)、
//     季终(集数 = 总集数)的不带季号收藏不认下一季的累计集号
//     第三轮(S5):cadence.clock 是相对"更新日"的,更新日可能是 TMDB 日期的前一天 → airLocal 按规律的星期几换算、夹在 TMDB 那天里
//     (周四 00:00 的剧美西/欧洲不再晚一天);clock 可到 30:00 → localCad 夹在更新日里(国内不被挪到第二天)
//     第四轮:alignAir 按规律的星期几认 TMDB 日期对应哪个更新日(日更深夜剧 clock ≥ 24:00 不再减一天、被标到第二天的晚间剧挪回来,T4)、
//     规律先对齐到官方日历再排本周更新条(周日 00:00 的剧不再排"周六",T7)、不带季号认第 2 季以后的要站上最近涨过集(T5)、
//     下一集停在昨天按集查(/season/{s}/episode/{e+k},不拉整季集表,T6);推送:静默订阅不占开关 + 有时限(T8)、
//     订阅途中不做归属检查(T11)、旧版关掉过的一次性迁移(T9)、离线缓存面板不算盖住小卡片(T10)
//  ⑥ 推送默认打开(假 Notification / PushManager / history / 时钟):浏览器已允许通知 → 启动静默订阅(走开关同一条流程,绝不要权限);
//     偏好设置里亲手关过 / 非同步 / 已拒绝 / 没问过 / 安卓 App / 服务器关了推送 → 不订;自动订失败一天内不再试;换号登录给新账号订新的。
//     「开启更新提醒？」小卡片:本页第一次 ♥ / 求片提交成功后、等 toast 和弹窗都没了才弹;以后再说 = 14 天、每账号最多 3 次;
//     浏览器回答"拒绝" → 卡片上留原提示一次、以后不再问;「开启」在点击的同一调用栈里要权限且整条订阅流程只走一次;
//     iOS 没装到主屏幕 / 非同步 / 安卓 App / 已允许 / 番剧线路 不弹;Esc / TV 返回键 / 手机返回键(历史)关;截帧弹窗叠在上面时返回只关弹窗
//     第三轮(P1–P3,假 history 按浏览器规矩做滚动恢复):关卡片退历史时页面不滚回卡片弹出时的位置(压之前改 manual、退回后改回 auto);
//     卡片被别的弹窗盖着时返回键关那个弹窗、卡片留着并压回它那条;偏好设置里开开关被拒/权限框被关 → 藏着的卡片也收掉
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

// 📅 追更日历纯函数核心(按标记整段抽出来)+ 页面里的并发池(_favSchedRun 用它)
const schedM = /\/\/ <dg-fav-sched-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-fav-sched-core>/.exec(HTML);
const S = schedM ? new Function(schedM[1] + '\n;return DgFavSched;')() : null;
const poolM = /\n {8}(async function runWithConcurrency\(items, limit, worker\) \{[\s\S]*?\n {8}\})\n/.exec(HTML);
const runWithConcurrency = poolM ? new Function('return (' + poolM[1] + ');')() : null;
const SCHED_METHODS = ['_favSchedKick', '_favDayTick', '_favSchedRun'];

const FAV_METHODS = ['_favIdOf', '_favWorkSig', '_favIsSync', '_favFind', 'favHasUpdate', 'favBadgeText', 'favSubText', '_favEpCountOf', '_favBuildItem',
    '_favLocalAdd', '_favMergeStatus', '_favLocalLoad', '_favLocalSave', '_favCacheLoad', '_favCacheSave', '_favBoot', 'loadFavorites', '_favLocalStatus',
    'toggleFavorite', 'removeFavorite', '_favOnPlay', '_favMarkSeen', '_b64uToU8', '_pushSameKey', '_pushErrText',
    'onFavPopRowScroll', '_favRetryBoot', '_favMigrateLocal', '_favRefreshMaybe', 'initHistorySync', '_syncConfigFetch',
    '_pushSupport', '_swReady', '_pushPost', '_pushKey', '_pushOwnerTag', '_pushOwnedByMe', '_pushStartupSync', '_pushRefreshState', 'pushSubscribe',
    'fetchPopular', '_popularPosters', 'confirmLogout', 'refreshV2boardInfo',
    // 🔔 推送默认打开 + 软提示
    '_pushAcct', '_pushOffList', '_pushOptedOut', '_pushSetOptOut', '_pushMigrate', '_pushAskLoad', '_pushAskSave', '_pushAskAcct', '_pushAutoOn', '_pushAskEligible',
    '_pushAskCoveredNow', '_pushAskBlocked', '_pushAskQueue', '_pushAskShow', '_pushAskFocusBtn', '_pushAskArm', '_pushAskKey', 'pushAskEnable', 'pushAskLater',
    'closePushAsk', 'pushUnsubscribe', '_pushUnsubscribeAll', 'togglePush', 'submitRequest', 'loadMyRequests', '_onHistPop', '_pushAskScrollBack', '_histBoot'];

// 历史同步 / 设置拉取的真实方法(opts.realSync:端到端用例里不用桩)
const SYNC_METHODS = ['syncHistory', 'pullAndMergeHistory', '_doPushHistory', '_histPending', '_histSyncLoad', '_histSyncSave', '_slimHistoryItem',
    '_loadTombstones', '_saveTombstones', '_isTombstoned', 'pullUserSettings'];

// opts.store:与沙箱里的 auth 脚本(mkAuth)共用同一份 localStorage
function makeVm(opts) {
    opts = opts || {};
    const store = opts.store || new Map();
    // 第四轮 T9:推送的一次性迁移(donggua_push_mig)默认当作已经做过 —— 别的用例模拟的是升级之后的设备;opts.noMig 测迁移本身
    if (!opts.noMig && !store.has('donggua_push_mig')) store.set('donggua_push_mig', '1');
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
        pushAsk: { show: false, kind: '', msg: '' }, isTVMode: false, frameShare: { show: false }, showRequestModal: false, showSettingsModal: false,
        showInfoModal: false, showSharePanel: false, showOfflinePanel: false, userBanned: false, previewLocked: false,
        _favBooted: opts.booted !== false,
        showMiniToast: m => toasts.push(m),
        $refs: {}, $nextTick: f => f && f(),
        syncHistory: async () => { vmObj._synced = (vmObj._synced || 0) + 1; }, pullUserSettings: async () => { },
        _isKzSource: s => !!(s && (s._kz || /^kz_/.test(s.site_key || ''))),
        posterKey: gg => (gg && gg.name || '') + (gg && gg._workLabel && gg._workSig ? '|' + gg._workSig : ''),
        // 📅 追更日历:默认只数 kick 次数(别的用例不碰 TMDB);opts.sched 时换成真实方法
        favAir: Object.freeze(Object.create(null)), favToday: '2026-10-08', showDetail: false, searched: false,
        _favSchedKick: () => { vmObj._kicks = (vmObj._kicks || 0) + 1; },
    };
    if (opts.sched) {
        g.runWithConcurrency = runWithConcurrency; g.DgFavSched = S;   // 大家都在看的用例跑完会删掉全局的并发池
        for (const n of SCHED_METHODS) vmObj[n] = mk(n).bind(vmObj);
    }
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
    ok(/const CACHE_VERSION = 'v39'/.test(src), 'CACHE_VERSION v39');
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
        // 和真浏览器一样:退订后 getSubscription() 拿到 null;subscribe() 给一条新 endpoint(已允许通知时"默认打开"会用到)
        const mk = (ep) => { const s = { endpoint: ep, options: {}, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, unsubscribe: async () => { ev.push('unsub'); if (cur === s) cur = null; return true; } }; return s; };
        let cur = o.noSub ? null : mk('https://fcm.googleapis.com/fcm/send/abc');
        const sub = cur;
        const reg = { pushManager: { getSubscription: async () => cur, subscribe: async () => { ev.push('sub'); cur = mk('https://fcm.googleapis.com/fcm/send/new'); return cur; } } };
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
        // (这个账号在偏好设置里关过推送 → 不会"默认打开",单看归属检查)
        const { ev } = env();
        const { vm, ls, calls } = mkPush({ sync: true });
        ls.setItem('donggua_push_on', 'someone_else_tok');
        vm._pushSetOptOut(true);
        await vm._pushStartupSync(true);
        ok(ev.join() === 'unsub' && !calls.some(c => c.url === '/api/push/subscribe') && !vm.pushSubscribed, '上个账号开的订阅:退掉,不悄悄过户');
        ok(ls.getItem('donggua_push_on') === null, '上个账号开的订阅退掉后,它的账号标记也清掉');
    }
    {
        // 浏览器早已允许通知、这个账号没关过:退掉上个账号的,再给这个账号订一条新的(默认打开);旧 endpoint 绝不报成这个账号的
        const { ev } = env();
        const { vm, ls, calls } = mkPush({ sync: true });
        ls.setItem('donggua_push_on', 'someone_else_tok');
        await vm._pushStartupSync(true);
        const posts = calls.filter(c => c.url === '/api/push/subscribe');
        ok(ev.join() === 'unsub,sub' && posts.length === 1 && posts[0].body.subscription.endpoint === 'https://fcm.googleapis.com/fcm/send/new' && posts[0].body.token === vm.syncToken
            && vm.pushSubscribed && ls.getItem('donggua_push_on') === vm.syncToken.slice(0, 16), '上个账号开的订阅退掉后:给现在的账号订新的(旧 endpoint 不过户)');
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
    // 没订阅 + 还没问过权限 / 没授权:什么也不做(已授权没订阅的"默认打开"见 ⑥)
    {
        env({ noSub: true, perm: 'default' });
        const { vm, calls } = mkPush({ sync: true });
        await vm._pushStartupSync(true);
        ok(!calls.some(c => /\/api\/push\//.test(c.url || '')), '没有订阅、没问过权限:不发任何请求(启动时绝不要权限)');
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
    ls.setItem('donggua_fav_tmdb', JSON.stringify({ ids: { '剧A': { id: 1, ts: Date.now() } }, tv: {} }));
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
        ok(r.ls.getItem('donggua_fav_tmdb') === null, '主动退出:清追更日历缓存(键是收藏的片名,第一轮审查回归)');
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
        const mkSub = (ep) => { const s = { endpoint: ep, options: {}, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, unsubscribe: async () => { ev.push('unsub'); if (sub === s) sub = null; return true; } }; return s; };
        let sub = mkSub('https://fcm.googleapis.com/fcm/send/abc');
        // 浏览器已允许通知:退掉上个账号的订阅后,"默认打开"会给现在的账号订一条新的(新 endpoint)
        const reg = { pushManager: { getSubscription: async () => sub, subscribe: async () => { ev.push('sub'); sub = mkSub('https://fcm.googleapis.com/fcm/send/new'); return sub; } } };
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
        const posts = b.calls.filter(c => c.url === '/api/push/subscribe');
        ok(b.ev[0] === 'unsub' && !posts.some(c => c.body.subscription.endpoint === 'https://fcm.googleapis.com/fcm/send/abc'),
            '换号登录:上个账号的推送订阅被归属检查退掉(它的 endpoint 不过户给新账号)');
        ok(b.ev.join() === 'unsub,sub' && posts.length === 1 && posts[0].body.token === B && posts[0].body.subscription.endpoint === 'https://fcm.googleapis.com/fcm/send/new'
            && b.vm.pushSubscribed && b.ls.getItem('donggua_push_on') === B.slice(0, 16),
            '换号登录 + 浏览器早已允许通知:默认打开 → 给新账号自己订一条新的,账号标记换成新账号');
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

// ---------- ⑤ 追更日历 ----------
const DAYMS = 86400000;
const ds = n => new Date(n * DAYMS).toISOString().slice(0, 10);          // 日序号 → 'YYYY-MM-DD'
const plus = (d, k) => ds(S.dayNum(d) + k);
// 收藏条目(与服务器 /api/favorites 的 items 同形状)
const fav = (name, o) => {
    o = o || {};
    return {
        fav_id: o.id || name, added_at: o.added || 1, seen_count: o.seen || 0,
        data: { name, checkSource: o.kz ? null : { site_key: 's1', vod_id: String(o.vid || name.length) }, workSig: o.sig || '', workLabel: o.sig ? 'x' : '', addedEpCount: o.added_ep || 0, kind: 'vod' },
        status: o.st === null ? null : Object.assign({ ep_count: 10, latest_ep: '第10集', remarks: '', finished: false }, o.st || {})
    };
};

console.log('⑤ 追更日历:纯函数');
await T(async () => {
    ok(!!S, 'index.html 里有 <dg-fav-sched-core> 段');
    ok(!!runWithConcurrency, '抽得到 runWithConcurrency');
    const TD = '2026-10-08';   // 周四
    // 日期基础
    ok(S.localDay(new Date(2026, 9, 8, 23, 59, 59)) === TD && S.localDay(new Date(2026, 0, 5, 0, 0, 1)) === '2026-01-05', '本地日历的今天(本地时区,补零)');
    ok(isNaN(S.dayNum('2026-02-30')) && isNaN(S.dayNum('2026-13-01')) && isNaN(S.dayNum('26-10-08')) && isNaN(S.dayNum(null)) && isNaN(S.dayNum('2026-10-08T00:00')) && S.dayNum(TD) === 20734, '日期解析:不合法的(2月30日/13月/带时间)都是 NaN');
    let wdOk = true;
    for (let n = 20000; n < 21000; n++) if (S.isoWd(n) !== (new Date(n * DAYMS).getUTCDay() || 7)) wdOk = false;
    ok(wdOk && S.isoWd(S.dayNum(TD)) === 4 && S.isoWd(-1) === 3, 'ISO 星期几与 Date 逐日一致(1000 天);1969-12-31 是周三');
    // 相对日期
    const R = a => S.relDayLabel(a, TD);
    ok(R(TD) === '今天更新' && R('2026-10-09') === '明天更新' && R('2026-10-10') === '周六更新' && R('2026-10-12') === '周一更新' && R('2026-10-14') === '周三更新', '今天/明天/一周内写星期几');
    ok(R('2026-10-15') === '10月15日更新' && R('2026-11-03') === '11月3日更新' && R('2027-01-05') === '2027年1月5日更新', '7 天及以后写日期(跨年带年份,不补零)');
    ok(R('2026-10-07') === '' && R('2025-10-09') === '' && R('') === '' && R('2026-10-32') === '' && S.relDayLabel('2026-10-09', 'x') === '', '过去的/不合法的日期 → 空');
    ok(S.relDayLabel('2026-11-01', '2026-10-31') === '明天更新' && S.relDayLabel('2027-01-01', '2026-12-31') === '明天更新' && S.relDayLabel('2026-03-30', '2026-03-28') === '周一更新'
        && S.relDayLabel('2026-11-02', '2026-10-31') === '周一更新', '跨月/跨年/夏令时那周不差一天');
    // 规律文字
    const C = c => S.cadenceLabels(c);
    ok(C({ daily: true, days: [1, 2, 3, 4, 5, 6, 7] }).join() === '每天更新' && C({ daily: true, days: [] }).join() === '每天更新' && C({ daily: true }).join() === '每天更新', '日更 → 每天更新');
    ok(C({ daily: false, days: [3, 4] }).join('|') === '通常每周三、四更新|每周三、四更新|周三、四更新', '每周三、四:完整/短/更短三档');
    ok(C({ daily: true, days: [1, 2, 3, 4, 5] })[0] === '通常每周一至五更新' && C({ daily: false, days: [1, 2, 3, 5] })[0] === '通常每周一至三、五更新'
        && C({ daily: false, days: [6, 7] })[0] === '通常每周六、日更新' && C({ daily: false, days: [5] })[0] === '通常每周五更新', '连着 3 天以上写"至";周末/单日');
    ok(C({ daily: false, days: [4, 3, 3, '5', 0, 8, 2.5] })[0] === '通常每周三、四更新' && C({ daily: false, days: [1, 2, 3, 4, 5, 6, 7] }).join() === '每天更新', '乱序/重复/非法值清掉;7 天都有 = 每天');
    ok(!C(null).length && !C('x').length && !C({ days: 'x' }).length && !C({ daily: false, days: [] }).length && !C({ daily: 'yes', days: [0, 9] }).length, '没有/不认识的规律 → 没有文字');
    // 卡片那一行
    const L = o => S.composeLine(Object.assign({ today: TD }, o));
    ok(L({ ep: 17, total: 30, air: '2026-10-09' }) === '17/30 · 明天更新' && L({ ep: 17, total: 30, air: '2026-10-16' }) === '17/30 · 10月16日更新', 'TMDB 日期 + 集数进度拼一行');
    ok(L({ air: '2026-10-10' }) === '周六更新' && L({ air: '2026-10-10', cad: { daily: true } }) === '周六更新', 'TMDB 日期优先于规律');
    ok(L({ cad: { daily: false, days: [3, 4] } }) === '通常每周三、四更新' && L({ cad: { daily: true } }) === '每天更新', '只有规律');
    ok(L({ ep: 17, total: 30, cad: { daily: false, days: [3, 4] } }) === '17/30 · 每周三、四更新', '集数 + 规律:完整版放不下 → 去掉"通常"');
    ok(L({ ep: 17, total: 30, cad: { daily: false, days: [3, 4] }, max: 20 }) === '17/30 · 通常每周三、四更新', '宽度够就用完整版');
    ok(L({ ep: 17, total: 30, cad: { daily: false, days: [1, 3, 5, 6] } }) === '周一、三、五、六更新', '实在太长:只留更新日');
    ok(L({ ep: 17, total: 30 }) === '更新至 17/30 集' && L({ ep: 120, total: 1000 }) === '更新至 120/1000 集', '只有进度:更新至 17/30 集');
    ok(L({ ep: 17, total: 0 }) === '' && L({ ep: 31, total: 30 }) === '' && L({ ep: 0, total: 30 }) === '' && L({}) === '', '总集数不知道/比集数少/没有集数:没有进度');
    ok(L({ ep: 17, total: 30, air: '2026-10-07', cad: { daily: false, days: [5] } }) === '17/30 · 通常每周五更新' && L({ air: '2026-10-01' }) === '' && L({ ep: 5, total: 9, air: '2026-10-07' }) === '更新至 5/9 集', '过去的 TMDB 日期不算(退回规律/进度)');
    let wOk = true;
    for (const days of [[1], [2, 4], [1, 2, 3, 4, 5], [1, 3, 5], [2, 4, 6], [1, 2, 3, 5, 6]]) for (const p of [[0, 0], [9, 24], [99, 100], [999, 1000]]) {
        const s = L({ ep: p[0], total: p[1], cad: { daily: false, days } });
        if (!s || /\n/.test(s) || (S.textW(s) > 12 && s !== C({ daily: false, days })[2])) wOk = false;
    }
    ok(wOk && S.textW('17/30 · 周五更新') < 9 && S.textW('通常每周三、四更新') === 9, '各种组合:不超宽度预算(超了的只会是最短的更新日)');
    // 哪些收藏算"在连载"
    const E = (o) => S.eligible(fav('剧', o));
    ok(E({}) && E({ st: null, added_ep: 12 }) && E({ st: { ep_count: 1, total: 30 } }), '剧集:集数 ≥2,或总集数 ≥2,或收藏时就 ≥2 集(状态还没查到)');
    ok(!E({ kz: true }) && !E({ st: { finished: true } }) && !E({ sig: 'y2025m' }) && !E({ sig: 'y0m' }) && E({ sig: 'y2023s' })
        && !E({ st: { ep_count: 1 } }) && !E({ st: null }) && !S.eligible(null) && !S.eligible({ fav_id: 'x' }), '番剧线路/完结/电影样(签名 m、只有 1 集)/没数据:不算');
    // 搜索参数
    const Q = (n, sig) => S.queryOf(fav(n, { sig }));
    ok(JSON.stringify(Q('庆余年第二季', 'y2024s')) === '{"name":"庆余年第二季","q":"庆余年","year":0}' && JSON.stringify(Q('遮天', 'y2023se7')) === '{"name":"遮天","q":"遮天","year":2023}'
        && Q('魅影神捕').year === 0 && Q('某剧 Season 2').q === '某剧' && Q('某剧 4K').q === '某剧', '去季号/清晰度;年份只取同名拆卡签名,带季号时不带年份');
    // TMDB 认片
    const P = (rs, n, o) => S.pickMatch(rs, Object.assign(S.queryOf(fav(n, o)), (o && o.q) || {}), TD);
    ok(P([{ id: 1, name: '魅影神捕前传' }, { id: 2, name: '魅影神捕' }], '魅影神捕') === 2, '只认完全同名(前传不算)');
    ok(P([{ id: 3, name: '名侦探柯南 零的执行人' }], '名侦探柯南：零的执行人') === 3 && P([{ id: 4, name: 'The Bad Guys' }], 'the bad guys') === 4, '比较时去标点/空白、不分大小写');
    ok(P([{ id: 5, name: '无可替代的你', original_name: '无可替代' }], '无可替代') === 5 && P([{ id: 6, name: '无可替代的你', original_name: '无可替代的你' }], '无可替代') === 0, '原名同名也认;都不同名 → 0(宁缺毋滥)');
    ok(P([{ id: 7, name: '魅影神捕', adult: true }, { id: '8', name: '魅影神捕' }, null, { id: -1, name: '魅影神捕' }], '魅影神捕') === 0 && P(null, '魅影神捕') === 0 && P({ results: 1 }, 'x') === 0, '成人/坏 id/坏结果不认');
    ok(P([{ id: 9, name: '庆余年' }], '庆余年第二季') === 9 && P([{ id: 9, name: '庆余年' }, { id: 10, name: '庆余年第二季' }], '庆余年第二季') === 10, '带季号:先认完整片名,没有再认去掉季号的');
    const zt = [{ id: 11, name: '遮天', first_air_date: '2025-01-01' }, { id: 12, name: '遮天', first_air_date: '2023-05-03' }];
    ok(P(zt, '遮天', { sig: 'y2023s' }) === 12 && P(zt, '遮天', { sig: 'y2024s' }) === 11 && P(zt, '遮天', { sig: 'y2020s' }) === 0 && P([{ id: 13, name: '遮天' }], '遮天', { sig: 'y2023s' }) === 0, '知道年份:首播年最近且差 ≤1 的;差太多或没首播日 → 不认');
    // 不知道年份、同名多部:按 TMDB 原顺序(相关度)取第一部 —— 以前取"最近开播的",在播动画全被同名的完结翻拍剧顶掉(审查实锤)
    ok(P([{ id: 21, name: '某剧', first_air_date: '2009-01-01' }, { id: 22, name: '某剧', first_air_date: '2026-09-30' }, { id: 23, name: '某剧', first_air_date: '2027-05-01' }], '某剧') === 21
        && P([{ id: 31, name: '某剧' }, { id: 32, name: '某剧', first_air_date: '2010-01-01' }], '某剧') === 32
        && P([{ id: 41, name: '某剧', first_air_date: '2020-01-01' }, { id: 42, name: '某剧', first_air_date: '2020-01-01' }], '某剧') === 41
        && P([{ id: 51, name: '某剧', first_air_date: '2027-01-01' }, { id: 52, name: '某剧', first_air_date: '2028-01-01' }], '某剧') === 51, '不知道年份、同名多部:TMDB 顺序第一个(还没开播/没首播日的排除,都没开播才用)');
    // 真实数据(/api/tmdb-proxy /search/tv,2026-10-08):TMDB 把在播的排第一,同名完结的翻拍排后面
    const REAL = [['凡人修仙传', 106449, '2020-07-25', 243224, '2025-07-27'], ['武神主宰', 110181, '2020-08-18', 228707, '2023-04-01'], ['万界独尊', 122612, '2021-06-03', 247201, '2024-01-10'], ['遮天', 224839, '2023-05-03', 278875, '2025-02-01']];
    ok(REAL.every(([n, a, ad, b, bd]) => P([{ id: a, name: n, first_air_date: ad }, { id: b, name: n, first_air_date: bd }], n) === a), '没年份:凡人修仙传/武神主宰/万界独尊/遮天 认 TMDB 排第一的在播那部(不认更新的完结翻拍)');
    const ML = S.matchList([{ id: 61, name: '某剧' }, { id: 62, name: '某剧', first_air_date: '2020-01-01' }, { id: 63, name: '某剧', first_air_date: '2015-01-01' }, { id: 64, name: '某剧外传', first_air_date: '2016-01-01' }], S.queryOf(fav('某剧')), TD);
    ok(ML.ids.join() === '62,63' && ML.b === false, 'matchList:同名候选按 TMDB 顺序(给"在播的优先"挑),全名认的 b=false', ML);
    const MB = S.matchList([{ id: 71, name: '大王饶命', first_air_date: '2021-01-30' }], S.queryOf(fav('大王饶命3')), TD);
    ok(MB.ids.join() === '71' && MB.b === true && S.matchList([{ id: 72, name: '庆余年第二季' }], S.queryOf(fav('庆余年第二季')), TD).b === false, 'matchList:去掉季号才认出来的 b=true(下一集要对季号),全名认出的 b=false');
    // 季号
    const SO = n => S.seasonOf(n);
    ok(SO('庆余年第二季') === 2 && SO('披荆斩棘第四季') === 4 && SO('某剧第十二季') === 12 && SO('某剧第二十季') === 20 && SO('某剧第3部') === 3 && SO('Some Show Season 5') === 5
        && SO('大王饶命3') === 3 && SO('庆余年2') === 2 && SO('大王饶命') === 0 && SO('1917') === 0 && SO('爱情公寓5 ') === 5 && SO('') === 0, 'seasonOf:第N季/第N部/Season N/末尾"汉字+单个数字";没有 → 0');
    ok(S.queryOf(fav('大王饶命3', { sig: 'y2026s' })).q === '大王饶命' && S.queryOf(fav('大王饶命3', { sig: 'y2026s' })).year === 0, '末尾数字季号:按去掉数字的片名搜、不带年份(以前搜"大王饶命3"认不出)');
    // /tv/{id}
    const TV = o => JSON.stringify(S.tvNext(o));
    ok(TV({ next_episode_to_air: { air_date: '2026-10-09', episode_number: 18, season_number: 1 }, status: 'Returning Series', seasons: [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 30 }] }) === '{"d":"2026-10-09","e":18,"s":1,"c":18,"l":1,"bj":1}'
        && TV({ next_episode_to_air: null, status: 'Ended' }) === '{"d":"","e":0,"s":0,"c":0,"l":0,"bj":1}' && TV(null) === '{"d":"","e":0,"s":0,"c":0,"l":0,"bj":1}'
        && TV({ next_episode_to_air: null, status: 'Returning Series' }) === '{"d":"","e":0,"s":0,"c":0,"l":1,"bj":1}'
        && TV({ next_episode_to_air: { air_date: '2026-10-9', episode_number: '3', season_number: '2' } }) === '{"d":"","e":0,"s":0,"c":0,"l":1,"bj":1}', '下一集:日期/集号/季号校验;在播 = 有下一集或 Returning/In Production');
    ok(TV({ next_episode_to_air: { air_date: '2026-10-10', episode_number: 4, season_number: 3 }, seasons: [{ season_number: 0, episode_count: 5 }, { season_number: 1, episode_count: 12 }, { season_number: 2, episode_count: 12 }, { season_number: 3, episode_count: 13 }] }) === '{"d":"2026-10-10","e":4,"s":3,"c":28,"l":1,"bj":1}', '累计集号 = 前几季集数 + 本季集号(特别篇第 0 季不算)');
    // 缓存
    const c0 = S.cacheParse('{"ids":{"__proto__":{"id":5,"ts":1},"A":{"id":"7","ts":1},"B":{"id":0,"ts":2},"C":{"id":3},"D":{"id":8,"ts":1,"b":1}},"tv":{"5":{"d":"2026-10-09","e":2,"s":3,"c":28,"l":1,"ts":3},"x":{"d":"","ts":1},"6":{"d":"bad","e":-1,"s":"x","c":-2,"ts":4}}}');
    ok(Object.keys(c0.ids).join() === '__proto__,B,D' && c0.ids['__proto__'].id === 5 && ({}).id === undefined && Object.getPrototypeOf(c0.ids) === null && c0.ids.D.b === 1 && !c0.ids.B.b, '缓存读回:片名当键无原型(__proto__ 片名不污染)、坏条目丢掉、b 留着');
    ok(Object.keys(c0.tv).join() === '5,6' && c0.tv['6'].d === '' && c0.tv['6'].e === 0 && c0.tv['6'].s === 0 && c0.tv['6'].c === 0 && c0.tv['5'].s === 3 && c0.tv['5'].c === 28 && c0.tv['5'].l === 1, '剧集键只认数字 id,坏日期/季号/累计集号清空');
    ok(Object.keys(S.cacheParse('not json').ids).length === 0 && Object.keys(S.cacheParse(null).tv).length === 0, '坏缓存 → 空');
    // 查询计划
    const NOW = Date.UTC(2026, 9, 8, 12), H = 3600000;
    const cc = S.cacheParse(JSON.stringify({
        ids: { A: { id: 1, ts: NOW - 29 * DAYMS }, B: { id: 2, ts: NOW - 29 * DAYMS }, C: { id: 3, ts: NOW - 31 * DAYMS }, D: { id: 0, ts: NOW - 6 * DAYMS }, E: { id: 0, ts: NOW - 8 * DAYMS }, F: { id: 4, ts: NOW + 2 * DAYMS } },
        tv: { 1: { d: '', ts: NOW - 5 * H }, 2: { d: '', ts: NOW - 7 * H }, 4: { d: '', ts: NOW } }
    }));
    const pl = S.plan(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(n => fav(n)).concat([fav('A'), fav('K', { kz: true }), fav('M', { st: { finished: true } })]), cc, NOW);
    ok(pl.map(t => t.fav_id + (t.search ? 's' : 'd')).join() === 'Gs,Cs,Es,Bd,Fs', '计划:认过且新鲜的不查;详情过期只查详情;id 过期(30 天)/没认出过 7 天/将来时间戳 → 重新搜;按缓存最旧的先');
    ok(pl.find(t => t.fav_id === 'B').id === 2 && pl.find(t => t.fav_id === 'G').q === 'G' && !pl.some(t => t.fav_id === 'K' || t.fav_id === 'M'), '只查在连载的;同一部只查一次');
    // 缓存 → 下一集表
    const am = S.airMap(S.cacheParse(JSON.stringify({ ids: { A: { id: 1, ts: NOW, b: 1 }, B: { id: 2, ts: NOW }, C: { id: 0, ts: NOW }, D: { id: 9, ts: NOW } }, tv: { 1: { d: '2026-10-09', e: 11, s: 2, c: 23, l: 1, ts: NOW - 2 * DAYMS }, 2: { d: '2026-10-10', e: 3, ts: NOW - 4 * DAYMS } } })), NOW);
    ok(Object.keys(am).join() === 'A' && am.A.d === '2026-10-09' && am.A.e === 11 && am.A.s === 2 && am.A.c === 23 && am.A.b === 1 && Object.isFrozen(am) && Object.isFrozen(am.A), '下一集表:只放有日期、不太旧(3 天)的;带季号/累计集号/b;冻结');
    const am2 = S.airMap(S.cacheParse(JSON.stringify({ ids: { A: { id: 1, ts: NOW, b: 1 } }, tv: { 1: { d: '2026-10-09', e: 11, s: 2, c: 23, ts: NOW } } })), NOW);
    ok(S.sameAir(am, am2) && !S.sameAir(am, Object.create(null)) && !S.sameAir(am, { A: { d: '2026-10-09', e: 12, s: 2, c: 23, b: 1 } }) && !S.sameAir(am, { A: { d: '2026-10-09', e: 11, s: 3, c: 23, b: 1 } }) && !S.sameAir(am, { A: { d: '2026-10-09', e: 11, s: 2, c: 23, b: 0 } }), 'sameAir(季号/b 变了也算变)');
    const pr = S.cachePrune(S.cacheParse(JSON.stringify({ ids: { A: { id: 1, ts: NOW }, Z: { id: 2, ts: NOW } }, tv: { 1: { d: '', ts: NOW }, 2: { d: '', ts: NOW }, 3: { d: '', ts: NOW } } })), [fav('A')], NOW);
    ok(Object.keys(pr.ids).join() === 'A' && Object.keys(pr.tv).join() === '1', '清理:不在收藏里的片名、没人用的剧集');
    // 7 天分桶(今天 2026-10-08 周四)
    const row = (id, air, cad) => ({ id, name: id, item: { fav_id: id }, air: air || '', cad: cad || null });
    const wk = S.week([row('甲', '2026-10-10', { daily: false, days: [6, 7] }), row('乙', '', { daily: false, days: [3, 4] }), row('丙', '', { daily: true, days: [] }),
    row('丁', '2026-10-20', { daily: false, days: [3, 4] }), row('戊', '2026-10-01', { daily: false, days: [5] }), row('己', '2026-10-09', null)], TD);
    const at = i => wk[i].items.map(x => x.id).join('');
    ok(wk.length === 7 && wk.map(d => d.label).join() === '今天,明天,周六,周日,周一,周二,周三' && wk.map(d => d.date).join() === '2026-10-08,2026-10-09,2026-10-10,2026-10-11,2026-10-12,2026-10-13,2026-10-14'
        && wk[0].today && !wk.slice(1).some(d => d.today) && wk[0].md === '10月8日', '今天起 7 天,今天排第一并标记');
    ok(at(0) === '乙丙' && at(1) === '丙戊己' && at(2) === '甲丙' && at(3) === '甲丙' && at(4) === '丙' && at(6) === '乙丙',
        'TMDB 日期那天 + 规律里在它之后的;TMDB 日期在窗口外(10/20)→ 这周都不放;过去的 TMDB 日期退回规律;日更每天都有');
    ok(S.week([row('甲', '', null), row('乙', '2026-10-30', null)], TD) === null && S.week([], 'bad') === null, '这周一部都没有 → null(整条隐藏)');
    // 整体:收藏列表 → 每张卡那一行 + 本周
    const list = [
        fav('魅影神捕', { st: { ep_count: 17, total: 30 } }),
        fav('无可替代', { st: { ep_count: 8, cadence: { daily: false, days: [3, 4], n: 6, last_t: 1 } } }),
        fav('完结剧', { st: { ep_count: 40, total: 40, finished: true, cadence: { daily: true, days: [] } } }),
        fav('电影', { st: { ep_count: 1 }, sig: 'y2025m' }),
        fav('原型键', { id: '__proto__', st: { ep_count: 3, cadence: { daily: true, days: [] } } }),
        fav('过期日期', { st: { ep_count: 5 } })
    ];
    const air = Object.freeze(Object.assign(Object.create(null), { '魅影神捕': { d: '2026-10-09', e: 18, s: 1, c: 18 }, '过期日期': { d: '2026-10-07', e: 6, s: 1, c: 6 }, '完结剧': { d: '2026-10-09', e: 41, s: 1, c: 41 } }));
    const sc = S.schedule(list, air, TD);
    ok(sc.line['魅影神捕'] === '17/30 · 明天更新' && sc.line['无可替代'] === '通常每周三、四更新' && sc.line['__proto__'] === '每天更新' && sc.any, '每张卡那一行');
    ok(!('完结剧' in sc.line) && !('电影' in sc.line) && !('过期日期' in sc.line) && Object.getPrototypeOf(sc.line) === null, '完结/电影/只有过去日期:没有这一行');
    ok(sc.week[0].items.map(x => x.id).join() === '无可替代,__proto__' && sc.week[1].items.map(x => x.id).join() === '魅影神捕,__proto__' && sc.week[1].items[0].item === list[0], '本周条:项带收藏条目(点了和点卡片一样)');
    const none = S.schedule([fav('完结剧', { st: { finished: true } })], air, TD);
    ok(!none.any && none.week === null && S.schedule(null, null, TD).week === null, '没有在连载的:不显示');
    // 第一轮审查回归:TMDB 同一个条目在播的是别的季 → 收藏的这季(早播完了)不能报"周六更新"
    //   真实数据(/api/tmdb-proxy,2026-10-08):146339 大王饶命 下一集 S3E4 10-10;131040 披荆斩棘 S6E17 10-09;231620 现在就出发 S4E1 10-10
    const ssn = [
        fav('大王饶命', { st: { ep_count: 12, total: 12, remarks: '更新至第12集' } }),
        fav('披荆斩棘第四季', { st: { ep_count: 20, remarks: '更新至20241101期' } }),
        fav('现在就出发第二季', { st: { ep_count: 12, remarks: '更新至20250118期' } }),
        fav('大王饶命3', { st: { ep_count: 3 } }),
        fav('凡人修仙传', { st: { ep_count: 196 } }),
        fav('名侦探柯南', { st: { ep_count: 1180, changed_at: Date.UTC(2026, 9, 4, 12) } }),   // 站上这条最近涨过集(第四轮 T5)
        fav('庆余年第二季', { st: { ep_count: 6 } }),
    ];
    const sAir = Object.freeze(Object.assign(Object.create(null), {
        '大王饶命': { d: '2026-10-10', e: 4, s: 3, c: 28, b: 0 },          // 不带季号 = 第 1 季(12 集),TMDB 在播第 3 季
        '披荆斩棘第四季': { d: '2026-10-09', e: 17, s: 6, c: 0, b: 1 },     // 去掉季号认出的条目,在播第 6 季
        '现在就出发第二季': { d: '2026-10-10', e: 1, s: 4, c: 0, b: 1 },
        '大王饶命3': { d: '2026-10-10', e: 4, s: 3, c: 28, b: 1 },          // 末尾数字 = 第 3 季 → 对上
        '凡人修仙传': { d: '2026-10-10', e: 195, s: 1, c: 195, b: 0 },      // 只有一季(站上 196 集)→ 对上
        '名侦探柯南': { d: '2026-10-11', e: 12, s: 30, c: 1181, b: 0 },     // 不带季号、TMDB 分季:累计集号 ≈ 站上集数 + 1 → 对上
        '庆余年第二季': { d: '2026-10-09', e: 7, s: 1, c: 7, b: 0 },        // 全名(带季号)认出的条目本身就是这一季 → 不比季号
    }));
    const ss = S.schedule(ssn, sAir, TD);
    ok(ss.line['大王饶命'] === '更新至 12/12 集' && !ss.line['披荆斩棘第四季'] && !ss.line['现在就出发第二季'], '收藏的季早播完、TMDB 在播别的季 → 不报更新日(以前「12/12 · 周六更新」「明天更新」「周六更新」)', ss.line);
    ok(ss.line['大王饶命3'] === '周六更新' && ss.line['凡人修仙传'] === '周六更新' && ss.line['名侦探柯南'] === '周日更新' && ss.line['庆余年第二季'] === '明天更新', '季号对上的照报(末尾数字季号/单季/累计集号/全名认出的那季)', ss.line);
    const wkN = ss.week.map(d => d.items.map(x => x.id).join('|'));
    ok(!wkN.join().includes('披荆斩棘') && !wkN.join().includes('现在就出发') && !wkN.some(s => s.split('|').includes('大王饶命')) && wkN[2] === '大王饶命3|凡人修仙传', '本周更新条里也没有对不上季的', wkN);
    const CH = Date.UTC(2026, 9, 5, 12);   // 站上这条最近一次涨集(第四轮 T5:不带季号认第 2 季以后的,站上得最近涨过)
    ok(S.nextFits(fav('某剧', { st: { ep_count: 100, changed_at: CH } }), { d: TD, s: 4, c: 140, b: 0 }) === false && S.nextFits(fav('某剧', { st: { ep_count: 100, changed_at: CH } }), { d: TD, s: 4, c: 103, b: 0 }) === true
        && S.nextFits(fav('某剧', { st: null, added_ep: 12 }), { d: TD, s: 2, c: 13, b: 0 }) === false && S.nextFits(fav('某剧第二季'), { d: TD, b: 1 }) === false, 'nextFits:累计集号容差(±max(3, 5%));没状态(不知道站上涨没涨)→ 不认第 2 季以后的;旧缓存没季号 → 不认');
});

// 第二轮审查回归(纯函数):时区换算 / TMDB 下一集停在昨天 / 季终后不认下一季
const TZ0 = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const inTz = (tz, fn) => { process.env.TZ = tz; try { return fn(); } finally { process.env.TZ = TZ0; } };
await T(async () => {
    // F8 北京日历 → 本地日历(美西 PDT = 北京 −15h;国内不变)
    const LA = 'America/Los_Angeles', SH = 'Asia/Shanghai';
    ok(inTz(LA, () => S.bjToLocal('2026-10-10', 600, 0)) === '2026-10-09' && inTz(SH, () => S.bjToLocal('2026-10-10', 600, 0)) === '2026-10-10'
        && inTz(LA, () => S.bjToLocal('2026-10-10', 22 * 60, 0)) === '2026-10-10' && S.bjToLocal('bad', 0, 0) === '', 'F8 bjToLocal:北京周六 10:00 = 美西周五 19:00;22:00 = 周六 07:00;国内不变');
    const sat10 = { daily: false, days: [6], clock: 600 };
    ok(inTz(LA, () => S.localCad(sat10, '2026-10-09')).days.join() === '5' && inTz(SH, () => S.localCad(sat10, '2026-10-09')) === sat10
        && inTz(LA, () => S.localCad({ daily: false, days: [6], clock: 22 * 60 }, '2026-10-09')).days.join() === '6'
        && inTz(LA, () => S.localCad({ daily: false, days: [6], clock: 1440 + 30 }, '2026-10-09')).days.join() === '6'
        && inTz(LA, () => S.localCad({ daily: false, days: [1, 7], clock: 600 }, '2026-10-09')).days.join() === '6,7'
        && inTz(LA, () => S.localCad({ daily: false, days: [6] }, '2026-10-09')).days.join() === '6', 'F8 localCad:北京周六上午 → 美西周五;晚上 22:00 / 过零点 24:30(算周六晚上)仍周六;周日+周一 → 周六、日;没给钟点按 20:00');
    ok(inTz(LA, () => S.airLocal('2026-10-10', 1, sat10)) === '2026-10-09' && inTz(LA, () => S.airLocal('2026-10-10', 0, sat10)) === '2026-10-10'
        && inTz(LA, () => S.airLocal('2026-10-10', 1, null)) === '2026-10-10' && inTz(LA, () => S.airLocal('2026-10-10', 1, { clock: 1440 + 30 })) === '2026-10-10'
        && inTz(SH, () => S.airLocal('2026-10-10', 1, sat10)) === '2026-10-10' && S.airLocal('', 1, null) === '', 'F8 airLocal:国产剧按钟点换(没有按 20:00);外国剧(bj=0)不换;国内不变');
    ok(S.tvNext({ next_episode_to_air: { air_date: '2026-10-10', episode_number: 1, season_number: 1 }, origin_country: ['US'] }).bj === 0
        && S.tvNext({ origin_country: ['KR'] }).bj === 0 && S.tvNext({ origin_country: ['CN'] }).bj === 1 && S.tvNext({ origin_country: ['HK', 'US'] }).bj === 1
        && S.tvNext({ origin_country: [] }).bj === 1 && S.cacheParse('{"tv":{"5":{"d":"","bj":0,"ts":1},"6":{"d":"","ts":1}}}').tv['5'].bj === 0 && S.cacheParse('{"tv":{"6":{"d":"","ts":1}}}').tv['6'].bj === 1, 'F8 tvNext.bj:出品国中国大陆/港澳台(或没写)= 北京日历;美/韩 = 0;缓存读回');
    // 审查原例:美西周五(10/09)晚上,北京周六 10:00 的动画已经上了 —— 以前卡片「明天更新」、条上排明天
    const anim = [fav('动画', { st: { ep_count: 20, cadence: { daily: false, days: [6], n: 5, last_t: 1, clock: 600 } } }), fav('动画2', { st: { ep_count: 20, cadence: { daily: false, days: [6], n: 5, last_t: 1, clock: 600 } } })];
    const animAir = Object.freeze(Object.assign(Object.create(null), { '动画': { d: '2026-10-10', e: 21, s: 1, c: 21, b: 0, bj: 1 } }));
    const la = inTz(LA, () => S.schedule(anim, animAir, '2026-10-09'));
    ok(la.line['动画'] === '今天更新' && la.line['动画2'] === '通常每周五更新' && la.week[0].items.map(x => x.id).join() === '动画,动画2' && !la.week[1].items.length, 'F8 美西周五:北京周六 10:00 的 → 「今天更新」/「通常每周五更新」,条上排今天(以前「明天更新」「通常每周六更新」)', la.line);
    const sh = inTz(SH, () => S.schedule(anim, animAir, '2026-10-09'));
    ok(sh.line['动画'] === '明天更新' && sh.line['动画2'] === '通常每周六更新' && sh.week[1].items.map(x => x.id).join() === '动画,动画2', 'F8 国内(北京时间)同一天看:照旧「明天更新」/「每周六」', sh.line);
});
await T(async () => {
    // 第三轮 S5:clock 是相对服务器"更新日"的,更新日可能是 TMDB 日期的前一天(零点/凌晨上新算前一天晚上)。
    //   以前 airLocal 直接加 clock % 1440:周四 00:00 的剧(服务器算周三、clock 23:28)→ 周四 23:28 → 美西/欧洲晚一天
    const LA = 'America/Los_Angeles', SH = 'Asia/Shanghai', BER = 'Europe/Berlin';
    const thu0 = { daily: false, days: [3], clock: 1408 }, thu0b = { daily: false, days: [3], clock: 1450 };
    ok(inTz(LA, () => S.airLocal('2026-10-15', 1, thu0)) === '2026-10-14' && inTz(LA, () => S.airLocal('2026-10-15', 1, thu0b)) === '2026-10-14'
        && inTz(BER, () => S.airLocal('2026-10-15', 1, thu0)) === '2026-10-14' && inTz(SH, () => S.airLocal('2026-10-15', 1, thu0)) === '2026-10-15',
        'S5 airLocal:周四 00:00 的剧(规律周三、clock 23:28 或 24:10)+ TMDB 周四 → 美西/柏林是周三(北京周四 00:00 = 美西周三 09:00),国内周四');
    // 周五 23:00 的剧,服务器算周五、clock 25:27(资源站凌晨才有)+ TMDB 周五 → 美西周五 08:00 播出;以前 clock % 1440 = 周五 01:27 → 周四
    const fri23 = { daily: false, days: [5], clock: 1527 };
    ok(inTz(LA, () => S.airLocal('2026-10-16', 1, fri23)) === '2026-10-16' && inTz(SH, () => S.airLocal('2026-10-16', 1, fri23)) === '2026-10-16',
        'S5 airLocal:规律那天 = TMDB 那天、clock 过了 24:00 → 夹在 TMDB 那天里(美西仍周五)');
    // 周四 23:00 的剧(规律周四、clock 23:28)+ TMDB 周四 → 就是周四 23:28(美西周四 08:28);日更 / 没给星期几的照旧按 clock 是否过 24:00
    ok(inTz(LA, () => S.airLocal('2026-10-15', 1, { daily: false, days: [4], clock: 1408 })) === '2026-10-15'
        && inTz(LA, () => S.airLocal('2026-10-15', 1, { daily: true, days: [1, 2, 3, 4, 5, 6, 7], clock: 1408 })) === '2026-10-15'
        && inTz(LA, () => S.airLocal('2026-10-15', 1, { daily: true, days: [1, 2, 3, 4, 5, 6, 7], clock: 1450 })) === '2026-10-15', 'S5 airLocal:规律就是 TMDB 那天 / 日更 → 按钟点(日更 24:10 = TMDB 那天深夜,第四轮 T4)');
    // localCad:clock 现在可到 30:00(服务器把凌晨才查到的周五剧算周五)→ 夹在更新日里,国内用户不会被挪到周六
    ok(inTz(SH, () => S.localCad(fri23, '2026-10-13')).days.join() === '5' && inTz(LA, () => S.localCad(fri23, '2026-10-13')).days.join() === '5'
        && inTz('Australia/Sydney', () => S.localCad(fri23, '2026-10-13')).days.join() === '6', 'S5 localCad:clock 25:27 的周五 → 国内/美西周五,悉尼周六(北京周五 23:59 = 悉尼周六 02:59)');
    // 审查原例:美西 2026-10-13(周二)上午,周四 00:00 的剧 TMDB 下一集周四 → 「明天更新」、条上排明天(以前「周四更新」/ 周四)
    const ep4 = [fav('零点剧', { st: { ep_count: 4, cadence: { daily: false, days: [3], n: 5, last_t: 1, clock: 1408 } } })];
    const air4 = Object.freeze(Object.assign(Object.create(null), { '零点剧': { d: '2026-10-15', e: 5, s: 1, c: 5, b: 0, bj: 1 } }));
    const la4 = inTz(LA, () => S.schedule(ep4, air4, '2026-10-13'));
    ok(la4.line['零点剧'] === '明天更新' && la4.week[1].items.map(x => x.id).join() === '零点剧', 'S5 美西 10-13:北京周四 00:00 的剧 →「明天更新」,条上排明天(以前「周四更新」)', la4.line);
    const sh4 = inTz(SH, () => S.schedule(ep4, air4, '2026-10-14'));
    ok(sh4.line['零点剧'] === '明天更新' && sh4.week[1].items.map(x => x.id).join() === '零点剧', 'S5 国内 10-14 看同一部 → 明天(周四)', sh4.line);
});
await T(async () => {
    // 第四轮 T4:clock ≥ 24:00 只在"服务器把零点后才有的记成前一天晚上"时出现 —— 日更/连着几天的,TMDB 日期就是那天晚上的官方日期,
    //   不能再减一天(以前日更 23:00、资源站 00:08 才有 → D@24:08 → 美西/柏林早一天:「今天更新」报在周日、周一反而没了)。
    //   服务器把周五 23:00 的剧标成「周六 01:28」时,TMDB 的周五 = 规律日的前一天 → 周五深夜(以前当周五 01:28 → 美西周四)
    const LA = 'America/Los_Angeles', SH = 'Asia/Shanghai', BER = 'Europe/Berlin', NY = 'America/New_York';
    const D7 = [1, 2, 3, 4, 5, 6, 7];
    const official = (tz, d, h) => inTz(tz, () => S.localDay(new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), h - 8))));
    for (const tz of [LA, NY, BER, SH]) {
        const r1 = inTz(tz, () => S.airLocal('2026-10-12', 1, S.normCad({ daily: true, days: D7, clock: 1448 })));
        ok(r1 === official(tz, '2026-10-12', 23), 'T4 日更 23:00、资源站 00:08(D@24:08)+ TMDB 周一 10-12 → ' + tz + ' 是官方那天 ' + official(tz, '2026-10-12', 23), r1);
        const r2 = inTz(tz, () => S.airLocal('2026-10-16', 1, S.normCad({ daily: false, days: [6], clock: 88 })));
        ok(r2 === official(tz, '2026-10-16', 23), 'T4 周五 23:00 被标成周六 01:28 + TMDB 周五 → ' + tz + ' ' + official(tz, '2026-10-16', 23), r2);
        const r3 = inTz(tz, () => S.airLocal('2026-10-13', 1, S.normCad({ daily: true, days: D7, clock: 80 })));
        ok(r3 === official(tz, '2026-10-13', 23), 'T4 日更 23:00、资源站凌晨 01:20(D@01:20)+ TMDB 周二 → 算周二晚上的:' + tz + ' ' + official(tz, '2026-10-13', 23), r3);
        const r4 = inTz(tz, () => S.airLocal('2026-10-14', 1, S.normCad({ daily: false, days: [1, 2, 3, 4], clock: 1470 })));
        ok(r4 === official(tz, '2026-10-14', 22), 'T4 周一至四 22:00、资源站过零点(1234@24:30)+ TMDB 周三 → ' + tz + ' ' + official(tz, '2026-10-14', 22), r4);
    }
    // 规律证明是官方零点更新的(TMDB 那天不在规律里、前一天在)照旧减一天;真凌晨更新(TMDB 那天在规律里、钟点 02:00)照旧
    ok(inTz(LA, () => S.airLocal('2026-10-18', 1, { daily: false, days: [6], clock: 1470 })) === '2026-10-17'
        && inTz(LA, () => S.airLocal('2026-10-14', 1, { daily: false, days: [3], clock: 120 })) === '2026-10-13'
        && inTz(SH, () => S.airLocal('2026-10-18', 1, { daily: false, days: [6], clock: 1470 })) === '2026-10-18', 'T4 对照:周日 00:00 的(规律周六 24:30)→ 美西周六;周三 02:00 → 美西周二;国内不变');
    const al = S.alignAir('2026-10-18', { daily: false, days: [6], clock: 1470 }), al2 = S.alignAir('2026-10-16', { daily: false, days: [6], clock: 88 }), al3 = S.alignAir('2026-10-17', { daily: false, days: [3], clock: 1200 });
    ok(al.s === -1 && al.m === 30 && al.sure && al2.s === 1 && al2.m === 1439 && al2.sure && al3.s === 0 && !al3.sure && S.alignAir('2026-10-17', null).m === S.T.defClock,
        'T4 alignAir:更新日 = TMDB −1 / +1 / 规律里没有这几天(sure=false)/ 没钟点按 20:00', [al, al2, al3]);
});
await T(async () => {
    // 第四轮 T7:本周更新条按 TMDB 日期之后排规律的星期几 —— 规律得先对齐到官方日历。周日 00:00 的剧服务器算「周六 24:30」、TMDB 说周日:
    //   以前国内周日看:「今天 [剧]」+「周六 10-24 [剧]」,下一集其实是 10-25 周日
    const SH = 'Asia/Shanghai', LA = 'America/Los_Angeles';
    const sun0 = [fav('零点周日', { st: { ep_count: 8, cadence: { daily: false, days: [6], n: 5, last_t: 1, clock: 1470 } } })];
    const airS = Object.freeze(Object.assign(Object.create(null), { '零点周日': { d: '2026-10-18', e: 9, s: 1, c: 9, b: 0, bj: 1 } }));
    const sh = inTz(SH, () => S.schedule(sun0, airS, '2026-10-18'));
    const wkS = sh.week.filter(d => d.items.length).map(d => d.date);
    ok(sh.line['零点周日'] === '今天更新' && wkS.join() === '2026-10-18', 'T7 国内周日:条上只有今天(以前还排「周六 10-24」)', [sh.line, wkS]);
    const sh2 = inTz(SH, () => S.schedule(sun0, airS, '2026-10-19'));   // TMDB 日期过了(还没翻篇):卡片按规律说,规律也已对齐到周日
    ok(sh2.line['零点周日'] === '通常每周日更新' && sh2.week.filter(d => d.items.length).map(d => d.date).join() === '2026-10-25', 'T7 TMDB 日期过了:按对齐后的规律「通常每周日更新」、条上排 10-25(周日)', sh2.line);
    const la = inTz(LA, () => S.schedule(sun0, airS, '2026-10-17'));   // 美西:北京周日 00:30 = 美西周六 09:30
    ok(la.line['零点周日'] === '今天更新' && la.week.filter(d => d.items.length).map(d => d.date).join() === '2026-10-17', 'T7 美西周六:今天,条上只有今天(下一集美西 10-24 周六不在 7 天里)', la.line);
    // 服务器把周五 23:00 的剧标成「周六 01:28」、TMDB 说周五 → 条上周五(TMDB)之后排的也是周五,不是周六
    const fri = [fav('周五剧', { st: { ep_count: 8, cadence: { daily: false, days: [6], n: 5, last_t: 1, clock: 88 } } })];
    const airF = Object.freeze(Object.assign(Object.create(null), { '周五剧': { d: '2026-10-09', e: 9, s: 1, c: 9, b: 0, bj: 1 } }));
    const shF = inTz(SH, () => S.schedule(fri, airF, '2026-10-09'));
    ok(shF.week.filter(d => d.items.length).map(d => d.date).join() === '2026-10-09' && inTz(SH, () => S.schedule(fri, airF, '2026-10-10')).line['周五剧'] === '通常每周五更新', 'T7 标成周六 01:28 的周五剧:今天(周五)之后不再排周六;TMDB 日期过了说「每周五」', shF.week.map(d => d.items.length).join());
    // 对照:规律里没有 TMDB 那几天(特别篇/规律不准)→ 不挪规律;外国剧(bj=0)不挪
    const odd = [fav('特别篇', { st: { ep_count: 8, cadence: { daily: false, days: [3], n: 5, last_t: 1, clock: 1200 } } })];
    const shO = inTz(SH, () => S.schedule(odd, Object.freeze(Object.assign(Object.create(null), { '特别篇': { d: '2026-10-10', e: 9, s: 1, c: 9, b: 0, bj: 1 } })), '2026-10-10'));
    ok(shO.week.filter(d => d.items.length).map(d => d.date).join() === '2026-10-10,2026-10-14', 'T7 对照:TMDB 日期不在规律附近 → 规律照旧(周三)', shO.week.map(d => d.items.length).join());
});
await T(async () => {
    // 第四轮 T5:不带季号的收藏、站上不给总集数(vod_total=0 最常见)、第一季几个月前就停了(备注没写完结)→ TMDB 第 2 季的下一集不认
    //   (以前 S2E1~E4 的累计集号 13~16 都在容差里 → 卡片「明天更新」、条上也有,点进去是播完的第一季)
    const TD = '2026-10-08', old = Date.UTC(2026, 5, 10), recent = Date.UTC(2026, 9, 3);
    const s1 = (ch) => fav('某剧', { st: { ep_count: 12, remarks: '更新至12集', changed_at: ch } });
    const bad = [];
    for (let e = 1; e <= 5; e++) {
        const ai = { d: plus(TD, 1 + 7 * (e - 1)), e, s: 2, c: 12 + e, b: 0, bj: 1 };
        const sc = S.schedule([s1(old)], Object.freeze(Object.assign(Object.create(null), { '某剧': ai })), plus(TD, 7 * (e - 1)));
        if (S.nextFits(s1(old), ai, TD) || sc.line['某剧'] || sc.week) bad.push(e);
    }
    ok(!bad.length, 'T5 第一季 120 天没涨过集、TMDB 第 2 季 E1~E5 → 都不认(卡片、条上都没有)', bad);
    ok(S.nextFits(s1(null), { d: TD, e: 1, s: 2, c: 13, b: 0 }, TD) === false, 'T5 站上从没见过涨集(changed_at 空)→ 不认');
    ok(S.nextFits(s1(recent), { d: TD, e: 1, s: 2, c: 13, b: 0 }, TD) === true && S.nextFits(s1(Date.UTC(2026, 8, 20)), { d: TD, e: 1, s: 2, c: 13, b: 0 }, TD) === true
        && S.nextFits(s1(Date.UTC(2026, 8, 10)), { d: TD, e: 1, s: 2, c: 13, b: 0 }, TD) === false, 'T5 站上这条 5 天前 / 18 天前涨过 → 认(连着编号的);28 天前 → 不认');
    ok(S.nextFits(s1(recent), { d: TD, e: 2, s: 2, c: 14, b: 0 }, TD) === true && S.nextFits(s1(recent), { d: TD, e: 3, s: 2, c: 15, b: 0 }, TD) === false
        && S.nextFits(s1(recent), { d: TD, e: 1, s: 2, c: 10, b: 0 }, TD) === true, 'T5 集数少的:TMDB 已播比站上多 2 集以上 → 不认(站上这条没跟新一季);站上多几集照认');
    ok(S.nextFits(fav('柯南', { st: { ep_count: 1150, changed_at: recent } }), { d: TD, e: 12, s: 30, c: 1181, b: 0 }, TD) === true, 'T5 长剧(容差 5%)站上比 TMDB 累计少几十集照认(分季累计和站上编号本来就对不齐)');
    ok(S.nextFits(s1(old), { d: TD, e: 13, s: 1, c: 13, b: 0 }, TD) === true && S.nextFits(fav('某剧第二季', { st: { ep_count: 3, changed_at: old } }), { d: TD, e: 4, s: 2, c: 16, b: 1 }, TD) === true, 'T5 对照:第 1 季、带季号的不看涨集时间');
});
await T(async () => {
    // F5 TMDB 的下一集停在昨天(北京上午 09:34 = UTC 01:34)
    const now5 = Date.UTC(2026, 9, 9, 1, 34);
    ok(S.bjToday(now5) === '2026-10-09' && S.bjToday(Date.UTC(2026, 9, 8, 15, 59)) === '2026-10-08' && S.bjToday(Date.UTC(2026, 9, 8, 16, 0)) === '2026-10-09', 'F5 北京今天:UTC 16:00 翻日');
    ok(S.homeToday(1, now5, '2026-10-08') === '2026-10-09' && S.homeToday(0, now5, '2026-10-08') === '2026-10-08', 'F5 判"已经播过":国产剧按北京今天,外国剧按本地今天');
    const n17 = { d: '2026-10-08', e: 17, s: 1, c: 17, l: 1, bj: 1 };
    const s1 = { episodes: [{ episode_number: 16, air_date: '2026-10-08' }, { episode_number: 17, air_date: '2026-10-08' }, { episode_number: 19, air_date: '2026-10-10' }, { episode_number: 18, air_date: '2026-10-09' }, { episode_number: 20, air_date: null }] };
    const r5 = S.seasonNext(n17, s1, '2026-10-09');
    ok(r5.d === '2026-10-09' && r5.e === 18 && r5.c === 18 && r5.s === 1 && r5.bj === 1 && n17.d === '2026-10-08', 'F5 seasonNext:换成集表里 ≥ 今天的第一集(E18 10-09),累计集号跟着加;不改原对象', r5);
    ok(S.seasonNext(n17, { episodes: [{ episode_number: 18, air_date: null }] }, '2026-10-09') === n17 && S.seasonNext(n17, null, '2026-10-09') === n17
        && S.seasonNext(Object.assign({}, n17, { d: '2026-10-09' }), s1, '2026-10-09').e === 17 && S.seasonNext({ d: '', e: 0 }, s1, '2026-10-09').d === '', 'F5 seasonNext:集表没排出更晚的/坏集表/下一集不在过去 → 原样');
    ok(S.isPast({ d: '2026-10-08', bj: 1 }, now5, '2026-10-08') && !S.isPast({ d: '2026-10-08', bj: 0 }, now5, '2026-10-08') && !S.isPast({ d: '', bj: 1 }, now5, '2026-10-08'), 'F5 isPast');
    const c5 = S.cacheParse(JSON.stringify({ ids: { 甲: { id: 1, ts: now5 }, 乙: { id: 2, ts: now5 } }, tv: { 1: { d: '2026-10-08', e: 17, s: 1, c: 17, l: 1, ts: now5 - 2 * 3600000 }, 2: { d: '2026-10-10', e: 3, s: 1, c: 3, l: 1, ts: now5 - 2 * 3600000 } } }));
    ok(S.plan([fav('甲'), fav('乙')], c5, now5, '2026-10-08').map(t => t.fav_id).join() === '甲', 'F5 plan:下一集日期已过的 1 小时后就重查(没过的照旧 6 小时)');
});
await T(async () => {
    // F7 季终后(12/12)不带季号的收藏:TMDB 的第 2 季第 1 集(累计 13 ≈ 12 + 1)不认;没到总集数的照认
    const d12 = fav('大王饶命', { st: { ep_count: 12, total: 12, remarks: '更新至第12集' } });
    const ch7 = Date.UTC(2026, 9, 6, 12);
    ok(S.nextFits(d12, { d: '2026-10-10', e: 1, s: 2, c: 13, b: 0 }) === false && S.nextFits(fav('大王饶命', { st: { ep_count: 12, changed_at: ch7 } }), { d: '2026-10-10', e: 1, s: 2, c: 13, b: 0 }, '2026-10-08') === true
        && S.nextFits(fav('柯南', { st: { ep_count: 1180, total: 1200, changed_at: ch7 } }), { d: '2026-10-10', e: 12, s: 30, c: 1181, b: 0 }, '2026-10-08') === true && S.nextFits(d12, { d: '2026-10-10', e: 13, s: 1, c: 13, b: 0 }) === true,
        'F7 nextFits:集数已到总集数 → 不认下一季的累计集号;不知道总集数/没到总集数(站上最近涨过)照认;第 1 季照认');
    const s7 = S.schedule([d12], Object.freeze(Object.assign(Object.create(null), { '大王饶命': { d: '2026-10-10', e: 1, s: 2, c: 13, b: 0, bj: 1 } })), '2026-10-08');
    ok(s7.line['大王饶命'] === '更新至 12/12 集' && s7.week === null, 'F7 季终的 12/12:不报下一季的「周六更新」(以前「12/12 · 周六更新」)', s7.line);
});

// 假 TMDB(经 /api/tmdb-proxy):按 path 分派;记录每个请求和同时在途的最大数
function tmdbServer(routes) {
    const st = { reqs: [], inflight: 0, max: 0, fail: null };
    globalThis.tmdbFetch = async (url, o) => {
        const u = new URL('http://x' + url);
        const rec = { url, path: u.searchParams.get('path'), query: u.searchParams.get('query'), year: u.searchParams.get('first_air_date_year'), lang: u.searchParams.get('language'), signal: !!(o && o.signal) };
        st.reqs.push(rec);
        st.inflight++; st.max = Math.max(st.max, st.inflight);
        try {
            await new Promise(r => setTimeout(r, 3));
            if (st.fail && st.fail(rec)) return { ok: false, status: 502, json: async () => ({ error: 'Proxy request failed' }) };
            let body = null;
            if (rec.path === '/search/tv') body = { results: (routes.search[rec.query + (rec.year ? '@' + rec.year : '')] || []) };
            else if (/^\/tv\/\d+\/season\/\d+$/.test(rec.path)) { const k = rec.path.slice(4).replace('/season/', '/'); if (!routes.season || !(k in routes.season)) return { ok: false, status: 404, json: async () => ({}) }; body = routes.season[k]; }
            else if (/^\/tv\/\d+\/season\/\d+\/episode\/\d+$/.test(rec.path)) {
                // 单集(/tv/{id}/season/{s}/episode/{e}):从同一份集表里取那一集;没有 → 404
                const [, id, sn, en] = /^\/tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)$/.exec(rec.path);
                const x = routes.season && routes.season[id + '/' + sn] && (routes.season[id + '/' + sn].episodes || []).find(e => e.episode_number === +en);
                if (!x) return { ok: false, status: 404, json: async () => ({ success: false, status_code: 34 }) };
                body = Object.assign({ season_number: +sn, name: '第 ' + en + ' 集', overview: '' }, x);
            }
            else { const m = /^\/tv\/(\d+)$/.exec(rec.path); if (!m || !(m[1] in routes.tv)) return { ok: false, status: 404, json: async () => ({}) }; body = routes.tv[m[1]]; }
            return { ok: true, status: 200, json: async () => body };
        } finally { st.inflight--; }
    };
    return st;
}

console.log('⑤ 追更日历:后台查 TMDB(_favSchedRun)');
await T(async () => {
    const today = S.localDay(new Date());
    const routes = {
        search: {
            '魅影神捕': [{ id: 101, name: '魅影神捕', first_air_date: '2026-09-20' }, { id: 109, name: '魅影神捕之前传' }],
            '无可替代': [{ id: 202, name: '无可替代的爱' }],
            '遮天@2023': [],
            '遮天': [{ id: 303, name: '遮天', first_air_date: '2023-05-03' }, { id: 304, name: '遮天', first_air_date: '2026-01-01' }],
            '庆余年': [{ id: 404, name: '庆余年', first_air_date: '2019-11-26' }],
        },
        tv: {
            101: { id: 101, next_episode_to_air: { air_date: plus(today, 1), episode_number: 18, season_number: 1 }, status: 'Returning Series' },
            303: { id: 303, next_episode_to_air: null, status: 'Returning Series' },
            404: { id: 404, next_episode_to_air: { air_date: plus(today, 3), episode_number: 5, season_number: 2 }, seasons: [{ season_number: 1, episode_count: 46 }, { season_number: 2, episode_count: 36 }] },
        }
    };
    const srv = tmdbServer(routes);
    const { vm, ls, calls } = makeVm({ sched: true });
    vm.favToday = today;
    vm.favList = [
        fav('魅影神捕', { st: { ep_count: 17, total: 30 } }),
        fav('无可替代', { st: { ep_count: 8, cadence: { daily: false, days: [3, 4] } } }),
        fav('遮天', { sig: 'y2023s', st: { ep_count: 160 } }),
        fav('庆余年', { st: { ep_count: 12 } }),
        fav('庆余年第二季', { st: { ep_count: 6 } }),
        fav('完结剧', { st: { finished: true } }),
        fav('番剧', { kz: true }),
        fav('电影', { sig: 'y2025m', st: { ep_count: 1 } }),
    ];
    // 详情页/搜索开着:不查
    vm.showDetail = true; await vm._favSchedRun();
    vm.showDetail = false; vm.searched = true; await vm._favSchedRun();
    ok(srv.reqs.length === 0, '详情页/搜索结果开着时不查');
    vm.searched = false;
    const air0 = vm.favAir;
    await vm._favSchedRun();
    ok(srv.reqs.every(r => r.url.startsWith('/api/tmdb-proxy?path=') && r.lang === 'zh-CN' && r.signal) && !calls.some(c => /tmdb/.test(c.url || c.fetchT || '')), '全走 tmdbFetch → /api/tmdb-proxy(带超时信号),不用裸 fetch');
    ok(srv.max <= 3 && srv.max >= 2, '同时最多 3 个请求(实测 ' + srv.max + ')');
    const srch = srv.reqs.filter(r => r.path === '/search/tv');
    ok(srch.map(r => r.query + (r.year ? '@' + r.year : '')).sort().join() === '庆余年,庆余年,无可替代,遮天,遮天@2023,魅影神捕', '在连载的才搜(完结/番剧线路/电影不搜);带季号的按去掉季号搜;知道年份先带年份,没对上不带年份再搜一次');
    const det = srv.reqs.filter(r => r.path !== '/search/tv').map(r => r.path).sort();
    ok(det.join() === '/tv/101,/tv/303,/tv/404', '对上的才查详情;两部对上同一个 id 只查一次详情');
    const cache = JSON.parse(ls.getItem('donggua_fav_tmdb'));
    ok(cache.ids['魅影神捕'].id === 101 && cache.ids['无可替代'].id === 0 && cache.ids['遮天'].id === 303 && cache.ids['庆余年第二季'].id === 404 && !('完结剧' in cache.ids), '片名 → id 缓存(没对上记 0)');
    ok(cache.tv['101'].d === plus(today, 1) && cache.tv['101'].e === 18 && cache.tv['303'].d === '', '剧集 → 下一集缓存');
    ok(vm.favAir !== air0 && Object.isFrozen(vm.favAir) && Object.keys(vm.favAir).sort().join() === '庆余年,庆余年第二季,魅影神捕' && vm.favAir['魅影神捕'].d === plus(today, 1), 'favAir 整个换掉一次(冻结)');
    const sc = S.schedule(vm.favList, vm.favAir, vm.favToday);
    ok(sc.line['魅影神捕'] === '17/30 · 明天更新' && sc.line['无可替代'] === '通常每周三、四更新' && /更新$/.test(sc.line['庆余年第二季']) && !sc.line['遮天'], '卡片那一行用上了 TMDB 日期/规律');
    ok(cache.ids['庆余年第二季'].b === 1 && !cache.ids['庆余年'].b && cache.tv['404'].s === 2 && cache.tv['404'].c === 51 && !sc.line['庆余年'], '去掉季号认出的记 b、详情记季号/累计集号;第一季(12 集)的收藏不拿第二季的下一集日期');
    // 第二次:全命中缓存,不发请求,favAir 不重写
    const n1 = srv.reqs.length, air1 = vm.favAir;
    await vm._favSchedRun();
    ok(srv.reqs.length === n1 && vm.favAir === air1, '缓存都新鲜:不发请求、不重写 favAir');
    // 新开页面:从缓存秒出(不查),data() 初始化同口径
    const init = S.airMap(S.cacheParse(ls.getItem('donggua_fav_tmdb')), Date.now());
    ok(S.sameAir(init, vm.favAir), '新开页面:本地缓存直接给出同一份下一集表(首屏就有)');
    // 7 小时后:只重查详情(不重新搜)
    const realNow = Date.now;
    try {
        Date.now = () => realNow() + 7 * 3600000;
        const { vm: v2 } = makeVm({ sched: true, store: ls._m });
        v2.favToday = today; v2.favList = vm.favList;
        const n2 = srv.reqs.length;
        await v2._favSchedRun();
        const nr = srv.reqs.slice(n2);
        ok(nr.length === 3 && nr.every(r => /^\/tv\/\d+$/.test(r.path)), '6 小时后只重查详情(' + nr.map(r => r.path).join(' ') + ')');
    } finally { Date.now = realNow; }
});

await T(async () => {
    // 第一轮审查回归:同名好几部、TMDB 排第一的已完结/停播又没有下一集 → 再看后面的(最多 3 部),在播的优先;排第一的在播就只查它
    const today = S.localDay(new Date());
    const srv = tmdbServer({
        search: {
            '同名剧': [{ id: 901, name: '同名剧', first_air_date: '2025-01-01' }, { id: 902, name: '同名剧', first_air_date: '2020-01-01' }, { id: 903, name: '同名剧', first_air_date: '2018-01-01' }],
            '凡人修仙传': [{ id: 106449, name: '凡人修仙传', first_air_date: '2020-07-25' }, { id: 243224, name: '凡人修仙传', first_air_date: '2025-07-27' }],
            '都完结了': [{ id: 911, name: '都完结了' }, { id: 912, name: '都完结了' }],
        },
        tv: {
            901: { id: 901, status: 'Ended', next_episode_to_air: null },
            902: { id: 902, status: 'Returning Series', next_episode_to_air: { air_date: plus(today, 2), episode_number: 30, season_number: 1 } },
            903: { id: 903, status: 'Returning Series', next_episode_to_air: null },
            106449: { id: 106449, status: 'Returning Series', next_episode_to_air: { air_date: plus(today, 2), episode_number: 195, season_number: 1 } },
            243224: { id: 243224, status: 'Ended', next_episode_to_air: null },
            911: { id: 911, status: 'Ended' }, 912: { id: 912, status: 'Canceled' },
        }
    });
    const { vm, ls } = makeVm({ sched: true });
    vm.favToday = today;
    vm.favList = [fav('同名剧', { st: { ep_count: 29 } }), fav('凡人修仙传', { st: { ep_count: 196 } }), fav('都完结了', { st: { ep_count: 5 } })];
    await vm._favSchedRun();
    const c = JSON.parse(ls.getItem('donggua_fav_tmdb'));
    const det = srv.reqs.filter(r => r.path !== '/search/tv').map(r => r.path);
    ok(c.ids['同名剧'].id === 902 && det.filter(p => p === '/tv/901').length === 1 && det.filter(p => p === '/tv/902').length === 1 && !det.includes('/tv/903'), '同名剧:排第一的完结了 → 认在播的第二部(看到在播的就停)', [c.ids['同名剧'], det]);
    ok(c.ids['凡人修仙传'].id === 106449 && !det.includes('/tv/243224'), '凡人修仙传:排第一的就在播 → 只查它(以前认成 2025 年完结的那部,永远没有日期)', [c.ids['凡人修仙传'], det]);
    ok(c.ids['都完结了'].id === 911 && det.includes('/tv/912'), '都完结了:认 TMDB 排第一的', c.ids['都完结了']);
    const sc = S.schedule(vm.favList, vm.favAir, today);
    ok(/更新$/.test(sc.line['同名剧'] || '') && /更新$/.test(sc.line['凡人修仙传'] || ''), '在播那部的下一集日期上了卡片', sc.line);
});

await T(async () => {
    // 失败不写缓存;额度 30 部、每 6 小时补满;额度用完后从没查过的(新收藏的)每轮最多再查 3 部
    const routes = { search: {}, tv: {} };
    for (let i = 0; i < 40; i++) { const n = '剧' + String(i).padStart(2, '0'); routes.search[n] = [{ id: 1000 + i, name: n }]; routes.tv[1000 + i] = { id: 1000 + i, next_episode_to_air: null }; }
    routes.search['新收藏'] = [{ id: 2000, name: '新收藏' }];
    routes.tv[2000] = { id: 2000, next_episode_to_air: { air_date: plus(S.localDay(new Date()), 2), episode_number: 3, season_number: 1 } };
    const srv = tmdbServer(routes);
    srv.fail = r => r.query === '剧00' || r.path === '/tv/1001';
    const { vm, ls } = makeVm({ sched: true });
    vm.favToday = S.localDay(new Date());
    vm.favList = Array.from({ length: 40 }, (_, i) => fav('剧' + String(i).padStart(2, '0'), { added: 100 - i }));
    await vm._favSchedRun();
    const q1 = new Set(srv.reqs.filter(r => r.path === '/search/tv').map(r => r.query));
    ok(q1.size === 30 && srv.max <= 3, '一次最多查 30 部(并发 ≤3)');
    const c1 = JSON.parse(ls.getItem('donggua_fav_tmdb'));
    ok(!('剧00' in c1.ids) && c1.ids['剧01'].id === 1001 && !('1001' in c1.tv) && c1.ids['剧02'].id === 1002 && c1.tv['1002'], '搜索失败不写缓存;详情失败不写详情缓存');
    // 第一轮审查回归:额度不再是"每页一次、用完就再也不查"
    const n1 = srv.reqs.length;
    await vm._favSchedRun();
    const r1 = srv.reqs.slice(n1), q1b = r1.filter(r => r.path === '/search/tv').map(r => r.query);
    ok(q1b.length === 3 && q1b.every(q => q === '剧00' || +q.slice(1) >= 30) && r1.every(r => r.path === '/search/tv' || /^\/tv\/10[34]\d$/.test(r.path)), '额度用完:回首页只补查从没查过的 3 部(已有的不刷新)', r1.map(r => r.query || r.path));
    const n2 = srv.reqs.length;
    vm.favList = [fav('新收藏', { added: 200, st: { ep_count: 2 } })].concat(vm.favList);
    await vm._favSchedRun();
    const r2 = srv.reqs.slice(n2);
    ok(r2.some(r => r.query === '新收藏') && r2.some(r => r.path === '/tv/2000') && vm.favAir['新收藏'] && vm.favAir['新收藏'].e === 3, '额度用完后详情页里新收藏的:回首页照样补查,卡片马上有日期(以前要整页刷新)', r2.map(r => r.query || r.path));
    const realNow = Date.now;
    try {
        Date.now = () => realNow() + 7 * 3600000;
        srv.fail = null;
        const n3 = srv.reqs.length;
        await vm._favSchedRun();
        const r3 = srv.reqs.slice(n3), items = new Set(r3.map(r => r.query ? 's:' + r.query : r.path));
        ok(r3.filter(r => /^\/tv\/\d+$/.test(r.path)).length >= 10 && r3.some(r => r.path === '/tv/1001') && r3.some(r => r.query === '剧00') && items.size <= 2 * 33, '6 小时后额度补满:过期详情照常刷新、失败的补上(长开的标签页/TV/App 不会"用完就再也不刷新")', r3.length);
    } finally { Date.now = realNow; }
});

await T(async () => {
    // 第二轮审查回归 F5:TMDB 的 next_episode_to_air 按美国时间翻篇,北京上午还停在"昨天"那集(实测 2026-10-09 09:34 北京:魅影神捕 E17 10-08,
    //   它的第 1 季集表 E18 10-09)→ 查这一季集表换成 ≥ 今天的;集表查失败 → 照样存详情的(过去的日期不显示),1 小时后再查
    const T0 = Date.UTC(2026, 9, 9, 1, 34), realNow = Date.now;
    const bjT = '2026-10-09', bjY = '2026-10-08';
    const routes = {
        search: { '魅影神捕': [{ id: 290699, name: '魅影神捕' }], '雷霆令': [{ id: 336706, name: '雷霆令' }], '美剧': [{ id: 777, name: '美剧' }] },
        tv: {
            290699: { id: 290699, origin_country: ['CN'], status: 'Returning Series', next_episode_to_air: { air_date: bjY, episode_number: 17, season_number: 1 }, seasons: [{ season_number: 1, episode_count: 30 }] },
            336706: { id: 336706, origin_country: ['CN'], status: 'Returning Series', next_episode_to_air: { air_date: bjY, episode_number: 23, season_number: 1 } },
            777: { id: 777, origin_country: ['US'], status: 'Returning Series', next_episode_to_air: { air_date: '2026-10-08', episode_number: 5, season_number: 1 } },
        },
        season: { '290699/1': { episodes: [{ episode_number: 17, air_date: bjY }, { episode_number: 19, air_date: '2026-10-10' }, { episode_number: 18, air_date: bjT }] } }
    };
    const srv = tmdbServer(routes);
    srv.fail = r => r.path.startsWith('/tv/336706/season/1');
    try {
        Date.now = () => T0;
        const { vm, ls } = makeVm({ sched: true });
        vm.favToday = '2026-10-08';   // 美西本地(北京 09:34 = 美西前一天 18:34)
        vm.favList = [fav('魅影神捕', { st: { ep_count: 17, total: 30 } }), fav('雷霆令', { st: { ep_count: 23 } }), fav('美剧', { st: { ep_count: 4 } })];
        await vm._favSchedRun();
        let c = JSON.parse(ls.getItem('donggua_fav_tmdb'));
        const paths = srv.reqs.map(r => r.path);
        ok(paths.includes('/tv/290699/season/1/episode/18') && c.tv['290699'].d === bjT && c.tv['290699'].e === 18 && c.tv['290699'].c === 18, 'F5 下一集停在北京昨天(E17)→ 查 E18(第四轮 T6:按集查),换成今天的 E18');
        ok(!paths.some(p => /\/season\/\d+$/.test(p)) && paths.filter(p => /\/episode\//.test(p)).sort().join() === '/tv/290699/season/1/episode/18,/tv/336706/season/1/episode/24', 'T6 不再拉整季集表(25~115 KB),只查下一集(~250 B);找到 ≥ 今天的就停', paths);
        ok(c.tv['336706'] && c.tv['336706'].d === bjY && c.tv['336706'].e === 23 && paths.includes('/tv/336706/season/1/episode/24'), 'F5 集查失败 → 照样存详情的(不丢整条)');
        ok(!paths.some(p => /^\/tv\/777\/season/.test(p)) && c.tv['777'].bj === 0, 'F5 外国剧按本地今天:下一集就是今天 → 不查集表');
        const sh = inTz('Asia/Shanghai', () => S.schedule(vm.favList, vm.favAir, bjT));
        ok(sh.line['魅影神捕'] === '17/30 · 今天更新' && !sh.line['雷霆令'] && sh.week[0].items.map(x => x.id).join() === '魅影神捕', 'F5 国内上午:魅影神捕「今天更新」、条上排今天(以前这行没了);雷霆令过期的日期不显示');
        // 65 分钟后(没到 6 小时):只重查日期已过的雷霆令,这次集表查得到
        srv.fail = null;
        routes.season['336706/1'] = { episodes: [{ episode_number: 23, air_date: bjY }, { episode_number: 24, air_date: bjY }, { episode_number: 25, air_date: bjT }, { episode_number: 26, air_date: bjT }] };
        Date.now = () => T0 + 65 * 60000;
        const n1 = srv.reqs.length;
        await vm._favSchedRun();
        const r2 = srv.reqs.slice(n1).map(r => r.path);
        c = JSON.parse(ls.getItem('donggua_fav_tmdb'));
        ok(r2.join() === '/tv/336706,/tv/336706/season/1/episode/24,/tv/336706/season/1/episode/25' && c.tv['336706'].d === bjT && c.tv['336706'].e === 25, 'F5 日期已过的 1 小时后重查(没过的 6 小时内不查);E24 还是昨天 → 再查 E25,换成今天的 E25', r2);
        ok(inTz('Asia/Shanghai', () => S.schedule(vm.favList, vm.favAir, bjT)).line['雷霆令'] === '今天更新', 'F5 雷霆令「今天更新」');
        // T6 往后最多查 T.eps 集:TMDB 落后好几集(都还在过去)→ 查 3 集就停;这季没有更后面的(404)→ 查 1 集就停
        routes.tv[336706].next_episode_to_air = { air_date: '2026-10-05', episode_number: 20, season_number: 1 };
        routes.season['336706/1'] = { episodes: [20, 21, 22, 23, 24].map(e => ({ episode_number: e, air_date: '2026-10-0' + (e - 15) })) };
        routes.tv[290699].next_episode_to_air = { air_date: bjY, episode_number: 30, season_number: 1 };
        Date.now = () => T0 + 8 * 3600000;   // 两部的缓存都过了 6 小时
        const n3 = srv.reqs.length;
        await vm._favSchedRun();
        const r3 = srv.reqs.slice(n3).map(r => r.path).filter(p => /episode/.test(p));
        c = JSON.parse(ls.getItem('donggua_fav_tmdb'));
        ok(r3.filter(p => p.startsWith('/tv/336706/')).join() === '/tv/336706/season/1/episode/21,/tv/336706/season/1/episode/22,/tv/336706/season/1/episode/23' && c.tv['336706'].e === 20,
            'T6 往后几集都还在过去 → 查 ' + S.T.eps + ' 集就停,先存详情的', r3);
        ok(r3.filter(p => p.startsWith('/tv/290699/')).join() === '/tv/290699/season/1/episode/31' && c.tv['290699'].e === 30, 'T6 这季没有更后面的(404)→ 查 1 集就停', r3);
    } finally { Date.now = realNow; }
});

await T(async () => {
    // kick:列表空不排;有列表延迟后跑;日期翻篇
    const srv = tmdbServer({ search: { '甲': [{ id: 1, name: '甲' }] }, tv: { 1: { id: 1, next_episode_to_air: null } } });
    const { vm, ls } = makeVm({ sched: true });
    vm.favToday = '2000-01-01';
    ls.setItem('donggua_fav_tmdb', JSON.stringify({ ids: { '上一个人收藏的剧': { id: 9, ts: Date.now() } }, tv: { 9: { d: '2026-10-09', e: 2, s: 1, c: 2, ts: Date.now() } } }));
    vm.favAir = S.airMap(S.cacheParse(ls.getItem('donggua_fav_tmdb')), Date.now());
    vm._favSchedKick(0);
    ok(vm.favToday === S.localDay(new Date()), 'kick 顺手校正"今天"(过零点后回首页也对)');
    await flush(4);
    ok(srv.reqs.length === 0, '收藏为空:不查');
    ok(ls.getItem('donggua_fav_tmdb') === null && Object.keys(vm.favAir).length === 0, '收藏为空:追更日历缓存(片名表)清掉,不留上一个人的片名(第一轮审查回归)');
    vm.favList = [fav('甲')];
    vm._favSchedKick(0);
    await new Promise(r => setTimeout(r, 40)); await flush();
    ok(srv.reqs.length === 2, '有收藏:延迟后在后台查');
    clearTimeout(vm._favDayTimer);
    // 跑的时候又被踢(比如刚收藏了一部):不并发跑两轮,跑完再补一轮
    const p = vm._favSchedRun();          // 这一轮的计划只有 甲(已缓存)
    vm.favList = [fav('甲'), fav('乙')];
    await vm._favSchedRun();
    ok(vm._favSchedAgain === true && srv.reqs.length === 2, '正在查时再触发:记下,不并发');
    await p; await new Promise(r => setTimeout(r, 1600)); await flush();
    ok(srv.reqs.filter(r => r.query === '乙').length === 1 && srv.reqs.length === 3 && !vm._favSchedBusy && !vm._favSchedAgain, '跑完补的那一轮查了新收藏的');
    clearTimeout(vm._favDayTimer); clearTimeout(vm._favSchedTimer);
});

console.log('⑤ 追更日历:接线');
await T(async () => {
    const sec = HTML.slice(HTML.indexOf('<!-- ⭐ 我的收藏'), HTML.indexOf('<!-- ✨ 为你推荐'));
    ok(/<div class="fav-week" v-if="favSched\.week"/.test(sec) && /v-for="d in favSched\.week"/.test(sec) && /@click="openFavorite\(e\.item\)"/.test(sec), '收藏区有「本周更新」条(没东西整条不渲染),点剧名 = 点卡片');
    ok(sec.indexOf('class="fav-week"') < sec.indexOf('class="scroll-container"') && sec.indexOf('class="section-header"') < sec.indexOf('class="fav-week"'), '条在标题下、收藏行上');
    ok(/<div v-if="favSched\.any" class="fav-sched"[^>]*>\{\{ favSched\.line\[item\.fav_id\] \|\| '' \}\}<\/div>/.test(sec) && sec.indexOf('favSubText(item)') < sec.indexOf('fav-sched'), '卡片副标题下一行');
    ok(/<div v-if="favHasUpdate\(item\)" class="fav-upd-badge">\{\{ favBadgeText\(item\) \}\}<\/div>/.test(sec), '红色角标不动');
    ok(/\n {16}favSched\(\) \{ return DgFavSched\.schedule\(this\.favSorted, this\.favAir, this\.favToday\); \},/.test(HTML), 'computed favSched 只依赖 favSorted/favAir/favToday');
    ok(/favAir: \(function \(\) \{ try \{ return DgFavSched\.airMap\(DgFavSched\.cacheParse\(localStorage\.getItem\('donggua_fav_tmdb'\)\), Date\.now\(\)\); \}/.test(HTML), 'data():favAir 开页从本地缓存来');
    ok(/this\._favOnPlay\(\);\s*\n\s*this\._favSchedKick\(\);/.test(method('loadFavorites').body) && /this\._favSchedKick\(\);/.test(method('_favRefreshMaybe').body), '收藏加载完 / 回首页 → kick');
    const run = method('_favSchedRun').body;
    ok(/tmdbFetch\(/.test(run) && !/[^.]fetch\(/.test(run.replace(/tmdbFetch\(/g, '')) && /runWithConcurrency\(todo, 3,/.test(run), '_favSchedRun:只用 tmdbFetch、并发 3');
    const css = (re) => { const m = re.exec(HTML); return m ? m[1] : ''; };
    const fw = css(/\n {8}\.fav-week \{([^}]*)\}/), fs_ = css(/\n {8}\.fav-sched \{([^}]*)\}/);
    ok(/height: 36px/.test(fw) && /overflow-x: auto/.test(fw) && /white-space: nowrap/.test(fw), '条:固定高度、横向滚动、不换行');
    ok(/white-space: nowrap/.test(fs_) && /text-overflow: ellipsis/.test(fs_) && /min-height/.test(fs_), '卡片那一行:永远一行(省略号)、空着也占高');
});

// ---------- ⑥ 推送默认打开 + 「开启更新提醒？」小卡片 ----------
console.log('⑥ 推送默认打开:浏览器已允许通知 → 启动静默订阅;偏好设置里关过的账号不动');
{
    const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    const realST = setTimeout, realCT = clearTimeout, realNow = Date.now;
    // 真的让出事件循环(setImmediate:Windows 上 setTimeout(0) 有 ~15ms 的计时精度,几百个假定时器会拖慢到分钟级)
    const rflush = async (n) => { for (let i = 0; i < (n || 12); i++) await new Promise(r => setImmediate(r)); };
    // 假时钟:方法里的 setTimeout(排队 400/700ms、自动收起 25s)和 Date.now(14 天冷却、一天内不重试)都由 advance() 推进
    const clock = { now: Date.UTC(2026, 9, 8, 4), q: [], id: 0 };
    globalThis.setTimeout = (f, ms) => { const id = ++clock.id; clock.q.push({ id, f, at: clock.now + (+ms || 0) }); return id; };
    globalThis.clearTimeout = (id) => { clock.q = clock.q.filter(t => t.id !== id); };
    Date.now = () => clock.now;
    const advance = async (ms) => {
        const end = clock.now + ms;
        for (; ;) {
            clock.q.sort((a, b) => a.at - b.at);
            const t = clock.q[0];
            if (!t || t.at > end) break;
            clock.q.shift(); clock.now = t.at; t.f(); await rflush(2);
        }
        clock.now = end; await rflush();
    };
    // 一台假浏览器:o.perm 当前通知权限、o.answer 权限框的回答、o.sub 已有订阅(o.badKey = 用旧公钥订的)、o.subFail 推送服务订阅失败、o.ua
    const penv = (o) => {
        o = o || {};
        clock.q = [];
        const S = { req: 0, subs: 0, unsubs: 0, pushes: [], backs: 0, toastUp: false, focused: [], fullscreen: null, hidden: false, login: false, popup: false, onPop: null };
        let cur = null;
        const mkSub = (ep, opt) => { const s = { endpoint: ep, options: opt || {}, toJSON() { return { endpoint: ep, keys: { p256dh: 'p', auth: 'a' } }; }, unsubscribe: async () => { S.unsubs++; if (cur === s) cur = null; return true; } }; return s; };
        if (o.sub) cur = mkSub('https://fcm.googleapis.com/fcm/send/old', o.badKey ? { applicationServerKey: new Uint8Array(65).buffer } : {});
        const reg = {
            pushManager: {
                getSubscription: async () => cur,
                // o.subWait[i]:第 i+1 次 subscribe 先等这个 promise(new Promise(() => {}) = 推送服务连不上、永远不返回)
                subscribe: async (opt) => { const i = S.subs++; S.subOpt = opt; if (o.subWait && o.subWait[i]) await o.subWait[i]; if (o.subFail) throw new Error('push service unavailable'); cur = mkSub('https://fcm.googleapis.com/fcm/send/n' + S.subs, opt); return cur; }
            }
        };
        Object.defineProperty(globalThis, 'navigator', { value: { userAgent: o.ua || 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', platform: 'Win32', maxTouchPoints: 0, serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg, addEventListener() { } } }, configurable: true, writable: true });
        const N = { permission: o.perm || 'default', requestPermission(cb) { S.req++; const a = o.answer || 'granted'; N.permission = a; if (cb) cb(a); return Promise.resolve(a); } };
        globalThis.Notification = N;
        // history:back() 异步发 popstate,交给页面常驻的 _onHistPop(S.onPop)。
        //   滚动恢复照浏览器的规矩:每条记录有自己的 scrollRestoration(pushState 照抄当前那条),离开一条时记下页面滚动位置 H.y,
        //   退回到 'auto' 的那条时把页面滚回它记下的位置(popstate 之前);E.userBack() = 用户按返回键
        const H = { entries: [{ state: null, sr: 'auto', y: 0 }], idx: 0, y: 0 };
        const traverse = () => { H.entries[H.idx].y = H.y; H.idx--; if (H.entries[H.idx].sr === 'auto') H.y = H.entries[H.idx].y || 0; };
        globalThis.history = {
            get state() { return H.entries[H.idx].state; },
            get scrollRestoration() { return H.entries[H.idx].sr || 'auto'; },
            set scrollRestoration(v) { H.entries[H.idx].sr = v; },
            pushState(s) { const cur = H.entries[H.idx]; cur.y = H.y; H.entries = H.entries.slice(0, H.idx + 1); H.entries.push({ state: s, sr: cur.sr || 'auto', y: H.y }); H.idx++; S.pushes.push(s); },
            back() { S.backs++; if (H.idx > 0) { traverse(); Promise.resolve().then(() => S.onPop && S.onPop()); } },
            replaceState(s) { H.entries[H.idx] = Object.assign({}, H.entries[H.idx], { state: s }); }
        };
        S.userBack = () => { if (H.idx > 0) { traverse(); S.onPop && S.onPop(); } };
        globalThis.location = { pathname: '/', search: '', href: 'https://ednovas.video/' };
        globalThis.document = {
            get hidden() { return S.hidden; }, get fullscreenElement() { return S.fullscreen; }, activeElement: null,
            querySelector: (sel) => ((S.toastUp && /\.dg-mini-toast/.test(sel)) || (S.popup && /#tv-episode-popup/.test(sel))) ? {} : null,
            getElementById: (id) => id === 'password-screen' ? { style: { display: S.login ? 'flex' : 'none' }, classList: { contains: () => false } } : null
        };
        return { S, N, H, sub: () => cur };
    };
    // 一个已登录的页面(默认同步账号 + 站点开着推送);toast 进 toasts 并"挂在 DOM 上"直到 E.S.toastUp = false
    const papp = (E, o) => {
        o = o || {};
        const r = makeVm({ sync: o.sync !== false, token: o.token, push: o.push !== false, store: o.store, noMig: o.noMig });
        const { vm, net, winEv } = r;
        if (o.tok) vm.syncToken = o.tok;
        vm.isNativeApp = !!o.native; vm.isTVMode = !!o.tv;
        globalThis.window.removeEventListener = (t, f) => { winEv[t] = (winEv[t] || []).filter(x => x !== f); };
        vm.showMiniToast = (m) => { r.toasts.push(m); E.S.toastUp = true; };
        vm.syncShareUrl = () => { r.synced = (r.synced || 0) + 1; };
        vm.closeFrameShare = () => { vm.frameShare = { show: false }; };
        E.S.onPop = () => vm._onHistPop();
        // 卡片的假 DOM:「以后再说」「开启」(结果提示时只有「知道了」);focus() 改 document.activeElement
        const btn = (name) => ({ name, focus() { globalThis.document.activeElement = this; E.S.focused.push(name); } });
        const later = btn('以后再说'), on = btn('开启'), gotit = btn('知道了');
        vm.$refs.pushAskBox = {
            contains: (el) => [later, on, gotit].includes(el),
            querySelector: (sel) => vm.pushAsk.msg ? gotit : (/pri/.test(sel) ? on : later),
            querySelectorAll: () => vm.pushAsk.msg ? [gotit] : [later, on]
        };
        net.handler = (url, body) => {
            if (url === '/api/push/key') return { status: 200, json: { enabled: true, publicKey: KEY } };
            if (url === '/api/push/subscribe') return o.srvReject ? { status: 400, json: { ok: false, error: 'endpoint' } } : { status: 200, json: { ok: true } };
            if (url === '/api/favorites/add') return { status: 200, json: { ok: true, fav_id: body.item.name } };
            if (url.startsWith('/api/requests/mine')) return { status: 200, json: { requests: [] } };
            return { status: 200, json: { ok: true } };
        };
        if (o.optOut) vm._pushSetOptOut(true);
        if (o.subscribed) vm.pushSubscribed = true;
        return Object.assign(r, { later, on, gotit });
    };
    const heart = async (r, name, kz) => {
        r.vm.currentGroup = { name: name || '凡人修仙传', pic: '', sources: [{ site_key: kz ? 'kz_qisefan' : 's1', vod_id: 7, site_name: '站1', vod_play_url: pu(12) }] };
        r.vm.currentSource = r.vm.currentGroup.sources[0];
        await r.vm.toggleFavorite();
        await rflush();
    };
    // ♥ → toast 消失 → 等排队的那几下
    const heartAndWait = async (E, r, name, kz) => { await heart(r, name, kz); E.S.toastUp = false; await advance(1500); };
    const ev = (key, target) => ({ key, target: target || {}, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
    const pushReqs = (r) => r.calls.filter(c => /^\/api\/push\/(key|subscribe)/.test(c.url || ''));

    await T(async () => {
        const E = penv({ perm: 'granted' });
        const r = papp(E);
        await r.vm._pushStartupSync(true); await rflush();
        const posts = r.calls.filter(c => c.url === '/api/push/subscribe');
        ok(E.S.subs === 1 && posts.length === 1 && posts[0].body.token === r.vm.syncToken && posts[0].body.subscription.endpoint === 'https://fcm.googleapis.com/fcm/send/n1' && r.vm.pushSubscribed,
            '已允许通知 + 这台设备没订阅:启动时静默订阅(开关同一条流程,POST /api/push/subscribe)');
        ok(E.S.subOpt && E.S.subOpt.userVisibleOnly === true && E.S.subOpt.applicationServerKey instanceof Uint8Array && E.S.subOpt.applicationServerKey.length === 65, '用服务器公钥订阅(userVisibleOnly)');
        ok(E.S.req === 0 && r.toasts.length === 0 && r.vm.pushMsg === '', '静默:不要权限、不弹 toast、开关下面不写字');
        ok(r.ls.getItem('donggua_push_on') === r.vm.syncToken.slice(0, 16), '照样记下账号标记(和手动打开一样)');
        const n = r.calls.length;
        await r.vm._pushStartupSync(true);
        ok(r.calls.length === n, '每页只跑一次');
    });
    await T(async () => {
        // 服务器换了推送密钥:旧订阅退掉后马上用新钥匙订上(以前要用户自己重新打开开关)
        const E = penv({ perm: 'granted', sub: true, badKey: true });
        const r = papp(E);
        r.ls.setItem('donggua_push_on', r.vm.syncToken.slice(0, 16));
        await r.vm._pushStartupSync(true); await rflush();
        ok(E.S.unsubs === 1 && E.S.subs === 1 && r.vm.pushSubscribed && r.vm.pushMsg === '' && E.sub().endpoint === 'https://fcm.googleapis.com/fcm/send/n1',
            '服务器换了推送密钥:退掉旧订阅,默认打开用新钥匙订上(提示清掉)');
    });
    await T(async () => {
        // 偏好设置里亲手关掉 → 记下;下次启动不自动打开;再打开开关 → 清掉
        const E = penv({ perm: 'granted', sub: true });
        const store = new Map();
        const r = papp(E, { store });
        r.ls.setItem('donggua_push_on', r.vm.syncToken.slice(0, 16));
        await r.vm.togglePush({ target: { checked: false } }); await rflush();
        const k = r.vm._pushAcct();
        ok(!r.vm.pushSubscribed && E.sub() === null && store.get('donggua_push_off') === k, '偏好设置里关掉:退订 + 记下这个账号关过(donggua_push_off)');
        ok(/^[0-9a-f]{4}$/.test(k) && !store.get('donggua_push_off').includes(r.vm.syncToken.slice(0, 6)), '关过的记录存账号哈希(退出登录也留着),不存 token 原文');
        const r2 = papp(E, { store });
        await r2.vm._pushStartupSync(true); await rflush();
        ok(E.S.subs === 0 && pushReqs(r2).length === 0 && !r2.vm.pushSubscribed && E.S.req === 0, '关过的账号:下次启动不自动打开');
        await r2.vm.togglePush({ target: { checked: true } }); await rflush();
        ok(r2.vm.pushSubscribed && E.S.subs === 1 && E.S.req === 0 && !store.has('donggua_push_off'), '再打开开关:订上、清掉"关过"(已允许就不再弹权限框)');
        // 退出登录(_pushUnsubscribeAll)不算"关过"
        await r2.vm._pushUnsubscribeAll(r2.vm.syncToken); await rflush();
        ok(!store.has('donggua_push_off'), '退出登录时的退订不算"亲手关掉"');
    });
    await T(async () => {
        // 关过的只是那一个账号:同一台设备上的另一个账号照样默认打开
        const E = penv({ perm: 'granted' });
        const store = new Map();
        const x = papp(E, { store, tok: 'tokX_1111111111111111xx' });
        x.vm._pushSetOptOut(true);
        const y = papp(E, { store, tok: 'tokY_2222222222222222yy' });
        ok(x.vm._pushAcct() !== y.vm._pushAcct(), '(两个账号哈希不同)');
        await y.vm._pushStartupSync(true); await rflush();
        ok(y.vm.pushSubscribed && E.S.subs === 1 && store.get('donggua_push_off') === x.vm._pushAcct(), '"关过"按账号记:另一个账号照样默认打开');
        store.set('donggua_push_off', 'zz,' + x.vm._pushAcct() + ',__proto__');
        ok(x.vm._pushOffList().join() === x.vm._pushAcct() && x.vm._pushOptedOut(), '读"关过"列表只认 4 位十六进制(脏数据忽略)');
    });
    await T(async () => {
        const cases = [
            ['非同步账号', { perm: 'granted' }, { sync: false, token: 'pw_nosync_123456789' }, true],
            ['浏览器拒绝了通知', { perm: 'denied' }, {}, true],
            ['还没问过权限(default)', { perm: 'default' }, {}, true],
            ['安卓 App', { perm: 'granted' }, { native: true }, true],
            ['服务器关了推送', { perm: 'granted' }, {}, false],
            ['站点没开推送', { perm: 'granted' }, { push: false }, true],
        ];
        for (const [name, eo, ao, srv] of cases) {
            const E = penv(eo);
            const r = papp(E, ao);
            await r.vm._pushStartupSync(srv); await rflush();
            ok(E.S.subs === 0 && E.S.req === 0 && pushReqs(r).length === 0 && !r.vm.pushSubscribed, name + ':启动不订阅、不要权限');
        }
        const E = penv({ perm: 'default' });
        const r = papp(E);
        await r.vm.pushSubscribe({ silent: true }); await rflush();
        ok(E.S.req === 0 && E.S.subs === 0 && !r.vm.pushBusy && r.vm.pushMsg === '', '静默订阅碰上还没授权:直接返回,绝不弹权限框(兜底)');
    });
    await T(async () => {
        // 自动开启失败:静默;一天内不再试;过了一天再试
        const E = penv({ perm: 'granted', subFail: true });
        const store = new Map();
        const r = papp(E, { store });
        await r.vm._pushStartupSync(true); await rflush();
        ok(E.S.subs === 1 && !r.vm.pushSubscribed && r.vm.pushMsg === '' && r.toasts.length === 0, '自动开启失败(推送服务订阅不了):静默,不写提示');
        const r2 = papp(E, { store });
        await r2.vm._pushStartupSync(true); await rflush();
        ok(E.S.subs === 1 && pushReqs(r2).length === 0, '失败后一天内再打开页面:不再试');
        clock.now += 25 * 3600e3;
        const r3 = papp(E, { store });
        await r3.vm._pushStartupSync(true); await rflush();
        ok(E.S.subs === 2, '过了一天:再试一次');
        const E2 = penv({ perm: 'granted' });
        const s = papp(E2, { srvReject: true });
        await s.vm._pushStartupSync(true); await rflush();
        ok(E2.S.subs === 1 && E2.sub() === null && !s.vm.pushSubscribed && s.ls.getItem('donggua_push_on') === null && s.vm.pushMsg === '', '服务器拒收:浏览器这边的订阅也撤掉,不留标记、不写提示');
    });
    await T(async () => {
        // 第四轮 T8:推送服务连不上(国内没开代理连不到 FCM)时 subscribe() 一直不返回 —— 以前启动静默那次占着 pushBusy:
        //   偏好设置的开关整个会话都是灰的,一天的退避也记不上,每次打开页面再卡一遍
        const hang = new Promise(() => { });
        const E = penv({ perm: 'granted', subWait: [hang] });
        const store = new Map();
        const r = papp(E, { store });
        const t0 = clock.now;
        const run = r.vm._pushStartupSync(true);
        await rflush();
        ok(E.S.subs === 1 && !r.vm.pushBusy && r.vm._pushAutoBusy === true, 'T8 静默订阅卡住时:不占 pushBusy(开关能按),用自己的 _pushAutoBusy');
        await advance(16000); await Promise.race([run, rflush(50)]);   // 修之前 run 永远不返回:不等它,让后面的断言照常判失败
        const a = JSON.parse(store.get('donggua_push_ask') || '{}').a || {};
        ok(!r.vm._pushAutoBusy && !r.vm.pushSubscribed && a[r.vm._pushAcct()] && a[r.vm._pushAcct()].f === t0 + 15000 && r.vm.pushMsg === '' && r.toasts.length === 0,
            'T8 15 秒没返回 → 算失败:记一天的退避、静默不写字', a);
        const r2 = papp(E, { store });
        await r2.vm._pushStartupSync(true); await rflush();
        ok(E.S.subs === 1, 'T8 退避记上了:再打开页面一天内不再去订阅(以前每次打开都卡一遍)');
        // 手动打开也有时限(30 秒):不会永远「开启中」
        const E3 = penv({ perm: 'granted', subWait: [hang] });
        const r3 = papp(E3);
        const t3 = r3.vm.togglePush({ target: { checked: true } });
        await rflush();
        ok(r3.vm.pushBusy, '(手动打开:途中开关是灰的)');
        await advance(31000); await Promise.race([t3, rflush(50)]);
        ok(!r3.vm.pushBusy && !r3.vm.pushSubscribed && /超时/.test(r3.vm.pushMsg), 'T8 手动打开 30 秒没返回:松开开关、提示超时', r3.vm.pushMsg);
    });
    await T(async () => {
        // T8 静默那次还在途时用户自己点开关:照常订上(以前开关是灰的点不动);之后又关掉 → 晚到的静默那次作废,
        //   不把开关改回"开"、不清"关掉过",它订出来的那条也退掉
        let go;
        const gate = new Promise(x => { go = x; });
        const E = penv({ perm: 'granted', subWait: [gate] });
        const store = new Map();
        const r = papp(E, { store });
        const run = r.vm._pushStartupSync(true);
        await rflush();
        await r.vm.togglePush({ target: { checked: true } }); await rflush();
        ok(r.vm.pushSubscribed && E.S.subs === 2 && !r.vm.pushBusy, 'T8 静默那次卡着时手动打开:照常订上');
        await r.vm.togglePush({ target: { checked: false } }); await rflush();
        ok(!r.vm.pushSubscribed && E.sub() === null && store.get('donggua_push_off') === r.vm._pushAcct(), '(随后手动关掉)');
        go(); await run; await rflush();
        ok(!r.vm.pushSubscribed && E.sub() === null && store.get('donggua_push_off') === r.vm._pushAcct() && !store.has('donggua_push_on') && !r.vm._pushAutoBusy,
            'T8 晚到的静默订阅作废:开关仍是关、"关掉过"还在、它订出来的那条退掉', [r.vm.pushSubscribed, !!E.sub(), store.get('donggua_push_off')]);
    });
    await T(async () => {
        // 第四轮 T11:订阅途中(订上了、还在等服务器回话,donggua_push_on 还没写)打开偏好设置 → _pushRefreshState 把刚订上的
        //   当成"别的账号的"退掉,开关却显示开着、服务器存的是死订阅
        for (const how of ['auto', 'switch']) {
            const E = penv({ perm: 'granted' });
            const r = papp(E);
            let go;
            const gate = new Promise(x => { go = x; });
            const post = r.vm._pushPost.bind(r.vm);
            r.vm._pushPost = (u, b) => (u === '/api/push/subscribe' ? gate.then(() => post(u, b)) : post(u, b));
            const run = how === 'auto' ? r.vm._pushAutoOn() : r.vm.togglePush({ target: { checked: true } });
            await rflush();
            ok(!!E.sub() && E.S.subs === 1, '(' + how + ':已经订上、在等服务器回话)');
            await r.vm._pushRefreshState(); await rflush();   // 偏好设置打开(showSettingsModal 的 watcher)
            go(); await run; await rflush();
            ok(E.S.unsubs === 0 && !!E.sub() && r.vm.pushSubscribed && r.ls.getItem('donggua_push_on') === r.vm.syncToken.slice(0, 16),
                'T11 ' + how + ':订阅途中打开偏好设置不会把刚订上的退掉', [E.S.unsubs, !!E.sub(), r.vm.pushSubscribed]);
        }
    });
    await T(async () => {
        // 第四轮 T9:这版以前在偏好设置里关掉推送只退订、不记"关掉过"(权限还是允许)→ 升级后第一次启动不能悄悄订回去
        const E = penv({ perm: 'granted' });
        const store = new Map();
        const r = papp(E, { store, noMig: true });
        await r.vm._pushStartupSync(true); await rflush();
        ok(E.S.subs === 0 && !r.vm.pushSubscribed && store.get('donggua_push_off') === r.vm._pushAcct() && store.get('donggua_push_mig') === '1',
            'T9 升级后第一次启动:已允许通知、没订阅、没有 donggua_push_on(以前关掉过)→ 记成关掉过,不自动订阅', [E.S.subs, store.get('donggua_push_off')]);
        const r2 = papp(E, { store, noMig: true });
        await r2.vm._pushStartupSync(true); await rflush();
        ok(E.S.subs === 0, 'T9 之后的启动也不自动订阅');
        await r2.vm.togglePush({ target: { checked: true } }); await rflush();
        ok(r2.vm.pushSubscribed && !store.has('donggua_push_off'), 'T9 自己打开开关:照常订上、清掉"关掉过"');
        // 迁移只做一次:之后才出现的"允许了、没订阅"(主动退出再登录)照常默认打开
        await r2.vm._pushUnsubscribeAll(r2.vm.syncToken); await rflush();
        const r3 = papp(E, { store, noMig: true });
        await r3.vm._pushStartupSync(true); await rflush();
        ok(r3.vm.pushSubscribed && E.S.subs === 2, 'T9 迁移只做一次:之后退出再登录 → 照常默认打开');
        // 有订阅 / 有 donggua_push_on(服务器换过密钥,旧版留着标记)/ 还没问过权限:不算关掉过
        const E2 = penv({ perm: 'granted', sub: true });
        const s2 = new Map([['donggua_push_on', 'tok_abcdef012345']]);
        const q2 = papp(E2, { store: s2, noMig: true });
        await q2.vm._pushStartupSync(true); await rflush();
        ok(!s2.has('donggua_push_off') && s2.get('donggua_push_mig') === '1' && q2.vm.pushSubscribed, 'T9 有订阅的(开着的)不受影响');
        const E3 = penv({ perm: 'granted' });
        const s3 = new Map([['donggua_push_on', 'tok_abcdef012345']]);
        const q3 = papp(E3, { store: s3, noMig: true });
        await q3.vm._pushStartupSync(true); await rflush();
        ok(!s3.has('donggua_push_off') && q3.vm.pushSubscribed && E3.S.subs === 1, 'T9 有 donggua_push_on 没订阅(旧版换密钥后的样子)→ 不算关掉过,默认打开');
        const E4 = penv({ perm: 'default' });
        const s4 = new Map();
        const q4 = papp(E4, { store: s4, noMig: true });
        await q4.vm._pushStartupSync(true); await rflush();
        ok(!s4.has('donggua_push_off') && s4.get('donggua_push_mig') === '1', 'T9 还没问过权限的:不记关掉过(之后照常软提示)');
        // 没登录不知道记给谁:这次不迁移
        const q5 = papp(penv({ perm: 'granted' }), { store: new Map(), noMig: true, sync: false, token: '' });
        q5.vm._pushMigrate(false);
        ok(!q5.ls.getItem('donggua_push_mig') && !q5.ls.getItem('donggua_push_off'), 'T9 没登录:不迁移(下次登录后再看)');
    });

    console.log('⑥ 「开启更新提醒？」小卡片:♥ / 求片后、等 toast 和弹窗都没了才弹;次数/冷却/拒绝;开启只走一次订阅流程');
    await T(async () => {
        const E = penv({ perm: 'default' });
        const r = papp(E);
        await heart(r);
        ok(r.toasts.length === 1 && r.toasts[0] === '❤️ 已收藏，有更新会在首页「我的收藏」提醒', '♥ 成功:toast 不再提"去偏好设置开"(马上要问)');
        ok(!r.vm.pushAsk.show, '♥ 后不立刻弹(先让 toast 显示)');
        await advance(3000);
        ok(!r.vm.pushAsk.show, 'toast 还在:等,不叠在一起');
        E.S.toastUp = false; await advance(800);
        ok(r.vm.pushAsk.show && r.vm.pushAsk.kind === 'fav' && r.vm.pushAsk.msg === '', 'toast 消失后弹「开启更新提醒？」卡片(kind=fav)');
        const a = JSON.parse(r.ls.getItem('donggua_push_ask')).a[r.vm._pushAcct()];
        ok(a.n === 1 && a.u > clock.now + 13.9 * 864e5, '弹出就记一次 + 先记 14 天冷却(不理它/刷新也不马上再问)');
        ok(E.S.pushes.length === 1 && E.S.pushes[0].dgPushAsk === r.vm._pushAskHistId && (r.winEv.keydown || []).length === 1, '压一条带卡片 id 的历史(返回键关)+ 挂按键监听');
        ok(E.S.req === 0 && E.S.focused.length === 0, '弹卡片不要浏览器权限;不是 TV:不抢焦点');
        // 点按钮关、退历史那一下落地:按当前集对齐地址栏(卡片开着时可能换了集)
        r.vm.showDetail = true;
        r.vm.pushAskLater(); await rflush();
        ok(!r.vm.pushAsk.show && E.S.backs === 1 && E.H.idx === 0 && (r.winEv.keydown || []).length === 0 && r.synced === 1 && !r.vm._pushAskBack,
            '以后再说:关卡片、退掉自己压的那条历史(落地按当前集写回地址栏)、摘掉按键监听');
        await heartAndWait(E, r, '庆余年');
        ok(!r.vm.pushAsk.show, '同一页再 ♥ 一部:不再问(每页只问一次)');
        // 自动收起:25 秒没理 = 以后再说;被别的弹窗盖着时不收
        const r2 = papp(E);
        await heartAndWait(E, r2);
        ok(r2.vm.pushAsk.show, '(新页面又弹了一张:新账号存储)');
        r2.vm.showSettingsModal = true;
        ok(r2.vm._pushAskCoveredNow(), '偏好设置盖上来:卡片藏起来(v-show)');
        await advance(30000);
        ok(r2.vm.pushAsk.show, '被盖着:不自动收起');
        r2.vm.showSettingsModal = false; await advance(6000);
        ok(!r2.vm.pushAsk.show && E.S.backs === 2, '盖着的弹窗关了:过一会儿自动收起(= 以后再说,退掉历史)');
    });
    await T(async () => {
        // 以后再说 = 14 天;每个账号最多 3 次;次数按账号分
        const E = penv({ perm: 'default' });
        const store = new Map();
        const page = async (tok) => { const r = papp(E, { store, tok }); await heartAndWait(E, r); return r; };
        let r = await page();
        ok(r.vm.pushAsk.show, '第 1 次:弹');
        r.vm.pushAskLater(); await rflush();
        clock.now += 13 * 864e5;
        r = await page();
        ok(!r.vm.pushAsk.show && /偏好设置里可开启/.test(r.toasts[0]), '14 天内:新页面 ♥ 也不弹(toast 照旧提偏好设置)');
        clock.now += 2 * 864e5;
        r = await page();
        ok(r.vm.pushAsk.show, '过了 14 天:第 2 次');
        r.vm.pushAskLater(); await rflush();
        clock.now += 15 * 864e5;
        r = await page();
        ok(r.vm.pushAsk.show, '第 3 次');
        r.vm.pushAskLater(); await rflush();
        clock.now += 60 * 864e5;
        r = await page();
        ok(!r.vm.pushAsk.show && JSON.parse(store.get('donggua_push_ask')).a[r.vm._pushAcct()].n === 3, '每个账号最多问 3 次');
        const o = await page('tokZ_3333333333333333zz');
        ok(o.vm.pushAsk.show, '另一个账号:次数分开算');
        store.set('donggua_push_ask', JSON.stringify({ a: { __proto__x: { n: 9 }, constructor: { n: 9 }, abcd: { n: 'x', u: 'y' } } }));
        const st = r.vm._pushAskLoad();
        ok(Object.getPrototypeOf(st.a) === null && Object.keys(st.a).join() === 'abcd' && st.a.abcd.n === 0 && st.d === 0, '存储里的脏数据:只认 4 位十六进制账号键、数字字段(无原型对象)');
    });
    await T(async () => {
        // Esc / 手机返回键 / 截帧弹窗叠在上面
        const E = penv({ perm: 'default' });
        let r = papp(E);
        await heartAndWait(E, r);
        let e = ev('Escape');
        r.winEv.keydown[0](e); await rflush();
        ok(!r.vm.pushAsk.show && e.prevented && e.stopped && E.S.backs === 1, 'Esc:关卡片(= 以后再说),Esc 不再往下传');
        r = papp(E);
        await heartAndWait(E, r);
        const b0 = E.S.backs;
        E.H.idx--; r.vm._onHistPop(); await rflush();
        ok(!r.vm.pushAsk.show && E.S.backs === b0 && JSON.parse(r.ls.getItem('donggua_push_ask')).a[r.vm._pushAcct()].n === 1, '手机返回键(退到卡片那条下面):关卡片,不再多退一步');
        r = papp(E);
        await heartAndWait(E, r);
        r.vm.frameShare = { show: true };
        history.pushState(Object.assign({}, history.state, { dgFrameShare: 1 }), '');   // 截帧弹窗压的那条抄了卡片的 id
        e = ev('Escape');
        r.winEv.keydown[0](e);
        ok(r.vm.pushAsk.show && !e.stopped, '截帧弹窗叠在上面:Esc 不归卡片(交给弹窗)');
        E.H.idx--; r.vm._onHistPop(); await rflush();
        ok(!r.vm.frameShare.show && r.vm.pushAsk.show, '返回键:只关截帧弹窗(落在卡片自己那条上),卡片还在');
        E.H.idx--; r.vm._onHistPop(); await rflush();
        ok(!r.vm.pushAsk.show, '再按返回:关卡片');
        // 截帧弹窗还叠在上面时卡片被关掉(程序关):不退历史 —— 退掉的会是弹窗那条
        r = papp(E);
        await heartAndWait(E, r);
        r.vm.frameShare = { show: true };
        history.pushState(Object.assign({}, history.state, { dgFrameShare: 1 }), '');
        const b1 = E.S.backs, i1 = E.H.idx;
        r.vm.closePushAsk(); await rflush();
        ok(!r.vm.pushAsk.show && E.S.backs === b1 && E.H.idx === i1 && r.vm.frameShare.show, '截帧弹窗叠在上面时关卡片:不 history.back()(否则退掉的是弹窗那条)');
        // 刷新留下的旧记录(id 对不上)不算卡片自己那条
        r = papp(E);
        E.H.entries = [{ state: null }, { state: { dgPushAsk: 12345 } }]; E.H.idx = 1;
        await heartAndWait(E, r);
        E.H.idx--; r.vm._onHistPop(); await rflush();
        ok(!r.vm.pushAsk.show, '刷新留下的旧卡片记录:id 对不上,退到那条照样关卡片');
    });
    await T(async () => {
        // 第三轮 P1:卡片不挡页面,首页/搜索结果整页滚动 —— 卡片弹出时在 300,用户接着翻到 2000,卡片关掉(以后再说/Esc/自动收起/
        //   开启成功/返回键)时退回压卡片之前那条:滚动恢复是 'auto' 的话浏览器把页面滚回 300(审查实锤)
        const E = penv({ perm: 'default' });
        let r = papp(E);
        E.H.y = 300;
        await heartAndWait(E, r);
        ok(r.vm.pushAsk.show && E.H.entries[0].sr === 'manual' && history.scrollRestoration === 'manual', '压卡片那条之前,把下面那条的滚动恢复改成手动(新压的照抄)');
        E.H.y = 2000;
        r.vm.pushAskLater(); await rflush();
        ok(!r.vm.pushAsk.show && E.H.idx === 0 && E.H.y === 2000, '以后再说(history.back()):页面停在 2000,不跳回卡片弹出时的 300');
        ok(history.scrollRestoration === 'auto' && r.vm._pushAskSR == null, '退回到下面那条后滚动恢复改回 auto(刷新/跨页面前进后退照旧恢复滚动)');
        // 用户按返回键关卡片
        r = papp(E);
        E.H.y = 500;
        await heartAndWait(E, r);
        E.H.y = 4000;
        E.S.userBack(); await rflush();
        ok(!r.vm.pushAsk.show && E.H.y === 4000 && history.scrollRestoration === 'auto', '返回键关卡片:页面也不动,之后滚动恢复改回 auto');
        // 自动收起(25s)
        r = papp(E);
        E.H.y = 100;
        await heartAndWait(E, r);
        E.H.y = 1500;
        await advance(26000);
        ok(!r.vm.pushAsk.show && E.H.y === 1500 && history.scrollRestoration === 'auto', '25 秒自动收起:页面不动');
        // 截帧弹窗叠在卡片上(它那条抄了 manual):关弹窗落在卡片那条上 → 还不改回;再退一条才改回
        r = papp(E);
        await heartAndWait(E, r);
        r.vm.frameShare = { show: true };
        history.pushState(Object.assign({}, history.state, { dgFrameShare: 1 }), '');
        E.S.userBack(); await rflush();
        ok(r.vm.pushAsk.show && history.scrollRestoration === 'manual', '截帧弹窗关掉、落在卡片那条:还是 manual');
        E.S.userBack(); await rflush();
        ok(!r.vm.pushAsk.show && history.scrollRestoration === 'auto', '再按返回关卡片:改回 auto');
        // 卡片开着时刷新:它那条的 manual 在启动时改回 auto
        E.H.entries = [{ state: null, sr: 'manual' }, { state: { dgPushAsk: 99 }, sr: 'manual' }]; E.H.idx = 1;
        r = papp(E);
        r.vm._histBoot();
        ok(history.scrollRestoration === 'auto', '刷新留下的卡片那条:启动时滚动恢复改回 auto');
    });
    await T(async () => {
        // 第三轮 P2:卡片被别的弹窗盖着(看不见)时按返回 —— 以前关掉的是看不见的卡片(还记了一次"以后再说"),弹窗不动,
        //   这一下返回像没反应,再按一下就离开了网站。现在:关看得见的弹窗,卡片露出来,把它那条历史压回去
        for (const k of ['showSharePanel', 'showSettingsModal', 'showRequestModal', 'showInfoModal']) {
            const E = penv({ perm: 'default' });
            const r = papp(E);
            await heartAndWait(E, r);
            const ask0 = r.ls.getItem('donggua_push_ask');
            r.vm[k] = true;
            ok(r.vm._pushAskCoveredNow(), k + ' 开着:卡片被盖住');
            const n = E.H.entries.length;
            E.S.userBack(); await rflush();
            ok(!r.vm[k] && r.vm.pushAsk.show && history.state && history.state.dgPushAsk === r.vm._pushAskHistId && E.H.entries.length === n && r.ls.getItem('donggua_push_ask') === ask0,
                k + ':返回键关掉这个弹窗,卡片留着(不记"以后再说"),它那条历史压回去');
            E.S.userBack(); await rflush();
            ok(!r.vm.pushAsk.show && E.H.idx === 0, k + ':再按返回才关卡片');
        }
        // 被封禁的遮罩关不掉:返回照旧关卡片
        const E = penv({ perm: 'default' });
        const r = papp(E);
        await heartAndWait(E, r);
        r.vm.userBanned = true;
        E.S.userBack(); await rflush();
        ok(!r.vm.pushAsk.show, '封禁遮罩(关不掉)盖着:返回照旧关卡片');
        // 第四轮 T10:离线缓存面板是选集区里的一块(position:static),不是盖在页面上的浮层 —— 以前也当成"盖住了":
        //   点开离线缓存卡片就消失、Esc 不管用、返回键去收起一个看不见的面板
        {
            const E = penv({ perm: 'default' });
            const r = papp(E);
            await heartAndWait(E, r);
            r.vm.showOfflinePanel = true;
            ok(!r.vm._pushAskCoveredNow() && !r.vm._pushAskBlocked(), 'T10 离线缓存面板开着:卡片不算被盖住(照常显示)');
            const k = ev('Escape');
            r.vm._pushAskKey(k);
            ok(!r.vm.pushAsk.show && k.prevented, 'T10 离线缓存面板开着:Esc 照常关卡片');
        }
        {
            const E = penv({ perm: 'default' });
            const r = papp(E);
            await heartAndWait(E, r);
            r.vm.showOfflinePanel = true;
            E.S.userBack(); await rflush();
            ok(!r.vm.pushAsk.show && r.vm.showOfflinePanel, 'T10 离线缓存面板开着:返回键关的是卡片,面板不动');
        }
    });
    await T(async () => {
        // 第三轮 P3:卡片藏在偏好设置后面,用户在偏好设置里打开开关、浏览器回答"拒绝"或权限框被直接关掉 →
        //   以前只有订阅成功才收卡片,关掉偏好设置后卡片又露出来问一遍
        for (const answer of ['denied', 'default']) {
            const E = penv({ perm: 'default', answer });
            const r = papp(E);
            await heartAndWait(E, r);
            r.vm.showSettingsModal = true;
            await r.vm.togglePush({ target: { checked: true } }); await rflush();
            ok(!r.vm.pushSubscribed && !r.vm.pushAsk.show && E.S.req === 1 && E.H.idx === 0, '偏好设置里打开、浏览器回答 ' + answer + ':藏在后面的卡片也收掉(退掉它那条)', r.vm.pushAsk);
            r.vm.showSettingsModal = false;
            ok(!r.vm.pushAsk.show && r.vm.showSettingsModal === false, answer + ':关掉偏好设置后卡片不再出现');
        }
    });
    await T(async () => {
        // TV 模式:焦点给「开启」,←/→ 在两个按钮间移动,空格只给按钮;关掉后焦点回原处;TV 返回键在 TV 监听里先截
        const E = penv({ perm: 'default' });
        const r = papp(E, { tv: true });
        const prev = { name: 'heart', isConnected: true, focus() { globalThis.document.activeElement = this; } };
        globalThis.document.activeElement = prev;
        await heartAndWait(E, r);
        ok(r.vm.pushAsk.show && globalThis.document.activeElement === r.on, 'TV 模式:焦点直接给「开启」(遥控器够得着)');
        let e = ev('ArrowLeft');
        r.winEv.keydown[0](e);
        ok(globalThis.document.activeElement === r.later && e.prevented && e.stopped, '←:焦点到「以后再说」');
        e = ev('ArrowRight');
        r.winEv.keydown[0](e);
        ok(globalThis.document.activeElement === r.on, '→:回到「开启」');
        e = ev(' ');
        r.winEv.keydown[0](e);
        ok(e.stopped && !e.prevented, '焦点在卡片按钮上:空格只给按钮(不传给页面空格暂停/DPlayer,也不拦按钮自己的点击)');
        globalThis.document.activeElement = prev;
        e = ev(' ');
        r.winEv.keydown[0](e);
        ok(!e.stopped && !e.prevented, '焦点不在卡片上:按键照常给页面(卡片不挡页面)');
        globalThis.document.activeElement = r.on;
        r.vm.pushAskLater(); await rflush();
        ok(globalThis.document.activeElement === prev, '关掉后焦点回到原来的元素');
        const tvH = HTML.slice(HTML.indexOf('// 📸 截帧分享弹窗开着(它是最上面一层):TV 返回键只关弹窗'), HTML.indexOf('// TV 模式全局返回键处理'));
        ok(/self\.isTVMode && self\.pushAsk && self\.pushAsk\.show && !self\._pushAskCoveredNow\(\)/.test(tvH) && /'GoBack'/.test(tvH) && /'BrowserBack'/.test(tvH)
            && /e\.key === 'Backspace' && !\(e\.target/.test(tvH) && /self\.pushAskLater\(\);\s*\n\s*return;/.test(tvH),
            'TV 返回键监听(比卡片的监听先跑):先关卡片、不关播放页;输入框里的 Backspace 不算');
    });
    await T(async () => {
        // 「开启」:点击的同一调用栈里要权限;整条订阅流程只走一次(连点也一次)
        const E = penv({ perm: 'default', answer: 'granted' });
        const r = papp(E);
        await heartAndWait(E, r);
        const p = r.vm.pushAskEnable();
        ok(E.S.req === 1, '「开启」:同步调用里就要了浏览器权限(之前没有 await,Safari 才认是用户点击)');
        r.vm.pushAskEnable();
        await p; await rflush();
        const posts = r.calls.filter(c => c.url === '/api/push/subscribe');
        ok(E.S.req === 1 && E.S.subs === 1 && posts.length === 1 && posts[0].body.token === r.vm.syncToken && r.vm.pushSubscribed, '订阅流程只走一次(连点也一次):权限 1 次、订阅 1 次、上报 1 次');
        ok(!r.vm.pushAsk.show && r.toasts.includes('🔔 已开启更新提醒推送') && E.S.backs === 1, '成功:收起卡片(退掉历史)+ 原来的「已开启」toast');
        ok(!r.vm._pushAskEligible() && r.ls.getItem('donggua_push_on') === r.vm.syncToken.slice(0, 16), '开了之后不再问;账号标记照记');
    });
    await T(async () => {
        // 卡片开着时用户去偏好设置里直接打开了开关:卡片收掉(不会在弹窗关掉后又露出来问一遍)
        const E = penv({ perm: 'default', answer: 'granted' });
        const r = papp(E);
        await heartAndWait(E, r);
        r.vm.showSettingsModal = true;
        await r.vm.togglePush({ target: { checked: true } }); await rflush();
        ok(r.vm.pushSubscribed && !r.vm.pushAsk.show && E.S.req === 1 && E.S.backs === 1, '偏好设置里打开了:藏在后面的卡片收掉(退掉它的历史)');
    });
    await T(async () => {
        // 浏览器回答"拒绝":卡片上留原来那句提示(只这一次),以后再也不问
        const E = penv({ perm: 'default', answer: 'denied' });
        const store = new Map();
        const r = papp(E, { store, tv: true });
        await heartAndWait(E, r);
        await r.vm.pushAskEnable(); await rflush();
        ok(r.vm.pushAsk.show && r.vm.pushAsk.msg === '通知权限已被拒绝：请在浏览器或系统设置里允许本站通知后再打开' && globalThis.document.activeElement === r.gotit,
            '浏览器回答"拒绝":卡片上显示开关原来那句提示(TV 焦点到「知道了」)');
        ok(JSON.parse(store.get('donggua_push_ask')).d === 1 && E.S.subs === 0, '记下"拒绝过",不订阅');
        r.vm.closePushAsk(); await rflush();
        ok(!r.vm.pushAsk.show, '「知道了」关掉');
        E.N.permission = 'default';   // 用户后来在浏览器设置里把权限重置了
        clock.now += 100 * 864e5;
        const r2 = papp(E, { store });
        await heartAndWait(E, r2);
        ok(!r2.vm.pushAsk.show && E.S.req === 1, '拒绝过:以后再也不弹(权限被重置成 default 也不弹)');
        // 权限框被直接关掉(仍是 default):收起卡片,冷却中,不算拒绝
        const E3 = penv({ perm: 'default', answer: 'default' });
        const r3 = papp(E3);
        await heartAndWait(E3, r3);
        await r3.vm.pushAskEnable(); await rflush();
        ok(!r3.vm.pushAsk.show && !JSON.parse(r3.ls.getItem('donggua_push_ask')).d && !r3.vm._pushAskEligible() && E3.S.subs === 0, '权限框被关掉(仍 default):收起卡片,14 天冷却,不算拒绝');
    });
    await T(async () => {
        // 求片:提交成功后等求片弹窗关掉才弹「求片有结果时通知你？」
        const E = penv({ perm: 'default' });
        const r = papp(E);
        r.vm.showRequestModal = true;
        r.vm.reqForm = { name: '沙丘', aka: '', year: '', cast: '', note: '' };
        await r.vm.submitRequest(); await rflush();
        ok(r.calls.some(c => c.url === '/api/requests' && c.body.name === '沙丘') && r.toasts.some(t => /求片已提交/.test(t)), '求片提交成功(原流程)');
        E.S.toastUp = false; await advance(5 * 60000);
        ok(!r.vm.pushAsk.show, '求片弹窗还开着(5 分钟):不叠在上面,接着等');
        r.vm.showRequestModal = false; await advance(800);
        ok(r.vm.pushAsk.show && r.vm.pushAsk.kind === 'req', '求片弹窗关掉后弹「求片有结果时通知你？」(kind=req)');
        r.vm.pushAskLater(); await rflush();
        r.vm.reqForm = { name: '沙丘2', aka: '', year: '', cast: '', note: '' };
        await r.vm.submitRequest(); await advance(2000);
        ok(!r.vm.pushAsk.show, '同一页再求片:不再问');
        // 提交失败不问
        const E2 = penv({ perm: 'default' });
        const f = papp(E2);
        f.net.handler = () => ({ status: 200, json: { ok: false, error: 'x' } });
        globalThis.alert = () => { };
        f.vm.reqForm = { name: '沙丘', aka: '', year: '', cast: '', note: '' };
        await f.vm.submitRequest(); await advance(2000);
        ok(!f.vm.pushAsk.show && !f.vm._pushAskWait, '求片提交失败:不问');
        delete globalThis.alert;
    });
    await T(async () => {
        // 不弹的情形
        const cases = [
            ['iPhone Safari 没添加到主屏幕(ios-hint)', { perm: 'default', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' }, {}],
            ['非同步账号', { perm: 'default' }, { sync: false, token: 'pw_nosync_123456789' }],
            ['安卓 App', { perm: 'default' }, { native: true }],
            ['已允许通知(启动时已默认打开)', { perm: 'granted' }, {}],
            ['已拒绝通知', { perm: 'denied' }, {}],
            ['偏好设置里亲手关过', { perm: 'default' }, { optOut: true }],
            ['已订阅', { perm: 'default' }, { subscribed: true }],
            ['站点没开推送', { perm: 'default' }, { push: false }],
        ];
        for (const [name, eo, ao] of cases) {
            const E = penv(eo);
            const r = papp(E, ao);
            await heartAndWait(E, r);
            ok(!r.vm.pushAsk.show && E.S.req === 0 && r.ls.getItem('donggua_push_ask') === null && r.vm.favList.length === 1, name + ':♥ 照常收藏,不弹卡片');
        }
        const E = penv({ perm: 'default' });
        const r = papp(E);
        await heartAndWait(E, r, '某番', true);
        ok(!r.vm.pushAsk.show && r.toasts[0] === '❤️ 已收藏（该线路不支持更新提醒）', '番剧 kz_* 线路(查不了更新):不问');
    });
    await T(async () => {
        // 一直被挡着超过时限:这次不问、不记次数;各种"挡着"
        const E = penv({ perm: 'default' });
        const r = papp(E);
        r.vm.frameShare = { show: true };
        await heartAndWait(E, r);
        await advance(4 * 60000);
        ok(!r.vm.pushAsk.show && r.ls.getItem('donggua_push_ask') === null && !r.vm._pushAskWait, '截帧弹窗一直开着超过 3 分钟:这次不问,不记次数');
        r.vm.frameShare = { show: false }; await advance(3000);
        ok(!r.vm.pushAsk.show, '放弃之后不会再冒出来');
        await heartAndWait(E, r, '庆余年');
        ok(!r.vm.pushAsk.show && !r.vm._pushAskWait, '放弃之后同一页再 ♥:也不再排(每页每种只排一次)');
        const blocked = (set, unset, name) => { set(); const b = r.vm._pushAskBlocked(); unset(); ok(b, name); };
        blocked(() => { E.S.hidden = true; }, () => { E.S.hidden = false; }, '标签页在后台:等');
        blocked(() => { E.S.fullscreen = {}; }, () => { E.S.fullscreen = null; }, '浏览器真全屏(body 上的卡片看不见):等');
        blocked(() => { E.S.login = true; }, () => { E.S.login = false; }, '登录浮层开着:等');
        blocked(() => { E.S.popup = true; }, () => { E.S.popup = false; }, 'TV 选集框开着:等');
        blocked(() => { E.S.toastUp = true; }, () => { E.S.toastUp = false; }, 'toast 还在:等');
        blocked(() => { r.vm.showSharePanel = true; }, () => { r.vm.showSharePanel = false; }, '分享面板开着:等');
        blocked(() => { r.vm.pushBusy = true; }, () => { r.vm.pushBusy = false; }, '正在开关推送:等');
        ok(!r.vm._pushAskBlocked(), '什么都没有:不挡');
    });
    await T(async () => {
        // 接线
        const tpl = HTML.slice(HTML.indexOf('<!-- 🔔 「开启更新提醒？」小卡片'), HTML.indexOf('<!-- 🚫 被封禁锁屏'));
        ok(/<teleport to="body">/.test(tpl) && /v-if="pushAsk\.show" v-show="!pushAskCovered" class="pask" ref="pushAskBox"/.test(tpl), '模板:teleport 到 body;v-if 开关 + 被别的弹窗盖住时 v-show 藏起来');
        ok(tpl.includes("'求片有结果时通知你？'") && tpl.includes("'开启更新提醒？新集一出就通知你'") && /@click="pushAskLater\(\)">以后再说</.test(tpl)
            && /class="pri"[^>]*@click="pushAskEnable\(\)"/.test(tpl) && /@click="closePushAsk\(\)">知道了</.test(tpl), '模板:两种文案、以后再说 / 开启 / 知道了');
        ok(!/:disabled="pushBusy"/.test(tpl), '「开启」不用 disabled(禁用会把 TV 焦点弄丢,防连点靠 pushBusy)');
        ok(/\n {16}pushAskCovered\(\) \{ return this\._pushAskCoveredNow\(\); \},/.test(HTML), 'computed pushAskCovered');
        ok(/pushAsk: \{ show: false, kind: '', msg: '' \},/.test(HTML), 'data():pushAsk 整个对象替换');
        ok(/t\.className = 'dg-mini-toast';/.test(method('showMiniToast').body), 'toast 带 dg-mini-toast 类(卡片等它消失)');
        ok(/this\._pushAskBack && Date\.now\(\) - this\._pushAskBack < 1500\) return;/.test(method('shareFrame').body), '截帧:卡片刚关、退历史还没落地时不开(否则落地会退掉弹窗那条)');
        ok(/this\._pushAskQueue\('fav'\)/.test(method('toggleFavorite').body) && /this\._pushAskQueue\('req'\)/.test(method('submitRequest').body), '♥ / 求片成功后排队');
        const css = (re) => { const m = re.exec(HTML); return m ? m[0] : ''; };
        ok(/z-index: 2147483400/.test(css(/\n {8}\.pask \{[^}]*\}/)) && /\.pask \{ left: 16px; right: 72px;/.test(HTML), '样式:层级低于分享面板/截帧弹窗/toast;手机贴底、给右边的 ⚙ 让位');
        ok(!/requestPermission/.test(method('_pushStartupSync').body + method('_pushAutoOn').body + method('_pushAskQueue').body + method('_pushAskShow').body),
            '启动 / 排队 / 弹卡片的路上都不要浏览器权限(只有点「开启」/ 开关才要)');
    });

    globalThis.setTimeout = realST; globalThis.clearTimeout = realCT; Date.now = realNow;
    delete globalThis.history; delete globalThis.document; delete globalThis.location;
    restoreNav();
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
