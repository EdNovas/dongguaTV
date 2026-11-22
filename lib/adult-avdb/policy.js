// [adult] AVDB 标签 / 英文片名 → 内容政策等级('block' | 'review_hide' | 'review_code' | null)。
//
// 规则在 policy-tags.json(调研 impl/p34/avdb-policy-tags.json 的运行时副本):
//   · 标签:小写精确匹配 lists(三级里取最严;同一标签只在一级里)→ allow(永不进政策)→ patterns(block > review_hide > review_code)。
//   · type_exceptions:'leaked' 在无码流出行上 / 'ai' 在日本片行上不算。
//   · 英文片名:title_signals(S********l / J● / R** 这类自我打码)+ block 级 patterns(片名只升不降;review 级不在自由文本上跑)。
//   · 等级:block 3 > review_hide 2 > review_code 1。行 → 取最严;作品(同键所有变体行)→ 取并集里最严(调研 §2.8:变体之间标签不一样)。
//
// 加载自检(fail-closed):规则文件坏了 / 金丝雀没按预期分级 → require 时 throw,调用方拿不到 AVDB(不会"没政策照样放行")。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RULES_FILE = path.join(__dirname, 'policy-tags.json');
const CODE_REV = 'p1';                         // 本文件的判定逻辑改了就改这里(进 POLICY_VERSION)
const RANK = { block: 3, review_hide: 2, review_code: 1 };
const LEVELS = ['block', 'review_hide', 'review_code'];

const rawText = fs.readFileSync(RULES_FILE, 'utf8');
const R = JSON.parse(rawText);
const POLICY_VERSION = 'avp' + R.version + '-' + CODE_REV + '-' + crypto.createHash('sha1').update(rawText).digest('hex').slice(0, 10);

const keyOf = (s) => String(s == null ? '' : s).replace(/&amp;/gi, '&').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

const LISTED = new Map();          // 标签键 → {list, group}
for (const lv of LEVELS) {
    const groups = (R.lists && R.lists[lv]) || {};
    for (const g of Object.keys(groups)) for (const t of groups[g] || []) {
        const k = keyOf(t);
        const prev = LISTED.get(k);
        if (!prev || RANK[lv] > RANK[prev.list]) LISTED.set(k, { list: lv, group: g });
    }
}
const ALLOW = new Set((R.allow || []).map(keyOf));
const TYPE_EXCEPT = new Map(Object.entries(R.type_exceptions || {}).map(([k, v]) => [keyOf(k), new Set((v || []).map(keyOf))]));
const PATTERNS = {};
for (const lv of LEVELS) PATTERNS[lv] = ((R.patterns && R.patterns[lv]) || []).map((p) => ({ group: p.group, re: new RegExp(p.regex) }));
const TITLE_SIGNALS = (R.title_signals || []).map((s) => ({ id: s.id, list: s.list, group: s.group, re: new RegExp(s.regex, s.flags || '') }));
const TITLE_SLEEP_EXC = R.title_sleep_exceptions ? new RegExp(R.title_sleep_exceptions, 'gi') : null;
for (const s of TITLE_SIGNALS) if (!RANK[s.list]) throw new Error('adult-avdb policy: title signal 等级不认识 ' + s.id);

// 单个标签 → {list, group, via} | null(typeName = 行的 type_name,做 type_exceptions 用)
function classifyTag(tag, typeName) {
    const k = keyOf(tag);
    if (!k) return null;
    const ex = TYPE_EXCEPT.get(k);
    if (ex && ex.has(keyOf(typeName))) return null;
    const e = LISTED.get(k);
    if (e) return { list: e.list, group: e.group, via: 'list' };
    if (ALLOW.has(k)) return null;
    for (const lv of LEVELS) for (const p of PATTERNS[lv]) if (p.re.test(k)) return { list: lv, group: p.group, via: 'pattern' };
    return null;
}
// 不看 type_exceptions 的分级(给 avdb_tag 表缓存用;type_exceptions 在行级再套)
function classifyTagNoType(tag) {
    const k = keyOf(tag);
    if (!k) return null;
    const e = LISTED.get(k);
    if (e) return { list: e.list, group: e.group, via: 'list' };
    if (ALLOW.has(k)) return null;
    for (const lv of LEVELS) for (const p of PATTERNS[lv]) if (p.re.test(k)) return { list: lv, group: p.group, via: 'pattern' };
    return null;
}
const hasTypeException = (tagKey) => TYPE_EXCEPT.has(keyOf(tagKey));
const typeExcepted = (tagKey, typeName) => { const ex = TYPE_EXCEPT.get(keyOf(tagKey)); return !!(ex && ex.has(keyOf(typeName))); };

