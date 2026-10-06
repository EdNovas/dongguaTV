#!/usr/bin/env node
// 线路列表 · 客户端逻辑回归(离线、零网络):
//   node scripts/source-list-test.mjs
// 从 public/index.html 原样抽出 SRC_* 常量 + 选源/分组/换源/同名拆分相关方法与计算属性,装进桩对象跑合成线路与真实搜索结果。
// 覆盖:可达性分档 _srcReachClass、档内偏好 _pickPreferred(无广告档 2s 豁免)、_autoPick/_earlyPick(绝不越档、3s 死锁修复)、
//   去广告是否在链路里 _srcFilterOn(noburn → 有插播 的运行时降级)、分组 sourceGroups(可能无法播放组垫底)、
//   _failoverNext 绕圈换源、HEVC 闸门、splitSameNameWorks(同名多部作品拆卡 + 同站/同片源去重,fixtures/sources/)。
// 改 index.html 里上述任何一处后必跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').split('\r\n').join('\n');

// ---------- 抽取 ----------
function matchBrace(src, openIdx) {
    // openIdx 指向 '{';跳过字符串/模板串/注释,返回匹配 '}' 的下标
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i], n = src[i + 1];
        if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
        if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
        if (c === '"' || c === "'" || c === '`') {
            for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    throw new Error('unbalanced');
}
function extractMember(name) {
    const re = new RegExp('\\n\\s+(?:async\\s+)?' + name.replace(/\$/g, '\\$') + '\\(([^)]*)\\)\\s*\\{');
    const m = re.exec(html);
    if (!m) throw new Error('member not found: ' + name);
    const open = m.index + m[0].length - 1;
    const close = matchBrace(html, open);
    return { params: m[1], body: html.slice(open, close + 1) };
}
const cStart = html.indexOf('const SRC_TIER_RANK = {');
const cEnd = html.indexOf('const EARLY_SETTLE_MS = 1200;');
if (cStart < 0 || cEnd < 0) throw new Error('SRC_* consts not found');
const consts = html.slice(cStart, cEnd + 'const EARLY_SETTLE_MS = 1200;'.length);

const methods = ['srcProfile', '_srcFilterOn', '_srcClipOn', '_srcUnreach', '_kzWorkerOk', 'srcGroupOf', '_srcAdBad', 'srcTierRank', '_srcResRankOf', 'srcResRank', 'srcResLabel', 'srcTierLabel', 'srcTitle',
    '_srcReachClass', '_pickPreferred', '_autoPick', '_earlyPick', '_srcLogTag', '_failoverNext', '_isKzSource'];
const computed = ['playableSources', 'sourceGroups', 'availableSources', 'fastSources', 'slowSources'];
let objSrc = '{\n';
methods.forEach(n => { const m = extractMember(n); objSrc += '  ' + n + '(' + m.params + ') ' + m.body + ',\n'; });
computed.forEach(n => { const m = extractMember(n); objSrc += '  get ' + n + '() ' + m.body + ',\n'; });
objSrc += '}';
const factory = new Function('stubs', 'window', 'localStorage', 'location', consts + '\nlet _navSeq = 1;\nconst vm = Object.assign(' + objSrc + ', stubs);\n' +
    'return { vm, setNav(v) { _navSeq = v; }, getNav() { return _navSeq; }, SRC_GROUPS, EARLY_SETTLE_MS };');

function mk(opts) {
    opts = opts || {};
    const bad = opts.adBad || {};
    const noEp = opts.noEp || {};
    return factory({
        siteProfiles: opts.profiles || {},
        corsProxyUrl: opts.cors === false ? null : 'https://w.example',
        currentGroup: { sources: opts.sources || [] },
        _adProxyBad: k => !!bad[k],
        _sourceHasEpisode: (s, ep) => ((ep && noEp[s.site_key]) ? false : null),
        _srcHevcOk: () => opts.hevc !== false,
    }, { AdFilter: { isEnabled: () => opts.adFilter !== false }, Hls: { isSupported: () => true }, AdClipCore: {}, _dgPreferNativeHls: !!opts.nativeHls }, { getItem: () => null, setItem() { }, removeItem() { } }, { hostname: opts.host || 'localhost' });
}

// ---------- 迷你断言 ----------
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS ' + msg); } else { fail++; console.log('  FAIL ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + (a === b ? '' : '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')')); }
const keys = arr => arr.map(s => s && s.site_key).join(',');

// 合成线路:tier 写在 site_profile 上(模拟搜索结果自带),或只靠 siteProfiles 表
const S = (key, testType, latency, tier, res, extra, codec) => Object.assign({
    site_key: key, site_name: key, vod_id: 1, latency: latency, _testType: testType,
    site_profile: tier ? { tier: tier, res: res || '', geo: 0, note: '', codec: codec || '' } : null
}, extra || {});

// ===== 1. _srcReachClass =====
console.log('[1] _srcReachClass 可达性分档');
{
    const { vm } = mk();
    eq(vm._srcReachClass(S('a', 'direct', 300, 'ads')), 0, 'direct → 0');
    eq(vm._srcReachClass(S('a', 'proxy', 300, 'ads')), 1, 'proxy → 1');
    eq(vm._srcReachClass(S('a', 'server', 300, 'clean')), 2, 'server → 2 (干净也不升档)');
    eq(vm._srcReachClass(S('a', undefined, 300, 'clean')), 2, '无类型 → 2');
    eq(vm._srcReachClass(S('kz_moonci', 'kz', 900, 'clean')), 0, '无广告 kz → 0 (站长例外)');
    eq(vm._srcReachClass(S('kz_moonci', 'kz', 8999, 'clean', '', { _kzMismatch: true })), -1, '年份不符 kz → -1');
    eq(vm._srcReachClass(S('kz_dm84', 'kz', 900, 'noburn')), 3, '无硬广 kz → 3 (仍是兜底)');
    eq(vm._srcReachClass(S('kz_x', 'kz', 900, null)), 3, '未评测 kz → 3');
    eq(vm._srcReachClass(S('a', 'direct', 9999, 'clean')), -1, '9999 → -1');
    eq(vm._srcReachClass(S('a', 'direct', 9998, 'clean')), -1, '9998(播放失败) → -1');
    eq(vm._srcReachClass(S('a', 'direct', '...', 'clean')), -1, "'...' 测速中 → -1");
}

