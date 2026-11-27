/* E视界 电视版 · 我的
 * 看过的 / 我的追剧 两排 + 设置(都是按钮,电视上不用打字):
 *   跳过片头片尾、去广告、清空观看记录、切换到网页版、退出登录、关于
 */
(function () {
    'use strict';
    var TV = window.TV;

    function chromeVer() { var m = /Chrome\/(\d+)/.exec(navigator.userAgent || ''); return m ? +m[1] : 0; }
    // 这台设备能不能跑网页版(同 index.html 启动检测的试法)
    function canRunWeb() {
        try { new Function('var o={a:1},p={...o};return o?.a??p.a'); new Function('return async function(){await 0}'); new RegExp('a', 's'); return true; } catch (e) { return false; }
    }

    TV.minePage = function () {
        var pg = TV.el('<div class="pg sy"><div class="mn-rows"></div><div class="mn-set"><div class="row-t">设置</div><div class="chips mn-btns" data-fg="set"></div><div class="mn-about dim"></div></div></div>');
        var rowsBox = TV.$('.mn-rows', pg), btns = TV.$('.mn-btns', pg), about = TV.$('.mn-about', pg);
        var sig = '';

        function paintRows(force) {
            var hist = TV.api.historyCards(50), favs = TV.api.favoriteCards(100);
            var s = JSON.stringify([hist.length, hist[0] && hist[0].title, hist[0] && hist[0].progress, favs.length]);
            if (s === sig && !force) return;
            sig = s;
            var had = TV.focused() && rowsBox.contains(TV.focused());
            rowsBox.innerHTML = '';
            if (hist.length) rowsBox.appendChild(TV.ui.row('看过的', hist, function (it) { TV.resume(it); }, { id: 'mhist', hint: '按 OK 接着看' }));
            if (favs.length) rowsBox.appendChild(TV.ui.row('我的追剧', favs, function (it) { TV.openItem(it); }, { id: 'mfav' }));
            if (!hist.length && !favs.length) rowsBox.innerHTML = '<div class="empty">还没有看过的片子。<br>在首页挑一部,或者用「搜索」按片名首字母找</div>';
            if (had) TV.focusFirst(rowsBox);
        }
        function onOff(v) { return v ? '开' : '关'; }
        function paintBtns() {
            var skip = TV.store.get('tv_skip_intro', true) !== false;
            var ad = TV.api.adFilterOn();
            var user = TV.api.userLabel();
            var h = '';
            h += '<div class="chip f" data-a="skip">自动跳过片头:' + onOff(skip) + '</div>';
            h += '<div class="chip f" data-a="ad">去广告:' + onOff(ad) + '</div>';
            h += '<div class="chip f" data-a="clear">清空观看记录</div>';
            if (canRunWeb()) h += '<div class="chip f" data-a="web">切换到网页版</div>';
            h += '<div class="chip f" data-a="reload">刷新</div>';
            if (TV.api.token()) h += '<div class="chip f" data-a="logout">退出登录' + (user ? '(' + TV.esc(user) + ')' : '') + '</div>';
            btns.innerHTML = h;
            var cv = chromeVer();
            about.textContent = 'E视界 电视版 · 浏览器内核 ' + (cv ? 'Chrome ' + cv : '未知') + (canRunWeb() ? '' : '(太旧,网页版打不开,只能用电视版)');
        }
        TV.on(btns, 'tvok', function (e) {
            var a = e.target.getAttribute('data-a');
            if (a === 'skip') { TV.store.set('tv_skip_intro', !(TV.store.get('tv_skip_intro', true) !== false)); paintBtns(); refocus(a); }
            else if (a === 'ad') { TV.store.set('donggua_ad_filter_enabled', TV.api.adFilterOn() ? 'false' : 'true'); paintBtns(); refocus(a); }
            else if (a === 'clear') TV.confirm('清空观看记录?', '首页「继续观看」会清空,已同步到账号的记录也会一起删掉。', '清空', function () {
                TV.each(TV.api.historyCards(200), function (c) { TV.api.removeHistory(c.hist ? c.hist.name : c.title); });
                TV.api.flushHistory();
                paintRows(true); TV.toast('已清空');
            });
            else if (a === 'web') TV.confirm('切换到网页版?', '以后打开都是网页版;想回来,在网页版底部点「TV 模式」。', '切换', function () { location.href = '/?tv=0'; });
            else if (a === 'reload') location.reload();
            else if (a === 'logout') TV.confirm('退出登录?', '这台设备上的观看记录和追剧会清掉(账号里的不受影响)。', '退出', function () { TV.api.logout(); TV.toast('已退出'); setTimeout(function () { location.reload(); }, 600); });
        });
        function refocus(a) { var x = TV.$('[data-a="' + a + '"]', btns); if (x) TV.focus(x, { noScroll: true }); }

        paintRows(true);
        paintBtns();
        TV.on(window, 'tv:hist', function () { paintRows(); });
        TV.on(window, 'tv:favs', function () { paintRows(); });
        return { el: pg, onShow: function () { paintRows(); paintBtns(); } };
    };
})();
