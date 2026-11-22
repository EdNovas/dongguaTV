// [adult] p4 封面悬停预览(window.dgAdultPreview)。电脑鼠标在目录卡片上停 ≥600ms、手机长按 ≥450ms → 在海报上叠一个静音 <video>,
//   播这部片子里挑出来的 3–8 段(每段 3–4 秒)「预告拼剪」。没成 / 被拦 / 出错 → 海报原样留着(视频只在真的开始播了才淡入)。
// 拼剪清单 previewPlan(text, baseUrl, opts) 是纯函数(node 里可直接 require,scripts/preview-plan-test.mjs):
//   从 CDN 原始媒体清单(或去广告 Worker 的输出)里只挑「肯定是正片」的分片,宁缺毋滥(预览只要几十秒):
//   C1 组内地址序列在清单里重复出现 = 插播素材(Worker 规则 D,不设 ≤2 上限)
//   C2 AES 为主的清单里的明文短组 = 插播(Worker 规则 E)
//   C3 不在「正片目录」(占非插播时长 ≥10% 的 host+目录)里的分片 = 外来广告
//   C4 短组(≤120s 且 <15 片)只在清单是「切块打包」(短组占 ≥50%)或确认有 C1/C2 插播时、且全在主目录里才可选
//   C5 不选 <1s 的分片,也不选 ≥3 片的组的首尾片;C6 掐头去尾(前 max(6%,15s) / 后 max(6%,10s);3 分钟内的短片 8% / 5%)
//   加密:每个选中分片的有效 #EXT-X-KEY 重新写出并带显式 IV(隐式 IV = 原清单里的媒体序号;重排后序号变了,不写显式 IV 会解密失败)
// 取清单:先直连(样本 128/128 都带 ACAO *、页面不发 Referer),网络错 / 超时 / 非 200 / 没有 #EXTM3U → 经 /api/config 的 Worker(?url=)重试一次
//   (预览已经停了就不重试);
//   红楼系(vfile.meituan.net)的 http 分片升 https;https 页面上还剩 http 分片 → 不预览。拼好的清单按作品缓存 6 小时(sessionStorage,50 部)
// 预算:单次清单估算 4MB / 实收 5MB 硬顶 / 本会话 60MB / 每天 150MB(非计量网络);同时只有一个预览;离开卡片 / 滚动 / 切走页面就停
// 不预览:省流量 / 2G·3G / 蜂窝网络或触屏上网络类型未知(设置里没允许)/ 电视 / 没有 MSE(iPhone)/ 系统「减少动态效果」/ 主播放器在放 / 页面隐藏 /
//   刷短片开着 / 隐私锁着 / 设置里关了
// 只依赖页面上的 window.Hls(补丁版 hls.min.js)和 window.DgAdult(adult/adult.js 的桥:作品信息、代理地址、主播放器忙不忙)
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && typeof root === 'object' && typeof root.document !== 'undefined' && root.document && root.document.addEventListener) {
        root.dgAdultPreview = api;
        try { api.boot(); } catch (e) { try { console.warn('[adult] 预览启动失败', e); } catch (_) { } }
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
    'use strict';

    // ======================= 拼剪清单(纯函数) =======================
    const SHORT_MAX_SEC = 120, SHORT_MAX_SEGS = 15;
    function absUrl(u, base) {
        if (/^https?:\/\//i.test(u)) return u;
        if (u.indexOf('//') === 0) return 'https:' + u;
        try { return new URL(u, base).href; } catch (e) { return u; }
    }
    function loc(url) {
        const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url || '');
        if (!m) return { host: '', dir: '' };
        const host = m[1].toLowerCase().replace(/:\d+$/, '');
        const p = m[2] || '/';
        return { host, dir: host + p.slice(0, p.lastIndexOf('/') + 1) };
    }
    function attr(line, name) {
        const m = new RegExp('(?:^|[:,])' + name + '=("([^"]*)"|[^,]*)').exec(line);
        return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
    }
    function median(a) { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; }
    // 隐式 IV = 媒体序号(16 字节大端);序号在 Number 安全整数范围内(老电视 WebView 没有 BigInt)
    function ivHex(n) { const v = Math.max(0, Math.floor(Number(n) || 0)); return '0x' + v.toString(16).padStart(32, '0'); }

    /** 清单 → { kind:'invalid'|'master'|'media', variants | header+segs };每个分片带它生效的 KEY / MAP / BYTERANGE、原媒体序号、组号、host+目录 */
    function parsePlaylist(text, baseUrl) {
        const L = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
        if (!L.some((l) => l.trim().indexOf('#EXTM3U') === 0)) return { kind: 'invalid' };
        if (L.some((l) => l.trim().indexOf('#EXT-X-STREAM-INF') === 0)) {
            const variants = [];
            for (let i = 0; i < L.length; i++) {
                const t = L[i].trim();
                if (t.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
                let j = i + 1;
                while (j < L.length && (!L[j].trim() || L[j].trim()[0] === '#')) j++;
                if (j >= L.length) break;
                const res = attr(t, 'RESOLUTION') || '';
                const wh = res.split('x').map(Number);
                variants.push({ url: absUrl(L[j].trim(), baseUrl), bandwidth: +(attr(t, 'BANDWIDTH') || 0), width: wh[0] || 0, height: wh[1] || 0, codecs: attr(t, 'CODECS') || '' });
                i = j;
            }
            return { kind: 'master', variants };
        }
        const header = { version: 3, targetDuration: 0, mediaSeq: 0, endlist: false, playlistType: '' };
        const segs = [];
        let key = null, map = null, g = 0, pendingBR = null, seq = 0, sawSeg = false;
        const brNext = Object.create(null);
        for (let i = 0; i < L.length; i++) {
            const t = L[i].trim();
            if (!t) continue;
            if (t.indexOf('#EXT-X-VERSION:') === 0) header.version = parseInt(t.slice(15), 10) || 3;
            else if (t.indexOf('#EXT-X-TARGETDURATION:') === 0) header.targetDuration = parseFloat(t.slice(22)) || 0;
            else if (t.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) { header.mediaSeq = parseInt(t.slice(22), 10) || 0; if (!sawSeg) seq = header.mediaSeq; }
            else if (t.indexOf('#EXT-X-PLAYLIST-TYPE:') === 0) header.playlistType = t.slice(21);
            else if (t === '#EXT-X-ENDLIST') header.endlist = true;
            else if (t === '#EXT-X-DISCONTINUITY') { if (sawSeg) g++; }
            else if (t.indexOf('#EXT-X-KEY:') === 0) {
                const method = (attr(t, 'METHOD') || 'NONE').toUpperCase();
                key = method === 'NONE' ? null : { method, uri: attr(t, 'URI') ? absUrl(attr(t, 'URI'), baseUrl) : '', iv: attr(t, 'IV'), keyformat: attr(t, 'KEYFORMAT') || 'identity', keyformatversions: attr(t, 'KEYFORMATVERSIONS') };
            } else if (t.indexOf('#EXT-X-MAP:') === 0) {
                map = { uri: absUrl(attr(t, 'URI') || '', baseUrl), byterange: attr(t, 'BYTERANGE') };
            } else if (t.indexOf('#EXT-X-BYTERANGE:') === 0) pendingBR = t.slice(17);
            else if (t.indexOf('#EXTINF:') === 0) {
                const dur = parseFloat(t.slice(8)) || 0;
                let j = i + 1;
                while (j < L.length && (!L[j].trim() || L[j].trim()[0] === '#')) {
                    const tj = L[j].trim();   // EXTINF 和地址之间可以夹 BYTERANGE
                    if (tj.indexOf('#EXT-X-BYTERANGE:') === 0) pendingBR = tj.slice(17);
                    j++;
                }
                if (j >= L.length) break;
                const url = absUrl(L[j].trim(), baseUrl);
                let byterange = null;
                if (pendingBR) {
                    const parts = pendingBR.split('@');
                    const len = +parts[0];
                    const o = parts[1] !== undefined ? +parts[1] : (brNext[url] || 0);
                    byterange = { len, off: o }; brNext[url] = o + len; pendingBR = null;
                }
                const l = loc(url);
                segs.push({ i: segs.length, seq, dur, url, g, key, map, byterange, host: l.host, dir: l.dir });
                seq++; sawSeg = true; i = j;
            }
        }
        return { kind: 'media', header, segs };
    }

    function topKey(counts) { let best = '', n = -1; for (const k in counts) if (counts[k] > n) { best = k; n = counts[k]; } return best; }

    /** 组级判定 → { groups, total, profile } */
    function classify(P) {
        const S = P.segs;
        const groups = [];
        for (const s of S) {
            let g = groups[s.g];
            if (!g) g = groups[s.g] = { g: s.g, segs: [], dur: 0, enc: 0, clear: 0 };
            g.segs.push(s); g.dur += s.dur;
            if (s.key) g.enc += s.dur; else g.clear += s.dur;
        }
        const G = groups.filter(Boolean);
        const total = G.reduce((a, g) => a + g.dur, 0);
        const shortish = (g) => g.dur <= SHORT_MAX_SEC && g.segs.length < SHORT_MAX_SEGS;
        const sigN = Object.create(null);
        for (const g of G) { g.sig = g.segs.map((s) => s.url).join('\n'); sigN[g.sig] = (sigN[g.sig] || 0) + 1; }
        const encDur = G.reduce((a, g) => a + g.enc, 0), clearDur = G.reduce((a, g) => a + g.clear, 0);
        for (const g of G) {
            g.repeat = sigN[g.sig] >= 2;
            g.clearInEnc = encDur > clearDur && g.enc === 0 && g.clear > 0 && shortish(g);
            g.creative = (g.repeat && shortish(g)) || g.clearInEnc;
        }
        const anyCreative = G.some((g) => g.creative) && G.some((g) => !g.creative);
        const dirDur = Object.create(null), durTotal = Object.create(null);
        let base = 0;
        for (const g of G) {
            if (g.creative) continue;
            for (const s of g.segs) { dirDur[s.dir] = (dirDur[s.dir] || 0) + s.dur; const k = s.dur.toFixed(3); durTotal[k] = (durTotal[k] || 0) + s.dur; base += s.dur; }
        }
        const mainDir = topKey(dirDur);
        const domDur = parseFloat(topKey(durTotal) || '0');
        const contentDirs = new Set(Object.keys(dirDur).filter((d) => dirDur[d] >= base * 0.1));
        let shortDur = 0;
        for (const g of G) if (!g.creative && shortish(g)) shortDur += g.dur;
        const packaged = base > 0 && shortDur / base >= 0.5;
        for (const g of G) {
            g.short = shortish(g);
            g.foreign = g.segs.some((s) => !contentDirs.has(s.dir));
            g.allMain = g.segs.every((s) => s.dir === mainDir);
            if (g.creative) { g.eligible = false; g.why = g.repeat ? 'repeat' : 'clear-in-aes'; }
            else if (g.repeat) { g.eligible = false; g.why = 'repeat-long'; }
            else if (g.foreign) { g.eligible = false; g.why = 'foreign-dir'; }
            else if (!g.short) { g.eligible = true; g.why = 'long'; }
            else if ((packaged || anyCreative) && g.allMain) { g.eligible = true; g.why = packaged ? 'packaged-piece' : 'between-creatives'; }
            else { g.eligible = false; g.why = 'short-suspect'; }
        }
        // 一组都不可选但有单目录的干净内容 → 放宽 C4(绝不放宽 C1–C3)
        let relaxed = false;
        if (!G.some((g) => g.eligible)) {
            for (const g of G) if (!g.creative && !g.repeat && g.allMain && g.why === 'short-suspect') { g.eligible = true; g.why = 'relaxed'; relaxed = true; }
        }
        return { groups: G, total, profile: { mainDir, domDur, contentDirs: Array.from(contentDirs), packaged, anyCreative, relaxed, encrypted: encDur > clearDur } };
    }

    function autoClips(contentSec) {
        if (contentSec < 90) return { k: 3, clipSec: 3 };
        if (contentSec < 300) return { k: 4, clipSec: 4 };
        if (contentSec < 1200) return { k: 5, clipSec: 4 };
        if (contentSec < 3600) return { k: 6, clipSec: 3.5 };
        return { k: 8, clipSec: 3 };
    }

    /**
     * @param {string} text  媒体(或 master)清单
     * @param {string} baseUrl 清单的地址(Worker 输出也传原始媒体地址;它的分片地址本来就是绝对的)
     * @param {object} [opts] { clips, clipSec, maxClipSec=7, bandwidth(bit/s), budgetBytes, minClips=3, keyUrl(u)=>u, segUrl(u)=>u }
     */
    function previewPlan(text, baseUrl, opts) {
        const o = opts || {};
        const P = parsePlaylist(text, baseUrl);
        if (P.kind === 'invalid') return { ok: false, reason: 'invalid' };
        if (P.kind === 'master') {
            const v = P.variants.slice().sort((a, b) => (a.bandwidth || 9e9) - (b.bandwidth || 9e9));
            const pick = v.find((x) => !x.height || Math.min(x.height, x.width || x.height) >= 360) || v[0];
            return { ok: false, reason: 'master', variant: pick || null, variants: P.variants };
        }
        if (!P.header.endlist) return { ok: false, reason: 'live' };
        if (!P.segs.length) return { ok: false, reason: 'empty' };
        if (P.segs.some((s) => s.key && (s.key.method !== 'AES-128' || !/^identity$/i.test(s.key.keyformat || 'identity')))) return { ok: false, reason: 'drm' };

        const C = classify(P);
        const total = C.total;
        const elig = new Array(P.segs.length).fill(false);
        for (const g of C.groups) {
            if (!g.eligible) continue;
            const n = g.segs.length;
            g.segs.forEach((s, k) => {
                if (s.dur < 1.0) return;                          // C5 尾巴 / 像素点
                if (n >= 3 && (k === 0 || k === n - 1)) return;    // C5 组的首尾
                elig[s.i] = true;
            });
        }
        // C6 掐头去尾(原时间轴)
        const short = total < 180;
        const headCut = short ? total * 0.08 : Math.max(total * 0.06, 15);
        const tailCut = short ? total * 0.05 : Math.max(total * 0.06, 10);
        let t = 0;
        const startAt = P.segs.map((s) => { const a = t; t += s.dur; return a; });
        for (const s of P.segs) if (startAt[s.i] < headCut || startAt[s.i] + s.dur > total - tailCut) elig[s.i] = false;
        const eligSec = P.segs.reduce((a, s) => a + (elig[s.i] ? s.dur : 0), 0);
        if (eligSec < 6) return { ok: false, reason: 'no-safe-content', stats: { totalSec: +total.toFixed(1), groups: C.groups.length, profile: C.profile } };

        const ac = autoClips(eligSec);
        let k = ac.k, clipSec = ac.clipSec;
        if (o.clips) k = o.clips;
        if (o.clipSec) clipSec = o.clipSec;
        const maxClipSec = o.maxClipSec || 7;
        const bw = o.bandwidth || 0;
        // 预算:按估算缩段数(不少于 minClips)
        if (bw && o.budgetBytes) {
            const segMed = median(P.segs.filter((s) => elig[s.i]).map((s) => s.dur));
            const perClip = Math.max(clipSec, segMed) * bw / 8;
            const fit = Math.floor(o.budgetBytes / perClip);
            k = Math.max(o.minClips || 3, Math.min(k, fit));
        }
        // 锚点均匀撒在 [headCut, total-tailCut],各吸附到最近的、没用过的可选分片
        const lo = headCut, hi = total - tailCut;
        const used = new Set();
        const clips = [];
        const half = (hi - lo) / k / 2;
        for (let c = 0; c < k; c++) {
            const at = lo + (c + 0.5) * (hi - lo) / k;
            let best = -1, bestD = Infinity;
            for (const s of P.segs) {
                if (!elig[s.i] || used.has(s.i)) continue;
                const odd = s.dur < 2 || s.dur > maxClipSec;   // 正常分片(2s..maxClipSec)优先,奇怪的只在没得选时
                const d = Math.abs(startAt[s.i] - at) + (odd ? half : 0);
                if (d < bestD) { best = s.i; bestD = d; }
            }
            if (best < 0) break;
            const pick = [P.segs[best]]; used.add(best);
            let sec = P.segs[best].dur;
            // ≥ 目标 75% 的单片自成一段(2609 的 2.64–3s、jpg-seg 的 4s);2s 片两两成段
            for (let j = best + 1; j < P.segs.length && sec < clipSec * 0.75; j++) {
                const s = P.segs[j];
                if (s.g !== P.segs[best].g || !elig[j] || used.has(j) || sec + s.dur > maxClipSec) break;
                pick.push(s); used.add(j); sec += s.dur;
            }
            clips.push({ at: +startAt[best].toFixed(2), sec: +sec.toFixed(2), segs: pick });
        }
        clips.sort((a, b) => a.segs[0].i - b.segs[0].i);
        // 挨着的两段(同组、序号相接)并成一段,连续的媒体里不插 DISCONTINUITY
        const merged = [];
        for (const c of clips) {
            const p = merged[merged.length - 1];
            if (p && p.segs[p.segs.length - 1].i + 1 === c.segs[0].i && p.segs[0].g === c.segs[0].g) { p.segs.push.apply(p.segs, c.segs); p.sec = +(p.sec + c.sec).toFixed(2); }
            else merged.push({ at: c.at, sec: c.sec, segs: c.segs.slice() });
        }

        const keyUrl = o.keyUrl || ((u) => u), segUrl = o.segUrl || ((u) => u);
        const picked = [];
        merged.forEach((c) => { c.segs.forEach((s) => picked.push(s)); });
        const maxDur = Math.max.apply(null, picked.map((s) => s.dur));
        const hasMap = picked.some((s) => s.map);
        const out = ['#EXTM3U', '#EXT-X-VERSION:' + Math.max(3, hasMap ? 6 : 3), '#EXT-X-TARGETDURATION:' + Math.ceil(maxDur), '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
        // KEY 跨 DISCONTINUITY 保持有效 → 只在变了时重写;隐式 IV 写成显式(按原媒体序号,所以每片都不同,每片前都写)
        let lastKeyLine = '#EXT-X-KEY:METHOD=NONE', lastMapLine = null;
        merged.forEach((c, ci) => {
            if (ci > 0) { out.push('#EXT-X-DISCONTINUITY'); lastMapLine = null; }
            for (const s of c.segs) {
                const keyLine = s.key
                    ? '#EXT-X-KEY:METHOD=' + s.key.method + ',URI="' + keyUrl(s.key.uri) + '",IV=' + (s.key.iv || ivHex(s.seq))
                    : '#EXT-X-KEY:METHOD=NONE';
                if (keyLine !== lastKeyLine) out.push(keyLine);
                lastKeyLine = keyLine;
                if (s.map) {
                    const ml = '#EXT-X-MAP:URI="' + segUrl(s.map.uri) + '"' + (s.map.byterange ? ',BYTERANGE="' + s.map.byterange + '"' : '');
                    if (ml !== lastMapLine) out.push(ml);
                    lastMapLine = ml;
                }
                if (s.byterange) out.push('#EXT-X-BYTERANGE:' + s.byterange.len + '@' + s.byterange.off);
                out.push('#EXTINF:' + s.dur + ',');
                out.push(segUrl(s.url));
            }
        });
        out.push('#EXT-X-ENDLIST');
        const pickedSec = picked.reduce((a, s) => a + s.dur, 0);
        const skipped = {};
        C.groups.filter((g) => !g.eligible).forEach((g) => { skipped[g.why] = (skipped[g.why] || 0) + 1; });
        return {
            ok: true,
            playlist: out.join('\n') + '\n',
            clips: merged.map((c) => ({ at: c.at, sec: c.sec, n: c.segs.length, group: c.segs[0].g, first: c.segs[0].i })),
            picked: picked.map((s) => s.i),
            stats: {
                totalSec: +total.toFixed(1), eligibleSec: +eligSec.toFixed(1), pickedSec: +pickedSec.toFixed(1), clips: merged.length,
                segDurMedian: median(P.segs.map((s) => s.dur)), groups: C.groups.length, skippedGroups: skipped,
                encrypted: C.profile.encrypted, packaged: C.profile.packaged, relaxed: C.profile.relaxed,
                estBytes: bw ? Math.round(pickedSec * bw / 8) : null,
            },
        };
    }

    // 预览用的 hls.js 配置:缓冲小、不重试清单、分片最多重试一次
    function previewHlsConfig() {
        return {
            autoStartLoad: true, startPosition: 0, enableWorker: true, lowLatencyMode: false,
            maxBufferLength: 8, maxMaxBufferLength: 12, maxBufferSize: 6 * 1024 * 1024, backBufferLength: 0,
            capLevelToPlayerSize: true, startFragPrefetch: false,
            manifestLoadingMaxRetry: 0, levelLoadingMaxRetry: 0, fragLoadingMaxRetry: 1, fragLoadingTimeOut: 8000,
        };
    }

    // ======================= 浏览器胶水的纯函数部分(也给测试用) =======================
    const PLAN_BUDGET = 4 * 1024 * 1024;    // 拼剪时的估算上限
    const HARD_CAP = 5 * 1024 * 1024;       // 单次预览实收硬顶(FRAG_LOADED 累加,到了就停)
    const SESSION_CAP = 60 * 1024 * 1024;   // 本会话
    const DAY_CAP = 150 * 1024 * 1024;      // 每天(非计量网络)
    const DWELL_MS = 600, PRESS_MS = 450;
    const HTTPS_OK = ['vfile.meituan.net'];   // 这些 CDN 的 http 分片升 https(证书有效);别的 http 分片在 https 页面上一律不预览
    // 各后端家族的实测码率(调研 phase4-prep §1.4,family 中位数);认不出按 1.5 Mbps
    const FAM_BPS = [['2609', 1.12e6], ['jpg', 1.28e6], ['cdn2020', 1.13e6], ['tsbf', 1.5e6], ['fdc', 1.39e6], ['souav', 0.77e6], ['preroll', 1.1e6],
        ['meituan', 1.51e6], ['hsck', 1.8e6], ['98cdn', 0.75e6], ['xyzyts', 0.98e6]];
    function famBps(fam) {
        const f = String(fam || '').toLowerCase();
        for (const x of FAM_BPS) if (f && f.indexOf(x[0]) >= 0) return x[1];
        return 1.5e6;
    }
    function upgradeHttps(u) {
        const s = String(u || '');
        const m = /^http:\/\/([^/?#:]+)/i.exec(s);
        if (!m) return s;
        const host = m[1].toLowerCase();
        return HTTPS_OK.some((h) => host === h || host.slice(-(h.length + 1)) === '.' + h) ? 'https://' + s.slice(7) : s;
    }
    // https 页面上清单里还有 http 分片 / 密钥 → 浏览器会拦(混合内容),不预览
    function hasInsecure(playlist) { return /(^|\n)http:\/\//.test(playlist) || /URI="http:\/\//.test(playlist); }
    // 作品(/api/catalog/work 的 JSON)→ 能拿来预览的线路:有第一集 .m3u8、没被多人判失效;服务器已按好坏排过,保持次序,最多 2 条
    function pickLines(work) {
        const out = [];
        const srcs = work && Array.isArray(work.sources) ? work.sources : [];
        for (const s of srcs) {
            if (!s || s._dead === true) continue;
            const url = firstM3u8(s.vod_play_url);
            if (!url) continue;
            out.push({ url, site: String(s.site_key || ''), fam: String(s._family || ''), dur: Number(s._dur) || 0 });
            if (out.length >= 2) break;
        }
        return out;
    }
    // 选集串「名$地址#名$地址」(多个播放源用 $$$ 隔开)里第一条 http(s) .m3u8
    function firstM3u8(playUrl) {
        const groups = String(playUrl || '').split('$$$');
        for (const g of groups) {
            for (const ep of g.split('#')) {
                const i = ep.lastIndexOf('$');
                const u = (i >= 0 ? ep.slice(i + 1) : ep).trim();
                if (/^https?:\/\/\S+\.m3u8(\?|$)/i.test(u)) return u;
            }
        }
        return '';
    }
    // 为什么现在不能预览('' = 可以)。env 由 envNow() 采集;单测直接喂
    function blockReason(env) {
        const e = env || {};
        if (!e.on) return 'off';
        if (e.tv) return 'tv';
        if (!e.mse) return 'no-mse';
        if (e.reducedMotion) return 'reduced-motion';
        if (e.hidden) return 'hidden';
        if (e.net) return e.net;
        if (e.busy) return 'main-player';
        if (e.feed) return 'feed';
        if (e.locked) return 'locked';
        if (e.sessionBytes >= SESSION_CAP) return 'session-budget';
        if (e.dayBytes >= DAY_CAP) return 'day-budget';
        return '';
    }
    // 每天的用量(localStorage,换日归零);读写都 try/catch
    function dayKey(now) { const d = new Date(now || Date.now()); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
    function makeBudget(ls, now) {
        const KEY = 'dg_pv_day';
        let session = 0;
        const read = () => { try { const o = JSON.parse((ls && ls.getItem(KEY)) || 'null'); return (o && o.d === dayKey(now ? now() : 0)) ? (+o.b || 0) : 0; } catch (e) { return 0; } };
        return {
            session: () => session,
            day: read,
            add(n) {
                const b = Math.max(0, Number(n) || 0);
                if (!b) return;
                session += b;
                try { if (ls) ls.setItem(KEY, JSON.stringify({ d: dayKey(now ? now() : 0), b: read() + b })); } catch (e) { }
            },
        };
    }
    // 拼好的清单按作品缓存(sessionStorage,6 小时,最多 50 部,先进先出);失败的原因也记(不反复去拉)。
    //   修订:记录可以带更短的 ttl(毫秒,只能比 6 小时短):拉清单失败这类可能是一时的,只记一小会儿
    const FAIL_TTL = 10 * 60e3;
    function makePlanCache(ss, now) {
        const KEY = 'dg_pv_plan', TTL = 6 * 3600e3, MAX = 50;
        const clock = () => (now ? now() : Date.now());
        const ttlOf = (r) => { const t = Number(r && r.ttl) || 0; return t > 0 && t < TTL ? t : TTL; };
        const fresh = (r) => !!r && clock() - r.at < ttlOf(r);
        const load = () => { try { const a = JSON.parse((ss && ss.getItem(KEY)) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
        const save = (a) => { try { if (ss) ss.setItem(KEY, JSON.stringify(a.slice(-MAX))); } catch (e) { } };
        return {
            get(wk) { const r = load().find((x) => x && x.wk === wk); return fresh(r) ? r : null; },
            put(wk, rec) { const a = load().filter((x) => x && x.wk !== wk && fresh(x)); a.push(Object.assign({ wk, at: clock() }, rec)); save(a); },
        };
    }

    // ======================= 浏览器胶水 =======================
    const state = {
        cur: null,          // 正在进行的一次预览 { wk, el, hls, video, src, bytes, stop }
        timer: 0, pressEl: null, pressCard: null, pressX: 0, pressY: 0, suppressClickUntil: 0, why: 'idle', budget: null, cache: null,
    };
    function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } }
    function D() { return root.DgAdult || null; }
    // 无痕(dgPrivacy):拼剪清单不进 sessionStorage(里面有作品键)
    function incog() { const A = D(); try { return !!(A && typeof A.incognito === 'function' && A.incognito()); } catch (e) { return false; } }
    function remember(wk, rec) { if (!incog()) cache().put(wk, rec); }
    function envNow() {
        const A = D();
        let reduced = false, mse = false, hidden = false, net = '', feed = false;
        try { reduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
        try { mse = !!(root.Hls && typeof root.Hls.isSupported === 'function' && root.Hls.isSupported()); } catch (e) { }
        try { hidden = !!root.document.hidden; } catch (e) { }
        try { net = A && typeof A.netNow === 'function' ? A.netNow() : ''; } catch (e) { }
        // 修订:触屏(长按预览)上浏览器不报网络类型(iPad Safari、Firefox 都没有 navigator.connection)= 网络未知,可能在用流量:
        //   设置里没开「移动网络也自动播放」就不预览(和刷短片同一口径);电脑鼠标悬停照旧
        if (!net && !hoverDevice()) {
            let conn = null;
            try { conn = root.navigator && root.navigator.connection; } catch (e) { }
            let cell = false;
            try { cell = !!(A && typeof A.cellOk === 'function' && A.cellOk()); } catch (e) { }
            if (!conn && !cell) net = 'net-unknown';
        }
        try { feed = !!(root.dgAdultFeed && typeof root.dgAdultFeed.isOpen === 'function' && root.dgAdultFeed.isOpen()); } catch (e) { }
        const B = budget();
        return {
            on: lsGet('dg_pv_on') !== '0', tv: !!(A && A.isTV && A.isTV()), mse, reducedMotion: reduced, hidden, net,
            busy: !!(A && A.mainBusy && A.mainBusy()), feed, locked: !!(A && A.privLocked && A.privLocked()),
            sessionBytes: B.session(), dayBytes: B.day(),
        };
    }
    function budget() { if (!state.budget) state.budget = makeBudget(root.localStorage || null, null); return state.budget; }
    function cache() { if (!state.cache) state.cache = makePlanCache(root.sessionStorage || null, null); return state.cache; }

    // c = 这次预览:中止用的控制器挂在它身上(修订:以前是全局 state.ctl,Worker 重试会把下一个预览的控制器顶掉,stop 中止错对象)
    function fetchText(url, c, ms) {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (c) c.ctl = ctl;
        const t = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { } }, ms || 6000) : 0;
        return root.fetch(url, { referrerPolicy: 'no-referrer', credentials: 'omit', mode: 'cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
            .then((r) => (r && r.ok) ? r.text() : null)
            .catch(() => null)
            .then((x) => { if (t) clearTimeout(t); if (c && c.ctl === ctl) c.ctl = null; return x; });
    }
    // 直连 → 不行再经 Worker 一次(只在网络错 / 超时 / 非 200 / 不是清单时)。
    //   修订:预览已经被停掉(离开卡片 / 滚动 / 点击 / 切走;stop 中止了直连)就不再经 Worker 重试 —— 以前每个半路停掉的预览都白打一次 Worker
    function getText(url, c, live) {
        return fetchText(url, c).then((tx) => {
            if (tx && tx.indexOf('#EXTM3U') >= 0) return { text: tx, via: 'direct' };
            if (live && !live()) return null;
            const A = D();
            const proxy = A && typeof A.proxyUrl === 'function' ? A.proxyUrl() : '';
            if (!proxy) return null;
            return fetchText(proxy + '/?url=' + encodeURIComponent(url), c).then((t2) => (t2 && t2.indexOf('#EXTM3U') >= 0) ? { text: t2, via: 'proxy' } : null);
        });
    }
    // 一条线路 → 拼剪清单(master 往下钻一层)
    function planFor(line, live, c) {
        let url = line.url;
        const step = (hop) => getText(url, c, live).then((r) => {
            if (!live()) return null;
            if (!r) return { fail: 'fetch' };
            const p = previewPlan(r.text, url, { bandwidth: famBps(line.fam), budgetBytes: PLAN_BUDGET, segUrl: upgradeHttps, keyUrl: upgradeHttps });
            if (p.reason === 'master' && p.variant && hop < 2) { url = p.variant.url; return step(hop + 1); }
            if (!p.ok) return { fail: p.reason || 'plan' };
            if (root.location && root.location.protocol === 'https:' && hasInsecure(p.playlist)) return { fail: 'http-seg' };
            return { playlist: p.playlist, clips: p.stats.clips, est: p.stats.estBytes };
        });
        return step(0);
    }
    // 修订:作品信息没拿到(fetchWorkRaw 在 401 / 503 / 断网 / 超时时都给 null)不当「这部没有能预览的线路」记 6 小时 ——
    //   只有真拿到了作品(带 sources 数组)才记 no-line;拉清单失败(可能是一时的)只记 10 分钟
    function isWork(w) { return !!(w && typeof w === 'object' && Array.isArray(w.sources)); }
    function getPlan(wk, live, c) {
        const hit = cache().get(wk);
        if (hit) return Promise.resolve(hit.playlist ? hit : null);
        const A = D();
        if (!A || typeof A.fetchWorkRaw !== 'function') return Promise.resolve(null);
        return Promise.resolve(A.fetchWorkRaw(wk)).then((w) => {
            if (!live()) return null;
            if (!isWork(w)) return null;
            const lines = pickLines(w);
            if (!lines.length) { remember(wk, { fail: 'no-line' }); return null; }
            let transient = false;   // 有一条线路是没拉到清单(不是清单本身不行)
            const tryAt = (i) => planFor(lines[i], live, c).then((r) => {
                if (!r || !live()) return null;
                if (r.playlist) { remember(wk, { playlist: r.playlist, clips: r.clips }); return r; }
                if (r.fail === 'fetch') transient = true;
                if (i + 1 < lines.length) return tryAt(i + 1);
                remember(wk, transient ? { fail: r.fail, ttl: FAIL_TTL } : { fail: r.fail });
                return null;
            });
            return tryAt(0);
        }).catch(() => null);
    }

    function stop(why) {
        clearTimeout(state.timer); state.timer = 0;
        state.pressEl = null; state.pressCard = null;
        const c = state.cur;
        state.cur = null;
        if (why) state.why = why;
        if (!c) return;
        c.dead = true;   // 先标死再中止:被中止的直连回来时 live() 已经是 false,不会再经 Worker 重试
        if (c.ctl) { try { c.ctl.abort(); } catch (e) { } c.ctl = null; }
        if (c.hls) { try { c.hls.destroy(); } catch (e) { } }
        if (c.src) { try { URL.revokeObjectURL(c.src); } catch (e) { } }
        const v = c.video;
        if (v) {
            try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { }
            if (v.parentNode) v.parentNode.removeChild(v);
        }
        if (c.el) { try { c.el.classList.remove('dg-pv-on'); } catch (e) { } }
    }
    function posterBox(el) { return (el && el.querySelector) ? el.querySelector('.poster-wrap') : null; }
    // 真正开始:拿清单 → hls.js 播 blob 清单(静音、循环、内联)→ 第一帧出来才把视频淡入
    function start(card, el) {
        const wk = card && (card._wk || card.wk);
        if (!wk || !el) return;
        const r0 = blockReason(envNow());
        if (r0) { state.why = r0; return; }
        if (state.cur && state.cur.wk === wk && state.cur.el === el) return;
        stop();
        const c = { wk, el, hls: null, video: null, src: '', bytes: 0, dead: false, ctl: null };
        state.cur = c;
        state.why = 'loading';
        const live = () => state.cur === c && !c.dead;
        getPlan(wk, live, c).then((plan) => {
            if (!live()) return;
            if (!plan || !plan.playlist) { state.why = 'no-plan'; stop(); return; }
            const r1 = blockReason(envNow());
            if (r1) { stop(r1); return; }
            const box = posterBox(el);
            if (!box || !root.Hls) { stop('no-box'); return; }
            const v = root.document.createElement('video');
            v.className = 'dg-pv-v';
            v.muted = true; v.defaultMuted = true; v.playsInline = true; v.loop = true; v.autoplay = false;
            v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.setAttribute('aria-hidden', 'true');
            v.preload = 'auto';
            box.appendChild(v);
            c.video = v;
            let hls;
            try { hls = new root.Hls(previewHlsConfig()); } catch (e) { stop('hls'); return; }
            c.hls = hls;
            const E = root.Hls.Events || {};
            hls.on(E.FRAG_LOADED, (_, d) => {
                const n = (d && d.frag && d.frag.stats && (d.frag.stats.loaded || d.frag.stats.total)) || (d && d.stats && d.stats.loaded) || 0;
                c.bytes += n;
                budget().add(n);
                if (c.bytes > HARD_CAP) stop('hard-cap');
            });
            hls.on(E.ERROR, (_, d) => { if (d && d.fatal) stop('error'); });
            v.addEventListener('playing', () => { if (live()) { el.classList.add('dg-pv-on'); state.why = 'playing'; } });
            try {
                c.src = URL.createObjectURL(new Blob([plan.playlist], { type: 'application/vnd.apple.mpegurl' }));
                hls.loadSource(c.src);
                hls.attachMedia(v);
                const p = v.play();
                if (p && typeof p.catch === 'function') p.catch(() => { if (live()) stop('play'); });
            } catch (e) { stop('attach'); }
        });
    }
    // ---- 触发:电脑停留 ≥600ms(鼠标离开就停);手机长按 ≥450ms(手指挪开 >10px / 提前松手不算;长按出来之后松手那一下不当点击)----
    function onHover(card, el, ev) {
        if (!el || !card) return;
        const touch = ev && ev.type === 'touchstart';
        if (!touch && !hoverDevice()) return;
        if (blockReason(envNow())) return;
        clearTimeout(state.timer);
        if (touch) {
            const t = ev.touches && ev.touches[0];
            state.pressEl = el; state.pressCard = card; state.pressX = t ? t.clientX : 0; state.pressY = t ? t.clientY : 0;
            state.timer = setTimeout(() => { if (state.pressEl === el) pressFire(); }, PRESS_MS);
            return;
        }
        const leave = () => {
            el.removeEventListener('mouseleave', leave);
            if (state.cur && state.cur.el === el) stop('leave');
            else if (state.hoverEl === el) { clearTimeout(state.timer); state.hoverEl = null; }
        };
        el.addEventListener('mouseleave', leave);
        state.hoverEl = el;
        state.timer = setTimeout(() => { if (state.hoverEl === el) start(card, el); }, DWELL_MS);
    }
    // 长按到点(或系统先发了长按的 contextmenu):开始预览
    function pressFire() {
        const el = state.pressEl, card = state.pressCard;
        clearTimeout(state.timer); state.timer = 0;
        if (!el || !card) return;
        state.suppressClickUntil = Date.now() + 900;
        start(card, el);
    }
    function hoverDevice() { try { return !!(root.matchMedia && root.matchMedia('(hover: hover) and (pointer: fine)').matches); } catch (e) { return false; } }
    let booted = false;
    function boot() {
        if (booted) return;
        booted = true;
        const d = root.document;
        injectCss();
        const H = root.dgAdultHooks;
        if (H && typeof H.add === 'function') { H.add('onCardHover', onHover); H.add('onPlayerReady', () => stop('main-player')); }
        else if (H) { H.onCardHover = onHover; H.onPlayerReady = () => stop('main-player'); }   // 主播放器一开始放就让路
        // 手指挪动 / 抬起:长按没到时间就作废;预览开着时滚动就停
        d.addEventListener('touchmove', (e) => {
            if (!state.pressEl) return;
            const t = e.touches && e.touches[0];
            if (t && (Math.abs(t.clientX - state.pressX) > 10 || Math.abs(t.clientY - state.pressY) > 10)) { clearTimeout(state.timer); state.pressEl = null; }
        }, { passive: true, capture: true });
        d.addEventListener('touchend', () => { if (state.pressEl && !state.cur) { clearTimeout(state.timer); state.pressEl = null; } }, { passive: true, capture: true });
        d.addEventListener('touchcancel', () => { clearTimeout(state.timer); state.pressEl = null; }, { passive: true, capture: true });
        // 长按出来预览后松手的那一下点击别开播放页(再点一下才开);长按时的系统菜单也拦掉
        d.addEventListener('click', (e) => {
            if (Date.now() < state.suppressClickUntil && state.cur && state.cur.el && state.cur.el.contains(e.target)) { e.preventDefault(); e.stopPropagation(); state.suppressClickUntil = 0; return; }
            if (state.cur || state.timer) stop('click');   // 点了卡片(开播放页)或别处:预览停
        }, true);
        // 修订:长按还没到 450ms 时也拦 —— 安卓 Chrome 的系统长按是 400ms(Android 11+ 默认),contextmenu 先到:以前图片菜单弹出来、
        //   随后的 touchcancel 把长按作废,手机上长按预览基本出不来。现在拦下它并就此开始预览(系统已经认定是长按了)
        d.addEventListener('contextmenu', (e) => {
            if (state.cur && state.cur.el && state.cur.el.contains(e.target)) { e.preventDefault(); return; }
            const pe = state.pressEl;
            if (pe && state.timer && typeof pe.contains === 'function' && pe.contains(e.target)) { e.preventDefault(); pressFire(); }
        }, true);
        // 在别处按下(手机)= 停
        d.addEventListener('pointerdown', (e) => { if (state.cur && state.cur.el && !state.cur.el.contains(e.target)) stop('tap-away'); }, { passive: true, capture: true });
        // 滚动(页面或横排)/ 切走 / 隐藏 → 停
        d.addEventListener('scroll', () => { if (state.cur || state.timer) stop('scroll'); }, { passive: true, capture: true });
        d.addEventListener('visibilitychange', () => { if (d.hidden) stop('hidden'); });
        try { root.addEventListener('blur', () => stop('blur')); root.addEventListener('pagehide', () => stop('pagehide')); } catch (e) { }
        // 隐私锁上 → 停
        try { const P = root.dgPrivacy; if (P && typeof P.onChange === 'function') P.onChange(() => { if (P.locked && P.locked()) stop('locked'); }); } catch (e) { }
    }
    const CSS = [
        '.poster-wrap > .dg-pv-v { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: 1; opacity: 0; transition: opacity .25s; pointer-events: none; background: transparent; }',
        '.dg-pv-on .poster-wrap > .dg-pv-v { opacity: 1; }',
        '.dg-pv-on .poster-wrap .dg-ov-dur, .dg-pv-on .poster-wrap .dg-ov-code, .dg-pv-on .poster-wrap .dg-ov-n, .dg-pv-on .poster-wrap .dg-ad-badge { z-index: 2; }',
        'html.dg-blur .dg-pv-on .poster-wrap > .dg-pv-v { filter: none; }',
    ].join('\n');
    function injectCss() {
        const d = root.document;
        if (!d || d.getElementById('dg-pv-css')) return;
        const s = d.createElement('style');
        s.id = 'dg-pv-css';
        s.textContent = CSS;
        (d.head || d.documentElement).appendChild(s);
    }
    // 控制台:dgAdultPreview.status() 看为什么没预览 / 用了多少流量
    function status() {
        const B = budget();
        return { why: state.why, playing: !!(state.cur && state.cur.video), wk: state.cur ? state.cur.wk : '', bytes: state.cur ? state.cur.bytes : 0, sessionMB: +(B.session() / 1048576).toFixed(2), dayMB: +(B.day() / 1048576).toFixed(2), block: blockReason(envNow()) };
    }

    return {
        parsePlaylist, classify, previewPlan, previewHlsConfig,
        famBps, upgradeHttps, hasInsecure, pickLines, firstM3u8, blockReason, makeBudget, makePlanCache, dayKey,
        PLAN_BUDGET, HARD_CAP, SESSION_CAP, DAY_CAP, DWELL_MS, PRESS_MS, FAIL_TTL,
        boot, start, stop, status, _onHover: onHover, _state: state,
    };
});
