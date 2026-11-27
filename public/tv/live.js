/* E视界 电视版 · 直播
 * 首页「直播」标签:一排分组(最近看过 / 央视 / 卫视 …)+ 频道墙,OK 开播。
 * 直播播放(按机顶盒的习惯):↑↓ 换台 · ←→ 换这个台的其它线路 · OK 频道列表 · 数字键输台号 · 返回先关列表再退出
 */
(function () {
    'use strict';
    var TV = window.TV;

    function chCard(ch, i) {
        return '<div class="lc f" data-i="' + i + '"><div class="lc-logo">' + (ch.logo ? '<img data-src="' + TV.esc(ch.logo) + '" alt="">' : '') +
            '<span class="lc-ph">' + TV.esc(ch.name.slice(0, 6)) + '</span></div><div class="lc-n">' + TV.esc(ch.name) + '</div></div>';
    }

    // ---------- 首页里的直播页 ----------
    TV.livePage = function () {
        var pg = TV.el('<div class="pg sy"><div class="lv-g chips sx" data-fg="lvg"></div><div class="lv-w" data-fg="lvw"></div></div>');
        var gBox = TV.$('.lv-g', pg), wBox = TV.$('.lv-w', pg);
        var data = null, group = '', list = [];
        function groupsOf() {
            var g = [];
            if (TV.api.liveRecent().length) g.push('最近看过');
            TV.each(data.groups, function (x) { if (g.indexOf(x) < 0) g.push(x); });
            return g;
        }
        function channelsOf(g) {
            if (g === '最近看过') return TV.api.liveRecent();
            return data.channels.filter(function (c) { return c.group === g; });
        }
        function paintGroups() {
            var h = '';
            TV.each(groupsOf(), function (g) { h += '<div class="chip f' + (g === group ? ' on' : '') + '" data-g="' + TV.esc(g) + '">' + TV.esc(g) + '</div>'; });
            gBox.innerHTML = h;
        }
        function paintList() {
            list = channelsOf(group);
            var h = '';
            TV.each(list.slice(0, 300), function (c, i) { h += chCard(c, i); });
            wBox.innerHTML = h || TV.ui.empty('这个分组没有频道');
            TV.lazy(wBox);
        }
        TV.on(gBox, 'tvfocus', function (e) {
            var g = e.target.getAttribute('data-g');
            if (g && g !== group) { group = g; TV.each(TV.$$('.chip', gBox), function (c) { c.classList.toggle('on', c === e.target); }); paintList(); }
        });
        TV.on(wBox, 'tvok', function (e) {
            var c = e.target.closest ? e.target.closest('.lc') : e.target;
            if (!c) return;
            var i = +c.getAttribute('data-i');
            TV.go('live', { list: list, idx: i, all: data.channels });
        });
        pg.innerHTML = '';
        pg.appendChild(gBox); pg.appendChild(wBox);
        wBox.innerHTML = TV.ui.loading('正在读取频道');
        TV.api.liveChannels().then(function (d) {
            data = d;
            if (!d || d.enabled === false || !d.channels.length) { wBox.innerHTML = TV.ui.empty('直播暂不可用'); return; }
            var gs = groupsOf();
            group = gs[0];
            paintGroups();
            paintList();
        }, function () { wBox.innerHTML = TV.ui.empty('频道读取失败,稍后再试'); });
        return {
            el: pg,
            onShow: function () { if (data && group === '最近看过') paintList(); }
        };
    };

    // ---------- 直播播放 ----------
    TV.screen('live', function (params) {
        var list = params.list || [], idx = params.idx || 0;
        var el = TV.el(
            '<div class="ply lvp">' +
            '<video class="ply-v" preload="auto" playsinline webkit-playsinline x5-playsinline></video>' +
            '<div class="ply-wait"><span class="spin"></span><span class="ply-wait-t">正在连接</span></div>' +
            '<div class="lvp-osd"><span class="lvp-no"></span><span class="lvp-name"></span><span class="lvp-src dim"></span></div>' +
            '<div class="lvp-num"></div>' +
            '<div class="ply-hint lvp-hint">↑↓ 换台 · ←→ 换线路 · OK 频道列表 · 数字键 输台号</div>' +
            '</div>');
        var v = TV.$('.ply-v', el), waitEl = TV.$('.ply-wait', el), waitT = TV.$('.ply-wait-t', el);
        var osd = TV.$('.lvp-osd', el), numEl = TV.$('.lvp-num', el);
        var session = null, osdT = 0, numBuf = '', numT = 0, listL = null, dead = false;

        function showOsd() {
            var ch = list[idx];
            TV.$('.lvp-no', el).textContent = (idx + 1);
            TV.$('.lvp-name', el).textContent = ch ? ch.name : '';
            osd.classList.add('show');
            el.classList.add('osd');
            clearTimeout(osdT);
            osdT = setTimeout(function () { osd.classList.remove('show'); el.classList.remove('osd'); }, 4000);
        }
        function tune(i) {
            if (!list.length) return;
            idx = (i + list.length) % list.length;
            if (session) { session.destroy(); session = null; }
            var ch = list[idx];
            showOsd();
            waitEl.style.display = ''; waitT.textContent = '正在连接 ' + ch.name;
            TV.$('.lvp-src', el).textContent = '';
            TV.api.addLiveRecent(ch);
            session = TV.play.openLive(v, ch, {
                onStatus: function (t) { waitT.textContent = t; },
                onSource: function (i, n) { TV.$('.lvp-src', el).textContent = n > 1 ? '线路 ' + (i + 1) + '/' + n : ''; showOsd(); },
                onStarted: function () { waitEl.style.display = 'none'; },
                onFail: function (why) { waitEl.style.display = ''; waitT.textContent = (why || '这个台现在放不了') + ',按 ↑↓ 换台'; }
            });
        }
        TV.on(v, 'playing', function () { waitEl.style.display = 'none'; });
        TV.on(v, 'waiting', function () { waitEl.style.display = ''; waitT.textContent = '缓冲中'; });

        // 频道列表:左分组右频道(只列当前这一组,够用)
        function openList() {
            var h = '<div class="lvl"><div class="lvl-box"><div class="lvl-t">频道列表</div><div class="lvl-l sy">';
            TV.each(list, function (c, i) { h += '<div class="lvl-i f' + (i === idx ? ' on' : '') + '" data-i="' + i + '"><span class="lvl-no">' + (i + 1) + '</span>' + TV.esc(c.name) + '</div>'; });
            h += '</div></div></div>';
            var p = TV.el(h);
            listL = TV.layer(p, { onClose: function () { listL = null; } });
            var on = TV.$('.lvl-i.on', p); if (on) TV.focus(on);
            TV.on(p, 'tvok', function (e) {
                var x = e.target.closest ? e.target.closest('.lvl-i') : e.target;
                if (!x) return;
                var i = +x.getAttribute('data-i');
                listL.close();
                if (i !== idx) tune(i);
            });
        }
        function digit(d) {
            numBuf = (numBuf + d).slice(-3);
            numEl.textContent = numBuf;
            numEl.classList.add('show');
            clearTimeout(numT);
            numT = setTimeout(function () {
                var n = parseInt(numBuf, 10);
                numBuf = ''; numEl.classList.remove('show');
                if (n >= 1 && n <= list.length) tune(n - 1); else TV.toast('没有 ' + n + ' 台');
            }, 1500);
        }

        tune(idx);
        return {
            el: el,
            onKey: function (k) {
                var n = k.name;
                if (n === 'up' || n === 'chup') { tune(idx - 1); return true; }
                if (n === 'down' || n === 'chdown') { tune(idx + 1); return true; }
                if (n === 'left' || n === 'right') { if (session && session.nextSource) session.nextSource(n === 'left' ? -1 : 1); return true; }
                if (n === 'ok' || n === 'menu') { openList(); return true; }
                if (/^d\d$/.test(n)) { digit(n.slice(1)); return true; }
                if (n === 'playpause') { if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () { }); } else v.pause(); return true; }
                return false;
            },
            onHide: function () { try { v.pause(); } catch (e) { } },
            onShow: function (back) { if (back) tune(idx); },
            destroy: function () {
                dead = true;
                clearTimeout(osdT); clearTimeout(numT);
                if (session) { session.destroy(); session = null; }
                try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { }
            }
        };
    });
})();
