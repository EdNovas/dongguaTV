#!/usr/bin/env node
// 缓冲小洞永久卡死回归(离线、零网络):
//   node scripts/hole-skip-test.mjs
//  ① hls.min.js 还是这套:前向目标公式、bufferPadding、跳洞与 nudge 的条件、一次性 stall 事件(升级改了就先报)
//  ② <dg-hole-core> 在沙箱里真跑(假时钟):判定表;真洞、网络欠载、段中间停住、暂停、拖动、下一段很远、直播;
//     轮询不被一次性事件卡住;销毁后不留定时器和监听;任何异常都不外抛
//  ③ 和别的逻辑不打架:dmResync(2 秒容差)、adClipSkip._onSeeking(<2 秒不算拖动)、已判定插播留下的大缺口、起播看门狗
//  ④ 接线:唯一的 new Hls 处挂上、配置里有 maxMaxBufferLength:120
// 改 hls 配置、缓冲相关逻辑、换 hls.js 版本后必跑。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const HLS = fs.readFileSync(path.join(ROOT, 'public/libs/js/hls.min.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };

console.log('① hls.min.js 的前提');
{
    ok(HLS.includes('getMaxBufferLength=function(t){var e,r=this.config;return e=t?Math.max(8*r.maxBufferSize/t,r.maxBufferLength):r.maxBufferLength,Math.min(e,r.maxMaxBufferLength)}'), '前向目标 = min(max(8×maxBufferSize÷码率, maxBufferLength), maxMaxBufferLength)');
    ok(/maxMaxBufferLength:600/.test(HLS), '默认 maxMaxBufferLength 还是 600');
    ok(/maxBufferSize:6e7/.test(HLS), '默认 maxBufferSize 还是 60MB');
    ok(/maxBufferHole:\.1/.test(HLS), '默认 maxBufferHole 还是 0.1s');
    ok(HLS.includes('this.bufferPadding=.2'), 'bufferPadding 还是 0.2s:≤0.2s 的洞不重新加载');
    ok(HLS.includes('e._trySkipBufferHole=function(t){'), '_trySkipBufferHole 还在');
    ok(HLS.includes('_tryFixBufferStall=function(t,e){var r=this.config,i=this.fragmentTracker,n=this.media.currentTime,a=i.getPartialFragment(n);if(a&&this._trySkipBufferHole(a))return;t.len>r.maxBufferHole&&e>1e3*r.highBufferWatchdogPeriod'), '_tryFixBufferStall:跳洞只认 partial 片,nudge 要求 len>maxBufferHole(这就是卡死的原因)');
    ok(HLS.includes('this.stallReported||(this.stallReported=!0,'), 'BUFFER_STALLED_ERROR 是一次性的:stallReported 挡着');
    ok(HLS.includes('else if(this.moved=!0,null!==i){if(this.stallReported){'), 'stallReported 只在 stalled 非空时才复位(nudge / 跳洞把 stalled 清掉后不复位)');
    ok(HLS.includes('o.b.log("destroy"),this.trigger(a.a.DESTROYING,void 0),this.detachMedia()'), 'hls.destroy() 先发 DESTROYING 再摘 media');
    ok(HLS.includes('detachMedia=function(){o.b.log("detachMedia"),this.trigger(a.a.MEDIA_DETACHING,void 0),this._media=null}'), 'detachMedia 后 hls.media 是 null');
    ok(HLS.includes('key:"media",get:function(){return this._media}'), 'hls.media 还是读 _media');
}

const coreM = /\/\/ <dg-hole-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-hole-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-hole-core> 段'); process.exit(1); }
const CORE = coreM[1];

