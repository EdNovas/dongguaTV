#!/usr/bin/env node
// 片头标记 / 包络迁移回归(零外网,只起本地 server.js):
//   node scripts/intro-mark-migrate-test.mjs
//  ① lib/intro-marks 合并规则:新算法值 > 旧值,不平均、不计票、不削票;片头、贴片、片尾两两组合(新算法值、旧值、旧 src:manual、不带 mv 的上报);连续上报字段不漂移;墓碑;第三集确认只认 pid
//  ② IntroCore.introNeed:什么标记要重算、有值的 mv:2 不再分析(待确认也不算)、墓碑过期重试;闸门:mv:2、afp 自动跳,旧标记和旧 manual 不跳,待确认、墓碑不跳,片尾按常量;边看边学引擎的值不被信任
//  ③ 真实 afpOffline(vm):_apply 带 mv:2、学习对待确认只亮按钮、学习对之外定位命中才转正;旧标记和旧 manual 能被覆盖;超限记墓碑;_envParse 只作废片头组件;包络带 pid/peps;片尾带 emv
//  ④ server.js 端到端:老页面/新页面交替上报互不写坏;包络组件级合并;GET 借用;上限;墓碑校验;请求里的 src 没有任何特权
//  ⑤ server.js 端到端:老页面的裸键(不带 ch)不被 ep|ch 遮住;借用优先长包络
//  ⑥ server.js 端到端:优先级和确认的全路径(真实 _apply + 真实路由 + 真实 check());上中下各用各的键,老页面不带部分字段写不到这些键上
//  ⑦ 老页面(闸门读不到票数为假,上报不报错也改不动新值)、综艺变体集在真实 _introOnEpisode 里不分析不套用不亮按钮、留一行判定;README 和 OUTRO_AUTO 注释与现状一致
// 改片头标记、包络格式、/api/intro/* 后必跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const introMarks = require(path.join(ROOT, 'lib/intro-marks'));
const { MARK_V, mergeOp, mergeBump, mergeOutro, applyMiss, settlePair, marksForRead } = introMarks;
const NOW = 1800000000000;
const IntroCoreOf = () => makeClient().IntroCore;

console.log('① 合并规则');
{
    const inc = (os, oe, extra) => ({ os, oe, mv: MARK_V, ...(extra || {}) });
    const oldInc = (os, oe) => ({ os, oe, mv: 0 });
    const legacy = { os: 0, oe: 100, v: 5, src: 'auto', at: 1 };
    const manual = { os: 0, oe: 90, v: 7, src: 'manual', at: 1 };
    const m2 = { os: 0, oe: 101.1, mv: 2, pid: 'pidx', at: 1 };
    const only = { os: 0, oe: 0, v: 0, ed: 2000, ev: 1 };

    // 片头:新算法值 × 各种旧记录
    let r = mergeOp(undefined, inc(0, 101.1), NOW);
    ok(r.os === 0 && r.oe === 101.1 && r.mv === 2 && r.at === NOW && !('v' in r) && !('src' in r), '空位 + 新算法值:落值,不带票数和 src', r);
    r = mergeOp(only, inc(0, 101.1), NOW);
    ok(r.oe === 101.1 && r.mv === 2, '只有片尾的旧行 + 新算法值:片头直接落值', r);
    for (const [name, old] of [['旧值 1 票', { ...legacy, v: 1 }], ['旧值多票', legacy], ['旧 src:manual', manual]]) {
        r = mergeOp(old, inc(0, 101.1), NOW);
        ok(r.oe === 101.1 && r.mv === 2 && !('v' in r) && !('src' in r), name + ' + 新算法值:直接覆盖,不平均,旧票数和 src 不带过来', r);
    }
    r = mergeOp({ os: 120.8, oe: 151.6, v: 1, src: 'auto' }, inc(120.8, 215.3), NOW);
    ok(r.oe === 215.3 && r.mv === 2, '嫁金钗 30.8s 旧标记被 94.5s 新值覆盖', r);
    r = mergeOp(m2, inc(0.2, 101.4), NOW);
    ok(r.os === 0 && r.oe === 101.1 && r.pid === 'pidx' && r.at === NOW, '新算法值 + 新算法值(接近):保留已有值', r);
    r = mergeOp(m2, inc(0, 150, { pid: 'pidy', pend: 1 }), NOW);
    ok(r.oe === 101.1 && r.pid === 'pidx' && !r.pend, '新算法值 + 新算法值(差很多):还是保留已有值,不翻来翻去', r);
    r = mergeOp({ ...m2, pend: 1 }, inc(0, 150, { pid: 'pidy' }), NOW);
    ok(r.oe === 101.1 && r.pid === 'pidx' && r.pend === 1, '待确认的新算法值 + 别的新算法值:值和待确认状态都不变', r);

    // 片头:不带 mv 的上报(老页面、边看边学引擎)× 各种旧记录
    r = mergeOp(undefined, oldInc(0, 100), NOW);
    ok(r.oe === 100 && !r.mv && !('v' in r), '空位 + 不带 mv:落值,不带票数', r);
    for (const [name, old] of [['旧值 1 票', { ...legacy, v: 1 }], ['旧值多票', legacy], ['旧 src:manual', manual]]) {
        r = mergeOp(old, oldInc(0, 102), NOW);
        ok(r.os === 0 && r.oe === 102 && !r.mv && !('v' in r) && !('src' in r), name + ' + 不带 mv(接近):后写覆盖,不平均不计票', r);
        r = mergeOp(old, oldInc(300, 360), NOW);
        ok(r.os === 300 && r.oe === 360 && !('v' in r), name + ' + 不带 mv(差很多):后写覆盖,不削票', r);
    }
    for (const [name, old] of [['接近', [0, 100]], ['差很多', [300, 360]]]) {
        r = mergeOp(m2, oldInc(...old), NOW);
        ok(r.oe === 101.1 && r.os === 0 && r.mv === 2 && r.pid === 'pidx', '新算法值 + 不带 mv(' + name + '):动不了', r);
    }
    r = mergeOp({ ...m2, pend: 1 }, oldInc(0, 100), NOW);
    ok(r.oe === 101.1 && r.pend === 1, '待确认的新算法值 + 不带 mv:动不了', r);

    // 连续上报字段不漂移:没有平均
    let cur = mergeOp(undefined, inc(200, 260), NOW);
    for (let i = 0; i < 6; i++) cur = mergeOp(cur, inc(200 + i * 0.3, 260 + i * 0.3), NOW + i);
    ok(cur.os === 200 && cur.oe === 260, '新算法值连报 6 次:字段不漂移', cur);
    cur = mergeOp(undefined, oldInc(200, 260), NOW);
    for (let i = 1; i <= 6; i++) cur = mergeOp(cur, oldInc(200 + i, 260 + i), NOW + i);
    ok(cur.os === 206 && cur.oe === 266, '不带 mv 连报 6 次:就是最后一次的值,不是平均', cur);

    // 贴片和片尾各按同样的优先级
    const bump = (rec, old, bs, be, mv, pend) => mergeBump(rec, old, { bs, be, mv, pend });
    const outro = (rec, old, ed, emv) => mergeOutro(rec, old, { ed, emv });
    const bl = { os: 0, oe: 100, bs: 3, be: 8, bv: 5 }, bn = { os: 0, oe: 100, bs: 3, be: 8, bmv: 2 };
    let x = bump({ ...bl }, bl, 3.2, 8.2, MARK_V);
    ok(x.bs === 3.2 && x.be === 8.2 && x.bmv === 2 && !('bv' in x), '贴片:旧值 + 新算法值:覆盖,旧票数不留', x);
    x = bump({ ...bl }, bl, 4, 9, 0);
    ok(x.bs === 4 && x.be === 9 && !x.bmv && !('bv' in x), '贴片:旧值 + 不带 mv:后写覆盖', x);
    x = bump({ ...bn }, bn, 50, 60, MARK_V);
    ok(x.bs === 3 && x.be === 8 && x.bmv === 2, '贴片:新算法值 + 新算法值:保留已有值', x);
    x = bump({ ...bn }, bn, 4, 9, 0);
    ok(x.bs === 3 && x.be === 8 && x.bmv === 2, '贴片:新算法值 + 不带 mv:动不了', x);
    x = bump({ os: 0, oe: 100 }, null, 3, 8, MARK_V);
    ok(x.bs === 3 && x.bmv === 2, '贴片:空位 + 新算法值', x);
    x = bump({ os: 0, oe: 100 }, null, 3, 8, 0);
    ok(x.bs === 3 && !x.bmv && !('bv' in x), '贴片:空位 + 不带 mv,不带票数', x);
    x = bump({ os: 0, oe: 100, mv: 2 }, bl, null, null, 0);
    ok(x.bs === 3 && x.be === 8 && x.bv === 5 && !x.bmv, '贴片:这次没带,旧值和旧字段原样留着', x);
    let bc = bump({ os: 0, oe: 100 }, null, 3, 8, 0);
    for (let i = 1; i <= 4; i++) bc = bump({ ...bc }, bc, 3 + i, 8 + i, 0);
    ok(bc.bs === 7 && bc.be === 12, '贴片:不带 mv 连报:不平均', bc);
    bc = bump({ os: 0, oe: 100 }, null, 3, 8, MARK_V);
    for (let i = 1; i <= 4; i++) bc = bump({ ...bc }, bc, 3 + i * 0.3, 8 + i * 0.3, MARK_V);
    ok(bc.bs === 3 && bc.be === 8, '贴片:新算法值连报:字段不漂移', bc);
    x = bump({ os: 0, oe: 100, mv: 2 }, { os: 0, oe: 100, mv: 2, bs: 3, be: 8 }, 5, 10, MARK_V, true);
    ok(x.bs === 3 && !x.bmv, '贴片:待确认的贴片不能落到已确认的记录上(闸门按整条记录看 pend)', x);
    x = bump({ os: 0, oe: 100, mv: 2, pend: 1 }, null, 5, 10, MARK_V, true);
    ok(x.bs === 5 && x.bmv === 2 && x.pend === 1, '贴片:待确认的记录上落待确认的贴片,照常', x);
    // 贴片算法版本:高版本盖低版本,低版本盖不掉高版本,同版本不翻来翻去
    const b2 = { os: 0, oe: 100, mv: 2, bs: 35.4, be: 42.8, bmv: 2 }, b3 = { os: 0, oe: 100, mv: 2, bs: 0, be: 16, bmv: 3 };
    const bumpV = (old, bs, be, inc) => mergeBump({ ...old }, old, { bs, be, ...inc });
    x = bumpV(b2, 0, 16, { mv: MARK_V, bmv: 3 });
    ok(x.bs === 0 && x.be === 16 && x.bmv === 3, '贴片:bmv:2 + bmv:3:覆盖', x);
    for (const [name, inc] of [['bmv:3 连报', { mv: MARK_V, bmv: 3 }], ['老页面(mv:2 不带 bmv)', { mv: MARK_V }], ['不带 mv', { mv: 0 }]]) {
        x = bumpV(b3, 50, 60, inc);
        ok(x.bs === 0 && x.be === 16 && x.bmv === 3, '贴片:bmv:3 + ' + name + ':动不了', x);
    }
    for (const [name, inc] of [['老页面(mv:2 不带 bmv)', { mv: MARK_V }], ['不带 mv', { mv: 0 }]]) {
        x = bumpV(b2, 50, 60, inc);
        ok(x.bs === 35.4 && x.be === 42.8 && x.bmv === 2, '贴片:bmv:2 + ' + name + ':动不了(不翻来翻去)', x);
    }
    x = mergeBump({ os: 0, oe: 100 }, null, { bs: 3, be: 8, mv: MARK_V, bmv: 3 });
    ok(x.bs === 3 && x.bmv === 3, '贴片:空位 + bmv:3', x);
    x = mergeBump({ os: 0, oe: 100, mv: 2 }, { os: 0, oe: 100, mv: 2, bs: 3, be: 8 }, { bs: 5, be: 10, mv: MARK_V, bmv: 3, pend: true });
    ok(x.bs === 3 && !x.bmv, '贴片:待确认的 bmv:3 不能落到已确认的记录上', x);
    x = mergeBump({ os: 0, oe: 100, v: 1 }, { os: 0, oe: 100, bs: 3, be: 8, bv: 5 }, { bs: 5, be: 10, mv: MARK_V, bmv: 3 });
    ok(x.bs === 5 && x.bmv === 3 && !('bv' in x), '贴片:旧票数的旧值 + bmv:3:覆盖', x);
    // 读标记不下发 bmv:2:还开着的老页面按 bmv===2 自动跳贴片;存的不动
    {
        const src = { '1|r': { ...b2 }, '2|r': { ...b3 }, '3|r': { os: 0, oe: 100, mv: 2 }, '4': { os: 0, oe: 100, bs: 3, be: 8, bv: 5 } };
        const v = marksForRead(src);
        ok(!('bmv' in v['1|r']) && v['1|r'].bs === 35.4 && v['1|r'].be === 42.8 && v['1|r'].mv === 2, '读标记:bmv:2 不下发,区间留着', v['1|r']);
        ok(v['2|r'].bmv === 3 && v['3|r'].mv === 2 && v['4'].bv === 5, '读标记:bmv:3 和别的记录原样', v);
        ok(src['1|r'].bmv === 2, '读标记:存的不动', src['1|r']);
        ok(JSON.stringify(marksForRead({})) === '{}' && JSON.stringify(marksForRead(null)) === '{}', '读标记:空表不报错');
    }

    const el = { os: 0, oe: 100, ed: 2000, ev: 5 }, en = { os: 0, oe: 100, ed: 2000, emv: 2 };
    x = outro({ ...el }, el, 2003, MARK_V);
    ok(x.ed === 2003 && x.emv === 2 && !('ev' in x), '片尾:旧值 + 新算法值:覆盖,旧票数不留', x);
    x = outro({ ...el }, el, 2010, 0);
    ok(x.ed === 2010 && !x.emv && !('ev' in x), '片尾:旧值 + 不带 emv:后写覆盖', x);
    x = outro({ ...en }, en, 2100, MARK_V);
    ok(x.ed === 2000 && x.emv === 2, '片尾:新算法值 + 新算法值:保留已有值', x);
    x = outro({ ...en }, en, 2010, 0);
    ok(x.ed === 2000 && x.emv === 2, '片尾:新算法值 + 不带 emv:动不了', x);
    x = outro({ os: 0, oe: 100 }, null, 2000, MARK_V);
    ok(x.ed === 2000 && x.emv === 2, '片尾:空位 + 新算法值', x);
    x = outro({ os: 0, oe: 100 }, null, 2000, 0);
    ok(x.ed === 2000 && !x.emv && !('ev' in x), '片尾:空位 + 不带 emv,不带票数', x);
    x = outro({ os: 0, oe: 100, mv: 2 }, el, null, 0);
    ok(x.ed === 2000 && x.ev === 5 && !x.emv, '片尾:这次没带,旧值和旧字段原样留着', x);
    let ec = outro({ os: 0, oe: 100 }, null, 2000, 0);
    for (let i = 1; i <= 4; i++) ec = outro({ ...ec }, ec, 2000 + i * 3, 0);
    ok(ec.ed === 2012, '片尾:不带 emv 连报:不平均', ec);
    ec = outro({ os: 0, oe: 100 }, null, 2000, MARK_V);
    for (let i = 1; i <= 4; i++) ec = outro({ ...ec }, ec, 2000 + i, MARK_V);
    ok(ec.ed === 2000, '片尾:新算法值连报:字段不漂移', ec);

    // 墓碑
    let tb = applyMiss({ os: 314, oe: 357.5, v: 3, src: 'auto', ed: 2500, ev: 2 }, 1, NOW);
    ok(tb.os === 314 && tb.oe === 357.5 && tb.miss === 1 && tb.mv === 2 && tb.mt === NOW && tb.ed === 2500 && !('v' in tb) && !('src' in tb), '墓碑:旧值留着亮按钮,旧票数不留', tb);
    tb = applyMiss(undefined, 2, NOW);
    ok(tb.os === 0 && tb.oe === 0 && tb.miss === 2 && tb.mv === 2, '墓碑:无旧值也能记', tb);
    tb = applyMiss(m2, 1, NOW);
    ok(tb.oe === 101.1 && !tb.miss, '墓碑盖不掉新算法的真值', tb);
    tb = applyMiss({ ...m2, pend: 1 }, 1, NOW);
    ok(tb.oe === 101.1 && !tb.miss && tb.pend === 1, '墓碑盖不掉待确认的值', tb);
    tb = applyMiss(manual, 1, NOW);
    ok(tb.oe === 90 && tb.miss === 1 && !('src' in tb), '旧 src:manual 和别的旧值一样:墓碑记得上,值留着亮按钮', tb);
    const tomb = applyMiss({ os: 0, oe: 100, v: 1, src: 'auto' }, 1, NOW);
    r = mergeOp(tomb, inc(0, 101.1), NOW + 1);
    ok(r.oe === 101.1 && r.mv === 2 && !r.miss && !r.mt, '真值到了直接覆盖墓碑,清掉 miss', r);
    r = mergeOp(tomb, oldInc(0, 95), NOW + 1);
    ok(r.oe === 100 && r.miss === 1, '不带 mv 动不了墓碑(新页面已判过)', r);
    r = mergeOp(applyMiss(undefined, 2, NOW), oldInc(0, 95), NOW + 1);
    ok(r.oe === 0 && r.miss === 2, '不带 mv 动不了空墓碑', r);

    // 第三集确认:只认 pid,不数集数
    const map = { '5|r': { os: 0, oe: 90, mv: 2, pid: 'pa', pend: 1 }, '6|r': { os: 0, oe: 90, mv: 2, pid: 'pa', pend: 1 }, '7|r': { os: 0, oe: 90, mv: 2, pid: 'pb', pend: 1 }, '8|r': { os: 0, oe: 90, mv: 2, pid: 'pb', pend: 1 } };
    settlePair(map, '7|r', { mv: 2, pid: 'pb', pend: 1 });
    ok(map['5|r'].pend && map['6|r'].pend && map['7|r'].pend && map['8|r'].pend, '两个学习对凑够 4 集:互相确认不了', map);
    map['9|r'] = { os: 0, oe: 90, mv: 2, pid: 'pb' };
    settlePair(map, '9|r', { mv: 2, pid: 'pb' });
    ok(!map['7|r'].pend && !map['8|r'].pend && map['5|r'].pend && map['6|r'].pend, '学习对之外命中:只转正同 pid 的那一对,别的学习对不动', map);
    map['10|r'] = { os: 0, oe: 90, mv: 2, pid: 'pb', pend: 1 };
    settlePair(map, '10|r', { mv: 2, pid: 'pb', pend: 1 });
    ok(!map['10|r'].pend, '已被确认过的包络:后来才算到学习对的集(别的线路借来定位)直接算确认过', map['10|r']);
    map['11|r'] = { os: 0, oe: 90, mv: 2, pid: 'pa', pend: 1 };
    settlePair(map, '11|r', { mv: 2, pid: 'pa', pend: 1 });
    ok(map['11|r'].pend === 1, '没被确认过的包络:再来一集学习对的集,还是待确认', map['11|r']);
    settlePair(map, '5|r', { mv: 0, pid: 'pa' });
    ok(map['5|r'].pend === 1, '不带 mv 的上报确认不了');
    settlePair(map, '5|r', { mv: 2, pid: '' });
    ok(map['5|r'].pend === 1, '没有 pid 的上报确认不了');

    for (const k of ['voteOk', 'truthCount', 'VOTE_MIN_TRUTH']) ok(!(k in introMarks), 'lib/intro-marks 不再导出 ' + k);
    const libSrc = fs.readFileSync(path.join(ROOT, 'lib/intro-marks/index.js'), 'utf8');
    ok(!/=== 'manual'/.test(libSrc), 'lib/intro-marks 里没有 src===manual 的分支');
}

