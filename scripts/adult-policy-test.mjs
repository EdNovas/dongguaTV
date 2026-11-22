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
    eq(Object.keys(A).sort(), ['RULES_VERSION', 'policy', 'tags', 'taxonomy', 'title'], 'index: 导出 {policy, taxonomy, title, tags, RULES_VERSION}');   // [adult] phase 3:+tags
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
    // p7:睡眠 / 媚药 题材从审查级 code 升成硬拦 drugging —— 原来期望 review:code 的样例现在拦得更严也算对(只认这一种升级)
    for (const c of CAN.block) {
        const r = chk(c.item, c.ctx || {});
        ok(!r.ok && (String(r.reason).startsWith(c.want)), '必拦: ' + c.item.vod_name + ' [' + c.item.type_name + ']', { got: r.reason, want: c.want });
    }
    // p7:下药 / 失去意识题材(与 AVDB Aphrodisiac / Sleeping / Coma 同口径)硬拦;简介里的剧情叙述(趁丈夫熟睡 / 重伤昏迷)不拦
    for (const [n, tn] of [['媚药调教美少女', '国产传媒'], ['睡奸熟睡的继母', '日本有码'], ['TMW-083 变身密药', '国产传媒'], ['某某春药实验', '国产自拍'], ['夜袭寡妇', '国产传媒'],
        ['趁老婆睡着', '国产自拍'], ['ABCD-105 媚薬で痙攣', '日本有码'], ['ABCD-106 寝込みを襲う', '日本有码'], ['Sleeping Stepsister', '欧美'], ['She Fell Asleep On The Couch', '欧美'], ['Aphrodisiac Massage', '欧美']]) {
        const r = chk({ vod_name: n, type_name: tn }, {});
        ok(!r.ok && r.reason === 'item:drugging', 'p7 必拦 drugging: ' + n, r.reason);
    }
    ok(chk({ vod_name: '某某睡奸', type_name: '国产传媒', vod_tag: '' }, {}).reason === 'item:drugging' && chk({ vod_name: '普通标题', type_name: '国产传媒', vod_tag: '熟睡,人妻' }, {}).reason === 'item:drugging', 'p7:标签字段里的 熟睡 也拦');
    {
        const r = chk({ vod_name: 'ABCD-201 普通の人妻', type_name: '日本有码', vod_content: '趁丈夫熟睡后出门,公公重伤昏迷住院' }, {});
        ok(r.ok, 'p7:简介里的 熟睡 / 昏迷 剧情叙述不拦(只查标签性字段)', r);
    }
    for (const n of ['Sleeping Bag Adventure', '秘书的诱惑', '神秘人妻', '美女午睡']) ok(chk({ vod_name: n, type_name: '国产自拍' }, {}).reason !== 'item:drugging', 'p7 不误拦为 drugging: ' + n);
    for (const q of ['媚药', '春药', '睡奸', '熟睡', '夜袭', 'asleep', 'aphrodisiac']) ok(A.policy.checkQuery(q) === true, 'p7 搜索词拦: ' + q);
    ok(A.policy.checkQuery('秘书') === false && A.policy.checkQuery('人妻 睡衣') === false, 'p7 搜索词不误拦(秘书 / 睡衣)');
    // p8(第四阶段复核):外力致昏 / 饮料加料 / 嗑药 / 昏迷 的同义说法硬拦(标签性字段);紧跟性行为的失去意识 → 审查级 code;比喻(被金钱砸晕)不拦
    for (const [n, tn] of [['一对夫妇在上班途中被跟踪闯入家中并被打晕 荡妇妻子喷水', '日本有码'], ['被打晕后侵犯', '国产自拍'], ['把隔壁女大学生弄昏当作性处理对象', '日本有码'],
        ['女教师下班水杯中加料晕倒', '国产自拍'], ['ABCD-107 欢迎会上晕倒了被同事带回家', '日本有码'], ['ABCD-108 失去意识后被强', '日本有码'], ['公司团建少妇醉酒不省人事', '国产自拍'],
        ['被灌醉后干到不省人事', '国产自拍'], ['人妻遭伏击 昏厥锁喉', '日本有码'], ['夜店嗑药3p', '国产自拍'], ['被下兴奋剂发情', '日本有码'], ['趁她意识不清醒时上了她', '国产自拍']]) {
        const r = chk({ vod_name: n, type_name: tn }, {});
        ok(!r.ok && r.reason === 'item:drugging', 'p8 必拦 drugging: ' + n, r.reason);
    }
    for (const n of ['被操到高潮晕倒好几次', '酒店客房内射长发美女被操到神志不清', '痉挛高潮到失去意识']) {
        const r = chk({ vod_name: n, type_name: '国产自拍' }, {});
        ok(!r.ok && r.reason === 'review:code' && r.review === 'code', 'p8 性行为导致的失去意识 = 审查级 code(没可信番号就藏): ' + n, r);
    }
    {
        const r = chk({ vod_name: 'SSIS-305 高潮到失去意识', type_name: '日本有码' }, {});
        ok(r.ok && r.review === 'code', 'p8 可信番号的 高潮到失去意识:放行但审查级 code(不做精选)', r);
    }
    for (const n of ['极品女大学生被金钱砸晕', '小主播被礼物砸晕', '差点被西瓜奶敲晕', '打飞机', '晕车的美女', '普通人妻']) {
        const r = chk({ vod_name: n, type_name: '国产自拍' }, {});
        ok(r.reason !== 'item:drugging', 'p8 不误拦为 drugging: ' + n, r.reason);
    }
    ok(chk({ vod_name: 'ABCD-202 普通の人妻', type_name: '日本有码', vod_content: '丈夫被人打晕后她独自出门' }, {}).ok, 'p8:简介里的 打晕 剧情叙述不拦(只查标签性字段)');
    for (const q of ['打晕', '被打晕', '晕倒', '不省人事', '嗑药']) ok(A.policy.checkQuery(q) === true, 'p8 搜索词拦: ' + q);
    ok(A.policy.checkQuery('操到晕倒') === false && A.policy.checkQuery('晕车') === false, 'p8 搜索词不误拦(性行为导致 / 晕车)');
    // p8:reviewTagHints —— 乱伦框架片名补 incest 审查级标签(只会更不露出)
    const H = A.policy.reviewTagHints;
    ok(typeof H === 'function', 'policy.reviewTagHints 存在');
    for (const n of ['一小时打桩内射妈妈', '小姨欲望好强', '表姐替女友满足我', '我妹的秘密', '继妹用脚诱惑我', '骚姐姐想吃弟弟的大鸡巴', '坏公公偷看媳妇', 'ABCD-109 義母と二人きり'])
        ok(JSON.stringify(H({ vod_name: n })) === '["incest"]', 'p8 reviewTagHints → incest: ' + n, H({ vod_name: n }));
    for (const n of ['隔壁姐姐', '小姐姐自慰', '我刚来完姨妈下面特别紧', '大姨妈期间', '被小哥哥操的小妹妹', '普通人妻', '继续努力'])
        ok(JSON.stringify(H({ vod_name: n })) === '[]', 'p8 reviewTagHints 不误标: ' + n, H({ vod_name: n }));
    ok(JSON.stringify(H({ vod_name: '普通标题', vod_content: '内射妈妈' })) === '[]' && JSON.stringify(H(null)) === '[]', 'p8 reviewTagHints 只看标签性字段;坏输入 → []');
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
    // p6:leet 写法折一遍再查;番号/分辨率/厂牌这类字母数字混写的正常查询不受影响
    for (const q of ['l0li', 'L0LI', '10li', 'lo1i', 'sh0ta', 'ch1ld', 'k1ds', 'j4ilbait', 'l0li collection']) ok(A.policy.checkQuery(q) === true, 'checkQuery p6 leet 拦: ' + q);
    for (const q of ['SSIS-001', 'ssis001', '300MIUM-1402', 'FC2-PPV-1234567', 'MD0315', '1080p', '4k', 'S1', 'HEYZO-1234', '1PON-100626_001', 'x264', '3p', 'm1lf', '0nlyfans', 'tokyo hot n1234', '1pondo'])
        ok(A.policy.checkQuery(q) === false, 'checkQuery p6 leet 放: ' + q);
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

