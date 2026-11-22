// [adult] 逐条/逐作品打标签:资源站一条线路 → 词表标签;多条线路 + AVDB → 作品标签(严格口径)。
//
// 词表在同目录 tag-vocab.json(调研 impl/cat/tag-vocab.json + impl/p34 tag-map/avdb-policy-tags 移植,163 条,9 个分面组):
//   featured = 可做导航标签 / 标签云 / 相关标签 / 首页行;review = 只能在筛选里选(全部标签页、作品页),永不做 chip、永不进相关/首页;
//   blocked  = 永不成为标签、永不接受为筛选,命中只作为 signals 回给调用方(policy 才决定条目能不能露出)。
// 加载即校验:文件缺失 / JSON 坏 / 结构不对 / 正则编译失败 / 金丝雀没过 —— 一律 throw(fail-closed,和 taxonomy.js 一样)。
// tag-vocab.json 与本文件都进 RULES_VERSION 指纹(policy.js):词表一改,目录自动重扫。
//
// 公共 API:
//   VERSION                                词表版本
//   VOCAB   [{id,label,group,kind:'featured'|'review'|'blocked',syn:[],weight}]   blocked 的 syn 恒为 []
//   GROUPS  [{id,label}]                   9 个分面组(不含 _blocked),按 order
//   LEGACY  {旧 taxonomy 标签 id: 新 id}   旧 ?tag= 链接 / 分类派生标签用(studio 厂牌伪标签没有对应)
//   tagLine(rawItem, {site, parsed, cls, bucket?, classNames?})
//       rawItem: maccms 原始字段(vod_name / vod_sub / type_name / vod_tag / vod_class / vod_remarks)
//       site:    站点 key 字符串,或站点对象 {key, aiTitles?}(aiTitles:true = AI 改写标题的站,见 setAiTitleSites)
//       parsed:  title.parseTitle() 结果(flags → 中字/无码/无码流出/4K;studio)
//       cls:     taxonomy.buildClassMap 的一行({name,parentName,bucket,tags});没有就按 type_name 现分类
//       bucket:  (可选)入库最终大类(mixed/uncat 路由之后的),不给就用 cls.bucket
//       classNames:(可选)本站全部分类名(Set/数组),vod_class 回显分类名的 token 记为 cat 来源
//     → {tags:[{id, src:'cat'|'raw'|'title'|'flag', ai?:true}], signals:[blocked id...], studio:''}
//       每个标签一条,src 取最可信的来源(cat > raw > flag > title);只有 AI 改写标题命中的标签带 ai:true。
//       signals:x_minor / x_voyeur / x_drug / x_deepfake / x_leak / x_bestiality / x_studio(signalKind = 'block-item'),
//                x_school / x_ai(signalKind = 'no-tag')—— 只是信号,条目能否露出由 policy 决定。
//       studio: 片商(parseTitle().studio / souav "传媒-X" / 粘在英文片名里的欧美片商),没有就 ''
//   tagsFromAvdb(enTags, {bucket?}) → [{id, src:'avdb'}]
//       AVDB 英文标签(category[] ∪ tag,逗号串也认;&amp; 解码;大小写无关)经词表 en 映射;
//       AVDB 硬拦/审查隐藏标签(学生/校服/偷拍/迷药/睡眠/teen/daughter/AI…)永不成为标签(AVDB 模块管政策)。
//   mergeWork(lineTagLists, avdbTags?, {bucket?}) → string[]
//       lineTagLists: [[{id, src, site?, ai?}...] 每条线路一组];也认纯 id 字符串(当作可信来源)和旧 taxonomy id(经 LEGACY)。
//       严格口径:一个标签如果唯一的来源是 AI 改写标题站(ai:true,或 site 是 aiTitles 站)的片名,
//                必须有另一条线路的非 AI 片名来源或 AVDB 证实,否则丢掉。blocked 永不输出。按词表顺序返回。
//       bucket 给了且不是题材大类(短剧/三级/动漫/解说/国产传媒)→ 题材组标签(都市/古装/仙侠…)不输出。
//   isFeatured(id) / isReview(id) / label(id) / group(id)     blocked / 未知 id → false / ''(旧 id 经 LEGACY 解析)
//   resolve(id)       → 词表 id(LEGACY 映射后)| ''(未知 / blocked);浏览参数 t= / x= 用它校验
//   fromWord(word)    → [id](与某个标签名/同义词完全相同的非 blocked 标签;搜索建议用)
//   signalKind(id)    → 'block-item' | 'no-tag' | null
//   packLine(tags) → ',busty,wife,creampie~,'   unpackLine(str) → [{id} | {id,src:'title',ai:true}]
//                     线路标签落库用('~' = 只来自 AI 改写标题);unpackLine 的结果直接喂 mergeWork,严格口径不丢
//   setAiTitleSites(keys) / isAiTitleSite(site)   AI 改写标题的站(默认 tag-vocab.json aiTitleSites;
//                     tagLine 收到 {key, aiTitles:true/false} 的站点对象会顺手记住/取消)
//   selftest()        → {errs:[], warns:[]}:每个非 blocked 同义词对 taxonomy.classify / policy.checkQuery 的碰撞检查 + 金样例
'use strict';

