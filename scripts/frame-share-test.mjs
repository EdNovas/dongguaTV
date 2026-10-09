#!/usr/bin/env node
// 截一帧分享(分享当前画面)回归 —— 离线、零网络、不需要 node_modules:node scripts/frame-share-test.mjs
//  ① public/index.html 里 <dg-frame-share-core> 那段纯函数:时间格式(与 DPlayer.min.js 的 secondToTime 逐值对拍)/ 链接拼法
//     (与改造前的 shareUrl 逐组合对拍 + URLSearchParams 往返)/ 集名 / 截图尺寸 / "用画面还是剧照"判定 / 卡片画面区比例 /
//     折行与超长片名截断(集名和时间保持完整)/ 文件名
//  ② drawCard 用假 canvas 记录绘制:标题行宽不超、剧照角标只在用剧照时画、二维码码元取整且留白 ≥ 3 格
//  ③ 二维码:用 vendored 的 public/libs/js/qrcode-generator.min.js 生成,再用本文件里【独立实现】的解码器
//     (读格式信息 BCH / 去掩码 / 之字形读码字 / 按 ISO 分块表解交织 / 逐块重算 Reed-Solomon 纠错码比对 / 解析 8bit 字节段)解回来 == 原链接
//  ④ Vue 方法(从 index.html 抽出,假 dp/画布/历史):shareFrame 的时间轴口径(卡片时间 = 进度条上的剪后时间,&t= = _cutToBase 的原时间轴秒数)、
//     分享统计渠道 'frame' + 码与链接一致 + 之后换码、画布被污染/全透明/没解码 → 换剧照并标明、直播/未登录预览不出卡片、
//     画在卡片上的二维码(从假 canvas 的 fillRect 还原)解码 == 弹窗里的链接、关闭时回收 blob 地址并退掉压的历史、返回键/Esc 关闭
//  ⑤ 静态:入口(分享面板按钮 / 齿轮菜单行 / 桌面相机图标)与直播/预览隐藏、二维码库按需加载不进首屏、sw.js 预缓存同一个 ?v=
//  ④b 第一轮审查回归:剧照只认完全同名(海贼王≠海贼王女)、弹窗 teleport 到 body(网页全屏/TV 模式下看得见)、TV 遥控 Esc/Backspace 与
//     App 返回键(MainActivity 注入的 JS)只关弹窗且恢复网页全屏、退历史落地时播放页已关 → 地址栏清成首页、空格/方向键不隔着弹窗动视频、
//     焦点进出弹窗、安卓 App / 内嵌网页的保存方式与提示、横屏矮屏布局
//  ④c 第二轮审查回归:剧照按文件头认真图(sw.js 取图失败回的「加载失败」SVG 不当剧照、不记住、换同源代理;Vercel 代理不带 Content-Type 也认)、
//     返回键/侧滑关弹窗后地址栏补写当前集、弹窗开着时刷新留下的历史(启动去标记 + 常驻 popstate 对齐地址栏)、弹窗框不吃全站焦点红框、
//     焦点陷阱(Tab/Shift+Tab 循环,焦点在弹窗外时回车/空格 keydown+keyup 都拦)
//  ④d 第四轮审查回归:TV 模式打开弹窗聚焦第一个能按的按钮(T1)、弹窗开着时换集/切线路不把焦点抢到被遮住的暂停按钮(T2)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 400) : '')); } };
const eq = (a, b, msg) => ok(a === b, msg, { got: a, want: b });

const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
const QR_LIB_PATH = path.join(ROOT, 'public/libs/js/qrcode-generator.min.js');
const qrcode = require(QR_LIB_PATH);

// ---------- 抽出纯函数核心 ----------
const coreM = /\/\/ <dg-frame-share-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-frame-share-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-frame-share-core> 段'); process.exit(1); }
const coreCtx = vm.createContext({ Math, String, Array, Object, Number, encodeURIComponent, Infinity, NaN, Set, Map });
vm.runInContext(coreM[1] + '\n;globalThis.__C = DgFrameShare;', coreCtx);
const C = coreCtx.__C;
// 追更日历的纯函数核心(_frameBackdrop 用它的 pickArt 认剧照,与认片同一套"完全同名")
const schedM = /\/\/ <dg-fav-sched-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-fav-sched-core>/.exec(HTML);
const FS = schedM ? new Function(schedM[1] + '\n;return DgFavSched;')() : null;

// 假的文字宽度:中日韩 = 1em,其余 0.55em(与 canvas 真实测量同一量级,用来验折行逻辑)
const pxOf = font => { const m = /(\d+)px/.exec(font || ''); return m ? +m[1] : 10; };
const widthOf = (font, t) => Array.from(String(t)).reduce((a, ch) => a + (ch.codePointAt(0) >= 0x2E80 ? 1 : 0.55) * pxOf(font), 0);

console.log('① 纯函数');
{
    // timeLabel 与 DPlayer 的 secondToTime 逐值对拍(进度条上显示的就是它)
    const dpSrc = fs.readFileSync(path.join(ROOT, 'public/libs/js/DPlayer.min.js'), 'utf8');
    const m = /secondToTime:(function\(e\)\{[^]*?join\(":"\)\})/.exec(dpSrc);
    ok(!!m, 'DPlayer.min.js 里找到 secondToTime');
    if (m) {
        const dpFmt = vm.runInNewContext('(' + m[1] + ')', { Math, Infinity });
        const vals = [0, 0.4, 1, 5.9, 59.99, 60, 61, 599, 754.2, 3599.9, 3600, 3661, 3723.5, 7322, 36000, 86399, NaN, Infinity, undefined];
        for (const v of vals) eq(C.timeLabel(v), dpFmt(v), 'timeLabel(' + v + ') 与 DPlayer 一致');
    }
    eq(C.timeLabel(754.2), '12:34', '12:34');
    eq(C.timeLabel(3723), '01:02:03', '超过 1 小时 hh:mm:ss');

    // 链接:与改造前的 shareUrl 逐组合对拍(原代码照抄在这里当参照)
    const oldShareUrl = (s) => {
        if (!s.currentGroup || !s.currentGroup.name) return s.origin + '/';
        const sc = (s.watchStatsEnabled && s.shareCode) ? '&s=' + s.shareCode : '';
        if (s.currentGroup._isLive) return s.origin + '/?live=' + encodeURIComponent(s.currentGroup.name) + sc;
        let u = s.origin + '/?play=' + encodeURIComponent(s.currentGroup.name);
        const cur = (s.episodeList && s.episodeList.length > 1) ? s.episodeList.find(e => e.url === s.currentUrl) : null;
        if (cur && cur.name) u += '&ep=' + encodeURIComponent(cur.name);
        if (s.currentGroup._workLabel && s.currentGroup._workSig) u += '&w=' + encodeURIComponent(s.currentGroup._workSig);
        if (s.shareIncludeTime && s.shareSeconds > 0) u += '&t=' + s.shareSeconds;
        return u + sc;
    };
    const parts = mkMethod('_shareLinkParts'), shareUrlFn = mkMethod('shareUrl');
    const groups = [null, { name: '' }, { name: '繁花' }, { name: '繁花', _workLabel: '2023', _workSig: 'y2023t' }, { name: 'CCTV-5 体育', _isLive: true }, { name: '我的 & 你的?#' }];
    const eps = [[], [{ name: '正片', url: 'a' }], [{ name: '第01集', url: 'a' }, { name: '第02集', url: 'b' }]];
    let combos = 0, same = 0;
    for (const g of groups) for (const el of eps) for (const cu of ['a', 'b', 'zz']) for (const inc of [false, true]) for (const secs of [0, 754]) for (const st of [false, true]) for (const code of ['', 'AbCdEf1234']) {
        const s = { origin: 'https://ednovas.video', currentGroup: g, episodeList: el, currentUrl: cu, shareIncludeTime: inc, shareSeconds: secs, watchStatsEnabled: st, shareCode: code };
        s._shareLinkParts = (t) => parts.call(s, t);
        combos++;
        if (shareUrlFn.call(s) === oldShareUrl(s)) same++;
    }
    eq(same, combos, 'shareUrl(改走 DgFrameShare.link)与改造前逐组合一致(' + combos + ' 组)');

    const L = C.link({ origin: 'https://ednovas.video', name: '繁花', ep: '第02集', t: 784.9, code: 'AbCdEf1234' });
    eq(L, 'https://ednovas.video/?play=%E7%B9%81%E8%8A%B1&ep=%E7%AC%AC02%E9%9B%86&t=784&s=AbCdEf1234', 'link 拼法(t 取整)');
    const q = new URL(L).searchParams;
    ok(q.get('play') === '繁花' && q.get('ep') === '第02集' && parseInt(q.get('t'), 10) === 784 && q.get('s') === 'AbCdEf1234', 'URLSearchParams 往返(深链按 parseInt(t) 读)');
    eq(C.link({ origin: 'https://x', name: 'a&b=c', work: 'w|1' }), 'https://x/?play=a%26b%3Dc&w=w%7C1', '特殊字符编码、t=0 不带');
    eq(C.link({ origin: 'https://x', name: 'CCTV', live: true, ep: 'x', t: 5, code: 'Q' }), 'https://x/?live=CCTV&s=Q', '直播只带 live + s');
    eq(C.link({ origin: 'https://x', name: '' }), 'https://x/', '没片名 → 首页');

    eq(C.epLabel('01', true), '第01集', '纯数字集名补成 第N集');
    eq(C.epLabel('第3集', true), '第3集', '集名照选集列表显示');
    eq(C.epLabel('20260703期 上', true), '20260703期 上', '综艺集名原样');
    eq(C.epLabel('正片', false), '', '只有一集不写集名');
    eq(C.epLabel('', true), '', '找不到当前集不写');
    eq(C.tail('第01集', '12:34'), ' · 第01集 · 12:34', 'tail');
    eq(C.tail('', '12:34'), ' · 12:34', 'tail 无集名');

    const cs = (a, b) => JSON.stringify(C.captureSize(a, b, 1280));
    eq(cs(3840, 2160), '{"w":1280,"h":720}', '4K 缩到长边 1280');
    eq(cs(1280, 720), '{"w":1280,"h":720}', '720p 原样');
    eq(cs(720, 1280), '{"w":720,"h":1280}', '竖屏 720×1280 原样');
    eq(cs(1080, 1920), '{"w":720,"h":1280}', '竖屏 1080×1920 → 720×1280');
    eq(cs(640, 360), '{"w":640,"h":360}', '小片源不放大');
    eq(cs(0, 0), '{"w":0,"h":0}', '没尺寸 → 0');

    const fd = r => { const d = C.frameDecision(r); return d.use + ':' + d.why; };
    eq(fd({ w: 1280, h: 720, readyState: 4 }), 'frame:', '正常 → 用画面');
    eq(fd({ w: 1280, h: 720, readyState: 4, tainted: true }), 'poster:tainted', '画布被污染 → 剧照');
    eq(fd({ w: 1280, h: 720, readyState: 4, blank: true }), 'poster:blank', '画出来全透明 → 剧照');
    eq(fd({ w: 1280, h: 720, readyState: 1 }), 'poster:notready', '还没解码出画面 → 剧照');
    eq(fd({ w: 0, h: 0, readyState: 4 }), 'poster:notready', '没尺寸 → 剧照');
    eq(fd({ w: 1280, h: 720, readyState: 4, error: true }), 'poster:error', '其它异常 → 剧照');
    eq(fd({}), 'poster:notready', '空 → 剧照');
    ok(C.posterNote('tainted', true).includes('剧照') && C.posterNote('tainted', false).includes('片名'), 'posterNote 区分有没有剧照');

    eq(C.imageBox(1080, 1920, 1080), 608, '16:9 画面区高 608');
    eq(C.imageBox(1080, 1080, 1920), 1350, '竖屏夹到 4:5');
    eq(C.imageBox(1080, 2390, 1000), 463, '超宽银幕夹到 21:9');
    eq(C.imageBox(1080, 0, 0), 608, '没图按 16:9');
    const cr = C.coverRect(1920, 1080, 1080, 1350);
    ok(Math.abs(cr.sh - 1080) < 1e-9 && Math.abs(cr.sw - 864) < 1e-9 && Math.abs(cr.sx - 528) < 1e-9 && cr.sy === 0, 'coverRect 居中裁切', cr);

    // 折行与截断
    const F46 = 'bold 46px x', meas = t => widthOf(F46, t), MAXW = 668;
    const fits = ls => ls.every(l => meas(l) <= MAXW + 1e-9);
    const noEdgeSpace = ls => ls.every(l => l === l.trim());
    let ls = C.layoutTitle(meas, '繁花', C.tail('第01集', '12:34'), MAXW, 2);
    ok(ls.length === 1 && ls[0] === '繁花 · 第01集 · 12:34', '短标题一行', ls);
    const longName = '这是一个非常非常长的电视剧名字用来测试卡片标题会不会被正确截断并且保留集数和时间点';
    ls = C.layoutTitle(meas, longName, C.tail('第128集', '1:02:03'), MAXW, 2);
    ok(ls.length === 2 && fits(ls) && ls.join('').includes('…') && ls.join('').replace(/\s/g, '').endsWith('…·第128集·1:02:03'), '超长片名:两行、截片名加 …、集名和时间完整', ls);
    ok(ls.join('').startsWith('这是一个非常'), '截断保留片名开头', ls);
    ls = C.layoutTitle(meas, '繁花', C.tail('第01集超级超级超级超级超级超级超级超级超级超级长的综艺集名再长一点再长一点', '12:34'), MAXW, 2);
    ok(ls.length === 2 && fits(ls) && ls[1].endsWith('…'), '集名本身超长 → 整串截断加 …', ls);
    const eng = 'The Lord of the Rings The Return of the King Extended Edition';
    ls = C.layoutTitle(meas, eng, C.tail('', '02:03:04'), MAXW, 2);
    ok(ls.length <= 2 && fits(ls) && noEdgeSpace(ls), '西文标题折行不超宽、行首行尾没空格', ls);
    const wr = C.wrap(meas, 'Breaking Bad Season Five Episode Fourteen Ozymandias', 400);
    ok(wr.length > 1 && wr.every(l => meas(l) <= 400), 'wrap 每行不超宽', wr);
    ok(wr.join(' ') === 'Breaking Bad Season Five Episode Fourteen Ozymandias' && noEdgeSpace(wr), '西文按空格折、单词不从中间断', wr);
    ok(C.wrap(meas, '   ', 100).length === 0, '全空白 → 0 行');
    eq(C.ellipsize(t => t.length * 10, 'abcdef', 100), 'abcdef', 'ellipsize 放得下原样');
    eq(C.ellipsize(t => t.length * 10, 'abcdefghijklmn', 60), 'abcde…', 'ellipsize 截断加 …');

    // 「保存图片」按设备分档(第一轮审查回归:安卓 App 的 WebView 丢掉 <a download>、也没有长按存图菜单)
    const UA_WV = 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36';
    const UA_WX = UA_WV + ' XWEB/1160065 MMWEBSDK/20231202 MicroMessenger/8.0.47.2560(0x28002F30)';
    const UA_CH = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
    eq(C.saveMode(UA_CH, false), 'download', '普通浏览器 → 下载');
    eq(C.saveMode(UA_WX, false), 'press', '微信(安卓微信 UA 也带 ; wv))→ 长按');
    eq(C.saveMode('Mozilla/5.0 (iPhone) QQ/9.0', false), 'press', 'QQ → 长按');
    eq(C.saveMode(UA_WV, true), 'app', '自家安卓 App(Capacitor)→ 提示截屏');
    eq(C.saveMode(UA_WV, false), 'webview', '别的安卓内嵌网页(; wv))→ 照样试下载、同时提示长按/截屏');
    ok(/长按/.test(C.saveTip('press')) && /截屏/.test(C.saveTip('app')) && !/长按/.test(C.saveTip('app')) && /截屏/.test(C.saveTip('webview')) && /长按/.test(C.saveTip('download')), 'saveTip:App 里不说"长按"(WebView 没有长按存图菜单),说截屏');

    eq(C.fileName('繁花', '第01集', '12:34'), '繁花_第01集_12-34.jpg', '文件名');
    eq(C.fileName('a/b:c*?"<>|', '', '01:02:03'), 'a_b_c_01-02-03.jpg', '文件名去非法字符');
    eq(C.fileName('', '', ''), 'frame.jpg', '空文件名兜底');
}