// ---------- 前端的真实代码 ----------
const coreM = /\/\/ <dg-intro-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-intro-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-intro-core> 段'); process.exit(1); }
const i0 = HTML.indexOf('if (!window.afpOffline) window.afpOffline = {'), i1 = HTML.indexOf('// ========== 🗨️ 弹幕样式管理器', i0);
if (i0 < 0 || i1 < 0) { console.log('✗ index.html 里找不到 afpOffline 段'); process.exit(1); }
function makeClient(envResp) {
    const store = new Map();
    const localStorage = { get length() { return store.size; }, key: i => [...store.keys()][i] ?? null, getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const win = {}, posts = [];
    const fetchStub = async (u, init) => { posts.push({ u: String(u), body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, json: async () => envResp || ({ env: null }) }; };
    const ctx = vm.createContext({ window: win, console: { log() { }, warn() { } }, localStorage, navigator: { onLine: true }, fetch: fetchStub, atob: s => Buffer.from(s, 'base64').toString('latin1'), btoa: s => Buffer.from(s, 'latin1').toString('base64'), MessageChannel, setTimeout, URL, Promise, Uint8Array, Float32Array, DataView, Math, Date, JSON, parseInt, parseFloat, isFinite, encodeURIComponent, String, Object, Array, RegExp, Error });
    vm.runInContext(coreM[1] + '\n;globalThis.__core = IntroCore;', ctx);
    vm.runInContext(HTML.slice(i0, i1), ctx);
    return { A: win.afpOffline, IntroCore: ctx.__core, localStorage, posts };
}
const makeVue = (marks, ch = 'r', epNow = 5, partNow = 0) => {
    const ups = [];
    const key = (ep, part) => ep + '|' + ch + (part ? '|' + part : '');
    return {
        ups, marks,
        vue: {
            _introMarks: { key: 'T|S', at: 0, marks },
            _introMarkGet(ep, part) { return marks[key(ep, part)] || (part ? null : marks[ep]) || null; }, _introMarkSet(ep, r, part) { marks[key(ep, part)] = r; }, _introEpNum() { return epNow; }, _introEpPart() { return partNow; }, _introChannel() { return ch; },
            _introCur: null,
            _introUpload(t, s, ep, os, oe, bump, ed, dur, extra) { ups.push({ ep, os, oe, bump, ed, dur, extra: extra ? JSON.parse(JSON.stringify(extra)) : null }); },
        },
    };
};

// 真实 skipManager.check:把一集从头播到 900 秒,记下 dp.seek 和亮过的按钮(开着自动跳过)
const smI0 = HTML.indexOf('window.skipManager = {'), smI1 = HTML.indexOf('\n                                };', smI0);
if (smI0 < 0 || smI1 < 0) { console.log('✗ index.html 里找不到 skipManager 段'); process.exit(1); }
function playCheck(cur, opts = {}) {
    const C = opts.core || makeClient().IntroCore;
    const seeks = [], btn = new Set();
    let ended = 0;
    const video = { duration: 2700, seeking: false, currentTime: 0 };
    const dp = { video, seek(t) { seeks.push(t); video.currentTime = t; }, notice() { }, events: { trigger(e) { if (e === 'ended') ended++; } } };
    const vue = { _introCur: cur, introSkipAuto: opts.auto !== false, introSkipShow: true, introBtn: { show: false }, _introRenderBtn() { if (vue.introBtn.show) btn.add(vue.introBtn.kind); }, _outroNextEp() { return true; } };
    const win = {};
    new Function('window', 'dp', 'console', 'IntroCore', HTML.slice(smI0, smI1) + '\n};').call(vue, win, dp, { log() { } }, C);
    for (let t = 0; t <= (opts.to || 900); t += 0.25) { if (ended) break; if (video.currentTime > t) t = video.currentTime; video.currentTime = t; win.skipManager.check(t); }
    return { seeks, btn: [...btn].sort().join(), ended };
}
// _introOnEpisode 按标记点亮当前集的写法
const curOf = (mk) => makeClient().IntroCore.curOf(mk);

console.log('② 什么标记要重算');
{
    const { IntroCore: C } = makeClient();
    const need = (m) => JSON.parse(JSON.stringify(C.introNeed(m, NOW)));
    ok(JSON.stringify(need(null)) === '{"intro":true}', '没标记:要算,可以冷启动', need(null));
    ok(need({ os: 0, oe: 100, v: 1, src: 'auto' }).intro === true, '旧算法标记(无 mv):要重算');
    ok(need({ os: 0, oe: 100, v: 9, src: 'manual' }).intro === true, '旧 src:manual:和别的旧值一样,要重算');
    ok(need({ os: 0, oe: 0, v: 0, ed: 2000 }).intro === true, '只有片尾:要算片头');
    ok(JSON.stringify(need({ os: 0, oe: 101, mv: 2 })) === '{"intro":false}', '新算法值:不算', need({ os: 0, oe: 101, mv: 2 }));
    ok(JSON.stringify(need({ os: 0, oe: 101, mv: 2, pid: 'p', pend: 1 })) === '{"intro":false}', '待确认的新算法值:不算(确认来自学习对之外的集,不是把这一集再算一遍)');
    ok(need({ os: 0, oe: 100, mv: 2, miss: 1 }).intro === true, '无时间的墓碑不算有值的 mv:2:照常要算');
    ok(need({ os: 0, oe: 0, mv: 2 }).intro === true, 'mv:2 但没有值:要算');
    ok(need({ os: 0, oe: 100, mv: 2, miss: 1, mt: NOW - 864e5 }).intro === false, '定位不中的墓碑:不算');
    const n = need({ os: 0, oe: 0, mv: 2, miss: 2, mt: NOW - 864e5 });
    ok(n.intro && n.noLearn, '学不出的墓碑:有包络才定位,不冷启动', n);
    ok(need({ os: 0, oe: 0, mv: 2, miss: 3, mt: NOW - 864e5 }).intro === false, '学不出且定位也不中的墓碑:不算');
    ok(need({ os: 0, oe: 100, mv: 2, miss: 1, mt: NOW - 31 * 864e5 }).intro === true, '墓碑 30 天后过期,允许重试一次');
    const marks = { '1|r': { miss: 2, mt: NOW }, '2|r': { miss: 3, mt: NOW }, '3|f': { miss: 2, mt: NOW }, '4|r': { miss: 1, mt: NOW }, '5|r': { miss: 2, mt: NOW - 40 * 864e5 } };
    ok(C.learnMissCount(marks, 'r', NOW) === 2, '学不出计数:只数本通道、未过期、kind=2 或 3', C.learnMissCount(marks, 'r', NOW));
    const mp = { ...marks, '6|r|1': { miss: 2, mt: NOW }, '7|f|1': { miss: 2, mt: NOW }, '9|r|3': { miss: 3, mt: NOW }, '8': { miss: 2, mt: NOW } };
    ok(C.learnMissCount(mp, 'r', NOW) === 3, '学不出计数:不带部分的集只数不带部分的,老页面的裸键也算', C.learnMissCount(mp, 'r', NOW));
    ok(C.learnMissCount(mp, 'r', NOW, 1) === 1 && C.learnMissCount(mp, 'r', NOW, 3) === 1 && C.learnMissCount(mp, 'f', NOW, 1) === 1 && C.learnMissCount(mp, 'r', NOW, 2) === 0, '学不出计数:上中下各算各的,下半学不出拦不住上半', [C.learnMissCount(mp, 'r', NOW, 1), C.learnMissCount(mp, 'r', NOW, 3)]);

    // 闸门:片头和贴片同一条
    const G = (c) => [C.opAuto(c), C.bumpAuto(c)].map(Number).join();
    ok(G({ mv: 2, bmv: 3 }) === '1,1', '闸门:mv:2 + bmv:3 片头、贴片都跳');
    ok(G({ mv: 2, bmv: 2 }) === '1,0', '闸门:已确认标记里的 bmv:2 旧贴片:片头跳,贴片只亮按钮(乘风2024 ikun 那种假贴片不能继续跳)');
    ok(G({ mv: 2 }) === '1,0', '闸门:mv:2 的记录上留着旧贴片:片头跳,贴片只亮按钮');
    ok(G({ src: 'afp', bmv: 3 }) === '1,1', '闸门:本机刚定位出来的(src:afp)跳');
    ok(G({ src: 'afp', bmv: 2 }) === '1,0', '闸门:src:afp 也不能带着 bmv:2 的贴片一起跳');
    ok(G({ src: 'afp' }) === '1,0', '闸门:src:afp 不能带着旧贴片一起跳');
    for (const [name, c] of [['旧标记', { os: 0, oe: 100 }], ['旧标记多票', { os: 0, oe: 100, v: 9, bv: 9 }], ['旧 src:manual', { os: 0, oe: 100, src: 'manual', v: 9, bv: 9 }], ['待确认', { mv: 2, bmv: 3, pend: 1 }], ['墓碑留着的旧值', { mv: 2, bmv: 3, miss: 1 }], ['边看边学引擎', { os: 0, oe: 100, ed: 0 }]]) {
        ok(G(c) === '0,0', '闸门:' + name + '不跳', c);
    }
    ok(C.OUTRO_AUTO === false, '片尾自动切集:抽样没过判定线,现在是关的(放开要重新抽样,见 index.html 注释)');
    for (const c of [{ ed: 2000 }, { ed: 2000, ev: 9 }, { ed: 2000, edSrc: 'afp' }, { ed: 2000, emv: 2 }]) ok(C.outroAuto(c) === false, '常量关着:片尾只亮按钮', c);
    {
        // 常量打开:只信带新算法标记的片尾,票数、edSrc 都不算
        const off = coreM[1]; const on = off.replace('const OUTRO_AUTO = false;', 'const OUTRO_AUTO = true;');
        ok(on !== off, '常量在注释说明的位置');
        const cx = vm.createContext({}); vm.runInContext(on + '\n;globalThis.__c = IntroCore;', cx); const CO = cx.__c;
        ok(CO.outroAuto({ ed: 2000, emv: 2 }) === true, '常量打开:带 emv 的片尾自动切');
        for (const c of [{ ed: 2000 }, { ed: 2000, ev: 9 }, { ed: 2000, edSrc: 'afp' }]) ok(CO.outroAuto(c) === false, '常量打开:旧片尾、票数、edSrc 都不算', c);
        let pc = playCheck({ ed: 600, emv: 2 }, { core: CO });
        ok(pc.ended === 1, '常量打开:真实 check() 到点切集', pc);
        pc = playCheck(CO.curOf({ os: 0, oe: 0, ed: 600, emv: 2 }), { core: CO });
        ok(pc.ended === 1, '常量打开:共享标记经 curOf 点亮后也切集(emv 不丢)', pc);
        pc = playCheck({ ed: 600, ev: 9 }, { core: CO });
        ok(pc.ended === 0 && pc.btn === 'outro', '常量打开:旧片尾还是只亮按钮', pc);
        pc = playCheck({ ed: 600, emv: 2 });
        ok(pc.ended === 0 && pc.btn === 'outro', '常量关着:真实 check() 只亮按钮', pc);
    }
    // 按钮不看闸门:有标记就给所有观众显示
    for (const c of [{ os: 100, oe: 200 }, { os: 100, oe: 200, mv: 2, pend: 1 }, { os: 100, oe: 200, mv: 2, miss: 1 }]) {
        const pc = playCheck(c);
        ok(pc.seeks.length === 0 && pc.btn === 'op', '开着自动跳过,不被信任的标记:真实 check() 不 seek,亮按钮', { c, pc });
    }
    {
        const pc = playCheck({ os: 100, oe: 200, mv: 2 });
        ok(pc.seeks.join() === '200', 'mv:2:真实 check() 自动跳', pc);
        const off = playCheck({ os: 100, oe: 200, mv: 2 }, { auto: false });
        ok(off.seeks.length === 0 && off.btn === 'op', '默认关:没开自动跳过的观众只有按钮', off);
    }

    // 边看边学引擎:上报不带 mv;值不被信任
    const m = /_afpLearned\(list, info\) \{([\s\S]*?)\n {16}\},/.exec(HTML);
    ok(!!m, '_afpLearned 在');
    if (m) {
        ok(/this\._introUpload\(info\.title, info\.site, m\.ep, m\.os, m\.oe\);/.test(m[1]), '引擎上报不带 extra(动不了新算法的值)');
        const f = new Function('list', 'info', 'IntroCore', m[1].replace(/\bthis\./g, 'self.'));
        const marksL = { 3: { os: 0, oe: 101.1, mv: 2 }, 4: { os: 0, oe: 100, v: 1, src: 'auto', ed: 2000 } };
        const ups = [];
        globalThis.self = { _introEpNum: () => 4, _introCur: null, _introUpload(...a) { ups.push(a); }, _introMarks: { key: 'T|S', marks: marksL }, _introMarkGet(ep) { return marksL[ep]; }, _introMarkSet(ep, r) { marksL[ep] = r; } };
        f([{ ep: 3, os: 2, oe: 90 }, { ep: 4, os: 2, oe: 90 }], { title: 'T', site: 'S' }, C);
        const engCur = globalThis.self._introCur;
        delete globalThis.self;
        ok(marksL[3].oe === 101.1 && marksL[3].mv === 2, '引擎的旧式值不盖本地新值', marksL[3]);
        ok(marksL[4].oe === 90 && !marksL[4].mv && marksL[4].ed === 2000, '无 mv 的本地行照旧更新,且不带 mv', marksL[4]);
        ok(engCur && !C.opAuto(engCur) && !('src' in engCur) && !('v' in engCur), '引擎学到的当前集:不被信任,只亮按钮', engCur);
    }
    {
        const m2 = /_afpDetected\(os, oe\) \{([\s\S]*?)\n {16}\},/.exec(HTML);
        ok(!!m2, '_afpDetected 在');
        const self = { _introCur: null };
        new Function('os', 'oe', m2[1].replace(/\bthis\./g, 'self.').replace(/^/, 'const self = arguments[2];')).call(null, 10, 90, self);
        ok(self._introCur && self._introCur.oe === 90 && !C.opAuto(self._introCur), '引擎实时检测到的片头:不被信任,只亮按钮', self._introCur);
        const eng = HTML.slice(HTML.indexOf('if (!window.afpEngine) window.afpEngine = {'), i0);
        ok(!/src: 'afp'|edSrc/.test(eng) && !/_introUpload\([^)]*'auto'/.test(eng), '引擎代码里不再写 afp 来源和 src', 0);
        ok(!/edSrc/.test(HTML), '页面里没有 edSrc 了');
    }
    ok(/const introNeed = window\.afpOffline \? window\.afpOffline\._introNeed\(/.test(HTML) && /\(!mk \|\| !mk\.ed \|\| introNeed\.intro\)/.test(HTML), '_introOnEpisode 按 introNeed 决定要不要后台分析');
    for (const [re, name] of [[/src === 'manual'|src==='manual'/, "src==='manual'"], [/\bmk\.v\b|\bcur\.v\b|\bold\.v\b|\bcur\.bv\b|\bcur\.ev\b|\bmk\.bv\b|\bmk\.ev\b|\bold\.bv\b|\bold\.ev\b/, 'v、bv、ev 的读'], [/\b_epNumOf\b/, '_epNumOf']]) {
        ok(!re.test(HTML.slice(i0 - 60000)) || !re.test(HTML.slice(i0, i1)), '页面的片头代码里没有 ' + name);
        ok(!re.test(HTML), '整个页面都没有 ' + name, (HTML.match(re) || [])[0]);
    }
}

console.log('③ 真实 afpOffline');
{
    const o = (vue, ep, part) => ({ vue, title: 'T', site: 'S', ep, part: part || 0 });
    const hit = { pid: 'pa', confirmed: true }, pending = { pid: 'pa' };
    {
        const { A, localStorage } = makeClient();
        const k = makeVue({ '5|r': { os: 0, oe: 100, v: 1, src: 'auto', ed: 2000, ev: 2, bs: 3, be: 8, bv: 2 } });
        A._apply(o(k.vue, 5), 5, 0, 101.1, true, null, hit);
        const rec = k.marks['5|r'];
        ok(rec.oe === 101.1 && rec.mv === 2 && !rec.pend && rec.pid === 'pa' && rec.ed === 2000 && rec.bs === 3 && rec.be === 8, '_apply:本地写 mv:2,片尾和贴片都留着', rec);
        ok(!('v' in rec) && !('src' in rec) && !('bv' in rec), '_apply:本地不留旧票数和 src', rec);
        ok(k.ups[0].oe === 101.1 && k.ups[0].extra.mv === 2 && k.ups[0].extra.pid === 'pa' && !k.ups[0].extra.pend && k.ups[0].bump === null, '_apply:上报带 mv:2 和 pid,没量到贴片就不报贴片', k.ups[0]);
        ok(k.vue._introCur.oe === 101.1 && k.vue._introCur.src === 'afp' && k.vue._introCur.mv === 2 && k.vue._introCur.bs === 3, '_apply:当前集立刻换成新值,旧贴片不丢', k.vue._introCur);
        ok(localStorage.length === 0, '_apply:本地不写别的记录', localStorage.key(0));
    }
    {
        // 新算法值遇到新算法值:本地也保留已有值,不翻来翻去
        const { A } = makeClient();
        const k = makeVue({ '5|r': { os: 0, oe: 101.1, mv: 2, pid: 'pa' } });
        A._apply(o(k.vue, 5), 5, 0, 150, true, null, { pid: 'pb' });
        ok(k.marks['5|r'].oe === 101.1 && k.marks['5|r'].pid === 'pa' && !k.ups.length && !k.vue._introCur, '_apply:已有新算法值:不改不报', k.marks['5|r']);
    }
    {
        // 学习对待确认、学习对之外定位命中才转正,都走真实 check()
        const OP = [205, 262], BP = { bs: 3.2, be: 8.1 };
        const run = (mk, pair, bump = BP, isCur = true) => {
            const { A } = makeClient();
            const k = makeVue(mk ? { '5|r': { ...mk } } : {});
            if (mk) k.vue._introCur = curOf(mk);
            A._apply(o(k.vue, 5), 5, OP[0], OP[1], isCur, bump, pair);
            return { cur: k.vue._introCur, rec: k.marks['5|r'], ups: k.ups, play: playCheck(k.vue._introCur) };
        };
        const oldM = { os: 200, oe: 260, v: 3, src: 'auto', bs: 3, be: 8, bv: 3 };
        // 学习对:包括算出来的这位观众,只亮按钮
        let x = run(null, pending);
        ok(x.rec.pend === 1 && x.rec.pid === 'pa' && x.rec.mv === 2 && x.ups[0].extra.pend === 1 && x.ups[0].extra.pid === 'pa', '学习对:本地和上报都待确认,带 pid', x.rec);
        ok(x.cur.src !== 'afp' && x.play.seeks.length === 0 && x.play.btn === 'bump,op', '学习对:第一位观众也只亮按钮(真实 check() 不 seek)', { cur: x.cur, play: x.play });
        x = run(oldM, pending);
        ok(x.rec.oe === 262 && x.rec.pend === 1 && x.play.seeks.length === 0 && x.play.btn === 'bump,op', '旧标记被学习对重算:换成新值,还是待确认,不跳', { rec: x.rec, play: x.play });
        // 定位命中:本集、贴片都能跳
        x = run(null, hit);
        ok(x.cur.src === 'afp' && !x.rec.pend && !x.ups[0].extra.pend && x.play.seeks.join() === '8.1,262', '学习对之外定位命中:本集自动跳贴片和片头', { cur: x.cur, play: x.play });
        ok(x.rec.bmv === 3 && x.ups[0].extra.bmv === 3 && !('src' in x.rec), '定位命中:src:afp 只活在本会话,缓存里是 mv:2 / bmv:3,上报带 bmv:3', { rec: x.rec, up: x.ups[0] });
        x = run(oldM, hit);
        ok(x.rec.oe === 262 && x.rec.mv === 2 && x.play.seeks.join() === '8.1,262', '旧标记定位命中:重算成 mv:2 后可以自动跳(片头、新贴片)', x.play);
        x = run(oldM, hit, null);
        ok(x.rec.bs === 3 && !x.rec.bmv && x.play.seeks.join() === '262' && x.play.btn === 'bump', '这次没量到贴片:旧贴片留着,只亮按钮,片头照跳', { rec: x.rec, play: x.play });
        x = run({ os: 200, oe: 260, v: 3, src: 'manual' }, hit, null);
        ok(x.rec.oe === 262 && x.rec.mv === 2 && !('src' in x.rec) && x.play.seeks.join() === '262', '旧 src:manual:能被新算法覆盖,没有手动优先', { rec: x.rec, play: x.play });
        x = run({ ...oldM, miss: 1, mv: 2, mt: 1 }, hit);
        ok(!x.rec.miss && !x.rec.mt && x.rec.mv === 2 && x.play.seeks.join() === '8.1,262', '留着旧值的过期墓碑:命中后覆盖墓碑', x.rec);
        x = run(oldM, pending, BP, false);
        ok(x.cur.src !== 'afp' && x.play.seeks.length === 0, '学习对的邻集正好在播:同样只亮按钮', x.cur);
        x = run({ os: 200, oe: 260, v: 1, bs: 3, be: 8, bmv: 3 }, hit);
        ok(x.rec.bs === 3 && x.rec.be === 8 && x.rec.bmv === 3 && x.ups[0].bump === null && !x.ups[0].extra.bmv, '已有新算法贴片:本地保留,不再上报', { rec: x.rec, up: x.ups[0] });
        x = run({ os: 200, oe: 260, v: 1, bs: 3, be: 8, bmv: 2 }, hit);
        ok(x.rec.bs === 3.2 && x.rec.be === 8.1 && x.rec.bmv === 3 && x.ups[0].bump.bs === 3.2 && x.ups[0].extra.bmv === 3, 'bmv:2 的旧贴片:这次量到了就换成新值', { rec: x.rec, up: x.ups[0] });
        x = run({ os: 200, oe: 260, v: 1, bs: 3, be: 8, bmv: 2 }, hit, null);
        ok(x.rec.bs === 3 && x.rec.bmv === 2 && x.play.seeks.join() === '262' && x.play.btn === 'bump', 'bmv:2 的旧贴片:这次没量到,留着只亮按钮,片头照跳', { rec: x.rec, play: x.play });
        // 没版本的旧贴片包络定位出来的(bump.v=2):按旧值算,本地 bmv:2、上报不带 bmv(服务器按 2 存),确认了也只亮按钮;已有 bmv:2/3 的不换
        const BP2 = { ...BP, v: 2 };
        x = run(null, hit, BP2);
        ok(x.rec.bs === 3.2 && x.rec.be === 8.1 && x.rec.bmv === 2 && x.ups[0].bump.bs === 3.2 && !('bmv' in x.ups[0].extra) && x.ups[0].extra.mv === 2, '旧包络定位的贴片:本地 bmv:2,上报不带 bmv', { rec: x.rec, up: x.ups[0] });
        ok(x.cur.src === 'afp' && x.play.seeks.join() === '262' && x.play.btn === 'bump', '旧包络定位的贴片:片头已确认也只亮按钮,片头照跳', { cur: x.cur, play: x.play });
        x = run(oldM, hit, BP2);
        ok(x.rec.bs === 3.2 && x.rec.bmv === 2 && x.play.seeks.join() === '262', '旧包络定位的贴片换掉没版本的旧贴片:还是只亮按钮', { rec: x.rec, play: x.play });
        x = run({ os: 200, oe: 260, v: 1, bs: 3, be: 8, bmv: 2 }, hit, BP2);
        ok(x.rec.bs === 3 && x.rec.bmv === 2 && x.ups[0].bump === null, '旧包络定位的贴片:已有 bmv:2 的不换(同版本不翻来翻去)', { rec: x.rec, up: x.ups[0] });
        x = run({ os: 200, oe: 260, v: 1, bs: 3, be: 8, bmv: 3 }, hit, BP2);
        ok(x.rec.bs === 3 && x.rec.bmv === 3 && x.ups[0].bump === null && x.play.seeks.join() === '8,262', '旧包络定位的贴片:盖不掉 bmv:3', { rec: x.rec, play: x.play });
        x = run(null, pending, BP2);
        ok(x.rec.bmv === 2 && x.rec.pend === 1 && x.play.seeks.length === 0 && x.play.btn === 'bump,op', '旧包络定位的贴片 + 学习对待确认:只亮按钮', x.play);
        x = run(null, hit, { bs: 3, be: 211 });
        ok(!x.rec.be && !x.rec.bmv && x.ups[0].bump === null && !x.ups[0].extra.bmv, '贴片压进片头 5s 以上:不写,不上报(和 server.js 校验同一条)', { rec: x.rec, up: x.ups[0] });
        x = run(null, hit, { bs: 3, be: 210 });
        ok(x.rec.be === 210 && x.ups[0].bump.be === 210, '贴片压进片头正好 5s:还算(和 server.js 同一条)', x.rec);
        // 包络不带 pid:确认不了
        x = run(null, { pid: '', confirmed: false });
        ok(x.rec.pend === 1 && !x.rec.pid && x.play.seeks.length === 0, '包络没有 pid:永远待确认,不跳', x.rec);
        // 确认:同 pid 的本地缓存跟着转正,别的 pid 不动
        const { A } = makeClient();
        const k = makeVue({ '3|r': { os: 0, oe: 90, mv: 2, pid: 'pa', pend: 1 }, '4|r': { os: 0, oe: 90, mv: 2, pid: 'pa', pend: 1 }, '8|r': { os: 0, oe: 90, mv: 2, pid: 'pz', pend: 1 } });
        A._apply(o(k.vue, 5), 5, 0, 90, true, null, hit);
        ok(!k.marks['3|r'].pend && !k.marks['4|r'].pend && k.marks['8|r'].pend === 1 && !k.marks['5|r'].pend, '定位命中:同 pid 的学习对本地缓存转正,别的学习对不动', k.marks);
        ok(playCheck(curOf({ ...k.marks['3|r'], os: 100, oe: 190 })).seeks.join() === '190', '学习对那两集转正后可以自动跳');
        // 学习对的集(别的线路借来定位)再中不是独立证据;包络已被确认过才算
        const { A: A2 } = makeClient();
        const k2 = makeVue({ '6|r': { os: 0, oe: 90, mv: 2, pid: 'pa' } });
        A2._apply(o(k2.vue, 5), 5, 0, 90, true, null, { pid: 'pa', confirmed: false });
        ok(!k2.marks['5|r'].pend && k2.vue._introCur.src === 'afp', '本线路已确认过这条包络:学习对的集定位到也算确认过', k2.marks['5|r']);
    }
    {
        // 上中下各用各的键;当前集判断带部分
        const { A } = makeClient();
        const k = makeVue({ '5|r': { os: 0, oe: 90, v: 1 } }, 'r', 5, 1);
        A._apply(o(k.vue, 5, 1), 5, 10, 100, true, null, hit);
        ok(k.marks['5|r|1'].oe === 100 && k.marks['5|r'].oe === 90 && k.ups[0].extra.part === 1, '第 5 期上:写到带部分的键,上报带部分字段,不碰不带部分的键', k.marks);
        ok(k.vue._introCur && k.vue._introCur.oe === 100, '当前就在看第 5 期上:点亮', k.vue._introCur);
        const k3 = makeVue({}, 'r', 5, 3);
        A._apply(o(k3.vue, 5, 1), 5, 10, 100, true, null, hit);
        ok(!k3.vue._introCur && k3.marks['5|r|1'].oe === 100, '当前在看第 5 期下:上半的结果不点亮下半', k3.vue._introCur);
        A._tomb(o(k3.vue, 6, 1), 6, 1);
        ok(k3.marks['6|r|1'].miss === 1 && k3.ups[k3.ups.length - 1].extra.part === 1, '墓碑也按部分记');
        A._applyOutro(o(k3.vue, 7, 1), 7, 2000, 2700);
        ok(k3.marks['7|r|1'].ed === 2000 && k3.ups[k3.ups.length - 1].extra.part === 1, '片尾也按部分记');
        const k4 = makeVue({});
        A._apply(o(k4.vue, 5), 5, 10, 100, true, null, hit);
        ok(!('part' in k4.ups[0].extra), '不带部分的集:上报没有 part 字段', k4.ups[0]);
    }
    {
        // 片尾带新算法标记,不信任 edSrc
        const { A } = makeClient();
        const k = makeVue({ '5|r': { os: 0, oe: 100, mv: 2, ed: 1900, ev: 9 } });
        A._applyOutro(o(k.vue, 5), 5, 2000, 2700);
        ok(k.marks['5|r'].ed === 2000 && k.marks['5|r'].emv === 2 && !('ev' in k.marks['5|r']) && !('edSrc' in k.marks['5|r']), '片尾:旧值被覆盖,带 emv,不带 ev/edSrc', k.marks['5|r']);
        ok(k.ups[0].extra.emv === 2 && k.ups[0].ed === 2000 && !k.ups[0].extra.mv, '片尾上报带 emv,不带片头的 mv', k.ups[0]);
        ok(k.vue._introCur.emv === 2 && !('edSrc' in k.vue._introCur) && k.vue._introCur.oe === 100 && k.vue._introCur.mv === 2, '当前集:片头字段不丢', k.vue._introCur);
        A._applyOutro(o(k.vue, 5), 5, 2050, 2700);
        ok(k.marks['5|r'].ed === 2000 && k.ups.length === 1, '片尾新算法值遇到新算法值:保留已有值', k.marks['5|r']);
        const k2 = makeVue({ '6|r': { os: 0, oe: 90, v: 1, src: 'manual' } });
        A._tomb(o(k2.vue, 6), 6, 1);
        ok(k2.marks['6|r'].miss === 1 && k2.marks['6|r'].oe === 90 && !('src' in k2.marks['6|r']), '_tomb:旧 src:manual 和别的旧值一样', k2.marks['6|r']);
    }
    {
        const { A } = makeClient();
        const k = makeVue({});
        A._apply(o(k.vue, 5), 5, 0, 241, true, null);
        ok(k.marks['5|r'].miss === 1 && k.marks['5|r'].oe === 0 && k.ups[0].extra.miss === 1 && k.ups[0].extra.mv === 2 && !(k.ups[0].oe > 0), '超 240s:不上报时间,记墓碑(不落回每会话重算)', k.ups[0]);
        const n = JSON.parse(JSON.stringify(A._introNeed(o(k.vue, 5), k.marks['5|r'])));
        ok(n.intro === false, '超限记完墓碑后本集不再分析', n);
    }
    {
        const { A } = makeClient();
        const k = makeVue({ '5|r': { os: 314, oe: 357.5, v: 3, src: 'auto' } });
        A._tomb(o(k.vue, 5), 5, 1);
        ok(k.marks['5|r'].oe === 357.5 && !('v' in k.marks['5|r']) && k.marks['5|r'].miss === 1 && k.ups[0].extra.miss === 1, '_tomb:旧值留着,旧票数不留,同步上报', k.marks['5|r']);
        const k3 = makeVue({ '5|r': { os: 0, oe: 0, v: 0, mv: 2, miss: 2, mt: 1 } });
        A._tomb(o(k3.vue, 5), 5, 1);
        ok(k3.marks['5|r'].miss === 3 && k3.ups[0].extra.miss === 3, '_tomb:学不出的集定位也不中 → 记 3,不再抓', k3.marks['5|r']);
        const k2 = makeVue({ '5|r': { os: 0, oe: 101, mv: 2 } });
        A._tomb(o(k2.vue, 5), 5, 1);
        ok(!k2.marks['5|r'].miss && !k2.ups.length, '_tomb:不盖新算法真值');
    }
    {
        const { A } = makeClient();
        const marks = { '1|r': { miss: 2, mt: Date.now() }, '2|r': { miss: 2, mt: Date.now() }, '3|r': { miss: 2, mt: Date.now() } };
        const k = makeVue(marks);
        const n = JSON.parse(JSON.stringify(A._introNeed(o(k.vue, 7), null)));
        ok(n.intro && n.noLearn, '本线路 ≥3 集学不出:别的集有包络才定位,不再冷启动', n);
        const k3 = makeVue({ '1|r|3': { miss: 2, mt: Date.now() }, '2|r|3': { miss: 2, mt: Date.now() }, '3|r|3': { miss: 2, mt: Date.now() } });
        ok(!A._introNeed(o(k3.vue, 7, 1), null).noLearn && !A._introNeed(o(k3.vue, 7), null).noLearn, '下半 ≥3 集学不出:上半和不带部分的集还能冷启动');
        ok(A._introNeed(o(k3.vue, 7, 3), null).noLearn, '下半 ≥3 集学不出:下半不再冷启动');
    }
    {
        const { A } = makeClient();
        const d = Buffer.from(new Uint8Array(200).fill(9)).toString('base64');
        const od = Buffer.from(new Uint8Array(150).fill(7)).toString('base64');
        let p = A._envParse({ v: 2, d, sec: 20, dur: 20, maxStart: 3, od, odur: 15, bd: od, bdur: 15 });
        ok(p && p.env === null && p.oenv && p.oenv.length === 150 && p.benv && p.benv.length === 150, '旧记录:只作废片头组件,片尾/贴片包络留着(否则多出每集尾部 4 分钟重学)', p && Object.keys(p));
        p = A._envParse({ v: 2, dv: 2, d, sec: 20, dur: 18, maxStart: 3 });
        ok(p && p.env && p.env.length === 200 && p.dur === 18, '新记录:片头组件可用');
        ok(A._envParse({ v: 1, d, sec: 20, dur: 20 }) === null, '记录级版本不对仍作废');
    }
    {
        const { A, localStorage, posts } = makeClient();
        A._envSave({ vue: {}, title: 'T', site: 'S' }, new Float32Array(200).fill(0.5), 20, 3, 18, null, 0, null, 0);
        const rec = JSON.parse(localStorage.getItem('donggua_afpenv|T|S'));
        ok(rec.v === 2 && rec.dv === 2 && rec.dur === 18 && rec.sec === 20, '_envSave:记录级 v 不动,片头带 dv', rec);
        ok(posts[0] && posts[0].body.env.dv === 2 && posts[0].body.env.v === 2, '云备份也带 dv');
        ok(!('ep' in rec) && !('ep' in posts[0].body.env), '包络不带 ep', rec.ep);
        ok(!rec.pid && !posts[0].body.env.pid, '没给学习对:不带 pid');
        A._st['T|P'] = {};
        A._envSave({ vue: {}, title: 'T', site: 'P' }, new Float32Array(200).fill(0.5), 20, 3, 18, null, 0, null, 0, { pid: 'pa', peps: [5, 6], psite: 'L', pk: 'q' });
        const rp = JSON.parse(localStorage.getItem('donggua_afpenv|T|P')), up = posts[posts.length - 1].body.env;
        ok(rp.pid === 'pa' && rp.peps.join() === '5,6' && up.pid === 'pa' && up.peps.join() === '5,6', '学习对的包络:本地和云备份都带 pid、peps', rp.pid);
        ok(rp.psite === 'L' && rp.pk === 'q' && up.psite === 'L' && up.pk === 'q', '学习对的包络:本地和云备份都带学习线路和集号体系,不是当前线路', { rp: rp.psite, up: up.psite });
        const parsed = A._envParse(rp);
        ok(parsed.pid === 'pa' && parsed.peps.join() === '5,6' && parsed.psite === 'L' && parsed.pk === 'q', '_envParse 读出 pid、peps、学习线路、集号体系', parsed.pid);
        const oldRec = A._envParse({ v: 2, d: rp.d, sec: 20, dur: 18, pid: 'pa', peps: [5, 6], psite: 'L', pk: 'q' });
        ok(oldRec.pid === '' && oldRec.psite === '' && oldRec.pk === '', '旧版片头组件(没有 dv)作废,pid、学习线路、集号体系也不读');
        ok(A._envJson({ d: 'x', pid: 'pa' }) !== A._envJson({ d: 'x', pid: 'pb' }), '_envJson:pid 不同算内容不同');
        const filled = A._envFill({ env: null }, { env: new Float32Array(1), pid: 'pb', peps: [1, 2], psite: 'L', pk: 'd', iB: 1 });
        ok(filled.pid === 'pb' && filled.peps.join() === '1,2' && filled.psite === 'L' && filled.pk === 'd', '_envFill:借来的片头带着它的 pid、peps、学习线路、集号体系', filled.pid);
        // 贴片包络版本 bdv:只有学习对用新算法学出来的(pair.bdv=3)才带;没版本的旧包络定位出来只亮按钮
        A._st['T|B'] = {};
        A._envSave({ vue: {}, title: 'T', site: 'B' }, new Float32Array(200).fill(0.5), 20, 3, 18, new Float32Array(80).fill(0.3), 8, null, 0, { pid: 'pa', peps: [5, 6], bdv: 3 });
        const rb = JSON.parse(localStorage.getItem('donggua_afpenv|T|B')), ub = posts[posts.length - 1].body.env;
        ok(rb.bd && rb.bdv === 3 && ub.bd && ub.bdv === 3, '新算法学的贴片包络:本地和云备份都带 bdv:3', { local: rb.bdv, up: ub.bdv });
        ok(A._envParse(rb).bdv === 3 && A._envParse(rb).benv.length === 80, '_envParse 读出 bdv:3');
        A._st['T|B2'] = {};
        A._envSave({ vue: {}, title: 'T', site: 'B2' }, new Float32Array(200).fill(0.5), 20, 3, 18, new Float32Array(80).fill(0.3), 8, null, 0, { pid: 'pa', peps: [5, 6] });
        const rb2 = JSON.parse(localStorage.getItem('donggua_afpenv|T|B2'));
        ok(rb2.bd && !('bdv' in rb2), '没给版本(旧包络转正回传):不带 bdv', rb2.bdv);
        ok(A._envParse({ v: 2, bd: rb.bd, bdur: 8, bdv: 2 }).bdv === 0 && A._envParse({ v: 2, bd: rb.bd, bdur: 8, bdv: '3' }).bdv === 0 && A._envParse({ v: 2, bdur: 8, bdv: 3 }).bdv === 0, '_envParse:bdv 只认数字 3,没有 bd 不算');
        ok(A._envJson({ bd: 'x', bdv: 3 }) !== A._envJson({ bd: 'x' }), '_envJson:bdv 不同算内容不同(旧包络换成新包络要上传)');
        const fb = A._envFill({ env: new Float32Array(1), benv: null }, { benv: new Float32Array(2), bdur: 3, bdv: 3, bB: 1 });
        ok(fb.bdv === 3 && fb.bB === 1 && fb.benv.length === 2, '_envFill:借来的贴片包络带着它的 bdv', fb);
        const fb2 = A._envFill({ env: new Float32Array(1), benv: new Float32Array(3), bdur: 3, bdv: 0 }, { benv: new Float32Array(2), bdur: 3, bdv: 3 });
        ok(fb2.benv.length === 3 && fb2.bdv === 0, '_envFill:本线路已有贴片包络(哪怕没版本)不被借来的换掉', fb2);
    }
    {
        // 云端来的:本线路记录、别的线路借来的、本线路旧版时顺带的,都带学习线路和集号体系
        const d = Buffer.from(new Uint8Array(200).fill(9)).toString('base64');
        const near = await makeClient({ env: { v: 2, dv: 2, d, sec: 20, dur: 18, pid: 'pa', peps: [1, 2], psite: 'L', pk: 'q' }, from: 'S', borrowed: false }).A._envFetchRemote({ vue: {}, title: 'T', site: 'S' });
        ok(near.pid === 'pa' && near.peps.join() === '1,2' && near.psite === 'L' && near.pk === 'q', '云端本线路记录:带 pid、peps、学习线路、集号体系', near.psite);
        const far = await makeClient({ env: { v: 2, dv: 2, d, sec: 20, dur: 18, pid: 'pa', peps: [1, 2], psite: 'L', pk: 'q' }, from: 'L', borrowed: true }).A._envFetchRemote({ vue: {}, title: 'T', site: 'S' });
        ok(far.psite === 'L' && far.pk === 'q' && far.borrowed === true, '云端别的线路的记录:同样带上', far.psite);
        const ib = await makeClient({ env: { v: 2, od: d, odur: 20 }, from: 'S', borrowed: false, introBorrow: { dv: 2, d, sec: 20, dur: 18, maxStart: 3, pid: 'pa', peps: [1, 2], psite: 'L', pk: 'd', from: 'X' } }).A._envFetchRemote({ vue: {}, title: 'T', site: 'S' });
        ok(ib.iB === 1 && ib.pid === 'pa' && ib.peps.join() === '1,2' && ib.psite === 'L' && ib.pk === 'd', '本线路旧版时顺带的新版片头:带 pid、peps、学习线路、集号体系', { pid: ib.pid, psite: ib.psite, pk: ib.pk });
    }
    {
        // 开发期留下的 ep:读进来就丢,也不算内容变化
        const d = Buffer.from(new Uint8Array(200).fill(9)).toString('base64');
        const e1 = makeClient({ env: { v: 2, dv: 2, d, sec: 20, dur: 18, maxStart: 3, ep: 21 }, from: 'S', borrowed: false });
        const s1 = await e1.A._envFetchRemote({ vue: {}, title: 'T', site: 'S' });
        ok(s1 && s1.env && !('ep' in s1), '云端记录里的 ep 不读', s1 && Object.keys(s1));
        const e2 = makeClient({ env: { v: 2, od: d, odur: 20 }, from: 'S', borrowed: false, introBorrow: { dv: 2, d, sec: 20, dur: 18, maxStart: 3, ep: 7, from: 'X' } });
        const s2 = await e2.A._envFetchRemote({ vue: {}, title: 'T', site: 'S' });
        ok(s2 && s2.env && s2.iB === 1 && !('ep' in s2), '云端借来的片头:ep 不读', s2 && Object.keys(s2));
        ok(e1.A._envJson({ d: 'x', ep: 21 }) === e1.A._envJson({ d: 'x', ep: 22 }), '_envJson:ep 不参与内容比较');
    }
    {
        // 本线路有旧版片头 + 片尾,别的线路有新版片头:本地合起来,借来的片头打未验证标
        const { A, localStorage } = makeClient();
        const d = Buffer.from(new Uint8Array(200).fill(9)).toString('base64'), od = Buffer.from(new Uint8Array(150).fill(7)).toString('base64');
        localStorage.setItem('donggua_afpenv|T|S', JSON.stringify({ v: 2, d, sec: 20, dur: 20, od, odur: 15 }));
        localStorage.setItem('donggua_afpenv|T|X', JSON.stringify({ v: 2, dv: 2, d, sec: 20, dur: 19 }));
        const s = A._envTag(A._envLoadAny({ title: 'T', site: 'S' }));
        ok(s.env && s.dur === 19 && s.iB === 1 && s.from === 'X' && s.oenv && !s.oB, '本地借用:片头来自别的线路且未验证,片尾还是本线路的', { iB: s.iB, from: s.from, oB: s.oB });
        localStorage.setItem('donggua_afpenv|T|Y', JSON.stringify({ v: 2, dv: 2, d, sec: 20, dur: 95 }));
        localStorage.setItem('donggua_afpenv|T|Z', JSON.stringify({ v: 2, dv: 2, d, sec: 20, dur: 40 }));
        const s2 = A._envTag(A._envLoadAny({ title: 'T', site: 'S' }));
        ok(s2.dur === 95 && s2.from === 'Y', '本地借用:优先最长的片头包络', { dur: s2.dur, from: s2.from });
    }
}

// ---------- 端到端 ----------
console.log('④ server.js 端到端');
// 接口限流每分钟 60 次,一个服务器跑不完就分开
async function withServer(run) {
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-mark-'));
let srv = null, srvLog = '';
try {
    fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
    fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
    for (const f of ['db.template.json', 'package.json']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    fs.mkdirSync(path.join(tmp, 'public'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'public/index.html'), path.join(tmp, 'public/index.html'));
    fs.writeFileSync(path.join(tmp, 'db.json'), JSON.stringify({ sites: [] }));
    const NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
    const port = 20000 + Math.floor(Math.random() * 20000);
    srv = spawn(process.execPath, ['server.js'], {
        cwd: tmp,
        env: Object.assign({}, process.env, { NODE_PATH, PORT: String(port), CACHE_TYPE: 'memory', ACCESS_PASSWORD: '', ADMIN_TOKEN: '', LIVE_TV_DISABLED: '1', KAZUMI_DISABLE: '1', CORS_PROXY_URL: '', REMOTE_DB_URL: '', TMDB_API_KEY: '', DANMU_API_URL: '', STATS_DISABLE: '1', SITE_URL: '', FAV_CHECK_DISABLE: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', d => { srvLog += d; }); srv.stderr.on('data', d => { srvLog += d; });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { await sleep(100); try { up = (await fetch(base + '/api/debug')).ok; } catch (e) { } }
    if (!up) throw new Error('server did not start:\n' + srvLog.slice(-1200));
    const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => null) }; };
    const get = async (p) => (await fetch(base + p)).json();
    const mark = (ep, os, oe, extra) => post('/api/intro/mark', { title: '测试剧', site: 's1', ep, ch: 'r', op_start: os, op_end: oe, ...(extra || {}) });
    const marks = async (site = 's1') => (await get('/api/intro/marks?title=' + encodeURIComponent('测试剧') + '&site=' + site)).marks;
    await run({ post, get, mark, marks });
} catch (e) {
    fail++; console.log('  ✗ 异常: ' + (e && e.stack || e));
} finally {
    if (srv) { const p = new Promise(r => srv.once('exit', r)); srv.kill(); await Promise.race([p, sleep(3000)]); }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}
}

await withServer(async ({ post, get, mark, marks }) => {
    await mark(1, 0, 100);
    ok((await marks())['1|r'].oe === 100 && !(await marks())['1|r'].mv && !('v' in (await marks())['1|r']), '老页面上报:无 mv,不带票数');
    await mark(1, 0, 101.1, { mv: 2 });
    let m = (await marks())['1|r'];
    ok(m.oe === 101.1 && m.mv === 2 && m.ch === 'r' && !('v' in m), '新页面上报:覆盖不平均', m);
    await mark(1, 0, 100);
    m = (await marks())['1|r'];
    ok(m.oe === 101.1 && m.mv === 2, '老页面再报:动不了', m);
    await mark(1, 3, 150, { mv: 2 });
    m = (await marks())['1|r'];
    ok(m.oe === 101.1 && m.os === 0, '新页面再报:保留已有值,不翻来翻去', m);
    // 请求里写 src:manual 没有任何特权
    for (const [name, body] of [['空位', {}], ['带 mv', { mv: 2 }]]) {
        const ep = name === '空位' ? 2 : 22;
        await mark(ep, 0, 90, { src: 'manual', ...body });
        m = (await marks())[ep + '|r'];
        ok(m.oe === 90 && !('src' in m), name + ' + src:manual:照常写,不存 src', m);
    }
    await mark(2, 0, 101);
    m = (await marks())['2|r'];
    ok(m.oe === 101, 'src:manual 写过的值:不带 mv 也能后写覆盖(没有手动保护)', m);
    await mark(22, 0, 101);
    m = (await marks())['22|r'];
    ok(m.oe === 90 && m.mv === 2, 'src:manual + mv:2 就是普通新算法值', m);
    await mark(23, 0, 101, { mv: 2 });
    await mark(23, 0, 90, { src: 'manual' });
    m = (await marks())['23|r'];
    ok(m.oe === 101 && m.mv === 2 && !('src' in m), 'src:manual 改不动新算法值', m);
    // 片尾 / 贴片跟新旧片头互不影响
    await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 1, ch: 'r', ed_start: 2000 });
    m = (await marks())['1|r'];
    ok(m.ed === 2000 && !m.emv && m.oe === 101.1 && m.mv === 2, '只报片尾:片头值和 mv 不动', m);
    await mark(1, 0.1, 101.2, { mv: 2, bmv: 3, b_start: 1, b_end: 4.5 });
    m = (await marks())['1|r'];
    ok(m.bs === 1 && m.bmv === 3 && m.ed === 2000 && m.oe === 101.1, '片头保留已有值时,贴片、片尾照常合', m);
    // 墓碑
    let r = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 3, ch: 'r', miss: 1 });
    ok(r.status === 400, '不带 mv 的墓碑:拒', r);
    r = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 10, ch: 'r', miss: 3, mv: 2 });
    ok(r.status === 200 && (await marks())['10|r'].miss === 3, 'kind 3 收下', r);
    r = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 3, ch: 'r', miss: 9, mv: 2 });
    ok(r.status === 400, '非法 kind:拒', r);
    await mark(4, 314, 357.5);
    r = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 4, ch: 'r', miss: 1, mv: 2 });
    m = (await marks())['4|r'];
    ok(r.status === 200 && m.miss === 1 && m.oe === 357.5 && m.mt > 0, '墓碑:旧值留着', m);
    await mark(4, 0, 101, { mv: 2 });
    m = (await marks())['4|r'];
    ok(m.oe === 101 && !m.miss && m.mv === 2, '真值到了盖掉墓碑', m);
    r = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 5, ch: 'r', miss: 2, mv: 2 });
    m = (await marks())['5|r'];
    ok(r.status === 200 && m.miss === 2 && m.oe === 0, '空墓碑', m);
    await mark(5, 0, 95);
    m = (await marks())['5|r'];
    ok(m.oe === 0 && m.miss === 2, '老页面上报不解除墓碑', m);
    // 上限
    r = await mark(6, 0, 144.1, { mv: 2 });
    ok(r.status === 200, '144s 长片头收下', r.status);
    r = await mark(7, 0, 240, { mv: 2 });
    ok(r.status === 200, '240s 上限内收下', r.status);
    r = await mark(8, 0, 241, { mv: 2 });
    ok(r.status === 400, '241s 拒', r.status);
    r = await mark(9, 0, 5, { mv: 2 });
    ok(r.status === 400, '太短拒', r.status);

});
await withServer(async ({ post, get }) => {
    let r;
    // 包络
    const b64 = (n, v = 9) => Buffer.from(new Uint8Array(n).fill(v)).toString('base64');
    const envPost = (site, env, title = '测试剧') => post('/api/intro/env', { title, site, env });
    const envGet = (site, dv) => get('/api/intro/env?title=' + encodeURIComponent('测试剧') + '&site=' + site + (dv ? '&dv=2' : ''));
    r = await envPost('e1', { v: 2, d: b64(300, 1), sec: 30, dur: 30, maxStart: 5, od: b64(200, 2), odur: 20 });
    ok(r.status === 200, '老页面传包络', r);
    r = await envPost('e1', { v: 3, d: b64(300, 1), sec: 30, dur: 30 });
    ok(r.status === 400, '记录级版本不对仍拒(版本放在组件上,老校验不动)', r.status);
    r = await envPost('e1', { v: 2, dv: 2, d: b64(1000, 3), sec: 100, dur: 101, maxStart: 5 });
    let e = (await envGet('e1')).env;
    ok(r.status === 200 && e.dv === 2 && e.dur === 101 && e.d === b64(1000, 3) && e.od === b64(200, 2), '新页面传片头:片尾包络留着', { dv: e.dv, dur: e.dur, od: !!e.od });
    r = await envPost('e1', { v: 2, d: b64(300, 4), sec: 30, dur: 30, maxStart: 5, bd: b64(100, 5), bdur: 10 });
    e = (await envGet('e1')).env;
    ok(r.status === 200 && e.dv === 2 && e.d === b64(1000, 3) && e.dur === 101 && e.bd === b64(100, 5), '老页面的片头盖不掉新版片头,但它带来的贴片照收', { dv: e.dv, dur: e.dur, bd: !!e.bd });
    r = await envPost('e1', { v: 2, od: b64(250, 6), odur: 25 });
    e = (await envGet('e1')).env;
    ok(e.od === b64(250, 6) && e.dv === 2 && e.d === b64(1000, 3), '只传片尾:片头组件和 dv 都在');
    // 贴片包络版本 bdv:新算法学的(3)盖得掉没版本的;老页面传来的没版本 bd 盖不掉 bdv:3;不带 bd 的上传留着原来的 bd 和 bdv
    ok(!('bdv' in e) && e.bd === b64(100, 5), '老页面传的贴片包络:不带 bdv', e.bdv);
    r = await envPost('e1', { v: 2, dv: 2, d: b64(1000, 3), sec: 100, dur: 101, maxStart: 5, bd: b64(80, 6), bdur: 8, bdv: 3 });
    e = (await envGet('e1')).env;
    ok(r.status === 200 && e.bd === b64(80, 6) && e.bdur === 8 && e.bdv === 3, '新算法的贴片包络(bdv:3):盖掉没版本的', { bdur: e.bdur, bdv: e.bdv });
    r = await envPost('e1', { v: 2, d: b64(300, 4), sec: 30, dur: 30, maxStart: 5, bd: b64(100, 5), bdur: 10 });
    e = (await envGet('e1')).env;
    ok(e.bd === b64(80, 6) && e.bdur === 8 && e.bdv === 3, '老页面的没版本贴片包络:盖不掉 bdv:3', { bdur: e.bdur, bdv: e.bdv });
    for (const bdv of [2, '3', 9, true]) {
        await envPost('e1', { v: 2, od: b64(250, 6), odur: 25, bd: b64(90, 7), bdur: 9, bdv });
        e = (await envGet('e1')).env;
        ok(e.bd === b64(80, 6) && e.bdv === 3, '乱写的 bdv(' + JSON.stringify(bdv) + '):按没版本算,盖不掉 bdv:3', { bdur: e.bdur, bdv: e.bdv });
    }
    await envPost('e1', { v: 2, od: b64(250, 6), odur: 25 });
    e = (await envGet('e1')).env;
    ok(e.bd === b64(80, 6) && e.bdv === 3, '不带贴片包络的上传:bd 和 bdv 都留着', { bdv: e.bdv });
    await envPost('e1', { v: 2, od: b64(250, 6), odur: 25, bd: b64(70, 8), bdur: 7, bdv: 3 });
    e = (await envGet('e1')).env;
    ok(e.bd === b64(70, 8) && e.bdur === 7 && e.bdv === 3, '新算法的贴片包络:同版本后来的照常换(和以前一样)', { bdur: e.bdur });
    await envPost('e4', { v: 2, od: b64(250, 6), odur: 25, bd: b64(90, 7), bdur: 9 });
    await envPost('e4', { v: 2, od: b64(250, 6), odur: 25 });
    e = (await envGet('e4')).env;
    ok(e.bd === b64(90, 7) && !('bdv' in e), '没版本的 bd:不带 bd 的上传留着它,也不凭空加 bdv', { bdv: e.bdv });
    r = await envPost('e2', { v: 2, d: b64(2000, 7), sec: 200, dur: 200, maxStart: 0, od: b64(200, 8), odur: 20 });
    r = await envPost('e2', { v: 2, dv: 2, d: b64(2300, 7), sec: 230, dur: 240, maxStart: 0 });
    ok(r.status === 200 && (await envGet('e2')).env.dur === 240, '长片头(240s)包络收下', r.status);
    r = await envPost('e2', { v: 2, dv: 2, d: b64(2600, 7), sec: 260, dur: 260, maxStart: 0 });
    ok(r.status === 400 || (await envGet('e2')).env.dur === 240, '超 250s 的 dur 不收');
    // 老页面只有旧 d 的线路
    await envPost('e3', { v: 2, d: b64(300, 1), sec: 30, dur: 30, maxStart: 5, od: b64(200, 2), odur: 20 });
    let g = await envGet('e3');
    ok(g.borrowed === false && !g.env.dv && g.introBorrow === undefined, '老页面(不带 dv):原样拿本线路记录,不多字段', Object.keys(g));
    g = await envGet('e3', true);
    ok(g.borrowed === false && !g.env.dv && g.env.od && g.introBorrow && g.introBorrow.dv === 2 && g.introBorrow.d && ['e1', 'e2'].includes(g.introBorrow.from), '新页面:本线路片尾 + 别的线路新版片头', { from: g.introBorrow && g.introBorrow.from });
    g = await envGet('nope', true);
    ok(g.borrowed === true && g.env.dv === 2, '新页面借用:优先有新版片头的线路', g.from);
    g = await envGet('e1', true);
    ok(g.borrowed === false && g.env.dv === 2 && g.introBorrow === undefined, '本线路已是新版:不再带借用');
    const t2 = encodeURIComponent('只有旧版');
    await post('/api/intro/env', { title: '只有旧版', site: 'x1', env: { v: 2, d: b64(300, 1), sec: 30, dur: 30, od: b64(200, 2), odur: 20 } });
    const ng = await get(`/api/intro/env?title=${t2}&site=x2&dv=2`);
    ok(ng.borrowed === true && !ng.env.dv && ng.env.od, '只有旧版的剧:新页面借到记录,片头被 _envParse 作废,片尾能用');
});

