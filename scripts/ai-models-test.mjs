#!/usr/bin/env node
// 站长后台「AI 模型」(lib/ai-models)回归,离线、零网络(假 fetch + 内存 SQLite):
//   node scripts/ai-models-test.mjs      (worktree 没有 node_modules 时:NODE_PATH=F:/dongguaTV/node_modules)
//  ① 目录条目解析:价格 / 思考档位 / 能干什么(聊天、认图、语音)/ 调用参数(实测表优先)
//  ② 同步:分页、存库、下架标记、新上标记、失败保留旧列表、重启从库里读回
//  ③ 生效的模型:默认 / 站长选的顺序 / 跳过下架和过期的 / 补默认兜底 / 截图只要认图的 / CF_AI_FIND_MODEL / 全不能用挑分最高的
//  ④ 改设置的校验
//  ⑤ 打分评级 + 实测底 + 推荐
//  ⑥ 快速测评:同一套提示词、打分、截图取图、延迟 / 花费、排队一个一个跑、进度、出错
//  ⑦ lib/ai-find / lib/cf-ai 每次请求现取模型(后台改了不用重启)
//  ⑧ server.js 接线
// 改 lib/ai-models、lib/ai-find 的模型参数、或后台 AI 接口后必跑。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };
const Database = dep('better-sqlite3');
const { createAiModels, parseRaw, derive, requestFor, gradeOf, letter, DEFAULT_IDS } = require(path.join(ROOT, 'lib/ai-models'));
const { createAiFind, SYS } = require(path.join(ROOT, 'lib/ai-find'));
const { createCfAi } = require(path.join(ROOT, 'lib/cf-ai'));
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('\r\n').join('\n');
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/ai-models/bench-cases.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const tick = () => new Promise((r) => setImmediate(r));
async function until(f, n = 500) { for (let i = 0; i < n; i++) { if (f()) return true; await tick(); } return false; }

const { GLM, DS, GEMMA, WHISPER } = DEFAULT_IDS;
const QWEN = '@cf/qwen/qwen3.8-27b', OLD = '@cf/meta/llama-3.2-3b-instruct', CLAIRIC = '@cf/cloudflare/clairic', SEA = '@cf/aisingapore/gemma-sea-lion-v4-27b-it';
const SCOUT = '@cf/meta/llama-4-scout-17b-16e-instruct', G47 = '@cf/zai-org/glm-4.7-flash', W1 = '@cf/openai/whisper', NOVA = '@cf/deepgram/nova-3', LLAVA = '@cf/llava-hf/llava-1.5-7b-hf';
const P = (o) => Object.entries(o).map(([property_id, value]) => ({ property_id, value }));
const tok = (i, o) => ({ property_id: 'price', value: [{ unit: 'per M input tokens', price: i, currency: 'USD' }, { unit: 'per M output tokens', price: o, currency: 'USD' }, { unit: 'per M cached input tokens', price: i / 5, currency: 'USD' }] });
const RAW = {
    [GLM]: { task: 'Text Generation', props: [...P({ require_workers_paid: 'true', context_window: '1048576', reasoning: 'true', reasoning_effort: { supported_efforts: ['max', 'high', 'low'], mandatory: true } }), tok(1.4, 4.4)] },
    [DS]: { task: 'Text Generation', props: [...P({ require_workers_paid: 'true', context_window: '1048576', reasoning: 'true', vision: 'true', reasoning_effort: { supported_efforts: ['max', 'high', 'low', 'none'] } }), tok(0.3, 1.2)] },
    [GEMMA]: { task: 'Text Generation', props: [...P({ context_window: '256000', reasoning: 'true', reasoning_effort: { mandatory: false, default_enabled: true }, vision: 'true' }), tok(0.1, 0.3)] },
    [QWEN]: { task: 'Text Generation', props: [...P({ reasoning: 'true', vision: 'true', reasoning_effort: { supported_efforts: ['xhigh', 'medium', 'low'] } }), tok(0.45, 3.2)] },
    [OLD]: { task: 'Text Generation', props: [...P({ planned_deprecation_date: '2026-11-20' }), tok(0.05, 0.33)] },
    [CLAIRIC]: { task: 'Text Generation', props: [...P({ context_window: '65536', vision: 'true' }), { property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.1 }] }] },
    [SEA]: { task: 'Text Generation', props: [tok(0.351, 0.555)] },
    [SCOUT]: { task: 'Text Generation', props: [...P({ vision: 'true' }), tok(0.27, 0.85)] },
    [G47]: { task: 'Text Generation', props: [...P({ reasoning: 'true', planned_deprecation_date: '2026-12-31' }), tok(0.06, 0.4)] },
    [WHISPER]: { task: 'Automatic Speech Recognition', props: [{ property_id: 'price', value: [{ unit: 'per audio minute', price: 0.000513 }] }] },
    [W1]: { task: 'Automatic Speech Recognition', props: [] },
    [NOVA]: { task: 'Automatic Speech Recognition', props: [...P({ partner: 'true' }), { property_id: 'price', value: [{ unit: 'per audio minute (websocket)', price: 0.0092 }, { unit: 'per audio minute', price: 0.0052 }] }] },
    [LLAVA]: { task: 'Image-to-Text', props: P({ beta: 'true', planned_deprecation_date: '2026-11-20' }) },
    '@cf/black-forest-labs/flux-1-schnell': { task: 'Text-to-Image', props: [] },
};
const raw = (name) => ({ id: 'x', name, description: name + ' 的说明'.repeat(60), task: { id: 't', name: RAW[name].task }, properties: RAW[name].props });