// ---------- 假 canvas(记录绘制) ----------
function fakeCanvas(opt) {
    opt = opt || {};
    const cv = { width: 300, height: 150, ops: [] };
    const ctx = {
        font: '10px sans-serif', fillStyle: '#000', textAlign: 'start', textBaseline: 'alphabetic',
        measureText(t) { return { width: widthOf(this.font, t) }; },
        fillText(t, x, y) { cv.ops.push({ op: 'text', t: String(t), x, y, font: this.font, fill: this.fillStyle, align: this.textAlign }); },
        fillRect(x, y, w, h) { cv.ops.push({ op: 'rect', x, y, w, h, fill: this.fillStyle }); },
        drawImage(...a) { cv.ops.push({ op: 'img', a }); },
        createLinearGradient() { return { addColorStop() { } }; },
        beginPath() { }, moveTo() { }, arcTo() { }, closePath() { }, save() { }, restore() { }, clip() { },
        fill() { cv.ops.push({ op: 'fill', fill: this.fillStyle }); },
        getImageData(x, y, w, h) {
            if (opt.taint) { const e = new Error('The canvas has been tainted by cross-origin data.'); e.name = 'SecurityError'; throw e; }
            return { data: new Uint8ClampedArray(w * h * 4).fill(opt.blank ? 0 : 180) };
        }
    };
    cv.getContext = () => ctx;
    cv.toBlob = (cb, type, q) => cb({ size: opt.blobSize ? opt.blobSize(q) : 200000, type, q });
    return cv;
}
// 从假 canvas 的 fillRect 记录还原二维码矩阵(只看二维码白底框里的黑块)
function qrFromOps(cv, box, cell, n) {
    const [qx, qy, QR] = box;
    const rects = cv.ops.filter(o => o.op === 'rect' && o.fill === '#000' && o.x >= qx && o.y >= qy && o.x < qx + QR && o.y < qy + QR);
    if (!rects.length) return null;
    const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
    const M = Array.from({ length: n }, () => new Array(n).fill(false));
    for (const r of rects) {
        if (r.w !== cell || r.h !== cell) return null;
        M[(r.y - y0) / cell][(r.x - x0) / cell] = true;
    }
    return M;
}

console.log('② drawCard');
{
    const link = 'https://ednovas.video/?play=%E7%B9%81%E8%8A%B1&ep=%E7%AC%AC02%E9%9B%86&t=784&s=AbCdEf1234';
    const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
    const base = { W: 1080, name: '繁花', tail: C.tail('第02集', '12:34'), sub: '扫码从这一秒开始看', brand: 'E视界', host: 'ednovas.video', qr: { count: qr.getModuleCount(), isDark: (r, c) => qr.isDark(r, c) }, icon: { w: 1 } };
    const cv = fakeCanvas();
    const r = C.drawCard(cv, { ...base, img: { src: { frame: 1 }, sw: 1280, sh: 720 }, poster: false });
    eq(cv.width, 1080, '卡片宽 1080');
    ok(r.H === cv.height && r.H > r.imgH && r.imgH === 608, '高度 = 画面区 + 文字区', r);
    const texts = cv.ops.filter(o => o.op === 'text').map(o => o.t);
    ok(texts.includes('繁花 · 第02集 · 12:34'), '标题「剧名 · 第N集 · 12:34」', texts);
    ok(texts.includes('扫码从这一秒开始看') && texts.includes('E视界') && texts.includes('ednovas.video'), '提示语 / 站点名 / 域名', texts);
    ok(!texts.some(t => t.includes('剧照')), '用画面时没有剧照角标');
    const img = cv.ops.find(o => o.op === 'img');
    ok(img && img.a[0].frame === 1 && img.a.length === 9 && img.a[7] === 1080 && img.a[8] === 608, '画面按 cover 画满画面区', img && img.a.slice(1));
    ok(r.qrCell >= 3 && Number.isInteger(r.qrCell), '码元整数像素且 ≥ 3px(' + r.qrCell + ')');
    const n = qr.getModuleCount(), off = Math.round((r.qrBox[2] - r.qrCell * n) / 2);
    ok(off >= 3 * r.qrCell, '二维码四周留白 ≥ 3 个码元');
    ok(r.qrBox[0] + r.qrBox[2] <= 1080 && r.qrBox[1] + r.qrBox[2] <= r.H, '二维码在卡片内');
    const M = qrFromOps(cv, r.qrBox, r.qrCell, n);
    const dec = M ? decodeQR(M) : { error: 'no matrix' };
    eq(dec.text, link, '画在卡片上的二维码解码 == 链接');
    // 标题行宽
    const tl = cv.ops.filter(o => o.op === 'text' && /bold 46px/.test(o.font));
    ok(tl.length >= 1 && tl.every(o => widthOf(o.font, o.t) <= 1080 - 56 * 2 - 264 - 40), '标题每行不超过文字区宽');

    const cv2 = fakeCanvas();
    C.drawCard(cv2, { ...base, name: '一部名字特别特别特别特别特别特别特别特别长的电视剧第二季', img: { src: { art: 1 }, sw: 780, sh: 439 }, poster: true });
    const t2 = cv2.ops.filter(o => o.op === 'text').map(o => o.t);
    ok(t2.includes('剧照 · 非当前画面'), '用剧照时画角标「剧照 · 非当前画面」', t2);
    const tl2 = cv2.ops.filter(o => o.op === 'text' && /bold 46px/.test(o.font)).map(o => o.t);
    ok(tl2.length === 2 && tl2.join('').includes('…') && tl2[1].endsWith('12:34'), '超长片名两行截断、时间在末尾', tl2);

    const cv3 = fakeCanvas();
    C.drawCard(cv3, { ...base, img: null, poster: false });
    ok(!cv3.ops.some(o => o.op === 'img' && o.a[0] && o.a[0].frame), '连剧照都没有 → 不画图');
    ok(cv3.ops.some(o => o.op === 'text' && o.t === '繁花' && o.align === 'center'), '没图时画面区居中大字片名');
    const cv4 = fakeCanvas();
    C.drawCard(cv4, { ...base, host: 'a-very-very-very-long-subdomain.of.some-really-long-domain-name.example.com' });
    const hostT = cv4.ops.find(o => o.op === 'text' && /24px/.test(o.font));
    ok(hostT && hostT.t.endsWith('…') && hostT.x + widthOf(hostT.font, hostT.t) <= 56 + (1080 - 56 * 2 - 264 - 40) + 1e-6, '超长域名截断,不压到二维码', hostT);
}