const DATA = require('./tag-vocab.json');   // 缺文件 / 坏 JSON 在这里就抛
const taxonomy = require('./taxonomy');
const { t2s } = require('./t2s');

function fail(msg) { throw new Error('[adult/tags] tag-vocab.json 无效: ' + msg); }
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- 归一化 ----------
const norm = (s) => t2s(String(s == null ? '' : s).normalize('NFKC')).toLowerCase();
const compact = (s) => norm(s).replace(/[\s​-‏﻿⠀]+/g, '');
const TOKEN_SPLIT = /[,，、|/;；\s]+/u;
// 番号 / 站点编号:ASCII 正则(vr/ol/sm/3p/69/4k…)匹配前先去掉,防 VRKM-123、SMBD-161、ABC-069
const CODE_RE = /(?:^|[^a-z0-9])[a-z]{1,8}[-_ ]?\d{2,6}(?:[-_][a-z0-9]{1,6})?(?=$|[^a-z0-9])/gi;
const REMARK_SKIP = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$|^[a-z]{2,6}-?\d{2,6}$|^更新|^第\d+集|集$/;
// 大类本身就说明的标签(来源记 cat)
const BUCKET_IMPLIED = { jp_uncensored: ['uncensored'], jp_subbed: ['subbed'], live: ['cam'], creators: ['influencer'], cn_hookup: ['hookup'], short: ['vertical'] };
const SRC_RANK = { cat: 0, raw: 1, flag: 2, title: 3, title_ai: 4 };

// ---------- 结构校验(坏了就抛) ----------
if (!DATA || typeof DATA !== 'object' || Array.isArray(DATA)) fail('不是对象');
if (typeof DATA.version !== 'string' || !DATA.version) fail('缺 version');
for (const k of ['groups', 'tags', 'genreBuckets', 'discardTokens', 'aiTitleSites']) if (!Array.isArray(DATA[k]) || !DATA[k].length) fail(k + ' 不是非空数组');
const strArr = (a, where) => {
    if (a == null) return [];
    if (!Array.isArray(a)) fail(where + ' 不是数组');
    for (const x of a) if (typeof x !== 'string') fail(where + ' 含非字符串');
    return a;
};
function rx(src, flags, where) {
    if (typeof src !== 'string' || !src) fail(where + ' 的正则为空');
    try { return new RegExp(src, flags); } catch (e) { fail(where + ' 正则编译失败: ' + e.message); }
}

const GROUP_ROWS = DATA.groups.map((g, i) => {
    if (!g || typeof g.id !== 'string' || !g.id || typeof g.label !== 'string') fail('groups[' + i + '] 缺 id/label');
    return { id: g.id, label: g.label, order: Number(g.order) || 0 };
});
const GROUP_IDS = new Set(GROUP_ROWS.map((g) => g.id));
if (GROUP_IDS.size !== GROUP_ROWS.length) fail('group id 重复');
if (!GROUP_IDS.has('_blocked')) fail('缺 _blocked 组');
const KINDS = new Set(['featured', 'review', 'blocked']);

