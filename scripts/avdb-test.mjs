#!/usr/bin/env node
// [adult] lib/adult-avdb 回归(离线、零网络、假时钟):
//   node scripts/avdb-test.mjs
//  ⓪ 归一化:每种番号形状(JAV / 数字前缀 / jav-cid / 国产带横线不带横线 / FC2 / HEYZO / 片商日期式 / 光秃日期式 / KBJ / 东京热 / H4610 /
//     Hentai)→ 键、变体后缀剥离、松键、和 lib/adult/title.js parseTitle 的键对得上;日期 / 时长 / 海报 / 片名占位 / 片商占位
//  ① 政策:标签分级(block / review_hide / review_code / allow / type_exceptions)、片名自我打码、变体行并集、被拦结果清空
//  ② 入库 + 查询:变体、tags_en(变体行的版本标签不算)、主行优先、KBJ / FC2 / 素人不出演员、占位演员 / 片名、日期式片商冲突 /
//     片商未知唯一 / 多片商按时长挑 / 挑不出且有被拦 = 拦、MDS-607 vs MDS-0607、recent()
//  ③ 演员:词序 / 前导空格 / 全大写合并、括号别名合并(旧 aid 跳转)、日文名 ≥2 部才上、粘连名字两半都在才拆、变体行机翻名 ≥2 部合并、
//     只在变体行出现的不计数、被拦的作品不计数、searchActress / actressKeys
//  ④ 爬取:全量顺序(先不带筛选第 1 页,再 t=5,7,4,3,2,1,绝不 t=6)、≥1.1s 间隔、游标逐页保存、重启从 pg−1 续、AVDB_MAX_PAGES、
//     退避 5/30/120s 后暂停 30 分钟、失败超 1% 作废、total=999 封顶不信 pagecount、完整性 + 两轮对账删除(带政策的行不删)、
//     增量停在水位、30 页封顶改按类型 h= 兜底、增量失败水位不动、不带筛选绝不翻过 5000 页、ids= 复取、调度(首轮延迟 / 每天增量 + 抖动)、
//     AVDB_DISABLE、规则版本变了重算标签等级
//  ⑤(有调研数据时)调研 join-raw.json 的真番号离线命中率 ≥ 90%
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createAvdb, norm: N, policy: P } = require(path.join(ROOT, 'lib/adult-avdb'));
const title = require(path.join(ROOT, 'lib/adult/title.js'));
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/avdb/rows.json'), 'utf8')).rows;

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra).slice(0, 600))); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b });
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const T0 = Date.UTC(2026, 10, 22, 3, 0, 0);          // 2026-11-22 12:00 JST
const tick = () => new Promise((r) => setImmediate(r));
function mkClock(t) {
    const c = { t };
    c.now = () => c.t;
    c.sleep = async (ms) => { const target = c.t + ms; await tick(); if (c.t < target) c.t = target; };
    return c;
}
const TAGS = {
    VOCAB: [{ id: 'busty', kind: 'featured' }, { id: 'office', kind: 'featured' }, { id: 'x_blk', kind: 'blocked' }, { id: 'milf', kind: 'featured' }],
    tagsFromAvdb(en) {
        const map = { 'big breasts': 'busty', 'office lady': 'office', 'cosplay': 'x_blk', 'married woman': 'milf' };
        return (en || []).map((e) => map[String(e).toLowerCase()]).filter(Boolean).map((id) => ({ id, src: 'avdb' }));
    },
};
const ADULT = { tags: TAGS };
const quiet = () => {};
const mk = (extra) => {
    const db = (extra && extra.db) || new Database(':memory:');
    const av = createAvdb(Object.assign({ db, log: quiet, env: {}, adult: ADULT }, extra || {}));
    return { db, av };
};

