/* E视界 电视版 · 详情页
 * 左海报,右:片名 / 信息 / 简介 / 一排按钮【▶ 继续 第8集 12:30】【♡ 追剧】【线路:量子 · 1080P ›】
 * 下面选集:集数多时上面一排区间(1-30 / 31-60 …,焦点移到哪块就显示哪块),下面集数格;数字键直接输集号。
 * 返回:焦点在选集里 → 先回到按钮行;在按钮行 → 离开。
 * params(任选其一):
 *   { work }                          搜索结果点进来,线路都在
 *   { title, year, poster, original, media }   首页 / 热门卡片:先按片名找片源
 *   { hist, autoplay }                继续观看:用历史里的线路,autoplay = 直接开播
 *   { fav }                           追剧:按收藏里的线路 / 片名
 */
(function () {
    'use strict';
    var TV = window.TV;

    TV.screen('detail', function (params) {
        var el = TV.el(
            '<div class="dt">' +
            '<div class="dt-bg"></div>' +
            '<div class="dt-wrap sy">' +
            '  <div class="dt-top">' +
            '    <div class="dt-poster"><img alt=""><div class="ph"></div></div>' +
            '    <div class="dt-info">' +
            '      <div class="dt-title"></div><div class="dt-meta"></div><div class="dt-desc"></div>' +
            '      <div class="dt-btns" data-fg="btns"></div>' +
            '      <div class="dt-state"></div>' +
            '    </div>' +
            '  </div>' +
            '  <div class="dt-eps"></div>' +
            '</div></div>');
        var titleEl = TV.$('.dt-title', el), metaEl = TV.$('.dt-meta', el), descEl = TV.$('.dt-desc', el);
        var btnsEl = TV.$('.dt-btns', el), stateEl = TV.$('.dt-state', el), epsEl = TV.$('.dt-eps', el);
        var posterImg = TV.$('.dt-poster img', el), posterPh = TV.$('.dt-poster .ph', el), bgEl = TV.$('.dt-bg', el);

        var work = null, lineIdx = 0, epIdx = 0, eps = [], tester = null, dead = false, lineChosenByUser = false;
        var rangeSize = 30, rangeIdx = 0, digitBuf = '', digitT = 0, epsSeq = 0;

        // ---------- 头部 ----------
        function paintHead(t, poster, meta, desc) {
            titleEl.textContent = t || '';
            if (poster && posterImg.getAttribute('data-p') !== poster) {
                posterImg.setAttribute('data-p', poster);
                posterImg.className = '';
                posterImg.onload = function () { posterImg.className = 'ld'; };
                posterImg.src = poster;
                bgEl.style.backgroundImage = 'url("' + poster.replace(/"/g, '%22') + '")';
            }
            posterPh.textContent = (t || '').slice(0, 8);
            if (meta != null) metaEl.textContent = meta;
            if (desc != null) descEl.textContent = desc;
        }
        function metaOf(w) {
            var a = [];
            if (w.year) a.push(w.year);
            if (w.area) a.push(w.area);
            if (w.type) a.push(w.type);
            if (w.remarks) a.push(w.remarks);
            if (w.label) a.push(w.label);
            return a.join(' · ');
        }
        function cleanDesc(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, ''); }

        // ---------- 按钮行 ----------
        function curLine() { return work && work.lines[lineIdx]; }
        function playLabel() {
            var lw = work ? TV.api.lastWatch(work) : null;
            var line = curLine();
            var multi = eps.length > 1;
            if (lw && lw.time > 5) {
                var i = line ? TV.api.matchEp(line, lw.epName, -1) : -1;
                if (i >= 0 || !multi) return '▶ 继续 ' + (multi && eps[i] ? eps[i].name + ' ' : '') + TV.fmtTime(lw.time);
            }
            if (lw && lw.epName && multi) {
                var j = TV.api.matchEp(line, lw.epName, -1);
                if (j >= 0) return '▶ 继续 ' + eps[j].name;
            }
            return '▶ 播放' + (multi && eps[0] ? ' ' + eps[0].name : '');
        }
        function lineLabel() {
            var l = curLine();
            if (!l) return '线路';
            var bits = [l.name];
            if (l.res) bits.push(l.res);
            if (l.tag) bits.push(l.tag);
            return '线路:' + bits.join(' · ') + (work.lines.length > 1 ? '  ›' : '');
        }
        function paintBtns() {
            if (!work) { btnsEl.innerHTML = ''; return; }
            var focusAct = TV.focused() && btnsEl.contains(TV.focused()) ? TV.focused().getAttribute('data-act') : '';
            var fav = TV.api.isFav(work);
            btnsEl.innerHTML =
                '<div class="btn pri f" data-act="play" data-first>' + TV.esc(playLabel()) + '</div>' +
                '<div class="btn f' + (fav ? ' on' : '') + '" data-act="fav">' + (fav ? '♥ 已追剧' : '♡ 追剧') + '</div>' +
                '<div class="btn f" data-act="lines">' + TV.esc(lineLabel()) + '</div>' +
                (work.lines.length ? '' : '');
            if (focusAct) { var b = TV.$('[data-act="' + focusAct + '"]', btnsEl); if (b) TV.focus(b, { noScroll: true }); }
        }
        TV.on(btnsEl, 'tvok', function (e) {
            var act = e.target.getAttribute('data-act');
            if (act === 'play') playResume();
            else if (act === 'fav') {
                TV.api.toggleFav(work).then(function (on) { TV.toast(on ? '已加入追剧,有更新会出现在首页「我的追剧」' : '已取消追剧'); paintBtns(); }, function () { TV.toast('操作失败,稍后再试'); });
            } else if (act === 'lines') openLines();
        });

        // ---------- 选集 ----------
        function paintEps() {
            var my = ++epsSeq;
            var line = curLine();
            if (!line) { epsEl.innerHTML = ''; return; }
            epsEl.innerHTML = '<div class="dt-eps-t">选集</div>' + TV.ui.loading('正在读取集数');
            TV.api.loadEps(line).then(function (list) {
                if (my !== epsSeq || dead) return;
                eps = list || [];
                if (epIdx >= eps.length) epIdx = 0;
                drawEps();
                paintBtns();
            }, function () {
                if (my !== epsSeq || dead) return;
                eps = [];
                epsEl.innerHTML = '<div class="dt-eps-t">选集</div><div class="empty">这条线路读不到集数,换一条线路试试</div>';
                paintBtns();
            });
        }
        function drawEps() {
            if (eps.length <= 1) { epsEl.innerHTML = ''; return; }
            var n = eps.length;
            rangeSize = n <= 40 ? n : n <= 300 ? 30 : n <= 600 ? 60 : 120;
            var longNames = eps.some(function (e) { return String(e.name).length > 6; });
            var cur = currentEpGuess();
            rangeIdx = Math.floor(Math.max(0, cur) / rangeSize);
            var h = '<div class="dt-eps-t">选集 <span class="dim">共 ' + n + ' 集 · 遥控器数字键可直接输集号</span></div>';
            if (n > rangeSize) {
                h += '<div class="chips sx dt-ranges" data-fg="ranges">';
                for (var r = 0; r * rangeSize < n; r++) {
                    var a = r * rangeSize + 1, b = Math.min(n, (r + 1) * rangeSize);
                    h += '<div class="chip f' + (r === rangeIdx ? ' on' : '') + '" data-r="' + r + '">' + a + '-' + b + '</div>';
                }
                h += '</div>';
            }
            h += '<div class="dt-grid' + (longNames ? ' long' : '') + '" data-fg="eps" data-enter="first"></div>';
            epsEl.innerHTML = h;
            drawRange();
        }
        function drawRange() {
            var grid = TV.$('.dt-grid', epsEl);
            if (!grid) return;
            var cur = currentEpGuess();
            var a = rangeIdx * rangeSize, b = Math.min(eps.length, a + rangeSize), h = '';
            for (var i = a; i < b; i++) {
                var nm = String(eps[i].name || ('第' + (i + 1) + '集'));
                var short = nm.replace(/^第0*(\d+)[集话期]$/, '$1');
                h += '<div class="ep f' + (i === cur ? ' on' : '') + '" data-ep="' + i + '">' + TV.esc(short) + '</div>';
            }
            grid.innerHTML = h;
            TV.each(TV.$$('.dt-ranges .chip', epsEl), function (c) { c.classList.toggle('on', +c.getAttribute('data-r') === rangeIdx); });
        }
        function currentEpGuess() {
            var lw = work ? TV.api.lastWatch(work) : null;
            if (lw && lw.epName && curLine()) { var i = TV.api.matchEp(curLine(), lw.epName, -1); if (i >= 0) return i; }
            return -1;
        }
        TV.on(epsEl, 'tvfocus', function (e) {
            var r = e.target.getAttribute('data-r');
            if (r != null && +r !== rangeIdx) { rangeIdx = +r; drawRange(); }
        });
        TV.on(epsEl, 'tvok', function (e) {
            var i = e.target.getAttribute('data-ep');
            if (i != null) { playEp(+i, true); return; }
            var r = e.target.getAttribute('data-r');
            if (r != null) { var g = TV.$('.dt-grid .ep', epsEl); if (g) TV.focus(g); }
        });

        // ---------- 线路面板(右侧) ----------
        function openLines() {
            if (!work || !work.lines.length) return;
            var p = TV.el('<div class="lp"><div class="lp-box"><div class="lp-t">选择线路 <span class="dim">共 ' + work.lines.length + ' 条</span></div><div class="lp-l sy"></div></div></div>');
            var list = TV.$('.lp-l', p);
            function row(l, i) {
                var sp = l.latency >= 9000 ? '<span class="lp-bad">连不上</span>' : l.test ? '<span class="lp-ms">' + (l.test === 'server' ? '可能放不了' : l.latency + 'ms') + '</span>' : '<span class="lp-ms dim">测速中</span>';
                return '<div class="lp-i f' + (i === lineIdx ? ' on' : '') + '" data-l="' + i + '"><div class="lp-n">' + TV.esc(l.name) +
                    (l.tag ? '<span class="tg ' + (l.tagCls || '') + '">' + TV.esc(l.tag) + '</span>' : '') + (l.res ? '<span class="tg">' + TV.esc(l.res) + '</span>' : '') +
                    '</div>' + sp + (i === lineIdx ? '<span class="lp-ck">正在用</span>' : '') + '</div>';
            }
            function fill() {
                var h = '';
                TV.each(work.lines, function (l, i) { h += row(l, i); });
                var f = TV.focused(), fi = f && list.contains(f) ? f.getAttribute('data-l') : null;
                list.innerHTML = h;
                if (fi != null) { var x = TV.$('[data-l="' + fi + '"]', list); if (x) TV.focus(x, { noScroll: true }); }
            }
            fill();
            var L = TV.layer(p, { onClose: function () { clearInterval(t); } });
            var t = setInterval(fill, 1500);     // 测速结果陆续回来,面板跟着刷新
            var on = TV.$('.lp-i.on', list);
            if (on) TV.focus(on);
            TV.on(p, 'tvok', function (e) {
                var x = e.target.closest ? e.target.closest('.lp-i') : e.target;
                if (!x) return;
                var i = +x.getAttribute('data-l');
                L.close();
                if (i !== lineIdx) { lineChosenByUser = true; switchLine(i); }
            });
        }
        function switchLine(i) {
            var oldEpName = eps[epIdx] ? eps[epIdx].name : '';
            lineIdx = i;
            var line = curLine();
            paintBtns();
            epsEl.innerHTML = TV.ui.loading('正在读取集数');
            TV.api.loadEps(line).then(function (list) {
                if (dead) return;
                eps = list || [];
                epIdx = Math.max(0, TV.api.matchEp(line, oldEpName, 0));
                drawEps();
                paintBtns();
            }, function () { eps = []; drawEps(); paintBtns(); });
        }

        // ---------- 播放 ----------
        function playEp(i, fromGrid) {
            if (!work) return;
            var line = curLine();
            if (!line) { TV.toast('没有可用的线路'); return; }
            if (!eps.length) { TV.toast('这条线路读不到集数,换一条试试'); openLines(); return; }
            epIdx = Math.max(0, Math.min(eps.length - 1, i));
            var at = TV.api.getResume(work, eps[epIdx].name);
            TV.go('player', { work: work, line: lineIdx, ep: epIdx, at: at });
        }
        function playResume() {
            if (!work) return;
            if (!eps.length && curLine()) {
                // 集数还没读完:读完马上播
                TV.api.loadEps(curLine()).then(function (list) { eps = list || []; if (eps.length) playResume(); else { TV.toast('这条线路读不到集数,换一条试试'); openLines(); } });
                return;
            }
            var lw = TV.api.lastWatch(work), i = 0;
            if (lw && lw.epName) { i = TV.api.matchEp(curLine(), lw.epName, 0); if (i < 0) i = 0; }
            playEp(i);
        }

        // ---------- 数据 ----------
        function setWork(w) {
            work = w;
            if (!work.lines.length) { stateEl.innerHTML = '<div class="dt-warn">这部片子暂时没有能播的线路</div>'; return; }
            TV.api.orderLines(work);
            // 起始线路:历史里上次用的 > 测速最好的(先按顺序第一条,测完再换,除非用户自己选过)
            var lw = TV.api.lastWatch(work);
            lineIdx = 0;
            if (lw && lw.lineKey) TV.each(work.lines, function (l, i) { if (l.key === lw.lineKey) lineIdx = i; });
            var fromHistory = !!(lw && lw.lineKey && work.lines[lineIdx] && work.lines[lineIdx].key === lw.lineKey);
            paintHead(work.title, work.poster || params.poster, metaOf(work), cleanDesc(work.desc) || descEl.textContent);
            stateEl.innerHTML = '';
            paintBtns();
            paintEps();
            if (!TV.focused() || !el.contains(TV.focused())) TV.focusFirst(btnsEl);
            // 测速(和网页版共用测速缓存);没用过的片子测完换到最好的线路
            var picked = fromHistory;
            tester = TV.api.testLines(work, function () {
                if (dead) return;
                if (!picked && !lineChosenByUser) {
                    var b = TV.api.bestLine(work);
                    if (b >= 0 && b !== lineIdx && work.lines[b].latency < 9000) { switchLine(b); }
                }
                paintBtns();
            });
            setTimeout(function () { picked = true; }, 3500);   // 3.5 秒后不再自动换线路,免得用户正要按 OK 时按钮变了
            if (params.autoplay) { params.autoplay = false; playResume(); }
        }
        function notFound(title) {
            stateEl.innerHTML = '<div class="dt-warn">没找到「' + TV.esc(title) + '」的片源</div>';
            btnsEl.innerHTML = '<div class="btn pri f" data-act="research" data-first>换个名字搜</div><div class="btn f" data-act="back">返回</div>';
            TV.focusFirst(btnsEl);
        }
        TV.on(btnsEl, 'tvok', function (e) {
            var act = e.target.getAttribute('data-act');
            if (act === 'research') TV.go('search', { q: titleEl.textContent.replace(/\s*第.+季$/, '') }, { replace: true });
            else if (act === 'back') TV.back();
        });

        function load() {
            if (params.work) { setWork(params.work); return; }
            if (params.hist) {
                var w = TV.api.workFromHistory(params.hist);
                if (w && w.lines.length) { setWork(w); return; }
                params.title = params.hist.name;
            }
            var t = params.title || (params.fav && (params.fav.data && params.fav.data.name)) || '';
            if (params.fav && params.fav.data) {
                var fw = TV.api.workFromFav ? TV.api.workFromFav(params.fav) : null;
                if (fw && fw.lines.length) { setWork(fw); return; }
            }
            paintHead(t, params.poster, params.year ? String(params.year) : '', '');
            stateEl.innerHTML = TV.ui.loading('正在各个资源站里找「' + t + '」');
            btnsEl.innerHTML = '<div class="btn f" data-act="back" data-first>返回</div>';
            TV.focusFirst(btnsEl);
            TV.api.findWork(t, { year: params.year, original: params.original, media: params.media }).then(function (w) {
                if (dead) return;
                if (!w) { notFound(t); return; }
                if (!w.poster && params.poster) w.poster = params.poster;
                TV.focus(null);
                setWork(w);
                TV.focusFirst(btnsEl);
            }, function () { if (!dead) notFound(t); });
        }
        load();

        // 数字键:输集号,停 1 秒跳过去
        function digit(d) {
            if (eps.length <= 1) return false;
            digitBuf = (digitBuf + d).slice(-4);
            TV.toast('跳到第 ' + digitBuf + ' 集', 1200);
            clearTimeout(digitT);
            digitT = setTimeout(function () {
                var n = parseInt(digitBuf, 10); digitBuf = '';
                if (!(n >= 1) || n > eps.length) { TV.toast('没有第 ' + n + ' 集'); return; }
                rangeIdx = Math.floor((n - 1) / rangeSize);
                drawRange();
                var x = TV.$('.dt-grid .ep[data-ep="' + (n - 1) + '"]', epsEl);
                if (x) TV.focus(x);
            }, 1000);
            return true;
        }

        return {
            el: el,
            onKey: function (k) {
                if (/^d\d$/.test(k.name)) return digit(k.name.slice(1));
                return false;
            },
            onBack: function () {
                var f = TV.focused();
                if (f && epsEl.contains(f)) { var b = TV.$('[data-act="play"]', btnsEl); if (b) { TV.focus(b); var w = TV.$('.dt-wrap', el); if (w) w.scrollTop = 0; return true; } }
                return false;
            },
            onShow: function (back) {
                if (back && work) {
                    // 从播放器回来:进度、当前集都可能变了
                    paintBtns();
                    if (eps.length > 1) drawRange();
                    var b = TV.$('[data-act="play"]', btnsEl);
                    if (b) TV.focus(b, { noScroll: true });
                }
            },
            destroy: function () { dead = true; clearTimeout(digitT); if (tester && tester.cancel) tester.cancel(); }
        };
    });
})();
