/* E视界 电视版 · 核心(工具 / 存储 / 请求 / 焦点 / 路由 / 弹层)
 *
 * 只写 ES5:老盒子(斐讯 T1 这类 Android 7 自带 WebView ≈ Chrome 52)读不懂 ?. ?? async 对象展开,
 * 一处读不懂整个文件都不跑。scripts/tv-compat-test.mjs 会把 public/tv/*.js 按 ES5 解析一遍,
 * 再扫一遍老内核没有的 API,改完必须跑。
 *
 * 屏幕(screen):TV.screen('名字', function (params, scr) { ... return { el, onShow, onHide, onKey, destroy } })
 *   TV.go(名字, 参数) 打开一层(会 pushState,遥控器返回键 = 浏览器后退 = 关掉这一层);TV.back() 关最上层。
 *   旧的层留在 DOM 里只是藏起来,返回时滚动位置和焦点原样还在。
 * 焦点:带 class="f" 的元素可以被遥控器选中;方向键按几何位置找最近的。
 *   容器加 data-fg="名字" 是一个"焦点组":从组外进来时回到组里上次停留的那个(比如从海报墙往上回到当前标签)。
 *   元素上 data-up / data-down / data-left / data-right = CSS 选择器,强行指定这个方向去哪;值为 "stop" 表示这个方向不动。
 *   选中(OK / 点击)时派发 'tvok' 事件,屏幕里用 TV.on(el, 'tvok', fn) 或在 onKey 里处理。
 */