console.log('⑤ 老页面的裸键 / 借用优先长包络');
await withServer(async ({ post, get, marks }) => {
    let r;
    const b64 = (n, v = 9) => Buffer.from(new Uint8Array(n).fill(v)).toString('base64');
    // 裸键(老页面不带 ch):读的时候是每条通道的兜底,ep|ch 一落地就把它遮住,所以写的时候要把内容带过来
    const reader = (M, ep, ch) => M[ep + '|' + ch] || M[ep] || null;
    const bare = (body) => post('/api/intro/mark', { title: '测试剧', site: 'bare', ...body });
    await bare({ ep: 15, op_start: 0, op_end: 96, b_start: 1, b_end: 4.5 });
    await bare({ ep: 15, ed_start: 3800 });
    let bm = (await marks('bare'))['15'];
    ok(bm.oe === 96 && bm.ed === 3800 && bm.be === 4.5 && !bm.mv, '老页面裸键:片头、贴片、片尾都在', bm);
    r = await bare({ ep: 15, ch: 'f', mv: 2, miss: 1 });
    let M = await marks('bare');
    let seen = reader(M, 15, 'f');
    ok(r.status === 200 && seen.oe === 96 && seen.os === 0 && seen.ed === 3800 && seen.be === 4.5 && seen.miss === 1 && seen.mv === 2, '裸键 + 墓碑:片头按钮、贴片、片尾都留着(现状只剩 {oe:0,miss:1})', seen);
    ok(M['15'].oe === 96 && !M['15'].miss, '裸键本身不动(另一条通道还靠它兜底)', M['15']);
    ok(reader(M, 15, 'r').oe === 96 && !reader(M, 15, 'r').miss, '另一条通道读到的还是裸键,没有墓碑', reader(M, 15, 'r'));
    // 新值落到 ep|ch:继承裸键的片尾和贴片(否则旧标记第一次重算后要多抓一遍片尾),片头直接用新值,不和裸键计票
    await bare({ ep: 16, op_start: 0, op_end: 96, b_start: 1, b_end: 4.5 });
    await bare({ ep: 16, ed_start: 3800 });
    r = await bare({ ep: 16, ch: 'f', mv: 2, op_start: 0, op_end: 101.1 });
    M = await marks('bare'); seen = reader(M, 16, 'f');
    ok(seen.oe === 101.1 && seen.mv === 2 && seen.ed === 3800 && seen.be === 4.5 && !seen.bmv && !seen.emv, '裸键 + 新值:片头用新值,片尾和贴片带过来,还是旧值', seen);
    // 老页面上报(带 ch 不带 mv):同样不能把裸键的片尾弄丢;片头走老规则但不和裸键混票(通道都不一定对)
    await bare({ ep: 17, op_start: 0, op_end: 96 });
    await bare({ ep: 17, ed_start: 3800 });
    await bare({ ep: 17, ch: 'r', op_start: 0, op_end: 98 });
    seen = reader(await marks('bare'), 17, 'r');
    ok(seen.oe === 98 && seen.ed === 3800 && !seen.mv, '裸键 + 老页面带 ch 上报:片头用后写的值,片尾留着', seen);
    // 只报片尾(带 ch):片头按钮不能被遮没;片尾早于裸键片头结束的照旧丢掉
    await bare({ ep: 18, op_start: 0, op_end: 96 });
    await bare({ ep: 18, ch: 'r', ed_start: 3800 });
    seen = reader(await marks('bare'), 18, 'r');
    ok(seen.oe === 96 && seen.ed === 3800, '裸键 + 只报片尾:片头按钮还在', seen);
    await bare({ ep: 19, op_start: 0, op_end: 96 });
    r = await bare({ ep: 19, ch: 'r', ed_start: 50 });
    ok(r.status === 400, '只报片尾且早于裸键片头结束:照旧拒', r.status);
    // 旧 src:manual 的裸键:和别的旧值一样,墓碑记得上,新值覆盖得了
    await bare({ ep: 20, src: 'manual', op_start: 0, op_end: 90 });
    await bare({ ep: 20, ch: 'f', mv: 2, miss: 1 });
    seen = reader(await marks('bare'), 20, 'f');
    ok(seen.oe === 90 && seen.miss === 1, 'src:manual 的裸键:墓碑记得上,值留着亮按钮', seen);
    await bare({ ep: 22, src: 'manual', op_start: 0, op_end: 90 });
    await bare({ ep: 22, ch: 'f', mv: 2, op_start: 0, op_end: 101.1 });
    seen = reader(await marks('bare'), 22, 'f');
    ok(seen.oe === 101.1 && seen.mv === 2 && !('src' in seen), 'src:manual 的裸键:新值遮得住', seen);
    // 只有 ep|ch 的老路径不受影响:裸键的存在不改变已有 ep|ch 的合并
    await bare({ ep: 21, op_start: 0, op_end: 96, b_start: 1, b_end: 4.5 });
    await bare({ ep: 21, ch: 'r', mv: 2, op_start: 0, op_end: 101.1 });
    await bare({ ep: 21, ch: 'r', mv: 2, op_start: 0.1, op_end: 101.2 });
    seen = reader(await marks('bare'), 21, 'r');
    ok(seen.oe === 101.1 && seen.be === 4.5, '有了 ep|ch 之后:再报保留已有值,贴片留着', seen);
    // 新版片头里优先借最长的:短包络定位命中也只能跳短的一截,转正后还不会再重算(zy360 的 40s 包络曾把 wujinys 的 100s 片头钉死在 46s)
    await post('/api/intro/env', { title: '长短', site: 'long', env: { v: 2, dv: 2, d: b64(1000, 3), sec: 100, dur: 100, maxStart: 0 } });
    await sleep(5);
    await post('/api/intro/env', { title: '长短', site: 'short', env: { v: 2, dv: 2, d: b64(400, 3), sec: 40, dur: 40, maxStart: 0 } });
    const lg = await get('/api/intro/env?title=' + encodeURIComponent('长短') + '&site=x&dv=2');
    ok(lg.borrowed === true && lg.from === 'long' && lg.env.dur === 100, '借用:优先长包络,不是最新的', { from: lg.from, dur: lg.env && lg.env.dur });
    const lg2 = await get('/api/intro/env?title=' + encodeURIComponent('长短') + '&site=x');
    ok(lg2.from === 'short', '老页面(不带 dv)行为不变:还是最新的', lg2.from);
});