// ===== 2. _pickPreferred =====
console.log('[2] _pickPreferred 档内偏好');
{
    const { vm } = mk();
    eq(vm._pickPreferred([]), null, '空候选 → null');
    eq(vm._pickPreferred([S('ads', 'direct', 120, 'ads'), S('clean', 'direct', 600, 'clean')]).site_key, 'clean', '120ms 含广告 vs 600ms 无广告(在 920 内) → 无广告');
    eq(vm._pickPreferred([S('ads', 'direct', 120, 'ads'), S('clean', 'direct', 1500, 'clean')]).site_key, 'clean', '120 vs 1500:超出相对窗口 max(920,240),但无广告档 <2000 豁免 → 无广告');
    eq(vm._pickPreferred([S('ads', 'direct', 61, 'ads'), S('rycj', 'direct', 873, 'noburn')]).site_key, 'rycj', '成龙历险记实测:61ms 有水印 vs 873ms 插播已去除 → 如意');
    eq(vm._pickPreferred([S('ads', 'direct', 120, 'ads'), S('clean', 'direct', 2100, 'clean')]).site_key, 'ads', '120 vs 2100:超出无广告豁免上限 2000 → 最快的有水印');
    eq(vm._pickPreferred([S('ads', 'direct', 120, 'ads'), S('u', 'direct', 1500, null)]).site_key, 'ads', '豁免只给无广告档:未评测 1500 仍按相对窗口出局');
    eq(vm._pickPreferred([S('ads', 'proxy', 1000, 'ads'), S('clean', 'proxy', 1900, 'clean')]).site_key, 'clean', '1000 vs 1900(在 max(1800,2000)=2000 内) → 无广告');
    eq(vm._pickPreferred([S('ads', 'proxy', 1600, 'ads'), S('clean', 'proxy', 3100, 'clean')]).site_key, 'ads', '1600 vs 3100(>=3000 上限) → 含广告');
    eq(vm._pickPreferred([S('ads', 'proxy', 3500, 'ads'), S('clean', 'proxy', 4000, 'clean')]).site_key, 'clean', '全部 >=3000 → 全体参与,按分级');
    eq(vm._pickPreferred([S('u', 'direct', 200, null), S('nb', 'direct', 300, 'noburn'), S('ads', 'direct', 100, 'ads')]).site_key, 'nb', '无硬广 > 未评测 > 含广告');
    eq(vm._pickPreferred([S('hd720', 'direct', 200, 'ads', '720p'), S('hd1080', 'direct', 500, 'ads', '1080p')]).site_key, 'hd1080', '同级:1080P 优先于 720P');
    eq(vm._pickPreferred([S('x', 'direct', 500, 'ads', '1080p'), S('y', 'direct', 300, 'ads', '1080p')]).site_key, 'y', '同级同分辨率:延迟低的');
    const cands = [S('a', 'proxy', 400, 'ads')];
    const r = vm._pickPreferred(cands);
    ok(cands.indexOf(r) >= 0, '结果永远在候选内');
}

// ===== 3. _autoPick =====
console.log('[3] _autoPick 分档顺序(分级绝不越档)');
{
    const { vm } = mk();
    eq(vm._autoPick([S('d', 'direct', 1200, 'ads'), S('p', 'proxy', 100, 'clean')], 2).site_key, 'd', '直连含广告 胜过 代理无广告(可达性优先)');
    eq(vm._autoPick([S('p', 'proxy', 300, 'ads'), S('kz_moonci', 'kz', 900, 'clean')], 2).site_key, 'kz_moonci', '无直连时 无广告kz(0档) 胜过 代理含广告');
    eq(vm._autoPick([S('d', 'direct', 200, 'ads'), S('kz_moonci', 'kz', 900, 'clean')], 2).site_key, 'kz_moonci', '直连含广告 200ms vs 无广告kz 900ms(同 0 档,在 1000 内) → kz');
    eq(vm._autoPick([S('d', 'direct', 100, 'ads'), S('kz_7sefun', 'kz', 1500, 'clean')], 2).site_key, 'kz_7sefun', '无广告kz 1500(超相对窗口 900 但 <2000 豁免) → kz');
    eq(vm._autoPick([S('d', 'direct', 100, 'ads'), S('kz_7sefun', 'kz', 2500, 'clean')], 2).site_key, 'd', '无广告kz 太慢(2500 > 2000) → 直连');
    eq(vm._autoPick([S('p', 'proxy', 300, 'ads'), S('kz_moonci', 'kz', 8999, 'clean', '', { _kzMismatch: true })], 3).site_key, 'p', '年份不符的 kz 不参与');
    eq(vm._autoPick([S('kz_dm84', 'kz', 700, 'noburn')], 2), null, '3s 定时器(maxClass=2)不选普通 kz');
    eq(vm._autoPick([S('kz_dm84', 'kz', 700, 'noburn')], 3).site_key, 'kz_dm84', '测速完成(maxClass=3) maccms 全不可用才轮到普通 kz');
    eq(vm._autoPick([S('s', 'server', 200, 'clean'), S('kz_dm84', 'kz', 700, 'noburn')], 3).site_key, 's', '服务器测速档 先于 普通 kz');
    eq(vm._autoPick([S('s1', 'server', 2500, 'clean'), S('s2', 'server', 400, 'ads')], 2).site_key, 's2', '服务器档内:2500 超出 max(1200,800) → 400 含广告');
    eq(vm._autoPick([S('a', 'direct', '...', 'clean'), S('b', 'direct', 9999, 'clean')], 3), null, '全部测速中/不可用 → null(调用方不烧 hasAutoSelected)');
    // 历史回放:只认 <3000ms
    eq(vm._autoPick([S('d', 'direct', 3500, 'clean'), S('p', 'proxy', 800, 'ads')], 2, 3000).site_key, 'p', '历史回放 maxLatency=3000:3500ms 直连不算');
}

// ===== 4. _earlyPick =====
console.log('[4] _earlyPick 测速中提前起播');
{
    const { vm, EARLY_SETTLE_MS } = mk();
    eq(EARLY_SETTLE_MS, 1200, 'EARLY_SETTLE_MS = 1200');
    const r1 = vm._earlyPick([S('p', 'proxy', 400, 'clean')], 50, 600, 2);
    eq(r1 && r1.src.site_key, 'p', '无广告代理 <600ms → 立即起播(不等 1.2s)');
    eq(vm._earlyPick([S('p', 'proxy', 400, 'ads')], 50, 600, 2), null, '含广告代理 50ms 时 → 先等');
    eq(vm._earlyPick([S('p', 'proxy', 400, null)], 1100, 600, 2), null, '未评测代理 1100ms 时 → 仍等');
    const r2 = vm._earlyPick([S('p', 'proxy', 400, 'ads')], 1300, 600, 2);
    eq(r2 && r2.src.site_key, 'p', '含广告代理 1300ms 时 → 起播');
    const r3 = vm._earlyPick([S('d1', 'direct', 100, 'ads'), S('d2', 'direct', 300, 'ads', '1080p')], 10, 600, 2);
    eq(r3 && r3.src.site_key, 'd2', '≥2 条直连快线 → 档内偏好(1080P)');
    eq(vm._earlyPick([S('d1', 'direct', 100, 'ads')], 10, 600, 2), null, '只有 1 条含广告直连快线 → 先等');
    const r4 = vm._earlyPick([S('d1', 'direct', 300, 'ads'), S('p', 'proxy', 200, 'ads')], 1300, 600, 2);
    eq(r4 && r4.src.site_key, 'd1', '1.2s 后:直连档优先于代理档');
    const r5 = vm._earlyPick([S('d1', 'direct', 100, 'ads'), S('d2', 'direct', 300, 'noburn')], 10, 600, 2);
    eq(r5 && r5.src.site_key, 'd2', '无硬广直连快线 → 立即起播');
    eq(vm._earlyPick([S('kz_moonci', 'kz', 700, 'clean')], 500, 600, 2), null, '无广告 kz(600ms 下限)不触发"快线立即播" → 先等');
    const r6 = vm._earlyPick([S('kz_moonci', 'kz', 700, 'clean'), S('p', 'proxy', 300, 'ads')], 1300, 600, 2);
    eq(r6 && r6.src.site_key, 'kz_moonci', '1.2s 后 无广告kz(0档) 胜过 代理含广告');
    eq(vm._earlyPick([S('s', 'server', 100, 'clean')], 5000, 600, 2), null, '服务器测速档从不提前起播(交给 3s 定时器)');
    eq(vm._earlyPick([S('kz_dm84', 'kz', 700, 'noburn')], 5000, 600, 2), null, '普通 kz 从不提前起播');
}
{
    const { vm } = mk({ adBad: { rycj: 1 } });
    eq(vm._earlyPick([S('rycj', 'direct', 300, 'noburn'), S('x', 'direct', 9999, 'ads')], 50, 600, 2), null, '无硬广但该站绕开 worker(_adProxyBad) → 降为未评测,不立即播');
    eq(vm.srcProfile(S('rycj', 'direct', 300, 'noburn')).tier, 'insert', '_adProxyBad 运行时降级 noburn → insert(有插播)');
    eq(vm.srcProfile(S('rycj', 'proxy', 300, 'noburn', '', { _useProxy: true })).tier, 'noburn', '_useProxy 播放本身就过 worker → 仍算插播已去除');
    eq(vm.srcProfile(S('kz_moonci', 'kz', 300, 'clean')).tier, 'clean', 'clean 不受 _adProxyBad 影响');
}