// ==================== ⓪ 归一化 ====================
console.log('⓪ normalization');
{
    const T = [
        // [movie_code, type_name, key, kind, variant]
        ['IPZZ-961', 'Censored', 'IPZZ-961', 'jav', 'main'],
        ['300MIUM-123', 'Amateur', 'MIUM-123', 'jav', 'main'],
        ['259LUXU-1500', 'Amateur', 'LUXU-1500', 'jav', 'main'],
        ['JVDW-84', 'Censored', 'JVDW-084', 'jav', 'main'],
        ['MT003', 'Censored', 'MT-003', 'jav', 'main'],
        ['IENE-394', 'Censored', 'IENE-394', 'jav', 'main'],
        ['TMW156', 'Chinese AV', 'TMW-0156', 'cn', 'main'],
        ['MD0146', 'Chinese AV', 'MD-0146', 'cn', 'main'],
        ['91CM-229', 'Chinese AV', '91CM-0229', 'cn', 'main'],
        ['FSOG-058', 'Chinese AV', 'FSOG-0058', 'cn', 'main'],
        ['FSOG058', 'Chinese AV', 'FSOG-0058', 'cn', 'main'],
        ['PMS011-1', 'Chinese AV', 'PMS-0011', 'cn', 'main'],
        ['FC2-PPV-942171', 'Uncensored', 'FC2-942171', 'fc2', 'main'],
        ['FC2PPV-4923152', 'Amateur', 'FC2-4923152', 'fc2', 'main'],
        ['HEYZO-3509', 'Uncensored', 'HEYZO-3509', 'heyzo', 'main'],
        ['HEYZO-173', 'Uncensored', 'HEYZO-0173', 'heyzo', 'main'],
        ['KBJ-24072342', 'Uncensored', 'KBJ-24072342', 'kbj', 'main'],
        ['TOKYO-HOT-K1444', 'Uncensored', 'TH-k1444', 'tokyohot', 'main'],
        ['H4610-ORI1611', 'Uncensored', 'H4610-ori1611', 'h4610', 'main'],
        ['HEYDOUGA4197-001', 'Uncensored', 'HEYDOUGA-4197-001', 'heydouga', 'main'],
        ['CARIBBEANCOM-061912-052', 'Uncensored', 'CARIB-061912-052', 'uncen-date', 'main'],
        ['CARIBBEANCOMPR-040525-001', 'Uncensored', 'CARIB-040525-001', 'uncen-date', 'main'],
        ['1PONDO-040525_001', 'Uncensored', '1PON-040525-001', 'uncen-date', 'main'],
        ['PONDO-040525_001', 'Uncensored', '1PON-040525-001', 'uncen-date', 'main'],
        ['PACOPACOMAMA-123124-100', 'Uncensored', 'PACO-123124-100', 'uncen-date', 'main'],
        ['10MUSUME-042025_01', 'Uncensored', '10MU-042025-01', 'uncen-date', 'main'],
        ['MURAMURA-010125_100', 'Uncensored', 'MURA-010125-100', 'uncen-date', 'main'],
        ['091923_912', 'Uncensored', 'UNC-091923-912', 'uncen-date', 'main'],
        ['102426-01', 'Uncensored', 'UNC-102426-01', 'uncen-date', 'main'],
        ['IPZZ-961-UNCENSORED-LEAK', 'Uncensored Leaked', 'IPZZ-961', 'jav', 'leak'],
        ['IPZZ-961-UNCENSORED-LEAKED', 'Uncensored Leaked', 'IPZZ-961', 'jav', 'leak'],
        ['DVDMS-826-UNCENSORED-LEAK', 'Uncensored Leaked', 'DVDMS-826', 'jav', 'leak'],
        ['SSIS-001-ENGLISH-SUBTITLE', 'English subtitle', 'SSIS-001', 'jav', 'ensub'],
        ['SSNI-901-SUB', 'English subtitle', 'SSNI-901', 'jav', 'ensub'],
        ['SSIS-001-ENGLISH-SUBTITLE', 'Censored', 'SSIS-001', 'jav', 'ensub'],
        ['MBDD-2108B', 'Censored', 'MBDD-2108B', 'other', 'main'],
        ['LDM014-001', 'Censored', 'LDM014-001', 'other', 'main'],
        ['131326-001', 'Uncensored', '131326-001', 'other', 'main'],
        ['  ipzz-961 ', 'Censored', 'IPZZ-961', 'jav', 'main'],
    ];
    for (const [mc, type, key, kind, variant] of T) {
        const nk = N.normKey(mc, type);
        ok(nk && nk.key === key && nk.kind === kind, `normKey ${mc} [${type}]`, { got: nk, want: { key, kind } });
        ok(N.variantOf(mc, type) === variant, `variantOf ${mc} [${type}]`, N.variantOf(mc, type));
    }
    ok(N.normKey('avdb-h15316', 'Hentai') === null, 'Hentai movie_code → null');
    ok(N.normKey('', 'Censored') === null, 'empty code → null');
    // 松键:补零 / 片商 / 后缀无关
    eq(N.looseKey('MDS-0607'), N.looseKey('MDS-607'), 'looseKey MDS-0607 ≡ MDS-607');
    eq(N.looseKey('XSJHG-010'), N.looseKey('XSJHG-0010'), 'looseKey XSJHG-010 ≡ XSJHG-0010');
    eq(N.looseKey('c:IPZZ-961#U'), 'IPZZ-961', 'looseKey strips c: and #U');
    eq(N.looseKey('IPVR-207~2'), 'IPVR-207', 'looseKey strips ~N');
    eq(N.looseKey('SSIS-001#clip'), N.looseKey('SSIS-001'), 'looseKey strips #clip');
    eq(N.looseKey('CARIB-061912-052'), N.looseKey('UNC-061912-052'), 'looseKey date codes are studio-free');
    eq(N.looseKey('TH-k1444'), N.looseKey(N.normKey('TOKYO-HOT-K1444', 'Uncensored').key), 'looseKey tokyo-hot case-insensitive');
    // 和 title.js parseTitle 的键对得上(站点标题写法 → 我们的键;AVDB movie_code → AVDB 键)
    const PT = [
        ['IPZZ-961 某某标题', '', 'IPZZ-961', 'Censored'],
        ['300MIUM-123 素人', '', '300MIUM-123', 'Amateur'],
        ['JVDW-084', '', 'JVDW-84', 'Censored'],
        ['1iene00394 标题', '', 'IENE-394', 'Censored'],
        ['h_158tos00116', '', 'TOS-116', 'Censored'],
        ['TMW156 天美传媒', '国产传媒', 'TMW156', 'Chinese AV'],
        ['MD-0146 麻豆', '国产传媒', 'MD0146', 'Chinese AV'],
        ['91CM-229 果冻', '国产传媒', '91CM-229', 'Chinese AV'],
        ['FSOG-058', '国产传媒', 'FSOG058', 'Chinese AV'],
        ['FC2-PPV-942171', '', 'FC2-PPV-942171', 'Uncensored'],
        ['FC2PPV 4923152', '', 'FC2PPV-4923152', 'Amateur'],
        ['HEYZO-3509', '', 'HEYZO-3509', 'Uncensored'],
        ['Caribbeancom 061912-052', '无码', 'CARIBBEANCOM-061912-052', 'Uncensored'],
        ['一本道 040525_001', '无码', '1PONDO-040525_001', 'Uncensored'],
        ['PACO-123124_100', '无码', 'PACOPACOMAMA-123124-100', 'Uncensored'],
        ['10musume 042025_01', '无码', '10MUSUME-042025_01', 'Uncensored'],
        ['091923_912 无码', '无码', '091923_912', 'Uncensored'],
        ['Tokyo-Hot k1444', '', 'TOKYO-HOT-K1444', 'Uncensored'],
        ['H4610-ori1611', '', 'H4610-ORI1611', 'Uncensored'],
        ['KBJ-24072342', '', 'KBJ-24072342', 'Uncensored'],
        ['heydouga 4197-001', '无码', 'HEYDOUGA4197-001', 'Uncensored'],
        ['MDS-607', '', 'MDS-607', 'Censored'],
    ];
    for (const [site, type, mc, atype] of PT) {
        const p = title.parseTitle(site, type);
        const nk = N.normKey(mc, atype);
        ok(p.key && nk && N.looseKey(p.key) === N.looseKey(nk.key), `parseTitle(${site}) ≈ normKey(${mc})`, { parser: p.key, avdb: nk && nk.key });
    }
    // 字段
    eq(N.releaseDate('2021-02-18'), '2021-02-18', 'releaseDate ISO');
    eq(N.releaseDate('5 Nov, 2026'), '2026-11-05', 'releaseDate "D Mon, YYYY"');
    eq(N.releaseDate('2026/11/05'), '2026-11-05', 'releaseDate YYYY/MM/DD');
    eq(N.releaseDate('2026-02-30'), null, 'releaseDate invalid day');
    eq(N.releaseDate(''), null, 'releaseDate empty');
    eq(N.hms('02:01:38'), 7298, 'hms');
    eq(N.hms('00:00:00'), null, 'hms zero → null');
    eq(N.cleanActors(['Updating', ' Japanese Cast', 'Actresses &amp; Casts', 'Voice Cast', 'Amateur Model', 'Chinese Model', 'H-Anime', '', '  Kilo  Testa ']), ['Kilo Testa'], 'cleanActors drops placeholders/entities, trims');
    eq(N.splitActor('Yu Testa (Shizu Fixture)'), { romaji: 'Yu Testa', alias: 'Shizu Fixture', ja: null, merged: false }, 'splitActor paren alias');
    eq(N.splitActor('Foxtrot Amane フォクスアマネ'), { romaji: 'Foxtrot Amane', alias: null, ja: 'フォクスアマネ', merged: false }, 'splitActor ja suffix');
    ok(N.splitActor('Golf Hayase Hotel Kurumi').merged, 'splitActor 4 tokens = merged');
    eq(N.orderKey('Kilo Testa'), N.orderKey('  testa KILO'), 'orderKey ignores order/case/leading space');
    ok(N.isRealName('Alpha Hoshino') && N.isRealName('Ai Fixturo-Test') && !N.isRealName('Mio') && !N.isRealName('Amateur Model') && !N.isRealName('Studio X')
        && !N.isRealName('Gen1 Test') && N.isRealName('フォクスアマネ') && !N.isRealName('Some Very Long Four Tokens'), 'isRealName');
    eq(N.displayName('ALPHA HOSHINO'), 'Alpha Hoshino', 'displayName title-cases ALL CAPS');
    eq(N.titleOf('[UNCENSORED-LEAK]     IPZZ-961 A Quiet Office Story', 'IPZZ-961-UNCENSORED-LEAK'), 'A Quiet Office Story', 'titleOf strips prefix + code');
    eq(N.titleOf('MFYD-071 MFYD-071 International Age Verification Compliance Notice', 'MFYD-071'), null, 'titleOf age-notice placeholder → null');
    eq(N.makerOf(['Madonna Production']), 'Madonna', 'makerOf X Production');
    eq(N.makerOf(['Updating', 'S-CUTE', 'JAV Studio Production', 'Chinese Studio Production', 'Amateur Studio Production', 'FC2-PPV Production']), null, 'makerOf placeholders');
    eq(N.directorOf(['Madonna Production', 'Ichigo']), 'Ichigo', 'directorOf skips Production');
    eq(N.posterOf({ poster_url: 'https://upload18.cc/v/ipzz-961/poster.jpg' }), 'u:ipzz-961', 'posterOf compresses upload18 poster');
    eq(N.posterUrl('u:ipzz-961'), 'https://upload18.cc/v/ipzz-961/poster.jpg', 'posterUrl expands');
    eq(N.posterOf({ poster_url: 'javascript:alert(1)', thumb_url: 'https://x.example/t.jpg' }), 'https://x.example/t.jpg', 'posterOf rejects non-http, falls back to thumb');
    eq(N.addedOf({ vod_time: '2026-11-22 09:37:46' }), Math.floor(Date.UTC(2026, 10, 22, 2, 37, 46) / 1000), 'addedOf parses UTC+7 vod_time');
    eq(N.typeIdOf('Uncensored Leaked'), 3, 'typeIdOf');
}

