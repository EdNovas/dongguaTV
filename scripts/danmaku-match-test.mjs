// 弹幕匹配回归:node scripts/danmaku-match-test.mjs [--verbose]
//  ① 两个后端(server.js / api/index.js)的匹配函数群必须逐字一致
//  ② 规则单测:分档(精确/结构化等价/包含)、类型冲突、翻拍按年份、别的季、版本标签
//  ③ 真实数据回放:scripts/fixtures/danmaku/real-cases.json —— 每个用例是 我方剧名/分类/年份/集数 + danmu_api(360 源)真实候选
//     + 人工核对过的"正确候选"(核对时读了线上真实弹幕内容)。新排序的前 3 个候选必须都在正确集合里;正确集合为空时必须一个不选。
//     同时回放旧排序,列出新旧不同的用例(只报告,不判)。
//  ⑤ 腾讯综艺日期式集名(第20261010期 ↔ 腾讯"第1期上/第1期加更"):按腾讯那一天全部条目的 发布日期 + 时长 + 类别 认(单测)
//  ⑥ 真实回放:7 档腾讯综艺 × 资源站日期式集名 + 实测 m3u8 时长(qq-airdate-replay.json),认错必须为 0
//  ⑦ 前端:日期式集名的判定(须覆盖服务器的)与弹幕重载键(同一天不同条目要换键)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

