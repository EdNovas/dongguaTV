// [adult] 成人站前端(window.DgAdult)。在 index.html 的 <head> 里同步加载,先于 Vue 主脚本:
//   ① 年龄确认门(Vue 之前的全屏遮罩;没点「我已年满18岁」之前不发任何内容请求)
//   ② 站名/标题(document.title 用 /api/config 的 site_name,默认 MEI.NU)
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
    const DEFAULT_NAME = 'MEI.NU';

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
    // 首页分类栏 / 浏览页大类:一排平铺(用户 2026-11-23 定:分类只要两层 = 这一排 + 浏览页里的筛选)。
    //   多分区的大类(国产 / 日本)默认整类浏览(服务器 b= 逗号分隔取并集);只有国产带「分类」细分行(sub),
    //   日本的 有码/无码/中字 不再是细分,改走 版本 / 标签(无码、中文字幕)。
    //   SM·重口(fetish)/ 韩国·东南亚(asia)不归任何大类:只从 全部 进(标签 SM·调教 / 韩国 / 东南亚、搜索词、首页行、筛选面板的分类),
    //   「全部」认这两个孤儿分区的 b(ORPHAN)。全部 = 不限分类,首页「新上架」「随机发现」的「全部」进这里
    const TYPES = [
        { k: 'cn', l: '国产', icon: 'fa-video', sort: 'new', sub: true, buckets: [['cn_amateur', '自拍'], ['cn_studio', '传媒'], ['cn_hookup', '探花'], ['creators', '网红'], ['live', '主播']] },
        { k: 'jp', l: '日本', icon: 'fa-torii-gate', sort: 'new', buckets: [['jp_censored', '有码'], ['jp_uncensored', '无码'], ['jp_subbed', '中字']] },
        { k: 'west', l: '欧美', icon: 'fa-globe', sort: 'new', buckets: [['western', '欧美']] },
        { k: 'anime', l: '动漫', icon: 'fa-dragon', sort: 'new', buckets: [['anime', '动漫·里番']] },
        { k: 'softcore', l: '三级', icon: 'fa-film', sort: 'new', buckets: [['softcore', '三级·伦理']] },
        { k: 'lgbt', l: '同性', icon: 'fa-rainbow', sort: 'new', buckets: [['lgbt', '同性·TS']] },
        { k: 'short', l: '短视频', icon: 'fa-mobile', sort: 'new', buckets: [['short', '短视频']] },
        { k: 'commentary', l: 'AV解说', icon: 'fa-microphone', sort: 'new', buckets: [['commentary', 'AV解说']] },
        { k: 'ai_drama', l: 'AI短剧', icon: 'fa-robot', sort: 'new', buckets: [['ai_drama', 'AI短剧']] },
        { k: 'all', l: '全部', icon: 'fa-layer-group', sort: 'new', buckets: [] },
    ];
    // 不归任何大类的分区:「全部」里按它筛(旧链接 #/c/more?b=fetish、首页「SM·重口」行的「全部」、搜「SM」都落到 全部 · SM·重口)
    const ORPHAN = new Set(NAV_BUCKETS.filter(b => !TYPES.some(T => T.buckets.some(x => x[0] === b))));
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
        if (!bs.length) b = ORPHAN.has(b) ? b : '';   // 全部:只认孤儿分区(SM·重口 / 韩国·东南亚)
        else if (bs.length === 1) b = bs[0];
        else if (bs.indexOf(b) < 0) b = '';   // 多分区大类:'' = 整类(browseApiUrl 按大类的几个分区一起查)
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
    // 多分区大类整类浏览时发给服务器的 b(逗号分隔);单分区 / 全部 → ''
    const typeBuckets = (tk) => { const T = typeOf(tk); return T && T.buckets.length > 1 ? T.buckets.map(x => x[0]).join(',') : ''; };
    // /api/catalog/browse 地址。opt.cursor 有值时按游标翻(不带 page),否则按页;opt.facets=1 要分面计数(第 1 页才要);
    //   opt.type:大类(国产 / 日本 没选细分时 b 为空 → 按这个大类的几个分区一起查;不给 type 就是不限分类)
    function browseApiUrl(sel, opt) {
        const s = sel || {}, o = opt || {};
        const q = [['b', s.b || typeBuckets(o.type)], ['t', (s.t || []).join(',')], ['x', (s.x || []).join(',')], ['dur', s.dur || ''], ['v', s.v || ''],
            ['studio', s.studio || ''], ['actress', s.actress || ''], ['lp', s.lp || ''], ['sort', s.sort || 'new']];
        if (o.cursor) q.push(['cursor', String(o.cursor)]);
        else q.push(['page', String(Math.max(1, Math.min(500, parseInt(o.page, 10) || 1)))]);
        if (o.facets) q.push(['facets', '1']);
        if (o.nr) q.push(['nr', '1']);   // 不要审查级作品(推荐位用,服务器 snapshot rvl)
        return '/api/catalog/browse?' + q.filter(([k, v]) => v !== '' || k === 'page').map(([k, v]) => k + '=' + encQ(v)).join('&');
    }
    function browseUrl(tk, sel, page) { return browseApiUrl(normSel(tk, sel), { page, type: tk }); }
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
        // 封面备用地址(服务器的 alt:同一作品别的图床的封面,≤2;封面代理模式不给)。没有就不带这个键
        const alt = cleanAlt(c.alt, o.poster_path);
        if (alt.length) o._alt = alt;
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
    // 浏览页的固定筛选行只剩「分类」(只有国产有:全部 + 自拍/传媒/探花/网红/主播);标签 / 排序 / 时长 / 版本 / 厂牌 / 女优 在 <dg-ad-filter>(标签行 + 筛选面板)里
    function groupsOf(tk, sel) {
        const T = typeOf(tk);
        if (!T || !T.sub) return [];
        return [{ k: 'b', l: '分类', opts: [{ k: '', l: '全部' }].concat(T.buckets.map(([k, l]) => ({ k, l }))) }];
    }
    // 首页分类栏下面那块(成人版不出:首页只有一排大类,点了直接进浏览页;留着给 DgCatalog 的接口)
    function navRows(tk) {
        const T = typeOf(tk);
        if (!T || !T.sub) return [];
        return [{ l: '分类', items: T.buckets.map(([b, l]) => ({ l, sel: { b } })) }];
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
        if (T.buckets.length > 1) { const x = T.buckets.find(b => b[0] === s.b); return T.l + (x ? ' · ' + x[1] : '') + tg; }
        if (!T.buckets.length && s.b && BUCKET_LABEL[s.b]) return BUCKET_LABEL[s.b] + tg;   // 全部 · 孤儿分区:标题就是分区名(SM·重口)
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
        add('同性 同性ts', 'lgbt');
        // 同性·TS 分区里 ~86% 是女同:搜「人妖 / 男同 / 女同」要的是那一种 → 全部 + 那个标签(跨分区:日本的 TS 片不在同性分区里)
        const addTag = (words, t) => words.split(' ').forEach(w => { ALIAS[w] = { t }; });
        addTag('人妖 ts 伪娘 ts伪娘 ts人妖 跨性别 变性 变性人 药娘 男娘 ladyboy shemale', 'trans');
        addTag('男同 基佬 gay', 'gay');
        addTag('女同 百合 拉拉 蕾丝边 les lesbian', 'lesbian');
    })();
    function fromSearch(kw) {
        const k = String(kw || '').replace(/\s+/g, '').toLowerCase();
        if (!k) return null;
        const a = ALIAS[k];
        if (a && a.t) return { type: 'all', sel: { t: [a.t] } };
        return a ? { type: typeOfBucket(a.b), sel: { b: a.b } } : null;
    }
    // 首页行的「全部」:行上带的 more({b} / {sort})→ 浏览页预设
    function rowPreset(key, sortMode, cfg) {
        const m = cfg && cfg.more;
        if (!m || typeof m !== 'object') return null;
        if (m.b && BUCKET_LABEL[m.b]) return { type: typeOfBucket(m.b), sel: { b: m.b, sort: sortKey(m.sort) || 'new' } };
        if (m.sort) return { type: 'all', sel: { sort: sortKey(m.sort) } };   // 新片速递 → 发行日期;随机发现 → rand
        // 首页自己加的行(homeRows):整个大类 / 版本
        if (m.type && typeOf(m.type) && m.type !== 'all') return { type: m.type, sel: { sort: 'new' } };
        if (m.v && VARIANTS.some(o => o.k && o.k === m.v)) return { type: 'all', sel: { v: m.v, sort: 'new' } };
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
    // 浏览页「全部标签」展开的标签云:facets.groups(当前筛选下的 featured 标签 + 数)按组排,数为 0 的不列(已选 / 已排除的照样列);
    //   字号档 w 1..5 按 log(数量)(全部组一起比)。审查类永不在这里(facets.groups 本来只给 featured,这里再拦一道)
    function cloudOf(facets, sel) {
        const s = sel || {}, t = s.t || [], x = s.x || [];
        const groups = [];
        let max = 1;
        for (const g of (facets && Array.isArray(facets.groups) ? facets.groups : [])) {
            const tags = (g.tags || []).filter(tg => tg && featurable(tg.id) && (tg.count > 0 || t.indexOf(tg.id) >= 0 || x.indexOf(tg.id) >= 0))
                .map(tg => ({ id: tg.id, label: tg.label, count: Math.max(0, tg.count || 0), st: t.indexOf(tg.id) >= 0 ? 'in' : x.indexOf(tg.id) >= 0 ? 'ex' : '' }));
            tags.forEach(tg => { if (tg.count > max) max = tg.count; });
            if (tags.length) groups.push({ id: g.id, label: g.label, tags: tags.sort((a, b) => b.count - a.count) });
        }
        const lm = Math.log(max + 1);
        groups.forEach(g => g.tags.forEach(tg => { tg.w = Math.max(1, Math.min(5, 1 + Math.floor(4 * Math.log(tg.count + 1) / lm))); }));
        return groups;
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
    // 没有片单的页面形态(女优索引):不拉片单、不出筛选行和底栏。全部标签不再是单独一页(浏览页筛选行里展开)
    const noList = (view) => view === 'actresses';
    function routeOf(view, tk, sel) {
        const T = typeOf(tk) || typeOf('all');
        const s = normSel(T.k, sel);
        if (view === 'actresses') return '#/actresses';
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
        if (seg[1] === 'tags' && seg.length === 2) {   // 旧的标签云页 → 那个分类的浏览页(标签在筛选行「全部标签」里展开)
            const b = BUCKET_LABEL[params.b] ? params.b : '';
            const type = b ? typeOfBucket(b) : 'all';
            return { view: '', type, sel: normSel(type, { b }) };
        }
        if (seg[1] === 'actresses' && seg.length === 2) return { view: 'actresses', type: 'all', sel: {} };
        if (seg[1] === 'tag' && validTag(one) && !isBlockedTag(one)) return { view: 'tag', type: 'all', sel: { t: [one] } };
        if (seg[1] === 'actress' && validAid(one)) return { view: '', type: 'all', sel: { actress: one } };
        if (seg[1] === 'c' && (typeOf(one) || one === 'more')) {   // more:旧版「更多」大类(书签 / 历史里还有)→ 按 b 落到新大类,没 b = 全部
            const b = BUCKET_LABEL[params.b] ? params.b : '';
            const type = b ? typeOfBucket(b) : (typeOf(one) ? one : 'all');
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
    const FRESH_MIN = 12;   // 新片速递(AVDB 发行 ≤60 天且能播):不足 12 部整行不出(服务器也这么判,两头都拦;前端拿掉封面加载不出来的之后再判一次)
    const rowMin = (key) => (key === 'ad_fresh' ? FRESH_MIN : 1);
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
    // ========== 首页分类行:顺序 / 开关 / 自己加的分类(用户 2026-11-23 要的)==========
    //   布局 = 全部分类行按显示顺序的 [{ k, on }](k = rowConfigs 的键);存本机 dg_home_rows,登录了同步账号的也推到服务器(settings.adHomeRows)。
    //   固定行(服务器 /api/catalog/home 给的 + 猜你喜欢)默认全开、随机发现排最前(用户定);自己加的 = 整个大类 / 首页默认没有的分区 / 版本,
    //   最多 MAX_ADD 行(每加一行首页多一次浏览请求)。存的值可能来自旧版本 / 别的设备 / 手改,用之前一律过 normalize
    const HOME_BUCKETS = ['cn_amateur', 'cn_studio', 'cn_hookup', 'live', 'creators', 'short', 'jp_censored', 'jp_uncensored', 'jp_subbed', 'western', 'anime', 'softcore', 'fetish'];   // = lib/site-catalog/common.js HOME_BUCKETS(测试比对)
    const homeRows = (function () {
        const KEY = 'dg_home_rows', MAX_ADD = 6, CUSTOM_MIN = 6;
        const icon = (b) => (TILE[b] || [])[2] || 'fa-film';
        const BUILTIN = [
            { k: 'ad_random', l: '随机发现', icon: 'fa-dice' },
            { k: 'ad_new', l: '新上架', icon: 'fa-clock' },
            { k: 'ad_foryou', l: '猜你喜欢', icon: 'fa-wand-magic-sparkles', hint: '看过几部之后才有' },
            { k: 'ad_hot', l: '热门', icon: 'fa-fire' },
            { k: 'ad_fresh', l: '新片速递', icon: 'fa-calendar-check' },
        ].concat(HOME_BUCKETS.map(b => ({ k: 'ad_' + b, l: BUCKET_LABEL[b], icon: icon(b) })));
        // 能加的:国产 / 日本整类、首页默认没有的分区、版本(跨分类)
        const ADD = [];
        ['cn', 'jp'].forEach(tk => { const T = typeOf(tk); ADD.push({ id: 't_' + tk, l: T.l + '·全部', icon: T.icon, type: tk, sel: { sort: 'new' }, more: { type: tk } }); });
        NAV_BUCKETS.filter(b => HOME_BUCKETS.indexOf(b) < 0).forEach(b => ADD.push({ id: 'b_' + b, l: BUCKET_LABEL[b], icon: icon(b), type: typeOfBucket(b), sel: { b, sort: 'new' }, more: { b } }));
        [['zh', '中字·全部', 'fa-closed-captioning'], ['unc', '无码·全部', 'fa-fire-flame-curved'], ['4k', '4K 高清', 'fa-tv'], ['vr', 'VR', 'fa-vr-cardboard']]
            .forEach(([v, l, ic]) => ADD.push({ id: 'v_' + v, l, icon: ic, type: 'all', sel: { v, sort: 'new' }, more: { v } }));
        ADD.forEach(a => { a.k = 'ad_c_' + a.id; });
        const INFO = Object.create(null);
        BUILTIN.forEach(s => { INFO[s.k] = s; });
        ADD.forEach(a => { INFO[a.k] = a; });
        const isCustom = (k) => typeof k === 'string' && k.indexOf('ad_c_') === 0 && !!INFO[k];
        const def = () => BUILTIN.map(s => ({ k: s.k, on: true }));
        // 认得的行按给定顺序留下(去重;自己加的超过 MAX_ADD 的丢掉),没给到的固定行补在后面、开着
        function normalize(v) {
            const out = [], seen = new Set();
            let n = 0;
            for (const x of Array.isArray(v) ? v : []) {
                const k = typeof x === 'string' ? x : (x && typeof x === 'object' ? x.k : null);
                if (typeof k !== 'string' || !INFO[k] || seen.has(k)) continue;
                if (isCustom(k)) { if (n >= MAX_ADD) continue; n++; }
                seen.add(k);
                out.push({ k, on: typeof x === 'string' || x.on !== false });
            }
            for (const s of BUILTIN) if (!seen.has(s.k)) out.push({ k: s.k, on: true });
            return out;
        }
        function initial(saved) {
            if (saved) { try { const v = JSON.parse(saved); if (Array.isArray(v)) return normalize(v); } catch (e) { } }
            return def();
        }
        const added = (L) => L.filter(s => isCustom(s.k)).length;
        // 首页实际出的行(keys = rowConfigs 现有的键):按布局排、关掉的不出;布局里没有的(服务器以后新加的行)照出,排在最后
        function order(L, keys) {
            const pos = new Map(), on = new Map();
            L.forEach((s, i) => { pos.set(s.k, i); on.set(s.k, s.on); });
            return keys.filter(k => pos.has(k) && on.get(k)).sort((a, b) => pos.get(a) - pos.get(b)).concat(keys.filter(k => !pos.has(k)));
        }
        function move(L, k, dir) {
            const i = L.findIndex(s => s.k === k), j = i + (dir < 0 ? -1 : 1);
            if (i < 0 || j < 0 || j >= L.length) return L;
            const out = L.slice();
            out[i] = L[j]; out[j] = L[i];
            return out;
        }
        const toggle = (L, k, on) => L.map(s => (s.k === k ? { k, on: !!on } : s));
        // 新加的放最前面(一眼看到;不想要可以再往下挪)
        function add(L, id) {
            const a = ADD.find(x => x.id === id);
            if (!a || L.some(s => s.k === a.k) || added(L) >= MAX_ADD) return L;
            return [{ k: a.k, on: true }].concat(L);
        }
        const remove = (L, k) => (isCustom(k) ? L.filter(s => s.k !== k) : L);
        function isDefault(L) { const d = def(); return L.length === d.length && L.every((s, i) => s.k === d[i].k && s.on); }
        // 自己加的行:浏览接口第 1 页,nr=1 不要审查级(和首页别的推荐位一个口径)
        function url(k) { const a = INFO[k]; return isCustom(k) ? browseApiUrl(normSel(a.type, a.sel), { page: 1, nr: true, type: a.type }) : ''; }
        function config(k) {
            const a = INFO[k];
            return { title: a.l, icon: a.icon, path: 'ADULT', params: '', page: 1, totalPages: 1, adult: true, more: Object.assign({}, a.more), today: 0, srcLabel: '', srcTip: '', custom: true };
        }
        return { KEY, MAX_ADD, CUSTOM_MIN, BUILTIN, ADD, info: (k) => INFO[k] || null, isCustom, def, normalize, initial, added, order, move, toggle, add, remove, isDefault, url, config };
    })();
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
            if (tag && d.alias.label && !Array.isArray(d.alias.tags)) learnTag(tag, d.alias.label);
            // 多个词都是标签词(「黑丝 女同」)→ tags:[{tag,label}](≤3),浏览页按这几个标签一起筛
            const tags = [];
            for (const x of Array.isArray(d.alias.tags) ? d.alias.tags.slice(0, 3) : []) {
                if (!x || !validTag(x.tag) || tags.indexOf(x.tag) >= 0) continue;
                tags.push(x.tag);
                if (x.label) learnTag(x.tag, x.label);
            }
            if (b || tag) alias = Object.assign({ b, tag, label: cleanText(d.alias.label, 30) || (tag ? tagLabel(tag) : BUCKET_LABEL[b]) }, tags.length > 1 ? { tags } : {});
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
        const tags = (Array.isArray(a.tags) && a.tags.length > 1 ? a.tags : [tag]).filter((x) => validTag(x) && !isBlockedTag(x)).slice(0, 3);
        if (tags.length) sel.t = tags;
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
    // 竖图(海报 0.70、短视频 0.56):在 16:9 卡里整张放下(contain)+ 同一张图模糊铺底,不裁成中间一条
    const isPortrait = (w, h) => w > 0 && h > 0 && (w / h) < 0.9;
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
    const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect fill='%23262626' width='320' height='180'/%3E%3Cpath d='M140 62h40v56h-40z' fill='%23444'/%3E%3C/svg%3E";

    // ========== 封面加载不出来的卡片藏起来(资源站图床被墙 / 挂了 / 文件坏了);弱网下只是慢的永远不藏 ==========
    //   只管目录卡片(首页行 / 浏览网格 / 搜索结果 / 播放页相关推荐 / 搜索联想);继续观看 / 收藏 / 播放页 / 刷短片从来不藏。
    //   失败 = error,或 load 了但宽高 <16(1×1 占位、7 字节坏图)。失败了先换下一个地址(pic → alt…;已知死图床上的渲染前就跳过)。
    //   网络好不好不再从加载耗时去猜(没有 Resource Timing、没有「弱」成功、没有毫秒门槛、不探 /sw.js),而是直接问一声:
    //     probe(地址) = HEAD、no-cors、no-store(不走 HTTP 缓存;SW 对跨域 HEAD 直通)、20 秒:回了 = up(404 / 405 也算)/ 20 秒内报错 = down / 没回 = slow;
    //     成对探测 = 失败的图床 H 那一张 + ≤2 张对照(本会话真加载出来过的别的图床的封面,新的在前;一张都没有 → 页面上别的卡片的封面)。
    //   决策表(一张卡所有地址都失败了):
    //     断网 / 页面在后台                  → 不探;online / 切回前台从头再试(不算次数)
    //     H up                               → 图床通、是这个文件坏了(404 / 403 / 防盗链 / 坏图):3 秒后重试一次,还失败 → 藏(不给图床记失败)
    //     H down,对照有 up                   → 这台设备连不上 H、别的图床通:藏,给 H 记一次失败
    //     H slow,对照有 up                   → 说不清:30 秒后再探一轮;还是 slow / down → 本会话藏(down 才记失败);up → 留着(只是慢)
    //     对照一个都没 up(或者没有对照)      → 网络问题:不藏;之后有别的图加载出来 / online 时再试
    //     2 分钟内 ≥3 个图床 down、看到 up 的图床不比它多 → 多半是本机的问题(新域名 DNS 坏了 / 代理节点挂了 / 分流规则坏了):先不藏(日志只打一次);
    //       只压 2 分钟(从这张卡第一次被它压着算):到点重新成对探测,还是 down(或 slow 两轮)、对照通 → 照表藏(真被屏蔽的图床不会永远留白卡);对照都不通照旧不藏
    //   卡住(没 load 也没 error):<img> 在视口附近(±200px)待满 30 秒才探它的图床:H up = 只是慢,不动、2 分钟内不再探;否则按上表(slow 也要第二轮)。别的都不计时。
    //   本机记死(localStorage dg_cover_hosts,6 小时;无痕只在内存里):≥2 次 down、不同的图、相隔 ≥60 秒,每次对照都有 up、不在「本机的问题」里、
    //     这个图床本会话一次没成功过;10 分钟最多新记 4 个。已知死 = 服务器的 cover_dead_hosts ∪ 本机记死:地址渲染前跳过,一个能用的都没有的卡片不出。
    //     本机记死的图床:第一次用到后 1 分钟、之后每 10 分钟在后台探一次(no-store,缓存冒充不了),up → 复活、卡片放回来。本会话成功过的图床本会话不当死。
    //   封面代理(同源 /api/img):只按单张判:失败 → 3 秒后重试一次 → 还失败就 HEAD 它:404 / 410 → 藏;5xx / 断网 → 网络或服务器的问题,不藏、以后再试。
    //   页面冻过 >5 秒(睡眠 / 后台)、断网 / 联网、切前后台:在路上的探测作废重来;窗口化网格换块(卡片卸载 / 重挂)不吃重试次数、不按过时的结论藏。
    const CV_MIN = 16, CV_TTL_MS = 6 * 3600 * 1000, CV_KEY = 'dg_cover_hosts', CV_ALT_MAX = 2, CV_MEM_MAX = 200;
    const CV_PROBE_MS = 20000, CV_RETRY_MS = 3000, CV_ROUND2_MS = 30000, CV_STALL_MS = 30000, CV_STALL_OK_MS = 120000;
    const CV_REUSE_MS = 30000, CV_GUARD_MS = 120000, CV_GUARD_N = 3, CV_FREEZE_MS = 5000, CV_BEAT_MS = 1000, CV_KICK_MS = 15000, CV_PAR = 6;
    const CV_STRIKE_SPAN = 60000, CV_STRIKE_TTL = 30 * 60000, CV_NEW_MAX = 4, CV_NEW_WIN = 600000, CV_RECHECK_FIRST = 60000, CV_RECHECK_MS = 600000;
    const BAD_PIC_RE = /mac_default|nopic/i;
    // 和服务器 cover-health.js hostOf / /api/config cover_dead_hosts 的过滤同一套字符(含 '_':有的 CDN 子域名带下划线)
    const CV_HOST_RE = /^(?:[a-z0-9_-]{1,63}\.)*[a-z0-9_-]{1,63}$|^\[[0-9a-f:.]{2,45}\]$/i;
    // 封面地址的来源:http(s) 绝对地址 → 主机名(小写);同源 / 相对地址(封面代理 /api/img)→ 'self';data: / 别的 → ''
    function coverHost(url, selfHost) {
        const u = typeof url === 'string' ? url.trim() : '';
        if (!u || /^data:/i.test(u)) return '';
        if (u[0] === '/' && u[1] !== '/') return 'self';
        const m = /^(?:https?:)?\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]+)/i.exec(u);
        if (!m) return '';
        const h = m[1].toLowerCase().replace(/\.$/, '');
        if (!h || h.length > 253 || !CV_HOST_RE.test(h)) return '';
        const me = typeof selfHost === 'string' ? selfHost.toLowerCase() : '';
        return me && h === me ? 'self' : h;
    }
    // 卡片的候选封面:poster_path → _alt…(能当海报的地址、不是 mac_default/nopic 占位、去重);deadUrl(url) 为真的(已知死图床)跳过
    function coverCands(it, deadUrl) {
        const out = [];
        if (!it || typeof it !== 'object') return out;
        const add = (u) => {
            if (typeof u !== 'string' || !u || u.length > 1000 || !PIC_OK_RE.test(u) || BAD_PIC_RE.test(u) || out.indexOf(u) >= 0) return;
            if (deadUrl && deadUrl(u)) return;
            out.push(u);
        };
        add(it.poster_path);
        if (Array.isArray(it._alt)) it._alt.forEach(add);
        return out;
    }
    // 服务器卡片的 alt → 干净的备用地址(http(s)、≤2、去重、不等于 pic);没有 → []
    function cleanAlt(alt, pic) {
        const out = [];
        for (const u of Array.isArray(alt) ? alt : []) {
            if (typeof u !== 'string' || !/^https?:\/\//i.test(u) || u.length > 500 || BAD_PIC_RE.test(u) || u === pic || out.indexOf(u) >= 0) continue;
            out.push(u);
            if (out.length >= CV_ALT_MAX) break;
        }
        return out;
    }
    // 搜索结果一组的备用封面:别的线路的 vod_pic(能用、不是占位、不等于主封面),先挑不同图床的,最多 3 个
    function searchAlts(group, primary, max) {
        const n = max || 3, all = [];
        for (const s of (group && Array.isArray(group.sources)) ? group.sources : []) {
            const u = s && typeof s.vod_pic === 'string' ? s.vod_pic : '';
            if (!u || u === primary || u.length > 1000 || !PIC_OK_RE.test(u) || BAD_PIC_RE.test(u) || all.indexOf(u) >= 0) continue;
            all.push(u);
        }
        const used = new Set([coverHost(primary, '')]), out = [];
        all.forEach(u => { const h = coverHost(u, ''); if (out.length < n && !used.has(h)) { used.add(h); out.push(u); } });
        all.forEach(u => { if (out.length < n && out.indexOf(u) < 0) out.push(u); });
        return out;
    }
    // 探测地址:https 页面上的 http 封面按 https 问(浏览器加载 http 封面时也是自动升级成 https 的;直接 fetch http 会被当混合内容拦掉)
    function coverProbeUrl(url, https) {
        const u = String(url || '');
        return (https && /^http:\/\//i.test(u)) ? 'https://' + u.slice(7) : u;
    }
    // 探一个地址(网络原语):HEAD、no-cors(跨域拿到的是不透明响应,回了就算,405 也算)、no-store(不进 HTTP 缓存)、不带 cookie / Referer。
    //   cb('up' 回了 / 'down' ms 之内就报错了(DNS 失败、拒绝连接、被重置)/ 'slow' ms 内没回(中止))。没有 fetch 的老 WebView → 'slow'(说不清 = 不藏)
    function coverProbe(url, ms, cb) {
        let https = false;
        try { https = !!(root.location && root.location.protocol === 'https:'); } catch (e) { https = false; }
        const u = coverProbeUrl(url, https), F = root.fetch;
        let done = false, ctl = null;
        const fin = (v) => { if (!done) { done = true; cb(v); } };
        if (typeof F !== 'function' || !u) { fin('slow'); return; }
        try { ctl = typeof root.AbortController === 'function' ? new root.AbortController() : null; } catch (e) { ctl = null; }
        const tm = setTimeout(() => { fin('slow'); try { if (ctl) ctl.abort(); } catch (e) { } }, ms > 0 ? ms : CV_PROBE_MS);
        try {
            const o = { method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
            if (ctl) o.signal = ctl.signal;
            F.call(root, u, o).then(() => { clearTimeout(tm); fin('up'); }, () => { clearTimeout(tm); fin('down'); });
        } catch (e) { clearTimeout(tm); fin('slow'); }
    }
    // 封面代理(同源 /api/img)那一张:HEAD、no-store、带同源 cookie(鉴权)。cb(状态码;断网 / 超时 / 报错 = 0)
    function coverHead(url, ms, cb) {
        const F = root.fetch;
        let done = false, ctl = null;
        const fin = (v) => { if (!done) { done = true; cb(v); } };
        if (typeof F !== 'function') { fin(0); return; }
        try { ctl = typeof root.AbortController === 'function' ? new root.AbortController() : null; } catch (e) { ctl = null; }
        const tm = setTimeout(() => { fin(0); try { if (ctl) ctl.abort(); } catch (e) { } }, ms > 0 ? ms : CV_PROBE_MS);
        try {
            const o = { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' };
            if (ctl) o.signal = ctl.signal;
            F.call(root, String(url || ''), o).then((r) => { clearTimeout(tm); fin((r && Number(r.status)) || 0); }, () => { clearTimeout(tm); fin(0); });
        } catch (e) { clearTimeout(tm); fin(0); }
    }
    // 一次成对探测 → 这个图床这一轮的结论(纯函数)。res = { target:'up'|'down'|'slow', controlUp };round = 1 / 2(30 秒后的第二轮)
    //   'file' 图床通、文件坏 / 'keep' 第二轮通了:只是慢 / 'net' 对照一个都没 up:网络问题 / 'host' down、对照通:连不上 /
    //   'amb' 第一轮 slow、对照通:30 秒后再探 / 'host2' 第二轮还 slow:本会话藏(不记失败)
    function coverClass(res, round) {
        const t = res && res.target;
        if (t === 'up') return round === 2 ? 'keep' : 'file';
        if (!(res && res.controlUp)) return 'net';
        if (t === 'down') return 'host';
        return round === 2 ? 'host2' : 'amb';
    }
    // 一张卡所有地址都失败了怎么办(纯函数)。c = { online, hidden, vs:[它失败过的各图床的结论;'pend' = 还在探], guard(本机的问题), retried(文件坏的那次重试用过了) }
    //   'off' 等 online / 切回前台 / 'pend' 等探测 / 'net' 'guard' 'keep' 先不藏、以后再试 / 'retry' 3 秒后重试一次 / 'hide'
    function coverVerdict(c) {
        const x = c || {}, vs = Array.isArray(x.vs) ? x.vs : [];
        if (x.online === false || x.hidden) return 'off';
        if (!vs.length || vs.some(v => v === 'pend' || v === 'amb')) return 'pend';
        if (vs.indexOf('net') >= 0) return 'net';
        if (x.guard) return 'guard';
        if (vs.indexOf('keep') >= 0) return 'keep';
        if (vs.indexOf('file') >= 0 && !x.retried) return 'retry';
        return 'hide';
    }
    // 本机的问题(纯函数):log = [{ t, h, up }](成对探测里目标 down 记 up:false;目标 / 对照 up 记 up:true)。
    //   2 分钟内 down 的图床 ≥3 个、up 的图床不比它多 → true(新域名 DNS 坏了 / 代理节点挂了 / 分流规则坏了,不是这些图床的错)
    function coverGuard(log, t) {
        const dn = new Set(), up = new Set();
        (Array.isArray(log) ? log : []).forEach(e => { if (e && e.t <= t && t - e.t <= CV_GUARD_MS) (e.up ? up : dn).add(e.h); });
        return dn.size >= CV_GUARD_N && up.size <= dn.size;
    }
    // 挑对照(纯函数):ok = [{ h, u, t }](每个图床一张,t = 加载成功的时刻);skip(h) 为真的不要(目标自己 / 已知死 / 同源 / 刚 down 过);
    //   新的在前,但 2 分钟内已经探到 up 的图床(recentUp)排后 —— 对照多覆盖几个图床,「本机的问题」才分得清;≤n 个、图床不重复
    function coverControls(ok, skip, recentUp, n) {
        const L = (Array.isArray(ok) ? ok : []).filter(x => x && x.h && x.u && !(skip && skip(x.h))).sort((a, b) => (b.t || 0) - (a.t || 0));
        const R = recentUp || new Set(), out = [], hs = new Set(), max = n || 2;
        const take = (x) => { if (out.length < max && !hs.has(x.h)) { hs.add(x.h); out.push(x); } };
        L.forEach(x => { if (!R.has(x.h)) take(x); });
        L.forEach(take);
        return out;
    }
    // 图床记忆:本会话真加载成功过的图床;记过的失败(down + 对照通,30 分钟内);本机记死(到期时间,localStorage,6 小时;无痕不写)+ 服务器给的死图床
    function makeCoverHosts(opt) {
        const o = opt || {};
        const now = o.now || (() => Date.now());
        const key = o.key || CV_KEY;
        let mem = null, server = new Set(), marks = [];
        const okN = Object.create(null), strikes = Object.create(null);
        const store = () => { try { return o.store ? o.store() : null; } catch (e) { return null; } };
        function load() {
            if (mem) return mem;
            mem = Object.create(null);
            let d = null;
            try { const s = store(); d = s ? JSON.parse(s.getItem(key) || 'null') : null; } catch (e) { d = null; }
            const t = now();
            if (d && d.v === 1 && d.d && typeof d.d === 'object') {
                for (const h of Object.keys(d.d)) { const until = Number(d.d[h]); if (CV_HOST_RE.test(h) && until > t && until <= t + CV_TTL_MS + 60000) mem[h.toLowerCase()] = until; }
            }
            return mem;
        }
        function save() {
            try { if (o.incognito && o.incognito()) return false; } catch (e) { return false; }   // 无痕:只在内存里
            try { if (o.register) o.register(key); } catch (e) { }
            const s = store();
            if (!s) return false;
            const t = now();
            const hs = Object.keys(mem).filter(h => mem[h] > t).sort((a, b) => mem[b] - mem[a]).slice(0, CV_MEM_MAX);
            try {
                if (!hs.length) { s.removeItem(key); return true; }
                const d = {};
                hs.forEach(h => { d[h] = mem[h]; });
                s.setItem(key, JSON.stringify({ v: 1, d }));
                return true;
            } catch (e) { return false; }
        }
        const live = (h) => !h || h === 'self' || okN[h] > 0;
        return {
            // 这个图床有一张目录封面真加载出来了 → 本会话不当它死。返回 true = 原来当它死(服务器 / 本机记的;只在第一次成功时报)。
            //   本机的记录不在这里删(可能是缓存里出来的):由后台 no-store 探测确认了再删(revive)
            ok(h) {
                if (!h) return false;
                const first = !(okN[h] > 0);
                okN[h] = (okN[h] || 0) + 1;
                delete strikes[h];
                if (h === 'self' || !first) return false;
                return server.has(h) || load()[h] > now();
            },
            hostOk: (h) => !!h && okN[h] > 0,
            // 记一次失败(成对探测:目标 down、对照通、不在「本机的问题」里 —— 调用方保证)。返回 true = 这一下把它记死了。
            //   要 ≥2 张不同的图、最早和最晚相隔 ≥60 秒(一阵子的 DNS 抽风哪怕连着十几秒也只算一次);30 分钟前的忘掉;本会话成功过的不记。
            //   保险丝:10 分钟内最多新记死 4 个
            strike(h, url, t) {
                if (live(h)) return false;
                const tt = t > 0 ? t : now();
                const f = strikes[h] || (strikes[h] = new Map());
                f.forEach((x, u) => { if (tt - x > CV_STRIKE_TTL || x - tt > CV_STRIKE_TTL) f.delete(u); });
                const u = String(url);
                if (!f.has(u) && f.size < 16) f.set(u, tt);
                if (f.size < 2) return false;
                let lo = Infinity, hi = -Infinity;
                f.forEach((x) => { if (x < lo) lo = x; if (x > hi) hi = x; });
                if (hi - lo < CV_STRIKE_SPAN) return false;
                const m = load(), tn = now();
                if (m[h] > tn) return false;
                marks = marks.filter(x => tn - x < CV_NEW_WIN);
                if (marks.length >= CV_NEW_MAX) return false;
                marks.push(tn);
                m[h] = tn + CV_TTL_MS;
                save();
                return true;
            },
            // 后台探测确认图床活了:删掉本机记录。返回 true = 原来记着
            revive(h) {
                const m = load();
                if (!(m[h] > now())) return false;
                delete m[h];
                delete strikes[h];
                save();
                return true;
            },
            isDead(h) { if (live(h)) return false; if (server.has(h)) return true; const x = load()[h]; return !!x && x > now(); },
            // 只是这台设备记死的(服务器没说死、本会话没成功过):后台定时再探
            local(h) { if (live(h) || server.has(h)) return false; const x = load()[h]; return !!x && x > now(); },
            // 本机记录里有它(不管本会话有没有成功过)
            marked(h) { const x = load()[h]; return !!x && x > now(); },
            // 服务器的死图床表(/api/config cover_dead_hosts);返回 true = 有变化
            setServer(list) {
                const next = new Set();
                for (const x of Array.isArray(list) ? list : []) {
                    const h = typeof x === 'string' ? x.trim().toLowerCase() : '';
                    if (h && h.length <= 253 && CV_HOST_RE.test(h)) next.add(h);
                    if (next.size >= CV_MEM_MAX) break;
                }
                const same = next.size === server.size && Array.from(next).every(h => server.has(h));
                server = next;
                return !same;
            },
            dead() { const m = load(), t = now(); return Array.from(new Set(Array.from(server).concat(Object.keys(m).filter(h => m[h] > t)))).filter(h => !live(h)); },
            mem: () => Object.assign({}, load()),
        };
    }
    // 封面控制器(页面里一个:covers;测试可以 makeCovers(假时钟 / 假存储 / 假 IntersectionObserver / 假探测)另起)
    //   模板:<img v-dg-cv="卡片" :src="covers.src(卡片)">(指令登记 <img> ↔ 卡片,load / error 由文档级捕获监听转给 onLoad / onError);
    //   卡片还出不出:covers.visible(卡片)(计算属性里先读 covers.ver() 才会在判定变了之后重算)
    function makeCovers(envOver) {
        const C = {};
        let E, hosts, st, recs, byKey, els, seenEls, probeSet, waitSet, pcache, selfH, io, T, dueAt, applyAt, epoch, lastBeat, lastLoad;
        let hp, pq, purl, inflight, glog, guardOn, guardAt, okHosts, seenUrls, stallOk, retryQ, kickAt, hidBy, samples, recheckAt, okPics, nProbe, ctlUsed;
        let ig = 0, rx = null;
        const rxPlain = { v: 0 }, subs = new Set();
        function init(over) {
            if (T && E) { try { E.clearTimeout(T); } catch (e) { } }
            if (io) { try { io.disconnect(); } catch (e) { } }
            ig++;
            E = Object.assign({
                now: () => Date.now(),
                online: () => { try { return !(root.navigator && root.navigator.onLine === false); } catch (e) { return true; } },
                hidden: () => { try { return !!(root.document && root.document.hidden === true); } catch (e) { return false; } },
                store: () => { try { return root.localStorage || null; } catch (e) { return null; } },
                incognito: () => incognito(),
                selfHost: () => { try { return (root.location && root.location.hostname) || ''; } catch (e) { return ''; } },
                IO: () => (typeof root.IntersectionObserver === 'function' ? root.IntersectionObserver : null),
                probe: (url, ms, cb) => coverProbe(url, ms, cb),   // 跨域探测 cb('up' / 'down' / 'slow');测试换成假的
                head: (url, ms, cb) => coverHead(url, ms, cb),     // 封面代理那一张 cb(状态码 / 0);测试换成假的
                setTimeout: (f, ms) => setTimeout(f, ms),
                clearTimeout: (t) => clearTimeout(t),
                // 一键清除 / 无痕拦截都认这个键(privacy.js 是 defer 加载的:写的时候它在就登记)
                register: (k) => { const P = root.dgPrivacy; if (P && typeof P.registerKeys === 'function') P.registerKeys({ keys: [k] }); },
                log: (m) => { try { console.info('[adult] 封面:' + m); } catch (e) { } },
            }, envOver || {}, over || {});
            hosts = makeCoverHosts({ now: E.now, store: E.store, incognito: E.incognito, register: E.register, key: CV_KEY });
            st = new Map();            // 卡片键 → 状态(见 sOf)
            recs = new WeakMap();      // <img> → { key, item, url, st(0 在加载 / 1 成功 / 2 失败), seen(进视口附近的时刻,0 = 不在), sp(卡住的探测在路上) }
            byKey = new Map();         // 卡片键 → Set(<img>)
            els = new Set();           // 挂着的 <img>
            seenEls = new Set();       // 在视口附近、还在加载的 <img>(卡住判定)
            probeSet = new Set();      // ph = 'probe' 的卡片键
            waitSet = new Set();       // ph = 'wait' 的卡片键
            pcache = new WeakMap();    // 卡片 → { p, a, L:[{u, h}] }(解析过的候选地址)
            selfH = '';
            try { selfH = String(E.selfHost() || ''); } catch (e) { selfH = ''; }
            io = null; T = 0; dueAt = 0; applyAt = 0; epoch = 1; lastBeat = E.now(); lastLoad = 0;
            hp = new Map();            // 图床 → 成对探测 { ep, st:'q'|'pend'|'wait2'|'done', round, t0, t1, url, res, cls, again, cards:Set(键), stalls:Set(<img>) }
            pq = [];                   // 排队的图床(同时最多 CV_PAR 个成对探测在路上)
            purl = new Map();          // 地址 → 探测(同一个地址在路上 / 5 秒内探过的合并)
            inflight = 0; nProbe = 0;
            glog = []; guardOn = false; // 最近 2 分钟的 up / down(「本机的问题」)
            guardAt = 0;               // 被「本机的问题」压着的卡最早到 2 分钟的时刻(到点重新探)
            ctlUsed = new Map();       // 图床 → 最近一次被挑去当对照的时刻(同时在探的错开)
            okHosts = new Map();       // 图床 → { u, t }:本会话真加载出来过的跨域封面(对照从这里挑)
            seenUrls = new Map();      // 图床 → 页面上见过的一个封面地址(还没有成功过的图时的对照)
            stallOk = new Map();       // 图床 → 到这个时刻之前不再为卡住探它(回了 = 只是慢)
            retryQ = new Map();        // 卡片键 → 3 秒后重试的时刻
            kickAt = 0;
            hidBy = new Map();         // 图床 → Set(卡片键):因为连不上它藏掉的(它后来有图加载出来 / 复活了 → 放回来)
            samples = new Map();       // 本机记死的图床 → 一个封面地址(定时在后台探)
            recheckAt = 0;
            okPics = new Map();        // 'w:'作品键 / 'p:'海报键 → 真加载出来的那张(收藏的封面用)
        }
        init();
        const hostOf = (u) => coverHost(u, selfH);
        const keyOf = (it) => (it && typeof it === 'object' && typeof it.id === 'string' && it.id && it.id.length <= 600) ? it.id : '';
        const attr = (el) => { try { return String((el.getAttribute ? el.getAttribute('src') : el.src) || ''); } catch (e) { return ''; } };
        const isData = (u) => /^data:/i.test(u);
        const deadH = (h) => !!h && hosts.isDead(h);
        const guard = (t) => coverGuard(glog, t);
        // 响应式版本号:Vue 在(adult.js 比 Vue 先加载,第一次用到时才建)
        function rxs() {
            if (rx) return rx;
            const V = root.Vue;
            if (V && typeof V.reactive === 'function') { try { rx = V.reactive({ v: rxPlain.v }); return rx; } catch (e) { } }
            return rxPlain;
        }
        // 卡片状态:ph ''(在试 / 好了)/ 'probe'(地址都失败了,等探测的结论)/ 'file'(3 秒后重试)/ 'wait'(先不藏;why:off|net|guard|keep)/ 'hid'
        //   failed(这一轮失败过的地址)/ kind(地址 → err|tiny|stall)/ last(最后失败的地址)/ ok(真加载出来的地址)/ fr(文件坏的那次重试用过了)/
        //   pr、px(封面代理的那次重试用过了 / 排着的是代理的重试)/ vs(这一轮各图床的结论)/ hw、hh(藏的原因、因为哪些图床)/ at(上次从头试的时刻)/ wt(开始等的时刻)/
        //   gw(第一次被「本机的问题」压着的时刻;从头再试也不清,加载出来 / 藏了才清)
        function sOf(k, mk) {
            let s = st.get(k);
            if (!s && mk) {
                if (st.size >= 5000) { for (const [kk, x] of st) { if (!x.ph) { st.delete(kk); break; } } }
                s = { ph: '', why: '', failed: new Set(), kind: Object.create(null), last: '', ok: '', fr: false, pr: false, px: false, vs: null, hw: '', hh: [], at: E.now(), wt: 0, hg: 0, gw: 0 };
                st.set(k, s);
            }
            return s || null;
        }
        function setPh(k, s, ph, why) {
            s.ph = ph; s.why = why || '';
            if (ph === 'probe') probeSet.add(k); else probeSet.delete(k);
            if (ph === 'wait') { waitSet.add(k); s.wt = E.now(); } else waitSet.delete(k);
            if (ph !== 'file') retryQ.delete(k);
        }
        // 卡片的候选地址(解析一次、按卡片缓存;网格每批判定要对上万张卡跑 visible)
        function parsed(it) {
            if (!it || typeof it !== 'object') return [];
            let c = pcache.get(it);
            if (c && c.p === it.poster_path && c.a === it._alt) return c.L;
            c = { p: it.poster_path, a: it._alt, L: coverCands(it).map(u => ({ u, h: hostOf(u) })) };
            try { pcache.set(it, c); } catch (e) { }
            return c.L;
        }
        const cands = (it) => { const out = []; parsed(it).forEach(x => { if (!deadH(x.h)) out.push(x.u); }); return out; };
        function current(it, s) { const L = parsed(it); for (let i = 0; i < L.length; i++) { const x = L[i]; if (!deadH(x.h) && (!s || !s.failed.has(x.u))) return x.u; } return ''; }
        const attached = (k) => { const set = byKey.get(k); let on = false; if (set) set.forEach(el => { if (el.isConnected !== false) on = true; }); return on; };
        // 本机记死的图床:记一个页面上遇到的地址,到点在后台探一下(1 分钟后,之后每 10 分钟)
        function sample(h, u) {
            if (samples.has(h) || samples.size >= 32) return;
            samples.set(h, u);
            if (!recheckAt) { recheckAt = E.now() + CV_RECHECK_FIRST; arm(recheckAt); }
        }
        // 卡片还该不该出现:判了藏 / 一个能用的地址都没有 → 不出;在等 / 在探的照常出(骨架闪烁)。
        //   判了藏的卡片带来了没试过的地址(重新搜索换了线路、死图床活了)→ 放出来再试
        function visible(it) {
            const k = keyOf(it);
            if (!k) return true;
            const L = parsed(it), s = st.get(k);
            let any = false, fresh = false;
            for (let i = 0; i < L.length; i++) {
                const x = L[i];
                if (deadH(x.h)) { if (hosts.local(x.h)) sample(x.h, x.u); continue; }
                any = true;
                if (x.h && x.h !== 'self' && !seenUrls.has(x.h) && seenUrls.size < 300) seenUrls.set(x.h, x.u);
                if (!s || !s.failed.has(x.u)) fresh = true;
            }
            if (!any) return false;
            if (!s || s.ph !== 'hid') return true;
            if (!fresh) return false;
            restart(k, s);
            changed();
            return true;
        }
        // 模板的 src:该试的那个地址;判了藏(点了「显示」才看得到)/ 没有能用的地址 → 中性占位
        function src(it) {
            const k = keyOf(it), s = k ? st.get(k) : null;
            if (s && s.ph === 'hid') return PLACEHOLDER;
            if (s && s.ok && !deadH(hostOf(s.ok)) && parsed(it).some(x => x.u === s.ok)) return s.ok;
            const u = current(it, s);
            if (u) return u;
            if (s && s.ph && s.last) return s.last;
            return PLACEHOLDER;
        }
        // ---- 唯一的定时器:批量生效(150ms 攒一批)/ 3 秒后的重试 / 第二轮探测 / 卡住判定 / 再试等着的卡 / 记死图床复查 / 探测在路上时每秒的心跳(看页面冻没冻过) ----
        function arm(at) {
            if (T && dueAt <= at) return;
            if (T) { try { E.clearTimeout(T); } catch (e) { } }
            dueAt = at;
            T = E.setTimeout(run, Math.max(0, at - E.now()));
        }
        function changed(soon) {
            const at = E.now() + (soon ? 0 : 150);
            if (!applyAt || at < applyAt) applyAt = at;
            arm(applyAt);
        }
        function flush() {
            const r = rxs();
            r.v = (r.v || 0) + 1;
            if (r !== rxPlain) rxPlain.v = r.v;
            subs.forEach(f => { try { f(); } catch (e) { try { console.warn('[adult] 封面', e); } catch (x) { } } });
            pvCheck();
        }
        function run() {
            const t = E.now();
            const late = dueAt > 0 && t - dueAt > CV_FREEZE_MS;
            T = 0; dueAt = 0;
            lastBeat = t;
            if (late) freeze();   // 页面冻过 / 睡眠:在路上的探测作废重来,卡住的表从现在起
            if (applyAt && t >= applyAt) { applyAt = 0; flush(); }
            let next = 0;
            const at = (x) => { if (x > 0) next = next ? Math.min(next, x) : x; };
            retryQ.forEach((due, k) => { if (t >= due) { retryQ.delete(k); doRetry(k); } else at(due); });
            let q = false;
            hp.forEach((P, h) => {
                if (P.st === 'wait2') { if (t >= P.again) { P.round = 2; P.st = 'q'; pq.push(h); q = true; } else at(P.again); }
                else if (P.st === 'pend' && t - P.t0 > 2 * CV_PROBE_MS + CV_FREEZE_MS) lost(h, P);   // 探测一直不回(不该发生):当作废重来
            });
            if (q) pump();
            if (!E.hidden()) {
                seenEls.forEach(el => {
                    const r = recs.get(el);
                    if (!r || r.st || !r.seen) { seenEls.delete(el); return; }
                    if (r.sp) return;
                    const due = Math.max(r.seen + CV_STALL_MS, stallOk.get(hostOf(r.url)) || 0);
                    if (t >= due) stallCheck(el, r); else at(due + 50);
                });
            }
            if (kickAt && t >= kickAt) { kickAt = 0; kick(); }
            if (recheckAt && t >= recheckAt) { recheckAt = 0; recheck(t); }
            if (guardAt && t >= guardAt) { guardAt = 0; reGuard(t); }
            at(applyAt); at(kickAt); at(recheckAt); at(guardAt);
            if (inflight > 0) at(t + CV_BEAT_MS);
            if (next) arm(next);
        }
        // ---- 作废:冻过 / 断网 / 联网 / 切前后台。在路上 / 等第二轮的探测不认了;卡住的表从现在重新起 ----
        function bump() {
            epoch++;
            const t = E.now();
            hp.clear(); pq = []; purl.clear();
            lastBeat = t;
            probeSet.forEach(k => { const s = st.get(k); if (s) s.vs = null; });
            seenEls.forEach(el => { const r = recs.get(el); if (r) { r.sp = false; if (r.seen) r.seen = t; } });
            if (seenEls.size) arm(t + CV_STALL_MS + 50);
        }
        function reDecide() { Array.from(probeSet).forEach(k => { const s = st.get(k); if (s && s.ph === 'probe') decide(k, s); }); }
        function freeze() { bump(); reDecide(); }
        function lost(h, P) {
            if (hp.get(h) !== P || P.lost) return;
            P.lost = true;
            hp.delete(h);
            inflight = Math.max(0, inflight - 1);
            P.cards.forEach(k => { const s = st.get(k); if (s && s.vs) s.vs.delete(h); });
            Array.from(P.cards).forEach(k => { const s = st.get(k); if (s && s.ph === 'probe') decide(k, s); });
            P.stalls.forEach(el => { const r = recs.get(el); if (r) r.sp = false; });
        }
        // 从头再试(不算次数):失败记录清掉,挂着的 <img> 换回第一个能用的地址
        function restart(k, s) {
            setPh(k, s, '');
            s.vs = null; s.failed.clear(); s.kind = Object.create(null); s.ok = ''; s.at = E.now(); s.hh = []; s.hw = '';
            const set = byKey.get(k);
            if (set) set.forEach(el => {
                const r = recs.get(el);
                if (!r || el.isConnected === false) return;
                const u = current(r.item, s);
                if (u) setSrc(el, r, u);
            });
        }
        function restartWaiting(all) {
            Array.from(waitSet).forEach(k => {
                const s = st.get(k);
                if (!s || s.ph !== 'wait') { waitSet.delete(k); return; }
                if (all || s.why === 'off') restart(k, s);
            });
        }
        // ---- 成对探测 ----
        // 这个图床的结论:同一轮(没作废)30 秒内探过的直接用;在探 / 等第二轮 → 'pend'(探完回来再判 k / 再看卡住的 el);没有 → 排队去探
        function verdict(h, u, k, el) {
            const t = E.now();
            let P = hp.get(h);
            if (P && P.ep === epoch) {
                if (P.st !== 'done') { if (k) P.cards.add(k); if (el) P.stalls.add(el); return 'pend'; }
                if (t - P.t1 <= CV_REUSE_MS) return P.cls;
            }
            P = { ep: epoch, st: 'q', round: 1, t0: 0, t1: 0, url: u, res: null, cls: '', again: 0, cards: new Set(k ? [k] : []), stalls: new Set(el ? [el] : []) };
            hp.set(h, P);
            pq.push(h);
            pump();
            return P.st === 'done' ? P.cls : 'pend';   // 地址刚探过(5 秒内的结果直接用)→ 当场就有结论
        }
        function pump() {
            while (inflight < CV_PAR && pq.length) {
                const h = pq.shift(), P = hp.get(h);
                if (P && P.st === 'q') start(h, P);
            }
        }
        // 探一个地址;同一个地址在路上 / 5 秒内(同一轮)探过的合并成一次
        function probeOnce(url, cb) {
            const t = E.now();
            let p = purl.get(url);
            if (p && p.ep === epoch && (p.st === 'pend' || t - p.t <= 5000)) { if (p.st === 'pend') p.cbs.push(cb); else cb(p.v); return; }
            p = { ep: epoch, st: 'pend', v: '', t: 0, cbs: [cb] };
            purl.set(url, p);
            if (purl.size > 300) purl.delete(purl.keys().next().value);
            nProbe++;
            const g0 = ig;
            const done = (v) => {
                if (p.st !== 'pend') return;
                p.st = 'done'; p.v = (v === 'up' || v === 'down') ? v : 'slow'; p.t = E.now();
                const cbs = p.cbs;
                p.cbs = [];
                if (g0 !== ig) return;
                cbs.forEach(f => { try { f(p.v); } catch (e) { try { console.warn('[adult] 封面', e); } catch (x) { } } });
            };
            try { E.probe(url, CV_PROBE_MS, done); } catch (e) { done('slow'); }
        }
        // 对照:本会话真加载出来过的别的图床(新的在前、先挑 2 分钟内还没探到 up 的);一张都没有 → 页面上别的卡片的封面
        //   (同时在探的几个图床也错开对照:几个图床一起坏的时候,对照覆盖的图床越多,「本机的问题」越不会误判)
        function controlsFor(h) {
            const t = E.now(), used = new Set(), dn = new Set();
            glog.forEach(e => { if (t - e.t <= CV_GUARD_MS) (e.up ? used : dn).add(e.h); });
            ctlUsed.forEach((t0, x) => { if (t - t0 <= CV_GUARD_MS) used.add(x); else ctlUsed.delete(x); });
            const skip = (x) => !x || x === h || x === 'self' || deadH(x) || dn.has(x);
            const ok = [];
            okHosts.forEach((o, x) => ok.push({ h: x, u: o.u, t: o.t }));
            let L = coverControls(ok, skip, used, 2);
            if (!L.length) {
                const F = [], fh = new Set();
                const add = (x, u) => { if (!skip(x) && !fh.has(x) && u && !isData(u)) { fh.add(x); F.push({ h: x, u, t: 0 }); } };
                els.forEach(el => { const r = recs.get(el); if (r && r.url) add(hostOf(r.url), r.url); });
                seenUrls.forEach((u, x) => add(x, u));
                L = coverControls(F, skip, used, 2);
            }
            L.forEach(c => { ctlUsed.delete(c.h); ctlUsed.set(c.h, t); });
            while (ctlUsed.size > 200) ctlUsed.delete(ctlUsed.keys().next().value);
            return L;
        }
        function start(h, P) {
            P.st = 'pend'; P.t0 = E.now(); lastBeat = P.t0;
            inflight++;
            arm(P.t0 + CV_BEAT_MS);
            const ctl = controlsFor(h), ep = epoch, g0 = ig;
            const res = { target: '', controlUp: false, controlsTried: ctl.length, ups: [] };
            let left = ctl.length, closed = false;
            // 结论一定下来就收(目标 up / 有对照 up / 对照都回来了),不等慢的对照;收了之后回来的对照 up 照样记进「本机的问题」的账
            const close = () => {
                if (closed || !res.target || !(res.target === 'up' || res.controlUp || left === 0)) return;
                closed = true;
                if (g0 !== ig || P.lost) return;
                inflight = Math.max(0, inflight - 1);
                finish(h, P, res, ep);
                pump();
            };
            ctl.forEach(c => probeOnce(c.u, (v) => {
                left--;
                if (v === 'up') { if (!closed) { res.controlUp = true; res.ups.push(c.h); } else if (g0 === ig && ep === epoch) glog.push({ t: E.now(), h: c.h, up: true }); }
                close();
            }));
            probeOnce(P.url, (v) => { res.target = v; close(); });
        }
        function finish(h, P, res, ep) {
            if (hp.get(h) !== P || P.st !== 'pend' || ep !== epoch) return;
            const t = E.now();
            // 页面冻过(心跳 >6 秒没跑 / 这一轮比超时还久 5 秒以上 —— 睡眠、后台冻结):结论作废,在等的全部重来
            if (t - lastBeat > CV_FREEZE_MS + CV_BEAT_MS || t - P.t0 > CV_PROBE_MS + CV_FREEZE_MS) { freeze(); return; }
            P.res = res; P.t1 = t;
            if (res.target === 'down') glog.push({ t, h, up: false });
            else if (res.target === 'up') glog.push({ t, h, up: true });
            res.ups.forEach(x => glog.push({ t, h: x, up: true }));
            while (glog.length && (t - glog[0].t > CV_GUARD_MS || glog.length > 400)) glog.shift();
            const g = guard(t);
            if (!g) guardOn = false;
            const cls = coverClass(res, P.round);
            if (cls === 'amb') { P.st = 'wait2'; P.again = t + CV_ROUND2_MS; arm(P.again); return; }
            P.st = 'done'; P.cls = cls;
            // 记失败:down、对照通、不在「本机的问题」里(hosts.strike 自己再看本会话有没有成功过、两次隔没隔 60 秒、保险丝)
            if (res.target === 'down' && res.controlUp && !g && hosts.strike(h, P.url, t)) deadChanged();
            const ks = Array.from(P.cards), ss = Array.from(P.stalls);
            P.cards.clear(); P.stalls.clear();
            ss.forEach(el => stallDone(el, h, cls));
            ks.forEach(k => { const s = st.get(k); if (s && s.ph === 'probe') decide(k, s); });
        }
        // ---- 一张卡的地址这一轮都失败了(ph = 'probe'):按决策表走 ----
        function failedHosts(s) {
            const m = new Map();
            s.failed.forEach(u => { const h = hostOf(u); if (h && h !== 'self' && !m.has(h)) m.set(h, u); });
            return m;
        }
        function decide(k, s) {
            if (!s || s.ph !== 'probe') return;
            if (E.online() === false || E.hidden()) { setPh(k, s, 'wait', 'off'); return; }
            const fh = failedHosts(s);
            if (!fh.size) { pxDecide(k, s); return; }
            if (!s.vs) s.vs = new Map();
            let pend = false;
            fh.forEach((u, h) => {
                if (s.vs.has(h)) return;
                if (deadH(h)) { s.vs.set(h, 'host'); return; }   // 期间被记死了(服务器的表 / 本机):不用再探
                const v = verdict(h, u, k, null);
                if (v === 'pend') pend = true; else s.vs.set(h, v);
            });
            if (s.ph !== 'probe' || !s.vs) return;   // 探测当场有了结论、里面已经替这张卡判完了
            const vs = [];
            s.vs.forEach(v => vs.push(v));
            if (pend) vs.push('pend');
            const t = E.now();
            // 「本机的问题」只压 2 分钟(从这张卡第一次被它压着算;vs 是刚探的 / 30 秒内的结论):过了照表判(对照都不通 = 'net' 照旧不藏)
            const gOn = !pend && guard(t), gx = gOn && s.gw > 0 && t - s.gw >= CV_GUARD_MS;
            const v = coverVerdict({ online: true, hidden: false, vs, guard: gOn && !gx, retried: s.fr });
            if (v === 'pend') return;
            if (v === 'retry') { setPh(k, s, 'file'); s.px = false; retryQ.set(k, t + CV_RETRY_MS); arm(t + CV_RETRY_MS); return; }
            if (v === 'hide') {
                const hh = [];
                s.vs.forEach((c, h) => { if (c === 'host' || c === 'host2') hh.push(h); });
                hide(k, s, hh.length ? 'host' : 'file', hh);
                return;
            }
            if (v === 'guard') {
                if (!guardOn) { guardOn = true; E.log('2 分钟内 ≥' + CV_GUARD_N + ' 个图床连不上、连得上的不比它多 —— 像是本机网络(DNS / 代理)的问题,先不藏'); }
                if (!s.gw) s.gw = t;
                const due = s.gw + CV_GUARD_MS;
                if (!guardAt || due < guardAt) { guardAt = due; arm(due); }
            }
            setPh(k, s, 'wait', v);
        }
        // 被「本机的问题」压满 2 分钟的卡:重新成对探测一次(页面上没有别的图再加载、没人来 kick,也会到点再判)
        function reGuard(t) {
            let next = 0;
            Array.from(waitSet).forEach(k => {
                const s = st.get(k);
                if (!s || s.ph !== 'wait' || s.why !== 'guard' || !s.gw) return;
                const due = s.gw + CV_GUARD_MS;
                if (t < due) { if (!next || due < next) next = due; return; }
                setPh(k, s, 'probe');
                s.vs = null;
                decide(k, s);
            });
            if (next && (!guardAt || next < guardAt)) { guardAt = next; arm(next); }
        }
        // 封面代理(同源):先 3 秒后重试一次;还失败 → HEAD 那一张:404 / 410(或 2xx 但加载出来的是 1×1)→ 藏;别的(5xx / 断网)→ 以后再试
        function pxDecide(k, s) {
            const t = E.now();
            if (!s.pr) { setPh(k, s, 'file'); s.px = true; retryQ.set(k, t + CV_RETRY_MS); arm(t + CV_RETRY_MS); return; }
            const u = s.last, ep = epoch, gen = ++s.hg, tiny = s.kind[u] === 'tiny';
            if (!u || typeof E.head !== 'function') { setPh(k, s, 'wait', 'net'); return; }
            try {
                E.head(u, CV_PROBE_MS, (code) => {
                    if (st.get(k) !== s || s.ph !== 'probe' || s.hg !== gen) return;
                    if (ep !== epoch || E.now() - t > CV_PROBE_MS + CV_FREEZE_MS) { decide(k, s); return; }   // 中间冻过 / 断过网:重来
                    const c = Number(code) || 0;
                    if (c === 404 || c === 410 || (c >= 200 && c < 300 && tiny)) hide(k, s, 'proxy', []);
                    else setPh(k, s, 'wait', 'net');
                });
            } catch (e) { setPh(k, s, 'wait', 'net'); }
        }
        // 3 秒后的重试:断网 / 后台 → 等(不吃次数);卡片这会儿不在页面上(窗口化网格换块卸载了)→ 不吃次数,重新挂上时从头试
        function doRetry(k) {
            const s = st.get(k);
            if (!s || s.ph !== 'file') return;
            if (E.online() === false || E.hidden()) { setPh(k, s, 'wait', 'off'); return; }
            if (!attached(k)) { restart(k, s); return; }
            if (s.px) s.pr = true; else s.fr = true;
            restart(k, s);
        }
        // 等着的卡(网络问题 / 本机的问题 / 第二轮通了):之后有图加载出来就从头再试(每张卡至少隔 15 秒)
        function kick() {
            const t = E.now();
            let next = 0;
            Array.from(waitSet).forEach(k => {
                const s = st.get(k);
                if (!s || s.ph !== 'wait') { waitSet.delete(k); return; }
                if (s.why === 'off' || !(lastLoad > s.wt)) return;
                const due = s.at + CV_KICK_MS;
                if (t >= due) restart(k, s); else if (!next || due < next) next = due;
            });
            if (next && (!kickAt || next < kickAt)) { kickAt = next; arm(next); }
        }
        // ---- 卡住:在视口附近待满 30 秒还没结果 → 探它的图床 ----
        function stallCheck(el, r) {
            const h = hostOf(r.url);
            if (!h || h === 'self') { seenEls.delete(el); return; }
            if (E.online() === false) return;
            r.sp = true;
            const v = verdict(h, r.url, null, el);
            if (v !== 'pend') stallDone(el, h, v);
        }
        function stallDone(el, h, cls) {
            const r = recs.get(el);
            if (!r) return;
            r.sp = false;
            if (r.st || !r.url || hostOf(r.url) !== h) return;     // 这期间加载出来了 / 换了地址
            if (cls === 'host' || cls === 'host2') { fail(el, r, r.url, 'stall'); return; }
            // 'file' / 'keep'(图床回了 = 只是慢)/ 'net'(网络问题):不动它,2 分钟内不再为它探这个图床
            const t = E.now();
            stallOk.set(h, t + CV_STALL_OK_MS);
            if (stallOk.size > 300) stallOk.delete(stallOk.keys().next().value);
            arm(t + CV_STALL_OK_MS + 50);
        }
        // ---- 失败 / 成功 ----
        function setSrc(el, r, u) {
            r.url = u; r.st = 0; r.seen = 0; r.sp = false;
            seenEls.delete(el);
            try { if (el.setAttribute) el.setAttribute('src', u); else el.src = u; } catch (e) { }
            watchEl(el);
        }
        // 一个地址失败了(kind:err / tiny / stall):还有下一个地址就换;都失败了 → 判
        function fail(el, r, url, kind) {
            r.st = 2; r.sp = false; r.seen = 0;
            seenEls.delete(el);
            const k = r.key, s = sOf(k, true);
            if (s.ph === 'hid') return;
            if (s.ph && s.failed.has(url)) return;          // 这一轮已经在判了(同一张卡的另一个 <img> / 重新挂上的又报一次)
            if (s.ok === url) s.ok = '';
            if (!s.failed.has(url)) { s.failed.add(url); s.kind[url] = kind; }
            s.last = url;
            const next = current(r.item, s);
            if (next) { setSrc(el, r, next); return; }
            if (s.ph) return;
            setPh(k, s, 'probe');
            s.vs = null;
            decide(k, s);
        }
        function hide(k, s, why, hh) {
            setPh(k, s, 'hid');
            s.hw = why; s.hh = hh || []; s.vs = null; s.gw = 0;
            s.hh.forEach(h => { let ks = hidBy.get(h); if (!ks) hidBy.set(h, ks = new Set()); if (ks.size < 2000) ks.add(k); });
            stopPreview(k);
            changed();
        }
        // 这个图床有图加载出来了 / 复活了:因为连不上它藏掉的卡放回来(从头试)
        function reviveHost(h) {
            const ks = hidBy.get(h);
            if (!ks) return;
            hidBy.delete(h);
            let any = false;
            ks.forEach(k => { const s = st.get(k); if (s && s.ph === 'hid' && s.hh.indexOf(h) >= 0) { restart(k, s); any = true; } });
            if (any) changed();
        }
        function noteOkPic(it, url) {
            const ks = [];
            if (it && typeof it._wk === 'string' && it._wk) ks.push('w:' + it._wk);
            if (it && typeof it._pk === 'string' && it._pk) ks.push('p:' + it._pk);
            ks.forEach(x => { okPics.delete(x); okPics.set(x, url); });
            while (okPics.size > 500) okPics.delete(okPics.keys().next().value);
        }
        // 一张图真加载出来了(item = 登记过的目录卡片;没登记的 —— 继续观看 / 收藏 —— 只当对照、只让等着的卡再试,
        //   不算「图床成功过」:可能是缓存里出来的)
        function noteSuccess(h, url, item) {
            const t = E.now();
            lastLoad = t;
            if (h && h !== 'self') {
                okHosts.delete(h); okHosts.set(h, { u: url, t });
                if (okHosts.size > 100) okHosts.delete(okHosts.keys().next().value);
            }
            if (item && h) {
                if (hosts.ok(h)) changed();             // 当它死了的图床本会话不当死了:用它的卡片重新出现
                if (h !== 'self' && hosts.marked(h)) {  // 本机记过它死:后台 no-store 探一下,通了才删记录
                    samples.set(h, url);
                    if (!recheckAt || recheckAt > t + 1000) { recheckAt = t + 1000; arm(recheckAt); }
                }
                if (h !== 'self') reviveHost(h);
                noteOkPic(item, url);
            }
            if (waitSet.size && (!kickAt || kickAt > t)) { kickAt = t; arm(t); }
        }
        // 到点在后台探一下本机记死的图床(一次最多 4 个;no-store,缓存冒充不了):up → 删记录,它的卡片放回来
        function recheck(t) {
            if (!samples.size) return;
            if (E.online() === false || E.hidden()) { recheckAt = t + CV_RECHECK_FIRST; arm(recheckAt); return; }
            let n = 0;
            samples.forEach((u, h) => {
                if (!hosts.marked(h)) { samples.delete(h); return; }
                if (n >= 4) return;
                n++;
                const ep = epoch;
                probeOnce(u, (v) => {
                    if (ep !== epoch || v !== 'up' || !hosts.revive(h)) return;
                    samples.delete(h);
                    reviveHost(h);
                    changed();
                });
            });
            if (samples.size) { recheckAt = t + CV_RECHECK_MS; arm(recheckAt); }
        }
        // 正在预览(悬停 / 长按)的卡片要被拿掉:先停预览(卡片卸载之后 preview.js 收不到离开事件,视频会接着拉分片)
        function stopPreview(k) {
            const P = root.dgAdultPreview, set = byKey.get(k);
            if (!P || typeof P.stop !== 'function' || !set) return;
            set.forEach(el => {
                try {
                    const card = el.closest ? el.closest('[data-wk]') : null;
                    if (!card) return;
                    let on = !!(card.classList && card.classList.contains('dg-pv-on'));
                    if (!on && card.matches) { try { on = card.matches(':hover'); } catch (e) { on = false; } }
                    if (on) P.stop('cover-hidden');
                } catch (e) { }
            });
        }
        // 每批生效时:正在预览 / 悬停等着开预览的那张卡,作品这一批不出了(图床被记死 / 服务器的表变了也会让卡片消失,不经过 hide)→ 先停;
        //   重渲染之后那张卡的元素脱离了文档(跨块挪位被重建)→ 也停(preview.js 在脱离文档的元素上收不到离开事件,视频会接着拉分片)
        function pvCards(S) { return (Array.isArray(S.list) ? S.list.map(c => c && c.el) : [S.cur && S.cur.el]).concat([S.hoverEl, S.pressEl]).filter(Boolean); }
        function pvCheck() {
            const P = root.dgAdultPreview, S = P && P._state;
            if (!P || typeof P.stop !== 'function' || !S || !(S.cur || S.timer)) return;
            const cs = pvCards(S);
            for (const c of cs) {
                try {
                    const im = c.querySelector ? c.querySelector('img') : null, r = im ? recs.get(im) : null;
                    if (r && !visible(r.item)) { P.stop('cover-hidden'); return; }
                } catch (e) { }
            }
            if (!cs.length) return;
            setTimeout(() => {
                try {
                    const S2 = P._state;
                    if (S2 && (S2.cur || S2.timer) && pvCards(S2).some(c => c.isConnected === false)) P.stop('cover-hidden');
                } catch (e) { }
            }, 0);
        }
        // 图床被记死 / 服务器的表变了:已挂着、还在加载的图当前地址在死图床上 → 就地换下一个(没有了 → 下一批生效时整张卡藏掉)
        function deadChanged() {
            for (const el of Array.from(els)) {
                const r = recs.get(el);
                if (!r || r.st === 1 || !r.url || isData(r.url) || !deadH(hostOf(r.url))) continue;
                const u = current(r.item, st.get(r.key));
                if (u && u !== r.url) setSrc(el, r, u);
            }
            changed();
        }
        // ---- 在视口附近(±200px,比浏览器懒加载的距离近:进来了就一定在加载)的时长 ----
        function ensureIO() {
            if (io) return io;
            const Ctor = E.IO();
            if (!Ctor) return null;
            try { io = new Ctor((es) => onIO(es), { rootMargin: '200px 0px 200px 0px' }); } catch (e) { io = null; }
            return io;
        }
        //   (已经在观察的元素再 observe 不会再回调:换了地址时按上次知道的「在不在视口附近」直接重新起表)
        function watchEl(el) {
            const r = recs.get(el), h = r ? hostOf(r.url) : '';
            if (!r) return;
            if (!h || h === 'self' || r.st) { r.seen = 0; seenEls.delete(el); return; }
            if (r.obs) { if (r.vis && !r.seen) { r.seen = E.now(); seenEls.add(el); arm(r.seen + CV_STALL_MS + 50); } return; }
            const I = ensureIO();
            if (I) { try { I.observe(el); r.obs = true; } catch (e) { } }
        }
        function unwatch(el, r) {
            if (r && r.obs && io) { try { io.unobserve(el); } catch (e) { } }
            if (r) { r.obs = false; r.vis = false; r.seen = 0; r.sp = false; }
            seenEls.delete(el);
        }
        function onIO(es) {
            const t = E.now();
            for (const en of es || []) {
                const el = en && en.target, r = el ? recs.get(el) : null;
                if (!r) { try { if (io && el) io.unobserve(el); } catch (e) { } continue; }
                r.vis = !!en.isIntersecting;
                if (r.st) continue;
                if (r.vis) { if (!r.seen) { r.seen = t; seenEls.add(el); arm(t + CV_STALL_MS + 50); } }
                else { r.seen = 0; r.sp = false; seenEls.delete(el); }
            }
        }
        // 文档级 load(捕获阶段):返回 false = 太小(1×1 之类)当失败,调用方拦住事件(模板不加 loaded,不显示)
        function onLoad(el) {
            const url = attr(el);
            if (!url || isData(url)) return true;
            const h = hostOf(url);
            const big = (Number(el.naturalWidth) || 0) >= CV_MIN && (Number(el.naturalHeight) || 0) >= CV_MIN;
            const r = recs.get(el);
            if (!r) { if (big && h) noteSuccess(h, url, null); return true; }
            if (url !== r.url) { r.url = url; r.st = 0; }
            if (!big) { fail(el, r, url, 'tiny'); return false; }
            if (r.st === 1) return true;    // 同一张又报一次(Vue 重渲染把同一个 src 再设一遍,浏览器从缓存里再发 load)
            r.st = 1;
            unwatch(el, r);
            // 加载出来的不是第一个地址(主封面在死图床上被跳过 / 换过 alt)→ 记下这张:图床后来复活了也不换回去(已经加载好的不再闪一次)
            const L0 = parsed(r.item);
            const s = st.get(r.key) || (L0.length && L0[0].u !== url ? sOf(r.key, true) : null);
            if (s) {
                const was = s.ph;
                s.ok = url;
                s.gw = 0;
                s.failed.delete(url);
                if (was) { setPh(r.key, s, ''); s.vs = null; s.hh = []; if (was === 'hid') changed(); }   // 判了藏还没生效它自己加载出来了:照常出
            }
            noteSuccess(h, url, r.item);
            return true;
        }
        // 文档级 error:返回 true = 是登记过的目录封面(已处理)
        function onError(el) {
            const r = recs.get(el);
            if (!r) return false;
            const url = attr(el);
            if (!url || isData(url)) return true;      // 占位图 / 清空 src 的那一下
            if (r.st === 2 && r.url === url) return true;
            if (url !== r.url) r.url = url;
            fail(el, r, url, 'err');
            return true;
        }
        // 指令:登记 / 更新 / 撤掉。卸载(窗口化网格换块)只撤 <img>,卡片的状态留着:重新挂上按最新状态出地址
        function attach(el, it) {
            if (!el) return;
            const k = keyOf(it);
            if (!k) { detach(el); return; }
            const url = attr(el);
            let r = recs.get(el);
            if (!r || r.key !== k) {
                if (r) detach(el);
                r = { key: k, item: it, url, st: 0, seen: 0, sp: false, obs: false, vis: false };
                recs.set(el, r); els.add(el);
                let set = byKey.get(k);
                if (!set) byKey.set(k, set = new Set());
                set.add(el);
                if (url && !isData(url)) watchEl(el);
                return;
            }
            r.item = it;
            if (url !== r.url) { r.url = url; r.st = 0; r.seen = 0; r.sp = false; seenEls.delete(el); if (url && !isData(url)) watchEl(el); }
        }
        function detach(el) {
            const r = recs.get(el);
            if (!r) return;
            unwatch(el, r);
            recs.delete(el); els.delete(el);
            const set = byKey.get(r.key);
            if (set) { set.delete(el); if (!set.size) byKey.delete(r.key); }
        }
        Object.assign(C, {
            attach, detach, onLoad, onError, visible, src, cands,
            // 网回来了:之前的探测作废,在等 / 在探的从头再试(不算次数)
            online() { bump(); restartWaiting(true); Array.from(probeSet).forEach(k => { const s = st.get(k); if (s) restart(k, s); }); },
            offline() { bump(); reDecide(); },
            // 页面切到后台(在探的作废、等回来)/ 回到前台(等着回来的从头再试、在探的重新探);resume = bfcache 恢复 / 冻结后恢复
            visibility(hiddenNow) { bump(); if (!hiddenNow) restartWaiting(false); reDecide(); },
            resume() { bump(); restartWaiting(false); reDecide(); },
            setServerDead(list) { if (hosts.setServer(list)) deadChanged(); },
            deadHosts: () => hosts.dead(),
            isDeadHost: (h) => hosts.isDead(String(h || '').toLowerCase()),
            hostOk: (h) => hosts.hostOk(h),
            // 收藏用:这部作品(作品键)/ 这组搜索结果(海报键)真加载出来的那张封面;没有 → ''
            okPic(wk, pk) { return (wk && okPics.get('w:' + wk)) || (pk && okPics.get('p:' + pk)) || ''; },
            ver: () => rxs().v,
            listen(fn) { if (typeof fn !== 'function') return () => { }; subs.add(fn); return () => { subs.delete(fn); }; },
            state(k) { const s = st.get(k); return s ? { ph: s.ph, why: s.why, failed: Array.from(s.failed), fr: s.fr, pr: s.pr, hw: s.hw, hh: s.hh.slice(), ok: s.ok, vs: s.vs ? Array.from(s.vs.entries()) : null } : null; },
            stats() {
                const H = {};
                hp.forEach((P, h) => { H[h] = P.st === 'done' ? P.cls : P.st + (P.round === 2 ? '2' : ''); });
                return { epoch, inflight, probes: nProbe, hp: H, queued: pq.length, probing: probeSet.size, waiting: waitSet.size, retry: retryQ.size, seen: seenEls.size, els: els.size,
                    armed: !!T, dueAt, guard: guard(E.now()), okHosts: Array.from(okHosts.keys()), samples: samples.size, recheckAt, mem: hosts.mem() };
            },
            _run: run, _flush() { applyAt = 0; flush(); }, _rec: (el) => recs.get(el) || null,
            _reset(over) { init(over); },
        });
        return C;
    }
    const covers = makeCovers();
    // <img v-dg-cv="卡片">:根组件(首页行 / 搜索联想)、网格、相关推荐都注册这个指令
    const cvDirective = {
        mounted(el, b) { covers.attach(el, b.value); },
        updated(el, b) { covers.attach(el, b.value); },
        beforeUnmount(el) { covers.detach(el); },
    };
    // 焦点保持(遥控器 / 键盘):藏卡之前记下焦点在哪一组(groupSel 上的 groupAttr)的哪张卡(cardSel 上的 idAttr)、它后面 / 前面各几张是谁;
    //   重渲染后焦点丢了(那张被拿掉 → 落回 body)→ 还给同一张卡;它没了 → 原来紧跟在它后面、还留着的那张(没有就往前找)
    const FOCUS_NB = 60;
    function neighborIds(ids, i) {
        const out = [];
        if (i < 0) return out;
        for (let j = i + 1; j < ids.length && j <= i + FOCUS_NB; j++) out.push(ids[j]);
        for (let j = i - 1; j >= 0 && j >= i - FOCUS_NB; j--) out.push(ids[j]);
        return out;
    }
    function focusMark(scope, groupSel, groupAttr, cardSel, idAttr) {
        try {
            const d = root.document, ae = d && d.activeElement;
            if (!ae || !scope || !scope.contains || !scope.contains(ae) || !ae.closest) return null;
            const card = ae.closest(cardSel), grp = card && card.closest ? card.closest(groupSel) : null;
            if (!card || !grp) return null;
            const cards = Array.prototype.slice.call(grp.querySelectorAll(cardSel));
            const i = cards.indexOf(card);
            return { scope, groupSel, groupAttr, cardSel, idAttr, g: grp.getAttribute(groupAttr), id: card.getAttribute(idAttr), i, nb: neighborIds(cards.map(c => c.getAttribute(idAttr)), i) };
        } catch (e) { return null; }
    }
    function focusBack(m) {
        if (!m) return false;
        try {
            const d = root.document, ae = d.activeElement;
            if (ae && ae !== d.body && ae.isConnected !== false) return false;   // 焦点还在(或者用户自己挪走了)
            const grps = m.scope.querySelectorAll(m.groupSel);
            let grp = null;
            for (let j = 0; j < grps.length; j++) if (grps[j].getAttribute(m.groupAttr) === m.g) { grp = grps[j]; break; }
            const cards = grp ? grp.querySelectorAll(m.cardSel) : [];
            if (!cards.length) return false;
            const byId = new Map();
            for (let j = 0; j < cards.length; j++) { const id = cards[j].getAttribute(m.idAttr); if (id && !byId.has(id)) byId.set(id, cards[j]); }
            let el = byId.get(m.id) || null;
            for (let j = 0; !el && m.nb && j < m.nb.length; j++) el = byId.get(m.nb[j]) || null;
            if (!el) el = cards[Math.max(0, Math.min(m.i, cards.length - 1))];
            if (!el || typeof el.focus !== 'function') return false;
            el.focus({ preventScroll: true });
            return true;
        } catch (e) { return false; }
    }
    // 拿掉卡片时不让正在看的内容跳(Safari / iPadOS / 老电视 WebView 没有浏览器自己的滚动锚定)。
    //   网格(DgAdGrid)不滚:视口上面的改动先压着(见 hold);整段拿掉的(首页一整行 / 相关推荐一整排)改之前记下视口里最上面几块的位置,
    //   改完找第一块还在的,量它挪了多少再滚回去(浏览器已经自己锚定过的话量出来是 0,不会滚两次)。
    //   滚动容器:往上找第一个能滚的祖先(播放页覆盖层);没有 = 窗口。top / bottom = 它在视口里的上下沿
    function scrollerOf(el) {
        try {
            let n = el && el.parentElement;
            const d = root.document;
            while (n && n !== d.body && n !== d.documentElement) {
                const cs = root.getComputedStyle ? root.getComputedStyle(n) : null;
                if (cs && /(auto|scroll)/.test(String(cs.overflowY || '')) && n.scrollHeight > n.clientHeight) { const rc = n.getBoundingClientRect(); return { el: n, top: rc.top, bottom: rc.bottom }; }
                n = n.parentElement;
            }
        } catch (e) { }
        let vh = 0;
        try { vh = Number(root.innerHeight) || Number(root.document.documentElement.clientHeight) || 0; } catch (e) { vh = 0; }
        return { el: null, top: 0, bottom: vh > 0 ? vh : 800 };
    }
    // 瞬间滚 dy(全站 html{scroll-behavior:smooth} 会把它拖成动画)
    function jumpBy(sc, dy) {
        try {
            if (sc && sc.el) { const s = sc.el.style, prev = s.scrollBehavior; s.scrollBehavior = 'auto'; sc.el.scrollTop += dy; s.scrollBehavior = prev; return; }
            const s = root.document.documentElement.style, prev = s.scrollBehavior;
            s.scrollBehavior = 'auto';
            root.scrollTo(0, Math.max(0, (Number(root.scrollY) || Number(root.pageYOffset) || 0) + dy));
            s.scrollBehavior = prev;
        } catch (e) { }
    }
    // 记:scope 里 cardSel 的块(idAttr 认),视口里最上面 ≤24 块的 top;scope 的顶在视口里 / 下面(前面没有能被拿掉的)→ null
    function anchorMark(scope, cardSel, idAttr) {
        try {
            if (!scope || !scope.querySelectorAll || !scope.getBoundingClientRect) return null;
            const sc = scrollerOf(scope);
            const vt = sc.top;
            if (!(scope.getBoundingClientRect().top < vt)) return null;
            const cards = scope.querySelectorAll(cardSel), list = [];
            for (let i = 0; i < cards.length && list.length < 24; i++) {
                const rc = cards[i].getBoundingClientRect();
                if (!(rc.height > 0 || rc.width > 0) || rc.bottom <= vt + 1) continue;
                list.push({ id: cards[i].getAttribute(idAttr), top: rc.top });
            }
            return list.length ? { sc, scope, cardSel, idAttr, list } : null;
        } catch (e) { return null; }
    }
    function anchorBack(a) {
        if (!a) return 0;
        try {
            const cards = a.scope.querySelectorAll(a.cardSel), byId = new Map();
            for (let i = 0; i < cards.length; i++) { const id = cards[i].getAttribute(a.idAttr); if (id && !byId.has(id)) byId.set(id, cards[i]); }
            for (const x of a.list) {
                const c = byId.get(x.id);
                if (!c) continue;
                const dy = c.getBoundingClientRect().top - x.top;
                if (Math.abs(dy) >= 1) { jumpBy(a.sc, dy); return dy; }
                return 0;
            }
        } catch (e) { }
        return 0;
    }
    // 横排(首页收起状态的 .hot-row / 相关推荐的 .dg-rail-row)滚过了的:改之前记下每排最左边露出来的几张卡的 left;
    //   改完(左边视口外的卡没了 → 后面的往左挪)找第一张还在的,补 scrollLeft,露出来的那几张不动
    function rowMark(scope, groupSel, groupAttr, rowSel, cardSel, idAttr) {
        const out = [];
        try {
            if (!scope || !scope.querySelectorAll) return null;
            const gs = scope.querySelectorAll(groupSel);
            for (let i = 0; i < gs.length; i++) {
                const row = gs[i].querySelector(rowSel);
                if (!row || !(row.scrollLeft > 0)) continue;
                const left0 = row.getBoundingClientRect().left;
                const cards = row.querySelectorAll(cardSel), list = [];
                for (let j = 0; j < cards.length && list.length < 12; j++) {
                    const rc = cards[j].getBoundingClientRect();
                    if (rc.right <= left0 + 1) continue;
                    list.push({ id: cards[j].getAttribute(idAttr), left: rc.left });
                }
                if (list.length) out.push({ g: gs[i].getAttribute(groupAttr), list });
            }
        } catch (e) { }
        return out.length ? { scope, groupSel, groupAttr, rowSel, cardSel, idAttr, out } : null;
    }
    function rowBack(m) {
        if (!m) return;
        m.out.forEach(x => {
            try {
                let grp = null;
                const gs = m.scope.querySelectorAll(m.groupSel);
                for (let i = 0; i < gs.length; i++) if (gs[i].getAttribute(m.groupAttr) === x.g) { grp = gs[i]; break; }
                const row = grp && grp.querySelector(m.rowSel);
                if (!row) return;
                const cards = row.querySelectorAll(m.cardSel), byId = new Map();
                for (let j = 0; j < cards.length; j++) byId.set(cards[j].getAttribute(m.idAttr), cards[j]);
                for (const a of x.list) {
                    const c = byId.get(a.id);
                    if (!c) continue;
                    const dx = c.getBoundingClientRect().left - a.left;
                    if (Math.abs(dx) >= 1) { const s = row.style, prev = s.scrollBehavior; s.scrollBehavior = 'auto'; row.scrollLeft += dx; s.scrollBehavior = prev; }
                    break;
                }
            } catch (e) { }
        });
    }

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

    // ========== 混合内容:红楼系 CDN 的 http 分片升 https ==========
    //   清单里写的是 http://vfile.meituan.net/…(https 也能用,实测 56/56);https 页面上浏览器拦 http 的 XHR → hls.js 拿到 status 0、
    //   整条判「放不了」(刷短片开头约七成是这个源)。主播放器 / 刷短片 / 预览都是 hls.js 发 XHR → 在 XMLHttpRequest.open 这一层统一改 https
    //   (只认这几个主机;Worker 也做同样的改写,管 iPhone 原生 HLS)
    const HTTPS_UPGRADE_HOSTS = ['vfile.meituan.net'];
    function upgradeMixed(u) {
        const s = String(u || '');
        const m = /^http:\/\/([^\/?#:]+)/i.exec(s);
        if (!m) return s;
        const h = m[1].toLowerCase();
        return HTTPS_UPGRADE_HOSTS.some(x => h === x || h.endsWith('.' + x)) ? 'https://' + s.slice(7) : s;
    }
    (function patchXhrOpen() {
        try {
            if (!root.location || root.location.protocol !== 'https:' || !root.XMLHttpRequest) return;
            const P = root.XMLHttpRequest.prototype;
            if (!P || P.__dgUpgrade) return;
            const open0 = P.open;
            P.open = function (method, url) {
                const a = Array.prototype.slice.call(arguments);
                if (typeof url === 'string' && url.charCodeAt(4) === 58) a[1] = upgradeMixed(url);   // 只看 "http:" 开头的
                return open0.apply(this, a);
            };
            P.__dgUpgrade = true;
        } catch (e) { }
    })();

    // ========== 站名字标 ==========
    // MEI.NU 的字标是自己画的线条(SVG,不加载任何外部字体 —— Google Fonts 在国内打不开):
    //   M:两侧竖线中段往外凸(胸部轮廓)、顶上两个角是圆肩;后面「ei.nu」用同一支笔画的圆弧小写(n 的圆拱 = M 的圆肩)。
    //   M 只和大写字母一样高(不当大图标);M 和点是红的,其余字跟 currentColor(.dg-wm 默认白)。局部坐标:大写高 y 8..94、小写 x 高 y 40..94
    const wordmark = (function () {
        const SW = 8;
        const M = 'M22 94 L22 72 C22 65 10 67 10 55 C10 44 22 39 22 29 L22 20 C22 10 28 6 33 13 L50 56 L67 13 C72 6 78 10 78 20 L78 29 C78 39 90 44 90 55 C90 67 78 65 78 72 L78 94';
        const TAIL = [   // [x 偏移, 路径]:e i n u
            [106, 'M6 68 H48 C48 51 38 40 26 40 C13 40 4 52 4 67 C4 83 14 94 27 94 C36 94 43 90 47 83'],
            [163, 'M4 42 V94 M4 20 h0'],
            [200, 'M4 40 V94 M4 64 C4 49 13 40 23 40 C34 40 42 49 42 62 V94'],
            [258, 'M4 40 V70 C4 85 13 94 23 94 C34 94 42 85 42 72 M42 40 V94'],
        ];
        const DOT = 186;   // 点和 i、n 都隔开一点(导航栏那么小时不糊成一团)
        const A = ' fill="none" stroke-linecap="round" stroke-linejoin="round"';
        const mPath = '<path d="' + M + '" stroke="#e50914" stroke-width="' + SW + '"' + A + '/>';
        // 整个「Mei.nu」
        const full = '<svg class="dg-wm" viewBox="5 4 300 96" aria-hidden="true" focusable="false">' + mPath +
            '<g stroke="currentColor" stroke-width="' + SW + '"' + A + '>' + TAIL.map((t) => '<path transform="translate(' + t[0] + ' 0)" d="' + t[1] + '"/>').join('') + '</g>' +
            '<path d="M' + DOT + ' 94 h0" stroke="#e50914" stroke-width="' + (SW * 1.4) + '"' + A + '/></svg>';
        // 只有 M(别的 M 开头站名:M 照画,后半截写字)
        const mOnly = '<svg class="dg-wm dg-wm-solo" viewBox="5 4 91 96" aria-hidden="true" focusable="false">' + mPath + '</svg>';
        return { full, mOnly, M, TAIL, DOT, SW };
    })();

    // ========== 站名 ==========
    const brand = (function () {
        const KEY = 'dg_site_name';
        const clean = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
        function name() { return clean(lsGet(KEY)) || DEFAULT_NAME; }
        // 图标就是一个「M」:站名以 M 开头时页面上的字只写后半截(图标 + EI.NU = MEI.NU),读屏照读全名;别的站名照写全名
        function tail(n) { const v = clean(n) || DEFAULT_NAME; return /^m./i.test(v) ? v.slice(1) : v; }
        // 页面上的站名(HTML):MEI.NU → 整个画好的字标;别的 M 开头 → 画的 M + 后半截文字;其余 → 文字(旁边显示 icon.png)
        function html(n) {
            const v = clean(n) || DEFAULT_NAME;
            if (v.toUpperCase() === 'MEI.NU') return wordmark.full;
            const tl = tail(v);
            return tl !== v ? wordmark.mOnly + '<span class="dg-wm-t">' + escHtml(tl) + '</span>' : escHtml(v);
        }
        function apply(n) {
            const v = clean(n) || DEFAULT_NAME;
            lsSet(KEY, v);
            if (typeof root.document === 'undefined') return v;
            try { root.document.title = v; } catch (e) { }
            try {
                const tl = tail(v), h = html(v);
                root.document.querySelectorAll('[data-dg-brand]').forEach(el => {
                    if (el.innerHTML !== h) el.innerHTML = h;
                    el.setAttribute('aria-label', v);
                });
                if (root.document.documentElement && root.document.documentElement.classList) root.document.documentElement.classList.toggle('dg-logo-full', tl === v);
                const m = root.document.querySelector('meta[name="apple-mobile-web-app-title"]');
                if (m) m.setAttribute('content', v);
            } catch (e) { }
            return v;
        }
        // 登录框的「购买套餐」按钮 / 套餐到期的续费链接:地址由服务器 /api/config purchase_url 给(默认主站的 ednovas.me,站长可配 PURCHASE_URL 换掉或关掉);
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
        // 续费提示(登录框里的 HTML 片段 / alert 文本);purchase_url 为空(站长关掉)→ 空(不提续费地址)
        function renewHtml() {
            const v = buyUrl();
            if (!v) return '';
            let host = v;
            try { host = new URL(v).host; } catch (e) { }
            return '<br>请前往 <a href="' + escHtml(v) + '" target="_blank" rel="noopener noreferrer" style="color:#ff6b6b;text-decoration:underline;">' + escHtml(host) + '</a> 续费';
        }
        function renewText() { const v = buyUrl(); return v ? '\n\n前往续费: ' + v : ''; }
        return { KEY, name, apply, clean, tail, html, buyUrl, applyBuy, showBuy, renewHtml, renewText, safeUrl };
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
    // ========== 每部作品的链接 #/v/<码>(用户 2026-11-23:每个视频要有自己的网址、能分享)==========
    //   码由服务器发(POST /api/catalog/share,一部作品一个 10 位码),链接里不带片名(聊天软件里显示 / 预览的都是一串码);
    //   打开:GET /api/catalog/share/<码> → 作品键(作品键因为规则重扫变了时服务器按当时的片名找回)。?t=秒 = 从这一秒开始
    const SHARE_HASH_RE = /^#\/v\/([A-Za-z0-9]{8,16})(?:\?t=(\d{1,6}))?$/;
    const shareLinks = (function () {
        const codes = new Map(), wait = new Map();
        function code(wk) {
            if (typeof wk !== 'string' || !WK_RE.test(wk) || wk.length > 300) return Promise.resolve('');
            if (codes.has(wk)) return Promise.resolve(codes.get(wk));
            if (wait.has(wk)) return wait.get(wk);
            let p;
            try {
                p = Promise.resolve(root.fetch('/api/catalog/share', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wk }) }))
                    .then(r => (r && r.ok ? r.json() : null))
                    .then(d => { const c = d && typeof d.code === 'string' && /^[A-Za-z0-9]{8,16}$/.test(d.code) ? d.code : ''; if (c) { if (codes.size > 500) codes.clear(); codes.set(wk, c); } return c; })
                    .catch(() => '')
                    .then(c => { wait.delete(wk); return c; });
            } catch (e) { return Promise.resolve(''); }
            wait.set(wk, p);
            return p;
        }
        const known = (wk) => codes.get(wk) || '';
        function resolve(c) {
            if (typeof c !== 'string' || !/^[A-Za-z0-9]{8,16}$/.test(c)) return Promise.resolve('');
            return fetchJson('/api/catalog/share/' + c, 10000).then(d => (d && typeof d.wk === 'string' && WK_RE.test(d.wk) && d.wk.length <= 300 ? d.wk : ''));
        }
        const url = (c, t, origin) => (c ? (origin || '') + '/#/v/' + c + (t > 0 ? '?t=' + Math.floor(t) : '') : '');
        function parse(h) { const m = SHARE_HASH_RE.exec(String(h || '')); return m ? { code: m[1], t: m[2] ? Number(m[2]) : 0 } : null; }
        return { code, known, resolve, url, parse };
    })();
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
    // 悬停预览让不让路:同 mainBusy,但正片在放且前面已缓冲 ≥30 秒时不让(预览只要几 MB,抢不着它;相关推荐上悬停也能预览)
    function previewBusy() {
        try {
            if (root.adCut && typeof root.adCut.busy === 'function' && root.adCut.busy()) return true;
            if (root.afpOffline && root.afpOffline._busy) return true;
            const app = bridge.app;
            if (!app || !app.showDetail) return false;
            const v = root.document && root.document.querySelector('#dplayer video');
            if (!v || v.paused || v.ended) return false;
            const t = v.currentTime || 0, b = v.buffered;
            for (let k = 0; b && k < b.length; k++) if (b.start(k) <= t + 0.5 && b.end(k) > t) return b.end(k) - t < 30;
            return true;
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
    // 封面悬停预览总开关(只存本机;preview.js 读同一个键):'1' = 明确打开(系统开了「减少动态效果」也照播)/ '0' = 关 /
    //   没设过 = 默认开,但系统「减少动态效果」(Windows 关了动画效果时 Chrome 也这么报)时默认关
    const PV_KEY = 'dg_pv_on';
    const reducedMotion = () => { try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } };
    // 封面悬停预览:默认开(系统「减少动态效果」也开 —— 只在鼠标停在封面上时放、静音);设置里关了(dg_pv_on=0)才关
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
        // 分享(2026-11-23 起能分享:链接 #/v/<短码>):不是目录作品(没有短码可要)的播放页才藏「分享当前画面」入口
        'html:not(.dg-can-share) #dplayer .dplayer-frame-icon, html:not(.dg-can-share) #dplayer .dg-mob-row[data-dg="frame"], html:not(.dg-can-share) .fshare-entry { display: none !important; }',
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
        // 横版卡片(2026-11-22):目录封面抽样 400+ 张,按作品数加权约 90% 是横图(国产/欧美 16:9,番号整张封套 1.49),
        //   竖海报只集中在两个情色电影站和短视频分类。主站的 2:3 海报卡在这里会把横图裁成中间三分之一 → 全站卡片改 16:9,
        //   卡宽随之加大(桌面一排约 5 张,手机首页行一屏约 1.7 张、浏览网格 2 列);悬停预览的视频本来就是横的,正好铺满
        'html:root { --card-w: calc(clamp(210px, 17vw, 300px) * var(--ui-scale, 1)); }',
        '@media (max-width: 480px) { html:root { --card-w: calc(56vw * var(--ui-scale, 1)); } }',
        // 注意:这段样式在 <head> 里 adult.js 执行时就插入,排在 index.html 的大 <style> 之前 → 同优先级会被主站规则压掉,要加 html 前缀
        'html .poster-wrap { aspect-ratio: 16 / 9; }',
        '@media (max-width: 768px) { html .browse-grid { grid-template-columns: repeat(auto-fill, minmax(calc(200px * var(--ui-scale, 1)), 1fr)); } }',
        '@media (max-width: 480px) { html .browse-grid { grid-template-columns: repeat(auto-fill, minmax(calc(140px * var(--ui-scale, 1)), 1fr)); } }',
        // 用户 2026-11-24:设置里字号「大」「特大」(--ui-scale ≥ 1.15)时手机上一排一张(以前 140px×1.35≈189px,宽一点的手机照样塞两张)。
        //   (scale − 1.1) × 10000px:标准 / 小是负数 → 照旧 140px×scale 两列;大 / 特大 ≥ 500px → min(100%, …) = 一整行。
        //   老浏览器不认 min()/max() 时这条整条作废,落回上面那条(两列)
        '@media (max-width: 480px) { html .browse-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, max(calc(140px * var(--ui-scale, 1)), calc((var(--ui-scale, 1) - 1.1) * 10000px))), 1fr)); } }',
        // 主站给封面 <img> 铺了灰色渐变占位底(background-image),竖图 contain 后两侧会露出来盖住模糊底 → 去掉
        'html .poster-wrap img.dg-port { object-fit: contain; position: relative; z-index: 1; background: none; }',
        '.poster-wrap.dg-port-bg::before { content: ""; position: absolute; top: -12px; left: -12px; right: -12px; bottom: -12px; background: var(--dg-pbg, none) center / cover no-repeat; filter: blur(14px) brightness(0.5); z-index: 0; pointer-events: none; }',
        '.movie-date.dg-ad-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        // 登录框的购买引导:purchase_url 为空(站长配了 PURCHASE_URL=off)就不出(见 brand.showBuy;切登录方式时的行内 display 也压得住)
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
        '.dg-sug-row img { width: 64px; height: 36px; object-fit: cover; border-radius: 4px; flex: none; background: #262626; }',
        '.dg-home-note { margin: 28px auto 8px; max-width: 640px; padding: 14px 18px; border-radius: 10px; background: rgba(255,255,255,.05); color: #bbb; font-size: 14px; line-height: 1.6; text-align: center; }',
        '.dg-home-note code { color: #eee; background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 4px; }',
        '.dg-sug-row img.dg-port { object-fit: contain; }',
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
        // 导航栏的字标和「刷短片」按钮:大屏跟着屏宽长一点,也跟设置里的界面大小(--ui-scale)走
        //   (变量放在根上:导航栏下面的搜索框按它让位,见 index.html .search-section 的 marginTop)
        'html:root { --dg-nav-h: calc(clamp(40px, 2.3vw, 52px) * var(--ui-scale, 1)); }',
        '@media (max-width: 480px) { html:root { --dg-nav-h: calc(40px * var(--ui-scale, 1)); } }',
        '.dg-nav-feed { display: inline-flex; align-items: center; gap: calc(var(--dg-nav-h) * .18); height: var(--dg-nav-h); padding: 0 calc(var(--dg-nav-h) * .46); border-radius: calc(var(--dg-nav-h) / 2); border: 1px solid rgba(255, 255, 255, 0.3); background: rgba(0, 0, 0, 0.4); color: #fff; font-size: calc(var(--dg-nav-h) * .38); font-weight: 500; cursor: pointer; white-space: nowrap; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); transition: background .15s, border-color .15s; }',
        '.dg-nav-feed i { color: #ff4d55; font-size: 1.1em; }',
        '.dg-nav-feed:hover, .dg-nav-feed:focus-visible { border-color: #fff; background: rgba(229, 9, 20, 0.35); outline: none; }',
        '.dg-nav-feed:hover i, .dg-nav-feed:focus-visible i { color: #fff; }',
        '@media (max-width: 480px) { .dg-nav-feed span { display: none; } .dg-nav-feed { width: var(--dg-nav-h); padding: 0; justify-content: center; font-size: calc(var(--dg-nav-h) * .42); } }',
        // 偏好设置「首页分类行」:沿用首页板块的列表样式;今天没内容的行名字后面一行小字;自己加的行多一个删除;底下「添加分类」下拉
        '.dg-hr-note { display: block; font-size: 11px; color: #888; line-height: 1.3; margin-top: 1px; }',
        '.dg-hr-del { color: #ff8a8f; }',
        '.dg-hr-del:hover:not(:disabled) { background: rgba(229, 9, 20, 0.3) !important; color: #fff !important; }',
        '.dg-hr-add { display: flex; align-items: center; gap: 10px; margin-top: 10px; }',
        '.dg-hr-add select { flex: 1; min-width: 0; height: 38px; padding: 0 12px; border-radius: 8px; border: 1px dashed rgba(255, 255, 255, 0.28); background: rgba(255, 255, 255, 0.04); color: #eee; font-size: 14px; cursor: pointer; }',
        '.dg-hr-add select:hover:not(:disabled), .dg-hr-add select:focus-visible { border-color: #e50914; outline: none; }',
        '.dg-hr-add select:disabled { opacity: 0.5; cursor: default; }',
        '.dg-hr-add select option { background: #1b1b1b; color: #eee; }',
        '.dg-hr-cnt { flex: none; font-size: 12px; color: #999; }',
        // 手机上换行 + 最多两行 + 「展开」(DgFold):盖掉 index.html 里手机端 .cat-tabs / .browse-fopts 的「不换行、横滑、右边渐隐」
        '.dg-fold { display: block; min-width: 0; }',
        '.dg-fold-in { display: flex; flex-wrap: wrap; gap: 6px; }',
        '.dg-fold.cat-tabs .dg-fold-in { gap: 8px; }',
        '.browse-frow > .dg-fold { flex: 1 1 auto; }',
        '.dg-fold-btn { display: inline-flex; align-items: center; gap: 5px; margin-top: 8px; height: 32px; padding: 0 14px; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.06); color: #ddd; font-size: 13px; cursor: pointer; }',
        '.dg-fold-btn:hover, .dg-fold-btn:focus-visible { border-color: #e50914; color: #fff; outline: none; }',
        '@media (max-width: 768px) {'
        + ' .dg-fold.cat-tabs, .dg-fold.browse-fopts { display: block !important; overflow: visible !important; -webkit-mask-image: none !important; mask-image: none !important; padding: 0 !important; margin: 0 !important; }'
        + ' .dg-fold.cat-tabs .dg-fold-in { gap: 6px; }'
        + ' .dg-fold-shut .dg-fold-in { overflow: hidden; }'
        + ' .dg-fold-in > * { flex: none; }'
        + ' .dg-fold-in::after { content: none; }'
        + ' .browse-frow { align-items: flex-start; }'   // 换行之后「分类 / 标签」几个字对齐第一行,不在几行中间
        + ' }',
        '.dg-row-shuf { margin-right: 8px; }',
        '.dg-row-shuf i { margin-right: 3px; }',
        '.dg-row-shuf:disabled { opacity: .6; cursor: default; }',
        '@media (pointer: coarse) { .home-layout-mv { width: 38px; height: 38px; } .dg-hr-add select { height: 44px; } }',
        // 往下滚后搜索框缩进导航栏右侧:和导航栏同高、同一条中线,并让出「刷短片」按钮(以前会整个盖住它)
        'html .search-section { top: 15px; }',
        'html .search-box-wrapper.compact { height: var(--dg-nav-h, 40px); }',
        'html .search-box-wrapper.compact .search-input { height: 100%; }',
        'body:has(.dg-nav-feed) .search-box-wrapper.compact { margin-right: calc(var(--dg-nav-h, 40px) * 2.66 + 14px); }',
        '@media (max-width: 480px) { body:has(.dg-nav-feed) .search-box-wrapper.compact { margin-right: calc(var(--dg-nav-h, 40px) + 10px); max-width: calc(100% - var(--dg-nav-h, 40px) * 3.81 - 32px); } }',
        // 站名:画好的字标(M 本身就是标志,旁边不再放 icon.png;站名不是 M 开头时 html.dg-logo-full 把图标放回来)
        'html:not(.dg-logo-full) .brand > img, html:not(.dg-logo-full) .loader-logo > img, html:not(.dg-logo-full) .password-logo-text > img { display: none !important; }',
        '.dg-wm { display: inline-block; height: 1em; width: auto; vertical-align: middle; overflow: visible; color: #fff; }',
        '.dg-wm-solo { margin-right: .06em; }',
        '.brand .dg-wm { height: calc(var(--dg-nav-h, 40px) * .9); filter: drop-shadow(0 2px 6px rgba(0, 0, 0, .55)); }',
        '.loader-logo [data-dg-brand], .password-logo-text [data-dg-brand] { display: inline-flex; align-items: center; color: #e50914; font-weight: 800; letter-spacing: 1px; }',
        '.loader-logo .dg-wm, .password-logo-text .dg-wm { height: 1.1em; }',
        '[data-dg-brand], .brand > span { line-height: 1; }',
        '.dg-rails { margin-top: 18px; }',
        '.dg-rail { margin-top: 14px; }',
        '.dg-rail-t { display: flex; align-items: center; gap: 8px; color: #eee; font-size: 16px; font-weight: 600; margin: 0 0 8px; }',
        '.dg-rail-t > i { color: #e50914; font-size: 14px; }',
        '.dg-rail-acts { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; }',
        '.dg-rail-all, .dg-rail-x { background: none; border: 0; color: #aaa; font-size: 13px; cursor: pointer; padding: 4px 6px; }',
        '.dg-rail-x:hover, .dg-rail-x:focus { color: #fff; }',
        // 左右箭头(只在有鼠标的设备上;手机横滑)/ 展开 = 换行成网格
        '.dg-rail-box { position: relative; }',
        '.dg-rail-nav { position: absolute; top: calc(50% - 30px); z-index: 2; width: 38px; height: 38px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.18); background: rgba(20,20,20,0.82); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(0,0,0,0.5); opacity: 0; transition: opacity .15s; }',
        '.dg-rail-nav.dg-l { left: -6px; } .dg-rail-nav.dg-r { right: -6px; }',
        '.dg-rail-box:hover .dg-rail-nav, .dg-rail-nav:focus-visible { opacity: 1; }',
        '.dg-rail-nav:hover { background: #e50914; border-color: #e50914; }',
        '@media (hover: none) { .dg-rail-nav { display: none; } }',
        '.dg-rail-row.dg-open { flex-wrap: wrap; overflow-x: visible; row-gap: 14px; }',
        '.dg-rail-all:hover, .dg-rail-all:focus { color: #fff; }',
        '.dg-rail-row { display: flex; gap: 12px; overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; padding: 2px 2px 10px; scrollbar-width: thin; }',
        '.dg-rail-card { flex: none; width: calc(var(--card-w, 150px) * 0.86); cursor: pointer; }',
        '.dg-rail-card .poster-wrap { position: relative; border-radius: 8px; overflow: hidden; }',
        '.dg-rail-card .movie-name { font-size: 13px; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.dg-rail-card:focus { outline: 3px solid #fff; outline-offset: 2px; }',
        '.dg-acts { padding: 8px 0 30px; }',
        '.dg-acts-q { max-width: 420px; }',
        '.dg-acts-sec { margin: 16px 0 6px; }',
        '.dg-cloud-links { display: flex; justify-content: flex-end; gap: 8px; margin: 0 0 4px; }',
        // 浏览页里就地展开的「全部标签」:选中 = 红字,排除 = 删除线
        '.dg-cloud.dg-cloud-in { padding: 2px 0 12px; margin: 0 0 6px; border-bottom: 1px solid rgba(255,255,255,0.06); }',
        '.dg-cloud-in .dg-cloud-g { margin: 10px 0 4px; }',
        '.dg-cloud-in .dg-cloud-links { justify-content: flex-start; margin: 10px 0 0; }',
        '.dg-cloud-t.active { color: #ff5a4f; } .dg-cloud-t.dg-x { color: #777; text-decoration: line-through; }',
        '.dg-act-head { margin: 0 0 4px; }',
        '.dg-act-name { color: #fff; font-size: 18px; font-weight: 700; margin: 0 0 4px; }',
        '.dg-act-idx { margin-left: 10px; background: none; border: 0; padding: 0; color: #ff8a80; font-size: 12px; cursor: pointer; }',
        '.dg-set-ext:empty { display: none; }',
        // 封面上长按预览时不弹系统菜单(iOS 存图 / 安卓长按菜单)
        '.hot-card .poster-wrap img, .browse-card .poster-wrap img, .dg-rail-card .poster-wrap img { -webkit-touch-callout: none; }',
        // 封面加载不出来藏掉的卡片:浏览 / 搜索网格底下一行「已隐藏 N 部 · 显示」(首页行 / 相关推荐不提示;搜索联想开着时不删行,下次重算才拿掉)。
        //   点了「显示」焦点没地方去时落在网格本身(tabindex=-1),不画框
        '.dg-cv-note { margin: 14px 0 4px; color: #888; font-size: 12px; text-align: center; }',
        '.dg-grid:focus { outline: none; }',
        '.dg-cv-show { background: none; border: 0; padding: 2px 6px; color: #ff8a80; font-size: 12px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }',
        '.dg-cv-show:hover, .dg-cv-show:focus { color: #fff; outline: none; }',
        'body.tv-mode .dg-cv-show:focus { outline: 2px solid #fff; outline-offset: 2px; }',
    ].join('\n');
    function injectCss() {
        const d = root.document;
        if (!d || d.getElementById('dg-adult-css')) return;
        const s = d.createElement('style');
        s.id = 'dg-adult-css';
        s.textContent = CSS;
        (d.head || d.documentElement).appendChild(s);
    }
    // 封面加载完按宽高比:竖图 → contain,父级 .poster-wrap 用同一张图模糊铺底。
    //   铺底走 CSS 变量里的 url():页面有 <meta name="referrer" content="no-referrer">,和 <img> 一样不带来源,同一 URL 命中缓存不再下载
    function shapeCover(img) {
        const src = String(img.currentSrc || img.src || '');
        const port = isPortrait(img.naturalWidth, img.naturalHeight) && !/^data:/i.test(src);
        img.classList.toggle('dg-port', port);
        const wrap = img.parentElement;
        if (!wrap || !wrap.classList || !wrap.classList.contains('poster-wrap')) return;
        if (port) {
            wrap.style.setProperty('--dg-pbg', 'url("' + src.replace(/["\\\r\n]/g, (c) => encodeURIComponent(c)) + '")');
            wrap.classList.add('dg-port-bg');
        } else if (wrap.classList.contains('dg-port-bg')) {
            wrap.classList.remove('dg-port-bg');
            wrap.style.removeProperty('--dg-pbg');
        }
    }
    // 首页行 / 浏览页的海报:目录卡片(v-dg-cv 登记过的)交给封面控制器(换备用地址 / 藏 / 等网络);别的坏图换中性占位(不走 TMDB)
    function hookImages() {
        const d = root.document;
        const inCard = (img) => img && img.tagName === 'IMG' && img.closest && img.closest('.hot-card .poster-wrap, .browse-card .poster-wrap, .dg-sug-row');
        // 竖图判定覆盖所有封面框(首页行 / 浏览网格 / 继续观看 / 收藏 / 相关推荐 / 搜索联想);坏图换占位只管原来那几处
        const shaped = (img) => img && img.tagName === 'IMG' && img.closest && img.closest('.poster-wrap, .dg-sug-row');
        d.addEventListener('load', (e) => {
            const img = e.target;
            if (!img || img.tagName !== 'IMG') return;
            // 1×1 之类的小图 = 失败:拦住事件,模板的 @load 不加 loaded(不显示),控制器换下一个地址 / 藏
            if (covers.onLoad(img) === false) { try { e.stopPropagation(); } catch (x) { } return; }
            if (shaped(img)) shapeCover(img);
        }, true);
        d.addEventListener('error', (e) => {
            const img = e.target;
            if (!img || img.tagName !== 'IMG' || covers.onError(img)) return;
            if (!inCard(img) || img.getAttribute('data-dg-fb') === '1') return;
            img.setAttribute('data-dg-fb', '1');
            img.src = PLACEHOLDER;
        }, true);
        // 断网 / 页面在后台时不探、不藏;网回来了 / 切回前台从头再试。断网 / 联网 / 切前后台 / bfcache 恢复 / 冻结后恢复:在路上的探测作废重来,卡住的表重新起
        try {
            root.addEventListener('online', () => covers.online());
            root.addEventListener('offline', () => covers.offline());
            root.addEventListener('pageshow', (e) => { if (e && e.persisted) covers.resume(); });
            d.addEventListener('visibilitychange', () => covers.visibility(d.hidden === true));
            d.addEventListener('resume', () => covers.resume());
        } catch (e) { }
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
        // DOMContentLoaded 时 defer 的 privacy.js 已经跑过:把本机记死图床的键登记给它(无痕拦截 / 一键清除都认,哪怕这次会话还没写过)
        try {
            root.document.addEventListener('DOMContentLoaded', () => {
                brand.apply(brand.name()); brand.showBuy();
                try { const P = root.dgPrivacy; if (P && typeof P.registerKeys === 'function') P.registerKeys({ keys: [CV_KEY] }); } catch (e) { }
            }, { once: true });
        } catch (e) { }
        auth.install();
        hookImages();
        hooks.install();      // [adult] p4:window.dgAdultHooks(先于 defer 的扩展模块)
        hookCardHover();
        // 登录框比 Vue 应用先出来:年龄确认之后单独拿一次 /api/config(站名、购买地址),不等应用启动
        ageGate.whenAccepted().then(() => fetchJson('/api/config', 8000)).then(c => {
            if (!c || typeof c !== 'object') return;
            if (c.site_name) brand.apply(c.site_name);
            brand.applyBuy(c.purchase_url);
            covers.setServerDead(c.cover_dead_hosts);   // 死图床表尽早到(首页行到之前就能先筛)
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
        // 与 CSS 的横版卡宽一致:桌面 clamp(210px, 17vw, 300px),平板 200,手机 140(只是首帧估计,渲染后按实测列数重分块)
        let min = Math.min(300, Math.max(210, W * 0.17)), gap = 16, pad = 0.10;
        if (W <= 480) { min = 140; gap = 10; pad = 0.08; } else if (W <= 768) { min = 200; gap = 10; pad = 0.08; }
        let s = 1;
        try { s = parseFloat(root.getComputedStyle(root.document.documentElement).getPropertyValue('--ui-scale')) || 1; } catch (e) { s = 1; }
        if (W <= 480 && s >= 1.1) return 1;   // 字号大 / 特大:手机一排一张(和 CSS 同一条)
        return Math.max(W <= 480 ? 1 : 2, Math.floor((W * (1 - pad) + gap) / (min * s + gap)));
    }
    const onImgLoad = (e) => { const t = e && e.target; if (t) { t.classList.add('loaded'); if (t.parentElement) t.parentElement.classList.add('img-loaded'); } };
    // 浏览页网格(窗口化):片单按「块」(6 排一块)切开,每块一个 .browse-grid;离视口 ±1600px 以外的块只留一个等高空壳,
    //   DOM 里始终只有几块(几十~两百张)卡片。块的死活只在 IntersectionObserver 回调里改(滚动时不写任何响应式状态);
    //   列数变了(转屏/改窗口)才重新分块,空壳高度按一张卡片的实测高度估
    const DgAdGrid = {
        name: 'DgAdGrid',
        // p4:keep = 片单是「一直在长 / 重排」的同一份(搜索结果流式到达):换数组不重新分块,只有清空 / 从空到有才重来
        // cover = 封面加载不出来的卡片从片单里拿掉(不是 display:none —— 那样块边上会留洞);底下一行「已隐藏 N 部 · 显示」。
        //   视口上面的卡片不动(见 hold):判了藏的先留着、要放回来的先不插 —— 拿掉 / 插进一张,后面每张都挪一格,整个视口里的卡都会跳
        props: { items: { type: Array, default: () => [] }, poster: { type: Function, default: null }, tv: { type: Boolean, default: false }, loading: { type: Boolean, default: false }, keep: { type: Boolean, default: false }, cover: { type: Boolean, default: false } },
        // vis(出了几张, 藏了几张):变了才报(浏览页底栏的「共 N 部」/ 空状态按它)
        emits: ['pick', 'imgerr', 'vis'],
        data() { return { cols: guessCols(), dead: {}, reveal: false, hv: 0 }; },
        directives: { dgCv: cvDirective },
        // 侦听 shown 的 watcher 在 created 之前就把 shown 算了一遍(_rendered 已经有了):这里只补没有的
        created() { if (!this._ho) this._ho = new Map(); if (!Array.isArray(this._rendered)) this._rendered = []; },
        computed: {
            // 实际渲染的片单:藏掉封面加载不出来的(点了「显示」就全部出,坏的用中性占位);_ho 里压着的(视口上面的)按压着的状态出
            shown() {
                const a = this.items;
                if (!this.cover) return a;
                covers.ver();
                void this.hv;
                let out = a;
                if (!this.reveal) {
                    const ho = this._ho && this._ho.size ? this._ho : null;
                    for (let i = 0; i < a.length; i++) {
                        const it = a[i], o = ho ? ho.get(it.id) : undefined;
                        const v = o !== undefined ? o : covers.visible(it);
                        if (out === a) { if (!v) out = a.slice(0, i); }
                        else if (v) out.push(it);
                    }
                }
                this._rendered = out;
                return out;
            },
            hiddenN() { return (this.cover && !this.reveal) ? this.items.length - this.shown.length : 0; },
            visSig() { return this.cover ? this.shown.length + '/' + this.hiddenN : ''; },
            per() { return Math.max(1, this.cols | 0) * ROWS_PER_BLOCK; },
            nBlocks() { return Math.ceil(this.shown.length / this.per); },
        },
        watch: {
            visSig: { immediate: true, handler(v) { if (v) { const p = v.split('/'); this.$emit('vis', +p[0], +p[1]); } } },
            items(nv, ov) { if (nv !== ov && !(this.keep && nv && nv.length && ov && ov.length)) this.reset(); },   // 换了筛选:整个新数组
            nBlocks(n, o) {
                // 片单变短(封面藏掉 / 流式结果重排):只丢掉超出的块的记录,不整个重来(全部块一下变活 = 渲染上千张卡)。
                //   前面的块还是满的 6 排,量好的高度照样对;新的最后一块永远是活的(还在被填)
                let d = null;
                for (const k of Object.keys(this.dead)) if (+k >= n - 1) { d = d || Object.assign({}, this.dead); delete d[k]; }
                if (d) this.dead = d;
                void o;
            },
            // 藏卡之前(这个侦听先于重渲染跑)记下焦点在哪张卡:被拿掉 / 跨块重建后在 updated 里还回去(遥控器 / 键盘不丢焦点)。
            //   不滚动:视口上面的改动由 hold 压着,搜索结果流式重排(keep)也不该带着页面走
            shown(nv, ov) { this.noteFocus(ov); },
        },
        methods: {
            slice(bi) { return this.shown.slice(bi * this.per, (bi + 1) * this.per); },
            src(p) { return this.poster ? this.poster(p) : (p || PLACEHOLDER); },
            cvSrc(it) { return covers.src(it); },
            pick(it) { this.$emit('pick', it); },
            // 「显示」:藏掉的全部插回去。插在视口上面的会把正在看的内容往下顶(Safari / 老电视 WebView 没有滚动锚定)→ 改之前记下视口里的卡的位置,
            //   改完补滚动;焦点原来在「显示」上(点完它就没了)→ 给视口里第一张放出来的卡(遥控器)/ 网格本身
            showAll() { this._rv = this.revealMark(); this.reveal = true; },
            revealMark() {
                try {
                    const el = this.$el, sc = scrollerOf(el), vt = sc.top, vb = sc.bottom, list = [];
                    const cs = el.querySelectorAll('.browse-card[data-bid]');
                    for (let i = 0; i < cs.length && list.length < 24; i++) {
                        const rc = cs[i].getBoundingClientRect();
                        if (rc.bottom <= vt + 1 || rc.top >= vb - 1) continue;
                        list.push({ id: cs[i].getAttribute('data-bid'), top: rc.top });
                    }
                    const ae = root.document.activeElement;
                    return { sc, list, bottom: el.getBoundingClientRect().bottom, prev: new Set((this._rendered || []).map(it => String(it.id))), foc: !!(ae && ae !== root.document.body && el.contains(ae)) };
                } catch (e) { return null; }
            },
            revealBack(m) {
                if (!m) return;
                try {
                    const el = this.$el, cs = el.querySelectorAll('.browse-card[data-bid]'), byId = new Map();
                    for (let i = 0; i < cs.length; i++) { const id = cs[i].getAttribute('data-bid'); if (id && !byId.has(id)) byId.set(id, cs[i]); }
                    let dy = null;
                    for (const x of m.list) { const c = byId.get(x.id); if (c) { dy = c.getBoundingClientRect().top - x.top; break; } }
                    if (dy === null) dy = el.getBoundingClientRect().bottom - m.bottom;   // 视口里原来没有卡(只看得见底下那行字):按网格底边对齐
                    if (Math.abs(dy) >= 1) jumpBy(m.sc, dy);    // 浏览器自己锚定过的话量出来是 0,不会滚两次
                    if (!m.foc) return;
                    const d = root.document, ae = d.activeElement;
                    if (ae && ae !== d.body && ae.isConnected !== false) return;
                    const sc = scrollerOf(el), vt = sc.top, vb = sc.bottom;
                    let first = null, any = null;
                    for (let i = 0; i < cs.length && !first; i++) {
                        const rc = cs[i].getBoundingClientRect();
                        if (rc.bottom <= vt + 1 || rc.top >= vb - 1) continue;
                        if (!any) any = cs[i];
                        if (!m.prev.has(cs[i].getAttribute('data-bid'))) first = cs[i];
                    }
                    const tgt = first || any;
                    if (tgt && tgt.hasAttribute && tgt.hasAttribute('tabindex')) { tgt.focus({ preventScroll: true }); return; }
                    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
                    el.focus({ preventScroll: true });
                } catch (e) { }
            },
            loaded: onImgLoad,
            // 渲染出来的片单(按渲染下标)里:fvi = 第一张不整个在视口上面的,lvi = 第一张整个在视口下面的。
            //   整块在上面的(含只剩空壳的块)整块算上面;跨着视口上沿的活块逐张量。
            //   网格没排版(浏览页被 v-show 藏着、搜索页盖在上面)→ null:量不出视口在哪,什么都不能动
            edges(n) {
                let fvi = n, lvi = n;
                try {
                    const el = this.$el, gr = el.getBoundingClientRect();
                    if (!(gr.width > 0 || gr.height > 0)) return null;
                    const sc = scrollerOf(el), vt = sc.top, vb = sc.bottom, per = this.per;
                    const blocks = el.querySelectorAll('.dg-blk');
                    let gotF = false;
                    for (let bi = 0; bi < blocks.length; bi++) {
                        const b = blocks[bi], rc = b.getBoundingClientRect(), base = bi * per;
                        const cards = this.dead[bi] == null ? b.querySelectorAll('.browse-card[data-bid]') : null;
                        if (!gotF) {
                            if (rc.bottom <= vt + 1) continue;
                            gotF = true;
                            if (rc.top >= vt - 1 || !cards) fvi = base;
                            else { let k = 0; while (k < cards.length && cards[k].getBoundingClientRect().bottom <= vt + 1) k++; fvi = base + k; }
                        }
                        if (rc.top >= vb - 1) { lvi = base; break; }
                        if (cards) {
                            let k = 0;
                            while (k < cards.length && cards[k].getBoundingClientRect().top < vb - 1) k++;
                            if (k < cards.length) { lvi = base + k; break; }
                        }
                    }
                } catch (e) { }
                fvi = Math.min(fvi, n);
                return { fvi, lvi: Math.max(fvi, Math.min(lvi, n)) };
            },
            // 一批封面判定生效之前(covers.listen;DOM 还是旧的)/ 块进出视口之后 / 有压着的卡时滚动停下来(hoWatch):
            //   要变的卡(判了藏 / 放回来)在视口上面 → 先压着(_ho:id → 照旧出不出);视口里的照改(拿掉一张,后面的往前补一格 ——
            //   卡片是懒加载的,失败多半就在视口附近);视口下面的照改(看不见)。压着的一到了视口里 / 下面(往回翻了、回到顶上、
            //   从搜索页回来有了排版)就放开、照改 —— 和没压着的一样(不然首屏里的会一直是灰的占位卡);换了片单就全清。
            //   上面永远不动 → 正在看的不跳,也不用滚回去(iOS 上程序滚动还会打断惯性滚动)
            hold() {
                if (!this.cover || this.reveal) return;
                const el = this.$el, a = this.items, prev = this._rendered, ho = this._ho;
                if (!el || !el.querySelectorAll || !Array.isArray(a) || !Array.isArray(prev) || !ho) return;
                const on = new Map();
                for (let i = 0; i < prev.length; i++) if (prev[i]) on.set(prev[i].id, i);
                const ch = [];
                let mod = false;
                for (let i = 0; i < a.length; i++) {
                    const it = a[i];
                    if (!it) continue;
                    const want = covers.visible(it), o = ho.get(it.id);
                    if (o !== undefined) { if (want === o) { ho.delete(it.id); mod = true; } else ch.push(i); continue; }
                    if (want !== on.has(it.id)) ch.push(i);
                }
                const E2 = ch.length ? this.edges(prev.length) : null;
                if (ch.length && !E2) {
                    // 网格没排版(浏览页藏在搜索页后面):全部压着、什么都不动 —— 回来时浏览页按存下的位置滚回去,这时上面要是少了 / 多了卡,
                    //   回到的就不是原来那张了。等有了排版(块进出视口 / 下一批判定)再按视口放
                    for (const i of ch) { const id = a[i].id; if (!ho.has(id)) { ho.set(id, on.has(id)); mod = true; } }
                } else if (ch.length) {
                    const fvi = E2.fvi;
                    // 没渲染的卡的插入点 = 它后面第一张渲染了的卡的下标(后面没有了 = 末尾)
                    const nxt = new Array(a.length);
                    let nx = prev.length;
                    for (let i = a.length - 1; i >= 0; i--) { const j = a[i] ? on.get(a[i].id) : undefined; nxt[i] = j !== undefined ? j : nx; if (j !== undefined) nx = j; }
                    for (const i of ch) {
                        const id = a[i].id, j = nxt[i];
                        if (ho.has(id)) { if (j >= fvi) { ho.delete(id); mod = true; } }       // 压着的到了视口里 / 下面(视口在列表最顶上时 fvi = 0:全部):放开
                        else if (j < fvi) { ho.set(id, on.has(id)); mod = true; }              // 视口上面:压着
                    }
                }
                if (mod) this.hv++;
                this.hoWatch();
            },
            // 有压着的卡:滚动停下来(200ms 没再滚)再按视口放一次 —— 块的 IntersectionObserver 只在块进出 ±1600px 时才回调,
            //   翻回列表顶上 / 首屏里的不一定等得到。没有压着的了 / 卸载(off)→ 撤掉
            hoWatch(off) {
                const want = !off && !!(this.cover && !this.reveal && this._ho && this._ho.size);
                if (want === !!this._hoFn) return;
                if (want) {
                    this._hoFn = () => {
                        clearTimeout(this._hoT);
                        this._hoT = setTimeout(() => { if (this.cover && !this.reveal && this._ho && this._ho.size) this.hold(); else this.hoWatch(); }, 200);
                    };
                    try { root.addEventListener('scroll', this._hoFn, { passive: true, capture: true }); } catch (e) { }
                } else {
                    try { root.removeEventListener('scroll', this._hoFn, { passive: true, capture: true }); } catch (e) { }
                    clearTimeout(this._hoT);
                    this._hoFn = null;
                }
            },
            noteFocus(prev) {
                this._fx = null;
                try {
                    const d = root.document, ae = d && d.activeElement, el = this.$el;
                    if (!ae || !el || !el.contains || !el.contains(ae)) return;
                    const card = ae.closest ? ae.closest('.browse-card') : null;
                    const id = card ? card.getAttribute('data-bid') : '';
                    if (!id) return;
                    const list = Array.isArray(prev) ? prev : [];
                    let i = -1;
                    for (let j = 0; j < list.length; j++) if (list[j] && String(list[j].id) === id) { i = j; break; }
                    // 它后面 / 前面各 60 张是谁:它被拿掉了就给紧跟在它后面、还留着的那张(不按原来的下标 —— 前面同时没了几张会跳过一张)
                    const nb = [];
                    if (i >= 0) {
                        for (let j = i + 1; j < list.length && j <= i + FOCUS_NB; j++) if (list[j]) nb.push(String(list[j].id));
                        for (let j = i - 1; j >= 0 && j >= i - FOCUS_NB; j--) if (list[j]) nb.push(String(list[j].id));
                    }
                    this._fx = { id, i, nb };
                } catch (e) { }
            },
            keepFocus() {
                const fx = this._fx;
                this._fx = null;
                if (!fx) return;
                try {
                    const d = root.document, ae = d.activeElement;
                    if (ae && ae !== d.body && ae.isConnected !== false) return;   // 焦点还在(或者用户自己挪走了)
                    const cards = this.$el.querySelectorAll('.browse-card[data-bid]'), byId = new Map();
                    for (let j = 0; j < cards.length; j++) { const id = cards[j].getAttribute('data-bid'); if (id && !byId.has(id)) byId.set(id, cards[j]); }
                    const want = [fx.id].concat(fx.nb || []);
                    const s = this.shown;
                    if (fx.i >= 0 && s.length) { const it = s[Math.min(fx.i, s.length - 1)]; if (it) want.push(String(it.id)); }
                    for (const id of want) { const c = byId.get(id); if (c) { c.focus({ preventScroll: true }); return; } }
                } catch (e) { }
            },
            reset() {
                this.dead = {};
                this.reveal = false;
                this._rv = undefined;
                if (this._ho && this._ho.size) { this._ho.clear(); this.hv++; }
                this.hoWatch();
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
                if (this._ho && this._ho.size) this.hold();   // 翻动了:压着的卡到了视口下面就放开
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
            this._cvOff = covers.listen(() => this.hold());   // 封面判定这一批生效之前(DOM 还是旧的):视口上面的改动先压着
            this.sync();
        },
        updated() {
            this.sync();
            if (this._rv !== undefined && this.reveal) { const m = this._rv; this._rv = undefined; this.revealBack(m); }
            this.keepFocus();
        },
        beforeUnmount() {
            if (this._cvOff) { this._cvOff(); this._cvOff = null; }
            this.hoWatch(true);
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
          <img v-dg-cv="cover ? item : null" :src="cover ? cvSrc(item) : src(item.poster_path)" loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" @load="loaded" @error="$emit('imgerr', item)">
          <div v-if="item._badge" class="dg-ad-badge">{{ item._badge }}</div><span v-if="item._n >= 2" class="dg-ov-n">{{ item._n }}线</span><span v-if="item._durText" class="dg-ov-dur">{{ item._durText }}</span><span v-if="item._code" class="dg-ov-code">{{ item._code }}</span>
        </div>
        <div class="movie-name">{{ item.title || item.name }}</div>
        <div class="movie-date dg-ad-sub">{{ item._sub }}</div>
      </div>
    </template>
  </div>
  <div v-if="hiddenN > 0" class="dg-cv-note">已隐藏 {{ hiddenN }} 部封面加载不出来的作品 · <button type="button" class="dg-cv-show" @click="showAll()">显示</button></div>
</div>`,
    };

    // 手机上一排放不下的按钮(大类 / 筛选项 / 标签):以前只能横着滑、「全部」「全部标签」在最后要滑到头才看得到(用户 2026-11-23)。
    //   现在手机上换行、最多 lines 行,多出来的收起,底下「展开 / 收起」;选中的那个在收起的部分里 → 自动展开。电脑上照常全部换行、没有按钮。
    //   只量子元素的位置(ResizeObserver + 内容变了重量),不改子元素本身
    const FOLD_MQ = '(max-width: 768px)';
    const DgFold = {
        name: 'DgFold',
        props: { lines: { type: Number, default: 2 } },
        data() { return { open: false, over: false, mob: false, maxH: 0 }; },
        mounted() {
            try {
                this._mq = root.matchMedia ? root.matchMedia(FOLD_MQ) : null;
                this.mob = !!(this._mq && this._mq.matches);
                this._mqFn = () => { this.mob = !!this._mq.matches; this.soon(); };
                if (this._mq) { if (this._mq.addEventListener) this._mq.addEventListener('change', this._mqFn); else if (this._mq.addListener) this._mq.addListener(this._mqFn); }
            } catch (e) { this.mob = false; }
            try { if (root.ResizeObserver && this.$refs.in) { this._ro = new root.ResizeObserver(() => this.soon()); this._ro.observe(this.$refs.in); } } catch (e) { }
            this.soon();
        },
        updated() { this.soon(); },
        beforeUnmount() {
            clearTimeout(this._t);
            try { if (this._ro) this._ro.disconnect(); } catch (e) { }
            try { if (this._mq) { if (this._mq.removeEventListener) this._mq.removeEventListener('change', this._mqFn); else if (this._mq.removeListener) this._mq.removeListener(this._mqFn); } } catch (e) { }
        },
        methods: {
            soon() { clearTimeout(this._t); this._t = setTimeout(() => this.measure(), 30); },
            measure() {
                const el = this.$refs.in;
                if (!el || !this.mob) { if (this.over) this.over = false; return; }
                const top0 = el.getBoundingClientRect().top + (el.scrollTop || 0);
                const kids = Array.prototype.filter.call(el.children, (k) => k.offsetParent !== null || k.getClientRects().length);
                const tops = [];
                for (const k of kids) { const t = Math.round(k.getBoundingClientRect().top - top0); if (!tops.some((x) => Math.abs(x - t) < 4)) tops.push(t); }
                tops.sort((a, b) => a - b);
                if (tops.length <= this.lines) { if (this.over) this.over = false; return; }
                const h = Math.max(1, tops[this.lines] - tops[0] - 2);
                if (!this.over || this.maxH !== h) { this.over = true; this.maxH = h; }
                // 选中的(大类 / 筛选项 / 标签)在收起的那几行里 → 展开(不然看不到自己选了什么)
                if (!this.open) {
                    const act = el.querySelector('.active, [aria-pressed="true"]');
                    if (act && act.getBoundingClientRect().top - top0 >= h) this.open = true;
                }
            },
            toggle() { this.open = !this.open; },
        },
        template: `<div class="dg-fold" :class="{ 'dg-fold-mob': mob, 'dg-fold-shut': mob && over && !open }">
  <div ref="in" class="dg-fold-in" :style="mob && over && !open ? { maxHeight: maxH + 'px' } : null"><slot></slot></div>
  <button v-if="mob && over" type="button" class="dg-fold-btn" :aria-expanded="open ? 'true' : 'false'" @click="toggle">{{ open ? '收起' : '展开' }} <i :class="['fas', open ? 'fa-angle-up' : 'fa-angle-down']" aria-hidden="true"></i></button>
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
        components: { DgFold },
        data() { return { open: false, xmode: false, note: '', sq: '', aq: '', aRes: null, studios: null, cloud: false }; },
        computed: {
            chips() { return chipRow(this.facets, this.sel, this.legacy); },
            // 「全部标签」展开:当前筛选下所有可选标签按分面组排,字号按 log(数量)(原来单独一页的标签云,现在就地展开、点了直接筛)
            cloudGroups() { return cloudOf(this.facets, this.sel); },
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
    <dg-fold class="browse-fopts">
      <button type="button" class="browse-fopt dg-alltags" :aria-expanded="cloud ? 'true' : 'false'" @click="cloud = !cloud">全部标签 <i :class="['fas', cloud ? 'fa-angle-up' : 'fa-angle-down']" aria-hidden="true"></i></button>
      <button v-for="c in chips" :key="'c-' + c.id" type="button" class="browse-fopt" :class="{ active: c.st === 'in', 'dg-x': c.st === 'ex' }" :disabled="c.off" :aria-pressed="c.st ? 'true' : 'false'" :title="chipTitle(c)" @click="tap(c.id)">{{ c.st === 'ex' ? '−' : '' }}{{ c.label }}<i v-if="c.st" class="fas fa-xmark dg-chip-x" aria-hidden="true"></i></button>
    </dg-fold>
  </div>
  <div v-if="cloud" class="dg-cloud dg-cloud-in" role="group" aria-label="全部标签">
    <section v-for="g in cloudGroups" :key="'cg-' + g.id" class="dg-cloud-g">
      <div class="dg-cloud-gt">{{ g.label }}</div>
      <div class="dg-cloud-ts"><button v-for="t in g.tags" :key="'ct-' + t.id" type="button" class="dg-cloud-t" :class="['w' + t.w, { active: t.st === 'in', 'dg-x': t.st === 'ex' }]" :aria-pressed="t.st ? 'true' : 'false'" :title="t.label + ' · ' + t.count + ' 部'" @click="tap(t.id)">{{ t.st === 'ex' ? '−' : '' }}{{ t.label }}<span class="dg-c">{{ t.count }}</span></button></div>
    </section>
    <div class="dg-cloud-links"><button type="button" class="browse-fopt" @click="$emit('go', { view: 'actresses' })"><i class="fas fa-user" aria-hidden="true"></i> 女优索引</button><button type="button" class="browse-fopt" @click="cloud = false">收起 <i class="fas fa-angle-up" aria-hidden="true"></i></button></div>
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

    // [adult] p4 播放页的「相关推荐 / 同演员 / 同片商」(GET /api/catalog/related/:wk)。wk 由根组件在主播放器出了第一帧之后才给
    //   (不跟起播抢);每排横向滑动 ≤24 张;点卡片 @pick → openWork,点「全部」@go → 女优页 / 厂牌浏览
    // 相关推荐现在能出的卡(按排):变了才算封面判定改了它
    function railSig(rs) { let s = ''; (rs || []).forEach(r => { s += r.k + ':' + r.items.map(it => it.id).join(',') + ';'; }); return s; }
    const DgAdRails = {
        name: 'DgAdRails',
        props: { wk: { type: String, default: '' }, poster: { type: Function, default: null }, tv: { type: Boolean, default: false } },
        emits: ['pick', 'go'],
        // open:哪几排展开成网格;edge:每排左右还能不能翻(电脑上的左右箭头,手机直接横滑)
        data() { return { rails: null, open: {}, edge: {} }; },
        directives: { dgCv: cvDirective },
        computed: {
            // 封面加载不出来的卡片不出;一排全没了整排不出(不提示)
            shownRails() {
                const rs = this.rails;
                if (!rs || !rs.length) { this._sig = ''; return []; }
                covers.ver();
                const out = [];
                rs.forEach(r => {
                    const items = r.items.filter(covers.visible);
                    if (items.length) out.push(items.length === r.items.length ? r : Object.assign({}, r, { items }));
                });
                this._sig = railSig(out);
                return out;
            },
        },
        watch: {
            wk: { immediate: true, handler() { this._cvm = null; this.load(); } },
            shownRails() { this._fm = focusMark(this.$el, '.dg-rail', 'data-rk', '.dg-rail-card', 'data-wk'); },   // 先于重渲染:记下焦点
        },
        // 封面判定这一批要让卡片 / 整排消失(DOM 还是旧的):记下横排露出来的第一张卡的位置、视口里最上面那排的位置,重渲染后补回去
        //   (只在封面判定改了能出的卡时记:换了一部 / 刚拉到推荐不动滚动)
        mounted() {
            this._cvOff = covers.listen(() => this.onCv());
            this._onRz = () => { if (this._rows) this._rows.forEach((el, k) => this.upd(k)); };
            try { root.addEventListener('resize', this._onRz, { passive: true }); } catch (e) { }
        },
        beforeUnmount() {
            if (this._cvOff) { this._cvOff(); this._cvOff = null; }
            try { root.removeEventListener('resize', this._onRz); } catch (e) { }
        },
        updated() {
            const m = this._fm, cm = this._cvm;
            this._fm = null; this._cvm = null;
            focusBack(m);
            if (cm) { rowBack(cm.h); anchorBack(cm.v); }
        },
        methods: {
            onCv() {
                const rs = this.rails, el = this.$el;
                if (!rs || !rs.length || !el || !el.querySelectorAll) return;
                const out = [];
                rs.forEach(r => { const items = r.items.filter(covers.visible); if (items.length) out.push({ k: r.k, items }); });
                if (railSig(out) === this._sig) return;
                this._cvm = { h: rowMark(el, '.dg-rail', 'data-rk', '.dg-rail-row', '.dg-rail-card[data-wk]', 'data-wk'), v: anchorMark(el, '.dg-rail', 'data-rk') };
            },
            src(p) { return this.poster ? this.poster(p) : (p || PLACEHOLDER); },
            cvSrc(it) { return covers.src(it); },
            loaded: onImgLoad,
            load() {
                const wk = this.wk;
                this.rails = null;
                this.open = {};
                this.edge = {};
                if (!wk || !WK_RE.test(wk) || wk.length > 300) return;
                cachedJson('/api/catalog/related/' + encodeURIComponent(wk), 10000).then(d => {
                    if (wk !== this.wk) return;
                    this.rails = Object.freeze(normRelated(d, wk));
                });
            },
            pick(it) { this.$emit('pick', it); },
            // 左右箭头:记下每排的横滑容器(函数 ref,不进响应式),滚动 / 改窗口大小时更新两头还能不能翻
            setRow(k, el) {
                if (!this._rows) this._rows = new Map();
                if (el) { if (this._rows.get(k) !== el) { this._rows.set(k, el); this.$nextTick(() => this.upd(k)); } } else this._rows.delete(k);
            },
            upd(k) {
                const el = this._rows && this._rows.get(k);
                if (!el) return;
                const l = el.scrollLeft > 4, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 4, e = this.edge[k];
                if (!e || e.l !== l || e.r !== r) this.edge = Object.assign({}, this.edge, { [k]: { l, r } });
            },
            nav(k, dir) {
                const el = this._rows && this._rows.get(k);
                if (!el) return;
                try { el.scrollBy({ left: dir * Math.max(200, el.clientWidth * 0.85), behavior: 'smooth' }); } catch (e) { el.scrollLeft += dir * Math.max(200, el.clientWidth * 0.85); }
            },
            toggle(k) { this.open = Object.assign({}, this.open, { [k]: !this.open[k] }); this.$nextTick(() => this.upd(k)); },
        },
        template: `<div v-if="shownRails.length" class="dg-rails">
  <section v-for="r in shownRails" :key="r.k" class="dg-rail" :data-rk="r.k" :aria-label="r.title">
    <div class="dg-rail-t"><i :class="['fas', r.icon]" aria-hidden="true"></i><span>{{ r.title }}</span><span class="dg-rail-acts"><button v-if="!tv && r.items.length > 3" type="button" class="dg-rail-x" :aria-expanded="open[r.k] ? 'true' : 'false'" @click="toggle(r.k)">{{ open[r.k] ? '收起' : '展开' }} <i :class="['fas', open[r.k] ? 'fa-angle-up' : 'fa-angle-down']" aria-hidden="true"></i></button><button v-if="r.go" type="button" class="dg-rail-all" :tabindex="tv ? 2 : null" @click="$emit('go', r.go)">全部 <i class="fas fa-angle-right" aria-hidden="true"></i></button></span></div>
    <div class="dg-rail-box">
      <button v-if="!tv && !open[r.k] && edge[r.k] && edge[r.k].l" type="button" class="dg-rail-nav dg-l" aria-label="往左翻" @click="nav(r.k, -1)"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
      <div class="dg-rail-row" :class="{ 'dg-open': !!open[r.k] }" :ref="(el) => setRow(r.k, el)" @scroll.passive="upd(r.k)">
        <div v-for="it in r.items" :key="r.k + '-' + it.id" class="dg-rail-card" :data-wk="it._wk" :tabindex="tv ? 2 : null" @click="pick(it)" @keydown.enter.prevent="pick(it)">
          <div class="poster-wrap">
            <img v-dg-cv="it" :src="cvSrc(it)" loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" @load="loaded">
            <div v-if="it._badge" class="dg-ad-badge">{{ it._badge }}</div><span v-if="it._durText" class="dg-ov-dur">{{ it._durText }}</span><span v-if="it._code" class="dg-ov-code">{{ it._code }}</span>
          </div>
          <div class="movie-name">{{ it.title }}</div>
          <div class="movie-date dg-ad-sub">{{ it._sub }}</div>
        </div>
      </div>
      <button v-if="!tv && !open[r.k] && edge[r.k] && edge[r.k].r" type="button" class="dg-rail-nav dg-r" aria-label="往右翻" @click="nav(r.k, 1)"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
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
                    bvis: { n: -1, h: 0 },                // 浏览网格现在出了几张 / 藏了几张(封面加载不出来的不算;-1 = 网格还没报)
                    // phase 3 浏览页:facets = 当前筛选的分面计数(冻结;第 1 页随结果下发);view = ''(浏览)/ 'tag'(标签页)/ 'actresses'(女优索引);
                    //   labv = 学到新名字(标签/厂牌/女优)时 +1,让标题重算;routeOn = 地址栏路由已接管(启动时先按地址栏开页,再开始写)
                    facets: null, view: '', labv: 0, routeOn: false,
                    // p4:relWk = 播放页「相关推荐」这部(首帧之后才有);pv / feedAuto = 设置里的「封面悬停预览」「刷短片自动播放(移动网络)」
                    relWk: '', pv: pvOn(), pvReduced: reducedMotion(), cell: cellOk(),
                    // 首页分类行的顺序 / 开关 / 自己加的(homeRows);rowsMsg = 读屏播报
                    rows: homeRows.initial(lsGet(homeRows.KEY)), rowsMsg: '',
                    shuf: false,                          // 随机发现「换一批」正在拉
                    link: null,                           // 播放页这部作品的链接短码 {wk, code}(#/v/<码>,分享面板 / 截帧分享用)

                },
            };
        },
        components: { DgAdGrid, DgAdFilter, DgAdHead, DgAdRails, DgAdActresses, DgFold },
        directives: { dgCv: cvDirective },   // 首页行 / 搜索联想的封面 <img v-dg-cv="item">
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
            // 导航栏站名:画好的字标(见 brand.html;站名经 clean + 转义,只有自己画的 SVG 是原样 HTML)
            adBrandHtml() { return brand.html((this.adult && this.adult.siteName) || DEFAULT_NAME); },
            // 偏好设置「首页分类行」:每行 名字 / 开关 / 是不是自己加的 / 今天有没有内容(首页加载完才判)
            adRowsView() {
                const has = this.rowConfigs || {}, loaded = this.adult.home === 'ok' || this.adult.home === 'empty';
                return (this.adult.rows || []).map(s => {
                    const I = homeRows.info(s.k) || {};
                    const empty = loaded && s.on && !has[s.k];
                    return { k: s.k, l: I.l || s.k, icon: I.icon || 'fa-film', on: s.on, custom: homeRows.isCustom(s.k), note: empty ? (I.hint || '暂时没内容') : '' };
                });
            },
            // 首页 / 浏览页的大类一排:「全部」排第一(以前在最后,手机上要滑到头才看得到 —— 用户 2026-11-23)
            adCatTypes() { return TYPES.filter(T => T.k === 'all').concat(TYPES.filter(T => T.k !== 'all')); },
            adRowsAddable() { const have = new Set((this.adult.rows || []).map(s => s.k)); return homeRows.ADD.filter(a => !have.has(a.k)).map(a => ({ id: a.id, l: a.l })); },
            adRowsAdded() { return homeRows.added(this.adult.rows || []); },
            adRowsMax() { return homeRows.MAX_ADD; },
            adRowsIsDefault() { return homeRows.isDefault(this.adult.rows || []); },
            adBrowseTitle() {
                void this.adult.labv;
                const b = this.browse, s = (b && b.sel) || {};
                if (this.adult.view === 'actresses') return '女优';   // p4 女优索引
                if (this.adult.view === 'tag' && s.t && s.t.length) return '#' + tagLabel(s.t[0]);
                return catalog.title(b.type, s);
            },
            adBrowseSummary() {
                void this.adult.labv;
                if (noList(this.adult.view) || this.adult.view === 'tag') return this.adBrowseTitle;
                return catalog.summary(this.browse.type, this.browse.sel);
            },
            // 搜索建议下拉的各行:分类词 → 「按分类浏览」;作品卡片(≤8,封面加载不出来的不出);最后一行「搜索全部站点」。
            //   封面判定不让它重算(不读 covers.ver()):下拉开着时不删行(鼠标指着的 / 方向键选中的行不跳),
            //   下次重算(打字出了新建议 / 重新打开)才把封面加载不出来的那几行筛掉
            adSugRows() {
                const S = this.adult && this.adult.sug;
                if (!S || !S.open) return [];
                const rows = [];
                if (S.alias) rows.push({ t: 'alias', k: 'a', label: S.alias.label, alias: S.alias });
                (S.items || []).forEach(it => { if (covers.visible(it)) rows.push({ t: 'item', k: 'i:' + it.id, it }); });
                rows.push({ t: 'all', k: 'all', q: S.q });
                return rows;
            },
            // ---- p4 ----
            // 浏览页当前是「没有片单」的形态(女优索引):不出筛选行、网格、底栏
            adNoList() { return !!(this.adultMode && this.adult && noList(this.adult.view)); },
            // 刷短片入口:有目录、不是电视、feed.js 加载了
            adFeedOn() { return !!(this.adultMode && this.adult && this.adult.catalog && !this.isTVMode && root.dgAdultFeed && typeof root.dgAdultFeed.open === 'function'); },
            // 浏览页底栏「已经到底了 · 共 N 部」/ 空状态按网格现在出了几张算(封面加载不出来藏掉的不算;网格还没报 → 片单长度)
            adBrowseN() {
                const v = this.adult && this.adult.bvis, b = this.browse;
                return (v && v.n >= 0) ? v.n : ((b && Array.isArray(b.items)) ? b.items.length : 0);
            },
            // 搜索结果(全站扇出可到几百张)→ 窗口化网格的卡片:海报按主组件的 finalPoster / 回退规则,_g 是原来的分组(点了 openDetail)
            adSearchItems() {
                if (!this.adultMode) return [];
                const out = [];
                for (const g of (this.groupedList || [])) {
                    if (!g || !g.name) continue;
                    let key = '', pic = '';
                    try { key = this.posterKey(g); pic = this.isFallback(key) ? '' : (this.finalPoster(g) || ''); } catch (e) { }
                    const o = {
                        id: g.name + '|' + (g._work || ''), _wk: typeof g._wk === 'string' ? g._wk : '', title: g.name, name: g.name, poster_path: pic,
                        _n: (g.sources || []).length, _sub: g._workLabel || '', _badge: '', _code: '', _durText: '', _pk: key, _g: g,
                    };
                    // 封面备用:同组别的线路的海报(先挑不同图床的,≤3);主封面坏了 / 在死图床上时网格挨个试,都不行就藏到「已隐藏 N 部」里
                    const alt = searchAlts(g, pic, 3);
                    if (alt.length) o._alt = alt;
                    out.push(Object.freeze(o));
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
                if (this.adultMode) { if (v) this._adLinkSoon(); else this._adLinkRestore(); }   // 地址栏跟着播放页:#/v/<码>,关了换回去
                if (v || this._adReturnY == null) return;
                const y = this._adReturnY;
                this._adReturnY = null;
                this.$nextTick(() => { try { this._jumpTo(y); } catch (e) { } });
            },
            // 换了一部:收起展开的备用线路、清掉「中字 / 原版」选择;从搜索结果/历史打开的(没有 _meta)补拉作品信息和线路标记;
            //   能分享 = 目录作品(有作品键,能要短码),播放器里的「分享当前画面」入口跟着它显隐;地址栏 #/v/<码> 跟着换(相关推荐 / 刷短片里点开别的)
            //   (watch 里只能有一个 currentGroup:对象字面量重名 = 后一个静默盖掉前一个)
            currentGroup(g, old) {
                if (!this.adultMode) return;
                try { root.document.documentElement.classList.toggle('dg-can-share', !!(g && typeof g._wk === 'string' && g._wk)); } catch (e) { }
                if (this.showDetail && g && g._wk && (!this.adult.link || this.adult.link.wk !== g._wk)) this._adLinkSoon();
                if (g !== old) {
                    if (this.adult.relWk && (!g || g._wk !== this.adult.relWk)) this.adult.relWk = '';   // [adult] p4:换了一部,相关推荐等新的首帧
                    if (Object.keys(this.adult.famOpen || {}).length) this.adult.famOpen = {};
                    if (this.adult.varPref && this.adult.varPref.kind && (!g || this.adult.varPref.wk !== (g._wk || ''))) this.adult.varPref = { wk: '', kind: '' };
                }
                this._adEnrich(g);
            },
            // 浏览页的类型/筛选/开关一变 → 写地址栏(新的一条历史;从地址栏来的 / 面板开着时替换当前这条)
            adRouteHash(h) { this._adRouteSync(h); },
            // 搜索联想的行变了(封面藏掉了几行):方向键选中的那行跟着它的键走,不落到别的行上(它自己没了 → 原位置,不越界)
            adSugRows(rows) {
                const S = this.adult && this.adult.sug;
                if (!S || !(S.hi >= 0) || !Array.isArray(rows)) return;
                let i = -1;
                for (let j = 0; j < rows.length; j++) if (rows[j].k === this._adSugHiK) { i = j; break; }
                const hi = i >= 0 ? i : Math.min(S.hi, rows.length - 1);
                if (hi !== S.hi) S.hi = hi;
            },
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
            if (!this._adCvOff) this._adCvOff = covers.listen(() => this._adCvApply());   // 封面判了藏 / 图床死活变了 → 首页行跟着筛
            this._adHashFn = () => this._adOnHash();
            this._adPopFn = () => this._adOnPop();
            try { root.addEventListener('hashchange', this._adHashFn); root.addEventListener('popstate', this._adPopFn); } catch (e) { }
        },
        beforeUnmount() {
            if (this._adCvOff) { this._adCvOff(); this._adCvOff = null; }
        },
        methods: {
            adultApplyConfig(config) {
                const c = config || {};
                this.adult.catalog = c.catalog === true;
                this.adult.intro = c.intro_enabled === true;   // 站长显式开了片头学习(INTRO_DISABLE=0)才显示那两行设置
                this.adult.siteName = brand.apply(c.site_name);
                brand.applyBuy(c.purchase_url);
                covers.setServerDead(c.cover_dead_hosts);   // 服务器 DNS 两次查无此域名的图床:这些地址的封面不请求
            },
            // 首页:目录各行(最多等 6s,与原来的 Hero 一样不挂死 loader);分类栏的「今日」数后台拉
            async adultLoadHome() {
                if (!this.adult.catalog) { this.adult.home = 'off'; return; }
                this.adult.home = 'loading';
                this.adultLoadBuckets();
                const p = fetchJson('/api/catalog/home', 15000);
                const d = await Promise.race([p, sleep(6000).then(() => 'slow')]);
                const apply = (home) => {
                    this._adHomeAll = homeToRows(home);            // 原始的行(没筛过):每批封面判定生效时从它重新筛(活过来的卡片 / 行放回来)
                    const r = this._adCvRows(this._adHomeAll);     // 没有能用封面的卡片(pic 空 / 只在死图床上)渲染之前就拿掉,不闪一下
                    this.rowLists = Object.assign({}, r.lists);
                    this.rowConfigs = Object.assign({}, r.configs);
                    this.adult.home = r.order.length ? 'ok' : 'empty';
                    this._adFySig = '';             // [adult] p4:首页行整个换了,猜你喜欢重新插
                    this._adForYouSoon(1500);
                    this._adCustomRowsSoon(600);    // 自己加的分类行(首页固定行先出,再一行行补)
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
                else if (e.key === 'Escape') { e.preventDefault(); this.adSugClose(); return; }
                const row = this.adSugRows[S.hi];
                this._adSugHiK = row ? row.k : '';   // 选中的是哪一行(按键认):前面的行因为封面藏掉时,高亮跟着这一行走
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
                if (alias && alias.tag && alias.label && !alias.tags) learnTag(alias.tag, alias.label);
                const tagOnly = !p.sel.b && p.sel.t && p.sel.t.length === 1 && featurable(p.sel.t[0]);
                this._adOpen(tagOnly ? 'tag' : '', p.type, p.sel, { keyword: String(kw || '') });
                return true;
            },
            // ---------- phase 3:分面浏览(_browseFetch 在成人站整个交给它)----------
            //   游标翻页:服务器回了 cursor_next(字符串 / null)就按游标接着拉,到 null 为止;没有这个键 → 按页(旧服务器 / 退路)。
            //   第 1 页带 facets=1(标签行 / 筛选面板 / 全部标签的计数、可用排序);女优索引页不拉片单
            async _adBrowseFetch(reset) {
                const b = this.browse;
                if (reset) {
                    this._browseAbort();
                    b.seq++;
                    b.items = []; b.page = 0; b.totalPages = 0; b.total = 0;
                    b.done = false; b.error = false; b.idle = 0; b.loading = false;
                    this._browseSeen = new Set();
                    this._adPrevPage = null;
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
                const url = browseApiUrl(b.sel, { page, cursor, facets: first, type: b.type });
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
                    // 「稀」按留下来能出的算:这一页渲染之前就能出的(没封面 / 死图床上的不算)不到 4 张,或者上一页到现在(封面判定已经出来了)
                    //   能出的不到 4 张 → 稀。连着 4 页稀就不再自己往下翻(露出「加载更多」):整页被藏的片单不会一页接一页地狂拉
                    const vis = fresh.filter(covers.visible).length;
                    const prevVis = (!first && this._adPrevPage) ? this._adPrevPage.filter(covers.visible).length : Infinity;
                    if (fresh.length) this._adPrevPage = fresh;
                    b.idle = (vis >= 4 && prevVis >= 4) ? 0 : b.idle + 1;
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
            //   { patch }(改当前筛选的几项)/ { sel, type? }(整个换)/ { view:'tag', id }(标签页)/ { view:'actresses' }(女优索引)
            adGo(nav) {
                const n = nav || {};
                const b = this.browse;
                const cur = (b && b.open) ? b.sel : {};
                let view = '', type = 'all', sel = {};
                if (n.view === 'tags') {   // 旧的标签云页已并进浏览页(筛选行「全部标签」):就是那个分类的浏览页
                    const bk = BUCKET_LABEL[n.b] ? n.b : '';
                    type = bk ? typeOfBucket(bk) : 'all'; sel = { b: bk };
                } else if (n.view === 'actresses') {
                    view = 'actresses'; type = 'all'; sel = {};   // p4 女优索引
                } else if (n.view === 'tag') {
                    if (!validTag(n.id) || isBlockedTag(n.id)) return;
                    view = 'tag'; sel = { t: [n.id] };
                } else if (n.patch && typeof n.patch === 'object') {
                    sel = Object.assign({}, cur, n.patch);
                    // 改 b:换到那个分区所在的大类;清掉 b(国产「全部」)= 留在当前大类
                    if (Object.prototype.hasOwnProperty.call(n.patch, 'b')) type = BUCKET_LABEL[n.patch.b] ? typeOfBucket(n.patch.b) : ((b && b.open && typeOf(b.type)) ? b.type : 'all');
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
                // 分享链接 #/v/<码>:地址栏里贴进来 / 点了站内的这种链接 → 打开那部
                const sp = shareLinks.parse(root.location.hash);
                if (sp) { if (!(this.adult.link && this.adult.link.code === sp.code && this.showDetail)) this.adOpenShare(sp); return; }
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
                const sp = shareLinks.parse(h);
                if (sp) { this.adOpenShare(sp); return; }   // 分享链接 / 书签 / 刷新时停在某部作品的 #/v/<码>
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
            // 搜索结果的窗口化网格:点卡片 = 原来的 openDetail(分组)。海报坏了由封面控制器换同组别的线路的海报(_alt = searchAlts),都不行就藏
            adSearchPick(item) { if (item && item._g && typeof this.openDetail === 'function') this.openDetail(item._g); },
            // ---------- 封面加载不出来就藏(见 covers)----------
            // 首页行 / 搜索联想的 <img :src>:该试的那个地址(主封面坏了换备用;不读响应式版本号 —— 根组件不跟着每批判定重渲染)
            adCvSrc(item) { return covers.src(item); },
            // 浏览网格报它现在出了几张 / 藏了几张(变了才报):底栏的「共 N 部」/ 空状态按这个
            adBrowseVis(n, h) {
                const v = this.adult.bvis, nn = Math.max(0, Number(n) || 0), hh = Math.max(0, Number(h) || 0);
                if (!v || v.n !== nn || v.h !== hh) this.adult.bvis = { n: nn, h: hh };
            },
            // 收藏的封面:这部作品 / 这组搜索结果的封面控制器换到备用地址并且真加载出来了 → 用那张(主封面是坏的);没有 → ''
            adOkPic(g, pk) { return covers.okPic(g && typeof g._wk === 'string' ? g._wk : '', String(pk || '')); },
            // homeToRows 的结果 → 拿掉没有能用封面的卡片;一张都不剩的行整行不出(新片速递拿掉之后不足 12 部也整行不出)
            _adCvRows(r) {
                const lists = {}, configs = {}, order = [];
                for (const k of (r && r.order) || []) {
                    const L = (r.lists[k] || []).filter(covers.visible);
                    if (L.length < rowMin(k)) continue;
                    lists[k] = L; configs[k] = r.configs[k]; order.push(k);
                }
                return { configs, lists, order };
            },
            // 一批封面判定生效:首页目录行按 homeToRows 的原始结果(_adHomeAll)重新筛 —— 藏掉的卡片拿掉,图床活过来 / 判藏撤销了的放回来;
            //   不够下限的行(新片速递:不足 12 部)整行拿掉,又够了就按原来的顺序整行放回来。猜你喜欢照旧只在现有片单上筛(放在第一行目录行后面)。
            //   不让正在看的内容跳:以视口里第一个留下的行为锚,改完量一下它挪了多少再滚回去(上面有行没了 / 回来了时);横排滚过的行同样以第一张露出来的卡为锚补 scrollLeft;
            //   播放页开着(首页各层还排着版、只是看不见)→ 不滚窗口,改的是关掉播放页时要回到的位置(_adReturnY),回来还是原来那张卡;
            //   焦点在被拿掉的卡上 → 给同一行紧跟在它后面、还留着的那张。搜索联想不在这里动(开着时不删行,见 adSugRows)
            _adCvApply() {
                if (!this.adultMode) return;
                const lists = this.rowLists || {}, cfgs = this.rowConfigs || {}, all = this._adHomeAll || null;
                const vis = (it) => !it || typeof it !== 'object' || !it._wk || covers.visible(it);
                const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
                const base = [], extra = [], drop = [];
                let changed = false;
                if (all) all.order.forEach(k => {
                    const L = all.lists[k].filter(vis);
                    if (L.length < rowMin(k)) { if (cfgs[k]) { changed = true; drop.push(k); } return; }
                    if (!cfgs[k] || !same(lists[k], L)) { changed = true; base.push([k, L]); } else base.push([k, lists[k]]);
                });
                Object.keys(cfgs).forEach(k => {
                    if (all && all.configs[k]) return;
                    const L = lists[k];
                    if (!Array.isArray(L) || !cfgs[k] || !cfgs[k].adult) { extra.push([k, L]); return; }
                    const f = L.filter(vis);
                    if (f.length === L.length) { extra.push([k, L]); return; }
                    changed = true;
                    if (f.length >= rowMin(k)) extra.push([k, f]); else drop.push(k);
                });
                if (!changed) return;
                const nl = {}, nc = {};
                base.slice(0, 1).concat(extra, base.slice(1)).forEach(x => { nl[x[0]] = x[1]; nc[x[0]] = x[0] in cfgs ? cfgs[x[0]] : all.configs[x[0]]; });
                const d = root.document;
                let anchor = null, top = 0;
                try {
                    const secs = d.querySelectorAll('[data-row-key]');
                    for (let i = 0; i < secs.length; i++) {
                        if (drop.indexOf(secs[i].getAttribute('data-row-key')) >= 0) continue;
                        const rc = secs[i].getBoundingClientRect();
                        if (rc.bottom > 0 && (rc.height > 0 || rc.width > 0)) { anchor = secs[i]; top = rc.top; break; }
                    }
                } catch (e) { anchor = null; }
                // 收起状态的横排(.hot-row)滚过了的:记下行里最左边露出来的几张卡的 left
                const hx = rowMark(d && d.body, '[data-row-key]', 'data-row-key', '.hot-row', '.hot-card[data-wk]', 'data-wk');
                const fm = focusMark(d && d.body, '[data-row-key]', 'data-row-key', '.hot-card[data-wk]', 'data-wk');
                if (Object.keys(nc).join('\n') !== Object.keys(cfgs).join('\n')) this.rowConfigs = nc;
                this.rowLists = nl;
                if (this.adult && this.adult.home === 'empty' && base.length) this.adult.home = 'ok';
                // 展开网格的页码别停在已经不存在的页
                try { Object.keys(nl).forEach(k => { const vp = this.viewPages && this.viewPages[k]; const n = Math.ceil(((nl[k] || []).length || 0) / 20) || 1; if (vp > n) this.viewPages[k] = n; }); } catch (e) { }
                this.$nextTick(() => {
                    try {
                        if (anchor && anchor.isConnected !== false) {
                            const dy = anchor.getBoundingClientRect().top - top;
                            if (Math.abs(dy) >= 1) {
                                if (this.showDetail) {
                                    if (this._adReturnY != null) this._adReturnY = Math.max(0, this._adReturnY + dy);
                                } else {
                                    const y = Math.max(0, (typeof root.scrollY === 'number' ? root.scrollY : 0) + dy);
                                    if (typeof this._jumpTo === 'function') this._jumpTo(y);   // 瞬间到位(全站 scroll-behavior:smooth)
                                    else if (typeof root.scrollTo === 'function') root.scrollTo(0, y);
                                }
                            }
                        }
                    } catch (e) { }
                    rowBack(hx);
                    focusBack(fm);
                });
            },
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
            // ---------- 首页分类行:顺序 / 开关 / 自己加的(homeRows;偏好设置「首页分类行」)----------
            // 首页 homeBlocks 用:现有的目录行按布局排、关掉的不出
            adHomeKeys(keys) { return homeRows.order(this.adult.rows || homeRows.def(), keys); },
            adRowsMove(k, dir) {
                const L = this.adult.rows || [], i = L.findIndex(s => s.k === k), j = i + dir;
                if (i < 0 || j < 0 || j >= L.length) return;
                this._adRowsSet(homeRows.move(L, k, dir), ((homeRows.info(k) || {}).l || '') + ' 已移到第 ' + (j + 1) + ' 位');
                // 移到头 / 尾时这个方向的按钮会变灰:焦点换到另一个按钮,键盘 / 遥控器可以接着按
                const keep = (j === 0 && dir < 0) || (j === L.length - 1 && dir > 0) ? -dir : dir;
                this.$nextTick(() => { try { const b = root.document.querySelector('[data-ad-row-mv="' + k + ':' + keep + '"]'); if (b) b.focus(); } catch (e) { } });
            },
            adRowsToggle(k, on) {
                this._adRowsSet(homeRows.toggle(this.adult.rows || [], k, on));
                if (homeRows.isCustom(k)) { if (on) this._adCustomRowsSoon(0); else this._adCustomRowsDrop(); }
            },
            adRowsAdd(id, ev) {
                if (ev && ev.target) { try { ev.target.value = ''; } catch (e) { } }   // 下拉框回到「添加分类…」
                if (!id) return;
                const L0 = this.adult.rows || [], L = homeRows.add(L0, id);
                if (L === L0) { if (homeRows.added(L0) >= homeRows.MAX_ADD) this.adult.rowsMsg = '最多加 ' + homeRows.MAX_ADD + ' 行,先删掉一行再加'; return; }
                const a = homeRows.ADD.find(x => x.id === id);
                this._adRowsSet(L, '已添加「' + a.l + '」,在首页最前面');
                this._adCustomRowsSoon(0);
            },
            adRowsRemove(k) {
                const I = homeRows.info(k);
                this._adRowsSet(homeRows.remove(this.adult.rows || [], k), '已移除「' + (I ? I.l : k) + '」');
                this._adCustomRowsDrop();
            },
            adRowsReset() {
                this._adRowsSet(homeRows.def(), '已恢复默认');
                this._adCustomRowsDrop();
                this.$nextTick(() => { try { const b = root.document.querySelector('[data-ad-row-mv]:not([disabled])'); if (b) b.focus(); } catch (e) { } });
            },
            // 存本机;登录了同步账号的推到服务器(并入 user_settings)。连点上移 / 下移只推最后一次(请求先后乱了会存成中间某一步)
            _adRowsSet(L, msg) {
                this.adult.rows = L;
                if (msg) this.adult.rowsMsg = msg;
                lsSet(homeRows.KEY, JSON.stringify(L));
                if (!(this.syncEnabled && this.syncToken)) return;
                clearTimeout(this._adRowsPushT);
                this._adRowsPushT = setTimeout(() => this.adRowsFlush(), 600);
            },
            // 还没推的立刻推(关偏好设置弹窗时)
            adRowsFlush() {
                if (!this._adRowsPushT) return;
                clearTimeout(this._adRowsPushT);
                this._adRowsPushT = 0;
                if (!(this.syncEnabled && this.syncToken)) return;
                try {
                    root.fetch('/api/settings/push', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: this.syncToken, settings: { adHomeRows: this.adult.rows } }),
                    }).catch(() => { });
                } catch (e) { }
            },
            // 同步拉下来的布局(本机刚改、还没推上去的不被服务器旧值盖掉)
            adRowsPulled(v) {
                if (this._adRowsPushT || !Array.isArray(v)) return;
                const L = homeRows.normalize(v);
                if (JSON.stringify(L) === JSON.stringify(this.adult.rows)) return;
                this.adult.rows = L;
                lsSet(homeRows.KEY, JSON.stringify(L));
                this._adCustomRowsDrop();
                this._adCustomRowsSoon(0);
            },
            _adCustomRowsSoon(ms) {
                clearTimeout(this._adCrT);
                this._adCrT = setTimeout(() => { this.adultLoadCustomRows().catch(() => { }); }, ms || 0);
            },
            // 拿掉已经不在布局里 / 关掉了的自己加的行
            _adCustomRowsDrop() {
                const want = new Set((this.adult.rows || []).filter(s => s.on && homeRows.isCustom(s.k)).map(s => s.k));
                const cur = this.rowConfigs || {};
                const gone = Object.keys(cur).filter(k => homeRows.isCustom(k) && !want.has(k));
                if (!gone.length) return;
                const c = Object.assign({}, cur), l = Object.assign({}, this.rowLists);
                gone.forEach(k => { delete c[k]; delete l[k]; });
                this.rowConfigs = c;
                this.rowLists = l;
            },
            // 自己加的分类行:一行一个浏览请求(第 1 页,nr=1),拿掉封面出不来的,不足 CUSTOM_MIN 部整行不出
            async adultLoadCustomRows() {
                if (!this.adultMode || !this.adult || !this.adult.catalog || (this.adult.home !== 'ok' && this.adult.home !== 'empty')) return;
                const seq = (this._adCrSeq = (this._adCrSeq || 0) + 1);
                this._adCustomRowsDrop();
                const isOn = (k) => (this.adult.rows || []).some(s => s.k === k && s.on);
                const want = (this.adult.rows || []).filter(s => s.on && homeRows.isCustom(s.k)).map(s => s.k);
                for (const k of want) {
                    const d = await cachedJson(homeRows.url(k), 10000);
                    if (seq !== this._adCrSeq) return;
                    if (!isOn(k)) continue;
                    const items = [], seen = new Set();
                    for (const c of (d && Array.isArray(d.results) ? d.results : [])) {
                        const it = cardToItem(c);
                        if (!it || seen.has(it._wk) || !covers.visible(it)) continue;
                        seen.add(it._wk);
                        items.push(Object.freeze(it));
                        if (items.length >= 24) break;
                    }
                    const c = Object.assign({}, this.rowConfigs), l = Object.assign({}, this.rowLists);
                    if (items.length >= homeRows.CUSTOM_MIN) { c[k] = homeRows.config(k); l[k] = items; } else { delete c[k]; delete l[k]; }
                    this.rowConfigs = c;
                    this.rowLists = l;
                }
            },
            // ---------- 每部作品的链接 #/v/<码>(地址栏 / 分享)----------
            //   开播放页 → 要这部的短码 → 地址栏换成 #/v/<码>(replaceState:不多压历史,返回键照旧关播放页);关播放页 → 换回原来的地址。
            //   无痕:不改地址栏(不留浏览记录),分享按钮照样能用(点的时候才要码)
            _adLinkSoon() {
                const g = this.currentGroup, wk = g && typeof g._wk === 'string' ? g._wk : '';
                if (!this.adultMode || !wk || !this.showDetail) return Promise.resolve(false);
                const seq = (this._adLinkSeq = (this._adLinkSeq || 0) + 1);
                return shareLinks.code(wk).then(code => {
                    if (seq !== this._adLinkSeq || !code || !this.showDetail || !this.currentGroup || this.currentGroup._wk !== wk) return false;
                    this.adult.link = { wk, code };
                    if (!incognito()) {
                        try {
                            const loc = root.location, h = '#/v/' + code;
                            if (loc.hash !== h) {
                                if (!SHARE_HASH_RE.test(loc.hash || '')) this._adLinkPrev = loc.pathname + loc.search + (loc.hash || '');
                                root.history.replaceState(root.history.state, '', loc.pathname + loc.search + h);
                            }
                        } catch (e) { }
                    }
                    return true;
                });
            },
            _adLinkRestore() {
                this._adLinkSeq = (this._adLinkSeq || 0) + 1;
                this.adult.link = null;
                try {
                    const loc = root.location;
                    if (!SHARE_HASH_RE.test(loc.hash || '')) { this._adLinkPrev = null; return; }
                    const prev = this._adLinkPrev != null ? this._adLinkPrev : (loc.pathname + loc.search);
                    this._adLinkPrev = null;
                    root.history.replaceState(root.history.state, '', prev);
                } catch (e) { }
            },
            // 分享面板 / 截帧分享用:这部的短码拿到了没有(没有就现要)→ true / false
            adEnsureLink() {
                const g = this.currentGroup;
                if (this.adult.link && g && this.adult.link.wk === g._wk) return Promise.resolve(true);
                const wk = g && typeof g._wk === 'string' ? g._wk : '';
                if (!wk) return Promise.resolve(false);
                return shareLinks.code(wk).then(code => {
                    if (!code || !this.currentGroup || this.currentGroup._wk !== wk) return false;
                    this.adult.link = { wk, code };
                    return true;
                });
            },
            // 分享链接(t = 原时间轴秒数,0 = 不带);短码还没拿到 → ''
            adShareUrl(t) {
                const g = this.currentGroup, L = this.adult && this.adult.link;
                if (!L || !g || L.wk !== g._wk) return '';
                return shareLinks.url(L.code, t > 0 ? t : 0, root.location ? root.location.origin : '');
            },
            // 打开别人分享的 #/v/<码>[?t=秒]:地址栏先换回干净的(关播放页之后不会又停在这条链接上),问服务器是哪部 → 开;t → 播放器就绪后跳过去
            async adOpenShare(p) {
                if (!p || !p.code) return;
                try { const loc = root.location; if (SHARE_HASH_RE.test(loc.hash || '')) root.history.replaceState(root.history.state, '', loc.pathname + loc.search); } catch (e) { }
                const wk = await shareLinks.resolve(p.code);
                if (!wk) { if (this.showMiniToast) this.showMiniToast('这个链接里的视频找不到了(可能已经下架)'); return; }
                if (typeof this.openWork === 'function') await this.openWork({ _wk: wk, wk });
                if (!(p.t > 0)) return;
                let n = 0;
                const tick = () => {
                    n++;
                    let v = null;
                    try { v = root.document.querySelector('#dplayer video'); } catch (e) { }
                    if (this.showDetail && v && v.readyState >= 1 && v.duration) {
                        try {
                            const at = typeof this._cutToPlay === 'function' ? this._cutToPlay(p.t) : p.t;   // 分享的是原时间轴秒数,按这台的剪段换算
                            if (at > 0 && at < v.duration) v.currentTime = at;
                            if (this.showMiniToast) this.showMiniToast('▶ 已跳转到分享的时间点');
                        } catch (e) { }
                        return;
                    }
                    if (n < 40 && this.showDetail) setTimeout(tick, 300);
                };
                setTimeout(tick, 1200);
            },
            // 随机发现「换一批」:服务器那一行按北京时间日种子排(一天不变,刷新页面也一样)。这里在浏览接口的随机序里随机翻到别的一页
            //   (每页 48 部,几百页),拿 24 部这次打开页面以来这行没出过的(nr=1 不要审查级、封面出得来);不够再翻一页。
            //   _adHomeAll 里那一行也换掉 —— 否则下一批封面判定生效时 _adCvApply 会按原始片单把它改回去
            async adRowShuffle(key) {
                if (!this.adultMode || !this.adult || this.adult.shuf || !this.rowConfigs || !this.rowConfigs[key]) return;
                const st = this._adShuf || (this._adShuf = { tp: 0, used: new Set([1]), seen: new Set() });
                (this.rowLists[key] || []).forEach(it => { if (it && it._wk) st.seen.add(it._wk); });
                this.adult.shuf = true;
                try {
                    const items = [];
                    for (let tries = 0; tries < 4 && items.length < 24; tries++) {
                        const hi = st.tp > 1 ? Math.min(st.tp, 500) : 40;
                        let pg = 0;
                        for (let n = 0; n < 8 && (!pg || st.used.has(pg)); n++) pg = 2 + Math.floor(Math.random() * Math.max(1, hi - 1));
                        if (st.used.has(pg)) st.used = new Set([1]);   // 翻遍了:从头再来
                        st.used.add(pg);
                        const d = await fetchJson(browseApiUrl({ sort: 'rand' }, { page: pg, nr: true }), 10000);
                        if (!this.adult) return;
                        const tp = Number(d && d.total_pages) || 0;
                        if (tp > 0) st.tp = tp;
                        for (const c of (d && Array.isArray(d.results) ? d.results : [])) {
                            const it = cardToItem(c);
                            if (!it || st.seen.has(it._wk) || !covers.visible(it)) continue;
                            st.seen.add(it._wk);
                            items.push(Object.freeze(it));
                            if (items.length >= 24) break;
                        }
                        if (st.seen.size > 3000) st.seen.clear();
                    }
                    if (items.length < 8 || !this.rowConfigs[key]) { if (this.showMiniToast) this.showMiniToast('暂时换不了,稍后再试'); return; }
                    if (this._adHomeAll && this._adHomeAll.lists && this._adHomeAll.lists[key]) this._adHomeAll.lists[key] = items;
                    this.rowLists = Object.assign({}, this.rowLists, { [key]: items });
                    try { if (this.viewPages && this.viewPages[key]) this.viewPages[key] = 1; } catch (e) { }
                    this.$nextTick(() => {
                        try {
                            const row = root.document.querySelector('[data-row-key="' + key + '"] .hot-row');
                            if (row) row.scrollLeft = 0;
                        } catch (e) { }
                    });
                } finally {
                    if (this.adult) this.adult.shuf = false;
                }
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
                        if (!it || seen.has(it._wk) || !covers.visible(it)) continue;   // 封面出不来的不推荐
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
        upgradeMixed,
        BUCKET_LABEL, NAV_BUCKETS, TYPES, SORTS, DURS, VARIANTS, GROUPS, DEFAULT_SORTS,
        catalog, cardToItem, browseUrl, homeToRows, todayMap, todayOf,
        workUrl, workSource, workToGroup, workToList, groupKeyOf, groupNameOf, isLandscape, isPortrait, shapeCover, pickFallbackPic, PLACEHOLDER,
        isContentPath, sameOriginPath,
        TAG_LABEL, NEVER_FEATURE, NO_ACTRESS_BUCKETS, tagLabel, fmtDur, srcFlags, srcExtra, varKind, orderSources, srcView, nativeDev,
        metaView, tagsUrl, normTags, suggestUrl, normSuggest, aliasPreset, beacon,
        // phase 3
        browseApiUrl, filterCount, nextTagState, normFacets, sortOpts, chipRow, activePills, routeOf, parseRoute, canonHash, isOurHash,
        cloudOf, normTagInfo, normActress, normActressList, normStudios, relDate, featurable, isBlockedTag, guessCols,
        components: { DgAdGrid, DgAdFilter, DgAdHead, DgAdRails, DgAdActresses, DgFold },
        ageGate, brand, wordmark, homeRows, HOME_BUCKETS, shareLinks, SHARE_HASH_RE, auth, fetchWork, mixin, boot,
        // p4:扩展点 / 给 preview.js、feed.js、player-x.js、privacy.js 的桥
        hook, hooks: hooks.H, HOOK_NAMES, cardOf, wkTags, fetchWorkRaw, wrapPlayUrl, playUrl, proxyUrl, mainBusy, previewBusy, isTV,
        openWork: openWorkExt, incognito, privLocked, netBlock, netNow, cellOk, pvOn, CELL_KEY, PV_KEY,
        normRelated, forYouTags, noList, actSections, actIndexUrls, isFeedHash, FEED_HASH,
        // 封面加载不出来就藏(纯函数 + 控制器)
        covers, makeCovers, makeCoverHosts, coverHost, coverCands, coverClass, coverVerdict, coverGuard, coverControls, coverProbe, coverProbeUrl, coverHead, cleanAlt, searchAlts, cvDirective,
        focusMark, focusBack, rowMark, rowBack, anchorMark, anchorBack,
        COVER: Object.freeze({ MIN: CV_MIN, TTL_MS: CV_TTL_MS, KEY: CV_KEY, ALT_MAX: CV_ALT_MAX, PROBE_MS: CV_PROBE_MS, RETRY_MS: CV_RETRY_MS, ROUND2_MS: CV_ROUND2_MS,
            STALL_MS: CV_STALL_MS, STALL_OK_MS: CV_STALL_OK_MS, REUSE_MS: CV_REUSE_MS, GUARD_MS: CV_GUARD_MS, GUARD_N: CV_GUARD_N, FREEZE_MS: CV_FREEZE_MS, BEAT_MS: CV_BEAT_MS,
            KICK_MS: CV_KICK_MS, PAR: CV_PAR, STRIKE_SPAN: CV_STRIKE_SPAN, STRIKE_TTL: CV_STRIKE_TTL, NEW_MAX: CV_NEW_MAX, NEW_WIN: CV_NEW_WIN, RECHECK_FIRST: CV_RECHECK_FIRST, RECHECK_MS: CV_RECHECK_MS }),
        _hooks: hooks, _bridge: bridge,
    };
});