console.log('① 目录条目解析');
{
    ok(parseRaw(raw('@cf/black-forest-labs/flux-1-schnell')) === null && parseRaw({ name: '../x', task: { name: 'Text Generation' } }) === null && parseRaw(null) === null, '不是那三类 / 名字不对 → 不收');
    const d = (n) => derive(n, RAW[n].task, { desc: '', props: parseRaw(raw(n)).props });
    const ds = d(DS);
    ok(ds.vision && ds.reasoning && ds.paidOnly && ds.ctx === 1048576 && ds.price.in === 0.3 && ds.price.out === 1.2 && ds.efforts.join() === 'max,high,low,none', 'deepseek:认图、思考档位、要付费、上下文、价格');
    ok(ds.roles.join() === 'text,image' && d(GLM).roles.join() === 'text' && d(SEA).roles.join() === 'text', '认图的聊天模型能管文字和截图,不认图的只能文字');
    ok(d(CLAIRIC).roles.length === 0 && d(CLAIRIC).request === null, 'clairic(结构化抽取,不是聊天模型)→ 不能选');
    ok(d(WHISPER).roles.join() === 'asr' && d(W1).roles.join() === 'asr' && d(NOVA).roles.length === 0 && d(NOVA).hosted === 'partner' && d(NOVA).price.minute === 0.0052, '语音只认 whisper;deepgram 是合作方、取普通(非 websocket)的每分钟价');
    ok(d(LLAVA).roles.join() === 'image' && d(LLAVA).beta && d(LLAVA).deprecation === '2026-11-20', '看图模型(Image-to-Text)→ 截图;beta、下架日期');
    ok(JSON.stringify(d(GLM).request) === '{"extra":{"reasoning_effort":"low"},"maxTokens":3000}', 'glm-5.3 用实测表:low + 3000 token');
    ok(JSON.stringify(d(DS).request) === '{"extra":{"reasoning_effort":"none"},"maxTokens":700}', 'deepseek-v4.1-flash 用实测表:none');
    ok(JSON.stringify(d(GEMMA).request) === '{"extra":{"chat_template_kwargs":{"enable_thinking":false}},"maxTokens":700}', 'gemma-4 用实测表:关思考');
    ok(JSON.stringify(d(QWEN).request) === '{"extra":{"reasoning_effort":"low"},"maxTokens":3000}', '只支持到 low → low + 3000 token');
    ok(JSON.stringify(d(G47).request) === '{"extra":{"chat_template_kwargs":{"enable_thinking":false}},"maxTokens":700}', '有思考没档位 → chat_template_kwargs 关思考');
    ok(JSON.stringify(d(SCOUT).request) === '{"extra":{},"maxTokens":700}', '不思考的 → 原样');
    ok(requestFor('@cf/a/b', ['high', 'none'], true).extra.reasoning_effort === 'none', '支持 none → none');
    ok(parseRaw(raw(GLM)).desc.length === 200, '说明截到 200 字');
}

// ---------- 假 Cloudflare ----------
let t = Date.UTC(2026, 10, 26, 4, 0);   // 北京 2026-11-26 12:00
let catalogNames = Object.keys(RAW), catalogFail = false;
const fetches = [];
const IMG_OK = new Set(['/3J8HmgR16MKX2iT71mB4EIDdV2x.jpg', '/i4xRsWEAwGgL5wMm8jrBbxxXKEI.jpg', '/dyJvKsNs2KP8qQnAXbRwDjblViy.jpg', '/2meX1nMdScFOoV4370rqHWKmXhY.jpg', '/8sNiAPPYU14PUepFNeSNGUTiHW.jpg']);
async function fakeFetch(url, init) {
    fetches.push({ url, init });
    const m = /\/ai\/models\/search\?per_page=100&page=(\d+)$/.exec(url);
    if (m) {
        if (catalogFail) return { ok: false, status: 500, json: async () => ({ success: false, errors: [{ message: 'internal' }] }) };
        const per = 6, page = Number(m[1]);
        const items = catalogNames.slice((page - 1) * per, page * per).map(raw);
        return { ok: true, status: 200, json: async () => ({ success: true, result: items, result_info: { page, per_page: per, count: items.length, total_count: catalogNames.length } }) };
    }
    const im = /^https:\/\/img\.test\/t\/p\/w780(\/\w+\.jpg)$/.exec(url);
    if (im) {
        if (!IMG_OK.has(im[1])) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        const buf = Buffer.from(('IMG' + im[1] + '|').repeat(60));
        return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
    }
    throw new Error('意外的请求 ' + url);
}
const ACC = 'a'.repeat(32), TOKEN = 't'.repeat(40);
const mk = (db, extra) => createAiModels(Object.assign({ db: () => db, ai: null, accountId: ACC, token: TOKEN, fetchImpl: fakeFetch, imageBase: 'https://img.test/t/p/w780/', now: () => t }, extra || {}));
const byName = (st, n) => st.models.find((x) => x.name === n);

