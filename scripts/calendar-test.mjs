#!/usr/bin/env node
// 📅 追剧日历(lib/update-calendar)回归(离线、零网络,内存 SQLite + 假资源站):
//   node scripts/calendar-test.mjs
//  ① 分类 / 集数 / 日期这些纯函数
//  ② tick:两个站拉「最近更新」→ 按北京日期归天、按片名去重(n = 几个站)、伦理/体育/老电影/不雅片名不收、第一次跑不标「新上」
//  ③ week / list 输出;没有 sqlite 时整块关掉
// 改 lib/update-calendar 后必跑。
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };
const Database = dep('better-sqlite3');
const { createCalendar } = require(path.join(ROOT, 'lib/update-calendar'));
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

const NOW = Date.UTC(2026, 10, 26, 12, 0);   // 北京时间 2026-11-26 20:00(周四)
const CLASSES = [
    { type_id: 1, type_pid: 0, type_name: '电影' }, { type_id: 2, type_pid: 0, type_name: '连续剧' }, { type_id: 3, type_pid: 0, type_name: '综艺' },
    { type_id: 4, type_pid: 0, type_name: '动漫' }, { type_id: 6, type_pid: 1, type_name: '动作片' }, { type_id: 7, type_pid: 1, type_name: '伦理片' },
    { type_id: 13, type_pid: 2, type_name: '国产剧' }, { type_id: 20, type_pid: 0, type_name: '短剧' }, { type_id: 30, type_pid: 0, type_name: '体育赛事' },
    { type_id: 40, type_pid: 0, type_name: '纪录片' },
];
const V = (name, type_id, time, extra) => Object.assign({ vod_name: name, type_id, vod_time: time, vod_remarks: '', vod_pic: 'https://img/' + encodeURIComponent(name) + '.jpg', vod_year: '2026', vod_area: '大陆' }, extra || {});
function fakeSite(lists) {
    let calls = 0;
    const get = async (url) => {
        calls++;
        if (/ac=list/.test(url)) return JSON.stringify({ class: CLASSES });
        const pg = +(/pg=(\d+)/.exec(url) || [0, 1])[1];
        const list = lists[pg - 1] || [];
        return { list, pagecount: lists.length, page: pg };
    };
    return { get, calls: () => calls };
}

console.log('① 纯函数');
{
    const c = createCalendar({ db: () => null, sites: () => [], httpGet: async () => ({}) });
    const cat = c._catOf;
    const cases = [['连续剧', '国产剧', 'tv'], ['', '欧美剧', 'tv'], ['电影', '动作片', 'movie'], ['电影', '动漫电影', 'anime'], ['', '大陆综艺', 'variety'], ['', '日韩动漫', 'anime'],
        ['', '纪录片', 'doc'], ['', '短剧', 'short'], ['连续剧', '爽文短剧', 'short'], ['电影', '伦理片', null], ['', '体育赛事', null], ['', 'NBA', null], ['', '预告片', null], ['', '未知', null]];
    for (const [p, t, want] of cases) ok(cat(p, t) === want, `catOf(${p || '-'}, ${t}) = ${want}`, cat(p, t));
    const ep = c._epOf;
    for (const [r, want] of [['更新至第16集', 16], ['更新至16集', 16], ['全30集', 30], ['第20261126期', 20261126], ['16集全', 16], ['HD', 0], ['', 0]]) ok(ep(r) === want, `epOf(${r || '空'}) = ${want}`, ep(r));
    ok(c._mondayOf('2026-11-26') === '2026-11-23' && c._mondayOf('2026-11-23') === '2026-11-23' && c._mondayOf('2026-11-29') === '2026-11-23', 'mondayOf:周四/周一/周日 → 当周周一');
    ok(c.week('2026-11-26') === null && c.list('2026-11-26', 'tv') === null, '没有 sqlite:week / list 返回 null(接口回 enabled:false)');
}

