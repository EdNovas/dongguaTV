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
    const VERSION = 3;
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
    // 标签(与 lib/adult/taxonomy.json 的 tags 一致;服务器 /api/catalog/tags 给的 label 优先,这里只是兜底名)
    const TAG_LABEL = {
        milf: '人妻熟女', busty: '巨乳美乳', uniform: '制服诱惑', legs: '丝袜美腿', cosplay: 'Cosplay', incest: '乱伦剧情', noncon: '强制凌辱',
        group: '群交多P', ntr: '绿帽NTR', oral: '口交颜射', solo: '自慰', squirt: '潮吹', bdsm: 'SM调教', extreme: '重口猎奇', outdoor: '野外露出',
        lesbian: '女同', gay: '男同', trans: '跨性别', vr: 'VR', amateur: '素人', pornstar: '女优明星', bbc: '黑人', massage: '按摩技师',
        story: '剧情', uncensored: '无码', subbed: '中字', hktw: '港台', korea: '韩国', beauty: '高颜值', studio: '厂牌',
    };
    // 审查类标签:服务器说 featured 也绝不做成导航/作品页的标签按钮(只在浏览页里作为已选条件出现)。fail-closed:服务器漏标时这里兜住
    //   phase 3 词表(lib/adult/tag-vocab.json)的 23 个 review 标签全在这里;blocked 的 x_* 一律不认(isBlockedTag)
    const NEVER_FEATURE = new Set(['noncon', 'rape', 'rape-play', 'incest', 'hypnosis', 'time-stop', 'timestop', 'sleep', 'drunk', 'aphrodisiac', 'drug', 'voyeur', 'teen', 'schoolgirl',
        'small_tits', 'pregnant', 'lactation', 'college', 'teacher', 'exhibition', 'train', 'pee', 'fisting', 'extreme', 'escort', 'chikan', 'virgin', 'cherry', 'humiliation', 'g_horror']);
    const isBlockedTag = (id) => typeof id === 'string' && /^x_/i.test(id);
    // 这些分类的人多是素人/主播/网红本人:作品页不出演员名(服务器也不该给,两头都拦)
    const NO_ACTRESS_BUCKETS = new Set(['cn_amateur', 'cn_hookup', 'live', 'creators']);
    const TAG_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
    const validTag = (t) => typeof t === 'string' && TAG_ID_RE.test(t);
    // 能做成按钮 / 标签云 / 相关标签的:合法 id、不是审查类、不是 blocked
    const featurable = (id) => validTag(id) && !NEVER_FEATURE.has(id) && !isBlockedTag(id);
    const tagLabels = Object.create(null);   // 运行时从 /api/catalog/tags、搜索建议、作品信息里学到的标签名
    const tagLabel = (id) => (validTag(id) ? (tagLabels[id] || TAG_LABEL[id] || id) : '');
    const learnTag = (id, label) => { const l = cleanText(label, 20); if (validTag(id) && l) tagLabels[id] = l; };
    function cleanText(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max || 40); }
    function fmtDur(sec) {
        sec = Math.round(Number(sec) || 0);
        if (!(sec > 0)) return '';
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        const p2 = (x) => String(x).padStart(2, '0');
        return h ? h + ':' + p2(m) + ':' + p2(s) : m + ':' + p2(s);
    }
    // 首页分类栏 / 浏览页大类:国产 · 日本 · 欧美 · 动漫 · 更多 · 全部(全部 = 不限分类,首页「新上架」「随机发现」的「全部」进这里)
    const TYPES = [
        { k: 'cn', l: '国产', icon: 'fa-video', sort: 'new', buckets: [['cn_amateur', '自拍'], ['cn_studio', '传媒'], ['cn_hookup', '探花'], ['creators', '网红'], ['live', '主播'], ['short', '短视频']] },
        { k: 'jp', l: '日本', icon: 'fa-torii-gate', sort: 'new', buckets: [['jp_censored', '有码'], ['jp_uncensored', '无码'], ['jp_subbed', '中字']] },
        { k: 'west', l: '欧美', icon: 'fa-globe', sort: 'new', buckets: [['western', '欧美']] },
        { k: 'anime', l: '动漫', icon: 'fa-dragon', sort: 'new', buckets: [['anime', '动漫·里番']] },
        { k: 'more', l: '更多', icon: 'fa-ellipsis', sort: 'new', buckets: [['softcore', '三级'], ['fetish', 'SM'], ['lgbt', '同性·TS'], ['commentary', 'AV解说'], ['ai_drama', 'AI短剧'], ['asia', '韩国·东南亚']] },
        { k: 'all', l: '全部', icon: 'fa-layer-group', sort: 'new', buckets: [] },
    ];
    // 浏览页筛选(phase 3,与 /api/catalog/browse 的参数一一对应):
    //   排序 7 种(服务器 facets.sorts 说哪些这次可用,只显示可用的;没给 facets 时按 DEFAULT_SORTS)/ 时长 6 档(含「时长未知」)/
    //   版本 6 种(单选)/ 标签 t ≤3(AND)/ 排除 x ≤3 / 厂牌 studio / 女优 actress(aid)/ 旧的厂牌前缀 lp
    const SORTS = [
        { k: 'new', l: '最新上架' }, { k: 'updated', l: '最近更新' }, { k: 'released', l: '发行日期' }, { k: 'hot', l: '热门' },
        { k: 'dur', l: '时长' }, { k: 'lines', l: '线路最多' }, { k: 'rand', l: '随机' },
    ];
    const SORT_ALIAS = { random: 'rand', release: 'released' };   // 旧地址 / 首页「随机发现」行的 more 还是 random
    const DEFAULT_SORTS = ['new', 'dur', 'lines', 'rand'];
    const DURS = [{ k: '', l: '全部' }, { k: 's', l: '10分钟内' }, { k: 'm', l: '10–30分钟' }, { k: 'l', l: '30–60分钟' }, { k: 'xl', l: '1–2小时' }, { k: 'xxl', l: '2小时以上' }, { k: 'unk', l: '时长未知' }];
    const VARIANTS = [{ k: '', l: '全部' }, { k: 'zh', l: '中字' }, { k: 'unc', l: '无码' }, { k: 'leak', l: '流出' }, { k: 'vr', l: 'VR' }, { k: '4k', l: '4K' }, { k: 'vertical', l: '竖屏' }];
    const FLAG_TO_V = { zh: 'zh', unc: 'unc' };   // phase 2 的 flag=(中字/无码)→ v=;flag=multi(≥3线)没有对应,丢掉
    const MAX_T = 3, MAX_X = 3;
    // 9 个分面组(与 lib/adult/tag-vocab.json 的 groups 同序;服务器给的 label 优先)
    const GROUPS = [
        { id: 'spec', label: '规格' }, { id: 'origin', label: '来源·人物' }, { id: 'body', label: '身材·外貌' }, { id: 'persona', label: '身份·职业' },
        { id: 'outfit', label: '服装·制服' }, { id: 'setting', label: '场景·地点' }, { id: 'act', label: '玩法·类型' }, { id: 'story', label: '剧情·关系' }, { id: 'genre', label: '题材' },
    ];
    const groupLabels = Object.create(null);
    const groupLabel = (id) => groupLabels[id] || ((GROUPS.find(g => g.id === id) || {}).label) || '';
    // 女优 id:AVDB 的 aid 是整数(行号),也认字符串 id(与 lib/adult-gate 的 actress 白名单同字符集);一律转成字符串用
    const AID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,39}$/;
    const aidStr = (a) => (typeof a === 'number' && Number.isInteger(a) && a > 0 && a < 1e15) ? String(a) : ((typeof a === 'string' && AID_RE.test(a)) ? a : '');
    const validAid = (a) => !!aidStr(a);
    // 厂牌键:服务器 facets.studio[].id / 作品 _meta.maker(片商名,不是片名);只去掉控制字符和尖括号
    const cleanStudio = (s) => (typeof s === 'string' ? cleanText(s, 80).replace(/["`\\]/g, '') : '');   // 与服务器 studio 白名单一致(≤80,不含双引号/反引号/反斜杠;单引号留着:M's video 这类片商名)
    const studioLabels = Object.create(null), actressNames = Object.create(null);
    const learnStudio = (id, l) => { const k = cleanStudio(id), v = cleanText(l, 40); if (k && v) studioLabels[k] = v; };
    const learnActress = (aid, n) => { const v = cleanText(n, 40), k = aidStr(aid); if (k && v) actressNames[k] = v; };
    const studioLabel = (id) => studioLabels[id] || id || '';
    const actressName = (aid) => { const k = aidStr(aid); return k ? actressNames[k] || '' : ''; };
    const typeOf = (k) => TYPES.find(t => t.k === k) || null;
    const typeOfBucket = (b) => { const T = TYPES.find(t => t.buckets.some(x => x[0] === b)); return T ? T.k : 'all'; };
    const optLabel = (arr, k) => { const x = arr.find(o => o.k === k); return x ? x.l : ''; };
    const sortKey = (v) => { const x = v == null ? '' : String(v); return SORT_ALIAS[x] || x; };
    // 标签 id 列表:合法、不是 blocked(x_*)、去重、最多 n 个;字符串(逗号串)或数组都认
    function idList(v, n) {
        const arr = Array.isArray(v) ? v : (typeof v === 'string' && v ? v.split(',') : []);
        const out = [];
        for (const x of arr) {
            const id = typeof x === 'string' ? x.trim() : '';
            if (!validTag(id) || isBlockedTag(id) || out.indexOf(id) >= 0) continue;
            out.push(id);
            if (out.length >= n) break;
        }
        return out;
    }

    function normSel(tk, sel) {
        const T = typeOf(tk) || TYPES[0], s = sel || {};
        const bs = T.buckets.map(x => x[0]);
        let b = s.b == null ? '' : String(s.b);
        if (!bs.length) b = '';
        else if (bs.indexOf(b) < 0) b = bs[0];   // 大类里不给「全部」:服务器一次只按一个分类筛
        const pick = (v, arr, d) => { const x = v == null ? '' : String(v); return arr.some(o => o.k === x) ? x : d; };
        const v0 = s.v != null && s.v !== '' ? s.v : (FLAG_TO_V[s.flag] || '');
        const out = { b, dur: pick(s.dur, DURS, ''), v: pick(v0, VARIANTS, ''), sort: pick(sortKey(s.sort), SORTS, T.sort || 'new') };
        // 下面这些没选时不带键(选择对象逐字稳定:submitSearch 用 JSON 比「是不是同一页」)
        const t = idList(s.t != null ? s.t : (validTag(s.tag) ? [s.tag] : []), MAX_T);   // 旧的单标签 tag → t
        const x = idList(s.x, MAX_X).filter(id => t.indexOf(id) < 0);
        if (t.length) out.t = t;
        if (x.length) out.x = x;
        const st = cleanStudio(s.studio);
        if (st) out.studio = st;
        if (validAid(s.actress)) out.actress = aidStr(s.actress);
        if (typeof s.lp === 'string' && /^[A-Z0-9]{2,10}$/i.test(s.lp)) out.lp = s.lp.toUpperCase();   // 厂牌前缀(作品页「SSIS」按钮)
        return out;
    }
    // /api/catalog/browse 地址。opt.cursor 有值时按游标翻(不带 page),否则按页;opt.facets=1 要分面计数(第 1 页才要)
    function browseApiUrl(sel, opt) {
        const s = sel || {}, o = opt || {};
        const q = [['b', s.b || ''], ['t', (s.t || []).join(',')], ['x', (s.x || []).join(',')], ['dur', s.dur || ''], ['v', s.v || ''],
            ['studio', s.studio || ''], ['actress', s.actress || ''], ['lp', s.lp || ''], ['sort', s.sort || 'new']];
        if (o.cursor) q.push(['cursor', String(o.cursor)]);
        else q.push(['page', String(Math.max(1, Math.min(500, parseInt(o.page, 10) || 1)))]);
        if (o.facets) q.push(['facets', '1']);
        if (o.nr) q.push(['nr', '1']);   // 不要审查级作品(推荐位用,服务器 snapshot rvl)
        return '/api/catalog/browse?' + q.filter(([k, v]) => v !== '' || k === 'page').map(([k, v]) => k + '=' + encQ(v)).join('&');
    }
    function browseUrl(tk, sel, page) { return browseApiUrl(normSel(tk, sel), { page }); }
    // 查询串的值:逗号留着(t=a,b,c 好读;服务器按逗号拆),别的照常转义
    const encQ = (v) => encodeURIComponent(String(v)).replace(/%2C/gi, ',');
    // 已选的筛选个数(筛选按钮上的数字):标签 + 排除 + 时长 + 版本 + 厂牌 + 女优 + 厂牌前缀
    function filterCount(sel) {
        const s = sel || {};
        return (s.t || []).length + (s.x || []).length + (s.dur ? 1 : 0) + (s.v ? 1 : 0) + (s.studio ? 1 : 0) + (s.actress ? 1 : 0) + (s.lp ? 1 : 0);
    }
    // 点一个标签。mode:
    //   'cycle'(筛选面板默认):没选 → 选中 → 再点 = 排除 → 再点 = 取消(「点两下 = 排除」)
    //   'x'(筛选面板开了「排除模式」):没选 → 直接排除;选中/排除 → 取消
    //   'toggle'(标签行):没选 → 选中;选中/排除 → 取消
    //   超过 3 个 → { err };不合法 / blocked → { err: '' }(什么都不做)
    function nextTagState(sel, id, mode) {
        const m = mode === true ? 'x' : (mode === 'x' || mode === 'toggle' ? mode : 'cycle');
        const s = sel || {};
        const t = (s.t || []).slice(), x = (s.x || []).slice();
        if (!validTag(id) || isBlockedTag(id)) return { err: '' };
        const ti = t.indexOf(id), xi = x.indexOf(id);
        if (ti >= 0) {
            t.splice(ti, 1);
            if (m === 'cycle' && x.length < MAX_X) x.push(id);   // 第二下:排除
        } else if (xi >= 0) x.splice(xi, 1);
        else if (m === 'x') { if (x.length >= MAX_X) return { err: '最多排除 ' + MAX_X + ' 个标签' }; x.push(id); }
        else { if (t.length >= MAX_T) return { err: '最多同时选 ' + MAX_T + ' 个标签' }; t.push(id); }
        return { t, x };
    }
    // 目录卡片 → 首页行 / 浏览页卡片用的对象(沿用模板的字段名:id / title / poster_path,另带 _wk/_sub/_badge)
    //   海报上叠 N线(≥2)/ 时长 / 番号:副行里就不再重复这两段(服务器的 sub = '3小时前 · 2:01:33 · 6线')
    const SUB_DUR_RE = /^\d{1,3}:\d{2}(:\d{2})?$/, SUB_N_RE = /^\d+线$/;
    function cardToItem(c) {
        if (!c || typeof c !== 'object' || typeof c.wk !== 'string' || !c.wk) return null;
        const name = String(c.name || '');
        const dur = Math.max(0, Number(c.dur) || 0), n = Math.max(0, Number(c.n_sites) || 0);
        const durText = fmtDur(dur);
        let sub = String(c.sub || '').split(' · ').filter(p => p && !(durText && SUB_DUR_RE.test(p)) && !SUB_N_RE.test(p)).join(' · ');
        const variant = cleanText(c.variant, 8);
        const o = {
            id: c.wk, _wk: c.wk, title: name, name: name,
            poster_path: typeof c.pic === 'string' ? c.pic : '',
            _sub: sub, _badge: cleanText(c.badge, 8) || variant, _code: cleanText(c.code, 24),
            _dur: dur, _durText: durText, _bucket: String(c.bucket || ''), _n: n, _variant: variant,
        };
        // phase 3:番号作品有发行日期(AVDB)→ 副行先写发行日,再跟上架时间;没有就不带这个键(与旧对象逐字相同)
        const rel = relDate(c.released);
        if (rel && c.wk.indexOf('c:') === 0) { o._rel = rel; o._sub = rel + (sub ? ' · ' + sub : ''); }
        indexCard(o);   // [adult] p4:悬停预览 / 刷短片按 wk 找回卡片(不改输出)
        return o;
    }
    // 'YYYY-MM-DD'(1950..2100 年的真实日期)→ 原样;别的 → ''
    function relDate(v) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === 'string' ? v.trim() : '');
        if (!m) return '';
        const y = +m[1], mo = +m[2], d = +m[3];
        if (y < 1950 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
        const dt = new Date(Date.UTC(y, mo - 1, d));
        return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? m[0] : '';
    }
    // 浏览页的固定筛选行只剩「分类」(多桶大类);标签 / 排序 / 时长 / 版本 / 厂牌 / 女优 在 <dg-ad-filter>(标签行 + 筛选面板)里
    function groupsOf(tk, sel) {
        const T = typeOf(tk);
        if (!T) return [];
        return T.buckets.length > 1 ? [{ k: 'b', l: '分类', opts: T.buckets.map(([k, l]) => ({ k, l })) }] : [];
    }
    const QUICK = [['最新上架', { sort: 'new' }], ['中文字幕', { v: 'zh' }], ['1–2小时', { dur: 'xl' }], ['随机', { sort: 'rand' }]];
    function navRows(tk) {
        const T = typeOf(tk);
        if (!T) return [];
        if (T.buckets.length > 1) return [{ l: '分类', items: T.buckets.map(([b, l]) => ({ l, sel: { b } })) }];
        return [{ l: '快速', items: QUICK.map(([l, sel]) => ({ l, sel: Object.assign({}, sel) })) }];
    }
    // 标题:大类(· 分类)· 厂牌前缀 · 标签名(只写正向选中的;审查类标签不写进标题)· 厂牌 · 女优
    //   「全部」只按一位女优筛时标题就是「女优 · 名字」
    function title(tk, sel) {
        const T = typeOf(tk);
        if (!T) return '';
        const s = normSel(tk, sel);
        const an = s.actress ? (actressName(s.actress) || '女优') : '';
        if (T.k === 'all' && s.actress && !s.t && !s.studio && !s.lp) return '女优' + (an !== '女优' ? ' · ' + an : '');
        const tags = (s.t || []).filter(id => !NEVER_FEATURE.has(id)).map(tagLabel).filter(Boolean);
        const tg = (s.lp ? ' · ' + s.lp : '') + (tags.length ? ' · ' + tags.join(' · ') : '') + (s.studio ? ' · ' + studioLabel(s.studio) : '') + (an ? ' · ' + an : '');
        if (T.buckets.length > 1) { const x = T.buckets.find(b => b[0] === s.b); return T.l + ' · ' + (x ? x[1] : '') + tg; }
        return T.l + tg;
    }
    function summary(tk, sel) {
        const s = normSel(tk, sel), parts = [title(tk, s)];
        if (s.dur) parts.push(optLabel(DURS, s.dur));
        if (s.v) parts.push(optLabel(VARIANTS, s.v));
        if ((s.x || []).length) parts.push('排除 ' + s.x.length);
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
                    { l: '时长', items: DURS.filter(d => d.k && d.k !== 'unk').map(d => ({ l: d.l, sel: { b: T.buckets[0][0], dur: d.k } })) },
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
        if (m.b && BUCKET_LABEL[m.b]) return { type: typeOfBucket(m.b), sel: { b: m.b, sort: sortKey(m.sort) || 'new' } };
        if (m.sort) return { type: 'all', sel: { sort: sortKey(m.sort) } };   // 新片速递 → 发行日期;随机发现 → rand
        return null;
    }

    // ========== phase 3:浏览页分面 / 地址栏路由 ==========
    // 服务器 facets → 前端用的形状。审查类标签只进 more(不带数);blocked / 不认识的一律丢掉;顺手记下各种名字
    function normFacets(f) {
        if (!f || typeof f !== 'object') return null;
        const arr = (v) => (Array.isArray(v) ? v : []);
        const cnt = (v) => Math.max(0, Math.floor(Number(v) || 0));
        const out = { buckets: [], groups: [], more: [], dur: [], variant: [], studio: [], actress: [], sorts: [] };
        for (const b of arr(f.buckets)) if (b && typeof b.id === 'string' && BUCKET_LABEL[b.id]) out.buckets.push({ id: b.id, label: cleanText(b.label, 20) || BUCKET_LABEL[b.id], count: cnt(b.count) });
        const seen = new Set();
        for (const g of arr(f.groups)) {
            if (!g || typeof g.id !== 'string' || !/^[a-z_]{1,20}$/.test(g.id) || g.id === '_blocked') continue;
            const gl = cleanText(g.label, 20);
            if (gl) groupLabels[g.id] = gl;
            const tags = [];
            for (const t of arr(g.tags)) {
                if (!t || !validTag(t.id) || seen.has(t.id)) continue;
                const label = cleanText(t.label, 20);
                if (!label) continue;
                learnTag(t.id, label);
                if (!featurable(t.id) || t.featured === false) continue;   // 服务器漏放进来的审查类:不做按钮
                seen.add(t.id);
                tags.push({ id: t.id, label, count: cnt(t.count) });
            }
            if (tags.length) out.groups.push({ id: g.id, label: groupLabel(g.id) || gl, tags });
        }
        for (const t of arr(f.more)) {
            if (!t || !validTag(t.id) || isBlockedTag(t.id) || seen.has(t.id)) continue;
            const label = cleanText(t.label, 20);
            if (!label) continue;
            learnTag(t.id, label);
            seen.add(t.id);
            out.more.push({ id: t.id, label });
        }
        const opt = (list, defs) => {
            const o = [];
            for (const x of arr(list)) {
                const id = x && typeof x.id === 'string' ? x.id : '';
                const d = defs.find(z => z.k === id && z.k);
                if (d && !o.some(z => z.id === id)) o.push({ id, label: cleanText(x.label, 12) || d.l, count: cnt(x.count) });
            }
            return o;
        };
        out.dur = opt(f.dur, DURS);
        out.variant = opt(f.variant, VARIANTS);
        for (const s of arr(f.studio)) {
            const id = s && cleanStudio(s.id);
            if (!id || out.studio.some(z => z.id === id)) continue;
            const label = cleanText(s.label, 40) || id;
            learnStudio(id, label);
            out.studio.push({ id, label, count: cnt(s.count) });
            if (out.studio.length >= 20) break;
        }
        for (const a of arr(f.actress)) {
            const aid = a ? aidStr(a.aid) : '';
            if (!aid || out.actress.some(z => z.aid === aid)) continue;
            const name = cleanText(a.name, 40);
            if (!name) continue;
            learnActress(aid, name);
            out.actress.push({ aid, name, count: cnt(a.count) });
            if (out.actress.length >= 20) break;
        }
        // sorts:[{id,label,available}](也认旧草案的纯 id 数组);可用的按 SORTS 的次序
        const av = new Set();
        for (const s of arr(f.sorts)) {
            if (typeof s === 'string') av.add(sortKey(s));
            else if (s && typeof s.id === 'string' && s.available !== false) av.add(sortKey(s.id));
        }
        out.sorts = SORTS.filter(s => av.has(s.k)).map(s => s.k);
        if (!out.sorts.length) out.sorts = DEFAULT_SORTS.slice();
        return out;
    }
    // 排序下拉的选项:可用的 + 当前选中的(就算这次服务器说不可用,也照实显示,别让下拉和数据对不上)
    function sortOpts(facets, sel) {
        const av = (facets && facets.sorts && facets.sorts.length) ? facets.sorts : DEFAULT_SORTS;
        const cur = sel && sel.sort;
        const act = !!(sel && sel.actress);   // p4:女优页总能按「发行日期」排(AVDB 的发行日;服务器的演员页就是按它排的)
        return SORTS.filter(s => av.indexOf(s.k) >= 0 || s.k === cur || (act && s.k === 'released'));
    }
    // 标签行:已选(正向)在前 → 已排除 → 当前分类数量最多的 featured 标签(facets.groups 摊平,≤12);数为 0 的置灰不可点。
    //   没有 facets(旧服务器)→ 用 /api/catalog/tags 的 legacy 列表。审查类(选中了也)永不在这一行出现
    function chipRow(facets, sel, legacy, max) {
        const s = sel || {}, t = s.t || [], x = s.x || [];
        const pool = [];
        if (facets && facets.groups) facets.groups.forEach(g => g.tags.forEach(tg => pool.push(tg)));
        else (Array.isArray(legacy) ? legacy : []).forEach(tg => { if (tg && featurable(tg.id)) pool.push({ id: tg.id, label: tg.label, count: tg.count || 0 }); });
        const byId = new Map(pool.map(p => [p.id, p]));
        const out = [];
        t.filter(featurable).forEach(id => out.push({ id, label: tagLabel(id), count: (byId.get(id) || {}).count || 0, st: 'in', off: false }));
        x.filter(featurable).forEach(id => out.push({ id, label: tagLabel(id), count: 0, st: 'ex', off: false }));
        const rest = pool.filter(p => t.indexOf(p.id) < 0 && x.indexOf(p.id) < 0).sort((a, b) => b.count - a.count).slice(0, max || 12);
        rest.forEach(p => out.push({ id: p.id, label: p.label, count: p.count, st: '', off: !!facets && p.count <= 0 }));
        return out;
    }
    // 已选的非标签条件(筛选按钮旁的小药丸,点 × 去掉):时长 / 版本 / 厂牌 / 女优 / 厂牌前缀 / 审查类标签(只写「1 个筛选标签」不写名字)
    function activePills(sel) {
        const s = sel || {}, out = [];
        if (s.dur) out.push({ k: 'dur', l: optLabel(DURS, s.dur) });
        if (s.v) out.push({ k: 'v', l: optLabel(VARIANTS, s.v) });
        if (s.studio) out.push({ k: 'studio', l: '厂牌 ' + studioLabel(s.studio) });
        if (s.actress) out.push({ k: 'actress', l: '女优 ' + (actressName(s.actress) || '') });
        if (s.lp) out.push({ k: 'lp', l: s.lp });
        const rv = (s.t || []).concat(s.x || []).filter(id => !featurable(id)).length;
        if (rv) out.push({ k: 'review', l: rv + ' 个筛选标签' });
        return out;
    }
    // ---- 地址栏路由(只有 id,不写片名):#/c/<大类>?b=&t=&x=&dur=&v=&studio=&actress=&lp=&sort= / #/tags?b= / #/tag/<id> / #/actress/<aid>
    //      p4:#/actresses(女优索引,浏览页的一种「没有片单」的形态,同标签云);#/feed(刷短片)不归这里管(见 mixin 的 _adFeedHash)
    const DEF_SEL_KEYS = ['t', 'x', 'dur', 'v', 'studio', 'actress', 'lp'];
    const onlyKeys = (s, keys) => DEF_SEL_KEYS.every(k => keys.indexOf(k) >= 0 || !s[k] || (Array.isArray(s[k]) && !s[k].length));
    // 没有片单的页面形态(标签云 / 女优索引):不拉片单、不出筛选行和底栏
    const noList = (view) => view === 'tags' || view === 'actresses';
    function routeOf(view, tk, sel) {
        const T = typeOf(tk) || typeOf('all');
        const s = normSel(T.k, sel);
        if (view === 'actresses') return '#/actresses';
        if (view === 'tags') return '#/tags' + (s.b ? '?b=' + encodeURIComponent(s.b) : '');
        if (T.k === 'all' && s.sort === 'new') {
            if (view === 'tag' && s.t && s.t.length === 1 && onlyKeys(s, ['t'])) return '#/tag/' + encodeURIComponent(s.t[0]);
            if (s.actress && onlyKeys(s, ['actress'])) return '#/actress/' + encodeURIComponent(s.actress);
        }
        const q = [['b', s.b], ['t', (s.t || []).join(',')], ['x', (s.x || []).join(',')], ['dur', s.dur], ['v', s.v], ['studio', s.studio || ''],
            ['actress', s.actress || ''], ['lp', s.lp || ''], ['sort', s.sort === 'new' ? '' : s.sort]]
            .filter(([, v]) => v).map(([k, v]) => k + '=' + encQ(v)).join('&');
        return '#/c/' + T.k + (q ? '?' + q : '');
    }
    // 地址栏 → { view, type, sel };不是这几种(空、#admin、乱写的)→ null
    function parseRoute(hash) {
        const h = String(hash == null ? '' : hash).replace(/^#/, '');
        if (!h || h.length > 600 || h[0] !== '/') return null;
        const qi = h.indexOf('?');
        const path = qi < 0 ? h : h.slice(0, qi);
        const params = Object.create(null);
        if (qi >= 0) {
            for (const kv of h.slice(qi + 1).split('&')) {
                const i = kv.indexOf('=');
                if (i <= 0) continue;
                try { params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { }
            }
        }
        const seg = path.split('/');   // ['', 'c', 'jp']
        let one = '';
        try { one = seg[2] != null ? decodeURIComponent(seg[2]) : ''; } catch (e) { return null; }
        if (seg.length > 3) return null;
        if (seg[1] === 'tags' && seg.length === 2) {
            const b = BUCKET_LABEL[params.b] ? params.b : '';
            return { view: 'tags', type: b ? typeOfBucket(b) : 'all', sel: { b } };
        }
        if (seg[1] === 'actresses' && seg.length === 2) return { view: 'actresses', type: 'all', sel: {} };
        if (seg[1] === 'tag' && validTag(one) && !isBlockedTag(one)) return { view: 'tag', type: 'all', sel: { t: [one] } };
        if (seg[1] === 'actress' && validAid(one)) return { view: '', type: 'all', sel: { actress: one } };
        if (seg[1] === 'c' && typeOf(one)) {
            const b = BUCKET_LABEL[params.b] ? params.b : '';
            const type = b ? typeOfBucket(b) : one;
            const sel = { b, t: params.t || '', x: params.x || '', dur: params.dur, v: params.v, studio: params.studio, actress: params.actress, lp: params.lp, sort: params.sort };
            return { view: '', type, sel: normSel(type, sel) };
        }
        return null;
    }
    // 规范化后的地址(两边都按这个比:浏览器对 # 后面字符的转义各家不同)
    const canonHash = (hash) => { const r = parseRoute(hash); return r ? routeOf(r.view, r.type, r.sel) : ''; };
    const isOurHash = (hash) => /^#\/(c|tags|tag|actress|actresses)(\/|\?|$)/.test(String(hash || ''));
    const FEED_HASH = '#/feed';
    const isFeedHash = (hash) => String(hash || '') === FEED_HASH;
    // /api/catalog/tags(标签云)→ { groups:[{id,label,tags:[{id,label,count,w}]}] };只要 featured,字号档 w 1..5 按 log(数量)
    function normCloud(d) {
        const arr = (v) => (Array.isArray(v) ? v : []);
        for (const g of arr(d && d.groups)) { const l = g && typeof g.id === 'string' ? cleanText(g.label, 20) : ''; if (l) groupLabels[g.id] = l; }
        const by = new Map();
        let max = 1;
        for (const t of arr(d && d.tags)) {
            if (!t || !validTag(t.id)) continue;
            const label = cleanText(t.label, 20) || TAG_LABEL[t.id] || '';
            if (!label) continue;
            learnTag(t.id, label);
            if (t.featured !== true || !featurable(t.id)) continue;
            const c = Math.max(0, Math.floor(Number(t.count) || 0));
            if (!c) continue;
            const gid = typeof t.group === 'string' && /^[a-z_]{1,20}$/.test(t.group) && t.group !== '_blocked' ? t.group : '';
            if (!by.has(gid)) by.set(gid, []);
            if (by.get(gid).some(x => x.id === t.id)) continue;
            by.get(gid).push({ id: t.id, label, count: c });
            if (c > max) max = c;
        }
        const order = arr(d && d.groups).map(g => g && g.id).filter(Boolean).concat(GROUPS.map(g => g.id));
        const gids = [...by.keys()].sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
        const lm = Math.log(max + 1);
        return {
            groups: gids.map(id => ({
                id, label: id ? (groupLabel(id) || id) : '其他',
                tags: by.get(id).sort((a, b) => b.count - a.count).map(t => Object.assign(t, { w: Math.max(1, Math.min(5, 1 + Math.floor(4 * Math.log(t.count + 1) / lm))) })),
            })),
        };
    }
    // /api/catalog/tag/:id → { tag:{id,label,group,count}, buckets:[{id,label,count}], related:[{id,label}] };related 只要 featured
    function normTagInfo(d) {
        if (!d || typeof d !== 'object' || !d.tag || !validTag(d.tag.id) || isBlockedTag(d.tag.id)) return null;
        const label = cleanText(d.tag.label, 20) || tagLabel(d.tag.id);
        learnTag(d.tag.id, label);
        const arr = (v) => (Array.isArray(v) ? v : []);
        const buckets = arr(d.buckets).filter(b => b && BUCKET_LABEL[b.id]).map(b => ({ id: b.id, label: cleanText(b.label, 20) || BUCKET_LABEL[b.id], count: Math.max(0, Math.floor(Number(b.count) || 0)) })).filter(b => b.count > 0);
        const related = [];
        for (const r of arr(d.related)) {
            if (!r || !featurable(r.id) || r.id === d.tag.id || related.some(x => x.id === r.id)) continue;
            const rl = cleanText(r.label, 20);
            if (!rl) continue;
            learnTag(r.id, rl);
            related.push({ id: r.id, label: rl });
            if (related.length >= 8) break;
        }
        const g = typeof d.tag.group === 'string' ? d.tag.group : '';
        // 部数:服务器放在顶层 d.count(tag 里没有);旧形状 d.tag.count 也认
        const count = Math.max(0, Math.floor(Number(d.count != null ? d.count : d.tag.count) || 0));
        return { tag: { id: d.tag.id, label, group: g, groupLabel: groupLabel(g), count, review: !featurable(d.tag.id) }, buckets, related: featurable(d.tag.id) ? related : [] };
    }
    // /api/catalog/actress/:aid → { aid, name, aliases }
    function normActress(d) {
        const a = d && d.actress;
        const aid = a ? aidStr(a.aid) : '';
        if (!aid) return null;
        const name = cleanText(a.name, 40);
        if (!name) return null;
        learnActress(aid, name);
        const aliases = (Array.isArray(a.aliases) ? a.aliases : []).map(x => cleanText(x, 40)).filter(x => x && x !== name).filter((x, i, arr) => arr.indexOf(x) === i).slice(0, 6);
        // p4:最新发行(服务器的演员页按发行日期排,第 1 页里最晚的那个真实日期)
        let latest = '';
        for (const c of Array.isArray(d.results) ? d.results : []) { const r = relDate(c && c.released); if (r && r > latest) latest = r; }
        return { aid, name, aliases, latest };
    }
    // p4 /api/catalog/related/:wk → 排好的几排 [{k, title, icon, items, go}](相关推荐 / 同演员 · 名字 / 同片商 · 名字);
    //   每排 ≤24 张、排内去重、不含这一部本身和它的 #clip/#U/~N 兄弟;同演员只在有合法 aid + 名字时出;没有卡片的排不出
    const wkBase = (wk) => String(wk || '').split(/[#~]/)[0];
    function normRelated(d, self) {
        if (!d || typeof d !== 'object') return [];
        const base = wkBase(self);
        const take = (arr) => {
            const out = [], seen = new Set();
            for (const c of Array.isArray(arr) ? arr : []) {
                const it = cardToItem(c);
                if (!it || seen.has(it._wk) || (base && wkBase(it._wk) === base)) continue;
                seen.add(it._wk);
                out.push(Object.freeze(it));
                if (out.length >= 24) break;
            }
            return out;
        };
        const rails = [];
        const rel = take(d.items);
        if (rel.length) rails.push({ k: 'rel', title: '相关推荐', icon: 'fa-wand-magic-sparkles', items: rel, go: null });
        const a = d.actress && typeof d.actress === 'object' ? d.actress : null;
        const aid = a ? aidStr(a.aid) : '', an = a ? cleanText(a.name, 40) : '';
        if (aid && an) {
            learnActress(aid, an);
            const items = take(a.items);
            if (items.length) rails.push({ k: 'act', title: '同演员 · ' + an, icon: 'fa-user', items, go: { sel: { actress: aid }, type: 'all' } });
        }
        const s = d.studio && typeof d.studio === 'object' ? d.studio : null;
        const sid = s ? cleanStudio(s.id) : '', sl = s ? (cleanText(s.label, 40) || sid) : '';
        if (sid) {
            learnStudio(sid, sl);
            const items = take(s.items);
            if (items.length) rails.push({ k: 'st', title: '同片商 · ' + sl, icon: 'fa-building', items, go: { sel: { studio: sid }, type: 'all' } });
        }
        return rails;
    }
    // p4 猜你喜欢的种子标签:最近看过的作品(新 → 旧,越新权重越大)的 featured 标签打分,取前 n 个(审查类 / blocked 永远不当种子)
    function forYouTags(recent, tagMap, n) {
        const score = Object.create(null);
        (Array.isArray(recent) ? recent : []).forEach((wk, i) => {
            const w = 1 / (1 + i * 0.35);
            const ids = tagMap && Array.isArray(tagMap[wk]) ? tagMap[wk] : [];
            const seen = new Set();
            ids.forEach(id => { if (!featurable(id) || seen.has(id)) return; seen.add(id); score[id] = (score[id] || 0) + w; });
        });
        return Object.keys(score).sort((a, b) => (score[b] - score[a]) || (a < b ? -1 : 1)).slice(0, Math.max(1, n || 3));
    }
    // /api/catalog/actress?q= → [{aid,name,n}] ≤10
    function normActressList(d) {
        const out = [];
        for (const a of Array.isArray(d) ? d : []) {
            const aid = a ? aidStr(a.aid) : '';
            if (!aid || out.some(x => x.aid === aid)) continue;
            const name = cleanText(a.name, 40);
            if (!name) continue;
            learnActress(aid, name);
            out.push({ aid, name, n: Math.max(0, Math.floor(Number(a.n) || 0)) });
            if (out.length >= 10) break;
        }
        return out;
    }
    // /api/catalog/studios?b= → [{id,label,count}]
    function normStudios(d) {
        const out = [];
        for (const s of Array.isArray(d) ? d : []) {
            const id = s && cleanStudio(s.id);
            if (!id || out.some(x => x.id === id)) continue;
            const label = cleanText(s.label, 40) || id;
            learnStudio(id, label);
            out.push({ id, label, count: Math.max(0, Math.floor(Number(s.count) || 0)) });
            if (out.length >= 500) break;
        }
        return out;
    }
    // index.html 的 DgCatalog 换成这个(同名同参的接口;TMDB 那套不再被调用)
    const catalog = {
        ADULT: true, DEFAULT_TYPE: 'cn', TYPES, SORTS, DURS, VARIANTS, NSFW_KW: '',
        typeOf, yearOpts: () => [], yearRange: () => null, normSel,
        buildQuery: (tk, sel, page) => ({ url: browseUrl(tk, sel, page), path: '', media: '', params: {}, map: cardToItem }),
        visible: (it) => !!(it && it.id != null && it.id !== ''),
        groupsOf, navRows, title, summary, countLabel, directory, fromSearch, rowPreset, typeOfBucket,
    };

    // ========== 首页 ==========
    const ROW_ICON = { new: 'fa-clock', random: 'fa-dice', hot: 'fa-fire', fresh: 'fa-calendar-check' };
    const FRESH_MIN = 12;   // 新片速递(AVDB 发行 ≤60 天且能播):不足 12 部整行不出(服务器也这么判,两头都拦)
    // 热门行的来源角标(本站观看统计 / 外站一周点击);行标题统一叫「热门」,来源写在角标上
    const HOT_SRC = {
        local: { l: '本站热门', tip: '按本站用户最近 7 天的观看统计' },
        ext: { l: '外站热门', tip: '按外部站点一周点击数(本站观看数据还不够时)' },
    };
    // /api/catalog/home → { configs, lists, order }(键:ad_<行 id>;随机发现也是普通一行,排在最后,不占首页布局里「随机盲盒」的位置)
    function homeToRows(home) {
        const configs = {}, lists = {}, order = [];
        const rows = (home && Array.isArray(home.rows)) ? home.rows : [];
        for (const r of rows) {
            if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_]{1,40}$/.test(r.id)) continue;
            // 只读展示:冻结 = 不做深层响应式(首页十几行 × 24 张)
            const items = (Array.isArray(r.items) ? r.items : []).map(cardToItem).filter(Boolean).map(Object.freeze);
            if (!items.length || (r.id === 'fresh' && items.length < FRESH_MIN)) continue;
            const key = 'ad_' + r.id;
            if (configs[key]) continue;
            const hs = r.id === 'hot' ? (HOT_SRC[r.source] || (r.title === HOT_SRC.local.l ? HOT_SRC.local : r.title === HOT_SRC.ext.l ? HOT_SRC.ext : null)) : null;
            configs[key] = {
                title: hs ? '热门' : String(r.title || BUCKET_LABEL[r.id] || (r.id === 'fresh' ? '新片速递' : '')), icon: ROW_ICON[r.id] || ((TILE[r.id] || [])[2]) || 'fa-film',
                path: 'ADULT', params: '', page: 1, totalPages: 1, adult: true,
                more: (r.more && typeof r.more === 'object') ? Object.assign({}, r.more) : null,
                today: Math.max(0, Number(r.today) || 0),
                srcLabel: hs ? hs.l : '', srcTip: hs ? hs.tip : '',
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
        return Object.assign(o, srcFlags(s));
    }
    // 线路的 phase-2 标记(/api/catalog/work 下发):_family 同一后端的镜像(一张卡「+N 备用」、自动换源先试它们)/
    //   _dead 多人反馈失效(排最后、置灰)/ _native 'risky' 原生 HLS(iOS)可能放不了 / _same 同一上游不同 CDN(标「同源」)/
    //   _res 别人实测的宽高 → _realRes(分辨率角标;本机测到的会覆盖它)。没有就不带这些键(与旧对象逐字相同)
    function srcFlags(s) {
        const o = {};
        if (!s || typeof s !== 'object') return o;
        const fam = cleanText(s._family, 40), same = cleanText(s._same, 80);
        if (fam) o._family = fam;
        if (same) o._same = same;
        if (s._dead === true) o._dead = true;
        if (s._native === 'risky') o._native = 'risky';
        const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(s._res || ''));
        if (m && +m[1] >= 64 && +m[2] >= 64) o._realRes = { w: +m[1], h: +m[2], from: 'beacon', ts: 0 };
        else {
            // 已经是 workSource 转过的线路(refreshSources 拿 _adWorkList 的结果重建):上报的分辨率在 _realRes 里,别丢;本机实测的不当上报的带
            const r = s._realRes;
            if (r && r.from === 'beacon' && +r.w >= 64 && +r.h >= 64 && +r.w <= 16384 && +r.h <= 16384) o._realRes = { w: +r.w, h: +r.h, from: 'beacon', ts: 0 };
        }
        return o;
    }
    // refreshSources 重建线路对象时补回的成人字段(变体/时长 + 上面的标记)
    function srcExtra(s) {
        if (!s || typeof s !== 'object') return {};
        const o = srcFlags(s);
        if (s._variant) o._variant = String(s._variant);
        if (Number(s._dur) > 0) o._dur = Number(s._dur);
        return o;
    }
    const famOf = (s) => (s && typeof s._family === 'string' ? s._family : '');
    const sameOf = (s) => (s && typeof s._same === 'string' ? s._same : '');
    const varKind = (s) => (s && s._variant === '中字' ? 'zh' : 'raw');
    // 收成一张卡的键:同一家 + 同一版本(中字/原版是两份片子,不互为备用)+ 同为失效/非失效
    const famKey = (s) => { const f = famOf(s); return f ? f + '|' + varKind(s) + (s._dead === true ? '|x' : '') : ''; };
    // 线路列表组内次序(sourceGroups 每组排好后再过一遍,显示顺序 = 自动换源顺序):
    //   ① 多人反馈失效的垫底 ② 本机走原生 HLS 时,标了 risky 的往后挪(不藏)③ 选了「中字 / 原版」时,选中的那种在前;
    //   其余保持原顺序(稳定);最后把同一 _family 的镜像收到第一条后面紧挨着 —— 换源时先试同家的备用线路。失效的成员不被拉上来
    function orderSources(items, opt) {
        const o = opt || {};
        const arr = Array.isArray(items) ? items.filter(Boolean) : [];
        const idx = new Map(arr.map((s, i) => [s, i]));
        const key = (s) => [s._dead === true ? 1 : 0, (o.native && s._native === 'risky') ? 1 : 0, (o.pref && varKind(s) !== o.pref) ? 1 : 0];
        const sorted = arr.slice().sort((a, b) => {
            const ka = key(a), kb = key(b);
            for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
            return idx.get(a) - idx.get(b);
        });
        const out = [], used = new Set();
        sorted.forEach((s, i) => {
            if (used.has(s)) return;
            used.add(s); out.push(s);
            const k = famKey(s);
            if (!k) return;
            for (let j = i + 1; j < sorted.length; j++) {
                const t = sorted[j];
                if (!used.has(t) && famKey(t) === k) { used.add(t); out.push(t); }
            }
        });
        return out;
    }
    // 线路列表每条的显示信息(Map:线路对象 → 视图)。同一组里同 _family 的第一条是「领头」(带「+N 备用」),其余是成员:
    //   没展开时藏起来(正在播的那条除外);同源 = 同一个 _same 在这部作品里出现 ≥2 次;risky 只在本机走原生 HLS 时标
    const NOV = Object.freeze({ lead: false, mem: false, more: 0, hide: false, open: false, same: false, risky: false, dead: false });
    function srcView(groups, opt) {
        const o = opt || {};
        const out = new Map();
        const cnt = Object.create(null);
        (o.all || []).forEach(s => { const k = sameOf(s); if (k) cnt[k] = (cnt[k] || 0) + 1; });
        const cur = o.cur || null;
        const isCur = (s) => !!cur && (cur === s || (cur.site_key === s.site_key && String(cur.vod_id) === String(s.vod_id)));
        (groups || []).forEach(g => {
            const lead = Object.create(null);
            ((g && g.items) || []).forEach(s => {
                if (!s) return;
                const k = sameOf(s);
                const v = { lead: false, mem: false, more: 0, hide: false, open: false, same: !!(k && cnt[k] > 1), risky: !!(o.native && s._native === 'risky'), dead: s._dead === true };
                const fk = famKey(s);
                if (fk) {
                    const L = lead[fk];
                    if (!L) { lead[fk] = v; v.lead = true; v.open = !!(o.expandAll || (o.open && o.open[famOf(s)])); }
                    else { v.mem = true; L.more++; v.open = L.open; v.hide = !L.open && !isCur(s); }
                }
                out.set(s, v);
            });
        });
        return out;
    }
    // 本机是不是走浏览器原生 HLS(iOS/iPadOS/Safari,或 hls.js 不可用):与 _dgHlsCustomType 同一判断
    function nativeDev() {
        try { return !!(root._dgPreferNativeHls || !(root.Hls && typeof root.Hls.isSupported === 'function' && root.Hls.isSupported())); }
        catch (e) { return false; }
    }

    // ========== 作品信息条(_meta) ==========
    //   兼容 phase 1 的形状(tags 是 id 字符串、siblings.kind 'alt'),也认契约里的 {id,label,featured} / 'main'
    //   phase 3:标签带 group(分面组)→ 另给按组排好的 tagGroups(审查类 / blocked 永远不出,不管服务器怎么标)
    function metaTagList(tags, max) {
        const out = [], seen = new Set();
        for (const t of Array.isArray(tags) ? tags : []) {
            let id = '', label = '', featured = false, group = '';
            if (typeof t === 'string') { id = t; label = TAG_LABEL[t] || ''; featured = !!label; }
            else if (t && typeof t === 'object') {
                id = String(t.id || ''); label = cleanText(t.label, 20) || TAG_LABEL[id] || ''; featured = t.featured === true;
                group = typeof t.group === 'string' && /^[a-z_]{1,20}$/.test(t.group) && t.group !== '_blocked' ? t.group : '';
            }
            if (!validTag(id) || !label || seen.has(id)) continue;
            learnTag(id, label);
            if (!featured || !featurable(id)) continue;
            seen.add(id);
            out.push({ id, label, group });
            if (out.length >= max) break;
        }
        return out;
    }
    function metaTags(tags) { return metaTagList(tags, 8).map(t => ({ id: t.id, label: t.label })); }
    function metaTagGroups(list) {
        const order = GROUPS.map(g => g.id);
        const by = new Map();
        list.forEach(t => { if (!by.has(t.group)) by.set(t.group, []); by.get(t.group).push({ id: t.id, label: t.label }); });
        return [...by.keys()].sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); })
            .map(id => ({ id, label: id ? (groupLabel(id) || '') : '', tags: by.get(id) }));
    }
    const WK_RE = /^[ct]:./;
    function metaView(m, g) {
        if (!m || typeof m !== 'object') return null;
        const wk = (g && typeof g._wk === 'string') ? g._wk : '';
        const code = cleanText(m.code, 40);
        const dur = Math.max(0, Math.round(Number(m.dur) || 0));
        const bucket = (typeof m.bucket === 'string' && BUCKET_LABEL[m.bucket]) ? m.bucket : '';
        const bucketLabel = bucket ? (cleanText(m.bucket_label, 20) || BUCKET_LABEL[bucket]) : '';
        let prefix = '';
        if (typeof m.label_prefix === 'string') prefix = m.label_prefix.trim();
        else if (code && wk.indexOf('c:') === 0) { const x = /^([A-Z]{2,8})-\d{2,6}$/i.exec(code); prefix = x ? x[1].toUpperCase() : ''; }
        if (!/^[A-Z0-9]{2,10}$/i.test(prefix)) prefix = '';
        // 演员:phase 3 是 [{aid,name}](已确认:站点字段 / 片名高置信 / AVDB)→ 点了进女优页;旧的纯名字 → aid 为空,点了全站搜
        const actress = [];
        if (!(bucket && NO_ACTRESS_BUCKETS.has(bucket))) {
            for (const a of Array.isArray(m.actress) ? m.actress : []) {
                const name = cleanText(a && typeof a === 'object' ? a.name : a, 30);
                const aid = a && typeof a === 'object' ? aidStr(a.aid) : '';
                if (!name || actress.some(x => x.name === name || (aid && x.aid === aid))) continue;
                if (aid) learnActress(aid, name);
                actress.push({ aid, name });
                if (actress.length >= 8) break;
            }
        }
        // 厂牌(片商):_meta.studio({id,label} 或字符串)优先,其次 AVDB 的 maker;label(AVDB 的发行商牌子)不同于片商时只作文字
        let studio = null;
        const st = m.studio;
        if (st && typeof st === 'object' && cleanStudio(st.id)) studio = { id: cleanStudio(st.id), label: cleanText(st.label, 40) || cleanStudio(st.id) };
        else if (cleanStudio(st)) studio = { id: cleanStudio(st), label: cleanStudio(st) };
        else if (cleanStudio(m.maker)) studio = { id: cleanStudio(m.maker), label: cleanText(m.maker, 40) };
        if (studio) learnStudio(studio.id, studio.label);
        const maker = cleanText(m.maker, 40), lbl = cleanText(m.label, 40);
        const sites = new Set(((g && g.sources) || []).map(s => s && s.site_key).filter(Boolean));
        const nSites = Math.max(Number(m.n_sites) || 0, sites.size);
        const curSub = /#(U|clip)(?=$|[#~])/.test(wk);
        const sib = [], clips = [];
        for (const s of Array.isArray(m.siblings) ? m.siblings : []) {
            if (!s || typeof s.wk !== 'string' || !WK_RE.test(s.wk) || s.wk.length > 300 || s.wk === wk) continue;
            const name = cleanText(s.name, 120);
            const kind = s.kind === 'clip' || s.wk.indexOf('#clip') >= 0 ? 'clip' : (s.kind === 'U' || /#U(?=$|[#~])/.test(s.wk)) ? 'U' : 'main';
            if (kind === 'clip') { clips.push({ wk: s.wk, name, kind }); continue; }
            const label = kind === 'U' ? '另有无码流出版' : (curSub && s.wk.indexOf('#') < 0) ? '正片' : '同番号另一版本';
            sib.push({ wk: s.wk, name, kind, label });
        }
        // 无码流出版在前,其余正片随后
        sib.sort((a, b) => (a.kind === 'U' ? 0 : 1) - (b.kind === 'U' ? 0 : 1));
        // 分类已经说明了的标签不再重复(中文字幕分类的「中字」、日本无码分类的「无码」)
        const dupTag = { jp_subbed: 'subbed', jp_uncensored: 'uncensored' }[bucket] || '';
        const all = metaTagList(m.tags, 16).filter(t => t.id !== dupTag);
        return {
            code, dur, durText: fmtDur(dur), nSites, bucket, bucketLabel, tags: all.slice(0, 8).map(t => ({ id: t.id, label: t.label })), prefix, actress,
            sib: sib.slice(0, 6), clips: clips.slice(0, 12), firstSeen: Number(m.first_seen) || 0,
            released: relDate(m.released), studio, label: lbl && lbl !== maker && (!studio || lbl !== studio.label) ? lbl : '',
            tagGroups: metaTagGroups(all), avdb: m.avdb === true,
        };
    }

    // ========== 标签 / 搜索建议 ==========
    const tagsUrl = (b) => '/api/catalog/tags?b=' + encodeURIComponent(b && BUCKET_LABEL[b] ? b : '');
    // /api/catalog/tags → 只留可做按钮的(featured 且不是审查类),按数量降序,最多 24 个
    function normTags(d) {
        const list = (d && Array.isArray(d.tags)) ? d.tags : [];
        const out = [], seen = new Set();
        for (const t of list) {
            if (!t || typeof t !== 'object' || !validTag(t.id) || seen.has(t.id)) continue;
            const label = cleanText(t.label, 20) || TAG_LABEL[t.id] || '';
            if (!label) continue;
            learnTag(t.id, label);
            if (t.featured !== true || NEVER_FEATURE.has(t.id)) continue;
            seen.add(t.id);
            out.push({ id: t.id, label, count: Math.max(0, Number(t.count) || 0) });
        }
        out.sort((a, b) => b.count - a.count);
        return out.slice(0, 24);
    }
    const suggestUrl = (q) => '/api/catalog/suggest?q=' + encodeURIComponent(String(q || '').trim().slice(0, 100));
    const SUG_KINDS = ['blocked', 'code', 'alias', 'text', 'empty'];
    // /api/catalog/suggest → { kind, alias, exact, items }(items 已是卡片对象);被拦的查询什么都不给(不提示为什么)
    function normSuggest(d) {
        if (!d || typeof d !== 'object') return null;
        const kind = SUG_KINDS.indexOf(d.kind) >= 0 ? d.kind : 'text';
        if (kind === 'blocked') return { kind, alias: null, exact: null, items: [] };
        let alias = null;
        if (d.alias && typeof d.alias === 'object') {
            const b = (typeof d.alias.b === 'string' && BUCKET_LABEL[d.alias.b]) ? d.alias.b : '';
            const tag = validTag(d.alias.tag) ? d.alias.tag : '';
            if (tag && d.alias.label) learnTag(tag, d.alias.label);
            if (b || tag) alias = { b, tag, label: cleanText(d.alias.label, 20) || (tag ? tagLabel(tag) : BUCKET_LABEL[b]) };
        }
        const items = (Array.isArray(d.items) ? d.items : []).map(cardToItem).filter(Boolean).slice(0, 8).map(Object.freeze);
        const exact = (typeof d.exact === 'string' && WK_RE.test(d.exact) && d.exact.length <= 300) ? d.exact : null;
        return { kind, alias, exact, items };
    }
    // 分类/标签词 → 浏览页预设(搜索建议的 alias)
    function aliasPreset(a) {
        if (!a || typeof a !== 'object') return null;
        const b = (typeof a.b === 'string' && BUCKET_LABEL[a.b]) ? a.b : '';
        const tag = validTag(a.tag) ? a.tag : '';
        if (!b && !tag) return null;
        const sel = {};
        if (b) sel.b = b;
        if (tag && !isBlockedTag(tag)) sel.t = [tag];
        else if (!b) return null;
        return { type: b ? typeOfBucket(b) : 'all', sel };
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
        if (!pic) { const p = sources.find(s => PIC_OK_RE.test(s.vod_pic)); pic = p ? p.vod_pic : ''; }
        return { name: w.name, pic, _wk: wk, _meta: (w._meta && typeof w._meta === 'object') ? w._meta : null, sources };
    }
    function workToList(w) {
        const g = workToGroup(w);
        return { list: g ? g.sources.map(s => { const o = Object.assign({}, s); delete o.latency; return o; }) : [], _adult: true, name: g ? g.name : '' };
    }
    // 能当海报用的地址:完整 http(s),或开了 ADULT_IMG_PROXY 时服务器改写成的同源 /api/img?k=&s=
    const PIC_OK_RE = /^(https?:\/\/|\/api\/img\?)/i;
    // 搜索结果分组键/卡片名:有作品键按作品并(各站片名常不同),名字用规范名
    const groupKeyOf = (it) => (it && typeof it._wk === 'string' && it._wk) ? it._wk : (it ? it.vod_name : '');
    const groupNameOf = (it) => (it && typeof it._wt === 'string' && it._wt) ? it._wt : (it ? it.vod_name : '');
    // 横版封面(日本有码常见 800×538)放进 2:3 位:人物在右半边 → object-position: right
    const isLandscape = (w, h) => w > 0 && h > 0 && (w / h) > 1.3;
    // 海报坏了:换这一组里另一条线路的海报(没试过的、不是 mac_default/nopic 占位);都试过 → ''(显示中性占位)
    function pickFallbackPic(group, tried) {
        const bad = (u) => !u || !PIC_OK_RE.test(u) || /mac_default|nopic/i.test(u);
        const t = tried || new Set();
        for (const s of (group && Array.isArray(group.sources)) ? group.sources : []) {
            const u = s && String(s.vod_pic || '').trim();
            if (!bad(u) && !t.has(u)) return u;
        }
        return '';
    }
    const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='450'%3E%3Crect fill='%23262626' width='300' height='450'/%3E%3Cpath d='M120 190h60v70h-60z' fill='%23444'/%3E%3C/svg%3E";

    // ========== 内容接口鉴权(401 → 补核验 → 重试一次 → 登录框) ==========
    const CONTENT_RE = /^\/api\/(search|detail|check|sites|catalog|popular|kz|img)(\/|$)/;
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
        // 登录框的「购买套餐」按钮 / 套餐到期的续费链接:成人站默认不出(主站的购买地址不能出现在这里);
        //   /api/config 给了 purchase_url(http/https)才显示,并指向它。上次的值记在本机,登录框先按它显示(config 回来再校正)
        const BUY_KEY = 'dg_buy_url';
        const safeUrl = (u) => {
            const s = String(u == null ? '' : u).trim();
            if (!s || s.length > 300 || !/^https?:\/\//i.test(s)) return '';
            try { const U = new URL(s); return /^https?:$/.test(U.protocol) ? U.href : ''; } catch (e) { return ''; }
        };
        function buyUrl() { return safeUrl(lsGet(BUY_KEY)); }
        function applyBuy(u) {
            const v = safeUrl(u);
            if (v) lsSet(BUY_KEY, v); else { try { if (root.localStorage) root.localStorage.removeItem(BUY_KEY); } catch (e) { } }
            showBuy();
            return v;
        }
        function showBuy() {
            const d = root.document, v = buyUrl();
            if (!d || !d.documentElement) return;
            try {
                d.documentElement.classList.toggle('dg-buy', !!v);
                const a = d.querySelector('#register-link a');
                if (a) { if (v) a.setAttribute('href', v); else a.removeAttribute('href'); }
            } catch (e) { }
        }
        const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        // 续费提示(登录框里的 HTML 片段 / alert 文本);没配 purchase_url → 空(不提续费地址)
        function renewHtml() {
            const v = buyUrl();
            if (!v) return '';
            let host = v;
            try { host = new URL(v).host; } catch (e) { }
            return '<br>请前往 <a href="' + escHtml(v) + '" target="_blank" rel="noopener noreferrer" style="color:#ff6b6b;text-decoration:underline;">' + escHtml(host) + '</a> 续费';
        }
        function renewText() { const v = buyUrl(); return v ? '\n\n前往续费: ' + v : ''; }
        return { KEY, name, apply, clean, buyUrl, applyBuy, showBuy, renewHtml, renewText, safeUrl };
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
        // 发了就不管的 JSON POST(线路反馈):自己带令牌/年龄头,不走上面的 401 补核验/登录框 —— 后台上报绝不弹登录框、不重试
        function post(url, body) {
            const f = origFetch || root.fetch;
            if (typeof f !== 'function') return Promise.resolve(null);
            try {
                const h = typeof Headers !== 'undefined' ? new Headers() : null;
                const set = (k, v) => { if (h) h.set(k, v); };
                set('Content-Type', 'application/json');
                set('x-dg-age', '1');
                const tok = tokenOf();
                if (tok) set('x-dg-token', tok);
                return Promise.resolve(f(url, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: h || { 'Content-Type': 'application/json', 'x-dg-age': '1' }, body: JSON.stringify(body) }))
                    .then(r => r, () => null);
            } catch (e) { return Promise.resolve(null); }
        }
        return { install, reauth, ensure, logout, loginRequired, isAuthRequired, post };
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
    // [adult] p4:不扩线的作品请求先用 adult/player-x.js 预取好的(dgAdultPlayer.prefetched(wk) → Promise / 作品 JSON / null);
    //   拿不到、形状不对、不是这一部 → 照常请求 /api/catalog/work
    function prefetchedWork(wk) {
        try {
            const P = root.dgAdultPlayer;
            if (!P || typeof P.prefetched !== 'function') return null;
            const r = P.prefetched(wk);
            if (r == null) return null;
            return Promise.resolve(r).then(d => (d && typeof d === 'object' && Array.isArray(d.sources) && (d._wk == null || d._wk === wk)) ? d : null, () => null);
        } catch (e) { return null; }
    }
    function fetchWorkRaw(wk) {
        const p = prefetchedWork(wk);
        return p ? p.then(d => d || fetchJson(workUrl(wk, false), 10000)) : fetchJson(workUrl(wk, false), 10000);
    }
    // 作品 → openDetail 用的 group;expand=true 时服务器现搜各站补线路(最多 ~20s)
    const fetchWork = (wk, expand) => (expand ? fetchJson(workUrl(wk, true), 25000) : fetchWorkRaw(wk)).then(workToGroup);

    // ========== 线路反馈(POST /api/catalog/beacon) ==========
    //   同一部作品的同一条线路,一个会话里「失败」「起播」各最多报一次(sessionStorage 记着,刷新也不重报);发了就不管,绝不挡播放
    const beacon = (function () {
        const KEY = 'dg_bc_sent', MAX = 500;
        let sent = null;
        function load() {
            if (sent) return sent;
            sent = new Set();
            try {
                const raw = root.sessionStorage ? root.sessionStorage.getItem(KEY) : null;
                const arr = JSON.parse(raw || '[]');
                if (Array.isArray(arr)) arr.slice(-MAX).forEach(k => sent.add(String(k)));
            } catch (e) { }
            return sent;
        }
        function save() { try { if (root.sessionStorage) root.sessionStorage.setItem(KEY, JSON.stringify([...sent].slice(-MAX))); } catch (e) { } }
        const int = (v, lo, hi) => { const n = Math.round(Number(v)); return (Number.isFinite(n) && n >= lo && n <= hi) ? n : 0; };
        // 契约:{ wk, site_key, vod_id, ok, err?, dur?, w?, h? };不合法 → null
        function payload(o) {
            if (!o || typeof o !== 'object' || typeof o.ok !== 'boolean') return null;
            if (typeof o.wk !== 'string' || !WK_RE.test(o.wk) || o.wk.length > 300) return null;
            if (typeof o.site_key !== 'string' || !o.site_key || o.site_key.length > 64) return null;
            if (o.vod_id == null || (typeof o.vod_id !== 'string' && typeof o.vod_id !== 'number') || String(o.vod_id).length > 64 || String(o.vod_id) === '') return null;
            const p = { wk: o.wk, site_key: o.site_key, vod_id: o.vod_id, ok: o.ok };
            if (!o.ok) { const e = cleanText(o.err, 60); if (e) p.err = e; return p; }
            const dur = int(o.dur, 1, 86400);
            if (dur) p.dur = dur;
            const w = int(o.w, 16, 16384), h = int(o.h, 16, 16384);
            if (w && h) { p.w = w; p.h = h; }
            // p4:画面方向(刷短片在 loadedmetadata 后量 videoWidth/Height 报;契约 P4 B1 beacon 的 orient)
            if (o.orient === 'v' || o.orient === 'h' || o.orient === 'sq') p.orient = o.orient;
            return p;
        }
        // 刷短片的方向上报(带 orient)与播放页的起播上报分开记(各报一次)
        const keyOf = (p) => (p.ok ? (p.orient ? 'or' : 'ok') : 'x') + '|' + p.wk + '|' + p.site_key + '|' + p.vod_id;
        function send(o) {
            if (incognito()) return false;   // [adult] p4:无痕时本机什么都不报(上报带作品键)
            const p = payload(o);
            if (!p) return false;
            const s = load(), k = keyOf(p);
            if (s.has(k)) return false;
            s.add(k);
            save();
            try { auth.post('/api/catalog/beacon', p); } catch (e) { }
            return true;
        }
        return { send, payload, keyOf, _reset() { sent = new Set(); save(); } };
    })();

    // ========== [adult] p4 扩展点:window.dgAdultHooks ==========
    //   别的模块(adult/player-x.js、privacy.js、preview.js、feed.js)往上挂;adult.js / index.html 在固定的地方调:
    //     onPlayerReady(dp, video, ctx)  每次 play() 把线路交给播放器之后(新建或换源/换集都算);
    //                                    ctx = { wk, dur, isLive, lineKey('站|vod_id'), siteKey, vodId, url, fresh, episodes }
    //     onPlayerDestroy(reason)        关播放页 / 回首页 / 销毁重建播放器之前;reason = 'close' | 'home' | 'switch' | 'rebuild' | 'offline'
    //     onHistoryWrite(item)           每次写观看历史 / 进度 / 观看统计之前;任一订阅者返回 false = 这次不写(无痕);
    //                                    item = { kind: 'history' | 'progress' | 'stats', name, wk, episode }
    //     onSettingsRender(container)    偏好设置弹窗打开:container 是一个空 div,订阅者往里放自己的设置行(每次打开都是新的)
    //     onCardHover(card, el, ev)      目录卡片 鼠标进入 / 手指按下(card = 卡片对象,至少有 wk;ev.type = 'pointerover' | 'touchstart')
    //   订阅:window.dgAdultHooks.onPlayerReady = fn(赋值 = 追加,不会顶掉别人的)/ .add(name, fn) / .remove(name, fn);
    //   整个对象被换掉(window.dgAdultHooks = {...})时把里面的函数逐个追加。没人订阅 = 什么都不做;每个订阅者各自 try/catch
    const HOOK_NAMES = ['onPlayerReady', 'onPlayerDestroy', 'onHistoryWrite', 'onSettingsRender', 'onCardHover'];
    const hooks = (function () {
        const subs = Object.create(null), busy = Object.create(null);
        HOOK_NAMES.forEach(n => { subs[n] = []; });
        function add(name, fn) {
            const L = subs[name];
            if (!L || typeof fn !== 'function' || fn.__dgHookDispatch) return false;
            if (L.indexOf(fn) < 0) L.push(fn);
            return true;
        }
        function remove(name, fn) { const L = subs[name], i = L ? L.indexOf(fn) : -1; if (i >= 0) L.splice(i, 1); return i >= 0; }
        // 调一个钩子:返回 false = 有订阅者否决(只对 onHistoryWrite 有意义)。同一个钩子在订阅者里又被调(链式包装)→ 不重入
        function call(name, args) {
            const L = subs[name];
            if (!L || !L.length || busy[name]) return true;
            busy[name] = true;
            let ok = true;
            try {
                for (const fn of L.slice()) {
                    try { if (fn.apply(null, args || []) === false) ok = false; }
                    catch (e) { try { console.warn('[adult] 钩子 ' + name + ' 出错', e); } catch (_) { } }
                }
            } finally { busy[name] = false; }
            return ok;
        }
        const H = {};
        HOOK_NAMES.forEach(n => {
            const dispatch = function () { return call(n, Array.prototype.slice.call(arguments)); };
            dispatch.__dgHookDispatch = true;
            Object.defineProperty(H, n, { enumerable: true, get: () => dispatch, set: (fn) => { add(n, fn); } });
        });
        Object.defineProperty(H, 'add', { value: add });
        Object.defineProperty(H, 'remove', { value: remove });
        Object.defineProperty(H, 'call', { value: function (n) { return call(n, Array.prototype.slice.call(arguments, 1)); } });
        Object.defineProperty(H, 'count', { value: (n) => (subs[n] ? subs[n].length : 0) });
        function merge(v) {
            if (!v || v === H || typeof v !== 'object') return;
            HOOK_NAMES.forEach(n => { let f = null; try { f = v[n]; } catch (e) { } if (typeof f === 'function') add(n, f); });
        }
        // 装到 window 上:先放进来的(脚本顺序意外时)合并;之后整个赋值也只是合并
        function install() {
            if (!root || typeof root !== 'object') return;
            let prev = null;
            try { prev = root.dgAdultHooks; } catch (e) { }
            if (prev === H) return;
            try { Object.defineProperty(root, 'dgAdultHooks', { configurable: true, enumerable: true, get: () => H, set: (v) => merge(v) }); }
            catch (e) { try { root.dgAdultHooks = H; } catch (_) { } }
            merge(prev);
        }
        return { H, add, remove, call, install, merge, NAMES: HOOK_NAMES };
    })();
    // 调钩子(index.html 用:window.DgAdult.hook('onPlayerDestroy', 'close'));返回 false = 被否决
    function hook(name) { return hooks.call(name, Array.prototype.slice.call(arguments, 1)); }

    // ========== [adult] p4 本机作品标签(「猜你喜欢」的种子):wk → featured 标签 id,最多 80 部,最近看的在后 ==========
    const wkTags = (function () {
        const KEY = 'dg_wk_tags', MAX = 80;
        function load() {
            try {
                const d = JSON.parse(lsGet(KEY) || 'null');
                return (d && Array.isArray(d.m)) ? d.m.filter(r => Array.isArray(r) && typeof r[0] === 'string' && WK_RE.test(r[0]) && Array.isArray(r[1])) : [];
            } catch (e) { return []; }
        }
        function get(wk) { const r = load().find(x => x[0] === wk); return r ? r[1].filter(featurable) : null; }
        function put(wk, ids) {
            if (typeof wk !== 'string' || !WK_RE.test(wk) || wk.length > 300) return false;
            const clean = (Array.isArray(ids) ? ids : []).filter(featurable).slice(0, 6);
            const m = load().filter(x => x[0] !== wk);
            m.push([wk, clean, Date.now()]);
            return lsSet(KEY, JSON.stringify({ v: 1, m: m.slice(-MAX) }));
        }
        function all() { const o = Object.create(null); load().forEach(r => { o[r[0]] = r[1].filter(featurable); }); return o; }
        return { KEY, get, put, all };
    })();

    // ========== [adult] p4 卡片索引:wk → 卡片对象(悬停预览 / 刷短片拿得到片名、海报、时长),最多 3000 个,先进先出 ==========
    const cardIndex = new Map();
    const CARD_INDEX_MAX = 3000;
    function indexCard(o) {
        if (!o || typeof o._wk !== 'string' || !o._wk) return;
        if (cardIndex.has(o._wk)) cardIndex.delete(o._wk);
        cardIndex.set(o._wk, o);
        if (cardIndex.size > CARD_INDEX_MAX) { const k = cardIndex.keys().next().value; cardIndex.delete(k); }
    }
    const cardOf = (wk) => (typeof wk === 'string' && cardIndex.get(wk)) || null;

    // ========== [adult] p4 给独立模块用的桥(preview.js / feed.js 不直接摸 Vue 实例) ==========
    const bridge = { app: null };
    // 主播放器的去广告地址变换(与 index.html play() 同规则):开着去广告、配了 Worker、是 .m3u8、这个站没被记「过不了代理」→ 套 Worker;否则原样
    function wrapPlayUrl(url, o) {
        const u = String(url == null ? '' : url);
        const opt = o || {};
        if (!/^https?:\/\//i.test(u) || !opt.filterOn || !opt.proxy || u.indexOf('.m3u8') < 0 || opt.bad) return u;
        return String(opt.proxy).replace(/\/+$/, '') + '/?url=' + encodeURIComponent(u);
    }
    function playUrl(url, siteKey) {
        const app = bridge.app;
        let filterOn = false, proxy = '', bad = false;
        try { const AF = root.AdFilter; filterOn = !!(AF && typeof AF.isEnabled === 'function' && AF.isEnabled()); } catch (e) { }
        try { proxy = (app && app.corsProxyUrl) || ''; } catch (e) { }
        try { bad = !!(siteKey && app && typeof app._adProxyBad === 'function' && app._adProxyBad(siteKey)); } catch (e) { }
        return wrapPlayUrl(url, { filterOn, proxy, bad });
    }
    // 配置的 CORS 代理(Worker)地址;没配 → ''
    function proxyUrl() { try { const app = bridge.app; return (app && typeof app.corsProxyUrl === 'string') ? app.corsProxyUrl.replace(/\/+$/, '') : ''; } catch (e) { return ''; } }
    // 主播放器正在放 / 后台在剪插播或离线分析 → 预览、刷短片让路(v1.1.176:后台抢带宽会让正片起不来)
    function mainBusy() {
        try {
            if (root.adCut && typeof root.adCut.busy === 'function' && root.adCut.busy()) return true;
            if (root.afpOffline && root.afpOffline._busy) return true;
            const app = bridge.app;
            if (!app || !app.showDetail) return false;
            const v = root.document && root.document.querySelector('#dplayer video');
            return !!(v && !v.paused && !v.ended);
        } catch (e) { return false; }
    }
    function isTV() { try { const app = bridge.app; return !!(app && app.isTVMode); } catch (e) { return false; } }
    function openWorkExt(card) {
        const app = bridge.app;
        if (!app || typeof app.openWork !== 'function' || !card) return false;
        try { Promise.resolve(app.openWork(card)).catch(() => { }); return true; } catch (e) { return false; }
    }
    // 无痕(adult/privacy.js 的 dgPrivacy):开着时本机不记历史 / 不攒「猜你喜欢」的标签 / 不上报
    function incognito() { try { const P = root.dgPrivacy; return !!(P && typeof P.incognito === 'function' && P.incognito()); } catch (e) { return false; } }
    function privLocked() { try { const P = root.dgPrivacy; return !!(P && typeof P.locked === 'function' && P.locked()); } catch (e) { return false; } }
    // 网络:省流量 / 2G·3G / 蜂窝(没在设置里允许)→ 不自动拉视频。opt 是「移动网络也自动播放」(设置里开,只存本机)
    const CELL_KEY = 'dg_cell_ok';
    const cellOk = () => lsGet(CELL_KEY) === '1';
    // 封面悬停预览总开关(只存本机,默认开;preview.js 读同一个键)
    const PV_KEY = 'dg_pv_on';
    const pvOn = () => lsGet(PV_KEY) !== '0';
    function netBlock(conn, optIn) {
        const c = conn || null;
        if (!c) return '';
        if (c.saveData) return 'save-data';
        if (/(^|\b)(slow-2g|2g|3g)$/.test(String(c.effectiveType || ''))) return 'slow';
        if (c.type === 'cellular' && !optIn) return 'cellular';
        return '';
    }
    function netNow() { try { return netBlock(root.navigator && root.navigator.connection, cellOk()); } catch (e) { return ''; } }

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
        // 登录框的购买引导:没配 purchase_url 不出(见 brand.showBuy;切登录方式时的行内 display 也压得住)
        'html:not(.dg-buy) #register-link { display: none !important; }',
        // 卡片角标:右上 N线、右下时长、左下番号(等宽)
        '.dg-ov-n, .dg-ov-dur, .dg-ov-code { position: absolute; z-index: 2; background: rgba(0, 0, 0, 0.74); color: #fff; font-size: 10px; line-height: 1.6; padding: 0 5px; border-radius: 4px; pointer-events: none; white-space: nowrap; }',
        '.dg-ov-n { top: 6px; right: 6px; font-weight: 600; }',
        '.dg-ov-dur { right: 6px; bottom: 6px; font-variant-numeric: tabular-nums; }',
        '.dg-ov-code { left: 6px; bottom: 6px; max-width: calc(100% - 66px); overflow: hidden; text-overflow: ellipsis; color: #ffd479; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-weight: 600; }',
        '.dg-row-src { margin-left: 8px; font-size: 11px; font-weight: 600; color: #ffb347; border: 1px solid rgba(255, 179, 71, 0.45); border-radius: 10px; padding: 0 7px; line-height: 1.6; white-space: nowrap; cursor: help; }',
        // 模糊封面(设置里开):悬停 / 键盘焦点 / 按住时看清
        'html.dg-blur .poster-wrap img, html.dg-blur .dg-sug-row img { filter: blur(16px); transition: filter 0.2s; }',
        'html.dg-blur .hot-card:hover .poster-wrap img, html.dg-blur .browse-card:hover .poster-wrap img, html.dg-blur .history-card:hover .poster-wrap img, html.dg-blur .result-card:hover .poster-wrap img,'
        + ' html.dg-blur .browse-card:focus .poster-wrap img, html.dg-blur .hot-card:focus-within .poster-wrap img, html.dg-blur .poster-wrap:active img, html.dg-blur .dg-sug-row:hover img, html.dg-blur .dg-sug-row.hi img, html.dg-blur .dg-sug-row:focus img { filter: none; }',
        // 播放页作品信息条
        '.dg-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: #aaa; }',
        '.dg-meta-t { white-space: nowrap; }',
        '.dg-meta-code { display: inline-flex; align-items: center; gap: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; color: #ffd479; background: rgba(255, 212, 121, 0.1); border: 1px solid rgba(255, 212, 121, 0.35); border-radius: 4px; padding: 0 2px 0 6px; line-height: 22px; }',
        '.dg-meta-copy { background: none; border: none; color: inherit; opacity: 0.75; cursor: pointer; padding: 0 5px; min-height: 22px; }',
        '.dg-meta-copy:hover, .dg-meta-copy:focus { opacity: 1; }',
        '.dg-meta-chip { background: #2a2a2a; border: 1px solid #3a3a3a; color: #ddd; border-radius: 12px; padding: 0 10px; font-size: 12px; line-height: 22px; cursor: pointer; white-space: nowrap; }',
        '.dg-meta-chip:hover, .dg-meta-chip:focus { border-color: #888; color: #fff; }',
        '.dg-meta-chip.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
        '.dg-meta-sib { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; }',
        '.dg-meta-link { background: none; border: none; color: #ff8a80; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; font-size: 12px; }',
        '.dg-meta-clips { color: #999; }',
        '.dg-meta-clips summary { cursor: pointer; }',
        '.dg-meta-clips .dg-meta-link { color: #bbb; margin: 4px 10px 0 0; text-align: left; }',
        // 线路:同家镜像收成一张卡(+N 备用)、失效置灰、中字 / 原版 切换
        '.source-pill.dg-src-dead { opacity: 0.45; }',
        '.source-pill.dg-src-mem { border-style: dashed; }',
        '.dg-src-fam { background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.25); color: inherit; border-radius: 10px; font-size: 10px; line-height: 1.5; padding: 0 6px; cursor: pointer; white-space: nowrap; }',
        '.dg-var-seg { display: inline-flex; margin-left: 10px; border: 1px solid #444; border-radius: 12px; overflow: hidden; font-size: 12px; font-weight: normal; }',
        '.dg-var-seg button { background: transparent; border: none; color: #999; padding: 1px 10px; cursor: pointer; }',
        '.dg-var-seg button.active { background: var(--accent, #e50914); color: #fff; }',
        // 搜索建议
        '.dg-sug { pointer-events: auto; position: absolute; top: 100%; left: 4%; right: 4%; margin-top: 6px; max-height: min(70vh, 560px); overflow-y: auto; background: #181818; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6); padding: 6px; z-index: 5; }',
        '.dg-sug.compact { left: auto; width: min(440px, 92%); }',
        '.dg-sug-row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; background: transparent; border: none; border-radius: 8px; color: #ddd; text-align: left; padding: 4px 8px; cursor: pointer; font-size: 13px; }',
        '.dg-sug-row:hover, .dg-sug-row.hi, .dg-sug-row:focus { background: rgba(255, 255, 255, 0.08); color: #fff; outline: none; }',
        '.dg-sug-row img { width: 34px; height: 48px; object-fit: cover; object-position: right center; border-radius: 4px; flex: none; background: #262626; }',
        '.dg-sug-row > i { width: 34px; text-align: center; color: #888; flex: none; }',
        '.dg-sug-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }',
        '.dg-sug-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.dg-sug-sub { font-size: 11px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.dg-sug-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #ffd479; margin-right: 6px; }',
        // ---- phase 3:浏览页标签行 / 排序 / 筛选面板 / 窗口化网格 / 标签云 / 标签页页头 / 信息条 ----
        '.browse-fopt.dg-x { color: #bbb; text-decoration: line-through; border-color: rgba(255, 255, 255, 0.3); background: rgba(255, 255, 255, 0.04); }',
        '.browse-fopt[disabled] { opacity: 0.35; cursor: default; }',
        '.browse-fopt .dg-chip-x { margin-left: 5px; font-size: 10px; opacity: 0.7; }',
        '.browse-fopt .dg-c, .dg-chip .dg-c, .dg-cloud-t .dg-c { margin-left: 4px; font-size: 11px; font-weight: normal; color: #888; }',
        '.browse-fopt.dg-alltags, .browse-fopt.dg-clear { color: #ff8a80; }',
        // 已选条件的小药丸:样子同选中的选项,但不用 .active(根组件的 _browseRevealActive 会把每行第一个 .active 滚到中间,手机上排序下拉会被滚出去)
        '.browse-fopt.dg-pill { color: #fff; font-weight: 600; background: rgba(229, 9, 20, 0.2); border-color: rgba(229, 9, 20, 0.6); }',
        '.dg-tool .browse-fopts { align-items: center; }',
        '.dg-sort { height: 30px; max-width: 9.5em; background: #1e1e1e; color: #ddd; border: 1px solid #3a3a3a; border-radius: 15px; padding: 0 10px; font-size: 13px; cursor: pointer; flex: none; }',
        '.dg-sort:focus, .dg-fbtn:focus { outline: 2px solid #fff; outline-offset: 1px; }',
        '.dg-fbtn { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 15px; border: 1px solid rgba(229, 9, 20, 0.6); background: rgba(229, 9, 20, 0.14); color: #fff; font-size: 13px; white-space: nowrap; cursor: pointer; }',
        '.dg-fbtn .dg-n { min-width: 18px; height: 18px; line-height: 18px; padding: 0 5px; border-radius: 9px; background: #e50914; font-size: 11px; font-weight: 700; text-align: center; }',
        '.dg-note { margin: 4px 0 2px; color: #ffb347; font-size: 12px; }',
        'body.tv-mode .dg-blk + .dg-blk { margin-top: 26px; }',
        '.dg-head { margin: -4px 0 12px; }',
        '.dg-head-sub { color: #aaa; font-size: 13px; margin: 0 0 6px; }',
        '.dg-head .browse-frow { padding: 4px 0; }',
        '.dg-cloud { padding: 8px 0 30px; }',
        '.dg-cloud-g { margin: 18px 0 6px; }',
        '.dg-cloud-gt { color: #999; font-size: 13px; letter-spacing: 1px; margin-bottom: 8px; }',
        '.dg-cloud-ts { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }',
        '.dg-cloud-t { background: none; border: 0; padding: 4px 2px; color: #ccc; cursor: pointer; line-height: 1.3; }',
        '.dg-cloud-t:hover, .dg-cloud-t:focus { color: #fff; text-decoration: underline; text-underline-offset: 3px; }',
        '.dg-cloud-t.w1 { font-size: 13px; color: #999; } .dg-cloud-t.w2 { font-size: 14px; } .dg-cloud-t.w3 { font-size: 16px; } .dg-cloud-t.w4 { font-size: 19px; font-weight: 600; color: #eee; } .dg-cloud-t.w5 { font-size: 22px; font-weight: 700; color: #fff; }',
        'html.dg-sheet-lock, html.dg-sheet-lock body { overflow: hidden !important; }',
        '.dg-sheet-mask { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 2000; background: rgba(0, 0, 0, 0.55); display: flex; justify-content: flex-end; }',
        '.dg-sheet { width: min(420px, 92vw); height: 100%; display: flex; flex-direction: column; background: #181818; color: #ddd; border-left: 1px solid rgba(255, 255, 255, 0.1); box-shadow: -12px 0 32px rgba(0, 0, 0, 0.6); animation: dg-sheet-r 0.2s ease-out; font-size: 14px; }',
        '@keyframes dg-sheet-r { from { transform: translateX(100%); } to { transform: none; } }',
        '@keyframes dg-sheet-u { from { transform: translateY(100%); } to { transform: none; } }',
        '.dg-sheet-hd { display: flex; align-items: center; gap: 12px; padding: 14px 16px; padding-top: calc(14px + env(safe-area-inset-top, 0px)); border-bottom: 1px solid rgba(255, 255, 255, 0.08); }',
        '.dg-sheet-hd b { flex: 1; font-size: 16px; color: #fff; }',
        '.dg-xmode { display: inline-flex; align-items: center; gap: 5px; margin: 0; font-size: 12px; color: #bbb; cursor: pointer; white-space: nowrap; }',
        '.dg-sheet-reset { background: none; border: 0; color: #ff8a80; font-size: 13px; padding: 4px 6px; cursor: pointer; }',
        '.dg-sheet-reset[disabled] { color: #555; cursor: default; }',
        '.dg-sheet-x { width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.05); color: #fff; cursor: pointer; }',
        '.dg-sheet-bd { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 4px 16px 16px; }',
        '.dg-sheet-tip { color: #777; font-size: 12px; margin: 8px 0 2px; }',
        '.dg-sec { padding: 12px 0; border-bottom: 1px dashed rgba(255, 255, 255, 0.07); }',
        '.dg-sec-t { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; color: #999; font-size: 13px; letter-spacing: 1px; }',
        'summary.dg-sec-t { cursor: pointer; margin-bottom: 0; display: list-item; }',
        '.dg-more-sec[open] summary.dg-sec-t { margin-bottom: 8px; }',
        '.dg-sec-n { color: #777; font-size: 12px; letter-spacing: 0; }',
        '.dg-chips { display: flex; flex-wrap: wrap; gap: 6px; }',
        '.dg-chip { height: 30px; padding: 0 11px; border-radius: 15px; border: 1px solid #3a3a3a; background: #222; color: #ccc; font-size: 13px; white-space: nowrap; cursor: pointer; }',
        '.dg-chip:hover:not([disabled]), .dg-chip:focus { color: #fff; border-color: #888; }',
        '.dg-chip.on { color: #fff; font-weight: 600; background: rgba(229, 9, 20, 0.25); border-color: rgba(229, 9, 20, 0.7); }',
        '.dg-chip.ex { color: #bbb; text-decoration: line-through; background: #1a1a1a; border-color: #777; }',
        '.dg-chip[disabled] { opacity: 0.35; cursor: default; }',
        '.dg-sq { width: 100%; height: 34px; margin: 0 0 8px; padding: 0 14px; border-radius: 17px; border: 1px solid #3a3a3a; background: #111; color: #eee; font-size: 13px; }',
        '.dg-sheet-ft { padding: 12px 16px; padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid rgba(255, 255, 255, 0.08); }',
        '.dg-sheet-go { width: 100%; height: 42px; border-radius: 21px; border: 0; background: #e50914; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }',
        '.dg-sheet-go:focus, .dg-sheet-x:focus { outline: 2px solid #fff; outline-offset: 2px; }',
        '@media (max-width: 768px) { .dg-sheet-mask { align-items: flex-end; justify-content: stretch; } .dg-sheet { width: 100%; height: auto; max-height: 86vh; border-left: 0; border-top: 1px solid rgba(255, 255, 255, 0.12); border-radius: 16px 16px 0 0; animation-name: dg-sheet-u; } .dg-sheet-hd { padding-top: 14px; } }',
        '.dg-meta-tags { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; font-size: 12px; }',
        '.dg-meta-tg { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }',
        '.dg-meta-tgl { color: #777; min-width: 5em; }',
        '.dg-meta-rel { white-space: nowrap; color: #bbb; }',
        '.browse-filters:empty { display: none; }',
        // ---- p4:刷短片入口 / 播放页相关推荐 / 女优索引与女优页头 / 扩展设置容器 ----
        '.dg-nav-feed { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 17px; border: 1px solid rgba(255, 255, 255, 0.28); background: rgba(0, 0, 0, 0.35); color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; }',
        '.dg-nav-feed:hover, .dg-nav-feed:focus { border-color: #fff; background: rgba(229, 9, 20, 0.3); outline: none; }',
        '@media (max-width: 480px) { .dg-nav-feed span { display: none; } .dg-nav-feed { width: 36px; padding: 0; justify-content: center; } }',
        '.catnav-q.is-feed i { color: #2dd4bf; }',
        '.dg-rails { margin-top: 18px; }',
        '.dg-rail { margin-top: 14px; }',
        '.dg-rail-t { display: flex; align-items: center; gap: 8px; color: #eee; font-size: 16px; font-weight: 600; margin: 0 0 8px; }',
        '.dg-rail-t > i { color: #e50914; font-size: 14px; }',
        '.dg-rail-all { margin-left: auto; background: none; border: 0; color: #aaa; font-size: 13px; cursor: pointer; padding: 4px 6px; }',
        '.dg-rail-all:hover, .dg-rail-all:focus { color: #fff; }',
        '.dg-rail-row { display: flex; gap: 12px; overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; padding: 2px 2px 10px; scrollbar-width: thin; }',
        '.dg-rail-card { flex: none; width: calc(var(--card-w, 150px) * 0.86); cursor: pointer; }',
        '.dg-rail-card .poster-wrap { position: relative; border-radius: 8px; overflow: hidden; }',
        '.dg-rail-card .movie-name { font-size: 13px; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.dg-rail-card:focus { outline: 3px solid #fff; outline-offset: 2px; }',
        '.dg-acts { padding: 8px 0 30px; }',
        '.dg-acts-q { max-width: 420px; }',
        '.dg-acts-sec { margin: 16px 0 6px; }',
        '.dg-cloud-links { display: flex; justify-content: flex-end; margin: 0 0 4px; }',
        '.dg-act-head { margin: 0 0 4px; }',
        '.dg-act-name { color: #fff; font-size: 18px; font-weight: 700; margin: 0 0 4px; }',
        '.dg-act-idx { margin-left: 10px; background: none; border: 0; padding: 0; color: #ff8a80; font-size: 12px; cursor: pointer; }',
        '.dg-set-ext:empty { display: none; }',
        // 封面上长按预览时不弹系统菜单(iOS 存图 / 安卓长按菜单)
        '.hot-card .poster-wrap img, .browse-card .poster-wrap img, .dg-rail-card .poster-wrap img { -webkit-touch-callout: none; }',
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
        const inCard = (img) => img && img.tagName === 'IMG' && img.closest && img.closest('.hot-card .poster-wrap, .browse-card .poster-wrap, .dg-sug-row');
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
    // [adult] p4 目录卡片的悬停 / 按下 → dgAdultHooks.onCardHover(card, el, ev)。卡片带 data-wk(首页行 / 浏览网格 / 相关推荐);
    //   文档级委托(不给几百张卡各绑监听),鼠标在卡片内部移动不重复触发;没人订阅时什么都不做
    const CARD_SEL = '.hot-card[data-wk], .browse-card[data-wk], .dg-rail-card[data-wk]';
    function hookCardHover() {
        const d = root.document;
        const fire = (el, ev) => {
            const wk = el.getAttribute('data-wk');
            if (!wk || !WK_RE.test(wk) || wk.length > 300) return;
            hooks.call('onCardHover', [cardOf(wk) || { wk, _wk: wk }, el, ev]);
        };
        const cardEl = (t) => (t && t.closest ? t.closest(CARD_SEL) : null);
        d.addEventListener('pointerover', (e) => {
            if (!hooks.H.count('onCardHover')) return;
            if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;   // 触屏走 touchstart
            const el = cardEl(e.target);
            if (!el) return;
            const from = e.relatedTarget;
            if (from && el.contains(from)) return;   // 卡片内部移动
            fire(el, e);
        }, { passive: true, capture: true });
        d.addEventListener('touchstart', (e) => {
            if (!hooks.H.count('onCardHover') || (e.touches && e.touches.length > 1)) return;
            const el = cardEl(e.target);
            if (el) fire(el, e);
        }, { passive: true, capture: true });
    }
    // 模糊封面(本机设置,默认关):<html> 上的 dg-blur 类
    const BLUR_KEY = 'dg_blur_cover';
    const blurOn = () => lsGet(BLUR_KEY) === '1';
    function applyBlur(on) { try { root.document.documentElement.classList.toggle('dg-blur', !!on); } catch (e) { } }
    function boot() {
        injectCss();
        brand.apply(brand.name());
        applyBlur(blurOn());
        brand.showBuy();
        // loader / 登录框里的站名节点在 <head> 之后才解析出来:DOM 就绪时按上次缓存的站名再写一遍(/api/config 回来后 adultApplyConfig 再更新)
        try { root.document.addEventListener('DOMContentLoaded', () => { brand.apply(brand.name()); brand.showBuy(); }, { once: true }); } catch (e) { }
        auth.install();
        hookImages();
        hooks.install();      // [adult] p4:window.dgAdultHooks(先于 defer 的扩展模块)
        hookCardHover();
        // 登录框比 Vue 应用先出来:年龄确认之后单独拿一次 /api/config(站名、购买地址),不等应用启动
        ageGate.whenAccepted().then(() => fetchJson('/api/config', 8000)).then(c => {
            if (!c || typeof c !== 'object') return;
            if (c.site_name) brand.apply(c.site_name);
            brand.applyBuy(c.purchase_url);
        }).catch(() => { });
    }

    // ========== phase 3 组件(由 mixin 的 components 注册;模板是字符串,vue.global 的运行时编译器现编) ==========
    //   都是根组件的子组件:它们自己的状态(面板开合、搜索框打字、网格哪几块活着)变了只重渲染自己,不牵动几万行的根模板。
    //   与根组件只通过 props / 事件来往:@go(导航)→ 根的 adGo;@sheet(面板开合)→ adSheet;@pick(点卡片)→ browsePick
    const ROWS_PER_BLOCK = 6;                          // 每块 6 排
    const IO_MARGIN = '1600px 0px 1600px 0px';         // 视口上下各 1600px 内的块是活的
    const dCache = new Map();                          // 标签云 / 标签页 / 女优 / 厂牌列表:url → { at, d }(10 分钟)
    function cachedJson(url, ms) {
        const hit = dCache.get(url);
        if (hit && Date.now() - hit.at < 600000) return Promise.resolve(hit.d);
        return fetchJson(url, ms || 10000).then(d => { if (d != null) { if (dCache.size > 200) dCache.clear(); dCache.set(url, { at: Date.now(), d }); } return d; });
    }
    // 还没量到真实列数时按 index.html 的 .browse-grid 规则估一个(量到之后以 getComputedStyle 为准)
    function guessCols() {
        const W = (root && typeof root.innerWidth === 'number' && root.innerWidth > 0) ? root.innerWidth : 1280;
        let min = 150, gap = 16, pad = 0.10;
        if (W <= 480) { min = 100; gap = 10; pad = 0.08; } else if (W <= 768) { min = 130; gap = 10; pad = 0.08; }
        return Math.max(2, Math.floor((W * (1 - pad) + gap) / (min + gap)));
    }
    const onImgLoad = (e) => { const t = e && e.target; if (t) { t.classList.add('loaded'); if (t.parentElement) t.parentElement.classList.add('img-loaded'); } };
    // 浏览页网格(窗口化):片单按「块」(6 排一块)切开,每块一个 .browse-grid;离视口 ±1600px 以外的块只留一个等高空壳,
    //   DOM 里始终只有几块(几十~两百张)卡片。块的死活只在 IntersectionObserver 回调里改(滚动时不写任何响应式状态);
    //   列数变了(转屏/改窗口)才重新分块,空壳高度按一张卡片的实测高度估
    const DgAdGrid = {
        name: 'DgAdGrid',
        // p4:keep = 片单是「一直在长 / 重排」的同一份(搜索结果流式到达):换数组不重新分块,只有清空 / 从空到有才重来
        props: { items: { type: Array, default: () => [] }, poster: { type: Function, default: null }, tv: { type: Boolean, default: false }, loading: { type: Boolean, default: false }, keep: { type: Boolean, default: false } },
        emits: ['pick', 'imgerr'],
        data() { return { cols: guessCols(), dead: {} }; },
        computed: {
            per() { return Math.max(1, this.cols | 0) * ROWS_PER_BLOCK; },
            nBlocks() { return Math.ceil(this.items.length / this.per); },
        },
        watch: {
            items(nv, ov) { if (nv !== ov && !(this.keep && nv && nv.length && ov && ov.length)) this.reset(); },   // 换了筛选:整个新数组
            nBlocks(n, o) {
                // 新的一页落在最后一块:它永远是活的(还在被填)
                if (n > 0 && this.dead[n - 1] != null) { const d = Object.assign({}, this.dead); delete d[n - 1]; this.dead = d; }
                if (n < o) this.reset();
            },
        },
        methods: {
            slice(bi) { return this.items.slice(bi * this.per, (bi + 1) * this.per); },
            src(p) { return this.poster ? this.poster(p) : (p || PLACEHOLDER); },
            pick(it) { this.$emit('pick', it); },
            loaded: onImgLoad,
            reset() {
                this.dead = {};
                this._needMeasure = true;
                if (this._io) { this._io.disconnect(); this._obs = new WeakSet(); }
                this.$nextTick(() => this.sync());
            },
            ensureIO() {
                if (this._io || typeof IntersectionObserver === 'undefined') return this._io;
                this._obs = new WeakSet();
                this._io = new IntersectionObserver((es) => this.onIO(es), { rootMargin: IO_MARGIN });
                return this._io;
            },
            onIO(entries) {
                let d = null;
                const last = this.nBlocks - 1;
                for (const en of entries) {
                    const bi = parseInt(en.target.getAttribute('data-blk'), 10);
                    if (!(bi >= 0)) continue;
                    if (en.isIntersecting) {
                        if (this.dead[bi] != null) { d = d || Object.assign({}, this.dead); delete d[bi]; }
                    } else if (this.dead[bi] == null && bi < last) {
                        const h = Math.round(en.boundingClientRect.height);
                        if (h > 0) { d = d || Object.assign({}, this.dead); d[bi] = h; }
                    }
                }
                if (d) this.dead = d;
            },
            // 渲染之后:新出现的块交给 IntersectionObserver;需要时量一次真实列数
            sync() {
                const el = this.$el;
                if (!el || !el.querySelectorAll) return;
                const io = this.ensureIO();
                if (io) el.querySelectorAll('.dg-blk').forEach(b => { if (!this._obs.has(b)) { this._obs.add(b); io.observe(b); } });
                if (this._needMeasure) this.measure();
            },
            measure() {
                const el = this.$el && this.$el.querySelector && this.$el.querySelector('.dg-blk.dg-live');
                if (!el || !root.getComputedStyle) return;
                this._needMeasure = false;
                let c = 0;
                try { const g = root.getComputedStyle(el).gridTemplateColumns; c = g && g !== 'none' ? g.split(' ').filter(Boolean).length : 0; } catch (e) { }
                if (c > 0 && c !== this.cols) this.setCols(c);
            },
            // 列数变了:重新分块。离当前位置远的块直接给估算高度的空壳(按一张卡片的实测高),再让 IntersectionObserver 从头判一遍
            setCols(c) {
                const card = this.$el.querySelector('.dg-blk.dg-live .browse-card');
                let ch = 0, gap = 0;
                try { ch = card ? card.offsetHeight : 0; gap = card ? (parseFloat(root.getComputedStyle(card.parentElement).rowGap) || 0) : 0; } catch (e) { }
                this.cols = c;
                const n = this.nBlocks;
                const d = {};
                if (ch > 0) {
                    const est = Math.round(ROWS_PER_BLOCK * ch + (ROWS_PER_BLOCK - 1) * gap);
                    let k = 0;
                    try { k = Math.floor(Math.max(0, -this.$el.getBoundingClientRect().top) / (est + gap)); } catch (e) { }
                    for (let i = 0; i < n - 1; i++) if (i < k - 1 || i > k + 2) d[i] = est;
                }
                this.dead = d;
                if (this._io) { this._io.disconnect(); this._obs = new WeakSet(); }
                this.$nextTick(() => this.sync());
            },
            onResize() {
                clearTimeout(this._rsT);
                this._rsT = setTimeout(() => { this._needMeasure = true; this.measure(); }, 200);
            },
        },
        mounted() {
            this._needMeasure = true;
            this._onRs = () => this.onResize();
            try { root.addEventListener('resize', this._onRs); } catch (e) { }
            // 网格自己的宽度变了也要重量列数(筛选面板锁滚动时滚动条消失、侧栏开合,都不发 resize);只看宽度,高度随翻页一直在变不算
            try {
                if (typeof root.ResizeObserver === 'function') {
                    this._ro = new root.ResizeObserver((es) => {
                        const w = es && es[0] && es[0].contentRect ? Math.round(es[0].contentRect.width) : 0;
                        if (w && w !== this._w) { const first = !this._w; this._w = w; if (!first) this.onResize(); }
                    });
                    this._ro.observe(this.$el);
                }
            } catch (e) { }
            this.sync();
        },
        updated() { this.sync(); },
        beforeUnmount() {
            clearTimeout(this._rsT);
            try { root.removeEventListener('resize', this._onRs); } catch (e) { }
            if (this._ro) { try { this._ro.disconnect(); } catch (e) { } this._ro = null; }
            if (this._io) { this._io.disconnect(); this._io = null; }
        },
        template: `<div class="dg-grid">
  <div v-if="loading && !items.length" class="browse-grid"><div class="browse-card is-skel" v-for="n in 12" :key="'sk' + n" aria-hidden="true"><div class="poster-wrap"></div><div class="skel-line"></div><div class="skel-line short"></div></div></div>
  <div v-for="bi in nBlocks" :key="'blk' + bi" class="browse-grid dg-blk" :class="{ 'dg-live': dead[bi - 1] == null }" :data-blk="bi - 1" :style="dead[bi - 1] != null ? { height: dead[bi - 1] + 'px' } : null">
    <template v-if="dead[bi - 1] == null">
      <div class="browse-card" v-for="item in slice(bi - 1)" :key="'b-' + item.id" :data-bid="item.id" :data-wk="item._wk || null" :tabindex="tv ? 0 : null" @click="pick(item)" @keydown.enter.prevent="pick(item)">
        <div class="poster-wrap">
          <img :src="src(item.poster_path)" loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" @load="loaded" @error="$emit('imgerr', item)">
          <div v-if="item._badge" class="dg-ad-badge">{{ item._badge }}</div><span v-if="item._n >= 2" class="dg-ov-n">{{ item._n }}线</span><span v-if="item._durText" class="dg-ov-dur">{{ item._durText }}</span><span v-if="item._code" class="dg-ov-code">{{ item._code }}</span>
        </div>
        <div class="movie-name">{{ item.title || item.name }}</div>
        <div class="movie-date dg-ad-sub">{{ item._sub }}</div>
      </div>
    </template>
  </div>
</div>`,
    };

    // 标签行 + 排序 / 筛选按钮 / 已选条件 + 筛选面板(手机底部抽屉、宽屏右侧面板)。所有改动 @go → 根的 adGo(立刻生效,面板里的数跟着刷新)
    const BACK_KEYS = new Set(['Escape', 'Esc', 'GoBack', 'BrowserBack']);
    const DgAdFilter = {
        name: 'DgAdFilter',
        props: {
            sel: { type: Object, default: () => ({}) }, type: { type: String, default: '' }, facets: { type: Object, default: null },
            total: { type: Number, default: 0 }, tv: { type: Boolean, default: false }, legacy: { type: Array, default: () => [] },
        },
        emits: ['go', 'sheet'],
        data() { return { open: false, xmode: false, note: '', sq: '', aq: '', aRes: null, studios: null }; },
        computed: {
            chips() { return chipRow(this.facets, this.sel, this.legacy); },
            sorts() { return sortOpts(this.facets, this.sel); },
            n() { return filterCount(this.sel); },
            pills() { return activePills(this.sel); },
            countText() { return countLabel(this.total || 0); },
            sheetGroups() {
                const f = this.facets;
                return f ? f.groups.map(g => ({ id: g.id, label: g.label, tags: g.tags.map(t => Object.assign({}, t, { st: this.st(t.id) })) })) : [];
            },
            more() { return (this.facets ? this.facets.more : []).map(t => Object.assign({}, t, { st: this.st(t.id) })); },
            moreOn() { return this.more.some(t => t.st); },
            durs() { return this.opts(DURS, this.facets && this.facets.dur, this.sel.dur); },
            vars() { return this.opts(VARIANTS, this.facets && this.facets.variant, this.sel.v); },
            unkNote() {
                const d = this.sel.dur;
                if (!d || d === 'unk' || !this.facets) return 0;
                const u = this.facets.dur.find(x => x.id === 'unk');
                return u ? u.count : 0;
            },
            buckets() { return (this.type === 'all' && this.facets) ? this.facets.buckets : []; },
            studioTop() {
                const list = (this.facets ? this.facets.studio : []).slice();
                const cur = this.sel.studio;
                if (cur && !list.some(s => s.id === cur)) list.unshift({ id: cur, label: studioLabel(cur), count: 0 });
                return list;
            },
            studioHits() {
                const q = this.sq.trim().toLowerCase();
                if (!q || !this.studios) return [];
                return this.studios.filter(s => s.label.toLowerCase().indexOf(q) >= 0 || s.id.toLowerCase().indexOf(q) >= 0).slice(0, 24);
            },
            actTop() {
                const list = (this.facets ? this.facets.actress : []).slice();
                const cur = this.sel.actress;
                if (cur && !list.some(a => a.aid === cur)) list.unshift({ aid: cur, name: actressName(cur) || '已选女优', count: 0 });
                return list;
            },
        },
        methods: {
            countLabel,
            st(id) { const s = this.sel || {}; return (s.t || []).indexOf(id) >= 0 ? 'in' : (s.x || []).indexOf(id) >= 0 ? 'ex' : ''; },
            opts(defs, counts, cur) {
                const by = new Map((counts || []).map(c => [c.id, c.count]));
                const has = !!counts && counts.length > 0;
                return defs.map(d => {
                    const c = d.k && has ? (by.get(d.k) || 0) : null;
                    return { k: d.k, l: d.l, c, off: !!d.k && has && !c && (cur || '') !== d.k };
                });
            },
            chipTitle(c) { return c.st === 'ex' ? '已排除「' + c.label + '」,点一下取消' : c.st === 'in' ? '已选「' + c.label + '」,点一下取消' : c.label + (c.count ? ' · ' + c.count + ' 部' : ''); },
            go(patch) { this.$emit('go', { patch }); },
            flash(msg) {
                if (!msg) return;
                this.note = msg;
                clearTimeout(this._noteT);
                this._noteT = setTimeout(() => { this.note = ''; }, 2200);
            },
            tapTag(id, mode) {
                const r = nextTagState(this.sel, id, mode);
                if (r.err != null) { this.flash(r.err); return; }
                this.go({ t: r.t, x: r.x });
            },
            tap(id) { this.tapTag(id, 'toggle'); },
            tapSheet(id) { this.tapTag(id, this.xmode ? 'x' : 'cycle'); },
            drop(k) {
                const s = this.sel || {};
                if (k === 'review') this.go({ t: (s.t || []).filter(featurable), x: (s.x || []).filter(featurable) });
                else { const p = {}; p[k] = ''; this.go(p); }
            },
            clearAll() { this.go({ t: [], x: [], dur: '', v: '', studio: '', actress: '', lp: '' }); },
            loadStudios() {
                if (this.studios || this._stBusy) return;
                this._stBusy = true;
                cachedJson('/api/catalog/studios?b=' + encodeURIComponent(this.sel.b || ''), 8000).then(d => { this._stBusy = false; this.studios = normStudios(d); });
            },
            actSearch() {
                clearTimeout(this._aT);
                const q = this.aq.trim();
                if (!q) { this.aRes = null; return; }
                if (q.length > 40) return;
                this._aT = setTimeout(() => {
                    const seq = (this._aSeq = (this._aSeq || 0) + 1);
                    cachedJson('/api/catalog/actress?q=' + encodeURIComponent(q), 8000).then(d => {
                        if (seq === this._aSeq && this.aq.trim() === q) this.aRes = normActressList(d);
                    });
                }, 250);
            },
            // ---- 面板开合(根组件压/退一条历史:手机返回键先关面板)----
            openSheet() {
                if (this.open) return true;
                this.open = true;
                this.studios = null;
                this.$emit('sheet', true);
                const d = root.document;
                try { d.documentElement.classList.add('dg-sheet-lock'); } catch (e) { }
                this._onKey = (e) => this.onKey(e);
                this._onFocus = (e) => this.onFocusIn(e);
                try { root.addEventListener('keydown', this._onKey, true); d.addEventListener('focusin', this._onFocus, true); } catch (e) { }
                this.$nextTick(() => { const x = this.$refs.sheetX; try { if (x) x.focus({ preventScroll: true }); } catch (e) { } });
                return true;
            },
            // fromPop = 根组件在 popstate 里关的(历史已经退掉了,不再通知)
            closeSheet(fromPop) {
                if (!this.open) return;
                this.open = false;
                this.unbind();
                if (!fromPop) this.$emit('sheet', false);
                this.$nextTick(() => { const b = this.$refs.fbtn; try { if (b) b.focus({ preventScroll: true }); } catch (e) { } });
            },
            unbind() {
                try { root.document.documentElement.classList.remove('dg-sheet-lock'); } catch (e) { }
                try { root.removeEventListener('keydown', this._onKey, true); root.document.removeEventListener('focusin', this._onFocus, true); } catch (e) { }
            },
            inSheet(el) { const s = this.$refs.sheet; try { return !!(s && el && s.contains(el)); } catch (e) { return false; } },
            focusables() {
                const s = this.$refs.sheet;
                return s ? Array.prototype.filter.call(s.querySelectorAll('button:not([disabled]), input, select, summary, [tabindex]:not([tabindex="-1"])'), x => x.offsetParent !== null) : [];
            },
            // 窗口捕获阶段:返回键 / Esc 只关面板(不让根组件的电视返回键把整个浏览页关掉);Tab 在面板里循环
            onKey(e) {
                if (!this.open) return;
                const k = e.key, typing = e.target && /^(input|textarea|select)$/i.test(e.target.tagName || '');
                if (BACK_KEYS.has(k) || (k === 'Backspace' && !typing)) { e.preventDefault(); e.stopImmediatePropagation(); this.closeSheet(); return; }
                if (k === 'Tab') {
                    const f = this.focusables();
                    if (!f.length) return;
                    const i = f.indexOf(root.document.activeElement);
                    const to = e.shiftKey ? (i <= 0 ? f[f.length - 1] : null) : (i < 0 || i === f.length - 1 ? f[0] : null);
                    if (to) { e.preventDefault(); try { to.focus(); } catch (x) { } }
                }
            },
            // 焦点跑到面板外(电视方向键的焦点导航)→ 拉回面板
            onFocusIn(e) {
                if (!this.open || this.inSheet(e.target)) return;
                const f = this.focusables();
                if (f.length) { try { f[0].focus({ preventScroll: true }); } catch (x) { } }
            },
        },
        beforeUnmount() {
            clearTimeout(this._noteT); clearTimeout(this._aT);
            if (this.open) { this.open = false; this.unbind(); this.$emit('sheet', false); }
        },
        template: `<div class="dg-af">
  <div v-if="chips.length" class="browse-frow" role="group" aria-label="标签">
    <span class="browse-flabel">标签</span>
    <div class="browse-fopts">
      <button v-for="c in chips" :key="'c-' + c.id" type="button" class="browse-fopt" :class="{ active: c.st === 'in', 'dg-x': c.st === 'ex' }" :disabled="c.off" :aria-pressed="c.st ? 'true' : 'false'" :title="chipTitle(c)" @click="tap(c.id)">{{ c.st === 'ex' ? '−' : '' }}{{ c.label }}<i v-if="c.st" class="fas fa-xmark dg-chip-x" aria-hidden="true"></i></button>
      <button type="button" class="browse-fopt dg-alltags" @click="$emit('go', { view: 'tags', b: sel.b || '' })">全部标签 <i class="fas fa-angle-right" aria-hidden="true"></i></button>
    </div>
  </div>
  <div class="browse-frow dg-tool" role="group" aria-label="排序与筛选">
    <span class="browse-flabel">排序</span>
    <div class="browse-fopts">
      <select class="dg-sort" :value="sel.sort" aria-label="排序" @change="go({ sort: $event.target.value })"><option v-for="s in sorts" :key="s.k" :value="s.k">{{ s.l }}</option></select>
      <button type="button" ref="fbtn" class="dg-fbtn" :aria-expanded="open ? 'true' : 'false'" @click="openSheet()"><i class="fas fa-sliders" aria-hidden="true"></i> 筛选<span v-if="n" class="dg-n">{{ n }}</span></button>
      <button v-for="p in pills" :key="'p-' + p.k" type="button" class="browse-fopt dg-pill" :title="'去掉 ' + p.l" @click="drop(p.k)">{{ p.l }} <i class="fas fa-xmark" aria-hidden="true"></i></button>
      <button v-if="n" type="button" class="browse-fopt dg-clear" @click="clearAll()">清除筛选</button>
    </div>
  </div>
  <div v-if="note && !open" class="dg-note" role="status">{{ note }}</div>
  <teleport to="body">
    <div v-if="open" class="dg-sheet-mask" @click.self="closeSheet()">
      <div class="dg-sheet" ref="sheet" role="dialog" aria-modal="true" aria-label="筛选">
        <div class="dg-sheet-hd">
          <b>筛选</b>
          <label class="dg-xmode"><input type="checkbox" v-model="xmode"> 排除模式</label>
          <button type="button" class="dg-sheet-reset" :disabled="!n" @click="clearAll()">重置</button>
          <button type="button" ref="sheetX" class="dg-sheet-x" aria-label="关闭筛选" @click="closeSheet()"><i class="fas fa-xmark" aria-hidden="true"></i></button>
        </div>
        <div class="dg-sheet-bd">
          <div class="dg-sheet-tip">{{ xmode ? '排除模式：点一下标签就排除它' : '点一下选中，再点一下排除，第三下取消' }} · 标签需同时满足，选中、排除各最多 3 个</div>
          <div v-if="note" class="dg-note" role="status">{{ note }}</div>
          <section v-if="buckets.length" class="dg-sec">
            <div class="dg-sec-t">分类</div>
            <div class="dg-chips"><button v-for="b in buckets" :key="'sb-' + b.id" type="button" class="dg-chip" :disabled="!b.count" @click="go({ b: b.id })">{{ b.label }}<span class="dg-c">{{ b.count }}</span></button></div>
          </section>
          <section class="dg-sec">
            <div class="dg-sec-t">时长<span v-if="unkNote" class="dg-sec-n">另有 {{ unkNote }} 部时长未知，未计入</span></div>
            <div class="dg-chips"><button v-for="d in durs" :key="'sd-' + d.k" type="button" class="dg-chip" :class="{ on: (sel.dur || '') === d.k }" :aria-pressed="(sel.dur || '') === d.k ? 'true' : 'false'" :disabled="d.off" @click="go({ dur: d.k })">{{ d.l }}<span v-if="d.c != null" class="dg-c">{{ d.c }}</span></button></div>
          </section>
          <section class="dg-sec">
            <div class="dg-sec-t">版本</div>
            <div class="dg-chips"><button v-for="d in vars" :key="'sv-' + d.k" type="button" class="dg-chip" :class="{ on: (sel.v || '') === d.k }" :aria-pressed="(sel.v || '') === d.k ? 'true' : 'false'" :disabled="d.off" @click="go({ v: d.k })">{{ d.l }}<span v-if="d.c != null" class="dg-c">{{ d.c }}</span></button></div>
          </section>
          <section v-for="g in sheetGroups" :key="'sg-' + g.id" class="dg-sec">
            <div class="dg-sec-t">{{ g.label }}</div>
            <div class="dg-chips"><button v-for="t in g.tags" :key="'st-' + t.id" type="button" class="dg-chip" :class="{ on: t.st === 'in', ex: t.st === 'ex' }" :aria-pressed="t.st ? 'true' : 'false'" :disabled="!t.st && !t.count" @click="tapSheet(t.id)">{{ t.st === 'ex' ? '−' : '' }}{{ t.label }}<span class="dg-c">{{ t.count }}</span></button></div>
          </section>
          <section class="dg-sec">
            <div class="dg-sec-t">厂牌</div>
            <input class="dg-sq" type="search" v-model="sq" placeholder="搜索厂牌" aria-label="搜索厂牌" maxlength="40" @focus="loadStudios()">
            <div class="dg-chips">
              <button v-for="s in (sq.trim() ? studioHits : studioTop)" :key="'ss-' + s.id" type="button" class="dg-chip" :class="{ on: sel.studio === s.id }" :aria-pressed="sel.studio === s.id ? 'true' : 'false'" @click="go({ studio: sel.studio === s.id ? '' : s.id })">{{ s.label }}<span v-if="s.count" class="dg-c">{{ s.count }}</span></button>
              <span v-if="sq.trim() && studios && !studioHits.length" class="dg-sec-n">没有匹配的厂牌</span>
              <span v-if="!sq.trim() && !studioTop.length" class="dg-sec-n">当前条件下没有可筛的厂牌</span>
            </div>
          </section>
          <section class="dg-sec">
            <div class="dg-sec-t">女优</div>
            <input class="dg-sq" type="search" v-model="aq" placeholder="搜索女优" aria-label="搜索女优" maxlength="40" @input="actSearch()">
            <div class="dg-chips">
              <button v-for="a in (aq.trim() ? (aRes || []) : actTop)" :key="'sa-' + a.aid" type="button" class="dg-chip" :class="{ on: sel.actress === a.aid }" :aria-pressed="sel.actress === a.aid ? 'true' : 'false'" @click="go({ actress: sel.actress === a.aid ? '' : a.aid })">{{ a.name }}<span v-if="a.count || a.n" class="dg-c">{{ a.count || a.n }}</span></button>
              <span v-if="aq.trim() && aRes && !aRes.length" class="dg-sec-n">没有找到</span>
              <span v-if="!aq.trim() && !actTop.length" class="dg-sec-n">当前条件下没有可筛的女优</span>
            </div>
          </section>
          <details v-if="more.length" class="dg-sec dg-more-sec" :open="moreOn">
            <summary class="dg-sec-t">更多（只能筛选）</summary>
            <div class="dg-chips"><button v-for="t in more" :key="'sm-' + t.id" type="button" class="dg-chip" :class="{ on: t.st === 'in', ex: t.st === 'ex' }" :aria-pressed="t.st ? 'true' : 'false'" @click="tapSheet(t.id)">{{ t.st === 'ex' ? '−' : '' }}{{ t.label }}</button></div>
          </details>
        </div>
        <div class="dg-sheet-ft"><button type="button" class="dg-sheet-go" @click="closeSheet()">查看 {{ countText }} 部</button></div>
      </div>
    </div>
  </teleport>
</div>`,
    };

    // 标签页 / 女优页的页头:标签所属分面组、按分类细分(点了 = 这个标签 + 那个分类)、相关标签(只有 featured);女优名 + 别名
    const DgAdHead = {
        name: 'DgAdHead',
        // p4:total = 浏览页当前筛选的部数(女优页头的「共 N 部」)
        props: { view: { type: String, default: '' }, sel: { type: Object, default: () => ({}) }, total: { type: Number, default: 0 } },
        emits: ['go', 'learn'],
        data() { return { info: null, err: false }; },
        computed: {
            kind() { const s = this.sel || {}; return (this.view === 'tag' && s.t && s.t.length) ? 'tag' : (s.actress ? 'actress' : ''); },
            key() { const s = this.sel || {}; return this.kind === 'tag' ? 'tag:' + s.t[0] : this.kind === 'actress' ? 'actress:' + s.actress : ''; },
        },
        watch: { key: { immediate: true, handler() { this.load(); } } },
        methods: {
            countLabel,
            load() {
                const k = this.key, s = this.sel || {};
                this.info = null; this.err = false;
                if (!k) return;
                const kind = this.kind;
                const url = kind === 'tag' ? '/api/catalog/tag/' + encodeURIComponent(s.t[0]) : '/api/catalog/actress/' + encodeURIComponent(s.actress) + '?page=1';
                cachedJson(url, 8000).then(d => {
                    if (k !== this.key) return;
                    const v = kind === 'tag' ? normTagInfo(d) : normActress(d);
                    if (!v) { this.err = true; return; }
                    this.info = Object.freeze(v);
                    this.$emit('learn');
                });
            },
        },
        template: `<div v-if="kind" class="dg-head">
  <template v-if="kind === 'tag'">
    <div v-if="err" class="dg-head-sub">这个标签暂时没有可看的作品</div>
    <template v-else-if="info">
      <div class="dg-head-sub"><span v-if="info.tag.groupLabel">{{ info.tag.groupLabel }}</span><span v-if="info.tag.count">{{ info.tag.groupLabel ? ' · ' : '' }}共 {{ countLabel(info.tag.count) }} 部</span></div>
      <div v-if="info.buckets.length" class="browse-frow" role="group" aria-label="按分类"><span class="browse-flabel">分类</span><div class="browse-fopts"><button v-for="b in info.buckets" :key="'hb-' + b.id" type="button" class="browse-fopt" @click="$emit('go', { sel: { b: b.id, t: [info.tag.id] } })">{{ b.label }}<span class="dg-c">{{ b.count }}</span></button></div></div>
      <div v-if="info.related.length" class="browse-frow" role="group" aria-label="相关标签"><span class="browse-flabel">相关</span><div class="browse-fopts"><button v-for="r in info.related" :key="'hr-' + r.id" type="button" class="browse-fopt" @click="$emit('go', { view: 'tag', id: r.id })">#{{ r.label }}</button></div></div>
    </template>
  </template>
  <div v-else-if="info" class="dg-act-head">
    <div class="dg-act-name"><i class="fas fa-user" aria-hidden="true"></i> {{ info.name }}</div>
    <div v-if="info.aliases.length" class="dg-head-sub">又名 {{ info.aliases.join(' / ') }}</div>
    <div class="dg-head-sub"><span v-if="total">共 {{ countLabel(total) }} 部</span><span v-if="info.latest">{{ total ? ' · ' : '' }}最新 {{ info.latest }} 发行</span><button type="button" class="dg-act-idx" @click="$emit('go', { view: 'actresses' })">女优索引 <i class="fas fa-angle-right" aria-hidden="true"></i></button></div>
  </div>
</div>`,
    };

    // 标签云(#/tags?b=):当前分类的 featured 标签按分面组排,字号按 log(数量);审查类不进来
    const DgAdCloud = {
        name: 'DgAdCloud',
        props: { b: { type: String, default: '' } },
        emits: ['go', 'learn'],
        data() { return { data: null, err: false }; },
        watch: { b: { immediate: true, handler() { this.load(); } } },
        methods: {
            load(force) {
                const b = BUCKET_LABEL[this.b] ? this.b : '';
                const url = tagsUrl(b);
                if (force) dCache.delete(url);
                this.data = null; this.err = false;
                cachedJson(url, 8000).then(d => {
                    if ((BUCKET_LABEL[this.b] ? this.b : '') !== b) return;
                    if (!d) { this.err = true; return; }
                    this.data = Object.freeze(normCloud(d));
                    this.$emit('learn');
                });
            },
            pick(id) {
                const b = BUCKET_LABEL[this.b] ? this.b : '';
                this.$emit('go', b ? { sel: { b, t: [id] } } : { view: 'tag', id });
            },
        },
        template: `<div class="dg-cloud">
  <div class="dg-cloud-links"><button type="button" class="browse-fopt" @click="$emit('go', { view: 'actresses' })"><i class="fas fa-user" aria-hidden="true"></i> 女优索引</button></div>
  <div v-if="err" class="browse-state">标签加载失败 <button type="button" class="browse-btn" @click="load(true)"><i class="fas fa-rotate-right" aria-hidden="true"></i> 重试</button></div>
  <div v-else-if="!data" class="browse-state"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> 正在加载标签…</div>
  <div v-else-if="!data.groups.length" class="browse-empty"><i class="fas fa-tags" aria-hidden="true"></i><div class="browse-empty-t">这个分类还没有标签</div></div>
  <section v-for="g in (data ? data.groups : [])" :key="'cg-' + g.id" class="dg-cloud-g">
    <div class="dg-cloud-gt">{{ g.label }}</div>
    <div class="dg-cloud-ts"><button v-for="t in g.tags" :key="'ct-' + t.id" type="button" class="dg-cloud-t" :class="'w' + t.w" :title="t.label + ' · ' + t.count + ' 部'" @click="pick(t.id)">{{ t.label }}<span class="dg-c">{{ t.count }}</span></button></div>
  </section>
</div>`,
    };

    // [adult] p4 播放页的「相关推荐 / 同演员 / 同片商」(GET /api/catalog/related/:wk)。wk 由根组件在主播放器出了第一帧之后才给
    //   (不跟起播抢);每排横向滑动 ≤24 张;点卡片 @pick → openWork,点「全部」@go → 女优页 / 厂牌浏览
    const DgAdRails = {
        name: 'DgAdRails',
        props: { wk: { type: String, default: '' }, poster: { type: Function, default: null }, tv: { type: Boolean, default: false } },
        emits: ['pick', 'go'],
        data() { return { rails: null }; },
        watch: { wk: { immediate: true, handler() { this.load(); } } },
        methods: {
            src(p) { return this.poster ? this.poster(p) : (p || PLACEHOLDER); },
            loaded: onImgLoad,
            load() {
                const wk = this.wk;
                this.rails = null;
                if (!wk || !WK_RE.test(wk) || wk.length > 300) return;
                cachedJson('/api/catalog/related/' + encodeURIComponent(wk), 10000).then(d => {
                    if (wk !== this.wk) return;
                    this.rails = Object.freeze(normRelated(d, wk));
                });
            },
            pick(it) { this.$emit('pick', it); },
        },
        template: `<div v-if="rails && rails.length" class="dg-rails">
  <section v-for="r in rails" :key="r.k" class="dg-rail" :aria-label="r.title">
    <div class="dg-rail-t"><i :class="['fas', r.icon]" aria-hidden="true"></i><span>{{ r.title }}</span><button v-if="r.go" type="button" class="dg-rail-all" :tabindex="tv ? 2 : null" @click="$emit('go', r.go)">全部 <i class="fas fa-angle-right" aria-hidden="true"></i></button></div>
    <div class="dg-rail-row">
      <div v-for="it in r.items" :key="r.k + '-' + it.id" class="dg-rail-card" :data-wk="it._wk" :tabindex="tv ? 2 : null" @click="pick(it)" @keydown.enter.prevent="pick(it)">
        <div class="poster-wrap">
          <img :src="src(it.poster_path)" loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" @load="loaded">
          <div v-if="it._badge" class="dg-ad-badge">{{ it._badge }}</div><span v-if="it._durText" class="dg-ov-dur">{{ it._durText }}</span><span v-if="it._code" class="dg-ov-code">{{ it._code }}</span>
        </div>
        <div class="movie-name">{{ it.title }}</div>
        <div class="movie-date dg-ad-sub">{{ it._sub }}</div>
      </div>
    </div>
  </section>
</div>`,
    };

    // [adult] p4 女优索引(#/actresses):热门女优 = 全部 + 日本三个分类各自按作品数的前 20(浏览接口的 facets.actress,快照里现算、10 分钟缓存);
    //   上面一个搜索框走 /api/catalog/actress?q=(≤10 个);点名字 @go → 女优页
    const ACT_SECTIONS = [['', '热门女优'], ['jp_censored', '日本有码'], ['jp_uncensored', '日本无码'], ['jp_subbed', '中文字幕']];
    const actIndexUrls = () => ACT_SECTIONS.map(([b]) => browseApiUrl(b ? normSel(typeOfBucket(b), { b }) : normSel('all', {}), { page: 1, facets: true }));
    function actSections(ds) {
        const out = [];
        (Array.isArray(ds) ? ds : []).forEach((d, i) => {
            const f = d && d.facets ? normFacets(d.facets) : null;
            const list = f ? f.actress.slice(0, 20) : [];
            if (list.length && ACT_SECTIONS[i]) out.push({ k: ACT_SECTIONS[i][0] || 'all', label: ACT_SECTIONS[i][1], list });
        });
        return out;
    }
    const DgAdActresses = {
        name: 'DgAdActresses',
        emits: ['go', 'learn'],
        data() { return { q: '', res: null, secs: null, err: false }; },
        mounted() { this.load(); },
        beforeUnmount() { this._gone = true; clearTimeout(this._t); },
        methods: {
            countLabel,
            load(force) {
                const urls = actIndexUrls();
                if (force) urls.forEach(u => dCache.delete(u));
                this.err = false; this.secs = null;
                Promise.all(urls.map(u => cachedJson(u, 10000))).then(ds => {
                    if (this._gone) return;
                    if (ds.every(d => !d)) { this.err = true; return; }
                    this.secs = Object.freeze(actSections(ds));
                    this.$emit('learn');
                });
            },
            search() {
                clearTimeout(this._t);
                const q = this.q.trim();
                if (!q) { this.res = null; return; }
                if (q.length > 40) return;
                this._t = setTimeout(() => {
                    const seq = (this._seq = (this._seq || 0) + 1);
                    cachedJson('/api/catalog/actress?q=' + encodeURIComponent(q), 8000).then(d => {
                        if (seq === this._seq && this.q.trim() === q) this.res = normActressList(d);
                    });
                }, 250);
            },
            pick(a) { if (a && validAid(a.aid)) this.$emit('go', { sel: { actress: aidStr(a.aid) }, type: 'all' }); },
        },
        template: `<div class="dg-acts">
  <input class="dg-sq dg-acts-q" type="search" v-model="q" placeholder="搜索女优名字（也认别名）" aria-label="搜索女优" maxlength="40" @input="search()">
  <section v-if="q.trim()" class="dg-acts-sec">
    <div v-if="res && !res.length" class="dg-sec-n">没有找到</div>
    <div class="dg-chips"><button v-for="a in (res || [])" :key="'aq-' + a.aid" type="button" class="dg-chip" @click="pick(a)">{{ a.name }}<span v-if="a.n" class="dg-c">{{ a.n }}</span></button></div>
  </section>
  <template v-else>
    <div v-if="err" class="browse-state">加载失败 <button type="button" class="browse-btn" @click="load(true)"><i class="fas fa-rotate-right" aria-hidden="true"></i> 重试</button></div>
    <div v-else-if="!secs" class="browse-state"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> 正在加载…</div>
    <div v-else-if="!secs.length" class="browse-empty"><i class="fas fa-user" aria-hidden="true"></i><div class="browse-empty-t">还没有可浏览的女优</div></div>
    <section v-for="s in (secs || [])" :key="'as-' + s.k" class="dg-acts-sec">
      <div class="dg-cloud-gt">{{ s.label }}</div>
      <div class="dg-chips"><button v-for="a in s.list" :key="s.k + '-' + a.aid" type="button" class="dg-chip" :title="a.name + ' · ' + a.count + ' 部'" @click="pick(a)">{{ a.name }}<span class="dg-c">{{ countLabel(a.count) }}</span></button></div>
    </section>
  </template>
</div>`,
    };

    // ========== Vue mixin(index.html 的 createApp 里 mixins: [DgAdult.mixin]) ==========
    //   方法名都带 ad 前缀(openWork 除外),scripts/adult-frontend-test.mjs 校验不与主组件的 methods/computed/data 重名
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const tagCache = new Map();        // 浏览页标签行:分类 → { at, list }(10 分钟)
    const enriched = new WeakSet();    // 已经补拉过作品信息的 group(每个只拉一次)
    const mixin = {
        data() {
            return {
                adultMode: true,
                adult: {
                    catalog: false, intro: false, siteName: brand.name(), today: {}, home: 'idle',
                    blur: blurOn(),                       // 模糊封面
                    tags: { key: null, list: [] },        // 浏览页标签行(当前分类的 featured 标签)
                    famOpen: {},                          // 展开了「+N 备用」的线路家族
                    varPref: { wk: '', kind: '' },        // 这部作品选了「中字 / 原版」哪种
                    sug: { q: '', open: false, hi: -1, kind: '', alias: null, exact: null, items: [] },   // 搜索建议
                    // phase 3 浏览页:facets = 当前筛选的分面计数(冻结;第 1 页随结果下发);view = ''(浏览)/ 'tags'(标签云)/ 'tag'(标签页);
                    //   labv = 学到新名字(标签/厂牌/女优)时 +1,让标题重算;routeOn = 地址栏路由已接管(启动时先按地址栏开页,再开始写)
                    facets: null, view: '', labv: 0, routeOn: false,
                    // p4:relWk = 播放页「相关推荐」这部(首帧之后才有);pv / feedAuto = 设置里的「封面悬停预览」「刷短片自动播放(移动网络)」
                    relWk: '', pv: pvOn(), cell: cellOk(),
                },
            };
        },
        components: { DgAdGrid, DgAdFilter, DgAdHead, DgAdCloud, DgAdRails, DgAdActresses },
        computed: {
            // 播放页作品信息条(currentGroup._meta 的展示版;没有 _meta 不出)
            adMeta() {
                const g = this.currentGroup;
                return (this.adultMode && g && g._meta && typeof g._meta === 'object' && !g._isLive) ? metaView(g._meta, g) : null;
            },
            // 线路列表每条的显示信息(家族领头/成员、同源、risky)。电视/遥控器模式全部展开(「+N 备用」按钮遥控器够不着)
            adSrcView() {
                if (!this.adultMode) return new Map();
                return srcView(this.sourceGroups, {
                    cur: this.currentSource, open: this.adult.famOpen, native: nativeDev(), expandAll: !!this.isTVMode,
                    all: (this.currentGroup && this.currentGroup.sources) || [],
                });
            },
            // 这部作品既有中字线路又有原版线路 → 线路标题旁出「中字 / 原版」切换
            adVarBoth() {
                const ss = (this.adultMode && this.currentGroup && this.currentGroup.sources) || [];
                let z = false, r = false;
                ss.forEach(s => { if (varKind(s) === 'zh') z = true; else r = true; });
                return z && r;
            },
            adVarCur() {
                const g = this.currentGroup, p = this.adult && this.adult.varPref;
                if (p && p.kind && g && p.wk === (g._wk || '')) return p.kind;
                return this.currentSource ? varKind(this.currentSource) : '';
            },
            // 浏览页标签行:当前分类(或全部)的 featured 标签;从搜索词进来的非 featured 标签也挂上,能看见、能取消
            adTagKey() {
                const b = this.browse;
                if (!this.adultMode || !this.adult.catalog || !b || !b.open) return '';
                const T = typeOf(b.type);
                return 't|' + ((T && T.buckets.length && b.sel && b.sel.b) || '');
            },
            //   (phase 3:只在服务器没给 facets 时当标签行的后备;选中的标签由 chipRow 自己挂上)
            adTagOpts() {
                const b = this.browse;
                if (!this.adultMode || !b || !b.open) return [];
                const T = typeOf(b.type);
                const bucket = (T && T.buckets.length && b.sel && b.sel.b) || '';
                const t = this.adult.tags;
                return (t && t.key === bucket) ? t.list : [];
            },
            // 地址栏路由(只有 id):浏览页关着 = '';没有目录 / 还没接管 = null(不写地址栏)
            adRouteHash() {
                if (!this.adultMode || !this.adult.catalog || !this.adult.routeOn) return null;
                const b = this.browse;
                if (!b || !b.open) return '';
                return routeOf(this.adult.view, b.type, b.sel);
            },
            adBrowseTitle() {
                void this.adult.labv;
                const b = this.browse, s = (b && b.sel) || {};
                if (this.adult.view === 'tags') return '全部标签' + (s.b && BUCKET_LABEL[s.b] ? ' · ' + BUCKET_LABEL[s.b] : '');
                if (this.adult.view === 'actresses') return '女优';   // p4 女优索引
                if (this.adult.view === 'tag' && s.t && s.t.length) return '#' + tagLabel(s.t[0]);
                return catalog.title(b.type, s);
            },
            adBrowseSummary() {
                void this.adult.labv;
                if (noList(this.adult.view) || this.adult.view === 'tag') return this.adBrowseTitle;
                return catalog.summary(this.browse.type, this.browse.sel);
            },
            // 搜索建议下拉的各行:分类词 → 「按分类浏览」;作品卡片(≤8);最后一行「搜索全部站点」
            adSugRows() {
                const S = this.adult && this.adult.sug;
                if (!S || !S.open) return [];
                const rows = [];
                if (S.alias) rows.push({ t: 'alias', k: 'a', label: S.alias.label, alias: S.alias });
                (S.items || []).forEach(it => rows.push({ t: 'item', k: 'i:' + it.id, it }));
                rows.push({ t: 'all', k: 'all', q: S.q });
                return rows;
            },
            // ---- p4 ----
            // 浏览页当前是「没有片单」的形态(标签云 / 女优索引):不出筛选行、网格、底栏
            adNoList() { return !!(this.adultMode && this.adult && noList(this.adult.view)); },
            // 刷短片入口:有目录、不是电视、feed.js 加载了
            adFeedOn() { return !!(this.adultMode && this.adult && this.adult.catalog && !this.isTVMode && root.dgAdultFeed && typeof root.dgAdultFeed.open === 'function'); },
            // 搜索结果(全站扇出可到几百张)→ 窗口化网格的卡片:海报按主组件的 finalPoster / 回退规则,_g 是原来的分组(点了 openDetail)
            adSearchItems() {
                if (!this.adultMode) return [];
                const out = [];
                for (const g of (this.groupedList || [])) {
                    if (!g || !g.name) continue;
                    let key = '', pic = '';
                    try { key = this.posterKey(g); pic = this.isFallback(key) ? '' : (this.finalPoster(g) || ''); } catch (e) { }
                    out.push(Object.freeze({
                        id: g.name + '|' + (g._work || ''), _wk: typeof g._wk === 'string' ? g._wk : '', title: g.name, name: g.name, poster_path: pic,
                        _n: (g.sources || []).length, _sub: g._workLabel || '', _badge: '', _code: '', _durText: '', _pk: key, _g: g,
                    }));
                }
                return out;
            },
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
                if (!v && this.adult && this.adult.relWk) this.adult.relWk = '';   // [adult] p4:相关推荐跟着播放页走
                if (!v && typeof this._adRelOff === 'function') this._adRelOff();
                if (!v && this.adultMode) this._adAfterDetail();                 // [adult] p4:从刷短片进来的回到刷短片;猜你喜欢按新历史重算
                if (v || this._adReturnY == null) return;
                const y = this._adReturnY;
                this._adReturnY = null;
                this.$nextTick(() => { try { this._jumpTo(y); } catch (e) { } });
            },
            // 换了一部:收起展开的备用线路、清掉「中字 / 原版」选择;从搜索结果/历史打开的(没有 _meta)补拉作品信息和线路标记
            currentGroup(g, old) {
                if (!this.adultMode) return;
                if (g !== old) {
                    if (this.adult.relWk && (!g || g._wk !== this.adult.relWk)) this.adult.relWk = '';   // [adult] p4:换了一部,相关推荐等新的首帧
                    if (Object.keys(this.adult.famOpen || {}).length) this.adult.famOpen = {};
                    if (this.adult.varPref && this.adult.varPref.kind && (!g || this.adult.varPref.wk !== (g._wk || ''))) this.adult.varPref = { wk: '', kind: '' };
                }
                this._adEnrich(g);
            },
            // 浏览页的类型/筛选/开关一变 → 写地址栏(新的一条历史;从地址栏来的 / 面板开着时替换当前这条)
            adRouteHash(h) { this._adRouteSync(h); },
            // [adult] p4:历史整份换了(云同步合并 / 清空)→ 猜你喜欢按新历史重算(签名没变就什么都不做)
            watchHistory() { if (this.adultMode && this.adult && this.adult.home === 'ok') this._adForYouSoon(1500); },
            // [adult] p4:偏好设置打开 → onSettingsRender(空容器,订阅者自己往里放设置行)
            showSettingsModal(v) {
                if (!v || !this.adultMode) return;
                this.$nextTick(() => { const el = this.$refs && this.$refs.adSetExt; if (el) hooks.call('onSettingsRender', [el]); });
            },
        },
        mounted() {
            if (!this.adultMode) return;
            bridge.app = this;   // [adult] p4:preview.js / feed.js 经 DgAdult 的桥用(去广告地址、开作品、主播放器忙不忙)
            this._adHashFn = () => this._adOnHash();
            this._adPopFn = () => this._adOnPop();
            try { root.addEventListener('hashchange', this._adHashFn); root.addEventListener('popstate', this._adPopFn); } catch (e) { }
        },
        methods: {
            adultApplyConfig(config) {
                const c = config || {};
                this.adult.catalog = c.catalog === true;
                this.adult.intro = c.intro_enabled === true;   // 站长显式开了片头学习(INTRO_DISABLE=0)才显示那两行设置
                this.adult.siteName = brand.apply(c.site_name);
                brand.applyBuy(c.purchase_url);
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
                    this._adFySig = '';             // [adult] p4:首页行整个换了,猜你喜欢重新插
                    this._adForYouSoon(1500);
                };
                // [adult] p4:无痕开关一变 → 猜你喜欢重算(开了无痕整行收起)
                if (!this._adPrivHooked) {
                    this._adPrivHooked = true;
                    try { const P = root.dgPrivacy; if (P && typeof P.onChange === 'function') P.onChange(() => { this._adFySig = ''; this._adForYouSoon(0); }); } catch (e) { }
                }
                if (d === 'slow') {   // 先放行进应用,同一个请求回来后再填首页
                    p.then(h => { if (h) apply(h); else this.adult.home = 'error'; });
                    this._adRouteBoot();
                    return;
                }
                if (d) apply(d); else this.adult.home = 'error';
                this._adRouteBoot();   // 地址栏带着浏览页路由(刷新 / 书签)→ 直接开那一页
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
            // 搜索框回车(返回 true = 已处理,调用方不再全站扇出;false = 照常搜索):
            //   ① 下拉里用方向键选中了一行 → 就开那一行;
            //   ② 本地搜索建议(/api/catalog/suggest,零上游):番号查询给了 exact(恰好一部正片;#clip/#U 不算)→ 直接开作品页;
            //      分类/标签词(alias)→ 开浏览页(带「按片名搜索」);文字 / 没命中 / 被拦 → false;
            //   ③ suggest 不可用(旧服务器 / 1.5s 没回)→ 退回 /api/catalog/lookup:番号恰好命中一部作品才开
            async adLookupOpen(kw) {
                const q = String(kw == null ? '' : kw).trim();
                const S = this.adult && this.adult.sug;
                if (S && S.open && S.hi >= 0 && S.q === q) {
                    const row = this.adSugRows[S.hi];
                    if (row) { this.adSugPick(row); return true; }
                }
                this.adSugClose();
                if (!this.adult.catalog || !q || q.length > 100) return false;
                const c = this._adSugLast;
                const d = (c && c.q === q && c.r && Date.now() - c.at < 30000) ? c.r : normSuggest(await fetchJson(suggestUrl(q), 1500));
                if (d) {
                    if (d.kind === 'code' && d.exact) {
                        const card = d.items.find(it => it._wk === d.exact) || { _wk: d.exact, title: '', poster_path: '' };
                        this.openWork(card);
                        return true;
                    }
                    if (d.kind === 'alias' && this._adOpenAlias(d.alias, q)) return true;
                    return false;
                }
                const L = await fetchJson('/api/catalog/lookup?q=' + encodeURIComponent(q) + '&limit=2', 1500);
                const r = L && L.kind === 'code' && Array.isArray(L.results) && L.results.length === 1 ? L.results[0] : null;
                if (!r || typeof r.wk !== 'string' || r.wk.indexOf('c:') !== 0) return false;
                this.openWork(cardToItem(r));
                return true;
            },
            // ---------- 搜索建议(输入停顿 200ms → /api/catalog/suggest;输入停顿不再全站扇出,回车/放大镜才搜) ----------
            // debouncedSearch 最前面调:返回 true = 这次输入由建议接管(关键词非空且目录可用);false = 照旧(清空关键词等)
            adSuggestInput(kw) {
                clearTimeout(this._adSugT);
                const q = String(kw == null ? '' : kw).trim();
                if (!this.adult || !this.adult.catalog || !q) { this.adSugClose(); return false; }
                if (q.length > 100) { this.adSugClose(); return true; }
                this._adSugT = setTimeout(() => { this._adSuggest(q); }, 200);
                return true;
            },
            async _adSuggest(q) {
                const seq = (this._adSugSeq = (this._adSugSeq || 0) + 1);
                const r = normSuggest(await fetchJson(suggestUrl(q), 4000));
                if (seq !== this._adSugSeq || String(this.keyword == null ? '' : this.keyword).trim() !== q) return;
                this._adSugLast = { q, r, at: Date.now() };
                const S = this.adult.sug;
                S.q = q; S.hi = -1;
                // 被拦的查询 / 没有任何东西:不出下拉,也不说为什么
                if (!r || r.kind === 'blocked' || (!r.items.length && !r.alias)) { S.open = false; S.items = []; S.alias = null; S.exact = null; S.kind = r ? r.kind : ''; return; }
                S.kind = r.kind; S.alias = r.alias; S.exact = r.exact; S.items = r.items;
                S.open = this._adSugFocused();
            },
            _adSugFocused() {
                try { const ae = root.document.activeElement; return !!(ae && ae.classList && ae.classList.contains('search-input')); } catch (e) { return false; }
            },
            adSugClose() {
                clearTimeout(this._adSugT);
                this._adSugSeq = (this._adSugSeq || 0) + 1;
                const S = this.adult && this.adult.sug;
                if (S && (S.open || S.hi !== -1)) { S.open = false; S.hi = -1; }
            },
            // 搜索框重新获得焦点:关键词没变、上次有结果 → 再打开下拉
            adSugFocus() {
                const S = this.adult && this.adult.sug, c = this._adSugLast;
                const q = String(this.keyword == null ? '' : this.keyword).trim();
                if (S && q && c && c.q === q && c.r && c.r.kind !== 'blocked' && (c.r.items.length || c.r.alias) && !this.searched) { S.open = true; S.hi = -1; }
            },
            // 焦点离开搜索区(输入框 + 下拉)才收起;下拉的行 @mousedown.prevent,点它不会先失焦
            adSugBlur(e) {
                const to = e && e.relatedTarget, box = e && e.currentTarget;
                if (to && box && box.contains && box.contains(to)) return;
                this.adSugClose();
            },
            // 方向键选行、Esc 收起(电视遥控器的方向键留给焦点导航;回车由 @keyup.enter → submitSearch → adLookupOpen 处理)
            adSugKey(e) {
                const S = this.adult && this.adult.sug;
                if (!S || !S.open || !e || e.isComposing || this.isTVMode) return;
                const n = this.adSugRows.length;
                if (!n) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); S.hi = S.hi >= n - 1 ? 0 : S.hi + 1; }
                else if (e.key === 'ArrowUp') { e.preventDefault(); S.hi = S.hi <= 0 ? n - 1 : S.hi - 1; }
                else if (e.key === 'Escape') { e.preventDefault(); this.adSugClose(); }
            },
            adSugPick(row) {
                if (!row) return;
                const q = (this.adult.sug && this.adult.sug.q) || String(this.keyword || '').trim();
                this.adSugClose();
                try { const ae = root.document.activeElement; if (ae && ae.blur && /^input$/i.test(ae.tagName || '')) ae.blur(); } catch (e) { }
                if (row.t === 'item' && row.it) { this.openWork(row.it); return; }
                if (row.t === 'alias') { this._adOpenAlias(row.alias, q); return; }
                // 搜索全部站点:与回车一样走全站搜索(不再查本地)
                clearTimeout(this.searchTimer);
                if (!this.keyword) this.keyword = q;
                this._browsePickId = null;
                this.doSearch();
            },
            // 分类 / 标签词 → 浏览页(带「按片名搜索」);只有标签没有分类的 → 标签页(跨分类,带按分类细分)
            _adOpenAlias(alias, kw) {
                const p = aliasPreset(alias);
                if (!p || typeof this.openBrowse !== 'function') return false;
                if (alias && alias.tag && alias.label) learnTag(alias.tag, alias.label);
                const tagOnly = !p.sel.b && p.sel.t && p.sel.t.length === 1 && featurable(p.sel.t[0]);
                this._adOpen(tagOnly ? 'tag' : '', p.type, p.sel, { keyword: String(kw || '') });
                return true;
            },
            // ---------- phase 3:分面浏览(_browseFetch 在成人站整个交给它)----------
            //   游标翻页:服务器回了 cursor_next(字符串 / null)就按游标接着拉,到 null 为止;没有这个键 → 按页(旧服务器 / 退路)。
            //   第 1 页带 facets=1(标签行 / 筛选面板的计数、可用排序);标签云页不拉片单
            async _adBrowseFetch(reset) {
                const b = this.browse;
                if (reset) {
                    this._browseAbort();
                    b.seq++;
                    b.items = []; b.page = 0; b.totalPages = 0; b.total = 0;
                    b.done = false; b.error = false; b.idle = 0; b.loading = false;
                    this._browseSeen = new Set();
                    this._browsePickId = null;
                    this._adCursor = '';
                    this._adPaged = false;
                    // 标签页(#/tag/<id>)只认「全部 + 只选这一个标签 + 默认排序」;动了别的就是普通浏览
                    if (this.adult.view === 'tag' && !(b.type === 'all' && /^#\/tag\//.test(routeOf('tag', b.type, b.sel)))) this.adult.view = '';
                    // p4:女优索引页上点了别的大类 → 那个大类的普通浏览页(索引本身不分大类)
                    if (this.adult.view === 'actresses' && b.type !== 'all') this.adult.view = '';
                }
                if (b.loading) return;
                if (noList(this.adult.view)) { b.done = true; return; }   // 标签云 / 女优索引不拉片单
                const seq = b.seq, page = b.page + 1;
                const first = page === 1;
                const cursor = first || this._adPaged ? '' : this._adCursor;
                if (!first && !this._adPaged && !cursor) { b.done = true; return; }
                const url = browseApiUrl(b.sel, { page, cursor, facets: first });
                const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
                this._browseCtl = ctl;
                const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { } }, 15000) : 0;
                b.loading = true;
                try {
                    const r = await root.fetch(url, ctl ? { signal: ctl.signal, credentials: 'same-origin' } : { credentials: 'same-origin' });
                    if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
                    const d = await r.json();
                    if (seq !== b.seq) return;
                    const seen = this._browseSeen || (this._browseSeen = new Set());
                    const fresh = (d && Array.isArray(d.results) ? d.results : []).map(cardToItem).filter(it => {
                        if (!it || seen.has(it.id)) return false;
                        seen.add(it.id);
                        return true;
                    }).map(it => Object.freeze(it));   // 只读展示:不做深层响应式
                    if (fresh.length) b.items.push(...fresh);
                    b.page = page;
                    b.totalPages = Math.min(Number(d && d.total_pages) || 0, 500);
                    b.total = Math.max(0, Number(d && d.total_results) || 0);
                    const hasCur = !!d && Object.prototype.hasOwnProperty.call(d, 'cursor_next');
                    if (first) this._adPaged = !hasCur;
                    if (this._adPaged) b.done = page >= b.totalPages || (!fresh.length && !(d && d.results && d.results.length));
                    else { this._adCursor = (typeof d.cursor_next === 'string' && d.cursor_next.length <= 400) ? d.cursor_next : ''; b.done = !this._adCursor; }
                    b.idle = fresh.length >= 4 ? 0 : b.idle + 1;
                    if (first) {
                        const f = d && d.facets ? normFacets(d.facets) : null;
                        this.adult.facets = f ? Object.freeze(f) : null;
                        if (!f) this._adLoadTags();   // 旧服务器没有 facets:标签行退回 /api/catalog/tags
                        this.adult.labv++;
                    }
                } catch (e) {
                    if (seq === b.seq) b.error = true;
                } finally {
                    if (timer) clearTimeout(timer);
                    if (this._browseCtl === ctl) this._browseCtl = null;
                    if (seq === b.seq) b.loading = false;
                }
                if (seq === b.seq && !b.error && !b.done) this.$nextTick(() => this._browseFill());
            },
            // 组件(标签行 / 筛选面板 / 标签云 / 标签页页头)和信息条的导航都走这里:
            //   { patch }(改当前筛选的几项)/ { sel, type? }(整个换)/ { view:'tags', b }(标签云)/ { view:'tag', id }(标签页)
            adGo(nav) {
                const n = nav || {};
                const b = this.browse;
                const cur = (b && b.open) ? b.sel : {};
                let view = '', type = 'all', sel = {};
                if (n.view === 'tags') {
                    const bk = BUCKET_LABEL[n.b] ? n.b : '';
                    view = 'tags'; type = bk ? typeOfBucket(bk) : 'all'; sel = { b: bk };
                } else if (n.view === 'actresses') {
                    view = 'actresses'; type = 'all'; sel = {};   // p4 女优索引
                } else if (n.view === 'tag') {
                    if (!validTag(n.id) || isBlockedTag(n.id)) return;
                    view = 'tag'; sel = { t: [n.id] };
                } else if (n.patch && typeof n.patch === 'object') {
                    sel = Object.assign({}, cur, n.patch);
                    if (Object.prototype.hasOwnProperty.call(n.patch, 'b')) type = BUCKET_LABEL[n.patch.b] ? typeOfBucket(n.patch.b) : 'all';
                    else type = (b && b.open && typeOf(b.type)) ? b.type : (sel.b && BUCKET_LABEL[sel.b] ? typeOfBucket(sel.b) : 'all');
                } else if (n.sel && typeof n.sel === 'object') {
                    sel = n.sel;
                    type = typeOf(n.type) ? n.type : (BUCKET_LABEL[sel.b] ? typeOfBucket(sel.b) : 'all');
                } else return;
                this._adOpen(view, type, sel, { keyword: n.keyword });
            },
            // 打开 / 换到某一页:浏览页没开(或在搜索结果 / 播放页上)→ openBrowse;开着 → 就地换筛选重拉(不动焦点,滚回顶部)
            _adOpen(view, type, sel, opt) {
                const o = opt || {};
                const T = typeOf(type) || typeOf('all');
                const ns = normSel(T.k, sel);
                const run = () => {
                    const b = this.browse;
                    if (!b.open || this.searched || o.keyword) {   // 从搜索词来的:openBrowse 才带「按片名搜索」提示
                        this.adult.view = view;
                        if (typeof this.openBrowse === 'function') this.openBrowse({ type: T.k, sel: ns }, o.keyword ? { keyword: String(o.keyword) } : undefined);
                        return;
                    }
                    const same = b.type === T.k && JSON.stringify(b.sel) === JSON.stringify(ns);
                    const prev = this.adult.view;
                    this.adult.view = view;
                    // 筛选没变:同一种页面什么都不做;只换了页面形态(#/c/all?t=x ↔ #/tag/x)片单不变,不重拉;进出标签云要重拉 / 清空片单
                    if (same && (prev === view || (!noList(prev) && !noList(view)))) return;
                    if (typeof this._browseDropKeyword === 'function') this._browseDropKeyword();
                    b.type = T.k;
                    b.sel = ns;
                    if (typeof this.catNavSelect === 'function') this.catNavSelect(T.k);
                    if ((root.scrollY || 0) > 0 && typeof this._jumpTo === 'function') this._jumpTo(0);
                    this._browseFetch(true);
                };
                if (this.showDetail) this._adLeaveDetail(run); else run();
            },
            // 学到新名字(标签云 / 标签页 / 女优页回来)→ 标题重算
            adLearned() { this.adult.labv++; },
            // 首页分类栏「标签」→ 标签云(当前大类的第一个分类;「全部」不限分类)
            adOpenTags(tk) {
                const T = typeOf(tk);
                const b0 = T && T.buckets.length ? T.buckets[0][0] : '';
                const cur = this.browse && this.browse.open && this.browse.sel ? this.browse.sel.b : '';
                this.adGo({ view: 'tags', b: (this.browse && this.browse.open) ? (cur || '') : b0 });
            },
            // 顶上摘要条的「筛选」:直接打开筛选面板(返回 true = 已处理;没有面板时调用方照旧滚回顶部)
            adOpenSheet() {
                const f = this.$refs && this.$refs.adFilter;
                if (!f || typeof f.openSheet !== 'function' || noList(this.adult.view)) return false;
                return f.openSheet() === true;
            },
            // ---------- 地址栏路由 ----------
            // 状态 → 地址栏。面板开着(它压了一条同地址的历史)时替换那一条(保留标记);从地址栏应用的(规范化)也替换;其余新压一条
            _adRouteSync(h) {
                if (h == null) return;
                if (h === '' && this.adult.view) this.adult.view = '';   // 浏览页关了:下次从首页进来是普通浏览
                let cur = '';
                try { cur = canonHash(root.location.hash); } catch (e) { return; }
                if (h === cur) return;
                const loc = root.location;
                if (!h && loc.hash && !isOurHash(loc.hash)) return;   // 别人的 #(#admin 之类)不动
                const url = h || (loc.pathname + loc.search);
                const sheet = this._adSheetHist;
                try {
                    if (sheet) root.history.replaceState(Object.assign({}, root.history.state || {}, { dgAdSheet: sheet }), '', url);
                    else if (this._adRouteReplace || incognito()) root.history.replaceState({ dgAd: 1 }, '', url);   // 复核 r3:无痕不往浏览器历史里压浏览路由
                    else root.history.pushState({ dgAd: 1 }, '', url);
                } catch (e) { }
            },
            // 地址栏 → 状态(后退 / 前进 / 手改地址栏)。播放页开着时后退 = 关播放页(浏览页留在原样,把刚退掉的那条压回去)
            _adOnHash() {
                if (!this.adultMode || !this.adult.catalog || !this.adult.routeOn) return;
                if (this._adFeedHash()) return;   // [adult] p4:#/feed 进出归刷短片管
                const want = canonHash(root.location.hash);
                const have = this.adRouteHash;
                if (have == null || want === have) return;
                if (!want && root.location.hash && !isOurHash(root.location.hash)) return;   // 别人的 #
                if (this.showDetail) {
                    if (typeof this.closeDetail === 'function') this.closeDetail();
                    try { root.history[incognito() ? 'replaceState' : 'pushState']({ dgAd: 1 }, '', have || (root.location.pathname + root.location.search)); } catch (e) { }
                    return;
                }
                this._adApplyRoute(parseRoute(root.location.hash));
            },
            _adApplyRoute(r) {
                this._adRouteReplace = true;
                this.$nextTick(() => { this.$nextTick(() => { this._adRouteReplace = false; }); });
                if (!r) {
                    if (this.browse && this.browse.open) {
                        if (this.searched && typeof this._leaveSearch === 'function') this._leaveSearch();
                        if (typeof this.closeBrowse === 'function') this.closeBrowse();
                    }
                    return;
                }
                if (this.searched && typeof this._leaveSearch === 'function') this._leaveSearch();
                this._adOpen(r.view, r.type, r.sel, {});
            },
            // 启动(首页拿到之后)一次:地址栏带着路由就直接开那一页;之后才开始写地址栏
            _adRouteBoot() {
                if (!this.adultMode || !this.adult.catalog || this.adult.routeOn) return;
                const h = (root.location && root.location.hash) || '';
                const r = parseRoute(h);
                this.adult.routeOn = true;
                if (isFeedHash(h)) { this._adFeedPushed = false; this._adFeedHash(); return; }   // [adult] p4:书签 / 刷新时停在刷短片
                if (r) this._adApplyRoute(r);
                else if (isOurHash(h)) { try { root.history.replaceState(root.history.state, '', root.location.pathname + root.location.search); } catch (e) { } }   // 坏掉的旧路由:清掉
            },
            // 筛选面板开 / 关(组件 @sheet)。开:压一条同地址的历史(手机返回键先关面板);关:退掉那条,popstate 里把最终筛选压成新的一条
            adSheet(open) {
                if (open) {
                    if (this._adSheetHist) return;
                    const id = (this._adSheetSeq = (this._adSheetSeq || 0) + 1);
                    try { root.history.pushState(Object.assign({}, root.history.state || {}, { dgAdSheet: id }), ''); this._adSheetHist = id; } catch (e) { this._adSheetHist = 0; }
                    return;
                }
                const id = this._adSheetHist;
                if (!id) return;
                let mine = false;
                try { mine = !!(root.history.state && root.history.state.dgAdSheet === id); } catch (e) { }
                if (mine) { this._adSheetBack = true; try { root.history.back(); } catch (e) { this._adSheetBack = false; this._adSheetHist = 0; } }
                else this._adSheetHist = 0;
            },
            // popstate:离开了面板那条历史(点关闭自己退的 / 手机返回键)→ 面板关上;退回的是开面板前那条,筛选可能已经改过 → 当前状态压成新的一条
            _adOnPop() {
                const id = this._adSheetHist;
                if (!id) return;
                try { if (root.history.state && root.history.state.dgAdSheet === id) return; } catch (e) { }
                const viaUi = this._adSheetBack;
                this._adSheetBack = false;
                this._adSheetHist = 0;
                if (!viaUi) { const f = this.$refs && this.$refs.adFilter; if (f && typeof f.closeSheet === 'function') f.closeSheet(true); }
                const h = this.adRouteHash;
                if (h == null) return;
                let cur = '';
                try { cur = canonHash(root.location.hash); } catch (e) { return; }
                if (h !== cur) { try { root.history[incognito() ? 'replaceState' : 'pushState']({ dgAd: 1 }, '', h || (root.location.pathname + root.location.search)); } catch (e) { } }
            },
            // 信息条:标签 → 标签页(跨分类,带按分类细分);厂牌 → 按厂牌浏览;女优(有 aid)→ 女优页,没有 aid 的旧名字 → 全站搜
            adMetaTag(id) { if (featurable(id)) this.adGo({ view: 'tag', id }); },
            adMetaStudio(st) {
                const id = cleanStudio(st && typeof st === 'object' ? st.id : st);
                if (id) this.adGo({ sel: { studio: id }, type: 'all' });
            },
            adMetaActress(a) {
                if (a && validAid(a.aid)) { this.adGo({ sel: { actress: aidStr(a.aid) }, type: 'all' }); return; }
                this.adMetaSearch(a && typeof a === 'object' ? a.name : a);
            },
            // ---------- 浏览页标签行 ----------
            _adLoadTags() {
                const b = this.browse;
                if (!b || !b.open) return;
                const T = typeOf(b.type);
                const key = (T && T.buckets.length && b.sel && b.sel.b) || '';
                const hit = tagCache.get(key);
                if (hit && Date.now() - hit.at < 600000) { this.adult.tags = { key, list: hit.list }; return; }
                const seq = (this._adTagSeq = (this._adTagSeq || 0) + 1);
                fetchJson(tagsUrl(key), 8000).then(d => {
                    const list = d ? Object.freeze(normTags(d)) : null;
                    if (list) tagCache.set(key, { at: Date.now(), list });
                    if (seq === this._adTagSeq) this.adult.tags = { key, list: list || [] };
                });
            },
            // ---------- 播放页作品信息条 ----------
            adCopyCode() {
                const m = this.adMeta, code = m && m.code;
                if (!code) return;
                const done = (ok) => { if (this.showMiniToast) this.showMiniToast(ok ? '已复制番号 ' + code : '复制失败,请手动选择'); };
                const legacy = () => {
                    try {
                        const d = root.document, ta = d.createElement('textarea');
                        ta.value = code; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
                        d.body.appendChild(ta); ta.select();
                        const ok = d.execCommand('copy');
                        d.body.removeChild(ta);
                        done(ok);
                    } catch (e) { done(false); }
                };
                try {
                    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(code).then(() => done(true), legacy);
                    else legacy();
                } catch (e) { legacy(); }
            },
            // 分类 / 标签按钮 → 关掉播放页,打开分类浏览页(标签按这部作品的分类筛)
            //   (phase 3:只给标签 → 标签页;给了分类 + 标签 → 这个分类里按标签筛)
            adMetaGo(sel) {
                const s = sel || {};
                const b = (typeof s.b === 'string' && BUCKET_LABEL[s.b]) ? s.b : '';
                const tag = featurable(s.tag) ? s.tag : '';
                if (!b && !tag) return;
                if (tag && !b) { this.adGo({ view: 'tag', id: tag }); return; }
                this.adGo({ sel: tag ? { b, t: [tag] } : { b } });
            },
            // 厂牌前缀 → 关掉播放页,打开「全部」浏览页按厂牌筛(本地目录,零上游;不再全站扇出)
            adMetaPrefix(lp) {
                const k = typeof lp === 'string' ? lp.trim().toUpperCase() : '';
                if (!/^[A-Z0-9]{2,10}$/.test(k) || typeof this.openBrowse !== 'function') return;
                this._adLeaveDetail(() => this.openBrowse({ type: 'all', sel: { lp: k } }));
            },
            // 演员 → 关掉播放页按这个词全站搜
            adMetaSearch(kw) {
                const k = cleanText(kw, 60);
                if (!k) return;
                this._adLeaveDetail(() => {
                    if (this.browse && this.browse.open && typeof this.closeBrowse === 'function') this.closeBrowse(true);
                    this.keyword = k;
                    this._browsePickId = null;
                    this.doSearch();
                });
            },
            adOpenSibling(s) {
                if (!s || typeof s.wk !== 'string' || !WK_RE.test(s.wk)) return;
                this.openWork({ _wk: s.wk, title: s.name || '', poster_path: '' });
            },
            _adLeaveDetail(then) {
                const y = this._adReturnY;
                this._adReturnY = null;
                if (this.showDetail && typeof this.closeDetail === 'function') this.closeDetail();
                this.$nextTick(() => {
                    if (y != null && !this.searched && !(this.browse && this.browse.open)) { try { this._jumpTo(y); } catch (e) { } }
                    then();
                });
            },
            // ---------- 线路列表 ----------
            // sourceGroups 每组排好后再过一遍(见 orderSources):失效垫底、原生 HLS 设备上 risky 往后、选中的中字/原版在前、同家镜像挨着
            _adSrcOrder(items) {
                const g = this.currentGroup, p = this.adult && this.adult.varPref;
                const pref = (p && p.kind && g && p.wk === (g._wk || '')) ? p.kind : '';
                return orderSources(items, { native: nativeDev(), pref });
            },
            adSrcV(s) { return (this.adSrcView && this.adSrcView.get(s)) || NOV; },
            adFamToggle(s) {
                const f = famOf(s);
                if (!f) return;
                const o = Object.assign({}, this.adult.famOpen);
                if (o[f]) delete o[f]; else o[f] = true;
                this.adult.famOpen = o;
            },
            // 「中字 / 原版」:记下这部作品的选择(组内排序、自动换源跟着它),当前线路不是这种就换到这种里排最前的一条
            adVarPick(kind) {
                if (kind !== 'zh' && kind !== 'raw') return;
                const g = this.currentGroup;
                if (!g) return;
                this.adult.varPref = { wk: g._wk || '', kind };
                const cur = this.currentSource;
                if (cur && varKind(cur) === kind) return;
                const next = (this.availableSources || []).find(s => varKind(s) === kind && s._dead !== true) || (this.availableSources || []).find(s => varKind(s) === kind);
                if (next && typeof this.pickSourceManual === 'function') this.pickSourceManual(next);
                else if (this.showMiniToast) this.showMiniToast(kind === 'zh' ? '暂时没有可用的中字线路' : '暂时没有可用的原版线路');
            },
            // refreshSources 重建线路对象时补回成人字段
            _adSrcExtra(item) { return srcExtra(item); },
            // 从搜索结果 / 历史打开的作品(有 _wk、没有 _meta):补拉一次作品(不扩线,60s 缓存),挂上信息条和线路标记
            async _adEnrich(g) {
                if (!g || typeof g._wk !== 'string' || !WK_RE.test(g._wk) || g._meta || g._isLive || g._offlineCtx) return;
                if (!this.adult.catalog || !Array.isArray(g.sources) || !g.sources.length || enriched.has(g)) return;
                enriched.add(g);
                const d = await fetchWorkRaw(g._wk);   // [adult] p4:预取过的直接用
                if (!d || this.currentGroup !== g) return;
                if (d._meta && typeof d._meta === 'object' && !g._meta) { g._meta = d._meta; this._adRememberTags(g); }
                const by = new Map();
                (Array.isArray(d.sources) ? d.sources : []).forEach(s => { if (s && s.site_key && s.vod_id != null) by.set(s.site_key + '|' + s.vod_id, srcExtra(s)); });
                (g.sources || []).forEach(s => {
                    const x = s && by.get(s.site_key + '|' + s.vod_id);
                    if (!x) return;
                    Object.keys(x).forEach(k => { if (k === '_realRes' && s._realRes) return; if (s[k] !== x[k]) s[k] = x[k]; });
                });
            },
            // ---------- 线路反馈 ----------
            // 自动换源确认这条线路放不了(handlePlaybackError 换下一条 / 全部试完的那一刻)调。只有 hls.js 设备报失败:
            //   原生 HLS(iOS)放不了常是设备问题,不能拿来给所有人判「失效」;断网、离线缓存、直播不报
            _adBeaconFail(s, v) {
                const g = this.currentGroup;
                if (!this.adultMode || !g || typeof g._wk !== 'string' || !s || !s.site_key || g._isLive || g._offlineCtx || this._activeOffCached) return;
                try { if (root.navigator && root.navigator.onLine === false) return; } catch (e) { }
                if (nativeDev()) return;
                const code = v && v.error && v.error.code;
                beacon.send({ wk: g._wk, site_key: s.site_key, vod_id: s.vod_id, ok: false, err: 'hls:' + (code ? 'media' + code : 'nostart') });
            },
            // 播放器 timeupdate 里调(index.html):这条线路真的连续播了一段 → 报一次起播(单集作品带实测时长,另带画面宽高)。
            //   等 30 秒(短片按时长的一半,至少 3 秒)再报:片头常有 20 多秒别的分辨率的贴片广告(实测 1920x1080 贴片 → 1280x720 正片),
            //   宽高只在画面尺寸稳定 ≥3 秒时才带;本机已从主清单 / 播放补测量到的分辨率优先(更准)
            _adBeaconTick(v) {
                const g = this.currentGroup, s = this.currentSource;
                if (!v || !g || typeof g._wk !== 'string' || !g._wk || !s || g._isLive || g._offlineCtx) return;
                const t = Number(v.currentTime) || 0;
                let st = this._adBc;
                if (!st || st.tok !== this._playToken || st.s !== s) { this._adBc = { tok: this._playToken, s, last: t, acc: 0, done: false, dims: '', dimsAt: 0 }; return; }
                if (st.done) return;
                const d = t - st.last;
                st.last = t;
                if (v.paused || v.error || !(d > 0 && d < 4)) return;   // 暂停/拖动/切后台回来的大跳不算
                st.acc += d;
                const dims = v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth + 'x' + v.videoHeight : '';
                if (dims !== st.dims) { st.dims = dims; st.dimsAt = st.acc; }
                const total = (Number.isFinite(v.duration) && v.duration > 0) ? v.duration : 0;
                const need = total ? Math.max(3, Math.min(30, total / 2)) : 30;
                if (st.acc < need || !dims) return;
                st.done = true;
                if (s._dead === true) s._dead = false;   // 本机放得了:不再按失效置灰(服务器收到起播也会清掉)
                if (this._activeOffCached) return;
                const one = (this.episodeList || []).length <= 1;
                const o = { wk: g._wk, site_key: s.site_key, vod_id: s.vod_id, ok: true, dur: (one && total) ? Math.round(total) : 0 };
                let real = null;
                try { real = typeof this._srcRealRes === 'function' ? this._srcRealRes(s) : null; } catch (e) { }
                if (real && real.w && real.h && real.from !== 'beacon') { o.w = real.w; o.h = real.h; }
                else if (st.acc - st.dimsAt >= 3) { o.w = v.videoWidth; o.h = v.videoHeight; }
                beacon.send(o);
            },
            // ---------- 模糊封面 ----------
            adSetBlur(on) {
                const v = !!on;
                this.adult.blur = v;
                lsSet(BLUR_KEY, v ? '1' : '0');
                applyBlur(v);
            },
            // [adult] p4 封面悬停预览总开关 / 移动网络也自动播放(preview.js、feed.js 读同样的键)
            adSetPv(on) {
                const v = !!on;
                this.adult.pv = v;
                lsSet(PV_KEY, v ? '1' : '0');
                try { if (!v && root.dgAdultPreview && typeof root.dgAdultPreview.stop === 'function') root.dgAdultPreview.stop('off'); } catch (e) { }
            },
            adSetCell(on) {
                const v = !!on;
                this.adult.cell = v;
                lsSet(CELL_KEY, v ? '1' : '0');
            },
            // ---------- [adult] p4 钩子(index.html 在固定的地方调这几个) ----------
            // play() 把线路交给播放器之后(新建 / 换源 / 换集):onPlayerReady(dp, video, ctx);顺带记下这部的标签(猜你喜欢)、相关推荐等首帧后再拉
            adPlayerReady(dp, url, fresh) {
                if (!this.adultMode || !dp) return;
                const g = this.currentGroup, s = this.currentSource;
                const wk = (g && typeof g._wk === 'string') ? g._wk : '';
                const m = g && g._meta && typeof g._meta === 'object' ? g._meta : null;
                const dur = Math.max(0, Math.round(Number(s && s._dur) || Number(m && m.dur) || 0));
                const ctx = Object.freeze({
                    wk, dur, isLive: !!(this._liveActive || (g && g._isLive)), lineKey: s && s.site_key ? s.site_key + '|' + s.vod_id : '',
                    siteKey: s && s.site_key ? String(s.site_key) : '', vodId: s && s.vod_id != null ? String(s.vod_id) : '',
                    url: String(url || ''), fresh: !!fresh, episodes: (this.episodeList || []).length,
                });
                hooks.call('onPlayerReady', [dp, dp.video || null, ctx]);
                if (wk && !ctx.isLive) { this._adRememberTags(g); this._adArmRelated(dp, g); }
            },
            // 「猜你喜欢」用:本机记下看过的目录作品的 featured 标签(审查类 / blocked 不记;无痕不记)
            _adRememberTags(g) {
                if (!g || typeof g._wk !== 'string' || !WK_RE.test(g._wk) || !g._meta || typeof g._meta !== 'object' || incognito()) return;
                const ids = metaTagList(g._meta.tags, 6).map(t => t.id);
                if (ids.length) wkTags.put(g._wk, ids);
            },
            // 相关推荐:等主播放器出了第一帧(playing / 真的走动了)才挂上(不跟起播抢);20s 还没起播也挂(线路坏了时用户照样能换一部)
            _adArmRelated(dp, g) {
                const wk = g && g._wk;
                if (!wk || this.adult.relWk === wk) return;
                if (typeof this._adRelOff === 'function') this._adRelOff();
                const v = dp && dp.video;
                const go = () => {
                    off();
                    const cg = this.currentGroup;
                    if (!this.showDetail || !cg || cg._wk !== wk) return;
                    if (this.adult.relWk !== wk) this.adult.relWk = wk;
                };
                const onT = () => { if (v && v.currentTime > 0 && v.readyState >= 2) go(); };
                let t = 0;
                const off = () => {
                    clearTimeout(t);
                    if (v) { try { v.removeEventListener('playing', go); v.removeEventListener('timeupdate', onT); } catch (e) { } }
                    if (this._adRelOff === off) this._adRelOff = null;
                };
                this._adRelOff = off;
                if (v && v.addEventListener) { v.addEventListener('playing', go); v.addEventListener('timeupdate', onT); }
                t = setTimeout(go, 20000);
            },
            adRelPick(item) { if (item && item._wk) this.openWork(item); },
            // 搜索结果的窗口化网格:点卡片 = 原来的 openDetail(分组);海报坏了走原来的回退(换同组别的线路的海报 → 中性占位)
            adSearchPick(item) { if (item && item._g && typeof this.openDetail === 'function') this.openDetail(item._g); },
            adSearchImgErr(item) { if (item && item._pk && typeof this.handleImgError === 'function') { try { this.handleImgError(item._pk, item.title); } catch (e) { } } },
            // ---------- [adult] p4 刷短片(#/feed;页面本身在 adult/feed.js 的 window.dgAdultFeed)----------
            //   入口按钮 → 压一条 #/feed(返回键关);刷短片里点片名 → 刷短片先收起(停掉视频),开播放页;关播放页回到刷短片原位
            adOpenFeed() {
                if (!this.adFeedOn) return;
                try {
                    if (root.location.hash !== FEED_HASH) { this._adFeedPushed = true; root.location.hash = FEED_HASH; }
                    else this._adFeedHash();
                } catch (e) { }
            },
            // 返回键 / goHome:刷短片开着 → 关掉(退掉压的那条历史),返回 true
            adFeedBack() {
                const F = root.dgAdultFeed;
                if (!F || typeof F.isOpen !== 'function' || !F.isOpen()) return false;
                this._adFeedLeave();
                return true;
            },
            _adFeedLeave() {
                const F = root.dgAdultFeed;
                if (isFeedHash(root.location.hash) && this._adFeedPushed) { this._adFeedPushed = false; try { root.history.back(); return; } catch (e) { } }
                this._adFeedPushed = false;
                if (F && typeof F.close === 'function') F.close();
                if (isFeedHash(root.location.hash)) { try { root.history.replaceState(root.history.state, '', root.location.pathname + root.location.search); } catch (e) { } }
            },
            // 地址栏是 / 不是 #/feed → 开 / 关刷短片。返回 true = 这次地址变化归刷短片管(_adOnHash 不再往下走)
            _adFeedHash() {
                const F = root.dgAdultFeed;
                if (!F || typeof F.open !== 'function') return false;
                const want = isFeedHash(root.location.hash);
                const sus = typeof F.suspended === 'function' && F.suspended();
                if (want) {
                    if (!this.adFeedOn) { try { root.history.replaceState(root.history.state, '', root.location.pathname + root.location.search); } catch (e) { } return true; }
                    if (sus && this.showDetail) return true;   // 播放页开着时又回到 #/feed(前进键):等播放页关了再恢复
                    if (sus) { F.resume(); return true; }
                    if (!F.isOpen() && this.showDetail) {
                        // 播放页开着(不是从刷短片开的)时地址变成 #/feed(前进键 / 书签 / 手改地址):先关播放页(主播放器停下、销毁),再开刷短片 ——
                        //   否则两个同时放:主播放器有声 + 刷短片静音自动播,两份 HLS 下载。关不掉(截帧分享弹窗开着,closeDetail 只关弹窗)→ 这次不开
                        try { if (typeof this.closeDetail === 'function') this.closeDetail(); } catch (e) { }
                        if (this.showDetail) { try { root.history.replaceState(root.history.state, '', root.location.pathname + root.location.search); } catch (e) { } return true; }
                    }
                    if (!F.isOpen()) {
                        F.open({
                            onClose: () => this._adFeedLeave(),
                            onPick: (card) => { if (card && card._wk) { F.suspend(); this.openWork(card); } },
                        });
                    }
                    return true;
                }
                if (sus && this.showDetail) {
                    // 从刷短片开的播放页上按返回:关播放页,把刚退掉的 #/feed 压回去(关播放页的侦听器会恢复刷短片)
                    if (typeof this.closeDetail === 'function') this.closeDetail();
                    try { root.history.pushState({ dgAd: 1 }, '', FEED_HASH); } catch (e) { }
                    return true;
                }
                if (F.isOpen() || sus) { this._adFeedPushed = false; F.close(); }
                return false;
            },
            // 播放页关了:从刷短片来的回到刷短片;「猜你喜欢」按新的历史再算一次
            _adAfterDetail() {
                const F = root.dgAdultFeed;
                if (F && typeof F.suspended === 'function' && F.suspended()) {
                    if (isFeedHash(root.location.hash)) this.$nextTick(() => { try { F.resume(); } catch (e) { } });
                    else F.close();
                }
                this._adForYouSoon(2500);
            },
            // ---------- [adult] p4 猜你喜欢(纯本机:最近看过的目录作品的 featured 标签 → /api/catalog/browse?t=..&sort=hot;无痕不出)----------
            _adForYouSoon(ms) {
                clearTimeout(this._adFyT);
                this._adFyT = setTimeout(() => { this.adultLoadForYou(false).catch(() => { }); }, ms || 0);
            },
            async adultLoadForYou(force) {
                if (!this.adultMode || !this.adult || !this.adult.catalog) return;
                const seq = (this._adFySeq = (this._adFySeq || 0) + 1);
                const KEY = 'ad_foryou';
                const drop = () => {
                    if (!this.rowConfigs || !this.rowConfigs[KEY]) return;
                    const c = Object.assign({}, this.rowConfigs), l = Object.assign({}, this.rowLists);
                    delete c[KEY]; delete l[KEY];
                    this.rowConfigs = c; this.rowLists = l;
                };
                if (incognito()) { this._adFySig = ''; drop(); return; }
                const seen = new Set(), recent = [];
                (this.watchHistory || []).forEach(h => {
                    const wk = h && h.groupData && h.groupData._wk;
                    if (typeof wk === 'string' && WK_RE.test(wk) && !seen.has(wk)) { seen.add(wk); recent.push(wk); }
                });
                const top12 = recent.slice(0, 12);
                if (!top12.length) { this._adFySig = ''; drop(); return; }
                const sig = top12.join('|');
                if (!force && this._adFySig === sig) return;
                // 没记过标签的(以前看的 / 别的设备同步来的):补拉最近 3 部的作品信息(本地目录,零上游)
                let tags = wkTags.all();
                for (const wk of top12.filter(k => !tags[k]).slice(0, 3)) {
                    const d = await fetchWorkRaw(wk);
                    if (seq !== this._adFySeq) return;
                    wkTags.put(wk, d && d._meta ? metaTagList(d._meta.tags, 6).map(t => t.id) : []);
                }
                tags = wkTags.all();
                const top = forYouTags(top12, tags, 3);
                if (!top.length) { this._adFySig = sig; drop(); return; }
                const qs = [top.slice(0, 2), [top[0]], top[1] ? [top[1]] : null, top[2] ? [top[2]] : null].filter(q => q && q.length);
                const uq = qs.filter((q, i) => qs.findIndex(x => x.join(',') === q.join(',')) === i);
                const items = [];
                for (const t of uq) {
                    if (items.length >= 16) break;
                    // 复核 r3:推荐位 = 审查级(乱伦/强制等)永不推荐 → nr=1 让服务器把 rvl≠0 的作品整个去掉
                    const d = await cachedJson(browseApiUrl({ t, sort: 'hot' }, { page: 1, nr: true }), 8000);
                    if (seq !== this._adFySeq) return;
                    for (const c of (d && Array.isArray(d.results) ? d.results : [])) {
                        const it = cardToItem(c);
                        if (!it || seen.has(it._wk)) continue;
                        seen.add(it._wk);
                        items.push(Object.freeze(it));
                        if (items.length >= 24) break;
                    }
                }
                if (seq !== this._adFySeq || incognito()) return;
                this._adFySig = sig;
                if (items.length < 8) { drop(); return; }
                const labels = top.map(tagLabel).filter(Boolean);
                const cfg = {
                    title: '猜你喜欢', icon: 'fa-wand-magic-sparkles', path: 'ADULT', params: '', page: 1, totalPages: 1, adult: true,
                    more: null, today: 0, srcLabel: labels.slice(0, 2).join(' · '), srcTip: '按你最近看过的作品的标签推荐(只在这台设备上算,不上传)', foryou: labels.join(' · '),
                };
                // 放在第一行目录行(新上架)之后
                const c = {}, l = Object.assign({}, this.rowLists);
                const keys = Object.keys(this.rowConfigs || {}).filter(k => k !== KEY);
                keys.forEach((k, i) => { c[k] = this.rowConfigs[k]; if (i === 0) c[KEY] = cfg; });
                if (!keys.length) c[KEY] = cfg;
                l[KEY] = items;
                this.rowLists = l;
                this.rowConfigs = c;
            },
            // 关播放页 / 回首页 / 销毁重建播放器之前
            adPlayerGone(reason) {
                if (!this.adultMode) return;
                hooks.call('onPlayerDestroy', [String(reason || '')]);
            },
            // 写历史 / 进度 / 观看统计之前问一句(无痕时订阅者返回 false);返回 false = 别写
            adHistoryOk(kind, name, extra) {
                if (!this.adultMode) return true;
                const g = this.currentGroup;
                const item = Object.assign({ kind: String(kind || 'history'), name: String(name || ''), wk: (g && typeof g._wk === 'string') ? g._wk : '' }, extra || {});
                return hooks.call('onHistoryWrite', [item]) !== false;
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
        BUCKET_LABEL, NAV_BUCKETS, TYPES, SORTS, DURS, VARIANTS, GROUPS, DEFAULT_SORTS,
        catalog, cardToItem, browseUrl, homeToRows, todayMap, todayOf,
        workUrl, workSource, workToGroup, workToList, groupKeyOf, groupNameOf, isLandscape, pickFallbackPic, PLACEHOLDER,
        isContentPath, sameOriginPath,
        TAG_LABEL, NEVER_FEATURE, NO_ACTRESS_BUCKETS, tagLabel, fmtDur, srcFlags, srcExtra, varKind, orderSources, srcView, nativeDev,
        metaView, tagsUrl, normTags, suggestUrl, normSuggest, aliasPreset, beacon,
        // phase 3
        browseApiUrl, filterCount, nextTagState, normFacets, sortOpts, chipRow, activePills, routeOf, parseRoute, canonHash, isOurHash,
        normCloud, normTagInfo, normActress, normActressList, normStudios, relDate, featurable, isBlockedTag, guessCols,
        components: { DgAdGrid, DgAdFilter, DgAdHead, DgAdCloud, DgAdRails, DgAdActresses },
        ageGate, brand, auth, fetchWork, mixin, boot,
        // p4:扩展点 / 给 preview.js、feed.js、player-x.js、privacy.js 的桥
        hook, hooks: hooks.H, HOOK_NAMES, cardOf, wkTags, fetchWorkRaw, wrapPlayUrl, playUrl, proxyUrl, mainBusy, isTV,
        openWork: openWorkExt, incognito, privLocked, netBlock, netNow, cellOk, pvOn, CELL_KEY, PV_KEY,
        normRelated, forYouTags, noList, actSections, actIndexUrls, isFeedHash, FEED_HASH,
        _hooks: hooks, _bridge: bridge,
    };
});