console.log('⑥ 优先级、确认、上中下(服务器)');
await withServer(async ({ post, mark, marks }) => {
    const P = (ep, os, oe, extra) => mark(ep, os, oe, { mv: 2, ...(extra || {}) });
    const both = (bs, be, ed, emv) => ({ b_start: bs, b_end: be, ed_start: ed, ...(emv ? { emv: 2 } : {}) });
    // 片头、贴片、片尾同一次报,反复报:值都不动,没有票数
    let r = await P(1, 200, 260, both(3, 8, 2000, true));
    let m = r.j.mark;
    ok(m.os === 200 && m.bs === 3 && m.bmv === 2 && m.ed === 2000 && m.emv === 2 && !('v' in m) && !('bv' in m) && !('ev' in m), '第一次上报:三样都落值,带新算法标记,不带票数', m);
    for (let i = 0; i < 3; i++) r = await P(1, 200.2 + i, 260.3 + i, both(3.4 + i, 8.4 + i, 2002 + i, true));
    m = r.j.mark;
    ok(m.os === 200 && m.oe === 260 && m.bs === 3 && m.be === 8 && m.ed === 2000, '新算法值连报:字段不漂移', m);
    r = await P(1, 500, 560, both(20, 30, 2300, true));
    m = r.j.mark;
    ok(m.os === 200 && m.bs === 3 && m.ed === 2000, '差得再多:还是保留已有值', m);
    // 新算法值遇到旧值:直接覆盖,不管旧值多少票
    await mark(2, 200, 260, both(3, 8, 2000));
    r = await mark(2, 201, 261, both(4, 9, 2001));
    m = r.j.mark;
    ok(m.os === 201 && m.oe === 261 && m.bs === 4 && m.be === 9 && m.ed === 2001 && !m.mv && !m.bmv && !m.emv && !('v' in m) && !('bv' in m) && !('ev' in m), '不带 mv 连报:后写覆盖,不平均不计票', m);
    r = await P(2, 200.2, 260.3, both(3.2, 8.2, 2005, true));
    m = r.j.mark;
    ok(m.oe === 260.3 && m.mv === 2 && m.be === 8.2 && m.bmv === 2 && m.ed === 2005 && m.emv === 2, '旧值遇到新算法值:三样都直接覆盖', m);
    // 不带 mv 的上报动不了新算法值,不带 emv 的片尾也一样
    r = await mark(2, 300, 360, both(30, 40, 2100));
    m = r.j.mark;
    ok(m.oe === 260.3 && m.mv === 2 && m.be === 8.2 && m.bmv === 2 && m.ed === 2005 && m.emv === 2, '老页面碰到新算法值:三样都动不了', m);
    // 片头是新算法、贴片片尾是旧值:各管各的
    await P(3, 200, 260);
    await mark(3, 201, 261, both(3, 8, 2000));
    m = (await marks())['3|r'];
    ok(m.oe === 260 && m.mv === 2 && m.bs === 3 && !m.bmv && m.ed === 2000 && !m.emv, '片头新算法动不了;空位的贴片、片尾老页面还能写', m);
    await mark(3, 201, 261, both(5, 10, 2010));
    m = (await marks())['3|r'];
    ok(m.bs === 5 && m.ed === 2010, '旧贴片、旧片尾:老页面后写覆盖', m);
    await P(3, 201, 261, both(6, 11, 2020, true));
    m = (await marks())['3|r'];
    ok(m.oe === 260 && m.bs === 6 && m.ed === 2020 && m.emv === 2, '片头保留已有值时,旧贴片、旧片尾照样被新算法覆盖', m);
    // 只报片尾、墓碑夹带片尾
    await mark(4, 200, 260);
    r = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 4, ch: 'r', ed_start: 2002, emv: 2 });
    ok(r.j.mark.ed === 2002 && r.j.mark.emv === 2 && r.j.mark.oe === 260 && !r.j.mark.mv, '只报片尾:片尾带 emv,片头还是旧值', r.j.mark);
    r = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 4, ch: 'r', ed_start: 2050, emv: 2, mv: 2, miss: 1 });
    ok(r.j.mark.ed === 2002 && r.j.mark.miss === 1 && r.j.mark.oe === 260, '墓碑夹带片尾:片尾保留已有值,旧片头留着亮按钮', r.j.mark);
    // 片头的 mv:2 不等于片尾的新算法标记:只有 emv 才算
    r = await P(5, 200, 260, { ed_start: 2000 });
    ok(r.j.mark.ed === 2000 && !r.j.mark.emv && r.j.mark.mv === 2, '上报带 mv:2 不带 emv:片尾还是旧值', r.j.mark);
    // 待确认的贴片经真实路由也落不到已确认的记录上
    await P(6, 200, 260, { pid: 'pair0009' });
    r = await P(6, 200, 260, { pid: 'pair0010', pend: 1, b_start: 3, b_end: 8 });
    ok(!(r.j.mark.be > r.j.mark.bs) && !r.j.mark.pend, '已确认的记录:待确认的上报带来的贴片不收', r.j.mark);
    await P(7, 200, 260, { pid: 'pair0011', pend: 1 });
    r = await P(7, 200, 260, { pid: 'pair0012', b_start: 3, b_end: 8 });
    ok(r.j.mark.bs === 3 && r.j.mark.bmv === 2 && r.j.mark.pend === 1 && r.j.mark.pid === 'pair0011', '待确认的记录:贴片收下,跟着记录一起待确认', r.j.mark);
    // 服务器上没有计票、平均、手动的逻辑了
    const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const i0s = srvSrc.indexOf('// ========== ⏭️ 跳过片头 API'), i1s = srvSrc.indexOf('// ========== 求片 API');
    const route = srvSrc.slice(i0s, i1s);
    ok(!/voteOk|VoteOk|canVote|truthCount|VOTE_MIN_TRUTH|第二票|削票|票池|共识|计票/.test(route), 'intro 路由里没有计票、削票、票池、共识');
    ok(!/manual/.test(route) && !/b\.src\b/.test(route), 'intro 路由不读请求的 src,没有手动分支');
    ok(!/\* w|w \+ 1|\/ \(w/.test(route), 'intro 路由没有加权平均');
    const envI0 = route.indexOf("app.get('/api/intro/env'");
    ok(envI0 > 0 && !/\bep\b/.test(route.slice(envI0)), '/api/intro/env 不再碰 ep');
});
await withServer(async ({ post, get }) => {
    // 包络的 ep:不收;pid/peps 跟着片头组件走
    const b64 = (n, v = 9) => Buffer.from(new Uint8Array(n).fill(v)).toString('base64');
    const envPost = (site, env) => post('/api/intro/env', { title: '测试剧', site, env });
    const envGet = (site) => get('/api/intro/env?title=' + encodeURIComponent('测试剧') + '&site=' + site + '&dv=2');
    await envPost('s1', { v: 2, dv: 2, d: b64(200, 3), sec: 20, dur: 18, maxStart: 3, ep: 5, pid: 'pa11', peps: [5, 6], psite: 'learner', pk: 'q' });
    let e = (await envGet('s1')).env;
    ok(e.d === b64(200, 3) && !('ep' in e) && e.pid === 'pa11' && e.peps.join() === '5,6', '上传:ep 不存,pid、peps 存', Object.keys(e));
    ok(e.psite === 'learner' && e.pk === 'q', '上传:学习线路和集号体系存,不改成上传的线路', { psite: e.psite, pk: e.pk });
    const far = await envGet('s9');
    ok(far.borrowed === true && far.env.pid === 'pa11' && far.env.psite === 'learner' && far.env.pk === 'q', '借别的线路的记录:带学习线路和集号体系', far.env.psite);
    await envPost('s2', { v: 2, od: b64(250, 6), odur: 25 });
    const g = await envGet('s2');
    ok(g.introBorrow && g.introBorrow.dv === 2 && !('ep' in g.introBorrow) && g.introBorrow.pid === 'pa11' && g.introBorrow.peps.join() === '5,6', '借来的片头:带 pid、peps', g.introBorrow && Object.keys(g.introBorrow));
    ok(g.introBorrow.psite === 'learner' && g.introBorrow.pk === 'q', '借来的片头:带学习线路和集号体系', g.introBorrow.psite);
    await envPost('s1', { v: 2, d: b64(300, 4), sec: 30, dur: 30, maxStart: 5 });
    e = (await envGet('s1')).env;
    ok(e.dv === 2 && e.d === b64(200, 3) && e.dur === 18 && e.pid === 'pa11', '老页面的片头盖不掉新版片头,pid 也留着', { dv: e.dv, dur: e.dur, pid: e.pid });
    ok(e.psite === 'learner' && e.pk === 'q', '老页面的片头盖不掉新版片头:学习线路和集号体系也留着', { psite: e.psite, pk: e.pk });
    await envPost('s1', { v: 2, od: b64(250, 6), odur: 25 });
    e = (await envGet('s1')).env;
    ok(e.pid === 'pa11' && e.d === b64(200, 3) && e.od === b64(250, 6), '只传片尾:片头组件和 pid 都在', e.pid);
    ok(e.psite === 'learner' && e.pk === 'q', '只传片尾:学习线路和集号体系都在', { psite: e.psite, pk: e.pk });
    // 换了一条新学习对:新的盖旧的,旧的学习线路不能留下
    await envPost('s6', { v: 2, dv: 2, d: b64(200, 3), sec: 20, dur: 18, pid: 'pb11', peps: [7, 8], psite: 'first', pk: 'q' });
    await envPost('s6', { v: 2, dv: 2, d: b64(200, 5), sec: 20, dur: 18, pid: 'pb22', peps: [9, 10], pk: 'j' });
    e = (await envGet('s6')).env;
    ok(e.pid === 'pb22' && !e.psite && e.pk === 'j', '新学习对盖旧的:旧的学习线路不留下', { pid: e.pid, psite: e.psite, pk: e.pk });
    // 非法值不存,但不影响 pid
    await envPost('s7', { v: 2, dv: 2, d: b64(200, 3), sec: 20, dur: 18, pid: 'pc11', peps: [7, 8], psite: 123, pk: 'x' });
    e = (await envGet('s7')).env;
    ok(e.pid === 'pc11' && !e.psite && !e.pk, '非法学习线路和体系:不存', { psite: e.psite, pk: e.pk });
    await envPost('s8', { v: 2, dv: 2, d: b64(200, 3), sec: 20, dur: 18, pid: 'pc22', peps: [7, 8], psite: 'x'.repeat(41), pk: 'd' });
    e = (await envGet('s8')).env;
    ok(e.pid === 'pc22' && !e.psite && e.pk === 'd', '学习线路超过 40 字:不存', e.psite);
    await envPost('s10', { v: 2, dv: 2, d: b64(200, 3), sec: 20, dur: 18, psite: 'lone', pk: 'j' });
    e = (await envGet('s10')).env;
    ok(!e.pid && !e.psite && !e.pk, '没有 pid:学习线路和体系也不存', { psite: e.psite, pk: e.pk });
    await envPost('s3', { v: 2, dv: 2, d: b64(200, 3), sec: 20, dur: 18, pid: 'BAD ID', peps: [5, 6] });
    e = (await envGet('s3')).env;
    ok(e.d && !e.pid && !e.peps, '非法 pid:不存', e.pid);
    await envPost('s4', { v: 2, dv: 2, d: b64(200, 3), sec: 20, dur: 18, pid: 'pa22', peps: ['x', 6] });
    e = (await envGet('s4')).env;
    ok(e.d && !e.pid && !e.peps, '非法 peps:不存');
    await envPost('s5', { v: 2, d: b64(200, 3), sec: 20, dur: 18, pid: 'pa33', peps: [5, 6] });
    e = (await envGet('s5')).env;
    ok(e.d && !e.pid, '旧版片头(没有 dv)带 pid:不存', e.pid);

});
await withServer(async ({ post, mark, marks }) => {
    let r;
    // 真实 _apply + 真实路由 + 真实 check():第三集确认的全路径
    const send = (u, ep = u.ep) => post('/api/intro/mark', { title: '测试剧', site: 'c1', ep, ch: 'r', ...(u.oe > u.os ? { op_start: u.os, op_end: u.oe } : {}), ...(u.bump ? { b_start: u.bump.bs, b_end: u.bump.be } : {}), ...(u.ed ? { ed_start: u.ed } : {}), ...(u.extra || {}) });
    const cm = async () => (await marks('c1'));
    const viewer = async (ep, os, oe, pair, bump, part) => {
        const { A, IntroCore } = makeClient();
        const server = await cm();
        const k = makeVue(JSON.parse(JSON.stringify(server)), 'r', ep, part || 0);
        const key = ep + '|r' + (part ? '|' + part : '');
        if (server[key]) k.vue._introCur = curOf(server[key]);
        const oo = { vue: k.vue, title: 'T', site: 'S', ep, part: part || 0 };
        const need = JSON.parse(JSON.stringify(A._introNeed(oo, server[key] || null)));
        if (need.intro) A._apply(oo, ep, os, oe, true, bump || null, pair);
        let last = null;
        for (const u of k.ups) last = (await send(u)).j.mark;
        return { need, cur: k.vue._introCur, ups: k.ups, last, play: k.vue._introCur ? playCheck(k.vue._introCur, { core: IntroCore }) : null, local: k.marks };
    };
    const thirdPlay = async (ep) => { const mk = (await cm())[ep + '|r']; return playCheck(curOf(mk)); };
    const A1 = { pid: 'pair0001' }, HIT = { pid: 'pair0001', confirmed: true }, BP = { bs: 3, be: 8 };
    // 观众 1 冷启动学第 5/6 集:两集都待确认,自己也只亮按钮
    let x = await viewer(5, 200, 260, A1, BP);
    ok(x.last.pend === 1 && x.last.pid === 'pair0001' && x.last.mv === 2 && x.play.seeks.length === 0 && x.play.btn === 'bump,op', '学习对第 5 集:待确认,第一位观众也只亮按钮', { last: x.last, play: x.play });
    x = await viewer(6, 300, 360, A1, BP);
    ok(x.last.pend === 1, '学习对第 6 集:待确认', x.last);
    let p5 = await thirdPlay(5);
    ok(p5.seeks.length === 0 && p5.btn === 'bump,op', '后来的观众:第 5 集只亮按钮', p5);
    x = await viewer(5, 200, 260, A1);
    ok(x.need.intro === false && !x.ups.length, '待确认的集:不再分析、不再上报(不增加下载)', x.need);
    // 第 7 集定位不中:只写墓碑,这一对还是待确认(假片头的情况,永远不会被自动跳)
    await post('/api/intro/mark', { title: '测试剧', site: 'c1', ep: 7, ch: 'r', mv: 2, miss: 1 });
    p5 = await thirdPlay(5);
    ok((await cm())['5|r'].pend === 1 && p5.seeks.length === 0, '学习对之外定位不中:学习对还是待确认,不跳', p5);
    // 另一个学习对(第 8/9 集)不能确认第 5/6 集,也确认不了自己
    await viewer(8, 200, 260, { pid: 'pair0002' });
    await viewer(9, 200, 260, { pid: 'pair0002' });
    let M = await cm();
    ok(M['5|r'].pend && M['6|r'].pend && M['8|r'].pend && M['9|r'].pend, '两个学习对凑够 4 集:还是全部待确认', M);
    // 第 10 集用第一对的包络定位命中:命中的这一集和第 5/6 集可以自动跳,第二对不动
    x = await viewer(10, 200, 260, HIT, BP);
    ok(!x.last.pend && x.cur.src === 'afp' && x.play.seeks.join() === '8,260', '学习对之外定位命中:这一集自动跳', { last: x.last, play: x.play });
    M = await cm();
    ok(!M['5|r'].pend && !M['6|r'].pend && M['8|r'].pend && M['9|r'].pend, '第一对转正,第二对不动', M);
    p5 = await thirdPlay(5);
    ok(p5.seeks.join() === '8,260', '第 5 集转正后:后来的观众自动跳片头和贴片', p5);
    ok((await thirdPlay(8)).seeks.length === 0, '第二对:还是只亮按钮');
    // 确认过的包络:学习对的集后来才算到(值丢了/别的通道),直接算确认过
    r = await post('/api/intro/mark', { title: '测试剧', site: 'c1', ep: 5, ch: 'f', op_start: 200, op_end: 260, mv: 2, pid: 'pair0001', pend: 1 });
    ok(!r.j.mark.pend, '包络已被确认:学习对的集再报,不再待确认', r.j.mark);
    // 没确认过的 id:再报还是待确认
    r = await post('/api/intro/mark', { title: '测试剧', site: 'c1', ep: 11, ch: 'r', op_start: 200, op_end: 260, mv: 2, pid: 'pair0002', pend: 1 });
    ok(r.j.mark.pend === 1, '包络没被确认:再多一集学习对的集,也还是待确认', r.j.mark);
    // 跨线路集号写法不同:真实 pairWitness + 真实 _apply + 真实路由 + 真实 check()。ikun 的 20220830(第1期上)借 jisu 第1期上配第2期上的包络命中,其实是学习对同一期
    {
        const { IntroCore } = makeClient();
        const borrowedEnv = { pid: 'pair0004', peps: [1, 2], psite: 'jisu', pk: 'q' }, infoOf = (name) => IntroCore.epInfos([{ name, url: 'u' }])[0];
        const me = infoOf('20220830（第1期上）');
        x = await viewer(me.ep, 60, 87, { pid: borrowedEnv.pid, confirmed: IntroCore.pairWitness(borrowedEnv, me, 'ikun') }, null, me.part);
        ok(x.last.pend === 1 && x.last.pid === 'pair0004' && x.cur.src !== 'afp' && x.play.seeks.length === 0 && x.play.btn === 'op', '借第N期的包络、日期式集号命中:服务器也是待确认,不自动跳', { last: x.last, play: x.play });
        const mid = (await cm())[me.ep + '|r|' + me.part];
        let pc = playCheck(curOf(mid));
        ok(mid.pend === 1 && pc.seeks.length === 0 && pc.btn === 'op', '借第N期的包络、日期式集号命中:后来的观众也只亮按钮', { mid, pc });
        const next = infoOf('20220910（第2期上）');
        x = await viewer(next.ep, 60, 87, { pid: borrowedEnv.pid, confirmed: IntroCore.pairWitness(borrowedEnv, next, 'ikun') }, null, next.part);
        M = await cm();
        ok(x.last.pend === 1 && M[me.ep + '|r|' + me.part].pend === 1, '日期式集号再中一期:还是全部待确认,凑集数确认不了', M[next.ep + '|r|' + next.part]);
        // 同一条线路第N集照常确认(魔道祖师 jisu 第09集借 zy360 第05/06话的包络)
        const tvEnv = { pid: 'pair0005', peps: [31, 32], psite: 'zy360', pk: 'j' };
        await viewer(31, 200, 260, { pid: tvEnv.pid, confirmed: IntroCore.pairWitness(tvEnv, infoOf('第31集'), 'jisu') });
        M = await cm();
        ok(M['31|r'].pend === 1, '第N集:学习对的集号命中,待确认', M['31|r']);
        x = await viewer(33, 200, 260, { pid: tvEnv.pid, confirmed: IntroCore.pairWitness(tvEnv, infoOf('第33集'), 'jisu') });
        M = await cm();
        ok(!x.last.pend && x.cur.src === 'afp' && x.play.seeks.join() === '260' && !M['31|r'].pend, '第N集:学习对之外命中,这一集自动跳,同 id 的跟着转正', { last: x.last, m31: M['31|r'] });
    }
    // 旧标记、旧 src:manual 被定位命中覆盖后可以自动跳;没量到贴片时旧贴片只亮按钮
    await post('/api/intro/mark', { title: '测试剧', site: 'c1', ep: 12, ch: 'r', op_start: 343, op_end: 356, b_start: 3, b_end: 8, src: 'manual' });
    p5 = await thirdPlay(12);
    ok(p5.seeks.length === 0 && p5.btn === 'bump,op', '旧 src:manual:只亮按钮', p5);
    x = await viewer(12, 340, 360, HIT);
    ok(x.need.intro && x.last.oe === 360 && x.last.mv === 2 && !x.last.bmv && x.last.bs === 3, '旧 src:manual 被定位命中覆盖,旧贴片留着', x.last);
    p5 = await thirdPlay(12);
    ok(p5.seeks.join() === '360' && p5.btn === 'bump', '重算成 mv:2:片头自动跳,旧贴片还是只亮按钮', p5);
    // 手里是 15 分钟内旧缓存的观众再算一遍:服务器保留已有值
    await mark(13, 343, 356);
    const stale = (await marks())['13|r'];
    ok(!stale.mv, '旧标记');
    // 非法字段
    r = await post('/api/intro/mark', { title: '测试剧', site: 'c1', ep: 14, ch: 'r', op_start: 1, op_end: 90, mv: 2, pid: 'BAD ID!', pend: 1 });
    ok(!r.j.mark.pid && r.j.mark.pend === 1, '非法 pid:不存,还是待确认', r.j.mark);
    r = await post('/api/intro/mark', { title: '测试剧', site: 'c1', ep: 15, ch: 'r', op_start: 1, op_end: 90, pid: 'pair0003', pend: 1 });
    ok(!r.j.mark.pid && !r.j.mark.pend && !r.j.mark.mv, '不带 mv:pid、pend 都不存', r.j.mark);
});
await withServer(async ({ post, mark, marks }) => {
    // 上中下各用各的键
    const M = () => marks('s1');
    await mark(5, 10, 100, { part: 1, mv: 2 });
    await mark(5, 20, 120, { part: 3, mv: 2 });
    await mark(5, 30, 130, { part: 2, mv: 2 });
    let m = await M();
    ok(m['5|r|1'].oe === 100 && m['5|r|3'].oe === 120 && m['5|r|2'].oe === 130 && !m['5|r'], '同一期的上中下各写各的键', Object.keys(m));
    // 日期式集号占满 8 位也一样
    let r = await mark(20260809, 10, 100, { part: 1, mv: 2 });
    ok(r.status === 200 && (await M())['20260809|r|1'].oe === 100, '日期式集号 + 部分', r.status);
    // 老页面不带这个字段:写普通键,写不到带部分的键上,也写不坏
    await mark(5, 40, 140);
    m = await M();
    ok(m['5|r'].oe === 140 && m['5|r|1'].oe === 100 && m['5|r|3'].oe === 120, '老页面:写 ep|ch,带部分的键不动', Object.keys(m));
    await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 5, op_start: 50, op_end: 150 });
    m = await M();
    ok(m['5'].oe === 150 && m['5|r'].oe === 140 && m['5|r|1'].oe === 100, '老页面裸键:也写不到带部分的键上', Object.keys(m));
    // 带部分的键不从裸键继承:裸键分不清是上半还是下半
    await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 6, op_start: 50, op_end: 150, ed_start: 3000 });
    await mark(6, 10, 100, { part: 1, mv: 2 });
    m = await M();
    ok(!m['6|r|1'].ed && m['6|r|1'].oe === 100, '带部分的键:不继承裸键的片尾', m['6|r|1']);
    await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 6, ch: 'r', part: 1, mv: 2, miss: 1 });
    m = await M();
    ok(!m['6|r|1'].miss, '带部分的键上的新算法值:墓碑盖不掉', m['6|r|1']);
    await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 7, ch: 'r', part: 3, mv: 2, miss: 2 });
    m = await M();
    ok(m['7|r|3'].miss === 2 && !m['7|r'], '墓碑也按部分写', Object.keys(m));
    await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 8, ch: 'r', part: 2, ed_start: 3000, emv: 2 });
    m = await M();
    ok(m['8|r|2'].ed === 3000 && m['8|r|2'].emv === 2 && !m['8|r'], '片尾也按部分写', Object.keys(m));
    // 非法部分:忽略,不进键
    for (const part of [0, 4, -1, '上', 1.5, null]) {
        await mark(9, 10, 100, { part });
        m = await M();
        ok(m['9|r'] && Object.keys(m).filter(k => k.startsWith('9|')).length === 1, '非法部分字段 ' + JSON.stringify(part) + ':按没带处理', Object.keys(m));
    }
    r = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 10, part: 1, op_start: 10, op_end: 100 });
    ok(r.status === 200 && (await M())['10'], '不带通道的部分字段:按老页面裸键处理', r.status);
});

