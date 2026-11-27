'use strict';
// ✨ AI 找片:用户描述剧情 / 演员 / 台词 / 画面,或者上传截图问「这是哪部」,也可以让它推荐类似的。
//   Workers AI 给候选片名 → 逐个到 TMDB 核实(对上片名 + 年份才算;编出来的片名在这里被筛掉),带上海报 / 简介 / 年份回给前端,
//   前端点了照常 autoSearch 去资源站搜线路。
//
// createAiFind({ ai, tmdbGet, log?, now?, opts? })
//   ai       lib/cf-ai 实例(run(model, body))
//   tmdbGet  async (path, params) → TMDB JSON 或 null(没配 TMDB 时 → 不核实,原样回片名)
//   opts.textModels / opts.imageModels  [{ id, extra, maxTokens }],也可以是返回这种数组的函数(每次请求现取:
//            站长后台「AI 模型」页改了顺序不用重启,见 lib/ai-models)
// → { find({ q, image }) → { items, unverified, model, ms, cached } }
//
// 模型(2026-11-26 实测,见 ai-model-choice):
//   文字 → glm-5.3(reasoning low;用户记错细节的说法 8/8 排第一,中位 1.6 秒,~$0.45/千次)
//          deepseek-v4.1-flash 不开思考只有 6/8(「男主坐公交车爆炸」排出源代码),开思考又慢到 6~25 秒
//   截图 → deepseek-v4.1-flash(glm 不认图;截图 8/10,~1.4 秒,~$0.22/千次)
//   Workers AI 的模型下架很快(qwen3-30b 2026-11-20 下架直接 410):主模型 4xx 就按顺序换备用。
const DEF = Object.freeze({
    textModels: [
        { id: '@cf/zai-org/glm-5.3', extra: { reasoning_effort: 'low' }, maxTokens: 3000 },
        { id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', extra: { reasoning_effort: 'none' } },
        { id: '@cf/google/gemma-4-26b-a4b-it', extra: { chat_template_kwargs: { enable_thinking: false } } },
    ],
    imageModels: [
        { id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', extra: { reasoning_effort: 'none' } },
        { id: '@cf/google/gemma-4-26b-a4b-it', extra: { chat_template_kwargs: { enable_thinking: false } } },
    ],
    maxCandidates: 6, maxTokens: 700, timeoutMs: 25000, tmdbConcurrency: 6, cacheMs: 3600e3, cacheMax: 300,
});
const SYS = '你是影视识别助手。用户会描述想找的电影 / 电视剧 / 动漫 / 综艺 / 纪录片(剧情、演员、台词、画面都可能),'
    + '或者上传截图问是哪部,也可能请你推荐类似的作品。只输出 JSON,不要任何别的文字:'
    + '{"candidates":[{"title":"中文片名(中国大陆通用译名)","original_title":"原名","year":2023,"type":"movie|tv|anime|variety|doc","confidence":0.9,"reason":"一句话说明为什么是它(不超过 30 字)"}]}。'
    + '用户的记忆常有偏差(主角性别、演员、年份、细节记混),以核心情节和标志性设定 / 画面为准:核心情节对得上的就排第一,不要因为细节对不上把它排到后面。'
    + '给 3~6 个候选,最可能的排第一(只有百分之百确定时才可以只给 1 个);只写真实存在的作品,不要编造片名。推荐类的问题给 5~6 部真实作品。';

const norm = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// 发给模型的请求体 —— AI 找片和站长后台的快速测评共用,测的就是线上这一套
function requestBody(m, q, image, maxTokens) {
    const userText = q || '帮我找下这个是哪个电影或者电视剧';
    const content = image ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: image } }] : userText;
    return Object.assign({
        messages: [{ role: 'system', content: SYS }, { role: 'user', content }],
        max_tokens: (m && m.maxTokens) || maxTokens || DEF.maxTokens, temperature: 0.2,
    }, (m && m.extra) || {});
}
// 模型回的文字(OpenAI 式 choices 或 Workers AI 老式 response)
function replyText(r) {
    const msg = r && r.choices && r.choices[0] && r.choices[0].message;
    return (msg && msg.content) || (r && r.response) || '';
}
const yearOf = (r) => Number(String((r && (r.release_date || r.first_air_date)) || '').slice(0, 4)) || 0;

