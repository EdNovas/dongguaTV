#!/usr/bin/env node
// [adult] 片名身份识别离线测试(lib/adult/title.js,零网络):
//   node scripts/adult-title-test.mjs
// 覆盖:番号抽取与归一化键(JAV / 数字前缀厂牌 / 国产厂牌补 4 位 / FC2 / HEYZO / 日期式无码 / KBJ)、
//   占位番号与可疑番号(2609 系 JUL-123 之类、非日本分类里的日本番号、整站假番号 siteTrust:false)、codeOk 白名单、
//   版本标记(无码流出/-U → #U,中字,解说片段,4K)、标题键繁简/噪声词归一、演员(只给有把握的;吃瓜/主播类不抽)、
//   searchVariants(番号只发 [带横杠, 不带横杠],绝不发光秃秃的厂牌;文本加简体)、workKey(跨站同番号同键)。
// 改 lib/adult/title.js 后必跑。失败退出码非 0。片名全部合成,不含真人姓名。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = require(path.join(ROOT, 'lib/adult/title.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) pass++;
    else { fail++; failures.push(name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });
const P = (n, t) => T.parseTitle(n, t);

// ============ 1. 输出形状 ============
{
    const p = P('SSIS-001 测试片名', '日本有码');
    for (const k of ['code', 'key', 'kind', 'placeholder', 'suspect', 'cleanTitle', 'titleKey', 'actress', 'flags']) ok(k in p, 'shape: 字段 ' + k);
    eq(Object.keys(p.flags).filter((k) => ['uncensored', 'chineseSub', 'leak', 'clip'].includes(k)).sort(), ['chineseSub', 'clip', 'leak', 'uncensored'], 'shape: flags 四个布尔');
    ok(Object.values(p.flags).every((v) => typeof v === 'boolean'), 'shape: flags 全是布尔');
    ok(Array.isArray(p.actress), 'shape: actress 数组');
    const z = P(null);
    ok(z.code === null && z.key === null && z.kind === null && z.titleKey === '' && z.placeholder === false, 'shape: null 输入', z);
    ok(typeof P(12345).titleKey === 'string', 'shape: 数字输入不抛');
}

// ============ 2. 番号抽取 / 归一化键 ============
const CASES = [
    // [name, typeName, code, key, kind]
    ['SSIS-001 测试片名', '日本有码', 'SSIS-001', 'SSIS-001', 'jav'],
    ['[SSIS-001] 测试片名 中文字幕', '中文字幕', 'SSIS-001', 'SSIS-001', 'jav'],
    ['SSIS001 测试片名', '日本有码', 'SSIS-001', 'SSIS-001', 'jav'],
    ['ssis-01 测试', '日本有码', 'SSIS-001', 'SSIS-001', 'jav'],
    ['300MAAN-1007 测试片名', '', '300MAAN-1007', 'MAAN-1007', 'jav'],
    ['1iene00394 测试片名', '', 'IENE-394', 'IENE-394', 'jav-cid'],
    ['MD0315 测试片名', '麻豆传媒', 'MD-0315', 'MD-0315', 'cn'],
    ['麻豆传媒 MD-315 测试片名', '麻豆传媒', 'MD-315', 'MD-0315', 'cn'],
    ['TMW038 测试片名', '天美传媒', 'TMW-038', 'TMW-0038', 'cn'],
    ['蜜桃影像传媒.PMX-167.测试', '蜜桃传媒', 'PMX-167', 'PMX-0167', 'cn'],
    ['FC2-PPV-4953636 测试片名', '', 'FC2-PPV-4953636', 'FC2-4953636', 'fc2'],
    ['FC2PPV 4953636 测试', '', 'FC2-PPV-4953636', 'FC2-4953636', 'fc2'],
    ['HEYZO-2975 测试片名', '日本无码', 'HEYZO-2975', 'HEYZO-2975', 'heyzo'],
    ['Caribbeancom 032826-001 测试片名', '', 'CARIB-032826-001', 'CARIB-032826-001', 'uncen-date'],
    ['1pondo 092926_001 测试片名', '', '1PON-092926_001', '1PON-092926-001', 'uncen-date'],
    ['032826-001 测试片名', '日本无码', 'CARIB-032826-001', 'UNC-032826-001', 'uncen-date'],
    ['kbj-24072340 测试片名', '韩国-主播', 'KBJ-24072340', 'KBJ-24072340', 'kbj'],
    ['某测试片名 有码2024-09-28JKSR-656未知演员', '女优明星', 'JKSR-656', 'JKSR-656', 'jav'],
];
for (const [n, t, code, key, kind] of CASES) {
    const p = P(n, t);
    eq([p.code, p.key, p.kind], [code, key, kind], `code: ${n}`);
}
{
    eq(P('MD0315 甲').key, P('MD-315 乙').key, 'key: 国产 MD0315 / MD-315 同键');
    eq(P('SSIS-001 甲').key, P('SSIS001 乙').key, 'key: 有无横杠同键');
    for (const n of ['普通国产自拍标题', 'Vol 2 合集', 'Top 10 精选', '1080P 高清', '2024-09-28 更新', 'iPhone15 拍摄', 'lucy2027 自拍']) eq(P(n, '国产自拍').code, null, 'code: 没有番号 ' + n);
}

