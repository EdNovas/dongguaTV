#!/usr/bin/env node
// 页面整体语法回归(离线):index.html / admin.html 的每段内联 <script> 能被解析、每段 <style> 花括号配对、admin 的 <section> 开合配对。
//   合并分支时冲突块边界常常切在共有的闭合行上(「}」「});」「</section>」),只拼两边会悄悄丢一行:
//   2026-11-26 合并评论分支就丢了 admin.html 里的一个「}」和一个「</section>」,整个后台白屏,其它测试都没报。
//   node scripts/page-syntax-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

for (const f of ['public/index.html', 'public/admin.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    let n = 0;
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="text\/x-template")[^>]*>([\s\S]*?)<\/script>/g)) {
        n++;
        let err = null;
        try { new vm.Script(m[1]); } catch (e) { err = e.message; }
        ok(!err, `${f} 第 ${n} 段内联脚本能解析`, err);
    }
    ok(n > 0, `${f} 找到内联脚本`);
    let k = 0;
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        k++;
        const css = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"\n]*"|'[^'\n]*'/g, '""');
        ok(css.split('{').length === css.split('}').length, `${f} 第 ${k} 段 <style> 花括号配对`, [css.split('{').length - 1, css.split('}').length - 1]);
    }
    if (f.endsWith('admin.html')) ok((html.match(/<section\b/g) || []).length === (html.match(/<\/section>/g) || []).length, 'admin.html 的 <section> 开合配对');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
