/* E视界 电视版 · 播放链路(地址路由 / hls.js / 出错分诊 / 换线 / 去插播 / 缓冲小洞 / 片头片尾 / 观看时长 / 直播)
 *
 *   TV.play.open(video, opts) → session        点播
 *     opts: { work, line, lineIdx, ep(line.eps 下标), at(从第几秒开始),
 *             onStatus(文字), onSwitchLine(新线路下标, 提示, 新集下标), onFail(提示), onStarted(), onSkip({ text, done, kind, to }) }
 *     session: { seek(t), destroy(), lineIdx(), epIdx(), channel() 'f'|'r', skipIntroNow() 'bump'|'op'|'outro'|'', time(), route() }
 *   TV.play.openLive(video, channel, opts) → session   直播
 *     opts: { onStatus, onFail, onStarted, onSource(下标, 总数) };session: { destroy(), nextSource(方向 1|-1), index() }
 *
 * 照搬播放页(public/index.html)的做法,改成 ES5 + 裸 <video>:
 *   · 路由(先中先用):Kazumi /api/kz/ep/ 先解析(45s)→ mp4 原生播 / hls 接着走;线路要代理(useProxy)→ proxyUrl/?url=;
 *     去广告开着 + m3u8 + 有 worker + 该站没记"源站封 worker"(donggua_adproxy_bad2,12h)→ worker/?url=;否则直连。
 *     https 页上的 http 地址(APK 里混合内容一律被拦)一律经 worker;http 分片在 hls.js 的 xhrSetup 里改走 worker。
 *   · 只认 Hls.isSupported() 选 hls.js(新 Chrome 的 canPlayType 回 'maybe',靠它判断会整个绕开 hls.js)。
 *   · 每次起播一个令牌、一个 hls 实例:旧实例立刻销毁,所有异步回调先对令牌。
 *   · 出错分诊:worker 通道先经 worker 再取一次本集清单(跟到子清单数 EXTINF)→ 正常重试一次 / 被过滤清空走 nofilter /
 *     worker 故障换备用 worker 或直连(不记账)/ 源站封 worker 记账后直连或换线。
 *   · 换线只在"这条线路这一集还没播起来"时做;播起来之后才断的原地重来一次,还不行就交给播放页弹失败框(半路悄悄换线最招人烦)。
 */
