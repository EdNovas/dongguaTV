/* 🖼️ 进度条缩略图预览(window.dgSeekPreview;判定核心 window.DgSeekPreviewCore,回归 scripts/seek-preview-test.mjs)
 *
 * 电脑:鼠标悬停在进度条上;手机/触屏(含手机端控制栏):按住拖动进度条 —— 指针上方出一张约 160px 宽的画面 + 时间。
 *
 * 做法:另开一个不挂进页面的 <video> + 它自己的 hls.js 实例,读【主播放器正在用的同一个清单地址】(已经过去广告 worker),
 *   autoStartLoad:false、前向缓冲 1~2s,每次只取 t 所在的那一个分片 → seek → 画到 canvas → 按分片下标缓存(LRU 200 张 / 8MB)。
 *   拖动时先拿已缓存里最近的一张顶上,停手 150ms 才去取;同时最多 1 个分片在路上;AES-128 加密的清单由 hls.js 自己解。
 *   主播放器剪过插播(adCut,清单变短)时,进度条上的时间先经 vue._cutToBase 换回原时间轴再找分片(预览实例读的是没剪的清单)。
 *   多码率主清单只取最低码率那一档。预览实例的清单只拉一次(内存里留着,startLoad 重载清单时不再走网络)。
 *
 * ⚠️ 绝不能抢主播放的带宽(v1.1.176:后台分析抢带宽,整站播不了):
 *   · 只在主视频暂停、或前方已缓冲 ≥20s(片尾不足 20s 时缓冲到片尾也算)时才取;起播 4s 内、拖动/卡顿后 2s 内、正在 seek、
 *     readyState 不够、页面在后台时一律不取;主视频一 waiting / seeking 就中止在路上的预览分片;取的过程中前方缓冲掉到 8s 以下也中止。
 *   · 不启用:省流量模式(saveData)、2G/3G、TV 模式、不支持 MSE(iPhone)、浏览器原生 HLS 通道(Safari / iPad attachNative)、
 *     主视频此刻不在 MSE 上(src 不是 blob:,比如同一次播放里换成了 MP4 直链)、直播、投屏、未登录预览框架、试看已结束;
 *     localStorage donggua_seekprev_off=1 手动关掉。
 *   · 每次播放(播放令牌)最多下 200MB、整个页面会话最多 1GB,超了这一集不再取(已缓存的照样显示)。
 *
 * ⚠️ 与主播放器完全隔离:不碰 dp.plugins.hls、_dpSwitchHls、_proxyRetrying、playToken / handleError 的任何状态,
 *   只读 vueApp._playToken / _cutToBase 等。接线只有四处(index.html):_dgHlsCustomType 的 hls.js 分支 bind(原生分支不接:
 *   那边主视频不是 blob:,这里自己不启用),play() 两处递增令牌后与 closeDetail 调 reset。预览实例绑定当时的播放令牌:换线路、换集、switchVideo、关播放页、下一次 play()、
 *   播放器销毁都会销毁它;任何时刻最多一个预览实例;所有失败都静默(没有缩略图),绝不弹错、绝不抛到页面。
 *   分片请求是普通 XHR:跨域的 SW 不碰(sw.js v43 起连 .png/.jpg 伪装分片也不碰),走代理的(?url=)本来就豁免。
 */
