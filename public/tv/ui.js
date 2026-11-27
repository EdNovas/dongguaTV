/* E视界 电视版 · 通用界面块(海报卡 / 横排 / 海报墙 / 顶栏)
 * 统一的条目格式(各接口的数据先转成这个再画):
 *   { title, poster, year, note(右下角小字,如"更新至20集"), badge(右上角,如评分), sub(片名下一行), progress(0~1,继续观看进度条),
 *     wide(横版卡), ...其它字段原样带着,点开时交回给调用方 }
 */
(function () {
    'use strict';
    var TV = window.TV;
    var ui = TV.ui = {};

    ui.card = function (it, i, opt) {
        opt = opt || {};
        var cls = 'card f' + (it.wide ? ' wide' : '') + (it.more ? ' more' : '') + (opt.cls ? ' ' + opt.cls : '');
        var h = '<div class="' + cls + '" data-i="' + i + '"' + (opt.attrs || '') + '><div class="pic">';
        if (it.poster) h += '<img data-src="' + TV.esc(it.poster) + '" alt="">';
        h += '<div class="ph">' + TV.esc(it.more ? it.title : (it.title || '').slice(0, 12)) + '</div>';
        if (it.badge) h += '<span class="badge">' + TV.esc(it.badge) + '</span>';
        if (it.flag) h += '<span class="badge l">' + TV.esc(it.flag) + '</span>';
        if (it.progress > 0) h += '<div class="prog"><i style="width:' + Math.min(100, Math.round(it.progress * 100)) + '%"></i></div>';
        else if (it.note) h += '<div class="note">' + TV.esc(it.note) + '</div>';
        h += '</div>';
        if (!it.more) {
            h += '<div class="nm">' + TV.esc(it.title) + '</div>';
            if (it.sub) h += '<div class="sub">' + TV.esc(it.sub) + '</div>';
        }
        return h + '</div>';
    };

    // 一个横排:标题 + 可横向滚动的卡片。返回 DOM;onPick(item, index) 在 OK 时调用
    ui.row = function (title, items, onPick, opt) {
        opt = opt || {};
        var h = '<div class="row" data-fg="row"' + (opt.id ? ' data-row="' + TV.esc(opt.id) + '"' : '') + '>' +
            '<div class="row-t">' + TV.esc(title) + (opt.hint ? '<span class="dim">' + TV.esc(opt.hint) + '</span>' : '') + '</div>' +
            '<div class="row-s sx">';
        TV.each(items, function (it, i) { h += ui.card(it, i); });
        h += '</div></div>';
        var el = TV.el(h);
        el._items = items;
        TV.on(el, 'tvok', function (e) {
            var c = e.target.closest ? e.target.closest('.card') : e.target;
            if (!c) return;
            var it = items[+c.getAttribute('data-i')];
            if (it && onPick) onPick(it, +c.getAttribute('data-i'), c);
        });
        TV.lazy(el);
        return el;
    };

    // 海报墙(一行 6 张),可以不断 append 下一页
    ui.wall = function (onPick, opt) {
        opt = opt || {};
        var el = TV.el('<div class="wall" data-fg="wall"></div>');
        var items = [];
        el._items = items;
        el.add = function (more) {
            var h = '';
            TV.each(more, function (it) { h += ui.card(it, items.length); items.push(it); });
            var tmp = document.createElement('div');
            tmp.innerHTML = h;
            while (tmp.firstChild) el.appendChild(tmp.firstChild);
            TV.lazy(el);
        };
        el.clear = function () { items.length = 0; el.innerHTML = ''; };
        TV.on(el, 'tvok', function (e) {
            var c = e.target.closest ? e.target.closest('.card') : e.target;
            if (!c || !el.contains(c)) return;
            var idx = +c.getAttribute('data-i');
            if (items[idx] && onPick) onPick(items[idx], idx, c);
        });
        // 焦点走到倒数两行时要下一页
        if (opt.onNearEnd) TV.on(el, 'tvfocus', function (e) {
            var c = e.target;
            if (!c.classList || !c.classList.contains('card')) return;
            if (+c.getAttribute('data-i') >= items.length - 12) opt.onNearEnd();
        });
        return el;
    };

    ui.loading = function (text) { return '<div class="loading"><span class="spin"></span>' + TV.esc(text || '加载中') + '</div>'; };
    ui.empty = function (text) { return '<div class="empty">' + TV.esc(text || '这里还没有内容') + '</div>'; };

    // 卡片在屏幕上的位置(做"跟随"动画、找附近的卡用)
    ui.indexOf = function (el) { return el ? +el.getAttribute('data-i') : -1; };
})();