console.log('② 同步');
const db = new Database(':memory:');
const M = mk(db);
{
    const s0 = M.state();
    ok(s0.models.length === 0 && s0.catalogAt === 0 && s0.effective.text.join() === [GLM, DS, GEMMA].join(), '还没同步:列表空,生效的是默认');
    await M.refresh();
    const pages = fetches.filter((f) => /models\/search/.test(f.url));
    ok(pages.length === 3 && pages[0].init.headers.Authorization === 'Bearer ' + TOKEN && /accounts\/a{32}\/ai\/models\/search\?per_page=100&page=1$/.test(pages[0].url), '分页拉到 total_count 为止(14 条 / 每页 6 → 3 页),带 Bearer token', pages.map((p) => p.url));
    const s = M.state();
    ok(s.models.length === 13 && !byName(s, '@cf/black-forest-labs/flux-1-schnell') && s.catalogAt === t && s.catalogErr === '', '只留三类(13 个),记下同步时间');
    ok(s.models.every((x) => !x.isNew && !x.gone), '第一次同步的都不算「新」');
    ok(byName(s, OLD).deprecated && byName(s, LLAVA).deprecated && !byName(s, G47).deprecated && byName(s, G47).deprecation === '2026-12-31', '过了计划下架日期(按北京日期)= 已过期;没到的只显示日期');
    ok(db.prepare('SELECT COUNT(*) c FROM ai_models').get().c === 13, '存进 ai_models');
    // 第二次:deepseek 没了、新上一个
    t += 86400e3;
    RAW['@cf/new/model-x'] = { task: 'Text Generation', props: [tok(0.01, 0.02)] };
    catalogNames = Object.keys(RAW).filter((n) => n !== DS);
    await M.refresh();
    const s2 = M.state();
    ok(byName(s2, DS).gone && byName(s2, '@cf/new/model-x').isNew && !byName(s2, GLM).isNew, '目录里没了 → 已下架;新出现的 → 新');
    ok(s2.models[s2.models.length - 1].name === DS, '下架的排最后');
    t += 8 * 86400e3;
    catalogNames = Object.keys(RAW);
    await M.refresh();
    const s3 = M.state();
    ok(!byName(s3, DS).gone && !byName(s3, '@cf/new/model-x').isNew, '回来了 → 不再是下架;超过 7 天 → 不再是新');
    catalogFail = true;
    const at = s3.catalogAt;
    await M.refresh();
    const s4 = M.state();
    ok(s4.catalogErr === 'internal' && s4.catalogAt === at && s4.models.length === 14, '拉目录失败:保留上次的列表,记下原因', s4.catalogErr);
    catalogFail = false;
    const p1 = M.refresh(), p2 = M.refresh();
    ok(p1 === p2, '同时点两次刷新只拉一次');
    await p1;
    ok(M.state().catalogErr === '', '再成功一次清掉错误');
    const off = createAiModels({ accountId: '', token: '' });
    await off.refresh();
    ok(/没配/.test(off.state().catalogErr), '没配账号 → 报原因不请求');
}

