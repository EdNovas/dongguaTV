/* E视界 电视版 · 播放器(画面 + 按键;地址怎么来、去广告、出错换线在 TV.play,见 play.js)
 * 遥控器:
 *   OK 暂停 / 继续 · ←→ 快退 / 快进:连按或按住会累加,越久越快(10 秒 → 30 秒 → 60 秒),屏幕上先显示目标时间,松手 0.6 秒后才真跳
 *   ↓ 控制栏【上一集】【下一集】【选集】【线路】【倍速】【片头】,焦点在哪个就在下面显示它的内容 · 菜单键 直接到选集
 *   ↑ 看片名 / 进度 / 时间 · 频道键 / 上下一曲键 = 上 / 下一集
 *   返回:先取消快进预览 / 收起控制栏,再按退出播放(回到详情页)
 * params: { work, line(线路下标), ep(集下标), at(从第几秒开始) }
 */
(function () {
    'use strict';
    var TV = window.TV;
    var SPEEDS = [0.75, 1, 1.25, 1.5, 2];

    TV.screen('player', function (params) {
        var work = params.work;
        var lineIdx = params.line || 0, epIdx = params.ep || 0;
        var el = TV.el(
            '<div class="ply">' +
            '<video class="ply-v" preload="auto" playsinline webkit-playsinline x5-playsinline></video>' +
            '<div class="ply-wait"><span class="spin"></span><span class="ply-wait-t">正在连接</span></div>' +
            '<div class="ply-top"><div class="ply-ttl"></div><div class="ply-clock"></div></div>' +
            '<div class="ply-bot">' +
            '  <div class="ply-seek"><span class="ply-cur">0:00</span><div class="ply-bar"><i class="ply-buf"></i><i class="ply-pos"></i><b class="ply-dot"></b></div><span class="ply-dur">--:--</span></div>' +
            '  <div class="ply-hint">OK 暂停 · ←→ 快退快进(按住更快)· ↓ 选集 / 线路 / 倍速 · 返回 退出</div>' +
            '</div>' +
            '<div class="ply-jump"></div>' +
            '<div class="ply-big"></div>' +
            '<div class="ply-msg"></div>' +
            '</div>');
        var v = TV.$('.ply-v', el), waitEl = TV.$('.ply-wait', el), waitT = TV.$('.ply-wait-t', el);
        var msgEl = TV.$('.ply-msg', el), bigEl = TV.$('.ply-big', el), jumpEl = TV.$('.ply-jump', el);
        var curEl = TV.$('.ply-cur', el), durEl = TV.$('.ply-dur', el), posEl = TV.$('.ply-pos', el), bufEl = TV.$('.ply-buf', el), dotEl = TV.$('.ply-dot', el);
        var ttlEl = TV.$('.ply-ttl', el), clockEl = TV.$('.ply-clock', el);
        var session = null, panel = null, nextCard = null;
        var osdT = 0, seekTarget = -1, seekT = 0, seekSeqAt = 0, seekLastAt = 0, saveT = 0, clockT = 0, msgT = 0, nextT = 0;
        var destroyed = false, rate = 1, started = false;

        function line() { return work.lines[lineIdx]; }
        function eps() { var l = line(); return (l && l.eps) || []; }
        function title() { var e = eps()[epIdx]; return work.title + (eps().length > 1 && e ? '  ' + e.name : ''); }
        function showOsd(ms) {
            el.classList.add('osd');
            clearTimeout(osdT);
            if (!panel && (!v.paused || ms)) osdT = setTimeout(function () { if (!panel && !v.paused && seekTarget < 0) el.classList.remove('osd'); }, ms || 4000);
        }
        function hideOsd() { clearTimeout(osdT); el.classList.remove('osd'); }
        function msg(t, ms) { msgEl.textContent = t; msgEl.classList.add('show'); clearTimeout(msgT); msgT = setTimeout(function () { msgEl.classList.remove('show'); }, ms || 2600); }
        function big(icon) { bigEl.textContent = icon; bigEl.classList.add('show'); setTimeout(function () { bigEl.classList.remove('show'); }, 600); }
        function tick() {
            var d = v.duration, c = seekTarget >= 0 ? seekTarget : v.currentTime;
            var ok = isFinite(d) && d > 0;
            durEl.textContent = ok ? TV.fmtTime(d) : '--:--';
            curEl.textContent = TV.fmtTime(c);
            var p = ok ? Math.max(0, Math.min(1, c / d)) : 0;
            posEl.style.width = (p * 100) + '%';
            dotEl.style.left = (p * 100) + '%';
            try { if (ok && v.buffered.length) bufEl.style.width = Math.min(100, v.buffered.end(v.buffered.length - 1) / d * 100) + '%'; } catch (e) { }
        }
        function clock() { var d = new Date(); clockEl.textContent = TV.pad2(d.getHours()) + ':' + TV.pad2(d.getMinutes()); }

        // ---------- 开播 ----------
        function start(at) {
            if (session) { session.destroy(); session = null; }
            started = false;
            closeNext();
            ttlEl.textContent = title();
            waitEl.style.display = ''; waitT.textContent = '正在连接';
            session = TV.play.open(v, {
                work: work, line: line(), lineIdx: lineIdx, ep: epIdx, at: at || 0,
                onStatus: function (t) { if (!destroyed) waitT.textContent = t; },
                onSwitchLine: function (idx, why, newEp) {
                    if (destroyed) return;
                    lineIdx = idx;
                    if (newEp >= 0) epIdx = newEp;          // 同一集在别的线路上下标可能不一样
                    ttlEl.textContent = title();
                    msg(why || ('换到线路「' + line().name + '」'), 4000);
                },
                onStarted: function () { if (destroyed) return; started = true; waitEl.style.display = 'none'; },
                onFail: function (why) { if (destroyed) return; waitEl.style.display = 'none'; failBox(why); },
                onSkip: function (info) { if (!destroyed && info && info.text) msg(info.text, info.done ? 2600 : 4000); }
            });
            try { TV.api.markWatching(work, lineIdx, epIdx); } catch (e) { }
        }
        function failBox(why) {
            var items = [];
            TV.each(work.lines, function (l, i) { if (i !== lineIdx) items.push({ label: '换线路:' + l.name, sub: [l.tag, l.res].filter(Boolean).join(' · '), line: i }); });
            items.unshift({ label: '重试这条线路', retry: true });
            items.push({ label: '退出播放', quit: true });
            TV.menu('播放失败' + (why ? ':' + why : ''), items, function (it) {
                if (it.quit) TV.back();
                else if (it.retry) start((session && session.time && session.time()) || v.currentTime || params.at || 0);
                else switchLine(it.line);
            }, { wide: true });
        }
        function switchLine(i) {
            var oldName = eps()[epIdx] ? eps()[epIdx].name : '';
            var at = v.currentTime || 0;
            save(false);
            lineIdx = i;
            waitEl.style.display = ''; waitT.textContent = '正在切换线路';
            TV.api.loadEps(line()).then(function (list) {
                if (destroyed) return;
                line().eps = list || line().eps;
                var j = TV.api.matchEp(line(), oldName, epIdx);
                epIdx = j >= 0 ? j : 0;
                start(at);
            }, function () { if (!destroyed) failBox('这条线路读不到集数'); });
        }

        TV.on(v, 'playing', function () { started = true; waitEl.style.display = 'none'; showOsd(2500); });
        TV.on(v, 'waiting', function () { if (started) { waitEl.style.display = ''; waitT.textContent = '缓冲中'; } });
        TV.on(v, 'pause', function () { if (!destroyed) showOsd(); });
        TV.on(v, 'timeupdate', function () { if (seekTarget < 0) tick(); if (!v.paused && v.readyState >= 3) waitEl.style.display = 'none'; });
        TV.on(v, 'durationchange', tick);
        TV.on(v, 'ended', function () { save(true); askNext(); });

        // ---------- 快进快退:按"这一串按了多久"加速(有的遥控器按住不连发,只能靠连按),松手 0.6 秒后才 seek ----------
        function seekBy(dir) {
            var d = v.duration;
            if (!(d > 0) || !isFinite(d)) return;
            var now = TV.now();
            if (seekTarget < 0 || now - seekLastAt > 900) { seekTarget = seekTarget < 0 ? v.currentTime : seekTarget; seekSeqAt = now; }
            seekLastAt = now;
            var held = now - seekSeqAt;
            var step = held < 1500 ? 10 : held < 4000 ? 30 : held < 8000 ? 60 : (d > 5400 ? 180 : 90);
            seekTarget = Math.max(0, Math.min(d - 3, seekTarget + dir * step));
            var delta = seekTarget - v.currentTime;
            jumpEl.innerHTML = '<b>' + (delta >= 0 ? '+' : '−') + TV.fmtTime(Math.abs(delta)) + '</b>  ' + TV.fmtTime(seekTarget) + ' / ' + TV.fmtTime(d);
            jumpEl.classList.add('show');
            el.classList.add('seeking');
            showOsd(6000);
            tick();
            clearTimeout(seekT);
            seekT = setTimeout(commitSeek, 650);
        }
        function cancelSeek() { clearTimeout(seekT); seekTarget = -1; el.classList.remove('seeking'); jumpEl.classList.remove('show'); tick(); }
        function commitSeek() {
            if (seekTarget < 0) return;
            var t = seekTarget;
            cancelSeek();
            if (session) session.seek(t); else v.currentTime = t;
            showOsd(2500);
        }
        function togglePlay() {
            if (seekTarget >= 0) { commitSeek(); return; }
            if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () { }); big('▶'); showOsd(2000); }
            else { v.pause(); big('❚❚'); showOsd(); }
        }

        // ---------- 换集 ----------
        function gotoEp(i, at) {
            if (i < 0 || i >= eps().length) return false;
            save(false);
            epIdx = i;
            start(at != null ? at : TV.api.getResume(work, eps()[i].name));
            return true;
        }
        function nextEp() {
            if (epIdx + 1 < eps().length) { msg('下一集:' + eps()[epIdx + 1].name); gotoEp(epIdx + 1, 0); return true; }
            msg('已经是最后一集了');
            return false;
        }
        function prevEp() {
            if (epIdx > 0) { msg('上一集:' + eps()[epIdx - 1].name); gotoEp(epIdx - 1, 0); return true; }
            msg('已经是第一集了');
            return false;
        }
        // 一集放完:5 秒倒计时卡片,OK 立刻播、返回取消
        function askNext() {
            if (epIdx + 1 >= eps().length) { msg('全部播完了', 5000); showOsd(8000); return; }
            var n = 5, nm = eps()[epIdx + 1].name;
            var card = TV.el('<div class="mnu"><div class="mnu-box cfm"><div class="mnu-t">即将播放 ' + TV.esc(nm) + '</div><div class="cfm-x nx-n">5 秒后自动播放</div>' +
                '<div class="cfm-b"><div class="btn pri f" data-first data-v="1">立即播放</div><div class="btn f" data-v="0">取消</div></div></div></div>');
            nextCard = TV.layer(card, { onClose: function () { clearInterval(nextT); nextCard = null; } });
            nextT = setInterval(function () {
                n--;
                var x = TV.$('.nx-n', card); if (x) x.textContent = n + ' 秒后自动播放';
                if (n <= 0) { clearInterval(nextT); if (nextCard) { nextCard.close(); setTimeout(nextEp, 0); } }
            }, 1000);
            TV.on(card, 'tvok', function (e) { var go = e.target.getAttribute('data-v') === '1'; if (nextCard) nextCard.close(); if (go) setTimeout(nextEp, 0); });
        }
        function closeNext() { clearInterval(nextT); if (nextCard) nextCard.close(); }

        // ---------- 控制栏(底部):上面一排按钮,下面是焦点所在按钮的内容 ----------
        function openPanel(focusWhat) {
            if (panel) return;
            var hasEps = eps().length > 1;
            var acts = [];
            if (hasEps) { acts.push(['prev', '⏮ 上一集']); acts.push(['next', '下一集 ⏭']); acts.push(['eps', '选集']); }
            if (work.lines.length > 1) acts.push(['lines', '线路']);
            acts.push(['speed', '倍速' + (rate !== 1 ? ' ' + rate + 'x' : '')]);
            acts.push(['skip', '片头片尾']);
            var h = '<div class="pnl"><div class="pnl-tabs" data-fg="ptabs">';
            TV.each(acts, function (a) { h += '<div class="pnl-tab f" data-t="' + a[0] + '">' + a[1] + '</div>'; });
            h += '</div><div class="pnl-body sx" data-fg="pbody"></div></div>';
            var p = TV.el(h), body = TV.$('.pnl-body', p), shown = '';
            function fill(t) {
                if (t === 'prev' || t === 'next') t = hasEps ? 'eps' : 'speed';
                if (t === shown) return;
                shown = t;
                var b = '';
                if (t === 'eps') TV.each(eps(), function (e, i) { b += '<div class="chip f' + (i === epIdx ? ' on' : '') + '" data-ep="' + i + '">' + TV.esc(e.name) + '</div>'; });
                else if (t === 'lines') TV.each(work.lines, function (l, i) {
                    b += '<div class="chip f' + (i === lineIdx ? ' on' : '') + '" data-line="' + i + '">' + TV.esc(l.name) +
                        (l.tag ? '<span class="tg ' + (l.tagCls || '') + '">' + TV.esc(l.tag) + '</span>' : '') + (l.res ? '<small>' + TV.esc(l.res) + '</small>' : '') + '</div>';
                });
                else if (t === 'speed') TV.each(SPEEDS, function (s) { b += '<div class="chip f' + (s === rate ? ' on' : '') + '" data-rate="' + s + '">' + (s === 1 ? '正常' : s + 'x') + '</div>'; });
                else if (t === 'skip') {
                    var on = TV.store.get('tv_skip_intro', true) !== false;
                    b += '<div class="chip f' + (on ? ' on' : '') + '" data-skip="1">自动跳过片头:' + (on ? '开' : '关') + '</div>';
                    b += '<div class="chip f" data-skipnow="1">快进 90 秒</div>';
                }
                body.innerHTML = b;
                body.scrollLeft = 0;
                var on0 = TV.$('.chip.on', body);
                if (on0) TV.reveal(on0);
            }
            el.classList.add('osd', 'pnl-on');
            clearTimeout(osdT);
            panel = TV.layer(p, { onClose: function () { panel = null; el.classList.remove('pnl-on'); showOsd(2500); } });
            panel.el.classList.add('pnl-l');
            var first = TV.$('[data-t="' + (focusWhat === 'eps' && hasEps ? 'eps' : hasEps ? 'next' : 'speed') + '"]', p) || TV.$('.pnl-tab', p);
            fill(first.getAttribute('data-t'));
            if (focusWhat === 'eps' && hasEps) { var c = TV.$('.chip.on', body) || TV.$('.chip', body); TV.focus(c || first); }
            else TV.focus(first);
            TV.on(p, 'tvfocus', function (e) { var t = e.target.getAttribute('data-t'); if (t) fill(t); });
            TV.on(p, 'tvok', function (e) {
                var x = e.target, t = x.getAttribute('data-t');
                if (t === 'prev') { panel.close(); prevEp(); return; }
                if (t === 'next') { panel.close(); nextEp(); return; }
                if (t) { var f = TV.$('.chip.on', body) || TV.$('.chip', body); if (f) TV.focus(f); return; }
                if (x.hasAttribute('data-ep')) { var ei = +x.getAttribute('data-ep'); panel.close(); if (ei !== epIdx) gotoEp(ei); return; }
                if (x.hasAttribute('data-line')) { var li = +x.getAttribute('data-line'); panel.close(); if (li !== lineIdx) switchLine(li); return; }
                if (x.hasAttribute('data-rate')) { rate = +x.getAttribute('data-rate'); v.playbackRate = rate; shown = ''; fill('speed'); TV.focus(TV.$('.chip.on', body)); msg('倍速 ' + (rate === 1 ? '正常' : rate + 'x')); return; }
                if (x.hasAttribute('data-skip')) { TV.store.set('tv_skip_intro', !(TV.store.get('tv_skip_intro', true) !== false)); shown = ''; fill('skip'); TV.focus(TV.$('.chip', body)); return; }
                if (x.hasAttribute('data-skipnow')) { panel.close(); var to = Math.min((v.duration || 1e9) - 3, v.currentTime + 90); if (session) session.seek(to); else v.currentTime = to; return; }
            });
        }

        // ---------- 历史 ----------
        function save(ended) {
            var d = v.duration;
            if (!d || !isFinite(d) || !started) return;
            try { TV.api.saveProgress(work, lineIdx, epIdx, ended ? d : v.currentTime, d); } catch (e) { TV.log('save', e); }
        }

        start(params.at || 0);
        clock();
        clockT = setInterval(clock, 15000);
        saveT = setInterval(function () { if (!v.paused) save(false); }, 15000);
        // 切到后台 / 关屏也存一下
        function onVis() { if (document.hidden) { save(false); try { TV.api.flushHistory(); } catch (e) { } } }
        TV.on(document, 'visibilitychange', onVis);

        return {
            el: el,
            onBack: function () {
                if (seekTarget >= 0) { cancelSeek(); return true; }
                if (el.classList.contains('osd') && !v.paused) { hideOsd(); return true; }
                return false;
            },
            onKey: function (k) {
                var n = k.name;
                if (n === 'ok' || n === 'playpause') { togglePlay(); return true; }
                if (n === 'play') { if (v.paused) togglePlay(); return true; }
                if (n === 'pause') { if (!v.paused) togglePlay(); return true; }
                if (n === 'left' || n === 'rew') { seekBy(-1); return true; }
                if (n === 'right' || n === 'ff') {
                    // 正处在片头 / 片尾提示的区间:第一下 ▶▶ = 跳过片头 / 下一集(提示里就是这么说的)
                    if (seekTarget < 0 && session && session.skipIntroNow) {
                        var r = session.skipIntroNow();
                        if (r === 'outro') { if (!nextEp()) seekBy(1); return true; }
                        if (r) { msg(r === 'bump' ? '已跳过开头的贴片' : '已跳过片头'); return true; }
                    }
                    seekBy(1);
                    return true;
                }
                if (n === 'down') { if (seekTarget >= 0) commitSeek(); openPanel(); return true; }
                if (n === 'menu') { openPanel('eps'); return true; }
                if (n === 'up') { showOsd(5000); return true; }
                if (n === 'next' || n === 'chdown') { nextEp(); return true; }
                if (n === 'prev' || n === 'chup') { prevEp(); return true; }
                return false;
            },
            onHide: function () { save(false); try { v.pause(); } catch (e) { } },
            destroy: function () {
                destroyed = true;
                save(false);
                document.removeEventListener('visibilitychange', onVis, false);
                clearInterval(clockT); clearInterval(saveT); clearTimeout(osdT); clearTimeout(seekT); clearTimeout(msgT); clearInterval(nextT);
                if (session) { session.destroy(); session = null; }
                try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { }
                try { TV.api.flushHistory(); } catch (e) { }
            }
        };
    });
})();
