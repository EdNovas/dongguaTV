#!/usr/bin/env node
// 🎙️ 语音搜索 + ✨ AI 找片回归(离线、零网络):
//   node scripts/voice-test.mjs
//  ① public/index.html 里 <dg-voice-core> 的纯函数:识别结果 → 搜索词、降采样、WAV 编码 / base64
//  ② lib/cf-ai:没配置时关着、模型名校验、每日上限、CF 报错 / 超时的处理(假 fetch)
//  ③ lib/ai-find:模型输出解析、TMDB 核实(编造的片名筛掉)、主模型下架换备用、缓存
//  ④ 接线:/api/voice/transcribe 校验 WAV 头和登录、/api/config.voice_asr、前端麦克风按钮只在能用时出
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

console.log('③ lib/ai-find');
{
    const { createAiFind, parseCandidates, pickTmdb } = require(path.join(ROOT, 'lib/ai-find'));
    const P = (t) => parseCandidates(t).map(c => c.title + ':' + c.year + ':' + c.type).join(',');
    ok(P('{"candidates":[{"title":"开端","year":2022,"type":"tv","confidence":0.9}]}') === '开端:2022:tv', '标准 JSON');
    ok(P('<think>嗯…</think>' + '`'.repeat(3) + 'json\n{"candidates":[{"title":"繁花","year":"2023","type":"tv"}]}\n' + '`'.repeat(3)) === '繁花:2023:tv', '去掉 <think> 和代码围栏,年份是字符串也认');
    ok(P('好的,结果如下:{"candidates":[{"title":"狂飙"}]} 希望有帮助') === '狂飙:0:', '前后有废话:截出 {…}');
    ok(P('[{"name":"三体","year":3000,"type":"series"},{"title":"三体"},{"title":""},null,"x"]') === '三体:0:', '只给数组也认;name 当 title;非法年份 / 类型清掉;重复 / 空的丢掉');
    ok(P('完全不是 JSON') === '' && P(null) === '', '解析不了 → 空');
    ok(parseCandidates(JSON.stringify({ candidates: Array.from({ length: 9 }, (_, i) => ({ title: 'T' + i })) })).length === 6, '最多 6 个');
    const R = (o) => Object.assign({ media_type: 'tv', vote_count: 100 }, o);
    ok(pickTmdb([R({ id: 1, name: '开端', first_air_date: '2022-01-11' })], { title: '开端', year: 2022, type: 'tv' }).id === 1, '片名一样 + 年份对 → 核实');
    ok(pickTmdb([R({ id: 2, name: '狂飙', first_air_date: '2023-01-14' })], { title: '狂飙', year: 0 }).id === 2, '片名一样、没给年份 → 也算');
    ok(pickTmdb([R({ id: 3, name: '流浪地球2', media_type: 'movie', release_date: '2023-01-22' })], { title: '流浪地球', year: 2023, type: 'movie' }).id === 3, '片名互相包含 + 年份对 → 算');
    ok(pickTmdb([R({ id: 4, name: '重生之我在公交车上', first_air_date: '2010-01-01' })], { title: '公交车', year: 2022 }) === null, '只是包含、年份差很多 → 不算(编造 / 对错片)');
    ok(pickTmdb([R({ id: 6, media_type: 'person', name: '开端' })], { title: '开端' }) === null, '人物结果不算');
    ok(pickTmdb([R({ id: 7, name: 'Interstellar', original_name: 'Interstellar', media_type: 'movie', release_date: '2014-11-05' })], { title: '星际穿越', original_title: 'Interstellar', year: 2014, type: 'movie' }).id === 7, '中文名对不上时用原名对');

    const runs = [];
    let mode = 'ok';
    const fakeAi = { run: async (model, body) => {
        runs.push({ model, body });
        if (mode === 'gone' && /glm|deepseek/.test(model)) { const e = new Error('Model has been deprecated'); e.status = 410; throw e; }
        if (mode === 'busy') { const e = new Error('upstream'); e.status = 503; throw e; }
        return { choices: [{ message: { content: JSON.stringify({ candidates: [
            { title: '开端', year: 2022, type: 'tv', reason: '公交车爆炸循环' }, { title: '重生之我在公交车上', year: 2023, type: 'tv' }, { title: '开端', year: 2022 }, { title: '源代码', year: 2011, type: 'movie' }] }) } }] };
    } };
    const db = { '开端': [R({ id: 11, name: '开端', first_air_date: '2022-01-11', poster_path: '/a.jpg', overview: '游戏架构师李诗情…' })], '源代码': [R({ id: 22, title: '源代码', media_type: 'movie', release_date: '2011-03-11' })] };
    let t = 1000;
    const f = createAiFind({ ai: fakeAi, now: () => t, tmdbGet: async (p, q) => ({ results: db[q.query] || [] }) });
    const r1 = await f.find({ q: '男主每次坐公交车都会爆炸' });
    ok(r1.items.map(x => x.title + ':' + x.media).join() === '开端:tv,源代码:movie' && r1.unverified.map(x => x.title).join() === '重生之我在公交车上', '核实到的带海报 / 简介;编造的进「没核实」;重复的只留一个', r1);
    ok(r1.items[0].poster === '/a.jpg' && r1.items[0].reason === '公交车爆炸循环' && r1.model === '@cf/zai-org/glm-5.3', '…字段齐全,文字默认 glm-5.3');
    const b0 = runs[0].body;
    ok(b0.reasoning_effort === 'low' && b0.max_tokens === 3000 && b0.messages[0].role === 'system' && b0.messages[1].content === '男主每次坐公交车都会爆炸' && b0.temperature === 0.2, '请求:glm 轻思考(token 给够)、system + user、低温度');
    const n = runs.length;
    const r2 = await f.find({ q: '  男主每次坐公交车都会爆炸 ' });
    ok(r2.cached === true && runs.length === n, '同一句话 1 小时内走缓存(空格不同也算)');
    t += 3600e3 + 1;
    await f.find({ q: '男主每次坐公交车都会爆炸' });
    ok(runs.length === n + 1, '过了 1 小时重新问');
    await f.find({ image: 'data:image/jpeg;base64,AAAA', q: '' });
    const bi = runs[runs.length - 1].body.messages[1].content;
    ok(Array.isArray(bi) && bi[0].text === '帮我找下这个是哪个电影或者电视剧' && bi[1].image_url.url === 'data:image/jpeg;base64,AAAA'
        && runs[runs.length - 1].model === '@cf/deepseek-ai/deepseek-v4.1-flash-1017' && runs[runs.length - 1].body.reasoning_effort === 'none', '截图:默认问题 + image_url,用认图的 deepseek(不开思考)');
    mode = 'gone';
    const r3 = await f.find({ q: '换个问题' });
    ok(r3.model === '@cf/google/gemma-4-26b-a4b-it' && runs.slice(-3).map(x => x.model.split('/')[2]).join() === 'glm-5.3,deepseek-v4.1-flash-1017,gemma-4-26b-a4b-it'
        && runs[runs.length - 1].body.chat_template_kwargs.enable_thinking === false, '主模型 / 第一备用都下架(410)→ 按顺序换到 gemma-4(关思考)');
    mode = 'busy';
    let threw = null;
    try { await f.find({ q: '再换一个' }); } catch (e) { threw = e.status; }
    ok(threw === 503, '5xx 不换模型,直接报错(别把两个模型都打一遍)');
    // 主模型胡答(只回一部、confidence 0)→ 换下一个模型再问一次,用核实到更多的那个
    mode = 'ok';
    const seqAi = { n: 0, run: async (model) => {
        seqAi.n++;
        if (/glm/.test(model)) return { choices: [{ message: { content: '{"candidates":[{"title":"明日方舟：黎明前奏","year":2022,"confidence":0.0,"reason":""}]}' } }] };
        return { choices: [{ message: { content: '{"candidates":[{"title":"开端","year":2022,"type":"tv","confidence":0.9}]}' } }] };
    } };
    const g = createAiFind({ ai: seqAi, tmdbGet: async (p, q) => ({ results: db[q.query] || [R({ id: 99, name: q.query, first_air_date: '2022-05-01' })] }) });
    const r5 = await g.find({ q: '推荐几部像开端的' });
    ok(r5.retried === true && r5.model === '@cf/deepseek-ai/deepseek-v4.1-flash-1017' && r5.items.map(x => x.title).join() === '开端' && seqAi.n === 2, '主模型胡答 → 换 deepseek 再问一次,用它的结果', r5);
    const goodAi = { n: 0, run: async () => { goodAi.n++; return { choices: [{ message: { content: '{"candidates":[{"title":"开端","year":2022,"confidence":0.9}]}' } }] }; } };
    const r6 = await createAiFind({ ai: goodAi, tmdbGet: async (p, q) => ({ results: db[q.query] || [] }) }).find({ q: 'x' });
    ok(r6.retried === false && goodAi.n === 1, '答得好就不重问(只调用一次)');
    const noTmdb = createAiFind({ ai: { run: async () => ({ response: '{"candidates":[{"title":"繁花"}]}' }) } });
    const r4 = await noTmdb.find({ q: 'x' });
    ok(r4.items.length === 0 && r4.unverified[0].title === '繁花' && r4.unverified[0].noCheck, '没配 TMDB:原样回片名(标没核实)');
    threw = null;
    try { await f.find({ q: '  ' }); } catch (e) { threw = e.message; }
    ok(/说说想找什么/.test(threw || ''), '空问题 → 报错不调用');
    const D = V.descriptive;
    ok(D('有个剧男主每次坐公交车都会爆炸') && D('推荐几部像开端一样的剧') && D('一个宇航员在火星种土豆的电影') && !D('繁花') && !D('我想看狂飙') && !D('庆余年第二季') && !D('胡歌演的繁花'),
        '语音说的是描述 → 交给 AI 找片;说的是片名 → 照常搜');
}

