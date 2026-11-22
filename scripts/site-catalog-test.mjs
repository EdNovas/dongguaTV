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
//  ⑦ 第二阶段:外站计数可信检查(有序/KS 非均匀/复取在涨,每周一次)、ids= 复取(每批 20、每轮 ≤2、每小时 ≤10)、热门行(紧跟新上架;
//     本站 ≥12 部用本站否则外站,只收有活线路的作品)、站点表 strict/codeTrust 传进 checkItem、tags(featured)、浏览 tag 组合、
//     suggest(empty/blocked/code+exact/alias/text,零上游)、beacon(不同上报者 3 个/24h 判死、成功复活、换地址复活、时长/宽高补全)、
//     线路 _family/_dead/_res/_native/_same 与排序、_meta(分区名/标签/厂牌前缀/演员/兄弟/首见)、封面代理(改写、索引查地址、魔数、
//     内网拒、LRU、负缓存)、薄分区回填(6h 后、每周、只拉叶子、≤10 页、每轮 ≤12)
//  ⑧ 第三阶段(inline,AVDB 用 scripts/fixtures/catalog/avdb-stub.cjs):AVDB 可信度(白名单外命中 + 时长对得上 → 可信;占位番号时长对不上 → 不可信;
//     冲突 → 不可信)、pol=block 入库就拦 / 后来拦了复核删掉、AVDB 认片段、片长 / 封面兜底、发行日 → 新片速递行与 released 排序、演员 / 片商、
//     标签合并(AI 改写标题严格口径)、分面(析取、只 featured、review 进 more、时长 6 档、版本、片商、演员、排序可用性)、游标(快照换了也能接着翻)、
//     标签云 / 标签页 / 片商榜 / 演员页
//  ⑨ 第三阶段(worker):dbPath → 写线程入库 + 读线程快照 / 浏览;AVDB 住写线程;全量历史回填(每站游标、续跑重一页、同域名 ≥2.2s、
//     首轮增量后自动开始、CATALOG_BACKFILL=0 关)
//  ⑩ 20 万作品合成目录(scripts/fixtures/catalog/synth.cjs):浏览 / 分面 / 标签 / 联想 / 建快照全程主线程卡顿 < 50 ms
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import crypto from 'node:crypto';

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
            pg: Number(u.searchParams.get('pg')) || 0, ps: Number(u.searchParams.get('pagesize')) || 0, h: Number(u.searchParams.get('h')) || 0,
            ids: u.searchParams.get('ids'), t: u.searchParams.get('t') };
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
            if (rec.ids != null) {   // ac=detail&ids=a,b,c(外站计数复取):idsHook 可以改计数
                const want = rec.ids.split(',');
                const list = s.items.filter((it) => want.includes(String(it.vod_id))).map((it) => (s.idsHook ? s.idsHook(it) : it));
                return { code: 1, page: 1, pagecount: 1, total: list.length, list };
            }
            const ps = s.cap ? Math.min(s.cap, rec.ps || 20) : (rec.ps || 20);
            const pool = rec.t != null ? s.items.filter((it) => String(it.type_id) === rec.t) : s.items;   // &t=<分类>(薄分区回填)
            const win = (s.ignoreH || !rec.h ? pool : pool.filter((it) => it._t >= clock.t - rec.h * HOUR)).slice().sort((a, b) => b._t - a._t);
            const pg = rec.pg || 1;
            return { code: 1, page: pg, pagecount: Math.max(1, Math.ceil(win.length / ps)), limit: String(ps), total: win.length, list: win.slice((pg - 1) * ps, pg * ps) };
        } finally {
            rec.end = clock.t;
            net.all--;
            net.inflight.set(host, net.inflight.get(host) - 1);
            if (wkey) { net.wdIn.set(wkey, net.wdIn.get(wkey) - 1); net.wdAll--; }
        }
    };
    net.sitesCfg = () => [...net.hosts.values()].map((s) => ({ key: s.key, name: s.key.toUpperCase() + '站', api: s.api, search: !s.noSearch, active: s.active !== false, codeTrust: s.codeTrust !== false, family: s.family,
        nativeHls: s.nativeHls, strict: s.strict, extHot: s.extHot, upstream: s.upstream, aiTitles: s.aiTitles }));
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
// 第三阶段:原始字段挪进了压缩旁表 adult_items_raw —— 测试照旧拿到 r.raw(JSON 字符串)
const zlib = require('zlib');
const withRaw = (r) => { if (r && r.rawz) { r.raw = zlib.inflateRawSync(r.rawz).toString('utf8'); delete r.rawz; } return r; };
const itemsBy = (db, where, ...a) => db.prepare('SELECT *, (SELECT x.raw FROM adult_items_raw x WHERE x.id = adult_items.id) AS rawz FROM adult_items WHERE ' + where).all(...a).map(withRaw);
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
    // 第三阶段 6 档:s <10 分 / m 10-30 / l 30-60 / xl 1-2 小时 / xxl ≥2 小时 / unk 未知
    const lg = cat.browse({ dur: 'xxl' });
    ok(lg.results.length > 0 && lg.results.every((c) => c.dur >= 7200), '时长 ≥2 小时筛选');
    const mid = cat.browse({ dur: 'l' });
    ok(mid.results.length > 0 && mid.results.every((c) => c.dur >= 1800 && c.dur < 3600), '时长 30-60 分钟筛选', mid.results.map((c) => c.dur));
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
    // 规则版本变了:新实例启动 → 代数 +1、旧代的行读不到;重扫逐块按新规则重跑(跑完一块亮一块,入库照常);删掉不合格的行、合格的不动
    const before = new Map(itemsBy(db, '1').map((r) => [r.site + '|' + r.vod_id, r.wk]));
    const good = itemsBy(db, "site='sb' AND name='某国产合成标题0号'")[0];
    const raw = JSON.parse(good.raw);
    raw.n = '某合成标题 偷拍 版';
    const ins = db.prepare(`INSERT INTO adult_items (site, vod_id, wk, bucket, tags, review, code_ok, name, clean, code, ckey, tkey, pic, dur, vod_time, first_seen, last_seen,
        type_id, type_name, play_from, play_url, play_at, variant, flags, family, src)
        SELECT site, 'fake-1', 't:fakebad', bucket, tags, review, code_ok, '某合成标题 偷拍 版', clean, code, ckey, 'fakebad', pic, dur, vod_time, first_seen, last_seen,
        type_id, type_name, play_from, play_url, play_at, variant, flags, family, src FROM adult_items WHERE site=? AND vod_id=?`).run(good.site, good.vod_id);
    db.prepare('INSERT INTO adult_items_raw (id, raw) VALUES (?, ?)').run(ins.lastInsertRowid, zlib.deflateRawSync(Buffer.from(JSON.stringify(raw))));
    db.prepare(`INSERT INTO adult_works (wk, name, bucket, tags, review, code_ok, pic, dur_med, n_sites, sites, live_sites, first_site, first_seen, last_seen, rand, vis)
        VALUES ('t:fakebad', '某合成标题 偷拍 版', 'cn_amateur', '', NULL, 0, '', 0, 1, ',sb,', ',sb,', 'sb', ?, ?, 1, 1)`).run(clock.t, clock.t);   // 旧规则下"可见"
    // 作品名是冻结的:冻结它的那条线路后来没了,名字里还留着新规则要拦的词(催情)→ 线路都合格也不进快照(闸门按作品名本来就会丢)
    const frozen = db.prepare("SELECT wk, name FROM adult_works WHERE vis=1 AND wk LIKE 't:%' ORDER BY id LIMIT 1 OFFSET 3").get();
    db.prepare('UPDATE adult_works SET name=? WHERE wk=?').run(frozen.name + ' 催情版', frozen.wk);
    // 模拟部署了新规则:库里记的(全库已重跑完的 'rules' 与当前代代表的 'rv:rules')都是旧规则
    db.prepare("UPDATE adult_meta SET v='p0-old' WHERE k IN ('rules', 'rv:rules')").run();
    // 站点配置还没加载(空列表)→ 不重扫、不删任何行;旧代的行读不到
    const nItems = itemsBy(db, '1').length;
    const cat0 = createCatalog({ db, getSites: () => [], adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep });
    ok(cat0.home().rows.length === 0, '站点列表空 + 规则版本不一致 → 旧代的行读不到(首页空)');
    await cat0.flush();
    ok(itemsBy(db, '1').length === nItems && cat0.stats().rescanPending === true && db.prepare("SELECT v FROM adult_meta WHERE k='rules'").get().v === 'p0-old', '…重扫推迟,一行都不删');
    const genOf = () => Number((db.prepare("SELECT v FROM adult_meta WHERE k='rv:gen'").get() || {}).v) || 0;
    const gen1 = genOf();
    ok(gen1 >= 1 && itemsBy(db, '1').every((r) => r.rv < gen1), '规则变了:代数 +1,库里的行都是旧代', gen1);
    // 重扫一块只跑 2 部作品(A 段按最新上架倒序):跑完一块那一块就可读,没跑到的读不到 —— 不再整库回空十几分钟
    const cat2 = mkCat(db, net, clock, { referenced: () => keepRefs, opts: { rescanWorks: 2, rescanChunk: 3 } });
    const h0 = cat2.home();
    ok(h0.rows.length === 0 && cat2.browse({}).total_results === 0 && cat2.lookup('SSIS-600').length === 0 && cat2.stats().rescanPending === true,
        '重扫还没跑到:首页 / 浏览 / 查找读不到旧代的行(没按新规则复查过的不露)', h0.rows.length);
    ok(genOf() === gen1, '同一套新规则重启:不再加代(接着上次的重扫)');
    await new Promise((r) => setImmediate(r));   // 让写端跑一块(块与块之间让出事件循环)
    const verified = (wk) => { const w = db.prepare('SELECT rv FROM adult_works WHERE wk=?').get(wk); return !!w && w.rv >= gen1; };
    const visN = (cond) => db.prepare('SELECT COUNT(*) n FROM adult_works WHERE vis=1 AND ' + cond).get(gen1).n;
    const vDone = visN('rv >= ?'), vLeft = visN('rv < ?');
    ok(vDone > 0 && vLeft > 0 && cat2.stats().rescanPending === true, '重扫进行中:已有作品重跑完、还有没跑到的', [vDone, vLeft]);
    ok(!workRow(db, 't:fakebad'), '最新上架的先跑:A 段第一块就把不合格的那条删了');
    cat2.rebuild();
    const bMid = cat2.browse({});
    ok(bMid.total_results > 0 && bMid.total_results <= vDone && bMid.results.every((c) => verified(c.wk)) && !bMid.results.some((c) => c.wk === 't:fakebad'),
        '重扫进行中:浏览只出已按新规则重跑过的作品(首页 / 浏览亮起来)', [bMid.total_results, vDone]);
    const unv = db.prepare('SELECT wk FROM adult_works WHERE vis=1 AND rv < ? LIMIT 1').get(gen1);
    ok(unv && (await cat2.work(unv.wk)) === null && cat2.picUrl(unv.wk, '') === null, '重扫进行中:还没跑到的作品,作品页 / 封面地址都读不到', unv);
    const ver = bMid.results[0];
    ok(ver && !!(await cat2.work(ver.wk)), '重扫进行中:跑完的作品作品页照常', ver && ver.wk);
    // 重扫期间搜索回写照常入库(新入库的就是新一代,马上可读;原来整段丢掉)
    cat2.ingestSearchItems('sa', [mk('某合成重扫期间条目', '国产自拍', { dur: 900 })]);
    await cat2.flush();
    const dur = itemsBy(db, "name='某合成重扫期间条目'")[0];
    ok(dur && dur.rv === gen1 && !('rescan' in (cat2.stats().rejected || {})), '重扫期间的搜索回写照常入库(rv = 新一代)', dur && dur.rv);
    ok(cat2.stats().rescan && cat2.stats().rescan.running === false && cat2.stats().rescan.checked > 0, 'stats().rescan:进度 / 结果', cat2.stats().rescan);
    ok(cat2.stats().rescanPending === false && String(db.prepare("SELECT v FROM adult_meta WHERE k='rules'").get().v).startsWith(adult.RULES_VERSION + '|'), '重扫完成、记下新规则版本(policy 指纹 + writer 入库修订)');
    ok(!itemsBy(db, "vod_id='fake-1'").length && !workRow(db, 't:fakebad'), '重扫删掉不合格的行和它的作品');
    ok(itemsBy(db, '1').every((r) => r.rv === gen1) && db.prepare('SELECT COUNT(*) n FROM adult_works WHERE vis=1 AND rv < ?').get(gen1).n === 0, '重扫完:全部行 / 可见作品都是新一代');
    const fz = workRow(db, frozen.wk);
    ok(fz && fz.vis === 0 && fz.rv === gen1 && itemsBy(db, 'wk=?', frozen.wk).length > 0 && !cat2.browse({ facets: 1 }).results.some((c) => c.wk === frozen.wk),
        '冻结的作品名过不了新规则(催情)→ vis=0、不进快照(线路照留)', fz && { vis: fz.vis, name: fz.name });
    const after = new Map(itemsBy(db, "name<>'某合成重扫期间条目'").map((r) => [r.site + '|' + r.vod_id, r.wk]));
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
    // 第三阶段全量历史:很久没再见到的线路照样留着,作品永远保留;线路按健康过期(判死超过 30 天才删)
    keepRefs = ['SSIS-600 某合成标题', 'c:SSIS-601'];
    const nW = db.prepare('SELECT COUNT(*) n FROM adult_works').get().n, nI = itemsBy(db, '1').length;
    const sdN = itemsBy(db, "site='sd'").length;
    db.prepare("UPDATE adult_items SET dead=1, dead_at=? WHERE site='sd'").run(clock.t - 31 * DAY);
    db.prepare("UPDATE adult_items SET dead=1, dead_at=? WHERE site='sa' AND wk='c:SSIS-601'").run(clock.t - 10 * DAY);
    const n = cat.retention();
    const left = itemsBy(db, '1');
    ok(n === sdN && left.length === nI - sdN && !left.some((r) => r.site === 'sd') && left.some((r) => r.site === 'sa' && r.wk === 'c:SSIS-601'), '判死 >30 天的线路删掉;没判死 / 判死不到 30 天的照留(不按"多久没见到"删)', [n, sdN, nI, left.length]);
    ok(db.prepare('SELECT COUNT(*) n FROM adult_works').get().n === nW && db.prepare("SELECT COUNT(*) n FROM adult_works WHERE n_sites=0 AND vis=0").get().n > 0, '作品永远保留(线路没了 → n_sites=0、vis=0)');
    // 站点表里删掉的站:连续 7 天不在才删它的线路;站点表拉不到(空)什么都不动
    const scN = itemsBy(db, "site='sc'").length;
    const catGone = createCatalog({ db, getSites: () => net.sitesCfg().filter((s) => s.key !== 'sc'), adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep });
    const catEmpty = createCatalog({ db, getSites: () => [], adult, httpGet: net.httpGet, log: () => {}, now: clock.now, sleep: clock.sleep });
    ok(catGone.retention() === 0 && itemsBy(db, "site='sc'").length === scN && scN > 0, '站点刚从站点表消失:先记下,不删');
    clock.t += 8 * DAY;
    ok(catEmpty.retention() === 0 && itemsBy(db, "site='sc'").length === scN, '站点表空(没拉到):不删');
    ok(catGone.retention() === scN && itemsBy(db, "site='sc'").length === 0, '站点消失满 7 天:删它的线路', itemsBy(db, "site='sc'").length);
    keepRefs = { [Symbol.iterator]() { throw new Error('boom'); } };
    const before2 = itemsBy(db, '1').length;
    ok(cat.retention() === 0 && itemsBy(db, '1').length === before2, 'referenced() 出错 → 这轮一条都不删');
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
    ok(r1.more === true, '爬虫自己把这一轮额度用完(还有站没爬完)→ lastTick.more:下一轮 tickBusyMs 后就来', r1);
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
    ok(r3.requests === 0 && n2.log.length === m2 && r3.more === false, '都爬完后不到期的站不请求(lastTick.more = false:回到 tickMs)', r3);
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