// 假时钟:定时器按时间顺序跑,video 由调用方在每 10ms 推进
function makeEnv() {
    let clock = 1000, seq = 0;
    const timers = new Map();
    const box = {
        Number, Math,
        performance: { now: () => clock },
        setInterval(f, ms) { const id = ++seq; timers.set(id, { f, at: clock + ms, every: ms }); return id; },
        clearInterval(id) { timers.delete(id); },
        setTimeout(f, ms) { const id = ++seq; timers.set(id, { f, at: clock + ms, every: 0 }); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    const { dgHoleTarget, dgHoleWatch, DG_HOLE } = vm.runInNewContext(CORE + '\n;({ dgHoleTarget, dgHoleWatch, DG_HOLE });', box);
    const run = (ms, onStep) => {
        for (let left = ms; left > 0; left -= 10) {
            clock += 10;
            if (onStep) onStep(10);
            for (const [id, x] of [...timers]) {
                if (x.at > clock || !timers.has(id)) continue;
                if (x.every) x.at += x.every; else timers.delete(id);
                x.f();
            }
        }
    };
    return { dgHoleTarget, dgHoleWatch, DG_HOLE, run, timers, now: () => clock };
}
const ranges = (list) => ({ length: list.length, start: i => list[i][0], end: i => list[i][1] });
// 假 video:currentTime 写入算一次 seek;readyState 默认 2(卡住),playing=true 时按实时前进且 readyState=4
function makeVideo(t, list) {
    const L = {};
    const v = {
        _t: t, seeks: [], paused: false, seeking: false, ended: false, error: null, readyState: 2, playbackRate: 1, playing: false, list,
        get currentTime() { return this._t; },
        set currentTime(x) { this._t = x; this.seeks.push(x); this.fire('seeking'); },
        get buffered() { return ranges(this.list); },
        addEventListener(k, f) { (L[k] = L[k] || []).push(f); },
        removeEventListener(k, f) { L[k] = (L[k] || []).filter(x => x !== f); },
        fire(k) { (L[k] || []).forEach(f => f()); },
        count: k => (L[k] || []).length,
        step(ms) { if (this.playing) this._t += ms / 1000; },
    };
    return v;
}
const makeHls = (video, extra) => {
    const L = {};
    return Object.assign({
        media: video, levels: [{ details: { live: false } }], currentLevel: 0,
        on(k, f) { (L[k] = L[k] || []).push(f); },
        trigger(k) { (L[k] || []).forEach(f => f()); },
        subs: () => Object.keys(L),
    }, extra);
};
const start = (env, video, extra, opt) => {
    const hls = makeHls(video, extra);
    const w = env.dgHoleWatch(hls, video, Object.assign({ destroying: 'DESTROYING' }, opt));
    return { hls, w };
};

console.log('② 判定表');
{
    const { dgHoleTarget: T, DG_HOLE } = makeEnv();
    ok(DG_HOLE.TAIL === 0.3 && DG_HOLE.NEAR === 1 && DG_HOLE.STILL === 350 && DG_HOLE.POLL >= 250 && DG_HOLE.POLL <= 500 && DG_HOLE.PAD === 0.01, '阈值:段尾 0.3s、下一段 1s、连续 350ms、轮询 250~500ms、落点 +0.01');
    const close = (a, b) => a != null && Math.abs(a - b) < 1e-9;
    // 实测的洞(stall 调查 / 复核报告)
    ok(close(T(1204.881, ranges([[1100, 1204.961], [1205.085, 1800]])), 1205.095), '复核实测:洞 0.124s,停在洞前 0.08s → 落到下一段 +0.01');
    ok(close(T(1205.016, ranges([[1100, 1205.016], [1205.155, 1800]])), 1205.165), '调查实测:洞 0.139s,正好停在段尾');
    ok(close(T(1209.92, ranges([[1100, 1210.016], [1210.155, 1800]])), 1210.165), '调查实测:Chrome 停在洞前约 0.1s(不能卡得太死)');
    ok(close(T(1205.024, ranges([[1100, 1205.024], [1205.094, 1800]])), 1205.104), '0.07s 的洞(原本 2s 后 nudge)');
    ok(close(T(1205.2, ranges([[1100, 1205.016], [1205.326, 1800]])), 1205.336), '不在任何段内,下一段很近 → 跳');
    ok(close(T(0, ranges([[0.05, 30]])), 0.06), '开头的小洞,在第一段之前');
    // 边界
    ok(close(T(10, ranges([[0, 10.25], [11, 30]])), 11.01), '距段尾 0.25、下一段正好 1s:跳');
    ok(T(10, ranges([[0, 10.35], [10.6, 30]])) === null, '距段尾 0.35(段中间停住),下一段又很近:不跳');
    ok(T(10, ranges([[0, 10.25], [11.25, 30]])) === null, '下一段 1.25s:不跳');
    ok(T(10.5, ranges([[0, 10], [11.75, 30]])) === null, '不在段内,下一段 1.25s:不跳');
    // 不该动的
    ok(T(100, ranges([[0, 100]])) === null, '后面没有缓冲(网络欠载)');
    ok(T(100, ranges([[0, 100.1]])) === null, '段尾前 0.1s 但后面没有缓冲');
    ok(T(100, ranges([[0, 90]])) === null, '比所有缓冲都靠后(网络欠载)');
    ok(T(100, ranges([])) === null, '没有缓冲');
    ok(T(50, ranges([[0, 100], [100.1, 200]])) === null, '段中间停住');
    ok(T(100, ranges([[0, 100], [120, 300]])) === null, '已判定插播留下的 20s 大缺口');
    ok(T(100, ranges([[0, 100], [101.2, 300]])) === null, '1.2s 的缺口(不是小洞)');
    ok(T(NaN, ranges([[0, 100], [100.1, 200]])) === null, '换源中 currentTime=NaN');
    ok(T(10, null) === null, 'buffered 拿不到');
}

console.log('③ 轮询');
{
    // 真洞:连续约 350ms 没动才跳,1 秒内过去
    const env = makeEnv(), v = makeVideo(1204.881, [[1100, 1204.961], [1205.085, 1800]]);
    const { w } = start(env, v);
    env.run(240);
    ok(v.seeks.length === 0, '还没到 350ms:不动');
    env.run(600);
    ok(v.seeks.length === 1 && Math.abs(v.seeks[0] - 1205.095) < 1e-9, '只靠轮询(没有 waiting 事件):1 秒内跳到下一段 +0.01', v.seeks);
    ok(w.skips.length === 1 && w.skips[0].still >= 350, '记下这次跳过', w.skips);
    env.run(2000);
    ok(v.seeks.length === 1, '落到下一段中间后:不再跳', v.seeks);
}
{
    // waiting 事件提前看一眼:从 waiting 起 360ms 左右就跳
    const env = makeEnv(), v = makeVideo(1204.881, [[1100, 1204.961], [1205.085, 1800]]);
    v.readyState = 4; v.playing = true;
    start(env, v);
    env.run(500, ms => v.step(ms));
    v.playing = false; v._t = 1204.881; v.readyState = 2; v.fire('waiting');
    const t0 = env.now();
    let at = 0;
    for (let i = 0; i < 100 && !at; i++) { env.run(10); if (v.seeks.length) at = env.now() - t0; }
    ok(at >= 350 && at <= 370, 'waiting 后约 360ms 跳(不用等轮询对齐)', at);
}
{
    const env = makeEnv(), v = makeVideo(1204.881, [[1100, 1204.961], [1205.085, 1800]]);
    v.fire('waiting');   // 没挂之前的事件没有影响
    start(env, v);
    env.run(100);
    v.fire('waiting'); v.fire('waiting'); v.fire('waiting');   // 连发
    env.run(1000);
    ok(v.seeks.length === 1, 'waiting 连发:只跳一次', v.seeks);
}
{
    // 网络欠载
    const env = makeEnv(), v = makeVideo(100, [[0, 100]]);
    start(env, v);
    env.run(10000);
    ok(v.seeks.length === 0, '网络欠载(后面没缓冲):一直不动');
    v.list = [[0, 100], [110, 200]];
    env.run(5000);
    ok(v.seeks.length === 0, '网络欠载(下一段到了但很远):不动');
    v.list = [[0, 100], [100.6, 200]];
    env.run(200);
    ok(v.seeks.length === 0, '欠载中下一段补到 1s 内:刚到,先不动(浏览器可能自己接上)', v.seeks);
    env.run(800);
    ok(v.seeks.length === 1 && Math.abs(v._t - 100.61) < 1e-9, '…缺口一直在、一直没动:跳过去', v.seeks);
}
{
    // 起播:等数据的时间不算数,数据到了再计时,让 hls.js 自己先跳开头的小洞
    const env = makeEnv(), v = makeVideo(0, []);
    start(env, v);
    env.run(2000);
    v.list = [[0.023, 30]];
    env.run(240);
    ok(v.seeks.length === 0, '起播等了 2s 数据才到:不马上跳');
    v._t = 0.1; v.readyState = 4; v.playing = true;   // hls.js 自己跳过去了
    env.run(1000, ms => v.step(ms));
    ok(v.seeks.length === 0, 'hls.js 先跳开了:不再动', v.seeks);
    const env2 = makeEnv(), v2 = makeVideo(0, []);
    start(env2, v2);
    env2.run(2000);
    v2.list = [[0.023, 30]];
    env2.run(800);
    ok(v2.seeks.length === 1 && Math.abs(v2._t - 0.033) < 1e-9, 'hls.js 没动:到点兜底跳过去', v2.seeks);
}
{
    const env = makeEnv(), v = makeVideo(50, [[0, 100], [100.1, 200]]);
    start(env, v);
    env.run(10000);
    ok(v.seeks.length === 0, '段中间停住(解码慢、后面还有缓冲):不动');
}
{
    for (const [name, set] of [['暂停', x => { x.paused = true; }], ['拖动中', x => { x.seeking = true; }], ['已结束', x => { x.ended = true; }], ['readyState=3', x => { x.readyState = 3; }], ['readyState=4', x => { x.readyState = 4; }], ['媒体错误', x => { x.error = { code: 3 }; }], ['播放速度 0', x => { x.playbackRate = 0; }]]) {
        const env = makeEnv(), v = makeVideo(1204.881, [[1100, 1204.961], [1205.085, 1800]]);
        set(v);
        start(env, v);
        env.run(5000);
        ok(v.seeks.length === 0, name + ':不动');
    }
    // 恢复之后要重新计满 350ms
    const env = makeEnv(), v = makeVideo(1204.881, [[1100, 1204.961], [1205.085, 1800]]);
    v.paused = true;
    start(env, v);
    env.run(5000);
    v.paused = false;
    env.run(240);
    ok(v.seeks.length === 0, '刚取消暂停:要重新计满 350ms');
    env.run(600);
    ok(v.seeks.length === 1, '取消暂停后确实卡着:跳');
}
{
    // 正常播放不被打断
    const env = makeEnv(), v = makeVideo(1204, [[1100, 1204.961], [1205.085, 1800]]);
    v.readyState = 4; v.playing = true;
    start(env, v);
    env.run(800, ms => v.step(ms));
    ok(v.seeks.length === 0, '正常播放靠近洞:不动');
    // 播放中 readyState 掉下来但时间还在走
    v.readyState = 2;
    env.run(120, ms => v.step(ms));
    ok(v.seeks.length === 0, 'readyState<3 但时间还在走:不动');
    // 短暂停一下(不足 350ms)又继续
    const env2 = makeEnv(), v2 = makeVideo(1204.9, [[1100, 1204.961], [1205.085, 1800]]);
    v2.readyState = 4; v2.playing = true;
    start(env2, v2);
    env2.run(250, ms => v2.step(ms));
    for (let i = 0; i < 5; i++) {
        v2.playing = false; v2.readyState = 2;
        env2.run(200);
        v2.playing = true; v2.readyState = 4;
        env2.run(60, ms => v2.step(ms));
    }
    ok(v2.seeks.length === 0, '反复停不足 350ms 又走:不动', v2.seeks);
}
{
    // 轮询不被一次性事件卡住:hls.js 那边 stallReported 已经用掉(先来一次欠载,没缓冲可跳),之后再遇到小洞,这里照样跳
    const env = makeEnv(), v = makeVideo(100, [[0, 100]]);
    const { hls, w } = start(env, v);
    ok(hls.subs().join() === 'DESTROYING', '只订阅 DESTROYING,不依赖 BUFFER_STALLED_ERROR', hls.subs());
    ok(!/BUFFER_STALLED|bufferStalled/.test(CORE.replace(/\/\/.*$/gm, '')), '核心代码没用 stall 事件');
    env.run(3000);   // 欠载,这段时间 hls.js 已把一次性事件发掉
    v.list = [[0, 200]]; v.playing = true; v.readyState = 4;
    env.run(1000, ms => v.step(ms));
    // 第一个洞
    v.playing = false; v.readyState = 2; v.list = [[0, v._t + 0.1], [v._t + 0.25, 300]];
    env.run(900);
    ok(v.seeks.length === 1, '欠载之后第一个小洞:跳', v.seeks);
    // 走一段,第二个洞(hls.js 的 stalled 被清过、不会再发事件)
    v.playing = true; v.readyState = 4;
    env.run(1000, ms => v.step(ms));
    v.playing = false; v.readyState = 2; v.list = [[0, v._t + 0.1], [v._t + 0.25, 300]];
    env.run(900);
    ok(v.seeks.length === 2 && w.skips.length === 2, '第二个小洞:照样跳', v.seeks);
}
{
    // 连续小洞,每次往前
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.2, 100.25], [100.4, 200]]);
    start(env, v);
    env.run(3000);
    ok(v.seeks.length === 2 && v.seeks[1] > v.seeks[0] && Math.abs(v._t - 100.41) < 1e-9, '一串小洞:逐个往前跳,不来回', v.seeks);
}
{
    // 直播 / 投屏
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    start(env, v, { levels: [{ details: { live: true } }] });
    env.run(5000);
    ok(v.seeks.length === 0, '直播清单:不动(hls.js 自己按 2×目标时长处理)');
    const env2 = makeEnv(), v2 = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    let live = true;
    start(env2, v2, {}, { off: () => live });
    env2.run(5000);
    ok(v2.seeks.length === 0, '站内直播模式 / 投屏(off):不动');
    live = false;
    env2.run(600);
    ok(v2.seeks.length === 1, '退出之后恢复判定');
    // levels 还没就绪
    const env3 = makeEnv(), v3 = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    start(env3, v3, { levels: null });
    env3.run(1000);
    ok(v3.seeks.length === 1, 'hls.levels 拿不到:不影响判定');
}

