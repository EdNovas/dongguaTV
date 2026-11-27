#!/usr/bin/env node
// 电视版老内核兼容回归(离线):public/tv/ 下的脚本只能用 ES5 + 老 WebView(≈Chrome 51,斐讯 T1 这类 Android 7 盒子)有的 API,
// 样式不能用老内核不认的写法。一处读不懂整个脚本都不跑,电视上就是一直转圈 —— 主站 index.html 就是这么在 T1 上卡死在「正在初始化」的。
//   node scripts/tv-compat-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public/tv');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

// 把字符串 / 注释 / 正则字面量换成空白,剩下的才是代码(行号不变)
function stripJs(src) {
    let out = '', i = 0, prev = '';   // prev = 上一个有意义的字符,用来判断 / 是除号还是正则
    const blank = s => s.replace(/[^\n]/g, ' ');
    while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? src.length : j; out += blank(src.slice(i, e)); i = e; continue; }
        if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? src.length : j + 2; out += blank(src.slice(i, e)); i = e; continue; }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
            out += c + blank(src.slice(i + 1, j)) + (c === '`' ? '`' : c); i = j + 1; prev = 'a'; continue;
        }
        if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|case|in|of|void|delete|new)\s*$/.test(out.slice(-12)))) {
            let j = i + 1, cls = false;
            while (j < src.length && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '\n') break; j++; }
            j++; while (/[a-z]/i.test(src[j] || '')) j++;
            out += '/' + blank(src.slice(i + 1, j - 1)) + ' '; i = j; prev = 'a'; continue;
        }
        out += c; if (!/\s/.test(c)) prev = c; i++;
    }
    return out;
}

const JS_SYNTAX = [
    [/=>/, '箭头函数 =>'], [/`/, '模板字符串'], [/\blet\s/, 'let'], [/\bconst\s/, 'const'], [/\bclass\s+[A-Za-z_$]/, 'class'],
    [/\basync\b/, 'async'], [/\bawait\b/, 'await'], [/\?\./, '?. 可选链'], [/\?\?/, '?? 空值合并'], [/\.\.\./, '... 展开'],
    [/\bfor\s*\([^)]*\bof\b/, 'for...of'], [/\bfunction\s*\*/, '生成器'], [/\*\*/, '** 乘方'],
];
const JS_API = [
    ['Object.values(', 54], ['Object.entries(', 54], ['.padStart(', 57], ['.padEnd(', 57], ['.finally(', 63], ['AbortController', 66],
    ['ResizeObserver', 64], ['scrollIntoView({', 61], ['.flat(', 69], ['.flatMap(', 69], ['Object.fromEntries', 73], ['globalThis', 71],
    ['.replaceAll(', 85], ['.matchAll(', 73], ['structuredClone', 98], ['.at(', 92], ['Object.hasOwn', 93], ['.append(', 54], ['.prepend(', 54],
    ['.isConnected', 54], ['fetch(', 42], ['.toggleAttribute(', 69], ['queueMicrotask', 71], ['new URL(', 32], ['Symbol', 38],
];
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js'));
ok(files.length > 0, 'public/tv 下有脚本');
for (const f of files) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    let err = null;
    try { new vm.Script(src, { filename: f }); } catch (e) { err = e.message; }
    ok(!err, `${f} 语法能解析`, err);
    const code = stripJs(src);
    const lines = code.split('\n');
    for (const [re, name] of JS_SYNTAX) {
        const hits = [];
        lines.forEach((l, i) => { if (re.test(l)) hits.push(i + 1); });
        ok(!hits.length, `${f} 不用 ${name}(老内核读不懂)`, hits.slice(0, 5));
    }
    for (const [api, chrome] of JS_API) {
        const hits = [];
        lines.forEach((l, i) => { if (l.indexOf(api) >= 0) hits.push(i + 1); });
        ok(!hits.length, `${f} 不用 ${api}(Chrome ${chrome} 才有)`, hits.slice(0, 5));
    }
}

const CSS_BAD = [
    [/display\s*:\s*(-webkit-)?grid/, 'display:grid(Chrome 57)'], [/(^|[;{\s])(row-|column-)?gap\s*:/, 'gap(flex 的 gap 要 Chrome 84)'],
    [/position\s*:\s*sticky/, 'position:sticky(Chrome 56)'], [/(^|[;{\s])inset\s*:/, 'inset(Chrome 87)'], [/aspect-ratio/, 'aspect-ratio(Chrome 88)'],
    [/:focus-visible/, ':focus-visible(Chrome 86)'], [/:focus-within/, ':focus-within(Chrome 60)'], [/backdrop-filter/, 'backdrop-filter'],
    [/:is\(|:where\(|:has\(/, ':is/:where/:has'], [/\bclamp\(|[:\s(,]min\(|[:\s(,]max\(/, 'clamp/min/max(Chrome 79)'], [/\benv\(/, 'env()(Chrome 69)'],
];
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
    ok(css.split('{').length === css.split('}').length, `${f} 花括号配对`);
    const lines = css.split('\n');
    for (const [re, name] of CSS_BAD) {
        const hits = [];
        lines.forEach((l, i) => { if (re.test(l)) hits.push(i + 1); });
        ok(!hits.length, `${f} 不用 ${name}`, hits.slice(0, 5));
    }
}

// 页面本身:只引 public/tv 里的脚本 + 补丁版 hls.min.js,内联脚本也得是 ES5
const page = path.join(DIR, 'index.html');
if (fs.existsSync(page)) {
    const html = fs.readFileSync(page, 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
        const src = (m[1].match(/src="([^"]+)"/) || [])[1];
        if (src) { ok(/^(\/tv\/|\/libs\/js\/hls\.min\.js|\/libs\/js\/qrcode-generator\.min\.js|\/libs\/js\/ad-clip-core\.js)/.test(src), 'tv/index.html 只引老内核能跑的脚本(ES5 的库)', src); continue; }
        const code = stripJs(m[2]);
        for (const [re, name] of JS_SYNTAX) ok(!re.test(code), `tv/index.html 内联脚本不用 ${name}`);
    }
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