const TAGS = DATA.tags.map((t, i) => {
    const w = 'tags[' + i + ']';
    if (!t || typeof t.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(t.id)) fail(w + ' id 不合法');
    if (typeof t.label !== 'string' || !t.label) fail(w + ' 缺 label');
    if (!GROUP_IDS.has(t.group)) fail(w + ' group 未定义: ' + t.group);
    if (!KINDS.has(t.status)) fail(w + ' status 只能是 featured/review/blocked');
    if ((t.status === 'blocked') !== (t.group === '_blocked')) fail(w + ' blocked 必须且只能在 _blocked 组: ' + t.id);
    for (const k of ['zh', 'tok', 'en', 'old', 'implies']) strArr(t[k], w + '.' + k);
    return {
        id: t.id, label: t.label, group: t.group, kind: t.status, weight: Math.max(1, Math.min(3, Number(t.weight) || 1)),
        zh: (t.zh || []).slice(), tok: (t.tok || []).slice(), en: (t.en || []).slice(), old: (t.old || []).slice(), implies: (t.implies || []).slice(),
        policy: typeof t.policy === 'string' ? t.policy : null,
        reRe: t.re ? rx(t.re, 'iu', w + '.re') : null,
        reCjk: !!(t.re && /[^\x00-\x7f]/.test(t.re)),
    };
});
const BY_ID = new Map(TAGS.map((t) => [t.id, t]));
if (BY_ID.size !== TAGS.length) fail('tag id 重复');
for (const t of TAGS) {
    for (const p of t.implies) {
        const pt = BY_ID.get(p);
        if (!pt) fail('implies 指向未定义标签 ' + t.id + '→' + p);
        if (pt.kind === 'blocked' && t.kind !== 'blocked') fail('非 blocked 标签不能 implies blocked: ' + t.id + '→' + p);
    }
    if (t.kind === 'blocked' && t.policy !== 'block-item' && t.policy !== 'no-tag') fail('blocked 标签缺 policy(block-item/no-tag): ' + t.id);
}
const GENRE_B = new Set(DATA.genreBuckets);
const DISCARD = new Set(strArr(DATA.discardTokens, 'discardTokens').map(compact));
const SLUG = rx(DATA.slug && DATA.slug.re ? DATA.slug.re : '^\\d{1,3}[a-z]{5,}$', '', 'slug.re');
const STUDIOS = ((DATA.studios && Array.isArray(DATA.studios.western)) ? DATA.studios.western : []).map((s, i) => {
    if (!s || typeof s.name !== 'string') fail('studios.western[' + i + '] 缺 name');
    for (const p of strArr(s.implies, 'studios.western[' + i + '].implies')) if (!BY_ID.has(p) || BY_ID.get(p).kind === 'blocked') fail('studios.western[' + i + '] implies 不合法: ' + p);
    return { name: s.name, implies: (s.implies || []).slice(), noTag: s.noTag === true, block: s.block === true, rx: rx(s.re, 'i', 'studios.western[' + i + '].re') };
});

