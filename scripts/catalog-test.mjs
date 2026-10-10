#!/usr/bin/env node
// 分类浏览(首页分类栏 / 分类浏览页 / 搜「泰剧」直达)回归(离线、零网络):
//   node scripts/catalog-test.mjs
//  ① public/index.html 里 <dg-catalog-core> 那段纯函数:分类定义自洽、TMDB /discover 参数拼装(地区/题材/形式换接口/
//     年份/排序/票数门槛/华语默认/成人过滤)、哪些条目显示、搜索框分类词识别(带前后缀、年份;真片名不误判)、榜单「全部」映射
//  ② 模板 / 方法接线:搜索框走 submitSearch、旧的 19 个图标分类已删、TV 返回键与安卓 App 返回键都会退一层
//  ③ 在沙箱里真跑 Vue 方法:进出浏览页的滚动/焦点还原、搜索结果 → 浏览页 → 首页、分页去重/过滤/过期请求丢弃、
//     MainActivity 注入的返回键脚本原样跑一遍(装好的 App 改不了,只能靠 window.vueApp 的 searched)
// 改 index.html 里分类栏、浏览页、搜索提交、goHome、返回键任何一处后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const coreM = /\/\/ <dg-catalog-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-catalog-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-catalog-core> 段'); process.exit(1); }
const C = vm.runInNewContext(coreM[1] + '\n;DgCatalog;', { Math, String, Array, Object, Number, Date, RegExp, JSON, parseInt });
const NOW = new Date(2026, 9, 9, 12, 0, 0);
const Q = (t, sel, o) => C.buildQuery(t, sel, 1, Object.assign({ now: NOW }, o)).params;
const P = (t, sel, o) => C.buildQuery(t, sel, 1, Object.assign({ now: NOW }, o)).path;

