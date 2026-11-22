// [adult] lib/site-catalog 的纯函数(无 IO,可单测):时长/时间解析、卡片文案、同站连排打散、信号量。
'use strict';

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const CST = 8 * HOUR;   // 资源站 vod_time 一律是北京时间、不带时区

// vod_duration / vod_remarks → 秒(0 = 不知道)。
//   "01:23:45" / "1:2:03" / "37:12" / "90分钟" / "90 分钟" / "90"(只认 vod_duration 里的纯数字 = 分钟,s22/s39/s53 实测)
//   备注里只认 时:分:秒 / 分:秒(备注里的纯数字多半是集数/年份)
function parseDur(d, rm) {
    for (let k = 0; k < 2; k++) {
        const v = k === 0 ? d : rm;
        if (v == null || v === '') continue;
        const t = String(v).normalize('NFKC').trim();
        if (!t || t.length > 20) continue;
        let m, s = 0;
        if ((m = /^(\d{1,2}):(\d{1,2}):(\d{2})$/.exec(t))) { if (+m[2] < 60 && +m[3] < 60) s = +m[1] * 3600 + +m[2] * 60 + +m[3]; }
        else if ((m = /^(\d{1,3}):(\d{2})$/.exec(t))) { if (+m[2] < 60) s = +m[1] * 60 + +m[2]; }
        else if (k === 0 && (m = /^(\d{1,3})\s*(?:分钟|分鐘|分|min|mins|minutes)?$/i.exec(t))) s = +m[1] * 60;
        if (s > 0 && s <= 12 * 3600) return s;
    }
    return 0;
}

// vod_time → ms。"2026-11-21 11:14:39"(北京时间)/ "2026-11-21" / unix 秒 / unix 毫秒;认不出 → 0
function parseTime(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number' || /^\d{9,13}$/.test(String(v).trim())) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return n > 1e12 ? n : n * 1000;
    }
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(String(v).trim());
    if (!m) return 0;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - CST;
    return Number.isFinite(t) && t > 0 ? t : 0;
}

// 两个时长算不算同一部:任一方不知道 → 算;否则差 ≤ 3% + 5s(调研:跨站同番号 99% 落在这里)
function durCompatible(a, med) {
    if (!(a > 0) || !(med > 0)) return true;
    return Math.abs(a - med) <= 0.03 * med + 5;
}

function median(arr) {
    const a = arr.filter((x) => x > 0).sort((x, y) => x - y);
    if (!a.length) return 0;
    const i = a.length >> 1;
    return a.length % 2 ? a[i] : Math.round((a[i - 1] + a[i]) / 2);
}

function fmtDur(sec) {
    sec = Math.round(Number(sec) || 0);
    if (sec <= 0) return '';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p2 = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

function relTime(t, now) {
    if (!(t > 0)) return '';
    const d = Math.max(0, now - t);
    if (d < MIN) return '刚刚';
    if (d < HOUR) return Math.floor(d / MIN) + '分钟前';
    if (d < DAY) return Math.floor(d / HOUR) + '小时前';
    if (d < 30 * DAY) return Math.floor(d / DAY) + '天前';
    return Math.floor(d / (30 * DAY)) + '个月前';
}

// 北京时间的"今天"编号(随机发现的每日种子)
function dayNo(now) { return Math.floor((now + CST) / DAY); }

// 32 位 FNV-1a,返回非负 31 位整数
function hash31(s) {
    let h = 0x811c9dc5;
    s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0) & 0x7fffffff;
}

// 同一小时槽里按站(家族)轮流出:newest-first 直接排会出现"一个站连续 200 张"(调研实测 s22)
//   items 已按 first_seen 倒序;slotOf(x) → 槽号;famOf(x) → 家族键
function slotRoundRobin(items, famOf, slotOf) {
    const out = [];
    let i = 0;
    while (i < items.length) {
        const slot = slotOf(items[i]);
        const fams = [], q = new Map();
        while (i < items.length && slotOf(items[i]) === slot) {
            const f = famOf(items[i]);
            if (!q.has(f)) { q.set(f, []); fams.push(f); }
            q.get(f).push(items[i]);
            i++;
        }
        let left = true;
        while (left) {
            left = false;
            for (const f of fams) { const a = q.get(f); if (a.length) { out.push(a.shift()); left = true; } }
        }
    }
    return out;
}

