// public/index.html 主 Vue 应用(createApp)的方法表守卫:node scripts/index-methods-test.mjs
//  ① methods / computed / watch 对象字面量里不许有重复的键 —— 对象字面量后写的同名键会静默覆盖前一个
//     (曾经:收藏行新加的 onRowScroll(ref, key) 顶掉了分类榜单的 onRowScroll(key) → 榜单左箭头消失、手机滑到底不再加载更多)
//     用一个小词法扫描器(字符串/模板/正则/注释都跳过)数出顶层键,再和真正跑出来的 methods 对象的键集合对一遍,保证扫描没漏
//  ② 行为:分类榜单 @scroll="onRowScroll(key)" 真的写 rowLeftButtons / 靠近右边缘调 fetchRow(key, true);
//     收藏 / 大家都在看两行的 onFavPopRowScroll(ref, key) 写 favCanScrollLeft/Right
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg); } };

const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => ({ code: m[1], at: m.index + m[0].indexOf('>') + 1 }));
const main = scripts.find(s => s.code.includes('createApp({'));
if (!main) { console.log('✗ 找不到 createApp 主脚本'); process.exit(1); }
const SRC = main.code;
const lineOf = (i) => HTML.slice(0, main.at + i).split('\n').length;

// ---------- 极简 JS 词法:只为数清对象字面量的顶层键 ----------
const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const isIdStart = c => /[A-Za-z_$ -￿]/.test(c);
const isId = c => /[A-Za-z0-9_$ -￿]/.test(c);
// 从 i 开始读一个 token;prev = 上一个有效 token(判断 / 是除号还是正则)
function readToken(src, i, prev) {
    for (; ;) {
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
        if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
        break;
    }
    if (i >= src.length) return null;
    const c = src[i], start = i;
    if (c === '\'' || c === '"') {
        i++;
        while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
        return { type: 'str', value: src.slice(start + 1, i), start, end: i + 1 };
    }
    if (c === '`') return { type: 'tmpl', start, end: skipTemplate(src, i) };
    if (isIdStart(c)) {
        while (i < src.length && isId(src[i])) i++;
        return { type: 'name', value: src.slice(start, i), start, end: i };
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        while (i < src.length && /[0-9A-Za-z_.]/.test(src[i])) i++;
        return { type: 'num', value: src.slice(start, i), start, end: i };
    }
    if (c === '/') {
        const regexOk = !prev
            || (prev.type === 'punct' && !/^[)\]]$/.test(prev.value))
            || (prev.type === 'name' && KW_BEFORE_REGEX.has(prev.value));
        if (regexOk) {
            i++;
            let cls = false;
            while (i < src.length) {
                const d = src[i];
                if (d === '\\') { i += 2; continue; }
                if (d === '\n') throw new Error('正则字面量跨行(扫描器误判)@' + lineOf(start));
                if (cls) { if (d === ']') cls = false; }
                else if (d === '[') cls = true;
                else if (d === '/') break;
                i++;
            }
            i++;
            while (i < src.length && /[a-z]/.test(src[i])) i++;
            return { type: 'regex', start, end: i };
        }
    }
    if (src.startsWith('=>', i) || src.startsWith('...', i) || src.startsWith('?.', i) && !/[0-9]/.test(src[i + 2] || '')) {
        const v = src.startsWith('...', i) ? '...' : src.slice(i, i + 2);
        return { type: 'punct', value: v, start, end: i + v.length };
    }
    return { type: 'punct', value: c, start, end: i + 1 };
}
// 模板字符串:${ … } 里是完整的代码(可再嵌模板),数到配平的 }
function skipTemplate(src, i) {
    i++;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') return i + 1;
        if (c === '$' && src[i + 1] === '{') { i = skipCode(src, i + 2); continue; }
        i++;
    }
    throw new Error('模板字符串没闭合');
}
// 从 i 读代码直到配平的 }(返回 } 之后的位置)
function skipCode(src, i) {
    let depth = 0, prev = null;
    for (; ;) {
        const t = readToken(src, i, prev);
        if (!t) throw new Error('代码块没闭合');
        i = t.end;
        if (t.type === 'punct') {
            if ('{(['.includes(t.value)) depth++;
            else if ('})]'.includes(t.value)) { if (depth === 0) return i; depth--; }
        }
        prev = t;
    }
}
// 对象字面量 { … } 的顶层键(按出现顺序,含重复)。open = '{' 的位置
function objectKeys(src, open) {
    const keys = [];
    let i = open, depth = 0, prev = null, seg = [];
    const flush = () => {
        // 一段 = 两个顶层逗号之间的前几个 token:[async|get|set|*]* 名字 (…)|:
        let k = 0;
        while (k < seg.length - 1 && ((seg[k].type === 'name' && /^(async|get|set|static)$/.test(seg[k].value) && seg[k + 1].type !== 'punct')
            || (seg[k].type === 'punct' && seg[k].value === '*'))) k++;
        const t = seg[k];
        if (t && t.type !== 'punct') {
            const nx = seg[k + 1];
            keys.push({ name: t.value, at: t.start, valueStart: (nx && nx.type === 'punct' && nx.value === ':') ? seg[k + 2] : null });
        } else if (t && t.value === '[') keys.push({ name: '[computed]', at: t.start, valueStart: null });
        seg = [];
    };
    for (; ;) {
        const t = readToken(src, i, prev);
        if (!t) throw new Error('对象没闭合');
        i = t.end;
        if (t.type === 'punct' && '{(['.includes(t.value)) {
            depth++;
            if (depth === 2 && seg.length < 4) seg.push(t);
        } else if (t.type === 'punct' && '})]'.includes(t.value)) {
            depth--;
            if (depth === 0) { flush(); return { keys, end: i }; }
        } else if (depth === 1) {
            if (t.type === 'punct' && t.value === ',') flush();
            else if (seg.length < 4) seg.push(t);
        }
        prev = t;
    }
}