// ==================== ① 政策 ====================
console.log('① policy');
{
    const C = [
        ['High School Girl', 'Censored', 'block'], ['school girls', 'Censored', 'block'], ['Sneak Shots', 'Censored', 'block'], ['Voyeurism', 'Amateur', 'block'],
        ['Drugs And Aphrodisiacs', 'Censored', 'block'], ['Aphrodisiac', 'Censored', 'block'], ['Sleeping', 'Censored', 'block'], ['School Uniform', 'Censored', 'block'],
        ['Sailor Suit', 'Censored', 'block'], ['Loli', 'Uncensored', 'block'], ['Outflow', 'Uncensored', 'block'], ['secret filming', 'Amateur', 'block'],
        ['Rape', 'Censored', 'review_code'], ['Incest', 'Censored', 'review_code'], ['Hypnosis', 'Censored', 'review_code'],
        ['Teen', 'Censored', 'review_hide'], ['Daughter', 'Censored', 'review_hide'], ['Leaked', 'Censored', 'review_hide'], ['AI', 'Chinese AV', 'review_hide'],
        ['Leaked', 'Uncensored Leaked', null], ['AI', 'Censored', null], ['Uncensored Leaked', 'Uncensored Leaked', null], ['Leak', 'Uncensored Leaked', null],
        ['Young Wife', 'Censored', null], ['Sleeping Bag', 'Censored', null], ['Female College Student', 'Censored', null], ['Uniform', 'Censored', null],
        ['Big Breasts', 'Censored', null], ['Childhood Friend', 'Censored', null],
    ];
    for (const [tag, type, lv] of C) { const c = P.classifyTag(tag, type); ok((c ? c.list : null) === lv, `classifyTag ${tag} [${type}]`, c); }
    const TT = [
        ['Served Up S********l Story', 'block'], ['[Uncensored L**ked] A Boss Story', null], ['A Cheeky New Wife J● Life', 'block'],
        ['R** Training Camp', 'review_code'], ['Hidden Cam In A Bathhouse', 'block'], ['Spiked With An Aphrodisiac', 'block'], ['I Got Sleeping', 'block'],
        ['A Sleepover With Neighbours', null], ['Ends Up Sleeping With Her Boyfriend', null], ['In The Middle Of The Night Without Sleep', null],
        ['Married Woman Seduced In Her Sleep', 'block'], ['Office Lady Overtime', null], ['A playcon teacher', 'block'], ['My playhood friend', 'review_hide'],
    ];
    for (const [t, lv] of TT) { const c = P.classifyTitle(t); ok((c ? c.list : null) === lv, `classifyTitle "${t}"`, c); }
    eq(P.classifyRow(['Censored', 'Big Breasts', 'Rape', 'Teen'], 'Censored', 'x').pol, 'review_hide', 'classifyRow takes the strictest (review_hide > review_code)');
    eq(P.maxPol('review_code', 'block'), 'block', 'maxPol');
    ok(/^avp\d+-/.test(P.POLICY_VERSION), 'POLICY_VERSION fingerprint', P.POLICY_VERSION);
}

