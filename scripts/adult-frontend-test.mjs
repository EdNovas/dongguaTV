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
//     海报和内容接口不进缓存)
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
    ok(it && it.id === 'c:SSIS-001' && it._wk === 'c:SSIS-001' && it.title === card.name && it.poster_path === card.pic && it._sub === card.sub && it._badge === '中字' && it._n === 6 && !('vote_average' in it), '卡片 → 行/浏览页对象(id=wk,poster_path=完整地址,_sub/_badge)', it);
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
{
    const calls = [];
    const net = { verify: true, search401: 1, sites401: 0 };
    let showLogin = 0;
    globalThis.location = { href: 'https://site.test/', replace() { } };
    globalThis.fetch = async (url, init) => {
        const u = String(url), h = init && init.headers;
        calls.push({ url: u, tok: h && h.get ? h.get('x-dg-token') : null, age: h && h.get ? h.get('x-dg-age') : null, method: (init && init.method) || 'GET' });
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
    ok(Object.keys(A.mixin.watch).every(k => k in D), 'mixin 监听的都是主组件已有的 data(showDetail)');
    // 主组件里用到的 mixin 方法都存在
    const used = ['adultApplyConfig', 'adultLoadHome', 'adToday', 'openWork', '_adWorkList', '_adImgFallback'];
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
        adultMode: true, adult: { catalog: true, siteName: 'DGX', today: {}, home: 'idle' },
        browse: { open: false, type: 'cn', sel: {}, items: [], page: 0, totalPages: 0, total: 0, loading: false, error: false, done: false, idle: 0, seq: 0, keyword: '', auto: false, fromDir: false },
        rawList: [], imageMap: {}, fallbackMap: {}, rowConfigs: {}, rowLists: {}, watchHistory: [], favList: [], recommendList: [], popularList: [], liveChannels: [],
        homeLayout: [{ k: 'history', on: true }, { k: 'fav', on: true }, { k: 'recommend', on: true }, { k: 'popular', on: true }, { k: 'live', on: true }, { k: 'catnav', on: true }, { k: 'random', on: true }],
        favoritesEnabled: true, liveEnabled: false, showDetail: false, currentGroup: null, currentSource: null, episodeList: [], currentUrl: '',
        isTestingSources: false, refreshingSources: false, deepLinkLoading: false, deepLinkSourceCount: 0, previewLocked: false, searched: false, catDirOpen: false,
        filterNsfw: true, isTVMode: false, $refs: {}, toasts: [], opened: [], closed: 0,
        $nextTick(f) { if (f) f(); return Promise.resolve(); },
    }, over || {});
    for (const n of Object.keys(CPm)) Object.defineProperty(app, n, { get: () => CPm[n].call(app), configurable: true });
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
    // 回车搜番号:本地目录恰好一部作品 → 直接开作品页,不全站扇出;其余照常 doSearch
    const run = async (kw, body, explicit) => {
        const app = makeApp();
        let ow = null, searched = 0;
        app.openWork = (it) => { ow = it; };
        app.doSearch = () => { searched++; };
        app.keyword = kw;
        net.calls.length = 0;
        net.handler = (u) => (u.startsWith('/api/catalog/lookup') ? (body ? { body } : { status: 503, body: { error: 'CATALOG_UNAVAILABLE' } }) : null);
        app.submitSearch(explicit);
        for (let i = 0; i < 6; i++) await tick();
        return { ow, searched, calls: net.calls.slice() };
    };
    let r = await run('SSIS-001', { kind: 'code', key: 'SSIS-001', results: [{ wk: 'c:SSIS-001', name: 'SSIS-001 合成标题', pic: 'https://p/1.jpg' }] }, true);
    ok(r.ow && r.ow._wk === 'c:SSIS-001' && r.ow.title === 'SSIS-001 合成标题' && r.searched === 0 && r.calls[0] === '/api/catalog/lookup?q=SSIS-001&limit=2', '回车搜番号:本地目录恰好一部 → 直接开作品页,不全站搜', r);
    r = await run('SSIS-002', { kind: 'code', key: 'SSIS-002', results: [{ wk: 'c:SSIS-002', name: 'a' }, { wk: 'c:SSIS-002#clip', name: 'b' }] }, true);
    ok(!r.ow && r.searched === 1, '番号命中多个作品(正片 + 片段)→ 照常全站搜', r);
    r = await run('某某片名', { kind: 'text', key: null, results: [{ wk: 't:x', name: 'x' }] }, true);
    ok(!r.ow && r.searched === 1, '文字查询 → 照常全站搜(不直接开)', r);
    r = await run('SSIS-001', null, true);
    ok(!r.ow && r.searched === 1, '目录不可用(503)→ 照常全站搜', r);
    r = await run('SSIS-001', { kind: 'code', key: 'SSIS-001', results: [{ wk: 'c:SSIS-001', name: 'x' }] }, false);
    ok(!r.ow && r.searched === 1 && !r.calls.some(u => u.startsWith('/api/catalog/lookup')), '输入停顿的自动搜索不查本地、不自动开作品页', r);
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

console.log('⑤ 页面接线 / sw.js');
{
    const head = HTML.slice(0, HTML.indexOf('</head>'));
    const headNoComments = head.replace(/<!--[\s\S]*?-->/g, '');
    ok(/<title>DGX<\/title>/.test(head) && !/E视界/.test(headNoComments) && !/E视界/.test(head), '<title> 是站名,head 里不再有主站品牌');
    ok(/<meta name="robots" content="noindex, nofollow, noarchive">/.test(head) && !/og:|twitter:|rel="canonical"|ednovas\.video/.test(head), 'robots noindex;没有 OG / Twitter 卡片 / canonical / 主站域名');
    ok(!/<link rel="(dns-prefetch|preconnect)" href="[^"]*(tmdb|themoviedb)/.test(headNoComments), '不预连接 TMDB');
    const iAdult = head.indexOf('src="adult/adult.js?v=2"'), iVue = head.indexOf('vue.global.prod.min.js');
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
    const SW = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
    // 主线的 CACHE_VERSION 字面不动(别的测试钉着它);成人站用 ADULT_REV 换缓存名 = 升版
    const ver = +((/const CACHE_VERSION = 'v(\d+)'/.exec(SW) || [])[1] || 0), rev = (/const ADULT_REV = '([^']+)'/.exec(SW) || [])[1] || '';
    ok(ver >= 42 && /^-adult\d+$/.test(rev) && ['static', 'images', 'live-img'].every(n => SW.includes("'donggua-" + n + "-' + CACHE_VERSION + ADULT_REV")),
        'sw.js 升版:三个缓存名都带成人站版本(新 SW 重新预缓存、activate 清掉旧缓存)', [ver, rev]);
    ok(SW.includes("'./adult/adult.js?v=2'"), 'sw.js 预缓存的 adult.js 与页面引用同一个 ?v=');
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
    ok(handled('https://site.test/adult/adult.js?v=2') && handled('https://site.test/api/config') && handled('https://site.test/', 'document'), '外壳(页面/adult.js)和 /api/config 照旧由 SW 接手');
}

console.log(`\n${fail ? '✗' : '✓'} adult-frontend-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
