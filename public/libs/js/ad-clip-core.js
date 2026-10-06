/*!
 * ad-clip-core.js v2 —— 插播广告判定(纯函数,零依赖,ES2017,UMD:浏览器 window.AdClipCore / Node require)。
 * 不碰 DOM、不碰 hls 实例;运行时包装在 public/index.html 的 window.adClipSkip,回归测试 scripts/adclip-test.mjs。
 *
 * 为什么要它:CF Worker 只能按清单删插播(看 DISCONTINUITY 分组的时长/目录/域名)。如意(rycj)把 20-22 秒的棋牌广告
 *   重新切成和正片一样的"每 5/6 片一个 DISCONTINUITY"块藏在正片中间,清单层面与正片无从区分(EXTINF 全整数的组正片里也有)。
 *   但每段插播在【解码层】有两个和正片不一样的地方(2026-10-05 实测:成龙历险记 95 集 + 11 个源 123 集,共 ~19k 组):
 *   ① 分辨率:如意广告 1280x720、正片 1080x810;1080p 广告插在 1920x800/960 宽银幕正片里也是一样。190+182 段全中、0 误判。
 *   ② 时间戳:插播是另外剪进来的片子,首帧 PTS 从 ~1.45s 重新开始("restart");正片的时钟在广告前后是连续的,
 *      只是"停"了一个广告的长度("bridge":前一组的 PTS 偏移 - 后一组的 PTS 偏移 = 广告时长,残差 ≤0.2s)。
 *      ~12.8k 个正片组里 0 个同时满足 restart+bridge;同分辨率广告(魔都/iKun/360/爱奇艺/1080资源/最大的 1080p 插播、
 *      如意的 720p 片源)只能靠它抓。
 *   hls.js 每个 DISCONTINUITY(cc)首片转封装时发 FRAG_PARSING_INIT_SEGMENT(宽高)和 INIT_PTS_FOUND(initPTS/timescale
 *   = 首帧 PTS - frag.start),比播放头早一个预加载窗口,所以能在播到之前就判定,播到时直接 seek 过去。
 *
 * 判定(精度优先 —— 宁可漏跳,绝不吃正片):
 *   R 模式(分辨率):连续若干组分辨率(±5% 视为相同)≠ 主分辨率;前后都是主分辨率;且前后组的 PTS 偏移能"架桥"跨过它。
 *   P 模式(时间戳):单组、分辨率与主相同,但首帧 PTS 重新开始且前后架桥成立(同分辨率插播)。
 *   片头(第一组):只在"刚开始播、没拖动过"时、≤15s 才跳(R 模式);片尾(最后一组):必须 PTS 重新开始、≤25s。
 *   左侧未知(拖进/续看落在段中):必须 PTS 重新开始 + 更强的主分辨率证据。
 *   段长 ≤60s、≤全片 10%;已知内容里非主分辨率 / 重新开始的组合计 >12% → 熔断不跳(片源本身就花)。
 *
 * 输入:
 *   groups  = groupsFromFrags(hls 的 level details.fragments) —— 按 cc 切出的连续组
 *   resOf   = function(cc) -> 'WxH' | 'mixed' | undefined    —— FRAG_PARSING_INIT_SEGMENT 学到的每组分辨率(也可传对象)
 *   t       = video.currentTime
 *   ctx     = { offOf(cc) -> 秒|undefined(INIT_PTS_FOUND 的 initPTS/timescale), overridden(group) -> bool, freshStart, rate }
 * 输出: { act: 'none'|'wait'|'seek'|'ended', why, run?, main?, to? }
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AdClipCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    var MIXED = 'mixed';
    var DEF = {
        lead: 0.15,          // 提前量:t+lead 进入插播段即跳(timeupdate 约 250ms 一次);倍速时按 rate 加大
        landPad: 0.1,        // 落点 = 插播段后第一组起点 + 0.1s(躲 DISCONTINUITY 交界的音视频小空洞)
        maxRun: 60,          // 一段插播最长(实测 5.25-44s)
        maxRunFrac: 0.10,    // 也不得超过全片 10%(实测单段最多 4.3%)
        minRun: 0.5,         // 太短的不值得 seek
        minMainKnown: 30,    // 主分辨率至少已确认 30s
        mainVsRun: 2,        // 且至少是候选段的 2 倍
        minMainShare: 0.85,  // 候选段之外的已知内容里,主分辨率占比(实测最低 0.931)
        strongMainKnown: 45, // 段左侧未知(拖进段中/续看)时的主分辨率证据下限(此时 hls 只加载过播放头之后的 30-75s;另有 PTS 重启 + 右侧主分辨率 + 0.9 占比把关)
        strongMainShare: 0.9,
        simRel: 0.05,        // 宽、高各差 <5% 视为同一分辨率(1920x1088 vs 1080);实测广告与正片最小差 11%
        bridgeTol: 0.75,     // 架桥残差容差(实测 -0.19~+0.12s;正片组残差≈-段长)
        restartMax: 5,       // 首帧 PTS < 5s 视为"重新开始"(实测插播 1.42-1.49s)
        restartMinStart: 30, //   且该组不在片头 30s 内(正片自己也从 ~1.4s 开始)
        preMax: 15,          // 片头贴片最长(实测 5.25/5.85s);且只在刚开始播时跳
        tailMax: 25,         // 片尾插播最长(实测 12.16-17.67s)
        ptsMaxRun: 45,       // P 模式(同分辨率)单组上限
        fuseShare: 0.12,     // 已知内容里"非主分辨率 + PTS 重新开始"合计占比上限
        fuseMinKnown: 300    //   已知 ≥300s 才启用熔断(太少时占比没意义,交给证据规则)
    };

    // hls.js 的 fragments → 按 cc 切成连续组。必须用 hls 实例里的【活】Fragment(FRAG_PARSED 后 start 会按 PTS 修正:
    //   实测清单写 581.2、实际 581.35),用清单原值算落点会落回广告里。
    function groupsFromFrags(frags) {
        var out = [];
        if (!frags || !frags.length) return out;
        var cur = null;
        for (var i = 0; i < frags.length; i++) {
            var f = frags[i];
            if (!f || !isFinite(f.start) || !isFinite(f.duration)) continue;
            if (!cur || f.cc !== cur.cc) {
                cur = { cc: f.cc, start: f.start, end: f.start + f.duration, dur: 0, n: 0, sn0: f.sn };
                out.push(cur);
            }
            cur.end = f.start + f.duration;
            cur.dur = cur.end - cur.start;
            cur.n++;
        }
        return out;
    }

    function findGroup(groups, x) {
        var lo = 0, hi = groups.length - 1;
        if (hi < 0 || x < groups[0].start || x >= groups[hi].end) return -1;
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (groups[mid].start <= x) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    function parseRes(r) {
        var m = /^(\d+)x(\d+)$/.exec(String(r || ''));
        return m ? [+m[1], +m[2]] : null;
    }
    function sameRes(a, b, rel) {
        if (!a || !b || a === MIXED || b === MIXED) return false;
        if (a === b) return true;
        var p = parseRes(a), q = parseRes(b);
        if (!p || !q) return false;
        rel = rel == null ? DEF.simRel : rel;
        return Math.abs(p[0] - q[0]) <= rel * Math.max(p[0], q[0]) && Math.abs(p[1] - q[1]) <= rel * Math.max(p[1], q[1]);
    }

    // 主分辨率 = 已知时长最长的那个分辨率(相近的合并成一档;每组分辨率一旦学到,按整组时长计)
    function stats(groups, resOf, rel) {
        var keys = [], by = {}, known = 0, main = null, mainDur = 0;
        for (var i = 0; i < groups.length; i++) {
            var r = resOf(groups[i].cc);
            if (!r || r === MIXED) continue;
            var k = null;
            for (var j = 0; j < keys.length; j++) if (sameRes(keys[j], r, rel)) { k = keys[j]; break; }
            if (!k) { k = r; keys.push(k); by[k] = 0; }
            by[k] += groups[i].dur;
            known += groups[i].dur;
        }
        for (var q in by) if (by[q] > mainDur) { mainDur = by[q]; main = q; }
        return { main: main, mainDur: mainDur, known: known, by: by };
    }

    function decide(groups, resOf, t, opt, ctx) {
        var o = {}, k;
        for (k in DEF) o[k] = DEF[k];
        if (opt) for (k in opt) o[k] = opt[k];
        ctx = ctx || {};
        if (typeof resOf !== 'function') { var map = resOf || {}; resOf = function (cc) { return map[cc]; }; }
        var offOf = typeof ctx.offOf === 'function' ? ctx.offOf : function () { return undefined; };
        if (!groups || !groups.length || !isFinite(t)) return { act: 'none', why: 'no-data' };
        var rate = ctx.rate > 1 ? ctx.rate : 1;
        var gi = findGroup(groups, t + o.lead + 0.25 * (rate - 1));
        if (gi < 0) return { act: 'none', why: 'out-of-range' };
        var r = resOf(groups[gi].cc);
        if (!r) return { act: 'none', why: 'cur-unknown' };
        if (r === MIXED) return { act: 'none', why: 'cur-mixed' };
        var st = stats(groups, resOf, o.simRel);
        if (!st.main) return { act: 'none', why: 'no-main' };
        var isMain = function (x) { return sameRes(x, st.main, o.simRel); };
        var other = function (x) { return !!x && x !== MIXED && !isMain(x); };
        var restart = function (g) {
            var off = offOf(g.cc);
            return off != null && isFinite(off) && g.start > o.restartMinStart && off + g.start < o.restartMax;
        };

        var g0 = gi, g1 = gi, mode;
        if (other(r)) {
            mode = 'res';   // 连续的"非主分辨率"组合并成一段(广告位里背靠背的几支广告分辨率可能各不相同)
            while (g0 > 0 && other(resOf(groups[g0 - 1].cc))) g0--;
            while (g1 < groups.length - 1 && other(resOf(groups[g1 + 1].cc))) g1++;
        } else if (restart(groups[gi])) {
            mode = 'pts';   // 同分辨率,但首帧 PTS 重新开始:单组
        } else {
            // 播放头在正片里:照样带上主分辨率(运行时据此判断前方刚解析出的组"像不像正片",决定要不要加大预加载)
            return { act: 'none', why: 'main', main: { res: st.main, dur: st.mainDur, known: st.known } };
        }
        var run = { g0: g0, g1: g1, cc0: groups[g0].cc, cc1: groups[g1].cc, start: groups[g0].start, end: groups[g1].end, res: r, mode: mode };
        run.dur = run.end - run.start;
        run.key = run.cc0 + '-' + run.cc1;
        var last = groups.length - 1;
        var total = groups[last].end - groups[0].start;
        var atEnd = g1 === last, atStart = g0 === 0;
        run.atEnd = atEnd; run.atStart = atStart;
        var res = { run: run, main: { res: st.main, dur: st.mainDur, known: st.known } };
        function out(act, why, extra) { res.act = act; res.why = why; if (extra) for (var q in extra) res[q] = extra[q]; return res; }

        // 用户刻意看过的段(撤销 / 第二次拖回)→ 不再跳
        if (typeof ctx.overridden === 'function') for (var gg = g0; gg <= g1; gg++) if (ctx.overridden(groups[gg])) return out('none', 'user-override');
        if (mode === 'pts' && run.dur > o.ptsMaxRun) return out('none', 'pts-too-long');

        // 右侧封口:后一组分辨率必须已知且是主分辨率(或已到片尾);未知 → 等 hls 预加载把它解析出来
        var next = atEnd ? null : groups[g1 + 1], prev = atStart ? null : groups[g0 - 1];
        if (next) {
            var nr = resOf(next.cc);
            if (!nr) return out('wait', 'open-right');
            if (!isMain(nr)) return out('none', 'right-mixed');
        }
        // 左侧:已知主分辨率 → 封口;已知但不是主分辨率(含 mixed)→ 不判;未知 → 只能靠 PTS 重新开始 + 更强证据
        var leftUnknown = false;
        if (prev) {
            var lr = resOf(prev.cc);
            if (lr && !isMain(lr)) return out('none', 'left-mixed');
            if (!lr) leftUnknown = true;
        }
        if (mode === 'pts' && (leftUnknown || !next)) {
            // P 模式只认"前后都看得到"的中插(片尾 P 模式见下方 atEnd 分支)
            if (!next && !leftUnknown) { /* 片尾,下面判 */ } else return out(leftUnknown ? 'wait' : 'none', leftUnknown ? 'pts-left-unknown' : 'pts-edge');
        }

        if (run.dur < o.minRun) return out('none', 'too-short');
        if (run.dur > o.maxRun) return out('none', 'too-long');
        if (run.dur > o.maxRunFrac * total) return out('none', 'too-large-share');

        // 片头:只在刚开始播(没拖动/续看)时跳,且 ≤15s;PTS 帮不上(正片自己也从 ~1.4s 开始)。动画 OP、片头 logo 多在 15s 以上
        if (atStart) {
            if (mode !== 'res') return out('none', 'pts-at-start');
            if (!ctx.freshStart) return out('none', 'pre-not-fresh');
            if (run.dur > o.preMax) return out('none', 'pre-too-long');
        }
        // 片尾:必须 PTS 重新开始、≤25s(片尾彩蛋/下集预告换了分辨率也不会被当广告结束掉整集)
        if (atEnd) {
            if (!restart(groups[g0])) return offOf(groups[g0].cc) == null ? out('wait', 'tail-pts-unknown') : out('none', 'tail-no-restart');
            if (run.dur > o.tailMax) return out('none', 'tail-too-long');
        }
        // 左侧未知(拖进/续看落在段中):段真实起点不可知 → 必须 PTS 重新开始
        if (leftUnknown && !restart(groups[g0])) return offOf(groups[g0].cc) == null ? out('wait', 'left-pts-unknown') : out('none', 'left-no-restart');
        // 中插:前后都看得到 → 必须架桥(正片时钟停了一个段长)。正片里分辨率怪的一组(1088 编码、合集里另一集)时钟不会停 → 拒
        if (prev && next && !leftUnknown) {
            var op = offOf(prev.cc), on = offOf(next.cc);
            if (op == null || on == null || !isFinite(op) || !isFinite(on)) return out('wait', 'bridge-unknown');
            run.bridge = op - on - run.dur;
            if (Math.abs(run.bridge) > o.bridgeTol) return out('none', 'no-bridge');
        }

        // 证据:主分辨率已知时长足够、且在"候选段之外"的已知内容里占绝对多数
        var strong = leftUnknown;
        var needMain = Math.max(strong ? o.strongMainKnown : o.minMainKnown, o.mainVsRun * run.dur);
        if (st.mainDur < needMain) return out('wait', strong ? 'evidence-strong' : 'evidence');
        var rest = st.known - (mode === 'res' ? run.dur : 0);
        if (rest <= 0 || st.mainDur / rest < (strong ? o.strongMainShare : o.minMainShare)) return out('wait', 'main-share');
        // 熔断:已知内容里"非主分辨率 + PTS 重新开始"的组合计太多 → 片源本身就花(或时间戳乱),整集不跳
        //   不计:正在判的这一段本身、以及前后都是主分辨率且架桥成立的组(已经确认是插播,不是"片源花")
        if (st.known >= o.fuseMinKnown) {
            var odd = 0;
            var bridged = function (i) {
                if (i <= 0 || i >= groups.length - 1) return false;
                var p = groups[i - 1], n = groups[i + 1];
                if (!isMain(resOf(p.cc)) || !isMain(resOf(n.cc))) return false;
                var a = offOf(p.cc), b = offOf(n.cc);
                return a != null && b != null && Math.abs(a - b - groups[i].dur) <= o.bridgeTol;
            };
            for (var i = 0; i < groups.length; i++) {
                if (i >= g0 && i <= g1) continue;
                var rr = resOf(groups[i].cc);
                if (!rr) continue;
                if ((other(rr) || restart(groups[i])) && !bridged(i)) odd += groups[i].dur;
            }
            if (odd / st.known > o.fuseShare) return out('none', 'fuse');
        }
        if (atEnd) return out('ended', 'tail-run');
        return out('seek', mode === 'res' ? 'run' : 'pts-run', { to: next.start + o.landPad });
    }

    return { DEF: DEF, MIXED: MIXED, groupsFromFrags: groupsFromFrags, findGroup: findGroup, stats: stats, sameRes: sameRes, decide: decide };
}));
