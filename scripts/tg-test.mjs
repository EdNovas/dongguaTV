// [adult] TG 频道片源回归:node scripts/tg-test.mjs
//   签名(成人站 lib/adult/tg.js ↔ 中转 tg-relay/lib/common.js 两份算法一致、播放器 _isTgUrl 认得出)/ 配文整理 / 收不收 /
//   频道停用(频道名命中、未成年比例)/ 经假中转走真目录入库 / 闸门详情签名 / 中转的 Range、分块缓存、限流解析
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const TGL = require(path.join(ROOT, 'lib/adult/tg.js'));
const RC = require(path.join(ROOT, 'tg-relay/lib/common.js'));
const adult = require(path.join(ROOT, 'lib/adult'));
const { createCatalog } = require(path.join(ROOT, 'lib/site-catalog'));
const { createAdultGate } = require(path.join(ROOT, 'lib/adult-gate'));
const Database = require('better-sqlite3');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra).slice(0, 600))); } };
const SECRET = 'test-secret-0123456789';
const NOW = 1795400000;   // 秒
const ENV = { ADULT_TG_RELAY: 'https://relay.example.com', ADULT_TG_SECRET: SECRET, ADULT_TG_CHANNELS: 'TS88158:伪娘:120, ntong_1:女同, https://t.me/s/AI538, bad-name, ts88158' };

// ---------- 1. 配置 ----------
{
    const cfg = TGL.config(ENV);
    ok(cfg.on, 'config on', cfg.problems);
    ok(cfg.channels.length === 3, '频道去重 / 坏名字丢掉 / t.me 链接认得', cfg.channels);
    const ts = cfg.channels.find((c) => c.ch === 'TS88158');
    ok(ts && ts.cls === '伪娘' && ts.minSec === 120 && ts.key === 'tg_ts88158', '频道:分类 + 最短秒', ts);
    const nt = cfg.channels.find((c) => c.ch === 'ntong_1');
    ok(nt && nt.cls === '女同' && nt.minSec === 180, '默认最短 180 秒', nt);
    ok(cfg.channels.some((c) => c.ch === 'AI538' && c.cls === ''), 't.me/s/xxx 链接', cfg.channels);
    // 多个分类词:+ / 、 / 同一项里空格隔开(非频道名的词接到分类后面);空格隔开的纯频道名表照旧
    const chs = (s) => TGL.config({ ...ENV, ADULT_TG_CHANNELS: s }).channels.map((c) => c.ch + ':' + c.cls + ':' + c.minSec).join(' | ');
    ok(chs('JpSub01:日本+中文字幕') === 'JpSub01:日本+中文字幕:180', '多分类:+', chs('JpSub01:日本+中文字幕'));
    ok(chs('JpSub01:日本、中文字幕:300') === 'JpSub01:日本+中文字幕:300', '多分类:、', chs('JpSub01:日本、中文字幕:300'));
    ok(chs('JpSub01:日本 中文字幕, ntong_1:女同') === 'JpSub01:日本+中文字幕:180 | ntong_1:女同:180', '多分类:空格(不再把"中文字幕"丢了)', chs('JpSub01:日本 中文字幕, ntong_1:女同'));
    ok(chs('JpSub01:日本 中文字幕 ntong_1:女同') === 'JpSub01:日本+中文字幕:180 | ntong_1:女同:180', '多分类:空格后带冒号的是下一个频道', chs('JpSub01:日本 中文字幕 ntong_1:女同'));
    ok(chs('JpSub01:日本 中文字幕:300,ntong_1') === 'JpSub01:日本+中文字幕:300 | ntong_1::180', '多分类:空格 + 最短秒', chs('JpSub01:日本 中文字幕:300,ntong_1'));
    ok(chs('TS88158 ntong_1\nAI538')=== 'TS88158::180 | ntong_1::180 | AI538::180', '空格 / 换行隔开的频道表照旧', chs('TS88158 ntong_1\nAI538'));
    ok(chs('TS88158 中文字幕, ntong_1') === 'TS88158::180 | ntong_1::180', '没写分类的频道后面跟的词不当分类(防手滑)', chs('TS88158 中文字幕, ntong_1'));
    ok(!TGL.config({ ADULT_TG_RELAY: 'relay.example.com', ADULT_TG_SECRET: SECRET, ADULT_TG_CHANNELS: 'abcd' }).on, '中转不是 http(s) → 不启用');
    ok(!TGL.config({ ADULT_TG_RELAY: 'https://r.x', ADULT_TG_SECRET: 'short', ADULT_TG_CHANNELS: 'abcd' }).on, '密钥太短 → 不启用');
    ok(TGL.config({ ...ENV, ADULT_TG_MIN_SEC: '300' }).channels.find((c) => c.ch === 'ntong_1').minSec === 300, 'ADULT_TG_MIN_SEC');
    const tg = TGL.createTg(ENV);
    const sites = tg.sites();
    ok(sites.length === 3 && sites.every((s) => s.family === 'tg' && s.strict === true && s.search === false && s.crawl === false && /^https:\/\/relay\.example\.com\/api\/list\?ch=/.test(s.api)), 'TG 站:严格站、不搜、不走 maccms 爬虫', sites);
    tg.setKilled('tg_ai538', 'x');
    ok(tg.sites().length === 2 && !tg.sites().some((s) => s.key === 'tg_ai538'), '停用的频道不在站点表里');
    ok(TGL.createTg({}).sites().length === 0, '没配 = 空表');
}

// ---------- 2. 签名:两份算法一致 + 中转验得过 + 播放器认得出 ----------
{
    for (const [kind, ch, id, exp] of [['v', 'TS88158', 1, NOW + 100], ['t', 'ntong_1', 987654, TGL.THUMB_EXP], ['v', 'AI538', 42, NOW]]) {
        ok(TGL.sign(SECRET, kind, ch, id, exp) === RC.sign(SECRET, kind, ch, id, exp), '两边签名一致 ' + kind + ch);
    }
    ok(RC.sign(SECRET, 'v', 'TS88158', 1, 5) === RC.sign(SECRET, 'v', 'ts88158', 1, 5), '频道名不分大小写');
    const s = RC.sign(SECRET, 'v', 'TS88158', 7, NOW + 60);
    ok(RC.verify(SECRET, 'v', 'TS88158', '7', String(NOW + 60), s, NOW), 'verify 正常');
    ok(!RC.verify(SECRET, 'v', 'TS88158', '8', String(NOW + 60), s, NOW), '换消息 id 不行');
    ok(!RC.verify(SECRET, 't', 'TS88158', '7', String(NOW + 60), s, NOW), '视频签名不能当封面用');
    ok(!RC.verify(SECRET, 'v', 'TS88158', '7', String(NOW + 60), s, NOW + 61), '过期不行');
    ok(!RC.verify(SECRET + 'x', 'v', 'TS88158', '7', String(NOW + 60), s, NOW), '密钥不同不行');
    ok(!RC.verify(SECRET, 'v', '../etc', '7', String(NOW + 60), s, NOW), '频道名非法不行');
    const cfg = TGL.config(ENV);
    const pu = TGL.playUrl(cfg, 'TS88158', '123', NOW);
    const u = new URL(pu);
    ok(Number(u.searchParams.get('e')) % 3600 === 0 && Number(u.searchParams.get('e')) >= NOW + TGL.PLAY_TTL, '到期按整点、至少 48h', pu);
    ok(RC.verify(SECRET, 'v', 'TS88158', '123', u.searchParams.get('e'), u.searchParams.get('s'), NOW), '中转验得过成人站签的播放地址');
    ok(TGL.playUrl(cfg, 'TS88158', '123', NOW) === TGL.playUrl(cfg, 'TS88158', '123', NOW + 30), '同一小时内地址不变(浏览器缓存得住)');
    const tu = new URL(TGL.thumbUrl(cfg, 'TS88158', '123'));
    ok(/^\/t\/TS88158\/123\.jpg$/.test(tu.pathname) && RC.verify(SECRET, 't', 'TS88158', '123', tu.searchParams.get('e'), tu.searchParams.get('s'), NOW), '封面地址:长期有效、中转验得过', tu.href);
    ok(TGL.signPlayUrls(cfg, '正片$tg://TS88158/123', NOW) === '正片$' + pu, 'tg:// → 签名地址');
    ok(TGL.signPlayUrls(cfg, '第1集$https://x.com/a.m3u8', NOW) === '第1集$https://x.com/a.m3u8', '别的地址不动');
    // 卡片预览片地址(/p/,签名种类 p:拿播放 / 封面的签名换不来)
    const pvu = new URL(TGL.previewOf(cfg, '正片$tg://TS88158/123', NOW));
    ok(pvu.pathname === '/p/TS88158/123' && RC.verify(SECRET, 'p', 'TS88158', '123', pvu.searchParams.get('e'), pvu.searchParams.get('s'), NOW), '预览片地址:中转验得过', pvu.href);
    ok(!RC.verify(SECRET, 'v', 'TS88158', '123', pvu.searchParams.get('e'), pvu.searchParams.get('s'), NOW), '预览片签名不能拿去取整个视频');
    ok(TGL.previewOf(cfg, '正片$https://x.com/a.m3u8', NOW) === '' && TGL.previewOf({ on: false }, '正片$tg://TS88158/1', NOW) === '', '不是 tg:// / 没启用 → 没有预览片');
    // 播放器的 _isTgUrl(从 index.html 抽出来)
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const m = html.match(/_isTgUrl\(u\) \{ return typeof u === 'string' && (\/\^.*?\$\/)\.test\(u\); \}/);
    ok(!!m, 'index.html 里有 _isTgUrl');
    if (m) {
        const re = new Function('return ' + m[1])();
        ok(re.test(pu), '_isTgUrl 认得签名地址', pu);
        ok(!re.test('https://relay.example.com/v/TS88158/123'), '_isTgUrl:没签名不算');
        ok(!re.test('https://cdn.example.com/v/abc/index.m3u8'), '_isTgUrl:普通地址不算');
        ok(!re.test('tg://TS88158/123'), '_isTgUrl:没签名的 tg:// 不算');
    }
    // 中转路由认得签名地址的路径
    const relaySrc = fs.readFileSync(path.join(ROOT, 'tg-relay/server.js'), 'utf8');
    const rm = relaySrc.match(/const m = (\/\^\\\/\(\[vtp\]\).*?\$\/)\.exec\(u\.pathname\);/);
    ok(!!rm, '中转 server.js 的路由正则');
    if (rm) {
        const re = new Function('return ' + rm[1])();
        ok(re.test(new URL(pu).pathname) && re.test(tu.pathname) && re.test(pvu.pathname), '中转路由认得播放 / 封面 / 预览片地址');
    }
}