console.log('③ 二维码:vendored 库生成 → 独立解码器解回原文');
{
    const head = fs.readFileSync(QR_LIB_PATH, 'utf8').slice(0, 1500);
    ok(/MIT/.test(head) && /Kazuhiko Arase/.test(head) && /qrcode-generator 2\.0\.4/.test(head), 'vendored 库带版本与 MIT 许可头');
    ok(typeof qrcode === 'function', 'qrcode 库可加载');
    const samples = [
        'https://ednovas.video/',
        'https://ednovas.video/?play=%E7%B9%81%E8%8A%B1&t=754',
        'https://ednovas.video/?play=%E7%B9%81%E8%8A%B1&ep=%E7%AC%AC02%E9%9B%86&t=784&s=AbCdEf1234',
        C.link({ origin: 'https://video.example-domain.com', name: '名侦探柯南：绯色的子弹', ep: '第1集', work: 'y2021m', t: 3723, code: 'Zz09Yy18Xx' }),
        C.link({ origin: 'http://192.168.1.10:3000', name: '这是一个非常非常长的电视剧名字用来测试二维码版本会变大', ep: '20260703期 上 纯享版', t: 59, code: 'AAAAAAAAAA' }),
        C.link({ origin: 'https://ednovas.video', name: '一'.repeat(60), ep: '第100集', t: 86399, code: 'abcdefghij' }),
    ];
    const versions = new Set();
    for (const s of samples) {
        const q = qrcode(0, 'M'); q.addData(s); q.make();
        const n = q.getModuleCount();
        const M = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
        const d = decodeQR(M);
        versions.add(d.version);
        ok(!d.error, '解码无错误(' + s.length + ' 字节):' + (d.error || ''));
        eq(d.ec, 'M', '纠错等级 M');
        ok(d.rsOk, 'Reed-Solomon 纠错码逐块重算一致(v' + d.version + ')');
        ok(d.formatBoth, '两份格式信息一致');
        eq(d.text, s, '解码 == 原链接(v' + d.version + ')');
    }
    ok(versions.size >= 4, '覆盖多个版本(' + [...versions].sort((a, b) => a - b).join(',') + ')');
}

// ---------- 独立的二维码解码器(只认 8bit 字节段;库生成的码没有错误,所以纠错码只做"重算比对"不做纠错) ----------
function decodeQR(M) {
    const n = M.length, v = (n - 17) / 4;
    if (!Number.isInteger(v) || v < 1 || v > 40) return { error: 'bad size ' + n };
    // 格式信息:15 bit = BCH(5bit 数据, 生成多项式 0x537) ^ 0x5412;数据 = 纠错等级(2bit) << 3 | 掩码(3bit)
    const fmtWord = d => { let r = d << 10; for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0x537 << (i - 10); return ((d << 10) | r) ^ 0x5412; };
    const bitAt = (r, c) => (M[r][c] ? 1 : 0);
    // 第一份(左上):bit14..9 在 (8,0..5),bit8 (8,7),bit7 (8,8),bit6 (7,8),bit5..0 在 (5..0,8)
    let f1 = 0;
    const p1 = [];
    for (let c = 0; c <= 5; c++) p1.push([8, c]);
    p1.push([8, 7], [8, 8], [7, 8]);
    for (let r = 5; r >= 0; r--) p1.push([r, 8]);
    for (const [r, c] of p1) f1 = (f1 << 1) | bitAt(r, c);
    // 第二份:bit14..8 在 (n-1..n-7, 8),bit7..0 在 (8, n-8..n-1)
    let f2 = 0;
    for (let r = n - 1; r >= n - 7; r--) f2 = (f2 << 1) | bitAt(r, 8);
    for (let c = n - 8; c <= n - 1; c++) f2 = (f2 << 1) | bitAt(8, c);
    let data = -1;
    for (let d = 0; d < 32; d++) if (fmtWord(d) === f1) data = d;
    if (data < 0) return { error: 'format info' };
    const ec = ['M', 'L', 'H', 'Q'][data >> 3], mask = data & 7;
    // 功能图形:三个定位角(含分隔符与格式区)、两条定时线、校正图形、版本信息
    const fn = Array.from({ length: n }, () => new Array(n).fill(false));
    const mark = (r0, c0, h, w) => { for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < n && c < n) fn[r][c] = true; };
    mark(0, 0, 9, 9); mark(0, n - 8, 9, 8); mark(n - 8, 0, 8, 9);
    mark(6, 0, 1, n); mark(0, 6, n, 1);
    if (v >= 2) {
        const num = Math.floor(v / 7) + 2, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (num * 2 - 2)) * 2;
        const pos = [6];
        for (let p = n - 7; pos.length < num; p -= step) pos.splice(1, 0, p);
        for (let i = 0; i < num; i++) for (let j = 0; j < num; j++) {
            if ((i === 0 && j === 0) || (i === 0 && j === num - 1) || (i === num - 1 && j === 0)) continue;
            mark(pos[i] - 2, pos[j] - 2, 5, 5);
        }
    }
    if (v >= 7) { mark(0, n - 11, 6, 3); mark(n - 11, 0, 3, 6); }
    // 原始数据模块数(ISO 公式)与功能图形之外的模块数必须一致
    let raw = (16 * v + 128) * v + 64;
    if (v >= 2) { const na = Math.floor(v / 7) + 2; raw -= (25 * na - 10) * na - 55; if (v >= 7) raw -= 36; }
    let free = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!fn[r][c]) free++;
    if (free !== raw) return { error: 'function pattern mismatch ' + free + ' vs ' + raw };
    const maskFn = [
        (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
        (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
        (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0, (i, j) => ((i + j) % 2 + (i * j) % 3) % 2 === 0
    ][mask];
    // 之字形读:从右下角起,两列一组,上下交替,跳过第 6 列(竖定时线)
    const bits = [];
    let up = true;
    for (let right = n - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let k = 0; k < n; k++) {
            const r = up ? n - 1 - k : k;
            for (const c of [right, right - 1]) if (!fn[r][c]) bits.push((M[r][c] ? 1 : 0) ^ (maskFn(r, c) ? 1 : 0));
        }
        up = !up;
    }
    const total = Math.floor(raw / 8), words = [];
    for (let i = 0; i < total; i++) { let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k]; words.push(b); }
    // ISO 18004 表:每块纠错码字数 / 块数(L, M, Q, H)
    const ECC = {
        L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
        Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
        H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
    };
    const BLK = {
        L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
        M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
        Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
        H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
    };
    const ecc = ECC[ec][v], nb = BLK[ec][v];
    const nShort = nb - (total % nb), shortLen = Math.floor(total / nb);
    const dataLens = Array.from({ length: nb }, (_, j) => shortLen - ecc + (j >= nShort ? 1 : 0));
    const blocks = dataLens.map(() => ({ d: [], e: [] }));
    let p = 0;
    for (let i = 0; i < shortLen - ecc + 1; i++) for (let j = 0; j < nb; j++) if (i < dataLens[j]) blocks[j].d.push(words[p++]);
    for (let i = 0; i < ecc; i++) for (let j = 0; j < nb; j++) blocks[j].e.push(words[p++]);
    if (p !== total) return { error: 'deinterleave' };
    // GF(256)(本原多项式 0x11D)上重算 Reed-Solomon 纠错码
    const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; };
    const divisor = (deg) => {
        const res = new Array(deg - 1).fill(0); res.push(1);
        let root = 1;
        for (let i = 0; i < deg; i++) {
            for (let j = 0; j < res.length; j++) { res[j] = mul(res[j], root); if (j + 1 < res.length) res[j] ^= res[j + 1]; }
            root = mul(root, 0x02);
        }
        return res;
    };
    const div = divisor(ecc);
    let rsOk = true;
    for (const b of blocks) {
        const rem = div.map(() => 0);
        for (const x of b.d) { const f = x ^ rem.shift(); rem.push(0); div.forEach((co, i) => { rem[i] ^= mul(co, f); }); }
        if (rem.some((x, i) => x !== b.e[i])) rsOk = false;
    }
    // 数据位流:模式 0100(8bit 字节)+ 字数(v1-9 为 8 位,之后 16 位)+ 字节;0000 结束
    const dbits = [];
    for (const b of blocks) for (const x of b.d) for (let k = 7; k >= 0; k--) dbits.push((x >> k) & 1);
    let i = 0;
    const read = (k) => { let x = 0; for (let t = 0; t < k; t++) x = (x << 1) | (dbits[i++] || 0); return x; };
    const bytes = [];
    while (i + 4 <= dbits.length) {
        const mode = read(4);
        if (mode === 0) break;
        if (mode !== 4) return { error: 'unexpected mode ' + mode };
        const cnt = read(v < 10 ? 8 : 16);
        for (let k = 0; k < cnt; k++) bytes.push(read(8));
    }
    return { version: v, ec, mask, rsOk, formatBoth: f1 === f2, text: Buffer.from(bytes).toString('utf8') };
}