// ============ 3. 占位 / 可疑 / codeOk ============
{
    for (const [n, t] of [['[JUL-123] 人妻测试', '中文字幕'], ['[SSNI-888] 测试', '国产自拍'], ['[SSNI-789] 测试', '欧美性爱'], ['[SSNI-666] 测试', '伦理三级'], ['SSNI-123 测试', ''],
        ['3GU-105 测试', '欧美系列'], ['CAMP-001 测试', '成人动漫'], ['YUA-001 测试', '国产自拍'], ['[FC2-PPV-123456] 测试', '国产裸聊'], ['FC2-PPV-1234567 测试', '']]) {
        const p = P(n, t);
        ok(p.placeholder && p.suspect && !T.codeOk(p), '占位: ' + n, p);
        ok(T.workKey(p).startsWith('t:'), '占位: 不按番号合并 ' + n, T.workKey(p));
    }
    // 真片里"凑数"形状的编号不算占位(样本里多站时长一致)
    for (const n of ['FSDSS-888 测试', 'HMN-888 测试', 'DSOD-111 测试']) ok(!P(n, '日本有码').placeholder, '非占位: ' + n);
    // 非日本分类里的日本番号 = 可疑
    ok(P('SSIS-123 测试', '国产自拍').suspect, '可疑: 国产分类里的日本番号');
    ok(P('SSIS-123 测试', '欧美精品').suspect, '可疑: 欧美分类里的日本番号');
    ok(!P('SSIS-123 测试', '日本有码').suspect, '不可疑: 日本分类');
    ok(!P('SSIS-123 测试', '').suspect, '不可疑: 没有分类名');
    ok(!P('MD0315 测试', '国产传媒').suspect, '不可疑: 国产分类里的国产厂牌');
    ok(P('ABCD-123 测试', '国产主播').suspect, '可疑: 国产分类里的未知厂牌');
    // codeOk
    ok(T.codeOk(P('SSIS-123 测试', '日本有码')), 'codeOk: 白名单 JAV');
    ok(T.codeOk(P('SSIS-123 测试', '日本有码'), { siteTrust: true }), 'codeOk: siteTrust:true');
    ok(!T.codeOk(P('SSIS-123 测试', '日本有码'), { siteTrust: false }), 'codeOk: siteTrust:false 一律不信');
    ok(T.codeOk(P('MD0315 测试', '麻豆传媒')), 'codeOk: 国产厂牌');
    ok(T.codeOk(P('FC2-PPV-4953636 测试')), 'codeOk: FC2');
    ok(T.codeOk(P('HEYZO-2975 测试')), 'codeOk: HEYZO');
    ok(T.codeOk(P('Caribbeancom 032826-001 测试')), 'codeOk: 知道片商的日期式无码');
    ok(!T.codeOk(P('032826-001 测试', '日本无码')), 'codeOk: 不知道片商的日期式无码不算');
    ok(!T.codeOk(P('kbj-24072340 测试')), 'codeOk: KBJ(直播录屏)不算');
    ok(!T.codeOk(P('ZZQX-123 测试', '日本有码')), 'codeOk: 不在白名单的厂牌不算');
    ok(!T.codeOk(P('普通标题')) && !T.codeOk(null) && !T.codeOk({}), 'codeOk: 没番号 / 坏输入');
    ok(T.isJavLabel('ssis') && T.isJavLabel('IPZZ') && !T.isJavLabel('ZZQX'), 'isJavLabel');
    ok(T.isCnPrefix('md') && T.isCnPrefix('91CM') && !T.isCnPrefix('SSIS'), 'isCnPrefix');
}

