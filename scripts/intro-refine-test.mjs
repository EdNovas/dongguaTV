#!/usr/bin/env node
// 跳过片头精修回归(离线、零网络;fixture 是真实片源包络的最小切片,scripts/fixtures/intro/slices.json):
//   node scripts/intro-refine-test.mjs
//  ① M1 尾部判定:静音集数卡要跨过去、没静音的 2s 窗越界要裁掉、响度差不能误裁、长静音和零洞不能跨、慢淡出要跨、正片开头的弱音不能跨
//  ② M2 中段掉窗:莲花楼、嫁金钗 zy360、云之羽 zy360/jisu、长风渡 1080zyk、唐朝诡事录走到真实结尾(2s 窗和粗对齐都不可靠,靠逐秒响度比);平稳段走完不被整段 Pearson 退回(权力的游戏、老友记);帧级抖动走得过去但不推进终点(少年歌行、无忧渡、玉骨遥);差得少且响度对不上的不续(长相思会过跳);公共静音、解码失败的洞都走不过去
//  ③ 定位:误命中(永夜星河第 12 集;别的剧靠一个响度跳变撑到 0.87)不算;两道命中线(主体<20s 要 ≥0.9、conf<0.8 要三项都对)各有只靠它挡住的样本;包络尾部带赞助音频时片头照样算中、终点收回(云之羽第 3/5/7/9 集);解码失败的洞不影响命中
//  ④ M3 窗口截断:藏海传第 1 集片头跨 480s 阶段上限,要多抓一档
//  ⑤ 全流程(真 learnOrDetect,只桩抓取):dur 不含静音延伸,定位 = 起点 + dur + 本集延伸;无 mv 旧标记重新定位一次,重算成 mv:2 后真实 skipManager.check 自动跳;片头贴着窗口尾巴时补抓;顺带定位开头贴片;墓碑;让路不记墓碑;流量上限和中止都还在;解码失败太多不写共享墓碑;换剧竞态和 0 片清单不写墓碑
//  ⑥ 有值的 mv:2 标记不抓、不上报、不变(待确认的也一样,确认不靠多下载);不读写 donggua_afpvote;包络不带 ep
//  ⑦ 综艺变体:真实集名拆成 期号/部分/变体词(第20201217(上)期 里单独的"期"不算残留);配对只用正片,期号不同、部分相同,由近及远;普通电视剧配对不变;变体集不分析;找不到配对不学、不下载、不进 LEARN_BLOCK,借来的包络定位不中才记墓碑(解码失败不记);不分析都留一行判定;上中下不共用
//  ⑧ 第三集确认(真 learnOrDetect):学习对待确认只亮按钮,包络带 pid;学习对之外定位命中才转正,确认绑定这条包络;两个学习对凑集数不能确认;学习对的集再定位不算确认;不多下载
//  ⑨ 开头贴片(真实包络切片 + 真 learnOrDetect + 真 check()):假贴片不中不写(乘风2024 ikun、隐秘的角落 1080zyk、咒术回战 zy360、奔跑吧第八季 jisu);真贴片保住且落点不切正片;只在集首 30s;bmv:2 的旧贴片只亮按钮,集首之外的不亮,不为它重算
// 改片头精修、定位阈值、包络格式后必跑。阈值变动要再回放真实 m3u8(见 memory 的 skip-intro 笔记),这里只防回退。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/intro/slices.json'), 'utf8'));
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); } };
const near = (a, b, d) => Math.abs(a - b) <= d;
const atob_len = (b64) => Buffer.from(b64, 'base64').length;

const coreM = /\/\/ <dg-intro-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-intro-core>/.exec(HTML);
const i0 = HTML.indexOf('if (!window.afpOffline) window.afpOffline = {'), i1 = HTML.indexOf('// ========== 🗨️ 弹幕样式管理器', i0);
if (!coreM || i0 < 0 || i1 < 0) { console.log('✗ 找不到 <dg-intro-core> 或 afpOffline 段'); process.exit(1); }