console.log('① createApp 方法表无重复键');
const appOpen = SRC.indexOf('createApp({') + 'createApp('.length;
const opts = objectKeys(SRC, appOpen);
const optKey = n => opts.keys.find(k => k.name === n);
const sections = {};
for (const sec of ['methods', 'computed', 'watch']) {
    const k = optKey(sec);
    ok(k && k.valueStart && k.valueStart.value === '{', 'createApp 选项里有 ' + sec + ': { … }');
    if (!k || !k.valueStart) continue;
    sections[sec] = objectKeys(SRC, k.valueStart.start).keys;
}
const dupReport = {};
for (const [sec, keys] of Object.entries(sections)) {
    const seen = new Map(), dups = [];
    for (const k of keys) {
        if (seen.has(k.name)) dups.push(k.name + ' (行 ' + lineOf(seen.get(k.name)) + ' 与 行 ' + lineOf(k.at) + ')');
        else seen.set(k.name, k.at);
    }
    dupReport[sec] = dups;
    ok(!dups.length, sec + ' 里有重复键(后一个静默覆盖前一个):' + dups.join(', '));
}
// methods 与 computed 同名:Vue 只认一个
if (sections.methods && sections.computed) {
    const m = new Set(sections.methods.map(k => k.name));
    const both = [...new Set(sections.computed.map(k => k.name))].filter(n => m.has(n));
    ok(!both.length, 'methods 与 computed 同名:' + both.join(', '));
}

// 在沙箱里真跑一遍主脚本,拿到真正的 createApp 选项对象(全局都是"万能"代理)
function any() {
    const f = function () { return any(); };
    return new Proxy(f, {
        get(t, k) {
            if (k === Symbol.toPrimitive) return () => '';
            if (k === 'then') return undefined;
            if (k === Symbol.iterator) return function* () { };
            return any();
        },
        apply() { return any(); }, construct() { return any(); }, set() { return true; }, has() { return true; }
    });
}
let captured = null;
const ctxObj = {
    Vue: { createApp(o) { captured = o; return { mount() { return {}; }, use() { return this; }, config: {} }; } },
    console: { log() { }, warn() { }, error() { }, info() { } },
    setTimeout: () => 0, clearTimeout() { }, setInterval: () => 0, clearInterval() { },
    requestAnimationFrame: () => 0, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet, Symbol, Error, TypeError,
    URL, URLSearchParams, Uint8Array, ArrayBuffer, Proxy, Reflect, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, AbortController, TextEncoder, TextDecoder,
};
const ctx = new Proxy(ctxObj, {
    has() { return true; },
    get(t, k) { if (k in t) return t[k]; if (k === 'window' || k === 'self' || k === 'globalThis') return ctx; return any(); },
    set(t, k, v) { t[k] = v; return true; }
});
try { vm.runInNewContext(SRC, ctx, { timeout: 5000 }); } catch (e) { }
ok(!!captured && !!captured.methods, '沙箱里跑出了 createApp 选项');
const M = (captured && captured.methods) || {};
if (sections.methods) {
    const scanned = [...new Set(sections.methods.map(k => k.name))].sort();
    const real = Object.keys(M).sort();
    ok(scanned.length === real.length && scanned.every((n, i) => n === real[i]),
        '扫描出的方法名与真实 methods 对象一致(扫描器没漏没多):扫描 ' + scanned.length + ' / 真实 ' + real.length
        + ' 差异 ' + JSON.stringify(scanned.filter(n => !(n in M)).concat(real.filter(n => !scanned.includes(n)))));
}

