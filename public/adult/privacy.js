// [adult] 本机隐私(window.dgPrivacy):老板键 / 无痕模式 / PIN 锁 / 标签页伪装 / 一键清除本机记录。
//   全部只作用于这台设备的这个浏览器(或 App),设置存 localStorage(dgp_*,读写都 try/catch;没有存储照样能用,只是不记住)。
//   ① 老板键:桌面默认「`」(可改 连按两次 Esc / F9 / 关);触屏可选 三指轻点 / 可拖动的小悬浮按钮(都默认关)。
//      按下:所有 <video>/<audio> 暂停 + 静音(记住原状态)、退出全屏/画中画、整页盖成空白文档或假搜索页、标签页标题和图标换掉;
//      再按一次恢复(设了 PIN 则要输 PIN)。可选「切走自动暂停」。
//   ② 无痕:dgAdultHooks.onHistoryWrite 一律否决(历史/进度/观看统计),下面 INCOG_KEYS 列的本机键一律不写(Storage.setItem 拦截),
//      观看统计 / 线路反馈 / 热度 / 历史推送的 POST 一律不发(fetch / sendBeacon 拦截);角落一直显示「无痕」小标。
//      删除不拦:继续观看列表「只删不加」的改写照常落地(写的是存着的条目去掉被删的)、只带删除墓碑的历史推送照常发。
//      关掉无痕 = 刷新页面(刷新前照无痕拦着):app 内存里无痕期间的记录(线路分辨率表等)不会在下一次正常写时整份落地。
//   ③ PIN 锁:4–6 位数字,PBKDF2-SHA256(WebCrypto,15 万次,16 字节随机盐),逐字节常量时间比较;打开站点 / 闲置 N 分钟(正在播放不算,循环播放的短片 / 预览不算播放)/
//      从后台回来超过 1 分钟时锁上;锁屏盖住一切、暂停媒体、标签页伪装;连错 5 次后等 30s,之后每错一次翻倍(最多 1 小时);
//      忘记 PIN = 本机完全重置(退出登录 + 清空本机数据和离线下载)。只是本机遮挡,不是账号安全(界面上写明)。
//   ④ 标签页伪装:文档 / 搜索 / 邮箱 / 自定义标题,中性内联 SVG 图标;开着时站内改 document.title 会被盖回去(MutationObserver,不轮询)。
//   ⑤ 设置:dgAdultHooks.onSettingsRender(container) 往容器里放「隐私」一节(纯 DOM,不依赖 Vue)。
// 纯函数部分在 node 里可直接 require(scripts/adult-privacy-test.mjs);只有浏览器里(有 document)才 boot。
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && typeof root === 'object' && root.document && root.document.documentElement && !root.__dgPrivacyNoBoot) {
        try { root.dgPrivacy = api.pub; } catch (e) { }
        try { api.boot(); } catch (e) { try { console.error('[privacy] boot 失败', e); } catch (_) { } }
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
    'use strict';
    const VERSION = 1;
    const doc = (root && root.document) || null;

    // ---------- 常量 ----------
    const LS_SET = 'dgp_settings', LS_PIN = 'dgp_pin', LS_FAIL = 'dgp_pin_fail';
    const PBKDF2_IT = 150000, SALT_LEN = 16, KEY_BITS = 256;
    const FREE_TRIES = 5, LOCK_BASE_MS = 30e3, LOCK_MAX_MS = 3600e3;
    const BG_LOCK_MS = 60e3;            // 从后台回来:离开 ≥ 1 分钟就锁
    const ESC2_MS = 400;                // 连按两次 Esc 的间隔
    const IDLE_OPTS = [1, 5, 15, 30];
    const BOSS_KEYS = ['backquote', 'esc2', 'f9', 'off'];
    const COVERS = ['doc', 'search'];
    const PRESETS = ['doc', 'search', 'mail', 'custom'];
    const DEFAULTS = Object.freeze({
        bossKey: 'backquote', cover: 'doc', touch3: false, fab: false, fabPos: null, autoPause: false,
        incognito: false, disguise: false, preset: 'doc', customTitle: '', idleMin: 5, secure: true,
    });
    // 无痕时这些本机键一律不写(一键清除也删它们)。别的模块的新键:dgPrivacy.registerKeys({ keys, prefixes })
    const INCOG_KEYS = [
        'donggua_watch_history',   // 观看历史 / 继续观看
        'donggua_hist_synced',     // 历史增量同步的「服务器已确认」
        'donggua_watch_pending',   // 观看时长统计待发批次(带片名)
        'donggua_live_recent',     // 最近看的直播频道
        'donggua_fav_cache',       // 同步用户的收藏缓存
        'donggua_src_res',         // 线路实测分辨率(站点|vod_id)
        'donggua_dm_offset', 'donggua_dm_auto',   // 按集的弹幕偏移
        'donggua_rec_cache', 'donggua_tmdb_title',
        'dg_wk_tags',              // 「猜你喜欢」的本机种子(看过的作品键)
        'dg_bc_sent',              // 线路反馈去重(sessionStorage,带作品键)
        'dgx_heat_sent', 'dgx_heat_pend',   // 热度条(adult/player-x.js):今天已报过的作品键 / 切后台时存的待发一份(带作品键)
        'dg_pv_plan',              // 封面悬停预览(adult/preview.js)按作品缓存的拼剪清单(sessionStorage,带作品键)
        'donggua_site_srv_pending',   // 「只有服务器能通」的待确认表(站点 key + 刚测的 vod_id = 刚打开的是哪一部)
        'donggua_adcut_plan',      // 去插播的剪切计划缓存(站点 + 本集分片指纹)
    ];
    const INCOG_PREFIXES = ['donggua_progress_', 'donggua_afp|', 'donggua_afpop|', 'donggua_afpenv|'];
    // 一键清除额外删的(无痕不拦:删除墓碑 / 试看计时 / 热门缓存 —— 拦了会让删除失效或绕过试看)
    const CLEAR_EXTRA = ['donggua_history_deleted', 'donggua_trial', 'donggua_fav_tmdb', 'donggua_popular_cache', 'donggua_popular_cache2', 'donggua_popular_cache3', 'donggua_share_ref', 'donggua_resume_diag',
        'dgx_dev'];   // 热度上报的随机设备号:清除后换一个(之前的上报和以后的连不起来);无痕时 player-x 本来就不生成它
    // 无痕时不发的同源 POST(观看统计 / 线路反馈 / 热度 / 历史推送)
    const NET_BLOCK = ['/api/history/push', '/api/stats/watch', '/api/catalog/beacon', '/api/catalog/heat'];
    const TITLES = { doc: '无标题文档', search: '搜索', mail: '收件箱' };

    // 中性图标(不仿任何真实产品)
    const svgUri = (s) => 'data:image/svg+xml,' + encodeURIComponent(s);
    const SVG = {
        doc: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M8 3h11l7 7v19H8z" fill="#fff" stroke="#80868b" stroke-width="1.6"/><path d="M19 3v7h7" fill="#e8eaed" stroke="#80868b" stroke-width="1.6"/><path d="M11.5 15h11M11.5 19h11M11.5 23h7" stroke="#6b8fc7" stroke-width="1.8"/></svg>',
        search: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="13.5" cy="13.5" r="8" fill="#fff" stroke="#5f6368" stroke-width="3"/><path d="M19.5 19.5l8 8" stroke="#5f6368" stroke-width="3.4" stroke-linecap="round"/></svg>',
        mail: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="7" width="26" height="18" rx="2.5" fill="#fff" stroke="#5f6368" stroke-width="1.8"/><path d="M4 9l12 9 12-9" fill="none" stroke="#5f6368" stroke-width="1.8"/></svg>',
        lock: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect x="9" y="21" width="30" height="21" rx="4" fill="none" stroke="#c8c8cc" stroke-width="3"/><path d="M16 21v-6a8 8 0 0 1 16 0v6" fill="none" stroke="#c8c8cc" stroke-width="3"/><circle cx="24" cy="31" r="3" fill="#c8c8cc"/></svg>',
        eyeOff: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#e8e8e8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.4 3.5M6.5 6.6C4.4 8 2.9 10.1 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.5 4.8-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
    };
    const ICONS = { doc: svgUri(SVG.doc), search: svgUri(SVG.search), mail: svgUri(SVG.mail) };

    // ---------- 状态 ----------
    const S = {
        booted: false, set: Object.assign({}, DEFAULTS),
        cover: null,              // null | 'boss' | 'lock'
        coverEl: null, layer: null, fab: null, badge: null,
        media: new Map(),         // 盖着期间:元素 → { playing, muted }
        lastFocus: null, disg: false, want: null, realTitle: null, headMo: null, bodyMo: null,
        subs: new Set(), hosts: [], ui: { form: '', clear: 0, clearOpts: null, msg: '', msgErr: false, busy: false },
        lastActive: 0, idleT: 0, hiddenAt: 0, lastEsc: 0, purge: '', selfWrite: false,
        failMem: null, extraKeys: new Set(), extraPrefixes: [], hooked: null, lockTick: 0, longT: 0,
        t3: { start: 0, cx: 0, cy: 0 },
    };
    const now = () => Date.now();

    // ---------- 存储 ----------
    function store(kind) { try { return kind === 's' ? root.sessionStorage : root.localStorage; } catch (e) { return null; } }
    function lsGet(k) { try { const s = store('l'); return s ? s.getItem(k) : null; } catch (e) { return null; } }
    function lsSet(k, v) {
        S.selfWrite = true;
        try { const s = store('l'); if (!s) return false; s.setItem(k, v); return true; }
        catch (e) { return false; }
        finally { S.selfWrite = false; }
    }
    function lsDel(k) { try { const s = store('l'); if (s) s.removeItem(k); } catch (e) { } }
    const pick = (v, list, d) => (list.indexOf(v) >= 0 ? v : d);
    function cleanTitle(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }
    function normSettings(o) {
        const x = (o && typeof o === 'object') ? o : {};
        const d = DEFAULTS;
        const fp = x.fabPos && typeof x.fabPos === 'object' && Number.isFinite(x.fabPos.x) && Number.isFinite(x.fabPos.y)
            ? { x: Math.min(1, Math.max(0, x.fabPos.x)), y: Math.min(1, Math.max(0, x.fabPos.y)) } : null;
        return {
            bossKey: pick(x.bossKey, BOSS_KEYS, d.bossKey), cover: pick(x.cover, COVERS, d.cover),
            touch3: x.touch3 === true, fab: x.fab === true, fabPos: fp, autoPause: x.autoPause === true,
            incognito: x.incognito === true, disguise: x.disguise === true, preset: pick(x.preset, PRESETS, d.preset),
            customTitle: cleanTitle(x.customTitle), idleMin: IDLE_OPTS.indexOf(Number(x.idleMin)) >= 0 ? Number(x.idleMin) : d.idleMin,
            secure: x.secure !== false,
        };
    }
    function loadSettings() { let o = null; try { o = JSON.parse(lsGet(LS_SET) || 'null'); } catch (e) { } return normSettings(o); }
    function saveSettings() { lsSet(LS_SET, JSON.stringify(S.set)); }

    function isBlockedKey(k) {
        k = String(k);
        if (INCOG_KEYS.indexOf(k) >= 0 || S.extraKeys.has(k)) return true;
        for (const p of INCOG_PREFIXES) if (k.indexOf(p) === 0) return true;
        for (const p of S.extraPrefixes) if (k.indexOf(p) === 0) return true;
        return false;
    }
    function isClearKey(k) { return isBlockedKey(k) || CLEAR_EXTRA.indexOf(String(k)) >= 0; }
    // 这次写要不要拦:无痕 → 拦 INCOG 键;正在清除 → 拦 INCOG 键和一键清除额外删的键(清完要刷新,这期间 app 的卸载保存 / 推送 /
    //   晚到的历史拉取会把内存里的旧记录、删除墓碑(片名)写回去);刚关掉无痕(S.purge='incog',等刷新)→ 跟无痕一样拦;完全重置 → 全拦
    function writeBlocked(k) {
        if (S.selfWrite) return false;
        if (S.purge === 'all') return true;
        if (S.purge === 'keys') return isClearKey(k);
        if (!S.purge && !S.set.incognito) return false;
        return isBlockedKey(k);
    }
    // 无痕时「只删不加」的写照常落地:删除记录永远不该被无痕挡住(继续观看里删一条、过期清理)。
    //   只认这些列表键;新列表里每一条(按 id 字段)都已经在存着的列表里、且比它少 → 写进去的是「存着的列表去掉被删的那几条」,
    //   条目内容一律用存着的原样(内存里无痕期间改过的进度等一个字节都不落地);有一条是存着的列表里没有的 → 整次照旧拦掉
    const SHRINK_KEYS = Object.freeze({ donggua_watch_history: 'name' });
    function shrinkOnly(stored, next, idKey) {
        let a, b;
        try { a = JSON.parse(stored); b = JSON.parse(next); } catch (e) { return null; }
        if (!Array.isArray(a) || !Array.isArray(b) || b.length >= a.length) return null;
        const id = (x) => (x && typeof x === 'object' && typeof x[idKey] === 'string' && x[idKey]) ? x[idKey] : null;
        const have = new Set(a.map(id)), keep = new Set();
        for (const x of b) { const i = id(x); if (i == null || !have.has(i)) return null; keep.add(i); }
        const out = a.filter(x => keep.has(id(x)));
        return out.length < a.length ? JSON.stringify(out) : null;
    }
    function shrinkWrite(st, orig, k, v) {
        if (S.purge === 'all' || S.purge === 'keys') return;   // 清除 / 重置中:什么都不写
        const idKey = Object.prototype.hasOwnProperty.call(SHRINK_KEYS, String(k)) ? SHRINK_KEYS[String(k)] : null;
        if (!idKey || !st || typeof st.getItem !== 'function') return;
        const cur = st.getItem(k);
        if (cur == null) return;
        const out = shrinkOnly(cur, String(v), idKey);
        if (out != null) orig.call(st, k, out);
    }
    function installStorageGuard() {
        const wrap = (orig) => {
            const f = function (k, v) {
                let blocked = false;
                try { blocked = writeBlocked(k); } catch (e) { }
                if (blocked) { try { shrinkWrite(this, orig, k, v); } catch (e) { } return undefined; }
                return orig.apply(this, arguments);
            };
            f.__dgp = true;
            return f;
        };
        const SP = root.Storage && root.Storage.prototype;
        if (SP && typeof SP.setItem === 'function') { if (!SP.setItem.__dgp) SP.setItem = wrap(SP.setItem); return; }
        ['l', 's'].forEach(kind => { const s = store(kind); if (s && typeof s.setItem === 'function' && !s.setItem.__dgp) { try { s.setItem = wrap(s.setItem); } catch (e) { } } });
    }

    // ---------- 网络:无痕 / 清除中不发统计、反馈、热度、历史推送 ----------
    // 返回 0 = 放行;否则 = 假回包的状态码(历史推送回 503:app 当失败、不记「已确认」;其余 204 = 当发过了丢掉)
    //   例外:无痕时只带删除墓碑、一条观看条目都不带的历史推送照常发(删除记录不该被无痕挡住;墓碑里的片名是无痕之前就在历史里的)。
    //   清除中 / 刚关无痕等刷新(S.purge)不放:清完云端再推墓碑会把删过的片名又写回服务器
    function deletionOnlyPush(body) {
        if (S.purge || !S.set.incognito || typeof body !== 'string' || body.length > 262144) return false;
        let j = null;
        try { j = JSON.parse(body); } catch (e) { return false; }
        return !!j && typeof j === 'object' && Array.isArray(j.history) && j.history.length === 0 && Array.isArray(j.deleted) && j.deleted.length > 0;
    }
    function blocksRequest(url, method, body) {
        if (!S.purge && !S.set.incognito) return 0;
        const m = String(method || 'GET').toUpperCase();
        if (m === 'GET' || m === 'HEAD') return 0;
        let p = '';
        try {
            const base = (root.location && root.location.href) || 'http://localhost/';
            const u = new URL(String(url), base);
            const origin = root.location && root.location.origin;
            if (origin && u.origin !== origin) return 0;
            p = u.pathname;
        } catch (e) { return 0; }
        for (const b of NET_BLOCK) {
            if (!(p === b || p.indexOf(b + '/') === 0)) continue;
            if (b !== '/api/history/push') return 204;
            return (p === b && deletionOnlyPush(body)) ? 0 : 503;
        }
        return 0;
    }
    function fakeResponse(status) {
        try { if (typeof root.Response === 'function') return new root.Response(null, { status }); } catch (e) { }
        return { ok: status < 300, status, headers: { get: () => null }, json: () => Promise.resolve({}), text: () => Promise.resolve(''), clone() { return this; } };
    }
    function installNetGuard() {
        const of = root.fetch;
        if (typeof of === 'function' && !of.__dgp) {
            const f = function (input, init) {
                try {
                    const url = (input && typeof input === 'object' && 'url' in input) ? input.url : input;
                    const method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
                    const st = blocksRequest(url, method, init && init.body);
                    if (st) return Promise.resolve(fakeResponse(st));
                } catch (e) { }
                return of.apply(root, arguments);
            };
            f.__dgp = true;
            S.origFetch = of;
            root.fetch = f;
        }
        const nav = root.navigator;
        if (nav && typeof nav.sendBeacon === 'function' && !nav.sendBeacon.__dgp) {
            const ob = nav.sendBeacon;
            const sb = function (url) { try { if (blocksRequest(url, 'POST')) return true; } catch (e) { } return ob.apply(nav, arguments); };
            sb.__dgp = true;
            try { nav.sendBeacon = sb; } catch (e) { }
        }
    }
    // adult.js 的线路反馈直接用它自己存的原生 fetch(绕过上面的包装)→ 在 send 上再挡一层
    function patchAdultBeacon() {
        const A = root.DgAdult, b = A && A.beacon;
        if (!b || typeof b.send !== 'function' || b.send.__dgp) return;
        const orig = b.send;
        const w = function () { if (S.set.incognito || S.purge) return false; return orig.apply(this, arguments); };
        w.__dgp = true;
        try { b.send = w; } catch (e) { }
    }
    function vetoHistory() { return (S.set.incognito || S.purge) ? false : undefined; }

    // ---------- 钩子 ----------
    function attachHooks() {
        let H = null;
        try { H = root.dgAdultHooks; } catch (e) { }
        if (!H || typeof H !== 'object') {
            // adult.js 没加载(或顺序意外):先放一个普通对象,adult.js 装上时会把里面的函数合并过去
            H = { onHistoryWrite: vetoHistory, onSettingsRender: renderSettings };
            try { root.dgAdultHooks = H; } catch (e) { }
            S.hooked = H;
            return;
        }
        if (S.hooked === H) return;
        S.hooked = H;
        if (typeof H.add === 'function') { H.add('onHistoryWrite', vetoHistory); H.add('onSettingsRender', renderSettings); }
        else { H.onHistoryWrite = chain(H.onHistoryWrite, vetoHistory); H.onSettingsRender = chain(H.onSettingsRender, renderSettings); }
    }
    function chain(prev, fn) {
        if (typeof prev !== 'function') return fn;
        return function () {
            let a, b;
            try { a = prev.apply(this, arguments); } catch (e) { }
            try { b = fn.apply(this, arguments); } catch (e) { }
            return (a === false || b === false) ? false : (b !== undefined ? b : a);
        };
    }

    // ---------- 订阅 ----------
    function state() { return { incognito: !!S.set.incognito, locked: !!S.cover, cover: S.cover, pin: hasPin(), disguise: !!S.disg }; }
    function emit() {
        const st = state();
        S.subs.forEach(fn => { try { fn(st); } catch (e) { } });
        refreshHosts();
    }

    // ---------- DOM 小工具 ----------
    function h(tag, attrs, kids) {
        const el = doc.createElement(tag);
        if (attrs) {
            for (const k of Object.keys(attrs)) {
                const v = attrs[k];
                if (v == null || v === false) continue;
                if (k === 'class') el.className = v;
                else if (k === 'text') el.textContent = String(v);
                else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
                else if (k === 'value') el.value = String(v);
                else if (k === 'checked' || k === 'disabled') el[k] = !!v;
                else el.setAttribute(k, v === true ? '' : String(v));
            }
        }
        if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach(c => { if (c == null || c === false) return; el.appendChild(typeof c === 'object' ? c : doc.createTextNode(String(c))); });
        return el;
    }
    function htmlClass(name, on) {
        try { const cl = doc.documentElement.classList; if (on) cl.add(name); else cl.remove(name); } catch (e) { }
    }
    const connected = (el) => !!el && (el.isConnected === true || (el.isConnected === undefined && !!el.parentNode));
    function isMedia(el) { const t = el && el.tagName ? String(el.tagName).toUpperCase() : ''; return t === 'VIDEO' || t === 'AUDIO'; }
    function isEditable(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        const t = el.tagName ? String(el.tagName).toUpperCase() : '';
        if (t === 'TEXTAREA' || t === 'SELECT') return true;
        if (t !== 'INPUT') return false;
        const ty = String(el.type || (el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
        return ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].indexOf(ty) < 0;
    }

    // ---------- 样式 ----------
    const CSS = [
        'html.dgp-covered, html.dgp-covered body { overflow: hidden !important; }',
        // 盖着 / 预锁(head 里的内联片段)/ 切到后台(设了 PIN):页面其余部分一律不可见、不可聚焦、点不到
        'html.dgp-covered body > *:not(.dgp-layer), html.dgp-prelock body > *:not(.dgp-layer), html.dgp-hide body > *:not(.dgp-layer) { visibility: hidden !important; }',
        '.dgp-layer { position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; visibility: visible !important; }',
        '.dgp-layer [hidden] { display: none !important; }',
        '.dgp-cover { position: fixed; top: 0; left: 0; right: 0; bottom: 0; overflow: auto; box-sizing: border-box; -webkit-user-select: none; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-tap-highlight-color: transparent; }',
        '.dgp-cover:focus { outline: none; }',
        // 空白文档
        '.dgp-doc { background: #f1f3f4; color: #202124; }',
        '.dgp-doc-bar { height: 56px; background: #fff; border-bottom: 1px solid #dadce0; display: flex; align-items: center; gap: 12px; padding: 0 16px; box-sizing: border-box; }',
        '.dgp-doc-ic { flex: none; width: 26px; height: 26px; background: url("' + ICONS.doc + '") center / contain no-repeat; }',
        '.dgp-doc-name { font-size: 16px; color: #202124; white-space: nowrap; }',
        '.dgp-doc-tools { flex: 1; display: flex; gap: 10px; overflow: hidden; padding-left: 12px; }',
        '.dgp-ph { flex: none; width: 44px; height: 10px; border-radius: 5px; background: #e8eaed; }',
        '.dgp-doc-page { width: 816px; max-width: calc(100% - 32px); min-height: calc(100% - 104px); margin: 24px auto; background: #fff; box-shadow: 0 1px 3px rgba(60, 64, 67, .3); }',
        // 假搜索页
        '.dgp-search { background: #fff; color: #202124; display: flex; flex-direction: column; align-items: center; padding-top: 24vh; }',
        '.dgp-search-box { width: 584px; max-width: calc(100% - 32px); height: 46px; border: 1px solid #dfe1e5; border-radius: 24px; display: flex; align-items: center; gap: 10px; padding: 0 16px; box-sizing: border-box; background: #fff; }',
        '.dgp-search-ic { flex: none; width: 18px; height: 18px; background: url("' + ICONS.search + '") center / contain no-repeat; opacity: .7; }',
        '.dgp-search-box input { flex: 1; min-width: 0; border: 0; outline: 0; font-size: 16px; background: transparent; color: #202124; -webkit-user-select: text; user-select: text; }',
        // 锁屏
        '.dgp-lock { background: #0e0e10; color: #e6e6e6; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }',
        '.dgp-lock-card { width: 100%; max-width: 340px; text-align: center; margin: auto; }',
        '.dgp-lock-ic { width: 56px; height: 56px; margin: 0 auto 14px; background: url("' + svgUri(SVG.lock) + '") center / contain no-repeat; }',
        '.dgp-lock h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; color: #fff; }',
        '.dgp-lock p { font-size: 13px; color: #a0a0a6; margin: 0 0 16px; line-height: 1.6; }',
        '.dgp-lock form { display: flex; flex-direction: column; gap: 12px; }',
        '.dgp-pin { width: 100%; height: 50px; font-size: 22px; letter-spacing: .4em; text-align: center; border-radius: 10px; border: 1px solid #3a3a3e; background: #1b1b1f; color: #fff; box-sizing: border-box; -webkit-user-select: text; user-select: text; }',
        '.dgp-pin:focus, .dgp-btn:focus-visible, .dgp-link:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }',
        '.dgp-pin:disabled { opacity: .5; }',
        '.dgp-btn { min-height: 46px; padding: 0 20px; border-radius: 23px; border: 1px solid #45454b; background: #26262b; color: #eee; font-size: 15px; cursor: pointer; }',
        '.dgp-btn-pri { background: #e8e8ea; border-color: transparent; color: #111; font-weight: 600; }',
        '.dgp-btn-danger { background: #5a1f1f; border-color: #7a2b2b; color: #ffd7d7; }',
        '.dgp-btn:disabled { opacity: .5; cursor: default; }',
        '.dgp-err { min-height: 20px; color: #ff9b91; font-size: 13px; margin: 2px 0 0; }',
        '.dgp-link { background: none; border: 0; color: #a0a0a6; text-decoration: underline; font-size: 13px; cursor: pointer; margin-top: 12px; padding: 8px; }',
        '.dgp-help { font-size: 12px !important; color: #74747a !important; margin-top: 18px !important; }',
        '.dgp-confirm { text-align: left; background: #18181c; border: 1px solid #333; border-radius: 12px; padding: 14px; margin-top: 12px; }',
        '.dgp-confirm p { color: #d0d0d4; margin-bottom: 12px; }',
        '.dgp-row-btns { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }',
        // 悬浮按钮 / 无痕小标
        '.dgp-fab { position: fixed; width: 44px; height: 44px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, .2); background: rgba(20, 20, 20, .72) url("' + svgUri(SVG.eyeOff) + '") center / 22px no-repeat; box-shadow: 0 2px 8px rgba(0, 0, 0, .45); touch-action: none; cursor: pointer; padding: 0; }',
        '.dgp-fab:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }',
        '.dgp-badge { position: fixed; left: 8px; bottom: 8px; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); padding: 2px 8px 2px 22px; border-radius: 10px; background: rgba(20, 20, 20, .8) url("' + svgUri(SVG.eyeOff) + '") 6px center / 12px no-repeat; color: #ddd; font-size: 11px; line-height: 16px; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }',
        // 设置
        '.dgp-set .dgp-sel { background: #1f1f1f; color: #eee; border: 1px solid rgba(255, 255, 255, .18); border-radius: 8px; padding: 6px 8px; font-size: 13px; max-width: 170px; flex: none; }',
        '.dgp-set .dgp-sbtn { padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, .18); background: rgba(255, 255, 255, .06); color: #ddd; font-size: 13px; cursor: pointer; margin: 8px 8px 0 0; }',
        '.dgp-set .dgp-sbtn:disabled { opacity: .45; cursor: default; }',
        '.dgp-set .dgp-sbtn.danger { color: #ff9b91; border-color: rgba(255, 107, 107, .45); }',
        '.dgp-set .dgp-in { width: 150px; background: #141414; color: #fff; border: 1px solid rgba(255, 255, 255, .22); border-radius: 8px; padding: 6px 10px; font-size: 14px; }',
        '.dgp-set .dgp-in-wide { width: 100%; max-width: 260px; }',
        '.dgp-set .dgp-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }',
        '.dgp-set .dgp-msg { min-height: 18px; font-size: 12px; color: #46d369; padding-top: 8px; }',
        '.dgp-set .dgp-msg.err { color: #ff9b91; }',
        '.dgp-set .dgp-chk { display: flex; gap: 8px; align-items: center; font-size: 13px; color: #ccc; margin-top: 8px; cursor: pointer; }',
        '.dgp-set .dgp-warn { color: #ffb74d; font-size: 12px; margin-top: 8px; line-height: 1.5; }',
        '.dgp-set .dgp-sub { color: #fff; font-size: 13px; font-weight: 600; margin-top: 4px; }',
    ].join('\n');
    function ensureCss() {
        if (!doc || S.css) return;
        try {
            const st = doc.createElement('style');
            st.setAttribute('id', 'dgp-css');
            st.textContent = CSS;
            (doc.head || doc.documentElement).appendChild(st);
            S.css = st;
        } catch (e) { }
    }
    function ensureLayer() {
        if (!doc || !doc.body) return null;
        if (S.layer && S.layer.parentNode) return S.layer;
        ensureCss();
        S.layer = h('div', { class: 'dgp-layer' });
        doc.body.appendChild(S.layer);
        return S.layer;
    }

    // ---------- 标签页伪装 ----------
    function disguiseOf(p) {
        p = pick(p, PRESETS, 'doc');
        if (p === 'custom') return { title: cleanTitle(S.set.customTitle) || TITLES.doc, icon: ICONS.doc };
        return { title: TITLES[p], icon: ICONS[p] };
    }
    function effectiveDisguise() {
        if (S.set.disguise) return disguiseOf(S.set.preset);
        if (S.cover === 'boss' && S.set.cover === 'search') return disguiseOf('search');
        if (S.cover) return disguiseOf('doc');
        return null;
    }
    function iconLinks() { try { return Array.from(doc.querySelectorAll('link[rel~="icon"]')); } catch (e) { return []; } }
    function applyIcons(icon) {
        const links = iconLinks();
        if (!links.length && doc.head) {
            const l = h('link', { rel: 'icon', type: 'image/svg+xml', href: icon, 'data-dgp-own': '1' });
            doc.head.appendChild(l);
            return;
        }
        const ours = (v) => Object.keys(ICONS).some(k => ICONS[k] === v);
        links.forEach(l => {
            if (l.hasAttribute('data-dgp-own')) { if (l.getAttribute('href') !== icon) l.setAttribute('href', icon); return; }
            const cur = l.getAttribute('href') || '';
            if (!l.hasAttribute('data-dgp-href')) {
                l.setAttribute('data-dgp-href', cur);
                l.setAttribute('data-dgp-type', l.getAttribute('type') || '');
            } else if (cur !== icon && !ours(cur)) {
                l.setAttribute('data-dgp-href', cur);   // 伪装期间 app 自己换了图标:关伪装时恢复成它最后设的
                l.setAttribute('data-dgp-type', '');     //  (type 不知道,恢复时去掉让浏览器自己认)
            }
            if (l.getAttribute('href') !== icon) l.setAttribute('href', icon);
            if (l.getAttribute('type') !== 'image/svg+xml') l.setAttribute('type', 'image/svg+xml');
        });
    }
    function restoreIcons() {
        iconLinks().forEach(l => {
            if (l.hasAttribute('data-dgp-own')) { if (l.parentNode) l.parentNode.removeChild(l); return; }
            if (!l.hasAttribute('data-dgp-href')) return;
            const href = l.getAttribute('data-dgp-href'), type = l.getAttribute('data-dgp-type');
            if (href) l.setAttribute('href', href); else l.removeAttribute('href');
            if (type) l.setAttribute('type', type); else l.removeAttribute('type');
            l.removeAttribute('data-dgp-href'); l.removeAttribute('data-dgp-type');
        });
    }
    // 站内改了标题 / 换了图标 → 记下真标题,再盖回伪装(MutationObserver 回调在微任务里,标签栏来不及显示真标题)
    function onHeadMutate() {
        if (!S.want) return;
        const t = doc.title;
        if (t !== S.want.title) { S.realTitle = t; doc.title = S.want.title; }
        applyIcons(S.want.icon);
    }
    function observeHead(on) {
        if (!on) { if (S.headMo) { try { S.headMo.disconnect(); } catch (e) { } S.headMo = null; } return; }
        if (S.headMo || typeof root.MutationObserver !== 'function' || !doc.head) return;
        S.headMo = new root.MutationObserver(onHeadMutate);
        S.headMo.observe(doc.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href', 'rel'] });
    }
    function applyDisguise() {
        if (!doc) return;
        const want = effectiveDisguise();
        if (want) {
            if (!S.disg) { S.disg = true; S.realTitle = doc.title; }
            S.want = want;
            if (doc.title !== want.title) doc.title = want.title;
            applyIcons(want.icon);
            observeHead(true);
        } else if (S.disg) {
            S.disg = false; S.want = null;
            observeHead(false);
            if (S.realTitle != null && doc.title !== S.realTitle) doc.title = S.realTitle;
            S.realTitle = null;
            restoreIcons();
        }
    }

    // ---------- 媒体 ----------
    function mediaList() { try { return Array.from(doc.querySelectorAll('video, audio')); } catch (e) { return []; } }
    const isPlaying = (m) => !!m && !m.paused && !m.ended;
    function holdMedia(m, playing) {
        let rec = S.media.get(m);
        if (!rec) { rec = { playing: !!playing, muted: !!m.muted }; S.media.set(m, rec); }
        else if (playing) rec.playing = true;
        try { if (!m.muted) m.muted = true; } catch (e) { }
        try { if (!m.paused) m.pause(); } catch (e) { }
    }
    function snapshotMedia() { S.media = new Map(); mediaList().forEach(m => holdMedia(m, isPlaying(m))); }
    function restoreMedia() {
        const map = S.media;
        S.media = new Map();
        map.forEach((rec, m) => {
            try { m.muted = rec.muted; } catch (e) { }
            if (rec.playing && connected(m)) { try { const p = m.play(); if (p && typeof p.catch === 'function') p.catch(() => { }); } catch (e) { } }
        });
    }
    function pauseAll() { mediaList().forEach(m => { try { if (!m.paused) m.pause(); } catch (e) { } }); }
    function exitFullscreenPip() {
        try {
            if (doc.fullscreenElement && doc.exitFullscreen) { const p = doc.exitFullscreen(); if (p && p.catch) p.catch(() => { }); }
            else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) doc.webkitExitFullscreen();
        } catch (e) { }
        try { if (doc.pictureInPictureElement && doc.exitPictureInPicture) { const p = doc.exitPictureInPicture(); if (p && p.catch) p.catch(() => { }); } } catch (e) { }
        mediaList().forEach(m => {
            try { if (m.webkitPresentationMode === 'picture-in-picture' && m.webkitSetPresentationMode) m.webkitSetPresentationMode('inline'); } catch (e) { }
            try { if (m.webkitDisplayingFullscreen && m.webkitExitFullscreen) m.webkitExitFullscreen(); } catch (e) { }
        });
    }
    // 盖着期间 app 又要播 / 取消静音(自动下一集、换源重建)→ 记下意图,继续压住;恢复时照意图来
    function onMediaPlay(e) { if (!S.cover) return; const m = e && e.target; if (isMedia(m)) holdMedia(m, true); }
    function onMediaVolume(e) {
        if (!S.cover) return;
        const m = e && e.target;
        if (!isMedia(m) || m.muted) return;
        const rec = S.media.get(m);
        if (rec) rec.muted = false; else S.media.set(m, { playing: isPlaying(m), muted: false });
        try { m.muted = true; } catch (e2) { }
    }

    // ---------- 盖住 / 恢复 ----------
    function engage(kind) {
        if (!doc) return;
        if (!doc.body) { S.pending = kind; htmlClass('dgp-prelock', true); return; }
        if (S.cover === kind && S.coverEl && S.coverEl.parentNode) { focusCover(); return; }   // 已经是这个画面:不重画(别清掉正在输的 PIN)
        const first = !S.cover;
        if (first) { S.lastFocus = doc.activeElement || null; snapshotMedia(); exitFullscreenPip(); }
        S.cover = kind;
        ensureLayer();
        renderCover();
        htmlClass('dgp-covered', true);
        htmlClass('dgp-prelock', false);
        htmlClass('dgp-hide', false);
        watchBody(true);
        applyDisguise();
        updateFab(); updateBadge();
        clearTimeout(S.idleT); S.idleT = 0;
        focusCover();
        emit();
    }
    function release() {
        if (!S.cover) return;
        S.cover = null;
        clearTimeout(S.lockTick); S.lockTick = 0;
        clearTimeout(S.longT); S.longT = 0;
        if (S.coverEl && S.coverEl.parentNode) S.coverEl.parentNode.removeChild(S.coverEl);
        S.coverEl = null;
        htmlClass('dgp-covered', false);
        watchBody(false);
        restoreMedia();
        applyDisguise();
        updateFab(); updateBadge();
        S.lastActive = now();
        scheduleIdle();
        const lf = S.lastFocus;
        S.lastFocus = null;
        try { if (lf && connected(lf) && typeof lf.focus === 'function') lf.focus(); } catch (e) { }
        emit();
    }
    // 老板键:没盖 → 盖上;老板画面 → 有 PIN 换成锁屏,没 PIN 恢复;锁屏 → 换成老板画面(再按回锁屏)。设了 PIN 永远不会因老板键直接解开
    function toggleBoss(force) {
        if (S.cover === 'boss') {
            if (force === true) return;
            if (hasPin()) engage('lock'); else release();
        } else if (S.cover === 'lock') {
            if (force === false) return;
            engage('boss');
        } else if (force !== false) engage('boss');
    }
    function lockNow() { if (!hasPin()) return false; engage('lock'); return true; }

    // 盖着时保证我们的层是 body 最后一个元素(同为最大 z-index 时后来者在上:toast / teleport 的弹窗)
    function keepLast() {
        const L = S.layer;
        if (!L || !doc.body) return;
        let n = L.nextSibling, after = false;
        while (n) { if (n.nodeType === 1) { after = true; break; } n = n.nextSibling; }
        if (!after && L.parentNode === doc.body) return;
        const ae = doc.activeElement;
        doc.body.appendChild(L);
        if (ae && L.contains && L.contains(ae)) { try { ae.focus(); } catch (e) { } }
    }
    function watchBody(on) {
        if (!on) { if (S.bodyMo) { try { S.bodyMo.disconnect(); } catch (e) { } S.bodyMo = null; } return; }
        keepLast();
        if (S.bodyMo || typeof root.MutationObserver !== 'function') return;
        S.bodyMo = new root.MutationObserver(keepLast);
        S.bodyMo.observe(doc.body, { childList: true });
    }

    function renderCover() {
        if (S.coverEl && S.coverEl.parentNode) S.coverEl.parentNode.removeChild(S.coverEl);
        clearTimeout(S.lockTick); S.lockTick = 0;
        S.coverEl = S.cover === 'lock' ? buildLock() : buildBoss();
        S.layer.appendChild(S.coverEl);
    }
    function buildBoss() {
        let el;
        if (S.set.cover === 'search') {
            el = h('div', { class: 'dgp-cover dgp-search', tabindex: '-1', 'data-dgp-cover': 'boss' }, [
                h('div', { class: 'dgp-search-box' }, [
                    h('span', { class: 'dgp-search-ic', 'aria-hidden': 'true' }),
                    h('input', { type: 'search', 'aria-label': '搜索', placeholder: '搜索', autocomplete: 'off', spellcheck: 'false', 'data-dgp-first': '1' }),
                ]),
            ]);
        } else {
            el = h('div', { class: 'dgp-cover dgp-doc', tabindex: '-1', 'aria-label': '文档', 'data-dgp-cover': 'boss', 'data-dgp-first': '1' }, [
                h('div', { class: 'dgp-doc-bar' }, [
                    h('span', { class: 'dgp-doc-ic', 'aria-hidden': 'true' }),
                    h('span', { class: 'dgp-doc-name' }, TITLES.doc),
                    h('span', { class: 'dgp-doc-tools', 'aria-hidden': 'true' }, [h('span', { class: 'dgp-ph' }), h('span', { class: 'dgp-ph' }), h('span', { class: 'dgp-ph' }), h('span', { class: 'dgp-ph' })]),
                ]),
                h('div', { class: 'dgp-doc-page' }),
            ]);
        }
        // 触屏:在伪装画面上长按 1 秒 = 再按一次老板键(三指轻点关着时也能退出)
        const clear = () => { clearTimeout(S.longT); S.longT = 0; };
        el.addEventListener('pointerdown', (e) => {
            if (!e || e.pointerType !== 'touch') return;
            clear();
            const x = e.clientX, y = e.clientY;
            S.longStart = { x, y };
            S.longT = setTimeout(() => { S.longT = 0; toggleBoss(); }, 1000);
        });
        el.addEventListener('pointermove', (e) => { const s = S.longStart; if (S.longT && s && e && Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) > 16) clear(); });
        el.addEventListener('pointerup', clear);
        el.addEventListener('pointercancel', clear);
        return el;
    }
    function buildLock() {
        const can = pinAvailable();
        const err = h('p', { class: 'dgp-err', role: 'alert', 'aria-live': 'assertive' });
        const input = h('input', {
            class: 'dgp-pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off',
            'aria-label': 'PIN（4 到 6 位数字）', 'data-dgp-first': '1',
        });
        const submit = h('button', { type: 'submit', class: 'dgp-btn dgp-btn-pri' }, '解锁');
        const form = h('form', { novalidate: true }, [input, submit, err]);
        let busy = false;
        const setBusy = (b) => { busy = b; input.disabled = b; submit.disabled = b; };
        const tick = () => {
            clearTimeout(S.lockTick); S.lockTick = 0;
            if (S.cover !== 'lock' || !connected(form)) return;
            const left = lockoutLeft();
            if (left > 0) {
                input.disabled = true; submit.disabled = true;
                err.textContent = '错误次数太多，请 ' + Math.ceil(left / 1000) + ' 秒后再试';
                S.lockTick = setTimeout(tick, Math.min(1000, left));
            } else if (!busy) {
                input.disabled = false; submit.disabled = false;
                if (/秒后再试/.test(err.textContent)) err.textContent = '';
            }
        };
        form.addEventListener('submit', (e) => {
            if (e && e.preventDefault) e.preventDefault();
            if (busy || lockoutLeft() > 0) { tick(); return; }
            const v = String(input.value || '').trim();
            if (!/^\d{4,6}$/.test(v)) { err.textContent = '请输入 4–6 位数字'; return; }
            setBusy(true);
            verifyPin(v).then((r) => {
                setBusy(false);
                input.value = '';
                if (r && r.ok) { release(); return; }
                if (r && r.wait > 0) tick();
                else err.textContent = 'PIN 不对' + (r && r.left > 0 ? '，再错 ' + r.left + ' 次要等一会儿' : '');
                try { input.focus(); } catch (e2) { }
            }, () => { setBusy(false); err.textContent = '验证出错，请重试'; });
        });
        const forgot = h('button', { type: 'button', class: 'dgp-link' }, '忘记 PIN？');
        const confirmBox = h('div', { class: 'dgp-confirm', hidden: true }, [
            h('p', null, '忘记 PIN 只能重置这台设备：会退出登录，并清空这台设备上的观看记录、进度、缓存、离线下载和全部本机设置（包括 PIN）。云端记录不受影响，重新登录即可。'),
            h('div', { class: 'dgp-row-btns' }, [
                h('button', { type: 'button', class: 'dgp-btn dgp-btn-danger', 'data-dgp-reset': '1', onclick: () => { resetDevice(); } }, '重置这台设备'),
                h('button', { type: 'button', class: 'dgp-btn', onclick: () => { confirmBox.setAttribute('hidden', ''); forgot.removeAttribute('hidden'); try { (can ? input : forgot).focus(); } catch (e) { } } }, '返回'),
            ]),
        ]);
        forgot.addEventListener('click', () => {
            confirmBox.removeAttribute('hidden'); forgot.setAttribute('hidden', '');
            try { const b = confirmBox.querySelector('[data-dgp-reset]'); if (b) b.focus(); } catch (e) { }
        });
        const card = h('div', { class: 'dgp-lock-card' }, [
            h('div', { class: 'dgp-lock-ic', 'aria-hidden': 'true' }),
            h('h1', { id: 'dgp-lock-h' }, '已锁定'),
            h('p', { id: 'dgp-lock-d' }, can ? '输入 PIN 解锁' : '当前连接不是 HTTPS（或浏览器太旧），没法验证 PIN。请改用 https 地址打开，或重置这台设备。'),
            can ? form : null,
            forgot, confirmBox,
            h('p', { class: 'dgp-help' }, '这是本机的隐私遮挡，防止别人随手翻看；不是账号安全措施。'),
        ]);
        const el = h('div', { class: 'dgp-cover dgp-lock', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dgp-lock-h', 'aria-describedby': 'dgp-lock-d', 'data-dgp-cover': 'lock' }, [card]);
        if (!can) forgot.setAttribute('data-dgp-first', '1');
        if (can && lockoutLeft() > 0) S.lockTick = setTimeout(tick, 0);
        return el;
    }
    function focusables() {
        const c = S.coverEl;
        if (!c) return [];
        let list = [];
        try { list = Array.from(c.querySelectorAll('input, button, select, textarea, a[href], [tabindex]')); } catch (e) { }
        return list.filter(el => {
            if (el.disabled || el.getAttribute('tabindex') === '-1') return false;
            for (let n = el; n && n !== c; n = n.parentNode) if (n.hasAttribute && n.hasAttribute('hidden')) return false;
            return true;
        });
    }
    function focusCover() {
        const c = S.coverEl;
        if (!c) return;
        let t = null;
        try { t = c.querySelector('[data-dgp-first]'); } catch (e) { }
        if (t && (t.disabled || (t.hasAttribute && t.hasAttribute('hidden')))) t = null;
        t = t || focusables()[0] || c;
        try { t.focus(); } catch (e) { }
    }
    function trapTab(e) {
        const f = focusables();
        if (!f.length) { focusCover(); return; }
        const i = f.indexOf(doc.activeElement);
        let n = i < 0 ? (e.shiftKey ? f.length - 1 : 0) : (e.shiftKey ? i - 1 : i + 1);
        n = (n + f.length) % f.length;
        try { f[n].focus(); } catch (e2) { }
    }

    // ---------- 键盘 / 触摸 ----------
    function bossKeyHit(e) {
        const k = S.set.bossKey;
        if (k === 'off' || !e || e.repeat || e.isComposing) return false;
        if (k === 'backquote') {
            if (e.ctrlKey || e.metaKey || e.altKey) return false;
            if (!(e.code === 'Backquote' || e.key === '`')) return false;
            if (!S.cover && isEditable(e.target)) return false;   // 在搜索框里打字照常输入
            return true;
        }
        if (k === 'f9') return e.key === 'F9' || e.code === 'F9';
        if (k === 'esc2') {
            if (!(e.key === 'Escape' || e.key === 'Esc')) return false;
            const t = now();
            if (S.lastEsc && t - S.lastEsc <= ESC2_MS) { S.lastEsc = 0; return true; }
            S.lastEsc = t;
            return false;
        }
        return false;
    }
    function stop(e, prevent) {
        try { if (prevent && e.preventDefault) e.preventDefault(); } catch (x) { }
        try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else if (e.stopPropagation) e.stopPropagation(); } catch (x) { }
    }
    function onKeyDown(e) {
        S.lastActive = now();
        if (bossKeyHit(e)) { stop(e, true); toggleBoss(); return; }
        if (!S.cover) return;
        const k = e.key;
        if (k === 'Escape' || k === 'Esc') { stop(e, true); return; }   // Esc 不关锁屏
        if (k === 'Tab') { stop(e, true); trapTab(e); return; }
        const inside = S.coverEl && e.target && S.coverEl.contains && S.coverEl.contains(e.target);
        if (!inside) { stop(e, true); focusCover(); return; }
        stop(e, false);   // 盖着时 app 的快捷键(空格播放等)一律收不到;输入框照常打字
    }
    function onKeyOther(e) { if (S.cover) stop(e, false); }
    function onFocusIn(e) {
        if (!S.cover || !S.coverEl) return;
        const t = e && e.target;
        if (t && S.coverEl.contains && !S.coverEl.contains(t)) focusCover();
    }
    // 三指轻点:三根手指同时按下、几乎不动、0.6 秒内全部抬起
    function onTouchStart(e) {
        if (!S.set.touch3) return;
        const ts = e && e.touches, n = ts ? ts.length : 0;
        if (n === 3) {
            let x = 0, y = 0;
            for (let i = 0; i < 3; i++) { x += ts[i].clientX; y += ts[i].clientY; }
            S.t3 = { start: now(), cx: x / 3, cy: y / 3 };
        } else if (n > 3) S.t3.start = 0;
    }
    function onTouchMove(e) {
        if (!S.t3.start) return;
        const ts = e && e.touches;
        if (!ts || ts.length < 3) return;
        let x = 0, y = 0;
        for (let i = 0; i < 3; i++) { x += ts[i].clientX; y += ts[i].clientY; }
        if (Math.abs(x / 3 - S.t3.cx) + Math.abs(y / 3 - S.t3.cy) > 30) S.t3.start = 0;
    }
    function onTouchEnd(e) {
        if (!S.t3.start) return;
        if (e && e.touches && e.touches.length > 0) return;
        const ok = now() - S.t3.start <= 600;
        S.t3.start = 0;
        if (ok && S.set.touch3) { try { if (e.cancelable && e.preventDefault) e.preventDefault(); } catch (x) { } toggleBoss(); }
    }

    // ---------- 悬浮按钮 / 无痕小标 ----------
    function placeFab(x, y) {
        const b = S.fab;
        if (!b) return;
        const W = root.innerWidth || 360, H = root.innerHeight || 640, sz = 44;
        const cx = Math.min(Math.max(4, x), Math.max(4, W - sz - 4)), cy = Math.min(Math.max(4, y), Math.max(4, H - sz - 4));
        b.style.left = Math.round(cx) + 'px';
        b.style.top = Math.round(cy) + 'px';
        return { x: cx, y: cy };
    }
    function fabHome() {
        const W = root.innerWidth || 360, H = root.innerHeight || 640, p = S.set.fabPos;
        if (p) return { x: p.x * W, y: p.y * H };
        return { x: W - 44 - 12, y: H * 0.62 };
    }
    function updateFab() {
        const want = !!(S.set.fab && !S.cover && doc && doc.body);
        if (!want) { if (S.fab && S.fab.parentNode) S.fab.parentNode.removeChild(S.fab); S.fab = null; return; }
        if (S.fab && S.fab.parentNode) return;
        if (!ensureLayer()) return;
        const b = h('button', { type: 'button', class: 'dgp-fab', 'aria-label': '隐藏页面（老板键）', title: '隐藏页面' });
        let drag = null;
        b.addEventListener('pointerdown', (e) => {
            const l = parseFloat(b.style.left) || 0, t = parseFloat(b.style.top) || 0;
            drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: l, oy: t, moved: false };
            try { if (b.setPointerCapture) b.setPointerCapture(e.pointerId); } catch (x) { }
        });
        b.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
            drag.moved = true;
            placeFab(drag.ox + dx, drag.oy + dy);
        });
        b.addEventListener('pointerup', (e) => {
            if (!drag) return;
            const d = drag;
            drag = null;
            if (d.moved) {
                const W = root.innerWidth || 360, H = root.innerHeight || 640;
                const l = parseFloat(b.style.left) || 0, t = parseFloat(b.style.top) || 0;
                S.set.fabPos = { x: Math.min(1, Math.max(0, l / W)), y: Math.min(1, Math.max(0, t / H)) };
                saveSettings();
            } else toggleBoss();
        });
        b.addEventListener('pointercancel', () => { drag = null; });
        b.addEventListener('click', (e) => { if (e && e.detail === 0) toggleBoss(); });   // 键盘回车 / 空格
        S.layer.appendChild(b);
        S.fab = b;
        const p = fabHome();
        placeFab(p.x, p.y);
    }
    function updateBadge() {
        const want = !!(S.set.incognito && !S.cover && doc && doc.body);
        if (!want) { if (S.badge && S.badge.parentNode) S.badge.parentNode.removeChild(S.badge); S.badge = null; return; }
        if (S.badge && S.badge.parentNode) return;
        if (!ensureLayer()) return;
        S.badge = h('div', { class: 'dgp-badge', role: 'status', 'aria-label': '无痕模式已开启', title: '无痕模式：不记历史和进度' }, '无痕');
        S.layer.appendChild(S.badge);
    }
    // Android App(MainActivity 的 AndroidPrivacy 接口):防截屏 / 最近任务不显示画面
    function androidPriv() { try { const A = root.AndroidPrivacy; return (A && typeof A.setSecure === 'function') ? A : null; } catch (e) { return null; } }
    function applySecure() { const A = androidPriv(); if (A) { try { A.setSecure(!!S.set.secure); } catch (e) { } } }

    // ---------- 闲置 / 后台 ----------
    function idleMs() { return S.set.idleMin * 60e3; }
    // 「正在看」只认会自己停下的播放:带 loop 的(刷短片静音自动循环、封面悬停预览)永远不 ended,算进来闲置锁就永远不触发。
    //   主播放器(DPlayer)的「循环」是 ended 时 seek(0) 重播,video.loop 一直是 false,不受影响
    function mediaPlayingVisible() { if (doc.hidden) return false; return mediaList().some(m => isPlaying(m) && !m.loop); }
    function scheduleIdle() {
        clearTimeout(S.idleT); S.idleT = 0;
        if (!hasPin() || S.cover) return;
        const due = S.lastActive + idleMs() - now();
        S.idleT = setTimeout(idleCheck, Math.max(1000, due));
    }
    function idleCheck() {
        S.idleT = 0;
        if (!hasPin() || S.cover) return;
        if (mediaPlayingVisible()) S.lastActive = now();   // 正在看视频不算闲置
        if (now() - S.lastActive >= idleMs()) { engage('lock'); return; }
        scheduleIdle();
    }
    function onActivity() { S.lastActive = now(); }
    function onHidden() {
        if (!S.hiddenAt) S.hiddenAt = now();
        if (S.set.autoPause) pauseAll();
        if (hasPin() && !S.cover) htmlClass('dgp-hide', true);   // 回来那一帧也不露内容,够 1 分钟再锁
    }
    function onVisible() {
        const away = S.hiddenAt ? now() - S.hiddenAt : 0;
        S.hiddenAt = 0;
        if (hasPin() && !S.cover && away >= BG_LOCK_MS) engage('lock');
        htmlClass('dgp-hide', false);
        S.lastActive = now();
        scheduleIdle();
    }
    function onVisibility() { if (doc.visibilityState === 'hidden' || doc.hidden === true) onHidden(); else onVisible(); }

    // ---------- PIN ----------
    function subtle() {
        try {
            const c = root.crypto;
            if (root.isSecureContext === false) return null;
            return (c && c.subtle && typeof c.subtle.deriveBits === 'function' && typeof c.getRandomValues === 'function') ? c.subtle : null;
        } catch (e) { return null; }
    }
    function pinAvailable() { return !!subtle() && typeof root.TextEncoder === 'function'; }
    function hasPin() { return lsGet(LS_PIN) != null || !!S.pinMem; }
    const toHex = (u8) => Array.from(u8, b => (b < 16 ? '0' : '') + b.toString(16)).join('');
    function fromHex(s) {
        s = String(s || '');
        if (!/^(?:[0-9a-f]{2})+$/.test(s)) return null;
        const out = new Uint8Array(s.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
        return out;
    }
    function readPin() {
        let r = null;
        try { r = JSON.parse(lsGet(LS_PIN) || 'null'); } catch (e) { }
        if (!r && S.pinMem) r = S.pinMem;
        if (!r || r.v !== 1 || !Number.isInteger(r.it) || r.it < 1000 || r.it > 1e7) return null;
        const salt = fromHex(r.salt), dk = fromHex(r.dk);
        if (!salt || salt.length < 8 || !dk || dk.length !== KEY_BITS / 8) return null;
        return { it: r.it, salt, dk };
    }
    async function derive(pin, salt, it) {
        const s = subtle();
        if (!s) throw new Error('WebCrypto unavailable');
        const key = await s.importKey('raw', new root.TextEncoder().encode(String(pin)), { name: 'PBKDF2' }, false, ['deriveBits']);
        const bits = await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: it }, key, KEY_BITS);
        return new Uint8Array(bits);
    }
    // 常量时间:不因第一个不同字节提前返回
    function ctEqual(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        let d = 0;
        for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
        return d === 0;
    }
    function lockoutDelay(n) { return n < FREE_TRIES ? 0 : Math.min(LOCK_MAX_MS, LOCK_BASE_MS * Math.pow(2, n - FREE_TRIES)); }
    function getFail() {
        let f = null;
        try { f = JSON.parse(lsGet(LS_FAIL) || 'null'); } catch (e) { }
        if (!f && S.failMem) f = S.failMem;
        const n = f && Number.isInteger(f.n) && f.n > 0 ? Math.min(f.n, 1000) : 0;
        let until = f && Number.isFinite(f.until) ? f.until : 0;
        if (until > now() + LOCK_MAX_MS) until = now() + LOCK_MAX_MS;   // 时钟被往回拨 / 手改
        return { n, until };
    }
    function setFail(f) { S.failMem = f; if (!f.n) lsDel(LS_FAIL); else lsSet(LS_FAIL, JSON.stringify(f)); }
    function lockoutLeft() { const f = getFail(); return Math.max(0, f.until - now()); }
    async function setPin(pin) {
        pin = String(pin == null ? '' : pin);
        if (!/^\d{4,6}$/.test(pin)) return { ok: false, error: 'format' };
        if (!pinAvailable()) return { ok: false, error: 'unavailable' };
        const salt = new Uint8Array(SALT_LEN);
        root.crypto.getRandomValues(salt);
        const dk = await derive(pin, salt, PBKDF2_IT);
        const rec = { v: 1, kdf: 'pbkdf2-sha256', it: PBKDF2_IT, salt: toHex(salt), dk: toHex(dk) };
        if (!lsSet(LS_PIN, JSON.stringify(rec))) S.pinMem = rec;   // 没有存储:只在这次打开里有效
        setFail({ n: 0, until: 0 });
        S.lastActive = now();
        scheduleIdle();
        emit();
        return { ok: true };
    }
    async function verifyPin(pin) {
        const wait = lockoutLeft();
        if (wait > 0) return { ok: false, wait, left: 0 };
        const rec = readPin();
        let ok = false;
        if (rec && /^\d{4,6}$/.test(String(pin))) {
            try { ok = ctEqual(await derive(pin, rec.salt, rec.it), rec.dk); } catch (e) { ok = false; }
        }
        if (ok) { setFail({ n: 0, until: 0 }); return { ok: true, wait: 0, left: FREE_TRIES }; }
        const f = getFail();
        f.n += 1;
        f.until = f.n >= FREE_TRIES ? now() + lockoutDelay(f.n) : 0;
        setFail(f);
        return { ok: false, wait: lockoutLeft(), left: Math.max(0, FREE_TRIES - f.n) };
    }
    async function removePin(pin) {
        const r = await verifyPin(pin);
        if (!r.ok) return r;
        lsDel(LS_PIN); S.pinMem = null;
        setFail({ n: 0, until: 0 });
        clearTimeout(S.idleT); S.idleT = 0;
        emit();
        return { ok: true };
    }

    // ---------- 清除 ----------
    function removeKeys(all) {
        let n = 0;
        const s = store('l');
        if (!s) return 0;
        try {
            if (all) { n = s.length || 0; s.clear(); return n; }
            const ks = [];
            for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k != null && isClearKey(k)) ks.push(k); }
            ks.forEach(k => { try { s.removeItem(k); n++; } catch (e) { } });
        } catch (e) { }
        return n;
    }
    function clearSession() { try { const ss = store('s'); if (ss) ss.clear(); return true; } catch (e) { return false; } }
    // Cache Storage:图片缓存整个删;页面外壳缓存里只删 /api/ 回包(搜索 / 作品 / 历史),外壳留着(断网还能打开)
    async function purgeCaches() {
        const C = root.caches;
        if (!C || typeof C.keys !== 'function') return 0;
        let n = 0;
        try {
            const names = await C.keys();
            for (const name of names) {
                if (!/^donggua-/.test(name)) continue;
                if (/^donggua-(images|live-img)-/.test(name)) { if (await C.delete(name)) n++; continue; }
                const c = await C.open(name);
                const reqs = await c.keys();
                for (const r of reqs) {
                    let p = '';
                    try { p = new URL(r.url).pathname; } catch (e) { }
                    if (p.indexOf('/api/') === 0) { if (await c.delete(r)) n++; }
                }
            }
        } catch (e) { }
        return n;
    }
    // 离线下载(IndexedDB donggua_offline):清空各表(删库会被 app 开着的连接挡住);库不存在不新建
    function clearOfflineDb() {
        return new Promise(resolve => {
            let done = false, guard = 0;
            const fin = (v) => { if (!done) { done = true; clearTimeout(guard); resolve(v); } };
            try {
                const idb = root.indexedDB;
                if (!idb) return fin(false);
                const req = idb.open('donggua_offline');
                req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (e) { } };
                req.onerror = () => fin(false);
                req.onblocked = () => fin(false);
                req.onsuccess = () => {
                    const db = req.result;
                    let names = [];
                    try { names = Array.from(db.objectStoreNames || []); } catch (e) { }
                    if (!names.length) { try { db.close(); } catch (e) { } return fin(true); }
                    try {
                        const tx = db.transaction(names, 'readwrite');
                        names.forEach(n => tx.objectStore(n).clear());
                        tx.oncomplete = () => { try { db.close(); } catch (e) { } fin(true); };
                        tx.onerror = tx.onabort = () => { try { db.close(); } catch (e) { } fin(false); };
                    } catch (e) { try { db.close(); } catch (e2) { } fin(false); }
                };
                guard = setTimeout(() => fin(false), 6000);
            } catch (e) { fin(false); }
        });
    }
    // 云端观看历史(server.js POST /api/history/clear,按同步令牌)。all:true = 删除墓碑也一起删:
    //   墓碑按片名存、服务器留 120 天,不删的话清完一刷新,历史拉取又把「删过的片名」整份写回本机 donggua_history_deleted
    async function clearServerHistory() {
        const token = lsGet('emax_auth_hash');
        if (!token) return 'skip';
        const f = S.origFetch || root.fetch;
        if (typeof f !== 'function') return 'skip';
        try {
            const r = await f.call(root, '/api/history/clear', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, all: true }) });
            return (r && r.ok) ? 'ok' : ('http ' + (r ? r.status : 0));
        } catch (e) { return 'error'; }
    }
    function reloadSoon(ms) {
        setTimeout(() => { try { root.location.reload(); } catch (e) { } }, ms == null ? 400 : ms);
    }
    // 一键清除:opts = { server: 同时清云端历史, offline: 同时清离线下载, reload: 默认 true }
    async function clearLocal(opts) {
        opts = opts || {};
        if (S.purge !== 'all') S.purge = 'keys';   // 刷新前 app 的卸载保存 / 推送一律拦下
        const out = { keys: 0, session: false, caches: 0, offline: null, server: null };
        if (opts.server) out.server = await clearServerHistory();
        out.keys = removeKeys(false);
        out.session = clearSession();
        out.caches = await purgeCaches();
        if (opts.offline) out.offline = await clearOfflineDb();
        if (opts.reload !== false) reloadSoon(serverFailed(out.server) ? 2500 : undefined);   // 云端没清掉:多留两秒让人看到提示
        return out;
    }
    function serverFailed(s) { return s != null && s !== 'ok' && s !== 'skip'; }
    // 忘记 PIN:本机完全重置(退出登录 + 全部本机数据 + 离线下载 + PIN)
    async function resetDevice(opts) {
        opts = opts || {};
        S.purge = 'all';
        const jobs = [purgeCaches(), clearOfflineDb()];
        try {
            const A = root.DgAdult;
            if (A && A.auth && typeof A.auth.logout === 'function') jobs.push(Promise.resolve(A.auth.logout()).catch(() => { }));
            else {
                const f = S.origFetch || root.fetch;
                if (typeof f === 'function') jobs.push(Promise.resolve(f.call(root, '/api/auth/logout', { method: 'POST', credentials: 'same-origin', keepalive: true })).catch(() => { }));
            }
        } catch (e) { }
        try {
            const nav = root.navigator;
            if (nav && nav.serviceWorker && nav.serviceWorker.getRegistration) {
                jobs.push(Promise.resolve(nav.serviceWorker.getRegistration()).then(reg => (reg && reg.pushManager) ? reg.pushManager.getSubscription() : null)
                    .then(sub => sub ? sub.unsubscribe() : null).catch(() => { }));
            }
        } catch (e) { }
        removeKeys(true); clearSession();
        S.pinMem = null; S.failMem = null;
        let cap = 0;
        await Promise.race([Promise.all(jobs), new Promise(r => { cap = setTimeout(r, 2500); })]);
        clearTimeout(cap);
        removeKeys(true); clearSession();   // 期间有人又写了(登出回调等)再清一次
        if (opts.reload !== false) reloadSoon(0);
        return true;
    }

    // 退出无痕:app 内存里还留着无痕期间的记录(线路实测分辨率表 站点|vod_id、弹幕偏移、推荐缓存…都是「读一次进内存、改完整份写回」),
    //   只拦 setItem 的话,关掉无痕后下一次正常写就把它们整份落到本机。→ 刷新之前照无痕拦着(S.purge='incog':存储 / 网络 / 历史钩子都当无痕),
    //   清掉这段时间的接口 / 图片缓存,然后刷新页面,内存里的副本随之丢掉
    function leaveIncognito() {
        if (!S.purge) S.purge = 'incog';
        say('已关闭无痕，正在刷新页面…');
        let done = false;
        const go = () => { if (done) return; done = true; reloadSoon(0); };
        setTimeout(go, 1500);   // 缓存清理卡住也要刷新
        Promise.resolve().then(purgeCaches).then(go, go);
    }

    // ---------- 设置 ----------
    function setSetting(key, value) {
        const next = Object.assign({}, S.set);
        next[key] = value;
        const was = S.set;
        S.set = normSettings(next);
        saveSettings();
        if (key === 'incognito' && was.incognito && !S.set.incognito) leaveIncognito();
        if (key === 'idleMin') { S.lastActive = now(); scheduleIdle(); }
        if (key === 'secure') applySecure();
        applyDisguise(); updateFab(); updateBadge();
        emit();
        return Object.assign({}, S.set);
    }
    function refreshHosts() {
        S.hosts = S.hosts.filter(x => connected(x.el));
        S.hosts.slice().forEach(x => { renderSettings(x.container); });
    }
    function say(msg, isErr) { S.ui.msg = msg || ''; S.ui.msgErr = !!isErr; }
    function renderSettings(container) {
        if (!container || !doc || typeof container.appendChild !== 'function') return null;
        ensureCss();
        let old = null;
        const kids = container.children ? Array.from(container.children) : [];
        old = kids.find(k => k.getAttribute && k.getAttribute('data-dgp-section') === '1') || null;
        let fk = null;
        const ae = doc.activeElement;
        if (old && ae && old.contains && old.contains(ae) && ae.getAttribute) fk = ae.getAttribute('data-dgp');
        const sec = buildSettings(container);
        if (old) container.replaceChild(sec, old); else container.appendChild(sec);
        S.hosts = S.hosts.filter(x => x.container !== container && connected(x.el));
        S.hosts.push({ container, el: sec });
        if (fk) { try { const t = sec.querySelector('[data-dgp="' + fk + '"]'); if (t) t.focus(); } catch (e) { } }
        return sec;
    }
    function rerender(container) { renderSettings(container); }
    function buildSettings(container) {
        const st = S.set, ui = S.ui;
        const sec = h('div', { class: 'dgp-set', 'data-dgp-section': '1' });
        const row = (title, desc, control) => h('div', { class: 'set-row' }, [
            h('div', null, [h('div', { class: 'set-title' }, title), desc ? h('div', { class: 'set-desc' }, desc) : null]), control,
        ]);
        const toggle = (key, label) => {
            const input = h('input', { type: 'checkbox', 'aria-label': label, 'data-dgp': key, checked: !!st[key] });
            input.addEventListener('change', () => { setSetting(key, !!input.checked); });
            return h('label', { class: 'settings-switch' }, [input, h('span', { class: 'settings-slider' })]);
        };
        const select = (key, opts, label) => {
            const s = h('select', { class: 'dgp-sel', 'aria-label': label, 'data-dgp': key }, opts.map(o => h('option', { value: String(o[0]) }, o[1])));
            s.value = String(st[key]);
            s.addEventListener('change', () => { setSetting(key, key === 'idleMin' ? Number(s.value) : s.value); });
            return s;
        };
        sec.appendChild(h('div', { class: 'set-block' }, [
            h('div', { class: 'set-title' }, '隐私'),
            h('div', { class: 'set-desc' }, '下面这些只作用于这台设备上的这个浏览器 / App，不上传。'),
        ]));
        // 老板键
        sec.appendChild(row('老板键', '一键盖住页面：视频暂停并静音、换成空白页面、标签页改名；再按一次恢复' + (hasPin() ? '（已设 PIN，恢复要输 PIN）' : ''),
            select('bossKey', [['backquote', '` 键'], ['esc2', '连按两次 Esc'], ['f9', 'F9'], ['off', '关闭']], '老板键')));
        sec.appendChild(row('伪装画面', '老板键盖上后的样子', select('cover', [['doc', '空白文档'], ['search', '搜索页']], '伪装画面')));
        sec.appendChild(row('三指轻点（触屏）', '三根手指同时轻点一下 = 老板键；在伪装画面上长按 1 秒也能恢复', toggle('touch3', '三指轻点触发老板键')));
        sec.appendChild(row('悬浮按钮', '屏幕边上一个可拖动的小按钮，点一下 = 老板键', toggle('fab', '显示老板键悬浮按钮')));
        sec.appendChild(row('切走自动暂停', '切到别的标签页或应用时自动暂停视频', toggle('autoPause', '切走自动暂停')));
        // 标签页伪装
        sec.appendChild(row('标签页伪装', '浏览器标签一直显示成别的标题和图标（站内改标题也会被盖回去）', toggle('disguise', '标签页伪装')));
        sec.appendChild(row('伪装成', '', select('preset', [['doc', '文档'], ['search', '搜索'], ['mail', '邮箱'], ['custom', '自定义标题']], '标签页伪装成')));
        if (st.preset === 'custom') {
            const inp = h('input', { class: 'dgp-in dgp-in-wide', type: 'text', maxlength: '60', placeholder: TITLES.doc, 'aria-label': '自定义标签页标题', 'data-dgp': 'customTitle', value: st.customTitle });
            inp.addEventListener('change', () => { setSetting('customTitle', inp.value); });
            sec.appendChild(row('自定义标题', '', inp));
        }
        // 无痕
        sec.appendChild(row('无痕模式', '开着时不记观看历史、继续观看、播放进度、最近直播，不上报观看统计、线路反馈和热度；已有记录不动（删记录照常生效）。页面左下角会显示「无痕」；关掉时页面会刷新一次',
            toggle('incognito', '无痕模式')));
        // PIN
        sec.appendChild(pinBlock(container));
        // App:防截屏
        if (androidPriv()) sec.appendChild(row('防截屏（App）', '禁止截屏和录屏，最近任务里也不显示画面', toggle('secure', '防截屏')));
        // 一键清除
        sec.appendChild(clearBlock(container));
        sec.appendChild(h('div', { class: 'dgp-msg' + (ui.msgErr ? ' err' : ''), role: 'status', 'aria-live': 'polite' }, ui.msg || ''));
        return sec;
    }
    function pinBlock(container) {
        const ui = S.ui;
        const blk = h('div', { class: 'set-block' });
        blk.appendChild(h('div', { class: 'set-title' }, 'PIN 锁'));
        const help = '打开站点时、闲置一段时间后（正在播放不算）、从后台回来超过 1 分钟时锁上，输 4–6 位数字解锁。这是本机的隐私遮挡，挡住别人随手翻看；'
            + '不是账号安全措施（清除浏览器数据就能去掉它，但本机记录也会一起没了）。忘记 PIN 只能重置这台设备。';
        if (!pinAvailable()) {
            blk.appendChild(h('div', { class: 'set-desc' }, help));
            blk.appendChild(h('div', { class: 'dgp-warn' }, '当前连接不是 HTTPS（或浏览器太旧），浏览器不给用安全加密接口，所以 PIN 锁不可用。请改用 https 地址打开。'));
            return blk;
        }
        const has = hasPin();
        blk.appendChild(h('div', { class: 'set-desc' }, (has ? '已开启。' : '未开启。') + help));
        const pinInput = (key, label) => h('input', { class: 'dgp-in', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off', 'aria-label': label, placeholder: label, 'data-dgp': key });
        const btn = (text, key, fn, cls) => h('button', { type: 'button', class: 'dgp-sbtn' + (cls ? ' ' + cls : ''), 'data-dgp': key, onclick: fn }, text);
        const openForm = (f) => { ui.form = f; say(''); rerender(container); };
        if (has) {
            const idle = h('select', { class: 'dgp-sel', 'aria-label': '闲置多久自动锁', 'data-dgp': 'idleMin' }, IDLE_OPTS.map(m => h('option', { value: String(m) }, m + ' 分钟')));
            idle.value = String(S.set.idleMin);
            idle.addEventListener('change', () => { setSetting('idleMin', Number(idle.value)); });
            blk.appendChild(h('div', { class: 'dgp-form' }, [h('span', { class: 'set-desc' }, '闲置多久自动锁'), idle]));
        }
        const busy = ui.busy;
        if (!ui.form) {
            const btns = h('div', null, has
                ? [btn('立即锁定', 'pinLockNow', () => { lockNow(); }), btn('修改 PIN', 'pinChange', () => openForm('change')), btn('移除 PIN', 'pinRemove', () => openForm('remove'), 'danger')]
                : [btn('设置 PIN', 'pinSet', () => openForm('set'))]);
            blk.appendChild(btns);
            return blk;
        }
        const f = ui.form;
        const cur = (f === 'change' || f === 'remove') ? pinInput('pinCur', '当前 PIN') : null;
        const nw = (f === 'set' || f === 'change') ? pinInput('pinNew', '新 PIN（4–6 位）') : null;
        const nw2 = nw ? pinInput('pinNew2', '再输一次') : null;
        const okBtn = h('button', { type: 'submit', class: 'dgp-sbtn' + (f === 'remove' ? ' danger' : ''), 'data-dgp': 'pinOk', disabled: busy }, f === 'remove' ? '移除' : '保存');
        const cancel = btn('取消', 'pinCancel', () => { ui.form = ''; say(''); rerender(container); });
        const form = h('form', { class: 'dgp-form', novalidate: true }, [cur, nw, nw2, okBtn, cancel]);
        form.addEventListener('submit', (e) => {
            if (e && e.preventDefault) e.preventDefault();
            if (ui.busy) return;
            const cv = cur ? String(cur.value || '').trim() : '', nv = nw ? String(nw.value || '').trim() : '', nv2 = nw2 ? String(nw2.value || '').trim() : '';
            if (cur && !/^\d{4,6}$/.test(cv)) { say('当前 PIN 是 4–6 位数字', true); rerender(container); return; }
            if (nw && !/^\d{4,6}$/.test(nv)) { say('新 PIN 要 4–6 位数字', true); rerender(container); return; }
            if (nw && nv !== nv2) { say('两次输入的新 PIN 不一样', true); rerender(container); return; }
            ui.busy = true; say('请稍候…');
            rerender(container);
            const done = (msg, err, keepForm) => { ui.busy = false; if (!keepForm) ui.form = ''; say(msg, err); rerender(container); };
            const failMsg = (r) => (r && r.wait > 0) ? ('错误次数太多，请 ' + Math.ceil(r.wait / 1000) + ' 秒后再试') : '当前 PIN 不对';
            (async () => {
                try {
                    if (f === 'set') { const r = await setPin(nv); return r.ok ? done('PIN 已设置') : done('设置失败', true, true); }
                    if (f === 'remove') { const r = await removePin(cv); return r.ok ? done('PIN 已移除') : done(failMsg(r), true, true); }
                    const r = await verifyPin(cv);
                    if (!r.ok) return done(failMsg(r), true, true);
                    const r2 = await setPin(nv);
                    return r2.ok ? done('PIN 已修改') : done('修改失败', true, true);
                } catch (err) { done('出错了，请重试', true, true); }
            })();
        });
        blk.appendChild(form);
        return blk;
    }
    function clearBlock(container) {
        const ui = S.ui;
        const blk = h('div', { class: 'set-block' });
        blk.appendChild(h('div', { class: 'set-title' }, '一键清除本机记录'));
        blk.appendChild(h('div', { class: 'set-desc' }, '删除这台设备上的观看历史 / 继续观看、播放进度、最近直播、收藏缓存、浏览和图片缓存、这次打开的会话数据。收藏、设置和登录不受影响；清完页面会刷新。'));
        const back = () => { ui.clear = 0; ui.clearOpts = null; rerender(container); };
        if (ui.clear === 'busy') { blk.appendChild(h('div', { class: 'dgp-warn' }, '正在清除…')); return blk; }
        if (!ui.clear) {
            blk.appendChild(h('button', { type: 'button', class: 'dgp-sbtn danger', 'data-dgp': 'clear', onclick: () => { ui.clear = 1; ui.clearOpts = { server: true, offline: false }; rerender(container); } }, '清除…'));
            return blk;
        }
        const o = ui.clearOpts || (ui.clearOpts = { server: true, offline: false });
        const run = () => {
            ui.clear = 'busy'; say('');
            rerender(container);
            clearLocal({ server: !!o.server, offline: !!o.offline }).then((out) => {
                if (out && serverFailed(out.server)) say('本机已清除；云端观看历史没清掉（网络或服务器出错），刷新后可以再清一次', true);
                else say('已清除，正在刷新…');
                ui.clear = 0; rerender(container);
            }, () => { ui.clear = 0; say('清除出错', true); rerender(container); });
        };
        if (ui.clear === 2) {
            blk.appendChild(h('div', { class: 'dgp-warn', role: 'alert' }, '离线下载删除后没法恢复，要重新下载。确定连离线下载一起删？'));
            blk.appendChild(h('div', null, [
                h('button', { type: 'button', class: 'dgp-sbtn danger', 'data-dgp': 'clearGo2', onclick: run }, '删除离线下载并清除'),
                h('button', { type: 'button', class: 'dgp-sbtn', 'data-dgp': 'clearCancel', onclick: back }, '取消'),
            ]));
            return blk;
        }
        const cb = (key, text) => {
            const i = h('input', { type: 'checkbox', 'data-dgp': 'clear_' + key, checked: !!o[key] });
            i.addEventListener('change', () => { o[key] = !!i.checked; });
            return h('label', { class: 'dgp-chk' }, [i, h('span', null, text)]);
        };
        blk.appendChild(cb('server', '同时清除云端观看历史（登录同步的账号）'));
        blk.appendChild(cb('offline', '同时删除离线下载（还要再确认一次）'));
        blk.appendChild(h('div', null, [
            h('button', { type: 'button', class: 'dgp-sbtn danger', 'data-dgp': 'clearGo', onclick: () => { if (o.offline) { ui.clear = 2; rerender(container); } else run(); } }, '确认清除'),
            h('button', { type: 'button', class: 'dgp-sbtn', 'data-dgp': 'clearCancel', onclick: back }, '取消'),
        ]));
        return blk;
    }

    // ---------- 启动 ----------
    function boot() {
        if (S.booted || !doc) return;
        S.booted = true;
        S.set = loadSettings();
        S.lastActive = now();
        installStorageGuard();
        installNetGuard();
        attachHooks();
        ensureCss();
        const W = root;
        const add = (t, ev, fn, opt) => { try { t.addEventListener(ev, fn, opt); } catch (e) { } };
        add(W, 'keydown', onKeyDown, true);
        add(W, 'keyup', onKeyOther, true);
        add(W, 'keypress', onKeyOther, true);
        add(doc, 'focusin', onFocusIn, true);
        add(doc, 'play', onMediaPlay, true);
        add(doc, 'volumechange', onMediaVolume, true);
        add(doc, 'pause', onActivity, true);   // 闲置从视频停下那刻算(播放期间不算闲置)
        add(doc, 'ended', onActivity, true);
        add(doc, 'visibilitychange', onVisibility);
        add(W, 'pagehide', () => { if (!S.hiddenAt) S.hiddenAt = now(); });
        add(W, 'pageshow', () => { if (!doc.hidden) onVisible(); });
        add(W, 'focus', () => { if (!doc.hidden && S.hiddenAt) onVisible(); });
        ['pointerdown', 'wheel', 'touchstart'].forEach(ev => add(W, ev, onActivity, { capture: true, passive: true }));
        add(W, 'pointermove', onActivity, { capture: true, passive: true });
        add(W, 'touchstart', onTouchStart, { capture: true, passive: true });
        add(W, 'touchmove', onTouchMove, { capture: true, passive: true });
        add(W, 'touchend', onTouchEnd, { capture: true, passive: false });
        add(W, 'resize', () => { if (S.fab) { const p = fabHome(); placeFab(p.x, p.y); } }, { passive: true });
        const go = () => {
            ensureLayer();
            patchAdultBeacon();
            attachHooks();
            if (hasPin() || S.pending === 'lock') engage('lock');
            else if (S.pending === 'boss') engage('boss');
            else htmlClass('dgp-prelock', false);
            S.pending = null;
            applyDisguise(); updateFab(); updateBadge(); applySecure(); scheduleIdle();
            if (S.set.incognito) purgeCaches();   // 上次无痕会话留下的接口 / 图片缓存
        };
        if (doc.body) go(); else add(doc, 'DOMContentLoaded', go, { once: true });
        add(doc, 'DOMContentLoaded', () => { attachHooks(); patchAdultBeacon(); });
        add(W, 'load', () => { attachHooks(); patchAdultBeacon(); });
    }

    const pub = {
        version: VERSION,
        incognito: () => !!(S.set.incognito || S.purge),
        locked: () => !!S.cover,
        cover: () => S.cover,
        hasPin, pinAvailable,
        onChange(fn) { if (typeof fn !== 'function') return () => { }; S.subs.add(fn); return () => { S.subs.delete(fn); }; },
        state,
        boss(on) { toggleBoss(on === true ? true : (on === false ? false : undefined)); return S.cover; },
        lock: lockNow,
        setIncognito(on) { setSetting('incognito', !!on); return !!S.set.incognito; },
        settings: () => Object.assign({}, S.set),
        set(patch) { if (patch && typeof patch === 'object') Object.keys(patch).forEach(k => { if (k in DEFAULTS) setSetting(k, patch[k]); }); return Object.assign({}, S.set); },
        renderSettings,
        vetoHistory,
        registerKeys(o) {
            o = o || {};
            (Array.isArray(o.keys) ? o.keys : []).forEach(k => { if (typeof k === 'string' && k && k.indexOf('dgp_') !== 0) S.extraKeys.add(k); });
            (Array.isArray(o.prefixes) ? o.prefixes : []).forEach(p => { if (typeof p === 'string' && p.length >= 3 && S.extraPrefixes.indexOf(p) < 0 && p.indexOf('dgp_') !== 0) S.extraPrefixes.push(p); });
        },
        isBlockedKey, blocksRequest,
        clearLocal,
        keys: () => ({ keys: INCOG_KEYS.concat(Array.from(S.extraKeys)), prefixes: INCOG_PREFIXES.concat(S.extraPrefixes), clearExtra: CLEAR_EXTRA.slice(), net: NET_BLOCK.slice() }),
    };
    return {
        pub, boot, VERSION, DEFAULTS, INCOG_KEYS, INCOG_PREFIXES, CLEAR_EXTRA, NET_BLOCK, TITLES, ICONS,
        normSettings, isBlockedKey, isClearKey, blocksRequest, lockoutDelay, ctEqual, toHex, fromHex, derive, bossKeyHit,
        setPin, verifyPin, removePin, lockoutLeft, toggleBoss, release, engage, clearLocal, resetDevice, purgeCaches, clearOfflineDb,
        _S: S,
    };
});
