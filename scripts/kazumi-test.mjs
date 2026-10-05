#!/usr/bin/env node
// Kazumi 规则站适配层测试。
//   node scripts/kazumi-test.mjs          离线:XPath 规则引擎 / 播放页解析 / m3u8 绝对化 / 路由校验 / titlematch 回归
//   node scripts/kazumi-test.mjs --live   另跑线上冒烟:两站各搜 4 部 → 首个结果详情 → 第 1 集解析 → hls 取清单 / mp4 Range 0-1
// 离线失败退出码非 0;线上失败只打印(上游/地区封锁不归我们管),但会在表格里标出。
// 改 lib/kazumi/* 或 public/libs/js/kz-titlematch.js 后必跑。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'scripts/fixtures/kazumi');
const fx = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

const K = require(path.join(ROOT, 'lib/kazumi/index.js'));
const X = require(path.join(ROOT, 'lib/kazumi/rule-xpath.js'));
const R = require(path.join(ROOT, 'lib/kazumi/resolvers.js'));
const T = require(path.join(ROOT, 'lib/kazumi/titlematch.js'));
const I = K._internal;

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) pass++;
    else { fail++; failures.push(name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

// ============ 1. XPath 语义 ============
{
    const html = '<html><body><div id="a"><div class="x"><span>1</span><a href="/1">一</a></div><div class="x"><a href="/2">二</a><a href="/3">三</a></div></div><p>外</p><a href="/out">外链</a></body></html>';
    const root = X.parseHtml(html);
    const items = X.evaluate(root, '//div[@id=\'a\']/div').nodes;
    eq(items.length, 2, 'xpath: [@id=] 谓词 + 子步');
    // 开头 // 相对上下文:第一项里只有 /1,不应跑到文档根拿到 /out
    eq(X.evaluate(root, '//a', items[0]).nodes.map((n) => X.attr(n, 'href')), ['/1'], 'xpath: 子查询开头 // 相对上下文节点');
    eq(X.evaluate(root, '//a[last()]', items[1]).nodes.map((n) => X.attr(n, 'href')), ['/3'], 'xpath: [last()]');
    eq(X.evaluate(root, '//a[position()<2]', items[1]).nodes.map((n) => X.attr(n, 'href')), ['/2'], 'xpath: [position()<n]');
    eq(X.evaluate(root, '//a[contains(@href,\'3\')]', items[1]).nodes.length, 1, 'xpath: contains()');
    eq(X.evaluate(root, '//a[text()=\'二\']', items[1]).nodes.length, 1, 'xpath: [text()=]');
    eq(X.evaluate(root, '//a/@href', items[1]).attr, '/2', 'xpath: 末步 @attr 带出属性');
    eq(X.textOf(X.evaluate(root, "//div[@class='x'][1]/text()", root).node), '1一', 'xpath: text() 是 self 步,读完整 textContent');
    eq(X.evaluate(root, '//div[@class=\'x\']/span|//p').nodes.length, 2, 'xpath: | 并集');
    eq(X.normalizeEpisodeUrl('https://dmbus.cc/', 'http://dmbus.cc/p/1-2-3.html/'), 'https://dmbus.cc/p/1-2-3.html', 'normalizeEpisodeUrl: 同 host 统一协议 + 去尾斜杠');
    eq(X.encodeQueryComponent('a b'), 'a+b', 'encodeQueryComponent: 空格→+');
    eq([X.extractEpisodeNumber('第12话'), X.extractEpisodeNumber('短篇16'), X.extractEpisodeNumber('SP')], [12, 16, 0], 'extractEpisodeNumber');
}

// ============ 2. 规则引擎:搜索 / 详情(真实页面快照) ============
const s7 = I.siteOf('kz_7sefun'), dm = I.siteOf('kz_dm84');
{
    const r7 = I.parseSearchHtml(s7, fx('s7_search.html'));
    eq(r7.map((x) => [x.vid, x.name, x.remarks]), [['26976', '葬送的芙莉莲第二季', '10集全'], ['32644', '葬送的芙莉莲', '28']], '7sefun 搜索:名称/ID/备注(4 个空壳节点被跳过)');
    ok(/^http:\/\/p\.qpic\.cn\//.test(r7[0].pic) && r7[1].pic === '', '7sefun 搜索:封面绝对化,src="/" 视为无封面', r7.map((x) => x.pic));
    const rd = I.parseSearchHtml(dm, fx('dm_search.html'));
    eq(rd.map((x) => [x.vid, x.name, x.remarks]), [['5963', '葬送的芙莉莲 第二季', '完结'], ['4356', '葬送的芙莉莲', '完结']], 'DM84 搜索:名称/ID/备注');
    ok(/^http:\/\/p\.qpic\.cn\//.test(rd[0].pic), 'DM84 搜索:懒加载 data-bg 封面', rd[0].pic);

    const d7 = I.parseDetailHtml(s7, '26976', fx('s7_detail.html'));
    eq(d7.roads.map((r) => [r.sid, r.label, r.eps.length, r.eps[0].name, r.eps[9].tok]), [[2, '七色A线', 10, '第01集', '26976-2-10'], [1, '七色B线', 10, '第01集', '26976-1-10']], '7sefun 详情:线路(含站点线路名)/集');
    eq([d7.name, d7.year, d7.type, d7.content, d7.remarks], ['葬送的芙莉莲第二季', '2026', '动漫', '', '10集全'], '7sefun 详情:名称/年份(类型行首个 YYYY年)/类型/占位简介置空');
    const dd = I.parseDetailHtml(dm, '5963', fx('dm_detail.html'));
    eq(dd.roads.map((r) => [r.sid, r.label, r.eps.length, r.eps[0].name]), [[2, '线路2', 10, '第1集'], [1, '线路1', 10, '第1集'], [3, '线路3', 10, '第1集']], 'DM84 详情:按页面顺序的线路 + 纯数字集名→第N集');
    eq([dd.name, dd.year, dd.type, dd.remarks], ['葬送的芙莉莲第二季', '2026', '动漫', '完结'], 'DM84 详情:名称归一/v_desc 年份/类型/备注');
    ok(dd.content.startsWith('这是一个魔王'), 'DM84 详情:剧情简介');

    // 倒序长篇 + 非数字集名:构造 DM84 第一条线路倒序、第二条含"短篇"
    const lis = (sid, names) => names.map((n, i) => `<li><a href="/p/5963-${sid}-${i + 1}.html">${n}</a></li>`).join('');
    let syn = fx('dm_detail.html').replace(/<ul class="play_list current">[\s\S]*?<\/ul><ul class="play_list">[\s\S]*?<\/ul>/,
        `<ul class="play_list current">${lis(2, ['3', '2', '1'])}</ul><ul class="play_list">${lis(1, ['短篇16', '01', ' 2 '])}</ul>`);
    const ds = I.parseDetailHtml(dm, '5963', syn);
    eq(ds.roads[0].eps.map((e) => [e.name, e.nid]), [['第1集', 3], ['第2集', 2], ['第3集', 1]], '详情排序:全数字集名按集号升序(倒序列表被纠正)');
    eq(ds.roads[1].eps.map((e) => [e.name, e.nid]), [['短篇16', 1], ['第1集', 2], ['第2集', 3]], '详情排序:含非数字集名时按 nid');
}

// detail()/search() 走缓存注入,验证对外形状(不联网:直接写缓存)
{
    const d = I.parseDetailHtml(dm, '5963', fx('dm_detail.html'));
    I.caches.detailCache.set('kz_dm84|5963', d, 60000);
    const { list } = await K.detail('kz_dm84', '5963');
    const it = list[0];
    eq(it.vod_play_from, '线路2$$$线路1$$$线路3', 'detail(): vod_play_from 用站点线路名 $$$ 连接');
    ok(it.vod_play_url.split('$$$')[0].split('#')[0] === '第1集$/api/kz/ep/kz_dm84/5963-2-1', 'detail(): 集地址是相对 /api/kz/ep/<site>/<vid-sid-nid>', it.vod_play_url.slice(0, 80));
    eq([it.vod_id, it.type_name, it.vod_year, it._kz], ['5963', '动漫', '2026', 1], 'detail(): 字段');
    I.caches.searchCache.set('kz_dm84|葬送的芙莉莲', I.parseSearchHtml(dm, fx('dm_search.html')).map((r) => ({
        vod_id: r.vid, vod_name: I.normName(r.name), vod_pic: r.pic, vod_remarks: r.remarks, vod_year: '', type_name: '动漫',
        vod_content: '', vod_play_from: '', vod_play_url: '', _kz: 1, _gk: T.titleKey(I.normName(r.name), { remarks: r.remarks }), _season: null, _kind: 't',
    })), 60000);
    const s = await K.search('kz_dm84', '葬送的芙莉莲 第二季');   // coreKeyword 去掉季号 → 命中缓存键
    eq(s.list.map((x) => [x.vod_id, x.vod_name, x._gk]), [['5963', '葬送的芙莉莲第二季', '葬送的芙莉莲#s2'], ['4356', '葬送的芙莉莲', '葬送的芙莉莲']], 'search(): 核心词 + 展示名归一 + _gk');
    I.caches.detailCache.clear(); I.caches.searchCache.clear();

    // 0 结果回退:原名也要过 coreKeyword(去季号/副标题、≤10 字),与核心词相同就不再发
    const realGetHtml = R.getHtml, sent = [];
    R.getHtml = async (site, url) => { sent.push(url); return '<html><body></body></html>'; };
    try {
        await K.search('kz_7sefun', '某番', '葬送のフリーレン 第2期');
        eq(sent, [I.buildSearchUrl(s7, '某番'), I.buildSearchUrl(s7, '葬送のフリーレン')], 'search 回退:原名经 coreKeyword 去掉季号后才发');
        sent.length = 0; I.caches.searchCache.clear();
        await K.search('kz_dm84', '某番', '某番 第二季');
        eq(sent, [I.buildSearchUrl(dm, '某番')], 'search 回退:原名核心词 == 核心词 → 不发第二次');
        sent.length = 0; I.caches.searchCache.clear();
        await K.search('kz_7sefun', '某番', 'Shingeki no Kyojin The Final Season Part 2 Kanketsu-hen');
        eq(sent, [I.buildSearchUrl(s7, '某番'), I.buildSearchUrl(s7, 'Shingeki')], 'search 回退:长英文原名 → 单段核心词(不发整串/季号)');
    } finally { R.getHtml = realGetHtml; I.caches.searchCache.clear(); }
}

// ============ 3. 播放页 / 解析器纯函数 ============
{
    const p = R.parsePlayerData(fx('s7_play.html'));
    ok(p && p.from === 'lmm' && p.id === '26976' && p.url.startsWith('https://www.lmm85.com/play/'), '7sefun player_aaaa encrypt=2 解码', p && p.url);
    const raw = 'https://a.b/c d.m3u8';
    eq(R.decodeMaccmsUrl(Buffer.from(escape(raw), 'latin1').toString('base64'), 2), raw, 'decodeMaccmsUrl encrypt=2');
    eq(R.decodeMaccmsUrl(escape(raw), 1), raw, 'decodeMaccmsUrl encrypt=1');
    eq(R.decodeMaccmsUrl(raw, 0), raw, 'decodeMaccmsUrl encrypt=0');
    eq(R.parsePlayerData('<script>var player_abc={"from":"x","encrypt":0,"url":"u{}","vod_data":{"a":{"b":1}}}</script>').url, 'u{}', 'parsePlayerData: 嵌套对象 + 字符串里的括号');
    ok(/^https:\/\/groupvideo\.photo\.qq\.com\/.*\.mp4\?dis_k=/.test(R.parseArtConfig(fx('s7_art.html')) || ''), 'art.php var config url');
    eq(R.parseArtConfig('var config = {"api":"x","url":"https:\\/\\/h.cn\\/a.mp4"}'), 'https://h.cn/a.mp4', 'parseArtConfig 反转义 \\/');
    const ifr = R.parseHhjxIframe(fx('dm_play.html'));
    ok(/^https:\/\/hhjx\.hhplayer\.com\/\?url=[0-9A-F]{64,}$/.test(ifr || ''), 'DM84 播放页 hhjx iframe', ifr);
    const b = R.parseHhjxBootstrap(fx('hhjx_boot.html'));
    ok(b && /^[0-9A-F]+$/.test(b.url) && typeof b.t === 'number' && /^[0-9a-f]{64}$/.test(b.key) && /^[0-9a-f]{64}$/.test(b.ts_key), 'hhjx __HHJX_BOOTSTRAP__ 解析', b);
    eq(R.expiryOf('https://hhjx.hhplayer.com/playlist/x.m3u8?expires=1791204138&sign=abc'), 1791204138000, 'expiryOf expires=');
    eq(R.expiryOf('https://o.ctyun.cn/a.mp4?X-Amz-Date=20261004T010000Z&X-Amz-Expires=10800'), Date.parse('2026-10-04T04:00:00Z'), 'expiryOf X-Amz-*');
    eq(R.expiryOf('https://v3.365yg.com/0123456789abcdef0123456789abcdef/6a8b1c2d/video/tos/cn/x/'), 0x6a8b1c2d * 1000, 'expiryOf 字节系路径十六进制');
    eq(R.expiryOf('https://x.qq.com/a.mp4?dis_k=1&dis_t=1791134916'), null, 'expiryOf QQ dis_t(签发时间)不当过期时间');
}

// ============ 4. m3u8 绝对化 / master 拍平 ============
{
    const media = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:5,\nseg1.ts?x=1\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\n/abs/seg2.ts#frag\n#EXT-X-ENDLIST';
    const out = I.absolutizeM3u8(media, 'https://cdn.a.com/p/q/index.m3u8');
    eq(out.split('\n'), ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.a.com/p/q/key.bin"', '#EXTINF:5,', 'https://cdn.a.com/p/q/seg1.ts?x=1', '#EXT-X-DISCONTINUITY', '#EXTINF:5,', 'https://cdn.a.com/abs/seg2.ts#frag', '#EXT-X-ENDLIST'], 'absolutizeM3u8: URI 行与 URI="" 属性,其它标签原样');
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nhigh/index.m3u8\n';
    eq(I.pickVariant(master, 'https://h.com/a/master.m3u8'), 'https://h.com/a/high/index.m3u8', 'pickVariant: 取最高 BANDWIDTH');
}

// ============ 5. 站点开关 / 名称归一 / isKzSite ============
{
    eq(K.getSites({ env: { KAZUMI_DISABLE: '1' } }), [], 'KAZUMI_DISABLE=1 → []');
    eq(K.getSites({ env: { KAZUMI_DISABLE: 'ON' } }), [], 'KAZUMI_DISABLE=ON → []');
    eq(K.getSites({ env: { KAZUMI_DISABLE: '0' } }).length, 2, 'KAZUMI_DISABLE=0 → 不关闭(envFlag 语义)');
    eq(K.getSites({ env: { KAZUMI_DISABLE: 'off' } }).length, 2, 'KAZUMI_DISABLE=off → 不关闭');
    eq(K.getSites({ env: { KAZUMI_SITES: 'dm84' } }).map((s) => s.key), ['kz_dm84'], 'KAZUMI_SITES 白名单');
    eq(K.getSites({ env: {} })[0], { key: 'kz_7sefun', name: '七色番', kazumi: true, active: true, api: '' }, 'getSites 形状');
    // 只认 kazumi:true:db.json/远程 maccms 源 key 恰以 kz_ 开头、或与内置同 key 覆盖内置时,都必须仍按 maccms 处理
    eq([K.isKzSite({ key: 'kz_x' }), K.isKzSite({ key: 'kz_7sefun', api: 'https://x/api.php/provide/vod' }), K.isKzSite({ key: 'kz_x', kazumi: 'true' }),
        K.isKzSite({ key: 'ffzy', kazumi: true }), K.isKzSite({ key: 'ffzy' }), K.isKzSite(null)], [false, false, false, true, false, false], 'isKzSite: 只认 kazumi===true,不按 kz_ 前缀');
    ok(K.getSites({ env: {} }).every((s) => K.isKzSite(s)), 'isKzSite: getSites 产出的条目全部识别为规则站');
    // 额外规则写坏(正则非法 / 结构缺失 / null / 原型键解析器)只跳过该条,内置站照常
    const warn = console.warn; console.warn = () => { };
    let built = null, threw = null;
    try {
        built = I.buildSites(Object.assign({}, I.BUILTIN, {
            'bad-re.json': { baseURL: 'https://x.cc', dg: { key: 'kz_badre', resolver: 'maccms', vidFrom: '(', playPath: '/p/{vid}.html' } },
            'null.json': null,
            'no-vid.json': { dg: { key: 'kz_novid', resolver: 'maccms', playPath: '/p/{vid}.html' } },
            'proto.json': { dg: { key: 'kz_proto', resolver: 'constructor', vidFrom: '/v/(\\d+)', playPath: '/p/{vid}.html' } },
        }));
    } catch (e) { threw = e; } finally { console.warn = warn; }
    eq([threw && threw.message, built && [...built.keys()]], [null, ['kz_7sefun', 'kz_dm84']], 'buildSites: 坏规则逐条跳过,不抛错,内置站保留');
    eq(I.normName('​葬送的芙莉莲  第二季​'), '葬送的芙莉莲第二季', 'normName: 零宽 + 中文与"第"之间空格');
    eq(I.normName('间谍过家家 Part 2'), '间谍过家家 Part 2', 'normName: 其它保持原样');
    eq(K.coreKeyword('【我推的孩子】 第三季'), '我推的孩子', 'coreKeyword 再导出');
}

// ============ 6. 路由校验(无 SSRF / 非法参数 404,不联网) ============
{
    const express = require('express');
    const app = express();
    K.registerRoutes(app);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = srv.address().port;
    const get = (p) => new Promise((r) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); res.on('end', () => r(res.statusCode)); }).on('error', () => r(0)));
    eq(await get('/api/kz/ep/kz_nope/1-1-1'), 404, '路由: 未知站点 404');
    eq(await get('/api/kz/ep/kz_dm84/1-1'), 404, '路由: tok 非 vid-sid-nid 404');
    eq(await get('/api/kz/m3u8/kz_dm84/1-1-1.txt'), 404, '路由: m3u8 文件名校验');
    eq(await get('/api/kz/mp4/kz_dm84/' + encodeURIComponent('http://evil')), 404, '路由: mp4 拒绝任意 URL');
    srv.close();
}

// ============ 6b. 每 host 并发闸门 / 排队期限 ============
{
    const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
    const host = 'https://gate.test/';
    let active = 0, max = 0;
    const manual = () => { let rel; const p = new Promise((r) => { rel = r; }); return { p, rel }; };
    const run = (wait) => R.withHost(host, async () => { active++; max = Math.max(max, active); await wait; active--; });
    // 回归:2 个持有者 + 1 个等待者同时释放,随后立刻来 3 个新请求 —— 旧实现会让并发冲到 3
    const a = manual(), b = manual(), c = manual();
    const ps = [run(a.p), run(b.p), run(c.p)];
    await tick();
    a.rel(); b.rel();
    await Promise.resolve(); await Promise.resolve();
    ps.push(run(tick(20)), run(tick(20)), run(tick(20)));
    await tick(5); c.rel();
    await Promise.all(ps);
    ok(max <= 2, 'withHost: 释放时直接移交槽位,并发不超过 2', { max });
    // 排队期限:两个槽位被占满时,maxWait 到期抛 EKZBUSY 并从队列移除,之后的请求不受影响
    const h1 = manual(), h2 = manual();
    const hp = [run(h1.p), run(h2.p)];
    const t0 = Date.now();
    const busy = await R.withHost(host, async () => 'ran', { maxWait: 40 }).then(() => null, (e) => e);
    ok(busy && busy.code === 'EKZBUSY' && Date.now() - t0 < 1000, 'withHost: 排队超过 maxWait → EKZBUSY', busy && busy.message);
    h1.rel(); h2.rel(); await Promise.all(hp);
    eq(await R.withHost(host, async () => 'ran', { maxWait: 40 }), 'ran', 'withHost: 超时等待者已出队,后续请求正常拿到槽位');
}

// ============ 6c. 出网目的地校验(SSRF) ============
{
    const blocked = ['http://127.0.0.1:1/', 'http://localhost/', 'http://a.localhost/', 'http://169.254.169.254/latest/', 'http://10.0.0.8/', 'http://192.168.1.1/',
        'http://172.20.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://2130706433/', 'http://0x7f.1/', 'ftp://dmbus.cc/', 'file:///etc/passwd'];
    const leaks = blocked.filter((u) => { try { R.assertPublicHttpUrl(u); return true; } catch (e) { return e.code !== 'EKZBLOCKED'; } });
    eq(leaks, [], 'assertPublicHttpUrl: 拒绝回环/内网/链路本地/元数据/非 http(s)');
    eq(['https://dmbus.cc/p/1-1-1.html', 'https://8.8.8.8/x', 'https://[2606:4700::1]/'].map((u) => { try { R.assertPublicHttpUrl(u); return true; } catch (e) { return false; } }), [true, true, true], 'assertPublicHttpUrl: 公网地址放行');
    const e1 = await R.getText('http://127.0.0.1:1/x.m3u8').then(() => null, (e) => e);
    ok(e1 && e1.code === 'EKZBLOCKED', 'getText: 字面内网 IP 在连接前就被拒', e1 && e1.message);
    const e2 = await new Promise((r) => R._safeLookup('localhost', {}, (err) => r(err)));
    ok(e2 && e2.code === 'EKZBLOCKED', 'safeLookup: 解析到 127.0.0.1/::1 的域名被拒', e2 && e2.message);
    let e3 = null; try { R._guardRedirect({ protocol: 'http:', hostname: '169.254.169.254' }); } catch (e) { e3 = e; }
    ok(e3 && e3.code === 'EKZBLOCKED', 'beforeRedirect: 重定向到元数据地址被拒');

    // IPv6 内嵌 IPv4 的各种写法:展开后按内嵌 IPv4 判(NAT64 / 6to4 / IPv4 兼容 / SIIT / 映射的十六进制写法)
    eq(R._expandIpv6('64:ff9b::127.0.0.1'), [0x64, 0xff9b, 0, 0, 0, 0, 0x7f00, 1], 'expandIpv6: 压缩 + 内嵌点分 IPv4');
    eq(R._expandIpv6('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8], 'expandIpv6: 全写');
    eq([R._expandIpv6('::'), R._expandIpv6('1::2::3'), R._expandIpv6('1:2:3:4:5:6:7:8:9')], [[0, 0, 0, 0, 0, 0, 0, 0], null, null], 'expandIpv6: :: / 非法');
    const privV6 = ['::', '::1', '0:0:0:0:0:0:0:1', '::127.0.0.1', '::10.1.2.3', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:a9fe',
        '::ffff:0:127.0.0.1', '::ffff:0:a00:1', '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::c0a8:101', '64:ff9b:1::1', '64:ff9b:1:abcd::8.8.8.8',
        '2002:7f00:1::', '2002:a00:1::1', '2002:c0a8:101::', '2002:a9fe:a9fe::1', 'fe80::1%eth0', 'fec0::1', 'fd12::1', 'ff02::1'];
    eq(privV6.filter((ip) => !R.isPrivateIp(ip)), [], 'isPrivateIp: NAT64/6to4/IPv4 兼容/SIIT/映射/ULA/链路本地/组播 全部判内网');
    const pubV6 = ['2606:4700::1', '64:ff9b::8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '::8.8.8.8', '::ffff:8.8.8.8', '::ffff:0:8.8.8.8', '2001:4860:4860::8888'];
    eq(pubV6.filter((ip) => R.isPrivateIp(ip)), [], 'isPrivateIp: 内嵌公网 IPv4 / 普通公网 IPv6 放行');
    const blocked6 = ['http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://[::ffff:0:7f00:1]/', 'http://[::7f00:1]/', 'http://[64:ff9b:1::1]/'];
    eq(blocked6.filter((u) => { try { R.assertPublicHttpUrl(u); return true; } catch (e) { return false; } }), [], 'assertPublicHttpUrl: URL 里的 NAT64/6to4/兼容地址被拒');

    // assertPublicDns:302 前的域名解析守卫(打桩 DNS,按 host 缓存结论)
    const realLookup = R._dnsImpl.lookup;
    const looked = [];
    R._dnsImpl.lookup = async (h) => {
        looked.push(h);
        if (h === 'evil.test') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
        if (h === 'nat64.test') return [{ address: '64:ff9b::a9fe:a9fe', family: 6 }];
        if (h === 'nx.test') throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        return [{ address: '93.184.216.34', family: 4 }];
    };
    try {
        R._dnsVerdicts.clear();
        const tryDns = (u) => R.assertPublicDns(u).then(() => 'ok', (e) => e.code || e.message);
        eq([await tryDns('https://good.test/a.mp4'), await tryDns('https://evil.test/a.mp4'), await tryDns('https://nat64.test/a.mp4'), await tryDns('https://nx.test/a.mp4'), await tryDns('http://127.0.0.1/a.mp4'), await tryDns('https://8.8.8.8/a.mp4')],
            ['ok', 'EKZBLOCKED', 'EKZBLOCKED', 'EKZBLOCKED', 'EKZBLOCKED', 'ok'], 'assertPublicDns: 任一解析地址是内网即拒;解析失败拒;字面 IP 不查 DNS');
        looked.length = 0;
        await tryDns('https://good.test/b.mp4'); await tryDns('https://evil.test/b.mp4');
        eq(looked, [], 'assertPublicDns: 同 host 结论缓存,不重复解析');
        await tryDns('https://nx.test/b.mp4');
        eq(looked, ['nx.test'], 'assertPublicDns: 解析失败不缓存(下次重查)');
    } finally { R._dnsImpl.lookup = realLookup; R._dnsVerdicts.clear(); }
}

// ============ 6d. 缓存 / fresh 节流 ============
{
    const c = I.ttlCache(10);
    c.set('k', 'old', 60000); c.set('k', 'new', 0);
    eq(c.get('k'), undefined, 'ttlCache.set(ttl<=0) 删除旧条目(否则 fresh 结果存不进、坏地址继续命中)');
    eq([I.allowFresh('t|1-1-1'), I.allowFresh('t|1-1-1'), I.allowFresh('t|1-1-2')], [true, false, true], 'fresh 节流:同一集 15s 内只放行一次');
}

// ============ 6e. 解析回退 / 清单预取 / 409 / 报错不外泄(打桩,不联网) ============
{
    const express = require('express');
    const realRes = Object.assign({}, R.RESOLVERS), realGetText = R.getText, realLookup = R._dnsImpl.lookup;
    const calls = [];
    // mp4 路由 302 前会解析目标域名:cdn.test 解析为公网,rebind.test 解析为回环
    R._dnsImpl.lookup = async (h) => [{ address: h === 'rebind.test' ? '127.0.0.1' : '93.184.216.34', family: 4 }];
    R._dnsVerdicts.clear();
    let plStatus = 200;
    const PL = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nseg1.ts\n#EXT-X-ENDLIST\n';
    // fetchPlaylistText 走 R.getText:换成假的上游
    R.getText = async (url) => {
        if (/^https:\/\/cdn\.test\//.test(url)) return { status: plStatus, text: plStatus === 200 ? PL : 'forbidden', url, headers: {} };
        return realGetText(url);
    };
    const dmD = I.parseDetailHtml(dm, '5963', fx('dm_detail.html'));
    const s7D = I.parseDetailHtml(s7, '26976', fx('s7_detail.html'));
    const reset = () => { I.caches.resolveCache.clear(); I.caches.playlistCache.clear(); I.caches.detailCache.set('kz_dm84|5963', dmD, 600000); I.caches.detailCache.set('kz_7sefun|26976', s7D, 600000); calls.length = 0; };
    const app = express(); K.registerRoutes(app);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = srv.address().port;
    const get = (p) => new Promise((r) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => r({ status: res.statusCode, body: b, loc: res.headers.location })); }).on('error', (e) => r({ status: 0, body: e.message })));
    try {
        // a. 上游把地址指向内网:每条线路都失败 → 502 且响应体不含 127.0.0.1 / ECONNREFUSED
        reset();
        R.RESOLVERS.hhjx = async (ctx) => { calls.push(`${ctx.sid}-${ctx.nid}`); return { type: 'hls', url: 'http://127.0.0.1:1/x.m3u8' }; };
        let r = await get('/api/kz/ep/kz_dm84/5963-2-1');
        eq([r.status, JSON.parse(r.body).error], [502, 'upstream resolve failed'], '路由 502:泛化报错');
        ok(!/127\.0\.0\.1|ECONNREFUSED|blocked/.test(r.body), '路由 502:不回显上游/内网细节', r.body);
        eq(calls, ['2-1', '1-1', '3-1'], '回退:hhjx 不重试同线路,按集号依次试其它线路');

        // b. 请求线路 hls 清单 403 → 视为失败,回退到线路 1 的 mp4
        reset();
        R.RESOLVERS.hhjx = async (ctx) => { calls.push(`${ctx.sid}-${ctx.nid}`); return ctx.sid === '2' ? { type: 'hls', url: 'https://cdn.test/a.m3u8' } : { type: 'mp4', url: 'https://cdn.test/b.mp4' }; };
        plStatus = 403;
        r = await get('/api/kz/ep/kz_dm84/5963-2-1');
        const j = JSON.parse(r.body);
        eq([r.status, j.type, j.road, j.url], [200, 'mp4', 1, '/api/kz/mp4/kz_dm84/5963-2-1'], 'ep:hls 清单取不到 = 线路失败,回退到可用的 mp4 线路');
        r = await get('/api/kz/mp4/kz_dm84/5963-2-1');
        eq([r.status, r.loc], [302, 'https://cdn.test/b.mp4'], 'mp4 路由:302 到回退线路的直链');

        // b2. mp4 直链域名解析到内网 → 502 泛化报错,不 302、不回显细节
        reset();
        R.RESOLVERS.hhjx = async () => ({ type: 'mp4', url: 'https://rebind.test/x.mp4' });
        r = await get('/api/kz/mp4/kz_dm84/5963-2-4');
        eq([r.status, r.loc, JSON.parse(r.body).error], [502, undefined, 'upstream resolve failed'], 'mp4 路由:域名解析到内网 → 502,不 302');
        ok(!/rebind|127\.0\.0\.1|blocked/.test(r.body), 'mp4 路由 502:不回显域名/地址', r.body);

        // c. maccms:同一条再试一次(art.php 轮换上游)
        reset();
        let n = 0;
        R.RESOLVERS.maccms = async (ctx) => { calls.push(`${ctx.sid}-${ctx.nid}`); if (n++ === 0) return { type: 'hls', url: 'https://cdn.test/a.m3u8' }; return { type: 'mp4', url: 'https://cdn.test/c.mp4' }; };
        const rr = await K.resolve('kz_7sefun', '26976-2-1');
        eq([calls, rr.type, rr.road], [['2-1', '2-1'], 'mp4', 2], 'maccms:首次失败后同线路重试一次');

        // d. 清单预取成功 → m3u8 路由直接出微缓存;缓存过期后上游 403,重解析变成 mp4 → 409 指路,随后 ep 答 mp4
        reset(); plStatus = 200; n = 0;
        R.RESOLVERS.maccms = async (ctx) => { calls.push(`${ctx.sid}-${ctx.nid}`); return n++ === 0 ? { type: 'hls', url: 'https://cdn.test/d.m3u8' } : { type: 'mp4', url: 'https://cdn.test/d.mp4' }; };
        r = await get('/api/kz/ep/kz_7sefun/26976-2-3');
        eq([r.status, JSON.parse(r.body).type], [200, 'hls'], 'ep:hls 且清单可取');
        r = await get('/api/kz/m3u8/kz_7sefun/26976-2-3.m3u8');
        ok(r.status === 200 && r.body.includes('https://cdn.test/seg1.ts'), 'm3u8 路由:预取的清单(已绝对化)', r);
        eq(calls.length, 1, 'm3u8 路由:命中预取微缓存,不再打上游');
        I.caches.playlistCache.clear(); plStatus = 403;
        r = await get('/api/kz/m3u8/kz_7sefun/26976-2-3.m3u8');
        eq([r.status, r.body], [409, JSON.stringify({ type: 'mp4', url: '/api/kz/mp4/kz_7sefun/26976-2-3' })], 'm3u8 路由:重解析变 mp4 → 409 指路(不是笼统 502)');
        r = await get('/api/kz/ep/kz_7sefun/26976-2-3');
        eq(JSON.parse(r.body).type, 'mp4', 'ep:重解析结果已入缓存,下次直接答 mp4');

        // e. 同线路同名兄弟条目(DM84 电影:一条线路两个"高清")
        reset();
        const syn = fx('dm_detail.html').replace(/<ul class="play_list current">[\s\S]*?<\/ul>/, '<ul class="play_list current"><li><a href="/p/5893-1-1.html">高清</a></li><li><a href="/p/5893-1-2.html">高清</a></li></ul>');
        const mv = I.parseDetailHtml(dm, '5893', syn.replace(/\/p\/5963-\d+-\d+\.html/g, '/p/5963-9-9.html'));
        I.caches.detailCache.set('kz_dm84|5893', mv, 600000);
        R.RESOLVERS.hhjx = async (ctx) => { calls.push(`${ctx.sid}-${ctx.nid}`); if (ctx.nid === '1') throw new Error('url 解密失败'); return { type: 'mp4', url: 'https://cdn.test/m.mp4' }; };
        const rm = await K.resolve('kz_dm84', '5893-1-1');
        eq([calls, rm.url], [['1-1', '1-2'], 'https://cdn.test/m.mp4'], '回退:同线路同名镜像条目');

        // f. 第一次的错误被保留(而不是回退链末端的错误)
        reset();
        R.RESOLVERS.hhjx = async (ctx) => { if (ctx.sid === '2') throw new Error('first-cause'); throw new Error('later'); };
        const ef = await K.resolve('kz_dm84', '5963-2-2').then(() => null, (e) => e);
        ok(ef && /^first-cause \(fallback 1,3 also failed\)$/.test(ef.message), '回退全败:报第一次的错误', ef && ef.message);
    } finally {
        Object.assign(R.RESOLVERS, realRes); R.getText = realGetText; R._dnsImpl.lookup = realLookup; R._dnsVerdicts.clear();
        I.caches.resolveCache.clear(); I.caches.playlistCache.clear(); I.caches.detailCache.clear();
        srv.close();
    }
}

// ============ 7. titlematch 回归(源自 202 条真实结果) + UMD 浏览器加载 ============
{
    const tc = JSON.parse(fx('titlematch-cases.json'));
    let coreBad = 0;
    for (const [inp, want] of tc.core) if (T.coreKeyword(inp) !== want) { coreBad++; ok(false, 'coreKeyword ' + inp, { got: T.coreKeyword(inp), want }); }
    ok(coreBad === 0, `coreKeyword 回归 ${tc.core.length} 例`);
    const st = { html: 0, newMergedMac: 0, newMergedHtmlOnly: 0, ownCard: 0 };
    let bad = 0;
    for (const c of tc.cases) {
        const groups = new Map();
        const add = (k, p, s) => { if (!groups.has(k)) groups.set(k, { p, srcs: new Set() }); groups.get(k).srcs.add(s); };
        c.mac.forEach(([name, remarks, type], i) => {
            const p = T.parseTitle(name, { remarks, type });
            if (p.key !== c.macKeys[i]) { bad++; ok(false, 'parseTitle(mac) ' + name, { got: p.key, want: c.macKeys[i] }); }
            add(p.key, p, 'mac');
        });
        for (const [s, name, remarks, wantKey, wantHow, wantTarget] of c.html) {
            st.html++;
            const p = T.parseTitle(name, { remarks });
            const sn = T.snapToGroup(p, groups);
            const g0 = groups.get(sn.key);
            if (sn.how === 'new') st.ownCard++; else if (g0 && g0.srcs.has('mac')) st.newMergedMac++; else st.newMergedHtmlOnly++;
            if (p.key !== wantKey || sn.how !== wantHow || sn.key !== wantTarget) { bad++; ok(false, `snap ${c.tmdb} / ${s} ${name}`, { got: [p.key, sn.how, sn.key], want: [wantKey, wantHow, wantTarget] }); }
            add(sn.key, p, s);
        }
    }
    ok(bad === 0, `titlematch 逐条回归 (${tc.cases.length} 部 / ${st.html} 条 HTML 结果)`);
    eq(st, tc.stats, 'titlematch 合并统计 (162 并入 maccms / 5 并入 HTML 卡 / 35 独立)');

    // 规格中的关键例子
    eq(['【我推的孩子】', 'Re：从零开始的异世界生活', '鬼灭之刃：无限城篇 第一章 猗窝座再袭', '你的名字。'].map(T.coreKeyword), ['我推的孩子', '从零开始的异世界生活', '鬼灭之刃', '你的名字'], 'coreKeyword 规格例');
    eq(T.titleKey('葬送的芙莉莲 第二季'), T.titleKey('葬送的芙莉莲第二季'), 'key: 空格不影响');
    eq(T.titleKey('咒术回战第一季'), T.titleKey('咒术回战'), 'key: 第一季 == 裸标题');
    eq(T.titleKey('​我只想安静地打游戏 第2季​'), T.titleKey('我只想安静地打游戏第二季'), 'key: 零宽 + 阿拉伯/中文季号');
    eq(T.parseTitle('斗罗大陆Ⅱ绝世唐门').base, T.parseTitle('斗罗大陆2：绝世唐门').base, 'key: 罗马数字');
    eq(T.parseTitle('间谍过家家 S2').season, 2, 'parseTitle: sN 季号');
    eq(T.parseTitle('casts2').season, null, 'parseTitle: 词内 s2 不当季号');
    ok(T.parseTitle('鬼灭之刃 剧场版 无限列车篇').key !== T.parseTitle('鬼灭之刃 无限列车篇').key, 'key: 剧场版不与 TV 合并');
    eq(T.parseTitle('海贼王 国语').lang, '国语', 'parseTitle: 语言后缀');
    const g = new Map([[T.titleKey('败犬女主太多了'), { p: T.parseTitle('败犬女主太多了', { remarks: '12集全' }) }]]);
    eq(T.snapToGroup(T.parseTitle('败犬女主太多啦', { remarks: '12' }), g).how, 'fuzzy(0.83)', 'snap: 模糊 Dice');
    eq(T.snapToGroup('鬼灭之刃第二季(游郭篇)', [{ key: 'k1', p: '鬼灭之刃 游郭篇' }]).key, 'k1', 'snap: 数组/字符串入参 + arc-season');
    ok(T.snapToGroup('名侦探柯南 第二十五部', [{ key: 'k', p: '名侦探柯南 第二十六部' }]).how === 'new', 'snap: 数字守卫');

    // 短拉丁/数字头尾守卫回归(对抗审查):旧版 Dice 0.83–0.98 会把不同作品并卡
    const ns = tc.noSnap || [];
    const nsBad = ns.filter(([[mn, mr, mt], [hn, hr]]) => {
        const q = T.parseTitle(mn, { remarks: mr, type: mt });
        return T.snapToGroup(T.parseTitle(hn, { remarks: hr }), new Map([[q.key, { p: q }]])).how !== 'new';
    }).map((x) => x[1][0] + ' → ' + x[0][0]);
    ok(ns.length >= 7 && nsBad.length === 0, `snap: 短拉丁/数字头尾不模糊合并 (${ns.length} 例)`, nsBad);
    eq(T.snapToGroup(T.parseTitle('败犬女主太多啦', { remarks: '12' }), [{ key: 'k', p: T.parseTitle('败犬女主太多了', { remarks: '12集全' }) }]).how, 'fuzzy(0.83)', 'snap: 头尾守卫不误伤中文一字之差');

    // UMD:浏览器形态(无 module)加载暴露 window.KzTitle;且不含 ES2018+ 语法隐患
    const src = fs.readFileSync(path.join(ROOT, 'public/libs/js/kz-titlematch.js'), 'utf8');
    const win = {}; vm.runInNewContext(src, { self: win, window: win });
    ok(win.KzTitle && win.KzTitle.titleKey('葬送的芙莉莲 第二季') === '葬送的芙莉莲#s2', 'UMD: <script> 形态暴露 window.KzTitle');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok(!/\?\?|\?\.[a-zA-Z_(]|\(\?<[=!]|matchAll|fromEntries/.test(code), 'UMD: 无 ?? / ?. / 后行断言 / matchAll / fromEntries');
}

console.log(`\n离线测试:${pass} 通过,${fail} 失败`);
for (const f of failures) console.log('  ✗ ' + f);

// ============ 8. 线上冒烟(--live) ============
if (process.argv.includes('--live')) await live();
process.exitCode = fail ? 1 : 0;

async function live() {
    const axios = require('axios');
    const titles = ['葬送的芙莉莲', '间谍过家家', '海贼王', '凡人修仙传'];
    const rows = [];
    const host = (u) => { try { return new URL(u).host; } catch (e) { return '?'; } };
    const express = require('express');
    const app = express(); K.registerRoutes(app);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const routeGet = async (p) => { const r = await axios.get(base + p, { validateStatus: () => true, maxRedirects: 0, transformResponse: [(d) => d] }); return r; };

    for (const site of K.getSites()) {
        const chk = await K.check(site.key);
        console.log(`\n[${site.key}] check latency=${chk.latency}ms`);
        for (const t of titles) {
            const row = { site: site.key, title: t, hits: '-', first: '-', roads: '-', type: '-', road: '-', host: '-', verify: '-', ms: 0 };
            const t0 = Date.now();
            try {
                const s = await K.search(site.key, t);
                row.hits = s.list.length;
                if (!s.list.length) throw new Error('0 hits');
                const hit = s.list[0];
                row.first = `${hit.vod_name}(${hit.vod_id})`;
                const d = (await K.detail(site.key, hit.vod_id)).list[0];
                const roads = d.vod_play_url.split('$$$');
                row.roads = `${roads.length}/${roads.map((r) => r.split('#').length).join(',')}`;
                const ep1 = roads[0].split('#')[0].split('$')[1];
                const tok = ep1.split('/').pop();
                // 走真实路由:/api/kz/ep → 同源地址
                const ep = await routeGet(`/api/kz/ep/${site.key}/${tok}`);
                if (ep.status !== 200) throw new Error(`ep route ${ep.status} ${String(ep.data).slice(0, 120)}`);
                const j = JSON.parse(ep.data);
                const r = await K.resolve(site.key, tok);
                row.type = j.type; row.road = `${tok.split('-')[1]}→${j.road}`; row.host = host(r.url);
                if (j.type === 'hls') {
                    const pl = await routeGet(j.url);
                    const n = (String(pl.data).match(/#EXTINF/g) || []).length;
                    const seg = (String(pl.data).split('\n').find((l) => /^https?:\/\//.test(l)) || '');
                    row.verify = pl.status === 200 && n > 0 ? `EXTINF×${n} seg@${host(seg)}` : pl.status === 409 ? `409→mp4 ${String(pl.data).slice(0, 60)}` : `FAIL ${pl.status} ${String(pl.data).slice(0, 60)}`;
                } else {
                    const rd = await routeGet(j.url);
                    const loc = rd.headers.location;
                    // 浏览器侧行为:跟 302,无 Referer,Range 0-1 → 期望 206
                    const m = await axios.get(loc, { headers: { 'User-Agent': R.UA, Range: 'bytes=0-1' }, responseType: 'arraybuffer', validateStatus: () => true, timeout: 15000, maxContentLength: 1 << 20 }).catch((e) => ({ status: 'ERR ' + e.code }));
                    row.verify = `302→${host(loc)} Range:${m.status}`;
                }
            } catch (e) {
                row.verify = 'ERR ' + String(e.message || e).slice(0, 90);
            }
            row.ms = Date.now() - t0;
            rows.push(row);
            console.log(`  ${t}: ${row.verify}`);
        }
    }
    // 线路回退:DM84 5963 线路1 上游已死("url 解密失败"),应自动落到同集的其它线路
    try {
        const r = await K.resolve('kz_dm84', '5963-1-1', { fresh: true });
        rows.push({ site: 'kz_dm84', title: '回退 5963-1-1', hits: '-', first: '-', roads: '-', type: r.type, road: `1→${r.road}`, host: host(r.url), verify: r.road !== 1 ? 'fallback OK' : 'road1 itself OK', ms: 0 });
    } catch (e) {
        rows.push({ site: 'kz_dm84', title: '回退 5963-1-1', hits: '-', first: '-', roads: '-', type: '-', road: '-', host: '-', verify: 'ERR ' + e.message.slice(0, 90), ms: 0 });
    }
    // art.php 轮换上游:7sefun 27876-1-1 曾在 hls(地区封锁 403)与字节 mp4 之间摇摆 —— ep 只应答"取得到"的类型
    {
        const t0 = Date.now();
        const row = { site: 'kz_7sefun', title: '轮换 27876-1-1', hits: '-', first: '-', roads: '-', type: '-', road: '-', host: '-', verify: '-', ms: 0 };
        try {
            const ep = await routeGet('/api/kz/ep/kz_7sefun/27876-1-1');
            if (ep.status !== 200) throw new Error(`ep route ${ep.status} ${String(ep.data).slice(0, 80)}`);
            const j = JSON.parse(ep.data);
            row.type = j.type; row.road = `1→${j.road}`;
            const r2 = await routeGet(j.url);
            row.verify = j.type === 'hls' ? `m3u8 ${r2.status} EXTINF×${(String(r2.data).match(/#EXTINF/g) || []).length}` : `mp4 ${r2.status}→${host(r2.headers.location)}`;
            row.host = j.type === 'hls' ? '-' : host(r2.headers.location);
        } catch (e) { row.verify = 'ERR ' + String(e.message || e).slice(0, 90); }
        row.ms = Date.now() - t0;
        rows.push(row);
    }
    srv.close();
    console.log('\n线上冒烟结果:');
    console.table(rows);
}
