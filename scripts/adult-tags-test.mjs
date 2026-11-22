#!/usr/bin/env node
// [adult] 标签词表 / 打标签离线测试(lib/adult/tags.js + tag-vocab.json,零网络):
//   node scripts/adult-tags-test.mjs
// 覆盖:接口形状(VOCAB/GROUPS/LEGACY)、词表自检(每个非 blocked 同义词对 taxonomy.classify 不能是硬拦、featured 不能是审查级 hide/code,
//   policy.checkQuery 不能拦 featured 同义词;金样例)、tagLine 各来源(cat/raw/title/flag、拼音 slug、分类回显、备注、番号不触发 vr/sm/69、
//   题材组只在题材大类、blocked 只出信号、欧美片商、AI 改写标题站 ai 标记)、mergeWork 严格口径(只有 AI 标题来源的标签要别的线路或 AVDB 证实)、
//   tagsFromAvdb(AVDB 硬拦/审查隐藏标签永不成为标签、映射样例、逗号串/&amp;/大小写)、审查级永不 featured、RULES_VERSION 指纹含 tag-vocab.json/tags.js、性能。
// 改 lib/adult/tags.js / tag-vocab.json 后必跑。失败退出码非 0。样例片名全部合成,不含真人姓名。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'lib/adult');
const adult = require(LIB);
const T = adult.tags;
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adult/tags-cases.json'), 'utf8'));
const AVFX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/adult/tags-avdb.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
    if (cond) pass++;
    else { fail++; failures.push(name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

// ============ 1. 接口形状 ============
{
    for (const k of ['VERSION', 'VOCAB', 'GROUPS', 'LEGACY', 'tagLine', 'tagsFromAvdb', 'mergeWork', 'isFeatured', 'isReview', 'label', 'group']) ok(k in T, 'shape: 导出 ' + k);
    ok(typeof T.VERSION === 'string' && T.VERSION.length > 0, 'shape: VERSION');
    ok(adult.tags === T, 'shape: lib/adult 导出 tags');
    const kinds = {};
    for (const v of T.VOCAB) kinds[v.kind] = (kinds[v.kind] || 0) + 1;
    eq(T.VOCAB.length, 163, 'vocab: 163 条');
    // 2026-11-22:媚药 / 睡眠 从 review 改成 blocked(x_aphrodisiac / x_sleep):下药 / 失去意识题材永不露出(与 AVDB 同口径)
    eq(kinds, { featured: 132, review: 21, blocked: 10 }, 'vocab: 132 featured / 21 review / 10 blocked');
    ok(T.VOCAB.every((v) => typeof v.id === 'string' && typeof v.label === 'string' && typeof v.group === 'string' && Array.isArray(v.syn)), 'vocab: 每条有 id/label/group/syn');
    ok(T.VOCAB.filter((v) => v.kind === 'blocked').every((v) => v.syn.length === 0 && v.group === '_blocked'), 'vocab: blocked 不暴露同义词、在 _blocked 组');
    ok(T.VOCAB.filter((v) => v.kind !== 'blocked').every((v) => v.group !== '_blocked'), 'vocab: 非 blocked 不在 _blocked 组');
    eq(T.GROUPS.map((g) => g.id), ['spec', 'origin', 'body', 'persona', 'outfit', 'setting', 'act', 'story', 'genre'], 'groups: 9 个分面组按顺序');
    ok(T.GROUPS.every((g) => typeof g.label === 'string' && g.label), 'groups: 有 label');
    const gids = new Set(T.GROUPS.map((g) => g.id));
    ok(T.VOCAB.filter((v) => v.kind !== 'blocked').every((v) => gids.has(v.group)), 'vocab: 非 blocked 的组都在 GROUPS');
    // LEGACY:旧 taxonomy 每个标签(厂牌伪标签除外)都有新 id,且新 id 非 blocked
    const legacyIds = adult.taxonomy.TAGS.map((t) => t.id).filter((id) => id !== 'studio');
    for (const id of legacyIds) ok(typeof T.LEGACY[id] === 'string' && T.VOCAB.some((v) => v.id === T.LEGACY[id] && v.kind !== 'blocked'), 'legacy: ' + id + ' → ' + T.LEGACY[id]);
    ok(!('studio' in T.LEGACY), 'legacy: studio 伪标签不映射');
    eq(T.LEGACY.milf, 'wife', 'legacy: milf → wife');
    eq(T.LEGACY.oral, 'blowjob', 'legacy: oral → blowjob');
    eq(T.LEGACY.bbc, 'interracial', 'legacy: bbc → interracial');
}

// ============ 2. 词表自检(同义词 vs 分类体系 / 搜索词拦截;金样例) ============
{
    const r = T.selftest();
    eq(r.errs, [], 'selftest: 无错误');
    ok(Array.isArray(r.warns), 'selftest: warns 是数组');
    // 已知的有意多义 token 之外不该有别的告警
    const unexpected = r.warns.filter((w) => w !== 'token "丝足" → stockings,footjob');
    eq(unexpected, [], 'selftest: 无意外告警');
}

// ============ 3. 审查级 / blocked 的可见性 ============
{
    for (const v of T.VOCAB) {
        if (v.kind === 'review') {
            ok(!T.isFeatured(v.id) && T.isReview(v.id), 'review 永不 featured: ' + v.id);
            ok(T.label(v.id) === v.label && T.group(v.id) === v.group && T.resolve(v.id) === v.id, 'review 可解析(只做筛选): ' + v.id);
        } else if (v.kind === 'blocked') {
            ok(!T.isFeatured(v.id) && !T.isReview(v.id) && T.label(v.id) === '' && T.group(v.id) === '' && T.resolve(v.id) === '', 'blocked 不可解析: ' + v.id);
            ok(T.signalKind(v.id) === 'block-item' || T.signalKind(v.id) === 'no-tag', 'blocked 有 signalKind: ' + v.id);
        } else {
            ok(T.isFeatured(v.id) && !T.isReview(v.id) && T.label(v.id) === v.label, 'featured: ' + v.id);
        }
    }
    eq(T.signalKind('x_studio'), 'block-item', 'signalKind: x_studio');
    eq(T.signalKind('x_minor'), 'block-item', 'signalKind: x_minor');
    eq(T.signalKind('x_school'), 'no-tag', 'signalKind: x_school');
    eq(T.signalKind('busty'), null, 'signalKind: 普通标签 null');
    for (const id of ['incest', 'noncon', 'hypnosis', 'timestop', 'drunk', 'chikan', 'small_tits', 'college', 'teacher', 'exhibition', 'virgin']) ok(T.isReview(id), 'review 名单: ' + id);
    // 下药 / 失去意识:旧 id(aphrodisiac / sleep)和新的 blocked id 都解析不出来(浏览 t= / 标签页 → 空 / 404),命中只出信号
    for (const id of ['aphrodisiac', 'sleep', 'x_aphrodisiac', 'x_sleep']) ok(T.resolve(id) === '' && !T.isReview(id) && !T.isFeatured(id) && T.label(id) === '', 'drugging/sleep 不可解析: ' + id);
    for (const [txt, sig] of [['媚药调教', 'x_aphrodisiac'], ['春药合集', 'x_aphrodisiac'], ['睡奸熟睡的人妻', 'x_sleep'], ['夜袭', 'x_sleep']]) {
        const r = T.tagLine({ vod_name: txt }, {});
        ok(r.signals.includes(sig) && !r.tags.some((x) => /aphrodisiac|sleep/.test(x.id)), 'drugging/sleep 只出信号: ' + txt, r);
        ok(adult.policy.checkItem({ vod_name: txt, type_name: '国产传媒' }, {}).reason === 'item:drugging' && adult.policy.checkQuery(txt) === true, 'block-item 信号 → 政策硬拦(条目 + 搜索词): ' + txt);
    }
    // 词表里每个 block-item 的同义词,政策都要拦(词表说"policy must also hard-block";只看片名)。
    //   已知例外:单独的"摄像头"(主播对着摄像头 / 露出)政策有意不拦,只拦 隐藏/偷装/破解…摄像头 这类搭配(policy.js voyeur 组注释)
    const NOT_ALONE = new Set(['x_voyeur|摄像头']);
    for (const t of JSON.parse(fs.readFileSync(path.join(LIB, 'tag-vocab.json'), 'utf8')).tags) {
        if (t.status !== 'blocked' || t.policy !== 'block-item') continue;
        for (const zh of t.zh || []) if (!NOT_ALONE.has(t.id + '|' + zh)) ok(!adult.policy.checkItem({ vod_name: '某某' + zh + '合集', type_name: '国产传媒' }, {}).ok, 'block-item 同义词被政策拦: ' + t.id + ' ' + zh);
    }
    eq(T.resolve('milf'), 'wife', 'resolve: 旧 id');
    eq(T.resolve('constructor'), '', 'resolve: 原型链键不解析');
    eq(T.resolve('__proto__'), '', 'resolve: __proto__');
    eq(T.resolve(''), '', 'resolve: 空');
    eq(T.resolve(null), '', 'resolve: null');
    eq(T.label('nope'), '', 'label: 未知');
    eq(T.fromWord('黑丝'), ['black_stockings'], 'fromWord: 黑丝');
    eq(T.fromWord('萝莉'), [], 'fromWord: blocked 词不出');
    eq(T.fromWord('乱伦'), ['incest'], 'fromWord: 审查级可出(调用方自己判 featured)');
}

// ============ 4. tagLine ============
function lineCase(c) {
    const r = T.tagLine(c.item, c.ctx);
    const by = new Map(r.tags.map((x) => [x.id, x]));
    for (const w of c.want || []) {
        const [idsrc, aiMark] = w.split('~');
        const [id, src] = idsrc.split(':');
        const got = by.get(id);
        ok(!!got, `line[${c.name}]: 有 ${id}`, r.tags);
        if (got && src) ok(got.src === src, `line[${c.name}]: ${id} 来源 ${src}`, got);
        if (got) ok(aiMark === 'ai' ? got.ai === true : got.ai === undefined, `line[${c.name}]: ${id} ai 标记${aiMark === 'ai' ? '有' : '无'}`, got);
    }
    for (const n of c.not || []) ok(!by.has(n), `line[${c.name}]: 无 ${n}`, r.tags);
    if (c.signals) eq(r.signals, c.signals, `line[${c.name}]: signals`);
    if (c.want && c.want.length === 0) eq(r.tags, [], `line[${c.name}]: 无标签`);
    if (c.studio !== undefined) eq(r.studio, c.studio, `line[${c.name}]: studio`);
    // 不变量:每个标签一条、只出合法来源、blocked 永不出现、按词表顺序
    ok(new Set(r.tags.map((x) => x.id)).size === r.tags.length, `line[${c.name}]: 每个标签一条`);
    ok(r.tags.every((x) => ['cat', 'raw', 'title', 'flag'].includes(x.src)), `line[${c.name}]: 来源合法`, r.tags);
    ok(r.tags.every((x) => T.resolve(x.id) === x.id), `line[${c.name}]: 无 blocked/未知`, r.tags);
    const order = T.VOCAB.map((v) => v.id);
    ok(r.tags.every((x, i) => i === 0 || order.indexOf(r.tags[i - 1].id) < order.indexOf(x.id)), `line[${c.name}]: 词表顺序`);
}
for (const c of FX.line) lineCase(c);
{
    // 形状与容错
    const r = T.tagLine(null, null);
    eq(r, { tags: [], signals: [], studio: '' }, 'line: null 输入');
    const r2 = T.tagLine({ vod_name: 12345, vod_tag: { a: 1 }, type_name: ['x'] }, { site: 42, parsed: 'x', cls: 7 });
    ok(Array.isArray(r2.tags) && Array.isArray(r2.signals), 'line: 怪类型字段不抛');
    const long = '巨乳'.repeat(5000);
    ok(T.tagLine({ vod_name: long, vod_tag: long }, {}).tags.some((x) => x.id === 'busty'), 'line: 超长字段截断不抛');
    // classNames 传 Set(原始分类名)也认;同一个对象反复传结果一致
    const cn = new Set(['国产', '人妻熟女']);
    for (let i = 0; i < 2; i++) {
        const r3 = T.tagLine({ vod_name: '测试', type_name: '国产', vod_class: '人妻熟女' }, { site: 't02', classNames: cn });
        ok(r3.tags.some((x) => x.id === 'wife' && x.src === 'cat'), 'line: classNames 为 Set 时回显记 cat #' + i, r3.tags);
    }
    // site 对象 aiTitles:true 会记住;false 会取消
    T.tagLine({ vod_name: '测试' }, { site: { key: 'zz_learn', aiTitles: true } });
    ok(T.isAiTitleSite('zz_learn'), 'ai: 站点对象 aiTitles:true 被记住');
    T.tagLine({ vod_name: '测试' }, { site: { key: 'zz_learn', aiTitles: false } });
    ok(!T.isAiTitleSite('zz_learn'), 'ai: aiTitles:false 取消');
    ok(T.isAiTitleSite('av_s04') && T.isAiTitleSite('av_s10') && T.isAiTitleSite('av_s14') && T.isAiTitleSite('av_s16'), 'ai: 默认 2609 改写标题站');
    ok(!T.isAiTitleSite('av_s00') && !T.isAiTitleSite('av_s07') && !T.isAiTitleSite('av_s26'), 'ai: 2609 系里标题没改写的站不算');
}
{
    // 与 db.adult.json 的 aiTitles 一致(调研目录在才查)
    const dbp = path.join(ROOT, '.adult-research/db.adult.json');
    if (fs.existsSync(dbp)) {
        const db = JSON.parse(fs.readFileSync(dbp, 'utf8').replace(/^﻿/, ''));
        const ai = (db.sites || []).filter((s) => s.aiTitles === true).map((s) => s.key).sort();
        eq(ai, ['av_s04', 'av_s10', 'av_s14', 'av_s16'], 'db.adult.json: aiTitles 站');
        ok(ai.every((k) => T.isAiTitleSite(k)), 'db.adult.json: aiTitles 站都在默认表里');
    }
}

// ============ 5. mergeWork(严格口径) ============
for (const c of FX.merge) eq(T.mergeWork(c.lines, c.avdb, c.opts), c.want, 'merge[' + c.name + ']');
{
    eq(T.mergeWork(), [], 'merge: 无参数');
    eq(T.mergeWork(null, null), [], 'merge: null');
    eq(T.mergeWork([null, 'x', [null, 5, {}]]), [], 'merge: 垃圾输入');
    // setAiTitleSites 换表
    const before = T.isAiTitleSite('av_s04');
    T.setAiTitleSites(['zz_only']);
    eq(T.mergeWork([[{ id: 'busty', src: 'title', site: 'av_s04' }], [{ id: 'legs', src: 'title', site: 'zz_only' }]]), ['busty'], 'merge: setAiTitleSites 换表生效');
    T.setAiTitleSites([{ key: 'av_s04', aiTitles: true }, { key: 'av_s10' }, { key: 'zz_off', aiTitles: false }, 'av_s14', 'av_s16', 'av_s27']);
    ok(T.isAiTitleSite('av_s04') === before && T.isAiTitleSite('av_s10') && !T.isAiTitleSite('zz_off'), 'merge: setAiTitleSites 认站点对象');
    // 端到端:AI 站片名 + 普通站分类
    const a = T.tagLine({ vod_name: '[ABC-123] 极品人妻 巨乳爆操', type_name: '人妻熟女' }, { site: 'av_s14' });
    const b = T.tagLine({ vod_name: 'ABC-123 测试', type_name: '日本有码' }, { site: 't09' });
    const m = T.mergeWork([a.tags.map((x) => Object.assign({ site: 'av_s14' }, x)), b.tags.map((x) => Object.assign({ site: 't09' }, x))]);
    ok(m.includes('wife') && m.includes('mature') && !m.includes('busty') && !m.includes('hardcore'), 'merge: 端到端 AI 片名标签被丢、分类标签保留', m);
    const m2 = T.mergeWork([a.tags, b.tags], T.tagsFromAvdb(['Big Breasts']));
    ok(m2.includes('busty') && !m2.includes('hardcore'), 'merge: 端到端 AVDB 证实 巨乳', m2);
    // 落库往返:packLine/unpackLine 保住 AI 标记,mergeWork 结果不变
    const pa = T.packLine(a.tags);
    ok(/^,.*,$/.test(pa) && pa.includes(',busty~,') && pa.includes(',wife,'), 'pack: AI 标签带 ~,可信标签不带', pa);
    eq(T.mergeWork([T.unpackLine(pa), T.unpackLine(T.packLine(b.tags))]), m, 'pack: 往返后 mergeWork 结果一致');
    eq(T.packLine([]), '', 'pack: 空');
    eq(T.packLine(['milf', 'x_minor', 'nope', { id: 'legs', src: 'title', ai: true }]), ',wife,legs~,', 'pack: 旧 id 映射、blocked/未知丢弃');
    eq(T.unpackLine(',busty,x_minor,legs~,oral,,~,'), [{ id: 'busty' }, { id: 'legs', src: 'title', ai: true }, { id: 'blowjob' }], 'unpack: blocked/空段丢弃、旧 id 映射');
    eq(T.unpackLine(null), [], 'unpack: null');
}

// ============ 6. tagsFromAvdb ============
for (const c of FX.avdb) eq(T.tagsFromAvdb(c.tags, c.opts).map((x) => x.id), c.want, 'avdb: ' + JSON.stringify(c.tags) + (c.opts ? ' ' + JSON.stringify(c.opts) : ''));
{
    ok(T.tagsFromAvdb(['Big Breasts']).every((x) => x.src === 'avdb'), 'avdb: src 恒为 avdb');
    eq(T.tagsFromAvdb(null), [], 'avdb: null');
    eq(T.tagsFromAvdb('Big Breasts,Creampie').map((x) => x.id), ['busty', 'creampie'], 'avdb: 单个逗号串');
    eq(T.tagsFromAvdb([5, null, {}]), [], 'avdb: 垃圾输入');
    // AVDB 硬拦 / 审查隐藏 / 只靠模式命中的 / 合成的:一个都不能成为标签(单独、混在正常标签里、大小写/&amp; 变体)
    const all = AVFX.block.concat(AVFX.reviewHide, AVFX.patternOnly, AVFX.synthetic);
    ok(AVFX.block.length >= 60 && AVFX.reviewHide.length >= 40, 'avdb fixture 完整');
    for (const t of all) {
        eq(T.tagsFromAvdb([t]), [], 'avdb 拦截: ' + t);
        eq(T.tagsFromAvdb([t.toUpperCase()]), [], 'avdb 拦截(大写): ' + t);
    }
    eq(T.tagsFromAvdb(all.concat(['Big Breasts'])).map((x) => x.id), ['busty'], 'avdb: 拦截标签混在正常标签里只出正常的');
    eq(T.tagsFromAvdb([all.join(',')]), [], 'avdb: 拦截标签拼成逗号串');
    // AVDB 来的审查级标签只能是 review,不会是 featured
    const rev = T.tagsFromAvdb(['Rape', 'Incest', 'Hypnosis', 'Time Stop', 'Molester', 'Humiliation', 'Stepmother', 'Drunk']).map((x) => x.id);
    ok(rev.length >= 6 && rev.every((id) => T.isReview(id)), 'avdb: 审查类 AVDB 标签只成 review 标签', rev);
    // 词表里每个非 blocked 标签的 en 都能被映射回来(不被拦截表吞掉;VOCAB 不暴露 en,从 JSON 取)
    const vocab = JSON.parse(fs.readFileSync(path.join(LIB, 'tag-vocab.json'), 'utf8'));
    // tag-vocab.json 的 avdb 段是 lib/adult-avdb/policy-tags.json 的手抄副本:两边必须一致
    //   (只改一边 = AVDB 的拦截标签在这边没登记 → 悄悄变成可浏览标签,或那边不拦;没有测试守着就是静默的政策洞)
    {
        const pt = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/adult-avdb/policy-tags.json'), 'utf8').replace(/^﻿/, ''));
        const lc = (a) => [...new Set((a || []).map((x) => String(x).toLowerCase().replace(/&amp;/g, '&').trim()))].sort();
        const flat = (groups) => lc(Object.values(groups || {}).flat());
        const av = vocab.avdb;
        eq(lc(av.block), flat(pt.lists.block), 'avdb 副本一致: block = policy-tags lists.block');
        eq(lc(av.noTag), flat(pt.lists.review_hide), 'avdb 副本一致: noTag = policy-tags lists.review_hide');
        eq(lc(av.review), flat(pt.lists.review_code), 'avdb 副本一致: review = policy-tags lists.review_code');
        eq(lc(av.allow), lc(pt.allow), 'avdb 副本一致: allow');
        eq((av.blockPatterns || []).slice().sort(), pt.patterns.block.map((p) => p.regex).sort(), 'avdb 副本一致: blockPatterns = patterns.block');
        eq((av.noTagPatterns || []).slice().sort(), pt.patterns.review_hide.map((p) => p.regex).sort(), 'avdb 副本一致: noTagPatterns = patterns.review_hide');
    }
    let enN = 0;
    for (const t of vocab.tags) {
        if (t.status === 'blocked') continue;
        for (const en of t.en || []) {
            enN++;
            const ids = T.tagsFromAvdb([en]).map((x) => x.id);
            ok(ids.includes(t.id), 'avdb en 可映射: ' + t.id + ' "' + en + '"', ids);
        }
    }
    ok(enN > 400, 'avdb: 词表 en 映射条数', enN);
    // blocked 标签的 en 永远映射不出任何 blocked id
    for (const t of vocab.tags) {
        if (t.status !== 'blocked') continue;
        for (const en of t.en || []) ok(T.tagsFromAvdb([en]).every((x) => T.resolve(x.id) === x.id), 'avdb blocked en 不出 blocked id: ' + en);
    }
}

// ============ 7. RULES_VERSION 指纹含 tag-vocab.json / tags.js ============
{
    const policyPath = require.resolve(path.join(LIB, 'policy.js'));
    const base = adult.RULES_VERSION;
    const realRead = fs.readFileSync;
    const versionWith = (target) => {
        delete require.cache[policyPath];
        fs.readFileSync = function (p, ...rest) {
            const out = realRead.call(fs, p, ...rest);
            return typeof p === 'string' && path.basename(p) === target && typeof out === 'string' ? out + '\n ' : out;
        };
        try { return require(policyPath).RULES_VERSION; } finally { fs.readFileSync = realRead; delete require.cache[policyPath]; }
    };
    ok(typeof base === 'string' && base.length > 10, 'rules: RULES_VERSION');
    const vVocab = versionWith('tag-vocab.json');
    const vTags = versionWith('tags.js');
    ok(vVocab !== base, 'rules: 改 tag-vocab.json → RULES_VERSION 变', { base, vVocab });
    ok(vTags !== base, 'rules: 改 tags.js → RULES_VERSION 变', { base, vTags });
    eq(require(policyPath).RULES_VERSION, base, 'rules: 内容不变 → RULES_VERSION 稳定');
}

// ============ 8. 性能 ============
{
    const items = FX.line.map((c) => [c.item, c.ctx]);
    const N = 4000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) { const [it, ctx] = items[i % items.length]; T.tagLine(it, ctx); }
    const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
    console.log(`  perf: tagLine ${us.toFixed(1)} µs/条`);
    ok(us < 500, 'perf: tagLine < 500µs/条', us);
}

console.log(`adult-tags-test: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  FAIL ' + f); process.exit(1); }