function makeEnv() {
    const store = new Map();
    const localStorage = { get length() { return store.size; }, key: i => [...store.keys()][i] ?? null, getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
    const win = {}; const posts = [];
    const dp = { video: { paused: false, readyState: 4, currentTime: 20, buffered: { length: 1, start: () => 0, end: () => 9999 } }, notice() { } };
    const conLog = [];
    const fetchStub = async (u, init) => { posts.push({ u: String(u), body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({ env: null }), text: async () => '' }; };
    const ctx = vm.createContext({ window: win, dp, console: { log: (...a) => conLog.push(a.join(' ')), warn: (...a) => conLog.push(a.join(' ')) }, localStorage, navigator: { onLine: true }, fetch: fetchStub, atob: s => Buffer.from(s, 'base64').toString('latin1'), btoa: s => Buffer.from(s, 'latin1').toString('base64'), MessageChannel, setTimeout: (f) => setImmediate(f), URL, Promise, Uint8Array, Float32Array, DataView, Math, Date, JSON, parseInt, parseFloat, isFinite, encodeURIComponent, String, Object, Array, RegExp, Error });
    vm.runInContext(coreM[1] + '\n;globalThis.__core = IntroCore;', ctx);
    vm.runInContext(HTML.slice(i0, i1), ctx);
    return { A: win.afpOffline, C: ctx.__core, posts, localStorage, conLog, dp };
}
const chunks = arr => arr.map(c => ({ st: c.st, rms: Float32Array.from(c.r.map(x => x / 1e5)) }));
const sess = arr => ({ chunks: chunks(arr) });
const F32 = arr => Float32Array.from(arr.map(x => x / 1e5));
const { A, C } = makeEnv();
const IntroCoreCur = (m) => C.curOf(m);
const refine = (name, opt) => { const c = FX[name].coarse; return A._refineRegion(sess(FX[name].A), sess(FX[name].B), (opt && opt.a) || c.a, (opt && opt.b) || c.b, (opt && opt.len) || c.len); };

console.log('① 尾部判定');
{
    let f = refine('jjc_sil');
    ok(near(f.oeA, 101.02, 0.15) && near(f.oeB, 101.02, 0.15), '嫁金钗:静音集数卡跨过去(现状 100,真值 101.02)', f);
    ok(near(f.comA, 100, 0.15), '公共段不含静音延伸(dur 按它算,定位时各集再自己延伸)', f.comA);
    f = refine('yfx_short_sil');
    ok(near(f.oeA, 91.66, 0.15) && near(f.oeB, 91.66, 0.15), '与凤行:1.8s 短静音,2s 窗越界到 93.4,要裁回静音结束(真值 91.66)', f);
    f = refine('gsfh_overflow');
    ok(near(f.oeA, 104.14, 0.2) && near(f.oeB, 104.14, 0.2), '国色芳华:没静音时 2s 窗越界,块能量比裁回(现状 106,真值 104.14)', f);
    f = refine('myyj_loud');
    ok(near(f.oeA, 99.06, 0.15) && near(f.oeB, 99.06, 0.15), '墨雨云间:两集尾部响度差 2 倍,先归一再比,不能退化到 97.2(真值 99.06)', f);

    const tail = (name, end, mut) => { let ch = chunks(FX[name].chunks); if (mut) ch = mut(ch); return A._tailExt({ chunks: ch }, end === undefined ? FX[name].end : end); };
    let x = tail('cxs_fade');
    ok(near(FX.cxs_fade.end + x, FX.cxs_fade.truth, 0.3), '长相思第 12 集:慢淡出 0.003→0.0009 约 2s,跨到真静音结束(真值 102.78)', x);
    x = tail('yfx_weak');
    ok(x === 0, '与凤行第 3 集:正片开头的弱音(0.002 平着走,接着就是对白)不跨', x);
    // 零洞:解码失败的段没有 chunk,不是静音
    x = tail('jjc_hole');
    ok(near(100 + x, 101.02, 0.2), '嫁金钗第 23 集:正常延伸到 101.0', x);
    const dropAfter = (t0, t1) => ch => ch.filter(c => !(c.st > t0 && c.st < t1));
    x = tail('jjc_hole', undefined, dropAfter(99.5, 103));
    ok(100 + x <= 101.2, '嫁金钗第 23 集坏段:零洞不当静音(复核模拟曾到 104.0)', 100 + x);
    x = tail('gsfh_hole', undefined, dropAfter(103.7, 107.2));
    ok(104.2 + x <= 104.8, '国色芳华第 12 集坏段:零洞不当静音(复核模拟曾到 108.0)', 104.2 + x);
    // 静音 ≥6s 不延伸(多半是音频空洞);<6s 照常
    const synth = (silFrames) => { const e = new Float32Array(200), cov = new Uint8Array(200).fill(1); for (let i = 0; i < 200; i++) e[i] = i >= 50 && i < 50 + silFrames ? 0 : 0.1; return { e, cov }; };
    let s = synth(59);
    ok(C.silenceExt(s.e, s.cov, 50) === 59, '静音 5.9s:延伸', C.silenceExt(s.e, s.cov, 50));
    s = synth(60);
    ok(C.silenceExt(s.e, s.cov, 50) === 0, '静音 6.0s:不延伸');
    // 淡出规则的边界
    const seq = (arr) => { const e = Float32Array.from(arr), cov = new Uint8Array(arr.length).fill(1); return { e, cov }; };
    const quiet = Array(30).fill(0);
    let q = seq([0.003, 0.0028, 0.0026, 0.0024, 0.0022, 0.002, 0.0018, 0.0016, 0.0014, 0.0012, 0.0011, 0.0009, 0.0005, ...quiet, 0.1, 0.1]);
    ok(C.silenceExt(q.e, q.cov, 0) > 11, '合成慢淡出:跨', C.silenceExt(q.e, q.cov, 0));
    q = seq([0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.0005, ...quiet, 0.1, 0.1]);
    ok(C.silenceExt(q.e, q.cov, 0) === 0, '平的弱音后接静音:不算淡出(降幅不够)');
    q = seq([0.002, 0.003, 0.0045, 0.007, 0.01, 0.02, 0.05, 0.1, 0.1, 0.1, 0.1]);
    ok(C.silenceExt(q.e, q.cov, 0) === 0, '弱音往上走(正片起音):不跨');
    q = seq([0.2, 0.15, 0.1, 0.05, 0.03, 0.02, 0.01, 0.005, 0.0005, ...quiet, 0.1]);
    ok(C.silenceExt(q.e, q.cov, 0) === 0, '响的声音衰减:不算慢淡出');
    q = seq([0.003, 0.002, 0.0018, 0.0015, 0.0012, 0.0005, 0.0002, 0.1, 0.1]);
    ok(C.silenceExt(q.e, q.cov, 0) === 0, '落进静音不到 0.5s(气口):不跨');
    const pair = (a, b) => ({ eA: Float32Array.from(a), eB: Float32Array.from(b), covA: new Uint8Array(a.length).fill(1), covB: new Uint8Array(b.length).fill(1) });
    const flat = n => Array.from({ length: n }, (_, i) => 0.1 + 0.05 * Math.sin(i / 3));
    let c = pair([...flat(120), 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.1], [...flat(120), 0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.1]);
    let t = C.tailCut(c, 0, 0, 134);
    ok(t.end === 130 && t.why === 'sil', '末窗公共静音:到静音结束', t);
    c = pair([...flat(130), 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], [...flat(130), 0, 0, 0, 0, 0, 0, 0, 0]);
    c.covB.fill(0, 130);
    t = C.tailCut(c, 0, 0, 138);
    ok(t.why === 'hole' && t.end <= 130, '尾部一集是解码失败的洞:比不了,宁少勿多,裁到洞前', t);
    const ca = sess(FX.gsfh_hole.chunks).chunks;
    const cov = C.coverage(ca, 94, 220);
    ok(cov[0] === 1 && cov[100] === 1, 'coverage:有 chunk 的帧是 1');
    const cov2 = C.coverage([{ st: 10, rms: new Float32Array(10) }], 0, 200);
    ok(cov2[99] === 0 && cov2[100] === 1 && cov2[109] === 1 && cov2[112] === 1 && cov2[113] === 0, 'coverage:chunk 尾放宽 0.3s(floor 丢帧不算洞),再往后才算洞', Array.from(cov2.slice(99, 115)));
}

console.log('② 中段掉窗');
{
    let f = refine('lhl_m2');
    ok(f.osA === 0 && near(f.oeA, 100.94, 0.35) && near(f.oeB, 100.94, 0.35), '莲花楼第 10/11 集:续接到真实结尾(现状 45.4,真值 100.94)', f);
    ok(f.headEnv.length >= 990 && near(f.headSec, f.comA - f.osA, 0.11), '包络随公共段一起变长(现状 45.4s,一次误命中要跳掉的正片会放大约 2 倍)', { len: f.headEnv.length, sec: f.headSec });
    f = refine('zy360_m2');
    ok(near(f.oeA, 215.4, 0.2) && near(f.oeB, 101.2, 0.2), '嫁金钗 zy360 第 1/2 集:续接到真实结尾(现状 151.6/37.4,真值 215.4/101.2)', f);
    ok(f.headEnv.length >= 900, '嫁金钗 zy360:包络也跟着变长(现状 30.8s)', f.headEnv.length);
    ok(near(f.osA, 120.8, 0.1), '只往后走,片头起点不动(往前连会把藏海传第 1 集的 46s 正片算进片头)', f.osA);
    f = refine('cxs_guard');
    ok(f.oeA <= 100.8 && f.oeB <= 100.8, '长相思第 10/11 集:只差几秒不算掉窗,不续(续了会到 104.8,多跳进正片)', f);
    // 2s 窗连不起来(差 0.4s 就断)、粗对齐又短的线路:响度比一路对得上,到片头结束才骤降
    f = refine('yzy_zy360');
    ok(near(f.oeA, 94.2, 0.3) && near(f.oeB, 94.2, 0.3) && near(f.headSec, 94, 0.5), '云之羽 zy360 第 10/11 集:2s 窗 33.8-40、40.4-42.8 差 0.4s 也接得上(现状 40,真值 94.2)', f);
    f = refine('zyk_gap');
    ok(near(f.oeA, 106.05, 0.3) && near(f.oeB, 106.05, 0.3), '长风渡 1080zyk 第 10/11 集:10s 窗都掉到 0.38、粗对齐只到 69s,还是走到真实结尾(现状 63.6,真值 106.05)', f);
    f = refine('yzy_jisu');
    ok(near(f.oeA, 100.23, 0.3) && near(f.oeB, 100.23, 0.3), '云之羽 jisu 第 10/11 集:粗对齐只比 2s 段长 7s 也要走(现状 76.2,真值 100.23)', f);
    f = refine('tcgs_hong');
    ok(near(f.oeA, 105.7, 0.4) && near(f.oeB, 105.7, 0.4), '唐朝诡事录 hongniuzy 第 10/11 集:响度比对得上就走(现状 100.4,真值 105.7)', f);
    // 平稳音乐段:走路走对了,不能再被整段 Pearson 退回(走路要解决的正是 Pearson 低)
    f = refine('got_whole');
    ok(near(f.osA, 60.2, 0.2) && near(f.oeA, 91.4, 0.3) && near(f.oeB, 91.7, 0.3), '权力的游戏 zy360 第 3/4 集:走到公共音频结束(现状 72.4,整段 Pearson<0.6 被退回;91s 起逐秒响度比就对不上了,真实片头约到 97~100s,后面这段音频两集不同)', f);
    ok(f.headEnv.length >= 300, '权力的游戏:包络也跟着变长,别的集定位才有得比(现状 12.2s)', f.headEnv.length);
    f = refine('friends_whole');
    ok(near(f.oeA, 103.1, 0.3) && near(f.oeB, 99, 0.3), '老友记 1080zyk 第 5/6 集:走到片头结束(现状 83.1/79.2,真实约 103~105/99~101)', f);
    // 帧级抖动:1s 块比稳定,逐帧随机掉到 0.6 以下
    f = refine('snxg_jitter');
    ok(near(f.oeA, 116.16, 0.3) && near(f.oeB, 116.3, 0.3), '少年歌行 zy360 第 10/11 集:帧级抖动不算断,走到真实结尾(现状 64.9/64.2,真值 116.16)', f);
    ok(f.headEnv.length >= 900, '少年歌行:包络也跟着变长(现状 42s)', f.headEnv.length);
    // 抖动只放行,不推进:±10% 块比当"对得上"的话这几条都会多跳
    f = refine('wyd_tail');
    ok(f.oeA <= 101.5 && f.oeB <= 101.5, '无忧渡 zy360 第 10/11 集:不越过片头尾巴(块比当好会到 108.9)', f);
    f = refine('ygy_tail');
    ok(f.oeA <= 116.8 && f.oeB <= 116.8, '玉骨遥 jisu 第 10/11 集:不越过片头尾巴(块比当好会到 120.7)', f);
    f = refine('dhn_tail');
    ok(f.oeA <= 93.8 && f.oeB <= 93.8, '度华年 hongniuzy 第 10/11 集:不越过片头尾巴(块比当好会到 99,真值 92.9/93.15)', f);
    f = refine('qqrc_tail');
    ok(f.oeA <= 106.6 && f.oeB <= 106.6, '卿卿日常 wujinys 第 10/11 集:不越过片头尾巴(块比当好会到 109.8,真值 105.94)', f);
    // 合成:一拍 5 帧 HLHLL,错一帧逐帧只有 20% 贴合,错一帧容忍后 100%,1s 均值不变
    const beat = i => [0.18, 0.02, 0.18, 0.02, 0.02][i % 5];
    const walkOf = (...segs) => {
        const a = [], b = [];
        for (const [kind, sec] of segs) for (let k = 0; k < sec * 10; k++) {
            const i = a.length;
            if (kind === 'anti') { a.push(i % 10 < 5 ? 0.18 : 0.02); b.push(i % 10 < 5 ? 0.02 : 0.18); continue; }   // 块比相等,形状相反
            a.push(beat(i));
            b.push(kind === 'same' ? beat(i) : kind === 'jit' ? beat(i + 1) : kind === 'loud' ? beat(i + 1) * 1.2 : 0.6);
        }
        return C.levelWalk({ eA: Float32Array.from(a), eB: Float32Array.from(b), covA: new Uint8Array(a.length).fill(1), covB: new Uint8Array(b.length).fill(1) }, 0, 100, a.length, 0);
    };
    ok(walkOf(['same', 30], ['jit', 20], ['same', 20], ['diff', 20]) === 710, 'levelWalk:帧级抖动走得过去,终点落在后面真对得上的秒上', walkOf(['same', 30], ['jit', 20], ['same', 20], ['diff', 20]));
    ok(walkOf(['same', 30], ['jit', 20], ['diff', 20]) === 310, 'levelWalk:帧级抖动本身不推进终点(块比当好会多跳)', walkOf(['same', 30], ['jit', 20], ['diff', 20]));
    ok(walkOf(['same', 30], ['diff', 1], ['jit', 1], ['diff', 1], ['same', 20]) === 310, 'levelWalk:抖动夹着的两个坏秒照样停(抖动不清坏秒计数)', walkOf(['same', 30], ['diff', 1], ['jit', 1], ['diff', 1], ['same', 20]));
    ok(walkOf(['same', 30], ['anti', 2], ['same', 20]) === 310, 'levelWalk:1s 块比相等但形状对不上,不算抖动', walkOf(['same', 30], ['anti', 2], ['same', 20]));
    ok(walkOf(['same', 30], ['loud', 2], ['same', 20]) === 310, 'levelWalk:错一帧贴得上但响度差 20%,不算抖动', walkOf(['same', 30], ['loud', 2], ['same', 20]));
    // 走不过公共静音:静音后面的相关只可能是巧合
    const y = FX.yfx_short_sil, sa = sess(y.A), sb = sess(y.B), from = 60;
    const ea = A._localEnv(sa, from, 120), eb = A._localEnv(sb, from, 120);
    const ctx = { eA: ea, eB: eb, covA: C.coverage(sa.chunks, from, ea.length), covB: C.coverage(sb.chunks, from, eb.length) };
    const silAt = 915 - from * 10;   // 片头结束的静音从 91.5s 附近开始(真值 91.66)
    const en = C.levelWalk(ctx, 0, silAt - 10, ea.length, ea.length);
    ok(from + en / 10 <= 92.6, '与凤行:公共静音挡路,不往后走', from + en / 10);
    // 解码失败的洞走不过去;不缩短已确认的部分
    const z = FX.yzy_zy360, zs = sess(z.A), zt = sess(z.B), ze = A._localEnv(zs, 0, 120), zf = A._localEnv(zt, 0, 120);
    const zc = { eA: ze, eB: zf, covA: C.coverage(zs.chunks, 0, ze.length), covB: C.coverage(zt.chunks, 0, zf.length) };
    ok(near(C.levelWalk(zc, 0, 262, ze.length, 0) / 10, 94, 1.2), 'levelWalk:一路走到片头结束', C.levelWalk(zc, 0, 262, ze.length, 0) / 10);
    const holed = { ...zc, covB: Uint8Array.from(zc.covB) };
    holed.covB.fill(0, 500, 560);
    ok(near(C.levelWalk(holed, 0, 262, ze.length, 0) / 10, 50, 1.2), 'levelWalk:解码失败的洞不算对得上,停在洞前', C.levelWalk(holed, 0, 262, ze.length, 0) / 10);
    ok(C.levelWalk(zc, 0, 1050, ze.length, 0) === 1050, 'levelWalk:走不动就原样返回,不缩短');
    ok(C.levelWalk(zc, 0, 262, 300, 0) <= 300, 'levelWalk:不超过上限');
}

console.log('③ 误命中');
{
    const fa = FX.yyxh_false, env = F32(fa.env), hay = F32(fa.sess);
    const loose = A._xcorrDetect(env, hay, hay.length);
    ok(loose && near(fa.from + loose.at / 10, fa.oldAt, 0.3) && loose.conf < 0.75, '永夜星河第 12 集:旧阈值 0.6 命中 571.9(conf 0.66,抽帧全是正片)', loose);
    ok(A._xcorrDetect(env, hay, hay.length, C.HIT_CONF) === null, '永夜星河第 12 集:新阈值不再命中');
    ok(C.HIT_CONF === 0.8, '命中线 0.8(样本里真命中都 ≥0.90,唯一误命中 0.66)。改它要重新回放真实 m3u8', C.HIT_CONF);
    const tr = FX.lhl_true, hit = A._xcorrDetect(F32(tr.env), F32(tr.sess), tr.sess.length, C.HIT_CONF);
    ok(hit && hit.at === 0 && hit.conf >= 0.85, '莲花楼第 12 集:延长后的 101s 包络照样命中(conf ≥0.85)', hit);
    ok(/_xcorrDetect\(saved\.oenv, sess\.env, sess\.n\)/.test(HTML), '片尾定位阈值没动(片尾算法不在这次改动里)');
    // 包络变长之后别的集照样定位得到:少年歌行旧的 42s 包络第 12 集还多收回 4.4s,第 11 集因此和已有的值判成冲突;老友记旧的 10.8s 包络第 7 集不中,写墓碑后没有按钮
    const sl = FX.snxg_loc, senv = F32(sl.env);
    for (const [k, at] of [['ep11', 21.8], ['ep12', 21.8], ['ep13', 22.5]]) {
        const h = F32(sl[k]), hit = C.locate(senv, h, h.length);
        ok(hit && near(hit.at / 10, at, 0.2) && hit.len === senv.length, '少年歌行 92s 包络:' + k + ' 命中,尾部不收回', hit);
    }
    const fl7 = FX.friends_loc, fenv = F32(fl7.env), fhit = C.locate(fenv, F32(fl7.ep7), fl7.ep7.length);
    ok(fhit && near(fhit.at / 10, 66.6, 0.2) && fhit.len === fenv.length, '老友记 31s 包络:第 7 集命中(平稳段 Pearson 只有 0.78,靠响度比和子窗)', fhit);
    ok(C.locate(env, hay, hay.length) === null, '永夜星河第 12 集:locate 不命中');
    const lt = C.locate(F32(tr.env), F32(tr.sess), tr.sess.length);
    ok(lt && lt.at === 0 && lt.len === tr.env.length, '莲花楼第 12 集:locate 命中,尾部对得上,不收回', lt);

    // 别的剧:一个响度跳变把整段 Pearson 撑高
    const ng = FX.neg_step, nenv = F32(ng.env), nhay = F32(ng.sess);
    const nold = A._xcorrDetect(nenv, nhay, nhay.length, 0.8);
    ok(nold && nold.conf >= 0.8, '别的剧:只看整段 Pearson 能到 0.8 以上', nold);
    ok(C.locate(nenv, nhay, nhay.length) === null, '别的剧:子窗不相关,locate 不算中');
    // 主体不到 20s:子窗没几个,要 ≥0.9 才算(13.2s 包络在别的剧头部能到 0.86)
    {
        const mk = (noise) => { const a = [], b = []; for (let i = 0; i < 150; i++) { const v = 0.1 + 0.05 * Math.sin(i / 3) + 0.03 * Math.sin(i / 7); a.push(v); b.push(v + noise * (i % 2 ? 1 : -1)); } for (let i = 0; i < 300; i++) b.push(0.1 + 0.05 * Math.cos(i / 11)); return { a: Float32Array.from(a), b: Float32Array.from(b) }; };
        const ok1 = mk(0), bad1 = mk(0.05);
        const rA = C.locate(ok1.a, ok1.b, ok1.b.length), rB = C.locate(bad1.a, bad1.b, bad1.b.length);
        ok(rA && rA.at === 0, '短包络:几乎一样,算中', rA);
        ok(rB === null || rB.conf >= 0.9, '短包络:相关不够 0.9,不算中', rB);
    }

    // 两道命中线:主体<20s 要 ≥0.9,否则 conf<0.8 要三项都对。上面的用例都被别的关卡先挡住了,这两道线同时去掉也全过,所以单独钉。
    //   真实样本是别的剧的包络滑到别的剧上(25198 对里挑的),其它关卡全过,只靠这一道线。真实样本内层三项总是一起不过,单项只能靠合成钉
    const nc = FX.neg_conf09, ncE = F32(nc.env), ncS = F32(nc.sess), ncP = C.pearson(ncE, 0, ncS, nc.at, ncE.length);
    ok(ncP >= 0.85 && ncP < 0.9, nc.src + ':整段 Pearson 在 0.85~0.9 之间(这条样本走得到主体<20s 那道线)', ncP);
    ok(C.locate(ncE, ncS, ncS.length) === null, nc.src + ':主体<20s,conf ' + nc.conf + ' 不算中');
    for (const k of ['neg_hitconf', 'neg_hitconf2']) {
        const n = FX[k];
        ok(C.locate(F32(n.env), F32(n.sess), n.sess.length) === null, n.src + ':conf ' + n.conf + ' 低于命中线,不算中');
    }
    {
        const rng = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
        const wave = i => 0.1 * (1 + 0.2 * Math.sin(i / 5));
        const after = r => Array.from({ length: 15 }, () => 0.1 + 0.03 * r());
        const F = (a, b, r) => { b.push(...after(r)); return { a: Float32Array.from(a), b: Float32Array.from(b) }; };
        // conf 由噪声控制,响度比和子窗都贴合
        const base = (L, noise) => { const r = rng(7), a = [], b = []; for (let i = 0; i < L; i++) { a.push(wave(i)); b.push(wave(i) + noise * (r() * 2 - 1)); } return F(a, b, r); };
        // 前 60% 贴合,后 40% 形状不相关;一个小台阶把整段撑到 0.6 以上:子窗过半但不到 70%
        const halfSub = () => { const r = rng(11), a = [], b = [], L = 500, cut = 300; for (let i = 0; i < L; i++) { const x = 0.1 + (i < cut ? 0 : 0.004) + 0.008 * Math.sin(i / 3); a.push(x); b.push(i < cut ? x : 0.1 + 0.004 + 0.008 * (r() * 2 - 1)); } return F(a, b, r); };
        // 每 7 秒有一秒响度差 1.5 倍:形状还对,逐秒响度比不到 90%
        const offSecs = () => { const r = rng(13), a = [], b = [], L = 500; for (let i = 0; i < L; i++) { const x = wave(i), sec = Math.floor(i / 10), off = sec % 7 === 2 && sec < 44; a.push(x); b.push((off ? x * 1.5 : x) + 0.01 * (r() * 2 - 1)); } return F(a, b, r); };
        const loc = s => C.locate(s.a, s.b, s.b.length);
        let s = base(150, 0.01), r = loc(s);
        ok(r && r.at === 0 && r.conf >= 0.9, '合成,主体 15s:conf 0.93 算中', r);
        s = base(150, 0.013);
        ok(loc(s) === null && C.pearson(s.a, 0, s.b, 0, 150) >= 0.85, '合成,主体 15s:conf 0.88 不算中', C.pearson(s.a, 0, s.b, 0, 150));
        s = base(400, 0.024); r = loc(s);
        ok(r && r.at === 0 && r.conf < C.HIT_CONF && r.len === 400, '合成,主体 40s:conf 0.69 但响度比和子窗全对,算中(平稳音乐段)', r);
        s = base(250, 0.024);
        ok(loc(s) === null && C.pearson(s.a, 0, s.b, 0, 250) >= 0.6, '合成,主体 25s:同样 conf 0.70,主体不到 30s 不算中');
        s = halfSub();
        ok(loc(s) === null && C.pearson(s.a, 0, s.b, 0, 500) >= 0.6, '合成,主体 50s:conf 0.66 子窗不到 70%,不算中');
        s = offSecs();
        ok(loc(s) === null && C.pearson(s.a, 0, s.b, 0, 500) >= 0.6, '合成,主体 50s:conf 0.63 逐秒响度比不到 90%,不算中');
        // 同一段 judge 里挨着的两道线:0.6 底线、子窗过半
        const ramped = () => { const a = [], b = [], L = 500; for (let i = 0; i < L; i++) { const x = 0.1 * (1 + 0.1 * Math.sin(i / 5)); a.push(x); b.push(x + 0.042 * (i / L - 0.5)); } return F(a, b, rng(3)); };
        s = ramped(); const rp = C.pearson(s.a, 0, s.b, 0, 500);
        ok(loc(s) === null && rp >= 0.4 && rp < 0.6, '合成,主体 50s:子窗和响度比全对,conf 低于 0.6 还是不算中', rp);
        const stepOnly = () => { const r = rng(5), a = [], b = [], L = 500; for (let i = 0; i < L; i++) { const lv = i < 250 ? 0.1 : 0.16; a.push(lv + 0.004 * (r() * 2 - 1)); b.push(lv + 0.004 * (r() * 2 - 1)); } return F(a, b, r); };
        s = stepOnly(); const sp = C.pearson(s.a, 0, s.b, 0, 500);
        ok(loc(s) === null && sp >= C.HIT_CONF, '合成,主体 50s:一个响度台阶撑到 conf≥0.8,子窗不相关,不算中', sp);
    }

    // 包络尾部带赞助音频:云之羽第 14/15 集学到 44→105.8,第 3/5/7/9 集片头相同,100.1 处接的是别的广告
    const yt = FX.yzy_tail, yenv = F32(yt.env);
    for (const k of ['ep3', 'ep5', 'ep7', 'ep9']) {
        const h = F32(yt[k]), loose = A._xcorrDetect(yenv, h, h.length, 0);
        const hit = C.locate(yenv, h, h.length);
        ok(hit && near(yt.from + hit.at / 10, yt.at, 0.15), '云之羽第 14/15 集包络:' + k + ' 片头照样算中(整段只有 ' + loose.conf.toFixed(2) + ')', hit);
        ok(hit && hit.len < yenv.length && near(yt.from + (hit.at + hit.len) / 10, yt.truth, 1.2), '云之羽第 14/15 集包络:' + k + ' 终点收回到赞助音频之前(真值 100.1)', hit && yt.from + (hit.at + hit.len) / 10);
    }
    // 跨空洞续接的部分也进包络,核对得到:第 10 集没有那段广告,不能盲跳 133.6
    const cb = FX.cfd_blind, chit = C.locate(F32(cb.env), F32(cb.ep10), cb.ep10.length);
    ok(chit && chit.len < cb.env.length && near((chit.at + chit.len) / 10, cb.truth, 1.2), '长风渡第 1/2 集包络 → 第 10 集:收回到 106s(现状盲跳 133.6)', chit);

    // 解码失败的洞:跳过无覆盖的帧再比
    const hh = Float32Array.from(F32(tr.sess)), cov = new Uint8Array(hh.length).fill(1);
    hh.fill(0, 400, 480); cov.fill(0, 400, 480);
    const lc = A._xcorrDetect(F32(tr.env), hh, hh.length, 0);
    const hc = C.locate(F32(tr.env), hh, hh.length, cov);
    ok(lc && lc.conf < 0.97 && hc && hc.at === 0 && hc.conf >= 0.85 && hc.len === tr.env.length, '片头中段坏 8s:跳过洞再比,照样命中,终点不动', { lc, hc });
    const allHole = new Uint8Array(hh.length);
    ok(C.locate(F32(tr.env), hh, hh.length, allHole) === null, '全是洞:比不了,不算中');
}

// ---------- 全流程桩 ----------
const makeFlow = (data, opts = {}) => {
    const env = makeEnv(), a = env.A, urls = { a: 'u:a', b: 'u:b', c: 'u:c' };
    const fetchCalls = [];
    const byUrl = u => data[u[2]] ? chunks(data[u[2]]) : [];
    a._mkFetch = () => { const F = async () => ({ ok: true }); F.channel = opts.ch || 'r'; F.playlist = F; return F; };
    a._resolveMedia = async (u) => ({ origBase: u, text: '#EXTM3U' });
    const fill = (sess, from, to) => {
        fetchCalls.push({ url: sess.url, from, to });
        if (opts.onFetch) opts.onFetch(sess, from, to);
        const all = byUrl(sess.url); let any = false;
        for (const c of all) {
            if (c.st < from - 0.01 || c.st >= to) continue;
            any = true; sess.chunks.push(c);
            let idx = Math.round((c.st - (sess.baseStart || 0)) * 10), last = 0;
            for (let k = 0; k < c.rms.length && idx < sess.env.length; k++, idx++) { if (idx >= 0) last = sess.env[idx] = c.rms[k]; }
            if (idx >= 0 && idx < sess.env.length && !sess.env[idx]) sess.env[idx] = last;   // 与真实 _fetchEnvRange 一样补一帧边界零
            if (idx > sess.n) sess.n = idx;
        }
        a._mb += 10;
        return all.some(c => c.st >= to);
    };
    a._fetchEnvTo = async (sess, F, cap) => { if (!sess.text) { sess.base = sess.url; sess.text = 'x'; } if (cap <= sess.filled) return true; const from = sess.filled; sess.filled = cap; return fill(sess, from, cap); };
    a._fetchEnvRange = async (sess, F, from, to) => fill(sess, from, to);
    const marks = opts.marks || {}, ups = [];
    const partOf = (list, urlKey) => { const x = list && env.C.epInfoOf(list, urls[urlKey]); return x ? x.part : 0; };
    const vue = (ep, urlKey, list) => ({
        _playToken: 1, _liveActive: false, currentSource: { site_key: 'S' }, currentGroup: { name: 'T' }, currentUrl: urls[urlKey],
        _introMarks: { key: 'T|S', at: Date.now(), marks },
        _introMarkGet(e, p) { return marks[e + '|r' + (p ? '|' + p : '')] || (p ? null : marks[e]) || (opts.needOutro ? null : { os: 0, oe: 0, ed: 99999 }); }, _introMarkSet(e, r, p) { marks[e + '|r' + (p ? '|' + p : '')] = r; }, _introEpNum() { return ep; }, _introEpPart() { return partOf(list, urlKey); }, _introChannel() { return 'r'; }, _introCur: null,
        _introUpload(t, s, e, os, oe, bump, ed, dur, extra) { ups.push({ ep: e, os, oe, ...(bump ? { bump } : {}), ...(ed ? { ed } : {}), ...(extra ? JSON.parse(JSON.stringify(extra)) : {}) }); },
    });
    const run = async (ep, urlKey, sibEp, sibKey) => {
        const epList = [{ name: '第' + ep + '集', url: urls[urlKey] }]; if (sibKey) epList.push({ name: '第' + sibEp + '集', url: urls[sibKey] });
        const V = vue(ep, urlKey, epList);
        await a.learnOrDetect({ vue: V, title: 'T', site: 'S', ep, epList });
        return V;
    };
    // 用真实集名跑:names=[集名...],urlKeys 按字母顺序对应数据(a,b,c...),idx=正在看的那一集
    const runNames = async (names, idx) => {
        const epList = names.map((name, i) => { const k = String.fromCharCode(97 + i); urls[k] = urls[k] || 'u:' + k; return { name, url: urls[k] }; });
        const key = String.fromCharCode(97 + idx), info = env.C.epInfos(epList)[idx];
        const V = vue(info.ep, key, epList);
        await a.learnOrDetect({ vue: V, title: 'T', site: 'S', ep: info.ep, epList });
        return V;
    };
    return { ...env, run, runNames, ups, marks, fetchCalls };
};
const J = FX.jjc_flow;
const shift = (arr, d) => arr.map(c => ({ ...c, st: c.st + d }));
// 真实 skipManager.check:把一集从头播到 900 秒,记下 dp.seek 和亮过的按钮(开着自动跳过)
const smI0 = HTML.indexOf('window.skipManager = {'), smI1 = HTML.indexOf('\n                                };', smI0);
if (smI0 < 0 || smI1 < 0) { console.log('✗ 找不到 skipManager 段'); process.exit(1); }
function playCheck(cur) {
    const seeks = [], btn = new Set();
    const video = { duration: 2700, seeking: false, currentTime: 0 };
    const dp = { video, seek(t) { seeks.push(t); video.currentTime = t; }, notice() { }, events: { trigger() { } } };
    const vue = { _introCur: cur, introSkipAuto: true, introSkipShow: true, introBtn: { show: false }, _introRenderBtn() { if (vue.introBtn.show) btn.add(vue.introBtn.kind); }, _outroNextEp() { return true; } };
    const win = {};
    new Function('window', 'dp', 'console', 'IntroCore', HTML.slice(smI0, smI1) + '\n};').call(vue, win, dp, { log() { } }, C);
    for (let t = 0; t <= 900; t += 0.25) { if (video.currentTime > t) t = video.currentTime; video.currentTime = t; win.skipManager.check(t); }
    return { seeks, btn: [...btn].sort().join() };
}

console.log('④ 窗口截断');
{
    const fl = makeFlow({ a: FX.chz_edge.A, b: FX.chz_edge.B });
    await fl.run(1, 'a', 2, 'b');
    const a = fl.ups.find(u => u.ep === 1), b = fl.ups.find(u => u.ep === 2);
    ok(a && b && a.oe >= 486 && a.oe <= 489.7, '藏海传第 1 集:公共段贴着 480s 窗尾,再抓一档(现状 481.8,真值 489.62)', a);
    ok(b && b.oe >= 93 && b.oe <= 94.3, '藏海传第 2 集:不再被窗口截断(现状 85.4,真值 93.18)', b);
    ok(fl.fetchCalls.some(c => c.url === 'u:a' && c.to === 600), '确实多抓了一档', fl.fetchCalls.map(c => c.to));
    ok(fl.conLog.some(s => /贴着窗口尾部/.test(s)), '控制台说明了为什么多抓');
    const short = makeFlow({ a: J.A, b: J.B });
    await short.run(21, 'a', 22, 'b');
    ok(!short.fetchCalls.some(c => c.to > 240), '片头没碰窗尾:还是只抓 240s(不多花流量)', short.fetchCalls.map(c => c.to));
}

console.log('⑤ 全流程');
{
    // 学习 → 定位
    const fl = makeFlow({ a: J.A, b: J.B, c: J.C });
    await fl.run(21, 'a', 22, 'b');
    const a = fl.ups.find(u => u.ep === 21), b = fl.ups.find(u => u.ep === 22);
    ok(a && b && near(a.oe, 101.02, 0.2) && near(b.oe, 101.02, 0.2) && a.mv === 2 && b.mv === 2, '学习:两集都带 mv:2,落点到静音结束', { a, b });
    ok(a.pend === 1 && b.pend === 1 && a.pid && a.pid === b.pid, '学习:两集都待确认,带同一个学习对 id', { a, b });
    const saved = fl.A._st['T|S'].intro;
    ok(saved && near(saved.dur, 100 - a.os, 0.2) && saved.env.length === Math.round(saved.sec * 10), 'dur = 公共段长度,不含静音延伸;包络长度和 sec 一致(服务器校验)', { dur: saved.dur, sec: saved.sec });
    const rec = JSON.parse(fl.localStorage.getItem('donggua_afpenv|T|S'));
    ok(rec.v === 2 && rec.dv === 2 && Math.abs(Math.floor(rec.d.length * 3 / 4) / 10 - rec.sec) <= 3 && rec.sec >= 10, '存下的包络过得了服务器校验', { sec: rec.sec, dv: rec.dv });
    const n0 = fl.ups.length;
    await fl.run(23, 'c');
    const c = fl.ups.slice(n0).find(u => u.ep === 23);
    ok(c && near(c.oe, 101.02, 0.25) && c.mv === 2 && !c.pend && c.pid === a.pid, '定位:起点 + dur + 本集延伸,学习对之外命中不再待确认', c);
    ok(near(fl.marks['23|r'].oe, c.oe, 0.01) && fl.marks['23|r'].mv === 2, '定位结果写进本地缓存,带 mv:2', fl.marks['23|r']);

    // 旧标记:继续有值,重算完替换;定位不中记墓碑,旧值留着
    const makeOldFlow = () => {
        const fl = makeFlow({ c: J.C }, { marks: { '23|r': { os: 0, oe: 100, v: 1, src: 'auto', ed: 99999 } } });
        fl.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
        return fl;
    };
    const o = makeOldFlow();
    await o.run(23, 'c');
    ok(o.ups[0] && near(o.ups[0].oe, 101.02, 0.25) && o.marks['23|r'].mv === 2, '旧标记(无 mv):重算后被替换', o.ups[0]);
    const oc = o.fetchCalls.length, ou = o.ups.length;
    o.A._epDone = {};
    await o.run(23, 'c');
    ok(o.fetchCalls.length === oc && o.ups.length === ou, '旧标记只重新定位一次:变成 mv:2 之后新会话不再抓、不再报', { calls: o.fetchCalls.length, ups: o.ups.length });
    // 旧标记只亮按钮,重算成 mv:2 才生效
    let pc = playCheck({ os: 0, oe: 100, v: 9, src: 'auto' });
    ok(pc.seeks.length === 0 && pc.btn === 'op', '旧标记(不管多少票):真实 check() 不 seek,只亮按钮', pc);
    const oldCur = await makeOldFlow().run(23, 'c');
    pc = playCheck(oldCur._introCur);
    ok(oldCur._introCur.src === 'afp' && oldCur._introCur.mv === 2 && near(oldCur._introCur.oe, 101.02, 0.25) && pc.seeks.length === 1 && near(pc.seeks[0], oldCur._introCur.oe, 0.01), '旧标记重算成 mv:2:这一集可以自动跳', { cur: oldCur._introCur, pc });
    const firstFl = makeFlow({ c: J.C });
    firstFl.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
    const firstCur = await firstFl.run(23, 'c');
    pc = playCheck(firstCur._introCur);
    ok(firstCur._introCur.src === 'afp' && pc.seeks.length === 1 && near(pc.seeks[0], firstCur._introCur.oe, 0.01), '学习对之外的集,本机定位命中:本会话自动跳', { cur: firstCur._introCur, pc });
    ok(!('src' in firstFl.marks['23|r']) && firstFl.marks['23|r'].mv === 2, 'src:afp 只活在本会话,缓存里是 mv:2', firstFl.marks['23|r']);

    const m = makeFlow({ c: FX.jjc_flow.A.slice(0, 1) }, { marks: { '23|r': { os: 314, oe: 357.5, v: 3, src: 'auto', ed: 99999 } } });
    m.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
    await m.run(23, 'c');
    ok(m.ups.length === 1 && m.ups[0].miss === 1 && m.ups[0].mv === 2 && !(m.ups[0].oe > 0), '定位不中:上报墓碑,不夹带时间', m.ups);
    ok(m.marks['23|r'].oe === 357.5 && m.marks['23|r'].miss === 1, '定位不中:旧值留着亮按钮', m.marks['23|r']);
    pc = playCheck(IntroCoreCur(m.marks['23|r']));
    ok(pc.seeks.length === 0 && pc.btn === 'op', '定位不中:墓碑留着的旧值,真实 check() 只亮按钮', pc);
    const n2 = m.fetchCalls.length;
    m.A._epDone = {};
    await m.run(23, 'c');
    ok(m.fetchCalls.length === n2, '有墓碑的集:新会话不再重抓');

    // 学不出:两集记墓碑,新会话不再冷启动
    const no = makeFlow({ a: J.A.slice(0, 2), b: J.C.slice(-2) });
    await no.run(10, 'a', 11, 'b');
    const t = no.ups.filter(u => u.miss === 2).map(u => u.ep).sort();
    ok(t.join() === '10,11', '学不出:这一对记墓碑(kind 2)', no.ups);
    const nf = no.fetchCalls.length;
    no.A._st = {}; no.A._epDone = {};
    await no.run(10, 'a', 11, 'b');
    ok(no.fetchCalls.length === nf, '学不出的集:新会话不再冷启动');
    no.marks['12|r'] = { os: 0, oe: 0, mv: 2, miss: 2, mt: Date.now(), ed: 99999 };
    no.A._st = {}; no.A._epDone = {};
    await no.run(13, 'a', 14, 'b');
    ok(no.fetchCalls.length === nf, '本线路 ≥3 集学不出:别的集也不再冷启动');

    // 借用的包络没中:本来就不会冷启动的集要记墓碑(否则每个会话拿借来的包络重抓一遍);会冷启动的,学不出时直接记 3
    const bw = makeFlow({ c: FX.jjc_flow.A.slice(0, 1) }, { marks: { '23|r': { os: 0, oe: 0, mv: 2, miss: 2, mt: Date.now(), ed: 99999 } } });
    bw.A._st['T|S'] = { phase: 'learned', tries: 0, intro: { ...saved, iB: 1 }, outroTries: 0, mb: 0, envFetched: 1 };
    await bw.run(23, 'c');
    ok(bw.ups.length === 1 && bw.ups[0].miss === 3 && bw.marks['23|r'].miss === 3 && bw.fetchCalls.length >= 1, '学不出的集借包络也没中:记 3,不冷启动', { ups: bw.ups, calls: bw.fetchCalls.length });
    const nb = bw.fetchCalls.length;
    bw.A._epDone = {}; bw.A._st = {};
    await bw.run(23, 'c');
    ok(bw.fetchCalls.length === nb, '记完 3 新会话不再抓');
    const bl = makeFlow({ c: FX.jjc_flow.A.slice(0, 1), b: J.C.slice(-1) }, {});
    bl.A._st['T|S'] = { phase: 'idle', tries: 0, intro: { ...saved, iB: 1 }, outroTries: 0, mb: 0, envFetched: 1 };
    await bl.run(23, 'c', 24, 'b');
    ok(bl.ups.find(x => x.ep === 23).miss === 3 && bl.ups.find(x => x.ep === 24).miss === 2, '借用没中回退冷启动也学不出:本集 3、邻集 2', bl.ups);

    // 旧 src:manual:和别的旧值一样,要重算,命中后被覆盖,没有手动优先
    const man = makeFlow({ c: J.C }, { marks: { '23|r': { os: 0, oe: 90, v: 9, src: 'manual', ed: 99999 } } });
    man.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
    await man.run(23, 'c');
    ok(man.fetchCalls.length > 0 && man.ups[0] && near(man.ups[0].oe, 101.02, 0.25) && man.marks['23|r'].mv === 2 && !('src' in man.marks['23|r']), '旧 src:manual:照常重算,被新算法覆盖', man.ups);
    const manMiss = makeFlow({ c: FX.jjc_flow.A.slice(0, 1) }, { marks: { '23|r': { os: 0, oe: 90, v: 9, src: 'manual', ed: 99999 } } });
    manMiss.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
    await manMiss.run(23, 'c');
    ok(manMiss.ups[0] && manMiss.ups[0].miss === 1 && manMiss.marks['23|r'].oe === 90 && manMiss.marks['23|r'].miss === 1, '旧 src:manual 定位不中:记墓碑,值留着亮按钮', manMiss.marks['23|r']);

    // 让路/中止:什么都不记
    const ab = makeFlow({ a: J.A, b: J.B }, { onFetch: () => { throw new Error('播放缓冲不足,分析让路'); } });
    await ab.run(21, 'a', 22, 'b');
    ok(ab.ups.length === 0 && !ab.A._epDone['T|S|21'] && ab.A._st['T|S'].phase === 'idle' && ab.A._busy === false, '让路:不记墓碑、不记完成,下次还能试', { ups: ab.ups, st: ab.A._st['T|S'].phase });
    const ab2 = makeFlow({ c: J.C }, { marks: { '23|r': { os: 0, oe: 100, v: 1, src: 'auto', ed: 99999 } }, onFetch: () => { throw new Error('播放需要带宽,分析已让路'); } });
    ab2.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
    await ab2.run(23, 'c');
    ok(ab2.ups.length === 0 && ab2.marks['23|r'].oe === 100 && !ab2.marks['23|r'].miss, '定位被让路打断:旧标记原样,不记墓碑');

    // 定位:尾部对不上,收回终点;长相思例外(包络结束处本集接静音,片头还是在那结束)
    const ts = makeFlow({ c: FX.yzy_tail.chunks3 });
    ts.A._st['T|S'] = { phase: 'learned', tries: 0, intro: { env: F32(FX.yzy_tail.env), sec: FX.yzy_tail.env.length / 10, dur: FX.yzy_tail.dur, maxStart: 44 }, outroTries: 0, mb: 0 };
    await ts.run(3, 'c');
    ok(ts.ups[0] && near(ts.ups[0].os, 44, 0.2) && near(ts.ups[0].oe, 100.1, 1.2) && ts.ups[0].mv === 2 && !ts.ups[0].miss, '云之羽第 3 集:尾部带赞助音频的包络也能定位,落点是本集片头结束(现状写墓碑)', ts.ups);
    ok(ts.conLog.some(x => /包络尾部对不上,收回/.test(x)), '控制台说明了收回多少');
    const cx = FX.cxs_tail, ct = makeFlow({ c: cx.chunks });
    ct.A._st['T|S'] = { phase: 'learned', tries: 0, intro: { env: F32(cx.env), sec: cx.sec, dur: cx.dur, maxStart: 54 }, outroTries: 0, mb: 0 };
    await ct.run(12, 'c');
    ok(ct.ups[0] && near(ct.ups[0].oe, cx.truth, 0.5), '长相思第 12 集:尾部音频不同但结束处接静音,不收回(真值 102.78)', ct.ups);

    // 片头贴着已抓窗口尾巴:补抓一小段,静音延伸才看得到声音恢复。J.C 平移 140s:公共段在 240s 结束,静音到 241s,第一档只抓到 240s
    const edge = (opts) => {
        const fl = makeFlow({ c: shift(J.C, 140) }, opts);
        fl.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
        return fl;
    };
    const eg = edge();
    await eg.run(23, 'c');
    ok(eg.fetchCalls.some(c => c.from === 240 && c.to > 240 && c.to <= 252) && !eg.fetchCalls.some(c => c.to === 480), '贴着窗口尾巴:只补抓一小段,不多抓一整档', eg.fetchCalls);
    ok(eg.ups[0] && near(eg.ups[0].oe, 241.02, 0.25) && !eg.ups[0].miss, '贴着窗口尾巴:补抓后落点到声音恢复', eg.ups);
    const eg2 = edge({ onFetch: (s, from) => { if (from >= 240) throw new Error('播放缓冲不足,分析让路'); } });
    await eg2.run(23, 'c');
    ok(eg2.ups[0] && eg2.ups[0].oe >= 239 && eg2.ups[0].oe < eg.ups[0].oe - 0.5 && eg2.ups[0].mv === 2 && eg2.A._epDone['T|S|23'] === 1, '补抓不到:不影响标记,只是少了静音延伸', { ups: eg2.ups, full: eg.ups[0] });
    const eg3 = edge({ onFetch: (s, from) => { if (from >= 240) eg3.A._abort = true; } });
    await eg3.run(23, 'c');
    ok(eg3.ups.length === 0 && !eg3.marks['23|r'] && !eg3.A._epDone['T|S|23'], '补抓时已换剧:不写标记,不记完成', eg3.ups);
    const eg4 = makeFlow({ c: shift(J.C, 130) });
    eg4.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
    await eg4.run(23, 'c');
    ok(eg4.ups[0] && near(eg4.ups[0].oe, 231.02, 0.25) && eg4.fetchCalls.length === 1 && eg4.fetchCalls[0].to === 240, '离窗口尾巴够远:不补抓(不多花流量)', eg4.fetchCalls);

    // 定位时顺带定位开头贴片(只在前 150s 找):片头前放一段响度独特的 20s,切出来当贴片包络
    const bumpR = Array.from({ length: 10 }, (_, j) => Array.from({ length: 19 }, (_, i) => 3000 + ((j * 19 + i) * 7919 % 997) * 20));
    const bumpEnv = Float32Array.from(bumpR.flatMap(r => [...r, r[18]]).map(x => x / 1e5));   // 和分段填包络同样的边界补帧
    const withBump = [...bumpR.map((r, j) => ({ st: 10 + j * 2, r })), ...J.C];
    const bumpFlow = (data, intro, marks) => {
        const fl = makeFlow({ c: data }, marks ? { marks } : {});
        fl.A._st['T|S'] = { phase: 'learned', tries: 0, intro: { ...saved, benv: bumpEnv, bdur: 20, bdv: 3, ...intro }, outroTries: 0, mb: 0 };
        return fl;
    };
    const bh = bumpFlow(withBump);
    const bhCur = await bh.run(23, 'c');
    ok(bh.ups[0] && bh.ups[0].bump && near(bh.ups[0].bump.bs, 10, 0.15) && near(bh.ups[0].bump.be, 30, 0.15) && near(bh.ups[0].oe, 101.02, 0.25), '贴片包络命中:上报带贴片区间,片头不受影响', bh.ups);
    ok(near(bh.marks['23|r'].bs, 10, 0.15) && near(bh.marks['23|r'].be, 30, 0.15) && bh.marks['23|r'].bmv === 3 && !('bv' in bh.marks['23|r']), '贴片包络命中:写进本地缓存,带 bmv', bh.marks['23|r']);
    const bn = bumpFlow(J.C);
    await bn.run(23, 'c');
    ok(bn.ups[0] && !bn.ups[0].bump && bn.ups[0].oe > 0 && bn.A._st['T|S'].intro.benv === bumpEnv, '本线路的贴片包络没中:不带贴片,包络留着(别的集还要用)', bn.ups);
    const bb = bumpFlow(J.C, { bB: 1 });
    await bb.run(23, 'c');
    ok(bb.ups[0] && !bb.ups[0].bump && bb.A._st['T|S'].intro.benv === null && !JSON.parse(bb.localStorage.getItem('donggua_afpenv|T|S')).bd, '借来的贴片包络没中:丢掉,不登记到本线路', bb.ups);
    const bc = bumpFlow(withBump, { bB: 1 });
    await bc.run(23, 'c');
    ok(bc.ups[0] && bc.ups[0].bump && bc.A._st['T|S'].intro.bB === 0 && !!JSON.parse(bc.localStorage.getItem('donggua_afpenv|T|S')).bd, '借来的贴片包络命中:转正登记到本线路', bc.ups);
    // 旧标记重算顺带定位到贴片:片头、贴片都重算成新算法值,都能跳
    const bo = bumpFlow(withBump, {}, { '23|r': { os: 60, oe: 100, v: 1, src: 'auto', bs: 10.1, be: 30.1, bv: 9, ed: 99999 } });
    const boCur = await bo.run(23, 'c');
    pc = playCheck(boCur._introCur);
    ok(boCur._introCur.bmv === 3 && near(boCur._introCur.bs, 10, 0.15) && pc.seeks.length === 2, '旧标记重算 + 贴片:都是新算法值,都自动跳', { cur: boCur._introCur, pc });
    ok(bo.marks['23|r'].bmv === 3 && !('bv' in bo.marks['23|r']) && !('v' in bo.marks['23|r']), '旧标记重算 + 贴片:本地缓存不留旧票数', bo.marks['23|r']);
    // 旧贴片这次没量到:留着,只亮按钮;片头照跳
    const bo2 = bumpFlow(J.C, {}, { '23|r': { os: 60, oe: 100, v: 1, src: 'auto', bs: 3, be: 20, bv: 9, ed: 99999 } });
    const bo2Cur = await bo2.run(23, 'c');
    pc = playCheck(bo2Cur._introCur);
    ok(pc.seeks.length === 1 && near(pc.seeks[0], bo2Cur._introCur.oe, 0.01) && pc.btn === 'bump', '旧贴片这次没量到:只亮按钮,不能跟着片头一起跳', pc);
    pc = playCheck(bhCur._introCur);
    ok(bhCur._introCur.src === 'afp' && pc.seeks.length === 2 && near(pc.seeks[0], 30, 0.15) && near(pc.seeks[1], bhCur._introCur.oe, 0.01), '定位命中的集:贴片和片头都自动跳', { cur: bhCur._introCur, pc });
    // 只在集首前 30s 里找:同样的音频挪到 40s、170s 都不算贴片(位置不对的,就算对得上也多半是正片里的音乐)
    const bl2 = bumpFlow([...bumpR.map((r, j) => ({ st: 170 + j * 2, r })), ...J.C]);
    await bl2.run(23, 'c');
    ok(bl2.ups[0] && bl2.ups[0].oe > 0 && !bl2.ups[0].bump, '贴片包络在 170s:不算', bl2.ups);
    const bl3 = bumpFlow([...bumpR.map((r, j) => ({ st: 31 + j * 2, r })), ...J.C]);
    await bl3.run(23, 'c');
    ok(bl3.ups[0] && bl3.ups[0].oe > 0 && !bl3.ups[0].bump, '贴片包络在 31s:不算', bl3.ups);
    const bl4 = bumpFlow([...bumpR.map((r, j) => ({ st: 30 + j * 2, r })), ...J.C]);
    await bl4.run(23, 'c');
    ok(bl4.ups[0] && bl4.ups[0].bump && near(bl4.ups[0].bump.bs, 30, 0.15), '贴片包络在 30s:还算(边界)', bl4.ups);

    // 解码失败太多:算不出来不写共享墓碑,只记本会话
    const badDec = (fl) => { fl.A._fetchEnvTo = (orig => async (sess, F, cap) => { const r = await orig(sess, F, cap); sess.segs = 100; sess.decFail = 60; return r; })(fl.A._fetchEnvTo); };
    const de = makeFlow({ a: J.A.slice(0, 2), b: J.C.slice(-2) });
    badDec(de);
    await de.run(10, 'a', 11, 'b');
    ok(!de.ups.some(u => u.miss) && !de.marks['10|r'] && de.A._st['T|S'].phase === 'nointro', '学不出 + 解码失败太多:不写共享墓碑,本会话不再试', de.ups);
    const dn = de.fetchCalls.length;
    await de.run(10, 'a', 11, 'b');
    ok(de.fetchCalls.length === dn, '同一会话不重抓');
    de.A._st = {}; de.A._epDone = {};
    await de.run(10, 'a', 11, 'b');
    ok(de.fetchCalls.length > dn, '下个会话还会试(可能只是这台设备的问题)');
    const dd = makeFlow({ c: FX.jjc_flow.A.slice(0, 1) });
    dd.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
    badDec(dd);
    await dd.run(23, 'c');
    ok(!dd.ups.some(u => u.miss) && dd.A._epDone['T|S|23'] === 1, '定位不中 + 解码失败太多:不写共享墓碑,只记本会话', dd.ups);
    const d1 = makeFlow({ c: FX.jjc_flow.A.slice(0, 1) });
    d1.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
    d1.A._fetchEnvTo = (orig => async (sess, F, cap) => { const r = await orig(sess, F, cap); sess.segs = 100; sess.decFail = 5; return r; })(d1.A._fetchEnvTo);
    await d1.run(23, 'c');
    ok(d1.ups.some(u => u.miss === 1), '只坏一点(≤5%):定位不中的结论还算数,照常记墓碑', d1.ups);

    // 真实 _fetchEnvRange:解码失败要计数;一段都解不出来就停,这次会话不再分析
    {
        const e = makeEnv(), a = e.A;
        const S = { url: 'u', base: 'u', text: '#EXTM3U', env: new Float32Array(600), n: 0, filled: 0, keyCache: {}, chunks: [], baseStart: 0 };
        a._segList = () => Array.from({ length: 12 }, (_, i) => ({ url: 's' + i, st: i * 2, key: null }));
        a._tsToAdts = () => ({ type: 'aac', data: new Uint8Array(1000), pts: -1, vpts: -1 });
        const F = async () => ({ arrayBuffer: async () => new ArrayBuffer(8) });
        let n = 0;
        a._ac = { decodeAudioData: async () => { n++; throw new Error('bad'); } };
        let msg = '';
        try { await a._fetchEnvRange(S, F, 0, 24); } catch (x) { msg = x.message; }
        ok(/解不了/.test(msg) && n === 6, '全部解码失败:6 段就停(不再烧流量)', { msg, n });
        ok(a._decodeOk(S) === false, '全部失败:结论不可信');
        // 全流程:这条线路这次会话不再分析,别的线路不受影响;不写任何东西
        const fl = makeFlow({ a: J.A, b: J.B });
        fl.A._fetchEnvTo = async () => { throw new Error('本机解不了这个片源的音频'); };
        await fl.run(21, 'a', 22, 'b');
        const nc = fl.conLog.length;
        ok(fl.A._st['T|S'].noDecode === 1 && !fl.ups.length && fl.A._busy === false, '解不了:记在这条线路上,不写标记也不写墓碑', fl.ups);
        await fl.run(21, 'a', 22, 'b');
        const moreLog = fl.conLog.slice(nc);
        ok(moreLog.length === 1 && /第21集不分析: 本机解不出/.test(moreLog[0]), '解不了:这条线路这次会话不再启动分析,只留一行判定', moreLog);

        const e2 = makeEnv(), b = e2.A, S2 = { url: 'u', base: 'u', text: '#EXTM3U', env: new Float32Array(600), n: 0, filled: 0, keyCache: {}, chunks: [], baseStart: 0 };
        b._segList = a._segList; b._tsToAdts = a._tsToAdts;
        let k = 0;
        b._ac = { decodeAudioData: async () => { if (k++ === 3) throw new Error('bad'); return { sampleRate: 10, getChannelData: () => new Float32Array(20).fill(0.1) }; } };
        await b._fetchEnvRange(S2, F, 0, 24);
        ok(S2.segs === 12 && S2.decFail === 1 && S2.chunks.length === 11, '个别坏段:跳过,计数', { segs: S2.segs, fail: S2.decFail });
        const cv = b._covOf(S2);
        ok(cv && cv[0] === 1 && cv[59] === 1 && cv[65] === 0 && cv[79] === 0 && cv[85] === 1, '_covOf:坏段的帧没覆盖(前一段尾部放宽 0.3s)', cv && Array.from(cv.slice(58, 68)));
        ok(b._decodeOk(S2) === false && b._decodeOk({ decFail: 1, segs: 40, chunks: [{}] }) === true, '坏段比例 >5% 才算不可信');
        // 0 片清单:真实 _fetchEnvRange 没有分段就直接返回,sess.n=0,没有 decFail 也不算分析过
        const e0 = makeEnv(), S0 = { url: 'u', base: 'u', text: '#EXTM3U', env: new Float32Array(600), n: 0, filled: 0, keyCache: {}, chunks: [], baseStart: 0 };
        e0.A._segList = () => [];
        const more = await e0.A._fetchEnvRange(S0, F, 0, 24);
        ok(more === false && S0.n === 0 && !S0.decFail && e0.A._decodeOk(S0) === false, '0 片清单:一段音频都没分析到,结论不可信', { more, n: S0.n });
        ok(b._covOf({ n: 10, chunks: [] }) === null, '没失败过:走快路径');
    }

    // 中止:算完学习/补抓之后已经换集,不能接着写标记
    const ab3 = makeFlow({ a: J.A, b: J.B });
    ab3.A._xcorrLearn = (orig => async function (...x) { const r = await orig.apply(ab3.A, x); ab3.A._abort = true; return r; })(ab3.A._xcorrLearn);
    await ab3.run(21, 'a', 22, 'b');
    ok(ab3.ups.length === 0 && ab3.A._busy === false, '学习算完已被中止:不写标记', ab3.ups);

    // 换剧竞态:play() 在最后一段抓取期间置 _abort,逐段检查已经过了。定位不中的结论不能写:_introUpload 按当前剧名上报,墓碑会落到新剧的同线路同集号
    const raceFlow = (data, marks, intro) => {
        const fl = makeFlow(data, { marks, onFetch: () => { fl.A._abort = true; } });
        fl.A._st['T|S'] = { phase: 'learned', tries: 0, intro, outroTries: 0, mb: 0, envFetched: 1 };
        return fl;
    };
    const miss1 = FX.jjc_flow.A.slice(0, 1);
    const rc = raceFlow({ c: miss1 }, {}, saved);
    await rc.run(23, 'c');
    ok(rc.fetchCalls.length >= 1 && rc.ups.length === 0 && !rc.marks['23|r'], '定位不中时已换剧:不写墓碑', rc.ups);
    ok(!rc.A._epDone['T|S|23'] && rc.A._busy === false && rc.A._st['T|S'].phase === 'learned', '定位不中时已换剧:不记完成,下次还能试', { done: rc.A._epDone, phase: rc.A._st['T|S'].phase });
    ok(rc.conLog.some(s => /让路/.test(s)) && !rc.conLog.some(s => /未找到已知片头/.test(s)), '定位不中时已换剧:走让路分支,不下"没有片头"的结论', rc.conLog);
    const rb1 = raceFlow({ c: miss1 }, { '23|r': { os: 0, oe: 0, mv: 2, miss: 2, mt: Date.now(), ed: 99999 } }, { ...saved, iB: 1 });
    await rb1.run(23, 'c');
    ok(rb1.ups.length === 0 && rb1.marks['23|r'].miss === 2, '借来的包络没中时已换剧:不把墓碑升成 3', rb1.ups);
    const rh = raceFlow({ c: J.C }, {}, saved);
    await rh.run(23, 'c');
    ok(rh.ups.length === 0 && !rh.marks['23|r'], '定位命中时已换剧:同样不写标记', rh.ups);

    // 0 片清单:sess.n=0,locate 不中,但一段音频都没比过,不能写进共享墓碑让所有观众 30 天不再试
    const z = makeFlow({});
    z.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0, envFetched: 1 };
    await z.run(23, 'c');
    ok(z.fetchCalls.length >= 1 && !z.ups.some(u => u.miss) && !z.marks['23|r'], '定位遇 0 片清单:不写墓碑', z.ups);
    ok(z.A._epDone['T|S|23'] === 1, '定位遇 0 片清单:只记本会话(不反复拉清单)');
    z.A._epDone = {};
    const zn = z.fetchCalls.length;
    await z.run(23, 'c');
    ok(z.fetchCalls.length > zn, '定位遇 0 片清单:下个会话还会试');
    const zb = makeFlow({}, { marks: { '23|r': { os: 0, oe: 0, mv: 2, miss: 2, mt: Date.now(), ed: 99999 } } });
    zb.A._st['T|S'] = { phase: 'learned', tries: 0, intro: { ...saved, iB: 1 }, outroTries: 0, mb: 0, envFetched: 1 };
    await zb.run(23, 'c');
    ok(zb.ups.length === 0 && zb.marks['23|r'].miss === 2, '借来的包络遇 0 片清单:墓碑不升级', zb.ups);
    const zl = makeFlow({});
    await zl.run(10, 'a', 11, 'b');
    ok(zl.fetchCalls.length >= 2 && !zl.ups.length && !zl.marks['10|r'] && !zl.marks['11|r'], '冷启动两集都是 0 片清单:不写墓碑', zl.ups);
    const zo = makeFlow({ a: J.A.slice(0, 2) });
    await zo.run(10, 'a', 11, 'b');
    ok(!zo.ups.length, '冷启动一集 0 片清单:学不出的结论不算数,两集都不写', zo.ups);

    // 算出来太短(<10s):也要记下来,否则每个会话重抓
    const sh = makeFlow({ c: J.C });
    sh.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 0 };
    sh.A._apply({ vue: { _introMarks: { key: 'T|S', marks: sh.marks }, _introMarkGet: e => sh.marks[e + '|r'] || null, _introMarkSet: (e, r) => { sh.marks[e + '|r'] = r; }, _introChannel: () => 'r', _introEpNum: () => 7, _introEpPart: () => 0, _introUpload(t, s, e, os, oe, b, ed, d, ex) { sh.ups.push({ ep: e, os, oe, ...(ex || {}) }); } }, title: 'T', site: 'S', ep: 7 }, 7, 0, 9.5, true, null);
    ok(sh.ups.length === 1 && sh.ups[0].miss === 1 && sh.marks['7|r'].miss === 1, '算出来 <10s:按算不出记墓碑,不再每会话重抓', sh.ups);

    // 流量上限
    const big = makeFlow({ c: J.C });
    big.A._st['T|S'] = { phase: 'learned', tries: 0, intro: saved, outroTries: 0, mb: 701 };
    await big.run(23, 'c');
    ok(big.fetchCalls.length === 0 && big.conLog.some(s => /单剧上限/.test(s)), '单剧流量上限还在,命中有日志');
    const big2 = makeFlow({ c: J.C });
    big2.A._mb = 2001;
    await big2.run(23, 'c');
    ok(big2.fetchCalls.length === 0 && big2.conLog.some(s => /会话分析总流量/.test(s)), '会话流量上限还在,命中有日志');

    // 真实 _fetchEnvRange 的逐段让路和 _abort 没动
    const src = HTML.slice(i0, i1);
    ok(/if \(this\._abort\) throw new Error\('播放需要带宽,分析已让路'\);/.test(src) && /if \(v\.readyState < 3 \|\| ahead < 6\) throw new Error\('播放缓冲不足,分析让路'\);/.test(src), '逐段让路和中止还在');
    ok(/if \(v && !v\.paused && v\.readyState >= 3 && \(v\.currentTime \|\| 0\) > 10\) \{ stable = true; break; \}/.test(src), '播放稳定才抓的门控还在');
}

