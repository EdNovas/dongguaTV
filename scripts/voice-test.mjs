#!/usr/bin/env node
// 🎙️ 语音搜索回归(离线、零网络):
//   node scripts/voice-test.mjs
//  ① public/index.html 里 <dg-voice-core> 的纯函数:识别结果 → 搜索词、降采样、WAV 编码 / base64
//  ② lib/cf-ai:没配置时关着、模型名校验、每日上限、CF 报错 / 超时的处理(假 fetch)
//  ③ 接线:/api/voice/transcribe 校验 WAV 头和登录、/api/config.voice_asr、前端麦克风按钮只在能用时出
// 改语音搜索 / lib/cf-ai 后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

const m = /\/\/ <dg-voice-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-voice-core>/.exec(HTML);
if (!m) { console.log('✗ index.html 里找不到 <dg-voice-core> 段'); process.exit(1); }
const V = vm.runInNewContext(m[1] + '\n;DgVoice;', { Float32Array, Int16Array, Uint8Array, ArrayBuffer, DataView, Math, String, btoa: (s) => Buffer.from(s, 'binary').toString('base64') });

console.log('① 纯函数');
{
    const cases = [
        ['我想看狂飙。', '狂飙'], ['胡歌演的繁花', '繁花'], ['流浪地球二', '流浪地球2'], ['庆余年第二季。', '庆余年第二季'], ['帮我找一下甄嬛传', '甄嬛传'],
        ['搜索三体', '三体'], ['播放琅琊榜', '琅琊榜'], ['我要看鱿鱼游戏吧', '鱿鱼游戏'], ['看不见的客人', '看不见的客人'], ['放羊的星星', '放羊的星星'],
        ['Breaking Bad.', 'Breaking Bad'], ['  ，繁花 ', '繁花'], ['张艺谋导演的满江红', '满江红'], ['第二十条', '第二十条'], ['一二三', '一二三'],
        ['西游记后传十', '西游记后传十'], ['。', '。'], ['', ''],
    ];
    for (const [i, want] of cases) ok(V.clean(i) === want, `clean(${JSON.stringify(i)}) = ${JSON.stringify(want)}`, V.clean(i));
    const sine = (n, rate, hz) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * hz * i / rate); return a; };
    const pcm = V.downsample([sine(4800, 48000, 440), sine(4800, 48000, 440)], 48000, 16000);
    ok(pcm.length === 3200 && Math.max(...pcm) > 15000 && Math.max(...pcm) <= 32767 && Math.min(...pcm) >= -32768, '48k 两段 0.1 秒 → 16k 3200 个采样,幅度对', [pcm.length, Math.max(...pcm)]);
    const clip = V.downsample([new Float32Array([2, -2, 0.5])], 16000, 16000);
    ok(clip[0] === 32767 && clip[1] === -32768, '超过 ±1 的削顶,不溢出', [...clip]);
    const w = V.wav(pcm, 16000), d = new DataView(w.buffer);
    const tag = (o) => String.fromCharCode(...w.slice(o, o + 4));
    ok(tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ' && tag(36) === 'data' && d.getUint32(24, true) === 16000 && d.getUint16(22, true) === 1 && d.getUint16(34, true) === 16
        && d.getUint32(40, true) === 6400 && w.length === 44 + 6400, 'WAV 头:RIFF/WAVE、16k、单声道、16 位、数据长度对');
    const b = V.b64(w);
    ok(b.slice(0, 5) === 'UklGR' && Buffer.from(b, 'base64').equals(Buffer.from(w)), 'base64 以 UklGR 开头、能原样还原(服务器靠这个认 WAV)');
    const big = V.b64(new Uint8Array(200000).map((_, i) => i & 255));
    ok(Buffer.from(big, 'base64').length === 200000, '大于 32KB 分块编码也对');
}