// ---------- 从源码抽出纯函数(dandanToDplayer 之后到"⛔ 以下联网"标记之前是纯函数区) ----------
const norm = t => t.split('\r\n').join('\n');
function region(file) {
    const s = norm(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const a = s.indexOf('function danmakuCn2Num(');
    const b = s.indexOf('// ⛔ 以下联网(非纯函数)', a);
    if (a < 0 || b < 0) throw new Error('matching region not found in ' + file);
    return s.slice(a, b);
}
// 一致性覆盖到"取弹幕"函数末尾(按地址取/按 id 退回的条件、低置信标记都在里面)
function fullRegion(file) {
    const s = norm(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const a = s.indexOf('function danmakuCn2Num(');
    const f = s.indexOf('async function fetchDanmakuFromInstance(', a);
    const b = s.indexOf('\n}\n', f);
    if (a < 0 || f < 0 || b < 0) throw new Error('full region not found in ' + file);
    return s.slice(a, b + 2);
}
const srvCode = region('server.js'), apiCode = region('api/index.js');
console.log('① 两个后端一致');
ok(srvCode === apiCode, 'server.js 与 api/index.js 的弹幕匹配函数群不一致(改一处必须两处同步)');
ok(fullRegion('server.js') === fullRegion('api/index.js'), 'server.js 与 api/index.js 的 fetchDanmakuFromInstance 不一致');
{
    const ep = s => (norm(fs.readFileSync(path.join(ROOT, s), 'utf8')).match(/const \{ title, ep, hints, cacheKey \} = danmakuParseId\(req\.query\.id\);/g) || []).length;
    ok(ep('server.js') === 1 && ep('api/index.js') === 1, '两个后端的弹幕端点都用共用的 danmakuParseId');
}
const M = new Function(srvCode + '\nreturn { danmakuRankCandidates, pickDanmakuEpisode, danmakuKindOfOurs, danmakuKindOfCand, danmakuParseId, danmakuMarkers, danmakuQqPart, danmakuRaceVerdict, danmakuAirDated, danmakuQqParseList, danmakuQqVid, danmakuDurOk, danmakuTitleVariants, danmakuAirDateTarget, danmakuAirDateCompatible, danmakuAirDatePick, danmakuPoolQqCid };')();
{
    const P = M.danmakuParseId;
    let r = P('兰香如故|第01集|v5|k:tv|y:2025|n:36');
    ok(r.title === '兰香如故' && r.ep === '第01集' && r.hints.kind === 'tv' && r.hints.year === 2025 && r.hints.eps === 36 && r.cacheKey === '兰香如故|第01集|k:tv|y:2025', 'id 解析(v5 归一提示)');
    r = P('兰香如故|第01集|v4');
    ok(r.cacheKey === '兰香如故|第01集' && !r.hints.kind && !r.hints.year, '旧前端 v4 id 没有提示');
    r = P('王牌对王牌|第1期|v5|t:大陆综艺|y:2016');
    ok(r.cacheKey === '王牌对王牌|第1期|k:variety|y:2016', '只有资源站分类 t: 时按分类推断类型进缓存键');
    r = P('x|1|v5|k:hacker|y:1888|n:abc|t:' + 'a'.repeat(60) + '|zz:1');
    ok(!r.hints.kind && !r.hints.year && !r.hints.eps && !r.hints.type, '非法/超长提示一律忽略');
    r = P('三体|第1集|v5|k:amovie');
    ok(r.hints.kind === 'amovie' && r.cacheKey === '三体|第1集|k:amovie', '动画电影 amovie');
}
{
    // 前端 _danmakuKindOf 与服务器 danmakuKindOfOurs 同口径(前端把动画电影单列成 amovie,服务器当 movie)
    const html = norm(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));
    const a = html.indexOf('_danmakuKindOf(type) {');
    const b = html.indexOf('\n                },', a);
    ok(a > 0 && b > a, '找到前端 _danmakuKindOf');
    const body = html.slice(html.indexOf('{', a) + 1, b);
    const cli = new Function('type', body);
    const TYPES = ['国产剧', '内地剧', '大陆剧', '香港剧', '韩剧', '日剧', '欧美剧', '海外剧', '短剧', '现代都市', '穿越重生', '大陆综艺', '日韩综艺', '国产动漫', '日韩动漫', '中国动漫', '动画片', '动漫电影', '动作片', '喜剧片', '剧情片', '科幻片', '纪录片', '记录片', '战争片', '恐怖片', '爱情片', '电影', ''];
    const bad = TYPES.filter(t => { const c = cli(t) || null; const s = M.danmakuKindOfOurs(t, 1); return (c === 'amovie' ? 'movie' : c) !== s; });
    ok(!bad.length, '前后端类型映射一致,不一致的:' + bad.join(','));
}
const rank = (animes, title, hints) => M.danmakuRankCandidates(animes, title, hints);
const pickTitles = r => r.pool.slice(0, 3).map(a => a.animeTitle);

// 旧排序(本次改动前的内联逻辑,原样保留供对比)
function legacyRank(animes, title) {
    const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
    const stripFrom = s => String(s || '').replace(/\s+from\s+[a-z0-9_]+\s*$/i, '');
    const core = s => norm(String(stripFrom(s)).split(/[(（【\[]/)[0]);
    const normT = s => norm(stripFrom(s));
    const nt = norm(title), ct = core(title);
    const yearM = String(title).match(/(?:19|20)\d{2}/);
    const cn = t => { const m = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }; if (/^\d+$/.test(t)) return +t; if (t.length === 1) return m[t] || null; if (t[0] === '十') return 10 + (m[t[1]] || 0); if (t[1] === '十') return m[t[0]] * 10 + (m[t[2]] || 0); return null; };
    const seasonOf = s => { s = stripFrom(s); const m = s.match(/第\s*([0-9一二两三四五六七八九十]+)\s*季|season\s*0*(\d+)|\bS0*(\d{1,2})\b/i); if (m) return cn(m[1] || m[2] || m[3]); const t = s.match(/(?<![0-9])([2-9]|1[0-9])\s*$/); return t ? parseInt(t[1], 10) : null; };
    const wantSeason = seasonOf(title);
    const ctBase = wantSeason != null ? ct.replace(/([2-9]|1\d)$/, '') : ct;
    const ctNoYear = ct.replace(/((?:19|20)\d{2})\s*$/, '');
    const fitTier = a => {
        const c = core(a.animeTitle);
        if (!c) return 9;
        if (c === ct || normT(a.animeTitle) === nt) return 0;
        if (ctNoYear && ctNoYear !== ct && c === ctNoYear) return 1;
        if (c.includes(ct) || ct.includes(c) || (ctBase !== ct && ctBase && c.includes(ctBase)) || (ctNoYear !== ct && ctNoYear && (c.includes(ctNoYear) || ctNoYear.includes(c)))) return 2;
        return 9;
    };
    let candidates = animes.filter(a => fitTier(a) < 9);
    if (candidates.length > 1 && yearM) { const w = candidates.filter(a => String(a.animeTitle || '').includes(yearM[0])); if (w.length) candidates = w; }
    if (wantSeason != null && candidates.length) {
        const exact = candidates.filter(a => seasonOf(a.animeTitle) === wantSeason);
        if (exact.length) candidates = exact;
        else candidates = candidates.filter(a => { const s = seasonOf(a.animeTitle); return (s == null || s === wantSeason) && core(a.animeTitle) !== ctBase; });
    }
    const platOf = s => { const m = String(s || '').match(/from\s+([a-z0-9]+)/i); return m ? m[1].toLowerCase() : ''; };
    const PR = { iqiyi: 0, qq: 1, tencent: 1, youku: 2, bilibili: 3, mango: 4, imgo: 4, '360': 5, migu: 9 };
    candidates.sort((a, b) => (fitTier(a) - fitTier(b)) || ((PR[platOf(a.animeTitle)] ?? 6) - (PR[platOf(b.animeTitle)] ?? 6)));
    const bestTier = candidates.length ? fitTier(candidates[0]) : 9;
    return { pool: candidates.filter(a => fitTier(a) === bestTier), bestTier };
}

// ---------- ② 规则单测 ----------
console.log('② 规则单测');
const C = (t, y, cat, from) => ({ animeTitle: `${t}(${y})【${cat}】from ${from || '360'}`, type: cat, typeDescription: cat });
{
    // 季号写法不同:我方"第二季"↔候选"2"(旧版根本配不上)、我方"2"↔候选"第二季"
    const c = [C('庆余年', 2019, '电视剧'), C('庆余年2', 2024, '电视剧')];
    let r = rank(c, '庆余年第二季', { type: '国产剧', year: 2024, eps: 36 });
    ok(r.bestTier === 1 && pickTitles(r)[0].startsWith('庆余年2('), '庆余年第二季 → 庆余年2,高贴合 ' + JSON.stringify(r.why));
    ok(/庆余年\(2019\)/.test((legacyRank(c, '庆余年第二季').pool[0] || {}).animeTitle || ''), '(旧版对照:第二季配到了第一季 庆余年(2019))');
    ok(rank([C('庆余年', 2019, '电视剧')], '庆余年第二季').pool.length === 0, '没有提示、弹幕源只有第一季时:第二季一个不选');
    r = rank([C('庆余年', 2019, '电视剧'), C('庆余年第二季', 2024, '电视剧')], '庆余年2', { type: '国产剧', year: 2024 });
    ok(r.bestTier === 1 && /第二季/.test(pickTitles(r)[0]), '庆余年2 → 庆余年第二季 升为高贴合');
}
{
    // 我方没写季号 → 只配第一季,明确写着第 2 季以上的不要
    const c = [C('长相思 第二季', 2024, '电视剧')];
    ok(rank(c, '长相思', { type: '国产剧', year: 2023 }).pool.length === 0, '长相思(第一季) 不配 长相思 第二季');
    ok(legacyRank(c, '长相思').pool.length === 1, '(旧版对照:会配上第二季)');
    const c2 = [C('长相思 第一季', 2023, '电视剧'), C('长相思 第二季', 2024, '电视剧')];
    const r = rank(c2, '长相思', { type: '国产剧', year: 2023 });
    ok(r.bestTier === 1 && /第一季/.test(pickTitles(r)[0]) && r.pool.length === 1, '长相思 ↔ 长相思 第一季 高贴合');
    ok(rank([C('流浪地球2', 2023, '电影')], '流浪地球', { type: '科幻片', year: 2019, eps: 1 }).pool.length === 0, '流浪地球 不配 流浪地球2');
}
{
    // 电影 ↔ 综艺 硬冲突
    const c = [C('王牌对王牌', 1998, '电影'), C('王牌对王牌 第一季', 2016, '综艺'), C('王牌对王牌 第8季', 2023, '综艺')];
    const r = rank(c, '王牌对王牌', { type: '大陆综艺', year: 2016, eps: 12 });
    ok(r.pool.every(a => /综艺/.test(a.animeTitle)) && /第一季/.test(pickTitles(r)[0]), '综艺 王牌对王牌 不拿 1998 电影的弹幕 → ' + pickTitles(r).join(' / '));
    {   // 片名里的版本标记比分类可靠(苍兰诀（动画版）被标成内地剧)
        const cl = [C('苍兰诀', 2022, '动漫'), C('苍兰诀', 2022, '电视剧')];
        const ra = rank(cl, '苍兰诀（动画版）', { type: '内地剧', year: 2022, eps: 36 });
        ok(ra.pool.length === 1 && /动漫/.test(ra.pool[0].animeTitle), '苍兰诀（动画版）标成内地剧也取动画 → ' + pickTitles(ra).join(' / '));
        const rt = rank(cl, '苍兰诀（真人版）', { type: '国产动漫', year: 2022, eps: 56 });
        ok(rt.pool.length === 1 && /电视剧/.test(rt.pool[0].animeTitle), '苍兰诀（真人版）标成动漫也取电视剧');
    }
    const r2 = rank(c, '王牌对王牌', { type: '剧情片', year: 1998, eps: 1 });
    ok(r2.pool.length && r2.pool.every(a => /电影/.test(a.animeTitle)), '电影 王牌对王牌(1998) 只拿电影');
    ok(legacyRank(c, '王牌对王牌').pool.some(a => /电影/.test(a.animeTitle)), '(旧版对照:综艺会拿到电影)');
}
{
    // 翻拍按年份
    const c = [C('天龙八部 胡军版', 2003, '电视剧'), C('天龙八部 黄日华版', 1997, '电视剧'), C('天龙八部钟汉良版', 2013, '电视剧'), C('天龙八部', 2009, '综艺')];
    let r = rank(c, '天龙八部2003', { type: '国产剧', year: 2003, eps: 40 });
    ok(r.bestTier === 1 && /胡军版/.test(pickTitles(r)[0]) && r.pool.length === 1, '天龙八部2003 → 胡军版(2003) 高贴合 → ' + pickTitles(r).join(' / '));
    r = rank(c, '天龙八部', { type: '国产剧', year: 1997, eps: 45 });
    ok(/黄日华版/.test(pickTitles(r)[0]) && r.pool.length === 1, '天龙八部(1997 剧) → 黄日华版 → ' + pickTitles(r).join(' / '));
    r = rank(c, '天龙八部', { type: '国产剧', year: 2021, eps: 50 });
    ok(r.pool.length === 0, '天龙八部 2021 版(弹幕源没有)→ 一个不选,不拿别的版本: ' + pickTitles(r).join(' / '));
    r = rank([C('红楼梦', 1987, '电视剧'), C('红楼梦', 2010, '电视剧')], '红楼梦', { type: '国产剧', year: 2010, eps: 50 });
    ok(r.bestTier === 0 && /2010/.test(pickTitles(r)[0]) && r.pool.length === 1, '同名精确 红楼梦 按年份取 2010 版');
}
{
    // 版本标签
    const r = rank([C('狂飙 未删减版', 2023, '电视剧')], '狂飙', { type: '国产剧', year: 2023, eps: 39 });
    ok(r.bestTier === 1, '狂飙 ↔ 狂飙 未删减版 = 高贴合');
    const r2 = rank([C('狂飙兄弟', 2022, '电视剧')], '狂飙', { type: '国产剧', year: 2023, eps: 39 });
    ok(r2.bestTier === 2 || r2.pool.length === 0, '狂飙 ↔ 狂飙兄弟 至多低置信');
}
{
    // 类型推断
    const K = M.danmakuKindOfOurs;
    ok(K('剧情片', 1) === 'movie' && K('国产剧', 1) === 'tv' && K('大陆综艺', 10) === 'variety' && K('日韩动漫', 12) === 'anime' && K('动画片', 1) === 'movie', '分类 → 类型');
    ok(K('剧情片', 16) === 'movie' && K('', 30) === 'series' && K('', 1) === null && K('纪录片', 1) === null && K('现代都市', 40) === 'short' && K('动漫电影', 1) === 'movie', '分类优先于集数(有站把一部电影切成十几段)/ 无分类按集数 / 纪录片不判 / 短剧 / 动漫电影');
    // 没有提示(旧前端)时行为与旧版同档
    const c = [C('兰香如故', 2025, '电视剧'), C('兰香如故 特别篇', 2025, '综艺')];
    const r = rank(c, '兰香如故');
    ok(r.bestTier === 0 && /电视剧/.test(pickTitles(r)[0]), '无提示时照常精确匹配');
}

// ---------- ③ 真实数据回放 ----------
//   real-cases.json:调规则时用的 205 例;holdout-cases.json:规则写完后另采的 133 例(验证有没有过拟合)
for (const [FIXNAME, LABEL] of [['real-cases.json', '③ 真实数据回放'], ['holdout-cases.json', '④ 留出集回放']]) {
const FIX = path.join(ROOT, 'scripts/fixtures/danmaku', FIXNAME);
if (fs.existsSync(FIX)) {
    const cases = JSON.parse(fs.readFileSync(FIX, 'utf8'));
    console.log(`${LABEL}(${cases.length} 例)`);
    let newRight = 0, oldRight = 0, changed = 0, known = 0;
    for (const k of cases) {
        const hints = { type: k.ours && k.ours.type_name, year: k.ours && parseInt(k.ours.vod_year, 10) || undefined, eps: k.ours && k.ours.eps };
        const truth = new Set(k.truth || []);
        const judge = (pool) => truth.size ? (pool.length > 0 && pool.slice(0, 3).every(a => truth.has(a.animeTitle))) : pool.length === 0;
        const n = rank(k.candidates || [], k.title, hints);
        const o = legacyRank(k.candidates || [], k.title);
        const nOk = judge(n.pool), oOk = judge(o.pool);
        if (nOk) newRight++; if (oOk) oldRight++;
        const label = `${k.title} [${hints.type || '?'} ${hints.year || '?'} ${hints.eps || '?'}集]`;
        if (k.knownMiss) {   // 名字层面解决不了的(译名/改名/同名同年不同国别):不计失败,但每次都列出来
            known++;
            console.log(`   (已知) ${label}: 新排序选 ${JSON.stringify(pickTitles(n))},正确 ${JSON.stringify([...truth])} —— ${k.knownMiss}`);
            continue;
        }
        ok(nOk, `${label}: 新排序选 ${JSON.stringify(pickTitles(n))}(${n.why}),正确应为 ${JSON.stringify([...truth])}`);
        const differ = JSON.stringify(pickTitles(n)) !== JSON.stringify(o.pool.slice(0, 3).map(a => a.animeTitle));
        if (differ) changed++;
        if (VERBOSE || (differ && nOk !== oOk)) console.log(`   ${nOk ? '✓' : '✗'}新 ${oOk ? '✓' : '✗'}旧  ${label}\n      新: ${pickTitles(n).join(' / ') || '(不选)'}  [${n.why}]\n      旧: ${o.pool.slice(0, 3).map(a => a.animeTitle).join(' / ') || '(不选)'}`);
    }
    console.log(`   新排序正确 ${newRight}/${cases.length - known}(另 ${known} 例已知名字层面解决不了),旧排序正确 ${oldRight}/${cases.length},结果不同 ${changed} 例`);
} else console.log(LABEL + ' 跳过:没有 ' + path.relative(ROOT, FIX));
}

// ---------- ⑤ 腾讯综艺日期式集名:平台发布日期 + 时长 + 类别(单测,数据来自真实腾讯选集) ----------
console.log('⑤ 腾讯综艺日期式集名(发布日期 + 时长 + 类别)');
{
    const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/danmaku/qq-airdate-cases.json'), 'utf8'));
    const P = M.danmakuQqParseList(fx.qqPage);
    ok(P.items.length === 11 && P.items.filter(i => i.trailer).length === 1 && P.items.every(i => /^\d{8}$/.test(i.date) && i.dur > 0 && i.title) && !P.next,
        '解析腾讯选集页:11 集、1 个预告、都有日期/时长/标题、没有下一页(实际 ' + P.items.length + ')');
    ok(P.tabs.length && P.tabs.every(t => t.name && t.key) && !P.tabs.some(t => /^第\d+季$/.test(t.title)), '标签:只收带 chapter_name 的(别的季是别的 cid,不收)');
    const L = M.danmakuQqParseList(fx.qqPageLongShowBase);
    ok(L.tabs.length >= 10 && L.tabs.some(t => t.title.includes('2026')) && new Set(L.tabs.map(t => t.key)).size === L.tabs.length, '长寿综艺:分季标签按名字去重,实际 ' + L.tabs.length);
    const pg = { data: { module_list_datas: [{ module_datas: [{ module_params: { has_next: 'true', next_page_context: 'chapter_name=正片&list_page_context=p2' }, item_data_lists: { item_datas: [
        { item_params: { vid: 'a1', title: '第1期上：x', publish_date: '2026-10-10 00:00:00', duration: '100', is_trailer: '0' } },
        { item_params: { title: '纯享', page_context: 'chapter_name=纯享&x=1' } }, { item_params: { title: '纯享', page_context: 'chapter_name=纯享&x=2' } },
        { item_params: { title: '特辑', page_context: 'chapter_name=2026秋&sub_chapter_name=特辑' } },
        { item_params: { title: '第2季', page_context: 'cid=other&id_type=1' } }] } }] }] } };
    const PG = M.danmakuQqParseList(pg);
    ok(PG.next === 'chapter_name=正片&list_page_context=p2' && PG.tabs.length === 2 && PG.tabs[1].sub === '特辑' && PG.items[0].dur === 100, '分页 next;同名标签只留一个;子标签认 sub_chapter_name;别的季不收');
    ok(JSON.stringify(M.danmakuQqVid('https://v.qq.com/x/cover/mzc002001bk7moh/v4102k0g66u.html?traceid=12_360')) === '{"cid":"mzc002001bk7moh","vid":"v4102k0g66u"}'
        && !M.danmakuQqVid('https://www.iqiyi.com/v_19rr.html') && !M.danmakuQqVid('local:1'), '腾讯地址 → cid/vid,别的地址不认');
    ok(M.danmakuDurOk(5474, 5417) && M.danmakuDurOk(9716, 9959) && M.danmakuDurOk(1640, 1598) && M.danmakuDurOk(600, 551)
        && !M.danmakuDurOk(4003, 4649) && !M.danmakuDurOk(1676, 5417) && !M.danmakuDurOk(239, 2286) && !M.danmakuDurOk(0, 100), '时长窗口');
    // 季号换写法
    const V = t => JSON.stringify(M.danmakuTitleVariants(t));
    ok(V('现在就出发第四季') === '["现在就出发第4季","现在就出发 第4季"]' && V('奔跑吧第十季') === '["奔跑吧第10季","奔跑吧 第10季"]'
        && V('开始推理吧 第4季') === '["开始推理吧第四季"]' && V('种地吧4') === '["种地吧第4季"]' && V('毛雪汪') === '[]' && V('第一季') === '[]', '季号换写法');
    // 要找哪一天
    const TG = M.danmakuAirDateTarget;
    ok(TG('第20261010期', '2026') === '20261010' && TG('2026-10-17', null) === '20261017' && TG('第261018期', null) === '20261018' && TG('2026年10月11日', null) === '20261011'
        && TG('1020期', '2026') === '20261020' && TG('1020期', null) === '' && TG('第1-2期', '2026') === '' && TG('第3集', '2026') === '' && TG('20260803第1期上纯享', '2026') === '20260803', '日期式集名 → 发布日期');
    // 类别相容:纯享对纯享、陪看对陪看;加更不算(资源站按日期命名时不写加更);两边都写了第N期就得是同一期
    const CP = M.danmakuAirDateCompatible;
    ok(CP('第20261012期', '第1期加更') === 2 && CP('第20261010期纯享', '第1期上·慢速目击证人纯享') === 2 && CP('第20261010期', '第1期上·慢速目击证人纯享') === 1 && !CP('第20261010期纯享', '第1期上')
        && CP('第20261010期捣蛋', '第1期上·捣蛋鱼医生纯享') === 1 && CP('20260907第7期上纯享', '第6期上纯享') === -1
        && CP('20261010第1期下纯享', '第1期上·慢速目击证人纯享') === -1 && CP('第20261017期纯享上', '第2期上·二指追击战纯享') === 2 && CP('第20261005期下', '心动的旅行中') === -1
        && CP('20260518加更', '超越目标坞民第1期下') <= 0 && CP('第20261012期', '第1期加更') === 2 && CP('20260803第1期上纯享', '【qq】 第1期上纯享：晚宴现场')
        && CP('第20261015期', '第1期花絮特辑') === 1 && !CP('第20261010期纯享', '第5期陪看') && CP('第20261024期预告', '预告') === 2, '类别相容:2 严格 / 1 宽松(我方没写类别词)/ 0 不相容');
    // 现成的一天:腾讯《现在就出发第四季》10-10 三条(正片 + 两条纯享)
    const day = [{ vid: 'r4102opm7x3', date: '20261010', dur: 5417, title: '第1期上' }, { vid: 's41027w41r0', date: '20261010', dur: 1676, title: '第1期上·慢速目击证人纯享' }, { vid: 'i4102wwwubm', date: '20261010', dur: 2121, title: '第1期上·捣蛋鱼医生纯享' }];
    const PK = (d, ep, dur, py = '2026') => { const r = M.danmakuAirDatePick(d, ep, py, dur); return r ? r.vid : null; };
    ok(PK(day, '20261010第1期下纯享', 1642) === null, '错标日期的下半纯享(1642s,腾讯 10-11 的那条)不配到 10-10 的上半纯享');
    ok(PK(day, '第20261010期', 5474) === 'r4102opm7x3' && PK(day, '第20261010期纯享', 1696) === 's41027w41r0' && PK(day, '第20261010期捣蛋', 2159) === 'i4102wwwubm'
        && PK(day, '第20261010期', 0) === null && PK(day, '第20261010期', 3000) === null && PK(day, '第20251010期', 5474) === null,
        '10-10:正片配正片、纯享配那条纯享(不在 danmu_api 列表也行)、捣蛋(那天只有那条纯享对得上)配捣蛋鱼医生纯享、没时长/时长不对/年份不对不配');
    // 两半时长差几十秒:按我方写的拆分认(资源站插广告会把时长拉长,"哪条更近"靠不住;对抗审查用去广告后的时长核对过 ffzy 这条就是加更上)
    const halves = [{ vid: 'u', date: '20260709', dur: 1588, title: '第6期加更上' }, { vid: 'd', date: '20260709', dur: 1609, title: '第6期加更下' }];
    ok(PK(halves, '第20260709期上', 1609) === 'u' && PK(halves, '第20260709期下', 1609) === 'd' && PK(halves, '第20260709期', 1609) === null, '两半差 21s:按拆分认;没写拆分不认');
    ok(M.danmakuAirDateTarget('2011-05期', null) === '' && M.danmakuAirDateTarget('201801.06期', null) === '20180106', '月刊式 2011-05期 不当 2020-11-05;201801.06期 照旧是 2018-01-06');
    const trip = [{ vid: 'a', date: '20261005', dur: 3961, title: '第10期中' }, { vid: 'b', date: '20261005', dur: 3965, title: '心动的旅行中' }];
    ok(PK(trip, '20261005第10期中', 3961) === 'a', '拆分一致的有几条:我方写了第N期只认同一期');
    const twins = [{ vid: 'z', date: '20260720', dur: 2139, title: '第10期中' }, { vid: 'x', date: '20260720', dur: 2138, title: '第10期下' }];
    ok(PK(twins, '第20260720期下', 2175) === 'x' && PK(twins, '第20260720期中', 2176) === 'z' && PK(twins, '第20260720期', 2175) === null, '两半几乎一样长:按拆分认;没写拆分不认');
    // 同一天两条几乎一样长 → 分不开
    ok(PK([{ vid: 'a', date: '20261010', dur: 3000, title: '第1期' }, { vid: 'b', date: '20261010', dur: 3003, title: '第1期' }], '第20261010期', 3050) === null, '同一天两条几乎一样长 → 不认');
    // 离得最近的那条类别不相容 → 不认(防"资源站把纯享按日期命名"拿到正片)
    ok(PK([{ vid: 'a', date: '20261010', dur: 3009, title: '第5期中' }, { vid: 'b', date: '20261010', dur: 2958, title: '第5期上纯享' }], '第20261010期', 2958) === null, '最近的是纯享而我方没写纯享 → 不认');
    // 上/中/下:期/集/日期后面(可隔着 纯享/加更…);平台标题末尾的也算
    const QP = M.danmakuQqPart;
    ok(QP('第1期下纯享') === '下' && QP('第20261017期纯享上') === '上' && QP('第6期加更上') === '上' && QP('20260601上') === '上' && QP('第10期中（上）') === '中'
        && QP('第20261010期') === '' && QP('心动的旅行中') === '' && QP('心动的旅行中', true) === '中' && QP('先导片上', true) === '上', '上/中/下 识别');
    // 月刊式(2026-03期)不是某一天
    ok(M.danmakuAirDateTarget('2026-03期', '2026') === '' && M.danmakuAirDateTarget('第2025-12期', null) === '', '月刊式集名不当日期');
    // 多实例赛跑:腾讯给了结论就以它为准;日期式请求里旧规则的结果等全部回来、被 _veto 否掉
    const RV = M.danmakuRaceVerdict, arr = (o, n = 3) => Object.assign(Array(n).fill([0, 0, 0, '', 'x']), o);
    ok(RV(arr({ _oracle: true, _tier: 0 }), true) === 'finish' && RV(Object.assign([], { _veto: true }), true) === 'veto' && RV(arr({ _tier: 0 }), true) === 'holdAll'
        && RV(arr({ _tier: 0 }), false) === 'finish' && RV(arr({ _tier: 2 }), false) === 'hold' && RV([], true) === '' && RV(null, false) === '', '赛跑取舍');
    ok(M.danmakuAirDated('现在就出发第四季', '第20261010期', { dur: 5474 }) && !M.danmakuAirDated('现在就出发第四季', '第20261010期', {}) && !M.danmakuAirDated('x', '第3集', { dur: 2700 })
        && M.danmakuAirDated('x', '1020期', { dur: 1600, year: 2026 }) && !M.danmakuAirDated('x', '1020期', { dur: 1600 }), '哪些请求走腾讯认集');
    // 候选里腾讯 cid:优先腾讯自己的候选
    const pool = [{ animeTitle: 'x(2026)【综艺】from 360', episodes: [{ url: 'https://v.qq.com/x/cover/other/a.html' }, { url: 'https://v.qq.com/x/cover/other/b.html' }] },
        { animeTitle: 'x(2026)【综艺】from tencent', episodes: [{ url: 'https://v.qq.com/x/cover/mine/c.html' }] }, { animeTitle: 'x【综艺】from aiyifan', episodes: [{ url: 'https://www.yfsp.tv/play/1' }] }];
    ok(M.danmakuPoolQqCid(pool) === 'mine' && M.danmakuPoolQqCid(pool.slice(0, 1)) === 'other' && M.danmakuPoolQqCid(pool.slice(2)) === '', '候选里的腾讯 cid');
    // id 的 d: 时长提示;缓存键:日期式 + 时长才带时长档,其余与以前一模一样
    let r = M.danmakuParseId('现在就出发第四季|第20261020期|v5|k:variety|y:2026|n:14|d:1598');
    const bk = d => Math.round(Math.log(d) / Math.log(1.04));
    ok(r.hints.dur === 1598 && r.cacheKey === '现在就出发第四季|第20261020期|k:variety|y:2026|qd' + bk(1598), '日期式集名 + 时长 → 缓存键带时长档');
    ok(M.danmakuParseId('现在就出发第四季|第20261020期|v5|k:variety|y:2026').cacheKey === '现在就出发第四季|第20261020期|k:variety|y:2026'
        && M.danmakuParseId('兰香如故|第01集|v5|d:2700').cacheKey === '兰香如故|第01集' && M.danmakuParseId('x|1020期|v5|d:1600').cacheKey === 'x|1020期',
        '不带时长 / 非日期式 / 4 位月日没年份:缓存键与以前一样');
    ok(M.danmakuParseId('x|第20261010期|v5|y:2026|d:5474').cacheKey !== M.danmakuParseId('x|第20261010期|v5|y:2026|d:1696').cacheKey, '同名不同剪辑(时长差得多)各存各的');
    ok(!M.danmakuParseId('x|1|v5|d:abc').hints.dur && !M.danmakuParseId('x|1|v5|d:12').hints.dur && !M.danmakuParseId('x|1|v5|d:123456').hints.dur, '非法时长提示忽略');
}

// ---------- ⑥ 真实回放:7 档腾讯综艺 × 资源站(日期式集名 + 实测 m3u8 时长) ----------
//   夹具 scripts/fixtures/danmaku/qq-airdate-replay.json:腾讯各标签全量 + 资源站集名与实测时长(对抗审查实测)。
//   真值:时长精准的站(bdzy/wujinys,与腾讯差 0–1s)= 前后 7 天内与我方时长差 ≤2s 的那条腾讯条目(与日期无关,独立于认集规则;
//   错标日期的资源这样会被判错);其余站 = 那天时长离我方最近的那条/那组(差 <5s),或拆分标签(上/中/下)一致且时长在窗口内的。
//   认出来的必须就是真值(错 = 0);只统计"没认"的数量(宁可没弹幕)。认集逻辑本身也拿"最近那条"做准,所以这里主要防:
//   类别相容 / 期号 / 年份 / 时长窗口这些规则把对的拒掉太多(数字往下掉就是回归),以及误把别的条目当成它。
console.log('⑥ 真实回放(腾讯综艺 × 资源站,日期 + 时长)');
{
    const RF = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/danmaku/qq-airdate-replay.json'), 'utf8'));
    let right = 0, wrong = 0, none = 0, noTruth = 0, n = 0;
    const wrongs = [];
    for (const show of RF.shows) {
        const items = show.items.map(([vid, date, dur, tr, title]) => ({ vid, date, dur, trailer: !!tr, title }));
        for (const site of show.sites) {
            const yearM = String(site.title).match(/(?:19|20)\d{2}/);
            const py = yearM ? yearM[0] : (site.year ? String(site.year) : null);
            for (const [name, res] of site.rows) {
                const target = M.danmakuAirDateTarget(name, py);
                if (!target) continue;
                n++;
                const sameDay = items.filter(it => it.date === target).sort((a, b) => Math.abs(res - a.dur) - Math.abs(res - b.dur));
                const exactSite = site.site === 'bdzy' || site.site === 'wujinys';
                const dd = (a, b) => Math.abs(Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8)) - Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8))) / 864e5;
                const exact = exactSite ? items.filter(it => Math.abs(it.dur - res) <= 2 && dd(it.date, target) <= 7) : [];
                const g0 = sameDay.length ? Math.abs(res - sameDay[0].dur) : 0;
                const group = sameDay.length && M.danmakuDurOk(res, sameDay[0].dur) ? sameDay.filter(it => Math.abs(res - it.dur) - g0 <= 5) : [];
                if (!group.length) noTruth++;
                const pick = M.danmakuAirDatePick(sameDay, name, py, res);
                if (!pick) { none++; continue; }
                const sp = M.danmakuMarkers(name).split, spOf = it => M.danmakuMarkers(String(it.title)).split;
                const part = M.danmakuQqPart;
                const ok1 = exactSite && exact.length === 1 ? pick.vid === exact[0].vid
                    : (group.includes(pick) && (group.length === 1 || (sp && spOf(pick) === sp))) || (!exactSite && part(name) && part(String(pick.title), true) === part(name) && M.danmakuDurOk(res, pick.dur));
                if (ok1) right++;
                else { wrong++; wrongs.push(`${show.show}/${site.site} ${name}(${res}s) → ${pick.title}(${pick.dur}s),时长最近的 ${group.map(x => x.title + '(' + x.dur + 's)').join(' / ') || '无'}`); }
            }
        }
    }
    console.log(`   日期式 ${n} 条:认对 ${right} / 认错 ${wrong} / 没认 ${none}(其中腾讯那天根本没有时长对得上的 ${noTruth})`);
    for (const w of wrongs) console.log('   ✗ ' + w);
    ok(wrong === 0, `一条都不能认错(错 ${wrong})`);
    ok(right >= 645, `认对的数量不能退步(现在 ${right},基线 649)`);
}

