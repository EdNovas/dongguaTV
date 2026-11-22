#!/usr/bin/env node
// [adult] lib/site-catalog 回归(离线、零网络、假时钟):
//   node scripts/site-catalog-test.mjs
// (scripts/catalog-test.mjs 已经是首页 TMDB 分类浏览的测试,这里不能占用那个名字)
//  ⓪ util 纯函数:时长 / 时间解析、3%+5s 时长闸、同站连排打散、信号量
//  ① 爬虫:只请求 ac=list / ac=detail(绝不碰 m3u8 / 图片)、同域名同时 ≤1 且间隔 ≥2s、全局并发 ≤2、每轮 ≤120 请求、
//     预算用完存游标下一轮接着翻、pagesize 被截成 20 记下来、不认 h 的站一页就停、CATALOG_MAX_SITES / CATALOG_DISABLE
//  ② 入库:内容政策金丝雀(scripts/fixtures/adult/canaries.json,全部合成标题)0 条入库、主流影视丢弃、父分类硬拦继承、
//     库里每一行按 policy.checkItem 复查全部放行、mixed/uncat 路由(不可信番号绝不进日本区)
//  ③ 作品键:JUL-123 占位番号时长不同绝不合并、真番号跨站 3%+5s 内合并、#U / #clip(标题 / 时长 / 先片段后完整版)分开、
//     同站假番号自动降级、所有作品内线路时长两两对得上
//  ④ 读:审查过滤(review=hide / code 且 code_ok=0)在首页 / 浏览 / 作品 / 查找都生效、新上架同站连续 ≤4、
//     大类行最新 >72h 或不足 12 部隐藏、浏览同一快照内翻页稳定、浏览筛选、播放地址超过 3 天不给
//  ⑤ 扩线:全局 ≤12 / 单次 ≤6 并发、同作品并发合并、只搜 [带横线, 不带横线]、search:false / codeTrust:false 跳过、
//     正 6h / 负 24h 缓存、出错不缓存、搜到的线路写回索引、无关模糊结果不写
//  ⑥ 搜索回写(含先片段后完整版的迁移)、规则版本变了全库重扫(重扫完之前读接口回空)、保留期
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const adult = require(path.join(ROOT, 'lib/adult'));
const { createCatalog } = require(path.join(ROOT, 'lib/site-catalog'));
const U = require(path.join(ROOT, 'lib/site-catalog/util.js'));
const BASE_CLASSES = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/catalog/classes.json'), 'utf8')).class;
const CAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adult/canaries.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra).slice(0, 800))); } };
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const T0 = Date.UTC(2026, 10, 21, 4, 0, 0);   // 2026-11-21 12:00 北京时间
const fmt = (t) => new Date(t + 8 * HOUR).toISOString().replace('T', ' ').slice(0, 19);
const tick = () => new Promise((r) => setImmediate(r));

// ---------- 假时钟:sleep 立即返回但把时钟推到目标时刻(多个并发 sleeper 不会叠加) ----------
function mkClock(t) {
    const c = { t };
    c.now = () => c.t;
    c.sleep = async (ms) => { const target = c.t + ms; await tick(); if (c.t < target) c.t = target; };
    return c;
}

// ---------- 分类表:基础表 + 金丝雀用到的分类名(按名字自动编号;可挂父分类) ----------
const classes = BASE_CLASSES.map((c) => Object.assign({}, c));
let nextTid = 100;
function tidOf(name, parentName) {
    const pid = parentName ? tidOf(parentName) : 0;
    const hit = classes.find((c) => c.type_name === name && c.type_pid === pid);
    if (hit) return hit.type_id;
    const id = nextTid++;
    classes.push({ type_id: id, type_pid: pid, type_name: name });
    return id;
}
let vid = 1000;
function mk(name, typeName, o = {}) {
    const id = o.id != null ? o.id : vid++;
    const t = o.t != null ? o.t : T0 - 30 * MIN;
    return Object.assign({
        vod_id: id, vod_name: name, type_id: tidOf(typeName, o.parent), type_name: typeName,
        vod_time: fmt(t), _t: t, vod_duration: o.dur ? U.fmtDur(o.dur) : '', vod_remarks: o.rm || 'HD',
        vod_pic: 'https://img.example/p/' + id + '.jpg', vod_play_from: 'm3u8', vod_play_url: '正片$https://media.example/' + id + '/index.m3u8',
        vod_content: '',
    }, o.extra || {});
}

// ---------- 假 maccms 网络:记录每个请求、同域名/全局在途数 ----------
function mkNet(clock) {
    const net = { hosts: new Map(), log: [], inflight: new Map(), maxHost: 0, all: 0, maxAll: 0, latency: 300, realDelay: 0, wdIn: new Map(), wdMax: new Map(), wdAll: 0, wdAllMax: 0 };
    net.site = (key, cfg) => {
        const api = `https://${key}.test/api.php/provide/vod`;
        const s = Object.assign({ key, api, items: [], cap: 0, ignoreH: false, search: null, fail: false }, cfg || {});
        net.hosts.set(`${key}.test`, s);
        return s;
    };
    net.httpGet = async (url, opts) => {
        const u = new URL(url);
        const host = u.hostname;
        const rec = { url, host, start: clock.t, end: null, timeout: opts && opts.timeout, siteKey: opts && opts.siteKey, ac: u.searchParams.get('ac'), wd: u.searchParams.get('wd'),
            pg: Number(u.searchParams.get('pg')) || 0, ps: Number(u.searchParams.get('pagesize')) || 0, h: Number(u.searchParams.get('h')) || 0 };
        net.log.push(rec);
        const n = (net.inflight.get(host) || 0) + 1;
        net.inflight.set(host, n);
        if (n > net.maxHost) net.maxHost = n;
        if (++net.all > net.maxAll) net.maxAll = net.all;
        const wkey = rec.wd != null ? rec.wd.replace(/-/g, '').toUpperCase() : null;
        if (wkey) {
            const m = (net.wdIn.get(wkey) || 0) + 1;
            net.wdIn.set(wkey, m);
            net.wdMax.set(wkey, Math.max(net.wdMax.get(wkey) || 0, m));
            if (++net.wdAll > net.wdAllMax) net.wdAllMax = net.wdAll;
        }
        try {
            if (net.realDelay && wkey) await new Promise((r) => setTimeout(r, net.realDelay));
            else await tick();
            clock.t += net.latency;
            const s = net.hosts.get(host);
            if (!s) throw new Error('ENOTFOUND ' + host);
            if (s.fail) throw new Error('timeout of 10000ms exceeded');
            if (rec.ac === 'list') return { code: 1, msg: '数据列表', class: classes, list: [] };
            if (rec.wd != null) return JSON.stringify({ code: 1, page: 1, pagecount: 1, list: s.search ? s.search(rec.wd) : [] });   // 字符串响应也要认
            const ps = s.cap ? Math.min(s.cap, rec.ps || 20) : (rec.ps || 20);
            const win = (s.ignoreH || !rec.h ? s.items : s.items.filter((it) => it._t >= clock.t - rec.h * HOUR)).slice().sort((a, b) => b._t - a._t);
            const pg = rec.pg || 1;
            return { code: 1, page: pg, pagecount: Math.max(1, Math.ceil(win.length / ps)), limit: String(ps), total: win.length, list: win.slice((pg - 1) * ps, pg * ps) };
        } finally {
            rec.end = clock.t;
            net.all--;
            net.inflight.set(host, net.inflight.get(host) - 1);
            if (wkey) { net.wdIn.set(wkey, net.wdIn.get(wkey) - 1); net.wdAll--; }
        }
    };
    net.sitesCfg = () => [...net.hosts.values()].map((s) => ({ key: s.key, name: s.key.toUpperCase() + '站', api: s.api, search: !s.noSearch, active: s.active !== false, codeTrust: s.codeTrust !== false, family: s.family }));
    return net;
}
function mkCat(db, net, clock, extra = {}) {
    const logs = [];
    const cat = createCatalog({
        db, getSites: () => net.sitesCfg(), adult, httpGet: net.httpGet, log: (m) => logs.push(m),
        env: extra.env || {}, now: clock.now, sleep: clock.sleep, opts: extra.opts, referenced: extra.referenced,
    });
    cat._logs = logs;
    return cat;
}
const workRow = (db, wk) => db.prepare('SELECT * FROM adult_works WHERE wk=?').get(wk);
const itemsBy = (db, where, ...a) => db.prepare('SELECT * FROM adult_items WHERE ' + where).all(...a);
const pacingOk = (log, gap) => {
    const by = new Map();
    for (const r of log) { if (!by.has(r.host)) by.set(r.host, []); by.get(r.host).push(r); }
    const bad = [];
    for (const [h, rs] of by) { rs.sort((a, b) => a.start - b.start); for (let i = 1; i < rs.length; i++) if (rs[i].start - rs[i - 1].end < gap) bad.push([h, rs[i - 1].end, rs[i].start]); }
    return bad;
};

