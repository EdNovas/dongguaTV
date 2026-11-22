#!/usr/bin/env node
// [adult] 成人站前端回归(离线、零网络):node scripts/adult-frontend-test.mjs
//  ① public/adult/adult.js 纯函数:分类(与 lib/adult 的 17 个导航桶一一对应)/浏览地址(参数与服务器白名单一致)/首页行/
//     卡片映射/作品 → 线路/搜索并组键/横版封面/海报回退/今日数
//  ② fetch 包装:同源 /api 带 x-dg-token;内容接口 401(AUTH_REQUIRED)→ 补核验一次 → 重试;还 401 → 登录框;
//     年龄确认之前内容请求挂起;跨域与非内容接口不动
//  ③ lib/history-slim 与前端 _slimHistoryItem 都保留 _wk(没有时输出逐字不变)
//  ④ 在沙箱里跑 index.html 主脚本两遍(成人 / 非成人):mixin 接上且方法名不与主组件重名、DgCatalog 换成目录版、
//     首页行起步为空、按 _wk 并组、浏览页走 /api/catalog/browse、openWork(≥2 线路立刻开 / 不足 2 条加载帧 + expand)、
//     refreshSources 按作品键取线路不按片名重搜、海报回退不查 TMDB、TMDB 请求根本不发
//  ⑤ 模板/页面接线(年龄门在最前、标题/robots、不再有 OG/canonical、设置行/分享按钮隐藏)与 sw.js(升版、预缓存 adult.js、
//     海报和内容接口不进缓存);phase 2 的模板接线 + 整个 #app 模板交给 Vue 编译器编一遍
//  ⑥ phase 2:浏览标签(tag 参数 / featured 才做按钮)、搜索建议(200ms、回车 exact / alias / blocked、方向键)、热门行来源角标、
//     作品信息条(_meta)、线路家族(+N 备用、换源先试同家)/ 失效垫底 / risky / 同源 / 中字原版、线路反馈(beacon)、
//     refreshSources 保留成人字段、补拉 _meta、购买地址(purchase_url)、模糊封面。后端接口全部用桩
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise(r => setImmediate(r));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 假 localStorage(adult.js 在 require 时就绑定了 globalThis,存储每次现读)
const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const A = require(path.join(ROOT, 'public/adult/adult.js'));
const X = require(path.join(ROOT, 'lib/adult'));
const { slimHistoryItem } = require(path.join(ROOT, 'lib/history-slim'));

console.log('① adult.js 纯函数');
{
    ok(A.ON === true && typeof A.mixin === 'object' && typeof A.catalog === 'object', '导出 ON / mixin / catalog');
    // 分类:与 lib/adult 的导航桶完全一致,每个桶恰好落在一个大类里
    const nav = X.taxonomy.NAV_BUCKETS.slice().sort();
    ok(eq(A.NAV_BUCKETS.slice().sort(), nav), '17 个导航桶与 lib/adult/taxonomy 一致', A.NAV_BUCKETS);
    const inTypes = A.TYPES.flatMap(T => T.buckets.map(b => b[0]));
    ok(eq(inTypes.slice().sort(), nav) && new Set(inTypes).size === inTypes.length, '每个导航桶恰好在一个大类(国产/日本/欧美/动漫/更多)里', inTypes);
    const lab = Object.fromEntries(X.taxonomy.BUCKETS.map(b => [b.id, b.label]));
    ok(A.NAV_BUCKETS.every(b => A.BUCKET_LABEL[b] === lab[b]), '桶名与服务器 taxonomy 的 label 一致(服务器没给 /buckets 时的兜底)');
    ok(eq(A.TYPES.map(t => t.k), ['cn', 'jp', 'west', 'anime', 'more', 'all']), '大类顺序:国产 · 日本 · 欧美 · 动漫 · 更多 · 全部');
    ok(eq(A.TYPES[0].buckets.map(b => b[1]), ['自拍', '传媒', '探花', '网红', '主播', '短视频']) && eq(A.TYPES[1].buckets.map(b => b[1]), ['有码', '无码', '中字']), '国产 / 日本 的标签(规格 §4)');
    const C = A.catalog;
    ok(C.ADULT === true && C.DEFAULT_TYPE === 'cn' && C.typeOf('cn') && !C.typeOf('tv'), '目录版 DgCatalog:默认大类 cn,没有 TMDB 的 tv');
    // normSel
    ok(eq(C.normSel('cn', {}), { b: 'cn_amateur', dur: '', flag: '', sort: 'new' }), 'normSel:大类默认第一个桶、新上架');
    ok(eq(C.normSel('jp', { b: 'cn_amateur', dur: 'x', flag: 'zh', sort: 'hot' }), { b: 'jp_censored', dur: '', flag: 'zh', sort: 'new' }), 'normSel:别的大类的桶/不认识的值 → 默认');
    ok(eq(C.normSel('all', { b: 'jp_subbed', sort: 'random' }), { b: '', dur: '', flag: '', sort: 'random' }), 'normSel:「全部」不带桶');
    ok(eq(C.normSel('nope', { b: 'jp_subbed' }), { b: 'cn_amateur', dur: '', flag: '', sort: 'new' }), 'normSel:不认识的大类按第一个');
    // buildQuery:只给地址,参数与 lib/adult-gate 的 browseQuery 白名单一致
    const q = C.buildQuery('jp', { b: 'jp_uncensored', dur: 'l', flag: 'zh', sort: 'dur' }, 3);
    ok(q.url === '/api/catalog/browse?b=jp_uncensored&sort=dur&dur=l&flag=zh&page=3' && eq(q.params, {}) && typeof q.map === 'function', 'buildQuery → /api/catalog/browse 地址(params 空、带卡片映射)', q.url);
    ok(C.buildQuery('all', {}, 0).url === '/api/catalog/browse?sort=new&page=1' && /page=500$/.test(C.buildQuery('cn', {}, 9999).url), 'buildQuery:「全部」不带 b;页码夹在 1..500');
    const GATE = fs.readFileSync(path.join(ROOT, 'lib/adult-gate/index.js'), 'utf8');
    const srvSorts = (/sort: pick\(q\.sort, \[([^\]]*)\]/.exec(GATE) || [])[1] || '';
    const srvDur = (/dur: pick\(q\.dur, \[([^\]]*)\]/.exec(GATE) || [])[1] || '';
    const srvFlag = (/flag: pick\(q\.flag, \[([^\]]*)\]/.exec(GATE) || [])[1] || '';
    ok(A.SORTS.every(s => srvSorts.includes("'" + s.k + "'")) && A.DURS.every(d => srvDur.includes("'" + d.k + "'")) && A.FLAGS.every(f => srvFlag.includes("'" + f.k + "'")),
        '前端的排序/时长/标记取值都在服务器 browseQuery 的白名单里', { srvSorts, srvDur, srvFlag });
    // 筛选行 / 分类栏 / 标题
    ok(eq(C.groupsOf('cn', {}).map(g => g.k), ['b', 'dur', 'flag', 'sort']) && eq(C.groupsOf('west', {}).map(g => g.k), ['dur', 'flag', 'sort']), '浏览页筛选:多桶大类有「分类」行,单桶没有;时长 / 标记 / 排序');
    ok(eq(C.groupsOf('cn', {})[3].opts.map(o => o.l), ['新上架', '时长', '随机']) && eq(C.groupsOf('cn', {})[2].opts.map(o => o.l), ['全部', '中字', '无码', '≥3线']), '排序:新上架/时长/随机;标记:中字/无码/≥3线');
    ok(eq(C.navRows('jp')[0].items.map(i => i.sel.b), ['jp_censored', 'jp_uncensored', 'jp_subbed']) && C.navRows('west')[0].items.length === 4, '分类栏标签:多桶按桶,单桶给快速入口');
    ok(C.title('cn', { b: 'cn_hookup' }) === '国产 · 探花' && C.title('west', {}) === '欧美' && C.summary('jp', { b: 'jp_subbed', dur: 'l', sort: 'random' }) === '日本 · 中字 · 60分钟以上 · 随机', '标题 / 摘要', C.summary('jp', { b: 'jp_subbed', dur: 'l', sort: 'random' }));
    ok(C.countLabel(12345) === '1万+' && C.countLabel(0) === '0', 'countLabel');
    const dir = C.directory();
    ok(dir.hot.length === 17 && dir.hot.every(h => h.l && C.typeOf(h.type) && h.sel.b && /gradient/.test(h.bg) && /^fa-/.test(h.icon)) && dir.types.every(t => t.rows.every(r => r.items.every(i => i.sel && i.sel.b))), '分类大全:17 个桶色块 + 各大类卡片');
    // 搜索框分类词
    ok(eq(C.fromSearch(' 无码 '), { type: 'jp', sel: { b: 'jp_uncensored' } }) && eq(C.fromSearch('探花'), { type: 'cn', sel: { b: 'cn_hookup' } }) && eq(C.fromSearch('SM'), { type: 'more', sel: { b: 'fetish' } }), '分类词 → 浏览页(无码 / 探花 / SM)');
    ok(C.fromSearch('泰剧') === null && C.fromSearch('人妻') === null && C.fromSearch('SSIS-001') === null && C.fromSearch('') === null, '不是分类词(主站的泰剧、标签词人妻、番号)照常搜索');
    // 首页行「全部」
    ok(eq(C.rowPreset('ad_jp_subbed', undefined, { more: { b: 'jp_subbed' } }), { type: 'jp', sel: { b: 'jp_subbed', sort: 'new' } }) && eq(C.rowPreset('ad_new', undefined, { more: { sort: 'new' } }), { type: 'all', sel: { sort: 'new' } })
        && C.rowPreset('movieRow', 'newest') === null, '首页行「全部」按 more 进浏览页;没有 more 的不跳');
    // 卡片
    const card = { wk: 'c:SSIS-001', name: 'SSIS-001 合成标题', pic: 'https://img.example/a.jpg', sub: '3小时前 · 2:01:33 · 6线', badge: '中字', bucket: 'jp_subbed', code: 'SSIS-001', dur: 7293, n_sites: 6, first_seen: 1 };
    const it = A.cardToItem(card);
    ok(it && it.id === 'c:SSIS-001' && it._wk === 'c:SSIS-001' && it.title === card.name && it.poster_path === card.pic && it._sub === '3小时前' && it._badge === '中字' && it._n === 6 && it._durText === '2:01:33' && it._code === 'SSIS-001' && !('vote_average' in it), '卡片 → 行/浏览页对象(id=wk,poster_path=完整地址,_badge;时长/N线叠在海报上,副行只留「3小时前」)', it);
    ok(A.cardToItem(null) === null && A.cardToItem({ name: 'x' }) === null && C.visible(it) && !C.visible({}), '坏卡片丢掉');
    // 首页
    const home = {
        generatedAt: 1, rows: [
            { id: 'new', title: '新上架', more: { sort: 'new' }, today: 120, items: [card, { wk: 't:abc', name: '合成国产', pic: '', sub: '', badge: '' }] },
            { id: 'jp_subbed', title: '中文字幕', more: { b: 'jp_subbed' }, today: 7, items: [card] },
            { id: 'cn_live', title: '空行', items: [] },
            { id: 'bad id!', title: 'x', items: [card] },
            { id: 'random', title: '随机发现', more: { sort: 'random' }, items: [card] },
        ],
    };
    const r = A.homeToRows(home);
    ok(eq(r.order, ['ad_new', 'ad_jp_subbed', 'ad_random']), '首页行:键 ad_<id>,空行/坏 id 丢掉,随机发现是普通一行排最后', r.order);
    ok(r.configs.ad_new.adult === true && r.configs.ad_new.path === 'ADULT' && r.configs.ad_new.totalPages === 1 && r.configs.ad_new.today === 120 && eq(r.configs.ad_new.more, { sort: 'new' }) && r.configs.ad_new.icon === 'fa-clock', '行配置:目录行标记、不翻页、今日数、more');
    ok(r.lists.ad_new.length === 2 && Object.isFrozen(r.lists.ad_new[0]) && r.lists.ad_new[1]._wk === 't:abc', '行里的卡片冻结(不做深层响应式)');
    ok(eq(A.homeToRows(null), { configs: {}, lists: {}, order: [] }), '没有首页数据 → 空');
    // 今日数
    const tm = A.todayMap([{ id: 'cn_amateur', today: 30 }, { id: 'cn_studio', today: 5 }, { id: 'jp_subbed', today: 2 }, { id: 'x_mainstream', today: 99 }, null]);
    ok(eq(tm, { cn_amateur: 30, cn_studio: 5, jp_subbed: 2 }) && A.todayOf(tm, 'cn') === 35 && A.todayOf(tm, 'jp_subbed') === 2 && A.todayOf(tm, 'west') === 0 && A.todayOf(tm, '') === 0, '今日数:桶直接取、大类求和、丢弃非导航桶');
    // 作品 → 线路
    const work = {
        name: 'SSIS-001 合成标题', pic: '', _wk: 'c:SSIS-001', _meta: { code: 'SSIS-001' }, sources: [
            { site_key: 'av_s01', site_name: '站一', vod_id: 11, vod_name: '标题一', vod_pic: 'https://p.example/1.jpg', type_name: '中文字幕', _variant: '中字', _dur: 7200, vod_play_url: '正片$https://m.example/1/index.m3u8', site_profile: { tier: 'clean' } },
            { site_key: 'av_s01', site_name: '站一', vod_id: 12, vod_name: '重复站' },
            { site_key: 'av_s42', site_name: '站二', vod_id: 'x9', vod_name: '别的标题' },
            { vod_id: 1 },
        ],
    };
    const g = A.workToGroup(work);
    ok(g && g.name === work.name && g._wk === 'c:SSIS-001' && g.sources.length === 2 && g.sources.every(s => s.latency === 999) && g.pic === 'https://p.example/1.jpg' && g._meta.code === 'SSIS-001', '作品 → openDetail 的 group:一站一条、latency 999、没海报借线路的', g);
    ok(g.sources[0].vod_play_url && g.sources[1].vod_play_url === '' && g.sources[0].site_profile.tier === 'clean', '线路保留选集串(过期没给的空着 → 测速时现拉详情)与广告档案');
    ok(A.workToGroup({ name: 'x', sources: [] }) === null && A.workToGroup(null) === null, '没有线路 → null');
    const wl = A.workToList(work);
    ok(wl._adult === true && wl.list.length === 2 && !('latency' in wl.list[0]) && wl.name === work.name && eq(A.workToList(null), { list: [], _adult: true, name: '' }), 'workToList:与搜索结果同形的 {list,_adult}');
    ok(A.workUrl('c:SSIS-001', true) === '/api/catalog/work?k=c%3ASSIS-001&expand=1' && A.workUrl('t:a b', false) === '/api/catalog/work?k=t%3Aa%20b', 'workUrl 编码作品键');
    // 搜索并组键
    ok(A.groupKeyOf({ _wk: 'c:A-1', vod_name: 'x' }) === 'c:A-1' && A.groupKeyOf({ vod_name: 'x' }) === 'x' && A.groupNameOf({ _wt: '规范', vod_name: 'x' }) === '规范' && A.groupNameOf({ vod_name: 'x' }) === 'x', '并组键 _wk || vod_name;卡片名 _wt || vod_name');
    ok(A.isLandscape(800, 538) && !A.isLandscape(300, 450) && !A.isLandscape(130, 100) && !A.isLandscape(0, 0), '横版封面判定 > 1.3');
    const tried = new Set(['https://p.example/1.jpg']);
    ok(A.pickFallbackPic({ sources: [{ vod_pic: 'https://p.example/1.jpg' }, { vod_pic: 'https://x/mac_default.jpg' }, { vod_pic: 'data:x' }, { vod_pic: 'https://p.example/2.jpg' }] }, tried) === 'https://p.example/2.jpg'
        && A.pickFallbackPic({ sources: [{ vod_pic: 'https://p.example/1.jpg' }] }, tried) === '' && A.pickFallbackPic(null) === '', '海报回退:换没试过的另一条线路海报,都试过 → 空(中性占位)');
    ok(/^data:image\/svg\+xml/.test(A.PLACEHOLDER) && !/tmdb/i.test(A.PLACEHOLDER), '占位图是本地 SVG');
    ok(A.isContentPath('/api/search') && A.isContentPath('/api/catalog/home') && A.isContentPath('/api/kz/ep') && !A.isContentPath('/api/config') && !A.isContentPath('/api/auth/verify') && !A.isContentPath('/api/searchx'), '内容接口路径(与服务器 CONTENT_PATHS 一致)');
    const CP = (/const CONTENT_PATHS = \[([^\]]*)\]/.exec(GATE) || [])[1] || '';
    const srvPaths = [...CP.matchAll(/'([^']+)'/g)].map(m => m[1]);
    ok(srvPaths.length >= 5 && srvPaths.every(p => A.isContentPath(p)), '服务器 requireAuth 的每个路径前端都认作内容接口', srvPaths);
    ok(A.sameOriginPath('/api/x?a=1', 'https://s.test/') === '/api/x' && A.sameOriginPath('https://other.test/api/x', 'https://s.test/') === null, 'sameOriginPath');
    ok(A.brand.clean('<b>站</b>\u0001') === 'b站/b' && A.brand.name() === 'DGX', '站名清洗 / 默认 DGX');
}