console.log('② lib/cf-ai');
{
    const { createCfAi } = require(path.join(ROOT, 'lib/cf-ai'));
    const off = createCfAi({ accountId: '', token: '' });
    let threw = null;
    try { await off.run('@cf/x/y', {}); } catch (e) { threw = e.code; }
    ok(!off.enabled() && threw === 'disabled', '没配 → enabled false,调用直接拒绝');
    ok(!createCfAi({ accountId: 'not-hex', token: 'x'.repeat(40) }).enabled(), 'account id 格式不对 → 不开');
    const calls = [];
    let reply = { success: true, result: { text: ' 胡歌演的繁花 ' } }, status = 200, delay = 0;
    const fakeFetch = async (url, init) => {
        calls.push({ url, init });
        if (delay) await new Promise((r, j) => { const t = setTimeout(r, delay); init.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; j(e); }); });
        return { ok: status === 200, status, json: async () => reply };
    };
    let now = Date.UTC(2026, 10, 26, 15, 0);
    const ai = createCfAi({ accountId: 'a'.repeat(32), token: 't'.repeat(40), fetchImpl: fakeFetch, now: () => now, opts: { dailyLimit: 3, timeoutMs: 50 } });
    ok(ai.enabled() && await ai.transcribe('UklGRxxx') === '胡歌演的繁花', '转文字:去掉首尾空白');
    const c0 = calls[0];
    ok(c0.url === 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/ai/run/@cf/openai/whisper-large-v3-turbo' && c0.init.headers.Authorization === 'Bearer ' + 't'.repeat(40)
        && JSON.parse(c0.init.body).audio === 'UklGRxxx' && !('language' in JSON.parse(c0.init.body)), '请求:Whisper turbo、Bearer token、不指定语言');
    threw = null;
    try { await ai.run('../../evil', {}); } catch (e) { threw = e.message; }
    ok(threw === '模型名不对' && calls.length === 1, '模型名不是 @cf/作者/名字 → 不发请求');
    reply = { success: false, errors: [{ code: 5028, message: 'Model has been deprecated' }] }; status = 410;
    threw = null;
    try { await ai.run('@cf/qwen/old', {}); } catch (e) { threw = e; }
    ok(threw && threw.status === 410 && /deprecated/.test(threw.message), 'CF 报错 → 抛出带状态码和原因');
    reply = { success: true, result: { text: 'x' } }; status = 200; delay = 500;
    threw = null;
    try { await ai.run('@cf/x/y', {}); } catch (e) { threw = e.code; }
    ok(threw === 'quota' || threw === 'timeout', '超时 → timeout(或已到上限)', threw);
    delay = 0;
    threw = null;
    try { await ai.run('@cf/x/y', {}); } catch (e) { threw = e.code; }
    ok(threw === 'quota' && ai.usage().count === 3, '每天上限 3 次:第 4 次拒绝', ai.usage());
    now += 24 * 3600e3;
    ok(await ai.transcribe('UklGR') === 'x' && ai.usage().count === 1, '第二天(北京时间)重新计数');
}

console.log('③ 接线');
{
    ok(/app\.post\('\/api\/voice\/transcribe', voiceLimiter,/.test(SERVER) && /audio\.slice\(0, 5\) !== 'UklGR'/.test(SERVER) && /audio\.length > 1600000/.test(SERVER), '服务器:限流、只收 WAV、大小上限');
    ok(/if \(ACCESS_PASSWORDS\.length && !Object\.prototype\.hasOwnProperty\.call\(PASSWORD_HASH_MAP, token\)\) return \{ status: 401/.test(SERVER), '需要登录的站:没登录 / 原型键(constructor)都拒绝');
    ok(/voice_asr: VOICE_ENABLED,/.test(SERVER) && /this\.voiceAsr = !!config\.voice_asr;/.test(HTML), '/api/config.voice_asr → 前端 voiceAsr');
    ok(/<button v-if="voiceAvail" type="button" class="search-mic" @click="voiceStart"/.test(HTML), '搜索框里的麦克风按钮只在 voiceAvail 时出');
    ok(/token: localStorage\.getItem\('emax_auth_hash'\) \|\| ''/.test(HTML), '上传录音带登录 token');
    ok(!/@click="voiceStart\(\$event/.test(HTML) && /@click="voice\.phase === 'listen' \? voiceStop\(\) : voiceStart\(\)"/.test(HTML), '模板调用不把点击事件塞进参数');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