// =====================================================================
console.log('⑦ 第二阶段:可信检查 / 站点标志 / 热门行 / 标签 / 联想 / 上报 / 线路字段 / 封面代理 / 薄分区回填');
{
    const IMG = require(path.join(ROOT, 'lib/site-catalog/img.js'));
    // ---- 外站计数可信检查(纯函数) ----
    {
        const real = [], unif = [], disorder = [], stat = [];
        let seed = 7;
        const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let i = 0; i < 60; i++) {
            const tot = Math.round(200000 / (i + 1)) + 50, mon = Math.round(tot * 0.6), wk = Math.round(mon * 0.5), day = Math.round(wk * 0.3);
            real.push({ day, week: wk, month: mon, total: tot, at: T0, prev_total: tot - 120, prev_at: T0 - 5 * MIN });
            const u = Math.floor(rnd() * 1000);
            unif.push({ day: Math.floor(rnd() * 1000), week: Math.floor(rnd() * 1000), month: Math.floor(rnd() * 1000), total: u, at: T0, prev_total: u, prev_at: T0 - 5 * MIN });
            disorder.push({ day: wk + 5, week: wk, month: mon, total: tot, at: T0, prev_total: tot - 1, prev_at: T0 - 5 * MIN });
            stat.push({ day, week: wk, month: mon, total: tot, at: T0, prev_total: tot, prev_at: T0 - 5 * MIN });
        }
        const r1 = U.hitsTrust(real), r2 = U.hitsTrust(unif), r3 = U.hitsTrust(disorder), r4 = U.hitsTrust(stat);
        ok(r1.decided && r1.ok && r1.ordered === 1 && r1.ks > r1.crit, '可信检查:有序 + 长尾 + 复取在涨 → 可信', r1);
        ok(r2.decided && !r2.ok && /uniform/.test(r2.reason) && /order/.test(r2.reason), '可信检查:均匀随机的假计数 → 不可信', r2);
        ok(r3.decided && !r3.ok && r3.reason === 'order', '可信检查:日 > 周(<95% 有序)→ 不可信', r3);
        ok(r4.decided && !r4.ok && r4.reason === 'static', '可信检查:隔 ≥2 分钟复取不涨 → 不可信', r4);
        ok(!U.hitsTrust(real.slice(0, 10)).decided && U.hitsTrust(real.map((r) => Object.assign({}, r, { prev_at: null }))).reason === 'no-refetch'
            && U.hitsTrust(real.map((r) => Object.assign({}, r, { prev_at: T0 - MIN }))).reason === 'no-refetch', '数据不够 / 没复取过 / 复取间隔 <2 分钟 → 不判(decided:false)');
        ok(U.ksUniform([1, 2, 3]).n === 3 && U.ksUniform([]).n === 0 && U.ksUniform([0, 0, 0]).D === 0, 'ksUniform 边界');
    }

    // ---- 主场景:6 个站(两个同家族、一个 nativeHls:false、一个 strict、一个 codeTrust:false、一个外站计数站) ----
    const c7 = mkClock(T0);
    const n7 = mkNet(c7);
    n7.latency = 20;
    const db7 = new Database(':memory:');
    const PA = n7.site('pa', { family: 'fam1' }), PB = n7.site('pb', { family: 'fam2', nativeHls: false }), PC = n7.site('pc', { family: 'fam1' });
    const PD = n7.site('pd', { strict: true }), PE = n7.site('pe', { codeTrust: false }), HX = n7.site('hx', { family: 'fam3', extHot: true });
    const hitsOf = (i) => { const tot = Math.round(400000 / (i + 1)) + 100, mon = Math.round(tot * 0.6), wk = Math.round(mon * 0.5); return { vod_hits: tot, vod_hits_month: mon, vod_hits_week: wk, vod_hits_day: Math.round(wk * 0.3) }; };
    const samePath = (h) => '正片$https://cdn-' + h + '.example/v/20261121/abcdef1234/index.m3u8';
    PA.items.push(mk('SSIS-900 某合成标题', '日本有码', { t: T0 - HOUR, dur: 7200, extra: { vod_play_url: samePath('a') } }));
    PB.items.push(mk('SSIS-900 某合成标题', '日本有码', { t: T0 - HOUR - MIN, dur: 7202, extra: { vod_play_url: samePath('b') } }));
    PC.items.push(mk('SSIS-900 某合成标题-架空ユメ', '日本有码', { t: T0 - HOUR - 2 * MIN, dur: 7201, extra: { vod_actor: 'テスト花子' } }));
    HX.items.push(mk('SSIS-900 某合成标题', '日本有码', { t: T0 - HOUR - 3 * MIN, dur: 7200, extra: hitsOf(45) }));
    PA.items.push(mk('[无码流出] SSIS-900 某合成标题', '日本无码', { t: T0 - HOUR - 4 * MIN, dur: 7200 }));
    PB.items.push(mk('水果派解说 SSIS-900', 'AV解说', { t: T0 - HOUR - 5 * MIN, dur: 600 }));
    PA.items.push(mk('SSIS-903 某合成乙', '日本有码', { t: T0 - 2 * HOUR, dur: 7200 }));
    PC.items.push(mk('SSIS-903 某合成乙', '日本有码', { t: T0 - 2 * HOUR - MIN, dur: 5000 }));      // 时长对不上 → 第二部正片(~2)
    PA.items.push(mk('有码2024-09-28SSIS-902架空太郎', '日本有码', { t: T0 - 3 * HOUR, dur: 7000 })); // 结构化尾巴的纯汉字名 → 不当演员
    PB.items.push(mk('某国产合成自拍片', '国产自拍', { t: T0 - 3 * HOUR - MIN, dur: 900, extra: { vod_actor: '某网名' } }));   // 国产自拍 → 不给演员
    PA.items.push(mk('SSIS-906 某合成丙', '日本有码', { t: T0 - 4 * HOUR, dur: 7200 }));
    PB.items.push(mk('SSIS-906 某合成丙', '日本有码', { t: T0 - 4 * HOUR - MIN }));               // 时长未知 → 等上报补
    PA.items.push(mk('SSIS-907 某合成丁', '日本有码', { t: T0 - 4 * HOUR - 2 * MIN, dur: 7200 }));
    PB.items.push(mk('SSIS-907 某合成丁', '日本有码', { t: T0 - 4 * HOUR - 3 * MIN }));
    for (let i = 0; i < 3; i++) PA.items.push(mk(`SSIS-92${i} 某合成剧情${i}`, '强奸乱伦', { t: T0 - 5 * HOUR - i * MIN, dur: 7100 + i }));   // 标签 incest/noncon(审查级)
    for (let i = 0; i < 5; i++) PC.items.push(mk(`SSIS-93${i} 某合成人妻${i}`, '人妻熟女', { t: T0 - 6 * HOUR - i * MIN, dur: 7000 + i * 100 }));
    for (let i = 0; i < 3; i++) PB.items.push(mk(`某合成人妻无番号${i}`, '人妻熟女', { t: T0 - 6 * HOUR - 10 * MIN - i * MIN, dur: 1200 + i }));
    for (let i = 0; i < 3; i++) PD.items.push(mk(`某严格站合成作品${i}`, '国产自拍', { t: T0 - 7 * HOUR - i * MIN, dur: 800 + i }));
    PD.items.push(mk('SSIS-904 某合成严格站标题', '爱播资源', { t: T0 - 7 * HOUR - 5 * MIN, dur: 7200, extra: { vod_class: '国产传媒' } }));   // 严格站:国产分类挂日本番号 → 政策不信
    PE.items.push(mk('SSIS-910 某合成标题', '日本有码', { t: T0 - 7 * HOUR, dur: 7200 }));
    PA.items.push(mk('某合成欧美长标题-架空マリ', '欧美', { t: T0 - 7 * HOUR - 30 * MIN, dur: 1500 }));   // 片名解析出的名字只在日本片分区用 → 欧美不给
    for (let i = 0; i < 40; i++) HX.items.push(mk(`某合成热门作品${i}`, '国产自拍', { t: T0 - 8 * HOUR - i * MIN, dur: 1000 + i * 30, extra: hitsOf(i) }));
    HX.grow = false;
    HX.idsHook = (it) => { if (HX.grow) for (const k of ['vod_hits', 'vod_hits_day', 'vod_hits_week', 'vod_hits_month']) it[k] += 100; return it; };

    const calls = [];
    const spyAdult = Object.assign({}, adult, {
        policy: Object.assign({}, adult.policy, { checkItem: (it, ctx) => { calls.push({ n: it && it.vod_name, ctx: Object.assign({}, ctx || {}) }); return adult.policy.checkItem(it, ctx); } }),
    });
    let popTitles = [];
    const cat7 = createCatalog({ db: db7, getSites: () => n7.sitesCfg(), adult: spyAdult, httpGet: n7.httpGet, log: () => {}, env: {}, now: c7.now, sleep: c7.sleep, popularTitles: () => (typeof popTitles === 'function' ? popTitles() : popTitles) });
    await cat7.tick();
    const dead = (site, wk) => !!db7.prepare('SELECT dead FROM adult_items WHERE site=? AND wk=?').get(site, wk || 'c:SSIS-900').dead;
    {
        // 站点标志传进 policy.checkItem(只看线路入库那一次;作品名复查 workNameOk 只带分区,和闸门 nameOk 同口径)
        const lineCalls = calls.filter((c) => 'siteTrust' in c.ctx);
        ok(calls.some((c) => !('siteTrust' in c.ctx) && c.ctx.cls && typeof c.ctx.cls.bucket === 'string'), '作品名也按闸门口径(带分区)过一遍片名政策');
        const pd = lineCalls.filter((c) => /严格站/.test(c.n)), pe = lineCalls.filter((c) => c.n === 'SSIS-910 某合成标题'), oth = lineCalls.filter((c) => /热门作品/.test(c.n));
        ok(pd.length >= 3 && pd.every((c) => c.ctx.strict === true && c.ctx.siteTrust === true), 'strict:true 的站:checkItem 收到 ctx.strict=true', pd.map((c) => c.ctx.strict));
        ok(pe.length >= 1 && pe.every((c) => c.ctx.siteTrust === false && c.ctx.strict === false && c.ctx.codeOk === false), 'codeTrust:false 的站:ctx.siteTrust=false、codeOk=false', pe.map((c) => [c.ctx.siteTrust, c.ctx.codeOk]));
        ok(oth.length >= 40 && oth.every((c) => c.ctx.strict === false && c.ctx.siteTrust === true), '其他站 ctx.strict=false、siteTrust=true');
        ok(db7.prepare("SELECT wk FROM adult_items WHERE site='pe'").get().wk.startsWith('t:'), 'codeTrust:false 的站番号不进 c: 键');
        const sx = db7.prepare("SELECT wk, code_ok, bucket FROM adult_items WHERE site='pd' AND name LIKE 'SSIS-904%'").get();
        ok(sx && sx.wk.startsWith('t:') && sx.code_ok === 0 && sx.bucket === 'cn_studio' && !db7.prepare("SELECT 1 FROM adult_works WHERE wk='c:SSIS-904'").get(),
            'strict 站:政策回的 codeOk 更严(国产分类挂日本番号)→ 以它为准:不进 c: 键、code_ok=0', sx);
    }
    {
        // 外站计数:爬虫顺手记下;第一轮还没复取过 → 可信检查判不了 → 没有热门行
        ok(db7.prepare("SELECT COUNT(*) n FROM adult_hits WHERE site='hx'").get().n === 41 && !n7.log.some((x) => x.ids != null), '外站计数站的条目爬取时记下计数(41 条),刚取过的不复取');
        ok(db7.prepare("SELECT COUNT(*) n FROM adult_hits WHERE site<>'hx'").get().n === 0, '别的站的 vod_hits 一律不记');
        ok(!cat7.home().rows.some((r) => r.id === 'hot'), '没复取过 → 可信检查判不了 → 没有热门行');
        // 61 分钟后:每轮最多 2 个 ids= 请求、每批 20 个
        HX.grow = true;
        c7.t += 61 * MIN;
        const m = n7.log.length;
        await cat7.tick();
        const idr = n7.log.slice(m).filter((x) => x.ids != null);
        ok(idr.length === 2 && idr.every((x) => x.host === 'hx.test' && x.ac === 'detail' && x.ids.split(',').length === 20), '复取:ac=detail&ids= 每批 20 个、每轮 ≤2 个请求', idr.map((x) => x.ids.split(',').length));
        ok(pacingOk(n7.log, 2000).length === 0 && n7.maxHost === 1, '复取也守同域名串行 / 间隔');
        cat7.rebuild();
        const rows = cat7.home().rows;
        const hot = rows.find((r) => r.id === 'hot');
        ok(rows[0].id === 'new' && rows[1] && rows[1].id === 'hot', '热门行紧跟在新上架后面', rows.map((r) => r.id));
        ok(hot && hot.source === 'ext' && hot.title === '外站热门' && hot.more === null && hot.items.length >= 12 && hot.items.length <= 24, '没有本站数据 → 外站热门(source ext,more:null)', hot && { s: hot.source, n: hot.items.length });
        ok(hot && hot.items[0].name === '某合成热门作品0' && hot.items.every((c) => c.wk && c.name && 'pic' in c && 'sub' in c && 'badge' in c && 'bucket' in c && 'code' in c && 'dur' in c && 'n_sites' in c && 'first_seen' in c), '按 hits_week 排序、卡片字段不变', hot && hot.items.slice(0, 3).map((c) => c.name));
        const tr = cat7.stats().extTrust;
        ok(tr && tr.decided && tr.ok && tr.site === 'hx' && tr.pairs >= 10, '可信检查结果记在库里', tr);
        // 只收至少有一条没判死线路的作品
        const w0 = hot.items[0].wk;
        const v0 = db7.prepare('SELECT vod_id FROM adult_items WHERE wk=?').get(w0).vod_id;
        for (const who of ['x1', 'x2', 'x3']) cat7.beacon({ wk: w0, site_key: 'hx', vod_id: v0, ok: false }, who);
        cat7.rebuild();
        const hot2 = cat7.home().rows.find((r) => r.id === 'hot');
        ok(hot2 && !hot2.items.some((c) => c.wk === w0), '线路全判死的作品不进热门行');
        // 本站热门:够 12 部 → 用本站;不够 → 退回外站
        const names = db7.prepare("SELECT name FROM adult_works WHERE name LIKE '某合成人妻%' OR name LIKE 'SSIS-9%' ORDER BY name").all().map((r) => r.name);
        popTitles = ['不存在的片名', ...names];
        cat7.rebuild();
        let h3 = cat7.home().rows.find((r) => r.id === 'hot');
        ok(names.length >= 13 && h3 && h3.source === 'local' && h3.title === '本站热门' && h3.items.length >= 12 && h3.items[0].name === names[0], '本站热门 ≥12 部 → 用本站(按榜单顺序,对不上的片名跳过)', h3 && { s: h3.source, n: h3.items.length, first: h3.items[0].name });
        popTitles = names.slice(0, 5);
        cat7.rebuild();
        h3 = cat7.home().rows.find((r) => r.id === 'hot');
        ok(h3 && h3.source === 'ext', '本站不足 12 部 → 外站热门');
        popTitles = () => { throw new Error('x'); };
        cat7.rebuild();
        ok(cat7.home().rows.find((r) => r.id === 'hot').source === 'ext', 'popularTitles 出错 → 当没有');
        popTitles = [];
        // 每小时 ≤10 个计数请求(独立实例:复取间隔设 0、每轮额度放开)
        const c9 = mkClock(T0), n9 = mkNet(c9), H9 = n9.site('hy', { extHot: true });
        n9.latency = 20;
        for (let i = 0; i < 30; i++) H9.items.push(mk(`某合成计数作品${i}`, '国产自拍', { t: T0 - HOUR - i * MIN, dur: 900 + i, extra: hitsOf(i) }));
        const cat9 = createCatalog({ db: new Database(':memory:'), getSites: () => n9.sitesCfg(), adult, httpGet: n9.httpGet, log: () => {}, now: c9.now, sleep: c9.sleep, opts: { hitsPerTick: 50, hitsRefreshMs: 0 } });
        await cat9.tick();
        const ids1 = n9.log.filter((x) => x.ids != null).length;
        c9.t += 10 * MIN;
        await cat9.tick();
        const ids2 = n9.log.filter((x) => x.ids != null).length;
        c9.t += 55 * MIN;
        await cat9.tick();
        const ids3 = n9.log.filter((x) => x.ids != null).length;
        ok(ids1 === 10 && ids2 === 10 && ids3 > 10 && ids3 <= 20, '外站计数请求每小时 ≤10 个(额度用完这一小时不再要)', [ids1, ids2, ids3]);
        // 外站计数不可信(复取不涨)→ 没有外站热门行
        const c10 = mkClock(T0), n10 = mkNet(c10), H10 = n10.site('hz', { extHot: true });
        n10.latency = 20;
        for (let i = 0; i < 40; i++) H10.items.push(mk(`某合成静止作品${i}`, '国产自拍', { t: T0 - HOUR - i * MIN, dur: 900 + i, extra: hitsOf(i) }));
        const cat10 = createCatalog({ db: new Database(':memory:'), getSites: () => n10.sitesCfg(), adult, httpGet: n10.httpGet, log: () => {}, now: c10.now, sleep: c10.sleep, opts: { hitsPerTick: 3 } });
        await cat10.tick();
        c10.t += 61 * MIN;
        await cat10.tick();
        cat10.rebuild();
        const t10 = cat10.stats().extTrust;
        ok(t10 && t10.decided && !t10.ok && t10.reason === 'static' && !cat10.home().rows.some((r) => r.id === 'hot'), '可信检查不过(计数不涨)→ 没有外站热门行', t10);
        // 每周一次:判过的结论 7 天内不重判;过期后按当时的数据重判
        db7.prepare("UPDATE adult_hits SET day = week + 1 WHERE site='hx'").run();
        cat7.rebuild();
        ok(cat7.home().rows.some((r) => r.id === 'hot' && r.source === 'ext'), '可信结论 7 天内沿用');
        c7.t += 8 * DAY;
        db7.prepare("UPDATE adult_hits SET at=?, prev_at=? WHERE site='hx'").run(c7.t, c7.t - 5 * MIN);
        cat7.rebuild();
        const tr2 = cat7.stats().extTrust;
        ok(tr2 && tr2.decided && !tr2.ok && tr2.reason === 'order' && !cat7.home().rows.some((r) => r.id === 'hot'), '超过 7 天重判:日 > 周 → 不可信 → 没有外站热门行', tr2);
        c7.t -= 8 * DAY;
        db7.prepare("DELETE FROM adult_meta WHERE k='exthot:trust'").run();
        cat7.rebuild();
    }
    {
        // 标签(第三阶段词表 lib/adult/tags:featured 才进标签云;审查级只能筛选;旧 &tag= 经 LEGACY 映射)
        const tg = cat7.tags('');
        ok(Array.isArray(tg.groups) && tg.groups.length > 0 && tg.tags.length > 0 && tg.tags.every((t, i) => typeof t.id === 'string' && t.label && t.count > 0 && t.featured === true
            && typeof t.group === 'string' && tg.groups.some((g) => g.id === t.group) && (i === 0 || t.count <= tg.tags[i - 1].count)), 'tags():{groups, tags:[{id,label,count,featured:true,group}]},按数量降序', tg);
        const byId = Object.fromEntries(tg.tags.map((t) => [t.id, t]));
        ok(!byId.incest && !byId.noncon && !tg.tags.some((t) => adult.tags.isReview(t.id)), '审查级标签(乱伦/强制凌辱)不进标签云', tg.tags.map((t) => t.id));
        ok(byId.wife && byId.wife.count === 8 && byId.wife.label === '人妻' && byId.wife.group === 'persona', '普通标签计数对(人妻 8 = 5 番号 + 3 无番号)', byId.wife);
        const tj = cat7.tags('jp_censored').tags;
        ok(tj.length > 0 && tj.find((t) => t.id === 'wife').count === 5, '按分区计数(日本有码里的人妻 = 5)', tj);
        ok(cat7.tags('nope').tags.length === 0 && cat7.tags('!bad').tags.length === 0, '未知分区 → 空');
        // 浏览 t= / 旧 &tag= 与 b/sort/dur/v/page 组合
        const has = (c, id) => String(workRow(db7, c.wk).tags).includes(',' + id + ',');
        const b1 = cat7.browse({ tag: 'milf' });
        ok(b1.total_results === 8 && b1.results.every((c) => has(c, 'wife')) && cat7.browse({ t: 'wife' }).total_results === 8, '浏览 t=wife;旧 tag=milf 经 LEGACY 映射成 wife', b1.results.map((c) => c.name));
        const b2 = cat7.browse({ t: 'wife', b: 'jp_censored', sort: 'dur', page: 1 });
        ok(b2.total_results === 5 && b2.results.every((c, i) => has(c, 'wife') && c.bucket === 'jp_censored' && (i === 0 || c.dur <= b2.results[i - 1].dur)), '标签 + 分区 + 时长排序', b2.results.map((c) => [c.name, c.dur]));
        ok(cat7.browse({ t: 'wife', b: 'jp_censored', dur: 'xxl' }).total_results === 3 && cat7.browse({ t: 'wife', b: 'jp_censored', dur: 'xl' }).total_results === 2, '标签 + 时长档(≥2 小时 3 部 / 1-2 小时 2 部)');
        ok(cat7.browse({ t: 'wife', dur: 's' }).total_results === 0 && cat7.browse({ t: 'wife', v: 'zh' }).total_results === 0 && cat7.browse({ t: 'wife', page: 2 }).results.length === 0, '标签 + 其他筛选 / 翻过头 → 空');
        ok(cat7.browse({ t: 'incest', b: 'jp_censored' }).total_results === 3 && cat7.browse({ tag: 'incest' }).total_results === 3, '审查级标签只在浏览筛选里可用');
        ok(cat7.browse({ t: 'x_minor' }).total_results === 0 && cat7.browse({ t: 'x_school' }).total_results === 0 && cat7.browse({ t: 'nope' }).total_results === 0
            && cat7.browse({ t: 'wife', x: 'x_voyeur' }).total_results === 0 && cat7.browse({ t: 'a,b,c,d' }).total_results === 0, 'blocked / 未知 / 超过 3 个标签 → 空结果');
        const jpAll = cat7.browse({ b: 'jp_censored' }).total_results;
        const ex = cat7.browse({ b: 'jp_censored', x: 'wife' });
        ok(ex.total_results === jpAll - 5 && ex.results.every((c) => !has(c, 'wife')), '排除标签 x=', [jpAll, ex.total_results]);
        ok(!['', 'jp_censored'].some((b) => cat7.tags(b).tags.some((t) => t.id === 'studio')), '「厂牌」伪标签不在标签云里(片商走 studio 分面)');
        // 厂牌前缀 lp(作品页「SSIS」按钮)
        const bl = cat7.browse({ lp: 'ssis' });
        ok(bl.total_results > 0 && bl.results.every((c) => /^c:SSIS-/.test(c.wk)), '浏览 lp=SSIS:只出 SSIS 番号作品', bl.results.map((c) => c.wk));
        const blm = cat7.browse({ lp: 'SSIS', tag: 'milf' });
        ok(blm.total_results === 5 && blm.results.every((c) => /^c:SSIS-/.test(c.wk) && has(c, 'wife')), 'lp + tag 组合(旧 tag=milf → wife)', blm.results.map((c) => c.wk));
        ok(cat7.browse({ lp: 'SS%' }).total_results === 0 && cat7.browse({ lp: '!bad' }).total_results === 0 && cat7.browse({ lp: 'ZZZZ' }).total_results === 0, 'lp 非法 / 没有这个厂牌 → 空');
    }
    {
        // 联想(零上游)
        const m = n7.log.length;
        const sg = (x) => cat7.suggest(x);
        ok(sg('').kind === 'empty' && sg('   ').kind === 'empty' && sg(null).kind === 'empty', '空查询 → empty');
        const sb = sg('迷奸');
        ok(sb.kind === 'blocked' && sb.items.length === 0 && sb.exact === null && sb.alias === null, '被拦的查询 → blocked、items 空', sb);
        const s1 = sg('ssis900');
        ok(s1.kind === 'code' && s1.exact === 'c:SSIS-900' && s1.items[0].wk === 'c:SSIS-900' && s1.items.some((c) => c.wk === 'c:SSIS-900#U') && s1.items.some((c) => c.wk === 'c:SSIS-900#clip'),
            '番号:恰好一部正片 → exact(#U / #clip 兄弟不算),正片排第一', s1);
        const s2 = sg('SSIS-903');
        ok(s2.kind === 'code' && s2.exact === null && s2.items.length === 2 && s2.items.some((c) => c.wk === 'c:SSIS-903~2') && s2.items.some((c) => c.wk === 'c:SSIS-903'),
            '番号:本体 + 时长拆出的 ~2 是两部正片 → exact 为 null(让用户选;第二阶段的小 bug)', s2);
        ok(sg('SSIS-999').kind === 'code' && sg('SSIS-999').items.length === 0 && sg('SSIS-999').exact === null, '番号:本地没有 → 空');
        const sa = sg('无码'), sm = sg('人妻'), sl = sg('乱伦');
        ok(sa.kind === 'alias' && sa.alias.b === 'jp_uncensored' && sa.alias.label === '日本无码' && !('tag' in sa.alias), '别名:无码 → 分区 jp_uncensored', sa.alias);
        ok(sm.kind === 'alias' && sm.alias.tag === 'wife' && sm.alias.label === '人妻' && sm.items.length > 0, '别名:人妻 → 标签 wife(同时给片名匹配)', sm);
        ok(sl.kind === 'text' && sl.alias === null, '审查级标签不做别名(乱伦 → 普通文字)', sl);
        ok(sg('日本无码').alias.b === 'jp_uncensored' && sg('中字').alias.b === 'jp_subbed' && sg('探花').alias.b === 'cn_hookup' && sg('里番').alias.b === 'anime' && sg('欧美').alias.b === 'western', '分区名 / 常用词别名');
        const t3 = sg('合成热门');
        ok(t3.kind === 'text' && t3.items.length === 8 && t3.items.every((c) => c.name.includes('合成热门')), '文字 ≥3 字:FTS trigram,最多 8 张', t3.items.length);
        const t2 = sg('热门');
        ok(t2.kind === 'text' && t2.items.length === 8 && t2.items.every((c) => c.name.includes('热门')), '文字 2 字:bigram 旁路索引(不再全表 LIKE)', t2.items.length);
        cat7.tags('');
        ok(n7.log.length === m, '联想 / 标签零上游请求');
    }
    {
        // 播放上报
        const m = n7.log.length;
        const L = (site, wk) => db7.prepare('SELECT vod_id FROM adult_items WHERE site=? AND wk=?').get(site, wk || 'c:SSIS-900').vod_id;
        const bk = (site, okv, who, extra, wk) => cat7.beacon(Object.assign({ wk: wk || 'c:SSIS-900', site_key: site, vod_id: L(site, wk), ok: okv }, extra || {}), who);
        ok(cat7.beacon({}, 'w1').ok === false && cat7.beacon({ site_key: 'pa', vod_id: L('pa'), ok: 'yes' }, 'w1').reason === 'invalid' && cat7.beacon({ site_key: 'pa', vod_id: L('pa'), ok: false }, '').reason === 'anonymous',
            '上报:字段不对 → 忽略;匿名(认不出上报者)的失败 → 不计');
        for (let i = 0; i < 4; i++) cat7.beacon({ site_key: 'pa', vod_id: L('pa'), ok: false }, '');
        ok(!dead('pa') && db7.prepare('SELECT COUNT(*) n FROM adult_line_fail WHERE site=?').get('pa').n === 0, '匿名失败报多少次都不判死、不进失败表');
        const ra = cat7.beacon({ site_key: 'pa', vod_id: L('pa'), ok: true }, '');
        ok(ra.ok === true && ra.dead === false, '匿名的成功照收(补时长/分辨率/复活)', ra);
        ok(cat7.beacon({ site_key: 'pa', vod_id: 'nope', ok: false }, 'w1').reason === 'unknown', '上报:不认识的线路 → 忽略');
        bk('pa', false, 'w1'); bk('pa', false, 'w1'); bk('pa', false, 'w1');
        ok(!dead('pa'), '同一个上报者报 3 次不算');
        bk('pa', false, 'w2');
        ok(!dead('pa'), '2 个不同上报者 → 还不算');
        const r3 = bk('pa', false, 'w3');
        ok(r3.ok && r3.dead === true && dead('pa'), '24h 内 3 个不同上报者失败 → 判死');
        let g = await cat7.work('c:SSIS-900');
        ok(g.sources[g.sources.length - 1].site_key === 'pa' && g.sources.find((s) => s.site_key === 'pa')._dead === true && g.sources.filter((s) => s._dead).length === 1, '判死的线路 _dead:true、排最后', g.sources.map((s) => s.site_key + (s._dead ? '†' : '')));
        bk('pa', true, 'w4');
        ok(!dead('pa'), '之后任何一次成功 → 复活');
        bk('pa', false, 'w1'); bk('pa', false, 'w2');
        ok(!dead('pa'), '复活之前的失败不再算');
        bk('pa', false, 'w3');
        ok(dead('pa'), '复活后再有 3 个不同上报者失败 → 再判死');
        bk('pa', true, 'w9');
        // 资源站换了播放地址 → 复活;只是签名参数变了不算
        for (const w of ['y1', 'y2', 'y3']) bk('pc', false, w);
        ok(dead('pc'), 'pc 判死');
        const pcIt = PC.items.find((x) => x.vod_name === 'SSIS-900 某合成标题-架空ユメ');
        cat7.ingestSearchItems('pc', [Object.assign({}, pcIt, { vod_play_url: '正片$https://media.example/new-path/index.m3u8?sign=1' })]);
        await cat7.flush();
        ok(!dead('pc'), '资源站换了播放地址 → 判死清掉');
        for (const w of ['y5', 'y6', 'y7']) bk('pc', false, w);
        cat7.ingestSearchItems('pc', [Object.assign({}, pcIt, { vod_play_url: '正片$https://media.example/new-path/index.m3u8?sign=3' })]);
        await cat7.flush();
        ok(dead('pc'), '只是签名参数变了 → 不算换地址');
        bk('pc', true, 'y4');
        // 时长补全:不知道的才补,和作品对得上才收;作品中位数重算
        bk('pb', true, 'w5', { dur: 7203 }, 'c:SSIS-906');
        const i906 = db7.prepare("SELECT dur FROM adult_items WHERE site='pb' AND wk='c:SSIS-906'").get();
        ok(i906.dur === 7203 && workRow(db7, 'c:SSIS-906').dur_med === 7202, '成功上报带时长 → 补上未知时长、重算作品中位数', [i906.dur, workRow(db7, 'c:SSIS-906').dur_med]);
        bk('pb', true, 'w5', { dur: 3000 }, 'c:SSIS-907');
        ok(db7.prepare("SELECT dur FROM adult_items WHERE site='pb' AND wk='c:SSIS-907'").get().dur === 0, '上报时长和作品对不上 → 不收');
        bk('pa', true, 'w5', { dur: 100 });
        ok(db7.prepare("SELECT dur FROM adult_items WHERE site='pa' AND wk='c:SSIS-900'").get().dur === 7200, '已知时长不被上报改写');
        bk('pb', true, 'w5', { w: 1920, h: 1080 });
        bk('pc', true, 'w5', { w: 'x', h: 99999 });
        g = await cat7.work('c:SSIS-900');
        ok(g.sources.find((s) => s.site_key === 'pb')._res === '1920x1080' && g.sources.find((s) => s.site_key === 'pc')._res === '', '成功上报带宽高 → _res;乱填的不收');
        // 24h 窗口
        bk('pb', false, 'z1'); bk('pb', false, 'z2');
        c7.t += 25 * HOUR;
        bk('pb', false, 'z3');
        ok(!dead('pb'), '超过 24h 的失败不算');
        c7.t -= 25 * HOUR;
        ok(n7.log.length === m, '上报零上游请求');
        const st = cat7.stats().beacon;
        ok(st.dead >= 3 && st.revived >= 2 && st.dur === 1 && st.res >= 1, '上报计数', st);
    }
    {
        // 线路字段 / 排序 / _meta
        const g = await cat7.work('c:SSIS-900');
        const by = Object.fromEntries(g.sources.map((s) => [s.site_key, s]));
        ok(by.pa._family === 'fam1' && by.pc._family === 'fam1' && by.pb._family === 'fam2' && by.hx._family === 'fam3', '_family = 站点表 family', g.sources.map((s) => [s.site_key, s._family]));
        ok(by.pb._native === 'risky' && by.pa._native === 'ok' && by.hx._native === 'ok', "_native:nativeHls:false → 'risky'");
        ok(by.pa._same && by.pa._same === by.pb._same && by.pc._same === '' && by.hx._same === '', '_same:不同家族、第一集路径(去掉域名)相同 → 同一组', g.sources.map((s) => [s.site_key, s._same]));
        ok(g.sources.every((s) => typeof s._dead === 'boolean' && typeof s._res === 'string' && typeof s._family === 'string' && typeof s._same === 'string'), '线路字段类型');
        const keys = g.sources.map((s) => s.site_key);
        ok(Math.abs(keys.indexOf('pc') - keys.indexOf('pa')) === 1, '同家族挨着(pa, pc 都是 fam1,中间不夹别家)', keys);
        PC.upstream = 'up1'; HX.upstream = 'up1';
        const gu = await cat7.work('c:SSIS-900');
        const bu = Object.fromEntries(gu.sources.map((s) => [s.site_key, s]));
        ok(bu.pc._same && bu.pc._same === bu.hx._same && bu.pc._same !== bu.pa._same, '_same:站点表 upstream 相同的站同一组', gu.sources.map((s) => [s.site_key, s._same]));
        delete PC.upstream; delete HX.upstream;
        // 判死的线路:活的先,同家族也不跨过死活分界
        const paId = db7.prepare("SELECT vod_id FROM adult_items WHERE site='pa' AND wk='c:SSIS-900'").get().vod_id;
        for (const w of ['d1', 'd2', 'd3']) cat7.beacon({ wk: 'c:SSIS-900', site_key: 'pa', vod_id: paId, ok: false }, w);
        const gd = await cat7.work('c:SSIS-900');
        const dk = gd.sources.map((s) => s.site_key);
        ok(dk.length === 4 && dk[3] === 'pa' && gd.sources[3]._dead === true && gd.sources.slice(0, 3).every((s) => !s._dead), '活的在前、死的在后(同家族也不跨过死活分界)', gd.sources.map((s) => s.site_key + (s._dead ? '†' : '')));
        cat7.beacon({ wk: 'c:SSIS-900', site_key: 'pa', vod_id: paId, ok: true }, 'd4');
        const M = g._meta;
        ok(M.code === 'SSIS-900' && M.bucket === 'jp_censored' && M.bucket_label === '日本有码' && M.label_prefix === 'SSIS' && M.n_sites === 4 && M.first_seen > 0 && M.dur >= 7200, '_meta 基本字段', M);
        ok(Array.isArray(M.tags) && M.tags.every((t) => typeof t.id === 'string' && typeof t.label === 'string' && typeof t.featured === 'boolean'), '_meta.tags = [{id,label,featured}]', M.tags);
        ok(JSON.stringify(M.siblings.map((s) => s.kind).sort()) === '["U","clip"]' && M.siblings.every((s) => s.wk && s.name), "_meta.siblings kind 'U' / 'clip'", M.siblings);
        const gU = await cat7.work('c:SSIS-900#U');
        ok(gU && gU._meta.siblings.some((s) => s.wk === 'c:SSIS-900' && s.kind === 'main'), "#U 作品的兄弟里正片 kind 'main'", gU && gU._meta.siblings);
        const g903 = await cat7.work('c:SSIS-903');
        ok(g903 && g903._meta.siblings.length === 1 && g903._meta.siblings[0].kind === 'main', "~2 第二部正片也是 'main'", g903 && g903._meta.siblings);
        ok(M.actress.some((a) => a.name === 'テスト花子' && a.aid === null) && M.actress.some((a) => a.name === '架空ユメ'), '演员:vod_actor + title.js 有把握的解析(第三阶段 [{aid,name}],对不上 AVDB 的 aid=null)', M.actress);
        const g902 = await cat7.work('c:SSIS-902');
        ok(g902 && g902._meta.actress.length === 0, '演员:纯汉字的解析结果不要', g902 && g902._meta.actress);
        const wwe = db7.prepare("SELECT wk, bucket FROM adult_works WHERE name LIKE '某合成欧美长标题%'").get();
        const gwe = wwe && await cat7.work(wwe.wk);
        ok(gwe && gwe._meta.bucket === 'western' && gwe._meta.actress.length === 0, '演员:片名解析出的名字只在日本片分区用(欧美不给)', gwe && gwe._meta);
        const wcn = db7.prepare("SELECT wk FROM adult_works WHERE name='某国产合成自拍片'").get().wk;
        const gcn = await cat7.work(wcn);
        ok(gcn && gcn._meta.bucket === 'cn_amateur' && gcn._meta.actress.length === 0 && gcn._meta.label_prefix === '' && gcn._meta.siblings.length === 0, '国产自拍:不给演员(哪怕有 vod_actor)、没有厂牌前缀', gcn && gcn._meta);
    }
    {
        // 封面代理:开着时卡片 / 线路封面改写;地址只从索引查
        const catImg = createCatalog({ db: db7, getSites: () => n7.sitesCfg(), adult, httpGet: n7.httpGet, log: () => {}, env: { ADULT_IMG_PROXY: '1' }, now: c7.now, sleep: c7.sleep });
        const cards = catImg.home().rows.flatMap((r) => r.items);
        ok(cards.length > 0 && cards.every((c) => /^\/api\/img\?k=[^&]+&s=[a-z0-9]+$/.test(c.pic)), 'ADULT_IMG_PROXY=1:卡片封面 → /api/img?k=&s=', cards.slice(0, 3).map((c) => c.pic));
        const gi = await catImg.work('c:SSIS-900');
        ok(gi.sources.every((s) => s.vod_pic === '/api/img?k=' + encodeURIComponent('c:SSIS-900') + '&s=' + s.site_key) && /^\/api\/img\?k=/.test(gi.pic), '线路封面 → /api/img?k=&s=<站>', gi.sources.map((s) => s.vod_pic));
        ok(catImg.stats().imgProxy === true && cat7.stats().imgProxy === false, 'stats.imgProxy');
        ok(cat7.home().rows.flatMap((r) => r.items).every((c) => !c.pic || /^https:\/\/img\.example\//.test(c.pic)), '默认关:卡片封面是直链');
        const pa = db7.prepare("SELECT pic FROM adult_items WHERE site='pa' AND wk='c:SSIS-900'").get().pic;
        ok(catImg.picUrl('c:SSIS-900', 'pa') === pa && /^https:\/\/img\.example\//.test(pa), 'picUrl:按 (作品, 站) 从索引查地址');
        const meta = catImg.picUrl('c:SSIS-900', '', { meta: true });
        ok(meta && /^https:\/\/img\.example\//.test(meta.url) && meta.name === 'SSIS-900 某合成标题' && meta.bucket === 'jp_censored', 'picUrl 不给站 → 用作品封面那一条;meta:true 带片名 / 分区', meta);
        ok(catImg.picUrl('c:SSIS-900', 'zz') === null && catImg.picUrl('c:NOPE-001', 'pa') === null && catImg.picUrl('', 'pa') === null && catImg.picUrl('c:SSIS-900', 'pd') === null, 'picUrl:没有 / 不相干的站 → null');
        db7.prepare("UPDATE adult_works SET review='hide' WHERE wk='c:SSIS-906'").run();
        ok(catImg.picUrl('c:SSIS-906', 'pa') === null, 'picUrl:审查过滤藏起来的作品 → null');
        db7.prepare("UPDATE adult_works SET review=NULL WHERE wk='c:SSIS-906'").run();
    }
    {
        // 封面代理模块:魔数 / 内网地址 / 地址检查 / 缓存 / LRU / 负缓存
        const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
        const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]);
        const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(40)]);
        ok(IMG.sniff(JPG).type === 'image/jpeg' && IMG.sniff(PNG).ext === 'png' && IMG.sniff(WEBP).ext === 'webp' && IMG.sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) === null
            && IMG.sniff(Buffer.from('<html>hello world</html>')) === null && IMG.sniff(Buffer.alloc(3)) === null, '魔数认图片(SVG / HTML 不认)');
        const priv = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'garbage'];
        const pub = ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'];
        ok(priv.every(IMG.isPrivateAddr) && !pub.some(IMG.isPrivateAddr), '内网 / 回环 / 链路本地 / 组播地址判定', [priv.filter((x) => !IMG.isPrivateAddr(x)), pub.filter(IMG.isPrivateAddr)]);
        const thr = (u) => { try { IMG.checkUrl(u); return false; } catch (e) { return true; } };
        ok(['http://127.0.0.1/x.jpg', 'http://[::1]/x.jpg', 'file:///etc/passwd', 'http://localhost/x.jpg', 'http://a.localhost/x', 'http://user:pw@img.example/x.jpg', 'ftp://img.example/x.jpg', 'http://10.0.0.8:8080/x.jpg', 'javascript:alert(1)'].every(thr)
            && !thr('https://img.example/a.jpg') && !thr('http://img.example:8080/a.jpg'), 'checkUrl:非 http(s) / 内网字面量 / localhost / 带账号 一律拒');
        await new Promise((r) => IMG.safeLookup('localhost', {}, (err) => { ok(err && /private/.test(err.message), 'safeLookup:域名解析到内网地址 → 拒', err && err.message); r(); }));
        const tmpImg = fs.mkdtempSync(path.join(os.tmpdir(), 'adult-img-'));
        const fetched = [];
        const big = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, n % 7)]);
        const map = { 'c:A|pa': 'https://img.example/a.jpg', 'c:B|pa': 'https://img.example/b.bin', 'c:C|pa': 'https://img.example/c.html', 'c:D|pa': 'http://10.0.0.1/d.jpg', 'c:E|pa': 'https://img.example/e.jpg' };
        for (let i = 1; i <= 4; i++) map['c:L' + i + '|pa'] = 'https://img.example/l' + i + '.jpg';
        let tnow = T0;
        const px = IMG.createImgProxy({
            dir: tmpImg, capMb: 1, now: () => tnow, resolve: (k, s) => map[k + '|' + s] || null,
            fetchImage: async (u) => {
                fetched.push(u);
                if (/a\.jpg$/.test(u)) return JPG;
                if (/b\.bin$/.test(u)) return PNG;
                if (/c\.html$/.test(u)) return Buffer.from('<html><body>not an image at all</body></html>');
                if (/e\.jpg$/.test(u)) return big(6 * 1024 * 1024);
                if (/l\d\.jpg$/.test(u)) return big(400 * 1024);
                throw new Error('boom');
            },
        });
        const mockRes = () => { const r = { code: 200, h: {}, body: null, sent: false }; r.set = (k, v) => { r.h[k.toLowerCase()] = v; return r; }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; r.sent = true; return r; }; r.end = (b) => { r.body = b; r.sent = true; return r; }; Object.defineProperty(r, 'headersSent', { get: () => r.sent }); return r; };
        const call = async (query) => { const res = mockRes(); await px.handle({ query }, res); return res; };
        let r = await call({ k: 'c:A', s: 'pa', url: 'http://169.254.169.254/latest/meta-data' });
        ok(r.code === 200 && r.h['content-type'] === 'image/jpeg' && Buffer.isBuffer(r.body) && /private/.test(r.h['cache-control']) && r.h['x-content-type-options'] === 'nosniff' && fetched.join() === 'https://img.example/a.jpg',
            '代理:地址从索引查(请求里的 url= 不看),回图片', [r.code, r.h, fetched]);
        r = await call({ k: 'c:A', s: 'pa' });
        ok(r.code === 200 && fetched.length === 1 && px.stats().hits === 1, '第二次:磁盘缓存命中,不再出网');
        ok(fs.readdirSync(tmpImg).some((f) => /^[0-9a-f]{40}\.jpg$/.test(f)), '缓存文件名 = sha256(地址) 前 40 位 + 扩展名');
        r = await call({ k: 'c:B', s: 'pa' });
        ok(r.code === 200 && r.h['content-type'] === 'image/png', '上游 octet-stream:按魔数改成 image/png');
        r = await call({ k: 'c:C', s: 'pa' });
        const n1 = fetched.length;
        const r2 = await call({ k: 'c:C', s: 'pa' });
        ok(r.code === 502 && r2.code === 502 && fetched.length === n1, '不是图片 → 502,1 小时内不再试');
        r = await call({ k: 'c:D', s: 'pa' });
        ok(r.code === 502 && !fetched.some((u) => /10\.0\.0\.1/.test(u)) && px.stats().refused >= 1, '索引里的地址是内网 → 拒,一次都不连');
        r = await call({ k: 'c:E', s: 'pa' });
        ok(r.code === 502, '超过 5MB → 拒');
        ok((await call({ k: 'c:NOPE', s: 'pa' })).code === 404 && (await call({ k: 'x', s: 'pa' })).code === 400 && (await call({ k: 'c:A', s: '../x' })).code === 400 && (await call({ url: 'https://img.example/a.jpg' })).code === 400,
            '不认识的作品 404;参数不合法 400;只给 url= → 400');
        for (let i = 1; i <= 4; i++) { tnow += 1000; await call({ k: 'c:L' + i, s: 'pa' }); }
        const st = px.stats();
        ok(st.bytes <= 1024 * 1024 && st.evicted >= 2 && fs.readdirSync(tmpImg).filter((f) => !/\.tmp$/.test(f)).length === st.files, 'LRU:总量超过上限 → 删最久没用的,删到 90% 以下', st);
        const keep = crypto.createHash('sha256').update('https://img.example/l4.jpg').digest('hex').slice(0, 40) + '.jpg';
        ok(fs.existsSync(path.join(tmpImg, keep)), 'LRU:最新的那张还在');
        fs.rmSync(tmpImg, { recursive: true, force: true });
    }
}
{
    // 薄分区回填:首爬 6h 后才开始、每周一次、只拉叶子分类(&t=<叶子>&pagesize=60,每叶子 ≤10 页)、每轮 ≤12 个、守爬虫节奏
    const leafId = tidOf('欧美精品', '欧美'), parentId = tidOf('欧美');
    const c8 = mkClock(T0), n8b = mkNet(c8);
    n8b.latency = 20;
    const db8 = new Database(':memory:');
    const B1 = n8b.site('bf1');
    for (let i = 0; i < 20; i++) B1.items.push(mk('某合成国产回填' + i, '国产自拍', { t: T0 - i * 10 * MIN - MIN, dur: 600 + i }));
    for (let i = 0; i < 700; i++) B1.items.push(mk('某合成欧美旧片 ' + i, '欧美精品', { parent: '欧美', t: T0 - 100 * DAY - i * HOUR, dur: 1500 + i }));
    const cat8 = createCatalog({ db: db8, getSites: () => n8b.sitesCfg(), adult, httpGet: n8b.httpGet, log: () => {}, now: c8.now, sleep: c8.sleep });
    await cat8.tick();
    ok(!n8b.log.some((x) => x.t != null), '首次爬取 6h 内不回填');
    const western = () => db8.prepare("SELECT COUNT(*) n FROM adult_works WHERE bucket='western'").get().n;
    ok(western() === 0, '增量爬虫(h=72)拿不到旧片');
    c8.t += 7 * HOUR;
    let m0 = n8b.log.length;
    const r = await cat8.tick();
    const first = n8b.log.slice(m0).filter((x) => x.t != null);
    ok(first.length > 0 && first.length <= 12 && r.requests <= 120 && r.backfill === first.length, '回填每轮 ≤12 个请求(用爬虫预算)', [first.length, r.requests, r.backfill]);
    for (let g = 0; g < 200; g++) {
        const st = cat8.stats().backfillState;
        if (!st || !st.queued) break;
        c8.t += 5 * MIN;
        await cat8.tick();
    }
    const all = n8b.log.filter((x) => x.t != null);
    const cmap = adult.taxonomy.buildClassMap(classes, { host: B1.api });
    ok(all.every((x) => { const row = cmap.get(Number(x.t)); return row && !row.container && !row.block; }) && !all.some((x) => Number(x.t) === parentId), '只拉叶子分类,绝不拉父分类 / 硬拦分类',
        all.filter((x) => { const row = cmap.get(Number(x.t)); return !row || row.container || row.block; }).map((x) => x.t));
    ok(all.every((x) => x.ps === 60 && x.pg >= 1 && x.pg <= 10 && x.ac === 'detail' && !x.h), '&t=<叶子>&pagesize=60,页码 1~10,不带 h');
    const leafPages = all.filter((x) => Number(x.t) === leafId).map((x) => x.pg);
    ok(leafPages.length === 10 && Math.max(...leafPages) === 10, '每个叶子最多翻 10 页(这个叶子有 12 页)', leafPages);
    ok(western() === 600, '回填的旧片入库(10 页 × 60)', western());
    ok(pacingOk(n8b.log, 2000).length === 0 && n8b.maxHost === 1, '回填也守同域名串行 / 间隔');
    const bst = cat8.stats().backfillState;
    ok(bst && bst.thin.includes('western'), '最近 30 天作品 <60 的分区算薄', bst);
    m0 = n8b.log.length;
    c8.t += DAY;
    await cat8.tick();
    ok(!n8b.log.slice(m0).some((x) => x.t != null), '一周内不再回填');
    c8.t += 7 * DAY;
    await cat8.tick();
    ok(n8b.log.slice(m0).some((x) => x.t != null), '一周后再回填一轮');
}

