/* E视界 电视版 · 搜索
 * 左边:拼音首字母键盘(庆余年 → QYN),也能按「输入法」用盒子自带的输入法打中文,接了实体键盘直接打字也行
 * 右边:没输入时 = 热门 + 搜过的;输入了 = 联想片名(/api/tv/suggest,首字母也认);选一个 = 搜线路,结果是海报墙
 * 返回键:结果页 → 回到联想;联想 → 退出搜索
 */
(function () {
    'use strict';
    var TV = window.TV;
    var KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'.split('');
    var HIST_KEY = 'tv_search_hist';

    TV.screen('search', function (params) {
        var el = TV.el(
            '<div class="srch">' +
            '<div class="srch-l">' +
            '  <div class="srch-in"><span class="srch-q"></span><span class="srch-ph">输入片名首字母,例如 庆余年 → QYN</span><span class="srch-caret"></span></div>' +
            '  <div class="kb" data-fg="kb"></div>' +
            '  <div class="kb-ops"><div class="btn f" data-op="clear">清空</div><div class="btn f" data-op="del">删除</div><div class="btn f" data-op="ime">输入法</div></div>' +
            '  <input class="srch-ime" type="text" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="用输入法打片名,按确定搜索">' +
            '</div>' +
            '<div class="srch-r sy"></div>' +
            '</div>');
        var kb = TV.$('.kb', el), right = TV.$('.srch-r', el), qEl = TV.$('.srch-q', el), phEl = TV.$('.srch-ph', el), ime = TV.$('.srch-ime', el);
        var q = '', sugSeq = 0, results = null, resultWall = null, searchSeq = 0;

        var kh = '';
        TV.each(KEYS, function (k, i) { kh += '<div class="key f" data-k="' + k + '"' + (i === 0 ? ' data-first' : '') + '>' + k + '</div>'; });
        kb.innerHTML = kh;

        function setQ(v) {
            q = v;
            qEl.textContent = q;
            phEl.style.display = q ? 'none' : '';
            results = null;
            if (!q) showHome(); else suggest();
        }
        TV.on(kb, 'tvok', function (e) { var k = e.target.getAttribute('data-k'); if (k && q.length < 24) setQ(q + k); });
        TV.on(TV.$('.kb-ops', el), 'tvok', function (e) {
            var op = e.target.getAttribute('data-op');
            if (op === 'clear') setQ('');
            else if (op === 'del') setQ(q.slice(0, -1));
            else if (op === 'ime') openIme();
        });

        // 盒子自带输入法:把真输入框露出来并聚焦,OK 键弹出输入法;回车 = 直接按这个词搜
        function openIme() {
            ime.style.display = 'block';
            ime.value = /^[A-Z0-9]*$/.test(q) ? '' : q;
            try { ime.focus(); ime.click(); } catch (e) { }
        }
        TV.on(ime, 'keydown', function (e) {
            if (e.keyCode === 13) { e.preventDefault(); var v = ime.value.replace(/^\s+|\s+$/g, ''); ime.blur(); if (v) runSearch(v); }
        });
        TV.on(ime, 'blur', function () { setTimeout(function () { ime.style.display = 'none'; var v = ime.value.replace(/^\s+|\s+$/g, ''); if (v && v !== q && !results) { q = v; qEl.textContent = q; phEl.style.display = 'none'; suggest(); } }, 0); });

        // ---------- 右侧:热门 / 历史 ----------
        function hist() { var h = TV.store.get(HIST_KEY, []); return h && h.length ? h : []; }
        function addHist(w) { var h = hist().filter(function (x) { return x !== w; }); h.unshift(w); TV.store.set(HIST_KEY, h.slice(0, 16)); }
        function listHtml(title, words, kind) {
            if (!words.length) return '';
            var h = '<div class="sl" data-fg="' + kind + '"><div class="sl-t">' + TV.esc(title) + '</div>';
            TV.each(words, function (w, i) {
                var label = typeof w === 'string' ? w : w.title;
                var sub = typeof w === 'string' ? '' : (w.year || w.sub || '');
                h += '<div class="sl-i f" data-w="' + TV.esc(label) + '"><span class="sl-n' + (i < 3 && kind === 'hot' ? ' top' : '') + '">' + (i + 1) + '</span>' + TV.esc(label) + (sub ? '<span class="dim"> ' + TV.esc(sub) + '</span>' : '') + '</div>';
            });
            return h + '</div>';
        }
        var hotCache = null;
        function showHome() {
            resultWall = null;
            var hs = hist();
            right.innerHTML = '<div class="srch-cols">' + '<div class="srch-col">' + (hotCache ? listHtml('热门搜索', hotCache, 'hot') : TV.ui.loading('热门加载中')) + '</div>' +
                '<div class="srch-col">' + (hs.length ? listHtml('搜过的', hs.slice(0, 10), 'hist') + '<div class="sl-i f sl-clr" data-op="clrhist">清空搜索记录</div>' : '') + '</div></div>';
            if (!hotCache) TV.api.hotWords().then(function (w) { hotCache = (w || []).slice(0, 10); if (!q && !results) showHome(); }, function () { hotCache = []; if (!q && !results) showHome(); });
        }
        function suggest() {
            var my = ++sugSeq, word = q;
            right.innerHTML = '<div class="sl"><div class="sl-t">「' + TV.esc(word) + '」</div>' +
                '<div class="sl-i f sl-go" data-w="' + TV.esc(word) + '">直接搜「' + TV.esc(word) + '」</div><div class="sug-wait">' + TV.ui.loading('联想中') + '</div></div>';
            TV.api.suggest(word).then(function (list) {
                if (my !== sugSeq || results) return;
                var wait = TV.$('.sug-wait', right);
                if (!wait) return;
                if (!list || !list.length) { wait.innerHTML = '<div class="sl-none">没有联想,可以「直接搜」,或者换几个字母</div>'; return; }
                var h = '';
                TV.each(list.slice(0, 12), function (s) {
                    h += '<div class="sl-i f" data-w="' + TV.esc(s.title) + '">' + TV.esc(s.title) + (s.year ? '<span class="dim"> ' + s.year + '</span>' : '') + (s.kind ? '<span class="sl-k">' + TV.esc(s.kind) + '</span>' : '') + '</div>';
                });
                wait.innerHTML = h;
            }, function () { if (my === sugSeq) { var w = TV.$('.sug-wait', right); if (w) w.innerHTML = '<div class="sl-none">联想暂时不可用,可以「直接搜」</div>'; } });
        }
        TV.on(right, 'tvok', function (e) {
            var t = e.target;
            if (t.getAttribute('data-op') === 'clrhist') { TV.store.del(HIST_KEY); showHome(); TV.focusFirst(kb); return; }
            var w = t.getAttribute('data-w');
            if (w) runSearch(w);
        });

        // ---------- 搜线路 ----------
        function runSearch(word) {
            var my = ++searchSeq;
            addHist(word);
            results = [];
            right.innerHTML = '<div class="sres-t">「' + TV.esc(word) + '」的结果</div>' + TV.ui.loading('正在各个资源站里找');
            resultWall = null;
            TV.api.searchWorks(word, function (partial) {
                // 流式:先到的站先画出来
                if (my !== searchSeq) return;
                paint(word, partial, false);
            }).then(function (works) {
                if (my !== searchSeq) return;
                paint(word, works, true);
            }, function (err) {
                if (my !== searchSeq) return;
                right.innerHTML = '<div class="sres-t">「' + TV.esc(word) + '」</div>' + TV.ui.empty(err && err.status === 401 ? '登录已失效,请重新登录' : '搜索失败了,检查一下网络再试');
            });
        }
        function paint(word, works, final) {
            results = works || [];
            var hadFocus = TV.focused() && right.contains(TV.focused());
            if (!results.length) {
                if (final) right.innerHTML = '<div class="sres-t">「' + TV.esc(word) + '」</div>' + TV.ui.empty('没找到,换个名字试试(比如去掉"第二季")');
                return;
            }
            if (!resultWall) {
                right.innerHTML = '<div class="sres-t">「' + TV.esc(word) + '」<span class="dim">' + (final ? '' : '还在找…') + '</span></div>';
                resultWall = TV.ui.wall(function (w) { TV.openWork(w); });
                resultWall.classList.add('w4');
                right.appendChild(resultWall);
            }
            var shown = resultWall._items.length;
            if (results.length > shown) resultWall.add(results.slice(shown).map(TV.api.workCard));
            var t = TV.$('.sres-t .dim', right);
            if (t) t.textContent = final ? '共 ' + results.length + ' 部' : '还在找…';
            if (!hadFocus && final && TV.focused() && !el.contains(TV.focused())) TV.focusFirst(resultWall);
        }

        // 接了实体键盘 / 飞鼠键盘:字母数字直接输入
        function onChar(ch) {
            if (/^[a-zA-Z0-9]$/.test(ch)) { setQ(q + ch.toUpperCase()); return true; }
            return false;
        }

        if (params.q) { q = params.q; qEl.textContent = q; phEl.style.display = 'none'; runSearch(params.q); } else showHome();

        return {
            el: el,
            onChar: onChar,
            onBack: function () {
                if (results) {                               // 结果页 → 回到联想 / 热门
                    results = null; searchSeq++;
                    if (q) suggest(); else showHome();
                    TV.focusFirst(kb);
                    return true;
                }
                return false;
            },
            onKey: function (k) {
                if (k.name === 'back' && k.event.keyCode === 8 && q && !results) { setQ(q.slice(0, -1)); return true; }   // 键盘上的退格 = 删一个字
                return false;
            }
        };
    });
})();