console.log('② 首页横向行的滚动处理');
{
    // 分类榜单:模板是 @scroll="onRowScroll(key)",ref 是 v-for 里的 :ref="key"(数组)
    const rafQ = [];
    ctxObj.requestAnimationFrame = f => { rafQ.push(f); return rafQ.length; };
    ctxObj.setTimeout = (f) => { rafQ.push(f); return 0; };
    const row = { scrollLeft: 900, clientWidth: 400, scrollWidth: 1500 };
    const self = { $refs: { trendingMovies: [row] }, rowLeftButtons: {}, fetched: [], fetchRow(k, more) { this.fetched.push([k, more]); return Promise.resolve(); } };
    ok(typeof M.onRowScroll === 'function' && M.onRowScroll.length === 1, '分类榜单的 onRowScroll(key) 还在(一个参数)');
    try { M.onRowScroll.call(self, 'trendingMovies'); } catch (e) { }
    while (rafQ.length) rafQ.shift()();
    ok(self.rowLeftButtons.trendingMovies === true, '分类榜单滚动后显示左箭头 (rowLeftButtons.trendingMovies)');
    ok(self.fetched.length === 1 && self.fetched[0][0] === 'trendingMovies' && self.fetched[0][1] === true, '分类榜单滑到靠近右边缘 → fetchRow(key, true) 加载更多');
    ok(!Object.keys(self).some(k => /CanScroll/.test(k)), '分类榜单滚动不写 xxxCanScrollLeft/Right 之类的散属性');

    // 收藏 / 大家都在看:onFavPopRowScroll(ref, key)
    ok(typeof M.onFavPopRowScroll === 'function', '收藏/大家都在看两行用独立的 onFavPopRowScroll(ref, key)');
    const r2 = { scrollLeft: 50, clientWidth: 400, scrollWidth: 1500 };
    const s2 = { $refs: { favRow: r2 }, favCanScrollLeft: false, favCanScrollRight: false };
    if (M.onFavPopRowScroll) M.onFavPopRowScroll.call(s2, 'favRow', 'fav');
    ok(s2.favCanScrollLeft === true && s2.favCanScrollRight === true, '收藏行:左右箭头状态按滚动位置写');
    // 模板/代码里所有调用点都用对了名字
    const calls1 = [...HTML.matchAll(/onRowScroll\(([^)]*)\)/g)].map(m => m[1].trim());
    ok(calls1.every(a => !a.includes(',')), '没有地方再用两个参数调 onRowScroll:' + JSON.stringify(calls1.filter(a => a.includes(','))));
    const calls2 = [...HTML.matchAll(/onFavPopRowScroll\(([^)]*)\)/g)].map(m => m[1].trim()).filter(a => !/^ref, key$/.test(a));
    ok(calls2.length >= 8 && calls2.every(a => /^'(favRow|popularRow)', '(fav|popular)'$/.test(a)), 'onFavPopRowScroll 的调用都是 (favRow, fav) / (popularRow, popular):' + JSON.stringify(calls2));
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过, ${fail} 失败`);
if (Object.values(dupReport).some(a => a.length)) console.log('重复键:', JSON.stringify(dupReport, null, 1));
process.exit(fail ? 1 : 0);