console.log('① 纯函数');
{
    // 分类定义自洽:键不重复、默认选项、nav 引用的组/选项都存在
    const tk = C.TYPES.map(t => t.k);
    ok(eq(tk, ['movie', 'tv', 'anime', 'variety', 'doc']), '五个大类:电影 / 剧集 / 动漫 / 综艺 / 纪录片', tk);
    for (const T of C.TYPES) {
        const gk = T.groups.map(g => g.k);
        ok(new Set(gk).size === gk.length && !gk.includes('year') && !gk.includes('sort'), T.l + ':筛选组键不重复、不占用 year/sort', gk);
        for (const g of T.groups) {
            const ks = g.opts.map(x => x.k);
            ok(new Set(ks).size === ks.length, T.l + '/' + g.l + ':选项键不重复', ks);
            ok(g.all === false ? ks[0] === '' : !ks.includes(''), T.l + '/' + g.l + ':没有「全部」的组第一个选项是默认(键为空),其余组不许有空键');
            for (const x of g.opts) ok(x.k === '' || x.q || x.m || x.media, T.l + '/' + g.l + '/' + x.l + ':选项带了查询参数或换接口');
        }
        for (const n of T.nav) {
            if (n.g) ok(gk.includes(n.g), T.l + ' 首页分类栏引用的组存在:' + n.g);
            for (const [l, sel] of (n.items || [])) ok(eq(C.normSel(T.k, sel), C.normSel(T.k, Object.assign(C.normSel(T.k, {}), sel))) && Object.keys(sel).every(k => C.normSel(T.k, sel)[k] === sel[k]), T.l + ' 首页快捷标签「' + l + '」的 sel 都是有效值', sel);
        }
    }
    // 泰剧 / 韩剧 / 港剧 … 这些用户点名要的分类都在
    const tvRegions = C.groupsOf('tv', {}, NOW)[0].opts.map(x => x.l);
    ok(['国产', '港剧', '台剧', '韩剧', '日剧', '泰剧', '美剧', '英剧'].every(l => tvRegions.includes(l)), '剧集地区有国产/港剧/台剧/韩剧/日剧/泰剧/美剧/英剧', tvRegions);
    ok(!tvRegions.includes('日韩'), '「日韩」只给首页那一行的「全部」用,平时不出现在筛选里');
    ok(C.groupsOf('tv', { region: 'krjp' }, NOW)[0].opts.some(x => x.k === 'krjp'), '…被选中时出现(否则筛选行里没有高亮项)');
    // 原来首页的 19 个分类在新分类里都找得到
    const labels = (t) => C.TYPES.find(x => x.k === t).groups.flatMap(g => g.opts.map(o => o.l));
    ok(['动作', '喜剧', '爱情', '科幻', '奇幻', '悬疑', '恐怖', '犯罪', '战争', '历史', '家庭'].every(l => labels('movie').includes(l)), '旧分类栏的电影题材(科幻/动作/喜剧/犯罪/爱情/家庭/战争/恐怖/悬疑/奇幻/历史)都在电影题材里');
}
{
    const TV_EX = '16,10764,10767,99,10763,10762';
    let q = Q('tv', { region: 'th' });
    ok(P('tv', { region: 'th' }) === '/discover/tv' && q.with_origin_country === 'TH' && q.without_genres === TV_EX && q.sort_by === 'popularity.desc' && q['vote_count.gte'] === 1 && q.page === 1,
        '泰剧:/discover/tv · 泰国 · 去掉动画/综艺/纪录 · 最热 · ≥1 票', q);
    q = Q('tv', { genre: 'costume' });
    ok(q.with_origin_country === 'CN|HK|TW' && /195013/.test(q.with_keywords), '古装不选地区:默认只看华语(否则是唐顿庄园)', q);
    q = Q('tv', { genre: 'costume', region: 'kr', sort: 'top' });
    ok(q.with_origin_country === 'KR' && q.sort_by === 'vote_average.desc' && q['vote_count.gte'] === 8, '古装 + 韩剧:按选的地区;高分门槛取选项自带的 8', q);
    ok(Q('tv', { genre: 'spy' }).with_origin_country === 'CN|HK|TW', '谍战不选地区也默认华语');
    ok(Q('tv', { region: 'hk', sort: 'top' })['vote_count.gte'] === 5 && Q('tv', { region: 'cn', sort: 'top' })['vote_count.gte'] === 15, '高分门槛:港剧票数少降到 5,国产保持 15');
    q = Q('tv', { region: 'kr', genre: 'romance' });
    ok(q.with_keywords === '9840' && q.with_origin_country === 'KR', 'TMDB 剧集没有爱情类型 → 用关键词 romance', q);
    q = Q('anime', { form: 'movie', genre: 'action', year: '2010s' });
    ok(P('anime', { form: 'movie' }) === '/discover/movie' && q.with_genres === '16,28' && q['primary_release_date.gte'] === '2010-01-01' && q['primary_release_date.lte'] === '2019-12-31',
        '动画电影:换电影接口,题材用电影的类型 id(热血 = 动作 28),年代用上映日期', q);
    ok(Q('anime', { genre: 'action' }).with_genres === '16,10759', 'TV 动画的热血 = 剧集类型 10759');
    q = Q('variety', { genre: 'talk', region: 'cn' });
    ok(q.with_genres === '10767' && q.with_origin_country === 'CN' && !('vote_count.gte' in q), '综艺·脱口秀:覆盖掉真人秀|脱口秀,综艺不设票数门槛(TMDB 上综艺票数普遍很少)', q);
    q = Q('doc', {});
    ok(q.sort_by === 'vote_average.desc' && q['vote_count.gte'] === 20 && q.with_genres === '99', '纪录片默认高分(热度排前面的是欧美新闻杂志节目)', q);
    ok(Q('doc', { region: 'cn' })['vote_count.gte'] === 3, '国产纪录片票数少:高分门槛 3');
    ok(Q('doc', { form: 'movie' }).without_genres === '10402', '纪录电影去掉演唱会(音乐类)');
    ok(Q('doc', { genre: 'food' })['vote_count.gte'] === 5 && Q('doc', { genre: 'food', form: 'movie' })['vote_count.gte'] === 20, '门槛只升的选项(vcUp):纪录电影 + 美食的高分门槛升回 20(电视纪录片才降到 5)');
    q = Q('movie', {});
    ok(q['vote_count.gte'] === 50, '电影热门全局 ≥50 票(几十票以下的欧美片混着情色片)');
    ok(['cn', 'mainland', 'hk', 'tw', 'kr', 'jp', 'th'].every(r => Q('movie', { region: r })['vote_count.gte'] === 10) && Q('movie', { region: 'fr' })['vote_count.gte'] === 50 && Q('movie', { region: 'eu' })['vote_count.gte'] === 50,
        '华语 / 日韩泰电影热门 ≥10 票(正经新片只有 10~40 票),法国 / 欧洲照全局 50');
    ok(Q('movie', { genre: 'wuxia' })['vote_count.gte'] === 10, '武侠电影本来就少:热门门槛 10');
    ok(Q('tv', { genre: 'youth' }).with_origin_country === 'CN|HK|TW' && Q('tv', { genre: 'youth', region: 'kr' }).with_origin_country === 'KR', '青春不选地区默认华语(否则全是美剧)');
    ok(/347945/.test(Q('tv', { genre: 'costume' }).with_keywords) && /309130/.test(Q('tv', { genre: 'spy' }).with_keywords), '古装 / 谍战带上 TMDB 的中文关键词(古装剧 / 谍战剧)');
    ok(!/5647/.test(Q('doc', { genre: 'history' }).with_keywords), '历史纪录片不含 natural history(那是自然类)');
    q = Q('movie', { region: 'hk', sort: 'new', year: '2026' });
    ok(q['primary_release_date.gte'] === '2026-01-01' && q['primary_release_date.lte'] === '2026-10-09' && q.sort_by === 'primary_release_date.desc', '最新 + 今年:截止到今天(不要还没上映的)', q);
    q = Q('tv', { sort: 'new' });
    ok(q['first_air_date.lte'] === '2026-10-09' && q.sort_by === 'first_air_date.desc', '剧集最新:按首播日期,截止今天', q);
    ok(Q('tv', { year: 'old' })['first_air_date.lte'] === '1989-12-31' && !('first_air_date.gte' in Q('tv', { year: 'old' })), '「更早」= 1989 年及以前');
    q = Q('movie', {}, { nsfw: true });
    ok(q.include_adult === 'false' && q.without_keywords === C.NSFW_KW, '过滤成人内容:不要成人片 + 排除 softcore/erotic movie/hentai 等关键词', q);
    // adult animation(辛普森 / 瑞克和莫蒂)、pornography(出租车司机)、ecchi(无职转生)、erotic 打在正经作品上,不能排除
    ok(C.NSFW_KW.split('|').every(id => !['161919', '445', '195669', '256466'].includes(id)), '成人过滤不排除 adult animation / pornography / ecchi / erotic 这几个会误伤的关键词', C.NSFW_KW);
    q = Q('tv', {}, { nsfw: false });
    ok(!('without_keywords' in q) && !('include_adult' in q), '关掉过滤:不加这两个参数');
    ok(C.buildQuery('tv', {}, 0, { now: NOW }).params.page === 1 && C.buildQuery('tv', {}, 999, { now: NOW }).params.page === 500, '页码夹在 1~500(TMDB 上限)');
    ok(eq(C.normSel('tv', { region: 'xx', genre: 'romance', year: '1888', sort: 'bad' }, NOW), { region: '', genre: 'romance', lang: '', year: '', sort: 'hot' }), '认不得的值归「全部」/默认');
    q = Q('movie', { lang: 'cn' });
    ok(q.with_original_language === 'cn' && q['vote_count.gte'] === 10, '粤语片:按原始语言(TMDB 的 cn = 粤语),华语门槛 10', q);
    ok(Q('movie', { lang: 'fr' })['vote_count.gte'] === 50 && Q('tv', { lang: 'cn', sort: 'top' })['vote_count.gte'] === 5, '法语片照全局 50;粤语剧高分门槛 5(TVB 剧票数少)');
    ok(eq(C.groupsOf('tv', {}, NOW).map(g => g.k), ['region', 'genre', 'lang', 'year', 'sort']) && C.groupsOf('tv', {}, NOW)[2].opts.length === 7, '剧集筛选多一行语言(全部 + 国语/粤语/英语/韩语/日语/泰语)');
    ok(!C.groupsOf('anime', {}, NOW).some(g => g.k === 'lang'), '动漫不放语言(和地区重复)');
    ok(C.normSel('doc', {}, NOW).sort === 'top' && C.normSel('tv', {}, NOW).sort === 'hot', '默认排序:纪录片高分,其余最热');
}
{
    const ys = C.yearOpts(NOW).map(x => x.k);
    ok(eq(ys, ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2010s', '2000s', '1990s', 'old']), '年份(2026):近 7 年逐年 + 2010/2000/90 年代 + 更早', ys);
    const y30 = C.yearOpts(new Date(2030, 0, 2));
    ok(y30[7].k === '2020s' && C.yearRange('2020s', new Date(2030, 0, 2)).lte === '2023-12-31', '年份(2030):年代接在逐年之前(2020 年代只到 2023)', y30.map(x => x.k));
    ok(C.yearOpts(NOW)[9].l === '90年代', '1990 年代显示成「90年代」');
}
{
    const it = (name, extra) => Object.assign({ id: 1, poster_path: '/a.jpg', name, original_name: name, original_language: 'zh' }, extra || {});
    ok(C.visible(it('庆余年'), true), '中文名显示');
    ok(!C.visible(it('ธี่หยด', { original_language: 'th' }), false), '泰文名(没有中文译名)不显示');
    ok(!C.visible(it('런닝맨', { original_language: 'ko' }), false), '韩文名不显示');
    ok(!C.visible(it('水曜どうでしょう', { original_language: 'ja' }), false), '带假名的日文名不显示');
    ok(C.visible(it('相棒', { original_language: 'ja' }), false), '纯汉字的日文名照常显示');
    ok(C.visible(it('Slow Horses', { original_language: 'en' }), false), '英语原名照常显示(服务器会去换中文名再搜)');
    ok(!C.visible(it('Köln 50667', { original_language: 'de' }), false), '没翻译的德语原名不显示');
    ok(C.visible(it('Running Man', { original_language: 'ko', original_name: '런닝맨' }), false), '有拉丁字母译名的(Running Man)显示');
    ok(!C.visible(it('无海报', { poster_path: null }), false), '没海报的不显示');
    ok(C.visible(it('哈利・波特与魔法石', { original_language: 'en', original_name: 'Harry Potter' }), true), '中文译名里的「・」不算假名');
    ok(!C.visible(it('玉蒲团之极乐宝鉴', { vote_count: 4 }), true) && C.visible(it('玉蒲团之极乐宝鉴', { vote_count: 4 }), false), '片名黑名单只在开着过滤成人内容时生效');
    ok(!C.visible(it('裸体诱惑', { vote_count: 44 }), true) && !C.visible(it('晚娘上部：恋欲', { vote_count: 43 }), true), '黑名单拦住裸体相亲节目、没打关键词的情色片');
    ok(C.visible(it('性爱自修室', { vote_count: 8029 }), true), '黑名单只管 200 票以下:《性爱自修室》八千多票照常显示');
    const legit = ['小姐', '色‧戒', '情书', '偷情', '岳母刺字', '漂亮妈妈', '姐姐', '性格', '年轻的教师', '春光乍泄'];
    ok(legit.every(n => C.visible(it(n), true)), '正经片名不被黑名单误伤', legit.filter(n => !C.visible(it(n), true)));
    ok(C.countLabel(999) === '999' && C.countLabel(20001) === '2万+', '数量显示:过万写「N万+」');
}
{
    const F = (s) => C.fromSearch(s, NOW);
    const cases = [
        ['泰剧', { type: 'tv', sel: { region: 'th' } }],
        ['  泰 剧 ', { type: 'tv', sel: { region: 'th' } }],
        ['韩剧推荐', { type: 'tv', sel: { region: 'kr' } }],
        ['泰剧在线观看', { type: 'tv', sel: { region: 'th' } }],
        ['最新泰剧', { type: 'tv', sel: { region: 'th', sort: 'new' } }],
        ['2024年韩剧', { type: 'tv', sel: { region: 'kr', year: '2024' } }],
        ['2008日剧', { type: 'tv', sel: { region: 'jp', year: '2000s' } }],
        ['1985港片', { type: 'movie', sel: { region: 'hk', year: 'old' } }],
        ['高分港剧', { type: 'tv', sel: { region: 'hk', sort: 'top' } }],
        ['好看的韩剧推荐', { type: 'tv', sel: { region: 'kr', sort: 'hot' } }],
        ['经典港片', { type: 'movie', sel: { region: 'hk', sort: 'top' } }],
        ['TVB', { type: 'tv', sel: { region: 'hk' } }],
        ['BBC', { type: 'doc', sel: { region: 'gb' } }],
        ['新番', { type: 'anime', sel: {} }],
        ['国漫', { type: 'anime', sel: { region: 'cn' } }],
        ['动画电影', { type: 'anime', sel: { form: 'movie' } }],
        ['韩综', { type: 'variety', sel: { region: 'kr' } }],
        ['恋综', { type: 'variety', sel: { genre: 'dating' } }],
        ['古装剧', { type: 'tv', sel: { genre: 'costume' } }],
        ['恐怖片', { type: 'movie', sel: { genre: 'horror' } }],
        ['纪录片', { type: 'doc', sel: {} }],
    ];
    for (const [kw, want] of cases) ok(eq(F(kw), want), '搜「' + kw + '」→ ' + JSON.stringify(want), F(kw));
    // 真片名 / 不完整的词 → 照常按片名搜(好莱坞 = Netflix 剧《好莱坞》,真人秀 = 2012 年电影,影片 = 2021 年电影)
    for (const kw of ['', '新白娘子传奇', '喜剧之王', '新喜剧之王', '2012', '2046', '最新', '2027韩剧', '狂飙', '武侠', '韩剧TV', '泰剧星辰', '好莱坞', '真人秀', '影片', 'a'.repeat(30)]) ok(F(kw) === null, '「' + kw.slice(0, 12) + '」不是分类词,按片名搜', F(kw));
    ok(eq(F('好莱坞电影'), { type: 'movie', sel: { region: 'us' } }) && eq(F('真人秀节目'), { type: 'variety', sel: { genre: 'reality' } }), '带上「电影」「节目」才算分类词');
    ok(eq(F('粤语片'), { type: 'movie', sel: { lang: 'cn' } }) && eq(F('经典粤语片'), { type: 'movie', sel: { lang: 'cn', sort: 'top' } }) && eq(F('粤语剧'), { type: 'tv', sel: { lang: 'cn' } }), '搜「粤语片」「粤语剧」→ 按语言浏览');
    // 每个分类词都能落到有效的分类上(sel 归一后不丢键)
    const bad = [];
    for (const w of ['泰国剧', '国产剧', '台剧', '英剧', '欧剧', '日韩剧', '仙侠', '谍战', '青春剧', '医疗剧', '律政剧', '港片', '宝莱坞', '武侠片', '灾难片', '日漫', '美漫', '异世界', '机甲番', '国综', '日综', '台综', '美综', '脱口秀', '真人秀节目', '选秀', '国产纪录片', '纪录电影', '自然纪录片', '罪案纪录片']) {
        const p = F(w);
        if (!p || !C.typeOf(p.type) || !Object.keys(p.sel).every(k => C.normSel(p.type, p.sel, NOW)[k] === p.sel[k])) bad.push(w);
    }
    ok(!bad.length, '分类词都能落到有效的分类上', bad);
}
{
    const rowKeys = [...(/rowConfigs: \{([\s\S]*?)\n\s*\},\n/.exec(HTML) || ['', ''])[1].matchAll(/\n\s*(\w+Row): \{/g)].map(m => m[1]);
    ok(rowKeys.length >= 19 && rowKeys[0] === 'randomRow', '读到首页榜单配置(rowConfigs)', rowKeys);
    const miss = rowKeys.filter(k => k !== 'randomRow' && !C.rowPreset(k, 'newest'));
    ok(!miss.length, '除随机盲盒外每个榜单都有「全部」去处', miss);
    ok(C.rowPreset('randomRow') === null, '随机盲盒没有「全部」');
    ok(eq(C.rowPreset('cnRow', 'newest'), { type: 'tv', sel: { sort: 'new', region: 'cn' } }) && C.rowPreset('movieRow').sel.sort === 'hot', '榜单当前是「最新」→ 浏览页也按最新;榜单热门/周榜 → 最热');
    ok(C.rowPreset('krjpRow').sel.region === 'krjp' && C.rowPreset('docRow').sel.form === 'movie', '日韩那行 → 日韩;纪录片那行(电影接口)→ 纪录电影');
    for (const k of rowKeys.filter(k => k !== 'randomRow')) {
        const p = C.rowPreset(k, 'newest');
        ok(Object.keys(p.sel).every(x => C.normSel(p.type, p.sel, NOW)[x] === p.sel[x]), '榜单 ' + k + ' 的预设都是有效值', p);
    }
}
{
    ok(C.title('tv', { region: 'th' }) === '剧集 · 泰剧' && C.title('movie', {}) === '电影', '标题:大类 + 选中的筛选');
    ok(C.title('anime', { region: 'jp', form: 'movie' }) === '动漫 · 日本 · 动画电影', '标题带形式(默认的 TV 动画不写)');
    ok(C.summary('doc', { region: 'gb' }, NOW) === '纪录片 · 英国 · 高分' && C.summary('tv', { year: '2010s', sort: 'new' }, NOW) === '剧集 · 2010年代 · 最新', '摘要条:标题 + 年份 + 排序');
    const g = C.groupsOf('anime', {}, NOW);
    ok(eq(g.map(x => x.k), ['region', 'form', 'genre', 'year', 'sort']) && g[1].opts[0].l === 'TV动画' && g[0].opts[0].l === '全部', '筛选行:各组 + 年份 + 排序;形式没有「全部」', g.map(x => x.k));
    const nav = C.navRows('anime');
    ok(eq(nav[0].items.map(x => x.l), ['日本番剧', '国漫', '欧美动画', '动画电影']) && nav[1].l === '题材', '首页动漫:日本番剧 / 国漫 / 欧美动画 / 动画电影 + 题材');
    ok(!C.navRows('tv')[0].items.some(x => x.l === '日韩'), '首页剧集地区不出现隐藏的「日韩」');
    ok(!C.navRows('movie').some(r => r.l === '语言'), '首页分类栏不放语言(只在浏览页和分类大全里)');
}
{
    // 分类大全:热门入口 + 每个大类一张卡片(各组 + 年份);每一项都是有效的浏览页预设
    const D = C.directory(NOW);
    ok(D.hot.length >= 12 && ['国产剧', '韩剧', '泰剧', '美剧', '日剧', '港剧', '台剧'].every(l => D.hot.some(h => h.l === l)), '热门入口有国产剧/韩剧/泰剧/美剧/日剧/港剧/台剧', D.hot.map(h => h.l));
    const badHot = D.hot.filter(h => !C.typeOf(h.type) || !Object.keys(h.sel).every(k => C.normSel(h.type, h.sel, NOW)[k] === h.sel[k]) || !/^linear-gradient/.test(h.bg));
    ok(!badHot.length, '热门入口都落到有效的分类上、都有渐变底色', badHot.map(h => h.l));
    ok(eq(D.types.map(t => t.k), C.TYPES.map(t => t.k)), '每个大类一张卡片');
    ok(D.types.every(t => t.rows[t.rows.length - 1].l === '年份' && t.rows[t.rows.length - 1].items.length === 11), '每张卡片最后一行是年份(近 7 年 + 年代 + 更早)');
    ok(['movie', 'tv'].every(k => D.types.find(t => t.k === k).rows.some(r => r.l === '语言')), '电影 / 剧集卡片有语言');
    const badItems = [];
    for (const t of D.types) for (const r of t.rows) for (const it of r.items) if (!Object.keys(it.sel).every(k => C.normSel(t.k, it.sel, NOW)[k] === it.sel[k])) badItems.push(t.l + '/' + r.l + '/' + it.l);
    ok(!badItems.length, '大全里每一项都是有效的浏览页预设', badItems);
    ok(!D.types.find(t => t.k === 'tv').rows[0].items.some(x => x.l === '日韩'), '大全里不出现隐藏的「日韩」');
}

console.log('② 模板 / 方法接线');
{
    ok(/@keyup\.enter="submitSearch\(true\)"/.test(HTML) && /search-icon" @click="submitSearch\(true\)"/.test(HTML), '搜索框回车 / 放大镜走 submitSearch(分类词直达)');
    ok(/this\.searchTimer = setTimeout\(\(\) => \{\s*this\.submitSearch\(\);/.test(HTML), '输入停顿自动搜也走 submitSearch(不收键盘)');
    ok(!/handleCatClick|category-nav-container|class="cat-icon"|\n\s*categories: \[/.test(HTML), '旧的 19 个图标分类(categories / handleCatClick / 样式)已删干净');
    ok(/<nav class="navbar-custom" v-show="!offHome">/.test(HTML) && /<div v-show="!offHome" class="home-flow">/.test(HTML) && /v-if="!searched" v-show="!browse\.open && !catDirOpen"/.test(HTML), '浏览页 / 分类大全开着:导航栏、首页各行收起,轮播只藏不销毁');
    ok(/<div class="browse-page" v-if="browse\.open" v-show="!searched">/.test(HTML), '浏览页:从它点进搜索时只藏起来(返回时片单还在)');
    ok(/browse\.open \|\| catDirOpen \? '返回分类' : '返回首页'/.test(HTML), '从浏览页 / 分类大全进的搜索结果,返回按钮写「返回分类」');
    ok(/<div class="catdir-page" v-if="catDirOpen" v-show="!browse\.open && !searched">/.test(HTML), '分类大全:从它点进浏览页 / 搜索时只藏起来(返回时位置还在)');
    const tabsH = (/<div class="cat-tabs" role="group" aria-label="大类">([\s\S]*?)<\/div>/.exec(HTML) || ['', ''])[1];
    ok(/^\s*<!--[^>]*-->\s*<button type="button" class="cat-tab cat-tab-all" @click="openCatDir\(\)"/.test(tabsH), '首页大类最前面是「全部分类」,点了进分类大全');
    ok(/<div class="catnav-body" role="group"/.test(HTML), '首页分类栏照旧有地区 / 题材标签');
    ok(!/catNavVariant|is-compact|\?catnav=/.test(HTML), '对比用的预览开关(?catnav=)已删干净');
    ok(/v-if="key !== 'randomRow'"[^>]*class="expand-toggle row-all" @click="rowBrowse\(key\)"/.test(HTML), '榜单标题旁的「全部」(随机盲盒除外)');
    ok(/catNavJump\('random'\)/.test(HTML) && /catNavJump\('recommend'\)/.test(HTML) && /ref="recommendSection"/.test(HTML), '分类栏保留「随机盲盒」「猜你想看」两个快捷入口');
    ok(/v-if="!hideRandomRow"[^>]*catNavJump\('random'\)/.test(HTML) && /v-if="recommendList\.length > 0 && homeOn\.recommend"[^>]*catNavJump\('recommend'\)/.test(HTML), '…隐藏了随机盲盒 / 没有推荐(或首页关了为你推荐)时入口跟着藏');
    ok(/if \(this\.browse\.open && !this\.searched\) this\._browseScrollY = window\.scrollY/.test(HTML), 'doSearch:从浏览页进搜索前记下滚动位置');
    const tvH = HTML.slice(HTML.indexOf('// TV 模式全局返回键处理'), HTML.indexOf('// 在首页：不拦截返回键'));
    ok(/if \(self\.searched\) \{[\s\S]*?self\.goHome\(\);[\s\S]*?if \(self\.browse && self\.browse\.open\) \{[\s\S]*?self\.closeBrowse\(\);/.test(tvH), 'TV 遥控返回键:搜索结果 → goHome(会退回浏览页),浏览页 → 首页');
    ok(!/@click="closeBrowse"/.test(HTML) && /@click="closeBrowse\(\)"/.test(HTML), '模板里 closeBrowse 都带括号调用(不带的话点击事件会被当成 quiet,不还原首页位置)');
    ok((HTML.match(/class="browse-sticky-(back|main)" :tabindex="isTVMode \? -1 : null"/g) || []).length === 2, '顶上摘要条的两个按钮不进遥控器焦点链');
    ok(/window\.vueApp = new Proxy\(this, \{\s*get: \(t, k\) => \(k === 'searched' \? !!\(t\.searched \|\| \(t\.browse && t\.browse\.open\) \|\| t\.catDirOpen\) : Reflect\.get\(t, k\)\),/.test(HTML), 'window.vueApp:浏览页 / 分类大全开着时对安卓 App 说 searched = true');
    ok(/过滤随机盲盒和分类浏览中的不适宜内容/.test(HTML) && /if \(this\.browse\.open\) this\._browseFetch\(true\);/.test(HTML), '「过滤成人内容」也管分类浏览,切换后浏览页重拉');
}

console.log('③ 沙箱里真跑方法');
const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const SRC = scripts.find(s => s.includes('createApp({'));
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
let captured = null;
const scrolls = [], cleared = [];
const ctxObj = {
    Vue: { createApp(o) { captured = o; return { mount() { return {}; }, use() { return this; }, config: {} }; } },
    console: { log() { }, warn() { }, error() { }, info() { } },
    setTimeout: () => 0, clearTimeout(id) { cleared.push(id); }, setInterval: () => 0, clearInterval() { },
    requestAnimationFrame: () => 0, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet, Symbol, Error, TypeError,
    URL, URLSearchParams, Uint8Array, ArrayBuffer, Proxy, Reflect, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, AbortController, TextEncoder, TextDecoder,
    scrollY: 0, innerHeight: 800,
    scrollTo(a, b) { scrolls.push(typeof a === 'object' ? a.top : b); },
};
const ctx = new Proxy(ctxObj, {
    has() { return true; },
    get(t, k) { if (k in t) return t[k]; if (k === 'window' || k === 'self' || k === 'globalThis') return ctx; return any(); },
    set(t, k, v) { t[k] = v; return true; }
});
try { vm.runInNewContext(SRC, ctx, { timeout: 5000 }); } catch (e) { }
const M = (captured && captured.methods) || {};
ok(!!captured && typeof M.openBrowse === 'function', '沙箱里跑出了 createApp 选项和浏览页方法');
const names = ['openBrowse', 'closeBrowse', '_leaveSearch', '_browseFromSearch', 'setBrowseType', 'setBrowseFilter', 'browseClearFilters', 'browseMore', '_browseFetch', '_browseFill',
    '_browseAbort', '_browseDropKeyword', 'browsePick', 'browseSearchKeyword', 'submitSearch', 'goHome', 'catNavSelect', 'rowBrowse', '_browseRevealActive', '_browseObserve'];
ok(names.every(n => typeof M[n] === 'function'), '方法都在:' + names.filter(n => typeof M[n] !== 'function').join(','));

function makeApp(over) {
    const app = {
        browse: { open: false, type: 'tv', sel: {}, items: [], page: 0, totalPages: 0, total: 0, loading: false, error: false, done: false, idle: 0, seq: 0, keyword: '', auto: false, fromDir: false },
        browseStuck: false, catDirOpen: false, searched: false, keyword: '', rawList: [], loading: false, _originalTitle: '', showDetail: false, isTVMode: false, filterNsfw: true,
        catNavType: 'tv', rowConfigs: { cnRow: { sortMode: 'newest' }, movieRow: {} }, $refs: {}, calls: [],
        $nextTick(f) { if (f) f(); return Promise.resolve(); },
    };
    for (const n of Object.keys(M)) if (typeof M[n] === 'function') app[n] = M[n].bind(app);
    app._cancelDeepLink = () => false;
    app._browseObserve = () => { app.calls.push('observe'); };
    app._browseRevealActive = () => { };
    app.doSearch = () => { app.calls.push('doSearch:' + app.keyword); app.searched = true; };
    app.autoSearch = (n) => { app.keyword = n; app.doSearch(); };
    app.scrollToSection = (k) => { app.calls.push('section:' + k); };
    return Object.assign(app, over || {});
}
const tick = () => new Promise(r => setImmediate(r));
{
    // 首页 → 浏览页 → 首页:记住/还原首页位置
    const app = makeApp();
    let fetches = 0;
    app._browseFetch = (reset) => { fetches++; app.calls.push('fetch:' + reset); };
    ctxObj.scrollY = 1234; scrolls.length = 0;
    app.openBrowse({ type: 'tv', sel: { region: 'th' } });
    ok(app.browse.open && app.browse.type === 'tv' && eq(app.browse.sel, { region: 'th', genre: '', lang: '', year: '', sort: 'hot' }) && app._homeScrollY === 1234 && scrolls[0] === 0 && fetches === 1,
        '打开浏览页:sel 补齐、记下首页位置、回到顶部、拉第一页', { sel: app.browse.sel, home: app._homeScrollY, scrolls, fetches });
    ok(app.catNavType === 'tv', '首页分类栏同步选中这个大类');
    scrolls.length = 0;
    app.goHome();
    ok(!app.browse.open && scrolls[0] === 1234, 'goHome(返回按钮 / 安卓返回键)在浏览页:回首页,滚回进来前的位置', scrolls);

    // 搜索框搜「泰剧」:直达;再按回车不重拉;关掉时清掉搜索框里的词
    const b = makeApp();
    let f2 = 0;
    b._browseFetch = () => { f2++; };
    b.keyword = '泰剧';
    b.submitSearch();
    ok(b.browse.open && b.browse.sel.region === 'th' && b.browse.keyword === '泰剧' && f2 === 1 && !b.calls.some(c => c.startsWith('doSearch')), '搜「泰剧」:打开剧集·泰剧,不当片名搜', b.calls);
    b.submitSearch(true);
    ok(f2 === 1, '停顿时已自动打开同一个分类,再按回车不重拉');
    b.keyword = '狂飙';
    b.submitSearch(true);
    ok(b.calls.includes('doSearch:狂飙'), '普通片名照常搜');
    b.goHome();   // 搜索结果 → 浏览页
    ok(b.browse.open && !b.searched && b.keyword === '泰剧', '从浏览页进的搜索,返回:回到浏览页,搜索框换回「泰剧」');
    b.goHome();   // 浏览页 → 首页
    ok(!b.browse.open && b.keyword === '', '再返回:回首页,搜索框里的「泰剧」清掉');

    // 浏览页点海报 → 搜索 → 返回:位置、片单都在
    const c = makeApp();
    c._browseFetch = () => { };
    c.openBrowse({ type: 'anime', sel: { region: 'jp' } });
    c.browse.items = [{ id: 7, name: '葬送的芙莉莲', original_name: '葬送のフリーレン' }];
    c._browseScrollY = 2400;
    c.browsePick(c.browse.items[0]);
    ok(c.searched && c.keyword === '葬送的芙莉莲' && c._browsePickId === 7, '点海报:按片名搜(和首页一样)');
    scrolls.length = 0;
    c.goHome();
    ok(c.browse.open && !c.searched && c.browse.items.length === 1 && scrolls[0] === 2400 && c.calls.includes('observe'), '返回分类:片单还在,滚回原位置,重新挂上滚动加载', scrolls);

    // 改了筛选:搜的那个分类词不再代表片单 → 从搜索框和提示里去掉
    const d = makeApp();
    d._browseFetch = () => { };
    d.keyword = '韩综';
    d.submitSearch(true);
    d.setBrowseFilter('genre', 'dating');
    ok(d.browse.keyword === '' && d.keyword === '' && d.browse.sel.genre === 'dating' && d.browse.sel.region === 'kr', '从「韩综」进来又改了筛选:搜索框里的词和「按片名搜索」提示去掉');
    d.setBrowseType('doc');
    ok(d.browse.type === 'doc' && d.browse.sel.sort === 'top', '切到纪录片:排序没手动改过 → 用纪录片自己的默认(高分)');
    d.setBrowseFilter('sort', 'new');
    d.setBrowseType('tv');
    ok(d.browse.sel.sort === 'new' && d.browse.sel.region === '', '手动选过的排序跨大类保留,地区等清空');

    // 榜单「全部」
    const e = makeApp();
    let got = null;
    e.openBrowse = (p) => { got = p; };
    e.rowBrowse('cnRow');
    ok(eq(got, { type: 'tv', sel: { sort: 'new', region: 'cn' } }), '华语强档那行(当前最新)→ 剧集·国产·最新', got);
}
{
    // 首页 → 分类大全 → 浏览页 → 返回(回大全原位置)→ 返回(回首页原位置)
    const app = makeApp();
    app._browseFetch = () => { };
    ctxObj.scrollY = 900; scrolls.length = 0;
    app.openCatDir();
    ok(app.catDirOpen && app._homeScrollY === 900 && scrolls[0] === 0, '打开分类大全:记下首页位置,回到顶部');
    ctxObj.scrollY = 1500;
    app.openBrowse({ type: 'tv', sel: { region: 'th' } });
    ok(app.browse.open && app.browse.fromDir && app._dirScrollY === 1500 && app._homeScrollY === 900, '从大全点「泰剧」:记下大全位置,首页位置不动');
    app.browsePick({ id: 5, name: '禁忌女孩' });
    app.goHome();
    ok(app.browse.open && !app.searched, '搜索结果 → 返回 → 浏览页');
    scrolls.length = 0;
    app.goHome();
    ok(!app.browse.open && app.catDirOpen && scrolls[0] === 1500, '浏览页 → 返回 → 分类大全原位置', scrolls);
    scrolls.length = 0;
    app.goHome();
    ok(!app.catDirOpen && scrolls[0] === 900, '分类大全 → 返回 → 首页原位置', scrolls);
    // 在大全的搜索框里搜片名:返回回大全原位置
    ctxObj.scrollY = 0;
    app.openCatDir();
    app._dirScrollY = 700;
    app.keyword = '狂飙'; app.submitSearch(true);
    ok(app.searched && app.catDirOpen && !app.browse.open, '在大全里搜片名:进搜索结果');
    scrolls.length = 0;
    app.goHome();
    ok(!app.searched && app.catDirOpen && scrolls[0] === 700, '搜索结果 → 返回 → 分类大全原位置', scrolls);
    ctxObj.scrollY = 0;
}
{
    // 停顿自动搜的定时器:离开浏览页 / 回车提交都取消(否则半秒后在首页冒出搜索结果,或回车后又搜一遍)
    const app = makeApp();
    app._browseFetch = () => { };
    app.openBrowse({ type: 'tv', sel: {} });
    app.keyword = '狂飙'; app.searchTimer = 4242; cleared.length = 0;
    app.closeBrowse();
    ok(cleared.includes(4242) && app.keyword === '狂飙', '在浏览页打了字马上返回:取消还没触发的停顿自动搜(打的字留着)');
    app.searchTimer = 4343; cleared.length = 0;
    app.keyword = '泰剧';
    app.submitSearch(true);
    ok(cleared.includes(4343), '回车提交:取消停顿自动搜');
}
{
    // 停顿时按分类词自动打开的浏览页(临时),接着打成片名:收掉它,返回直接回首页
    const app = makeApp();
    app._browseFetch = () => { };
    app.keyword = '谍战';
    app.submitSearch();
    ok(app.browse.open && app.browse.auto && app.browse.sel.genre === 'spy', '停顿时自动打开「剧集·谍战」(临时)');
    scrolls.length = 0;
    app.keyword = '谍战深海之惊蛰';
    app.submitSearch();
    ok(!app.browse.open && app.searched && app.calls.includes('doSearch:谍战深海之惊蛰') && app.keyword === '谍战深海之惊蛰' && !scrolls.length,
        '接着打成片名:临时分类页静默收掉(不跳回首页位置),直接搜片名');
    const b = makeApp();
    b._browseFetch = () => { };
    b.keyword = '谍战'; b.submitSearch(true);
    b.keyword = '潜伏'; b.submitSearch(true);
    ok(b.browse.open && b.searched, '回车打开的分类页:再搜片名,返回时还能回到它');
    const c = makeApp();
    c._browseFetch = () => { };
    c.keyword = '谍战'; c.submitSearch();
    c.setBrowseFilter('sort', 'top');
    c.keyword = '伪装者'; c.submitSearch();
    ok(c.browse.open && c.searched, '临时分类页里动过筛选:它就留在返回路径上');
}
{
    // 从浏览页进的搜索,把搜索框清空:回浏览页原位置,不把分类词填回去
    const app = makeApp();
    app._browseFetch = () => { };
    app.keyword = '泰剧'; app.submitSearch(true);
    app.browsePick({ id: 3, name: '禁忌女孩' });
    app._browseScrollY = 1800; scrolls.length = 0;
    app.keyword = '';
    app.debouncedSearch();
    ok(app.browse.open && !app.searched && app.keyword === '' && scrolls[0] === 1800, '清空搜索框:回浏览页原位置,搜索框保持空', { scrolls, kw: app.keyword });
}
{
    // TV 模式返回键(mounted 里 window 捕获阶段那个处理器):在输入框里按退格是删字,不是返回
    const at = HTML.indexOf('// TV 模式全局返回键处理');
    const f0 = HTML.indexOf('function (e) {', HTML.lastIndexOf("addEventListener('keydown', function (e) {", at));
    let i = f0 + 'function (e) {'.length, depth = 1, q = null;
    for (; i < HTML.length && depth > 0; i++) {
        const ch = HTML[i];
        if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
        if (ch === '/' && HTML[i + 1] === '/') { i = HTML.indexOf('\n', i); continue; }
        if (ch === '\'' || ch === '"' || ch === '`') { q = ch; continue; }
        if (ch === '{') depth++; else if (ch === '}') depth--;
    }
    const app = makeApp({ isTVMode: true });
    app._browseFetch = () => { };
    const handler = vm.runInNewContext('(function (self) { return ' + HTML.slice(f0, i) + '; })', { document: { getElementById: () => null, activeElement: null }, dp: null, safeSeekBy() { } })(app);
    const key = (k, tag) => { const e = { key: k, target: { tagName: tag }, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { } }; handler(e); return e; };
    app.openBrowse({ type: 'tv', sel: { region: 'th' } });
    const e1 = key('Backspace', 'INPUT');
    ok(app.browse.open && !e1.prevented, 'TV:在搜索框里按退格 = 删字,浏览页不关');
    const e2 = key('Backspace', 'BUTTON');
    ok(!app.browse.open && e2.prevented, 'TV:焦点不在输入框时按退格 = 返回,回首页');
    app.openBrowse({ type: 'tv', sel: {} });
    app.browsePick({ id: 9, name: '狂飙' });
    key('Escape', 'BODY');
    ok(app.browse.open && !app.searched, 'TV:搜索结果按返回 → 退回浏览页');
    key('Escape', 'BODY');
    app.openCatDir();
    app.openBrowse({ type: 'anime', sel: { region: 'jp' } });
    key('Escape', 'BUTTON');
    ok(!app.browse.open && app.catDirOpen, 'TV:从分类大全进的浏览页按返回 → 回大全');
    const e3 = key('Escape', 'BUTTON');
    ok(!app.catDirOpen && e3.prevented, 'TV:分类大全按返回 → 回首页');
    const e4 = key('Escape', 'BUTTON');
    ok(!e4.prevented, 'TV:首页按返回不拦(交给系统退出)');
}
{
    // 换筛选时上一个请求被中止:不算出错,只留新结果
    const app = makeApp();
    app.browse.open = true;
    app.browse.sel = C.normSel('tv', {}, NOW);
    const sigs = [];
    let resolveSecond = null;
    ctxObj.tmdbFetch = (url, opt) => new Promise((res, rej) => {
        sigs.push(opt.signal);
        opt.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        if (sigs.length === 2) resolveSecond = () => res({ ok: true, json: () => Promise.resolve({ total_pages: 1, total_results: 1, results: [{ id: 77, name: '新筛选', original_name: '新筛选', poster_path: '/x.jpg', original_language: 'zh' }] }) });
    });
    const p1 = app._browseFetch(true);
    const p2 = app._browseFetch(true);
    resolveSecond();
    await Promise.all([p1, p2]);
    ok(sigs[0].aborted && !sigs[1].aborted && eq(app.browse.items.map(x => x.id), [77]) && !app.browse.error && !app.browse.loading, '换筛选:上一个请求被中止,不算出错,只留新结果');
}
{
    // 底部还在视野里(这页大多被滤掉 / 屏幕很高):不等滚动,自己接着拉
    const app = makeApp();
    app.browse.open = true;
    app.browse.sel = C.normSel('tv', {}, NOW);
    app.$refs.browseFoot = { getBoundingClientRect: () => ({ top: 100 }) };
    const mk = (p) => ({ total_pages: 3, total_results: 60, results: [1, 2, 3, 4, 5].map(n => ({ id: p * 10 + n, name: '剧' + p + n, original_name: 'x', poster_path: '/p.jpg', original_language: 'zh' })) });
    ctxObj.tmdbFetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(mk(+(/[?&]page=(\d+)/.exec(url) || [])[1])) });
    await app._browseFetch(true);
    for (let n = 0; n < 50 && !app.browse.done; n++) await tick();
    ok(app.browse.done && app.browse.page === 3 && app.browse.items.length === 15, '底部一直在视野里:自己拉到最后一页', { page: app.browse.page, n: app.browse.items.length });
}
{
    // 分页:去重、过滤、冻结、过期请求丢弃、出错、到底
    const app = makeApp();
    app.browse.open = true;
    app.browse.type = 'tv';
    app.browse.sel = C.normSel('tv', { region: 'th' }, NOW);
    const urls = [];
    let pages = {};
    ctxObj.tmdbFetch = (url) => {
        urls.push(url);
        const p = +(/[?&]page=(\d+)/.exec(url) || [])[1];
        const body = pages[p];
        if (body instanceof Error) return Promise.reject(body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    };
    const item = (id, name, extra) => Object.assign({ id, name, original_name: name, poster_path: '/p' + id + '.jpg', original_language: 'th' }, extra || {});
    pages = {
        1: { total_pages: 3, total_results: 50, results: [item(1, '禁忌女孩'), item(2, 'บัลลังก์มาร'), item(3, '无海报', { poster_path: null }), item(4, '黑帮少爷爱上我')] },
        2: { total_pages: 3, total_results: 50, results: [item(4, '黑帮少爷爱上我'), item(5, '天生一对')] },
        3: { total_pages: 3, total_results: 50, results: [item(6, '只是朋友')] },
    };
    await app._browseFetch(true);
    const u = decodeURIComponent(urls[0]);
    ok(/^\/api\/tmdb-proxy\?path=\/discover\/tv&/.test(u) && /with_origin_country=TH/.test(u) && /page=1/.test(u) && /without_keywords=/.test(u), '请求走 /api/tmdb-proxy 的 /discover/tv,带上筛选和成人过滤', u);
    ok(eq(app.browse.items.map(x => x.id), [1, 4]) && Object.isFrozen(app.browse.items[0]) && app.browse.page === 1 && app.browse.total === 50 && !app.browse.done && !app.browse.loading,
        '第 1 页:泰文名、没海报的滤掉,条目冻结(不做深层响应式)', app.browse.items.map(x => x.id));
    await app._browseFetch(false);
    ok(eq(app.browse.items.map(x => x.id), [1, 4, 5]), '第 2 页:和上一页重复的那部去掉', app.browse.items.map(x => x.id));
    await app._browseFetch(false);
    ok(app.browse.done && app.browse.items.length === 4, '第 3 页 = 最后一页:标记到底');
    app.browseMore(true);
    ok(urls.length === 3, '到底后不再请求');

    // 过期请求:筛选变了,晚到的旧页丢掉
    let release;
    pages = { 1: { total_pages: 1, total_results: 1, results: [item(9, '旧筛选的结果')] } };
    ctxObj.tmdbFetch = () => new Promise(r => { release = () => r({ ok: true, json: () => Promise.resolve(pages[1]) }); });
    const pending = app._browseFetch(true);
    app.browse.seq++;   // 用户在这期间又换了筛选
    release();
    await pending;
    ok(!app.browse.items.some(x => x.id === 9), '晚到的旧筛选结果不会混进新片单');

    // 出错:标记 error(露出「重试」),不卡在加载中
    ctxObj.tmdbFetch = () => Promise.reject(new Error('net'));
    await app._browseFetch(true);
    ok(app.browse.error && !app.browse.loading && !app.browse.items.length, '请求失败:显示重试,不卡在加载中');

    // 一页全被滤掉:idle 计数;连着 4 页都这样就不再自动往下翻(手动「加载更多」照样能翻)
    pages = {};
    for (let p = 1; p <= 10; p++) pages[p] = { total_pages: 10, total_results: 200, results: [item(100 + p, 'คลึง' + p)] };
    ctxObj.tmdbFetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(pages[+(/[?&]page=(\d+)/.exec(url) || [])[1]]) });
    await app._browseFetch(true);
    for (let i = 0; i < 3; i++) await app._browseFetch(false);
    ok(app.browse.idle === 4 && app.browse.page === 4, '连着 4 页一张都没留下:idle = 4', { idle: app.browse.idle, page: app.browse.page });
    let more = 0;
    const realFetch = app._browseFetch;
    app._browseFetch = () => { more++; };
    app.browseMore(false);
    ok(more === 0, '…自动翻页停下(底部露出「加载更多」)');
    app.browseMore(true);
    ok(more === 1 && app.browse.idle === 0, '…手动「加载更多」照样能翻');
    app._browseFetch = realFetch;

    // 每页只留下两三张(宽屏上撑不起底部)也算"稀":连着 4 页就停
    pages = {};
    for (let p = 1; p <= 10; p++) pages[p] = { total_pages: 10, total_results: 200, results: [item(200 + p * 2, '剧' + p), item(201 + p * 2, '集' + p), item(300 + p, 'คลึง' + p)] };
    await app._browseFetch(true);
    for (let n = 0; n < 3; n++) await app._browseFetch(false);
    ok(app.browse.idle === 4 && app.browse.items.length === 8, '每页只留下 2 张:连着 4 页后 idle = 4', { idle: app.browse.idle, n: app.browse.items.length });
    more = 0;
    app._browseFetch = () => { more++; };
    app.browseMore(false);
    ok(more === 0, '…自动翻页停下');
    // 上了 600 张:不再自动往下翻(电视盒子扛不住无限多卡片),手动照样能翻
    app.browse.idle = 0;
    app.browse.items = Array.from({ length: 600 }, (_, n) => ({ id: 10000 + n }));
    app.browseMore(false);
    ok(more === 0, '600 张以后自动翻页停下');
    app.browseMore(true);
    ok(more === 1, '…手动「加载更多」照样能翻');
    app._browseFetch = realFetch;
}
{
    // 安卓 App 的返回键:MainActivity.onBackPressed 注入的那段 JS 原样跑(Java 字符串字面量拼回来)
    const j = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/ednovas/donguatv/MainActivity.java'), 'utf8');
    const i = j.indexOf('webView.evaluateJavascript('), k = j.indexOf('result ->', i);
    const APK_JS = [...j.slice(i, k).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1')).filter(p => !/^\s*\/\//.test(p)).join('\n');
    ok(/window\.vueApp\.searched/.test(APK_JS) && /window\.vueApp\.goHome\(\)/.test(APK_JS), '拿到 App 返回键脚本(只认 showDetail / searched)');
    const proxyM = /window\.vueApp = (new Proxy\(this, \{[\s\S]*?\}\));/.exec(HTML);
    ok(!!proxyM, '找到 mounted 里的 window.vueApp 赋值');
    const app = makeApp();
    app._browseFetch = () => { };
    const facade = proxyM ? new Function('return ' + proxyM[1]).call(app) : app;
    const win = { vueApp: facade };
    const run = () => vm.runInNewContext(APK_JS, { window: win, document: { getElementById: () => null } });
    app.openBrowse({ type: 'tv', sel: { region: 'th' } });
    app.browsePick({ id: 1, name: '禁忌女孩' });
    ok(run() === 'went_home' && app.browse.open && !app.searched, 'App 返回键 #1(搜索结果):退回浏览页');
    ok(run() === 'went_home' && !app.browse.open, 'App 返回键 #2(浏览页):回首页 —— 不是直接退出 App');
    ok(run() === 'exit', 'App 返回键 #3(首页):交给系统退出(和以前一样)');
    ok(facade.searched === false && typeof facade.closeDetail === 'function', '其余属性/方法原样透传');
    // 经过分类大全:搜索结果 → 浏览页 → 大全 → 首页 → 退出
    app.openCatDir();
    app.openBrowse({ type: 'tv', sel: { region: 'kr' } });
    app.browsePick({ id: 2, name: '鱿鱼游戏' });
    const seq = [run(), app.browse.open, run(), app.catDirOpen && !app.browse.open, run(), !app.catDirOpen, run()];
    ok(eq(seq, ['went_home', true, 'went_home', true, 'went_home', true, 'exit']), 'App 返回键经过分类大全:搜索结果 → 浏览页 → 大全 → 首页 → 退出', seq);
}

console.log('\n' + (fail ? 'FAILED' : 'ALL PASSED') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