// 保持顺序取前 limit 个,但同一家族连续不超过 maxRun 个:超了就把后面最近的别家条目提上来;
//   整个候选里已经没有别家 → fill=false 截断(新上架:宁可少几张也不连排)/ fill=true 照原顺序接着放(大类行 / 浏览:别把一行砍成 4 张)。
//   O(n × 家族数)
function interleave(items, famOf, limit, maxRun, fill) {
    const n = items.length;
    const fam = items.map(famOf);
    const taken = new Uint8Array(n);
    const byFam = new Map();
    for (let i = 0; i < n; i++) { if (!byFam.has(fam[i])) byFam.set(fam[i], { idx: [], p: 0 }); byFam.get(fam[i]).idx.push(i); }
    const out = [];
    let g = 0, last = null, run = 0;
    while (out.length < limit) {
        while (g < n && taken[g]) g++;
        if (g >= n) break;
        let pick = g;
        if (fam[g] === last && run >= maxRun) {
            pick = -1;
            for (const [f, q] of byFam) {
                if (f === last) continue;
                while (q.p < q.idx.length && taken[q.idx[q.p]]) q.p++;
                if (q.p < q.idx.length && (pick < 0 || q.idx[q.p] < pick)) pick = q.idx[q.p];
            }
            if (pick < 0) { if (!fill) break; pick = g; }
        }
        taken[pick] = 1;
        out.push(items[pick]);
        if (fam[pick] === last) run++; else { last = fam[pick]; run = 1; }
    }
    return out;
}

// 最长连续同家族段(测试/自检用)
function maxRunOf(items, famOf) {
    let best = 0, run = 0, last;
    for (const x of items) { const f = famOf(x); if (f === last) run++; else { last = f; run = 1; } if (run > best) best = run; }
    return best;
}

// 计数信号量(扩线并发上限);peak 记最高同时数
class Sem {
    constructor(n) { this.n = Math.max(1, n | 0); this.active = 0; this.q = []; this.peak = 0; }
    acquire() {
        if (this.active < this.n) { this.active++; if (this.active > this.peak) this.peak = this.active; return Promise.resolve(); }
        return new Promise((r) => this.q.push(r));
    }
    release() {
        const r = this.q.shift();
        if (r) r();            // 名额直接转给排队的,active 不变
        else if (this.active > 0) this.active--;
    }
}

// KS 统计量:样本 vs [0, max] 上的均匀分布(资源站的假计数多是导入时填的 0~1000 均匀随机数)
function ksUniform(values) {
    const a = (Array.isArray(values) ? values : []).filter((x) => Number.isFinite(x) && x >= 0).sort((x, y) => x - y);
    const n = a.length;
    if (!n) return { D: 0, n: 0, crit: Infinity };
    const max = a[n - 1];
    const crit = 1.36 / Math.sqrt(n);
    if (!(max > 0)) return { D: 0, n, crit };   // 全是 0:不算"不均匀"(也就过不了检查)
    let D = 0;
    for (let i = 0; i < n; i++) { const F = a[i] / max; D = Math.max(D, (i + 1) / n - F, F - i / n); }
    return { D, n, crit };
}
// 外站计数可不可信(调研 an-popularity):≥95% 满足 日≤周≤月≤总、总数分布不是均匀随机(KS D > 1.36/√n)、
//   隔 ≥2 分钟复取过的条目里 ≥一半总数在涨。数据不够 → decided:false(下次再判)
function hitsTrust(rows, o) {
    const opt = Object.assign({ minN: 30, minPairs: 10, orderFrac: 0.95, growFrac: 0.5, gapMs: 2 * MIN }, o || {});
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && [r.day, r.week, r.month, r.total].every((x) => Number.isFinite(x)));
    const n = list.length;
    if (n < opt.minN) return { decided: false, ok: false, reason: 'insufficient', n };
    const ordered = list.filter((r) => r.day <= r.week && r.week <= r.month && r.month <= r.total).length / n;
    const ks = ksUniform(list.map((r) => r.total));
    const pairs = list.filter((r) => Number.isFinite(r.prev_total) && Number.isFinite(r.prev_at) && r.at - r.prev_at >= opt.gapMs);
    const base = { n, ordered: Math.round(ordered * 1000) / 1000, ks: Math.round(ks.D * 1000) / 1000, crit: Math.round(ks.crit * 1000) / 1000, pairs: pairs.length };
    if (pairs.length < opt.minPairs) return Object.assign({ decided: false, ok: false, reason: 'no-refetch' }, base);
    const grew = pairs.filter((r) => r.total > r.prev_total).length / pairs.length;
    base.grew = Math.round(grew * 1000) / 1000;
    const why = [];
    if (ordered < opt.orderFrac) why.push('order');
    if (!(ks.D > ks.crit)) why.push('uniform');
    if (grew < opt.growFrac) why.push('static');
    return Object.assign({ decided: true, ok: why.length === 0, reason: why.join(',') || 'ok' }, base);
}

function clip(s, n) {
    if (s == null) return '';
    s = String(s);
    return s.length > n ? s.slice(0, n) : s;
}

function hostOf(u) {
    try { return new URL(String(u)).hostname.toLowerCase(); } catch (_) { return ''; }
}

module.exports = {
    MIN, HOUR, DAY,
    parseDur, parseTime, durCompatible, median, fmtDur, relTime, dayNo, hash31,
    slotRoundRobin, interleave, maxRunOf, Sem, clip, hostOf, ksUniform, hitsTrust,
};