(function () {
    'use strict';
    var TV = window.TV = window.TV || {};
    TV.ver = '1';

    // ---------- 小工具 ----------
    var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    TV.esc = function (s) { return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); };
    TV.$ = function (sel, root) { return (root || document).querySelector(sel); };
    TV.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
    TV.el = function (html) { var d = document.createElement('div'); d.innerHTML = String(html).replace(/^\s+/, ''); return d.firstChild; };
    TV.qs = function (o) {
        var a = [];
        for (var k in o) if (o.hasOwnProperty(k) && o[k] != null && o[k] !== '') a.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k]));
        return a.join('&');
    };
    TV.on = function (el, ev, fn) { el.addEventListener(ev, fn, false); return el; };
    TV.each = function (arr, fn) { for (var i = 0; i < (arr ? arr.length : 0); i++) fn(arr[i], i); };
    TV.assign = function (t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (s.hasOwnProperty(k)) t[k] = s[k]; } return t; };
    TV.now = function () { return new Date().getTime(); };
    // 手机 / iPad(没有遥控器,只能点):电视版在这类设备上要留一个「回手机版」的出口
    TV.isPhone = (function () {
        var ua = navigator.userAgent || '';
        return /iphone|ipod|ipad|android.*mobile|windows phone/i.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
    })();
    // 关闭 TV 模式 → 网页版(记住;手机顶栏的「手机版」和「我的」里的按钮共用)
    TV.leaveTV = function () {
        var back = TV.isPhone
            ? '换回手机网页版。想再打开:网页版右下角 ⚙️ 设置 →「TV 模式」。'
            : '换成网页版(要用触屏或鼠标操作)。想回来:网页版右下角 ⚙️ 设置 →「TV 模式」;用遥控器的话,在网页版按方向键也会提示换回电视版。';
        TV.confirm('关闭 TV 模式?', back, '关闭 TV 模式', function () { location.href = '/?tv=0'; });
    };
    // 这台设备能不能跑网页版(同 index.html 启动检测的试法)
    TV.canRunWeb = function () {
        try { new Function('var o={a:1},p={...o};return o?.a??p.a'); new Function('return async function(){await 0}'); new RegExp('a', 's'); return true; } catch (e) { return false; }
    };
    TV.pad2 = function (n) { n = Math.floor(n); return n < 10 ? '0' + n : '' + n; };
    TV.fmtTime = function (sec) {
        if (!(sec >= 0) || !isFinite(sec)) return '--:--';
        var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
        return (h ? h + ':' + TV.pad2(m) : m) + ':' + TV.pad2(s);
    };
    TV.debounce = function (fn, ms) {
        var t = 0;
        return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
    };
    TV.uid = (function () { var n = 0; return function (p) { n++; return (p || 'u') + n; }; })();

    // ---------- 存储(读写都包 try:隐私模式 / 被清空时照常能跑) ----------
    TV.store = {
        get: function (k, def) {
            try { var v = localStorage.getItem(k); if (v == null) return def; try { return JSON.parse(v); } catch (e) { return v; } }
            catch (e) { return def; }
        },
        raw: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set: function (k, v) { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) { } },
        del: function (k) { try { localStorage.removeItem(k); } catch (e) { } }
    };

    // ---------- 请求(XHR:老内核的 fetch 没有超时,也没有 AbortController) ----------
    // TV.http(url, { method, body, headers, timeout, raw }) → Promise(JSON 或文本)
    // 失败 reject 一个 Error,带 .status(0 = 网络错 / 超时)和 .data(服务器回的 JSON,有的话)
    TV.authHeaders = function () { return {}; };   // 由 auth.js 覆盖
    TV.http = function (url, opt) {
        opt = opt || {};
        return new Promise(function (resolve, reject) {
            var x = new XMLHttpRequest(), done = false;
            x.open(opt.method || (opt.body != null ? 'POST' : 'GET'), url, true);
            var h = TV.assign({}, opt.noAuth ? {} : TV.authHeaders(), opt.headers || {});
            var body = opt.body;
            if (body != null && typeof body !== 'string') { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
            for (var k in h) if (h.hasOwnProperty(k) && h[k] != null) x.setRequestHeader(k, h[k]);
            var timer = setTimeout(function () { if (done) return; done = true; try { x.abort(); } catch (e) { } var er = new Error('timeout'); er.status = 0; er.timeout = true; reject(er); }, opt.timeout || 20000);
            x.onreadystatechange = function () {
                if (x.readyState !== 4 || done) return;
                done = true; clearTimeout(timer);
                var txt = x.responseText, data = txt;
                if (!opt.raw) { try { data = JSON.parse(txt); } catch (e) { data = txt; } }
                if (x.status >= 200 && x.status < 300) resolve(data);
                else { var er = new Error('HTTP ' + x.status); er.status = x.status; er.data = data; reject(er); }
            };
            x.send(body == null ? null : body);
            if (opt.signal) opt.signal.onabort = function () { if (done) return; done = true; clearTimeout(timer); try { x.abort(); } catch (e) { } var er = new Error('aborted'); er.status = 0; er.aborted = true; reject(er); };
        });
    };
    // 可取消的请求句柄:var c = TV.cancelable(); TV.http(url, { signal: c }); c.abort();
    TV.cancelable = function () { var s = { onabort: null, aborted: false, abort: function () { if (s.aborted) return; s.aborted = true; if (s.onabort) s.onabort(); } }; return s; };

    // ---------- 按键 ----------
    // 各家遥控器 / 浏览器的键码 → 统一名字
    var KEYMAP = {
        37: 'left', 38: 'up', 39: 'right', 40: 'down',
        21: 'left', 19: 'up', 22: 'right', 20: 'down',          // 少数盒子直接透传 Android 键码
        13: 'ok', 23: 'ok', 32: 'ok',
        27: 'back', 8: 'back', 461: 'back', 10009: 'back', 4: 'back', 166: 'back',
        93: 'menu', 113: 'menu',                                // 菜单键(F2 方便电脑上试;82 是字母 R,不能用)
        // 媒体键只用 DOM 键码(安卓的 85/87/88/89/90 到了网页里是别的键,而且和字母 U/W/X/Y/Z 撞)
        179: 'playpause', 415: 'play', 417: 'ff', 228: 'ff', 412: 'rew', 227: 'rew',
        176: 'next', 177: 'prev',
        33: 'chup', 427: 'chup', 34: 'chdown', 428: 'chdown'
    };
    TV.keyName = function (e) {
        var k = e.keyCode || e.which;
        if (k >= 48 && k <= 57) return 'd' + (k - 48);
        if (k >= 96 && k <= 105) return 'd' + (k - 96);
        if (KEYMAP.hasOwnProperty(k)) return KEYMAP[k];
        var n = e.key;
        if (n === 'GoBack' || n === 'BrowserBack' || n === 'Escape') return 'back';
        if (n === 'MediaPlayPause') return 'playpause';
        if (n === 'ContextMenu') return 'menu';
        return '';
    };

    // ---------- 焦点 ----------
    var cur = null;            // 当前焦点元素
    var groupMem = {};         // 焦点组 → 上次停留的元素
    function visible(el) {
        if (!el || !document.body.contains(el)) return false;
        if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
        if (el.disabled || el.classList.contains('f-off')) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }
    function layerRoot() {
        var top = TV._topLayer();
        return top || document.body;
    }
    function groupOf(el) {
        while (el && el !== document.body) { if (el.getAttribute && el.getAttribute('data-fg')) return el; el = el.parentNode; }
        return null;
    }
    function rememberGroup(el) {
        var g = groupOf(el);
        while (g) {
            groupMem[g.getAttribute('data-fg') + '#' + (g._tvgid || (g._tvgid = TV.uid('g')))] = el;
            g = groupOf(g.parentNode);
        }
    }
    function groupRemembered(g) {
        var el = groupMem[g.getAttribute('data-fg') + '#' + (g._tvgid || (g._tvgid = TV.uid('g')))];
        if (el && g.contains(el) && visible(el)) return el;
        var act = g.querySelector('.f.on');           // 组里标了 .on(当前选中的标签 / 正在播的集)就去它
        if (act && visible(act)) return act;
        if (g.getAttribute('data-enter') === 'first') {   // 第一次进来落在第一个(选集:从按钮行往下 = 第 1 集,不是正下方那一集)
            var fs = g.querySelectorAll('.f');
            for (var i = 0; i < fs.length; i++) if (visible(fs[i])) return fs[i];
        }
        return null;
    }
    TV.focus = function (el, opt) {
        if (!el) return;
        if (cur && cur !== el) { cur.classList.remove('fo'); TV._emit(cur, 'tvblur'); }
        cur = el;
        el.classList.add('fo');
        rememberGroup(el);
        if (!(opt && opt.noScroll)) TV.reveal(el);
        TV._emit(el, 'tvfocus');
    };
    TV.focused = function () { return cur && document.body.contains(cur) ? cur : null; };
    // 在 root 里找第一个能选的(优先 .on,再 [data-first],再第一个)
    TV.focusFirst = function (root) {
        root = root || layerRoot();
        var els = TV.$$('.f', root).filter(visible);
        if (!els.length) return false;
        var pick = null;
        for (var i = 0; i < els.length && !pick; i++) if (els[i].hasAttribute('data-first')) pick = els[i];
        for (i = 0; i < els.length && !pick; i++) if (els[i].classList.contains('on')) pick = els[i];
        TV.focus(pick || els[0]);
        return true;
    };
    // 方向移动。返回 true = 动了
    TV.move = function (dir) {
        var root = layerRoot();
        var from = TV.focused();
        if (!from || !root.contains(from) || !visible(from)) return TV.focusFirst(root);
        var force = from.getAttribute('data-' + dir);
        if (force === 'stop') return false;
        if (force) { var t = root.querySelector(force); if (t && visible(t)) { enter(t); return true; } }
        var a = from.getBoundingClientRect();
        var acx = a.left + a.width / 2, acy = a.top + a.height / 2;
        var best = null, bestScore = Infinity;
        var els = root.querySelectorAll('.f');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el === from || !visible(el)) continue;
            var b = el.getBoundingClientRect();
            var bcx = b.left + b.width / 2, bcy = b.top + b.height / 2;
            var main, cross, overlap;
            if (dir === 'left' || dir === 'right') {
                main = dir === 'left' ? a.left - b.right : b.left - a.right;
                if ((dir === 'left' ? bcx >= acx : bcx <= acx)) continue;
                overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                cross = overlap > 0 ? 0 : Math.abs(bcy - acy);
            } else {
                main = dir === 'up' ? a.top - b.bottom : b.top - a.bottom;
                if ((dir === 'up' ? bcy >= acy : bcy <= acy)) continue;
                overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                cross = overlap > 0 ? Math.abs(bcx - acx) * 0.25 : Math.abs(bcx - acx);
            }
            if (main < -4) main = Math.max(0, main + a.width / 2);  // 叠在一起的(放大后的卡)也算
            if (main < 0) main = 0;
            var score = main + cross * 2.2;
            if (score < bestScore) { bestScore = score; best = el; }
        }
        if (!best) { TV._emit(from, 'tvedge', { dir: dir }); return false; }
        enter(best, from);
        return true;
    };
    // 跨进另一个焦点组时,回到那个组上次停留的元素(从最外层的组开始找:从顶栏下到页面,回到页面里上次停的那张卡)
    function enter(target, from) {
        var chain = [], g = groupOf(target);
        while (g) { chain.unshift(g); g = groupOf(g.parentNode); }
        for (var i = 0; i < chain.length; i++) {
            if (from && chain[i].contains(from)) continue;
            var m = groupRemembered(chain[i]);
            if (m) { TV.focus(m); return; }
        }
        TV.focus(target);
    }
    // 让焦点元素露出来:最近的可滚动祖先(.sx 横向 / .sy 纵向)滚到它在视野里(留边距)
    TV.reveal = function (el) {
        var p = el.parentNode;
        while (p && p !== document.body) {
            if (p.classList) {
                if (p.classList.contains('sx')) {
                    var pr = p.getBoundingClientRect(), r = el.getBoundingClientRect();
                    var padX = Math.min(pr.width * 0.12, 120);
                    if (r.left < pr.left + padX) p.scrollLeft -= (pr.left + padX - r.left);
                    else if (r.right > pr.right - padX) p.scrollLeft += (r.right - (pr.right - padX));
                }
                if (p.classList.contains('sy')) {
                    var pr2 = p.getBoundingClientRect(), r2 = el.getBoundingClientRect();
                    var padY = Math.min(pr2.height * 0.18, 160);
                    // data-sy-top = 选择器:焦点在页面里【第一个】匹配它的元素里时滚回顶(首页:第一排)。
                    // 只认第一个:首页「继续观看 / 我的追剧」下面的推荐区里也有 .row:first-child,
                    // 以前用 closest 命中它 → 焦点进「热门剧集」也滚回顶,选中的卡跑到屏幕外
                    var keepTop = p.getAttribute('data-sy-top');
                    var topEl = keepTop ? p.querySelector(keepTop) : null;
                    if (topEl && topEl.contains(el)) p.scrollTop = 0;
                    else if (r2.top < pr2.top + padY) p.scrollTop -= (pr2.top + padY - r2.top);
                    else if (r2.bottom > pr2.bottom - padY) p.scrollTop += (r2.bottom - (pr2.bottom - padY));
                }
            }
            p = p.parentNode;
        }
    };

    // ---------- 事件 ----------
    TV._emit = function (el, name, detail) {
        var ev;
        try { ev = new CustomEvent(name, { bubbles: true, cancelable: true, detail: detail || null }); }
        catch (e) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent(name, true, true, detail || null); }
        return el.dispatchEvent(ev);
    };

    // ---------- 屏幕栈 / 路由 ----------
    // 每打开一层 pushState 一次;返回键(安卓 WebView 的返回 = history.back)触发 popstate → 关最上层。
    var defs = {}, stack = [], layers = [], booted = false, appEl = null;
    TV.screen = function (name, factory) { defs[name] = factory; };
    TV.current = function () { return stack[stack.length - 1] || null; };
    TV.stack = function () { return stack.slice(); };
    TV._topLayer = function () {
        if (layers.length) return layers[layers.length - 1].el;
        var s = TV.current();
        return s ? s.el : null;
    };
    function mount(name, params) {
        var f = defs[name];
        if (!f) throw new Error('no screen ' + name);
        var scr = { name: name, params: params || {}, lastFocus: null };
        var api = f(scr.params, scr) || {};
        scr.api = api;
        scr.el = api.el;
        scr.el.classList.add('scr');
        scr.el.setAttribute('data-scr', name);
        appEl.appendChild(scr.el);
        return scr;
    }
    function show(scr, back) {
        scr.el.style.display = '';
        if (scr.api.onShow) { try { scr.api.onShow(back); } catch (e) { TV.log('onShow', e); } }
        if (back && scr.lastFocus && scr.el.contains(scr.lastFocus) && visible(scr.lastFocus)) TV.focus(scr.lastFocus, { noScroll: true });
        else if (!TV.focused() || !scr.el.contains(TV.focused())) TV.focusFirst(scr.el);
    }
    function hide(scr) {
        scr.lastFocus = TV.focused();
        if (scr.api.onHide) { try { scr.api.onHide(); } catch (e) { TV.log('onHide', e); } }
        scr.el.style.display = 'none';
    }
    function destroy(scr) {
        if (scr.api.destroy) { try { scr.api.destroy(); } catch (e) { TV.log('destroy', e); } }
        if (scr.el.parentNode) scr.el.parentNode.removeChild(scr.el);
    }
    // 打开一层。opt.replace = 换掉当前层(不新增历史)。
    // 还有"后退"在路上(history.back() 是异步的)时先等它落地,否则新压的这条历史会被那次后退弹掉
    TV.go = function (name, params, opt) {
        if (!settled()) { settleQ.push(function () { TV.go(name, params, opt); }); return null; }
        opt = opt || {};
        var prev = TV.current();
        if (opt.replace && prev) { stack.pop(); destroy(prev); prev = TV.current(); }
        else if (prev) hide(prev);
        var scr = mount(name, params);
        stack.push(scr);
        if (!opt.replace) { try { history.pushState({ tv: stack.length }, ''); } catch (e) { } }
        show(scr, false);
        return scr;
    };
    // 关最上层(由 popstate 驱动;代码里想关就 history.back())。
    // 返回键在安卓 App 里不是按键事件,是 WebView 的后退 → 只能在这里处理:屏幕的 onBack() 返回 true = 它自己消化了
    // (比如搜索结果 → 回到联想、播放器先收起菜单),那就把被弹掉的那条历史补回去,屏幕不动。
    function popOne() {
        if (layers.length) { closeLayer(layers[layers.length - 1], true); return; }
        var s = TV.current();
        if (s && s.api.onBack) {
            var used = false;
            try { used = s.api.onBack() === true; } catch (e) { TV.log('onBack', e); }
            if (used) { try { history.pushState({ tv: 'stay' }, ''); } catch (e) { } return; }
        }
        if (stack.length <= 1) { rootBack(); return; }
        var scr = stack.pop();
        destroy(scr);
        show(TV.current(), true);
    }
    // ---- 后退排队 ----
    // 每次后退 = history.back() → popstate → popOne() 退一层。history.back() 是异步的,连着要退两层(关菜单再退出播放)
    // 或者退的同时又要打开新的一层时,必须一个一个来:popsWanted 记还要退几层,popBusy = 有一次后退在路上,
    // settleQ = 等后退都落地了再做的事(打开新屏 / 弹层)。
    var popsWanted = 0, popBusy = false, popSafety = 0, lateUntil = 0, settleQ = [];
    function settled() { return !popBusy && popsWanted === 0; }
    TV.whenSettled = function (fn) { if (settled()) fn(); else settleQ.push(fn); };
    function drain() {
        while (settled() && settleQ.length) { var fn = settleQ.shift(); try { fn(); } catch (e) { TV.log('settle', e); } }
    }
    function kickPop() {
        if (popBusy || popsWanted <= 0) return;
        popBusy = true;
        clearTimeout(popSafety);
        // 1.5 秒都没等到 popstate(没有可退的历史 / 内核没发):直接在界面上退一层;之后 3 秒内迟到的那次 popstate 不再算
        popSafety = setTimeout(function () {
            if (!popBusy) return;
            popBusy = false; popsWanted = Math.max(0, popsWanted - 1); lateUntil = TV.now() + 3000;
            popOne(); kickPop(); drain();
        }, 1500);
        try { history.back(); } catch (e) { clearTimeout(popSafety); popBusy = false; popsWanted = Math.max(0, popsWanted - 1); popOne(); kickPop(); drain(); }
    }
    // 代码里要退一层(关弹层 / 退出播放)用这个
    TV.back = function () { popsWanted++; kickPop(); };
    // 遥控器的返回:同一次按键可能从两条路进来(按键事件 + 安卓 App 的 onBackPressed,前后差几毫秒),100ms 内只算一次;
    // 再长就会吞掉用户真的连按两下(关列表 + 退出)
    var lastUserBack = 0;
    TV.userBack = function () {
        var t = TV.now();
        if (t - lastUserBack < 100) return;
        lastUserBack = t;
        TV.back();
    };
    function onPop() {
        clearTimeout(popSafety);
        if (popBusy) { popBusy = false; if (popsWanted > 0) popsWanted--; }
        else if (lateUntil && TV.now() < lateUntil) { lateUntil = 0; return; }   // 兜底已经替它退过了
        popOne();
        kickPop();
        drain();
    }
    // 首页的返回:历史里永远压着一层"守卫"。按返回 = 守卫被弹掉 → 先给屏幕自己处理(比如焦点先回到顶栏),
    // 不处理就提示"再按一次退出",这 2.5 秒里守卫不补回去:再按一次时 WebView 已经没有可退的历史,安卓直接关 App。
    var guardT = 0, exitArmedAt = 0;
    function rootBack() {
        exitArmedAt = TV.now();
        TV.toast('再按一次返回键退出', 2500);
        clearTimeout(guardT);
        guardT = setTimeout(guard, 2500);
    }
    function guard() { clearTimeout(guardT); try { history.pushState({ tv: 'root' }, ''); } catch (e) { } }

    // 安卓 App(android/.../MainActivity.java 的 onBackPressed)按返回时不走浏览器历史,而是执行一段固定的 JS:
    //   window.vueApp.showDetail 为真 → 调 window.vueApp.closeDetail();否则(或者出错)直接退出 App。
    // 已经装好的 App 改不了,所以电视版在页面上放一个同名的壳:还有东西可退(弹层 / 不在首页 / 首页还没提示"再按一次")就接住,
    // 交给 TV.back() 走同一套 popstate 逻辑;提示过 2.5 秒内再按 → showDetail 为假 → App 自己退出。
    // 别用 id 为 tv-episode-popup 的元素、也别放全局 dp —— App 那段 JS 会先去动它们。
    var shim = { searched: false };
    try {
        Object.defineProperty(shim, 'showDetail', {
            get: function () {
                try { return layers.length > 0 || stack.length > 1 || TV.now() - exitArmedAt > 2500; } catch (e) { return false; }
            }
        });
    } catch (e) { shim.showDetail = true; }
    shim.closeDetail = function () { TV.userBack(); };
    shim.goHome = function () { TV.userBack(); };
    window.vueApp = shim;
    TV.on(window, 'popstate', onPop);

    // ---------- 弹层(菜单 / 确认 / 面板)----------
    // TV.layer(el, { onClose, onKey }) 盖在当前屏上,焦点只在弹层里走;返回键关掉它。
    // L.close() 也是走一次后退(弹层占着一条历史);还有后退在路上时等它落地再挂上来
    TV.layer = function (el, opt) {
        opt = opt || {};
        var L = { el: el, opt: opt, prevFocus: null, state: 'wait' };
        el.classList.add('lyr');
        L.close = function () {
            if (L.state === 'wait') { L.state = 'gone'; return; }
            if (L.state === 'open') { L.state = 'closing'; TV.back(); }
        };
        TV.whenSettled(function () {
            if (L.state !== 'wait') return;
            L.state = 'open';
            L.prevFocus = TV.focused();
            document.body.appendChild(el);
            layers.push(L);
            try { history.pushState({ tv: 'layer' }, ''); } catch (e) { }
            if (!TV.focusFirst(el)) { if (cur) cur.classList.remove('fo'); }
            if (opt.onOpen) { try { opt.onOpen(); } catch (e) { TV.log('layer open', e); } }
        });
        return L;
    };
    function closeLayer(L) {
        var i = layers.indexOf(L);
        if (i < 0) return;
        layers.splice(i, 1);
        L.state = 'gone';
        if (L.el.parentNode) L.el.parentNode.removeChild(L.el);
        if (L.opt.onClose) { try { L.opt.onClose(); } catch (e) { TV.log('layer close', e); } }
        if (L.prevFocus && document.body.contains(L.prevFocus) && visible(L.prevFocus)) TV.focus(L.prevFocus, { noScroll: true });
        else { var s = TV.current(); if (s) TV.focusFirst(s.el); }
    }
    // 列表菜单:TV.menu(标题, [{ label, sub, on(当前项), value }], function (item) {}) — 选了就关
    TV.menu = function (title, items, pick, opt) {
        opt = opt || {};
        var html = '<div class="mnu' + (opt.wide ? ' wide' : '') + '"><div class="mnu-box"><div class="mnu-t">' + TV.esc(title) + '</div><div class="mnu-l sy">';
        TV.each(items, function (it, i) {
            html += '<div class="mnu-i f' + (it.on ? ' on' : '') + (it.disabled ? ' f-off dis' : '') + '" data-i="' + i + '">' +
                '<span class="mnu-lb">' + TV.esc(it.label) + '</span>' + (it.sub ? '<span class="mnu-sub">' + TV.esc(it.sub) + '</span>' : '') +
                (it.on ? '<span class="mnu-ck">✓</span>' : '') + '</div>';
        });
        html += '</div></div></div>';
        var el = TV.el(html);
        var L = TV.layer(el, { onClose: opt.onClose });
        TV.on(el, 'tvok', function (e) {
            var t = e.target.closest ? e.target.closest('.mnu-i') : e.target;
            if (!t) return;
            var it = items[+t.getAttribute('data-i')];
            L.close();
            if (pick) TV.whenSettled(function () { pick(it); });
        });
        return L;
    };
    TV.confirm = function (title, text, okLabel, cb) {
        var el = TV.el('<div class="mnu"><div class="mnu-box cfm"><div class="mnu-t">' + TV.esc(title) + '</div>' +
            (text ? '<div class="cfm-x">' + TV.esc(text) + '</div>' : '') +
            '<div class="cfm-b"><div class="btn f" data-first data-v="1">' + TV.esc(okLabel || '确定') + '</div><div class="btn f" data-v="0">取消</div></div></div></div>');
        var L = TV.layer(el);
        TV.on(el, 'tvok', function (e) { var v = e.target.getAttribute('data-v'); L.close(); if (v === '1' && cb) TV.whenSettled(cb); });
        return L;
    };

    // ---------- 提示 ----------
    var toastEl = null, toastT = 0;
    TV.toast = function (msg, ms) {
        if (!toastEl) { toastEl = TV.el('<div class="toast"></div>'); document.body.appendChild(toastEl); }
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        clearTimeout(toastT);
        toastT = setTimeout(function () { toastEl.classList.remove('show'); }, ms || 2200);
    };
    TV.log = function () { try { console.log.apply(console, ['[tv]'].concat(Array.prototype.slice.call(arguments))); } catch (e) { } };

    // ---------- 键盘 / 鼠标入口 ----------
    var lastKeyAt = 0, repeatN = 0, lastKey = '';
    TV.on(document, 'keydown', function (e) {
        var name = TV.keyName(e);
        var tgt = e.target;
        var typing = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA');
        if (typing) {
            // 输入框里:上下 / 返回 / OK 离开输入框,其余键交给输入法
            if (name === 'back' && e.keyCode !== 8) { tgt.blur(); e.preventDefault(); return; }
            if (name === 'up' || name === 'down' || (name === 'ok' && e.keyCode === 13)) { tgt.blur(); }
            else return;
        }
        if (!name) { var s0 = TV.current(); if (s0 && s0.api.onChar && e.key && e.key.length === 1) { if (s0.api.onChar(e.key) !== false) e.preventDefault(); } return; }
        var t = TV.now();
        repeatN = (name === lastKey && t - lastKeyAt < 220) ? repeatN + 1 : 0;   // 长按连发计数(快进加速用)
        lastKey = name; lastKeyAt = t;
        var info = { name: name, repeat: repeatN, event: e };
        // 返回键一律走历史(和安卓 App 的返回同一条路,见 popOne);只有退格键先问一下屏幕(搜索框里删字)
        if (name === 'back') {
            var s1 = TV.current();
            if (!(e.keyCode === 8 && !layers.length && s1 && s1.api.onKey && s1.api.onKey(info) === true)) TV.userBack();
            e.preventDefault();
            return;
        }
        // 1) 弹层 2) 当前屏的 onKey 3) 默认:方向键移动焦点、OK 选中
        var L = layers[layers.length - 1];
        var handled = false;
        if (L && L.opt.onKey) handled = L.opt.onKey(info) === true;
        if (!handled && !L) { var s = TV.current(); if (s && s.api.onKey) handled = s.api.onKey(info) === true; }
        if (!handled) {
            if (name === 'up' || name === 'down' || name === 'left' || name === 'right') { TV.move(name); handled = true; }
            else if (name === 'ok') { var f = TV.focused(); if (f) TV._emit(f, 'tvok'); handled = true; }
        }
        if (handled) e.preventDefault();
    }, true);
    // 鼠标 / 触摸 / 飞鼠:点哪个就选哪个
    TV.on(document, 'click', function (e) {
        var t = e.target;
        while (t && t !== document.body && !(t.classList && t.classList.contains('f'))) t = t.parentNode;
        if (!t || t === document.body || t.classList.contains('f-off')) return;
        e.preventDefault();
        TV.focus(t, { noScroll: true });
        TV._emit(t, 'tvok');
    }, false);
    TV.on(document, 'mouseover', function (e) {
        var t = e.target;
        while (t && t !== document.body && !(t.classList && t.classList.contains('f'))) t = t.parentNode;
        if (t && t !== document.body && t !== cur && !t.classList.contains('f-off')) {
            var root = layerRoot();
            if (root.contains(t)) TV.focus(t, { noScroll: true });
        }
    }, false);

    // ---------- 尺寸:按 1920 宽设计,1rem = 宽度/120(1920 → 16px,1280 → 10.67px) ----------
    function fit() {
        var w = window.innerWidth || document.documentElement.clientWidth || 1280;
        var h = window.innerHeight || document.documentElement.clientHeight || 720;
        // 竖屏(手机误入)按高度算,别让字小到看不见
        var base = Math.min(w / 120, h / 67.5);
        document.documentElement.style.fontSize = Math.max(8, base) + 'px';
    }
    fit();
    TV.on(window, 'resize', TV.debounce(fit, 120));

    // ---------- 启动 ----------
    TV.boot = function (first, params) {
        if (booted) return;
        booted = true;
        appEl = document.getElementById('app');
        try { history.replaceState({ tv: 0 }, ''); } catch (e) { }
        var scr = mount(first, params);
        stack.push(scr);
        guard();
        show(scr, false);
    };
    TV.reset = function (first, params) {
        // 退出登录等:清空栈从头来
        while (layers.length) { var L = layers.pop(); if (L.el.parentNode) L.el.parentNode.removeChild(L.el); }
        while (stack.length) destroy(stack.pop());
        var scr = mount(first, params);
        stack.push(scr);
        show(scr, false);
    };

    // ---------- 图片懒加载(IntersectionObserver 有就用,没有就滚动时检查)----------
    var io = null;
    if (window.IntersectionObserver) {
        io = new IntersectionObserver(function (ents) {
            TV.each(ents, function (en) { if (en.isIntersecting || en.intersectionRatio > 0) { loadImg(en.target); io.unobserve(en.target); } });
        }, { rootMargin: '300px 600px' });
    }
    function loadImg(img) {
        var s = img.getAttribute('data-src');
        if (!s) return;
        img.removeAttribute('data-src');
        img.onerror = function () { img.onerror = null; img.classList.add('noimg'); var fb = img.getAttribute('data-fb'); if (fb) img.src = fb; };
        img.onload = function () { img.classList.add('ld'); };
        img.src = s;
    }
    TV.lazy = function (root) {
        TV.each((root || document).querySelectorAll('img[data-src]'), function (img) {
            if (io) io.observe(img); else loadImg(img);
        });
    };
})();
