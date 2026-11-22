// [adult] lib/site-catalog 各部分(主线程 / 写线程 / 读线程)共用的常量与纯函数(无 IO)。
'use strict';

const U = require('./util');

const F_ZH = 1, F_UNC = 2, F_LEAK = 4, F_CLIP = 8, F_UHD = 16;
// 审查过滤(每次读都套;入库时已经拦过,这里是第二道)
// + 规则代数:线路 / 作品的 rv = 按第几代规则入库的(adult_meta 'rv:gen',规则一变 +1,见 writer.js init/rescan)。
//   只有 rv ≥ 当前代的才读得到:规则变了之后旧行一律不出,重扫按新规则逐块重跑、跑完一块亮一块(目录不再整体回空,也不会露出没按新规则复查过的行)。
//   代数子查询不相关,SQLite 每条语句只算一次
const RV_GEN = "COALESCE((SELECT CAST(v AS INTEGER) FROM adult_meta WHERE k='rv:gen'), 0)";
//   + 第四阶段:w.hid = 0(后台隐藏的作品在每条读路径上都不出:快照 / 浏览卡片 / 查找 / 联想 / 作品页 / 封面 / 相关 / 刷一刷 / 热度)
const ELIG = "COALESCE(w.review,'') <> 'hide' AND (COALESCE(w.review,'') <> 'code' OR w.code_ok = 1) AND w.rv >= " + RV_GEN + ' AND w.hid = 0';
const ELIG_I = "COALESCE(i.review,'') <> 'hide' AND (COALESCE(i.review,'') <> 'code' OR i.code_ok = 1) AND i.rv >= " + RV_GEN;
const eligOk = (review, codeOk) => review !== 'hide' && (review !== 'code' || !!codeOk);
// 卡片要的列(w.dur = 展示时长:线路中位数,没有就 AVDB 片长;w.dur_med 只给作品键的时长闸用)
const WCOLS = 'w.id, w.wk, w.name, w.pic, w.pic_item, w.apic, w.bucket, w.code, w.dur, w.dur_med, w.n_sites, w.sites, w.first_site, w.flags, w.first_seen, w.released';

// 首页 13 个大类行(调研 §3 顺序)
const HOME_BUCKETS = ['cn_amateur', 'cn_studio', 'cn_hookup', 'live', 'creators', 'short', 'jp_censored', 'jp_uncensored', 'jp_subbed', 'western', 'anime', 'softcore', 'fetish'];
// 第三阶段浏览参数(契约 C)
const DUR_CLASSES = [['s', 1, 599, '10分钟内'], ['m', 600, 1799, '10-30分钟'], ['l', 1800, 3599, '30-60分钟'], ['xl', 3600, 7199, '1-2小时'], ['xxl', 7200, 1e9, '2小时以上'], ['unk', 0, 0, '时长未知']];
const VARIANTS = [['zh', '中字'], ['unc', '无码'], ['leak', '无码流出'], ['vr', 'VR'], ['4k', '4K'], ['vertical', '竖屏']];
const SORTS = [['new', '最新上架'], ['updated', '最近更新'], ['released', '发行日期'], ['hot', '本站热门'], ['dur', '时长'], ['lines', '线路最多'], ['rand', '随机']];
const SORT_IDS = new Set(SORTS.map((s) => s[0]));
const LEGACY_SORT = { random: 'rand', release: 'released', hot7: 'hot' };
const LEGACY_FLAG = { zh: 'zh', unc: 'unc' };   // flag=multi 单独处理(线路 ≥3)
// 旧 taxonomy 标签里的审查级(没有 lib/adult/tags 时的兜底)
const NONFEATURED_LEGACY = new Set(['noncon', 'incest', 'hypnosis', 'timestop', 'time_stop', 'rape', 'forced', 'sleep', 'drunk', 'teen', 'student']);
// 这些分区里的人名多半是素人 / 主播本人:作品页一律不给演员(调研 §6)
const NO_ACTRESS_BUCKETS = new Set(['cn_amateur', 'cn_hookup', 'live', 'creators']);
const MODES = new Set(['continuous', 'batch', 'stale']);
// AI 改写标题的站(2609 系 s04/s10/s14/s16/s27):站点表 aiTitles:true/false 优先,其余交给 lib/adult/tags 的默认表
function envFlag(v) { return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim()); }
function envOff(v) { return /^(0|false|no|off)$/i.test(String(v == null ? '' : v).trim()); }
function envInt(v, def, min) {
    if (v == null || String(v).trim() === '') return def;
    const n = Number(String(v).trim());
    return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
}