// =====================================================================
console.log('⓪ util');
{
    ok(U.parseDur('02:01:33') === 7293 && U.parseDur('1:2:03') === 3723 && U.parseDur('37:12') === 2232, '时:分:秒 / 分:秒');
    ok(U.parseDur('90分钟') === 5400 && U.parseDur('90 分钟') === 5400 && U.parseDur('136') === 8160, 'N分钟 / 纯数字 = 分钟');
    ok(U.parseDur('', '1:23:45') === 5025 && U.parseDur('', 'HD') === 0 && U.parseDur('', '12') === 0, '备注只认 时:分:秒');
    ok(U.parseDur('9:99:99') === 0 && U.parseDur('0') === 0 && U.parseDur(null, null) === 0, '非法时长 → 0');
    ok(U.parseTime('2026-11-21 12:00:00') === T0 && U.parseTime(T0 / 1000) === T0 && U.parseTime('垃圾') === 0, 'vod_time 按北京时间解析');
    ok(U.durCompatible(7200 + 0.03 * 7200 + 5, 7200) && !U.durCompatible(7200 + 0.03 * 7200 + 6, 7200) && U.durCompatible(0, 5) && U.durCompatible(5, 0), '3%+5s 时长闸(相对中位数);任一方未知算对得上');
    const items = [];
    for (let i = 0; i < 30; i++) items.push({ f: 'A', i });
    for (let i = 0; i < 5; i++) items.push({ f: 'B', i });
    const out = U.interleave(items, (x) => x.f, 24, 4);
    ok(U.maxRunOf(out, (x) => x.f) <= 4, '同站连排 ≤4', out.map((x) => x.f).join(''));
    ok(out.length === 25 - 1 || out.length === 24, '有别家可插时取满 24');
    const onlyA = U.interleave(items.slice(0, 30), (x) => x.f, 24, 4);
    ok(onlyA.length === 4, '只剩一家时截断而不是连排(新上架)', onlyA.length);
    const filled = U.interleave(items, (x) => x.f, 35, 4, true);
    ok(filled.length === 35 && U.maxRunOf(filled.slice(0, 25), (x) => x.f) <= 4, 'fill:有别家时照样打散、别家用完后照原顺序排满(大类行 / 浏览)', filled.map((x) => x.f).join(''));
    const rr = U.slotRoundRobin([{ s: 1, f: 'A' }, { s: 1, f: 'A' }, { s: 1, f: 'B' }, { s: 0, f: 'A' }], (x) => x.f, (x) => x.s);
    ok(rr.map((x) => x.f + x.s).join(',') === 'A1,B1,A1,A0', '同一小时槽里轮流出', rr);
    const sem = new U.Sem(3);
    let cur = 0, peak = 0;
    await Promise.all(Array.from({ length: 10 }, async () => { await sem.acquire(); cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 2)); cur--; sem.release(); }));
    ok(peak === 3 && sem.active === 0, '信号量上限', { peak, active: sem.active });
}

// =====================================================================
console.log('① ② ③ 爬虫 + 入库 + 作品键');
const clock = mkClock(T0);
const net = mkNet(clock);
const db = new Database(':memory:');
let keepRefs = [];
const SA = net.site('sa'), SB = net.site('sb'), SC = net.site('sc', { codeTrust: false }), SD = net.site('sd', { noSearch: true });
for (let i = 0; i < 40; i++) SA.items.push(mk(`SSIS-${300 + i} 某合成标题${i}`, '日本有码', { t: T0 - i * 30 * MIN - 5 * MIN, dur: 7000 + i * 30 }));
for (let i = 0; i < 14; i++) SB.items.push(mk(`某国产合成标题${i}号`, '国产自拍', { t: T0 - i * 40 * MIN - 7 * MIN, dur: 600 + i * 10 }));
for (let i = 0; i < 6; i++) SC.items.push(mk(`某欧美合成作品 ${i}`, '欧美系列', { t: T0 - i * HOUR - 9 * MIN, dur: 1500 + i * 100 }));
for (let i = 0; i < 6; i++) SD.items.push(mk(`某合成短视频${i}`, '抖音短视频', { t: T0 - i * HOUR - 11 * MIN, dur: 60 + i * 10 }));
// 内容政策金丝雀:要 codeOk=false / siteTrust=false 才拦的放到整站假番号的 sc;要父分类的挂到父分类下
const blockedNames = new Set();
CAN.block.forEach((c, i) => {
    const ctx = c.ctx || {};
    const extra = {};
    for (const k of ['vod_content', 'vod_sub', 'vod_tag', 'vod_class', 'vod_remarks', 'vod_blurb', 'vod_actor', 'vod_director', 'vod_area']) if (c.item[k] != null) extra[k] = c.item[k];
    const it = mk(c.item.vod_name, c.item.type_name || '精品推荐', { t: T0 - (i % 20) * 20 * MIN - 3 * MIN, dur: 1800 + i, parent: ctx.parentName, extra });
    (ctx.codeOk === false || ctx.siteTrust === false ? SC : (i % 2 ? SA : SB)).items.push(it);
    blockedNames.add(c.item.vod_name + '|' + (c.item.type_name || '精品推荐'));
});
const allowNames = [];
CAN.allow.forEach((c, i) => {
    const extra = {};
    for (const k of ['vod_content', 'vod_sub', 'vod_tag', 'vod_class', 'vod_remarks', 'vod_blurb', 'vod_actor', 'vod_director', 'vod_area']) if (c.item[k] != null) extra[k] = c.item[k];
    SD.items.push(mk(c.item.vod_name, c.item.type_name, { t: T0 - (i % 10) * HOUR - 13 * MIN, dur: 2400 + i * 37, extra }));
    allowNames.push(c.item.vod_name);
});
// 审查级 / 父分类 / 主流
SA.items.push(mk('SSIS-500 某合成剧情', '强奸乱伦', { t: T0 - HOUR, dur: 7100 }));            // code 级 + 可信番号 → 收
SA.items.push(mk('某无番号合成凌辱剧情', '强奸乱伦', { t: T0 - HOUR - MIN, dur: 3000 }));     // code 级无番号 → 不收
SA.items.push(mk('SSIS-501 某合成作品', '学生校园', { t: T0 - HOUR - 2 * MIN, dur: 7100 }));    // hide → 不收
SA.items.push(mk('普通合成标题', '日本', { t: T0 - HOUR - 3 * MIN, parent: '变态暗网', dur: 3000 }));   // 父分类硬拦
SB.items.push(mk('某合成电视剧 第1集', '国产剧', { t: T0 - HOUR, dur: 2700 }));                 // 主流 → 丢
const NOT_STORED = ['某无番号合成凌辱剧情', 'SSIS-501 某合成作品', '普通合成标题', '某合成电视剧 第1集'];
// 路由(精品推荐 = uncat)
SA.items.push(mk('ABCD-123 某合成素人', '精品推荐', { t: T0 - 8 * HOUR, dur: 1300 }));
SA.items.push(mk('SSIS-502 某合成作品', '精品推荐', { t: T0 - 8 * HOUR - MIN, dur: 7000 }));
SA.items.push(mk('ひとづまの合成午後', '精品推荐', { t: T0 - 8 * HOUR - 2 * MIN, dur: 5000 }));
SA.items.push(mk('MD-0315 某合成传媒作品', '精品推荐', { t: T0 - 8 * HOUR - 3 * MIN, dur: 2000 }));
SA.items.push(mk('[中文字幕] SSIS-503 某合成', '精品推荐', { t: T0 - 8 * HOUR - 4 * MIN, dur: 7000 }));
// 真番号跨站 / #U / #clip / 假番号站
SA.items.push(mk('SSIS-600 某合成标题', '日本有码', { t: T0 - 2 * HOUR, dur: 7200 }));
SB.items.push(mk('[中文字幕] SSIS-600 另一个合成标题', '中文字幕', { t: T0 - 2 * HOUR - MIN, dur: 7203 }));
SB.items.push(mk('[无码流出] SSIS-600 某合成标题', '日本无码', { t: T0 - 2 * HOUR - 2 * MIN, dur: 7200 }));
SA.items.push(mk('水果派解说 SSIS-600', 'AV解说', { t: T0 - 2 * HOUR - 3 * MIN, dur: 600 }));
SC.items.push(mk('SSIS-600 某合成标题', '日本有码', { t: T0 - 2 * HOUR - 4 * MIN, dur: 7200 }));
SA.items.push(mk('SSIS-601 某合成甲', '日本有码', { t: T0 - 3 * HOUR, dur: 7200 }));
SB.items.push(mk('SSIS-601 某合成甲', '日本有码', { t: T0 - 3 * HOUR - MIN, dur: 900 }));
SA.items.push(mk('SSIS-602 某合成乙', '日本有码', { t: T0 - 4 * HOUR, dur: 1000 }));
SB.items.push(mk('SSIS-602 某合成乙', '日本有码', { t: T0 - 4 * HOUR - MIN, dur: 7000 }));
SA.items.push(mk('SSIS-603 某合成丙', '日本有码', { t: T0 - 5 * HOUR, dur: 7200 }));
SB.items.push(mk('SSIS-603 某合成丙', '日本有码', { t: T0 - 5 * HOUR - MIN, dur: 5000 }));
// JUL-123 占位番号:同标题、不同片子
SA.items.push(mk('JUL-123 人妻', '日本有码', { t: T0 - 6 * HOUR, dur: 3600 }));
SB.items.push(mk('JUL-123 人妻', '日本有码', { t: T0 - 6 * HOUR - MIN, dur: 7200 }));
SC.items.push(mk('JUL-123 人妻', '日本有码', { t: T0 - 6 * HOUR - 2 * MIN, dur: 3601 }));
SB.items.push(mk('JUL-123 人妻', '日本有码', { t: T0 - 6 * HOUR - 3 * MIN, dur: 9000 }));
SA.items.push(mk('JUL-123 某合成熟女', '日本有码', { t: T0 - 6 * HOUR - 4 * MIN, dur: 4000 }));
// 同站假番号:一个番号挂 3 个标题、时长对不上
SB.items.push(mk('ABP-777 合成标题一', '日本有码', { t: T0 - 7 * HOUR, dur: 3600 }));
SB.items.push(mk('ABP-777 合成标题二', '日本有码', { t: T0 - 7 * HOUR - MIN, dur: 5400 }));
SB.items.push(mk('ABP-777 合成标题三', '日本有码', { t: T0 - 7 * HOUR - 2 * MIN, dur: 1800 }));