console.log('④ 不泄漏');
{
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    const { hls, w } = start(env, v);
    ok(env.timers.size === 1 && v.count('waiting') === 1, '起了一个定时器和一个 waiting 监听');
    v.fire('waiting');
    ok(env.timers.size === 2, 'waiting 多一个一次性定时器');
    hls.trigger('DESTROYING');
    ok(env.timers.size === 0 && v.count('waiting') === 0, 'hls 销毁:定时器和监听全清', [env.timers.size, v.count('waiting')]);
    env.run(5000);
    v.fire('waiting');
    w.tick();
    ok(v.seeks.length === 0 && env.timers.size === 0, '销毁之后:什么都不做');
    w.stop();
    ok(env.timers.size === 0, 'stop 重复调用无害');
}
{
    // 切集:新实例接管同一个 <video>
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    const plugins = {};
    const a = makeHls(v); plugins.hls = a;
    const wa = env.dgHoleWatch(a, v, { destroying: 'DESTROYING', gone: () => plugins.hls !== a });
    const b = makeHls(v); plugins.hls = b;   // switchVideo 建了新实例,旧实例要等一会才销毁
    const wb = env.dgHoleWatch(b, v, { destroying: 'DESTROYING', gone: () => plugins.hls !== b });
    env.run(300);
    ok(env.timers.size === 1, '被顶替的实例下一拍自己停:只剩一个定时器', env.timers.size);
    ok(v.count('waiting') === 1, '只剩一个 waiting 监听', v.count('waiting'));
    env.run(600);
    ok(v.seeks.length === 1 && wa.skips.length === 0 && wb.skips.length === 1, '只有当前实例在判定,不跳两次', v.seeks);
    a.trigger('DESTROYING');
    ok(env.timers.size === 1 && v.count('waiting') === 1, '旧实例晚到的销毁不影响新实例');
    b.trigger('DESTROYING');
    ok(env.timers.size === 0 && v.count('waiting') === 0, '新实例销毁:全清');
}
{
    // 反复切集不累积
    const env = makeEnv(), v = makeVideo(0, []);
    for (let i = 0; i < 20; i++) { const h = makeHls(v); env.dgHoleWatch(h, v, { destroying: 'DESTROYING' }); h.trigger('DESTROYING'); }
    ok(env.timers.size === 0 && v.count('waiting') === 0, '切 20 次集:定时器和监听不累积');
}
{
    // hls.media 没了(detach),没有收到销毁事件也要停
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    const { hls } = start(env, v);
    hls.media = null;
    env.run(300);
    ok(env.timers.size === 0 && v.count('waiting') === 0 && v.seeks.length === 0, 'hls.media 变 null:停');
}

