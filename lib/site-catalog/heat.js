// [adult] 高光热度条(第四阶段):观众把"这部片子哪几段看得多"按百分位攒成 100 格,攒够 3 个贡献才给人看。
//
//   写(写线程,writer.js 的 heatAdd):每个贡献 = 客户端本次观看的 100 格强度(0..255,每格 = 该 1% 区间被看了多少),
//     先按自己的最大值归一到 0..255(每个贡献者权重一样:一个人反复拖同一段刷不出"全站高光"),再累加进作品那一行(100 个 uint32)。
//   去重:同一个上报者(who = 闸门给的不透明哈希,sha256(设备随机 id + 每日盐))同一作品同一 UTC 天只算一次。
//     去重键 = sha256(who | wk | 天) 的前 32 位十六进制,只存这个键和天号,2 天后删掉 —— 库里没有"谁看了什么"的逐人记录,只有聚合计数。
//   读(主线程点查,index.js heat):users < 3 → null(k-匿名);否则 100 格按最大值归一到 0..100。
//   注:闸门的 who 每天换盐,跨天无法认出同一个人 —— users 是"每天去重后的贡献次数",不是严格的不同人数(见报告的已知缺口)。
'use strict';

const crypto = require('crypto');
const U = require('./util');

const BINS = 100;
const MIN_USERS = 3;
const SEEN_KEEP_DAYS = 2;

// bins:长度 100 的数组 / Uint8Array / Buffer,每格 0..255 的整数 → Uint8Array(100);不合法 → null
function parseBins(bins) {
    if (bins == null || typeof bins !== 'object') return null;
    const n = bins.length;
    if (n !== BINS) return null;
    const out = new Uint8Array(BINS);
    for (let i = 0; i < BINS; i++) {
        const v = Number(bins[i]);
        if (!Number.isFinite(v) || v < 0 || v > 255 || Math.floor(v) !== v) return null;
        out[i] = v;
    }
    return out;
}
// 一个贡献按自己的最大值归一到 0..255;全 0 → null(没有信息)
function normContribution(b) {
    let mx = 0;
    for (let i = 0; i < BINS; i++) if (b[i] > mx) mx = b[i];
    if (!mx) return null;
    const out = new Uint8Array(BINS);
    for (let i = 0; i < BINS; i++) out[i] = Math.round((b[i] * 255) / mx);
    return out;
}
function sumsFrom(blob) {
    const out = new Float64Array(BINS);
    if (!blob || blob.length !== BINS * 4) return out;
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    for (let i = 0; i < BINS; i++) out[i] = buf.readUInt32LE(i * 4);
    return out;
}
function sumsBlob(sums) {
    const buf = Buffer.alloc(BINS * 4);
    for (let i = 0; i < BINS; i++) buf.writeUInt32LE(Math.min(0xffffffff, Math.max(0, Math.round(sums[i]))), i * 4);
    return buf;
}
// 读出口:{bins:number[100] 0..100, users, dur};users < 3 → null
function heatOut(row) {
    if (!row || !(Number(row.users) >= MIN_USERS)) return null;
    const s = sumsFrom(row.sums);
    let mx = 0;
    for (let i = 0; i < BINS; i++) if (s[i] > mx) mx = s[i];
    const bins = new Array(BINS);
    for (let i = 0; i < BINS; i++) bins[i] = mx > 0 ? Math.round((s[i] * 100) / mx) : 0;
    return { bins, users: Number(row.users), dur: Number(row.dur) || 0 };
}
const dayOf = (t) => Math.floor(t / U.DAY);
const seenKey = (who, wk, day) => crypto.createHash('sha256').update(String(who) + '\n' + String(wk) + '\n' + day).digest('hex').slice(0, 32);

// 写线程这一侧。q = 预编译语句缓存(writer.js 的 q),d = 连接,elig = common.ELIG
function createHeatWriter({ q, d, elig }) {
    let purgedDay = -1;
    const stats = { added: 0, dup: 0, rejected: 0 };
    function purge(day) {
        q('DELETE FROM adult_heat_seen WHERE day < ?').run(day - (SEEN_KEEP_DAYS - 1));
        purgedDay = day;
    }
    // {wk, bins, dur, who, t} → boolean(true = 记上了)
    function heatAdd({ wk, bins, dur, who, t }) {
        const rej = () => { stats.rejected++; return false; };
        if (typeof wk !== 'string' || !wk || wk.length > 300) return rej();
        if (typeof who !== 'string' || !who || who.length > 128) return rej();
        const b = parseBins(bins);
        if (!b) return rej();
        const c = normContribution(b);
        if (!c) return rej();
        const du = Math.round(Number(dur));
        if (!Number.isFinite(du) || du < 1 || du > 12 * 3600) return rej();
        const w = q(`SELECT w.id, w.dur FROM adult_works w WHERE w.wk=? AND w.vis=1 AND ${elig}`).get(wk);
        if (!w) return rej();
        // 百分位是相对线路时长的:和作品时长差太多(别的版本 / 片段)的不收
        if (w.dur > 0 && Math.abs(du - w.dur) > 0.1 * w.dur + 30) return rej();
        const day = dayOf(Number(t) || Date.now());
        let added = false;
        d.transaction(() => {
            if (purgedDay !== day) purge(day);
            const ins = q('INSERT OR IGNORE INTO adult_heat_seen (k, day) VALUES (?, ?)').run(seenKey(who, wk, day), day);
            if (!ins.changes) return;
            const row = q('SELECT users, sums FROM adult_heat WHERE wk=?').get(wk);
            const s = sumsFrom(row && row.sums);
            for (let i = 0; i < BINS; i++) s[i] += c[i];
            q('INSERT OR REPLACE INTO adult_heat (wk, users, sums, dur, at) VALUES (?, ?, ?, ?, ?)').run(wk, (row ? Number(row.users) || 0 : 0) + 1, sumsBlob(s), du, Number(t) || 0);
            added = true;
        })();
        if (added) stats.added++; else stats.dup++;
        return added;
    }
    // 保留期:去重键过期(没有 heatAdd 也按天清)、作品已经没了的热度行
    function retention(t) {
        purge(dayOf(Number(t) || Date.now()));
        q('DELETE FROM adult_heat WHERE NOT EXISTS (SELECT 1 FROM adult_works w WHERE w.wk = adult_heat.wk)').run();
    }
    return { heatAdd, retention, stats };
}

module.exports = { BINS, MIN_USERS, SEEN_KEEP_DAYS, parseBins, normContribution, sumsFrom, sumsBlob, heatOut, seenKey, dayOf, createHeatWriter };