// ============ 4. 版本标记 ============
{
    const u = P('SSIS-123-U 测试', '日本有码');
    ok(u.flags.leak && u.flags.uncensored, 'flags: -U 后缀 = 无码流出版', u.flags);
    ok(P('【无码流出】SSIS-124 测试', '').flags.leak, 'flags: 无码流出');
    ok(P('SSIS-124 UNCENSORED-LEAK 测试', '').flags.leak, 'flags: UNCENSORED-LEAK');
    ok(P('骑兵破解 SSIS-124 测试', '').flags.leak, 'flags: 破解');
    ok(P('SSIS-124 测试', '骑兵破解').flags.leak, 'flags: 破解分类');
    ok(P('SSIS-124 测试 -无码', '日本-无码流出').flags.leak, 'flags: 无码流出分类');
    eq(T.workKey(P('SSIS-124 测试 -无码', '日本-无码流出')), 'c:SSIS-124#U', 'workKey: 无码流出分类里的有码番号 → #U');
    ok(!P('SSIS-125 中出し精液流出 测试', '日本有码').flags.leak, 'flags: 精液流出 不是流出版');
    ok(!P('HEYZO-2975 测试', '日本无码').flags.leak && P('HEYZO-2975 测试', '日本无码').flags.uncensored, 'flags: 原生无码不是流出版');
    ok(P('SSIS-126-C 测试', '').flags.chineseSub, 'flags: -C = 中字');
    ok(P('SSIS-126 测试', '中文字幕').flags.chineseSub, 'flags: 中文字幕分类');
    ok(P('IPZZ-048 剧情解说', 'AV解说').flags.clip, 'flags: 解说 = 片段');
    ok(P('π377 测试', '').flags.clip, 'flags: 水果派 π 编号');
    ok(P('某测试作品 4K', '').flags.uhd, 'flags: 4K');
    ok(!P('SSIS-127 测试', '日本有码').flags.uncensored, 'flags: 普通有码不是无码');
}

// ============ 5. 净标题 / 标题键 ============
{
    eq(P('【中文字幕】SSIS-128 某某測試片名 1080P', '').cleanTitle, '某某測試片名', 'clean: 去番号/字幕/分辨率噪声');
    eq(P('溫泉旅行 高清', '').titleKey, P('温泉旅行', '').titleKey, 'titleKey: 繁简 + 噪声词归一');
    eq(P('温泉旅行!!!', '').titleKey, P('温泉  旅行', '').titleKey, 'titleKey: 标点空白不计');
    eq(P('温泉旅行 完整版', '').titleKey, '温泉旅行', 'titleKey: 完整版 去掉');
    ok(P('SSIS-129', '').titleKey.length > 0, 'titleKey: 片名只有番号时也不为空');
    ok(P('【】', '').titleKey.length > 0, 'titleKey: 片名全是标点时也不为空');
    eq(T.titleKey('國產 測試'), '国产测试', 'titleKey(): 导出函数');
    eq(T.t2s('換臉'), '换脸', 't2s(): 导出函数');
    const t0 = Date.now();
    const long = P('SSIS-130 ' + '很长的标题'.repeat(5000), '日本有码');
    ok(long.code === 'SSIS-130' && Date.now() - t0 < 300, 'robust: 超长片名不慢', Date.now() - t0);
    ok(P('&amp;amp;amp;#039;SSIS-131&amp;amp; 测试', '').code === 'SSIS-131', 'robust: 多层转义的实体');
}

// ============ 6. 演员 ============
{
    eq(P('ABP-601 测试片名 山田テスト', '日本有码').actress, ['山田テスト'], 'actress: 番号片名后面的日文名');
    eq(P('测试片名有码2024-09-28JKSR-656山田テスト', '女优明星').actress, ['山田テスト'], 'actress: 155 结构化尾巴');
    eq(P('测试片名有码2024-09-28JKSR-656未知演员', '女优明星').actress, [], 'actress: 未知演员');
    eq(P('ABP-601 测试片名 山田テスト', '国产主播').actress, [], 'actress: 主播类不抽');
    eq(P('某某吃瓜 ABP-601 山田テスト', '').actress, [], 'actress: 吃瓜标题不抽');
    eq(P('测试片名-张三', '国产传媒').actress, [], 'actress: 纯汉字候选不给(要词典确认)');
}