// 模型输出 → 候选数组(去掉 ``` 围栏 / <think> 段;只给了数组也认)
function parseCandidates(text, max) {
    let s = String(text == null ? '' : (typeof text === 'object' ? JSON.stringify(text) : text));
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
    let j = null;
    try { j = JSON.parse(s); } catch (e) {
        const a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a >= 0 && b > a) { try { j = JSON.parse(s.slice(a, b + 1)); } catch (e2) { /* 下面再试数组 */ } }
        if (!j) { const c = s.indexOf('['), d = s.lastIndexOf(']'); if (c >= 0 && d > c) { try { j = JSON.parse(s.slice(c, d + 1)); } catch (e3) { /* 放弃 */ } } }
    }
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.candidates) ? j.candidates : []);
    const out = [], seen = new Set();
    for (const x of list) {
        if (!x || typeof x !== 'object') continue;
        const title = String(x.title || x.name || '').trim().slice(0, 60);
        const k = norm(title);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        const y = Number(x.year);
        out.push({
            title, original_title: String(x.original_title || x.original || '').trim().slice(0, 80),
            year: y >= 1900 && y <= 2100 ? Math.round(y) : 0,
            type: /^(movie|tv|anime|variety|doc)$/.test(String(x.type)) ? String(x.type) : '',
            confidence: x.confidence == null || x.confidence === '' || !Number.isFinite(Number(x.confidence)) ? null : Math.max(0, Math.min(1, Number(x.confidence))),   // 没给 = null(不当成没把握)
            reason: String(x.reason || '').trim().slice(0, 60),
        });
        if (out.length >= (max || DEF.maxCandidates)) break;
    }
    return out;
}

// TMDB 搜索结果里挑和候选对得上的那条:片名完全一样 3 分;互相包含 1.5 分(还得年份对上才过线);
//   年份差 ≤1 +2、差 >3 −2;电影 / 剧集类型对 +0.5;投票多的略加分。≥ 3 分才算核实
function pickTmdb(results, c) {
    const want = [c.title, c.original_title].map(norm).filter(Boolean);
    let best = null, bestScore = 0;
    for (const r of Array.isArray(results) ? results : []) {
        if (!r || (r.media_type !== 'movie' && r.media_type !== 'tv')) continue;
        const names = [r.title, r.name, r.original_title, r.original_name].map(norm).filter(Boolean);
        let s;
        if (names.some((n) => want.includes(n))) s = 3;
        else if (names.some((n) => want.some((w) => Math.min(w.length, n.length) >= 2 && (n.includes(w) || w.includes(n))))) s = 1.5;
        else continue;
        const y = yearOf(r);
        if (c.year && y) { const d = Math.abs(y - c.year); if (d <= 1) s += 2; else if (d > 3) s -= 2; }
        if (c.type && ((c.type === 'movie') === (r.media_type === 'movie') || c.type === 'anime' || c.type === 'doc')) s += 0.5;
        s += Math.min(1, (Number(r.vote_count) || 0) / 500) * 0.5;
        if (s > bestScore) { bestScore = s; best = r; }
    }
    return bestScore >= 3 ? best : null;
}