console.log('② fetch 包装(401 补核验 / 年龄门 / 令牌头)');
let rawCalls = [];   // ② 的 fetch 桩收到的请求(auth.install 绑定它当 origFetch;⑥ 的线路反馈也看它)
{
    const calls = [];
    rawCalls = calls;
    const net = { verify: true, search401: 1, sites401: 0 };
    let showLogin = 0;
    globalThis.location = { href: 'https://site.test/', replace() { } };
    globalThis.fetch = async (url, init) => {
        const u = String(url), h = init && init.headers;
        calls.push({ url: u, tok: h && h.get ? h.get('x-dg-token') : null, age: h && h.get ? h.get('x-dg-age') : null, method: (init && init.method) || 'GET', body: init && init.body });
        const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (u === '/api/auth/verify') return J(200, { success: net.verify });
        if (u.startsWith('/api/search')) { if (net.search401 > 0) { net.search401--; return J(401, { error: 'AUTH_REQUIRED' }); } return J(200, { list: [1] }); }
        if (u.startsWith('/api/sites')) { if (net.sites401 > 0) { net.sites401--; return J(401, { error: 'AUTH_REQUIRED' }); } return J(200, { sites: [] }); }
        if (u.startsWith('/api/history')) return J(401, { error: 'bad token' });
        return J(200, {});
    };
    globalThis.showLoginScreen = () => { showLogin++; };
    const startApp0 = globalThis.startApp = () => 'orig';
    store.set('emax_auth_hash', 'hash_abc');
    store.set('emax_auth_type', 'password');
    A.auth.install();
    // 年龄确认之前:内容请求挂起
    let done = false;
    const p0 = fetch('/api/sites').then(r => { done = true; return r; });
    await tick(); await tick();
    ok(!done && !calls.some(c => c.url === '/api/sites'), '没点「我已年满18岁」之前内容请求不发出');
    const pc = await fetch('/api/config');
    ok(pc.status === 200 && calls.some(c => c.url === '/api/config'), '非内容接口(/api/config)不等年龄门');
    A.ageGate.accept();
    await p0;
    ok(done && store.get('dg_age_ok') === '1' && A.ageGate.accepted(), '确认之后挂起的请求照常发出,记住 dg_age_ok=1');
    ok(calls.find(c => c.url === '/api/sites').tok === 'hash_abc', '同源 /api 请求带 x-dg-token 头');
    ok(calls.find(c => c.url === '/api/sites').age === '1' && calls.find(c => c.url === '/api/config').age == null, '内容接口带 x-dg-age: 1(没配密码的站服务器按它放行),非内容接口不带');
    // 401 → 补核验 → 重试成功
    calls.length = 0;
    const r1 = await fetch('/api/search?wd=x');
    const urls = calls.map(c => c.url);
    ok(r1.status === 200 && eq(urls, ['/api/search?wd=x', '/api/auth/verify', '/api/search?wd=x']) && showLogin === 0, '401 AUTH_REQUIRED → /api/auth/verify 补核验一次 → 重试成功', urls);
    // 20s 内再遇 401:复用上次核验结果,不再请求 verify
    calls.length = 0; net.sites401 = 1;
    const r2 = await fetch('/api/sites');
    ok(r2.status === 200 && calls.filter(c => c.url === '/api/auth/verify').length === 0 && calls.filter(c => c.url === '/api/sites').length === 2, '短时间内再 401:复用核验结果直接重试');
    // 别的 401(不是 AUTH_REQUIRED、不是内容接口)原样返回
    calls.length = 0;
    const r3 = await fetch('/api/history/pull');
    ok(r3.status === 401 && calls.length === 1, '非内容接口的 401 原样返回,不重试');
    // 跨域不碰
    calls.length = 0;
    await fetch('https://cdn.other.test/api/search');
    ok(calls.length === 1 && calls[0].tok === null, '跨域请求不加头、不重试');
    // 重试还是 401 → 登录框;登录成功后 startApp 改为整页刷新
    calls.length = 0; net.sites401 = 2;
    const r4 = await fetch('/api/sites');
    ok(r4.status === 401 && showLogin === 1 && globalThis.startApp !== startApp0, '核验后仍 401 → 出登录框(登录后整页刷新)');
    // v2board 走面板令牌核验(revalidateV2boardSession)
    await sleep(0);
    ok(typeof A.auth.ensure === 'function' && typeof A.auth.logout === 'function', 'ensure / logout 在');
    const lo = [];
    const f0 = globalThis.fetch;
    await A.auth.logout();
    ok(calls.some(c => c.url === '/api/auth/logout' && c.method === 'POST'), '退出登录:POST /api/auth/logout(清 dg_t)');
    globalThis.fetch = f0;
    void lo;
}

console.log('③ 历史瘦身保留 _wk');
const norm = t => t.split('\r\n').join('\n');
const HTML = norm(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));
{
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
        return new Function(...m[2].split(',').map(s => s.trim()).filter(Boolean), HTML.slice(m.index + m[0].length, i - 1));
    }
    const cli = method('_slimHistoryItem');
    const item = (wk) => ({
        name: 'SSIS-001 合成标题', watchedAt: 't', lastSourceKey: 'av_s42',
        groupData: Object.assign({ name: 'SSIS-001 合成标题', pic: '/p.jpg', _work: '', _workSig: '', _workLabel: '', sources: [{ site_key: 'av_s42', vod_id: 1, vod_name: 'a', site_name: 's', vod_play_url: 'x$y', latency: 3 }] }, wk === undefined ? {} : { _wk: wk }),
    });
    const a = slimHistoryItem(item('c:SSIS-001')), b = cli.call({}, item('c:SSIS-001'));
    ok(a.groupData._wk === 'c:SSIS-001' && JSON.stringify(a) === JSON.stringify(b), 'lib/history-slim 与前端 _slimHistoryItem 都保留 _wk,结果逐字一致');
    const c = slimHistoryItem(item(undefined));
    ok(!('_wk' in c.groupData) && JSON.stringify(c) === JSON.stringify(cli.call({}, item(undefined))), '没有 _wk 时不多出这个键(主站条目输出不变)');
    ok(slimHistoryItem(item('t:' + 'x'.repeat(400))).groupData._wk.length === 300 && JSON.stringify(slimHistoryItem(a)) === JSON.stringify(a), '_wk 截到 300 字;瘦身幂等');
    // 存历史时把 _wk 写进 groupData(不复用 _work)
    ok(/\.\.\.\(groupData\._wk \? \{ _wk: groupData\._wk \} : \{\}\)/.test(HTML) && !/_work: groupData\._wk/.test(HTML), 'addToWatchHistory 存 _wk(独立字段,不占 _work)');
}

