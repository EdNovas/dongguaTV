#!/usr/bin/env node
// iOS / iPadOS 新弹幕先在右边闪一下(录屏:新弹幕贴着右边完整显示一两帧,再跳回屏幕外开始滚)回归(离线、零网络):
//   node scripts/danmaku-flash-test.mjs
//  ① DPlayer.min.js 还是修补时的那套:right:0 + translateX(100%) 起步,draw 写行内宽度和 translateX(-容器宽px),
//     内部用 this.draw 调(DPlayer 升级改了这些,dmPixelStart 就对不上,这里先报)
//  ② <dg-dm-px-core> 在沙箱里真跑:只改这一批新画的滚动弹幕,终点改成 -(容器宽 + 弹幕宽),打 data-dgpx;
//     顶部 / 底部弹幕、之前就在的弹幕、读不出数的不动;只装一次;原 draw 的 this / 参数 / 返回值照传
//  ③ 改前改后每个时刻的位置一样(路线、速度不变);"没套上动画"的那一帧,改前贴着右边完整显示,改后都在屏幕外
//  ④ 样式与接线:[data-dgpx] 用 left:100% 起步、dg-danmaku 关键帧只有像素;新建播放器时装上
// 改弹幕样式、换 DPlayer 版本后必跑。
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
    ok(DPJS.includes('.dplayer-danmaku .dplayer-danmaku-right{position:absolute;right:0;transform:translateX(100%)}'), '滚动弹幕 right:0 定位、静止时 translateX(100%)');
    ok(DPJS.includes('@keyframes danmaku{0%{transform:translateX(100%)}}'), '动画从 translateX(100%) 起步,终点取行内 transform');
    ok(/n=this\.container\.offsetWidth/.test(DPJS) && DPJS.includes('i.style.width=l+1+"px"') && DPJS.includes('i.style.transform="translateX(-".concat(n,"px)")'),
        'draw 写行内宽度 + translateX(-容器宽px)');
    ok(DPJS.includes('i.classList.add("dplayer-danmaku-move"),p.appendChild(i)') && DPJS.includes('this.container.appendChild(p),p'), '一批弹幕先进 fragment,再整批追加到容器末尾');
    ok((DPJS.match(/this\.draw\(/g) || []).length === 2 && !/[^.]\bdraw\(/.test(DPJS.replace(/this\.draw\(/g, '')), '内部只用 this.draw(逐帧画 / 发弹幕),换掉实例上的 draw 就都走包装');
}

const coreM = /\/\/ <dg-dm-px-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-dm-px-core>/.exec(HTML);
if (!coreM) { console.log('✗ index.html 里找不到 <dg-dm-px-core> 段'); process.exit(1); }
const dmPixelStart = vm.runInNewContext(coreM[1] + '\n;dmPixelStart;', { parseFloat });

// 假 DOM:够 dmPixelStart 用的那几样
class El {
    constructor(cls, style) { this.cls = new Set(cls.split(' ')); this.style = Object.assign({}, style); this.attrs = {}; this.parent = null; }
    get classList() { return { contains: c => this.cls.has(c) }; }
    setAttribute(k, v) { this.attrs[k] = v; }
    get nextElementSibling() { const s = this.parent.kids; return s[s.indexOf(this) + 1] || null; }
}
class Box {
    constructor() { this.kids = []; }
    get firstElementChild() { return this.kids[0] || null; }
    get lastElementChild() { return this.kids[this.kids.length - 1] || null; }
    add(el) { el.parent = this; this.kids.push(el); return el; }
}
const CW = 1180;
// 照 DPlayer 的 draw:滚动弹幕写宽度(文字宽 + 1)、top、translateX(-容器宽px);顶部 / 底部只写 top / bottom
const fakeDanmaku = (box, cw = CW) => {
    const calls = [];
    return {
        container: box, calls,
        draw(list) {
            calls.push({ self: this, args: [...arguments] });
            for (const d of [].concat(list)) {
                const style = d.type === 'right' ? { width: d.w + 1 + 'px', top: '0px', transform: 'translateX(-' + cw + 'px)' } : { top: '0px' };
                box.add(new El('dplayer-danmaku-item dplayer-danmaku-' + d.type + ' dplayer-danmaku-move', style));
            }
            return 'frag';
        },
    };
};
const tx = el => { const m = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform || ''); return m ? +m[1] : null; };

console.log('② 只改新画的那批滚动弹幕');
{
    const box = new Box();
    box.add(new El('dplayer-danmaku-item dplayer-danmaku-item--demo', {}));
    const old = box.add(new El('dplayer-danmaku-item dplayer-danmaku-right dplayer-danmaku-move', { width: '61px', transform: 'translateX(-' + CW + 'px)' }));
    const dm = fakeDanmaku(box);
    const player = { danmaku: dm };
    ok(dmPixelStart(player) === true && dmPixelStart(player) === false, '装上返回 true;再装一次不重复包');
    const ret = dm.draw([{ type: 'right', w: 99 }, { type: 'top' }, { type: 'right', w: 49.5 }], 'x');
    const [a, top, b] = box.kids.slice(2);
    ok(ret === 'frag' && dm.calls.length === 1 && dm.calls[0].self === dm && dm.calls[0].args[1] === 'x', '原 draw 的 this、参数、返回值照传');
    ok(tx(a) === -(CW + 100) && tx(b) === -(CW + 50.5) && 'data-dgpx' in a.attrs && 'data-dgpx' in b.attrs, '新的滚动弹幕:终点 = -(容器宽 + 弹幕宽),打上 data-dgpx', [a.style.transform, b.style.transform]);
    ok(!('data-dgpx' in top.attrs) && top.style.transform === undefined, '顶部弹幕不动(它不滚,也不闪)');
    ok(!('data-dgpx' in old.attrs) && tx(old) === -CW, '包装之前就在屏幕上的弹幕不动(正滚到一半,一改就会跳)');
    dm.draw([{ type: 'right', w: 30 }]);
    ok(tx(box.kids[5]) === -(CW + 31) && tx(a) === -(CW + 100), '下一批只改新的,已经改过的不再叠加');

    const empty = new Box();
    const dm2 = fakeDanmaku(empty);
    dmPixelStart({ danmaku: dm2 });
    dm2.draw([{ type: 'right', w: 9 }]);
    ok(tx(empty.kids[0]) === -(CW + 10), '容器原本是空的(没有 demo 元素)也照样改');

    const zero = new Box();
    const dm3 = fakeDanmaku(zero, 0);
    dmPixelStart({ danmaku: dm3 });
    dm3.draw([{ type: 'right', w: 9 }]);
    ok(!('data-dgpx' in zero.kids[0].attrs) && zero.kids[0].style.transform === 'translateX(-0px)', '读不出容器宽(播放器藏着,宽 0)→ 不动,照 DPlayer 原样');

    ok(dmPixelStart(null) === false && dmPixelStart({}) === false && dmPixelStart({ danmaku: {} }) === false, '没有弹幕模块 → 什么都不做');
}

console.log('③ 路线不变,没套上动画的那一帧在屏幕外');
{
    // p = 动画进度 0..1;x = 弹幕左边缘相对容器左边的位置;容器可见范围 [0, cw]
    const before = (cw, w, p) => (cw - w) + (w + p * (-cw - w));   // right:0,translateX(100%) → translateX(-cw)
    const after = (cw, w, p) => cw + p * -(cw + w);                 // left:100%,translateX(0) → translateX(-(cw + w))
    let same = true;
    for (const cw of [320, 744, 1180, 2560]) for (const w of [12, 100, 401.5]) for (let p = 0; p <= 1; p += 0.05) if (Math.abs(before(cw, w, p) - after(cw, w, p)) > 1e-9) same = false;
    ok(same, '每个时刻的位置都一样:路线、速度、什么时候出屏都不变');
    const visible = (x, w, cw) => x < cw && x + w > 0;
    const cw = 1180, w = 120;
    ok(visible(cw - w, w, cw), '改前:没套上动画、transform:none 时贴着右边完整显示(录屏里闪的那一下)');
    ok(!visible(cw, w, cw), '改后:transform:none 时在右边屏幕外');
    ok(!visible(cw - (cw + w), w, cw), '改后:停在终点(行内 transform)时在左边屏幕外');
}

console.log('④ 样式与接线');
{
    ok(/#dplayer \.dplayer-danmaku \.dplayer-danmaku-right\[data-dgpx\] \{\s*right: auto;\s*left: 100%;\s*\}/.test(HTML), '[data-dgpx] 从 left:100%(右边屏幕外)起步');
    ok(/#dplayer \.dplayer-danmaku \.dplayer-danmaku-right\.dplayer-danmaku-move\[data-dgpx\] \{\s*animation-name: dg-danmaku !important;\s*\}/.test(HTML),
        '换成 dg-danmaku 动画(!important 压过 DPlayer 全屏时的 animation 简写)');
    const kf = /@keyframes dg-danmaku \{([\s\S]*?)\n\s*\}/.exec(HTML);
    ok(!!kf && /from \{ transform: translateX\(0\); \}/.test(kf[1]) && !/%\)/.test(kf[1]), 'dg-danmaku 只有像素位移(不靠百分比,不依赖元素宽度有没有算出来)', kf && kf[1]);
    ok(/#dplayer \.dplayer-danmaku \.dplayer-danmaku-item\.dplayer-danmaku-move \{\s*animation-duration: var\(--dm-dur, 8s\) !important;/.test(HTML), '弹幕速度设置照样作用在改过的弹幕上');
    ok((HTML.match(/new DPlayer\(/g) || []).length === 1, '只有一处新建播放器');
    const create = HTML.slice(HTML.indexOf('dp = new DPlayer({'), HTML.indexOf('// ========== 🔧 设置菜单修复 =========='));
    ok(/\n\s*dmPixelStart\(dp\);/.test(create), '新建播放器(含先看直播后重建)时装上');
}

console.log(fail ? `\nFAILED: ${pass} passed, ${fail} failed` : `\nALL PASSED: ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