// ---------- ④ Vue 方法 ----------
// 抽方法:从 "\n" + 16 空格 + "name(" 起数大括号到配平(跳过字符串里的括号)
function methodSrc(name) {
    const re = new RegExp('\\n {16}(async )?' + name + '\\(([^)]*)\\) \\{');
    const m = re.exec(HTML);
    if (!m) throw new Error('method not found: ' + name);
    let i = m.index + m[0].length, depth = 1, q = null;
    for (; i < HTML.length && depth > 0; i++) {
        const c = HTML[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
        if (c === '{') depth++; else if (c === '}') depth--;
    }
    return { async: !!m[1], args: m[2], body: HTML.slice(m.index + m[0].length, i - 1) };
}
function mkMethod(name, ctx) {
    const m = methodSrc(name);
    const code = '(' + (m.async ? 'async ' : '') + 'function (' + m.args + ') {' + m.body + '})';
    return ctx ? vm.runInContext(code, ctx) : vm.runInNewContext(code, { location: { origin: 'https://ednovas.video' }, DgFrameShare: C, encodeURIComponent });
}

const REAL = ['shareFrame', '_frameCapture', '_shareTrack', '_shareCanTrack', '_shareNewCode', '_shareRotate', '_shareLinkParts', '_frameShareFree', 'closeFrameShare',
    '_frameShareHistPush', '_frameShareHistPop', 'frameShareSave', 'frameShareCopy', 'frameShareNative', 'copyShareLink', '_frameEncode', '_frameBackdrop', '_frameLoadImg', '_loadQrLib', '_frameIcon',
    '_frameFetchArt', '_frameShareInBox', '_frameShareFocusables', '_onHistPop', '_histBoot', '_pushAskScrollBack', '_frameShareFocusIn'];
// 剧照图片的字节:真 JPEG 文件头 / sw.js 取图失败时回的「加载失败」SVG 占位(200,image/svg+xml)
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const SW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect fill="#333" width="300" height="450"/><text fill="#666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="16">加载失败</text></svg>';
const tick = () => new Promise(r => setTimeout(r, 0));

function makeApp(o) {
    o = o || {};
    const S = { posts: [], toasts: [], revoked: [], created: 0, canvases: [], drawn: [], backdropCalls: [], pushes: 0, backs: 0, listeners: {}, synced: 0, shares: [], images: [], scripts: [], replaced: [], toggled: 0, focused: [], imgFetches: [] };
    const fsState = { browser: !!o.fullscreen, web: !!o.webfs };
    const hist = { entries: [{ state: null }], idx: 0 };
    const win = {
        addEventListener(t, f, cap) { (S.listeners[t] = S.listeners[t] || []).push(f); },
        removeEventListener(t, f) { S.listeners[t] = (S.listeners[t] || []).filter(x => x !== f); },
        qrcode: o.noQrGlobal ? undefined : qrcode
    };
    const fire = (t, ev) => (S.listeners[t] || []).slice().forEach(f => f(ev || {}));
    let rnd = 1;
    const core = { ...C, drawCard: (cv, opts) => { const r = C.drawCard(cv, opts); S.drawn.push({ cv, opts, r }); return r; } };
    const g = {
        DgFrameShare: core, DgFavSched: FS, console: { log() { }, warn() { }, error() { } }, Math, Number, String, Object, Array, JSON, Date, Map, Set, Promise, Error, TypeError,
        Uint8Array, Uint8ClampedArray, encodeURIComponent, decodeURIComponent, isFinite, parseInt, setTimeout, clearTimeout, AbortController, Infinity, NaN,
        dp: o.noDp ? null : {
            video: Object.assign({ currentTime: 754.4, videoWidth: 1920, videoHeight: 1080, readyState: 4, paused: false }, o.video || {}),
            fullScreen: { isFullScreen: (k) => !!fsState[k], cancel: (k) => { S.fsCancel = k; fsState[k] = false; }, request: (k) => { S.fsRequest = k; fsState[k] = true; } },
            toggle() { S.toggled++; }, notice() { }, pause() { }
        },
        safeSeekBy: () => { S.seeked = true; },
        location: { origin: 'https://ednovas.video', host: 'ednovas.video', pathname: '/', search: o.search || '' },
        history: {
            get state() { return hist.entries[hist.idx].state; },
            pushState(s) { hist.entries = hist.entries.slice(0, hist.idx + 1); hist.entries.push({ state: s }); hist.idx++; S.pushes++; },
            back() { S.backs++; if (hist.idx > 0) { hist.idx--; setTimeout(() => fire('popstate', { state: hist.entries[hist.idx].state }), 0); } },
            replaceState(s, t, u) { S.replaced.push(u); hist.entries[hist.idx] = { state: s }; }
        },
        window: win,
        document: {
            createElement(tag) {
                if (tag === 'canvas') { const cv = fakeCanvas(o.canvas); S.canvases.push(cv); return cv; }
                if (tag === 'a') { const a = { click() { S.clicked = { href: a.href, download: a.download }; }, remove() { } }; return a; }
                if (tag === 'script') { const s = {}; S.scripts.push(s); return s; }
                return {};
            },
            body: { appendChild() { } },
            head: { appendChild(s) { setTimeout(() => { if (o.qrLoadFails) s.onerror && s.onerror(); else { win.qrcode = qrcode; s.onload && s.onload(); } }, 0); } },
            activeElement: o.active || null,   // 可写:焦点陷阱用例里由假按钮的 focus() 改它
            getElementById: () => null,
            contains: () => true
        },
        navigator: Object.assign({ userAgent: 'Mozilla/5.0 Chrome' }, o.nav || {}),
        URL: { createObjectURL: (b) => (b && b._from ? 'blob:' + b._from : 'blob:card-' + (++S.created)), revokeObjectURL: (u) => S.revoked.push(u) },
        File: function (parts, name, opt) { this.parts = parts; this.name = name; this.type = opt && opt.type; },
        FileReader: function () { this.readAsDataURL = (b) => { this.result = 'data:image/jpeg;base64,' + (b && b.size); setTimeout(() => this.onload && this.onload(), 0); }; },
        Image: function () { const im = this; S.images.push(im); Object.defineProperty(im, 'src', { set(v) { im._src = v; setTimeout(() => { const okLoad = o.imgOk ? o.imgOk(v, im) : true; if (okLoad) { im.naturalWidth = 780; im.naturalHeight = 439; im.onload && im.onload(); } else im.onerror && im.onerror(); }, 0); }, get() { return im._src; } }); },
        fetch: (url, opt) => {
            url = String(url);
            if (/\/t\/p\/|\/api\/tmdb-image\//.test(url)) {   // 剧照图片:o.imgFetch(url) → { status, bytes, type } | 'neterr';默认真 JPEG
                S.imgFetches.push(url);
                const r = o.imgFetch ? o.imgFetch(url) : { status: 200, bytes: JPEG, type: 'image/jpeg' };
                if (r === 'neterr') return Promise.reject(new TypeError('Failed to fetch'));
                const b = new Blob([r.bytes]); b._from = url;
                return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => (/content-type/i.test(k) ? r.type || null : null) }, blob: async () => b });
            }
            S.posts.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null }); return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
        },
        Blob, Response,
        tmdbFetch: (url, opt) => { S.tmdb = (S.tmdb || []).concat(String(url)); return Promise.resolve({ json: async () => (o.tmdb || { results: [] }) }); },
        TMDB_BACKDROP_URL: '/api/tmdb-image/original',
        localStorage: { getItem: (k) => (k === 'emax_auth_hash' && !o.noToken ? 'tok_abc' : null) },
        crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (rnd = (rnd * 1103515245 + 12345) >>> 0) & 0xFF; return a; } },
    };
    const ctx = vm.createContext(g);
    const app = {
        currentGroup: o.group !== undefined ? o.group : { name: '繁花' },
        episodeList: o.episodes || [{ name: '第01集', url: 'u1' }, { name: '第02集', url: 'u2' }],
        currentUrl: 'u2', watchStatsEnabled: o.stats !== false, shareCode: 'PanelCode1', shareIncludeTime: false, shareSeconds: 0,
        showSharePanel: true, previewLocked: !!o.preview, _liveActive: !!o.liveActive, showDetail: true, isNativeApp: !!o.native, isTVMode: !!o.tv, searched: false,
        TMDB_BACKDROP_URL: o.tmdbBase || 'https://image.tmdb.org/t/p/original',
        $nextTick: (f) => { f && f(); }, $refs: { fshareBox: null },
        frameShare: { show: false, busy: false, img: '', note: '', link: '', title: '', canFiles: false, err: '', tip: '' },
        showMiniToast: (m) => S.toasts.push(m),
        syncShareUrl: () => { S.synced++; },
        _cutToBase: (t) => t + 30,   // 片头前剪掉了 30 秒插播:进度条 12:34 = 原时间轴 13:04
    };
    // 弹窗框 + 里面的按钮(假 DOM):focus() 改 document.activeElement;contains 认自己和这些按钮
    const btn = (name) => ({ name, offsetParent: {}, focus(opt) { g.document.activeElement = this; S.focused.push([name, opt]); } });
    const btns = o.btns || [btn('关闭'), btn('保存图片'), btn('复制链接')];
    // .fshare-btns 里第一个没禁用的按钮:与模板同口径 —— 保存图片 :disabled="!frameShare.img"、复制链接 :disabled="!frameShare.link"(o.noCopy:复制链接也灰着)
    const actDisabled = (b) => b.name === '保存图片' ? !app.frameShare.img : b.name === '复制链接' ? (!!o.noCopy || !app.frameShare.link) : true;
    const box = {
        name: 'box', focus(opt) { g.document.activeElement = box; S.focused.push(['box', opt]); }, contains: (el) => el === box || btns.includes(el), querySelectorAll: () => btns,
        querySelector: (sel) => (/\.fshare-btns button:not\(\[disabled\]\)/.test(sel) ? btns.find(b => b.name !== '关闭' && !actDisabled(b)) || null : null)
    };
    app.$refs.fshareBox = box;
    for (const n of REAL) { try { app[n] = mkMethod(n, ctx).bind(app); } catch (e) { /* 改前的版本没有这个方法:用例自然失败,不中断整个脚本 */ } }
    if (app._histBoot) app._histBoot();   // 与 mounted() 一样:启动时注册常驻 popstate
    app._realFrameBackdrop = app._frameBackdrop;
    app._frameBackdrop = (name, hint) => { S.backdropCalls.push(name); S.backdropHint = hint; return Promise.resolve(o.art === undefined ? { art: 1, naturalWidth: 780, naturalHeight: 439 } : o.art); };
    app._frameIcon = () => Promise.resolve(null);
    if (!o.realQr) app._loadQrLib = () => Promise.resolve(qrcode);
    return { app, S, hist, fire, g, ctx, fsState, box, btns };
}

