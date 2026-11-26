'use strict';
// ☁️ Cloudflare Workers AI 的薄封装:语音搜索转文字、AI 找片、以后评论审核共用。
//   CF_AI_ACCOUNT_ID + CF_AI_TOKEN(Workers AI 读写权限的 API Token)都配了才开;没配 → enabled() = false,前端整块隐藏。
//
// createCfAi({ accountId, token, fetchImpl?, log?, now?, opts? })
// → { enabled(), run(model, body, {timeoutMs}), transcribe(base64Wav), usage() }
//
// 每天的调用次数有上限(CF_AI_DAILY_LIMIT,默认 3000 次 / 天,按北京日期算),超了直接拒绝 —— 防止被刷爆账单。
// opts.asrModel 可以是模型名,也可以是返回模型名的函数(站长后台「AI 模型」页改了马上生效,见 lib/ai-models)。
const DEF = Object.freeze({
    timeoutMs: 20000,
    asrModel: '@cf/openai/whisper-large-v3-turbo',   // $0.0005 / 分钟音频;实测 1~4 秒出结果
    dailyLimit: 3000,
});
const API = 'https://api.cloudflare.com/client/v4/accounts/';
const cnDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

function createCfAi(o) {
    const opts = Object.assign({}, DEF, (o && o.opts) || {});
    const accountId = String((o && o.accountId) || '').trim(), token = String((o && o.token) || '').trim();
    const doFetch = (o && o.fetchImpl) || ((...a) => fetch(...a));
    const log = (o && o.log) || (() => { });
    const now = (o && o.now) || Date.now;
    const on = /^[0-9a-f]{32}$/i.test(accountId) && token.length >= 20;
    let day = '', count = 0;

    function take() {
        const d = cnDay(now());
        if (d !== day) { day = d; count = 0; }
        if (count >= opts.dailyLimit) { const e = new Error('今天的 AI 调用次数用完了'); e.code = 'quota'; throw e; }
        count++;
    }

    // 跑一个模型,返回 result(CF 的 { result, success, errors } 里那层)
    async function run(model, body, ro) {
        if (!on) { const e = new Error('Workers AI 没配置'); e.code = 'disabled'; throw e; }
        if (!/^@cf\/[\w.-]+\/[\w.-]+$/.test(String(model || ''))) throw new Error('模型名不对');
        take();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), (ro && ro.timeoutMs) || opts.timeoutMs);
        const t0 = now();
        try {
            const r = await doFetch(API + accountId + '/ai/run/' + model, {
                method: 'POST', signal: ctl.signal,
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            let j = null;
            try { j = await r.json(); } catch (e) { /* 非 JSON */ }
            if (!r.ok || !j || j.success === false) {
                const msg = ((j && j.errors) || []).map((x) => x && x.message).filter(Boolean).join('; ') || ('HTTP ' + r.status);
                const e = new Error(msg.slice(0, 300)); e.status = r.status; throw e;
            }
            log(`${model} ${now() - t0}ms`);
            return j.result;
        } catch (e) {
            if (e.name === 'AbortError') { const t = new Error('AI 响应超时'); t.code = 'timeout'; throw t; }
            throw e;
        } finally { clearTimeout(timer); }
    }

    function asrModel() {
        let m = opts.asrModel;
        if (typeof m === 'function') { try { m = m(); } catch (e) { m = ''; } }
        return m || DEF.asrModel;
    }

    // 语音 → 文字。不指定语言(片名常夹英文;指定 zh 反而爱在句尾加「。」),标点在前端清
    //   whisper-large-v3-turbo 收 base64 字符串;老的 whisper / whisper-tiny-en 只收字节数组
    async function transcribe(b64) {
        const model = asrModel();
        const audio = /\/whisper(?!-large-v3)/.test(model) ? Array.from(Buffer.from(String(b64), 'base64')) : b64;
        const r = await run(model, { audio });
        return String((r && r.text) || '').trim();
    }

    return { enabled: () => on, run, transcribe, usage: () => ({ day, count, limit: opts.dailyLimit }) };
}

module.exports = { createCfAi };
