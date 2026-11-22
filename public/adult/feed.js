// [adult] p4 刷短片(window.dgAdultFeed):全屏竖向整屏翻页的短片流,地址栏只写 #/feed(不带任何作品信息)。
//   数据:GET /api/catalog/feed?cursor=&vert=1(服务器已按短片规则挑好:8–300 秒、竖屏优先、按家族轮换、审查类不进;每条再过一遍策略)。
//   播放:同时只有 1 个在放的 hls.js 实例(autoStartLoad:false,翻到 ≥60% 可见才建、清单到了才 startLoad),maxBufferLength 10;
//     静音自动播放、点一下开声音、循环;横屏片 object-fit: contain;地址走与播放页同一个去广告变换(DgAdult.playUrl:配了 Worker 就套,
//     没配直连);没有 MSE 的 iPhone 走原生 HLS。量到画面宽高后按 beacon 报方向(无痕时不报)。
//   流量:非计量网络本会话 300MB 封顶,之后改成「点一下才播」;省流量 / 2G·3G / 蜂窝(设置里没允许)一开始就是点一下才播。电视上不出。
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
    function feedUrl(cursor, vert) {
        const q = [];
        if (cursor) q.push('cursor=' + encodeURIComponent(String(cursor)));
        if (vert) q.push('vert=1');
        return '/api/catalog/feed' + (q.length ? '?' + q.join('&') : '');
    }
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
    // 'auto' = 滑到就静音自动播;'tap' = 点一下才播(省流量 / 慢网 / 蜂窝没允许 / 本会话流量用完)
    function netMode(conn, cellOk, bytes) {
        if ((Number(bytes) || 0) >= SESSION_CAP) return 'tap';
        const c = conn || null;
        if (!c) return 'auto';
        if (c.saveData) return 'tap';
        if (/(^|\b)(slow-2g|2g|3g)$/.test(String(c.effectiveType || ''))) return 'tap';
        if (c.type === 'cellular' && !cellOk) return 'tap';
        return 'auto';
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
    };
    function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } }
    function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, v); } catch (e) { } }
    function A() { return root.DgAdult || null; }
    // 隐私锁着(或 head 里的预锁还没解开):不建任何播放实例(不拉清单、不拉分片、预备的下一条也不建);解锁后当前这条点一下才播
    function locked() {
        try { const P = root.dgPrivacy; if (P && typeof P.locked === 'function' && P.locked()) return true; } catch (e) { }
        try { const de = root.document && root.document.documentElement; if (de && de.classList && de.classList.contains('dgp-prelock')) return true; } catch (e) { }
        return false;
    }
    function mode() {
        const a = A();
        let conn = null;
        try { conn = root.navigator && root.navigator.connection; } catch (e) { }
        return netMode(conn, !!(a && a.cellOk && a.cellOk()), S.bytes);
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
        bar.appendChild(x); bar.appendChild(t); bar.appendChild(lab);
        const list = h('div', 'dg-feed-list', { tabindex: '-1' });
        const note = h('div', 'dg-feed-note', { role: 'status' });
        note.hidden = true;
        wrap.appendChild(bar); wrap.appendChild(list); wrap.appendChild(note);
        list.addEventListener('click', onListClick);
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

    // ---- 数据 ----
    function loadMore() {
        if (!S.open || S.loading || S.done || S.err) return;
        S.loading = true;
        const gen = S.gen;
        const url = feedUrl(S.cursor, S.vert);
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const tm = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { } }, 15000) : 0;
        Promise.resolve(root.fetch(url, { credentials: 'same-origin', signal: ctl ? ctl.signal : undefined }))
            .then(r => (r && r.ok) ? r.json() : Promise.reject(new Error('HTTP ' + (r && r.status))))
            .then(d => {
                if (gen !== S.gen) return;
                const a = A();
                const p = normFeed(d, a && a.cardToItem, S.seen, S.vert);
                S.cursor = p.next; S.done = p.done;
                const from = S.items.length;
                p.items.forEach(it => { S.items.push(it); addSlide(S.items.length - 1); });
                if (!S.items.length) showNote(S.done ? '暂时没有可刷的短片' : '');
                else if (S.done) addEnd();
                if (from === 0 && S.items.length) { S.cur = -1; setActive(0); }
                else if (S.cur >= 0) renderWindow();
                // 这一页全被筛掉了但还有下一页 → 接着拉
                if (!p.items.length && !S.done) setTimeout(() => { if (gen === S.gen) loadMore(); }, 300);
            })
            .catch(() => { if (gen === S.gen) { S.err = true; showNote('加载失败，可能是网络不稳定', true); } })
            .then(() => { if (tm) clearTimeout(tm); if (gen === S.gen) S.loading = false; });
    }
    function reload() {
        destroyAll();
        S.gen++;
        S.items = []; S.seen = new Set(); S.cursor = ''; S.done = false; S.err = false; S.loading = false; S.cur = -1; S.ratio = new Map();
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
                hls.on(E.MANIFEST_PARSED, () => { x.parsed = true; if (x.want && !x.started) { x.started = true; try { hls.startLoad(0); } catch (e) { } } });
                hls.on(E.FRAG_LOADED, (_, d) => {
                    const n = (d && d.frag && d.frag.stats && (d.frag.stats.loaded || d.frag.stats.total)) || 0;
                    S.bytes += n;
                });
                hls.on(E.ERROR, (_, d) => { if (d && d.fatal) failInst(i); });
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
        bindVideo(i, x);
        if (start) startInst(x);
        return x;
    }
    function startInst(x) {
        x.want = true;
        if (x.hls && x.parsed && !x.started) { x.started = true; try { x.hls.startLoad(0); } catch (e) { } }
        if (x.native && !x.video.getAttribute('src')) { x.video.src = playUrl(x.line); try { x.video.load(); } catch (e) { } }
        x.video.muted = S.muted;
        playVideo(x.video);
    }
    function playVideo(v) {
        let p;
        try { p = v.play(); } catch (e) { return; }
        if (p && typeof p.catch === 'function') p.catch((err) => {
            // 带声音自动播被浏览器拦 → 退回静音再播
            if (err && err.name === 'NotAllowedError' && !v.muted) { S.muted = true; syncMute(); try { v.play().catch(() => { }); } catch (e) { } }
        });
    }
    function bindVideo(i, x) {
        if (x.bound) return;
        x.bound = true;
        const v = x.video, sl = S.slides[i];
        v.addEventListener('playing', () => { if (sl) sl.classList.add('dg-fs-on'); measure(i, x); });
        v.addEventListener('loadedmetadata', () => measure(i, x));
        v.addEventListener('error', () => { if (x.native) failInst(i); });
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
        x.hls = null; x.parsed = false; x.started = false;
        x.li++;
        if (x.li < it.lines.length) { makeInst(i, want); return; }
        delete S.inst[i];
        showMsg(i, '这条暂时放不了，往下滑看下一条');
    }
    function showMsg(i, text) {
        const sl = S.slides[i];
        const m = sl && sl.querySelector('.dg-fs-msg');
        if (m) { m.textContent = text; m.hidden = !text; }
        if (sl) { sl.classList.remove('dg-fs-on'); sl.classList.toggle('dg-fs-err', !!text); }
    }
    function teardown(x) {
        if (!x) return;
        if (x.hls) { try { x.hls.destroy(); } catch (e) { } }
        const v = x.video;
        if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { } }
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
        // 离开的那条(如果还是预备 / 在放)先停
        Object.keys(S.inst).forEach(k => { const n = +k; if (n !== i) { const x = S.inst[n]; if (x && x.video && !x.video.paused) { try { x.video.pause(); } catch (e) { } } } });
        activate(i);
        if (i >= S.items.length - MORE_AT) loadMore();
    }
    function activate(i) {
        if (!S.open || S.suspended) return;
        if (locked()) { S.lockHeld = true; destroyAll(); return; }
        const sl = S.slides[i];
        const tap = sl && sl.querySelector('.dg-fs-tap');
        const m = mode();
        const x0 = S.inst[i];
        if (m === 'tap' && !(x0 && x0.user)) { if (tap) tap.hidden = false; if (x0 && x0.video && !x0.video.paused) { try { x0.video.pause(); } catch (e) { } } return; }
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
        if (t.closest('.dg-fs-mute')) { S.muted = !S.muted; syncMute(); const x = S.inst[i]; if (x && x.video && x.video.paused && !S.muted) playVideo(x.video); return; }
        if (t.closest('.dg-fs-tap')) {
            if (i !== S.cur) return;
            const x = makeInst(i, true);
            if (x) x.user = true;
            const tap = sl.querySelector('.dg-fs-tap');
            if (tap) tap.hidden = true;
            return;
        }
        // 点画面:静音时 → 开声音;有声时 → 暂停 / 继续
        const x = S.inst[i];
        if (!x || !x.video) return;
        if (S.muted) { S.muted = false; syncMute(); if (x.video.paused) playVideo(x.video); return; }
        if (x.video.paused) playVideo(x.video); else { try { x.video.pause(); } catch (err) { } }
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
    function onKey(e) {
        if (!S.open || S.suspended) return;
        const k = e.key;
        if (k === 'Escape' || k === 'Esc') { e.preventDefault(); e.stopPropagation(); close(true); return; }
        if (k === 'ArrowDown' || k === 'PageDown' || k === 'j') { e.preventDefault(); e.stopPropagation(); step(1); return; }
        if (k === 'ArrowUp' || k === 'PageUp' || k === 'k') { e.preventDefault(); e.stopPropagation(); step(-1); return; }
        if (k === 'm') { S.muted = !S.muted; syncMute(); return; }
        if (k === ' ') {
            const x = S.inst[S.cur];
            if (x && x.video) { e.preventDefault(); if (x.video.paused) playVideo(x.video); else x.video.pause(); }
        }
    }
    function onVis() {
        if (!S.open || S.suspended) return;
        const x = S.inst[S.cur];
        if (root.document.hidden) { if (x && x.video) { try { x.video.pause(); } catch (e) { } } }
        else if (x && x.video && x.want && !locked()) playVideo(x.video);
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
        '.dg-feed { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 3000; background: #000; color: #fff; display: flex; flex-direction: column; }',
        '.dg-feed-bar { position: absolute; top: 0; left: 0; right: 0; z-index: 3; display: flex; align-items: center; gap: 12px; padding: 10px 16px; padding-top: calc(10px + env(safe-area-inset-top, 0px)); background: linear-gradient(to bottom, rgba(0,0,0,.7), transparent); pointer-events: none; }',
        '.dg-feed-bar > * { pointer-events: auto; }',
        '.dg-feed-x { width: 38px; height: 38px; border-radius: 50%; border: 0; background: rgba(0,0,0,.45); color: #fff; font-size: 16px; cursor: pointer; }',
        '.dg-feed-t { flex: 1; font-size: 16px; }',
        '.dg-feed-vert { display: inline-flex; align-items: center; gap: 4px; margin: 0; font-size: 13px; background: rgba(0,0,0,.45); border-radius: 15px; padding: 4px 10px; cursor: pointer; }',
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
        '.dg-fs-tap { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 8px; border: 0; background: rgba(0,0,0,.5); color: #fff; border-radius: 16px; padding: 16px 22px; font-size: 14px; cursor: pointer; }',
        '.dg-fs-tap i { font-size: 30px; }',
        '.dg-fs-info { position: absolute; left: 0; right: 64px; bottom: 0; z-index: 2; padding: 16px; padding-bottom: calc(22px + env(safe-area-inset-bottom, 0px)); background: linear-gradient(to top, rgba(0,0,0,.75), transparent); }',
        '.dg-fs-title { display: block; max-width: 100%; background: none; border: 0; padding: 0; color: #fff; font-size: 15px; font-weight: 600; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }',
        '.dg-fs-title:hover, .dg-fs-title:focus { text-decoration: underline; text-underline-offset: 3px; outline: none; }',
        '.dg-fs-sub { margin-top: 4px; color: #ccc; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dg-fs-mute { position: absolute; right: 14px; bottom: calc(26px + env(safe-area-inset-bottom, 0px)); z-index: 2; width: 44px; height: 44px; border-radius: 50%; border: 0; background: rgba(0,0,0,.5); color: #fff; font-size: 18px; cursor: pointer; }',
        '.dg-fs-msg { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 2; background: rgba(0,0,0,.7); border-radius: 10px; padding: 10px 16px; font-size: 13px; color: #ddd; }',
        '.dg-fs-end { height: 64px; display: flex; align-items: center; justify-content: center; color: #777; font-size: 13px; scroll-snap-align: end; }',
        '.dg-feed-note { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 4; text-align: center; color: #ccc; font-size: 14px; }',
        '.dg-feed-retry { margin-left: 10px; border: 1px solid #666; background: transparent; color: #fff; border-radius: 14px; padding: 3px 12px; cursor: pointer; }',
        '@media (min-width: 769px) { .dg-fs-poster, .dg-fs-v { left: 50%; width: min(100%, 62vh); transform: translateX(-50%); } .dg-fs.dg-fs-h .dg-fs-v, .dg-fs.dg-fs-h .dg-fs-poster { width: 100%; } .dg-fs-info { left: calc(50% - min(50%, 31vh)); right: calc(50% - min(50%, 31vh) + 64px); } .dg-fs-mute { right: calc(50% - min(50%, 31vh) + 14px); } }',
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
        return { open: S.open, suspended: S.suspended, cur: S.cur, items: S.items.length, inst: Object.keys(S.inst).map(Number), mode: mode(), mb: +(S.bytes / 1048576).toFixed(1), muted: S.muted, vert: S.vert, done: S.done };
    }
    return {
        feedUrl, orientOf, normItem, normFeed, netMode, hlsConfig, fitOf, fmtDur, SESSION_CAP, WINDOW_BEFORE, WINDOW_AFTER,
        open, close, suspend, resume, boot, status,
        isOpen: () => S.open && !S.suspended, suspended: () => S.open && S.suspended,
        _S: S, _setActive: setActive, _onIO: onIO, _click: onListClick,
    };
});
