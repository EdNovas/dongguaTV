// 弹幕匹配回归:node scripts/danmaku-match-test.mjs [--verbose]
//  ① 两个后端(server.js / api/index.js)的匹配函数群必须逐字一致
//  ② 规则单测:分档(精确/结构化等价/包含)、类型冲突、翻拍按年份、别的季、版本标签
//  ③ 真实数据回放:scripts/fixtures/danmaku/real-cases.json —— 每个用例是 我方剧名/分类/年份/集数 + danmu_api(360 源)真实候选
//     + 人工核对过的"正确候选"(核对时读了线上真实弹幕内容)。新排序的前 3 个候选必须都在正确集合里;正确集合为空时必须一个不选。
//     同时回放旧排序,列出新旧不同的用例(只报告,不判)。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

// ---------- 从源码抽出纯函数(dandanToDplayer 之后到"从【一个 danmu_api 实例】"之前是纯函数区) ----------
const norm = t => t.split('\r\n').join('\n');
function region(file) {
    const s = norm(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const a = s.indexOf('function danmakuCn2Num(');
    const b = s.indexOf('// 从【一个 danmu_api 实例】取某剧某集弹幕', a);
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
const M = new Function(srvCode + '\nreturn { danmakuRankCandidates, pickDanmakuEpisode, danmakuKindOfOurs, danmakuKindOfCand, danmakuParseId };')();
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

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