// ============ 7. searchVariants ============
{
    const SV = T.searchVariants;
    eq(SV('SSIS-001'), { kind: 'code', key: 'SSIS-001', variants: ['SSIS-001', 'SSIS001'] }, "search: 'SSIS-001'");
    eq(SV('ssis001'), { kind: 'code', key: 'SSIS-001', variants: ['SSIS-001', 'SSIS001'] }, "search: 'ssis001'");
    eq(SV('ssis 001'), { kind: 'code', key: 'SSIS-001', variants: ['SSIS-001', 'SSIS001'] }, "search: 'ssis 001'");
    eq(SV('FC2-PPV-1234567'), { kind: 'code', key: 'FC2-1234567', variants: ['FC2-PPV-1234567', 'FC2PPV1234567'] }, "search: 'FC2-PPV-1234567'");
    eq(SV('MD-0315'), { kind: 'code', key: 'MD-0315', variants: ['MD-0315', 'MD0315'] }, "search: 'MD-0315'");
    eq(SV('TMW038'), { kind: 'code', key: 'TMW-0038', variants: ['TMW-038', 'TMW038'] }, "search: 'TMW038'");
    eq(SV('人妻 温泉'), { kind: 'text', variants: ['人妻 温泉'] }, "search: '人妻 温泉'");
    eq(SV('人妻 溫泉'), { kind: 'text', variants: ['人妻 溫泉', '人妻 温泉'] }, 'search: 繁体文本附带简体');
    eq(SV('  SSIS-001  '), SV('SSIS-001'), 'search: 首尾空白');
    eq(SV('ＳＳＩＳ－００１'), SV('SSIS-001'), 'search: 全角');
    eq(SV('[SSIS-001]'), SV('SSIS-001'), 'search: 括号');
    eq(SV('SSIS-001-C').variants, ['SSIS-001', 'SSIS001'], 'search: -C 后缀查原番号');
    eq(SV('300maan-1007'), { kind: 'code', key: 'MAAN-1007', variants: ['300MAAN-1007', '300MAAN1007'] }, 'search: 数字前缀厂牌');
    eq(SV('heyzo 2975').key, 'HEYZO-2975', 'search: HEYZO');
    eq(SV('032826-001').kind, 'code', 'search: 日期式无码');
    eq(SV(''), { kind: 'text', variants: [] }, 'search: 空串');
    eq(SV(null), { kind: 'text', variants: [] }, 'search: null');
    for (const q of ['vr180', 'top10', 'mp4', 'iphone15', '4k60', 'abc']) eq(SV(q).kind, 'text', 'search: 不是番号 ' + q);
    // 番号查询绝不发光秃秃的厂牌前缀;且查询键 == 片名解析出来的键(搜索后按键过滤才对得上)
    for (const q of ['SSIS-001', 'ssis001', 'ssis 001', 'FC2-PPV-1234567', 'MD-0315', 'TMW038', '300MAAN-1007', 'heyzo 2975', 'IPZZ-048', 'md315']) {
        const r = SV(q);
        ok(r.kind === 'code' && r.variants.length === 2, 'search: 两种写法 ' + q, r);
        ok(r.variants.every((v) => /\d/.test(v) && !/^[A-Za-z]+$/.test(v)), 'search: 没有光秃秃的厂牌 ' + q, r.variants);
        const t = /^(MD|TMW)/i.test(q) ? '国产传媒' : '';
        for (const v of r.variants) {
            const p = P(v + ' 测试片名', t);
            if (p.key) eq(p.key, r.key, `search: 变体 ${v} 解析回同一键`);
        }
    }
}