console.log('⑥ 有值的 mv:2 不再分析');
{
    // 观众 1 冷启动学第 21/22 集
    const l = makeFlow({ a: J.A, b: J.B, c: J.C });
    await l.run(21, 'a', 22, 'b');
    const saved = l.A._st['T|S'].intro, rec = JSON.parse(l.localStorage.getItem('donggua_afpenv|T|S'));
    ok(!('ep' in saved) && !('ep' in rec), '学习:包络不带 ep', { saved: saved.ep, rec: rec.ep });
    ok(l.posts.some(p => /\/api\/intro\/env/.test(p.u) && p.body && p.body.env && p.body.env.d && !('ep' in p.body.env)), '云备份不带 ep', l.posts.map(p => p.u));
    const flowWith = (data, marks, intro) => {   // 新设备:票池按 marks,数据全在,真要抓就抓得到
        const fl = makeFlow(data, { marks: JSON.parse(JSON.stringify(marks)) });
        if (intro) fl.A._st['T|S'] = { phase: 'learned', tries: 0, intro, outroTries: 0, mb: 0, envFetched: 1 };
        return fl;
    };
    const only = (m, ...eps) => Object.fromEntries(eps.map(e => [e + '|r', m[e + '|r']]));
    const tomb = { os: 0, oe: 0, mv: 2, miss: 1, mt: Date.now(), ed: 99999 };
    const pair = only(l.marks, 21, 22);
    const three = { ...pair, '23|r': { ...pair['21|r'] } };

    // 有值的 mv:2 标记:不管有几集值、包络切自哪集、本线路的还是借来的,都不抓、不上报、v 不变
    for (const [name, marks, ep, key, intro] of [
        ['只有学习对两集,邻集', pair, 22, 'b', saved],
        ['学习对之外全是墓碑', { ...pair, '23|r': tomb, '24|r': tomb, '25|r': tomb }, 21, 'a', saved],
        ['3 集有值,邻集', three, 22, 'b', saved],
        ['3 集有值,学习对之外命中的那集', three, 23, 'c', saved],
        ['3 集有值,切出包络的那一集', three, 21, 'a', saved],
        ['3 集有值,包络是借来的', three, 22, 'b', { ...saved, iB: 1 }],
        ['本机没有包络(云端可能有)', three, 22, 'b', null],
    ]) {
        const d = flowWith({ a: J.A, b: J.B, c: J.C }, marks, intro), before = JSON.stringify(d.marks);
        for (let round = 0; round < 2; round++) {   // 第二轮 = 新会话(内存守卫清空)
            await d.run(ep, key);
            d.A._epDone = {};
        }
        ok(d.fetchCalls.length === 0, name + ':不抓', d.fetchCalls);
        ok(d.ups.length === 0 && d.posts.length === 0, name + ':不上报,也不拉不传包络', { ups: d.ups, posts: d.posts.map(p => p.u) });
        ok(JSON.stringify(d.marks) === before, name + ':标记不变');
        ok(d.A._busy === false, name + ':没有留下忙状态');
        ok(JSON.stringify(d.A._introNeed({ vue: { _introChannel: () => 'r', _introMarks: { key: 'T|S', marks: d.marks } }, title: 'T', site: 'S', ep }, d.marks[ep + '|r'])) === '{"intro":false}', name + ':判定就是不算', ep);
    }

    // 缺片尾的 mv:2 标记:片尾照常学(抓尾部),片头不抓、片头值不上报、票数不变
    const noEd = (m) => { const r = { ...m }; delete r.ed; return r; };
    const ne = flowWith({ a: J.A, b: J.B }, { ...three, '22|r': noEd(three['22|r']) }, saved);
    ne.marks['21|r'] = { ...ne.marks['21|r'] };
    const tails = [];
    ne.A._fetchTailEnv = async (s) => { tails.push(s.url); return false; };
    await ne.run(22, 'b', 21, 'a');
    ok(tails.length === 2 && ne.fetchCalls.length === 0 && ne.ups.length === 0, '缺片尾:只抓尾部学片尾,片头不抓不报', { tails, calls: ne.fetchCalls, ups: ne.ups });

    // 这几种还是要算:没有值就不是"有值的 mv:2 标记"
    const a7 = flowWith({ a: J.A }, {}, saved);
    await a7.run(21, 'a');
    ok(a7.ups.length === 1 && a7.ups[0].mv === 2 && a7.ups[0].pend === 1 && a7.marks['21|r'].pend === 1, '切出包络的那一集没有值:普通定位不受影响(值丢了要能补回来),但它在学习对里,再中也不算确认', a7.ups);
    const ex = flowWith({ c: J.C }, { '23|r': { ...tomb, mt: Date.now() - 31 * 864e5 } }, saved);
    await ex.run(23, 'c');
    ok(ex.ups.length === 1 && ex.ups[0].mv === 2 && ex.ups[0].oe > 0 && !ex.marks['23|r'].miss, '过期墓碑:照常重试一次,算出来覆盖墓碑', ex.ups);

    // 冷启动学习对把已有值的邻集再算一遍:新算法值遇到新算法值,保留已有值,不上报(服务器也一样,见 intro-mark-migrate-test)
    const cn = makeFlow({ a: J.A, b: J.B }, { marks: { '22|r': { ...pair['22|r'], oe: 77.7 } } });
    await cn.run(21, 'a', 22, 'b');
    ok(cn.marks['22|r'].oe === 77.7 && cn.marks['22|r'].pid === pair['22|r'].pid, '冷启动撞上已有值的邻集:保留已有值', cn.marks['22|r']);
    ok(!cn.ups.some(u => u.ep === 22 && u.oe > 0) && cn.ups.some(u => u.ep === 21 && u.pend === 1), '冷启动撞上已有值的邻集:邻集不上报,本集照常待确认', cn.ups);

    // 本地投票记录:不读不写。开发版留下的旧记录不影响分析,也不被碰
    const spyLs = (fl) => {
        const seen = [], ls = fl.localStorage;
        for (const m of ['getItem', 'setItem', 'removeItem']) { const f = ls[m]; ls[m] = (k, ...r) => { seen.push(k); return f(k, ...r); }; }
        return seen;
    };
    const VK = 'donggua_afpvote|T|S', VV = JSON.stringify({ '21|r': 1, '22|r': 1, '23|r': 1 });
    const allFlows = [
        ['冷启动学习', flowWith({ a: J.A, b: J.B }, {}, null), [21, 'a', 22, 'b']],
        ['定位命中', flowWith({ c: J.C }, {}, saved), [23, 'c']],
        ['定位不中', flowWith({ c: FX.jjc_flow.A.slice(0, 1) }, {}, saved), [23, 'c']],
        ['借来的包络没中', flowWith({ c: FX.jjc_flow.A.slice(0, 1) }, { '23|r': { os: 0, oe: 0, mv: 2, miss: 2, mt: Date.now(), ed: 99999 } }, { ...saved, iB: 1 }), [23, 'c']],
        ['有值的 mv:2 标记', flowWith({ a: J.A }, three, saved), [21, 'a']],
    ];
    for (const [name, fl, args] of allFlows) {
        fl.localStorage.setItem(VK, VV);
        const seen = spyLs(fl);
        await fl.run(...args);
        if (name === '定位不中') {   // 算出来超限那条路也走一遍
            fl.A._apply({ vue: { _introMarks: { key: 'T|S', marks: fl.marks }, _introMarkGet: e => fl.marks[e + '|r'] || null, _introMarkSet: (e, r) => { fl.marks[e + '|r'] = r; }, _introChannel: () => 'r', _introEpNum: () => 7, _introUpload() { } }, title: 'T', site: 'S', ep: 7 }, 7, 0, 9.5, true, null);
        }
        ok(fl.fetchCalls.length > 0 || name === '有值的 mv:2 标记', name + ':这条路确实跑了分析(不是空跑)', fl.fetchCalls);
        ok(!seen.some(k => String(k).indexOf('donggua_afpvote') === 0), name + ':不读写 donggua_afpvote', seen.filter(k => /afpvote/.test(k)));
        ok(fl.localStorage.getItem(VK) === VV, name + ':旧记录原样,不清不改');
    }
    const fresh = flowWith({ a: J.A, b: J.B }, {}, null);
    await fresh.run(21, 'a', 22, 'b');
    ok(fresh.ups.length === 2 && !Array.from({ length: fresh.localStorage.length }, (_, i) => fresh.localStorage.key(i)).some(k => /afpvote/.test(k)), '新设备学完:本地没有投票记录', fresh.ups);
    for (const [re, name] of [[/donggua_afpvote/, 'donggua_afpvote'], [/_voteNote|_voted\b|_voteKey/, '_voteNote/_voted/_voteKey'], [/need\.vote|introNeed\.vote/, 'need.vote'], [/truthCount|VOTE_MIN_TRUTH/, 'truthCount/VOTE_MIN_TRUTH'], [/voteOk|canVote/, 'voteOk/canVote'], [/_fetchAround/, '_fetchAround']]) {
        ok(!re.test(HTML), '页面里没有 ' + name);
    }
    const C = makeEnv().C;
    ok(C.truthCount === undefined && C.VOTE_MIN_TRUTH === undefined, 'IntroCore 不再导出票数相关');

    // 包络不再带 ep:本地存取、云端拉取、转正回传、片尾学习重存都没有;开发期留下的记录读进来就丢
    const E = makeEnv(), o = { vue: {}, title: 'T', site: 'S' };
    const f = new Float32Array(200).fill(0.5);
    E.A._envSave(o, f, 20, 3, 18, null, 0, null, 0);
    ok(!('ep' in JSON.parse(E.localStorage.getItem('donggua_afpenv|T|S'))) && !('ep' in E.A._envLoad(o)), '_envSave / _envLoad:没有 ep');
    const dev = E.A._envParse({ v: 2, dv: 2, d: Buffer.from(new Uint8Array(200).fill(9)).toString('base64'), sec: 20, dur: 20, ep: 21 });
    ok(dev.env && !('ep' in dev), '_envParse:开发期记录里的 ep 不读', Object.keys(dev));
    const lib = E.A._envFill({ env: null, oenv: f, odur: 20 }, { env: f, sec: 20, dur: 18, iB: 1, from: 'X' });
    ok(lib.env === f && lib.iB === 1 && !('ep' in lib), '_envFill:借来的片头不带 ep', lib.ep);
    const P = makeEnv();
    P.A._st['T|S'] = { phase: 'learned' };
    P.A._envPromote(o, { env: f, sec: 20, dur: 18, maxStart: 3, benv: null, bdur: 0, oenv: null, odur: 0 });
    ok(!('ep' in JSON.parse(P.localStorage.getItem('donggua_afpenv|T|S'))) && P.posts.some(p => p.body && p.body.env && p.body.env.d && !('ep' in p.body.env)), '_envPromote:转正回传没有 ep', P.posts.length);
    ok(P.A._envJson({ d: 'x', ep: 21 }) === P.A._envJson({ d: 'x' }), '_envJson:ep 不参与内容比较');
    const R = makeFlow({ a: J.A, b: J.B });
    const FF = R.A._mkFetch();
    const tailSess = (s) => { s.text = 'x'; s.duration = 2000; s.baseStart = 1800; s.filled = 200; s.env = new Float32Array(2000).fill(0.1); s.n = 2000; return true; };
    R.A._fetchTailEnv = async (s) => tailSess(s);
    R.A._xcorrLearn = async () => ({ aStart: 100, bStart: 100, len: 200, conf: 0.9 });
    const st = R.A._st['T|S'] = { phase: 'learned', tries: 0, intro: null, outroTries: 0, mb: 0 };
    const outroVue = { _introMarks: { key: 'T|S', marks: {} }, _introMarkGet: () => null, _introMarkSet() { }, _introEpNum: () => 21, _introChannel: () => 'r', _introUpload() { }, currentGroup: { name: 'T' }, currentUrl: 'u:a' };
    await R.A._learnOutro({ vue: outroVue, title: 'T', site: 'S', ep: 21 }, FF, 'u:a', { ep: 22, url: 'u:b' }, st, { env: f, sec: 20, dur: 18, maxStart: 3, pid: 'pairabcd', peps: [21, 22], psite: 'X', pk: 'j', benv: null, bdur: 0, oenv: null, odur: 0 });
    const ro = JSON.parse(R.localStorage.getItem('donggua_afpenv|T|S'));
    ok(ro.od && ro.d && ro.dv === 2 && !('ep' in ro), '片尾学习重存包络:片头组件不丢,没有 ep', Object.keys(ro));
    ok(ro.pid === 'pairabcd' && ro.peps.join() === '21,22' && ro.psite === 'X' && ro.pk === 'j', '片尾学习重存包络:学习对 id、学习线路、集号体系不丢(丢了这条包络就再也确认不了)', ro.pid);
}