console.log('⑤ 异常不外抛');
{
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    Object.defineProperty(v, 'buffered', { get() { throw new Error('InvalidState'); } });
    start(env, v);
    let threw = false;
    try { env.run(2000); } catch (e) { threw = true; }
    ok(!threw && v.seeks.length === 0, 'buffered 读取抛错:吞掉、不跳');
}
{
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    Object.defineProperty(v, 'currentTime', { get() { return 100; }, set() { throw new TypeError('non-finite'); } });
    const { w } = start(env, v);
    let threw = false;
    try { env.run(2000); v.fire('waiting'); env.run(500); } catch (e) { threw = true; }
    ok(!threw && env.timers.size >= 1, 'currentTime 写入抛错:吞掉,下一拍还能再判', w.skips.length);
}
{
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    const { w } = start(env, v, {}, { log() { throw new Error('log'); } });
    let threw = false;
    try { env.run(1000); } catch (e) { threw = true; }
    ok(!threw && v.seeks.length === 1 && w.skips.length === 1, '日志回调抛错:不影响跳转、不外抛');
}
{
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    const { w } = start(env, v, {}, { off() { throw new Error('off'); } });
    let threw = false;
    try { env.run(1000); } catch (e) { threw = true; }
    ok(!threw && v.seeks.length === 0 && !!w, 'off 回调抛错:不跳、不外抛');
}
{
    const env = makeEnv(), v = makeVideo(100, [[0, 100.1], [100.3, 200]]);
    const hls = makeHls(v, { on() { throw new Error('on'); } });
    let threw = false, w = null;
    try { w = env.dgHoleWatch(hls, v, { destroying: 'DESTROYING' }); } catch (e) { threw = true; }
    ok(!threw && !!w && env.timers.size === 0 && v.count('waiting') === 0, 'hls.on 抛错:不启动、不外抛');
    const hls2 = makeHls(v), v2 = makeVideo(1, []);
    Object.defineProperty(hls2, 'levels', { get() { throw new Error('levels'); } });
    v2.list = [[0, 1.1], [1.3, 5]];
    env.dgHoleWatch(hls2, v2, { destroying: 'DESTROYING' });
    let threw2 = false;
    try { env.run(1000); } catch (e) { threw2 = true; }
    ok(!threw2 && v2.seeks.length === 0, 'hls.levels 抛错:不跳、不外抛');
}