console.log('④ shareFrame 端到端(假播放器/画布/历史)');
{
    // 正常:hls.js 画面可读
    const { app, S, hist, fire } = makeApp();
    await app.shareFrame();
    const fs1 = app.frameShare;
    const post = S.posts.find(p => p.url === '/api/stats/share');
    ok(!!post, '登记了一次分享');
    eq(post && post.body.channel, 'frame', '分享统计渠道 = frame');
    eq(post && post.body.t, 784, '登记的 t = 原时间轴秒数(754.4 + 剪掉的 30 → 784)');
    eq(post && post.body.episode, '第02集', '登记的集名 = 当前集');
    const code = post && post.body.code;
    ok(code === 'PanelCode1', '用的是面板上那个码(先登记再拼链接)', code);
    eq(fs1.link, 'https://ednovas.video/?play=%E7%B9%81%E8%8A%B1&ep=%E7%AC%AC02%E9%9B%86&t=784&s=' + code, '弹窗链接:同一拼法、&t= 原时间轴、&s= 登记的码');
    ok(app.shareCode && app.shareCode !== code, '分享后换了新码(下一次分享单独计)');
    eq(fs1.title, '繁花 · 第02集 · 12:34', '卡片标题 = 剧名 · 集名 · 进度条上的时间(剪后 12:34,不是 13:04)');
    ok(fs1.show && !fs1.busy && fs1.img.startsWith('data:image/jpeg') && !fs1.err, '卡片生成完成(dataURL 给 <img>)', fs1);
    eq(fs1.note, '', '用了画面 → 不提示');
    eq(S.backdropCalls.length, 0, '画面可读 → 不去找剧照');
    eq(app.showSharePanel, false, '收起分享面板');
    const d = S.drawn[0];
    ok(d && d.opts.img && d.opts.img.sw === 1280 && d.opts.img.sh === 720 && d.opts.poster === false, '截图按长边 1280 画进卡片', d && d.opts.img);
    ok(d && d.opts.sub === '扫码从这一秒开始看' && d.opts.brand === 'E视界' && d.opts.host === 'ednovas.video', '提示语与站点');
    const M = d ? qrFromOps(d.cv, d.r.qrBox, d.r.qrCell, d.opts.qr.count) : null;
    eq(M ? decodeQR(M).text : null, fs1.link, '卡片上画出来的二维码解码 == 弹窗里的链接');
    ok(S.pushes === 1 && hist.entries[hist.idx].state && hist.entries[hist.idx].state.dgFrameShare === 1, '打开时压了一条历史(返回键关弹窗)');
    eq(app._frameShareRes && app._frameShareRes.name, '繁花_第02集_12-34.jpg', '保存文件名');
    eq(fs1.canFiles, false, '不支持分享文件的浏览器不显示「分享…」');
    // 保存 / 复制
    app.frameShareSave();
    ok(S.clicked && S.clicked.href === 'blob:card-1' && S.clicked.download === '繁花_第02集_12-34.jpg', '保存图片走 blob 地址 + download');
    let copied = null;
    app.copyShareLink = async (u) => { copied = u; return true; };
    await app.frameShareCopy();
    eq(copied, fs1.link, '复制链接复制的是卡片那条(带时间点与它的码)');
    // 再点一次(弹窗开着)不重复生成
    await app.shareFrame();
    eq(S.posts.filter(p => p.url === '/api/stats/share').length, 1, '弹窗开着时再点不重复登记');
    // 点关闭:回收 blob、退掉压的历史;退回那一下的 popstate 不再触发关闭逻辑
    app.closeFrameShare();
    ok(!app.frameShare.show && S.revoked.includes('blob:card-1') && app._frameShareRes === null, '关闭:回收 blob 地址');
    eq(S.backs, 1, '关闭:退掉自己压的那条历史');
    await app.shareFrame();
    ok(!app.frameShare.show, '刚关、退历史那一下还没落地时再点 → 不开(防历史错乱)');
    await tick(); await tick();
    eq(S.synced, 1, '退回那一下由 _frameShareBack 认领(只补写一次地址栏),不当成用户返回');
    eq((S.listeners.popstate || []).length, 1, 'popstate 只有启动时注册的那一个常驻的(弹窗不再自己挂/摘)');
    eq((S.listeners.keydown || []).length + (S.listeners.keyup || []).length, 0, '弹窗的按键监听(keydown/keyup)已摘掉');

    // 返回键:popstate → 关闭,不再 history.back()
    await app.shareFrame();
    ok(app.frameShare.show, '第二次打开');
    const backs0 = S.backs;
    hist.idx--; fire('popstate', { state: null });
    ok(!app.frameShare.show && S.backs === backs0, '返回键(popstate)关闭弹窗,不再额外后退');
    ok(S.revoked.includes('blob:card-2'), '返回键关闭也回收 blob');
    // Esc
    await app.shareFrame();
    let prevented = false;
    fire('keydown', { key: 'Escape', preventDefault() { prevented = true; }, stopImmediatePropagation() { } });
    ok(!app.frameShare.show && prevented, 'Esc 关闭弹窗(且不让 DPlayer 再处理这次 Esc)');
}
{
    // 画布被污染(原生 HLS / 跨域 MP4)→ 剧照 + 角标 + 提示
    const { app, S } = makeApp({ canvas: { taint: true } });
    await app.shareFrame();
    eq(S.backdropCalls[0], '繁花', '画布被污染 → 按片名找剧照');
    const d = S.drawn[0];
    ok(d && d.opts.img && d.opts.img.src.art === 1 && d.opts.poster === true, '卡片画的是剧照、标了 poster', d && d.opts.img);
    ok(d && d.cv.ops.some(o => o.op === 'text' && o.t === '剧照 · 非当前画面'), '卡片上有「剧照 · 非当前画面」角标');
    ok(/不支持截取画面/.test(app.frameShare.note) && /剧照/.test(app.frameShare.note), '弹窗提示换成了剧照', app.frameShare.note);
    ok(app.frameShare.link.includes('&t=784'), '链接照样带时间点');
}
{
    const { app, S } = makeApp({ canvas: { taint: true }, art: null });
    await app.shareFrame();
    const d = S.drawn[0];
    ok(d && d.opts.img === null && d.opts.poster === false, '剧照也没有 → 不画图、不标角标');
    ok(/片名/.test(app.frameShare.note), '提示里说只放了片名', app.frameShare.note);
}
{
    const { app, S } = makeApp({ canvas: { blank: true } });
    await app.shareFrame();
    ok(S.backdropCalls.length === 1 && /不支持截取画面/.test(app.frameShare.note), 'Safari 画出全透明 → 当没截到');
}
{
    const { app, S } = makeApp({ video: { readyState: 1 } });
    await app.shareFrame();
    ok(S.backdropCalls.length === 1 && /还没加载出来/.test(app.frameShare.note), '还没解码出画面 → 剧照');
    eq(S.canvases.filter(c => c.width === 1280).length, 0, '没画面时不去画截图');
}
{
    const { app } = makeApp({ video: { currentTime: 0.4 } });
    app._cutToBase = (t) => t;
    await app.shareFrame();
    ok(!/[?&]t=/.test(app.frameShare.link), '开头不到 1 秒:链接不带 &t=');
}
{
    // 直播 / 未登录预览 / 没播放器:不出卡片、不登记
    for (const [label, o] of [['直播频道', { group: { name: 'CCTV-5', _isLive: true } }], ['直播模式', { liveActive: true }], ['未登录预览', { preview: true }], ['没有剧', { group: null }]]) {
        const { app, S } = makeApp(o);
        await app.shareFrame();
        ok(!app.frameShare.show && !S.posts.length, label + ':不生成卡片、不登记分享');
    }
    const { app, S } = makeApp({ noDp: true });
    await app.shareFrame();
    ok(!app.frameShare.show && S.toasts.length === 1, '播放器没就绪:只提示');
}
{
    // 没登录/没开统计:不带 &s=,不登记
    const { app, S } = makeApp({ noToken: true });
    app.shareCode = '';
    await app.shareFrame();
    ok(!S.posts.length && !/[?&]s=/.test(app.frameShare.link) && app.frameShare.link.includes('&t=784'), '不能统计时:链接不带码、不登记');
}
{
    // 只有一集(电影):卡片不写集名、链接不带 ep
    const { app } = makeApp({ episodes: [{ name: '正片', url: 'u2' }] });
    await app.shareFrame();
    eq(app.frameShare.title, '繁花 · 12:34', '电影:剧名 · 时间');
    ok(!/[?&]ep=/.test(app.frameShare.link), '电影:链接不带 ep');
}
{
    // 真全屏下先退出全屏(弹窗才看得见)
    const { app, S } = makeApp({ fullscreen: true });
    await app.shareFrame();
    eq(S.fsCancel, 'browser', '真全屏时先退出');
}
{
    // 能分享文件的浏览器显示「分享…」,点了带图片文件
    const shared = [];
    const { app } = makeApp({ nav: { share: (d) => { shared.push(d); return Promise.resolve(); }, canShare: (d) => !!(d && d.files && d.files.length) } });
    await app.shareFrame();
    ok(app.frameShare.canFiles, 'navigator.canShare({files}) 为真 → 显示「分享…」');
    app.frameShareNative();
    ok(shared[0] && shared[0].files[0].name === '繁花_第02集_12-34.jpg' && shared[0].text.includes(app.frameShare.link), '系统分享带卡片文件 + 链接');
}
{
    // 微信/QQ 内置浏览器:保存图片提示长按
    const { app, S } = makeApp({ nav: { userAgent: 'Mozilla/5.0 MicroMessenger/8.0' } });
    await app.shareFrame();
    S.clicked = null;
    app.frameShareSave();
    ok(!S.clicked && /长按/.test(S.toasts[S.toasts.length - 1] || ''), '微信里保存图片 → 提示长按');
}
{
    // 生成途中关掉:结果作废(不再写回弹窗、不留 blob)
    const { app, S } = makeApp();
    let release;
    app._loadQrLib = () => new Promise(r => { release = () => r(qrcode); });
    const p = app.shareFrame();
    ok(app.frameShare.show && app.frameShare.busy && app.frameShare.link.includes('&t=784'), '生成中:弹窗已开、链接已可复制');
    app.closeFrameShare();
    release(); await p;
    ok(!app.frameShare.show && !app._frameShareRes && S.created === 0, '生成途中关掉 → 结果作废');
}
{
    // 二维码库加载失败 → 报错但链接仍可复制;真 _loadQrLib 失败后可重试
    const { app } = makeApp({ realQr: true, noQrGlobal: true, qrLoadFails: true });
    await app.shareFrame();
    ok(!app.frameShare.busy && /失败/.test(app.frameShare.err) && app.frameShare.link.includes('&t=784'), '二维码库加载失败:提示 + 链接仍在');
    ok(!app._qrLibP, '加载失败后清掉缓存的 Promise(下次重试)');
}
{
    // 真 _loadQrLib:按需插 <script>,?v= 与 sw.js 预缓存一致;第二次直接用全局
    const { app, S } = makeApp({ realQr: true, noQrGlobal: true });
    const lib = await app._loadQrLib();
    ok(lib === qrcode && S.scripts.length === 1 && S.scripts[0].src === 'libs/js/qrcode-generator.min.js?v=2.0.4', '按需加载二维码库', S.scripts.map(s => s.src));
    await app._loadQrLib();
    eq(S.scripts.length, 1, '已加载过不重复插 script');
}
{
    // 真 _frameEncode:超过 400KB 逐档降质量
    const { app } = makeApp({ canvas: { blobSize: (q) => (q > 0.75 ? 600 * 1024 : 300 * 1024) } });
    const cv = fakeCanvas({ blobSize: (q) => (q > 0.75 ? 600 * 1024 : 300 * 1024) });
    const out = await app._frameEncode(cv);
    ok(out.blob.q === 0.72 && out.blob.type === 'image/jpeg' && out.dataUrl.startsWith('data:image/jpeg'), 'JPEG 超 400KB 降到 0.72', out.blob);
    const cv2 = fakeCanvas({ blobSize: () => 900 * 1024 });
    const out2 = await app._frameEncode(cv2);
    eq(out2.blob.q, 0.6, '一直超也停在最低档 0.6(不死循环)');
}
{
    // 真 _frameBackdrop:优先横版剧照 w780,带 crossOrigin;第一个图片地址读不了换同源代理;同名记住结果
    const { app, S } = makeApp({ tmdb: { results: [{ media_type: 'tv', name: '繁花', backdrop_path: '/b.jpg', poster_path: '/p2.jpg' }] }, imgFetch: (u) => (u.startsWith('/api/') ? { status: 200, bytes: JPEG, type: 'image/jpeg' } : 'neterr') });
    const img = await app._realFrameBackdrop('繁花 第二季', { tv: true });
    ok(img && img._src === 'blob:/api/tmdb-image/w780/b.jpg', '官方 CDN 读不了 → 同源代理 w780 横版剧照', img && img._src);
    ok(S.images.length === 1 && S.images.every(im => im.crossOrigin === 'anonymous' && /^blob:/.test(im._src)), '剧照从 blob: 地址(同源)解码,不污染卡片画布', S.images.map(im => im._src));
    ok(S.imgFetches[0] === 'https://image.tmdb.org/t/p/w780/b.jpg' && S.imgFetches[1] === '/api/tmdb-image/w780/b.jpg', '先试当前 TMDB 图片地址(original 换成 w780),再试同源代理', S.imgFetches);
    ok(/query=%E7%B9%81%E8%8A%B1&/.test(S.tmdb[0]) && S.tmdb[0].includes('/api/tmdb-proxy?path='), '走 tmdb-proxy、季号剥掉再搜', S.tmdb[0]);
    const n0 = S.tmdb.length;
    const again = await app._realFrameBackdrop('繁花 第二季', { tv: true });
    ok(again === img && S.tmdb.length === n0, '同名第二次直接用记住的剧照');
    const { app: a2 } = makeApp({ tmdb: { results: [{ media_type: 'tv', name: 'X', poster_path: '/only.jpg' }] } });
    const im2 = await a2._realFrameBackdrop('X', { tv: true });
    ok(im2 && im2._src === 'blob:https://image.tmdb.org/t/p/w500/only.jpg', '只有竖版海报 → w500', im2 && im2._src);
    const { app: a3 } = makeApp({ tmdb: { results: [] } });
    eq(await a3._realFrameBackdrop('Y', { tv: true }), null, 'TMDB 没结果 → null');
}
{
    // 第一轮审查回归:剧照只认完全同名的(与追更日历认片同一套),不拿搜索结果里第一个有图的冒充"剧照"
    //   真实 /search/multi(2026-10-08):海贼王 → 前 20 个结果里没有单纯叫「海贼王」的剧,第一个有横图的是《海贼王女》;
    //   老师 → 第一个是《老练律师》,完全同名的「老师」排第 9(只有竖版海报);神探 → 完全同名的排第 6
    const BD = async (name, results, hint) => { const { app, S } = makeApp({ tmdb: { results } }); const im = await app._realFrameBackdrop(name, hint || { tv: true }); return { src: im && im._src.replace(/^blob:/, ''), S }; };
    let r = await BD('海贼王', [{ media_type: 'tv', name: '海贼王女', original_name: 'Fena: Pirate Princess', backdrop_path: '/fena.jpg', first_air_date: '2021-08-15' }, { media_type: 'person', name: '海贼王', profile_path: '/p.jpg' }]);
    ok(r.src === null && r.S.images.length === 0, '海贼王:没有完全同名的 → 不用剧照(以前画《海贼王女》还标「剧照」)', r.src);
    const fuzzy = (n, k) => Array.from({ length: k }, (_, i) => ({ media_type: 'tv', name: n + '之' + i, backdrop_path: '/f' + i + '.jpg' }));
    r = await BD('老师', [{ media_type: 'tv', name: '老练律师', original_name: 'Matlock', backdrop_path: '/matlock.jpg' }].concat(fuzzy('老师', 7), [{ media_type: 'tv', name: '老师', poster_path: '/teacher.jpg' }]));
    ok(r.src === 'https://image.tmdb.org/t/p/w500/teacher.jpg', '老师:用完全同名那部的海报(哪怕前面的模糊结果有横图)', r.src);
    r = await BD('神探', fuzzy('神探', 5).concat([{ media_type: 'tv', name: '神探', backdrop_path: '/sd.jpg' }]));
    ok(r.src === 'https://image.tmdb.org/t/p/w780/sd.jpg', '神探:完全同名的横版剧照', r.src);
    r = await BD('繁花', [{ media_type: 'movie', title: '繁花', backdrop_path: '/m1995.jpg', release_date: '1995-01-01' }, { media_type: 'tv', name: '繁花', backdrop_path: '/tv2023.jpg', first_air_date: '2023-12-27' }], { tv: true, year: 2023 });
    ok(r.src === 'https://image.tmdb.org/t/p/w780/tv2023.jpg', '知道年份(同名拆卡签名):首播年差 ≤1 的那部', r.src);
    r = await BD('繁花', [{ media_type: 'movie', title: '繁花', backdrop_path: '/m.jpg' }, { media_type: 'tv', name: '繁花', backdrop_path: '/tv.jpg' }], { tv: true });
    ok(r.src === 'https://image.tmdb.org/t/p/w780/tv.jpg', '剧集认剧集', r.src);
    r = await BD('神探', [{ media_type: 'movie', title: '神探', backdrop_path: '/movie2007.jpg', release_date: '2007-11-29' }], { tv: true });
    ok(r.src === null, '剧集只有同名的电影 → 不用(同名电影是另一部作品)', r.src);
    r = await BD('神探', [{ media_type: 'tv', name: '神探', backdrop_path: '/tv.jpg' }, { media_type: 'movie', title: '神探', backdrop_path: '/movie.jpg' }], { tv: false });
    ok(r.src === 'https://image.tmdb.org/t/p/w780/movie.jpg', '单集(电影)认电影', r.src);
    r = await BD('繁花', [{ media_type: 'tv', name: '繁花', backdrop_path: '/tv.jpg', first_air_date: '2023-12-27' }], { tv: true, year: 2019 });
    ok(r.src === null, '知道年份但同名的那部年份对不上 → 不用', r.src);
    // shareFrame 把"剧集还是电影 / 年份"交给 _frameBackdrop
    const { app: ap, S: S2 } = makeApp({ canvas: { taint: true }, group: { name: '繁花', _workLabel: '2023 剧集', _workSig: 'y2023s' } });
    await ap.shareFrame();
    ok(S2.backdropHint && S2.backdropHint.tv === true && S2.backdropHint.year === 2023, 'shareFrame:剧集 + 同名拆卡年份交给 _frameBackdrop', S2.backdropHint);
}