(function (root) {
    'use strict';

    const C = {
        THUMB_W: 160,            // 缩略图显示宽度(CSS px);竖屏片按高度封顶
        THUMB_H_MAX: 120,
        BOX_CHROME: 28,          // 框边 + 内边距 + 时间行占的高度(px)
        BOX_GAP: 10,             // 框底到进度条
        BOX_TOP: 4,              // 框顶到播放器上沿至少留
        MIN_PIC_H: 36,           // 画面高度低于这个就不出框
        LRU_MAX: 200,            // 每次播放最多缓存 200 张
        LRU_BYTES: 8e6,          // 且 data URL 合计不超过约 8MB(按 UTF-16 两字节算)
        IDLE_MS: 150,            // 指针停下 150ms 才去取
        GATE_RETRY_MS: 500,      // 主播放器不让取时,隔多久再看一眼(指针还在进度条上才看)
        FAIL_RETRY_MS: 1200,
        AHEAD_MIN: 20,           // 主视频前方缓冲 ≥20s 才取
        AHEAD_JOB_MIN: 8,        // 取的过程中掉到 8s 以下就中止
        SETTLE_MS: 2000,         // 主视频 waiting / seeking 之后 2s 内不取
        STARTUP_MS: 4000,        // 主视频开始播放后 4s 内不取
        JOB_TIMEOUT_MS: 12000,
        POLL_MS: 200,
        FAIL_MAX: 3,             // 连续失败 3 次,这一集不再取
        MAX_BUF: 1,              // 预览实例的前向缓冲(maxBufferLength);seek 点离片尾留够它,hls.js 就不会顺手取下一片
        MAX_MAX_BUF: 2,
        NEAR_SEC: 30,            // 拖动时顶上的"最近一张"最远差多少秒(长片按时长 1.5% 放宽)
        NEAR_FRAC: 0.015,
        TOKEN_BYTES: 200e6,
        SESSION_BYTES: 1000e6,
        JPEG_Q: 0.72
    };
    const SLOW_NET = ['slow-2g', '2g', '3g'];

    // ---------------- 纯逻辑(scripts/seek-preview-test.mjs 在 node 里直接跑) ----------------

    // 时间 t 落在哪个分片(frags 按 start 升序;t 在首片前 → 0,在末片后 → 末片);空/NaN → -1
    function fragIndexAt(frags, t) {
        const n = frags ? frags.length : 0;
        if (!n || typeof t !== 'number' || t !== t) return -1;
        if (!(t > frags[0].start)) return 0;
        let lo = 0, hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (frags[mid].start <= t) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    // 一个分片拿哪一帧当缩略图:片头往后 0.3×时长(最多 1s,避开切点黑场/转场),但离片尾至少留 maxBuf+0.1s ——
    //   hls.js 的前向缓冲按 seek 点算,片内剩余 ≥ maxBufferLength 它就不会再去取下一片(省一个分片的流量)
    function thumbTime(frag, maxBuf) {
        const s = +frag.start || 0, d = +frag.duration || 0;
        if (!(d > 0)) return s;
        const lo = Math.min(0.1, d / 2);
        let off = Math.min(1, d * 0.3, d - (maxBuf == null ? C.MAX_BUF : maxBuf) - 0.1);
        if (!(off >= lo)) off = lo;
        return s + off;
    }

    // 带字节上限的 LRU(Map 保持插入顺序;get 算一次使用)
    class Lru {
        constructor(max, maxBytes) { this.max = max; this.maxBytes = maxBytes; this.m = new Map(); this.bytes = 0; }
        get size() { return this.m.size; }
        has(k) { return this.m.has(k); }
        peek(k) { const e = this.m.get(k); return e ? e.v : undefined; }
        get(k) {
            const e = this.m.get(k);
            if (!e) return undefined;
            this.m.delete(k); this.m.set(k, e);
            return e.v;
        }
        set(k, v, size) {
            const old = this.m.get(k);
            if (old) { this.bytes -= old.size; this.m.delete(k); }
            const sz = size > 0 ? size : 0;
            this.m.set(k, { v, size: sz });
            this.bytes += sz;
            while (this.m.size > 1 && (this.m.size > this.max || this.bytes > this.maxBytes)) {
                const k0 = this.m.keys().next().value;
                this.bytes -= this.m.get(k0).size;
                this.m.delete(k0);
            }
        }
        keys() { return Array.from(this.m.keys()); }
        clear() { this.m.clear(); this.bytes = 0; }
    }

    // 已缓存的分片里离 t 最近的一个(距离按分片区间算,t 在片内为 0);超过 maxSec 返回 -1
    function nearestKey(keys, frags, t, maxSec) {
        let best = -1, bd = Infinity;
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i], f = frags && frags[k];
            if (!f) continue;
            const e = f.start + f.duration;
            const d = t < f.start ? f.start - t : (t > e ? t - e : 0);
            if (d < bd) { bd = d; best = k; }
        }
        return bd <= maxSec ? best : -1;
    }
    function nearSec(dur) { return Math.max(C.NEAR_SEC, (dur > 0 && isFinite(dur) ? dur : 0) * C.NEAR_FRAC); }

    // TimeRanges 形状 b:t 前方连续缓冲多少秒(t 比段起点早 0.3s 内也算在段里:起播/跳转后的小缝)
    function bufferedAhead(b, t) {
        if (!b || !(t >= 0)) return 0;
        for (let i = 0; i < b.length; i++) {
            const s = b.start(i), e = b.end(i);
            if (t >= s - 0.3 && t <= e) return Math.max(0, e - t);
        }
        return 0;
    }
    function isBuffered(b, t) {
        if (!b || !(t >= 0)) return false;
        for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t < b.end(i) - 0.02) return true;
        return false;
    }
    // [s, e) 里有缓冲的一个点(分片实际时间戳比清单晚一点、缓冲段没盖住预定点时用);没有返回 null
    function pointIn(b, s, e) {
        if (!b) return null;
        for (let i = 0; i < b.length; i++) {
            const a = Math.max(b.start(i), s), z = Math.min(b.end(i), e);
            if (z - a > 0.05) return a + Math.min(0.3, (z - a) / 2);
        }
        return null;
    }

    // 带宽让路闸门:主视频状态 → 这时能不能去取一个预览分片。
    //   s = { hidden, paused, ended, seeking, readyState, ahead, remain, sinceStall(ms,没有为 Infinity), sincePlaying(ms,还没播过为 -1) }
    function gate(s) {
        if (!s) return { ok: false, why: 'nomain' };
        if (s.hidden) return { ok: false, why: 'hidden' };
        if (s.seeking) return { ok: false, why: 'seeking' };
        if (!(s.readyState >= 2)) return { ok: false, why: 'startup' };
        if (s.sinceStall < C.SETTLE_MS) return { ok: false, why: 'settle' };
        if (s.paused || s.ended) return { ok: true, why: 'paused' };
        if (!(s.sincePlaying >= C.STARTUP_MS)) return { ok: false, why: 'startup' };
        if (s.readyState < 3) return { ok: false, why: 'stall' };
        const need = Math.min(C.AHEAD_MIN, Math.max(0, (s.remain || 0) - 1));
        return s.ahead >= need ? { ok: true, why: 'ahead' } : { ok: false, why: 'buffer' };
    }
    // 取的过程中还能不能继续(waiting / seeking 由事件直接中止;这里兜住"前方缓冲在往下掉"和后台)
    function keepJob(s) {
        if (!s || s.hidden || s.seeking) return false;
        if (s.paused || s.ended) return true;
        if (s.readyState < 3) return false;
        const need = Math.min(C.AHEAD_JOB_MIN, Math.max(0, (s.remain || 0) - 1));
        return s.ahead >= need;
    }

    // 环境 → 为什么不启用('' = 启用)
    function disabledReason(e) {
        if (!e) return 'env';
        if (e.off) return 'off';
        if (e.saveData) return 'saveData';
        if (e.effectiveType && SLOW_NET.indexOf(String(e.effectiveType)) >= 0) return 'slowNet';
        if (e.tv) return 'tv';
        if (!e.hls) return 'noMse';
        if (e.preferNative) return 'native';
        if (!e.mse) return 'notMse';       // 主视频没挂在 MSE 上(原生 HLS / MP4 直链):不是 hls.js 在播
        if (e.live) return 'live';
        if (e.casting) return 'cast';
        if (!e.pointer) return 'noPointer';
        if (e.locked) return 'locked';
        if (e.trialEnded) return 'trial';
        return '';
    }

    // 预览框左边位置:以指针为中心,夹在容器里(两边留 pad);容器比框还窄就居中
    function boxLeft(x, boxW, contW, pad) {
        pad = pad == null ? 6 : pad;
        if (!(contW > boxW + 2 * pad)) return Math.max(0, (contW - boxW) / 2);
        return Math.min(Math.max(x - boxW / 2, pad), contW - boxW - pad);
    }

    // 与 DPlayer secondToTime 同格式:mm:ss / hh:mm:ss
    function fmtTime(sec) {
        sec = sec > 0 && isFinite(sec) ? sec : 0;
        const h = Math.floor(sec / 3600), m = Math.floor((sec - h * 3600) / 60), s = Math.floor(sec - h * 3600 - m * 60);
        const p = n => (n < 10 ? '0' : '') + n;
        return (h > 0 ? [h, m, s] : [m, s]).map(p).join(':');
    }

    // 缩略图显示尺寸:宽 160,按画面比例算高;竖屏片(短剧 9:16)高度封顶 120
    function thumbSize(vw, vh) {
        if (!(vw > 0 && vh > 0)) return { w: C.THUMB_W, h: Math.round(C.THUMB_W * 9 / 16) };
        let w = C.THUMB_W, h = Math.round(w * vh / vw);
        if (h > C.THUMB_H_MAX) { h = C.THUMB_H_MAX; w = Math.max(40, Math.round(h * vw / vh)); }
        return { w, h };
    }

    // 框得放进播放器里(容器圆角 overflow:hidden):手机竖屏播放器只有 ~190px 高,竖屏片 68×120 + 时间会顶出上沿被裁掉。
    //   room = 进度条上沿到容器上沿能给画面的高度(已扣掉框边、时间行、上下间距);放不下就等比缩;连 36px 都没有就不出框(留 DPlayer 自己的时间气泡)
    function fitSize(sz, room) {
        if (!sz || !(room >= C.MIN_PIC_H)) return null;
        if (sz.h <= room) return { w: sz.w, h: sz.h };
        const h = Math.floor(room);
        return { w: Math.max(24, Math.round(sz.w * h / sz.h)), h };
    }

    // 预览实例的 hls.js 配置:不自动加载、只取最低码率、前向缓冲 1~2s、失败少重试
    function hlsConfig(Loader) {
        const cfg = {
            autoStartLoad: false, startLevel: 0, capLevelToPlayerSize: false, testBandwidth: false, startFragPrefetch: false,
            maxBufferLength: C.MAX_BUF, maxMaxBufferLength: C.MAX_MAX_BUF, maxBufferSize: 0, maxBufferHole: 0.5,
            lowLatencyMode: false, enableWebVTT: false, enableIMSC1: false, enableCEA708Captions: false,
            manifestLoadingMaxRetry: 1, manifestLoadingTimeOut: 10000, levelLoadingMaxRetry: 1, levelLoadingTimeOut: 10000,
            fragLoadingMaxRetry: 1, fragLoadingRetryDelay: 500, fragLoadingTimeOut: 10000, debug: false
        };
        if (Loader) { cfg.loader = Loader; cfg.pLoader = Loader; }
        return cfg;
    }

    // 预览实例的 loader:清单(VOD / 主清单)拉一次就留在内存(startLoad 每次都会重载一遍清单),其余照常。
    //   继承离线 loader(已缓存的集分片直接从本机 IndexedDB 读,不走网络);契约同 index.html 的 OfflineLoader:
    //   命中时填 stats 调 onSuccess(..., null),onSuccess / super.load 不放在任何 catch 链里;abort/destroy 之后的迟到回调丢掉。
    //   fragOk(frag) = false 的分片(及其密钥)【不发请求】,挂着等 stopLoad 来 abort:hls.js 刚建好的实例在目标片缓冲完那一拍
    //   (内部 loadedmetadata 还没置位,取片位置 = 刚取完那片的片尾)会同步发出下一片的请求,我们的 FRAG_BUFFERED 监听排在它后面,
    //   只能事后 abort —— 请求其实已经出去了。挂着的 loader 没调过父类 load,abort/destroy 都是空操作(XhrLoader 没有 xhr、没有 callbacks)
    function makeLoader(Base, mem, nowFn, later, fragOk) {
        if (!Base) return null;
        return class SeekPreviewLoader extends Base {
            abort() { this._spDead = true; super.abort(); }
            destroy() { this._spDead = true; super.destroy(); }
            load(context, config, callbacks) {
                const ty = context && context.type;
                const isList = ty === 'manifest' || ty === 'level' || ty === 'audioTrack' || ty === 'subtitleTrack';
                if (!isList) {
                    const f = context && context.frag;
                    if (fragOk && f && f.sn !== 'initSegment' && f.type !== 'audio' && f.type !== 'subtitle' && !fragOk(f)) { this._spHeld = true; return; }
                    return super.load(context, config, callbacks);
                }
                const hit = mem.get(context.url);
                if (typeof hit === 'string') {
                    later(() => {
                        if (this._spDead) return;
                        const st = this.stats, t = nowFn();
                        try { st.loading.start = t; st.loading.first = t; st.loading.end = t; st.loaded = st.total = hit.length; } catch (e) { }
                        callbacks.onSuccess({ url: context.url, data: hit }, st, context, null);
                    });
                    return;
                }
                const onOk = callbacks.onSuccess;
                super.load(context, config, Object.assign({}, callbacks, {
                    onSuccess: (resp, stats, ctx, nd) => {
                        try {
                            const d = resp && resp.data;
                            if (typeof d === 'string' && d.length < 4e6 && /#EXT-X-(ENDLIST|STREAM-INF)/i.test(d)) mem.set(context.url, d);
                        } catch (e) { }
                        onOk(resp, stats, ctx, nd);
                    }
                }));
            }
        };
    }

    const CSS = [
        '.dg-sp{position:absolute;left:0;bottom:60px;z-index:40;display:none;box-sizing:border-box;padding:3px;flex-direction:column;align-items:center;',
        'pointer-events:none;background:rgba(20,20,20,.95);border:1px solid rgba(255,255,255,.14);border-radius:8px;box-shadow:0 5px 20px rgba(0,0,0,.5)}',
        '.dg-sp.on{display:flex}',
        '.dg-sp-pic{display:none;border-radius:5px;overflow:hidden;background:#000}',
        '.dg-sp.pic .dg-sp-pic,.dg-sp.wait .dg-sp-pic{display:block}',
        '.dg-sp-pic img{display:block;width:100%;height:100%;object-fit:cover}',
        '.dg-sp:not(.pic) .dg-sp-pic img{visibility:hidden}',
        '.dg-sp.wait .dg-sp-pic{background:linear-gradient(90deg,#161616 0%,#2a2a2a 50%,#161616 100%);background-size:200% 100%;animation:dgSpWait 1.1s linear infinite}',
        '.dg-sp.approx .dg-sp-pic img{opacity:.6}',
        '.dg-sp-t{color:#fff;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
        'padding:4px 4px 1px;font-variant-numeric:tabular-nums;white-space:nowrap}',
        '@keyframes dgSpWait{from{background-position:100% 0}to{background-position:-100% 0}}',
        // 预览框里已经有时间了:框亮着时把 DPlayer 自己的时间气泡藏起来(4 个类,压过全屏时 .dplayer-fulled .dplayer-bar-time 的 !important)
        '.dplayer.dg-sp-on .dplayer-bar-wrap .dplayer-bar-time{opacity:0!important;visibility:hidden!important}',
        '.dplayer-hide-controller .dg-sp{display:none!important}'
    ].join('');

    // ---------------- 控制器(浏览器里自动建一个;测试里注入假的 window/document/Hls/时钟) ----------------
    function createController(d) {
        d = d || {};
        const win = d.win || {};
        const doc = d.doc || null;
        const now = d.now || (() => Date.now());
        const setT = d.setTimeout || ((f, ms) => setTimeout(f, ms));
        const clrT = d.clearTimeout || (id => clearTimeout(id));
        const raf = d.raf || (f => setT(f, 16));
        const getHls = d.getHls || (() => win.Hls);
        const getVue = d.getVue || (() => win.vueApp);
        const log = d.log || (() => { });

        const S = {
            bound: null,     // 本次播放:{ player, video(主), url, tok, cache, failed, mem, fails, bytes, dead, details, stallAt, playingAt, ... }
            inst: null,      // 预览实例:{ b, hls, video, parsed, attached, loading, dead, flushAt }
            job: null,       // 在路上的那一个:{ inst, tBase, idx, sn, seekPos, buffered, ... }
            ptr: null,       // 指针:{ ui, x, t(播放时间轴), drag, at }
            pumpT: 0, rafId: 0, canvas: null,
            sessionBytes: 0,
            n: { binds: 0, jobs: 0, ok: 0, fail: 0, abort: 0 },
            why: ''
        };

        const vue = () => { try { return getVue() || null; } catch (e) { return null; } };
        const tokNow = () => { const v = vue(); return v ? v._playToken : undefined; };
        const stale = () => !!S.bound && tokNow() !== S.bound.tok;
        const lsOff = () => { try { return !!(win.localStorage && win.localStorage.getItem('donggua_seekprev_off') === '1'); } catch (e) { return false; } };

        function envNow() {
            const b = S.bound, v = vue(), g = v && v.currentGroup, mv = b && b.video;
            const nav = win.navigator || {}, c = nav.connection || nav.mozConnection || nav.webkitConnection || null;
            let tv = false, casting = false, mse = false;
            try { mse = !!mv && /^blob:/i.test(String(mv.src || mv.currentSrc || '')); } catch (e) { }
            try { tv = !!((v && v.isTVMode) || (doc && doc.body && doc.body.classList.contains('tv-mode'))); } catch (e) { }
            try { casting = !!(v && typeof v._isCasting === 'function' && v._isCasting()); } catch (e) { }
            return {
                off: b ? b.off : lsOff(), saveData: !!(c && c.saveData), effectiveType: c ? c.effectiveType : '',
                tv, hls: b ? b.hlsOk : false, preferNative: !!win._dgPreferNativeHls, mse,
                live: !!(v && (v._liveActive || (g && g._isLive))), casting,
                pointer: typeof win.PointerEvent === 'function',
                locked: !!(v && v.previewLocked), trialEnded: !!(v && v.trial && v.trial.on && v.trial.ended)
            };
        }

        function mainState() {
            const b = S.bound, v = b && b.video;
            if (!v) return null;
            const t = now(), ct = +v.currentTime || 0, dur = +v.duration;
            // 没收到 playing(绑定时已经在播)也要有起播计时:第一次看到它在播就从现在算 4s
            if (!b.playingAt && !v.paused && !v.ended && (v.readyState | 0) >= 3) b.playingAt = t;
            return {
                hidden: !!(doc && doc.hidden), paused: !!v.paused, ended: !!v.ended, seeking: !!v.seeking, readyState: v.readyState | 0,
                ahead: bufferedAhead(v.buffered, ct), remain: (dur > 0 && isFinite(dur)) ? dur - ct : 0,
                sinceStall: b.stallAt ? t - b.stallAt : Infinity, sincePlaying: b.playingAt ? t - b.playingAt : -1
            };
        }

        // 进度条时间(剪过插播的是剪后时间轴)→ 预览实例读的原清单时间轴
        function toBase(t) {
            try {
                const v = vue();
                if (v && typeof v._cutToBase === 'function') { const x = v._cutToBase(t); if (typeof x === 'number' && isFinite(x)) return x; }
            } catch (e) { }
            return t;
        }

        function schedPump(ms) { clrT(S.pumpT); S.pumpT = setT(pump, ms > 0 ? ms : 0); }
        function schedRender() { if (S.rafId) return; S.rafId = raf(() => { S.rafId = 0; render(); }) || 1; }

        // ---- 预览实例 ----
        function createInst(b) {
            const H = getHls();
            if (!H || !doc || !(H.isSupported && H.isSupported())) return null;
            const Base = win._OfflineHlsLoader || (H.DefaultConfig && H.DefaultConfig.loader);
            let inst = null;
            // 只放行这次要的那一片(和它的密钥);没有任务、别的实例的任务、hls.js 顺手预取的下一片一律挂着不发
            const fragOk = f => { const j = S.job; return !!(inst && !inst.dead && j && j.inst === inst && j.sn != null && f.sn === j.sn); };
            const Loader = makeLoader(Base, b.mem, now, f => setT(f, 0), fragOk);
            const video = doc.createElement('video');
            video.muted = true; video.playsInline = true; video.preload = 'auto';
            try { video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); } catch (e) { }
            const hls = new H(hlsConfig(Loader));
            inst = { b, hls, video, parsed: false, attached: false, lvlReq: false, loading: false, dead: false, flushAt: 0 };
            const E = H.Events;
            const mine = () => !inst.dead && S.inst === inst;
            hls.on(E.MANIFEST_PARSED, () => {
                try {
                    if (!mine()) return;
                    inst.parsed = true;
                    if (hls.levels && hls.levels.length > 1) hls.loadLevel = 0;   // 多码率:锁最低一档(levels 按码率升序)
                    kick(inst);
                } catch (e) { }
            });
            hls.on(E.LEVEL_LOADED, (ev, data) => {
                try {
                    if (!mine()) return;
                    const det = data && data.details;
                    if (!det || !det.fragments || !det.fragments.length) return die('empty');
                    if (det.live) return die('live');
                    b.details = det;
                    kick(inst);
                } catch (e) { }
            });
            hls.on(E.FRAG_LOADED, (ev, data) => {
                try {
                    const n = (data && data.payload && data.payload.byteLength) || (data && data.frag && data.frag.stats && data.frag.stats.loaded) || 0;
                    b.bytes += n; S.sessionBytes += n;
                } catch (e) { }
            });
            hls.on(E.FRAG_BUFFERED, (ev, data) => {
                try {
                    const job = S.job, f = data && data.frag;
                    if (!mine() || !job || job.inst !== inst || !f || f.type !== 'main') return;
                    if (f.sn === job.sn) job.buffered = true;
                    check();   // 预定点有画面了就 stopLoad(顺手预取的下一片挂在 loader 里,一并 abort)
                } catch (e) { }
            });
            hls.on(E.ERROR, (ev, data) => {
                try {
                    if (!mine() || !data || !data.fatal) return;   // 非致命的分片错误 hls.js 自己按 fragLoadingMaxRetry 重试,超时由 JOB_TIMEOUT 兜
                    const det = String(data.details || data.type || '');
                    if (/^(frag|key)/i.test(det)) { destroyInst('error'); return; }   // 单个分片/密钥拿不到:算一次失败,下次换新实例再试
                    die('fatal:' + det);
                } catch (e) { }
            });
            const onV = () => { try { if (mine()) check(); } catch (e) { } };
            video.addEventListener('seeked', onV);
            video.addEventListener('loadeddata', onV);
            try { hls.loadSource(b.url); } catch (e) { try { hls.destroy(); } catch (e2) { } return null; }
            return inst;
        }

        function stopLoad(inst) {
            inst.loading = false;
            try { inst.hls.stopLoad(); } catch (e) { }
        }

        function flush(inst) {
            if (!inst || inst.dead || !inst.attached) return;
            try {
                const H = getHls();
                inst.hls.trigger(H.Events.BUFFER_FLUSHING, { startOffset: 0, endOffset: Number.POSITIVE_INFINITY, type: null });
                inst.flushAt = now();
            } catch (e) { }
        }

        function destroyInst(why) {
            const inst = S.inst;
            if (!inst) return;
            S.inst = null; inst.dead = true;   // 先摘掉:endJob 里失败计满会再调 die → destroyInst,不能二次销毁
            if (S.job && S.job.inst === inst) endJob(why || 'abort:destroy');
            try { inst.hls.destroy(); } catch (e) { }
            try { inst.video.removeAttribute('src'); inst.video.load(); } catch (e) { }
        }

        // 这一集不再取(已缓存的照样显示)
        function die(why) {
            const b = S.bound;
            if (b && !b.dead) { b.dead = why; log('本集停用:' + why); }
            destroyInst('abort:' + why);
        }

        // ---- 一次取图 ----
        function startJob(tBase) {
            const b = S.bound;
            if (!S.inst) {
                S.inst = createInst(b);
                if (!S.inst) { die('inst'); return; }
            }
            const inst = S.inst;
            const job = S.job = { inst, tBase, idx: -1, sn: null, seekPos: NaN, fs: 0, fe: 0, buffered: false, seeks: 0, t0: now(), timer: 0, poll: 0 };
            S.n.jobs++;
            job.timer = setT(() => { if (S.job === job) endJob('timeout'); }, C.JOB_TIMEOUT_MS);
            const tick = () => {
                if (S.job !== job) return;
                try {
                    if (!keepJob(mainState())) return endJob('abort:main');
                    if (job.idx < 0) kick(inst); else check();
                } catch (e) { }
                if (S.job === job) job.poll = setT(tick, C.POLL_MS);
            };
            job.poll = setT(tick, C.POLL_MS);
            kick(inst);
            schedRender();
        }

        function kick(inst) {
            const job = S.job, b = inst.b;
            if (!job || job.inst !== inst || inst.dead || !inst.parsed) return;
            if (!b.details) {
                // 主清单的子清单要 startLoad 才会拉。此时还没挂 <video>:stream-controller 没有 media 就不取分片,只拿到分片表
                if (!inst.lvlReq) { inst.lvlReq = true; try { inst.hls.startLoad(job.tBase); } catch (e) { } }
                return;
            }
            if (!inst.attached) { inst.attached = true; try { inst.hls.attachMedia(inst.video); } catch (e) { } }
            if (job.idx < 0) aim(job);
        }

        // 分片表到手:定下这一片和 seek 点,让 hls.js 只取这一片
        function aim(job) {
            const inst = job.inst, b = inst.b, v = inst.video, frags = b.details.fragments;
            if (inst.flushAt) {   // 上一张的缓冲还在清:清完再取(否则会把刚清掉的旧数据当成已缓冲)
                if (v.buffered && v.buffered.length && now() - inst.flushAt < 2000) return;
                inst.flushAt = 0;
            }
            const i = fragIndexAt(frags, job.tBase);
            if (i < 0) return endJob('range');
            if (b.cache.has(i)) return endJob('cached');
            const f = frags[i];
            job.idx = i; job.sn = f.sn; job.fs = f.start; job.fe = f.start + f.duration;
            job.seekPos = thumbTime(f, C.MAX_BUF);
            try { v.currentTime = job.seekPos; } catch (e) { }   // 还没元数据时就是默认起播点
            inst.loading = true;
            try { inst.hls.startLoad(job.seekPos); } catch (e) { return endJob('error'); }
            schedRender();
            check();
        }

        function check() {
            const job = S.job;
            if (!job || job.idx < 0) return;
            const inst = job.inst, v = inst.video;
            if (!job.buffered && isBuffered(v.buffered, job.seekPos)) job.buffered = true;
            if (!job.buffered) return;
            // video.buffered 是各 SourceBuffer 的交集:分离音轨(EXT-X-MEDIA)的片还没到时这里还是空的,继续等(视频片的下一片照样挂着不发)
            if (!isBuffered(v.buffered, job.seekPos)) {
                const alt = pointIn(v.buffered, job.fs, job.fe);   // 分片实际时间戳比清单晚一点:改到本片里有数据的地方
                if (alt == null) return;
                job.seekPos = alt;
            }
            if (inst.loading) stopLoad(inst);
            if (!(v.readyState >= 1)) return;
            if (Math.abs((+v.currentTime || 0) - job.seekPos) > 0.05) {
                if (job.seeks++ < 4) { try { v.currentTime = job.seekPos; } catch (e) { } }
                return;
            }
            if (v.seeking || v.readyState < 2) return;
            draw(job);
        }

        function draw(job) {
            const inst = job.inst, v = inst.video, b = inst.b;
            let url = '', sz = null;
            try {
                sz = thumbSize(v.videoWidth, v.videoHeight);
                const dpr = Math.min(2, Math.max(1, +win.devicePixelRatio || 1));
                const cv = S.canvas || (S.canvas = doc.createElement('canvas'));
                const W = Math.round(sz.w * dpr), H = Math.round(sz.h * dpr);
                cv.width = W; cv.height = H;
                const ctx = cv.getContext('2d');
                ctx.drawImage(v, 0, 0, W, H);
                const px = ctx.getImageData(W >> 1, H >> 1, 1, 1).data;
                if (px[3]) url = cv.toDataURL('image/jpeg', C.JPEG_Q);   // 中心像素全透明 = 帧还没解出来,当失败
            } catch (e) { url = ''; }
            if (!/^data:image\/jpeg/.test(url)) return endJob('draw');
            b.cache.set(job.idx, { url, w: sz.w, h: sz.h }, url.length * 2);
            b.lastSize = { w: sz.w, h: sz.h };
            endJob('ok');
        }

        function endJob(why) {
            const job = S.job;
            if (!job) return;
            S.job = null;
            clrT(job.timer); clrT(job.poll);
            const inst = job.inst, b = inst.b;
            if (inst.loading && !inst.dead) stopLoad(inst);
            inst.loading = false;
            const abort = why.indexOf('abort') === 0, neutral = why === 'cached' || why === 'range';
            if (why === 'ok') { S.n.ok++; b.fails = 0; }
            else if (abort) S.n.abort++;
            else if (!neutral) {
                S.n.fail++; b.fails++;
                if (job.idx >= 0) b.failed.add(job.idx);
            }
            if (why === 'ok' || abort) flush(inst);   // 画完/中止就清掉预览实例的缓冲(内存始终只有一片)
            S.why = why;
            if (!abort && !neutral && why !== 'ok' && b.fails >= C.FAIL_MAX && S.bound === b) die('fail:' + why);
            schedRender();
            if (S.ptr && S.bound === b && !b.dead) schedPump(why === 'ok' || neutral ? 0 : (abort ? C.GATE_RETRY_MS : C.FAIL_RETRY_MS));
        }

        // 指针停下后:该不该去取、能不能取
        function pump() {
            S.pumpT = 0;
            try {
                const p = S.ptr, b = S.bound;
                if (!p || !b || S.job || b.dead) return;
                const el = now() - p.at;
                if (el < C.IDLE_MS) return schedPump(C.IDLE_MS - el);
                if (stale()) return unbind('token');
                const dis = disabledReason(envNow());
                if (dis) { S.why = dis; return; }
                const tBase = toBase(p.t);
                const frags = b.details && b.details.fragments;
                if (frags) {
                    const i = fragIndexAt(frags, tBase);
                    if (i < 0 || b.cache.has(i) || b.failed.has(i)) return;
                }
                if (b.bytes >= C.TOKEN_BYTES || S.sessionBytes >= C.SESSION_BYTES) return die('budget');
                const g = gate(mainState());
                if (!g.ok) { S.why = g.why; return schedPump(C.GATE_RETRY_MS); }
                startJob(tBase);
            } catch (e) { }
        }

        // ---- 界面 ----
        function ensureCss() {
            if (!doc || doc.getElementById('dg-sp-css')) return;
            const st = doc.createElement('style');
            st.id = 'dg-sp-css';
            st.textContent = CSS;
            (doc.head || doc.documentElement).appendChild(st);
        }

        function installUi(player) {
            if (!doc || !player) return null;
            if (player.__dgSp) return player.__dgSp;
            const cont = player.container;
            const wrap = (player.template && player.template.playedBarWrap) || (cont && cont.querySelector && cont.querySelector('.dplayer-bar-wrap'));
            if (!cont || !wrap || typeof wrap.addEventListener !== 'function') return null;
            ensureCss();
            const box = doc.createElement('div'); box.className = 'dg-sp'; box.setAttribute('aria-hidden', 'true');
            const pic = doc.createElement('div'); pic.className = 'dg-sp-pic';
            const img = doc.createElement('img'); img.alt = ''; img.draggable = false;
            try { img.decoding = 'async'; } catch (e) { }
            const lab = doc.createElement('div'); lab.className = 'dg-sp-t';
            pic.appendChild(img); box.appendChild(pic); box.appendChild(lab); cont.appendChild(box);
            const ui = { player, cont, wrap, box, pic, img, lab, src: '', shown: false, cleanup: null };
            let dragId = null;
            const onDocMove = e => { if (e.pointerId === dragId) onPtr(ui, e.clientX, true); };
            const offDoc = () => {
                doc.removeEventListener('pointermove', onDocMove);
                doc.removeEventListener('pointerup', onDocUp);
                doc.removeEventListener('pointercancel', onDocUp);
            };
            const onDocUp = e => { if (e.pointerId !== dragId) return; dragId = null; offDoc(); onLeave(ui); };
            // 悬停只认鼠标/笔;触屏只在按住拖动时出(手指按下才有位置)
            const onWrapMove = e => { if (dragId == null && e.pointerType !== 'touch') onPtr(ui, e.clientX, false); };
            const onWrapLeave = () => { if (dragId == null) onLeave(ui); };
            const onWrapDown = e => {
                if (e.button > 0) return;
                dragId = e.pointerId;
                doc.addEventListener('pointermove', onDocMove, { passive: true });
                doc.addEventListener('pointerup', onDocUp, { passive: true });
                doc.addEventListener('pointercancel', onDocUp, { passive: true });
                onPtr(ui, e.clientX, true);
            };
            wrap.addEventListener('pointermove', onWrapMove, { passive: true });
            wrap.addEventListener('pointerleave', onWrapLeave, { passive: true });
            wrap.addEventListener('pointerdown', onWrapDown, { passive: true });
            ui.cleanup = () => {
                try {
                    offDoc();
                    wrap.removeEventListener('pointermove', onWrapMove);
                    wrap.removeEventListener('pointerleave', onWrapLeave);
                    wrap.removeEventListener('pointerdown', onWrapDown);
                    if (box.parentNode) box.parentNode.removeChild(box);
                    if (cont.classList) cont.classList.remove('dg-sp-on');
                } catch (e) { }
            };
            player.__dgSp = ui;
            try {
                if (player.events && typeof player.events.on === 'function') {
                    player.events.on('destroy', () => {
                        try { if (S.bound && S.bound.player === player) unbind('destroy'); } catch (e) { }
                        try { if (S.ptr && S.ptr.ui === ui) S.ptr = null; ui.cleanup(); player.__dgSp = null; } catch (e) { }
                    });
                }
            } catch (e) { }
            return ui;
        }

        function hide(ui) {
            if (!ui || !ui.shown) return;
            ui.shown = false;
            try { ui.box.classList.remove('on'); ui.cont.classList.remove('dg-sp-on'); } catch (e) { }
        }

        function onPtr(ui, x, drag) {
            try {
                const b = S.bound;
                if (!b || b.player !== ui.player) return hide(ui);
                if (stale()) { unbind('token'); return hide(ui); }
                if (disabledReason(envNow())) return hide(ui);
                const v = b.video, dur = +v.duration;
                if (!(dur > 0) || !isFinite(dur)) return hide(ui);
                const r = ui.wrap.getBoundingClientRect();
                if (!(r.width > 0)) return hide(ui);
                const ratio = Math.min(1, Math.max(0, (x - r.left) / r.width));
                S.ptr = { ui, x, t: ratio * dur, drag: !!drag, at: now() };
                schedRender();
                schedPump(C.IDLE_MS);
            } catch (e) { }
        }

        function onLeave(ui) {
            if (S.ptr && S.ptr.ui === ui) { S.ptr = null; clrT(S.pumpT); S.pumpT = 0; }
            hide(ui);
        }

        function render() {
            try {
                const p = S.ptr, b = S.bound;
                if (!p) return;
                const ui = p.ui;
                if (!b || b.player !== ui.player) return hide(ui);
                const frags = b.details && b.details.fragments;
                let ent = null, approx = false, wait = false;
                if (frags) {
                    const tBase = toBase(p.t), i = fragIndexAt(frags, tBase);
                    if (i >= 0) {
                        ent = b.cache.get(i) || null;
                        if (!ent) {
                            const k = nearestKey(b.cache.keys(), frags, tBase, nearSec(+b.video.duration));
                            if (k >= 0) { ent = b.cache.peek(k); approx = true; }
                        }
                        wait = !!(S.job && (S.job.idx === i || S.job.idx < 0));
                    }
                } else wait = !!S.job;
                if (!ent && !wait) return hide(ui);
                // 位置:容器内坐标(容器若被 CSS 缩放,按 offsetWidth/rect 宽换算);框底在进度条上方 10px,框顶不出播放器上沿
                const cr = ui.cont.getBoundingClientRect();
                const sx = cr.width > 0 ? (ui.cont.offsetWidth || cr.width) / cr.width : 1;
                const bar = (ui.wrap.querySelector && ui.wrap.querySelector('.dplayer-bar')) || ui.wrap;
                const br = bar.getBoundingClientRect();
                const room = (br.top - cr.top) * sx - C.BOX_GAP - C.BOX_TOP - C.BOX_CHROME;
                const sz = fitSize(ent ? { w: ent.w, h: ent.h } : (b.lastSize || thumbSize(0, 0)), room);
                if (!sz) return hide(ui);
                if (ent && ui.src !== ent.url) { ui.img.src = ent.url; ui.src = ent.url; }
                const cl = ui.box.classList;
                cl.toggle('pic', !!ent); cl.toggle('approx', !!ent && approx); cl.toggle('wait', !ent && wait);
                ui.pic.style.width = sz.w + 'px'; ui.pic.style.height = sz.h + 'px';
                const boxW = Math.max(sz.w, 56) + 8;
                ui.box.style.width = boxW + 'px';
                const label = fmtTime(p.t);
                if (ui.lab.textContent !== label) ui.lab.textContent = label;
                const left = boxLeft((p.x - cr.left) * sx, boxW, ui.cont.offsetWidth || cr.width, 6);
                ui.box.style.left = Math.round(left) + 'px';
                ui.box.style.bottom = Math.round(Math.max(0, (cr.bottom - br.top) * sx + C.BOX_GAP)) + 'px';
                if (!ui.shown) { ui.shown = true; cl.add('on'); ui.cont.classList.add('dg-sp-on'); }
            } catch (e) { }
        }

        // ---- 主视频:waiting / seeking 立刻中止在路上的预览;记下起播时刻 ----
        function hookMain(v) {
            if (!v || v.__dgSpHooked || typeof v.addEventListener !== 'function') return;
            v.__dgSpHooked = true;
            const stall = ev => {
                try {
                    const b = S.bound;
                    if (!b || b.video !== v) return;
                    b.stallAt = now();
                    if (S.job) endJob('abort:' + ev.type);
                } catch (e) { }
            };
            v.addEventListener('waiting', stall);
            v.addEventListener('seeking', stall);
            v.addEventListener('playing', () => { try { const b = S.bound; if (b && b.video === v && !b.playingAt) b.playingAt = now(); } catch (e) { } });
        }
        if (doc && typeof doc.addEventListener === 'function') {
            doc.addEventListener('visibilitychange', () => { try { if (doc.hidden && S.job) endJob('abort:hidden'); } catch (e) { } });
        }

        // ---- 接线入口(index.html 调;一律不抛) ----
        // _dgHlsCustomType 的 hls.js 分支:主播放器这次用的清单地址(必须在 hls.attachMedia 把 src 换成 blob: 之前读)
        function bind(player, video, url) {
            try {
                const tok = tokNow(), b0 = S.bound;
                if (b0 && b0.player === player && b0.video === video && b0.url === url && b0.tok === tok) return;
                unbind('rebind');
                if (!player || !video || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
                const H = getHls();
                let hlsOk = false;
                try { hlsOk = !!(H && H.isSupported && H.isSupported()); } catch (e) { }
                S.bound = {
                    player, video, url, tok, hlsOk, off: lsOff(),
                    cache: new Lru(C.LRU_MAX, C.LRU_BYTES), failed: new Set(), mem: new Map(),
                    fails: 0, bytes: 0, dead: '', details: null, stallAt: 0, playingAt: 0, lastSize: null
                };
                S.n.binds++;
                installUi(player);
                hookMain(video);
            } catch (e) { }
        }
        // 原生通道 / 新的 play() / 关播放页 / 播放器销毁
        function unbind(reason) {
            try {
                const b = S.bound;
                if (S.job) endJob('abort:' + (reason || 'unbind'));
                destroyInst('abort:' + (reason || 'unbind'));
                S.bound = null;
                if (S.ptr) { const ui = S.ptr.ui; S.ptr = null; hide(ui); }
                else if (b && b.player && b.player.__dgSp) hide(b.player.__dgSp);
                clrT(S.pumpT); S.pumpT = 0;
            } catch (e) { }
        }

        function status() {
            const b = S.bound, j = S.job;
            let dis = '';
            try { dis = b ? disabledReason(envNow()) : 'unbound'; } catch (e) { }
            return {
                bound: !!b, url: b ? String(b.url).slice(0, 120) : '', tok: b ? b.tok : null, stale: stale(), disabled: dis, dead: b ? b.dead : '',
                frags: b && b.details ? b.details.fragments.length : 0, cached: b ? b.cache.size : 0, cacheKB: b ? Math.round(b.cache.bytes / 1024) : 0,
                failed: b ? b.failed.size : 0, fails: b ? b.fails : 0, MB: b ? +(b.bytes / 1e6).toFixed(1) : 0, sessionMB: +(S.sessionBytes / 1e6).toFixed(1),
                inst: !!S.inst, job: j ? { idx: j.idx, seekPos: j.seekPos, buffered: j.buffered, ms: Math.round(now() - j.t0) } : null,
                gate: b ? gate(mainState()) : null, last: S.why, n: Object.assign({}, S.n)
            };
        }

        return { bind, unbind, reset: unbind, status, _S: S };
    }

    const Core = {
        C, fragIndexAt, thumbTime, Lru, nearestKey, nearSec, bufferedAhead, isBuffered, pointIn, gate, keepJob,
        disabledReason, boxLeft, fmtTime, thumbSize, fitSize, hlsConfig, makeLoader, createController
    };
    if (typeof module === 'object' && module && module.exports) module.exports = Core;
    root.DgSeekPreviewCore = Core;
    if (root.document && typeof root.document.createElement === 'function' && !root.dgSeekPreview) {
        root.dgSeekPreview = createController({
            win: root, doc: root.document,
            now: () => (root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now()),
            setTimeout: (f, ms) => root.setTimeout(f, ms),
            clearTimeout: id => root.clearTimeout(id),
            raf: f => (typeof root.requestAnimationFrame === 'function' ? root.requestAnimationFrame(f) : root.setTimeout(f, 16)),
            log: m => { try { console.log('[进度预览] ' + m); } catch (e) { } }
        });
    }
})(typeof window !== 'undefined' ? window : globalThis);