// ---------- ⑦ 前端:日期式集名的判定与弹幕重载键 ----------
console.log('⑦ 前端(日期式集名判定 / 弹幕重载键)');
{
    const html = norm(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));
    const rm = html.match(/const _dmDatedRe = (\/.+\/);\n/);
    ok(!!rm, '找到前端 _dmDatedRe');
    const RE = rm ? new Function('return ' + rm[1])() : /$^/;
    // 服务器认作日期式的集名,前端必须也认(否则那集永远不带时长、腾讯综艺日期式认集用不上)
    const names = new Set();
    const RF = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/danmaku/qq-airdate-replay.json'), 'utf8'));
    for (const s of RF.shows) for (const site of s.sites) for (const [n] of site.rows) names.add(n);
    for (const n of JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/danmaku/qq-airdate-cases.json'), 'utf8')).ours) names.add(n);
    ['第0624期', '0624期', '6月24日', '2017年7月1日', '2026-03期', '第261018期', '2026.10.17', '20260803第1期上纯享', '20261010(第1期上)'].forEach(n => names.add(n));
    const miss = [...names].filter(n => M.danmakuMarkers(n).date && !RE.test(n));
    ok(!miss.length, `服务器认作日期的集名前端都要等时长(漏了 ${miss.length}:${miss.slice(0, 5).join(' ')})`);
    ok(!RE.test('第12集') && !RE.test('第3期') && !RE.test('EP05') && !RE.test('正片') && !RE.test('1080P'), '普通集名不等时长');
    ok(!/\(\?<[=!]/.test(rm ? rm[1] : ''), '_dmDatedRe 不用后行断言(旧 iOS Safari)');
    // 弹幕重载键:日期式集名带上日期之外的文字;写法不同的同一条仍同键;普通集名照旧
    const a = html.indexOf('_danmakuKey() {');
    const b = html.indexOf('\n                },', a);
    const body = html.slice(html.indexOf('{', a) + 1, b);
    const keyOf = epName => new Function(body).call({ currentGroup: { name: 'X' }, episodeList: [{ url: 'u', name: epName }], currentUrl: 'u' });
    const same = (p, q) => keyOf(p) === keyOf(q);
    ok(same('第20261010期', '20261010') && same('第20261010期', '2026-10-10') && same('第20261010期', '2026年10月10日'), '同一天写法不同 → 同键');
    ok(!same('第20261010期', '第20261010期捣蛋') && !same('第20261010期', '第20261010期纯享') && !same('第20261017期纯享上', '第20261017期纯享下')
        && !same('20261010第1期上', '20261010第1期下') && !same('第20261010期', '第20261011期') && !same('20261012(加更第1期)', '20261012(第1期加更)'), '同一天不同条目 → 不同键');
    ok(same('第06集', '6') && same('第6集 幕后黑手', '第6集') && !same('第1期上', '第1期下') && !same('第0624期', '第624期'), '普通集名的键与以前一致');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
