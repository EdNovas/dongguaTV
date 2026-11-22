// [adult] 成人站分类体系:资源站分类名 → 大类(bucket) / 主题标签(tags) / 硬过滤(block) / 审查级(review)。
//
// 数据在同目录 taxonomy.json(调研 analysis/out/taxonomy.json 原样移植,规则顺序有意义:第一条命中的规则定大类)。
// 加载即校验:文件缺失 / JSON 坏 / 结构不对 / 正则编译失败 / 自检金丝雀没拦住 —— 一律 throw。
//   server.js 不加 try/catch 直接 require,规则坏了服务器拒绝启动,绝不静默放行(fail-closed)。
//
// 公共 API:
//   BUCKETS                       [{id, label, nav}]  17 个 nav:true(首页行/导航)+ 隐藏的 mixed / uncat / x_mainstream / x_nonvideo / x_container
//   NAV_BUCKETS                   nav:true 的 id 数组(taxonomy.json 顺序)
//   DROP_BUCKETS                  ['x_mainstream','x_nonvideo','x_container'](入库直接丢)
//   TAGS                          [{id, label}]
//   normName(s)                   NFKC → 繁转简 → 小写 → 去空白(分类名匹配用的归一化)
//   classify(typeName, parentName?, opts?)
//                                 → {bucket, tags[], block, blockReason?, review: null|'hide'|'code'|'filter', unmapped?}
//                                 opts: 'mixed'|'adult' 或 {siteKind, ancestors:[祖先名...]}(siteKind 缺省 'adult')
//                                 block:自己或任一祖先命中 blockPolicy(不可关闭);review:自己或父分类命中 reviewPolicy,取更严的一档
//                                 没有规则命中 → bucket 'uncat' + unmapped:true(只进搜索/最新流,条目级再路由)
//   buildClassMap(classes, opts?) classes = maccms ac=list 的 [{type_id,type_name,type_pid}](也认 {id,name,pid})
//                                 opts: {host?(API 地址或域名,套 siteOverrides), siteKind?}
//                                 → Map<number, {name, parentName, bucket, tags, block, blockReason?, review, container}>
//                                 container = 有子分类的父节点 / siteOverrides.aggregateParents:爬虫绝不能用 &t=<父 id> 拉列表
//   siteKindOf(classes)           'mixed'(≥3 个主流影视分类,如 聚合/艾旦/看看)| 'adult'
//   siteOverride(hostOrUrl)       taxonomy.json siteOverrides 里该域名的条目(没有返回 null)
//   isNavBucket(id) / bucketLabel(id) / VERSION
//
// 分类 id 在同品牌不同镜像间会漂移(老色逼两个后端、搜AV .net):调用方必须按 API 地址各建一张表,永远按名字分类,别跨镜像抄 id。
'use strict';

const DATA = require('./taxonomy.json');   // 缺文件 / 坏 JSON 在这里就抛
const { t2s } = require('./t2s');

function fail(msg) { throw new Error('[adult/taxonomy] taxonomy.json 无效: ' + msg); }

// ---------- 结构校验(坏了就抛) ----------
if (!DATA || typeof DATA !== 'object' || Array.isArray(DATA)) fail('不是对象');
if (typeof DATA.version !== 'string' || !DATA.version) fail('缺 version');
for (const k of ['buckets', 'tags', 'rules', 'tagRules', 'block', 'blockPolicy', 'review', 'reviewPolicy']) {
    if (!Array.isArray(DATA[k]) || !DATA[k].length) fail(k + ' 不是非空数组');
}
const FLAGS = (DATA.normalize && typeof DATA.normalize.flags === 'string') ? DATA.normalize.flags : 'iu';
function rx(src, where) {
    if (typeof src !== 'string' || !src) fail(where + ' 的正则为空');
    try { return new RegExp(src, FLAGS); } catch (e) { fail(where + ' 正则编译失败: ' + e.message); }
}

const BUCKETS = DATA.buckets.map((b, i) => {
    if (!b || typeof b.id !== 'string' || !b.id || typeof b.label !== 'string' || typeof b.nav !== 'boolean') fail('buckets[' + i + '] 缺 id/label/nav');
    return Object.freeze({ id: b.id, label: b.label, nav: b.nav });
});
const BUCKET_BY_ID = new Map(BUCKETS.map((b) => [b.id, b]));
if (BUCKET_BY_ID.size !== BUCKETS.length) fail('bucket id 重复');
const NAV_BUCKETS = BUCKETS.filter((b) => b.nav).map((b) => b.id);
if (NAV_BUCKETS.length !== 17) fail('导航大类应为 17 个,实际 ' + NAV_BUCKETS.length);
for (const need of ['mixed', 'uncat', 'x_mainstream', 'x_nonvideo', 'x_container']) if (!BUCKET_BY_ID.has(need)) fail('缺隐藏大类 ' + need);
const DROP_BUCKETS = ['x_mainstream', 'x_nonvideo', 'x_container'];