// ==================== ② 入库 + 查询 ====================
console.log('② ingest + lookup');
const clockL = mkClock(T0);
const L = mk({ now: clockL.now, sleep: clockL.sleep });
{
    const r = L.av.ingest(FIX, { run: 1 });
    ok(r.rows === FIX.length - 1 && r.hentai === 1, 'ingest: all fixture rows but the Hentai one', r);
    ok(!L.db.prepare("SELECT 1 FROM avdb WHERE mc LIKE 'avdb-%'").get(), 'Hentai rows never stored');
    const a = L.av.lookup('IPZZ-961');
    ok(a && a.key === 'IPZZ-961' && a.avdb_key === 'IPZZ-961' && a.kind === 'jav', 'lookup IPZZ-961 hit', a);
    eq(a.variants, ['main', 'leak', 'ensub'], 'variants main/leak/ensub');
    eq([a.runtime, a.released, a.maker, a.label, a.pol], [7210, '2026-11-10', 'IdeaPocket', 'IPZZ', null], 'runtime/released/maker/label/pol from the main row');
    eq(a.poster, 'https://upload18.cc/v/ipzz-961/poster.jpg', 'poster from the main row');
    ok(a.tags_en.includes('big breasts') && a.tags_en.includes('office lady') && a.tags_en.includes('cosplay'), 'tags_en union over variant rows', a.tags_en);
    ok(!a.tags_en.includes('uncensored leaked') && !a.tags_en.includes('leak') && !a.tags_en.includes('english subtitle') && !a.tags_en.includes('ipzz'),
        'tags_en: variant-only version tags and the label are dropped', a.tags_en);
    eq(a.tags, [{ id: 'busty', src: 'avdb' }, { id: 'office', src: 'avdb' }], 'tags via adult.tags.tagsFromAvdb, blocked vocab ids filtered');
    eq(a.actors.map((x) => x.name), ['Alpha Hoshino'], 'actors from the main row only (ensub reversed order = same person; leak reading ignored)');
    eq(L.av.lookup('c:IPZZ-961#U').avdb_key, 'IPZZ-961', 'lookup accepts c: prefix and #U');
    eq(L.av.lookup('IPZZ-961~2').key, 'IPZZ-961', 'lookup strips ~N (key echoes the base key)');
    eq(L.av.lookup('IPZZ-0961') && L.av.lookup('IPZZ-0961').avdb_key, 'IPZZ-961', 'padding-insensitive');
    ok(L.av.lookup('NOPE-001') === null && L.av.lookup('') === null && L.av.lookup(null) === null, 'miss → null');
    // 政策并集
    const s = L.av.lookup('SSNI-500');
    ok(s && s.pol === 'block', 'policy union: clean main + leak row tagged High School Girl → block', s);
    ok(s.actors.length === 0 && s.tags.length === 0 && s.tags_en.length === 0 && s.poster === '' && s.released === '' && s.maker === '', 'blocked result carries nothing displayable', s);
    eq(s.variants, ['main', 'leak'], 'blocked result keeps variants');
    ok(L.av.lookup('DOCD-010').pol === 'block', 'Sneak Shots → block');
    ok(L.av.lookup('JUR-310').pol === 'block', 'Drugs And Aphrodisiacs → block');
    ok(L.av.lookup('SHKD-900').pol === 'block', 'starred S********l title → block');
    ok(L.av.lookup('SSNI-901').pol === null && L.av.lookup('SSNI-901').variants[0] === 'ensub', '"[Uncensored L**ked]" title is not loli; -SUB row is ensub');
    ok(L.av.lookup('JUQ-200').pol === 'review_hide', 'Leaked tag on a Censored row → review_hide');
    ok(L.av.lookup('JUR-300').pol === 'review_code', 'Rape → review_code');
    ok(L.av.lookup('IPZZ-961').pol === null, '"Uncensored Leaked" / "Leak" on the leak row → no policy');
    // 类别
    const k = L.av.lookup('KBJ-24072342');
    ok(k && k.actors.length === 0 && k.maker === '', 'KBJ: no actors, no maker', k);
    ok(L.av.lookup('FC2-942171').actors.length === 0 && L.av.lookup('FC2-4923152').actors.length === 0, 'FC2: no actors even with a real-looking name');
    ok(L.av.lookup('MIUM-123') && L.av.lookup('MIUM-123').actors.length === 0 && L.av.lookup('MIUM-123').label === 'MIUM', 'numeric-prefix amateur: hit, no actors');
    ok(L.av.lookup('SIRO-5000').actors.length === 0, 'single-token amateur name → no actress');
    ok(L.av.lookup('IPZZ-970').actors.length === 0 && L.av.lookup('IPZZ-970').maker === '', 'placeholder actors / placeholder maker');
    eq(L.av.lookup('HEYZO-3509').actors.map((x) => x.name), ['India Takane'], 'HEYZO credits real names');
    ok(L.db.prepare("SELECT title_en FROM avdb WHERE mc='MFYD-071'").get().title_en === null, 'age-notice placeholder title stored as NULL');
    ok(L.av.lookup('TH-k1444') && L.av.lookup('H4610-ori1611'), 'tokyo-hot / h4610 keys');
    eq(L.av.lookup('IENE-394').poster, 'https://upload18.cc/v/iene-394/thumb.jpg', 'poster falls back to thumb');
    // 国产
    const t = L.av.lookup('TMW-0156');
    ok(t && t.maker === 'Tianmei Media' && t.actors.map((x) => x.name).join() === 'Juliet Lin' && L.av.lookup('TMW-156'), 'CN TMW156 ↔ TMW-0156', t);
    const f = L.av.lookup('FSOG-0058');
    ok(f && f.variants.join() === 'main' && f.maker === '' && f.runtime === 1800, 'CN dashed + undashed rows = one work; Chinese Studio maker placeholder', f);
    ok(L.av.lookup('91CM-0229') && L.av.lookup('MD-0146') && L.av.lookup('PMS-0011'), 'CN 91CM / MD / multi-part PMS');
    eq(L.av.lookup('MDS-607').actors.map((x) => x.name), ['Kilo Asagiri'], 'MDS-607 (JAV) exact match wins');
    eq(L.av.lookup('MDS-0607').actors.map((x) => x.name), ['Lima Chen'], 'MDS-0607 (CN) exact match wins');
    // 日期式
    ok(L.av.lookup('CARIB-061912-052') && L.av.lookup('UNC-061912-052'), 'date code: exact studio / UNC with one studio');
    ok(L.av.lookup('1PON-061912-052') === null, 'date code: studio conflict → null');
    ok(L.av.lookup('UNC-040726-001') === null, 'UNC with two studios, no duration → null (ambiguous)');
    eq(L.av.lookup('UNC-040726-001', { dur: 3340 }).avdb_key, '1PON-040726-001', 'UNC + duration picks 1PON (3336 s)');
    eq(L.av.lookup('UNC-040726-001', { dur: 3660 }).avdb_key, 'CARIB-040726-001', 'UNC + duration picks CARIB (3663 s)');
    eq(L.av.lookup('1PON-040726-001').runtime, 3336, 'known studio picks its own row');
    ok(L.av.lookup('CARIB-091923-912') && L.av.lookup('UNC-091923-912'), 'bare MMDDYY_NNN (UNC) joins a known-studio key');
    ok(L.av.lookup('10MU-042025-01') && L.av.lookup('PACO-123124-100') && L.av.lookup('CARIB-123124-100') === null, '10MU / PACO / conflict');
    const amb = L.av.lookup('UNC-050126-001');
    ok(amb && amb.pol === 'block' && amb.ambiguous === true && amb.actors.length === 0, 'ambiguous UNC with a blocked candidate → block (fail-closed)', amb);
    ok(L.av.lookup('CARIB-050126-001').pol === null, 'the clean studio of the same date stays clean');
    // lookupMany / recent
    const m = L.av.lookupMany(['IPZZ-961', 'NOPE-001', 'SSNI-500', 'IPZZ-961']);
    ok(m.size === 2 && m.get('SSNI-500').pol === 'block', 'lookupMany → Map of hits');
    eq(L.av.recent(60), ['IPZZ-962', 'IPZZ-961'], 'recent(60): released ≤60d, main rows, not blocked, not future');
    ok(L.av.recent(3650).includes('HEYZO-3509') && !L.av.recent(3650).includes('KBJ-24072342') && !L.av.recent(3650).includes('SSNI-500'), 'recent excludes KBJ and blocked');
}