console.log('④ 沙箱里跑主脚本');
// 主 Vue 脚本(与 index-methods-test 同一套沙箱:未定义的全局都是万能代理)
const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const SRC = scripts.find(s => s.includes('createApp({'));
function any() {
    const f = function () { return any(); };
    return new Proxy(f, {
        get(t, k) { if (k === Symbol.toPrimitive) return () => ''; if (k === 'then') return undefined; if (k === Symbol.iterator) return function* () { }; return any(); },
        apply() { return any(); }, construct() { return any(); }, set() { return true; }, has() { return true; }
    });
}
function runMain(extra) {
    let captured = null;
    const ctxObj = Object.assign({
        Vue: { createApp(o) { captured = o; return { mount() { return {}; }, use() { return this; }, config: {} }; } },
        console: { log() { }, warn() { }, error() { }, info() { } },
        setTimeout, clearTimeout, setInterval: () => 0, clearInterval() { }, setImmediate,
        requestAnimationFrame: () => 0, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet, Symbol, Error, TypeError,
        URL, URLSearchParams, Uint8Array, ArrayBuffer, Proxy, Reflect, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, AbortController, TextEncoder, TextDecoder,
        Response, Headers, scrollY: 0, innerHeight: 800, scrollTo() { },
    }, extra || {});
    const ctx = new Proxy(ctxObj, {
        has() { return true; },
        get(t, k) { if (k in t) return t[k]; if (k === 'window' || k === 'self' || k === 'globalThis') return ctx; return any(); },
        set(t, k, v) { t[k] = v; return true; }
    });
    try { vm.runInNewContext(SRC, ctx, { timeout: 5000 }); } catch (e) { }
    return { o: captured, ctxObj, ctx };
}
// 主组件的 methods/computed/data 键(非成人沙箱跑出来的就是主组件本身)
const plain = runMain();
const P = plain.o;
ok(!!P && !!P.methods && Array.isArray(P.mixins), '非成人沙箱:跑出 createApp 选项(带 mixins 数组)');
{
    ok(P.mixins.length === 1 && Object.keys(P.mixins[0]).length === 0, '没有 DgAdult(或 ON 不是 true)时 mixin 是空对象');
    const D = P.data.call(new Proxy({}, { get: () => any() }));
    ok(D.rowConfigs && D.rowConfigs.movieRow && D.rowConfigs.randomRow && D.catNavType === 'tv', '非成人:首页榜单照旧是 TMDB 那 20 行、分类栏默认剧集');
    // mixin 不与主组件重名(Vue 里主组件同名方法会静默盖掉 mixin 的)
    const mk = Object.keys(A.mixin.methods), main = new Set([...Object.keys(P.methods), ...Object.keys(P.computed || {})]);
    const dKeys = new Set(Object.keys(D));
    const clash = mk.filter(n => main.has(n) || dKeys.has(n));
    ok(!clash.length, 'mixin 方法名不与主组件的 methods/computed/data 重名', clash);
    const md = Object.keys(A.mixin.data());
    ok(md.every(k => !main.has(k) && !dKeys.has(k)), 'mixin 的 data 键(adultMode/adult)不与主组件重名', md.filter(k => main.has(k) || dKeys.has(k)));
    ok(Object.keys(A.mixin.watch).every(k => k in D || k in A.mixin.computed), 'mixin 监听的都是主组件已有的 data(showDetail/currentGroup)或 mixin 自己的 computed(adTagKey)', Object.keys(A.mixin.watch));
    // mixin 的 computed 也不许与主组件重名(主组件同名的会盖掉它)
    const mc = Object.keys(A.mixin.computed || {});
    ok(mc.length >= 6 && mc.every(n => !main.has(n) && !dKeys.has(n) && !(n in A.mixin.methods)), 'mixin computed 不与主组件的 methods/computed/data、也不与 mixin 方法重名', mc.filter(n => main.has(n) || dKeys.has(n) || (n in A.mixin.methods)));
    // 主组件里用到的 mixin 方法都存在
    const used = ['adultApplyConfig', 'adultLoadHome', 'adToday', 'openWork', '_adWorkList', '_adImgFallback', 'adSuggestInput', 'adSugKey', 'adSugFocus', 'adSugBlur', 'adSugPick', 'adSetBlur', 'adCopyCode', 'adMetaGo', 'adMetaPrefix', 'adMetaSearch', 'adOpenSibling', 'adSrcV', 'adFamToggle', 'adVarPick', '_adSrcOrder', '_adSrcExtra', '_adBeaconFail', '_adBeaconTick'];
    ok(used.every(n => typeof A.mixin.methods[n] === 'function'), 'index.html 调用的 mixin 方法都在', used.filter(n => typeof A.mixin.methods[n] !== 'function'));
    // _adProxyBad 之类是主组件自己的(广告 ad)方法,不算
    const calledInHtml = [...new Set([...HTML.matchAll(/this\.(ad[A-Z]\w*|_ad[A-Z]\w*|adult[A-Z]\w*|openWork)\(/g)].map(m => m[1]))].filter(n => !(n in P.methods));
    ok(calledInHtml.every(n => typeof A.mixin.methods[n] === 'function'), 'index.html 里 this.adXxx/_adXxx/openWork 调用都有对应 mixin 方法', calledInHtml);
}

// 成人沙箱:window.DgAdult = 真的 adult.js
const net = { calls: [] };
const adultFetch = async (url, init) => {
    const u = String(url);
    net.calls.push(u);
    const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (net.handler) { const r = net.handler(u, init); if (r) return J(r.status || 200, r.body); }
    return J(404, {});
};
globalThis.fetch = adultFetch;   // mixin 里的请求走 adult.js 绑定的全局 fetch
const AD = runMain({ DgAdult: A, fetch: adultFetch, fetchT: (u, o) => adultFetch(u, o), document: { body: { classList: { add() { }, remove() { } } }, querySelectorAll: () => [], querySelector: () => null } });
const O = AD.o;
ok(!!O && O.mixins[0] === A.mixin, '成人沙箱:createApp 用上 DgAdult.mixin');
{
    const D = O.data.call(new Proxy({}, { get: () => any() }));
    // 主组件 data 照旧(TMDB 榜单、记住的大类);mixin 的 created 在第一次渲染前清空榜单、换默认大类
    const inst = Object.assign({}, D);
    A.mixin.created.call(inst);
    ok(eq(inst.rowConfigs, {}) && eq(inst.rowLists, {}) && inst.catNavType === 'cn', '成人:首页榜单起步为空(不先渲染 TMDB 行标题),分类栏默认国产', [Object.keys(inst.rowConfigs).length, inst.catNavType]);
    const inst2 = { rowConfigs: { x: 1 }, rowLists: {}, catNavType: 'jp' };
    A.mixin.created.call(inst2);
    ok(inst2.catNavType === 'jp', '记住的大类是目录版认得的就保留');
    // 分类栏 computed 走目录版
    const CP = O.computed;
    const self = { catNavType: 'jp', browse: { type: 'cn', sel: { b: 'cn_studio' } } };
    ok(eq(CP.catTypes.call(self).map(t => t.k), ['cn', 'jp', 'west', 'anime', 'more', 'all']) && CP.catNavRows.call(self)[0].items.length === 3 && CP.browseTitle.call(self) === '国产 · 传媒', 'catTypes/catNavRows/browseTitle 都是目录版');
}
const M = O.methods, CPm = O.computed;
function makeApp(over) {
    const app = Object.assign({
        adultMode: true, adult: Object.assign(A.mixin.data().adult, { catalog: true, siteName: 'DGX', today: {}, home: 'idle' }),
        browse: { open: false, type: 'cn', sel: {}, items: [], page: 0, totalPages: 0, total: 0, loading: false, error: false, done: false, idle: 0, seq: 0, keyword: '', auto: false, fromDir: false },
        rawList: [], imageMap: {}, fallbackMap: {}, rowConfigs: {}, rowLists: {}, watchHistory: [], favList: [], recommendList: [], popularList: [], liveChannels: [],
        homeLayout: [{ k: 'history', on: true }, { k: 'fav', on: true }, { k: 'recommend', on: true }, { k: 'popular', on: true }, { k: 'live', on: true }, { k: 'catnav', on: true }, { k: 'random', on: true }],
        favoritesEnabled: true, liveEnabled: false, showDetail: false, currentGroup: null, currentSource: null, episodeList: [], currentUrl: '',
        isTestingSources: false, refreshingSources: false, deepLinkLoading: false, deepLinkSourceCount: 0, previewLocked: false, searched: false, catDirOpen: false,
        filterNsfw: true, isTVMode: false, $refs: {}, toasts: [], opened: [], closed: 0,
        $nextTick(f) { if (f) f(); return Promise.resolve(); },
    }, over || {});
    for (const n of Object.keys(CPm)) Object.defineProperty(app, n, { get: () => CPm[n].call(app), configurable: true });
    for (const n of Object.keys(A.mixin.computed)) Object.defineProperty(app, n, { get: () => A.mixin.computed[n].call(app), configurable: true });
    for (const n of Object.keys(M)) if (typeof M[n] === 'function') app[n] = M[n].bind(app);
    for (const n of Object.keys(A.mixin.methods)) app[n] = A.mixin.methods[n].bind(app);
    app.showMiniToast = (t) => app.toasts.push(t);
    app._kzSnapGroups = (x) => x;
    app._cancelDeepLink = () => false;
    app.openDetail = (g) => { app.opened.push(g); app.currentGroup = g; app.showDetail = true; app.deepLinkLoading = false; return Promise.resolve(); };
    app.closeDetail = () => { app.closed++; app.showDetail = false; app.deepLinkLoading = false; app.isTestingSources = false; };
    return Object.assign(app, over || {});
}
{
    // 搜索结果按 _wk 并组,卡片名 _wt;各站片名不同也是同一张卡
    const app = makeApp();
    app.rawList = [
        { _wk: 'c:SSIS-001', _wt: 'SSIS-001 合成标题', vod_name: '站一标题', vod_pic: 'https://p/1.jpg', site_key: 's1', vod_id: 1, vod_play_url: '正片$https://a.test/x/1/index.m3u8' },
        { _wk: 'c:SSIS-001', _wt: 'SSIS-001 合成标题', vod_name: '站二另一个标题', vod_pic: '', site_key: 's2', vod_id: 2, vod_play_url: '正片$https://b.test/y/2/index.m3u8' },
        { _wk: 'c:SSIS-001#U', _wt: 'SSIS-001 合成标题 · 无码流出', vod_name: '站一标题', vod_pic: '', site_key: 's1', vod_id: 3, vod_play_url: '正片$https://a.test/z/3/index.m3u8' },
        { vod_name: '没有作品键', vod_pic: '', site_key: 's3', vod_id: 4 },
    ];
    const gl = app.groupedList;
    const main = gl.find(g => g._wk === 'c:SSIS-001'), u = gl.find(g => g._wk === 'c:SSIS-001#U'), old = gl.find(g => g.name === '没有作品键');
    ok(gl.length === 3 && main && main.name === 'SSIS-001 合成标题' && main.sources.length === 2 && u && u.name.endsWith('无码流出') && old && !('_wk' in old), 'groupedList:按 _wk 并组、名字用 _wt;#U 是另一张卡;没有 _wk 的照旧按片名', gl.map(g => [g.name, g._wk, g.sources.length]));
    // 两个作品键撞了同一个规范名:后到的加「 · 2」(卡片 key = 名字|_work,历史/收藏也按名字认)
    app.rawList = app.rawList.concat([{ _wk: 'c:SSIS-001~2', _wt: 'SSIS-001 合成标题', vod_name: 'z', vod_pic: '', site_key: 's9', vod_id: 9 }]);
    const names = app.groupedList.map(g => g.name);
    ok(names.includes('SSIS-001 合成标题') && names.includes('SSIS-001 合成标题 · 2') && new Set(names).size === names.length, '规范名撞车:后到的作品加「 · 2」,卡片名不重复', names);
    ok(/:key="group\.name \+ '\|' \+ \(group\._work \|\| ''\)"/.test(HTML), '搜索卡片 key 照旧(名字 + _work)');
}
{
    // 首页:/api/catalog/home → rowConfigs/rowLists;homeBlocks 不占「随机盲盒」位、目录行排在后面;没有目录 → 没有分类栏
    const app = makeApp({ watchHistory: [{ name: 'x' }] });
    net.handler = (u) => {
        if (u === '/api/catalog/home') return { body: { rows: [{ id: 'new', title: '新上架', more: { sort: 'new' }, items: [{ wk: 'c:A-001', name: 'A-001 x', pic: 'https://p/a.jpg' }] }, { id: 'random', title: '随机发现', more: { sort: 'random' }, items: [{ wk: 't:yy', name: 'y' }] }] } };
        if (u === '/api/catalog/buckets') return { body: [{ id: 'cn_amateur', label: '国产自拍', nav: true, today: 9 }] };
        return null;
    };
    await app.adultLoadHome();
    await sleep(5);
    ok(eq(Object.keys(app.rowConfigs), ['ad_new', 'ad_random']) && app.rowLists.ad_new[0]._wk === 'c:A-001' && app.adult.home === 'ok', 'adultLoadHome:目录各行进 rowConfigs/rowLists', Object.keys(app.rowConfigs));
    ok(app.adToday('cn') === 9 && app.adToday('cn_amateur') === 9, '分类栏今日数(/api/catalog/buckets)');
    const ids = app.homeBlocks.map(b => b.id);
    ok(eq(ids, ['history', 'catnav', 'row:ad_new', 'row:ad_random']), 'homeBlocks:继续观看、分类栏,然后目录行(随机发现排最后,不占随机盲盒的位置)', ids);
    app.adult.catalog = false;
    ok(!app.homeBlocks.some(b => b.id === 'catnav'), '没有目录:不出分类栏');
    const view = app.homeLayoutView.map(s => s.k);
    ok(!view.includes('recommend') && !view.includes('popular') && !view.includes('random') && view.includes('history'), '偏好设置的首页板块不列 推荐/大家都在看/直播/随机盲盒', view);
    // 没有目录 → 不请求
    net.calls.length = 0;
    const app2 = makeApp({ adult: { catalog: false, siteName: 'DGX', today: {}, home: 'idle' } });
    await app2.adultLoadHome();
    ok(app2.adult.home === 'off' && !net.calls.length, '目录不可用(config.catalog=false):首页不请求 /api/catalog/home');
    let fr = null;
    try { fr = app.fetchRow('ad_new', true); } catch (e) { }
    ok(fr && typeof fr.then === 'function' && !net.calls.some(u => /tmdb/.test(u)), 'fetchRow 在成人站什么都不拉');
    // 「全部」→ 浏览页预设
    let opened = null;
    app.openBrowse = (p) => { opened = p; };
    app.rowConfigs.ad_new.more = { sort: 'new' };
    app.rowBrowse('ad_new');
    ok(eq(opened, { type: 'all', sel: { sort: 'new' } }), '行的「全部」按 more 打开浏览页', opened);
}
{
    // 浏览页:走 /api/catalog/browse(不是 tmdb-proxy),卡片映射、页数
    const app = makeApp();
    app.browse.open = true; app.browse.type = 'jp'; app.browse.sel = { b: 'jp_subbed', dur: '', flag: 'zh', sort: 'new' };
    app._browseFill = () => { };
    net.calls.length = 0;
    net.handler = (u) => (u.startsWith('/api/catalog/browse') ? { body: { page: 1, total_pages: 7, total_results: 160, results: [{ wk: 'c:B-1', name: 'B-1 x', pic: 'https://p/b.jpg', sub: 's', badge: '中字' }, { wk: 'c:B-1', name: 'dup' }, { name: 'bad' }] } } : null);
    await app._browseFetch(true);
    ok(net.calls[0] === '/api/catalog/browse?b=jp_subbed&sort=new&flag=zh&page=1' && !net.calls.some(u => /tmdb/.test(u)), '浏览页请求 /api/catalog/browse(按当前筛选)', net.calls);
    ok(app.browse.items.length === 1 && app.browse.items[0]._wk === 'c:B-1' && app.browse.items[0]._badge === '中字' && app.browse.totalPages === 7 && app.browse.total === 160 && !app.browse.done, '卡片映射、去重、坏卡丢掉、页数', app.browse);
    // 点卡片 → openWork,不按片名搜
    let ow = null, searched = 0;
    app.openWork = (it) => { ow = it; };
    app.autoSearch = () => { searched++; };
    app.browsePick(app.browse.items[0]);
    ok(ow && ow._wk === 'c:B-1' && !searched && app._browsePickId === 'c:B-1', '浏览页点卡片 → openWork(按作品键)');
    ok(app.getPosterUrl('https://p/b.jpg') === 'https://p/b.jpg' && app.getPosterUrl('/api/img?id=1') === '/api/img?id=1' && /^data:image\/svg/.test(app.getPosterUrl('')), 'getPosterUrl:完整地址/同源 /api 原样用');
}
{
    // openWork:≥2 条线路 → 立刻开,后台 expand 找到更多 → 测速完后 refreshSources
    const app = makeApp();
    let refreshed = 0;
    app.refreshSources = async () => { refreshed++; };
    const src = (k) => ({ site_key: k, site_name: k, vod_id: 1, vod_name: 'n' });
    net.calls.length = 0;
    net.handler = (u) => {
        if (u === '/api/catalog/work?k=c%3AW-1') return { body: { name: 'W-1 x', _wk: 'c:W-1', sources: [src('a'), src('b')] } };
        if (u === '/api/catalog/work?k=c%3AW-1&expand=1') return { body: { name: 'W-1 x', _wk: 'c:W-1', sources: [src('a'), src('b'), src('c')] } };
        return null;
    };
    await app.openWork({ _wk: 'c:W-1', title: 'W-1 x' });
    ok(app.opened.length === 1 && app.opened[0]._wk === 'c:W-1' && app.opened[0].sources.length === 2 && !app.deepLinkLoading, '≥2 条线路:立刻 openDetail(带 _wk)');
    await sleep(30);
    ok(net.calls.includes('/api/catalog/work?k=c%3AW-1&expand=1') && refreshed === 1 && app._adPrefetch && app._adPrefetch.list.list.length === 3, '后台 expand=1 找到更多线路 → 刷新线路(结果先存着给 refreshSources 用)');
    const wl = await app._adWorkList('c:W-1');
    ok(wl._adult && wl.list.length === 3 && !app._adPrefetch, '_adWorkList:1 分钟内直接用后台拿到的结果(不再请求)');

    // 不足 2 条:加载帧 + expand,expand 回来就用它开
    const app2 = makeApp();
    let frameSeen = false;
    net.handler = (u) => {
        if (u === '/api/catalog/work?k=t%3Aonly') { return { body: { name: '合成单线', _wk: 't:only', sources: [src('a')] } }; }
        if (u === '/api/catalog/work?k=t%3Aonly&expand=1') { frameSeen = app2.deepLinkLoading && app2.showDetail && app2.currentGroup && app2.currentGroup._wk === 't:only'; return { body: { name: '合成单线', _wk: 't:only', sources: [src('a'), src('d')] } }; }
        return null;
    };
    await app2.openWork({ _wk: 't:only', title: '合成单线', poster_path: 'https://p/x.jpg' });
    ok(frameSeen && app2.opened.length === 1 && app2.opened[0].sources.length === 2, '不足 2 条:先出加载帧,expand=1 回来后用扩充后的线路开');

    // expand 也没有线路:关掉加载帧 + 提示
    const app3 = makeApp();
    net.handler = (u) => (u.startsWith('/api/catalog/work') ? { status: 404, body: { error: 'NOT_FOUND' } } : null);
    await app3.openWork({ _wk: 't:none', title: 'n' });
    ok(app3.opened.length === 0 && app3.closed === 1 && app3.toasts.includes('暂时没有可播放的线路'), '一条线路都没有:收起加载帧并提示');

    // 等待期间用户关掉了 → 不再打开
    const app4 = makeApp();
    net.handler = (u) => {
        if (u === '/api/catalog/work?k=t%3Aq') return { body: { name: 'q', _wk: 't:q', sources: [src('a')] } };
        if (u.includes('expand=1')) { app4.showDetail = false; return { body: { name: 'q', _wk: 't:q', sources: [src('a'), src('b')] } }; }
        return null;
    };
    await app4.openWork({ _wk: 't:q' });
    ok(app4.opened.length === 0, '加载帧期间用户关了播放页:不再打开');
    // 关播放页回到原来的滚动位置
    const app5 = makeApp();
    let jumped = null;
    app5._jumpTo = (y) => { jumped = y; };
    app5._adReturnY = 640;
    A.mixin.watch.showDetail.call(app5, false);
    ok(jumped === 640 && app5._adReturnY === null, '从首页/浏览页开的播放页关掉后回到原滚动位置');
}
{
    // 回车:先问本地搜索建议(/api/catalog/suggest);suggest 不可用 → 退回 /api/catalog/lookup(番号恰好一部才开)。其余照常 doSearch
    const run = async (kw, body, explicit, sug) => {
        const app = makeApp();
        let ow = null, searched = 0, br = null;
        app.openWork = (it) => { ow = it; };
        app.doSearch = () => { searched++; };
        app.openBrowse = (p, f) => { br = { p, f }; };
        app.keyword = kw;
        net.calls.length = 0;
        net.handler = (u) => {
            if (u.startsWith('/api/catalog/suggest')) return sug ? { body: sug } : null;   // null → 404(旧服务器没有 suggest)
            if (u.startsWith('/api/catalog/lookup')) return body ? { body } : { status: 503, body: { error: 'CATALOG_UNAVAILABLE' } };
            return null;
        };
        app.submitSearch(explicit);
        for (let i = 0; i < 8; i++) await tick();
        return { ow, searched, br, calls: net.calls.slice() };
    };
    let r = await run('SSIS-001', { kind: 'code', key: 'SSIS-001', results: [{ wk: 'c:SSIS-001', name: 'SSIS-001 合成标题', pic: 'https://p/1.jpg' }] }, true);
    ok(r.ow && r.ow._wk === 'c:SSIS-001' && r.ow.title === 'SSIS-001 合成标题' && r.searched === 0 && eq(r.calls, ['/api/catalog/suggest?q=SSIS-001', '/api/catalog/lookup?q=SSIS-001&limit=2']), 'suggest 不可用(404):退回 lookup,本地目录恰好一部 → 直接开作品页,不全站搜', r);
    r = await run('SSIS-002', { kind: 'code', key: 'SSIS-002', results: [{ wk: 'c:SSIS-002', name: 'a' }, { wk: 'c:SSIS-002#clip', name: 'b' }] }, true);
    ok(!r.ow && r.searched === 1, 'suggest 不可用 + lookup 命中多个作品(正片 + 片段)→ 照常全站搜', r);
    r = await run('某某片名', { kind: 'text', key: null, results: [{ wk: 't:x', name: 'x' }] }, true);
    ok(!r.ow && r.searched === 1, '文字查询 → 照常全站搜(不直接开)', r);
    r = await run('SSIS-001', null, true);
    ok(!r.ow && r.searched === 1, '目录不可用(503)→ 照常全站搜', r);
    r = await run('SSIS-001', { kind: 'code', key: 'SSIS-001', results: [{ wk: 'c:SSIS-001', name: 'x' }] }, false);
    ok(!r.ow && r.searched === 1 && !r.calls.some(u => u.startsWith('/api/catalog/')), '输入停顿的自动搜索(submitSearch(false))不查本地、不自动开作品页', r);
    // suggest 的 exact:番号有正片 + #clip + #U 兄弟时也直接开正片(旧 lookup 要求恰好 1 条,从来开不了)
    const codeSug = {
        kind: 'code', alias: null, exact: 'c:SSIS-003', items: [
            { wk: 'c:SSIS-003', name: 'SSIS-003 合成正片', pic: 'https://p/3.jpg', n_sites: 4 },
            { wk: 'c:SSIS-003#U', name: 'SSIS-003 合成正片 [无码流出]' }, { wk: 'c:SSIS-003#clip', name: 'SSIS-003 合成正片 [解说]' }],
    };
    r = await run('ssis 003', null, true, codeSug);
    ok(r.ow && r.ow._wk === 'c:SSIS-003' && r.ow.title === 'SSIS-003 合成正片' && r.searched === 0 && eq(r.calls, ['/api/catalog/suggest?q=ssis%20003']), '回车 + suggest.exact(有 #U/#clip 兄弟)→ 直接开正片作品页,不查 lookup、不全站搜', r);
    r = await run('SSIS-004', null, true, { kind: 'code', alias: null, exact: null, items: [{ wk: 'c:SSIS-004', name: 'a' }, { wk: 'c:SSIS-004~2', name: 'b' }] });
    ok(!r.ow && r.searched === 1, '番号有两部正片(exact 为空)→ 照常全站搜', r);
    // 分类/标签词 → 浏览页(带「按片名搜索」入口 = from.keyword)
    r = await run('人妻', null, true, { kind: 'alias', alias: { tag: 'milf', label: '人妻熟女' }, exact: null, items: [] });
    ok(r.br && eq(r.br.p, { type: 'all', sel: { tag: 'milf' } }) && r.br.f.keyword === '人妻' && r.searched === 0, '标签词(人妻)→ 浏览页按标签筛,保留「按片名搜索」', r.br);
    r = await run('里番', null, true, { kind: 'alias', alias: { b: 'anime', label: '动漫·里番' }, exact: null, items: [] });
    ok(r.br && eq(r.br.p, { type: 'anime', sel: { b: 'anime' } }) && r.searched === 0, '分类词(里番,本地 ALIAS 表里也有)→ 动漫浏览页', r.br);
    r = await run('合成标签词', null, true, { kind: 'alias', alias: { tag: 'bad id!', label: 'x' }, exact: null, items: [] });
    ok(!r.br && r.searched === 1, 'alias 里的标签 id 不合法 → 不开浏览页,照常搜索', r);
    r = await run('合成被拦词', null, true, { kind: 'blocked', alias: null, exact: null, items: [] });
    ok(!r.ow && !r.br && r.searched === 1, '被拦的查询:不开任何东西,照常交给服务器(服务器返回空结果,不提示为什么)', r);
}
{
    // 搜索建议:输入停顿 200ms → /api/catalog/suggest(不再 500ms 自动全站搜);下拉、方向键、回车选中行、失焦收起
    const app = makeApp();
    let searched = 0, ow = null, br = null;
    app.doSearch = () => { searched++; };
    app.openWork = (it) => { ow = it; };
    app.openBrowse = (p, f) => { br = { p, f }; };
    const doc0 = globalThis.document;
    let focused = true;
    globalThis.document = { get activeElement() { return focused ? { tagName: 'INPUT', classList: { contains: (c) => c === 'search-input' }, blur() { focused = false; } } : null; } };
    net.calls.length = 0;
    net.handler = (u) => (u.startsWith('/api/catalog/suggest') ? {
        body: {
            kind: 'text', alias: null, exact: null, items: [
                { wk: 't:a1', name: '合成片名一', pic: 'https://p/a1.jpg', dur: 600, n_sites: 3, sub: '1天前 · 10:00 · 3线' }, { wk: 't:a2', name: '合成片名二' }],
        },
    } : null);
    app.keyword = '合成片';
    app.debouncedSearch();
    await sleep(80);
    ok(!net.calls.length, '200ms 防抖:还没到点不请求');
    await sleep(200);
    for (let i = 0; i < 4; i++) await tick();
    ok(eq(net.calls, ['/api/catalog/suggest?q=%E5%90%88%E6%88%90%E7%89%87']) && app.searchTimer == null, '输入停顿 → 只请求 /api/catalog/suggest,不设 500ms 自动全站搜', net.calls);
    await sleep(600);
    ok(searched === 0, '停顿后也不自动全站扇出(回车/放大镜才搜)');
    const rows = app.adSugRows;
    ok(app.adult.sug.open && eq(rows.map(x => x.t), ['item', 'item', 'all']) && rows[0].it._wk === 't:a1' && rows[0].it._durText === '10:00' && rows[0].it._n === 3, '下拉:作品卡片 + 最后一行「搜索全部站点」', rows.map(x => x.t));
    const ev = (key) => ({ key, isComposing: false, preventDefault() { this.d = true; } });
    app.adSugKey(ev('ArrowDown')); app.adSugKey(ev('ArrowDown'));
    ok(app.adult.sug.hi === 1, '方向键下移选中行');
    app.adSugKey(ev('ArrowUp')); app.adSugKey(ev('ArrowUp'));
    ok(app.adult.sug.hi === 2, '方向键上移到头绕到最后一行');
    app.adSugKey(ev('ArrowDown'));   // → 第 0 行
    net.calls.length = 0;
    app.submitSearch(true);
    for (let i = 0; i < 6; i++) await tick();
    ok(ow && ow._wk === 't:a1' && searched === 0 && !net.calls.length && !app.adult.sug.open && !focused, '回车 + 选中的行 → 开那一部(不再请求、收起下拉、收起键盘)', [ow && ow._wk, searched, net.calls]);
    // 「搜索全部站点」行 → 全站搜
    focused = true; ow = null;
    app.keyword = '合成片'; app.adult.sug.open = true; app.adult.sug.q = '合成片';
    app.adSugPick({ t: 'all', k: 'all', q: '合成片' });
    ok(searched === 1 && !ow, '「搜索全部站点」→ doSearch');
    // 被拦的词:不出下拉,不说为什么
    focused = true;
    net.handler = (u) => (u.startsWith('/api/catalog/suggest') ? { body: { kind: 'blocked', alias: null, exact: null, items: [] } } : null);
    app.keyword = '合成被拦'; app.debouncedSearch();
    await sleep(260); for (let i = 0; i < 4; i++) await tick();
    ok(!app.adult.sug.open && !app.adSugRows.length, '被拦的查询:下拉不出现(不提示被过滤)');
    // alias:第一行「按分类浏览」
    net.handler = (u) => (u.startsWith('/api/catalog/suggest') ? { body: { kind: 'alias', alias: { b: 'cn_hookup', label: '探花约炮' }, exact: null, items: [{ wk: 't:h1', name: '合成探花' }] } } : null);
    app.keyword = '探花'; app.debouncedSearch();
    await sleep(260); for (let i = 0; i < 4; i++) await tick();
    ok(app.adult.sug.open && app.adSugRows[0].t === 'alias' && app.adSugRows[0].label === '探花约炮', '分类词:第一行「按分类浏览」');
    app.adSugPick(app.adSugRows[0]);
    ok(br && eq(br.p, { type: 'cn', sel: { b: 'cn_hookup' } }) && br.f.keyword === '探花', '点「按分类浏览」→ 浏览页(带按片名搜索)', br);
    // 失焦(焦点去了搜索区之外)收起;焦点还在搜索区里不收
    app.adult.sug.open = true;
    const inside = {}, box = { contains: (x) => x === inside };
    app.adSugBlur({ relatedTarget: inside, currentTarget: box });
    ok(app.adult.sug.open, '焦点移到下拉里(遥控器)不收起');
    app.adSugBlur({ relatedTarget: null, currentTarget: box });
    ok(!app.adult.sug.open, '焦点离开搜索区 → 收起');
    // 清空关键词:照旧走原逻辑(回首页/浏览页),不请求
    net.calls.length = 0;
    app.keyword = ''; app.searched = false;
    app.debouncedSearch();
    await sleep(260);
    ok(!net.calls.length && !app.adult.sug.open, '清空关键词:不请求建议,下拉收起');
    // 失焦后才回来的结果不弹下拉
    focused = false;
    net.handler = (u) => (u.startsWith('/api/catalog/suggest') ? { body: { kind: 'text', items: [{ wk: 't:z', name: 'z' }] } } : null);
    app.keyword = 'zz'; app.debouncedSearch();
    await sleep(260); for (let i = 0; i < 4; i++) await tick();
    ok(!app.adult.sug.open, '搜索框已不在焦点:建议回来也不弹下拉');
    // 非成人站:debouncedSearch 照旧 500ms 自动搜
    const app2 = makeApp({ adultMode: false });
    let s2 = 0;
    app2.submitSearch = () => { s2++; };
    app2.keyword = '某剧'; app2.debouncedSearch();
    await sleep(560);
    ok(s2 === 1, '非成人站:输入停顿照旧自动搜索(行为不变)');
    globalThis.document = doc0;
}
{
    // refreshSources 成人分支:按 _wk 取线路,不按片名搜
    const app = makeApp();
    app.currentGroup = { name: '规范名', _wk: 'c:R-1', sources: [{ site_key: 'old', vod_id: 9 }] };
    app.currentSource = app.currentGroup.sources[0];
    app._isKzSource = () => false; app._kzSameTitle = () => false; app._applyServerCheck = () => { };
    net.calls.length = 0;
    net.handler = (u) => (u === '/api/catalog/work?k=c%3AR-1&expand=1' ? { body: { name: '规范名', _wk: 'c:R-1', sources: [{ site_key: 's1', site_name: '一', vod_id: 1, vod_name: '标题甲', vod_play_url: '正片$https://a.test/p/1/index.m3u8' }, { site_key: 's2', site_name: '二', vod_id: 2, vod_name: '完全不同的标题', vod_play_url: '正片$https://b.test/q/2/index.m3u8' }] } } : null);
    try { await app.refreshSources(); } catch (e) { }
    ok(net.calls[0] === '/api/catalog/work?k=c%3AR-1&expand=1' && !net.calls.some(u => u.startsWith('/api/search')), 'refreshSources:请求 /api/catalog/work?expand=1,不按片名重搜', net.calls.slice(0, 3));
    ok(eq(app.currentGroup.sources.map(s => s.site_key).sort(), ['s1', 's2']), '各站片名不同也都留下(不按名字筛)', app.currentGroup.sources.map(s => s.site_key));
}
{
    // 海报回退:换同组另一条线路,不查 TMDB
    const app = makeApp();
    app.rawList = [
        { _wk: 'c:P-1', _wt: 'P-1', vod_name: 'a', vod_pic: 'https://p/1.jpg', site_key: 's1', vod_id: 1 },
        { _wk: 'c:P-1', _wt: 'P-1', vod_name: 'b', vod_pic: 'https://p/2.jpg', site_key: 's2', vod_id: 2 },
    ];
    net.calls.length = 0;
    app.handleImgError('P-1', 'P-1');
    ok(app.imageMap['P-1'] === 'https://p/2.jpg' && !app.fallbackMap['P-1'], '海报坏了:换另一条线路的海报');
    app.handleImgError('P-1', 'P-1');
    ok(app.fallbackMap['P-1'] === true && !net.calls.length, '都坏了:中性占位,不发任何请求(不查 TMDB)');
    app.handleImgError('站一的原名', '站一的原名');
    ok(!app.fallbackMap['站一的原名'], '搜索流里单条缺图(不是卡片键):不处理');
}
{
    // TMDB 请求根本不发;分享 / 地址栏片名都关掉
    const tmdbFetch = AD.ctxObj.tmdbFetch || null;
    let r = null;
    try { r = await vm.runInNewContext('tmdbFetch("/api/tmdb-proxy?path=%2Ftrending")', AD.ctx); } catch (e) { r = e; }
    ok(r && r.status === 404 && !net.calls.some(u => /tmdb/.test(u)), 'tmdbFetch 在成人站直接回空 404,不发请求', r && r.status);
    void tmdbFetch;
    const app = makeApp({ currentGroup: { name: '规范名' } });
    let replaced = 0;
    AD.ctxObj.history = { replaceState() { replaced++; }, state: null };
    app.syncShareUrl();
    ok(replaced === 0, 'syncShareUrl:地址栏不写片名');
    app.openSharePanel();
    ok(!app.showSharePanel, '分享面板不打开');
    await app.shareFrame();
    ok(app.toasts.includes('本站不提供分享'), '截帧分享不出卡片');
    let popularCalls = 0;
    AD.ctxObj.fetch = async (u) => { popularCalls++; return adultFetch(u); };
    await app.fetchPopular();
    await app.fetchRecommendations();
    ok(popularCalls === 0, '大家都在看 / 为你推荐(靠 TMDB)不请求');
    AD.ctxObj.fetch = adultFetch;
}

console.log('⑥ phase 2:标签 / 建议 / 信息条 / 线路家族 / 线路反馈 / 购买地址');
{
    // 浏览:标签筛选进 normSel / 地址 / 标题;没选标签时选择对象逐字不变
    const C = A.catalog;
    ok(eq(C.normSel('jp', { b: 'jp_censored', tag: 'busty' }), { b: 'jp_censored', dur: '', flag: '', sort: 'new', tag: 'busty' }) && eq(C.normSel('jp', { b: 'jp_censored', tag: '' }), { b: 'jp_censored', dur: '', flag: '', sort: 'new' })
        && !('tag' in C.normSel('jp', { tag: 'bad id!' })) && !('tag' in C.normSel('jp', { tag: { x: 1 } })), 'normSel:合法标签 id 才带 tag 键;空/非法不带');
    ok(C.buildQuery('jp', { b: 'jp_censored', tag: 'busty', dur: 'l' }, 2).url === '/api/catalog/browse?b=jp_censored&tag=busty&sort=new&dur=l&page=2' && C.buildQuery('all', { tag: 'milf' }, 1).url === '/api/catalog/browse?tag=milf&sort=new&page=1',
        'browse 地址带 &tag=(可与 b/sort/dur/flag/page 组合;全部大类只带 tag)', C.buildQuery('all', { tag: 'milf' }, 1).url);
    ok(eq(C.normSel('all', { lp: 'ssis' }), { b: '', dur: '', flag: '', sort: 'new', lp: 'SSIS' }) && !('lp' in C.normSel('all', { lp: 'S%' })) && !('lp' in C.normSel('all', { lp: '' }))
        && C.buildQuery('all', { lp: 'SSIS', tag: 'milf' }, 1).url === '/api/catalog/browse?tag=milf&lp=SSIS&sort=new&page=1' && C.title('all', { lp: 'SSIS' }) === '全部 · SSIS',
        'normSel / 地址 / 标题:厂牌前缀 lp(合法才带键)', C.buildQuery('all', { lp: 'SSIS', tag: 'milf' }, 1).url);
    ok(C.title('jp', { b: 'jp_censored', tag: 'busty' }) === '日本 · 有码 · 巨乳美乳' && C.title('all', { tag: 'milf' }) === '全部 · 人妻熟女' && C.summary('all', { tag: 'milf', sort: 'random' }) === '全部 · 人妻熟女 · 随机', '标题/摘要带标签名');
    const X2 = require(path.join(ROOT, 'lib/adult'));
    const tx = (X2.taxonomy && (X2.taxonomy.TAGS || X2.taxonomy.tags)) || require(path.join(ROOT, 'lib/adult/taxonomy.json')).tags;
    // 服务器下发的 label 优先,这张表只是兜底:两边都有的 id 名字必须一致(服务器新加的标签前端没有也行,会用服务器给的名字)
    ok(Array.isArray(tx) && tx.length >= 20 && tx.every(t => !A.TAG_LABEL[t.id] || A.TAG_LABEL[t.id] === t.label), '兜底标签名与 lib/adult/taxonomy.json 的 tags 一致', tx && tx.filter(t => A.TAG_LABEL[t.id] && A.TAG_LABEL[t.id] !== t.label).map(t => t.id));
    ok(['noncon', 'incest', 'hypnosis', 'time-stop'].every(id => A.NEVER_FEATURE.has(id)), '审查类标签在前端也永不做按钮(强制/乱伦/催眠/时停)');
    // /api/catalog/tags → featured 才留;服务器漏标 featured 的审查类也不留;按数量降序、最多 24
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, label: '合成' + i, count: i, featured: true }));
    const tl = A.normTags({ tags: [{ id: 'busty', label: '巨乳美乳', count: 50, featured: true }, { id: 'noncon', label: '强制凌辱', count: 99, featured: true }, { id: 'incest', label: '乱伦剧情', count: 80, featured: false },
        { id: 'milf', label: '人妻熟女', count: 70, featured: true }, { id: 'legs', label: '丝袜美腿', count: 60 }, { id: 'bad id', label: 'x', featured: true }, null].concat(many) });
    ok(tl[0].id === 'milf' && tl[1].id === 'busty' && !tl.some(t => ['noncon', 'incest', 'legs', 'bad id'].includes(t.id)) && tl.length === 24 && tl.every((t, i) => !i || tl[i - 1].count >= t.count),
        'normTags:只留 featured===true 且不是审查类;降序;最多 24', tl.slice(0, 3));
    ok(A.tagsUrl('jp_censored') === '/api/catalog/tags?b=jp_censored' && A.tagsUrl('') === '/api/catalog/tags?b=' && A.tagsUrl('x_mainstream') === '/api/catalog/tags?b=', 'tagsUrl:只认导航桶');
    // /api/catalog/suggest
    ok(eq(A.normSuggest({ kind: 'blocked', items: [{ wk: 't:x', name: 'x' }], alias: { b: 'anime', label: 'x' } }), { kind: 'blocked', alias: null, exact: null, items: [] }), '被拦:什么都不给(即使服务器带了东西)');
    const sg = A.normSuggest({ kind: 'code', exact: 'c:A-1', items: Array.from({ length: 12 }, (_, i) => ({ wk: 'c:A-1' + (i ? '#clip~' + i : ''), name: 'n' + i })) });
    ok(sg.kind === 'code' && sg.exact === 'c:A-1' && sg.items.length === 8 && sg.items[0]._wk === 'c:A-1' && Object.isFrozen(sg.items[0]), 'suggest:卡片 ≤8、exact 原样', sg.items.length);
    ok(A.normSuggest({ kind: 'code', exact: 'javascript:x', items: [] }).exact === null && A.normSuggest({ kind: 'weird', items: [] }).kind === 'text' && A.normSuggest(null) === null, 'suggest:exact 必须是作品键;未知 kind 当 text;没有回包 → null');
    const al = A.normSuggest({ kind: 'alias', alias: { tag: 'milf', label: '人妻熟女<b>' } }).alias;
    ok(eq(al, { b: '', tag: 'milf', label: '人妻熟女b' }) && A.normSuggest({ kind: 'alias', alias: { b: 'x_mainstream', label: 'x' } }).alias === null, 'suggest:alias 只认导航桶 / 合法标签,名字去掉尖括号', al);
    ok(eq(A.aliasPreset({ b: 'jp_uncensored', tag: 'busty' }), { type: 'jp', sel: { b: 'jp_uncensored', tag: 'busty' } }) && eq(A.aliasPreset({ tag: 'milf' }), { type: 'all', sel: { tag: 'milf' } }) && A.aliasPreset({ b: 'nope' }) === null, 'aliasPreset');
    // 首页热门行:标题统一「热门」,来源在角标上;没有 more → 前端不给「全部」
    const hr = A.homeToRows({ rows: [{ id: 'new', title: '新上架', more: { sort: 'new' }, items: [{ wk: 'c:A-1', name: 'a' }] },
        { id: 'hot', title: '本站热门', source: 'local', more: null, items: [{ wk: 'c:H-1', name: 'h', n_sites: 3 }] }] });
    ok(eq(hr.order, ['ad_new', 'ad_hot']) && hr.configs.ad_hot.title === '热门' && hr.configs.ad_hot.srcLabel === '本站热门' && /7 天/.test(hr.configs.ad_hot.srcTip) && hr.configs.ad_hot.icon === 'fa-fire' && hr.configs.ad_hot.more === null && hr.configs.ad_new.srcLabel === '',
        '热门行紧跟新上架:标题「热门」+ 来源角标「本站热门」', hr.configs.ad_hot);
    ok(A.homeToRows({ rows: [{ id: 'hot', title: '外站热门', source: 'ext', items: [{ wk: 'c:H-1', name: 'h' }] }] }).configs.ad_hot.srcLabel === '外站热门'
        && A.homeToRows({ rows: [{ id: 'hot', title: '外站热门', items: [{ wk: 'c:H-1', name: 'h' }] }] }).configs.ad_hot.srcLabel === '外站热门', '外站热门:按 source,缺 source 时按标题认');
    // 卡片:可选 variant、1 线不出「1线」角标(模板 _n >= 2)
    const c1 = A.cardToItem({ wk: 't:q', name: 'q', sub: '2天前 · 1线', n_sites: 1, variant: '竖屏' });
    ok(c1._sub === '2天前' && c1._n === 1 && c1._badge === '竖屏' && c1._durText === '', 'cardToItem:没 badge 时用 variant;副行去掉「1线」', c1);
    ok(A.fmtDur(59) === '0:59' && A.fmtDur(3600) === '1:00:00' && A.fmtDur(0) === '' && A.fmtDur('x') === '', 'fmtDur 与服务器同格式');
}
{
    // 作品信息条(_meta → 展示版)
    const g = { _wk: 'c:SSIS-010', sources: [{ site_key: 's1' }, { site_key: 's2' }, { site_key: 's2' }] };
    const m = A.metaView({
        code: 'SSIS-010', dur: 7293, bucket: 'jp_censored', bucket_label: '日本有码', n_sites: 1, label_prefix: 'SSIS', first_seen: 5,
        tags: [{ id: 'busty', label: '巨乳美乳', featured: true }, { id: 'noncon', label: '强制凌辱', featured: false }, { id: 'incest', label: '乱伦剧情', featured: true }, { id: 'legs', label: '丝袜美腿' }],
        actress: ['合成演员甲', '', '合成演员甲', '<x>'],
        siblings: [{ wk: 'c:SSIS-010#U', name: 'SSIS-010 [无码流出]', kind: 'U' }, { wk: 'c:SSIS-010#clip', name: 'SSIS-010 [解说]', kind: 'clip' }, { wk: 'c:SSIS-010~2', name: 'SSIS-010 另一部', kind: 'main' },
            { wk: 'c:SSIS-010', name: '自己', kind: 'main' }, { wk: 'http://x', name: 'bad' }],
    }, g);
    ok(m.code === 'SSIS-010' && m.durText === '2:01:33' && m.nSites === 2 && m.bucket === 'jp_censored' && m.bucketLabel === '日本有码' && m.prefix === 'SSIS' && m.firstSeen === 5, '信息条:番号/时长/上架站数(取线路实数)/分类/厂牌前缀', m);
    ok(eq(m.tags, [{ id: 'busty', label: '巨乳美乳' }]), '标签按钮:只要 featured===true 的,审查类(featured 也不行)和没标 featured 的都不出', m.tags);
    ok(eq(m.actress, ['合成演员甲', 'x']), '演员:去空、去重、去尖括号', m.actress);
    ok(eq(m.sib.map(s => [s.kind, s.label]), [['U', '另有无码流出版'], ['main', '同番号另一版本']]) && eq(m.clips.map(s => s.wk), ['c:SSIS-010#clip']), '同番号:无码流出版链接在前;解说/片段单独收起;自己和坏键丢掉', m.sib);
    const mu = A.metaView({ code: 'SSIS-010', bucket: 'jp_uncensored', siblings: [{ wk: 'c:SSIS-010', name: 'SSIS-010 正片', kind: 'main' }] }, { _wk: 'c:SSIS-010#U', sources: [] });
    ok(mu.sib[0].label === '正片' && mu.prefix === 'SSIS', '无码流出版页:指回「正片」;没给 label_prefix 时按番号推前缀(phase 1 服务器)');
    const cn = A.metaView({ bucket: 'cn_hookup', actress: ['合成名'], tags: ['milf', 'noncon'], label_prefix: '' }, { _wk: 't:x', sources: [] });
    ok(cn.actress.length === 0 && cn.prefix === '' && eq(cn.tags, [{ id: 'milf', label: '人妻熟女' }]), '探花/自拍/主播/网红:绝不出演员名;phase 1 的字符串标签也认(审查类照样不出)', cn);
    ok(['cn_amateur', 'cn_hookup', 'live', 'creators'].every(b => A.metaView({ bucket: b, actress: ['合成名'] }, { sources: [] }).actress.length === 0), '四个素人类分类都不出演员');
    ok(A.metaView(null, g) === null && A.metaView({ bucket: 'x_mainstream' }, g).bucket === '', '没有 _meta → null;不认识的分类不出按钮');
}
{
    // 线路标记 / 组内排序 / 家族视图
    const w = A.workSource({ site_key: 's1', vod_id: 1, _family: 'fam-a', _dead: true, _native: 'risky', _same: 'up1', _res: '1920x1080' });
    ok(w._family === 'fam-a' && w._dead === true && w._native === 'risky' && w._same === 'up1' && eq(w._realRes, { w: 1920, h: 1080, from: 'beacon', ts: 0 }), 'workSource:带上 _family/_dead/_native/_same,_res → _realRes(分辨率角标)', w);
    const w0 = A.workSource({ site_key: 's1', vod_id: 1, _family: '', _dead: false, _native: 'ok', _same: '', _res: '' });
    ok(!['_family', '_dead', '_native', '_same', '_realRes'].some(k => k in w0), '没有标记时不带这些键(与 phase 1 对象逐字相同)', w0);
    ok(eq(A.srcExtra({ _variant: '中字', _dur: 7200, _family: 'f' }), { _family: 'f', _variant: '中字', _dur: 7200 }) && eq(A.srcExtra(null), {}), 'srcExtra:refreshSources 重建时补回的字段');
    ok(eq(A.srcExtra(w)._realRes, { w: 1920, h: 1080, from: 'beacon', ts: 0 }) && !('_realRes' in A.srcExtra({ _realRes: { w: 640, h: 360, from: 'play', ts: 1 } })),
        'srcExtra:刷新线路时上报的分辨率(workSource 已转成 _realRes)不丢;本机实测的不当上报的带', A.srcExtra(w));
    const S = (k, o) => Object.assign({ site_key: k, vod_id: 1 }, o || {});
    const L = [S('a', { _family: 'F' }), S('b'), S('c', { _family: 'F' }), S('d', { _dead: true }), S('e', { _family: 'F', _dead: true }), S('f', { _native: 'risky' }), S('g', { _variant: '中字' }), S('h', { _family: 'F', _native: 'risky' })];
    const keys = (o) => A.orderSources(L, o).map(s => s.site_key).join('');
    ok(keys({}) === 'acfhbgde' || keys({}) === 'achbfgde', '默认:失效垫底、同家镜像紧跟领头(c/h 挨着 a),其余原顺序', keys({}));
    ok(keys({}) === 'achbfgde', '同家里非失效成员都拉到领头后面(risky 成员也拉)', keys({}));
    ok(keys({ native: true }) === 'achbgfde', '原生 HLS 设备:risky 往后挪(不藏);家族仍挨着', keys({ native: true }));
    ok(keys({ pref: 'zh' }) === 'gachbfde', '选了中字:中字线路在前', keys({ pref: 'zh' }));
    ok(A.orderSources(L, {}).length === L.length && A.orderSources(null).length === 0, '一条不少');
    // 同一家里的中字 / 原版是两份片子,不互为备用:不收到一起
    const M = [S('m1', { _family: 'G', _variant: '中字' }), S('m2'), S('m3', { _family: 'G' }), S('m4', { _family: 'G', _variant: '中字' })];
    ok(A.orderSources(M, {}).map(s => s.site_key).join('') === 'm1m4m2m3', '同家只把同一版本(中字/原版)的收到一起', A.orderSources(M, {}).map(s => s.site_key));
    const VM = A.srcView([{ items: A.orderSources(M, {}) }], {});
    ok(VM.get(M[0]).lead && VM.get(M[0]).more === 1 && VM.get(M[3]).hide && VM.get(M[2]).lead && VM.get(M[2]).more === 0 && !VM.get(M[2]).hide, '家族视图同样按版本分:原版那条自己是领头(不被中字领头收起)');
    ok(eq(A.metaView({ bucket: 'jp_subbed', tags: [{ id: 'subbed', label: '中字', featured: true }, { id: 'busty', label: '巨乳美乳', featured: true }] }, { sources: [] }).tags.map(t => t.id), ['busty']), '分类已说明的标签(中文字幕分类的「中字」)不重复出');
    const groups = [{ tier: 'clean', items: A.orderSources(L.slice(0, 3).concat([L[7]]), {}) }, { tier: 'unreach', items: [L[3], L[4]] }];
    const V = A.srcView(groups, { cur: null, open: {}, native: false, all: [S('x', { _same: 'u' }), S('y', { _same: 'u' }), S('z', { _same: 'v' })] });
    const va = V.get(L[0]), vc = V.get(L[2]), vh = V.get(L[7]), ve = V.get(L[4]);
    ok(va.lead && va.more === 2 && !va.hide && vc.mem && vc.hide && vh.mem && vh.hide && ve.lead && ve.more === 0 && ve.dead, '家族视图:领头 +2 备用,成员收起;失效组里另起一个领头(不跨组)', [va, vc]);
    const V2 = A.srcView(groups, { cur: L[2], open: {}, native: true, all: [] });
    ok(!V2.get(L[2]).hide && V2.get(L[7]).hide && V2.get(L[7]).risky && !V2.get(L[0]).risky, '正在播的成员照常显示;risky 只在原生设备标', V2.get(L[2]));
    const V3 = A.srcView(groups, { cur: null, open: { F: true }, native: false, all: [] });
    ok(!V3.get(L[2]).hide && V3.get(L[0]).open, '展开后成员都显示');
    const V5 = A.srcView(groups, { cur: null, open: {}, expandAll: true, all: [] });
    ok(!V5.get(L[2]).hide && V5.get(L[0]).more === 2, '电视模式(expandAll):成员都列出来(遥控器够不着「+N 备用」)');
    const sameAll = [S('p', { _same: 'u' }), S('q', { _same: 'u' }), S('r', { _same: 'v' })];
    const V4 = A.srcView([{ items: sameAll }], { all: sameAll });
    ok(V4.get(sameAll[0]).same && V4.get(sameAll[1]).same && !V4.get(sameAll[2]).same, '同源:同一个 _same 出现 ≥2 次才标');
    ok(A.varKind({ _variant: '中字' }) === 'zh' && A.varKind({ _variant: '无码' }) === 'raw' && A.varKind({}) === 'raw', 'varKind');
}
{
    // 线路反馈:载荷校验、每会话每条一次、带令牌/年龄头、不走 401 补核验
    A.beacon._reset();
    ok(A.beacon.payload({ wk: 'c:A-1', site_key: 's1', vod_id: 3, ok: true, dur: 3600.4, w: 1920, h: 1080, err: 'x' }) && eq(A.beacon.payload({ wk: 'c:A-1', site_key: 's1', vod_id: 3, ok: true, dur: 3600.4, w: 1920, h: 1080, err: 'x' }), { wk: 'c:A-1', site_key: 's1', vod_id: 3, ok: true, dur: 3600, w: 1920, h: 1080 }), '起播载荷:时长取整、宽高成对、不带 err');
    ok(eq(A.beacon.payload({ wk: 't:x', site_key: 's1', vod_id: 'v9', ok: false, err: 'hls:media3', dur: 5 }), { wk: 't:x', site_key: 's1', vod_id: 'v9', ok: false, err: 'hls:media3' }), '失败载荷:只带 err');
    ok([{ wk: 'x', site_key: 's', vod_id: 1, ok: true }, { wk: 'c:A', site_key: '', vod_id: 1, ok: true }, { wk: 'c:A', site_key: 's', vod_id: null, ok: true }, { wk: 'c:A', site_key: 's', vod_id: 1, ok: 'yes' }, { wk: 'c:A', site_key: 's', vod_id: {}, ok: true }].every(o => A.beacon.payload(o) === null), '不合法 → 不发');
    ok(eq(A.beacon.payload({ wk: 'c:A', site_key: 's', vod_id: 1, ok: true, dur: -1, w: 10, h: 99999 }), { wk: 'c:A', site_key: 's', vod_id: 1, ok: true }), '离谱的时长/宽高丢掉');
    store.set('emax_auth_hash', 'hash_bc');
    // auth.install 时绑定的 origFetch 是 ② 的桩(记在 rawCalls 里):上报走它,不经 401 补核验那层
    rawCalls.length = 0;
    const o = { wk: 'c:B-1', site_key: 's1', vod_id: 7, ok: false, err: 'hls:nostart' };
    const sent1 = A.beacon.send(o), sent2 = A.beacon.send(o), sent3 = A.beacon.send(Object.assign({}, o, { ok: true }));
    await tick(); await tick();
    ok(sent1 && !sent2 && sent3, '同一作品同一线路:失败/起播各报一次(同一会话里再来不重发)');
    const bc = rawCalls.filter(c => c.url === '/api/catalog/beacon');
    ok(bc.length === 2 && bc.every(c => c.method === 'POST' && c.tok === 'hash_bc' && c.age === '1') && eq(JSON.parse(bc[0].body), o) && rawCalls.every(c => c.url !== '/api/auth/verify'),
        'POST /api/catalog/beacon:JSON 体、带 x-dg-token / x-dg-age,不走补核验', bc.map(c => [c.method, c.tok, c.age]));
}
{
    // mixin:起播反馈(连续播 30 秒 / 短片一半才算,避开片头贴片)/ 失败反馈(只 hls.js 设备报)
    const app = makeApp();
    const sent = [];
    const send0 = A.beacon.send;
    A.beacon.send = (o) => { sent.push(o); return true; };
    const s1 = { site_key: 's1', vod_id: 11, _dead: true }, s2 = { site_key: 's2', vod_id: 22 }, s3 = { site_key: 's3', vod_id: 33 }, s4 = { site_key: 's4', vod_id: 44, _realRes: { w: 854, h: 480, from: 'm3u8' } };
    app.currentGroup = { name: 'n', _wk: 'c:K-1', sources: [s1, s2, s3, s4] };
    app.currentSource = s1; app._playToken = 5; app.episodeList = [{ name: '正片', url: 'u' }];
    const v = { currentTime: 100, paused: false, error: null, videoWidth: 1920, videoHeight: 1080, duration: 3601.6 };
    const play = (from, to, onTick) => { for (let t = from; t <= to + 1e-9; t += 0.25) { v.currentTime = t; if (onTick) onTick(t); app._adBeaconTick(v); } };
    app._adBeaconTick(v);
    play(100.25, 110);
    ok(!sent.length, '起播不满 30 秒不报');
    v.currentTime = 400; app._adBeaconTick(v);   // 拖动(大跳)不算
    // 片头 25 秒是 1920x1080 的贴片,之后正片 1280x720
    play(400.25, 425, (t) => { if (t >= 415) { v.videoWidth = 1280; v.videoHeight = 720; } });
    ok(sent.length === 1 && eq(sent[0], { wk: 'c:K-1', site_key: 's1', vod_id: 11, ok: true, dur: 3602, w: 1280, h: 720 }) && s1._dead === false,
        '连续播满 30 秒 → 报一次起播(单集带时长;宽高取贴片之后稳定的正片尺寸);本机放得了就不再置灰', sent[0]);
    play(425.25, 440);
    ok(sent.length === 1, '同一次播放只报一次');
    // 尺寸刚变(<3 秒)→ 不带宽高
    app.currentSource = s3; app._playToken = 7; v.currentTime = 0; v.videoWidth = 1920; v.videoHeight = 1080;
    app._adBeaconTick(v);
    play(0.25, 30, (t) => { if (t >= 28.5) { v.videoWidth = 1280; v.videoHeight = 720; } });
    ok(sent.length === 2 && sent[1].site_key === 's3' && !('w' in sent[1]) && !('h' in sent[1]), '画面尺寸刚变还没稳(<3 秒):不带宽高', sent[1]);
    // 本机主清单量到的分辨率优先
    app.currentSource = s4; app._playToken = 8; v.currentTime = 0;
    app._adBeaconTick(v);
    play(0.25, 31);
    ok(sent.length === 3 && sent[2].w === 854 && sent[2].h === 480, '主清单(m3u8)量到的分辨率优先于画面尺寸', sent[2]);
    // 多集作品不报时长;暂停中不算
    app.episodeList = [{ name: '1', url: 'a' }, { name: '2', url: 'b' }];
    app.currentSource = s2; app._playToken = 6; v.currentTime = 0; v.paused = true;
    app._adBeaconTick(v);
    play(0.25, 40);
    ok(sent.length === 3, '暂停中不算');
    v.paused = false;
    play(40.25, 72);
    ok(sent.length === 4 && sent[3].site_key === 's2' && !sent[3].dur, '多集作品不报时长(时长是这一集的)', sent[3]);
    // 短片:按时长一半(至少 3 秒)
    const app3 = makeApp();
    const sh = { site_key: 's5', vod_id: 55 };
    app3.currentGroup = { name: 'short', _wk: 't:short', sources: [sh] }; app3.currentSource = sh; app3._playToken = 1; app3.episodeList = [{ name: '正片', url: 'x' }];
    const vs = { currentTime: 0, paused: false, error: null, videoWidth: 720, videoHeight: 1280, duration: 12 };
    app3._adBeaconTick(vs);
    for (let t = 0.25; t <= 6.01; t += 0.25) { vs.currentTime = t; app3._adBeaconTick(vs); }
    ok(sent.length === 5 && sent[4].site_key === 's5' && sent[4].dur === 12 && sent[4].w === 720, '12 秒短片:播满 6 秒就报', sent[4]);
    const app2 = makeApp();
    app2.currentGroup = { name: 'n', sources: [s2] }; app2.currentSource = s2; app2._playToken = 1;
    for (let t = 0; t <= 40; t += 0.25) { v.currentTime = t; app2._adBeaconTick(v); }
    ok(sent.length === 5, '没有 _wk 的(非目录作品)不报');
    // 失败:原生 HLS 设备不报;hls.js 设备报 err;断网不报
    const Hls0 = globalThis.Hls;
    delete globalThis.Hls;
    app._adBeaconFail(s1, { error: { code: 3 } });
    ok(sent.length === 5, '原生 HLS 设备(iOS)不报失败(设备问题不能给所有人判失效)');
    globalThis.Hls = { isSupported: () => true };
    app._adBeaconFail(s1, { error: { code: 3 } });
    app._adBeaconFail(s2, null);
    ok(sent.length === 7 && eq(sent[5], { wk: 'c:K-1', site_key: 's1', vod_id: 11, ok: false, err: 'hls:media3' }) && sent[6].err === 'hls:nostart', 'hls.js 设备:确认放不了 → 报失败(带错误码)', sent.slice(5));
    const nav0 = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    app._adBeaconFail(s1, null);
    ok(sent.length === 7, '断网时不报');
    if (nav0) Object.defineProperty(globalThis, 'navigator', nav0); else delete globalThis.navigator;
    app._activeOffCached = true; app._adBeaconFail(s1, null); app._activeOffCached = false;
    app.currentGroup._isLive = true; app._adBeaconFail(s1, null); app.currentGroup._isLive = false;
    ok(sent.length === 7, '离线缓存 / 直播不报');
    if (Hls0) globalThis.Hls = Hls0; else delete globalThis.Hls;
    A.beacon.send = send0;
}
{
    // 线路列表接到真组件:失效进「可能无法播放」组垫底、同家镜像挨着(= 自动换源顺序)、自动选源不先挑失效的
    const app = makeApp({ srcRev: 0, siteProfiles: {} });
    globalThis.Hls = { isSupported: () => true };
    const mk = (k, lat, o) => Object.assign({ site_key: k, site_name: k, vod_id: 1, latency: lat, _testType: 'direct', site_profile: { tier: 'clean' } }, o || {});
    const a = mk('a', 100, { _family: 'F' }), b = mk('b', 120), c = mk('c', 300, { _family: 'F' }), d = mk('d', 50, { _dead: true }), e = mk('e', 200, { _variant: '中字' });
    app.currentGroup = { name: 'n', _wk: 'c:L-1', sources: [a, b, c, d, e] };
    app.currentSource = a;
    let order = null, groupsOk = false;
    try {
        order = app.availableSources.map(s => s.site_key).join('');
        const G = app.sourceGroups;
        groupsOk = G[G.length - 1].tier === 'unreach' && G[G.length - 1].items[G[G.length - 1].items.length - 1] === d;
    } catch (err) { order = 'ERR ' + err.message; }
    ok(order === 'acbed' && groupsOk, '显示/换源顺序:同家镜像 c 紧跟 a,失效 d 进「可能无法播放」组最后', order);
    ok(app._srcReachClass(d) === 1 && app._srcReachClass(a) === 0 && app._srcReachClass(mk('d2', 50, { _dead: true, _testType: 'proxy' })) === 1
        && app._srcReachClass(mk('d3', 50, { _dead: true, _testType: undefined })) === 2, '失效线路:本机测通也不进第 0 档(降到代理档 1);只有服务器能通的照旧 2');
    let pick = null;
    try { pick = app._autoPick(app.currentGroup.sources, 2); } catch (err) { pick = { site_key: 'ERR' }; }
    ok(pick && pick.site_key !== 'd', '自动选源:最快的那条失效了也不先挑它', pick && pick.site_key);
    try { pick = app._autoPick([d], 2); } catch (err) { pick = null; }
    ok(pick === d, '只剩失效线路时照样能选(不藏)');
    try { pick = app._autoPick([d], 1); } catch (err) { pick = null; }
    ok(pick === d, '整部作品都被判失效:3s 提前起播(只看 0~1 档)也挑得到,不用等 6.5s 兜底');
    const pnd = mk('p', 400, { _testType: 'proxy' });
    try { pick = app._autoPick([d, pnd], 1); } catch (err) { pick = null; }
    ok(pick === pnd, '同档里失效的排最后(哪怕它更快)', pick && pick.site_key);
    // 分辨率:本机实测(localStorage 记忆)优先于别人上报的(beacon)
    const rb = { site_key: 'rx', vod_id: 9, _realRes: { w: 1280, h: 720, from: 'beacon', ts: 0 } };
    app._resMemo = {};
    ok(app._srcRealRes(rb) === rb._realRes, '没有本机实测 → 用上报的分辨率');
    app._resMemo = { 'rx|9': { w: 1920, h: 1080, from: 'play', ts: Date.now() } };
    ok(app._srcRealRes(rb).w === 1920 && app._srcRealRes(rb).from === 'play', '本机实测过 → 本机的优先(别人上报的不压过它)', app._srcRealRes(rb));
    const rl = { site_key: 'rx', vod_id: 9, _realRes: { w: 640, h: 360, from: 'm3u8', ts: 1 } };
    ok(app._srcRealRes(rl).w === 640, '本次会话刚测到的(非上报)照旧最优先');
    app._resMemo = null;
    let fo = null;
    try { fo = app._failoverNext(app.availableSources, a, ''); } catch (err) { fo = null; }
    ok(fo === c, '自动换源:a 放不了先试同家备用 c', fo && fo.site_key);
    // 中字 / 原版
    ok(app.adVarBoth === true && app.adVarCur === 'raw', '既有中字又有原版 → 出切换;当前是原版');
    let picked = null;
    app.pickSourceManual = (s) => { picked = s; app.currentSource = s; };
    app.adVarPick('zh');
    ok(picked === e && app.adult.varPref.kind === 'zh' && app.adVarCur === 'zh' && app.availableSources[0] === e, '点「中字」→ 换到中字线路,中字排到最前(换源也先试中字)', app.availableSources.map(s => s.site_key));
    // 家族:领头 + 1 备用,成员收起;展开
    app.currentSource = b;
    ok(app.adSrcV(a).lead && app.adSrcV(a).more === 1 && app.adSrcV(c).hide, '领头「+1 备用」,成员收起');
    app.adFamToggle(a);
    ok(!app.adSrcV(c).hide && app.adSrcV(a).open, '点「+1 备用」展开');
    // 换一部作品:展开状态和中字选择清掉
    A.mixin.watch.currentGroup.call(app, { name: 'n2', _wk: 'c:L-2', _meta: {}, sources: [] }, app.currentGroup);
    ok(eq(app.adult.famOpen, {}) && app.adult.varPref.kind === '', '换一部:收起备用、清掉中字/原版选择');
    delete globalThis.Hls;
    // 非成人:sourceGroups 不调 _adSrcOrder
    const app3 = makeApp({ adultMode: false, srcRev: 0, siteProfiles: {} });
    app3.currentGroup = { name: 'n', sources: [mk('x', 100), mk('y', 50)] };
    let called = 0;
    app3._adSrcOrder = (x) => { called++; return x; };
    try { void app3.sourceGroups; } catch (err) { }
    ok(called === 0, '非成人站:线路分组完全不经过成人排序');
}
{
    // refreshSources 重建线路对象时保留成人字段;同家镜像(首集地址相同)不被同片源去重吃掉
    const app = makeApp();
    app.currentGroup = { name: '规范名', _wk: 'c:R-2', sources: [{ site_key: 'old', vod_id: 9 }] };
    app.currentSource = app.currentGroup.sources[0];
    app._isKzSource = () => false; app._kzSameTitle = () => false; app._applyServerCheck = () => { };
    net.handler = (u) => (u === '/api/catalog/work?k=c%3AR-2&expand=1' ? { body: { name: '规范名', _wk: 'c:R-2', sources: [
        { site_key: 'm1', site_name: '镜像一', vod_id: 1, vod_name: 'x', _family: 'fam', _variant: '中字', _dur: 7200, vod_play_url: '正片$https://cdn.test/p/1/index.m3u8' },
        { site_key: 'm2', site_name: '镜像二', vod_id: 1, vod_name: 'x', _family: 'fam', _dead: true, vod_play_url: '正片$https://cdn.test/p/1/index.m3u8' },
        { site_key: 'u1', site_name: '同片源', vod_id: 2, vod_name: 'x', vod_play_url: '正片$https://cdn.test/q/2/index.m3u8' },
        { site_key: 'u2', site_name: '同片源二', vod_id: 3, vod_name: 'x', _native: 'risky', _same: 'up', _res: '1280x720', vod_play_url: '正片$https://cdn.test/q/2/index.m3u8' }] } } : null);
    try { await app.refreshSources(); } catch (e) { }
    const by = Object.fromEntries(app.currentGroup.sources.map(s => [s.site_key, s]));
    ok(by.m1 && by.m2 && by.m1._family === 'fam' && by.m1._variant === '中字' && by.m1._dur === 7200 && by.m2._dead === true, 'refreshSources:同家镜像都留下,_family/_variant/_dur/_dead 带过来', Object.keys(by));
    ok(Object.keys(by).filter(k => k[0] === 'u').length === 1, '不同家的同片源照旧去重(③)', Object.keys(by));
}
{
    // 从搜索结果 / 历史打开(有 _wk 没 _meta):补拉一次作品,挂上信息条和线路标记
    const app = makeApp();
    const s1 = { site_key: 's1', vod_id: 1 }, s2 = { site_key: 's2', vod_id: 'b' };
    const g = { name: 'n', _wk: 'c:E-1', sources: [s1, s2] };
    net.calls.length = 0;
    net.handler = (u) => (u === '/api/catalog/work?k=c%3AE-1' ? { body: { name: 'n', _wk: 'c:E-1', _meta: { code: 'E-1', bucket: 'jp_censored' }, sources: [{ site_key: 's1', vod_id: 1, _family: 'F', _res: '1920x1080' }, { site_key: 's2', vod_id: 'b', _dead: true }] } } : null);
    app.currentGroup = g;
    A.mixin.watch.currentGroup.call(app, g, null);
    await sleep(5); for (let i = 0; i < 4; i++) await tick();
    ok(g._meta && g._meta.code === 'E-1' && s1._family === 'F' && s1._realRes && s1._realRes.w === 1920 && s2._dead === true && app.adMeta && app.adMeta.code === 'E-1', '补拉:_meta 挂上、线路标记合进去', g._meta);
    A.mixin.watch.currentGroup.call(app, g, g);
    await sleep(5);
    ok(net.calls.filter(u => u.startsWith('/api/catalog/work')).length === 1, '同一个 group 只补拉一次');
    const frame = { name: 'x', _wk: 'c:E-2', sources: [] };
    A.mixin.watch.currentGroup.call(app, frame, g);
    await sleep(5);
    ok(net.calls.filter(u => u.startsWith('/api/catalog/work')).length === 1, '加载帧(还没有线路)不补拉(openWork 自己在拉)');
}
{
    // 信息条按钮:分类/标签 → 关掉播放页开浏览页;前缀/演员 → 全站搜;兄弟作品 → openWork
    const app = makeApp();
    let br = null, ow = null, searched = 0, closed = 0;
    app.showDetail = true;
    app.closeDetail = () => { closed++; app.showDetail = false; };
    app.openBrowse = (p) => { br = p; };
    app.openWork = (x) => { ow = x; };
    app.doSearch = () => { searched++; };
    app.currentGroup = { name: 'n', _wk: 'c:M-1', _meta: { code: 'M-1', bucket: 'jp_censored', tags: [{ id: 'busty', label: '巨乳美乳', featured: true }] }, sources: [{ site_key: 's' }] };
    app.adMetaGo({ b: 'jp_censored', tag: 'busty' });
    ok(closed === 1 && eq(br, { type: 'jp', sel: { b: 'jp_censored', tag: 'busty' } }), '标签按钮 → 关播放页,按这部的分类 + 标签开浏览页', br);
    app.showDetail = true;
    app.adMetaPrefix('ssis');
    ok(closed === 2 && eq(br, { type: 'all', sel: { lp: 'SSIS' } }) && searched === 0, '厂牌前缀 → 关播放页,开「全部」浏览页按厂牌筛(本地目录,不全站搜)', br);
    app.showDetail = true;
    app.adMetaPrefix('../x');
    ok(closed === 2 && br.sel.lp === 'SSIS', '坏前缀不动');
    app.showDetail = true;
    app.adMetaSearch('テスト花子');
    ok(closed === 3 && app.keyword === 'テスト花子' && searched === 1, '演员 → 关播放页,全站搜这个名字');
    ok(HTML.includes('@click="adMetaPrefix(adMeta.prefix)"') && !HTML.includes('adMetaSearch(adMeta.prefix)') && HTML.includes('v-if="adultMode && browse.sel.lp"') && HTML.includes("@click=\"setBrowseFilter('lp', '')\""),
        'index.html:前缀按钮走 adMetaPrefix;浏览页有可取消的厂牌行');
    app.adOpenSibling({ wk: 'c:M-1#U', name: 'M-1 [无码流出]' });
    ok(ow && ow._wk === 'c:M-1#U' && ow.title === 'M-1 [无码流出]', '「另有无码流出版」→ 开那一部');
    app.adOpenSibling({ wk: 'javascript:alert(1)' });
    ok(ow._wk === 'c:M-1#U', '坏键不开');
    // 复制番号
    const toasts0 = app.toasts.length;
    const nav0 = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let copied = null;
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true });
    app.adCopyCode();
    await tick(); await tick();
    ok(copied === 'M-1' && app.toasts.length === toasts0 + 1 && /已复制番号/.test(app.toasts[app.toasts.length - 1]), '复制番号(剪贴板 + 提示)');
    if (nav0) Object.defineProperty(globalThis, 'navigator', nav0); else delete globalThis.navigator;
}
{
    // 浏览页标签行:按当前分类拉 /api/catalog/tags(10 分钟缓存);从标签词进来的非 featured 标签也挂上
    const app = makeApp();
    net.calls.length = 0;
    net.handler = (u) => (u.startsWith('/api/catalog/tags') ? { body: { tags: [{ id: 'busty', label: '巨乳美乳', count: 9, featured: true }, { id: 'noncon', label: '强制凌辱', count: 99, featured: false }] } } : null);
    app.browse.open = true; app.browse.type = 'jp'; app.browse.sel = { b: 'jp_censored', dur: '', flag: '', sort: 'new' };
    ok(app.adTagKey === 't|jp_censored', 'adTagKey 跟着当前分类');
    app._adLoadTags();
    await sleep(5); for (let i = 0; i < 4; i++) await tick();
    ok(eq(net.calls, ['/api/catalog/tags?b=jp_censored']) && eq(app.adTagOpts.map(t => t.id), ['busty']), '标签行:只出 featured 的', app.adTagOpts);
    app.browse.sel = Object.assign({}, app.browse.sel, { tag: 'noncon' });
    ok(eq(app.adTagOpts.map(t => t.id), ['busty', 'noncon']), '已选的非 featured 标签(从搜索词进来)挂在后面,能看见、能取消');
    app._adLoadTags();
    ok(net.calls.length === 1, '同一分类 10 分钟内不重拉');
    app.browse.type = 'all'; app.browse.sel = { b: '', dur: '', flag: '', sort: 'new' };
    ok(app.adTagKey === 't|', '「全部」大类:不限分类的标签');
    app.browse.open = false;
    ok(app.adTagKey === '' && eq(app.adTagOpts, []), '浏览页关着:不拉');
}
{
    // 购买地址 / 续费提示:没配不出;只认 http(s);HTML 转义
    ok(A.brand.applyBuy('javascript:alert(1)') === '' && A.brand.buyUrl() === '' && A.brand.renewHtml() === '' && A.brand.renewText() === '', '没配 / 不是 http(s) 的 purchase_url:不出购买按钮和续费地址');
    const u = A.brand.applyBuy('https://shop.example.test/buy?a="1"&b=<2>');
    const h = A.brand.renewHtml();
    ok(u && A.brand.buyUrl() === u && /href="https:\/\/shop\.example\.test\/buy\?a=%221%22&amp;b=%3C2%3E"/.test(h) && />shop\.example\.test<\/a> 续费/.test(h) && !/<2>/.test(h) && A.brand.renewText() === '\n\n前往续费: ' + u, 'purchase_url:续费链接指向它、转义', h);
    A.brand.applyBuy(undefined);
    ok(A.brand.buyUrl() === '', '/api/config 不再给 purchase_url → 清掉本机记的');
    const SRC = fs.readFileSync(path.join(ROOT, 'public/adult/adult.js'), 'utf8');
    ok(SRC.includes("'html:not(.dg-buy) #register-link { display: none !important; }'"), '登录框「购买套餐」块:没有 dg-buy 类就藏(压得住切登录方式时的行内 display)');
    // 模糊封面
    const app = makeApp();
    app.adSetBlur(true);
    ok(store.get('dg_blur_cover') === '1' && app.adult.blur === true, '模糊封面:存本机');
    app.adSetBlur(false);
    ok(store.get('dg_blur_cover') === '0' && app.adult.blur === false, '关掉');
    ok(/html\.dg-blur \.poster-wrap img/.test(SRC) && /\.hot-card:hover \.poster-wrap img/.test(SRC), '模糊封面的样式:悬停 / 焦点 / 按住看清');
}