// =====================================================================
console.log('⑦b 审查级 code 只认白名单番号(和闸门 checkRaw 同一条规则;AVDB 证实只管分组)');
{
    const AVS = require(path.join(ROOT, 'scripts/fixtures/catalog/avdb-stub.cjs'));
    const cR = mkClock(T0), nR = mkNet(cR);
    const dbR = new Database(':memory:');
    dbR.exec('CREATE TABLE IF NOT EXISTS avdb_stub (key TEXT PRIMARY KEY, j TEXT NOT NULL)');
    const avS = (key, a) => dbR.prepare('INSERT OR REPLACE INTO avdb_stub (key, j) VALUES (?, ?)').run(key, JSON.stringify(a));
    const RA = nR.site('ra');
    avS('QWER-124', { pol: 'review_code', runtime: 7200 });   // 不在白名单:AVDB 时长对得上也只是"证实"
    avS('SSIS-760', { pol: 'review_code', runtime: 7200 });   // 白名单番号
    avS('QWER-125', { runtime: 7200 });                       // 不在白名单、无审查级:照常按 AVDB 证实上架
    RA.items.push(mk('QWER-124 某合成审查甲', '日本有码', { t: T0 - HOUR, dur: 7200 }));
    RA.items.push(mk('SSIS-760 某合成审查乙', '日本有码', { t: T0 - HOUR - MIN, dur: 7200 }));
    RA.items.push(mk('QWER-125 某合成普通', '日本有码', { t: T0 - HOUR - 2 * MIN, dur: 7200 }));
    const catR = createCatalog({ db: dbR, getSites: () => nR.sitesCfg(), adult, httpGet: nR.httpGet, log: () => {}, now: cR.now, sleep: cR.sleep,
        avdbFactory: (db) => AVS.createAvdb({ db }) });
    await catR.tick();
    const nm = (n) => itemsBy(dbR, "name=?", n)[0];
    ok(!nm('QWER-124 某合成审查甲') && catR.stats().rejected.review >= 1, 'AVDB review_code + 番号只被 AVDB 证实(不在白名单)→ 不入库(闸门同样不放,免得卡片点开 404)', catR.stats().rejected);
    ok(nm('SSIS-760 某合成审查乙') && nm('SSIS-760 某合成审查乙').review === 'code', 'AVDB review_code + 白名单番号 → 入库(review=code)');
    const q125 = nm('QWER-125 某合成普通');
    ok(q125 && q125.code_ok === 1 && q125.code_src === 'avdb' && q125.wk === 'c:QWER-125', '没有审查级的线路:AVDB 证实照常用于分组(c: 键)', q125);
    await catR.close();
}