// ============ 8. workKey ============
{
    const W = T.workKey;
    eq(W(P('SSIS-001 片名甲', '日本有码')), 'c:SSIS-001', 'workKey: 番号作品');
    eq(W(P('[SSIS-001] 片名乙 中文字幕', '中文字幕')), W(P('SSIS-001 片名甲', '日本有码')), 'workKey: 各站标题不同但番号相同 → 同键');
    eq(W(P('SSIS-001-U 片名', '')), 'c:SSIS-001#U', 'workKey: 无码流出版 #U 独立成卡');
    eq(W(P('【无码流出】SSIS-001 片名', '')), 'c:SSIS-001#U', 'workKey: 无码流出 #U');
    eq(W(P('SSIS-001-C 片名', '')), 'c:SSIS-001', 'workKey: 中字版不加后缀');
    eq(W(P('HEYZO-2975 片名', '日本无码')), 'c:HEYZO-2975', 'workKey: 原生无码不加 #U');
    eq(W(P('MD0315 甲', '麻豆传媒')), W(P('麻豆传媒 MD-315 乙', '麻豆传媒')), 'workKey: 国产厂牌补位同键');
    eq(W(P('溫泉旅行 高清', '国产自拍')), W(P('温泉旅行', '国产自拍')), 'workKey: 无番号按标题键');
    ok(W(P('温泉旅行', '国产自拍')).startsWith('t:'), 'workKey: t: 前缀');
    ok(W(P('[JUL-123] 片名', '中文字幕')).startsWith('t:'), 'workKey: 占位番号走标题键');
    ok(W(P('SSIS-001 片名', '日本有码'), { siteTrust: false }).startsWith('t:'), 'workKey: siteTrust:false 走标题键');
    ok(W(P('SSIS-001 片名', '日本有码'), { codeOk: false }).startsWith('t:'), 'workKey: codeOk:false 强制标题键');
    eq(W(P('ZZQX-123 片名', '日本有码'), { codeOk: true }), 'c:ZZQX-123', 'workKey: codeOk:true 强制番号键');
    ok(W(P('ZZQX-123 片名', '日本有码')).startsWith('c:'), 'workKey: 形状可信的未知厂牌也按番号合并(时长闸门由调用方做)');
    eq(W(null), 't:', 'workKey: 坏输入');
}

// ============ 9. 净标题去上传者/平台前缀与杂项(p2,从 items.jsonl + 目录片名统计) ============
{
    const C = (n, t) => P(n, t).cleanTitle;
    eq(C('ED MOASIC-寂寞少妇的测试片名。全程露脸', '国产'), '寂寞少妇的测试片名。全程露脸', 'junk: ED MOASIC- 前缀');
    eq(C('ED MOSAIC—双飞测试-闺蜜姐妹花无聊寻求刺激轮番', '国产'), '双飞测试-闺蜜姐妹花无聊寻求刺激轮番', 'junk: ED MOSAIC— 前缀(长横杠)');
    eq(C('EdMosaic11-16测试模特的初体验', '国产'), '测试模特的初体验', 'junk: EdMosaic+日期 前缀');
    eq(C('【ED MOASIC】测试生日会', '国产'), '测试生日会', 'junk: 【ED MOASIC】');
    eq(C('测试片名男友的报复 ED MOASIC', '国产'), '测试片名男友的报复', 'junk: ED MOASIC 尾巴');
    eq(C('KU【天美传媒】测试人【绝对测试按摩店】高清原版首发【TMW038】 new', '天美传媒'), '测试人【绝对测试按摩店】', 'junk: KU + 【片商】 + new');
    eq(C('myfans裏垢男子の日常-somehandle-テスト密会してきました', ''), 'テスト密会してきました', 'junk: myfans 频道名 + handle');
    eq(C('Onlyfans测试人妻【testhandle】肛交测试 (4)', ''), '测试人妻【testhandle】肛交测试 (4)', 'junk: Onlyfans 平台词(分集号保留)');
    eq(C('香蕉视频.XJX880测试修女', '香蕉视频'), '测试修女', 'junk: 香蕉视频. 前缀');
    eq(C('星空无限传媒.XKTY053.某某.测试兼职', '星空传媒'), '某某.测试兼职', 'junk: 星空无限传媒. 前缀');
    eq(C('色控 . 渴望测试的日夜 . PH-176 . 某某', '色控'), '渴望测试的日夜', 'junk: 色控 . 前缀');
    eq(C('國產AV 天美傳媒 偷看测试', '天美传媒'), '偷看测试', 'junk: 國產AV 天美傳媒(繁体)');
    eq(C('02月24日售价126RMB测试店长', '国产'), '测试店长', 'junk: 日期+价签');
    eq(C('11月20日测试赛季决赛', ''), '11月20日测试赛季决赛', 'junk: 普通日期开头不动(是片名)');
    eq(C('[独家] 测试网红被金主', '国产'), '测试网红被金主', 'junk: [独家]');
    eq(C('【日本无码】测试临床护理', ''), '测试临床护理', 'junk: 【日本无码】');
    eq(C('测试片名长长的测试3(8V)', ''), '测试片名长长的测试3', 'junk: (8V) 分段数');
    eq(C('测试控制:某某(26岁),G罩YMDS-174テストエンジェルス映像出版未知演员', ''), '测试控制:某某(26岁),G罩', 'junk: 155 尾巴 <片名><番号><片商>未知演员');
    eq(C('测试很长的片名-cd2', ''), '测试很长的片名', 'junk: -cd2 分碟');
    eq(C('测试很长的片名 -ABCD', ''), '测试很长的片名', 'junk: 全大写上传者缩写尾巴');
    eq(C('测试很长的片名-妄想族', ''), '测试很长的片名', 'junk: -妄想族');
    // 永不吃掉真片名
    eq(C('ED MOASIC', ''), 'ED MOASIC', 'junk: 去掉后不剩字就不去');
    eq(C('测试片名-出轨已婚女上司', ''), '测试片名-出轨已婚女上司', 'junk: 横杠后的长片名不是演员名,不切');
    eq(C('「测试経験なし」と言っていた婚約者。', ''), '「测试経験なし」と言っていた婚約者。', 'junk: 片尾句号保留');
    eq(C('PACO-113024 测试人妻巨乳', ''), '测试人妻巨乳', 'junk: 片商前缀不是演员名前缀');
    eq(P('PACO-113024 测试人妻巨乳', '').actress.concat(P('PACO-113024 测试人妻巨乳', '').actressGuess), [], 'junk: PACO 不当演员');
    // 标题键跟着净标题走:带不带上传者前缀同键
    eq(P('ED MOASIC-测试情侣互换', '国产').titleKey, P('测试情侣互换', '国产').titleKey, 'junk: 上传者前缀不影响标题键');
}

