// [adult] 成人站前端(window.DgAdult)。在 index.html 的 <head> 里同步加载,先于 Vue 主脚本:
//   ① 年龄确认门(Vue 之前的全屏遮罩;没点「我已年满18岁」之前不发任何内容请求)
//   ② 站名/标题(document.title 用 /api/config 的 site_name,默认 DGX)
//   ③ 内容接口 401 处理:fetch 包一层 —— 补一次登录核验(会种 dg_t cookie)再重试一次,还不行就出登录框;同源 /api 带 x-dg-token 头
//   ④ 目录(lib/site-catalog)接到首页/分类浏览页:DgCatalog 的替身 catalog(同一套接口,buildQuery 给出 /api/catalog/browse 地址)
//   ⑤ Vue mixin:首页目录行、openWork(按作品键开播放页)、作品线路刷新、海报回退(不走 TMDB)
// 纯函数部分(卡片映射/分类/作品转线路/海报回退)在 node 里可直接 require:scripts/adult-frontend-test.mjs。
// 只在浏览器里(有 window + document)才自动装 fetch 包装和样式;require 时什么副作用都没有。
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && typeof root === 'object' && typeof root.document !== 'undefined') {
        root.DgAdult = api;
        try { api.boot(); } catch (e) { try { console.error('[adult] boot 失败', e); } catch (_) { } }
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
    'use strict';
    const VERSION = 1;
    const DEFAULT_NAME = 'DGX';

    // ---------- 安全的存储读写(隐私模式/被禁用时 localStorage 会抛) ----------
    function lsGet(k) { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } }
    function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, v); return true; } catch (e) { return false; } }

    // ========== 分类(与 lib/adult/taxonomy.json 的 17 个导航桶一致) ==========
    const BUCKET_LABEL = {
        cn_amateur: '国产自拍', cn_studio: '国产传媒', cn_hookup: '探花约炮', live: '主播直播', creators: '网红·福利姬', short: '短视频',
        jp_censored: '日本有码', jp_uncensored: '日本无码', jp_subbed: '中文字幕', western: '欧美', asia: '韩国·东南亚',
        anime: '动漫·里番', softcore: '三级·伦理', ai_drama: 'AI短剧', commentary: 'AV解说', fetish: 'SM·重口', lgbt: '同性·TS',
    };
    const NAV_BUCKETS = Object.keys(BUCKET_LABEL);
    // 首页分类栏 / 浏览页大类:国产 · 日本 · 欧美 · 动漫 · 更多 · 全部(全部 = 不限分类,首页「新上架」「随机发现」的「全部」进这里)
    const TYPES = [
        { k: 'cn', l: '国产', icon: 'fa-video', sort: 'new', buckets: [['cn_amateur', '自拍'], ['cn_studio', '传媒'], ['cn_hookup', '探花'], ['creators', '网红'], ['live', '主播'], ['short', '短视频']] },
        { k: 'jp', l: '日本', icon: 'fa-torii-gate', sort: 'new', buckets: [['jp_censored', '有码'], ['jp_uncensored', '无码'], ['jp_subbed', '中字']] },
        { k: 'west', l: '欧美', icon: 'fa-globe', sort: 'new', buckets: [['western', '欧美']] },
        { k: 'anime', l: '动漫', icon: 'fa-dragon', sort: 'new', buckets: [['anime', '动漫·里番']] },
        { k: 'more', l: '更多', icon: 'fa-ellipsis', sort: 'new', buckets: [['softcore', '三级'], ['fetish', 'SM'], ['lgbt', '同性·TS'], ['commentary', 'AV解说'], ['ai_drama', 'AI短剧'], ['asia', '韩国·东南亚']] },
        { k: 'all', l: '全部', icon: 'fa-layer-group', sort: 'new', buckets: [] },
    ];
    // 浏览页筛选(与 /api/catalog/browse 的参数一一对应;服务器另有 sort=lines,只作并列时的次序,不单独给入口)
    const SORTS = [{ k: 'new', l: '新上架' }, { k: 'dur', l: '时长' }, { k: 'random', l: '随机' }];
    const DURS = [{ k: '', l: '全部' }, { k: 's', l: '10分钟内' }, { k: 'm', l: '10–60分钟' }, { k: 'l', l: '60分钟以上' }];
    const FLAGS = [{ k: '', l: '全部' }, { k: 'zh', l: '中字' }, { k: 'unc', l: '无码' }, { k: 'multi', l: '≥3线' }];
    const typeOf = (k) => TYPES.find(t => t.k === k) || null;
    const typeOfBucket = (b) => { const T = TYPES.find(t => t.buckets.some(x => x[0] === b)); return T ? T.k : 'all'; };
    const optLabel = (arr, k) => { const x = arr.find(o => o.k === k); return x ? x.l : ''; };

    function normSel(tk, sel) {
        const T = typeOf(tk) || TYPES[0], s = sel || {};
        const bs = T.buckets.map(x => x[0]);
        let b = s.b == null ? '' : String(s.b);
        if (!bs.length) b = '';
        else if (bs.indexOf(b) < 0) b = bs[0];   // 大类里不给「全部」:服务器一次只按一个分类筛
        const pick = (v, arr, d) => { const x = v == null ? '' : String(v); return arr.some(o => o.k === x) ? x : d; };
        return { b, dur: pick(s.dur, DURS, ''), flag: pick(s.flag, FLAGS, ''), sort: pick(s.sort, SORTS, T.sort || 'new') };
    }
    function browseUrl(tk, sel, page) {
        const s = normSel(tk, sel);
        const p = Math.max(1, Math.min(500, parseInt(page, 10) || 1));
        const q = [['b', s.b], ['sort', s.sort], ['dur', s.dur], ['flag', s.flag], ['page', String(p)]]
            .filter(([k, v]) => v !== '' || k === 'page')
            .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
        return '/api/catalog/browse?' + q;
    }
    // 目录卡片 → 首页行 / 浏览页卡片用的对象(沿用模板的字段名:id / title / poster_path,另带 _wk/_sub/_badge)
    function cardToItem(c) {
        if (!c || typeof c !== 'object' || typeof c.wk !== 'string' || !c.wk) return null;
        const name = String(c.name || '');
        return {
            id: c.wk, _wk: c.wk, title: name, name: name,
            poster_path: typeof c.pic === 'string' ? c.pic : '',
            _sub: String(c.sub || ''), _badge: String(c.badge || ''), _code: String(c.code || ''),
            _dur: Number(c.dur) || 0, _bucket: String(c.bucket || ''), _n: Number(c.n_sites) || 0,
        };
    }
    function groupsOf(tk, sel) {
        const T = typeOf(tk);
        if (!T) return [];
        const rows = [];
        if (T.buckets.length > 1) rows.push({ k: 'b', l: '分类', opts: T.buckets.map(([k, l]) => ({ k, l })) });
        rows.push({ k: 'dur', l: '时长', opts: DURS.slice() });
        rows.push({ k: 'flag', l: '标记', opts: FLAGS.slice() });
        rows.push({ k: 'sort', l: '排序', opts: SORTS.slice() });
        return rows;
    }
    const QUICK = [['最新上架', { sort: 'new' }], ['中文字幕', { flag: 'zh' }], ['60分钟以上', { dur: 'l' }], ['随机', { sort: 'random' }]];
    function navRows(tk) {
        const T = typeOf(tk);
        if (!T) return [];
        if (T.buckets.length > 1) return [{ l: '分类', items: T.buckets.map(([b, l]) => ({ l, sel: { b } })) }];
        return [{ l: '快速', items: QUICK.map(([l, sel]) => ({ l, sel: Object.assign({}, sel) })) }];
    }
    function title(tk, sel) {
        const T = typeOf(tk);
        if (!T) return '';
        const s = normSel(tk, sel);
        if (T.buckets.length > 1) { const x = T.buckets.find(b => b[0] === s.b); return T.l + ' · ' + (x ? x[1] : ''); }
        return T.l;
    }
    function summary(tk, sel) {
        const s = normSel(tk, sel), parts = [title(tk, s)];
        if (s.dur) parts.push(optLabel(DURS, s.dur));
        if (s.flag) parts.push(optLabel(FLAGS, s.flag));
        parts.push(optLabel(SORTS, s.sort));
        return parts.filter(Boolean).join(' · ');
    }
    const countLabel = (n) => (n >= 10000 ? Math.floor(n / 10000) + '万+' : String(n || 0));
    const TILE = {
        cn_amateur: ['#e52d27', '#9b1b30', 'fa-mobile-screen'], cn_studio: ['#c2306a', '#6d214f', 'fa-clapperboard'], cn_hookup: ['#f7971e', '#c2410c', 'fa-hotel'],
        live: ['#e0437c', '#8e2a62', 'fa-tower-broadcast'], creators: ['#d6457a', '#7b2ff7', 'fa-star'], short: ['#11998e', '#185a9d', 'fa-mobile'],
        jp_censored: ['#8e54e9', '#4776e6', 'fa-torii-gate'], jp_uncensored: ['#b31217', '#5c0a0f', 'fa-fire'], jp_subbed: ['#1d6fa5', '#163a6b', 'fa-closed-captioning'],
        western: ['#2b5cff', '#1e3a8a', 'fa-globe'], asia: ['#5f72bd', '#4a2c7a', 'fa-earth-asia'], anime: ['#ee5a9e', '#9b2fae', 'fa-dragon'],
        softcore: ['#a8763e', '#5b3a29', 'fa-film'], ai_drama: ['#178a6b', '#0f4c45', 'fa-robot'], commentary: ['#e67e22', '#a0402a', 'fa-microphone'],
        fetish: ['#5c2a2a', '#2a0f0f', 'fa-link'], lgbt: ['#f0592a', '#a3301b', 'fa-rainbow'],
    };
    function directory() {
        return {
            hot: NAV_BUCKETS.map(b => {
                const t = TILE[b] || ['#444', '#222', 'fa-film'];
                return { l: BUCKET_LABEL[b], type: typeOfBucket(b), sel: { b }, icon: t[2], bg: 'linear-gradient(135deg, ' + t[0] + ', ' + t[1] + ')' };
            }),
            types: TYPES.filter(T => T.buckets.length).map(T => ({
                k: T.k, l: T.l, icon: T.icon,
                rows: [
                    { l: '分类', items: T.buckets.map(([b, l]) => ({ l: T.buckets.length > 1 ? l : BUCKET_LABEL[b], sel: { b } })) },
                    { l: '时长', items: DURS.filter(d => d.k).map(d => ({ l: d.l, sel: { b: T.buckets[0][0], dur: d.k } })) },
                ],
            })),
        };
    }
    // 搜索框里的分类词 → 浏览页(整词,忽略空格大小写);片名里本来就常带这些词的不收(人妻/巨乳 是标签,不当分类)
    const ALIAS = {};
    (function () {
        const add = (words, b, extra) => words.split(' ').forEach(w => { ALIAS[w] = { b, extra: extra || null }; });
        add('国产 国产自拍 自拍 偷拍自拍', 'cn_amateur');
        add('传媒 国产传媒 麻豆', 'cn_studio');
        add('探花 约炮 探花约炮', 'cn_hookup');
        add('主播 直播 主播直播 女主播', 'live');
        add('网红 福利姬 网红福利姬', 'creators');
        add('短视频 竖屏', 'short');
        add('有码 日本有码 日韩有码', 'jp_censored');
        add('无码 日本无码 无码破解', 'jp_uncensored');
        add('中字 中文字幕 字幕', 'jp_subbed');
        add('欧美 欧美色情 西方', 'western');
        add('韩国 东南亚 韩国东南亚 韩国主播', 'asia');
        add('动漫 里番 动画 hentai 3d动漫', 'anime');
        add('三级 伦理 三级片 伦理片', 'softcore');
        add('ai短剧 短剧', 'ai_drama');
        add('解说 av解说', 'commentary');
        add('sm 重口 调教', 'fetish');
        add('同性 男同 ts 人妖 跨性别 同性ts', 'lgbt');
    })();
    function fromSearch(kw) {
        const k = String(kw || '').replace(/\s+/g, '').toLowerCase();
        if (!k) return null;
        const a = ALIAS[k];
        return a ? { type: typeOfBucket(a.b), sel: { b: a.b } } : null;
    }
    // 首页行的「全部」:行上带的 more({b} / {sort})→ 浏览页预设
    function rowPreset(key, sortMode, cfg) {
        const m = cfg && cfg.more;
        if (!m || typeof m !== 'object') return null;
        if (m.b && BUCKET_LABEL[m.b]) return { type: typeOfBucket(m.b), sel: { b: m.b, sort: m.sort || 'new' } };
        if (m.sort) return { type: 'all', sel: { sort: m.sort } };
        return null;
    }
    // index.html 的 DgCatalog 换成这个(同名同参的接口;TMDB 那套不再被调用)
    const catalog = {
        ADULT: true, DEFAULT_TYPE: 'cn', TYPES, SORTS, NSFW_KW: '',
        typeOf, yearOpts: () => [], yearRange: () => null, normSel,
        buildQuery: (tk, sel, page) => ({ url: browseUrl(tk, sel, page), path: '', media: '', params: {}, map: cardToItem }),
        visible: (it) => !!(it && it.id != null && it.id !== ''),
        groupsOf, navRows, title, summary, countLabel, directory, fromSearch, rowPreset, typeOfBucket,
    };

    // ========== 首页 ==========
    const ROW_ICON = { new: 'fa-clock', random: 'fa-dice' };
    // /api/catalog/home → { configs, lists, order }(键:ad_<行 id>;随机发现也是普通一行,排在最后,不占首页布局里「随机盲盒」的位置)
    function homeToRows(home) {
        const configs = {}, lists = {}, order = [];
        const rows = (home && Array.isArray(home.rows)) ? home.rows : [];
        for (const r of rows) {
            if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_]{1,40}$/.test(r.id)) continue;
            // 只读展示:冻结 = 不做深层响应式(首页十几行 × 24 张)
            const items = (Array.isArray(r.items) ? r.items : []).map(cardToItem).filter(Boolean).map(Object.freeze);
            if (!items.length) continue;
            const key = 'ad_' + r.id;
            if (configs[key]) continue;
            configs[key] = {
                title: String(r.title || BUCKET_LABEL[r.id] || ''), icon: ROW_ICON[r.id] || ((TILE[r.id] || [])[2]) || 'fa-film',
                path: 'ADULT', params: '', page: 1, totalPages: 1, adult: true,
                more: (r.more && typeof r.more === 'object') ? Object.assign({}, r.more) : null,
                today: Math.max(0, Number(r.today) || 0),
            };
            lists[key] = items;
            order.push(key);
        }
        return { configs, lists, order };
    }
    // /api/catalog/buckets → { 桶 id: 今日新增 }
    function todayMap(list) {
        const o = {};
        for (const b of Array.isArray(list) ? list : []) if (b && typeof b.id === 'string' && BUCKET_LABEL[b.id]) o[b.id] = Math.max(0, Number(b.today) || 0);
        return o;
    }
    // 大类 = 名下各桶之和;桶 id 直接取
    function todayOf(map, k) {
        if (!k || !map) return 0;
        if (Object.prototype.hasOwnProperty.call(map, k)) return map[k] || 0;
        const T = typeOf(k);
        return T ? T.buckets.reduce((n, b) => n + (map[b[0]] || 0), 0) : 0;
    }

    // ========== 作品 / 线路 ==========
    function workUrl(wk, expand) { return '/api/catalog/work?k=' + encodeURIComponent(wk) + (expand ? '&expand=1' : ''); }
    // /api/catalog/work 的线路 → 和搜索结果同形的线路(openDetail / refreshSources 都认)
    function workSource(s) {
        if (!s || typeof s !== 'object' || !s.site_key || s.vod_id == null) return null;
        const o = {
            site_key: String(s.site_key), site_name: String(s.site_name || s.site_key), vod_id: s.vod_id, vod_name: String(s.vod_name || ''),
            vod_pic: String(s.vod_pic || ''), type_name: String(s.type_name || ''), vod_play_url: String(s.vod_play_url || ''),
            site_profile: s.site_profile || null, _variant: String(s._variant || ''), _dur: Number(s._dur) || 0,
        };
        if (s.vod_play_from) o.vod_play_from = String(s.vod_play_from);
        return o;
    }
    function workToGroup(w) {
        if (!w || typeof w !== 'object' || typeof w.name !== 'string' || !w.name) return null;
        const wk = typeof w._wk === 'string' ? w._wk : '';
        const seen = new Set(), sources = [];
        for (const s of Array.isArray(w.sources) ? w.sources : []) {
            const x = workSource(s);
            if (!x || seen.has(x.site_key)) continue;   // 一站一条(服务器已按中字优先挑过)
            seen.add(x.site_key);
            x.latency = 999;
            sources.push(x);
        }
        if (!sources.length) return null;
        let pic = typeof w.pic === 'string' ? w.pic : '';
        if (!pic) { const p = sources.find(s => /^https?:\/\//i.test(s.vod_pic)); pic = p ? p.vod_pic : ''; }
        return { name: w.name, pic, _wk: wk, _meta: (w._meta && typeof w._meta === 'object') ? w._meta : null, sources };
    }
    function workToList(w) {
        const g = workToGroup(w);
        return { list: g ? g.sources.map(s => { const o = Object.assign({}, s); delete o.latency; return o; }) : [], _adult: true, name: g ? g.name : '' };
    }
    // 搜索结果分组键/卡片名:有作品键按作品并(各站片名常不同),名字用规范名
    const groupKeyOf = (it) => (it && typeof it._wk === 'string' && it._wk) ? it._wk : (it ? it.vod_name : '');
    const groupNameOf = (it) => (it && typeof it._wt === 'string' && it._wt) ? it._wt : (it ? it.vod_name : '');
    // 横版封面(日本有码常见 800×538)放进 2:3 位:人物在右半边 → object-position: right
    const isLandscape = (w, h) => w > 0 && h > 0 && (w / h) > 1.3;
    // 海报坏了:换这一组里另一条线路的海报(没试过的、不是 mac_default/nopic 占位);都试过 → ''(显示中性占位)
    function pickFallbackPic(group, tried) {
        const bad = (u) => !u || !/^https?:\/\//i.test(u) || /mac_default|nopic/i.test(u);
        const t = tried || new Set();
        for (const s of (group && Array.isArray(group.sources)) ? group.sources : []) {
            const u = s && String(s.vod_pic || '').trim();
            if (!bad(u) && !t.has(u)) return u;
        }
        return '';
    }
    const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='450'%3E%3Crect fill='%23262626' width='300' height='450'/%3E%3Cpath d='M120 190h60v70h-60z' fill='%23444'/%3E%3C/svg%3E";

    // ========== 内容接口鉴权(401 → 补核验 → 重试一次 → 登录框) ==========
    const CONTENT_RE = /^\/api\/(search|detail|check|sites|catalog|popular|kz)(\/|$)/;
    function sameOriginPath(url, base) {
        try {
            const U = new URL(String(url), base);
            const B = new URL(base);
            return U.origin === B.origin ? U.pathname : null;
        } catch (e) { return null; }
    }
    const isContentPath = (p) => typeof p === 'string' && CONTENT_RE.test(p);

    // ========== 年龄确认门 ==========
    const AGE_KEY = 'dg_age_ok';
    const ageGate = (function () {
        let ok = false, resolve = null, el = null;
        const ready = new Promise(r => { resolve = r; });
        function accepted() { return ok || lsGet(AGE_KEY) === '1'; }
        // 服务器(没配访问密码时)按 dg_age=1 放行内容接口;每次确认过的页面加载都重种一遍(Safari 会把脚本种的 Cookie 7 天清掉)
        function setCookie() { try { if (root.document) root.document.cookie = 'dg_age=1; Path=/; Max-Age=31536000; SameSite=Lax'; } catch (e) { } }
        function done() { ok = true; setCookie(); if (resolve) { resolve(true); resolve = null; } }
        function accept() {
            lsSet(AGE_KEY, '1');
            setCookie();
            if (el && el.parentNode) el.parentNode.removeChild(el);
            el = null;
            try { root.document.documentElement.classList.remove('dg-age-lock'); } catch (e) { }
            done();
        }
        function leave() { try { root.location.replace('about:blank'); } catch (e) { root.location.href = 'about:blank'; } }
        function build() {
            const d = root.document;
            const wrap = d.createElement('div');
            wrap.className = 'dg-age';
            wrap.setAttribute('role', 'dialog');
            wrap.setAttribute('aria-modal', 'true');
            wrap.setAttribute('aria-labelledby', 'dg-age-title');
            const card = d.createElement('div');
            card.className = 'dg-age-card';
            const badge = d.createElement('div');
            badge.className = 'dg-age-badge';
            badge.textContent = '18+';
            const h = d.createElement('h1');
            h.id = 'dg-age-title';
            h.textContent = brand.name();
            const p = d.createElement('p');
            p.textContent = '本站包含成人内容，仅限年满 18 周岁且所在地法律允许的用户访问。';
            const btns = d.createElement('div');
            btns.className = 'dg-age-btns';
            const yes = d.createElement('button');
            yes.type = 'button'; yes.className = 'dg-age-enter'; yes.textContent = '我已年满18岁，进入';
            yes.addEventListener('click', accept);
            const no = d.createElement('button');
            no.type = 'button'; no.className = 'dg-age-leave'; no.textContent = '离开';
            no.addEventListener('click', leave);
            btns.appendChild(yes); btns.appendChild(no);
            card.appendChild(badge); card.appendChild(h); card.appendChild(p); card.appendChild(btns);
            wrap.appendChild(card);
            // 遥控器/键盘:左右/上下在两个按钮间切,焦点不出这层
            wrap.addEventListener('keydown', (e) => {
                const k = e.key;
                if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' || k === 'Tab') {
                    e.preventDefault(); e.stopPropagation();
                    (d.activeElement === yes ? no : yes).focus();
                }
            });
            return { wrap, yes };
        }
        function mount() {
            if (accepted()) { done(); return; }
            const d = root.document;
            if (!d.body) { d.addEventListener('DOMContentLoaded', mount, { once: true }); return; }
            if (el) return;
            try { d.documentElement.classList.add('dg-age-lock'); } catch (e) { }
            const b = build();
            el = b.wrap;
            d.body.insertBefore(el, d.body.firstChild);
            try { b.yes.focus(); } catch (e) { }
        }
        if (accepted()) done();
        return { KEY: AGE_KEY, accepted, whenAccepted: () => ready, mount, accept, leave };
    })();

    // ========== 站名 ==========
    const brand = (function () {
        const KEY = 'dg_site_name';
        const clean = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
        function name() { return clean(lsGet(KEY)) || DEFAULT_NAME; }
        function apply(n) {
            const v = clean(n) || DEFAULT_NAME;
            lsSet(KEY, v);
            if (typeof root.document === 'undefined') return v;
            try { root.document.title = v; } catch (e) { }
            try {
                root.document.querySelectorAll('[data-dg-brand]').forEach(el => { el.textContent = v; });
                const m = root.document.querySelector('meta[name="apple-mobile-web-app-title"]');
                if (m) m.setAttribute('content', v);
            } catch (e) { }
            return v;
        }
        return { KEY, name, apply, clean };
    })();

    // ========== fetch 包装 ==========
    const auth = (function () {
        let origFetch = null, inflight = null, lastAt = 0, lastOk = false, loginShown = false;
        const tokenOf = () => lsGet('emax_auth_hash') || '';
        async function doReauth() {
            const type = lsGet('emax_auth_type');
            if (type === 'v2board' && typeof root.revalidateV2boardSession === 'function') {
                // 机场账户:面板令牌核实一遍(成功时写回新的本站令牌,服务器同时种 dg_t);断网/限流它也回 true —— 交给重试判定
                return (await root.revalidateV2boardSession()) === true;
            }
            const hash = tokenOf();
            if (!hash) return false;
            const r = await origFetch('/api/auth/verify', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passwordHash: hash }),
            });
            const d = await r.json().catch(() => null);
            return !!(d && d.success);
        }
        // 同一时间只核验一次;20s 内的结果直接复用(一页里几十个并发请求同时 401 不会各自去核验)
        function reauth() {
            if (inflight) return inflight;
            if (Date.now() - lastAt < 20000) return Promise.resolve(lastOk);
            inflight = Promise.resolve().then(doReauth).catch(() => false).then(ok => {
                inflight = null; lastAt = Date.now(); lastOk = !!ok;
                return lastOk;
            });
            return inflight;
        }
        // 核验后仍是 401:出登录框。登录成功(startApp)后整页刷新 —— 应用早已初始化过,startApp 本身不会重拉首页
        function loginRequired() {
            if (loginShown) return;
            loginShown = true;
            const prev = root.startApp;
            root.startApp = function () {
                root.startApp = prev;
                setTimeout(() => { try { root.location.reload(); } catch (e) { } }, 30);
                return Promise.resolve();
            };
            try { if (typeof root.showLoginScreen === 'function') root.showLoginScreen(); } catch (e) { }
        }
        const isAuthRequired = (res) => res.clone().json().then(b => !!(b && b.error === 'AUTH_REQUIRED')).catch(() => false);
        function install() {
            if (origFetch || typeof root.fetch !== 'function') return;
            origFetch = root.fetch.bind(root);
            root.fetch = function (input, init) {
                const plain = typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL);
                if (!plain) return origFetch(input, init);
                const path = sameOriginPath(input, root.location.href);
                if (!path || path.indexOf('/api/') !== 0) return origFetch(input, init);
                const tok = tokenOf();
                let opts = init;
                if (tok) {
                    opts = Object.assign({}, init || {});
                    const h = new Headers(opts.headers || {});
                    if (!h.has('x-dg-token')) h.set('x-dg-token', tok);
                    opts.headers = h;
                }
                const go = () => origFetch(input, opts);
                if (!isContentPath(path)) return go();
                // 内容接口带年龄确认头(Cookie 被清掉时服务器也认);只在确认之后才会真正发出
                opts = Object.assign({}, opts || {});
                { const h = new Headers(opts.headers || {}); h.set('x-dg-age', '1'); opts.headers = h; }
                // 年龄确认之前不发内容请求(兜底:正常流程里登录门要等确认后才启动)
                const first = ageGate.accepted() ? go() : ageGate.whenAccepted().then(go);
                return first.then(res => {
                    if (!res || res.status !== 401) return res;
                    return isAuthRequired(res).then(yes => {
                        if (!yes) return res;
                        return reauth().then(ok => {
                            if (!ok) { loginRequired(); return res; }
                            // 重试时用新令牌(v2board 核验会换本站令牌)
                            const t2 = tokenOf();
                            if (t2 && opts && opts.headers) { try { opts.headers.set('x-dg-token', t2); } catch (e) { } }
                            return go().then(r2 => { if (r2 && r2.status === 401) loginRequired(); return r2; });
                        });
                    });
                });
            };
        }
        // 搜索走 EventSource(拿不到状态码):出错且一条结果都没有时用一个轻量内容接口探一下,401 会走上面的核验/重试
        function ensure() {
            if (!root.fetch) return Promise.resolve(false);
            return root.fetch('/api/catalog/buckets', { cache: 'no-store', credentials: 'same-origin' })
                .then(r => !!r && r.status !== 401).catch(() => false);
        }
        // 主动退出登录:服务器清 dg_t(keepalive:页面马上要刷新)
        function logout() {
            const f = origFetch || root.fetch;
            if (typeof f !== 'function') return Promise.resolve();
            try { return f('/api/auth/logout', { method: 'POST', credentials: 'same-origin', keepalive: true }).then(() => { }, () => { }); }
            catch (e) { return Promise.resolve(); }
        }
        return { install, reauth, ensure, logout, loginRequired, isAuthRequired };
    })();

    // ========== 作品请求(浏览器里用) ==========
    function fetchJson(url, ms) {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const t = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { } }, ms || 10000) : 0;
        return root.fetch(url, ctl ? { signal: ctl.signal, credentials: 'same-origin' } : { credentials: 'same-origin' })
            .then(r => (r && r.ok) ? r.json() : null)
            .catch(() => null)
            .then(d => { if (t) clearTimeout(t); return d; });
    }
    // 作品 → openDetail 用的 group;expand=true 时服务器现搜各站补线路(最多 ~20s)
    const fetchWork = (wk, expand) => fetchJson(workUrl(wk, expand), expand ? 25000 : 10000).then(workToGroup);

    // ========== 样式 ==========
    const CSS = [
        'html.dg-age-lock, html.dg-age-lock body { overflow: hidden !important; }',
        // 成人站没有首页轮播(TMDB 本周热门):整个空壳藏掉
        '#heroCarousel { display: none !important; }',
        // 不分享:播放器里的「分享当前画面」相机图标 / 手机齿轮菜单那一行 / 分享面板里的入口都藏掉(方法本身也拦了)
        '#dplayer .dplayer-frame-icon, #dplayer .dg-mob-row[data-dg="frame"], .fshare-entry { display: none !important; }',
        '.dg-age { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 2147483647; background: #0b0b0b; color: #eee; display: flex; align-items: center; justify-content: center; padding: 24px 16px; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }',
        '.dg-age-card { width: 100%; max-width: 420px; text-align: center; }',
        '.dg-age-badge { width: 76px; height: 76px; margin: 0 auto 18px; border-radius: 50%; border: 3px solid #e50914; color: #e50914; font-size: 26px; font-weight: 800; display: flex; align-items: center; justify-content: center; }',
        '.dg-age h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff; }',
        '.dg-age p { font-size: 15px; line-height: 1.8; color: #bbb; margin: 0; }',
        '.dg-age-btns { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 26px; }',
        '.dg-age-btns button { min-height: 44px; padding: 0 22px; border-radius: 22px; font-size: 15px; cursor: pointer; border: 1px solid transparent; }',
        '.dg-age-enter { background: #e50914; color: #fff; font-weight: 600; }',
        '.dg-age-leave { background: transparent; color: #ccc; border-color: #555 !important; }',
        '.dg-age-btns button:focus { outline: 3px solid #fff; outline-offset: 2px; }',
        '.dg-ad-badge { position: absolute; top: 6px; left: 6px; z-index: 2; background: rgba(229, 9, 20, 0.92); color: #fff; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; pointer-events: none; }',
        '.dg-today { margin-left: 4px; font-size: 10px; font-weight: 700; color: #46d369; }',
        '.dg-today-row { margin-left: 10px; font-size: 12px; font-weight: 600; color: #46d369; white-space: nowrap; }',
        '.poster-wrap img.dg-land { object-position: right center; }',
        '.movie-date.dg-ad-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    ].join('\n');
    function injectCss() {
        const d = root.document;
        if (!d || d.getElementById('dg-adult-css')) return;
        const s = d.createElement('style');
        s.id = 'dg-adult-css';
        s.textContent = CSS;
        (d.head || d.documentElement).appendChild(s);
    }
    // 首页行 / 浏览页的海报:加载完按宽高比放横版封面;坏图换中性占位(不走 TMDB)
    function hookImages() {
        const d = root.document;
        const inCard = (img) => img && img.tagName === 'IMG' && img.closest && img.closest('.hot-card .poster-wrap, .browse-card .poster-wrap');
        d.addEventListener('load', (e) => {
            const img = e.target;
            if (!inCard(img)) return;
            if (isLandscape(img.naturalWidth, img.naturalHeight)) img.classList.add('dg-land');
            else img.classList.remove('dg-land');
        }, true);
        d.addEventListener('error', (e) => {
            const img = e.target;
            if (!inCard(img) || img.getAttribute('data-dg-fb') === '1') return;
            img.setAttribute('data-dg-fb', '1');
            img.src = PLACEHOLDER;
        }, true);
    }
    function boot() {
        injectCss();
        brand.apply(brand.name());
        // loader / 登录框里的站名节点在 <head> 之后才解析出来:DOM 就绪时按上次缓存的站名再写一遍(/api/config 回来后 adultApplyConfig 再更新)
        try { root.document.addEventListener('DOMContentLoaded', () => brand.apply(brand.name()), { once: true }); } catch (e) { }
        auth.install();
        hookImages();
    }

    // ========== Vue mixin(index.html 的 createApp 里 mixins: [DgAdult.mixin]) ==========
    //   方法名都带 ad 前缀(openWork 除外),scripts/adult-frontend-test.mjs 校验不与主组件的 methods/computed/data 重名
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const mixin = {
        data() {
            return {
                adultMode: true,
                adult: { catalog: false, intro: false, siteName: brand.name(), today: {}, home: 'idle' },
            };
        },
        // 主组件 data 之后、第一次渲染之前:首页榜单起步为空(不先渲染一排 TMDB 榜单标题,adultLoadHome 整个换掉);
        //   分类栏默认大类换成目录版的(主组件按 localStorage 记的 TMDB 大类起步)
        created() {
            this.rowConfigs = {};
            this.rowLists = {};
            if (!catalog.typeOf(this.catNavType)) this.catNavType = catalog.DEFAULT_TYPE;
        },
        watch: {
            // 从首页行 / 浏览页开的播放页关掉后回到原来的滚动位置(closeDetail 会先滚回顶部)
            showDetail(v) {
                if (v || this._adReturnY == null) return;
                const y = this._adReturnY;
                this._adReturnY = null;
                this.$nextTick(() => { try { this._jumpTo(y); } catch (e) { } });
            },
        },
        methods: {
            adultApplyConfig(config) {
                const c = config || {};
                this.adult.catalog = c.catalog === true;
                this.adult.intro = c.intro_enabled === true;   // 站长显式开了片头学习(INTRO_DISABLE=0)才显示那两行设置
                this.adult.siteName = brand.apply(c.site_name);
            },
            // 首页:目录各行(最多等 6s,与原来的 Hero 一样不挂死 loader);分类栏的「今日」数后台拉
            async adultLoadHome() {
                if (!this.adult.catalog) { this.adult.home = 'off'; return; }
                this.adult.home = 'loading';
                this.adultLoadBuckets();
                const p = fetchJson('/api/catalog/home', 15000);
                const d = await Promise.race([p, sleep(6000).then(() => 'slow')]);
                const apply = (home) => {
                    const r = homeToRows(home);
                    this.rowLists = Object.assign({}, r.lists);
                    this.rowConfigs = Object.assign({}, r.configs);
                    this.adult.home = r.order.length ? 'ok' : 'empty';
                };
                if (d === 'slow') {   // 先放行进应用,同一个请求回来后再填首页
                    p.then(h => { if (h) apply(h); else this.adult.home = 'error'; });
                    return;
                }
                if (d) apply(d); else this.adult.home = 'error';
            },
            async adultLoadBuckets() {
                const b = await fetchJson('/api/catalog/buckets', 10000);
                if (Array.isArray(b)) this.adult.today = Object.freeze(todayMap(b));
            },
            adToday(k) { return todayOf(this.adult && this.adult.today, k); },
            // 首页行 / 浏览页卡片 → 播放页。≥2 条线路:立刻打开,后台 expand=1 找更多线路;不足 2 条:加载帧等 expand(最多 4s)
            async openWork(card) {
                const wk = card && (card._wk || card.wk);
                if (!wk || typeof wk !== 'string') return;
                const seq = (this._adWorkSeq = (this._adWorkSeq || 0) + 1);
                if (!this.showDetail) this._adReturnY = (typeof root.scrollY === 'number' ? root.scrollY : 0);
                const name = String((card && (card.title || card.name)) || '');
                const pic = String((card && (card.poster_path || card.pic)) || '');
                const g = await fetchWork(wk, false);
                if (seq !== this._adWorkSeq) return;
                if (g && g.sources.length >= 2) {
                    Promise.resolve(this.openDetail(g)).catch(e => console.warn('[adult] openDetail', e));
                    this._adExpandLater(wk, g.sources.length, null);
                    return;
                }
                this._adShowFrame(wk, (g && g.name) || name, (g && g.pic) || pic, g ? g.sources.length : 0);
                const frame = this.currentGroup;
                const exP = fetchWork(wk, true);
                const ex = await Promise.race([exP, sleep(4000).then(() => null)]);
                // 用户在等待期间关掉了 / 开了别的
                if (seq !== this._adWorkSeq || !this.showDetail || this.currentGroup !== frame) return;
                const best = (ex && (!g || ex.sources.length >= g.sources.length)) ? ex : g;
                if (!best) {
                    // 4s 内没回来:接着等 expand(最长 25s),还没有线路才放弃
                    const late = ex || await exP;
                    if (seq !== this._adWorkSeq || !this.showDetail || this.currentGroup !== frame) return;
                    if (!late) { this._adCloseFrame(); if (this.showMiniToast) this.showMiniToast('暂时没有可播放的线路'); return; }
                    Promise.resolve(this.openDetail(late)).catch(e => console.warn('[adult] openDetail', e));
                    return;
                }
                Promise.resolve(this.openDetail(best)).catch(e => console.warn('[adult] openDetail', e));
                if (!ex) this._adExpandLater(wk, best.sources.length, exP);
            },
            // 搜索框回车:先查本地目录(/api/catalog/lookup,零上游)。番号查询恰好命中一部作品 → 直接开作品页(线路由 expand 现搜补齐),
            //   返回 true,调用方不再全站扇出;其余情况(文字查询 / 没命中 / 多个变体 / 目录不可用 / 1.5s 没回)返回 false,照常搜索
            async adLookupOpen(kw) {
                const q = String(kw == null ? '' : kw).trim();
                if (!this.adult.catalog || !q || q.length > 100) return false;
                const d = await fetchJson('/api/catalog/lookup?q=' + encodeURIComponent(q) + '&limit=2', 1500);
                const r = d && d.kind === 'code' && Array.isArray(d.results) && d.results.length === 1 ? d.results[0] : null;
                if (!r || typeof r.wk !== 'string' || r.wk.indexOf('c:') !== 0) return false;
                this.openWork(cardToItem(r));
                return true;
            },
            // 加载帧(与已登录深链同一个播放页框架)
            _adShowFrame(wk, name, pic, n) {
                try { if (this._cancelDeepLink) this._cancelDeepLink(true); } catch (e) { }
                this.previewLocked = false;
                this.deepLinkLoading = true;
                this.currentGroup = { name: name || '', pic: pic || '', sources: [], _wk: wk };
                this.currentSource = null;
                this.episodeList = [];
                this.currentUrl = '';
                this.isTestingSources = true;
                this.deepLinkSourceCount = n || 0;
                this.showDetail = true;
                try { root.document.body.classList.add('detail-open'); } catch (e) { }
            },
            _adCloseFrame() {
                if (typeof this.closeDetail === 'function') this.closeDetail();
                else { this.deepLinkLoading = false; this.isTestingSources = false; this.showDetail = false; }
            },
            // 后台 expand 拿到更多线路 → 等这一轮测速结束,同一部还开着就刷新线路(refreshSources 会直接用这份结果,不再请求)
            _adExpandLater(wk, have, p) {
                const exP = p || fetchWork(wk, true);
                exP.then(async (ex) => {
                    if (!ex || ex.sources.length <= have) return;
                    this._adPrefetch = { wk, at: Date.now(), list: workToList({ name: ex.name, pic: ex.pic, _wk: wk, sources: ex.sources }) };
                    for (let i = 0; i < 90; i++) {
                        const g = this.currentGroup;
                        if (!this.showDetail || !g || g._wk !== wk) return;
                        if (!this.isTestingSources && !this.refreshingSources) {
                            if ((g.sources || []).length >= ex.sources.length) return;
                            try { await this.refreshSources(); } catch (e) { }
                            return;
                        }
                        await sleep(1000);
                    }
                }).catch(() => { });
            },
            // refreshSources / refreshEpisodes 的成人分支:按作品键取线路(1 分钟内后台刚拿到的直接用,否则 expand=1)
            async _adWorkList(wk) {
                const pf = this._adPrefetch;
                if (pf && pf.wk === wk && Date.now() - pf.at < 60000) { this._adPrefetch = null; return pf.list; }
                const d = await fetchJson(workUrl(wk, true), 25000);
                return d ? workToList(d) : { list: [], _adult: true, name: '' };
            },
            // 搜索结果海报坏了:换同组另一条线路的海报,都不行显示中性占位(poster-fallback)。绝不查 TMDB
            _adImgFallback(key) {
                const g = (this.groupedList || []).find(x => this.posterKey(x) === key);
                if (!g) return;   // 搜索流里缺图的单条:分组时已挑别的线路的海报
                const tried = (this._adImgTried = this._adImgTried || Object.create(null));
                const set = tried[key] || (tried[key] = new Set());
                const cur = this.imageMap[key] || g.pic;
                if (cur) set.add(cur);
                const next = pickFallbackPic(g, set);
                if (next) { set.add(next); this.imageMap[key] = next; }
                else this.fallbackMap[key] = true;
            },
        },
    };

    return {
        ON: true, VERSION, DEFAULT_NAME,
        BUCKET_LABEL, NAV_BUCKETS, TYPES, SORTS, DURS, FLAGS,
        catalog, cardToItem, browseUrl, homeToRows, todayMap, todayOf,
        workUrl, workSource, workToGroup, workToList, groupKeyOf, groupNameOf, isLandscape, pickFallbackPic, PLACEHOLDER,
        isContentPath, sameOriginPath,
        ageGate, brand, auth, fetchWork, mixin, boot,
    };
});