console.log('⑧ 第三阶段(inline):AVDB 可信度 / 拦截 / 片段 / 片长 / 封面 / 发行日 / 演员 / 标签合并 / 分面 / 排序 / 游标 / 标签页 / 片商 / 新片速递');
const AVSTUB = require(path.join(ROOT, 'scripts/fixtures/catalog/avdb-stub.cjs'));
{
    const c9 = mkClock(T0), n9 = mkNet(c9);
    n9.latency = 20;
    const db9 = new Database(':memory:');
    db9.exec('CREATE TABLE IF NOT EXISTS avdb_stub (key TEXT PRIMARY KEY, j TEXT NOT NULL)');
    const avSet = (key, a) => db9.prepare('INSERT OR REPLACE INTO avdb_stub (key, j) VALUES (?, ?)').run(key, JSON.stringify(a));
    const QA = n9.site('qa', { family: 'fq' }), QB = n9.site('qb'), QAI = n9.site('qai', { aiTitles: true });
    const recent = (d) => new Date(T0 - d * DAY + 8 * HOUR).toISOString().slice(0, 10);
    avSet('SSIS-700', { pol: 'block', runtime: 7200 });
    avSet('QWER-123', { runtime: 7200, released: recent(11), actors: [{ aid: 501, name: 'Kakuu Hanako' }], tags: [{ id: 'busty', src: 'avdb' }], maker: '合成片商A', label: 'QWER Label', poster: 'https://poster.example/qwer123.jpg' });
    avSet('JUL-123', { runtime: 7155 });
    avSet('SSIS-702', { runtime: 7200 });
    avSet('SSIS-703', { runtime: 7200 });
    avSet('SSIS-704', { runtime: 7300, poster: 'https://poster.example/704.jpg' });
    avSet('SSIS-705', { runtime: 7000, poster: 'https://poster.example/705.jpg' });
    for (let i = 0; i < 13; i++) avSet(`SSIS-${710 + i}`, { runtime: 7100 + i, released: recent(2 + i * 3) });
    avSet('SSIS-731', { runtime: 7000, released: '2020-01-01' });
    QA.items.push(mk('SSIS-700 某合成被拦', '日本有码', { t: T0 - HOUR, dur: 7200 }));
    QA.items.push(mk('QWER-123 某合成新人', '日本有码', { t: T0 - HOUR - MIN, dur: 7210 }));
    QA.items.push(mk('JUL-123 某合成甲', '日本有码', { t: T0 - 2 * HOUR, dur: 3600 }));
    QB.items.push(mk('JUL-123 某合成乙', '日本有码', { t: T0 - 2 * HOUR - MIN, dur: 7160 }));
    QA.items.push(mk('SSIS-702 某合成丙', '日本有码', { t: T0 - 3 * HOUR, dur: 900 }));
    QB.items.push(mk('SSIS-702 某合成丙', '日本有码', { t: T0 - 3 * HOUR - MIN, dur: 7200 }));
    QA.items.push(mk('SSIS-703 某合成丁', '日本有码', { t: T0 - 4 * HOUR, dur: 4000 }));
    QA.items.push(mk('SSIS-704 某合成戊', '日本有码', { t: T0 - 4 * HOUR - MIN }));
    QA.items.push(Object.assign(mk('SSIS-705 某合成己', '日本有码', { t: T0 - 4 * HOUR - 2 * MIN, dur: 7000 }), { vod_pic: '' }));
    for (let i = 0; i < 13; i++) (i % 2 ? QA : QB).items.push(mk(`SSIS-${710 + i} 某合成新片${i}`, '日本有码', { t: T0 - 5 * HOUR - i * MIN, dur: 7100 + i }));
    QA.items.push(mk('SSIS-731 某合成旧片', '日本有码', { t: T0 - 5 * HOUR - 30 * MIN, dur: 7000 }));
    // AI 改写标题站:只有它的片名给的标签要别的线路 / AVDB 证实
    QAI.items.push(mk('SSIS-740 某合成 巨乳 黑丝', '日本有码', { t: T0 - 6 * HOUR, dur: 7200 }));
    QA.items.push(mk('SSIS-740 某合成巨乳', '日本有码', { t: T0 - 6 * HOUR - MIN, dur: 7200 }));
    QAI.items.push(mk('SSIS-741 某合成 黑丝', '日本有码', { t: T0 - 6 * HOUR - 2 * MIN, dur: 7200 }));
    for (let i = 0; i < 30; i++) (i % 2 ? QA : QB).items.push(mk(`SSIS-${800 + i} 某合成填充${i}`, '日本有码', { t: T0 - 7 * HOUR - i * MIN, dur: i % 3 ? 7000 + i : 0, extra: i % 5 ? {} : { vod_name: `[中文字幕] SSIS-${800 + i} 某合成填充${i}` } }));
    QB.items.push(mk('SSIS-750 某合成后来被拦', '日本有码', { t: T0 - 8 * HOUR, dur: 7200 }));
    for (let i = 0; i < 2; i++) QB.items.push(mk(`某合成国产作品${i}`, '国产自拍', { t: T0 - 9 * HOUR - i * MIN, dur: 600 + i }));
    let pop = [];
    const cat9 = createCatalog({ db: db9, getSites: () => n9.sitesCfg(), adult, httpGet: n9.httpGet, log: () => {}, now: c9.now, sleep: c9.sleep,
        avdbFactory: (db) => AVSTUB.createAvdb({ db }), popularTitles: () => pop });
    await cat9.tick();
    const wr = (wk) => workRow(db9, wk);
    const ir = (where, ...a) => itemsBy(db9, where, ...a);
    // —— 番号可信度 / 拦截 ——
    ok(!ir("name LIKE 'SSIS-700%'").length && cat9.stats().rejected['avdb-block'] === 1, 'AVDB pol=block:入库就拦(一行都不写)', cat9.stats().rejected);
    ok(cat9.avdbPol('SSIS-700') === 'block' && cat9.avdbPol('QWER-123') === null && cat9.avdbPol('NOPE-1') === null, 'avdbPol(闸门搜索出口用)');
    ok(cat9.suggest('SSIS-700').kind === 'blocked' && cat9.lookup('SSIS-700').length === 0, 'AVDB 拦截的番号:联想 blocked、本地查找空');
    const q123 = ir("name='QWER-123 某合成新人'")[0];
    ok(q123 && q123.wk === 'c:QWER-123' && q123.code_ok === 1 && q123.code_src === 'avdb' && !adult.title.codeOk(adult.title.parseTitle(q123.name, '日本有码'), {}),
        '不在白名单的番号:AVDB 命中 + 时长 3%+60s 内对得上 → 可信(code_src=avdb)', q123);
    const jA = ir("name='JUL-123 某合成甲'")[0], jB = ir("name='JUL-123 某合成乙'")[0];
    ok(jA && jA.wk.startsWith('t:') && jA.code_ok === 0 && jB && jB.wk === 'c:JUL-123' && jB.code_ok === 1, '占位番号 JUL-123:时长和 AVDB 对不上 → 不可信(按片名);对得上 → 就是那部片', [jA && jA.wk, jB && jB.wk]);
    ok(ir("name='SSIS-702 某合成丙' AND site='qa'")[0].wk === 'c:SSIS-702#clip' && ir("name='SSIS-702 某合成丙' AND site='qb'")[0].wk === 'c:SSIS-702', 'AVDB 片长认片段:< 50% → #clip(单独一张卡)');
    const s703 = ir("name='SSIS-703 某合成丁'")[0];
    ok(s703.wk.startsWith('t:') && s703.code_ok === 0 && cat9.stats().flags['avdb-conflict'] >= 2, '白名单番号但时长和 AVDB 冲突(不是片段)→ 不可信', [s703.wk, cat9.stats().flags]);
    // —— 片长兜底 / 封面兜底 / 发行日 / 演员 / 片商 ——
    const w704 = wr('c:SSIS-704');
    ok(w704.dur_med === 0 && w704.dur === 7300, '线路都没时长 → 展示时长用 AVDB 片长(作品键的时长闸不用它)', [w704.dur_med, w704.dur]);
    const card704 = cat9.browse({ b: 'jp_censored', dur: 'xxl' }).results.find((c) => c.wk === 'c:SSIS-704');
    ok(card704 && card704.dur === 7300, '卡片时长 / 时长筛选也用 AVDB 片长', card704);
    const all9 = [];
    for (let p = 1; p <= 5; p++) all9.push(...cat9.browse({ b: 'jp_censored', page: p }).results);
    const c705 = all9.find((c) => c.wk === 'c:SSIS-705');
    ok(c705 && c705.pic === 'https://poster.example/705.jpg', '线路都没封面 → 卡片用 AVDB 封面', c705);
    const pu = cat9.picUrl('c:SSIS-704', '', { meta: true });
    ok(pu && pu.urls.length === 2 && /img\.example/.test(pu.urls[0]) && pu.urls[1] === 'https://poster.example/704.jpg' && pu.url === pu.urls[0], '封面代理候选:线路封面在前、AVDB 封面兜底(线路封面死了换下一个)', pu);
    ok(JSON.stringify(cat9.picUrl('c:SSIS-705', '', { meta: true }).urls) === JSON.stringify(['https://poster.example/705.jpg']), '没有线路封面:代理只有 AVDB 封面');
    const g123 = await cat9.work('c:QWER-123');
    const M = g123 && g123._meta;
    ok(M && M.released === recent(11) && M.maker === '合成片商A' && M.label === 'QWER Label' && M.avdb === true && M.studio === '合成片商A', '作品 _meta:released / maker / label / avdb / studio(没有片商前缀时用 AVDB 片商)', M);
    ok(M && JSON.stringify(M.actress) === JSON.stringify([{ aid: 501, name: 'Kakuu Hanako' }]), '作品 _meta.actress:AVDB 演员带 aid', M && M.actress);
    ok(M && M.tags.some((t) => t.id === 'busty' && t.label === '巨乳' && t.group === 'body' && t.featured === true), '作品标签合并 AVDB 标签({id,label,group,featured})', M && M.tags);
    ok(g123.pic && /img\.example/.test(g123.pic), '有线路封面时作品封面还是线路封面');
    // —— AI 改写标题的严格口径 ——
    ok(String(wr('c:SSIS-740').tags).includes(',busty,') && !String(wr('c:SSIS-741').tags).includes(',black_stockings,') && !String(wr('c:SSIS-741').tags).includes(',stockings,'),
        'AI 改写标题站的片名标签:有别的线路证实才算(SSIS-740 巨乳留下;SSIS-741 只有 AI 标题的 黑丝 丢掉)', [wr('c:SSIS-740').tags, wr('c:SSIS-741').tags]);
    // —— 首页:新片速递 ——
    let h9 = cat9.home();
    const ids9 = h9.rows.map((r) => r.id);
    const fr = h9.rows.find((r) => r.id === 'fresh');
    ok(fr && fr.title === '新片速递' && JSON.stringify(fr.more) === JSON.stringify({ sort: 'released' }) && fr.items.length === 14 && ids9.indexOf('fresh') === ids9.indexOf('new') + 1,
        '新片速递:AVDB 发行日 60 天内、能播、≥12 部才出,紧跟新上架(没有热门行时)', [ids9, fr && fr.items.length]);
    ok(fr.items.every((c) => c.released && c.released >= recent(60)) && !fr.items.some((c) => c.wk === 'c:SSIS-731'), '新片速递只收 60 天内(2020 年的不收);卡片带 released', fr.items.map((c) => c.released));
    // 热门行出现后新片速递排在它后面
    pop = all9.filter((c) => /某合成填充/.test(c.name)).slice(0, 12).map((c) => c.name);
    cat9.rebuild();
    h9 = cat9.home();
    const ids9b = h9.rows.map((r) => r.id);
    ok(ids9b[0] === 'new' && ids9b[1] === 'hot' && ids9b[2] === 'fresh', '行序:新上架 → 热门 → 新片速递', ids9b);
    // —— 浏览:排序 / 分面 / 游标 ——
    const rel = cat9.browse({ b: 'jp_censored', sort: 'released' }).results;
    const relDates = rel.filter((c) => c.released).map((c) => c.released);
    ok(relDates.length >= 14 && relDates.every((x, i) => i === 0 || x <= relDates[i - 1]) && rel.findIndex((c) => !c.released) > rel.findIndex((c) => c.wk === 'c:SSIS-731'), '排序 released:发行日倒序,没有日期的排后面', relDates);
    const hot = cat9.browse({ sort: 'hot' }).results;
    ok(hot.slice(0, 12).map((c) => c.name).join() === pop.join(), '排序 hot:按本站热门(lib/popular)排名', hot.slice(0, 3).map((c) => c.name));
    const F = cat9.browse({ b: 'jp_censored', facets: 1 });
    const fc = F.facets;
    ok(fc && ['buckets', 'groups', 'more', 'dur', 'variant', 'studio', 'actress', 'sorts'].every((k) => Array.isArray(fc[k])), 'facets=1:buckets/groups/more/dur/variant/studio/actress/sorts', fc && Object.keys(fc));
    ok(fc.groups.every((g) => g.label && g.tags.every((t) => adult.tags.isFeatured(t.id) && typeof t.count === 'number')) && fc.more.every((t) => adult.tags.isReview(t.id) && !('count' in t)), '分面:标签组只有 featured(带计数),审查级只在 more 里、不给计数', fc.more);
    ok(fc.dur.length === 6 && fc.dur.map((d) => d.id).join() === 's,m,l,xl,xxl,unk' && fc.dur.find((d) => d.id === 'unk').count >= 10, '分面:时长 6 档(含 未知)', fc.dur);
    ok(fc.variant.some((v) => v.id === 'zh' && v.count === 6) && fc.studio.some((s) => s.id === 'S1' && s.label === 'S1') && fc.studio.some((s) => s.id === '合成片商A'), '分面:版本(中字 6)/ 片商(S1、AVDB 片商)', [fc.variant, fc.studio]);
    ok(fc.actress.length === 1 && fc.actress[0].aid === 501 && fc.actress[0].name === 'Kakuu Hanako' && fc.actress[0].count === 1, '分面:演员(AVDB)', fc.actress);
    const fcn = cat9.browse({ b: 'cn_amateur', facets: 1 }).facets;
    ok(fc.sorts.find((s) => s.id === 'released').available === true && fc.sorts.find((s) => s.id === 'hot').available === true && fc.sorts.find((s) => s.id === 'new').available === true
        && fcn.sorts.find((s) => s.id === 'released').available === false && fcn.sorts.find((s) => s.id === 'hot').available === false,
        '分面:排序可用性(released / hot 要这个筛选里有 ≥12 部有数据)', [fc.sorts, fcn.sorts]);
    ok(fc.buckets.some((b) => b.id === 'jp_censored' && b.count === F.total_results) && fc.buckets.some((b) => b.id === 'cn_amateur' && b.count === 2), '分面:分区计数(不套分区这一维)', fc.buckets);
    // 标签计数 = 点进去的结果数:选了 巨乳 之后,同组(身材)兄弟标签的计数也按 巨乳 筛过(t= 同组也是"且");已选的 = 当前总数
    const Fb = cat9.browse({ b: 'jp_censored', t: 'busty', facets: 1 });
    const body0 = fc.groups.find((g) => g.id === 'body'), body1 = Fb.facets.groups.find((g) => g.id === 'body');
    ok(Fb.total_results === 2 && body1 && body0 && body1.tags.find((t) => t.id === 'busty').count === Fb.total_results, '标签分面:已选标签的计数 = 当前总数', [Fb.total_results, body0, body1]);
    ok(body1.tags.filter((t) => t.id !== 'busty').every((t) => t.count === cat9.browse({ b: 'jp_censored', t: 'busty,' + t.id }).total_results), '标签分面:同组兄弟标签的计数 = 两个一起选的结果数(不再按析取多报)', body1.tags);
    ok(Fb.facets.dur.reduce((a, d) => a + d.count, 0) === 2, '别的维度按已选标签筛过');
    // 筛选:片商 / 演员 / 版本 / 时长未知 / 排除
    ok(cat9.browse({ studio: 'S1' }).results.every((c) => /^c:SSIS-/.test(c.wk)) && cat9.browse({ studio: '合成片商A' }).results.map((c) => c.wk).join() === 'c:QWER-123' && cat9.browse({ studio: 'nope' }).total_results === 0, '片商筛选;不认识的片商 → 空');
    ok(cat9.browse({ actress: '501' }).results.map((c) => c.wk).join() === 'c:QWER-123' && cat9.browse({ actress: '999' }).total_results === 0, '演员筛选;不认识的演员 → 空');
    ok(cat9.browse({ v: 'zh' }).results.every((c) => c.badge === '中字') && cat9.browse({ dur: 'unk' }).results.every((c) => !c.dur) && cat9.browse({ dur: 'unk' }).total_results >= 10, '版本 / 时长未知筛选');
    ok(cat9.browse({ dur: 'zz' }).total_results === 0 && cat9.browse({ v: 'zz' }).total_results === 0 && cat9.browse({ dur: 'zz', facets: 1 }).results.length === 0, '不认识的 dur / v → 空页(和未知标签一样,不再悄悄当"不筛")');
    // 游标:第 1 页的 cursor_next = 第 2 页;快照换了也从上一页最后一部之后接着翻
    const p1 = cat9.browse({ b: 'jp_censored' });
    const p2 = cat9.browse({ b: 'jp_censored', page: 2 });
    ok(p1.results.length === 24 && typeof p1.cursor_next === 'string' && p2.results.length > 0, '第 1 页满 24 张、给 cursor_next');
    const pc = cat9.browse({ b: 'jp_censored', cursor: p1.cursor_next });
    ok(pc.page === 2 && pc.results.map((c) => c.wk).join() === p2.results.map((c) => c.wk).join(), 'cursor 翻页 = page=2', [pc.page, pc.results.length]);
    c9.t += 11 * MIN;
    cat9.rebuild();
    const pc2 = cat9.browse({ b: 'jp_censored', cursor: p1.cursor_next });
    ok(pc2.results.map((c) => c.wk).join() === p2.results.map((c) => c.wk).join(), '快照换了:按上一页最后一部作品接着翻');
    ok(cat9.browse({ b: 'jp_censored', cursor: 'garbage!!' }).results.length === 24, '坏游标当没有(从头)');
    // —— 标签云 / 标签页 / 片商 / 演员 ——
    const tg9 = cat9.tags('jp_censored');
    ok(tg9.tags.some((t) => t.id === 'busty' && t.group === 'body') && tg9.groups.some((g) => g.id === 'body' && g.label) && tg9.tags.every((t) => t.featured === true), '标签云:{groups, tags} 只 featured');
    const tp = cat9.tagPage('busty');
    ok(tp && tp.tag.id === 'busty' && tp.tag.label === '巨乳' && tp.tag.group === 'body' && !tp.tag.review && tp.count === 2 && tp.buckets.some((b) => b.id === 'jp_censored' && b.count === 2)
        && tp.items.length === 2 && tp.related.every((r) => adult.tags.isFeatured(r.id) && r.lift > 0), '标签页:{tag, count, buckets, related(只 featured), items}', tp);
    const tpl = cat9.tagPage('milf');
    ok(tpl && tpl.tag.id === 'wife', '标签页:旧 id 经 LEGACY');
    const tpr = cat9.tagPage('incest');
    ok(tpr && tpr.tag.review === true && tpr.buckets.length === 0 && tpr.related.length === 0, '标签页:审查级标签 review:true、没有分区高亮 / 相关', tpr);
    ok(cat9.tagPage('x_minor') === null && cat9.tagPage('x_school') === null && cat9.tagPage('nope') === null && cat9.tagPage('../x') === null, '标签页:blocked / 未知 → null(闸门 404)');
    const st9 = cat9.studios('jp_censored');
    ok(st9.length >= 2 && st9[0].count >= st9[st9.length - 1].count && st9.some((s) => s.id === 'S1'), '片商榜', st9);
    ok(cat9.studios('nope').length === 0, '片商榜:未知分区 → 空');
    const ac = cat9.actress('501');
    ok(ac && ac.actress.aid === 501 && ac.actress.name === 'Kakuu Hanako' && ac.results.map((c) => c.wk).join() === 'c:QWER-123' && ac.total_pages === 1, '演员页 {actress, page, total_pages, results}', ac);
    ok(cat9.actress('999') === null && cat9.actress('a b') === null, '演员页:没有 / 非法 → null');
    avSet('ZZZZ-901', { actors: [{ aid: 902, name: 'Kakuu Nowork' }] });
    ok(cat9.actress('902') === null, '演员页:AVDB 有这个人但目录里她一部可见作品都没有 → null(闸门 404,不能拿 aid 枚举名字)');
    ok(JSON.stringify(cat9.actressSearch('kakuu')) === JSON.stringify([{ aid: 501, name: 'Kakuu Hanako', n: 1 }]) && cat9.actressSearch('迷奸').length === 0, '演员搜索;被拦的查询 → 空');
    // —— 入库之后 AVDB 才拦:复核把线路和作品都删掉 ——
    ok(wr('c:SSIS-750') && (await cat9.work('c:SSIS-750')), '先入库(AVDB 还没收录)');
    const has750 = (list) => (Array.isArray(list) ? list : []).some((c) => c && c.wk === 'c:SSIS-750');
    const pages750 = () => { const a = []; for (let p = 1; p <= 5; p++) a.push(...cat9.browse({ b: 'jp_censored', page: p }).results); return a; };
    const home750 = () => cat9.home().rows.some((r) => has750(r.items));
    ok(has750(pages750()) && home750() && has750(cat9.lookup('某合成后来被拦')) && has750(cat9.suggest('某合成后来被拦').items), '拦之前:浏览 / 首页 / 查找 / 联想里都有它');
    avSet('SSIS-750', { pol: 'block' });
    // 写线程复核、快照重建之前:主线程出口复查已经不让它出现(作品行还在库里)
    ok(wr('c:SSIS-750') && !has750(pages750()) && !home750() && !has750(cat9.lookup('某合成后来被拦')) && !has750(cat9.suggest('某合成后来被拦').items)
        && (await cat9.work('c:SSIS-750')) === null && cat9.picUrl('c:SSIS-750') === null && cat9.avdbPol('SSIS-750') === 'block',
        'AVDB 新拦的番号:复核前浏览 / 首页 / 查找 / 联想 / 作品页 / 封面代理就都不出');
    const av = await cat9.avdbSync({});
    ok(av && av.ran && av.changed >= 1 && !wr('c:SSIS-750') && !ir("name LIKE 'SSIS-750%'").length && (await cat9.work('c:SSIS-750')) === null, 'AVDB 后来拦了:复核删掉线路 + 作品', av);
    ok(!(await cat9.avdbSync({})).ran, 'AVDB 没变化:不复核');
    avSet('__meta', { polv: 'stub-v2' });
    ok((await cat9.avdbSync({})).ran && !(await cat9.avdbSync({})).ran, 'AVDB 政策规则版本变了(行数 / 时间都没变)→ 复核一次');
    avSet('__meta', { polv: 'stub-v2', polchg: 5 });
    ok((await cat9.avdbSync({})).ran, 'AVDB 政策戳变了(有带等级的行进来)→ 复核');
    // 封面代理开着:没有线路封面的卡片走 /api/img?k=(不带站)
    const cat9p = createCatalog({ db: db9, getSites: () => n9.sitesCfg(), adult, httpGet: n9.httpGet, log: () => {}, env: { ADULT_IMG_PROXY: '1' }, now: c9.now, sleep: c9.sleep, avdbFactory: (db) => AVSTUB.createAvdb({ db }) });
    const all9p = [];
    for (let p = 1; p <= 5; p++) all9p.push(...cat9p.browse({ b: 'jp_censored', page: p }).results);
    ok(all9p.find((c) => c.wk === 'c:SSIS-705').pic === '/api/img?k=' + encodeURIComponent('c:SSIS-705') && all9p.find((c) => c.wk === 'c:QWER-123').pic === '/api/img?k=' + encodeURIComponent('c:QWER-123') + '&s=qa',
        '封面代理:线路封面 /api/img?k=&s=,只有 AVDB 封面 /api/img?k=');
    ok(n9.log.every((x) => /^https:\/\/q[a-z]+\.test\/api\.php\/provide\/vod\?ac=(?:list|detail)/.test(x.url)), '第三阶段也只调 maccms API(AVDB 在本地表,零上游)');
    // 游标续翻不受页号上限(maxPages)限制
    const cat9m = createCatalog({ db: db9, getSites: () => n9.sitesCfg(), adult, httpGet: n9.httpGet, log: () => {}, now: c9.now, sleep: c9.sleep, avdbFactory: (db) => AVSTUB.createAvdb({ db }), opts: { maxPages: 2 } });
    let bm = cat9m.browse({ b: 'jp_censored' });
    const totM = bm.total_results, seenM = new Set(bm.results.map((c) => c.wk));
    let pgM = 1;
    ok(bm.total_pages === 2 && totM > 48 && typeof bm.cursor_next === 'string', '按页号最多 maxPages 页', [bm.total_pages, totM]);
    while (bm.cursor_next && pgM < 20) { bm = cat9m.browse({ b: 'jp_censored', cursor: bm.cursor_next }); pgM++; for (const c of bm.results) seenM.add(c.wk); }
    ok(pgM === Math.ceil(totM / 24) && pgM > 2 && bm.page === pgM && bm.total_pages === pgM && bm.cursor_next === null && seenM.size === totM, '游标续翻过 maxPages 一直到底(不重不漏)', [pgM, bm.page, bm.total_pages, seenM.size, totM]);
    // AVDB 配了但主线程实例建不起来:番号一律当被拦(fail-closed),列表里的番号作品不出,纯片名作品照常
    const cat9f = createCatalog({ db: db9, getSites: () => n9.sitesCfg(), adult, httpGet: n9.httpGet, log: () => {}, now: c9.now, sleep: c9.sleep,
        avdbFactory: () => { throw new Error('simulated'); }, opts: { avdbRetryMs: 3600e3 } });
    const lf = cat9f.browse({ b: 'jp_censored' }).results, lt = cat9f.lookup('某合成国产作品');
    ok(cat9f.avdbPol('QWER-123') === 'block' && cat9f.stats().avdb.failClosed === true && cat9f.suggest('QWER-123').kind === 'blocked' && cat9f.lookup('QWER-123').length === 0
        && (await cat9f.work('c:QWER-123')) === null && lf.length === 0 && lt.length > 0 && lt.every((c) => !c.wk.startsWith('c:')),
        'AVDB 主线程实例建不起来 → 番号一律当被拦(闸门搜索 / 列表 / 作品页 / 联想),纯片名作品照常', [lf.length, lt.map((c) => c.wk)]);
    ok(cat9f.avdbPol('QWER-123') === 'block', '重试间隔内不反复建(主线程不卡)');
}