console.log('③ 生效的模型');
{
    ok(M.state().effective.image.join() === [DS, GEMMA].join() && M.asrModel() === WHISPER, '默认:截图 deepseek → gemma,语音 whisper-large-v3-turbo');
    M.saveSettings({ text: [QWEN, OLD], image: [QWEN], asr: W1 });
    const e = M.state().effective;
    ok(e.text.join() === [QWEN, GLM, DS, GEMMA].join(), '站长选的在前(过期的跳过),后面补默认兜底', e.text);
    ok(e.image.join() === [QWEN, DS, GEMMA].join() && e.asr === W1, '截图 / 语音按站长选的');
    const calls = M.textModels();
    ok(calls[0].id === QWEN && calls[0].extra.reasoning_effort === 'low' && calls[0].maxTokens === 3000 && calls[1].id === GLM && calls[1].maxTokens === 3000, 'textModels() 给 ai-find 的是 { id, extra, maxTokens }');
    ok(M.imageModels()[1].extra.reasoning_effort === 'none', 'imageModels() 同样带调用参数');
    // deepseek 下架
    t += 3600e3;
    catalogNames = Object.keys(RAW).filter((n) => n !== DS);
    await M.refresh();
    ok(M.state().effective.text.join() === [QWEN, GLM, GEMMA].join() && M.state().effective.image.join() === [QWEN, GEMMA].join(), '下架的自动跳过(选的、默认的都是)');
    // 全部不能用 → 挑能用的里分最高的
    catalogNames = [SEA, G47, SCOUT, WHISPER];
    await M.refresh();
    M.saveSettings({ reset: true });
    const e2 = M.state().effective;
    ok(e2.text.join() === SEA && e2.image.join() === SCOUT, '选的、默认的全下架了 → 挑能用的里测评分最高的,不会空', e2);
    catalogNames = Object.keys(RAW);
    await M.refresh();
    ok(M.state().effective.text.join() === [GLM, DS, GEMMA].join(), '恢复默认后就是默认三个');
    const E = mk(new Database(':memory:'), { opts: { envTextModel: QWEN } });
    ok(E.state().defaults.text.join() === [QWEN, DS, GEMMA].join() && E.textModels()[0].id === QWEN, 'CF_AI_FIND_MODEL 换掉默认文字模型的第一个');
    ok(createAiModels({ opts: { envTextModel: '../evil' } }).state().defaults.text[0] === GLM, 'CF_AI_FIND_MODEL 格式不对 → 不理');
}

console.log('④ 改设置的校验');
{
    const err = (p) => { try { M.saveSettings(p); return ''; } catch (e) { return e.status + ' ' + e.message; } };
    ok(/^400 .*最多选 4 个/.test(err({ text: [GLM, DS, GEMMA, QWEN, SEA] })), '文字最多 4 个');
    ok(/^400 .*最多选 3 个/.test(err({ image: [DS, GEMMA, QWEN, SCOUT] })), '截图最多 3 个');
    ok(/^400 .*不在 Cloudflare 的模型列表/.test(err({ text: ['@cf/no/such'] })), '目录里没有的 → 拒绝');
    ok(/^400 .*不能用来截图找片/.test(err({ image: [GLM] })), '不认图的不能选截图');
    ok(/^400 .*不能用来文字找片/.test(err({ text: [CLAIRIC] })) && /^400 .*不能用来语音识别/.test(err({ asr: NOVA })) && /^400 .*不能用来语音识别/.test(err({ asr: GLM })), '非聊天模型 / 非 whisper 的语音 → 拒绝');
    ok(/^400 .*模型名不对/.test(err({ text: ['../x'] })) && /^400 .*要传模型名数组/.test(err({ text: GLM })), '名字不对 / 不是数组 → 拒绝');
    ok(M.state().settings.text.length === 0, '被拒的不会存一半');
    const r = M.saveSettings({ text: [OLD, GLM, GLM] });
    ok(r.warnings.length === 1 && /已过计划下架日期/.test(r.warnings[0]) && r.settings.text.join() === [OLD, GLM].join() && r.effective.text[0] === GLM, '过期的可以选但提示会被跳过;重复的去掉', r.warnings);
    M.saveSettings({ asr: '' });
    ok(M.asrModel() === WHISPER, 'asr 传空 = 用默认');
    // 重启:从库里读回
    const M2 = mk(db);
    const s = M2.state();
    ok(s.models.length === 14 && s.settings.text.join() === [OLD, GLM].join() && s.catalogAt === M.state().catalogAt, '重启后目录 / 设置从库里读回');
    M.saveSettings({ reset: true });
    ok(M.state().settings.text.length === 0 && M.state().settings.asr === '', 'reset 清掉所有选择');
    const mem = createAiModels({ db: () => null, accountId: ACC, token: TOKEN, fetchImpl: fakeFetch, now: () => t });
    await mem.refresh();
    ok(mem.saveSettings({ text: [QWEN] }).effective.text[0] === QWEN, '没 sqlite 也能用(只在内存)');
}

