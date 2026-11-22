#!/usr/bin/env node
// [adult] 封面域名健康回归(lib/site-catalog/cover-health.js + 目录接线;离线、零网络、假 DNS、假时钟):
//   node scripts/cover-health-test.mjs
//  ① 纯函数:hostOf / checkable / pickCover(最新一条活域名封面、候补 ≤2 个别的活域名、AVDB 封面域名死了不算)/ verdictOf / applyRound
//     (NXDOMAIN 两次且隔 ≥10 分钟才判死、一次不算、隔太近不算、超时 / SERVFAIL / ENODATA = 不知道、解析出地址即复活、一半以上 NXDOMAIN 的一轮不算数)/
//     checkHosts(并发 ≤8、挂住的查询按超时当不知道)
//  ② inline 目录:判死 → 作品封面换到活域名(最新的那条)、没有活封面的作品不进首页各行 / 浏览 / 分面计数 / 标签页 / 相关 / 演员页 / 新片速递 /
//     猜你喜欢(计数和列表一致;全是死封面的首页行整行消失),作品页 / 查找 / 联想 / 刷一刷照常;卡片 alt ≤2 个别的活域名、代理模式没有;
//     /api/config 用的 coverDeadHosts();规则代数不变、不触发规则重扫;重启后死域名还在;复活 → 封面回来;
//     ADULT_COVER_HEALTH_DISABLE=1 → 不查、死域名表当空、封面挑回来;重挑分块、块间让出;服务器从不请求图片、只查封面域名
//  ②b SERVFAIL 规则默认开(CD 位复核 lame vs DNSSEC 签坏了、=0 关)  ②c 确认轮带对照(≥4 个等确认也 15 分钟确认;对照被劫持不确认)
//  ②d stop / close 取消在途的一轮  ②e 按域名重挑被"死了又活"打断 / 重启后照样挑回来  ②f 标签页计数和列表一致(片段)
//     另:解析器过关门槛(30% / ≥3 个有地址 / 只算明确答复)、checkHosts 取消、CD 位小查询(本机 127.0.0.1 假 DNS)
//  ②g 代理 picUrl 按 pic_item 取挑中的那条 + pic_alt 兜底(站停用 / 审查过滤 / 死图床的候补不取)
//  ②h 早就判死的图床不进过关比例(死图床 > 30% 也判得出新死的、不误报)  ②i 首轮库没好 / 出错 ≈5 分钟后重试  ②j SERVFAIL 规则默认开(文档钉住)
//  ③ worker 目录:同一套跨写 / 读线程,重启后还在
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const adult = require(path.join(ROOT, 'lib/adult'));
const { createCatalog, DEF: CAT_DEF } = require(path.join(ROOT, 'lib/site-catalog'));
const { createWriter } = require(path.join(ROOT, 'lib/site-catalog/writer.js'));
const CH = require(path.join(ROOT, 'lib/site-catalog/cover-health.js'));
const U = require(path.join(ROOT, 'lib/site-catalog/util.js'));
const AVSTUB = require(path.join(ROOT, 'scripts/fixtures/catalog/avdb-stub.cjs'));
const BASE_CLASSES = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/catalog/classes.json'), 'utf8')).class;

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra).slice(0, 900))); } };
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const T0 = Date.UTC(2026, 10, 21, 4, 0, 0);
const fmt = (t) => new Date(t + 8 * HOUR).toISOString().replace('T', ' ').slice(0, 19);
const tick = () => new Promise((r) => setImmediate(r));
function mkClock(t) {
    const c = { t };
    c.now = () => c.t;
    c.sleep = async (ms) => { const target = c.t + ms; await tick(); if (c.t < target) c.t = target; };
    return c;
}

// ---------- 假 maccms 网络 ----------
const classes = BASE_CLASSES.map((c) => Object.assign({}, c));
const tidOf = (name) => { const hit = classes.find((c) => c.type_name === name && c.type_pid === 0); if (!hit) throw new Error('no class ' + name); return hit.type_id; };
let vid = 5000;
function mk(name, typeName, o) {
    const id = vid++;
    const t = o.t != null ? o.t : T0 - 30 * MIN;
    return {
        vod_id: id, vod_name: name, type_id: tidOf(typeName), type_name: typeName, vod_time: fmt(t), _t: t, vod_duration: o.dur ? U.fmtDur(o.dur) : '', vod_remarks: 'HD',
        vod_pic: o.pic == null ? '' : o.pic, vod_play_from: 'm3u8', vod_play_url: '第1集$https://media.example/' + id + '/index.m3u8', vod_content: '',
    };
}
function mkNet(clock) {
    const net = { hosts: new Map(), log: [], latency: 20, off: new Set() };
    net.site = (key, cfg) => {
        const s = Object.assign({ key, api: `https://${key}.test/api.php/provide/vod`, items: [] }, cfg || {});
        net.hosts.set(`${key}.test`, s);
        return s;
    };
    net.httpGet = async (url) => {
        const u = new URL(url);
        net.log.push(url);
        await tick();
        clock.t += net.latency;
        const s = net.hosts.get(u.hostname);
        if (!s) throw new Error('ENOTFOUND ' + u.hostname);
        const ac = u.searchParams.get('ac');
        if (ac === 'list') return { code: 1, class: classes, list: [] };
        const wd = u.searchParams.get('wd');
        if (wd != null) return { code: 1, page: 1, pagecount: 1, list: [] };
        const h = Number(u.searchParams.get('h')) || 0, pg = Number(u.searchParams.get('pg')) || 1, ps = Number(u.searchParams.get('pagesize')) || 20;
        const win = (h ? s.items.filter((it) => it._t >= clock.t - h * HOUR) : s.items).slice().sort((a, b) => b._t - a._t);
        return { code: 1, page: pg, pagecount: Math.max(1, Math.ceil(win.length / ps)), limit: String(ps), total: win.length, list: win.slice((pg - 1) * ps, pg * ps) };
    };
    net.sitesCfg = () => [...net.hosts.values()].filter((s) => !net.off.has(s.key)).map((s) => ({ key: s.key, name: s.key.toUpperCase() + '站', api: s.api, search: false, active: true, codeTrust: true, family: s.family }));
    return net;
}
// ---------- 假 DNS(c-ares 的形状:resolve4 / resolve6 返回 Promise;错误带 code)----------
//   'servfail' = 注册了但授权服务器不应答(lame:CD 位复核也 SERVFAIL);'dnssec' = DNSSEC 签坏了(SERVFAIL,CD 位复核解析得出);
//   'hang' = 永远不回(cancel() 时像 c-ares 一样以 ECANCELLED 收尾)
function mkDns() {
    const d = { mode: new Map(), calls: [], cdCalls: [], inflight: 0, maxIn: 0, delay: 3, cancels: 0, hung: [] };
    const err = (code) => Object.assign(new Error(code), { code });
    const ans = async (h, fam) => {
        d.calls.push(h + '/' + fam);
        d.inflight++;
        if (d.inflight > d.maxIn) d.maxIn = d.inflight;
        try {
            const m = d.mode.get(h) || 'ok';
            if (m === 'hang') await new Promise((_, rej) => d.hung.push(rej));
            await new Promise((r) => setTimeout(r, d.delay));
            if (m === 'ok') { if (fam === 'A') return ['192.0.2.10']; throw err('ENODATA'); }
            if (m === 'ok6') { if (fam === 'AAAA') return ['2001:db8::1']; throw err('ENODATA'); }
            if (m === 'nx') throw err('ENOTFOUND');
            if (m === 'nxA') { if (fam === 'A') throw err('ENOTFOUND'); throw err('ETIMEOUT'); }
            if (m === 'timeout') throw err('ETIMEOUT');
            if (m === 'servfail' || m === 'dnssec') throw err('ESERVFAIL');
            if (m === 'refused') throw err('ECONNREFUSED');
            if (m === 'nodata') throw err('ENODATA');
            throw err('EBADRESP');
        } finally { d.inflight--; }
    };
    d.resolver = {
        resolve4: (h) => ans(h, 'A'), resolve6: (h) => ans(h, 'AAAA'),
        cdCheck: async (h) => {
            d.cdCalls.push(h);
            const m = d.mode.get(h) || 'ok';
            await new Promise((r) => setTimeout(r, d.delay));
            return m === 'servfail' ? 'sf' : m === 'dnssec' ? 'ok' : m === 'nx' ? 'nx' : 'unk';
        },
        cancel: () => { d.cancels++; const l = d.hung.splice(0); for (const rej of l) rej(err('ECANCELLED')); },
    };
    return d;
}