// =====================================================================
console.log('⑨ 第三阶段(worker):写线程入库 / 读线程浏览 / AVDB 住写线程 / 全量历史回填(可续、同域名 ≥2.2s、CATALOG_BACKFILL=0)');
{
    const tmpW = fs.mkdtempSync(path.join(os.tmpdir(), 'catw-'));
    const file = path.join(tmpW, 'catalog.db');
    const cw = mkClock(T0), nw = mkNet(cw);
    nw.latency = 30;
    const WA = nw.site('wa'), WB = nw.site('wb'), WC = nw.site('wc');
    for (let i = 0; i < 300; i++) WA.items.push(mk(`SSIS-${100 + i} 某合成历史作品${i}`, '日本有码', { t: i < 40 ? T0 - i * HOUR - MIN : T0 - 80 * HOUR - i * HOUR, dur: 7000 + i }));
    for (let i = 0; i < 150; i++) WB.items.push(mk(`某合成国产历史${i}`, '国产自拍', { t: i < 20 ? T0 - i * HOUR - MIN : T0 - 100 * HOUR - i * HOUR, dur: 600 + i }));
    WC.items.push(mk('SSIS-990 某合成被拦', '日本有码', { t: T0 - HOUR, dur: 7200 }));
    {
        const d0 = new Database(file);
        d0.exec('CREATE TABLE avdb_stub (key TEXT PRIMARY KEY, j TEXT NOT NULL)');
        d0.prepare('INSERT INTO avdb_stub VALUES (?, ?)').run('SSIS-990', JSON.stringify({ pol: 'block' }));
        d0.prepare('INSERT INTO avdb_stub VALUES (?, ?)').run('SSIS-101', JSON.stringify({ runtime: 7001, actors: [{ aid: 900, name: 'Kakuu Worker' }] }));
        d0.close();
    }
    const logsW = [];
    const mkW = (env, f) => createCatalog({ dbPath: f || file, getSites: () => nw.sitesCfg(), adult, httpGet: nw.httpGet, log: (m) => logsW.push(m), env: Object.assign({}, env || {}), now: cw.now, sleep: cw.sleep,
        avdbFactory: (db) => AVSTUB.createAvdb({ db }), avdbModule: path.join(ROOT, 'scripts/fixtures/catalog/avdb-stub.cjs') });
    const cw1 = mkW();
    ok((await cw1.ready()) === true && cw1.mode === 'worker', 'dbPath → 写线程 + 两个读线程', logsW);
    const r1 = await cw1.tick();
    const ro = new Database(file, { readonly: true });
    const nItems = () => ro.prepare('SELECT COUNT(*) n FROM adult_items').get().n;
    ok(r1.requests > 0 && r1.ingested === 60 && nItems() === 60, '增量爬取(h=72):主线程出网、写线程入库', [r1, nItems()]);
    const s1 = await cw1.statsAsync();
    ok(!ro.prepare("SELECT 1 FROM adult_items WHERE name LIKE 'SSIS-990%'").get() && s1.rejected['avdb-block'] === 1 && cw1.avdbPol('SSIS-990') === 'block', 'AVDB 住写线程:pol=block 入库就拦;主线程只读实例(闸门用)看得到同一份', s1.rejected);
    const h1 = await cw1.home();
    ok(h1.rows.some((r) => r.id === 'new' && r.items.length === 24), '读线程建快照 → 首页');
    const b1 = await cw1.browse({ b: 'jp_censored', facets: 1 });
    ok(b1.total_results === 40 && b1.results.length === 24 && b1.facets && Array.isArray(b1.facets.groups) && typeof b1.cursor_next === 'string', '读线程:浏览 + 分面 + 游标', [b1.total_results, b1.facets && Object.keys(b1.facets)]);
    const b1c = await cw1.browse({ b: 'jp_censored', cursor: b1.cursor_next });
    ok(b1c.page === 2 && b1c.results.length === 16, '读线程:游标翻页(两个读线程共用同一个快照)', [b1c.page, b1c.results.length]);
    const g1 = await cw1.work('c:SSIS-100');
    ok(g1 && g1.sources.length === 1 && g1.sources[0].site_key === 'wa', '作品页(主线程点查)');
    const vid = ro.prepare("SELECT vod_id FROM adult_items WHERE wk='c:SSIS-100'").get().vod_id;
    const bk = await cw1.beacon({ site_key: 'wa', vod_id: vid, ok: true, w: 1920, h: 1080 }, 'w1');
    ok(bk && bk.ok === true && ro.prepare("SELECT res FROM adult_items WHERE wk='c:SSIS-100'").get().res === '1920x1080', '上报 → 写线程');
    const sg = await cw1.suggest('SSIS-101');
    ok(sg.kind === 'code' && sg.exact === 'c:SSIS-101' && (await cw1.suggest('SSIS-990')).kind === 'blocked', '联想(读线程);AVDB 拦截 → blocked');
    ok((await cw1.lookup('某合成国产历史1')).length > 0 && (await cw1.tags('')).tags !== undefined && Array.isArray(await cw1.studios('')), '查找 / 标签云 / 片商榜');
    const asw = await cw1.actressSearch('kakuu');
    const apw = await cw1.actress('900');
    ok(asw.length === 1 && asw[0].aid === 900 && apw && apw.results.map((c) => c.wk).join() === 'c:SSIS-101' && (await cw1.browse({ actress: '900' })).total_results === 1,
        'AVDB 演员:搜索在写线程跑(主线程不做 LIKE 扫描)、演员页 / 演员筛选', [asw, apw && apw.results.length]);
    // —— 全量历史回填 ——
    const m0 = nw.log.length;
    const lastEnd = new Map();
    for (const x of nw.log) lastEnd.set(x.host, x.end);
    const hs1 = await cw1.historyStep({ maxPages: 2 });
    const bf1 = nw.log.slice(m0);
    ok(hs1.requests === 5 && bf1.length === 5 && bf1.every((x) => x.ac === 'detail' && !x.h && x.ps === 60 && x.t == null && x.wd == null && x.ids == null), '回填:ac=detail&pagesize=60&pg=N(不带 h),这一轮每站最多 2 页', bf1.map((x) => x.host + ':' + x.pg));
    ok(pacingOk(bf1, 2200).length === 0 && bf1.every((x) => !lastEnd.has(x.host) || x.start - lastEnd.get(x.host) >= 2200), '回填:同域名一次一个、间隔 ≥2.2s(和增量爬虫共用同域名队列)', pacingOk(bf1, 2200));
    const bs1 = Object.fromEntries((await cw1.statsAsync()).historySites.map((r) => [r.site, r]));
    ok(bs1.wa.pg === 3 && !bs1.wa.done && bs1.wb.pg === 3 && bs1.wc.done === 1, '回填进度存在 adult_backfill(每站一条游标)', bs1);
    await cw1.close();
    // 重启:从上次那页的前一页接着翻(新上架会把旧条目往后挤)
    const cw2 = mkW();
    await cw2.ready();
    const m1 = nw.log.length;
    const hs2 = await cw2.historyStep({ maxPages: 10 });
    const bf2 = nw.log.slice(m1);
    const firstPg = (h) => (bf2.find((x) => x.host === h) || {}).pg;
    ok(firstPg('wa.test') === 2 && firstPg('wb.test') === 2 && !bf2.some((x) => x.host === 'wc.test'), '续跑:从上次那页的前一页开始;已完成的站不再请求', bf2.map((x) => x.host + ':' + x.pg));
    const bs2 = Object.fromEntries((await cw2.statsAsync()).historySites.map((r) => [r.site, r]));
    ok(bs2.wa.done === 1 && bs2.wb.done === 1 && nItems() === 450 && hs2.sitesDone === 2, '回填完:全部历史入库(300 + 150;被拦的 1 条不收)', [bs2, nItems()]);
    ok(pacingOk(bf2, 2200).length === 0, '续跑也守 2.2s 间隔');
    const b2 = await cw2.browse({ b: 'jp_censored' });
    ok(b2.total_results === 300 || (await (async () => { await cw2.rebuild(); return (await cw2.browse({ b: 'jp_censored' })).total_results === 300; })()), '回填的旧作品进浏览');
    ok((await cw2.historyStep({})).pending === 0, '全部完成:没有待回填的站');
    await cw2.close();
    // 自动开始 / CATALOG_BACKFILL=0
    const f3 = path.join(tmpW, 'auto.db'), f4 = path.join(tmpW, 'off.db');
    const cw3 = mkW({ CATALOG_FIRST_DELAY_MS: '0' }, f3), cw4 = mkW({ CATALOG_FIRST_DELAY_MS: '0', CATALOG_BACKFILL: '0' }, f4);
    cw3.start(); cw4.start();
    for (let i = 0; i < 100 && !(cw3.stats().lastTick && cw4.stats().lastTick); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    ok(cw3.stats().history.enabled === true && cw3.stats().history.running === true, '首轮增量爬完 → 全量回填自动开始', cw3.stats().history);
    ok(cw4.stats().history.enabled === false && cw4.stats().history.running === false && cw4.stats().history.requests === 0, 'CATALOG_BACKFILL=0:不回填', cw4.stats().history);
    await cw3.close(); await cw4.close();
    // 重启:上次没回填完(第一轮增量已爬完)→ start() 就接着回填,不等哪一轮爬虫真发出请求
    const f5 = path.join(tmpW, 'resume.db');
    const cw5 = mkW({}, f5);
    await cw5.ready();
    await cw5.tick();
    ok(cw5.stats().history.running === false, '没 start:只爬增量,不回填');
    // 回填和增量爬虫同时在同一批域名上跑:回填碰过的域名,爬虫请求也按 ≥2.2s 排(原来回填一页后紧跟的爬虫请求只隔 2.0s)
    cw.t += 2 * HOUR;
    const m5 = nw.log.length;
    const [hs5, rt5] = await Promise.all([cw5.historyStep({ maxPages: 2 }), cw5.tick()]);
    const mixed = nw.log.slice(m5);
    ok(hs5.requests > 0 && rt5.requests > 0 && mixed.some((x) => x.h) && pacingOk(mixed, 2200).length === 0, '回填 + 增量爬虫同域名交错:间隔都 ≥2.2s(共用下限)', [hs5.requests, rt5.requests, pacingOk(mixed, 2200)]);
    await cw5.close();
    const cw6 = mkW({ CATALOG_FIRST_DELAY_MS: '3600000' }, f5);
    const m6 = nw.log.length;
    cw6.start();
    for (let i = 0; i < 100 && !(cw6.stats().history.requests > 0); i++) await new Promise((r) => setTimeout(r, 50));
    const h6 = cw6.stats();
    ok(h6.lastTick == null && h6.history.running === true && h6.history.requests > 0 && nw.log.slice(m6).length > 0 && nw.log.slice(m6).every((x) => x.ac === 'detail' && !x.h),
        '重启后直接接着回填(爬虫一轮都没跑)', [h6.lastTick, h6.history]);
    await cw6.close();
    ro.close();
    try { fs.rmSync(tmpW, { recursive: true, force: true }); } catch (_) { /* Windows 上 WAL 文件偶尔晚一点释放 */ }
}

// =====================================================================
console.log('⑩ 第三阶段:20 万作品合成目录 —— 浏览 / 分面 / 标签 / 联想调用时主线程卡顿 < 50 ms');
{
    const { synth } = require(path.join(ROOT, 'scripts/fixtures/catalog/synth.cjs'));
    const { performance } = await import('node:perf_hooks');
    const tmpS = fs.mkdtempSync(path.join(os.tmpdir(), 'cat200k-'));
    const file = path.join(tmpS, 'catalog.db');
    let t = performance.now();
    synth(file, { n: 200000, adult, now: T0 });
    const genMs = performance.now() - t;
    const sites = [{ key: 's1', name: 'S1', api: 'https://s1.test/api.php/provide/vod' }, { key: 's2', name: 'S2', api: 'https://s2.test/api.php/provide/vod' }];
    let maxLag = 0, last = performance.now();
    const lags = [];
    const iv = setInterval(() => { const n = performance.now(); const lag = n - last - 2; if (lag > maxLag) maxLag = lag; lags.push(lag); last = n; }, 2);
    const catS = createCatalog({ dbPath: file, getSites: () => sites, adult, env: { CATALOG_DISABLE: '1' }, httpGet: async () => { throw new Error('offline'); }, log: () => {}, now: () => T0 });
    await catS.ready();
    t = performance.now();
    const hS = await catS.home();
    const firstMs = performance.now() - t;
    const feats = adult.tags.VOCAB.filter((x) => adult.tags.isFeatured(x.id)).map((x) => x.id);
    const qs = [];
    for (let i = 0; i < 300; i++) {
        const p = { b: ['', 'jp_censored', 'cn_amateur', 'western', 'anime'][i % 5], sort: ['new', 'updated', 'released', 'hot', 'dur', 'lines', 'rand'][i % 7], page: 1 + (i % 40) };
        if (i % 2) p.facets = 1;
        if (i % 3 === 0) p.t = feats.slice(i % 25, i % 25 + 1 + (i % 3)).join(',');
        if (i % 4 === 0) p.x = feats[(i * 7) % feats.length];
        if (i % 5 === 0) p.dur = ['s', 'm', 'l', 'xl', 'xxl', 'unk'][i % 6];
        if (i % 6 === 0) p.v = ['zh', 'unc', 'leak', 'vr', '4k', 'vertical'][i % 6];
        qs.push(p);
    }
    const lat = [];
    t = performance.now();
    const res = await Promise.all(qs.map(async (p) => { const s = performance.now(); const r = await catS.browse(p); lat.push(performance.now() - s); return r; }));
    const wall = performance.now() - t;
    lat.sort((a, b) => a - b);
    const okShape = res.every((r) => r && Array.isArray(r.results) && typeof r.total_results === 'number');
    const big = await catS.browse({ facets: 1 });
    t = performance.now();
    for (let i = 0; i < 20; i++) { await catS.tags(i % 2 ? 'jp_censored' : ''); await catS.studios(''); await catS.tagPage(feats[i]); await catS.suggest('合成作品标题' + (100 + i)); await catS.lookup('ZZT-' + (300 + i)); }
    const miscMs = performance.now() - t;
    t = performance.now();
    const rb = await catS.rebuild();
    const rebuildMs = performance.now() - t;
    clearInterval(iv);
    lags.sort((a, b) => a - b);
    const snapS = catS.stats().snapshot;
    console.log(`  (20 万作品:生成 ${Math.round(genMs)} ms;首个快照 ${Math.round(firstMs)} ms(读线程建 ${snapS.buildMs} ms);浏览 ×300 并发 ${Math.round(wall)} ms,p50 ${lat[150].toFixed(1)} / p95 ${lat[285].toFixed(1)} ms;` +
        `标签/片商/标签页/联想/查找 ×20 ${Math.round(miscMs)} ms;重建 ${Math.round(rebuildMs)} ms;主线程最大卡顿 ${maxLag.toFixed(1)} ms(p99 ${lags[Math.floor(lags.length * 0.99)].toFixed(1)},${lags.length} 次采样))`);
    ok(snapS.works === 200000 && hS.rows.length >= 10 && okShape && big.total_results > 150000 && big.facets.groups.length >= 8, '20 万作品:快照 / 首页 / 浏览 / 分面都正常', [snapS, hS.rows.length, big.total_results]);
    ok(maxLag < 50, '主线程卡顿 < 50 ms(浏览 / 分面 / 标签 / 联想 / 建快照全程)', maxLag);
    ok(rb && rb.N === 200000, '重建快照(读线程)');
    await catS.close();
    try { fs.rmSync(tmpS, { recursive: true, force: true }); } catch (_) { /* */ }
}

console.log(`\nsite-catalog-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