const cat = mkCat(db, net, clock, { referenced: () => keepRefs });
{
    const r = await cat.tick();
    ok(r && r.requests > 0 && r.requests <= 120 && r.ingested > 100, '第一轮爬完', r);
    const urls = net.log.map((x) => x.url);
    ok(urls.every((u) => /^https:\/\/s[a-d]\.test\/api\.php\/provide\/vod\?ac=(?:list|detail)(?:&|$)/.test(u)), '只请求 ac=list / ac=detail', urls.filter((u) => !/\?ac=(?:list|detail)/.test(u)));
    ok(!urls.some((u) => /m3u8|\.jpe?g|\.png|\.webp|img\.example|media\.example/i.test(u)), '绝不请求 m3u8 / 图片');
    ok(net.log.filter((x) => x.ac === 'detail').every((x) => x.h === 72 && x.ps === 60), '首轮 h=72、pagesize=60');
    ok(net.log.every((x) => x.timeout === 10000 && x.siteKey === x.host.split('.')[0]), '超时 10s、带 siteKey');
    ok(net.maxHost === 1, '同域名同时最多 1 个请求', net.maxHost);
    ok(net.maxAll <= 2, '全局并发 ≤2', net.maxAll);
    const bad = pacingOk(net.log, 2000);
    ok(bad.length === 0, '同域名两次请求间隔 ≥2s', bad.slice(0, 5));
    ok(!urls.some((u) => /[?&]t=/.test(u)), '从不按 &t= 拉分类');
}
{
    // ② 金丝雀 0 入库、主流丢弃、库里每一行复查政策
    const rows = itemsBy(db, '1');
    const leaked = rows.filter((r) => blockedNames.has(r.name + '|' + r.type_name));
    ok(leaked.length === 0, '内容政策金丝雀 0 条入库(' + blockedNames.size + ' 条)', leaked.map((r) => r.name));
    for (const n of NOT_STORED) ok(!rows.some((r) => r.name === n), '不入库:' + n);
    const missing = allowNames.filter((n) => !rows.some((r) => r.name === n));
    ok(missing.length === 0, '放行金丝雀全部入库(' + allowNames.length + ' 条)', missing);
    let recheckBad = [];
    for (const r of rows) {
        const raw = JSON.parse(r.raw);
        const info = cat.classInfo(r.site, raw.t);
        const res = info ? adult.policy.checkItem({ vod_name: raw.n, vod_sub: raw.s, vod_content: raw.c, vod_blurb: raw.b, type_name: raw.tn, vod_tag: raw.tg, vod_class: raw.cl, vod_remarks: raw.rm },
            { cls: Object.assign({ tags: [] }, info), codeOk: r.code_ok === 1, siteTrust: r.site !== 'sc' }) : { ok: false, reason: 'no class' };
        if (!res.ok || (info && info.block)) recheckBad.push([r.name, res.reason]);
        if (r.review === 'hide' || (r.review === 'code' && r.code_ok !== 1)) recheckBad.push([r.name, 'review ' + r.review]);
    }
    ok(recheckBad.length === 0, '库里 ' + rows.length + ' 行按 policy.checkItem 复查全部放行', recheckBad.slice(0, 10));
    ok(!rows.some((r) => adult.taxonomy.DROP_BUCKETS.includes(r.bucket) || !adult.taxonomy.isNavBucket(r.bucket)), '库里只有导航大类');
    const st = cat.stats();
    ok(st.rejected.category > 0 && st.rejected.mainstream > 0 && Object.keys(st.rejected).some((k) => k.startsWith('item:')) && st.rejected['review:code'] > 0 && st.rejected['review:hide'] > 0, '各类拦截都有计数', st.rejected);
    // 父分类硬拦:classInfo 看得到
    const child = cat.classInfo('sa', tidOf('日本', '变态暗网'));
    ok(child && child.block === true && child.parentName === '变态暗网', 'classInfo:子分类继承父分类硬拦', child);
    ok(cat.classInfo('sa', 1).bucket === 'jp_censored' && cat.classInfo('sa', 7).review === 'code' && cat.classInfo('nope', 1) === null && cat.classInfo('sa', 99999) === null, 'classInfo 基本字段');
    // 路由:不可信番号绝不进日本区
    const b = (n) => (rows.find((r) => r.name === n) || {}).bucket;
    ok(b('ABCD-123 某合成素人') === 'cn_amateur', 'uncat + 不可信番号 → 国产自拍', b('ABCD-123 某合成素人'));
    ok(b('SSIS-502 某合成作品') === 'jp_censored' && b('[中文字幕] SSIS-503 某合成') === 'jp_subbed', 'uncat + 可信番号 → 日本区(中字分开)');
    ok(b('ひとづまの合成午後') === 'jp_censored', 'uncat + 假名 → 日本区');
    ok(b('MD-0315 某合成传媒作品') === 'cn_studio', 'uncat + 国产传媒番号 → 国产传媒');
    ok(b('SSIS-500 某合成剧情') && b('SSIS-500 某合成剧情').startsWith('jp_'), 'code 级分类 + 可信番号 → 收进日本区');
    const routedBad = rows.filter((r) => {
        const info = cat.classInfo(r.site, JSON.parse(r.raw).t);
        return info && (info.bucket === 'mixed' || info.bucket === 'uncat') && /^jp_/.test(r.bucket) && r.code_ok !== 1 && !/[\u3041-\u3096\u30a1-\u30fa]/.test(r.name);
    });
    ok(routedBad.length === 0, 'mixed/uncat 里没有可信番号、没有假名的条目一条都没进日本区', routedBad.map((r) => r.name));
}
{
    // ③ 作品键
    const wkOf = (site, name) => { const r = db.prepare('SELECT wk FROM adult_items WHERE site=? AND name=?').all(site, name); return r.map((x) => x.wk); };
    const w600 = workRow(db, 'c:SSIS-600');
    ok(w600 && w600.n_sites === 2 && w600.sites === ',sa,sb,' || (w600 && w600.n_sites === 2 && w600.sites === ',sb,sa,'), '真番号跨站时长 3%+5s 内合并(中字副本也算)', w600);
    ok(wkOf('sb', '[无码流出] SSIS-600 某合成标题')[0] === 'c:SSIS-600#U', '无码流出 → #U 独立作品');
    ok(wkOf('sa', '水果派解说 SSIS-600')[0] === 'c:SSIS-600#clip', '解说标题 → #clip 独立作品');
    ok(wkOf('sc', 'SSIS-600 某合成标题')[0].startsWith('t:'), '整站假番号的站(codeTrust:false)不进番号作品', wkOf('sc', 'SSIS-600 某合成标题'));
    ok(wkOf('sb', 'SSIS-601 某合成甲')[0] === 'c:SSIS-601#clip' && wkOf('sa', 'SSIS-601 某合成甲')[0] === 'c:SSIS-601', '时长 < 50% → #clip', [wkOf('sa', 'SSIS-601 某合成甲'), wkOf('sb', 'SSIS-601 某合成甲')]);
    ok(wkOf('sb', 'SSIS-602 某合成乙')[0] === 'c:SSIS-602' && wkOf('sa', 'SSIS-602 某合成乙')[0] === 'c:SSIS-602#clip', '片段完整版谁先到都一样:完整版占主键、片段去 #clip', [wkOf('sa', 'SSIS-602 某合成乙'), wkOf('sb', 'SSIS-602 某合成乙')]);
    const w603 = [wkOf('sa', 'SSIS-603 某合成丙')[0], wkOf('sb', 'SSIS-603 某合成丙')[0]];
    ok(w603[0] !== w603[1] && w603.every((x) => /^c:SSIS-603(~\d+)?$/.test(x)), '时长差 >3%+5s 不到一半 → 分开(~2)', w603);
    const jul = itemsBy(db, "name LIKE 'JUL-123%'");
    ok(jul.length === 5 && jul.every((r) => r.wk.startsWith('t:')), 'JUL-123 占位番号从不进番号作品', jul.map((r) => r.wk));
    const julW = new Map();
    for (const r of jul) { if (!julW.has(r.wk)) julW.set(r.wk, []); julW.get(r.wk).push(r.dur); }
    const julMixed = [...julW.values()].filter((ds) => ds.some((x) => !U.durCompatible(x, U.median(ds))));
    ok(julMixed.length === 0 && julW.size === 4, 'JUL-123:时长差 >3% 的绝不合并(3600/3601 合、7200、9000、另一标题各自独立)', [...julW.entries()]);
    const sameA = jul.find((r) => r.dur === 3600), sameC = jul.find((r) => r.dur === 3601);
    ok(sameA && sameC && sameA.wk === sameC.wk, 'JUL-123:同标题且时长对得上的合并', [sameA && sameA.wk, sameC && sameC.wk]);
    const abp = itemsBy(db, "site='sb' AND ckey='ABP-777'");
    ok(abp.length === 3 && abp.filter((r) => r.wk.startsWith('t:')).length >= 1 && cat.stats().flags.autoflag >= 1, '同站同番号挂 3 个标题且时长对不上 → 后来的降级为无番号', abp.map((r) => [r.name, r.wk]));
    // 全库不变量:每个作品里的线路时长都对得上中位数
    const all = db.prepare('SELECT wk, dur FROM adult_items WHERE dur > 0').all();
    const byWk = new Map();
    for (const r of all) { if (!byWk.has(r.wk)) byWk.set(r.wk, []); byWk.get(r.wk).push(r.dur); }
    const badWk = [...byWk.entries()].filter(([, ds]) => ds.some((x) => !U.durCompatible(x, U.median(ds))));
    ok(badWk.length === 0, '全库:没有一个作品混着时长对不上的线路', badWk.slice(0, 5));
    // 番号作品只来自可信番号
    const badC = db.prepare("SELECT name, wk, code_ok FROM adult_items WHERE substr(wk,1,2)='c:' AND code_ok <> 1").all();
    ok(badC.length === 0, '番号作品里每一条都 code_ok=1', badC);
    // 作品名首见冻结、番号作品 = 番号 + 净标题
    ok(w600 && w600.name === 'SSIS-600 某合成标题', '番号作品名 = 番号 净标题', w600 && w600.name);
    ok(workRow(db, 'c:SSIS-600#U').name.endsWith('[无码流出]') && workRow(db, 'c:SSIS-600#clip').name.endsWith('[解说]'), '#U / #clip 作品名带后缀');
    const names = db.prepare('SELECT name, COUNT(*) n FROM adult_works GROUP BY name HAVING n > 1').all();
    ok(names.length === 0, '作品名不重复(撞名加 · 2)', names);
}