// ==================== ③ 演员 ====================
console.log('③ actresses');
{
    const av = L.av;
    const find = (q) => av.searchActress(q);
    const hoshino = find('Hoshino Alpha');
    ok(hoshino.length === 1 && hoshino[0].name === 'Alpha Hoshino' && hoshino[0].n === 2, 'romaji order / leading space / ALL CAPS → one actress, n=2', hoshino);
    ok(find('alpha').some((x) => x.name === 'Alpha Hoshino') && find('hosh').some((x) => x.name === 'Alpha Hoshino'), 'prefix search on any token');
    eq(find('Alpha Starfield'), [], 'leak-row reading not searchable before post-processing');
    const leakOnly = L.db.prepare("SELECT a.aid FROM actress_alias l JOIN actress a ON a.aid=l.aid WHERE l.alias='r:alpha starfield'").get();
    ok(leakOnly && av.actress(leakOnly.aid).n === 0, 'leak-only credit creates an n=0 actress');
    eq(find('Bravo Kawanami'), [], 'leak-only actress is not searchable');
    eq(find('Charlie Minase'), [], 'actress whose only work is blocked is not searchable (n excludes blocked works)');
    // 括号别名合并
    const delta = find('Delta Sorano');
    ok(delta.length === 1 && delta[0].n === 3, 'paren alias: "Delta Sorano (Echo Kirisame)" merges both; blocked JUR-310 not counted', delta);
    const echoOld = L.db.prepare('SELECT from_aid FROM actress_merge WHERE into_aid=?').get(delta[0].aid);
    ok(echoOld && av.actress(echoOld.from_aid).aid === delta[0].aid, 'merged aid redirects', echoOld);
    ok(av.actress(delta[0].aid).aliases.includes('Echo Kirisame'), 'aliases list the merged name', av.actress(delta[0].aid));
    eq(find('Echo Kirisame').map((x) => x.aid), [delta[0].aid], 'search by the merged name finds the survivor');
    eq(av.actressKeys(delta[0].aid), ['JUR-302', 'JUR-301', 'JUR-300'], 'actressKeys: newest first, blocked work excluded');
    // 日文名
    const fox = find('Foxtrot Amane')[0];
    ok(fox && fox.n === 2 && av.actress(fox.aid).name_ja === 'フォクスアマネ', 'ja suffix alias becomes name_ja at support 2', av.actress(fox && fox.aid));
    eq(find('フォクス').map((x) => x.aid), [fox.aid], 'CJK substring search');
    // 粘连名字
    const golf = find('Golf Hayase')[0], hotel = find('Hotel Kurumi')[0];
    ok(golf && golf.n === 1 && hotel && hotel.n === 1, 'merged string dropped while halves unknown', [golf, hotel]);
    const tango = find('Tango Hikawa')[0];
    ok(tango && tango.n === 1, 'n excludes blocked works (STARS-950 counts, JUR-310 does not)', tango);
    ok(find('Mio').length === 0 && find('Kilo Kanzaki').length === 0 && find('Ruka').length === 0, 'amateur / FC2 / single-token names never become actresses');
    ok(find('a').length === 0 && find('').length === 0, 'too-short query → []');
    const pp = await av.postProcess();
    ok(pp.merged >= 1, 'postProcess merged leak readings', pp);
    ok(find('Golf Hayase')[0].n === 2 && find('Hotel Kurumi')[0].n === 2, 'merged string split once both halves exist');
    ok(av.actressKeys(find('Golf Hayase')[0].aid).includes('MIDV-300'), 'split credit shows in actressKeys');
    const st = find('Alpha Starfield');
    eq(st.map((x) => x.aid), [hoshino[0].aid], 'leak reading paired with the main name on ≥2 works → alias of the main actress');
    ok(av.actress(leakOnly.aid) && av.actress(leakOnly.aid).aid === hoshino[0].aid, 'pre-existing leak-only actress merged (old aid redirects)');
    ok(av.actressKeys(hoshino[0].aid).includes('IPZZ-963'), 'leak-only work moved to the merged actress');
    eq(av.lookup('IPZZ-961').actors.map((x) => x.name), ['Alpha Hoshino'], 'lookup actors unchanged after merges');
    const whisky = find('Whiskey Moriwaki'), victor = find('Victor Hanabusa');
    ok(whisky.length === 1 && victor.length === 1 && whisky[0].aid !== victor[0].aid && whisky[0].n === 1 && victor[0].n === 2,
        'leak reading that is itself a main-credited actress is never merged', { whisky, victor });
    ok(av.searchActress('a l').length <= 10, 'searchActress ≤ 10');
    // 拼音 / 罗马字只是空格切分不同("Qiaomei Testa" / "Qiao Mei Testa"):同一个人,不再拆成两位(合成名字)
    {
        const mkRow = (id, code, actor) => ({ id, type_name: 'Censored', movie_code: code, name: code + ' Split Name Story', actor: [actor], director: ['Synthetic Production'], category: ['Censored'], time: '02:00:00', created_at: '2024-04-01', vod_time: '2024-04-02 10:00:00' });
        av.ingest([mkRow(990001, 'ZZSN-101', 'Qiaomei Testa'), mkRow(990002, 'ZZSN-102', 'Qiao Mei Testa')], { run: 9 });
        const a1 = find('Qiaomei Testa'), a2 = find('Qiao Mei Testa');
        ok(a1.length === 1 && a2.length === 1 && a1[0].aid === a2[0].aid && a1[0].n === 2, 'space-split spellings of one name → one actress (n=2)', { a1, a2 });
        ok(find('Qiao Testa').every((x) => x.aid === a1[0].aid), 'no second actress for the other spelling');
    }
    // 规则版本:旧版本的标签等级在新实例启动时重算
    L.db.prepare("UPDATE avdb_tag SET pol='block', grp='x' WHERE name='big breasts'").run();
    L.db.prepare("UPDATE avdb_state SET v='\"old\"' WHERE k IN ('polv_tags','polv_rows')").run();
    L.db.prepare("UPDATE avdb SET pol='block' WHERE mc='IPZZ-962'").run();
    const L2 = createAvdb({ db: L.db, log: quiet, env: { AVDB_DISABLE: '1' }, adult: ADULT, now: clockL.now, sleep: clockL.sleep });
    ok(L2.lookup('IPZZ-961').pol === null, 'policy version change → stored tag levels recomputed at startup');
    const rp = await L2.recomputePolicy();
    ok(rp.status === 'done' && rp.changed >= 1 && L.db.prepare("SELECT pol FROM avdb WHERE mc='IPZZ-962'").get().pol === '', 'recomputePolicy rewrites stale row pol', rp);
    eq((await L2.recomputePolicy()).status, 'current', 'recomputePolicy is a no-op once current');
}

// ==================== ④ 爬取 ====================
console.log('④ crawl');
const TYPES = { 1: 'Censored', 2: 'Uncensored', 3: 'Uncensored Leaked', 4: 'Amateur', 5: 'Chinese AV', 6: 'Hentai', 7: 'English subtitle' };
const p3 = (n, w = 3) => String(n).padStart(w, '0');
function codeFor(t, i) {
    switch (+t) {
        case 1: return `ABP-${p3(i)}`;
        case 2: return `HEYZO-${p3(i, 4)}`;
        case 3: return `ABP-${p3(i)}-UNCENSORED-LEAK`;
        case 4: return `300MIUM-${p3(i)}`;
        case 5: return `MD${p3(i, 4)}`;
        case 6: return `avdb-h${10000 + i}`;
        default: return `ABW-${p3(i)}-SUB`;
    }
}
// 合成数据集:按类型轮流分配递增 id(id 越大越新);vod_time_add = 假时钟 - (最大 id - id) 分钟
function genRows(spec, startId, nowMs, extra) {
    const left = Object.fromEntries(Object.entries(spec).map(([t, n]) => [t, n]));
    const idx = Object.fromEntries(Object.keys(spec).map((t) => [t, (extra && extra.offset && extra.offset[t]) || 0]));
    const out = [];
    let id = startId;
    for (let more = true; more;) {
        more = false;
        for (const t of Object.keys(spec)) {
            if (left[t] <= 0) continue;
            left[t]--; more = true;
            const i = ++idx[t];
            out.push({ id: id++, type_name: TYPES[t], movie_code: codeFor(t, i), name: `${codeFor(t, i)} Generated Title ${i}`, actor: ['Updating'], director: ['Updating'], category: [TYPES[t]], time: '01:00:00', created_at: '2020-01-01' });
        }
    }
    const top = id - 1;
    for (const r of out) r.vod_time_add = Math.floor((nowMs - (top - r.id) * MIN) / 1000);
    return out;
}
function mkApi(rows, clock) {
    const api = { rows: rows.slice(), calls: [], fail: [], cap999: new Set(), hidden: new Set() };
    api.add = (more) => { api.rows.push(...more); };
    api.httpGet = async (url, o) => {
        const t = clock.now();
        const u = new URL(url);
        const q = Object.fromEntries(u.searchParams);
        api.calls.push({ t, q, url, timeout: o && o.timeout, siteKey: o && o.siteKey });
        for (const f of api.fail) if (f.re.test(u.search) && f.n > 0) { f.n--; throw new Error('HTTP 503'); }
        let list = api.rows.filter((r) => !api.hidden.has(r.id)).sort((a, b) => b.id - a.id);
        if (q.ids) { const s = new Set(q.ids.split(',').map(Number)); list = list.filter((r) => s.has(r.id)); }
        if (q.t) list = list.filter((r) => N.typeIdOf(r.type_name) === +q.t);
        if (q.h) list = list.filter((r) => r.vod_time_add * 1000 >= t - +q.h * HOUR);
        const pg = +(q.pg || 1);
        const total = list.length;
        const capped = q.t && api.cap999.has(+q.t);
        const body = { code: 1, msg: 'ok', page: pg, pagecount: capped ? 10 : Math.ceil(total / 100), limit: '100', total: capped ? 999 : total, list: list.slice((pg - 1) * 100, pg * 100).map((r) => Object.assign({}, r)) };
        return api.asString ? '﻿' + JSON.stringify(body) : body;
    };
    return api;
}
const SPEC = { 5: 230, 7: 120, 4: 150, 3: 260, 2: 180, 1: 420, 6: 140 };
const nonHentai = (rows) => rows.filter((r) => r.type_name !== 'Hentai').length;
const typeCalls = (api, T) => api.calls.filter((c) => c.q.t === String(T) && !c.q.h);
const unfiltered = (c) => !c.q.t && !c.q.h && !c.q.ids;
function gapsOk(api) { for (let i = 1; i < api.calls.length; i++) if (api.calls[i].t - api.calls[i - 1].t < 1100) return false; return true; }