// ============ 9. 严格站 ctx.strict(p5,爱播 s51 这类大杂烩站) ============
{
    const chk = A.policy.checkItem;
    const S = { strict: true };
    // 金丝雀:fixtures canaries.json 的 strict 组(严格站专用,普通站入库测试不用这一组)
    ok(CAN.strict && CAN.strict.block.length >= 10 && CAN.strict.allow.length >= 5, 'strict: 金丝雀组存在', CAN.strict && [CAN.strict.block.length, CAN.strict.allow.length]);
    for (const c of CAN.strict.block) {
        const r = chk(c.item, Object.assign({}, c.ctx || {}, S));
        ok(!r.ok && String(r.reason).startsWith(c.want), '严格站必拦: ' + c.item.vod_name + ' [' + c.item.type_name + '/' + (c.item.vod_class || '') + ']', { got: r.reason, want: c.want });
    }
    for (const c of CAN.strict.allow) {
        const r = chk(c.item, Object.assign({}, c.ctx || {}, S));
        ok(r.ok, '严格站放行: ' + c.item.vod_name, r);
    }
    // 普通站的必拦金丝雀在严格站也必拦(严格站只会更严)
    let looser = [];
    for (const c of CAN.block) { const r = chk(c.item, Object.assign({}, c.ctx || {}, S)); if (r.ok) looser.push(c.item.vod_name); }
    eq(looser, [], 'strict: 普通站必拦的严格站也拦');
    // 只认严格的 true
    const leakish = { vod_name: '95后小嫩模私拍狂欢夜', type_name: '爱播资源' };
    ok(chk(leakish).ok && chk(leakish, { strict: 'yes' }).ok && chk(leakish, { strict: 1 }).ok, 'strict: 不是 true 就不算严格站', chk(leakish, { strict: 'yes' }));
    eq(chk(leakish, S).reason, 'item:leak', 'strict: 同一条在严格站被拦');
    // S6 大杂烩分类按 vod_class 定大类、并上标签;非严格站不动
    const short = { vod_name: '这妹子太主动了', type_name: '爱播资源', vod_class: '抖阴短片,抖阴短' };
    eq(chk(short).bucket, 'uncat', 'strict: 非严格站大杂烩仍是 uncat(爱播资源 只是站点级大杂烩名)');
    eq(chk(short, S).bucket, 'short', 'strict: 严格站按 vod_class 定大类');
    const jp = chk({ vod_name: 'HODV-21995 某某', type_name: '爱播资源', vod_class: '强奸乱伦,日本有码' }, S);
    ok(jp.ok && jp.bucket === 'jp_censored' && jp.review === 'code' && jp.tags.length > 0, 'strict: 第一个能导航的 token 定大类,审查级与标签并进来', jp);
    ok(chk({ vod_name: '某某', type_name: '视频二区', vod_class: '国产精品' }, S).review === 'filter', 'strict: 审查级至少是 filter');
    // S4 番号放回上游分类重判;codeOk 字段给调用方用
    const cnJav = { vod_name: 'SSIS-505 普通の人妻', type_name: '爱播资源', vod_class: '国产主播' };
    ok(chk(cnJav).ok && chk(cnJav).codeOk === true, 'strict: 非严格站 codeOk=true(只看 type_name)', chk(cnJav));
    const r4 = chk(cnJav, S);
    ok(r4.ok && r4.codeOk === false && r4.code && r4.code.ok === false, 'strict: 国产 vod_class 里的日本番号 codeOk=false', r4);
    ok(chk(cnJav, Object.assign({ codeOk: true }, S)).codeOk === false, 'strict: 调用方传 codeOk:true 也会被降级');
    // S1 vod_class 是数组 / 超多 token 也不抛;token 太多 = hide
    ok(!chk({ vod_name: 'x', type_name: '爱播资源', vod_class: ['国产精品', '偷拍偷窥'] }, S).ok, 'strict: vod_class 数组也查');
    eq(chk({ vod_name: '某某', type_name: '爱播资源', vod_class: Array.from({ length: 90 }, (_, i) => '标签' + i).join(',') }, S).reason, 'review:hide', 'strict: token 超过 80 个 = 不认识 = 藏');
    // S7 只对国产类;日本片真简介放行
    const prose = '她叫小某,某地本地人,身高一米六八,皮肤白皙,今天穿着黑色蕾丝内裤等着你来。镜头前她缓缓抬起一条腿,眼神迷离地看着镜头';
    eq(chk({ vod_name: '某某巨乳 爆操', type_name: '爱播资源', vod_class: '国产主播', vod_content: prose }, S).reason, 'item:strict', 'strict: 国产类 AI 叙述简介');
    ok(chk({ vod_name: '某某巨乳 爆操', type_name: '爱播资源', vod_class: '国产主播', vod_content: '某某巨乳 爆操' }, S).ok, 'strict: 简介=片名 不算叙述');
    ok(chk({ vod_name: '某某巨乳 爆操', type_name: '爱播资源', vod_class: '国产主播', vod_content: prose }).ok, 'strict: 非严格站不做 S7');
    // 性能
    const t0 = Date.now();
    for (let i = 0; i < 3000; i++) chk({ vod_name: `某作品标题第${i}集 中文字幕`, type_name: '爱播资源', vod_class: i % 2 ? '国产精品,主播直播' : '强奸乱伦', vod_tag: '高清AV,麻豆傳媒,素人', vod_content: '一段普通的简介文字'.repeat(20) }, S);
    ok(Date.now() - t0 < 3000, 'perf: 3000 次严格站 checkItem < 3s', Date.now() - t0);
}