// ===== 4b. 去广告是否在链路里 =====
console.log('[4b] _srcFilterOn:noburn 只有 worker 真在链路里才算插播已去除');
{
    const noCors = mk({ cors: false }).vm;
    eq(noCors.srcProfile(S('rycj', 'direct', 300, 'noburn')).tier, 'insert', '未配 CORS_PROXY_URL → 有插播(2026-10-05 用户实看到棋牌插片的场景)');
    eq(noCors.srcTierLabel(S('rycj', 'direct', 300, 'noburn')), '有插播', '未配代理 → 标签 有插播');
    eq(noCors.srcProfile(S('c', 'direct', 300, 'clean')).tier, 'clean', 'clean 不依赖 worker');
    const off = mk({ adFilter: false }).vm;
    eq(off.srcProfile(S('rycj', 'direct', 300, 'noburn')).tier, 'insert', '广告过滤开关关掉 → 有插播');
    eq(off.srcProfile(S('rycj', 'proxy', 300, 'noburn', '', { _useProxy: true })).tier, 'noburn', '开关关掉但走代理播放 → 仍过 worker');
    const r = noCors._pickPreferred([S('rycj', 'direct', 300, 'noburn'), S('u', 'direct', 250, null)]);
    eq(r.site_key, 'rycj', '有插播(2) 仍优先于 未评测(3)');
    eq(noCors._earlyPick([S('rycj', 'direct', 300, 'noburn')], 50, 600, 2), null, '有插播不算"干净快线",不立即起播');
}

{
    // clip:如意的中插只能靠播放器按分辨率跳 → 原生 HLS(iOS/Safari)上跳不了 → 有插播
    const R = () => S('rycj', 'direct', 300, null);
    const P = { rycj: { tier: 'noburn', res: '1080p', clip: 1 } };
    eq(mk({ profiles: P }).vm.srcProfile(R()).tier, 'noburn', 'clip 站:hls.js 通道能跳 → 仍算插播已去除');
    eq(mk({ profiles: P, nativeHls: true }).vm.srcProfile(R()).tier, 'insert', 'clip 站:原生 HLS 跳不了 → 有插播');
    eq(mk({ profiles: { ffzy: { tier: 'noburn' } }, nativeHls: true }).vm.srcProfile(S('ffzy', 'direct', 300, null)).tier, 'noburn', '非 clip 站:原生 HLS 照样靠 worker 去插播');
    eq(mk({ profiles: P }).vm.srcProfile(R()).clip, true, 'srcProfile 透出 clip');
}

{
    const { vm } = mk();
    eq(vm._pickPreferred([S('c80', 'direct', 80, 'clean', '720p'), S('c1950', 'direct', 1950, 'clean', '1080p')]).site_key, 'c80', '两条都是无广告:2s 豁免不让 1950ms 压过 80ms(豁免者之间按自己的相对窗口)');
    eq(vm._pickPreferred([S('nb300', 'direct', 300, 'noburn'), S('c1900', 'direct', 1900, 'clean')]).site_key, 'nb300', '插播已去除 300ms vs 无广告 1900ms → 300ms(同显示为无广告)');
    eq(vm._pickPreferred([S('ads', 'direct', 61, 'ads'), S('nb', 'direct', 873, 'noburn'), S('c', 'direct', 1900, 'clean')]).site_key, 'nb', '有水印 61 / 插播已去除 873 / 无广告 1900 → 873(仍救得出被挤掉的干净线路)');
    const off = mk({ profiles: { rycj: { tier: 'noburn', clip: 1 } }, adFilter: false }).vm;
    eq(off.srcProfile(S('rycj', 'proxy', 300, null, '', { _useProxy: true })).tier, 'insert', 'clip 站 + 广告过滤关 + 走代理 → 有插播(去插播跳过器跟随开关,也关了)');
    const nocors = mk({ profiles: { rycj: { tier: 'noburn', note: '插播会被自动去除' } }, cors: false }).vm;
    ok(!/自动去除/.test(nocors.srcTitle(S('rycj', 'direct', 300, null))), '降级成有插播时 tooltip 不再附"会被自动去除"的备注');
    ok(/自动去除/.test(mk({ profiles: { rycj: { tier: 'noburn', note: '插播会被自动去除' } } }).vm.srcTitle(S('rycj', 'direct', 300, null))), '没降级时照常附备注');
}

{
    // 动漫巴士(kz HLS):公网部署时清单也经 worker 去广告 → 算插播已去除;本地开发 worker 够不着 → 有插播
    const P = { kz_dm84: { tier: 'noburn', res: '1080p' } };
    eq(mk({ profiles: P, host: 'ednovas.video' }).vm.srcProfile(S('kz_dm84', 'kz', 900, null)).tier, 'noburn', '动漫巴士 + 公网域名 + 去广告开着 → 无广告(清单经 worker 过滤)');
    eq(mk({ profiles: P, host: 'ednovas.video' }).vm.srcTierLabel(S('kz_dm84', 'kz', 900, null)), '无广告', '动漫巴士公网显示 无广告');
    for (const host of ['localhost', '127.0.0.1', '192.168.1.5', 'nas.local'])
        eq(mk({ profiles: P, host }).vm.srcProfile(S('kz_dm84', 'kz', 900, null)).tier, 'insert', '动漫巴士 + ' + host + '(worker 拉不到本站)→ 有插播');
    eq(mk({ profiles: P, host: 'ednovas.video', adBad: { kz_dm84: 1 } }).vm.srcProfile(S('kz_dm84', 'kz', 900, null)).tier, 'insert', 'worker 实测拉不到(记账)→ 有插播');
    eq(mk({ profiles: P, host: 'ednovas.video', cors: false }).vm.srcProfile(S('kz_dm84', 'kz', 900, null)).tier, 'insert', '没配代理 → 有插播');
    ok(html.indexOf("const kzHls = !!(this._activeKz && this._activeKz.type === 'hls' && this._kzWorkerOk());") > 0 &&
        html.indexOf("const isDirectM3U8 = ((url && url.includes('.m3u8')) || kzHls) &&") > 0, 'play():kz HLS 清单也路由到 worker');
}