console.log('⑤ 打分评级 + 实测底 + 推荐');
{
    ok(letter(90) === 'S' && letter(89) === 'A' && letter(80) === 'A' && letter(65) === 'B' && letter(50) === 'C' && letter(49) === 'D', '字母:S≥90 A≥80 B≥65 C≥50');
    const g = gradeOf({ textTop1: 8, textTop3: 9, textN: 10, rec: 0.5, imgTop1: 3, imgTop3: 4, imgN: 6, latMedian: 2000, latImg: 7000 }, true);
    // 文字 100×(0.7×0.8 + 0.15×0.9 + 0.15×0.5)×0.95 = 73.15;截图 100×(0.8×0.5 + 0.2×0.667)×0.7 = 37.3
    ok(g.text.score === 73 && g.text.letter === 'B' && g.image.score === 37 && g.image.letter === 'D' && g.overall.score === 73, '公式:准确率 × 速度系数(≤1.5s 1、≤3s 0.95、≤6s 0.85、更慢 0.7)', g);
    ok(gradeOf({ textTop1: 1, textTop3: 1, textN: 1, imgTop1: 1, imgTop3: 1, imgN: 1 }, false).image === null, '不认图的没有截图分');
    const s = M.state();
    const gl = byName(s, GLM), ds = byName(s, DS), ge = byName(s, GEMMA);
    ok(gl.bench.source === 'seed' && gl.bench.textN === 22 && gl.bench.textTop1 === 22 && gl.grade.text.score === 100 && gl.grade.text.letter === 'S' && gl.grade.image === null, 'glm-5.3 实测底:原题 14 + 记错细节 8 条全对 → 100 S', gl.grade);
    ok(ds.bench.textTop1 === 20 && ds.bench.textN === 22 && ds.grade.text.score === 92 && ds.grade.image.score === 82 && ds.grade.image.letter === 'A', 'deepseek 实测底:文字 20/22 → 92,截图 8/10 → 82', ds.grade);
    ok(ge.grade.text.score === 72 && ge.grade.image.score === 40 && ge.bench.costPer1kText === 0.0324, 'gemma-4:文字 72、截图 40、每千次 $0.03', ge.grade);
    ok(/不是聊天模型/.test(byName(s, CLAIRIC).bench.notes) && byName(s, CLAIRIC).grade && byName(s, CLAIRIC).roles.length === 0, 'clairic 有分有说明,但不能选');
    ok(s.recommended.text === GLM && s.recommended.image === DS && s.recommended.asr === WHISPER, '推荐:文字 glm-5.3、截图 deepseek、语音 whisper-turbo', s.recommended);
    ok(s.recommended.value === SEA, '性价比:文字分 ≥75 里最便宜的(sea-lion 77 分 $0.12/千次)', s.recommended.value);
    ok(db.prepare("SELECT COUNT(*) c FROM ai_bench WHERE source = 'seed'").get().c === 12, '实测底写进 ai_bench(12 个)');
    ok(s.models[0].name === GLM, '列表按总分排');
}

