/*!
 * kz-titlematch.js — 番剧/影视标题归一化 + 分组吸附(单一真源)
 *
 * 同一个文件同时被三处使用,改一处 = 改全部(避免 danmaku 那种"两后端匹配函数群同源却各改各的"漂移):
 *   - server.js / api/index.js 经 lib/kazumi/titlematch.js require() 进来(给 Kazumi 规则站搜索结果打 _gk/_season/_kind)
 *   - public/index.html 以 <script> 引入,暴露 window.KzTitle(groupedList 二次吸附用)
 * 约束:零依赖、ES2017 语法 —— 不用 ?? / ?. / 正则后行断言(Safari<16.4 解析即抛 SyntaxError,整个脚本失效)/
 *   matchAll / Object.fromEntries;\p{..} 属性类(ES2018)只在运行时 try 构造,失败回退显式区间。
 * 回归:scripts/kazumi-test.mjs(fixtures/kazumi/titlematch-cases.json,源自 202 条真实搜索结果的探测样本)。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.KzTitle = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var CN = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    var ROMAN = { 'Ⅰ': '1', 'Ⅱ': '2', 'Ⅲ': '3', 'Ⅳ': '4', 'Ⅴ': '5', 'Ⅵ': '6', 'Ⅶ': '7', 'Ⅷ': '8', 'Ⅸ': '9', 'Ⅹ': '10' };
    var NUM = '[0-9一二三四五六七八九十两]+';
    // DM84 的片名里混有 U+200B 等零宽字符(肉眼不可见,却让精确名分组/搜索全部失配)
    var ZW_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
    var NOISE_RE = /(tv版|完整版|无修版|未删减)$/;
    var CJK_RE = /[一-鿿぀-ヿ]/g;
    // 去掉所有标点/符号/空白:优先用 Unicode 属性类;老浏览器不支持时退回常见区间(覆盖中日文标点与全角符号)
    var PUNCT_RE = (function () {
        try { return new RegExp('[\\p{P}\\p{S}\\p{Z}\\s]+', 'gu'); } catch (e) {
            return /[\s!-\/:-@\[-`{-~\u00A0-\u00BF\u00D7\u00F7\u2000-\u206F\u2190-\u2BFF\u3000-\u303F\u30FB\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFE30-\uFE4F]+/g;
        }
    })();

    function cnNum(s) {
        if (/^\d+$/.test(s)) return parseInt(s, 10);
        var m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
        if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
        if (s.length === 1 && Object.prototype.hasOwnProperty.call(CN, s)) return CN[s];
        return NaN;
    }
    function nfkc(s) { return typeof s.normalize === 'function' ? s.normalize('NFKC') : s; }

    /** 'm' 电影 / 't' 剧集 / '?' 未知 —— 由片名 + remarks(+ maccms type_name)推断。只用于否决模糊合并,不进 key。 */
    function kindOf(raw, remarks, type) {
        var r = nfkc(String(raw == null ? '' : raw));
        var m = nfkc(String(remarks || '')).trim();
        var t = String(type || '');
        if (/剧场版|劇場版|电影版|the movie/i.test(r) || /电影|片$/.test(t)) return 'm';
        if (/tv版/i.test(r)) return 't';
        // 7sefun 的 remarks 是裸集数("28");"1" 有歧义(单集电影也是 1),所以只认 2 及以上
        if (/\d+\s*[集话話期]|更新|完结|全\d|^([2-9]|\d{2,})$|连载|part/i.test(m)) return 't';
        if (/^(hd|bd|tc|ts|4k|1080|720|正片|高清|超清|蓝光|抢先)|中字|双语|^ova$/i.test(m)) return 'm';
        return '?';
    }

    /** 原始片名 → {raw, base, season, part, lang, year, kind, key} */
    function parseTitle(raw, meta) {
        meta = meta || {};
        var kind = kindOf(raw, meta.remarks, meta.type);
        var s = String(raw == null ? '' : raw).replace(ZW_RE, '');
        s = s.replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, function (c) { return ROMAN[c]; });   // 斗罗大陆Ⅱ → 斗罗大陆2
        s = nfkc(s).toLowerCase().trim();                                       // 全角 ：！（） → ASCII
        var season = null, part = null, lang = '', year = null;
        // 显式年份后缀 ".2024" "(2024)" " 2024" 才剥;"凡人修仙传2025"(另一部真人剧)保留数字
        s = s.replace(/(?:[.\s]+|[(（])((?:19|20)\d{2})[)）]?$/, function (m, y) { year = +y; return ''; });
        // 语言版本留在 key 里:配音版维持独立卡片(与现状一致)
        s = s.replace(/\s*[(（]?\s*(国语|粤语|日语|普通话|中配|双语|国粤)(版|配音)?\s*[)）]?$/, function (m) {
            lang = m.replace(/[()（）\s版配音]/g, ''); return '';
        });
        s = s.replace(new RegExp('第\\s*(' + NUM + ')\\s*[季期]', 'g'), function (m, n) { season = cnNum(n); return ' '; });
        s = s.replace(/\bseason\s*(\d{1,2})\b/g, function (m, n) { season = +n; return ' '; });
        // "s2" 前面不能紧贴字母数字;用 (^|[^a-z0-9]) 捕获代替后行断言(兼容老 Safari)
        s = s.replace(/(^|[^a-z0-9])s(\d{1,2})(?![0-9a-z])/g, function (m, pre, n) { season = +n; return pre + ' '; });
        s = s.replace(/最终季|final\s*season/g, function () { if (season == null) season = 'final'; return ' '; });
        s = s.replace(/\bpart\.?\s*(\d)\b|第\s*(\d)\s*(?:部分|クール|cour)/g, function (m, a, b) { part = +(a || b); return ' '; });
        var base = s.replace(/劇場版/g, '剧场版').replace(PUNCT_RE, '');
        base = base.replace(NOISE_RE, '');   // 剧场版 保留在 base:否则"剧场版 无限列车篇"(电影)会和 TV 版并卡
        if (season === 1 && part == null) season = null;   // 第一季 == 裸标题
        var key = base + (season != null ? '#s' + season : '') + (part ? '#p' + part : '') + (lang ? '#' + lang : '');
        return { raw: raw, base: base, season: season, part: part, lang: lang, year: year, kind: kind, key: key };
    }

    /** 分组 key(= parseTitle(...).key) */
    function titleKey(raw, meta) { return parseTitle(raw, meta).key; }

    /** 字符 bigram Dice 系数 */
    function dice(a, b) {
        if (a === b) return 1;
        if (a.length < 2 || b.length < 2) return 0;
        var bg = function (x) {
            var m = new Map();
            for (var i = 0; i < x.length - 1; i++) { var g = x.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
            return m;
        };
        var A = bg(a), B = bg(b), inter = 0;
        A.forEach(function (c, g) { inter += Math.min(c, B.get(g) || 0); });
        return (2 * inter) / (a.length + b.length - 2);
    }

    // groups 兼容三种形态:Map(key → {p}) / 数组 [{key, p}] / 普通对象 {key: {p}};p 也可直接给原始片名字符串
    function toEntries(groups) {
        var out = [];
        var norm = function (k, g) {
            var p = g && g.p ? g.p : g;
            if (typeof p === 'string') p = parseTitle(p);
            if (p && typeof p.base === 'string') out.push([k != null ? k : p.key, p]);
        };
        if (!groups) return out;
        if (typeof Map !== 'undefined' && groups instanceof Map) groups.forEach(function (g, k) { norm(k, g); });
        else if (Array.isArray(groups)) groups.forEach(function (g) { norm(g && g.key, g); });
        else Object.keys(groups).forEach(function (k) { norm(k, groups[k]); });
        return out;
    }
    var numsOf = function (x) { return (x.match(/\d+|第[一二三四五六七八九十]+[章部篇集]/g) || []).join(','); };
    /** a、b 之一 = 另一个 + 1–3 个 [a-z0-9] 的前缀或后缀(base 已小写、去标点) */
    function latinAffixOnly(a, b) {
        if (a === b) return false;
        var lng = a.length > b.length ? a : b, sht = a.length > b.length ? b : a;
        var d = lng.length - sht.length;
        if (!sht || d < 1 || d > 3) return false;
        if (lng.slice(0, sht.length) === sht && /^[a-z0-9]+$/.test(lng.slice(sht.length))) return true;
        if (lng.slice(d) === sht && /^[a-z0-9]+$/.test(lng.slice(0, d))) return true;
        return false;
    }

    /**
     * 把一个 Kazumi 站(HTML 站)结果吸附到已有分组(通常由 maccms 结果建成)。
     * 顺序:精确 key → (kind 兼容前提下) arc-season → arc-suffix → 模糊 Dice ≥0.8(数字守卫/短拉丁头尾守卫/最短 5 字/长度差 ≤2)。
     * @returns {{key:string, how:string}} how ∈ exact | arc-season | arc-suffix | fuzzy(0.xx) | new
     */
    function snapToGroup(p, groups) {
        if (typeof p === 'string') p = parseTitle(p);
        var entries = toEntries(groups);
        for (var i = 0; i < entries.length; i++) if (entries[i][0] === p.key) return { key: p.key, how: 'exact' };
        var best = null;
        for (var j = 0; j < entries.length; j++) {
            var k = entries[j][0], q = entries[j][1];
            if (q.part !== p.part || q.lang !== p.lang) continue;
            if (q.kind !== p.kind && q.kind !== '?' && p.kind !== '?') continue;   // 电影与剧集永不互吸
            // "鬼灭之刃第二季(游郭篇)" == "鬼灭之刃 游郭篇":篇名本身已标识季
            if (q.base === p.base && /篇$/.test(p.base) && (q.season == null) !== (p.season == null)) return { key: k, how: 'arc-season' };
            if (q.season !== p.season) continue;
            // "Re…第四季 夺还篇" vs "Re…第四季":同一显式季(≥2),多出来的只是篇名/上下
            if (p.season != null && (p.base.indexOf(q.base) === 0 || q.base.indexOf(p.base) === 0)) {
                var extra = p.base.length > q.base.length ? p.base.slice(q.base.length) : q.base.slice(p.base.length);
                if ((/篇$/.test(extra) || /^(上|下)$/.test(extra)) && extra.length <= 6) return { key: k, how: 'arc-suffix' };
            }
            // 双方都是电影时"剧场版"只是装饰("鬼灭之刃 剧场版 无限城篇第一章…" ~ "鬼灭之刃：无限城篇 第一章…")
            var bothMovie = p.kind === 'm' && q.kind === 'm';
            var pb = bothMovie ? p.base.replace(/剧场版|电影版/g, '') : p.base;
            var qb = bothMovie ? q.base.replace(/剧场版|电影版/g, '') : q.base;
            // 数字守卫:续作/章节号必须一致("第一章" vs "第二章","剧场版5" vs "6")
            if (numsOf(pb) !== numsOf(qb)) continue;
            // 短拉丁/数字头尾守卫:"某科学的超电磁炮t" vs "某科学的超电磁炮"、"…邪恶大小姐x" vs "…邪恶大小姐" 是不同作品,
            // 长标题下 Dice 几乎不受 1–3 个字母影响(≥0.9),必须在模糊前单独否决。数字尾巴多数已被数字守卫拦下,这里一并覆盖
            if (latinAffixOnly(pb, qb)) continue;
            if (pb.length >= 5 && qb.length >= 5 && Math.abs(pb.length - qb.length) <= 2) {
                var d = dice(pb, qb);
                if (d >= 0.8 && (!best || d > best.d)) best = { key: k, how: 'fuzzy(' + d.toFixed(2) + ')', d: d };
            }
        }
        if (best) return { key: best.key, how: best.how };
        return { key: p.key, how: 'new' };
    }

    /**
     * Kazumi 站专用的唯一短关键词:去季号/书名号,按分隔符取第一个"有意义"的段(≥2 个中日文字或 ≥4 个拉丁字母数字),截 10 字。
     * 原因:7sefun 把 wd 截断到 10 字;两站都对空格敏感("葬送的芙莉莲 第二季"在 7sefun 搜 0、"葬送的芙莉莲第二季"在 DM84 搜 0),
     * 只有裸核心名两边都能命中全部季。
     */
    function coreKeyword(name) {
        var s = nfkc(String(name == null ? '' : name).replace(ZW_RE, ''));
        s = s.replace(new RegExp('第\\s*' + NUM + '\\s*[季部期]', 'g'), ' ').replace(/season\s*\d+/ig, ' ').replace(/[【】《》「」『』]/g, ' ');
        var segs = s.split(/[:·・\s\-—–|~()!?,，。、]+/).map(function (x) { return x.trim(); }).filter(Boolean);
        var good = null;
        for (var i = 0; i < segs.length; i++) {
            var x = segs[i];
            if ((x.match(CJK_RE) || []).length >= 2 || /^[a-z0-9]{4,}$/i.test(x)) { good = x; break; }
        }
        var kw = good || segs[0] || s.trim();
        var chars = Array.from(kw);
        if (chars.length > 10) kw = chars.slice(0, 10).join('');
        return kw;
    }

    return { cnNum: cnNum, kindOf: kindOf, parseTitle: parseTitle, titleKey: titleKey, dice: dice, snapToGroup: snapToGroup, coreKeyword: coreKeyword };
}));
