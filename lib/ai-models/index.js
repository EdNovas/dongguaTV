'use strict';
// 🤖 Workers AI 模型管理(站长后台「AI 模型」页):
//   · 模型目录:启动 60 秒后同步一次 Cloudflare 的模型列表,之后每 24 小时一次(后台可以手动刷新)。
//     只留 文字生成 / 看图 / 语音转文字 三类;新上的标「新」,目录里没了的标「已下架」,过了计划下架日期的标「已过期」。
//   · 选模型:站长可以手动排 AI 找片的文字模型(≤4 个)、截图模型(≤3 个)顺序,选语音识别模型;存 cache.db(没 sqlite 就只在内存)。
//     选了的模型下架 / 过期 → 自动跳过,后面再补上默认模型兜底,AI 找片永远有模型可用(lib/ai-find 每次请求现取)。
//   · 测评:2026-11-26 实测的结果当底(bench-seed.json);后台点「快速测评」跑 10 条文字 + 1 条推荐 + 6 张截图(bench-cases.json),
//     用的是线上 AI 找片同一套提示词和解析,一次只跑一个、排队最多 6 个。按 准确率 × 速度 打分,给每个用途推荐一个模型。
//
// createAiModels({ db, ai, accountId, token, fetchImpl?, imageBase?, log?, now?, opts? })
//   db         () => better-sqlite3 实例或 null(调用时才取,server.js 里 REQ_DB_OK 构造时还在 TDZ)
//   ai         lib/cf-ai 实例(测评用 run)
//   imageBase  截图测评取 TMDB 剧照的前缀,如 https://image.tmdb.org/t/p/w780(没给就不测截图)
//   opts.envTextModel  CF_AI_FIND_MODEL:换掉默认文字模型的第一个
// → { start, stop, refresh, state, saveSettings, queueBench, textModels, imageModels, asrModel }
const { parseCandidates, requestBody, replyText, norm } = require('../ai-find');
const SEED = require('./bench-seed.json');
const { familyOf, OTHER: FAM_OTHER, pub: famPub } = require('./families');
const CASES = require('./bench-cases.json');

const API = 'https://api.cloudflare.com/client/v4/accounts/';
const TASKS = ['Text Generation', 'Image-to-Text', 'Automatic Speech Recognition'];
const MODEL_RE = /^@cf\/[\w.-]+\/[\w.-]+$/;
const GLM = '@cf/zai-org/glm-5.3', DS = '@cf/deepseek-ai/deepseek-v4.1-flash-1017', GEMMA = '@cf/google/gemma-4-26b-a4b-it', WHISPER = '@cf/openai/whisper-large-v3-turbo';
// 实测过的调用参数,比按目录推出来的准
const OVERRIDE = {
    [GLM]: { extra: { reasoning_effort: 'low' }, maxTokens: 3000 },          // 思考关不掉,low 几乎不思考
    [DS]: { extra: { reasoning_effort: 'none' }, maxTokens: 700 },
    [GEMMA]: { extra: { chat_template_kwargs: { enable_thinking: false } }, maxTokens: 700 },
};
// 目录里算「文字生成」但不是聊天模型:clairic / clef 是结构化抽取 / 选择题模型,llama-guard 是审核分类;AI 找片调用不了
const NOT_CHAT = /^@cf\/cloudflare\/(clairic|clef)|llama-guard/;
const LIMIT = { text: 4, image: 3 };
const ROLE_LABEL = { text: '文字找片', image: '截图找片', asr: '语音识别' };
const DEF = Object.freeze({
    firstDelayMs: 60e3, intervalMs: 24 * 3600e3, fetchTimeoutMs: 20000, maxPages: 20,
    benchTimeoutMs: 40000, queueMax: 6, newDays: 7, envTextModel: '',
});
const cnDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const T = (v) => v === true || v === 'true';
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const clone = (x) => JSON.parse(JSON.stringify(x));
const uniq = (a) => a.filter((x, i) => x && a.indexOf(x) === i);
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const p90 = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)]); };
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const r4 = (x) => x == null ? null : Math.round(x * 1e4) / 1e4;

