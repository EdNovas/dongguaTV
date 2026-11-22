/* [adult] 播放器增强(window.dgAdultPlayer;纯逻辑 window.DgAdultPlayerCore;回归 scripts/adult-player-test.mjs)
 *
 * 三件事,全部挂在 window.dgAdultHooks(index.html / adult.js 调)上,自己不改 index.html / adult.js / seek-preview.js:
 *
 * ① 高光热度条(O3):进度条正上方一条细的"最常回看"曲线(SVG,100 格,平滑),插在 .dplayer-bar 里(absolute,bottom:100%):
 *    不占布局、跟着进度条的位置/宽度走(手机 / 全屏 / 网页全屏都不用量),pointer-events:none;
 *    进度条缩略图框亮着(容器 .dg-sp-on)时藏起来。数据:GET /api/catalog/heat/:wk(204 = 不到 3 人,不画)——
 *    等主视频第一次 playing(或 4 秒兜底)才去拿,不跟起播抢。
 *    贡献:timeupdate 增量按 1% 一格记"实际播了几秒"(只认 0.5x–2.5x、跳变 >2s 不算);一格播够 60% 算 1,每多播一整格 +1(回看),
 *    用户自己跳到某格并停留 ≥5s 再 +1(只认用户操作 1.5s 内的跳转;起播续播跳转、插播跳过这类程序跳转不算),每格封顶 15。
 *    pagehide / onPlayerDestroy / 换作品时 POST /api/catalog/heat {wk,dur,bins(100 字节 base64),dev}:
 *    看够 5 分钟或 30% 才发;同一部作品每个 UTC 日只发一次(localStorage dgx_heat_sent);无痕(dgPrivacy.incognito())一律不记不发、
 *    连设备号都不生成;直播不记。切后台时先存一份待发(dgx_heat_pend),iOS 后台被杀下次打开再补发。从不写 Vue 响应式状态。
 *
 * ② 手机手势(O8,只认触屏 (any-pointer: coarse)):在 #dplayer 上用【捕获阶段】监听,只有真的接管了才 preventDefault + 截停:
 *    · 长按 ≥450ms(视频在播;安卓系统长按的 contextmenu 先到就拦下它、从那一刻开始):按住期间 2 倍速 + 顶部「2x ▶▶」,
 *      松手/取消恢复原来的倍速(localStorage dplayer_speed 原样还回去,
 *      index.html 的 ratechange 会把 2 记成用户倍速);
 *    · 横滑(≥24px 且 |dx|>2|dy|):拖动定位,中间显示目标时间和差值,往进度条派发合成 pointermove(dgSeekPreview 据此出缩略图),
 *      松手才 seek,手指回到起点附近 = 取消;从屏幕左右边缘 16px 内起手的不接(系统返回手势);
 *    · 双击左右 35% 快退/快进 10 秒:index.html 原有(不重复做),这里只在它真的跳了之后补一个波纹 + 「−10s / +10s」(连点累加),
 *      并藏掉旧的提示框;中间双击 / 单击开关控制栏照旧由 index.html 处理。
 *    控制栏、齿轮 / 弹幕设置面板、遮罩、按钮和输入框上起手的触摸一律不碰;面板开着时也不碰。
 *    电脑:J / L = 后退 / 前进 10 秒,Shift+> / Shift+< = 加 / 减速(DPlayer 与 index.html 都没有这几个键;输入框里、TV 模式、直播不响应)。
 *
 * ③ 起播提速(O7):dgAdultHooks.onCardHover(card, el, ev) —— 电脑悬停 ≥150ms、手机 touchstart 立刻 —— 预取作品
 *    GET /api/catalog/work?k=(与 adult.js openWork 同一个地址;内存 LRU 20 条、60 秒有效、离开卡片未被领取就中止、同时最多 3 个),
 *    并给第一条线路的 m3u8 源站(和配了的 CORS 代理)加 <link rel=preconnect crossorigin>(同时最多 4 个)。
 *    dgAdultPlayer.prefetched(wk) → Promise<作品 JSON | null> | null,adult.js openWork 用它代替现拉。
 *    绝不预取 m3u8 / 分片;主视频(或任何没静音的视频)在播、页面在后台、省流量、断网、没过年龄门时一律不预取。
 */