// ===== 5. srcProfile / 标签 =====
console.log('[5] srcProfile 数据来源与标签');
{
    const { vm } = mk({ profiles: { rycj: { tier: 'noburn', res: '1080p', geo: 0, note: '片尾偶有12秒插播' }, ffzy: { t: 'noburn', r: '1080p', geo: 1 }, weird: { tier: 'bogus' } } });
    eq(vm.srcProfile(S('rycj', 'proxy', 1, null)).tier, 'noburn', '无 site_profile → 查 siteProfiles 表');
    eq(vm.srcProfile(S('rycj', 'proxy', 1, 'ads')).tier, 'ads', 'site_profile 优先于表');
    eq(vm.srcProfile(S('ffzy', 'proxy', 1, null)).tier, 'noburn', '兼容短键 t/r');
    eq(vm.srcProfile(S('ffzy', 'proxy', 1, null)).geo, true, 'geo → 海外受限');
    eq(vm.srcProfile(S('weird', 'proxy', 1, null)).tier, 'unknown', '非法 tier → unknown');
    eq(vm.srcProfile(S('nope', 'proxy', 1, null)).tier, 'unknown', '不在表里 → unknown');
    eq(vm.srcProfile(null).tier, 'unknown', 'null → unknown');
    eq(vm.srcResLabel(S('rycj', 'proxy', 1, null)), '1080P', '1080p → 1080P');
    eq(vm.srcResLabel(S('a', 'proxy', 1, 'ads', '720p')), '720P', '720p → 720P');
    eq(vm.srcResLabel(S('a', 'proxy', 1, 'ads', 'sd')), '标清', 'sd → 标清');
    eq(vm.srcResLabel(S('a', 'proxy', 1, 'ads', '')), '', '无分辨率 → 不显示');
    eq(vm.srcTierLabel(S('a', 'proxy', 1, 'ads')), '有水印', 'ads → 有水印');
    eq(vm.srcTierLabel(S('a', 'direct', 1, 'noburn')), '无广告', 'noburn + 去广告生效 → 显示 无广告');
    eq(vm.srcGroupOf(S('a', 'direct', 1, 'noburn')), 'clean', 'noburn 徽章颜色走 clean');
    eq(vm.srcTierLabel(S('a', 'direct', 1, 'insert')), '有插播', 'insert → 有插播');
    eq(vm.srcTierLabel(S('kz_dm84', 'kz', 700, 'noburn')), '有插播', 'kz 的 noburn → 有插播(kz HLS 不过 worker)');
    ok(/片尾偶有12秒插播/.test(vm.srcTitle(S('rycj', 'proxy', 1, null))), 'title 带 note');
    ok(/海外受限/.test(vm.srcTitle(S('ffzy', 'proxy', 1, null))), 'title 带 海外受限');
    ok(/测速未通过/.test(vm.srcTitle(S('ffzy', 'server', 2600, null, '', { _srvOnly: true }))), '用户端真测过只有服务器能通 → title 说明可能无法播放');
    ok(!/测速未通过/.test(vm.srcTitle(S('ffzy', 'server', 2600, null))), '没在用户端测过的服务器档(详情兜底/历史快照)→ 不说测速未通过');
}

// ===== 6. sourceGroups / availableSources =====
console.log('[6] sourceGroups 分组排序');
{
    const sources = [
        S('ads_fast720', 'direct', 100, 'ads', '720p'),
        S('ads_fast1080', 'direct', 450, 'ads', '1080p'),
        S('ads_slow1080', 'proxy', 900, 'ads', '1080p'),
        S('unk', 'server', 300, null, '', { _srvOnly: true }),
        S('hist', null, 999, null),
        S('nb_slow', 'proxy', 2000, 'noburn', '1080p'),
        S('nb_fast', 'proxy', 500, 'noburn', '1080p'),
        S('kz_moonci', 'kz', 650, 'clean', '1080p'),
        S('testing', 'direct', '...', 'clean'),
        S('dead', 'direct', 9999, 'clean'),
        S('failed', 'direct', 9998, 'clean'),
        S('kz_mis', 'kz', 8999, 'clean', '', { _kzMismatch: true }),
    ];
    const { vm } = mk({ sources });
    const g = vm.sourceGroups;
    eq(g.map(x => x.tier).join(','), 'clean,ads,unreach', '组顺序:无广告 > 有插播 > 有水印 > 可能无法播放(没有单独的"未评测"组;空组不出现)');
    eq(keys(g[0].items), 'nb_fast,kz_moonci,nb_slow,kz_mis', '无广告组(clean+插播已去除合并):快线在前 → 档位 → 分辨率;年份不符 kz 垫底');
    eq(keys(g[1].items), 'ads_fast1080,ads_fast720,ads_slow1080', '组内:快线 → 分辨率高 → 延迟低');
    eq(keys(g[2].items), 'hist,unk', '可能无法播放组 = 未评测(用户端测得通/没测过的在前)+ 用户端只有服务器能通的');
    eq(g.map(x => x.offset).join(','), '0,4,7', 'offset 累加(tabindex 用)');
    eq(keys(vm.availableSources), 'nb_fast,kz_moonci,nb_slow,kz_mis,ads_fast1080,ads_fast720,ads_slow1080,hist,unk', 'availableSources = 分组展开顺序(未评测与不可达的在最后 → 自动换源也最后试)');
    ok(!vm.sourceGroups.some(x => x.tier === 'unknown'), '不再有单独的"未评测"分组');
    eq(vm.srcTierLabel(S('u', 'direct', 300, null)), '未评测', '未评测线路的徽章文字照旧(在"可能无法播放"组里也能看出是未评测)');
    ok(!vm.availableSources.some(s => ['testing', 'dead', 'failed'].indexOf(s.site_key) >= 0), "'...'/9999/9998 不显示");
    eq(keys(vm.fastSources), 'nb_fast,ads_fast1080,ads_fast720,unk', 'fastSources = <600');
    eq(keys(vm.slowSources), 'kz_moonci,nb_slow,kz_mis,ads_slow1080,hist', 'slowSources = >=600');
    eq(vm.fastSources.length + vm.slowSources.length, vm.availableSources.length, 'fast+slow = 全部');
    ok(vm.availableSources.every(s => sources.indexOf(s) >= 0), '元素是原线路对象本身(换源 indexOf / switchSource 依赖)');
    // 可能无法播放组内:档位优先(不看快慢);海外受限但本机直连测通的留在原分组
    const g2 = mk({ sources: [S('s_ads', 'server', 300, 'ads', '', { _srvOnly: true }), S('s_nb', 'server', 2500, 'noburn', '', { _srvOnly: true }), Object.assign(S('geo_ok', 'direct', 800, 'noburn'), { site_profile: { tier: 'noburn', res: '1080p', geo: 1 } })] }).vm.sourceGroups;
    eq(g2.map(x => x.tier + ':' + keys(x.items)).join(' | '), 'clean:geo_ok | unreach:s_nb,s_ads', '国内用户测通的海外受限线路留在原组;不可达组按档位排');
    const empty = mk({ sources: [] }).vm;
    eq(empty.sourceGroups.length, 0, '无线路 → 无分组');
    eq(empty.availableSources.length, 0, '无线路 → availableSources 空(模板显示"所有采集站均不可用")');
}