// 目录原始条目 → { name, task, desc, props };不是那三类的、名字不对的 → null
function parseRaw(raw) {
    if (!raw || typeof raw.name !== 'string' || !MODEL_RE.test(raw.name)) return null;
    const task = raw.task && raw.task.name;
    if (!TASKS.includes(task)) return null;
    const props = {};
    for (const p of Array.isArray(raw.properties) ? raw.properties : []) {
        if (p && typeof p.property_id === 'string' && p.property_id !== '__proto__') props[p.property_id] = p.value;
    }
    return { name: raw.name, task, desc: String(raw.description || '').slice(0, 200), props };
}

// 聊天模型怎么调:实测表优先;支持 reasoning_effort none → 关思考;只到 low → low(要多给 token);
//   有思考但没有 effort 档位 → chat_template_kwargs 关思考;都没有 → 原样
function requestFor(name, efforts, reasoning) {
    if (OVERRIDE[name]) return clone(OVERRIDE[name]);
    const e = Array.isArray(efforts) ? efforts : [];
    if (e.includes('none')) return { extra: { reasoning_effort: 'none' }, maxTokens: 700 };
    if (e.includes('low')) return { extra: { reasoning_effort: 'low' }, maxTokens: 3000 };
    if (reasoning) return { extra: { chat_template_kwargs: { enable_thinking: false } }, maxTokens: 700 };
    return { extra: {}, maxTokens: 700 };
}

// 目录属性 → 列表里显示的字段(价格:美元 / 百万 token、美元 / 分钟音频)
function derive(name, task, info) {
    const p = (info && info.props) || {};
    const re = p.reasoning_effort && typeof p.reasoning_effort === 'object' ? p.reasoning_effort : null;
    const efforts = re && Array.isArray(re.supported_efforts) ? re.supported_efforts.map(String) : [];
    const price = { in: null, out: null, minute: null };
    for (const x of Array.isArray(p.price) ? p.price : []) {
        const u = String((x && x.unit) || '').toLowerCase(), v = Number(x && x.price);
        if (!Number.isFinite(v)) continue;
        if (u === 'per m input tokens') price.in = v;
        else if (u === 'per m output tokens') price.out = v;
        else if (/^per audio minute/.test(u)) { if (!/websocket/.test(u) || price.minute == null) price.minute = v; }   // 有普通的就不用 websocket 的
    }
    const vision = T(p.vision) || task === 'Image-to-Text';
    const reasoning = T(p.reasoning) || efforts.length > 0;
    const roles = [];
    if (task === 'Text Generation' && !NOT_CHAT.test(name)) { roles.push('text'); if (vision) roles.push('image'); }
    if (task === 'Image-to-Text') roles.push('image');
    // 语音只认 whisper 一家(deepgram 的请求格式不一样,lib/cf-ai 调不了)
    if (task === 'Automatic Speech Recognition' && /^@cf\/openai\/whisper/.test(name)) roles.push('asr');
    const dep = String(p.planned_deprecation_date || '');
    return {
        desc: String((info && info.desc) || '').slice(0, 200),
        hosted: T(p.partner) ? 'partner' : 'cloudflare',
        vision, reasoning, efforts, ctx: Number(p.context_window) || 0, price,
        paidOnly: T(p.require_workers_paid), beta: T(p.beta),
        deprecation: /^\d{4}-\d{2}-\d{2}$/.test(dep) ? dep : '',
        roles,
        request: roles.includes('text') || roles.includes('image') ? requestFor(name, efforts, reasoning) : null,
    };
}

// 打分:文字 = 70% 第一名命中 + 15% 前三命中 + 15% 推荐;截图 = 80% 第一 + 20% 前三;再乘速度系数
const speed = (ms) => ms == null || !Number.isFinite(Number(ms)) ? 1 : ms <= 1500 ? 1 : ms <= 3000 ? 0.95 : ms <= 6000 ? 0.85 : 0.7;
const letter = (s) => s >= 90 ? 'S' : s >= 80 ? 'A' : s >= 65 ? 'B' : s >= 50 ? 'C' : 'D';
const mark = (s) => { const v = Math.round(s); return { score: v, letter: letter(v) }; };
function gradeOf(b, vision) {
    if (!b) return null;
    const text = b.textN > 0 ? mark(100 * (0.7 * b.textTop1 / b.textN + 0.15 * b.textTop3 / b.textN + 0.15 * (Number(b.rec) || 0)) * speed(b.latMedian)) : null;
    const image = vision && b.imgN > 0 ? mark(100 * (0.8 * b.imgTop1 / b.imgN + 0.2 * b.imgTop3 / b.imgN) * speed(b.latImg != null ? b.latImg : b.latMedian)) : null;
    if (!text && !image) return null;
    const best = Math.max(text ? text.score : -1, image ? image.score : -1);
    return { text, image, overall: { score: best, letter: letter(best) } };
}

