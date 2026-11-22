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
        ['女老师下班后水杯里被加料晕倒', '国产自拍'], ['ABCD-107 欢迎会上晕倒了被同事带回家', '日本有码'], ['ABCD-108 失去意识后被侵犯', '日本有码'], ['公司团建少妇醉酒不省人事', '国产自拍'],
        ['被灌醉后干到不省人事', '国产自拍'], ['人妻被伏击 锁喉昏厥', '日本有码'], ['夜店嗑药3p', '国产自拍'], ['被下兴奋剂发情', '日本有码'], ['趁女友意识不清时上了她', '国产自拍']]) {
        const r = chk({ vod_name: n, type_name: tn }, {});
        ok(!r.ok && r.reason === 'item:drugging', 'p8 必拦 drugging: ' + n, r.reason);
    }
    for (const n of ['被干到高潮晕倒了好几次', '酒店里长发美女被操到神志不清', '痉挛着高潮到失去意识']) {
        const r = chk({ vod_name: n, type_name: '国产自拍' }, {});
        ok(!r.ok && r.reason === 'review:code' && r.review === 'code', 'p8 性行为导致的失去意识 = 审查级 code(没可信番号就藏): ' + n, r);
    }
    {
        const r = chk({ vod_name: 'SSIS-305 连续高潮到失去意识', type_name: '日本有码' }, {});
        ok(r.ok && r.review === 'code', 'p8 可信番号的 高潮到失去意识:放行但审查级 code(不做精选)', r);
    }
    for (const n of ['女大学生被金钱砸晕了', '女主播被礼物砸晕了', '差点被大奶敲晕', '打飞机', '晕车的美女', '普通人妻']) {
        const r = chk({ vod_name: n, type_name: '国产自拍' }, {});
        ok(r.reason !== 'item:drugging', 'p8 不误拦为 drugging: ' + n, r.reason);
    }
    ok(chk({ vod_name: 'ABCD-202 普通の人妻', type_name: '日本有码', vod_content: '丈夫被人打晕后她独自出门' }, {}).ok, 'p8:简介里的 打晕 剧情叙述不拦(只查标签性字段)');
    for (const q of ['打晕', '被打晕', '晕倒', '不省人事', '嗑药']) ok(A.policy.checkQuery(q) === true, 'p8 搜索词拦: ' + q);
    ok(A.policy.checkQuery('操到晕倒') === false && A.policy.checkQuery('晕车') === false, 'p8 搜索词不误拦(性行为导致 / 晕车)');
    // p8:reviewTagHints —— 乱伦框架片名补 incest 审查级标签(只会更不露出)
    const H = A.policy.reviewTagHints;
    ok(typeof H === 'function', 'policy.reviewTagHints 存在');
    for (const n of ['打桩一小时内射妈妈', '小姨的欲望好强', '表姐替女友满足我', '我妹的秘密', '继妹用脚勾引我', '骚姐姐想吃弟弟的大鸡巴', '坏公公偷看媳妇', 'ABCD-109 義母と二人きり'])
        ok(JSON.stringify(H({ vod_name: n })) === '["incest"]', 'p8 reviewTagHints → incest: ' + n, H({ vod_name: n }));
    for (const n of ['隔壁姐姐', '小姐姐自慰', '刚来完姨妈那里特别紧', '大姨妈期间', '被小哥哥操的小妹妹', '普通人妻', '继续努力'])
        ok(JSON.stringify(H({ vod_name: n })) === '[]', 'p8 reviewTagHints 不误标: ' + n, H({ vod_name: n }));
    ok(JSON.stringify(H({ vod_name: '普通标题', vod_content: '内射妈妈' })) === '[]' && JSON.stringify(H(null)) === '[]', 'p8 reviewTagHints 只看标签性字段;坏输入 → []');
    // ---- p9(第四阶段复核第二轮)----
    const P9 = A.policy;
    const r9 = (n, tn) => chk({ vod_name: n, type_name: tn }, {});
    // P1:抄底 / 带偷拍语境的 裙底 / 街头魔手 / 街射 / 顶臀 / 公交摸 / 街拍走光 / 一路跟拍 / 暗装·私装摄像头 / 隠しカメラ / creepshot / downblouse —— 刷一刷曾自动播放
    for (const [n, tn] of [['地铁抄底合集', '国产自拍'], ['商场裙底', '国产自拍'], ['尾随抄底反差妹裙底', '国产自拍'], ['漫展跟着小姐姐看裙底', '国产自拍'], ['暗装摄像头', '国产自拍'], ['私装摄像头', '国产自拍'],
        ['ABCD-120 隠しカメラ', '日本有码'], ['Creepshots Compilation', '欧美'], ['Office Downblouse Clips', '欧美'], ['Up Skirt Clips', '欧美'], ['[街头商场] 魔手袭胸 合集8 某某沦陷', '国产情色'],
        ['街头商场魔手系列8 合集 偷摸骚穴内射', '国产主播'], ['撸管街射路过的女人', '精品推荐'], ['顶臀系列全集', '国产自拍'], ['#公交车 #摸逼 胆子太大了', '抖阴视频'], ['街拍走光连衣裙小姐姐', '国产丝袜'],
        ['一路跟拍.陪男友逛商场的美女', '网红主播'], ['全程跟拍美女如厕', '网红头条'], ['某某被完全抄底', '探花约炮'], ['精选抄底无内漫展大长腿眼镜妹', '抖阴视频']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:voyeur', 'p9 必拦 voyeur: ' + n, r.reason);
    }
    for (const q of ['抄底', '地铁抄底', '商场裙底', '暗装摄像头', '私装摄像头', '隠しカメラ', 'creepshots', 'downblouse', '魔手袭胸', '街射']) ok(P9.checkQuery(q) === true, 'p9 搜索词拦: ' + q);
    for (const [n, tn] of [['钻进闺蜜裙底舔她', '国产传媒'], ['ABCD-121 长裙底下偷偷插入', '日本有码'], ['裙底风景无限好 ABCD-122', 'AV解说'], ['补习老师的魔手', '91视频'], ['小恶魔手淫', '日本有码'],
        ['股市抄底失败的男人', '伦理片'], ['跟拍性感瑜伽教练', '国产传媒'], ['老爸在客厅尾随上厕所的继母', '国产乱伦'], ['新生军训野战偷情走光', '国产自拍']]) {
        ok(r9(n, tn).reason !== 'item:voyeur', 'p9 不误拦为 voyeur: ' + n, r9(n, tn).reason);
    }
    ok(P9.checkQuery('裙底') === false && P9.checkQuery('魔手') === false && P9.checkQuery('走光') === false, 'p9 搜索词不误拦(单独的 裙底 / 魔手 / 走光)');
    for (const c of ['摄制组一路跟拍她的一天', '他在股市抄底失败', '趁行情抄底买入'])
        ok(chk({ vod_name: 'SSIS-401 某合成作品', type_name: '日本有码', vod_content: c }, {}).ok, 'p9 简介里的 一路跟拍 / 股市抄底 不拦: ' + c);
    // P2:麻醉 / 麻药 / 氯仿 / 搞晕·灌晕 / 加了料的酒 / 被下了东西 / 下安眠 / 被迷幻 / 被注射了 / 嗑嗨 / 溜冰 / K粉 / 笑气 / 興奮劑(繁体 劑) / 失去意识的同义说法 / 沉睡中 / 睡眠强奸
    for (const [n, tn] of [['人妻被麻醉针放倒,领导爆操内射', '国产自拍'], ['麻醉针下某某狂干', '国产主播'], ['给老婆打了麻醉针让领导操', '91探花'], ['打过麻醉后被医生玩弄', '国产大制作'],
        ['女特工中计麻药调教', '国产传媒'], ['氯仿与S', '强奸乱伦'], ['乙醚手帕', '国产自拍'], ['被搞晕后带回家', '国产自拍'], ['我的表姐被我搞晕了', '海角社区'], ['表姐聚会被同事灌晕', '国产乱伦'],
        ['被熏晕的少妇', '国产自拍'], ['喝了加了料的酒', '国产自拍'], ['加料的牛奶', 'AI短剧'], ['酒里被下了东西', '国产自拍'], ['被下了东西', '国产自拍'], ['被继父下安眠', '日本有码'],
        ['她被迷幻強姦了', '日本有码'], ['一场迷幻引发的交合', '日本有码'], ['出走的女人被注射了', '日本有码'], ['喂药给他吃,然后硬上', '探花'], ['ABCD-123 说好一起嗑嗨了再幹', '日本有码'],
        ['一起嗑嗨了再干', '国产自拍'], ['溜冰助兴合集', '精品推荐'], ['K粉派对', '国产自拍'], ['笑气派对', '国产自拍'], ['帶著馬用興奮劑的女郎', '日本有码'], ['STSK-200 興奮劑爆汗', '日本有码'],
        ['迷幻劑派对', '国产自拍'], ['因为药而失神', '日本有码'], ['婚前一晚,女长辈晕厥', '伦理片'], ['某某休克', '国产自拍'], ['神智不清的人妻', '国产自拍'], ['不醒人事的少妇', '国产自拍'],
        ['毫无意识的她', '国产自拍'], ['没有意识的人妻', '国产自拍'], ['ABCD-124 気絶した人妻', '日本有码'], ['ABCD-125 意識を失った妻', '日本有码'], ['ABCD-126 睡眠中の妻', '日本有码'],
        ['Fainted Girl Next Door', '欧美'], ['Comatose Wife', '欧美'], ['Spiked Drink Party', '欧美'], ['毫无防备地沉睡中的人妻沦陷', '伦理片'], ['沉睡的女人与沉睡的女人', '角色剧情'],
        ['沉睡按摩女被干到内射', '日本无码'], ['总是陷入沉睡,人妻猥亵诊察室', '日本有码'], ['ABCD-127 睡眠强奸之夜', '日本有码'], ['睡眠强暴录像', '日本有码'], ['女同事晕厥了被带回家', '国产自拍'],
        ['晕厥后被侵犯', '国产自拍'], ['或许会晕厥的已婚女人', '伦理片'], ['醉酒女星被按摩器玩到潮吹晕厥', '制服诱惑'], ['窒息式性爱被干到昏厥', '乌鸦传媒'], ['被绑架后干到失去意识', '国产自拍'],
        ['遭袭击后操到昏厥', '国产自拍'], ['被掐脖子操到昏厥', '国产自拍'], ['趁她神智不清干了她', '国产自拍']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:drugging', 'p9 必拦 drugging: ' + n, r.reason);
    }
    for (const q of ['麻醉针', '麻药', '氯仿', '搞晕', '灌晕', '嗑嗨', '溜冰', 'k粉', '笑气', '晕厥', '休克', '神智不清', '不醒人事', '毫无意识', '気絶', '沉睡中', '睡眠中の', 'comatose', 'spiked drink', '加了料的酒', '被下了东西', '興奮劑'])
        ok(P9.checkQuery(q) === true, 'p9 搜索词拦: ' + q);
    for (const [n, tn] of [['冷漠麻醉师沦为性奴', 'AV解说'], ['35岁麻醉科女医师', '91视频'], ['肛门咨询 无麻醉2穴扩张', '日本有码'], ['无需麻醉直接扩张', '日本有码'], ['捆绑的麻药搜查官', 'SM调教'],
        ['麻药直穿式丁字内裤', '制服诱惑'], ['被干到受不了往下面涂麻药', '成人头条'], ['庆祝10k粉丝的福利', '国产视频'], ['换下溜冰鞋就口交', '国产自拍'], ['狂吸粉嫩乳头', '巨乳美乳'],
        ['放倒23岁模特抽插', 'cosplay'], ['上司用肉棒喂药', '国产传媒'], ['护士淫荡喂药被爆操', '伦理三级'], ['哥哥可以给我打一针嘛', '抖阴视频'], ['旅馆遗留影片[加料:额外性爱]', 'FC2'],
        ['被耳边淫语迷幻到', '中文字幕'], ['迷幻梦境里激情潮吹', 'cosplay'], ['肉棒猛插注射精液', '国产视频'], ['被注射了攒了一周的浓精', 'FC2'], ['沉睡的她醒来后发现', '日本有码'], ['唤醒她沉睡的性欲', '日本有码'], ['唤醒沉睡的小穴', '制服诱惑'],
        ['人気絶頂のモデル', '日本有码'], ['没有意识到自己很敏感', '中文字幕'], ['无意识的诱惑', '日本有码'], ['無意識に誘惑してくる人妻', '日本有码'], ['涂油按摩', '国产自拍']]) {
        const r = r9(n, tn);
        ok(r.reason !== 'item:drugging' && r.review !== 'code', 'p9 不误拦为 drugging / 不误判审查级: ' + n, r);
    }
    for (const q of ['麻醉师', '无意识', '人気絶頂', '溜冰鞋', '10k粉丝', '操到晕厥', '被内射到失神']) ok(P9.checkQuery(q) === false, 'p9 搜索词不误拦: ' + q);
    // P3:女高生(女子高生 的简写)/ 女子高校 / 女子高 后接 校·生·中·の·制服;女子高潮 / 女子高尔夫 / 高生活 不算
    for (const [n, tn] of [['女高生的残酷私刑', '伦理片'], ['女子高校激战 FC2某某', '传媒-糖心传媒'], ['ABCD-129 女子高の制服', '日本有码'], ['女子高制服合集', '国产自拍']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:minor', 'p9 必拦 minor: ' + n, r.reason);
    }
    ok(P9.checkQuery('女高生') && P9.checkQuery('女子高校'), 'p9 搜索词拦: 女高生 / 女子高校');
    for (const n of ['女子高潮合集', '女子高尔夫球手', '美女高生活品质']) ok(r9(n, '国产自拍').reason !== 'item:minor', 'p9 不误拦为 minor: ' + n, r9(n, '国产自拍').reason);
    ok(P9.checkQuery('女子高潮') === false, 'p9 搜索词不误拦: 女子高潮');
    // P4:性行为导致的晕厥(晕厥 / 失神 / 気絶)= 审查级 code:没可信番号就藏,有可信番号放行但永不推荐
    for (const n of ['Gangbang内射—被肏到晕厥', '被内射到失神', '某某晕厥Ahegao快感沉沦', '落地窗前挨操,痛到晕厥,内射', '老婆被操到高潮晕厥', '金发女孩高潮到快晕厥', 'Fainting Orgasm']) {
        const r = r9(n, '国产自拍');
        ok(!r.ok && r.reason === 'review:code' && r.review === 'code', 'p9 性行为导致的晕厥 = 审查级 code(没可信番号就藏): ' + n, r);
    }
    for (const n of ['SSIS-320 晕厥Ahegao快感沉沦', 'SSIS-321 晕厥颜艺快感', 'SSIS-322 被猛干到失神中出', 'SSIS-323 失神イキ地獄', 'SSIS-324 気絶するほどイキまくる', 'SSIS-325 小恶魔美女的晕厥高潮']) {
        const r = r9(n, '日本有码');
        ok(r.ok && r.review === 'code', 'p9 可信番号的性行为晕厥:放行但审查级 code(不进推荐): ' + n, r);
    }
    // P6:p8 的误伤 —— 比喻(兴奋剂 / 钞票砸晕)不拦;性行为导致的(抽搐 / 榨取 / 累得 / 羞耻 / 玩起来 / 失禁 / 戏弄 …,含跨一个断句、状态词后跟 高潮/课程/的感觉)= code;
    //     否决词按词:灌肠 / 灌精 / 灌尿 / 捆绑 / 袭胸 / 着迷 不再把它变成硬拦
    for (const n of ['SSIS-330 就把我当作你的兴奋剂!', 'SSIS-331 当着男友面NTR!钞票砸晕女友', 'SSIS-341 被金子砸晕的女友']) {
        const r = r9(n, '日本有码');
        ok(r.ok && r.review === null, 'p9 比喻不拦: ' + n, r);
    }
    for (const n of ['SSIS-332 「这根是我的!」玩起来会晕倒!', 'SSIS-333 快要暈過去的感覺……吞精、中出', 'SSIS-334 抽搐、喷水、后仰、昏厥与彻底高潮课程', 'SSIS-335 深喉猛操四位熟女,抽搐昏厥',
        'SSIS-336 中出&amp;男潮 连续榨取到昏厥的课程', 'SSIS-337 灌肠羞耻诊室 羞耻到昏厥的实习护士', 'SSIS-338 作弊游戏,昏厥,高潮!', 'SSIS-339 小穴失禁后昏死过去', 'SSIS-340 一个荡妇会戏弄你,直到你神智不清',
        'SSIS-342 深喉太深了。四名熟女抽搐并昏倒']) {
        const r = r9(n, '日本有码');
        ok(r.ok && r.review === 'code', 'p9 性行为导致的晕厥不再硬拦(审查级 code): ' + n, r);
    }
    // 升成 code 只能更严:分类审查级 filter(探花…)的 FILTER_EXTRA 复查(前女友 / 不知情 …,含简介)在条目被升成 code 之后照样做
    {
        const r = chk({ vod_name: 'SSIS-350 被狂干到失神', type_name: '国模私拍', vod_content: '和前女友分手后' }, {});
        ok(!r.ok && r.reason === 'item:filter', 'p9 分类 filter 的条目被 失神 升成 code 后,FILTER_EXTRA 复查照做', r);
        ok(chk({ vod_name: 'SSIS-350 被狂干到失神', type_name: '国模私拍' }, {}).ok && chk({ vod_name: 'SSIS-350 被狂干到失神', type_name: '国模私拍' }, {}).review === 'code', 'p9 分类 filter + 失神 + 可信番号 → 放行但审查级 code');
    }
    for (const n of ['被猛男插到,累得不省人事', '贱母狗灌尿淋尿爽到不省人事', '狂灌精内射到失去意识', '捆绑调教到失去意识', '袭胸后干到昏厥', '对假阳具十分着迷,干到失去意识']) {
        const r = r9(n, '国产自拍');
        ok(r.reason === 'review:code', 'p9 否决词按词(灌肠/灌精/捆绑/袭胸/着迷 不否决)→ 审查级 code: ' + n, r.reason);
    }
    // ---- p9 复核(对抗复核第二轮:修复后仍漏的同义说法 / P6 改动带来的放松 / 新误伤)----
    // blocker 1:女高 = 女子高生 的最短简写(JK / 女子高生 / 女高生 有可信番号也拦,女高 不能例外);前后是复合词的放行
    for (const [n, tn] of [['女高', '国产自拍'], ['清纯女高', '国产自拍'], ['黑丝女高', '国产自拍'], ['纯情女高背书包被干', '成人头条'], ['极品女高在厕所自慰', '国产自拍'],
        ['MD0000 某某 骚女高被干到抵债', '精品推荐'], ['SSIS-940 某某纯欲系女高被猛干', '日本有码'], ['女高小仙女在爸爸面前', '国产专区'], ['反差騷貨翹臀女高嫩', '韩国-主播'],
        ['被欺负的白丝女高-桥本某某', '91视频'], ['某某女高 高桥某某', '国产自拍'], ['清纯女高长腿细腰', '网红主播']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:minor', 'p9 复核 必拦 女高: ' + n, r.reason);
    }
    for (const [n, tn] of [['美女高潮合集', '国产自拍'], ['女高管的秘密', '国产传媒'], ['女高音歌唱家', '伦理片'], ['SSIS-941 熟女高濑某某', '日本有码'], ['美女高颜值', '国产自拍'],
        ['女高跟鞋足交', '恋足'], ['SSIS-942 某某女高山某某', '日本有码'], ['金发艳女高水平外国女优', '日本有码'], ['SSIS-943 痴女高技巧榨精', '日本有码'], ['高端外围女高阶段服务', '抖阴视频'],
        ['SSIS-944 某地的婦女高瀨某某', '日本有码'], ['妹子女高170', '国产自拍'], ['美女高生活品质', '国产自拍'], ['SP女高园某某', '伦理片'], ['女高大上的会所', '国产自拍'],
        ['男高180,女高165', '国产自拍'], ['熟女 高桥某某', '日本有码'], ['巨乳女高桥某某', '日本有码']]) {
        ok(r9(n, tn).reason !== 'item:minor', 'p9 复核 不误拦为 minor(女高 复合词): ' + n, r9(n, tn).reason);
    }
    // blocker 2:中学女生 / 女孩 / 女友 / 情侣 / 表妹 / 时代 / の / 中学3年生 / 住校;中学女老师 / 中学英语老师 / 中学校长 / 中学女儿 / 中学习 放行
    for (const [n, tn] of [['某市实验中学女生初夜视频', '群P换妻'], ['记录还没发育好的中学女孩', '国产色情'], ['素颜中学女生合集', '精品推荐'], ['反差淫娃住校中学女孩', '主播诱惑'],
        ['我和中学女友(下)', '国产自拍'], ['中学情侣翘课跑到天台', '野外露出'], ['花钱敲开中学表妹的房门', '乱伦'], ['猛干中学处女妹', '国产自拍'], ['SSIS-945 初めては中学3年生', '日本有码'],
        ['SSIS-946 中学時代からの妄想セックス', '日本有码'], ['住校妹', '国产自拍']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:minor', 'p9 复核 必拦 中学: ' + n, r.reason);
    }
    for (const [n, tn] of [['某地中学女老师穿情趣内衣', '国产自拍'], ['中学数学老师出轨', '国产主播'], ['天台上干中学老师', '国产主播'], ['SSIS-947 中学女儿的班主任和我', '日本有码'],
        ['SSIS-948 从大叔的高超技术中学习到快感', '日本有码'], ['SSIS-949 公立中学校に勤務する保健室の先生', '日本有码'], ['SSIS-950 中学の娘の担任と', '日本有码']]) {
        ok(r9(n, tn).reason !== 'item:minor', 'p9 复核 不误拦为 minor(中学老师 / 中学习): ' + n, r9(n, tn).reason);
    }
    for (const q of ['女高', '清纯女高', '中学女生', '中学女孩', '住校妹']) ok(P9.checkQuery(q) === true, 'p9 复核 搜索词拦: ' + q);
    for (const q of ['女高管', '女高音', '美女高潮', '中学老师', '中学英语老师']) ok(P9.checkQuery(q) === false, 'p9 复核 搜索词不误拦: ' + q);
    // blocker 3:迷玩 / MJ(迷奸 拼音缩写,整词)/ 灌倒;沉迷玩手机 / 痴迷玩具 / 用户名里的 mj0128 放行
    for (const [n, tn] of [['【迷玩系列】暗恋已久的同事被拿下', '角色剧情'], ['禽兽姐夫灌倒后迷玩美臀', '国产大制作'], ['药物迷玩上门女教师', '糖心Vlog'], ['真实MJ公司新来的白领', '精品推荐'],
        ['少妇 被俩兄弟MJ了', '国产专区'], ['三人设局MJ空姐', '国产自拍'], ['另類危險MJ,把表姐弄倒', '国产视频'], ['请女同事去酒吧把她灌倒去酒店开房', '91视频']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核 必拦 迷玩 / MJ / 灌倒: ' + n, r.reason);
    }
    for (const [n, tn] of [['SSIS-951 沈迷玩手機之中的人妻', '日本有码'], ['沉迷玩手机的人妻', '国产自拍'], ['痴迷玩具的少妇', '国产自拍'], ['kbj00000000_mj0000 - Mj0000', '韩国直播'], ['MJ-001 合集', '欧美']]) {
        ok(r9(n, tn).reason !== 'item:drugging', 'p9 复核 不误拦为 drugging(沉迷玩 / mj0128): ' + n, r9(n, tn).reason);
    }
    for (const q of ['迷玩', 'MJ', 'mj', '灌倒']) ok(P9.checkQuery(q) === true, 'p9 复核 搜索词拦: ' + q);
    ok(P9.checkQuery('沉迷玩手机') === false, 'p9 复核 搜索词不误拦: 沉迷玩手机');
    // major P2:同一部片的兄弟线路(日文 / 异写)—— 有可信番号也拦
    for (const n of ['SSIS-952 眠姦して調教', 'SSIS-953 「寝堕ちー。」いつの間にか眠りに堕ちて', 'SSIS-954 总是陷入睡眠中,人妻诊察室', 'SSIS-955 痴漢寝落ち中出し',
        'SSIS-956 睡眠性侵 无意识地被性消费的女人们', 'SSIS-957 記録映像 クロロホル', 'SSIS-958 クロロホルムで昏●', 'SSIS-959 完蛋!嗑了好多藥!', 'SSIS-960 ノンレム眠姦',
        'SSIS-961 生意気な彼女を眠姦', 'SSIS-962 眠姦用藥做愛', 'SSIS-963 带到酒店睡眠性侵', 'SSIS-964 醉妹路边睡死!被捡回去狂干', 'SSIS-965 意識のない女', 'SSIS-966 気を失った女に中出し',
        'SSIS-967 怎么弄都醒不过来的嫂子', 'SSIS-968 做什麼都不會醒來的姐姐', 'SSIS-969 ネムラセ!!何しても起きない人妻', 'SSIS-970 深夜、路上で寝る女たち', 'SSIS-971 深夜在路上睡觉的女人',
        'SSIS-972 每次都睡着堕落的人妻', 'SSIS-973 某某的睡眠性爱', 'SSIS-974 薬漬けモデル', 'SSIS-975 成瘾女的药物性惩罚', 'SSIS-976 睡覺OO影片']) {
        const r = r9(n, '日本有码');
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核 必拦(兄弟线路,有可信番号): ' + n, r.reason);
    }
    ok(r9('半夜钻被窝把正在睡熟中的妈妈操上高潮', '海角社区').reason === 'item:drugging', 'p9 复核 必拦: 睡熟中');
    {
        const r = r9('SSIS-977 気を失うまでイカせる', '日本有码');
        ok(r.ok && r.review === 'code', 'p9 复核 気を失うまでイカせ = 性行为导致(code,不拦)', r);
    }
    for (const [n, tn] of [['嗑瓜子聊天', '国产自拍'], ['探花精选 边操边唠嗑', '国产自拍'], ['SSIS-978 不停催眠姦淫', '麻豆传媒'], ['SSIS-979 老公睡死!人妻被邻居干到失禁', '日本有码'],
        ['SSIS-980 新婚夜丈夫睡死,新娘被邻居猛干', '日本有码'], ['SSIS-981 巨乳人妻的無意識誘惑', '日本有码'], ['SSIS-982 在无意识中被诱惑', '日本有码'], ['勾引男大嗑伟哥', '网红主播'],
        ['SSIS-983 不让我睡觉的女同事', '日本有码']]) {
        ok(r9(n, tn).reason !== 'item:drugging', 'p9 复核 不误拦为 drugging: ' + n, r9(n, tn).reason);
    }
    for (const q of ['眠姦', '寝落ち', '睡眠性侵', 'クロロホルム', '醒不过来']) ok(P9.checkQuery(q) === true, 'p9 复核 搜索词拦: ' + q);
    ok(P9.checkQuery('无意识诱惑') === false && P9.checkQuery('唠嗑') === false, 'p9 复核 搜索词不误拦: 无意识诱惑 / 唠嗑');
    // major:毒品 / 大麻 / 麻古 / 海洛因 / 可卡因 / 覚醒剤 / 冰妹 / 毒瘾 / 磕药;加料的各种写法;吞…安眠
    for (const [n, tn] of [['SSIS-984 滥用大麻,在被大麻浸泡后被迫提供性服务', '日本有码'], ['GX-000 毒品控制的女优', '国产传媒'], ['人妻护士被毒品操控变成性奴', '伦理三级'],
        ['SSIS-985 毒品引发的乱交', '日本有码'], ['SSIS-986 满是毒品的性派对', '日本有码'], ['SSIS-987 沉溺於毒品性愛的女友', '日本有码'], ['用麻古控制女友', '精品推荐'],
        ['兄妹吸大麻后乱性', '乱伦'], ['海洛因派对', '国产自拍'], ['可卡因派对', '国产自拍'], ['SSIS-988 覚醒剤', '日本有码'], ['SSIS-989 覚せい剤漬け', '日本有码'], ['冰妹狂欢', '国产自拍'],
        ['毒瘾发作的人妻被干', '国产自拍'], ['大哥磕药了把妹子干趴', '探花嫖娼'], ['边嗨药边猛操', '国产情色'], ['饭局上趁机下点小料搞定女同事', '精品推荐'], ['酒里加了东西', '国产自拍'],
        ['饮料里加了点料', '国产自拍'], ['在她饮料里偷偷加了点料', '淫妻绿帽'], ['加了药的红酒', '国产自拍'], ['加料奶茶', '国产自拍'], ['往表姐的咖啡里加点料', 'mini传媒'],
        ['表姐被人下小料了', '海角社区'], ['吞了几颗安眠', '国产自拍'], ['被喂了药', '国产自拍'], ['被放倒后带回家', '国产自拍'], ['没了知觉', '国产自拍']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核 必拦 毒品 / 加料: ' + n, r.reason);
    }
    for (const [n, tn] of [['SSIS-990 运动服拉链,大麻烦!', '日本有码'], ['双马尾大麻花辫', '国产自拍'], ['青梅竹马变成肉棒毒瘾辣妹', '日本无码'], ['KTV两个公主淫乱磕炮', '国产丝袜'],
        ['反差母狗磕头哀求求操', '国产自拍'], ['旅馆遗留影片[加料:额外性爱]', 'FC2'], ['放倒23岁模特抽插', 'cosplay'], ['护士淫荡喂药被爆操', '伦理三级'], ['SSIS-991 然后他就被放倒了', '日本有码']]) {
        ok(r9(n, tn).reason !== 'item:drugging', 'p9 复核 不误拦为 drugging(大麻烦 / 磕炮 / 放倒): ' + n, r9(n, tn).reason);
    }
    for (const q of ['毒品', '吸食大麻', '大麻', '麻古', '下点小料', '磕药']) ok(P9.checkQuery(q) === true, 'p9 复核 搜索词拦: ' + q);
    ok(P9.checkQuery('大麻烦') === false && P9.checkQuery('磕炮') === false, 'p9 复核 搜索词不误拦: 大麻烦 / 磕炮');
    // major P6 回归:先失去意识再被…("晕倒了被""晕倒后被")不管前面有没有 玩/累/撞/喷;掐着脖子 / 掐住她的脖子 / 勒紧 / 捂住嘴 / 闷住 —— 有可信番号也拦
    for (const n of ['SSIS-992 欢迎会上玩游戏晕倒了被同事带回家', 'SSIS-993 加班太累晕倒了被上司带回家', 'SSIS-994 加班太累,晕倒后被同事侵犯', 'SSIS-995 去游乐园玩,晕倒后被带回家',
        'SSIS-996 被车撞晕过去后被司机带走', 'SSIS-997 喷了防狼喷雾昏倒后被', 'SSIS-998 掐着脖子操到昏过去', 'SSIS-999 掐住她的脖子爆操到晕死过去', 'SSIS-900 勒紧脖子操到失去意识',
        'SSIS-901 捂住嘴干到不省人事', 'SSIS-902 用皮带勒住她操到失去意识', 'SSIS-903 用枕头闷住干到昏过去', 'SSIS-904 首絞めで失神', 'SSIS-905 被叔父侵犯 扼颈失神',
        'SSIS-906 被灌醉后失神', 'SSIS-907 失神后被侵犯', 'SSIS-908 失神了被轮奸', 'SSIS-909 昏死过去后被继续内射', 'SSIS-910 掐脖猛干到失神']) {
        const r = r9(n, '日本有码');
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核 必拦(P6 回归,有可信番号): ' + n, r.reason);
    }
    for (const n of ['SSIS-911 「这根是我的!」玩起来会晕倒!', 'SSIS-912 玩到晕倒', 'SSIS-913 失神中出し', 'SSIS-914 イキ失神', 'SSIS-915 干到昏死过去继续干',
        'SSIS-916 被操到高潮晕倒在床上', 'SSIS-917 被狂干到失神后庭花穴双开', 'SSIS-918 酒会后的淫乱一夜,被巨根狂干到失神', 'SSIS-919 被巨根彻底睡服 内射到失神']) {
        const r = r9(n, '日本有码');
        ok(r.ok && r.review === 'code', 'p9 复核 性行为导致的晕厥仍是 code(不拦): ' + n, r);
    }
    // minor:新误伤 —— 笑笑气氛 / 高潮麻醉 / 唤醒沉睡中 / 让你晕厥 / 像…兴奋剂一样 不再硬拦
    for (const [n, tn] of [['闺蜜4P 大家说说笑笑气氛很好', '国产视频'], ['用高潮麻醉小穴 无痛纹身体验', '国产情色'],
        ['SSIS-920 唤醒沉睡中的绝顶快感', '日本有码'], ['像吃了兴奋剂一样', '国产自拍'], ['像打了兴奋剂一样狂干', '国产自拍']]) {
        const r = r9(n, tn);
        ok(r.ok && r.review === null, 'p9 复核 误伤修正(放行且不是审查级): ' + n, r);
    }
    {
        const r = r9('FC2-PPV-1000001 这位OL会用她五彩缤纷的呻吟声让你晕厥!', 'FC2');
        ok(r.ok, 'p9 复核 误伤修正:让你晕厥(说的是观众)不硬拦', r);
        ok(r9('这股味道让人直接昏倒', '伦理片').ok, 'p9 复核 误伤修正:让人直接昏倒 不硬拦');
    }
    // minor:偷拍组的残余同义说法;奸尸(死者不能同意 → 失能类)
    for (const n of ['公交咸猪手', '地铁咸猪手系列', '商场裙下抓拍', '扶梯裙下风光', '地铁顶臀', '地铁蹭臀', '逆さ撮り', '盗み撮り', '试衣间拍摄', '公厕偷', '偷看女生上厕所']) {
        const r = r9(n, '国产自拍');
        ok(!r.ok && r.reason === 'item:voyeur', 'p9 复核 必拦 voyeur: ' + n, r.reason);
    }
    // (p9 复核四:"偷看X洗澡"不再放行 —— 剧本片里的偷看也按偷拍题材硬拦,见下面 复核四 的 偷拍 组)
    for (const [n, tn] of [['拜倒在石榴裙下', '伦理片'], ['试衣间自拍', '国产自拍'], ['商场试衣间里偷情', '国产自拍'], ['试衣间对着镜子边拍边干', '国产视频'], ['厕所偷情', '国产自拍']]) {
        ok(r9(n, tn).reason !== 'item:voyeur', 'p9 复核 不误拦为 voyeur(试衣间偷情): ' + n, r9(n, tn).reason);
    }
    for (const n of ['劫匪掐死后奸尸', '用丝袜勒死然后奸尸', '猛干丝袜女尸体', '验尸房侮辱美女尸体', '冰恋系列']) {
        const r = r9(n, '国产自拍');
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核 必拦 奸尸: ' + n, r.reason);
    }
    ok(r9('某某的尸体', '伦理片').ok, 'p9 复核 单独的 尸体(片名)不拦');
    for (const q of ['地铁咸猪手', '盗み撮り', '奸尸']) ok(P9.checkQuery(q) === true, 'p9 复核 搜索词拦: ' + q);
    // ---- p9 复核二(对抗复核第三轮)。全部是合成标题 ----
    // blocker 1:下药做爱 / 春药 / 迷情药 / 用药强上 / 给她吃性药 / 放入性药 / 服药过量 / Kimeseku —— 有可信番号也拦,搜索词也拦
    for (const [n, tn] of [['SSIS-601 用药做爱的女上司NTR', '日本有码'], ['SSIS-608 用藥做愛的人妻', '日本有码'], ['SSIS-609 藥物性愛的夜晚', '日本有码'], ['SSIS-602 Kimeseku女上司', '日本有码'],
        ['SSIS-604 決めセク人妻', '日本有码'], ['想上表姐先给表姐吃性药', '家庭乱伦'], ['往茶水中放入性药', '日本有码'], ['逛街时被人用药操到高潮', '国产主播'], ['OD(服药过量)的玩偶', 'SM调教'],
        ['儿子用迷情药让继母高潮', '精品推荐'], ['对女上司用药强上', '淫欲痴女'], ['用药拿下继母', 'SWAG'], ['被药爆操到内射的人妻', 'AV明星'], ['上门老师 药物迷惑计划', '糖心Vlog'],
        ['迷魂水 人妻被药爆操', 'AV明星'], ['被灌下迷情药后连续做爱', '强奸乱伦'], ['SSIS-610 女友OD（Overdose）中出', '强奸乱伦'], ['SSIS-611 彼女をOD（オーバードーズ）', 'SM调教'],
        ['用烈性药物腌制的女人', '女优明星'], ['人妻被灌了失禁药', 'AV明星'], ['SSIS-612 惚れ薬で覚醒', '颜值正义'], ['SSIS-613 用药物洗脑的偶像', '中文字幕'], ['SSIS-614 不用藥做愛就會受不了的人妻', '颜值正义'],
        ['SSIS-615 用藥睡走岳母', '中文字幕'], ['SSIS-616 用药高潮到崩坏', 'AV明星'], ['绿帽男给自己老婆吃性药', '制服诱惑']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核二 必拦 下药做爱: ' + n, r.reason);
    }
    for (const q of ['用药做爱', '药物性爱', 'kimeseku', '迷情药', '迷魂水', '被人用药', '用药强上', '给表姐吃性药', '放入性药', '服药过量', '被药爆操', 'overdose', 'オーバードーズ', '惚れ薬', '想上表姐先给表姐吃性药', '儿子用迷情药让继母高潮'])
        ok(P9.checkQuery(q) === true, 'p9 复核二 搜索词拦: ' + q);
    // 男方自己吃性药 / 伟哥(助性)、不用药(否定)、迷情(言情片名)、过量精液、比喻 —— 不拦;简介里的 overdosed 不拦(只查标签性字段)
    for (const [n, tn] of [['吃性药狂操女同事', '嫖妓全过程'], ['小伙吃了伟哥猛插人妻', '淫妻绿帽'], ['给隔壁老大爷吃性药助兴', '91视频'], ['不用药做爱?敏感的痴女', '制服丝袜'],
        ['午夜迷情', '国产自拍'], ['迷情按摩', '伦理片'], ['深喉吞下过量精液', 'AV明星'], ['口服过量合集', '欧美系列'],
        ['高潮脸是男人的性药', '精品推荐'], ['Cock Overdose Part 1', '3D动漫'], ['用药睡觉', '国产自拍']]) {
        ok(r9(n, tn).reason !== 'item:drugging', 'p9 复核二 不误拦为 drugging(助性 / 否定 / 比喻): ' + n, r9(n, tn).reason);
    }
    // p9 复核五:性药 = 春药 的同义词(春药 全字段硬拦):只放过 男方自己吃了 + 狂操·助兴·增加战力…(助性)/ 性药加持 / 男人的性药(比喻);
    //   女方自己吃 / 性药代理 这类(复核二曾放行)按 春药 同口径硬拦;单独搜 吃性药 也拦
    for (const [n, tn] of [['性药女代理服务客户', '传媒剧情'], ['女主播吃了性药自慰', '抖阴视频']]) eq(r9(n, tn).reason, 'item:drugging', 'p9 复核五 性药 = 春药: ' + n);
    ok(chk({ vod_name: 'SSIS-617 某合成作品', type_name: '韩国伦理', vod_content: 'young men overdosed with gas appear' }, {}).ok, 'p9 复核二 简介里的 overdosed(剧情叙述)不拦');
    ok(P9.checkQuery('吃性药') === true && P9.checkQuery('伟哥') === false && P9.checkQuery('迷情') === false, 'p9 复核二 搜索词不误拦: 伟哥 / 迷情(p9 复核五:单独的 吃性药 拦)');
    // blocker 2:睡著(繁体)/ 沈睡 / 睡觉(时)被 / 正在睡觉的嫂子 / 寝てる女 / 睡眠干炮 / 睡眠用药 / 睡得像死猪 —— 有可信番号也拦
    for (const [n, tn] of [['睡著的人妻', '中文字幕'], ['沈睡中的妻子', '日本有码'], ['SSIS-618 寝てる女に悪戯', 'SM调教'], ['表妹睡觉被表哥偷偷插入', '91视频'], ['正在睡觉的大嫂', '乱伦'],
        ['SSIS-619 睡眠幹砲', '中文字幕'], ['睡眠用药之夜', '中文字幕'], ['后入正在睡觉的继母', '乱伦'], ['SSIS-620 把睡著的婆婆误认成老婆', '中文字幕'], ['SSIS-621 寝ている義母に挿入', 'SM重味'],
        ['SSIS-622 寝ている姉に悪戯', 'SM重味'], ['SSIS-623 寝ている息子に跨る母', '强奸乱伦'], ['睡著被丈夫的同事', '乌鸦传媒'], ['小姨子睡觉的时候被干', '角色剧情'], ['DASS-999 睡觉时被侵犯', '强制侵犯'],
        ['把睡觉的大嫂操醒了', '乱伦'], ['猛干睡得像死猪的女人', '嫖妓全过程'], ['SSIS-624 毫無防備地睡著了', '口交视频'], ['操正在睡觉的女友', '主播网红'], ['嫂子骑上在睡觉的小叔子', '91视频'],
        ['在睡著的女友身上中出', '国产自拍']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核二 必拦 睡眠失能: ' + n, r.reason);
    }
    for (const q of ['睡著的人妻', '沈睡中', '睡觉时被', '正在睡觉的大嫂', '睡眠干炮', '睡眠用药', '寝てる女', '寝ている姉']) ok(P9.checkQuery(q) === true, 'p9 复核二 搜索词拦: ' + q);
    // 旁人在睡(老公·丈夫…睡着的身边 / 夫が寝ている横で)/ 装睡 / 睡觉被吵醒 / 被偷走睡觉(寝取られ 的译法)/ 睡衣 / 叫醒再做 —— 不拦
    for (const [n, tn] of [['SSIS-625 丈夫睡著時勾引繼子', '角色剧情'], ['SSIS-626 在睡著的丈夫身邊偷情', '人妻系列'], ['SSIS-627 她假裝睡著的時候', '角色剧情'], ['半夜睡觉被吵醒了发现邻居', '乱伦'],
        ['SSIS-628 震撼的睡覺被拍下', '日本有码'], ['SSIS-629 被偷走睡覺的故事', '中文字幕'], ['在还在睡觉的闺蜜旁边自慰', 'mini传媒'], ['SSIS-630 夫が寝ている横で不倫', '无码高清'], ['SSIS-631 寝てる横でこっそり', '日本无码'],
        ['SSIS-632 寝てるだけでいい', 'VR视角'], ['老婆在睡觉我撩小姨子', '抖阴视频'], ['姐姐在睡觉姐夫在旁边上小姨子', '姐夫小姨子'], ['SSIS-633 睡不著嗎', '中文字幕'], ['著名女优的写真', '国产自拍'],
        ['SSIS-634 不會讓人睡著的女上司', '中文字幕'], ['照顾他睡著的女友旁打炮', '国产色情'], ['跑去继母房间睡觉被继母赶', '海角社区'], ['湿身巨乳和无防备睡衣', '美乳巨乳'], ['叫醒正在睡觉的男友做爱', '国产自拍']]) {
        ok(r9(n, tn).reason !== 'item:drugging', 'p9 复核二 不误拦为 drugging(旁人 / 装睡 / 睡衣): ' + n, r9(n, tn).reason);
    }
    // major:状态词作定语("晕倒的女人被干到高潮")= 先失去意识的人 —— 硬拦(有可信番号也拦;p8 也是硬拦);结果词 / 性行为导致 仍是 code;比喻不算
    for (const n of ['SSIS-606 晕倒的女人被干到高潮', 'SSIS-607 不省人事的她被操到高潮', 'SSIS-635 神志不清的女孩被干到高潮', 'SSIS-636 昏死的少妇被干到潮吹', 'SSIS-637 昏倒的人妻被内射高潮',
        'SSIS-638 意识模糊的她高潮', 'SSIS-639 失去意识的女人高潮']) {
        const r = r9(n, '日本有码');
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核二 必拦 状态词作定语: ' + n, r.reason);
        ok(P9.checkQuery(n.slice(9)) === true, 'p9 复核二 搜索词拦: ' + n.slice(9));
    }
    for (const n of ['SSIS-640 差點暈過去的感覺', 'SSIS-641 晕厥的快感', 'SSIS-642 被操到晕倒的女人', 'SSIS-643 小恶魔美女的晕厥高潮']) {
        const r = r9(n, '日本有码');
        ok(r.ok && r.review === 'code', 'p9 复核二 性行为导致 / 结果词 仍是 code: ' + n, r);
    }
    ok(r9('让人晕倒的美女', '国产自拍').reason !== 'item:drugging', 'p9 复核二 比喻 让人晕倒的… 不拦');
    // major:操晕 / 干晕 / 插晕 / 干昏 / 插得昏阙 = 审查级 code(永不推荐);干晕 直接就…操 / 尾行 → 硬拦;晕车 / 晕乎乎 不算
    for (const n of ['被两个壮汉操晕', '被黑大屌插得昏阙', '很快就被操晕了', '被继父插晕了', '大嫂几次被操晕', '直接把熟女干昏了']) {
        const r = r9(n, '国产自拍');
        ok(!r.ok && r.reason === 'review:code' && r.review === 'code', 'p9 复核二 操晕 = 审查级 code: ' + n, r);
    }
    ok(r9('SSIS-663 被操晕了', '日本有码').ok && r9('SSIS-663 被操晕了', '日本有码').review === 'code', 'p9 复核二 可信番号的 操晕:放行但审查级 code');
    for (const n of ['色狼尾行美女干晕直接就给上了', '小巷里干晕直接就给上了', '操晕后被轮奸']) {
        const r = r9(n, '国产传媒');
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核二 必拦 先打晕再… : ' + n, r.reason);
    }
    for (const n of ['晕车的美女', '被干得晕乎乎的女孩']) ok(r9(n, '国产自拍').ok && r9(n, '国产自拍').review === null, 'p9 复核二 晕车 / 晕乎乎 不是审查级: ' + n, r9(n, '国产自拍'));
    // p9 复核五:爽晕 = 性行为导致的晕厥(和 操晕 同为审查级 code;复核二曾当成不是审查级)
    eq(r9('爽晕了', '国产自拍').reason, 'review:code', 'p9 复核五 爽晕 = 审查级 code');
    ok(P9.checkQuery('操晕') === false && P9.checkQuery('小巷里干晕直接就给上了') === true, 'p9 复核二 搜索词:操晕 不拦(code 级),干晕直接就给操了 拦');
    // minor:喝到断片 = code;捡醉女 / 迷药俗称 / 麻酔 / 丧失意识 / passes out / 撂倒 / 打了一针后任人摆布 → 硬拦
    ok(r9('朋友女友在KTV喝到断片被扒光', '国产自拍').reason === 'review:code', 'p9 复核二 喝到断片 = 审查级 code');
    for (const [n, tn] of [['深夜捡醉女', '国产自拍'], ['捡醉妹', '国产自拍'], ['三唑仑', '国产自拍'], ['乖乖水', '国产自拍'], ['G水', '国产自拍'], ['神仙水', '国产自拍'], ['听话药', '国产自拍'],
        ['失忆药', '国产自拍'], ['迷情水', '国产自拍'], ['吸K', '国产自拍'], ['K他命', '国产自拍'], ['氯胺酮', '国产自拍'], ['SSIS-644 シャブ漬け', '日本有码'], ['SSIS-645 ドラッグ漬けの女', '日本有码'],
        ['SSIS-646 眠り薬', '日本有码'], ['SSIS-647 睡眠導入剤', '日本有码'], ['SSIS-648 麻酔で動けない', '日本有码'], ['哥罗芳', '伦理片'], ['丧失意识的人妻', '国产自拍'], ['SSIS-649 喪失意識の妻', '日本有码'],
        ['She Passes Out', '欧美'], ['Passing Out Party', '欧美'], ['被撂倒带回酒店', '国产自拍'], ['打了一针后任人摆布', '国产自拍'], ['SSIS-650 昏睡ドラッグを飲まされた妻', '日本有码'], ['老板的茶里竟然是乖乖水', '精东影业']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核二 必拦 迷药俗称 / 失能: ' + n, r.reason);
        ok(P9.checkQuery(n) === true, 'p9 复核二 搜索词拦: ' + n);
    }
    for (const [n, tn] of [['SSIS-651 無麻酔で拡張', '日本有码'], ['SSIS-652 麻酔科医の人妻', '日本有码'], ['SSIS-653 ちんシャブ中毒の人妻', '日本有码'], ['SSIS-654 チ○ポをシャブる', '日本有码'],
        ['SSIS-655 ドラッグストアでバイト', '日本有码'], ['爽到断片', '国产自拍']]) {
        ok(r9(n, tn).reason !== 'item:drugging', 'p9 复核二 不误拦为 drugging(無麻酔 / シャブる / ドラッグストア): ' + n, r9(n, tn).reason);
    }
    // minor:髙 / 満 异体字、十X歳·十X才、18歳未満、ようじょ;二十五岁 这类成年岁数不再误中;女高筒袜 / 女高叉 / 女高鼻梁 不是 女高
    for (const n of ['女子髙生', '髙校生', '清纯女髙', '十五歳の', '十七才', '十五六岁的', '18歳未満', '未満18', '18岁未满', 'ようじょ', 'ようじょと遊ぶ', '某某女高同学', '中学时代的同学', '长大看到一定要']) {
        const r = r9(n, '国产自拍');
        ok(!r.ok && r.reason === 'item:minor', 'p9 复核二 必拦 minor: ' + n, r.reason);
        ok(P9.checkQuery(n) === true, 'p9 复核二 搜索词拦: ' + n);
    }
    for (const n of ['二十五岁的人妻', '三十五歳の人妻', '二十七才', 'ようじょう', '黑丝女高筒袜', '女高叉泳衣', '混血女高鼻梁']) {
        ok(r9(n, '国产自拍').reason !== 'item:minor', 'p9 复核二 不误拦为 minor: ' + n, r9(n, '国产自拍').reason);
        ok(P9.checkQuery(n) === false, 'p9 复核二 搜索词不误拦: ' + n);
    }
    // 中学时代 / 中学同学 / 女高同学 / 中学のとき 只查标签性字段:简介里的成年回忆剧情不拦,片名里照拦
    for (const c of ['她是我中学时代的朋友,多年后在同学会重逢', '有一天,女高同学搬到了隔壁', 'ペンションで、中学時代の仲間たちが再会した', '中学のときに好きだった人と再会'])
        ok(chk({ vod_name: '某合成伦理片', type_name: '伦理片', vod_content: c }, {}).ok, 'p9 复核二 简介里的 中学时代 / 女高同学 不拦: ' + c);
    ok(r9('SSIS-656 中学時代の同級生と再会', '日本有码').reason === 'item:minor' && r9('SSIS-657 中学のときに好きだった人', '日本有码').reason === 'item:minor', 'p9 复核二 片名里的 中学时代 / 中学のとき 照拦');
    // minor:偷拍组残余 —— 上厕所偷看 / 纽扣·微型·针眼·伪装 摄像头 / 商场 CD / 抄了个底 / 公交地铁 偷摸·被摸 / 英文 groping
    for (const [n, tn] of [['陪朋友上厕所时偷看', '网红头条'], ['纽扣摄像头记录', '国产自拍'], ['微型摄像头偷录', '国产自拍'], ['针眼摄像头', '国产自拍'], ['伪装摄像头', '国产自拍'], ['商场CD合集', '国产自拍'],
        ['地铁CD系列', '国产自拍'], ['抄了个底', '国产自拍'], ['地铁上偷摸美女屁股', '国产自拍'], ['公交车上被摸', '国产自拍'], ['Public Groping On Bus', '欧美'], ['Groped On The Train', '欧美']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:voyeur', 'p9 复核二 必拦 voyeur: ' + n, r.reason);
        ok(P9.checkQuery(n) === true, 'p9 复核二 搜索词拦: ' + n);
    }
    for (const [n, tn] of [['CD伪娘合集', 'TS专区'], ['Grope 某动画 第1话', '激情动漫'], ['SSIS-658 電車裡被摸的人妻', '人妻熟女'], ['把微型摄影机塞进身体', '欧美激情']])
        ok(r9(n, tn).reason !== 'item:voyeur', 'p9 复核二 不误拦为 voyeur(CD = 伪娘 / 剧本电车 / 塞进身体的摄影机): ' + n, r9(n, tn).reason);
    ok(P9.checkQuery('cd伪娘') === false, 'p9 复核二 搜索词不误拦: cd伪娘');
    // 误伤修正:毒品类名词不查 vod_tag(犯罪片剧情标签);片名里照拦
    ok(chk({ vod_name: '某合成犯罪片', type_name: '香港伦理', vod_tag: '某合成犯罪片,毒品,毒贩,扫毒' }, {}).ok && chk({ vod_name: '某合成影片', type_name: '欧美', vod_tag: '欧美,大麻,成人' }, {}).ok,
        'p9 复核二 vod_tag 里的 毒品 / 大麻 不拦');
    ok(chk({ vod_name: '某合成犯罪片', type_name: '香港伦理', vod_sub: '毒品派对' }, {}).reason === 'item:drugging', 'p9 复核二 副名里的 毒品 照拦');
    // 误伤修正:失神 的否决词 窒息 不算 到窒息 / 至窒息 / 窒息按摩 / 裤袜…窒息;窒息操 / 窒息性爱 照拦;"的陪酒女…遭" 太远不算定语
    for (const n of ['SSIS-659 裤袜按摩 呼吸困难到窒息失神', 'SSIS-660 深喉至窒息 猛干到失神', 'SSIS-661 紧身裤袜按摩,窒息失神', 'SSIS-662 连续内射到失神的女招待某某遭粗暴对待']) {
        const r = r9(n, '日本有码');
        ok(r.ok && r.review === 'code', 'p9 复核二 失神 + 窒息比喻 = code(不拦): ' + n, r);
    }
    for (const n of ['SSIS-664 骑乘窒息操 干到失神', 'SSIS-665 窒息性爱 狂干失神']) ok(r9(n, '日本有码').reason === 'item:drugging', 'p9 复核二 窒息操 + 失神 照拦: ' + n);
    // ---- p9 复核三(对抗复核第四轮)。全部是合成标题 / 去掉人名的真实形态 ----
    // blocker 1:兴奋剂 回到 fail-closed —— "X的兴奋剂"(下药)照拦,有可信番号也拦;只放过窄的比喻句式
    for (const [n, tn] of [['NGHJ-038 一位企业运动员尝试精油按摩!他偷偷使用了大量的兴奋剂,里面添加了许多不正当的成分', '日本有码'], ['SSIS-940 偷偷给她用了强效的兴奋剂', '日本有码'],
        ['在她的饮料里加入了特制的兴奋剂', '国产自拍'], ['往按摩油里混了大量的兴奋剂', '国产自拍'], ['给女运动员用了违禁的兴奋剂后狂操', '国产自拍'], ['涂满了高浓度的兴奋剂精油', '国产自拍'],
        ['NGHJ-038 躍動!アスリートがオイルエステに挑戦!エッチな成分たっぷりのドーピングを内緒で', '日本有码'], ['SKMJ-696 素人娘6名 ドーピング過剰摂取', '日本有码'], ['兴奋剂', '国产自拍']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核三 必拦 兴奋剂 / ドーピング: ' + n, r.reason);
        ok(P9.checkQuery(n) === true, 'p9 复核三 搜索词拦: ' + n);
    }
    for (const [n, tn] of [['SSIS-310 就把我当作你的兴奋剂', '国产传媒'], ['像吃了兴奋剂一样', '国产自拍'], ['像打了兴奋剂一样狂干', '国产自拍'], ['如同兴奋剂般的快感', '国产自拍'], ['成为你的兴奋剂', '国产自拍'],
        ['SONE-100-C 俺のドーピング巨根', '日本有码'], ['DSJH-013 ドーピング検査で', '日本有码']]) {
        const r = r9(n, tn);
        ok(r.ok && r.review === null, 'p9 复核三 兴奋剂 / ドーピング 比喻·检查 不拦: ' + n, r);
        ok(P9.checkQuery(n) === false, 'p9 复核三 搜索词不误拦: ' + n);
    }
    // blocker 2:破解 / 黑客 + 隔开几个字的 摄像头·探头·更衣室、医院 / 安防 / 出租房 / 家里装 摄像头、摄像头解密 / 被骇、TP(= 偷拍)
    for (const [n, tn] of [['黑客破解医院摄像头正规医院妇科产检', '精品推荐'], ['黑客破解家庭网络摄像头白领小夫妻的夜晚', '国产人妻'], ['骇客破解家庭探头窥视辑夫妻居家', '国产人妻'],
        ['破解游泳会所女更衣室小姐姐们身材都不错', '精品推荐'], ['破解小饭店摄像头小老板和服务员', '精品推荐'], ['免费福利-欧美摄像破解,两对情侣浴室4p', '欧美精品'], ['家庭网络摄像头胖哥急匆匆的干媳妇', '精品推荐'],
        ['出租房网络摄像头打工蜗居夫妻', '国产人妻'], ['高清安防摄像头初尝禁果', '网红头条'], ['办公室摄像头工厂老板与女会计', '精品推荐'], ['摄像头解密新婚夫妻在客厅直接开操', 'SWAG'], ['家庭摄像镜头被骇小情侣在家', '国产自拍'],
        ['窥视女生宿舍的秘密', '精品推荐'], ['STOL-115 高阶男士美容院的隐藏式摄影机镜头', '日本有码'], ['老公故意出差家里装监视器终于拍到', '精品推荐'], ['家中提前布置好摄像头,俩少妇上门服务', '国产探花'],
        ['趁女主洗澡安好摄像头后拉她出来操', '国产自拍'], ['在隔壁高楼拿着摄像机往下拍24', '精品推荐'], ['360水滴年轻情侣的开房实录', '探花嫖娼'], ['【摄像头实录】小嫂子和小叔子在沙发上', '嫂子诱惑'],
        ['TP厕录貌美年轻姑娘', 'SWAG'], ['国内民间大神多场景TP妹子洗澡', '国产自拍'], ['【精品TP】海边隔板浴室TP各种小姐妹换衣服', '乱伦毁三观'], ['重磅稀缺TP某温泉会所各种美女浴室换衣', '国产自拍'],
        ['约了个少妇TP啪啪', '国产自拍'], ['[TP]约到极品长发少妇', '国产裸聊'], ['情趣酒店TP中年男女', '偷情少妇']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:voyeur', 'p9 复核三 必拦 voyeur: ' + n, r.reason);
        ok(P9.checkQuery(n) === true, 'p9 复核三 搜索词拦: ' + n);
    }
    for (const q of ['TP妹子洗澡', 'TP厕录', '骇客破解家庭探头', '黑客破解家庭网络摄像头', '酒店TP', '摄像头破解']) ok(P9.checkQuery(q) === true, 'p9 复核三 搜索词拦: ' + q);
    // 欧美 webcam 秀(主播自己对着网络摄像头)、TP 开头的番号 / 厂牌编号(TPPN- / TP-030 / TP.PN-)、DP·TP(英文)、水滴奶、剧本片的拍摄机位 —— 不拦
    for (const [n, tn] of [['两名辣妹实时网络摄像头自慰', '欧美明星'], ['网络摄像头情侣 100% 天然胸 性爱', '欧美明星'], ['TP.PN-256(中字)苗条美女连续中出', '中文字幕'], ['我的私人健身教练.兔子先生TP-030', '国产传媒'],
        ['TPPN-201 某某', '日本有码'], ['DP TP Gangbang', '欧美'], ['水滴奶美女自慰', '国产自拍'], ['OFJE-546从下面窥视SEX最色情', '日本有码'], ['这摄像头放床头,超近距离快贴到脸上去了', '国产自拍'],
        ['TPIN-023 某某', '日本有码'], ['欧美TP三穴大战', '欧美'], ['女黑客在浴室自慰', '国产传媒']]) {
        ok(r9(n, tn).reason !== 'item:voyeur', 'p9 复核三 不误拦为 voyeur(webcam 秀 / 番号 / 英文 TP): ' + n, r9(n, tn).reason);
    }
    for (const q of ['网络摄像头', 'TPPN-256', 'tp-030']) ok(P9.checkQuery(q) === false, 'p9 复核三 搜索词不误拦: ' + q);
    // blocker 3:下药同义词(淫药 / 发情药 / 性欲增强剂 / 迷恋药 / 违禁药品 / 拷問ドラッグ / Mドラッグ / 吃下X药)与睡眠失能的残余说法 —— 有可信番号也拦
    for (const [n, tn] of [['淫药喷雾强驯女上司', '制服丝袜'], ['女上司误吸淫药喷雾', '制服丝袜'], ['MNGS-009 被淫药浸泡后变身', '日本有码'], ['SONE-880 淫药按摩院', '日本有码'], ['SSIS-941 淫薬漬けの人妻', '日本有码'],
        ['值班护士 极恶淫药侵入', '国产自拍'], ['22禽兽小伙发情药肏完亲姐姐', '原创乱伦'], ['DJDT-009 我给她注射了100倍浓缩的性欲增强剂', '日本有码'], ['报复专横姐姐!100倍性欲剂注射', '伦理三级'],
        ['情欲汤屋-偷偷让我吃下X药 还把我玩到坏掉', '国产视频'], ['偷偷让她吃下×药', '国产视频'], ['MUKC-081迷恋药让淫乱觉醒', '日本有码'], ['STSK-166 赏樱【女生喝酒,摇晃,违禁药品,高潮】', '日本有码'],
        ['GTJ-149 拷問ドラッグ', '主奴调教'], ['GTJ-130 Mドラッグ 女体肉便器', '强奸乱伦'], ['SORA-623 药水浸泡~被绑架~倒下', '日本有码'], ['给她喝了发情水', '国产自拍'],
        ['奸睡邻家小可爱', '角色剧情'], ['喵喵小护士睡梦遭凌虐爆操', '国产自拍'], ['FNS-141 睡梦巨乳人妻被狗式爆操', '日本有码'], ['DOCP-291 睡梦之中就被别人玩出水', 'AV解说'],
        ['女友还在睡、我继续操', '抖阴视频'], ['【乱伦小姨子】偷看小姨子睡觉,掀开被子发现小穴湿漉漉,忍不住放进去了', '乱伦'], ['【乱伦】姐姐正在睡觉,看到姐姐这性感大屁股,忍不住把姐姐上了', '乱伦'],
        ['Mature Man Caught Sleeping Poor Girl And Fucked Her', '欧美劲爆'], ['SMKD-011 完全昏 – 4人 – 高尔夫教练(37岁)', '日本-无码流出'], ['SORA-648 被跟踪、入室抢劫、昏、5P', '日本有码'],
        ['FHQG-989 已婚妇女遭伏击,被锁喉昏,随心所欲地玩弄', '日本有码'], ['MUKC-103 醉酒女仆:从早灌到昏,3P内射', '高潮喷吹'], ['MD-0203薰香麻醉女租客', '国产乱伦']]) {
        const r = r9(n, tn);
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核三 必拦 下药同义词 / 睡眠失能: ' + n, r.reason);
        ok(P9.checkQuery(n) === true, 'p9 复核三 搜索词拦: ' + n);
    }
    for (const q of ['淫药', '淫薬', '发情药', '性欲增强剂', '迷恋药', '违禁药品', '拷問ドラッグ', 'ドーピングを内緒で', '吃下X药', '奸睡', '睡梦遭凌虐', '喂药', '喂了药']) ok(P9.checkQuery(q) === true, 'p9 复核三 搜索词拦: ' + q);
    // 单字 昏 是性行为导致的(痉挛…快要昏)= 审查级 code,不硬拦;黄昏 / 头昏 不算;ドラッグストア / 发情期 / 违禁 / 药学 不算;旁人在睡(姐姐在旁边睡觉 / 老公在隔壁睡觉时)/ 叫醒 / 睡梦诱惑 不算
    {
        const r = r9('KDMN-043 猛烈抽插!!痉挛喘絶快要昏', 'SM调教');
        ok(r.reason !== 'item:drugging' && r.review === 'code', 'p9 复核三 单字 昏 + 性行为 = 审查级 code', r);
    }
    for (const [n, tn] of [['黄昏 恋人', '伦理片'], ['头昏 脑胀的人妻', '国产自拍'], ['黄昏★恋人', '伦理片'], ['STARS-534 ドラッグストアでアルバイトする地味女子', '角色剧情'], ['发情期的人妻', '国产自拍'], ['流了好多发情水', '国产自拍'],
        ['违禁品检查', '国产自拍'], ['SIRO-4970 G罩杯×药学学生', '日本素人'], ['姐姐在睡觉姐夫就在旁边操小姨子', '姐夫小姨子'], ['嫂子妈妈在隔壁睡觉嫂子被我内射', '91视频'],
        ['最享受老公就在隔壁睡觉时,被野男人猛干到腿软', '国产传媒'], ['海角叔嫂乱伦哥哥睡觉时猛操 嫂子', '国产乱伦'], ['SONE-876 除了睡覺時間,下面永遠濕答答的人妻', '日本有码'], ['极品短裙美女还在睡觉拉起来再干一炮', '国产自拍'],
        ['老公在睡觉时偷偷和邻居做爱', '国产自拍'], ['叫醒正在睡觉的男友做爱', '国产自拍'], ['与女天狗的激情睡梦诱惑', '成人动漫'], ['这就是所谓的睡梦杀', '三级伦理'],
        ['Secret Date With My Stepsister While Our Parents Are Sleeping', '欧美'], ['Chooses Intense Sex Over Sleeping', '欧美'], ['Sleeping With My Wife\'s Sister', '欧美'], ['中药水浸泡足疗', '国产自拍']]) {
        ok(r9(n, tn).reason !== 'item:drugging', 'p9 复核三 不误拦为 drugging(旁人在睡 / 叫醒 / 黄昏 / ドラッグストア): ' + n, r9(n, tn).reason);
    }
    // major:review:code 的睡奸 / 昏睡奸 说法升成硬拦(昏● / 昏レプ / 睡眠轮奸 / 睡眠レイプ / 眠らされ / 睡強姦 / 睡觉时接连OO / 睡着人被人干 / 吃掉睡觉儿子…)—— 有可信番号也拦
    for (const n of ['MUKD-555 睡眠轮奸爆操内射', 'MIAB-153 睡眠轮奸 掐脖子中出', 'CLUB-908 ベビーカー人妻付きまとい昏●レ●プ', 'CLUB-908 ベビーカー人妻付きまとい昏レプ', 'SHKD-967 昏●レ●プされた転校生',
        'CLUB-894 巨乳OL付きまとい拉○昏●○姦', 'EBWH-186 昏●させ性処理対象として', 'REAL-900 昏●強制', 'ADN-313 変態整体師に昏●マッサージされた', 'HEZ-757 熟女患者を昏〇診察', 'NGOD-217 他所の男達に眠らされ舐められ犯された妻',
        'HUNBL-100 女友朋友們在睡覺時接連OO', 'SONE-886 睡着人被人干', 'YSN-519 即使睡觉时也持续侵犯我的日常', 'DVDMS-999 偷偷吃掉睡覺兒子老二的母親', 'DVRT-010 偷偷玩弄睡覺中的兒子肉棒的媽媽',
        'STARS-898 每天5小時的逆睡強姦', 'SHKD-951 昏レプされた優等生', 'SSIS-942 睡眠レイプ', 'SSIS-943 睡眠輪姦', 'GVH-581 巨乳モニタリング睡眠レ×プ', 'LJ-0006 邻居爸爸在我睡觉时激情抽插',
        'MIMK-271 允许在睡觉时随意使用她身体的同学', 'AVSA-087 睡觉时房间偷偷潜入三匹恶魔']) {
        const r = r9(n, '日本有码');
        ok(!r.ok && r.reason === 'item:drugging', 'p9 复核三 必拦 睡奸 / 昏睡奸(原来只是 code): ' + n, r.reason);
    }
    for (const q of ['睡眠轮奸', '睡眠レイプ', '昏レプ', '昏●レ●プ', '眠らされ', '逆睡強姦', '睡觉时接连OO', '睡着人被人干']) ok(P9.checkQuery(q) === true, 'p9 复核三 搜索词拦: ' + q);
    // minor:新误伤修正 —— 熟女高● / 去溜冰 / 局部麻醉 / 麻醉女医生·大四麻醉女 / 中学时代的前男友 / 男方 醉醒 / 奸尸道长
    for (const [n, tn] of [['淫乱熟女高●', '国产自拍'], ['和女友去溜冰场约会', '国产自拍'], ['美女隆胸手术局部麻醉全纪录', '国产自拍'], ['PRTD-020 性感缺乏症的麻醉女医生被开发', '日本有码'],
        ['医大大四麻醉女某某背着男友', '日本无码'], ['SDAB-304 与中學時代的前女友重逢', '日本有码'], ['SDAB-305 中学時代の元カレと再会', '日本有码'], ['奸尸道长', '伦理片']]) {
        const r = r9(n, tn);
        ok(r.ok && r.reason === undefined && r.review === null, 'p9 复核三 误伤修正(放行且不是审查级): ' + n, r);
    }
    for (const [n, want] of [['清纯女高●', 'item:minor'], ['SDAB-153 中学时代的学弟', 'item:minor'], ['SSIS-944 中学時代の同級生と再会', 'item:minor'], ['SDAB-304 篮球部顾问在援交与中學時代的前OO', 'item:minor'], ['溜冰助兴合集', 'item:drugging'], ['麻醉女生后侵犯', 'item:drugging'],
        ['SSIS-945 全身麻醉后被侵犯', 'item:drugging'], ['劫匪掐死后奸尸', 'item:drugging']])
        eq(r9(n, '国产自拍').reason, want, 'p9 复核三 误伤修正的边界照拦: ' + n);
    {
        const r = r9('IPZZ-541 醉醒惊见半裸辣妹,巨乳翘臀狂插到失神', '日本有码');
        ok(r.ok && r.review === 'code', 'p9 复核三 男方 醉醒 不算 醉 否决词(失神 仍是 code)', r);
        for (const n of ['SSIS-946 人妻酒醒前被狂干到失神', 'SSIS-947 被灌醉醒来后又被干到失神', 'SSIS-948 醉酒后被干到失神']) eq(r9(n, '日本有码').reason, 'item:drugging', 'p9 复核三 女方醉着(酒醒前 / 灌醉)照拦: ' + n);
    }
    // minor:私密视频被卖(泄露);暗访 → 审查级 filter(永不推荐、做 FILTER_EXTRA 复查);悪い子(搾→榨 折叠后 強制搾精 的例外不再放松它)
    for (const n of ['神仙颜值网红私房视频被无良摄影师高价售出', '少妇被男友骗色最后性爱私拍视频都被便宜卖了']) eq(r9(n, '主播秀色').reason, 'item:leak', 'p9 复核三 私密视频被卖 = 泄露: ' + n);
    ok(r9('已婚妇女被卖给黑帮', '日本有码').ok && r9('SSIS-949 私密影片被卖掉了', '日本有码').ok, 'p9 复核三 被卖给… / 可信番号片的剧情 不算泄露');
    for (const [n, tn] of [['【暗访足疗】骚女技师骑乘位', '国产自拍'], ['暗访足疗店勾搭漂亮女技师', '美女主播'], ['女记者暗访光棍村', '国产传媒']]) {
        const r = r9(n, tn);
        ok(r.ok && r.review === 'filter', 'p9 复核三 暗访 = 审查级 filter: ' + n, r);
    }
    eq(r9('暗访会所约到前女友', '国产自拍').reason, 'item:filter', 'p9 复核三 暗访 + 前女友 → item:filter');
    eq(r9('ILLUSIONサキュバスの強制搾精悪い子にはお仕置きよ', '卡通动漫').reason, 'review:code', 'p9 复核三 悪い子 = 审查级 code');
    ok(r9('巨乳技师强制榨精', '国产自拍').ok && r9('巨乳技师强制榨精', '国产自拍').review === null, 'p9 复核三 中文 强制榨精 仍放行');
    // 严格站:简介里的 失神 / 気絶 / 昏厥 只靠 ITEM_REVIEW_CODE 判(unconHit 只看标签性字段)→ hide
    for (const c of ['被干到失神', '高潮到気絶', '干到昏厥']) eq(chk({ vod_name: '某某合成', type_name: '爱播资源', vod_content: c }, { strict: true }).reason, 'review:hide', 'p9 复核四 严格站简介里的 ' + c + ' → hide');
    // ---- p9 复核四(对抗复核第五轮)。测试串只用最短的触发标签(不写情节,不写涉及未成年 / 亲属的描写)----
    const blk4 = (list, want, tag) => {
        for (const x of list) {
            const [n, tn] = Array.isArray(x) ? x : [x, '国产自拍'];
            const r = r9(n, tn);
            ok(!r.ok && r.reason === want, 'p9 复核四 ' + tag + ' 必拦 ' + want + ': ' + n, r.reason);
            ok(P9.checkQuery(n) === true, 'p9 复核四 ' + tag + ' 搜索词拦: ' + n);
        }
    };
    const pass4 = (list, tag, allowReview) => {
        for (const x of list) {
            const [n, tn] = Array.isArray(x) ? x : [x, '国产自拍'];
            const r = r9(n, tn);
            ok(r.ok && (allowReview || r.review === null), 'p9 复核四 ' + tag + ' 放行: ' + n, r);
            ok(P9.checkQuery(n) === false, 'p9 复核四 ' + tag + ' 搜索词不误拦: ' + n);
        }
    };
    // 回退修复 1:兴奋剂 —— 如同·犹如 这一支要有比喻结尾;任何一支前面紧挨着投药动词、后面跟着 的药 / 东西 / 饮料 / 气体 都不算比喻
    blk4(['她被下了如同兴奋剂的药', '给她注射了如同兴奋剂的药物', '在饮料里加入如同兴奋剂的药粉', '偷偷给她用了犹如兴奋剂的东西', '被灌了好比兴奋剂的饮料', '让她吸入作为我们的兴奋剂的气体',
        '在她酒里下了如同兴奋剂的东西', '被打了一针仿佛兴奋剂的药', '被喂了好比兴奋剂的药丸', '下了跟兴奋剂一样的东西', '如同兴奋剂', ['SSIS-950 被下了宛如兴奋剂的药', '日本有码']], 'item:drugging', '兴奋剂');
    pass4(['如同兴奋剂般的快感', '犹如兴奋剂的感觉', '像吃了兴奋剂一样', '像打了兴奋剂一样', ['SSIS-310 就把我当作你的兴奋剂', '国产传媒']], '兴奋剂 比喻');
    // 回退修复 2:溜冰 = 冰毒 黑话(出来溜冰 / 来溜冰 / 去溜冰 都拦);只放过 溜冰鞋 / 场 / 馆 / 课 / 教练 / 运动 / 比赛
    blk4(['约她出来溜冰', '叫两个人来溜冰一起嗨', '带去溜冰', '会所里一起溜冰'], 'item:drugging', '溜冰');
    pass4(['和女友去溜冰场约会', '溜冰馆', '溜冰课', '溜冰教练', '溜冰运动会', '溜冰比赛', '脱掉溜冰鞋'], '溜冰 场所');
    // 回退修复 3:打码的 女高●(女高中生 / 女高校生)只有 熟女 / 妇女 / 母 / 妻 这些不可能是未成年的前缀才放过
    blk4(['少女高●', '少女高●●', '美女高●', '女高●'], 'item:minor', '打码 女高');
    pass4(['淫乱熟女高●', '妇女高●'], '打码 熟女高');
    // 回退修复 4:局部麻醉 / 大X·研X 麻醉 只在后面 12 个字里没有 被 / 侵犯 / 动弹 / 昏 / 不省… 时放行
    blk4(['局部麻醉后不省人事', '被打了局部麻醉全身动弹不得', '大三麻醉后被带走', '研二麻醉后昏迷'], 'item:drugging', '局部麻醉');
    pass4(['美女隆胸手术局部麻醉全纪录', '研二麻醉课题', '大四麻醉专业考试'], '局部麻醉 放行');
    // 回退修复 5:中学时代的前任 只在明写 重逢 / 再会(且后面没有 初体验 / 回忆 / 那时…)时放行
    blk4(['中学时代的前任', '中学时代的前任回忆', '中学时代的前任重逢后回忆当年'], 'item:minor', '中学时代');
    pass4([['SDAB-306 与中學時代的前女友重逢', '日本有码'], ['SDAB-305 中学時代の元カレと再会', '日本有码']], '中学时代 重逢');
    // 回退修复 6:醉醒 / 酒醒 只放过"男方醉醒、看见一个女人"(IPZZ-541);喝醉醒来 / 宿醉醒来 / 发现自己… 照算女方醉着
    blk4(['她喝醉醒来后又晕倒了', '宿醉醒来已昏厥', '酒醒后发现自己不省人事', '醉醒前就失神了', ['SSIS-954 酒醒后失去意识', '日本有码'],
        // 下面三条走"失神 / 结果词"的审查级路径:复核三 把 醉醒 整个当成不算醉,它们会降成 review:code
        '喝醉醒来后失神', '宿醉醒来晕厥的感觉', ['SSIS-955 酒醒后晕厥的感觉', '日本有码']], 'item:drugging', '醉醒');
    {
        const r = r9('IPZZ-541 醉醒惊见半裸辣妹 失神', '日本有码');
        ok(r.ok && r.review === 'code', 'p9 复核四 男方醉醒看见女人 = 审查级 code(不硬拦)', r);
    }
    // 回退修复 7:奸尸道长 只放过单独的片名
    blk4(['奸尸道长夜里挖坟'], 'item:drugging', '奸尸道长');
    pass4([['奸尸道长', '伦理片']], '奸尸道长 片名');
    // 召回 1:泄露 —— 爆出 / 怒曝 / 怒爆 / 爆料 / 直播事故 / 忘关摄像头 / 公开其…视频 / 发到网上(没有可信番号的一律拦)
    blk4(['网红被爆出跟金主的视频', '分手后被男友爆出', '网友爆出视频', '被老公怒曝', '现男友怒爆出轨视频', '最新爆料', '斗鱼主播直播事故', '女主播下播忘关摄像头', '上网课忘关摄像头',
        '换衣服没关摄像头', '公开其性爱视频', '视频被我发到网上', '某艺人视频被黑客入侵电脑爆出'], 'item:leak', '泄露');
    pass4(['口爆出来了', '劲爆出品', '引爆出轨话题', '愤怒爆射', '火爆出演'], '爆出 / 怒爆 的修辞用法与可信番号', true);
    // (p9 复核六:可信日本番号片的 直播事故 条目照样放行,但查询不看番号 —— 同一个番号挂在国产分区时条目被拦,搜同名也要拒绝)
    ok(r9('SSIS-123 直播事故', '日本有码').ok && P9.checkQuery('SSIS-123 直播事故') === true, 'p9 复核六 可信番号 + 直播事故:条目放行、查询拒绝');
    ok(r9('MD0306 好声音爆出潜规则', '国产传媒').ok, 'p9 复核四 可信的国产片商番号 + 爆出(剧本)放行');
    // 召回 2:流出 的液体放行只认紧跟的单字 / 两字以上的液体词(精品 / 大奶 / 无水印 / 混血 不再算液体)
    blk4(['最新流出-精品力荐', '最新流出无水印原档', '作品流出大奶反差', '福利流出 露奶艳舞', '国内流出精品视频', '最新流出·乌克兰混血'], 'item:leak', '流出');
    pass4(['流出了好多水', '流出大量白浆', '流出浓精', '流出乳白色的液体', '流出忍耐汁', '流出豆浆', '精液一点点流出'], '流出 液体');
    // 召回 3:吃瓜 的同义(新瓜 / 热瓜 / 猛瓜 / 瓜友 / 瓜料 / 流传的瓜 / X的瓜)与 X事件 / X门 真人框架
    blk4(['开年新瓜', '抖音热瓜', '重磅猛瓜', '瓜友投稿', '劲爆瓜料', '最近流传的瓜', '某花店老板娘的瓜', '#精选 优衣库事件', '某网红洗漱台事件', '露脸裸聊事件', '快手网红陪睡大哥事件', '试衣间黑炮事件',
        '名师工作室', '【某省教师门】', '会议门:书记与主任', '成都富婆门完整版', '某医院3P门'], 'item:leak', '瓜 / 事件 / 门');
    pass4(['黄瓜自慰', '西瓜', '破瓜实录', '瓜田李下', '推开宿舍门,看到室友', '打开房门', '送货上门', '快递员上门'], '瓜 / 门 的普通用法');
    // 召回 4:下药同义词
    blk4(['眉药按摩', '药醉', '专挑男客下猛药', ['IPZZ-735 吃药性爱', '日本有码'], ['EBWH-183 药物诱导', '日本有码'], ['GTJ-143 M药', '日本有码'], 'M藥物', '药物酷刑', '酷刑药物',
        '药物绑架', '强力药物腌制', '药效发作', ['MUKC-081 药效觉醒', '日本有码'], '药已到手', '被下催●药', '催药NTR', '被OD过量服用', '药物让她入睡', '用药全部放倒', '趁他吃药无力反抗', '三年药瘾',
        '在药里加点料', '被灌发情液体', '捡到的醉女', '醉女拾遗', '酒醉女子捡回家', '将9名喝醉的女人捡回家', '【禁薬カルテ】'], 'item:drugging', '下药');
    pass4(['伟哥药效发作', '吃了伟哥药效上来', ['GSY-035 抖M药剂师小姐', '日本有码'], '禁药检查', '24小时不眠性爱', '发情期的人妻'], '下药 误伤');
    // 召回 5:睡眠 / 失去意识 的说法(只用标签词与中性句式)
    blk4([['NPJS-012 寝姦', '日本有码'], ['AT-178 睡眠カン', '日本有码'], ['AT-173 睡眠テロパコ', '日本有码'], '眠性交', '在她昏时', '在昏状态下', '沉睡人妻', '沉睡趁机', '沉睡后遭',
        '睡中的人', '寢著的人', '深眠女子', 'ノンレム睡眠女子', '睡●すやすや', '公园で爆睡', '打瞌睡被', '睡到一半被', '睡觉到一半就被', '道端で寝てたギャル', '睡太熟被闯入', ['DOCD075 眠泄漏影片', '日本有码'],
        ['STSK-041 睡眠营业培训', '日本有码'], '寝静まった女を', 'In Her Sleep', 'while she was sleeping', '她入睡后偷偷', ['AKDLD-323 夜寝てたら', '日本有码'], ['BIWW-023 眠る男', '日本有码']], 'item:drugging', '睡眠');
    pass4(['唤醒沉睡中的绝顶快感', '还在睡就被老公叫醒', '正在睡觉被电话吵醒', '头晕眼昏', '睡梦般的被窝', '和老公一起睡觉前', '老公入睡后偷偷出门'], '睡眠 误伤', true);
    // 召回 6:偷拍
    blk4(['偷看她洗澡', '偷看裙底', 'KTV厕窥', '窥视 尿尿', '公交地铁窥胸', '拍胸族', '遭窥拍', '秘密摄像头全记录', ['FSET-776 还偷偷地拍摄下来', '日本有码'], ['393OTIM-338 集團跟蹤OL投稿映像', '日本有码'],
        '跟蹤套裝女子記錄', '居家监视记录', '地铁跟踪', '窥探女子宿舍', '偷藏的摄像头', '偷藏的摄像的头', '给同事桌下装了个摄像头', '丈夫暗中拍下', '总觉得有摄像头在拍我', '找了一圈摄像头',
        '一直看摄像头?难道被发现了', '还以为没有人看到结果被拍了', '「監視器下的畫面」', '被跟踪的秘密镜头'], 'item:voyeur', '偷拍');
    // p9 复核五:场所 + 摄像头 只在 对着·在…摄像头(前)+ 自慰·直播·表演… 时放行;单独的"办公室的摄像头前"照拦(复核四曾放行)
    blk4(['办公室的摄像头前'], 'item:voyeur', '偷拍(复核五)');
    pass4(['用家用摄像机记录夫妻生活', '家庭摄像机拍摄的夫妻', '女黑客勾引摄影师', '对面楼的邻居约我拍照', '提前装好摄像机和女友自拍', '趁老公不在架好摄像机直播',
        '破解版厕所游戏', '摄影偷情', ['CAWD-803 AV出道前的秘密镜头', '日本有码'], ['SIRO-5206 害怕被拍照的女孩', '日本素人'], ['DVMM-352 跟踪拍摄到高潮', '日本有码']], '偷拍 误伤', true);
    // 召回 7:未成年(只用年龄 / 打码 / 学制标签本身)
    blk4(['才9岁', '8岁女孩', ['BBTU-084 ○リータ', '日本有码'], ['104DANDY-870 J○Ver', '日本有码'], ['ABW-284 ドSJ●に', '日本有码'], ['BBAN-477 市立●野女子●等学校', '日本有码'],
        ['KAGP-229 少女○生', '日本有码'], 'ランドセル', '正在发育', '学う生妹', ['SDAB153 中学う时代', '日本有码']], 'item:minor', '未成年');
    pass4(['25岁的人妻', '大5岁的御姐', '二十五岁的人妻'], '未成年 误伤', true);
    ok(r9('有5岁孩子的人妻', '国产自拍').reason !== 'item:minor', 'p9 复核四 N岁孩子(母亲)不按未成年硬拦(孩子 仍是审查级 code)');
    // 水印假名:只删夹在汉字 / 数字中间的 う·イ·ト·ヘ;美う少女 → 美少女(不再误当成 少女)
    ok(r9('SDAB157 美う少女', '日本有码').ok && r9('SDAB157 美う少女', '日本有码').review === null, 'p9 复核四 水印假名 美う少女 = 美少女');
    eq(r9('TURA352 自作の昏ト睡薬', '日本有码').reason, 'item:drugging', 'p9 复核四 水印假名 昏ト睡 = 昏睡');
    eq(r9('某某未公开视频流う出', '日本无码').reason, 'item:leak', 'p9 复核四 水印假名 流う出 = 流出');
    ok(r9('思う存分', '日本有码').ok, 'p9 复核四 真日文 汉字+う+汉字 不受影响');
    // major:英文的 学校 / 同学 / 校服 / 醉酒 = 审查级 code;sex tape … leaked
    for (const n of ['After School Special', 'In Her School Uniform', 'A Girl From School', 'Classmate Reunion', 'Drunk Night Out', 'DANCING DRUNK']) eq(r9(n, '欧美').reason, 'review:code', 'p9 复核四 英文 school / drunk = code: ' + n);
    for (const n of ['Hiking Sex Tape Video Leaked', 'fullsex Tape Leakabbey.']) eq(r9(n, '性感网红').reason, 'item:leak', 'p9 复核四 sex tape … leaked: ' + n);
    // minor:泥醉 / 性侵 / 監禁記録·入室盗窃 / 跟踪狂 / 〇眠(打码的 催眠)= 审查级 code
    for (const n of ['DASS-559 泥醉', '性侵', 'SHIND-051 跟踪狂M的入室盗窃记录', 'SHIND-079 粘着ストーカーMの監禁記録', '[zombie]_〇眠アプリ']) {
        const r = r9(n, /^[A-Z]/.test(n) ? '日本有码' : '国产自拍');
        ok(r.review === 'code' || r.reason === 'review:code', 'p9 复核四 审查级 code: ' + n, r);
    }
    for (const n of ['蹂躏', '隔壁人妻破门而入', '(18禁アニメ) ダークストーカーズ']) ok(r9(n, '国产自拍').review === null, 'p9 复核四 蹂躏 / 破门而入 / ダークストーカー 不是审查级: ' + n);
    // 覆盖(复核四 integrity):这些规则 / 例外删掉任何一个,本测试都应失败
    for (const n of ['镜头窥视夫妻', '水滴直播间夫妻', '睡梦之中的人妻', '还在睡就被搬走', '睡觉中的人妻', '被男友掐到晕', '她被锁喉晕了', '给她吃了×药', '黑入某某摄像', '駭客某某摄影机', '入侵他家摄影机', '黑进探头',
        '破解会所浴室', '破解商场厕', '家里摄像头', '家中探头', '医院摄像头', '诊所摄像头', '病房摄像机', '妇科摄像头', '工厂摄像头', '厂房摄像头', '小区摄像头', '公寓摄像头', '酒店探头', '摄像头被骇', '摄像头被駭',
        'ドーピングを内緒', 'ドーピングをこっそり', 'ドーピングを盛', 'ドーピングを飲ま', 'ドーピングを打', 'ドーピングを注射', 'ドーピングを大量', 'ドーピング過剰', 'ドーピング过剰', 'ドーピング漬け', 'ドーピングさせ', 'ドーピングされ']) {
        const r = r9(n, '国产自拍');
        ok(!r.ok && /^item:(voyeur|drugging)$/.test(r.reason), 'p9 复核四 覆盖 必拦: ' + n, r.reason);
    }
    eq(r9('わるい子にお仕置き', '国产自拍').reason, 'review:code', 'p9 复核四 覆盖 わるい子 = code');
    for (const n of ['TPPN-256 某某', '欧美TP三穴', '360水滴奶', 'Mドラッグストア', '吃下max药', '汉奸睡衣', '睡梦般的被窝', '睡觉前忍不住摆弄手机', '溜冰馆', '研二麻醉课题', '吃了×药学', '晨昏 定省', '脑子发昏 了', '犯昏 了', '昏昏 欲睡']) {
        ok(r9(n, '国产自拍').reason !== 'item:drugging' && r9(n, '国产自拍').reason !== 'item:voyeur', 'p9 复核四 覆盖 例外不误拦: ' + n, r9(n, '国产自拍').reason);
    }
    // ---- p9 复核五(对抗复核第六轮)。同上:只用最短的触发标签,不写真人名 ----
    const blk5 = (list, want, tag) => {
        for (const x of list) {
            const [n, tn] = Array.isArray(x) ? x : [x, '国产自拍'];
            const r = r9(n, tn);
            ok(!r.ok && r.reason === want, 'p9 复核五 ' + tag + ' 必拦 ' + want + ': ' + n, r.reason);
            ok(P9.checkQuery(n) === true, 'p9 复核五 ' + tag + ' 搜索词拦: ' + n);
        }
    };
    const pass5 = (list, tag, allowReview) => {
        for (const x of list) {
            const [n, tn] = Array.isArray(x) ? x : [x, '国产自拍'];
            const r = r9(n, tn);
            ok(r.ok && (allowReview || r.review === null), 'p9 复核五 ' + tag + ' 放行: ' + n, r);
            ok(P9.checkQuery(n) === false, 'p9 复核五 ' + tag + ' 搜索词不误拦: ' + n);
        }
    };
    const code5 = (list, tag) => {
        for (const x of list) {
            const [n, tn] = Array.isArray(x) ? x : [x, '国产自拍'];
            const r = r9(n, tn);
            ok(r.review === 'code' && (r.ok || r.reason === 'review:code'), 'p9 复核五 ' + tag + ' 审查级 code: ' + n, r);
        }
    };
    // 回退修复 1:摄像头 + 偷(偷情 / 偷欢 / 偷偷 / 偷着 / 偷听)照拦,只放过 偷偷自慰 这类露出;场所 + 摄像头(前)只在 对着·在…(前)+ 自慰·直播·表演 时放行
    blk5(['网络摄像头偷情实录', '摄像头偷欢实录', '摄像头偷偷记录', '摄像头偷情', '摄像头偷着拍', '摄像头偷听', '监视器偷偷记录', '宾馆摄像头前偷情实录', '民宿摄像头前做爱全程', '试衣间监视器前换装',
        '浴室摄像头面前洗澡', '卧室监视器前啪啪', '宿舍摄像头前换衣服', '酒店摄像头前偷情的男女', '澡堂监视器前', '家里摄像头跟前', '在浴室摄像头前洗澡', '对着宿舍摄像头前换衣服'], 'item:voyeur', '摄像头');
    pass5(['对着宿舍摄像头前自慰', '对着摄像头偷偷自慰', '女主播对着网络摄像头自慰', '摄影偷情', '冲着家里摄像头跳舞', '脸红人妻监视~偷偷用按摩棒'], '摄像头 露出');
    // 回退修复 2:睡觉被 X 叫醒 —— 只放过 被(人 / 闹钟 / 电话…)叫醒·吵醒 且后面没有性行为的;被子 / 被窝 后面跟着性行为照拦
    blk5(['睡觉被鸡巴叫醒', '睡觉时被大屌叫醒', '睡觉被肉棒叫醒', '睡觉被子里偷偷操她', '睡觉被窝里内射', '睡觉被窝里被继父猥亵', '睡觉被褥里插入', '睡觉被窝里偷偷摸她', '妹妹睡觉被子被掀开',
        '睡觉时被父亲吵醒继续操', '睡觉被单下被侵犯', '睡觉时被继父吵醒后强奸', '还在睡觉被肉棒叫醒', '还在睡被窝里被插'], 'item:drugging', '睡觉被');
    pass5(['半夜睡觉被吵醒了', '早上睡觉被吵醒了,发现表姐', '睡觉被子没盖好', '睡觉被闹钟吵醒', '睡觉时被妈妈叫醒吃早饭', '还在睡觉就被电话吵醒'], '睡觉被 叫醒', true);
    // 回退修复 3:流出 —— 液体词 + 泄露限定词(独家 / 原版 / 最新 / 绝版)+ 流出 照拦;"精液从粉穴一点点流出"不管后面跟什么(片商后缀)都放行
    blk5(['白浆四溢 独家流出', '淫水泛滥 原版流出', '被灌精液后最新流出', '满脸精液 绝版流出', '白浆原版流出', '白浆四溢独家流出了', '最新流出精华版'], 'item:leak', '流出');
    pass5(['YSSO-740 连续榨精 精液从粉穴一点点流出 精主TV', '糖心Vlog.精液从粉穴一点点流出-精主TV', '精液从粉穴一点点流出', '精液从小穴里缓缓流出 某某传媒', '无毛粉嫩穴内射流出精华', '在震动棒的刺激下流出阴精',
        '调教流出骚汁四溅', '男子迅速缴械流出白精', '淫荡少妇自慰流出超级多水', '从她胸口流出的纯净水', '插的BB流出许多新鲜的酸奶', '马眼流出的前液', '嘴角流出的唾液', '口中不断流出涎水', '流出了老二汁', '中流出的大量人奶'], '流出 液体');
    // 回退修复 4:打码 女高●● —— 只有 熟女 / 妇女 + 一个打码位(= 高潮)放行
    blk5(['母女高●●', '继母女高●●', '人妻女高●●', '熟女高●●', '母女高●'], 'item:minor', '女高●');
    pass5(['淫乱熟女高●', '妇女高●'], '女高● 高潮');
    // 回退修复 5:兴奋剂 如同 / 犹如 —— 的 效果 / 状态 / 存在 不算比喻;同一断句前面有 喝 / 吃 / 产生… 也不算
    blk5(['喝下后产生如同兴奋剂的效果', '犹如兴奋剂的存在', '如同兴奋剂的状态', '喝了一杯就犹如兴奋剂般'], 'item:drugging', '兴奋剂');
    pass5(['如同兴奋剂般的快感', '如同兴奋剂的快感', '她就像兴奋剂一样'], '兴奋剂 比喻');
    // major:泥醉 只查片名 / 副名(av_s03 / av_s25 给无关条目挂 vod_class "泥醉");片名里的 泥醉 照样 code
    {
        const r = chk({ vod_name: '某合成作品 骑乘', type_name: '欧美', vod_class: '泥醉,交合,长身,短髮' }, {});
        ok(r.ok && r.review === null, 'p9 复核五 vod_class 里的 泥醉 不算审查级', r);
        eq(r9('泥醉的人妻', '国产自拍').reason, 'review:code', 'p9 复核五 片名里的 泥醉 = 审查级 code');
        eq(chk({ vod_name: '某合成作品', type_name: '国产自拍', vod_sub: '泥醉' }, {}).reason, 'review:code', 'p9 复核五 副名里的 泥醉 = 审查级 code');
    }
    // major:LEAK_BROAD / LEAK_GATE 只查标签性字段 —— 简介里"巨乳被勒得几乎爆出""公之于众""进了酒店门"是叙述
    for (const c of ['她的巨乳被勒得几乎爆出拉链', '嘴巴的秘密彻底公之于众', '两人进了酒店门,开始', '锁好宿舍门,开始自慰', '敲开教授办公室门']) {
        const r = chk({ vod_name: '某合成作品', type_name: '国产自拍', vod_content: c }, {});
        ok(r.ok, 'p9 复核五 简介叙述不算泄露: ' + c, r);
    }
    for (const c of ['如今挂在网上出租肉体', '这场直播事故让她', '因抢劫和谋杀而入狱20年', '最近爆火的外卖援交事件']) ok(chk({ vod_name: '某合成作品', type_name: '国产自拍', vod_content: c }, {}).ok, 'p9 复核五 简介里的剧情叙述不算泄露: ' + c);
    // 简介里最窄的真人泄露说法照拦(LEAK_PROSE)
    for (const c of ['抖音上那位贵妇竟被爆出深夜密会', '今天就被人爆料给新郎看', '这段视频被发到网上', '私下却是个淫娃这组私拍直接爆出她的', '男友分手后公开其性爱视频'])
        eq(chk({ vod_name: '某合成作品', type_name: '国产自拍', vod_content: c }, {}).reason, 'item:leak', 'p9 复核五 简介里的真人泄露说法照拦: ' + c);
    for (const n of ['芭比.Q了一对情.侣 宾馆门.口啪', '巨乳被勒得几乎爆出', '蜜穴首次公之于众']) ok(r9(n, '国产自拍').reason !== 'item:leak', 'p9 复核五 片名 门口 / 几乎爆出 / 比喻 公之于众 不算泄露: ' + n, r9(n, '国产自拍').reason);
    blk5(['性爱视频被公之于众', '某某药业 某某 出轨女秘书 获刑11年', '豪门恩怨分崩离析', '高校美女某某貌似和男友性爱视频'], 'item:leak', '泄露');
    // minor:爆睡衣 / 口爆睡走 / ドM薬剤師 / 违禁药品(标签)/ 利令智昏 不拦
    for (const [n, tn] of [['极品继母巨乳撑爆睡衣', '欧美'], ['在丈夫面前被人口爆睡走', '日本有码'], ['デカ乳首のドM薬剤師さん', '日本有码'], ['利令智昏', '伦理片']])
        ok(r9(n, tn).reason !== 'item:drugging', 'p9 复核五 不误拦为 drugging: ' + n, r9(n, tn).reason);
    eq(r9('爆睡中の妻', '日本有码').reason, 'item:drugging', 'p9 复核五 爆睡 照拦');
    ok(chk({ vod_name: '某港片', type_name: '伦理三级', vod_tag: '毒品,违禁药品,扫毒' }, {}).ok, 'p9 复核五 vod_tag 里的 违禁药品 不拦(禁药 不再命中 违禁药品)');
    eq(r9('禁药调教', '国产自拍').reason, 'item:drugging', 'p9 复核五 禁药 照拦');
    // 召回 1:打码的未成年标签挨着字母 / 数字(J● 在 spaced 上认)、女●●生 / 現●生 / 新●生 / 小●校、错字谐音 未性年 / 炉利 / 露●塔、平成年份、粘连的 jk
    blk5([['FC2-PPV-1000101 県立全日制 現●J● 18才', '日韩无码'], ['real J〇-cd1', '日韩无码'], ['AARM-149-C J●', '日本有码'], ['FC2-1000102 18歳 LJ◯', '日韩无码'], ['SCB-001 LJ〇', '日韩无码'],
        ['KTRA-259 J○いもうと', '群P换妻'], ['MILK-244 J〇潮特化', '强奸乱伦'], ['禁断J○-cd10', 'VR视角'], ['FC2-1000103 【極上女○○生】', '日韩无码'], ['FC2-1000104 巨乳女〇〇生', '日韩无码'],
        ['FC2-1000105 女◯◯生を学校帰りに', '口交视频'], ['FC2-1000106 現●生', '日韩无码'], ['FC2-1000107 現◯生', '日韩无码'], ['现〇女〇生', '国产自拍'], ['DSVR-1172 新●生', '日本有码'], ['SKMJ-731 本物小●校の教員', '日本有码'],
        ['个人cm未性年', '日韩无码'], ['140#38露●塔', '国产自拍'], ['#144cm#炉利#', '重口色情'], ['N0557 巨乳炉利', '日本无码'], ['【某某Vol.2】平成19年生', '日韩无码'], ['#jk006_制服', '国产自拍'],
        ['LJK 制服', '国产自拍'], ['OLJK', '国产自拍'], ['91CM214JK', '国产传媒'], ['BUR-639 还不能怀孕身高148cm以下', '日本有码'], ['夜晚OO贫乳OO塔白虎', '日本有码']], 'item:minor', '未成年 打码 / 谐音');
    pass5([['GMJK-026 某某', '日本有码'], ['SKJK-016-C 某某', '日本有码'], ['STJK-002 某某', '日本有码'], ['KJK-004 某某', '日本有码'], ['Jcup 爆乳', '日本有码'], ['1LDK 同居', '日本有码'], ['JKT48 某某', '日本有码'],
        '火炉利用', ['美〇女的写真', '国产自拍'], '男女●生活'], '未成年 误伤');
    // 召回 2:思春期 / 青春期(标签性字段;比喻 般·一样、思春期の息子を持つ 除外)/ 青ハル期 / 底辺校 / 入学準備+制服採寸 / 单独成句的个位数岁数;10代 = 审查级 code
    blk5([['DLDSS-030 僕の思春期、毎日セックスをしてくれた姉', '日本有码'], ['91CM-150 弟弟的青春期', '国产传媒'], ['DASD-619 思春期女子と家庭教師', '中文字幕'], ['FC2-1000108 青ハル期真っ只中', '日韩无码'],
        ['FC2-1000109 爱上她的青春期女孩', '日本无码'], ['DAVK-102 底辺校で1番可愛い', '日本有码'], ['底边校最可爱不良辣妹', '国产自拍'], ['DSVR-1172 入学準備 制服採寸', '日本有码'], ['准备入学的制服测量', '日本有码'],
        ['某某撮影。８才、あと１日遅く、生、、ま、れてたら', '素人特摄']], 'item:minor', '青春期 / 底辺校');
    pass5([['259LUXU-1860 拥有青春期般柔软胸部的已婚女性', '日本-素人'], '像青春期一样躁动', '第二青春期的熟女', ['336KNB-057 思春期の息子を持つ人妻', '日本有码']], '青春期 比喻', true);
    code5(['超10代妹子', ['FC2-1000110 【今ドキ10代】', '日韩无码'], '十代的身体'], '10代');
    ok(r9('第10代传人', '国产自拍').review === null && r9('10代目', '日本有码').review === null, 'p9 复核五 第10代 / 10代目 不是 10代');
    // 召回 3 / 4:下药 动词 + 修饰 + 药、椿药 / 烈药 / 药劲 / 被试药 / 媚的药 / k药、给…喂·吃 勃起药、用…药让她、私处涂药 + 痒、性药(= 春药;男方助性除外)、媚●(打码盖掉 薬)/ キメパコ / 発情オイル
    blk5(['情人节下了点药', '约会就被下CY药捆绑', '给儿媳喂性药', '用新药拿下姐姐', '放药放倒玩弄', '教练用椿药放倒学员', '烈药绑架人妻', '买药等药劲到了偷偷玩弄', '却被屌丝试药', '吸了媚的药',
        ['HMN-324-C 误让卧病义妹喝下超强勃起药', '中文字幕'], ['HMN-324 给她吃了超强勃起药', '高清有码'], ['ELIP-192 用勃起药让她疯狂', '日韩无码'], ['MIAA-222 私处涂药结果搔痒到恳求', '制服诱惑'],
        '小姑娘全程露脸吃了性药跟两大哥', '还k药了都停不下来', ['594PRGO-271 媚●漬けにされた彼女', '亚洲有码'], ['HEZ-880 媚●オイルを使って', 'SM调教'], ['QMAE-998 媚○チ〇ポで', '人妻系列'],
        ['[某某]_強力媚●を盛ったら', '剧情故事'], ['SAN-251 20万円の媚●で', '人妻系列'], ['BLK-438 監禁生姦キメパコ中出し', '日本无码'], ['NHDTC047発情オイルまみれ', 'SM调教']], 'item:drugging', '下药');
    pass5(['小伙吃了壮阳药猛插', '自己吃避孕药', '外号炸药的辣妹', '人称毒药的女人', '性药加持猛男', '吃了性药爆草', '妩媚●性感', '药劲猛连干两炮射不出'], '下药 误伤');
    // 召回 5:泥●(打码 泥酔)= 审查级 code;泥● / 泥酔 / 酔い潰れ + 姦·お持ち帰り·監禁·レイ● = 醉奸 / 捡尸(硬拦)
    code5([['IPZZ-246-C BBQ泥●NTR', '中文字幕'], ['JUR-242 泥●するまで飲まされ', '日本有码'], ['某某飲まされ酔わされ', '日本有码']], '泥●');
    blk5([['HONB-479 【泥●姫姦】', '重口激情'], ['HONB-318 クラブお持ち帰り泥●生ハメ', '人妻系列'], ['HUBLK-065 潰れた泥●女を監禁', '重口激情'], ['FC2-1000111 【レイ●·陵辱】酔い潰れていた女を連れ帰って●姦', '素人特摄'],
        ['SSIS-966 泥酔レイプ', '日本有码'], ['SSIS-967 お持ち帰りした泥酔女', '日本有码']], 'item:drugging', '醉奸');
    ok(chk({ vod_name: '某合成作品', type_name: '日本有码', vod_class: '泥醉,强奸' }, {}).reason !== 'item:drugging', 'p9 复核五 醉奸 组合只查片名 / 副名(vod_class 里的 泥醉+强奸 不硬拦)');
    // 召回 6:意識混濁 / 意识混浊 / 昏眠 / 嘞晕
    blk5([['761GESY-007-C 【意識混濁】', '中文字幕'], '中出意识混浊的巨乳美女', ['完全昏眠-4名-', '日本有码'], '剧情演绎 连续嘞晕两个邻居'], 'item:drugging', '失去意识');
    // 召回 7:睡眠失能的常见说法
    blk5([['睡觉的美少女-玩弄', '福利姬'], '涂鸦正在睡觉的女大学生', ['眠る金髪美女を', '日本有码'], ['寝ている姪っ子の', '东南亚AV'], '裸睡的我被表哥', '裸睡被姐夫硬上', '无套中出裸睡的妹妹',
        '每天晚上,当我嫂子睡觉时,高速活塞', ['酔って眠る短パンの隙間から', '日本有码'], ['同窓会で酔って寝ている所を襲われて', '日本有码'], ['マッサージ中に眠ってしまった女性に', '激情口交'],
        '当我睡得入眠时 伯父对我', '妹妹在沙发上睡觉偷偷操喷', '继妹全裸睡觉没关门 突袭强插', '表姐睡觉我舔胸摸奶', ['DRPT-034 偷偷玩弄不穿内裤睡觉的大屁股姐姐', '中文字幕'],
        ['SU-005 潜入睡美人', 'AV明星'], '睡美人被手抠到失禁', '人妻沉睡美人诊间'], 'item:drugging', '睡眠');
    pass5(['唤醒沉睡的欲望', '裸睡的我被姐姐看到', '老婆在隔壁睡觉我和小姨子', '外婆在睡觉我在屋里', '女不睡觉我要操逼', '我哥在楼上睡觉我和嫂子', ['AVJI-250 是位睡美人', '91视频'], '睡觉的时候妈妈进来',
        ['SSIS-983 不让我睡觉的女同事', '日本有码'], '20岁大学生同居女友裸睡发骚'], '睡眠 误伤', true);
    // 召回 8:●撮 / 〇撮 / ●●撮り(打码 盗撮·隠し撮り)
    blk5([['ECBM-005 セクハラ、●撮、', 'SM调教'], ['MILK-228-C インストラクター〇撮', '中文字幕'], ['[3D] ネットで見つけたのは●●撮りされた彼女', '3D'], ['MILK-227 ●撮バレで', '强奸乱伦']], 'item:voyeur', '打码 撮');
    pass5([['某某ハ●撮り', '日本有码'], ['人妻×撮影会', '日本有码'], ['●●撮影会', '日本有码']], '撮 误伤', true);
    // major:拉丁 OO 当打码(挨着中日文);強OO = 审查级 code
    code5(['某某被強OO', '强OO合集'], 'OO 打码');
    ok(r9('BOO继父', '国产自拍').review === null && r9('XOO都', '国产自拍').review === null, 'p9 复核五 字母后面的 OO 不是打码');
    // major:性行为导致的失去意识的口语(意識が飛ぶ / 意识飞走 / 意識崩壊 / 爽晕 / 玩晕 / 舔晕)= 审查级 code;否决词(烂醉 / 狂虐 / 地獄姦)→ 硬拦
    code5([['MXGS-1334 意識がぶっ飛ぶほどイカされまくる', '亚洲有码'], ['DAVK-102-C 意识飞走精液满溢', '亚洲情色'], ['EBWH-146 意識飛ぶ寸前まで射精', '日本有码'], '被爆操到爽晕', ['MFK-0074 被舌头玩晕的邻家女', '国产自拍'],
        ['Siswet被爆操到意识崩坏', '欧美情色']], '性行为致昏');
    blk5([['n1052 意識崩壊ザーメン地獄姦', 'SM调教'], '狂虐老師玩太大直接把妹子玩暈', '把街头烂醉女子带回家 爽过头意识飞走'], 'item:drugging', '性行为致昏 + 否决词');
    // 实测目录复核出来的误伤(新规则的边界):偷窃OO / 强盗OO / OO脸 / 痴女×生 / 現◯女子大生 / 現〇JD / LJK-142 番号 / OO 塔乃(人名)/ 打码的成年岁数 / 母子门 禁忌 / 对白精彩
    for (const [n, tn, bad] of [['VR 偷竊OO輔導手冊', 'V R 视角', 'item:voyeur'], ['ROE-287 看著母親持續被強盜OO', '强奸乱伦', 'item:voyeur'], ['FSDSS-770 甘甜OO脸蛋玩弄乳头', '中文字幕', 'item:deepfake'],
        ['MIKR-011 三個漂亮女OO臉上沾滿精液', '多人群交', 'item:deepfake'], ['PXH-028 美爆尻痴女×生ハメ', '中文字幕', 'item:minor'], ['FC2-1000112 美人現◯女子大生と', '口交视频', 'item:minor'],
        ['FC2-1000113 現◯女◯大の美女', '日韩无码', 'item:minor'], ['FC2-1000114 清楚で可憐な現〇JD', '日本无码', 'item:minor'], ['LJK-142 爆乳寫真偶像', '颜值正义', 'item:minor'], ['MIDA-221 逆恨大小姐OO 塔乃某某', '多人群交', 'item:minor'],
        ['FC2-1000115 某某,18岁,2岁,脸部访谈', 'FC2', 'item:minor'], ['LSV-527 某某(2...1岁),一名大学生', 'AV明星', 'item:minor'], ['FC2-1000116 1..8岁。就读体育大学', 'FC2', 'item:minor']]) {
        const r = r9(n, tn);
        ok(r.reason !== bad, 'p9 复核五 实测误伤不再 ' + bad + ': ' + n, r.reason);
    }
    for (const [n, tn, bad] of [['某某-【二輪車プレイ×最低2発射保証】', '人妻巨乳', 'review:code'], ['FC2-1000117 露出集団**プレイ＆****', '日本无码', 'review:code'], ['F杯-爆乳熟女♥小海媚♥', '国产专区', 'item:drugging'],
        ['女朋友在睡觉偷偷干她闺蜜', '人妻巨乳', 'item:drugging'], ['IPX-780 新入社員歓迎会で酔いつぶれた僕が受付嬢に逆お持ち帰りされ', '日本无码', 'item:drugging'],
        ['PRED-713 社員旅行先で僕が酔い潰れてる間に中出し輪姦されていた', '中文字幕', 'item:drugging']]) {
        const r = r9(n, tn);
        ok(r.reason !== bad && !(bad === 'review:code' && r.review === 'code'), 'p9 复核五 实测误伤不再 ' + bad + ': ' + n, r);
    }
    blk5([['DLDSS-492 女上司、媚⚫️に憑りつかれた', 'SM调教'], ['IENF-045 酔いつぶれた同僚を自宅お持ち帰り', '中文字幕'], ['MIAB-603 狂操烂醉人妻 诱奸', '群交淫乱']], 'item:drugging', '实测 醉奸 / 媚⚫');
    for (const n of ['上海母子乱伦门 禁忌家庭情感体验', '济南母子门 禁忌母子情感纠葛', '【出卖女友】某地女生车震被男友流出-对白精彩有趣']) eq(r9(n, '原创乱伦').reason, 'item:leak', 'p9 复核五 实测 门 禁忌 / 对白精彩 仍是泄露: ' + n);
    // 覆盖(复核五 integrity):复核四新增、此前没有任何输入单独触发的分支 —— 每条只命中一个分支
    blk5(['服用过量', '把她摸醒', '潜入妹妹睡觉时的被窝', '男友在睡觉掏出大屌就要操', '还在睡觉就直接开操', '睡着把我操了', '姐姐睡着了忍不住放进去', '姐姐睡着了没忍住插入',
        '姐姐睡着了悄悄地摆弄', '被od'], 'item:drugging', '覆盖 睡眠 / 过量');
    blk5(['某某极品9岁', '露丽塔', ['FC2-1000131 極上女OO生', '日韩无码']], 'item:minor', '覆盖 极品N岁 / 露丽塔 / 女OO生');
    // 覆盖(复核五 新分支,每条只命中一个)
    blk5(['喂了点勃起药', ['夜中に寝ている所を襲われ', '日本有码'], '中出睡觉的新来女仆', '私处涂了药', '被下了怪药', ['FC2-1000132 【レイ●】酔い潰れていた女', '素人特摄'], ['FC2-1000133 酔い潰れた女をレイ●', '素人特摄']], 'item:drugging', '覆盖 复核五');
    ok(r9('两人进了酒店门 开房', '国产自拍').reason !== 'item:leak', 'p9 复核五 覆盖 进了酒店门 不是 X门');
    eq(r9('某某レイ●', '国产自拍').reason, 'review:code', 'p9 复核五 覆盖 レイ●(打码 レイプ)= 审查级 code');
    blk5(['居家监视', '怀疑有摄像头'], 'item:voyeur', '覆盖 偷拍');
    blk5(['优衣库事件', '网红某某事件', '某某爆出视频', '被男友爆出', '网上爆出', '怒曝', '怒爆出轨', '老公怒爆', '爆料', '直播事故', '忘关摄像头', '没关直播', '公开其性爱视频', '发到网上', '获刑3年', '豪门恩怨'], 'item:leak', '覆盖 LEAK_BROAD');
    for (const n of ['破门入室', '跟踪狂', 'ストーカー']) eq(r9(n, '国产自拍').reason, 'review:code', 'p9 复核五 覆盖 审查级 code: ' + n);
    // 搜索词
    for (const q of ['思春期', '青春期', '底辺校', '未性年', '炉利', '现●生', '女○○生', 'LJK', 'jk006', '平成19年生', '下了点药', '性药', '吃性药', '椿药', '媚●漬け', 'キメパコ', '発情オイル', '泥●姫姦', '意識混濁', '昏眠', '●撮', '裸睡被', '睡觉被鸡巴叫醒', '发情水', '发情液'])
        ok(P9.checkQuery(q) === true, 'p9 复核五 搜索词拦: ' + q);
    for (const q of ['青春期般', 'GMJK-026', 'Jcup', '1LDK', '壮阳药', '避孕药', '炸药', '唤醒沉睡的欲望', '半夜睡觉被吵醒'])
        ok(P9.checkQuery(q) === false, 'p9 复核五 搜索词不误拦: ' + q);
    // ---- p9 复核六(对抗复核第七轮)。只用最短的触发标签,人名一律 某某 占位 ----
    const blk6 = (list, want, tag) => {
        for (const x of list) {
            const [n, tn] = Array.isArray(x) ? x : [x, '国产自拍'];
            const r = r9(n, tn);
            ok(!r.ok && r.reason === want, 'p9 复核六 ' + tag + ' 必拦 ' + want + ': ' + n, r.reason);
            ok(P9.checkQuery(n) === true, 'p9 复核六 ' + tag + ' 搜索词拦: ' + n);
        }
    };
    const pass6 = (list, tag, allowReview) => {
        for (const x of list) {
            const [n, tn] = Array.isArray(x) ? x : [x, '国产自拍'];
            const r = r9(n, tn);
            ok(r.ok && (allowReview || r.review === null), 'p9 复核六 ' + tag + ' 放行: ' + n, r);
            ok(P9.checkQuery(n) === false, 'p9 复核六 ' + tag + ' 搜索词不误拦: ' + n);
        }
    };
    const not6 = (list, bad, tag) => {   // 条目不再是 bad(查询词可能因为别的词另行拒绝,这里不管)
        for (const x of list) {
            const [n, tn] = Array.isArray(x) ? x : [x, '国产自拍'];
            const r = r9(n, tn);
            ok(r.reason !== bad, 'p9 复核六 ' + tag + ' 不误拦为 ' + bad + ': ' + n, r.reason);
        }
    };
    // blocker:ロリ 紧跟片假名词 / 隔空格跟片假名词;拟声词 / 外来词照样放行
    blk6([['KTRA-450 ミニマムロリ子とデカチン性交', '日本有码'], ['HEYZO 0274 パイパンロリモデルの撮影会', '日本无码'], ['DOA-035 爆乳Iカップ ロリロリ美少女', '日本有码'], 'ガチロリマグワイ',
        ['EBWH-003 甘サドロリ巨乳とイカせ合い対決', '日本有码'], 'ブルマ ロリ美少女', 'ロール ロリな体', 'キツキツロリマン', '逆ナンロリびっち', 'チビマンロリBOX', 'カワロリちゃん', 'ネオロリ'], 'item:minor', 'ロリ');
    pass6(['カロリー', 'フロリダ', 'ポロリ', '水着ポロリ', 'ハプニングポロリ', 'ペロリ', 'エロリスト', 'エロリーマン', 'エロテロリスト', 'ベロリンガール', 'テロリスト', 'グロリア', 'ドロリ濃厚',
        'エロリューションズ', 'エロリズム', 'セロリ', 'ジロリと睨む', 'キャロリン', 'マロリー', 'エロテロリ。。', 'ポフロリ'], 'ロリ 拟声词 / 外来词');
    // blocker:補導 / 発育盛り / 2004年生 / 2005年生 / 平成16年生 / 円光 + 制服·娘の親友 / 女OO + 制服·电车
    blk6([['NEXT-001 金曜 午後9時 補導前', '日本有码'], ['午後9時 補導前02 チビギャルからの秘密の相談', '日本有码'], '【2004年生】P活で补导された', ['【2005年生】某某', '日韩无码'],
        ['FC2-1000140 2005年生まれDカップ', '日韩无码'], '平成16年生まれ', ['MVSD-644 姪っ子の発育盛りのお', '日本有码'], '與發育正當時的拖油瓶', ['[4K]ROOM-046 円光ドキュメント Bカップ制服美少女', '日本有码'],
        ['- 娘の親友ギャルと円光日記', '日本无码'], ['10musume_081425_01 在火車上對穿制服的女OO惡作劇', '制服丝袜'], ['AMBI-191 美麗的女OO在製服中出', '制服诱惑']], 'item:minor', '補導 / 年份 / 円光');
    // 県立③全日制 / 県立普通科 / 都立商業科のクラスメイト(在读高中生框架);…の先生 / 卒 / 県立図書館 / 私立女子大学 不算
    blk6([['FC2-1000160 【個撮】県立③全日制 某某', '日韩无码'], ['FC2-1000161 県立普通科①無垢な色白少女', '日韩无码'], ['FC2-1000162 都立商業科のクラスメイト', '日韩无码'], ['FC2-1000163 県立进学校テニス部', '日韩无码']], 'item:minor', '県立全日制');
    pass6([['SSIS-993 県立高校の先生', '日本有码'], ['SSIS-994 都立高校卒の人妻', '日本有码'], ['ACZD-993 県立図書館の司書', '日本有码'], ['300MIUM-993 私立パコパコ女子大学', '日本有码']], '県立全日制 误伤', true);
    pass6([['DRPT-084 地味巨乳補導員', '日本有码'], ['KNAM-012 完ナマSTYLE ＃初めての生円光', '日本有码'], '2010年生活', ['420HPT-033 某某（24）美丽的女OO', '日本有码']], '補導員 / 円光 / 年生活 / 女OO');
    // minor:思春期.com(厂牌名)/ 19岁青春期 / J⚫︎A(U+FE0E 选择符)不再误拦;クラスの美少女 / 醉妹 = 审查级 code
    not6([['SHIC-309 诱惑家庭教师的痴女259分 思春期.com', '制服丝袜'], ['思春期.comザ・ベスト8時間', '长腿丝袜'], '19岁青春期弟弟', ['FC2PPV 1000141 元J⚫︎A航空CA', '无码专区']], 'item:minor', '思春期.com / 19岁 / J⚫︎A');
    for (const [n, tn] of [['[4K]T28-641 クラスの美少女に家を占領されて', '日本有码'], ['クラスメイトの誘惑', '日本有码'], ['HBAD-693 巨乳醉妹酒会沦陷', '日本有码'], ['某某激情3P醉妹', '抖阴短片'], ['強盗●●事件', '国产自拍']]) {
        const r = r9(n, tn);
        ok(r.review === 'code', 'p9 复核六 审查级 code: ' + n, r);
    }
    ok(r9('トップクラスの美女', '日本有码').review === null && r9('Aクラスの女', '日本有码').review === null, 'p9 复核六 トップクラス / Aクラス 不是 クラス(同学)');
    // blocker:日文下药 / 中文迷奸黑话 / 下药说法
    blk6([['NHDTB-83902 クスリを飲まされ女体炎上', '日本有码'], ['某某が痺れ薬を開発して中出し', '日本有码'], ['集団しびれ薬 男子校', '日本有码'], ['密室空間で利尿剤を盛られてお漏らし START-481', '日本有码'],
        ['FTHTD-089 女上司にスプレーを吸わせてたら', '日本有码'], ['FANH-006 某某さん 脱法オイル爆イキ', '日本有码'], ['●法ドラッグ混入アロマオイルの罠', '日本有码'], '绝顶高潮！下薬性欲4.2倍',
        ['MIAA-222 マ○コが死ぬほどカユくなる薬を塗った結果', '日本有码'], '《经典✅死猪玩》御姐KTV消遣被暗中下料', '大神变态死猪玩边调边肏', '极品妹子全程死猪一般随意摆弄', ['有人将一颗药丸混入她的蛋白粉 START-445', '日本有码'],
        '吃了加料的麻辣烫和姐夫在客厅搞起', '白雪公主吃完被加料的蘋果', '惨遭老公要药献给肌肉猛男', ['MCY-0225 神奇药水让我操上妈妈', '国产传媒'], '色情医师给你妹妹注射药物', '让娇蛮堕姬喝下毒药 用肉棒教训她',
        '拖油瓶用藥滿滿做愛', ['偷偷在肛門上塗抹壯陽藥', '日本有码'], ['喷雾乱伦中出，我的妹妹是我的听话娃娃 DVRT-025', '日本有码'], ['HEYZO 3449 淫乱秘书饮药后骚穴泛滥', '日本无码'], '清纯女药后狂淫求肏被猛干',
        '在厕所纸上喷了性爱喷雾'], 'item:drugging', '下药');
    not6(['二表哥好像偷偷喷药了', '加料版', '加料内容', '人称毒药的女人'], 'item:drugging', '下药 误伤');
    // major:灌醉 + 性侵 / 被灌醉(有可信番号也拦);"把老公灌醉后…"是旁人
    blk6([['SNIS-967 跟男友出席同學會被灌醉輪姦', '日本有码'], '大二學姐被灌醉猥褻', ['SCOP-457 女友被灌醉睡走', '中文字幕'], ['EBOD-796-C 灌醉巨乳妹诱骗带回家', '中文字幕'],
        ['NKKD-147 昨天晚上迷迷糊糊上的', '日本有码'], '极品小美女酒后迷糊状态下被3P', '大奶美女和男友宿醉迷糊开房被操'], 'item:drugging', '灌醉 / 迷糊');
    not6(['把老公灌醉后和邻居偷情', '小迷糊被操'], 'item:drugging', '灌醉 / 迷糊 旁人·昵称');
    // blocker:睡眠失能的其他说法
    blk6([['WAAA-021 昏昏欲睡 舔阴', '日本有码'], ['WAAA021昏昏欲睡う舔阴.', '日本有码'], ['NHDTB-951 女友妹妹性知識昏昏欲睡,隔著褲子攻擊陰蒂', '日本有码'], '打扫卫生打盹累了的老婆从内裤边插了一根肉棒',
        '我舔了一位打瞌睡的女同事', ['親友の彼女が寝ぼけて僕の布団に入ってきたので、我慢出来ずにヤリまくった。', '日本有码'], ['ATID-425 女友睡迷糊了挤到了我被窝中被没忍住的我干了个爽', '日本有码'],
        ['PASN-031 半梦半醒的柔软……电击般的恶作剧。', '日本有码'], '早上起来趁她还迷糊时插入', '馬子在睡覺硬是給她摸起來操一砲', '帶著眼罩正在睡覺推門進去摸胸', '姐姐还在睡觉弟弟提着抢进来要干',
        '胖叔带喝的有点迷糊的妹子开房', '某某草醒了妹子主动迎合', ['眠り姫魔姦', '日本有码'], ['XYZ 某某 Sleeping Sex HD720p', '亚洲无码'], ['睡眠営業', '日本有码'], ['寝てる所を夜這', '日本有码']], 'item:drugging', '睡眠');
    not6(['老公在打盹我和邻居做爱', '把昏昏欲睡的小女友搖醒啪啪', '紫薇瞌睡送枕头大肉棒来到', '叫醒还在睡觉的奶茶妹啪啪', '还在睡觉拉起来再干一炮', ['MIDV-946 睡眼惺忪的某某 用晨勃硬挺的阴茎让她高潮', '中文字幕'],
        ['爆睡中の彼氏の横で、バレないようにNTRセックス', '中文字幕'], '昏昏 欲睡'], 'item:drugging', '睡眠 误伤');
    eq(r9('爆睡中の妻', '日本有码').reason, 'item:drugging', 'p9 复核六 爆睡中の妻 照拦(只放过 爆睡中の彼氏の横で 这类旁人)');
    // blocker:破解云摄像头 / 黑客破解 / 偷录说法 / 【上帝视角】/ 抖音走光合集
    blk6(['《萤石云破解》中年大叔和美女下属情趣酒店开房', '《乐橙云破解》小哥带着女友开房', '《黑客破解》眼镜哥浴缸房猛操小女友', '【黑客破解】某公司高管与女秘书偷情', '- 未經許可錄製：不情願的戴綠帽性愛影片',
        ['【个撮·不伦旅行】温泉へ行ってこっそり撮影した一部始终', '日本有码'], '某某约啪在校大学生 厕所操（全程不知道）', ['326PAPA-015 【パパ活潜入】カメラがバレるハプニング', '日本有码'],
        '带她回家，趁她洗澡时忍不住开门偷', '【翻车探花】空姐制服少妇开始就质疑有摄像头', '【上帝视角】人妻宾.馆开.房与.友激情啪.啪偷情', '【上帝视角】白嫩.大奶美.女被小.伙毫不.留情的.爆干',
        '上帝视角 1-16 小情侣酒店开房', '上帝视角欣赏年轻情侣开房造爱', '.【稀缺资源】抖音快手网红直播间～不慎漏点走光大合集', '_抖音走光闪现_奶子刚刚好一把抓', '虎牙主播换衣.间意外露.点'], 'item:voyeur', '偷拍');
    pass6(['女黑客破解密码后', '老公全程不知道', '网易直播某某订制揉奶骚舞上帝视角', '哺乳期少妇直播上帝视角看B', '#某某_大奶熟女直播洗澡，上帝视角观看_丝袜自慰', ['SNQ-230 上帝视角在酒店房间门口和窗外露出做爱', '日本有码'],
        '走光', ['JUR-858 打扫卫生时，不慎走光', '日本有码'], '巨乳肥臀主播自慰漏点', ['MIDV-752 一场名为微比基尼拍摄的未经授权的拍摄中', '中文字幕']], '偷拍 误伤');
    // precision blocker:场所 + 摄像头 的放行只剩 对着·对准·面对·冲着·朝着 + 家里·家中·卧室·宿舍 + 自慰·直播·表演·秀·自拍·跳舞(复核五的 在 / 酒店 / 脱衣 / 展示 放得太宽)
    blk6(['情侣在酒店摄像头前脱衣啪啪', '少妇在浴室摄像头下脱衣洗澡', '女租客在出租屋摄像头下脱衣服', '在宾馆摄像头前展示身材', '在酒店摄像头前直播', '在酒店的摄像机前自慰', '对着家庭摄像头自慰',
        '对着卧室摄像头脱衣'], 'item:voyeur', '场所摄像头(复核六收窄)');
    pass6(['对着宿舍摄像头前自慰', '冲着家里摄像头跳舞', '对准卧室摄像头直播'], '场所摄像头 露出');
    // blocker:泄露 —— 無断公開·配信·販売 / 復讐動画 / リベンジポルノ / 未经许可发布 / 黑客盗取 / 手机被黑 / 热搜 / 发到XX群 / 手机里被发现 / 厕所事件 / 性侵视频
    blk6([['534IND-092 自宅でのハメ撮り映像を无断配信', '日本有码'], ['326PAPA-013 パパ活女子の痴態を無断公開して元本回収', '日本有码'], '連続種付けSEXを無断配信！', ['FC2PPV 1000150 彼女を騙し、無断販売。', '日韩无码'],
        '应召女本番 打破规矩无断公开', ['DWD-072 投稿個人撮影 キモ男ヲタ復讐動画', '日本有码'], ['CNW-454 リベンジポルノ！', '日本有码'], ['- 未經許可發布！ 營業部中期', '无码专区'], '黑客入侵电脑爆出私拍视频',
        '【黑客盗取】某模特公司面试资料', 'MBMA005 手机被黑！黑客盗取素人私密淫乱视频', '抖音热搜·某局长出轨女经理老婆发现后将视频发到公务员群', '【全网热搜】某地屋顶酒吧厕所事件',
        '【兄妹乱伦】妹妹手机里的偷偷自慰自拍被我发现', '某某性侵视频之甲 1'], 'item:leak', '泄露');
    pass6([['SSIS-001 無断で中出し', '日本有码']], '無断中出し 是剧情');
    // precision blocker:流出 —— 泄露限定词 / 真人来源词在 流出 前面时液体豁免不算;单字 道 只认 阴道;无码流出 要番号或日本分区且没有真人泄露标记
    blk6(['最新流出白浊内射', '独家流出母乳喷射', '网红白浊流出', '私拍白浊流出', '网红经血流出', '某某白浆直接流出', '网红流出先走り', '某某私下听话母狗视频惨道流出', '[无码流出] 修手机意外解锁人妻骚货隐藏淫照',
        ['抖音爆乳女神【某某】私密性爱视频无码流出', '日本无码'], ['[无码流出] 95年警花沦为富商胯下母狗', '日本无码']], 'item:leak', '流出');
    pass6([['[无码流出] SSIS-001 某作品', '日本无码'], ['[无码流出] 某作品', '日本无码'], ['caribbeancom040324-001 噴精快手 某某精選', '无码流出'], 'RLMP-005 阴道内流出阴道液', '无套内射流出浓液',
        '淫语教科书，大鸡吧骚逼等淫秽词语频频爆出', ['无码破解版长腿女神某某最新作品', '无码流出'], '巨乳女内射自拍 还在镜头前擦拭流出来的', 'YSSO-990 精液从粉穴一点点流出 精主TV'], '流出 误伤');
    ok(r9('SOE-419【无码流出版】某某', '反差母狗').ok, 'p9 复核六 番号可疑(日本番号挂在 反差 分区)的 无码流出版 放行');
    eq(r9('[无码流出] 某作品', '国产自拍').reason, 'item:leak', 'p9 复核六 国产分区里没有番号的 无码流出 = 泄露');
    // precision blocker:AI-某某 / Al—某某(真人明星换脸;分类名 AI剧情、AI 生成 / 修复类说法、罗马字名里的 Ai 不算)
    blk6(['AI-某某-手.脚并用地帮你打出来射精', 'AI-某某某-女下属为升职献身男上司性交', 'AI-.某某-美腿人妻', 'Al—某某 疯狂猛操射身上', '2019年末巅峰之作！AI人工智慧调教某*×某**绝世美腿双姝',
        'AI某**双穴饥渴难耐遭多人轮番激烈抽插', 'AI某某某 史上最优剧情片', 'AI某某化身空姐', 'AI仿真某某直播开播', '【AI-某某】喜欢黑人巨屌的美少女', 'AI●●脸明星', '明星●●脸视频'], 'item:deepfake', 'AI 换脸');
    pass6(['AI.黑暗圣经 第八集', 'AI高清2K修复 某作品', 'AI画质增强 某作品', 'AI短剧.《某某》', 'AI-美女-合集', 'Ai Example solo scene', '[AI增强]某某作品', ['一村女人一村长', 'AI剧情'],
        'FSTU-030 淫荡比基尼黑 Acme Demo Ai - 某某某', 'HND-689 耳语 Mock Ai - 某某某', 'AI人工修正_最爱BBC的妻子', '甘甜OO脸蛋'], 'AI 换脸 误伤', true);
    // minor:局部麻醉 + 上了·内射·射… / 査询里的 X门·事件·爆出 不看番号(条目照样按分区判)
    blk6(['局部麻醉后医生上了她', '局部麻醉后被内射'], 'item:drugging', '局部麻醉');
    ok(P9.checkQuery('某某乱伦门 SSIS-001') === true && P9.checkQuery('网红被爆出视频 SSIS-001') === true && P9.checkQuery('某某热搜出轨 SSIS-001') === true, 'p9 复核六 查询里的 X门 / 爆出 / 热搜 加番号也拒绝(LEAK_SOFT 的 私房视频被卖 + 可信日本番号 照旧放行,同条目)');
    // integrity:此前没有任何测试单独钉住的整条规则 / 有效分支(删掉任何一个本测试都会失败)
    for (const [n, want] of [['露莉塔', 'item:minor'], ['●等学校', 'item:minor'], ['1岁小穴', 'item:minor'], ['平成20年生', 'item:minor'], ['跟踪猥亵', 'item:voyeur'], ['监视记录', 'item:voyeur'],
        ['摄像在拍我', 'item:voyeur'], ['窃●', 'item:voyeur'], ['骇客摄像', 'item:voyeur'], ['摄像被入侵', 'item:voyeur'], ['镜头被黑', 'item:voyeur'], ['道端寝', 'item:drugging'], ['寝てた女', 'item:drugging'],
        ['过量服用', 'item:drugging'], ['操醒', 'item:drugging'], ['涂药搔痒', 'item:drugging'], ['睡觉的女神', 'item:drugging'], ['寝てる同僚', 'item:drugging'], ['●脸', 'item:deepfake'],
        ['捉奸事件', 'item:leak'], ['伴娘事件', 'item:leak'], ['私房视频被贩卖', 'item:leak']]) {
        eq(r9(n, '国产自拍').reason, want, 'p9 复核六 覆盖 ' + want + ': ' + n);
    }
    for (const n of ['酔わされ', '饮まされ酔', '监禁奸', '入室盗']) eq(r9(n, '国产自拍').reason, 'review:code', 'p9 复核六 覆盖 审查级 code: ' + n);
    // 覆盖(复核六新分支,每条只命中一个分支)
    blk6(['2004后的嫩妹', '电车里的女OO', '对女OO恶作剧'], 'item:minor', '覆盖 复核六 未成年');
    blk6(['大学生情侣酒店开房上帝视角拍摄', '抖音女主播露点', '某某走光集锦'], 'item:voyeur', '覆盖 复核六 偷拍');
    blk6(['御姐被暗中下料带到宾馆', '御姐被人下料带到宾馆', '在她肛门上涂抹了药', '偷偷在她身上涂了药', '巨乳人妻被灌醉'], 'item:drugging', '覆盖 复核六 下药');
    blk6(['黑客入侵她的电脑', '女友手机被黑', '出轨事件上了热搜', '局长出轨上了热搜', '偷情视频不小心发到小区微信群', '母狗视频惨道流出'], 'item:leak', '覆盖 复核六 泄露');
    not6(['把老公灌醉后被邻居操'], 'item:drugging', '覆盖 复核六 灌醉 旁人');
    eq(r9('SOE-419【无码流出版】某某网红私拍', '反差母狗').reason, 'item:leak', 'p9 复核六 覆盖 番号可疑时 无码流出 再看真人标记');
    pass6(['AI剧情 某某作品'], '覆盖 复核六 AI 生成类说法', true);
    ok(chk({ vod_name: '某某作品', type_name: '国产自拍', vod_class: 'AI原创' }, {}).ok, 'p9 复核六 覆盖 AI-人名 只查片名 / 副名(分类 / 标签里的 AI原创 不算)');
    // integrity:兴奋剂 比喻判定的护栏 —— 每个投药动词 / 药物载体 / 同句投药词单独钉住(删掉任何一个,对应的串就会被当成比喻放行)
    for (const v of ['下', '注射', '打', '灌', '喂', '吸', '吸入', '服', '服用', '用', '吃', '喝', '加', '加入', '掺', '掺入', '混', '混入', '放', '放入', '涂', '喷', '塞', '偷偷'])
        eq(r9('她' + v + '像兴奋剂一样', '国产自拍').reason, 'item:drugging', 'p9 复核六 兴奋剂 投药动词(紧挨着): ' + v);
    for (const c of ['药', '薬', '物', '东西', '粉', '液', '水', '饮料', '饮品', '酒', '气体', '烟', '雾', '剂', '针', '丸', '片', '胶囊', '精油', '油'])
        eq(r9('像兴奋剂一样的' + c, '国产自拍').reason, 'item:drugging', 'p9 复核六 兴奋剂 药物载体: ' + c);
    for (const v of ['喝', '吃', '服', '注射', '下了', '产生', '吸入', '灌', '喂', '打了', '用了', '加入', '掺'])
        eq(r9('她' + v + '了一整瓶如同兴奋剂般', '国产自拍').reason, 'item:drugging', 'p9 复核六 兴奋剂 同句投药词: ' + v);
    // integrity:醉奸(DRUNK_ASSAULT)与 打码 泥● 组合的每个分支
    for (const h of ['泥酔', '泥醉', '酔潰れ', '酔い潰れ', '酔いつぶれ', '烂醉', '爛醉'])
        for (const t of ['姦', 'レイプ', '犯され', '犯す', '轮奸', 'お持ち帰り', '連れ帰', '捡', '監禁', '拉致'])
            eq(r9('某某' + h + 'の女を' + t, '日本有码').reason, 'item:drugging', 'p9 复核六 醉奸: ' + h + ' + ' + t);
    for (const t of ['姦', 'レイプ', 'お持ち帰り', '監禁', '拉致', '連れ帰']) for (const h of ['泥酔', '酔い潰れ', '酔いつぶれ'])
        eq(r9('某某' + t + 'した' + h + 'の女', '日本有码').reason, 'item:drugging', 'p9 复核六 醉奸(倒序): ' + t + ' + ' + h);
    for (const n of ['泥●女を姦', '泥●レイプ', '泥●レ●プ', '泥●レイ●', '泥●監禁', '泥●拉致', '泥●お持ち帰り', '姦した泥●', '監禁泥●', '拉致泥●', 'レ●プ泥●', 'レイ●泥●', 'レイプ泥●', 'お持ち帰り泥●',
        '泥酔レ●プ', '泥酔レイ●', '泥酔●姦', 'レ●プ泥酔', 'レイ●泥酔'])
        eq(r9('某某' + n, '日本有码').reason, 'item:drugging', 'p9 复核六 打码 泥●: ' + n);
    // integrity:失去意识 的否决词(有否决词时 性行为导致 也不降级为 code)
    for (const v of ['醉酒', '喝酒', '灌醉', '睡', '眠', '闯入', '入室', '跟踪', '尾随', '尾行', '伏击', '锁喉', '扼颈', '掐着脖子', '闷住', '掐死', '勒住', '捂晕', '首絞め', '窒息', '绑架', '绑走', '劫持', '掳',
        '拐走', '诱拐', '囚禁', '监禁', '拉致', '袭击', '偷袭', '突袭', '奇袭', '殴', '揍', '暴打', '毒打', '拳打', '趁', '狂虐', '地狱奸'])
        eq(r9('某某' + v + ' 干到昏死过去', '日本有码').reason, 'item:drugging', 'p9 复核六 否决词: ' + v);
    for (const v of ['醉', '酒醒前', '灌醉', '灌酒', '灌药', '药', '迷药', '锁喉', '扼颈', '掐着脖子', '闷住', '掐死', '勒住', '捂晕', '首絞め', '窒息', '殴', '揍', '暴打', '毒打', '拳打', '狂虐', '地狱奸'])
        eq(r9('某某' + v + ' 干到失神', '日本有码').reason, 'item:drugging', 'p9 复核六 失神 否决词: ' + v);
    // 搜索词
    for (const q of ['パイパンロリ', 'ミニマムロリ', 'ガチロリ', '補導前', '补导', '死猪玩', '暗中下料', '萤石云破解', '乐橙云破解', '黑客破解', '黑客盗取', '無断配信', '無断公開', '復讐動画', 'クスリを飲まされ',
        '痺れ薬', 'しびれ薬', '脱法ドラッグ', '昏昏欲睡', '打瞌睡', '打盹', '寝ぼけ', '半梦半醒', '眠り姫', 'sleeping sex', '厕所事件', 'AI-某某-', '睡眠営業', '性侵视频', '2005年生'])
        ok(P9.checkQuery(q) === true, 'p9 复核六 搜索词拦: ' + q);
    for (const q of ['カロリー', 'フロリダ', 'ポロリ', 'エロリスト', '補導員', '円光', '走光', '上帝视角', 'AI高清', 'AI短剧', '加料版', '无码流出', '瞌睡送枕头'])
        ok(P9.checkQuery(q) === false, 'p9 复核六 搜索词不误拦: ' + q);
    // integrity blocker:兴奋剂 比喻判定原来每个匹配都回看整个前缀(平方复杂度,20 万字 5 秒);现在只看固定窗口
    {
        const s = '如同兴奋剂般'.repeat(Math.ceil(200000 / 6)).slice(0, 200000);
        const t0 = Date.now();
        chk({ vod_name: s, type_name: '国产自拍' }, {});
        const s2 = s.slice(0, 40000);
        chk({ vod_name: s2, vod_sub: s2, vod_tag: s2, vod_class: s2, vod_remarks: s2, type_name: '国产自拍' }, {});
        ok(Date.now() - t0 < 1500, 'p9 复核六 perf: 20 万字的 如同兴奋剂般 不再是平方复杂度', Date.now() - t0);
    }
    // 金丝雀 / 本测试 / 自检里不得出现真人账号:KBJ 直播的 kbj<日期>_<账号> 一律用 kbj00000000_ 占位(曾抄进一个真实主播账号)
    {
        const own = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') + fs.readFileSync(path.join(FIX, 'canaries.json'), 'utf8') + fs.readFileSync(path.join(LIB, 'policy.js'), 'utf8');
        eq((own.match(/kbj[0-9]{6,}/gi) || []).filter((m) => !/^kbj0+$/i.test(m)), [], 'p9 复核二 测试 / 金丝雀 / 自检里没有真实 KBJ 账号(用 kbj00000000 占位)');
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
    const short = { vod_name: '这个妹子好主动', type_name: '爱播资源', vod_class: '抖阴短片,抖阴短' };
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