console.log('⑤ 页面接线 / sw.js');
{
    const head = HTML.slice(0, HTML.indexOf('</head>'));
    const headNoComments = head.replace(/<!--[\s\S]*?-->/g, '');
    ok(/<title>DGX<\/title>/.test(head) && !/E视界/.test(headNoComments) && !/E视界/.test(head), '<title> 是站名,head 里不再有主站品牌');
    ok(/<meta name="robots" content="noindex, nofollow, noarchive">/.test(head) && !/og:|twitter:|rel="canonical"|ednovas\.video/.test(head), 'robots noindex;没有 OG / Twitter 卡片 / canonical / 主站域名');
    ok(!/<link rel="(dns-prefetch|preconnect)" href="[^"]*(tmdb|themoviedb)/.test(headNoComments), '不预连接 TMDB');
    const iAdult = head.indexOf('src="adult/adult.js?v=3"'), iVue = head.indexOf('vue.global.prod.min.js');
    ok(iAdult > 0 && iAdult < iVue && !/src="adult\/adult\.js[^"]*"[^>]*\b(defer|async)\b/.test(head), 'adult.js 在 Vue 之前同步加载');
    const body = HTML.slice(HTML.indexOf('<body>'));
    const iGate = body.indexOf('DgAdult.ageGate.mount()'), iLoader = body.indexOf('id="app-loader"'), iPw = body.indexOf('id="password-screen"');
    ok(iGate > 0 && iGate < iLoader && iLoader < iPw, '年龄门挂在 body 最前(先于 loader 和登录框)');
    ok(/document\.addEventListener\('DOMContentLoaded', \(\) => \{\s*if \(!window\.DgAdult \|\| !window\.DgAdult\.ageGate\) return;\s*window\.DgAdult\.ageGate\.whenAccepted\(\)\.then\(\(\) => checkAuthStatus\(\)\);/.test(HTML), '登录检查等年龄确认之后才跑;adult.js 没加载就不启动');
    ok(/#heroCarousel \{ display: none !important; \}/.test(fs.readFileSync(path.join(ROOT, 'public/adult/adult.js'), 'utf8')), '首页轮播空壳在成人站藏掉(adult.js 样式)');
    const settings = HTML.slice(HTML.indexOf('<!-- NSFW 过滤开关 -->'), HTML.indexOf('<!-- 📐 封面/文字大小'));
    ok((settings.match(/v-if="!adultMode"/g) || []).length === 1 && (settings.match(/v-if="!adultMode \|\| adult\.intro"/g) || []).length === 2,
        '设置:过滤成人内容 在成人站隐藏;跳过按钮 / 自动跳过 只在站长开了片头学习时显示');
    ok(/<button v-if="requestsEnabled"/.test(HTML) && /v-if="pushUi !== 'hidden'"/.test(HTML), '求片 / 推送 设置行跟着 /api/config(成人站默认关)');
    ok(/<button class="btn-cast" v-if="!adultMode" tabindex="2" @click="openSharePanel"/.test(HTML), '播放页分享按钮隐藏');
    const rowClicks = (HTML.match(/@click="item\._wk \? openWork\(item\) : autoSearch\(/g) || []).length;
    ok(rowClicks === 2, '首页行(横排 + 展开网格)的目录卡片点开走 openWork', rowClicks);
    ok((HTML.match(/class="dg-ad-badge"/g) || []).length === 3, '首页行两处 + 浏览页一处都有 中字/无码/竖屏 角标');
    ok(!/<span[^>]*>MAX<\/span>/.test(body.slice(0, body.indexOf('<div id="app"'))) && (body.match(/data-dg-brand/g) || []).length >= 2, 'loader / 登录框的「视界 MAX」换成站名');
    // phase 2 模板接线
    ok((HTML.match(/<template v-if="item\._wk"><span v-if="item\._n >= 2" class="dg-ov-n">\{\{ item\._n \}\}线<\/span><span v-if="item\._durText" class="dg-ov-dur">\{\{ item\._durText \}\}<\/span><span v-if="item\._code" class="dg-ov-code">\{\{ item\._code \}\}<\/span><\/template>/g) || []).length === 3,
        '首页行两处 + 浏览页:海报上叠 N线(≥2)/ 时长 / 番号');
    ok(/<span v-if="config\.adult && config\.srcLabel" class="dg-row-src" :title="config\.srcTip">\{\{ config\.srcLabel \}\}<\/span>/.test(HTML), '热门行标题旁的来源角标(本站热门 / 外站热门)');
    ok(/<button v-if="key !== 'randomRow'" v-show="!\(config\.adult && !config\.more\)" type="button" class="expand-toggle row-all"/.test(HTML), '没有 more 的目录行(热门)不给「全部」');
    ok(/<div class="browse-frow" v-if="adultMode && adTagOpts\.length" role="group" aria-label="标签">/.test(HTML) && /@click="setBrowseFilter\('tag', t\.id\)"/.test(HTML), '浏览页第二行:标签按钮(setBrowseFilter tag)');
    ok(/<div class="search-section" @focusout="adultMode && adSugBlur\(\$event\)"/.test(HTML) && /@keydown="adultMode && adSugKey\(\$event\)" @focus="adultMode && adSugFocus\(\)"/.test(HTML)
        && /<div v-if="adultMode && adult\.sug\.open && adSugRows\.length" class="dg-sug"/.test(HTML) && /@mousedown\.prevent @click="adSugPick\(r\)"/.test(HTML), '搜索建议下拉:焦点离开收起、方向键、点行不先失焦');
    ok(/if \(this\.adultMode && typeof this\.adSuggestInput === 'function' && this\.adSuggestInput\(this\.keyword\)\) return;\s*\n\s*if \(!this\.keyword \|\| this\.keyword\.length < 2\)/.test(HTML), 'debouncedSearch 最前面:成人站交给搜索建议(不再自动全站搜)');
    ok(/<template v-if="adultMode && adMeta && !previewLocked">/.test(HTML) && /@click="adCopyCode"/.test(HTML) && /adMetaGo\(\{ b: adMeta\.bucket, tag: t\.id \}\)/.test(HTML)
        && /<details v-if="adMeta\.clips\.length" class="dg-meta-clips">/.test(HTML) && /@click="adOpenSibling\(s\)">\{\{ s\.label \}\}/.test(HTML), '播放页信息条:复制番号 / 分类标签 / 无码流出版链接 / 解说片段折叠');
    ok(/<div v-else class="ep-grid" v-show="!\(adultMode && episodeList\.length === 1\)"/.test(HTML), '单集作品藏选集格子');
    ok(/<div v-for="\(source, i\) in g\.items" class="source-pill" v-show="!\(adultMode && adSrcV\(source\)\.hide\)"/.test(HTML) && /'dg-src-dead': adultMode && source\._dead === true/.test(HTML)
        && /@click\.stop="adFamToggle\(source\)"/.test(HTML) && /本设备可能无法播放/.test(HTML) && />同源<\/span>/.test(HTML), '线路:家族收起(+N 备用)/ 失效置灰 / 同源 / 本设备可能无法播放');
    ok(/<span v-if="adultMode && adVarBoth && !previewLocked" class="dg-var-seg"/.test(HTML), '「中字 / 原版」切换');
    ok(/const items = \(this\.adultMode && typeof this\._adSrcOrder === 'function'\) \? this\._adSrcOrder\(items0\) : items0;/.test(HTML) && /p\.tier === 'unknown' \|\| s\._dead === true\) \? 'unreach'/.test(HTML)
        && /if \(s\._dead === true\) return \(s\._testType === 'direct' \|\| s\._testType === 'proxy'\) \? 1 : 2;/.test(HTML)
        && /return \(\(a\._dead === true \? 1 : 0\) - \(b\._dead === true \? 1 : 0\)\)/.test(HTML), 'sourceGroups 组内重排 + 失效进可能无法播放组;_srcReachClass 失效最多到代理档、_pickPreferred 同档失效垫底');
    ok(/if \(this\.adultMode\) \{ try \{ this\._adBeaconFail\(failingSource, v\); \} catch \(e\) \{ \} \}[^\n]*\n\s*failingSource\.latency = 9998;/.test(HTML) && /this\._adBeaconFail\(failingSource, v0\)/.test(HTML), '线路反馈:自动换源确认放不了 / 全部试完时报失败');
    ok(/if \(this\.adultMode && dp\.video\) \{ try \{ this\._adBeaconTick\(dp\.video\); \} catch \(e\) \{ \} \}/.test(HTML), '线路反馈:timeupdate 里报起播(出错也不影响播放器的其他 tick)');
    ok(/\.\.\.\(\(data\._adult && this\.adultMode\) \? this\._adSrcExtra\(item\) : \{\}\)/.test(HTML) && /if \(!u \|\| it\._family\) \{ result\.push\(it\); return; \}/.test(HTML), 'refreshSources 保留成人字段;同片源去重不吃同家镜像');
    ok((HTML.match(/window\.DgAdult\.brand\.renew(Html|Text)\(\)/g) || []).length === 3, '三处续费提示:成人站用 purchase_url(没配不提主站地址)');
    ok(/<div class="set-row" v-if="adultMode">[\s\S]{0,400}模糊封面[\s\S]{0,600}@change="adSetBlur\(\$event\.target\.checked\)"/.test(HTML), '设置里的「模糊封面」开关');
    // 标了 [adult] 的行里注释不在标签中间(浏览器会把它当属性,模板整个坏掉)
    const badCm = HTML.split('\n').filter(l => l.includes('<!-- [adult]')).filter(l => { const pre = l.split('<!--')[0]; return pre.lastIndexOf('<') > pre.lastIndexOf('>'); });
    ok(!badCm.length, '[adult] 注释没有写进标签里面', badCm.map(l => l.trim().slice(0, 80)));
    // 整个 #app 模板交给 Vue 编译器(vue.global.prod.min.js)编一遍:语法错 / 表达式错在这里就暴露
    {
        const s = HTML.indexOf('<div id="app" v-cloak>');
        const re = /<\/?div\b[^>]*>/g;
        re.lastIndex = s;
        let depth = 0, end = -1, mm;
        while ((mm = re.exec(HTML))) { if (mm[0][1] === '/') depth--; else depth++; if (depth === 0) { end = mm.index + mm[0].length; break; } }
        const tpl = HTML.slice(s, end);
        const vctx = { console: { log() { }, warn() { }, error() { } }, setTimeout, clearTimeout, navigator: { userAgent: 'node' }, document: { createElement: () => ({ style: {} }) }, SVGElement: function () { }, Element: function () { } };
        vctx.window = vctx; vctx.self = vctx;
        let errs = [], compiled = false;
        try {
            vm.createContext(vctx);
            vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/libs/js/vue.global.prod.min.js'), 'utf8'), vctx);
            const fn = vctx.Vue.compile(tpl, { decodeEntities: (x) => x, onError: (e) => errs.push(e.message) });
            compiled = typeof fn === 'function';
        } catch (e) { errs.push(String(e && e.message).slice(0, 200)); }
        ok(compiled && !errs.length && tpl.includes('dg-meta-code') && tpl.includes('dg-sug-row'), '#app 模板能被 Vue 编译(含 phase 2 新加的信息条/建议/线路标记)', errs.slice(0, 5));
    }
    const SW = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
    // 主线的 CACHE_VERSION 字面不动(别的测试钉着它);成人站用 ADULT_REV 换缓存名 = 升版
    const ver = +((/const CACHE_VERSION = 'v(\d+)'/.exec(SW) || [])[1] || 0), rev = (/const ADULT_REV = '([^']+)'/.exec(SW) || [])[1] || '';
    ok(ver >= 42 && /^-adult\d+$/.test(rev) && ['static', 'images', 'live-img'].every(n => SW.includes("'donggua-" + n + "-' + CACHE_VERSION + ADULT_REV")),
        'sw.js 升版:三个缓存名都带成人站版本(新 SW 重新预缓存、activate 清掉旧缓存)', [ver, rev]);
    ok(SW.includes("'./adult/adult.js?v=3'"), 'sw.js 预缓存的 adult.js 与页面引用同一个 ?v=');
    // 真跑 sw.js 的 fetch 处理:哪些请求 SW 接手
    const handlers = {};
    const swCtx = {
        self: { addEventListener: (t, f) => { handlers[t] = f; }, location: { origin: 'https://site.test' }, skipWaiting() { }, clients: { claim() { } }, registration: {} },
        caches: { open: async () => ({ match: async () => null, put: async () => { }, keys: async () => [] }), keys: async () => [], delete: async () => true, match: async () => null },
        fetch: async () => new Response('x'), Response, URL, Promise, console, setTimeout, clearTimeout,
    };
    vm.runInNewContext(SW, swCtx);
    const handled = (url, dest) => {
        let took = false;
        const req = { url, destination: dest || '', headers: { has: () => false }, mode: dest === 'document' ? 'navigate' : 'cors', method: 'GET' };
        handlers.fetch({ request: req, respondWith() { took = true; }, waitUntil() { } });
        return took;
    };
    ok(!handled('https://img.other-cdn.test/upload/a.jpg', 'image') && !handled('https://img.other-cdn.test/b.webp'), '跨域海报不进 SW 缓存');
    ok(!handled('https://site.test/api/catalog/home') && !handled('https://site.test/api/catalog/browse?b=x&page=1') && !handled('https://site.test/api/detail?site_key=a&id=1') && !handled('https://site.test/api/search?wd=x'), '目录/详情/搜索接口直达不缓存');
    ok(!handled('https://site.test/api/sites') && !handled('https://site.test/api/check?key=a') && !handled('https://site.test/api/catalog/suggest?q=a') && !handled('https://site.test/api/img?k=c%3AA-1&s=s1', 'image'),
        'phase 2:/api/sites、/api/check、/api/catalog/*(含 suggest/tags/beacon)、/api/img 海报代理都直达不缓存');
    ok(/const ADULT_REV = '-adult3';/.test(SW), 'sw.js 成人站升版到 -adult3(adult.js?v=3 重新预缓存、旧缓存清掉)');
    ok(handled('https://site.test/adult/adult.js?v=3') && handled('https://site.test/api/config') && handled('https://site.test/', 'document'), '外壳(页面/adult.js)和 /api/config 照旧由 SW 接手');
}

console.log(`\n${fail ? '✗' : '✓'} adult-frontend-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