console.log('④b 第一轮审查回归:弹窗层级 / 返回键 / 按键 / App 里保存');
// 抽 mounted() 里注册的 keydown 处理函数:从标记往前找最近的 addEventListener('keydown', function (e) {,数大括号到配平(跳过字符串、// 注释)
function handlerSrc(marker) {
    const at = HTML.indexOf(marker);
    if (at < 0) throw new Error('marker not found: ' + marker);
    const f0 = HTML.indexOf('function (e) {', HTML.lastIndexOf("addEventListener('keydown', function (e) {", at));
    let i = f0 + 'function (e) {'.length, depth = 1, q = null;
    for (; i < HTML.length && depth > 0; i++) {
        const c = HTML[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '/' && HTML[i + 1] === '/') { i = HTML.indexOf('\n', i); continue; }
        if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
        if (c === '{') depth++; else if (c === '}') depth--;
    }
    return HTML.slice(f0, i);
}
const keyEv = (key, extra) => { const e = Object.assign({ key, code: key === ' ' ? 'Space' : key, keyCode: key === ' ' ? 32 : 0, prevented: false, stopped: false }, extra || {}); e.preventDefault = () => { e.prevented = true; }; e.stopImmediatePropagation = () => { e.stopped = true; }; e.stopPropagation = () => { e.stopped = true; }; return e; };
// 安卓 App(MainActivity.onBackPressed)注入的那段 JS:按 Java 字符串字面量拼回来(去掉注释字面量 —— 原样拼成一行时 // 会把后面全注释掉,见报告)
const APK_JS = (() => {
    try {
        const j = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/ednovas/donguatv/MainActivity.java'), 'utf8');
        const i = j.indexOf('webView.evaluateJavascript('), k = j.indexOf('result ->', i);
        return [...j.slice(i, k).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1')).filter(p => !/^\s*\/\//.test(p)).join('\n');
    } catch (e) { return ''; }
})();
{
    // R1 网页全屏(DPlayer .dplayer-fulled z-index 2147483647,和弹窗同在 .detail-overlay 里)盖住弹窗 → 弹窗挂到 body 下(teleport)
    const tp = /<teleport to="body">\s*\n\s*<div v-if="frameShare\.show" class="fshare-mask"[\s\S]*?<\/teleport>/.exec(HTML);
    ok(!!tp, 'R1 截帧弹窗用 <teleport to="body"> 挂到 body 下(不再和网页全屏的播放器同在 .detail-overlay 层叠上下文里)');
    const zm = /\n\s*\.fshare-mask \{[^}]*z-index:(\d+)/.exec(HTML), zd = /\.detail-overlay \{[^}]*z-index: (\d+)/.exec(HTML), zt = /z-index:(\d+);font-size:14px;box-shadow/.exec(HTML);
    ok(zm && zd && zt && +zm[1] > +zd[1] && +zm[1] < +zt[1], 'R1 弹窗层级:高于播放页(.detail-overlay)、低于小提示(复制成功等提示要压在弹窗上面)', [zm && zm[1], zd && zd[1], zt && zt[1]]);
    // 网页全屏里打开:不退出网页全屏(只退真全屏,真全屏在 top layer 谁也盖不上)
    const { app, S } = makeApp({ webfs: true });
    await app.shareFrame();
    ok(app.frameShare.show && S.fsCancel === undefined, 'R1 网页全屏里打开:弹窗照开,不退网页全屏(TV 模式一直是网页全屏)');
}
{
    // R2 TV 模式遥控 Esc/Backspace、App 返回键(都调 closeDetail)只关弹窗,不关整个播放页
    const { app, S, ctx } = makeApp({ tv: true, webfs: true });
    const closeDetail = mkMethod('closeDetail', ctx).bind(app);
    let realClosed = 0;
    app.closeDetail = function () { realClosed++; return closeDetail(); };
    await app.shareFrame();
    try { closeDetail(); } catch (e) { }
    ok(!app.frameShare.show && app.showDetail === true, 'R2 closeDetail():弹窗开着时只关弹窗,播放页不动');
    // TV 遥控:window 捕获阶段的 TV 处理器(挂载时注册,比弹窗自己的 Esc 监听早)
    const tv = vm.runInContext('(function (self) { return ' + handlerSrc('// TV 模式全局返回键处理') + '; })', ctx)(app);
    for (const key of ['Escape', 'Backspace']) {
        await tick(); await tick();
        await app.shareFrame();
        realClosed = 0;
        const e = keyEv(key);
        try { tv(e); } catch (err) { }
        ok(!app.frameShare.show && app.showDetail === true && realClosed === 0 && e.prevented && e.stopped, 'R2 TV 模式 ' + key + ':只关弹窗,不走 closeDetail(以前整个播放页关掉、地址栏留着 ?play=)', { show: app.frameShare.show, detail: app.showDetail, realClosed });
    }
    await tick(); await tick();
    await app.shareFrame();
    const e2 = keyEv('ArrowDown');
    try { tv(e2); } catch (err) { }
    ok(app.frameShare.show && !e2.prevented && !e2.stopped, 'R2 TV 模式弹窗开着:方向键交给弹窗(不被抢去跳播放器按钮)');
    app.closeFrameShare(); await tick(); await tick();
    // 安卓 App 的返回键:onBackPressed 注入的 JS 先退网页全屏再调 closeDetail
    if (APK_JS) {
        await app.shareFrame();
        ctx.window.vueApp = app;
        let ret = null;
        try { ret = vm.runInContext(APK_JS, ctx); } catch (err) { ret = 'ERR ' + err.message; }
        ok(ret === 'closed_detail' && !app.frameShare.show && app.showDetail === true, 'R2 App 返回键(MainActivity 那段 JS):只关弹窗,播放页还在', { ret, detail: app.showDetail });
        ok(S.fsRequest === 'web', 'R2 App 返回键先退了网页全屏 → 关弹窗后恢复网页全屏(TV 模式)', S.fsRequest);
        await tick(); await tick();
    } else ok(false, 'R2 找不到 MainActivity 的返回键 JS');
}
{
    // R2 退历史那一下落地时播放页已经关了(别的路径关的):地址栏清成首页,不留 ?play=(以前刷新又把刚关的剧打开)
    const { app, S } = makeApp();
    await app.shareFrame();
    app.showDetail = false;
    app.closeFrameShare();
    await tick(); await tick();
    ok(S.replaced.includes('/') && S.synced === 0, 'R2 自己退掉的那条历史落地时播放页已关 → replaceState 成首页地址', S.replaced);
}
{
    // R3 空格:弹窗开着时不播放/暂停背后的视频,焦点按钮照常被空格按下
    const { app, S, ctx, btns } = makeApp();
    const space = vm.runInContext('(function (self) { return ' + handlerSrc("if (e.key !== ' ' && e.code !== 'Space' && e.keyCode !== 32) return;") + '; })', ctx)(app);
    await app.shareFrame();
    const e = keyEv(' ');
    space(e);
    ok(S.toggled === 0 && !e.prevented, 'R3 弹窗开着按空格:不 toggle 视频、不 preventDefault(按钮照常被空格激活)', { toggled: S.toggled, prevented: e.prevented });
    // 弹窗自己的按键监听:Esc 以外的键截住不往下传(DPlayer 热键 ←→↑↓/空格不再动背后的播放器),但不 preventDefault
    const e2 = keyEv(' ', { target: btns[2] });   // 焦点在弹窗的「复制链接」上
    (S.listeners.keydown || []).forEach(f => f(e2));
    ok(e2.stopped && !e2.prevented && app.frameShare.show, 'R3 弹窗开着:空格被弹窗截住(不传给 DPlayer 热键),焦点按钮的默认动作保留', e2);
    const e3 = keyEv('ArrowLeft');
    (S.listeners.keydown || []).forEach(f => f(e3));
    ok(e3.stopped && !e3.prevented, 'R3 方向键同理(不快退背后的视频)');
    app.closeFrameShare(); await tick(); await tick();
    const e4 = keyEv(' ');
    space(e4);
    ok(S.toggled === 1 && e4.prevented, 'R3 弹窗关了:空格照常播放/暂停');
}
{
    // R4 打开时焦点进弹窗(键盘/遥控能直接操作),关掉还回原来的元素
    const back = { focus: () => { back.n = (back.n || 0) + 1; }, isConnected: true };
    const { app, S } = makeApp({ active: back });
    await app.shareFrame();
    ok(S.focused.length === 1 && S.focused[0][1] && S.focused[0][1].preventScroll === true, 'R4 打开:焦点移到弹窗', S.focused);
    app.closeFrameShare();
    ok(back.n === 1, 'R4 关闭:焦点还给打开前的元素(TV 遥控不丢焦点)');
}
{
    // R5 安卓 App(Capacitor WebView):<a download href=blob:> 被丢掉、也没有长按存图 → 不假装能下载,提示截屏
    const UA_WV = 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36';
    const { app, S } = makeApp({ native: true, nav: { userAgent: UA_WV } });
    await app.shareFrame();
    ok(/截屏/.test(app.frameShare.tip) && !/长按/.test(app.frameShare.tip), 'R5 App 里:提示截屏(不说"长按图片可保存")', app.frameShare.tip);
    S.clicked = null;
    app.frameShareSave();
    ok(!S.clicked && /截屏/.test(S.toasts[S.toasts.length - 1] || ''), 'R5 App 里点保存图片:不点死链,提示截屏/复制链接', S.toasts);
    const { app: a2, S: S2 } = makeApp({ nav: { userAgent: UA_WV } });
    await a2.shareFrame();
    S2.clicked = null;
    a2.frameShareSave();
    ok(S2.clicked && /截屏|长按/.test(S2.toasts[S2.toasts.length - 1] || '') && /截屏/.test(a2.frameShare.tip), 'R5 别的安卓内嵌网页:照样试下载,同时提示长按/截屏', S2.toasts);
    const { app: a3, S: S3 } = makeApp();
    await a3.shareFrame();
    S3.clicked = null;
    a3.frameShareSave();
    ok(S3.clicked && !S3.toasts.length && /长按/.test(a3.frameShare.tip), 'R5 普通浏览器:直接下载、不弹提示');
    ok(/<div v-if="frameShare\.img && frameShare\.tip" class="fshare-tip">\{\{ frameShare\.tip \}\}<\/div>/.test(HTML), 'R5 弹窗里的提示文字按设备来(frameShare.tip)');
}
{
    // R6 手机横屏(高度只剩 ~280px):弹窗能滚、横屏矮屏时图在左按钮在右,按钮不再掉到屏幕外
    const box = /\n\s*\.fshare-box \{([^}]*)\}/.exec(HTML);
    ok(box && /overflow-y:auto/.test(box[1]), 'R6 .fshare-box 放不下时能滚(overflow-y:auto)', box && box[1]);
    const mq = /@media \(max-height: ?420px\) and \(orientation: ?landscape\) \{([\s\S]*?)\n {8}\}/.exec(HTML);
    ok(mq && /\.fshare-box \{[^}]*grid/.test(mq[1]) && /\.fshare-stage \{[^}]*min-height:0/.test(mq[1]) && /\.fshare-img \{[^}]*max-height/.test(mq[1]), 'R6 横屏矮屏:图在左、按钮在右(grid),画面区不再强占 120px', mq && mq[1].slice(0, 300));
}