console.log('⑥ 和别的逻辑不打架');
// dmResync:同一个 video 上跑真的 <dg-dm-resync-core>,弹幕模块用 DPlayer 同样的 seek 语义(这段还没进代码的版本上跳过;它自己的回归是 danmaku-sync-test)
const resync = /\/\/ <dg-dm-resync-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-dm-resync-core>/.exec(HTML);
if (resync) {
    const { dmResync } = vm.runInNewContext(resync[1] + '\n;({ dmResync });', { parseFloat, Number });
    const env = makeEnv(), v = makeVideo(1204.881, [[1100, 1204.961], [1205.8, 1800]]);
    const dm = {
        dan: Array.from({ length: 2000 }, (_, i) => ({ time: i })), danIndex: 1205, clears: 0, options: { time: () => v.currentTime },
        clear() { this.danIndex = 0; this.clears++; },
        seek() { this.clear(); for (let e = 0; e < this.dan.length; e++) { if (this.dan[e].time >= this.options.time()) { this.danIndex = e; break; } this.danIndex = this.dan.length; } },
    };
    ok(dmResync({ danmaku: dm, video: v }) === true, '装上 dmResync');
    start(env, v);
    env.run(1000);
    ok(v.seeks.length === 1 && v._t > 1205.8, '跳过接近上限的 1s 洞', v.seeks);
    ok(dm.clears === 0, '弹幕不清屏:跳 ≤1s 在 dmResync 的 2 秒容差内', dm.clears);
}
// adClipSkip:抽真的 window.adClipSkip 跑 _onSeeking / check
const resumeM = /\/\/ <dg-resume-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-resume-core>/.exec(HTML);
const skipBody = (resumeM ? resumeM[1] : '') + '\n' + HTML.slice(HTML.indexOf('window.adClipSkip = {'), HTML.indexOf('let _lastProgressSaveTime'));
const AdClipCore = require(path.join(ROOT, 'public/libs/js/ad-clip-core.js'));
function makeSkip(video) {
    const seeks = [];
    const hls = { on() { }, off() { }, trigger() { }, config: { maxBufferLength: 30 } };
    const Hls = { Events: new Proxy({}, { get: (t, k) => String(k) }) };
    const dp = { video, plugins: { hls }, bar: { set() { } }, danmaku: null, events: { trigger() { } }, seek(x) { seeks.push(x); video.currentTime = x; }, notice() { } };
    const win = { AdClipCore, AdFilter: { isEnabled: () => true }, Hls };
    const store = { getItem: () => null, setItem() { } };
    const make = new Function('window', 'AdClipCore', 'dp', 'localStorage', 'sessionStorage', 'performance', '_navSeq', 'console', 'Hls', skipBody + '\nreturn window.adClipSkip;');
    const skip = make(win, AdClipCore, dp, store, store, { now: () => 0 }, 1, { log() { }, warn() { } }, Hls);
    skip.vue = { _playToken: 1, _activePlaySeq: 1, _liveActive: false, _activeKz: null, _isCasting: () => false, _outroSkipped: false, currentSource: { site_key: 'x' } };
    skip.attach(hls, video);
    return { skip, st: hls._adClip, dp };
}
{
    const env = makeEnv(), v = makeVideo(1204.881, [[1100, 1204.961], [1205.8, 1800]]);
    const { skip, st } = makeSkip(v);
    ok(!!st, '抽出真的 adClipSkip 并挂上');
    st.groups = [{ cc: 0, start: 0, end: 1500, dur: 1500, sn0: 0 }];
    st.lastT = 1204.75;   // 卡住之前最后一次 timeupdate
    const before = v.seeks.length;
    start(env, v);
    env.run(1000);
    ok(v.seeks.length === before + 1, '跳了一次(含最长 1s 的洞)', v.seeks);
    ok(st.userSeeked === false, '_onSeeking:<2 秒不算用户拖动(片头贴片的 freshStart 还在)');
    ok(st.lastT === v._t, '_onSeeking:lastT 跟上了(下一次拖动方向不判错)', st.lastT);
    ok(st.selfTo == null, '没有被当成"自己发起的 seek"换算落点');
    void skip;
}
{
    // 刚跳过插播再按 ← 的换算:小洞跳转(向前)不会走到这条路
    const env = makeEnv(), v = makeVideo(640, [[600, 640.1], [640.3, 800]]);
    const { st } = makeSkip(v);
    st.groups = [{ cc: 0, start: 0, end: 625, dur: 625, sn0: 0 }, { cc: 1, start: 625, end: 645, dur: 20, sn0: 100 }, { cc: 2, start: 645, end: 1500, dur: 855, sn0: 104 }];
    st.skipped[1] = [1];
    st.lastT = 640;
    start(env, v);
    env.run(1000);
    ok(v.seeks.length === 1 && Math.abs(v._t - 640.31) < 1e-9, '已跳过的插播范围内出现小洞:向前跳,不触发"往回换算"', v.seeks);
}
{
    // 已判定插播不下载(ac05307):缓冲到段前为止,段后正片已缓冲,中间 20s 大缺口 → 跳过器不碰,交给 adClipSkip
    const env = makeEnv(), v = makeVideo(625, [[600, 625], [645, 700]]);
    const { st } = makeSkip(v);
    st.hopKey = '625';
    start(env, v);
    env.run(5000);
    ok(v.seeks.length === 0, '停在插播大缺口前(段尾 0s):不误跳', v.seeks);
    v._t = 624.9;
    env.run(5000);
    ok(v.seeks.length === 0, '停在插播大缺口前 0.1s:不误跳', v.seeks);
    // 清缓冲路径(_seekPast):BUFFER_FLUSHING 后 video.buffered 留下缺口,等 FLUSHED 才 seek;seek 落点没缓冲时 seeking 一直 true
    const env2 = makeEnv(), v2 = makeVideo(645.1, [[600, 625], [646, 700]]);
    v2.seeking = true;
    start(env2, v2);
    env2.run(5000);
    ok(v2.seeks.length === 0, 'adClipSkip 跳到段后、落点还没缓冲(seeking):不动');
    // 短于 1s 的怪组(AdClipCore minRun 是 0.5s)被绕开时缺口也在 1s 内:向前跳过去,结果和 adClipSkip 一致,落点不进广告
    const env3 = makeEnv(), v3 = makeVideo(625, [[600, 625], [625.8, 700]]);
    start(env3, v3);
    env3.run(1000);
    ok(v3.seeks.length === 1 && Math.abs(v3._t - 625.81) < 1e-9, '绕开不足 1s 的怪组留下的缺口:向前跳到段后', v3.seeks);
}
{
    // 起播看门狗:它看 readyState / currentTime / buffered;没有任何缓冲时跳过器不动,不会改变它的判断
    const env = makeEnv(), v = makeVideo(0, []);
    v.readyState = 0;
    start(env, v);
    env.run(14000);
    ok(v.seeks.length === 0 && v._t === 0, '起播阶段没有缓冲:不动,看门狗照常判死');
    const m = /const hasContent = !v\.error && \(v\.readyState >= 3 \|\| \(v\.currentTime \|\| 0\) > 0\.1 \|\| \(v\.buffered && v\.buffered\.length > 0\)\);/.test(HTML);
    ok(m, '看门狗:有缓冲就算有进展(跳过器动作的前提就是有缓冲,不改变结论)');
}

