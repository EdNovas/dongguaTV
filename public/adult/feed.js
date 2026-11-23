// [adult] p4 刷短片(window.dgAdultFeed):全屏竖向整屏翻页的短片流,地址栏只写 #/feed(不带任何作品信息)。
//   数据:GET /api/catalog/feed?cursor=&vert=1(服务器已按短片规则挑好:8–300 秒、竖屏优先、按家族轮换、审查类不进;每条再过一遍策略)。
//   播放:同时只有 1 个在放的 hls.js 实例(autoStartLoad:false,翻到 ≥60% 可见才建、清单到了才 startLoad),maxBufferLength 10;
//     静音自动播放、点一下开声音、循环;横屏片 object-fit: contain;地址走与播放页同一个去广告变换(DgAdult.playUrl:配了 Worker 就套,
//     没配直连);没有 MSE 的 iPhone 走原生 HLS。量到画面宽高后按 beacon 报方向(无痕时不报)。
//   流量:非计量网络本会话 300MB 封顶,之后改成「点一下才播」(原生 HLS 量不到字节,按秒数 × 2 Mbps 估);省流量 / 2G·3G / 蜂窝(设置里没允许)/
//     手机触屏上浏览器不报网络类型(iPhone / iPad 都是)一开始就是点一下才播。静音自动播也被浏览器拦 → 同样出「点一下播放」。电视上不出。
//   点片名 → 交给 adult.js 开正常的播放页(刷短片先收起、停掉视频;关了播放页回到原位)。
//   复核:不再预拉下一条的 m3u8 清单(除了正在放的这条,什么 m3u8 正文都不预拉),只给下一条的源站 <link rel=preconnect>;
//   收起(播放页开着)、隐私锁着(含 head 预锁)时一个实例都不建、也不预连。
// 不碰 Vue:自己建 DOM(fixed 全屏层),滑动只改 DOM、不写任何响应式状态;离当前 ±2 条以外的只留空壳(长列表不涨 DOM)。
// 纯函数部分(地址 / 归一化 / 方向 / 网络模式)node 里可直接 require:scripts/adult-frontend-test.mjs
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && typeof root === 'object' && typeof root.document !== 'undefined' && root.document && root.document.addEventListener) {
        root.dgAdultFeed = api;
        try { api.boot(); } catch (e) { try { console.warn('[adult] 刷短片启动失败', e); } catch (_) { } }
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
    'use strict';
    const SESSION_CAP = 300 * 1024 * 1024;
    const WINDOW_BEFORE = 2, WINDOW_AFTER = 3;   // 有内容的条目:当前前 2 条 ~ 后 3 条
    const MORE_AT = 4;                            // 离末尾还剩 4 条就拉下一页
    const VERT_KEY = 'dg_feed_vert';
    const WK_RE = /^[ct]:./;

    // ======================= 纯函数 =======================
    // rand:没有游标时从服务器挑的随机位置开始(每次打开 / 「换一批」都不是同一批)
    function feedUrl(cursor, vert, rand) {
        const q = [];
        if (cursor) q.push('cursor=' + encodeURIComponent(String(cursor)));
        else if (rand) q.push('start=rand');
        if (vert) q.push('vert=1');
        return '/api/catalog/feed' + (q.length ? '?' + q.join('&') : '');
    }
    // 清单的「正片窗口」(hls.js 的 level 分片 → {start,end} 或 null):按不连续段(cc)分块,最长那块 ≥ 总长 60%、
    //   别的块都 ≤ 60 秒(片头 / 中插 / 片尾贴片,去广告 Worker 没剪掉的)→ 只在最长那块里放、循环也只在这块里转
    function contentWindow(frags) {
        const blocks = new Map();
        let total = 0;
        for (const f of Array.isArray(frags) ? frags : []) {
            if (!f) continue;
            const d = Number(f.duration) || 0, s = Number(f.start) || 0, cc = Number(f.cc) || 0;
            if (!(d > 0)) continue;
            total += d;
            const b = blocks.get(cc) || { start: s, end: s, dur: 0 };
            b.start = Math.min(b.start, s); b.end = Math.max(b.end, s + d); b.dur += d;
            blocks.set(cc, b);
        }
        if (blocks.size < 2 || !(total > 0)) return null;
        const arr = [...blocks.values()].sort((a, b) => b.dur - a.dur);
        const main = arr[0];
        if (main.dur < 0.6 * total || arr.slice(1).some(b => b.dur > 60)) return null;
        return { start: main.start, end: main.end };
    }
    // 双击:画面左 40% 后退、右 40% 前进,中间不算
    function tapZone(rel) { return rel < 0.4 ? -1 : rel > 0.6 ? 1 : 0; }
    // 和服务器(lib/site-catalog/common.js orientOf)同一个阈值:高 ≥ 1.15 × 宽 = 竖,宽 ≥ 1.15 × 高 = 横,其余方
    function orientOf(w, h) {
        const W = Number(w) || 0, H = Number(h) || 0;
        if (!(W > 0 && H > 0)) return '';
        return H >= 1.15 * W ? 'v' : (W >= 1.15 * H ? 'h' : 'sq');
    }
    function cleanText(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max || 80); }
    function fmtDur(sec) {
        sec = Math.round(Number(sec) || 0);
        if (!(sec > 0)) return '';
        const m = Math.floor(sec / 60), s = sec % 60;
        return m + ':' + String(s).padStart(2, '0');
    }
    // 一条 FeedItem → 本模块用的形状;不合格 → null。toCard = DgAdult.cardToItem(有就用,卡片对象和首页 / 播放页同形)
    function normItem(x, toCard) {
        if (!x || typeof x !== 'object' || typeof x.wk !== 'string' || !WK_RE.test(x.wk) || x.wk.length > 300) return null;
        let card = null;
        try { card = toCard ? toCard(x) : null; } catch (e) { card = null; }
        if (!card) card = { id: x.wk, _wk: x.wk, title: cleanText(x.name, 120), name: cleanText(x.name, 120), poster_path: typeof x.pic === 'string' ? x.pic : '', _sub: '', _badge: cleanText(x.badge, 8), _code: cleanText(x.code, 24) };
        const dur = Math.max(0, Number(x.dur) || 0);
        if (dur && (dur < 8 || dur > 300)) return null;   // 契约:有时长时只要 8–300 秒(服务器也这么挑,两头都拦)
        const lines = [];
        for (const l of Array.isArray(x.lines) ? x.lines : []) {
            if (!l || typeof l.url !== 'string' || !/^https?:\/\/\S+$/i.test(l.url) || l.url.indexOf('.m3u8') < 0 || typeof l.site !== 'string' || !l.site || l.site.length > 64) continue;
            lines.push({ site: l.site, url: l.url, dur: Math.max(0, Number(l.dur) || 0), vod_id: (typeof l.vod_id === 'string' || typeof l.vod_id === 'number') ? String(l.vod_id).slice(0, 64) : '' });
            if (lines.length >= 4) break;
        }
        if (!lines.length) return null;
        const orient = (x.orient === 'v' || x.orient === 'h' || x.orient === 'sq') ? x.orient : '';
        return { wk: x.wk, card, title: cleanText(card.title || card.name, 120), code: cleanText(card._code, 24), badge: cleanText(card._badge, 8), pic: typeof card.poster_path === 'string' ? card.poster_path : '', dur, orient, lines };
    }
    // 一页 → { items, next, done };seen = 已经有的作品键(跨页去重);只看竖屏时横屏 / 方形的也丢掉
    function normFeed(d, toCard, seen, vert) {
        const s = seen || new Set();
        const items = [];
        for (const x of (d && Array.isArray(d.items)) ? d.items : []) {
            const it = normItem(x, toCard);
            if (!it || s.has(it.wk) || (vert && it.orient && it.orient !== 'v')) continue;
            s.add(it.wk);
            items.push(it);
        }
        const next = (d && typeof d.cursor_next === 'string' && d.cursor_next.length <= 400) ? d.cursor_next : '';
        return { items, next, done: !next };
    }
    // 为什么要「点一下才播」('' = 可以自动播):本会话流量用完 / 省流量 / 慢网 / 蜂窝没允许 /
    //   网络未知 —— 修订:手机 / 触屏(mobile)上没有 navigator.connection(Safari、iOS WKWebView、Firefox 都没有)= 可能在用流量,
    //   设置里没开「移动网络也自动播放」就点一下才播(以前当成不计量,iPhone / iPad 用流量也一路自动播)。电脑上没有照旧自动播
    function netWhy(conn, cellOk, bytes, mobile) {
        if ((Number(bytes) || 0) >= SESSION_CAP) return 'cap';
        const c = conn || null;
        if (!c) return (mobile && !cellOk) ? 'unknown' : '';
        if (c.saveData) return 'save-data';
        if (/(^|\b)(slow-2g|2g|3g)$/.test(String(c.effectiveType || ''))) return 'slow';
        if (c.type === 'cellular' && !cellOk) return 'cellular';
        return '';
    }
    // 'auto' = 滑到就静音自动播;'tap' = 点一下才播
    function netMode(conn, cellOk, bytes, mobile) { return netWhy(conn, cellOk, bytes, mobile) ? 'tap' : 'auto'; }
    // 修订:原生 HLS(iPhone 没有 MSE,hls.js 1.1.5 不认 ManagedMediaSource)量不到分片字节 → 按「缓冲过的秒数 / 实际播过的秒数」里大的那个
    //   × 估算码率记进本会话流量(2 Mbps,比各家族实测中位数 0.75–1.8 Mbps 都高,宁多算),300MB 封顶在 iPhone 上也生效
    const NATIVE_BPS = 2e6;
    function nativeBytes(bufSec, playSec, bps) {
        const s = Math.max(Number(bufSec) || 0, Number(playSec) || 0);
        return s > 0 ? Math.round(s * (Number(bps) || NATIVE_BPS) / 8) : 0;
    }
    function hlsConfig() {
        return {
            autoStartLoad: false, startPosition: 0, enableWorker: true, lowLatencyMode: false,
            maxBufferLength: 10, maxMaxBufferLength: 20, maxBufferSize: 20 * 1024 * 1024, backBufferLength: 30,
            capLevelToPlayerSize: true, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2,
        };
    }
    // 竖屏片在竖着的屏幕上、宽高比相差 <25% 时铺满(cover),其余一律 contain(横屏片不裁)
    function fitOf(vw, vh, sw, sh) {
        const o = orientOf(vw, vh);
        if (o !== 'v' || !(sw > 0 && sh > 0) || sh <= sw) return 'contain';
        const a = vw / vh, b = sw / sh;
        return Math.abs(a - b) / b < 0.25 ? 'cover' : 'contain';   // 9:16 片在 19.5:9 手机上铺满(两边各裁 ~9%)
    }

    // ======================= 浏览器部分 =======================
    const S = {
        open: false, suspended: false, el: null, list: null, note: null, vertBox: null, slides: [], items: [], seen: new Set(),
        cursor: '', done: false, loading: false, err: false, vert: false, cur: -1, io: null, ratio: new Map(), inst: Object.create(null),
        muted: true, bytes: 0, opts: null, gen: 0, onKey: null, onVis: null, reported: new Set(),
        // 随机起点 / 到底后换个随机位置接着刷(wraps)/ 连续几页全是看过的(emptyRun)→ 放开「跳过看过的」(relax)
        rand: true, wraps: 0, emptyRun: 0, relax: false,
        seenP: null, marked: new Set(), histMem: [],
        press: null, lpT: 0, tapT: 0, lastTap: null, suppressClick: 0, scrub: null,
    };
    const SEEN_KEY = 'dg_feed_seen', HIST_KEY = 'dg_feed_hist';   // 这几天刷到过的(跳过)/「看过」列表 —— 看了 ≥3 秒才算;无痕只在内存
    const SEEN_TTL = 7 * 86400e3, SEEN_MAX = 2000, HIST_MAX = 200;
    const LP_MS = 400, DBL_MS = 280, SEEK_STEP = 10;
    function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } }
    function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, v); } catch (e) { } }
    function A() { return root.DgAdult || null; }
    // ---- 刷到过 / 看过(本机;无痕只在内存,一键清除连同删)----
    function incog() { const a = A(); try { return !!(a && typeof a.incognito === 'function' && a.incognito()); } catch (e) { return true; } }
    function seenMap() {
        if (S.seenP) return S.seenP;
        const m = new Map();
        if (!incog()) {
            try {
                const arr = JSON.parse(lsGet(SEEN_KEY) || '[]'), now = Date.now();
                for (const x of Array.isArray(arr) ? arr : []) if (Array.isArray(x) && typeof x[0] === 'string' && WK_RE.test(x[0]) && now - Number(x[1]) < SEEN_TTL) m.set(x[0], Number(x[1]));
            } catch (e) { }
        }
        S.seenP = m;
        return m;
    }
    function histList() {
        if (incog()) return S.histMem.slice();
        try {
            const a = JSON.parse(lsGet(HIST_KEY) || '[]');
            return Array.isArray(a) ? a.filter(x => x && typeof x.wk === 'string' && WK_RE.test(x.wk)).slice(0, HIST_MAX) : [];
        } catch (e) { return []; }
    }
    function markWatched(it) {
        if (!it || S.marked.has(it.wk)) return;
        S.marked.add(it.wk);
        const now = Date.now();
        const m = seenMap();
        m.set(it.wk, now);
        const rec = { wk: it.wk, title: cleanText(it.title, 120), pic: typeof it.pic === 'string' && it.pic.length <= 1000 ? it.pic : '', code: cleanText(it.code, 24), dur: Math.max(0, Number(it.dur) || 0), t: now };
        if (incog()) { S.histMem = [rec].concat(S.histMem.filter(x => x.wk !== it.wk)).slice(0, HIST_MAX); return; }
        lsSet(SEEN_KEY, JSON.stringify([...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX)));
        lsSet(HIST_KEY, JSON.stringify([rec].concat(histList().filter(x => x.wk !== it.wk)).slice(0, HIST_MAX)));
    }
    function histClear() {
        S.histMem = [];
        try { if (root.localStorage) root.localStorage.removeItem(HIST_KEY); } catch (e) { }
    }
    // 隐私锁着(或 head 里的预锁还没解开):不建任何播放实例(不拉清单、不拉分片、预备的下一条也不建);解锁后当前这条点一下才播
    function locked() {
        try { const P = root.dgPrivacy; if (P && typeof P.locked === 'function' && P.locked()) return true; } catch (e) { }
        try { const de = root.document && root.document.documentElement; if (de && de.classList && de.classList.contains('dgp-prelock')) return true; } catch (e) { }
        return false;
    }
    function why() {
        const a = A();
        let conn = null;
        try { conn = root.navigator && root.navigator.connection; } catch (e) { }
        return netWhy(conn, !!(a && a.cellOk && a.cellOk()), S.bytes, mobileDev());
    }
    function mode() { return why() ? 'tap' : 'auto'; }
    // 手机 / 平板:没有 MSE(iPhone 走原生 HLS)、有粗指针(触屏)、或报了触点(iPadOS「桌面版网站」的 UA 是 Mac)
    function mobileDev() {
        if (!mse()) return true;
        try { if (root.matchMedia && (root.matchMedia('(any-pointer: coarse)').matches || root.matchMedia('(pointer: coarse)').matches)) return true; } catch (e) { }
        try { const n = root.navigator; if (n && (Number(n.maxTouchPoints) || 0) > 0) return true; } catch (e) { }
        return false;
    }
    function mse() { try { return !!(root.Hls && typeof root.Hls.isSupported === 'function' && root.Hls.isSupported()); } catch (e) { return false; } }
    function nativeOk(v) { try { return !!(v && v.canPlayType && v.canPlayType('application/vnd.apple.mpegurl')); } catch (e) { return false; } }
    function playUrl(line) { const a = A(); try { return a && typeof a.playUrl === 'function' ? a.playUrl(line.url, line.site) : line.url; } catch (e) { return line.url; } }
    const h = (tag, cls, attrs) => {
        const e = root.document.createElement(tag);
        if (cls) e.className = cls;
        if (attrs) Object.keys(attrs).forEach(k => { if (attrs[k] != null) e.setAttribute(k, attrs[k]); });
        return e;
    };
    const icon = (cls) => h('i', 'fas ' + cls, { 'aria-hidden': 'true' });

    function build() {
        const wrap = h('div', 'dg-feed', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '刷短片' });
        const bar = h('div', 'dg-feed-bar');
        const x = h('button', 'dg-feed-x', { type: 'button', 'aria-label': '返回', title: '返回' });
        x.appendChild(icon('fa-arrow-left'));
        x.addEventListener('click', () => close(true));
        const t = h('b', 'dg-feed-t');
        t.textContent = '刷短片';
        const lab = h('label', 'dg-feed-vert');
        const cb = h('input', '', { type: 'checkbox' });
        cb.checked = S.vert;
        cb.addEventListener('change', () => { S.vert = !!cb.checked; lsSet(VERT_KEY, S.vert ? '1' : '0'); reload(); });
        lab.appendChild(cb);
        lab.appendChild(root.document.createTextNode(' 只看竖屏'));
        // 「换一批」:从新的随机位置重新开始(像抖音下拉刷新);「看过」:看了 ≥3 秒的短片列表
        const shuf = h('button', 'dg-feed-btn', { type: 'button', title: '换一批' });
        shuf.appendChild(icon('fa-rotate-right'));
        shuf.appendChild(root.document.createTextNode(' 换一批'));
        shuf.addEventListener('click', () => { S.rand = true; reload(); });
        const hb = h('button', 'dg-feed-btn', { type: 'button', title: '看过的短片' });
        hb.appendChild(icon('fa-clock-rotate-left'));
        hb.appendChild(root.document.createTextNode(' 看过'));
        hb.addEventListener('click', () => showHist(true));
        bar.appendChild(x); bar.appendChild(t); bar.appendChild(lab); bar.appendChild(shuf); bar.appendChild(hb);
        const list = h('div', 'dg-feed-list', { tabindex: '-1' });
        const note = h('div', 'dg-feed-note', { role: 'status' });
        note.hidden = true;
        wrap.appendChild(bar); wrap.appendChild(list); wrap.appendChild(note);
        list.addEventListener('click', onListClick);
        // 长按 2 倍速 / 拖进度条:指针事件(滑动翻页照旧是原生滚动,手指一挪就不算长按)
        list.addEventListener('pointerdown', onDown);
        list.addEventListener('pointermove', onMove, { passive: true });
        list.addEventListener('pointerup', onUp);
        list.addEventListener('pointercancel', onUp);
        list.addEventListener('contextmenu', onCtx);
        S.el = wrap; S.list = list; S.note = note; S.vertBox = cb;
        return wrap;
    }
    function showNote(text, retry) {
        const n = S.note;
        if (!n) return;
        while (n.firstChild) n.removeChild(n.firstChild);
        if (!text) { n.hidden = true; return; }
        const s = h('span');
        s.textContent = text;
        n.appendChild(s);
        if (retry) {
            const b = h('button', 'dg-feed-retry', { type: 'button' });
            b.textContent = '重试';
            b.addEventListener('click', () => { S.err = false; showNote(''); loadMore(); });
            n.appendChild(b);
        }
        n.hidden = false;
    }

    // ---- 看过的短片(面板盖在刷短片上;点一条 = 开它的播放页)----
    function showHist(on) {
        if (!S.el) return;
        const old = S.el.querySelector('.dg-feed-hist');
        if (old) old.parentNode.removeChild(old);
        const x = S.inst[S.cur];
        if (!on) { if (S.histPaused && x && x.video && x.want) playVideo(x.video, S.cur); S.histPaused = false; return; }
        if (x && x.video && !x.video.paused) { try { x.video.pause(); } catch (e) { } S.histPaused = true; }
        const p = h('div', 'dg-feed-hist', { role: 'dialog', 'aria-label': '看过的短片' });
        const head = h('div', 'dg-fh-head');
        const ttl = h('b');
        const list = histList();
        ttl.textContent = '看过的短片' + (list.length ? ' · ' + list.length : '');
        const clr = h('button', 'dg-feed-btn', { type: 'button' });
        clr.textContent = '清空';
        clr.addEventListener('click', () => { histClear(); showHist(true); });
        const cls = h('button', 'dg-feed-btn', { type: 'button', 'aria-label': '关闭' });
        cls.appendChild(icon('fa-xmark'));
        cls.addEventListener('click', () => showHist(false));
        head.appendChild(ttl); head.appendChild(clr); head.appendChild(cls);
        p.appendChild(head);
        if (incog()) { const n = h('div', 'dg-fh-note'); n.textContent = '无痕模式:只记在这次打开的页面里,关掉就没了'; p.appendChild(n); }
        const grid = h('div', 'dg-fh-grid');
        if (!list.length) { const n = h('div', 'dg-fh-note'); n.textContent = '还没有看过的短片(看 3 秒以上才算)'; grid.appendChild(n); }
        list.forEach(r => {
            const b = h('button', 'dg-fh-item', { type: 'button', title: r.title || '' });
            const im = h('div', 'dg-fh-img');
            if (r.pic) { const img = h('img', '', { alt: '', referrerpolicy: 'no-referrer', loading: 'lazy', decoding: 'async' }); img.src = r.pic; im.appendChild(img); }
            if (r.dur) { const d = h('span', 'dg-fh-dur'); d.textContent = fmtDur(r.dur); im.appendChild(d); }
            const tt = h('div', 'dg-fh-t');
            tt.textContent = r.title || r.code || '未命名';
            b.appendChild(im); b.appendChild(tt);
            b.addEventListener('click', () => {
                const o = S.opts;
                showHist(false);
                if (o && typeof o.onPick === 'function') o.onPick({ id: r.wk, _wk: r.wk, title: r.title, name: r.title, poster_path: r.pic, _code: r.code, _sub: '', _badge: '' });
            });
            grid.appendChild(b);
        });
        p.appendChild(grid);
        S.el.appendChild(p);
        try { cls.focus({ preventScroll: true }); } catch (e) { }
    }

    // ---- 数据 ----
    function loadMore() {
        if (!S.open || S.loading || S.done || S.err) return;
        S.loading = true;
        const gen = S.gen;
        const url = feedUrl(S.cursor, S.vert, !S.cursor && S.rand);
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const tm = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { } }, 15000) : 0;
        Promise.resolve(root.fetch(url, { credentials: 'same-origin', signal: ctl ? ctl.signal : undefined }))
            .then(r => (r && r.ok) ? r.json() : Promise.reject(new Error('HTTP ' + (r && r.status))))
            .then(d => {
                if (gen !== S.gen) return;
                const a = A();
                const p = normFeed(d, a && a.cardToItem, S.seen, S.vert);
                // 这几天刷到过的(看了 ≥3 秒)先跳过;连着 8 页全是看过的 = 池子快刷完了 → 放开,看过的也出
                const sm = seenMap();
                const fresh = S.relax ? p.items : p.items.filter(it => !sm.has(it.wk));
                S.emptyRun = fresh.length ? 0 : S.emptyRun + 1;
                if (S.emptyRun >= 8 && !S.relax) S.relax = true;
                S.cursor = p.next; S.done = p.done; S.rand = false;
                const from = S.items.length;
                fresh.forEach(it => { S.items.push(it); addSlide(S.items.length - 1); });
                // 到底了:换个随机位置接着刷(无尽,像抖音);连续两轮一条新的都没有才真的到底
                let more = !fresh.length && !S.done;
                if (S.done) {
                    if (fresh.length) S.wraps = 0;
                    if (S.wraps < 2) { S.wraps++; S.done = false; S.cursor = ''; S.rand = true; more = !fresh.length; }
                    else if (!S.items.length && !S.relax) { S.relax = true; S.wraps = 0; S.done = false; S.cursor = ''; S.rand = true; more = true; }
                }
                if (!S.items.length) showNote(S.done ? '暂时没有可刷的短片' : '');
                else if (S.done) addEnd();
                if (from === 0 && S.items.length) { S.cur = -1; setActive(0); }
                else if (S.cur >= 0) renderWindow();
                // 这一页全被筛掉了但还有下一页 → 接着拉
                if (more) setTimeout(() => { if (gen === S.gen) loadMore(); }, 300);
            })
            .catch(() => { if (gen === S.gen) { S.err = true; showNote('加载失败，可能是网络不稳定', true); } })
            .then(() => { if (tm) clearTimeout(tm); if (gen === S.gen) S.loading = false; });
    }
    function reload() {
        destroyAll();
        S.gen++;
        S.items = []; S.seen = new Set(); S.cursor = ''; S.done = false; S.err = false; S.loading = false; S.cur = -1; S.ratio = new Map();
        S.rand = true; S.wraps = 0; S.emptyRun = 0; S.relax = false;
        if (S.io) { try { S.io.disconnect(); } catch (e) { } }
        S.slides = [];
        if (S.list) { while (S.list.firstChild) S.list.removeChild(S.list.firstChild); S.list.scrollTop = 0; }
        showNote('');
        loadMore();
    }

    // ---- 条目(空壳 + 视口附近才有内容)----
    function addSlide(i) {
        const sl = h('section', 'dg-fs', { 'data-i': String(i) });
        S.slides[i] = sl;
        const endEl = S.list.querySelector('.dg-fs-end');
        S.list.insertBefore(sl, endEl || null);
        if (S.io) S.io.observe(sl);
    }
    function addEnd() {
        if (!S.list || S.list.querySelector('.dg-fs-end')) return;
        const e = h('div', 'dg-fs-end');
        e.textContent = '没有更多了';
        S.list.appendChild(e);
    }
    function fill(i) {
        const sl = S.slides[i], it = S.items[i];
        if (!sl || !it || sl.getAttribute('data-full') === '1') return;
        sl.setAttribute('data-full', '1');
        if (it.orient === 'h') sl.classList.add('dg-fs-h');
        if (it.pic) {
            const bg = h('div', 'dg-fs-bg');
            bg.style.backgroundImage = 'url("' + String(it.pic).replace(/["\\\n]/g, '') + '")';
            sl.appendChild(bg);
            const img = h('img', 'dg-fs-poster', { alt: '', referrerpolicy: 'no-referrer', decoding: 'async' });
            img.src = it.pic;
            sl.appendChild(img);
        }
        const v = h('video', 'dg-fs-v', { playsinline: '', 'webkit-playsinline': '', muted: '', preload: 'none', 'aria-label': it.title || '短片' });
        v.muted = true; v.defaultMuted = true; v.playsInline = true; v.loop = true;
        sl.appendChild(v);
        const tap = h('button', 'dg-fs-tap', { type: 'button', 'aria-label': '播放' });
        tap.appendChild(icon('fa-play'));
        const tl = h('span');
        tl.textContent = '点一下播放';
        tap.appendChild(tl);
        const hint = h('small', 'dg-fs-hint');
        hint.textContent = '设置里打开「移动网络也自动播放」就能滑到即播';
        hint.hidden = true;
        tap.appendChild(hint);
        tap.hidden = true;
        sl.appendChild(tap);
        sl.appendChild(h('div', 'dg-fs-spin', { 'aria-hidden': 'true' }));
        const info = h('div', 'dg-fs-info');
        const ttl = h('button', 'dg-fs-title', { type: 'button', title: '看完整播放页' });
        ttl.textContent = it.title || it.code || '未命名';
        info.appendChild(ttl);
        const sub = [it.code, fmtDur(it.dur || (it.lines[0] && it.lines[0].dur)), it.badge].filter(Boolean).join(' · ');
        if (sub) { const sd = h('div', 'dg-fs-sub'); sd.textContent = sub; info.appendChild(sd); }
        sl.appendChild(info);
        const mute = h('button', 'dg-fs-mute', { type: 'button' });
        sl.appendChild(mute);
        setMuteIcon(mute);
        const msg = h('div', 'dg-fs-msg', { role: 'status' });
        msg.hidden = true;
        sl.appendChild(msg);
        // 进度条(可拖)+ 时间;长按 2 倍速的角标;双击 ±10 秒的提示
        const prog = h('div', 'dg-fs-prog', { role: 'slider', 'aria-label': '播放进度', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', tabindex: '-1' });
        const track = h('div', 'dg-fs-prog-t');
        track.appendChild(h('div', 'dg-fs-prog-f'));
        prog.appendChild(track);
        const tm = h('span', 'dg-fs-time');
        prog.appendChild(tm);
        sl.appendChild(prog);
        const fast = h('div', 'dg-fs-fast', { 'aria-hidden': 'true' });
        fast.appendChild(icon('fa-forward'));
        fast.appendChild(root.document.createTextNode(' 2× 快进中'));
        fast.hidden = true;
        sl.appendChild(fast);
        sl.appendChild(h('div', 'dg-fs-seek', { 'aria-hidden': 'true' }));
    }
    function empty(i) {
        const sl = S.slides[i];
        destroyInst(i);
        if (!sl || sl.getAttribute('data-full') !== '1') return;
        while (sl.firstChild) sl.removeChild(sl.firstChild);
        sl.removeAttribute('data-full');
        sl.classList.remove('dg-fs-on', 'dg-fit-cover', 'dg-fs-h', 'dg-fs-err');
    }
    function renderWindow() {
        const lo = S.cur - WINDOW_BEFORE, hi = S.cur + WINDOW_AFTER;
        for (let i = 0; i < S.slides.length; i++) {
            if (i >= lo && i <= hi) fill(i); else empty(i);
        }
    }
    function setMuteIcon(btn) {
        if (!btn) return;
        while (btn.firstChild) btn.removeChild(btn.firstChild);
        btn.appendChild(icon(S.muted ? 'fa-volume-xmark' : 'fa-volume-high'));
        btn.setAttribute('aria-label', S.muted ? '打开声音' : '静音');
    }
    function syncMute() {
        Object.keys(S.inst).forEach(k => { const x = S.inst[k]; if (x && x.video) x.video.muted = S.muted; });
        if (S.list) Array.prototype.forEach.call(S.list.querySelectorAll('.dg-fs-mute'), setMuteIcon);
    }

    // ---- 播放实例(复核:只有在放的那一个;下一条只预连源站,见 preconnectNext)----
    function videoOf(i) { const sl = S.slides[i]; return sl ? sl.querySelector('.dg-fs-v') : null; }
    const PC = new Map();   // 源站 → <link rel=preconnect>(最多 4 个,先进先出)
    function preconnectNext(i) {
        try {
            const it = S.items[i], line = it && it.lines[0], d = root.document;
            if (!line || !d || !d.head || typeof d.createElement !== 'function' || locked()) return;
            const loc = root.location;
            const o = new URL(playUrl(line), loc && loc.href ? loc.href : undefined).origin;
            if (!o || o === 'null' || PC.has(o) || (loc && o === loc.origin)) return;
            const l = d.createElement('link');
            l.setAttribute('rel', 'preconnect'); l.setAttribute('href', o); l.setAttribute('crossorigin', 'anonymous'); l.setAttribute('data-dgx', 'feed');
            d.head.appendChild(l);
            PC.set(o, l);
            while (PC.size > 4) { const k = PC.keys().next().value; const x = PC.get(k); PC.delete(k); try { if (x && x.parentNode) x.parentNode.removeChild(x); } catch (e) { } }
        } catch (e) { }
    }
    function makeInst(i, start) {
        const it = S.items[i], v = videoOf(i);
        if (!it || !v || locked()) return null;
        let x = S.inst[i];
        if (!x) x = S.inst[i] = { i, li: 0, hls: null, video: v, native: false, parsed: false, want: false, started: false, gen: S.gen };
        const line = it.lines[x.li];
        if (!line) return x;
        const url = playUrl(line);
        x.line = line;
        if (mse() && root.Hls) {
            if (!x.hls) {
                let hls;
                try { hls = new root.Hls(hlsConfig()); } catch (e) { return x; }
                x.hls = hls;
                const E = root.Hls.Events || {};
                const mine = () => S.inst[i] === x && x.hls === hls;
                hls.on(E.MANIFEST_PARSED, () => { if (!mine()) return; x.parsed = true; if (x.want && !x.started) { x.started = true; try { hls.startLoad(loadPos(x)); } catch (e) { } } });
                hls.on(E.FRAG_LOADED, (_, d) => {
                    const n = (d && d.frag && d.frag.stats && (d.frag.stats.loaded || d.frag.stats.total)) || 0;
                    S.bytes += n;
                });
                // 片头 / 片尾贴片(Worker 没剪掉的不连续短块):只在正片那块里放
                hls.on(E.LEVEL_LOADED, (_, d) => {
                    if (!mine()) return;
                    const w = contentWindow(d && d.details && d.details.fragments);
                    x.win = w;
                    if (w && x.video && (Number(x.video.currentTime) || 0) < w.start - 0.5) { try { x.video.currentTime = w.start; } catch (e) { } }
                });
                // 致命的媒体错误先 recoverMediaError 一次(解码 / 追加缓冲出错常能救回来),再不行才换线路
                hls.on(E.ERROR, (_, d) => {
                    if (!d || !d.fatal || !mine()) return;
                    const T = root.Hls.ErrorTypes || {};
                    if (d.type === T.MEDIA_ERROR && !x.recovered) { x.recovered = true; try { hls.recoverMediaError(); return; } catch (e) { } }
                    failInst(i);
                });
                hls.loadSource(url);
                hls.attachMedia(v);
            }
        } else if (nativeOk(v)) {
            x.native = true;
            if (start && v.getAttribute('src') !== url) { v.src = url; try { v.load(); } catch (e) { } }
        } else {
            showMsg(i, '这台设备放不了这种视频');
            return x;
        }
        bindVideo(i, v);
        if (start) startInst(x);
        return x;
    }
    // 从哪儿开始 / 接着加载:第一次从 0;停过(往回翻 / 自动播被拦)再续上时从画面停的位置
    function loadPos(x) { const t = x && x.video ? Number(x.video.currentTime) || 0 : 0; return t > 0 ? t : 0; }
    // 起播看门狗:要播了 15 秒还没出画面、也没报错(卡在 0 秒一直转圈)→ 当这条线路放不了;页面在后台 / 用户停着不算
    const START_MS = 15000;
    function armWatchdog(x) {
        clearTimeout(x.wd);
        x.wd = setTimeout(() => {
            if (S.inst[x.i] !== x || !x.want || x.gen !== S.gen || S.suspended || !S.open) return;
            try { if (root.document.hidden) { armWatchdog(x); return; } } catch (e) { }
            const v = x.video;
            if (v && (Number(v.currentTime) || 0) > 0.1) return;
            failInst(x.i);
        }, START_MS);
    }
    function startInst(x) {
        armWatchdog(x);
        x.want = true;
        if (x.hls && x.parsed && !x.started) { x.started = true; try { x.hls.startLoad(loadPos(x)); } catch (e) { } }
        if (x.native && !x.video.getAttribute('src')) { x.video.src = playUrl(x.line); try { x.video.load(); } catch (e) { } }
        x.video.muted = S.muted;
        playVideo(x.video, x.i);
    }
    // 带声音自动播被浏览器拦 → 退回静音再播;修订:静音也被拦(iOS 低电量模式、Safari「不允许自动播放」、Firefox 拦音视频;
    //   滑动不算用户手势)→ 以前什么都不做,一直转圈、hls.js 还照样下 10 秒缓冲 —— 现在出「点一下播放」、停止下载,点了再播
    function playVideo(v, i) {
        let p;
        try { p = v.play(); } catch (e) { return; }
        if (!p || typeof p.catch !== 'function') return;
        p.catch((err) => {
            if (!err || err.name !== 'NotAllowedError') return;
            if (!v.muted) {
                S.muted = true; syncMute();
                let p2 = null;
                try { p2 = v.play(); } catch (e) { p2 = null; }
                if (p2 && typeof p2.catch === 'function') p2.catch((e2) => { if (e2 && e2.name === 'NotAllowedError') autoplayBlocked(i, v); });
                return;
            }
            autoplayBlocked(i, v);
        });
    }
    function autoplayBlocked(i, v) {
        const x = S.inst[i];
        if (!x || x.video !== v || x.gen !== S.gen) return;
        x.want = false;
        if (x.hls && x.started) { try { x.hls.stopLoad(); } catch (e) { } x.started = false; }
        if (x.native && v.getAttribute('src')) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { } x.nat = null; }
        showTap(i, '');
    }
    // 修订:每个 <video> 只绑一次(以前按实例绑:翻走再翻回来重建实例时同一个元素再叠一套监听,原生 HLS 一次 error 连换好几条线路、
    //   好线路也被拆掉);处理时现读这一条当前的实例,不是它的(旧实例 / 重新拉过的列表)不认
    function bindVideo(i, v) {
        if (!v || v.__dgFeedBound) return;
        v.__dgFeedBound = true;
        const cur = () => { const x = S.inst[i]; return (x && x.video === v && x.gen === S.gen) ? x : null; };
        v.addEventListener('playing', () => { const x = cur(); if (!x) return; clearTimeout(x.wd); const sl = S.slides[i]; if (sl) sl.classList.add('dg-fs-on'); measure(i, x); });
        v.addEventListener('loadedmetadata', () => { const x = cur(); if (x) measure(i, x); });
        v.addEventListener('error', () => { const x = cur(); if (x && x.native && v.getAttribute('src')) failInst(i); });
        const count = () => { const x = cur(); if (x && x.native) countNative(x); };
        v.addEventListener('progress', count);
        // 原生 HLS 记流量 + 进度条 / 正片窗口(跳过贴片、只在正片里循环)/ 看了 ≥3 秒记「看过」(每种监听只绑一个)
        v.addEventListener('timeupdate', () => {
            const x = cur();
            if (!x) return;
            if (x.native) countNative(x);
            const w = x.win, t = Number(v.currentTime) || 0;
            if (w && !v.seeking) {
                if (t < w.start - 0.5) { try { v.currentTime = w.start; } catch (e) { } return; }
                if (t >= w.end - 0.25) { try { v.currentTime = w.start; } catch (e) { } return; }
            }
            progUpd(i);
            if (t - (w ? w.start : 0) >= 3 && i === S.cur) markWatched(S.items[i]);
        });
    }
    // 原生 HLS 的流量估算(见 nativeBytes):播过的秒数按 timeupdate 累加(循环回开头 / 跳转不算),缓冲过的秒数取 buffered 的最大值;只往上加
    function countNative(x) {
        const v = x.video;
        if (!v) return;
        const t = Number(v.currentTime) || 0;
        const n = x.nat || (x.nat = { last: t, play: 0, buf: 0, counted: 0 });
        const d = t - n.last;
        if (d > 0 && d <= 2) n.play += d;
        n.last = t;
        let b = 0;
        try { const r = v.buffered; for (let k = 0; r && k < r.length; k++) b += Math.max(0, r.end(k) - r.start(k)); } catch (e) { }
        if (b > n.buf) n.buf = b;
        const est = nativeBytes(n.buf, n.play);
        if (est > n.counted) { S.bytes += est - n.counted; n.counted = est; }
    }
    function measure(i, x) {
        const v = x.video, it = S.items[i], sl = S.slides[i];
        if (!v || !it || !(v.videoWidth > 0 && v.videoHeight > 0)) return;
        let sw = 0, sh = 0;
        try { sw = root.innerWidth; sh = root.innerHeight; } catch (e) { }
        if (sl) sl.classList.toggle('dg-fit-cover', fitOf(v.videoWidth, v.videoHeight, sw, sh) === 'cover');
        const o = orientOf(v.videoWidth, v.videoHeight);
        if (sl) sl.classList.toggle('dg-fs-h', o === 'h');
        if (o && o !== it.orient && !v.paused) report(it, x.line, v.videoWidth, v.videoHeight, o);
    }
    // 方向上报(契约 P4 beacon 的 orient/w/h):每部每会话一次;无痕不报;线路没带 vod_id 时按作品信息补(本地目录,零上游)
    function report(it, line, w, hgt, o) {
        const a = A();
        if (!a || !a.beacon || typeof a.beacon.send !== 'function' || !line || S.reported.has(it.wk)) return;
        if (typeof a.incognito === 'function' && a.incognito()) return;
        S.reported.add(it.wk);
        const send = (vid) => { if (vid) { try { a.beacon.send({ wk: it.wk, site_key: line.site, vod_id: vid, ok: true, w, h: hgt, orient: o }); } catch (e) { } } };
        if (line.vod_id) { send(line.vod_id); return; }
        if (typeof a.fetchWorkRaw !== 'function') return;
        Promise.resolve(a.fetchWorkRaw(it.wk)).then(d => {
            const s = d && Array.isArray(d.sources) ? d.sources.find(z => z && z.site_key === line.site) : null;
            send(s && s.vod_id != null ? String(s.vod_id) : '');
        }).catch(() => { });
    }
    // 这条线路放不了:换下一条线路;都不行 → 提示,往下滑
    function failInst(i) {
        const x = S.inst[i], it = S.items[i];
        if (!x || !it || x.gen !== S.gen) return;
        const want = x.want;
        teardown(x);
        x.hls = null; x.parsed = false; x.started = false; x.recovered = false; x.win = null;
        x.li++;
        if (x.li < it.lines.length) { makeInst(i, want); return; }
        delete S.inst[i];
        showMsg(i, '这条暂时放不了，马上跳到下一条…');
        // 正在看的这条:1.5 秒后自动翻到下一条(用户没自己翻走才翻)
        if (i === S.cur) {
            const g = S.gen;
            setTimeout(() => { if (S.open && !S.suspended && S.gen === g && S.cur === i && i + 1 < S.items.length) step(1); }, 1500);
        }
    }
    function showMsg(i, text) {
        const sl = S.slides[i];
        const m = sl && sl.querySelector('.dg-fs-msg');
        if (m) { m.textContent = text; m.hidden = !text; }
        if (sl) { sl.classList.remove('dg-fs-on'); sl.classList.toggle('dg-fs-err', !!text); }
    }
    function teardown(x) {
        if (!x) return;
        clearTimeout(x.wd);
        if (x.hls) { try { x.hls.destroy(); } catch (e) { } }
        const v = x.video;
        if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { } }
        x.nat = null;   // 换线路 / 重建 = 重新下载,估算从头记(已记的流量不退)
    }
    function destroyInst(i) {
        const x = S.inst[i];
        if (!x) return;
        delete S.inst[i];
        teardown(x);
        const sl = S.slides[i];
        if (sl) sl.classList.remove('dg-fs-on');
    }
    function destroyAll() { Object.keys(S.inst).forEach(k => destroyInst(+k)); }

    // ---- 当前条目 ----
    function setActive(i) {
        if (i === S.cur || i < 0 || i >= S.items.length) return;
        S.cur = i;
        renderWindow();
        Object.keys(S.inst).forEach(k => { const n = +k; if (n !== i && n !== i + 1) destroyInst(n); });
        // 离开的那条(往回翻时留着的下一条)先停
        Object.keys(S.inst).forEach(k => { const n = +k; if (n !== i) park(n); });
        activate(i);
        if (i >= S.items.length - MORE_AT) loadMore();
    }
    // 修订:留着的那条不只暂停,也不再缓冲(以前 hls.js 暂停着还接着下到 maxBufferLength,等于两个实例在跑):
    //   hls.js stopLoad(清单和已有缓冲留着,翻回去从停的地方续上);原生 HLS 停不住下载,直接销毁
    function park(n) {
        const x = S.inst[n];
        if (!x) return;
        if (x.native) { destroyInst(n); return; }
        x.want = false;
        if (x.video && !x.video.paused) { try { x.video.pause(); } catch (e) { } }
        if (x.hls && x.started) { try { x.hls.stopLoad(); } catch (e) { } x.started = false; }
    }
    function showTap(i, w) {
        const sl = S.slides[i];
        const tap = sl && sl.querySelector('.dg-fs-tap');
        if (!tap) return;
        const hint = tap.querySelector('.dg-fs-hint');
        if (hint) hint.hidden = !(w === 'unknown' || w === 'cellular');
        tap.hidden = false;
    }
    function activate(i) {
        if (!S.open || S.suspended) return;
        if (locked()) { S.lockHeld = true; destroyAll(); return; }
        const sl = S.slides[i];
        const tap = sl && sl.querySelector('.dg-fs-tap');
        const w = why();
        const m = w ? 'tap' : 'auto';
        const x0 = S.inst[i];
        if (m === 'tap' && !(x0 && x0.user)) { showTap(i, w); if (x0 && x0.video && !x0.video.paused) { try { x0.video.pause(); } catch (e) { } } return; }
        if (tap) tap.hidden = true;
        const x = makeInst(i, true);
        if (x && x0 && x0.user) x.user = true;
        // 复核:不再预拉下一条的 m3u8 清单(验收口径:除了正在放的这条,什么都不预拉 m3u8 正文)—— 只给它的源站预连(DNS + TLS,不发请求)
        if (m === 'auto' && i + 1 < S.items.length && !S.inst[i + 1]) preconnectNext(i + 1);
    }
    function onListClick(e) {
        const t = e.target;
        const sl = t && t.closest ? t.closest('.dg-fs') : null;
        if (!sl) return;
        const i = parseInt(sl.getAttribute('data-i'), 10);
        const it = S.items[i];
        if (!it) return;
        if (t.closest('.dg-fs-title')) {
            const o = S.opts;
            if (o && typeof o.onPick === 'function') o.onPick(it.card);
            return;
        }
        if (t.closest('.dg-fs-mute')) { S.muted = !S.muted; syncMute(); const x = S.inst[i]; if (x && x.want && x.video && x.video.paused && !S.muted) playVideo(x.video, i); return; }
        // 点「点一下播放」(出着这个按钮时点画面也算):现在才建实例 / 续上加载,在手势里播
        const tapBtn = sl.querySelector('.dg-fs-tap');
        if (t.closest('.dg-fs-tap') || (tapBtn && !tapBtn.hidden)) { if (i === S.cur) userPlay(i); return; }
        if (t.closest('.dg-fs-prog')) return;
        if (Date.now() < S.suppressClick) return;   // 长按 2 倍速 / 拖进度条松手的那一下不算点
        // 点画面:先等一下看是不是双击(左 40% 后退 10 秒、右 40% 前进 10 秒);单击照旧:静音 → 开声音,有声 → 暂停 / 继续
        const now = Date.now(), lt = S.lastTap;
        if (lt && lt.i === i && now - lt.t < DBL_MS && Math.abs(e.clientX - lt.x) < 60 && Math.abs(e.clientY - lt.y) < 60) {
            clearTimeout(S.tapT); S.lastTap = null;
            const r = sl.getBoundingClientRect();
            const z = tapZone((e.clientX - r.left) / (r.width || 1));
            if (z) seekBy(i, z * SEEK_STEP, z);
            return;
        }
        S.lastTap = { i, t: now, x: e.clientX, y: e.clientY };
        clearTimeout(S.tapT);
        S.tapT = setTimeout(() => { S.lastTap = null; singleTap(i); }, DBL_MS);
    }
    function singleTap(i) {
        const x = S.inst[i];
        if (!x || !x.video || i !== S.cur) return;
        if (S.muted) { S.muted = false; syncMute(); if (x.video.paused) playVideo(x.video, i); return; }
        if (x.video.paused) playVideo(x.video, i); else { try { x.video.pause(); } catch (err) { } }
    }
    // ---- 进度条 / 快进快退 ----
    function winOf(x) {
        const v = x && x.video, D = v ? Number(v.duration) : 0, w = x && x.win;
        const s0 = w ? w.start : 0, e0 = w ? w.end : (isFinite(D) && D > 0 ? D : 0);
        return { s0, e0, len: Math.max(0, e0 - s0) };
    }
    function progUpd(i) {
        const x = S.inst[i], sl = S.slides[i];
        if (!x || !x.video || !sl) return;
        const f = sl.querySelector('.dg-fs-prog-f'), tm = sl.querySelector('.dg-fs-time'), bar = sl.querySelector('.dg-fs-prog');
        const W = winOf(x), t = Math.max(0, (Number(x.video.currentTime) || 0) - W.s0);
        const p = W.len > 0 ? Math.min(1, t / W.len) : 0;
        if (f) f.style.width = (p * 100).toFixed(2) + '%';
        if (tm) tm.textContent = W.len > 0 ? fmtDur(t) + ' / ' + fmtDur(W.len) : '';
        if (bar) bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    }
    function seekTo(i, sec) {
        const x = S.inst[i];
        if (!x || !x.video) return;
        const W = winOf(x);
        if (!(W.len > 0)) return;
        const to = Math.max(W.s0, Math.min(W.e0 - 0.4, sec));
        try { x.video.currentTime = to; } catch (e) { }
        progUpd(i);
    }
    function seekBy(i, d, side) {
        const x = S.inst[i];
        if (!x || !x.video) return;
        seekTo(i, (Number(x.video.currentTime) || 0) + d);
        const sl = S.slides[i], tip = sl && sl.querySelector('.dg-fs-seek');
        if (tip) {
            tip.textContent = (d > 0 ? '+' : '−') + Math.abs(d) + ' 秒';
            tip.classList.remove('dg-l', 'dg-r', 'dg-show');
            tip.classList.add(side < 0 ? 'dg-l' : 'dg-r');
            void tip.offsetWidth;
            tip.classList.add('dg-show');
            clearTimeout(tip.__t);
            tip.__t = setTimeout(() => tip.classList.remove('dg-show'), 650);
        }
    }
    function seekAtX(i, clientX) {
        const sl = S.slides[i], tr = sl && sl.querySelector('.dg-fs-prog-t'), x = S.inst[i];
        if (!tr || !x) return;
        const r = tr.getBoundingClientRect();
        const W = winOf(x);
        if (!(r.width > 0 && W.len > 0)) return;
        seekTo(i, W.s0 + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * W.len);
    }
    // ---- 长按 2 倍速(按着画面 0.4 秒,松手恢复;手指一挪 = 在滑动,不算)/ 拖进度条 ----
    function slideIndexOf(t) {
        const sl = t && t.closest ? t.closest('.dg-fs') : null;
        return sl ? parseInt(sl.getAttribute('data-i'), 10) : -1;
    }
    function fastBadge(i, on) { const sl = S.slides[i], b = sl && sl.querySelector('.dg-fs-fast'); if (b) b.hidden = !on; }
    function startFast(p) {
        const x = S.inst[p.i];
        if (!x || !x.video || x.video.paused || p.lp) return;
        p.lp = true; p.rate = x.video.playbackRate || 1;
        try { x.video.playbackRate = 2; } catch (e) { }
        fastBadge(p.i, true);
    }
    function onDown(e) {
        if (e.button != null && e.button !== 0) return;
        const t = e.target;
        const i = slideIndexOf(t);
        if (i < 0 || i !== S.cur) return;
        if (t.closest && t.closest('.dg-fs-prog')) {
            e.preventDefault();
            S.scrub = { i, id: e.pointerId };
            try { t.closest('.dg-fs-prog').setPointerCapture(e.pointerId); } catch (err) { }
            const sl = S.slides[i];
            if (sl) sl.classList.add('dg-fs-scrub');
            seekAtX(i, e.clientX);
            return;
        }
        if (t.closest && t.closest('button, a, input, label')) return;
        S.press = { i, x: e.clientX, y: e.clientY, id: e.pointerId, lp: false };
        clearTimeout(S.lpT);
        S.lpT = setTimeout(() => { if (S.press && S.press.i === S.cur) startFast(S.press); }, LP_MS);
    }
    function onMove(e) {
        if (S.scrub && S.scrub.id === e.pointerId) { seekAtX(S.scrub.i, e.clientX); return; }
        const p = S.press;
        if (!p || p.id !== e.pointerId || p.lp) return;
        if (Math.abs(e.clientX - p.x) > 10 || Math.abs(e.clientY - p.y) > 10) { clearTimeout(S.lpT); S.press = null; }
    }
    function onUp(e) {
        if (S.scrub && S.scrub.id === e.pointerId) {
            const sl = S.slides[S.scrub.i];
            if (sl) sl.classList.remove('dg-fs-scrub');
            S.scrub = null;
            S.suppressClick = Date.now() + 350;
            return;
        }
        const p = S.press;
        clearTimeout(S.lpT);
        S.press = null;
        if (p && p.lp) {
            const x = S.inst[p.i];
            if (x && x.video) { try { x.video.playbackRate = p.rate || 1; } catch (err) { } }
            fastBadge(p.i, false);
            S.suppressClick = Date.now() + 400;
        }
    }
    // 手机系统的长按菜单(安卓 ~400ms 先到):在画面上拦掉,并且就此开始 2 倍速(系统已经认定是长按了)
    function onCtx(e) {
        const t = e.target;
        if (slideIndexOf(t) < 0 || (t.closest && t.closest('a, input'))) return;
        e.preventDefault();
        if (S.press && !S.press.lp) { clearTimeout(S.lpT); startFast(S.press); }
    }
    function userPlay(i) {
        const x = makeInst(i, true);
        if (!x) return null;
        x.user = true;
        const sl = S.slides[i];
        const tap = sl && sl.querySelector('.dg-fs-tap');
        if (tap) tap.hidden = true;
        return x;
    }
    function onIO(entries) {
        for (const en of entries) {
            const i = parseInt(en.target.getAttribute('data-i'), 10);
            if (i >= 0) S.ratio.set(i, en.isIntersecting ? en.intersectionRatio : 0);
        }
        let best = -1, br = 0;
        S.ratio.forEach((r, i) => { if (r >= 0.6 && r > br) { best = i; br = r; } });
        if (best >= 0) setActive(best);
    }
    // 没有 IntersectionObserver 的老浏览器:按滚动位置算(rAF 节流,只改 DOM)
    let rafPending = false;
    function onScrollFallback() {
        if (rafPending || !S.list) return;
        rafPending = true;
        (root.requestAnimationFrame || ((f) => setTimeout(f, 16)))(() => {
            rafPending = false;
            const H = S.list.clientHeight || 1;
            setActive(Math.max(0, Math.min(S.items.length - 1, Math.round(S.list.scrollTop / H))));
        });
    }
    function step(d) {
        if (!S.list) return;
        const H = S.list.clientHeight || 0;
        const to = Math.max(0, Math.min(S.items.length - 1, S.cur + d));
        try { S.list.scrollTo({ top: to * H, behavior: 'smooth' }); } catch (e) { S.list.scrollTop = to * H; }
    }
    // 修订:键盘只认刷短片自己的(以前文档捕获阶段谁的键都吃:刷短片开着时会话过期弹出的登录框里打不了 j / k / 空格、
    //   方向键挪不了光标、Esc 把底下的刷短片关了;「只看竖屏」勾选框上按空格变成暂停)
    const NOKEY_INPUT = /^(checkbox|button|submit|reset|image|file|color|hidden)$/i;
    function typingIn(el) {
        if (!el || !el.tagName) return false;
        const tag = String(el.tagName).toLowerCase();
        if (tag === 'textarea' || tag === 'select') return true;
        if (tag === 'input') return !NOKEY_INPUT.test(String((el.getAttribute && el.getAttribute('type')) || el.type || 'text'));
        if (el.isContentEditable) return true;
        const ce = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
        return ce === '' || ce === 'true';
    }
    function inside(el, box) { let n = el; while (n) { if (n === box) return true; n = n.parentNode; } return false; }
    // 登录框(#password-screen,z-index 10000)盖在刷短片(3000)上面:和 index.html 判断它亮着的口径一样
    function loginShown() {
        try {
            const ps = root.document.getElementById('password-screen');
            return !!(ps && ps.style && ps.style.display !== 'none' && !(ps.classList && ps.classList.contains('hidden')));
        } catch (e) { return false; }
    }
    function keyMine(e) {
        const d = root.document, t = e.target;
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (typingIn(t) || typingIn(d.activeElement)) return false;
        if (t && t !== d && t !== d.body && t !== d.documentElement && !inside(t, S.el)) return false;   // 焦点在别的层上
        return !loginShown();
    }
    function onKey(e) {
        if (!S.open || S.suspended || !keyMine(e)) return;
        const k = e.key;
        if (k === 'Escape' || k === 'Esc') { e.preventDefault(); e.stopPropagation(); close(true); return; }
        if (k === 'ArrowDown' || k === 'PageDown' || k === 'j') { e.preventDefault(); e.stopPropagation(); step(1); return; }
        if (k === 'ArrowUp' || k === 'PageUp' || k === 'k') { e.preventDefault(); e.stopPropagation(); step(-1); return; }
        if (k === 'm') { S.muted = !S.muted; syncMute(); return; }
        if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekBy(S.cur, k === 'ArrowLeft' ? -5 : 5, k === 'ArrowLeft' ? -1 : 1); return; }
        if (k === ' ') {
            // 焦点在按钮 / 勾选框上:空格照旧是按那个按钮
            const t = e.target;
            if (t && t.closest && t.closest('button, a, label, input, select, textarea')) return;
            const x = S.inst[S.cur];
            const sl = S.slides[S.cur], tap = sl && sl.querySelector('.dg-fs-tap');
            if (tap && !tap.hidden) { e.preventDefault(); userPlay(S.cur); return; }
            if (x && x.video) { e.preventDefault(); if (x.video.paused) playVideo(x.video, S.cur); else x.video.pause(); }
        }
    }
    function onVis() {
        if (!S.open || S.suspended) return;
        const x = S.inst[S.cur];
        if (root.document.hidden) { if (x && x.video) { try { x.video.pause(); } catch (e) { } } }
        else if (x && x.video && x.want && !locked()) playVideo(x.video, S.cur);
    }

    // ======================= 对外 =======================
    // opts:{ onClose()(点返回 / Esc,交给 adult.js 退掉 #/feed),onPick(card)(点片名,交给 adult.js 开播放页)}
    function open(opts) {
        const a = A();
        if (a && typeof a.isTV === 'function' && a.isTV()) return false;
        if (S.open) { if (S.suspended) resume(); return true; }
        S.opts = opts || null;
        S.open = true; S.suspended = false;
        S.vert = lsGet(VERT_KEY) === '1';
        S.muted = true;
        injectCss();
        const d = root.document;
        const el = build();
        d.body.appendChild(el);
        try { d.documentElement.classList.add('dg-feed-lock'); } catch (e) { }
        if (typeof root.IntersectionObserver === 'function') S.io = new root.IntersectionObserver(onIO, { root: S.list, threshold: [0, 0.6, 0.9] });
        else S.list.addEventListener('scroll', onScrollFallback, { passive: true });
        S.onKey = onKey; S.onVis = onVis;
        d.addEventListener('keydown', S.onKey, true);
        d.addEventListener('visibilitychange', S.onVis);
        try { S.list.focus({ preventScroll: true }); } catch (e) { }
        reload();
        return true;
    }
    // fromUi = 用户点了返回 / Esc:交给 onClose(adult.js 退掉压的历史,hashchange 再回来调 close())
    function close(fromUi) {
        if (!S.open) return;
        if (fromUi && S.opts && typeof S.opts.onClose === 'function') { const f = S.opts.onClose; S.opts = Object.assign({}, S.opts, { onClose: null }); f(); if (!S.open) return; }
        S.open = false; S.suspended = false;
        S.gen++;
        destroyAll();
        if (S.io) { try { S.io.disconnect(); } catch (e) { } S.io = null; }
        const d = root.document;
        try { d.removeEventListener('keydown', S.onKey, true); d.removeEventListener('visibilitychange', S.onVis); } catch (e) { }
        try { d.documentElement.classList.remove('dg-feed-lock'); } catch (e) { }
        if (S.el && S.el.parentNode) S.el.parentNode.removeChild(S.el);
        S.el = S.list = S.note = S.vertBox = null;
        S.slides = []; S.items = []; S.seen = new Set(); S.cur = -1; S.ratio = new Map(); S.opts = null;
    }
    // 开播放页前:收起(停掉、销毁实例省流量),位置和已拉的条目都留着
    function suspend() {
        if (!S.open || S.suspended) return;
        S.suspended = true;
        destroyAll();
        if (S.el) S.el.style.display = 'none';
        try { root.document.documentElement.classList.remove('dg-feed-lock'); } catch (e) { }
    }
    function resume() {
        if (!S.open || !S.suspended) return;
        S.suspended = false;
        if (S.el) S.el.style.display = '';
        try { root.document.documentElement.classList.add('dg-feed-lock'); } catch (e) { }
        const i = S.cur;
        if (i >= 0) {
            // 回到原位(display:none 期间滚动位置可能被重置)
            try { const H = S.list.clientHeight || 0; if (H) S.list.scrollTop = i * H; } catch (e) { }
            renderWindow();
            activate(i);
        }
        try { S.list.focus({ preventScroll: true }); } catch (e) { }
    }
    function boot() {
        // 「刷到过」「看过」两个本机键:无痕时不写、一键清除连同删(privacy.js 的键表)
        try { const P = root.dgPrivacy; if (P && typeof P.registerKeys === 'function') P.registerKeys({ keys: [SEEN_KEY, HIST_KEY] }); } catch (e) { }
        // 隐私锁上 → 停掉并销毁全部实例(锁屏后面不许接着下清单 / 分片);解锁不自动续播:当前这条出「点一下播放」
        try {
            const P = root.dgPrivacy;
            if (P && typeof P.onChange === 'function') P.onChange(() => {
                if (!S.open) return;
                if (locked()) { S.lockHeld = true; destroyAll(); return; }
                if (!S.lockHeld || S.suspended) return;
                S.lockHeld = false;
                const sl = S.slides[S.cur];
                const tap = sl && sl.querySelector('.dg-fs-tap');
                if (tap) tap.hidden = false;
                else if (S.cur >= 0) activate(S.cur);
            });
        } catch (e) { }
    }
    const CSS = [
        'html.dg-feed-lock, html.dg-feed-lock body { overflow: hidden !important; }',
        // 按钮 / 字号跟着页面的界面缩放(--ui-scale,设置里的「界面大小」)走,底子也比以前大一号
        '.dg-feed { --fs: var(--ui-scale, 1); position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 3000; background: #000; color: #fff; display: flex; flex-direction: column; }',
        '.dg-feed-bar { position: absolute; top: 0; left: 0; right: 0; z-index: 3; display: flex; align-items: center; gap: calc(10px * var(--fs)); padding: 10px 16px; padding-top: calc(10px + env(safe-area-inset-top, 0px)); background: linear-gradient(to bottom, rgba(0,0,0,.7), transparent); pointer-events: none; }',
        '.dg-feed-bar > * { pointer-events: auto; }',
        '.dg-feed-x { flex: none; width: calc(46px * var(--fs)); height: calc(46px * var(--fs)); border-radius: 50%; border: 0; background: rgba(0,0,0,.5); color: #fff; font-size: calc(19px * var(--fs)); cursor: pointer; }',
        '.dg-feed-t { flex: 1; font-size: calc(18px * var(--fs)); white-space: nowrap; }',
        '.dg-feed-vert, .dg-feed-btn { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: calc(14px * var(--fs)); color: #fff; background: rgba(0,0,0,.5); border: 0; border-radius: 999px; padding: calc(8px * var(--fs)) calc(14px * var(--fs)); cursor: pointer; white-space: nowrap; }',
        '.dg-feed-btn:hover, .dg-feed-btn:focus-visible { background: rgba(229,9,20,.85); outline: none; }',
        '@media (max-width: 480px) { .dg-feed-vert, .dg-feed-btn { padding: calc(8px * var(--fs)) calc(10px * var(--fs)); } .dg-feed-t { display: none; } }',
        '.dg-feed-list { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow-y: scroll; scroll-snap-type: y mandatory; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; scrollbar-width: none; outline: none; }',
        '.dg-feed-list::-webkit-scrollbar { display: none; }',
        '.dg-fs { position: relative; height: 100%; width: 100%; scroll-snap-align: start; scroll-snap-stop: always; overflow: hidden; background: #000; }',
        '.dg-fs-bg { position: absolute; top: -20px; left: -20px; right: -20px; bottom: -20px; background-size: cover; background-position: center; filter: blur(24px) brightness(.45); }',
        '.dg-fs-poster, .dg-fs-v { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; }',
        '.dg-fs-v { opacity: 0; transition: opacity .2s; background: transparent; }',
        '.dg-fs.dg-fs-on .dg-fs-v { opacity: 1; }',
        '.dg-fs.dg-fit-cover .dg-fs-v { object-fit: cover; }',
        '.dg-fs-spin { position: absolute; top: 50%; left: 50%; width: 34px; height: 34px; margin: -17px 0 0 -17px; border: 3px solid rgba(255,255,255,.25); border-top-color: #fff; border-radius: 50%; animation: dg-fs-rot .9s linear infinite; pointer-events: none; }',
        '.dg-fs.dg-fs-on .dg-fs-spin, .dg-fs.dg-fs-err .dg-fs-spin, .dg-fs-tap:not([hidden]) ~ .dg-fs-spin { display: none; }',
        '@keyframes dg-fs-rot { to { transform: rotate(360deg); } }',
        '.dg-fs-tap { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 8px; border: 0; background: rgba(0,0,0,.5); color: #fff; border-radius: 16px; padding: calc(18px * var(--fs)) calc(26px * var(--fs)); font-size: calc(16px * var(--fs)); cursor: pointer; }',
        '.dg-fs-tap i { font-size: calc(36px * var(--fs)); }',
        '.dg-fs-hint { max-width: 220px; font-size: 11px; line-height: 1.4; color: #bbb; }',
        '.dg-fs-info { position: absolute; left: 0; right: calc(76px * var(--fs)); bottom: 0; z-index: 2; padding: 16px; padding-bottom: calc(36px + env(safe-area-inset-bottom, 0px)); background: linear-gradient(to top, rgba(0,0,0,.75), transparent); }',
        '.dg-fs-title { display: block; max-width: 100%; background: none; border: 0; padding: 0; color: #fff; font-size: calc(17px * var(--fs)); font-weight: 600; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }',
        '.dg-fs-title:hover, .dg-fs-title:focus { text-decoration: underline; text-underline-offset: 3px; outline: none; }',
        '.dg-fs-sub { margin-top: 4px; color: #ccc; font-size: calc(13px * var(--fs)); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dg-fs-mute { position: absolute; right: 14px; bottom: calc(40px + env(safe-area-inset-bottom, 0px)); z-index: 2; width: calc(54px * var(--fs)); height: calc(54px * var(--fs)); border-radius: 50%; border: 0; background: rgba(0,0,0,.5); color: #fff; font-size: calc(22px * var(--fs)); cursor: pointer; }',
        '.dg-fs-msg { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 2; background: rgba(0,0,0,.7); border-radius: 10px; padding: 12px 18px; font-size: calc(15px * var(--fs)); color: #ddd; }',
        // 进度条:平时细一条,按住 / 悬停加粗;触屏上手指拖它不会翻页(touch-action:none)
        '.dg-fs-prog { position: absolute; left: 0; right: 0; bottom: calc(6px + env(safe-area-inset-bottom, 0px)); z-index: 3; height: 26px; display: flex; align-items: center; gap: 10px; padding: 0 14px; touch-action: none; cursor: pointer; }',
        '.dg-fs-prog-t { position: relative; flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,.28); transition: height .12s; }',
        '.dg-fs-prog-f { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 2px; background: #fff; }',
        '.dg-fs-prog:hover .dg-fs-prog-t, .dg-fs.dg-fs-scrub .dg-fs-prog-t { height: 6px; } .dg-fs.dg-fs-scrub .dg-fs-prog-f { background: #e50914; }',
        '.dg-fs-time { flex: none; min-width: 7.5em; text-align: right; font-size: calc(12px * var(--fs)); color: rgba(255,255,255,.85); font-variant-numeric: tabular-nums; text-shadow: 0 1px 2px #000; }',
        '.dg-fs:not(.dg-fs-on) .dg-fs-prog { visibility: hidden; }',
        '.dg-fs-fast { position: absolute; top: calc(70px * var(--fs) + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); z-index: 3; background: rgba(0,0,0,.6); border-radius: 999px; padding: 6px 14px; font-size: calc(14px * var(--fs)); pointer-events: none; }',
        '.dg-fs-seek { position: absolute; top: 50%; z-index: 3; transform: translateY(-50%); padding: 10px 18px; border-radius: 999px; background: rgba(0,0,0,.55); font-size: calc(18px * var(--fs)); font-weight: 600; opacity: 0; pointer-events: none; transition: opacity .2s; }',
        '.dg-fs-seek.dg-l { left: 12%; } .dg-fs-seek.dg-r { right: 12%; } .dg-fs-seek.dg-show { opacity: 1; }',
        // 看过的短片面板
        '.dg-feed-hist { position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 6; background: rgba(10,10,10,.97); overflow-y: auto; padding: calc(14px + env(safe-area-inset-top, 0px)) 16px 24px; }',
        '.dg-fh-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; } .dg-fh-head b { flex: 1; font-size: calc(18px * var(--fs)); }',
        '.dg-fh-note { color: #999; font-size: calc(13px * var(--fs)); margin: 6px 0 12px; }',
        '.dg-fh-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(150px * var(--fs)), 1fr)); gap: 12px; }',
        '.dg-fh-item { background: none; border: 0; padding: 0; color: #eee; text-align: left; cursor: pointer; }',
        '.dg-fh-img { position: relative; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; background: #222; }',
        '.dg-fh-img img { width: 100%; height: 100%; object-fit: cover; display: block; }',
        '.dg-fh-dur { position: absolute; right: 4px; bottom: 4px; font-size: 11px; background: rgba(0,0,0,.7); border-radius: 4px; padding: 1px 5px; }',
        '.dg-fh-t { margin-top: 6px; font-size: calc(13px * var(--fs)); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }',
        '.dg-fh-item:hover .dg-fh-t, .dg-fh-item:focus-visible .dg-fh-t { color: #fff; text-decoration: underline; text-underline-offset: 3px; }',
        '.dg-fs-end { height: 64px; display: flex; align-items: center; justify-content: center; color: #777; font-size: 13px; scroll-snap-align: end; }',
        '.dg-feed-note { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 4; text-align: center; color: #ccc; font-size: 14px; }',
        '.dg-feed-retry { margin-left: 10px; border: 1px solid #666; background: transparent; color: #fff; border-radius: 14px; padding: 3px 12px; cursor: pointer; }',
        '@media (min-width: 769px) { .dg-fs-poster, .dg-fs-v { left: 50%; width: min(100%, 62vh); transform: translateX(-50%); } .dg-fs.dg-fs-h .dg-fs-v, .dg-fs.dg-fs-h .dg-fs-poster { width: 100%; } .dg-fs-info { left: calc(50% - min(50%, 31vh)); right: calc(50% - min(50%, 31vh) + 64px); } .dg-fs-mute { right: calc(50% - min(50%, 31vh) + 14px); } .dg-fs-prog { left: calc(50% - min(50%, 31vh)); right: calc(50% - min(50%, 31vh)); } }',
    ].join('\n');
    function injectCss() {
        const d = root.document;
        if (!d || d.getElementById('dg-feed-css')) return;
        const s = d.createElement('style');
        s.id = 'dg-feed-css';
        s.textContent = CSS;
        (d.head || d.documentElement).appendChild(s);
    }
    function status() {
        return { open: S.open, suspended: S.suspended, cur: S.cur, items: S.items.length, inst: Object.keys(S.inst).map(Number), mode: mode(), why: why(), mb: +(S.bytes / 1048576).toFixed(1), muted: S.muted, vert: S.vert, done: S.done };
    }
    return {
        feedUrl, orientOf, normItem, normFeed, netMode, netWhy, nativeBytes, NATIVE_BPS, hlsConfig, fitOf, fmtDur, SESSION_CAP, WINDOW_BEFORE, WINDOW_AFTER, contentWindow, tapZone, SEEN_KEY, HIST_KEY,
        open, close, suspend, resume, boot, status,
        isOpen: () => S.open && !S.suspended, suspended: () => S.open && S.suspended,
        _S: S, _setActive: setActive, _onIO: onIO, _click: onListClick, _onKey: onKey,
    };
});