console.log('⑦ 综艺变体');
{
    const C = makeEnv().C;
    const P = (s) => { const x = C.parseEpName(s); return [x.kind, x.kind ? x.num : '-', x.part, x.variant ? 'V' : ''].join(' ').trim(); };
    // 真实集名(来自 db.json 各站的 vod_play_url)
    const cases = [
        // 第 N 期 + 上中下
        ['第1期上', 'qi 1 1'], ['第1期下', 'qi 1 3'], ['第01期上', 'qi 1 1'], ['第1期（上）', 'qi 1 1'], ['第1期-下', 'qi 1 3'], ['第09集下', 'ji 9 3'], ['第07期', 'qi 7 0'], ['第一期上', 'qi 1 1'], ['第十二集', 'ji 12 0'],
        // 日期式
        ['第20250516期', 'date 20250516 0'], ['20250926期', 'date 20250926 0'], ['20250321上', 'date 20250321 1'], ['20250321中', 'date 20250321 2'], ['20250321下', 'date 20250321 3'], ['20240628(下)', 'date 20240628 3'], ['20240904 上', 'date 20240904 1'], ['20220819（第1期上）', 'date 20220819 1'], ['20220826（第2期）', 'date 20220826 0'], ['20241107第4期上', 'date 20241107 1'], ['2021-08-12期', 'date 20210812 0'], ['20210812期-中', 'date 20210812 2'], ['2021.08.13期', 'date 20210813 0'], ['20240731期-第1期', 'date 20240731 0'], ['2020329上', 'date 2020329 1'], ['2023102', 'date 2023102 0'], ['20239010', 'date 20239010 0'], ['2025-13-40期', '- 0'],
        // 紧贴的变体词
        ['第1期上纯享版', 'qi 1 1 V'], ['第1期纯享版', 'qi 1 0 V'], ['第4期加更', 'qi 4 0 V'], ['第4期加更版', 'qi 4 0 V'], ['第20250517期纯享', 'date 20250517 0 V'], ['第20250516期竖屏直拍', 'date 20250516 0 V'], ['第20250602期Mickey Guyton直拍', 'date 20250602 0 V'], ['第20240626期先导片', 'date 20240626 0 V'], ['20240820上纯享版', 'date 20240820 1 V'], ['20241019会员加更版', 'date 20241019 0 V'], ['20241108抢鲜版', 'date 20241108 0 V'], ['20241018沉浸版', 'date 20241018 0 V'], ['20250319超前企划', 'date 20250319 0 V'], ['20250321(舞台纯享版)', 'date 20250321 0 V'], ['20250327(一公抢先看)', 'date 20250327 0 V'], ['20220820（加更第1期）', 'date 20220820 0 V'], ['2021.08.05期plus版.', 'date 20210805 0 V'], ['20240801会员plus版', 'date 20240801 0 V'], ['20240808大神版下', 'date 20240808 0 V'],
        // 日期式、第 N 期后面紧贴别的文字:不是正片
        ['20250927日常篇', 'date 20250927 0 V'], ['20250327蒸蒸日上的姐姐', 'date 20250327 0 V'], ['20251127陈伟霆', 'date 20251127 0 V'], ['20220825（滚烫营业第1期）', 'date 20220825 0 V'], ['第1期喜人夜聊', 'qi 1 0 V'], ['第1期朋友们和Ta的脱口秀', 'qi 1 0 V'], ['第2期生活特辑', 'qi 2 0 V'], ['第20251128期奇妙夜', 'date 20251128 0 V'], ['20240829 9游记陪看篇', 'date 20240829 0 V'], ['20250619EP00', 'date 20250619 0 V'], ['第20250619期EP00', 'date 20250619 0 V'], ['20250816(1)', 'date 20250816 0 V'], ['20210930期披', 'date 20210930 0 V'],
        // 期号前面的文字
        ['加更版第1期', 'qi 1 0 V'], ['超前Vlog第1期', 'qi 1 0 V'], ['游记陪看篇第1期', 'qi 1 0 V'], ['滚烫营业第1期', 'qi 1 0 V'], ['第二季第5期', 'qi 5 0'], ['第5期20260101', 'date 20260101 0'],
        // 会员、未删减、超前点映、试播、番外(新补的)
        ['第5集会员版', 'ji 5 0 V'], ['第5集未删减版', 'ji 5 0 V'], ['第5期超前点映', 'qi 5 0 V'], ['超前点映第5集', 'ji 5 0 V'], ['第5集 番外', 'ji 5 0 V'], ['第5集 试播', 'ji 5 0 V'], ['第5集 特别篇', 'ji 5 0 V'], ['第5集 独家花絮', 'ji 5 0 V'], ['第5集预告', 'ji 5 0 V'],
        // 电视剧的副标题不是变体词(结构位置才算)
        ['第6集 幕后黑手', 'ji 6 0'], ['第12集大结局', 'ji 12 0'], ['第5期 聊聊人生', 'qi 5 0'], ['第5集 预告犯', 'ji 5 0'], ['第3集上海滩', 'ji 3 0'], ['第3集 上海滩', 'ji 3 0'], ['第12集HD', 'ji 12 0'], ['庆余年第5集', 'ji 5 0'], ['第2季第5集', 'ji 5 0'], ['第5期 下午茶', 'qi 5 0'],
        // 括号把"期"隔开(奇葩说第七季的真实写法):单独的"期"不是残留;连着别的字、括号里是别的字,还是残留
        ['第20201217(上)期', 'date 20201217 1'], ['第20201219(下)期', 'date 20201219 3'], ['第20201217（中）期', 'date 20201217 2'], ['20201217(上)期', 'date 20201217 1'], ['20201217-期', 'date 20201217 0'],
        ['第20201217(上)期纯享', 'date 20201217 1 V'], ['第20201217(上)期 加更', 'date 20201217 1 V'], ['第20201217(加更)期', 'date 20201217 0 V'], ['第20201217(上)期末考', 'date 20201217 1 V'], ['20201217(陈伟霆)期', 'date 20201217 0 V'],
        // 老写法不变
        ['第1集', 'ji 1 0'], ['第01话', 'ji 1 0'], ['EP05', 'ji 5 0'], ['Ep.12', 'ji 12 0'], ['05', 'ji 5 0'], ['1', 'ji 1 0'], ['0', 'ji 0 0'],
        // 解析不出
        ['先导片', '- 0 V'], ['主题曲', '- 0'], ['尝鲜篇', '- 0 V'], ['抢先看', '- 0 V'], ['回顾', '- 0 V'], ['第2季', '- 0'], ['超前企划（上）', '- 0 V'], ['第0817预热特辑上', '- 0'], ['2025112720251127范丞丞', '- 0'], ['HD国语', '- 0'], ['正片', '- 0'], ['1080P', '- 0'], ['4K', '- 0'], ['第1-2集', '- 0'], ['1-2', '- 0'], ['12.5', '- 0'], ['第12.5集', '- 0'], ['S01E05', '- 0'], ['上集', '- 1'], ['下', '- 3'], ['试播集', '- 0 V'], ['番外1', '- 0 V'],
    ];
    for (const [name, want] of cases) ok(P(name) === want, '集名 ' + name + ' → ' + want, P(name));

    // 词表:不能比现有几份少,不另起一套
    const words = C.VAR_WORDS.split('|');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const list = (re, src) => { const m = re.exec(src); return m ? m[1].split('|') : null; };
    const sources = [
        ['server.js DM_VARIANT', list(/const DM_VARIANT = '([^']+)'/, srv)],
        ['server.js DM_EXTRA', list(/const DM_EXTRA = '([^']+)'/, srv)],
        ['页面 SUFW', list(/const SUFW = \/\^\(([^)]+)\)\/i/, HTML)],
        ['页面 _epMatchKey', list(/const re = \/\(([^)]+)\)\/g/, HTML)],
    ];
    for (const [name, arr] of sources) {
        ok(!!arr && arr.length >= 5, name + ':找得到', arr);
        const lack = (arr || []).filter(w => !/^[上中下]$/.test(w) && !words.includes(w));
        ok(!lack.length, name + ':IntroCore 的词表一个不少', lack);
    }
    for (const w of ['会员', '未删减', '超前', '番外', '试播']) ok(words.includes(w), '词表补上 ' + w);

    // 整个列表:零宽字符、共同前缀、解析不出的、重名
    const L = (...names) => names.map((name, i) => ({ name, url: 'u' + i }));
    const I = (list) => C.epInfos(list).map(x => [x.ep, x.part, x.variant ? 'V' : ''].join(' ').trim());
    let a = I(L('2021.\u200b07.28期-上\u200b', '2021.\u200b07.28期-下\u200b', '2021.08.04期'));
    ok(a.join() === '20210728 1,20210728 3,20210804 0', '零宽字符不影响', a);
    a = I(L('披荆斩棘的哥哥20210813', '披荆斩棘的哥哥20210813下', '披荆斩棘的哥哥20210814.PLus[]', '披荆斩棘的哥哥20210816.定义.上', '披荆斩棘的哥哥20210820'));
    ok(a.join() === '20210813 0,20210813 3,20210814 0 V,20210816 1 V,20210820 0', '共同前缀去掉(剧名写进集名)', a);
    a = I(L('歌手2025第1期', '歌手2025第2期'));
    ok(a.join() === '1 0,2 0', '剧名带数字:前缀遇到数字就停,期号还认得出', a);
    a = I(L('滚烫营业第1期', '滚烫营业第2期', '滚烫营业第3期'));
    ok(a.join() === '1 0,2 0,3 0', '整个列表都是同一类:这个列表的正片就是它', a);
    a = I(L('先导片', '第1期', '第2期'));
    ok(a.join() === '1 0 V,1 0,2 0', '先导片按位置是 1,不当正片,撞不上真的第 1 期', a);
    a = I(L('主题曲', '20220819（第1期上）', '20220819（第1期下）'));
    ok(a.join() === '1 0 V,20220819 1,20220819 3', '主题曲:别的集解析得出,它就不当正片', a);
    a = I(L('第一部', '第二部', '第三部'));
    ok(a.join() === '1 0,2 0,3 0', '全都解析不出:还按列表位置(和以前一样)', a);
    a = I(L('HD国语', 'HD国语版'));
    ok(a.join() === '1 0,2 0', '全都解析不出:HD 这种还按列表位置', a);
    a = I(L('正片', '预告片'));
    ok(a.join() === '1 0,2 0 V', '全都解析不出:预告片还是变体', a);
    a = I([{ name: '2021-08-12期', url: 'x' }, { name: '2021-08-12期', url: 'y' }, { name: '2021-08-12期', url: 'z' }, { name: '2021-08-13期', url: 'w' }]);
    ok(a.join() === '20210812 0 V,20210812 0 V,20210812 0 V,20210813 0', '同一个期号三个地址:分不清谁是谁,都不当正片', a);
    a = I([{ name: '第1集', url: 'x' }, { name: '第1集', url: 'x' }, { name: '第2集', url: 'y' }]);
    ok(a.join() === '1 0,1 0,2 0', '同一个地址列了两遍:不算重名', a);
    a = I(L('第1期上', '第1期下', '第1期', '第2期'));
    ok(a.join() === '1 1,1 3,1 0,2 0', '第1期和第1期上不算重名', a);
    ok(C.epInfoOf(L('第1集'), 'nope') === null, '地址不在列表里:null');
    ok(C.epInfoOf(null, 'nope') === null, '列表为空:null');

    // 配对:只用正片,期号不同、部分相同,由近及远
    const pick = (names, idx) => { const list = L(...names), r = C.pickPair(list, 'u' + idx); return r ? names[+r.url.slice(1)] : null; };
    ok(pick(['第1期上', '第1期下', '第2期上', '第2期下'], 0) === '第2期上', '第1期上配第2期上,不配第1期下');
    ok(pick(['第1期上', '第1期下', '第2期上', '第2期下'], 1) === '第2期下', '第1期下配第2期下');
    ok(pick(['第1期上纯享版', '第1期上', '第1期下纯享版', '第1期下', '第1期朋友们和Ta的脱口秀', '第2期上纯享版', '第2期上', '第2期下纯享版', '第2期下'], 1) === '第2期上', '脱口秀:越过纯享版和朋友们,配第2期上');
    ok(pick(['第20250516期', '第20250516期竖屏直拍', '第20250517期纯享', '第20250517期加更', '第20250522期', '第20250523期'], 0) === '第20250522期', '歌手:越过竖屏直拍、纯享、加更');
    ok(pick(['20250321上', '20250321中', '20250321下', '20250321舞台纯享版', '20250323加更版', '20250326全纪录', '20250327蒸蒸日上的姐姐', '20250328上', '20250328下'], 0) === '20250328上', '乘风:隔 6 集也找得到');
    ok(pick(['第1期', '第1期加更', '第2期'], 2) === '第1期', '往前找也行');
    ok(pick(['第1期上', '第2期下', '第3期'], 0) === null, '没有同部分的正片:不配');
    ok(pick(['第1期上', '第1期下'], 0) === null, '只有同一期的上下半:不配');
    ok(pick(['第1期', '第1期纯享版'], 0) === null, '只有变体:不配');
    ok(pick(['第1期纯享版', '第1期', '第2期'], 0) === null, '正在看变体集:不配');
    ok(pick(['先导片', '第1期', '第2期'], 0) === null, '正在看先导片:不配');
    const pep = C.pickPair(L('第1期上', '第1期下', '第2期上'), 'u0');
    ok(pep.ep === 2 && pep.part === 1 && pep.kind === 'qi', '配对结果带集号、部分和写法', pep);
    // 奇葩说第七季 mdzy、ikun、moduanime、moduzy 的真实写法:整张表 46 集曾全判变体,整季没按钮
    const QP = ['第20201217(上)期', '第20201219(下)期', '第20201224(上)期', '第20201224(下)期', '第20201226(上)期', '第20201226(下)期'];
    ok(I(L(...QP)).join() === '20201217 1,20201219 3,20201224 1,20201224 3,20201226 1,20201226 3', '奇葩说第七季:都是正片,部分认得出', I(L(...QP)));
    ok(pick(QP, 0) === '第20201224(上)期' && pick(QP, 1) === '第20201224(下)期', '奇葩说第七季:上配上,下配下');
    ok(C.epInfos(L(...QP)).every(x => C.epScheme(x) === 'd'), '奇葩说第七季:集号体系是日期式');
    // 判定日志用的原因:三种不当正片各说各的,正片没有原因
    const whyOf = C.epInfos(L('第1期', '第1期纯享版', '主题曲', '第2期'));
    ok(whyOf[0].why === '' && whyOf[3].why === '' && /变体词/.test(whyOf[1].why) && /解析不出/.test(whyOf[2].why), '不当正片的原因:变体词、解析不出', whyOf);
    const whyDup = C.epInfos([{ name: '2021-08-12期', url: 'a' }, { name: '2021-08-12期', url: 'b' }, { name: '2021-08-13期', url: 'c' }]);
    ok(/多个地址/.test(whyDup[0].why) && /多个地址/.test(whyDup[1].why) && whyDup[2].why === '', '不当正片的原因:同一集号多个地址,两边都说', whyDup);

    // 集号体系:真实集名。d=日期式 j=第N集 q=第N期/分上下/列表位置
    const SC = (name) => C.epScheme(C.epInfos([{ name, url: 'u' }])[0]);
    for (const [name, want] of [['第05集', 'j'], ['第05话', 'j'], ['01', 'j'], ['EP12', 'j'], ['第一百集', 'j'], ['第100集', 'j'], ['第1期', 'q'], ['第01期上', 'q'], ['第1期下', 'q'], ['第1集上', 'q'], ['第一部', 'q'],
        ['20220830（第1期上）', 'd'], ['第20250607期上', 'd'], ['20240227期', 'd'], ['2025-03-21', 'd'], ['240906上', 'd'], ['2024110上', 'd'], ['第2023012期', 'd'], ['2020424', 'd']]) ok(SC(name) === want, '集号体系 ' + name + ' → ' + want, SC(name));
    ok(C.epScheme(null) === '', '不在列表里:没有体系');
    // 算不算学习对之外的独立证据:线上真实列表里的写法
    const WIT = (env, name, site) => C.pairWitness({ pid: 'p', ...env }, C.epInfos([{ name, url: 'u' }])[0], site);
    const TK = { peps: [1, 2], psite: 'jisu', pk: 'q' }, TH = { peps: [1, 2], psite: 'dyttzy', pk: 'q' }, YN = { peps: [1, 2], psite: 'ffzy', pk: 'q' }, YJ = { peps: [3, 4], psite: '1080zyk', pk: 'j' }, MD = { peps: [5, 6], psite: 'zy360', pk: 'j' }, BS = { peps: [20240227, 20240228], psite: '1080zyk', pk: 'd' }, LZ = { peps: [20220904, 20220911], psite: 'lzi', pk: 'd' };
    for (const [env, name, site, want, why] of [
        [TK, '20220830（第1期上）', 'ikun', false, '脱口秀 ikun:日期式就是学习对的第1期上'], [TK, '20220910（第2期上）', 'ikun', false, '脱口秀 ikun:日期式就是学习对的第2期上'], [TK, '第1期下', 'jisu', false, '脱口秀 jisu:学习对同一期的下半'], [TK, '第3期上', 'jisu', true, '脱口秀 jisu:第3期上'], [TK, '第3期下', 'jisu', true, '脱口秀 jisu:第3期下'], [TK, '第3期上', 'zy360', false, '脱口秀 别的线路的第3期上:分不分上下、从哪开始数都不一定一样'],
        [TH, '第3期', 'bfzy', false, '桃花坞 bfzy:第3期就是学习对的第2期上'], [TH, '第4期', 'bfzy', false, '桃花坞 bfzy:第4期是第2期下'], [TH, '第3期上', 'dyttzy', true, '桃花坞 dyttzy:第3期上'],
        [YN, '第03集', '1080zyk', false, '喜剧大赛 1080zyk:第03集就是学习对的第02期上'], [YJ, '第2期上', 'ikun', false, '喜剧大赛 ikun:第2期上就是学习对的第03集'], [YJ, '第05集', '1080zyk', true, '喜剧大赛 1080zyk:第05集'], [YJ, '第05集', 'yzzy', true, '喜剧大赛 yzzy:都是第N集,照常比'], [YJ, '第03集', 'yzzy', false, '喜剧大赛 yzzy:学习对的集号'],
        [MD, '第05集', 'jisu', false, '魔道祖师 jisu:学习对的集号'], [MD, '第09集', 'jisu', true, '魔道祖师 jisu:学习对之外'], [MD, '第07话', 'zy360', true, '魔道祖师 zy360:学习对之外'], [MD, '20240229期', 'zy360', false, '魔道祖师 第N集的包络、日期式'],
        [BS, '20240229期', '1080zyk', true, '半熟恋人 学出它的线路:学习对之外'], [BS, '20240227期', '1080zyk', false, '半熟恋人 学出它的线路:学习对的日期'], [BS, '20240229期', 'ikun', false, '半熟恋人 别的线路:日期可能差一天'], [BS, '第3期', '1080zyk', false, '半熟恋人 本线路但集号写法不同'],
        [LZ, '20220910（第2期上）', 'ikun', false, '差一天:ikun 20220910 = lzi 20220911'], [LZ, '20220917', 'ikun', false, '差一天:下一期'], [LZ, '第3期上', 'jisu', false, '日期式的包络、第N期'], [LZ, '第03集', 'jisu', false, '日期式的包络、第N集'],
        [{ peps: null, psite: 'S', pk: 'j' }, '第9集', 'S', false, '没有 peps'], [{ psite: 'S', pk: 'j' }, '第9集', 'S', false, '没有 peps 字段'], [{ peps: [1, 2], psite: 'S', pk: '' }, '第9集', 'S', false, '没有体系'], [{ peps: [1, 2], pk: 'q' }, '第9期', 'S', false, '第N期没有学习线路'], [{ peps: [1, 2], pk: 'd' }, '20240229', 'S', false, '日期式没有学习线路'], [{ peps: [1, 2], pk: 'j' }, '第9集', 'S', true, '第N集没有学习线路也能比'],
    ]) ok(WIT(env, name, site) === want, '独立证据 ' + why + ' → ' + want, { env, name, site });
    ok(C.pairWitness({ pid: '', peps: [1, 2], psite: 'S', pk: 'j' }, { ep: 9, part: 0, kind: 'ji' }, 'S') === false, '没有 pid:不算');
    ok(C.pairWitness({ pid: 'p', peps: [1, 2], psite: 'S', pk: 'j' }, null, 'S') === false, '这一集不在列表里:不算');
    ok(C.pairWitness({ pid: 'p', peps: [1, 2], psite: 'S', pk: '' }, null, 'S') === false, '这一集不在列表里、包络也没记体系:不算,不报错');
    ok(C.pairWitness(null, { ep: 9, part: 0, kind: 'ji' }, 'S') === false, '没有包络:不算');
    // 普通电视剧:和以前一样的顺序,只多一层校验
    const old = (list, url) => { const idx = list.findIndex(e => e.url === url); for (const j of [idx + 1, idx - 1, idx + 2, idx - 2]) if (j >= 0 && j < list.length && list[j].url !== url) return list[j].url; return null; };
    for (const [name, gen] of [['第N集', i => '第' + (i + 1) + '集'], ['第0N集', i => '第' + String(i + 1).padStart(2, '0') + '集'], ['数字', i => String(i + 1).padStart(2, '0')], ['EP', i => 'EP' + (i + 1)], ['第N话', i => '第' + (i + 1) + '话'], ['中文数字', i => '第' + '一二三四五六七八九十'[i] + '集']]) {
        const list = Array.from({ length: 10 }, (_, i) => ({ name: gen(i), url: 'u' + i }));
        let same = true, nums = true;
        for (let i = 0; i < 10; i++) { const r = C.pickPair(list, 'u' + i); if (!r || r.url !== old(list, 'u' + i)) same = false; if (C.epInfos(list)[i].ep !== i + 1 || C.epInfos(list)[i].variant) nums = false; }
        ok(same, '电视剧 ' + name + ':配对和以前一样');
        ok(nums, '电视剧 ' + name + ':集号和以前一样,都是正片');
    }

    // 全流程:变体集不分析、不写墓碑;找不到配对不学、不写墓碑、不进 LEARN_BLOCK
    const names3 = ['第1期纯享版', '第1期上', '第1期下', '第2期上'];
    const vf = makeFlow({ a: J.A, b: J.B, c: J.C, d: J.A }, { needOutro: true });
    const tails0 = [];
    vf.A._fetchTailEnv = async (s) => { tails0.push(s.url); return false; };
    await vf.runNames(names3, 0);
    ok(vf.fetchCalls.length === 0 && vf.ups.length === 0 && !tails0.length && !vf.posts.length && Object.keys(vf.marks).length === 0, '变体集:不抓片头、不抓片尾、不上报、不写本地', { calls: vf.fetchCalls, ups: vf.ups, tails: tails0 });
    const nf = makeFlow({ a: J.A, b: J.B, c: J.C }, { needOutro: true });
    const tails1 = [];
    nf.A._fetchTailEnv = async (s) => { tails1.push(s.url); return false; };
    await nf.runNames(['第1期上', '第1期下', '第1期纯享版'], 0);
    ok(nf.fetchCalls.length === 0 && nf.ups.length === 0 && !tails1.length && Object.keys(nf.marks).length === 0, '找不到配对:不学,不写墓碑', { calls: nf.fetchCalls, ups: nf.ups });
    ok(nf.A._st['T|S'].tries === 0 && nf.A._st['T|S'].phase === 'idle', '找不到配对:不算试过,阶段不变', nf.A._st['T|S']);
    ok(nf.conLog.some(s => /找不到能配对/.test(s)), '找不到配对:控制台说明了原因');
    ok(!nf.A._epDone['T|S|1|1'], '找不到配对:不记完成(列表更新了还能学)');
    ok(C.learnMissCount(nf.marks, 'r', Date.now()) === 0, '找不到配对:不进 LEARN_BLOCK');
    // 奇葩说第七季全流程:真 learnOrDetect 真的分析,抓第20201224(上)期做学习对,写带部分的键
    const qf = makeFlow({ a: J.A, c: J.B });
    await qf.runNames(QP, 0);
    ok(qf.fetchCalls.some(c => c.url === 'u:a') && qf.fetchCalls.some(c => c.url === 'u:c') && !qf.fetchCalls.some(c => c.url === 'u:b'), '奇葩说第七季:第20201217(上)期配第20201224(上)期', qf.fetchCalls.map(c => c.url));
    ok(qf.ups.length === 2 && qf.ups.every(u => u.part === 1 && u.oe > u.os) && !!qf.marks['20201217|r|1'] && !!qf.marks['20201224|r|1'], '奇葩说第七季:学出来了,按部分写键', qf.ups);
    // 借来的包络没中、列表里又找不到配对:记定位不中,否则每个会话都拿借来的包络重抓一遍(乘风2024 hongniuzy 第1期(中) 实测每会话 165MB)
    const bwSrc = makeFlow({ a: J.A, b: J.B });
    await bwSrc.run(21, 'a', 22, 'b');
    const bwEnv = { ...bwSrc.A._st['T|S'].intro, iB: 1, from: 'X' };
    const bwFlow = (data, opts, env) => { const f = makeFlow(data, opts || {}); f.A._st['T|S'] = { phase: 'idle', tries: 0, intro: { ...(env || bwEnv) }, outroTries: 0, mb: 0, envFetched: 1 }; return f; };
    const MID = ['第1期上', '第1期中', '第1期下', '第2期上', '第2期下'], MISS = J.A.slice(0, 1);   // 第1期中:没有别的"中",配不了对
    const m1 = bwFlow({ b: MISS });
    await m1.runNames(MID, 1);
    ok(m1.fetchCalls.length >= 1 && m1.fetchCalls.every(c => c.url === 'u:b') && m1.ups.length === 1 && m1.ups[0].ep === 1 && m1.ups[0].part === 2 && m1.ups[0].miss === 1 && m1.marks['1|r|2'].miss === 1, '借来的没中、找不到配对:记定位不中,按部分写键', { calls: m1.fetchCalls, ups: m1.ups });
    ok(m1.A._st['T|S'].tries === 0 && C.learnMissCount(m1.marks, 'r', Date.now(), 2) === 0, '借来的没中、找不到配对:不算学不出,不进 LEARN_BLOCK', m1.A._st['T|S'].tries);
    ok(m1.conLog.some(s => /找不到能配对/.test(s)) && !m1.conLog.some(s => /回退冷启动/.test(s)), '借来的没中、找不到配对:日志不说回退冷启动', m1.conLog);
    const m1n = m1.fetchCalls.length;
    m1.A._st = {}; m1.A._epDone = {};
    await m1.runNames(MID, 1);
    ok(m1.fetchCalls.length === m1n && m1.ups.length === 1, '记完新会话不再抓', m1.fetchCalls.length);
    ok(m1.conLog.some(s => /第1集不分析: 片头算不出\(1\)的墓碑还有效/.test(s)), '记完新会话:日志说明了为什么不分析', m1.conLog);
    // 已判过学不出的集,这条路照旧升成 3
    const m3 = bwFlow({ b: MISS }, { marks: { '1|r|2': { os: 0, oe: 0, mv: 2, miss: 2, mt: Date.now(), ed: 99999 } } });
    await m3.runNames(MID, 1);
    ok(m3.ups.length === 1 && m3.ups[0].miss === 3 && m3.marks['1|r|2'].miss === 3, '学不出的集借包络也没中、找不到配对:记 3', m3.ups);
    const m4 = bwFlow({ a: MISS }, { marks: { '1|r|1': { os: 0, oe: 0, mv: 2, miss: 2, mt: Date.now(), ed: 99999 } } });
    await m4.runNames(MID, 0);
    ok(m4.ups.length === 1 && m4.ups[0].miss === 3 && m4.marks['1|r|1'].miss === 3 && m4.fetchCalls.length >= 1 && m4.fetchCalls.every(c => c.url === 'u:a'), '学不出的集有配对、借包络也没中:记 3,不抓配对那集', { ups: m4.ups, calls: m4.fetchCalls });
    // 解码失败不算数:一段音频都没有、失败太多,都不写墓碑,下个会话还试
    const m0 = bwFlow({});
    await m0.runNames(MID, 1);
    ok(m0.fetchCalls.length >= 1 && !m0.ups.length && !m0.marks['1|r|2'], '找不到配对、0 片清单:不写墓碑', m0.ups);
    const mf = bwFlow({ b: MISS }, { onFetch: (s) => { s.decFail = 5; s.segs = 10; } });
    await mf.runNames(MID, 1);
    ok(mf.fetchCalls.length >= 1 && !mf.ups.length && !mf.marks['1|r|2'], '找不到配对、解码失败太多:不写墓碑', mf.ups);
    const mfn = mf.fetchCalls.length;
    mf.A._st['T|S'] = { phase: 'idle', tries: 0, intro: { ...bwEnv }, outroTries: 0, mb: 0, envFetched: 1 }; mf.A._epDone = {};
    await mf.runNames(MID, 1);
    ok(mf.fetchCalls.length > mfn, '找不到配对、解码失败太多:下个会话还试', mf.fetchCalls.length);
    // 有配对的集:借来的没中照旧回退冷启动,学出来就不留墓碑
    const noiseEnv = { ...bwEnv, env: Float32Array.from({ length: bwEnv.env.length }, (_, i) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1) };
    const mp = bwFlow({ a: J.A, d: J.B }, {}, noiseEnv);
    await mp.runNames(MID, 0);
    ok(mp.conLog.some(s => /回退冷启动/.test(s)) && mp.ups.length === 2 && mp.ups.every(u => !u.miss && u.oe > u.os), '有配对:借来的没中,回退冷启动学出来,不留墓碑', mp.ups);
    // 配对只用同部分:真 learnOrDetect 抓的是第2期上,不是第1期下
    const pf = makeFlow({ a: J.A, b: J.C, c: J.B, d: J.C });
    await pf.runNames(['第21期上', '第21期下', '第22期上', '第22期下'], 0);
    ok(pf.fetchCalls.some(c => c.url === 'u:a') && pf.fetchCalls.some(c => c.url === 'u:c') && !pf.fetchCalls.some(c => c.url === 'u:b' || c.url === 'u:d'), '学习对:第21期上配第22期上,不抓第21期下', pf.fetchCalls.map(c => c.url));
    ok(pf.ups.length === 2 && pf.ups.every(u => u.part === 1) && pf.ups.map(u => u.ep).join() === '21,22', '上报带部分字段', pf.ups);
    ok(pf.marks['21|r|1'] && pf.marks['22|r|1'] && !pf.marks['21|r'] && !pf.marks['22|r'], '本地写带部分的键,不写普通键', Object.keys(pf.marks));
    ok(pf.A._epDone['T|S|21|1'] === 1 && pf.A._epDone['T|S|22|1'] === 1 && !pf.A._epDone['T|S|21'], '完成记录也按部分记:下半还能算', pf.A._epDone);
    // 上半学到的,不会套到下半:下半没值,要自己定位
    const hf = makeFlow({ a: J.A, b: J.C, c: J.B, d: J.C }, { marks: pf.marks });
    hf.A._st['T|S'] = { phase: 'learned', tries: 0, intro: pf.A._st['T|S'].intro, outroTries: 0, mb: 0, envFetched: 1 };
    const hCur = await hf.runNames(['第21期上', '第21期下', '第22期上', '第22期下'], 1);
    ok(hf.fetchCalls.some(c => c.url === 'u:b') && hf.ups.length === 1 && hf.ups[0].part === 3 && !!hf.marks['21|r|3'], '第21期下:不读上半的值,自己定位,写下半的键', { calls: hf.fetchCalls.map(c => c.url), ups: hf.ups });
    ok(hf.marks['21|r|1'].oe === pf.marks['21|r|1'].oe, '上半的值不动');
    ok(hf.ups[0].pend === 1 && hCur._introCur && !C.opAuto(hCur._introCur), '第21期下:期号在学习对里,不是独立证据,待确认', hf.ups[0]);
    // 片尾也只配同部分
    const of1 = makeFlow({ a: J.A, b: J.C, c: J.B, d: J.C }, { needOutro: true, marks: { '21|r|1': { os: 0, oe: 90, mv: 2 } } });
    const tailUrls = [];
    of1.A._fetchTailEnv = async (s) => { tailUrls.push(s.url); return false; };
    await of1.runNames(['第21期上', '第21期下', '第22期上', '第22期下'], 0);
    ok(tailUrls.includes('u:a') && tailUrls.includes('u:c') && !tailUrls.includes('u:b'), '片尾学习:同样配第22期上,不配第21期下', tailUrls);

    // 不分析的情况各留一行判定,排查"这集为什么没按钮"
    const noRun = async (mark, st, hook) => {
        const fl = makeFlow({ a: J.A }, { needOutro: true, marks: mark ? { '5|r': mark } : {} });
        fl.A._st['T|S'] = { phase: 'idle', tries: 0, intro: null, outroTries: 0, mb: 0, ...(st || {}) };
        if (hook) hook(fl);
        await fl.run(5, 'a');
        return fl;
    };
    const ED = 2000;
    for (const [name, mark, st, hook, re] of [
        ['有新算法的值', { os: 5, oe: 90, mv: 2, ed: ED }, null, null, /第5集不分析: 片头有新算法的值,片尾有值/],
        ['待确认', { os: 5, oe: 90, mv: 2, pend: 1, ed: ED }, null, null, /第5集不分析: 片头有待确认的值,片尾有值/],
        ['墓碑', { os: 0, oe: 0, mv: 2, miss: 1, mt: Date.now(), ed: ED }, null, null, /第5集不分析: 片头算不出\(1\)的墓碑还有效,片尾有值/],
        ['本线路学不出', { ed: ED }, { phase: 'nointro' }, null, /第5集不分析: 片头本线路学不出,片尾有值/],
        ['失败两次', { ed: ED }, { tries: 2 }, null, /第5集不分析: 片头本线路已失败 2 次,片尾有值/],
        ['本会话算过片头', { ed: ED }, null, f => { f.A._epDone['T|S|5'] = 1; }, /第5集不分析: 片头本会话算过,片尾有值/],
        ['片尾试过', { os: 5, oe: 90, mv: 2 }, { outroTries: 1 }, null, /第5集不分析: 片头有新算法的值,片尾本线路这次会话试过一次/],
        ['本会话算过片尾', { os: 5, oe: 90, mv: 2 }, null, f => { f.A._outroDone['T|S|5'] = 1; }, /第5集不分析: 片头有新算法的值,片尾本会话算过/],
        ['解不了', null, { noDecode: 1 }, null, /第5集不分析: 本机解不出/],
        ['别的分析在跑', null, null, f => { f.A._busy = true; }, /第5集不分析: 另一轮分析还没结束/],
        ['本线路分析中', null, { phase: 'pending' }, null, /第5集不分析: 另一轮分析还没结束/],
    ]) {
        const fl = await noRun(mark, st, hook);
        ok(fl.fetchCalls.length === 0 && !fl.ups.length && fl.conLog.filter(s => /不分析/.test(s)).length === 1 && fl.conLog.some(s => re.test(s)), '判定日志:' + name, fl.conLog);
    }
    // 等播放稳定的 60 秒里:换了集、别的分析先开跑
    const waitOf = async (onRead) => {
        const fl = makeFlow({ a: J.A });
        const need0 = fl.A._introNeed;
        fl.A._introNeed = function (o, m) { let n = 0; Object.defineProperty(o.vue, '_playToken', { get() { return onRead(fl, n++); } }); return need0.call(this, o, m); };
        await fl.run(5, 'a');
        return fl;
    };
    const wt = await waitOf((fl, n) => n ? 2 : 1);
    ok(wt.fetchCalls.length === 0 && wt.conLog.some(s => /第5集不分析: 等播放稳定时换了集或线路/.test(s)), '判定日志:等待时换集', wt.conLog);
    const wb = await waitOf((fl, n) => { if (n) fl.A._busy = true; return 1; });
    ok(wb.fetchCalls.length === 0 && wb.conLog.some(s => /第5集不分析: 另一轮分析还没结束/.test(s)), '判定日志:等待时别的分析先开跑', wb.conLog);
    // 正常分析不说"不分析"
    ok(!pf.conLog.some(s => /不分析/.test(s)), '正常分析:没有不分析的判定', pf.conLog);
}

