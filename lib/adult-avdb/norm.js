// [adult] AVDB 行 → 我们的番号键空间(lib/adult/title.js parseTitle().key 的形状)与字段清洗。
//
// 调研 .adult-research/impl/p34/avdb-norm.cjs 的移植 + 加固(更多实体、YYYY/MM/DD 日期、标题占位、海报压缩、演员名判定)。
//
//   JAV:  LABEL-NNN(数字前缀去掉,数字补到 ≥3 位)          IPZZ-961, 300MIUM-123 → MIUM-123, JVDW-84 → JVDW-084
//   Heydouga: HEYDOUGA-4197-001(和 title.js 一样;我们这边 kind='heydouga',不走日期式片商逻辑)
//   CN:   LABEL-NNNN(Chinese AV 行,补到 4 位)              TMW156 → TMW-0156, MD0146 → MD-0146, 91CM-229 → 91CM-0229
//   FC2:  FC2-N   HEYZO: HEYZO-NNNN   KBJ: KBJ-N   Tokyo-Hot: TH-k1444   H4610: H4610-ori1611
//   日期式:STUDIO-MMDDYY-NN[N],STUDIO ∈ CARIB|1PON|PACO|10MU|MURA|H0930;光秃秃的 MMDDYY_NNN = UNC(片商未知)
//   Hentai(avdb-hNNNNN)没有番号 → null(不入库)
//
// 变体后缀:-UNCENSORED-LEAK(ED) → 'leak';-ENGLISH-SUBTITLE / -SUB → 'ensub';其余 'main'(type 3 / 7 也按类型名认)。
// 松键 looseKey:去掉数字补零和日期式片商(IPZZ-961 / TMW-156 / D:123124-100),解析器和这里补零不一致(MDS-607 vs MDS-0607)也能对上。
'use strict';

const STUDIO = [
    [/^CARIBBEANCOM(?:PR)?$|^CARIB(?:PR)?$/, 'CARIB'],
    [/^1PONDO$|^1PON$|^PONDO$/, '1PON'],
    [/^PACOPACOMAMA$|^PACO$/, 'PACO'],
    [/^10MUSUME$|^10MU$/, '10MU'],
    [/^MURAMURA$|^MURA$/, 'MURA'],
    [/^H0930$/, 'H0930'],
];
const DATE_STUDIOS = ['CARIB', '1PON', 'PACO', '10MU', 'MURA', 'H0930', 'UNC'];

const TYPE_ID = { 'censored': 1, 'uncensored': 2, 'uncensored leaked': 3, 'amateur': 4, 'chinese av': 5, 'hentai': 6, 'english subtitle': 7 };
const typeIdOf = (name) => TYPE_ID[String(name == null ? '' : name).trim().toLowerCase()] || 0;

const pad = (n, w) => { const v = String(parseInt(n, 10)); return v.length >= w ? v : v.padStart(w, '0'); };

