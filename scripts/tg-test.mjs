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
    const rm = relaySrc.match(/const m = (\/\^\\\/\(\[vt\]\).*?\$\/)\.exec\(u\.pathname\);/);
    ok(!!rm, '中转 server.js 的路由正则');
    if (rm) {
        const re = new Function('return ' + rm[1])();
        ok(re.test(new URL(pu).pathname) && re.test(tu.pathname), '中转路由认得播放 / 封面地址');
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
}

// ---------- 6. 经假中转走真目录:收 / 拦 / 停用 / 进度 ----------
const captions = {
    good: (i) => '#伪娘 #人妖 黑丝伪娘小姐姐第' + i + '部 酒店里被大屌猛操',
    minor: '#伪娘 萝莉装男娘穿黑丝自慰 射了好多',
};
function mkRelay() {
    const calls = [];
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
    return { fetch, calls, chans };
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
        // 部署前就改过(旧进度没记 cfgCls,库里分类名对不上)→ 也从头再读
        dropCfg();
        relay.calls.length = 0;
        r = restart('TS88158:伪娘:120');
        await r.c.tgKick(true);
        ts2 = rows('tg_ts88158');
        ok(relay.calls.some((c) => /ch=TS88158&after=0&/.test(c)) && ts2.every((x) => x.type_name === '伪娘') && ts2.map((x) => x.bucket).join() === b0.join(), '旧进度、库里分类对不上:从头再读改回来', ts2.map((x) => [x.type_name, x.bucket]).slice(0, 3));
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
        const res2 = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
        await gate.detailGet({ query: { site_key: 'tg_ts88158', id: '9' } }, res2);
        ok(res2.code === 404, '详情:未成年那条 404', res2);
        const res3 = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
        await gate.detailGet({ query: { site_key: 'tg_ai538', id: '1' } }, res3);
        ok(res3.code === 404, '详情:停用的频道 404');
    } finally { globalThis.fetch = realFetch; }
    try { await cat.close(); await cat2.close(); } catch (_) { /* */ }
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