(function (root) {
    'use strict';

    const C = Object.freeze({
        BINS: 100,
        BIN_FRAC: 0.6,            // 一格播够 60% 算看过
        BIN_CAP: 15,              // 每格封顶(契约范围 0..255,服务器也该夹)
        RATE_MIN: 0.5, RATE_MAX: 2.5,
        JUMP_MAX: 2,              // timeupdate 两次之间超过 2s = 跳转,不算看
        STAY_SEC: 5,              // 跳过去停留 ≥5s 才 +1
        USER_SEEK_MS: 1500,       // 用户操作后 1.5s 内的 seek 才算"用户跳的"
        RESUME_GRACE_MS: 1500,    // 第一次 playing 之后 1.5s 内的 seek(续播 / 起播对齐)不算
        SEND_MIN_SEC: 300, SEND_MIN_FRAC: 0.3,
        HEAT_MIN_USERS: 3,
        HEAT_DELAY_MS: 4000,      // 等不到 playing 时 4s 兜底再拿热度
        HEAT_TTL_MS: 600000,      // 同一部作品的热度内存里留 10 分钟
        HEAT_URL: '/api/catalog/heat/', HEAT_POST: '/api/catalog/heat',
        SENT_KEY: 'dgx_heat_sent', PEND_KEY: 'dgx_heat_pend', DEV_KEY: 'dgx_dev', SPEED_KEY: 'dplayer_speed',
        PEND_DELAY_MS: 8000,      // 打开页面 8s 后才补发上次没发出去的
        LP_MS: 450, LP_RATE: 2,
        MOVE_TOL: 10,             // 与 index.html 的点击判定同一个阈值
        SWIPE_MIN: 24, EDGE: 16,
        SEEK_STEP: 10,
        RIPPLE_ACC_MS: 900, RIPPLE_SHOW_MS: 650,
        SPEEDS: Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3]),   // 与 index.html new DPlayer 的 playbackSpeed 一致
        HOVER_DWELL_MS: 150, PF_TTL: 60000, PF_MAX: 20, PF_INFLIGHT: 3, PF_TIMEOUT: 10000,
        PC_MAX: 4, PC_REFRESH_MS: 10000
    });

    // ---------------- 纯逻辑(scripts/adult-player-test.mjs 在 node 里直接跑) ----------------
    const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
    const utcDay = (ms) => Math.floor(ms / 86400000);
    const fin = (x) => typeof x === 'number' && isFinite(x);
    function binOf(t, dur) {
        if (!(dur > 0) || !fin(dur) || !fin(t)) return -1;
        return clamp(Math.floor(t / dur * C.BINS), 0, C.BINS - 1);
    }
    // [a, b) 这段播放按格分摊到 w(长度 100);返回实际记进去的秒数
    function addWatched(w, a, b, dur) {
        if (!(dur > 0) || !fin(dur) || !fin(a) || !fin(b)) return 0;
        a = Math.max(0, a); b = Math.min(dur, b);
        if (!(b > a)) return 0;
        const L = dur / C.BINS;
        let i = clamp(Math.floor(a / L), 0, C.BINS - 1), added = 0;
        while (a < b && i < C.BINS) {
            const end = i === C.BINS - 1 ? b : Math.min(b, (i + 1) * L);
            const s = end - a;
            if (s > 0) { w[i] += s; added += s; a = end; }
            i++;
        }
        return added;
    }
    // 每格的上报值:播够 60% 算 1,之后每多一整格 +1;再加"跳过来停留"的 1;封顶 BIN_CAP
    function binsOut(w, bonus, dur) {
        const out = new Uint8Array(C.BINS);
        if (!(dur > 0) || !fin(dur)) return out;
        const L = dur / C.BINS;
        for (let i = 0; i < C.BINS; i++) {
            const passes = Math.floor((+w[i] || 0) / L + (1 - C.BIN_FRAC) + 1e-9);
            out[i] = clamp(Math.max(0, passes) + (bonus && bonus[i] ? 1 : 0), 0, C.BIN_CAP);
        }
        return out;
    }
    const eligible = (total, dur) => total >= C.SEND_MIN_SEC || (dur > 0 && fin(dur) && total >= C.SEND_MIN_FRAC * dur);
    function b64(bytes, btoaFn) {
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
        const f = btoaFn || (typeof btoa === 'function' ? btoa : null);
        return f ? f(s) : '';
    }
    const B64_100 = /^[A-Za-z0-9+/]{134}==$/;
    // 服务器热度 → 100 个 0..100 的数;不到 3 人 / 形状不对 / 全 0 → null
    function normHeat(j) {
        if (!j || typeof j !== 'object' || !Array.isArray(j.bins) || j.bins.length !== C.BINS) return null;
        if (!(+j.users >= C.HEAT_MIN_USERS)) return null;
        const bins = j.bins.map(x => (fin(+x) ? clamp(+x, 0, 100) : 0));
        return bins.some(x => x > 0) ? bins : null;
    }
    // [1,4,6,4,1] 平滑(两端按实际权重归一)
    function smoothBins(b) {
        const K = [1, 4, 6, 4, 1], n = b.length, out = new Array(n);
        for (let i = 0; i < n; i++) {
            let s = 0, w = 0;
            for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < n) { s += b[j] * K[k + 2]; w += K[k + 2]; } }
            out[i] = w ? s / w : 0;
        }
        return out;
    }
    // 曲线路径(viewBox 0 0 W H,preserveAspectRatio=none):Catmull-Rom → 三次贝塞尔;按最大值归一,顶上留 8%
    function heatPath(vals, W, H) {
        W = W || 1000; H = H || 100;
        const n = vals ? vals.length : 0;
        if (!n) return null;
        let max = 0;
        for (let i = 0; i < n; i++) if (vals[i] > max) max = vals[i];
        if (!(max > 0)) return null;
        const r1 = (x) => Math.round(x * 10) / 10;
        const pts = [];
        const yOf = (v) => clamp(H - (v / max) * H * 0.92, 0, H);
        pts.push([0, yOf(vals[0])]);
        for (let i = 0; i < n; i++) pts.push([(i + 0.5) * W / n, yOf(vals[i])]);
        pts.push([W, yOf(vals[n - 1])]);
        let line = 'M' + r1(pts[0][0]) + ' ' + r1(pts[0][1]);
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
            const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6, 0, H);
            const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6, 0, H);
            line += 'C' + r1(c1x) + ' ' + r1(c1y) + ' ' + r1(c2x) + ' ' + r1(c2y) + ' ' + r1(p2[0]) + ' ' + r1(p2[1]);
        }
        return { line, area: line + 'L' + W + ' ' + H + 'L0 ' + H + 'Z' };
    }
    // 横滑一整个播放器宽度代表多少秒:时长的 1/4,夹在 60s..900s,且不超过时长
    function scrubSpan(dur) {
        if (!(dur > 0) || !fin(dur)) return 0;
        return Math.min(dur, clamp(dur * 0.25, 60, 900));
    }
    // 横滑定位:起手 24px 是死区(回到死区里 = 取消);目标夹在 [0, 时长-0.5]
    function scrubTarget(t0, dx, width, dur) {
        const span = scrubSpan(dur);
        if (!(width > 0) || !span || !fin(t0) || !fin(dx)) return { t: t0, delta: 0, cancel: true };
        const ad = Math.abs(dx);
        if (ad < C.SWIPE_MIN) return { t: t0, delta: 0, cancel: true };
        const eff = (dx < 0 ? -1 : 1) * (ad - C.SWIPE_MIN);
        const t = clamp(t0 + eff / width * span, 0, Math.max(0, dur - 0.5));
        const delta = t - t0;
        return { t, delta, cancel: Math.abs(delta) < 1 };
    }
    // 与 DPlayer secondToTime 同格式
    function fmtTime(sec) {
        sec = sec > 0 && isFinite(sec) ? sec : 0;
        const h = Math.floor(sec / 3600), m = Math.floor((sec - h * 3600) / 60), s = Math.floor(sec - h * 3600 - m * 60);
        const p = n => (n < 10 ? '0' : '') + n;
        return (h > 0 ? [h, m, s] : [m, s]).map(p).join(':');
    }
    function fmtDelta(d) {
        if (!fin(d)) d = 0;
        const sign = d < 0 ? '−' : '+', a = Math.round(Math.abs(d));
        const h = Math.floor(a / 3600), m = Math.floor((a - h * 3600) / 60), s = a - h * 3600 - m * 60;
        const p = n => (n < 10 ? '0' : '') + n;
        return sign + (h > 0 ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s));
    }
    // 与 index.html 双击判定同一套分区:左 35% / 右 35% / 中间
    function zoneOf(x, left, width) {
        if (!(width > 0)) return 'C';
        const rx = (x - left) / width;
        return rx < 0.35 ? 'L' : rx > 0.65 ? 'R' : 'C';
    }
    // index.html 的双击跳转真的发生了没有(跳前/跳后读 currentTime;贴着片头片尾被夹住的也算)
    function seekedBy(before, after, dur, step) {
        if (!fin(before) || !fin(after)) return false;
        const d = after - before;
        if (Math.abs(d - step) < 0.6) return true;
        if (step < 0) return d < -0.05 && after <= 0.05;
        return d > 0.05 && dur > 0 && fin(dur) && after >= dur - 0.6;
    }
    function nextSpeed(cur, dir, list) {
        const L = (Array.isArray(list) && list.length ? list : C.SPEEDS).filter(x => fin(x) && x > 0).slice().sort((a, b) => a - b);
        cur = fin(cur) && cur > 0 ? cur : 1;
        if (dir > 0) { for (let i = 0; i < L.length; i++) if (L[i] > cur + 0.01) return L[i]; return null; }
        for (let i = L.length - 1; i >= 0; i--) if (L[i] < cur - 0.01) return L[i];
        return null;
    }
    // 触摸起手点在这些东西上 → 不接管(控制栏 / 齿轮菜单 / 弹幕设置 / 遮罩 / 跳过片头 / 预览框 / 任何按钮输入框)
    const DENY = ['dplayer-controller', 'dplayer-setting-box', 'dplayer-setting', 'dm-settings-panel', 'intro-skip-btn', 'mobile-play-overlay',
        'desktop-play-overlay', 'dplayer-mask', 'dplayer-comment-box', 'dplayer-comment', 'dplayer-bar-wrap', 'dplayer-menu', 'dplayer-info-panel',
        'dplayer-icons', 'dg-sp', 'dg-mob-row'];
    const TAG_RE = /^(input|textarea|select|button|a|label|option|summary|details|iframe)$/i;
    const ROLE_RE = /^(button|link|slider|menu|menuitem|dialog|textbox|checkbox|switch|tab|combobox|listbox|option)$/i;
    function interactive(t, cont) {
        let n = t, hops = 0;
        while (n && n !== cont && hops++ < 50) {
            if (n.tagName) {
                if (TAG_RE.test(String(n.tagName))) return true;
                if (n.isContentEditable) return true;
                const ga = typeof n.getAttribute === 'function' ? (k) => n.getAttribute(k) : () => null;
                const ce = ga('contenteditable');
                if (ce === '' || ce === 'true') return true;
                const role = ga('role');
                if (role && ROLE_RE.test(role)) return true;
                const cl = n.classList;
                if (cl && typeof cl.contains === 'function') for (let i = 0; i < DENY.length; i++) if (cl.contains(DENY[i])) return true;
            }
            n = n.parentNode;
        }
        return n !== cont;   // 走出了容器 / 层数异常 → 当不可接管
    }
    function panelOpen(cont) {
        try {
            if (!cont || typeof cont.querySelector !== 'function') return false;
            if (cont.querySelector('.dplayer-setting-box-open, .dplayer-mask-show, .dplayer-comment-setting-open, .dplayer-menu-show')) return true;
            const dm = cont.querySelector('.dm-settings-panel');
            if (dm && dm.style && dm.style.display && dm.style.display !== 'none') return true;
        } catch (e) { }
        return false;
    }
    function typingIn(el) {
        if (!el || !el.tagName) return false;
        if (/^(input|textarea|select)$/i.test(String(el.tagName))) return true;
        if (el.isContentEditable) return true;
        const ce = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
        return ce === '' || ce === 'true';
    }
    // 线路选集串的第一集地址(与 index.html 测速 latencyWorker 同一取法:$$$ 多组取含 m3u8 的那组,# 分集,$ 分名字和地址)
    function firstEpUrl(playUrl) {
        let s = typeof playUrl === 'string' ? playUrl : '';
        if (!s) return '';
        if (s.indexOf('$$$') >= 0) { const sets = s.split('$$$'); s = sets.find(x => x.toLowerCase().indexOf('m3u8') >= 0) || sets[0]; }
        const parts = s.split('#')[0].split('$');
        const u = String(parts.length > 1 ? parts[1] : parts[0]).trim();
        return /^https?:\/\/[^\s]+$/i.test(u) ? u : '';
    }
    function originOf(u, URLc) {
        try {
            const Uc = URLc || (typeof URL === 'function' ? URL : null);
            if (!Uc) return '';
            const x = new Uc(String(u));
            if (!/^https?:$/i.test(x.protocol) || x.username || x.password || !x.hostname) return '';
            return x.origin;
        } catch (e) { return ''; }
    }
    const validWk = (wk) => typeof wk === 'string' && wk.length <= 300 && /^[ct]:./.test(wk);
    function wkOf(card) {
        if (!card || typeof card !== 'object') return '';
        const k = card._wk || card.wk;
        return validWk(k) ? k : '';
    }

    const CSS = [
        // ① 热度条:插在 .dplayer-bar 里,贴着进度条上沿;控制栏藏起来它跟着藏(在进度条里面);缩略图框亮着时让开
        //   选择器要压过 DPlayer 自带的 ".dplayer svg{width:100%;height:100%}"(0,1,1)——只写 .dgx-heat 时桌面端曲线被压成进度条的 3px 高
        '.dplayer svg.dgx-heat,.dgx-heat{position:absolute;left:0;right:0;bottom:100%;width:100%;height:20px;margin-bottom:2px;overflow:visible;pointer-events:none;opacity:0;transition:opacity .2s;z-index:1}',
        '.dgx-heat.on{opacity:1}',
        '.dgx-heat-a{fill:var(--dgx-heat-fill,rgba(255,255,255,.2))}',
        '.dgx-heat-l{fill:none;stroke:var(--dgx-heat-line,var(--accent,#e50914));stroke-width:1.5;stroke-opacity:.9;vector-effect:non-scaling-stroke}',
        '.dplayer.dg-sp-on .dgx-heat{opacity:0!important}',
        '@media (pointer:coarse),(max-width:768px){#dplayer .dgx-heat{height:24px;margin-bottom:3px}}',
        '@media (prefers-contrast:more){.dgx-heat-a{fill:rgba(255,255,255,.35)}}',
        '@media (forced-colors:active){.dgx-heat{display:none}}',
        // ② 手势:旧的双击提示框换成波纹;视频区横向交给脚本(竖向照常滚页面,顺带去掉双击缩放);长按时藏掉倍速浮层
        '.dgx-on .dplayer-seek-hint{display:none!important}',
        '.dgx-on .dplayer-video-wrap{touch-action:pan-y;-webkit-user-select:none;user-select:none}',   // 长按不选中弹幕文字
        '.dgx-on{-webkit-touch-callout:none}',
        '.dgx-lp .dplayer-speed-indicator{opacity:0!important}',
        '.dgx-badge,.dgx-scrub,.dgx-rip{position:absolute;pointer-events:none;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums}',
        '.dgx-badge{top:14px;left:50%;transform:translateX(-50%);z-index:60;display:none;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;',
        'background:rgba(0,0,0,.62);font-size:13px;font-weight:700;line-height:1.2;letter-spacing:.02em;white-space:nowrap}',
        '.dgx-badge.on{display:flex}',
        '.dgx-badge i{font-style:normal;font-size:11px;animation:dgxPulse 1s ease-in-out infinite}',
        '@keyframes dgxPulse{0%,100%{opacity:1}50%{opacity:.45}}',
        '.dgx-rip{top:0;bottom:0;width:38%;z-index:55;display:none;align-items:center;justify-content:center;background:rgba(255,255,255,.12)}',
        '.dgx-rip.l{left:0;border-radius:0 50% 50% 0/0 50% 50% 0}',
        '.dgx-rip.r{right:0;border-radius:50% 0 0 50%/50% 0 0 50%}',
        '.dgx-rip.on{display:flex}',
        '.dgx-rip.a{animation:dgxRipA .3s ease-out}',
        '.dgx-rip.b{animation:dgxRipB .3s ease-out}',
        '@keyframes dgxRipA{from{opacity:0}to{opacity:1}}',
        '@keyframes dgxRipB{from{opacity:0}to{opacity:1}}',
        '.dgx-rip-t{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:15px;font-weight:700;line-height:1.2;text-shadow:0 1px 3px rgba(0,0,0,.6)}',
        '.dgx-rip-t i{font-style:normal;font-size:12px;letter-spacing:-2px}',
        '.dgx-scrub{left:50%;top:42%;transform:translate(-50%,-50%);z-index:60;display:none;flex-direction:column;align-items:center;gap:2px;',
        'padding:8px 16px;border-radius:12px;background:rgba(0,0,0,.62);white-space:nowrap}',
        '.dgx-scrub.on{display:flex}',
        '.dgx-scrub-t{font-size:22px;font-weight:700;line-height:1.15}',
        '.dgx-scrub-d{font-size:13px;font-weight:600;line-height:1.2;opacity:.88}',
        '.dgx-scrub.cancel .dgx-scrub-d{color:#ffb4b4}',
        '@media (prefers-reduced-motion:reduce){.dgx-rip.a,.dgx-rip.b,.dgx-badge i{animation:none}}'
    ].join('');

    // ---------------- 控制器(浏览器里自动建一个;测试里注入假的 window / document / 时钟 / fetch) ----------------
    function createPlayerX(d) {
        d = d || {};
        const win = d.win || {};
        const doc = d.doc || null;
        const now = d.now || (() => Date.now());
        const setT = d.setTimeout || ((f, ms) => setTimeout(f, ms));
        const clrT = d.clearTimeout || (id => clearTimeout(id));
        const log = d.log || (() => { });
        const URLc = d.URL || win.URL || (typeof URL === 'function' ? URL : null);

        const store = () => { try { return d.storage || win.localStorage || null; } catch (e) { return null; } };
        const lsGet = (k) => { try { const s = store(); return s ? s.getItem(k) : null; } catch (e) { return null; } };
        const lsSet = (k, v) => { try { const s = store(); if (!s) return false; s.setItem(k, v); return true; } catch (e) { return false; } };
        const lsDel = (k) => { try { const s = store(); if (s) s.removeItem(k); } catch (e) { } };
        const fetchFn = (u, o) => { const f = d.fetch || win.fetch; return f.call(win, u, o); };
        const mq = (q) => { try { return !!(win.matchMedia && win.matchMedia(q).matches); } catch (e) { return false; } };
        const AC = () => win.AbortController || (typeof AbortController === 'function' ? AbortController : null);

        const S = {
            dp: null, video: null, cont: null, wk: '', live: false, lineKey: '',
            vOff: null, dpHooked: null,
            sess: null,
            heat: { wk: '', tok: 0, ctl: null, data: null, el: null, waitT: 0, waiting: false },
            g: null, lp: null, scrub: null, lpClsT: 0, ctxBlockUntil: 0,
            rip: { side: '', at: 0, acc: 0, t: 0, flip: false },
            els: {},
            lastInputAt: -1e15, lastPtrType: '',
            pf: new Map(), hov: typeof WeakMap === 'function' ? new WeakMap() : null, pc: new Map(),
            dev: '', sentMem: Object.create(null), privSub: false,
            n: { sent: 0, pend: 0, pendSent: 0, heatGet: 0, heatShown: 0, pf: 0, pfAbort: 0, pc: 0, lp: 0, scrub: 0, scrubSeek: 0, rip: 0, key: 0 }
        };

        // ---------- 隐私 ----------
        function incognito() {
            try { const P = win.dgPrivacy; return !!(P && typeof P.incognito === 'function' && P.incognito()); }
            catch (e) { return true; }   // 隐私模块出错 = 当无痕(宁可不发)
        }
        function privSub() {
            if (S.privSub) return;
            const P = win.dgPrivacy;
            if (!P || typeof P.onChange !== 'function') return;
            S.privSub = true;
            try {
                P.onChange(() => {
                    try { if (incognito()) { if (S.sess) S.sess.off = true; lsDel(C.PEND_KEY); } } catch (e) { }
                });
            } catch (e) { }
        }

        // ---------- 小工具 ----------
        const qs = (el, sel) => { try { return el && typeof el.querySelector === 'function' ? el.querySelector(sel) : null; } catch (e) { return null; } };
        const rectOf = (el) => { try { const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null; return r || { left: 0, top: 0, width: 0, height: 0 }; } catch (e) { return { left: 0, top: 0, width: 0, height: 0 }; } };
        const addCls = (el, c) => { try { if (el && el.classList) el.classList.add(c); } catch (e) { } };
        const rmCls = (el, c) => { try { if (el && el.classList) el.classList.remove(c); } catch (e) { } };
        const rmEl = (el) => { try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) { } };
        const vw = () => { try { return +win.innerWidth || (doc && doc.documentElement ? +doc.documentElement.clientWidth : 0) || 0; } catch (e) { return 0; } };
        const touchCapable = () => mq('(any-pointer: coarse)') || mq('(pointer: coarse)');

        function ensureCss() {
            if (!doc || typeof doc.createElement !== 'function') return;
            try {
                if (typeof doc.getElementById === 'function' && doc.getElementById('dgx-css')) return;
                const st = doc.createElement('style');
                st.id = 'dgx-css';
                try { st.setAttribute('id', 'dgx-css'); } catch (e) { }
                st.textContent = CSS;
                (doc.head || doc.documentElement).appendChild(st);
            } catch (e) { }
        }
        function mkEl(tag, cls, text) {
            const el = doc.createElement(tag);
            if (cls) { try { el.className = cls; } catch (e) { } }
            if (text) el.textContent = text;
            return el;
        }
        // 叠在播放器上的小部件:DPlayer 重建会清空容器 → 用的时候发现不在容器里就重建
        function ensureEl(key, build) {
            const cont = S.cont;
            if (!cont || !doc) return null;
            const cur = S.els[key];
            if (cur && cur.box && cur.box.parentNode === cont) return cur;
            ensureCss();
            const x = build();
            cont.appendChild(x.box);
            S.els[key] = x;
            return x;
        }
        const badgeEl = () => ensureEl('badge', () => {
            const box = mkEl('div', 'dgx-badge');
            box.setAttribute('aria-hidden', 'true');
            box.appendChild(mkEl('b', '', C.LP_RATE + 'x'));
            box.appendChild(mkEl('i', '', '▶▶'));
            return { box };
        });
        const ripEl = (side) => ensureEl('rip' + side, () => {
            const box = mkEl('div', 'dgx-rip ' + (side === 'L' ? 'l' : 'r'));
            box.setAttribute('aria-hidden', 'true');
            const t = mkEl('div', 'dgx-rip-t');
            t.appendChild(mkEl('i', '', side === 'L' ? '◀◀' : '▶▶'));
            const lab = mkEl('span', '', '');
            t.appendChild(lab);
            box.appendChild(t);
            return { box, lab };
        });
        const scrubEl = () => ensureEl('scrub', () => {
            const box = mkEl('div', 'dgx-scrub');
            box.setAttribute('aria-hidden', 'true');
            const t = mkEl('div', 'dgx-scrub-t', '');
            const dd = mkEl('div', 'dgx-scrub-d', '');
            box.appendChild(t); box.appendChild(dd);
            return { box, t, d: dd };
        });

        // =============== ① 热度条 ===============
        function ensureHeatEl() {
            const cont = S.cont;
            if (!cont || !doc) return null;
            const bar = qs(cont, '.dplayer-bar-wrap .dplayer-bar');
            if (!bar) return null;
            const H = S.heat;
            if (H.el && H.el.svg.parentNode === bar) return H.el;
            removeHeatEl();
            ensureCss();
            const NS = 'http://www.w3.org/2000/svg';
            const mk = (t) => (typeof doc.createElementNS === 'function' ? doc.createElementNS(NS, t) : doc.createElement(t));
            const svg = mk('svg');
            svg.setAttribute('class', 'dgx-heat');
            svg.setAttribute('viewBox', '0 0 1000 100');
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.setAttribute('aria-hidden', 'true');
            svg.setAttribute('focusable', 'false');
            const a = mk('path'); a.setAttribute('class', 'dgx-heat-a');
            const l = mk('path'); l.setAttribute('class', 'dgx-heat-l');
            svg.appendChild(a); svg.appendChild(l);
            bar.appendChild(svg);
            H.el = { svg, a, l };
            return H.el;
        }
        function removeHeatEl() {
            const H = S.heat;
            if (H.el) { rmEl(H.el.svg); H.el = null; }
        }
        function drawHeat(bins) {
            if (!bins) { removeHeatEl(); return false; }
            const p = heatPath(smoothBins(bins), 1000, 100);
            if (!p) { removeHeatEl(); return false; }
            const el = ensureHeatEl();
            if (!el) return false;
            el.a.setAttribute('d', p.area);
            el.l.setAttribute('d', p.line);
            addCls(el.svg, 'on');
            S.n.heatShown++;
            return true;
        }
        function cancelHeat() {
            const H = S.heat;
            H.waiting = false;
            clrT(H.waitT); H.waitT = 0;
            if (H.ctl) { try { H.ctl.abort(); } catch (e) { } H.ctl = null; }
            H.tok++;
        }
        function scheduleHeat() {
            const H = S.heat;
            cancelHeat();
            if (!S.wk || S.live) { removeHeatEl(); return; }
            if (H.data && H.data.wk === S.wk && now() - H.data.at < C.HEAT_TTL_MS) { drawHeat(H.data.bins); return; }   // 同一部(换线路 / 重建播放器):重画,不重拿
            removeHeatEl();
            H.wk = S.wk;
            H.waiting = true;
            const v = S.video;
            if (v && !v.paused && !v.ended && (v.readyState | 0) >= 3) { fireHeat(); return; }
            H.waitT = setT(() => { if (H.waiting) fireHeat(); }, C.HEAT_DELAY_MS);
        }
        function fireHeat() {
            const H = S.heat;
            H.waiting = false;
            clrT(H.waitT); H.waitT = 0;
            const wk = S.wk;
            if (!wk || S.live) return;
            const tok = ++H.tok;
            const A = AC();
            const ctl = A ? new A() : null;
            H.ctl = ctl;
            S.n.heatGet++;
            let p;
            try { p = fetchFn(C.HEAT_URL + encodeURIComponent(wk), ctl ? { credentials: 'same-origin', signal: ctl.signal } : { credentials: 'same-origin' }); }
            catch (e) { H.ctl = null; return; }
            Promise.resolve(p).then(r => (r && r.status === 200 && typeof r.json === 'function') ? r.json() : null).then(j => {
                if (tok !== H.tok || S.wk !== wk) return;
                H.ctl = null;
                const bins = normHeat(j);
                H.data = { wk, bins, at: now() };
                drawHeat(bins);
            }).catch(() => { if (tok === H.tok) H.ctl = null; });
        }

        // ---------- 贡献 ----------
        function newSess(wk) {
            return {
                wk, dur: 0, w: new Float64Array(C.BINS), bonus: new Uint8Array(C.BINS), total: 0, lastT: null,
                seekBin: -1, stay: 0, userSeek: false, firstPlayAt: 0, off: incognito(), sent: false
            };
        }
        function onTime(v) {
            const s = S.sess;
            if (!s || s.off || s.sent || v !== S.video) return;
            const ct = +v.currentTime, dur = +v.duration;
            if (!(dur > 0) || !fin(dur) || !fin(ct)) return;
            s.dur = dur;
            if (s.lastT != null && !v.seeking && !v.paused) {
                const delta = ct - s.lastT, r = +v.playbackRate;
                if (delta > 0 && delta <= C.JUMP_MAX && r >= C.RATE_MIN && r <= C.RATE_MAX) {
                    s.total += addWatched(s.w, s.lastT, ct, dur);
                    if (s.seekBin >= 0) {
                        s.stay += delta;
                        if (s.stay >= C.STAY_SEC) { s.bonus[s.seekBin] = 1; s.seekBin = -1; }
                    }
                } else if (delta > C.JUMP_MAX || delta < -0.5) s.seekBin = -1;   // 位置跳走了(没有 seeking 事件的跳变):"停留"不再连续
            }
            s.lastT = ct;
        }
        function onSeeking(v) {
            const s = S.sess;
            if (!s || v !== S.video) return;
            s.lastT = null;
            s.seekBin = -1; s.stay = 0;
            const t = now();
            s.userSeek = !!(s.firstPlayAt && t - s.firstPlayAt >= C.RESUME_GRACE_MS && t - S.lastInputAt <= C.USER_SEEK_MS);
        }
        function onSeeked(v) {
            const s = S.sess;
            if (!s || v !== S.video) return;
            const ct = +v.currentTime;
            s.lastT = fin(ct) ? ct : null;
            if (s.userSeek) { const b = binOf(ct, +v.duration); if (b >= 0) { s.seekBin = b; s.stay = 0; } }
            s.userSeek = false;
        }
        function onPlaying(v) {
            if (v !== S.video) return;
            const s = S.sess;
            if (s && !s.firstPlayAt) s.firstPlayAt = now();
            if (S.heat.waiting && S.heat.wk === S.wk) fireHeat();
        }

        function sentMap() {
            try { const o = JSON.parse(lsGet(C.SENT_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
            catch (e) { return {}; }
        }
        function sentToday(wk) {
            const today = utcDay(now());
            if (S.sentMem[wk] === today) return true;
            const m = sentMap();
            return Object.prototype.hasOwnProperty.call(m, wk) && m[wk] === today;
        }
        function markSent(wk) {
            const today = utcDay(now());
            S.sentMem[wk] = today;
            const m = sentMap();
            const keep = Object.keys(m).filter(k => validWk(k) && k !== wk && +m[k] >= today - 1).sort((a, b) => m[b] - m[a]).slice(0, 299);
            const out = {};
            keep.forEach(k => { out[k] = +m[k]; });
            out[wk] = today;
            lsSet(C.SENT_KEY, JSON.stringify(out));
        }
        function randHex(n) {
            const a = new Uint8Array(n);
            let ok = false;
            try { const c = win.crypto; if (c && typeof c.getRandomValues === 'function') { c.getRandomValues(a); ok = true; } } catch (e) { }
            if (!ok) for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
            let s = '';
            for (let i = 0; i < n; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
            return s;
        }
        function devId() {
            if (S.dev) return S.dev;
            let v = lsGet(C.DEV_KEY);
            if (!/^[0-9a-f]{32}$/.test(v || '')) { v = randHex(16); lsSet(C.DEV_KEY, v); }
            S.dev = v;
            return v;
        }
        function canSend(s) {
            return !!s && !s.off && !s.sent && eligible(s.total, s.dur) && !incognito() && !sentToday(s.wk);
        }
        function payloadOf(s) {
            if (!(s.dur > 0) || !fin(s.dur)) return null;
            const bins = b64(binsOut(s.w, s.bonus, s.dur), win.btoa ? (x) => win.btoa(x) : null);
            return B64_100.test(bins) ? { wk: s.wk, dur: Math.round(s.dur), bins } : null;
        }
        function post(p, unloading) {
            const dev = devId();
            const body = { wk: p.wk, dur: p.dur, bins: p.bins, dev };
            const json = JSON.stringify(body);
            const nav = win.navigator || {};
            const viaBeacon = () => {
                try { if (typeof nav.sendBeacon === 'function' && typeof win.Blob === 'function') return !!nav.sendBeacon(C.HEAT_POST, new win.Blob([json], { type: 'application/json' })); } catch (e) { }
                return false;
            };
            // adult.js 的发了就不管的 POST:自带令牌 / 年龄头,不走 401 补核验 / 登录框
            const viaAuth = () => {
                try { const A = win.DgAdult; if (A && A.auth && typeof A.auth.post === 'function') { A.auth.post(C.HEAT_POST, body); return true; } } catch (e) { }
                return false;
            };
            const viaFetch = () => {
                try {
                    Promise.resolve(fetchFn(C.HEAT_POST, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: json })).catch(() => { });
                    return true;
                } catch (e) { return false; }
            };
            // 页面要走了:sendBeacon 最稳(带 Cookie);平时走 adult.js 的 POST(带令牌头)
            if (unloading) return viaBeacon() || viaAuth() || viaFetch();
            return viaAuth() || viaBeacon() || viaFetch();
        }
        function dropPending(wk) {
            const raw = lsGet(C.PEND_KEY);
            if (!raw) return;
            try { const p = JSON.parse(raw); if (!p || p.wk === wk) lsDel(C.PEND_KEY); } catch (e) { lsDel(C.PEND_KEY); }
        }
        function flush(reason, unloading) {
            const s = S.sess;
            if (!canSend(s)) return false;
            const p = payloadOf(s);
            if (!p) return false;
            s.sent = true;
            markSent(s.wk);
            dropPending(s.wk);
            post(p, !!unloading);
            S.n.sent++;
            log('热度已上报(' + reason + ')');
            return true;
        }
        function savePending() {
            const s = S.sess;
            if (!canSend(s)) return false;
            const p = payloadOf(s);
            if (!p) return false;
            if (lsSet(C.PEND_KEY, JSON.stringify({ wk: p.wk, dur: p.dur, bins: p.bins, day: utcDay(now()) }))) S.n.pend++;
            return true;
        }
        // 上次切后台后没回来(iOS 后台被杀):打开页面一会儿后补发
        function sendPending() {
            const raw = lsGet(C.PEND_KEY);
            if (!raw) return false;
            if (S.sess && !S.sess.sent) {
                try { const q = JSON.parse(raw); if (q && q.wk === S.sess.wk) return false; } catch (e) { }   // 正在看同一部:交给这次会话自己发
            }
            lsDel(C.PEND_KEY);
            let p = null;
            try { p = JSON.parse(raw); } catch (e) { return false; }
            if (!p || !validWk(p.wk) || typeof p.bins !== 'string' || !B64_100.test(p.bins) || !(p.dur > 0) || !(p.day >= utcDay(now()) - 1)) return false;
            if (incognito() || sentToday(p.wk)) return false;
            markSent(p.wk);
            post({ wk: p.wk, dur: Math.round(+p.dur), bins: p.bins }, false);
            S.n.pendSent++;
            return true;
        }

        // =============== ② 手势 ===============
        function blockedAt(target) { return interactive(target, S.cont) || panelOpen(S.cont); }
        function canLongPress() {
            const v = S.video;
            return !!(S.dp && v && !S.live && !v.paused && !v.ended && (v.readyState | 0) >= 2);
        }
        function canScrub() {
            const v = S.video;
            const dur = v ? +v.duration : NaN;
            return !!(S.dp && v && !S.live && dur > 0 && fin(dur) && fin(+v.currentTime));
        }
        function restoreSpeedKey(snap) {
            if (snap === null || snap === undefined) lsDel(C.SPEED_KEY); else lsSet(C.SPEED_KEY, snap);
        }
        // 改倍速:index.html 的 ratechange 会把它记成用户倍速(dplayer_speed)——等这次 ratechange 的监听都跑完再把原值写回去
        function setRate(v, r, snap) {
            if (!v) return;
            let done = false;
            const fix = () => { if (done) return; done = true; restoreSpeedKey(snap); };
            if (Math.abs((+v.playbackRate || 1) - r) < 1e-6) { fix(); return; }
            try {
                const h = () => { try { v.removeEventListener('ratechange', h); } catch (e) { } setT(fix, 0); };
                v.addEventListener('ratechange', h);
            } catch (e) { }
            try { v.playbackRate = r; } catch (e) { }
            setT(fix, 400);
        }
        function showBadge(on) {
            if (!on) { const x = S.els.badge; if (x) rmCls(x.box, 'on'); return; }
            const x = badgeEl();
            if (x) addCls(x.box, 'on');
        }
        function startLongPress() {
            const g = S.g;
            if (!g || g.mode !== 'pending' || g.moved) return;
            g.lpT = 0;
            if (!canLongPress()) return;
            const v = S.video;
            g.mode = 'lp';
            const prev = +v.playbackRate > 0 ? +v.playbackRate : 1;
            S.lp = { v, prev, snap: lsGet(C.SPEED_KEY), at: now() };
            clrT(S.lpClsT); S.lpClsT = 0;
            addCls(S.cont, 'dgx-lp');
            showBadge(true);
            setRate(v, C.LP_RATE, S.lp.snap);
            S.n.lp++;
        }
        function endLongPress() {
            const lp = S.lp;
            if (!lp) return;
            S.lp = null;
            showBadge(false);
            setRate(lp.v, lp.prev, lp.snap);
            const cont = S.cont;
            clrT(S.lpClsT);
            S.lpClsT = setT(() => rmCls(cont, 'dgx-lp'), 1600);   // 恢复倍速那一下的倍速浮层也藏掉
            if (S.g && S.g.mode === 'lp') S.g.mode = 'swallow';
        }
        function ctlShow() {
            try {
                const c = S.dp && S.dp.controller;
                if (c && typeof c.setAutoHide === 'function') c.setAutoHide();
                else if (c && typeof c.show === 'function') c.show();
            } catch (e) { }
        }
        function seekTo(t) {
            const dp = S.dp, v = S.video;
            if (!dp || !v || !fin(t)) return false;
            const dur = +v.duration;
            t = clamp(t, 0, dur > 0 && fin(dur) ? dur : Math.max(t, 0));
            try { if (typeof dp.seek === 'function') dp.seek(t); else v.currentTime = t; return true; } catch (e) { return false; }
        }
        // 合成指针事件给进度条:dgSeekPreview 把非 touch 的 pointermove 当悬停,出这个位置的缩略图;pointerleave 收起
        function firePtr(type, t, dur) {
            try {
                const wrap = qs(S.cont, '.dplayer-bar-wrap');
                const PE = win.PointerEvent;
                if (!wrap || typeof PE !== 'function' || typeof wrap.dispatchEvent !== 'function') return false;
                const r = rectOf(wrap);
                if (!(r.width > 0)) return false;
                const x = r.left + (dur > 0 ? clamp(t / dur, 0, 1) : 0) * r.width;
                wrap.dispatchEvent(new PE(type, { clientX: x, clientY: r.top + (r.height || 0) / 2, pointerType: 'mouse', pointerId: 7731, isPrimary: false, bubbles: false, cancelable: false }));
                return true;
            } catch (e) { return false; }
        }
        function startScrub(dx) {
            const v = S.video;
            const r = rectOf(S.cont);
            if (!(r.width > 0)) return false;
            const t0 = +v.currentTime, dur = +v.duration;
            S.scrub = { t0, dur, width: r.width, t: t0, cancel: true, shownAt: -1e15, ptr: false };
            addCls(S.cont, 'dgx-scrubbing');
            S.n.scrub++;
            updateScrub(dx);
            return true;
        }
        function updateScrub(dx) {
            const sc = S.scrub;
            if (!sc) return;
            const r = scrubTarget(sc.t0, dx, sc.width, sc.dur);
            sc.t = r.t; sc.cancel = r.cancel;
            const el = scrubEl();
            if (el) {
                const tt = fmtTime(r.t) + ' / ' + fmtTime(sc.dur);
                if (el.t.textContent !== tt) el.t.textContent = tt;
                const dd = r.cancel ? '松手取消' : fmtDelta(r.delta);
                if (el.d.textContent !== dd) el.d.textContent = dd;
                try { el.box.classList.toggle('cancel', !!r.cancel); } catch (e) { }
                addCls(el.box, 'on');
            }
            if (now() - sc.shownAt > 1000) { sc.shownAt = now(); ctlShow(); }   // 缩略图框跟着控制栏(控制栏藏着时它也藏)
            if (r.cancel) { if (sc.ptr) { firePtr('pointerleave', sc.t0, sc.dur); sc.ptr = false; } }
            else if (firePtr('pointermove', r.t, sc.dur)) sc.ptr = true;
        }
        function endScrubUi() {
            const sc = S.scrub;
            S.scrub = null;
            const x = S.els.scrub;
            if (x) rmCls(x.box, 'on');
            rmCls(S.cont, 'dgx-scrubbing');
            if (sc && sc.ptr) firePtr('pointerleave', sc.t0, sc.dur);
            return sc;
        }
        function commitScrub() {
            const sc = endScrubUi();
            if (sc && !sc.cancel && fin(sc.t) && seekTo(sc.t)) { S.n.scrubSeek++; ctlShow(); }
        }
        function ripple(side) {
            const R = S.rip, t = now();
            R.acc = (R.side === side && t - R.at < C.RIPPLE_ACC_MS) ? R.acc + C.SEEK_STEP : C.SEEK_STEP;
            R.side = side; R.at = t;
            const el = ripEl(side);
            const other = S.els['rip' + (side === 'L' ? 'R' : 'L')];
            if (other) rmCls(other.box, 'on');
            if (el) {
                el.lab.textContent = (side === 'L' ? '−' : '+') + R.acc + 's';
                R.flip = !R.flip;
                rmCls(el.box, R.flip ? 'b' : 'a');
                addCls(el.box, R.flip ? 'a' : 'b');   // 两套同样的关键帧轮换:连点时重新播淡入,不用强制回流
                addCls(el.box, 'on');
            }
            clrT(R.t);
            R.t = setT(() => { ['ripL', 'ripR'].forEach(k => { const x = S.els[k]; if (x) rmCls(x.box, 'on'); }); }, C.RIPPLE_SHOW_MS);
            S.n.rip++;
        }
        // 一次干净的点击(没动、没被接管):左右区记下跳前时间,等 index.html 的双击处理跑完再看有没有真跳
        function observeTap(e) {
            const v = S.video, cont = S.cont;
            if (!v || !cont) return;
            const t = e.changedTouches && e.changedTouches[0];
            if (!t) return;
            const r = rectOf(cont);
            const z = zoneOf(t.clientX, r.left, r.width);
            if (z === 'C') return;
            const before = +v.currentTime, dur = +v.duration;
            if (!fin(before)) return;
            setT(() => {
                try {
                    if (S.video !== v) return;
                    if (seekedBy(before, +v.currentTime, dur, z === 'L' ? -C.SEEK_STEP : C.SEEK_STEP)) ripple(z);
                } catch (err) { }
            }, 0);
        }
        function consume(e) {
            if (e.cancelable) e.preventDefault();
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); else e.stopPropagation();
            S.ctxBlockUntil = now() + 800;
        }
        const touchById = (list, id) => { if (!list) return null; for (let i = 0; i < list.length; i++) if (list[i] && list[i].identifier === id) return list[i]; return null; };
        function abortGesture() {
            const g = S.g;
            if (g && g.lpT) { clrT(g.lpT); g.lpT = 0; }
            const took = !!(S.lp || S.scrub || (g && g.mode === 'swallow'));
            if (S.lp) endLongPress();
            if (S.scrub) endScrubUi();
            if (g) g.mode = took ? 'swallow' : 'other';
        }
        function onTS(e) {
            try {
                if (!S.dp || e.currentTarget !== S.cont) return;
                const ts = e.touches;
                if (!ts || ts.length !== 1) { if (S.g) abortGesture(); return; }
                if (!touchCapable() || blockedAt(e.target)) { S.g = null; return; }
                const t = ts[0];
                const W = vw();
                S.g = { id: t.identifier, x0: t.clientX, y0: t.clientY, mode: 'pending', moved: false, lpT: 0, edge: t.clientX < C.EDGE || (W > 0 && t.clientX > W - C.EDGE) };
                if (canLongPress()) S.g.lpT = setT(startLongPress, C.LP_MS);
            } catch (err) { S.g = null; }
        }
        function onTM(e) {
            try {
                const g = S.g;
                if (!g || e.currentTarget !== S.cont || g.mode === 'other') return;
                if (g.mode === 'lp' || g.mode === 'swallow') { if (e.cancelable) e.preventDefault(); e.stopPropagation(); return; }
                const t = touchById(e.touches, g.id);
                if (!t) return;
                const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
                if (g.mode === 'scrub') { if (e.cancelable) e.preventDefault(); e.stopPropagation(); updateScrub(dx); return; }
                const ax = Math.abs(dx), ay = Math.abs(dy);
                if (!g.moved && (ax > C.MOVE_TOL || ay > C.MOVE_TOL)) { g.moved = true; if (g.lpT) { clrT(g.lpT); g.lpT = 0; } }
                if (ax >= C.SWIPE_MIN && ax > 2 * ay) {
                    // 浏览器已经在滚动(touchmove 不可取消)/ 边缘起手 / 不能定位(直播、没时长)/ 面板开了 → 不接
                    if (g.edge || !e.cancelable || !canScrub() || panelOpen(S.cont)) { g.mode = 'other'; return; }
                    if (!startScrub(dx)) { g.mode = 'other'; return; }
                    g.mode = 'scrub';
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                if (ay > 14 && ay > 1.2 * ax) g.mode = 'other';   // 竖滑:页面滚动 / 全屏亮度音量,不归这里
            } catch (err) { }
        }
        function onTE(e) {
            try {
                const g = S.g;
                if (!g || e.currentTarget !== S.cont) return;
                const left = e.touches ? e.touches.length : 0;
                if (g.lpT) { clrT(g.lpT); g.lpT = 0; }
                if (g.mode === 'lp') { endLongPress(); consume(e); }
                else if (g.mode === 'scrub') { commitScrub(); consume(e); }
                else if (g.mode === 'swallow') consume(e);
                else if (g.mode === 'pending' && !g.moved && left === 0) observeTap(e);
                if (left === 0) S.g = null;
            } catch (err) { S.g = null; }
        }
        function onTC() {
            try {
                const g = S.g;
                if (g && g.lpT) clrT(g.lpT);
                if (S.lp) endLongPress();
                if (S.scrub) endScrubUi();
                S.g = null;
            } catch (err) { S.g = null; }
        }
        // 安卓长按会冒出 contextmenu(DPlayer 会弹它的右键菜单):只在我们接管的长按 / 拖动期间和刚松手时拦。
        //   修订:长按计时还没到(pending、没挪动、计时器在跑)也拦 —— 安卓 Chrome 的系统长按是 400ms(Android 11+ 默认),比我们的 450ms 先到:
        //   以前 DPlayer 菜单先弹出来,50ms 后 2 倍速在菜单底下启动。现在拦下它并就此开始长按倍速(系统已经认定是长按了)
        function onCtx(e) {
            try {
                if (e.currentTarget !== S.cont) return;
                const g = S.g;
                if (g && g.mode === 'pending' && !g.moved && g.lpT && canLongPress()) {
                    if (e.cancelable) e.preventDefault();
                    e.stopPropagation();
                    clrT(g.lpT);
                    startLongPress();
                    return;
                }
                if (S.lp || S.scrub || (g && (g.mode === 'lp' || g.mode === 'scrub' || g.mode === 'swallow')) || now() < S.ctxBlockUntil) {
                    if (e.cancelable) e.preventDefault();
                    e.stopPropagation();
                }
            } catch (err) { }
        }
        function installContainer(cont) {
            if (!cont || typeof cont.addEventListener !== 'function') return;
            ensureCss();
            if (touchCapable()) addCls(cont, 'dgx-on');
            if (cont.__dgxG) return;
            cont.__dgxG = true;
            cont.addEventListener('touchstart', onTS, { capture: true, passive: true });
            cont.addEventListener('touchmove', onTM, { capture: true, passive: false });
            cont.addEventListener('touchend', onTE, { capture: true, passive: false });
            cont.addEventListener('touchcancel', onTC, { capture: true, passive: true });
            cont.addEventListener('contextmenu', onCtx, true);
        }

        // ---------- 键盘(电脑) ----------
        function keysAllowed(e) {
            const dp = S.dp, v = S.video, cont = S.cont;
            if (!dp || !v || !cont || S.live) return false;
            if (doc && doc.hidden) return false;
            if (typingIn(e.target) || typingIn(doc && doc.activeElement)) return false;
            try {
                const vue = win.vueApp;
                if (vue && (vue.isTVMode || vue.showDetail === false || (vue.frameShare && vue.frameShare.show))) return false;
            } catch (err) { }
            try { const P = win.dgPrivacy; if (P && typeof P.locked === 'function' && P.locked()) return false; } catch (err) { return false; }
            const r = rectOf(cont);
            return r.width > 0 && r.height > 0;
        }
        function onKey(e) {
            try {
                if (!e || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
                const k = e.key;
                let act = null;
                if ((k === 'j' || k === 'J') && !e.shiftKey) act = ['seek', -C.SEEK_STEP];
                else if ((k === 'l' || k === 'L') && !e.shiftKey) act = ['seek', C.SEEK_STEP];
                else if (k === '>' || (e.shiftKey && e.code === 'Period')) act = ['speed', 1];
                else if (k === '<' || (e.shiftKey && e.code === 'Comma')) act = ['speed', -1];
                if (!act || !keysAllowed(e)) return;
                const v = S.video;
                if (act[0] === 'seek') {
                    const cur = +v.currentTime;
                    if (!fin(cur)) return;
                    seekTo(cur + act[1]);
                    ctlShow();
                } else {
                    const opt = S.dp.options && Array.isArray(S.dp.options.playbackSpeed) ? S.dp.options.playbackSpeed : C.SPEEDS;
                    const nx = nextSpeed(+v.playbackRate, act[1], opt);
                    if (nx == null) { e.preventDefault(); return; }
                    if (typeof S.dp.speed === 'function') S.dp.speed(nx); else v.playbackRate = nx;   // index.html 的 ratechange 负责浮层 / 菜单高亮 / 记住倍速
                }
                e.preventDefault();
                S.n.key++;
            } catch (err) { }
        }

        // =============== ③ 起播提速:悬停预取 ===============
        function workUrlOf(wk) {
            try { const A = win.DgAdult; if (A && typeof A.workUrl === 'function') return A.workUrl(wk, false); } catch (e) { }
            return '/api/catalog/work?k=' + encodeURIComponent(wk);
        }
        // 主视频在放 / 页面上有没静音的视频在放 / 后台在剪插播或离线分析(adult.js mainBusy)→ 不做任何预取
        //   (静音的封面悬停预览不算:几 KB 的作品 JSON 不跟它抢什么)
        function playingNow() {
            const v = S.video;
            if (v && !v.paused && !v.ended) return true;
            try {
                const list = doc && typeof doc.getElementsByTagName === 'function' ? doc.getElementsByTagName('video') : [];
                for (let i = 0; i < list.length; i++) { const x = list[i]; if (x && !x.paused && !x.ended && !x.muted) return true; }
            } catch (e) { }
            try { const A = win.DgAdult; if (A && typeof A.mainBusy === 'function' && A.mainBusy()) return true; } catch (e) { }
            return false;
        }
        function pfAllowed() {
            if (!doc || doc.hidden) return false;
            const nav = win.navigator || {};
            if (nav.onLine === false) return false;
            try { const c = nav.connection; if (c && (c.saveData || /(^|\b)(slow-2g|2g|3g)$/.test(String(c.effectiveType || '')))) return false; } catch (e) { }
            try { const A = win.DgAdult; if (A && A.ageGate && typeof A.ageGate.accepted === 'function' && !A.ageGate.accepted()) return false; } catch (e) { return false; }
            return !playingNow();
        }
        function abortEntry(e, force) {
            if (!e || e.state !== 'pending') return;
            if (!force && (e.claimed || e.refs > 0)) return;
            e.state = 'aborted';
            clrT(e.timer);
            try { if (e.ctl) e.ctl.abort(); } catch (err) { }
            if (S.pf.get(e.wk) === e) S.pf.delete(e.wk);
            S.n.pfAbort++;
        }
        function proxyOrigin() {
            try { const v = win.vueApp; const p = v && v.corsProxyUrl; return typeof p === 'string' && p ? originOf(p, URLc) : ''; } catch (e) { return ''; }
        }
        function preconnect(o) {
            if (!o || !doc || !doc.head || typeof doc.createElement !== 'function') return;
            let self = '';
            try { self = win.location ? String(win.location.origin || '') : ''; } catch (e) { }
            if (o === self) return;
            const t = now();
            const old = S.pc.get(o);
            if (old && t - old.at < C.PC_REFRESH_MS) return;
            if (old) { rmEl(old.link); S.pc.delete(o); }
            const l = doc.createElement('link');
            l.setAttribute('rel', 'preconnect');
            l.setAttribute('href', o);
            l.setAttribute('crossorigin', 'anonymous');   // 测速 fetch / hls.js XHR 都是不带凭据的跨域请求,连接池要对上
            l.setAttribute('data-dgx', '1');
            doc.head.appendChild(l);
            S.pc.set(o, { link: l, at: t });
            while (S.pc.size > C.PC_MAX) { const k0 = S.pc.keys().next().value; const x = S.pc.get(k0); S.pc.delete(k0); if (x) rmEl(x.link); }
            S.n.pc++;
        }
        function preconnectFrom(j) {
            if (!j || typeof j !== 'object' || !Array.isArray(j.sources) || playingNow()) return;
            const list = [];
            const px = proxyOrigin();
            if (px) list.push(px);
            for (let i = 0; i < j.sources.length; i++) {
                const s = j.sources[i];
                const u = s && firstEpUrl(s.vod_play_url);
                if (u) { const o = originOf(u, URLc); if (o) list.push(o); break; }
            }
            list.forEach(preconnect);
        }
        function startPrefetch(wk) {
            if (!pfAllowed()) return null;
            const t = now();
            let e = S.pf.get(wk);
            if (e && (t - e.at > C.PF_TTL || e.state === 'fail' || e.state === 'aborted')) { S.pf.delete(wk); e = null; }
            if (e) {
                S.pf.delete(wk); S.pf.set(wk, e);   // LRU:用过挪到最后
                e.refs++;
                if (e.state === 'done') preconnectFrom(e.json);
                return e;
            }
            const pend = [];
            S.pf.forEach(x => { if (x.state === 'pending' && !x.claimed) pend.push(x); });
            if (pend.length >= C.PF_INFLIGHT) abortEntry(pend[0], true);
            const A = AC();
            const ctl = A ? new A() : null;
            e = { wk, at: t, state: 'pending', claimed: false, refs: 1, text: null, json: null, ctl, timer: 0, promise: null };
            const ent = e;
            ent.timer = setT(() => abortEntry(ent, true), C.PF_TIMEOUT);
            let p;
            try { p = fetchFn(workUrlOf(wk), ctl ? { credentials: 'same-origin', signal: ctl.signal } : { credentials: 'same-origin' }); }
            catch (err) { p = Promise.reject(err); }
            ent.promise = Promise.resolve(p).then(r => (r && r.ok && typeof r.text === 'function') ? r.text() : null).then(txt => {
                clrT(ent.timer);
                if (ent.state !== 'pending') return null;
                let j = null;
                try { j = txt ? JSON.parse(txt) : null; } catch (err) { j = null; }
                if (!j || typeof j !== 'object') { ent.state = 'fail'; return null; }
                ent.state = 'done'; ent.text = txt; ent.json = j;
                preconnectFrom(j);
                return txt;
            }, () => { clrT(ent.timer); if (ent.state === 'pending') ent.state = 'fail'; return null; });
            S.pf.set(wk, ent);
            while (S.pf.size > C.PF_MAX) {
                const k0 = S.pf.keys().next().value;
                const e0 = S.pf.get(k0);
                S.pf.delete(k0);
                if (e0 && e0 !== ent && e0.state === 'pending' && !e0.claimed) { e0.refs = 0; abortEntry(e0, true); }
            }
            S.n.pf++;
            return ent;
        }
        function isTouchEv(ev) {
            if (ev && typeof ev === 'object') {
                if (typeof ev.type === 'string' && /^touch/.test(ev.type)) return true;
                if (ev.pointerType === 'touch') return true;
                if (ev.sourceCapabilities && ev.sourceCapabilities.firesTouchEvents) return true;
                if (typeof ev.type === 'string') return false;
            }
            return (S.lastPtrType === 'touch' && now() - S.lastInputAt < 1500) || mq('(hover: none)');
        }
        function endHover(h, abort) {
            if (!h.live) return;
            h.live = false;
            clrT(h.timer); h.timer = 0;
            const offs = h.offs; h.offs = [];
            offs.forEach(f => { try { f(); } catch (e) { } });
            const e = h.entry;
            if (e) { e.refs = Math.max(0, e.refs - 1); if (abort) abortEntry(e, false); }
            if (S.hov && h.el && S.hov.get(h.el) === h) S.hov.delete(h.el);
        }
        function listen(h, el, type, fn, opt) {
            el.addEventListener(type, fn, opt);
            h.offs.push(() => el.removeEventListener(type, fn, opt));
        }
        function onCardHover(card, el, ev) {
            try {
                const wk = wkOf(card);
                if (!wk) return;
                const touch = isTouchEv(ev);
                const keyEl = el && typeof el === 'object' ? el : null;
                const hv = S.hov && keyEl ? S.hov.get(keyEl) : null;
                if (hv && hv.wk === wk && hv.live) return;   // 同一张卡重复进入(重复调用 / 两条接线都调)
                if (hv) endHover(hv, true);
                const h = { wk, el: keyEl, live: true, timer: 0, entry: null, offs: [] };
                if (S.hov && keyEl) S.hov.set(keyEl, h);
                const begin = () => { if (h.live && !h.entry) h.entry = startPrefetch(wk); };
                const canListen = keyEl && typeof keyEl.addEventListener === 'function';
                if (touch) {
                    if (canListen) {
                        const t0 = ev && ev.touches && ev.touches[0];
                        const x0 = t0 ? +t0.clientX : NaN, y0 = t0 ? +t0.clientY : NaN;
                        listen(h, keyEl, 'touchmove', (e2) => {
                            const t = e2 && e2.touches && e2.touches[0];
                            if (t && fin(x0) && (Math.abs(t.clientX - x0) > C.MOVE_TOL || Math.abs(t.clientY - y0) > C.MOVE_TOL)) endHover(h, true);   // 滚动列表:不是要点它
                        }, { passive: true });
                        listen(h, keyEl, 'touchcancel', () => endHover(h, true), { passive: true });
                        listen(h, keyEl, 'touchend', () => endHover(h, false), { passive: true });   // 抬手:马上就是 click,结果留着
                    }
                    begin();
                } else {
                    if (canListen) {
                        const leave = () => endHover(h, true);
                        listen(h, keyEl, 'mouseleave', leave);
                        listen(h, keyEl, 'pointerleave', leave);
                        // 复核:停留不到 150ms 就按下去(点得快)→ 不等了,按下那一刻就开始预取;随后的 click → openWork 认领这一份
                        //   (原来计时器没取消:openWork 自己拉一遍,计时器到点又拉一遍、没人认领 = 白白多一个请求,快点击正好吃不到提速)
                        const now0 = () => { if (h.timer) { clrT(h.timer); h.timer = 0; begin(); } };
                        listen(h, keyEl, 'pointerdown', now0, { passive: true });
                        listen(h, keyEl, 'mousedown', now0, { passive: true });
                    }
                    h.timer = setT(() => { h.timer = 0; begin(); }, C.HOVER_DWELL_MS);
                }
            } catch (err) { }
        }
        function prefetched(wk) {
            try {
                if (!validWk(wk)) return null;
                const e = S.pf.get(wk);
                if (!e || !e.promise) return null;
                if (now() - e.at > C.PF_TTL || e.state === 'fail' || e.state === 'aborted') { if (e.state !== 'pending') S.pf.delete(wk); return null; }
                e.claimed = true;
                return e.promise.then(txt => { if (!txt) return null; try { return JSON.parse(txt); } catch (err) { return null; } });
            } catch (err) { return null; }
        }

        // =============== 接线 ===============
        function bindVideo(v) {
            if (S.video === v && S.vOff) return;
            unbindVideo();
            S.video = v;
            if (!v || typeof v.addEventListener !== 'function') return;
            const H = {
                timeupdate: () => { try { onTime(v); } catch (e) { } },
                seeking: () => { try { onSeeking(v); } catch (e) { } },
                seeked: () => { try { onSeeked(v); } catch (e) { } },
                playing: () => { try { onPlaying(v); } catch (e) { } },
                pause: () => { try { if (S.lp && S.lp.v === v) endLongPress(); } catch (e) { } },
                emptied: () => { try { if (S.lp && S.lp.v === v) endLongPress(); } catch (e) { } }
            };
            Object.keys(H).forEach(t => v.addEventListener(t, H[t]));
            S.vOff = () => Object.keys(H).forEach(t => { try { v.removeEventListener(t, H[t]); } catch (e) { } });
        }
        function unbindVideo() {
            if (S.vOff) { try { S.vOff(); } catch (e) { } }
            S.vOff = null;
            S.video = null;
        }
        function onPlayerReady(dp, video, ctx) {
            try {
                const c = ctx && typeof ctx === 'object' ? ctx : {};
                const v = video || (dp && dp.video) || null;
                if (!dp || !v) return;
                const wk = validWk(c.wk) ? c.wk : '';
                const live = !!c.isLive;
                const lineKey = typeof c.lineKey === 'string' ? c.lineKey : '';
                if (S.dp === dp && S.video === v && S.wk === wk && S.live === live && S.lineKey === lineKey && S.vOff) return;   // 重复调用
                privSub();
                if (S.dp && S.dp !== dp) detach();   // 旧播放器没走 onPlayerDestroy 就被换掉(重建):拆掉旧的,观看记录留着(同一部接着记)
                if (S.lp) endLongPress();
                if (S.scrub) endScrubUi();
                if (S.sess && (S.sess.wk !== wk || live)) { flush('switch', false); S.sess = null; }
                S.dp = dp;
                S.cont = dp.container || (doc && typeof doc.getElementById === 'function' ? doc.getElementById('dplayer') : null);
                S.wk = wk; S.live = live; S.lineKey = lineKey;
                bindVideo(v);
                installContainer(S.cont);
                if (S.dpHooked !== dp) {
                    S.dpHooked = dp;
                    // DPlayer 自己销毁(index.html 重建播放器也会走这里):只拆接线,不算看完 —— 上报留给 onPlayerDestroy / 换作品 / 离开页面
                    try { if (typeof dp.on === 'function') dp.on('destroy', () => { try { if (S.dp === dp) detach(); } catch (e) { } }); } catch (e) { }
                }
                if (wk && !live) {
                    if (!S.sess) S.sess = newSess(wk);
                    else { S.sess.firstPlayAt = 0; S.sess.lastT = null; S.sess.seekBin = -1; }   // 同一部换线路 / 换集:续播跳转重新算宽限期
                } else S.sess = null;
                scheduleHeat();
            } catch (e) { }
        }
        // 拆掉和当前播放器的接线(手势状态 / 倍速还原 / 热度条 / video 监听);观看记录 S.sess 不动
        function detach() {
            if (S.g && S.g.lpT) clrT(S.g.lpT);
            if (S.lp) endLongPress();
            if (S.scrub) endScrubUi();
            S.g = null;
            cancelHeat();
            removeHeatEl();
            unbindVideo();
            S.dp = null; S.wk = ''; S.live = false; S.lineKey = '';
        }
        // index.html 在销毁 / 收起播放器之前调,reason = 'close' | 'home' | 'switch' | 'rebuild' | 'offline'(adult.js adPlayerGone):
        //   'rebuild' 是同一部换个干净容器重建(Kazumi MP4)→ 只拆接线、接着记;其余 = 这一部看完了 → 按条件上报再拆
        function onPlayerDestroy(reason) {
            try {
                if (reason === 'rebuild') { if (S.dp) detach(); return; }
                flush('destroy' + (reason ? ':' + reason : ''), false);
                S.sess = null;
                if (S.dp) detach();
            } catch (e) { }
        }

        // 文档级:用户操作时刻(判断 seek 是不是用户跳的)、键盘、切后台 / 离开页面
        if (doc && typeof doc.addEventListener === 'function') {
            const mark = (e) => {
                S.lastInputAt = now();
                if (e && typeof e.pointerType === 'string' && e.pointerType) S.lastPtrType = e.pointerType;
                else if (e && typeof e.type === 'string' && /^touch/.test(e.type)) S.lastPtrType = 'touch';
            };
            ['pointerdown', 'pointerup', 'touchend', 'keydown'].forEach(t => doc.addEventListener(t, mark, { capture: true, passive: true }));
            doc.addEventListener('keydown', onKey, false);
            doc.addEventListener('visibilitychange', () => {
                try { if (doc.hidden) { if (S.lp) endLongPress(); if (S.scrub) endScrubUi(); savePending(); } } catch (e) { }
            });
        }
        if (win && typeof win.addEventListener === 'function') {
            win.addEventListener('pagehide', () => { try { if (S.lp) endLongPress(); flush('pagehide', true); } catch (e) { } });
        }
        setT(() => { try { sendPending(); } catch (e) { } }, C.PEND_DELAY_MS);

        const api = {
            version: 1,
            onPlayerReady, onPlayerDestroy, onCardHover, prefetched,
            status() {
                const s = S.sess;
                return {
                    bound: !!S.dp, wk: S.wk, live: S.live, touch: touchCapable(),
                    sess: s ? { total: Math.round(s.total * 10) / 10, dur: s.dur, eligible: eligible(s.total, s.dur), off: s.off, sent: s.sent } : null,
                    heat: { wk: S.heat.wk, shown: !!(S.heat.el && S.heat.el.svg.parentNode), waiting: S.heat.waiting },
                    gesture: S.g ? S.g.mode : '', lp: !!S.lp, scrub: !!S.scrub,
                    prefetch: Array.from(S.pf.values()).map(e => ({ wk: e.wk, state: e.state, claimed: e.claimed, ms: now() - e.at })),
                    preconnect: Array.from(S.pc.keys()), n: Object.assign({}, S.n)
                };
            },
            _S: S, _flush: flush, _sendPending: sendPending
        };
        // 挂到 window.dgAdultHooks(adult.js 在 <head> 里同步建好,先于这个 defer 脚本):
        //   有 add(name, fn)(adult.js 的实现;赋值 H.onX = fn 也是追加)→ 按契约名注册;别的实现(on/register/subscribe)同理;
        //   都没有(只是个普通对象)→ 把同名函数包一层(先调原来的)。三个入口都是幂等的,被调两次也没事
        let regOn = null;
        function register() {
            const H = win.dgAdultHooks;
            if (!H || (typeof H !== 'object' && typeof H !== 'function')) return false;
            if (regOn === H) return true;
            const mine = { onPlayerReady: api.onPlayerReady, onPlayerDestroy: api.onPlayerDestroy, onCardHover: api.onCardHover };
            const reg = ['add', 'on', 'register', 'subscribe'].map(n => H[n]).find(f => typeof f === 'function');
            if (reg) Object.keys(mine).forEach(k => { try { reg.call(H, k, mine[k]); } catch (e) { } });
            else {
                Object.keys(mine).forEach(k => {
                    const prev = H[k];
                    if (prev && prev.__dgx) return;
                    const f = function () {
                        let r;
                        if (typeof prev === 'function') { try { r = prev.apply(this, arguments); } catch (e) { } }
                        try { mine[k].apply(null, arguments); } catch (e) { }
                        return r;
                    };
                    f.__dgx = true;
                    try { H[k] = f; } catch (e) { }
                });
            }
            regOn = H;
            return true;
        }
        api._register = function () {
            if (register()) return true;
            [0, 1500, 5000].forEach(ms => setT(() => { try { register(); } catch (e) { } }, ms));
            try { if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('DOMContentLoaded', () => { try { register(); } catch (e) { } }); } catch (e) { }
            return false;
        };
        return api;
    }

    const Core = {
        C, CSS, clamp, utcDay, binOf, addWatched, binsOut, eligible, b64, normHeat, smoothBins, heatPath, scrubSpan, scrubTarget,
        fmtTime, fmtDelta, zoneOf, seekedBy, nextSpeed, interactive, panelOpen, typingIn, firstEpUrl, originOf, validWk, wkOf, createPlayerX
    };
    if (typeof module === 'object' && module && module.exports) module.exports = Core;
    root.DgAdultPlayerCore = Core;
    if (root.document && typeof root.document.createElement === 'function' && !root.dgAdultPlayer) {
        root.dgAdultPlayer = createPlayerX({
            win: root, doc: root.document,
            log: m => { try { console.log('[播放增强] ' + m); } catch (e) { } }
        });
        try { root.dgAdultPlayer._register(); } catch (e) { }
    }
})(typeof window !== 'undefined' ? window : globalThis);