// ============ 10. 站长追加屏蔽词 setExtraBlock(第四阶段:只会更严、永远放松不了内置规则) ============
{
    const P = A.policy;
    for (const f of ['setExtraBlock', 'extraBlock', 'rulesKey', 'extraHit']) ok(typeof P[f] === 'function', 'policy.' + f);
    eq(P.extraBlock(), { words: [], n: 0, rev: '' }, 'extra: 默认没有追加词');
    eq(P.rulesKey(), A.RULES_VERSION, 'extra: 没追加词时 rulesKey() === RULES_VERSION');
    const reasons = (list) => list.map((c) => P.checkItem(c.item, c.ctx || {}).reason || 'ok');
    const blockBefore = reasons(CAN.block), allowBefore = reasons(CAN.allow);
    const qs = ['迷奸', '人妻 温泉', 'SSIS-001 流出', 'l0li', '某某 合成', 'foo bar baz'];
    const qBefore = qs.map((q) => P.checkQuery(q));
    // 归一化和内置规则同一套:繁简 / 全半角 / 空白标点;纯字母数字按词边界
    const x = P.setExtraBlock(['合成屏蔽词', '  Foo Bar  ', '合成屏蔽詞', 'ＺＺ９']);
    eq([x.n, x.words], [3, ['合成屏蔽词', 'Foo Bar', 'ＺＺ９']], 'extra: 去重(繁简归一后同一个词只留一个)、保留原写法');
    ok(/^[0-9a-f]{8}$/.test(x.rev) && P.rulesKey() === A.RULES_VERSION + '+x' + x.rev, 'extra: rulesKey = RULES_VERSION + "+x" + 词表哈希', P.rulesKey());
    ok(P.checkQuery('某某合成屏蔽词某某') && P.checkQuery('合 成 屏-蔽 词') && P.checkQuery('合成屏蔽詞') && P.checkQuery('foo-bar') && P.checkQuery('FOOBAR clips') && P.checkQuery('Foo  Bar') && P.checkQuery('zz9'),
        'extra: 查询命中(子串 / 拆字 / 繁体 / 词边界 / 粘连 / 全角)');
    ok(!P.checkQuery('foobarbaz') && !P.checkQuery('xfoo bar') && !P.checkQuery('zz90') && !P.checkQuery('人妻 温泉'), 'extra: 英文词不跨词边界误中;别的查询不受影响');
    eq(P.checkItem({ vod_name: '某合成作品 合成屏蔽词', type_name: '国产自拍' }).reason, 'item:admin', 'extra: 片名命中 → item:admin');
    eq(P.checkItem({ vod_name: '某合成作品', type_name: '国产自拍', vod_tag: 'Foo Bar' }).reason, 'item:admin', 'extra: 标签字段命中 → item:admin');
    eq(P.checkItem({ vod_name: '某合成作品', type_name: '国产自拍', vod_remarks: 'zz9' }).reason, 'item:admin', 'extra: 备注命中 → item:admin');
    ok(P.checkItem({ vod_name: '某合成作品', type_name: '国产自拍', vod_content: '合成屏蔽词' }).ok && P.checkItem({ vod_name: '某合成作品', type_name: '国产自拍', vod_actor: '合成屏蔽词' }).ok,
        'extra: 只查标签性字段(简介 / 演员栏不查)');
    ok(P.extraHit('有合成屏蔽词的片名') && !P.extraHit('普通片名') && P.extraHit('FOO BAR'), 'extra: extraHit(出口复查用)');
    // 只会更严:内置拦的照拦、理由一字不变;放行的里面最多多出 item:admin
    eq(reasons(CAN.block), blockBefore, 'extra: 内置硬拦金丝雀全部照拦、理由不变');
    ok(reasons(CAN.allow).every((r, i) => r === allowBefore[i] || r === 'item:admin'), 'extra: 放行金丝雀只可能多出 item:admin');
    ok(qs.every((q, i) => !qBefore[i] || P.checkQuery(q)), 'extra: 原来拦的查询照拦');
    // 追加和内置重复的词 / 空表:也放松不了任何东西
    P.setExtraBlock(['迷奸', '萝莉']);
    eq(reasons(CAN.block), blockBefore, 'extra: 追加和内置重复的词 → 内置理由照旧');
    P.setExtraBlock([]);
    eq(reasons(CAN.block), blockBefore, 'extra: 空表 → 内置照拦');
    eq(reasons(CAN.allow), allowBefore, 'extra: 空表 → 放行的照旧放行');
    eq(P.rulesKey(), A.RULES_VERSION, 'extra: 清空后 rulesKey 回到 RULES_VERSION');
    // 不合法 → 抛错、旧词表不变
    P.setExtraBlock(['合成屏蔽词']);
    const keep = P.extraBlock();
    for (const bad of [null, '合成屏蔽词', [1], ['a'], ['x'.repeat(41)], Array.from({ length: 501 }, (_, i) => '合成词' + i), ['!!'], ['合成屏蔽词', null]]) {
        let threw = false;
        try { P.setExtraBlock(bad); } catch (_) { threw = true; }
        ok(threw, 'extra: 不合法 → 抛错 ' + JSON.stringify(bad).slice(0, 40));
    }
    eq(P.extraBlock(), keep, 'extra: 不合法的词表不改旧词表');
    ok(P.setExtraBlock(Array.from({ length: 500 }, (_, i) => '合成词' + String(i).padStart(3, '0'))).n === 500, 'extra: 500 个词可以');
    // 性能:500 个追加词下 3000 次 checkItem
    P.setExtraBlock(Array.from({ length: 500 }, (_, i) => (i % 2 ? '合成词' + i : 'kakuu' + i)));
    const t0 = Date.now();
    for (let i = 0; i < 3000; i++) P.checkItem({ vod_name: `某作品标题第${i}集 中文字幕`, type_name: '国产自拍', vod_tag: '高清,素人', vod_content: '一段普通的简介文字'.repeat(20) });
    ok(Date.now() - t0 < 3000, 'perf: 500 个追加词下 3000 次 checkItem < 3s', Date.now() - t0);
    P.setExtraBlock([]);
    eq(P.extraBlock(), { words: [], n: 0, rev: '' }, 'extra: 测试结束清空');
}

console.log(`adult-policy-test: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  FAIL ' + f); process.exit(1); }