const TAGS = DATA.tags.map((t, i) => {
    if (!t || typeof t.id !== 'string' || typeof t.label !== 'string') fail('tags[' + i + '] 缺 id/label');
    return Object.freeze({ id: t.id, label: t.label });
});
const TAG_IDS = new Set(TAGS.map((t) => t.id));

const RULES = DATA.rules.map((r, i) => {
    if (!r || !BUCKET_BY_ID.has(r.bucket)) fail('rules[' + i + '] bucket 未定义: ' + (r && r.bucket));
    if (r.siteKind != null && r.siteKind !== 'mixed' && r.siteKind !== 'adult') fail('rules[' + i + '] siteKind 只能是 mixed/adult');
    const tags = Array.isArray(r.tags) ? r.tags.slice() : [];
    for (const t of tags) if (!TAG_IDS.has(t)) fail('rules[' + i + '] 标签未定义 ' + t);
    return { re: rx(r.match, 'rules[' + i + '].match'), pre: r.parent ? rx(r.parent, 'rules[' + i + '].parent') : null, siteKind: r.siteKind || null, bucket: r.bucket, tags };
});
const TAG_RULES = DATA.tagRules.map((r, i) => {
    if (!r || !TAG_IDS.has(r.tag)) fail('tagRules[' + i + '] 标签未定义');
    return { re: rx(r.match, 'tagRules[' + i + '].match'), tag: r.tag };
});
const BLOCK = DATA.blockPolicy.map((b, i) => {
    if (!b || typeof b.reason !== 'string' || !b.reason) fail('blockPolicy[' + i + '] 缺 reason');
    return { re: rx(b.match, 'blockPolicy[' + i + '].match'), reason: b.reason };
});
if (BLOCK.length < 6) fail('blockPolicy 少于 6 组(未成年/偷拍/迷奸/换脸/泄露/人兽)');
if (JSON.stringify(DATA.block) !== JSON.stringify(DATA.blockPolicy.map((b) => b.match))) fail('block 与 blockPolicy 不一致');
const REVIEW_MAP = { hide: 'hide', 'show-if-fanhao': 'code', show: 'filter' };
const REVIEW_RANK = { hide: 3, code: 2, filter: 1 };
const REVIEW = DATA.reviewPolicy.map((r, i) => {
    if (!r || !Object.prototype.hasOwnProperty.call(REVIEW_MAP, r.default)) fail('reviewPolicy[' + i + '].default 只能是 hide/show-if-fanhao/show');
    return { re: rx(r.match, 'reviewPolicy[' + i + '].match'), level: REVIEW_MAP[r.default] };
});
if (JSON.stringify(DATA.review) !== JSON.stringify(DATA.reviewPolicy.map((r) => r.match))) fail('review 与 reviewPolicy 不一致');
const OVERRIDES = (DATA.siteOverrides && typeof DATA.siteOverrides === 'object') ? DATA.siteOverrides : {};
const MAINSTREAM = RULES[0].re;   // rules[0] = 主流影视(MAINSTREAM_STRICT),构造上固定在第一条
if (RULES[0].bucket !== 'x_mainstream') fail('rules[0] 必须是主流影视规则');

// ---------- 归一化 ----------
function normName(s) {
    return t2s(String(s == null ? '' : s).normalize('NFKC')).toLowerCase().replace(/[\s\u200b-\u200f\ufeff\u2800]+/g, '');
}

function reviewOf(n) {
    if (!n) return null;
    for (const r of REVIEW) if (r.re.test(n)) return r.level;   // 第一条命中的档(与调研 taxonomy-apply 一致)
    return null;
}
function stricter(a, b) { return (REVIEW_RANK[b] || 0) > (REVIEW_RANK[a] || 0) ? b : a; }

function classify(typeName, parentName, opts) {
    const o = typeof opts === 'string' ? { siteKind: opts } : (opts && typeof opts === 'object' ? opts : {});
    const siteKind = o.siteKind === 'mixed' ? 'mixed' : 'adult';
    const n = normName(typeName);
    const p = parentName == null ? '' : normName(parentName);
    const anc = [p].concat(Array.isArray(o.ancestors) ? o.ancestors.map(normName) : []).filter(Boolean);
    // 1) 硬过滤:自己或任一祖先命中(不可配置)
    let blk = null;
    for (const b of BLOCK) { if (b.re.test(n) || anc.some((a) => b.re.test(a))) { blk = b; break; } }
    // 2) 大类:第一条命中的规则(父名 / 站点类型条件要成立)
    let bucket = null, extra = [];
    for (const r of RULES) {
        if (r.siteKind && r.siteKind !== siteKind) continue;
        if (r.pre && !(p && r.pre.test(p))) continue;
        if (!r.re.test(n)) continue;
        bucket = r.bucket; extra = r.tags; break;
    }
    // 3) 标签 = 规则标签 ∪ 所有命中的 tagRule
    const tags = extra.slice();
    for (const t of TAG_RULES) if (t.re.test(n) && tags.indexOf(t.tag) < 0) tags.push(t.tag);
    // 4) 审查级:自己和父分类取更严(调研原版只看自己;父是"学生校园"的子分类同样要藏)
    const review = stricter(reviewOf(n), reviewOf(p));
    const out = { bucket: bucket || 'uncat', tags, block: !!blk, review: review || null };
    if (blk) out.blockReason = blk.reason;
    if (!bucket) out.unmapped = true;
    return out;
}