// E1 全量顺序 / 间隔 / 完整
{
    const clock = mkClock(T0);
    const rows = genRows(SPEC, 1000, T0);
    const api = mkApi(rows, clock);
    api.asString = true;                                      // 字符串 + BOM 也认
    const { db, av } = mk({ httpGet: api.httpGet, now: clock.now, sleep: clock.sleep });
    const r = await av.runFull();
    ok(r.status === 'done' && r.complete === true, 'full: done + complete', r);
    const c0 = api.calls[0];
    ok(unfiltered(c0) && c0.q.pg === '1' && c0.q.ac === 'detail', 'full: first request = unfiltered page 1 (maxIdAtStart)', c0.q);
    const order = [];
    for (const c of api.calls.slice(1)) if (c.q.t && order[order.length - 1] !== c.q.t) order.push(c.q.t);
    eq(order, ['5', '7', '4', '3', '2', '1'], 'full: types in order 5,7,4,3,2,1');
    ok(!api.calls.some((c) => c.q.t === '6'), 'full: never requests Hentai (t=6)');
    for (const T of [5, 7, 4, 3, 2, 1]) eq(typeCalls(api, T).map((c) => +c.q.pg), Array.from({ length: Math.ceil(SPEC[T] / 100) }, (_, i) => i + 1), `full: t=${T} pages 1..pagecount`);
    ok(gapsOk(api), 'full: ≥1.1 s between request starts');
    ok(api.calls.every((c) => c.siteKey === 'avdb' && c.timeout > 0), 'httpGet gets {timeout, siteKey:"avdb"}');
    eq(db.prepare('SELECT COUNT(*) n FROM avdb').get().n, nonHentai(rows), 'full: every non-Hentai row stored');
    const s = av.stats();
    ok(s.lastFull === clock.t || s.lastFull > T0, 'stats.lastFull set', s);
    ok(s.wm === Math.max(...rows.map((x) => x.id)) && s.cursor === null && s.crawling === false && s.rows === nonHentai(rows), 'stats: wm = newest id, no cursor', s);
    ok(unfiltered(api.calls[api.calls.length - 1]), 'full ends with the delta from maxIdAtStart');
    ok(av.lookup('ABP-001') && av.lookup('ABP-001').variants.join() === 'main,leak', 'crawled rows are joinable (main + leak)');

    // E5 增量:只收 id > 水位,某页最小 id ≤ 水位就停
    const wm0 = av.stats().wm;
    clock.t += DAY;
    const fresh = genRows({ 1: 90, 3: 60, 6: 80, 5: 20 }, wm0 + 1, clock.t, { offset: { 1: 420, 3: 260, 6: 140, 5: 230 } });
    api.add(fresh);
    const n0 = api.calls.length;
    const before = db.prepare('SELECT COUNT(*) n FROM avdb').get().n;
    const d = await av.runDelta();
    const dc = api.calls.slice(n0);
    ok(d.status === 'done' && !d.fallback, 'delta: done', d);
    eq(dc.map((c) => [unfiltered(c), +c.q.pg]), [[true, 1], [true, 2], [true, 3]], 'delta: unfiltered pages until a page reaches the watermark');
    eq(db.prepare('SELECT COUNT(*) n FROM avdb').get().n - before, nonHentai(fresh), 'delta: only new non-Hentai rows added');
    eq(av.stats().wm, Math.max(...fresh.map((x) => x.id)), 'delta: watermark advanced');
    ok(gapsOk(api), 'delta: pacing');
    const nd = av.stats().nextDeltaAt - av.stats().lastDelta;
    ok(nd >= DAY && nd <= DAY + 10 * MIN, 'delta: next run in 24h + 0–10 min jitter', nd);

    // E6 增量 30 页封顶 → 按类型 h= 兜底
    const clock2 = clock;
    clock2.t += 2 * HOUR;
    const wm1 = av.stats().wm;
    const fresh2 = genRows({ 1: 150, 2: 120, 4: 90, 6: 100, 7: 50 }, wm1 + 1, clock2.t, { offset: { 1: 600, 2: 180, 4: 150, 6: 300, 7: 120 } });
    api.add(fresh2);
    const av2 = createAvdb({ db, log: quiet, env: {}, adult: ADULT, httpGet: api.httpGet, now: clock.now, sleep: clock.sleep, opts: { deltaCapPages: 2 } });
    const n1 = api.calls.length;
    const d2 = await av2.runDelta();
    const dc2 = api.calls.slice(n1);
    ok(d2.status === 'done' && d2.fallback === true, 'delta cap → fallback', d2);
    eq(dc2.slice(0, 2).map((c) => [unfiltered(c), +c.q.pg]), [[true, 1], [true, 2]], 'delta: stops unfiltered paging at the cap');
    const fb = dc2.slice(2);
    eq([...new Set(fb.map((c) => c.q.t))], ['1', '2', '3', '4', '5', '7'], 'fallback types 1,2,3,4,5,7 (never 6)');
    ok(fb.every((c) => +c.q.h >= 72), 'fallback h ≥ 72', fb.map((c) => c.q.h));
    ok(fresh2.filter((x) => x.type_name !== 'Hentai').every((x) => db.prepare('SELECT 1 FROM avdb WHERE id=?').get(x.id)), 'fallback: every new row ingested');
    eq(av2.stats().wm, Math.max(...fresh2.map((x) => x.id)), 'fallback: watermark advanced');

    // E7 增量失败 → 暂停,水位不动
    clock.t += DAY;
    const wm2 = av2.stats().wm;
    api.add(genRows({ 1: 150 }, wm2 + 1, clock.t, { offset: { 1: 800 } }));
    api.fail.push({ re: /^\?ac=detail&pg=2$/, n: 99 });
    const ld = av2.stats().lastDelta;
    const d3 = await av2.runDelta();
    ok(d3.status === 'paused' && av2.stats().wm === wm2 && av2.stats().lastDelta === ld, 'delta failure → paused, watermark and lastDelta unchanged', d3);
    ok(av2.stats().pauseUntil > clock.t, 'pauseUntil set');
    api.fail.length = 0;
    eq(await av2.step(), av2.stats().pauseUntil - clock.t, 'step() while paused only waits');

    // E8 不带筛选绝不翻过上限
    const av3 = createAvdb({ db, log: quiet, env: {}, adult: ADULT, httpGet: api.httpGet, now: clock.now, sleep: clock.sleep, opts: { unfilteredMaxPage: 1, deltaCapPages: 5 } });
    L.db.prepare('SELECT 1').get();
    db.prepare("DELETE FROM avdb_state WHERE k='pauseUntil'").run();
    const n3 = api.calls.length;
    const d4 = await av3.runDelta();
    ok(d4.status === 'error' && !api.calls.slice(n3).some((c) => unfiltered(c) && +c.q.pg > 1), 'unfiltered page guard (never past unfilteredMaxPage; 5000 in production)', d4);
    ok(av3._opts.unfilteredMaxPage === 1 && createAvdb({ db, log: quiet, env: {} })._opts.unfilteredMaxPage === 5000, 'default unfiltered cap = 5000');

    // E12 ids= 复取
    const n4 = api.calls.length;
    const rf = await av3.refetch(rows.slice(0, 150).map((x) => x.id));
    const rc = api.calls.slice(n4);
    ok(rf.status === 'done' && rc.length === 2 && rc[0].q.ids.split(',').length === 100 && rc[1].q.ids.split(',').length === 50, 'refetch: 100 ids per request', rf);
}