console.log('⑧ 第三集确认');
{
    const C = makeEnv().C;
    const flowOf = (data, marks, intro) => {
        const fl = makeFlow(data, { marks: JSON.parse(JSON.stringify(marks || {})) });
        if (intro) fl.A._st['T|S'] = { phase: 'learned', tries: 0, intro, outroTries: 0, mb: 0, envFetched: 1 };
        return fl;
    };
    // 第一位观众冷启动学第 21/22 集
    const l = makeFlow({ a: J.A, b: J.B });
    const lv = await l.run(21, 'a', 22, 'b');
    const saved = l.A._st['T|S'].intro, rec = JSON.parse(l.localStorage.getItem('donggua_afpenv|T|S')), pid = saved.pid;
    ok(/^[a-z0-9]{4,24}$/.test(pid) && saved.peps.join() === '21,22' && saved.psite === 'S' && saved.pk === 'j', '学习:包络带学习对 id、那两集、学习线路、集号体系', { pid, peps: saved.peps, psite: saved.psite, pk: saved.pk });
    ok(rec.pid === pid && rec.peps.join() === '21,22', '学习:落盘的包络带 id', rec.pid);
    ok(l.posts.some(p => p.body && p.body.env && p.body.env.pid === pid && p.body.env.peps.join() === '21,22'), '学习:云备份带 id');
    ok(l.marks['21|r'].pend === 1 && l.marks['22|r'].pend === 1 && l.marks['21|r'].pid === pid && l.marks['22|r'].pid === pid, '学习:两集本地都待确认', l.marks);
    let pc = playCheck(lv._introCur);
    ok(lv._introCur.pend === 1 && lv._introCur.src !== 'afp' && pc.seeks.length === 0 && pc.btn === 'op', '学习:算出来的这位观众也只亮按钮', { cur: lv._introCur, pc });
    pc = playCheck(C.curOf(l.marks['21|r']));
    ok(pc.seeks.length === 0 && pc.btn === 'op', '学习对的值:后来的观众只亮按钮', pc);

    // 学习对之外定位命中:这一集能跳,学习对两集转正,不多下载
    const hit = flowOf({ c: J.C }, { '21|r': l.marks['21|r'], '22|r': l.marks['22|r'] }, saved);
    const hv = await hit.run(23, 'c');
    ok(hit.ups.length === 1 && hit.ups[0].ep === 23 && !hit.ups[0].pend && hit.ups[0].pid === pid, '第三集命中:上报不待确认,带 id(服务器据此转正)', hit.ups);
    pc = playCheck(hv._introCur);
    ok(hv._introCur.src === 'afp' && pc.seeks.length === 1, '第三集命中:这一集可以自动跳', { cur: hv._introCur, pc });
    ok(!hit.marks['21|r'].pend && !hit.marks['22|r'].pend && !hit.marks['23|r'].pend, '第三集命中:学习对两集本地也转正', hit.marks);
    pc = playCheck(C.curOf(hit.marks['21|r']));
    ok(pc.seeks.length === 1, '第三集命中:学习对的集可以自动跳了', pc);
    ok(new Set(hit.fetchCalls.map(c => c.url)).size === 1 && hit.fetchCalls[0].url === 'u:c', '确认不多下载:只抓观众本来就要定位的这一集', hit.fetchCalls.map(c => c.url));

    // 定位不中(伪装者那种假片头):只有墓碑,学习对还是待确认
    const miss = flowOf({ c: J.A.slice(0, 1) }, { '21|r': l.marks['21|r'], '22|r': l.marks['22|r'] }, saved);
    await miss.run(23, 'c');
    ok(miss.ups.length === 1 && miss.ups[0].miss === 1, '学习对之外定位不中:记墓碑', miss.ups);
    ok(miss.marks['21|r'].pend === 1 && miss.marks['22|r'].pend === 1, '学习对之外定位不中:学习对还是待确认,永远不会被自动跳', miss.marks);

    // 学习对自己的集(值丢了/别的线路借来定位)再中:不是独立证据
    const self = flowOf({ a: J.A }, {}, saved);
    const sv = await self.run(21, 'a');
    ok(self.ups[0].pend === 1 && self.ups[0].pid === pid && self.marks['21|r'].pend === 1, '学习对的集定位命中:还是待确认', self.ups);
    pc = playCheck(sv._introCur);
    ok(sv._introCur.src !== 'afp' && pc.seeks.length === 0, '学习对的集定位命中:只亮按钮', pc);
    const borrowed = flowOf({ a: J.A }, {}, { ...saved, iB: 1, from: 'X' });
    await borrowed.run(22, 'a');
    ok(borrowed.ups[0].pend === 1, '借别的线路的包络、定位到学习对的集号:还是待确认', borrowed.ups);
    const stored = JSON.parse(borrowed.localStorage.getItem('donggua_afpenv|T|S'));
    ok(stored.pid === pid && stored.peps.join() === '21,22', '借用转正登记:id 和那两集跟着包络走', stored.pid);
    const bh = flowOf({ c: J.C }, {}, { ...saved, psite: 'X', iB: 1, from: 'X' });
    const bhv = await bh.run(23, 'c');
    ok(!bh.ups[0].pend && bhv._introCur.src === 'afp' && playCheck(bhv._introCur).seeks.length === 1, '第 N 集:借别的线路的包络、定位到学习对之外的集,算确认', bh.ups);

    // 🔢 集号比得上才算确认:同一期在别的线路上可能是另一个数字(见 IntroCore.pairWitness),这些都只亮按钮
    const stillPend = (fl, v, label) => {
        const u = fl.ups[0], pc = playCheck(v._introCur);
        ok(fl.ups.length === 1 && u.pend === 1 && u.pid && v._introCur.pend === 1 && v._introCur.src !== 'afp' && pc.seeks.length === 0 && pc.btn === 'op', label, { ups: fl.ups, cur: v._introCur, pc });
    };
    const confirmedHit = (fl, v, label) => {
        const u = fl.ups[0], pc = playCheck(v._introCur);
        ok(fl.ups.length === 1 && !u.pend && u.pid && !v._introCur.pend && v._introCur.src === 'afp' && pc.seeks.length === 1, label, { ups: fl.ups, cur: v._introCur, pc });
    };
    // 脱口秀大会第五季:jisu 第1期上配第2期上;ikun 的 20220830(第1期上)就是第1期上,借去命中
    const qEnv = { ...saved, pid: 'pairqqqq', peps: [1, 2], psite: 'jisu', pk: 'q' };
    let f9 = flowOf({ c: J.C }, {}, { ...qEnv, iB: 1, from: 'jisu' });
    stillPend(f9, await f9.run(20220830, 'c'), '借 第N期 的包络、日期式集号命中(其实是学习对同一期):还是待确认');
    const reg = JSON.parse(f9.localStorage.getItem('donggua_afpenv|T|S'));
    ok(reg.pid === 'pairqqqq' && reg.psite === 'jisu' && reg.pk === 'q' && reg.peps.join() === '1,2', '借用转正登记到本线路:学习线路和集号体系不变', reg);
    f9 = flowOf({ c: J.C }, {}, qEnv);
    stillPend(f9, await f9.run(20220906, 'c'), '转正登记后(不再是借用)同线路下一期日期式命中:还是待确认,看学习线路不看 iB');
    // 新说唱2025:第20250607期上,日期写在 第…期 里
    f9 = flowOf({ a: J.C }, {}, { ...qEnv, iB: 1, from: 'jisu' });
    stillPend(f9, await f9.runNames(['第20250607期上', '第20250614期上'], 0), '借 第N期 的包络、第20250607期上命中:还是待确认');
    // 少写一位、两位年份也是日期式
    for (const nm of ['2024110上', '第2023012期', '240906上']) {
        f9 = flowOf({ a: J.C }, {}, { ...qEnv, iB: 1, from: 'jisu' });
        stillPend(f9, await f9.runNames([nm, '第99期'], 0), '借 第N期 的包络、' + nm + ' 命中:还是待确认');
    }
    // 日期式之间能差一天:lzi 的 20220911上 = ikun 的 20220910(第2期上)。借来时、转正登记后都不算
    const dEnv = { ...saved, pid: 'pairdddd', peps: [20220904, 20220911], psite: 'lzi', pk: 'd' };
    f9 = flowOf({ c: J.C }, {}, { ...dEnv, iB: 1, from: 'lzi' });
    stillPend(f9, await f9.run(20220910, 'c'), '借 日期式 的包络、别的线路的日期命中(差一天):还是待确认');
    f9 = flowOf({ c: J.C }, {}, dEnv);
    stillPend(f9, await f9.run(20220917, 'c'), '日期式包络转正登记后,别的线路下一期:还是待确认');
    f9 = flowOf({ c: J.C }, {}, { ...dEnv, iB: 1, from: 'lzi' });
    stillPend(f9, await f9.run(3, 'c'), '借 日期式 的包络、第N集命中:还是待确认');
    // 桃花坞第四季:dyttzy 第2期上 = bfzy 第3期(不分上下);一年一度喜剧大赛:ffzy 第02期上 = 1080zyk 第03集。序号相同体系也不能跨线路比
    f9 = flowOf({ a: J.C }, {}, { ...qEnv, iB: 1, from: 'dyttzy' });
    stillPend(f9, await f9.runNames(['第3期', '第4期'], 0), '第N期 跨线路(一边分上下一边不分):还是待确认');
    f9 = flowOf({ a: J.C }, {}, { ...qEnv, iB: 1, from: 'ffzy' });
    stillPend(f9, await f9.runNames(['第03集', '第04集'], 0), '第N期 借到 第N集 的线路:还是待确认');
    f9 = flowOf({ a: J.C }, {}, { ...saved, peps: [1, 2], psite: 'X', pk: 'j', iB: 1, from: 'X' });
    stillPend(f9, await f9.runNames(['第02期上', '第03期上'], 0), '第N集 借到 第N期 的线路:还是待确认');
    // 本线路自己的体系照常确认,学习对两集跟着转正
    const dSelf = { ...saved, pid: 'pairself', peps: [20240227, 20240228], psite: 'S', pk: 'd' };
    const dMarks = () => ({ '20240227|r': { os: 23, oe: 40, mv: 2, pid: 'pairself', pend: 1 }, '20240228|r': { os: 105, oe: 123, mv: 2, pid: 'pairself', pend: 1 } });
    f9 = flowOf({ c: J.C }, dMarks(), dSelf);
    confirmedHit(f9, await f9.run(20240229, 'c'), '日期式:学出它的线路上学习对之外的一期命中,算确认');
    ok(!f9.marks['20240227|r'].pend && !f9.marks['20240228|r'].pend, '日期式:本线路确认后学习对两集转正', f9.marks);
    f9 = flowOf({ c: J.C }, {}, dSelf);
    stillPend(f9, await f9.run(20240228, 'c'), '日期式:学习对自己那一期命中,还是待确认');
    const qSelf = { ...qEnv, psite: 'S' };
    f9 = flowOf({ a: J.C }, {}, qSelf);
    confirmedHit(f9, await f9.runNames(['第3期上', '第4期上'], 0), '第N期:学出它的线路上学习对之外的一期命中,算确认');
    f9 = flowOf({ a: J.C }, {}, qSelf);
    stillPend(f9, await f9.runNames(['第1期下', '第4期下'], 0), '第N期:学习对同一期的下半命中,还是待确认');
    f9 = flowOf({ a: J.C }, {}, { ...saved, peps: [21, 22], psite: 'S', pk: 'j' });
    stillPend(f9, await f9.runNames(['第23期', '第24期'], 0), '本线路混着两种写法(第N集学的,第N期命中):还是待确认');
    // 老记录缺字段:宁可只亮按钮
    f9 = flowOf({ c: J.C }, {}, { ...saved, pk: '' });
    stillPend(f9, await f9.run(23, 'c'), '包络没记集号体系:还是待确认');
    f9 = flowOf({ a: J.C }, {}, { ...qEnv, psite: '' });
    stillPend(f9, await f9.runNames(['第3期上', '第4期上'], 0), '第N期的包络没记学习线路:还是待确认');
    f9 = flowOf({ c: J.C }, {}, { ...saved, psite: '' });
    confirmedHit(f9, await f9.run(23, 'c'), '第N集的包络没记学习线路:不影响,第N集各线路能比');
    // 学习时记下的体系
    const learnOf = async (names) => { const fl = makeFlow({ a: J.A, b: J.B }); await fl.runNames(names, 0); return { fl, intro: fl.A._st['T|S'].intro, rec: JSON.parse(fl.localStorage.getItem('donggua_afpenv|T|S')) }; };
    let lr = await learnOf(['第21集', '第22集']);
    ok(lr.intro.pk === 'j' && lr.intro.psite === 'S' && lr.rec.pk === 'j' && lr.rec.psite === 'S', '学习第N集:记下 j 和学习线路', { pk: lr.rec.pk, psite: lr.rec.psite });
    ok(lr.fl.posts.some(p => p.body && p.body.env && p.body.env.pk === 'j' && p.body.env.psite === 'S'), '学习:云备份也带学习线路和集号体系');
    lr = await learnOf(['第21期上', '第22期上']);
    ok(lr.rec.pk === 'q' && lr.rec.psite === 'S', '学习第N期上:记下 q', lr.rec.pk);
    lr = await learnOf(['20240227期', '20240228期']);
    ok(lr.rec.pk === 'd' && lr.rec.psite === 'S', '学习日期式:记下 d', lr.rec.pk);
    lr = await learnOf(['第21集', '20240228期']);
    ok(lr.intro.pid && !lr.rec.pk && lr.intro.pk === '', '学习对两集不是一套集号:不记体系,这条包络谁也确认不了', lr.intro.pk);
    // 借来的没中:丢掉,重学时用本线路自己的
    f9 = makeFlow({ a: J.A, b: J.B });
    f9.A._st['T|S'] = { phase: 'learned', tries: 0, intro: { ...qEnv, env: new Float32Array(saved.env.length).map((_, i) => (i * 7919 % 97) / 1000), iB: 1, from: 'jisu' }, outroTries: 0, mb: 0, envFetched: 1 };
    await f9.run(21, 'a', 22, 'b');
    const relearn = f9.A._st['T|S'].intro;
    ok(relearn.pid !== 'pairqqqq' && relearn.psite === 'S' && relearn.pk === 'j' && relearn.peps.join() === '21,22', '借来的包络没中、重学:新包络是本线路自己的', { pid: relearn.pid, psite: relearn.psite, pk: relearn.pk });
    // 本线路已确认过这条包络:学习对的集后来才算到,也算确认过
    const later = flowOf({ a: J.A }, { '23|r': { os: 0, oe: 90, mv: 2, pid } }, saved);
    const lat = await later.run(21, 'a');
    ok(!later.ups[0].pend && lat._introCur.src === 'afp', '本线路已确认过这条包络:学习对的集定位到也算确认过', later.ups);

    // 两个学习对凑集数:确认不了
    const pairA = { ...saved, pid: 'pairaaaa', peps: [21, 22] }, pairB = { ...saved, pid: 'pairbbbb', peps: [23, 24] };
    const two = { '21|r': { os: 0, oe: 90, mv: 2, pid: 'pairaaaa', pend: 1 }, '22|r': { os: 0, oe: 90, mv: 2, pid: 'pairaaaa', pend: 1 }, '23|r': { os: 0, oe: 90, mv: 2, pid: 'pairbbbb', pend: 1 }, '24|r': { os: 0, oe: 90, mv: 2, pid: 'pairbbbb', pend: 1 } };
    const nothing = flowOf({ a: J.A, c: J.C }, two, pairA);
    await nothing.run(23, 'c');
    await nothing.run(21, 'a');
    ok(nothing.fetchCalls.length === 0 && Object.values(nothing.marks).every(m => m.pend === 1), '两个学习对凑够 4 集:不分析、全部还是待确认', nothing.marks);
    const onlyB = flowOf({ c: J.C }, two, pairB);
    await onlyB.run(25, 'c');
    ok(!onlyB.marks['23|r'].pend && !onlyB.marks['24|r'].pend && onlyB.marks['21|r'].pend === 1 && onlyB.marks['22|r'].pend === 1, '第五集用第二条包络命中:只转正第二对,第一对不动', onlyB.marks);
    // 没有 id 的包络:命中也确认不了
    const noId = flowOf({ c: J.C }, {}, { ...saved, pid: '', peps: null });
    const nv = await noId.run(23, 'c');
    ok(noId.ups[0].pend === 1 && !noId.ups[0].pid && nv._introCur.src !== 'afp', '没有 id 的包络:命中也只亮按钮', noId.ups);
    // 贴片跟着记录走:待确认的贴片也不跳
    const R = Array.from({ length: 10 }, (_, j) => Array.from({ length: 19 }, (_, i) => 3000 + ((j * 19 + i) * 7919 % 997) * 20));
    const bEnv = Float32Array.from(R.flatMap(r => [...r, r[18]]).map(x => x / 1e5));
    const bData = [...R.map((r, j) => ({ st: 10 + j * 2, r })), ...J.A];
    const bp = flowOf({ a: bData }, {}, { ...saved, benv: bEnv, bdur: 20, bdv: 3 });
    const bv = await bp.run(21, 'a');
    pc = playCheck(bv._introCur);
    ok(bv._introCur.pend === 1 && bv._introCur.bmv === 3 && pc.seeks.length === 0 && pc.btn === 'bump,op', '待确认的贴片:带 bmv 也不跳,只亮按钮', { cur: bv._introCur, pc });
    // 引擎学到的值和旧片尾都不被信任(这里只钉真实 check 的结果,引擎的代码路径见 intro-mark-migrate-test)
    pc = playCheck({ os: 100, oe: 200, ed: 0 });
    ok(pc.seeks.length === 0 && pc.btn === 'op', '只有时间、没有 mv 的 _introCur(边看边学引擎):只亮按钮', pc);
}