// 同义词索引:zh 子串按首字符分桶(一次扫描找出全部重叠命中,比 163 个正则逐个跑快一个数量级)
const FIRST = new Map();    // 首字符 → [{s, ids}]
const EXACT = new Map();    // 归一化整词 → [ids](zh ∪ tok ∪ label;只用于标签字段整 token)
const EN = new Map();       // AVDB 英文标签 → [ids]
const OLD = new Map();      // 旧 taxonomy 标签 → [ids]
const pushMap = (m, k, id) => { if (!k) return; const a = m.get(k); if (!a) m.set(k, [id]); else if (a.indexOf(id) < 0) a.push(id); };
const avdbKey = (s) => norm(String(s == null ? '' : s).replace(/&amp;/gi, '&').replace(/&#0?39;|&apos;/gi, "'").replace(/&quot;/gi, '"')).trim().replace(/\s+/g, ' ');
{
    const syn = new Map();
    for (const t of TAGS) {
        for (const s of t.zh) { const c = compact(s); if (c) pushMap(syn, c, t.id); }
        for (const s of t.zh.concat(t.tok, [t.label])) pushMap(EXACT, compact(s), t.id);
        for (const s of t.en) pushMap(EN, avdbKey(s), t.id);
        for (const s of t.old) pushMap(OLD, s, t.id);
    }
    for (const [s, ids] of syn) {
        const k = s[0];
        const a = FIRST.get(k);
        if (a) a.push({ s, ids }); else FIRST.set(k, [{ s, ids }]);
    }
}
const RE_TAGS = TAGS.filter((t) => t.reRe);

// LEGACY:旧 taxonomy 标签 → 新 id(一对多时取第一个非 blocked 的)
const LEGACY = {};
for (const [old, ids] of OLD) {
    const id = ids.find((x) => BY_ID.get(x).kind !== 'blocked');
    if (id) LEGACY[old] = id;
}

// AVDB 永不成为标签的英文标签(AVDB 模块管政策;这里只保证它们不会变成可浏览的标签)
const AV = DATA.avdb && typeof DATA.avdb === 'object' ? DATA.avdb : fail('缺 avdb');
const AV_BLOCK = new Set(strArr(AV.block, 'avdb.block').map(avdbKey));
const AV_NOTAG = new Set(strArr(AV.noTag, 'avdb.noTag').map(avdbKey));
// allow ∪ review(AVDB review_code 精确表:母女/儿媳…可成为审查级标签)不吃下面的模式;精确拦截表优先于一切
const AV_ALLOW = new Set(strArr(AV.allow, 'avdb.allow').concat(strArr(AV.review, 'avdb.review')).map(avdbKey));
const AV_PATS = strArr(AV.blockPatterns, 'avdb.blockPatterns').concat(strArr(AV.noTagPatterns, 'avdb.noTagPatterns')).map((p, i) => rx(p, 'i', 'avdb.patterns[' + i + ']'));
if (AV_BLOCK.size < 20 || AV_PATS.length < 5) fail('avdb 拦截表过短');
function avdbSkip(k) {
    if (AV_BLOCK.has(k) || AV_NOTAG.has(k)) return true;
    if (AV_ALLOW.has(k)) return false;
    for (const r of AV_PATS) if (r.test(k)) return true;
    return false;
}

// ---------- AI 改写标题的站 ----------
let AI_SITES = new Set(strArr(DATA.aiTitleSites, 'aiTitleSites'));
const siteKeyOf = (site) => (typeof site === 'string' ? site : (site && typeof site === 'object' ? String(site.key || site.id || '') : ''));
function setAiTitleSites(keys) {
    const next = new Set();
    for (const k of (keys && typeof keys[Symbol.iterator] === 'function' && typeof keys !== 'string') ? keys : []) {
        const s = siteKeyOf(k);
        if (s && (typeof k === 'string' || k.aiTitles !== false)) next.add(s);
    }
    AI_SITES = next;
    return AI_SITES.size;
}
function isAiTitleSite(site) {
    if (site && typeof site === 'object') {
        const key = siteKeyOf(site);
        if (site.aiTitles === true) { if (key) AI_SITES.add(key); return true; }
        if (site.aiTitles === false) { if (key) AI_SITES.delete(key); return false; }
        return !!key && AI_SITES.has(key);
    }
    return typeof site === 'string' && AI_SITES.has(site);
}

// ---------- 匹配 ----------
function matchText(text, spaced) {
    const out = new Set();
    const c = compact(text);
    if (!c) return out;
    for (let i = 0; i < c.length; i++) {
        const list = FIRST.get(c[i]);
        if (!list) continue;
        for (const e of list) if (c.startsWith(e.s, i)) for (const id of e.ids) out.add(id);
    }
    const sp = spaced == null ? norm(text) : spaced;
    for (const t of RE_TAGS) if (t.reRe.test(sp) || (t.reCjk && t.reRe.test(c))) out.add(t.id);
    return out;
}
function add(acc, ids, src) {
    for (const id of ids) {
        const s = acc.get(id);
        if (s) s.add(src); else acc.set(id, new Set([src]));
    }
}
function closeImplies(acc) {
    for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (const [id, srcs] of [...acc]) {
            const t = BY_ID.get(id);
            for (const p of (t && t.implies) || []) {
                let s = acc.get(p);
                if (!s) { s = new Set(); acc.set(p, s); changed = true; }
                for (const x of srcs) if (!s.has(x)) { s.add(x); changed = true; }
            }
        }
        if (!changed) break;
    }
}
const genreOk = (t, bucket) => t.group !== 'genre' || !bucket || bucket === 'mixed' || bucket === 'uncat' || GENRE_B.has(bucket);
const ORDER = new Map(TAGS.map((t, i) => [t.id, i]));
const byOrder = (a, b) => ORDER.get(a) - ORDER.get(b);
const str = (v) => (v == null ? '' : typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''));
// 本站分类名表 → 归一化 Set(同一个数组/Set 对象只算一次)
const CLASS_CACHE = new WeakMap();
function classNameSet(names) {
    if (!names || typeof names !== 'object' || (!Array.isArray(names) && !(names instanceof Set))) return null;
    let s = CLASS_CACHE.get(names);
    if (!s) {
        s = new Set();
        for (const n of names) { const c = compact(typeof n === 'string' ? n : (n && (n.type_name || n.name)) || ''); if (c) s.add(c); }
        CLASS_CACHE.set(names, s);
    }
    return s;
}