// =====================================================================
console.log('① 纯函数');
{
    ok(CH.hostOf('https://Img.Dead.TEST/a/b.jpg') === 'img.dead.test' && CH.hostOf('http://u:p@x.test:8080/p') === 'x.test' && CH.hostOf('//cdn.test/x') === 'cdn.test'
        && CH.hostOf('ftp://x.test/a') === '' && CH.hostOf('') === '' && CH.hostOf(null) === '' && CH.hostOf('https://x.test./a') === 'x.test', 'hostOf');
    ok(CH.checkable('img.dead.test') && !CH.checkable('1.2.3.4') && !CH.checkable('localhost') && !CH.checkable('[::1]') && !CH.checkable('a..b') && !CH.checkable(''), 'checkable:只查像域名的名字(IP / 单段名 / 空段不查)');
    const dead = new Set(['dead.test']);
    const rows = [
        { site: 'a', vod_id: '1', pic: 'https://dead.test/1.jpg', last_seen: 50 },
        { site: 'b', vod_id: '2', pic: 'https://live1.test/2.jpg', last_seen: 30 },
        { site: 'c', vod_id: '3', pic: 'https://live2.test/3.jpg', last_seen: 40 },
        { site: 'd', vod_id: '4', pic: 'https://live2.test/4.jpg', last_seen: 45 },
        { site: 'e', vod_id: '5', pic: 'https://live3.test/5.jpg', last_seen: 10 },
        { site: 'f', vod_id: '6', pic: 'https://live4.test/6.jpg', last_seen: 20 },
        { site: 'g', vod_id: '7', pic: '', last_seen: 99 },
    ];
    const c0 = CH.pickCover(rows, null, new Set());
    ok(c0.pic === 'https://dead.test/1.jpg' && c0.item === 'a|1' && c0.cov === 1, '没有死域名:最新一条有封面的线路(和原来一样)', c0);
    const c1 = CH.pickCover(rows, null, dead);
    ok(c1.pic === 'https://live2.test/4.jpg' && c1.item === 'd|4', '死域名上的跳过:最新一条活域名封面', c1);
    const alt1 = c1.alt.split('\n');
    ok(alt1.length === 2 && alt1[0] === 'https://live1.test/2.jpg' && alt1[1] === 'https://live4.test/6.jpg', '候补:≤2 个、别的活域名(同域名 live2 不算、死域名不算)、新的在前', c1.alt);
    const c2 = CH.pickCover([rows[0]], 'https://poster.test/p.jpg', dead);
    ok(c2.pic === '' && c2.item === null && c2.alt === '' && c2.cov === 1, '线路封面全死、AVDB 封面活着:pic 空(卡片用 AVDB 封面)、cov=1', c2);
    const c3 = CH.pickCover([rows[0]], 'https://poster.test/p.jpg', new Set(['dead.test', 'poster.test']));
    ok(c3.pic === '' && c3.cov === 0, 'AVDB 封面域名也死了:cov=0', c3);
    const c4 = CH.pickCover([rows[1]], 'https://poster.test/p.jpg', dead);
    ok(c4.pic === 'https://live1.test/2.jpg' && c4.alt === 'https://poster.test/p.jpg', 'AVDB 封面(别的活域名)可以当最后一个候补', c4);
    const c5 = CH.pickCover([{ site: 'a', vod_id: '1', pic: 'https://x.test/1.jpg', last_seen: 5 }, { site: 'b', vod_id: '2', pic: 'https://y.test/2.jpg', last_seen: 5 }], null, null);
    ok(c5.item === 'a|1', '同 last_seen 取先出现的(和 refreshWork 原来一样)', c5);
    ok(JSON.stringify(CH.altList('https://a.test/1.jpg\njavascript:alert(1)\nhttps://b.test/2.jpg\nhttps://c.test/3.jpg')) === JSON.stringify(['https://a.test/1.jpg', 'https://b.test/2.jpg']), 'altList:只要 http(s)、≤2');

    ok(CH.verdictOf({ code: 'ENOTFOUND' }, { code: 'ENOTFOUND' }) === 'nx' && CH.verdictOf({ ok: true }, { code: 'ENOTFOUND' }) === 'ok' && CH.verdictOf({ code: 'ENOTFOUND' }, { code: 'ETIMEOUT' }) === 'unk'
        && CH.verdictOf({ code: 'ESERVFAIL' }, { code: 'ESERVFAIL' }) === 'sf' && CH.verdictOf({ code: 'ESERVFAIL' }, { code: 'ETIMEOUT' }) === 'unk'
        && CH.verdictOf({ code: 'ENODATA' }, { code: 'ENODATA' }) === 'unk' && CH.verdictOf({ code: 'ECONNREFUSED' }, { code: 'ENOTFOUND' }) === 'unk',
    'verdictOf:A 和 AAAA 都 NXDOMAIN 才算不存在;解析出任一地址 = 活;两个都 SERVFAIL 单独记 sf;超时 / 拒绝 / ENODATA = 不知道');
    {
        // SERVFAIL(默认 = 不知道,契约原样;可选规则开着:健康的轮里连续 ≥3 次、跨 ≥24h 才判死)
        const V2 = (o) => new Map(Object.entries(o));
        const healthy = (v) => V2(Object.assign({ 'o1.test': 'ok', 'o2.test': 'ok', 'o3.test': 'ok' }, v));
        const s0 = CH.emptyState();
        for (let k = 0; k < 6; k++) CH.applyRound(s0, healthy({ 'lame.test': 'sf' }), T0 + k * 7 * HOUR, {});
        ok(CH.deadSet(s0).size === 0 && !(s0.hosts['lame.test'].sf > 0), 'SERVFAIL 默认永远不算死(规则关着:状态都不记)');
        const s1 = CH.emptyState();
        const SF = { sfDead: true };
        CH.applyRound(s1, healthy({ 'lame.test': 'sf' }), T0, SF);
        CH.applyRound(s1, healthy({ 'lame.test': 'sf' }), T0 + 7 * HOUR, SF);
        CH.applyRound(s1, healthy({ 'lame.test': 'sf' }), T0 + 14 * HOUR, SF);
        ok(CH.deadSet(s1, { sf: true }).size === 0 && s1.hosts['lame.test'].sf === 3, '开着:3 次但只跨 14 小时 → 还不算');
        CH.applyRound(s1, V2({ 'lame.test': 'sf', 'o1.test': 'ok', 'o2.test': 'timeout', 'o3.test': 'timeout', 'o4.test': 'timeout' }), T0 + 20 * HOUR, SF);
        ok(s1.hosts['lame.test'].sf === 3, '解析器不明显正常的一轮(活的不到一半)不记');
        const rr = CH.applyRound(s1, healthy({ 'lame.test': 'sf' }), T0 + 25 * HOUR, SF);
        ok(CH.deadSet(s1, { sf: true }).has('lame.test') && s1.hosts['lame.test'].why === 'sf' && rr.changed.join() === 'lame.test', '开着:连续 4 次、跨 25 小时 → 判死(why:sf)', rr);
        ok(!CH.deadSet(s1).has('lame.test') && CH.deadList(s1, 200, { sf: false }).length === 0 && CH.deadList(s1, 200, { sf: true }).join() === 'lame.test', '开关关掉:按 SERVFAIL 判死的马上不算(不用等下一轮)');
        const st5 = CH.parseState(CH.dumpState(s1));
        ok(st5.hosts['lame.test'].why === 'sf' && st5.hosts['lame.test'].sf === 4, '持久化带 why / sf');
        CH.applyRound(s1, healthy({ 'lame.test': 'ok' }), T0 + 31 * HOUR, SF);
        ok(!CH.deadSet(s1, { sf: true }).size && s1.hosts['lame.test'].sf === 0, '解析出地址 → 复活、计数清零');
    }
    const st = CH.emptyState();
    const V = (o) => new Map(Object.entries(o));
    // 全量轮要过解析器那一关:至少 3 个解析出地址(这里 up1..3),NXDOMAIN ≤ 明确答复的 30%
    const F3 = (o) => V(Object.assign({ 'up1.test': 'ok', 'up2.test': 'ok', 'up3.test': 'ok' }, o));
    CH.applyRound(st, F3({ 'gone.test': 'nx', 'slow.test': 'unk' }), T0, { minGap: 10 * MIN });
    ok(!st.hosts['gone.test'].dead && st.hosts['gone.test'].nx === 1 && CH.deadSet(st).size === 0 && JSON.stringify(CH.pendingList(st)) === '["gone.test"]', '一次 NXDOMAIN:不算死,等确认');
    CH.applyRound(st, F3({ 'gone.test': 'nx' }), T0 + 5 * MIN, { minGap: 10 * MIN });
    ok(!st.hosts['gone.test'].dead, '隔 5 分钟又 NXDOMAIN:太近,还不算');
    CH.applyRound(st, F3({ 'gone.test': 'unk' }), T0 + 8 * MIN, { minGap: 10 * MIN });
    const r3 = CH.applyRound(st, F3({ 'gone.test': 'nx' }), T0 + 11 * MIN, { minGap: 10 * MIN });
    ok(st.hosts['gone.test'].dead && JSON.stringify(r3.changed) === '["gone.test"]' && CH.deadList(st).join() === 'gone.test', '第一次之后 ≥10 分钟又 NXDOMAIN(中间的超时不算数)→ 判死', r3);
    CH.applyRound(st, V({ 'slow.test': 'unk' }), T0 + HOUR, {});
    CH.applyRound(st, V({ 'slow.test': 'unk' }), T0 + 2 * HOUR, {});
    ok(!st.hosts['slow.test'].dead && !(st.hosts['slow.test'].nx > 0), '一直超时 / SERVFAIL:永远不算死');
    const r4 = CH.applyRound(st, V({ 'gone.test': 'ok' }), T0 + 7 * HOUR, {});
    ok(!st.hosts['gone.test'].dead && st.hosts['gone.test'].nx === 0 && JSON.stringify(r4.changed) === '["gone.test"]', '死域名复查解析出地址 → 复活', r4);
    const st2 = CH.emptyState();
    const many = V({ 'a1.test': 'nx', 'a2.test': 'nx', 'a3.test': 'nx', 'a4.test': 'ok', 'a5.test': 'nx' });
    const r5 = CH.applyRound(st2, many, T0, {});
    ok(r5.suspicious && Object.keys(st2.hosts).every((h) => !(st2.hosts[h].nx > 0)), '一轮里一半以上都 NXDOMAIN(≥4 个)= 解析器有问题,这一轮的 NXDOMAIN 不算数', r5);
    const mkV = (nOk, nNx, nUnk, nSf) => {
        const m = new Map();
        for (let i = 0; i < nOk; i++) m.set('ok' + i + '.test', 'ok');
        for (let i = 0; i < nNx; i++) m.set('nx' + i + '.test', 'nx');
        for (let i = 0; i < (nUnk || 0); i++) m.set('unk' + i + '.test', 'unk');
        for (let i = 0; i < (nSf || 0); i++) m.set('sf' + i + '.test', 'sf');
        return m;
    };
    const clone = (s) => CH.parseState(CH.dumpState(s));
    {
        // 解析器过关的门槛(复核:原来 >50% 才算可疑、分母含超时、<4 个域名不查):比例只算明确答复、至少 3 个解析出地址、NXDOMAIN ≤ 30%
        const g = (a, b, c, e) => CH.applyRound(CH.emptyState(), mkV(a, b, c, e), T0, {});
        const g45 = g(55, 45), gUnk = g(0, 10, 90), g3 = g(2, 1), gReal = g(100, 9, 3, 1), g25 = g(75, 25), g31 = g(69, 31);
        ok(g45.suspicious && gUnk.suspicious && g3.suspicious && g31.suspicious && !gReal.suspicious && gReal.healthy && !g25.suspicious,
            '解析器过关:45% / 31% NXDOMAIN、90 超时 + 10 NXDOMAIN(没有一个解析出地址)、只有 2 个解析出地址 → 整轮不算;实测分布(100 有地址 / 9 不存在 / 3 超时 / 1 SERVFAIL)、25% → 算',
            [g45.suspicious, gUnk.suspicious, g3.suspicious, g31.suspicious, gReal, g25.suspicious]);
        const twice = (v, gap) => { const s = CH.emptyState(); CH.applyRound(s, v, T0, {}); CH.applyRound(s, v, T0 + gap, {}); return CH.deadSet(s).size; };
        ok(twice(V({ 'x1.test': 'nx', 'x2.test': 'nx', 'x3.test': 'nx' }), 15 * MIN) === 0 && twice(mkV(55, 45), 6 * HOUR) === 0 && twice(mkV(0, 10, 90), 6 * HOUR) === 0 && twice(mkV(75, 25), 6 * HOUR) === 25,
            '小目录 3 个域名全 NXDOMAIN / 45% NXDOMAIN / 只有超时和 NXDOMAIN:两轮也不判死;25% 的两轮 → 判死');
    }
    {
        // 确认轮(复核:原来拿"全是上一轮 NXDOMAIN"的待确认域名自己算比例,≥4 个待确认就永远过不了关,要等 6 小时后的全量轮)
        const s = CH.emptyState();
        CH.applyRound(s, mkV(20, 5), T0, {});
        const pend = CH.pendingList(s);
        const ctl = CH.controlList(s, 6, new Set(pend));
        ok(pend.length === 5 && ctl.length === 6 && ctl.every((h) => /^ok\d+\.test$/.test(h)), '全量轮后:5 个等确认;对照 = 6 个上一轮解析正常的域名', [pend, ctl]);
        const ver = new Map(pend.map((h) => [h, 'nx']));
        const okCtl = new Map(ctl.map((h) => [h, 'ok']));
        const sNo = clone(s), sHj = clone(s), sThin = clone(s);
        const pNo = CH.applyRound(sNo, ver, T0 + 15 * MIN, { pending: true, controls: new Map() });
        const pHj = CH.applyRound(sHj, ver, T0 + 15 * MIN, { pending: true, controls: new Map(ctl.map((h) => [h, 'nx'])) });
        const pThin = CH.applyRound(sThin, ver, T0 + 15 * MIN, { pending: true, controls: new Map(ctl.map((h, k) => [h, k < 4 ? 'unk' : 'ok'])) });
        ok(pNo.suspicious && pHj.suspicious && pThin.suspicious && !CH.deadSet(sNo).size && !CH.deadSet(sHj).size && !CH.deadSet(sThin).size,
            '确认轮:没有对照 / 对照也说不存在(劫持)/ 对照大半超时 → 不确认', [pNo.ctl, pHj.ctl, pThin.ctl]);
        const ctlBefore = JSON.stringify(ctl.map((h) => s.hosts[h]));
        const p2 = CH.applyRound(s, ver, T0 + 15 * MIN, { pending: true, controls: okCtl });
        ok(!p2.suspicious && p2.changed.length === 5 && CH.deadSet(s).size === 5 && JSON.stringify(ctl.map((h) => s.hosts[h])) === ctlBefore,
            '确认轮:对照正常 → 5 个(≥4 个)待确认的隔 15 分钟就确认判死;对照只看、不改状态', p2);
        const s2 = CH.emptyState();
        CH.applyRound(s2, V({ 'o1.test': 'ok', 'o2.test': 'ok', 'o3.test': 'ok', 'lame.test': 'sf' }), T0, { sfDead: true });
        CH.applyRound(s2, V({ 'lame.test': 'sf' }), T0 + 15 * MIN, { sfDead: true, pending: true, controls: V({ 'o1.test': 'ok', 'o2.test': 'ok', 'o3.test': 'ok' }) });
        ok(s2.hosts['lame.test'].sf === 1, 'SERVFAIL 只在全量轮记(确认轮不算一次)', s2.hosts['lame.test']);
        const s3 = CH.emptyState();
        CH.applyRound(s3, V({ 'a.test': 'ok', 'b.test': 'ok', 'c.test': 'unk', 'd.test': 'ok' }), T0, { counts: new Map([['a.test', 5], ['b.test', 50], ['c.test', 99], ['d.test', 7]]) });
        s3.hosts['d.test'].dead = true; s3.hosts['d.test'].why = 'nx';
        ok(JSON.stringify(CH.controlList(s3, 6)) === '["b.test","a.test"]' && JSON.stringify(CH.controlList(s3, 1)) === '["b.test"]' && JSON.stringify(CH.controlList(s3, 6, new Set(['b.test']))) === '["a.test"]',
            'controlList:上一次查就正常、没死的(封面多的在前、≤max、排除指定的)', CH.controlList(s3, 6));
    }
    {
        // 复核:解析器过关的比例原来把【早就判死的】也算进去 —— 死图床一多(> 30%,它们每轮照样 NXDOMAIN)全量轮就永远"可疑",
        //   新死的再也判不出来,还每 6 小时报一次"解析器有问题"。现在只算这一轮之前没死的(r.guard)
        const deadHost = () => ({ n: 1, nx: 2, nxAt: T0 - DAY, dead: true, why: 'nx', at: T0 - 6 * HOUR, okAt: 0, deadAt: T0 - DAY, sf: 0, sfAt: 0 });
        const withDead = (n) => { const s = CH.emptyState(); for (let i = 0; i < n; i++) s.hosts['old' + i + '.test'] = deadHost(); return s; };
        const s = withDead(40);
        const v = mkV(57, 0);
        for (let i = 0; i < 40; i++) v.set('old' + i + '.test', 'nx');
        v.set('old0.test', 'ok');   // 一个死了的这轮解析出地址:照样复活
        for (const h of ['new0.test', 'new1.test', 'new2.test']) v.set(h, 'nx');
        const r = CH.applyRound(s, v, T0, {});
        ok(!r.suspicious && r.guard.deadBefore === 40 && r.guard.nx === 3 && r.guard.ok === 57 && r.guard.n === 60 && r.nx === 42 && r.ok === 58,
            '早就判死的 40 个(其中 39 个这轮照样 NXDOMAIN)不进过关比例:没死的 60 个里 3 个 NXDOMAIN(5%)→ 过关(原来 42/100 → 整轮"可疑")', r);
        ok(['new0.test', 'new1.test', 'new2.test'].every((h) => s.hosts[h].nx === 1) && !s.hosts['old0.test'].dead && s.hosts['old1.test'].dead && r.changed.join() === 'old0.test',
            '新的 NXDOMAIN 记第一次;早就死的解析出地址照样复活、其余还是死的', r.changed);
        const pend = CH.pendingList(s);
        const ctl = CH.controlList(s, 6, new Set(pend));
        const r2 = CH.applyRound(s, new Map(pend.map((h) => [h, 'nx'])), T0 + 15 * MIN, { pending: true, controls: new Map(ctl.map((h) => [h, 'ok'])) });
        ok(!r2.suspicious && pend.length === 3 && CH.deadSet(s).size === 42 && ['new0.test', 'new1.test', 'new2.test'].every((h) => s.hosts[h].dead), '确认轮照常判死新死的', [pend, r2.changed]);
        // SERVFAIL 规则的"解析器明显正常"(≥70% 解析出地址)同样只算没死的
        const s2 = withDead(40);
        const v2 = mkV(59, 0);
        for (let i = 0; i < 40; i++) v2.set('old' + i + '.test', 'nx');
        v2.set('lame.test', 'sf');
        const rs = CH.applyRound(s2, v2, T0, { sfDead: true });
        ok(rs.healthy && s2.hosts['lame.test'].sf === 1, 'SERVFAIL 计数:早就死的 40 个不拉低"解析出地址"的比例(59/60 → 明显正常,记一次;原来 59/100 → 不记,永远判不死)', rs);
        // 没死的太少(< 3 个解析出地址)→ 照样整轮不算,但没死的里没有 NXDOMAIN / SERVFAIL(guard.nx = guard.sf = 0)→ 目录不报警
        const s3 = withDead(5);
        const v3 = new Map([['a.test', 'ok'], ['b.test', 'ok']]);
        for (let i = 0; i < 5; i++) v3.set('old' + i + '.test', 'nx');
        const r3 = CH.applyRound(s3, v3, T0, {});
        ok(r3.suspicious && r3.guard.nx === 0 && r3.guard.sf === 0 && r3.guard.deadBefore === 5 && r3.nx === 5, '全是早就死的在 NXDOMAIN:可疑但 guard 里没有 NXDOMAIN(不该报"解析器有问题")', r3);
    }
    // 状态序列化:坏的输入 → 空状态;非域名的键丢掉
    const round = CH.parseState(CH.dumpState(st));
    ok(round.hosts['gone.test'] && round.hosts['gone.test'].okAt > 0 && CH.parseState('{bad').hosts && Object.keys(CH.parseState('{"hosts":{"1.2.3.4":{"dead":true},"x.test":{"dead":true}}}').hosts).join() === 'x.test',
        'parseState / dumpState(坏 JSON → 空;IP 之类的键丢掉)');
    // checkHosts:并发 ≤8、挂住的查询按超时当不知道
    const dns = mkDns();
    const hs = [];
    for (let i = 0; i < 12; i++) { const h = 'h' + i + '.test'; hs.push(h); dns.mode.set(h, i % 3 === 0 ? 'nx' : i % 3 === 1 ? 'ok' : 'timeout'); }
    dns.mode.set('hang.test', 'hang');
    hs.push('hang.test', '10.0.0.1', 'bad host');
    const t1 = Date.now();
    const vr = await CH.checkHosts(hs, { resolver: dns.resolver, conc: 50, timeoutMs: 100 });
    ok(dns.maxIn <= 8 && dns.maxIn >= 2, 'DNS 查询并发 ≤8(给 50 也一样)', dns.maxIn);
    ok(vr.get('h0.test') === 'nx' && vr.get('h1.test') === 'ok' && vr.get('h2.test') === 'unk' && vr.get('hang.test') === 'unk' && !vr.has('10.0.0.1') && !vr.has('bad host') && Date.now() - t1 < 5000,
        'checkHosts:NXDOMAIN / 有地址 / 超时;挂住的查询按超时 → 不知道;IP / 坏名字不查', [...vr]);
    {
        // SERVFAIL 的 CD 位复核:lame(复核还是 SERVFAIL)→ 'sf';DNSSEC 签坏了(复核解析得出)→ 'unk';没法复核 → 'unk';不要复核 → 原样 'sf'
        const d2 = mkDns();
        d2.mode.set('lame.test', 'servfail'); d2.mode.set('bogus.test', 'dnssec');
        const a = await CH.checkHosts(['lame.test', 'bogus.test', 'fine.test'], { resolver: d2.resolver, timeoutMs: 500, sfConfirm: true });
        const noCd = await CH.checkHosts(['lame.test'], { resolver: { resolve4: d2.resolver.resolve4, resolve6: d2.resolver.resolve6 }, timeoutMs: 500, sfConfirm: true });
        const raw = await CH.checkHosts(['lame.test'], { resolver: d2.resolver, timeoutMs: 500 });
        ok(a.get('lame.test') === 'sf' && a.get('bogus.test') === 'unk' && a.get('fine.test') === 'ok' && noCd.get('lame.test') === 'unk' && raw.get('lame.test') === 'sf'
            && JSON.stringify(d2.cdCalls.slice(0, 2).sort()) === '["bogus.test","lame.test"]',
        'checkHosts sfConfirm:lame → sf、DNSSEC 签坏了 → 不知道、解析器不会 CD 位复核 → 不知道、只对 SERVFAIL 的复核', [[...a], [...noCd], d2.cdCalls]);
    }
    {
        // 取消(复核:stop / close 以后一轮还在发查询,在途的定时器撑着进程到整轮超时为止)
        const d3 = mkDns();
        const hs3 = [];
        for (let i = 0; i < 40; i++) { const h = 'hang' + i + '.test'; hs3.push(h); d3.mode.set(h, 'hang'); }
        const ac = new AbortController();
        const t0 = Date.now();
        const p = CH.checkHosts(hs3, { resolver: d3.resolver, conc: 8, timeoutMs: 3000, signal: ac.signal });
        for (let k = 0; k < 50 && d3.calls.length < 8; k++) await tick();
        const n0 = d3.calls.length;
        ac.abort();
        await p;
        const dt = Date.now() - t0;
        await new Promise((r) => setTimeout(r, 60));
        ok(n0 === 8 && d3.calls.length === n0 && dt < 1000 && d3.cancels === 1, 'checkHosts 取消:不再发新查询、在途的立刻收尾(不等 4 秒的超时)、resolver.cancel()', { n0, calls: d3.calls.length, dt, cancels: d3.cancels });
        const p2 = await CH.checkHosts(['x.test'], { resolver: d3.resolver, signal: ac.signal });
        ok(d3.calls.length === n0 && p2.get('x.test') === 'unk', '已经取消的 signal:一个查询都不发');
    }
    {
        // 复核:外层超时一到就让出名额,底层查询其实还在 → 真正在途的会超过 8 个。现在等底层结束(或再等 2 × 超时)才让出
        const d4 = mkDns();
        d4.delay = 1300;   // 每个查询 1.3 秒才回(比外层超时 100ms + 1s 还慢)
        const hs4 = [];
        for (let i = 0; i < 8; i++) hs4.push('slow' + i + '.test');
        const v4 = await CH.checkHosts(hs4, { resolver: d4.resolver, conc: 8, timeoutMs: 100 });
        ok(d4.maxIn <= 8 && d4.calls.length === 16 && [...v4.values()].every((x) => x === 'unk'), '外层超时了也等底层查询结束才发下一个:真正在途的 ≤ 8', { maxIn: d4.maxIn, calls: d4.calls.length });
    }
    // c-ares 单次超时按总预算倒推(实测一个查询的寿命 ≈ 单次 ×(服务器数 + 1~2),会取整)
    ok(CH.perTryMs(5000, 3) === 1000 && CH.perTryMs(5000, 1) === 1666 && CH.perTryMs(5000, 0) === 1666 && CH.perTryMs(300, 9) === 200, 'perTryMs', [CH.perTryMs(5000, 3), CH.perTryMs(5000, 1), CH.perTryMs(300, 9)]);
    ok(JSON.stringify(CH.parseServer('8.8.8.8')) === '{"host":"8.8.8.8","port":53,"fam":"udp4"}' && CH.parseServer('127.0.0.1:5353').port === 5353
        && JSON.stringify(CH.parseServer('[2001:db8::1]:5353')) === '{"host":"2001:db8::1","port":5353,"fam":"udp6"}' && CH.parseServer('fd74:a91::1').fam === 'udp6' && CH.parseServer('dns.example') === null,
    'parseServer:IPv4 / IPv4:端口 / [IPv6]:端口 / IPv6;名字不认');
    const q0 = CH.dnsQuery(0x1234, 'fb.example.test');
    ok(q0.readUInt16BE(0) === 0x1234 && q0[2] === 0x01 && q0[3] === 0x10 && q0.readUInt16BE(4) === 1 && q0.slice(12, 15).toString('latin1') === '\x02fb' && q0.readUInt16BE(q0.length - 4) === 1,
        'dnsQuery:RD + CD 位、一个 A 问题');
    {
        // 本机假 DNS(127.0.0.1 上的 UDP,零外网):lame → SERVFAIL、bogus → CD 位下 NOERROR、gone → NXDOMAIN;另一台回 REFUSED、一台不回
        const dgram = require('node:dgram');
        const mkSrv = (fn) => new Promise((resolve) => {
            const s = dgram.createSocket('udp4');
            s.on('message', (m, rinfo) => {
                let i = 12; const labels = [];
                while (m[i]) { labels.push(m.slice(i + 1, i + 1 + m[i]).toString('latin1')); i += m[i] + 1; }
                const rc = fn(labels.join('.'), !!(m[3] & 0x10));
                if (rc == null) return;
                const out = Buffer.from(m.slice(0, i + 5));
                out[2] = 0x81; out[3] = 0x80 | rc;
                s.send(out, rinfo.port, rinfo.address);
            });
            s.bind(0, '127.0.0.1', () => resolve(s));
        });
        const seenCd = [];
        const main = await mkSrv((name, cd) => { seenCd.push(cd); return name === 'lame.test' ? 2 : name === 'bogus.test' ? (cd ? 0 : 2) : name === 'gone.test' ? 3 : 0; });
        const refuser = await mkSrv(() => 5);
        const mute = await mkSrv(() => null);
        const at = (s) => '127.0.0.1:' + s.address().port;
        const r1 = await CH.cdServfail('lame.test', [at(main)], 500);
        const r2 = await CH.cdServfail('bogus.test', [at(main)], 500);
        const r3 = await CH.cdServfail('gone.test', [at(main)], 500);
        const r4 = await CH.cdServfail('lame.test', [at(refuser), at(main)], 500);
        const r5 = await CH.cdServfail('lame.test', [at(mute)], 150);
        const r6 = await CH.cdServfail('lame.test', [at(refuser)], 500);
        ok(r1 === 'sf' && r2 === 'ok' && r3 === 'nx' && r4 === 'sf' && r5 === 'unk' && r6 === 'unk' && seenCd.length && seenCd.every(Boolean),
            'cdServfail:带 CD 位问;lame → sf、DNSSEC 签坏了 → ok、不存在 → nx;REFUSED 的服务器不算数;都不回 → unk', [r1, r2, r3, r4, r5, r6]);
        const mr = CH.makeResolver(4000, [at(main)]);
        ok(mr.perTryMs === 1333 && JSON.stringify(mr.getServers()) === JSON.stringify([at(main)]) && (await mr.cdCheck('lame.test')) === 'sf' && typeof mr.cancel === 'function',
            'makeResolver:单次超时按服务器数倒推;cdCheck 问的是同一组服务器', [mr.perTryMs, mr.getServers()]);
        for (const s of [main, refuser, mute]) s.close();
    }
    ok(CH.envOn('1') && CH.envOn('yes') && !CH.envOn('0') && !CH.envOn('false') && !CH.envOn('off') && !CH.envOn('no') && !CH.envOn('') && !CH.envOn(undefined), 'envOn 与 server.js envFlag 同口径');
}

