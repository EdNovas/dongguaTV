'use strict';
// [adult] TG 帖子"是不是同一部片"的纯函数(无 IO,writer.js 用,scripts/tg-test.mjs 单测)。
//
//   同一个文件:字节数 + 时长(秒)完全一样(转发 / 原样重发都是同一个文件)。
//     同一个频道里重发的 → 只留消息号最小的那条;别的频道里的 → 并进同一部作品,多一条线路。
//   不同频道、重新上传过的(大小不同):片名很像 + 时长差 ≤1 秒 才并(similarTitle):
//     · 双方片名去掉消息号 / "标题:" / 标点之后,短的那个 ≥8 个字,且它的两字片段 ≥80% 出现在长的那个里
//       (常见是一边把另一边的片名截短了 / 前面加了博主名);
//     · 数字对不上(1V / 2V、第一部 / 第二部)不并 —— 定长切开的上下集时长一样、片名几乎一样;
//     · 只有 #标签 的帖子(片名是标签拼的,很多不同视频一样)不参与:调用方只拿有正文的帖子来找(captionOk)。
//   实测(18 个频道 3.1 万条重放):相似度 ≥0.8 的样例全是同一部片;0.5~0.7 开始混进"伪娘户外露出"这种泛标题的不同视频。

const LABEL_RE = /^(?:标题|標題|片名|名称|名稱|视频名称|視頻名稱|title)\s*[:：]\s*/i;
const MSGNO_RE = /\s*#\d{1,12}\s*$/;
const PART_RE = /第\s*([一二三四五六七八九十两百\d]+)\s*(?:部分|部|集|期|章|回|篇|季|弹|彈|场|場|段|话|話)|([上中下])\s*(?:部|集|篇)|\b(?:part|pt|ep|vol)\s*\.?\s*(\d+)/giu;
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

// 展示用:去掉片名末尾的消息号(相册 / 纯标签帖子为了不和同组别的视频并成一部才带的,观众看了没意义)
function stripMsgNo(name) { return String(name == null ? '' : name).replace(MSGNO_RE, '').trim(); }
// 去掉开头的"标题:"这类标签
function stripLabel(name) { return String(name == null ? '' : name).replace(LABEL_RE, '').trim(); }

function normTitle(name) {
    return stripLabel(stripMsgNo(String(name == null ? '' : name).normalize('NFKC'))).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
// 片段:中日韩字两两一段,英文 / 数字整个词一段("浴室play浴室play" 只有 {浴室, play} 两段,不算描述性片名)
function tokenSet(s) {
    const out = new Set();
    for (const m of s.match(/[a-z0-9]+|[^a-z0-9]+/g) || []) {
        if (/^[a-z0-9]/.test(m)) { out.add(m); continue; }
        const c = [...m];
        if (c.length === 1) out.add(c[0]);
        for (let i = 0; i + 1 < c.length; i++) out.add(c[i] + c[i + 1]);
    }
    return out;
}
function cnToNum(x) {
    if (/^\d+$/.test(x)) return Number(x);
    if (x.length === 1 && CN_NUM[x] != null) return CN_NUM[x];
    if (x === '十') return 10;
    const m = /^([一二三四五六七八九两])?十([一二三四五六七八九])?$/.exec(x);
    if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
    return x;
}
function partOf(s) {
    const out = [];
    for (const m of String(s).normalize('NFKC').matchAll(PART_RE)) out.push(String(m[1] ? cnToNum(m[1]) : m[2] ? ({ 上: 1, 中: 2, 下: 3 })[m[2]] : Number(m[3])));
    return out.join(',');
}
const digitsOf = (n) => (n.match(/\d+/g) || []).map((d) => String(Number(d)));
// 有正文的配文(和 lib/adult/tg.js MIN_TEXT 同口径:≥4 个中日韩字或 ≥3 个英文词)—— 只拿这种帖子做模糊匹配
function captionOk(text) {
    const s = String(text == null ? '' : text);
    return (s.match(/[㐀-鿿぀-ヿ가-힯]/g) || []).length >= 4 || (s.match(/[A-Za-z]{2,}/g) || []).length >= 3;
}

// 片名像不像同一部:像 → 相似度(0.8~1),不像 → 0
function similarTitle(a, b) {
    const na = normTitle(a), nb = normTitle(b);
    if (!na || !nb) return 0;
    const ta = tokenSet(na), tb = tokenSet(nb);
    const [s, l, bs, bl] = ta.size <= tb.size ? [na, nb, ta, tb] : [nb, na, tb, ta];
    if (bs.size < 7) return 0;   // 短的那个至少 7 段(约 8 个字):"伪娘户外露出"这种泛标题不参与
    // 数字:短的那个里的每个数都要在长的里出现(长的多出来的可以是博主名 / 年份)
    const dl = digitsOf(l);
    for (const d of digitsOf(s)) { const i = dl.indexOf(d); if (i < 0) return 0; dl.splice(i, 1); }
    const pa = partOf(a), pb = partOf(b);
    if (pa && pb && pa !== pb) return 0;
    if (s === l) return 1;
    let hit = 0;
    for (const x of bs) if (bl.has(x)) hit++;
    const r = bs.size ? hit / bs.size : 0;
    return r >= 0.8 ? r : 0;
}

module.exports = { stripMsgNo, stripLabel, normTitle, similarTitle, captionOk, partOf };