// =====================================================================
console.log('④ 读:首页 / 浏览 / 作品 / 审查过滤');
{
    const h = cat.home();
    const ids = h.rows.map((r) => r.id);
    ok(ids[0] === 'new' && h.rows[0].title === '新上架' && h.rows[0].items.length === 24, '新上架一行 24 张', h.rows[0] && h.rows[0].items.length);
    const famOf = (c) => workRow(db, c.wk).first_site;
    ok(U.maxRunOf(h.rows[0].items, famOf) <= 4, '新上架同站连续 ≤4', h.rows[0].items.map(famOf).join(','));
    ok(new Set(h.rows[0].items.map((c) => c.wk)).size === 24, '新上架按作品去重');
    ok(ids.includes('jp_censored') && ids.includes('cn_amateur'), '够 12 部且新鲜的大类行显示', ids);
    ok(!ids.includes('short') && !ids.includes('western'), '不足 12 部的大类行隐藏', ids);
    const shortRows = h.rows.filter((r) => r.id !== 'new' && r.items.length < 12);
    ok(shortRows.length === 0, '显示出来的大类行至少 12 张(一个站独占也不截成 4 张)', shortRows.map((r) => [r.id, r.items.length]));
    const jpRow = h.rows.find((r) => r.id === 'jp_censored');
    ok(jpRow && jpRow.items.length === 24 && U.maxRunOf(jpRow.items.slice(0, 12), (c) => workRow(db, c.wk).first_site) <= 4, '大类行也打散连排', jpRow && jpRow.items.map((c) => workRow(db, c.wk).first_site).join(','));
    const order = ['new', 'cn_amateur', 'cn_studio', 'cn_hookup', 'live', 'creators', 'short', 'jp_censored', 'jp_uncensored', 'jp_subbed', 'western', 'anime', 'softcore', 'fetish', 'random'];
    ok(ids.every((id, i) => i === 0 || order.indexOf(id) > order.indexOf(ids[i - 1])), '行顺序按规格', ids);
    const c0 = h.rows[0].items[0];
    ok(c0 && typeof c0.wk === 'string' && typeof c0.name === 'string' && typeof c0.sub === 'string' && ['', '中字', '无码', '竖屏'].includes(c0.badge) && c0.n_sites >= 1 && c0.first_seen > 0, '卡片字段', c0);
    const jp = h.rows.find((r) => r.id === 'jp_censored');
    ok(jp.more && jp.more.b === 'jp_censored' && jp.today > 0, '大类行带 more.b 和今日计数', { more: jp.more, today: jp.today });
    const sub600 = cat.browse({ b: 'jp_subbed' }).results;
    ok(sub600.every((c) => c.badge === '中字'), '中字大类卡片角标 = 中字');
    const cSub = jp.items.find((c) => c.dur > 0);
    ok(cSub && /^\d+(分钟|小时)前 · \d+:\d\d:\d\d · \d+线$/.test(cSub.sub), "副标题 'N小时前 · 2:01:33 · N线'", cSub && cSub.sub);
    const bk = cat.buckets();
    ok(bk.length === 17 && bk.every((b) => b.nav === true && typeof b.today === 'number' && b.label) && bk.find((b) => b.id === 'jp_censored').today > 0, 'buckets(): 17 个导航大类 + 今日数', bk.map((b) => b.id + ':' + b.today));
    // 一次 home() 之后,首页零上游请求
    const n0 = net.log.length;
    for (let i = 0; i < 5; i++) { cat.home(); cat.browse({ page: 2 }); cat.buckets(); await cat.work('c:SSIS-600'); }
    ok(net.log.length === n0, '首页 / 浏览 / 作品读取零上游请求');
}
{
    // 大类行:最新一部 >72h → 隐藏;补一部新的 → 出现
    const old = [];
    for (let i = 0; i < 15; i++) old.push(mk(`某合成动漫 第${i}话`, '动漫里番', { t: T0 - 80 * HOUR - i * MIN, dur: 1400 + i * 50 }));
    cat.ingestSearchItems('sa', old);
    await cat.flush();
    ok(itemsBy(db, "bucket='anime'").length === 15 && itemsBy(db, "bucket='anime' AND src='search'").length === 15, '搜索回写入库(src=search)');
    cat.rebuild();
    ok(!cat.home().rows.some((r) => r.id === 'anime'), '大类行最新一部 >72h → 隐藏');
    cat.ingestSearchItems('sb', [mk('某合成动漫新番 第1话', '动漫里番', { t: clock.t - 10 * MIN, dur: 1440 })]);
    await cat.flush();
    clock.t += 10 * MIN;
    ok(cat.home().rows.some((r) => r.id === 'anime'), '补一部新的、10 分钟后快照重建 → 出现');
}
{
    // 浏览:同一快照内翻页稳定
    const p1 = cat.browse({ sort: 'new', page: 1 });
    ok(p1.results.length === 24 && p1.total_pages === Math.ceil(p1.total_results / 24) && p1.page === 1, '浏览 TMDB 形状', { n: p1.results.length, tp: p1.total_pages, tr: p1.total_results });
    ok(U.maxRunOf(p1.results, (c) => workRow(db, c.wk).first_site) <= 4, '浏览按新上架排序也打散连排');
    const fresh = [];
    for (let i = 0; i < 30; i++) fresh.push(mk(`某合成新片 ${i}`, '国产自拍', { t: clock.t - MIN, dur: 900 + i * 40 }));
    cat.ingestSearchItems('sb', fresh);
    await cat.flush();
    clock.t += 2 * MIN;
    const p2 = cat.browse({ sort: 'new', page: 2 });
    const s1 = new Set(p1.results.map((c) => c.wk));
    ok(p2.total_results === p1.total_results && p2.results.length === 24 && !p2.results.some((c) => s1.has(c.wk)), '快照内新入库不影响翻页(不重复、总数不变)', { t1: p1.total_results, t2: p2.total_results });
    ok(![...p1.results, ...p2.results].some((c) => /^某合成新片/.test(c.name)), '快照之后的新作品不插进当前快照');
    clock.t += 10 * MIN;
    const p1b = cat.browse({ sort: 'new', page: 1 });
    ok(p1b.total_results >= p1.total_results + 30 && p1b.results.some((c) => /^某合成新片/.test(c.name)), '10 分钟后新快照带上新作品', p1b.total_results);
    // 筛选
    const sh = cat.browse({ dur: 's' });
    ok(sh.results.length > 0 && sh.results.every((c) => c.dur > 0 && c.dur < 600), '时长 <10 分钟筛选');
    const lg = cat.browse({ dur: 'l' });
    ok(lg.results.length > 0 && lg.results.every((c) => c.dur > 3600), '时长 >60 分钟筛选');
    const zh = cat.browse({ flag: 'zh' });
    ok(zh.results.length > 0 && zh.results.every((c) => c.badge === '中字'), '中字筛选');
    const unc = cat.browse({ flag: 'unc' });
    ok(unc.results.length > 0 && unc.results.some((c) => c.wk === 'c:SSIS-600#U'), '无码筛选含 #U');
    const dsort = cat.browse({ b: 'jp_censored', sort: 'dur' }).results.map((c) => c.dur);
    ok(dsort.length > 1 && dsort.every((x, i) => i === 0 || x <= dsort[i - 1]), '时长排序');
    const r1 = cat.browse({ sort: 'random' }).results.map((c) => c.wk), r2 = cat.browse({ sort: 'random' }).results.map((c) => c.wk);
    ok(r1.length === 24 && r1.join() === r2.join(), '随机排序同一天稳定');
    ok(cat.browse({ b: 'nope' }).total_results === 0 && cat.browse({ tag: 'nope' }).total_results === 0, '未知大类 / 标签 → 空');
    ok(cat.browse({ tag: 'incest' }).results.every((c) => /^c:/.test(c.wk)), '敏感标签只在浏览筛选里,且只有可信番号的作品');
    ok(!cat.browse({}).results.some((c) => /#clip/.test(c.wk)) && cat.browse({ b: 'commentary' }).results.some((c) => /#clip/.test(c.wk)), '#clip 只在 AV解说 里出现');
    ok(cat.browse({ page: 9999 }).page === 500, '页码上限 500');
}
{
    // 作品 / 线路
    const g = await cat.work('c:SSIS-600');
    ok(g && g._wk === 'c:SSIS-600' && g.name === 'SSIS-600 某合成标题' && g.sources.length === 2, '作品:两站两条线路', g && g.sources.map((s) => s.site_key));
    ok(g.sources[0]._variant === '中字' && g.sources[0].site_name.endsWith('· 中字'), '中字线路排前、站名带变体', g.sources[0]);
    ok(g.sources.every((s) => s.vod_play_url && s.vod_id && s.vod_name && s.type_name && s._dur > 7000), '线路字段(新鲜的带播放串)', g.sources);
    ok(g._meta.code === 'SSIS-600' && g._meta.dur >= 7200 && g._meta.n_sites === 2 && g._meta.bucket.startsWith('jp_'), '_meta', g._meta);
    const sib = g._meta.siblings.map((s) => s.kind).sort().join(',');
    ok(sib === 'U,clip', '_meta.siblings 指向 #U / #clip', g._meta.siblings);
    ok((await cat.work('c:NOPE-000')) === null && (await cat.work('')) === null && (await cat.work(null)) === null, '不存在 / 非法 wk → null');
    ok(cat.lookup('ssis 600').some((c) => c.wk === 'c:SSIS-600') && cat.lookup('SSIS600').length >= 2, '本地查找按番号命中');
    ok(cat.lookup('某合成短视频').length > 0 && cat.lookup('偷拍').length === 0, '本地查找文字;拦截词直接空');
}
{
    // 审查过滤(库被改坏 / 旧数据也要拦):作品级 & 线路级
    const jp = cat.browse({ b: 'jp_censored' }).results;
    const wkCode = jp[0].wk, wkHide = jp[1].wk;
    db.prepare("UPDATE adult_works SET review='code', code_ok=0 WHERE wk=?").run(wkCode);
    db.prepare("UPDATE adult_works SET review='hide' WHERE wk=?").run(wkHide);
    db.prepare("UPDATE adult_items SET review='hide' WHERE wk='c:SSIS-600' AND site='sb'").run();
    cat.rebuild();
    const seen = new Set();
    for (const r of cat.home().rows) for (const c of r.items) seen.add(c.wk);
    for (let p = 1; p <= 30; p++) { const b = cat.browse({ page: p }); for (const c of b.results) seen.add(c.wk); if (p >= b.total_pages) break; }
    for (const c of cat.browse({ b: 'jp_censored' }).results) seen.add(c.wk);
    ok(!seen.has(wkCode) && !seen.has(wkHide), "review='code' 且 code_ok=0 / review='hide' 的作品在首页和浏览都看不到", [wkCode, wkHide]);
    ok((await cat.work(wkCode)) === null && (await cat.work(wkHide)) === null, '…work() 也拿不到');
    const code = workRow(db, wkCode).code;
    ok(!cat.lookup(code).some((c) => c.wk === wkCode), '…本地查找也查不到');
    const g = await cat.work('c:SSIS-600');
    ok(g && g.sources.length === 1 && g.sources[0].site_key === 'sa', '线路级 review=hide 的那条不给', g && g.sources);
    db.prepare("UPDATE adult_items SET review=NULL WHERE wk='c:SSIS-600' AND site='sb'").run();
}

// =====================================================================
console.log('⑥ 搜索回写 / 先片段后完整版 / 规则重扫 / 保留期');
{
    const n0 = itemsBy(db, '1').length;
    cat.ingestSearchItems('sa', [mk('某合成偷拍视频', '国产自拍', { t: clock.t - HOUR }), mk('某合成正常视频', '国产自拍', { t: clock.t - HOUR, dur: 700 }), null, 'x']);
    cat.ingestSearchItems('zz-not-a-site', [mk('某合成正常视频2', '国产自拍')]);
    cat.ingestSearchItems('sa', 'not-an-array');
    await cat.flush();
    const rows = itemsBy(db, '1');
    ok(rows.length === n0 + 1 && rows.some((r) => r.name === '某合成正常视频' && r.src === 'search') && !rows.some((r) => r.name === '某合成偷拍视频'), '搜索回写:政策再查一遍,拦截的不写、正常的写', rows.length - n0);
    // 没有 vod_time 的搜索条目不进新上架
    cat.ingestSearchItems('sa', [Object.assign(mk('某合成无时间条目', '国产自拍', { dur: 800 }), { vod_time: '' })]);
    await cat.flush();
    const nt = itemsBy(db, "name='某合成无时间条目'")[0];
    ok(nt && nt.first_seen <= clock.t - 29 * DAY, '没有上架时间的搜索条目首见时间记成 30 天前', nt && (clock.t - nt.first_seen) / DAY);
    // 先片段后完整版(确定顺序)
    cat.ingestSearchItems('sa', [mk('SSIS-610 某合成丁', '日本有码', { t: clock.t - HOUR, dur: 1000 })]);
    await cat.flush();
    ok(itemsBy(db, "site='sa' AND name='SSIS-610 某合成丁'")[0].wk === 'c:SSIS-610', '片段先到 → 先占主键');
    cat.ingestSearchItems('sb', [mk('SSIS-610 某合成丁', '日本有码', { t: clock.t - HOUR, dur: 7000 })]);
    await cat.flush();
    ok(itemsBy(db, "site='sb' AND name='SSIS-610 某合成丁'")[0].wk === 'c:SSIS-610' && itemsBy(db, "site='sa' AND name='SSIS-610 某合成丁'")[0].wk === 'c:SSIS-610#clip', '完整版到了 → 片段挪去 #clip');
    ok(workRow(db, 'c:SSIS-610').name === 'SSIS-610 某合成丁' && workRow(db, 'c:SSIS-610#clip').name === 'SSIS-610 某合成丁 [解说]' && cat.stats().migrated >= 1, '迁移后两个作品名正确', [workRow(db, 'c:SSIS-610'), workRow(db, 'c:SSIS-610#clip')].map((w) => w && w.name));
}
{
    // 规则版本变了:新实例启动 → 重扫完之前读接口回空;重扫删掉不合格的行、合格的不动
    const before = new Map(itemsBy(db, '1').map((r) => [r.site + '|' + r.vod_id, r.wk]));
    const good = itemsBy(db, "site='sb' AND name='某国产合成标题0号'")[0];
    const raw = JSON.parse(good.raw);
    raw.n = '某合成标题 偷拍 版';
    db.prepare(`INSERT INTO adult_items (site, vod_id, wk, bucket, tags, review, code_ok, name, clean, code, ckey, tkey, pic, dur, vod_time, first_seen, last_seen,
        type_id, type_name, play_from, play_url, play_at, variant, flags, family, src, raw)
        SELECT site, 'fake-1', 't:fakebad', bucket, tags, review, code_ok, '某合成标题 偷拍 版', clean, code, ckey, 'fakebad', pic, dur, vod_time, first_seen, last_seen,
        type_id, type_name, play_from, play_url, play_at, variant, flags, family, src, ? FROM adult_items WHERE site=? AND vod_id=?`).run(JSON.stringify(raw), good.site, good.vod_id);
    db.prepare(`INSERT INTO adult_works (wk, name, bucket, tags, review, code_ok, pic, dur_med, n_sites, sites, first_site, first_seen, last_seen, rand)
        VALUES ('t:fakebad', '某合成标题 偷拍 版', 'cn_amateur', '', NULL, 0, '', 0, 1, ',sb,', 'sb', ?, ?, 1)`).run(clock.t, clock.t);
    db.prepare("UPDATE adult_meta SET v='p0-old' WHERE k='rules'").run();
    // 站点配置还没加载(空列表)→ 不重扫、不删任何行,读接口回空
    const nItems = itemsBy(db, '1').length;
    const cat0 = createCatalog({ db, getSites: () => [], adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep });
    ok(cat0.home().rows.length === 0, '站点列表空 + 规则版本不一致 → 读接口回空');
    await cat0.flush();
    ok(itemsBy(db, '1').length === nItems && cat0.stats().rescanPending === true && db.prepare("SELECT v FROM adult_meta WHERE k='rules'").get().v === 'p0-old', '…重扫推迟,一行都不删');
    const cat2 = mkCat(db, net, clock, { referenced: () => keepRefs });
    const h0 = cat2.home();
    ok(h0.rows.length === 0 && cat2.stats().rescanPending === true, '规则版本不一致:重扫完之前首页回空', h0.rows.length);
    ok((await cat2.work('c:SSIS-600')) === null && cat2.browse({}).total_results === 0 && cat2.lookup('SSIS-600').length === 0, '…作品 / 浏览 / 查找也回空');
    await cat2.flush();
    ok(cat2.stats().rescanPending === false && db.prepare("SELECT v FROM adult_meta WHERE k='rules'").get().v === adult.RULES_VERSION, '重扫完成、记下新规则版本');
    ok(!itemsBy(db, "vod_id='fake-1'").length && !workRow(db, 't:fakebad'), '重扫删掉不合格的行和它的作品');
    const after = new Map(itemsBy(db, '1').map((r) => [r.site + '|' + r.vod_id, r.wk]));
    const abpKeys = new Set(itemsBy(db, "ckey='ABP-777'").map((r) => r.site + '|' + r.vod_id));
    const changed = [...before].filter(([k, wk]) => !abpKeys.has(k) && after.get(k) !== wk);
    ok(after.size === before.size && changed.length === 0, '合格的行全部保留、作品键不变(同站假番号的除外)', { before: before.size, after: after.size, changed: changed.slice(0, 5) });
    ok(itemsBy(db, "site='sb' AND ckey='ABP-777' AND substr(wk,1,2)='c:'").length === 0, '重扫时同站假番号三条全部降级');
    ok(cat2.home().rows.length > 3, '重扫完首页恢复');
}
{
    // 播放地址超过 3 天不给;保留期 30 天(被引用的作品保留)
    clock.t += 3 * DAY + HOUR;
    const g = await cat.work('c:SSIS-600');
    ok(g && g.sources.length === 2 && g.sources.every((s) => !('vod_play_url' in s) && !('vod_play_from' in s)), '播放地址超过 3 天 → 不给(前端走 /api/detail)', g && g.sources);
    clock.t += 28 * DAY;
    keepRefs = ['SSIS-600 某合成标题', 'c:SSIS-601'];
    const n = cat.retention();
    const left = itemsBy(db, '1');
    ok(n > 0 && left.length > 0 && left.every((r) => r.wk === 'c:SSIS-600' || r.wk === 'c:SSIS-601'), '30 天没再见到的删掉,被引用的作品(按名字 / wk)保留', left.map((r) => r.wk));
    ok(db.prepare('SELECT COUNT(*) n FROM adult_works').get().n === 2, '没有线路的作品一起删');
    keepRefs = { [Symbol.iterator]() { throw new Error('boom'); } };
    ok(cat.retention() === 0 && itemsBy(db, '1').length === left.length, 'referenced() 出错 → 这轮一条都不删');
}

// =====================================================================
console.log('① 爬虫预算 / 游标续爬 / pagesize / 不认 h / 调度');
{
    const c2 = mkClock(T0);
    const n2 = mkNet(c2);
    n2.latency = 50;
    const db2 = new Database(':memory:');
    const big = ['b1', 'b2', 'b3'].map((k) => n2.site(k));
    big.forEach((s, j) => { for (let i = 0; i < 2400; i++) s.items.push(mk(`某合成国产 ${s.key}-${i}`, '国产自拍', { t: T0 - i * MIN - j * 7 * 1000, dur: 300 + (i % 500) })); });
    const capped = n2.site('b4', { cap: 20 });
    for (let i = 0; i < 100; i++) capped.items.push(mk(`某合成短片 b4-${i}`, '国产自拍', { t: T0 - 5 * HOUR - i * 10e3, dur: 200 + i }));   // 每天一批:一个钟点里传完
    const noH = n2.site('b5', { ignoreH: true });
    for (let i = 0; i < 300; i++) noH.items.push(mk(`某合成老片 b5-${i}`, '国产自拍', { t: T0 - 70 * HOUR - i * HOUR, dur: 1000 + i }));
    const cat3 = mkCat(db2, n2, c2);
    const r1 = await cat3.tick();
    ok(r1.requests <= 120 && n2.log.length <= 120 && r1.requests === n2.log.length, '每轮 ≤120 个请求', { r: r1.requests, log: n2.log.length });
    ok(n2.maxHost === 1 && n2.maxAll <= 2 && pacingOk(n2.log, 2000).length === 0, '预算轮也守住同域名串行 / 间隔 / 全局并发', { maxHost: n2.maxHost, maxAll: n2.maxAll });
    const st1 = cat3.stats().sites;
    const resuming = st1.filter((s) => s.resuming);
    ok(resuming.length >= 1, '预算用完的站存了游标', st1);
    const b5d = n2.log.filter((x) => x.host === 'b5.test' && x.ac === 'detail');
    ok(b5d.length === 1 && st1.find((s) => s.site === 'b5').ignores_h === 1, '不认 h 的站一页就停', b5d.length);
    const b4s = st1.find((s) => s.site === 'b4');
    ok(b4s && b4s.pagesize === 20, 'pagesize 被截成 20 记下来', b4s);
    // 第二轮:续爬的站从下一页接着翻,h 不变
    const lastPg = new Map();
    for (const x of n2.log) if (x.ac === 'detail') lastPg.set(x.host, { pg: x.pg, h: x.h, ps: x.ps });
    const mark = n2.log.length;
    c2.t += MIN;
    const r2 = await cat3.tick();
    const firstOf = new Map();
    for (const x of n2.log.slice(mark)) if (x.ac === 'detail' && !firstOf.has(x.host)) firstOf.set(x.host, x);
    const res = resuming.map((s) => s.site + '.test');
    ok(res.every((h) => firstOf.get(h) && firstOf.get(h).pg === lastPg.get(h).pg + 1 && firstOf.get(h).h === lastPg.get(h).h && firstOf.get(h).ps === lastPg.get(h).ps), '下一轮从下一页续爬(h / pagesize 不变)',
        res.map((h) => [h, lastPg.get(h), firstOf.get(h) && { pg: firstOf.get(h).pg, h: firstOf.get(h).h }]));
    ok(!n2.log.slice(mark).some((x) => x.ac === 'list'), '分类表一天只拉一次');
    let guard = 0;
    while (cat3.stats().sites.some((s) => s.resuming) && guard++ < 10) { c2.t += MIN; await cat3.tick(); }
    ok(n2.log.filter((x) => x.host === 'b1.test' && x.ac === 'detail').length === 40, '单站单次最多翻 40 页');
    const m2 = n2.log.length;
    c2.t += MIN;
    const r3 = await cat3.tick();
    ok(r3.requests === 0 && n2.log.length === m2, '都爬完后不到期的站不请求', r3);
    const modes = Object.fromEntries(cat3.stats().sites.map((s) => [s.site, s.mode]));
    ok(modes.b1 === 'continuous' && modes.b4 === 'batch', '持续上新 / 每天一批 分档', modes);
    c2.t += 61 * MIN;
    const m3 = n2.log.length;
    await cat3.tick();
    const again = n2.log.slice(m3).filter((x) => x.ac === 'detail');
    ok(again.some((x) => x.host === 'b4.test' && x.ps === 20) && again.filter((x) => x.pg === 1).every((x) => x.h >= 2 && x.h <= 4), '一小时后批量站再爬:h = 距上次成功小时数 + 1、pagesize 用记下的 20', again.filter((x) => x.pg === 1).map((x) => [x.host, x.h, x.ps]));
    // 失败退避
    n2.hosts.get('b4.test').fail = true;
    c2.t += 2 * HOUR;
    await cat3.tick();
    const b4f = cat3.stats().sites.find((s) => s.site === 'b4');
    ok(b4f.fails === 1 && b4f.next_at >= c2.t + 5 * MIN && /timeout/.test(b4f.last_err), '请求失败 → 记失败、退避', b4f);
    // CATALOG_MAX_SITES
    const n3 = mkNet(mkClock(T0));
    ['m1', 'm2', 'm3', 'm4'].forEach((k) => n3.site(k));
    const cat4 = createCatalog({ db: new Database(':memory:'), getSites: () => n3.sitesCfg(), adult, httpGet: n3.httpGet, log: () => {}, env: { CATALOG_MAX_SITES: '2' }, now: () => T0, sleep: async () => {} });
    await cat4.tick();
    ok(new Set(n3.log.map((x) => x.host)).size === 2 && n3.log.every((x) => /^m[12]\./.test(x.host)), 'CATALOG_MAX_SITES=2 只爬前 2 个站', [...new Set(n3.log.map((x) => x.host))]);
    // CATALOG_DISABLE
    const n4 = mkNet(mkClock(T0));
    n4.site('z1');
    const off = createCatalog({ db: new Database(':memory:'), getSites: () => n4.sitesCfg(), adult, httpGet: n4.httpGet, log: () => {}, env: { CATALOG_DISABLE: '1', CATALOG_FIRST_DELAY_MS: '0' } });
    off.start();
    await new Promise((r) => setTimeout(r, 40));
    ok(n4.log.length === 0 && off.stats().started === false && off.stats().disabled === true, 'CATALOG_DISABLE=1 不启动爬虫');
    off.stop();
    const n5 = mkNet(mkClock(T0));
    n5.site('z2');
    const on = createCatalog({ db: new Database(':memory:'), getSites: () => n5.sitesCfg(), adult, httpGet: n5.httpGet, log: () => {}, env: { CATALOG_DISABLE: '0', CATALOG_FIRST_DELAY_MS: '0' }, sleep: async () => {} });
    on.start();
    for (let i = 0; i < 50 && n5.log.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    ok(on.stats().started === true && n5.log.length >= 1, "CATALOG_DISABLE=0 不算关(只认 1/true/yes/on);CATALOG_FIRST_DELAY_MS=0 立即开爬", n5.log.length);
    on.stop();
    // 出网连接数 > 48 → 这轮不爬
    const n8 = mkNet(mkClock(T0));
    n8.site('p1');
    let busy = 60;
    const paused = createCatalog({ db: new Database(':memory:'), getSites: () => n8.sitesCfg(), adult, httpGet: n8.httpGet, log: () => {}, now: () => T0, sleep: async () => {}, socketsBusy: () => busy });
    const pr = await paused.tick();
    ok(pr.skipped === 'sockets' && n8.log.length === 0, '出网连接 > 48 → 本轮暂停', pr);
    busy = 10;
    await paused.tick();
    ok(n8.log.length >= 2, '连接降下来 → 照常爬', n8.log.length);
    // 没有数据库 → 全部回空,不抛
    const nodb = createCatalog({ db: () => null, getSites: () => [], adult, httpGet: async () => ({}), log: () => {} });
    ok(nodb.home().rows.length === 0 && nodb.browse({}).total_results === 0 && (await nodb.work('c:X-001')) === null && nodb.buckets().length === 17 && nodb.classInfo('a', 1) === null, '没有数据库:全部回空');
    ok((await nodb.tick()).skipped === 'nodb', '没有数据库:爬虫跳过');
}

// =====================================================================
console.log('⑤ 扩线');
{
    const c5 = mkClock(T0);
    const n6 = mkNet(c5);
    n6.latency = 20;
    const db5 = new Database(':memory:');
    const S = [];
    for (let i = 0; i < 20; i++) S.push(n6.site('x' + String(i).padStart(2, '0')));
    S[18].codeTrust = false;
    S[19].noSearch = true;
    const CODES = ['SSIS-700', 'SSIS-701', 'SSIS-702'];
    CODES.forEach((c, j) => S[0].items.push(mk(c + ' 某合成标题', '日本有码', { t: T0 - HOUR - j * MIN, dur: 7200 })));
    S[0].items.push(mk('某国产合成长标题甲', '国产自拍', { t: T0 - HOUR, dur: 1200 }));
    for (let i = 1; i < 20; i++) {
        S[i].search = (wd) => {
            const out = [];
            const norm = wd.replace(/-/g, '').toUpperCase();
            CODES.forEach((code, j) => {
                if (norm !== code.replace('-', '')) return;
                if (i <= 9 && (i !== 5 || wd.indexOf('-') < 0)) out.push(mk(code + ' 某合成标题', '日本有码', { id: 5000 + i * 10 + j, t: T0 - 2 * HOUR, dur: 7201 }));
                if (i === 3) { out.push(mk(code + '1 合成模糊结果', '日本有码', { id: 6000 + j, dur: 3000 })); out.push(mk('SSIS 合成模糊合集', '日本有码', { id: 6100 + j })); }
            });
            if (wd === '某国产合成长标题甲' && i % 2 === 0) out.push(mk('某国产合成长标题甲', '国产自拍', { id: 7000 + i, t: T0 - 2 * HOUR, dur: 1201 }));
            if (wd === '某国产合成长标题甲' && i === 7) out.push(mk('某国产合成长标题乙', '国产自拍', { id: 7100, dur: 1201 }));
            return out;
        };
    }
    const cat5 = mkCat(db5, n6, c5);
    await cat5.tick();   // 拉分类表 + 种子作品
    ok(workRow(db5, 'c:SSIS-700') && workRow(db5, 'c:SSIS-700').n_sites === 1, '种子作品入库');
    n6.log.length = 0;
    n6.realDelay = 8;
    const [g1, g1b, g2, g3] = await Promise.all([
        cat5.work('c:SSIS-700', { expand: true }), cat5.work('c:SSIS-700', { expand: true }),
        cat5.work('c:SSIS-701', { expand: true }), cat5.work('c:SSIS-702', { expand: true }),
    ]);
    const wd = n6.log.filter((x) => x.wd != null);
    ok(n6.wdAllMax <= 12 && n6.wdAllMax >= 7, '全局同时 ≤12 个扩线请求(且确实有多个扩线并发)', n6.wdAllMax);
    ok([...n6.wdMax.values()].every((m) => m <= 6), '单次扩线同时 ≤6', [...n6.wdMax.entries()]);
    ok(wd.every((x) => /^SSIS-?70[012]$/.test(x.wd)), '番号作品只搜 [带横线, 不带横线],从不搜光厂牌', [...new Set(wd.map((x) => x.wd))]);
    ok(!wd.some((x) => /^x1[89]\./.test(x.host)), 'search:false / codeTrust:false 的站不搜番号');
    const w700 = wd.filter((x) => /^SSIS-?700$/.test(x.wd));
    ok(new Set(w700.map((x) => x.host + '|' + x.wd)).size === w700.length && cat5.stats().expand.coalesced >= 1, '同作品并发扩线合并成一次(没有重复请求)', w700.length);
    ok(w700.length === 26, '请求数:命中的站只搜带横线(8×1)、x05 带横线没中再搜不带横线(2)、没货的站两种都搜(8×2)', w700.length);
    ok(g1 && g1b && g1.sources.length === 10 && g1b.sources.length === 10 && new Set(g1.sources.map((s) => s.site_key)).size === 10, '扩线找到的线路写回、作品 10 条线路', g1 && g1.sources.map((s) => s.site_key));
    ok(g2 && g2.sources.length === 10 && g3 && g3.sources.length === 10, '另外两个作品也各 10 条');
    ok(db5.prepare("SELECT COUNT(*) n FROM adult_items WHERE name LIKE '%模糊%'").get().n === 0, '无关模糊结果不写进索引');
    ok(workRow(db5, 'c:SSIS-700').n_sites === 10, '索引里的作品线路数更新(后来的用户直接从索引拿)');
    // 缓存
    let m = n6.log.length;
    await cat5.work('c:SSIS-700', { expand: true });
    ok(n6.log.length === m, '马上再扩:正缓存(已有线路)/ 负缓存 → 零请求');
    c5.t += 23 * HOUR;
    await cat5.work('c:SSIS-700', { expand: true });
    ok(n6.log.length === m, '23 小时后:负缓存仍有效 → 零请求');
    c5.t += 2 * HOUR;
    await cat5.work('c:SSIS-700', { expand: true });
    const again = n6.log.slice(m).filter((x) => x.wd != null);
    ok(again.length === 16 && again.every((x) => /^x1[0-7]\./.test(x.host)), '25 小时后:只重搜负缓存过期的站', again.map((x) => x.host + ' ' + x.wd));
    // 无番号作品:搜精确净标题;出错的站不缓存
    S[17].fail = true;
    m = n6.log.length;
    const tw = db5.prepare("SELECT wk FROM adult_works WHERE name='某国产合成长标题甲'").get().wk;
    const gt = await cat5.work(tw, { expand: true });
    const twd = n6.log.slice(m).filter((x) => x.wd != null);
    ok(twd.length === 18 && twd.every((x) => x.wd === '某国产合成长标题甲') && !twd.some((x) => x.host === 'x19.test'), '无番号作品搜精确净标题(整站假番号的站也搜,search:false 不搜)', twd.length);
    ok(gt && gt.sources.length === 10, '无番号作品找到偶数站的线路', gt && gt.sources.map((s) => s.site_key));
    ok(!db5.prepare("SELECT 1 FROM adult_items WHERE name='某国产合成长标题乙'").get(), '标题键不同的不写');
    m = n6.log.length;
    S[17].fail = false;
    await cat5.work(tw, { expand: true });
    const retry = n6.log.slice(m).filter((x) => x.wd != null);
    ok(retry.length === 1 && retry[0].host === 'x17.test', '出错的站不缓存,下次只重试它', retry.map((x) => x.host));
    ok(cat5.stats().expand.globalPeak <= 12, 'stats 里的全局并发峰值 ≤12', cat5.stats().expand);
    // 扩线时没有分类表的站:现拉一次分类表再搜
    const n7 = mkNet(mkClock(T0));
    const y0 = n7.site('y0'), y1 = n7.site('y1');
    y0.items.push(mk('SSIS-800 某合成标题', '日本有码', { t: T0 - HOUR, dur: 7200 }));
    y1.search = (w) => (w === 'SSIS-800' ? [mk('SSIS-800 某合成标题', '日本有码', { id: 8001, dur: 7200 })] : []);
    let crawlOnlyY0 = true;
    const cat6 = createCatalog({ db: new Database(':memory:'), getSites: () => n7.sitesCfg().filter((s) => !crawlOnlyY0 || s.key === 'y0'), adult, httpGet: n7.httpGet, log: () => {}, now: () => T0, sleep: async () => {} });
    await cat6.tick();
    crawlOnlyY0 = false;
    const g8 = await cat6.work('c:SSIS-800', { expand: true });
    ok(g8 && g8.sources.length === 2 && n7.log.some((x) => x.host === 'y1.test' && x.ac === 'list'), '扩线遇到没分类表的站先拉 ac=list 再收', n7.log.map((x) => x.host + ' ' + x.ac + ' ' + (x.wd || '')));
}

console.log(`\nsite-catalog-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