// 英文片名 → {list, group, via:'title'} | null
function classifyTitle(title) {
    const t = String(title == null ? '' : title).normalize('NFKC');
    if (!t) return null;
    let best = null;
    const take = (c) => { if (c && (!best || RANK[c.list] > RANK[best.list])) best = c; };
    for (const s of TITLE_SIGNALS) if (s.re.test(t)) take({ list: s.list, group: s.group, via: 'title:' + s.id });
    if (R.title_block_patterns && (!best || best.list !== 'block')) {
        let low = t.toLowerCase().replace(/\s+/g, ' ');
        if (TITLE_SLEEP_EXC) low = low.replace(TITLE_SLEEP_EXC, ' ');
        for (const p of PATTERNS.block) if (p.re.test(low)) { take({ list: 'block', group: p.group, via: 'title:pattern' }); break; }
    }
    return best;
}

// 一行(标签数组 + 类型名 + 英文片名)→ {pol, groups:[]}
function classifyRow(tags, typeName, title) {
    let best = null;
    const groups = new Set();
    for (const t of tags || []) {
        const c = classifyTag(typeof t === 'string' ? t : (t && (t.form || t.k)), typeName);
        if (!c) continue;
        groups.add(c.group);
        if (!best || RANK[c.list] > RANK[best]) best = c.list;
    }
    const tc = classifyTitle(title);
    if (tc) { groups.add(tc.group); if (!best || RANK[tc.list] > RANK[best]) best = tc.list; }
    return { pol: best, groups: [...groups] };
}
// 多级合并:取最严
function maxPol(a, b) { if (!a) return b || null; if (!b) return a; return RANK[a] >= RANK[b] ? a : b; }

// ---------- 加载自检(金丝雀) ----------
(function selfTest() {
    const expect = [
        ['High School Girl', 'Censored', 'block'], ['Schoolgirl', 'Censored', 'block'], ['Sneak Shots', 'Censored', 'block'],
        ['Voyeur', 'Amateur', 'block'], ['Drugs And Aphrodisiacs', 'Censored', 'block'], ['Lolita', 'Censored', 'block'],
        ['School Uniform', 'Censored', 'block'], ['Sleeping', 'Censored', 'block'], ['Outflow', 'Uncensored', 'block'],
        ['peeping tom', 'Uncensored', 'block'], ['Rape', 'Censored', 'review_code'], ['Incest', 'Censored', 'review_code'],
        ['Teen', 'Censored', 'review_hide'], ['Leaked', 'Censored', 'review_hide'], ['Leaked', 'Uncensored Leaked', null],
        ['AI', 'Chinese AV', 'review_hide'], ['AI', 'Censored', null], ['Uncensored Leaked', 'Uncensored Leaked', null],
        ['Young Wife', 'Censored', null], ['Sleeping Bag', 'Censored', null], ['Female College Student', 'Censored', null],
        ['Big Breasts', 'Censored', null], ['Uniform', 'Censored', null],
    ];
    for (const [tag, type, lv] of expect) {
        const c = classifyTag(tag, type);
        if ((c ? c.list : null) !== lv) throw new Error(`adult-avdb policy 自检失败:${tag} [${type}] → ${c ? c.list : null},应为 ${lv}`);
    }
    const titles = [
        ['My Teacher Is My Sugar Daddy With A Naughty S********l', 'block'], ['A Cheeky New Wife J● Creampie Life', 'block'],
        ['[Uncensored L**ked] A Boss And Her Colleague', null], ['R** Training Camp', 'review_code'], ['Hidden Cam In The Bathhouse', 'block'],
        ['A Sleepover With Neighbours', null], ['Office Lady Overtime', null], ['Schoolgirl After Class', 'block'],
    ];
    for (const [t, lv] of titles) {
        const c = classifyTitle(t);
        if ((c ? c.list : null) !== lv) throw new Error(`adult-avdb policy 自检失败(片名):${t} → ${c ? c.list : null},应为 ${lv}`);
    }
})();

module.exports = { POLICY_VERSION, RANK, classifyTag, classifyTagNoType, classifyTitle, classifyRow, maxPol, hasTypeException, typeExcepted, keyOf };