const NOT_STUDIO = /^(?:海角(?:社区)?|杏吧|91视频)$/i;
// 一条资源站线路 → {tags, signals, studio}
function tagLine(rawItem, ctx) {
    const it = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const o = ctx && typeof ctx === 'object' ? ctx : {};
    const cls = o.cls && typeof o.cls === 'object' ? o.cls : null;
    const parsed = o.parsed && typeof o.parsed === 'object' ? o.parsed : null;
    const ai = isAiTitleSite(o.site);
    const typeName = str(it.type_name).slice(0, 60) || (cls ? str(cls.name).slice(0, 60) : '');
    const parentName = cls ? str(cls.parentName).slice(0, 60) : str(o.parentName).slice(0, 60);
    const bucket = str(o.bucket) || (cls ? str(cls.bucket) : '');
    const acc = new Map();
    const signals = new Set();
    let studio = '';
    // cat:分类名(及父分类名)过词表 + 旧 taxonomy 分类标签经 old 映射
    if (typeName) {
        add(acc, matchText(typeName), 'cat');
        if (parentName) add(acc, matchText(parentName), 'cat');
        let legacy = cls && Array.isArray(cls.tags) ? cls.tags : null;
        if (!legacy) { try { legacy = taxonomy.classify(typeName, parentName).tags; } catch (_) { legacy = []; } }
        for (const old of legacy) add(acc, OLD.get(old) || [], 'cat');
    }
    // raw:vod_tag / vod_class / vod_remarks 逐 token(拼音 slug、分类回显、泛词丢掉)
    const typeC = compact(typeName);
    const classNames = classNameSet(o.classNames);
    for (const [field, val] of [['tag', it.vod_tag], ['class', it.vod_class], ['remarks', it.vod_remarks]]) {
        const v = str(val);
        if (!v) continue;
        for (const raw of v.slice(0, 2000).split(TOKEN_SPLIT)) {
            const tok = compact(raw);
            if (!tok || tok.length < 2) continue;
            if (SLUG.test(tok)) continue;
            const sm = /^(?:传媒|国产)-(.{2,12})$/u.exec(tok);
            if (sm) { if (!studio) studio = sm[1]; continue; }
            if (/^(?:日本|欧美)-/.test(tok)) { add(acc, matchText(tok.replace(/^[^-]+-/, '')), 'raw'); continue; }
            if (tok === typeC || (classNames && classNames.has(tok))) { add(acc, matchText(tok), 'cat'); continue; }
            if (DISCARD.has(tok)) continue;
            if (field === 'remarks' && REMARK_SKIP.test(tok)) continue;
            const ex = EXACT.get(tok);
            if (ex) { add(acc, ex, 'raw'); continue; }
            add(acc, matchText(raw), 'raw');
        }
    }
    // title:片名 + 副名(AI 改写标题的站另记,严格口径要别的来源证实)
    const name = str(it.vod_name).slice(0, 300);
    const sub = str(it.vod_sub).slice(0, 300);
    const tsrc = ai ? 'title_ai' : 'title';
    if (name || sub) {
        const both = name + ' ' + sub;
        add(acc, matchText(both, norm(both).replace(CODE_RE, ' ')), tsrc);
        // 欧美片商(ASCII 粘在片名里)
        const asciiName = norm(name).replace(/[^a-z0-9.]+/g, '');
        if (asciiName) {
            for (const s of STUDIOS) {
                if (!s.rx.test(asciiName)) continue;
                if (!studio) studio = s.name;
                if (s.block) signals.add('x_studio');
                else if (s.noTag) signals.add('x_school');
                else add(acc, s.implies, tsrc);
                break;
            }
        }
    }
    // flag:parseTitle 版本标记
    const f = (parsed && parsed.flags) || {};
    if (f.chineseSub) add(acc, ['subbed'], 'flag');
    if (f.uncensored) add(acc, ['uncensored'], 'flag');
    if (f.leak) add(acc, ['leak_unc'], 'flag');
    if (f.uhd) add(acc, ['uhd'], 'flag');
    if (!studio && parsed && typeof parsed.studio === 'string') studio = parsed.studio.slice(0, 40);
    // 大类本身说明的标签
    if (BUCKET_IMPLIED[bucket]) add(acc, BUCKET_IMPLIED[bucket], 'cat');
    closeImplies(acc);
    const tags = [];
    for (const id of [...acc.keys()].sort(byOrder)) {
        const t = BY_ID.get(id);
        if (!t) continue;
        if (t.kind === 'blocked') { signals.add(id); continue; }
        if (!genreOk(t, bucket)) continue;
        let best = null;
        for (const s of acc.get(id)) if (best === null || SRC_RANK[s] < SRC_RANK[best]) best = s;
        tags.push(best === 'title_ai' ? { id, src: 'title', ai: true } : { id, src: best });
    }
    // 社区 / 论坛名不是片商:海角社区 / 杏吧 / 91视频 是偷拍、黑料、探花的集散地(政策里是审查级 filter 语境),不能做成可点的"片商"入口
    if (studio && NOT_STUDIO.test(studio)) studio = '';
    return { tags, signals: [...signals].sort(), studio };
}