// =====================================================================
console.log('② inline 目录:判死 / 换封面 / 排除 / 候补 / 复活 / 持久化 / 关掉');
const HOST_DEAD = 'img-dead.test', HOST_B = 'img-b.test', HOST_C = 'img-c.test', HOST_D = 'img-d.test', HOST_E = 'img-e.test', POSTER = 'poster.test';
const P = (h, id) => 'https://' + h + '/p/' + id + '.jpg';
function buildWorld(clock) {
    const net = mkNet(clock);
    const SA = net.site('ca'), SB = net.site('cb'), SC = net.site('cc'), SD = net.site('cd'), SE = net.site('ce');
    // 甲 0..11:只在 ca(封面全在要死的域名上);0..3 另有 cb 线路(活域名,但比 ca 的旧)
    for (let i = 0; i < 12; i++) SA.items.push(mk(`某合成素人甲${i}号作品`, '国产自拍', { t: T0 - i * 10 * MIN - 5 * MIN, dur: 900 + i * 7, pic: P(HOST_DEAD, 'a' + i) }));
    for (let i = 0; i < 4; i++) SB.items.push(mk(`某合成素人甲${i}号作品`, '国产自拍', { t: T0 - i * 10 * MIN - 6 * MIN, dur: 900 + i * 7, pic: P(HOST_B, 'b' + i) }));
    // 乙:四个站、四个活域名 + 一个死域名(候补最多 2 个)
    SA.items.push(mk('某合成素人乙多线路作品', '国产自拍', { t: T0 - 2 * MIN, dur: 1500, pic: P(HOST_DEAD, 'y') }));
    SB.items.push(mk('某合成素人乙多线路作品', '国产自拍', { t: T0 - 3 * MIN, dur: 1500, pic: P(HOST_B, 'y') }));
    SC.items.push(mk('某合成素人乙多线路作品', '国产自拍', { t: T0 - 3 * MIN, dur: 1500, pic: P(HOST_C, 'y') }));
    SD.items.push(mk('某合成素人乙多线路作品', '国产自拍', { t: T0 - 3 * MIN, dur: 1500, pic: P(HOST_D, 'y') }));
    SE.items.push(mk('某合成素人乙多线路作品', '国产自拍', { t: T0 - 3 * MIN, dur: 1500, pic: P(HOST_E, 'y') }));
    // 丙 0..5:只在 cb(活域名)
    for (let i = 0; i < 6; i++) SB.items.push(mk(`某合成素人丙${i}号作品`, '国产自拍', { t: T0 - i * 10 * MIN - 8 * MIN, dur: 700 + i * 11, pic: P(HOST_B, 'c' + i) }));
    // 番号:QWX-101 只在 ca、有 AVDB 封面;QWX-102 只在 ca、没有 AVDB 封面;QWX-103 在 cb。同一位演员、发行日期都很近(新片速递)
    SA.items.push(mk('QWX-101 某合成新片一', '日本有码', { t: T0 - 20 * MIN, dur: 7200, pic: P(HOST_DEAD, 'q101') }));
    SA.items.push(mk('QWX-102 某合成新片二', '日本有码', { t: T0 - 21 * MIN, dur: 7300, pic: P(HOST_DEAD, 'q102') }));
    SB.items.push(mk('QWX-103 某合成新片三', '日本有码', { t: T0 - 22 * MIN, dur: 7400, pic: P(HOST_B, 'q103') }));
    // 短视频(刷一刷):只在 ca(封面死了也照样刷得到 —— 刷一刷放视频不看封面)
    for (let i = 0; i < 3; i++) SA.items.push(mk(`某合成短视频${i}号`, '抖音短视频', { t: T0 - 30 * MIN - i * MIN, dur: 60 + i, pic: P(HOST_DEAD, 's' + i) }));
    return { net, SA, SB };
}
function avdbRows(db) {
    db.exec('CREATE TABLE IF NOT EXISTS avdb_stub (key TEXT PRIMARY KEY, j TEXT NOT NULL)');
    const rel = new Date(T0 - 5 * DAY + 8 * HOUR).toISOString().slice(0, 10);
    const ins = db.prepare('INSERT OR REPLACE INTO avdb_stub (key, j) VALUES (?, ?)');
    const act = [{ aid: 9001, name: 'Kakuu Example' }];
    ins.run('QWX-101', JSON.stringify({ runtime: 7200, released: rel, actors: act, poster: 'https://' + POSTER + '/q101.jpg' }));
    ins.run('QWX-102', JSON.stringify({ runtime: 7300, released: rel, actors: act }));
    ins.run('QWX-103', JSON.stringify({ runtime: 7400, released: rel, actors: act }));
}
const OPTS = { rowMin: 1, freshMin: 1, hotMin: 999, extHotMin: 999, relatedRow: 12 };
const flat = (h) => (h && Array.isArray(h.rows) ? h.rows : []).flatMap((r) => r.items.map((c) => c.wk));
const allBrowse = async (cat, p) => { const out = []; let r = await cat.browse(Object.assign({ sort: 'new' }, p)); for (let k = 0; k < 20 && r; k++) { out.push(...r.results); if (!r.cursor_next) break; r = await cat.browse(Object.assign({ sort: 'new' }, p, { cursor: r.cursor_next })); } return out; };
{
    const clock = mkClock(T0);
    const { net } = buildWorld(clock);
    const dns = mkDns();
    dns.mode.set(HOST_DEAD, 'nx');
    dns.mode.set(HOST_C, 'timeout');   // 一直超时:永远不算死
    dns.mode.set(HOST_D, 'dnssec');    // 一直 SERVFAIL 但 CD 位下解析得出(DNSSEC 签坏了,不校验的解析器照样能看):永远不算死
    dns.mode.set(HOST_E, 'ok6');       // 只有 AAAA:活
    const db = new Database(':memory:');
    avdbRows(db);
    const logs = [];
    const mkC = (extra) => createCatalog(Object.assign({
        db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: (m) => logs.push(m), now: clock.now, sleep: clock.sleep, resolver: dns.resolver,
        avdbFactory: (d) => AVSTUB.createAvdb({ db: d }), env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, opts: OPTS,
    }, extra || {}));
    // 先只爬 cb..ce(旧的),再爬 ca(新的):甲 0..3 / 乙 的最新封面在 ca(要死的域名)上
    net.off.add('ca');
    const cat = mkC();
    await cat.tick();
    clock.t += 10 * MIN;
    net.off.delete('ca');
    await cat.tick();
    await cat.flush();
    const wkOf = (name) => (db.prepare('SELECT wk FROM adult_items WHERE name=? LIMIT 1').get(name) || {}).wk;
    const W = (name) => db.prepare('SELECT * FROM adult_works WHERE wk=?').get(wkOf(name));
    const wA0 = wkOf('某合成素人甲0号作品'), wA5 = wkOf('某合成素人甲5号作品'), wY = wkOf('某合成素人乙多线路作品'), wC0 = wkOf('某合成素人丙0号作品');
    const q101 = wkOf('QWX-101 某合成新片一'), q102 = wkOf('QWX-102 某合成新片二'), q103 = wkOf('QWX-103 某合成新片三'), s0 = wkOf('某合成短视频0号');
    ok(wA0 && wA5 && wY && wC0 && q101 === 'c:QWX-101' && q102 === 'c:QWX-102' && q103 === 'c:QWX-103' && s0, '入库', [wA0, wA5, wY, wC0, q101, q102, q103, s0]);
    ok(db.prepare('SELECT COUNT(DISTINCT site) n FROM adult_items WHERE wk=?').get(wA0).n === 2 && db.prepare('SELECT COUNT(DISTINCT site) n FROM adult_items WHERE wk=?').get(wY).n === 5, '甲0 两站、乙 五站合并成一部');
    const a0 = W('某合成素人甲0号作品');
    ok(a0.pic === P(HOST_DEAD, 'a0') && a0.cov === 1 && a0.pic_alt === P(HOST_B, 'b0'), '判死之前:作品封面 = 最新那条(ca,要死的域名);候补 = cb 的', a0);
    const gen0 = db.prepare("SELECT v FROM adult_meta WHERE k='rv:gen'").get();
    const applied0 = JSON.parse(db.prepare("SELECT v FROM adult_meta WHERE k='cover:applied'").get().v);
    ok(applied0.rev === CH.COVER_REV && applied0.dead === '', '新库:封面口径记成已挑(没有死域名)', applied0);
    const home0 = await cat.home();
    const b0 = await cat.browse({ b: 'cn_amateur', facets: 1 });
    ok(flat(home0).includes(wA5) && b0.total_results === 19 && home0.rows.some((r) => r.id === 'short'), '判死之前:甲 / 乙 / 丙 都在首页和浏览里(19 部国产)、有短视频行', [b0.total_results, home0.rows.map((r) => r.id + ':' + r.items.length)]);
    const cY0 = b0.results.find((c) => c.wk === wY);
    ok(cY0 && cY0.pic === P(HOST_DEAD, 'y') && Array.isArray(cY0.alt) && cY0.alt.length === 2 && cY0.alt.every((u) => CH.hostOf(u) !== HOST_DEAD), '卡片 alt:≤2 个别的域名', cY0);
    ok(cat.coverDeadHosts().length === 0, 'coverDeadHosts:一开始空');
    // —— 第一次检查:NXDOMAIN 一次,不算 ——
    const r1 = await cat.coverCheck();
    ok(r1 && r1.full === true && r1.nx === 1 && r1.dead.length === 0 && cat.coverDeadHosts().length === 0, '第一次 NXDOMAIN:不判死', r1);
    const asked = new Set(dns.calls.map((x) => x.split('/')[0]));
    ok(asked.has(HOST_DEAD) && asked.has(POSTER) && asked.has(HOST_B) && ![...asked].some((h) => /^c[a-e]\.test$/.test(h) || h === 'media.example'), '只查封面域名(线路封面 + AVDB 封面),不查资源站接口 / 播放地址的域名', [...asked]);
    ok(!net.log.some((u) => /img-|poster\.test|\.jpg/.test(u)), '服务器从不请求图片');
    clock.t += 5 * MIN;
    const r2 = await cat.coverCheck();
    ok(r2 && r2.full === false && r2.checked === 1 && r2.dead.length === 0, '5 分钟后复查(只查等确认的那一个):隔太近,还不算', r2);
    clock.t += 6 * MIN;
    const r3 = await cat.coverCheck();
    ok(r3 && r3.dead.length === 1 && r3.dead[0] === HOST_DEAD && r3.applied && r3.applied.mode === 'hosts' && r3.applied.changed > 0, '隔 11 分钟第二次 NXDOMAIN → 判死,写线程只重挑受影响的作品', r3);
    ok(JSON.stringify(cat.coverDeadHosts()) === JSON.stringify([HOST_DEAD]), 'coverDeadHosts() = [死域名](给 /api/config)', cat.coverDeadHosts());
    // —— 作品封面换了 ——
    const a0b = W('某合成素人甲0号作品'), a5b = W('某合成素人甲5号作品'), yb = W('某合成素人乙多线路作品'), w101 = W('QWX-101 某合成新片一'), w102 = W('QWX-102 某合成新片二');
    ok(a0b.pic === P(HOST_B, 'b0') && a0b.pic_item.indexOf('cb|') === 0 && a0b.pic_alt === '' && a0b.cov === 1, '甲0:封面换到 cb(最新的活域名那条),没有别的活域名就没有候补', a0b);
    ok(a5b.pic === '' && a5b.pic_item === null && a5b.cov === 0, '甲5:只在死域名上 → pic 空、cov=0', a5b);
    // 乙的 4 条活线路给不同的 last_seen(cc 最新),重挑:作品封面必须是活域名里最新的那条
    {
        const ids = db.prepare('SELECT id, site FROM adult_items WHERE wk=? ORDER BY id').all(wY);
        for (const r of ids) db.prepare('UPDATE adult_items SET last_seen=? WHERE id=?').run(r.site === 'ca' ? T0 + 9 * HOUR : r.site === 'cc' ? T0 + 8 * HOUR : T0 + HOUR, r.id);
        db.prepare("UPDATE adult_meta SET v=? WHERE k='cover:applied'").run(JSON.stringify({ rev: CH.COVER_REV, dead: '' }));   // 当成刚判死:按变了的域名重挑
        const cx = mkC();
        await cx.browse({});   // 新实例 init 看到还没按现在的死域名挑 → 重挑
        await cx.flush();
    }
    const yb2 = W('某合成素人乙多线路作品');
    ok(yb2.pic === P(HOST_C, 'y') && yb2.pic_item.indexOf('cc|') === 0, '乙:死域名上的那条最新(ca)也跳过,挑活域名里最新的(cc)', yb2);
    ok(yb.pic && CH.hostOf(yb.pic) !== HOST_DEAD && yb.pic_alt.split('\n').length === 2 && !yb.pic_alt.includes(HOST_DEAD) && new Set([yb.pic, ...yb.pic_alt.split('\n')].map(CH.hostOf)).size === 3, '乙:换到活域名、候补 2 个别的活域名', yb);
    ok(yb2.pic_alt.split('\n').length === 2 && !yb2.pic_alt.includes(HOST_C) && !yb2.pic_alt.includes(HOST_DEAD), '乙:候补不含作品封面自己的域名、不含死域名', yb2.pic_alt);
    ok(w101.pic === '' && w101.cov === 1 && w102.cov === 0, 'QWX-101 线路封面死了但 AVDB 封面活着 → cov=1;QWX-102 → cov=0', [w101.cov, w102.cov]);
    ok(db.prepare("SELECT v FROM adult_meta WHERE k='rv:gen'").get()?.v === gen0?.v && !cat.stats().rescanPending, '规则代数不变、不触发规则重扫');
    // —— 排除:首页 / 浏览 / 分面 / 标签页 / 相关 / 演员页 / 新片速递 / 猜你喜欢 ——
    const home1 = await cat.home();
    const hw = flat(home1);
    const noCov = new Set(db.prepare('SELECT wk FROM adult_works WHERE cov=0').all().map((r) => r.wk));
    ok(noCov.has(wA5) && noCov.has(q102) && noCov.has(s0) && !hw.some((w) => noCov.has(w)), '首页各行一部没有活封面的作品都没有', hw.filter((w) => noCov.has(w)));
    ok(!home1.rows.some((r) => r.id === 'short') && hw.includes(wA0) && hw.includes(wY), '全是死封面的行(短视频)整行消失;换了封面的作品还在', home1.rows.map((r) => r.id));
    const fresh = home1.rows.find((r) => r.id === 'fresh');
    ok(fresh && fresh.items.some((c) => c.wk === q101) && !fresh.items.some((c) => c.wk === q102), '新片速递:AVDB 封面活着的在,没封面的不在', fresh && fresh.items.map((c) => c.wk));
    const c101 = fresh && fresh.items.find((c) => c.wk === q101);
    ok(c101 && c101.pic === 'https://' + POSTER + '/q101.jpg' && !('alt' in c101), 'QWX-101 卡片用 AVDB 封面', c101);
    const b1 = await cat.browse({ b: 'cn_amateur', facets: 1 });
    const all1 = await allBrowse(cat, { b: 'cn_amateur' });
    ok(b1.total_results === 11 && all1.length === 11 && !all1.some((c) => noCov.has(c.wk)) && all1.every((c) => c.pic && CH.hostOf(c.pic) !== HOST_DEAD), '浏览:甲4..11 下去,剩 甲0..3 + 乙 + 丙0..5 = 11(计数 = 列表)', [b1.total_results, all1.length]);
    const bAll = await cat.browse({ facets: 1 });
    const bk = new Map((bAll.facets.buckets || []).map((x) => [x.id, x.count]));
    let facetOk = true;
    for (const [b, n] of bk) { const r = await cat.browse({ b }); if (r.total_results !== n) facetOk = false; }
    ok(facetOk && bk.get('cn_amateur') === 11 && bk.get('short') === undefined && bk.get('jp_censored') === 2, '分区分面计数 = 点进去的结果数(没封面的不算;短视频分区整个没了)', [...bk]);
    const bk2 = await cat.buckets();
    ok(bk2.every((x) => x.today == null || x.today <= (bk.get(x.id) || 0)), '分区导航的"今日"数也不算没封面的', bk2.filter((x) => x.today));
    const nr = await cat.browse({ nr: 1, b: 'jp_censored' });
    ok(nr.results.length === 2 && !nr.results.some((c) => c.wk === q102), '猜你喜欢(nr=1):不出没封面的', nr.results.map((c) => c.wk));
    const actP = await cat.actress('9001');
    ok(actP && actP.results.length === 2 && !actP.results.some((c) => c.wk === q102), '演员页:没封面的不算、不出', actP && actP.results.map((c) => c.wk));
    const actS = await cat.actressSearch('Kakuu');
    ok(Array.isArray(actS) && actS.length === 1 && actS[0].n === 2, '演员搜索的部数也不算没封面的', actS);
    const rel = await cat.related(q103);
    const relW = rel ? [...rel.items, ...(rel.actress ? rel.actress.items : []), ...(rel.studio ? rel.studio.items : [])].map((c) => c.wk) : null;
    ok(rel && relW.includes(q101) && !relW.includes(q102), '相关 / 她的其它作品:没封面的不出', relW);
    const relSeed = await cat.related(q102);
    ok(relSeed && [...relSeed.items, ...(relSeed.actress ? relSeed.actress.items : [])].some((c) => c.wk === q101 || c.wk === q103), '没封面的作品自己打开时,相关推荐照样能算', relSeed);
    // —— 不排除:作品页 / 查找 / 联想 / 刷一刷 ——
    const g5 = await cat.work(wA5);
    ok(g5 && g5.sources.length === 1 && g5.pic === '' && g5.sources[0].vod_pic === P(HOST_DEAD, 'a5'), '作品页照常打开(没有活封面也能直接进;作品封面不退回死域名上的线路封面)', g5 && { pic: g5.pic, n: g5.sources.length });
    const g101 = await cat.work(q101);
    ok(g101 && g101.pic === 'https://' + POSTER + '/q101.jpg', '作品页:线路封面死了用 AVDB 封面', g101 && g101.pic);
    const gY = await cat.work(wY);
    ok(gY && gY.pic && CH.hostOf(gY.pic) !== HOST_DEAD, '作品页封面:活域名上的那张', gY && gY.pic);
    const lk = await cat.lookup('某合成素人甲5号作品');
    ok(Array.isArray(lk) && lk.some((c) => c.wk === wA5 && c.pic === ''), '本地查找照常出(pic 空,客户端藏在"显示"后面)', lk);
    const sg = await cat.suggest('某合成素人甲');
    ok(sg && sg.items.some((c) => c.wk === wA5 && c.pic === ''), '联想照常出', sg && sg.items.map((c) => c.wk + ':' + c.pic));
    const lk102 = await cat.lookup('QWX-102');
    ok(lk102.length === 1 && lk102[0].pic === '', '番号查找照常出', lk102);
    const fd = await cat.feed({});
    ok(fd.items.some((c) => c.wk === s0), '刷一刷照常(放视频不看封面)', fd.items.map((c) => c.wk));
    // —— 卡片 alt ——
    const cY = all1.find((c) => c.wk === wY);
    ok(cY && Array.isArray(cY.alt) && cY.alt.length === 2 && cY.alt.every((u) => CH.hostOf(u) !== CH.hostOf(cY.pic) && CH.hostOf(u) !== HOST_DEAD), '卡片 alt:≤2 个别的活域名', cY);
    const cA0 = all1.find((c) => c.wk === wA0);
    ok(cA0 && !('alt' in cA0), '没有候补:不带 alt 字段');
    // —— 一直超时 / DNSSEC 签坏了(SERVFAIL、CD 位能解析)的不判死(查很多轮、跨 21 小时)——
    for (let k = 0; k < 3; k++) { clock.t += 7 * HOUR; await cat.coverCheck(); }
    ok(JSON.stringify(cat.coverDeadHosts()) === JSON.stringify([HOST_DEAD]), '一直超时 / DNSSEC 签坏了的域名查多少轮都不判死(SERVFAIL 规则默认开着也一样);死的复查还是死', cat.coverDeadHosts());
    // —— 新入库也按死域名挑 ——
    net.hosts.get('ca.test').items.push(mk('某合成素人甲0号作品', '国产自拍', { t: clock.t - MIN, dur: 900, pic: P(HOST_DEAD, 'a0new') }));
    await cat.tick();
    ok(W('某合成素人甲0号作品').pic === P(HOST_B, 'b0'), '新入库的死域名封面不会被挑成作品封面', W('某合成素人甲0号作品').pic);
    // —— 代理模式:没有 alt,地址是 /api/img ——
    const catP = mkC({ env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0', ADULT_IMG_PROXY: '1' } });
    const bp = await allBrowse(catP, { b: 'cn_amateur' });
    ok(bp.length === 11 && bp.every((c) => /^\/api\/img\?k=/.test(c.pic) && !('alt' in c)), '代理模式:卡片封面都是 /api/img、没有 alt', bp.slice(0, 2));
    const pu = catP.picUrl(q101, '', { meta: true });
    ok(pu && pu.urls.length === 1 && pu.urls[0] === 'https://' + POSTER + '/q101.jpg', '代理查地址:死域名上的封面不取(只剩 AVDB 封面)', pu);
    // —— 重启:死域名还在(adult_meta 'cover:hosts')——
    const cat2 = mkC();
    ok(JSON.stringify(cat2.coverDeadHosts()) === JSON.stringify([HOST_DEAD]), '重启(新实例)后死域名表还在', cat2.coverDeadHosts());
    const b2 = await cat2.browse({ b: 'cn_amateur' });
    ok(b2.total_results === 11, '重启后照样排除', b2.total_results);
    // —— 可疑的一轮(解析器劫持:一半以上都说不存在)不算数 ——
    const keep = new Map(dns.mode);
    for (const h of [HOST_B, HOST_C, HOST_D, HOST_E, POSTER]) dns.mode.set(h, 'nx');
    clock.t += 7 * HOUR;
    const rs = await cat2.coverCheck();
    ok(rs && rs.suspicious && JSON.stringify(cat2.coverDeadHosts()) === JSON.stringify([HOST_DEAD]) && CH.pendingList(CH.parseState(db.prepare("SELECT v FROM adult_meta WHERE k='cover:hosts'").get().v)).length === 0,
        '一轮里大半域名都 NXDOMAIN:整轮不算(不判死、不记第一次)', rs);
    dns.mode = keep;
    // —— 复活 ——
    dns.mode.set(HOST_DEAD, 'ok');
    clock.t += 7 * HOUR;
    const rv = await cat2.coverCheck();
    ok(rv && rv.dead.length === 0 && rv.applied && rv.applied.changed > 0 && cat2.coverDeadHosts().length === 0, '死域名解析出地址 → 复活,受影响的作品重挑', rv);
    const a5c = W('某合成素人甲5号作品'), a0c = W('某合成素人甲0号作品');
    // 最新一条有封面的线路(同 last_seen 取库里先出现的)—— 和判死之前的口径一样
    const newest = (wk) => { let b = null; for (const r of db.prepare('SELECT pic, last_seen FROM adult_items WHERE wk=? ORDER BY id').all(wk)) if (r.pic && (!b || r.last_seen > b.last_seen)) b = r; return b && b.pic; };
    const yc = W('某合成素人乙多线路作品');
    ok(a5c.pic === P(HOST_DEAD, 'a5') && a5c.cov === 1 && a0c.pic === newest(wA0) && yc.pic === newest(wY) && db.prepare('SELECT COUNT(*) n FROM adult_works WHERE cov=0').get().n === 0,
        '复活后封面回来(又按"最新一条"挑)', [a5c.pic, a0c.pic, newest(wA0), yc.pic, newest(wY)]);
    const b3 = await cat2.browse({ b: 'cn_amateur' });
    const h3 = await cat2.home();
    ok(b3.total_results === 19 && flat(h3).includes(wA5) && h3.rows.some((r) => r.id === 'short'), '复活后首页 / 浏览都回来', [b3.total_results, h3.rows.map((r) => r.id)]);
    // —— 关掉:ADULT_COVER_HEALTH_DISABLE=1 → 不查、死域名当空、封面挑回来 ——
    dns.mode.set(HOST_DEAD, 'nx');
    clock.t += 7 * HOUR; await cat2.coverCheck();
    clock.t += 20 * MIN; await cat2.coverCheck();
    ok(JSON.stringify(cat2.coverDeadHosts()) === JSON.stringify([HOST_DEAD]) && W('某合成素人甲5号作品').cov === 0, '(再判死一次)');
    const callsBefore = dns.calls.length;
    const catOff = mkC({ env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0', ADULT_COVER_HEALTH_DISABLE: '1' } });
    await catOff.browse({ b: 'cn_amateur' });
    await catOff.flush();
    const rOff = await catOff.coverCheck();
    ok(rOff && rOff.skipped === 'disabled' && dns.calls.length === callsBefore && catOff.coverDeadHosts().length === 0, 'ADULT_COVER_HEALTH_DISABLE=1:不查 DNS、coverDeadHosts 空', rOff);
    ok(W('某合成素人甲5号作品').cov === 1 && W('某合成素人甲5号作品').pic === P(HOST_DEAD, 'a5'), '关掉后写线程按"全活"把封面挑回来', W('某合成素人甲5号作品'));
    const bOff = await catOff.browse({ b: 'cn_amateur' });
    ok(bOff.total_results === 19, '关掉后不按封面隐藏', bOff.total_results);
    const catOn = mkC();
    await catOn.browse({});
    await catOn.flush();
    ok(W('某合成素人甲5号作品').cov === 0, '再打开:按存着的死域名重新排除', W('某合成素人甲5号作品').cov);
    // —— 重挑分块、块间让出 ——
    db.prepare("UPDATE adult_meta SET v=NULL WHERE k='cover:applied'").run();   // 当成升级后第一次(全部作品重挑)
    const catChunk = mkC({ opts: Object.assign({}, OPTS, { coverChunk: 2 }) });
    const p = catChunk.browse({});
    const seen = [];
    for (let k = 0; k < 400; k++) { await tick(); const s = catChunk.stats().cover.writer; if (s) seen.push(Object.assign({}, s)); if (s && !s.running) break; }
    await p; await catChunk.flush();
    const totalW = db.prepare('SELECT COUNT(*) n FROM adult_works').get().n;
    const mid = seen.filter((s) => s.running && s.works > 0 && s.works < totalW);
    ok(mid.length >= 3 && seen.length && seen[seen.length - 1].mode === 'all', '全量重挑分块(每块 2 部)、块与块之间让出(期间别的请求照常)', { mid: mid.length, last: seen[seen.length - 1], totalW });
    const ap = JSON.parse(db.prepare("SELECT v FROM adult_meta WHERE k='cover:applied'").get().v);
    ok(ap.rev === CH.COVER_REV && ap.dead === HOST_DEAD && W('某合成素人甲5号作品').cov === 0, '全量重挑完记下口径 + 死域名', ap);
    // 全量重挑中途重启:从记下的位置接着挑
    db.prepare("UPDATE adult_meta SET v=NULL WHERE k='cover:applied'").run();
    const midId = db.prepare('SELECT id FROM adult_works ORDER BY id LIMIT 1 OFFSET 10').get().id;
    db.prepare("INSERT OR REPLACE INTO adult_meta (k, v) VALUES ('cover:job', ?)").run(JSON.stringify({ rev: CH.COVER_REV, dead: HOST_DEAD, id: midId }));
    const catResume = mkC();
    await catResume.browse({});
    await catResume.flush();
    const sw = catResume.stats().cover.writer;
    ok(sw && sw.mode === 'all' && sw.works === totalW - 11, '全量重挑重启后从断点续(不从头)', sw);
    // 统计里看得到
    const cs = cat2.stats().cover;
    ok(cs && cs.enabled === true && Array.isArray(cs.dead) && cs.hosts >= 5, 'stats().cover', cs);
    // —— 起步定时器:首轮延后、按 ADULT_COVER_HEALTH_DELAY_MS ——
    clock.t += 7 * HOUR;   // 到下一次全量检查的时候了
    const callsT = dns.calls.length;
    const catT = mkC({ env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0', CATALOG_FIRST_DELAY_MS: '3600000', ADULT_COVER_HEALTH_DELAY_MS: '30' } });
    catT.start();
    for (let k = 0; k < 100 && dns.calls.length === callsT; k++) await new Promise((r) => setTimeout(r, 10));
    catT.stop();
    ok(dns.calls.length > callsT, 'start():首轮在 ADULT_COVER_HEALTH_DELAY_MS 后跑(不等爬虫首轮)');
    const callsT2 = dns.calls.length;
    const catT2 = mkC({ env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0', CATALOG_FIRST_DELAY_MS: '3600000' } });
    catT2.start();
    await new Promise((r) => setTimeout(r, 150));
    catT2.stop();
    ok(dns.calls.length === callsT2, '默认首轮延后(10 分钟):启动时不查', dns.calls.length - callsT2);
}

// =====================================================================
console.log('②b SERVFAIL 规则(默认开,ADULT_COVER_SERVFAIL_DEAD=0 关;CD 位复核排除 DNSSEC 签坏了)');
{
    const runWorld = async (env, mode) => {
        const clock = mkClock(T0);
        const { net } = buildWorld(clock);
        const dns = mkDns();
        dns.mode.set(HOST_DEAD, mode || 'servfail');   // 注册了但解析服务器失灵(授权服务器拒答 / 不应答;公共解析器一律 SERVFAIL)
        const db = new Database(':memory:');
        avdbRows(db);
        const cat = createCatalog({ db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep, resolver: dns.resolver,
            avdbFactory: (d) => AVSTUB.createAvdb({ db: d }), env: Object.assign({ CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, env), opts: OPTS });
        await cat.tick();
        const res = [];
        for (const dt of [0, 7 * HOUR, 7 * HOUR, 11 * HOUR]) { clock.t += dt; const r = await cat.coverCheck(); res.push(r.dead.length); }
        const b = await cat.browse({ b: 'cn_amateur' });
        return { res, dead: cat.coverDeadHosts(), total: b.total_results, st: cat.stats().cover, cd: dns.cdCalls.length };
    };
    const def = await runWorld({});
    ok(JSON.stringify(def.res) === '[0,0,0,1]' && JSON.stringify(def.dead) === JSON.stringify([HOST_DEAD]) && def.total === 11 && def.st.servfailDead === true && def.cd === 4,
        '默认开(复核:有个站整站的封面图床就是 SERVFAIL、原来永远不判死):A/AAAA SERVFAIL、CD 位复核也 SERVFAIL,全量轮连续 4 次、跨 25 小时 → 判死,封面按死域名挑、浏览排除', def);
    const emp = await runWorld({ ADULT_COVER_SERVFAIL_DEAD: '' });
    ok(JSON.stringify(emp.res) === '[0,0,0,1]' && emp.st.servfailDead === true, '空值 = 没设 = 开', emp.res);
    for (const v of ['0', 'false', 'off', 'no']) {
        const off = await runWorld({ ADULT_COVER_SERVFAIL_DEAD: v });
        ok(off.res.every((n) => n === 0) && off.dead.length === 0 && off.total === 19 && off.st.servfailDead === false && off.cd === 0, 'ADULT_COVER_SERVFAIL_DEAD=' + v + ' 关:一直 SERVFAIL 也不判死、不做 CD 位复核', off);
    }
    const sec = await runWorld({}, 'dnssec');
    ok(sec.res.every((n) => n === 0) && sec.dead.length === 0 && sec.total === 19 && sec.cd === 4, 'DNSSEC 签坏了(SERVFAIL,CD 位下解析得出 —— 不校验的解析器照样能看):查 4 轮也不判死', sec);
}

console.log('②c 确认轮:≥4 个等确认的域名 15 分钟后照样确认(复核)');
{
    const clock = mkClock(T0);
    const net = mkNet(clock);
    const S = net.site('sa');
    const dns = mkDns();
    for (let i = 0; i < 20; i++) {
        const h = 'img' + i + '.example';
        if (i < 5) dns.mode.set(h, 'nx');
        S.items.push(mk('某合成确认作品' + i + '号', '国产自拍', { t: T0 - i * MIN - MIN, dur: 900 + i * 13, pic: 'https://' + h + '/p/' + i + '.jpg' }));
    }
    const db = new Database(':memory:');
    const logs = [];
    const cat = createCatalog({ db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: (m) => logs.push(String(m)), now: clock.now, sleep: clock.sleep, resolver: dns.resolver,
        env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, opts: OPTS });
    await cat.tick(); await cat.flush();
    const r1 = await cat.coverCheck();
    ok(r1.full && r1.checked === 20 && r1.nx === 5 && !r1.suspicious && r1.dead.length === 0 && r1.pending === 5, '全量轮:20 个里 5 个 NXDOMAIN(25%)→ 记第一次', r1);
    // 解析器被劫持的那 15 分钟:对照也说不存在 → 不确认
    const keep = new Map(dns.mode);
    for (let i = 5; i < 20; i++) dns.mode.set('img' + i + '.example', 'nx');
    clock.t += 15 * MIN;
    const rH = await cat.coverCheck();
    ok(!rH.full && rH.checked === 5 && rH.controls === 6 && rH.suspicious && rH.dead.length === 0 && rH.pending === 5 && logs.some((m) => /对照域名解析不正常/.test(m)), '确认轮:对照也说不存在(劫持)→ 不确认、告警、还等着', rH);
    dns.mode = keep;
    const nLog = logs.length;
    clock.t += 15 * MIN;
    const r2 = await cat.coverCheck();
    ok(!r2.full && r2.checked === 5 && r2.controls === 6 && !r2.suspicious && r2.dead.length === 5 && r2.applied && r2.applied.changed === 5,
        '确认轮(5 个等确认 + 6 个对照):15 分钟后就确认判死(原来 ≥4 个等确认的每轮都算"可疑",要等 6 小时后的全量轮)', r2);
    ok(!logs.slice(nLog).some((m) => /解析器|对照/.test(m)), '正常的确认轮不报"解析器有问题"', logs.slice(nLog));
    const b = await cat.browse({ b: 'cn_amateur' });
    ok(b.total_results === 15, '浏览:5 部没封面的下去', b.total_results);
    ok(new Set(dns.calls.map((x) => x.split('/')[0])).size === 20, '确认轮只查等确认的和对照(都是目录里的封面域名)');
    // 对照凑不够(正常的封面域名不到 3 个;例如老版本留下的状态):确认轮不查、不报警,等下一次全量轮
    const sx = CH.emptyState();
    sx.full = clock.t;
    sx.hosts['img1.example'] = { n: 9, nx: 0, nxAt: 0, dead: false, why: '', at: clock.t, okAt: clock.t, deadAt: 0, sf: 0, sfAt: 0 };
    sx.hosts['img2.example'] = { n: 9, nx: 0, nxAt: 0, dead: false, why: '', at: clock.t, okAt: clock.t, deadAt: 0, sf: 0, sfAt: 0 };
    sx.hosts['img3.example'] = { n: 9, nx: 0, nxAt: 0, dead: false, why: '', at: clock.t, okAt: clock.t - HOUR, deadAt: 0, sf: 0, sfAt: 0 };
    sx.hosts['img0.example'] = { n: 9, nx: 1, nxAt: clock.t, dead: false, why: '', at: clock.t, okAt: 0, deadAt: 0, sf: 0, sfAt: 0 };
    db.prepare("UPDATE adult_meta SET v=? WHERE k='cover:hosts'").run(CH.dumpState(sx));
    const catX = createCatalog({ db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: (m) => logs.push(String(m)), now: clock.now, sleep: clock.sleep, resolver: dns.resolver,
        env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, opts: OPTS });
    await catX.browse({}); await catX.flush();
    const nCalls = dns.calls.length, nLog2 = logs.length;
    clock.t += 15 * MIN;
    const rX = await catX.coverCheck();
    ok(rX && rX.skipped === 'nocontrols' && dns.calls.length === nCalls && !logs.slice(nLog2).some((m) => /解析器|对照/.test(m)), '对照不到 3 个:确认轮跳过(不查、不报警)', rX);
}

console.log('②d stop / close 取消在途的封面检查(复核)');
{
    const clock = mkClock(T0);
    const net = mkNet(clock);
    const S = net.site('sh');
    const dns = mkDns();
    for (let i = 0; i < 40; i++) {
        const h = 'hang' + i + '.example';
        dns.mode.set(h, 'hang');
        S.items.push(mk('某合成挂起作品' + i + '号', '国产自拍', { t: T0 - i * MIN - MIN, dur: 800 + i * 11, pic: 'https://' + h + '/p/' + i + '.jpg' }));
    }
    const db = new Database(':memory:');
    const mkC = (env) => createCatalog({ db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep, resolver: dns.resolver,
        env: Object.assign({ CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, env || {}), opts: Object.assign({}, OPTS, { coverTimeoutMs: 3000 }) });
    const cat = mkC();
    await cat.tick(); await cat.flush();
    const st0 = JSON.stringify(db.prepare("SELECT v FROM adult_meta WHERE k='cover:hosts'").get() || null);
    const p = cat.coverCheck();
    for (let k = 0; k < 500 && dns.calls.length < 8; k++) await tick();
    const n0 = dns.calls.length;
    const t0 = Date.now();
    cat.stop();
    const r = await p;
    const dt = Date.now() - t0;
    await new Promise((res) => setTimeout(res, 80));
    ok(n0 === 8 && r && r.skipped === 'stopped' && dt < 1000 && dns.calls.length === n0 && dns.cancels === 1,
        'stop():在途的一轮立刻收尾(不等 80 个查询 × 4 秒超时)、不再发查询、cancel 解析器', { n0, r, dt, calls: dns.calls.length, cancels: dns.cancels });
    ok(JSON.stringify(db.prepare("SELECT v FROM adult_meta WHERE k='cover:hosts'").get() || null) === st0 && cat.coverDeadHosts().length === 0, '取消的一轮结果整个丢掉(不落库)');
    const cat2 = mkC({ CATALOG_FIRST_DELAY_MS: '3600000', ADULT_COVER_HEALTH_DELAY_MS: '0' });
    const c0 = dns.calls.length;
    cat2.start();
    for (let k = 0; k < 400 && dns.calls.length < c0 + 8; k++) await new Promise((res) => setTimeout(res, 5));
    const n1 = dns.calls.length;
    const t1 = Date.now();
    await cat2.close();
    const dt1 = Date.now() - t1;
    await new Promise((res) => setTimeout(res, 80));
    ok(n1 === c0 + 8 && dt1 < 1500 && dns.calls.length === n1 && dns.cancels === 2,
        'close():start() 起的那一轮也立刻取消(原来 close 之后还接着发查询,超时定时器把进程撑到整轮查完)', { n1: n1 - c0, dt1, after: dns.calls.length - n1, cancels: dns.cancels });
}

console.log('②e 按域名重挑被"死了又活"打断:中途挑过的作品照样挑回来(复核)');
{
    const clock = mkClock(T0);
    const net = mkNet(clock);
    const S = net.site('sb');
    const X = 'flip.example';
    for (let i = 0; i < 40; i++) S.items.push(mk('某合成翻转作品' + i + '号', '国产自拍', { t: T0 - i * MIN - MIN, dur: 1000 + i * 17, pic: 'https://' + X + '/p/' + i + '.jpg' }));
    const db = new Database(':memory:');
    const cat = createCatalog({ db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep,
        env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, opts: OPTS });
    await cat.tick(); await cat.flush();
    const nW = db.prepare('SELECT COUNT(*) n FROM adult_works').get().n;
    const meta = (k) => { const r = db.prepare('SELECT v FROM adult_meta WHERE k=?').get(k); return r ? r.v : null; };
    const cov0 = () => db.prepare('SELECT COUNT(*) n FROM adult_works WHERE cov=0').get().n;
    const hostState = (dead) => { const s = CH.emptyState(); s.hosts[X] = { n: 40, nx: dead ? 2 : 0, nxAt: dead ? T0 : 0, dead, why: dead ? 'nx' : '', at: T0, okAt: dead ? 0 : T0, deadAt: dead ? T0 : 0, sf: 0, sfAt: 0 }; return CH.dumpState(s); };
    // 和写线程跑的是同一份代码:同一个库上单独建一个写端(块 = 1 部,好在中途插进去)
    const wr = createWriter({ db, adult, C: { coverChunk: 1, coverHealth: true }, rules: cat.RULES_VERSION, log: () => {} });
    wr.handle('coverHosts', { state: hostState(true) });
    const p = wr.handle('coverApply', {});
    for (let k = 0; k < 200 && cov0() === 0; k++) await tick();
    const mid = cov0();
    wr.handle('coverHosts', { state: hostState(false) });   // 下一轮检查:它又活了(表变回"已挑过"的样子)
    const ar = await p;
    ok(nW === 40 && mid > 0 && mid < 40 && cov0() === 0 && db.prepare("SELECT COUNT(*) n FROM adult_works WHERE pic=''").get().n === 0 && !meta('cover:touch')
        && JSON.parse(meta('cover:applied')).dead === '',
    '中途被打断(按 {X} 挑了一半,X 又活了):挑过的那几部也挑回来,没有作品留着 cov=0 / 空封面', { nW, mid, after: cov0(), ar });
    // 进程在半中间没了:库里留着 'cover:touch',表已经变回"已挑过"的样子 → 新写端照样把它们挑回来
    db.prepare("UPDATE adult_works SET cov=0, pic='', pic_item=NULL WHERE id IN (SELECT id FROM adult_works ORDER BY id LIMIT 3)").run();
    db.prepare("INSERT OR REPLACE INTO adult_meta (k, v) VALUES ('cover:touch', ?)").run(JSON.stringify([X]));
    const wr2 = createWriter({ db, adult, C: { coverChunk: 5, coverHealth: true }, rules: cat.RULES_VERSION, log: () => {} });
    const r2 = await wr2.handle('coverApply', {});
    ok(cov0() === 0 && r2.changed === 3 && !meta('cover:touch'), '重启后:上次没挑完的域名(cover:touch)接着挑,哪怕死域名表和"已挑过"一样', { r2, cov0: cov0() });
}

console.log('②f 标签页总数 / 分区计数和点进去的列表一致(片段不算;复核)');
{
    const clock = mkClock(T0);
    const net = mkNet(clock);
    const S = net.site('st');
    for (let i = 0; i < 6; i++) S.items.push(mk('某合成巨乳素人' + i + '号作品', '国产自拍', { t: T0 - i * MIN - MIN, dur: 900 + i * 7, pic: P(HOST_B, 'tb' + i) }));
    // 番号片段(AVDB 有片长,我们的时长不到一半 → '#clip'):两部在「AV解说」、一部在日本有码分区
    S.items.push(mk('QWX-102 某合成巨乳解说', 'AV解说', { t: T0 - 20 * MIN, dur: 600, pic: P(HOST_B, 'tc2') }));
    S.items.push(mk('QWX-103 某合成巨乳解说', 'AV解说', { t: T0 - 21 * MIN, dur: 610, pic: P(HOST_B, 'tc3') }));
    S.items.push(mk('QWX-101 某合成巨乳片段', '日本有码', { t: T0 - 40 * MIN, dur: 900, pic: P(HOST_B, 'tclip') }));
    const db = new Database(':memory:');
    avdbRows(db);
    const cat = createCatalog({ db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep,
        avdbFactory: (d) => AVSTUB.createAvdb({ db: d }), env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, opts: OPTS });
    await cat.tick(); await cat.flush();
    const clips = db.prepare("SELECT wk, bucket FROM adult_works WHERE is_clip=1 AND tags LIKE '%,busty,%'").all();
    ok(clips.length === 3 && clips.filter((c) => c.bucket === 'commentary').length === 2 && clips.some((c) => c.bucket === 'jp_censored'), '布景:带「巨乳」的片段 3 部(解说 2 + 日本有码的片段 1)', clips);
    const tp = await cat.tagPage('busty');
    const list = await cat.browse({ t: ['busty'] });
    let bOk = !!(tp && tp.buckets.length > 0);
    const per = [];
    for (const bk of (tp && tp.buckets) || []) { const r = await cat.browse({ t: ['busty'], b: bk.id }); per.push([bk.id, bk.count, r.total_results]); if (r.total_results !== bk.count) bOk = false; }
    ok(tp && tp.count === list.total_results && tp.count === 6, '标签页「共 N 部」= 点进去的列表(不分区的列表不出片段)', [tp && tp.count, list.total_results]);
    ok(bOk && per.some((x) => x[0] === 'commentary' && x[1] === 2) && !per.some((x) => x[0] === 'jp_censored'), '标签页的分区计数 = 点进去的分区列表(片段只在「AV解说」里算)', per);
}

console.log('②g 代理模式 picUrl:取 pickCover 挑中的那条(不是"那个站最新的一条")+ pic_alt 兜底(复核)');
{
    const clock = mkClock(T0);
    const net = mkNet(clock);
    const SP = net.site('pa'), SQ = net.site('pb'), SR = net.site('pc');
    const NAME = '某合成同站两条作品';
    const GONE = 'img-gone.example', LIVE = 'img-live.example', ALT = 'img-alt.example';
    const X3 = mk(NAME, '国产自拍', { t: T0 - 40 * MIN, dur: 1200, pic: 'https://' + ALT + '/x3.jpg' });
    SQ.items.push(X3);
    for (let i = 1; i <= 3; i++) SQ.items.push(mk('某合成填充' + i + '号作品', '国产自拍', { t: T0 - 50 * MIN - i * MIN, dur: 800 + i * 37, pic: 'https://img-f' + i + '.example/f.jpg' }));
    SR.items.push(mk('某合成别站作品', '国产自拍', { t: T0 - 55 * MIN, dur: 777, pic: 'https://img-f4.example/f.jpg' }));
    // pa 上同一部有两条:X1 新、封面在要死的图床上;X2 旧、封面在活图床上
    const X1 = mk(NAME, '国产自拍', { t: T0 - 2 * MIN, dur: 1200, pic: 'https://' + GONE + '/x1.jpg' });
    const X2 = mk(NAME, '国产自拍', { t: T0 - 30 * MIN, dur: 1200, pic: 'https://' + LIVE + '/x2.jpg' });
    SP.items.push(X1, X2);
    const dns = mkDns();
    dns.mode.set(GONE, 'nx');
    const db = new Database(':memory:');
    const mkC = (env) => createCatalog({ db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep, resolver: dns.resolver,
        env: Object.assign({ CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, env || {}), opts: OPTS });
    const cat = mkC();
    net.off.add('pa');   // 先爬 pb / pc(旧),再爬 pa(新):pa 的两条比 pb 那条新
    await cat.tick();
    clock.t += 10 * MIN;
    net.off.delete('pa');
    await cat.tick(); await cat.flush();
    const wk = (db.prepare('SELECT wk FROM adult_items WHERE name=? LIMIT 1').get(NAME) || {}).wk;
    const its = db.prepare('SELECT site, vod_id, pic, last_seen FROM adult_items WHERE wk=? ORDER BY id').all(wk);
    ok(wk && its.length === 3 && its.filter((r) => r.site === 'pa').length === 2, '布景:同一部在 pa 两条、pb 一条', its);
    db.prepare('UPDATE adult_items SET last_seen=? WHERE wk=? AND pic=?').run(clock.t + HOUR, wk, X1.vod_pic);   // 死图床那条后来又被抓到过:pa 上最新的是它
    await cat.coverCheck();
    clock.t += 11 * MIN;
    const rd2 = await cat.coverCheck();
    ok(JSON.stringify(rd2.dead) === JSON.stringify([GONE]), '布景:img-gone 判死', rd2);
    const w = db.prepare('SELECT pic, pic_item, pic_alt FROM adult_works WHERE wk=?').get(wk);
    ok(w.pic === X2.vod_pic && w.pic_item === 'pa|' + X2.vod_id && w.pic_alt === X3.vod_pic, 'pickCover:挑 pa 上活图床那条(X2),候补 = pb 那条', w);
    const catP = mkC({ ADULT_IMG_PROXY: '1' });
    const card = (await allBrowse(catP, { b: 'cn_amateur' })).find((c) => c.wk === wk);
    ok(card && card.pic === '/api/img?k=' + encodeURIComponent(wk) + '&s=pa' && !('alt' in card), '代理卡片:s = pic_item 的站、没有 alt', card);
    const urls = (s) => { const r = catP.picUrl(wk, s, { meta: true }); return r ? r.urls : null; };
    ok(JSON.stringify(urls('pa')) === JSON.stringify([X2.vod_pic, X3.vod_pic]) && catP.picUrl(wk, 'pa') === X2.vod_pic,
        'picUrl(作品, pic_item 的站):挑中的 X2 + pic_alt 兜底(原来取 pa 最新那条 X1 → 死图床 → 过滤掉 → null → /api/img 404,客户端把有活封面的卡片藏了)', urls('pa'));
    ok(JSON.stringify(urls('')) === JSON.stringify([X2.vod_pic, X3.vod_pic]), '不给站:同样(挑中的那条 → pic_alt)', urls(''));
    ok(JSON.stringify(urls('pb')) === JSON.stringify([X3.vod_pic, X2.vod_pic]), '作品页 pb 线路:pb 那条在前,挑中的那条兜底', urls('pb'));
    ok(urls('pc') === null && urls('zz') === null, '这部片不在点名的站上 / 不认识的站 → null(不相干的站不给)', [urls('pc'), urls('zz')]);
    net.off.add('pa');
    ok(JSON.stringify(urls('pa')) === JSON.stringify([X3.vod_pic]), 'pic_item 的站停用了:不取它的封面,按 pic_alt 兜底(原来 → null)', urls('pa'));
    net.off.delete('pa');
    net.off.add('pb');
    ok(JSON.stringify(urls('pa')) === JSON.stringify([X2.vod_pic]), 'pic_alt 那条线路的站停用了 → 不当候补', urls('pa'));
    net.off.delete('pb');
    const rev0 = db.prepare("SELECT review FROM adult_items WHERE wk=? AND site='pb'").get(wk).review;
    db.prepare("UPDATE adult_items SET review='hide' WHERE wk=? AND site='pb'").run(wk);
    ok(JSON.stringify(urls('pa')) === JSON.stringify([X2.vod_pic]), 'pic_alt 那条线路被审查过滤掉了 → 不当候补', urls('pa'));
    db.prepare("UPDATE adult_items SET review=? WHERE wk=? AND site='pb'").run(rev0, wk);
    ok(JSON.stringify(urls('pa')) === JSON.stringify([X2.vod_pic, X3.vod_pic]), '(还原)');
    // pic_alt 的图床也死了:候补不取
    dns.mode.set(ALT, 'nx');
    clock.t += 7 * HOUR; await catP.coverCheck();
    clock.t += 15 * MIN; const rd3 = await catP.coverCheck();
    ok(rd3.dead.includes(ALT) && JSON.stringify(urls('pa')) === JSON.stringify([X2.vod_pic]), '候补在死图床上:不取', [rd3.dead, urls('pa')]);
}

console.log('②h 早就判死的图床很多(> 30%)也照样判得出新死的、不报"解析器有问题"(复核)');
{
    const clock = mkClock(T0);
    const net = mkNet(clock);
    const S = net.site('sg');
    const dns = mkDns();
    const H = (i) => 'img' + i + '.guard.example';
    for (let i = 0; i < 20; i++) {
        if (i <= 8) dns.mode.set(H(i), 'nx');   // 0..7 早就判死了(一直 NXDOMAIN);8 这次新死
        S.items.push(mk('某合成过关作品' + i + '号', '国产自拍', { t: T0 - i * MIN - MIN, dur: 900 + i * 13, pic: 'https://' + H(i) + '/p.jpg' }));
    }
    const db = new Database(':memory:');
    const logs = [];
    const mkC = () => createCatalog({ db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: (m) => logs.push(String(m)), now: clock.now, sleep: clock.sleep, resolver: dns.resolver,
        env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, opts: OPTS });
    const cat0 = mkC();
    await cat0.tick(); await cat0.flush();
    const s = CH.emptyState();
    s.full = clock.t - 7 * HOUR;
    for (let i = 0; i < 20; i++) {
        s.hosts[H(i)] = i < 8 ? { n: 1, nx: 2, nxAt: T0 - 3 * DAY, dead: true, why: 'nx', at: clock.t - 7 * HOUR, okAt: 0, deadAt: T0 - 3 * DAY, sf: 0, sfAt: 0 }
            : { n: 1, nx: 0, nxAt: 0, dead: false, why: '', at: clock.t - 7 * HOUR, okAt: clock.t - 7 * HOUR, deadAt: 0, sf: 0, sfAt: 0 };
    }
    db.prepare("INSERT OR REPLACE INTO adult_meta (k, v) VALUES ('cover:hosts', ?)").run(CH.dumpState(s));
    const cat = mkC();
    await cat.browse({}); await cat.flush();
    ok(cat.coverDeadHosts().length === 8 && (await cat.browse({ b: 'cn_amateur' })).total_results === 12, '布景:20 个图床里 8 个早就判死了(40%),浏览剩 12 部', cat.coverDeadHosts());
    const nLog = logs.length;
    const r1 = await cat.coverCheck();
    ok(r1.full && r1.nx === 9 && !r1.suspicious && r1.deadBefore === 8 && r1.pending === 1,
        '全量轮:9 个 NXDOMAIN 里 8 个早就死了 —— 只算没死的(1/12)→ 过关,新死的记第一次(原来 9/20 = 45% → 整轮"可疑",再也判不出新死的)', r1);
    ok(!logs.slice(nLog).some((m) => /解析器有问题|这一轮不判死/.test(m)), '不报"解析器有问题"(原来每 6 小时报一次)', logs.slice(nLog));
    clock.t += 15 * MIN;
    const r2 = await cat.coverCheck();
    ok(!r2.full && r2.dead.length === 9 && r2.dead.includes(H(8)) && (await cat.browse({ b: 'cn_amateur' })).total_results === 11, '确认轮:新死的判死,浏览少一部', r2);
    clock.t += 7 * HOUR;
    const nLog2 = logs.length;
    const r3 = await cat.coverCheck();
    ok(r3.full && !r3.suspicious && r3.nx === 9 && r3.dead.length === 9 && !logs.slice(nLog2).some((m) => /解析器有问题|这一轮不判死/.test(m)), '下一轮全量:死的照样复查,不算可疑、不报警', r3);
}

console.log('②i 首轮库没好 / 出错:约 5 分钟后重试,不等 6 小时(复核)');
{
    const clock = mkClock(T0);
    const net = mkNet(clock);
    const S = net.site('sr');
    for (let i = 0; i < 5; i++) S.items.push(mk('某合成重试作品' + i + '号', '国产自拍', { t: T0 - i * MIN - MIN, dur: 900 + i * 13, pic: 'https://img' + i + '.retry.example/p.jpg' }));
    const dns = mkDns();
    const db = new Database(':memory:');
    const base = { getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, now: clock.now, sleep: clock.sleep, resolver: dns.resolver };
    const cat0 = createCatalog(Object.assign({ db, log: () => {}, env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, opts: OPTS }, base));
    await cat0.tick(); await cat0.flush();
    ok(CAT_DEF.coverRetryMs === 5 * MIN && CAT_DEF.coverEveryMs === 6 * HOUR, '默认:失败后 5 分钟重试;正常 6 小时一轮全量');
    // 库一开始拿不到(skipped:'nodb');拿到以后第一次扫封面域名抛错(error);再下一轮才跑通
    let dbOn = false, failScan = 0;
    const prep = db.prepare.bind(db);
    db.prepare = (sql) => {
        if (failScan > 0 && /^SELECT id, pic FROM adult_items WHERE id > \?/.test(sql)) { failScan--; throw new Error('模拟出错 boom'); }
        return prep(sql);
    };
    const logs = [];
    const catR = createCatalog(Object.assign({ db: () => (dbOn ? db : null), log: (m) => logs.push(String(m)),
        env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0', CATALOG_FIRST_DELAY_MS: '3600000', ADULT_COVER_HEALTH_DELAY_MS: '0' },
        opts: Object.assign({}, OPTS, { coverRetryMs: 40 }) }, base));
    const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 2)); } return !!fn(); };
    const st = () => catR.coverStatus();
    catR.start();
    ok(await until(() => st().next && st().next.ms === 40, 2000) && dns.calls.length === 0 && st().lastFull === 0,
        '首轮库还没好(skipped nodb)→ coverRetryMs(这里 40ms)后重试(原来按"没有上次全量"排到 6 小时后)', st());
    failScan = 1; dbOn = true;
    ok(await until(() => logs.some((m) => /boom/.test(m)), 3000) && dns.calls.length === 0, '接着那一轮出错(扫封面域名抛错)', logs);
    ok(await until(() => st().lastFull > 0, 3000) && dns.calls.length > 0, '出错后照样很快再来一轮,这次跑完全量', { lastFull: st().lastFull, calls: dns.calls.length });
    ok(await until(() => st().next && st().next.ms === CAT_DEF.coverEveryMs, 2000), '跑完全量、没有等确认的 → 下一轮 6 小时后', st().next);
    catR.stop();
    ok(st().next === null, 'stop() 之后没有排着的下一轮', st().next);
    db.prepare = prep;
}

console.log('②j SERVFAIL 规则默认开(文档 + 默认值钉住;区被删掉的图床对所有人都打不开)');
{
    const c = createCatalog({ db: new Database(':memory:'), getSites: () => [], adult, log: () => {} });
    ok(c.coverStatus().servfailDead === true, '完全不给 env:ADULT_COVER_SERVFAIL_DEAD 默认开', c.coverStatus());
    const doc = fs.readFileSync(path.join(ROOT, 'docs/ADULT.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.indexOf('`ADULT_COVER_SERVFAIL_DEAD`') >= 0) || '';
    ok(/^\|\s*`ADULT_COVER_SERVFAIL_DEAD`\s*\|\s*开\s*\|/.test(row) && /默认开/.test(row), 'docs/ADULT.md:环境变量表写明默认开', row);
}

console.log('③ worker 目录:写线程挑封面、读线程排除、重启后还在');
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covw-'));
    const file = path.join(tmp, 'catalog.db');
    const clock = mkClock(T0);
    const { net } = buildWorld(clock);
    const dns = mkDns();
    dns.mode.set(HOST_DEAD, 'nx');
    const mkW = () => createCatalog({ dbPath: file, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep, resolver: dns.resolver,
        env: { CATALOG_BACKFILL: '0', CATALOG_SHORT_BACKFILL: '0' }, opts: OPTS });
    net.off.add('ca');
    const cw = mkW();
    ok((await cw.ready()) === true && cw.mode === 'worker', 'worker 模式');
    await cw.tick();
    clock.t += 10 * MIN;
    net.off.delete('ca');
    await cw.tick();
    await cw.flush();
    await cw.rebuild();
    const b0 = await cw.browse({ b: 'cn_amateur' });
    ok(b0.total_results === 19, '判死之前 19 部', b0.total_results);
    await cw.coverCheck();
    clock.t += 11 * MIN;
    const r = await cw.coverCheck();
    ok(r && r.dead.length === 1 && r.applied && r.applied.changed > 0, '两次 NXDOMAIN(隔 11 分钟)→ 判死、写线程重挑', r);
    const b1 = await cw.browse({ b: 'cn_amateur', facets: 1 });
    const h1 = await cw.home();
    const ro = new Database(file, { readonly: true });
    const noCov = new Set(ro.prepare('SELECT wk FROM adult_works WHERE cov=0').all().map((x) => x.wk));
    ok(b1.total_results === 11 && !flat(h1).some((w) => noCov.has(w)) && noCov.size > 0, '读线程:浏览 / 首页按 cov 排除', [b1.total_results, noCov.size]);
    const bAll = await cw.browse({ facets: 1 });
    const cnt = (bAll.facets.buckets.find((x) => x.id === 'cn_amateur') || {}).count;
    ok(cnt === 11, '分面计数一致', cnt);
    const yb = b1.results.find((c) => (c.alt || []).length === 2);
    ok(yb && yb.alt.every((u) => CH.hostOf(u) !== HOST_DEAD), 'worker 卡片带 alt', yb);
    ok(JSON.stringify(cw.coverDeadHosts()) === JSON.stringify([HOST_DEAD]), 'coverDeadHosts()(worker)');
    await cw.close();
    const cw2 = mkW();
    await cw2.ready();
    ok(JSON.stringify(cw2.coverDeadHosts()) === JSON.stringify([HOST_DEAD]), '重启后死域名表还在(worker)', cw2.coverDeadHosts());
    const b2 = await cw2.browse({ b: 'cn_amateur' });
    ok(b2.total_results === 11, '重启后照样排除(worker)', b2.total_results);
    dns.mode.set(HOST_DEAD, 'ok');
    clock.t += 7 * HOUR;
    const rv = await cw2.coverCheck();
    const b3 = await cw2.browse({ b: 'cn_amateur' });
    ok(rv && rv.dead.length === 0 && b3.total_results === 19, '复活 → 回来(worker)', [rv && rv.dead, b3.total_results]);
    ro.close();
    await cw2.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* Windows 上文件可能还占着 */ }
}

console.log(`\ncover-health-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
