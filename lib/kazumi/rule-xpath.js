// Kazumi 规则 XPath 求值器(净室重写,非抄袭):复刻 Kazumi 所依赖的 Dart 包 xpath_selector 3.0.x
// (+ xpath_selector_html_parser,BSD-3-Clause)在 html5lib DOM 上的"可观察语义",HTML 解析用 parse5(同为 HTML5 规范解析器)。
//
// 为什么不能直接用标准 XPath(document.evaluate / xpath 包):
//   1) 规则里子查询(searchName/searchResult/chapterResult)开头的 "//" 在 xpath_selector 里是【相对上下文节点】的
//      (上下文的 descendant-or-self 再走 child 步),W3C 里 "//" 却是从文档根重新开始 —— 直接照搬的话
//      DM84 片名全空、7sefun 片名变成整页文本。等价的 W3C 写法是 ".//"。
//   2) 只遍历【元素】子节点(Dart html 的 children 只含元素),位置谓词 [n] 也只按元素计数。
//   3) 结果顺序是"按父节点 DFS 先序、各父节点下按子序,去重",不是严格文档序(嵌套匹配时才有差别)。
//   4) 末尾的 text()/string() 是 self 步:结果节点仍是元素本身,Kazumi 读的是其完整 textContent(含所有后代文本);
//      末尾 @attr 同理是 self 步,另外带出属性值。
//   5) 支持的谓词:[n] [last()] [last()-n] [position() op n] [@a='v'] [text()='v'] contains/starts-with/ends-with(及 not(...))。
'use strict';

const { parse } = require('parse5');

// ---------- parse5 默认树上的极简 DOM 适配 ----------
const isEl = (n) => !!n && typeof n.tagName === 'string';
const kids = (n) => ((n && (n.childNodes || (n.content && n.content.childNodes))) || []).filter(isEl);

function attr(n, name) {
    if (!isEl(n)) return undefined;
    for (const a of n.attrs || []) if (a.name === name) return a.value;
    return undefined;
}
function attrValues(n) { return (n.attrs || []).map((a) => a.value); }

/** 完整 textContent(后代所有文本拼接) */
function textOf(n) {
    if (!n) return '';
    if (n.nodeName === '#text') return n.value;
    let s = '';
    for (const c of n.childNodes || []) {
        if (c.nodeName === '#text') s += c.value;
        else if (isEl(c)) s += textOf(c);
    }
    return s;
}

/** 解析 HTML,返回 <html> 元素(Kazumi 的 searchList/chapterRoads 都以 documentElement 为上下文) */
function parseHtml(html) {
    const doc = parse(String(html || ''));
    return doc.childNodes.find((n) => n.tagName === 'html') || doc;
}

// ---------- 表达式解析(xpath_selector 的子集) ----------
// 分步正则与 xpath_selector 的分组正则同形:可选 / 或 //,可选 @,名字/轴,若干 [谓词],可选 ()
const XPATH_GROUP = /\/{0,2}@?[\w*-]+:{0,2}[*\w]*(?:\[.+?\])*(?:\(\))?/g;
const PRED = /\[(.+?)\]/g;

function parseStep(input) {
    let type, src;
    if (input.startsWith('//')) { type = 'desc'; src = input.slice(2); }
    else if (input.startsWith('/')) { type = 'self'; src = input.slice(1); }
    else throw new Error(`'${input}' is not a valid xpath query string`);
    if (src.startsWith('@')) return { type, axis: 'self', nodeTest: '*', preds: [], attr: src.slice(1) };
    if (src === '..') return { type, axis: 'parent', nodeTest: '*', preds: [] };
    if (src === '.') return { type, axis: 'self', nodeTest: '*', preds: [] };
    if (src === 'node()') return { type, axis: 'child', nodeTest: 'node()', preds: [] };
    if (/^\w*\(\s*\)$/.test(src)) return { type, axis: 'self', nodeTest: '*', preds: [], fn: src };
    let axis = 'child', rest = src;
    if (src.includes('::')) { const p = src.split('::'); axis = p[0].trim(); rest = p[1].trim(); }
    const preds = [];
    rest.replace(PRED, (m, p) => { preds.push(p); return m; });
    let nodeTest = rest.replace(PRED, '');
    if (nodeTest === '.') { axis = 'self'; nodeTest = '*'; }
    return { type, axis, nodeTest, preds };
}