console.log('② tick');
const db = new Database(':memory:');
let now = NOW;
const A = fakeSite([[
    V('繁花', 13, '2026-11-26 09:10:00', { vod_remarks: '更新至第12集' }),
    V('繁花', 13, '2026-11-25 22:00:00', { vod_remarks: '更新至第11集' }),
    V('奔跑吧', 3, '2026-11-26 11:00:00', { vod_remarks: '第20261126期' }),
    V('某伦理片', 7, '2026-11-26 10:00:00', { type_id_1: 1 }),
    V('老电影', 6, '2026-11-26 10:00:00', { vod_year: '1999', type_id_1: 1 }),
    V('新电影', 6, '2026-11-26 10:30:00', { vod_year: '2025', type_id_1: 1 }),
    V('球赛', 30, '2026-11-26 10:00:00'),
], [
    V('霸道总裁爱上我', 20, '2026-11-26 08:00:00', { vod_remarks: '全80集' }),
    V('坏时间', 13, 'not a date'),
    V('', 13, '2026-11-26 08:00:00'),
]]);
const B = fakeSite([[
    V('繁花 ', 13, '2026-11-26 10:20:00', { vod_remarks: '更新至第13集', vod_pic: 'https://b/x.jpg' }),
    V('地球脉动', 40, '2026-11-24 08:00:00', { vod_remarks: '全6集' }),
]]);
const gets = { a: A.get, b: B.get };
const cal = createCalendar({
    db: () => db, now: () => now,
    sites: () => [{ key: 'a', api: 'https://a.example/api.php/provide/vod' }, { key: 'b', api: 'https://b.example/api.php/provide/vod/' }],
    httpGet: (url) => gets[/a\.example/.test(url) ? 'a' : 'b'](url),
    opts: { pageGapMs: 0 },
});
await cal.tick();
{
    const w = cal.week('2026-11-26', 24);
    const tv = w.cats.tv.items;
    ok(w.today === '2026-11-26' && w.day === '2026-11-26' && w.monday === '2026-11-23' && w.prev === '2026-11-16' && w.next === '2026-11-30' && w.days.length === 7, 'week:今天 / 周一 / 上周 / 下周 / 7 天', w);
    ok(tv.length === 1 && tv[0].title === '繁花' && tv[0].n === 2 && tv[0].remarks === '更新至第13集' && tv[0].ep === 13, '同一部两个站都更新(片名多个空格也算同一部):一条,n=2,备注取集数大的', tv);
    ok(tv[0].pic === 'https://img/%E7%B9%81%E8%8A%B1.jpg', '封面留先收到的那张');
    ok(tv[0].t === Date.UTC(2026, 10, 26, 2, 20), '更新时间取最晚的(北京 10:20)', tv[0].t);
    ok(w.cats.variety.items.map(x => x.title).join() === '奔跑吧' && w.cats.variety.items[0].ep === 20261126, '综艺:日期式期数');
    ok(w.cats.movie.items.map(x => x.title).join() === '新电影', '电影:只收近两年的,伦理片不收');
    ok(w.cats.short.n === 1 && w.cats.anime.n === 0, '短剧单独一类;别的分类没有就是 0');
    const d26 = w.days.find(x => x.day === '2026-11-26'), d25 = w.days.find(x => x.day === '2026-11-25'), d24 = w.days.find(x => x.day === '2026-11-24');
    ok(d26.total === 3 && d26.counts.short === 1 && d25.total === 1 && d24.counts.doc === 1, '每天的数量(total 不算短剧)', [d26, d25, d24]);
    ok(w.days.filter(x => x.future).map(x => x.day).join() === '2026-11-27,2026-11-28,2026-11-29', '今天以后的标 future');
    ok(w.oldest === '2026-11-24', 'oldest = 最早有数据的那天(刚部署只有几天数据时「上一周」翻不到空白周)', w.oldest);
    ok(!tv[0].isNew && !w.cats.variety.items[0].isNew, '第一次跑:全部当以前就有,不标「新上」');
    ok(db.prepare('SELECT count(*) AS c FROM cal_seen').get().c === 5 && db.prepare("SELECT last_day FROM cal_seen WHERE nk = '繁花'").get().last_day === '2026-11-26', '首轮那批「以前就有」的记录清理时没被删掉(否则下一轮又当首轮、永远不出「新上」)');
    const st = cal.status();
    ok(st.enabled && st.sites.length === 2 && st.sites.every(s => s.last_ok === NOW && !s.last_err), 'status:两个站都拉成功', st);
}
{
    // 第二轮:a 站多了一部没见过的新剧 → 那天标「新上」;已见过的照旧
    now = NOW + 31 * 60e3;
    A.get = undefined;
    gets.a = fakeSite([[V('新剧来了', 13, '2026-11-26 20:15:00', { vod_remarks: '更新至第2集' }), V('繁花', 13, '2026-11-26 20:20:00', { vod_remarks: '更新至第14集' })]]).get;
    gets.b = fakeSite([[]]).get;
    await cal.tick();
    const w = cal.week('2026-11-26', 24);
    const by = Object.fromEntries(w.cats.tv.items.map(x => [x.title, x]));
    ok(by['新剧来了'] && by['新剧来了'].isNew === true && by['繁花'].isNew === false && by['繁花'].ep === 14, '第二轮:没见过的新剧标「新上」,繁花更新到 14 集', w.cats.tv.items);
    ok(w.cats.tv.items[0].title === '繁花', '排序:几个站都更新的在前', w.cats.tv.items.map(x => x.title));
    const l1 = cal.list('2026-11-26', 'tv', 0, 1), l2 = cal.list('2026-11-26', 'tv', 1, 1);
    ok(l1.total === 2 && l1.items.length === 1 && l2.items.length === 1 && l1.items[0].title !== l2.items[0].title, 'list:分页', [l1, l2]);
    ok(cal.list('2026-11-26', 'nope').total === 0 && cal.list('bad', 'tv').total === 0, 'list:分类 / 日期不对 → 空');
    // 很久以前首次出现、一直在更新的长剧:清理按最近更新日期,不会被忘掉又变「新上」
    db.prepare("INSERT OR REPLACE INTO cal_seen (nk, first_day, last_day) VALUES ('长寿综艺', '2025-01-01', '2026-11-20')").run();
    db.prepare("INSERT OR REPLACE INTO cal_seen (nk, first_day, last_day) VALUES ('早停播了', '2025-01-01', '2025-02-01')").run();
    // 站点失败:记下错误,不影响别的站、不清已有数据
    gets.a = async () => { throw new Error('boom'); };
    now += 31 * 60e3;
    await cal.tick();
    const st = cal.status();
    ok(st.sites.find(s => s.site === 'a').last_err === 'boom' && cal.week('2026-11-26', 24).cats.tv.n === 2, '站点拉取失败:记错误,数据还在', st.sites);
    const seen = new Set(db.prepare('SELECT nk FROM cal_seen').all().map(r => r.nk));
    ok(seen.has('长寿综艺') && !seen.has('早停播了'), '清理:首播早但最近还在更新的留着,半年多没更新的忘掉', [...seen]);
    // 老库(cal_seen 没有 last_day 列)能自己补列
    const old = new Database(':memory:');
    old.exec("CREATE TABLE cal_seen (nk TEXT PRIMARY KEY, first_day TEXT NOT NULL) WITHOUT ROWID; INSERT INTO cal_seen VALUES ('x', '2026-11-01');");
    const c2 = createCalendar({ db: () => old, now: () => NOW, sites: () => [], httpGet: async () => ({}) });
    ok(c2.week('2026-11-26') && old.prepare('PRAGMA table_info(cal_seen)').all().some(c => c.name === 'last_day'), '老库自动补 last_day 列');
    old.close();
}
db.close();

