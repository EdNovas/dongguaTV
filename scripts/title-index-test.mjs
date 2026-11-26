// 片名索引(lib/title-index)自测:假资源站(进程内 httpGet),不联网
// node scripts/title-index-test.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const { createTitleIndex, norm, NOSEARCH_RE } = require('../lib/title-index');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));

// ---------- 假资源站 ----------
function makeSite(names, { search = false, perPage = 3 } = {}) {
    const s = { list: names.map((n, i) => ({ vod_id: 1000 + i, vod_name: n, type_name: '国产剧', vod_time: '2026-11-20 10:00:00' })), recent: [], perPage, search, calls: [], down: false };
    s.handle = (url) => {
        s.calls.push(url);
        if (s.down) throw new Error('timeout of 15000ms exceeded');
        const u = new URL(url);
        const p = u.searchParams;
        if (p.get('wd') != null) {
            if (!s.search) return '暂不支持搜索';
            return JSON.stringify({ code: 1, list: s.list.filter((v) => v.vod_name.includes(p.get('wd'))) });
        }
        const src = p.get('h') ? s.recent : s.list.slice().reverse();   // 列表新的在前
        const pc = Math.max(1, Math.ceil(src.length / s.perPage));
        const pg = Number(p.get('pg') || 1);
        const list = src.slice((pg - 1) * s.perPage, pg * s.perPage);
        return JSON.stringify({ code: 1, page: pg, pagecount: pc, limit: s.perPage, total: src.length, list });
    };
    return s;
}
const A = makeSite(['庆余年', '庆余年 第二季', '繁花', '狂飙', '人世间', '漫长的季节', '三体', '长相思', '莲花楼', '我的阿勒泰']);
const B = makeSite(['甲', '乙'], { search: true });
const C = makeSite(['丙']); C.down = true;
const HOSTS = { 'a.test': A, 'b.test': B, 'c.test': C };
const httpGet = async (url) => { const h = new URL(url).host; const s = HOSTS[h]; if (!s) throw new Error('ENOTFOUND'); return s.handle(url); };

let SITES = [
    { key: 'sa', name: '站A', api: 'https://a.test/api.php/provide/vod' },
    { key: 'sb', name: '站B', api: 'https://b.test/api.php/provide/vod' },
    { key: 'sc', name: '站C', api: 'https://c.test/api.php/provide/vod' },
];
let T = 1_800_000_000_000;
const now = () => T;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidx-'));
const dbFile = path.join(dir, 'ti.db');
const OPTS = { firstDelayMs: 1e9, tickMs: 1e9, pageGapMs: 0, pagesPerTick: 2, sitesPerTick: 3 };
let ti = createTitleIndex({ dbFile, sites: () => SITES, httpGet, now, opts: OPTS });

console.log('1. 归一化 / 正则');
eq(norm(' 庆余年 第二季！'), '庆余年第二季', '去空格标点');
eq(norm('ＡＢＣ　One'), 'abcone', '全角转半角 + 小写');
ok(NOSEARCH_RE.test('暂不支持搜索'), '「暂不支持搜索」');
ok(NOSEARCH_RE.test('err not serarch'), '奶香香的拼错');
ok(!NOSEARCH_RE.test('<!DOCTYPE html>'), '网页不算');
{
    // 茅台式:JSON 里说禁止关键词搜索
    const M = { handle: (u) => (new URL(u).searchParams.get('wd') != null ? JSON.stringify({ code: 1002, msg: 'Current API forbids keyword search.' }) : JSON.stringify({ code: 1, page: 1, pagecount: 1, total: 1, list: [{ vod_id: 1, vod_name: '茅台片' }] })) };
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tidx-m-'));
    const t2 = createTitleIndex({ dbFile: path.join(d2, 'm.db'), sites: () => [{ key: 'mt', name: '茅台', api: 'https://m.test/api.php/provide/vod' }], httpGet: async (u) => M.handle(u), opts: { firstDelayMs: 1e9, tickMs: 1e9, pageGapMs: 0 } });
    await t2.tick();
    eq(t2.status().sites[0].mode, 'nosearch', 'JSON「forbids keyword search」也算关了搜索');
    t2.stop(); fs.rmSync(d2, { recursive: true, force: true });
}