function createAiFind(o) {
    const opts = Object.assign({}, DEF, (o && o.opts) || {});
    const log = (o && o.log) || (() => { });
    const now = (o && o.now) || Date.now;
    const cache = new Map();
    // 模型列表:数组或函数(每次请求现取);取不到 / 空的 → 内置默认
    const listOf = (v, def) => {
        let x = v;
        if (typeof v === 'function') { try { x = v(); } catch (e) { log('取模型列表失败:', e.message); x = null; } }
        return Array.isArray(x) && x.length ? x : def;
    };

    // 从第 from 个模型开始问;模型本身不可用(4xx)就顺延到下一个。返回用到的是第几个
    async function ask(q, image, from, models) {
        let lastErr = null;
        for (let i = from || 0; i < models.length; i++) {
            const m = models[i];
            try {
                const r = await o.ai.run(m.id, requestBody(m, q, image, opts.maxTokens), { timeoutMs: opts.timeoutMs });
                return { model: m.id, idx: i, cands: parseCandidates(replyText(r), opts.maxCandidates) };
            } catch (e) {
                lastErr = e;
                // 只有模型本身不可用(下架 / 不存在 / 参数不收)才换备用;超时、超额、5xx 直接报错
                if (!(e.status >= 400 && e.status < 500 && e.status !== 429) || i === models.length - 1) throw e;
                log(`${m.id} 不可用(${e.status} ${e.message}),换 ${models[i + 1].id}`);
            }
        }
        throw lastErr;
    }

    async function verify(c) {
        const tries = [c.title, c.original_title].filter((t, i, a) => t && a.indexOf(t) === i);
        for (const query of tries) {
            let d = null;
            try { d = await o.tmdbGet('/search/multi', { query, language: 'zh-CN', include_adult: 'false', page: 1 }); } catch (e) { d = null; }
            const r = d && pickTmdb(d.results, c);
            if (r) return r;
        }
        return null;
    }

    // 候选 → 到 TMDB 核实(并发),核实到的带海报 / 简介;同一部只留一个
    async function verifyAll(cands) {
        const items = [], unverified = [], seen = new Set();
        const canVerify = typeof o.tmdbGet === 'function';
        let next = 0;
        const res = new Array(cands.length);
        await Promise.all(Array.from({ length: Math.min(opts.tmdbConcurrency, cands.length) }, async () => {
            while (next < cands.length) { const i = next++; res[i] = canVerify ? await verify(cands[i]) : null; }
        }));
        cands.forEach((c, i) => {
            const r = res[i];
            if (!r) { unverified.push({ title: c.title, original: c.original_title, year: c.year, reason: c.reason }); return; }
            const id = r.media_type + ':' + r.id;
            if (seen.has(id)) return;
            seen.add(id);
            items.push({
                title: r.title || r.name || c.title, original: r.original_title || r.original_name || c.original_title,
                year: yearOf(r) || c.year, media: r.media_type, type: c.type, poster: r.poster_path || '', backdrop: r.backdrop_path || '',
                overview: String(r.overview || '').slice(0, 160), reason: c.reason, tmdb: r.id, rating: Number(r.vote_average) || 0,
            });
        });
        return { items, unverified: canVerify ? unverified : unverified.map((x) => Object.assign(x, { noCheck: true })) };
    }

    // 模型偶尔胡答(实测 glm-5.3 三次里有一次只回一部不相干的、confidence 0):没候选 / 全都没把握 / 一部都核实不到 → 换下一个模型再问一次
    const weak = (cands, items, canVerify) => !cands.length || cands.every((c) => c.confidence != null && c.confidence < 0.15) || (canVerify && !items.length);

    async function find(input) {
        const q = String((input && input.q) || '').trim().slice(0, 300), image = (input && input.image) || '';
        if (!q && !image) throw new Error('说说想找什么,或者传一张截图');
        // 这次请求用的模型顺序一次取定(中途后台改了也不影响这一次);缓存按主模型分开,换了模型不吃旧答案
        const models = image ? listOf(opts.imageModels, DEF.imageModels) : listOf(opts.textModels, DEF.textModels);
        const key = image ? '' : models[0].id + '|' + norm(q);
        const hit = key && cache.get(key);
        if (hit && now() - hit.at < opts.cacheMs) return Object.assign({}, hit.v, { cached: true });
        const t0 = now();
        const canVerify = typeof o.tmdbGet === 'function';
        let a = await ask(q, image, 0, models);
        let got = await verifyAll(a.cands);
        let retried = false;
        if (weak(a.cands, got.items, canVerify) && a.idx + 1 < models.length) {
            retried = true;
            log(`${a.model} 的回答没用(候选 ${a.cands.length} 个、核实到 ${got.items.length} 个),换 ${models[a.idx + 1].id} 再问`);
            try {
                const b = await ask(q, image, a.idx + 1, models);
                const gb = await verifyAll(b.cands);
                if (gb.items.length > got.items.length || (gb.items.length === got.items.length && !weak(b.cands, gb.items, canVerify))) { a = b; got = gb; }
            } catch (e) { log('重问失败:', e.message); }
        }
        const v = { items: got.items, unverified: got.unverified, model: a.model, retried, ms: now() - t0 };
        if (key) {
            if (cache.size >= opts.cacheMax) cache.delete(cache.keys().next().value);
            cache.set(key, { v, at: now() });
        }
        return v;
    }

    return { find };
}

module.exports = { createAiFind, parseCandidates, pickTmdb, requestBody, replyText, norm, SYS };