console.log('④ 今天以后:TMDB 排期 + 按规律预计');
{
    const db = new Database(':memory:');
    let now = NOW;   // 北京 2026-11-26 20:00 周四
    const ep = (n, d) => ({ episode_number: n, air_date: d });
    const SHOWS = {
        1: { name: '两京十五日', origin_country: ['CN'], genres: [{ id: 18 }], popularity: 50, poster_path: '/a.jpg', first_air_date: '2026-11-10',
            next_episode_to_air: { air_date: '2026-11-27', season_number: 1, episode_number: 13 },
            season: [ep(11, '2026-11-26'), ep(12, '2026-11-26'), ep(13, '2026-11-27'), ep(14, '2026-11-27'), ep(15, '2026-11-28'), ep(16, '2026-12-20')] },
        2: { name: '你好，星期六', origin_country: ['CN'], genres: [{ id: 10764 }], popularity: 30, next_episode_to_air: { air_date: '2026-11-28', season_number: 5, episode_number: 46 }, season: [ep(46, '2026-11-28')] },
        3: { name: '新剧来了', origin_country: ['CN'], genres: [{ id: 18 }], popularity: 5, next_episode_to_air: { air_date: '2026-11-29', season_number: 1, episode_number: 1 }, season: [ep(1, '2026-11-29'), ep(2, '2026-11-29')] },
        4: { name: 'No Chinese Title', origin_country: ['CN'], genres: [{ id: 18 }], popularity: 99, next_episode_to_air: { air_date: '2026-11-27', season_number: 1, episode_number: 3 }, season: [ep(3, '2026-11-27')] },
        5: { name: '塔尔萨之王', origin_country: ['US'], genres: [{ id: 18 }], popularity: 900, next_episode_to_air: { air_date: '2026-11-27', season_number: 3, episode_number: 1 }, season: [ep(1, '2026-11-27')] },
        6: { name: '晚间新闻', origin_country: ['CN'], genres: [{ id: 10763 }], popularity: 80, next_episode_to_air: { air_date: '2026-11-27', season_number: 1, episode_number: 9 }, season: [ep(9, '2026-11-27')] },
        7: { name: '已完结的剧', origin_country: ['CN'], genres: [{ id: 18 }], popularity: 70, next_episode_to_air: null, season: [] },
        8: { name: '粤语教程', origin_country: ['CN'], genres: [{ id: 10762 }], popularity: 60, next_episode_to_air: { air_date: '2026-11-27', season_number: 1, episode_number: 5 }, season: [ep(5, '2026-11-27')] },
        9: { name: '加冕街', origin_country: ['GB'], genres: [{ id: 18 }, { id: 10766 }], popularity: 300, next_episode_to_air: { air_date: '2026-11-27', season_number: 67, episode_number: 222 }, season: [ep(222, '2026-11-27')] },
        10: { name: '株式会社スターダム', origin_country: ['JP'], genres: [{ id: 18 }], popularity: 400, next_episode_to_air: { air_date: '2026-11-28', season_number: 1, episode_number: 110 }, season: [ep(110, '2026-11-28')] },
        11: { name: '哥伦比亚电视小说', origin_country: ['CO'], genres: [{ id: 18 }], popularity: 90, next_episode_to_air: { air_date: '2026-11-28', season_number: 1, episode_number: 14 }, season: [ep(14, '2026-11-28')] },
    };
    let discover = { CN: [1, 2, 3, 4, 6, 7, 8], US: [5, 11], GB: [9], JP: [10] }, tvFail = false, calls = 0;
    const tmdbGet = async (p, q) => {
        calls++;
        if (p === '/discover/tv') return { results: (discover[q.with_origin_country] || []).map((id) => ({ id })), total_pages: 1 };
        let m = /^\/tv\/(\d+)$/.exec(p);
        if (m) { if (tvFail) throw new Error('timeout'); const s = SHOWS[m[1]]; return Object.assign({ id: +m[1] }, s, { season: undefined }); }
        m = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(p);
        if (m) return { episodes: SHOWS[m[1]].season };
        throw new Error('unexpected ' + p);
    };
    // 资源站历史:繁花 前一周、前两周的周五都更新了 → 预计这周五(11-27);完结的、只更新过一周的不猜;两京十五日今天资源站已经更新
    const cal = createCalendar({ db: () => db, now: () => now, sites: () => [], httpGet: async () => ({}), tmdbGet, opts: { pageGapMs: 0, schedGapMs: 0 } });
    cal.status();   // 建表
    // t 不给 = 那天北京 20 点
    const insQ = db.prepare(`INSERT INTO cal_items (day, nk, title, cat, remarks, ep, pic, year, area, t, sites, n) VALUES (?,?,?,?,?,0,'',2026,'大陆',?,'a',1)`);
    const ins = { run: (d, nk, title, cat, rm, t) => insQ.run(d, nk, title, cat, rm, t != null ? t : Date.parse(d + 'T12:00:00Z')) };
    for (const d of ['2026-11-13', '2026-11-20']) { ins.run(d, '繁花', '繁花', 'tv', '更新至第10集'); ins.run(d, '完结剧', '完结剧', 'tv', '全30集'); }
    ins.run('2026-11-20', '一周剧', '一周剧', 'tv', '更新至第2集');
    ins.run('2026-11-26', '两京十五日', '两京十五日', 'tv', '更新至第12集');
    ins.run('2026-11-26', '早更剧', '早更剧', 'tv', '更新至第3集', Date.UTC(2026, 10, 26, 1, 0));   // 北京 11-26 早上 9 点 = 北美 11-25 傍晚
    await cal.tick();
    const st = cal.status().sites.find((s) => s.site === '@tmdb');
    ok(st && st.last_ok === NOW && !st.last_err && st.items > 0, 'TMDB 排期拉成功,状态记在 @tmdb', st);
    const w = cal.week('2026-11-26', 24);
    const D = Object.fromEntries(w.days.map((x) => [x.day, x]));
    ok(w.cats.tv.items.filter((x) => x.title === '两京十五日').length === 1 && !w.cats.tv.items.find((x) => x.title === '两京十五日').plan, '今天资源站已经更新的,不再重复出一条「待播」', w.cats.tv.items);
    ok(D['2026-11-27'].total === 2 && D['2026-11-27'].real === 0 && D['2026-11-27'].plan === 2 && D['2026-11-27'].future, '明天:2 部待播(资源站还没有 → real = 0)', D['2026-11-27']);
    ok(D['2026-11-26'].real === 2 && D['2026-11-26'].plan === 0, '今天:资源站更新了的照常算 real', D['2026-11-26']);
    const w27 = cal.week('2026-11-27', 24);
    const tv27 = w27.cats.tv.items.map((x) => x.title + ':' + x.plan + ':' + x.remarks);
    ok(tv27.join() === '两京十五日:tmdb:第13-14集,繁花:guess:', '明天电视剧:TMDB 排期在前(同一天两集写「第13-14集」),再是按规律预计的繁花;完结的 / 只更新过一周的不猜', tv27);
    ok(w27.cats.tv.n === 2 && w27.days.find((x) => x.day === '2026-11-27').counts.tv === 2, '明天电视剧 2 部');
    ok(!w27.cats.tv.items.some((x) => /No Chinese|晚间新闻|粤语教程/.test(x.title)), '没中文译名 / 新闻 / 教学片 不收');
    const w28 = cal.week('2026-11-28', 24);
    const v = w28.cats.variety.items[0], us = w28.cats.tv.items.find((x) => x.title === '塔尔萨之王');
    ok(v && v.title === '你好，星期六' && v.plan === 'tmdb' && v.remarks === '', '综艺:TMDB 的集号和资源站「第2026xxxx期」对不上 → 不写集数', v);
    ok(us && us.area === '美国' && us.tag === '新季' && us.remarks === '第1集', '美剧当地 11-27 播 → 北京 11-28 才有片源;新一季第 1 集标「新季」', us);
    ok(w28.cats.tv.items.map((x) => x.title).join() === '两京十五日,塔尔萨之王', '排序:华语在前(美剧热度 900 也排在热度 50 的国产剧后面);欧美肥皂剧、没译名的日文片名、别的产地 不收', w28.cats.tv.items.map((x) => x.title));
    const w29 = cal.week('2026-11-29', 24);
    const nw = w29.cats.tv.items.find((x) => x.title === '新剧来了');
    ok(nw && nw.tag === '首播' && nw.remarks === '第1-2集', '第一季第 1 集 = 首播', nw);
    ok(w.last === '2026-11-29' && w.days.find((x) => x.day === '2026-11-25').plan === 0, 'last = 排期排到哪天(两周外的第 16 集不收);过去的日子没有待播', [w.last]);
    const l1 = cal.list('2026-11-27', 'tv', 0, 1), l2 = cal.list('2026-11-27', 'tv', 1, 1);
    ok(l1.total === 2 && l1.items[0].title === '两京十五日' && l2.items.length === 1 && l2.items[0].title === '繁花', 'list:待播的也能分页', [l1, l2]);
    const lt = cal.list('2026-11-26', 'tv', 0, 30);
    ok(lt.total === lt.items.length && lt.items[0].title === '两京十五日' && !lt.items[0].plan, 'list 今天:先列资源站已更新的', lt);
    // 按看的人的时区分天(Regina = UTC-6,不过夏令时):此刻北京 11-26 20:00 = Regina 11-26 06:00
    const R = 'America/Regina';
    const wr = cal.week('', 24, R);
    ok(wr.today === '2026-11-26' && wr.tz === R && wr.day === '2026-11-26', 'tz:「今天」按当地日期', [wr.today, wr.tz]);
    ok(!wr.cats.tv.items.some((x) => x.title === '早更剧') && cal.week('2026-11-25', 24, R).cats.tv.items.some((x) => x.title === '早更剧' && !x.plan),
        'tz:北京早上 9 点更新的,在北美算前一天傍晚');
    ok(w.cats.tv.items.some((x) => x.title === '早更剧'), '同一条在北京时间还是 11-26');
    const r27 = cal.week('2026-11-27', 24, R), r28 = cal.week('2026-11-28', 24, R);
    ok(r27.cats.tv.items.some((x) => x.title === '塔尔萨之王') && !r28.cats.tv.items.some((x) => x.title === '塔尔萨之王'), 'tz:美剧当地 11-27 晚上播 → 北美就是 11-27(北京是 11-28)');
    ok(r27.cats.tv.items.some((x) => x.title === '两京十五日' && x.remarks === '第13-14集'), 'tz:国产剧北京 11-27 晚上 = Regina 11-27 清早,还是同一天');
    const rl = cal.list('2026-11-25', 'tv', 0, 30, R);
    ok(rl.items.map((x) => x.title).join() === '早更剧' && rl.total === 1, 'list 也按时区分天', rl);
    ok(cal.week('', 24, 'Not/AZone').tz === 'Asia/Shanghai' && cal.week('', 24, 'a b;drop').tz === 'Asia/Shanghai', '不认识 / 不合法的时区 → 北京时间');
    // 浏览器同时报此刻的 UTC 偏移(分钟):跟服务器时区库算的一致 → 用时区名;不一致(时区库旧了) → 按浏览器的固定偏移
    ok(cal.week('', 24, R, '-360').tz === R && cal.week('', 24, 'Asia/Shanghai', 480).tz === 'Asia/Shanghai', 'tzo 跟时区名对得上:照用时区名');
    const fx = cal.week('', 24, R, '-420');
    ok(fx.tz === '@-420' && fx.today === '2026-11-26', 'tzo 对不上(服务器时区库旧了):按浏览器的偏移 @-420', [fx.tz, fx.today]);
    ok(cal.week('', 24, '', -300).tz === '@-300' && cal.week('', 24, 'Not/AZone', 'x').tz === 'Asia/Shanghai' && cal.week('', 24, R, 7).tz === R, '没时区名只有偏移 → 固定偏移;偏移不合法 → 不管它');
    ok(cal._dayIn('@-420', Date.UTC(2026, 10, 27, 6, 30)) === '2026-11-26' && cal._dayRange('@-420', '2026-11-26')[0] === Date.UTC(2026, 10, 26, 7), '固定偏移:分天 / 边界');
    const T = 'America/Toronto';   // 2026-11-01 凌晨 2 点夏令时结束,那天 25 小时
    const [ta, tb] = cal._dayRange(T, '2026-11-01');
    ok(ta === Date.UTC(2026, 10, 1, 4) && tb === Date.UTC(2026, 10, 2, 5) && cal._dayIn(T, Date.UTC(2026, 10, 2, 4, 30)) === '2026-11-01', 'tz:夏令时切换那天的边界也对', [new Date(ta).toISOString(), new Date(tb).toISOString()]);
    // 30 分钟后:不到 6 小时不重拉
    const c0 = calls;
    now = NOW + 31 * 60e3;
    await cal.tick();
    ok(calls === c0, '6 小时内不重拉 TMDB', calls - c0);
    // 7 小时后:详情一半以上查失败 → 留着上一轮的排期,记错误
    now = NOW + 7 * 3600e3; tvFail = true;
    await cal.tick();
    const st2 = cal.status().sites.find((s) => s.site === '@tmdb');
    ok(/失败太多/.test(st2.last_err) && db.prepare("SELECT count(*) AS c FROM cal_sched WHERE nk = '两京十五日'").get().c > 0, 'TMDB 大面积失败:不清旧排期', st2);
    const c1 = calls;
    now += 30 * 60e3;
    await cal.tick();
    ok(calls === c1, '失败后 1 小时内不重试', calls - c1);
    // 第二天 10 点:重拉成功 → 整张表换成新的;昨天的排期清掉
    now = NOW + 14 * 3600e3; tvFail = false; discover = { CN: [3] };
    await cal.tick();
    const left = db.prepare('SELECT DISTINCT nk FROM cal_sched').all().map((r) => r.nk);
    ok(left.join() === norm('新剧来了'), '重拉成功:整张排期换成新的', left);
    ok(db.prepare('SELECT count(*) AS c FROM cal_sched WHERE t < ?').get(now - 36 * 3600e3).c === 0, '一天半以前的排期不留');
    // 没传 tmdbGet:只有按规律预计
    const c3 = createCalendar({ db: () => db, now: () => NOW, sites: () => [], httpGet: async () => ({}) });
    db.prepare('DELETE FROM cal_sched').run();
    const w3 = c3.week('2026-11-27', 24);
    ok(w3.cats.tv.items.map((x) => x.title).join() === '繁花' && w3.last === '2026-11-26', '没配 TMDB:未来只有按规律预计的', w3.cats.tv.items);
    ins.run('2026-11-19', '日更剧', '日更剧', 'tv', '更新至第5集'); ins.run('2026-11-26', '日更剧', '日更剧', 'tv', '更新至第9集');
    ok(c3.week('2026-12-03', 24).cats.tv.n === 0, '只猜 6 天内(12-03 前两周同一天都更新了也不猜)');
    db.close();
}
function norm(s) { return String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
