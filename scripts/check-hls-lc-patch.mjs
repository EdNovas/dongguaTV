// 回归守卫:public/libs/js/hls.min.js 必须带 AAC-LC 信令补丁(见 public/index.html _dgHlsCustomType 注释)。
// 用法:node scripts/check-hls-lc-patch.mjs   (升级/替换 hls.min.js 后必跑;失败=补丁丢了,Chrome 上会复发"声音低一个八度")
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/libs/js/hls.min.js');
const src = fs.readFileSync(file, 'utf8');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
if (!src.includes('dongguaTV patch')) fail('hls.min.js 顶部没有 dongguaTV patch banner——补丁丢失');
// 把 getAudioConfig 的内部函数从压缩包里抠出来单独执行(定位锚:ADTS 采样率表)
const anchor = 'var o=function(t,e,r,a){var s,o,l,u,h=navigator.userAgent.toLowerCase()';
const i = src.indexOf(anchor);
if (i < 0) fail('找不到 getAudioConfig 内部函数(hls.js 版本变了?请重新评估补丁)');
let j = src.indexOf('{', i + 'var o='.length + 'function(t,e,r,a)'.length); // 函数体起点
let depth = 0, k = j;
for (; k < src.length; k++) { const ch = src[k]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) break; } }
const fnText = src.slice(i + 'var o='.length, k + 1);
const make = (ua) => new Function('navigator', 'f', 'i', 'n', 'return ' + fnText)({ userAgent: ua }, { b: { log() { } } }, { a: {} }, { a: {}, b: {} });
const adts = (profileLC, samplingIndex, channels) => { const b = new Uint8Array(7); b[0] = 0xff; b[1] = 0xf1; b[2] = ((profileLC ? 1 : 0) << 6) | (samplingIndex << 2) | ((channels >> 2) & 1); b[3] = (channels & 3) << 6; return b; };
const hex = (u) => Array.from(u).map(x => x.toString(16).padStart(2, '0')).join(' ');
const CHROME = 'mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 (khtml, like gecko) chrome/140.0.0.0 safari/537.36';
const cases = [
  { ua: CHROME, idx: 4, ch: 2, codec: undefined, want: 'mp4a.40.2', asc: '12 10', why: 'Chrome 44.1k 立体声 LC(资源站主流)' },
  { ua: CHROME, idx: 3, ch: 2, codec: undefined, want: 'mp4a.40.2', asc: '11 90', why: 'Chrome 48k 立体声 LC' },
  { ua: CHROME, idx: 6, ch: 2, codec: 'mp4a.40.2', want: 'mp4a.40.2', asc: '13 10', why: 'Chrome 24k 立体声,清单声明 LC → 绝不能再出 AOT5 ext==base 的坏形状' },
  { ua: CHROME, idx: 6, ch: 2, codec: undefined, want: 'mp4a.40.5', asc: '2b 11 88 00', why: 'Chrome 24k 无 CODECS = 隐式 HE-AAC,保持 AOT5+扩展采样率翻倍(原逻辑)' },
  { ua: CHROME, idx: 4, ch: 2, codec: 'mp4a.40.5', want: 'mp4a.40.5', asc: '2a 10 88 00', why: '清单声明 HE-AAC → 原逻辑' },
  { ua: 'mozilla/5.0 (linux; android 13) chrome/140 mobile', idx: 4, ch: 2, codec: undefined, want: 'mp4a.40.2', asc: '12 10', why: 'Android 分支不变' },
  { ua: 'mozilla/5.0 (windows nt 10.0; rv:130.0) gecko/20100101 firefox/130.0', idx: 4, ch: 2, codec: undefined, want: 'mp4a.40.2', asc: '12 10', why: 'Firefox 分支不变' },
];
let bad = 0;
for (const c of cases) {
  const r = make(c.ua)({ trigger() { } }, adts(true, c.idx, c.ch), 0, c.codec);
  const got = hex(r.config);
  const ok = r.codec === c.want && got === c.asc;
  console.log((ok ? '✓ ' : '✗ ') + c.why + ' → codec ' + r.codec + ' asc [' + got + ']' + (ok ? '' : '  (期望 ' + c.want + ' [' + c.asc + '])'));
  if (!ok) bad++;
}
if (bad) fail(bad + ' 例不符——补丁失效或 hls.js 变了');
console.log('✅ hls.min.js AAC-LC 信令补丁在位');
