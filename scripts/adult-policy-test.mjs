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
    for (const [n, tn] of [['拜倒在石榴裙下', '伦理片'], ['试衣间自拍', '国产自拍'], ['商场试衣间里偷情', '国产自拍'], ['试衣间对着镜子边拍边干', '国产视频'], ['厕所偷情', '国产自拍'],
        ['偷看继妹洗澡后忍不住上了她', '国产大制作']]) {
        ok(r9(n, tn).reason !== 'item:voyeur', 'p9 复核 不误拦为 voyeur(试衣间偷情 / 剧本里的 偷看…洗澡): ' + n, r9(n, tn).reason);
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
        ['性药女代理服务客户', '传媒剧情'], ['午夜迷情', '国产自拍'], ['迷情按摩', '伦理片'], ['深喉吞下过量精液', 'AV明星'], ['口服过量合集', '欧美系列'], ['女主播吃了性药自慰', '抖阴视频'],
        ['高潮脸是男人的性药', '精品推荐'], ['Cock Overdose Part 1', '3D动漫'], ['用药睡觉', '国产自拍']]) {
        ok(r9(n, tn).reason !== 'item:drugging', 'p9 复核二 不误拦为 drugging(助性 / 否定 / 比喻): ' + n, r9(n, tn).reason);
    }
    ok(chk({ vod_name: 'SSIS-617 某合成作品', type_name: '韩国伦理', vod_content: 'young men overdosed with gas appear' }, {}).ok, 'p9 复核二 简介里的 overdosed(剧情叙述)不拦');
    ok(P9.checkQuery('吃性药') === false && P9.checkQuery('伟哥') === false && P9.checkQuery('迷情') === false, 'p9 复核二 搜索词不误拦: 吃性药 / 伟哥 / 迷情');
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
    for (const n of ['晕车的美女', '被干得晕乎乎的女孩', '爽晕了']) ok(r9(n, '国产自拍').ok && r9(n, '国产自拍').review === null, 'p9 复核二 晕车 / 晕乎乎 / 爽晕 不是审查级: ' + n, r9(n, '国产自拍'));
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
