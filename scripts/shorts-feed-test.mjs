#!/usr/bin/env node
// 📱 短剧竖屏刷片库(lib/shorts-feed)回归(离线、零网络,内存 SQLite / 内存版 + 假资源站):
//   node scripts/shorts-feed-test.mjs
//  ① 纯函数:挑 m3u8 选集(分享页那一路不要)、短剧叶子分类(父分类 / 擦边 / AI 漫剧不要)、同名是不是同一部
//  ② tick:多集的进竖屏刷、「全集」单文件只进分类页(不再跳过整个站);几个站的同一部并成一部(线路按广告分级排、全集排后)、同名不同部不并
//  ③ feed 分页 / 排序(热的往前)/ 没 sqlite 走内存;片库空着 kick 会开一轮
//  ④ 分类页:题材标签 / list(题材、排序、搜片名、只看分集)/ item / cats;往后补老页(cursor);老 cache.db 的表自动补列、补标签
// 改 lib/shorts-feed 后必跑。
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };
const Database = dep('better-sqlite3');
const { createShortsFeed, pickLine, shortLeaves, siteLeaves, parseTypes, sameWork } = require(path.join(ROOT, 'lib/shorts-feed'));
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

const eps = (n, host, from) => Array.from({ length: n }, (_, i) => `第${String(i + 1).padStart(2, '0')}集$https://${host}/v/${i + 1}/index.m3u8`).join('#');
const share = (n, host) => Array.from({ length: n }, (_, i) => `第${String(i + 1).padStart(2, '0')}集$https://${host}/share/${i + 1}`).join('#');

console.log('① 纯函数');
{
    const a = pickLine('feifan$$$ffm3u8', share(3, 'ff') + '$$$' + eps(3, 'ff'));
    ok(a && a.n === 3 && !/share/.test(a.line) && /index\.m3u8/.test(a.line), 'pickLine:分享页那一路不要,取 m3u8 那一路', a);
    const b = pickLine('rym3u8$$$ruyi', eps(5, 'ry') + '$$$' + share(5, 'ry'));
    ok(b && b.n === 5, 'pickLine:m3u8 在前一路', b);
    ok(pickLine('x', share(4, 'a')) === null, 'pickLine:只有分享页 → null');
    ok(pickLine('x', '第01集$https://a/1/index.m3u8#第02集$https://a/share/2') === null, 'pickLine:一路里混着分享页 → 整路不要');
    const c = pickLine('m3u8', 'https://a/1/index.m3u8#https://a/2/index.m3u8?sign=1');
    ok(c && c.n === 2 && c.line.startsWith('第01集$') && c.line.indexOf('第02集$https://a/2/index.m3u8?sign=1') > 0, 'pickLine:没集名补「第NN集」、带查询串的 m3u8 照收', c);
    const m = pickLine('m3u8', '全集$https://a/all/index.m3u8#第01集$https://a/1/index.m3u8#第02集$https://a/2/index.m3u8');
    ok(m && m.n === 2 && !/全集/.test(m.line), 'pickLine:「全集」拼合文件 + 分集:只留分集', m);
    const m2 = pickLine('m3u8', '全集$https://a/all/index.m3u8');
    ok(m2 && m2.n === 1, 'pickLine:只有「全集」一个:原样(之后按集数太少不收)', m2);
    const leaves = shortLeaves([
        { type_id: 38, type_pid: 0, type_name: '短剧' }, { type_id: 45, type_pid: 38, type_name: '古装仙侠' }, { type_id: 46, type_pid: 38, type_name: '现代都市' },
        { type_id: 53, type_pid: 38, type_name: '擦边短剧' }, { type_id: 54, type_pid: 38, type_name: 'AI漫剧' }, { type_id: 60, type_pid: 38, type_name: '甜宠' },
        { type_id: 2, type_pid: 0, type_name: '连续剧' }, { type_id: 36, type_pid: 2, type_name: '短剧' }, { type_id: 13, type_pid: 2, type_name: '国产剧' },
        { type_id: 73, type_pid: null, type_name: 'ai短剧' }, { type_id: 75, type_pid: null, type_name: '漫剧' },
    ]);
    ok(JSON.stringify(leaves) === JSON.stringify(['45', '46', '60', '36']), 'shortLeaves:父分类 / 擦边 / AI / 漫剧不要,父是短剧的子分类要,连续剧下的「短剧」要', leaves);
    ok(JSON.stringify(parseTypes('96-98, 120,x')) === JSON.stringify({ replace: false, ids: ['96', '97', '98', '120'] }) && parseTypes('=5').replace, 'parseTypes:区间 / 逗号 / 坏的跳过 / = 表示只用这些');
    ok(JSON.stringify(siteLeaves({ api: 'https://caiji.mgzyapi.com/api.php/provide/vod' }, ['24'])) === JSON.stringify(['24', '50', '51', '52', '53']), 'siteLeaves:芒果按主机补上 50–53');
    ok(siteLeaves({ api: 'https://api.yzzy-api.com/inc/apijson.php' }, ['83']).length === 22, 'siteLeaves:优质补上 96–116');
    ok(JSON.stringify(siteLeaves({ api: 'https://x.com/api.php', shorts_types: '7,8' }, ['3'])) === JSON.stringify(['3', '7', '8']) && JSON.stringify(siteLeaves({ api: 'https://api.yzzy-api.com/x', shorts_types: '=9' }, ['3'])) === JSON.stringify(['9']), 'siteLeaves:站点 shorts_types 追加,= 开头整个替换');
    ok(sameWork(63, 61) && sameWork(10, 13) && !sameWork(80, 40) && !sameWork(12, 30), 'sameWork:差一两集算同一部,差一倍不算');
}