console.log('⑥ 快速测评');
{
    const runs = [];
    let mode = 'ok', gate = null;
    const ANS = {   // 每题回什么(前面的排第一)
        '男主每次坐公交车都会爆炸,然后重新醒来': ['开端'],
        '女主坐公交车爆炸后一直循环': ['源代码', '开端'],                       // 前三
        '太阳要毁灭了,人类给地球装发动机推出太阳系,有太空电梯的那一部': ['流浪地球'],   // 错
        '推荐几部像《开端》一样的时间循环剧': ['明日边缘', '土拨鼠之日', 'Source Code', '叛逆者', '时光列车'],
    };
    const IMG_ANS = { '/3J8HmgR16MKX2iT71mB4EIDdV2x.jpg': ['繁花'], '/i4xRsWEAwGgL5wMm8jrBbxxXKEI.jpg': ['扫黑风暴', '狂飙'], '/2meX1nMdScFOoV4370rqHWKmXhY.jpg': ['辉耀之城'], '/dyJvKsNs2KP8qQnAXbRwDjblViy.jpg': ['神隐少女'] };
    const fakeAi = {
        run: async (model, body, ro) => {
            runs.push({ model, body, ro });
            if (gate) await gate;
            if (mode === 'gone') { const e = new Error('Model has been deprecated'); e.status = 410; throw e; }
            if (mode === 'quota') { const e = new Error('今天的 AI 调用次数用完了'); e.code = 'quota'; throw e; }
            const u = body.messages[1].content;
            let titles;
            if (Array.isArray(u)) {
                const img = Buffer.from(u[1].image_url.url.split(',')[1], 'base64').toString();
                const p = Object.keys(IMG_ANS).find((k) => img.includes(k));
                if (!p) { const e = new Error('AI 响应超时'); e.code = 'timeout'; throw e; }   // 星际穿越那张超时
                titles = IMG_ANS[p];
            } else titles = ANS[u] || [{ '宫斗剧,女主一开始很单纯后来当了太后': '后宫·甄嬛传', '老电影,男主在船上画女主,船后来沉了': 'Titanic' }[u] || CASES.text.find((c) => c.q === u).accept[0]];
            t += 1000;
            const json = { candidates: titles.map((x) => /[a-z]/i.test(x) ? { title: '某译名' + x, original_title: x } : { title: x }) };
            return { choices: [{ message: { content: '```json\n' + JSON.stringify(json) + '\n```' } }], usage: { prompt_tokens: 200, completion_tokens: 50 } };
        },
    };
    const B = mk(db, { ai: fakeAi });
    await B.refresh();
    const err = (n) => { try { B.queueBench(n); return ''; } catch (e) { return e.status + ' ' + e.message; } };
    ok(/最多测 6/.test(err([GLM, DS, GEMMA, QWEN, SEA, SCOUT, G47])) && /不在模型列表/.test(err(['@cf/no/such'])) && /不是能找片的模型/.test(err([WHISPER])) && /不是能找片/.test(err([CLAIRIC])) && /选几个/.test(err([])), '测评名单校验');
    const fetch0 = fetches.length;
    let open;
    gate = new Promise((r) => { open = r; });
    const st = B.queueBench([GEMMA, GLM, GEMMA]);
    ok(st.bench.running === GEMMA && st.bench.queue.join() === GLM && st.bench.progress.total === 17, '马上开始跑第一个、其余排队(重复的去掉);进度 = 10 文字 + 1 推荐 + 6 截图', st.bench);
    ok(/排队的测评太多/.test(err([QWEN, SEA, SCOUT, G47, OLD])) && B.state().bench.queue.join() === GLM, '排队加起来最多 6 个(超了整批不收)');
    gate = null; open();
    ok(await until(() => !B.state().bench.running && !B.state().bench.queue.length), '跑完');
    const s = B.state(), gb = byName(s, GEMMA).bench, lb = byName(s, GLM).bench;
    ok(s.bench.last.name === GLM && s.bench.last.ok && s.bench.progress === null, '一个一个跑完,last 是最后一个');
    ok(gb.source === 'quick' && gb.textN === 10 && gb.textTop1 === 8 && gb.textTop3 === 9, '文字:排第一 8、前三 9(公交车循环女主那条排第二、流浪地球答成第一部)', gb);
    ok(gb.rec === 0.75, '推荐:5 部里 3 部在时间循环片单里(英文原名也认)→ 0.75', gb.rec);
    ok(gb.imgN === 5 && gb.imgTop1 === 2 && gb.imgTop3 === 3 && gb.errors === 1, '截图:取不到的那张不算;繁花 / 神隐少女第一、狂飙第二、鱿鱼游戏错、星际穿越超时', gb);
    ok(gb.latText === 1000 && gb.latImg === 1000 && gb.latMedian === 1000 && gb.latP90 === 1000 && gb.costPer1kText === 0.035, '延迟中位 / p90、每千次花费(200 入 50 出 × 目录价)', gb);
    ok(/快速测评:文字 8\/10 排第一、推荐对 3 部;截图 2\/5;出错 1 次/.test(gb.notes), '说明', gb.notes);
    ok(lb.textN === 10 && lb.textTop1 === 8 && lb.imgN === 0 && byName(s, GLM).grade.image === null, '不认图的只测文字');
    const gRuns = runs.filter((r) => r.model === GEMMA), lRuns = runs.filter((r) => r.model === GLM);
    ok(gRuns.length === 16 && lRuns.length === 11, '不认图的不发截图题;取不到的图不调用模型', [gRuns.length, lRuns.length]);
    ok(gRuns[0].body.messages[0].content === SYS && gRuns[0].body.temperature === 0.2 && gRuns[0].body.chat_template_kwargs.enable_thinking === false && gRuns[0].ro.timeoutMs === 40000, '同线上一样的提示词 + 这个模型的调用参数,每题 40 秒超时');
    ok(lRuns[0].body.reasoning_effort === 'low' && lRuns[0].body.max_tokens === 3000, 'glm 用 low + 3000');
    const imgRun = gRuns.find((r) => Array.isArray(r.body.messages[1].content));
    ok(imgRun.body.messages[1].content[0].text === '帮我找下这个是哪个电影或者电视剧' && /^data:image\/jpeg;base64,/.test(imgRun.body.messages[1].content[1].image_url.url), '截图题:默认问句 + base64 图');
    ok(fetches.slice(fetch0).filter((f) => /img\.test/.test(f.url)).length === 6 && fetches.slice(fetch0).every((f) => !/\/\//.test(f.url.replace('https://', ''))), '6 张图各取一次(地址不重复斜杠)');
    ok(db.prepare('SELECT source FROM ai_bench WHERE name = ?').get(GEMMA).source === 'quick', '快速测评覆盖实测底,存库');
    ok(mk(db).state().models.find((x) => x.name === GEMMA).bench.source === 'quick', '重启后实测底不会盖掉快速测评');
    // 第二个认图模型:图用缓存
    const f1 = fetches.length;
    B.queueBench([QWEN]);
    await until(() => !B.state().bench.running);
    ok(fetches.slice(f1).filter((f) => /img\.test/.test(f.url)).length === 1, '图取过的用缓存(只有取不到的那张再试)');
    // 模型调不了 / 额度用完
    mode = 'gone';
    const before = JSON.stringify(byName(B.state(), SCOUT).bench);
    B.queueBench([SCOUT]);
    await until(() => !B.state().bench.running);
    ok(B.state().bench.last.ok === false && /410/.test(B.state().bench.last.error) && JSON.stringify(byName(B.state(), SCOUT).bench) === before && runs.filter((r) => r.model === SCOUT).length === 1, '第一题就 4xx → 这个模型测评失败,不动旧分数,不继续打', B.state().bench.last);
    mode = 'quota';
    B.queueBench([SEA, G47]);
    await until(() => !B.state().bench.running && !B.state().bench.queue.length);
    ok(B.state().bench.last.name === SEA && !B.state().bench.last.ok && B.state().bench.queue.length === 0 && !runs.some((r) => r.model === G47), '额度用完 → 整个队列停');
    mode = 'ok';
    const noImg = mk(new Database(':memory:'), { ai: fakeAi, imageBase: '' });
    await noImg.refresh();
    noImg.queueBench([DS]);
    await until(() => !noImg.state().bench.running);
    ok(/没配 TMDB,截图没测/.test(byName(noImg.state(), DS).bench.notes) && byName(noImg.state(), DS).bench.imgN === 0, '没配 TMDB 图片地址 → 只测文字');
}

console.log('⑦ ai-find / cf-ai 每次请求现取');
{
    const used = [];
    const ai = { run: async (model, body) => { used.push({ model, body }); return { choices: [{ message: { content: '{"candidates":[{"title":"开端","year":2022,"confidence":0.9}]}' } }] }; } };
    const F = createAiFind({ ai, opts: { textModels: () => M.textModels(), imageModels: () => M.imageModels() } });
    await F.find({ q: '公交车爆炸' });
    ok(used[0].model === GLM && used[0].body.reasoning_effort === 'low', '默认先问 glm-5.3');
    M.saveSettings({ text: [QWEN], image: [GEMMA] });
    await F.find({ q: '公交车爆炸' });
    ok(used.length === 2 && used[1].model === QWEN && used[1].body.max_tokens === 3000, '后台改了文字模型 → 下一次请求就用新的(缓存按主模型分开)');
    await F.find({ q: '', image: 'data:image/png;base64,AAAA' });
    ok(used[2].model === GEMMA && used[2].body.chat_template_kwargs.enable_thinking === false, '截图同样现取');
    const bad = createAiFind({ ai, opts: { textModels: () => { throw new Error('x'); } } });
    await bad.find({ q: 'y' });
    ok(used[3].model === GLM, '取模型出错 → 内置默认');
    M.saveSettings({ reset: true });

    const calls = [];
    let cur = '';
    const cf = createCfAi({ accountId: ACC, token: TOKEN, opts: { asrModel: () => cur }, fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ success: true, result: { text: '繁花' } }) }; } });
    await cf.transcribe('UklGRg==');
    ok(/whisper-large-v3-turbo$/.test(calls[0].url) && calls[0].body.audio === 'UklGRg==', '语音模型没选 → whisper-large-v3-turbo,base64');
    cur = W1;
    await cf.transcribe('UklGRg==');
    ok(/\/openai\/whisper$/.test(calls[1].url) && JSON.stringify(calls[1].body.audio) === JSON.stringify([...Buffer.from('UklGRg==', 'base64')]), '换成老 whisper → 现取,音频按字节数组发');
}