console.log('④ 接线');
{
    ok(/app\.post\('\/api\/voice\/transcribe', voiceLimiter,/.test(SERVER) && /audio\.slice\(0, 5\) !== 'UklGR'/.test(SERVER) && /audio\.length > 1600000/.test(SERVER), '服务器:限流、只收 WAV、大小上限');
    ok(/if \(ACCESS_PASSWORDS\.length && !Object\.prototype\.hasOwnProperty\.call\(PASSWORD_HASH_MAP, token\)\) return \{ status: 401/.test(SERVER), '需要登录的站:没登录 / 原型键(constructor)都拒绝');
    ok(/voice_asr: VOICE_ENABLED,/.test(SERVER) && /this\.voiceAsr = !!config\.voice_asr;/.test(HTML), '/api/config.voice_asr → 前端 voiceAsr');
    ok(/<button v-if="voiceAvail" type="button" class="search-mic" @click="voiceStart"/.test(HTML), '搜索框里的麦克风按钮只在 voiceAvail 时出');
    ok(/token: localStorage\.getItem\('emax_auth_hash'\) \|\| ''/.test(HTML), '上传录音带登录 token');
    ok(/app\.post\('\/api\/ai\/find', aiFindLimiter,/.test(SERVER) && /ai_find: !!aiFind,/.test(SERVER) && /this\.aiFindOn = !!config\.ai_find;/.test(HTML), 'AI 找片:接口限流、/api/config.ai_find → 前端');
    ok(/image\.length > 2000000 \|\| !AI_IMG_RE\.test\(image\)/.test(SERVER), 'AI 找片:只收 jpg/png/webp、≤2MB');
    ok(/@click="aiFindOpen\(keyword\)"/.test(HTML) && /if \(this\.aiFindOn && DgVoice\.descriptive\(text\)\)/.test(HTML), '搜不到时「让 AI 找找」、语音说一段描述直接进 AI 找片');
    ok(!/@click="voiceStart\(\$event/.test(HTML) && /@click="voice\.phase === 'listen' \? voiceStop\(\) : voiceStart\(\)"/.test(HTML), '模板调用不把点击事件塞进参数');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