console.log('④c 第二轮审查回归:SW 占位图不当剧照 / 返回键关弹窗后地址栏 / 刷新留下的历史 / 焦点红框 / 焦点陷阱');
{
    // F1 isRaster:按文件头认真图片(Vercel 版 /api/tmdb-image 转发时不带 Content-Type,不能看头)
    const B = (...xs) => new Uint8Array(xs.flatMap(x => (typeof x === 'string' ? [...x].map(c => c.charCodeAt(0)) : x)));
    const has = typeof C.isRaster === 'function', isR = (x) => (has ? C.isRaster(x) : null);
    ok(has && isR(JPEG) && isR(B([0x89], 'PNG', [13, 10, 26, 10, 0, 0, 0, 13])) && isR(B('RIFF', [1, 2, 3, 4], 'WEBPVP8 ')) && isR(B('GIF89a', [1, 0, 1, 0, 0, 0]))
        && isR(B([0, 0, 0, 28], 'ftypavif', [0, 0, 0, 0])), 'F1 isRaster:JPEG/PNG/WebP/GIF/AVIF 文件头 → 真图');
    ok(has && !isR(B(SW_SVG.slice(0, 40))) && !isR(B('<?xml version="1.0"?><svg')) && !isR(B('<!doctype html><html>')) && !isR(B([0xFF, 0xD8])) && !isR(new Uint8Array(0)) && !isR(null)
        && !isR(B('RIFF', [1, 2, 3, 4], 'WAVEfmt ')), 'F1 isRaster:SW 的「加载失败」SVG / HTML 错误页 / 截断 / 空 / 别的 RIFF → 不是');
}
{
    // F1 官方图床连不上(大陆用户的 Vercel 部署 / 断网):sw.js 回 200 的「加载失败」SVG。以前 <img crossOrigin> 照样 onload(300×450)→
    //    画进卡片标成「剧照」、记一整个会话、也不再试同源代理。现在:不认、换同源 /api/tmdb-image,取到真图才记住
    const res = [{ media_type: 'tv', name: '繁花', backdrop_path: '/3J8HmgR16MKX2iT71mB4EIDdV2x.jpg', first_air_date: '2023-12-27' }];
    const swPlaceholder = (u) => (u.startsWith('https://image.tmdb.org') ? { status: 200, bytes: SW_SVG, type: 'image/svg+xml' } : { status: 200, bytes: JPEG, type: 'image/jpeg' });
    const { app, S } = makeApp({ tmdb: { results: res }, imgFetch: swPlaceholder });
    const img = await app._realFrameBackdrop('繁花', { tv: true, year: 2023 });
    ok(img && img._src === 'blob:/api/tmdb-image/w780/3J8HmgR16MKX2iT71mB4EIDdV2x.jpg', 'F1 官方图床回的是 SW 占位 SVG → 不认,换同源代理取到真剧照', img && img._src);
    ok(!S.images.some(im => /image\.tmdb\.org/.test(im._src)), 'F1 占位 SVG 根本没被解码', S.images.map(im => im._src));
    ok(app._frameArtMemo && app._frameArtMemo.get('繁花|t2023') === img, 'F1 记住的是真剧照');
    // 所有地址都只回占位 → null、不记住(下次再试)
    const { app: a2, S: S2 } = makeApp({ tmdb: { results: res }, imgFetch: () => ({ status: 200, bytes: SW_SVG, type: 'image/svg+xml' }) });
    eq(await a2._realFrameBackdrop('繁花', { tv: true, year: 2023 }), null, 'F1 每个地址都是占位图 → 没有剧照(卡片只放片名)');
    ok(!(a2._frameArtMemo && a2._frameArtMemo.has('繁花|t2023')), 'F1 占位/失败不记住');
    const n0 = S2.imgFetches.length;
    await a2._realFrameBackdrop('繁花', { tv: true, year: 2023 });
    ok(S2.imgFetches.length > n0, 'F1 下次分享会再去取');
    // Vercel 版代理:不带 Content-Type,但字节是 JPEG → 认;HTTP 404 / 断网 → 换下一个
    const { app: a3 } = makeApp({ tmdb: { results: res }, imgFetch: (u) => (u.startsWith('https://') ? { status: 404, bytes: 'Image not found' } : { status: 200, bytes: JPEG, type: null }) });
    const im3 = await a3._realFrameBackdrop('繁花', { tv: true });
    ok(im3 && im3._src === 'blob:/api/tmdb-image/w780/3J8HmgR16MKX2iT71mB4EIDdV2x.jpg', 'F1 没有 Content-Type 的真 JPEG 照认;404 换下一个', im3 && im3._src);
    // shareFrame 端到端:画布被污染 + 官方图床只回占位 → 卡片上的是真剧照
    const { app: a4, S: S4 } = makeApp({ canvas: { taint: true }, tmdb: { results: res }, imgFetch: swPlaceholder, group: { name: '繁花', _workLabel: '2023 剧集', _workSig: 'y2023s' } });
    a4._frameBackdrop = a4._realFrameBackdrop;
    await a4.shareFrame();
    const d4 = S4.drawn[0];
    ok(d4 && d4.opts.poster === true && d4.opts.img && d4.opts.img.src._src === 'blob:/api/tmdb-image/w780/3J8HmgR16MKX2iT71mB4EIDdV2x.jpg', 'F1 shareFrame:卡片画的是同源代理取到的真剧照(不是「加载失败」)', d4 && d4.opts.img && d4.opts.img.src._src);
}
{
    // F2 弹窗开着时自动换了集(syncShareUrl 改的是弹窗那条),手机返回键/侧滑关弹窗 → 落到的打开前那条还是上一集 → 补写成当前集
    const { app, S, hist, fire } = makeApp();
    await app.shareFrame();
    const s0 = S.synced;
    hist.idx--; fire('popstate', { state: hist.entries[hist.idx].state });
    ok(!app.frameShare.show && S.synced === s0 + 1 && S.backs === 0, 'F2 返回键关弹窗:地址栏补写成当前集(以前只有点按钮关才补写)', { show: app.frameShare.show, synced: S.synced - s0 });
}
{
    // F9 弹窗开着时刷新/标签页被回收:留下 [A ?play=…][B 弹窗那条 dgFrameShare]
    const { app, S, hist, fire } = makeApp({ search: '?play=%E7%B9%81%E8%8A%B1&ep=%E7%AC%AC03%E9%9B%86' });
    // 模拟"刷新后":历史里还留着那条,state 带标记(用新的启动逻辑再跑一次 _histBoot)
    hist.entries = [{ state: null }, { state: { dgFrameShare: 1, keep: 7 } }]; hist.idx = 1;
    S.listeners.popstate = [];
    app._histBoot?.();
    ok(hist.entries[1].state && !('dgFrameShare' in hist.entries[1].state) && hist.entries[1].state.keep === 7 && (S.listeners.popstate || []).length === 1, 'F9 启动时去掉留下那条的 dgFrameShare 标记(别的 state 保留),注册一个常驻 popstate', hist.entries[1].state);
    hist.entries[1] = { state: { dgFrameShare: 1 } };
    app._histBoot?.();
    ok(hist.entries[1].state === null, 'F9 只有标记的 state → null');
    S.listeners.popstate = S.listeners.popstate.slice(0, 1);
    // (a) 播放页开着按返回:落到 A —— 页面不动,地址栏对齐当前集
    const s0 = S.synced;
    hist.idx = 0; fire('popstate', { state: null });
    ok(S.synced === s0 + 1 && !app.frameShare.show, 'F9 (a) 留下那条被退掉:播放页开着 → 地址栏写当前集');
    // (b) 播放页关了(closeDetail 把 B 改成 '/')再按返回:落到 A(?play=…)→ 清成首页地址(以前首页顶着上一部的深链,刷新又打开)
    app.showDetail = false; S.replaced.length = 0;
    fire('popstate', { state: null });
    ok(S.replaced.join() === '/', 'F9 (b) 首页落到旧深链 → 地址栏清成首页', S.replaced);
    // 没有 ?play= 的首页地址 → 不动
    const { app: a2, S: S2, fire: f2 } = makeApp({ search: '?requests=1' });
    a2.showDetail = false;
    f2('popstate', { state: null });
    ok(S2.replaced.length === 0 && S2.synced === 0, 'F9 首页别的地址(没有 ?play=/?live=)不动');
    // 刷新后再开一张、点关闭:只退自己新压的那条(一次)
    const { app: a3, S: S3, hist: h3 } = makeApp();
    h3.entries = [{ state: null }, { state: { dgFrameShare: 1 } }]; h3.idx = 1;
    S3.listeners.popstate = [];   // 换成"刷新后"那次启动注册的
    a3._histBoot?.();
    await a3.shareFrame();
    a3.closeFrameShare();
    await tick(); await tick();
    ok(S3.backs === 1 && h3.idx === 1 && S3.synced === 1, 'F9 刷新后再开一张再关:只退自己新压的那一条', { backs: S3.backs, idx: h3.idx });
}
{
    // F3 打开时焦点落在弹窗框(tabindex=-1)上:全站 [tabindex]:focus 的红框/红光晕(!important)不能把整个框住
    const css = /\n\s*(\.fshare-mask \.fshare-box:focus) \{([^}]*)\}/.exec(HTML);
    ok(css && /outline:\s*none !important/.test(css[2]) && /box-shadow:\s*0 20px 60px rgba\(0,\s*0,\s*0,\s*\.6\) !important/.test(css[2]), 'F3 .fshare-box:focus 去掉红框、保留原阴影(都 !important)', css && css[2]);
    const spec = (sel) => { const a = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length; return a; };
    const glob = /\n(\s*\.close-btn:focus,[\s\S]*?\[tabindex\]:focus) \{([^}]*)\}/.exec(HTML);
    ok(glob && /outline: 3px solid #e50914 !important/.test(glob[2]) && css && spec(css[1]) > spec('[tabindex]:focus'), 'F3 选择器比全站的 [tabindex]:focus 多一层(不看先后顺序都压得住)', [css && css[1], spec(css ? css[1] : '')]);
}
{
    // F10 焦点陷阱:Tab/Shift+Tab 在弹窗按钮间循环;焦点在弹窗外时回车/空格不按下背后的按钮(♥ 会直接取消收藏)
    const { app, S, g, btns, box } = makeApp();
    await app.shareFrame();
    const kd = (ev) => { (S.listeners.keydown || []).forEach(f => f(Object.assign(ev, { type: 'keydown' }))); return ev; };
    const ku = (ev) => { (S.listeners.keyup || []).forEach(f => f(Object.assign(ev, { type: 'keyup' }))); return ev; };
    eq(g.document.activeElement, box, 'F10 打开:焦点在弹窗框上');
    let e = kd(keyEv('Tab'));
    ok(e.prevented && g.document.activeElement === btns[0], 'F10 框上按 Tab → 第一个按钮');
    g.document.activeElement = btns[2];
    e = kd(keyEv('Tab'));
    ok(e.prevented && g.document.activeElement === btns[0], 'F10 最后一个按钮(复制链接)再 Tab → 回到第一个(以前跑到背后的 ♥)', g.document.activeElement && g.document.activeElement.name);
    e = kd(keyEv('Tab', { shiftKey: true }));
    ok(e.prevented && g.document.activeElement === btns[2], 'F10 第一个按钮 Shift+Tab → 最后一个');
    g.document.activeElement = box;
    e = kd(keyEv('Tab', { shiftKey: true }));
    ok(e.prevented && g.document.activeElement === btns[2], 'F10 框上 Shift+Tab → 最后一个(以前直接到背后的线路按钮)');
    g.document.activeElement = btns[1];
    e = kd(keyEv('Tab'));
    ok(!e.prevented && e.stopped, 'F10 中间的按钮之间 Tab:浏览器自己移(不拦默认动作)');
    const heart = { name: '♥' };
    e = kd(keyEv('Enter', { target: heart }));
    const e2 = kd(keyEv(' ', { target: heart })), e3 = ku(keyEv(' ', { target: heart })), e4 = ku(keyEv('Enter', { target: heart }));
    ok(e.prevented && e2.prevented && e3.prevented && e4.prevented, 'F10 焦点在弹窗外:回车/空格的 keydown、keyup 都不让按下背后的按钮');
    const e5 = kd(keyEv('Enter', { target: btns[1] })), e6 = ku(keyEv(' ', { target: btns[1] }));
    ok(!e5.prevented && !e6.prevented, 'F10 焦点在弹窗按钮上:回车/空格照常按下它');
    app.closeFrameShare();
    ok((S.listeners.keyup || []).length === 0 && (S.listeners.keydown || []).length === 0, 'F10 关掉后按键监听都摘掉');
    // 弹窗里一个能按的都没有(生成中按钮都禁用的极端情况)→ Tab 留在框上
    const { app: a2, g: g2, S: S2, box: b2 } = makeApp({ btns: [] });
    await a2.shareFrame();
    g2.document.activeElement = b2;
    const e7 = keyEv('Tab', { type: 'keydown' });
    (S2.listeners.keydown || []).forEach(f => f(e7));
    ok(e7.prevented && g2.document.activeElement === b2, 'F10 没有能按的 → Tab 留在弹窗框上');
}