function hostOf(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return '';
    let h = s;
    try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) h = new URL(s).hostname; } catch (_) { h = ''; }
    return h.replace(/^www\./, '').replace(/:\d+$/, '').replace(/\/.*$/, '');
}
function siteOverride(hostOrUrl) {
    const h = hostOf(hostOrUrl);
    return h && Object.prototype.hasOwnProperty.call(OVERRIDES, h) ? OVERRIDES[h] : null;
}

function normClass(c) {
    if (!c || typeof c !== 'object') return null;
    const id = Number(c.type_id != null ? c.type_id : c.id);
    if (!Number.isFinite(id)) return null;
    const pid = Number(c.type_pid != null ? c.type_pid : c.pid) || 0;
    const name = String(c.type_name != null ? c.type_name : (c.name != null ? c.name : ''));
    return { id, pid, name };
}

function siteKindOf(classes) {
    let n = 0;
    for (const c of Array.isArray(classes) ? classes : []) {
        if (!c || typeof c !== 'object') continue;
        const name = c.type_name != null ? c.type_name : c.name;
        if (name != null && MAINSTREAM.test(normName(name))) n++;
    }
    return n >= 3 ? 'mixed' : 'adult';
}

function buildClassMap(classes, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const list = (Array.isArray(classes) ? classes : []).map(normClass).filter(Boolean);
    const ov = siteOverride(o.host) || {};
    const pidFix = ov.pidFix && typeof ov.pidFix === 'object' ? ov.pidFix : {};
    const agg = new Set(Array.isArray(ov.aggregateParents) ? ov.aggregateParents.map(Number) : []);
    for (const c of list) {
        if (!c.pid && Object.prototype.hasOwnProperty.call(pidFix, String(c.id))) c.pid = Number(pidFix[String(c.id)]) || 0;
        if (c.pid === c.id) c.pid = 0;
    }
    const siteKind = o.siteKind === 'mixed' || o.siteKind === 'adult' ? o.siteKind : siteKindOf(list.map((c) => ({ id: c.id, name: c.name })));
    const byId = new Map(list.map((c) => [c.id, c]));
    const pids = new Set(list.map((c) => c.pid).filter(Boolean));
    const out = new Map();
    for (const c of list) {
        const parent = c.pid ? byId.get(c.pid) : null;
        // 祖先链(防环,最多 6 层):硬过滤要看到所有祖先
        const ancestors = [];
        const seen = new Set([c.id]);
        let cur = parent;
        while (cur && cur.pid && !seen.has(cur.pid) && ancestors.length < 6) {
            seen.add(cur.id);
            const up = byId.get(cur.pid);
            if (!up || seen.has(up.id)) break;
            ancestors.push(up.name);
            cur = up;
        }
        const r = classify(c.name, parent ? parent.name : '', { siteKind, ancestors });
        const row = { name: c.name, parentName: parent ? parent.name : '', bucket: r.bucket, tags: r.tags, block: r.block, review: r.review, container: pids.has(c.id) || agg.has(c.id) };
        if (r.blockReason) row.blockReason = r.blockReason;
        if (r.unmapped) row.unmapped = true;
        out.set(c.id, row);
    }
    return out;
}

function isNavBucket(id) { const b = BUCKET_BY_ID.get(id); return !!(b && b.nav); }
function bucketLabel(id) { const b = BUCKET_BY_ID.get(id); return b ? b.label : ''; }

// ---------- 加载自检:规则真的能拦住这些分类名,否则拒绝启动 ----------
for (const name of ['自拍偷拍', '少女萝莉', '网曝门', 'AI换脸', '强奸迷奸', '人兽性交', '國產盜攝', 'J K 少女']) {
    if (!classify(name).block) fail('自检失败:分类 "' + name + '" 没被硬过滤');
}
if (!classify('日本', '变态暗网').block) fail('自检失败:父分类硬过滤没继承');
if (classify('无码流出').block) fail('自检失败:无码流出 被误拦');
if (classify('学生少女').review !== 'hide' || classify('强奸乱伦').review !== 'code' || classify('91探花').review !== 'filter') fail('自检失败:审查级默认值不对');

module.exports = {
    VERSION: DATA.version,
    BUCKETS: Object.freeze(BUCKETS.slice()),
    NAV_BUCKETS: Object.freeze(NAV_BUCKETS.slice()),
    DROP_BUCKETS: Object.freeze(DROP_BUCKETS.slice()),
    TAGS: Object.freeze(TAGS.slice()),
    normName,
    classify,
    buildClassMap,
    siteKindOf,
    siteOverride,
    isNavBucket,
    bucketLabel,
};
