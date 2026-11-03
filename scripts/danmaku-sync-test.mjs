#!/usr/bin/env node
// 弹幕跟不上画面(快退后一段没弹幕、快进后跳过的弹幕一口气全出来)回归(离线、零网络):
//   node scripts/danmaku-sync-test.mjs
//  ① DPlayer.min.js 还是这套:frame 按 options.time() 只往前读、seek 才对齐读指针(升级改了就先报)
//  ② <dg-dm-resync-core> 在沙箱里真跑,弹幕模块用 DPlayer 同样的 seek / frame 语义:
//     绕过 dp.seek 改 currentTime 后读指针对齐;已对齐、小跳不清屏;切后台回来对齐;重建播放器后旧实例不动弹幕
//  ③ 接线:safeSeekBy 同步对齐、新建播放器时装上
// 改弹幕时间、跳转逻辑、换 DPlayer 版本后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const DPJS = fs.readFileSync(path.join(ROOT, 'public/libs/js/DPlayer.min.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

console.log('① DPlayer 的前提');
{
    ok(DPJS.includes('this.options.time()>parseFloat(t.time)'), 'frame:按 options.time() 比较,读指针只往前');
    ok(DPJS.includes('this.dan[e].time>=this.options.time()'), 'seek:按 options.time() 对齐读指针');
    ok(DPJS.includes('time:function(){return a.video.currentTime}'), '弹幕时间默认取 video.currentTime');
    ok(/this\.video\.currentTime=e,this\.danmaku&&this\.danmaku\.seek\(\)/.test(DPJS), 'dp.seek 自己会对齐(绕过它的才需要补)');
}

const coreM = /\/\/ <dg-dm-resync-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-dm-resync-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-dm-resync-core> 段'); process.exit(1); }
const { dmPointerOff, dmResync } = vm.runInNewContext(coreM[1] + '\n;({ dmPointerOff, dmResync });', { parseFloat, Number });

// 弹幕模块:seek / frame 照 DPlayer 的语义写
const makeDm = (times, video) => {
    const dm = {
        dan: times.map(t => ({ time: t })), danIndex: 0, drawn: [], clears: 0,
        options: { time: () => video.currentTime },
        clear() { this.danIndex = 0; this.clears++; },
        seek() {
            this.clear();
            for (let e = 0; e < this.dan.length; e++) {
                if (this.dan[e].time >= this.options.time()) { this.danIndex = e; break; }
                this.danIndex = this.dan.length;
            }
        },
        frame() {
            let t = this.dan[this.danIndex];
            while (t && this.options.time() > parseFloat(t.time)) { this.drawn.push(t.time); t = this.dan[++this.danIndex]; }
        },
    };
    return dm;
};
const makeVideo = () => {
    const L = {};
    return { currentTime: 0, addEventListener(k, f) { (L[k] = L[k] || []).push(f); }, fire(k) { (L[k] || []).forEach(f => f()); }, count: k => (L[k] || []).length };
};
const makeDoc = () => {
    const L = {};
    return { hidden: false, addEventListener(k, f) { (L[k] = L[k] || []).push(f); }, fire(k) { (L[k] || []).forEach(f => f()); }, count: k => (L[k] || []).length };
};
const everySecond = Array.from({ length: 600 }, (_, i) => i);

console.log('② 读指针跟着时间走');
{
    const v = makeVideo(), dm = makeDm(everySecond, v), player = { danmaku: dm, video: v };
    ok(dmResync(player, makeDoc()) === true && dmResync(player, makeDoc()) === false && v.count('seeking') === 1, '装上返回 true;同一实例不重复装');

    // 正常播到 100 秒
    v.currentTime = 100.5; dm.frame();
    const at100 = dm.danIndex;
    ok(at100 === 101, '正常播放读指针在当前时间', at100);

    // 快退 10 秒(绕过 dp.seek)
    v.currentTime = 90.5; v.fire('seeking');
    ok(dm.dan[dm.danIndex].time === 91, '快退 10 秒:读指针回到 90.5 之后', dm.dan[dm.danIndex]);
    dm.drawn = []; v.currentTime = 95.5; dm.frame();
    ok(dm.drawn.join() === '91,92,93,94,95', '快退后这一段的弹幕照常出现(修之前要等追回 100 秒)', dm.drawn);

    // 快进 60 秒
    v.currentTime = 155.5; v.fire('seeking');
    dm.drawn = []; dm.frame();
    ok(dm.drawn.length === 0, '快进:跳过的弹幕不会一口气全画出来(修之前这一帧 60 条)', dm.drawn.length);
    v.currentTime = 157.5; dm.frame();
    ok(dm.drawn.join() === '156,157', '快进后从新位置接着出', dm.drawn);

    // dp.seek 已对齐 → 不再清屏
    const clears = dm.clears;
    v.currentTime = 300.5; dm.seek();
    const afterSeek = dm.clears;
    v.fire('seeking');
    ok(afterSeek === clears + 1 && dm.clears === afterSeek, 'dp.seek 已经对齐过:seeking 不再多清一次屏');

    // hls.js 跳小空洞、微调
    v.currentTime = 301.5; dm.frame();
    const c2 = dm.clears;
    v.currentTime = 302.9; v.fire('seeking');
    ok(dm.clears === c2, '2 秒内的小跳(跳空洞、微调):屏幕上的弹幕不动');
}