{
    // ④d 第四轮审查回归 T1:TV 模式(安卓 App 默认就是)打开弹窗,焦点放在弹窗框上 —— 框没有焦点样式(F3 去掉了)、OK 键按了没反应,
    //   第一下"下"到了 ×、再 OK 就关了。现在 TV 模式聚焦第一个能按的按钮(生成中「保存图片」还灰着 → 「复制链接」)
    const { app, S, g, btns } = makeApp({ tv: true });
    await app.shareFrame();
    ok(S.focused.length >= 1 && S.focused[0][0] === '复制链接' && S.focused[0][1] && S.focused[0][1].preventScroll === true && g.document.activeElement === btns[2],
        'T1 TV 模式打开:焦点在「复制链接」(生成中保存图片是灰的),不是弹窗框', S.focused.map(f => f[0]));
    const kd = (ev) => { (S.listeners.keydown || []).forEach(f => f(Object.assign(ev, { type: 'keydown' }))); return ev; };
    const e = kd(keyEv('Enter', { target: g.document.activeElement }));
    ok(!e.prevented && app.frameShare.show, 'T1 遥控 OK(回车)落在「复制链接」上:照常按下它(不被弹窗拦)');
    // 生成完了焦点不乱跳(用户可能已经在按了)
    ok(S.focused.length === 1, 'T1 卡片生成完:焦点不再挪(还在复制链接)', S.focused.map(f => f[0]));
    // 打开时一个能按的都没有(复制链接也灰着)→ 先放框上,生成完「保存图片」能按了再挪过去
    const b2 = makeApp({ tv: true, noCopy: true });
    await b2.app.shareFrame();
    ok(b2.S.focused.map(f => f[0]).join() === 'box,保存图片' && b2.g.document.activeElement === b2.btns[1], 'T1 TV 模式、打开时没有能按的:先放框上,生成完挪到「保存图片」', b2.S.focused.map(f => f[0]));
    // 不是 TV(键盘/鼠标):照旧放弹窗框(全站 button:focus 是红框,鼠标点开时不该框住一个按钮)
    const b3 = makeApp();
    await b3.app.shareFrame();
    ok(b3.S.focused.map(f => f[0]).join() === 'box' && b3.g.document.activeElement === b3.box, 'T1 对照:不是 TV 模式 → 焦点照旧在弹窗框上', b3.S.focused.map(f => f[0]));
}
{
    // ④d T2:TV 模式弹窗开着时自动下一集 / 跳片尾 / 出错切线路 → play() 1.5s 后的"聚焦暂停/播放按钮"把焦点抢到被遮罩盖住的按钮上,
    //   弹窗的按钮都没焦点、OK 键被弹窗拦掉没反应。现在弹窗开着不抢,记成关弹窗后焦点回去的地方
    const m = /\/\/ 4\. 聚焦到暂停\/播放按钮[^\n]*\n(?:\s*\/\/[^\n]*\n)*(\s*const playPauseBtn = document\.getElementById\('tv-play-pause'\);\s*\n\s*if \(playPauseBtn\) \{[\s\S]*?\n {32}\})/.exec(HTML);
    ok(!!m, 'T2 play() 的 TV 模式定时器里找得到"聚焦暂停/播放按钮"那一步');
    if (m) {
        const step4 = new Function('document', m[1]);
        const { app, S, g, btns } = makeApp({ tv: true });
        await app.shareFrame();
        const pp = { name: 'tv-play-pause', isConnected: true, focus(opt) { g.document.activeElement = pp; S.focused.push(['tv-play-pause', opt]); } };
        const doc = { getElementById: (id) => (id === 'tv-play-pause' ? pp : null) };
        step4.call(app, doc);
        ok(g.document.activeElement === btns[2] && !S.focused.some(f => f[0] === 'tv-play-pause'), 'T2 弹窗开着时换集:焦点留在弹窗里(不抢到被遮住的暂停按钮)', S.focused.map(f => f[0]));
        app.closeFrameShare();
        ok(g.document.activeElement === pp, 'T2 关掉弹窗:焦点去新的暂停/播放按钮(原来的元素可能已经被换掉)', g.document.activeElement && g.document.activeElement.name);
        // 弹窗没开:照旧聚焦
        const c2 = makeApp({ tv: true });
        const pp2 = { focus() { c2.g.document.activeElement = pp2; } };
        step4.call(c2.app, { getElementById: () => pp2 });
        ok(c2.g.document.activeElement === pp2, 'T2 对照:弹窗没开 → 照旧聚焦暂停/播放按钮');
    }
}

console.log('⑤ 静态接线');
{
    ok(/<button v-if="currentGroup && !currentGroup\._isLive" class="fshare-entry" @click="shareFrame">/.test(HTML), '分享面板里有「分享当前画面」入口,直播不显示');
    ok(/row\('frame', '分享当前画面'/.test(HTML) && /key === 'frame'\) \{\s*this\.shareFrame\(\);/.test(HTML), '手机齿轮菜单有「分享当前画面」行');
    ok(/class="dplayer-icon dplayer-frame-icon"/.test(HTML) && /camBtn\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); this\.shareFrame\(\); \}\)/.test(HTML), '桌面控制栏相机图标');
    ok(/#dplayer \.dplayer-icons \.dplayer-frame-icon,/.test(HTML), '手机端控制栏不显示相机图标(只留 4 个大按钮)');
    ok(/class="player-box"[^>]*:class="\{ 'dg-no-frame': previewLocked \|\| currentGroup\._isLive \}"/.test(HTML), '直播 / 未登录预览给 player-box 打 dg-no-frame');
    ok(/\.player-box\.dg-no-frame #dplayer \.dplayer-frame-icon,\s*\n\s*\.player-box\.dg-no-frame #dplayer \.dg-mob-row\[data-dg="frame"\] \{ display:none !important; \}/.test(HTML), 'dg-no-frame 把两个入口都藏掉(!important 压过手机行的 display:flex !important)');
    ok(!/<script[^>]+qrcode-generator/.test(HTML), '二维码库不在首屏 <script> 里(按需加载)');
    ok(/-webkit-touch-callout:default !important/.test(HTML.slice(HTML.indexOf('.fshare-img'), HTML.indexOf('.fshare-img') + 400)), '卡片图片打开长按菜单(body 全局关了 touch-callout)');
    ok(/v-if="frameShare\.canFiles"/.test(HTML), '「分享…」只在能分享文件时显示');
    ok(/if \(this\.frameShare && this\.frameShare\.show\) \{ this\.closeFrameShare\(\); return; \}/.test(methodSrc('closeDetail').body), '关播放页(返回键)时弹窗开着:先只关弹窗');
    const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
    ok(/const CACHE_VERSION = 'v39'/.test(sw), 'sw.js 升到 v39');
    ok(sw.includes("'./libs/js/qrcode-generator.min.js?v=2.0.4'"), 'sw.js 预缓存二维码库(与页面同一个 ?v=)');
    ok(/s\.src = 'libs\/js\/qrcode-generator\.min\.js\?v=2\.0\.4'/.test(HTML), '页面按需加载的 ?v= 与预缓存一致');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok(!JSON.stringify(pkg).includes('qrcode'), 'package.json 没加 qrcode 依赖(vendored)');
}

console.log(`\n${fail ? '✗' : '✓'} frame-share: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