console.log('⑨ 开头贴片');
{
    const { A, C } = makeEnv();
    const BD = FX.bump_d, BL = FX.bump_l, sec = (x) => Math.round(x) / 10;
    ok(C.BUMP_V === 3 && C.MARK_V === 2, '贴片版本单独算:bmv:3 才自动跳,片头还是 mv:2');
    // 真实假贴片:旧判定(前 150s 整段 ≥0.6)都命中,抽帧是正片或片中转场;新判定都不中
    for (const [k, name] of [['cf0422', '乘风2024 ikun 第20240422期 109.8s,嘉宾聊天'], ['cf0426', '乘风2024 ikun 第20240426期 111.8s'], ['ym8', '隐秘的角落 1080zyk 第8集 112.1s,海滩正片'], ['ym10', '隐秘的角落 1080zyk 第10集 83.6s'], ['zs3', '咒术回战 zy360 第3集 109.6s,对白']]) {
        const d = BD[k], env = F32(d.env), head = F32(d.head), old = A._xcorrDetect(env, head, Math.min(head.length, 1500));
        ok(old && old.at === d.oldAt && old.conf < 0.75, '旧判定:' + name + ' 命中', old);
        ok(C.bumpLocate(env, head, head.length, null) === null, '新判定:' + name + ' 不中');
    }
    // 只提高整段线不够:0.8 放到前 30s 也有误命中(乘风2024 第20240422期 7.9s 0.62 这种只是 0.6 线挡不住;别的剧头部能到 0.85 以上)
    {
        const d = BD.neg85, env = F32(d.env), head = F32(d.head), hi = A._xcorrDetect(env, head, Math.min(head.length, 300 + env.length), 0.85);
        ok(hi && hi.at > 30, '别的剧头部:整段 Pearson 能到 0.85,光提高线挡不住(' + d.src + ')', hi);
        ok(C.bumpLocate(env, head, head.length, null) === null, '别的剧头部:locate 不中(' + d.src + ')');
    }
    // 真实真贴片。be=位置+长度,不能切到正片:天官赐福第 3 集 28s 已是字幕;哈哈哈哈哈第 2 期下 14s 进正片;向往的生活 25s 进正片
    const T = [
        ['tg3', 0, 27.2, 0.2, '天官赐福第 3 集:旧包络 31.8s,尾部收回到 logo 后的黑场'],
        ['tg7', 14.1, 45, 0.2, '天官赐福第 7 集:贴片前面多 14.1s;旧算法的 31.8s 包络落到 45.0s(抽帧 43s 起已是正片),所以没版本的旧包络只亮按钮,见下'],
        ['yfx16', 0, 16.4, 0.2, '与凤行第 16 集:尾部 1s 对不上,整段只有 0.82,主体 0.99 还是中'],
        ['xw605', 0.8, 24.4, 0.2, '向往的生活第七季 ikun 20230605:旧判定漏掉(整段 0.60),新判定看主体'],
        ['hh23', 0, 13.2, 0.2, '哈哈哈哈哈第四季第 2 期下:旧包络 15s,收回到 13.2s'],
        ['md16', 0, 16.8, 0.1, '魔道祖师第 16 集:92.8s 处还有 0.81 的相似段,不影响'],
        ['ym7', 0, 7.4, 0.1, '隐秘的角落 1080zyk 第 7 集:7.4s 短包络,0.96'],
        ['zhj10', 0, 5.4, 0.1, '镇魂街第 10 集:5.4s,贴着最短线'],
        ['cm6', 0, 7.8, 0.1, '沉默的真相第 6 集:新选的剧'],
    ];
    for (const [k, at, be, tol, name] of T) {
        const d = BD[k], h = C.bumpLocate(F32(d.env), F32(d.head), d.head.length, null);
        ok(h && near(h.at / 10, at, 0.21) && near((h.at + h.len) / 10, be, tol), name, h && { at: h.at, len: h.len, conf: h.conf });
    }
    {
        // 天官赐福第 7 集:新算法学出的长度(学习对收回到 27.2s,见下面 tg12)落在 41.3s,logo 后的黑场;旧的 31.8s 包络落到 45.0s
        const d = BD.tg7, h = C.bumpLocate(F32(d.env).slice(0, 272), F32(d.head), d.head.length, null);
        ok(h && near(h.at / 10, 14.1, 0.21) && near((h.at + h.len) / 10, 41.3, 0.2), '天官赐福第 7 集:新算法长度的包络落在 41.3s 黑场', h && { at: h.at, len: h.len, conf: h.conf });
    }
    {
        // 极限挑战第九季 20230430:19.8s 的 5.2s 广告尾标,定位是对的(0.98),这一集尾部对不上,收回后不到 5s,不要(损失,跳它也只跳掉一小段广告)
        const d = BD.jx430, env = F32(d.env), head = F32(d.head), h = C.locate(env, head, head.length, null);
        ok(h && near(h.at / 10, 19.8, 0.1) && C.bumpLocate(env, head, head.length, null) === null, '收回后短于 5s:不要', h);
    }
    // 只在集首找:把真贴片挪到 31s,再好也不要;30s 还算(真贴片起点 0~23s,假的 35s 起)
    {
        const d = BD.cm6, env = F32(d.env), L = env.length;
        const pad = (n) => { const f = new Float32Array(n + d.head.length); for (let i = 0; i < n; i++) f[i] = 0.05 + 0.01 * Math.sin(i * 1.7); f.set(F32(d.head), n); return f; };
        let h = C.bumpLocate(env, pad(300), 300 + d.head.length, null);
        ok(h && h.at === 300, '贴片起点 30s:算', h);
        ok(C.bumpLocate(env, pad(301), 301 + d.head.length, null) === null, '贴片起点 30.1s:不算');
        h = C.locate(env, pad(301), 301 + d.head.length, null);
        ok(h && h.at === 301, '(同一段 locate 本身是中的,挡住它的是位置)', h);
        // 短于 5s 的包络不要:同一段切成 4.9s,对得再好也不算
        const short = F32(d.env.slice(0, 49));
        ok(C.locate(short, F32(d.head), d.head.length, null) && C.bumpLocate(short, F32(d.head), d.head.length, null) === null, '包络短于 5s:不用');
        ok(C.bumpLocate(F32(d.env.slice(0, 50)), F32(d.head), d.head.length, null) !== null, '包络正好 5s:还用');
    }
    // 学习对:收回尾部、A 集的包络要能在 B 集原位定位中
    const mk = (x) => { const eA = F32(x.A), eB = F32(x.B), full = (f) => new Uint8Array(f.length).fill(1); return { c: { eA, eB, covA: full(eA), covB: full(eB) }, nB: eB.length }; };
    const LT = [
        ['yn23', 157, '一年一度喜剧大赛 ikun:17.4s 收回 15.7s(16s 已是正片)'],
        ['hh', 131, '哈哈哈哈哈第四季 zy360:15s 收回 13.1s(14s 已是正片)'],
        ['xd', 284, '令人心动的offer ikun:30.2s 收回 28.4s(另一集 28.4s 进黑场接正片)'],
        ['tg12', 272, '天官赐福 jisu:31.8s 靠多看 3s 找到 logo 后的黑场,收回 27.2s'],
        ['xw', 236, '向往的生活第七季 ikun:25.6s 收回 23.6s;整段只有 0.70,主体够'],
        ['wz78', 185, '伪装者 jisu 第 7、8 集:19.2s 收回 18.5s(第一个镜头在 18.4s)'],
        ['md78', 168, '魔道祖师 jisu:结尾就是公共静音,不收'],
    ];
    for (const [k, len, name] of LT) {
        const x = BL[k], { c, nB } = mk(x), r = C.bumpLearn({ aStart: x.aStart, bStart: x.bStart, len: x.len, conf: x.conf }, c, nB, null);
        ok(r && r.aStart === x.aStart && r.bStart === x.bStart && near(r.len, len, 2), name, r);
    }
    for (const [k, name] of [['cf', '乘风2024 ikun 35.4s / 46.7s:片中转场,位置就不对'], ['zs', '咒术回战 zy360 17.4s / 47.1s:正片,47.1s 位置不对'], ['bp', '奔跑吧第八季 jisu 5.2s / 6.6s:位置对,5s 只有 0.77,定位过不了'], ['jx', '极限挑战第九季 44.1s / 10s:真广告,但不在集首(损失)'], ['tk', '脱口秀大会第五季 22.1s / 22s:真广告,只有 0.61(损失)']]) {
        const x = BL[k], { c, nB } = mk(x);
        ok(C.bumpLearn({ aStart: x.aStart, bStart: x.bStart, len: x.len, conf: x.conf }, c, nB, null) === null, '学习对不写:' + name);
    }
    // 位置这一条单独挡:把能过的那一对整体往后挪过 30s
    {
        const x = BL.md78, n = 301, shiftArr = (a) => { const f = new Float32Array(n + a.length); for (let i = 0; i < n; i++) f[i] = 0.05 + 0.01 * Math.sin(i * 1.3 + (a.length % 7)); f.set(F32(a), n); return f; };
        const eA = shiftArr(x.A), eB = shiftArr(x.B), full = (f) => new Uint8Array(f.length).fill(1), c = { eA, eB, covA: full(eA), covB: full(eB) };
        ok(C.bumpLearn({ aStart: n, bStart: n, len: x.len }, c, eB.length, null) === null, '学习对:两集都在 30.1s:不要');
        ok(C.bumpLearn({ aStart: 0, bStart: n, len: x.len }, { eA: F32(x.A), eB, covA: full(F32(x.A)), covB: full(eB) }, eB.length, null) === null, '学习对:只有 B 集在 30.1s:也不要');
        const n2 = 300, a2 = new Float32Array(n2 + x.A.length), b2 = new Float32Array(n2 + x.B.length);
        for (let i = 0; i < n2; i++) { a2[i] = 0.05 + 0.01 * Math.sin(i * 1.3); b2[i] = 0.03 + 0.02 * Math.sin(i * 2.1); }
        a2.set(F32(x.A), n2); b2.set(F32(x.B), n2);
        ok(C.bumpLearn({ aStart: n2, bStart: n2, len: x.len }, { eA: a2, eB: b2, covA: full(a2), covB: full(b2) }, b2.length, null) !== null, '学习对:两集都在 30s:还算');
    }
    // A 集的包络在 B 集定位到别处:这一对对不上,不要(给错 bStart)
    {
        const x = BL.md78, { c, nB } = mk(x);
        ok(C.bumpLearn({ aStart: 0, bStart: 20, len: x.len }, c, nB, null) === null, '学习对:对不到原位,不要');
    }
    // 尾部 ≥4s 对不上:tailCut 只看最后 2s,靠定位收回
    {
        const x = BL.yn23, eA = F32(x.A), eB = F32(x.B).slice(), full = (f) => new Uint8Array(f.length).fill(1);
        for (let i = 100; i < eB.length; i++) eB[i] = 0.2 + 0.15 * Math.sin(i * 0.9) * Math.sin(i * 0.13);
        const r = C.bumpLearn({ aStart: 0, bStart: 0, len: 174 }, { eA, eB, covA: full(eA), covB: full(eB) }, eB.length, null);
        ok(r && r.len >= 95 && r.len <= 125, '学习对:尾部 ≥4s 对不上,长度跟着定位收回', r);
    }
    // 收回太短也不要
    {
        const x = BL.md78, { c, nB } = mk(x);
        ok(C.bumpLearn({ aStart: 0, bStart: 0, len: 49 }, c, nB, null) === null, '学习对:短于 5s 不要');
    }
    // 片头的 tailCut 默认行为没变:不传 silWin 还是只看最后 3s
    {
        const x = BL.tg12, { c } = mk(x);
        ok(near(C.tailCut(c, 0, 0, x.len).end, 303, 3), '片头用的 tailCut 默认只看 3s,天官赐福这里走能量比(不是 27.2s 那段黑场)', C.tailCut(c, 0, 0, x.len));
        ok(C.tailCut(c, 0, 0, x.len, 60).end === 272, '贴片给 6s:找到黑场', C.tailCut(c, 0, 0, x.len, 60));
    }

    // 真 learnOrDetect + 真 check():贴片不再跟着片头切正片
    const toChunks = (arr, st0 = 0) => { const out = []; for (let k = 0; k * 20 < arr.length; k++) { const r = arr.slice(k * 20, k * 20 + 20); if (r.length) out.push({ st: st0 + k * 2, r }); } return out; };
    const base = makeFlow({ a: J.A, b: J.B });
    await base.run(21, 'a', 22, 'b');
    const saved = base.A._st['T|S'].intro;
    const flowB = (data, intro, marks) => { const fl = makeFlow({ c: data }, marks ? { marks } : {}); fl.A._st['T|S'] = { phase: 'learned', tries: 0, intro: { ...saved, ...intro }, outroTries: 0, mb: 0 }; return fl; };
    {
        const d = BD.cf0422, fl = flowB([...toChunks(d.head), ...shift(J.C, 130)], { benv: F32(d.env), bdur: d.env.length / 10 }), v = await fl.run(23, 'c'), pc = playCheck(v._introCur);
        ok(fl.ups[0] && fl.ups[0].oe > 0 && !fl.ups[0].bump && !fl.ups[0].bmv, '乘风2024 ikun 第20240422期:片头定位中,假贴片不写、不上报', fl.ups);
        ok(pc.seeks.length === 1 && near(pc.seeks[0], v._introCur.oe, 0.01) && pc.btn === '' && v._introCur.src === 'afp', '乘风2024 ikun 第20240422期:开着自动跳过只跳片头,109.8s 不跳', { cur: v._introCur, pc });
        ok(fl.A._st['T|S'].intro.benv && fl.A._st['T|S'].intro.benv.length === d.env.length, '本线路的贴片包络没中:留着(和以前一样,这一集不中不代表别的集不中)');
    }
    {
        // 新算法学的包络(带 bdv:3,长度是学习对收回后的 27.2s)
        const d = BD.tg3, fl = flowB([...toChunks(d.head), ...shift(J.C, 0)], { benv: F32(d.env).slice(0, 272), bdur: 27.2, bdv: 3 }), v = await fl.run(23, 'c'), pc = playCheck(v._introCur), u = fl.ups[0];
        ok(u && u.bump && u.bump.bs === 0 && near(u.bump.be, 27.2, 0.2) && u.bmv === 3 && !u.pend, '天官赐福第 3 集:贴片 0→27.2s,上报带 bmv:3', u);
        ok(near(fl.marks['23|r'].be, 27.2, 0.2) && fl.marks['23|r'].bmv === 3, '天官赐福第 3 集:本地缓存同样的值', fl.marks['23|r']);
        ok(pc.seeks.length === 2 && near(pc.seeks[0], 27.2, 0.2) && near(pc.seeks[1], v._introCur.oe, 0.01), '天官赐福第 3 集:贴片和片头都自动跳,落点在 28s 字幕之前', pc);
    }
    {
        // 同一集用没版本的旧包络(旧算法学的 31.8s):定位出来一样是 0→27.2,但按旧值算:本地 bmv:2、上报不带 bmv(服务器按 2 存),开着自动跳过只亮按钮,片头照跳
        const d = BD.tg3, fl = flowB([...toChunks(d.head), ...shift(J.C, 0)], { benv: F32(d.env), bdur: d.env.length / 10 }), v = await fl.run(23, 'c'), pc = playCheck(v._introCur), u = fl.ups[0];
        ok(u && u.bump && u.bump.bs === 0 && near(u.bump.be, 27.2, 0.2) && !('bmv' in u) && u.mv === 2 && !u.pend, '没版本的旧包络:贴片照样上报,不带 bmv', u);
        ok(fl.marks['23|r'].bmv === 2 && v._introCur.bmv === 2 && v._introCur.src === 'afp', '没版本的旧包络:本地记 bmv:2', { m: fl.marks['23|r'], cur: v._introCur });
        ok(pc.seeks.length === 1 && near(pc.seeks[0], v._introCur.oe, 0.01) && pc.btn === 'bump', '没版本的旧包络:片头已确认也只跳片头,贴片只亮按钮', pc);
        const rec = JSON.parse(fl.localStorage.getItem('donggua_afpenv|T|S'));
        ok(!rec || (rec.bd && !('bdv' in rec)), '没版本的旧包络转正回传:还是没版本(不会因为这次命中变成 bdv:3)', rec && { bdv: rec.bdv, bdur: rec.bdur });
        // 天官赐福第 7 集:旧包络落到 45.0s(切掉 43~45s 正片),新页面也只亮按钮
        const d7 = BD.tg7, f7 = flowB([...toChunks(d7.head), ...shift(J.C, 130)], { benv: F32(d7.env), bdur: d7.env.length / 10 }), v7 = await f7.run(23, 'c'), p7 = playCheck(v7._introCur);
        ok(f7.ups[0] && f7.ups[0].bump && near(f7.ups[0].bump.be, 45, 0.2) && !('bmv' in f7.ups[0]) && p7.btn === 'bump' && !p7.seeks.some(x => near(x, 45, 0.2)), '天官赐福第 7 集,旧包络:落点 45.0s 只亮按钮,不自动跳', { up: f7.ups[0], p7 });
    }
    // 解码失败的集:包络里的零洞不算对不上,定位要带上覆盖(同片头)
    {
        const d = BD.md16, env = F32(d.env), all = toChunks(d.head).filter(c => c.st < 300);
        const data = [...all.filter(c => c.st < 2 || c.st > 6), ...shift(J.C, 130)];
        const mkf = (dec) => { const fl = makeFlow({ c: data }, dec ? { onFetch: (sess) => { sess.decFail = 1; } } : {}); fl.A._st['T|S'] = { phase: 'learned', tries: 0, intro: { ...saved, benv: env, bdur: env.length / 10 }, outroTries: 0, mb: 0 }; return fl; };
        const f1 = mkf(true); await f1.run(23, 'c');
        ok(f1.ups[0] && f1.ups[0].bump && f1.ups[0].bump.bs === 0, '贴片中间有一段解码失败:带覆盖,还是中', f1.ups[0]);
        const f2 = mkf(false); await f2.run(23, 'c');
        ok(f2.ups[0] && f2.ups[0].oe > 0 && !f2.ups[0].bump, '(同样的洞,没记解码失败就当真的对不上)', f2.ups[0]);
    }
    // 学习对:写进去的是收回后的值,包络也是;没过判定的不写,控制台说一声
    {
        const x = BL.yn23, fl = makeFlow({ a: [...toChunks(x.A), ...shift(J.A, 30)], b: [...toChunks(x.B), ...shift(J.B, 30)] }), v = await fl.run(21, 'a', 22, 'b');
        const a = fl.ups.find(u => u.ep === 21), b = fl.ups.find(u => u.ep === 22), rec = JSON.parse(fl.localStorage.getItem('donggua_afpenv|T|S'));
        ok(a && a.bump && a.bump.bs === 0 && near(a.bump.be, 15.7, 0.25) && a.bmv === 3 && a.pend === 1, '学习对:贴片收回到 15.7s,带 bmv:3,待确认', a);
        ok(b && b.bump && near(b.bump.be, 15.7, 0.25) && b.bmv === 3, '学习对:另一集同样', b);
        ok(rec.bd && near(rec.bdur, 15.7, 0.25) && Math.abs(atob_len(rec.bd) - rec.bdur * 10) <= 1, '包络跟着收回', { bdur: rec.bdur });
        ok(rec.bdv === 3 && fl.A._st['T|S'].intro.bdv === 3 && fl.A._envParse(rec).bdv === 3, '学习对学出的贴片包络带 bdv:3(以后定位出来的才能自动跳)', { local: rec.bdv, st: fl.A._st['T|S'].intro.bdv });
        ok(fl.posts.some(q => q.u.indexOf('/api/intro/env') >= 0 && q.body && q.body.env && q.body.env.bd && q.body.env.bdv === 3), '学习对的云备份也带 bdv:3', fl.posts.map(q => q.body && q.body.env && { bdv: q.body.env.bdv, bd: !!q.body.env.bd }));
        const pc = playCheck(v._introCur);
        ok(pc.seeks.length === 0 && pc.btn === 'bump,op', '学习对:待确认,贴片也只亮按钮', pc);
    }
    {
        const x = BL.cf, fl = makeFlow({ a: [...toChunks(x.A), ...shift(J.A, 30)], b: [...toChunks(x.B), ...shift(J.B, 30)] }), v = await fl.run(21, 'a', 22, 'b');
        const a = fl.ups.find(u => u.ep === 21), rec = JSON.parse(fl.localStorage.getItem('donggua_afpenv|T|S'));
        ok(a && a.oe > 0 && !a.bump && !a.bmv && !rec.bd, '乘风2024 ikun 学习对:片头照常,假贴片不写、不存包络', { a, bd: !!rec.bd });
        ok(fl.conLog.some(s => /没过贴片判定,不写/.test(s)), '没过判定:控制台说一声(排查"这集为什么没有跳过开头")', fl.conLog.slice(-4));
        ok(v._introCur.bs === 0 && v._introCur.be === 0, '当前集也不亮贴片', v._introCur);
    }
    // 迁移:已确认标记里的旧贴片不再自动跳;集首之外的旧贴片按钮也不亮;不多分析
    {
        const cf = { os: 184.4, oe: 203, mv: 2, pid: 'pairabcd', bs: 109.8, be: 117.2, bmv: 2, ed: 99999 };
        let pc = playCheck(C.curOf(cf));
        ok(pc.seeks.length === 1 && pc.seeks[0] === 203 && pc.btn === '', '乘风2024 ikun 已确认的旧标记:只跳片头,109.8s 不跳也不亮按钮', pc);
        const yf = { os: 25.2, oe: 94.5, mv: 2, pid: 'pairabcd', bs: 0, be: 16.8, bmv: 2, ed: 99999 };
        pc = playCheck(C.curOf(yf));
        ok(pc.seeks.length === 1 && pc.seeks[0] === 94.5 && pc.btn === 'bump', '与凤行 已确认的旧标记:贴片在集首,只亮按钮;片头照跳', pc);
        pc = playCheck(C.curOf({ ...yf, bmv: 3 }));
        ok(pc.seeks.length === 2 && pc.seeks[0] === 16.8 && pc.btn === '', 'bmv:3 才自动跳', pc);
        pc = playCheck(C.curOf({ ...cf, bs: 30, be: 40 }));
        ok(pc.seeks.length === 1 && pc.btn === 'bump', '旧贴片起点 30s:亮按钮', pc);
        pc = playCheck(C.curOf({ ...cf, bs: 30.1, be: 40 }));
        ok(pc.seeks.length === 1 && pc.btn === '', '旧贴片起点 30.1s:不亮', pc);
        ok(C.bumpShow(null) === false && C.bumpShow({ bs: 0, be: 0 }) === false && C.bumpShow({ bs: 0, be: 3 }) === true, 'bumpShow:没贴片不亮');
        // 有值的 mv:2 旧标记不为贴片重算(不新增下载):整段不分析
        const fl = flowB([...toChunks(BD.cf0422.head), ...shift(J.C, 130)], { benv: F32(BD.cf0422.env), bdur: 7.4 }, { '23|r': { ...cf } });
        const v = await fl.run(23, 'c');
        ok(fl.fetchCalls.length === 0 && fl.ups.length === 0 && fl.marks['23|r'].bmv === 2 && fl.marks['23|r'].bs === 109.8, '有值的 mv:2 旧标记:不抓、不上报、不改(不为贴片重算)', { calls: fl.fetchCalls.length, ups: fl.ups });
    }
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
