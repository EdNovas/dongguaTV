/* E视界 电视版 · 启动
 * 读配置 → 看登录 → 首页(没登录先出登录页);?play=片名 直接进详情;?tv=1 记住"以后都用电视版"。
 * 卡片点开的统一入口也在这里:TV.openItem / TV.openWork / TV.resume
 */
(function () {
    'use strict';
    var TV = window.TV;

    // 搜索还在继续时 Work 会被原地更新,详情页拿一份快照(线路下标才不会变)
    TV.openWork = function (work) { TV.go('detail', { work: TV.api.snapshotWork ? TV.api.snapshotWork(work) : work }); };
    TV.resume = function (card) {
        if (card && card.hist) TV.go('detail', { hist: card.hist, autoplay: true });
        else TV.openItem(card);
    };
    TV.openItem = function (it) {
        if (!it) return;
        if (it.kind === 'hist' && it.hist) { TV.resume(it); return; }
        if (it.kind === 'work' && it.work) { TV.openWork(it.work); return; }
        if (it.kind === 'fav' && it.fav) { TV.go('detail', { fav: it.fav, title: it.title, poster: it.poster }); return; }
        TV.go('detail', { title: it.title, year: it.year, poster: it.poster, original: it.original, media: it.media });
    };

    function param(k) {
        var m = new RegExp('[?&]' + k + '=([^&#]*)').exec(location.search);
        if (!m) return '';
        try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return m[1]; }
    }

    function startHome() {
        TV.boot('home');
        TV.started = true;
        var play = param('play');
        if (play) setTimeout(function () { TV.go('detail', { title: play }); }, 50);
        // 后台:v2board 令牌重新登记(服务器重启后要)、拉账号里的观看记录、追剧
        setTimeout(function () {
            try { TV.api.revalidateOnce(); } catch (e) { }
            try { if (TV.api.pullHistory) TV.api.pullHistory(); } catch (e) { }
            try { if (TV.api.refreshFavorites) TV.api.refreshFavorites(); } catch (e) { }
        }, 1200);
    }
    function startLogin(info) {
        TV.boot('login', {
            qr: !!info.qrLogin,
            v2b: info.v2board !== false,
            onDone: function () {
                TV.reset('home');
                setTimeout(function () {
                    try { if (TV.api.pullHistory) TV.api.pullHistory(); } catch (e) { }
                    try { if (TV.api.refreshFavorites) TV.api.refreshFavorites(); } catch (e) { }
                }, 800);
            }
        });
        TV.started = true;
    }

    function start() {
        if (param('tv') === '1') TV.store.set('force_tv_mode', '1');
        var bootEl = document.getElementById('tv-boot');
        TV.api.init().then(null, function () { }).then(function () {
            return TV.api.authCheck();
        }).then(function (info) {
            if (bootEl && bootEl.parentNode) bootEl.parentNode.removeChild(bootEl);
            if (info && info.need) startLogin(info); else startHome();
        }, function (e) {
            // 检查登录本身失败(很少见):有令牌就先进,没有就出登录页
            if (bootEl && bootEl.parentNode) bootEl.parentNode.removeChild(bootEl);
            if (TV.api.token()) startHome(); else startLogin({ qrLogin: true });
            TV.log('authCheck failed', e);
        });
    }
    TV.on(window, 'tv:logout', function () {
        TV.toast('登录已失效,请重新登录', 3500);
        TV.api.authCheck().then(function (info) {
            TV.reset('login', { qr: !!(info && info.qrLogin), v2b: !(info && info.v2board === false), onDone: function () { TV.reset('home'); } });
        }, function () { TV.reset('login', { qr: true, onDone: function () { TV.reset('home'); } }); });
    });

    try { start(); } catch (e) { if (window.__tvBootErr) window.__tvBootErr(e && e.message); }
})();
