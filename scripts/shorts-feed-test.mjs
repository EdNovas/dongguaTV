#!/usr/bin/env node
// 📱 短剧竖屏刷片库(lib/shorts-feed)回归(离线、零网络,内存 SQLite / 内存版 + 假资源站):
//   node scripts/shorts-feed-test.mjs
//  ① 纯函数:挑 m3u8 选集(分享页那一路不要)、短剧叶子分类(父分类 / 擦边 / AI 漫剧不要)、同名是不是同一部
//  ② tick:多集的收、「全集」单文件不收、站点几乎全是单文件 → 3 天不拉;几个站的同一部并成一部(线路按广告分级排)、同名不同部不并
//  ③ feed 分页 / 排序(热的往前)/ 没 sqlite 走内存;片库空着 kick 会开一轮
// 改 lib/shorts-feed 后必跑。
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };
const Database = dep('better-sqlite3');
const { createShortsFeed, pickLine, shortLeaves, sameWork } = require(path.join(ROOT, 'lib/shorts-feed'));
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
ok(st.items === 5, '片库 5 部(单文件 / AI / 擦边不收,同名并成一部,同名不同部留先来的)', st.items);
ok(S.jisu && S.jisu.skip_until > NOW && /全集/.test(S.jisu.last_err), '几乎全是「全集」单文件的站:3 天不拉', S.jisu);
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

// 第二轮:只翻第一页;被跳过的站不再请求
const before = { rycj: sites.rycj.calls(), jisu: sites.jisu.calls() };
await F.tick();
ok(sites.rycj.calls() - before.rycj === 1 && sites.jisu.calls() === before.jisu, '之后每轮每个分类只拉第一页(分类表有缓存);跳过中的站零请求', { r: sites.rycj.calls() - before.rycj, j: sites.jisu.calls() - before.jisu });

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