console.log('⑦ 老页面 / 变体集');
await withServer(async ({ post, mark, marks }) => {
    // 老页面(HEAD)的闸门和写法:票数读不到是 1,src 读不到,闸门为假,只亮按钮,不报错
    const oldCur = (mk) => ({ os: mk.os || 0, oe: mk.oe || 0, ed: mk.ed || 0, ev: mk.ev || (mk.ed > 0 ? 1 : 0), edSrc: mk.edSrc || null, src: mk.src, v: mk.v || 1, bs: mk.bs || 0, be: mk.be || 0, bv: mk.bv || 0 });
    const oldGate = (c) => [c.src === 'afp' || (c.bv || 0) >= 2, c.src === 'afp' || (c.v || 0) >= 2, c.edSrc === 'afp' || (c.ev || 0) >= 2];
    await mark(1, 200, 260, { mv: 2, b_start: 3, b_end: 8, ed_start: 2000, emv: 2 });
    await mark(2, 200, 260, { b_start: 3, b_end: 8, ed_start: 2000 });
    await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 3, ch: 'r', mv: 2, miss: 1 });
    await mark(4, 200, 260, { mv: 2, pid: 'pair0001', pend: 1 });
    const M = await marks();
    for (const [k, name] of [['1|r', '新算法值'], ['2|r', '老页面后写的值'], ['3|r', '墓碑'], ['4|r', '待确认']]) {
        const g = oldGate(oldCur(M[k]));
        ok(g.every(x => x === false), '老页面读 ' + name + ':闸门为假,只亮按钮', { k, g });
    }
    // 老页面的引擎判定不报错:没有 v 也能算
    ok((M['1|r'].v || 1) < 3, '老页面 willEngine 判定不报错(v 没有就是 1)');
    // 老页面上报:不报错,也改不动新值
    for (const body of [{ op_start: 201, op_end: 261 }, { op_start: 1, op_end: 90, src: 'manual' }, { ed_start: 2100 }, { op_start: 201, op_end: 261, b_start: 4, b_end: 9, ed_start: 2100 }]) {
        const r = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 1, ch: 'r', src: 'auto', ...body });
        ok(r.status === 200 && r.j.ok === true, '老页面上报不报错', { body, status: r.status });
    }
    const after = (await marks())['1|r'];
    ok(after.os === 200 && after.oe === 260 && after.bs === 3 && after.be === 8 && after.ed === 2000 && after.mv === 2 && after.emv === 2, '老页面改不动新值', after);
    // 贴片升版:老页面(mv:2,不带 bmv)写的算 bmv:2;读的时候不下发 bmv,还开着的老页面也不再自动跳(它按 bmv===2 判);存的不动
    const oldBumpGate = (c) => (c.mv === 2 && !c.miss && !c.pend) && c.bmv === 2;
    let rb = await mark(60, 200, 260, { mv: 2, pid: 'pair0060', b_start: 35.4, b_end: 42.8 });
    ok(rb.j.mark.bs === 35.4 && rb.j.mark.bmv === 2, '老页面上报贴片:存成 bmv:2', rb.j.mark);
    let mb = (await marks())['60|r'];
    ok(mb.bs === 35.4 && mb.be === 42.8 && mb.mv === 2 && !('bmv' in mb) && !oldBumpGate(mb), '读标记:区间留着,不下发 bmv,老页面的闸门为假', mb);
    let pcb = playCheck(curOf(mb));
    ok(pcb.seeks.join() === '260' && pcb.btn === '', '新页面读这条:35.4s 不跳,也不亮(在集首之外);片头照跳', pcb);
    // 新页面的值能覆盖,之后老页面改不动
    rb = await mark(60, 200, 260, { mv: 2, bmv: 3, pid: 'pair0060', b_start: 0, b_end: 16 });
    ok(rb.j.mark.bs === 0 && rb.j.mark.be === 16 && rb.j.mark.bmv === 3 && rb.j.mark.oe === 260, '新页面 bmv:3:覆盖旧贴片,片头不变', rb.j.mark);
    for (const body of [{ mv: 2, b_start: 35, b_end: 42 }, { b_start: 35, b_end: 42 }, { mv: 2, pid: 'pair0060', pend: 1, b_start: 35, b_end: 42 }]) {
        rb = await mark(60, 201, 261, body);
        ok(rb.status === 200 && rb.j.mark.bs === 0 && rb.j.mark.bmv === 3, '老页面改不动 bmv:3', { body, mark: rb.j.mark });
    }
    mb = (await marks())['60|r'];
    ok(mb.bmv === 3 && oldBumpGate(mb) === false, '读标记:bmv:3 下发;老页面闸门为假,只亮按钮', mb);
    pcb = playCheck(curOf(mb));
    ok(pcb.seeks.join() === '16,260', '新页面读这条:贴片、片头都跳', pcb);
    // bmv:3 只认新页面:不带 mv 的上报夹带 bmv:3 不算
    rb = await mark(61, 200, 260, { bmv: 3, b_start: 3, b_end: 8 });
    ok(rb.j.mark.bs === 3 && !rb.j.mark.bmv, '不带 mv 的上报夹带 bmv:3:不算', rb.j.mark);
    rb = await mark(62, 200, 260, { mv: 2, bmv: 9, b_start: 3, b_end: 8 });
    ok(rb.j.mark.bmv === 2, '乱写的 bmv 版本:按老页面算', rb.j.mark);
    // 已确认标记里的 bmv:2:没人重算,也不会变(只亮按钮靠页面);带 pid 的第三集确认不动贴片版本
    await mark(63, 200, 260, { mv: 2, pid: 'pair0063', pend: 1, b_start: 0, b_end: 16 });
    await mark(64, 200, 260, { mv: 2, pid: 'pair0063' });
    mb = await marks();
    ok(!mb['63|r'].pend && !('bmv' in mb['63|r']) && mb['63|r'].bs === 0 && playCheck(curOf(mb['63|r'])).seeks.join() === '260', '旧贴片的学习对转正:片头跳,贴片还是只亮按钮', mb['63|r']);
    // 旧数据的 v/bv/ev 留着不读:没有写接口能造这些字段,但旧行本身不被清理
    const r5 = await post('/api/intro/mark', { title: '测试剧', site: 's1', ep: 5, op_start: 10, op_end: 100, v: 9, bv: 9, ev: 9 });
    ok(r5.status === 200 && !('v' in r5.j.mark), '请求里写 v/bv/ev:不存', r5.j.mark);
});
{
    // 真实 _introOnEpisode:变体集不分析、不套用、不显示按钮;上中下各读各的
    const m = /async _introOnEpisode\(\) \{([\s\S]*?)\n {16}\},\n {16}\/\/ 指纹引擎回调/.exec(HTML);
    ok(!!m, '_introOnEpisode 在');
    const keyM = /_introMarkKey\(ep, part\) \{[^\n]*\n\s*_introMarkGet\(ep, part\) \{[\s\S]*?\n {16}\},\n\s*_introMarkSet\(ep, rec, part\) \{[\s\S]*?\n {16}\},/.exec(HTML);
    ok(!!keyM, '_introMarkGet/_introMarkSet 在');
    const numM = /_introEpNum\(\) \{[\s\S]*?_introEpVariant\(\) \{[\s\S]*?\n {16}\},/.exec(HTML);
    ok(!!numM, '_introEpNum/_introEpPart/_introEpVariant 在');
    const run = async (list, curIdx, marksObj, extra) => {
        const { A, IntroCore } = makeClient();
        const calls = [], eng = { started: 0, stopped: 0 }, logs = [];
        A.learnOrDetect = async (o) => { calls.push(o); };
        const win = { afpOffline: A, afpEngine: { start() { eng.started++; }, stop() { eng.stopped++; } } };
        const methods = new Function('IntroCore', 'return {' + keyM[0] + numM[0] + '};')(IntroCore);
        const v = Object.assign(methods, {
            _liveActive: false, currentGroup: { name: 'T' }, currentSource: { site_key: 'S' }, episodeList: list, currentUrl: list[curIdx].url,
            _introTitleKey: () => 'T', _introChannel: () => 'r', _isKzUrl: () => false, introBtn: { show: false }, _introRenderBtn() { }, _introMarks: { key: 'T|S', at: Date.now(), marks: marksObj }, introSkipShow: true, introSkipAuto: true,
        }, extra || {});
        const body = m[1];
        const fn = new Function('window', 'IntroCore', 'console', 'fetchT', 'return (async function () {' + body + '\n}).call(this);');
        const go = () => fn.call(v, win, IntroCore, { log: (...a) => logs.push(a.join(' ')), warn() { } }, async () => ({ json: async () => ({ marks: marksObj }) }));
        await go();
        return { v, calls, eng, logs, go };
    };
    const url = (i) => 'u:' + i;
    const L = ['第1期上', '第1期下', '第1期纯享版', '第2期上', '第2期下', '先导片'].map((name, i) => ({ name, url: url(i) }));
    const marksObj = { '1|r': { os: 500, oe: 600, v: 9 }, '1|r|1': { os: 10, oe: 100, mv: 2, ed: 2000, emv: 2 }, '1|r|3': { os: 20, oe: 110, mv: 2 }, '1': { os: 700, oe: 800, v: 9 } };
    let r = await run(L, 0, { ...marksObj });
    ok(r.v._introCur && r.v._introCur.oe === 100 && r.v._introEpKey.includes('|1|'), '第1期上:读带部分的键', r.v._introCur);
    ok(r.calls.length === 0 && r.eng.started === 0 && r.eng.stopped === 1, '第1期上:有新算法值不分析;引擎不开(它分不清上下半)', { calls: r.calls.length, eng: r.eng });
    r = await run(L, 1, { ...marksObj });
    ok(r.v._introCur && r.v._introCur.oe === 110, '第1期下:读自己的键,不套用上半', r.v._introCur);
    {
        const a0 = await run(L, 0, { ...marksObj }), a1 = await run(L, 1, { ...marksObj });
        ok(a0.v._introEpKey !== a1.v._introEpKey, '第1期上和第1期下:集键不同,切过去会重取标记', [a0.v._introEpKey, a1.v._introEpKey]);
    }
    r = await run(L, 3, { ...marksObj, '2': { os: 900, oe: 950, v: 9 }, '2|r': { os: 901, oe: 951, mv: 2 } });
    ok(!r.v._introCur && r.calls.length === 1, '第2期上:没有值,不退回裸键和不带部分的键,要分析', r.v._introCur);
    ok(r.eng.started === 0 && r.eng.stopped === 1, '第2期上:边看边学引擎不开(它按集号存录音,分不清上下半)', r.eng);
    for (const i of [2, 5]) {
        r = await run(L, i, { ...marksObj, '6|r': { os: 1, oe: 90, mv: 2 } });
        ok(r.v._introCur === null && r.calls.length === 0 && r.eng.started === 0 && r.eng.stopped === 1 && r.v.introBtn.show === false, L[i].name + ':不分析、不套用、不亮按钮,引擎也停', { cur: r.v._introCur, calls: r.calls.length });
    }
    // 从正片切到同集号的变体:不能因为集键相同就留着正片的标记
    {
        const P2 = ['第1期', '第1期纯享版', '第2期'].map((name, i) => ({ name, url: url(i) }));
        const mk2 = { '1|r': { os: 10, oe: 100, mv: 2 } };
        const a = await run(P2, 0, { ...mk2 });
        ok(a.v._introCur && a.v._introCur.oe === 100, '第1期:有值', a.v._introCur);
        const k0 = a.v._introEpKey;
        const b = await run(P2, 1, { ...mk2 });
        ok(b.v._introEpKey !== k0 && b.v._introCur === null, '第1期纯享版:集键不同,标记清掉', b.v._introEpKey);
    }
    // 普通电视剧:读 ep|ch,再退回裸键
    const D = ['第1集', '第2集', '第3集'].map((name, i) => ({ name, url: url(i) }));
    r = await run(D, 1, { '2': { os: 5, oe: 90, v: 3 } });
    ok(r.v._introCur && r.v._introCur.oe === 90 && !IntroCoreOf().opAuto(r.v._introCur), '电视剧:裸键兜底照旧,旧值只亮按钮', r.v._introCur);
    r = await run(D, 1, { '2|r': { os: 5, oe: 91, mv: 2, miss: 1, mt: Date.now() }, '2': { os: 5, oe: 90, v: 3 } });
    ok(r.v._introCur && r.v._introCur.oe === 91 && r.eng.started === 1, '电视剧:墓碑留着的旧值,引擎还跑(只亮按钮)', r.eng);

    // 判定日志:这集为什么没按钮。变体集三种原因都说清楚
    r = await run(L, 2, { ...marksObj });
    ok(r.logs.length === 1 && /第1集判定: 「第1期纯享版」不当正片\(集名带变体词.*不分析、不套用标记、不显示按钮/.test(r.logs[0]), '变体集:一行判定,说清哪一集、为什么', r.logs);
    r = await run(['第1期', '主题曲', '第2期'].map((name, i) => ({ name, url: url(i) })), 1, {});
    ok(r.logs.length === 1 && /「主题曲」不当正片\(别的集有集号,这集解析不出/.test(r.logs[0]), '解析不出的集:一行判定', r.logs);
    r = await run(['2021-08-12期', '2021-08-12期', '2021-08-13期'].map((name, i) => ({ name, url: url(i) })), 1, {});
    ok(r.logs.length === 1 && /第20210812集判定: 「2021-08-12期」不当正片\(同一集号对应多个地址/.test(r.logs[0]), '同号多地址:一行判定', r.logs);
    // 奇葩说第七季的写法不再当变体:真的走到分析
    r = await run(['第20201217(上)期', '第20201219(下)期', '第20201224(上)期'].map((name, i) => ({ name, url: url(i) })), 0, {});
    ok(r.calls.length === 1 && r.logs.some(s => /第20201217集判定: 共享标记=无 \| 离线分析→启动/.test(s)) && !r.logs.some(s => /不当正片/.test(s)), '第20201217(上)期:是正片,要分析', r.logs);
    // 不分析:判定摘要里说原因
    const offWhy = async (name, re, args, wantCalls = 0) => {
        const x = await run(...args);
        ok(x.calls.length === wantCalls && x.logs.length === 1 && re.test(x.logs[0]), '判定摘要:' + name, x.logs);
    };
    await offWhy('只有一集', /离线分析→不分析\(只有一集/, [D.slice(0, 1), 0, {}]);
    await offWhy('片头片尾都有值', /离线分析→不分析\(片头片尾都有值\)/, [L, 0, { ...marksObj }]);
    await offWhy('待确认也算有值', /片头5→90s\(待确认\).*离线分析→不分析\(片头片尾都有值\)/, [D, 1, { '2|r': { os: 5, oe: 90, mv: 2, pend: 1, ed: 2000 } }]);
    await offWhy('墓碑还有效', /离线分析→不分析\(算不出的墓碑还有效/, [D, 1, { '2|r': { os: 0, oe: 0, mv: 2, miss: 1, mt: Date.now(), ed: 2000 } }]);
    await offWhy('共享标记没拉到', /离线分析→不分析\(共享标记没拉到\)/, [D, 1, {}, { _introMarks: { key: 'T|S', at: Date.now(), marks: {}, failed: true } }]);
    await offWhy('番剧解析地址', /离线分析→不分析\(番剧解析地址拉不了\)/, [D, 1, {}, { _isKzUrl: () => true }]);
    await offWhy('要分析', /离线分析→启动\(缺片头\+片尾\)/, [D, 1, {}], 1);
    // 当前地址不在列表里:没有集键,说一次(canplay 会重复进来)
    r = await run(D, 1, {}, { currentUrl: 'u:x' });
    ok(r.v._introCur === null && r.calls.length === 0 && r.logs.length === 1 && /判定: 当前地址不在选集列表里,不分析、不显示按钮/.test(r.logs[0]), '不在列表里:一行判定', r.logs);
    await r.go();
    ok(r.logs.length === 1, '不在列表里:同一地址重复进来不再说', r.logs);
}
{
    // README 和 OUTRO_AUTO 注释与现状一致
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    ok(!/投票|至少 2 票|被佐证|片尾直接下一集|直接叫「下一集」/.test(readme), 'README:不再写投票和片尾直接下一集');
    const sec = /### 跳过片头片尾\r\n([\s\S]*?)\r\n### /.exec(readme);
    ok(!!sec && /只信已确认的新算法标记/.test(sec[1]) && /默认关/.test(sec[1]) && /片尾只亮按钮/.test(sec[1]) && /「跳过按钮」/.test(sec[1]), 'README:写明按钮、默认关、只信已确认的新算法标记、片尾只亮按钮');
    ok(/\| 自动跳过片头\/片尾 \| 关 \| [^|\r\n]*片尾还是显示按钮 \|/.test(readme), 'README 设置表:片尾还是显示按钮');
    ok(!/(^|[^\r])\n/.test(readme), 'README:还是纯 CRLF');
    const outro = HTML.slice(HTML.indexOf('// 片尾自动切下一集的总开关'), HTML.indexOf('const OUTRO_AUTO = false;'));
    ok(/魔道祖师/.test(outro) && /司藤/.test(outro) && /狂飙 yzzy/.test(outro), 'OUTRO_AUTO 注释:抽样写全魔道祖师、司藤、狂飙 yzzy', outro.length);
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