// AVDB 英文标签 → [{id, src:'avdb'}]
function tagsFromAvdb(enTags, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const list = Array.isArray(enTags) ? enTags : (typeof enTags === 'string' ? [enTags] : []);
    const acc = new Map();
    let n = 0;
    for (const x of list) {
        if (typeof x !== 'string') continue;
        for (const part of x.split(',')) {
            if (++n > 400) break;
            const k = avdbKey(part);
            if (!k || avdbSkip(k)) continue;
            const ids = EN.get(k);
            if (ids) add(acc, ids, 'avdb');
        }
    }
    closeImplies(acc);
    const bucket = str(o.bucket);
    return [...acc.keys()].filter((id) => { const t = BY_ID.get(id); return t && t.kind !== 'blocked' && genreOk(t, bucket); })
        .sort(byOrder).map((id) => ({ id, src: 'avdb' }));
}

// 标签 id 规范化:词表 id 或旧 taxonomy id(LEGACY);未知 / blocked → ''
function resolve(id) {
    if (typeof id !== 'string' || !id || id.length > 40) return '';
    let t = BY_ID.get(id);
    if (!t && own(LEGACY, id)) t = BY_ID.get(LEGACY[id]);
    return t && t.kind !== 'blocked' ? t.id : '';
}

// 作品级合并(严格口径)
function mergeWork(lineTagLists, avdbTags, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const strong = new Map();   // 有可信来源的 id → Set(用 closeImplies 传递);只来自 AI 标题的不进来
    const take = (e, fromAvdb) => {
        let id, lowTrust = false;
        if (typeof e === 'string') id = e;
        else if (e && typeof e === 'object') {
            id = e.id;
            const src = str(e.src);
            if (!fromAvdb && (src === 'title' || src === 'title_ai')) lowTrust = src === 'title_ai' || e.ai === true || (e.ai !== false && isAiTitleSite(e.site));
        } else return;
        const r = resolve(id);
        if (r && !lowTrust) add(strong, [r], 's');
    };
    for (const list of Array.isArray(lineTagLists) ? lineTagLists : []) {
        if (!Array.isArray(list)) continue;
        for (const e of list) take(e, false);
    }
    if (Array.isArray(avdbTags)) for (const e of avdbTags) take(e, true);
    closeImplies(strong);
    const bucket = str(o.bucket);
    return [...strong.keys()].filter((id) => { const t = BY_ID.get(id); return t && t.kind !== 'blocked' && genreOk(t, bucket); }).sort(byOrder);
}