console.log('2. 探测 + 全量(每轮 2 页,断点续爬)');
await ti.tick();
let st = ti.status();
const byKey = (k) => st.sites.find((s) => s.key === k);
eq(byKey('sa').mode, 'nosearch', '站A 判为关了搜索');
eq(byKey('sb').mode, 'ok', '站B 搜索正常');
eq(byKey('sc').mode, 'unknown', '站C 打不开 = 未确认');
ok(byKey('sa').rows > 0 && !byKey('sa').full_done, '一轮只爬 2 页,还没完');
ok(!B.calls.some((u) => /ac=list&pg=/.test(u)), '搜索正常的站不爬');
ok(ti.useFor(SITES[0]) && !ti.useFor(SITES[1]) && !ti.useFor(SITES[2]), 'useFor 只对站A');
// 中途重启:新实例从 pg−1 续
ti.stop();
ti = createTitleIndex({ dbFile, sites: () => SITES, httpGet, now, opts: OPTS });
for (let i = 0; i < 4; i++) await ti.tick();
st = ti.status();
ok(byKey('sa').full_done > 0, '重启后续爬完成');
eq(byKey('sa').rows, 10, '10 条全收(重复页不重复计)');
eq(byKey('sa').total, 10, '记下资源站总数');

console.log('3. 查询(worker 线程)');
eq(await ti.lookup('sa', '庆余年'), ['1000', '1001'], '完全一致排第一');
eq(await ti.lookup('sa', '庆余年第二季'), ['1001'], '查询词去空格也能命中「庆余年 第二季」');
eq(await ti.lookup('sa', '阿勒泰'), ['1009'], '子串命中');
eq(await ti.lookup('sa', '不存在的片'), [], '没有');
eq(await ti.lookup('sb', '甲'), [], '没建索引的站查不到');
ok(ti.status().worker === 'thread', '查询走了 worker 线程');
eq(ti.sample('sa', '花', 5).map((r) => r.name), ['繁花', '莲花楼'], '后台试搜:按长度排');

console.log('4. 增量(6 小时后 ?h=)');
A.recent = [{ vod_id: 2000, vod_name: '新片上线', type_name: '国产剧', vod_time: '2026-11-27 10:00:00' }];
A.list.push(A.recent[0]);
T += 7 * 3600e3;
await ti.tick();
ok(A.calls.some((u) => /ac=list&h=\d+&pg=1/.test(u)), '发了 ?h= 增量请求');
eq(await ti.lookup('sa', '新片上线'), ['2000'], '增量收进来的新片能查到(查询缓存已作废)');

console.log('5. 失败退避 + 后台操作');
A.down = true; T += 7 * 3600e3;
await ti.tick();
st = ti.status();
ok(byKey('sa').fails === 1 && byKey('sa').next_at > T, '失败记次数 + 退避');
ok(ti.useFor(SITES[0]), '失败期间旧索引照常用');
A.down = false;
await ti.action('retry', 'sa'); await new Promise((r) => setTimeout(r, 80));
st = ti.status();
eq(byKey('sa').fails, 0, '立刻重试后成功清零');
await ti.action('pause', 'sa');
ok(!ti.useFor(SITES[0]), '暂停后不走索引');
await ti.action('resume', 'sa');
await ti.action('force-index', 'sb');
st = ti.status();
eq(byKey('sb').mode, 'nosearch', '强制走索引');
await ti.action('auto', 'sb');
await ti.action('clear', 'sa');
eq(await ti.lookup('sa', '庆余年'), [], '清空后查不到');
ok(!ti.useFor(SITES[0]), '清空后不走索引(回退正常搜索)');

console.log('6. db.json 写 search 字段 / 换 API 地址');
SITES = SITES.map((s) => (s.key === 'sb' ? Object.assign({}, s, { search: false }) : s));
await ti.tick(); await ti.tick();
ok(ti.useFor(SITES[1]), 'search:false 强制给站B 建索引');
SITES = SITES.map((s) => (s.key === 'sb' ? Object.assign({}, s, { api: 'https://b.test/api2.php/provide/vod' }) : s));
await ti.tick();
st = ti.status();
ok(byKey('sb').api.includes('api2') && byKey('sb').rows <= 2, '换了 API 地址 → 清空重来');

console.log('7. 搜索恢复了 → 自动清掉索引');
SITES = [SITES[0]];
await ti.action('rebuild', 'sa'); for (let i = 0; i < 6; i++) await ti.tick();
ok(ti.useFor(SITES[0]), '重建后可用');
A.search = true; T += 25 * 3600e3;
await ti.tick();
ok(!ti.useFor(SITES[0]) && ti.status().sites.find((s) => s.key === 'sa').mode === 'ok', '探测到搜索恢复 → 不再走索引');

ti.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