function createAiModels(o) {
    const opts = Object.assign({}, DEF, (o && o.opts) || {});
    const getDb = (o && o.db) || (() => null);
    const ai = o && o.ai;
    const accountId = String((o && o.accountId) || '').trim(), token = String((o && o.token) || '').trim();
    const doFetch = (o && o.fetchImpl) || ((...a) => fetch(...a));
    const imageBase = String((o && o.imageBase) || '').replace(/\/$/, '');
    const log = (o && o.log) || (() => { });
    const now = (o && o.now) || Date.now;
    const DEFAULTS = {
        text: uniq([MODEL_RE.test(opts.envTextModel || '') ? opts.envTextModel : GLM, DS, GEMMA]),
        image: [DS, GEMMA],
        asr: WHISPER,
    };

    const catalog = new Map();        // name → { name, task, info, first_seen, last_seen, gone }
    const bench = new Map();          // name → 测评结果(含 at / source)
    let settings = { text: [], image: [], asr: '' };
    let meta = { firstSync: 0, catalogAt: 0 };
    let catalogErr = '';
    let loaded = false, tablesFor = null, syncing = null, stopped = false, timers = [];
    let running = null, progress = null, last = null, looping = false;
    const queue = [];
    let ver = 0, memo = null;
    const bump = () => { ver++; memo = null; };
    const imgCache = new Map();

    // ---------- 存储 ----------
    function dbx() {
        let d = null;
        try { d = getDb(); } catch (e) { return null; }
        if (!d) return null;
        if (tablesFor !== d) {
            try {
                d.exec(`CREATE TABLE IF NOT EXISTS ai_models (name TEXT PRIMARY KEY, task TEXT, info TEXT, first_seen INTEGER, last_seen INTEGER, gone INTEGER DEFAULT 0);
                    CREATE TABLE IF NOT EXISTS ai_bench (name TEXT PRIMARY KEY, at INTEGER, source TEXT, result TEXT);
                    CREATE TABLE IF NOT EXISTS ai_settings (k TEXT PRIMARY KEY, v TEXT);`);
            } catch (e) { log('建表失败:', e.message); return null; }
            tablesFor = d;
        }
        return d;
    }
    const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
    function putSetting(k, v) {
        const d = dbx();
        if (!d) return;
        try { d.prepare('INSERT INTO ai_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v)); }
        catch (e) { log('存设置失败:', e.message); }
    }
    function putBench(name, b) {
        const d = dbx();
        if (!d) return;
        try { d.prepare('INSERT INTO ai_bench (name, at, source, result) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at, source = excluded.source, result = excluded.result').run(name, b.at, b.source, JSON.stringify(b)); }
        catch (e) { log('存测评失败:', e.message); }
    }
    function putModels(rows) {
        const d = dbx();
        if (!d) return;
        try {
            const st = d.prepare(`INSERT INTO ai_models (name, task, info, first_seen, last_seen, gone) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET task = excluded.task, info = excluded.info, first_seen = excluded.first_seen, last_seen = excluded.last_seen, gone = excluded.gone`);
            d.transaction((list) => { for (const m of list) st.run(m.name, m.task, JSON.stringify(m.info), m.first_seen, m.last_seen, m.gone ? 1 : 0); })(rows);
        } catch (e) { log('存模型目录失败:', e.message); }
    }

    // 第一次用到时从库里读回来,再补上实测底(库里没有这个模型的测评、或只有更旧的底才写)
    function ensureLoaded() {
        if (loaded) return;
        try { getDb(); } catch (e) { return; }   // 库还没初始化好(server.js 启动中)→ 下次用到再读,别当成没有库
        loaded = true;
        const d = dbx();
        if (d) {
            try {
                for (const r of d.prepare('SELECT name, task, info, first_seen, last_seen, gone FROM ai_models').all()) {
                    catalog.set(r.name, { name: r.name, task: r.task, info: J(r.info, {}), first_seen: r.first_seen || 0, last_seen: r.last_seen || 0, gone: r.gone ? 1 : 0 });
                }
                for (const r of d.prepare('SELECT name, at, source, result FROM ai_bench').all()) {
                    const b = J(r.result, null);
                    if (b && typeof b === 'object') bench.set(r.name, Object.assign(b, { at: r.at, source: r.source }));
                }
                for (const r of d.prepare('SELECT k, v FROM ai_settings').all()) {
                    const v = J(r.v, null);
                    if (r.k === 'models' && v && typeof v === 'object') settings = { text: Array.isArray(v.text) ? v.text.filter((x) => MODEL_RE.test(x)) : [], image: Array.isArray(v.image) ? v.image.filter((x) => MODEL_RE.test(x)) : [], asr: MODEL_RE.test(v.asr || '') ? v.asr : '' };
                    if (r.k === 'meta' && v && typeof v === 'object') meta = { firstSync: Number(v.firstSync) || 0, catalogAt: Number(v.catalogAt) || 0 };
                }
            } catch (e) { log('读 AI 模型数据失败:', e.message); }
        }
        for (const s of Array.isArray(SEED) ? SEED : []) {
            if (!s || !MODEL_RE.test(s.name || '')) continue;
            const cur = bench.get(s.name);
            if (cur && !(cur.source === 'seed' && cur.at < s.at)) continue;
            const b = Object.assign({}, s);
            delete b.name;
            bench.set(s.name, b);
            putBench(s.name, b);
        }
        bump();
    }

    // ---------- 目录同步 ----------
    async function fetchPage(page) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), opts.fetchTimeoutMs);
        try {
            const r = await doFetch(API + accountId + '/ai/models/search?per_page=100&page=' + page, { headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal });
            let j = null;
            try { j = await r.json(); } catch (e) { /* 非 JSON */ }
            if (!r.ok || !j || j.success === false || !Array.isArray(j.result)) {
                const msg = ((j && j.errors) || []).map((x) => x && x.message).filter(Boolean).join('; ') || ('HTTP ' + r.status);
                throw new Error(msg.slice(0, 200));
            }
            return j;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('Cloudflare 响应超时');
            throw e;
        } finally { clearTimeout(timer); }
    }
    async function fetchCatalog() {
        const all = [];
        for (let page = 1; page <= opts.maxPages; page++) {
            const j = await fetchPage(page);
            all.push(...j.result);
            const ri = j.result_info || {};
            const per = Number(ri.per_page) || 0, total = Number(ri.total_count) || 0;
            if (!j.result.length) break;
            if (total && per) { if (page * per >= total) break; }
            else if (j.result.length < (per || 100)) break;
        }
        return all;
    }
    // 同步一次;失败保留上次的列表,记下原因。同时调用的合并成一次
    function refresh() {
        ensureLoaded();
        if (syncing) return syncing;
        syncing = (async () => {
            try {
                if (!/^[0-9a-f]{32}$/i.test(accountId) || token.length < 20) throw new Error('没配 CF_AI_ACCOUNT_ID / CF_AI_TOKEN');
                const list = (await fetchCatalog()).map(parseRaw).filter(Boolean);
                if (!list.length) throw new Error('模型目录是空的(token 没有 Workers AI 读权限?)');
                const t = now(), seen = new Set(), rows = [];
                if (!meta.firstSync) meta.firstSync = t;
                for (const x of list) {
                    if (seen.has(x.name)) continue;
                    seen.add(x.name);
                    const old = catalog.get(x.name);
                    const row = { name: x.name, task: x.task, info: { desc: x.desc, props: x.props }, first_seen: old && old.first_seen ? old.first_seen : t, last_seen: t, gone: 0 };
                    catalog.set(x.name, row);
                    rows.push(row);
                }
                for (const m of catalog.values()) if (!seen.has(m.name) && !m.gone) { m.gone = 1; rows.push(m); log(`${m.name} 已不在模型目录里`); }
                meta.catalogAt = t;
                catalogErr = '';
                putModels(rows);
                putSetting('meta', meta);
                log(`模型目录同步完:${seen.size} 个`);
            } catch (e) {
                catalogErr = String((e && e.message) || e).slice(0, 300);
                log('同步模型目录失败:', catalogErr);
            } finally { syncing = null; bump(); }
        })();
        return syncing;
    }

    // ---------- 生效的模型 ----------
    const today = () => cnDay(now());
    function info(name) {
        const m = catalog.get(name);
        return m ? Object.assign({ m }, derive(m.name, m.task, m.info)) : null;
    }
    const isDeprecated = (d) => !!d.deprecation && d.deprecation <= today();
    // 目录还没同步过 → 只能相信默认 / 已存的;同步过 → 要在目录里、没下架、没过期、能干这个
    function usable(name, role) {
        if (!catalog.size) return MODEL_RE.test(name || '');
        const d = info(name);
        return !!d && !d.m.gone && !isDeprecated(d) && d.roles.includes(role);
    }
    function roleScore(name, role) {
        const g = gradeOf(bench.get(name), role === 'image' ? !!(info(name) || {}).vision : true);
        const x = g && (role === 'image' ? g.image : g.text);
        return x ? x.score : null;
    }
    // 每千次大概多少钱:有测评用测评的,没有按目录价估(输入 200 + 输出 60 token)
    function costOf(name, role) {
        const b = bench.get(name), k = role === 'image' ? 'costPer1kImg' : 'costPer1kText';
        if (b && b[k] != null) return b[k];
        const d = info(name);
        if (d && d.price.in != null) return (d.price.in * 200 + (d.price.out || 0) * 60) / 1000;
        return Infinity;
    }
    // 这个用途下能用的模型,分高的在前,同分便宜的在前,没测评的排最后(也按便宜)
    function ranked(role) {
        const list = [...catalog.keys()].filter((n) => usable(n, role));
        const sc = new Map(list.map((n) => [n, roleScore(n, role)]));
        return list.sort((a, b) => ((sc.get(b) == null ? -1 : sc.get(b)) - (sc.get(a) == null ? -1 : sc.get(a))) || (costOf(a, role) - costOf(b, role)) || (a < b ? -1 : 1));
    }
    function effList(role) {
        const def = DEFAULTS[role];
        const want = uniq((settings[role].length ? settings[role] : def).concat(def));
        let out = want.filter((n) => usable(n, role));
        if (!out.length && catalog.size) out = ranked(role).slice(0, 1);   // 选的和默认的全不能用了:挑能用的里分最高的
        return out.length ? out : def.slice();
    }
    // 目录里能用的语音模型,默认的在前,其余按每分钟价格
    function asrList() {
        const perMin = (n) => { const m = info(n).price.minute; return m == null ? Infinity : m; };
        return [...catalog.keys()].filter((n) => usable(n, 'asr'))
            .sort((a, b) => ((b === DEFAULTS.asr) - (a === DEFAULTS.asr)) || (perMin(a) - perMin(b)) || (a < b ? -1 : 1));
    }
    function effAsr() {
        for (const n of uniq([settings.asr, DEFAULTS.asr])) if (usable(n, 'asr')) return n;
        return (catalog.size && asrList()[0]) || DEFAULTS.asr;
    }
    function effective() {
        ensureLoaded();
        const key = ver + '|' + today();
        if (memo && memo.key === key) return memo.v;
        const v = { text: effList('text'), image: effList('image'), asr: effAsr() };
        memo = { key, v };
        return v;
    }
    const requestOf = (name) => { const d = info(name); return (d && d.request) || requestFor(name, [], false); };
    const asCalls = (names) => names.map((id) => Object.assign({ id }, requestOf(id)));

    function recommended() {
        const pick = (role) => { const r = ranked(role).find((n) => roleScore(n, role) != null); return r || null; };
        const value = ranked('text').filter((n) => (roleScore(n, 'text') || 0) >= 75).sort((a, b) => (costOf(a, 'text') - costOf(b, 'text')) || (a < b ? -1 : 1))[0] || null;
        return { text: pick('text'), image: pick('image'), value, asr: asrList()[0] || null };
    }

    // 没测过的模型:按同系列里实测最好的那个估计(新版本一般和老版本差不多);系列里一个都没测过 → 用系列表里的估计分
    function estimateOf(name, vision) {
        const fam = familyOf(name);
        if (fam === FAM_OTHER) return null;
        let best = null, bestScore = -1;
        for (const [n, b] of bench) {
            if (n === name || familyOf(n) !== fam) continue;
            const m = catalog.get(n);
            if (m && m.gone) continue;
            const g = gradeOf(b, !!(info(n) || {}).vision);
            if (g && g.overall.score > bestScore) { best = { n, g }; bestScore = g.overall.score; }
        }
        let text = null, image = null;
        if (best) { text = best.g.text; image = vision ? best.g.image : null; }
        else if (fam.est) {
            if (fam.est.text != null) text = mark(fam.est.text);
            if (vision && fam.est.image != null) image = mark(fam.est.image);
        }
        if (!text && !image) return null;
        const top = Math.max(text ? text.score : -1, image ? image.score : -1);
        return { text, image, overall: { score: top, letter: letter(top) }, estimated: true, from: best ? best.n : '' };
    }

    function itemOf(m) {
        const d = derive(m.name, m.task, m.info);
        const b = bench.get(m.name) || null;
        const measured = gradeOf(b, d.vision);
        return {
            name: m.name, task: m.task, desc: d.desc, hosted: d.hosted, vision: d.vision, reasoning: d.reasoning, efforts: d.efforts, ctx: d.ctx,
            price: d.price, paidOnly: d.paidOnly, beta: d.beta, deprecation: d.deprecation, deprecated: isDeprecated(d), gone: !!m.gone,
            isNew: !m.gone && !!meta.firstSync && m.first_seen > meta.firstSync && now() - m.first_seen <= opts.newDays * 86400e3,
            bench: b ? clone(b) : null, grade: measured || estimateOf(m.name, d.vision), roles: d.roles, request: d.request,
            family: famPub(familyOf(m.name)),
        };
    }

    // 系列总评:目录里有成员的系列,按 首选 → 后备 → 不推荐、同档按系列里最好的分排
    function familiesOf(models) {
        const by = new Map();
        for (const it of models) {
            if (it.gone) continue;
            const k = it.family.key;
            if (!by.has(k)) by.set(k, Object.assign({}, it.family, { models: [], best: null }));
            const f = by.get(k);
            f.models.push(it.name);
            const g = it.grade && !it.grade.estimated ? it.grade.overall : null;
            if (g && (!f.best || g.score > f.best.score)) f.best = { name: it.name, score: g.score, letter: g.letter };
        }
        return [...by.values()].sort((a, b) => (a.tier - b.tier) || ((b.best ? b.best.score : -1) - (a.best ? a.best.score : -1)) || (a.label < b.label ? -1 : 1));
    }

    function state() {
        ensureLoaded();
        const models = [...catalog.values()].map(itemOf)
            .sort((a, b) => (a.gone - b.gone) || ((b.grade ? b.grade.overall.score : -1) - (a.grade ? a.grade.overall.score : -1)) || (a.name < b.name ? -1 : 1));
        return {
            catalogAt: meta.catalogAt || 0, catalogErr,
            families: familiesOf(models),
            settings: { text: settings.text.slice(), image: settings.image.slice(), asr: settings.asr || '' },
            effective: clone(effective()),
            recommended: recommended(),
            defaults: clone(DEFAULTS),
            bench: { running, queue: queue.slice(), progress: progress ? Object.assign({}, progress) : null, last: last ? Object.assign({}, last) : null },
            models,
        };
    }

    // ---------- 站长改设置 ----------
    function saveSettings(patch) {
        ensureLoaded();
        const p = patch && typeof patch === 'object' ? patch : {};
        const warnings = [];
        if (p.reset === true) {
            settings = { text: [], image: [], asr: '' };
        } else {
            if (!catalog.size) throw bad('模型列表还没同步好,先点「刷新」');
            const next = { text: settings.text.slice(), image: settings.image.slice(), asr: settings.asr };
            const check = (n, role) => {
                if (typeof n !== 'string' || !MODEL_RE.test(n)) throw bad('模型名不对:' + String(n).slice(0, 80));
                const d = info(n);
                if (!d || d.m.gone) throw bad(n + ' 已经不在 Cloudflare 的模型列表里了');
                if (!d.roles.includes(role)) throw bad(n + ' 不能用来' + ROLE_LABEL[role]);
                if (isDeprecated(d)) warnings.push(n + ' 已过计划下架日期(' + d.deprecation + '),实际会被跳过');
            };
            for (const role of ['text', 'image']) {
                if (p[role] === undefined) continue;
                if (!Array.isArray(p[role])) throw bad(ROLE_LABEL[role] + '要传模型名数组');
                const list = uniq(p[role].map((x) => typeof x === 'string' ? x.trim() : x));
                if (list.length > LIMIT[role]) throw bad(ROLE_LABEL[role] + '最多选 ' + LIMIT[role] + ' 个');
                list.forEach((n) => check(n, role));
                next[role] = list;
            }
            if (p.asr !== undefined) {
                const a = typeof p.asr === 'string' ? p.asr.trim() : p.asr;
                if (a === '' || a == null) next.asr = '';
                else { check(a, 'asr'); next.asr = a; }
            }
            settings = next;
        }
        putSetting('models', settings);
        bump();
        log('模型设置:', JSON.stringify(settings));
        return Object.assign(state(), { warnings });
    }

    // ---------- 快速测评 ----------
    async function loadImage(p) {
        if (imgCache.has(p)) return imgCache.get(p);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        try {
            const r = await doFetch(imageBase + p, { signal: ctl.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length < 1000) throw new Error('图片太小');
            const url = 'data:image/jpeg;base64,' + buf.toString('base64');
            imgCache.set(p, url);
            return url;
        } finally { clearTimeout(timer); }
    }
    const hits = (cands, accept) => {
        const ok = new Set(accept.map(norm));
        return cands.findIndex((c) => ok.has(norm(c.title)) || ok.has(norm(c.original_title)));
    };
    // 这次调用花了多少美元:按返回的 token 数 × 目录价;没有价格就按 neurons(每千个 $0.011)
    function callCost(r, d) {
        const u = (r && r.usage) || {};
        const tin = Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens), tout = Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0;
        if (d && d.price.in != null && Number.isFinite(tin)) return (tin * d.price.in + tout * (d.price.out || 0)) / 1e6;
        if (Number.isFinite(Number(u.neurons))) return Number(u.neurons) * 0.011 / 1000;
        return null;
    }
    async function benchOne(name) {
        const d = info(name);
        const req = (d && d.request) || requestFor(name, [], false);
        const roles = d ? d.roles : ['text'];
        const doText = roles.includes('text'), doImg = roles.includes('image') && !!imageBase;
        const jobs = [];
        if (doText) { for (const c of CASES.text) jobs.push({ kind: 'text', c }); jobs.push({ kind: 'rec', c: CASES.rec }); }
        if (doImg) for (const c of CASES.image) jobs.push({ kind: 'image', c });
        progress = { done: 0, total: jobs.length };
        const res = { textTop1: 0, textTop3: 0, textN: 0, rec: 0, imgTop1: 0, imgTop3: 0, imgN: 0 };
        const lat = { text: [], image: [] }, cost = { text: [], image: [] }, tried = { text: 0, image: 0 };
        let errors = 0, firstErr = '', recCount = 0, skipImg = false;
        const runJob = async (job) => {
            const kind = job.kind === 'image' ? 'image' : 'text';
            if (kind === 'image' && skipImg) return;
            let image = '';
            if (kind === 'image') {
                try { image = await loadImage(job.c.path); } catch (e) { log(`取测评截图 ${job.c.path} 失败:`, e.message); return; }   // 图拿不到不算模型的错
            }
            tried[kind]++;
            if (job.kind === 'text') res.textN++;
            if (kind === 'image') res.imgN++;
            const t0 = now();
            let r = null;
            try {
                r = await ai.run(name, requestBody(req, kind === 'image' ? '' : job.c.q, image), { timeoutMs: opts.benchTimeoutMs });
            } catch (e) {
                if (e.code === 'quota' || e.code === 'disabled') throw e;   // 整个队列停
                errors++;
                if (!firstErr) firstErr = e.message;
                if (e.code === 'timeout') lat[kind].push(opts.benchTimeoutMs);
                // 第一题就 4xx = 这个模型 / 这种请求根本调不了:文字的整个模型不测了,截图的跳过剩下的截图
                if (e.status >= 400 && e.status < 500 && e.status !== 429 && tried[kind] === 1) {
                    if (kind === 'text') throw new Error('调用失败(' + e.status + ' ' + String(e.message).slice(0, 120) + ')');
                    skipImg = true;
                    res.imgN = 0;
                }
                return;
            }
            lat[kind].push(now() - t0);
            const c1 = callCost(r, d);
            if (c1 != null) cost[kind].push(c1);
            const cands = parseCandidates(replyText(r), 6);
            if (job.kind === 'rec') {
                const known = new Set(job.c.known.map(norm));
                recCount = cands.filter((c) => known.has(norm(c.title)) || known.has(norm(c.original_title))).length;
                res.rec = recCount >= 4 ? 1 : recCount / 4;
            } else {
                const i = hits(cands, job.c.accept);
                const k = kind === 'image' ? 'img' : 'text';
                if (i === 0) res[k + 'Top1']++;
                if (i >= 0 && i < 3) res[k + 'Top3']++;
            }
        };
        for (const job of jobs) {
            if (stopped) throw new Error('服务器在关,测评中断');
            try { await runJob(job); } finally { progress.done++; }
        }
        if (skipImg) { res.imgTop1 = 0; res.imgTop3 = 0; }
        const all = lat.text.concat(lat.image);
        const b = Object.assign(res, {
            at: now(), source: 'quick',
            latMedian: median(all), latP90: p90(all), latText: median(lat.text), latImg: median(lat.image),
            costPer1kText: r4(cost.text.length ? avg(cost.text) * 1000 : null), costPer1kImg: r4(cost.image.length ? avg(cost.image) * 1000 : null),
            errors,
        });
        const parts = [];
        if (doText) parts.push(`文字 ${res.textTop1}/${res.textN} 排第一、推荐对 ${recCount} 部`);
        if (res.imgN) parts.push(`截图 ${res.imgTop1}/${res.imgN}`);
        else if (roles.includes('image')) parts.push(imageBase ? '截图没测成' : '没配 TMDB,截图没测');
        if (errors) parts.push(`出错 ${errors} 次(${String(firstErr).slice(0, 60)})`);
        b.notes = '快速测评:' + parts.join(';');
        if (!all.length) throw new Error('全部调用失败' + (firstErr ? ':' + String(firstErr).slice(0, 120) : ''));
        return b;
    }
    async function loop() {
        if (looping) return;
        looping = true;
        try {
            while (queue.length && !stopped) {
                const name = queue.shift();
                running = name;
                progress = { done: 0, total: 0 };
                try {
                    const b = await benchOne(name);
                    bench.set(name, b);
                    putBench(name, b);
                    last = { name, ok: true, error: '' };
                    log(`${name} 测评完:${b.notes}`);
                } catch (e) {
                    last = { name, ok: false, error: String((e && e.message) || e).slice(0, 200) };
                    log(`${name} 测评失败:`, last.error);
                    if (e && (e.code === 'quota' || e.code === 'disabled')) queue.length = 0;
                }
                running = null;
                progress = null;
                bump();
            }
        } finally { looping = false; running = null; progress = null; }
    }
    function queueBench(names) {
        ensureLoaded();
        if (!Array.isArray(names) || !names.length) throw bad('选几个要测评的模型');
        if (names.length > opts.queueMax) throw bad('一次最多测 ' + opts.queueMax + ' 个');
        if (!catalog.size) throw bad('模型列表还没同步好,先点「刷新」');
        for (const n of names) {
            const d = typeof n === 'string' ? info(n) : null;
            if (!d || d.m.gone) throw bad(String(n).slice(0, 80) + ' 不在模型列表里');
            if (!d.roles.includes('text') && !d.roles.includes('image')) throw bad(n + ' 不是能找片的模型,测不了');
        }
        const add = uniq(names).filter((n) => n !== running && !queue.includes(n));
        if (queue.length + add.length + (running ? 1 : 0) > opts.queueMax) throw bad('排队的测评太多了(最多 ' + opts.queueMax + ' 个),等跑完再加');
        queue.push(...add);
        if (add.length) loop();   // 同步跑到第一个 await,返回时 running 已经是第一个
        return state();
    }

    function start() {
        stopped = false;
        // 推到下一轮事件循环:server.js 里 REQ_DB_OK 这时才定义好
        setImmediate(() => {
            try { ensureLoaded(); } catch (e) { log('加载失败:', e.message); }
            const a = setTimeout(() => {
                refresh();
                const b = setInterval(() => { refresh(); }, opts.intervalMs);
                if (b.unref) b.unref();
                timers.push(b);
            }, opts.firstDelayMs);
            if (a.unref) a.unref();
            timers.push(a);
        });
    }
    function stop() {
        stopped = true;
        for (const t of timers) { clearTimeout(t); clearInterval(t); }
        timers = [];
    }

    return {
        start, stop, refresh, state, saveSettings, queueBench,
        textModels: () => asCalls(effective().text),
        imageModels: () => asCalls(effective().image),
        asrModel: () => effective().asr,
    };
}

module.exports = { createAiModels, parseRaw, derive, requestFor, gradeOf, letter, speed, DEFAULT_IDS: { GLM, DS, GEMMA, WHISPER } };