console.log('⑦ 接线');
{
    const count = (HTML.match(/new Hls\(/g) || []).length;
    ok(count === 1, '全站唯一的 new Hls', count);
    const i0 = HTML.indexOf('window._dgHlsCustomType = function (video, player) {');
    const ct = HTML.slice(i0, HTML.indexOf('function buildOfflineHlsConfig()'));
    ok(i0 > 0 && HTML.indexOf('// <dg-hole-core>') < i0, '核心段定义在 _dgHlsCustomType 之前');
    ok(/hls\.attachMedia\(video\);\s*\n\s*try \{[^\n]*\n\s*hls\._dgHole = dgHoleWatch\(hls, video, \{/.test(ct), 'attachMedia 之后挂(hls.media 已就绪),整段包 try/catch');
    ok(ct.indexOf('new Hls(') < ct.indexOf('dgHoleWatch(') && /destroying: Hls\.Events\.DESTROYING/.test(ct), '销毁事件传进去');
    ok(/gone: \(\) => player\.plugins\.hls !== hls/.test(ct), '被顶替(切集 / 切源)就停');
    ok(/off: \(\) => \{[^\n]*_liveActive[^\n]*_isCasting/.test(ct), '直播模式、投屏不动');
    const nativeBranch = ct.slice(0, ct.indexOf('new Hls('));
    ok(!nativeBranch.includes('dgHoleWatch'), '原生通道不挂(浏览器自己处理)');
    const cfg = /function buildOfflineHlsConfig\(\) \{[\s\S]*?return \{ loader: window\._OfflineHlsLoader, pLoader: window\._CutHlsLoader \|\| window\._OfflineHlsLoader, backBufferLength: 90, maxMaxBufferLength: 120 \};/.test(HTML);
    ok(cfg, 'buildOfflineHlsConfig 返回 backBufferLength:90 + maxMaxBufferLength:120');
    ok(/只减少触发,不能单独解决/.test(HTML), '注释写明 A 不是治本');
    const big = /BIG_BUFFER: (\d+)/.exec(HTML);
    ok(big && +big[1] < 120, 'adClipSkip.BIG_BUFFER 小于前向上限(不受影响)', big && big[1]);
    // 480e6 / 码率 > 120 ⇔ 码率 < 4Mbps;800000 的线路原来是 600,现在 120
    const fwd = (br, base = 30, cap = 120) => Math.min(Math.max(8 * 6e7 / br, base), cap);
    ok(fwd(800000) === 120 && fwd(800000, 30, 600) === 600 && fwd(8e6) === 60 && fwd(0.5e6, 75) === 120, '前向目标按公式算:800kbps 600→120,8Mbps 仍 60');
    ok(!/this\.[a-zA-Z_]+\s*=|vueApp/.test(CORE.replace(/\/\/.*$/gm, '')), '核心段不碰 Vue(每拍不写响应式数据)');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
