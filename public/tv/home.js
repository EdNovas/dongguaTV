/* E视界 电视版 · 首页(顶栏标签 + 各个页面)
 * 顶栏:搜索 · 首页 · 电影 · 剧集 · 综艺 · 动漫 · 直播 · 我的 —— 焦点停在哪个标签就显示哪一页(和电视盒子的习惯一样),
 *   往下进入页面;页面里按返回先回到顶栏,在顶栏再按返回 = 退出提示。
 * 首页:继续观看 / 我的追剧 / 推荐的几排;分类页:一排筛选 + 海报墙(往下翻自动加载下一页)。
 */
(function () {
    'use strict';
    var TV = window.TV;
    var TABS = [
        { k: 'search', t: '搜索', ic: '⌕' },
        { k: 'home', t: '首页' },
        { k: 'movie', t: '电影' },
        { k: 'tv', t: '剧集' },
        { k: 'variety', t: '综艺' },
        { k: 'anime', t: '动漫' },
        { k: 'live', t: '直播' },
        { k: 'mine', t: '我的' }
    ];

    TV.screen('home', function (params) {
        var h = '<div class="hm"><div class="top"><div class="logo"><img src="/icon.png" alt=""><b>E</b>视界</div><div class="tabs" data-fg="tabs">';
        TV.each(TABS, function (t) {
            h += '<div class="tab f' + (t.k === 'home' ? ' on' : '') + '" data-tab="' + t.k + '">' + (t.ic ? '<span class="ic">' + t.ic + '</span>' : '') + t.t + '</div>';
        });
        h += '</div><div class="top-r"><span class="hm-user"></span><span class="hm-clock"></span></div></div><div class="body"></div></div>';
        var el = TV.el(h);
        var body = TV.$('.body', el), tabsEl = TV.$('.tabs', el), clockEl = TV.$('.hm-clock', el);
        var pages = {}, curTab = '', switchT = 0, clockT = 0;

        function clock() { var d = new Date(); clockEl.textContent = TV.pad2(d.getHours()) + ':' + TV.pad2(d.getMinutes()); }

        function show(k) {
            if (k === curTab || k === 'search') return;
            curTab = k;
            TV.each(TV.$$('.tab', tabsEl), function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === k); });
            for (var p in pages) if (pages.hasOwnProperty(p)) { pages[p].el.classList.remove('cur'); pages[p].el.style.display = 'none'; }
            if (!pages[k]) {
                pages[k] = PAGES[k] ? PAGES[k]() : { el: TV.el('<div class="pg">' + TV.ui.empty() + '</div>') };
                pages[k].el.classList.add('pg');
                pages[k].el.setAttribute('data-fg', 'pg-' + k);
                body.appendChild(pages[k].el);
            }
            pages[k].el.style.display = '';
            pages[k].el.classList.add('cur');
            if (pages[k].onShow) pages[k].onShow();
        }
        // 焦点在标签上停一会儿才切页(左右快速划过时不每个都加载)
        TV.on(tabsEl, 'tvfocus', function (e) {
            var k = e.target.getAttribute('data-tab');
            clearTimeout(switchT);
            if (k && k !== 'search') switchT = setTimeout(function () { show(k); }, 160);
        });
        TV.on(tabsEl, 'tvok', function (e) {
            var k = e.target.getAttribute('data-tab');
            if (k === 'search') { TV.go('search'); return; }
            clearTimeout(switchT);
            show(k);
            var p = pages[k];
            if (p) TV.focusFirst(p.el);
        });

        // ---------- 各页 ----------
        var PAGES = {
            home: function () {
                var pg = TV.el('<div class="pg sy" data-sy-top=".row">' + TV.ui.loading() + '</div>');
                var loaded = false, rowsBox = null, personalKey = '';
                function paintPersonal() {
                    // 继续观看 / 我的追剧:每次回到首页都重画(看完一集回来进度要更新)
                    var hist = TV.api.historyCards(20), favs = TV.api.favoriteCards(20);
                    var key = JSON.stringify([hist.length && hist[0].key, hist.length && hist[0].progress, favs.length]);
                    if (key === personalKey) return;
                    personalKey = key;
                    var box = TV.$('.hm-personal', pg);
                    if (!box) return;
                    var had = TV.focused() && box.contains(TV.focused());
                    box.innerHTML = '';
                    if (hist.length) box.appendChild(TV.ui.row('继续观看', hist, function (it) { TV.resume(it); }, { id: 'hist', hint: '按 OK 接着看' }));
                    if (favs.length) box.appendChild(TV.ui.row('我的追剧', favs, function (it) { TV.openItem(it); }, { id: 'fav' }));
                    if (had) TV.focusFirst(box);
                }
                function load() {
                    pg.innerHTML = '<div class="hm-personal"></div><div class="hm-rows"></div>';
                    rowsBox = TV.$('.hm-rows', pg);
                    personalKey = '';
                    paintPersonal();
                    TV.api.homeRows(function (row) {
                        // 每排拿到就画,不等全部
                        if (!row || !row.items || !row.items.length) return;
                        rowsBox.appendChild(TV.ui.row(row.title, row.items, function (it) { TV.openItem(it); }, { id: row.id }));
                    }).then(function () {
                        loaded = true;
                        if (!pg.querySelector('.card')) pg.innerHTML = TV.ui.empty('推荐没加载出来,按 OK 重试') ;
                    }, function () {
                        if (!pg.querySelector('.card')) { pg.innerHTML = '<div class="empty">推荐没加载出来<br><br><span class="btn f" data-retry>重试</span></div>'; }
                    });
                }
                TV.on(pg, 'tvok', function (e) { if (e.target.hasAttribute('data-retry')) load(); });
                load();
                return { el: pg, onShow: function () { if (loaded) paintPersonal(); } };
            },
            movie: function () { return catPage('movie'); },
            tv: function () { return catPage('tv'); },
            variety: function () { return catPage('variety'); },
            anime: function () { return catPage('anime'); },
            live: function () { return TV.livePage ? TV.livePage() : { el: TV.el('<div class="pg">' + TV.ui.empty('直播暂不可用') + '</div>') }; },
            mine: function () { return TV.minePage ? TV.minePage() : { el: TV.el('<div class="pg">' + TV.ui.empty() + '</div>') }; }
        };

        // 分类页:顶上一两排筛选(类型 / 地区 / 排序),下面海报墙
        function catPage(cat) {
            var pg = TV.el('<div class="pg sy"><div class="cat-f"></div><div class="cat-w"></div></div>');
            var fBox = TV.$('.cat-f', pg), wBox = TV.$('.cat-w', pg);
            var defs = TV.api.catFilters(cat);           // [{ k, label, opts: [{ v, t }] }]
            var sel = {};
            var page = 0, more = true, busy = false, seq = 0;
            var wall = TV.ui.wall(function (it) { TV.openItem(it); }, { onNearEnd: function () { next(); } });
            wBox.appendChild(wall);
            function paintFilters() {
                var h = '';
                TV.each(defs, function (d) {
                    h += '<div class="chips sx" data-fg="f-' + d.k + '"><span class="cat-fl">' + TV.esc(d.label) + '</span>';
                    TV.each(d.opts, function (o, i) {
                        var on = (sel[d.k] == null ? i === 0 : sel[d.k] === o.v);
                        h += '<div class="chip f' + (on ? ' on' : '') + '" data-fk="' + d.k + '" data-fv="' + TV.esc(o.v) + '">' + TV.esc(o.t) + '</div>';
                    });
                    h += '</div>';
                });
                fBox.innerHTML = h;
            }
            function reset() {
                seq++; page = 0; more = true; busy = false;
                wall.clear();
                wBox.querySelector('.wall-end') && wBox.removeChild(wBox.querySelector('.wall-end'));
                next();
            }
            function next() {
                if (busy || !more) return;
                busy = true;
                var my = seq;
                var end = TV.$('.wall-end', wBox);
                if (!end) { end = TV.el('<div class="wall-end"></div>'); wBox.appendChild(end); }
                end.innerHTML = '<span class="spin"></span>加载中';
                TV.api.browse(cat, sel, page + 1).then(function (r) {
                    if (my !== seq) return;
                    busy = false;
                    page++;
                    more = !!r.more && r.items.length > 0;
                    if (r.items.length) wall.add(r.items);
                    end.innerHTML = more ? '' : (wall._items.length ? '没有更多了' : '这个筛选下没有内容');
                }, function () {
                    if (my !== seq) return;
                    busy = false;
                    end.innerHTML = '加载失败,往下移一下重试';
                });
            }
            TV.on(fBox, 'tvok', function (e) {
                var k = e.target.getAttribute('data-fk');
                if (!k) return;
                sel[k] = e.target.getAttribute('data-fv');
                TV.each(TV.$$('.chip[data-fk="' + k + '"]', fBox), function (c) { c.classList.toggle('on', c === e.target); });
                reset();
            });
            paintFilters();
            next();
            return { el: pg };
        }

        show('home');
        clock();
        clockT = setInterval(clock, 15000);
        TV.on(window, 'tv:user', function () { var u = TV.$('.hm-user', el); if (u) u.textContent = TV.api.userLabel(); });

        return {
            el: el,
            onShow: function (back) {
                var p = pages[curTab];
                if (back && p && p.onShow) p.onShow();
                var u = TV.$('.hm-user', el); if (u) u.textContent = TV.api.userLabel();
            },
            // 返回:焦点不在顶栏 → 回到顶栏当前标签,页面滚回顶;已经在顶栏 → 交给退出提示
            onBack: function () {
                var f = TV.focused();
                if (f && tabsEl.contains(f)) {
                    if (curTab !== 'home') { var hm = TV.$('.tab[data-tab="home"]', tabsEl); TV.focus(hm); show('home'); return true; }
                    return false;
                }
                var on = TV.$('.tab.on', tabsEl);
                TV.focus(on || TV.$('.tab', tabsEl));
                var p = pages[curTab];
                if (p && p.el.classList.contains('sy')) p.el.scrollTop = 0;
                return true;
            },
            destroy: function () { clearInterval(clockT); }
        };
    });
})();