// ===== 7. _failoverNext 绕圈换源 =====
console.log('[7] _failoverNext 绕圈 + 已试排除');
{
    const A = S('A', 'direct', 100, 'clean'), B = S('B', 'proxy', 300, 'noburn'), C = S('C', 'proxy', 200, 'ads'), D = S('D', 'proxy', 250, 'ads');
    const KM = S('kz_mis', 'kz', 8000, 'clean', '', { _kzMismatch: true });
    const list = [A, B, C, KM, D];
    const h = mk({ noEp: { B: 1 } });
    const vm = h.vm;
    eq(vm._failoverNext(list, C, '第1集').site_key, 'D', 'C 失败 → 跳过年份不符 kz → D');
    eq(vm._failoverNext(list, D, '第1集').site_key, 'A', 'D(末尾)失败 → 绕回 A(旧版此处直接报"所有线路均无法播放")');
    eq(vm._failoverNext(list, A, '第1集').site_key, 'C', 'A 失败 → B 没有这一集,跳到 C');
    eq(vm._failoverNext(list, A, null).site_key, 'B', '不知道集名 → 按顺序 B');
    eq(vm._failoverNext([A, B], A, '第1集').site_key, 'B', '其余都没有这一集 → 仍按顺序试 B');
    C._failNav = h.getNav();
    eq(vm._failoverNext(list, B, '第1集').site_key, 'D', '本次导航已试过的 C 跳过');
    h.setNav(h.getNav() + 1);
    eq(vm._failoverNext(list, B, '第1集').site_key, 'C', '换了导航(新剧)后 _failNav 失效');
    eq(vm._failoverNext([A], A, '第1集'), null, '只剩自己 → null(走"所有线路均无法播放"/离线兜底)');
    eq(vm._failoverNext([KM], A, '第1集'), null, '只剩年份不符 kz → null');
    eq(vm._failoverNext(list, S('X', 'direct', 100, 'clean'), '第1集').site_key, 'A', '失败线路不在列表里 → 从头');
    const A2 = Object.assign({}, A);  // 同 site_key 不同对象(同卡片同站两条)
    eq(vm._failoverNext(list, A2, null).site_key, 'B', '按 site_key 兜底定位');
}
{
    // 端到端:模拟逐个失败(失败即 latency=9998 + _failNav),从中间起播,所有可用线路都恰好试一次再报全挂
    const srcs = [S('a', 'proxy', 300, 'ads'), S('b', 'proxy', 400, 'clean'), S('c', 'direct', 500, 'noburn'), S('d', 'server', 700, null), S('kz_moonci', 'kz', 900, 'clean'), S('kz_bad', 'kz', 8999, 'clean', '', { _kzMismatch: true })];
    const h = mk({ sources: srcs });
    const vm = h.vm;
    let cur = vm.availableSources.find(s => s.site_key === 'kz_moonci');   // 自动选中的在列表中间
    eq(vm.availableSources.indexOf(cur), 2, '起播线路确实在列表中间');
    const tried = [cur.site_key];
    for (let guard = 0; guard < 20; guard++) {
        const next = vm._failoverNext(vm.availableSources, cur, null);
        cur.latency = 9998; cur._failNav = h.getNav();
        if (!next) break;
        tried.push(next.site_key);
        cur = next;
    }
    eq(tried.slice().sort().join(','), 'a,b,c,d,kz_moonci', '从中间起播:5 条可自动换的线路全部各试一次(年份不符 kz 不试)');
    eq(new Set(tried).size, tried.length, '没有重复尝试');
}