function info(id) { const r = resolve(id); return r ? BY_ID.get(r) : null; }
const isFeatured = (id) => { const t = info(id); return !!(t && t.kind === 'featured'); };
const isReview = (id) => { const t = info(id); return !!(t && t.kind === 'review'); };
const label = (id) => { const t = info(id); return t ? t.label : ''; };
const group = (id) => { const t = info(id); return t ? t.group : ''; };
function fromWord(word) {
    const ids = EXACT.get(compact(word)) || [];
    return ids.filter((id) => BY_ID.get(id).kind !== 'blocked').sort(byOrder);
}
function signalKind(id) {
    if (id === 'x_studio') return 'block-item';
    const t = BY_ID.get(id);
    return t && t.kind === 'blocked' ? t.policy : null;
}
// 线路标签落库的紧凑写法:',busty,wife,creampie~,'('~' = 只来自 AI 改写标题;LIKE '%,id,%' 只命中可信的)
function packLine(tags) {
    const out = [];
    for (const e of Array.isArray(tags) ? tags : []) {
        const id = resolve(e && typeof e === 'object' ? e.id : e);
        if (!id) continue;
        const ai = !!(e && typeof e === 'object' && (e.src === 'title_ai' || (e.src === 'title' && e.ai === true)));
        out.push(id + (ai ? '~' : ''));
    }
    return out.length ? ',' + out.join(',') + ',' : '';
}
// packLine 的逆:→ [{id} | {id, src:'title', ai:true}](直接喂 mergeWork;旧 taxonomy id 也认)
function unpackLine(s) {
    const out = [];
    for (const p of String(s == null ? '' : s).split(',')) {
        if (!p) continue;
        const ai = p.endsWith('~');
        const id = resolve(ai ? p.slice(0, -1) : p);
        if (id) out.push(ai ? { id, src: 'title', ai: true } : { id });
    }
    return out;
}

const VOCAB = Object.freeze(TAGS.map((t) => Object.freeze({
    id: t.id, label: t.label, group: t.group, kind: t.kind,
    syn: Object.freeze(t.kind === 'blocked' ? [] : [...new Set(t.zh.concat(t.tok))]),
    weight: t.weight,
})));
const GROUPS = Object.freeze(GROUP_ROWS.filter((g) => g.id !== '_blocked').sort((a, b) => a.order - b.order).map((g) => Object.freeze({ id: g.id, label: g.label })));

