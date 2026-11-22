#!/usr/bin/env node
// [adult] 内容政策 / 分类体系 离线测试(零网络):
//   node scripts/adult-policy-test.mjs
// 覆盖:lib/adult 入口接口、加载即校验(taxonomy.json 缺失/坏 JSON/结构坏/规则被削弱 → require 抛错 = 服务器拒绝启动)、
//   分类名回归(fixtures/adult/categories.json:调研判定的 67 个硬拦分类名全部仍拦、审查级默认值、大类映射)、
//   buildClassMap(父分类继承硬拦与审查级、CK百货 pidFix/aggregateParents、混合站主流判定)、
//   条目级金丝雀(fixtures/adult/canaries.json:换脸/年级与出生年份/迷奸/点名大学生曝光/偷拍/人兽 必拦;
//   无码流出、液体"流出"、可信番号日本片里的"学生" 等长得像的必须放行)、checkQuery、filterItems、RULES_VERSION。
// 改 lib/adult/* 任何规则后必跑。失败退出码非 0。
// 金丝雀全部是合成标题,不得放入任何真人姓名。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'lib/adult');
const A = require(LIB);
const FIX = path.join(ROOT, 'scripts/fixtures/adult');
const CATS = JSON.parse(fs.readFileSync(path.join(FIX, 'categories.json'), 'utf8'));
const CAN = JSON.parse(fs.readFileSync(path.join(FIX, 'canaries.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) pass++;
    else { fail++; failures.push(name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

// ============ 1. 接口 ============
{
    eq(Object.keys(A).sort(), ['RULES_VERSION', 'policy', 'taxonomy', 'title'], 'index: 导出 {policy, taxonomy, title, RULES_VERSION}');
    for (const f of ['checkQuery', 'checkItem', 'filterItems']) ok(typeof A.policy[f] === 'function', 'policy.' + f);
    for (const f of ['classify', 'buildClassMap']) ok(typeof A.taxonomy[f] === 'function', 'taxonomy.' + f);
    for (const f of ['parseTitle', 'codeOk', 'searchVariants', 'workKey']) ok(typeof A.title[f] === 'function', 'title.' + f);
    ok(typeof A.RULES_VERSION === 'string' && /^p\d+-\d{4}-\d{2}-\d{2}-[0-9a-f]{10}$/.test(A.RULES_VERSION), 'RULES_VERSION 形如 p1-<taxonomy版本>-<哈希>', A.RULES_VERSION);
    eq(A.RULES_VERSION, A.policy.RULES_VERSION, 'index.RULES_VERSION === policy.RULES_VERSION');
    const B = A.taxonomy.BUCKETS;
    eq(B.filter((b) => b.nav).length, 17, 'BUCKETS: 17 个导航大类');
    for (const id of ['mixed', 'uncat', 'x_mainstream', 'x_nonvideo', 'x_container']) ok(B.some((b) => b.id === id && !b.nav), 'BUCKETS: 隐藏大类 ' + id);
    ok(B.every((b) => typeof b.id === 'string' && typeof b.label === 'string' && typeof b.nav === 'boolean'), 'BUCKETS: {id,label,nav}');
}

// ============ 2. 加载即校验(fail-closed) ============
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adult-policy-test-'));
    const files = fs.readdirSync(LIB).filter((f) => /\.(js|json)$/.test(f));
    const good = fs.readFileSync(path.join(LIB, 'taxonomy.json'), 'utf8');
    let n = 0;
    function loadWith(mutate) {
        const dir = path.join(tmp, 'c' + (n++));
        fs.mkdirSync(dir);
        for (const f of files) fs.copyFileSync(path.join(LIB, f), path.join(dir, f));
        mutate(dir);
        try { require(path.join(dir, 'index.js')); return null; } catch (e) { return e; }
    }
    const tj = (dir, fn) => { const j = JSON.parse(good); fn(j); fs.writeFileSync(path.join(dir, 'taxonomy.json'), JSON.stringify(j)); };
    ok(loadWith(() => {}) === null, '加载: 原样拷贝可以加载');
    ok(loadWith((d) => fs.unlinkSync(path.join(d, 'taxonomy.json'))) instanceof Error, '加载: taxonomy.json 缺失 → 抛错');
    ok(loadWith((d) => fs.writeFileSync(path.join(d, 'taxonomy.json'), good.slice(0, 500))) instanceof Error, '加载: JSON 截断 → 抛错');
    ok(loadWith((d) => fs.writeFileSync(path.join(d, 'taxonomy.json'), '[]')) instanceof Error, '加载: 不是对象 → 抛错');
    ok(loadWith((d) => tj(d, (j) => { j.blockPolicy = []; j.block = []; })) instanceof Error, '加载: blockPolicy 清空 → 抛错');
    ok(loadWith((d) => tj(d, (j) => { j.blockPolicy[0].match = 'zzzz'; j.block[0] = 'zzzz'; })) instanceof Error, '加载: 未成年规则被削弱(金丝雀没拦住) → 抛错');
    ok(loadWith((d) => tj(d, (j) => { j.blockPolicy[1].match = 'zzzz'; j.block[1] = 'zzzz'; })) instanceof Error, '加载: 偷拍规则被削弱 → 抛错');
    ok(loadWith((d) => tj(d, (j) => { j.blockPolicy[4].match = 'zzzz'; j.block[4] = 'zzzz'; })) instanceof Error, '加载: 泄露规则被削弱 → 抛错');
    ok(loadWith((d) => tj(d, (j) => { j.blockPolicy[0].match = '(unclosed'; j.block[0] = '(unclosed'; })) instanceof Error, '加载: 正则编译失败 → 抛错');
    ok(loadWith((d) => tj(d, (j) => { j.block[2] = 'x'; })) instanceof Error, '加载: block 与 blockPolicy 不一致 → 抛错');
    ok(loadWith((d) => tj(d, (j) => { j.rules[5].bucket = 'nope'; })) instanceof Error, '加载: 规则指向不存在的大类 → 抛错');
    ok(loadWith((d) => tj(d, (j) => { j.buckets = j.buckets.filter((b) => b.id !== 'western'); })) instanceof Error, '加载: 导航大类少了一个 → 抛错');
    ok(loadWith((d) => tj(d, (j) => { j.reviewPolicy[0].default = 'maybe'; })) instanceof Error, '加载: 审查级默认值非法 → 抛错');
    // RULES_VERSION 跟着规则内容变
    {
        const dir = path.join(tmp, 'v');
        fs.mkdirSync(dir);
        for (const f of files) fs.copyFileSync(path.join(LIB, f), path.join(dir, f));
        tj(dir, (j) => { j.tagRules[0].match += '|测试词'; });
        const B2 = require(path.join(dir, 'index.js'));
        ok(B2.RULES_VERSION !== A.RULES_VERSION && B2.RULES_VERSION.startsWith(A.policy.POLICY_REV + '-'), 'RULES_VERSION: 改规则自动变', [A.RULES_VERSION, B2.RULES_VERSION]);
        // CRLF 检出与 LF 一样
        const dir2 = path.join(tmp, 'crlf');
        fs.mkdirSync(dir2);
        for (const f of files) fs.writeFileSync(path.join(dir2, f), fs.readFileSync(path.join(LIB, f), 'utf8').replace(/\r?\n/g, '\r\n'));
        eq(require(path.join(dir2, 'index.js')).RULES_VERSION, A.RULES_VERSION, 'RULES_VERSION: CRLF 检出不影响');
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 清不掉也不影响结果 */ }
}

// ============ 3. 分类名回归(调研判定) ============
{
    const C = A.taxonomy.classify;
    let lost = [];
    for (const [n, p] of CATS.blocked) if (!C(n, p).block) lost.push(n + (p ? '<' + p : ''));
    eq(lost, [], `分类: 调研判定的 ${CATS.blocked.length} 个硬拦分类名全部仍拦`);
    let bad = [];
    for (const [n, p, lvl] of CATS.review) { const r = C(n, p); if (r.block) continue; if (r.review !== lvl) bad.push([n, p, lvl, r.review]); }
    eq(bad, [], `分类: ${CATS.review.length} 个审查级分类名默认值(hide/code/filter)`);
    bad = [];
    for (const [n, p, b] of CATS.buckets) { const r = C(n, p); if (r.bucket !== b || r.block) bad.push([n, p, b, r.bucket]); }
    eq(bad, [], `分类: ${CATS.buckets.length} 个常见分类名大类映射`);
    // 关键单例
    ok(!C('无码流出').block && C('无码流出').bucket === 'jp_uncensored', '分类: 无码流出 不拦,进日本无码');
    ok(C('网红流出').block, '分类: 网红流出 拦');
    ok(C('A I 换脸').block && C('AI換臉').block, '分类: 空白拆字 / 繁体 也拦');
    ok(C('明星換臉').block, '分类: 繁体 明星換臉');
    ok(C('重口味', '变态暗网').block && !C('重口味').block, '分类: 重口味 只在 变态暗网 父分类下拦');
    eq(C('强奸乱伦').review, 'code', '分类: 强奸乱伦 → code');
    eq(C('学生少女').review, 'hide', '分类: 学生少女 → hide');
    eq(C('91探花').review, 'filter', '分类: 91探花 → filter');
    eq(C('AI短剧').review, 'filter', '分类: AI短剧 → filter');
    eq(C('留学生').review, null, '分类: 留学生 不算 学生');
    eq(C('日本', '学生校园').review, 'hide', '分类: 父分类审查级继承(更严)');
    eq(C('短剧', '', 'mixed').bucket, 'x_mainstream', '分类: 混合站的 短剧 = 主流');
    eq(C('动漫', '', { siteKind: 'mixed' }).bucket, 'x_mainstream', '分类: 混合站的 动漫 = 主流');
    eq(C('动漫').bucket, 'anime', '分类: 成人站的 动漫 = 动漫·里番');
    const u = C('一个没见过的新分类名');
    ok(u.bucket === 'uncat' && u.unmapped === true && !u.block, '分类: 未知名字 → uncat + unmapped', u);
    eq(C('').bucket, 'uncat', '分类: 空名字 → uncat');
    ok(Array.isArray(C('巨乳人妻').tags) && C('巨乳人妻').tags.includes('milf') && C('巨乳人妻').tags.includes('busty'), '分类: 主题标签', C('巨乳人妻').tags);
    ok(C('麻豆传媒').tags.includes('studio'), '分类: 规则自带标签 studio');
}

// ============ 4. buildClassMap ============
{
    const M = A.taxonomy.buildClassMap;
    const m = M([
        { type_id: 1, type_name: '变态暗网', type_pid: 0 },
        { type_id: 2, type_name: '重口味', type_pid: 1 },
        { type_id: 3, type_name: '学生校园', type_pid: 0 },
        { type_id: 4, type_name: '日本', type_pid: 3 },
        { type_id: '5', type_name: '国产自拍', type_pid: '0' },
        { type_id: 6, type_name: '吃瓜资讯', type_pid: 0 },
        { type_id: 7, type_name: '海外', type_pid: 6 },
        { type_id: 8, type_name: '其他', type_pid: 7 },
    ]);
    ok(m instanceof Map && m.size === 8, 'classMap: Map,数字键');
    ok(m.get(2).block && m.get(2).parentName === '变态暗网', 'classMap: 父分类硬拦继承', m.get(2));
    eq(m.get(4).review, 'hide', 'classMap: 父分类审查级继承');
    eq(m.get(5).bucket, 'cn_amateur', 'classMap: 字符串 id 也认');
    ok(m.get(1).container && m.get(3).container && !m.get(5).container, 'classMap: 有子分类的是容器');
    ok(m.get(8).block, 'classMap: 祖父分类硬拦也继承', m.get(8));
    // 也认 sites.json 的 {id,name,pid}
    eq(M([{ id: 9, name: 'AI换脸', pid: 0 }]).get(9).block, true, 'classMap: {id,name,pid} 形状');
    // CK百货:列表全是 pid=0,但 46/80 实为父分类(会返回子分类条目)
    const ck = M([
        { type_id: 46, type_name: '制服诱惑', type_pid: 0 },
        { type_id: 47, type_name: 'JK少女', type_pid: 0 },
        { type_id: 48, type_name: '黑丝', type_pid: 0 },
    ], { host: 'https://www.ckbh1.xyz/api.php/provide/vod' });
    ok(ck.get(46).container, 'classMap: CK百货 aggregateParents → 46 是容器(爬虫不能 &t=46)');
    ok(ck.get(47).block && ck.get(47).parentName === '制服诱惑', 'classMap: CK百货 pidFix 生效 + JK少女 拦', ck.get(47));
    eq(ck.get(48).parentName, '制服诱惑', 'classMap: CK百货 pidFix 48→46');
    const mixed = M([{ type_id: 1, type_name: '电视剧' }, { type_id: 2, type_name: '综艺' }, { type_id: 3, type_name: '纪录片' }, { type_id: 4, type_name: '动漫' }, { type_id: 5, type_name: '成人' }]);
    eq(mixed.get(4).bucket, 'x_mainstream', 'classMap: 混合站(≥3 个主流分类)自动判定');
    eq(A.taxonomy.siteKindOf([{ type_name: '电视剧' }, { type_name: '综艺' }, { type_name: '纪录片' }]), 'mixed', 'siteKindOf: mixed');
    eq(M(null).size, 0, 'classMap: 坏输入不抛');
    eq(M([null, { type_name: 'x' }, { type_id: 'abc' }]).size, 0, 'classMap: 坏行跳过');
}

// ============ 5. 条目级金丝雀 ============
{
    const chk = A.policy.checkItem;
    for (const c of CAN.block) {
        const r = chk(c.item, c.ctx || {});
        ok(!r.ok && String(r.reason).startsWith(c.want), '必拦: ' + c.item.vod_name + ' [' + c.item.type_name + ']', { got: r.reason, want: c.want });
    }
    for (const c of CAN.allow) {
        const r = chk(c.item, c.ctx || {});
        ok(r.ok, '放行: ' + c.item.vod_name + ' [' + c.item.type_name + ']', r);
    }
    // 返回形状
    const r = chk({ vod_name: 'SSIS-301 测试', type_name: '日本有码' });
    ok(r.ok === true && r.bucket === 'jp_censored' && Array.isArray(r.tags) && r.review === null, 'checkItem: 放行形状 {ok,bucket,tags,review}', r);
    ok(r.code && r.code.key === 'SSIS-301' && r.code.ok === true, 'checkItem: 附带番号信息', r.code);
    const rb = chk({ vod_name: 'x', type_name: '自拍偷拍' });
    ok(rb.ok === false && typeof rb.reason === 'string' && rb.bucket && Array.isArray(rb.tags), 'checkItem: 拦截形状 {ok:false,reason,bucket,tags,review}', rb);
    // ctx.cls 直接用 buildClassMap 的行
    const cls = A.taxonomy.buildClassMap([{ type_id: 1, type_name: '变态暗网' }, { type_id: 2, type_name: '日本', type_pid: 1 }]).get(2);
    ok(!chk({ vod_name: '正常标题', type_name: '日本' }, { cls }).ok, 'checkItem: ctx.cls(带父分类硬拦)生效');
    ok(chk({ vod_name: '正常标题', type_name: '日本' }).ok, 'checkItem: 不给 ctx 时只按自身分类名');
    // 所有文本字段都查
    for (const f of ['vod_sub', 'vod_content', 'vod_blurb', 'vod_tag', 'vod_class', 'vod_remarks', 'vod_actor', 'vod_director']) {
        const it = { vod_name: '正常标题', type_name: '国产视频' };
        it[f] = '某某偷拍合集';
        ok(!chk(it).ok, 'checkItem: 字段 ' + f + ' 也查硬拦词');
    }
    ok(!chk({ vod_name: '正常', type_name: '国产视频', vod_content: '<p>某某&#20599;拍</p>' }).ok, 'checkItem: HTML 标签与实体先解码');
    ok(!chk({ vod_name: '國產偷窺', type_name: '国产视频' }).ok, 'checkItem: 繁体硬拦词');
    ok(chk({ vod_name: '正常标题', type_name: '三级伦理', vod_content: '她的女儿考上大学后离家,一家人的故事' }).ok, 'checkItem: 审查词只看标签性字段,剧情简介里的 女儿/大学 不藏');
    // 坏输入
    eq(chk(null).ok, false, 'checkItem: null → 不放行(fail-closed)');
    eq(chk('SSIS-001').ok, false, 'checkItem: 非对象 → 不放行');
    ok(typeof chk({ vod_name: 12345, type_name: null, vod_tag: ['a', 'b'] }).ok === 'boolean', 'checkItem: 非字符串字段不抛');
    const t1 = Date.now();
    eq(chk({ vod_name: '正常', type_name: '国产视频', vod_content: 'x'.repeat(50000) + '偷拍' }).ok, false, 'checkItem: 简介前面塞 5 万字填充也拦得住');
    ok(Date.now() - t1 < 500, 'checkItem: 超长简介不慢', Date.now() - t1);
}

// ============ 6. checkQuery ============
{
    for (const q of CAN.queries.block) ok(A.policy.checkQuery(q) === true, 'checkQuery 拦: ' + q);
    for (const q of CAN.queries.allow) ok(A.policy.checkQuery(q) === false, 'checkQuery 放: ' + JSON.stringify(q));
    ok(A.policy.checkQuery(null) === false && A.policy.checkQuery(undefined) === false, 'checkQuery: 空值不拦不抛');
    ok(A.policy.checkQuery('萝 莉') && A.policy.checkQuery('蘿莉') && A.policy.checkQuery('ＬＯＬＩ'), 'checkQuery: 空白/繁体/全角');
}

// ============ 7. filterItems ============
{
    const items = [
        { vod_name: 'SSIS-401 测试', type_name: '日本有码' },
        { vod_name: '某某偷拍', type_name: '国产视频' },
        { vod_name: '正常', type_name: '自拍偷拍' },
        { vod_name: '真实强奸', type_name: '强奸乱伦' },
        { vod_name: '人妻温泉', type_name: '人妻熟女' },
    ];
    eq(A.policy.filterItems(items).map((x) => x.vod_name), ['SSIS-401 测试', '人妻温泉'], 'filterItems: 留下放行的');
    eq(A.policy.filterItems(items, (it) => (it.vod_name === '人妻温泉' ? { parentName: '变态暗网' } : {})).map((x) => x.vod_name), ['SSIS-401 测试'], 'filterItems: ctxFn 生效');
    eq(A.policy.filterItems(items, () => { throw new Error('x'); }), [], 'filterItems: ctxFn 抛错 = 不放行');
    eq(A.policy.filterItems(null), [], 'filterItems: 坏输入');
}

// ============ 8. 性能 ============
{
    const t0 = Date.now();
    for (let i = 0; i < 3000; i++) A.policy.checkItem({ vod_name: `SSIS-${100 + (i % 800)} 某作品标题第${i}集 中文字幕`, type_name: i % 2 ? '日本有码' : '国产自拍', vod_content: '一段普通的简介文字'.repeat(20) });
    const ms = Date.now() - t0;
    ok(ms < 3000, 'perf: 3000 次 checkItem < 3s', ms);
}

console.log(`adult-policy-test: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  FAIL ' + f); process.exit(1); }