console.log('② tick');
const NOW = Date.UTC(2026, 10, 26, 12, 0);
const T = (h) => new Date(NOW + 8 * 3600e3 - h * 3600e3).toISOString().replace('T', ' ').slice(0, 19);   // h 小时前(北京时间串)
const V = (id, name, n, h, extra) => Object.assign({ vod_id: id, vod_name: name, type_name: '短剧', vod_time: T(h), vod_remarks: '已完结', vod_pic: 'https://img/' + id + '.jpg', vod_play_from: 'm3u8', vod_play_url: eps(n, 'cdn' + id) }, extra || {});
const single = (id, name, h) => V(id, name, 1, h, { vod_play_url: '全集$https://s/' + id + '/index.m3u8' });
function fakeSite(classes, pages) {
    let calls = 0;
    const get = async (url) => {
        calls++;
        if (/ac=list/.test(url)) return JSON.stringify({ class: classes });
        const t = (/[?&]t=([^&]+)/.exec(url) || [])[1];
        const pg = +(/pg=(\d+)/.exec(url) || [0, 1])[1];
        const lists = pages[t] || [];
        return { list: lists[pg - 1] || [], pagecount: lists.length, page: pg };
    };
    return { get, calls: () => calls };
}
const SHORT = [{ type_id: 46, type_pid: 2, type_name: '短剧' }, { type_id: 2, type_pid: 0, type_name: '连续剧' }];
const sites = {
    rycj: fakeSite(SHORT, { 46: [[V(1, '你是世间璀璨', 61, 1), V(2, '本官在此', 72, 2), single(3, '全集一部', 3), V(4, '踢我出局', 51, 30, { vod_blurb: '<p>&nbsp;公司 倒计时</p>' })],
        [V(5, '第二页的剧', 20, 50, { vod_content: '艾旦影视,海外影院,海外影视,海外YY,海外抢先电影,海外手机影院' })]] }),
    ffzy: fakeSite(SHORT, { 46: [[V(11, '本官在此', 70, 200), V(12, '我真得控制你了', 63, 300), V(13, '你是世间璀璨', 20, 5), V(14, '我最亲爱的(Ai)', 14, 1), V(15, '某擦边', 30, 1, { type_name: '擦边短剧' })]] }),
    mirror: fakeSite(SHORT, { 46: [[V(2, '本官在此', 72, 2)]] }),   // 与 rycj 那部同一个 CDN 地址(cdn2):镜像,不算第二条线路
    jisu: fakeSite([{ type_id: 38, type_pid: 0, type_name: '短剧' }, { type_id: 46, type_pid: 38, type_name: '现代都市' }],
        { 46: [Array.from({ length: 14 }, (_, i) => single(100 + i, '单文件' + i, 2))] }),
    none: fakeSite([{ type_id: 1, type_pid: 0, type_name: '电影' }], {}),
    bad: { get: async () => { throw new Error('boom'); }, calls: () => 0 },
};
const SITES = Object.keys(sites).map((k) => ({ key: k, name: k + '名', api: 'https://' + k + '/api.php/provide/vod' }));
const TIERS = { rycj: 'noburn', ffzy: 'noburn', jisu: 'unknown' };
const mk = (db, over) => createShortsFeed(Object.assign({
    db: () => db, sites: () => SITES, now: () => NOW, tierOf: (k) => TIERS[k] || 'ads',
    httpGet: async (url) => { const k = /https:\/\/([^/]+)\//.exec(url)[1]; return sites[k].get(url); },
    opts: { pageGapMs: 0, firstDelayMs: 1e9, tickMs: 1e9 },
}, over || {}));

const db = new Database(':memory:');
// 日历表在(同一个 cache.db):「本官在此」这周好几个站都更新了 → 再往前提
db.exec(`CREATE TABLE cal_items (day TEXT, nk TEXT, title TEXT, cat TEXT, remarks TEXT, ep INTEGER, pic TEXT, year INTEGER, area TEXT, t INTEGER, sites TEXT, n INTEGER, PRIMARY KEY (day, nk));
    INSERT INTO cal_items VALUES ('2026-11-25', '本官在此', '本官在此', 'short', '', 0, '', 0, '', 0, 'a,b,c', 3);`);
const F = mk(db);
await F.tick();
const st = F.status();
const S = Object.fromEntries(st.sites.map((s) => [s.site, s]));
ok(st.eps === 5, '竖屏刷 5 部(单文件 / AI / 擦边不进,同名并成一部,同名不同部留先来的)', st.eps);
ok(st.items === 5 + 1 + 14, '片库还有 15 部「全集」单文件(rycj 1 部 + jisu 14 部),只进分类页', st.items);
ok(S.jisu && !(S.jisu.skip_until > NOW) && S.jisu.whole === 14 && S.jisu.multi === 0, '几乎全是「全集」单文件的站:照样收(全集),不再跳过', S.jisu);
ok(S.none && S.none.skip_until > NOW && /没有短剧分类/.test(S.none.last_err), '没有短剧分类的站:一周后再看', S.none);
ok(S.bad && /boom/.test(S.bad.last_err) && S.bad.skip_until > NOW, '拉取失败的站:记错误、过一阵再试,不拖垮整轮', S.bad);
ok(sites.rycj.calls() === 3, '第一次跑翻到最后一页就停(分类表 1 + 两页)', sites.rycj.calls());

const page1 = F.feed(0, 3), page2 = F.feed(3, 3);
ok(page1.total === 5 && page1.items.length === 3 && page1.next === 3 && page2.next === null && page2.items.length === 2, 'feed 分页 total / next', { t: page1.total, n1: page1.next, n2: page2.next });
const all = page1.items.concat(page2.items);
const by = Object.fromEntries(all.map((x) => [x.title, x]));
ok(all[0].title === '本官在此', '两个站都有 + 日历里多站更新的排第一', all.map((x) => x.title));
ok(by['本官在此'].srcs.length === 2 && by['本官在此'].eps === 72 && by['本官在此'].srcs[0].site_key === 'rycj', '同一部:两条线路、集数取多的、同分级集数多的在前', by['本官在此'].srcs.map((x) => x.site_key + x.n));
ok(!by['本官在此'].srcs.some((x) => x.site_key === 'mirror'), '镜像站(同一个 CDN 地址)不算第二条线路', by['本官在此'].srcs.map((x) => x.site_key));
ok(by['你是世间璀璨'].srcs.length === 1 && by['你是世间璀璨'].eps === 61, '同名但集数差太多(61 vs 20):不并', by['你是世间璀璨'].srcs.map((x) => x.site_key + x.n));
ok(!by['全集一部'] && !by['我最亲爱的(Ai)'] && !by['某擦边'], '单文件 / AI / 擦边都不在');
ok(by['踢我出局'].blurb === '公司 倒计时', '简介去掉 HTML 和 &nbsp;', by['踢我出局'].blurb);
ok(by['第二页的剧'].blurb === '', 'SEO 关键词简介不要', by['第二页的剧'].blurb);
const s0 = by['本官在此'].srcs[0];
ok(s0.vod_id === '2' && /^第01集\$https:\/\/cdn2\/v\/1\/index\.m3u8#/.test(s0.url) && s0.url.split('#').length === 72, '线路带 vod_id + 一条 m3u8 选集串', s0);
const idxOld = all.findIndex((x) => x.title === '我真得控制你了'), idxNew = all.findIndex((x) => x.title === '你是世间璀璨');
ok(idxNew < idxOld, '新更新的在前(1 小时前 > 300 小时前)', all.map((x) => x.title));

// 第二轮:只翻第一页(第一次就翻到底的分类不再往后补);跳过中的站(没短剧分类 / 刚出错)零请求
const before = { rycj: sites.rycj.calls(), jisu: sites.jisu.calls(), none: sites.none.calls() };
await F.tick();
ok(sites.rycj.calls() - before.rycj === 1 && sites.jisu.calls() - before.jisu === 1 && sites.none.calls() === before.none,
    '之后每轮每个分类只拉第一页(分类表有缓存);跳过中的站零请求', { r: sites.rycj.calls() - before.rycj, j: sites.jisu.calls() - before.jisu, n: sites.none.calls() - before.none });

console.log('④ 分类页');
{
    const { tagsOf } = require(path.join(ROOT, 'lib/shorts-feed'));
    ok(tagsOf('古装仙侠', '', '随便') === ',guzhuang,', 'tagsOf:看分类名', tagsOf('古装仙侠', '', '随便'));
    ok(tagsOf('短剧', '逆袭,都市', '') === ',dushi,nixi,', 'tagsOf:看 vod_class(可以几个)', tagsOf('短剧', '逆袭,都市', ''));
    ok(tagsOf('短剧', '', '重生之我在七零当首富') === ',dushi,chuanyue,', 'tagsOf:分类名没信息才看片名', tagsOf('短剧', '', '重生之我在七零当首富'));
    ok(tagsOf('短剧', '', '某剧') === '', 'tagsOf:都没有 → 空');

    const all1 = F.list({ offset: 0, limit: 60 });
    ok(all1.total === 20 && all1.items.length === 20 && !all1.items[0].srcs, 'list:全部 20 部(含全集),卡片不带选集串', { t: all1.total, s: !!all1.items[0].srcs });
    const one = all1.items.find((x) => x.title === '全集一部');
    ok(one && one.whole && one.eps === 1, 'list:「全集」单文件标 whole、1 集', one);
    const eps = F.list({ only: 'eps', limit: 60 });
    ok(eps.total === 5 && eps.items.every((x) => !x.whole), 'list only=eps:只要一集一集的', eps.total);
    const newest = F.list({ sort: 'new', limit: 3 });
    ok(newest.items[0].t >= newest.items[1].t && newest.items[1].t >= newest.items[2].t && newest.next === 3, 'list sort=new:按更新时间,next 翻页', newest.items.map((x) => x.t));
    const hot = F.list({ sort: 'hot', limit: 1 });
    ok(hot.items[0].title === '本官在此', 'list sort=hot:多站 + 日历热的在前', hot.items[0].title);
    const q = F.list({ q: '世间 璀璨' });
    ok(q.total === 1 && q.items[0].title === '你是世间璀璨', 'list q:搜片名(去空白)', q.items.map((x) => x.title));
    ok(F.list({ q: '%' }).total === 0 && F.list({ cat: 'bogus' }).total === 20, 'list:% 不当通配;不认识的题材 = 全部');
    const full = F.list({ only: 'eps', limit: 2, full: 1 });
    ok(full.items[0].srcs && full.items[0].srcs[0].url, 'list full=1:带选集串(竖屏刷接着刷)', full.items[0]);
    const it = F.item(by['本官在此'].id);
    ok(it && it.title === '本官在此' && it.srcs.length === 2, 'item:按 id 拿整部', it && it.srcs.length);
    ok(F.item('没有这部') === null, 'item:没有 → null');
    const c = F.cats();
    ok(c.total === 20 && c.eps === 5 && c.tags.length === 7 && c.tags.every((x) => x.k && x.l && typeof x.n === 'number'), 'cats:总数 / 分集数 / 7 个题材带计数', c);

    // 「全集」+ 一集一集的同一部:并成一部,一集一集的线路排前面,不算 whole
    const sites2 = {
        a: fakeSite(SHORT, { 46: [[single(201, '合并测试', 3)]] }),
        b: fakeSite(SHORT, { 46: [[V(202, '合并测试', 40, 4)]] }),
    };
    const G = createShortsFeed({ db: () => null, sites: () => ['a', 'b'].map((k) => ({ key: k, name: k, api: 'https://' + k + '/api.php/provide/vod' })), now: () => NOW,
        httpGet: async (url) => sites2[/https:\/\/([^/]+)\//.exec(url)[1]].get(url), opts: { pageGapMs: 0, firstDelayMs: 1e9, tickMs: 1e9 } });
    await G.tick();
    const m = G.list({ limit: 5, full: 1 }).items;
    ok(m.length === 1 && !m[0].whole && m[0].eps === 40 && m[0].srcs[0].site_key === 'b' && m[0].srcs[1].whole, '全集 + 分集的同一部:并成一部、分集线路在前', m);

    // 往后补老页:第一次 5 页,之后每轮补 backfillPages 页,补到底记 -1
    const pages = Array.from({ length: 9 }, (_, p) => [V(300 + p, '老剧' + p, 10, 100 + p)]);
    const s3 = fakeSite(SHORT, { 46: pages });
    const hdb = new Database(':memory:');
    const H = createShortsFeed({ db: () => hdb, sites: () => [{ key: 'c', name: 'c', api: 'https://c/api.php/provide/vod' }], now: () => NOW,
        httpGet: async (url) => s3.get(url), opts: { pageGapMs: 0, firstDelayMs: 1e9, tickMs: 1e9, backfillPages: 2 } });
    await H.tick();
    let cs = JSON.parse(H.status().sites[0].cursor);
    ok(H.status().items === 7 && cs['46'] === 8, '第一次:前 5 页 + 补 2 页(到第 7 页),下次从第 8 页', { n: H.status().items, cs });
    await H.tick();
    cs = JSON.parse(H.status().sites[0].cursor);
    ok(H.status().items === 9 && cs['46'] === -1, '第二次:补到第 9 页(最后一页)记 -1', { n: H.status().items, cs });
}
{
    // 老 cache.db(没有 tags / whole / cursor 列):启动补列、按分类名 + 片名补标签,旧的「全集」跳过作废
    const odb = new Database(':memory:');
    odb.exec(`CREATE TABLE shorts_items (nk TEXT PRIMARY KEY, title TEXT NOT NULL, pic TEXT NOT NULL DEFAULT '', remarks TEXT NOT NULL DEFAULT '', blurb TEXT NOT NULL DEFAULT '',
        year INTEGER NOT NULL DEFAULT 0, area TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', eps INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0, srcs TEXT NOT NULL DEFAULT '[]') WITHOUT ROWID;
        CREATE TABLE shorts_state (site TEXT PRIMARY KEY, api TEXT NOT NULL DEFAULT '', leaves TEXT NOT NULL DEFAULT '[]', classes_at INTEGER NOT NULL DEFAULT 0,
        last_ok INTEGER NOT NULL DEFAULT 0, skip_until INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, multi INTEGER NOT NULL DEFAULT 0, last_err TEXT NOT NULL DEFAULT '');
        INSERT INTO shorts_items (nk, title, type, eps, t, score, srcs) VALUES ('老一部', '老一部', '古装仙侠', 30, 1, 1, '[{"s":"x","id":"1","n":30,"t":1,"u":"第01集$https://a/1.m3u8"}]');
        INSERT INTO shorts_state (site, skip_until, last_err) VALUES ('jisu', 99999999999999, '多为全集单文件');`);
    const O = createShortsFeed({ db: () => odb, sites: () => [], now: () => NOW, httpGet: async () => null, opts: { firstDelayMs: 1e9, tickMs: 1e9 } });
    const r = O.list({ cat: 'guzhuang' });
    ok(r.total === 1 && r.items[0].tags[0] === 'guzhuang' && O.feed(0, 5).total === 1, '老表补列 + 补标签,照样能刷', r);
    const js = O.status().sites.find((x) => x.site === 'jisu');
    ok(js && js.skip_until === 0 && js.last_err === '', '旧的「多为全集单文件」跳过作废', js);
}

console.log('③ 内存版 / kick');
{
    let n = 0;
    const M = mk(null, { sites: () => SITES.filter((s) => s.key === 'rycj'), httpGet: async (url) => { n++; return sites.rycj.get(url); } });
    ok(M.feed(0, 8).total === 0, '冷启动:空片库');
    M.kick();
    await new Promise((r) => setTimeout(r, 20));
    await M.tick();   // 等那一轮跑完(running 时 tick 返回同一个 promise)
    const f = M.feed(0, 8);
    ok(f.total === 4 && f.items[0].srcs[0].site_key === 'rycj', '没 sqlite:放内存,照样能刷', f.total);
    const n1 = n;
    M.kick();
    ok(n === n1, '片库有东西了 kick 不再开轮');
}

console.log(`\n${fail ? '❌' : '✅'} shorts-feed-test: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
