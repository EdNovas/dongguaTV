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
//  ⑦ phase 3(契约 C):facets 归一化(审查类只进「更多」不带数、blocked 一律丢、服务器标错也不做按钮)/ 标签行 / 点标签(选中 · 排除 · 各 ≤3)/
//     筛选参数与地址 / 地址栏路由(#/c/<大类>?… · #/tag/<id> · #/actress/<aid> · #/tags?b=,只有 id)/ 后退前进 / 播放页开着按返回 /
//     筛选面板的历史(压一条、替换、退掉再压最终筛选)/ 游标翻页 + 按页退路 / 不按 600 张封顶 / 新片速递 / 卡片发行日 /
//     信息条(发行日 · 厂牌 · 女优 aid · 按分面组的标签)/ 标签云 / 标签页 / 女优 / 厂牌 / 组件逻辑(窗口化网格、筛选面板)与模板编译
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
    ok(A.upgradeMixed('http://vfile.meituan.net/a/1.png') === 'https://vfile.meituan.net/a/1.png' && A.upgradeMixed('http://cdn.example/x.ts') === 'http://cdn.example/x.ts'
        && A.upgradeMixed('http://vfile.meituan.net.evil.example/x') === 'http://vfile.meituan.net.evil.example/x' && A.upgradeMixed('https://vfile.meituan.net/a') === 'https://vfile.meituan.net/a',
        '混合内容:红楼系 vfile.meituan.net 的 http 分片改 https(别的主机、仿冒域名不动)');
    // 分类:与 lib/adult 的导航桶完全一致,每个桶恰好落在一个大类里
    const nav = X.taxonomy.NAV_BUCKETS.slice().sort();
    ok(eq(A.NAV_BUCKETS.slice().sort(), nav), '17 个导航桶与 lib/adult/taxonomy 一致', A.NAV_BUCKETS);
    const inTypes = A.TYPES.flatMap(T => T.buckets.map(b => b[0]));
    ok(eq(inTypes.concat(['fetish', 'asia']).sort(), nav) && new Set(inTypes).size === inTypes.length, '除 SM·重口 / 韩国·东南亚(只从 全部 进)外,每个导航桶恰好在一个大类里', inTypes);
    const lab = Object.fromEntries(X.taxonomy.BUCKETS.map(b => [b.id, b.label]));
    ok(A.NAV_BUCKETS.every(b => A.BUCKET_LABEL[b] === lab[b]), '桶名与服务器 taxonomy 的 label 一致(服务器没给 /buckets 时的兜底)');
    ok(eq(A.TYPES.map(t => t.k), ['cn', 'jp', 'west', 'anime', 'softcore', 'lgbt', 'short', 'commentary', 'ai_drama', 'all']) && eq(A.TYPES.map(t => t.l), ['国产', '日本', '欧美', '动漫', '三级', '同性', '短视频', 'AV解说', 'AI短剧', '全部']), '大类一排平铺:国产 · 日本 · 欧美 · 动漫 · 三级 · 同性 · 短视频 · AV解说 · AI短剧 · 全部(没有「更多」)');
    ok(eq(A.TYPES[0].buckets.map(b => b[1]), ['自拍', '传媒', '探花', '网红', '主播']) && A.TYPES[0].sub === true && eq(A.TYPES[1].buckets.map(b => b[1]), ['有码', '无码', '中字']) && !A.TYPES.slice(1).some(T => T.sub), '国产 / 日本 的分区;只有国产带细分行');
    const C = A.catalog;
    ok(C.ADULT === true && C.DEFAULT_TYPE === 'cn' && C.typeOf('cn') && !C.typeOf('tv'), '目录版 DgCatalog:默认大类 cn,没有 TMDB 的 tv');
    // normSel
    ok(eq(C.normSel('cn', {}), { b: '', dur: '', v: '', sort: 'new' }) && C.normSel('west', {}).b === 'western' && C.normSel('cn', { b: 'cn_hookup' }).b === 'cn_hookup', 'normSel:多分区大类默认整类(b 空)、单分区大类就是那个分区、最新上架');
    ok(eq(C.normSel('jp', { b: 'cn_amateur', dur: 'x', flag: 'zh', sort: 'bogus' }), { b: '', dur: '', v: 'zh', sort: 'new' }), 'normSel:别的大类的桶/不认识的值 → 默认;旧 flag=zh → v=zh');
    ok(eq(C.normSel('all', { b: 'jp_subbed', sort: 'random' }), { b: '', dur: '', v: '', sort: 'rand' }) && C.normSel('all', { b: 'fetish' }).b === 'fetish' && C.normSel('all', { b: 'asia' }).b === 'asia', 'normSel:「全部」只认不归大类的分区(SM·重口 / 韩国·东南亚);旧 sort=random → rand');
    ok(eq(C.normSel('nope', { b: 'jp_subbed' }), { b: '', dur: '', v: '', sort: 'new' }), 'normSel:不认识的大类按第一个');
    // buildQuery:只给地址(与契约 C 的 /api/catalog/browse 参数一致)
    const q = C.buildQuery('jp', { b: 'jp_uncensored', dur: 'l', flag: 'zh', sort: 'dur' }, 3);
    ok(q.url === '/api/catalog/browse?b=jp_uncensored&dur=l&v=zh&sort=dur&page=3' && eq(q.params, {}) && typeof q.map === 'function', 'buildQuery → /api/catalog/browse 地址(params 空、带卡片映射)', q.url);
    ok(C.buildQuery('all', {}, 0).url === '/api/catalog/browse?sort=new&page=1' && /page=500$/.test(C.buildQuery('cn', {}, 9999).url), 'buildQuery:「全部」不带 b;页码夹在 1..500');
    ok(C.buildQuery('jp', {}, 1).url === '/api/catalog/browse?b=jp_censored,jp_uncensored,jp_subbed&sort=new&page=1' && C.buildQuery('cn', {}, 1).url.indexOf('b=cn_amateur,cn_studio,cn_hookup,creators,live&') > 0
        && C.buildQuery('cn', { b: 'live' }, 1).url.indexOf('b=live&') > 0 && C.buildQuery('all', { b: 'fetish' }, 1).url.indexOf('b=fetish&') > 0, 'buildQuery:国产 / 日本 整类 = 逗号分隔的几个分区;选了细分 / 孤儿分区只发那一个', C.buildQuery('jp', {}, 1).url);
    // 取值与契约 C 一致:sort=new|updated|released|hot|dur|lines|rand、dur=s|m|l|xl|xxl|unk、v=zh|unc|leak|vr|4k|vertical
    ok(eq(A.SORTS.map(s => s.k), ['new', 'updated', 'released', 'hot', 'dur', 'lines', 'rand']) && eq(A.SORTS.map(s => s.l), ['最新上架', '最近更新', '发行日期', '热门', '时长', '线路最多', '随机'])
        && eq(A.DURS.map(d => d.k), ['', 's', 'm', 'l', 'xl', 'xxl', 'unk']) && A.DURS[6].l === '时长未知'
        && eq(A.VARIANTS.map(v => v.k), ['', 'zh', 'unc', 'leak', 'vr', '4k', 'vertical']) && eq(A.VARIANTS.slice(1).map(v => v.l), ['中字', '无码', '流出', 'VR', '4K', '竖屏']), '排序 / 时长 / 版本的取值与名字(契约 C)');
    const GATE = fs.readFileSync(path.join(ROOT, 'lib/adult-gate/index.js'), 'utf8');
    const srvSorts = (/sort: pick\(q\.sort, \[([^\]]*)\]/.exec(GATE) || [])[1] || '';
    // 服务器换成 phase 3 的白名单(带 released)之后:前端每个排序值都得在里面(并行开发期间旧白名单不判)
    ok(!/'released'/.test(srvSorts) || A.SORTS.every(s => srvSorts.includes("'" + s.k + "'")), '服务器 browseQuery 换成 phase 3 白名单后,前端排序值都在里面', srvSorts);
    // 筛选行 / 分类栏 / 标题
    ok(eq(C.groupsOf('cn', {}).map(g => g.k), ['b']) && eq(C.groupsOf('cn', {})[0].opts.map(o => o.k), ['', 'cn_amateur', 'cn_studio', 'cn_hookup', 'creators', 'live']) && C.groupsOf('cn', {})[0].opts[0].l === '全部'
        && eq(C.groupsOf('jp', {}), []) && eq(C.groupsOf('west', {}), []) && eq(C.groupsOf('all', {}), []), '浏览页固定筛选行只剩国产的「分类」(全部 + 5 个细分);日本 / 其余没有');
    ok(eq(C.navRows('cn')[0].items.map(i => i.sel.b), ['cn_amateur', 'cn_studio', 'cn_hookup', 'creators', 'live']) && eq(C.navRows('jp'), []) && eq(C.navRows('west'), []), '分类栏细分(成人版首页不出这块):只有国产');
    ok(C.title('cn', { b: 'cn_hookup' }) === '国产 · 探花' && C.title('cn', {}) === '国产' && C.title('jp', {}) === '日本' && C.title('all', { b: 'fetish' }) === 'SM·重口' && C.title('west', {}) === '欧美' && C.summary('jp', { b: 'jp_subbed', dur: 'l', sort: 'random' }) === '日本 · 中字 · 30–60分钟 · 随机', '标题 / 摘要', C.summary('jp', { b: 'jp_subbed', dur: 'l', sort: 'random' }));
    ok(C.countLabel(12345) === '1万+' && C.countLabel(0) === '0', 'countLabel');
    const dir = C.directory();
    ok(dir.hot.length === 17 && dir.hot.every(h => h.l && C.typeOf(h.type) && h.sel.b && /gradient/.test(h.bg) && /^fa-/.test(h.icon)) && dir.types.every(t => t.rows.every(r => r.items.every(i => i.sel && i.sel.b))), '分类大全:17 个桶色块 + 各大类卡片');
    // 搜索框分类词
    ok(eq(C.fromSearch(' 无码 '), { type: 'jp', sel: { b: 'jp_uncensored' } }) && eq(C.fromSearch('探花'), { type: 'cn', sel: { b: 'cn_hookup' } }) && eq(C.fromSearch('SM'), { type: 'all', sel: { b: 'fetish' } }), '分类词 → 浏览页(无码 / 探花 / SM → 全部 · SM·重口)');
    ok(eq(C.fromSearch('人妖'), { type: 'all', sel: { t: ['trans'] } }) && eq(C.fromSearch('TS'), { type: 'all', sel: { t: ['trans'] } }) && eq(C.fromSearch('男同'), { type: 'all', sel: { t: ['gay'] } })
        && eq(C.fromSearch('女同'), { type: 'all', sel: { t: ['lesbian'] } }) && eq(C.fromSearch('同性'), { type: 'lgbt', sel: { b: 'lgbt' } }), '人妖 / 男同 / 女同 → 全部 + 那个标签(同性分区大半是女同);「同性」才进整个分区');
    ok(C.fromSearch('泰剧') === null && C.fromSearch('人妻') === null && C.fromSearch('SSIS-001') === null && C.fromSearch('') === null, '不是分类词(主站的泰剧、标签词人妻、番号)照常搜索');
    // 首页行「全部」
    ok(eq(C.rowPreset('ad_jp_subbed', undefined, { more: { b: 'jp_subbed' } }), { type: 'jp', sel: { b: 'jp_subbed', sort: 'new' } }) && eq(C.rowPreset('ad_new', undefined, { more: { sort: 'new' } }), { type: 'all', sel: { sort: 'new' } })
        && eq(C.rowPreset('ad_fresh', undefined, { more: { sort: 'released' } }), { type: 'all', sel: { sort: 'released' } }) && eq(C.rowPreset('ad_random', undefined, { more: { sort: 'random' } }), { type: 'all', sel: { sort: 'rand' } })
        && C.rowPreset('movieRow', 'newest') === null, '首页行「全部」按 more 进浏览页(新片速递 → 发行日期;随机发现 → rand);没有 more 的不跳');
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
    // 横版卡片:竖图(海报 0.70 / 短视频 0.56)contain + 同图模糊铺底;横图、方图、占位图都不铺底;换成横图要把铺底撤掉
    ok(A.isPortrait(300, 450) && A.isPortrait(720, 1280) && !A.isPortrait(800, 538) && !A.isPortrait(100, 100) && !A.isPortrait(0, 0), '竖图判定 < 0.9');
    {
        const mkCls = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => { if (on) s.add(c); else s.delete(c); return !!on; } }; };
        const props = {};
        const wrap = { classList: mkCls(), style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } } };
        wrap.classList.add('poster-wrap');
        const img = { naturalWidth: 300, naturalHeight: 450, currentSrc: 'https://p.example/a"b.jpg', src: '', classList: mkCls(), parentElement: wrap };
        A.shapeCover(img);
        ok(img.classList.contains('dg-port') && wrap.classList.contains('dg-port-bg') && props['--dg-pbg'] === 'url("https://p.example/a%22b.jpg")', '竖图:contain + 父级铺同图模糊底(url 里的引号转义)', props);
        img.naturalWidth = 1280; img.naturalHeight = 720; img.currentSrc = 'https://p.example/c.jpg';
        A.shapeCover(img);
        ok(!img.classList.contains('dg-port') && !wrap.classList.contains('dg-port-bg') && !('--dg-pbg' in props), '同一个框换成横图:铺底撤掉', props);
        img.naturalWidth = 300; img.naturalHeight = 450; img.currentSrc = A.PLACEHOLDER;
        A.shapeCover(img);
        ok(!img.classList.contains('dg-port') && !wrap.classList.contains('dg-port-bg'), '占位图(data:)不当竖图铺底');
        const lone = { naturalWidth: 300, naturalHeight: 450, currentSrc: 'https://p.example/d.jpg', src: '', classList: mkCls(), parentElement: { classList: mkCls(), style: {} } };
        A.shapeCover(lone);
        ok(lone.classList.contains('dg-port'), '不在 .poster-wrap 里(搜索联想缩略图):只 contain,不动父级');
        const AS = fs.readFileSync(path.join(ROOT, 'public/adult/adult.js'), 'utf8');
        // adult.js 的样式插在 index.html 大 <style> 之前:同优先级会输,必须比主站的 .poster-wrap{aspect-ratio:2/3} 更具体
        ok(/'html \.poster-wrap \{ aspect-ratio: 16 \/ 9; \}'/.test(AS) && /\.poster-wrap \{[^}]*aspect-ratio: 2\/3/.test(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')) && /html:root \{ --card-w: calc\(clamp\(210px, 17vw, 300px\)/.test(AS) && !/dg-land \{ object-position: right center/.test(AS), '封面卡 16:9、卡宽加大;不再把横图裁到右半边');
        ok(/320' height='180'/.test(A.PLACEHOLDER), '占位图也是 16:9');
        ok(/'html \.poster-wrap img\.dg-port \{[^}]*background: none;/.test(AS), '竖图去掉 <img> 自带的灰色渐变底(否则盖住模糊铺底)');
        const PV = fs.readFileSync(path.join(ROOT, 'public/adult/preview.js'), 'utf8');
        ok(/dg-pv-fit \{ object-fit: contain;/.test(PV) && /videoWidth \/ v\.videoHeight < 1\.2\) v\.classList\.add\('dg-pv-fit'\)/.test(PV), '竖屏片源的悬停预览整条放下(contain),不裁成中间一条');
    }
    const tried = new Set(['https://p.example/1.jpg']);
    ok(A.pickFallbackPic({ sources: [{ vod_pic: 'https://p.example/1.jpg' }, { vod_pic: 'https://x/mac_default.jpg' }, { vod_pic: 'data:x' }, { vod_pic: 'https://p.example/2.jpg' }] }, tried) === 'https://p.example/2.jpg'
        && A.pickFallbackPic({ sources: [{ vod_pic: 'https://p.example/1.jpg' }] }, tried) === '' && A.pickFallbackPic(null) === '', '海报回退:换没试过的另一条线路海报,都试过 → 空(中性占位)');
    ok(/^data:image\/svg\+xml/.test(A.PLACEHOLDER) && !/tmdb/i.test(A.PLACEHOLDER), '占位图是本地 SVG');
    ok(A.isContentPath('/api/search') && A.isContentPath('/api/catalog/home') && A.isContentPath('/api/kz/ep') && !A.isContentPath('/api/config') && !A.isContentPath('/api/auth/verify') && !A.isContentPath('/api/searchx'), '内容接口路径(与服务器 CONTENT_PATHS 一致)');
    const CP = (/const CONTENT_PATHS = \[([^\]]*)\]/.exec(GATE) || [])[1] || '';
    const srvPaths = [...CP.matchAll(/'([^']+)'/g)].map(m => m[1]);
    ok(srvPaths.length >= 5 && srvPaths.every(p => A.isContentPath(p)), '服务器 requireAuth 的每个路径前端都认作内容接口', srvPaths);
    ok(A.sameOriginPath('/api/x?a=1', 'https://s.test/') === '/api/x' && A.sameOriginPath('https://other.test/api/x', 'https://s.test/') === null, 'sameOriginPath');
    ok(A.brand.clean('<b>站</b>\u0001') === 'b站/b' && A.brand.name() === 'MEI.NU', '站名清洗 / 默认 MEI.NU');
    // 站名字标:MEI.NU(不分大小写)= 画好的整段 SVG;别的 M 开头 = 画的 M + 转义后的后半截;其余 = 转义后的全名
    const wmHtml = A.brand.html('MEI.NU');
    ok(wmHtml === A.wordmark.full && A.brand.html('mei.nu') === wmHtml && /^<svg class="dg-wm" viewBox="[\d. ]+" aria-hidden="true" focusable="false">/.test(wmHtml) && !/font|<text|https?:/i.test(wmHtml.replace(/xmlns="[^"]*"/, '')),
        '字标 = 自己画的 SVG(没有文字 / 字体 / 外链)');
    ok(A.brand.html('Max&"Co') === A.wordmark.mOnly + '<span class="dg-wm-t">ax&amp;&quot;Co</span>' && A.brand.html('视界') === '视界' && A.brand.html('a&b') === 'a&amp;b', '别的站名:M 开头配画的 M,文字一律转义');
    // 首页分类行(homeRows):默认随机发现最前、固定行 = 服务器 HOME_BUCKETS、自己加的最多 MAX_ADD 行
    const HR = A.homeRows, KC = require(path.join(ROOT, 'lib/site-catalog/common.js'));
    ok(JSON.stringify(A.HOME_BUCKETS) === JSON.stringify(KC.HOME_BUCKETS), '前端首页分区行列表 = 服务器 HOME_BUCKETS', A.HOME_BUCKETS);
    const D0 = HR.def();
    ok(D0[0].k === 'ad_random' && D0[1].k === 'ad_new' && D0.every(s => s.on) && HR.isDefault(D0) && D0.length === 5 + KC.HOME_BUCKETS.length, '默认:随机发现排第一、其余固定行全开', D0.slice(0, 3));
    ok(HR.initial(null).length === D0.length && HR.initial('坏的{').length === D0.length && HR.initial('{"a":1}').length === D0.length, '没存过 / 存坏了 → 默认');
    const N1 = HR.normalize([{ k: 'ad_hot', on: false }, 'ad_new', { k: 'nope' }, { k: 'ad_hot', on: true }, { k: '__proto__' }, null, 5, { k: 'ad_c_v_unc', on: false }]);
    ok(N1[0].k === 'ad_hot' && N1[0].on === false && N1[1].k === 'ad_new' && N1[2].k === 'ad_c_v_unc' && N1[2].on === false && N1.length === D0.length + 1 && new Set(N1.map(s => s.k)).size === N1.length,
        'normalize:去重 / 丢不认识的 / 没给到的固定行补在后面开着', N1.slice(0, 4));
    const many = HR.ADD.map(a => ({ k: a.k, on: true }));
    ok(HR.added(HR.normalize(many)) === HR.MAX_ADD && HR.MAX_ADD === 6, '存的值里自己加的超过上限 → 只留前 ' + HR.MAX_ADD + ' 行');
    let L = HR.add(D0, 'v_unc');
    ok(L[0].k === 'ad_c_v_unc' && L[0].on && HR.add(L, 'v_unc') === L && HR.add(L, 'nope') === L && HR.remove(L, 'ad_new') === L && HR.remove(L, 'ad_c_v_unc').length === D0.length, '加一行放最前;重复 / 不认识的不加;固定行删不掉、自己加的能删');
    for (const a of HR.ADD) L = HR.add(L, a.id);
    ok(HR.added(L) === HR.MAX_ADD, '加满 ' + HR.MAX_ADD + ' 行后再加不进去');
    ok(JSON.stringify(HR.order(HR.toggle(D0, 'ad_new', false), ['ad_new', 'ad_hot', 'ad_cn_amateur', 'ad_random', 'ad_future'])) === JSON.stringify(['ad_random', 'ad_hot', 'ad_cn_amateur', 'ad_future']),
        '首页按布局排、关掉的不出、服务器新加的行排最后照出');
    ok(JSON.stringify(HR.move(D0, 'ad_new', -1).slice(0, 2).map(s => s.k)) === '["ad_new","ad_random"]' && HR.move(D0, 'ad_random', -1) === D0, '上移 / 到顶不动');
    ok(HR.url('ad_c_t_jp') === '/api/catalog/browse?b=jp_censored,jp_uncensored,jp_subbed&sort=new&page=1&nr=1' && HR.url('ad_c_v_unc') === '/api/catalog/browse?v=unc&sort=new&page=1&nr=1'
        && HR.url('ad_c_b_asia') === '/api/catalog/browse?b=asia&sort=new&page=1&nr=1' && HR.url('ad_new') === '', '自己加的行 = 浏览第 1 页 + nr=1(不要审查级)');
    ok(HR.ADD.every(a => !KC.HOME_BUCKETS.includes(a.sel.b) && A.catalog.rowPreset(a.k, 'new', HR.config(a.k)) !== null), '能加的都不和首页默认分区行重复,「全部」都能进浏览页');
    ok(JSON.stringify(A.catalog.rowPreset('x', 'new', { more: { type: 'jp' } })) === '{"type":"jp","sel":{"sort":"new"}}' && JSON.stringify(A.catalog.rowPreset('x', 'new', { more: { v: 'unc' } })) === '{"type":"all","sel":{"v":"unc","sort":"new"}}'
        && A.catalog.rowPreset('x', 'new', { more: { v: 'evil' } }) === null && A.catalog.rowPreset('x', 'new', { more: { type: 'all' } }) === null, 'rowPreset 认 {type} / {v}');
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
    ok(eq(CP.catTypes.call(self).map(t => t.k), ['cn', 'jp', 'west', 'anime', 'softcore', 'lgbt', 'short', 'commentary', 'ai_drama', 'all']) && eq(CP.catNavRows.call(self), []) && CP.catNavRows.call(Object.assign({}, self, { catNavType: 'cn' }))[0].items.length === 5 && CP.browseTitle.call(self) === '国产 · 传媒', 'catTypes/catNavRows/browseTitle 都是目录版');
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
        // 封面加载不出来就藏(2026-11-22):没有封面的卡片(pic 空)渲染之前就拿掉,一张不剩的行整行不出
        if (u === '/api/catalog/home') return { body: { rows: [{ id: 'new', title: '新上架', more: { sort: 'new' }, items: [{ wk: 'c:A-001', name: 'A-001 x', pic: 'https://p/a.jpg' }, { wk: 't:nopic', name: '没封面', pic: '' }] }, { id: 'cn_live', title: '全是没封面的', items: [{ wk: 't:np2', name: 'z' }] }, { id: 'random', title: '随机发现', more: { sort: 'random' }, items: [{ wk: 't:yy', name: 'y', pic: 'https://p/y.jpg' }] }] } };
        if (u === '/api/catalog/buckets') return { body: [{ id: 'cn_amateur', label: '国产自拍', nav: true, today: 9 }] };
        return null;
    };
    await app.adultLoadHome();
    await sleep(5);
    ok(eq(Object.keys(app.rowConfigs), ['ad_new', 'ad_random']) && app.rowLists.ad_new[0]._wk === 'c:A-001' && app.adult.home === 'ok', 'adultLoadHome:目录各行进 rowConfigs/rowLists', Object.keys(app.rowConfigs));
    ok(app.rowLists.ad_new.length === 1 && !app.rowConfigs.ad_cn_live, '没有封面的卡片渲染之前就拿掉;一张不剩的行(全是没封面的)整行不出', app.rowLists.ad_new.map(x => x._wk));
    ok(app.adToday('cn') === 9 && app.adToday('cn_amateur') === 9, '分类栏今日数(/api/catalog/buckets)');
    const ids = app.homeBlocks.map(b => b.id);
    ok(eq(ids, ['history', 'catnav', 'row:ad_random', 'row:ad_new']), 'homeBlocks:继续观看、分类栏,然后目录行(按「首页分类行」布局:默认随机发现排第一;不占随机盲盒的位置)', ids);
    app.adRowsToggle('ad_random', false);
    ok(eq(app.homeBlocks.map(b => b.id), ['history', 'catnav', 'row:ad_new']) && JSON.parse(store.get(A.homeRows.KEY)).find(s => s.k === 'ad_random').on === false, '关掉一行 → 首页不出、存本机', app.homeBlocks.map(b => b.id));
    app.adRowsMove('ad_new', -1); app.adRowsToggle('ad_random', true);
    ok(eq(app.homeBlocks.map(b => b.id), ['history', 'catnav', 'row:ad_new', 'row:ad_random']), '上移后首页跟着换顺序', app.homeBlocks.map(b => b.id));
    app.adRowsReset();
    ok(eq(app.homeBlocks.map(b => b.id), ['history', 'catnav', 'row:ad_random', 'row:ad_new']) && app.adRowsIsDefault, '恢复默认');
    // 随机发现「换一批」:浏览接口随机序的别的页(page ≥ 2、nr=1),这行出过的不再出,_adHomeAll 跟着换(封面判定重筛时不改回去)
    const shufCalls = [];
    net.handler = (u) => {
        const m = /^\/api\/catalog\/browse\?sort=rand&page=(\d+)&nr=1$/.exec(u);
        if (!m) return null;
        shufCalls.push(+m[1]);
        return { body: { total_pages: 300, results: [{ wk: 't:yy', name: 'y', pic: 'https://p/y.jpg' }].concat(Array.from({ length: 30 }, (_, i) => ({ wk: 't:s' + m[1] + '-' + i, name: 's' + i, pic: 'https://p/s' + i + '.jpg' }))) } };
    };
    await app.adRowShuffle('ad_random');
    const sh = app.rowLists.ad_random;
    ok(shufCalls.length === 1 && shufCalls[0] >= 2 && sh.length === 24 && !sh.some(x => x._wk === 't:yy') && app._adHomeAll.lists.ad_random === sh && app.adult.shuf === false,
        '换一批:随机翻到第 2 页以后、24 部、原来那行的不再出、原始片单跟着换', [shufCalls, sh.length]);
    await app.adRowShuffle('ad_random');
    ok(shufCalls.length === 2 && shufCalls[1] !== shufCalls[0] && !app.rowLists.ad_random.some(x => sh.includes(x)), '再换一批:换了一页、和上一批不重复', shufCalls);
    ok(/v-if="adultMode && key === 'ad_random'"[^>]*:disabled="adult\.shuf"[\s\S]{0,80}@click="adRowShuffle\(key\)"/.test(HTML), '随机发现行头有「换一批」按钮');
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
    app.browse.open = true; app.browse.type = 'jp'; app.browse.sel = { b: 'jp_subbed', dur: '', v: 'zh', sort: 'new' };
    app._browseFill = () => { };
    net.calls.length = 0;
    net.handler = (u) => (u.startsWith('/api/catalog/browse') ? { body: { page: 1, total_pages: 7, total_results: 160, results: [{ wk: 'c:B-1', name: 'B-1 x', pic: 'https://p/b.jpg', sub: 's', badge: '中字' }, { wk: 'c:B-1', name: 'dup' }, { name: 'bad' }] } } : null);
    await app._browseFetch(true);
    ok(net.calls[0] === '/api/catalog/browse?b=jp_subbed&v=zh&sort=new&page=1&facets=1' && !net.calls.some(u => /tmdb/.test(u)), '浏览页请求 /api/catalog/browse(按当前筛选,第 1 页要 facets)', net.calls);
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
    ok(r.br && eq(r.br.p, { type: 'all', sel: { b: '', dur: '', v: '', sort: 'new', t: ['milf'] } }) && r.br.f.keyword === '人妻' && r.searched === 0, '标签词(人妻)→ 标签页(全部 + t=milf),保留「按片名搜索」', r.br);
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
                { wk: 't:a1', name: '合成片名一', pic: 'https://p/a1.jpg', dur: 600, n_sites: 3, sub: '1天前 · 10:00 · 3线' }, { wk: 't:a2', name: '合成片名二', pic: 'https://p/a2.jpg' }, { wk: 't:a3', name: '合成片名三(没封面)' }],
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
    ok(!rows.some(x => x.it && x.it._wk === 't:a3'), '下拉:没有封面的作品整行不出(封面加载不出来就藏)');
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
    ok(br && eq(br.p, { type: 'cn', sel: { b: 'cn_hookup', dur: '', v: '', sort: 'new' } }) && br.f.keyword === '探花', '点「按分类浏览」→ 浏览页(带按片名搜索)', br);
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
    ok(eq(C.normSel('jp', { b: 'jp_censored', tag: 'busty' }), { b: 'jp_censored', dur: '', v: '', sort: 'new', t: ['busty'] }) && eq(C.normSel('jp', { b: 'jp_censored', tag: '' }), { b: 'jp_censored', dur: '', v: '', sort: 'new' })
        && !('t' in C.normSel('jp', { tag: 'bad id!' })) && !('t' in C.normSel('jp', { tag: { x: 1 } })), 'normSel:旧的单标签 tag → t(合法才带键;空/非法不带)');
    ok(C.buildQuery('jp', { b: 'jp_censored', tag: 'busty', dur: 'l' }, 2).url === '/api/catalog/browse?b=jp_censored&t=busty&dur=l&sort=new&page=2' && C.buildQuery('all', { tag: 'milf' }, 1).url === '/api/catalog/browse?t=milf&sort=new&page=1',
        'browse 地址带 &t=(可与 b/dur/sort/page 组合;全部大类只带 t)', C.buildQuery('all', { tag: 'milf' }, 1).url);
    ok(eq(C.normSel('all', { lp: 'ssis' }), { b: '', dur: '', v: '', sort: 'new', lp: 'SSIS' }) && !('lp' in C.normSel('all', { lp: 'S%' })) && !('lp' in C.normSel('all', { lp: '' }))
        && C.buildQuery('all', { lp: 'SSIS', tag: 'milf' }, 1).url === '/api/catalog/browse?t=milf&lp=SSIS&sort=new&page=1' && C.title('all', { lp: 'SSIS' }) === '全部 · SSIS',
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
    ok(eq(A.aliasPreset({ b: 'jp_uncensored', tag: 'busty' }), { type: 'jp', sel: { b: 'jp_uncensored', t: ['busty'] } }) && eq(A.aliasPreset({ tag: 'milf' }), { type: 'all', sel: { t: ['milf'] } }) && A.aliasPreset({ b: 'nope' }) === null && A.aliasPreset({ tag: 'x_minor' }) === null, 'aliasPreset(标签进 t;blocked 的 x_* 不认)');
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
    ok(eq(m.actress, [{ aid: '', name: '合成演员甲' }, { aid: '', name: 'x' }]), '演员:去空、去重、去尖括号(旧的纯名字 → aid 为空)', m.actress);
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
    ok(closed === 1 && eq(br, { type: 'jp', sel: { b: 'jp_censored', dur: '', v: '', sort: 'new', t: ['busty'] } }), '分类 + 标签 → 关播放页,这个分类里按标签筛', br);
    app.showDetail = true;
    app.adMetaGo({ tag: 'noncon' });
    ok(closed === 1, '审查类标签不导航(信息条本来也不出它)');
    app.showDetail = true;
    app.adMetaPrefix('ssis');
    ok(closed === 2 && eq(br, { type: 'all', sel: { lp: 'SSIS' } }) && searched === 0, '厂牌前缀 → 关播放页,开「全部」浏览页按厂牌筛(本地目录,不全站搜)', br);
    app.showDetail = true;
    app.adMetaPrefix('../x');
    ok(closed === 2 && br.sel.lp === 'SSIS', '坏前缀不动');
    app.showDetail = true;
    app.adMetaSearch('テスト花子');
    ok(closed === 3 && app.keyword === 'テスト花子' && searched === 1, '演员 → 关播放页,全站搜这个名字');
    ok(HTML.includes('@click="adMetaPrefix(adMeta.prefix)"') && !HTML.includes('adMetaSearch(adMeta.prefix)') && eq(A.activePills({ lp: 'SSIS' }), [{ k: 'lp', l: 'SSIS' }]),
        'index.html:前缀按钮走 adMetaPrefix;浏览页的已选条件里有可去掉的前缀(lp)');
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
    app.browse.open = true; app.browse.type = 'jp'; app.browse.sel = { b: 'jp_censored', dur: '', v: '', sort: 'new' };
    ok(app.adTagKey === 't|jp_censored', 'adTagKey 跟着当前分类');
    app._adLoadTags();
    await sleep(5); for (let i = 0; i < 4; i++) await tick();
    ok(eq(net.calls, ['/api/catalog/tags?b=jp_censored']) && eq(app.adTagOpts.map(t => t.id), ['busty']), '标签行:只出 featured 的', app.adTagOpts);
    app.browse.sel = Object.assign({}, app.browse.sel, { t: ['noncon'] });
    const cr = A.chipRow(null, app.browse.sel, app.adTagOpts);
    ok(eq(app.adTagOpts.map(t => t.id), ['busty']) && eq(cr.map(c => c.id), ['busty']) && eq(A.activePills(app.browse.sel), [{ k: 'review', l: '1 个筛选标签' }]),
        '已选的审查类标签(从筛选面板「更多」选的)永不进标签行,只在已选条件里写「1 个筛选标签」(能去掉)', cr);
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

console.log('⑦ phase 3:分面浏览 / 筛选面板 / 标签云 / 标签页 / 女优 / 地址栏路由 / 窗口化网格 / 新片速递 / 信息条');
{
    // ---- 纯函数:facets ----
    const raw = {
        buckets: [{ id: 'jp_censored', label: '日本有码', count: 312 }, { id: 'x_mainstream', count: 9 }, { id: 'jp_subbed', count: 88 }],
        groups: [
            { id: 'body', label: '身材·外貌', tags: [{ id: 'busty', label: '巨乳', count: 120 }, { id: 'legs', label: '美腿', count: 0 }, { id: 'small_tits', label: '贫乳', count: 50 }, { id: 'x_school', label: '学生', count: 9 }] },
            { id: 'outfit', label: '服装·制服', tags: [{ id: 'black_stockings', label: '黑丝<b>', count: 21 }, { id: 'busty', label: '重复', count: 1 }] },
            { id: '_blocked', label: 'x', tags: [{ id: 'x_minor', label: 'x', count: 1 }] },
            { id: 'act', tags: [{ id: 'sleep', label: '睡眠', count: 5, featured: true }, { id: 'oral', label: '口交', count: 40, featured: false }] },
        ],
        more: [{ id: 'noncon', label: '强制凌辱', count: 77 }, { id: 'x_drug', label: 'x' }, { id: 'bad id', label: 'x' }],
        dur: [{ id: 's', label: '10分钟内', count: 3 }, { id: 'xl', count: 51 }, { id: 'unk', count: 140 }, { id: 'zz', count: 1 }],
        variant: [{ id: 'zh', label: '中字', count: 88 }, { id: 'vertical', count: 2 }, { id: 'nope', count: 3 }],
        studio: Array.from({ length: 25 }, (_, i) => ({ id: i ? '合成厂牌' + i : 'S1', label: i ? '合成厂牌' + i : 'S1', count: 40 - i })),
        actress: [{ aid: 'a:12345', name: '合成女优甲', count: 7 }, { aid: 'bad aid!', name: 'x', count: 1 }, { aid: 'a:2', name: '', count: 1 }],
        sorts: [{ id: 'new', label: '最新上架', available: true }, { id: 'released', available: true }, { id: 'hot', available: false }, { id: 'dur', available: true }, { id: 'rand', available: true }, { id: 'zzz', available: true }],
    };
    const f = A.normFacets(raw);
    ok(eq(f.buckets.map(b => b.id), ['jp_censored', 'jp_subbed']) && f.buckets[1].label === '中文字幕', 'facets.buckets:只认导航桶,缺名字用本地名');
    ok(eq(f.groups.map(g => g.id), ['body', 'outfit']) && eq(f.groups[0].tags.map(t => t.id), ['busty', 'legs']) && eq(f.groups[1].tags.map(t => [t.id, t.label]), [['black_stockings', '黑丝b']]),
        'facets.groups:只留 featured;审查类(贫乳 small_tits)、blocked(x_school / _blocked 组)、featured:false、重复 id 全丢;名字去尖括号', f.groups);
    ok(!f.groups.some(g => g.tags.some(t => t.id === 'sleep')), '服务器把审查类(睡眠 sleep)标成 featured 放进分组 → 前端照样不做按钮(fail-closed)');
    ok(eq(f.more, [{ id: 'noncon', label: '强制凌辱' }]) && !('count' in f.more[0]), 'facets.more:审查类只要 id + 名字,不带数;blocked / 非法 id 丢掉', f.more);
    ok(eq(f.dur.map(d => d.id), ['s', 'xl', 'unk']) && f.dur[1].label === '1–2小时' && eq(f.variant.map(v => v.id), ['zh', 'vertical']) && f.variant[1].label === '竖屏', 'facets.dur / variant:只认契约里的取值,缺名字用本地名');
    ok(f.studio.length === 20 && f.studio[0].id === 'S1' && eq(f.actress, [{ aid: 'a:12345', name: '合成女优甲', count: 7 }]), 'facets.studio 最多 20;actress 要合法 aid 和名字');
    ok(eq(f.sorts, ['new', 'released', 'dur', 'rand']), 'facets.sorts:只要 available 的、按固定次序、不认识的丢掉', f.sorts);
    ok(eq(A.normFacets({}).sorts, A.DEFAULT_SORTS) && A.normFacets(null) === null && eq(A.normFacets({ sorts: ['new', 'random'] }).sorts, ['new', 'rand']), 'facets 没给 sorts → 默认(最新/时长/线路/随机);旧草案的纯 id 数组也认');
    ok(eq(A.sortOpts(f, { sort: 'new' }).map(s => s.k), ['new', 'released', 'dur', 'rand']) && eq(A.sortOpts(f, { sort: 'hot' }).map(s => s.k), ['new', 'released', 'hot', 'dur', 'rand'])
        && eq(A.sortOpts(null, { sort: 'new' }).map(s => s.k), ['new', 'dur', 'lines', 'rand']), '排序下拉:只列可用的;当前选中的(这次不可用)也照实列出');
    // ---- 标签行 ----
    const cr = A.chipRow(f, { t: ['busty'], x: ['black_stockings'] }, []);
    ok(eq(cr.map(c => [c.id, c.st, c.off]), [['busty', 'in', false], ['black_stockings', 'ex', false], ['legs', '', true]]), '标签行:已选在前、已排除随后、其余按数量;数为 0 的置灰', cr);
    const big = { groups: [{ id: 'act', label: 'a', tags: Array.from({ length: 30 }, (_, i) => ({ id: 't' + i, label: '合成' + i, count: i + 1 })) }] };
    const cr2 = A.chipRow(big, {}, []);
    ok(cr2.length === 12 && cr2[0].id === 't29' && cr2.every((c, i) => !i || cr2[i - 1].count >= c.count), '标签行:没选时最多 12 个,数量多的在前');
    ok(eq(A.chipRow(null, { t: ['noncon', 'busty'] }, [{ id: 'busty', label: '巨乳美乳', count: 3 }, { id: 'incest', label: '乱伦剧情', count: 9 }]).map(c => c.id), ['busty']), '没有 facets → 用旧标签列表;审查类(选中的、列表里的)都不进标签行');
    // ---- 点标签 ----
    ok(eq(A.nextTagState({}, 'busty', 'toggle'), { t: ['busty'], x: [] }) && eq(A.nextTagState({ t: ['busty'] }, 'busty', 'toggle'), { t: [], x: [] }) && eq(A.nextTagState({ x: ['busty'] }, 'busty', 'toggle'), { t: [], x: [] }), '标签行:点一下选中,再点取消');
    ok(eq(A.nextTagState({}, 'busty'), { t: ['busty'], x: [] }) && eq(A.nextTagState({ t: ['busty'] }, 'busty'), { t: [], x: ['busty'] }) && eq(A.nextTagState({ x: ['busty'] }, 'busty'), { t: [], x: [] }), '筛选面板:选中 → 再点排除 → 再点取消');
    ok(eq(A.nextTagState({}, 'busty', 'x'), { t: [], x: ['busty'] }) && eq(A.nextTagState({}, 'busty', true), { t: [], x: ['busty'] }), '排除模式:点一下直接排除');
    ok(A.nextTagState({ t: ['a', 'b', 'c'] }, 'd').err === '最多同时选 3 个标签' && A.nextTagState({ x: ['a', 'b', 'c'] }, 'd', 'x').err === '最多排除 3 个标签'
        && eq(A.nextTagState({ t: ['d'], x: ['a', 'b', 'c'] }, 'd'), { t: [], x: ['a', 'b', 'c'] }) && A.nextTagState({}, 'x_minor').err === '' && A.nextTagState({}, 'bad id!').err === '', '各最多 3 个(排除满了第二下只取消);blocked / 非法 id 什么都不做');
    ok(A.filterCount({ b: 'x', sort: 'new', t: ['a', 'b'], x: ['c'], dur: 'l', v: 'zh', studio: 'S1', actress: 'a:1', lp: 'SSIS' }) === 8 && A.filterCount({ b: 'x', sort: 'dur' }) === 0, '筛选按钮上的数:标签 + 排除 + 时长 + 版本 + 厂牌 + 女优 + 前缀');
    const pills = A.activePills({ dur: 'unk', v: '4k', studio: 'S1', actress: 'a:12345', t: ['busty', 'noncon'], x: ['hypnosis'] });
    ok(eq(pills.map(p => p.l), ['时长未知', '4K', '厂牌 S1', '女优 合成女优甲', '2 个筛选标签']), '已选条件:时长 / 版本 / 厂牌名 / 女优名(从 facets 学到)/ 审查类只写个数不写名字', pills);
    // ---- normSel phase 3 ----
    const C = A.catalog;
    ok(eq(C.normSel('jp', { b: 'jp_censored', t: 'busty,legs,oral,cosplay', x: ['busty', 'subbed', 'x_school'], dur: 'unk', v: 'vertical', studio: '<S1>', actress: 'a:12345', sort: 'released' }),
        { b: 'jp_censored', dur: 'unk', v: 'vertical', sort: 'released', t: ['busty', 'legs', 'oral'], x: ['subbed'], studio: 'S1', actress: 'a:12345' }),
        'normSel:t 最多 3 个、x 去掉和 t 重复的与 blocked、厂牌去尖括号、合法 aid', C.normSel('jp', { b: 'jp_censored', t: 'busty,legs,oral,cosplay', x: ['busty', 'subbed', 'x_school'], studio: '<S1>', actress: 'a:12345', sort: 'released' }));
    ok(!('actress' in C.normSel('all', { actress: '../x' })) && !('t' in C.normSel('all', { t: ['x_minor', 'bad id'] })) && C.normSel('all', { sort: 'release' }).sort === 'released', 'normSel:非法 aid / 只有 blocked 的 t 不带键;release → released');
    ok(A.browseApiUrl(C.normSel('jp', { b: 'jp_censored', t: ['busty', 'legs'], x: ['subbed'], dur: 'xl', v: 'zh', studio: '麻豆传媒', actress: 'a:1', sort: 'hot' }), { cursor: 'abc/=', facets: true })
        === '/api/catalog/browse?b=jp_censored&t=busty,legs&x=subbed&dur=xl&v=zh&studio=%E9%BA%BB%E8%B1%86%E4%BC%A0%E5%AA%92&actress=a%3A1&sort=hot&cursor=abc%2F%3D&facets=1', 'browse 地址:契约 C 的全部参数;游标翻页时不带 page');
    ok(A.browseApiUrl({ sort: 'new' }, { page: 3 }) === '/api/catalog/browse?sort=new&page=3', 'browse 地址:按页(退路)');
    ok(C.title('all', { actress: 'a:12345' }) === '女优 · 合成女优甲' && C.title('jp', { b: 'jp_censored', t: ['busty', 'noncon'], studio: 'S1' }) === '日本 · 有码 · ' + A.tagLabel('busty') + ' · S1'
        && C.summary('jp', { b: 'jp_censored', x: ['a'], v: 'zh', dur: 'unk', sort: 'released' }) === '日本 · 有码 · 时长未知 · 中字 · 排除 1 · 发行日期', '标题 / 摘要:女优名、标签名(审查类不写)、厂牌、排除个数');
    // ---- 地址栏路由(只有 id,不写片名)----
    const RT = [
        ['', 'jp', { b: 'jp_censored', t: ['busty', 'legs'], x: ['subbed'], dur: 'xl', v: 'zh', sort: 'released' }, '#/c/jp?b=jp_censored&t=busty,legs&x=subbed&dur=xl&v=zh&sort=released'],
        ['', 'all', {}, '#/c/all'],
        ['', 'all', { sort: 'rand' }, '#/c/all?sort=rand'],
        ['tag', 'all', { t: ['busty'] }, '#/tag/busty'],
        ['tag', 'all', { t: ['busty'], sort: 'dur' }, '#/c/all?t=busty&sort=dur'],
        ['', 'all', { actress: 'a:12345' }, '#/actress/a%3A12345'],
        ['', 'all', { actress: 'a:12345', v: 'zh' }, '#/c/all?v=zh&actress=a%3A12345'],
        ['', 'cn', {}, '#/c/cn'],
        ['', 'jp', { v: 'unc' }, '#/c/jp?v=unc'],
        ['', 'all', { b: 'fetish' }, '#/c/all?b=fetish'],
        ['', 'all', { studio: 'S1', lp: 'SSIS' }, '#/c/all?studio=S1&lp=SSIS'],
    ];
    const rtBad = RT.filter(([v, tk, sel, want]) => A.routeOf(v, tk, sel) !== want || A.canonHash(want) !== want);
    ok(!rtBad.length, 'routeOf:浏览 #/c/<大类>?…(只写非默认项;国产 / 日本整类不带 b;全部 · 孤儿分区带 b)/ 标签页 #/tag/<id> / 女优页 #/actress/<aid>;往返规范化不变', rtBad.map(r => [A.routeOf(r[0], r[1], r[2]), r[3]]));
    const pr = A.parseRoute('#/c/cn?b=jp_censored&t=busty,x_school,legs&sort=hot&studio=%E9%BA%BB%E8%B1%86%E4%BC%A0%E5%AA%92');
    ok(pr && pr.type === 'jp' && eq(pr.sel.t, ['busty', 'legs']) && pr.sel.sort === 'hot' && pr.sel.studio === '麻豆传媒' && pr.view === '', 'parseRoute:大类以分类为准、blocked 标签剔掉、转义还原', pr);
    ok(eq(A.parseRoute('#/tag/busty'), { view: 'tag', type: 'all', sel: { t: ['busty'] } }) && eq(A.parseRoute('#/actress/a%3A12345'), { view: '', type: 'all', sel: { actress: 'a:12345' } })
        && eq(A.parseRoute('#/tags?b=anime'), { view: '', type: 'anime', sel: { b: 'anime', dur: '', v: '', sort: 'new' } }) && eq(A.parseRoute('#/tags?b=x_bad'), { view: '', type: 'all', sel: { b: '', dur: '', v: '', sort: 'new' } })
        && A.canonHash('#/tags?b=jp_subbed') === '#/c/jp?b=jp_subbed' && A.parseRoute('#/c/more?b=softcore').type === 'softcore' && A.canonHash('#/c/more?b=fetish') === '#/c/all?b=fetish' && A.canonHash('#/c/more') === '#/c/all',
        'parseRoute:标签页 / 女优页;旧的标签云页 #/tags?b= 和旧「更多」大类 #/c/more?b= → 新的浏览页');
    ok(['', '#', '#admin', '#/admin', '#/tag/x_minor', '#/tag/bad id', '#/c/nope', '#/c/jp/x', '#/actress/../x', '#/w/abc', '#/' + 'c'.repeat(700), 'javascript:alert(1)'].every(h => A.parseRoute(h) === null), 'parseRoute:空 / #admin / blocked 标签 / 不认识的大类 / 多余路径 / 超长 → null');
    ok(A.isOurHash('#/c/jp') && A.isOurHash('#/tags') && A.isOurHash('#/tag/x') && A.isOurHash('#/actress/a') && !A.isOurHash('#admin') && !A.isOurHash('#/admin') && !A.isOurHash(''), 'isOurHash:只认这几种');
    // ---- 卡片发行日期 / 新片速递 ----
    const c1 = A.cardToItem({ wk: 'c:SSIS-100', name: 'SSIS-100 合成', sub: '3小时前 · 2:00:00 · 3线', dur: 7200, n_sites: 3, released: '2026-10-01' });
    const c2 = A.cardToItem({ wk: 't:abc', name: '合成国产', sub: '1天前', released: '2026-10-01' });
    const c3 = A.cardToItem({ wk: 'c:SSIS-101', name: 'x', sub: '1天前', released: '2026-02-30' });
    ok(c1._sub === '2026-10-01 · 3小时前' && c1._rel === '2026-10-01' && c2._sub === '1天前' && !('_rel' in c2) && c3._sub === '1天前' && !('_rel' in c3), '卡片副行:番号作品有发行日期 → 先写发行日;非番号作品 / 假日期(2 月 30)不写');
    ok(A.relDate('2024-09-28') === '2024-09-28' && A.relDate('1949-01-01') === '' && A.relDate('2024-9-28') === '' && A.relDate(null) === '', 'relDate');
    const freshItems = (n) => Array.from({ length: n }, (_, i) => ({ wk: 'c:FR-' + (100 + i), name: 'FR-' + (100 + i), released: '2026-11-0' + (1 + (i % 9)) }));
    const hr = A.homeToRows({ rows: [{ id: 'new', title: '新上架', more: { sort: 'new' }, items: [{ wk: 'c:A-1', name: 'a' }] }, { id: 'hot', title: '本站热门', source: 'local', items: [{ wk: 'c:H-1', name: 'h' }] }, { id: 'fresh', title: '新片速递', more: { sort: 'released' }, items: freshItems(12) }] });
    ok(eq(hr.order, ['ad_new', 'ad_hot', 'ad_fresh']) && hr.configs.ad_fresh.title === '新片速递' && hr.configs.ad_fresh.icon === 'fa-calendar-check' && eq(hr.configs.ad_fresh.more, { sort: 'released' })
        && /^2026-11-0\d · /.test(hr.lists.ad_fresh[0]._sub) === false && hr.lists.ad_fresh[0]._sub === '2026-11-01', '新片速递:紧跟热门(服务器给的次序)、「全部」→ 发行日期排序、卡片副行是发行日', hr.lists.ad_fresh[0]);
    ok(eq(A.homeToRows({ rows: [{ id: 'fresh', more: { sort: 'released' }, items: freshItems(11) }] }).order, []) && A.homeToRows({ rows: [{ id: 'fresh', items: freshItems(12) }] }).configs.ad_fresh.title === '新片速递', '新片速递不足 12 部整行不出;缺标题用「新片速递」');
    // ---- 作品信息条 phase 3 ----
    const g = { _wk: 'c:SSIS-200', sources: [{ site_key: 's1' }] };
    const m = A.metaView({
        code: 'SSIS-200', bucket: 'jp_censored', released: '2026-09-28', maker: 'S1 NO.1 STYLE', label: 'S1', avdb: true,
        actress: [{ aid: 'a:12345', name: '合成女优甲' }, { aid: 'a:12345', name: '重复' }, { aid: 'bad!', name: '合成女优乙' }, '合成女优丙', { name: '' }],
        tags: [{ id: 'busty', label: '巨乳', group: 'body', featured: true }, { id: 'black_stockings', label: '黑丝', group: 'outfit', featured: true }, { id: 'subbed', label: '中字', group: 'spec', featured: true },
            { id: 'sleep', label: '睡眠', group: 'act', featured: true }, { id: 'noncon', label: '强制凌辱', group: 'story', featured: false }, { id: 'x_school', label: 'x', group: '_blocked', featured: true },
            { id: 'legs', label: '美腿', group: 'body', featured: true }, { id: 'oral', label: '口交', featured: true }],
    }, g);
    ok(m.released === '2026-09-28' && eq(m.studio, { id: 'S1 NO.1 STYLE', label: 'S1 NO.1 STYLE' }) && m.label === 'S1' && m.avdb === true, '信息条:发行日期、厂牌(片商 maker → 按厂牌浏览)、发行牌子不同于片商时作文字', m);
    ok(eq(m.actress, [{ aid: 'a:12345', name: '合成女优甲' }, { aid: '', name: '合成女优乙' }, { aid: '', name: '合成女优丙' }]), '演员:有 aid 的进女优页;坏 aid 当纯名字(点了搜索);同 aid 去重', m.actress);
    ok(eq(m.tagGroups.map(x => [x.id, x.tags.map(t => t.id)]), [['spec', ['subbed']], ['body', ['busty', 'legs']], ['outfit', ['black_stockings']], ['', ['oral']]]) && m.tagGroups[1].label === '身材·外貌',
        '标签按分面组排(规格 → 身材 → 服装…,没有组的放最后);审查类(睡眠 featured 也不行、强制凌辱)/ blocked 一律不出', m.tagGroups);
    ok(A.metaView({ bucket: 'cn_hookup', actress: [{ aid: 'a:1', name: '合成名' }], studio: { id: '麻豆传媒', label: '麻豆传媒' } }, { sources: [] }).actress.length === 0
        && eq(A.metaView({ studio: { id: '麻豆传媒', label: '麻豆' } }, { sources: [] }).studio, { id: '麻豆传媒', label: '麻豆' }) && A.metaView({}, { sources: [] }).studio === null && A.metaView({}, { sources: [] }).released === '', '素人类分类不出演员(aid 也不行);_meta.studio 对象优先;没有就 null');
    // ---- 标签云 / 标签页 / 女优 / 厂牌 ----
    const cl = A.cloudOf({ groups: [{ id: 'outfit', label: '服装·制服', tags: [{ id: 'black_stockings', label: '黑丝', count: 200 }] },
        { id: 'body', label: '身材·外貌', tags: [{ id: 'legs', label: '美腿', count: 3 }, { id: 'busty', label: '巨乳', count: 1000 }, { id: 'small_tits', label: '贫乳', count: 50 }, { id: 'heels', label: '高跟鞋', count: 0 }, { id: 'oral', label: '口交', count: 0 }] },
        { id: 'story', label: '剧情·关系', tags: [{ id: 'noncon', label: '强制凌辱', count: 999 }, { id: 'x_voyeur', label: 'x', count: 9 }] }] }, { t: ['busty'], x: ['heels'] });
    ok(eq(cl.map(x => x.id), ['outfit', 'body']) && eq(cl[1].tags.map(t => [t.id, t.w, t.st]), [['busty', 5, 'in'], ['legs', 1, ''], ['heels', 1, 'ex']]) && cl[0].tags[0].w >= 3 && cl[0].tags[0].w <= 4 && eq(A.cloudOf(null, {}), []),
        '全部标签(浏览页就地展开):按分面组排、数为 0 的不列(已选 / 已排除的照列)、字号档按 log(数量);审查类 / blocked 不进', cl);
    const ti = A.normTagInfo({ tag: { id: 'black_stockings', label: '黑丝', group: 'outfit', count: 168 }, buckets: [{ id: 'live', count: 72 }, { id: 'x_bad', count: 3 }, { id: 'cn_amateur', count: 0 }],
        related: [{ id: 'heels', label: '高跟鞋', lift: 20.5 }, { id: 'noncon', label: '强制凌辱', lift: 9 }, { id: 'x_drug', label: 'x' }, { id: 'black_stockings', label: '自己' }] });
    ok(ti && ti.tag.label === '黑丝' && ti.tag.groupLabel === '服装·制服' && ti.tag.count === 168 && eq(ti.buckets, [{ id: 'live', label: '主播直播', count: 72 }]) && eq(ti.related, [{ id: 'heels', label: '高跟鞋' }]) && !ti.tag.review,
        '标签页:按分类细分(去掉 0 和非导航桶)、相关标签只要 featured(审查类 / blocked / 自己都去掉)', ti);
    const tr = A.normTagInfo({ tag: { id: 'noncon', label: '强制凌辱' }, related: [{ id: 'heels', label: '高跟鞋' }] });
    ok(tr && tr.tag.review === true && eq(tr.related, []) && A.normTagInfo({ tag: { id: 'x_minor', label: 'x' } }) === null && A.normTagInfo(null) === null, '审查类标签页:没有相关标签;blocked → null(当 404)');
    ok(eq(A.normActress({ actress: { aid: 'a:7', name: '合成女优丁', aliases: ['合成别名', '合成女优丁', '', '合成别名'] } }), { aid: 'a:7', name: '合成女优丁', aliases: ['合成别名'], latest: '' }) && A.normActress({ actress: { aid: '..', name: 'x' } }) === null, 'normActress');
    ok(eq(A.normActressList([{ aid: 'a:1', name: '合成甲', n: 30 }, { aid: 'a:1', name: '重复' }, { aid: 'x y', name: 'z' }]), [{ aid: 'a:1', name: '合成甲', n: 30 }]) && eq(A.normActressList(null), []), 'normActressList(≤10)');
    ok(eq(A.normStudios([{ id: 'S1', label: 'S1', count: 40 }, { id: '', label: 'x' }, { id: 'S1' }]), [{ id: 'S1', label: 'S1', count: 40 }]), 'normStudios');
    // AVDB 的 aid 是整数(行号):facets / 信息条 / 女优页 / 搜索都转成字符串;0、负数、小数不认
    ok(eq(A.normFacets({ actress: [{ aid: 123, name: '合成甲', count: 2 }, { aid: -1, name: 'x' }, { aid: 1.5, name: 'y' }, { aid: 0, name: 'z' }] }).actress, [{ aid: '123', name: '合成甲', count: 2 }])
        && eq(A.metaView({ actress: [{ aid: 7, name: '合成乙' }, { aid: null, name: '合成丙' }] }, { sources: [] }).actress, [{ aid: '7', name: '合成乙' }, { aid: '', name: '合成丙' }])
        && A.catalog.normSel('all', { actress: 42 }).actress === '42' && A.routeOf('', 'all', { actress: 42 }) === '#/actress/42' && eq(A.parseRoute('#/actress/42').sel, { actress: '42' })
        && A.normActress({ actress: { aid: 9, name: '合成丁' } }).aid === '9' && eq(A.normActressList([{ aid: 5, name: '合成戊', n: 1 }]), [{ aid: '5', name: '合成戊', n: 1 }]), '整数 aid(AVDB 行号)全链路认,统一成字符串');
    ok(A.catalog.normSel('all', { studio: 'S1 "x`\\' }).studio === 'S1 x' && A.catalog.normSel('all', { studio: 'x'.repeat(100) }).studio.length === 80
        && A.catalog.normSel('all', { studio: "M's video" }).studio === "M's video", '厂牌键与服务器白名单一致:≤80 字、去掉双引号 / 反引号 / 反斜杠;单引号留着(M\'s video)');
    // 标签页部数:服务器在顶层给 count({tag, count, buckets, related, items}),tag 里没有
    const tc = A.normTagInfo({ tag: { id: 'black_stockings', label: '黑丝', group: 'outfit' }, count: 37, buckets: [], related: [] });
    ok(tc && tc.tag.count === 37, '标签页部数读顶层 count', tc);
    // 词表对齐:lib/adult/tag-vocab.json(后端词表)里 review / blocked 的,前端一个都不做按钮;featured 的前端都认
    const vocabP = path.join(ROOT, 'lib/adult/tag-vocab.json');
    if (fs.existsSync(vocabP)) {
        const V = JSON.parse(fs.readFileSync(vocabP, 'utf8')).tags || [];
        const mism = V.filter(t => (t.status === 'featured') !== A.featurable(t.id)).map(t => t.id + ':' + t.status);
        ok(V.length > 100 && !mism.length, '前端 featurable 与 lib/adult/tag-vocab.json 的 featured/review/blocked 完全一致', mism);
    }
}
{
    // ---- 混入:分面浏览(游标翻页 / facets / 退路)----
    const app = makeApp();
    app._browseFill = () => { };
    app.browse.open = true; app.browse.type = 'jp'; app.browse.sel = C2().normSel('jp', { b: 'jp_censored', t: ['busty'] });
    let page = 0;
    const card = (i) => ({ wk: 'c:CU-' + i, name: 'CU-' + i, pic: 'https://p/' + i + '.jpg', released: '2026-01-0' + (1 + (i % 9)) });
    net.calls.length = 0;
    net.handler = (u) => {
        if (!u.startsWith('/api/catalog/browse')) return null;
        page++;
        if (page === 1) return { body: { page: 1, total_pages: 3, total_results: 12345, cursor_next: 'cur-2', results: Array.from({ length: 24 }, (_, i) => card(i)), facets: { groups: [{ id: 'body', label: '身材·外貌', tags: [{ id: 'busty', label: '巨乳', count: 9 }] }], sorts: [{ id: 'new', available: true }, { id: 'released', available: true }] } } };
        if (page === 2) return { body: { total_results: 12345, cursor_next: null, results: Array.from({ length: 24 }, (_, i) => card(i + 20)) } };
        return { body: { results: [] } };
    };
    await app._browseFetch(true);
    ok(net.calls[0] === '/api/catalog/browse?b=jp_censored&t=busty&sort=new&page=1&facets=1' && app.browse.items.length === 24 && app.browse.total === 12345 && !app.browse.done, '第 1 页:带 facets=1;总数 12345(标题栏显示「1万+」)', net.calls);
    ok(app.adult.facets && Object.isFrozen(app.adult.facets) && eq(app.adult.facets.sorts, ['new', 'released']) && !net.calls.some(u => u.startsWith('/api/catalog/tags')), 'facets 冻结后挂在 adult.facets;有 facets 就不再拉旧的标签列表');
    ok(app.browseCountLabel(app.browse.total) === '1万+', '筛选后的总数超过一万写「1万+」');
    app.browseMore(false);
    await sleep(5); for (let i = 0; i < 4; i++) await tick();
    ok(net.calls[1] === '/api/catalog/browse?b=jp_censored&t=busty&sort=new&cursor=cur-2' && app.browse.items.length === 44 && app.browse.done, '第 2 页按 cursor_next 翻(不带 page、不再要 facets);去重;cursor_next 为 null → 到底', net.calls);
    // 旧服务器:没有 cursor_next → 按页;没有 facets → 标签行退回 /api/catalog/tags
    const app2 = makeApp();
    app2._browseFill = () => { };
    app2.browse.open = true; app2.browse.type = 'all'; app2.browse.sel = C2().normSel('all', {});
    net.calls.length = 0;
    net.handler = (u) => (u.startsWith('/api/catalog/browse') ? { body: { page: 1, total_pages: 2, total_results: 30, results: [card(1)] } } : u.startsWith('/api/catalog/tags') ? { body: { tags: [] } } : null);
    await app2._browseFetch(true);
    app2.browse.idle = 0;
    app2.browseMore(false);
    await sleep(5); for (let i = 0; i < 4; i++) await tick();
    ok(net.calls.includes('/api/catalog/browse?sort=new&page=2') && net.calls.includes('/api/catalog/tags?b=') && app2.adult.facets === null && app2.browse.done, '没有 cursor_next → 按页翻(退路);没有 facets → 标签行用 /api/catalog/tags', net.calls);
    // 换筛选时在飞的旧请求作废
    const app3 = makeApp();
    app3._browseFill = () => { };
    app3.browse.open = true; app3.browse.type = 'all'; app3.browse.sel = C2().normSel('all', {});
    let release = null;
    net.handler = (u) => (u.startsWith('/api/catalog/browse') ? { body: { results: [card(u.includes('v=zh') ? 2 : 1)], total_results: 1, cursor_next: null } } : null);
    const slowFetch = globalThis.fetch;
    globalThis.fetch = (u, o) => (String(u).includes('v=zh') ? slowFetch(u, o) : new Promise(r => { release = () => r(slowFetch(u, o)); }));
    const pOld = app3._browseFetch(true);
    app3.browse.sel = C2().normSel('all', { v: 'zh' });
    await app3._browseFetch(true);
    release(); await pOld;
    globalThis.fetch = slowFetch;
    ok(app3.browse.items.length === 1 && app3.browse.items[0]._wk === 'c:CU-2', '换了筛选:旧请求晚回来也不混进新片单');
    // 成人站不按 600 张封顶(网格是窗口化的)
    const app4 = makeApp();
    let fetched = 0;
    app4._browseFetch = () => { fetched++; };
    app4.browse.open = true; app4.browse.items = new Array(700).fill(0);
    app4.browseMore(false);
    const app5 = makeApp({ adultMode: false });
    let f5 = 0;
    app5._browseFetch = () => { f5++; };
    app5.browse.open = true; app5.browse.items = new Array(700).fill(0);
    app5.browseMore(false);
    ok(fetched === 1 && f5 === 0, '成人站浏览页 700 张之后照样自动往下拉;主站仍按 600 张封顶');
}
// 假地址栏 + 历史(adult.js 用 root.location / root.history)
function fakeNav(hash) {
    const entries = [{ url: '/' + (hash || ''), state: null }];
    let idx = 0;
    const loc = { pathname: '/', search: '', hash: hash || '', href: 'https://site.test/' + (hash || ''), replace() { } };
    const sync = () => { const u = entries[idx].url, i = u.indexOf('#'); loc.hash = i >= 0 ? u.slice(i) : ''; };
    const norm = (url) => (url == null ? entries[idx].url : url.startsWith('#') ? '/' + url : url);
    const ops = [];
    const hist = {
        get state() { return entries[idx].state; },
        pushState(st, _, url) { entries.splice(idx + 1); entries.push({ url: norm(url), state: st }); idx++; sync(); ops.push('push ' + entries[idx].url); },
        replaceState(st, _, url) { entries[idx] = { url: norm(url), state: st }; sync(); ops.push('replace ' + entries[idx].url); },
        back() { if (idx > 0) { idx--; sync(); ops.push('back'); } },
    };
    return { loc, hist, ops, entries, get idx() { return idx; } };
}
function C2() { return A.catalog; }
{
    // ---- 地址栏路由 ----
    const nav = fakeNav('#/c/jp?b=jp_subbed&t=busty&sort=released');
    const L0 = globalThis.location, H0 = globalThis.history;
    globalThis.location = nav.loc; globalThis.history = nav.hist;
    const app = makeApp();
    app._jumpTo = () => { };
    app._browseFill = () => { };
    net.calls.length = 0;
    net.handler = (u) => (u.startsWith('/api/catalog/home') ? { body: { rows: [{ id: 'new', title: '新上架', more: { sort: 'new' }, items: [{ wk: 'c:A-1', name: 'a' }] }] } }
        : u.startsWith('/api/catalog/browse') ? { body: { results: [{ wk: 'c:R-1', name: 'R-1' }], total_results: 1, cursor_next: null, facets: { sorts: ['new', 'released'] } } } : u.startsWith('/api/catalog/buckets') ? { body: [] } : null);
    ok(app.adRouteHash === null, '启动之前不写地址栏(adRouteHash = null)');
    await app.adultLoadHome();
    await sleep(5); for (let i = 0; i < 4; i++) await tick();
    ok(app.adult.routeOn && app.browse.open && app.browse.type === 'jp' && eq(app.browse.sel, { b: 'jp_subbed', dur: '', v: '', sort: 'released', t: ['busty'] }) && net.calls.includes('/api/catalog/browse?b=jp_subbed&t=busty&sort=released&page=1&facets=1'),
        '刷新 / 书签:首页拿到后按地址栏直接开浏览页并拉片单', [app.browse.sel, net.calls]);
    app._adRouteSync(app.adRouteHash);
    ok(app.adRouteHash === '#/c/jp?b=jp_subbed&t=busty&sort=released' && !nav.ops.length, '地址栏已经是这一页:不重复写');
    // 改筛选 → 新的一条历史
    app.adGo({ patch: { t: ['busty', 'legs'] } });
    app._adRouteSync(app.adRouteHash);
    ok(nav.loc.hash === '#/c/jp?b=jp_subbed&t=busty,legs&sort=released' && nav.ops[0] === 'push /#/c/jp?b=jp_subbed&t=busty,legs&sort=released' && nav.hist.state.dgAd === 1, '改筛选:压一条新历史(只有 id)', nav.ops);
    ok(!/[一-龥]|R-1/.test(decodeURIComponent(nav.loc.hash)), '地址栏不写片名(只有大类 / 分类 / 标签 id)');
    // 换分类(patch.b)→ 大类跟着变
    app.adGo({ patch: { b: 'cn_studio' } });
    ok(app.browse.type === 'cn' && app.browse.sel.b === 'cn_studio' && eq(app.browse.sel.t, ['busty', 'legs']), '面板里选分类:大类跟着换,其余筛选保留');
    app._adRouteSync(app.adRouteHash);
    // 后退 → hashchange → 按地址栏恢复
    nav.hist.back();
    app._adOnHash();
    ok(app.browse.type === 'jp' && eq(app.browse.sel.t, ['busty', 'legs']) && app.browse.sel.b === 'jp_subbed', '后退:按地址栏恢复上一组筛选', app.browse.sel);
    app._adRouteSync(app.adRouteHash);
    ok(nav.ops[nav.ops.length - 1] === 'back', '从地址栏恢复的不再压历史');
    // 播放页开着时后退:关播放页、浏览页不动、刚退掉的那条压回去
    app.showDetail = true;
    const before = JSON.stringify(app.browse.sel);
    nav.hist.back();
    app._adOnHash();
    ok(app.closed === 1 && JSON.stringify(app.browse.sel) === before && nav.loc.hash === '#/c/jp?b=jp_subbed&t=busty,legs&sort=released', '播放页开着按返回:只关播放页,浏览页和地址栏留在原样', nav.ops.slice(-2));
    // 标签页 / 标签云 / 女优页
    net.calls.length = 0;
    app.adGo({ view: 'tag', id: 'black_stockings' });
    app._adRouteSync(app.adRouteHash);
    ok(app.adult.view === 'tag' && app.browse.type === 'all' && eq(app.browse.sel.t, ['black_stockings']) && nav.loc.hash === '#/tag/black_stockings' && net.calls.includes('/api/catalog/browse?t=black_stockings&sort=new&page=1&facets=1'), '标签页:#/tag/<id>,片单 = 全部 + 这个标签', nav.loc.hash);
    ok(app.adBrowseTitle.indexOf('#') === 0, '标签页标题 #标签名', app.adBrowseTitle);
    app.adGo({ patch: { sort: 'dur' } });
    app._adRouteSync(app.adRouteHash);
    ok(app.adult.view === '' && nav.loc.hash === '#/c/all?t=black_stockings&sort=dur', '标签页上改了排序 → 变成普通浏览页', nav.loc.hash);
    net.calls.length = 0;
    app.adGo({ view: 'tags', b: 'jp_censored' });
    app._adRouteSync(app.adRouteHash);
    ok(app.adult.view === '' && nav.loc.hash === '#/c/jp?b=jp_censored' && net.calls.includes('/api/catalog/browse?b=jp_censored&sort=new&page=1&facets=1') && app.adBrowseTitle === '日本 · 有码',
        '旧的标签云入口 {view:tags} → 那个分类的普通浏览页(全部标签改在筛选行里就地展开)', [nav.loc.hash, net.calls, app.adBrowseTitle]);
    app.setBrowseFilter('b', 'jp_subbed');
    app._adRouteSync(app.adRouteHash);
    ok(app.adult.view === '' && nav.loc.hash === '#/c/jp?b=jp_subbed', '旧地址带的日本分区照样认(日本没有细分行,标题写着)');
    app.adGo({ sel: { b: 'jp_subbed', t: ['busty'] } });
    app._adRouteSync(app.adRouteHash);
    ok(app.adult.view === '' && nav.loc.hash === '#/c/jp?b=jp_subbed&t=busty', '分类 + 标签筛');
    net.calls.length = 0;
    app.adGo({ sel: {}, type: 'jp' });
    app._adRouteSync(app.adRouteHash);
    ok(nav.loc.hash === '#/c/jp' && net.calls.includes('/api/catalog/browse?b=jp_censored,jp_uncensored,jp_subbed&sort=new&page=1&facets=1') && app.adBrowseTitle === '日本', '「日本」整类:三个分区一起查(b 逗号分隔),地址不带 b', [nav.loc.hash, net.calls]);
    app.adGo({ patch: { b: 'fetish' } });
    app._adRouteSync(app.adRouteHash);
    ok(app.browse.type === 'all' && nav.loc.hash === '#/c/all?b=fetish' && app.adBrowseTitle === 'SM·重口', '筛选面板「分类」点孤儿分区 → 全部 · SM·重口', [nav.loc.hash, app.adBrowseTitle]);
    learnActressViaFacets();
    app.adMetaActress({ aid: 'a:12345', name: '合成女优甲' });
    app._adRouteSync(app.adRouteHash);
    ok(nav.loc.hash === '#/actress/a%3A12345' && app.adBrowseTitle === '女优 · 合成女优甲', '信息条的女优 → #/actress/<aid>(浏览页按 actress 筛)', [nav.loc.hash, app.adBrowseTitle]);
    app.adMetaStudio({ id: 'S1', label: 'S1' });
    app._adRouteSync(app.adRouteHash);
    ok(nav.loc.hash === '#/c/all?studio=S1', '信息条的厂牌 → 按厂牌浏览');
    let searchedKw = null;
    app.adMetaSearch = (k) => { searchedKw = k; };
    app.adMetaActress({ aid: '', name: '合成纯名字' });
    ok(searchedKw === '合成纯名字', '没有 aid 的旧演员名 → 照旧全站搜');
    const h0 = nav.loc.hash;
    app.adMetaTag('noncon'); app.adMetaTag('x_school');
    ok(nav.loc.hash === h0 && app.adult.view === '', '审查类 / blocked 标签不导航');
    // 关浏览页 → 地址栏回到首页(新的一条);别人的 # 不动
    app.closeBrowse();
    app._adRouteSync(app.adRouteHash);
    ok(!app.browse.open && nav.loc.hash === '' && nav.entries[nav.idx].url === '/' && app.adult.view === '', '关浏览页:地址栏去掉 #');
    nav.hist.pushState(null, '', '#admin');
    app._adRouteSync(app.adRouteHash);
    app._adOnHash();
    ok(nav.loc.hash === '#admin' && !app.browse.open, '#admin 之类别人的 # 不碰');
    // 坏掉的旧路由:启动时清掉
    const nav2 = fakeNav('#/c/nope?b=zz');
    globalThis.location = nav2.loc; globalThis.history = nav2.hist;
    const appB = makeApp();
    appB._adRouteBoot();
    ok(appB.adult.routeOn && !appB.browse.open && nav2.loc.hash === '' && nav2.ops[0] === 'replace /', '启动时地址栏是坏掉的路由:清掉,停在首页');
    // ---- 筛选面板的历史:开 = 压一条同地址;面板里改筛选 = 替换那一条;关 = 退掉,再把最终筛选压成新的一条 ----
    const nav3 = fakeNav('');
    globalThis.location = nav3.loc; globalThis.history = nav3.hist;
    const appS = makeApp();
    appS._jumpTo = () => { }; appS._browseFill = () => { };
    appS.adult.routeOn = true;
    appS.adGo({ sel: { b: 'jp_censored' } });
    appS._adRouteSync(appS.adRouteHash);
    const base = nav3.loc.hash;
    let closedByPop = 0;
    appS.$refs = { adFilter: { closeSheet(fromPop) { if (fromPop) closedByPop++; }, openSheet() { return true; } } };
    appS.adSheet(true);
    ok(nav3.hist.state.dgAdSheet > 0 && nav3.loc.hash === base, '开面板:压一条同地址的历史(手机返回键先关面板)');
    appS.adGo({ patch: { t: ['busty'] } });
    appS._adRouteSync(appS.adRouteHash);
    appS.adGo({ patch: { v: 'zh' } });
    appS._adRouteSync(appS.adRouteHash);
    ok(nav3.entries.length === 3 && nav3.hist.state.dgAdSheet > 0 && nav3.loc.hash === '#/c/jp?b=jp_censored&t=busty&v=zh', '面板开着改筛选:替换面板那一条(不越压越多),标记还在', nav3.ops);
    appS.adSheet(false);
    ok(nav3.ops[nav3.ops.length - 1] === 'back' && nav3.loc.hash === base, '点关闭:退掉面板那一条');
    appS._adOnPop();
    ok(nav3.loc.hash === '#/c/jp?b=jp_censored&t=busty&v=zh' && nav3.idx === 2 && closedByPop === 0 && !appS._adSheetHist, '退掉之后:最终筛选压成新的一条(后退 = 回到开面板前的筛选)', nav3.ops);
    // 手机返回键关面板
    appS.adSheet(true);
    appS.adGo({ patch: { dur: 'unk' } });
    appS._adRouteSync(appS.adRouteHash);
    nav3.hist.back();
    appS._adOnPop();
    ok(closedByPop === 1 && nav3.loc.hash === '#/c/jp?b=jp_censored&t=busty&dur=unk&v=zh' && !appS._adSheetHist, '手机返回键:关面板(不关浏览页),筛选保留并压成新的一条', nav3.ops.slice(-3));
    ok(appS.adOpenSheet() === true && makeApp().adOpenSheet() === false, '顶上摘要条的「筛选」:有面板就直接打开面板,没有就照旧回到顶部');
    // 复核 r3:无痕时浏览路由(分类 / 标签 / 女优 / 厂牌)用 replaceState,不往浏览器历史里压
    const nav4 = fakeNav('');
    globalThis.location = nav4.loc; globalThis.history = nav4.hist;
    const P0 = globalThis.dgPrivacy;
    globalThis.dgPrivacy = { incognito: () => true };
    const appI = makeApp();
    appI._jumpTo = () => { }; appI._browseFill = () => { };
    appI.adult.routeOn = true;
    appI.adGo({ sel: { b: 'jp_censored' } });
    appI._adRouteSync(appI.adRouteHash);
    appI.adGo({ view: 'tag', id: 'black_stockings' });
    appI._adRouteSync(appI.adRouteHash);
    ok(nav4.entries.length === 1 && nav4.loc.hash === '#/tag/black_stockings' && nav4.ops.length === 2 && nav4.ops.every(o => o.startsWith('replace ')), '无痕:浏览路由只替换当前这一条(浏览器历史里不留分类 / 标签页)', nav4.ops);
    globalThis.dgPrivacy = P0;
    appI.adGo({ sel: { b: 'jp_subbed' } });
    appI._adRouteSync(appI.adRouteHash);
    ok(nav4.entries.length === 2 && nav4.ops[nav4.ops.length - 1].startsWith('push '), '关了无痕:照旧压新历史', nav4.ops);
    globalThis.location = L0; globalThis.history = H0;
}
function learnActressViaFacets() { A.normFacets({ actress: [{ aid: 'a:12345', name: '合成女优甲', count: 1 }] }); }
{
    // ---- 组件逻辑(假 this:props + data + computed 读值 + 方法)----
    function inst(def, props, extra) {
        const ev = [];
        const o = Object.assign({}, props || {});
        Object.assign(o, def.data ? def.data.call(o) : {});
        for (const [k, fn] of Object.entries(def.computed || {})) Object.defineProperty(o, k, { get: () => fn.call(o), configurable: true });
        for (const [k, fn] of Object.entries(def.methods || {})) o[k] = fn.bind(o);
        o.$emit = (n, a) => ev.push([n, a]);
        o.$nextTick = (f) => { if (f) f(); return Promise.resolve(); };
        o.$refs = {};
        return Object.assign(o, extra || {}, { _ev: ev });
    }
    const Fd = A.components.DgAdFilter;
    const facets = A.normFacets({
        buckets: [{ id: 'jp_censored', count: 30 }, { id: 'anime', count: 0 }],
        groups: [{ id: 'body', label: '身材·外貌', tags: [{ id: 'busty', label: '巨乳', count: 9 }, { id: 'legs', label: '美腿', count: 0 }] }],
        more: [{ id: 'noncon', label: '强制凌辱' }],
        dur: [{ id: 's', count: 4 }, { id: 'l', count: 9 }, { id: 'unk', count: 140 }],
        variant: [{ id: 'zh', count: 5 }],
        studio: [{ id: 'S1', label: 'S1', count: 4 }], actress: [{ aid: 'a:12345', name: '合成女优甲', count: 2 }],
    });
    const fi = inst(Fd, { sel: { b: '', sort: 'new', dur: 'l', t: ['busty'] }, type: 'all', facets, total: 23456, tv: false, legacy: [] });
    ok(fi.n === 2 && fi.countText === '2万+' && eq(fi.chips.map(c => c.id), ['busty', 'legs']) && fi.unkNote === 140, '面板:已选数、总数「2万+」、选了时长区间时提示「另有 N 部时长未知」');
    ok(eq(fi.durs.map(d => [d.k, d.c, d.off]), [['', null, false], ['s', 4, false], ['m', 0, true], ['l', 9, false], ['xl', 0, true], ['xxl', 0, true], ['unk', 140, false]]), '时长档:带数,0 的置灰(选中的不灰)', fi.durs);
    ok(eq(fi.sheetGroups[0].tags.map(t => [t.id, t.st]), [['busty', 'in'], ['legs', '']]) && eq(fi.more, [{ id: 'noncon', label: '强制凌辱', st: '' }]) && fi.buckets.length === 2, '面板:分组标签带状态;更多(审查类)不带数;「全部」大类给分类计数');
    fi.tap('legs');
    ok(eq(fi._ev[0], ['go', { patch: { t: ['busty', 'legs'], x: [] } }]), '标签行点一下 → go(patch t)');
    fi.tapSheet('busty');
    ok(eq(fi._ev[1], ['go', { patch: { t: [], x: ['busty'] } }]), '面板里再点已选的 → 排除');
    fi.xmode = true;
    fi.tapSheet('noncon');
    ok(eq(fi._ev[2], ['go', { patch: { t: ['busty'], x: ['noncon'] } }]), '排除模式:点一下直接排除(更多里的审查类也能排除)');
    const full = inst(Fd, { sel: { sort: 'new', t: ['a', 'b', 'c'] }, type: 'all', facets, total: 1, legacy: [] });
    full.tap('busty');
    ok(!full._ev.length && full.note === '最多同时选 3 个标签', '超过 3 个:不发请求,出提示');
    clearTimeout(full._noteT);
    fi.drop('dur'); fi.drop('review'); fi.clearAll();
    ok(eq(fi._ev.slice(-3).map(e => e[1].patch), [{ dur: '' }, { t: ['busty'], x: [] }, { t: [], x: [], dur: '', v: '', studio: '', actress: '', lp: '' }]), '去掉一项 / 去掉全部审查类标签 / 清除筛选(保留分类和排序)');
    fi.studios = A.normStudios([{ id: 'S1', label: 'S1', count: 4 }, { id: 'MOODYZ', label: 'MOODYZ', count: 3 }, { id: '麻豆传媒', label: '麻豆传媒', count: 9 }]);
    fi.sq = 'moo';
    ok(eq(fi.studioHits.map(s => s.id), ['MOODYZ']), '厂牌搜索:按名字子串(不分大小写)');
    const fa = inst(Fd, { sel: { sort: 'new', actress: 'a:999', studio: 'X9' }, type: 'jp', facets, total: 1, legacy: [] });
    ok(fa.actTop[0].aid === 'a:999' && fa.studioTop[0].id === 'X9' && fa.buckets.length === 0, '已选的女优 / 厂牌不在前 20 里也挂在最前;不是「全部」大类不出分类计数');
    // 女优搜索走 /api/catalog/actress?q=(250ms 防抖)
    net.calls.length = 0;
    net.handler = (u) => (u.startsWith('/api/catalog/actress?q=') ? { body: [{ aid: 'a:5', name: '合成搜到', n: 3 }] } : null);
    fa.aq = '合成'; fa.actSearch();
    await sleep(300); for (let i = 0; i < 4; i++) await tick();
    ok(net.calls[0] === '/api/catalog/actress?q=' + encodeURIComponent('合成') && eq(fa.aRes, [{ aid: 'a:5', name: '合成搜到', n: 3 }]), '女优搜索:/api/catalog/actress?q=', net.calls);
    // ---- 窗口化网格 ----
    const Gd = A.components.DgAdGrid;
    const items = Array.from({ length: 1000 }, (_, i) => Object.freeze({ id: 'c:G-' + i, _wk: 'c:G-' + i }));
    const gi = inst(Gd, { items, poster: null, tv: false, loading: false });
    gi.cols = 4;
    ok(gi.per === 24 && gi.nBlocks === 42 && gi.slice(41).length === 16 && gi.slice(0)[0].id === 'c:G-0', '网格按「6 排一块」切块(4 列 = 24 张一块)');
    const ent = (bi, on, h) => ({ target: { getAttribute: () => String(bi) }, isIntersecting: on, boundingClientRect: { height: h } });
    gi.onIO([ent(0, false, 1500), ent(1, false, 1490), ent(2, true, 1500), ent(41, false, 900)]);
    ok(eq(gi.dead, { 0: 1500, 1: 1490 }), '离开视口 ±1600px 的块变空壳(记下实测高度);最后一块(还在被填)永远是活的', gi.dead);
    gi.onIO([ent(0, true, 1500)]);
    ok(eq(gi.dead, { 1: 1490 }), '回到附近:恢复成卡片');
    const d0 = gi.dead;
    gi.onIO([ent(5, true, 1500)]);
    ok(gi.dead === d0, '没有变化的回调不写响应式状态');
    // 模板里只渲染活块的卡片(源码检查):空壳只有高度
    const tpl = Gd.template;
    ok(/<template v-if="dead\[bi - 1\] == null">/.test(tpl) && /:style="dead\[bi - 1\] != null \? \{ height: dead\[bi - 1\] \+ 'px' \} : null"/.test(tpl) && /class="browse-card"[^>]*:data-bid="item\.id"/.test(tpl), '网格模板:空壳块不渲染卡片;卡片沿用 .browse-card / data-bid(遥控器焦点还原照旧)');
    ok(!/scroll/i.test(Object.keys(Gd.methods).join(',')) && /IntersectionObserver/.test(fs.readFileSync(path.join(ROOT, 'public/adult/adult.js'), 'utf8')), '网格不监听滚动(只用 IntersectionObserver;resize 节流 200ms 才重量列数)');
    // 组件模板交给 Vue 编译器编一遍
    const vctx = { console: { log() { }, warn() { }, error() { } }, setTimeout, clearTimeout, navigator: { userAgent: 'node' }, document: { createElement: () => ({ style: {} }) }, SVGElement: function () { }, Element: function () { } };
    vctx.window = vctx; vctx.self = vctx;
    vm.createContext(vctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/libs/js/vue.global.prod.min.js'), 'utf8'), vctx);
    const cerr = [];
    for (const [n, def] of Object.entries(A.components)) {
        try { const fn = vctx.Vue.compile(def.template, { decodeEntities: (x) => x, onError: (e) => cerr.push(n + ': ' + e.message) }); if (typeof fn !== 'function') cerr.push(n + ': no fn'); } catch (e) { cerr.push(n + ': ' + e.message); }
    }
    ok(Object.keys(A.components).length === 6 && !A.components.DgAdCloud && !cerr.length, '六个组件(网格 / 筛选 / 页头 / p4 相关推荐 / 女优索引 / 手机换行展开)的模板都能被 Vue 编译;单独的标签云页已删', cerr);
    ok(A.mixin.components === undefined || eq(Object.keys(A.mixin.components), ['DgAdGrid', 'DgAdFilter', 'DgAdHead', 'DgAdRails', 'DgAdActresses', 'DgFold']), 'mixin 注册了这六个组件(index.html 用 <dg-ad-grid> / <dg-ad-rails> / <dg-ad-actresses> / dg-fold 等)');
    ok(A.components.DgAdFilter.components && A.components.DgAdFilter.components.DgFold === A.components.DgFold && /<dg-fold class="browse-fopts">\s*<button type="button" class="browse-fopt dg-alltags"/.test(A.components.DgAdFilter.template),
        '标签行:手机换行 + 展开,「全部标签」排第一');
    ok((HTML.match(/<component :is="adultMode \? 'dg-fold' : 'div'"/g) || []).length === 3 && (HTML.match(/v-for="t in \(adultMode \? adCatTypes : catTypes\)"/g) || []).length === 2, '首页 / 浏览页大类、浏览页筛选行都换成 dg-fold');
    ok(A.mixin.computed.adCatTypes.call({})[0].k === 'all' && A.mixin.computed.adCatTypes.call({}).length === 10, '大类一排「全部」排第一');
    // 组件里不用老 WebView 不认的语法(?. / ??)
    const SRCA = fs.readFileSync(path.join(ROOT, 'public/adult/adult.js'), 'utf8');
    ok(!/\?\.[a-zA-Z_$[(]/.test(SRCA.replace(/\/\/[^\n]*/g, '')) && !/[^?]\?\?[^?]/.test(SRCA.replace(/\/\/[^\n]*/g, '').replace(/'[^'\n]*'/g, "''")), 'adult.js 不用 ?. / ??(老电视 WebView 解析不了,整个文件会挂)');
}
{
    // ---- 模板接线 ----
    ok(/if \(this\.adultMode && typeof this\._adBrowseFetch === 'function'\) return this\._adBrowseFetch\(reset\);/.test(HTML), '_browseFetch 在成人站交给 _adBrowseFetch(游标 + facets)');
    ok(/b\.items\.length >= \(this\.adultMode \? 10000 : 600\)/.test(HTML), 'browseMore:成人站不按 600 张封顶');
    ok(/<dg-ad-grid v-if="adultMode" v-show="!adNoList" :cover="true" :items="browse\.items" :poster="getPosterUrl" :tv="isTVMode" :loading="browse\.loading" @pick="browsePick" @vis="adBrowseVis"><\/dg-ad-grid>/.test(HTML)
        && /<div class="browse-grid" v-if="!adultMode">/.test(HTML), '浏览页网格:成人站换成窗口化的 <dg-ad-grid>(点卡片照旧 browsePick;报出了几张 / 藏了几张),主站网格不动');
    // 封面加载不出来就藏:底栏「已经到底了 · 共 N 部」和空状态按网格出了几张算(藏掉的不算);收藏的封面用控制器换到的那张
    ok(/<div v-else-if="browse\.done && !\(adultMode \? adBrowseN : browse\.items\.length\)" class="browse-empty">/.test(HTML) && /已经到底了 · 共 \{\{ adultMode \? adBrowseN : browse\.items\.length \}\} 部/.test(HTML)
        && typeof A.mixin.computed.adBrowseN === 'function' && typeof A.mixin.methods.adBrowseVis === 'function', '浏览页底栏 / 空状态:按网格出了几张算(封面加载不出来藏掉的不算)');
    ok(/this\.imageMap && this\.imageMap\[pk\]\) \|\| \(this\.adultMode && typeof this\.adOkPic === 'function' && this\.adOkPic\(g, pk\)\) \|\| \(g && g\.pic\)/.test(HTML) && typeof A.mixin.methods.adOkPic === 'function',
        '收藏的封面:主封面坏了、封面控制器换到的备用地址真加载出来了 → 用那张');
    ok(A.components.DgAdGrid.emits.indexOf('vis') >= 0 && typeof A.components.DgAdGrid.methods.revealBack === 'function', '网格:报 vis;「显示」补滚动 / 焦点');
    ok(!/dg-ad-cloud/.test(HTML) && /<dg-ad-head v-if="adultMode" :view="adult\.view" :sel="browse\.sel" :total="browse\.total" @go="adGo" @learn="adLearned"><\/dg-ad-head>/.test(HTML),
        '标签页与女优页页头(没有单独的标签云页)');
    ok(/<h2 class="browse-title">\{\{ adultMode \? adBrowseTitle : browseTitle \}\}<\/h2>/.test(HTML) && /\{\{ adultMode \? adBrowseSummary : browseSummary \}\}/.test(HTML) && /@click="\(adultMode && adOpenSheet\(\)\) \|\| browseToTop\(\)"/.test(HTML), '标题 / 顶上摘要条(点「筛选」直接开面板)');
    ok(/<div class="browse-foot" ref="browseFoot" aria-live="polite" v-show="!adNoList">/.test(HTML) && !/adOpenTags/.test(HTML) && typeof A.mixin.methods.adOpenTags === 'undefined', '女优索引页不出片单底栏(adNoList);首页没有单独的「标签」入口');
    ok(/@click="adultMode \? openBrowse\(\{ type: t\.k, sel: \{\} \}\) : catNavSelect\(t\.k\)"/.test(HTML) && /<div class="catnav-body" role="group" v-if="!adultMode"/.test(HTML) && /class="cat-tab cat-tab-all" @click="openCatDir\(\)" v-if="!adultMode"/.test(HTML),
        '成人版首页分类栏只有一排大类:点了直接进浏览页;没有「全部分类」(分类大全)和下面的细分块');
    ok(/<span v-if="adMeta\.released" class="dg-meta-t dg-meta-rel">/.test(HTML) && /@click="adMetaStudio\(adMeta\.studio\)"/.test(HTML) && /@click="adMetaActress\(a\)"/.test(HTML)
        && /<div v-for="g in adMeta\.tagGroups" :key="'mg-' \+ g\.id" class="dg-meta-tg">/.test(HTML), '信息条:发行日期 / 厂牌 / 女优(进女优页)/ 按分面组排的标签');
    const browseTpl = HTML.slice(HTML.indexOf('<div class="browse-page" v-if="browse.open"'), HTML.indexOf('<div class="browse-sticky"'));
    const vfor = browseTpl.indexOf('v-for="item in browse.items"');
    ok(browseTpl.length > 1000 && vfor > browseTpl.indexOf('<div class="browse-grid" v-if="!adultMode">') && browseTpl.indexOf('<div class="browse-grid" v-if="!adultMode">') > browseTpl.indexOf('<dg-ad-grid'),
        '根模板里 v-for 整个片单的只剩主站那份(v-if="!adultMode");成人站走组件');
}
console.log('⑤ 页面接线 / sw.js');
{
    const head = HTML.slice(0, HTML.indexOf('</head>'));
    const headNoComments = head.replace(/<!--[\s\S]*?-->/g, '');
    ok(/<title>MEI\.NU<\/title>/.test(head) && !/E视界/.test(headNoComments) && !/E视界/.test(head), '<title> 是站名,head 里不再有主站品牌');
    ok(/<meta name="robots" content="noindex, nofollow, noarchive">/.test(head) && !/og:|twitter:|rel="canonical"|ednovas\.video/.test(head), 'robots noindex;没有 OG / Twitter 卡片 / canonical / 主站域名');
    ok(!/<link rel="(dns-prefetch|preconnect)" href="[^"]*(tmdb|themoviedb)/.test(headNoComments), '不预连接 TMDB');
    // ?v= 不钉死:页面引用的版本 = sw.js 预缓存的版本(升版时两处一起改,测试跟着走)
    const AV = (/src="adult\/adult\.js\?v=(\d+)"/.exec(head) || [])[1] || '';
    const iAdult = AV ? head.indexOf('src="adult/adult.js?v=' + AV + '"') : -1, iVue = head.indexOf('vue.global.prod.min.js');
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
    ok(body.split('<span data-dg-brand aria-label="MEI.NU">' + A.brand.html('MEI.NU') + '</span>').length === 3, 'loader / 登录框的静态字标和 brand.html() 一字不差(JS 起来前后不跳)');
    ok(HTML.includes(`<span :aria-label="(adult && adult.siteName) || 'MEI.NU'" v-html="adBrandHtml"></span>`) && !/dg-wm-m|adBrandTail/.test(HTML), '导航栏站名走 adBrandHtml(画好的字标)');
    ok(HTML.includes('this.adultMode && typeof this.adHomeKeys === \'function\' ? this.adHomeKeys(Object.keys(this.rowConfigs))') && /v-for="\(s, i\) in adRowsView"/.test(HTML)
        && /@change="adRowsAdd\(\$event\.target\.value, \$event\)"/.test(HTML) && HTML.includes('this.adRowsPulled(data.settings.adHomeRows)') && HTML.includes('this.adRowsFlush()'),
        '首页分类行:homeBlocks 按 adHomeKeys 排、设置里列表 + 添加下拉、同步拉取 / 关弹窗推送都接上');
    // phase 2 模板接线
    ok((HTML.match(/<template v-if="item\._wk"><span v-if="item\._n >= 2" class="dg-ov-n">\{\{ item\._n \}\}线<\/span><span v-if="item\._durText" class="dg-ov-dur">\{\{ item\._durText \}\}<\/span><span v-if="item\._code" class="dg-ov-code">\{\{ item\._code \}\}<\/span><\/template>/g) || []).length === 3,
        '首页行两处 + 浏览页:海报上叠 N线(≥2)/ 时长 / 番号');
    ok(/<span v-if="config\.adult && config\.srcLabel" class="dg-row-src" :title="config\.srcTip">\{\{ config\.srcLabel \}\}<\/span>/.test(HTML), '热门行标题旁的来源角标(本站热门 / 外站热门)');
    ok(/<button v-if="key !== 'randomRow'" v-show="!\(config\.adult && !config\.more\)" type="button" class="expand-toggle row-all"/.test(HTML), '没有 more 的目录行(热门)不给「全部」');
    ok(/<dg-ad-filter v-if="adultMode && !adNoList" ref="adFilter" :sel="browse\.sel"[^>]*:legacy="adTagOpts" @go="adGo" @sheet="adSheet"><\/dg-ad-filter>/.test(HTML), '浏览页:标签行 + 排序 + 筛选面板(<dg-ad-filter>,旧服务器的标签列表当后备)');
    ok(/<div class="search-section" @focusout="adultMode && adSugBlur\(\$event\)"/.test(HTML) && /@keydown="adultMode && adSugKey\(\$event\)" @focus="adultMode && adSugFocus\(\)"/.test(HTML)
        && /<div v-if="adultMode && adult\.sug\.open && adSugRows\.length" class="dg-sug"/.test(HTML) && /@mousedown\.prevent @click="adSugPick\(r\)"/.test(HTML), '搜索建议下拉:焦点离开收起、方向键、点行不先失焦');
    ok(/if \(this\.adultMode && typeof this\.adSuggestInput === 'function' && this\.adSuggestInput\(this\.keyword\)\) return;\s*\n\s*if \(!this\.keyword \|\| this\.keyword\.length < 2\)/.test(HTML), 'debouncedSearch 最前面:成人站交给搜索建议(不再自动全站搜)');
    ok(/<template v-if="adultMode && adMeta && !previewLocked">/.test(HTML) && /@click="adCopyCode"/.test(HTML) && /@click="adMetaTag\(t\.id\)"/.test(HTML)
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
    ok((HTML.match(/window\.DgAdult\.brand\.renew(Html|Text)\(\)/g) || []).length === 3, '三处续费提示:成人站用 /api/config 的 purchase_url(默认主站 ednovas.me,站长关掉就不提)');
    ok(/class="dg-home-note"/.test(HTML) && /adult.home === 'off'/.test(HTML) && /adult.home === 'empty'/.test(HTML) && /adult.home === 'error'/.test(HTML) && /CACHE_TYPE=sqlite/.test(HTML), '首页目录没起来 / 片库还空 / 拉不到:给一句提示,不留整页空白');
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
    ok(!!AV && +AV >= 4 && SW.includes("'./adult/adult.js?v=" + AV + "'"), 'sw.js 预缓存的 adult.js 与页面引用同一个 ?v=', AV);
    // 真跑 sw.js 的 fetch 处理:哪些请求 SW 接手
    const handlers = {};
    const swCtx = {
        self: { addEventListener: (t, f) => { handlers[t] = f; }, location: { origin: 'https://site.test' }, skipWaiting() { }, clients: { claim() { } }, registration: {} },
        caches: { open: async () => ({ match: async () => null, put: async () => { }, keys: async () => [] }), keys: async () => [], delete: async () => true, match: async () => null },
        fetch: async () => new Response('x'), Response, URL, Promise, console, setTimeout, clearTimeout,
    };
    vm.runInNewContext(SW, swCtx);
    const handled = (url, dest, method, cache) => {
        let took = false;
        const req = { url, destination: dest || '', headers: { has: () => false }, mode: dest === 'document' ? 'navigate' : 'cors', method: method || 'GET', cache: cache || 'default' };
        handlers.fetch({ request: req, respondWith() { took = true; }, waitUntil() { } });
        return took;
    };
    // 封面探测(跨域 HEAD、no-store,no-cors)必须真的走网络:SW 一律直通(否则策略1 的 TMDB 图片缓存会拿缓存 / 占位图冒充「通了」)
    ok(handled('https://image.tmdb.org/t/p/w300/a.jpg', 'image') && !handled('https://image.tmdb.org/t/p/w300/a.jpg', '', 'HEAD', 'no-store') && !handled('https://image.tmdb.org/t/p/w300/a.jpg', '', 'GET', 'no-store')
        && !handled('https://img.other-cdn.test/a.jpg', '', 'HEAD', 'no-store'), 'sw.js:跨域的 HEAD / no-store 请求直通(封面探测不会被缓存 / 占位图冒充)');
    ok(!handled('https://img.other-cdn.test/upload/a.jpg', 'image') && !handled('https://img.other-cdn.test/b.webp'), '跨域海报不进 SW 缓存');
    ok(!handled('https://site.test/api/catalog/home') && !handled('https://site.test/api/catalog/browse?b=x&page=1') && !handled('https://site.test/api/detail?site_key=a&id=1') && !handled('https://site.test/api/search?wd=x'), '目录/详情/搜索接口直达不缓存');
    ok(!handled('https://site.test/api/sites') && !handled('https://site.test/api/check?key=a') && !handled('https://site.test/api/catalog/suggest?q=a') && !handled('https://site.test/api/img?k=c%3AA-1&s=s1', 'image'),
        'phase 2:/api/sites、/api/check、/api/catalog/*(含 suggest/tags/beacon)、/api/img 海报代理都直达不缓存');
    ok(+((/const ADULT_REV = '-adult(\d+)';/.exec(SW) || [])[1] || 0) >= 4, 'sw.js 成人站版本 ≥ -adult4(adult.js 升 ?v= 时一起升,重新预缓存、旧缓存清掉)');
    ok(handled('https://site.test/adult/adult.js?v=' + AV) && handled('https://site.test/api/config') && handled('https://site.test/', 'document'), '外壳(页面/adult.js)和 /api/config 照旧由 SW 接手');
    ok(!handled('https://site.test/api/catalog/tag/busty') && !handled('https://site.test/api/catalog/actress/a1?page=1') && !handled('https://site.test/api/catalog/actress?q=x') && !handled('https://site.test/api/catalog/studios?b=') && !handled('https://site.test/api/catalog/browse?t=a,b&cursor=xyz&facets=1'),
        'phase 3:标签页 / 女优 / 厂牌 / 游标翻页的目录接口同样直达不缓存');
    // p4(-adult5):四个扩展模块按页面同一个 ?v= 预缓存;后台页面 / 后台脚本 / 后台接口一律直达;相关 / 短片流 / 热度接口直达
    const P4MODS = ['player-x', 'privacy', 'preview', 'feed'].map(n => [n, (new RegExp('src="adult/' + n + '\\.js\\?v=(\\d+)"').exec(head) || [])[1] || '']);
    ok(+((/const ADULT_REV = '-adult(\d+)';/.exec(SW) || [])[1] || 0) >= 5 && P4MODS.every(([n, v]) => !!v && SW.includes("'./adult/" + n + ".js?v=" + v + "'")),
        'p4:sw.js ≥ -adult5,预缓存 player-x / privacy / preview / feed(与页面同一个 ?v=)', P4MODS);
    ok(P4MODS.every(([n, v]) => handled('https://site.test/adult/' + n + '.js?v=' + v)), 'p4:四个扩展模块走静态资源策略(SWR)');
    const swStatic = ((/const STATIC_URLS = \[[\s\S]*?\];/.exec(SW) || [''])[0].match(/'\.\/[^']*'/g) || []);
    ok(swStatic.length > 10 && !swStatic.some(u => /admin/.test(u)), 'p4:后台 admin.html / admin.js 不预缓存', swStatic);
    ok(!handled('https://site.test/admin/adult', 'document') && !handled('https://site.test/adult/admin.html', 'document') && !handled('https://site.test/adult/admin.js?v=1')
        && !handled('https://site.test/api/adult/admin/stats') && !handled('https://site.test/api/adult/admin/hidden'),
        'p4:后台页面 / 脚本 / 接口(带 X-Admin-Token)一律直达不缓存');
    ok(!handled('https://site.test/api/catalog/related/' + encodeURIComponent('c:A-1')) && !handled('https://site.test/api/catalog/feed?vert=1&cursor=x') && !handled('https://site.test/api/catalog/heat/' + encodeURIComponent('c:A-1')),
        'p4:相关推荐 / 刷短片 / 热度条接口直达不缓存');
}

console.log('⑧ p4:扩展钩子 / 女优索引 / 相关推荐 / 猜你喜欢 / 刷短片 / 搜索结果窗口化 / 预取');
const P4 = { card: (wk, extra) => Object.assign({ wk, name: '合成 ' + wk, pic: 'https://img.example/' + encodeURIComponent(wk) + '.jpg', sub: '', badge: '', code: '', dur: 120, n_sites: 1, bucket: 'jp_censored' }, extra || {}) };
function fakeVideo() {
    const ls = {};
    return {
        paused: true, ended: false, currentTime: 0, readyState: 0, videoWidth: 0, videoHeight: 0,
        addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); }, removeEventListener(t, f) { ls[t] = (ls[t] || []).filter(x => x !== f); },
        dispatch(t) { (ls[t] || []).slice().forEach(f => f({ type: t })); }, _ls: ls,
    };
}
{
    // ---- 钩子:赋值 = 追加、重复不加、一个抛错不影响别的、否决、链式包装不递归 ----
    const Hk = A.hooks;
    ok(eq(A.HOOK_NAMES, ['onPlayerReady', 'onPlayerDestroy', 'onHistoryWrite', 'onSettingsRender', 'onCardHover']) && A.HOOK_NAMES.every(n => typeof Hk[n] === 'function')
        && typeof Hk.add === 'function' && typeof Hk.remove === 'function' && typeof Hk.count === 'function', '契约 F 的五个钩子 + add/remove/count');
    const calls = [];
    const f1 = (a, b) => { calls.push(['f1', a, b]); };
    const f2 = () => { calls.push(['f2']); throw new Error('合成错误'); };
    Hk.onPlayerDestroy = f1; Hk.onPlayerDestroy = f2; Hk.onPlayerDestroy = f1;
    ok(Hk.count('onPlayerDestroy') === 2, '赋值 = 追加订阅(不顶掉别人的),同一个函数不重复加');
    const cw0 = console.warn; console.warn = () => { };   // 订阅者故意抛错:adult.js 会 console.warn 一行,测试里静音
    const r0 = A.hook('onPlayerDestroy', 'close', 9);
    console.warn = cw0;
    ok(eq(calls, [['f1', 'close', 9], ['f2']]) && r0 === true, '按订阅顺序调;一个订阅者抛错不影响别的、不往外抛', calls);
    ok(A.hook('onSettingsRender', {}) === true && A.hook('nope') === true, '没人订阅 / 不认识的钩子 = 什么都不做');
    const v2 = (it) => (it && it.kind === 'history' ? false : undefined);
    const vTrue = () => true;
    Hk.add('onHistoryWrite', vTrue); Hk.add('onHistoryWrite', v2);
    ok(A.hook('onHistoryWrite', { kind: 'history' }) === false && A.hook('onHistoryWrite', { kind: 'stats' }) === true, 'onHistoryWrite:任一订阅者返回 false = 否决');
    let n = 0;
    const prev = Hk.onCardHover;
    const wrap = function () { prev.apply(null, arguments); n++; };
    Hk.onCardHover = wrap;
    A.hook('onCardHover', { wk: 'c:X-1' }, null);
    ok(n === 1 && Hk.count('onCardHover') === 1, '链式包装(先读旧的再赋新函数)不会无限递归、dispatch 本身不会被当订阅者加进去');
    Hk.remove('onPlayerDestroy', f1); Hk.remove('onPlayerDestroy', f2); Hk.remove('onHistoryWrite', v2); Hk.remove('onHistoryWrite', vTrue); Hk.remove('onCardHover', wrap);
    ok(A.HOOK_NAMES.every(k => Hk.count(k) === 0), '订阅者都能 remove 掉');
}
{
    // ---- 在假 window 里跑 adult.js:boot 装好 window.dgAdultHooks(先放进来的合并、整体赋值合并、x = x || {} 无害)、卡片悬停委托 ----
    const dl = {};
    const mkEl = () => ({ style: {}, classList: { add() { }, remove() { }, toggle() { }, contains: () => false }, setAttribute() { }, appendChild() { }, querySelector: () => null });
    const doc = {
        title: '', cookie: '', head: mkEl(), body: mkEl(), documentElement: mkEl(),
        getElementById: () => null, createElement: () => mkEl(), querySelector: () => null, querySelectorAll: () => [],
        addEventListener(t, f) { (dl[t] = dl[t] || []).push(f); },
    };
    const st = new Map();
    const got = [];
    const pre = (s) => { got.push(['pre', s]); };
    const win = {
        document: doc, localStorage: { getItem: k => (st.has(k) ? st.get(k) : null), setItem: (k, v) => st.set(k, String(v)), removeItem: k => st.delete(k) },
        sessionStorage: { getItem: () => null, setItem() { } }, location: { href: 'https://site.test/', protocol: 'https:', replace() { } }, navigator: {},
        fetch: () => new Promise(() => { }), Headers, Promise, URL, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet, Symbol, Error,
        setTimeout, clearTimeout, console: { log() { }, warn() { }, error() { } }, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isFinite,
        dgAdultHooks: { onSettingsRender: pre },
    };
    win.window = win; win.globalThis = win;
    vm.createContext(win);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/adult/adult.js'), 'utf8'), win, { filename: 'adult.js' });
    const W = win.DgAdult;
    ok(!!W && win.dgAdultHooks === W.hooks, 'boot 之后 window.dgAdultHooks 就是 DgAdult.hooks');
    W.hook('onSettingsRender', 'EL');
    ok(eq(got, [['pre', 'EL']]), '比 adult.js 先放上去的 dgAdultHooks 里的函数被合并进来');
    const late = (c, el, ev) => { got.push(['hover', c && c._wk, el && el.id, ev && ev.type]); };
    win.dgAdultHooks = { onCardHover: late };
    win.dgAdultHooks = win.dgAdultHooks || {};
    ok(win.dgAdultHooks === W.hooks && W.hooks.count('onCardHover') === 1 && W.hooks.count('onSettingsRender') === 1, '之后整个赋值 = 合并;x = x || {} 不会把分发器自己加进去');
    W.cardToItem(P4.card('c:HOV-1'));
    const card = { id: 'card', getAttribute: (k) => (k === 'data-wk' ? 'c:HOV-1' : null), contains: (x) => x === child || x === child2 || x === card };
    const child = { closest: () => card }, child2 = { closest: () => card };
    const fire = (t, ev) => (dl[t] || []).forEach(f => f(ev));
    got.length = 0;
    fire('pointerover', { pointerType: 'mouse', target: child, relatedTarget: null, type: 'pointerover' });
    fire('pointerover', { pointerType: 'mouse', target: child2, relatedTarget: child, type: 'pointerover' });
    fire('pointerover', { pointerType: 'touch', target: child, relatedTarget: null, type: 'pointerover' });
    fire('touchstart', { touches: [{}], target: child, type: 'touchstart' });
    fire('pointerover', { pointerType: 'mouse', target: { closest: () => null }, relatedTarget: null, type: 'pointerover' });
    ok(eq(got, [['hover', 'c:HOV-1', 'card', 'pointerover'], ['hover', 'c:HOV-1', 'card', 'touchstart']]), '卡片悬停委托:鼠标进入卡片一次(卡片内部移动不算)、触屏走 touchstart;card 是 cardToItem 出来的那个对象', got);
}
{
    // ---- adPlayerReady / adPlayerGone / adHistoryOk / 设置钩子 ----
    const app = makeApp({ showDetail: true });
    app.currentGroup = { name: '合成作品', _wk: 'c:REL-1', _meta: { tags: [{ id: 'busty', label: '巨乳', featured: true }, { id: 'noncon', label: '审查', featured: true }, { id: 'x_bad', label: '拦', featured: true }], dur: 600 }, sources: [] };
    app.currentSource = { site_key: 's1', vod_id: 7, _dur: 590 };
    app.episodeList = [{ name: '正片', url: 'https://m.example/x/index.m3u8' }];
    const got = [];
    const fR = (dp, v, ctx) => got.push([dp, v, ctx]);
    A.hooks.add('onPlayerReady', fR);
    const vid = fakeVideo(), dp = { video: vid };
    app.adPlayerReady(dp, 'https://m.example/x/index.m3u8', true);
    const ctx = got[0] && got[0][2];
    ok(got.length === 1 && got[0][0] === dp && got[0][1] === vid && Object.isFrozen(ctx)
        && eq(ctx, { wk: 'c:REL-1', dur: 590, isLive: false, lineKey: 's1|7', siteKey: 's1', vodId: '7', url: 'https://m.example/x/index.m3u8', fresh: true, episodes: 1 }), 'onPlayerReady(dp, video, ctx):ctx = {wk, dur, isLive, lineKey, siteKey, vodId, url, fresh, episodes}', ctx);
    ok(eq(A.wkTags.get('c:REL-1'), ['busty']), '顺带记下这部的 featured 标签(审查类 / blocked 不记)', A.wkTags.get('c:REL-1'));
    ok(app.adult.relWk === '', '首帧之前不拉相关推荐');
    vid.dispatch('playing');
    ok(app.adult.relWk === 'c:REL-1' && !(vid._ls.playing || []).length, '主播放器出了第一帧(playing)才挂相关推荐,监听随即摘掉');
    // 直播不挂、不记
    got.length = 0;
    app.currentGroup = { name: '直播', _wk: 'c:LIVE-1', _isLive: true, sources: [] };
    app.adult.relWk = '';
    app.adPlayerReady({ video: fakeVideo() }, 'u', false);
    ok(got.length === 1 && got[0][2].isLive === true && A.wkTags.get('c:LIVE-1') === null && typeof app._adRelOff !== 'function', '直播:照样通知订阅者(isLive=true),不记标签、不挂相关推荐');
    // 无痕:不记标签
    globalThis.dgPrivacy = { incognito: () => true, locked: () => false, onChange() { } };
    app.currentGroup = { name: '无痕', _wk: 'c:INC-1', _meta: { tags: [{ id: 'legs', label: '美腿', featured: true }] }, sources: [] };
    app.adPlayerReady({ video: fakeVideo() }, 'u', false);
    ok(A.wkTags.get('c:INC-1') === null && A.incognito() === true, '无痕时不记标签');
    if (typeof app._adRelOff === 'function') app._adRelOff();
    delete globalThis.dgPrivacy;
    A.hooks.remove('onPlayerReady', fR);
    // 销毁 / 历史否决
    const gone = [];
    const fG = (r) => gone.push(r);
    A.hooks.add('onPlayerDestroy', fG);
    app.adPlayerGone('close');
    A.hooks.remove('onPlayerDestroy', fG);
    ok(eq(gone, ['close']), 'adPlayerGone(reason) → onPlayerDestroy(reason)');
    const seen = [];
    const veto = (it) => { seen.push(it); return it.kind === 'stats' ? true : false; };
    A.hooks.add('onHistoryWrite', veto);
    app.currentGroup = { name: '合成作品', _wk: 'c:REL-1', sources: [] };
    ok(app.adHistoryOk('history', '合成作品', { episode: null }) === false && app.adHistoryOk('stats', '') === true
        && seen[0].kind === 'history' && seen[0].wk === 'c:REL-1' && seen[0].name === '合成作品', 'adHistoryOk(kind, name, extra):item = {kind, name, wk, ...extra}', seen[0]);
    // 主组件的 addToWatchHistory:被否决就不写
    app.trial = { on: false };
    app.watchHistory = [];
    app._loadTombstones = () => ({}); app._saveTombstones = () => { }; app.saveWatchHistoryToStorage = () => { app._saved = (app._saved || 0) + 1; };
    app.addToWatchHistory('合成作品', '', null, 100, 200, null);
    ok(app.watchHistory.length === 0 && !app._saved, '无痕(onHistoryWrite 否决):addToWatchHistory 什么都不写');
    A.hooks.remove('onHistoryWrite', veto);
    app.addToWatchHistory('合成作品', '', null, 100, 200, null);
    ok(app.watchHistory.length === 1 && app._saved === 1, '没人否决:照常写');
    // 设置弹窗打开 → onSettingsRender(容器)
    const box = { id: 'ext' };
    const sr = [];
    const fS = (el) => sr.push(el);
    A.hooks.add('onSettingsRender', fS);
    app.$refs = { adSetExt: box };
    A.mixin.watch.showSettingsModal.call(app, true);
    A.mixin.watch.showSettingsModal.call(app, false);
    A.hooks.remove('onSettingsRender', fS);
    ok(sr.length === 1 && sr[0] === box, '偏好设置打开 → onSettingsRender(空容器);关的时候不调');
}
{
    // ---- 女优索引(#/actresses)/ 女优页头 / 发行日期排序 ----
    ok(eq(A.parseRoute('#/actresses'), { view: 'actresses', type: 'all', sel: {} }) && A.routeOf('actresses', 'all', { b: 'jp_subbed' }) === '#/actresses' && A.canonHash('#/actresses') === '#/actresses'
        && A.isOurHash('#/actresses') && A.parseRoute('#/actresses/x') === null && A.isOurHash('#/actress/5'), '#/actresses 路由(只有路径,不带参数)');
    ok(!A.isOurHash('#/feed') && A.isFeedHash('#/feed') && !A.isFeedHash('#/feed?x') && A.parseRoute('#/feed') === null && A.FEED_HASH === '#/feed', '#/feed 不归浏览页路由管(不透明,不带任何作品信息)');
    ok(!A.noList('tags') && A.noList('actresses') && !A.noList('tag') && !A.noList(''), 'noList:只有女优索引没有片单');
    ok(A.sortOpts(null, { sort: 'new', actress: '5' }).some(s => s.k === 'released') && !A.sortOpts(null, { sort: 'new' }).some(s => s.k === 'released'), '女优页的排序下拉总有「发行日期」');
    const app = makeApp();
    let opened = null;
    app.openBrowse = (p) => { opened = p; app.browse.open = true; app.browse.type = p.type; app.browse.sel = p.sel; };
    app.adGo({ view: 'actresses' });
    ok(opened && opened.type === 'all' && app.adult.view === 'actresses' && app.adNoList === true && app.adBrowseTitle === '女优' && app.adBrowseSummary === '女优', 'adGo({view:"actresses"}) → 女优索引页(标题「女优」、没有片单)');
    ok(app.adRouteHash === null || app.adRouteHash === '#/actresses', '地址栏写 #/actresses');
    net.calls.length = 0;
    app._browseFill = () => { };
    await app._browseFetch(true);
    ok(app.browse.done === true && !net.calls.length, '女优索引页不拉片单');
    ok(app.adOpenSheet() === false, '女优索引页没有筛选面板');
    app.browse.type = 'jp'; app.browse.sel = A.catalog.normSel('jp', {});
    net.handler = () => null;
    await app._browseFetch(true);
    ok(app.adult.view === '' && app.adNoList === false, '女优索引页上点了别的大类 → 那个大类的普通浏览页');
    // 女优页头:作品数(浏览页总数)+ 最新发行
    const na = A.normActress({ actress: { aid: 12, name: '合成女优丙', aliases: [] }, results: [{ released: '2024-02-01' }, { released: '2025-13-01' }, { released: '2025-06-30' }, {}] });
    ok(na && na.latest === '2025-06-30' && na.aid === '12', 'normActress:latest = 第 1 页里最晚的真实发行日期');
    const Hd = A.components.DgAdHead;
    ok(Hd.props.total && /共 \{\{ countLabel\(total\) \}\} 部/.test(Hd.template) && /最新 \{\{ info\.latest \}\} 发行/.test(Hd.template) && /\$emit\('go', \{ view: 'actresses' \}\)/.test(Hd.template), '女优页头:共 N 部 · 最新 YYYY-MM-DD 发行 · 女优索引入口');
    ok(/\$emit\('go', \{ view: 'actresses' \}\)/.test(A.components.DgAdFilter.template) && /@click="cloud = !cloud">全部标签/.test(A.components.DgAdFilter.template), '筛选行「全部标签」就地展开,里面有「女优索引」入口');
    // 索引组件:全部 + 日本三个分类的 facets.actress
    const urls = A.actIndexUrls();
    ok(eq(urls, ['/api/catalog/browse?sort=new&page=1&facets=1', '/api/catalog/browse?b=jp_censored&sort=new&page=1&facets=1', '/api/catalog/browse?b=jp_uncensored&sort=new&page=1&facets=1', '/api/catalog/browse?b=jp_subbed&sort=new&page=1&facets=1']), '索引用浏览接口的 facets(快照现算)', urls);
    const secs = A.actSections([{ facets: { actress: [{ aid: 1, name: '合成甲', count: 9 }] } }, null, { facets: { actress: [] } }, { facets: { actress: [{ aid: 'a:2', name: '合成乙', count: 3 }] } }]);
    ok(eq(secs.map(s => [s.k, s.label, s.list.map(a => a.aid)]), [['all', '热门女优', ['1']], ['jp_subbed', '中文字幕', ['a:2']]]), 'actSections:空的 / 失败的分类不出', secs);
    const Ad = A.components.DgAdActresses;
    const ai = (function () { const o = Object.assign({}, Ad.data()); for (const [k, fn] of Object.entries(Ad.methods)) o[k] = fn.bind(o); o._ev = []; o.$emit = (nn, a) => o._ev.push([nn, a]); return o; })();
    net.calls.length = 0;
    net.handler = (u) => (u.startsWith('/api/catalog/browse?') ? { body: { results: [], facets: { actress: [{ aid: 77, name: '合成丁', count: 5 }] } } } : u.startsWith('/api/catalog/actress?q=') ? { body: [{ aid: 78, name: '合成戊', n: 2 }] } : null);
    ai.load(true);
    for (let i = 0; i < 10; i++) await tick();
    ok(ai.secs && ai.secs.length === 4 && ai.secs[0].list[0].aid === '77' && ai._ev.some(e => e[0] === 'learn') && net.calls.length === 4, '女优索引:4 个分类各一次(10 分钟缓存)', net.calls);
    ai.pick({ aid: '77' });
    ok(eq(ai._ev[ai._ev.length - 1], ['go', { sel: { actress: '77' }, type: 'all' }]), '点名字 → 女优页');
    ai.q = '合成戊'; ai.search();
    await sleep(300); for (let i = 0; i < 6; i++) await tick();
    ok(eq(ai.res, [{ aid: '78', name: '合成戊', n: 2 }]), '搜索框 → /api/catalog/actress?q=(250ms 防抖)');
    clearTimeout(ai._t);
}
{
    // ---- 相关推荐 ----
    const items = [P4.card('c:R-1'), P4.card('c:SELF-1#U'), P4.card('c:SELF-1'), P4.card('c:R-1')].concat(Array.from({ length: 30 }, (_, i) => P4.card('c:R-X' + i)));
    const rails = A.normRelated({ items, actress: { aid: 12, name: '合成女优乙', items: [P4.card('c:R-2'), P4.card('c:SELF-1~2')] }, studio: { id: 'S1', label: '合成片商', items: [] } }, 'c:SELF-1');
    ok(eq(rails.map(r => r.k), ['rel', 'act']) && rails[0].items.length === 24 && rails[0].items[0]._wk === 'c:R-1' && !rails[0].items.some(x => /SELF-1/.test(x._wk))
        && rails[0].items.filter(x => x._wk === 'c:R-1').length === 1 && Object.isFrozen(rails[0].items[0]), '相关推荐:≤24 张、排内去重、不含这一部和它的 #U/~N 兄弟', rails.map(r => [r.k, r.items.length]));
    ok(rails[1].title === '同演员 · 合成女优乙' && eq(rails[1].go, { sel: { actress: '12' }, type: 'all' }) && rails[1].items.length === 1, '同演员 · 名字(「全部」进女优页);没有卡片的同片商不出');
    const r2 = A.normRelated({ items: [], actress: { aid: '..', name: 'x', items: [P4.card('c:Q-1')] }, studio: { id: 'S"1', label: '', items: [P4.card('c:Q-2')] } }, 'c:Z');
    ok(eq(r2.map(r => [r.k, r.title]), [['st', '同片商 · S1']]) && eq(A.normRelated(null, 'c:Z'), []), 'aid 不合法的同演员不出;厂牌 id 清洗', r2.map(r => r.title));
    const Rd = A.components.DgAdRails;
    ok(/class="dg-rail-card" :data-wk="it\._wk"/.test(Rd.template) && /@click="pick\(it\)"/.test(Rd.template) && /\$emit\('go', r\.go\)/.test(Rd.template), '卡片带 data-wk(悬停预览)、点了换到那一部、「全部」跳转');
    const ri = (function () { const o = Object.assign({ wk: '', poster: null, tv: false }, Rd.data()); for (const [k, fn] of Object.entries(Rd.methods)) o[k] = fn.bind(o); return o; })();
    net.calls.length = 0;
    net.handler = (u) => (u === '/api/catalog/related/' + encodeURIComponent('c:SELF-9') ? { body: { items: [P4.card('c:R-9')], actress: null, studio: null } } : null);
    ri.wk = 'c:SELF-9'; ri.load();
    for (let i = 0; i < 6; i++) await tick();
    ok(net.calls[0] === '/api/catalog/related/c%3ASELF-9' && ri.rails && ri.rails.length === 1 && ri.rails[0].items[0]._wk === 'c:R-9', 'GET /api/catalog/related/:wk(作品键整体编码)', net.calls);
    ri.wk = '..'; ri.load();
    ok(ri.rails === null, '坏作品键不请求');
}
{
    // ---- 猜你喜欢(纯本机)----
    ok(eq(A.forYouTags(['c:A', 'c:B', 'c:C'], { 'c:A': ['busty', 'noncon'], 'c:B': ['busty', 'legs'], 'c:C': ['legs', 'x_minor', 'legs'] }, 3), ['busty', 'legs']), 'forYouTags:越新的权重越大;审查类 / blocked 绝不当种子');
    store.set('dg_wk_tags', JSON.stringify({ v: 1, m: [['c:H-1', ['busty', 'legs'], 1], ['c:H-2', ['busty', 'noncon'], 2]] }));
    ok(eq(A.wkTags.get('c:H-2'), ['busty']), 'wkTags:读出来也只留 featured');
    const app = makeApp();
    app.adult.home = 'ok';
    app.watchHistory = [{ name: 'a', groupData: { _wk: 'c:H-1' } }, { name: 'b', groupData: { _wk: 'c:H-2' } }, { name: 'c', groupData: { _wk: 'c:H-3' } }, { name: 'd' }];
    app.rowConfigs = { ad_new: { title: '新上架' }, ad_hot: { title: '热门' } }; app.rowLists = { ad_new: [1], ad_hot: [2] };
    net.calls.length = 0;
    const fy = (pre, n) => Array.from({ length: n }, (_, i) => P4.card('c:' + pre + i));
    net.handler = (u) => {
        if (u === '/api/catalog/work?k=' + encodeURIComponent('c:H-3')) return { body: { name: 'h3', _wk: 'c:H-3', _meta: { tags: [{ id: 'legs', label: '美腿', featured: true }] }, sources: [] } };
        // 复核 r3:推荐位带 nr=1(服务器去掉审查级作品)
        if (u === '/api/catalog/browse?t=busty,legs&sort=hot&page=1&nr=1') return { body: { results: [P4.card('c:H-1')].concat(fy('FA', 6)) } };
        if (u === '/api/catalog/browse?t=busty&sort=hot&page=1&nr=1') return { body: { results: fy('FA', 3).concat(fy('FB', 10)) } };
        return null;
    };
    await app.adultLoadForYou(true);
    const L = app.rowLists.ad_foryou || [];
    ok(eq(Object.keys(app.rowConfigs), ['ad_new', 'ad_foryou', 'ad_hot']) && app.rowConfigs.ad_foryou.title === '猜你喜欢' && app.rowConfigs.ad_foryou.adult === true && app.rowConfigs.ad_foryou.more === null,
        '猜你喜欢插在第一行目录行之后(没有「全部」)', Object.keys(app.rowConfigs));
    ok(L.length === 16 && !L.some(x => /^c:H-/.test(x._wk)) && new Set(L.map(x => x._wk)).size === L.length && L.every(Object.isFrozen), '排除看过的、去重、冻结', L.length);
    ok(net.calls.filter(u => u.startsWith('/api/catalog/work?')).length === 1 && eq(A.wkTags.get('c:H-3'), ['legs']), '没记过标签的(以前看的)补拉作品信息,记下来;记过的不再拉', net.calls);
    ok(net.calls.filter(u => u.startsWith('/api/catalog/browse?')).length === 2, '够 16 张就不再拉下一组');
    ok(net.calls.filter(u => u.startsWith('/api/catalog/browse?')).every(u => /&nr=1$/.test(u)), '猜你喜欢的浏览请求都带 nr=1(审查级作品永不推荐)', net.calls);
    ok(A.browseApiUrl ? !/nr=/.test(A.browseApiUrl({ t: ['busty'] }, { page: 1 })) : true, '普通浏览不带 nr(审查级照样可筛)');
    net.calls.length = 0;
    await app.adultLoadForYou(false);
    ok(!net.calls.length, '历史没变(签名相同)→ 不重算');
    // 不足 8 张 → 整行不出
    store.set('dg_wk_tags', JSON.stringify({ v: 1, m: [['c:H-9', ['oral'], 1]] }));
    app.watchHistory = [{ name: 'z', groupData: { _wk: 'c:H-9' } }];
    net.handler = (u) => (u.startsWith('/api/catalog/browse?t=oral') ? { body: { results: fy('FC', 5) } } : null);
    await app.adultLoadForYou(false);
    ok(!app.rowConfigs.ad_foryou && !app.rowLists.ad_foryou && eq(Object.keys(app.rowConfigs), ['ad_new', 'ad_hot']), '不足 8 张:整行收起');
    // 无痕 → 不出、不请求
    globalThis.dgPrivacy = { incognito: () => true };
    app.watchHistory = [{ name: 'a', groupData: { _wk: 'c:H-1' } }];
    net.calls.length = 0;
    await app.adultLoadForYou(true);
    ok(!app.rowConfigs.ad_foryou && !net.calls.length, '无痕:猜你喜欢不出、一个请求都不发');
    delete globalThis.dgPrivacy;
    clearTimeout(app._adFyT);
    ok(Object.keys(A.mixin.watch).includes('watchHistory') && Object.keys(A.mixin.watch).includes('showSettingsModal'), '历史整份换了 / 设置打开 都有侦听');
}
{
    // ---- 预取(dgAdultPlayer.prefetched)/ 去广告地址 / 网络 / 主播放器忙 / 方向上报 ----
    const raw = { name: '预取作品', _wk: 'c:PF-1', sources: [{ site_key: 's1', site_name: '站一', vod_id: 1, vod_name: 'x' }] };
    globalThis.dgAdultPlayer = { prefetched: (wk) => (wk === 'c:PF-1' ? Promise.resolve(raw) : null) };
    net.calls.length = 0;
    net.handler = (u) => (u.startsWith('/api/catalog/work?k=') ? { body: { name: '网络作品', _wk: 'c:PF-2', sources: [{ site_key: 's2', vod_id: 2, vod_name: 'y' }] } } : null);
    const g1 = await A.fetchWork('c:PF-1', false);
    ok(g1 && g1.name === '预取作品' && !net.calls.length, '不扩线的作品请求先用 dgAdultPlayer.prefetched(wk)');
    const g2 = await A.fetchWork('c:PF-2', false);
    ok(g2 && g2.name === '网络作品' && net.calls.length === 1, '没预取的照常请求');
    net.calls.length = 0;
    await A.fetchWork('c:PF-1', true);
    ok(net.calls.length === 1 && /expand=1/.test(net.calls[0]), '扩线(expand)不用预取');
    globalThis.dgAdultPlayer = { prefetched: () => ({ bogus: 1 }) };
    net.calls.length = 0;
    await A.fetchWorkRaw('c:PF-2');
    globalThis.dgAdultPlayer = { prefetched: () => Promise.resolve({ _wk: 'c:OTHER', sources: [] }) };
    await A.fetchWorkRaw('c:PF-2');
    globalThis.dgAdultPlayer = { prefetched: () => { throw new Error('x'); } };
    await A.fetchWorkRaw('c:PF-2');
    ok(net.calls.length === 3, '预取的形状不对 / 不是这一部 / 抛错 → 照常请求', net.calls);
    delete globalThis.dgAdultPlayer;
    const u = 'https://m.example/v/index.m3u8';
    ok(A.wrapPlayUrl(u, { filterOn: true, proxy: 'https://w.example/' }) === 'https://w.example/?url=' + encodeURIComponent(u)
        && A.wrapPlayUrl(u, { filterOn: false, proxy: 'https://w.example' }) === u && A.wrapPlayUrl(u, { filterOn: true, proxy: '' }) === u
        && A.wrapPlayUrl(u, { filterOn: true, proxy: 'https://w.example', bad: true }) === u && A.wrapPlayUrl('https://m.example/v.mp4', { filterOn: true, proxy: 'https://w.example' }) === 'https://m.example/v.mp4',
    '去广告地址变换与播放页同规则(开着去广告 + 配了 Worker + .m3u8 + 本站没被记过不了代理)');
    globalThis.AdFilter = { isEnabled: () => true };
    A._bridge.app = { corsProxyUrl: 'https://w.example', _adProxyBad: (k) => k === 'bad', showDetail: false, isTVMode: false };
    ok(A.playUrl(u, 's1') === 'https://w.example/?url=' + encodeURIComponent(u) && A.playUrl(u, 'bad') === u && A.proxyUrl() === 'https://w.example', 'playUrl 用主组件的 corsProxyUrl / _adProxyBad');
    delete globalThis.AdFilter;
    ok(A.netBlock({ saveData: true }) === 'save-data' && A.netBlock({ effectiveType: '3g' }) === 'slow' && A.netBlock({ effectiveType: 'slow-2g' }) === 'slow' && A.netBlock({ type: 'cellular' }, false) === 'cellular'
        && A.netBlock({ type: 'cellular', effectiveType: '4g' }, true) === '' && A.netBlock(null) === '' && A.netBlock({ type: 'wifi', effectiveType: '4g' }) === '', 'netBlock:省流量 / 2G·3G / 蜂窝(没允许)');
    globalThis.document = { querySelector: (s) => (s === '#dplayer video' ? { paused: false, ended: false } : null) };
    const busy1 = A.mainBusy();
    A._bridge.app.showDetail = true;
    const busy2 = A.mainBusy();
    globalThis.document = { querySelector: () => ({ paused: true, ended: false }) };
    const busy3 = A.mainBusy();
    globalThis.adCut = { busy: () => true };
    const busy4 = A.mainBusy();
    delete globalThis.adCut; delete globalThis.document;
    ok(!busy1 && busy2 && !busy3 && busy4, '主播放器在放(播放页开着且没暂停)/ 剪插播在跑 → 忙', [busy1, busy2, busy3, busy4]);
    A._bridge.app = null;
    const bp = A.beacon.payload({ wk: 'c:A-1', site_key: 's', vod_id: 1, ok: true, w: 720, h: 1280, orient: 'v' });
    ok(bp && bp.orient === 'v' && bp.w === 720 && A.beacon.keyOf(bp).startsWith('or|') && !('orient' in A.beacon.payload({ wk: 'c:A-1', site_key: 's', vod_id: 1, ok: true, orient: 'up' })) && A.beacon.keyOf(A.beacon.payload({ wk: 'c:A-1', site_key: 's', vod_id: 1, ok: true })).startsWith('ok|'),
        'beacon 带 orient(v/h/sq),方向上报与起播上报各记一次');
}
{
    // ---- 搜索结果窗口化 ----
    const app = makeApp({ searched: true });
    app.rawList = [
        { _wk: 'c:S-1', _wt: '合成搜到', vod_name: '一', vod_pic: 'https://p.example/1.jpg', site_key: 's1', vod_id: 1, vod_play_url: '正片$https://a.example/1/index.m3u8' },
        { _wk: 'c:S-1', _wt: '合成搜到', vod_name: '二', vod_pic: '', site_key: 's2', vod_id: 2, vod_play_url: '正片$https://b.example/2/index.m3u8' },
        { vod_name: '没有作品键', vod_pic: '', site_key: 's3', vod_id: 4 },
    ];
    const items0 = app.adSearchItems;
    const s1 = items0.find(i => i._wk === 'c:S-1'), s0 = items0.find(i => !i._wk);
    const items = [s1];
    ok(items0.length === 2 && s1 && s1._n === 2 && s1.title === '合成搜到' && Object.isFrozen(s1) && s1._g.sources.length === 2 && s0 && s0.title === '没有作品键', '搜索结果 → 窗口化网格的卡片(_g = 原分组)', items0.map(i => [i.title, i._n]));
    let od = null;
    app.openDetail = (g) => { od = g; };
    app.adSearchPick(items[0]);
    ok(od === items[0]._g && typeof A.mixin.methods.adSearchImgErr === 'undefined', '点卡片 = openDetail(分组);坏图交给封面控制器(换同组别的线路的海报 / 藏),原来的回退方法删掉了');
    const Gd = A.components.DgAdGrid;
    ok(Gd.props.keep && /@error="\$emit\('imgerr', item\)"/.test(Gd.template) && /:data-wk="item\._wk \|\| null"/.test(Gd.template), '网格:keep / imgerr / data-wk');
    const gi = { dead: { 0: 100 }, keep: true, _resets: 0 };
    gi.reset = () => { gi._resets++; gi.dead = {}; };
    Gd.watch.items.call(gi, [1, 2, 3], [1, 2]);
    ok(gi._resets === 0 && gi.dead[0] === 100, 'keep:片单流式变长 / 重排不重新分块');
    Gd.watch.items.call(gi, [], [1, 2]);
    ok(gi._resets === 1, 'keep:清空了才重来');
    gi.keep = false;
    Gd.watch.items.call(gi, [1, 2, 3], [1, 2]);
    ok(gi._resets === 2, '不 keep(浏览页换筛选):整个新数组就重来');
}
{
    // ---- 刷短片:adult.js 的路由 / 收起 / 恢复(假 dgAdultFeed)----
    const nav = fakeNav('');
    const L0 = globalThis.location, H0 = globalThis.history;
    globalThis.location = nav.loc; globalThis.history = nav.hist;
    const F = {
        o: false, s: false, opened: 0, closed: 0, resumed: 0, opts: null,
        open(opts) { this.o = true; this.s = false; this.opts = opts; this.opened++; return true; }, close() { this.o = false; this.s = false; this.closed++; },
        suspend() { this.s = true; }, resume() { this.s = false; this.resumed++; },
        isOpen() { return this.o && !this.s; }, suspended() { return this.o && this.s; },
    };
    globalThis.dgAdultFeed = F;
    const app = makeApp();
    app.adult.routeOn = true;
    let ow = null;
    app.openWork = (c) => { ow = c; app.showDetail = true; };
    app.closeDetail = () => { app.closed++; app.showDetail = false; };
    ok(app.adFeedOn === true, '有目录、不是电视、feed.js 在 → 出刷短片入口');
    app.adOpenFeed();
    ok(nav.loc.hash === '#/feed' && app._adFeedPushed === true, '入口 → 地址栏 #/feed(压一条历史,返回键关)');
    nav.hist.pushState(null, '', '#/feed');
    app._adOnHash();
    ok(F.opened === 1 && F.isOpen() && typeof F.opts.onClose === 'function' && typeof F.opts.onPick === 'function', 'hashchange 到 #/feed → dgAdultFeed.open({onClose, onPick})');
    F.opts.onPick({ _wk: 'c:FD-1', title: 'x' });
    ok(F.suspended() && ow && ow._wk === 'c:FD-1', '点片名:刷短片收起,开正常播放页');
    nav.hist.back();
    app._adOnHash();
    ok(app.closed === 1 && nav.loc.hash === '#/feed' && F.suspended(), '播放页上按返回:关播放页、把 #/feed 压回去', nav.ops);
    app._adAfterDetail();
    clearTimeout(app._adFyT);
    ok(F.isOpen() && F.resumed === 1, '播放页关了 → 回到刷短片原位');
    F.opts.onClose();
    ok(nav.loc.hash === '' && nav.ops[nav.ops.length - 1] === 'back', '刷短片的返回:退掉自己压的那条历史', nav.ops);
    app._adOnHash();
    ok(F.closed === 1 && !F.isOpen(), '离开 #/feed → close()');
    // 返回键 / goHome
    nav.hist.pushState(null, '', '#/feed'); app._adFeedPushed = true; app._adOnHash();
    ok(F.isOpen() && app.adFeedBack() === true, 'adFeedBack:刷短片开着 → 关(goHome / 安卓返回键)');
    app._adOnHash();
    ok(!F.isOpen() && app.adFeedBack() === false, '关了之后 adFeedBack 不接手');
    // 书签 / 刷新直接停在 #/feed(没有自己压的历史:关的时候换掉地址)
    const app2 = makeApp();
    globalThis.location.hash = '#/feed'; nav.hist.replaceState(null, '', '#/feed');
    app2._adRouteBoot();
    ok(F.isOpen() && app2._adFeedPushed === false, '启动时地址栏是 #/feed → 直接开刷短片');
    F.opts.onClose();
    ok(!F.isOpen() && nav.loc.hash === '' && /^replace \/$/.test(nav.ops[nav.ops.length - 1]), '没有自己压的历史:关掉并把地址换回首页', nav.ops.slice(-2));
    // 电视:不出入口,#/feed 直接换掉
    const app3 = makeApp({ isTVMode: true });
    app3.adult.routeOn = true;
    nav.hist.pushState(null, '', '#/feed');
    const n0 = F.opened;
    app3._adOnHash();
    ok(app3.adFeedOn === false && F.opened === n0 && nav.loc.hash === '', '电视:没有刷短片(入口不出,#/feed 换掉)');
    // 修订:播放页开着(不是从刷短片开的)时地址变成 #/feed(前进键 / 书签 / 手改)→ 先关播放页再开刷短片(不能两个一起放)
    const app4 = makeApp();
    app4.adult.routeOn = true;
    app4.showDetail = true; app4.closed = 0;
    app4.closeDetail = () => { app4.closed++; app4.showDetail = false; };
    nav.hist.pushState(null, '', '#/feed');
    const n4 = F.opened;
    app4._adOnHash();
    ok(app4.closed === 1 && !app4.showDetail && F.opened === n4 + 1 && F.isOpen(), '播放页开着时到 #/feed:先关播放页(主播放器停),再开刷短片', [app4.closed, F.opened - n4]);
    F.close();
    // 关不掉(截帧分享弹窗开着:closeDetail 只关弹窗)→ 这次不开,地址换回去
    const app5 = makeApp();
    app5.adult.routeOn = true;
    app5.showDetail = true; app5.closed = 0;
    app5.closeDetail = () => { app5.closed++; };
    nav.hist.pushState(null, '', '#/feed');
    const n5 = F.opened;
    app5._adOnHash();
    ok(app5.closed === 1 && app5.showDetail && F.opened === n5 && !F.isOpen() && nav.loc.hash === '', '播放页关不掉 → 不开刷短片,#/feed 换掉', [F.opened - n5, nav.loc.hash]);
    delete globalThis.dgAdultFeed;
    ok(makeApp().adFeedOn === false, 'feed.js 没加载 → 没有入口');
    globalThis.location = L0; globalThis.history = H0;
}
{
    // ---- 刷短片模块(feed.js)纯函数 ----
    const FD = require(path.join(ROOT, 'public/adult/feed.js'));
    ok(FD.feedUrl('', false) === '/api/catalog/feed' && FD.feedUrl('abc+/=', true) === '/api/catalog/feed?cursor=abc%2B%2F%3D&vert=1', 'feedUrl(契约:/api/catalog/feed?cursor=&vert=1)');
    ok(FD.feedUrl('', true, true) === '/api/catalog/feed?start=rand&vert=1' && FD.feedUrl('c1', false, true) === '/api/catalog/feed?cursor=c1', 'feedUrl:没游标时随机起点(start=rand);有游标照游标走');
    // 正片窗口:片头 18 秒贴片 + 117 秒正片 + 尾部 17 秒贴片 → 只放正片;单块 / 正片不够长 / 贴片太长 → 不限制
    const fr = (cc, start, duration) => ({ cc, start, duration });
    const cw = FD.contentWindow([fr(0, 0, 9), fr(0, 9, 8.6), fr(1, 17.6, 60), fr(1, 77.6, 57), fr(2, 134.6, 17.6)]);
    ok(cw && Math.abs(cw.start - 17.6) < 1e-6 && Math.abs(cw.end - 134.6) < 1e-6 && FD.contentWindow([fr(0, 0, 10), fr(0, 10, 10)]) === null
        && FD.contentWindow([fr(0, 0, 50), fr(1, 50, 50)]) === null && FD.contentWindow([fr(0, 0, 90), fr(1, 90, 300)]) === null && FD.contentWindow(null) === null,
        '刷短片:正片窗口跳过 Worker 没剪掉的片头 / 片尾贴片(只在最长那块里放)', cw);
    ok(FD.tapZone(0.1) === -1 && FD.tapZone(0.5) === 0 && FD.tapZone(0.9) === 1, '刷短片:双击左 40% 后退、右 40% 前进、中间不算');
    ok(FD.orientOf(720, 1280) === 'v' && FD.orientOf(1920, 1080) === 'h' && FD.orientOf(1000, 1100) === 'sq' && FD.orientOf(0, 10) === '', 'orientOf:高/宽 ≥1.15 竖、宽/高 ≥1.15 横,其余方');
    {   // 修订:和服务器 lib/site-catalog/common.js orientOf 同一个阈值(1.15 ~ 1.25 之间两边以前判得不一样)
        const KC = require(path.join(ROOT, 'lib/site-catalog/common.js'));
        const sizes = [[1000, 1160], [1160, 1000], [1000, 1200], [1200, 1000], [1000, 1140], [1140, 1000], [720, 1280], [1280, 720], [1080, 1080], [1000, 1150], [1150, 1000]];
        ok(sizes.every(([w, hh]) => FD.orientOf(w, hh) === KC.orientOf(w, hh)), 'orientOf:前端和服务器在 1.15 ~ 1.25 之间也判得一样', sizes.map(([w, hh]) => w + 'x' + hh + ':' + FD.orientOf(w, hh) + '/' + KC.orientOf(w, hh)));
    }
    const fi = (wk, extra) => Object.assign({ wk, name: '合成短片', pic: 'https://img.example/a.jpg', code: '', badge: '', dur: 60, orient: 'v', lines: [{ site: 's1', url: 'https://m.example/' + wk.slice(2) + '/index.m3u8', dur: 60, vod_id: 5 }] }, extra || {});
    const it = FD.normItem(fi('t:F1'), A.cardToItem);
    ok(it && it.wk === 't:F1' && it.card._wk === 't:F1' && it.lines.length === 1 && it.lines[0].vod_id === '5' && it.orient === 'v' && !('tags' in it), 'normItem:卡片同形、线路带 vod_id、不带任何标签');
    ok(FD.normItem(fi('t:F2', { dur: 7 })) === null && FD.normItem(fi('t:F3', { dur: 301 })) === null && FD.normItem(fi('t:F4', { dur: 0 })) !== null, '时长已知时只要 8–300 秒');
    ok(FD.normItem(fi('t:F5', { lines: [{ site: 's1', url: 'javascript:alert(1)' }, { site: '', url: 'https://m.example/a.m3u8' }, { site: 's', url: 'https://m.example/a.mp4' }] })) === null
        && FD.normItem(fi('bad')) === null && FD.normItem(null) === null, '线路只要 http(s) .m3u8 + 站点;作品键不合法的丢掉');
    const seen = new Set(['t:F1']);
    const pg = FD.normFeed({ items: [fi('t:F1'), fi('t:F6'), fi('t:F6'), fi('t:F7', { orient: 'h' }), fi('t:F8', { orient: '' })], cursor_next: 'next' }, A.cardToItem, seen, true);
    ok(eq(pg.items.map(x => x.wk), ['t:F6', 't:F8']) && pg.next === 'next' && pg.done === false && seen.has('t:F6'), 'normFeed:跨页去重;只看竖屏时横屏的丢掉(方向未知的留着)');
    ok(FD.normFeed({ items: [], cursor_next: null }).done === true && FD.normFeed(null).items.length === 0, '没有下一页 = 到底');
    ok(FD.netMode(null, false, 0) === 'auto' && FD.netMode({ saveData: true }, true, 0) === 'tap' && FD.netMode({ effectiveType: '3g' }, true, 0) === 'tap' && FD.netMode({ type: 'cellular' }, false, 0) === 'tap'
        && FD.netMode({ type: 'cellular', effectiveType: '4g' }, true, 0) === 'auto' && FD.netMode(null, false, FD.SESSION_CAP) === 'tap' && FD.SESSION_CAP === 300 * 1048576, 'netMode:省流量 / 慢网 / 蜂窝没允许 / 本会话 300MB 用完 → 点一下才播');
    const hc = FD.hlsConfig();
    ok(hc.autoStartLoad === false && hc.maxBufferLength === 10, 'hls.js:autoStartLoad false(清单到了才 startLoad)、maxBufferLength 10');
    ok(FD.fitOf(1920, 1080, 390, 844) === 'contain' && FD.fitOf(720, 1280, 390, 844) === 'cover' && FD.fitOf(720, 1280, 1440, 900) === 'contain', '横屏片 contain;竖屏片在竖屏上接近比例才铺满');
    const SRCF = fs.readFileSync(path.join(ROOT, 'public/adult/feed.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    ok(!/\?\.[a-zA-Z_$[(]/.test(SRCF) && !/[^?]\?\?[^?]/.test(SRCF.replace(/'[^'\n]*'/g, "''")) && !/catch\s*\{/.test(SRCF) && !/innerHTML/.test(SRCF), 'feed.js 不用 ?. / ?? / 可选 catch 绑定,不用 innerHTML(片名一律 textContent)');
}
{
    // ---- 刷短片模块:假 DOM 里跑一遍(复核:只有 1 个在放、不预拉下一条的清单;≥60% 可见才建、窗口外清空、300MB 后点一下才播、方向上报、收起 / 恢复 / 关)----
    const ids = new Set();
    function El(tag) {
        const e = {
            tagName: String(tag).toUpperCase(), attrs: {}, children: [], parentNode: null, style: {}, hidden: false, _ls: {}, _text: '', _cls: new Set(),
            get className() { return [...e._cls].join(' '); }, set className(v) { e._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
            classList: { add: (...c) => c.forEach(x => e._cls.add(x)), remove: (...c) => c.forEach(x => e._cls.delete(x)), contains: (c) => e._cls.has(c), toggle: (c, on) => { if (on === undefined ? !e._cls.has(c) : on) e._cls.add(c); else e._cls.delete(c); } },
            setAttribute(k, v) { e.attrs[k] = String(v); if (k === 'id') ids.add(String(v)); }, getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; }, removeAttribute(k) { delete e.attrs[k]; },
            get firstChild() { return e.children[0] || null; },
            appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = e; e.children.push(c); return c; },
            insertBefore(c, ref) { if (!ref) return e.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); const i = e.children.indexOf(ref); c.parentNode = e; e.children.splice(i < 0 ? e.children.length : i, 0, c); return c; },
            removeChild(c) { e.children = e.children.filter(x => x !== c); c.parentNode = null; return c; },
            set textContent(v) { e.children = []; e._text = String(v); }, get textContent() { return e._text + e.children.map(c => c.textContent).join(''); },
            matches(sel) { return sel.split(',').some(s => { s = s.trim(); return s[0] === '.' ? s.slice(1).split('.').every(c => e._cls.has(c)) : e.tagName === s.toUpperCase(); }); },
            closest(sel) { let n = e; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; },
            querySelectorAll(sel) { const out = []; const walk = (n) => n.children.forEach(c => { if (c.matches && c.matches(sel)) out.push(c); walk(c); }); walk(e); return out; },
            querySelector(sel) { return e.querySelectorAll(sel)[0] || null; },
            addEventListener(t, f) { (e._ls[t] = e._ls[t] || []).push(f); }, removeEventListener(t, f) { e._ls[t] = (e._ls[t] || []).filter(x => x !== f); },
            dispatch(t, ev) { (e._ls[t] || []).slice().forEach(f => f(Object.assign({ type: t, target: e }, ev || {}))); },
            focus() { }, scrollTo() { }, clientHeight: 800, scrollTop: 0,
        };
        if (e.tagName === 'VIDEO') Object.assign(e, { paused: true, muted: false, videoWidth: 0, videoHeight: 0, _plays: 0, play() { e.paused = false; e._plays++; return Promise.resolve(); }, pause() { e.paused = true; }, load() { }, canPlayType: () => '' });
        return e;
    }
    const docL = {};
    const doc = {
        hidden: false, body: El('body'), head: El('head'), documentElement: El('html'),
        createElement: (t) => El(t), createTextNode: (t) => { const n = El('#text'); n.textContent = t; return n; },
        getElementById: (id) => (ids.has(id) ? {} : null),
        addEventListener(t, f) { (docL[t] = docL[t] || []).push(f); }, removeEventListener(t, f) { docL[t] = (docL[t] || []).filter(x => x !== f); },
    };
    const hls = [];
    class FakeHls {
        static isSupported() { return true; }
        constructor(cfg) { this.cfg = cfg; this.h = {}; this.starts = 0; this.destroyed = false; hls.push(this); }
        on(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); } emit(ev, d) { (this.h[ev] || []).forEach(f => f(ev, d)); }
        loadSource(u) { this.src = u; } attachMedia(v) { this.media = v; } startLoad() { this.starts++; } destroy() { this.destroyed = true; }
    }
    FakeHls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', FRAG_LOADED: 'hlsFragLoaded', ERROR: 'hlsError' };
    const fItem = (i, extra) => Object.assign({ wk: 't:FS' + i, name: '合成短片 ' + i, pic: '', code: 'SYN-' + i, dur: 60, orient: '', lines: [{ site: 's1', url: 'https://m.example/fs' + i + '/index.m3u8', dur: 60, vod_id: i + 100 }] }, extra || {});
    const fetched = [];
    const beacons = [];
    const picks = [];
    let closes = 0;
    let incog = false;
    let privLocked = false;
    const privSubs = [];
    const win = {
        document: doc, Hls: FakeHls, navigator: {}, innerWidth: 390, innerHeight: 844,
        localStorage: { getItem: () => null, setItem() { } },
        dgPrivacy: { locked: () => privLocked, incognito: () => false, onChange: (f) => { privSubs.push(f); return () => { }; } },
        fetch: async (u) => {
            fetched.push(u);
            if (u === '/api/catalog/feed' || u === '/api/catalog/feed?start=rand') return new Response(JSON.stringify({ items: [0, 1, 2, 3, 4, 5].map(i => fItem(i)), cursor_next: 'c2' }), { status: 200 });
            if (u === '/api/catalog/feed?cursor=c2') return new Response(JSON.stringify({ items: [6, 7, 8].map(i => fItem(i)), cursor_next: null }), { status: 200 });
            return new Response('{}', { status: 404 });
        },
        DgAdult: {
            cardToItem: A.cardToItem, playUrl: (url) => 'W:' + url, isTV: () => false, cellOk: () => false, incognito: () => incog,
            beacon: { send: (o) => { beacons.push(o); return true; } }, fetchWorkRaw: async () => null,
        },
        IntersectionObserver: function (cb, opt) { this.cb = cb; this.opt = opt; this.observe = () => { }; this.disconnect = () => { }; },
        AbortController, Response, setTimeout, clearTimeout, console, Promise, JSON, Math, Date, Map, Set, Object, Array, String, Number, RegExp, Error, encodeURIComponent,
    };
    win.window = win;
    const ctx = vm.createContext(win);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/adult/feed.js'), 'utf8'), ctx, { filename: 'feed.js' });
    const FDw = win.dgAdultFeed;
    const S = FDw._S;
    ok(FDw.open({ onClose: () => { closes++; }, onPick: (c) => picks.push(c) }) === true && FDw.isOpen(), 'open()');
    for (let i = 0; i < 10; i++) await tick();
    ok(eq(fetched, ['/api/catalog/feed?start=rand']) && S.items.length === 6 && S.slides.length === 6 && S.cur === 0, '第一页 → 6 条空壳,当前第 0 条', fetched);
    ok(hls.length === 1 && hls[0].src === 'W:https://m.example/fs0/index.m3u8' && hls.every(x => x.cfg.autoStartLoad === false && x.cfg.maxBufferLength === 10), '只有 1 个在放(不预拉下一条的清单);地址走去广告变换', hls.map(x => x.src));
    hls[0].emit('hlsManifestParsed');
    ok(hls[0].starts === 1 && hls[0].media.muted === true && hls[0].media._plays >= 1, '在放的清单到了才 startLoad、静音自动播');
    const slide = (i) => S.slides[i];
    FDw._onIO([{ target: slide(1), isIntersecting: true, intersectionRatio: 0.4 }]);
    ok(S.cur === 0 && hls.length === 1, '只露出 40% 不算翻过去(下一条的清单也不拉)');
    FDw._onIO([{ target: slide(1), isIntersecting: true, intersectionRatio: 0.7 }, { target: slide(0), isIntersecting: true, intersectionRatio: 0.3 }]);
    for (let i = 0; i < 4; i++) await tick();
    const live = hls.filter(x => !x.destroyed);
    ok(S.cur === 1 && hls[0].destroyed && hls.length === 2 && live.length === 1 && live[0] === hls[1] && hls[1].src === 'W:https://m.example/fs1/index.m3u8' && hls[1].starts === 0,
        '≥60% 可见 → 才给它建实例、拉清单;上一条销毁(始终只有 1 个实例,不预拉第 2 条)', hls.map(x => [x.src.slice(-16), x.destroyed, x.starts]));
    hls[1].emit('hlsManifestParsed');
    ok(hls[1].starts === 1, '翻到的这条:清单到了才 startLoad');
    // 方向:量到 720x1280 → 报一次(线路带 vod_id)
    const v1 = hls[1].media;
    v1.videoWidth = 720; v1.videoHeight = 1280; v1.paused = false;
    v1.dispatch('playing');
    ok(beacons.length === 1 && eq(beacons[0], { wk: 't:FS1', site_key: 's1', vod_id: '101', ok: true, w: 720, h: 1280, orient: 'v' }) && slide(1).classList.contains('dg-fs-on') && slide(1).classList.contains('dg-fit-cover'), '第一帧:淡入、竖屏铺满、按 beacon 报方向(每部一次)', beacons);
    v1.dispatch('playing');
    ok(beacons.length === 1, '同一部不重复报');
    // 点画面:静音 → 开声音
    FDw._click({ target: v1 });
    await new Promise(r => setTimeout(r, 320));   // 单击要等 280ms 看是不是双击
    ok(S.muted === false && v1.muted === false, '点画面:开声音(等双击判定)');
    // 片名 → onPick(卡片)
    FDw._click({ target: slide(1).querySelector('.dg-fs-title') });
    ok(picks.length === 1 && picks[0]._wk === 't:FS1' && picks[0].title === '合成短片 1', '点片名 → onPick(卡片对象)');
    ok(slide(1).querySelector('.dg-fs-title').textContent === '合成短片 1', '片名用 textContent');
    // 流量:本会话 300MB 后改「点一下才播」
    hls[1].emit('hlsFragLoaded', { frag: { stats: { loaded: 301 * 1048576 } } });
    FDw._onIO([{ target: slide(2), isIntersecting: true, intersectionRatio: 0.9 }, { target: slide(1), isIntersecting: false, intersectionRatio: 0 }]);
    for (let i = 0; i < 10; i++) await tick();
    ok(S.cur === 2 && FDw.status().mode === 'tap' && !slide(2).querySelector('.dg-fs-tap').hidden && !hls.some(x => x.src.indexOf('fs2/') > 0) && !hls.some(x => x.src.indexOf('fs3/') > 0), '300MB 用完:不自动播,出「点一下播放」(这条的清单也不拉)');
    ok(eq(fetched.slice(0, 2), ['/api/catalog/feed?start=rand', '/api/catalog/feed?cursor=c2']) && S.items.length === 9, '离末尾还剩 4 条就按游标拉下一页(每次打开从随机起点开始)', fetched);
    FDw._click({ target: slide(2).querySelector('.dg-fs-tap') });
    const pre2 = hls.find(x => x.src.indexOf('fs2/') > 0);
    if (pre2) pre2.emit('hlsManifestParsed');
    ok(pre2 && pre2.starts === 1 && slide(2).querySelector('.dg-fs-tap').hidden, '点了才建、才播');
    // 窗口:翻到第 7 条,远处的条目清空(先把流量计数归零 → 回到自动播)
    S.bytes = 0;
    FDw._onIO([{ target: slide(7), isIntersecting: true, intersectionRatio: 1 }, { target: slide(2), isIntersecting: false, intersectionRatio: 0 }]);
    ok(S.cur === 7 && slide(0).children.length === 0 && slide(4).children.length === 0 && slide(5).children.length > 0 && slide(8).children.length > 0 && hls.filter(x => !x.destroyed).length === 1 && !hls.some(x => !x.destroyed && x.src.indexOf('fs8/') > 0), '当前 ±2/3 条以外的只留空壳;只有 1 个实例(第 7 条在放,第 8 条不预拉)');
    // 无痕:不报方向
    incog = true;
    const live7 = hls.filter(x => !x.destroyed && x.src.indexOf('fs7/') > 0)[0];
    if (live7) { live7.media.videoWidth = 1920; live7.media.videoHeight = 1080; live7.media.paused = false; live7.media.dispatch('playing'); }
    ok(!!live7 && beacons.length === 1 && S.slides[7].classList.contains('dg-fs-h'), '无痕:不上报(横屏片照样按 contain 放)');
    incog = false;
    // 收起 / 恢复 / 关
    FDw.suspend();
    ok(FDw.suspended() && !FDw.isOpen() && hls.every(x => x.destroyed) && S.el.style.display === 'none', '收起:实例全销毁、隐藏(位置和条目留着)');
    S.bytes = 0;
    FDw.resume();
    ok(FDw.isOpen() && S.el.style.display === '' && S.cur === 7 && hls.filter(x => !x.destroyed).length === 1, '恢复:回到原来那条接着放');
    // 修订:隐私锁 —— 锁上 → 实例全销毁(锁屏后面不接着下清单 / 分片);锁着翻页不建实例;解锁不自动续播(点一下才建);head 预锁类也算锁着
    privLocked = true; privSubs.forEach(f => f());
    ok(FDw.isOpen() && hls.every(x => x.destroyed), '锁上:实例全销毁');
    const nLock = hls.length;
    FDw._onIO([{ target: slide(8), isIntersecting: true, intersectionRatio: 1 }, { target: slide(7), isIntersecting: false, intersectionRatio: 0 }]);
    for (let i = 0; i < 4; i++) await tick();
    ok(S.cur === 8 && hls.length === nLock, '锁着翻页:一个实例都不建(不拉清单 / 分片,也不预备下一条)', hls.length - nLock);
    privLocked = false; privSubs.forEach(f => f());
    ok(hls.length === nLock && !slide(8).querySelector('.dg-fs-tap').hidden, '解锁:不自动续播,当前这条出「点一下播放」');
    doc.documentElement.classList.add('dgp-prelock');
    FDw._click({ target: slide(8).querySelector('.dg-fs-tap') });
    ok(hls.length === nLock, 'head 预锁类(dgp-prelock)还在 = 当锁着:点了也不建');
    doc.documentElement.classList.remove('dgp-prelock');
    FDw._click({ target: slide(8).querySelector('.dg-fs-tap') });
    ok(hls.length === nLock + 1 && hls[nLock].src === 'W:https://m.example/fs8/index.m3u8', '解锁后点一下才建实例', hls.length - nLock);
    (docL.keydown || []).forEach(f => f({ key: 'Escape', preventDefault() { }, stopPropagation() { } }));
    ok(closes === 1 && !FDw.isOpen() && !FDw.suspended() && hls.every(x => x.destroyed) && !doc.body.children.length, 'Esc / 返回:交给 onClose,自己也关干净');
    win.DgAdult.isTV = () => true;
    ok(FDw.open({}) === false && !FDw.isOpen(), '电视上不开');
}
// ---- 刷短片修订(p4 复审 F1–F4)用的假环境:iPhone(没有 MSE → 原生 HLS)/ iPad(触屏)/ 电脑;play() 可以被拦;可以有登录框 ----
async function feedWorld(o) {
    o = o || {};
    const env = { cell: !!o.cell, play: o.play || 'ok' };
    const byId = Object.create(null);
    function El(tag) {
        const e = {
            tagName: String(tag).toUpperCase(), attrs: {}, children: [], parentNode: null, style: {}, hidden: false, _ls: {}, _text: '', _cls: new Set(),
            get className() { return [...e._cls].join(' '); }, set className(v) { e._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
            classList: { add: (...c) => c.forEach(x => e._cls.add(x)), remove: (...c) => c.forEach(x => e._cls.delete(x)), contains: (c) => e._cls.has(c), toggle: (c, on) => { if (on === undefined ? !e._cls.has(c) : on) e._cls.add(c); else e._cls.delete(c); } },
            setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return k in e.attrs ? e.attrs[k] : null; }, removeAttribute(k) { delete e.attrs[k]; },
            get firstChild() { return e.children[0] || null; },
            appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = e; e.children.push(c); return c; },
            insertBefore(c, ref) { if (!ref) return e.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); const i = e.children.indexOf(ref); c.parentNode = e; e.children.splice(i < 0 ? e.children.length : i, 0, c); return c; },
            removeChild(c) { e.children = e.children.filter(x => x !== c); c.parentNode = null; return c; },
            set textContent(v) { e.children = []; e._text = String(v); }, get textContent() { return e._text + e.children.map(c => c.textContent).join(''); },
            matches(sel) { return sel.split(',').some(s => { s = s.trim(); return s[0] === '.' ? s.slice(1).split('.').every(c => e._cls.has(c)) : e.tagName === s.toUpperCase(); }); },
            closest(sel) { let n = e; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; },
            querySelectorAll(sel) { const out = []; const walk = (n) => n.children.forEach(c => { if (c.matches && c.matches(sel)) out.push(c); walk(c); }); walk(e); return out; },
            querySelector(sel) { return e.querySelectorAll(sel)[0] || null; },
            addEventListener(t, f) { (e._ls[t] = e._ls[t] || []).push(f); }, removeEventListener(t, f) { e._ls[t] = (e._ls[t] || []).filter(x => x !== f); },
            dispatch(t, ev) { (e._ls[t] || []).slice().forEach(f => f(Object.assign({ type: t, target: e }, ev || {}))); },
            focus() { }, scrollTo() { }, clientHeight: 800, scrollTop: 0,
        };
        if (e.tagName === 'VIDEO') {
            Object.assign(e, {
                paused: true, muted: false, currentTime: 0, videoWidth: 0, videoHeight: 0, _plays: 0, _loads: 0, _buf: [],
                play() {
                    e._plays++;
                    if (env.play === 'reject' || (env.play === 'reject-unmuted' && !e.muted)) { const err = new Error('合成:自动播放被拦'); err.name = 'NotAllowedError'; return Promise.reject(err); }
                    e.paused = false; return Promise.resolve();
                },
                pause() { e.paused = true; }, load() { e._loads++; if (!e.attrs.src) { e._buf = []; e.currentTime = 0; } },
                canPlayType: () => (o.native ? 'maybe' : ''),
            });
            Object.defineProperty(e, 'src', { get() { return e.attrs.src || ''; }, set(v) { e.attrs.src = String(v); }, configurable: true });
            Object.defineProperty(e, 'buffered', { get() { const b = e._buf; return { length: b.length, start: (k) => b[k][0], end: (k) => b[k][1] }; }, configurable: true });
        }
        return e;
    }
    const docL = {};
    const doc = {
        hidden: false, activeElement: null, body: El('body'), head: El('head'), documentElement: El('html'),
        createElement: (t) => El(t), createTextNode: (t) => { const n = El('#text'); n.textContent = t; return n; },
        getElementById: (id) => byId[id] || null,
        addEventListener(t, f) { (docL[t] = docL[t] || []).push(f); }, removeEventListener(t, f) { docL[t] = (docL[t] || []).filter(x => x !== f); },
    };
    const hls = [];
    class FakeHls {
        static isSupported() { return !o.native; }
        constructor(cfg) { this.cfg = cfg; this.h = {}; this.starts = 0; this.stops = 0; this.startAt = []; this.destroyed = false; hls.push(this); }
        on(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); } emit(ev, d) { if (!this.destroyed) (this.h[ev] || []).forEach(f => f(ev, d)); }
        loadSource(u) { this.src = u; } attachMedia(v) { this.media = v; } startLoad(p) { this.starts++; this.startAt.push(p); } stopLoad() { this.stops++; } destroy() { this.destroyed = true; }
    }
    FakeHls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', FRAG_LOADED: 'hlsFragLoaded', ERROR: 'hlsError' };
    const nl = o.lines || 1;
    const lineUrl = (i, k) => 'https://m.example/fw' + i + 'abcd'[k] + '/index.m3u8';
    const fItem = (i) => ({ wk: 't:FW' + i, name: '合成短片 ' + i, pic: '', code: 'SYN-' + i, dur: 60, orient: '', lines: Array.from({ length: nl }, (_, k) => ({ site: 's' + k, url: lineUrl(i, k), dur: 60, vod_id: i * 10 + k })) });
    const nav = {};
    if (o.conn) nav.connection = o.conn;
    const win = {
        document: doc, Hls: FakeHls, navigator: nav, innerWidth: 390, innerHeight: 844,
        matchMedia: (q) => ({ matches: !!o.coarse && /coarse/.test(q) }),
        localStorage: { getItem: () => null, setItem() { } },
        fetch: async (u) => ((u === '/api/catalog/feed' || u === '/api/catalog/feed?start=rand') ? new Response(JSON.stringify({ items: [0, 1, 2, 3, 4, 5].map(fItem), cursor_next: null }), { status: 200 }) : new Response('{}', { status: 404 })),
        DgAdult: { cardToItem: A.cardToItem, playUrl: (u) => u, isTV: () => false, cellOk: () => env.cell, incognito: () => false, beacon: { send: () => true }, fetchWorkRaw: async () => null },
        IntersectionObserver: function () { this.observe = () => { }; this.disconnect = () => { }; },
        AbortController, Response, setTimeout, clearTimeout, console, Promise, JSON, Math, Date, Map, Set, Object, Array, String, Number, RegExp, Error, encodeURIComponent,
    };
    win.window = win;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/adult/feed.js'), 'utf8'), vm.createContext(win), { filename: 'feed.js' });
    const FDw = win.dgAdultFeed, S = FDw._S;
    const ticks = async (n) => { for (let i = 0; i < (n || 10); i++) await tick(); };
    const W = {
        env, doc, win, hls, FDw, S, byId, El, lineUrl, ticks,
        slide: (i) => S.slides[i], video: (i) => S.slides[i].querySelector('.dg-fs-v'), tap: (i) => S.slides[i].querySelector('.dg-fs-tap'), msg: (i) => S.slides[i].querySelector('.dg-fs-msg'),
        fire: (t, ev) => (docL[t] || []).slice().forEach(f => f(ev)),
        // 翻到第 i 条(IntersectionObserver:这条全露出、别的都看不见)
        go: async (i) => { FDw._onIO(S.slides.map((sl, k) => ({ target: sl, isIntersecting: k === i, intersectionRatio: k === i ? 1 : 0 }))); await ticks(); },
        // 新建的 hls 实例都给一次「清单到了」
        parsed: () => hls.forEach(x => { if (!x.destroyed && !x._p) { x._p = true; x.emit('hlsManifestParsed'); } }),
    };
    FDw.open({ onClose() { }, onPick() { } });
    await ticks();
    return W;
}
{
    // ---- F1:手机 / 触屏上网络未知 = 点一下才播;原生 HLS(iPhone)也记流量,300MB 封顶生效 ----
    const FD = require(path.join(ROOT, 'public/adult/feed.js'));
    ok(FD.netMode(null, false, 0) === 'auto' && FD.netMode(null, false, 0, true) === 'tap' && FD.netMode(null, true, 0, true) === 'auto'
        && FD.netWhy(null, false, 0, true) === 'unknown' && FD.netWhy({ type: 'wifi' }, false, 0, true) === '' && FD.netWhy({ type: 'cellular' }, false, 0, true) === 'cellular' && FD.netWhy(null, true, FD.SESSION_CAP, true) === 'cap',
        'F1 netMode:手机 / 触屏上没有 navigator.connection = 网络未知 → 点一下才播(开了「移动网络也自动播放」才自动);电脑上没有照旧自动播');
    ok(FD.nativeBytes(80, 30) === 80 * FD.NATIVE_BPS / 8 && FD.nativeBytes(10, 200) === 200 * FD.NATIVE_BPS / 8 && FD.nativeBytes(0, 0) === 0 && FD.NATIVE_BPS >= 1.8e6, 'F1 原生 HLS 流量估算 = max(缓冲过的秒数, 播过的秒数) × 码率(≥ 各家族实测中位数)');
    const P = await feedWorld({ native: true });   // iPhone:没有 MSE、没有 navigator.connection、设置没开
    const pv0 = P.video(0);
    ok(P.FDw.status().mode === 'tap' && P.FDw.status().why === 'unknown' && !P.tap(0).hidden && !P.tap(0).querySelector('.dg-fs-hint').hidden && !pv0.getAttribute('src') && pv0._plays === 0,
        'F1 iPhone 上(网络类型未知、没开「移动网络也自动播放」):第一条就是「点一下播放」+ 设置提示,什么都不下', P.FDw.status());
    P.FDw._click({ target: P.tap(0) });
    ok(pv0.getAttribute('src') === P.lineUrl(0, 0) && pv0._plays === 1 && P.tap(0).hidden, '点了才设 src、才播');
    const I = await feedWorld({ coarse: true });   // iPad:hls.js 能用,但触屏、没有 navigator.connection
    ok(I.FDw.status().mode === 'tap' && I.hls.length === 0 && !I.tap(0).hidden, 'F1 iPad(触屏、没有 navigator.connection):同样点一下才播,清单都不拉', I.hls.length);
    const Iw = await feedWorld({ coarse: true, conn: { type: 'wifi' } });
    const Dk = await feedWorld({});
    ok(Iw.FDw.status().mode === 'auto' && Iw.hls.length === 1 && Dk.FDw.status().mode === 'auto' && Dk.hls.length === 1, '报了 wifi 的触屏设备、电脑(不报网络类型)照常滑到就播');
    const N = await feedWorld({ native: true, cell: true });   // iPhone,开了「移动网络也自动播放」
    const nv0 = N.video(0);
    ok(N.FDw.status().mode === 'auto' && nv0.getAttribute('src') === N.lineUrl(0, 0) && nv0._plays === 1, '开了「移动网络也自动播放」:iPhone 上滑到就播(原生 HLS)');
    nv0._buf = [[0, 30]]; nv0.dispatch('progress');
    ok(N.S.bytes === 30 * FD.NATIVE_BPS / 8, 'F1 原生 HLS:缓冲了 30 秒 → 按 30 秒 × 码率记进本会话流量', N.S.bytes);
    for (let s = 0; s < 1500 * 4; s++) { nv0.currentTime = (s / 4) % 60; nv0.dispatch('timeupdate'); }   // 60 秒的片循环放 25 分钟
    ok(N.S.bytes >= FD.SESSION_CAP, '循环放 25 分钟 → 估算过了 300MB(回到开头那一跳不算)', +(N.S.bytes / 1048576).toFixed(1));
    await N.go(1);
    ok(N.FDw.status().mode === 'tap' && N.FDw.status().why === 'cap' && !N.tap(1).hidden && !N.video(1).getAttribute('src'), 'F1 iPhone 上 300MB 封顶也生效:下一条改成点一下才播', N.FDw.status());
}
{
    // ---- F2:每个 <video> 只绑一次监听;原生 HLS 一次 error 只换一条线路;往回翻时留着的下一条不再缓冲 ----
    const W = await feedWorld({ native: true, cell: true, lines: 2 });
    const v0 = W.video(0);
    await W.go(1); await W.go(0);
    ok(['error', 'playing', 'loadedmetadata', 'timeupdate'].every(t => (v0._ls[t] || []).length === 1), 'F2 翻走再翻回来(实例重建):同一个 <video> 上每种监听只有一个', Object.keys(v0._ls).map(t => t + ':' + v0._ls[t].length));
    ok(v0.getAttribute('src') === W.lineUrl(0, 0), '翻回来:第一条线路重新设上');
    v0.dispatch('error');
    ok(v0.getAttribute('src') === W.lineUrl(0, 1) && W.S.inst[0] && W.S.inst[0].li === 1 && W.msg(0).hidden && !W.slide(0).classList.contains('dg-fs-err'),
        'F2 原生 HLS 一次 error 只换一条线路(第二条好线路留着,不出「暂时放不了」)', { src: v0.getAttribute('src'), li: W.S.inst[0] && W.S.inst[0].li, msg: W.msg(0).textContent });
    const H = await feedWorld({});
    H.parsed();
    await H.go(1); H.parsed();
    const h1 = H.hls.find(x => x.src === H.lineUrl(1, 0));
    ok(h1 && h1.starts === 1 && !h1.destroyed, '翻到第 2 条:清单到了才 startLoad');
    H.video(1).currentTime = 7.5;
    await H.go(0); H.parsed();
    ok(!h1.destroyed && h1.stops === 1 && H.video(1).paused, 'F2 往回翻:留着的下一条暂停并 stopLoad(不再接着缓冲),实例和已有缓冲留着', { stops: h1.stops, destroyed: h1.destroyed });
    await H.go(1);
    ok(h1.starts === 2 && h1.startAt[1] === 7.5 && !h1.destroyed && !H.video(1).paused, '再翻回去:同一个实例从停的位置续上加载、接着播', h1.startAt);
    for (let k = 0; k < 10; k++) { await H.go(k % 2); H.parsed(); }
    const loading = H.hls.filter(x => !x.destroyed && x.starts > x.stops);
    ok([0, 1].every(i => ['error', 'playing', 'loadedmetadata'].every(t => (H.video(i)._ls[t] || []).length === 1)) && loading.length === 1 && H.hls.filter(x => !x.destroyed).length <= 2,
        '来回翻 10 次(hls.js):监听不叠加;同时只有 1 个实例在加载', { loading: loading.length, live: H.hls.filter(x => !x.destroyed).length, playing: H.video(0)._ls.playing.length });
}
{
    // ---- F3:静音自动播也被浏览器拦 → 出「点一下播放」、停止下载,点了再播 ----
    const W = await feedWorld({ play: 'reject' });
    const h0 = W.hls[0];
    ok(!W.tap(0).hidden && W.S.inst[0] && W.S.inst[0].want === false, 'F3 静音自动播也被拦(低电量模式 / 不允许自动播放):出「点一下播放」(不再一直转圈)');
    W.parsed();
    ok(h0.starts === 0, 'F3 被拦着时清单到了也不 startLoad(不白下缓冲)');
    W.env.play = 'ok';
    W.FDw._click({ target: W.video(0) });   // 出着按钮时点画面也算点了播放
    ok(h0.starts === 1 && W.tap(0).hidden && !W.video(0).paused, '点一下:开始加载、播');
    // 已经在加载时被拦(切回前台续播被拒)→ stopLoad
    const L = await feedWorld({});
    L.parsed();
    const l0 = L.hls[0];
    L.env.play = 'reject';
    L.video(0).paused = true;
    L.doc.hidden = true; L.fire('visibilitychange'); L.doc.hidden = false; L.fire('visibilitychange');
    await L.ticks();
    ok(l0.starts === 1 && l0.stops === 1 && !L.tap(0).hidden, 'F3 已在加载的这条续播被拒:stopLoad + 出「点一下播放」', { starts: l0.starts, stops: l0.stops });
    // 带声音被拦 → 静音重试也被拦
    const U = await feedWorld({});
    U.parsed();
    U.FDw._click({ target: U.video(0) });   // 点画面:开声音
    await new Promise(r => setTimeout(r, 320));   // 单击要等 280ms 看是不是双击
    U.env.play = 'reject';
    await U.go(1);
    ok(U.S.muted === true && !U.tap(1).hidden && U.video(1)._plays === 2, 'F3 带声音被拦 → 退回静音重试也被拦:出「点一下播放」', { muted: U.S.muted, plays: U.video(1)._plays });
    // 原生 HLS:撤掉 src(不再下载),点了再设回去
    const Nn = await feedWorld({ native: true, cell: true, play: 'reject' });
    ok(!Nn.video(0).getAttribute('src') && !Nn.tap(0).hidden, 'F3 原生 HLS 被拦:撤掉 src(不再下载)+ 出「点一下播放」');
    Nn.env.play = 'ok';
    Nn.FDw._click({ target: Nn.tap(0) });
    ok(Nn.video(0).getAttribute('src') === Nn.lineUrl(0, 0) && !Nn.video(0).paused && Nn.tap(0).hidden, '点了:重新设 src、播');
}
{
    // ---- F4:键盘只认刷短片自己的(登录框的输入框 / 勾选框上的空格 / 登录框亮着时的 Esc 不吃)----
    const W = await feedWorld({});
    W.parsed();
    const pw = W.El('div'); pw.setAttribute('id', 'password-screen'); pw.style.display = 'flex';
    W.doc.body.appendChild(pw); W.byId['password-screen'] = pw;
    const inp = W.El('input'); inp.setAttribute('type', 'password'); pw.appendChild(inp);
    const key = (k, target) => { const ev = { key: k, target, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }; W.fire('keydown', ev); return ev; };
    const typed = ['j', 'k', ' ', 'ArrowDown', 'ArrowUp', 'PageUp', 'Escape'].map(k => key(k, inp));
    ok(typed.every(e => !e.defaultPrevented && !e.stopped) && W.FDw.isOpen() && !W.video(0).paused, 'F4 登录框(盖在刷短片上)的密码框里:j / k / 空格 / 方向键 / Esc 都照常,刷短片不翻、不停、不关', typed.map(e => e.key + ':' + e.defaultPrevented));
    const esc = key('Escape', W.doc.body);
    ok(!esc.defaultPrevented && W.FDw.isOpen(), 'F4 登录框亮着时(焦点不在输入框)Esc 也不关底下的刷短片');
    pw.style.display = 'none';
    const sp = key(' ', W.S.vertBox), jj = key('j', W.S.vertBox);
    ok(!sp.defaultPrevented && !W.video(0).paused && jj.defaultPrevented, 'F4 「只看竖屏」勾选框上:空格照旧勾选(不当暂停),j 照样翻页');
    const sp2 = key(' ', W.S.list);
    ok(sp2.defaultPrevented && W.video(0).paused, '焦点在列表上:空格暂停');
    const ek = key('Escape', W.S.list);
    ok(ek.defaultPrevented && !W.FDw.isOpen(), '登录框收起后:Esc 关刷短片');
}
{
    // ---- index.html 接线(p4)----
    const head = HTML.slice(0, HTML.indexOf('</head>'));
    const iSeek = head.indexOf('libs/js/seek-preview.js');
    const tags = ['adult/player-x.js?v=4', 'adult/privacy.js?v=3', 'adult/preview.js?v=5', 'adult/feed.js?v=7'].map(s => head.indexOf('<script data-cfasync="false" src="' + s + '" defer></script>'));
    // 修订:head 里的隐私预锁片段(设过 PIN 才加 dgp-prelock;privacy.js 10 秒没起来就撤掉),要在任何 body 内容之前
    const iPre = head.indexOf('dgp-prelock body > *:not(.dgp-layer)'), iPreJs = head.indexOf("localStorage.getItem('dgp_pin')");
    ok(iPre > 0 && iPreJs > iPre && iPreJs < head.indexOf('adult/adult.js?v=') && /if \(!window\.dgPrivacy\) d\.classList\.remove\('dgp-prelock'\); \}, 10000\)/.test(head), 'head:隐私预锁(CSS + 设过 PIN 才加类 + 10 秒兜底撤掉),在 adult.js 之前', [iPre, iPreJs]);
    ok(tags.every(i => i > iSeek) && tags.every((x, i) => i === 0 || x > tags[i - 1]) && head.indexOf('libs/js/hls.min.js') < tags[0], '四个扩展模块 <script defer>(hls.min.js 之后,顺序 player-x / privacy / preview / feed)', tags);
    ok(/if \(isFreshPlayer\) dp\.play\(\);\s*\n\s*\/\/ \[adult\] p4[^\n]*\n\s*if \(this\.adultMode && typeof this\.adPlayerReady === 'function'\) \{ try \{ this\.adPlayerReady\(dp, url, isFreshPlayer\); \} catch \(e\) \{ \} \}/.test(HTML), 'play():播放器拿到线路之后 → adPlayerReady(onPlayerReady)');
    const gone = (HTML.match(/if \(this\.adultMode( && this\.showDetail)?\) \{ try \{ this\.adPlayerGone\('(close|home|switch|rebuild|offline)'\); \} catch \(e\) \{ \} \}/g) || []).map(x => /'(\w+)'/.exec(x)[1]);
    ok(eq(gone.slice().sort(), ['close', 'home', 'offline', 'rebuild', 'switch']), 'onPlayerDestroy:关播放页 / 回首页 / 换剧销毁 / 重建 / 离线上下文', gone);
    ok(/if \(this\.adultMode\) \{ try \{ this\.adPlayerGone\('rebuild'\); \} catch \(e\) \{ \} \}[^\n]*\n\s*try \{ dp\.destroy\(\); \} catch \(e\) \{ \}/.test(HTML), '销毁之前调(不是之后)');
    ok(/if \(this\.trial\.on\) return;\s*\n[^\n]*\n\s*if \(this\.adultMode && typeof this\.adHistoryOk === 'function' && !this\.adHistoryOk\('history', name, \{ episode: episode \|\| null \}\)\) return;/.test(HTML)
        && /if \(this\.adultMode && typeof this\.adHistoryOk === 'function' && !this\.adHistoryOk\('progress', movieName, \{ episode: episodeName \}\)\) return;\s*\n\s*\n\s*try \{\s*\n\s*const data = \{\s*\n\s*time: Math\.floor\(currentTime\)/.test(HTML)
        && /window\.DgAdult\.hook\('onHistoryWrite', \{ kind: 'stats', name: '', wk: '' \}\) === false\) return 'private';/.test(HTML), 'onHistoryWrite:观看历史 / 进度 / 观看统计 三条写入路径都能被否决');
    ok(/<div v-if="adultMode" ref="adSetExt" class="dg-set-ext"><\/div>/.test(HTML) && /@change="adSetPv\(\$event\.target\.checked\)"/.test(HTML) && /@change="adSetCell\(\$event\.target\.checked\)"/.test(HTML), '设置:onSettingsRender 容器 + 悬停预览 / 移动网络自动播放 开关');
    ok((HTML.match(/class="hot-card" v-for="item in (rowLists\[key\]|getPagedItems\(key\))" :key="[^"]+" :data-wk="item\._wk \|\| null"/g) || []).length === 2, '首页行(横排 + 展开网格)的卡片带 data-wk(onCardHover)');
    ok(/<button v-if="adultMode && adFeedOn" type="button" class="dg-nav-feed" @click="adOpenFeed\(\)"/.test(HTML) && !/catnav-q is-feed/.test(HTML), '刷短片入口:只在导航栏(首页分类栏里那个重复的已删)');
    ok(/if \(this\.adultMode && !this\.showDetail && typeof this\.adFeedBack === 'function' && this\.adFeedBack\(\)\) return;/.test(HTML) && /window\.dgAdultFeed\.isOpen\(\)\)\) : Reflect\.get\(t, k\)\)/.test(HTML), '返回键:刷短片开着先关它(goHome / 安卓 App 的 searched 探测)');
    ok(/<dg-ad-rails v-if="adultMode && adult\.relWk && !previewLocked" :wk="adult\.relWk" :poster="getPosterUrl" :tv="isTVMode" @pick="adRelPick" @go="adGo"><\/dg-ad-rails>/.test(HTML), '播放页:相关推荐(首帧之后才有 relWk)');
    ok(/<dg-ad-actresses v-if="adultMode && adult\.view === 'actresses'" @go="adGo" @learn="adLearned"><\/dg-ad-actresses>/.test(HTML), '浏览页:女优索引');
    // 封面加载不出来就藏(2026-11-22):搜索网格也 :cover(坏封面网格自己换同组别的线路的海报,不再走 handleImgError)
    ok(/<dg-ad-grid v-if="adultMode && groupedList\.length > 0" :keep="true" :cover="true" :items="adSearchItems" :tv="isTVMode" @pick="adSearchPick"><\/dg-ad-grid>/.test(HTML)
        && /<div class="result-grid" v-if="groupedList\.length > 0 && !adultMode">/.test(HTML), '搜索结果:成人站走窗口化网格(:cover),主站照旧');
    // 封面加载不出来就藏:首页行(横排 + 展开网格)的封面走 v-dg-cv + adCvSrc;搜索联想出不来换图标;网格 / 相关推荐组件里也登记;继续观看 / 收藏不登记
    ok((HTML.match(/<img v-dg-cv="item" :src="item\._wk && adultMode \? adCvSrc\(item\) : getPosterUrl\(item\.poster_path\)"/g) || []).length === 2, '首页行两处封面:<img v-dg-cv="item" :src="adCvSrc(item)">');
    // 复核 r2:搜索联想里封面加载不出来的作品整行不出(adSugRows 按 covers.visible 筛;方向键选中的那行按键跟着走),不再换图标留着
    ok(/<img v-dg-cv="r\.it" :src="adCvSrc\(r\.it\)"[^>]*>/.test(HTML) && !/dg-sug-noimg/.test(HTML) && /covers\.visible\(it\)\) rows\.push\(\{ t: 'item'/.test(A.mixin.computed.adSugRows.toString()),
        '搜索联想:封面出不来的作品整行不出(不再换成图标留着)');
    const histTpl = HTML.slice(HTML.indexOf('<div class="history-card" v-for="(item, index) in watchHistory"'), HTML.indexOf('<div class="history-card" v-for="(item, index) in watchHistory"') + 3000);
    ok(histTpl.length > 100 && !/v-dg-cv/.test(histTpl) && !/v-dg-cv/.test(HTML.slice(HTML.indexOf('v-for="item in favSorted"'), HTML.indexOf('v-for="item in favSorted"') + 1500)), '继续观看 / 收藏的封面不登记(从来不藏)');
    ok(/<img v-dg-cv="cover \? item : null" :src="cover \? cvSrc\(item\) : src\(item\.poster_path\)"/.test(A.components.DgAdGrid.template) && /<img v-dg-cv="it" :src="cvSrc\(it\)"/.test(A.components.DgAdRails.template)
        && A.components.DgAdGrid.directives.dgCv === A.cvDirective && A.components.DgAdRails.directives.dgCv === A.cvDirective && A.mixin.directives.dgCv === A.cvDirective, '网格 / 相关推荐 / 根组件都注册了 v-dg-cv');
    ok(/已隐藏 \{\{ hiddenN \}\} 部封面加载不出来的作品 · <button type="button" class="dg-cv-show" @click="showAll\(\)">显示<\/button>/.test(A.components.DgAdGrid.template), '网格底下「已隐藏 N 部封面加载不出来的作品 · 显示」');
    const called = ['adPlayerReady', 'adPlayerGone', 'adHistoryOk', 'adSetPv', 'adSetCell', 'adOpenFeed', 'adFeedBack', 'adRelPick', 'adSearchPick', 'adCvSrc'];
    ok(called.every(nm => typeof A.mixin.methods[nm] === 'function'), 'index.html 调的 p4 mixin 方法都在', called.filter(nm => typeof A.mixin.methods[nm] !== 'function'));
    ok(['adNoList', 'adFeedOn', 'adSearchItems'].every(nm => typeof A.mixin.computed[nm] === 'function'), 'p4 computed 都在');
}
console.log(`\n${fail ? '✗' : '✓'} adult-frontend-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
