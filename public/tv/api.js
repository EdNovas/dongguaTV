/* E视界 电视版 · 数据层(配置 / 登录 / 首页 / 分类 / 搜索 / 线路 / 进度历史 / 收藏 / 直播)
 *
 * 和网页版共用同一批 localStorage 键、同一套格式:登录、观看历史、进度、收藏、测速缓存在电视和网页之间互通。
 * 标了「移植」的函数照抄 public/index.html 里的同名逻辑(改成 ES5),scripts/tv-api-test.mjs 会把原版抽出来对比输出,
 * 改了 index.html 里那几个函数要回来同步、再跑一遍测试。
 * 只写 ES5(见 core.js 顶部说明),请求一律走 TV.http(XHR)。
 */
(function () {
    'use strict';
    var TV = window.TV;
    var api = TV.api = {};
    var P = api._pure = {};

    // ---------- 小工具 ----------
    var DAY = 24 * 3600 * 1000;
    function now() { return new Date().getTime(); }
    function hasOwn(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
    function isArr(a) { return Object.prototype.toString.call(a) === '[object Array]'; }
    function assign(t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (hasOwn(s, k)) t[k] = s[k]; } return t; }
    function find(arr, fn) { for (var i = 0; i < (arr ? arr.length : 0); i++) if (fn(arr[i], i)) return arr[i]; return undefined; }
    function findIdx(arr, fn) { for (var i = 0; i < (arr ? arr.length : 0); i++) if (fn(arr[i], i)) return i; return -1; }
    function keysOf(o) { return o ? Object.keys(o) : []; }
    function str(v) { return v == null ? '' : String(v); }
    function enc(v) { return encodeURIComponent(v); }
    function log2(x) { return Math.log2 ? Math.log2(x) : Math.log(x) / Math.LN2; }
    // 稳定排序:老内核(V8 < 7)的 Array#sort 超过 10 个元素不稳定,网页版在新浏览器上是稳定的 —— 打平时保持原顺序
    function ssort(arr, cmp) {
        var w = arr.map(function (v, i) { return { v: v, i: i }; });
        w.sort(function (a, b) { return cmp(a.v, b.v) || (a.i - b.i); });
        return w.map(function (x) { return x.v; });
    }
    function fire(name, detail) { try { TV._emit(window, name, detail); } catch (e) { } }
    function log() { try { TV.log.apply(TV, arguments); } catch (e) { } }

    // localStorage:一律经 TV.store(读写都包了 try)
    function lsRaw(k) { return TV.store.raw(k); }
    function lsSet(k, v) { TV.store.set(k, v); }
    function lsDel(k) { TV.store.del(k); }
    function lsJSON(k, def) { var s = lsRaw(k); if (s == null || s === '') return def; try { var v = JSON.parse(s); return v == null ? def : v; } catch (e) { return def; } }
    // TV.store 没有列键的方法:要遍历(退出登录清进度、清过期进度)时单独包一层 try
    function lsKeys(prefix) {
        var out = [];
        try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(prefix) === 0) out.push(k); } } catch (e) { }
        return out;
    }

    function getJ(url, ms) { return TV.http(url, { timeout: ms || 10000 }); }
    function postJ(url, body, ms) { return TV.http(url, { method: 'POST', body: body || {}, timeout: ms || 10000 }); }
    // 并发池:同时最多 limit 个(老盒子连接数少、CPU 慢)。worker 返回 Promise;单个失败不影响其余
    function pool(items, limit, worker) {
        return new Promise(function (resolve) {
            var i = 0, active = 0, done = 0, n = items.length;
            if (!n) { resolve(); return; }
            function fin() { active--; done++; if (done >= n) resolve(); else next(); }
            function next() {
                while (active < limit && i < n) {
                    var idx = i++, p = null;
                    active++;
                    try { p = worker(items[idx], idx); } catch (e) { p = null; }
                    Promise.resolve(p).then(fin, fin);
                }
            }
            next();
        });
    }

    // ---------- 配置 ----------
    var cfg = api.cfg = {};
    var proxyList = [], proxyCur = '';
    var IMG_SIZE = 'w342', imgBase = '/api/tmdb-image/w342';
    (function () {
        try {
            var w = (window.innerWidth || 0) * (window.devicePixelRatio || 1);
            IMG_SIZE = w >= 1600 ? 'w500' : 'w342';
        } catch (e) { }
        imgBase = '/api/tmdb-image/' + IMG_SIZE;
    })();
    // 与 index.html initApp 同一套整理:逐个 trim、去掉结尾 /、只留 http(s);没有数组就用单个 cors_proxy_url
    function normProxies(c) {
        c = c || {};
        if (isArr(c.cors_proxy_urls) && c.cors_proxy_urls.length) {
            return c.cors_proxy_urls.map(function (u) { return String(u || '').trim().replace(/\/+$/, ''); }).filter(function (u) { return /^https?:\/\//i.test(u); });
        }
        return c.cors_proxy_url ? [String(c.cors_proxy_url).trim().replace(/\/+$/, '')] : [];
    }
    P.normProxies = normProxies;
    function applyConfig(c) {
        c = c || {};
        for (var k in cfg) if (hasOwn(cfg, k)) delete cfg[k];
        assign(cfg, c);
        proxyList = normProxies(c);
        if (!proxyList.length) proxyCur = '';
        else if (proxyList.indexOf(proxyCur) < 0) proxyCur = proxyList[0];
        imgBase = c.enable_local_image_cache === false ? 'https://image.tmdb.org/t/p/' + IMG_SIZE : '/api/tmdb-image/' + IMG_SIZE;
    }
    api.proxy = function () { return proxyCur || ''; };
    api.proxies = function () { return proxyList.slice(); };
    // 去广告 worker 坏了换备用(播放层分诊用):只接受配置里有的地址,本次打开页面内有效
    api.setProxy = function (u) { if (u && proxyList.indexOf(u) >= 0) proxyCur = u; return proxyCur; };

    function configUrl() { var t = token(); return '/api/config' + (t ? '?token=' + enc(t) : ''); }
    var inited = null;
    api.init = function () {
        if (inited) return inited;
        inited = getJ(configUrl(), 8000).then(function (c) {
            if (!c || typeof c !== 'object') throw new Error('bad config');
            lsSet('donggua_config_cache', { ts: now(), config: c });
            applyConfig(c);
        }, function (e) {
            // 连不上:用 7 天内的缓存配置照常进(和网页版一样);再旧的不如没有(代理早换了会钉死整个会话)
            var cached = lsJSON('donggua_config_cache', null);
            if (!cached || !cached.config || now() - (cached.ts || 0) > 7 * DAY) { inited = null; throw e; }
            applyConfig(cached.config);
            cfg._offline = true;
        }).then(function () {
            setTimeout(loadSites, 600);
            setTimeout(cleanUpOldProgress, 3000);
            startExpiryTimer();
            syncBoot();
            return cfg;
        });
        return inited;
    };
    api.ready = function () { return inited || api.init(); };
    // 换了账号 / 刚登录:重读一次配置(sync_enabled 按 token 算)
    function reloadConfig() {
        return getJ(configUrl(), 8000).then(function (c) { if (c && typeof c === 'object') applyConfig(c); }, function () { });
    }

    // 线路广告分级表(/api/sites 的 profiles):先用上次缓存的,再后台更新
    var siteProfiles = lsJSON('donggua_site_profiles', {}) || {};
    function loadSites() {
        return getJ('/api/sites', 8000).then(function (d) {
            var prof = (d && d.profiles && typeof d.profiles === 'object') ? d.profiles : {};
            siteProfiles = prof;
            lsSet('donggua_site_profiles', prof);
        }, function () { });
    }

    api.adFilterOn = function () { return lsRaw('donggua_ad_filter_enabled') !== 'false'; };
    api.nsfwOn = function () { return lsRaw('donggua_filter_nsfw') !== 'false'; };

    // ---------- 图片 ----------
    // TMDB poster_path(/abc.jpg)→ 图片代理;资源站的 http 图 → https(App 里是 https 页面,http 图会被拦)
    function imgUrl(path, base) {
        var p = str(path).trim();
        if (!p || p.indexOf('mac_default') >= 0 || p.indexOf('nopic') >= 0) return '';
        if (/^\/[A-Za-z0-9_\-]+\.(jpg|jpeg|png|webp)$/i.test(p)) return base + p;
        if (/^\/\//.test(p)) return 'https:' + p;
        if (/^http:\/\//i.test(p)) return 'https://' + p.slice(7);
        if (/^https:\/\//i.test(p) || p.charAt(0) === '/') return p;
        return '';
    }
    P.imgUrl = imgUrl;
    api.img = function (path, size) {
        var base = imgBase;
        if (size && /^(w\d+|original)$/.test(size)) base = imgBase.replace(/\/(w\d+|original)$/, '/' + size);
        return imgUrl(path, base);
    };

    // ---------- 登录(键名 / 规则同 index.html 的 auth 脚本) ----------
    var K_HASH = 'emax_auth_hash', K_EXP = 'emax_auth_expiry', K_TYPE = 'emax_auth_type', K_EMAIL = 'emax_v2board_email',
        K_V2T = 'emax_v2board_token', K_PLAN = 'emax_v2board_plan', K_LAST = 'emax_v2board_last_check', K_V2EXP = 'emax_v2board_expires';
    var V2B_CHECK_INTERVAL = 5 * DAY, YEAR = 365 * DAY;
    function token() { return lsRaw(K_HASH) || ''; }
    api.token = token;
    function isV2b() { return lsRaw(K_TYPE) === 'v2board'; }
    api.userLabel = function () { return token() && isV2b() ? (lsRaw(K_EMAIL) || '') : ''; };
    function clearAuthState() {
        TV.each([K_HASH, K_EXP, K_TYPE, K_EMAIL, K_V2T, K_PLAN, K_LAST, K_V2EXP], lsDel);
    }
    function savePlan(plan) {
        if (!plan) return;
        lsSet(K_PLAN, JSON.stringify(plan));
        if (plan.expiresAt) lsSet(K_V2EXP, String(plan.expiresAt));
        else lsDel(K_V2EXP);
    }
    function errMsg(e, def) { return (e && e.data && e.data.message) || def; }

    // 本页加载期内 /api/auth/v2board/check 有没有回答过(成功 / 失败 / 面板连不上都算;断网、超时、429 不算)
    var v2bAnswered = false;
    // 移植 revalidateV2boardSession:true = 有效(含断网 / 限流,不打断使用);对象 = 服务器的失败详情;false = 没有面板令牌
    function revalidate() {
        var v2bToken = lsRaw(K_V2T);
        if (!v2bToken) return Promise.resolve(false);
        return postJ('/api/auth/v2board/check', { v2boardToken: v2bToken, email: lsRaw(K_EMAIL) }, 8000).then(function (d) {
            v2bAnswered = true;
            if (d && d.success) {
                lsSet(K_HASH, d.userToken);
                lsSet(K_LAST, String(now()));
                savePlan(d.plan);
                return true;
            }
            return d || {};
        }, function (e) {
            // 限流 / 5xx / 断网 / 超时 ≠ 套餐失效:不阻断;只有 4xx 带明确回答才算失败
            if (e && e.status >= 400 && e.status < 500 && e.status !== 429 && e.data && typeof e.data === 'object') { v2bAnswered = true; return e.data; }
            return true;
        });
    }
    var revalOnce = null;
    // 本页加载期内补验证一次(服务器重启后 v2board 令牌要重新登记,不然 sync_enabled 一直是 false)。
    //   失败(过期 / 令牌失效 / 流量用尽)→ 登出并发 tv:logout;面板连不上 / 断网 → 照常用
    api.revalidateOnce = function () {
        if (revalOnce) return revalOnce;
        if (!isV2b() || !lsRaw(K_V2T)) { revalOnce = Promise.resolve(false); return revalOnce; }
        if (v2bAnswered) { revalOnce = Promise.resolve(true); return revalOnce; }
        revalOnce = revalidate().then(function (r) {
            if (r === true) return true;
            if (r && typeof r === 'object' && r.unreachable === true) return true;
            hardLogout(r && r.message);
            return false;
        });
        return revalOnce;
    };
    function hardLogout(message) {
        clearAuthState();
        resetAccountState();
        fire('tv:logout', { message: message || '' });
        fire('tv:user');
    }
    // 套餐到期检测(每 2 小时,同网页版 startV2boardExpiryTimer):电视常年开着
    var expiryT = 0;
    function startExpiryTimer() {
        clearInterval(expiryT);
        expiryT = setInterval(function () {
            var exp = parseInt(lsRaw(K_V2EXP) || '0', 10);
            if (!(exp > 0 && now() > exp) || !isV2b() || !lsRaw(K_V2T)) return;
            revalidate().then(function (r) {
                if (r === true || (r && r.unreachable === true)) return;
                hardLogout('您的机场套餐已到期，请续费后重新登录');
            });
        }, 2 * 3600 * 1000);
    }

    // 移植 checkAuthStatus → { need(要不要显示登录), qrLogin, passwordMode, v2board, message? }
    api.authCheck = function () {
        return getJ('/api/auth/check', 8000).then(function (data) {
            data = data || {};
            lsSet('donggua_auth_required', data.requirePassword ? '1' : '0');
            var base = { qrLogin: data.qrLogin === true, passwordMode: !!data.requirePassword, v2board: data.v2boardEnabled !== false };
            function res(need, message) { var o = assign({ need: need }, base); if (message) o.message = message; if (!need) fire('tv:user'); return o; }
            if (!data.requirePassword) return res(false);
            var hash = lsRaw(K_HASH), expiry = lsRaw(K_EXP), type = lsRaw(K_TYPE);
            if (!(hash && expiry)) return res(true);
            var expired = now() > parseInt(expiry, 10);
            if (type === 'v2board') {
                if (!expired) {
                    var last = parseInt(lsRaw(K_LAST) || '0', 10);
                    if (now() - last <= V2B_CHECK_INTERVAL) return res(false);
                    return revalidate().then(function (r) {
                        if (r === true) return res(false);
                        // 面板连不上 ≠ 套餐失效:按上次的登录状态放行
                        if (r && typeof r === 'object' && r.unreachable === true) return res(false);
                        clearAuthState();
                        return res(true, r && r.message ? '登录已过期:' + r.message : '');
                    });
                }
                return revalidate().then(function (r) {
                    if (r === true) { lsSet(K_EXP, String(now() + YEAR)); return res(false); }
                    clearAuthState();
                    return res(true, r && r.message ? '登录已过期:' + r.message : '');
                });
            }
            if (expired) { clearAuthState(); return res(true); }
            return postJ('/api/auth/verify', { passwordHash: hash }, 8000).then(function (d) {
                if (d && d.success) return res(false);
                clearAuthState();
                return res(true);
            }, function (e) {
                // 4xx = 服务器明确不认;429 / 5xx / 断网走外层的放行
                if (e && e.status >= 400 && e.status < 500 && e.status !== 429) { clearAuthState(); return res(true); }
                throw e;
            });
        }).then(null, function (e) {
            // 断网 / 超时:有凭据就放行(能看缓存);"已知本站要登录"又没凭据的不放行
            var need = lsRaw('donggua_auth_required') === '1' && !token();
            if (!need) fire('tv:user');
            return { need: need, qrLogin: false, passwordMode: true, v2board: true, offline: true };
        });
    };

    function afterLogin() {
        revalOnce = Promise.resolve(true);
        fire('tv:user');
        reloadConfig().then(function () { syncBoot(true); });
    }
    // 电视是自己的设备:登录一律记住 1 年
    api.loginV2board = function (email, pwd) {
        email = str(email).trim();
        return postJ('/api/auth/v2board', { email: email, password: str(pwd) }, 15000).then(function (d) {
            if (!d || !d.success) {
                var m = (d && d.message) || '登录失败';
                if (d && d.expired) m += ',请前往 domain.ednovas.xyz 续费';
                return { ok: false, message: m, expired: !!(d && d.expired), trafficExhausted: !!(d && d.trafficExhausted) };
            }
            lsSet(K_HASH, d.userToken);
            lsSet(K_TYPE, 'v2board');
            lsSet(K_EMAIL, email);
            savePlan(d.plan);
            lsSet(K_LAST, String(now()));
            if (d.v2boardToken) lsSet(K_V2T, d.v2boardToken);
            lsSet(K_EXP, String(now() + YEAR));
            v2bAnswered = true;
            afterLogin();
            return { ok: true };
        }, function (e) {
            if (e && e.status === 429) return { ok: false, message: '尝试太频繁,请一分钟后再试' };
            if (e && e.data && e.data.message) return { ok: false, message: e.data.message };
            return { ok: false, message: '网络连接失败，请稍后再试' };
        });
    };
    api.loginPassword = function (pwd) {
        return postJ('/api/auth/verify', { password: str(pwd) }, 10000).then(function (d) {
            if (!d || !d.success) return { ok: false, message: '密码错误，请重试' };
            if (d.passwordHash) lsSet(K_HASH, d.passwordHash);
            lsSet(K_TYPE, 'password');
            lsSet(K_EXP, String(now() + YEAR));
            afterLogin();
            return { ok: true };
        }, function (e) {
            if (e && e.status === 429) return { ok: false, message: '尝试太频繁,请一分钟后再试' };
            return { ok: false, message: '验证失败，请检查网络连接' };
        });
    };

    // 扫码登录(电视出码,手机确认)
    api.qrNew = function () {
        return postJ('/api/auth/qr/new', {}, 8000).then(function (d) {
            if (!d || !d.ok || !d.code) throw new Error((d && d.message) || '扫码登录暂不可用');
            var origin = '';
            try { origin = location.origin || (location.protocol + '//' + location.host); } catch (e) { }
            return { code: d.code, secret: d.secret, ttl: d.ttl || 300, url: origin + '/?tvlogin=' + d.code };
        }, function (e) { throw new Error(errMsg(e, e && e.status === 503 ? '扫码登录太忙,请稍后再试' : '扫码登录暂不可用')); });
    };
    // → { status: pending|scanned|approved|denied|expired|''(网络错,接着轮询), auth? }
    api.qrPoll = function (code, secret) {
        return postJ('/api/auth/qr/poll', { code: code, secret: secret }, 8000).then(function (d) {
            return { status: (d && d.status) || '', auth: d && d.auth };
        }, function (e) { return { status: (e && e.data && e.data.status) || '' }; });
    };
    // 移植 qrLoginApply:手机交过来的凭据按原接口核实一遍再存成本机登录(记住 1 年)
    api.qrApply = function (auth) {
        if (!auth || (auth.type !== 'password' && auth.type !== 'v2board')) return Promise.reject(new Error('登录信息不完整，请重新扫码'));
        var p;
        if (auth.type === 'password') {
            p = postJ('/api/auth/verify', { passwordHash: auth.hash }, 8000).then(function (d) {
                if (!d || !d.success) throw new Error('这个密码已经失效，请在手机上重新登录后再扫');
                lsSet(K_HASH, d.passwordHash);
                lsSet(K_TYPE, 'password');
            }, function (e) {
                if (e && e.data && e.data.success === false) throw new Error('这个密码已经失效，请在手机上重新登录后再扫');
                throw new Error('网络连接失败，请重新扫码');
            });
        } else {
            clearAuthState();
            lsSet(K_TYPE, 'v2board');
            lsSet(K_V2T, auth.v2boardToken);
            if (auth.email) lsSet(K_EMAIL, auth.email);
            // 它在断网、限流时也回 true,所以以"拿到了本站令牌"为准
            p = revalidate().then(function (ok) {
                if (ok !== true || !lsRaw(K_HASH)) {
                    clearAuthState();
                    throw new Error((ok && ok.message) || '暂时连不上机场面板，请稍后再扫');
                }
            });
        }
        return p.then(function () {
            lsSet(K_EXP, String(now() + YEAR));
            afterLogin();
            return true;
        });
    };

    // 移植 confirmLogout(主动退出 = 可能换人):清登录 + 观看历史 + 进度 + 收藏 / 片单 / 大家都在看缓存。不刷新页面,调用方重置界面
    //   (另外把 clearAuthState 的几个键也清掉:网页版主动退出只清了 hash / expiry,面板令牌和邮箱还留着,电视上不该留)
    api.logout = function () {
        var oldToken = token();
        lsDel(K_HASH); lsDel(K_EXP);
        try { sessionStorage.removeItem('emax_session_only'); } catch (e) { }
        lsDel('donggua_watch_history');
        lsDel('donggua_hist_synced');
        TV.each(lsKeys('donggua_progress_'), lsDel);
        TV.each(['donggua_favorites', 'donggua_fav_cache', 'donggua_push_on', 'donggua_popular_cache3', 'donggua_popular_cache2',
            'donggua_fav_tmdb', 'donggua_playlists', 'donggua_pl_cache'], lsDel);
        clearAuthState();
        pushUnsubscribe(oldToken);
        resetAccountState();
        fire('tv:user');
    };
    // 浏览器里有推送订阅就退掉(老盒子一般没有;有 SW + PushManager 才试)
    function pushUnsubscribe(oldToken) {
        try {
            if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistration) return;
            navigator.serviceWorker.getRegistration().then(function (reg) {
                if (!reg || !reg.pushManager) return null;
                return reg.pushManager.getSubscription().then(function (sub) {
                    if (!sub) return;
                    if (oldToken && sub.endpoint) postJ('/api/push/unsubscribe', { token: oldToken, endpoint: sub.endpoint }, 8000).then(null, function () { });
                    return sub.unsubscribe();
                });
            }).then(null, function () { });
        } catch (e) { }
    }
    function resetAccountState() {
        cfg.sync_enabled = false;
        H.list = null;
        F.list = null;
        clearTimeout(H.pushT); H.pushT = 0;
        popMem = null; hotMem = null;
        revalOnce = null;
    }

    // 登录后 / 启动时:v2board 账号服务器说没开同步 = 服务器重启后令牌还没登记 → 补验证一次再读配置;然后拉历史、收藏
    var syncing = null;
    function syncBoot(force) {
        if (syncing && !force) return syncing;
        if (!token()) { syncing = Promise.resolve(); return syncing; }
        var p = (cfg.sync_enabled || !isV2b()) ? Promise.resolve() : api.revalidateOnce().then(function (ok) { if (ok && token()) return reloadConfig(); });
        syncing = p.then(function () {
            var tasks = [api.refreshFavorites()];
            if (isSync()) tasks.push(api.pullHistory());
            return Promise.all(tasks).then(null, function () { });
        }).then(function () { fire('tv:sync', { sync: isSync() }); });
        return syncing;
    }
    function isSync() { return !!(cfg.sync_enabled && token()); }
    api.isSync = isSync;

    // ---------- 分类目录(移植 DgCatalog 里用得到的部分:TYPES / buildQuery / visible) ----------
    var Cat = (function () {
        var NSFW_KW = '155477|190370|159551|198385|10053';
        var NSFW_TITLE = /玉蒲团|蜜桃成熟|色欲|淫|情色|艳情|春宫|三级片|性爱|乱伦|走肾|裸体|恋欲|小姨子|嫂子的|继母的|姐姐的朋友|妈妈的朋友|朋友的(妈妈|母亲|姐姐|妹妹|妻子|老婆)|(年轻|漂亮|性感)的(妈妈|母亲|妻子|嫂子|阿姨|姐姐|妹妹)|拷问部/;
        var NSFW_TITLE_MAX_VOTES = 200;
        var TV_EX = '16,10764,10767,99,10763,10762';
        var ZH = 'CN|HK|TW';
        var EU = 'FR|DE|ES|IT|SE|DK|NO|BE|NL|PL|IE|PT|FI|AT|CH';
        var ASIA_VC = { hot: 10, new: 3, top: 50 };
        var KW = {
            romance: '9840', costume: '195013|295029|15060|319304|379597|384651|192772|347945|379699', xianxia: '234890|384653|347944',
            wuxia: '184656|384653|379597|384651|366002|366003', spy: '5265|470|220915|335028|309130|318771|364102', youth: '10683|6270|293194',
            timeTravel: '4379|334003', medical: '208788', legal: '222517', school: '6270', isekai: '237451', mecha: '10046', disaster: '10617',
            dating: '215119', cooking: '1918|10637|227635', travel: '9935|310315', music: '6383|8290|262705|251523',
            nature: '18330|221355|9902', history: '282633|378429', food: '10637|307690|1918', science: '287067|325892|9882',
            trueCrime: '33722|307587', biography: '5565'
        };
        function o(k, l, q, extra) { return assign({ k: k, l: l, q: q || null }, extra || {}); }
        function C(code) { return { with_origin_country: code }; }
        function L(code) { return { with_original_language: code }; }
        var TYPES = [
            {
                k: 'movie', l: '电影', media: 'movie', base: {}, vc: { hot: 50, new: 10, top: 100 },
                groups: [
                    { k: 'region', l: '地区', opts: [
                        o('cn', '华语', C(ZH), { vc: ASIA_VC }), o('mainland', '内地', C('CN'), { vc: ASIA_VC }),
                        o('hk', '香港', C('HK'), { vc: ASIA_VC }), o('tw', '台湾', C('TW'), { vc: ASIA_VC }),
                        o('us', '美国', C('US')), o('kr', '韩国', C('KR'), { vc: ASIA_VC }), o('jp', '日本', C('JP'), { vc: ASIA_VC }),
                        o('th', '泰国', C('TH'), { vc: { hot: 10, new: 3, top: 30 } }),
                        o('gb', '英国', C('GB')), o('fr', '法国', C('FR')), o('eu', '欧洲', C(EU)), o('in', '印度', C('IN'))
                    ] },
                    { k: 'genre', l: '题材', opts: [
                        o('action', '动作', { with_genres: '28' }), o('comedy', '喜剧', { with_genres: '35' }),
                        o('romance', '爱情', { with_genres: '10749' }), o('scifi', '科幻', { with_genres: '878' }),
                        o('fantasy', '奇幻', { with_genres: '14' }), o('mystery', '悬疑', { with_genres: '9648' }),
                        o('thriller', '惊悚', { with_genres: '53' }), o('horror', '恐怖', { with_genres: '27' }),
                        o('crime', '犯罪', { with_genres: '80' }), o('drama', '剧情', { with_genres: '18' }),
                        o('war', '战争', { with_genres: '10752' }), o('history', '历史', { with_genres: '36' }),
                        o('wuxia', '武侠', { with_keywords: KW.wuxia }, { vc: { hot: 10, top: 20 } }), o('animation', '动画', { with_genres: '16' }),
                        o('family', '家庭', { with_genres: '10751' }), o('adventure', '冒险', { with_genres: '12' }),
                        o('disaster', '灾难', { with_keywords: KW.disaster }), o('music', '音乐', { with_genres: '10402' })
                    ] },
                    { k: 'lang', l: '语言', opts: [
                        o('zh', '国语', L('zh'), { vc: ASIA_VC }), o('cn', '粤语', L('cn'), { vc: ASIA_VC }), o('en', '英语', L('en')),
                        o('ko', '韩语', L('ko'), { vc: ASIA_VC }), o('ja', '日语', L('ja'), { vc: ASIA_VC }),
                        o('th', '泰语', L('th'), { vc: { hot: 10, new: 3, top: 30 } }), o('fr', '法语', L('fr')), o('es', '西班牙语', L('es')),
                        o('hi', '印地语', L('hi')), o('de', '德语', L('de'))
                    ] }
                ]
            },
            {
                k: 'tv', l: '剧集', media: 'tv', base: { without_genres: TV_EX }, vc: { hot: 1, new: 1, top: 15 },
                groups: [
                    { k: 'region', l: '地区', opts: [
                        o('cn', '国产', C('CN')), o('hk', '港剧', C('HK'), { vc: { top: 5 } }), o('tw', '台剧', C('TW')),
                        o('kr', '韩剧', C('KR')), o('jp', '日剧', C('JP')), o('th', '泰剧', C('TH')),
                        o('us', '美剧', C('US')), o('gb', '英剧', C('GB')), o('eu', '欧洲', C(EU)),
                        o('krjp', '日韩', C('KR|JP'), { hidden: true })
                    ] },
                    { k: 'genre', l: '题材', opts: [
                        o('mystery', '悬疑', { with_genres: '9648' }), o('crime', '犯罪', { with_genres: '80' }),
                        o('romance', '爱情', { with_keywords: KW.romance }), o('comedy', '喜剧', { with_genres: '35' }),
                        o('costume', '古装', { with_keywords: KW.costume }, { dq: C(ZH), vc: { top: 8 } }),
                        o('xianxia', '仙侠', { with_keywords: KW.xianxia }, { vc: { top: 5 } }),
                        o('wuxia', '武侠', { with_keywords: KW.wuxia }, { vc: { top: 5 } }),
                        o('spy', '谍战', { with_keywords: KW.spy }, { dq: C(ZH), vc: { top: 3 } }),
                        o('youth', '青春', { with_keywords: KW.youth }, { dq: C(ZH) }), o('scifi', '科幻', { with_genres: '10765' }),
                        o('action', '动作', { with_genres: '10759' }), o('timetravel', '穿越', { with_keywords: KW.timeTravel }),
                        o('war', '战争', { with_genres: '10768' }), o('family', '家庭', { with_genres: '10751' }),
                        o('medical', '医疗', { with_keywords: KW.medical }), o('legal', '律政', { with_keywords: KW.legal })
                    ] },
                    { k: 'lang', l: '语言', opts: [
                        o('zh', '国语', L('zh')), o('cn', '粤语', L('cn'), { vc: { top: 5 } }), o('en', '英语', L('en')),
                        o('ko', '韩语', L('ko')), o('ja', '日语', L('ja')), o('th', '泰语', L('th'))
                    ] }
                ]
            },
            {
                k: 'anime', l: '动漫', media: 'tv', base: { with_genres: '16' }, vc: { hot: 1, new: 1, top: 20 },
                groups: [
                    { k: 'region', l: '地区', opts: [
                        o('jp', '日本', C('JP')), o('cn', '国产', C('CN'), { vc: { top: 10 } }),
                        o('west', '欧美', C('US|GB|FR|CA')), o('kr', '韩国', C('KR'), { vc: { top: 5 } })
                    ] },
                    { k: 'form', l: '形式', all: false, opts: [o('', 'TV动画'), o('movie', '动画电影', null, { media: 'movie' })] },
                    { k: 'genre', l: '题材', opts: [
                        o('action', '热血', { with_genres: '10759' }, { m: { with_genres: '28' } }),
                        o('fantasy', '奇幻', { with_genres: '10765' }, { m: { with_genres: '14' } }),
                        o('comedy', '搞笑', { with_genres: '35' }),
                        o('romance', '恋爱', { with_keywords: KW.romance }, { m: { with_genres: '10749' } }),
                        o('school', '校园', { with_keywords: KW.school }), o('isekai', '异世界', { with_keywords: KW.isekai }),
                        o('mystery', '悬疑', { with_genres: '9648' }), o('mecha', '机甲', { with_keywords: KW.mecha }),
                        o('kids', '亲子', { with_genres: '10762' }, { m: { with_genres: '10751' } })
                    ] }
                ]
            },
            {
                k: 'variety', l: '综艺', media: 'tv', base: { with_genres: '10764|10767' }, vc: { hot: 0, new: 0, top: 5 },
                groups: [
                    { k: 'region', l: '地区', opts: [
                        o('cn', '内地', C('CN'), { vc: { top: 3 } }), o('kr', '韩综', C('KR')), o('jp', '日综', C('JP'), { vc: { top: 2 } }),
                        o('tw', '台综', C('TW'), { vc: { top: 2 } }), o('west', '欧美', C('US|GB'))
                    ] },
                    { k: 'genre', l: '类型', opts: [
                        o('reality', '真人秀', { '!with_genres': '10764' }), o('talk', '脱口秀', { '!with_genres': '10767' }),
                        o('dating', '恋爱', { with_keywords: KW.dating }), o('cooking', '美食', { with_keywords: KW.cooking }),
                        o('travel', '旅行', { with_keywords: KW.travel }), o('music', '音乐', { with_keywords: KW.music })
                    ] }
                ]
            },
            {
                k: 'doc', l: '纪录片', media: 'tv', base: { with_genres: '99' }, vc: { hot: 10, new: 3, top: 20 }, sort: 'top',
                groups: [
                    { k: 'form', l: '形式', all: false, opts: [o('', '系列'), o('movie', '电影', null, { media: 'movie', m: { without_genres: '10402' }, vcUp: { top: 20 } })] },
                    { k: 'region', l: '地区', opts: [
                        o('cn', '国产', C(ZH), { vc: { hot: 1, new: 0, top: 3 } }), o('gb', '英国', C('GB')),
                        o('us', '美国', C('US')), o('jp', '日本', C('JP'), { vc: { hot: 1, new: 0, top: 3 } })
                    ] },
                    { k: 'genre', l: '题材', opts: [
                        o('nature', '自然', { with_keywords: KW.nature }), o('history', '历史', { with_keywords: KW.history }, { m: { with_genres: '36' } }),
                        o('food', '美食', { with_keywords: KW.food }, { vc: { top: 5 } }), o('science', '科学', { with_keywords: KW.science }),
                        o('crime', '罪案', { with_keywords: KW.trueCrime }), o('people', '人物', { with_keywords: KW.biography })
                    ] }
                ]
            }
        ];
        var SORTS = [{ k: 'hot', l: '最热' }, { k: 'new', l: '最新' }, { k: 'top', l: '高分' }];
        function typeOf(k) { return find(TYPES, function (t) { return t.k === k; }) || null; }
        function optOf(g, k) { return find(g.opts, function (x) { return x.k === k; }) || null; }
        function asDate(t) { return (t instanceof Date ? t : new Date(t == null ? now() : t)); }
        function isoDay(t) { var d = asDate(t); return d.getFullYear() + '-' + TV.pad2(d.getMonth() + 1) + '-' + TV.pad2(d.getDate()); }
        function yearOpts(t) {
            var y = asDate(t).getFullYear(), out = [];
            for (var i = 0; i < 7; i++) out.push({ k: String(y - i), l: String(y - i) });
            for (var d = Math.floor((y - 7) / 10) * 10; d >= 1990; d -= 10) out.push({ k: d + 's', l: (d === 1990 ? '90' : d) + '年代' });
            out.push({ k: 'old', l: '更早' });
            return out;
        }
        function yearRange(k, t) {
            if (/^\d{4}$/.test(k || '')) return { gte: k + '-01-01', lte: k + '-12-31' };
            var m = /^(\d{4})s$/.exec(k || '');
            if (m) return { gte: m[1] + '-01-01', lte: Math.min(+m[1] + 9, asDate(t).getFullYear() - 7) + '-12-31' };
            if (k === 'old') return { lte: '1989-12-31' };
            return null;
        }
        function normSel(tk, sel, t) {
            var T = typeOf(tk) || TYPES[1], s = sel || {}, out = {};
            TV.each(T.groups, function (g) {
                var v = s[g.k] == null ? '' : String(s[g.k]);
                out[g.k] = (v === '' || optOf(g, v)) ? v : '';
            });
            var y = s.year == null ? '' : String(s.year);
            out.year = y && yearOpts(t).some(function (x) { return x.k === y; }) ? y : '';
            out.sort = SORTS.some(function (x) { return x.k === s.sort; }) ? s.sort : (T.sort || 'hot');
            return out;
        }
        function mediaOf(T, s) {
            for (var i = 0; i < T.groups.length; i++) { var x = optOf(T.groups[i], s[T.groups[i].k]); if (x && x.media) return x.media; }
            return T.media;
        }
        var JOIN = { with_genres: ',', with_keywords: ',', without_genres: ',', without_keywords: '|' };
        function mergeQ(dst, src) {
            keysOf(src || {}).forEach(function (key) {
                var v = src[key];
                if (key.charAt(0) === '!') { dst[key.slice(1)] = v; return; }
                dst[key] = (dst[key] != null && dst[key] !== '' && JOIN[key]) ? dst[key] + JOIN[key] + v : v;
            });
            return dst;
        }
        function buildQuery(tk, sel, page, opt) {
            var op = opt || {}, T = typeOf(tk) || TYPES[1];
            var s = normSel(T.k, sel, op.now), media = mediaOf(T, s);
            var q = mergeQ({}, T.base), dq = {}, vc = assign({}, T.vc), up = {};
            TV.each(T.groups, function (g) {
                var x = optOf(g, s[g.k]);
                if (!x) return;
                mergeQ(q, (media !== T.media && x.m) ? x.m : x.q);
                assign(dq, x.dq);
                keysOf(x.vc || {}).forEach(function (k) { vc[k] = Math.min(vc[k], x.vc[k]); });
                keysOf(x.vcUp || {}).forEach(function (k) { up[k] = Math.max(up[k] || 0, x.vcUp[k]); });
            });
            keysOf(up).forEach(function (k) { vc[k] = Math.max(vc[k], up[k]); });
            keysOf(dq).forEach(function (k) { if (q[k] == null) q[k] = dq[k]; });
            var dk = media === 'movie' ? 'primary_release_date' : 'first_air_date';
            var yr = yearRange(s.year, op.now);
            if (yr && yr.gte) q[dk + '.gte'] = yr.gte;
            if (yr && yr.lte) q[dk + '.lte'] = yr.lte;
            if (s.sort === 'new') {
                var today = isoDay(op.now);
                if (!q[dk + '.lte'] || q[dk + '.lte'] > today) q[dk + '.lte'] = today;
                q.sort_by = dk + '.desc';
            } else q.sort_by = s.sort === 'top' ? 'vote_average.desc' : 'popularity.desc';
            if (vc[s.sort] > 0) q['vote_count.gte'] = vc[s.sort];
            if (op.nsfw) { q.include_adult = 'false'; mergeQ(q, { without_keywords: NSFW_KW }); }
            q.page = Math.max(1, Math.min(500, parseInt(page, 10) || 1));
            return { path: '/discover/' + media, media: media, params: q };
        }
        var HAN = /[㐀-䶿一-鿿]/;
        var OTHER_SCRIPT = /[Ѐ-ӿ֐-׿؀-ۿऀ-෿฀-๿ᄀ-ᇿ぀-ヺヽ-ヿㇰ-ㇿ가-힯]/;
        function visible(it, nsfw) {
            if (!it || !it.poster_path) return false;
            var name = String(it.title || it.name || '').trim();
            if (!name || OTHER_SCRIPT.test(name)) return false;
            if (!HAN.test(name) && it.original_language !== 'en' && name === String(it.original_title || it.original_name || '').trim()) return false;
            return !(nsfw && (it.vote_count || 0) < NSFW_TITLE_MAX_VOTES && NSFW_TITLE.test(name));
        }
        return { TYPES: TYPES, SORTS: SORTS, typeOf: typeOf, optOf: optOf, yearOpts: yearOpts, normSel: normSel, buildQuery: buildQuery, visible: visible };
    })();
    P.catalog = Cat;

    // 电视上的筛选:最多 3 排(地区或分类 + 题材 + 排序),每排第一个是默认。选项的 sel = 交给 buildQuery 的那部分
    function catRows(cat) {
        var T = Cat.typeOf(cat);
        if (!T) return [];
        function grp(k) { return find(T.groups, function (g) { return g.k === k; }); }
        function rowOf(k, label) {
            var g = grp(k);
            if (!g) return null;
            var opts = (g.all === false ? [] : [{ v: '', t: '全部', sel: {} }]);
            TV.each(g.opts, function (x) { if (!x.hidden) { var s = {}; s[k] = x.k; opts.push({ v: x.k, t: x.l, sel: s }); } });
            if (opts.length && opts[0].v === '') { opts[0].sel = {}; opts[0].sel[k] = ''; }
            return { k: k, label: label || g.l, opts: opts };
        }
        var rows = [];
        if (cat === 'anime' || cat === 'doc') {
            // 动漫 / 纪录片:地区和「电影」形式并成一排
            var region = grp('region'), first = { v: '', t: '全部', sel: { region: '', form: '' } }, cls = [first];
            TV.each(region.opts, function (x) { cls.push({ v: x.k, t: x.l, sel: { region: x.k, form: '' } }); });
            cls.push({ v: 'movie', t: cat === 'anime' ? '动画电影' : '纪录电影', sel: { region: '', form: 'movie' } });
            if (cat === 'doc') { first.t = '系列'; }
            rows.push({ k: 'cls', label: '分类', opts: cls });
        } else rows.push(rowOf('region'));
        rows.push(rowOf('genre'));
        var sorts = Cat.SORTS.map(function (x) { return { v: x.k, t: x.l, sel: { sort: x.k } }; });
        if (T.sort) sorts = ssort(sorts, function (a, b) { return (a.v === T.sort ? 0 : 1) - (b.v === T.sort ? 0 : 1); });
        rows.push({ k: 'sort', label: '排序', opts: sorts });
        return rows.filter(Boolean);
    }
    function catSel(cat, sel) {
        var out = {};
        TV.each(catRows(cat), function (r) {
            var v = sel && sel[r.k] != null ? String(sel[r.k]) : null;
            var x = (v == null ? null : find(r.opts, function (o) { return o.v === v; })) || r.opts[0];
            if (x) assign(out, x.sel);
        });
        return out;
    }
    P.catRows = catRows;
    P.catSel = catSel;
    api.catFilters = function (cat) {
        return catRows(cat).map(function (r) { return { k: r.k, label: r.label, opts: r.opts.map(function (x) { return { v: x.v, t: x.t }; }) }; });
    };

    // TMDB 条目 → 卡片
    function tmdbCard(it, media) {
        var m = (it.media_type === 'movie' || it.media_type === 'tv') ? it.media_type : media;
        var d = str(it.release_date || it.first_air_date);
        return {
            title: str(it.title || it.name).trim(), poster: api.img(it.poster_path), year: d.slice(0, 4),
            badge: it.vote_average > 0 ? (Math.round(it.vote_average * 10) / 10).toFixed(1) : '', note: '',
            kind: 'tmdb', tmdbId: it.id, media: m || 'tv', original: str(it.original_title || it.original_name),
            key: 'tmdb:' + (m || 'tv') + ':' + it.id
        };
    }
    function tmdbUrl(path, params) {
        var qs = typeof params === 'string' ? params : TV.qs(params || {});
        return '/api/tmdb-proxy?path=' + enc(path) + (qs ? '&' + qs : '');
    }
    var browseSeen = { sig: '', ids: {} };
    // 分类浏览一页:整页都被过滤掉时自己接着拉下一页(最多 3 页),不然海报墙以为到底了
    api.browse = function (cat, sel, page) {
        var nsfw = api.nsfwOn(), s = catSel(cat, sel);
        var sig = cat + '|' + JSON.stringify(s) + '|' + (nsfw ? 1 : 0);
        page = Math.max(1, parseInt(page, 10) || 1);
        if (page === 1 || browseSeen.sig !== sig) browseSeen = { sig: sig, ids: {} };
        var seen = browseSeen.ids, tries = 0;
        function one(pg) {
            var q = Cat.buildQuery(cat, s, pg, { nsfw: nsfw });
            return TV.http(tmdbUrl(q.path, q.params), { timeout: 15000 }).then(function (d) {
                if (browseSeen.sig !== sig) return { items: [], more: false, page: pg };
                var items = [];
                TV.each((d && d.results) || [], function (it) {
                    if (!it || seen[it.id] || !Cat.visible(it, nsfw)) return;
                    seen[it.id] = 1;
                    items.push(tmdbCard(it, q.media));
                });
                var total = Math.min((d && d.total_pages) || 0, 500);
                var more = pg < total;
                if (!items.length && more && ++tries < 3) return one(pg + 1);
                return { items: items, more: more, page: pg };
            });
        }
        return one(page);
    };

    // ---------- 首页 ----------
    // 与 index.html rowConfigs 同口径(sortMode newest = 按首播日期倒排 + 至少 10 票)
    var HOME_ROWS = [
        { id: 'tvRow', title: '热门剧集', path: '/trending/tv/week', params: '' },
        { id: 'movieRow', title: '热门电影', path: '/trending/movie/week', params: '' },
        { id: 'cnRow', title: '国产剧', path: '/discover/tv', params: 'with_origin_country=CN', sortMode: 'newest' },
        { id: 'usRow', title: '美剧', path: '/discover/tv', params: 'with_origin_country=US', sortMode: 'newest' },
        { id: 'krjpRow', title: '日韩剧', path: '/discover/tv', params: 'with_origin_country=KR|JP', sortMode: 'newest' },
        { id: 'animeRow', title: '动漫', path: '/discover/tv', params: 'with_genres=16', sortMode: 'newest' },
        { id: 'varietyRow', title: '综艺', path: '/discover/tv', params: 'with_genres=10764', sortMode: 'newest' },
        { id: 'docRow', title: '纪录片', path: '/discover/movie', params: 'with_genres=99', sortMode: 'newest' }
    ];
    P.HOME_ROWS = HOME_ROWS;
    function rowUrl(r, nsfw) {
        var sortParam = '';
        if (r.sortMode && r.path.indexOf('/discover/') >= 0) {
            var isMovie = r.path.indexOf('/movie') >= 0;
            sortParam = r.sortMode === 'newest' ? '&sort_by=' + (isMovie ? 'primary_release_date.desc' : 'first_air_date.desc') + '&vote_count.gte=10' : '&sort_by=popularity.desc';
        }
        return '/api/tmdb-proxy?path=' + enc(r.path) + '&page=1' + (r.params ? '&' + r.params : '') + sortParam + (nsfw ? '&include_adult=false' : '');
    }
    P.rowUrl = rowUrl;
    function tmdbRow(r) {
        var nsfw = api.nsfwOn(), media = r.path.indexOf('/movie') >= 0 ? 'movie' : 'tv';
        return TV.http(rowUrl(r, nsfw), { timeout: 12000 }).then(function (d) {
            var items = [];
            TV.each((d && d.results) || [], function (it) { if (items.length < 20 && Cat.visible(it, nsfw)) items.push(tmdbCard(it, media)); });
            return items;
        });
    }
    // onRow({ id, title, items, order }) 按固定顺序回调(并发 2 个,先到的等前面的排好);全部失败才 reject
    api.homeRows = function (onRow) {
        var tasks = HOME_ROWS.map(function (r) { return function () { return tmdbRow(r).then(function (items) { return { id: r.id, title: r.title, items: items }; }); }; });
        tasks.push(function () { return popularCards().then(function (items) { return { id: 'popular', title: '大家都在看', items: items }; }); });
        var results = [], emitted = 0, anyOk = false;
        function emit() {
            while (emitted < tasks.length && results[emitted] !== undefined) {
                var r = results[emitted];
                if (r && r.items && r.items.length && onRow) { r.order = emitted; try { onRow(r); } catch (e) { log('onRow', e); } }
                emitted++;
            }
        }
        return pool(tasks, 2, function (t, i) {
            return t().then(function (r) { anyOk = true; results[i] = r; emit(); }, function () { results[i] = null; emit(); });
        }).then(function () {
            emit();
            if (!anyOk) throw new Error('home rows failed');
        });
    };

    // 大家都在看(移植 fetchPopular / _popularPosters,缓存键 / 格式与网页版共用)
    var popMem = null;
    function popularList() {
        if (popMem && now() - popMem.ts < 30 * 60 * 1000) return Promise.resolve(popMem.list);
        var CK = 'donggua_popular_cache3', TTL = 30 * 60 * 1000;
        var tok = token(), t = tok.slice(0, 16);
        var c = lsJSON(CK, null);
        if (c && c.t === t && isArr(c.list) && now() - (c.ts || 0) < TTL) { popMem = { ts: now(), list: c.list }; return Promise.resolve(c.list); }
        return TV.http('/api/popular?window=7d' + (tok ? '&token=' + enc(tok) : ''), { timeout: 8000 }).then(function (d) {
            var good = !!(d && isArr(d.items));
            var seen = {}, list = [];
            TV.each(good ? d.items : [], function (x) {
                var title = str(x && x.title).trim();
                if (!title || title.length > 80 || seen['$' + title] || list.length >= 20) return;
                seen['$' + title] = 1;
                list.push({ title: title });
            });
            var p = list.length >= 4 ? popularPosters(list).then(function (l) { return l.filter(function (x) { return x.poster_path; }); }) : Promise.resolve([]);
            return p.then(function (l) {
                if (good) lsSet(CK, { t: t, ts: now(), list: l });
                popMem = { ts: now(), list: l, titles: list };
                return l;
            });
        });
    }
    function popularPosters(list) {
        var CK = 'donggua_tmdb_title', TTL = 7 * DAY, NEG_TTL = DAY;
        var cache = Object.create(null);
        assign(cache, lsJSON(CK, {}) || {});
        var t0 = now();
        var miss = list.filter(function (x) { var c = cache[x.title]; return !c || (c.p && typeof c.n !== 'string') || t0 - (c.ts || 0) > (c.p ? TTL : NEG_TTL); });
        return pool(miss, 3, function (x) {
            var q = x.title.replace(/第[0-9一二三四五六七八九十]+[季部]/g, '').replace(/Season\s*\d+/ig, '').replace(/\s*(HD|BD|1080P|720P|4K)\s*$/i, '').trim() || x.title;
            return TV.http(tmdbUrl('/search/multi', { query: q, language: 'zh-CN' }), { timeout: 10000 }).then(function (sr) {
                var rs = ((sr && sr.results) || []).filter(function (r) { return r && (r.media_type === 'tv' || r.media_type === 'movie') && r.poster_path && !r.adult; });
                function nm(r) { return String(r.title || r.name || '').trim(); }
                var exact = find(rs, function (r) { return nm(r) === x.title || nm(r) === q; }) || null;
                var hit = exact || rs[0] || null;
                cache[x.title] = hit ? { p: hit.poster_path, n: exact ? x.title : nm(hit), y: String(hit.first_air_date || hit.release_date || '').slice(0, 4), ts: t0 } : { p: '', ts: t0 };
            });
        }).then(function () {
            var ks = keysOf(cache);
            if (ks.length > 300) ssort(ks, function (a, b) { return (cache[a].ts || 0) - (cache[b].ts || 0); }).slice(0, ks.length - 300).forEach(function (k) { delete cache[k]; });
            lsSet(CK, cache);
            return list.map(function (x) { var c = cache[x.title]; return assign({}, x, { poster_path: (c && c.p) || '', name: (c && c.n) || '', year: (c && c.y) || '' }); });
        });
    }
    function popularCards() {
        return popularList().then(function (list) {
            var l = (list || []).filter(function (x) { return x && x.title && x.name && x.poster_path; });
            if (l.length < 4) return [];
            return l.map(function (x) { return { title: String(x.title), poster: api.img(x.poster_path), year: String(x.year || ''), kind: 'title', key: 'pop:' + x.title }; });
        });
    }
    // 搜索页的热门词:大家都在看的片名,没有就 TMDB 本周热门(30 分钟缓存)
    var hotMem = null;
    api.hotWords = function () {
        if (hotMem && now() - hotMem.ts < 30 * 60 * 1000) return Promise.resolve(hotMem.list.slice());
        return popularList().then(function (l) {
            var words = (popMem && popMem.titles ? popMem.titles : l || []).map(function (x) { return x.title; });
            if (words.length >= 4) return words;
            throw new Error('few');
        }).then(null, function () {
            return TV.http(tmdbUrl('/trending/all/week', { page: 1 }), { timeout: 10000 }).then(function (d) {
                var seen = {}, out = [];
                TV.each((d && d.results) || [], function (it) {
                    if (!Cat.visible(it, api.nsfwOn())) return;
                    var n = str(it.title || it.name).trim();
                    if (n && !seen['$' + n]) { seen['$' + n] = 1; out.push(n); }
                });
                return out;
            });
        }).then(function (list) {
            list = (list || []).slice(0, 20);
            hotMem = { ts: now(), list: list };
            return list.slice();
        });
    };

    // ---------- 联想 ----------
    var sugMem = {}, sugSeq = 0;
    // 打字时只发最后一个词(220ms 停顿);被后面的输入顶掉的直接回空
    api.suggest = function (q) {
        q = str(q).replace(/\s+/g, '').slice(0, 20);
        if (!q) return Promise.resolve([]);
        var k = '$' + q.toLowerCase(), hit = sugMem[k];
        if (hit && now() - hit.ts < 10 * 60 * 1000) return Promise.resolve(hit.list.slice());
        var my = ++sugSeq;
        return new Promise(function (resolve) { setTimeout(resolve, 220); }).then(function () {
            if (my !== sugSeq) return [];
            return TV.http('/api/tv/suggest?q=' + enc(q), { timeout: 9000 }).then(function (d) {
                var list = ((d && d.list) || []).filter(function (x) { return x && x.title; }).map(function (x) { return { title: str(x.title), year: str(x.year), kind: str(x.kind) }; });
                sugMem[k] = { ts: now(), list: list };
                var ks = keysOf(sugMem);
                if (ks.length > 200) delete sugMem[ks[0]];
                return list.slice();
            });
        });
    };

    // ---------- 线路档位(移植 srcProfile / SRC_GROUPS / _srcReachClass / _pickPreferred / sourceGroups) ----------
    var SRC_TIER_RANK = { clean: 0, noburn: 1, insert: 2, ads: 3, unknown: 4 };
    var SRC_TIER_GROUP = { clean: 'clean', noburn: 'clean', insert: 'insert', unknown: 'unknown', ads: 'ads' };
    var SRC_GROUP_ORDER = ['clean', 'insert', 'ads', 'unknown', 'unreach'];
    var GROUP_TAG = { clean: ['无广告', 'ok'], insert: ['有插播', 'warn'], ads: ['有水印', 'warn'], unknown: ['可能无法播放', ''], unreach: ['可能无法播放', ''] };
    var UNKNOWN_PROFILE = { tier: 'unknown', res: '', geo: false, note: '', codec: '', clip: false, downgraded: false };
    P.SRC_TIER_RANK = SRC_TIER_RANK;

    function isKzSrc(s) { return !!(s && (s._kz || /^kz_/.test(s.site_key || ''))); }
    function isKzUrl(u) { return typeof u === 'string' && /(^|\/)api\/kz\/ep\//.test(u); }
    P.isKzUrl = isKzUrl;
    function kzWorkerOk() {
        try {
            var host = String(location.hostname || '').toLowerCase();
            return !!host && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)/.test(host) && !/\.(local|localhost|lan|internal)$/.test(host);
        } catch (e) { return false; }
    }
    function adProxyBad(siteKey) {
        if (!siteKey) return false;
        var m = lsJSON('donggua_adproxy_bad2', {}) || {};
        return !!(m[siteKey] && now() - m[siteKey] < 12 * 3600 * 1000);
    }
    api.adProxyBad = adProxyBad;
    // 移植 _adProxyBadMark:源站封了 worker(探测 403/404)才记,12h,最多 60 个
    api.markAdProxyBad = function (siteKey) {
        if (!siteKey) return;
        var m = lsJSON('donggua_adproxy_bad2', {}) || {};
        m[siteKey] = now();
        var ks = keysOf(m);
        if (ks.length > 60) ssort(ks, function (a, b) { return m[a] - m[b]; }).slice(0, ks.length - 60).forEach(function (k) { delete m[k]; });
        lsSet('donggua_adproxy_bad2', m);
    };
    var hevcMemo = null;
    function hevcOk() {
        if (hevcMemo === null) {
            var ok = false;
            try {
                var MS = window.MediaSource || window.WebKitMediaSource;
                ok = !!(MS && typeof MS.isTypeSupported === 'function' && (MS.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"') || MS.isTypeSupported('video/mp4; codecs="hev1.1.6.L120.90"')));
            } catch (e) { ok = false; }
            hevcMemo = ok;
        }
        return hevcMemo;
    }
    // 播放器能不能按分辨率突变跳插播(TV.play 的 adClipSkip 端口);播放层给了判断就用它的
    function clipOn() {
        try {
            if (TV.play && typeof TV.play.clipOn === 'function') return !!TV.play.clipOn();
            if (!window.AdClipCore || typeof window.AdClipCore.probeTs !== 'function') return false;
            if (!(window.Hls && window.Hls.isSupported && window.Hls.isSupported())) return false;
            if (!api.adFilterOn()) return false;
            return lsRaw('donggua_adclip_off') !== '1';
        } catch (e) { return false; }
    }
    // 去广告 worker 在不在这条线路的播放链路里(与播放分流条件一致)
    function filterOn(l) {
        if (!l || !api.proxy()) return false;
        if ((l.test === 'kz' || l.kz) && !kzWorkerOk()) return false;
        if (l.useProxy) return true;
        if (!api.adFilterOn()) return false;
        return !adProxyBad(l.key);
    }
    // 线路 → 档案(env 只给测试注入:{ profiles, filterOn(l), clipOn() })
    function profileOf(l, env) {
        if (!l) return UNKNOWN_PROFILE;
        var profs = env && env.profiles ? env.profiles : siteProfiles;
        var raw = l.raw || {};
        var p = raw.site_profile || (profs && l.key ? profs[l.key] : null);
        if (!p || typeof p !== 'object') return UNKNOWN_PROFILE;
        var tier = p.tier || p.t;
        if (!hasOwn(SRC_TIER_RANK, tier)) tier = 'unknown';
        var clip = !!p.clip, downgraded = false;
        if (tier === 'noburn' && (clip ? !(env && env.clipOn ? env.clipOn() : clipOn()) : !(env && env.filterOn ? env.filterOn(l) : filterOn(l)))) { tier = 'insert'; downgraded = true; }
        return { tier: tier, res: String(p.res || p.r || ''), geo: !!p.geo, note: String(p.note || p.n || ''), codec: String(p.codec || p.c || ''), clip: clip, downgraded: downgraded };
    }
    P.profileOf = profileOf;
    function resRankOf(res) {
        var r = String(res || '').toLowerCase();
        return (r.indexOf('4k') >= 0 || r.indexOf('2160') >= 0) ? 4 : (r.indexOf('2k') >= 0 || r.indexOf('1440') >= 0) ? 3 :
            r.indexOf('1080') >= 0 ? 2 : r.indexOf('720') >= 0 ? 1 : 0;
    }
    function resTagOf(w, h) {
        w = +w || 0; h = +h || 0;
        if (!w || !h) return '';
        var Lg = Math.max(w, h), Sm = Math.min(w, h);
        return (Lg >= 3200 || Sm >= 2000) ? '4k' : (Lg >= 2400 || Sm >= 1400) ? '2k' : (Lg >= 1800 || Sm >= 1000) ? '1080p' : (Lg >= 1200 || Sm >= 700) ? '720p' : 'sd';
    }
    P.resRankOf = resRankOf;
    P.resTagOf = resTagOf;
    // 实测分辨率(donggua_src_res,站点|vod_id,30 天,600 条;与网页版共用)
    var resMemo = null;
    function resMemoGet() { if (!resMemo) { var m = lsJSON('donggua_src_res', null); resMemo = (m && typeof m === 'object' && !isArr(m)) ? m : {}; } return resMemo; }
    function realRes(l) {
        if (!l || !l.key || l.vodId == null) return null;
        var r = resMemoGet()[l.key + '|' + l.vodId];
        return (r && r.w && r.h) ? r : null;
    }
    function setRes(l, w, h, from) {
        w = Math.round(+w || 0); h = Math.round(+h || 0);
        if (!l || w < 64 || h < 64 || w > 16384 || h > 16384 || !l.key || l.vodId == null) return;
        var old = realRes(l);
        if (old && old.from === 'm3u8' && from !== 'm3u8') return;
        var m = resMemoGet(), t = now(), TTL = 30 * DAY;
        m[l.key + '|' + l.vodId] = { w: w, h: h, from: from, ts: t };
        keysOf(m).forEach(function (k) { if (!m[k] || t - (m[k].ts || 0) > TTL) delete m[k]; });
        var left = keysOf(m);
        if (left.length > 600) ssort(left, function (a, b) { return (m[a].ts || 0) - (m[b].ts || 0); }).slice(0, left.length - 600).forEach(function (k) { delete m[k]; });
        lsSet('donggua_src_res', m);
    }
    // 播放器拿到画面尺寸时可以记一笔(from = 'play';主清单写了的不被覆盖)
    api.noteRes = function (line, w, h) { setRes(line, w, h, 'play'); if (line) applyMeta(line); };
    function masterRes(text) {
        if (!text || !/#EXT-X-STREAM-INF/i.test(text)) return null;
        var re = /#EXT-X-STREAM-INF:[^\n]*?RESOLUTION=(\d+)x(\d+)/gi, m, best = null;
        while ((m = re.exec(text))) { var w = +m[1], h = +m[2]; if (!best || w * h > best.w * best.h) best = { w: w, h: h }; }
        return best;
    }
    P.masterRes = masterRes;
    function resOf(l, p) { var r = realRes(l); return r ? resTagOf(r.w, r.h) : (p || profileOf(l)).res; }
    function resLabel(res) {
        var r = String(res || '').toLowerCase();
        if (!r) return '';
        var k = resRankOf(r);
        return k === 4 ? '4K' : k === 3 ? '2K' : k === 2 ? '1080P' : k === 1 ? '720P' : '标清';
    }
    // 可达档:0 直连测通(或无广告的 kz)/ 1 代理 / 2 服务器或没测 / 3 其余 kz / -1 不可自动选
    function reachClass(l, env) {
        if (!l || typeof l.latency !== 'number' || l.latency >= 9000) return -1;
        if (l.test === 'kz' || l.kz) {
            if (l.kzMismatch) return -1;
            var p = profileOf(l, env);
            return (p.tier === 'clean' && (p.codec !== 'hevc' || (env && env.hevcOk ? env.hevcOk() : hevcOk()))) ? 0 : 3;
        }
        if (l.test === 'direct') return 0;
        if (l.test === 'proxy') return 1;
        return 2;
    }
    P.reachClass = reachClass;
    function tierRank(l, env) { return SRC_TIER_RANK[profileOf(l, env).tier]; }
    // 档内挑选(移植 _pickPreferred):不比最快的慢太多的候选里,按 档位 → 分辨率(只比到 1080P)→ 延迟
    function pickPreferred(cands, env) {
        if (!cands || !cands.length) return null;
        var fastest = Infinity;
        TV.each(cands, function (s) { if (s.latency < fastest) fastest = s.latency; });
        var lim = Math.max(fastest + 800, fastest * 2);
        function isClean(s) { return s.latency < 2000 && tierRank(s, env) <= SRC_TIER_RANK.noburn; }
        var fc = Infinity;
        TV.each(cands, function (s) { if (isClean(s) && s.latency < fc) fc = s.latency; });
        var limC = Math.max(fc + 800, fc * 2);
        var ok = cands.filter(function (s) { return s.latency < 3000 && (s.latency <= lim || (isClean(s) && s.latency <= limC)); });
        var pool_ = ok.length ? ok : cands.filter(function (s) { return s.latency <= lim; });
        var meta = pool_.map(function (s) { var p = profileOf(s, env); return [SRC_TIER_RANK[p.tier], Math.min(2, resRankOf(env && env.resOf ? env.resOf(s, p) : resOf(s, p)))]; });
        var idx = pool_.map(function (s, i) { return i; });
        idx = ssort(idx, function (a, b) { return (meta[a][0] - meta[b][0]) || (meta[b][1] - meta[a][1]) || (pool_[a].latency - pool_[b].latency); });
        return pool_[idx[0]];
    }
    P.pickPreferred = pickPreferred;
    function autoPick(lines, maxClass, maxLatency, env) {
        var lim = maxLatency || 9000;
        var list = (lines || []).filter(function (s) { return typeof s.latency === 'number' && s.latency < lim; });
        for (var c = 0; c <= maxClass; c++) {
            var cands = list.filter(function (s) { return reachClass(s, env) === c; });
            if (cands.length) return pickPreferred(cands, env);
        }
        return null;
    }
    P.autoPick = autoPick;
    function unreach(l, env) { return !!(l && l.srvOnly) && reachClass(l, env) === 2; }
    function groupOf(l, env) { var p = profileOf(l, env); return (unreach(l, env) || p.tier === 'unknown') ? 'unreach' : SRC_TIER_GROUP[p.tier]; }
    // 档位 / 标签 / 分辨率写回线路(测速、换代理后重算)
    function applyMeta(l) {
        var p = profileOf(l), g = groupOf(l), t = GROUP_TAG[g] || ['', ''];
        l.tier = p.tier;
        l.tag = t[0];
        l.tagCls = t[1];
        l.res = resLabel(resOf(l, p));
        l.geo = p.geo;
        return l;
    }
    // 显示顺序 = 自动换线顺序(移植 sourceGroups + availableSources);测不通的(≥9000)排最后
    function orderList(lines, env) {
        var by = {}, meta = new Map(), dead = [];
        TV.each(lines, function (s) {
            if (!(typeof s.latency === 'number' && s.latency < 9000)) { dead.push(s); return; }
            var p = profileOf(s, env);
            meta.set(s, [SRC_TIER_RANK[p.tier], resRankOf(env && env.resOf ? env.resOf(s, p) : resOf(s, p))]);
            var gid = (unreach(s, env) || p.tier === 'unknown') ? 'unreach' : SRC_TIER_GROUP[p.tier];
            (by[gid] = by[gid] || []).push(s);
        });
        var out = [];
        TV.each(SRC_GROUP_ORDER, function (gid) {
            if (!by[gid]) return;
            var isU = gid === 'unreach';
            ssort(by[gid], function (a, b) {
                var ma = meta.get(a), mb = meta.get(b);
                return ((a.kzMismatch ? 1 : 0) - (b.kzMismatch ? 1 : 0)) ||
                    (isU ? (unreach(a, env) ? 1 : 0) - (unreach(b, env) ? 1 : 0) : 0) ||
                    (isU ? 0 : ((a.latency >= 600 ? 1 : 0) - (b.latency >= 600 ? 1 : 0))) || (ma[0] - mb[0]) || (mb[1] - ma[1]) || (a.latency - b.latency);
            }).forEach(function (s) { out.push(s); });
        });
        return out.concat(dead);
    }
    P.orderList = orderList;
    // 会改 work.lines 的顺序:播放器拿着线路下标时别调
    api.orderLines = function (work) {
        if (!work || !work.lines) return [];
        TV.each(work.lines, applyMeta);
        var sorted = orderList(work.lines);
        work.lines.length = 0;
        TV.each(sorted, function (l) { work.lines.push(l); });
        return work.lines;
    };
    api.bestLine = function (work, maxLatency) {
        var lines = (work && work.lines) || [];
        if (!lines.length) return -1;
        var pick = autoPick(lines, 2, maxLatency) || find(lines, function (l) { return typeof l.latency === 'number' && l.latency < 9000; }) || lines[0];
        return lines.indexOf(pick);
    };

    // ---------- 选集(移植 parseEpisodes / _epMatchKey / _sourceHasEpisode) ----------
    function pickRoad(urlStr) {
        var s = str(urlStr);
        if (s.indexOf('$$$') >= 0) { var sets = s.split('$$$'); return find(sets, function (x) { return x.toLowerCase().indexOf('m3u8') >= 0; }) || sets[0]; }
        return s;
    }
    function parseEps(urlStr) {
        return pickRoad(urlStr).split('#').map(function (ep) {
            var p = ep.split('$');
            return { name: p.length > 1 ? p[0] : '正片', url: p.length > 1 ? p[1] : p[0] };
        });
    }
    function epMatchKey(name) {
        var s = String(name || '').trim();
        if (!s) return '';
        var core = null;
        var d = s.match(/(?:^|\D)((?:19|20)\d{2})[-./]?(\d{2})[-./]?(\d{2})(?=\D|$)/);
        if (d && +d[2] >= 1 && +d[2] <= 12 && +d[3] >= 1 && +d[3] <= 31) core = d[1] + d[2] + d[3];
        if (!core) {
            var n = s.match(/第\s*0*(\d+)\s*[集话話期]/) || s.match(/(?:^|[^a-z0-9])ep\.?\s*0*(\d+)/i) || s.match(/^0*(\d+)$/);
            if (n) core = 'N' + parseInt(n[1], 10);
        }
        if (!core) return 'T' + s.toLowerCase().replace(/\s+/g, '');
        var suf = '';
        var rest = s.replace(/(?:19|20)?\d{2,8}/g, '');
        var re = /(上|中|下|加更|纯享|先导|特辑|彩蛋|花絮|预告|回顾|集结篇|plus)/g, m2;
        while ((m2 = re.exec(rest))) suf += m2[1];
        return core + '|' + suf.toLowerCase();
    }
    // true = 有 / false = 确实没有 / null = 还不知道(选集没拉到)
    function hasEpIn(playUrl, epName) {
        if (!epName) return true;
        if (!playUrl) return null;
        var seg = pickRoad(playUrl);
        var want = epMatchKey(epName), core = want.split('|')[0];
        var names = seg.split('#').map(function (e) { return e.split('$')[0]; });
        if (names.some(function (n) { return epMatchKey(n) === want; })) return true;
        if (core && names.some(function (n) { return epMatchKey(n).split('|')[0] === core; })) return true;
        return false;
    }
    // ① 原名全等 ② 归一化键全等 ③ 同期号 / 同日期但"部分"不同 ④ fallbackIdx(不传 = 第一集;传负数 = 找不到就回 -1;超出范围 = 第一集)
    function matchEpIn(eps, epName, fallbackIdx) {
        if (!eps || !eps.length) return -1;
        var fb = typeof fallbackIdx !== 'number' ? 0 : fallbackIdx < 0 ? -1 : fallbackIdx < eps.length ? fallbackIdx : 0;
        if (!epName) return fb;
        var wantKey = epMatchKey(epName), wantCore = wantKey.split('|')[0];
        var i = findIdx(eps, function (ep) { return ep.name === epName; });
        if (i < 0) i = findIdx(eps, function (ep) { return epMatchKey(ep.name) === wantKey; });
        if (i < 0 && wantCore) i = findIdx(eps, function (ep) { return epMatchKey(ep.name).split('|')[0] === wantCore; });
        return i >= 0 ? i : fb;
    }
    P.parseEps = parseEps;
    P.epMatchKey = epMatchKey;
    P.hasEpIn = hasEpIn;
    P.matchEpIn = matchEpIn;
    api.matchEp = function (line, epName, fallbackIdx) { return matchEpIn(line && line.eps, epName, fallbackIdx); };
    api.hasEp = function (line, ep) {
        if (!line) return false;
        if (typeof ep === 'number') return line.eps && line.eps.length ? ep >= 0 && ep < line.eps.length : (line.playUrl ? ep >= 0 && ep < parseEps(line.playUrl).length : null);
        return hasEpIn(line.playUrl, ep);
    };
    // 选集:有 vod_play_url 直接解析;没有(Kazumi / 历史快照)再拉详情(20s)。拿不到回 [](不 reject)
    api.loadEps = function (line) {
        if (!line) return Promise.resolve([]);
        if (line.eps && line.eps.length) return Promise.resolve(line.eps);
        if (line.playUrl) { line.eps = parseEps(line.playUrl); return Promise.resolve(line.eps); }
        if (line._epsP) return line._epsP;
        line._epsP = TV.http('/api/detail?site_key=' + enc(line.key) + '&id=' + enc(line.vodId), { timeout: 20000 }).then(function (d) {
            var v = d && d.list && d.list[0];
            if (v && v.vod_play_url) { line.playUrl = String(v.vod_play_url); line.eps = parseEps(line.playUrl); if (v.vod_year && !line.year) line.year = String(v.vod_year); }
            line._epsP = null;
            return line.eps || [];
        }, function () { line._epsP = null; line.epsErr = true; return []; });
        return line._epsP;
    };

    // ---------- 搜索结果 → 作品(移植 splitSameNameWorks + groupedList) ----------
    function splitSameNameWorks(items) {
        var list = (items || []).filter(Boolean);
        function firstUrl(it) {
            var roads = String(it.vod_play_url || '').split('$$$');
            var road = find(roads, function (r) { return /\.m3u8/i.test(r); }) || roads[0] || '';
            var ep = road.split('#')[0] || '';
            var u = ep.indexOf('$') >= 0 ? ep.slice(ep.indexOf('$') + 1) : ep;
            return /^https?:\/\//i.test(u.trim()) ? u.trim() : '';
        }
        function urlKey(it) {
            var u = firstUrl(it).replace(/^https?:\/\/[^\/]+/i, '').split('?')[0];
            return u.split('/').filter(Boolean).length >= 2 ? u : '';
        }
        function sigOf(it) {
            var roads = String(it.vod_play_url || '').split('$$$').filter(function (r) { return r.trim(); });
            var road = find(roads, function (r) { return /\.m3u8/i.test(r); }) || roads[0] || '';
            var eps = road ? road.split('#').filter(function (e) { return e.trim(); }).length : 0;
            if (!eps) { var m = String(it.vod_remarks || '').match(/(\d{1,4})\s*[集话話期]/); eps = m ? parseInt(m[1], 10) : 0; }
            var ym = String(it.vod_year || '').match(/(19|20)\d{2}/);
            return { eps: eps, y: ym ? parseInt(ym[0], 10) : 0, movie: eps > 0 && eps <= 2, uk: urlKey(it) };
        }
        var sigs = new Map();
        list.forEach(function (it) { sigs.set(it, sigOf(it)); });
        function twin(a, b) { var x = sigs.get(a).uk; return !!x && x === sigs.get(b).uk; }
        function dYear(a, b) { return (a.y && b.y) ? Math.abs(a.y - b.y) : 0; }
        function compat(a, b) {
            if (!a.eps || !b.eps) return true;
            if (a.movie !== b.movie) return false;
            if (dYear(a, b) >= 2) return false;
            return a.movie || Math.min(a.eps, b.eps) / Math.max(a.eps, b.eps) >= 0.5;
        }
        function dist(a, p) {
            return (a.movie !== p.movie ? 100 : 0) + ((!a.movie && !p.movie) ? Math.abs(Math.log(a.eps / p.eps)) * 10 : 0) + Math.min(dYear(a, p), 5) * 5;
        }
        function siteOf(it) { return it.site_key || it.site_name || ''; }
        var bySite = new Map();
        list.forEach(function (it) { var k = siteOf(it); if (!bySite.has(k)) bySite.set(k, []); bySite.get(k).push(it); });
        var cands = [];
        bySite.forEach(function (arr) {
            if (arr.length < 2) return;
            var known = arr.filter(function (it) { return sigs.get(it).eps > 0; });
            if (!known.some(function (a, i) { return known.some(function (b, j) { return j > i && !twin(a, b) && !compat(sigs.get(a), sigs.get(b)); }); })) return;
            known.filter(function (it) {
                return !known.some(function (o) { return o !== it && twin(o, it) && sigs.get(o).eps >= sigs.get(it).eps && (sigs.get(o).eps > sigs.get(it).eps || known.indexOf(o) < known.indexOf(it)); });
            }).forEach(function (it) { cands.push(sigs.get(it)); });
        });
        cands = ssort(cands, function (a, b) { return (a.movie - b.movie) || (a.y - b.y) || (b.eps - a.eps); });
        var protos = [];
        cands.forEach(function (s) {
            var p = find(protos, function (q) { return q.members.every(function (m) { return compat(m, s); }); });
            if (p) { p.members.push(s); if (s.eps > p.sig.eps && !s.movie) p.sig = assign({}, p.sig, { eps: s.eps }); if (!p.sig.y && s.y) p.sig = assign({}, p.sig, { y: s.y }); }
            else protos.push({ sig: assign({}, s), members: [s], items: [] });
        });
        protos = ssort(protos, function (a, b) { return (a.sig.movie - b.sig.movie) || (a.sig.y - b.sig.y) || (a.sig.eps - b.sig.eps); });
        var clusters;
        if (protos.length < 2) clusters = [{ sig: null, items: list.slice() }];
        else {
            var unknown = [];
            list.forEach(function (it) {
                var s = sigs.get(it);
                if (!s.eps) { unknown.push(it); return; }
                var best = protos[0], bd = Infinity;
                protos.forEach(function (p) { var d = dist(s, p.sig); if (d < bd) { bd = d; best = p; } });
                best.items.push(it);
            });
            var home = new Map();
            protos.forEach(function (p) {
                p.items.forEach(function (it) {
                    var k = sigs.get(it).uk;
                    if (!k) return;
                    var h = home.get(k);
                    if (!h || sigs.get(it).eps > sigs.get(h.it).eps) home.set(k, { it: it, p: p });
                });
            });
            protos.forEach(function (p) {
                p.items = p.items.filter(function (it) {
                    var h = home.get(sigs.get(it).uk);
                    if (!h || h.p === p) return true;
                    h.p.items.push(it);
                    return false;
                });
            });
            var sitesN = function (c) { var seen = {}, n = 0; c.items.forEach(function (it) { var k = '$' + siteOf(it); if (!seen[k]) { seen[k] = 1; n++; } }); return n; };
            clusters = ssort(protos.filter(function (p) { return p.items.length; }), function (a, b) { return (sitesN(b) - sitesN(a)) || (a.sig.y - b.sig.y); });
            if (!clusters.length) clusters = [{ sig: null, items: [] }];
            Array.prototype.push.apply(clusters[0].items, unknown);
        }
        function tierOf(it) { var t = it.site_profile && (it.site_profile.tier || it.site_profile.t); return hasOwn(SRC_TIER_RANK, t) ? SRC_TIER_RANK[t] : SRC_TIER_RANK.unknown; }
        var overflow = [];
        function dedupe(arr) {
            var keep = new Map();
            arr.forEach(function (it) {
                var k = siteOf(it);
                var cur = keep.get(k);
                if (!cur) { keep.set(k, it); return; }
                var a = sigs.get(it), b = sigs.get(cur);
                var better = a.eps > b.eps || (a.eps === b.eps && a.y > b.y);
                var distinct = a.y && b.y && a.y !== b.y && !twin(it, cur) && firstUrl(it) && firstUrl(cur);
                var loser = better ? cur : it;
                if (better) keep.set(k, it);
                if (distinct) overflow.push(loser);
            });
            var byUrl = new Map(), result = [];
            keep.forEach(function (it) {
                var u = firstUrl(it);
                if (!u) { result.push(it); return; }
                var prev = byUrl.get(u);
                if (!prev) { byUrl.set(u, it); result.push(it); return; }
                var de = sigs.get(it).eps - sigs.get(prev).eps;
                if (de > 0 || (de === 0 && tierOf(it) < tierOf(prev))) { result[result.indexOf(prev)] = it; byUrl.set(u, it); }
            });
            return result;
        }
        var works = clusters.map(function (c) { return { items: dedupe(c.items), all: c.items.slice() }; });
        if (overflow.length) {
            var ex = new Map();
            overflow.forEach(function (it) { var s = sigs.get(it); var k = s.y + (s.movie ? 'm' : 's'); if (!ex.has(k)) ex.set(k, []); ex.get(k).push(it); });
            ex.forEach(function (arr) { works.push({ items: dedupe(arr), all: arr.slice() }); });
        }
        function describe(arr) {
            var yc = {}, eps = 0, movie = false;
            arr.forEach(function (it) { var s = sigs.get(it); if (s.y) yc[s.y] = (yc[s.y] || 0) + 1; if (s.eps > eps) { eps = s.eps; movie = s.movie; } });
            var y = 0, n = 0;
            keysOf(yc).forEach(function (k) { var c = yc[k]; if (c > n || (c === n && +k > y)) { n = c; y = +k; } });
            return { y: y, eps: eps, movie: movie };
        }
        var out = [];
        var split = works.filter(function (w) { return w.items.length; }).length > 1;
        var ds = works.map(function (w) { return describe(w.items); });
        var base = ds.map(function (d) { return split ? 'y' + (d.y || 0) + (d.movie ? 'm' : 's') : ''; });
        var cnt = {};
        base.forEach(function (b) { cnt[b] = (cnt[b] || 0) + 1; });
        var used = new Set();
        works.forEach(function (w, i) {
            var d = ds[i];
            var sig = base[i], label = '';
            if (split) {
                if (cnt[sig] > 1) sig += 'e' + Math.round(log2(Math.max(1, d.eps)));
                while (used.has(sig)) sig += '+';
                used.add(sig);
                label = (d.y ? d.y + ' · ' : '') + (d.movie ? '全' + d.eps + '集' : (d.eps ? d.eps + '集' : ''));
            }
            out.push({ work: i === 0 ? '' : sig, sig: sig, label: label, items: w.items, all: w.all || w.items });
        });
        return out;
    }
    P.splitSameNameWorks = splitSameNameWorks;

    function isDefaultPic(url) { var u = str(url); return !u || u.indexOf('mac_default') >= 0 || u.indexOf('nopic') >= 0; }
    // 移植 groupedList(不含 Kazumi 片名吸附 _kzSnapGroups:要 kz-titlematch.js,电视版没加载)→ [{ name, pic, _work, _workSig, _workLabel, sources }]
    function groupList(rawList) {
        var groups = Object.create(null);
        TV.each(rawList || [], function (item) {
            var name = item.vod_name;
            if (!groups[name]) groups[name] = { name: name, pic: item.vod_pic, items: [] };
            if (isDefaultPic(groups[name].pic) && !isDefaultPic(item.vod_pic)) groups[name].pic = item.vod_pic;
            groups[name].items.push(item);
        });
        var out = [];
        keysOf(groups).forEach(function (k) {
            var g = groups[k];
            splitSameNameWorks(g.items).forEach(function (w) {
                if (!w.items.length) return;
                var pic = g.pic;
                if (w.label) { var p = find(w.items, function (it) { return !isDefaultPic(it.vod_pic); }); pic = p ? p.vod_pic : ''; }
                out.push({
                    name: g.name, pic: pic, _work: w.work, _workSig: w.sig, _workLabel: w.label,
                    sources: w.items.map(function (item) { return assign({}, item, { latency: item.latency || 999 }); })
                });
            });
        });
        return ssort(out, function (a, b) { return b.sources.length - a.sources.length; });
    }
    P.groupList = groupList;

    function buildLine(s) {
        var l = {
            name: str(s.site_name || s.site_key), key: str(s.site_key), vodId: s.vod_id,
            tier: 'unknown', tag: '', tagCls: '', res: '',
            latency: typeof s.latency === 'number' ? s.latency : 999,
            test: s._testType || '', useProxy: !!s._useProxy, proxyUrl: s._proxyUrl || '', srvOnly: !!s._srvOnly,
            playUrl: str(s.vod_play_url), eps: [], raw: s,
            kz: isKzSrc(s), kzMismatch: !!s._kzMismatch, year: str(s.vod_year)
        };
        if (l.playUrl) l.eps = parseEps(l.playUrl);
        return applyMeta(l);
    }
    P.buildLine = buildLine;
    function stripHtml(s) { return str(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(); }
    function workFromGroup(g) {
        var srcs = g.sources || [];
        function first(f) { var x = find(srcs, function (s) { return s && s[f] && String(s[f]).trim(); }); return x ? String(x[f]).trim() : ''; }
        var ym = /(19|20)\d{2}/.exec(first('vod_year'));
        var w = {
            title: str(g.name), poster: isDefaultPic(g.pic) ? '' : str(g.pic), year: ym ? ym[0] : '',
            type: first('type_name'), area: first('vod_area'), desc: stripHtml(first('vod_content')).slice(0, 400), remarks: first('vod_remarks'),
            sig: g._workSig || '', label: g._workLabel || '',
            lines: srcs.map(buildLine), key: str(g.name) + '|' + (g._workSig || ''), group: g
        };
        return w;
    }
    P.workFromGroup = workFromGroup;
    api.workCard = function (w) {
        return {
            title: w.title, poster: api.img(w.poster), year: w.year, note: w.remarks ? w.remarks.slice(0, 10) : '',
            badge: w.lines.length + ' 线', sub: w.label || [w.year, w.type].filter(Boolean).join(' · '),
            kind: 'work', work: w, key: 'work:' + w.key
        };
    };
    // 从观看历史回放:用快照里的线路(测速结果原样带着),上次用的线路排第一
    api.workFromHistory = function (hist) {
        var g = (hist && hist.groupData) || { name: hist && hist.name, pic: hist && hist.poster, sources: [] };
        var srcs = (g.sources || []).map(function (s, i) { return assign({}, s, { site_key: s.site_key || (s.site_name + '_' + i), latency: s.latency || 500 }); });
        var w = workFromGroup(assign({}, g, { name: g.name || hist.name, pic: g.pic || (hist && hist.poster) || '', sources: srcs }));
        if (!w.poster && hist && hist.poster) w.poster = hist.poster;
        var lk = hist && hist.lastSourceKey;
        var i = lk ? findIdx(w.lines, function (l) { return l.key === lk; }) : -1;
        if (i > 0) w.lines.unshift(w.lines.splice(i, 1)[0]);
        w.fromHistory = true;
        return w;
    };

    // 同一部作品在连续几次局部结果里保持同一个对象(卡片拿着它,点开时线路是最新的);已测速的线路结果保留
    function mergeWorks(groups, prev) {
        return groups.map(function (g) {
            var w = workFromGroup(g), old = prev && prev[w.key];
            if (!old) return w;
            var oldBy = {};
            TV.each(old.lines, function (l) { oldBy[l.key + '|' + l.vodId] = l; });
            w.lines = w.lines.map(function (l) { return oldBy[l.key + '|' + l.vodId] || l; });
            for (var k in w) if (hasOwn(w, k)) old[k] = w[k];
            return old;
        });
    }
    var curSearch = null;
    // 搜线路:SSE 流式(先到的站先回调 onPartial,最多 600ms 一次),done 时 resolve;EventSource 没有 / 一开始就断 → 普通 GET。25s 兜底
    api.searchWorks = function (word, onPartial, opt) {
        opt = opt || {};
        word = str(word).trim();
        if (curSearch) curSearch.stop();
        if (!word) return Promise.resolve([]);
        return new Promise(function (resolve, reject) {
            var raw = [], es = null, done = false, got = false, byKey = {}, lastP = 0, pT = 0, hardT = 0;
            var me = { stop: function () { finish(); } };
            curSearch = me;
            function works() {
                var ws = mergeWorks(groupList(raw), byKey);
                byKey = {};
                TV.each(ws, function (w) { byKey[w.key] = w; });
                return ws;
            }
            function finish(err) {
                if (done) return;
                done = true;
                clearTimeout(pT); clearTimeout(hardT);
                if (es) { try { es.close(); } catch (e) { } es = null; }
                if (curSearch === me) curSearch = null;
                if (err && !raw.length) reject(err); else resolve(works());
            }
            function partial() {
                pT = 0;
                if (done || !onPartial) return;
                lastP = now();
                try { onPartial(works()); } catch (e) { log('onPartial', e); }
            }
            function add(items) {
                if (done || !isArr(items) || !items.length) return;
                got = true;
                raw = raw.concat(items);
                if (!onPartial || pT) return;
                var wait = 600 - (now() - lastP);
                if (wait <= 0) partial(); else pT = setTimeout(partial, wait);
            }
            function plain() {
                if (done) return;
                TV.http('/api/search?wd=' + enc(word), { timeout: 20000 }).then(function (d) {
                    add((d && d.list) || []);
                    finish();
                }, function (e) { finish(e); });
            }
            hardT = setTimeout(function () { finish(); }, opt.timeout || 25000);
            var url = '/api/search?wd=' + enc(word) + '&stream=true' + (opt.original && opt.original !== word ? '&original=' + enc(opt.original) : '');
            if (!window.EventSource) { plain(); return; }
            try { es = new EventSource(url); } catch (e) { es = null; plain(); return; }
            es.onmessage = function (e) { try { add(JSON.parse(e.data)); } catch (x) { } };
            es.addEventListener('done', function () { finish(); });
            es.onerror = function () {
                if (done) return;
                try { es.close(); } catch (x) { }
                es = null;
                if (!got) plain(); else finish();
            };
        });
    };
    api.cancelSearch = function () { if (curSearch) curSearch.stop(); };

    // 片名归一(去空格 / 标点 / 大小写)
    function normTitle(s) { return str(s).toLowerCase().replace(/[\s·・:：,，.。!！?？'"“”‘’\-—_()（）\[\]【】《》]+/g, ''); }
    P.normTitle = normTitle;
    // 从 TMDB 卡 / 片名打开:先找片名一致的(年份差 ≤1、线路最多),再找片名包含的
    function pickWork(works, title, o) {
        o = o || {};
        var t = normTitle(title), orig = normTitle(o.original), y = parseInt(o.year, 10) || 0;
        var exact = works.filter(function (w) { var n = normTitle(w.title); return n === t || (orig && n === orig); });
        if (exact.length) {
            var score = function (w) {
                var s = 0, wy = parseInt(w.year, 10) || 0;
                if (y && wy) s += Math.abs(wy - y) <= 1 ? 4 : -4;
                if (o.media) { var movie = /m/.test(w.sig || '') || (w.lines[0] && w.lines[0].eps.length > 0 && w.lines[0].eps.length <= 2); s += (o.media === 'movie') === !!movie ? 1 : 0; }
                return s;
            };
            return ssort(exact, function (a, b) { return (score(b) - score(a)) || (b.lines.length - a.lines.length); })[0];
        }
        return find(works, function (w) { var n = normTitle(w.title); return t && (n.indexOf(t) >= 0 || t.indexOf(n) >= 0); }) || null;
    }
    P.pickWork = pickWork;
    // 搜到的 Work 在搜索继续时会被原地更新(lines 换成新数组、顺序也会变);交给详情页 / 播放器的要是一份快照,
    // 否则它们手里的线路下标会对不上
    api.snapshotWork = function (w) {
        if (!w) return w;
        var c = assign({}, w);
        c.lines = (w.lines || []).slice();
        return c;
    };
    // 首页卡片 / 片名点进来:不等全部资源站(慢站要 20 多秒)—— 片名对上的那部已经有 3 条线路(或者搜了 5 秒还有片名对上的),
    // 就先拿这些开详情页,搜索停掉;都没对上就等到搜完
    api.findWork = function (title, o) {
        o = o || {};
        var t0 = now(), early = null;
        return new Promise(function (resolve, reject) {
            var settled = false, tick = 0;
            function take(w) { if (settled) return; settled = true; clearInterval(tick); resolve(api.snapshotWork(w)); }
            function check(ws) {
                if (settled) return;
                var w = pickWork(ws || [], title, o);
                if (!w || normTitle(w.title) !== normTitle(title) && !(o.original && normTitle(w.title) === normTitle(o.original))) return;
                early = w;
                var t = now() - t0;
                if ((w.lines.length >= 3 && t > 2500) || t > 5000) { take(w); api.cancelSearch(); }
            }
            var last = null;
            tick = setInterval(function () { if (last) check(last); }, 800);
            api.searchWorks(title, function (ws) { last = ws; check(ws); }, { original: o.original }).then(function (ws) {
                if (settled) return;
                var w = pickWork(ws, title, o);
                if (w) { take(w); return; }
                clearInterval(tick);
                if (o.original && o.original !== title) {
                    settled = true;
                    api.searchWorks(o.original, null).then(function (ws2) { resolve(api.snapshotWork(pickWork(ws2, o.original, o))); }, reject);
                    return;
                }
                take(null);
            }, function (e) { if (settled) return; settled = true; clearInterval(tick); if (early) resolve(api.snapshotWork(early)); else reject(e); });
        });
    };

    // ---------- 测速(移植 latencyWorker / _clientProbe / _m3u8HasFragments / 站点健康缓存) ----------
    // 相对地址 → 绝对(老内核用不了 new URL)
    function resolveUrl(rel, base) {
        rel = str(rel).trim();
        if (/^[a-z][a-z0-9+.\-]*:/i.test(rel)) return rel;
        var m = /^([a-z][a-z0-9+.\-]*:)\/\/([^\/?#]*)([^?#]*)/i.exec(str(base));
        if (!m) return rel;
        if (rel.indexOf('//') === 0) return m[1] + rel;
        var origin = m[1] + '//' + m[2];
        if (rel.charAt(0) === '/') return origin + rel;
        var dir = m[3].replace(/[^\/]*$/, '') || '/';
        var parts = (dir + rel).split('/'), out = [];
        TV.each(parts, function (p, i) {
            if (p === '..') { if (out.length > 1) out.pop(); }
            else if (p !== '.' || i === parts.length - 1) out.push(p === '.' ? '' : p);
        });
        return origin + out.join('/');
    }
    P.resolveUrl = resolveUrl;
    function firstChild(text) {
        var lines = String(text).split('\n');
        for (var i = 0; i < lines.length; i++) { var x = lines[i].trim(); if (x && x.charAt(0) !== '#') return x; }
        return '';
    }
    P.firstChild = firstChild;
    // 清单有没有真能播的分片:媒体清单看 #EXTINF;主清单跟进第一条子清单(5s);网络 / CORS 抖动不冤枉
    function hasFragments(text, baseUrl) {
        try {
            if (!/#EXTM3U/.test(text)) return Promise.resolve(false);
            if (/#EXTINF/.test(text)) return Promise.resolve(true);
            if (!/#EXT-X-STREAM-INF/i.test(text)) return Promise.resolve(false);
            var line = firstChild(text);
            if (!line) return Promise.resolve(false);
            return TV.http(resolveUrl(line, baseUrl), { raw: true, noAuth: true, timeout: 5000 }).then(function (t) {
                return /#EXTINF/.test(String(t));
            }, function (e) { return e && e.status >= 400 ? false : true; });
        } catch (e) { return Promise.resolve(true); }
    }
    P.hasFragments = hasFragments;
    function healthGet(siteKey) {
        if (!siteKey) return null;
        var m = lsJSON('donggua_site_health2', {}) || {};
        var r = m[siteKey];
        if (r && typeof r.latency === 'number') {
            var ttl = r.latency >= 9000 ? 12 * 3600 * 1000 : r.testType === 'server' ? 6 * 3600 * 1000 : 3 * DAY;
            if (now() - (r.ts || 0) < ttl) {
                return { latency: r.latency, _testType: r.testType || null, _useProxy: !!r.useProxy, _proxyUrl: r.proxyUrl || null, _srvOnly: !!r.srvOnly || (r.testType === 'server' && r.latency < 9000) };
            }
        }
        return null;
    }
    // source 是网页版字段格式({ latency, _testType, _useProxy, _proxyUrl, _srvOnly })
    function healthSet(siteKey, source, allowDead, allowServer) {
        if (!siteKey || !source || typeof source.latency !== 'number') return;
        var tt = source._testType;
        var isGood = (tt === 'direct' || tt === 'proxy') && source.latency < 9000;
        var isDead = source.latency >= 9000;
        var isServer = tt === 'server' && source.latency < 9000;
        if (!isGood && !(isDead && allowDead) && !(isServer && allowServer)) return;
        var MAXTTL = 3 * DAY, t = now();
        var m = lsJSON('donggua_site_health2', {}) || {};
        m[siteKey] = { latency: source.latency, testType: tt || null, useProxy: !!source._useProxy, proxyUrl: source._proxyUrl || null, srvOnly: !!(isServer && source._srvOnly), ts: t };
        keysOf(m).forEach(function (k) { if (t - (m[k].ts || 0) > MAXTTL) delete m[k]; });
        lsSet('donggua_site_health2', m);
    }
    P.healthGet = healthGet;
    P.healthSet = healthSet;
    // "只有服务器能通"要在两部不同的剧上都出现才按站点缓存(一部剧的坏链接不连累全站)
    function siteServerConfirmed(siteKey, vodId) {
        var K = 'donggua_site_srv_pending', t = now(), TTL = 6 * 3600 * 1000;
        var m = lsJSON(K, {}) || {};
        var p = m[siteKey];
        var ok = !!(p && String(p.vod) !== String(vodId) && t - (p.ts || 0) < TTL);
        if (ok) delete m[siteKey]; else m[siteKey] = { vod: String(vodId), ts: t };
        keysOf(m).forEach(function (k) { if (t - (m[k].ts || 0) > TTL) delete m[k]; });
        lsSet(K, m);
        return ok;
    }
    function asSource(l) { return { latency: l.latency, _testType: l.test || null, _useProxy: !!l.useProxy, _proxyUrl: l.proxyUrl || null, _srvOnly: !!l.srvOnly }; }
    function applyServerCheck(l, d) {
        d = d || {};
        var num = typeof d.latency === 'number';
        l.latency = num ? d.latency : 9999;
        l.test = 'server';
        if (d.transient || !num) l._timedOut = true;
    }
    // 拿一次清单,算延迟:只算到拿到正文;主清单子清单校验 <1s 不计入,慢了整段计入
    function probeOne(l, url, ms) {
        var t0 = now();
        return TV.http(url, { raw: true, noAuth: true, timeout: ms }).then(function (txt) {
            var tBody = now() - t0;
            var r = masterRes(txt);
            if (r) setRes(l, r.w, r.h, 'm3u8');
            return hasFragments(txt, url).then(function (ok) {
                var all = now() - t0;
                return { ok: ok, latency: (all - tBody < 1000) ? tBody : all };
            });
        });
    }
    // 移植 _clientProbe:直连 →(失败或 >1.5s)代理,代理要快 30% 才用;返回 true = 用户端测通
    function clientProbe(l, videoUrl) {
        var SLOW = 1500, directOK = false, directLat = 0, proxy = api.proxy();
        return probeOne(l, videoUrl, 5000).then(function (r) {
            if (r.ok) { directOK = true; directLat = r.latency; l.latency = directLat; }
            else l._noServerCache = true;
        }, function (e) {
            if (e && e.timeout) l._clientTimeout = true;
        }).then(function () {
            if (!((!directOK || directLat > SLOW) && proxy)) return;
            var pu = proxy + '/?url=' + enc(videoUrl);
            return probeOne(l, pu, directOK ? Math.max(1000, directLat) : 6000).then(function (r) {
                if (!r.ok) { if (!directOK) l._noServerCache = true; return; }
                if (!directOK || r.latency < directLat * 0.7) {
                    l.latency = r.latency; l.useProxy = true; l.proxyUrl = proxy; directOK = true;
                }
            }, function (e) {
                if (!directOK && e && (e.timeout || e.status >= 500)) l._clientTimeout = true;
            });
        }).then(function () {
            if (directOK) l.test = l.useProxy ? 'proxy' : 'direct';
            return directOK;
        });
    }
    // Kazumi 线路:解析一次(20s),年份和其它线路的多数年份对不上 → 排最后、不自动选
    function kzProbe(l, work, videoUrl) {
        l.test = 'kz';
        l.kzMismatch = false;
        try {
            var yr = parseInt(l.year, 10);
            var ys = work.lines.filter(function (x) { return !x.kz; }).map(function (x) { return parseInt(x.year, 10); }).filter(function (y) { return y > 1900; });
            if (yr > 1900 && ys.length) {
                var cnt = {}; ys.forEach(function (y) { cnt[y] = (cnt[y] || 0) + 1; });
                var major = +ssort(keysOf(cnt), function (a, b) { return cnt[b] - cnt[a]; })[0];
                var clear = ys.length === 1 || cnt[major] >= 2 || cnt[major] / ys.length >= 0.6;
                if (yr !== major && clear) l.kzMismatch = true;
            }
        } catch (e) { }
        var t0 = now();
        return TV.http(videoUrl, { timeout: 20000 }).then(function (j) {
            l.latency = (j && j.url) ? Math.max(600, now() - t0) : 9999;
        }, function () { l.latency = 9999; }).then(function () {
            if (l.kzMismatch && l.latency < 9000) l.latency = 8999;
        });
    }
    function detailOf(l) {
        return TV.http('/api/detail?site_key=' + enc(l.key) + '&id=' + enc(l.vodId), { timeout: 8000 }).then(function (d) {
            var v = d && d.list && d.list[0];
            if (v && v.vod_play_url) { l.playUrl = String(v.vod_play_url); l.eps = parseEps(l.playUrl); if (v.vod_year && !l.year) l.year = String(v.vod_year); }
            return v || null;
        });
    }
    function serverCheck(l) {
        return TV.http('/api/check?key=' + enc(l.key), { timeout: 6000 }).then(function (d) { applyServerCheck(l, d); }, function (e) {
            if (e && e.data && typeof e.data === 'object') applyServerCheck(l, e.data);
            else { l.latency = 9999; l._timedOut = true; }
        });
    }
    // 移植 latencyWorker
    function testOne(l, work) {
        l._clientTimeout = l._noServerCache = l._noDeadCache = l._timedOut = false;
        l.srvOnly = false; l.useProxy = false; l.proxyUrl = ''; l.test = '';
        var p = (l.playUrl && !l.kz) ? Promise.resolve({ vod_play_url: l.playUrl }) : detailOf(l);
        return p.then(function (detail) {
            if (!detail) { l.latency = 9999; l._noDeadCache = true; return; }
            var road = pickRoad(detail.vod_play_url || '');
            var firstEp = road.split('#')[0];
            var parts = firstEp.split('$');
            var videoUrl = parts.length > 1 ? parts[1] : parts[0];
            if (isKzUrl(videoUrl)) return kzProbe(l, work, videoUrl);
            if (!videoUrl || videoUrl.indexOf('http') !== 0) { l.latency = 9999; l._noDeadCache = true; return; }
            var pageHttps = false;
            try { pageHttps = location.protocol === 'https:'; } catch (e) { }
            // https 页面上的 http 片源:浏览器(App)直接拦,只能问服务器 → 归"可能无法播放"
            if (pageHttps && videoUrl.indexOf('http:') === 0) { l.srvOnly = true; return serverCheck(l); }
            return clientProbe(l, videoUrl).then(function (ok) {
                if (ok) return;
                l.srvOnly = true;
                return serverCheck(l);
            });
        }, function (e) {
            // 详情没拉到:问一次服务器测速(秒回);也失败才 9999,且不写死亡缓存
            l._timedOut = true;
            return serverCheck(l);
        });
    }
    // 测一部作品的全部线路:先套缓存(和网页版共用 donggua_site_health2),没命中的 3 个一批测(无广告的先测)。
    //   onUpdate(line | null, done):每条有结果回调一次;最后 onUpdate(null, true)。返回 { cancel(), done: Promise }
    api.testLines = function (work, onUpdate) {
        var dead = false, lines = (work && work.lines) || [];
        function cb(l, fin) { if (!dead && onUpdate) { try { onUpdate(l, !!fin); } catch (e) { log('onUpdate', e); } } }
        var misses = [];
        var order = ssort(lines.slice(), function (a, b) { return (tierRank(a) - tierRank(b)) || ((profileOf(a).geo ? 1 : 0) - (profileOf(b).geo ? 1 : 0)); });
        TV.each(order, function (l) {
            var c = l.kz ? null : healthGet(l.key);
            if (!c) { misses.push(l); return; }
            l.latency = c.latency; l.test = c._testType || ''; l.srvOnly = !!c._srvOnly; l.useProxy = !!c._useProxy; l.proxyUrl = c._proxyUrl || '';
            applyMeta(l);
        });
        if (misses.length < lines.length) cb(null, false);
        var done = pool(misses, 3, function (l) {
            if (dead) return null;
            return testOne(l, work).then(null, function () { l.latency = 9999; l._timedOut = true; }).then(function () {
                if (dead) return;
                if (!l.kz) {
                    var srvOK = !!l.srvOnly && !l._timedOut && !l._clientTimeout && !l._noServerCache && l.test === 'server' && l.latency < 9000 && siteServerConfirmed(l.key, l.vodId);
                    healthSet(l.key, asSource(l), !l._timedOut && !l._noDeadCache, srvOK);
                }
                applyMeta(l);
                cb(l, false);
            });
        }).then(function () {
            if (dead) return;
            if (work && work.group) work.group.sourcesTestedAt = now();
            cb(null, true);
        });
        return { cancel: function () { dead = true; }, done: done };
    };

    // ---------- 进度 / 观看历史(与 index.html 完全同格式) ----------
    function normEpName(name) {
        if (!name) return '正片';
        var n = String(name).replace(/第0*(\d+)集/g, '第$1集');
        n = n.replace(/^0+(\d)/, '$1');
        return n || '正片';
    }
    // 移植 getProgressKey:单集(电影)只用片名;剧集 = 片名 + 归一化集名
    function progressKey(name, epName, single) {
        var vodName = name || 'unknown';
        if (single) return ('donggua_progress_' + vodName).replace(/[^a-zA-Z0-9一-龥]/g, '_').substring(0, 80);
        var combined = (vodName + '_' + normEpName(epName)).replace(/[^a-zA-Z0-9一-龥]/g, '_');
        return 'donggua_progress_' + combined.substring(0, 80);
    }
    P.normEpName = normEpName;
    P.progressKey = progressKey;
    api.progressKey = progressKey;
    function lineEpCount(work) {
        if (!work || !work.lines || !work.lines.length) return 0;
        var l = work.lines[work._lastLine || 0] || work.lines[0];
        return (l.eps && l.eps.length) || 0;
    }
    // 续播位置(秒;0 = 从头):30 天内、看过 1 分钟以上、离结尾 2 分钟以上(时长已知时)
    api.getResume = function (work, epName, single, dur) {
        if (!work) return 0;
        if (typeof single !== 'boolean') { var n = lineEpCount(work); single = n ? n === 1 : !epName; }
        var v = lsJSON(progressKey(work.title, epName, single), null);
        if (!v || typeof v !== 'object') return 0;
        var t = Number(v.time), days = (now() - new Date(v.date).getTime()) / DAY;
        if (!(days < 30) || !(t > 60)) return 0;
        if (dur > 0 && isFinite(dur) && !(t < dur - 120)) return 0;
        return t;
    };

    var H = { list: null, pushT: 0, lastPush: 0, pushing: null };
    function histLoad() {
        if (H.list) return H.list;
        var arr = lsJSON('donggua_watch_history', null);
        if (!isArr(arr)) { H.list = []; return H.list; }
        var cut = now() - 30 * DAY;
        var list = arr.filter(function (it) { return it && new Date(it.watchedAt).getTime() > cut; });
        if (list.length > 30) list = list.slice(0, 30);
        H.list = list;
        if (list.length !== arr.length) histStore(true);
        return list;
    }
    // 存本地(配额满了分级精简,同网页版),同步用户随后增量推送
    function histStore(noPush) {
        var list = H.list || [];
        function put(v) { localStorage.setItem('donggua_watch_history', JSON.stringify(v)); }
        try { put(list); }
        catch (e) {
            try {
                put(list.map(function (item, idx) {
                    if (idx < 8 || !item.groupData) return item;
                    return assign({}, item, { groupData: assign({}, item.groupData, { sources: (item.groupData.sources || []).map(function (s) { return assign({}, s, { vod_play_url: '', vod_content: '' }); }) }) });
                }));
            } catch (e2) { try { put(list.slice(0, 15)); } catch (e3) { } }
        }
        if (!noPush) schedulePush(false);
    }
    function tombLoad() { var t = lsJSON('donggua_history_deleted', {}); return (t && typeof t === 'object') ? t : {}; }
    function tombSave(t) { lsSet('donggua_history_deleted', t); }
    function isTombstoned(tomb, item) { var d = tomb[item && item.name]; return d != null && d >= new Date(item.watchedAt || 0).getTime(); }
    // 线路快照(和网页版 addToWatchHistory 存的 groupData.sources 同格式)
    function groupDataOf(work) {
        var g = work.group || {};
        return {
            name: work.title, pic: g.pic || work.poster || '', _work: g._work || '', _workSig: work.sig || g._workSig || '', _workLabel: work.label || g._workLabel || '',
            sourcesTestedAt: g.sourcesTestedAt || null,
            sources: work.lines.map(function (l, idx) {
                var s = l.raw || {};
                return {
                    vod_id: l.vodId, vod_name: s.vod_name || work.title, vod_pic: s.vod_pic, vod_play_url: l.playUrl || '', vod_content: s.vod_content || '',
                    site_name: l.name, site_key: l.key || (l.name + '_' + idx), type_name: s.type_name || '', vod_year: s.vod_year || l.year || '',
                    latency: (typeof l.latency === 'number' && l.latency) || 500, _testType: l.test || null, _srvOnly: !!l.srvOnly,
                    _useProxy: !!l.useProxy, _proxyUrl: l.proxyUrl || null
                };
            })
        };
    }
    // 移植 addToWatchHistory(去掉网页版的试看 / 离线上下文 / 搜索结果补线路)
    function addHist(name, poster, episode, progress, duration, groupData, srcKey) {
        if (name) { var t = tombLoad(); if (t[name] != null) { delete t[name]; tombSave(t); } }
        var list = histLoad();
        var ex = findIdx(list, function (it) { return it.name === name; });
        var item = {
            name: name, poster: poster || '', episode: episode || null,
            progress: duration > 0 ? Math.min(Math.round((progress / duration) * 100), 100) : 0,
            progressTime: Math.round(progress) || 0, progressDuration: Math.round(duration) || 0,
            watchedAt: new Date().toISOString(), lastSourceKey: srcKey || null,
            groupData: groupData || null
        };
        if (ex !== -1) list.splice(ex, 1);
        list.unshift(item);
        if (list.length > 50) list.length = 50;
        histStore(false);
        return item;
    }
    // 移植 saveProgress:离结尾 2 分钟内 = 看完(清进度,历史记 100%);1 分钟以内不记
    api.saveProgress = function (work, lineIdx, epIdx, t, dur) {
        if (!work || !work.title || !work.lines) return;
        var line = work.lines[lineIdx] || work.lines[0];
        if (!line) return;
        var eps = line.eps || [], ep = eps[epIdx];
        var duration = (isFinite(dur) && dur > 0) ? dur : 0;
        t = +t || 0;
        var epName = (ep && eps.length > 1) ? ep.name : null;
        var key = progressKey(work.title, ep && ep.name, eps.length === 1);
        work._lastLine = lineIdx;
        if (duration > 0 && t > duration - 120) {
            lsDel(key);
            addHist(work.title, work.poster, epName, duration, duration, groupDataOf(work), line.key);
        } else if (t > 60) {
            lsSet(key, { time: Math.floor(t), date: new Date().toISOString() });
            addHist(work.title, work.poster, epName, t, duration, groupDataOf(work), line.key);
        } else return;
        fire('tv:hist', { local: true });
    };
    api.markWatching = function (work, lineIdx, epIdx) { if (work) { work._lastLine = lineIdx; work._lastEp = epIdx; } };
    function histOf(work) {
        var name = work && (work.title || work.name);
        if (!name) return null;
        var sig = work.sig || '';
        return find(histLoad(), function (x) { return x && x.name === name && (!sig || !x.groupData || !x.groupData._workSig || x.groupData._workSig === sig); }) || null;
    }
    api.lastWatch = function (work) {
        var h = histOf(work);
        return h ? { lineKey: h.lastSourceKey || '', epName: h.episode || '', time: h.progressTime || 0, progress: h.progress || 0 } : null;
    };
    api.historyItems = function () { return histLoad().slice(); };
    api.historyCards = function (n) {
        return histLoad().slice(0, n || 30).map(function (it) {
            var ep = str(it.episode);
            var sub = ep ? '看到 ' + (/^\d{1,4}$/.test(ep) ? '第' + parseInt(ep, 10) + '集' : ep) : (it.progressTime > 0 ? '看到 ' + TV.fmtTime(it.progressTime) : '');
            return { title: it.name, poster: api.img(it.poster || (it.groupData && it.groupData.pic)), progress: (it.progress || 0) / 100, sub: sub, kind: 'hist', hist: it, key: it.name };
        });
    };
    api.removeHistory = function (name) {
        var list = histLoad();
        var i = findIdx(list, function (it) { return it.name === name; });
        if (i < 0) return;
        list.splice(i, 1);
        var t = tombLoad(); t[name] = now(); tombSave(t);
        histStore(true);
        schedulePush(true);
        fire('tv:hist', { local: true });
    };
    // 清过期进度(30 天,格式不对也清;同网页版 cleanUpOldProgress)
    function cleanUpOldProgress() {
        var cut = now() - 30 * DAY;
        TV.each(lsKeys('donggua_progress_'), function (k) {
            var v = lsJSON(k, null);
            if (!v || !v.date || new Date(v.date).getTime() < cut) lsDel(k);
        });
    }

    // 同步瘦身(与 lib/history-slim、index.html _slimHistoryItem 同规则)
    function slimHistoryItem(d) {
        if (!d || typeof d !== 'object') return d;
        var out = assign({}, d);
        var g = d.groupData;
        if (g && typeof g === 'object' && isArr(g.sources)) {
            var srcs = g.sources.slice(0, 40);
            var keep = findIdx(srcs, function (s) { return s && s.site_key && s.site_key === d.lastSourceKey && s.vod_play_url; });
            if (keep < 0) keep = findIdx(srcs, function (s) { return s && s.vod_play_url; });
            var slimSource = function (s, keepPlayUrl) {
                if (!s || typeof s !== 'object') return null;
                var o = { vod_id: s.vod_id, vod_name: s.vod_name, site_name: s.site_name, site_key: s.site_key };
                if (s.type_name) o.type_name = s.type_name;
                if (s.vod_year) o.vod_year = s.vod_year;
                if (keepPlayUrl && s.vod_play_url) o.vod_play_url = String(s.vod_play_url).slice(0, 60000);
                return o;
            };
            out.groupData = {
                name: g.name, pic: g.pic, _work: g._work || '', _workSig: g._workSig || '', _workLabel: g._workLabel || '',
                sources: srcs.map(function (s, i) { return slimSource(s, i === keep); }).filter(Boolean)
            };
        }
        return out;
    }
    P.slimHistoryItem = slimHistoryItem;
    function syncLoad() {
        var t = token().slice(0, 16);
        var s = lsJSON('donggua_hist_synced', null);
        if (s && s.t === t && s.items && s.tombs) return s;
        return { t: t, items: {}, tombs: {} };
    }
    function syncSave(s) { lsSet('donggua_hist_synced', s); }
    function histPending() {
        var st = syncLoad();
        var items = histLoad().filter(function (it) { return it && it.name && st.items[it.name] !== it.watchedAt; });
        var tomb = tombLoad();
        var tombs = keysOf(tomb).filter(function (id) { return st.tombs[id] !== tomb[id]; }).map(function (id) { return { id: id, deleted_at: tomb[id] }; });
        return { items: items, tombs: tombs };
    }
    P.histPending = histPending;
    // 增量推送(只推和"服务器已确认"不一样的)
    function doPush() {
        if (!isSync()) return Promise.resolve();
        if (H.pushing) return H.pushing;
        H.lastPush = now();
        var pend = histPending();
        if (!pend.items.length && !pend.tombs.length) return Promise.resolve();
        var sent = pend.items.map(function (it) { return [it.name, it.watchedAt]; });
        var body = {
            token: token(),
            history: pend.items.map(function (it) { return { id: it.name, data: slimHistoryItem(it), updated_at: new Date(it.watchedAt).getTime() }; }),
            deleted: pend.tombs, label: lsRaw(K_EMAIL) || ''
        };
        H.pushing = postJ('/api/history/push', body, 20000).then(function (j) {
            if (!j || j.sync_enabled === false || j.message) return;
            var st = syncLoad();
            TV.each(sent, function (x) { st.items[x[0]] = x[1]; });
            TV.each(pend.tombs, function (t) { st.tombs[t.id] = t.deleted_at; });
            var names = {};
            TV.each(histLoad(), function (it) { if (it && it.name) names['$' + it.name] = 1; });
            keysOf(st.items).forEach(function (k) { if (!names['$' + k]) delete st.items[k]; });
            var tombNow = tombLoad();
            keysOf(st.tombs).forEach(function (k) { if (tombNow[k] == null) delete st.tombs[k]; });
            syncSave(st);
        }, function () { }).then(function () { H.pushing = null; });
        return H.pushing;
    }
    // 1 分钟最多推一次(同网页版);immediate = 删除 / 退出播放
    function schedulePush(immediate) {
        if (!isSync()) return;
        var t = now();
        if (!immediate && t - H.lastPush < 60000) {
            if (!H.pushT) H.pushT = setTimeout(function () { H.pushT = 0; doPush(); }, 60000 - (t - H.lastPush));
            return;
        }
        clearTimeout(H.pushT); H.pushT = 0;
        doPush();
    }
    api.flushHistory = function () { if (!isSync()) return Promise.resolve(); clearTimeout(H.pushT); H.pushT = 0; return doPush(); };
    // 关页面 / 切后台:sendBeacon 推一次(最多 60KB,不记确认,下次打开再推,服务器同版本跳过)
    function pushBeacon() {
        if (!isSync() || !navigator.sendBeacon) return;
        try {
            var pend = histPending();
            if (!pend.items.length && !pend.tombs.length) return;
            var base = { token: token(), history: [], deleted: pend.tombs, label: lsRaw(K_EMAIL) || '' };
            var size = JSON.stringify(base).length;
            ssort(pend.items.slice(), function (a, b) { return new Date(b.watchedAt || 0).getTime() - new Date(a.watchedAt || 0).getTime(); }).forEach(function (item) {
                var entry = { id: item.name, data: slimHistoryItem(item), updated_at: new Date(item.watchedAt).getTime() };
                var add = JSON.stringify(entry).length + 1;
                if (size + add > 60000) return;
                base.history.push(entry); size += add;
            });
            if (!base.history.length && !pend.tombs.length) return;
            navigator.sendBeacon('/api/history/push', new Blob([JSON.stringify(base)], { type: 'application/json' }));
        } catch (e) { }
    }
    try {
        TV.on(window, 'pagehide', pushBeacon);
        TV.on(document, 'visibilitychange', function () { if (document.hidden) pushBeacon(); });
    } catch (e) { }

    // 拉取合并(移植 pullAndMergeHistory):逐条 watchedAt 新的胜,墓碑压制,改写进度键;再推本地更新的
    function mergeHistory(local, serverRows, deleted, tomb, t) {
        TV.each(deleted || [], function (d) { if (d && d.id && !(tomb[d.id] >= d.deleted_at)) tomb[d.id] = d.deleted_at; });
        var cutoff = t - 120 * DAY;
        keysOf(tomb).forEach(function (k) { if (tomb[k] < cutoff) delete tomb[k]; });
        var byName = new Map();
        function consider(d, preferThis) {
            if (!d || !d.name || isTombstoned(tomb, d)) return;
            var ex = byName.get(d.name);
            var a = new Date(d.watchedAt || 0).getTime(), b = ex ? new Date(ex.watchedAt || 0).getTime() : -1;
            if (!ex || a > b || (preferThis && a === b)) byName.set(d.name, d);
        }
        TV.each(serverRows || [], function (s) { consider(s && s.data, false); });
        TV.each(local || [], function (d) { consider(d, true); });
        var out = [];
        byName.forEach(function (v) { out.push(v); });
        out = ssort(out, function (a, b) { return new Date(b.watchedAt || 0).getTime() - new Date(a.watchedAt || 0).getTime(); });
        if (out.length > 50) out.length = 50;
        return { list: out, tomb: tomb };
    }
    P.mergeHistory = mergeHistory;
    var pulling = null;
    api.pullHistory = function () {
        if (!isSync()) return Promise.resolve(false);
        if (pulling) return pulling;
        pulling = getJ('/api/history/pull?token=' + enc(token()), 15000).then(function (data) {
            if (!data || !data.sync_enabled || !data.history) return false;
            var serverHistory = data.history;
            var local = histLoad();
            var m = mergeHistory(local, serverHistory, data.deleted, tombLoad(), now());
            tombSave(m.tomb);
            var st = syncLoad();
            TV.each(serverHistory, function (s) { if (s && s.data && s.data.name) st.items[s.data.name] = s.data.watchedAt; });
            TV.each(data.deleted || [], function (d) { if (d && d.id) st.tombs[d.id] = d.deleted_at; });
            syncSave(st);
            var changed = JSON.stringify(local) !== JSON.stringify(m.list);
            if (changed) {
                H.list = m.list;
                lsSet('donggua_watch_history', JSON.stringify(m.list));
                TV.each(m.list, function (item) {
                    if (item.progressTime && item.progressTime > 60) {
                        var name = (item.groupData && item.groupData.name) || item.name;
                        lsSet(progressKey(name, item.episode, !item.episode), { time: item.progressTime, date: item.watchedAt });
                    }
                });
                fire('tv:hist', { remote: true });
            }
            return changed;
        }).then(function (changed) {
            return doPush().then(function () { return changed; });
        }, function () { return false; }).then(function (c) { pulling = null; return c; });
        return pulling;
    };

    // ---------- 收藏(移植 _favBuildItem / _favFind / 本机收藏;同步用户读写服务器) ----------
    var F = { list: null, limit: 100, busy: false };
    function favIdOf(name, workSig) { var n = String(name || '').trim(); return workSig ? n + '|w:' + workSig : n; }
    function favWorkSig(g) { return (g && g._workLabel && g._workSig) ? String(g._workSig) : ''; }
    P.favIdOf = favIdOf;
    function favEnabled() { return cfg.favorites_enabled !== false; }
    api.favEnabled = favEnabled;
    function favCacheLoad() {
        var c = lsJSON('donggua_fav_cache', null), t = token().slice(0, 16);
        return (c && t && c.t === t && isArr(c.items)) ? c.items : null;
    }
    function favCacheSave(items) { lsSet('donggua_fav_cache', { t: token().slice(0, 16), items: items || [] }); }
    function favLocalLoad() {
        var a = lsJSON('donggua_favorites', []);
        return isArr(a) ? a.filter(function (x) { return x && x.fav_id && x.data; }).slice(0, F.limit) : [];
    }
    function favLocalSave(list) { lsSet('donggua_favorites', list || []); }
    // v2board 账号一定是同步账号:服务器还没确认(重启后令牌没登记 / 断网)时只显示缓存,♥ 不写本机列表(同网页版 _favBoot(true))
    function favDisplayOnly() { return !!(token() && isV2b() && !isSync()); }
    function favList() {
        if (F.list) return F.list;
        if (isSync()) return (F.list = favCacheLoad() || []);
        if (favDisplayOnly()) return favCacheLoad() || [];
        // 配置还没回来:本账号的服务器缓存优先;v2board 账号一定是同步账号,不拿本机列表充数
        if (!inited || !cfg.hasOwnProperty('sync_enabled')) return favCacheLoad() || (isV2b() ? [] : favLocalLoad());
        return (F.list = favLocalLoad());
    }
    function favEpCountOf(playUrl) {
        var pu = pickRoad(playUrl);
        return pu ? pu.split('#').filter(function (x) { return x && x.trim(); }).length : 0;
    }
    // 收藏条目:检查线路 = 正在用的(kz 查不了更新 → 第一条 maccms),最多带 10 条线路
    function favBuildItem(work, cur) {
        function okSrc(l) { return !!(l && l.key && l.vodId != null && String(l.vodId) !== '' && !l.kz); }
        function slim(l) { return { site_key: String(l.key), vod_id: String(l.vodId), site_name: String(l.name || '') }; }
        var all = work.lines || [];
        var check = okSrc(cur) ? cur : (find(all, okSrc) || null);
        var sources = [], seen = {};
        TV.each([check].concat(all), function (l) {
            if (sources.length >= 10 || !okSrc(l) || seen['$' + l.key]) return;
            seen['$' + l.key] = 1; sources.push(slim(l));
        });
        var n = check ? (favEpCountOf(check.playUrl) || (check === cur ? ((cur.eps && cur.eps.length) || 0) : 0)) : 0;
        var g = { _workSig: work.sig, _workLabel: work.label };
        var workSig = favWorkSig(g);
        return {
            name: String(work.title || '').trim(), poster: String(work.poster || (work.group && work.group.pic) || '').slice(0, 500),
            workSig: workSig, workLabel: workSig ? String(work.label || '') : '',
            checkSource: check ? slim(check) : null, sources: sources, addedEpCount: n, kind: 'vod'
        };
    }
    P.favBuildItem = favBuildItem;
    function favFind(work) {
        var list = favList();
        if (!work || !work.title || !list.length) return null;
        var id = favIdOf(work.title, favWorkSig({ _workSig: work.sig, _workLabel: work.label }));
        var hit = find(list, function (x) { return x && x.fav_id === id; });
        if (hit) return hit;
        var same = list.filter(function (x) { return x && x.data && x.data.name === work.title && x.data.checkSource; });
        return find(same, function (x) {
            var c = x.data.checkSource;
            return (work.lines || []).some(function (l) { return l.key === c.site_key && String(l.vodId) === String(c.vod_id); });
        }) || null;
    }
    function favHasUpdate(item) {
        if (item && typeof item.has_update === 'boolean') return item.has_update;
        var st = item && item.status;
        return !!(st && (st.ep_count | 0) > (item.seen_count | 0));
    }
    function favSub(item) {
        var st = item && item.status, d = (item && item.data) || {};
        var r = st ? String(st.remarks || '').trim() : '';
        if (r) return r.length > 14 ? r.slice(0, 14) + '…' : r;
        if (st && st.finished) return '已完结';
        if (d.workLabel) return d.workLabel;
        return (st && st.ep_count) ? '共 ' + st.ep_count + ' 集' : '';
    }
    api.isFav = function (work) { return !!favFind(work); };
    // 点追剧卡(同网页版 openFavorite):看过就和继续观看一样(上次的线路 / 集);没看过回 null,调用方按片名搜
    api.workFromFav = function (fav) {
        var d = (fav && fav.data) || {};
        var name = d.name || (fav && fav.fav_id) || '';
        if (!name) return null;
        var h = find(histLoad(), function (x) { return x && x.name === name && (!d.workSig || !x.groupData || !x.groupData._workSig || x.groupData._workSig === d.workSig); });
        return h && h.groupData && h.groupData.sources && h.groupData.sources.length ? api.workFromHistory(h) : null;
    };
    api.favoriteCards = function (n) {
        return favList().slice(0, n || 100).map(function (x) {
            var d = x.data || {};
            return { title: d.name || x.fav_id, poster: api.img(d.poster), flag: favHasUpdate(x) ? '更新' : '', sub: favSub(x), kind: 'fav', fav: x, key: x.fav_id };
        });
    };
    function favChanged(prev, next) {
        F.list = next;
        if (JSON.stringify(prev || []) !== JSON.stringify(next || [])) fire('tv:favs');
    }
    // 同时只拉一次(启动时自动同步和 app.js 都会叫)
    api.refreshFavorites = function () {
        if (F.refreshing) return F.refreshing;
        F.refreshing = refreshFavs().then(function () { F.refreshing = null; }, function () { F.refreshing = null; });
        return F.refreshing;
    };
    function refreshFavs() {
        if (!favEnabled()) return Promise.resolve();
        var prev = favList();
        if (isSync()) {
            return getJ('/api/favorites?token=' + enc(token()), 10000).then(function (d) {
                if (d && d.enabled === false) { cfg.favorites_enabled = false; favChanged(prev, []); return; }
                if (!d || !isArr(d.items)) return;
                if (d.limit > 0) F.limit = d.limit;
                var items = d.items.filter(function (x) { return x && x.fav_id && x.data; });
                favCacheSave(items);
                favChanged(prev, items);
            }, function () { });
        }
        if (favDisplayOnly()) return Promise.resolve();
        // 本机收藏:问服务器这些线路的最新集数(登录 token 带上,有密码的站只认登录的)
        var q = [], seen = {};
        TV.each(favLocalLoad(), function (x) {
            var c = x.data && x.data.checkSource;
            var k = c && c.site_key && c.vod_id ? c.site_key + '|' + c.vod_id : '';
            if (k && !seen['$' + k]) { seen['$' + k] = 1; q.push({ site_key: String(c.site_key), vod_id: String(c.vod_id) }); }
        });
        if (!q.length) { favChanged(prev, favLocalLoad()); return Promise.resolve(); }
        return postJ('/api/favorites/status', { token: token(), items: q.slice(0, 100) }, 10000).then(function (d) {
            if (!d || !d.status || typeof d.status !== 'object') return;
            var map = d.status;
            var list = favLocalLoad().map(function (x) {
                var c = x && x.data && x.data.checkSource;
                var k = c ? c.site_key + '|' + c.vod_id : '';
                var st = (k && hasOwn(map, k)) ? map[k] : null;
                if (!st || typeof st !== 'object') return x;
                var y = assign({}, x, { status: st });
                if (!((y.seen_count | 0) > 0)) y.seen_count = st.ep_count | 0;
                return y;
            });
            favLocalSave(list);
            favChanged(prev, list);
        }, function () { });
    };
    // ♥:→ Promise<true 已收藏 / false 已取消>;失败 reject(Error(给用户看的话))
    api.toggleFav = function (work) {
        if (!work || !work.title) return Promise.reject(new Error('没有片名'));
        if (!favEnabled()) return Promise.reject(new Error('本站没有开启收藏'));
        if (F.busy) return Promise.reject(new Error('请稍等'));
        if (favDisplayOnly()) { syncBoot(true); return Promise.reject(new Error('网络异常，稍后再试')); }
        var prev = favList(), cur = favFind(work);
        F.busy = true;
        function end(v) { F.busy = false; return v; }
        function fail(e) { F.busy = false; throw e; }
        if (cur) {
            var id = cur.fav_id, next = prev.filter(function (x) { return x.fav_id !== id; });
            if (isSync()) {
                return postJ('/api/favorites/remove', { token: token(), fav_id: id }, 10000).then(function (d) {
                    if (d && d.ok === false) throw new Error('取消收藏失败，请稍后再试');
                    favCacheSave(next); favChanged(prev, next);
                    return end(false);
                }, function () { throw new Error('取消收藏失败，请稍后再试'); }).then(null, fail);
            }
            favLocalSave(favLocalLoad().filter(function (x) { return x.fav_id !== id; }));
            favChanged(prev, favLocalLoad());
            return Promise.resolve(end(false));
        }
        if (prev.length >= F.limit) { F.busy = false; return Promise.reject(new Error('收藏已满 ' + F.limit + ' 部，请先删掉一些')); }
        var data = favBuildItem(work, work.lines[work._lastLine || 0]);
        if (!data.name) { F.busy = false; return Promise.reject(new Error('没有片名')); }
        var entry = { fav_id: favIdOf(data.name, data.workSig), data: data, added_at: now(), seen_count: data.addedEpCount || 0, status: null };
        if (isSync()) {
            return postJ('/api/favorites/add', { token: token(), item: data }, 10000).then(function (d) {
                if (d && d.error === 'limit') { if (d.limit > 0) F.limit = d.limit; throw new Error('收藏已满 ' + F.limit + ' 部，请先删掉一些'); }
                if (!d || !d.ok) throw new Error('收藏失败，请稍后再试');
                if (d.fav_id) entry.fav_id = String(d.fav_id);
                var next = [entry].concat(prev.filter(function (x) { return x.fav_id !== entry.fav_id; }));
                favCacheSave(next); favChanged(prev, next);
                return end(true);
            }, function (e) {
                if (e && e.status === undefined) throw e;   // 上面自己抛的(收藏已满 / 失败),原样给出去
                throw new Error('收藏失败，请稍后再试');
            }).then(null, fail);
        }
        var cur2 = favLocalLoad();
        var i = findIdx(cur2, function (x) { return x.fav_id === entry.fav_id; });
        var list = i >= 0 ? cur2.map(function (x, j) { return j === i ? assign({}, x, { data: entry.data }) : x; }) : [entry].concat(cur2);
        favLocalSave(list);
        favChanged(prev, list);
        api.refreshFavorites();
        return Promise.resolve(end(true));
    };

    // ---------- 直播 ----------
    function liveShape(c) {
        var nsfw = api.nsfwOn();
        var chans = (c.channels || []).filter(function (ch) { return ch && !(ch.adult && nsfw); });
        var present = {};
        TV.each(chans, function (ch) { present['$' + ch.group] = 1; });
        var groups = (c.groups || []).filter(function (g) { return present['$' + g]; });
        return { enabled: true, groups: groups, channels: chans };
    }
    api.liveChannels = function () {
        if (cfg.live_enabled === false) return Promise.resolve({ enabled: false, groups: [], channels: [] });
        var CK = 'donggua_live_cache', TTL = 2 * 3600 * 1000;
        var c = lsJSON(CK, null);
        if (c && isArr(c.channels) && c.channels.length && now() - (c.at || 0) < TTL) return Promise.resolve(liveShape(c));
        return TV.http('/api/live/channels', { timeout: 15000 }).then(function (d) {
            if (d && d.enabled === false) return { enabled: false, groups: [], channels: [] };
            if (d && isArr(d.channels) && d.channels.length) {
                var v = { at: now(), channels: d.channels, groups: isArr(d.groups) ? d.groups : [], langs: isArr(d.langs) ? d.langs : [] };
                lsSet(CK, v);
                return liveShape(v);
            }
            if (c && isArr(c.channels)) return liveShape(c);
            return { enabled: true, groups: [], channels: [] };
        }, function (e) {
            if (c && isArr(c.channels)) return liveShape(c);
            throw e;
        });
    };
    api.liveRecent = function () { var a = lsJSON('donggua_live_recent', []); return isArr(a) ? a.slice(0, 12) : []; };
    api.addLiveRecent = function (ch) {
        if (!ch || !ch.id) return;
        var entry = { id: ch.id, name: ch.name, logo: ch.logo || '', group: ch.group || '', sources: (ch.sources || []).slice(0, 6), at: now() };
        var list = api.liveRecent().filter(function (c) { return c.id !== ch.id; });
        list.unshift(entry);
        list = list.slice(0, 12);
        lsSet('donggua_live_recent', list);
        if (isSync()) {
            var slim = list.map(function (c) { return { id: c.id, name: c.name, logo: c.logo, group: c.group, at: c.at }; });
            postJ('/api/settings/push', { token: token(), settings: { liveRecent: slim } }, 10000).then(null, function () { });
        }
    };
})();