// E2 total=999 封顶:不信 pagecount,翻到不满一页
{
    const clock = mkClock(T0);
    const rows = genRows({ 1: 1250, 5: 40 }, 1000, T0);
    const api = mkApi(rows, clock);
    api.cap999.add(1);
    const { db, av } = mk({ httpGet: api.httpGet, now: clock.now, sleep: clock.sleep });
    const r = await av.runFull();
    eq(typeCalls(api, 1).map((c) => +c.q.pg), Array.from({ length: 13 }, (_, i) => i + 1), 'total=999 quirk: pages past the fake pagecount (10) until a short page');
    ok(r.status === 'done' && db.prepare("SELECT COUNT(*) n FROM avdb WHERE type_id=1").get().n === 1250, 'total=999 quirk: all rows stored', r);
}

// E3 AVDB_MAX_PAGES + 游标 + 重启从 pg−1 续
{
    const clock = mkClock(T0);
    const rows = genRows(SPEC, 1000, T0);
    const api = mkApi(rows, clock);
    const db = new Database(':memory:');
    const a1 = createAvdb({ db, log: quiet, env: { AVDB_MAX_PAGES: '5' }, adult: ADULT, httpGet: api.httpGet, now: clock.now, sleep: clock.sleep });
    const r1 = await a1.runFull();
    ok(r1.status === 'capped' && api.calls.length === 5, 'AVDB_MAX_PAGES=5 caps the process at 5 pages', { r1, n: api.calls.length });
    eq(a1.stats().cursor, { run: 1, t: 7, pg: 2, phase: 'types' }, 'cursor saved after every page');
    eq((await a1.refetch([1000, 1001])).status, 'capped', 'cap applies across jobs');
    ok(await a1.step() > 0 && api.calls.length === 5, 'scheduler idles once the cap is reached');
    const a2 = createAvdb({ db, log: quiet, env: {}, adult: ADULT, httpGet: api.httpGet, now: clock.now, sleep: clock.sleep });
    const n0 = api.calls.length;
    const r2 = await a2.runFull();
    const c2 = api.calls.slice(n0);
    ok(r2.status === 'done' && c2[0].q.t === '7' && c2[0].q.pg === '1', 'restart resumes at pg−1 (t=7 pg=1)', c2[0] && c2[0].q);
    ok(!c2.some((c) => c.q.t === '5') && !c2.slice(0, -1).some(unfiltered), 'resume does not redo finished types or the start page');
    eq(db.prepare('SELECT COUNT(*) n FROM avdb').get().n, nonHentai(rows), 'resumed crawl complete');
}

// E4 退避 5/30/120s → 暂停 30 分钟 → 续;失败超阈值作废
{
    const clock = mkClock(T0);
    const rows = genRows(SPEC, 1000, T0);
    const api = mkApi(rows, clock);
    api.fail.push({ re: /t=4&pg=2$/, n: 4 });
    const { av } = mk({ httpGet: api.httpGet, now: clock.now, sleep: clock.sleep });
    const r1 = await av.runFull();
    const tries = api.calls.filter((c) => c.q.t === '4' && c.q.pg === '2');
    ok(r1.status === 'paused' && tries.length === 4, 'page fails 4 times → paused', { r1, n: tries.length });
    eq(tries.slice(1).map((c, i) => c.t - tries[i].t), [5000, 30000, 120000], 'backoff 5 s / 30 s / 120 s');
    eq(av.stats().pauseUntil - tries[3].t, 30 * MIN, 'job paused for 30 min');
    eq(av.stats().cursor, { run: 1, t: 4, pg: 2, phase: 'types' }, 'cursor kept at the failing page');
    const n0 = api.calls.length;
    const w = await av.step();
    ok(w > 0 && api.calls.length === n0, 'no requests while paused', w);
    clock.t = av.stats().pauseUntil;
    const r2 = await av.runFull();
    const c2 = api.calls.slice(n0);
    ok(r2.status === 'done' && c2[0].q.t === '4' && c2[0].q.pg === '1' && c2[1].q.pg === '2', 'after the pause: resume from pg−1, failing page succeeds', c2.slice(0, 2).map((c) => c.q));
    ok(gapsOk(api), 'pacing holds across retries');

    const clockB = mkClock(T0);
    const apiB = mkApi(genRows(SPEC, 1000, T0), clockB);
    apiB.fail.push({ re: /t=2&/, n: 1e9 });
    const B = mk({ httpGet: apiB.httpGet, now: clockB.now, sleep: clockB.sleep });
    const seq = [];
    for (let i = 0; i < 8; i++) {
        const r = await B.av.runFull();
        seq.push(r.status);
        if (r.status === 'aborted') break;
        clockB.t = B.av.stats().pauseUntil;
    }
    eq(seq, ['paused', 'paused', 'paused', 'paused', 'paused', 'aborted'], 'more than max(5, 1%) failed pages → run aborted');
    const retryAt = JSON.parse(B.db.prepare("SELECT v FROM avdb_state WHERE k='fullRetryAt'").get().v);
    ok(retryAt - clockB.t === DAY, 'aborted run retried after 24h');
    const nB = apiB.calls.length;
    await B.av.step();
    ok(apiB.calls.length === nB, 'scheduler waits for fullRetryAt');
}

// E9 对账:两轮完整的全量都没见到的行才删;带政策等级的行永不删
{
    const clock = mkClock(T0);
    const rows = genRows({ 1: 120, 5: 30 }, 1000, T0);
    rows[3].category = ['Censored', 'Sneak Shots'];
    const api = mkApi(rows, clock);
    const { db, av } = mk({ httpGet: api.httpGet, now: clock.now, sleep: clock.sleep });
    ok((await av.runFull()).status === 'done', 'reconcile: run 1');
    const gone = [rows[1].id, rows[3].id];
    gone.forEach((id) => api.hidden.add(id));
    clock.t += HOUR;
    const r2 = await av.runFull();
    ok(r2.status === 'done' && r2.dropped === 0 && db.prepare('SELECT COUNT(*) n FROM avdb WHERE id IN (?,?)').get(...gone).n === 2, 'reconcile: run 2 keeps rows missing only once', r2);
    clock.t += HOUR;
    const r3 = await av.runFull();
    ok(r3.status === 'done' && r3.dropped === 1, 'reconcile: run 3 drops the row missing twice', r3);
    ok(!db.prepare('SELECT 1 FROM avdb WHERE id=?').get(gone[0]) && db.prepare('SELECT 1 FROM avdb WHERE id=?').get(gone[1]), 'reconcile: blocked row is never dropped');
    ok(av.lookup(N.normKey(rows[3].movie_code, rows[3].type_name).key).pol === 'block', 'reconcile: block survives');
}