console.log('③ 边界');
{
    ok(dmPointerOff({ dan: [], danIndex: 0 }, 10, 2) === false, '没有弹幕:不算偏');
    ok(dmPointerOff({ dan: [{ time: 1 }], danIndex: 0 }, NaN, 2) === false, '换源中 currentTime=NaN:不动');
    ok(dmPointerOff({ dan: [{ time: 500 }], danIndex: 0 }, 10, 2) === false, '稀疏弹幕:下一条在很后面不算偏');
    ok(dmPointerOff({ dan: [{ time: 5 }], danIndex: 1 }, 400, 2) === false, '稀疏弹幕:读完了且时间在后面不算偏');
    ok(dmPointerOff({ dan: [{ time: 5 }, { time: 500 }], danIndex: 2 }, 400, 2) === true, '读到结尾又退回来:算偏');
    ok(dmPointerOff({ dan: [{ time: '5.5' }, { time: '9' }], danIndex: 0 }, 9, 2) === true, '字符串时间也能比');
    ok(dmResync(null) === false && dmResync({}) === false && dmResync({ danmaku: {}, video: {} }) === false, '没有弹幕模块或 video:什么都不做');

    // 切后台回来
    const doc = makeDoc(), v = makeVideo(), dm = makeDm(everySecond, v);
    dmResync({ danmaku: dm, video: v }, doc);
    v.currentTime = 10.5; dm.frame();
    v.currentTime = 200.5;   // 后台继续播,rAF 停了
    doc.hidden = true; doc.fire('visibilitychange');
    ok(dm.danIndex === 11, '还在后台:不动');
    doc.hidden = false; doc.fire('visibilitychange');
    dm.drawn = []; dm.frame();
    ok(dm.drawn.length === 0 && dm.dan[dm.danIndex].time === 201, '回到前台:后台那段不再一口气画出来', dm.drawn.length);

    // 重建播放器
    const v2 = makeVideo(), dm2 = makeDm(everySecond, v2), oldPlayer = { danmaku: dm, video: v };
    dmResync({ danmaku: dm2, video: v2 }, doc);
    ok(doc.count('visibilitychange') === 1, '重建播放器不叠 visibilitychange 监听');
    v2.currentTime = 50.5;
    doc.fire('visibilitychange');
    ok(dm2.dan[dm2.danIndex].time === 51, '回到前台对齐的是新播放器');
    const stale = makeVideo(), staleDm = makeDm(everySecond, stale), holder = { danmaku: staleDm, video: stale };
    dmResync(holder);
    holder.danmaku = dm2;   // 实例上的弹幕模块换了
    stale.currentTime = 200.5; const c = staleDm.clears; stale.fire('seeking');
    ok(staleDm.clears === c, '弹幕模块被换掉后:旧监听不再动它');
    void oldPlayer;
}

console.log('④ 接线');
{
    const seekBy = /const safeSeekBy = \(delta\) => \{([\s\S]*?)\n\s*\};/.exec(HTML);
    ok(!!seekBy && /dp\.video\.currentTime = next; if \(dp\.danmaku\) dp\.danmaku\.seek\(\);/.test(seekBy[1]), 'safeSeekBy 改完时间同步对齐(不等 seeking,免得中间那一帧先画一批)');
    const create = HTML.slice(HTML.indexOf('dp = new DPlayer({'), HTML.indexOf('// ========== 🔧 设置菜单修复 =========='));
    ok(/\n\s*dmResync\(dp, document\);/.test(create), '新建播放器(含先看直播后重建)时装上');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
