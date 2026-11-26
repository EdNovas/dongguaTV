/*!
 * ucomm-key.js — 评论 / 用户弹幕的"哪部剧、哪一集"键(单一真源)
 *
 * 同一个文件两处用:
 *   - lib/comments(服务器)require() 进来,按它给评论、用户弹幕落库和查询
 *   - public/index.html 以 <script> 引入(window.DgUcomm),评论区把"第3集 12:34"对回选集列表里的某一集
 * 两边对同一集必须算出同一个键,所以只能有这一份。
 *
 * 剧:播放页的组名(currentGroup.name,历史/进度/弹幕/片头标记都按它存)去掉空白和标点、全角转半角、小写。
 *     括号去掉但保留里面的字:「庆余年(第二季)」=「庆余年第二季」,和「庆余年」不是一部。
 *     同名拆卡(splitSameNameWorks)出来的【非主作品】再带上作品签名(_workSig,如 y2003m);主作品不带 ——
 *     不然一部冷门同名作品出现在搜索结果里,主作品的评论就跟着换了键、全都不见了。
 * 集:与播放页 _danmakuKey()(判断换线路要不要重拉弹幕)同一套归一,第06集 = 第6集 = 06 = EP6;日期式综艺按日期 + 日期外的文字。
 *     多一条:整部只有一集(电影)且集名里没有集号 → 'm'(各站电影的集名 HD中字 / 正片 / 高清 各写各的,其实是同一集)。
 *     scripts/comments-test.mjs 拿 index.html 里的 _danmakuKey 逐条比对,改那边要同步这里。
 * 约束:零依赖、ES2017(不用 ?? / ?. / 后行断言 —— 老 Safari 整段脚本解析失败)。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.DgUcomm = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function nfkc(s) { s = String(s == null ? '' : s); try { return s.normalize('NFKC'); } catch (e) { return s; } }

    function showKey(title, work) {
        var t = nfkc(title).replace(/[\s()（）\[\]【】{}·・:：\-—_~～!！?？"'“”‘’「」『』《》<>,，.。、;；\/\\|]+/g, '').toLowerCase().slice(0, 80);
        if (!t) return '';
        var w = String(work == null ? '' : work);
        return /^[a-z0-9]{1,24}$/i.test(w) ? t + '|' + w.toLowerCase() : t;
    }

    // 与 index.html _danmakuKey() 去掉"剧名|"之后的部分逐字一致(n 只多管"电影"那一条)
    function epKey(epName, n) {
        epName = String(epName == null ? '' : epName).trim();
        var dm = epName.match(/(?:^|\D)((?:19|20)\d{6})(?!\d)/), dkey = '', dtxt = '';
        if (dm) { dkey = dm[1]; dtxt = dm[1]; }
        else if ((dm = epName.match(/((?:19|20)\d{2})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})\s*日?/))) { dkey = dm[1] + pad2(dm[2]) + pad2(dm[3]); dtxt = dm[0]; }
        if (dkey) {
            var rest = epName.replace(dtxt, '\u0000').replace(/第?\s*\u0000\s*期?/, '')
                .replace(/[\s()（）\[\]【】·:：\-—_~～、.。]+/g, '').replace(/\d+/g, function (x) { return String(parseInt(x, 10)); }).toLowerCase();
            return dkey + '|' + rest;
        }
        var m = epName.match(/第\s*(\d+)\s*[集话話期]/) || epName.match(/\bep\.?\s*(\d+)/i) || epName.match(/^(\d+)$/);
        var num = m ? ((m[1].length >= 4 && m[1][0] === '0') ? m[1] : String(parseInt(m[1], 10))) : null;
        var suf = '';
        var tk = epName.match(/第?\s*\d+\s*[集话話期]/) || epName.match(/\bep\.?\s*\d+/i);
        if (tk) {
            var r = epName.slice(tk.index + tk[0].length);
            var SUFW = /^(上|中|下|先导|纯享|加更|特辑|彩蛋|花絮|片花|预告|直拍|发布会|见面会|专场|访谈|饭局|plus|reaction|repo)/i;
            for (var g = 0; g < 4; g++) {
                r = r.replace(/^[\s()（）\[\]【】·:：\-—_~～、.。]+/, '');
                var sm = r.match(SUFW);
                if (!sm) break;
                suf += sm[1].toLowerCase();
                r = r.slice(sm[0].length);
            }
        }
        if (num != null) return num + suf;
        if (Number(n) === 1) return 'm';
        return epName.slice(0, 60);
    }
    function pad2(x) { x = String(x); return x.length < 2 ? '0' + x : x; }

    // 播放器发给 /api/danmaku/v3/ 的 id:剧名|集名|v5|k:..|y:..|n:集数(见 _buildDanmakuOption),用户弹幕沿用同一个 id
    function parseDmId(id) {
        var parts = String(id == null ? '' : id).split('|');
        var out = { title: (parts[0] || '').trim(), ep: (parts[1] || '').trim(), n: 0 };
        for (var i = 2; i < parts.length; i++) { var m = /^n:(\d{1,5})$/.exec(parts[i]); if (m) out.n = Number(m[1]); }
        return out;
    }

    // 列表里的"第3集":数字键直接写第N集;其它(日期式/电影/认不出的)用发的人看到的集名
    function epText(key, label) {
        key = String(key || '');
        if (/^\d+$/.test(key)) return '第' + key + '集';
        if (/^\d+[^|\d]+$/.test(key) && !/^(19|20)\d{6}\|/.test(key)) return '第' + key.match(/^\d+/)[0] + '集' + key.replace(/^\d+/, '');
        if (key === 'm') return '';
        return String(label || '').slice(0, 30);
    }
    function clock(t) {
        t = Math.max(0, Math.floor(Number(t) || 0));
        var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
        return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s);
    }

    return { showKey: showKey, epKey: epKey, parseDmId: parseDmId, epText: epText, clock: clock };
}));