// E10 调度:首轮延迟、全量后每天一次增量;AVDB_DISABLE
{
    const clock = mkClock(T0);
    const rows = genRows({ 1: 120, 5: 30 }, 1000, T0);
    const api = mkApi(rows, clock);
    let av;
    const sleep = async (ms) => { await clock.sleep(ms); if (clock.t > T0 + 3 * DAY) av.stop(); };
    av = createAvdb({ db: new Database(':memory:'), log: quiet, env: { AVDB_FIRST_DELAY_MS: '1000' }, adult: ADULT, httpGet: api.httpGet, now: clock.now, sleep, random: () => 0.5 });
    av.start();
    for (let i = 0; i < 2000 && clock.t <= T0 + 3 * DAY; i++) await tick();
    await av.stop();
    ok(api.calls.length > 0 && api.calls[0].t === T0 + 1000, 'scheduler: first request after AVDB_FIRST_DELAY_MS', api.calls[0] && api.calls[0].t - T0);
    const fullEnd = api.calls.findIndex((c, i) => i > 0 && unfiltered(c));
    const deltas = api.calls.slice(fullEnd + 1).filter((c) => unfiltered(c) && c.q.pg === '1');
    ok(deltas.length === 2, 'scheduler: one delta per day after the full crawl (2 in ~3 days)', deltas.map((c) => (c.t - T0) / HOUR));
    ok(deltas.length >= 1 && deltas[0].t - api.calls[fullEnd].t >= DAY && deltas[0].t - api.calls[fullEnd].t <= DAY + 10 * MIN, 'scheduler: delta at 24h + jitter', deltas[0] && (deltas[0].t - api.calls[fullEnd].t) / MIN);
    ok(!api.calls.some((c) => c.q.t === '6'), 'scheduler never requests Hentai');

    const clockD = mkClock(T0);
    const apiD = mkApi(rows, clockD);
    const D = createAvdb({ db: new Database(':memory:'), log: quiet, env: { AVDB_DISABLE: '1', AVDB_FIRST_DELAY_MS: '0' }, adult: ADULT, httpGet: apiD.httpGet, now: clockD.now, sleep: clockD.sleep });
    D.start();
    for (let i = 0; i < 50; i++) await tick();
    await D.stop();
    ok(apiD.calls.length === 0 && D.stats().disabled === true, 'AVDB_DISABLE=1: no requests');
    ok(createAvdb({ db: new Database(':memory:'), log: quiet, env: {} })._opts.firstDelayMs === 600000, 'default first delay 10 min');
}

// ==================== ④b 只读实例(主线程):写实例之后才见到的拦截标签也要拦 ====================
console.log('④b read-only instance vs block tags first seen by the writer');
{
    const db = new Database(':memory:');
    const clk = mkClock(T0);
    const Wr = createAvdb({ db, log: quiet, env: {}, adult: ADULT, now: clk.now, sleep: clk.sleep });
    const row = (id, mc, cats) => ({ id, type_name: 'Censored', movie_code: mc, name: mc + ' A Plain Story', actor: [], director: [], category: cats, time: '02:00:00', created_at: '2026-11-01' });
    Wr.ingest([row(910001, 'TSTA-001', ['Big Breasts'])], { run: 1 });
    // 主线程实例先建好:标签等级表载入的是"当时"的(这时库里还没有任何拦截标签)
    const Rd = createAvdb({ db, log: quiet, env: { AVDB_DISABLE: '1' }, adult: ADULT, now: clk.now, sleep: clk.sleep });
    const v0 = Rd.polVersion();
    ok(Rd.lookup('TSTA-001') && Rd.lookup('TSTA-001').pol === null && Rd.pol('TSTA-001') === null && Rd.pol('NOPE-001') === null, 'reader: clean row / miss → no pol');
    Wr.ingest([row(910002, 'TSTB-002', ['High School Girl'])], { run: 1 });
    const b = Rd.lookup('TSTB-002');
    ok(b && b.pol === 'block' && Rd.pol('TSTB-002') === 'block' && b.actors.length === 0 && b.tags.length === 0, 'reader: block tag first seen after the reader was created → block (stored row pol)', b);
    ok(Rd.polVersion() !== v0 && Rd.stats().polchg === Rd.polVersion(), 'polVersion bumps when a policy-flagged row arrives (also in stats().polchg)', [v0, Rd.polVersion()]);
    Wr.ingest([row(910001, 'TSTA-001', ['Big Breasts', 'Sleeping'])], { run: 1 });
    ok(Rd.pol('TSTA-001') === 'block' && Rd.lookup('TSTA-001').pol === 'block', 'reader: an existing clean row re-tagged with a new block tag → block');
    const v1 = Rd.polVersion();
    Wr.ingest([row(910003, 'TSTC-003', ['Big Breasts'])], { run: 1 });
    ok(Rd.polVersion() === v1, 'clean rows do not bump polVersion');
    ok(Rd.recent(3650).indexOf('TSTB-002') < 0 && Rd.recent(3650).indexOf('TSTA-001') < 0 && Rd.recent(3650).indexOf('TSTC-003') >= 0, 'reader recent(): newly blocked keys excluded');
    // 实时算那半边:读实例的标签等级表按 MAX(tid) 增量补(2 秒一查)—— 存的 pol 清掉也照样拦
    db.prepare("UPDATE avdb SET pol='', polg='' WHERE id=910002").run();
    clk.t += 3000;
    ok(Rd.pol('TSTB-002') === 'block', 'reader: tag-level table synced incrementally (live half also blocks)');
    // 行级重算(规则版本变了)只按实时算,不被存的旧等级卡住(规则放宽时能放出来)
    db.prepare("UPDATE avdb SET pol='block', polg=',x,' WHERE id=910003").run();
    db.prepare("UPDATE avdb_state SET v='\"old\"' WHERE k='polv_rows'").run();
    ok(Rd.pol('TSTC-003') === 'block', 'stale stricter stored pol wins on reads until recomputed (fail-closed)');
    const rc = await Wr.recomputePolicy();
    ok(rc.status === 'done' && rc.changed >= 1 && Rd.pol('TSTC-003') === null && Rd.pol('TSTB-002') === 'block', 'recomputePolicy uses the live classification (not the stored value)', rc);
}

// ==================== ⑤ 调研数据离线命中率(有 .adult-research 时) ====================
{
    const f = path.join(ROOT, '.adult-research/impl/p34/join-raw.json');
    if (fs.existsSync(f)) {
        console.log('⑤ research join-raw (offline)');
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        const { av } = mk({});
        const list = [];
        const seen = new Set();
        for (const wk of Object.keys(raw)) for (const h of raw[wk].hits || []) {
            if (seen.has(h.id)) continue; seen.add(h.id);
            list.push({ id: h.id, movie_code: h.mc, type_name: h.type, name: h.name, actor: h.actor, director: h.director, category: h.cat, created_at: h.ct, time: h.time, vod_time: h.vt });
        }
        av.ingest(list, { run: 1 });
        let n = 0, hit = 0, wrong = 0;
        for (const wk of Object.keys(raw)) {
            const key = wk.slice(wk.indexOf(':') + 1);
            const got = av.lookup(key);
            const expect = (raw[wk].hits || []).some((h) => h.match === true || h.match === 'pad' || h.match === 'studio-unknown');
            if (wk.startsWith('c:')) { n++; if (got) hit++; }
            if (got && !expect) wrong++;
        }
        console.log(`  real codes: ${hit}/${n} = ${(hit / n * 100).toFixed(1)}%`);
        ok(hit / n >= 0.9, 'research real-code join rate ≥ 90%', { hit, n });
        ok(wrong === 0, 'no lookup hit where the research found no match', wrong);
    } else console.log('⑤ (skipped: .adult-research not present)');
}

console.log(`\navdb-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