// 站点表一行 → 目录用的站点对象(可结构化克隆:写线程 / 读线程都收这个)
function normSite(s) {
    if (!s || typeof s !== 'object') return null;
    const key = typeof s.key === 'string' ? s.key.trim() : '';
    const api = typeof s.api === 'string' ? s.api.trim() : '';
    if (!key || key.length > 64 || !/^https?:\/\/[^\s#]+$/i.test(api) || /m3u8/i.test(api)) return null;
    return {
        key, api,
        name: U.clip(s.name || key, 60),
        search: s.search !== false,
        active: s.active !== false && !s.alias,
        codeTrust: s.codeTrust !== false,
        family: typeof s.family === 'string' && s.family ? U.clip(s.family, 40) : '',
        crawlMode: MODES.has(s.crawlMode) ? s.crawlMode : '',
        searchFirst: !!s.searchFirst,
        crawl: s.crawl !== false,
        strict: s.strict === true,
        nativeHls: s.nativeHls !== false,
        extHot: s.extHot === true,
        upstream: typeof s.upstream === 'string' && s.upstream ? U.clip(s.upstream, 40) : '',
        aiTitles: s.aiTitles === true ? true : s.aiTitles === false ? false : undefined,
        backfill: s.backfill !== false,
    };
}

const imgUrl = (wk, site) => '/api/img?k=' + encodeURIComponent(wk) + (site ? '&s=' + encodeURIComponent(site) : '');
function liveCount(sites, act) { let n = 0; for (const k of String(sites || '').split(',')) if (k && act.has(k)) n++; return n; }
// 卡片(首页 / 浏览 / 联想共用)。ctx = {t, act:Set|Map(启用站 key), imgProxy}
function card(w, ctx) {
    const n = liveCount(w.sites, ctx.act);
    const zh = (w.flags & F_ZH) || w.bucket === 'jp_subbed';
    const unc = (w.flags & F_UNC) || w.bucket === 'jp_uncensored';
    const badge = zh ? '中字' : unc ? '无码' : w.bucket === 'short' ? '竖屏' : '';
    const dur = w.dur || w.dur_med || 0;
    const sub = [U.relTime(w.first_seen, ctx.t), U.fmtDur(dur), n + '线'].filter(Boolean).join(' · ');
    let pic = '';
    // 封面:线路封面优先;没有线路封面 → AVDB 封面(代理开着时都走 /api/img,地址由服务器查)
    if (w.pic) pic = ctx.imgProxy ? imgUrl(w.wk, String(w.pic_item || '').split('|')[0]) : w.pic;
    else if (w.apic) pic = ctx.imgProxy ? imgUrl(w.wk, '') : w.apic;
    return { wk: w.wk, name: w.name, pic, sub, badge, bucket: w.bucket, code: w.code || '', dur, n_sites: n, first_seen: w.first_seen, released: w.released || '' };
}
const kindOfWk = (k) => (k.indexOf('#clip') >= 0 ? 'clip' : /#U(?=$|[#~])/.test(k) ? 'U' : 'main');
// 同一部片的一家子(相关推荐要排除):番号作品 = 同 ckey(正片 / ~N / #clip / #U 都算);片名作品 = 去掉 ~N / ~d<秒> 后的键
const familyOf = (wk, ckey) => (String(wk).indexOf('c:') === 0 && ckey ? 'c:' + ckey : String(wk).replace(/(?:#clip)?(?:~d?\d+)?$/, ''));
// 画面方向(第四阶段):宽高 → 'v'(竖,高/宽 ≥ 1.15)| 'h'(横,宽/高 ≥ 1.15)| 'sq';认不出 → ''
const ORIENTS = new Set(['v', 'h', 'sq']);
function orientOf(w, h) {
    w = Math.round(Number(w)); h = Math.round(Number(h));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > 16384 || h > 16384) return '';
    return h >= 1.15 * w ? 'v' : w >= 1.15 * h ? 'h' : 'sq';
}
// 作品方向 = 线路方向的多数;平票按 v > sq > h(竖屏片被某个站补黑边成横屏比反过来常见)
function workOrient(list) {
    const n = { v: 0, h: 0, sq: 0 };
    for (const o of list || []) if (ORIENTS.has(o)) n[o]++;
    let best = '', bn = 0;
    for (const o of ['v', 'sq', 'h']) if (n[o] > bn) { best = o; bn = n[o]; }
    return best;
}
// 'YYYY-MM-DD' → UTC 天数(0 = 没有)
function relDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return 0;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return Number.isFinite(t) && t > 0 ? Math.floor(t / 86400e3) : 0;
}

// 没有 lib/adult/tags(旧版内容层)时的兜底:旧 taxonomy 的 30 个分类派生标签,审查级 review,单组。
//   只为了目录在内容层缺标签模块时仍能工作(fail-soft;内容安全不靠标签)
function legacyTags(X) {
    const VOCAB = X.TAGS.map((t) => ({ id: t.id, label: t.label, group: 'legacy', kind: NONFEATURED_LEGACY.has(t.id) ? 'review' : 'featured', syn: [] }));
    const by = new Map(VOCAB.map((t) => [t.id, t]));
    return {
        VERSION: 'legacy', VOCAB, GROUPS: [{ id: 'legacy', label: '标签' }], LEGACY: {},
        tagLine: (raw, ctx) => ({ tags: ((ctx && ctx.pcTags) || []).map((id) => ({ id, src: 'cat' })), signals: [], studio: '' }),
        tagsFromAvdb: () => [],
        mergeWork: (lists) => { const s = new Set(); for (const l of lists || []) for (const e of l || []) { const id = typeof e === 'string' ? e : e && e.id; if (by.has(id)) s.add(id); } return [...s]; },
        isFeatured: (id) => !!(by.get(id) && by.get(id).kind === 'featured'),
        isReview: (id) => !!(by.get(id) && by.get(id).kind === 'review'),
        label: (id) => (by.get(id) ? by.get(id).label : ''),
        group: (id) => (by.get(id) ? 'legacy' : ''),
        resolve: (id) => (by.has(id) ? id : ''),
        fromWord: () => [],
    };
}
function tagsOf(A, explicit) {
    const t = explicit || (A && A.tags);
    if (t && Array.isArray(t.VOCAB) && typeof t.tagLine === 'function' && typeof t.mergeWork === 'function') return t;
    return legacyTags(A.taxonomy);
}

module.exports = {
    F_ZH, F_UNC, F_LEAK, F_CLIP, F_UHD, ELIG, ELIG_I, RV_GEN, eligOk, WCOLS, HOME_BUCKETS,
    DUR_CLASSES, VARIANTS, SORTS, SORT_IDS, LEGACY_SORT, LEGACY_FLAG, NO_ACTRESS_BUCKETS, NONFEATURED_LEGACY,
    envFlag, envOff, envInt, normSite, imgUrl, liveCount, card, kindOfWk, relDay, legacyTags, tagsOf,
    familyOf, ORIENTS, orientOf, workOrient,
};