const compiled = new Map();
function compile(xpath) {
    let c = compiled.get(xpath);
    if (c) return c;
    c = String(xpath).split('|').map((p) => {
        const steps = (p.trim().match(XPATH_GROUP) || []).map((s) => parseStep(s.trim()));
        if (!steps.length) throw new Error('empty xpath: ' + xpath);
        return steps;
    });
    if (compiled.size > 200) compiled.clear();
    compiled.set(xpath, c);
    return c;
}

// ---------- 求值 ----------
function descendants(n, out = []) { for (const c of kids(n)) { out.push(c); descendants(c, out); } return out; }

function axisNodes(axis, n) {
    switch (axis) {
        case 'child': return kids(n);
        case 'self': case 'attribute': return [n];
        case 'parent': return n.parentNode && isEl(n.parentNode) ? [n.parentNode] : [];
        case 'descendant': return descendants(n);
        case 'descendant-or-self': return [n].concat(descendants(n));
        case 'following-sibling': { const s = kids(n.parentNode); return s.slice(s.indexOf(n) + 1); }
        case 'preceding-sibling': { const s = kids(n.parentNode); return s.slice(0, s.indexOf(n)).reverse(); }
        default: throw new Error('unsupported axis ' + axis);
    }
}
function fnValue(n, fn) {
    if (fn.startsWith('@')) return attr(n, fn.slice(1));
    if (fn === 'text()' || fn === 'string()') return textOf(n);
    if (fn === 'name()' || fn === 'local-name()') return n.tagName;
    throw new Error('Unsupported function: ' + fn);
}
function predOk(pred, n, i, len) {
    pred = pred.trim();
    let m;
    if ((m = /^(\d+)$/.exec(pred))) return +m[1] === i + 1;   // 位置从 1 开始,且只数元素
    if (/^last\(\s*\)$/.test(pred)) return i + 1 === len;
    if ((m = /^last\(\s*\)\s*-\s*(\d+)$/.exec(pred))) return len - +m[1] === i + 1;
    if ((m = /^position\(\s*\)\s*(<=|>=|<|>|=)\s*(\d+)$/.exec(pred))) {
        const p = i + 1, v = +m[2];
        return { '<': p < v, '<=': p <= v, '>': p > v, '>=': p >= v, '=': p === v }[m[1]];
    }
    if ((m = /^(not\s*\()?\s*(@?[\w-]+(?:\(\s*\))?)\s*(!=|=)\s*['"](.*?)['"]\s*\)?$/.exec(pred))) {
        const v = fnValue(n, m[2].replace(/\s/g, ''));
        if (v == null) return false;
        const r = m[3] === '=' ? v === m[4] : v !== m[4];
        return m[1] ? !r : r;
    }
    if ((m = /^(not\s*\()?\s*(contains|starts-with|ends-with)\s*\(\s*(.+?)\s*,\s*['"](.*?)['"]\s*\)\s*\)?$/.exec(pred))) {
        const v = fnValue(n, m[3].toLowerCase());
        if (v == null) return false;
        const r = m[2] === 'contains' ? v.includes(m[4]) : m[2] === 'starts-with' ? v.startsWith(m[4]) : v.endsWith(m[4]);
        return m[1] ? !r : r;
    }
    throw new Error('Unsupported predicate: ' + pred);
}

// 有序去重追加(Set 判重,避免大剧集上 includes 的 O(n²))
function pushU(arr, seen, items) { for (const x of items) if (!seen.has(x)) { seen.add(x); arr.push(x); } }

function execute(steps, ctx) {
    let tmp = [ctx];
    for (const st of steps) {
        const rootMatch = [], rootSeen = new Set();
        for (const el of tmp) {
            // "//X":上下文本身 + 其全部元素后代,逐个取匹配的子元素 —— 这就是"开头 // 相对上下文"的来源
            const pathNodes = st.type === 'desc' ? [el].concat(descendants(el)) : [el];
            const selMatch = [], selSeen = new Set();
            for (const p of pathNodes) {
                let ax = axisNodes(st.axis, p);
                if (!(st.attr != null || st.axis === 'attribute')) {
                    ax = ax.filter((x) => st.nodeTest === 'node()' || (isEl(x) && (st.nodeTest === '*' || x.tagName === st.nodeTest)));
                }
                for (const pr of st.preds) { const len = ax.length; ax = ax.filter((x, i) => predOk(pr, x, i, len)); }
                pushU(selMatch, selSeen, ax);
            }
            pushU(rootMatch, rootSeen, selMatch);
        }
        tmp = rootMatch;
    }
    return tmp;
}

/**
 * 等价于 Kazumi 的 element.queryXPath(xpath)。
 * @param rootOrHtml  HTML 字符串或已解析的节点(字符串时自动 parseHtml)
 * @param xpath       规则 XPath
 * @param contextNode 可选上下文(缺省 = root)
 * @returns {{nodes:object[], node:object|null, attrs:any[], attr:any}}
 */
function evaluate(rootOrHtml, xpath, contextNode) {
    const root = typeof rootOrHtml === 'string' ? parseHtml(rootOrHtml) : rootOrHtml;
    const ctx = contextNode || root;
    const nodes = [], attrs = [], seen = new Set();
    for (const steps of compile(xpath)) {
        const fresh = execute(steps, ctx).filter((n) => !seen.has(n));
        for (const n of fresh) seen.add(n);
        nodes.push(...fresh);
        const last = steps[steps.length - 1];
        for (const n of fresh) {
            if (last.attr != null) attrs.push(last.attr === '*' ? attrValues(n) : attr(n, last.attr));
            else if (last.fn) attrs.push(fnValue(n, last.fn));
        }
    }
    const a = attrs.find((x) => x != null);
    return { nodes, node: nodes[0] || null, attrs, attr: a === undefined ? null : a };
}

/** 取单值:XPath 末步是 @attr 时返回属性值,否则返回首个节点的完整文本 */
function evalString(root, xpath, ctx) {
    const r = evaluate(root, xpath, ctx);
    const last = compile(xpath)[0];
    if (last[last.length - 1].attr != null) return r.attr == null ? '' : String(r.attr);
    return r.node ? textOf(r.node) : '';
}

// Kazumi lib/utils/episode_url.dart 的语义:相对 baseURL 解析;同 host+port 时统一成 baseURL 的 http/https;去路径尾 '/';去空 ?/#
function normalizeEpisodeUrl(baseUrl, raw) {
    const t = String(raw || '').trim();
    if (!t) return '';
    let base = null; try { base = new URL(String(baseUrl).trim()); } catch (e) { }
    let u = null;
    try { u = new URL(t); } catch (e) { if (base) { try { u = new URL(t, base); } catch (e2) { } } }
    if (!u || !u.host) return t;
    if (base && /^https?:$/.test(base.protocol) && /^https?:$/.test(u.protocol) && u.protocol !== base.protocol &&
        u.hostname === base.hostname && u.port === base.port) u.protocol = base.protocol;
    let p = u.pathname; while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    u.pathname = p;
    if (u.search === '?') u.search = '';
    if (u.hash === '#') u.hash = '';
    return u.toString();
}

// Kazumi 的 searchURL 用 Dart Uri.encodeQueryComponent:空格编码为 '+'
function encodeQueryComponent(s) {
    return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Kazumi lib/utils/media.dart 的集号提取:/第?(\d+)[话集]?/,取不到为 0
function extractEpisodeNumber(s) { const m = /第?(\d+)[话集]?/.exec(String(s || '')); return m ? (parseInt(m[1], 10) || 0) : 0; }

module.exports = { parseHtml, evaluate, evalString, textOf, attr, compile, normalizeEpisodeUrl, encodeQueryComponent, extractEpisodeNumber };