console.log('⑧ server.js 接线');
{
    ok(/let aiModels = null;\nconst cfAi = require\('\.\/lib\/cf-ai'\)\.createCfAi\(/.test(SERVER) && /asrModel: \(\) => \(aiModels \? aiModels\.asrModel\(\) : ''\)/.test(SERVER), 'cf-ai 的语音模型从 aiModels 现取');
    ok(/if \(cfAi\.enabled\(\)\) \{\n    try \{[\s\S]{0,400}require\('\.\/lib\/ai-models'\)\.createAiModels\(\{\n            db: \(\) => REQ_DB_OK\(\) \? cacheManager\.db : null,/.test(SERVER) && /aiModels\.start\(\);/.test(SERVER), '配了 Workers AI 才建 aiModels(db 用闭包)并 start');
    ok(/opts: aiModels \? \{ textModels: \(\) => aiModels\.textModels\(\), imageModels: \(\) => aiModels\.imageModels\(\) \}/.test(SERVER), 'ai-find 传的是函数');
    for (const [m, p] of [['get', '/api/admin/ai'], ['post', '/api/admin/ai/refresh'], ['post', '/api/admin/ai/settings'], ['post', '/api/admin/ai/bench']]) {
        const i = SERVER.indexOf(`app.${m}('${p}',`);
        const body = i >= 0 ? SERVER.slice(i, i + 400) : '';
        ok(i >= 0 && /adminAuthed\(req\)|aiAdminGuard\(req, res\)/.test(body), `${m.toUpperCase()} ${p}:要站长令牌`);
    }
    ok(/function aiAdminGuard\(req, res\) \{\n    res\.set\('Cache-Control', 'no-store'\);\n    if \(!adminAuthed\(req\)\)/.test(SERVER) && /app\.get\('\/api\/admin\/ai', \(req, res\) => \{\n    res\.set\('Cache-Control', 'no-store'\);/.test(SERVER), '后台 AI 接口都不缓存');
    ok(/enabled: cfAi\.enabled\(\), usage: cfAi\.usage\(\)/.test(SERVER), 'GET 带 enabled 和今天的调用次数');
}

console.log('⑨ 系列总评 + 新版本按同系列估计');
{
    const { familyOf, FAMILIES } = require(path.join(ROOT, 'lib/ai-models/families'));
    const fk = (n) => familyOf(n).key;
    ok(fk(GLM) === 'glm' && fk(DS) === 'deepseek-flash' && fk('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b') === 'deepseek' && fk(GEMMA) === 'gemma' && fk(SEA) === 'sea-lion'
        && fk(QWEN) === 'qwen' && fk(SCOUT) === 'llama' && fk(CLAIRIC) === 'clairic' && fk(WHISPER) === 'whisper' && fk(NOVA) === 'deepgram' && fk(LLAVA) === 'vision-small' && fk('@cf/new/model-x') === 'other',
        '系列归类(SEA-LION 先于 Gemma、Flash 先于其它 DeepSeek)');
    ok(FAMILIES.every((f) => f.label && f.verdict && f.reason && [1, 2, 3].includes(f.tier)), '每个系列都有名字、定位、理由、梯队');
    ok(fk('@cf/qwen/qwen2.5-coder-32b-instruct') === 'coder' && fk('@cf/deepseek-ai/deepseek-math-7b-instruct') === 'coder' && fk('@cf/meta/codellama-7b') === 'coder', '写代码 / 做题的专用版单独一类(不按同系列聊天模型估)');
    // 新版本:同系列里有实测的 → 按实测最好的估计;一个都没测过 → 按系列表的估计分;都不是 → 没分
    const NEW_GLM = '@cf/zai-org/glm-5.4', NEW_QWEN = '@cf/qwen/qwen4-30b', KIMI = '@cf/moonshotai/kimi-k3';
    RAW[NEW_GLM] = { task: 'Text Generation', props: [tok(1.5, 4.5)] };
    RAW[NEW_QWEN] = { task: 'Text Generation', props: [...P({ vision: 'true' }), tok(0.5, 3)] };
    RAW[KIMI] = { task: 'Text Generation', props: [tok(0.6, 2.5)] };
    catalogNames = Object.keys(RAW);
    await M.refresh();
    const s = M.state();
    const g5 = byName(s, NEW_GLM), q4 = byName(s, NEW_QWEN), k3 = byName(s, KIMI);
    ok(g5.bench === null && g5.grade.estimated && g5.grade.from === GLM && g5.grade.text.score === byName(s, GLM).grade.text.score && g5.family.verdict === '文字找片首选',
        '没测过的 glm-5.4:按同系列 glm-5.3 的实测估计,标「估计」', g5.grade);
    ok(q4.grade.estimated && q4.grade.from === QWEN && q4.grade.image, 'qwen 新版本(能看图):文字 / 截图都按 qwen3.8 估计', q4.grade);
    ok(k3.grade.estimated && k3.grade.from === '' && k3.grade.text.score === 70 && k3.grade.text.letter === 'B', '系列里一个都没测过(Kimi):用系列表的估计分', k3.grade);
    ok(byName(s, '@cf/new/model-x').grade === null && byName(s, '@cf/new/model-x').family.key === 'other', '认不出系列的新模型:没分,提示去测');
    ok(!byName(s, GLM).grade.estimated && byName(s, GLM).family.reason.includes('8/8'), '测过的用实测,带系列理由');
    ok(s.recommended.text === GLM, '推荐只看实测分(估计分不抢推荐)');
    const fam = s.families;
    ok(fam.length >= 8 && fam[0].tier === 1 && fam[fam.length - 1].key === 'other' && fam[fam.length - 2].tier === 3 && fam.findIndex((f) => f.key === 'glm') < fam.findIndex((f) => f.key === 'gemma')
        && fam.findIndex((f) => f.key === 'gemma') < fam.findIndex((f) => f.key === 'llama'), '系列总评按 首选 → 后备 → 不推荐 排,认不出系列的「其它」垫底', fam.map((f) => f.key));
    const fg = fam.find((f) => f.key === 'glm');
    ok(fg.best && fg.best.name === GLM && fg.best.letter === 'S' && fg.models.includes(NEW_GLM), '系列里列出成员和实测最好的那个');
    delete RAW[NEW_GLM]; delete RAW[NEW_QWEN]; delete RAW[KIMI];
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