(function () {
    'use strict';
    var TV = window.TV = window.TV || {};
    var P = TV.play = {};

    // ---------- 小工具 ----------
    function now() { return new Date().getTime(); }
    function pnow() { try { if (window.performance && performance.now) return performance.now(); } catch (e) { } return now(); }
    function api() { return TV.api || {}; }
    function has(o, k) { return !!o && typeof o[k] === 'function'; }
    function log() { try { if (TV.log) TV.log.apply(TV, ['[play]'].concat(Array.prototype.slice.call(arguments))); } catch (e) { } }
    function sget(k, def) { try { return TV.store ? TV.store.get(k, def) : def; } catch (e) { return def; } }
    function sraw(k) { try { return TV.store ? TV.store.raw(k) : null; } catch (e) { return null; } }
    function sset(k, v) { try { if (TV.store) TV.store.set(k, v); } catch (e) { } }
    function call(f) { if (typeof f !== 'function') return; try { f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { log('callback', e); } }
    function pageHttps() { try { return location.protocol === 'https:'; } catch (e) { return false; } }
    function docHidden() { try { return !!document.hidden; } catch (e) { return false; } }

    // ---------- 纯函数(scripts/tv-play-test.mjs 逐个测;能和 index.html 对照的都对照) ----------

    // 相对地址 → 绝对地址(老内核没有 new URL)。处理 //host、/path、相对路径、./ 和 ../
    function resolveUrl(u, base) {
        u = String(u == null ? '' : u).replace(/^\s+|\s+$/g, '');
        if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return u;
        var m = /^([a-z][a-z0-9+.\-]*:)\/\/([^\/?#]*)([^?#]*)([^#]*)/i.exec(String(base || ''));
        if (!m) return u;
        if (u.slice(0, 2) === '//') return m[1] + u;
        var origin = m[1] + '//' + m[2], dir = m[3] || '/';
        if (!u) return origin + dir + m[4];
        if (u.charAt(0) === '?') return origin + dir + u;
        if (u.charAt(0) === '#') return origin + dir + m[4] + u;
        var path = u.charAt(0) === '/' ? u : dir.replace(/[^\/]*$/, '') + u;
        var q = path.search(/[?#]/), tail = '';
        if (q >= 0) { tail = path.slice(q); path = path.slice(0, q); }
        var segs = path.split('/'), out = [];
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i], last = i === segs.length - 1;
            if (s === '.') { if (last) out.push(''); continue; }
            if (s === '..') { if (out.length > 1) out.pop(); if (last) out.push(''); continue; }
            out.push(s);
        }
        return origin + out.join('/') + tail;
    }
    function isKzUrl(u) { return /(^|\/)api\/kz\/ep\//.test(String(u || '')); }
    // worker 能不能从公网拉到本站的 /api/kz/m3u8(本地开发 / 内网拉不到)—— 和 index.html _kzWorkerOk 同一套
    function kzWorkerOk(host) {
        var h = String(host || '').toLowerCase();
        return !!h && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)/.test(h) && !/\.(local|localhost|lan|internal)$/.test(h);
    }
    function wrapUrl(proxy, u, nofilter) { return proxy + '/?' + (nofilter ? 'nofilter=1&' : '') + 'url=' + encodeURIComponent(u); }
    // 起播路由。o = { raw(本集地址;Kazumi 是解析出来的绝对地址), kz('hls'|'mp4'|''), line, proxy, adOn, adBad, kzOk, https }
    //   → { route: 'lineproxy'|'worker'|'nofilter'|'direct', url }
    function routeOf(o) {
        var line = o.line || {}, url = o.raw, route = 'direct';
        if (!o.kz && line.useProxy && line.proxyUrl) { url = wrapUrl(line.proxyUrl, o.raw); route = 'lineproxy'; }
        var m3u8 = o.kz ? (o.kz === 'hls' && !!o.kzOk) : String(o.raw || '').indexOf('.m3u8') >= 0;
        if (o.adOn && m3u8 && !line.useProxy && o.proxy && !o.adBad) { url = wrapUrl(o.proxy, url); route = 'worker'; }
        // https 页上的 http 地址:APK 的 WebView 不放行混合内容,只能经 worker(不过滤:去广告关着 / 该站封 worker / 不是 m3u8)
        if (o.https && /^http:\/\//i.test(url) && o.proxy) { url = wrapUrl(o.proxy, url, true); route = 'nofilter'; }
        return { route: route, url: url };
    }
    function urlFor(route, raw, proxy, line) {
        if (route === 'worker' && proxy) return wrapUrl(proxy, raw);
        if (route === 'nofilter' && proxy) return wrapUrl(proxy, raw, true);
        if (route === 'lineproxy' && line && line.proxyUrl) return wrapUrl(line.proxyUrl, raw);
        return raw;
    }
    // 时间轴通道(片头标记按它分开存):经去广告 worker = 'f',直连 / 无过滤 = 'r'(index.html _introChannel)
    function channelOf(u) { u = String(u || ''); return (/[?&]url=/.test(u) && !/[?&]nofilter=1/.test(u)) ? 'f' : 'r'; }
    // worker 探测结果分类(index.html handleError 里的 classify)
    function classify(pr) {
        if (pr.status >= 500 || pr.status === 429) return 'workerdown';
        if (pr.status === 403 || pr.status === 404 || pr.status === 451) return 'siteblock';
        if (pr.ok) return !/#EXTM3U/.test(pr.txt) ? 'siteblock' : (/#EXTINF:/.test(pr.txt) ? 'ok' : 'stripped');
        return 'siteblock';
    }
    function masterChild(txt) {
        if (!/#EXT-X-STREAM-INF/.test(txt || '')) return '';
        var ls = String(txt).split('\n');
        for (var i = 0; i < ls.length; i++) { var l = ls[i].replace(/^\s+|\s+$/g, ''); if (l && l.charAt(0) !== '#') return l; }
        return '';
    }
    // 分诊结论 → 下一步。c = { retried, directOK(测速是直连通的), canDirect(不是 https 页上的 http 地址) }
    //   act: retry 经 worker 再来一次 / nofilter 走无过滤通道(还要再探)/ backup 试备用 worker(都不通就直连)/ direct / next 换线;mark = 记"源站封 worker"
    function decideTriage(cls, why, c) {
        if (why === 'empty' && cls === 'ok') cls = 'stripped';   // hls.js 亲眼看到 0 分片而探测"正常":worker 边缘节点不一致,一样按清空处理
        if (cls === 'ok') return c.retried ? { act: c.directOK && c.canDirect ? 'direct' : 'next', cls: cls } : { act: 'retry', cls: cls };
        if (cls === 'stripped') return { act: 'nofilter', cls: cls };
        if (cls === 'workerdown') return { act: 'backup', cls: cls };
        return { act: c.directOK && c.canDirect ? 'direct' : 'next', mark: true, cls: 'siteblock' };
    }
    // 换线顺序:从当前线路往后绕一圈(列表已按分级排好,当前线路可能在中间),跳过本次已失败的
    function failoverOrder(n, cur, failed) {
        var out = [];
        for (var k = 1; k < n; k++) { var i = (cur + k) % n; if (!(failed && failed[i])) out.push(i); }
        return out;
    }
    var ADBAD_TTL = 12 * 3600 * 1000;
    function adBadGet(map, site, t) { return !!(site && map && typeof map === 'object' && map[site] && t - map[site] < ADBAD_TTL); }
    function adBadMark(map, site, t) {
        map = (map && typeof map === 'object') ? map : {};
        if (!site) return map;
        map[site] = t;
        var ks = Object.keys(map);
        if (ks.length > 60) ks.sort(function (a, b) { return map[a] - map[b]; }).slice(0, ks.length - 60).forEach(function (k) { delete map[k]; });
        return map;
    }
    // 起播看门狗:有没有实质进展(播放页 armStartWatchdog 同一判据)
    function hasContent(v) { return !v.error && (v.readyState >= 3 || (v.currentTime || 0) > 0.1 || !!(v.buffered && v.buffered.length > 0)); }
    function shouldSeek(t, dur) { return t > 1 && (!isFinite(dur) || t < dur - 3); }
    function okTime(t) { return typeof t === 'number' && isFinite(t) && t >= 0; }

    // 缓冲小洞(index.html <dg-hole-core> 的 ES5 版):音频 SourceBuffer 撞满后往回 seek 会留 0.1~0.2s 的洞,hls.js 1.1.5 停在洞前永远不动
    var HOLE = { POLL: 250, STILL: 350, TAIL: 0.3, NEAR: 1, PAD: 0.01 };
    function holeTarget(t, b) {
        if (!b || typeof t !== 'number' || !isFinite(t)) return null;
        for (var i = 0; i < b.length; i++) {
            var s = b.start(i), e = b.end(i);
            if (t < s) return s - t <= HOLE.NEAR ? s + HOLE.PAD : null;   // 不在任何段内
            if (t > e) continue;
            if (e - t > HOLE.TAIL || i + 1 >= b.length) return null;     // 段中间停住 / 后面没缓冲(网络欠载)
            var n = b.start(i + 1);
            return n - t <= HOLE.NEAR ? n + HOLE.PAD : null;
        }
        return null;
    }

    // 集名结构(index.html IntroCore.parseEpName / epInfos 的 ES5 版,片头标记的键 = 期号|通道|部分)
    var VAR_WORDS = '纯享|加更|特辑|发布会|见面会|专场|访谈|饭局|plus|先导|预告|彩蛋|花絮|片花|直拍|reaction|repo|回顾|集结篇|会员|付费|未删减|超前|抢先|抢鲜|尝鲜|番外|试播|特别|陪看|竖屏|沉浸|大神版|精华|精编|加长|预热';
    var VAR_HEAD = new RegExp('^(?:' + VAR_WORDS + ')', 'i'), VAR_ANY = new RegExp(VAR_WORDS, 'i');
    var VAR_PRE = /^(?:独家|幕后|正片|精彩|完整|删减|未播|拍摄|舞台)/, VAR_END = /^(?:片|版|集锦|合集|篇|特辑|场)?$/;
    var PART_CODE = { '上': 1, '中': 2, '下': 3 };
    var PART_HEAD = new RegExp('^([上中下])(?:半?[场集部篇])?(?=$|[^\\u4e00-\\u9fa5]|' + VAR_WORDS + ')', 'i');
    var EP_SEP = /[\s:：,，、;；。•‧·\-—_~～!！?？()（）【】\[\]「」『』"'.\/|]+/;
    var EP_SEP_G = new RegExp(EP_SEP.source, 'g');
    var CN_D = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    function cleanName(s) { return String(s == null ? '' : s).replace(/[​-‏⁠﻿ ]/g, '').replace(/^\s+|\s+$/g, ''); }
    function cnNum(s) {
        var n = 0, c = 0;
        for (var i = 0; i < s.length; i++) {
            var x = s.charAt(i);
            if (CN_D.hasOwnProperty(x)) c = CN_D[x];
            else if (x === '十') { n += (c || 1) * 10; c = 0; }
            else { n += (c || 1) * 100; c = 0; }
        }
        return n + c;
    }
    function isVarToken(t) {
        var s = t.replace(VAR_PRE, ''), n = 0, m;
        while ((m = VAR_HEAD.exec(s))) { s = s.slice(m[0].length); n++; }
        return n > 0 && VAR_END.test(s);
    }
    function parseEpName(s) {
        var m, kind = '', num = 0, at = 0, len = 0, part = 0, variant = false;
        function mdOk(mm, dd) { return +mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31; }
        if ((m = /(?:^|\D)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/.exec(s)) && mdOk(m[2], m[3])) { at = m.index + m[0].indexOf(m[1]); len = 8; num = +(m[1] + m[2] + m[3]); kind = 'date'; }
        else if ((m = /(?:^|\D)((?:19|20)\d{2})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})\s*日?(?!\d)/.exec(s)) && mdOk(m[2], m[3])) { at = m.index + m[0].indexOf(m[1]); len = m.index + m[0].length - at; num = +m[1] * 10000 + +m[2] * 100 + +m[3]; kind = 'date'; }
        else if ((m = /第\s*0*(\d+)\s*[集话話期]/.exec(s))) { at = m.index; len = m[0].length; num = parseInt(m[1], 10); kind = /期$/.test(m[0]) ? 'qi' : 'ji'; }
        else if ((m = /第\s*([零一二两三四五六七八九十百]+)\s*[集话話期]/.exec(s))) { at = m.index; len = m[0].length; num = cnNum(m[1]); kind = /期$/.test(m[0]) ? 'qi' : 'ji'; }
        else if ((m = /\bep\.?\s*0*(\d+)/i.exec(s))) { at = m.index; len = m[0].length; num = parseInt(m[1], 10); kind = 'ji'; }
        else if ((m = /^0*(\d{1,8})\s*([集话話期]?)/.exec(s)) && !/^(?:\d|[a-z]|\s*[-—~～、,，.．]\s*\d)/i.test(s.slice(m[0].length))) { len = m[0].length; num = +m[1]; kind = m[1].length >= 7 ? 'date' : m[2] === '期' ? 'qi' : 'ji'; }
        if (!kind || num > 99999999) {
            var pm = /^([上中下])(?:半?[场集部篇])?$/.exec(s);
            return { num: 0, part: pm ? PART_CODE[pm[1]] : 0, variant: isVarToken(s) || VAR_HEAD.test(s), kind: '' };
        }
        var head = s.slice(0, at).replace(/第\s*(?:\d+|[零一二两三四五六七八九十百]+)\s*[季集话話期]/g, '').replace(/第\s*$/, '').replace(EP_SEP_G, '').replace(/^\d{1,4}$/, '');
        if (head && (kind !== 'ji' || VAR_ANY.test(head))) variant = true;
        function peel(x, glued) {
            for (;;) {
                var g;
                if (x === '期') return '';
                if (kind === 'date' && (g = /^第\s*0*\d+\s*[集话話期]/.exec(x))) { x = x.slice(g[0].length); continue; }
                if ((g = PART_HEAD.exec(x))) { part = PART_CODE[g[1]]; x = x.slice(g[0].length); continue; }
                if (glued && VAR_HEAD.test(x)) { variant = true; return ''; }
                return x;
            }
        }
        var tail = s.slice(at + len).replace(/^\s*[集话話期]+/, '');
        var toks = tail.split(EP_SEP);
        for (var i = 0; i < toks.length; i++) {
            var tok = toks[i];
            if (!tok) continue;
            var r = peel(tok, i === 0);
            if (r && (kind === 'date' || (i === 0 ? kind === 'qi' : isVarToken(r)))) variant = true;
        }
        return { num: num, part: part, variant: variant, kind: kind };
    }
    function epInfos(list) {
        var arr = list || [], names = [], i;
        for (i = 0; i < arr.length; i++) names.push(cleanName(arr[i] && arr[i].name));
        var pre = '';
        if (names.length >= 2) {
            pre = names[0];
            for (i = 0; i < names.length; i++) {
                var nm = names[i], j = 0;
                while (j < pre.length && j < nm.length && pre.charAt(j) === nm.charAt(j) && !/\d/.test(pre.charAt(j))) j++;
                pre = pre.slice(0, j);
                if (!pre) break;
            }
            pre = pre.replace(/第\s*$/, '');
            if (names.indexOf(pre) >= 0) pre = '';
        }
        var parsed = names.map(function (n) { return parseEpName(pre ? n.slice(pre.length) : n); });
        var anyTok = parsed.some(function (p) { return !!p.kind; });
        var out = parsed.map(function (p, k) {
            return { ep: p.kind ? p.num : k + 1, part: p.part, variant: p.variant || (anyTok && !p.kind), kind: p.kind, why: p.variant ? '集名带变体词或别的文字' : anyTok && !p.kind ? '别的集有集号,这集解析不出' : '' };
        });
        var seen = {};
        out.forEach(function (x, k) {
            if (x.variant) return;
            var key = x.ep + '|' + x.part, j2 = seen.hasOwnProperty(key) ? seen[key] : undefined;
            if (j2 === undefined) seen[key] = k;
            else if (arr[j2].url !== arr[k].url) { out[j2].variant = true; x.variant = true; out[j2].why = x.why = '同一集号对应多个地址,分不清'; }
        });
        return out;
    }
    var MARK_V = 2, BUMP_V = 3, BUMP_HEAD = 30, LEAD = 6;
    function opAuto(c) { return !!c && (c.src === 'afp' || (c.mv === MARK_V && !c.miss && !c.pend)); }
    function bumpAuto(c) { return opAuto(c) && c.bmv === BUMP_V; }
    function bumpShow(c) { return !!c && c.be > c.bs && c.bs <= BUMP_HEAD; }
    function curOf(m) { return { os: m.os || 0, oe: m.oe || 0, mv: m.mv, miss: m.miss, pend: m.pend, bs: m.bs || 0, be: m.be || 0, bmv: m.bmv, ed: m.ed || 0, emv: m.emv }; }
    function markKey(ep, ch, part) { return ep + '|' + ch + (part ? '|' + part : ''); }
    // 本集本通道的标记;没有本通道的才退回老格式裸集号键(只在没有上/中/下时)
    function markFor(marks, ep, ch, part) {
        if (!marks) return null;
        var mk = marks[markKey(ep, ch, part)] || (part ? null : marks[ep]) || null;
        return (mk && (mk.oe > mk.os || mk.ed > 0)) ? curOf(mk) : null;
    }
    // 当前在哪个可跳区间(skipManager.check 的区间选择;提前 LEAD 秒算进入,inside = 真正进了区间)。flags = { bump, op, outro } 已跳过
    function skipRegion(cur, t, dur, flags) {
        if (!cur) return null;
        flags = flags || {};
        if (bumpShow(cur) && t >= cur.bs - LEAD && t < cur.be - 1 && !flags.bump) return { kind: 'bump', start: cur.bs, to: cur.be, ok: bumpAuto(cur), inside: t >= cur.bs };
        if (cur.oe > cur.os && t >= cur.os - LEAD && t < cur.oe - 1 && !flags.op) return { kind: 'op', start: cur.os, to: cur.oe, ok: opAuto(cur), inside: t >= cur.os };
        if (cur.ed > 0 && t >= cur.ed - LEAD && t < dur - 2 && !flags.outro) return { kind: 'outro', start: cur.ed, to: 0, ok: false, inside: t >= cur.ed };   // 片尾从不自动跳
        return null;
    }
    // 观看时长上报的集名归一(index.html watchMeter.epLabel)
    function epLabel(name) {
        var s = String(name == null ? '' : name).replace(/^\s+|\s+$/g, '');
        var m = /^(?:第\s*(\d+)\s*([集话話期])|ep\.?\s*(\d+)|(\d+))$/i.exec(s);
        if (!m) return s;
        var d = m[1] || m[3] || m[4];
        if (d.length >= 4) return s;
        return '第' + parseInt(d, 10) + (m[2] === '期' ? '期' : '集');
    }
    // 直播一条源怎么播:http 走 worker(先测),https 直接放(老内核 XHR 直连多半被 CORS 挡,测了也白测);没 worker 的 http 在 https 页放不了
    function liveTarget(url, proxy, https) {
        if (/^http:\/\//i.test(url)) {
            if (proxy) return { url: wrapUrl(proxy, url), test: true };
            return https ? null : { url: url, test: false };
        }
        return { url: url, test: false };
    }

    P._pure = {
        resolveUrl: resolveUrl, isKzUrl: isKzUrl, kzWorkerOk: kzWorkerOk, wrapUrl: wrapUrl, routeOf: routeOf, urlFor: urlFor, channelOf: channelOf,
        classify: classify, masterChild: masterChild, decideTriage: decideTriage, failoverOrder: failoverOrder, adBadGet: adBadGet, adBadMark: adBadMark,
        hasContent: hasContent, shouldSeek: shouldSeek, HOLE: HOLE, holeTarget: holeTarget, cleanName: cleanName, parseEpName: parseEpName, epInfos: epInfos,
        opAuto: opAuto, bumpAuto: bumpAuto, bumpShow: bumpShow, curOf: curOf, markKey: markKey, markFor: markFor, skipRegion: skipRegion, LEAD: LEAD,
        epLabel: epLabel, liveTarget: liveTarget
    };

    // ---------- 环境 ----------
    var preferNative = (function () {
        // iOS / Safari 用浏览器自己的 HLS(和播放页 _dgPreferNativeHls 一样);电视盒子都是安卓,走 hls.js
        try {
            var ua = navigator.userAgent || '';
            var ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
            var safari = /Safari/.test(ua) && !/Chrome|CriOS|Edg|EdgA|Android|Firefox|FxiOS|OPR|SamsungBrowser/i.test(ua);
            return ios || safari;
        } catch (e) { return false; }
    })();
    function useHlsJs() { try { return !preferNative && !!(window.Hls && Hls.isSupported()); } catch (e) { return false; } }

    // worker:主用 TV.api.proxy();分诊发现主用的临时故障、备用能通 → 本次会话换成备用
    var proxyOverride = '';
    function proxyList() {
        var a = api(), l = null;
        try { if (has(a, 'proxies')) l = a.proxies(); } catch (e) { }
        if (!l || !l.length) { var p = ''; try { if (has(a, 'proxy')) p = a.proxy() || ''; } catch (e) { } l = p ? [p] : []; }
        return l;
    }
    function curProxy() {
        if (proxyOverride && proxyList().indexOf(proxyOverride) >= 0) return proxyOverride;
        try { var a = api(); return has(a, 'proxy') ? (a.proxy() || '') : ''; } catch (e) { return ''; }
    }
    function rotateProxy(p) {
        proxyOverride = p;
        try { var a = api(); if (has(a, 'setProxy')) a.setProxy(p); } catch (e) { }
    }
    function adOn() {
        try { var a = api(); if (has(a, 'adFilterOn')) return !!a.adFilterOn(); } catch (e) { }
        return sraw('donggua_ad_filter_enabled') !== 'false';
    }
    // "源站封 worker"记账:和网页同一个 localStorage 键,12h,最多 60 站
    var adBadMem = {};
    function adBad(site) { return !!(site && adBadMem[site]) || adBadGet(sget('donggua_adproxy_bad2', {}), site, now()); }
    function markAdBad(site) {
        if (!site) return;
        adBadMem[site] = 1;
        sset('donggua_adproxy_bad2', adBadMark(sget('donggua_adproxy_bad2', {}), site, now()));
    }
    // 这条线路测速时是不是直连通的(线路自己的 test,或网页 / 电视共用的测速缓存 donggua_site_health2)
    function directOK(line) {
        if (!line) return false;
        if (line.test === 'direct' || (line.raw && line.raw._testType === 'direct')) return true;
        try {
            var m = sget('donggua_site_health2', {}), r = m && typeof m === 'object' ? m[line.key] : null;
            return !!(r && r.testType === 'direct' && r.latency < 9000 && now() - (r.ts || 0) < 3 * 24 * 3600 * 1000);
        } catch (e) { return false; }
    }
    function canDirect(raw) { return !(pageHttps() && /^http:\/\//i.test(String(raw || ''))); }
    function hlsConfig() {
        // backBufferLength 90 / maxMaxBufferLength 120:防 12MB 音频缓冲撞顶后的小洞卡死(播放页同值);重试调低,一条线路打不开几秒内就知道
        var c = { backBufferLength: 90, maxMaxBufferLength: 120, fragLoadingMaxRetry: 2, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2 };
        var px = curProxy();
        // https 页上 hls.js 要拉的 http 分片(worker 清单里分片是源站原地址):APK 拦混合内容,改走 worker。xhrSetup 里先 open 了 hls.js 就不再 open
        if (px && pageHttps()) c.xhrSetup = function (xhr, url) { if (/^http:\/\//i.test(url)) xhr.open('GET', wrapUrl(px, url, true), true); };
        return c;
    }

    // XHR GET:非 2xx 也照常返回(要看状态码),只有网络错 / 超时才 reject
    function xget(url, ms) {
        return new Promise(function (resolve, reject) {
            var x = new XMLHttpRequest(), done = false;
            var timer = setTimeout(function () { if (done) return; done = true; try { x.abort(); } catch (e) { } var er = new Error('timeout'); er.timeout = true; reject(er); }, ms);
            x.onreadystatechange = function () {
                if (x.readyState !== 4 || done) return;
                done = true; clearTimeout(timer);
                if (!x.status) { reject(new Error('network')); return; }
                resolve({ status: x.status, ok: x.status >= 200 && x.status < 300, txt: x.responseText || '', url: x.responseURL || url });
            };
            try { x.open('GET', url, true); x.send(null); } catch (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }
        });
    }
    // 拉清单,主清单跟到第一条子清单(整条链共用一个时间预算);读一半超时 = 抛错(算 worker 不可达,绝不当空清单冤枉源站)
    function probeChain(u, deadline, depth) {
        var left = deadline - now();
        if (left <= 0) return Promise.reject(new Error('timeout'));
        return xget(u, left).then(function (pr) {
            if (pr.ok && (depth || 0) < 2) {
                var sub = masterChild(pr.txt);
                if (sub) return probeChain(resolveUrl(sub, pr.url || u), deadline, (depth || 0) + 1);
            }
            return pr;
        });
    }
    function probe(u, ms) { return probeChain(u, now() + (ms || 6000), 0); }
    function hasFrags(pr) { return !!(pr && pr.ok && /#EXTINF:/.test(pr.txt)); }
    // 刚从后台回来 / 断网:探测失败多半是网络还没接上
    var resumeAt = 0;
    function waitOnline(ms) {
        return new Promise(function (res) {
            var t = 0;
            function done() { clearTimeout(t); try { window.removeEventListener('online', done); } catch (e) { } res(); }
            try { window.addEventListener('online', done); } catch (e) { }
            t = setTimeout(done, ms);
        });
    }
    function weakNet() { try { return navigator.onLine === false || now() - resumeAt < 30000; } catch (e) { return false; } }

    // ---------- 一个 <video> 的公共部分 ----------
    function bindVideo(S, map) {
        var v = S.video;
        TV.each(Object.keys(map), function (ev) {
            var f = function (e) { try { map[ev](e); } catch (x) { log('on ' + ev, x); } };
            v.addEventListener(ev, f, false);
            S.unbind.push(function () { v.removeEventListener(ev, f, false); });
        });
    }
    function stopMedia(S) {
        var v = S.video;
        clearTimeout(S.wd);
        if (S.hls) { var h = S.hls; S.hls = null; try { h.destroy(); } catch (e) { } }   // 旧实例立刻销毁(两个 hls 抢一个 video = 错误风暴)
        try { v.pause(); } catch (e) { }
        if (v.getAttribute && v.getAttribute('src')) { try { v.removeAttribute('src'); v.load(); } catch (e) { } }
        S.cur = null;
    }
    function tryPlay(S, tok) {
        var v = S.video, p;
        try { p = v.play(); } catch (e) { return; }
        if (!p || typeof p.then !== 'function') return;
        p.then(null, function (err) {
            if (tok !== S.tok || !err || err.name !== 'NotAllowedError') return;
            // 不让带声音自动播(浏览器里;APK 允许):先静音播
            var c = S.cur;
            if (!c) return;
            if (!v.muted) {
                v.muted = true; S.autoMuted = true;
                var p2; try { p2 = v.play(); } catch (e) { }
                if (p2 && typeof p2.then === 'function') p2.then(null, function () { if (tok === S.tok && S.cur) S.cur.playBlocked = true; });
            } else c.playBlocked = true;
        });
    }
    function safeSeek(v, t) { if (!okTime(t)) return false; try { v.currentTime = t; return true; } catch (e) { return false; } }
    function fireEnded(S) {
        // 片尾插播:直接当这一集播完(播放页 dp.events.trigger('ended')),播放器的 ended 处理会接下一集
        var v = S.video;
        try { v.pause(); } catch (e) { }
        try { var ev = document.createEvent('Event'); ev.initEvent('ended', false, false); v.dispatchEvent(ev); } catch (e) { }
        call(S.opts.onEnded);
    }

    // ---------- 缓冲小洞跳过器(hls.js 通道) ----------
    function holeWatch(hls, video, o) {
        o = o || {};
        var lastT = NaN, since = 0, poll = 0, soon = 0, dead = false;
        var self = { skips: [], stop: null, tick: null };
        function onWaiting() { self.tick(); clearTimeout(soon); soon = setTimeout(self.tick, HOLE.STILL + 10); }
        self.stop = function () {
            if (dead) return;
            dead = true;
            try { clearInterval(poll); clearTimeout(soon); video.removeEventListener('waiting', onWaiting); } catch (e) { }
        };
        self.tick = function () {
            if (dead) return;
            try {
                if (!hls.media || (o.gone && o.gone())) return self.stop();
                var t = video.currentTime, n = pnow(), moved = !(Math.abs(t - lastT) < 0.01);
                if (moved) lastT = t;
                if (moved || video.error || video.paused || video.seeking || video.ended || video.readyState >= 3 || !(video.playbackRate > 0)) { since = n; return; }
                var to = holeTarget(t, video.buffered);
                if (to == null) { since = n; return; }
                if (n - since < HOLE.STILL) return;
                var lv = hls.levels ? hls.levels[hls.currentLevel] : null;
                if ((lv && lv.details && lv.details.live) || (o.off && o.off())) return;
                if (self.skips.length < 50) self.skips.push({ at: +t.toFixed(3), to: +to.toFixed(3), still: Math.round(n - since) });
                since = n;
                video.currentTime = to;
            } catch (e) { }
        };
        try {
            hls.on(o.destroying, self.stop);
            video.addEventListener('waiting', onWaiting);
            poll = setInterval(self.tick, HOLE.POLL);
        } catch (e) { self.stop(); }
        return self;
    }

    // ---------- 去插播(index.html adClipSkip 的 hls.js 通道子集,判定全在 /libs/js/ad-clip-core.js) ----------
    //   如意这类站把广告切成和正片一样的块藏在中间,清单上分不出来,但分辨率 / 首帧时间戳和正片不同:播到之前就判出来,到点静默跳过
    var CLIP = { COOLDOWN: 1500, MAX_ACTIONS: 30, MAX_ATTEMPTS: 2, BIG_BUFFER: 75 };
    function clipEnabled() {
        return !!(window.AdClipCore && typeof window.AdClipCore.decide === 'function') && adOn() && sraw('donggua_adclip_off') !== '1';
    }
    function clipAttach(hls, video, tok) {
        var C = window.AdClipCore, E = window.Hls.Events;
        var st = {
            hls: hls, video: video, tok: tok, dead: false, live: false, multi: false, frags: null, groups: [],
            res: Object.create(null), off: Object.create(null), overrides: Object.create(null), skipped: Object.create(null),
            attempts: Object.create(null), pendKey: null, actions: 0, lastActAt: -1e9, selfTo: null, selfAt: 0, endedFired: false,
            lastWhy: '', lastRes: '', mainRes: '', lastT: 0, startFromZero: null, userSeeked: false, bufRaised: false, bufOrig: null,
            loadedCc: Object.create(null)
        };
        function rebuild() { try { st.groups = C.groupsFromFrags(st.frags); } catch (e) { } }
        hls.on(E.FRAG_LOADING, function (ev, d) { try { if (d && d.frag) st.loadedCc[d.frag.cc] = 1; } catch (e) { } });
        hls.on(E.MANIFEST_PARSED, function (ev, d) { try { st.multi = !!(d && d.levels && d.levels.length > 1); } catch (e) { } });
        hls.on(E.LEVEL_LOADED, function (ev, d) { try { var det = d && d.details; if (!det) return; st.live = !!det.live; st.frags = det.fragments; rebuild(); } catch (e) { } });
        hls.on(E.FRAG_PARSED, rebuild);   // 活 Fragment 的 start 在 PTS 修正后会漂,落点按它重算
        hls.on(E.FRAG_PARSING_INIT_SEGMENT, function (ev, d) {
            try {
                if (!d || d.id !== 'main' || !d.frag) return;
                var m = d.tracks && d.tracks.video && d.tracks.video.metadata;
                if (!m || !(m.width > 0 && m.height > 0)) return;
                var k = m.width + 'x' + m.height, cc = d.frag.cc, old = st.res[cc];
                st.res[cc] = (old && old !== k) ? C.MIXED : k;
                st.lastRes = k;
                clipAdjust(st, cc);
            } catch (e) { }
        });
        hls.on(E.INIT_PTS_FOUND, function (ev, d) {
            try {
                if (!d || d.id !== 'main' || !d.frag || !(d.timescale > 0)) return;
                st.off[d.frag.cc] = d.initPTS / d.timescale;
                clipAdjust(st, d.frag.cc);
            } catch (e) { }
        });
        hls.on(E.DESTROYING, function () { st.dead = true; });
        return st;
    }
    function clipOdd(st, g, r, o) {
        var C = window.AdClipCore;
        return !!((r && st.mainRes && !C.sameRes(r, st.mainRes)) || (g && o != null && g.start > 30 && o + g.start < 5));
    }
    // 前方有"不像正片"的组:临时把预加载放到 75s,播到时它已经解析出来
    function clipAdjust(st, cc) {
        try {
            var h = st.hls;
            if (!h || !h.config || st.dead) return;
            var g = null;
            for (var i = 0; i < st.groups.length; i++) if (st.groups[i].cc === cc) { g = st.groups[i]; break; }
            if (clipOdd(st, g, st.res[cc], st.off[cc]) && !st.bufRaised) { st.bufOrig = h.config.maxBufferLength; h.config.maxBufferLength = Math.max(CLIP.BIG_BUFFER, st.bufOrig || 0); st.bufRaised = true; }
        } catch (e) { }
    }
    function clipRestore(st, t) {
        try {
            if (!st.bufRaised || !st.hls || !st.hls.config) return;
            if (st.groups.some(function (g) { return g.start > t && clipOdd(st, g, st.res[g.cc], st.off[g.cc]); })) return;
            st.hls.config.maxBufferLength = st.bufOrig; st.bufRaised = false;
        } catch (e) { }
    }
    function clipSeek(st, to) { st.selfTo = to; st.selfAt = pnow(); st.lastT = to; safeSeek(st.video, to); }
    // 刚跳过就往回退 5s 会落进广告:按"广告时长为 0"换算回广告之前
    function clipOnSeeking(st) {
        var C = window.AdClipCore;
        if (!st || st.dead || !C) return;
        var video = st.video, t = video.currentTime, n = pnow();
        if (st.selfTo != null && n - st.selfAt < 2000 && Math.abs(t - st.selfTo) < 0.5) return;   // 自己发起的
        var prevT = st.lastT;
        st.lastT = t;
        if (Math.abs(t - prevT) >= 2) st.userSeeked = true;   // <2s 的是 hls.js 起播跳洞 / 小洞跳过器,不算用户拖
        if (!(t < prevT - 0.5)) return;
        var gi = C.findGroup(st.groups, t);
        var ccs = gi >= 0 && st.skipped[st.groups[gi].cc];
        if (!ccs) return;
        var g0 = null, g1 = null;
        for (var i = 0; i < st.groups.length; i++) { if (st.groups[i].cc === ccs[0] && !g0) g0 = st.groups[i]; if (st.groups[i].cc === ccs[ccs.length - 1] && !g1) g1 = st.groups[i]; }
        if (g0 && g1 && prevT >= g1.end && prevT - g1.end < 30) clipSeek(st, Math.max(0, g0.start - (g1.end - t)));
    }
    // 先把这段从 SourceBuffer 删掉再 seek(不删的话落点先出广告末帧,全屏静止 ~1.7s);删不掉就照常 seek
    function clipSeekPast(st, run, to) {
        var h = st.hls, Hl = window.Hls, loaded = false;
        for (var i = run.g0; i <= run.g1; i++) if (st.groups[i] && st.loadedCc[st.groups[i].cc]) loaded = true;
        if (!h || !Hl || !loaded) { clipSeek(st, to); return; }
        var done = false, timer = 0;
        function go(ev, d) {
            if (done || (d && d.type === 'audio')) return;   // 音视频各发一次,等视频删完
            done = true;
            clearTimeout(timer);
            try { h.off(Hl.Events.BUFFER_FLUSHED, go); } catch (e) { }
            if (!st.dead) clipSeek(st, to);
        }
        try {
            var nx = st.groups[run.g1 + 1];
            h.on(Hl.Events.BUFFER_FLUSHED, go);
            timer = setTimeout(go, 150);
            h.trigger(Hl.Events.BUFFER_FLUSHING, { startOffset: run.start, endOffset: nx ? Math.min(run.end, nx.start) : run.end, type: null });
        } catch (e) { go(); }
    }
    function clipLanding(v, to) {
        try {
            var b = v.buffered;
            for (var i = 0; i < b.length; i++) {
                var s = b.start(i), e = b.end(i);
                if (to >= s && to + 0.5 <= e) return to;
                if (s > to && s - to < 1 && s + 0.5 <= e) return s + 0.05;   // 交界的小空洞:落到下一段缓冲开头
            }
        } catch (e) { }
        return null;
    }
    // timeupdate 里最先跑;真跳了返回 true(这一拍别的逻辑不再 seek)
    function clipCheck(S, st, t) {
        try {
            var C = window.AdClipCore;
            if (!st || st.dead || st.live || st.multi || !clipEnabled() || st.tok !== S.tok) return false;
            var v = st.video;
            if (v.paused || v.seeking || v.readyState < 2 || !isFinite(v.duration)) return false;
            if (st.startFromZero === null) st.startFromZero = t < 3 && !st.userSeeked;
            st.lastT = t;
            var n = pnow();
            if (n - st.lastActAt < CLIP.COOLDOWN || st.actions >= CLIP.MAX_ACTIONS) return false;
            var d = C.decide(st.groups, function (cc) { return st.res[cc]; }, t, null, {
                offOf: function (cc) { return st.off[cc]; }, overridden: function (g) { return !!st.overrides[g.cc]; },
                freshStart: !!st.startFromZero && !st.userSeeked, rate: v.playbackRate || 1
            });
            if (d.main && d.main.res) st.mainRes = d.main.res;
            if (d.why === 'main') clipRestore(st, t);
            if (st.pendKey && !(d.run && d.run.key === st.pendKey)) { delete st.attempts[st.pendKey]; st.pendKey = null; }
            if (d.run && d.why !== st.lastWhy) { st.lastWhy = d.why; log('去插播 ' + d.act + '/' + d.why + ' @' + d.run.start.toFixed(1) + '+' + d.run.dur.toFixed(1) + 's'); }
            if (d.act === 'seek') {
                var buffered = clipLanding(v, d.to);
                var to = buffered == null ? d.to : buffered;
                var ccs = [];
                for (var i = d.run.g0; i <= d.run.g1; i++) ccs.push(st.groups[i].cc);
                if ((st.attempts[d.run.key] = (st.attempts[d.run.key] || 0) + 1) > CLIP.MAX_ATTEMPTS) {
                    ccs.forEach(function (cc) { st.overrides[cc] = 1; });   // 两次都没越过去:本实例不再跳它(防死循环)
                    return false;
                }
                ccs.forEach(function (cc) { st.skipped[cc] = ccs; });
                st.pendKey = d.run.key;
                st.actions++; st.lastActAt = n; st.selfTo = to; st.selfAt = n; st.lastT = to;
                clipSeekPast(st, d.run, to);
                return true;
            }
            if (d.act === 'ended') {
                // 片尾广告:和"片尾"共用一个闸门,绝不触发两次(那会连跳两集)
                if (st.endedFired || (S.ic && S.ic.flags.outro) || S.endedFired) return false;
                st.endedFired = true; st.actions++; st.lastActAt = n;
                S.endedFired = true;
                if (S.ic) S.ic.flags.outro = true;
                fireEnded(S);
                return true;
            }
        } catch (e) { }
        return false;
    }

    // ---------- 片头片尾(只读:/api/intro/marks,别的设备学出来的标记) ----------
    var marksCache = {};
    function getMarks(title, site, cb) {
        var key = title + '|' + site, r = marksCache[key], t = now();
        if (r && r.marks && t - r.at < (r.failed ? 2 : 15) * 60 * 1000) { cb(r.marks); return; }
        if (r && r.wait) { r.wait.push(cb); return; }
        var rec = marksCache[key] = { wait: [cb], at: t, marks: null, failed: false };
        function done(marks, failed) {
            var w = rec.wait; rec.wait = null; rec.marks = marks; rec.failed = failed; rec.at = now();
            TV.each(w, function (f) { try { f(marks); } catch (e) { } });
        }
        if (typeof TV.http !== 'function') { done({}, true); return; }
        TV.http('/api/intro/marks?title=' + encodeURIComponent(title) + '&site=' + encodeURIComponent(site), { timeout: 5000 })
            .then(function (j) { done((j && j.marks && typeof j.marks === 'object') ? j.marks : {}, false); }, function () { done({}, true); });
    }
    function skipOn() { return sget('tv_skip_intro', true) !== false; }
    // 本集(本线路、本时间轴通道)的标记状态。换线 / 换通道后时间轴变了,要重新取
    function introState(S, c) {
        var ch = channelOf(c.url), key = c.lineIdx + '|' + c.epIdx + '|' + ch;
        if (S.ic && S.ic.key === key) return S.ic;
        var line = c.line, info = null;
        try { info = epInfos(line.eps)[c.epIdx] || null; } catch (e) { }
        var ic = S.ic = { key: key, cur: null, flags: { bump: false, op: false, outro: !!S.endedFired }, hint: {} };
        var title = (S.work && S.work.title) || '', site = line && line.key;
        if (!info || info.variant || !title || !site) return ic;   // 纯享 / 加更 / 先导这类不是正片:不套标记
        getMarks(title, site, function (marks) {
            if (S.dead || S.ic !== ic) return;
            ic.cur = markFor(marks, info.ep, ch, info.part);
        });
        return ic;
    }
    function introCheck(S, c, t) {
        var v = S.video, ic = introState(S, c);
        if (!ic.cur) return;
        var dur = v.duration;
        // 换源瞬间会有一拍 currentTime=0、duration=NaN:此刻绝不跳
        if (!(t > 1 && isFinite(dur) && dur > 0 && !v.seeking)) return;
        var reg = skipRegion(ic.cur, t, dur, ic.flags);
        if (!reg) return;
        if (reg.kind !== 'outro' && reg.ok && skipOn()) {
            if (!reg.inside) return;   // 自动跳严格等到区间起点(提前跳会切掉区间前的正片)
            ic.flags[reg.kind] = true;
            safeSeek(v, reg.to);
            call(S.opts.onSkip, { text: reg.kind === 'bump' ? '已跳过开头' : '已跳过片头', done: true, kind: reg.kind, to: reg.to });
            return;
        }
        if (reg.kind === 'outro') {
            if (reg.inside && !ic.hint.outro) { ic.hint.outro = 1; call(S.opts.onSkip, { text: '片尾:按 ▶▶ 下一集', done: false, kind: 'outro' }); }
            return;
        }
        if (!ic.hint[reg.kind]) { ic.hint[reg.kind] = 1; call(S.opts.onSkip, { text: (reg.kind === 'bump' ? '开头' : '片头') + ':按 ▶▶ 跳过', done: false, kind: reg.kind, to: reg.to }); }
    }
    function skipNow(S) {
        var c = S.cur, v = S.video;
        if (!c || !S.ic || !S.ic.cur) return '';
        var t = v.currentTime, dur = v.duration;
        if (!okTime(t) || !isFinite(dur) || !(dur > 0)) return '';
        var reg = skipRegion(S.ic.cur, t, dur, S.ic.flags);
        if (!reg) return '';
        if (reg.kind === 'outro') return 'outro';   // 片尾由播放器自己接下一集
        S.ic.flags[reg.kind] = true;
        safeSeek(v, reg.to);
        call(S.opts.onSkip, { text: reg.kind === 'bump' ? '已跳过开头' : '已跳过片头', done: true, kind: reg.kind, to: reg.to });
        return reg.kind;
    }

    // ---------- 观看时长(喂「大家都在看」;服务器开了 watch_stats 才报,和网页 watchMeter 同格式,简化成内存队列) ----------
    var meter = { acc: {}, sess: {}, pend: [], cur: null, v: null, src: '', ct: 0, wall: 0, flushAt: 0, timer: 0, input: now(), sending: false };
    function authToken() {
        try { var a = api(); if (has(a, 'token')) return a.token() || ''; } catch (e) { }
        return sraw('emax_auth_hash') || '';
    }
    function meterOk() { var a = api(); return !!(a.cfg && a.cfg.watch_stats) && !!authToken(); }
    function meterAttach(S) {
        meter.cur = S; meter.v = null; meter.src = '';
        if (!meter.timer) { meter.wall = 0; meter.flushAt = now(); meter.timer = setInterval(meterTick, 1000); }
    }
    function meterDetach(S) {
        if (meter.cur !== S) return;
        meter.cur = null;
        clearInterval(meter.timer); meter.timer = 0;
        meterFlush();
    }
    function meterTick() {
        try {
            var t = now(), dt = meter.wall ? (t - meter.wall) / 1000 : 0;
            meter.wall = t;
            var S = meter.cur;
            if (S && !S.dead) meterMeasure(S, dt);
            if (t - meter.flushAt >= 60000 || t < meter.flushAt) meterFlush();
        } catch (e) { }
    }
    function meterMeasure(S, dt) {
        var v = S.video, id = S.ident ? S.ident() : null;
        if (!v || !id) return;
        var src = id.k + '\n' + id.t + '\n' + id.e + '\n' + S.tok, ct = +v.currentTime || 0;
        var prev = meter.ct, same = src === meter.src && v === meter.v;
        meter.v = v; meter.src = src; meter.ct = ct;   // 基线每秒都跟着走:暂停 / 卡住期间也更新,恢复后只算新推进的
        if (!same || v.paused || v.ended || v.readyState < 2) return;
        var adv = ct - prev;
        if (!(adv > 0.05) || docHidden() || now() - meter.input > 4 * 3600e3 || !meterOk()) return;
        var rate = v.playbackRate > 0 ? v.playbackRate : 1;
        var inc = Math.min(dt, 5, adv / rate + 0.5);
        if (!(inc > 0)) return;
        var key = id.k + '\n' + id.t + '\n' + id.e, dur = +v.duration;
        var a = meter.acc[key] || (meter.acc[key] = { k: id.k, t: id.t, e: id.e, s: 0, c: 0 });
        a.s += inc;
        meter.sess[key] = (meter.sess[key] || 0) + inc;
        // 看完 = 播到 ≥90% 且这一集真看了 ≥30s
        if (id.k === 'vod' && isFinite(dur) && dur > 60 && ct >= dur * 0.9 && meter.sess[key] >= 30) a.c = 1;
    }
    function meterBid() {
        var r = '';
        try { var b = new Uint8Array(8); window.crypto.getRandomValues(b); for (var i = 0; i < b.length; i++) r += (b[i] % 36).toString(36); } catch (e) { }
        while (r.length < 8) r += Math.floor(Math.random() * 36).toString(36);
        return 'w' + now().toString(36) + '_' + r;
    }
    function meterFlush() {
        meter.flushAt = now();
        var items = [];
        for (var key in meter.acc) {
            if (!meter.acc.hasOwnProperty(key)) continue;
            var a = meter.acc[key], s = Math.floor(a.s);
            if (s < 1) continue;
            items.push({ k: a.k, t: a.t, e: a.e, s: Math.min(s, 14400), c: a.c });
            if (a.s - s < 0.01) delete meter.acc[key]; else { a.s -= s; a.c = 0; }
        }
        var token = authToken();
        if (items.length && token) {
            for (var i = 0; i < items.length; i += 60) meter.pend.push({ id: meterBid(), token: token, items: items.slice(i, i + 60) });
            if (meter.pend.length > 10) meter.pend = meter.pend.slice(meter.pend.length - 10);
        }
        meterSend();
    }
    function meterSend() {
        if (meter.sending || !meter.pend.length || typeof TV.http !== 'function') return;
        try { if (navigator.onLine === false) return; } catch (e) { }
        var b = meter.pend[0];
        meter.sending = true;
        function next() { if (meter.pend[0] === b) meter.pend.shift(); meter.sending = false; meterSend(); }
        // 同一批重发服务器按 batch 去重;4xx(408/429 除外)= 永远不收,丢掉;断网 / 5xx 留到下一轮
        TV.http('/api/stats/watch', { method: 'POST', body: { token: b.token, batch: b.id, items: b.items }, timeout: 15000, noAuth: true })
            .then(next, function (e) {
                var st = e && e.status;
                if (st >= 400 && st < 500 && st !== 408 && st !== 429) next();
                else meter.sending = false;
            });
    }
    try {
        document.addEventListener('keydown', function () { meter.input = now(); }, true);
        document.addEventListener('click', function () { meter.input = now(); }, true);
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) { if (meter.cur) meterFlush(); }
            else { resumeAt = now(); meter.input = now(); }
        }, false);
    } catch (e) { }

    // ======================================================================
    // 点播
    // ======================================================================
    P.open = function (video, opts) {
        opts = opts || {};
        var work = opts.work || {};
        var lines = work.lines && work.lines.length ? work.lines : (opts.line ? [opts.line] : []);
        var lineIdx = typeof opts.lineIdx === 'number' ? opts.lineIdx : Math.max(0, lines.indexOf(opts.line));
        if (!lines[lineIdx] && opts.line) lineIdx = Math.max(0, lines.indexOf(opts.line));
        var S = {
            video: video, opts: opts, work: work, lines: lines, lineIdx: lineIdx, epIdx: Math.max(0, opts.ep | 0),
            tok: 0, hls: null, cur: null, wd: 0, wdHidden: false, dead: false, halted: false, triage: 0, failed: {},
            epStarted: false, epName: '', single: false, unbind: [], ic: null, endedFired: false, rate: 0, autoMuted: false, at: +opts.at || 0
        };
        S.ident = function () {
            var line = S.lines[S.lineIdx], ep = line && line.eps && line.eps[S.epIdx];
            var t = String(S.work.title || '').replace(/^\s+|\s+$/g, '').slice(0, 200);
            return t ? { k: 'vod', t: t, e: epLabel(ep && ep.name).slice(0, 120) } : null;
        };
        function mine() { return !!S.cur && S.cur.tok === S.tok && !S.dead; }
        bindVideo(S, {
            playing: function () {
                if (!mine()) return;
                var c = S.cur;
                if (S.rate && video.playbackRate !== S.rate) { try { video.playbackRate = S.rate; } catch (e) { } }   // 换地址会把倍速重置回 1:补回去
                if (c.started) return;
                c.started = true; c.startT = video.currentTime || 0; S.epStarted = true;
                clearTimeout(S.wd);
                call(opts.onStarted);
            },
            // 换地址时 stopMedia 的 pause() 会晚到一个 pause 事件:那时新地址已经 play() 了(paused=false),不算用户暂停
            pause: function () { if (mine() && !S.cur.started && video.paused) S.cur.userPaused = true; },
            play: function () { if (mine() && !S.cur.started && S.cur.userPaused) { S.cur.userPaused = false; armWd(S, S.tok, 14000); } },
            ratechange: function () { if (mine() && S.cur.started && video.playbackRate > 0) S.rate = video.playbackRate; },
            loadedmetadata: function () {
                if (!mine()) return;
                var c = S.cur, t = c.seekTo;
                c.manifestOk = true;
                c.seekTo = 0;
                if (shouldSeek(t, video.duration)) safeSeek(video, t);
            },
            timeupdate: function () {
                if (!mine()) return;
                var c = S.cur, t = video.currentTime;
                if (t > 1) S.pos = t;
                // 播稳 30s 之后,"重来过一次"的额度还回去(隔很久的第二次网络抖动也能原地重来)
                if (c.started && (c.fragRetried || c.retried) && t - c.startT > 30) { c.fragRetried = false; c.retried = false; }
                if (c.clip && clipCheck(S, c.clip, t)) return;
                introCheck(S, c, t);
            },
            seeking: function () { if (mine() && S.cur.clip) clipOnSeeking(S.cur.clip); },
            error: function () { if (mine() && video.error) onErr(S, S.tok, 'video:' + video.error.code); }
        });
        meterAttach(S);

        var session = {
            seek: function (t) {
                var c = S.cur;
                if (!c || typeof t !== 'number' || !isFinite(t)) return;
                if (t < 0) t = 0;
                var d = video.duration;
                if (isFinite(d) && d > 0 && t > d - 1) t = Math.max(0, d - 1);
                if (video.readyState < 1) { c.seekTo = t; c.resumeAt = t; return; }
                safeSeek(video, t);
            },
            destroy: function () {
                if (S.dead) return;
                meterDetach(S);
                S.dead = true; S.tok++;
                clearTimeout(S.wd);
                stopMedia(S);
                TV.each(S.unbind, function (f) { try { f(); } catch (e) { } });
                S.unbind = [];
            },
            lineIdx: function () { return S.lineIdx; },
            epIdx: function () { return S.epIdx; },
            channel: function () { return S.cur ? channelOf(S.cur.url) : 'r'; },
            route: function () { return S.cur ? S.cur.route : ''; },
            // 现在的位置(失败框"重试"用:播不起来时 video.currentTime 是 0,要回到续播点)
            time: function () { var c = S.cur; if (c && c.started && video.currentTime > 1) return video.currentTime; return S.pos || (c && c.resumeAt) || S.at || 0; },
            skipIntroNow: function () { return skipNow(S); },
            _state: S
        };

        var line = lines[lineIdx];
        if (!line) { setTimeout(function () { if (!S.dead) call(opts.onFail, '没有可用的线路'); }, 0); return session; }
        var tok0 = ++S.tok;
        status(S, '正在连接');
        loadEps(line).then(function () {
            if (tok0 !== S.tok || S.dead) return;
            if (!line.eps || !line.eps.length) { lineFailed(S, S.at, 'noeps'); return; }
            if (S.epIdx >= line.eps.length) S.epIdx = line.eps.length - 1;
            S.epName = line.eps[S.epIdx].name;
            S.single = line.eps.length <= 1;
            startEp(S, { seekTo: S.at });
        }, function () { if (tok0 === S.tok && !S.dead) lineFailed(S, S.at, 'eps'); });
        return session;
    };

    function status(S, t) { call(S.opts.onStatus, t); }
    function loadEps(line) {
        if (line.eps && line.eps.length) return Promise.resolve(line.eps);
        var a = api();
        if (!has(a, 'loadEps')) return Promise.resolve(line.eps || []);
        return Promise.resolve(a.loadEps(line)).then(function (eps) {
            if (eps && eps.length && !(line.eps && line.eps.length)) line.eps = eps;
            return line.eps || [];
        });
    }
    // 新线路上对应的那一集:-1 = 没有
    function pickEp(S, line) {
        var eps = line.eps || [];
        if (!eps.length) return -1;
        if (S.single) return 0;   // 单集(电影):各站叫法不一(正片 / HD / 高清),有就算
        var a = api(), i;
        try { if (has(a, 'hasEp') && a.hasEp(line, S.epName) === false) return -1; } catch (e) { }
        try { if (has(a, 'matchEp')) { i = a.matchEp(line, S.epName, -1); return (typeof i === 'number' && i >= 0 && i < eps.length) ? i : -1; } } catch (e) { }
        for (i = 0; i < eps.length; i++) if (eps[i].name === S.epName) return i;
        return -1;
    }

    // 起播这一集:Kazumi 先问服务器解析成什么
    function startEp(S, o) {
        var line = S.lines[S.lineIdx], ep = line && line.eps && line.eps[S.epIdx];
        if (!ep || !ep.url) { lineFailed(S, o.seekTo || 0, 'noep'); return; }
        if (!isKzUrl(ep.url)) { playAttempt(S, { raw: ep.url, seekTo: o.seekTo }); return; }
        stopMedia(S);
        var tok = ++S.tok;   // 解析要几秒到几十秒:先作废上一个地址的看门狗 / 分诊
        status(S, '正在解析视频地址');
        var u = resolveUrl(ep.url, location.href);
        if (o.fresh) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'fresh=1';
        function fail() { if (tok !== S.tok || S.dead) return; lineFailed(S, o.seekTo || 0, 'kz'); }
        TV.http(u, { timeout: 45000 }).then(function (j) {
            if (tok !== S.tok || S.dead) return;
            if (!(j && typeof j.url === 'string' && (j.type === 'hls' || j.type === 'mp4'))) { fail(); return; }
            playAttempt(S, { raw: resolveUrl(j.url, location.href), kz: { type: j.type, epUrl: ep.url, retried: !!o.kzRetried }, seekTo: o.seekTo });
        }, fail);
    }

    // 起播一个地址(一次 = 一个令牌 + 一个 hls 实例)。o = { raw, kz, route, proxy, retried, fragRetried, seekTo, switched }
    function playAttempt(S, o) {
        var v = S.video;
        stopMedia(S);
        var tok = ++S.tok;
        var line = S.lines[S.lineIdx], ep = line.eps[S.epIdx];
        var proxy = o.proxy || curProxy(), route = o.route, url;
        var kzType = o.kz ? o.kz.type : '';
        if (!route) {
            var r = routeOf({ raw: o.raw, kz: kzType, line: line, proxy: proxy, adOn: adOn(), adBad: adBad(line.key), kzOk: kzWorkerOk(location.hostname), https: pageHttps() });
            route = r.route; url = r.url;
        } else url = urlFor(route, o.raw, proxy, line);
        var native = kzType === 'mp4' || !useHlsJs();
        var c = S.cur = {
            tok: tok, line: line, lineIdx: S.lineIdx, ep: ep, epIdx: S.epIdx, route: route, raw: o.raw, url: url, proxy: proxy,
            kz: o.kz || null, native: native, retried: !!o.retried, fragRetried: !!o.fragRetried, seekTo: +o.seekTo || 0, resumeAt: +o.seekTo || 0,
            started: false, manifestOk: false, switched: !!o.switched, startT: 0, clip: null, hole: null, playBlocked: false, userPaused: false, tri: o.tri | 0
        };
        log('▶ ' + (S.work.title || '') + ' ' + (ep && ep.name) + ' · ' + (line.key || line.name) + ' · ' + route + (native ? ' · 原生' : ''));
        if (native) {
            v.src = url;
        } else {
            var Hl = window.Hls, hls = new Hl(hlsConfig());
            S.hls = hls;
            if (!kzType || kzType === 'hls') { try { if (clipEnabled()) c.clip = clipAttach(hls, v, tok); } catch (e) { } }   // 要赶在 loadSource 之前(它要 MANIFEST_PARSED)
            hls.on(Hl.Events.MANIFEST_PARSED, function () { if (S.cur && S.cur.tok === tok) S.cur.manifestOk = true; });
            hls.on(Hl.Events.ERROR, function (e, d) {
                if (S.hls !== hls || !d) return;
                if (d.fatal) onErr(S, tok, 'hls:' + d.type + '/' + d.details);
                else if (d.details === 'levelEmptyError' && !hls._tvEmpty) { hls._tvEmpty = 1; onErr(S, tok, 'empty'); }   // 0 分片清单只报这个非致命错,不接住就永远转圈
            });
            hls.loadSource(url);
            hls.attachMedia(v);
            try { c.hole = holeWatch(hls, v, { destroying: Hl.Events.DESTROYING, gone: function () { return S.hls !== hls; } }); } catch (e) { }
        }
        tryPlay(S, tok);
        armWd(S, tok, o.switched ? 8000 : 14000);   // 分诊里换地址后 8s:海外拉国内 CDN 首片常要 4~6s
    }

    // 起播看门狗:没任何实质进展就算这个地址不行。页面隐藏时 MediaSource 不开,只等不判;回到前台重新计满
    function armWd(S, tok, ms) {
        clearTimeout(S.wd);
        S.wd = setTimeout(function () {
            var c = S.cur, v = S.video;
            if (tok !== S.tok || !c || S.dead || S.halted) return;
            if (docHidden()) { S.wdHidden = true; armWd(S, tok, 3000); return; }
            if (S.wdHidden) { S.wdHidden = false; armWd(S, tok, c.switched ? 8000 : 14000); return; }
            if (c.started) return;
            if (v.paused && (c.playBlocked || c.userPaused)) return;   // 自动播放被拦 / 用户暂停:不算失败
            if (hasContent(v)) return;
            onErr(S, tok, 'timeout');
        }, ms);
    }

    // 出错:先弄清是 worker 的问题还是源的问题,再决定怎么退
    function onErr(S, tok, why) {
        var c = S.cur, v = S.video;
        if (!c || tok !== S.tok || S.triage === tok || S.dead || S.halted) return;
        var at = v.currentTime > 1 ? v.currentTime : c.resumeAt;
        var started = c.started || S.epStarted;
        log('出错(' + why + ') ' + (c.line.key || '') + ' 走 ' + c.route + (started ? ' · 已播过' : ''));
        // Kazumi:hls 清单签名过期 / 上游轮换,或 mp4 直链播到一半过期 → 服务器强制重解析一次(起播阶段的 mp4 错直接换线)
        if (c.kz && !c.kz.retried && (c.kz.type === 'hls' || started)) { startEp(S, { seekTo: at, fresh: true, kzRetried: true }); return; }
        var again = { route: c.route, raw: c.raw, kz: c.kz, proxy: c.proxy, retried: c.retried, fragRetried: true, seekTo: at, switched: true, tri: c.tri };
        // 清单拿到了、分片拉不下来:走不走 worker 都一样(分片直连 CDN),不用分诊
        if (c.manifestOk && (why === 'timeout' || /frag|networkError\/(?!manifest|level)/i.test(why))) {
            if (started && !c.fragRetried) { status(S, '正在重新连接'); playAttempt(S, again); return; }
            lineFailed(S, at, why);
            return;
        }
        // 一集最多分诊 3 次(备用 worker 时好时坏时别来回切)
        if (c.route === 'worker' && c.tri < 3) { triage(S, tok, c, why, at); return; }
        if (c.route === 'nofilter') {
            if (canDirect(c.raw)) { playAttempt(S, { route: 'direct', raw: c.raw, kz: c.kz, proxy: c.proxy, seekTo: at, switched: true, tri: c.tri }); return; }
            lineFailed(S, at, why);
            return;
        }
        // 直连 / 线路代理 / Kazumi mp4
        if (started && !c.fragRetried) { status(S, '正在重新连接'); playAttempt(S, again); return; }
        lineFailed(S, at, why);
    }

    // worker 通道的分诊:经 worker 再取一次本集清单,分 正常 / 被过滤清空 / 源站封 worker / worker 自身故障
    function triage(S, tok, c, why, at) {
        S.triage = tok;
        status(S, '正在检查线路');
        function alive() { return tok === S.tok && !S.dead && !S.halted; }
        function end() { if (S.triage === tok) S.triage = 0; }
        function switchTo(route, proxy, note) {
            end();
            if (!alive()) return;
            if (note) status(S, note);
            playAttempt(S, { route: route, raw: c.raw, kz: c.kz, proxy: proxy || c.proxy, retried: route === 'worker', seekTo: at, switched: true, tri: c.tri + 1 });
        }
        function next(mark) {
            end();
            if (!alive()) return;
            lineFailed(S, at, 'triage');
            if (mark) markAdBad(c.line.key);   // 记账会让这站降级:换线目标先按原顺序选好再记
        }
        var classOf = function () {
            return probe(c.url, 6000).then(classify, function () {
                if (!weakNet()) return 'workerdown';
                // 断网 / 刚从后台回来:先等网络(最多 8s;在线就等 2.5s)再探一次
                return waitOnline(navigator.onLine === false ? 8000 : 2500).then(function () {
                    if (!alive()) return 'workerdown';
                    return probe(c.url, 6000).then(classify, function () { return 'workerdown'; });
                });
            });
        };
        classOf().then(function (cls) {
            if (!alive()) { end(); return; }
            var d = decideTriage(cls, why, { retried: c.retried, directOK: directOK(c.line), canDirect: canDirect(c.raw) });
            log('过滤代理探测:' + d.cls + ' → ' + d.act);
            if (d.act === 'retry') { switchTo('worker', c.proxy); return; }
            if (d.act === 'direct') { if (d.mark) markAdBad(c.line.key); switchTo('direct', null, d.mark ? '该线路屏蔽了去广告,直连播放' : ''); return; }
            if (d.act === 'next') { next(!!d.mark); return; }
            if (d.act === 'nofilter') {
                // 去广告把整集清空(源站均匀切块,规则不适用):走 worker 无过滤通道;还不行就看原站直连有没有分片;都没有换线。绝不记账
                var nf = wrapUrl(c.proxy, c.raw, true);
                probe(nf, 6000).then(hasFrags, function () { return false; }).then(function (nfOk) {
                    if (!alive()) { end(); return; }
                    if (nfOk) { switchTo('nofilter', null, '本集去广告不可用,按原片播放'); return; }
                    if (!(directOK(c.line) && canDirect(c.raw))) { next(false); return; }
                    probe(c.raw, 6000).then(hasFrags, function () { return false; }).then(function (dOk) {
                        if (!alive()) { end(); return; }
                        if (dOk) switchTo('direct', null, '本集去广告不可用,按原片播放');
                        else next(false);
                    });
                });
                return;
            }
            // workerdown:先试备用 worker(能通就本次会话换过去),都不通直连兜底(不记账,下次照常走过滤)
            var others = proxyList().filter(function (p) { return p && p !== c.proxy; });
            (function tryOne(k) {
                if (!alive()) { end(); return; }
                if (k >= others.length) {
                    if (canDirect(c.raw)) switchTo('direct', null, '去广告线路暂时不通,先直连播放');
                    else next(false);
                    return;
                }
                xget(wrapUrl(others[k], c.raw), 5000).then(function (pr) {
                    if (!alive()) { end(); return; }
                    if (pr.ok && /#EXTM3U/.test(pr.txt)) { rotateProxy(others[k]); switchTo('worker', others[k], '已换到备用去广告线路'); }
                    else tryOne(k + 1);
                }, function () { tryOne(k + 1); });
            })(0);
        }, function () { end(); });
    }

    // 这条线路放不了:没播起来过 → 换下一条有这一集的线路;播起来过 → 交给播放页(不悄悄换线)
    function lineFailed(S, at, why) {
        if (S.dead || S.halted) return;
        if (S.epStarted || (S.cur && S.cur.started)) { halt(S, '播放中断了,网络可能不太好'); return; }
        var cur = S.lineIdx, from = S.lines[cur];
        S.failed[cur] = 1;
        if (from) from.latency = 9998;   // 本机这次放不了(网页同样记 9998,排序沉底)
        var order = failoverOrder(S.lines.length, cur, S.failed).filter(function (i) {
            var l = S.lines[i];
            return l && !(l.latency >= 9998) && !l.kzMismatch && !(l.raw && l.raw._kzMismatch);
        });
        var tok = ++S.tok;
        stopMedia(S);
        status(S, '正在换线路');
        (function tryNext(k) {
            if (tok !== S.tok || S.dead) return;
            if (k >= order.length) { halt(S, '所有线路都放不了'); return; }
            var i = order[k], ln = S.lines[i];
            loadEps(ln).then(function () {
                if (tok !== S.tok || S.dead) return;
                var ei = pickEp(S, ln);
                if (ei < 0) { tryNext(k + 1); return; }   // 这条线路没有这一集
                S.lineIdx = i; S.epIdx = ei;
                call(S.opts.onSwitchLine, i, '「' + ((from && from.name) || '这条线路') + '」放不了,换到「' + (ln.name || '下一条') + '」', ei);
                startEp(S, { seekTo: at });
            }, function () { tryNext(k + 1); });
        })(0);
    }
    function halt(S, msg) {
        if (S.halted || S.dead) return;
        S.halted = true; S.tok++;
        clearTimeout(S.wd);
        // 不摘 src:播放器失败框的"重试"要读到当前位置
        if (S.hls) { try { S.hls.stopLoad(); } catch (e) { } }
        try { S.video.pause(); } catch (e) { }
        call(S.opts.onFail, msg);
    }

    // ======================================================================
    // 直播
    // ======================================================================
    P.openLive = function (video, ch, opts) {
        opts = opts || {};
        var srcs = (ch && ch.sources) || [];
        var S = { live: true, video: video, opts: opts, ch: ch, tok: 0, idx: -1, hls: null, cur: null, wd: 0, dead: false, halted: false, unbind: [], lastProg: 0, stallT: 0 };
        S.ident = function () { var t = String((ch && ch.name) || '').slice(0, 200); return t ? { k: 'live', t: t, e: '' } : null; };
        function mine() { return !!S.cur && S.cur.tok === S.tok && !S.dead; }
        bindVideo(S, {
            playing: function () {
                if (!mine()) return;
                S.lastProg = now();
                if (S.cur.started) return;
                S.cur.started = true;
                clearTimeout(S.wd);
                var i = S.cur.i;
                S.cur.next = function () { go(i + 1, srcs.length - 2, 1); };   // 播起来过:失败后其余源再各试一遍
                call(opts.onStarted);
            },
            timeupdate: function () { if (mine()) { var t = video.currentTime; if (t !== S.lastT) { S.lastT = t; S.lastProg = now(); } } },
            error: function () { if (mine() && video.error) liveFail(S, S.tok, 'video:' + video.error.code); }
        });
        meterAttach(S);
        // 卡住 12s(没暂停、页面在前台)→ 换下一条源
        S.stallT = setInterval(function () {
            var c = S.cur;
            if (!mine() || !c.started || video.paused || docHidden()) { S.lastProg = now(); return; }
            if (now() - S.lastProg > 12000) liveFail(S, S.tok, 'stall');
        }, 2000);

        // 从第 i 条起试,最多再试 left 条;dir = 往哪个方向找
        function go(i, left, dir) {
            var n = srcs.length;
            var tok = ++S.tok;
            stopMedia(S);
            if (!n || left < 0) { liveHalt(S, n ? '这个台现在放不了' : '这个台没有可用的源'); return; }
            i = ((i % n) + n) % n;
            var t = liveTarget(srcs[i].url, curProxy(), pageHttps());
            S.idx = i;
            if (!t) { go(i + dir, left - 1, dir); return; }
            call(opts.onSource, i, n);
            status(S, '正在连接');
            var next = function () { go(i + dir, left - 1, dir); };
            function start() { if (tok === S.tok && !S.dead) liveAttempt(S, tok, t.url, i, next); }
            if (!t.test) { start(); return; }
            xget(t.url, 6000).then(function (pr) { if (tok !== S.tok || S.dead) return; if (pr.ok) start(); else next(); }, function () { if (tok === S.tok && !S.dead) next(); });
        }
        S.go = go;
        go(0, srcs.length - 1, 1);
        return {
            destroy: function () {
                if (S.dead) return;
                meterDetach(S);
                S.dead = true; S.tok++;
                clearTimeout(S.wd); clearInterval(S.stallT);
                stopMedia(S);
                TV.each(S.unbind, function (f) { try { f(); } catch (e) { } });
                S.unbind = [];
            },
            // 手动换源:往 dir 方向找下一条能放的(只有一条就重连它)
            nextSource: function (dir) {
                if (S.dead) return;
                dir = dir < 0 ? -1 : 1;
                S.halted = false;
                go(S.idx + (srcs.length > 1 ? dir : 0), Math.max(0, srcs.length - 2), dir);
            },
            index: function () { return S.idx; },
            _state: S
        };
    };
    function liveAttempt(S, tok, url, i, next) {
        var v = S.video, native = !useHlsJs();
        var c = S.cur = { tok: tok, url: url, i: i, started: false, next: next, native: native, playBlocked: false, userPaused: false, switched: false };
        S.lastProg = now();
        if (native) v.src = url;
        else {
            var Hl = window.Hls, hls = new Hl(hlsConfig());
            S.hls = hls;
            hls.on(Hl.Events.ERROR, function (e, d) { if (S.hls === hls && d && d.fatal) liveFail(S, tok, 'hls:' + d.type + '/' + d.details); });
            hls.loadSource(url);
            hls.attachMedia(v);
        }
        tryPlay(S, tok);
        liveWd(S, tok, 12000);
    }
    function liveWd(S, tok, ms) {
        clearTimeout(S.wd);
        S.wd = setTimeout(function () {
            var c = S.cur, v = S.video;
            if (tok !== S.tok || !c || S.dead) return;
            if (docHidden()) { liveWd(S, tok, 3000); return; }
            if (c.started || (v.paused && c.playBlocked) || hasContent(v)) return;
            liveFail(S, tok, 'timeout');
        }, ms);
    }
    function liveFail(S, tok, why) {
        var c = S.cur;
        if (!c || tok !== S.tok || S.dead || S.halted) return;
        log('直播源出错(' + why + ') #' + c.i);
        c.next();
    }
    function liveHalt(S, msg) {
        if (S.halted || S.dead) return;
        S.halted = true;
        clearTimeout(S.wd);
        call(S.opts.onFail, msg);
    }

    P.status = function () {
        var S = meter.cur;
        if (!S) return null;
        var c = S.cur;
        return c ? { live: !!S.live, route: c.route || '', url: c.url, native: c.native, started: c.started, channel: channelOf(c.url), line: S.lineIdx, ep: S.epIdx, proxy: curProxy() } : { idle: true };
    };
})();
