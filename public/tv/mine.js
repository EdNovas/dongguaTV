/* E视界 电视版 · 我的
 * 看过的 / 我的追剧 两排 + 设置(都是按钮,电视上不用打字):
 *   跳过片头片尾、去广告、清空观看记录、切换到网页版、退出登录、关于
 */
(function () {
    'use strict';
    var TV = window.TV;

    function chromeVer() { var m = /Chrome\/(\d+)/.exec(navigator.userAgent || ''); return m ? +m[1] : 0; }
    function canRunWeb() { return TV.canRunWeb(); }

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
            if (canRunWeb()) h += '<div class="chip f" data-a="web">关闭 TV 模式(换网页版)</div>';
            if (TV.api.cfg && TV.api.cfg.app_download) h += '<div class="chip f" data-a="app">下载 App(手机 / 盒子)</div>';
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
            else if (a === 'web') TV.leaveTV();
            else if (a === 'reload') location.reload();
            else if (a === 'app') showAppQr();
            else if (a === 'logout') TV.confirm('退出登录?', '这台设备上的观看记录和追剧会清掉(账号里的不受影响)。', '退出', function () { TV.api.logout(); TV.toast('已退出'); setTimeout(function () { location.reload(); }, 600); });
        });
        // 下载页的二维码 + 短网址(电视上点不了下载链接,用手机扫;盒子用「下载器」输短网址)
        function showAppQr() {
            var url = location.protocol + '//' + location.host + '/app', img = '';
            try { var q = window.qrcode(0, 'M'); q.addData(url); q.make(); img = '<img alt="" src="' + q.createDataURL(8, 0) + '">'; } catch (e) { }
            var info = TV.api.cfg.app_download || {};
            var el = TV.el('<div class="mnu"><div class="mnu-box cfm appq"><div class="mnu-t">下载 E视界 安卓 App</div>' +
                '<div class="appq-r"><div class="lg-qrbox appq-qr">' + img + '</div><div class="cfm-x">手机扫码打开下载页' + (info.version ? '(' + TV.esc(info.version) + ')' : '') + '。<br>' +
                '安卓手机、平板、电视盒子通用(Android ' + TV.esc(info.minAndroid || '7.0') + ' 及以上)。<br>盒子上用「下载器」类 App 可以直接输入:<br><b>' + TV.esc(location.host) + '/app.apk</b><br>' +
                'iPhone / iPad / Apple TV 暂时没有 App,请用浏览器看。</div></div>' +
                '<div class="cfm-b"><div class="btn f" data-first>知道了</div></div></div></div>');
            var L = TV.layer(el);
            TV.on(el, 'tvok', function () { L.close(); });
        }
        function refocus(a) { var x = TV.$('[data-a="' + a + '"]', btns); if (x) TV.focus(x, { noScroll: true }); }

        paintRows(true);
        paintBtns();
        TV.on(window, 'tv:hist', function () { paintRows(); });
        TV.on(window, 'tv:favs', function () { paintRows(); });
        return { el: pg, onShow: function () { paintRows(); paintBtns(); } };
    };
})();
