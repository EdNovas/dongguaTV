/* E视界 电视版 · 登录
 * 电视上敲邮箱密码太难:优先扫码(手机上已登录的 E视界 扫一下就行,同 index.html 的扫码登录);
 * 扫码不可用 / 想自己输 → 右边账号密码(用盒子自带输入法)。
 * params: { qr: 服务器开了扫码登录, onDone: 登录成功回调 }
 */
(function () {
    'use strict';
    var TV = window.TV;

    TV.screen('login', function (params) {
        var el = TV.el(
            '<div class="lg">' +
            '<div class="lg-brand"><img src="/icon.png" alt=""><b>E</b>视界</div>' +
            '<div class="lg-cols">' +
            '  <div class="lg-qr"><div class="lg-t">手机扫码登录</div><div class="lg-qrbox"></div><div class="lg-qrst dim">正在生成二维码…</div>' +
            '    <div class="lg-tip">用手机相机或浏览器扫一扫,在手机上确认就登录好了<br>(手机上先登录 E视界)</div></div>' +
            '  <div class="lg-form"><div class="lg-t">账号密码登录</div>' +
            '    <div class="lg-in f" data-k="email"><span class="lg-lb">邮箱</span><span class="lg-v"></span></div>' +
            '    <div class="lg-in f" data-k="pwd"><span class="lg-lb">密码</span><span class="lg-v"></span></div>' +
            '    <div class="btn pri f" data-act="login">登录</div>' +
            '    <div class="lg-msg"></div>' +
            '    <div class="lg-alt"><span class="chip f" data-act="pwdonly">我只有访问密码</span></div>' +
            '  </div>' +
            '</div>' +
            '<input class="lg-ime" type="text" autocomplete="off" autocorrect="off" spellcheck="false">' +
            '</div>');
        var qrBox = TV.$('.lg-qrbox', el), qrSt = TV.$('.lg-qrst', el), msgEl = TV.$('.lg-msg', el), ime = TV.$('.lg-ime', el);
        var vals = { email: TV.store.raw('emax_v2board_email') || '', pwd: '' }, editing = null, pwdOnly = false;
        var qr = null, pollT = 0, renewN = 0, dead = false, busy = false;

        function paintVals() {
            TV.each(TV.$$('.lg-in', el), function (x) {
                var k = x.getAttribute('data-k'), v = vals[k] || '';
                TV.$('.lg-v', x).textContent = k === 'pwd' ? (v ? new Array(v.length + 1).join('•') : '按 OK 输入') : (v || '按 OK 输入');
                x.classList.toggle('empty', !v);
            });
            TV.$('[data-k="email"]', el).style.display = pwdOnly ? 'none' : '';
            TV.$('[data-k="pwd"] .lg-lb', el).textContent = pwdOnly ? '访问密码' : '密码';
            TV.$('[data-act="pwdonly"]', el).textContent = pwdOnly ? '用账号密码登录' : '我只有访问密码';
        }
        // 用盒子自带输入法输入:真输入框只在这一刻露出来、聚焦(平时不让它拿焦点,老盒子一聚焦就弹输入法)
        function edit(k) {
            editing = k;
            ime.type = k === 'pwd' ? 'password' : (k === 'email' ? 'email' : 'text');
            ime.value = vals[k] || '';
            ime.placeholder = k === 'email' ? '输入邮箱,按确定' : '输入密码,按确定';
            ime.style.display = 'block';
            try { ime.focus(); ime.click(); } catch (e) { }
        }
        function endEdit() {
            if (!editing) return;
            vals[editing] = ime.value.replace(/^\s+|\s+$/g, '');
            var k = editing;
            editing = null;
            ime.style.display = 'none';
            paintVals();
            var next = k === 'email' ? TV.$('[data-k="pwd"]', el) : TV.$('[data-act="login"]', el);
            if (next) TV.focus(next);
        }
        TV.on(ime, 'keydown', function (e) { if (e.keyCode === 13) { e.preventDefault(); ime.blur(); } });
        TV.on(ime, 'blur', function () { setTimeout(endEdit, 0); });

        function msg(t, bad) { msgEl.textContent = t || ''; msgEl.className = 'lg-msg' + (bad ? ' red' : ''); }
        function done() {
            dead = true;
            clearTimeout(pollT);
            TV.toast('登录成功');
            if (params.onDone) params.onDone();
        }
        function submit() {
            if (busy) return;
            if (pwdOnly) {
                if (!vals.pwd) { msg('先输入访问密码', true); return; }
                busy = true; msg('正在登录…');
                TV.api.loginPassword(vals.pwd).then(function (r) { busy = false; if (r && r.ok) done(); else msg((r && r.message) || '密码不对', true); },
                    function () { busy = false; msg('连不上服务器,检查网络后再试', true); });
                return;
            }
            if (!vals.email || !vals.pwd) { msg('邮箱和密码都要填', true); return; }
            busy = true; msg('正在登录…');
            TV.api.loginV2board(vals.email, vals.pwd).then(function (r) { busy = false; if (r && r.ok) done(); else msg((r && r.message) || '登录失败', true); },
                function () { busy = false; msg('连不上服务器,检查网络后再试', true); });
        }
        TV.on(el, 'tvok', function (e) {
            var t = e.target, k = t.getAttribute('data-k'), act = t.getAttribute('data-act');
            if (k) edit(k);
            else if (act === 'login') submit();
            else if (act === 'pwdonly') { pwdOnly = !pwdOnly; vals.pwd = ''; paintVals(); msg(''); }
            else if (act === 'qrretry') { renewN = 0; startQr(); }
        });

        // ---------- 扫码 ----------
        function startQr() {
            clearTimeout(pollT);
            qrBox.innerHTML = '';
            qrSt.textContent = '正在生成二维码…';
            TV.api.qrNew().then(function (r) {
                if (dead) return;
                qr = r;
                qr.exp = TV.now() + (r.ttl || 300) * 1000;
                drawQr(r.url);
                qrSt.textContent = '等待扫码';
                poll();
            }, function () {
                if (dead) return;
                qrSt.innerHTML = '二维码生成失败 <span class="chip f" data-act="qrretry">重试</span>';
            });
        }
        function drawQr(text) {
            try {
                var q = window.qrcode(0, 'M');
                q.addData(text);
                q.make();
                qrBox.innerHTML = '<img alt="" src="' + q.createDataURL(8, 0) + '">';
            } catch (e) { qrBox.innerHTML = '<div class="dim">二维码画不出来</div>'; }
        }
        function poll() {
            pollT = setTimeout(function () {
                if (dead || !qr) return;
                if (document.hidden) { poll(); return; }
                if (TV.now() > qr.exp) { renew(); return; }
                TV.api.qrPoll(qr.code, qr.secret).then(function (r) {
                    if (dead) return;
                    var st = r && r.status;
                    if (st === 'approved' && r.auth) {
                        qrSt.textContent = '正在登录…';
                        TV.api.qrApply(r.auth).then(function (ok) { if (ok && (ok === true || ok.ok)) done(); else { qrSt.textContent = '登录没成功,再扫一次'; renew(); } },
                            function () { qrSt.textContent = '登录没成功,再扫一次'; renew(); });
                        return;
                    }
                    if (st === 'scanned') qrSt.textContent = '已扫码,请在手机上确认';
                    else if (st === 'denied') { qrSt.textContent = '手机上取消了'; renew(); return; }
                    else if (st === 'expired') { renew(); return; }
                    poll();
                }, function () { if (!dead) poll(); });
            }, 2000);
        }
        function renew() {
            if (++renewN > 3) { qrSt.innerHTML = '二维码过期了 <span class="chip f" data-act="qrretry">刷新</span>'; return; }
            startQr();
        }

        paintVals();
        if (params.qr) startQr();
        else { TV.$('.lg-qr', el).style.display = 'none'; el.classList.add('noqr'); }

        return {
            el: el,
            onShow: function () { var f = TV.$(params.qr ? '[data-k="email"]' : '[data-k="email"]', el); if (f && !TV.focused()) TV.focus(f); },
            destroy: function () { dead = true; clearTimeout(pollT); }
        };
    });
})();