function decode(s) {
    let x = String(s == null ? '' : s);
    for (let k = 0; k < 5 && /&amp;/i.test(x); k++) x = x.replace(/&amp;/gi, '&');
    return x.replace(/&#0*39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d{1,7});/g, (_, d) => { const c = +d; return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
        .replace(/[\u200b-\u200f\ufeff]/g, '');
}

// 变体后缀(只认数据里真出现过的;-C / -U 这种单字母后缀会误伤 MBDD-2108B 一类的真番号,不认)
const SUFFIX_RE = /-(?:UNCENSORED-LEAK(?:ED)?|ENGLISH-SUBTITLES?|ENGLISH-SUB|SUB)$/;
function variantOf(mc, typeName) {
    const s = decode(mc).toUpperCase().trim();
    const t = String(typeName == null ? '' : typeName).trim().toLowerCase();
    if (/-UNCENSORED-LEAK(?:ED)?$/.test(s) || t === 'uncensored leaked') return 'leak';
    if (/-(?:ENGLISH-SUBTITLES?|ENGLISH-SUB|SUB)$/.test(s) || t === 'english subtitle') return 'ensub';
    return 'main';
}
function baseCode(mc) { return decode(mc).toUpperCase().trim().replace(/\s+/g, '').replace(SUFFIX_RE, ''); }

// → {key, kind, label, num?, studio?, d6?, nn?, prefix?} | null
function normKey(mc, typeName) {
    const s = baseCode(mc);
    const cnType = String(typeName == null ? '' : typeName).trim().toLowerCase() === 'chinese av';
    let m;
    if (!s || /^AVDB-/.test(s)) return null;                                                     // Hentai:avdb-h12345
    if ((m = /^FC2-?PPV-?(\d{4,8})$/.exec(s)) || (m = /^FC2-(\d{5,8})$/.exec(s))) return { key: 'FC2-' + m[1], kind: 'fc2', label: 'FC2', num: +m[1] };
    if ((m = /^HEYZO-?(\d{3,4})$/.exec(s))) return { key: 'HEYZO-' + pad(m[1], 4), kind: 'heyzo', label: 'HEYZO', num: +m[1] };
    if ((m = /^KBJ-?(\d{6,8})$/.exec(s))) return { key: 'KBJ-' + m[1], kind: 'kbj', label: 'KBJ', num: +m[1] };
    if ((m = /^TOKYO-?HOT-?([A-Z]{1,6}\d{3,5})$/.exec(s))) return { key: 'TH-' + m[1].toLowerCase(), kind: 'tokyohot', label: 'TH' };
    if ((m = /^([HC]\d{4})-([A-Z]{2,8}\d{3,7})$/.exec(s))) return { key: `${m[1]}-${m[2].toLowerCase()}`, kind: 'h4610', label: m[1] };
    if ((m = /^HEYDOUGA-?(\d{4})-(?:PPV-?)?(\d{3,6})$/.exec(s))) return { key: `HEYDOUGA-${m[1]}-${m[2]}`, kind: 'heydouga', label: 'HEYDOUGA' };   // title.js: HEYDOUGA-4197-001
    if ((m = /^(?:([0-9A-Z]+?)-)?(\d{6})[-_](\d{2,3})$/.exec(s))) {                              // CARIBBEANCOM-061912-052 / 10MUSUME-042025_01 / 091923_912
        let st = 'UNC';
        if (m[1]) { const hit = STUDIO.find(([re]) => re.test(m[1])); if (!hit) return { key: s, kind: 'other', label: null }; st = hit[1]; }
        const mm = +m[2].slice(0, 2), dd = +m[2].slice(2, 4);
        if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return { key: s, kind: 'other', label: null };
        const nn = st === '10MU' ? m[3].slice(-2) : m[3];
        return { key: `${st}-${m[2]}-${nn}`, kind: 'uncen-date', label: st, studio: st, d6: m[2], nn };
    }
    if (cnType) {
        if ((m = /^([0-9]*[A-Z]+)-?(\d{2,5})(?:-\d)?$/.exec(s))) return { key: `${m[1]}-${pad(m[2], 4)}`, kind: 'cn', label: m[1], num: +m[2] };
        return { key: s, kind: 'other', label: null };
    }
    if ((m = /^(\d{0,4})([A-Z]{2,10})-(\d{2,6})$/.exec(s))) return { key: `${m[2]}-${pad(m[3], 3)}`, kind: 'jav', label: m[2], num: +m[3], prefix: m[1] || '' };
    if ((m = /^([A-Z]{2,10})(\d{3,6})$/.exec(s))) return { key: `${m[1]}-${pad(m[2], 3)}`, kind: 'jav', label: m[1], num: +m[2] };
    return { key: s, kind: 'other', label: null };
}

// 我们的键(可带 c: 前缀、#U / #clip / ~N 后缀)→ 比较用的形状
function ourKey(ckey) {
    const k = String(ckey == null ? '' : ckey).trim().replace(/^c:/i, '').replace(/(?:#U|#CLIP|~\d+)+$/i, '');
    const m = /^(CARIB|1PON|PACO|10MU|MURA|H0930|UNC)-(\d{6})-(\d{2,3})$/i.exec(k);
    return m ? { key: k.toUpperCase(), date: { studio: m[1].toUpperCase(), d6: m[2], nn: m[3] } } : { key: k };
}

// 松键:去补零、去日期式片商 —— 两边都用它进索引
function looseKey(key) {
    const k = String(key == null ? '' : key).trim().replace(/^c:/i, '').replace(/(?:#U|#CLIP|~\d+)+$/i, '').toUpperCase();
    let m;
    if (!k) return '';
    if ((m = /^(?:CARIB|1PON|PACO|10MU|MURA|H0930|UNC)-(\d{6})-(\d{2,3})$/.exec(k))) return `D:${m[1]}-${m[2]}`;
    if ((m = /^([0-9A-Z]*[A-Z])-0*(\d+)$/.exec(k))) return `${m[1]}-${m[2]}`;
    return k;
}

// ---------- 演员 ----------
const PLACEHOLDER_ACTOR = /^(?:Updating|Japanese Cast|Japanese Actress|Actresses & Casts|Actress(?:es)?|Casts?|Voice Cast|Amateur Model|Chinese Model|Model|H-Animation|H-Anime|Anime|Unknown|N\/A|NA|None|Amateur|Various|Various Actresses|Other|Others|-+|\?+|)$/i;
const PLACEHOLDER_DIRECTOR = /^(?:Updating|S-CUTE|JAV Studio Production|Amateur Studio Production|Hentai OVA Production|FC2-PPV Production|Chinese Studio Production|Unknown|N\/A|)$/i;
// 拉丁名字里出现这些词 = 不是人名(片商 / 分类 / 角色词)
const NOT_NAME_WORD = /^(?:production|productions|studio|studios|media|model|models|cast|casts|amateur|amateurs|girl|girls|wife|wives|actress|actresses|unknown|various|japanese|chinese|korean|av|idol|voice|updating|anime|animation|hentai|team|staff|other|others|and|the|of|with|ova|uncensored|censored|leak|leaked|sub|subtitle|english|production\.|tv|channel|official)$/i;

function cleanActors(arr) {
    const out = [];
    const list = Array.isArray(arr) ? arr : (arr == null || arr === '' ? [] : String(arr).split(','));
    for (const raw of list) {
        const a = decode(raw).normalize('NFKC').replace(/\s+/g, ' ').trim();
        if (!a || a.length > 80 || PLACEHOLDER_ACTOR.test(a)) continue;
        out.push(a);
    }
    return out;
}
// "Alpha Testa (Bravo Fixto)" → 名字 + 括号别名;"Alpha Testa アルファテスタ" → 罗马字 + 日文(例子都是编的)
function splitActor(a) {
    const r = { romaji: String(a || '').trim(), alias: null, ja: null, merged: false };
    let m;
    if ((m = /^(.*?)\s*[(（]([^)）]+)[)）]\s*$/.exec(r.romaji))) { r.romaji = m[1].trim(); r.alias = m[2].trim(); }
    if ((m = /^([A-Za-z .'\-]+?)\s+([\u3040-\u30ff\u3400-\u9fff々ー・]+)$/.exec(r.romaji))) { r.romaji = m[1].trim(); r.ja = m[2]; }
    if (/^[A-Za-z]/.test(r.romaji) && r.romaji.split(' ').filter(Boolean).length >= 4) r.merged = true;   // "Alpha Testa Bravo Fixto" = 两个人粘在一起
    return r;
}
// 罗马字别名键:小写 a-z 词按字母序(Alpha Testa = Testa Alpha = " Alpha Testa")
const orderKey = (romaji) => String(romaji || '').toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter(Boolean).sort().join(' ');
// 日文 / 中文别名键:NFKC、去空白和中点
const cjkKey = (s) => String(s || '').normalize('NFKC').replace(/[\s・·.]/g, '');
const isLatin = (s) => /^[A-Za-z][A-Za-z .'\-]*$/.test(String(s || ''));
const isCjkName = (s) => /^[\u3040-\u30ff\u3400-\u9fff々ー・]{2,10}$/.test(String(s || '').replace(/\s/g, ''));
// "真名字":2-3 个拉丁词(每个 ≥2 字母、不是片商/分类词)或 2-10 个汉字假名;单个词(素人化名 Mio / Ruka)、带数字的、太长的都不算
function isRealName(s) {
    const t = String(s || '').trim();
    if (!t || t.length > 40 || /\d/.test(t)) return false;
    if (isCjkName(t)) return true;
    if (!isLatin(t)) return false;
    const toks = t.split(/\s+/).filter(Boolean);
    if (toks.length < 2 || toks.length > 3) return false;
    for (const w of toks) { const core = w.replace(/[.'\-]/g, ''); if (core.length < 2 || NOT_NAME_WORD.test(core)) return false; }
    return true;
}
// 全大写 → 首字母大写(ALPHA TESTA → Alpha Testa);其余照原样
function displayName(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (/^[A-Z .'\-]+$/.test(t) && /[A-Z]{2}/.test(t)) return t.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_, p, c) => p + c.toUpperCase());
    return t;
}

function makerOf(directors) {
    for (const d0 of directors || []) {
        const d = decode(d0).replace(/\s+/g, ' ').trim();
        if (PLACEHOLDER_DIRECTOR.test(d)) continue;
        const m = /^(.*\S)\s+Production$/i.exec(d);
        if (m && !PLACEHOLDER_DIRECTOR.test(m[1])) return m[1];
    }
    return null;
}
function directorOf(directors) {
    for (const d0 of directors || []) {
        const d = decode(d0).replace(/\s+/g, ' ').trim();
        if (PLACEHOLDER_DIRECTOR.test(d) || / Production$/i.test(d)) continue;
        return d;
    }
    return null;
}

// ---------- 日期 / 时长 / 海报 / 标题 ----------
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function ymd(y, mo, d) {
    if (!(y >= 1970 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;                                                // 2月30日
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function releaseDate(s) {
    const t = String(s == null ? '' : s).trim();
    let m;
    if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/.exec(t))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]*,? (\d{4})$/.exec(t)) && MON[m[2].toLowerCase()]) return ymd(+m[3], MON[m[2].toLowerCase()], +m[1]);
    return null;
}
function hms(t) {
    const m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(String(t == null ? '' : t).trim());
    if (!m) return null;
    const v = +m[1] * 3600 + +m[2] * 60 + +m[3];
    return v > 0 && v < 24 * 3600 ? v : null;
}
// vod_time / vod_time_add → epoch 秒(AVDB 时钟 UTC+7)
function addedOf(row) {
    const a = row && row.vod_time_add;
    if (a != null && /^\d{9,11}$/.test(String(a))) return +a;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String((row && (row.vod_time || row.updated_at)) || ''));
    if (m) return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], +m[6]) / 1000);
    return 0;
}
// 海报:upload18 的标准地址只存 slug('u:<SLUG>'),其余 http(s) 原样;别的协议一律不要
const POSTER_STD = /^https?:\/\/upload18\.cc\/v\/([A-Za-z0-9._\-]{1,120})\/poster\.jpg$/i;
function posterOf(row) {
    for (const f of ['poster_url', 'thumb_url', 'vod_pic', 'pic']) {
        const v = decode(row && row[f]).trim();
        if (!/^https?:\/\/[^\s"'<>]+$/i.test(v) || v.length > 400) continue;
        const m = POSTER_STD.exec(v);
        return m ? 'u:' + m[1] : v;
    }
    return null;
}
function posterUrl(stored) {
    const s = String(stored || '');
    if (!s) return '';
    if (s.startsWith('u:')) return `https://upload18.cc/v/${s.slice(2)}/poster.jpg`;
    return /^https?:\/\//i.test(s) ? s : '';
}
// 地理封锁的占位标题("International Age Verification Compliance Notice")当没有标题
const AGE_NOTICE = /International Age Verification Compliance Notice/i;
function titleOf(name, mc) {
    let t = decode(name).normalize('NFKC').replace(/\s+/g, ' ').trim();
    for (let k = 0; k < 3; k++) t = t.replace(/^\[[^\]]{1,40}\]\s*/, '');
    const code = baseCode(mc);
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (code) for (let k = 0; k < 3; k++) t = t.replace(new RegExp('^' + esc(code) + '(?:-[A-Z\\-]+)?\\s*', 'i'), '');
    t = t.replace(/^[\s\-–—:|]+/, '').trim();
    if (!t || AGE_NOTICE.test(t)) return null;
    return t.slice(0, 300);
}
// 标签:tag 字串(逗号分隔)∪ category[],解实体、压空白、去重(保留首次见到的写法)
function tagsOf(row) {
    const seen = new Map();
    const parts = String(decode(row && row.tag) || '').split(',').concat(Array.isArray(row && row.category) ? row.category.map(decode) : []);
    for (const p of parts) {
        const t = String(p || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!t) continue;
        const k = t.toLowerCase();
        if (!seen.has(k)) seen.set(k, t);
    }
    return [...seen.entries()].map(([k, form]) => ({ k, form }));
}

module.exports = {
    normKey, ourKey, looseKey, variantOf, baseCode, typeIdOf, decode,
    cleanActors, splitActor, orderKey, cjkKey, isRealName, displayName, makerOf, directorOf,
    releaseDate, hms, addedOf, posterOf, posterUrl, titleOf, tagsOf,
    PLACEHOLDER_ACTOR, PLACEHOLDER_DIRECTOR, AGE_NOTICE, DATE_STUDIOS, TYPE_ID,
};
