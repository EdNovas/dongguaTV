'use strict';
// [adult] scripts/adult-server-test.mjs 用的 lib/adult-mirror 替身(第四阶段):server.js 的接线测试只看"谁调了什么"——
//   apiFor 按 ADULT_TEST_MIRROR_MAP({key: 地址})给当前地址,report / probe / start 逐条记到 ADULT_TEST_MIRROR_LOG。
//   换源逻辑本身由 scripts/adult-mirror-test.mjs 测(真模块 + 注入的假网络)。
const fs = require('fs');
const path = require('path');
const LOG = process.env.ADULT_TEST_MIRROR_LOG || '';
const rec = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); };

function createMirror(d) {
    const sites = () => { try { return (typeof d.sites === 'function' ? d.sites() : d.sites) || []; } catch (e) { return []; } };
    const map = (() => { try { return JSON.parse(process.env.ADULT_TEST_MIRROR_MAP || '{}'); } catch (e) { return {}; } })();
    const s0 = sites();
    rec({
        ev: 'create', keys: Object.keys(d).sort(), sites: s0.map((s) => s.key), mirrorsOf: Object.fromEntries(s0.map((s) => [s.key, Array.isArray(s.mirrors) ? s.mirrors.length : 0])),
        storeFile: d.store && d.store.file ? path.basename(d.store.file) : null, storeDir: d.store && d.store.file ? path.dirname(d.store.file) : null,
    });
    return {
        apiFor(k) { const s = sites().find((x) => x.key === k); return s ? (map[k] || s.api) : null; },
        report(k, ok, kind, info) { rec({ ev: 'report', k, ok, kind, url: info && info.url, hasData: !!(info && info.data) }); },
        status() { return sites().map((s) => ({ key: s.key, primary: s.api, current: map[s.key] || s.api, since: 0, fails: 0, lastProbe: 0, candidates: Array.isArray(s.mirrors) ? s.mirrors.length : 0, reason: '' })); },
        async probe(k) { rec({ ev: 'probe', k }); return { key: k, ok: true, switched: false, current: map[k] || '', reason: 'stub', tried: [] }; },
        // 复核 SEC-2:后台「回到主地址」
        reset(k) { rec({ ev: 'reset', k }); const s = sites().find((x) => x.key === k); if (!s) return { key: k, ok: false, switched: false, reason: 'unknown-site' }; const from = map[k] || s.api; delete map[k]; return { key: k, ok: true, switched: from !== s.api, from, current: s.api, reason: from !== s.api ? 'admin-reset' : 'already-primary' }; },
        start() { rec({ ev: 'start' }); },
        stop() { },
        tick() { },
        // [修订] ADULT_TEST_MIRROR_GUARDED=1:ADULT_TEST_MIRROR_MAP 里的地址算"换上去的镜像源站"(server.js 出网时按 SSRF 再判一次)
        isMirrorUrl(u) { const s = String(u || ''); return process.env.ADULT_TEST_MIRROR_GUARDED === '1' && Object.values(map).some((m) => typeof m === 'string' && m && s.indexOf(m) === 0); },
    };
}
function classifyError(e) {
    if (!e) return 'other';
    if (e instanceof SyntaxError) return 'body';
    if (e.response && e.response.status >= 500) return '5xx';
    if (/ECONNREFUSED|ECONNRESET/.test(String(e.code || ''))) return 'conn';
    if (/timeout/i.test(String(e.message || '')) || e.code === 'ECONNABORTED') return 'timeout';
    return 'other';
}
function fileStore(file) { return { file, load() { return {}; }, save() { return true; } }; }
module.exports = { createMirror, classifyError, fileStore };