// ---------- 自检(scripts/adult-tags-test.mjs 跑全量;加载时只跑金丝雀) ----------
const GOLDEN = [
    // [片名, 必须有的标签, 必须没有的标签]
    ['VEC-536 测试 爆操朋友妈 内射熟妇人妻', ['creampie', 'mature', 'wife', 'hardcore'], []],
    ['SMBD-161 S Model', [], ['bdsm']],
    ['VRKM-123 美少女', [], ['vr']],
    ['黑丝OL办公室深喉口爆', ['black_stockings', 'stockings', 'office_lady', 'office', 'deepthroat', 'blowjob', 'cum_mouth'], []],
    ['ABC-069 69式互舔', ['sixtynine'], []],
    ['甜美妹子返场情趣装黑丝啪啪', ['lingerie', 'black_stockings', 'stockings'], []],
    ['処女作 新人出道', ['debut'], ['virgin']],
    ['4K60帧增强版', ['uhd'], []],
];
function selftest() {
    const errs = [], warns = [];
    let policy = null;
    try { policy = require('./policy'); } catch (e) { warns.push('policy 加载失败,跳过 checkQuery: ' + e.message); }
    for (const t of TAGS) {
        if (t.kind === 'blocked') continue;
        // 非 blocked 标签的名称/同义词:分类体系判硬拦 = 错;featured 标签被判审查级 hide/code = 错
        for (const syn of [t.label].concat(t.zh, t.tok)) {
            const k = taxonomy.classify(syn, '');
            if (k.block) errs.push(`同义词被分类体系硬拦: ${t.id} "${syn}" (${k.blockReason})`);
            else if (t.kind === 'featured' && (k.review === 'hide' || k.review === 'code')) errs.push(`featured 同义词是审查级 ${k.review}: ${t.id} "${syn}"`);
            if (policy && typeof policy.checkQuery === 'function' && policy.checkQuery(syn) === true) {
                (t.kind === 'featured' ? errs : warns).push(`checkQuery 拦截 ${t.kind} 同义词: ${t.id} "${syn}"`);
            }
        }
        // 非 blocked 标签的 AVDB 映射不能落在 AVDB 拦截表里(否则 tagsFromAvdb 永远用不上,词表写错了)
        for (const en of t.en) if (avdbSkip(avdbKey(en))) warns.push(`AVDB 标签被拦截表吞掉: ${t.id} "${en}"`);
    }
    for (const [k, ids] of EXACT) if (ids.length > 1) warns.push(`token "${k}" → ${ids.join(',')}`);
    for (const [txt, want, not] of GOLDEN) {
        const r = tagLine({ vod_name: txt }, {});
        const got = new Set(r.tags.map((x) => x.id));
        const miss = want.filter((x) => !got.has(x));
        const extra = not.filter((x) => got.has(x));
        if (miss.length || extra.length || (!want.length && got.size)) errs.push(`金样例 "${txt}" 得到 [${[...got]}] 应有 [${want}] 不应有 [${not}]`);
    }
    return { errs, warns };
}

// 加载金丝雀:blocked 词不会变成标签、AVDB 拦截标签不会变成标签、核心映射在
(function canaries() {
    const r1 = tagLine({ vod_name: '萝莉 偷拍 迷奸 换脸', vod_tag: '学生妹,校服,人兽' }, {});
    if (r1.tags.some((x) => BY_ID.get(x.id).kind === 'blocked')) fail('自检失败:blocked 词变成了标签');
    for (const need of ['x_minor', 'x_voyeur', 'x_drug', 'x_deepfake', 'x_bestiality', 'x_school']) if (r1.signals.indexOf(need) < 0) fail('自检失败:没给出信号 ' + need);
    if (tagsFromAvdb(['High School Girl', 'Sailor Suit', 'Voyeur', 'Sleeping', 'Drugged', 'Teen', 'Daughter', 'Aphrodisiac', 'School Uniform', 'Lookalike']).length) fail('自检失败:AVDB 拦截标签变成了标签');
    const b = tagsFromAvdb(['Big Breasts', 'Creampie']).map((x) => x.id);
    if (b.join() !== 'busty,creampie') fail('自检失败:AVDB 映射 ' + b.join());
    if (mergeWork([[{ id: 'busty', src: 'title', ai: true }]]).length) fail('自检失败:严格口径没丢掉只来自 AI 标题的标签');
    for (const t of TAGS) if (t.kind === 'blocked' && (isFeatured(t.id) || isReview(t.id) || resolve(t.id))) fail('自检失败:blocked 标签可被解析 ' + t.id);
})();

module.exports = {
    VERSION: DATA.version,
    VOCAB,
    GROUPS,
    LEGACY: Object.freeze(Object.assign({}, LEGACY)),
    tagLine,
    tagsFromAvdb,
    mergeWork,
    isFeatured,
    isReview,
    label,
    group,
    resolve,
    fromWord,
    signalKind,
    packLine,
    unpackLine,
    setAiTitleSites,
    isAiTitleSite,
    selftest,
};