// ===== 8. openDetail 守卫的静态检查 =====
console.log('[8] openDetail 守卫静态检查');
{
    const od = extractMember('openDetail').body;
    const sets = od.split('\n').map((l, i, arr) => ({ l, i, arr })).filter(x => /hasAutoSelected = true/.test(x.l));
    eq(sets.length, 3, 'hasAutoSelected = true 只出现 3 处(提前起播 / 3s 定时器 / 6.5s 晚定时器)');
    ok(sets.every(x => /if \(!r\) return;|if \(pick\) \{/.test(x.arr.slice(Math.max(0, x.i - 2), x.i).join('\n'))), '每处都紧跟在"真选中了源"之后(3s 死锁修复保留)');
    ok(/const MAX_WAIT_TIME = 3000;/.test(od), 'MAX_WAIT_TIME 仍是 3000');
    ok(/if \(_openSeq !== _navSeq\) return;  \/\/ 🧭 已切换到别的剧，停止自动选源/.test(od), 'checkEarlyReturn 导航令牌守卫在');
    ok(/if \(_openSeq !== _navSeq\) return;  \/\/ 🧭 已切换到别的剧，放弃超时自动选源/.test(od), '3s 定时器导航令牌守卫在');
    ok(/const lateReturnTimer = setTimeout\(\(\) => \{\s*\n\s*if \(_openSeq !== _navSeq\) return;/.test(od), '6.5s 晚定时器导航令牌守卫在');
    ok(/clearTimeout\(earlyReturnTimer\);\s*\n\s*clearTimeout\(lateReturnTimer\);\s*\n\s*clearTimeout\(earlySettleTimer\);/.test(od), '完成时三个定时器都清掉');
    ok(/if \(\(hasAutoSelected \|\| this\._manualPickNav === _openSeq\) && this\.currentSource && this\.currentUrl\)/.test(od), '完成路径不打断正在播放的线路(自动选的或用户手选的)');
    ok((od.match(/if \(hasAutoSelected \|\| this\._manualPickNav === _openSeq\) return;/g) || []).length === 3, '提前起播 / 3s / 6.5s 三处都给用户手选让路');
    ok(/@click="pickSourceManual\(source\)" @keydown\.enter="pickSourceManual\(source\)"/.test(html), '线路按钮走 pickSourceManual(记下本次导航的手选)');
    ok(/this\._autoPick\(this\.currentGroup\.sources, 3\)/.test(od) && /this\._autoPick\(this\.currentGroup\.sources, testing \? 1 : 2\)/.test(od) && /this\._autoPick\(this\.currentGroup\.sources, 2\)/.test(od),
        '3s 定时器:还有线路在测时只选直连/代理(服务器档注定播不了)/ 6.5s 晚定时器 maxClass=2 / 完成路径 maxClass=3');
    // 测速缓存:命中项在进测速池之前一次性套用;服务器档可缓存;一部剧自己的失败不写死亡缓存
    ok(/const misses = \[\];/.test(od) && /await runWithConcurrency\(misses, 6, testWorker\);/.test(od), '缓存命中不进测速池(回访 0 等待)');
    ok(/this\._siteHealthSet\(source\.site_key, source, !source\._timedOut && !source\._noDeadCache, srvOK\)/.test(od) &&
        /const srvOK = !!source\._srvOnly && !source\._timedOut && !source\._clientTimeout && !source\._noServerCache &&/.test(od) &&
        /this\._siteServerConfirmed\(source\.site_key, source\.vod_id\)/.test(od),
        '超时/单剧失败不写死亡缓存;"只有服务器能通"要用户端真测过、非瞬态、非单剧问题、且两部不同的剧都这样才按站点缓存');
    ok(/if \(source\.vod_play_url && !this\._isKzSource\(source\)\) \{\s*\n\s*detail = \{ vod_play_url: source\.vod_play_url \};/.test(od), '测速直接用搜索结果自带的选集,不再每条拉 /api/detail(kz 除外)');
    const hpe = extractMember('handlePlaybackError').body;
    ok(/if \(nextSource\) \{/.test(hpe) && !/currentIndex < allSources\.length - 1/.test(hpe), '换源分支条件改为 if (nextSource)');
    ok(/failingSource\._failNav = mySeq;/.test(hpe), '确认失败时标记 _failNav');
    ok(/if \(mySeq !== _navSeq\)/.test(hpe), '换源宽限期导航令牌守卫在');
    const tpl = html.slice(html.indexOf('<div class="source-list" v-if="fastSources.length > 0'), html.indexOf('<!-- 全部不可用提示 -->'));
    ok(!/直连|中转|服务器端测速/.test(tpl.replace(/<!--[\s\S]*?-->/g, '')), '模板里已无 直连/中转/服务 角标');
    ok(/:tabindex="Math\.min\(10 \+ g\.offset \+ i, 98\)"/.test(tpl), 'tabindex = 10+offset+i,封顶 98(不撞 TV 控制栏 99+)');
}

// ===== 9. 复审补丁 =====
console.log('[9] 复审补丁');
{
    const { vm } = mk();
    // F1 _earlyPick 绝不越档:2 条含广告直连快线 + 1 条无硬广代理快线 → 直连
    const r1 = vm._earlyPick([S('d1', 'direct', 100, 'ads'), S('d2', 'direct', 300, 'ads'), S('p', 'proxy', 200, 'noburn')], 10, 600, 2);
    eq(r1 && r1.src._testType, 'direct', 'F1: ≥2 直连快线(含广告) 先于 无硬广代理快线');
    eq(vm._earlyPick([S('d1', 'direct', 100, 'ads'), S('p', 'proxy', 200, 'clean')], 10, 600, 2), null, 'F1: 1 条直连快线 + 干净代理快线 → 先等(不越档)');
    const r1b = vm._earlyPick([S('d1', 'direct', 100, 'ads'), S('p', 'proxy', 200, 'clean')], 1300, 600, 2);
    eq(r1b && r1b.src.site_key, 'd1', 'F1: 1.2s 后 → 直连档');
    const r1c = vm._earlyPick([S('d1', 'direct', 1500, 'ads'), S('p', 'proxy', 200, 'clean')], 10, 600, 2);
    eq(r1c && r1c.src.site_key, 'p', 'F1: 直连只有慢线时 干净代理快线照旧立即起播(旧版"代理就绪即播")');
    // F2 _pickPreferred 全部 ≥3000 时守住相对窗口
    eq(vm._pickPreferred([S('a', 'direct', 3100, 'ads'), S('c', 'direct', 8900, 'clean')]).site_key, 'a', 'F2: 3100 含广告 vs 8900 无广告 → 3100');
    eq(vm._autoPick([S('d', 'direct', 3500, 'ads'), S('kz_7sefun', 'kz', 8000, 'clean')], 3).site_key, 'd', 'F2: 完成路径 直连 3500 含广告 vs kz 8000 无广告 → 直连');
    eq(vm._pickPreferred([S('a', 'direct', 3100, 'ads'), S('c', 'direct', 5000, 'clean')]).site_key, 'c', 'F2: 窗口内(≤6200)仍按分级');
    // F3 kz 的"无硬广"不成立(kz HLS 不走 worker)
    eq(vm.srcProfile(S('kz_dm84', 'kz', 700, 'noburn')).tier, 'insert', 'F3: kz 的 noburn → 有插播(kz HLS 不过 worker)');
    eq(vm.srcProfile(S('kz_dm84', undefined, 700, 'noburn')).tier, 'insert', 'F3: 未测速的 kz(按 key 认)同样降级');
    eq(vm.srcProfile(S('rycj', 'proxy', 700, 'noburn')).tier, 'noburn', 'F3: maccms 无硬广不受影响');
}
{
    // F4 HEVC 源只在本机能解码时进 0 档
    const no = mk({ hevc: false }).vm, yes = mk({ hevc: true }).vm;
    const mo = () => S('kz_moonci', 'kz', 900, 'clean', '1080p', null, 'hevc');
    eq(no._srcReachClass(mo()), 3, 'F4: 不支持 HEVC → 月之祠 3 档(兜底)');
    eq(yes._srcReachClass(mo()), 0, 'F4: 支持 HEVC → 月之祠 0 档');
    eq(no._srcReachClass(S('kz_7sefun', 'kz', 900, 'clean', '1080p')), 0, 'F4: 七色番(H.264)不受影响');
    eq(no._autoPick([S('p', 'proxy', 300, 'ads'), mo()], 2).site_key, 'p', 'F4: 不支持 HEVC 时 代理含广告 胜过 HEVC kz');
    eq(no.srcProfile(mo()).codec, 'hevc', 'F4: srcProfile 透出 codec');
    eq(no.srcProfile(S('x', 'proxy', 1, null)).codec, '', 'F4: 未评测 codec 为空');
    ok(/H\.265/.test(no.srcTitle(mo())) && !/H\.265/.test(yes.srcTitle(mo())), 'F4: 不支持时 title 提示 H.265');
    // 真实 _srcHevcOk:假 window.MediaSource
    const m = extractMember('_srcHevcOk');
    const mkHevc = (MS) => new Function('window', 'return {_srcHevcOk(' + m.params + ') ' + m.body + '};')({ MediaSource: MS });
    let calls = 0;
    const o1 = mkHevc({ isTypeSupported: t => { calls++; return /hvc1/.test(t); } });
    eq(o1._srcHevcOk(), true, 'F4: isTypeSupported(hvc1) → true');
    o1._srcHevcOk();
    eq(calls, 1, 'F4: 只探一次');
    eq(mkHevc({ isTypeSupported: () => false })._srcHevcOk(), false, 'F4: 不支持 → false');
    eq(mkHevc(undefined)._srcHevcOk(), false, 'F4: 无 MediaSource → false');
    eq(mkHevc({ isTypeSupported: () => { throw new Error('x'); } })._srcHevcOk(), false, 'F4: 抛错 → false');
}

// ===== 9b. 站点健康缓存 =====
console.log('[9b] _siteHealthGet/_siteHealthSet');
{
    const g = extractMember('_siteHealthGet'), st = extractMember('_siteHealthSet');
    const store = {};
    const LS = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
    let now = 1e12;
    const FakeDate = { now: () => now };
    const vm = new Function('localStorage', 'Date', 'return {_siteHealthGet(' + g.params + ') ' + g.body + ', _siteHealthSet(' + st.params + ') ' + st.body + '};')(LS, FakeDate);
    vm._siteHealthSet('srv', { latency: 800, _testType: 'server' }, true, false);
    eq(vm._siteHealthGet('srv'), null, '服务器档:没给 allowServer(刷新线路)→ 不缓存');
    vm._siteHealthSet('srv', { latency: 800, _testType: 'server' }, true, true);
    eq(vm._siteHealthGet('srv') && vm._siteHealthGet('srv')._testType, 'server', '服务器档:全量测速 → 缓存');
    now += 5.9 * 3600e3;
    ok(!!vm._siteHealthGet('srv'), '服务器档 5.9h 内仍命中');
    now += 0.2 * 3600e3;
    eq(vm._siteHealthGet('srv'), null, '服务器档 6h 过期(海外受限站 6h 后照样重测)');
    vm._siteHealthSet('ok', { latency: 300, _testType: 'direct' }, false, false);
    now += 2.9 * 24 * 3600e3;
    ok(!!vm._siteHealthGet('ok'), '直连测通 3 天内命中');
    vm._siteHealthSet('dead', { latency: 9999, _testType: 'server' }, false, true);
    eq(vm._siteHealthGet('dead'), null, '9999 没给 allowDead(超时/单剧失败)→ 不写死亡缓存');
    vm._siteHealthSet('dead', { latency: 9999 }, true, true);
    eq(vm._siteHealthGet('dead') && vm._siteHealthGet('dead').latency, 9999, '9999 全量测速确认 → 12h 死亡缓存');
    vm._siteHealthSet('mid', { latency: '...' }, true, true);
    store.donggua_site_health2 = JSON.stringify(Object.assign(JSON.parse(store.donggua_site_health2 || '{}'), { oldsrv: { latency: 1321, testType: 'server', ts: now } }));
    eq(vm._siteHealthGet('oldsrv') && vm._siteHealthGet('oldsrv')._srvOnly, true, '旧版本写的 server 缓存(没有 srvOnly 字段)回放时也算只有服务器能通 → 可能无法播放');
    eq(vm._siteHealthGet('mid'), null, "测速中('...')不存");
}

// ===== 10. splitSameNameWorks 同名拆分 + 去重 =====
console.log('[10] splitSameNameWorks');
{
    const fnStart = html.indexOf('function splitSameNameWorks(');
    ok(fnStart > 0, 'splitSameNameWorks 存在');
    const split = new Function('SRC_TIER_RANK', html.slice(fnStart, matchBrace(html, html.indexOf('{', fnStart)) + 1) + '\nreturn splitSameNameWorks;')({ clean: 0, noburn: 1, insert: 2, unknown: 3, ads: 4 });
    const fx = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/sources/zhetian-search.json'), 'utf8')).items;
    const SEP = '$' + '$' + '$';
    const rebuild = x => ({
        site_key: x.site_key, site_name: x.site_name, vod_id: x.vod_id, vod_name: x.vod_name, vod_year: x.vod_year, vod_remarks: x.vod_remarks,
        site_profile: x.tier ? { tier: x.tier } : null,
        vod_play_url: x.roads.map(r => [r.first].concat(Array.from({ length: Math.max(0, r.n - 1) },
            (_, i) => '第' + (i + 2) + '集$https://e.example/' + x.site_key + '/' + i + '.m3u8')).join('#')).join(SEP)
    });
    const firstOf = it => { const e = it.vod_play_url.split(SEP)[0].split('#')[0]; return e.slice(e.indexOf('$') + 1); };
    const zt = fx.filter(x => x.vod_name === '遮天').map(rebuild);
    const w = split(zt);
    eq(w.length, 4, '遮天:拆成 4 部(2023 动画 / 2025 电影 / 2023 单集 / 2025 短剧)');
    eq(w[0].work, '', '主作品 work 为空串(卡片/历史/刷新线路对得上旧数据)');
    ok(/^2023 · 18\d集$/.test(w[0].label), '主作品标注 2023 · 18x集: ' + w[0].label);
    ok(w[0].items.length >= 15, '主作品 ≥15 条: ' + w[0].items.length);
    ok(!w[0].items.some(i => i.site_key === 'zy360b'), '360资源2(与 360资源 首集地址相同)被去重');
    ok(w.every(g => new Set(g.items.map(i => i.site_key)).size === g.items.length), '每部作品里同一个站只出现一次(用户报的"多个资源站重复")');
    eq((w.find(g => g.work === 'y2025m') || {}).label, '2025 · 全1集', '2025 电影单独一张卡');
    ok(w.every(g => { const f = g.items.map(firstOf).filter(Boolean); return new Set(f).size === f.length; }),
        '同一部里没有首集地址相同的两条(速博=新浪/金鹰=虎牙/U酷=优酷 只留一条;kz 搜索结果无选集不参与)');
    const kz7 = w[0].items.filter(i => i.site_key === 'kz_7sefun');
    eq(kz7.length, 1, '七色番同名两条(183话/177话)只留一条');
    eq(kz7[0] && kz7[0].vod_remarks, '更新至183话', '留集数多的那条');
    ok(zt.every(i => w.some(g => g.items.some(j => firstOf(j) === firstOf(i)))), '去重不丢片源:每个首集地址都还在某张卡里');
    const dz = split(fx.filter(x => x.vod_name === '弹指遮天').map(rebuild));
    ok(dz.length >= 1 && dz.every(g => new Set(g.items.map(i => i.site_key)).size === g.items.length), '弹指遮天:同站不重复');
    // 没有冲突证据 → 不拆(旧行为)
    const mk1 = (k, eps, y, extra) => Object.assign({
        site_key: k, site_name: k, vod_id: k + eps, vod_year: y || '',
        vod_play_url: Array.from({ length: eps }, (_, i) => '第' + (i + 1) + '集$https://' + k + '.example/' + eps + '/' + i + '.m3u8').join('#')
    }, extra || {});
    const one = split([mk1('a', 40, '2024'), mk1('b', 12, '2024'), mk1('c', 1, '2020')]);
    eq(one.length, 1, '没有"同一个站两部"的证据 → 不拆(更新落后/年份乱写的站不会被拆成单线路卡片)');
    eq(one[0].label, '', '不拆时不显示标注');
    // 有证据时,更新落后的站归到最近的作品,不凭空多出卡片
    const two = split([mk1('a', 40, '2024'), mk1('a', 1, '2025'), mk1('b', 15, '2024'), mk1('c', 1, '2025')]);
    eq(two.length, 2, '证据站 a(剧+电影)→ 2 部');
    eq(two[0].items.map(i => i.site_key).sort().join(','), 'a,b', '落后的 b(15 集)归到剧集');
    eq(two[1].items.map(i => i.site_key).sort().join(','), 'a,c', '电影归电影');
    // 同站两条但其实是同一部(集数接近、同年)→ 不算证据,只去重
    const same = split([mk1('a', 40, '2024'), mk1('a', 38, '2024'), mk1('b', 40, '2024')]);
    eq(same.length, 1, '同站两条集数接近 → 不拆');
    eq(same[0].items.filter(i => i.site_key === 'a').length, 1, '只去重,留集数多的');
    // 集数未知(kz 搜索结果无选集、备注也没数字)→ 归主作品
    const three = split([mk1('a', 40, '2024'), mk1('a', 1, '2025'), mk1('b', 38, '2024'), { site_key: 'kz_x', site_name: 'kz', vod_id: 1, vod_play_url: '', vod_remarks: 'HD' }]);
    ok(three[0].items.some(i => i.site_key === 'kz_x'), '集数未知的归主作品');
    // 同片源:档位好的胜出
    const base = mk1('ads1', 30, '2024', { site_profile: { tier: 'ads' } });
    const dupTier = split([base, Object.assign(mk1('nb1', 30, '2024'), { site_profile: { tier: 'noburn' }, vod_play_url: base.vod_play_url })]);
    eq(dupTier[0].items.map(i => i.site_key).join(','), 'nb1', '同片源同集数 → 留档案档位好的');
    eq(split([]).length, 1, '空输入不抛');
    eq(split([])[0].items.length, 0, '空输入 → 空组(调用方跳过)');
    // 站内重复上架的旧副本(首集地址相同)不算"两部"的证据(审查:猫眼 2023/183 与 2025/55 是同一部)
    const twinUrl = (k, eps) => Array.from({ length: eps }, (_, i) => '第' + (i + 1) + '集$https://cdn' + (i % 3) + '.' + k + '.example/2024/abc/' + i + '.m3u8').join('#');
    const a40 = mk1('a', 40, '2024'), a16 = Object.assign(mk1('a', 16, '2025'), { vod_play_url: twinUrl('a', 16) });
    a40.vod_play_url = twinUrl('a', 40);
    const tw = split([a40, a16, mk1('b', 40, '2024'), mk1('c', 22, '2024'), mk1('d', 20, '2024'), mk1('e', 18, '2024')]);
    eq(tw.length, 1, '站内新旧两份(首集地址同、只差域名)→ 不拆');
    eq(tw[0].items.filter(i => i.site_key === 'a').length, 1, '旧副本去重');
    // 与到达顺序无关
    // 同片源多站去重时留谁 = 先到的(更快的 API),这一项本来就随到达顺序;比的是:分成哪几部、每部多少条、各自含哪些片源
    const sig = ws => ws.map(w => w.label + ':' + w.items.length + ':' + w.items.map(firstOf).sort().join(',')).sort().join(' | ');
    const zt2 = zt.slice().reverse();
    eq(sig(split(zt2)), sig(split(zt)), '遮天:输入顺序反过来结果一样(SSE 到达顺序不影响)');
    // 年份不同的同名综艺(同站各年都有)→ 每一年都还在某张卡里,且标注年份 = 卡里条目的年份
    const seasons = [];
    ['s1', 's2', 's3', 's4'].forEach(k => [2019, 2020, 2021, 2022, 2023, 2024].forEach(y => { const it = Object.assign(mk1(k, 48 + (y % 3), String(y)), { vod_id: k + y }); it.vod_play_url = it.vod_play_url.split('.example/').join('.example/' + y + '/'); seasons.push(it); }));
    for (const order of [seasons, seasons.slice().reverse()]) {
        const ws = split(order);
        const years = new Set();
        ws.forEach(w => w.items.forEach(i => years.add(i.vod_year)));
        eq([...years].sort().join(','), '2019,2020,2021,2022,2023,2024', '同名综艺 2019-2024:没有哪一年被去重吃掉');
        ok(ws.every(w => !w.label || w.items.every(i => w.label.indexOf(i.vod_year) === 0) || new Set(w.items.map(i => i.vod_year)).size > 1), '标注年份与卡里条目一致');
        ok(ws.every(w => new Set(w.items.map(i => i.site_key)).size === w.items.length), '同名综艺:每张卡里同站只出现一次');
    }
    ok(split(zt).every(w => typeof w.sig === 'string') && split(zt)[0].sig !== '' && split([mk1('a', 40, '2024')])[0].sig === '', 'sig:拆了才有(与名次无关),没拆为空');
    // 原型合并与到达顺序无关(全连接):同一个站互相冲突的两条绝不并进同一部、也不会被去重吃掉(审查复现用例)
    {
        const u = (k, n, tag) => Array.from({ length: n }, (_, i) => '第' + (i + 1) + '集$https://' + k + '.example/' + tag + '/' + i + '.m3u8').join('#');
        const it = (k, n, tag) => ({ site_key: k, site_name: k, vod_id: k + tag, vod_year: '2024', vod_play_url: u(k, n, tag) });
        const A = [it('a', 60, 'x'), it('a', 1, 'm'), it('b', 35, 'p'), it('b', 100, 'q'), it('c', 36, 'r'), it('d', 98, 's'), it('e', 1, 't')];
        const B = [A[2], A[3], A[0], A[1], A[4], A[5], A[6]];
        const view = ws => ws.map(w => w.sig + ':' + w.items.map(i => i.vod_id).sort().join(',')).sort().join(' | ');
        eq(view(split(B)), view(split(A)), '冲突站先到/后到,拆分结果完全一样');
        const all = new Set(); split(A).forEach(w => w.items.forEach(i => all.add(i.vod_id)));
        ok(all.has('bp') && all.has('bq'), '同站冲突的 35 集与 100 集两条都还在(没有被同站去重吃掉)', [...all]);
    }
    // 同年同类型的两部:签名按集数量级区分,与谁的线路多无关
    {
        const u = (k, n, tag) => Array.from({ length: n }, (_, i) => '第' + (i + 1) + '集$https://' + k + '.example/' + tag + '/' + i + '.m3u8').join('#');
        const it = (k, n, tag) => ({ site_key: k, site_name: k, vod_id: k + tag, vod_year: '2024', vod_play_url: u(k, n, tag) });
        const tvMore = [it('a', 40, 'tv'), it('a', 100, 'sd'), it('b', 40, 'tv'), it('c', 40, 'tv'), it('d', 100, 'sd')];
        const sdMore = [it('a', 40, 'tv'), it('a', 100, 'sd'), it('b', 100, 'sd'), it('c', 100, 'sd'), it('d', 40, 'tv')];
        const sigOfEps = (ws, n) => (ws.find(w => w.items.some(i => i.vod_play_url.split('#').length === n)) || {}).sig;
        eq(sigOfEps(split(tvMore), 40), sigOfEps(split(sdMore), 40), '40 集那部的签名与线路多少无关');
        eq(sigOfEps(split(tvMore), 100), sigOfEps(split(sdMore), 100), '100 集那部的签名与线路多少无关');
        ok(sigOfEps(split(tvMore), 40) !== sigOfEps(split(tvMore), 100), '两部签名不同');
    }
    // 去重前成员(all):刷新线路认作品要用
    ok(split(zt).every(w => Array.isArray(w.all) && w.all.length >= w.items.length), 'works 带去重前的全部成员 all');

    // 调用方确实用上了(卡片 key 带 _work、历史补齐按 _work 对、刷新线路也拆)
    ok(html.indexOf(":key=\"group.name + '|' + (group._work || '')\"") > 0, '卡片 key 含 _work(同名两张卡不撞 key)');
    ok(html.indexOf("const fresh = this.groupedList.find(g => g.name === name && (cs ? hasCur(g) : (!groupData._workSig || (g._workSig || '') === groupData._workSig)));") > 0, '历史补齐线路:有正在播放的线路就只认"含它的那张卡"(签名会随后续结果变)');
    ok(/const w = works\.find\(hasCur\) \|\| works\.find\(hadCur\) \|\|/.test(html), '刷新线路:当前线路被同片源去重掉了也认得出是哪一部(hadCur)');
    ok(/tryOpenDeepLink\(false, true\)/.test(html) && /!isFinal && !grace\) return;/.test(html), '深链 12s 兜底不被 &w= 挡住');
    ok(/const w = works\.find\(hasCur\) \|\|/.test(html), '刷新线路先按"含正在播放那条线路"认作品(名次会变,不按 _work)');
    ok(/u \+= '&w=' \+ encodeURIComponent\(this\.currentGroup\._workSig\)/.test(html) && /w: p\.get\('w'\) \|\| ''/.test(html), '深链带 &w= 作品签名,刷新/分享后开同一部');
    ok(/mergeInto\(host, g\.sources\)/.test(html), 'kz 变体片名并组时同站只留一条');
    ok(html.indexOf('splitSameNameWorks(matched)') > 0, '刷新线路也按作品拆');
    ok(html.indexOf('splitSameNameWorks(g.items)') > 0, 'groupedList 按作品拆');
}

console.log('\n' + (fail ? 'FAILED' : 'ALL PASSED') + ': ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