// ============ 10. 演员:有把握 / 猜测(p2) ============
{
    const p1 = P('ABP-601 测试片名 山田テスト', '日本有码');
    ok(p1.actressConfident === true && JSON.stringify(p1.actress) === '["山田テスト"]' && p1.actressGuess.length === 0, 'actress: 假名名 = 有把握', p1);
    const p2 = P('测试片名-张三', '国产传媒');
    ok(p2.actressConfident === false && p2.actress.length === 0 && JSON.stringify(p2.actressGuess) === '["张三"]', 'actress: 纯汉字 = 猜测', p2);
    const p3 = T.parseTitle('测试片名-张三', '国产传媒', { actor: '张三,未知演员' });
    ok(p3.actressConfident === true && JSON.stringify(p3.actress) === '["张三"]' && p3.actressGuess.length === 0, 'actress: vod_actor 证实的纯汉字名 = 有把握', p3);
    const p4 = T.parseTitle('测试片名一二三四', '日本有码', { actor: '架空ユメ / 素人' });
    eq(p4.actress, ['架空ユメ'], 'actress: vod_actor 名单(占位词去掉)');
    eq(T.parseTitle('测试片名', '国产自拍', { actor: '某某' }).actress, [], 'actress: 自拍类连 vod_actor 也不给');
    const p5 = P('测试名字 -MIDV-968 测试片名', '女优明星');
    ok(p5.cleanTitle === '测试片名' && p5.actress.length === 0 && JSON.stringify(p5.actressGuess) === '["测试名字"]', 'actress: "名字 -番号" 前缀(纯汉字 = 猜测)', p5);
    const p6 = P('三枝テスト-MILK-149 测试片名', '女优明星');
    ok(p6.cleanTitle === '测试片名' && JSON.stringify(p6.actress) === '["三枝テスト"]' && p6.actressConfident, 'actress: "名字-番号" 前缀(带假名 = 有把握)', p6);
    const p7 = P('测试片名有码2024-09-28JKSR-656测试花子', '女优明星');
    ok(p7.actress.length === 0 && JSON.stringify(p7.actressGuess) === '["测试花子"]', 'actress: 结构化尾巴里的纯汉字名也只是猜测', p7);
    const p8 = P('##测试媛#测试瑶 测试', '麻豆传媒');
    ok(p8.actress.length === 0 && p8.actressGuess.length === 2, 'actress: #标签 纯汉字 = 猜测', p8);
    for (const junk of ['cd2', 'JVID', 'HMV', 'ED MOASIC', 'ABCDE', '妄想族', 'soop']) {
        const p = P('测试很长的片名-' + junk, '日本有码');
        ok(!p.actress.includes(junk) && !p.actressGuess.includes(junk), 'actress: 不是人名 ' + junk, p);
    }
    // p6:#标签 / 【】括号词 / 拉丁 handle / 称呼 / 题材词 都只是猜测(前端绝不显示)
    for (const [n, t, g] of [
        ['ABCD-123 测试标题 #覗き #女のごほうび', '日本有码', '覗き'],
        ['ABCD-124 #個撮 #テスト活女子', '日本有码', 'テスト活女子'],
        ['[Uploader]_测试标题【TestChannel】', '动漫', 'TestChannel'],
        ['继母测试标题【SomeStudioChannel】', '欧美', 'SomeStudioChannel'],
        ['ABP-601 测试 The Motion Anime', '动漫', 'Anime'],
        ['测试很长的片名-testhandle', '国产传媒', 'testhandle'],
        ['ABP-601 测试片名 玲衣さん', '日本有码', '玲衣さん'],
        ['ABP-601 测试片名 痴女ギャル', '日本有码', '痴女ギャル'],
        ['ABP-601 测试片名 女のごほうび', '日本有码', '女のごほうび'],
    ]) {
        const p = P(n, t);
        ok(p.actress.length === 0 && p.actressConfident === false && p.actressGuess.includes(g), 'actress p6:不是有把握的名字 ' + g, p);
    }
    ok(T.parseTitle('测试标题【TestHandle】', '欧美', { actor: 'TestHandle' }).actress.includes('TestHandle'), 'actress p6:【】里的 handle 有 vod_actor 证实 → 有把握');
    ok(JSON.stringify(P('ABP-601 测试片名 円山テスト', '日本有码').actress) === '["円山テスト"]', 'actress p6:番号片名后面的 汉字姓+假名名 仍有把握');
    const pl = P('测试片名-终极测试之某某某某极致体验', '日本有码');
    ok(pl.actressGuess.length === 0 && pl.cleanTitle === '测试片名-终极测试之某某某某极致体验', 'actress: 长片名碎片不是名字,也不从净标题里切', pl);
    ok(Array.isArray(P(null).actressGuess) && P(null).actressConfident === false, 'actress: 坏输入');
}
{
    // p12:片名最前面的【分类标签】/ [厂牌] 不进片名键(同一部片别的站不带它,不去掉就并不成一部)
    const K = (n, t) => T.workKey(T.parseTitle(n, t || 'SM'));
    ok(K('【捆绑调教】丝袜制服母狗学生妹 强制捆绑高潮') === K('丝袜制服母狗学生妹 强制捆绑高潮') && T.parseTitle('【捆绑调教】丝袜制服母狗学生妹 强制捆绑高潮', 'SM').cleanTitle === '丝袜制服母狗学生妹 强制捆绑高潮',
        'p12:【分类标签】片名 与 片名 同一个键,净标题也去掉标签');
    ok(K('[セブンエイト] 百舌鳥ノ贄 (もすのにえ)', '动漫') === K('百舌鳥ノ贄 (もすのにえ)', '动漫'), 'p12:[厂牌] 片名 同上');
    ok(K('【捆绑调教】【户外露出】丝袜美腿女神被调教') === K('丝袜美腿女神被调教'), 'p12:连着两个标签都去');
    for (const tag of ['上', '下', '第一集', '第2部', '2', '花絮', '预告', '番外', '续集', 'Part1', 'EP3', 'AV解说', '解说', '精选合集', '片段'])
        ok(K('【' + tag + '】办公室恋情实录完整版本') !== K('办公室恋情实录完整版本'), 'p12:集数 / 上下篇 / 花絮预告 / 带数字的不去(是不同的片):' + tag);
    ok(K('【短】好的') === 't:短好的' && T.parseTitle('【捆绑】五个字片名', 'SM').cleanTitle === '【捆绑】五个字片名', 'p12:去掉后不足 6 个字不去');
}

console.log(`adult-title-test: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  FAIL ' + f); process.exit(1); }
