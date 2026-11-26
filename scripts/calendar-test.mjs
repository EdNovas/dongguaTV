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

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
