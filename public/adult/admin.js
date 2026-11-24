// [adult] 过滤规则后台(public/adult/admin.html,GET /admin/adult)。
//   令牌:输入后只放 sessionStorage(dgx_admin_token);每个请求带 X-Admin-Token。服务器:404 NOT_AVAILABLE = 后台关着(ADULT_ADMIN_TOKEN / ADMIN_TOKEN 都没设,或 ADULT_ADMIN_TOKEN=off)、
//   401 BAD_TOKEN = 令牌不对、429 LOCKED = 10 分钟内错 5 次被锁。
//   七个页签:概览(stats)/ 规则测试(test)/ 附加屏蔽词(block-words,只能更严)/ 隐藏作品(hidden、hide)/ 资源站(sites、site)/ TG 频道(tg、tg/sync)/ 镜像(mirrors、mirror/probe、mirror/reset)。
//   所有服务器字符串一律 textContent / setAttribute(值),绝不拼 HTML;链接一律不做成 <a>(服务器给的地址只显示成文字)。
//   纯函数与渲染在 node 里可 require(scripts/adult-privacy-test.mjs 用桩 DOM 测转义)。
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && typeof root === 'object' && root.document && !root.__dgAdminNoBoot) {
        const go = () => { try { const el = root.document.getElementById('dgx-admin'); if (el) api.boot(root.document, el); } catch (e) { try { console.error('[admin] boot 失败', e); } catch (_) { } } };
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', go);
        else go();
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
    'use strict';
    const TOKEN_KEY = 'dgx_admin_token';
    const BASE = '/api/adult/admin';
    const MAX_WORDS = 500, WORD_MIN = 2, WORD_MAX = 40;
    const TABS = [
        ['overview', '概览'], ['test', '规则测试'], ['words', '附加屏蔽词'], ['hidden', '隐藏作品'], ['sites', '资源站'], ['tg', 'TG 频道'], ['mirrors', '镜像'],
    ];

    // ---------- 纯函数 ----------
    const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
    function asArray(x, keys) {
        if (Array.isArray(x)) return x;
        if (isObj(x)) for (const k of keys || []) if (Array.isArray(x[k])) return x[k];
        return [];
    }
    function str(v, max) { const s = v == null ? '' : String(v); return max && s.length > max ? s.slice(0, max) + '…' : s; }
    function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
    function fmtNum(v) { const n = num(v); return n == null ? '—' : n.toLocaleString('zh-CN'); }
    // 时间:毫秒 / 秒 / ISO 字符串都认;0 / 空 = 「—」
    function toMs(v) {
        if (v == null || v === '' || v === 0) return 0;
        if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
        const n = Number(v);
        if (Number.isFinite(n) && String(v).trim() !== '') return n < 1e11 ? n * 1000 : n;
        const t = Date.parse(String(v));
        return Number.isFinite(t) ? t : 0;
    }
    function fmtAgo(v, now) {
        const t = toMs(v);
        if (!t) return '—';
        const d = Math.max(0, (now || Date.now()) - t) / 1000;
        if (d < 60) return '刚刚';
        if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
        if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
        return Math.floor(d / 86400) + ' 天前';
    }
    function fmtTime(v) {
        const t = toMs(v);
        if (!t) return '—';
        const d = new Date(t), p = (x) => (x < 10 ? '0' : '') + x;
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    // 概览「拦截原因」每一项的白话说明(原因码来自 lib/site-catalog/writer.js 的 rej() 和 lib/adult/policy.js 的 reason)
    const REASON_NOTE = {
        'category': '资源站自己的分类名就在硬过滤名单上(偷拍/偷窥、萝莉/学生、迷奸/下药、换脸/明星、黑料/流出、人兽…),整个分类不收',
        'mainstream': '普通影视(电视剧 / 电影 / 动漫等非成人内容)或非视频(小说 / 图片),不收',
        'noclass': '读不到这个站的分类表(站点暂时打不开),这批条目先跳过,下次再收',
        'bucket': '分类不在 17 个导航分区里,不收',
        'invalid': '条目数据不完整(没有 ID 或片名)',
        'error': '处理时出错(看服务器日志)',
        'policy-error': '过滤规则执行出错,按拦截处理',
        'policy': '过滤规则拦截',
        'avdb-block': '有番号的日本片:AVDB 的标签里有硬过滤项(学生 / JK / 制服、偷拍、迷药 / 睡眠 / 昏迷、流出…),片名看着正常也拦',
        'avdb-review': '有番号的日本片:AVDB 标为审查级(擦边题材),不收',
        'review': '擦边片名(学生 / 少女 / 处女 / 18岁…,或 操晕 / 失神 / 强奸乱伦 类):只有能核实番号的正规片商作品才收',
        'review:hide': '靠近未成年的词(学生 / 少女 / 处女 / 18岁 / cos…):一律不收,有番号也不行',
        'review:code': '擦边题材(操晕 / 失神、强奸乱伦分类…):只有能核实番号的正规片商作品才收',
        'item:minor': '硬过滤:片名 / 简介涉及未成年',
        'item:voyeur': '硬过滤:偷拍 / 偷窥 / 监控 / 针孔',
        'item:drugging': '硬过滤:迷奸 / 下药 / 迷药 / 昏迷',
        'item:deepfake': '硬过滤:换脸 / AI 合成 / 明星脸',
        'item:bestiality': '硬过滤:人兽',
        'item:leak': '硬过滤:真人私密泄露(黑料 / 网曝 / 流出 / 前任…)',
        'item:filter': '探花 / 反差 / 私房一类,又带 前女友 / 真名 / 偷录 / 不知情 等非自愿迹象',
        'item:strict': '严格站:AI 改写的片名(占位番号)或仿写的「泄露 / 曝光」简介',
        'item:admin': '命中后台的「附加屏蔽词」',
    };
    function reasonNote(code) {
        const k = String(code == null ? '' : code);
        if (Object.prototype.hasOwnProperty.call(REASON_NOTE, k)) return REASON_NOTE[k];
        return k.indexOf('item:') === 0 ? '硬过滤' : '';
    }
    // 概览的「片库历史回填」卡片:服务器 history{enabled,running,sites,started,done,pages,pagesTotal,etaMs,startedAt,finishedAt} → 显示用的几段字;没有 / 关了 → null 或一句说明
    function fmtDur(ms) {
        const m = Math.round((num(ms) || 0) / 60000);
        if (m < 1) return '不到 1 分钟';
        if (m < 60) return m + ' 分钟';
        const hh = Math.floor(m / 60), mm = m % 60;
        return hh < 48 ? hh + ' 小时' + (mm ? ' ' + mm + ' 分' : '') : Math.round(hh / 24) + ' 天';
    }
    function historyView(x) {
        if (!x || typeof x !== 'object') return null;
        const sites = num(x.sites) || 0, done = num(x.done) || 0, pages = num(x.pages) || 0, total = num(x.pagesTotal) || 0;
        if (x.enabled === false) return { pct: '关', sites: done + ' / ' + sites, eta: '—', done: false, note: '全量回填关着(CATALOG_BACKFILL=0):片库只有爬虫抓到的最新作品' };
        const all = sites > 0 && done >= sites;
        const pct = all ? '100%' : total > 0 ? Math.min(99.9, Math.floor(pages * 1000 / total) / 10) + '%' : '—';
        const note = all ? '全部站点的历史作品都已收录;之后只按新上架增量更新'
            : (num(x.started) || 0) < sites ? '还有 ' + (sites - (num(x.started) || 0)) + ' 个站在等第一轮增量爬完才开始回填;预计时间按已开始的站估'
            : '每个站按 ' + fmtNum(pages) + ' / ' + fmtNum(total) + ' 页的进度慢慢翻(同一域名几秒一页);预计时间按最慢那个站估';
        return { pct, sites: done + ' / ' + sites, eta: all ? fmtTime(x.finishedAt) : (num(x.etaMs) ? fmtDur(x.etaMs) : '—'), done: all, note };
    }
    // ---- TG 频道页 ----
    function fmtBytes(v) {
        const n = num(v) || 0;
        if (n >= 1073741824) return (Math.round(n / 107374182.4) / 10) + ' GB';
        if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
        return n > 0 ? '< 1 MB' : '0';
    }
    // 停用原因(lib/site-catalog/tg-sync.js 写的 why):'频道名/简介 item:minor' / '未成年 4/160'
    function tgKillText(why) {
        const w = str(why, 200);
        if (!w) return '';
        let m = /^频道名\/简介\s+(\S+)/.exec(w);
        if (m) return '频道名或简介命中硬过滤(' + (reasonNote(m[1]) || m[1]) + ')';
        m = /^未成年\s+(\d+)\/(\d+)/.exec(w);
        if (m) return '有正文的 ' + m[2] + ' 条帖子里 ' + m[1] + ' 条涉及未成年(≥2 条且 ≥2% 就整个频道停用)';
        return w;
    }
    // 进度:cur = 已读到的消息编号,top = 频道最新一条的编号(编号不连续,百分比是估的)
    function tgProgress(c) {
        const cur = num(c && c.cur) || 0, top = num(c && c.top) || 0;
        if (!cur && !top) return { text: '还没开始', pct: 0, done: false };
        if (top > 0 && cur >= top) return { text: '已读完(#' + fmtNum(top) + ')', pct: 100, done: true };
        if (top > 0) { const pct = Math.min(99, Math.floor(cur * 100 / top)); return { text: '#' + fmtNum(cur) + ' / #' + fmtNum(top) + '(约 ' + pct + '%)', pct, done: false }; }
        return { text: '读到 #' + fmtNum(cur), pct: 0, done: false };
    }
    const TG_SKIP = { short: '太短', notext: '没正文', mime: '不是 mp4', invalid: '数据不全' };
    function tgSkipText(sk, rej) {
        const parts = [];
        if (isObj(sk)) Object.keys(sk).sort((a, b) => (num(sk[b]) || 0) - (num(sk[a]) || 0)).slice(0, 8).forEach((k) => { const n = num(sk[k]) || 0; if (n > 0) parts.push((Object.prototype.hasOwnProperty.call(TG_SKIP, k) ? TG_SKIP[k] : str(k, 20)) + ' ' + fmtNum(n)); });
        if ((num(rej) || 0) > 0) parts.push('规则拦 ' + fmtNum(rej));
        return parts.join(' · ');
    }
    const wordLen = (w) => Array.from(String(w)).length;
    // 附加屏蔽词:一行一个(也认中英文逗号);去空白、去重(不分大小写),逐条查 2..40 字、≤500 个
    function parseWords(text) {
        const seen = new Set(), words = [], errors = [];
        String(text || '').split(/[\r\n,，]+/).forEach((raw) => {
            const w = raw.replace(/\s+/g, ' ').trim();
            if (!w) return;
            if (/[\u0000-\u001f\u007f]/.test(w)) { errors.push('含控制字符：' + str(w, 20)); return; }
            const n = wordLen(w);
            if (n < WORD_MIN || n > WORD_MAX) { errors.push('「' + str(w, 20) + '」长度 ' + n + '（要 ' + WORD_MIN + '–' + WORD_MAX + ' 字）'); return; }
            const k = w.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            words.push(w);
        });
        if (words.length > MAX_WORDS) errors.push('最多 ' + MAX_WORDS + ' 个，现在 ' + words.length + ' 个');
        return { words, errors };
    }
    // 出错 → 给人看的话
    function errText(r, ctx) {
        if (!r) return '出错了';
        const code = r.data && typeof r.data.error === 'string' ? r.data.error : '';
        const detail = r.data && typeof r.data.detail === 'string' ? r.data.detail : '';
        if (r.kind === 'network') return '连不上服务器';
        if (r.status === 404 && (code === 'NOT_AVAILABLE' || ctx === 'auth')) return '后台没有开启：服务器没有设置 ADULT_ADMIN_TOKEN 或 ADMIN_TOKEN（或设了 ADULT_ADMIN_TOKEN=off）';
        if (r.status === 401) return '管理令牌不对';
        if (r.status === 429) return '失败次数太多，已暂时锁定（约 10 分钟），请稍后再试';
        if (r.status === 404 && code === 'UNKNOWN_SITE') return '没有这个资源站';
        if (r.status === 404) return '没找到';
        if (r.status === 503) return '服务暂不可用（' + (code || '503') + '）';
        if (r.status === 400) return '输入不对' + (detail ? '：' + str(detail, 120) : (code ? '（' + code + '）' : ''));
        return 'HTTP ' + r.status + (code ? '（' + str(code, 40) + '）' : '');
    }
    // 统一的请求:{ ok, status, data, kind } 绝不抛
    function createClient(fetchFn, getToken) {
        return async function call(method, path, body) {
            const headers = { 'Accept': 'application/json', 'X-Admin-Token': String(getToken() || '') };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            let r;
            try { r = await fetchFn(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' }); }
            catch (e) { return { ok: false, status: 0, kind: 'network', data: null }; }
            let text = '';
            try { text = await r.text(); } catch (e) { }
            let data = null;
            if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
            if (r.ok) return { ok: true, status: r.status, data, kind: 'ok' };
            return { ok: false, status: r.status, data, kind: r.status === 401 ? 'auth' : r.status === 429 ? 'locked' : r.status === 404 ? 'notfound' : 'error' };
        };
    }

    // ---------- 渲染 ----------
    function boot(doc, mount, opts) {
        opts = opts || {};
        const W = opts.window || root;
        const fetchFn = opts.fetch || ((u, o) => W.fetch(u, o));
        const ss = (() => { try { return W.sessionStorage || null; } catch (e) { return null; } })();
        let memToken = '';
        const getToken = () => { try { return (ss && ss.getItem(TOKEN_KEY)) || memToken; } catch (e) { return memToken; } };
        const setToken = (t) => { memToken = t || ''; try { if (!ss) return; if (t) ss.setItem(TOKEN_KEY, t); else ss.removeItem(TOKEN_KEY); } catch (e) { } };
        const call = createClient(fetchFn, getToken);
        // 嵌在站长后台 /admin 的「片库管理」页签里(?embed=1):不出自己的标题和「退出」(外层后台管登录 / 退出,令牌同一个 sessionStorage 键)
        try { if (/[?&]embed=1(&|$)/.test(String((W.location && W.location.search) || '')) && doc.body && doc.body.classList) doc.body.classList.add('adm-embed'); } catch (e) { }

        function h(tag, attrs, kids) {
            const el = doc.createElement(tag);
            if (attrs) {
                for (const k of Object.keys(attrs)) {
                    const v = attrs[k];
                    if (v == null || v === false) continue;
                    if (k === 'class') el.className = String(v);
                    else if (k === 'text') el.textContent = String(v);
                    else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
                    else if (k === 'value') el.value = String(v);
                    else if (k === 'disabled' || k === 'checked') el[k] = !!v;
                    else el.setAttribute(k, v === true ? '' : String(v));
                }
            }
            if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach((c) => { if (c == null || c === false) return; el.appendChild(typeof c === 'object' ? c : doc.createTextNode(String(c))); });
            return el;
        }
        const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
        const msg = (text, kind) => h('div', { class: 'adm-msg' + (kind ? ' ' + kind : ''), role: kind === 'err' ? 'alert' : 'status' }, text || '');
        const pill = (text, kind) => h('span', { class: 'adm-pill' + (kind ? ' ' + kind : '') }, text);
        function table(cols, rows) {
            const thead = h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col' }, c.l))));
            const tbody = h('tbody', null, rows.map((r) => h('tr', null, cols.map((c) => {
                const v = c.f(r);
                return h('td', c.num ? { class: 'num' } : (c.mono ? { class: 'mono' } : null), (v != null && typeof v === 'object') ? v : str(v == null ? '—' : v));
            }))));
            return h('div', { class: 'adm-tablewrap' }, h('table', { class: 'adm-t' }, [thead, tbody]));
        }
        // 任意 JSON → dl(深度 ≤3、每层 ≤50 项);只用 textContent
        function kv(v, depth) {
            depth = depth || 0;
            if (v == null) return h('span', { class: 'adm-note' }, '—');
            if (typeof v !== 'object') return h('span', null, typeof v === 'boolean' ? (v ? '是' : '否') : str(v, 400));
            if (depth >= 3) return h('span', { class: 'mono' }, str(JSON.stringify(v), 400));
            if (Array.isArray(v)) {
                if (!v.length) return h('span', { class: 'adm-note' }, '（空）');
                if (v.every((x) => x == null || typeof x !== 'object')) return h('span', null, v.slice(0, 50).map((x) => str(x, 80)).join('、') + (v.length > 50 ? ' …（共 ' + v.length + '）' : ''));
                return h('div', null, v.slice(0, 50).map((x) => kv(x, depth + 1)));
            }
            const keys = Object.keys(v).slice(0, 50);
            if (!keys.length) return h('span', { class: 'adm-note' }, '（空）');
            return h('dl', { class: 'adm-kv' }, keys.reduce((a, k) => { a.push(h('dt', null, str(k, 60))); a.push(h('dd', null, kv(v[k], depth + 1))); return a; }, []));
        }

        // 骨架:头部(退出) / 令牌表单 / 页签 / 面板
        const head = mount.querySelector ? mount.querySelector('.adm-head') : null;
        const outBtn = h('button', { type: 'button', class: 'adm-btn small adm-out', hidden: true }, '退出');
        if (head) head.appendChild(outBtn); else mount.appendChild(outBtn);
        const authBox = h('section', { class: 'adm-card', 'aria-labelledby': 'adm-auth-h' });
        const tabsBar = h('div', { class: 'adm-tabs', role: 'tablist', 'aria-label': '后台页签', hidden: true });
        const panel = h('section', { class: 'adm-panel', role: 'tabpanel', tabindex: '-1', hidden: true });
        mount.appendChild(authBox); mount.appendChild(tabsBar); mount.appendChild(panel);
        let current = 'overview', seq = 0;

        function showAuth(note, kind) {
            clear(authBox);
            authBox.removeAttribute('hidden');
            tabsBar.setAttribute('hidden', ''); panel.setAttribute('hidden', ''); outBtn.setAttribute('hidden', '');
            const inp = h('input', { class: 'adm-in', id: 'adm-token', type: 'password', autocomplete: 'off', spellcheck: 'false', required: true, maxlength: '512' });
            const btn = h('button', { type: 'submit', class: 'adm-btn pri' }, '进入');
            const form = h('form', null, [
                h('div', { class: 'adm-row' }, [h('div', { class: 'adm-grow' }, [h('label', { class: 'adm-lbl', for: 'adm-token' }, '管理令牌（服务器的 ADULT_ADMIN_TOKEN；没设则是 ADMIN_TOKEN）'), inp]), btn]),
            ]);
            const m = msg(note || '', kind);
            form.addEventListener('submit', async (e) => {
                if (e && e.preventDefault) e.preventDefault();
                const t = String(inp.value || '').trim();
                if (!t) { m.textContent = '请输入令牌'; m.className = 'adm-msg err'; return; }
                btn.disabled = true; m.className = 'adm-msg'; m.textContent = '验证中…';
                setToken(t);
                const r = await call('GET', '/stats');
                btn.disabled = false;
                if (r.ok) { inp.value = ''; showApp('overview', r); return; }
                if (r.status === 401 || r.status === 429 || r.status === 404) setToken('');
                m.className = 'adm-msg err'; m.textContent = errText(r, 'auth');
            });
            authBox.appendChild(h('h2', { id: 'adm-auth-h' }, '登录后台'));
            authBox.appendChild(h('p', null, '令牌只存在这个标签页里（关掉就没了），不会写进本机存储。'));
            authBox.appendChild(form);
            authBox.appendChild(m);
            try { inp.focus(); } catch (e) { }
        }
        outBtn.addEventListener('click', () => { setToken(''); showAuth('已退出', 'ok'); });

        function showApp(tab, preload) {
            authBox.setAttribute('hidden', '');
            tabsBar.removeAttribute('hidden'); panel.removeAttribute('hidden'); outBtn.removeAttribute('hidden');
            clear(tabsBar);
            TABS.forEach(([k, l], i) => {
                const b = h('button', { type: 'button', class: 'adm-tab', role: 'tab', id: 'adm-tab-' + k, 'aria-controls': 'adm-panel', 'aria-selected': k === tab ? 'true' : 'false', tabindex: k === tab ? '0' : '-1', 'data-tab': k }, l);
                b.addEventListener('click', () => select(k));
                b.addEventListener('keydown', (e) => {
                    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                    if (e.preventDefault) e.preventDefault();
                    const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
                    select(n, true);
                });
                tabsBar.appendChild(b);
            });
            panel.setAttribute('id', 'adm-panel');
            select(tab, false, preload);
        }
        function select(tab, focusTab, preload) {
            current = tab;
            Array.from(tabsBar.children || []).forEach((b) => {
                const on = b.getAttribute('data-tab') === tab;
                b.setAttribute('aria-selected', on ? 'true' : 'false');
                b.setAttribute('tabindex', on ? '0' : '-1');
                if (on) { panel.setAttribute('aria-labelledby', b.getAttribute('id')); if (focusTab) { try { b.focus(); } catch (e) { } } }
            });
            return load(tab, preload);
        }
        // 公共:加载中 / 失败(401/429/404 关闭 → 回登录)
        function failed(r, box) {
            if (r.status === 401 || r.status === 429 || (r.status === 404 && r.data && r.data.error === 'NOT_AVAILABLE')) {
                if (r.status !== 429) setToken('');
                showAuth(errText(r, 'auth'), 'err');
                return true;
            }
            clear(box);
            box.appendChild(msg(errText(r), 'err'));
            return false;
        }
        async function load(tab, preload) {
            const my = ++seq;
            clear(panel);
            const box = h('div');
            panel.appendChild(box);
            box.appendChild(msg('加载中…'));
            const fn = VIEWS[tab] || VIEWS.overview;
            try { await fn(box, () => my === seq && current === tab, preload); }
            catch (e) { if (my === seq) { clear(box); box.appendChild(msg('页面出错：' + str(e && e.message, 120), 'err')); } }
        }
        const refreshBtn = (fn) => h('button', { type: 'button', class: 'adm-btn small', onclick: fn }, '刷新');
        // 重新抓取(key = null:全部在爬的站):先确认,POST /recrawl,结果写进 m;成功后 after()
        async function recrawl(key, btn, m, after) {
            const what = key ? '把 ' + str(key, 64) + ' 的历史从第 1 页重新翻一遍' : '把全部站的历史从第 1 页重新翻一遍(约 14 小时)';
            let yes = true;
            try { if (W && typeof W.confirm === 'function') yes = !!W.confirm(what + '?\n期间网站照常可用;按当前过滤规则重新收录,硬过滤照样拦。'); } catch (e) { yes = true; }
            if (!yes) return;
            btn.disabled = true;
            const x = await call('POST', '/recrawl', key ? { key } : {});
            btn.disabled = false;
            if (!x.ok) { if (m) { m.className = 'adm-msg err'; m.textContent = x.data && x.data.error === 'backfill-off' ? '全量回填关着(CATALOG_BACKFILL=0),没法重新抓取' : errText(x); } return; }
            if (m) { m.className = 'adm-msg ok'; m.textContent = '已开始:' + fmtNum(x.data && x.data.sites) + ' 个站从第 1 页重新抓取'; }
            if (typeof after === 'function') after();
        }

        const VIEWS = {
            // ① 概览
            async overview(box, alive, preload) {
                const r = preload && preload.ok ? preload : await call('GET', '/stats');
                if (!alive()) return;
                if (!r.ok) return failed(r, box);
                const d = isObj(r.data) ? r.data : {};
                const sites = asArray(d.sites);
                const on = sites.filter((s) => s && s.active !== false).length, bad = sites.filter((s) => s && num(s.fails) > 0).length;
                const xb = isObj(d.extraBlock) ? d.extraBlock : {};
                clear(box);
                const stat = (v, l) => h('div', { class: 'adm-stat' }, [h('b', null, v), h('span', null, l)]);
                box.appendChild(h('div', { class: 'adm-card' }, [
                    h('div', { class: 'adm-row' }, [h('h2', { class: 'adm-grow' }, '概览'), refreshBtn(() => load('overview'))]),
                    d.catalog === false ? msg('目录（catalog.db）没在运行：作品数 / 拦截统计暂时没有', 'warn') : null,
                    h('div', { class: 'adm-stats' }, [
                        stat(fmtNum(d.works), '可见作品'), stat(fmtNum(d.lines), '线路'),
                        stat(on + ' / ' + sites.length, '资源站 启用 / 全部'), stat(String(bad), '最近有失败的站'),
                        stat(fmtNum(xb.n), '附加屏蔽词'), stat(fmtNum(d.mirrors), '在用镜像'),
                    ]),
                    xb.rev ? h('p', { class: 'adm-note' }, '附加屏蔽词版本 ' + str(xb.rev, 40)) : null,
                ]));
                const hb = historyView(d.history);
                if (hb) {
                    const hm = msg('');
                    const rb = h('button', { type: 'button', class: 'adm-btn small' }, '全部重新抓取');
                    rb.addEventListener('click', () => recrawl(null, rb, hm, () => load('overview')));
                    box.appendChild(h('div', { class: 'adm-card' }, [
                        h('div', { class: 'adm-row' }, [h('h2', { class: 'adm-grow' }, '片库历史回填'), rb]),
                        h('div', { class: 'adm-stats' }, [stat(hb.pct, '已翻页数'), stat(hb.sites, '站 翻完 / 启用'), stat(hb.eta, hb.done ? '完成时间' : '预计还要')]),
                        h('p', { class: 'adm-note' }, hb.note),
                        h('p', { class: 'adm-note' }, '被拦的条目从来不入库:修好误拦的规则、删了附加屏蔽词之后,以前拦掉、现在允许的片要「重新抓取」才回来(按当前规则重新过一遍,硬过滤照样拦)。'),
                        hm,
                    ]));
                }
                const rej = isObj(d.rejected) ? Object.keys(d.rejected).map((k) => [k, num(d.rejected[k]) || 0]).sort((a, b) => b[1] - a[1]) : [];
                box.appendChild(h('div', { class: 'adm-card' }, [
                    h('h2', null, '拦截原因(本次启动以来)'),
                    h('p', { class: 'adm-note' }, '按源站条目计(同一部片在几个站上算几条)。数字只存在内存里,服务器重启后从 0 开始;片库里已经有的作品不受影响。内置的硬过滤关不掉,只能在「附加屏蔽词」里再加严。'),
                    rej.length ? table([{ l: '原因', f: (x) => x[0], mono: true }, { l: '说明', f: (x) => reasonNote(x[0]) || '—' }, { l: '条数', f: (x) => fmtNum(x[1]), num: true }], rej.slice(0, 200)) : h('p', null, '没有数据'),
                ]));
                box.appendChild(h('div', { class: 'adm-card' }, [h('h2', null, '规则重扫'), kv(d.rescan)]));
                if (isObj(d.purge)) box.appendChild(h('div', { class: 'adm-card' }, [h('h2', null, '附加屏蔽词:删除命中线路'), kv(d.purge)]));
                box.appendChild(h('div', { class: 'adm-card' }, [h('h2', null, 'AVDB 元数据'), kv(d.avdb)]));
            },
            // ② 规则测试
            async test(box, alive) {
                clear(box);
                const ti = h('input', { class: 'adm-in', id: 'adm-t-title', type: 'text', maxlength: '400', required: true, autocomplete: 'off' });
                const tn = h('input', { class: 'adm-in', id: 'adm-t-type', type: 'text', maxlength: '60', autocomplete: 'off', placeholder: '可不填' });
                const go = h('button', { type: 'submit', class: 'adm-btn pri' }, '测试');
                const out = h('div', { 'aria-live': 'polite' });
                const form = h('form', null, [
                    h('div', { class: 'adm-row' }, [
                        h('div', { class: 'adm-grow' }, [h('label', { class: 'adm-lbl', for: 'adm-t-title' }, '片名 / 搜索词'), ti]),
                        h('div', { style: 'flex: 0 1 200px; min-width: 140px;' }, [h('label', { class: 'adm-lbl', for: 'adm-t-type' }, '分类名（type_name）'), tn]),
                        go,
                    ]),
                ]);
                form.addEventListener('submit', async (e) => {
                    if (e && e.preventDefault) e.preventDefault();
                    const title = String(ti.value || '');
                    if (!title.trim()) { clear(out); out.appendChild(msg('请输入片名', 'err')); return; }
                    go.disabled = true;
                    clear(out); out.appendChild(msg('测试中…'));
                    const r = await call('POST', '/test', { title, type_name: String(tn.value || '') });
                    go.disabled = false;
                    if (!alive()) return;
                    if (!r.ok) return failed(r, out);
                    clear(out);
                    out.appendChild(renderVerdict(isObj(r.data) ? r.data : {}));
                });
                box.appendChild(h('div', { class: 'adm-card' }, [
                    h('h2', null, '规则测试'),
                    h('p', null, '输入一个片名（和可选的分类名），看内置规则 + 附加屏蔽词怎么判。不写库、不影响线上。'),
                    form, out,
                ]));
                try { ti.focus(); } catch (e) { }
            },
            // ③ 附加屏蔽词
            async words(box, alive) {
                const r = await call('GET', '/block-words');
                if (!alive()) return;
                if (!r.ok) return failed(r, box);
                const d = isObj(r.data) ? r.data : {};
                const list = asArray(d.words, ['words']).filter((w) => typeof w === 'string');
                clear(box);
                const ta = h('textarea', { class: 'adm-in', id: 'adm-words', spellcheck: 'false', 'aria-describedby': 'adm-words-help' });
                ta.value = list.join('\n');
                const info = h('div', { class: 'adm-note', 'aria-live': 'polite' });
                const m = msg('');
                const save = h('button', { type: 'button', class: 'adm-btn pri' }, '保存');
                const recount = () => { const p = parseWords(ta.value); info.textContent = p.words.length + ' 个词' + (p.errors.length ? '，' + p.errors.length + ' 处要改' : ''); return p; };
                ta.addEventListener('input', recount);
                save.addEventListener('click', async () => {
                    const p = recount();
                    if (p.errors.length) { m.className = 'adm-msg err'; m.textContent = p.errors.slice(0, 5).join(';'); return; }
                    save.disabled = true; m.className = 'adm-msg'; m.textContent = '保存中…';
                    const w = await call('PUT', '/block-words', { words: p.words });
                    save.disabled = false;
                    if (!w.ok) { if (w.status === 401 || w.status === 429) return failed(w, box); m.className = 'adm-msg err'; m.textContent = errText(w); return; }
                    const x = isObj(w.data) ? w.data : {};
                    m.className = 'adm-msg ok';
                    m.textContent = '已保存 ' + (num(x.n) != null ? x.n : p.words.length) + ' 个词' + (x.rev ? '（版本 ' + str(x.rev, 24) + '）' : '') + '；已立即生效（列表、作品页、搜索都按片名拦），目录在后台删除命中的线路（删词不会恢复已删掉的线路）';
                    if (Array.isArray(x.words)) ta.value = x.words.filter((s) => typeof s === 'string').join('\n');
                    recount();
                });
                box.appendChild(h('div', { class: 'adm-card' }, [
                    h('div', { class: 'adm-row' }, [h('h2', { class: 'adm-grow' }, '附加屏蔽词'), refreshBtn(() => load('words'))]),
                    h('p', { id: 'adm-words-help' }, '一行一个词（' + WORD_MIN + '–' + WORD_MAX + ' 字，最多 ' + MAX_WORDS + ' 个）。片名或搜索词里出现就拦。这里只能让规则更严：内置的禁止规则一条都改不了、也放宽不了；删掉这里的词只是撤销你自己加的拦截：保存时命中的线路会被目录删掉，删词后不会马上回来，要等之后抓取或搜索重新收录。'),
                    h('label', { class: 'adm-lbl', for: 'adm-words' }, '词表'), ta, info,
                    h('div', { class: 'adm-row', style: 'margin-top: 10px;' }, [save]), m,
                ]));
                recount();
            },
            // ④ 隐藏作品
            async hidden(box, alive) {
                const r = await call('GET', '/hidden');
                if (!alive()) return;
                if (!r.ok) return failed(r, box);
                const list = asArray(r.data, ['items', 'hidden']).filter((x) => isObj(x) && typeof x.wk === 'string');
                clear(box);
                const wk = h('input', { class: 'adm-in mono', id: 'adm-wk', type: 'text', maxlength: '300', autocomplete: 'off', spellcheck: 'false', placeholder: '作品键，如 c:ABC-123' });
                const hideBtn = h('button', { type: 'submit', class: 'adm-btn pri' }, '隐藏');
                const m = msg('');
                const form = h('form', null, h('div', { class: 'adm-row' }, [h('div', { class: 'adm-grow' }, [h('label', { class: 'adm-lbl', for: 'adm-wk' }, '按作品键隐藏'), wk]), hideBtn]));
                const act = async (key, on, btn) => {
                    if (btn) btn.disabled = true;
                    const x = await call('POST', '/hide', { wk: key, on });
                    if (btn) btn.disabled = false;
                    if (!x.ok) { if (x.status === 401 || x.status === 429) return failed(x, box); m.className = 'adm-msg err'; m.textContent = x.status === 404 ? '没有这个作品' : errText(x); return; }
                    await VIEWS.hidden(box, alive);
                    const mm = box.querySelector ? box.querySelector('[data-adm-msg]') : null;
                    if (mm) { mm.className = 'adm-msg ok'; mm.textContent = on ? '已隐藏' : '已取消隐藏'; }
                };
                form.addEventListener('submit', (e) => {
                    if (e && e.preventDefault) e.preventDefault();
                    const k = String(wk.value || '').trim();
                    if (!k || k.length > 300) { m.className = 'adm-msg err'; m.textContent = '请输入作品键'; return; }
                    act(k, true, hideBtn);
                });
                m.setAttribute('data-adm-msg', '1');
                const rows = list.map((x) => ({ x, btn: null }));
                const cols = [
                    { l: '片名', f: (o) => str(o.x.name || '—', 120) },
                    { l: '作品键', f: (o) => str(o.x.wk, 300), mono: true },
                    { l: '隐藏于', f: (o) => fmtTime(o.x.at) },
                    { l: '', f: (o) => { const b = h('button', { type: 'button', class: 'adm-btn small' }, '取消隐藏'); b.addEventListener('click', () => act(o.x.wk, false, b)); return b; } },
                ];
                box.appendChild(h('div', { class: 'adm-card' }, [
                    h('div', { class: 'adm-row' }, [h('h2', { class: 'adm-grow' }, '隐藏作品'), refreshBtn(() => load('hidden'))]),
                    h('p', null, '隐藏的作品在所有列表、短片流、相关推荐、搜索建议里都不出现，打开作品页也是 404。片名现在已被规则拦下的不在这里列出。'),
                    form, m,
                    rows.length ? table(cols, rows) : h('p', null, '没有隐藏的作品'),
                ]));
            },
            // ⑤ 资源站
            async sites(box, alive) {
                const r = await call('GET', '/sites');
                if (!alive()) return;
                if (!r.ok) return failed(r, box);
                const list = asArray(r.data, ['sites', 'items']).filter((s) => isObj(s) && typeof s.key === 'string');
                clear(box);
                const m = msg('');
                const now = Date.now();
                const stateOf = (s) => {
                    if (s.active !== false) return pill('启用', 'ok');
                    if (s.overrideActive === false) return pill('后台停用', 'warn');
                    return pill('配置里停用', 'bad');
                };
                const btnOf = (s) => {
                    let label, next, dis = false;
                    if (s.active !== false) { label = '停用'; next = false; }
                    else if (s.overrideActive === false) { label = '撤销停用'; next = true; }
                    else { label = '启用'; next = true; dis = true; }
                    const b = h('button', { type: 'button', class: 'adm-btn small' + (next ? '' : ' danger'), disabled: dis, title: dis ? '站点表（db）里就是停用的，后台开不了' : null }, label);
                    b.addEventListener('click', async () => {
                        b.disabled = true;
                        const x = await call('POST', '/site', { key: s.key, active: next });
                        if (!x.ok) { b.disabled = false; if (x.status === 401 || x.status === 429) return failed(x, box); m.className = 'adm-msg err'; m.textContent = errText(x); return; }
                        await VIEWS.sites(box, alive);
                    });
                    return b;
                };
                const cols = [
                    { l: '站点', f: (s) => h('div', null, [h('div', null, str(s.name || s.key, 60)), h('div', { class: 'mono adm-note' }, str(s.key, 64))]) },
                    { l: '状态', f: stateOf },
                    { l: '最近成功', f: (s) => fmtAgo(s.lastOk, now) },
                    { l: '失败', f: (s) => fmtNum(s.fails), num: true },
                    { l: '当前接口', f: (s) => str(s.current || s.api || '—', 200), mono: true },
                    { l: '', f: (s) => {
                        const kids = [btnOf(s)];
                        if (s.active !== false) {
                            const rb = h('button', { type: 'button', class: 'adm-btn small', title: '这个站的历史从第 1 页重新翻一遍,把以前拦掉、现在允许的片找回来' }, '重新抓取');
                            rb.addEventListener('click', () => recrawl(s.key, rb, m, null));
                            kids.push(rb);
                        }
                        return h('div', { class: 'adm-row' }, kids);
                    } },
                ];
                box.appendChild(h('div', { class: 'adm-card' }, [
                    h('div', { class: 'adm-row' }, [h('h2', { class: 'adm-grow' }, '资源站'), refreshBtn(() => load('sites'))]),
                    h('p', null, '只能停用 / 撤销停用站点表里配好的站（立即生效、重启后保留）；站点表里本来就停用的站这里开不了。'),
                    m,
                    list.length ? table(cols, list) : h('p', null, '没有站点'),
                ]));
            },
            // ⑥ TG 频道
            async tg(box, alive) {
                const r = await call('GET', '/tg');
                if (!alive()) return;
                if (!r.ok) return failed(r, box);
                const d = isObj(r.data) ? r.data : {};
                const list = asArray(d.channels).filter((c) => isObj(c) && typeof c.key === 'string');
                const acc = isObj(d.account) ? d.account : null;
                clear(box);
                const now = Date.now();
                const m = msg('');
                const stat = (v, l) => h('div', { class: 'adm-stat' }, [h('b', null, v), h('span', null, l)]);
                const syncBtn = h('button', { type: 'button', class: 'adm-btn small', disabled: d.on === false, title: '马上同步一轮(出错退避中的频道也重试)' }, '立即同步');
                syncBtn.addEventListener('click', async () => {
                    syncBtn.disabled = true;
                    const x = await call('POST', '/tg/sync', {});
                    syncBtn.disabled = false;
                    if (!x.ok) { if (x.status === 401 || x.status === 429) return failed(x, box); m.className = 'adm-msg err'; m.textContent = x.data && x.data.error === 'TG_OFF' ? 'TG 频道没启用,先在服务器上配好环境变量' : errText(x); return; }
                    m.className = 'adm-msg ok'; m.textContent = '已开始同步。老频道每轮最多读 2000 条帖子,过一两分钟点「刷新」看进度。';
                });
                const card = [h('div', { class: 'adm-row' }, [h('h2', { class: 'adm-grow' }, 'TG 频道'), syncBtn, refreshBtn(() => load('tg'))])];
                const problems = asArray(d.problems).filter((p) => typeof p === 'string');
                if (d.on === false) card.push(msg('TG 频道没启用:' + (problems.length ? problems.map((p) => str(p, 120)).join(';') : '配置不完整') + '。在服务器上设置 ADULT_TG_RELAY / ADULT_TG_SECRET / ADULT_TG_CHANNELS 后重启网站(Docker 要重建容器才读得到新变量)。', 'warn'));
                if (d.on !== false && acc && acc.ok === false) card.push(msg('连不上中转:' + str(acc.err, 120), 'err'));
                if (acc && acc.ok) {
                    const accs = asArray(acc.accounts).filter(isObj);
                    card.push(h('div', { class: 'adm-stats' }, [
                        stat((num(acc.usable) || 0) + ' / ' + accs.length, '中转账号 可用 / 全部'),
                        stat(fmtNum(acc.streams), '正在转的视频'),
                        stat(fmtBytes(acc.cache && acc.cache.bytes) + ' / ' + fmtBytes(acc.cache && acc.cache.cap), '中转缓存 已用 / 上限'),
                        stat(fmtBytes(acc.fromTg), '中转启动以来从 TG 拉'),
                    ]));
                    if (accs.length) card.push(table([
                        { l: '账号', f: (a) => str(a.name, 40), mono: true },
                        { l: '状态', f: (a) => (a.dead ? pill('失效', 'bad') : !a.ok ? pill('连不上', 'bad') : (num(a.floodSec) || 0) > 0 ? pill('限流 ' + fmtNum(a.floodSec) + ' 秒', 'warn') : pill('可用', 'ok')) },
                        { l: '进行中', f: (a) => fmtNum(a.active), num: true },
                        { l: '完成请求', f: (a) => fmtNum(a.served), num: true },
                        { l: '出错', f: (a) => fmtNum(a.errors), num: true },
                        { l: '最近的错误', f: (a) => str(a.dead || a.lastErr || '—', 80), mono: true },
                    ], accs.slice(0, 200)));
                }
                if (d.relay) card.push(h('p', { class: 'adm-note' }, '中转地址 ' + str(d.relay, 200) + (num(d.minSec) ? ' · 短于 ' + fmtNum(d.minSec) + ' 秒的视频不收(ADULT_TG_MIN_SEC)' : '')));
                card.push(m);
                box.appendChild(h('div', { class: 'adm-card' }, card));
                const stateOf = (c) => {
                    if (c.killed) return pill('已停用', 'bad');
                    if (c.err) return h('div', null, [pill('出错', 'warn'), (num(c.nextAt) || 0) > now ? h('div', { class: 'adm-note' }, Math.max(1, Math.ceil((num(c.nextAt) - now) / 60000)) + ' 分钟后重试') : null]);
                    if (!num(c.at)) return pill('等第一次同步');
                    return tgProgress(c).done ? pill('已跟上', 'ok') : pill('收录中', 'ok');
                };
                const cols = [
                    { l: '频道', f: (c) => h('div', null, [h('div', null, str(c.title || c.ch, 80)), h('div', { class: 'mono adm-note' }, '@' + str(c.ch, 40) + (c.cls ? ' · ' + str(c.cls, 30) : ''))]) },
                    { l: '状态', f: stateOf },
                    { l: '读取进度', f: (c) => tgProgress(c).text },
                    { l: '读过的帖子', f: (c) => fmtNum(c.n), num: true },
                    { l: '收录', f: (c) => (c.items == null ? '—' : fmtNum(c.items)), num: true },
                    { l: '没收', f: (c) => tgSkipText(c.sk, c.rej) || '—' },
                    { l: '未成年命中', f: (c) => ((num(c.minor) || 0) > 0 ? pill(fmtNum(c.minor), 'warn') : '0') },
                    { l: '停用原因 / 错误', f: (c) => (c.killed ? h('div', null, [h('div', null, tgKillText(c.killed)), num(c.killedAt) ? h('div', { class: 'adm-note' }, fmtTime(c.killedAt) + ' 停用') : null]) : str(c.err || '—', 120)) },
                    { l: '上次同步', f: (c) => fmtAgo(c.at, now) },
                ];
                const killed = list.filter((c) => c.killed).length;
                const items = list.reduce((a, c) => a + (num(c.items) || 0), 0);
                box.appendChild(h('div', { class: 'adm-card' }, [
                    h('h2', null, '频道(' + list.length + ' 个' + (killed ? ',停用 ' + killed + ' 个' : '') + ',共收录 ' + fmtNum(items) + ' 条)'),
                    h('p', { class: 'adm-note' }, '每 10 分钟从中转读一次新帖子,老频道的历史每轮最多读 2000 条,分几轮收完。「读过的帖子」只算有正文的;太短、没正文的不收,命中规则的入库时被拦。「收录」是库里现在还在的线路数。'),
                    h('p', { class: 'adm-note' }, '停用是硬过滤的一部分:频道名 / 简介命中,或未成年 ≥2 条且 ≥2%,整个频道停用并删掉已收的,这里不提供恢复。TG 作品和资源站的一样进首页 / 相关 / 刷一刷 / 猜你喜欢(带审查级标签的照样只能筛选)。'),
                    list.length ? table(cols, list) : h('p', null, d.on === false ? '没有频道(TG 没启用)' : '没有频道'),
                ]));
            },
            // ⑦ 镜像
            async mirrors(box, alive) {
                const r = await call('GET', '/mirrors');
                if (!alive()) return;
                if (!r.ok) return failed(r, box);
                const list = asArray(r.data, ['mirrors', 'items', 'status']).filter((s) => isObj(s) && typeof s.key === 'string');
                clear(box);
                const m = msg('');
                const out = h('pre', { class: 'adm-pre', hidden: true, 'aria-live': 'polite' });
                const now = Date.now();
                const cols = [
                    { l: '站点', f: (s) => str(s.key, 64), mono: true },
                    { l: '当前', f: (s) => h('div', null, [h('div', { class: 'mono' }, str(s.current || '—', 200)), s.primary && s.current && s.primary !== s.current ? pill('已切到镜像', 'warn') : null]) },
                    { l: '主地址', f: (s) => str(s.primary || '—', 200), mono: true },
                    { l: '切换于', f: (s) => fmtAgo(s.since, now) },
                    { l: '连续失败', f: (s) => fmtNum(s.fails), num: true },
                    { l: '上次探测', f: (s) => fmtAgo(s.lastProbe, now) },
                    { l: '候选', f: (s) => fmtNum(s.candidates), num: true },
                    { l: '原因', f: (s) => str(s.reason || '—', 120) },
                    {
                        l: '', f: (s) => {
                            const b = h('button', { type: 'button', class: 'adm-btn small' }, '探测');
                            b.addEventListener('click', async () => {
                                b.disabled = true; m.className = 'adm-msg'; m.textContent = '探测 ' + str(s.key, 64) + ' 中…（最多几十秒）';
                                const x = await call('POST', '/mirror/probe', { key: s.key });
                                b.disabled = false;
                                if (!x.ok) { if (x.status === 401 || x.status === 429) return failed(x, box); m.className = 'adm-msg err'; m.textContent = errText(x); return; }
                                m.className = 'adm-msg ok'; m.textContent = str(s.key, 64) + ' 探测完成';
                                out.textContent = str(JSON.stringify(x.data, null, 2), 6000);
                                out.removeAttribute('hidden');
                            });
                            // 复核 SEC-2:回到主地址(POST /mirror/reset):换上去的地址不对时一键撤回;已经在主地址上时按钮不可点
                            const onMirror = !!(s.primary && s.current && s.primary !== s.current);
                            const rb = h('button', { type: 'button', class: 'adm-btn small danger', disabled: !onMirror, title: onMirror ? null : '已经在用主地址' }, '回到主地址');
                            rb.addEventListener('click', async () => {
                                let yes = true;
                                try { if (W && typeof W.confirm === 'function') yes = !!W.confirm('把 ' + str(s.key, 64) + ' 切回主地址？\n' + str(s.primary, 200)); } catch (e) { yes = true; }
                                if (!yes) return;
                                rb.disabled = true; b.disabled = true;
                                const x = await call('POST', '/mirror/reset', { key: s.key });
                                if (!x.ok) { b.disabled = false; rb.disabled = false; if (x.status === 401 || x.status === 429) return failed(x, box); m.className = 'adm-msg err'; m.textContent = errText(x); return; }
                                await VIEWS.mirrors(box, alive);
                                let m2 = null;
                                try { m2 = box.querySelector ? box.querySelector('[data-adm-mirror-msg]') : null; } catch (e) { m2 = null; }
                                if (m2) { m2.className = 'adm-msg ok'; m2.textContent = str(s.key, 64) + (x.data && x.data.switched ? ' 已回到主地址' : ' 本来就在用主地址'); }
                            });
                            return h('div', { style: 'display: flex; gap: 6px; flex-wrap: wrap;' }, [b, rb]);
                        },
                    },
                ];
                m.setAttribute('data-adm-mirror-msg', '1');
                box.appendChild(h('div', { class: 'adm-card' }, [
                    h('div', { class: 'adm-row' }, [h('h2', { class: 'adm-grow' }, '镜像'), refreshBtn(() => load('mirrors'))]),
                    h('p', null, '资源站连续失败时自动换到同一后端的镜像域名（内容指纹要对得上），每 6 小时回头检查主地址。探测会立刻按同样的规则查一次（每站每小时最多 10 次）。「回到主地址」立刻切回站点表里的主地址（不发请求）。'),
                    m,
                    list.length ? table(cols, list) : h('p', null, '没有镜像状态（镜像模块没在运行，或没有配置资源站）'),
                    out,
                ]));
            },
        };
        function renderVerdict(d) {
            const it = isObj(d.item) ? d.item : {}, p = isObj(d.parsed) ? d.parsed : {};
            const tags = asArray(d.tags).filter(isObj);
            const yes = (b, okText, badText) => pill(b ? okText : badText, b ? 'ok' : 'bad');
            const review = it.review;
            return h('div', { class: 'adm-card', style: 'margin-top: 12px; background: var(--panel2);' }, [
                h('dl', { class: 'adm-kv' }, [
                    h('dt', null, '搜索词'), h('dd', null, d.query === false ? pill('拦截', 'bad') : pill('放行', 'ok')),
                    h('dt', null, '作品判定'), h('dd', null, yes(it.ok === true, '放行', '拦截')),
                    h('dt', null, '原因'), h('dd', { class: 'mono' }, str(it.reason || '—', 200)),
                    h('dt', null, '分类桶'), h('dd', { class: 'mono' }, str(it.bucket || '—', 80)),
                    h('dt', null, '审查级'), h('dd', null, review ? [pill('是', 'warn'), typeof review === 'string' ? h('span', { class: 'mono' }, str(review, 80)) : null, h('span', { class: 'adm-note' }, ' 只能筛选，不进推荐 / 标签行 / 相关')] : pill('否')),
                    h('dt', null, '番号'), h('dd', { class: 'mono' }, str(p.code || '—', 60) + (p.code ? (p.codeOk ? '（可信）' : '（不可信）') : '')),
                    h('dt', null, '作品键'), h('dd', { class: 'mono' }, str(p.key || '—', 300)),
                    h('dt', null, '类型'), h('dd', { class: 'mono' }, str(p.kind || '—', 40)),
                    h('dt', null, '标签'), h('dd', null, tags.length ? tags.slice(0, 80).map((t) => pill(str(t.id, 40) + (t.kind ? ' · ' + str(t.kind, 20) : ''), t.kind === 'review' ? 'warn' : '')) : h('span', { class: 'adm-note' }, '无')),
                    h('dt', null, 'AVDB'), h('dd', null, kv(d.avdb == null ? null : d.avdb)),
                ]),
            ]);
        }

        if (getToken()) showApp('overview'); else showAuth();
        return { showAuth, showApp, select, load, getToken, setToken };
    }

    return { boot, parseWords, errText, createClient, asArray, toMs, fmtAgo, fmtTime, reasonNote, historyView, tgKillText, tgProgress, tgSkipText, fmtBytes, TOKEN_KEY, BASE, TABS, MAX_WORDS };
});