// ---------- 3. Range ----------
{
    const r = RC.parseRange;
    ok(JSON.stringify(r('bytes=0-', 1000)) === '[0,999]', 'bytes=0-');
    ok(JSON.stringify(r('bytes=100-199', 1000)) === '[100,199]', 'bytes=a-b');
    ok(JSON.stringify(r('bytes=900-5000', 1000)) === '[900,999]', '超过结尾截到结尾');
    ok(JSON.stringify(r('bytes=-100', 1000)) === '[900,999]', '最后 n 字节');
    ok(r('bytes=1000-', 1000) === false && r('bytes=5-4', 1000) === false, '越界 → 416');
    ok(r('items=0-1', 1000) === null && r('', 1000) === null, '不认得的 Range → 整个文件');
}

// ---------- 4. 配文整理 ----------
{
    const c1 = TGL.cleanCaption('#伪娘 #tscd #雌堕 #人妖 黑丝伪娘小姐姐被大屌狠狠插入 真的好爽');
    ok(c1.meaningful && c1.tags.join() === '伪娘,tscd,雌堕,人妖' && !/#/.test(c1.body), '标签拆出来、正文留下', c1);
    ok(!TGL.cleanCaption('#伪娘 #人妖 #tscd').meaningful, '只有标签 = 没正文');
    ok(!TGL.cleanCaption('https://t.me/abcde @somechannel 🔥🔥🔥').meaningful, '只有链接 / @ / 表情 = 没正文');
    const c2 = TGL.cleanCaption('🥰【独家系列】极品伪娘颜值很高 想看完整无码版？点击加入会员，解锁全部精彩内容！\n频道:@abcd');
    ok(c2.meaningful && !/会员|频道|解锁/.test(c2.body) && /极品伪娘/.test(c2.body), '引流话术后面整段丢', c2.body);
    const c3 = TGL.cleanCaption('Hot femboy gets fucked hard\n#femboy');
    ok(c3.meaningful && c3.tags[0] === 'femboy', '英文正文');
    ok(!TGL.cleanCaption('投稿: @xxxx\n商务: @yyyy').meaningful, '只有投稿 / 商务行 = 没正文');
}

// ---------- 5. 收不收 ----------
{
    const cfg = TGL.config(ENV);
    const ch = cfg.channels.find((c) => c.ch === 'TS88158');
    const base = { id: 5, date: NOW, text: '#伪娘 黑丝伪娘在酒店自慰 射了好多', dur: 637, w: 1280, h: 720, mime: 'video/mp4', thumb: true };
    const a = TGL.toVod(cfg, ch, base, '伪娘');
    ok(a.ok && a.counted, '正常的收', a);
    ok(a.vod.vod_play_url === '正片$tg://TS88158/5' && a.vod.vod_duration === '10:37' && a.vod.type_name === '伪娘' && a.vod.vod_tag === '伪娘', '条目字段', a.vod);
    ok(/^https:\/\/relay\.example\.com\/t\/TS88158\/5\.jpg\?e=/.test(a.vod.vod_pic), '封面 = 中转封面地址');
    const b = TGL.toVod(cfg, ch, Object.assign({}, base, { dur: 60 }), '伪娘');
    ok(!b.ok && b.counted && b.reason === 'tg:short', '太短不收(但算进比例)', b);
    const c = TGL.toVod(cfg, ch, Object.assign({}, base, { mime: 'video/x-matroska', name: 'a.mkv' }), '伪娘');
    ok(!c.ok && c.counted && c.reason === 'tg:mime', 'mkv 不收');
    // 用户 2026-11-24:只有标签也收(标签当片名过硬过滤、算比例);片名带消息号,一个字都没有的才不收
    const d = TGL.toVod(cfg, ch, Object.assign({}, base, { text: '#锅包柚 #伪娘 #男娘 #TS极品 #TS 109V' }), '伪娘');
    ok(d.ok && d.counted && d.vod.vod_name === '锅包柚 伪娘 男娘 TS极品 TS · 109V #5' && d.vod.vod_tag === '锅包柚,伪娘,男娘,TS极品,TS', '只有标签:收,片名 = 标签 + 剩下几个字 + 消息号', d.vod);
    for (const t of ['', '   ', '#2023 #12', 'https://t.me/abcde @somechannel 🔥🔥🔥', '投稿: @xxxx\n商务: @yyyy']) {
        const e = TGL.toVod(cfg, ch, Object.assign({}, base, { text: t }), '伪娘');
        ok(!e.ok && !e.counted && e.reason === 'tg:notext', '一个字都没有 / 纯数字标签 / 只有链接和引流 → 不收、不算比例: ' + JSON.stringify(t), e);
    }
    const g1 = TGL.toVod(cfg, ch, Object.assign({}, base, { gid: '123' }), '伪娘'), g2 = TGL.toVod(cfg, ch, Object.assign({}, base, { id: 6, gid: '123' }), '伪娘');
    ok(g1.vod.vod_name === '黑丝伪娘在酒店自慰 射了好多 #5' && g2.vod.vod_name === '黑丝伪娘在酒店自慰 射了好多 #6' && a.vod.vod_name === '黑丝伪娘在酒店自慰 射了好多', '相册里共用配文的片名带消息号(不然按片名并成一部);单条不带(能和资源站按片名合并)', [g1.vod.vod_name, a.vod.vod_name]);
    const TT = require(path.join(ROOT, 'lib/adult/title.js'));
    ok(TT.parseTitle(g1.vod.vod_name, '伪娘').titleKey !== TT.parseTitle(g2.vod.vod_name, '伪娘').titleKey && !TT.parseTitle(d.vod.vod_name, '伪娘').code, '消息号让片名键各不相同,也不被当成番号');
    const m = TGL.toVod(cfg, ch, Object.assign({}, base, { text: '#伪娘 #萝莉' }), '伪娘');
    const PM = require(path.join(ROOT, 'lib/adult/policy.js'));
    ok(m.counted && !PM.checkItem(m.vod, { strict: true, strictFloor: false, siteTrust: false }).ok, '只有标签的照样过硬过滤(#萝莉 拦)');
    ok(TGL.toVod(cfg, ch, Object.assign({}, base, { mime: 'video/quicktime' }), '伪娘').ok, 'mov 收');
    ok(TGL.hms(3725) === '1:02:05' && TGL.hms(59) === '0:59', 'hms');
    const U = require(path.join(ROOT, 'lib/site-catalog/util.js'));
    ok(U.parseDur(TGL.hms(637)) === 637 && U.parseDur(TGL.hms(3725)) === 3725, '目录 parseDur 读得回 hms');
    ok(a.vod.tg_fsize === 0 && TGL.toVod(cfg, ch, Object.assign({}, base, { size: 123456789 }), '伪娘').vod.tg_fsize === 123456789, '条目带文件字节数(认同一个文件用)');
}

// ---------- 5b. 片名(TG_RULES 3,用户 2026-11-25):括号里的标签算正文、字段行 / 分隔线不当片名、带上编号 ----------
{
    const cfg = TGL.config(ENV);
    const ch = cfg.channels.find((c) => c.ch === 'TS88158');
    const nm = (text, extra) => TGL.toVod(cfg, ch, Object.assign({ id: 27, date: NOW, text, dur: 637, mime: 'video/mp4' }, extra || {}), '伪娘').vod.vod_name;
    ok(nm('【#欧美女主调教私奴虐阳】\n编号：#OS2023111002\n女主：#Alora #Alika\n出品：#CBT\n标签：#欧美FEMDOM') === '【欧美女主调教私奴虐阳】 OS2023111002', '括号里的标签留字 + 编号接在后面(不再是「【 】 编号」)', nm('【#欧美女主调教私奴虐阳】\n编号：#OS2023111002'));
    ok(nm('标题:美妖化为中间插头了\n#伪娘') === '美妖化为中间插头了', '去掉「标题:」');
    ok(nm('标题:护士伪娘遭主人龟头虐后猛入 简介:可爱伪娘肉棒被撸到崩溃 标签') === '护士伪娘遭主人龟头虐后猛入', '一行几个字段:片名到下一个字段名为止');
    ok(!/─/.test(nm('◤硬邦邦◢  \n───────  \n博主：#czu\n\n简评：散步时掀裙子好刺激')), '分隔线不进片名', nm('◤硬邦邦◢  \n───────  \n博主：#czu\n\n简评：散步时掀裙子好刺激'));
    ok(nm('伪娘:莹 国产人妖母狗莹内射精后舔食自己的精液~') === '伪娘:莹 国产人妖母狗莹内射精后舔食自己的精液~', '不认识的"xx:"开头照样是正文');
    ok(nm('#人夫伪娘 #人妖 #熟女\n\n只要能让其进入到喉咙 应该能吞下很长的肉棒') === '只要能让其进入到喉咙 应该能吞下很长的肉棒', '普通配文片名不变');
    const S = require(path.join(ROOT, 'lib/site-catalog/tg-same.js'));
    ok(S.similarTitle('最美韩国ts逆天颜值公主极品闺蜜▌Sugar▌3P爆肏极品小妹_双头龙互插嫩鲍后庭', '最美韩TS逆天颜值公主极品闺蜜Sugar 3P狂肏小骚妹双头龙互插嫩鲍后庭谁更浪 #20') > 0, '相似片名:改了几个字');
    ok(S.similarTitle('女王调教胖奴_边操边撸双重刺激很享受', '标题:超美的妖妖时诗君君黑丝女王调教胖奴_边操边撸双重刺激很享受 #88') > 0, '相似片名:一边前面多了博主名 / 标题: / 消息号');
    ok(S.similarTitle('伪娘户外露出', '眼镜伪娘户外露出') === 0 && S.similarTitle('浴室play浴室play', '古风伪娘御姐Bela浴室play,坐在浴缸里搔首弄姿') === 0, '泛标题(太短)不算');
    ok(S.similarTitle('伪娘Kyla最新视频完整版(1V,18min)已更新', '伪娘Kyla最新视频完整版(2V,共60min)已更新') === 0, '数字对不上不算(1V / 2V)');
    ok(S.similarTitle('黑丝伪娘小姐姐酒店里被大屌猛操 第一部', '黑丝伪娘小姐姐酒店里被大屌猛操 第二部') === 0 && S.similarTitle('黑丝伪娘小姐姐酒店里被大屌猛操 上集', '黑丝伪娘小姐姐酒店里被大屌猛操 下集') === 0, '上下集 / 第几部不算');
    ok(S.stripMsgNo('伪娘 人妖 #123') === '伪娘 人妖' && S.stripMsgNo('第2部') === '第2部', 'stripMsgNo 只去末尾的 #消息号');
}

// ---------- 6. 经假中转走真目录:收 / 拦 / 停用 / 进度 ----------
const captions = {
    good: (i) => '#伪娘 #人妖 黑丝伪娘小姐姐第' + i + '部 酒店里被大屌猛操',
    minor: '#伪娘 萝莉装男娘穿黑丝自慰 射了好多',
};
function mkRelay() {
    const calls = [];
    const flags = { warm404: false };
    const chans = {
        TS88158: { info: { title: '伪娘男娘TS人妖 精品收藏', about: '', members: 41736, top: 30 }, msgs: [] },
        ntong_1: { info: { title: '萝莉女同合集', about: '', members: 100, top: 3 }, msgs: [] },
        AI538: { info: { title: '🌈TS人妖CD伪娘甄选阁', about: '', members: 9920, top: 400 }, msgs: [] },
    };
    for (let i = 1; i <= 30; i++) {
        const m = { id: i, date: NOW - 86400 * (40 - i), text: captions.good(i), dur: 600 + i, w: 1280, h: 720, mime: 'video/mp4', thumb: true, size: 1e8 };
        if (i === 7) m.dur = 60;                    // 太短
        if (i === 8) m.text = '';                     // 一个字都没有
        if (i === 10) m.text = '#伪娘博主小美 #人妖';     // 只有标签:照样收
        if (i === 9) m.text = captions.minor;         // 未成年:1 条(< 2 条,不停用;这一条被硬过滤拦)
        chans.TS88158.msgs.push(m);
    }
    chans.ntong_1.msgs.push({ id: 1, date: NOW, text: '女同百合 姐姐们在床上互相舔', dur: 900, mime: 'video/mp4', thumb: true });
    for (let i = 1; i <= 160; i++) {
        const m = { id: i, date: NOW - 86400, text: captions.good(i), dur: 700, mime: 'video/mp4', thumb: true };
        if (i >= 120 && i % 10 === 0) { m.text = captions.minor; m.dur = 30; }   // 第 2 页 4 条预告片带未成年(4/160 = 2.5%):太短本来不收,照样算进比例
        chans.AI538.msgs.push(m);
    }
    const fetch = async (url, opts) => {
        const u = new URL(url);
        calls.push(u.pathname + u.search);
        const auth = (opts && opts.headers && opts.headers.authorization) || '';
        const json = (code, j) => ({ ok: code === 200, status: code, json: async () => j });
        if (auth !== 'Bearer ' + SECRET) return json(401, { error: 'UNAUTHORIZED' });
        if (u.pathname === '/api/health') return json(200, { ok: true, usable: 1, streams: 2, cache: { chunks: 3, bytes: 3 * 1048576, cap: 800 * 1073741824 }, fromTg: 5, fromCache: 1, accounts: [{ name: 'a1', ok: true, floodSec: 0, active: 1, served: 9, errors: 0 }, { name: 'a2', ok: false, dead: 'SESSION_REVOKED', floodSec: 0, active: 0, served: 0, errors: 2 }] });
        if (u.pathname === '/api/warm') return flags.warm404 ? json(404, { error: 'NOT_FOUND' }) : json(200, { ok: true, on: true, queued: (u.searchParams.get('ids') || '').split(',').length, have: 0 });
        const ch = u.searchParams.get('ch');
        const c = chans[ch];
        if (!c) return json(404, { error: 'USERNAME_NOT_OCCUPIED' });
        if (u.pathname === '/api/msg') {
            const m = c.msgs.find((x) => x.id === Number(u.searchParams.get('id')));
            return m ? json(200, { ok: true, ch, item: m }) : json(404, { error: 'NOT_VIDEO' });
        }
        const after = Number(u.searchParams.get('after')) || 0, limit = Number(u.searchParams.get('limit')) || 100;
        const rows = c.msgs.filter((m) => m.id > after).slice(0, limit);
        const next = rows.length ? rows[rows.length - 1].id : after;
        return json(200, { ok: true, ch, info: u.searchParams.get('info') === '1' ? c.info : null, next, done: rows.length < limit, items: rows });
    };
    return { fetch, calls, chans, flags };
}
{
    const relay = mkRelay();
    const tg = TGL.createTg(ENV);
    const db = new Database(':memory:');
    let now = NOW * 1000;
    const logs = [];
    const cat = createCatalog({ db, getSites: () => tg.sites(), adult, httpGet: async () => { throw new Error('no maccms'); }, log: (m) => logs.push(m), env: {}, now: () => now, sleep: async () => {}, tg, fetch: relay.fetch });
    await cat.tgKick();
    const rows = (site) => db.prepare('SELECT * FROM adult_items WHERE site=?').all(site);
    const ts = rows('tg_ts88158');
    // 30 条:7 太短、8 没正文、9 未成年(被硬过滤拦)→ 收 27
    ok(ts.length === 27, 'TS88158 收 27 条', { n: ts.length, logs: logs.slice(-5) });
    ok(ts.every((r) => /^正片\$tg:\/\/TS88158\/\d+$/.test(r.play_url)), '库里存 tg://(不存签名地址)');
    ok(!ts.some((r) => ['7', '8', '9'].includes(String(r.vod_id))), '太短 / 没正文 / 未成年 都不在库里');
    const t10 = ts.find((r) => String(r.vod_id) === '10');
    ok(t10 && t10.name === '伪娘博主小美 人妖 #10', '只有标签的帖子收进来,片名带消息号', t10 && t10.name);
    ok(ts.every((r) => /^https:\/\/relay\.example\.com\/t\/TS88158\//.test(r.pic)), '封面是中转地址');
    const meta = (k) => { const r = db.prepare('SELECT v FROM adult_meta WHERE k=?').get(k); return r ? JSON.parse(r.v) : null; };
    const st = meta('tg:tg_ts88158');
    ok(st && st.cur === 30 && st.n === 29 && st.minor === 1, '进度:拉到 30、有正文 29 条、未成年 1 条', st);
    // ntong_1:频道名命中 → 停用
    ok(meta('admin:tg-kill:tg_ntong_1') && rows('tg_ntong_1').length === 0, '频道名命中硬过滤 → 停用、一条不收', meta('admin:tg-kill:tg_ntong_1'));
    // AI538:第 2 页里 4 条未成年(就算本来太短不收)→ 停用,第 1 页收的也删掉
    ok(meta('admin:tg-kill:tg_ai538') && rows('tg_ai538').length === 0, '未成年 ≥2 条且 ≥2% → 停用并删掉已收的', { kill: meta('admin:tg-kill:tg_ai538'), n: rows('tg_ai538').length });
    ok(logs.some((l) => /AI538 已停用.*删掉已收的 100 条/.test(l)), '第 1 页收的 100 条被删', logs.filter((l) => /AI538/.test(l)));
    ok(!tg.sites().some((s) => s.key === 'tg_ai538' || s.key === 'tg_ntong_1'), '停用的频道不再出现在站点表');
    ok(logs.some((l) => /AI538 已停用/.test(l)), '停用写日志');
    // 作品页:TG 线路有播放地址(tg://),过了 3 天也有
    const wk = ts[0].wk;
    let w = await cat.work(wk);
    ok(w && w.sources && w.sources[0] && /tg:\/\/TS88158\//.test(w.sources[0].vod_play_url || ''), '作品页给 tg:// 地址', w && w.sources);
    now += 5 * 86400e3;
    w = await cat.work(wk);
    ok(w && w.sources[0] && /tg:\/\//.test(w.sources[0].vod_play_url || ''), '5 天后照样给(TG 不受 3 天限制)');
    // 第二轮:从 30 往后拉;新帖子进来
    relay.chans.TS88158.msgs.push({ id: 31, date: NOW, text: captions.good(31), dur: 800, mime: 'video/mp4', thumb: true });
    relay.calls.length = 0;
    await cat.tgKick();
    ok(relay.calls.some((c) => /ch=TS88158&after=30&/.test(c)), '第二轮从上次的进度往后拉', relay.calls);
    ok(!relay.calls.some((c) => /ch=AI538|ch=ntong_1/.test(c)), '停用的频道不再去拉', relay.calls);
    ok(rows('tg_ts88158').length === 28, '新帖子收进来');
    const sts = cat.tgStatus();
    ok(sts.length === 3 && sts.find((x) => x.ch === 'AI538').killed && sts.find((x) => x.ch === 'TS88158').cur === 31, 'tgStatus', sts);
    const sTs = sts.find((x) => x.ch === 'TS88158'), sAi = sts.find((x) => x.ch === 'AI538');
    ok(sTs.items === 28 && sAi.items === 0, '后台:收录数 = 库里还在的线路(停用的删光 = 0)', { ts: sTs.items, ai: sAi.items });
    ok(sTs.sk.short === 1 && sTs.sk.notext === 1 && sTs.rej === 1 && sTs.cls === '伪娘' && !sTs.err && sTs.at > 0, '后台:累计 太短 / 没正文 / 入库被拦,配置的分类', sTs);
    ok(/^未成年 \d+\/\d+$/.test(sAi.killed) && sAi.killedAt > 0, '后台:停用原因和时间', sAi);
    const info = await cat.tgInfo();
    ok(info.on === true && !info.problems.length && info.relay === 'https://relay.example.com' && !JSON.stringify(info).includes(SECRET), '后台:配置齐、给中转地址、不带密钥', info);
    ok(info.account && info.account.ok && info.account.usable === 1 && info.account.accounts.length === 2 && info.account.accounts[1].dead === 'SESSION_REVOKED', '后台:中转账号状态', info.account);
    const offInfo = await createCatalog({ db: new Database(':memory:'), getSites: () => [], adult, httpGet: async () => { throw new Error('x'); }, log: () => {}, env: {}, tg: TGL.createTg({ ADULT_TG_RELAY: 'https://relay.example.com' }), fetch: relay.fetch }).tgInfo();
    ok(offInfo.on === false && offInfo.problems.some((p) => /ADULT_TG_CHANNELS/.test(p)) && offInfo.problems.some((p) => /ADULT_TG_SECRET/.test(p)) && offInfo.account === null, '后台:没配齐说缺哪个', offInfo);
    // 用户 2026-11-24:TG 不强制审查级 filter → 干净的帖子能进推荐位(严格站的拦截规则照旧:上面未成年那条照样拦)
    ok(tg.sites().every((s) => s.strict === true && s.strictFloor === false), 'TG 站:strict 拦截照旧、strictFloor:false');
    const revs = db.prepare("SELECT COUNT(*) n FROM adult_items WHERE site='tg_ts88158' AND COALESCE(review,'') <> ''").get().n;
    ok(revs === 0, 'TG 干净帖子审查级为空(能进首页 / 相关 / 刷一刷 / 猜你喜欢)', revs);
    const wrev = db.prepare("SELECT COUNT(*) n FROM adult_works w WHERE w.wk IN (SELECT wk FROM adult_items WHERE site='tg_ts88158') AND COALESCE(w.review,'') <> ''").get().n;
    ok(wrev === 0, 'TG 作品审查级为空', wrev);
    // 收录规则升级(TGL.TG_RULES):已经读到头的频道从头再读一遍,计数重算(不翻倍)、线路不重复
    {
        const stOld = meta('tg:tg_ts88158');
        ok(stOld.rv === TGL.TG_RULES, '进度里记着收录规则版本', stOld);
        db.prepare('UPDATE adult_meta SET v=? WHERE k=?').run(JSON.stringify(Object.assign({}, stOld, { rv: 1 })), 'tg:tg_ts88158');
        relay.calls.length = 0;
        await cat.tgKick(true);
        const st2 = meta('tg:tg_ts88158');
        ok(relay.calls.some((c) => /ch=TS88158&after=0&/.test(c)) && st2.rv === TGL.TG_RULES && st2.cur === 31 && st2.n === stOld.n && st2.minor === stOld.minor, '规则升级:从头再读,计数重算不翻倍', { calls: relay.calls, st2, stOld });
        ok(rows('tg_ts88158').length === 28 && logs.some((l) => /TS88158:收录规则改到 v\d+,从头再读一遍/.test(l)), '规则升级:线路不重复、写日志');
        relay.calls.length = 0;
        await cat.tgKick(true);
        ok(relay.calls.some((c) => /ch=TS88158&after=31&/.test(c)), '升级完之后照常往后拉', relay.calls);
    }
    // 重启(新的 tg 实例):停用状态从库里读回来
    const tg2 = TGL.createTg(ENV);
    const cat2 = createCatalog({ db, getSites: () => tg2.sites(), adult, httpGet: async () => { throw new Error('x'); }, log: () => {}, env: {}, now: () => now, sleep: async () => {}, tg: tg2, fetch: relay.fetch });
    await cat2.tgKick();
    ok(!tg2.sites().some((s) => s.key === 'tg_ai538'), '重启后停用照旧');
    // 用户 2026-11-24:env 里频道分类标错了,改了重启 → 已收的要按新分类改过来(从头再读一遍,原地更新)
    {
        const restart = (chs) => {
            const t = TGL.createTg(Object.assign({}, ENV, { ADULT_TG_CHANNELS: chs }));
            const lg = [];
            return { lg, c: createCatalog({ db, getSites: () => t.sites(), adult, httpGet: async () => { throw new Error('x'); }, log: (m) => lg.push(m), env: {}, now: () => now, sleep: async () => {}, tg: t, fetch: relay.fetch }) };
        };
        const dropCfg = () => { const s = meta('tg:tg_ts88158'); delete s.cfgCls; db.prepare('UPDATE adult_meta SET v=? WHERE k=?').run(JSON.stringify(s), 'tg:tg_ts88158'); };
        const b0 = rows('tg_ts88158').map((r) => r.bucket);
        ok(meta('tg:tg_ts88158').cfgCls === '伪娘', '进度里记着配置的分类', meta('tg:tg_ts88158'));
        // 旧进度(没记 cfgCls)、分类没变 → 不重读
        dropCfg();
        relay.calls.length = 0;
        let r = restart('TS88158:伪娘:120');
        await r.c.tgKick(true);
        ok(relay.calls.some((c) => /ch=TS88158&after=31&/.test(c)) && meta('tg:tg_ts88158').cfgCls === '伪娘', '旧进度、分类没变:照常往后拉,补记分类', relay.calls);
        // 改分类 → 从头再读,已收的原地改分类 / 大类,条数不变
        relay.calls.length = 0;
        r = restart('TS88158:欧美:120');
        await r.c.tgKick(true);
        let ts2 = rows('tg_ts88158');
        ok(relay.calls.some((c) => /ch=TS88158&after=0&/.test(c)) && r.lg.some((l) => /TS88158:分类改成「欧美」,从头再读一遍/.test(l)), '改分类:从头再读、写日志', { calls: relay.calls, lg: r.lg });
        ok(ts2.length === 28 && ts2.every((x) => x.type_name === '欧美') && ts2.some((x, i) => x.bucket !== b0[i]), '改分类:已收的改成新分类和大类、不重复', ts2.map((x) => [x.type_name, x.bucket]).slice(0, 3));
        ok(meta('tg:tg_ts88158').cur === 31 && meta('tg:tg_ts88158').cfgCls === '欧美', '改分类:读完进度回到原处', meta('tg:tg_ts88158'));
        relay.calls.length = 0;
        await r.c.tgKick(true);
        ok(relay.calls.some((c) => /ch=TS88158&after=31&/.test(c)), '改完之后照常往后拉', relay.calls);
        // 用户 2026-11-24:一个频道多个分类词(日本 中文字幕)→ 大类按规则表先命中的、标签全要
        r = restart('TS88158:日本 中文字幕:120');
        await r.c.tgKick(true);
        ts2 = rows('tg_ts88158');
        const wtags = db.prepare(`SELECT tags FROM adult_works WHERE wk=?`).get(ts2[0].wk).tags || '';
        ok(ts2.length === 28 && ts2.every((x) => x.type_name === '日本+中文字幕' && x.bucket === 'jp_subbed') && /(^|,)subbed(,|$)/.test(wtags), '多分类词:日本·中文字幕大类 + 中字标签', { b: ts2.map((x) => [x.type_name, x.bucket]).slice(0, 2), wtags });
        // 部署前就改过(旧进度没记 cfgCls,库里分类名对不上)→ 也从头再读
        dropCfg();
        relay.calls.length = 0;
        r = restart('TS88158:伪娘:120');
        await r.c.tgKick(true);
        ts2 = rows('tg_ts88158');
        ok(relay.calls.some((c) => /ch=TS88158&after=0&/.test(c)) && ts2.every((x) => x.type_name === '伪娘') && ts2.map((x) => x.bucket).join() === b0.join(), '旧进度、库里分类对不上:从头再读改回来', ts2.map((x) => [x.type_name, x.bucket]).slice(0, 3));
    }

    // 用户 2026-11-24:新收录的帖子(3 天内、真进了库的)交给中转预做预览片;老帖子 / 太短 / 被硬过滤拦的不交;旧中转没有 /api/warm 不影响同步
    {
        ok(!relay.calls.some((c) => c.startsWith('/api/warm')), '老帖子(历史 / 重读)从来没交给中转预做');
        const nowS = Math.floor(now / 1000);
        relay.chans.TS88158.msgs.push(
            { id: 40, date: nowS - 3600, text: captions.good(40), dur: 800, mime: 'video/mp4', thumb: true, size: 1e8 + 40 },
            { id: 41, date: nowS - 3600, text: '#伪娘 酒店偷拍 隔壁情侣', dur: 800, mime: 'video/mp4', thumb: true, size: 1e8 + 41 },
            { id: 42, date: nowS - 3600, text: captions.good(42), dur: 30, mime: 'video/mp4', thumb: true, size: 1e8 + 42 },
            { id: 43, date: nowS - 5 * 86400, text: captions.good(43), dur: 800, mime: 'video/mp4', thumb: true, size: 1e8 + 43 },
            { id: 44, date: nowS - 60, text: captions.good(44), dur: 900, mime: 'video/mp4', thumb: true, size: 1e8 + 44 });
        relay.calls.length = 0;
        await cat2.tgKick(true);
        const wc = relay.calls.filter((c) => c.startsWith('/api/warm'));
        ok(wc.length === 1 && /^\/api\/warm\?ch=TS88158&ids=40,44$/.test(wc[0]), '只交 3 天内、真收进库的(偷拍被拦 / 太短 / 5 天前的不交)', relay.calls);
        ok(rows('tg_ts88158').some((r) => String(r.vod_id) === '43') && !rows('tg_ts88158').some((r) => String(r.vod_id) === '41'), '5 天前的照样收,只是不预做;偷拍的没进库');
        relay.flags.warm404 = true;
        relay.chans.TS88158.msgs.push({ id: 45, date: nowS - 60, text: captions.good(45), dur: 900, mime: 'video/mp4', thumb: true, size: 1e8 + 45 });
        relay.calls.length = 0;
        await cat2.tgKick(true);
        ok(relay.calls.some((c) => c.startsWith('/api/warm')) && meta('tg:tg_ts88158').cur === 45 && rows('tg_ts88158').some((r) => String(r.vod_id) === '45'), '中转是旧版本(/api/warm 404):同步照常', meta('tg:tg_ts88158'));
        relay.flags.warm404 = false;
    }

    // ---------- 7. 闸门:作品页 / 详情给签名地址 ----------
    const gate = createAdultGate({
        adult, allSites: () => tg2.sites(), tg: tg2, catalog: () => cat2, env: {},
        cache: { get: () => null, set: () => {} }, authConfigured: () => false, ownToken: () => false, isBanned: () => false,
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = relay.fetch;
    try {
        const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
        await gate.detailGet({ query: { site_key: 'tg_ts88158', id: '5' } }, res);
        const d = res.body && res.body.list && res.body.list[0];
        ok(res.code === 200 && d && /^正片\$https:\/\/relay\.example\.com\/v\/TS88158\/5\?e=\d+&s=/.test(d.vod_play_url), '详情:签名播放地址', res);
        // 2026-11-24 线上:消息号正则漏了反斜杠(/^[1-9]d{0,11}$/)→ ≥10 的帖子详情全 404,起播慢一点重试就"线路无法播放"
        for (const id of ['12', '30']) {
            const r = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
            await gate.detailGet({ query: { site_key: 'tg_ts88158', id } }, r);
            const dd = r.body && r.body.list && r.body.list[0];
            ok(r.code === 200 && dd && new RegExp('/v/TS88158/' + id + '\\?e=').test(dd.vod_play_url), '详情:两位数消息号也给签名地址 #' + id, r);
        }
        // 作品接口:TG 线路带 _pv(卡片预览片的签名地址)
        {
            const routes = {};
            gate.register(new Proxy({}, { get: (_, m) => (p, ...h) => { if (typeof p === 'string' && h.length) routes[String(m) + ' ' + p] = h[h.length - 1]; } }));
            const wr = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
            await routes['get /api/catalog/work']({ query: { k: wk }, headers: {} }, wr);
            const src = wr.body && wr.body.sources && wr.body.sources.find((x) => x.site_key === 'tg_ts88158');
            ok(wr.code === 200 && src && /^https:\/\/relay\.example\.com\/p\/TS88158\/\d+\?e=\d+&s=[A-Za-z0-9_-]{24}$/.test(src._pv || ''), '作品接口:TG 线路带预览片地址 _pv', src && src._pv);
            const PVJ = require(path.join(ROOT, 'public/adult/preview.js'));
            ok(PVJ.pickLines(wr.body, { mse: false }).length === 1 && PVJ.pickLines(wr.body)[0].mp4 === src._pv, 'preview.js 认得这个 _pv(没有 MSE 也能用)');
        }
        const res2 = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
        await gate.detailGet({ query: { site_key: 'tg_ts88158', id: '9' } }, res2);
        ok(res2.code === 404, '详情:未成年那条 404', res2);
        const res3 = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
        await gate.detailGet({ query: { site_key: 'tg_ai538', id: '1' } }, res3);
        ok(res3.code === 404, '详情:停用的频道 404');
    } finally { globalThis.fetch = realFetch; }
    try { await cat.close(); await cat2.close(); } catch (_) { /* */ }
}

// ---------- 7b. 同一个文件 / 相似片名(用户 2026-11-25:同频道重发的都显示出来了;不同频道片名很像、时长一样的也该并) ----------
{
    const chans = {
        ChanAaa: { info: { title: '伪娘频道甲', about: '', members: 10, top: 9 }, msgs: [
            { id: 1, date: NOW, text: '#伪娘 黑丝伪娘小姐姐在酒店里被大屌猛操 射了好多', dur: 700, mime: 'video/mp4', thumb: true, size: 5e8 + 1 },
            { id: 2, date: NOW, text: '#伪娘 #人妖', dur: 700, mime: 'video/mp4', thumb: true, size: 0 },   // 重发的同一个文件(先当旧库:没有字节数)
            { id: 3, date: NOW, gid: 'g1', text: '#伪娘 两个美妖穿着女仆装一起被大屌猛操', dur: 650, mime: 'video/mp4', thumb: true, size: 3e8 + 3 },
            { id: 4, date: NOW, gid: 'g1', text: '#伪娘 两个美妖穿着女仆装一起被大屌猛操', dur: 660, mime: 'video/mp4', thumb: true, size: 3e8 + 4 },
            { id: 5, date: NOW, text: '#伪娘 男娘穿着白丝在沙发上被后入 叫得好大声', dur: 800, mime: 'video/mp4', thumb: true, size: 4e8 + 5 },
        ] },
        ChanBbb: { info: { title: '伪娘频道乙', about: '', members: 10, top: 13 }, msgs: [
            { id: 10, date: NOW, text: '#人妖 最新上传 黑丝美妖酒店被干 超爽', dur: 700, mime: 'video/mp4', thumb: true, size: 5e8 + 1 },        // = 甲 1 同一个文件
            { id: 11, date: NOW, text: '#人妖 男娘穿着白丝在沙发上被后入 叫得好大声 好爽', dur: 801, mime: 'video/mp4', thumb: true, size: 2e8 + 11 },   // ≈ 甲 5(重新上传)
            { id: 12, date: NOW, text: '#人妖 男娘穿着白丝在沙发上被后入 叫得好大声', dur: 900, mime: 'video/mp4', thumb: true, size: 2e8 + 12 },       // 片名一样、时长差太多
        ] },
    };
    const fetch = async (url, opts) => {
        const u = new URL(url);
        const json = (code, j) => ({ ok: code === 200, status: code, json: async () => j });
        if (((opts && opts.headers && opts.headers.authorization) || '') !== 'Bearer ' + SECRET) return json(401, {});
        if (u.pathname === '/api/warm') return json(200, { ok: true, queued: 0 });
        const c = chans[u.searchParams.get('ch')];
        if (!c) return json(404, { error: 'USERNAME_NOT_OCCUPIED' });
        const after = Number(u.searchParams.get('after')) || 0;
        const rows = c.msgs.filter((m) => m.id > after);
        return json(200, { ok: true, info: c.info, next: rows.length ? rows[rows.length - 1].id : after, done: true, items: rows });
    };
    const E = Object.assign({}, ENV, { ADULT_TG_CHANNELS: 'ChanAaa:伪娘:120, ChanBbb:伪娘:120' });
    const tg = TGL.createTg(E);
    const db = new Database(':memory:');
    const cat = createCatalog({ db, getSites: () => tg.sites(), adult, httpGet: async () => { throw new Error('x'); }, log: () => {}, env: {}, now: () => NOW * 1000, sleep: async () => {}, tg, fetch });
    await cat.tgKick();
    const items = (site) => db.prepare('SELECT vod_id, wk, fsz, dur FROM adult_items WHERE site=? ORDER BY CAST(vod_id AS INTEGER)').all(site);
    const ids = (site) => items(site).map((r) => Number(r.vod_id));
    const wkOf = (site, id) => (items(site).find((r) => Number(r.vod_id) === id) || {}).wk;
    const meta = (k) => { const r = db.prepare('SELECT v FROM adult_meta WHERE k=?').get(k); return r ? JSON.parse(r.v) : null; };
    const workName = (wk) => (db.prepare('SELECT name FROM adult_works WHERE wk=?').get(wk) || {}).name;
    ok(ids('tg_chanaaa').join() === '1,2,3,4,5' && items('tg_chanaaa')[0].fsz === 5e8 + 1, '甲:旧库样子(2 没有字节数)全收,字节数记下', items('tg_chanaaa'));
    ok(wkOf('tg_chanbbb', 10) === wkOf('tg_chanaaa', 1), '别的频道的同一个文件(片名完全不同)→ 并进同一部、多一条线路', [wkOf('tg_chanbbb', 10), wkOf('tg_chanaaa', 1)]);
    ok(wkOf('tg_chanbbb', 11) === wkOf('tg_chanaaa', 5), '别的频道片名很像、时长差 1 秒(大小不同)→ 并进同一部');
    ok(wkOf('tg_chanbbb', 12) !== wkOf('tg_chanaaa', 5), '片名一样但时长差太多 → 不并');
    ok(wkOf('tg_chanaaa', 3) !== wkOf('tg_chanaaa', 4), '相册里共用配文的不同视频照旧各是一部');
    ok(!/#\d+$/.test(workName(wkOf('tg_chanaaa', 3))) && !/#\d+$/.test(workName(wkOf('tg_chanaaa', 4))) && !/#\d+$/.test(workName(wkOf('tg_chanaaa', 2))), '作品名不带消息号', [workName(wkOf('tg_chanaaa', 3)), workName(wkOf('tg_chanaaa', 4)), workName(wkOf('tg_chanaaa', 2))]);
    // 旧库升级:旧作品名带着消息号、重发的那条当时没认出来 → 规则升级重读一遍:重发的删掉、名字去掉消息号
    db.prepare('UPDATE adult_works SET name=? WHERE wk=?').run('两个美妖穿着女仆装一起被大屌猛操 #4', wkOf('tg_chanaaa', 4));
    const dupWk = wkOf('tg_chanaaa', 2);
    chans.ChanAaa.msgs[1].size = 5e8 + 1;
    for (const k of ['tg:tg_chanaaa', 'tg:tg_chanbbb']) { const s = meta(k); s.rv = 2; db.prepare('UPDATE adult_meta SET v=? WHERE k=?').run(JSON.stringify(s), k); }
    await cat.tgKick(true);
    ok(ids('tg_chanaaa').join() === '1,3,4,5' && !db.prepare('SELECT 1 FROM adult_works WHERE wk=?').get(dupWk), '重读:同频道重发的那条删掉(作品也没了),留最早的', ids('tg_chanaaa'));
    ok(meta('tg:tg_chanaaa').sk.dup === 1 && meta('tg:tg_chanaaa').rej === 0, '后台:重复的记在「不收 · 重复发的」,不算被拦', meta('tg:tg_chanaaa'));
    ok(workName(wkOf('tg_chanaaa', 4)) === '两个美妖穿着女仆装一起被大屌猛操' || /^两个美妖穿着女仆装一起被大屌猛操 · \d+$/.test(workName(wkOf('tg_chanaaa', 4))), '旧作品名去掉消息号', workName(wkOf('tg_chanaaa', 4)));
    ok(ids('tg_chanbbb').join() === '10,11,12' && wkOf('tg_chanbbb', 10) === wkOf('tg_chanaaa', 1) && wkOf('tg_chanbbb', 11) === wkOf('tg_chanaaa', 5), '重读后跨频道的合并不变');
    // 同频道后来又发了一次:不收
    chans.ChanAaa.msgs.push({ id: 6, date: NOW, text: '#伪娘 重发 男娘白丝沙发后入', dur: 800, mime: 'video/mp4', thumb: true, size: 4e8 + 5 });
    await cat.tgKick(true);
    ok(ids('tg_chanaaa').join() === '1,3,4,5' && meta('tg:tg_chanaaa').sk.dup === 2, '后来再重发的同一个文件不收');
    // 同一个文件在别的频道的配文被硬过滤拦下 → 这个文件哪儿都不要(已收的删掉,以后再发也不收)
    chans.ChanBbb.msgs.push({ id: 13, date: NOW, text: '#伪娘 酒店偷拍 隔壁情侣', dur: 650, mime: 'video/mp4', thumb: true, size: 3e8 + 3 });
    await cat.tgKick(true);
    ok(ids('tg_chanaaa').join() === '1,4,5' && !ids('tg_chanbbb').includes(13) && db.prepare('SELECT 1 FROM adult_tg_block WHERE fp=?').get((3e8 + 3) + ':650'), '别的频道配文是偷拍 → 甲 3(同一个文件)也删掉', ids('tg_chanaaa'));
    chans.ChanAaa.msgs.push({ id: 7, date: NOW, text: '#伪娘 两个美妖女仆装 重新发一次', dur: 650, mime: 'video/mp4', thumb: true, size: 3e8 + 3 });
    await cat.tgKick(true);
    ok(!ids('tg_chanaaa').includes(7), '被拦过的文件以后再发也不收');
    try { await cat.close(); } catch (_) { /* */ }
}

// ---------- 8. 中转:分块缓存淘汰 / 限流秒数 / 起一个真的中转(没账号)看鉴权 ----------
const relayDeps = fs.existsSync(path.join(ROOT, 'tg-relay/node_modules/telegram'));
if (!relayDeps) console.log('  (跳过中转部分:tg-relay 里还没 npm install)');
if (relayDeps) {
    const { ChunkCache, CHUNK } = require(path.join(ROOT, 'tg-relay/lib/media.js'));
    const { floodSeconds } = require(path.join(ROOT, 'tg-relay/lib/pool.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgr-'));
    const c = new ChunkCache(dir, 8 * CHUNK);
    c.init();
    const buf = Buffer.alloc(CHUNK, 1);
    for (let i = 0; i < 10; i++) await c.put('doc1', i, buf);
    ok(c.total <= 8 * CHUNK && !(await c.get('doc1', 0)) && !!(await c.get('doc1', 9)), '超上限先删最久没用的', c.stat());
    const c2 = new ChunkCache(dir, 8 * CHUNK);
    c2.init();
    ok(c2.idx.size === c.idx.size && c2.total === c.total, '重启后从磁盘认回已有的块');
    ok(new ChunkCache(dir, 20 * 1073741824).cap === 20 * 1073741824, '20GB 上限不被 32 位截坏');
    fs.rmSync(dir, { recursive: true, force: true });
    ok(floodSeconds({ seconds: 30 }) === 30, 'FloodWaitError.seconds');
    ok(floodSeconds({ errorMessage: 'FLOOD_PREMIUM_WAIT_7' }) === 7, 'FLOOD_PREMIUM_WAIT_X(非会员限速)');
    ok(floodSeconds({ errorMessage: 'FILE_REFERENCE_EXPIRED' }) === null, '别的错误不算限流');

    // login.js:验证码发到哪 / 换方式重发 / 绑邮箱 / 二步验证(假 Telegram,回的是 GramJS 真的 Api 对象)
    {
        const L = require(path.join(ROOT, 'tg-relay/login.js'));
        const { Api } = require(path.join(ROOT, 'tg-relay/node_modules/telegram'));
        ok(L.normalizePhone('+1 (984) 324-0703') === '+19843240703' && L.normalizePhone('0086 138 0000 0000') === '+8613800000000', '手机号去空格括号、00 当 +');
        ok(L.normalizePhone('13800000000') === null && L.normalizePhone('+12') === null, '不带国家码 / 太短不收');
        const SC = (type, hash, next, timeout) => new Api.auth.SentCode({ type, phoneCodeHash: hash, nextType: next, timeout });
        const dApp = L.describeSent(SC(new Api.auth.SentCodeTypeApp({ length: 5 }), 'h', new Api.auth.CodeTypeSms(), 30));
        ok(dApp.kind === 'SentCodeTypeApp' && /不是短信/.test(dApp.how) && /「Telegram」/.test(dApp.how) && dApp.next === '短信' && dApp.timeout === 30 && dApp.canUse, '发到 App:说清楚去哪看、下一种是短信', dApp);
        ok(!L.describeSent(SC(new Api.auth.SentCodeTypeFirebaseSms({}), 'h')).canUse, 'Firebase 短信标成收不到');
        ok(/fragment/.test(L.describeSent(SC(new Api.auth.SentCodeTypeFragmentSms({ url: 'https://fragment.com/x', length: 5 }), 'h')).how), 'Fragment 给链接');
        ok(/FLOOD|等 2 分钟/.test(L.zh({ errorMessage: 'FLOOD', seconds: 120 })) && /手机号不对/.test(L.zh({ errorMessage: 'PHONE_NUMBER_INVALID' })), '错误翻成中文');

        const rpc = (m) => Object.assign(new Error(m), { errorMessage: m });
        const run = async (inputs, handlers, pw) => {
            const calls = [];
            const logs = [];
            const client = {
                invoke: async (req) => { calls.push({ c: req.className, a: req }); const h = handlers[req.className]; if (!h) throw new Error('unexpected ' + req.className); return h(req, calls); },
                signInWithPassword: async (creds, p) => { calls.push({ c: 'password' }); const v = await p.password('hint'); if (v !== pw) throw rpc('PASSWORD_HASH_INVALID'); return { id: 'pw-user' }; },
            };
            const q = inputs.slice();
            const io = { ask: async (s) => { logs.push('? ' + s); return q.length ? q.shift() : 'q'; }, askHidden: async () => q.shift(), log: (s) => logs.push(s) };
            let user = null, err = null;
            try { user = await L.codeLogin(client, { apiId: 1, apiHash: 'x' }, io); } catch (e) { err = e; }
            return { user, err, calls, logs, left: q };
        };
        // A:先发到 App → r 换短信 → 输错 → 输对(带空格)→ 要二步验证
        const A = await run(['19843240703', '+1 984 324 0703', 'r', '11111', '12 345', 'secret'], {
            'auth.SendCode': () => SC(new Api.auth.SentCodeTypeApp({ length: 5 }), 'h1', new Api.auth.CodeTypeSms(), 0),
            'auth.ResendCode': (r) => (r.phoneCodeHash === 'h1' ? SC(new Api.auth.SentCodeTypeSms({ length: 5 }), 'h2', new Api.auth.CodeTypeCall(), 0) : null),
            'auth.SignIn': (r) => { if (r.phoneCodeHash !== 'h2') throw rpc('PHONE_CODE_HASH_EMPTY'); if (r.phoneCode !== '12345') throw rpc('PHONE_CODE_INVALID'); throw rpc('SESSION_PASSWORD_NEEDED'); },
        }, 'secret');
        ok(A.user && A.user.id === 'pw-user' && !A.left.length, 'App → 重发短信 → 输错再输 → 二步验证 → 登上', { err: A.err && A.err.message, calls: A.calls.map((c) => c.c), left: A.left });
        ok(A.calls[0].a.phoneNumber === '+19843240703', '没带 + 的号先被拦下,第二次的才发出去', A.calls[0].a.phoneNumber);
        ok(A.logs.some((s) => /不是短信/.test(s)) && A.logs.some((s) => /改用「短信」重发/.test(s)) && A.logs.some((s) => /验证码不对/.test(s)), '提示发到 App / 可改短信 / 输错', A.logs);
        // B:要先绑邮箱 → 邮箱验证 → 登录码发到邮箱 → 登上
        const B = await run(['+8613800000000', 'me@example.com', '777', '55555'], {
            'auth.SendCode': () => SC(new Api.auth.SentCodeTypeSetUpEmailRequired({}), 'h1'),
            'account.SendVerifyEmailCode': (r) => (r.purpose.phoneCodeHash === 'h1' && r.email === 'me@example.com' ? new Api.account.SentEmailCode({ emailPattern: 'm*@example.com', length: 3 }) : null),
            'account.VerifyEmail': (r) => (r.verification.code === '777' ? new Api.account.EmailVerifiedLogin({ email: 'me@example.com', sentCode: SC(new Api.auth.SentCodeTypeEmailCode({ emailPattern: 'm*@example.com', length: 5 }), 'h3') }) : null),
            'auth.SignIn': (r) => (r.phoneCodeHash === 'h3' && r.phoneCode === '55555' ? new Api.auth.Authorization({ user: { id: 'mail-user' } }) : null),
        });
        ok(B.user && B.user.id === 'mail-user', '要求绑邮箱 → 邮箱验证 → 邮箱收登录码 → 登上', { err: B.err && B.err.message, calls: B.calls.map((c) => c.c) });
        // C:号没注册
        const C = await run(['+12025550123', '12345'], {
            'auth.SendCode': () => SC(new Api.auth.SentCodeTypeSms({ length: 5 }), 'h1'),
            'auth.SignIn': () => new Api.auth.AuthorizationSignUpRequired({}),
        });
        ok(!C.user && C.err && /还没注册/.test(C.err.zh), '没注册的号说清楚', C.err && C.err.message);
        // D:发码就被限流
        const D = await run(['+12025550123'], { 'auth.SendCode': () => { throw Object.assign(rpc('FLOOD'), { seconds: 3600 }); } });
        ok(!D.user && D.err && /等 1 小时/.test(D.err.zh), '发码被限流给等待时间', D.err && D.err.zh);
        // E:重发时旧码过期 → 重新发
        const E = await run(['+12025550123', 'r', '24680'], {
            'auth.SendCode': (r, calls) => SC(new Api.auth.SentCodeTypeApp({ length: 5 }), 'h' + calls.length, new Api.auth.CodeTypeSms(), 0),
            'auth.ResendCode': () => { throw rpc('PHONE_CODE_EXPIRED'); },
            'auth.SignIn': (r) => (r.phoneCodeHash === 'h3' ? new Api.auth.Authorization({ user: { id: 'u3' } }) : (() => { throw rpc('PHONE_CODE_EXPIRED'); })()),
        });
        ok(E.user && E.user.id === 'u3', '重发时旧码过期就重新发码', { err: E.err && E.err.message, calls: E.calls.map((c) => c.c) });
    }

    // 预览片(tg-relay/lib/preview.js):挑段 / ffmpeg 参数;本机有 ffmpeg 就真做一个(源 moov 在文件尾、经带 Range 的 HTTP 读)
    {
        const PVR = require(path.join(ROOT, 'tg-relay/lib/preview.js'));
        const p6 = PVR.clipPlan(600), p60 = PVR.clipPlan(3600), p20 = PVR.clipPlan(20);
        ok(p6.length === 4 && p60.length === 5 && p20.length === 1 && PVR.clipPlan(3).length === 0, '挑段:10 分钟 4 段、1 小时 5 段、20 秒 1 段、3 秒不做', [p6, p60, p20]);
        ok(p6.every((c) => c.ss >= 48 && c.ss + c.t <= 600 - 36) && p60[0].ss >= 288, '掐头去尾', p6);
        const args = PVR.ffmpegArgs('http://127.0.0.1:1/v/x/1', p6, '/tmp/o.mp4');
        ok(args.filter((a) => a === '-i').length === 4 && args.includes('X-Relay-Preview: 1\r\n') && args.includes('+faststart') && args.includes('-an'), 'ffmpeg 参数:每段一个输入、带预览标记、faststart、不要声音');
        const { spawnSync } = await import('node:child_process');
        const hasFf = (() => { try { return spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0; } catch (_) { return false; } })();
        if (!hasFf) console.log('  (跳过预览片实做:本机没有 ffmpeg)');
        else {
            const http = await import('node:http');
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgpv-'));
            const src = path.join(tmp, 'src.mp4');
            spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', src]);
            const size = fs.statSync(src).size;
            let reqs = 0, pvHdr = 0;
            const srv = http.createServer((req, res) => {
                reqs++; if (req.headers['x-relay-preview'] === '1') pvHdr++;
                const rg = req.headers.range ? RC.parseRange(req.headers.range, size) : null;
                const [a, b] = rg || [0, size - 1];
                res.writeHead(rg ? 206 : 200, Object.assign({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 }, rg ? { 'Content-Range': 'bytes ' + a + '-' + b + '/' + size } : {}));
                const st = fs.createReadStream(src, { start: a, end: b }); st.pipe(res); res.on('close', () => st.destroy());
            });
            await new Promise((r) => srv.listen(0, '127.0.0.1', r));
            const warmed = [];
            const P = new PVR.Previews({ dir: path.join(tmp, 'pv'), capBytes: 64 * 1048576, meta: async (ch, id) => ({ dur: id === '2' ? 3 : 90, size }), srcUrl: () => 'http://127.0.0.1:' + srv.address().port + '/v/x/1', prefetch: (ch, id, meta, clips) => warmed.push(clips.length) });
            try {
                P.init();
                const [b1, b1b] = await Promise.all([P.get('TestCh', '1'), P.get('TestCh', '1')]);
                ok(b1 && b1.length > 2048 && b1.toString('latin1', 4, 8) === 'ftyp' && b1b.length === b1.length && P.stat().made === 1, '做出预览片(同时要两次只做一次)', P.stat());
                ok(b1.indexOf('moov') > 0 && b1.indexOf('moov') < b1.indexOf('mdat'), '预览片 moov 在前(faststart,浏览器拿到就能放)');
                ok(pvHdr > 0 && pvHdr === reqs && warmed[0] === 3, 'ffmpeg 的读都带预览标记;先预热各段', { reqs, pvHdr, warmed });
                const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path.join(tmp, 'pv', 'testch_1.mp4')], { encoding: 'utf8' });
                if (probe.status === 0) { const j = JSON.parse(probe.stdout); ok(j.streams[0].height === 360 && Math.abs(Number(j.format.duration) - 7.5) < 0.5, '360p、3 段 × 2.5 秒', j); }
                const r0 = reqs;
                ok((await P.get('testch', '1')).length === b1.length && reqs === r0 && P.stat().hits >= 1, '第二次直接读磁盘(频道名不分大小写)');
                let e2 = null; try { await P.get('TestCh', '2'); } catch (e) { e2 = e; }
                ok(e2 && e2.pvCode === 'failed', '太短做不了 → failed', e2 && e2.message);
                let e3 = null; try { await P.get('TestCh', '2'); } catch (e) { e3 = e; }
                ok(e3 && e3.pvCode === 'failed' && P.stat().fails === 1, '做不了的记住,不反复做');
                const P2 = new PVR.Previews({ dir: path.join(tmp, 'pv'), capBytes: 64 * 1048576, meta: async () => ({ dur: 90, size }), srcUrl: () => 'x' });
                P2.init();
                ok(P2.idx.size === 1 && P2.total === b1.length, '重启后认回磁盘上的预览片');
                const P3 = new PVR.Previews({ dir: path.join(tmp, 'pv3'), ffmpeg: path.join(tmp, 'no-such-ffmpeg'), meta: async () => ({}), srcUrl: () => 'x' });
                P3.init();
                let e4 = null; try { await P3.get('TestCh', '1'); } catch (e) { e4 = e; }
                ok(!P3.ok && e4 && e4.pvCode === 'no-ffmpeg', '没装 ffmpeg → no-ffmpeg');
                ok(P3.warm('TestCh', ['1']).on === false, '没装 ffmpeg 不收后台预做');
                // 后台预做:已经有的不排、同一条不重复排;中转忙(canBg 假)先不做,闲了一个一个做
                let busy = true;
                P.canBg = () => !busy; P.bgGapMs = 0; P.bgWaitMs = 30;
                const w1 = P.warm('TestCh', ['1', '3', '3', '4']);
                ok(w1.on && w1.have === 1 && w1.queued === 2, '已经有的不排、重复的只排一次', w1);
                await new Promise((r) => setTimeout(r, 300));
                ok(P.stat().bg.made === 0 && P.stat().bg.queue === 2, '中转忙:先不做', P.stat().bg);
                busy = false;
                for (let i = 0; i < 100 && P.stat().bg.made < 2; i++) await new Promise((r) => setTimeout(r, 100));
                ok(P.stat().bg.made === 2 && P.stat().bg.queue === 0 && P.idx.has('testch_3.mp4') && P.idx.has('testch_4.mp4'), '闲了就一个一个做好', P.stat().bg);
                const P4 = new PVR.Previews({ dir: path.join(tmp, 'pv4'), bg: false, meta: async () => ({ dur: 90, size }), srcUrl: () => 'x' });
                P4.init();
                ok(P4.warm('TestCh', ['1']).on === false, 'RELAY_PREVIEW_WARM=0(bg:false)不收后台预做');
            } finally { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
        }
    }

    const { spawn } = await import('node:child_process');
    const net = await import('node:net');
    const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgr-data-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'tg-relay/server.js')], {
        env: Object.assign({}, process.env, { RELAY_SECRET: SECRET, TG_API_ID: '1', TG_API_HASH: 'x', RELAY_PORT: String(port), RELAY_HOST: '127.0.0.1', RELAY_DATA: data, RELAY_CACHE_GB: '0.01' }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const base = 'http://127.0.0.1:' + port;
    try {
        for (let i = 0; i < 50 && !/监听/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
        ok(/监听/.test(out), '中转起得来(没账号也起)', out);
        const h = await fetch(base + '/healthz');
        ok(h.status === 200 && (await h.text()) === 'ok', '/healthz');
        ok((await fetch(base + '/api/list?ch=TS88158')).status === 401, '/api/list 没密钥 401');
        ok((await fetch(base + '/api/health', { headers: { authorization: 'Bearer wrong-secret-xxxxxxxx' } })).status === 401, '密钥错 401');
        const hj = await (await fetch(base + '/api/health', { headers: { authorization: 'Bearer ' + SECRET } })).json();
        ok(hj.ok && hj.usable === 0 && Array.isArray(hj.accounts), '/api/health', hj);
        ok((await fetch(base + '/v/TS88158/5?e=' + (NOW + 99999999) + '&s=' + 'A'.repeat(24))).status === 403, '签名不对 403');
        const exp = Math.floor(Date.now() / 1000) + 600;
        const sig = RC.sign(SECRET, 'v', 'TS88158', 5, exp);
        const v = await fetch(base + '/v/TS88158/5?e=' + exp + '&s=' + sig, { method: 'HEAD' });
        ok(v.status === 503, '签名对、没可用账号 → 503', v.status);
        ok(v.headers.get('access-control-allow-origin') === '*', '视频带 CORS 头(测速 HEAD 要用)');
        ok((await fetch(base + '/t/TS88158/5.jpg?e=' + exp + '&s=' + sig)).status === 403, '视频签名拿去取封面 403');
        ok((await fetch(base + '/v/TS88158/5?e=' + (Math.floor(Date.now() / 1000) - 10) + '&s=' + RC.sign(SECRET, 'v', 'TS88158', 5, Math.floor(Date.now() / 1000) - 10))).status === 403, '过期 403');
        ok((await fetch(base + '/x/../../etc/passwd')).status === 404, '别的路径 404');
        // 预览片:签名种类 p;播放签名拿来不行;签名对 → 去做(没账号 → 503 / 本机没装 ffmpeg → 501)
        ok((await fetch(base + '/p/TS88158/5?e=' + exp + '&s=' + sig)).status === 403, '播放签名拿去取预览片 403');
        const pvr = await fetch(base + '/p/TS88158/5?e=' + exp + '&s=' + RC.sign(SECRET, 'p', 'TS88158', 5, exp));
        ok(pvr.status === 503 || pvr.status === 501, '预览片签名对 → 没账号 503(没 ffmpeg 501)', pvr.status);
        const hj2 = await (await fetch(base + '/api/health', { headers: { authorization: 'Bearer ' + SECRET } })).json();
        ok(hj2.previews && typeof hj2.previews.files === 'number' && typeof hj2.previews.ok === 'boolean' && hj2.previews.bg && typeof hj2.previews.bg.queue === 'number', '/api/health 带预览片状态(含后台预做)', hj2.previews);
        ok((await fetch(base + '/api/warm?ch=TS88158&ids=5')).status === 401, '/api/warm 没密钥 401');
        const aw = await fetch(base + '/api/warm?ch=TS88158&ids=5,6', { headers: { authorization: 'Bearer ' + SECRET } });
        const awj = await aw.json();
        ok(aw.status === 200 && awj.ok === true && typeof awj.queued === 'number', '/api/warm 收下', awj);
        ok((await fetch(base + '/api/warm?ch=TS88158&ids=5,x', { headers: { authorization: 'Bearer ' + SECRET } })).status === 400 && (await fetch(base + '/api/warm?ch=TS88158&ids=' + Array.from({ length: 101 }, (_, i) => i + 1).join(','), { headers: { authorization: 'Bearer ' + SECRET } })).status === 400, '/api/warm 坏消息号 / 超过 100 个 400');
        // /api/msg 的消息号校验:两位数以上不能被当成坏输入(没账号 → 503,不是 400)
        const am = await fetch(base + '/api/msg?ch=TS88158&id=1243', { headers: { authorization: 'Bearer ' + SECRET } });
        ok(am.status === 503, '/api/msg 四位数消息号过校验(没账号 → 503,不是 400)', am.status);
        ok((await fetch(base + '/api/msg?ch=TS88158&id=12x', { headers: { authorization: 'Bearer ' + SECRET } })).status === 400, '/api/msg 坏消息号 400');
    } finally {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        fs.rmSync(data, { recursive: true, force: true });
    }
}

console.log(`\ntg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
