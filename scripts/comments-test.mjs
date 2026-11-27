// 评论 + 用户弹幕回归:node scripts/comments-test.mjs(worktree 没有 node_modules 时带 NODE_PATH)
//  ① public/libs/js/ucomm-key.js:epKey 与 index.html 的 _danmakuKey(去掉"剧名|")逐条一致;电影 'm';showKey 括号/作品签名;parseDmId
//  ② lib/comments(SQLite 内存库):登录闸门(非同步账号/封禁)、跨线路同一集、时间原样、HTML 转义、长度、屏蔽词/网址/联系方式、
//     限速/每日上限/10 分钟同话、reviewText(hold 只作者可见 / reject / 抛错与超时放行)、封禁后别人看不到;
//     评论 发/回复(一层)/点赞开关/举报 3 次自动收起/最新最热/删自己的;评论区弹幕页;站长 列表/筛选/隐藏/恢复/删除/屏蔽词
//  ②b AI 审核(createAiReviewer + 假 Workers AI):ok / hold / block 映射、回答解析、超时 / 出错 / 额度 / 看不懂 → 放行、
//     10 分钟缓存(超时晚到的答案也记)、同时来的合并、≤3 字和单字重复不问、每分钟 / 每天上限、站长选的模型现取、
//     接进 createComments(block 拒收不进库、hold 存原因给后台看、屏蔽词先拦不问 AI)、老库补 review_note 列、server.js 接线
//  ③ 路由:express 真 HTTP —— /api/udanmaku/v3/ GET 是 DPlayer v3 格式、POST 回 code;配了访问密码时读要令牌
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };
const Database = dep('better-sqlite3');
const express = dep('express');
const K = require(path.join(ROOT, 'public/libs/js/ucomm-key.js'));
const { createComments, normMatch, hasLink, createAiReviewer, parseVerdict, REVIEW_SYS, REVIEW_MODEL } = require(path.join(ROOT, 'lib/comments'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 400) : '')); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------- ① 键 ----------------
{
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const i = html.indexOf('                _danmakuKey() {');
    const j = html.indexOf('\n                },', i);
    ok(i > 0 && j > i, '找到 index.html 的 _danmakuKey');
    const body = html.slice(html.indexOf('{', i) + 1, j);
    const fn = new Function(body);
    const dk = (name) => fn.call({ currentGroup: { name: '剧' }, episodeList: [{ name, url: 'u' }], currentUrl: 'u' }).slice(2);
    const NAMES = ['第1集', '第01集', '01', '1', 'EP1', 'ep.01', '第6集', '第06集', '06', '第12话', '第1期上', '第1期(上)', '第1期-下', '第5期下纯享', 'EP5上',
        '第20261010期', '20261010', '2026-10-10', '2026年10月10日', '第20261010期捣蛋', '第0624期', '第624期', 'HD中字', '正片', '高清', '幕后黑手', '第3集 兵临城下',
        '第100集', '第1000集', '第0001集', '大结局', 'TC抢先版', '第2集plus', '第8期加更', '第8期 特辑', '番外1', 'SP'];
    for (const n of NAMES) ok(K.epKey(n, 30) === dk(n), 'epKey 与 _danmakuKey 一致: ' + n, [K.epKey(n, 30), dk(n)]);
    ok(K.epKey('第06集') === K.epKey('6') && K.epKey('EP6') === '6', '跨线路写法同一集');
    ok(K.epKey('HD中字', 1) === 'm' && K.epKey('正片', 1) === 'm' && K.epKey('第1集', 1) === '1', '电影(只有一集、没集号)= m');
    ok(K.epKey('HD中字', 2) === 'HD中字', '不是单集的照原名');
    ok(K.showKey('庆余年 (第二季)') === K.showKey('庆余年第二季') && K.showKey('庆余年第二季') !== K.showKey('庆余年'), 'showKey 括号去掉、季不丢');
    ok(K.showKey('Ｔｈｅ　Ｏｆｆｉｃｅ') === K.showKey('the office'), 'showKey 全角/大小写/空格');
    ok(K.showKey('倚天屠龙记', 'y2003t') === '倚天屠龙记|y2003t' && K.showKey('倚天屠龙记', '') === '倚天屠龙记' && K.showKey('倚天屠龙记', 'a b') === '倚天屠龙记', 'showKey 作品签名只收字母数字');
    const p = K.parseDmId('剧名|第3集|v5|k:tv|y:2024|n:36');
    ok(p.title === '剧名' && p.ep === '第3集' && p.n === 36, 'parseDmId', p);
    ok(K.epText('3', '第03集') === '第3集' && K.epText('m', 'HD') === '' && K.epText('20261010|', '第20261010期') === '第20261010期' && K.epText('1上', '第1期上') === '第1集上', 'epText', [K.epText('1上', '第1期上')]);
    ok(K.clock(754) === '12:34' && K.clock(3725) === '1:02:05', 'clock');
    ok(normMatch('加 微-信') === '加微信' && hasLink('看 www.x.com') && hasLink('abc.top') && !hasLink('第3.5集好看'), '屏蔽词归一 / 网址');
}

// ---------------- ② lib ----------------
function mkDb() {
    const d = new Database(':memory:');
    d.exec('CREATE TABLE user_stats (user_token TEXT PRIMARY KEY, label TEXT, first_seen INTEGER, last_login INTEGER, last_active INTEGER, banned INTEGER DEFAULT 0, banned_at INTEGER)');
    return d;
}
const TOK = { a: 'v2board_' + 'a'.repeat(64), b: 'v2board_' + 'b'.repeat(64), c: 'c'.repeat(64), d: 'd'.repeat(64), e: 'e'.repeat(64), nosync: 'f'.repeat(64) };
const INFO = Object.create(null);
for (const k of Object.keys(TOK)) INFO[TOK[k]] = { syncEnabled: k !== 'nosync' };
function mk(d, extra) {
    return createComments(Object.assign({
        db: () => d,
        authRequired: () => false,
        tokenOk: (t) => Object.prototype.hasOwnProperty.call(INFO, t),
        tokenInfo: (t) => INFO[t] || null,
        isBanned: (t) => { const r = d.prepare('SELECT banned FROM user_stats WHERE user_token = ?').get(t); return !!(r && r.banned); },
        adminAuthed: (req) => req.headers['x-admin-token'] === 'adm',
        identity: (t, label) => label || ('id:' + t.slice(0, 10)),
        opts: { dmRate: [[1, 1000]], cmRate: [[1, 1000]] }   // 机制测试:短窗口限速放开(另有专门的限速用例)
    }, extra || {}));
}
const ID = (title, ep, n) => encodeURIComponent(title + '|' + ep + '|v5|k:tv|y:2024|n:' + (n || 30));

{
    const d = mkDb(), c = mk(d);
    ok(c.enabled(), 'enabled');
    // 登录闸门
    let r = await c.postDanmaku({ token: 'nope', id: ID('剧A', '第1集'), time: 10, text: 'hi' });
    ok(r.status === 401, '无效令牌不能发', r);
    r = await c.postDanmaku({ token: TOK.nosync, id: ID('剧A', '第1集'), time: 10, text: 'hi' });
    ok(r.status === 401, '非同步账号不能发', r);
    // 发 → 另一条线路(集名写法不同)同一集拿得到,时间原样
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第06集'), time: 754.36, text: '<b>前方高能</b>', color: 0xe54256, type: 1 });
    ok(r.ok && r.id > 0, '同步账号发弹幕', r);
    const got = c.episodeDanmaku(K.showKey('剧A'), K.epKey('6', 30), '');
    ok(got.length === 1 && got[0][0] === 754.4 && got[0][1] === 1 && got[0][2] === 0xe54256 && got[0][4] === '&lt;b&gt;前方高能&lt;/b&gt;', '跨线路同一集 + 时间原样 + 转义', got);
    ok(c.episodeDanmaku(K.showKey('剧A'), K.epKey('第7集', 30), '').length === 0, '别的集没有');
    ok(c.episodeDanmaku(K.showKey('剧A', 'y1999t'), K.epKey('6', 30), '').length === 0, '同名的另一部作品(签名不同)没有');
    // 内容检查
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第1集'), time: 1, text: '   ' }); ok(r.error === 'empty', '空的不收');
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第1集'), time: 1, text: '加 微 信 abc' }); ok(r.error === 'word', '屏蔽词(带空格)', r);
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第1集'), time: 1, text: '去 abc.com 看' }); ok(r.error === 'word' && /网址/.test(r.msg), '网址不收', r);
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第1集'), time: 1, text: '扣我 1234 5678 90' }); ok(r.error === 'word' && /联系方式/.test(r.msg), '长串数字不收', r);
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第1集'), time: -5, text: 'x' }); ok(r.error === 'bad', '负时间不收');
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第1集'), time: 2, text: 'x'.repeat(200), color: 'red', type: 9 });
    const long = c.episodeDanmaku(K.showKey('剧A'), '1', '');
    ok(r.ok && long[0][4].length === 40 && long[0][2] === 0xffffff && long[0][1] === 0, '长度截断 / 颜色类型回默认', long[0]);
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第1集'), time: 50, text: 'x'.repeat(200) }); ok(r.error === 'dup', '10 分钟内同样的话不收', r);
    // 屏蔽词站长可改
    c.setWords(['剧透狗', '剧透狗', '  ']);
    ok(JSON.stringify(c.getWords().words) === '["剧透狗"]', '屏蔽词去重去空', c.getWords());
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第1集'), time: 3, text: '加微信' }); ok(r.ok, '删掉的词不再拦');
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧A', '第1集'), time: 3, text: '剧 透 狗滚' }); ok(r.error === 'word', '新加的词立刻生效');
    // 封禁:不能发、发过的别人看不到;解封回来
    d.prepare('INSERT INTO user_stats (user_token, banned) VALUES (?, 1)').run(TOK.b);
    r = await c.postDanmaku({ token: TOK.b, id: ID('剧A', '第06集'), time: 9, text: 'banned' }); ok(r.status === 403, '封禁的不能发');
    d.prepare('UPDATE user_stats SET banned = 0 WHERE user_token = ?').run(TOK.b);
    r = await c.postDanmaku({ token: TOK.b, id: ID('剧A', '第06集'), time: 9, text: '我是b' }); ok(r.ok, '解封后能发');
    d.prepare('UPDATE user_stats SET banned = 1 WHERE user_token = ?').run(TOK.b);
    ok(c.episodeDanmaku(K.showKey('剧A'), '6', TOK.a).length === 1, '封禁后他发过的别人看不到');
    d.prepare('UPDATE user_stats SET banned = 0 WHERE user_token = ?').run(TOK.b);
    ok(c.episodeDanmaku(K.showKey('剧A'), '6', TOK.a).length === 2, '解封后回来');
    // 评论区弹幕页
    const sd = c.showDanmaku(K.showKey('剧A'), TOK.b, 1);
    ok(sd.total >= 4 && sd.items[0].text === '我是b' && sd.items[0].mine && sd.items[0].ep === '第6集' && sd.items[0].nick.startsWith('观众') && !('token' in sd.items[0]), '评论区弹幕页', sd.items[0]);
    ok(!JSON.stringify(sd).includes(TOK.b), '不出令牌');
}

// 限速 / 每日上限 / reviewText
{
    const d = mkDb();
    const c = mk(d, { opts: { dmRate: [[60e3, 2]], cmRate: [[60e3, 1]], dmPerDay: 3 } });
    let r1 = await c.postDanmaku({ token: TOK.a, id: ID('剧B', '1'), time: 1, text: 'a1' });
    let r2 = await c.postDanmaku({ token: TOK.a, id: ID('剧B', '1'), time: 2, text: 'a2' });
    let r3 = await c.postDanmaku({ token: TOK.a, id: ID('剧B', '1'), time: 3, text: 'a3' });
    ok(r1.ok && r2.ok && r3.error === 'rate', '短窗口限速', r3);
    const c2 = mk(d, { opts: { dmRate: [[1, 1000]], dmPerDay: 3 } });
    r1 = await c2.postDanmaku({ token: TOK.a, id: ID('剧B', '1'), time: 4, text: 'a4' });
    r2 = await c2.postDanmaku({ token: TOK.a, id: ID('剧B', '1'), time: 5, text: 'a5' });
    ok(r1.ok && r2.error === 'day', '每日上限按库里现数(换实例也算)', r2);
    let c1 = await c.postComment({ token: TOK.c, title: '剧B', text: '第一条' });
    let c1b = await c.postComment({ token: TOK.c, title: '剧B', text: '第二条' });
    ok(c1.ok && c1b.error === 'rate', '评论限速', c1b);

    const seen = [];
    const cr = mk(mkDb(), {
        reviewText: async (text, ctx) => {
            seen.push(ctx.kind);
            if (text.includes('拒')) return { action: 'reject' };
            if (text.includes('扣')) return { action: 'hold' };
            if (text.includes('炸')) throw new Error('boom');
            if (text.includes('慢')) { await sleep(300); return { action: 'reject' }; }
            return { action: 'allow' };
        },
        opts: { dmRate: [[1, 1000]], cmRate: [[1, 1000]], reviewTimeoutMs: 100 }
    });
    let r = await cr.postDanmaku({ token: TOK.a, id: ID('剧C', '1'), time: 1, text: '拒绝我' }); ok(r.error === 'review', 'review reject', r);
    r = await cr.postDanmaku({ token: TOK.a, id: ID('剧C', '1'), time: 1, text: '扣下' }); ok(r.ok && r.held, 'review hold');
    ok(cr.episodeDanmaku(K.showKey('剧C'), '1', TOK.d).length === 0 && cr.episodeDanmaku(K.showKey('剧C'), '1', TOK.a).length === 1, 'hold 只作者自己看得见');
    r = await cr.postDanmaku({ token: TOK.a, id: ID('剧C', '1'), time: 1, text: '炸了' }); ok(r.ok && !r.held, 'review 抛错放行');
    r = await cr.postDanmaku({ token: TOK.a, id: ID('剧C', '1'), time: 1, text: '慢慢来' }); ok(r.ok, 'review 超时放行');
    r = await cr.postComment({ token: TOK.a, title: '剧C', text: '扣住的评论' });
    ok(r.ok && r.held && r.item.hidden, '评论 hold');
    ok(cr.listComments(K.showKey('剧C'), TOK.d, 'new', 1).total === 0 && cr.listComments(K.showKey('剧C'), TOK.a, 'new', 1).total === 1, '评论 hold 只作者可见');
    ok(seen.includes('danmaku') && seen.includes('comment'), 'review ctx.kind');
}

// ---------------- ②b AI 审核 ----------------
{
    // 回答解析
    const C = (s) => ({ choices: [{ message: { content: s } }] });
    let v = parseVerdict({ response: '{"verdict":"block","reason":"赌博"}' });
    ok(v && v.action === 'reject' && v.reason === '赌博', '老式 response 字段 + block → reject', v);
    v = parseVerdict(C('hold'));
    ok(v && v.action === 'hold' && v.reason === '拿不准', '只回一个词也认;hold 没给原因 → 拿不准', v);
    v = parseVerdict({ response: { verdict: 'OK' } });
    ok(v && v.action === 'allow' && v.reason === '', 'response 是对象 / 大小写', v);
    v = parseVerdict(C('<think>要不要 block 呢</think>\n```json\n{"verdict":"ok"}\n```'));
    ok(v && v.action === 'allow', '去掉 <think> 和 ``` 围栏', v);
    ok(parseVerdict(C('{"verdict":"ok 或 hold 或 block"}')) === null && parseVerdict(C('我觉得还行')) === null && parseVerdict(null) === null, '照抄模板 / 不是 JSON / 空 → 看不懂(null)');
    ok(parseVerdict(C('{"verdict":"block","reason":"' + '很长的原因'.repeat(20) + '"}')).reason.length === 30, '原因截到 30 字');

    let clock = Date.UTC(2026, 10, 26, 4, 0);
    const runs = [];
    const reply = (o) => C(typeof o === 'string' ? o : JSON.stringify(o));
    const fakeAi = {
        run: async (model, body, ro) => {
            runs.push({ model, body, ro });
            const m = /<<<([\s\S]*)>>>$/.exec(body.messages[1].content), text = m ? m[1] : '';
            if (text.includes('广告')) return reply({ verdict: 'block', reason: '广告引流' });
            if (text.includes('骂人')) return reply('```json\n{"verdict":"hold","reason":"人身攻击"}\n```');
            if (text.includes('超时')) { await sleep(150); return reply({ verdict: 'block', reason: '晚到' }); }
            if (text.includes('炸了')) throw Object.assign(new Error('HTTP 500'), { status: 500 });
            if (text.includes('额度')) throw Object.assign(new Error('今天的 AI 调用次数用完了'), { code: 'quota' });
            if (text.includes('乱答')) return reply('我觉得还行吧');
            if (text.includes('同时')) await sleep(20);
            return reply({ verdict: 'ok', reason: '' });
        }
    };
    let on = true;
    const logs = [];
    const G47 = '@cf/zai-org/glm-4.7-flash';
    let model = () => ({ id: G47, extra: { chat_template_kwargs: { enable_thinking: false } }, maxTokens: 700 });
    const R = createAiReviewer({ ai: fakeAi, model: () => model(), enabled: () => on, now: () => clock, log: (m) => logs.push(m), opts: { timeoutMs: 60 } });
    const ctx = { kind: 'danmaku', title: '剧F', token: TOK.a };
    let r = await R.review('这集真好看啊', ctx);
    ok(r.action === 'allow' && runs.length === 1, 'ok → allow', r);
    const b = runs[0].body;
    ok(runs[0].model === G47 && b.messages[0].content === REVIEW_SYS && b.messages[1].content === '弹幕(剧:《剧F》):\n<<<这集真好看啊>>>' && b.temperature === 0 && b.max_tokens === 200
        && b.chat_template_kwargs.enable_thinking === false && runs[0].ro.timeoutMs === 60, '请求:站长选的模型 + 它的调用参数、审核提示词、内容放 <<< >>> 里、不思考的给 200 token、4 秒级超时', { model: runs[0].model, b, ro: runs[0].ro });
    ok(/广告引流/.test(REVIEW_SYS) && /剧透/.test(REVIEW_SYS) && /"verdict"/.test(REVIEW_SYS), '提示词:要 JSON、列了 block 的几类、剧透算 ok');
    r = await R.review('看广告领红包', ctx);
    ok(r.action === 'reject' && r.reason === '广告引流', 'block → reject + 原因', r);
    r = await R.review('你这个骂人的家伙', { kind: 'comment', title: '剧F', token: TOK.b });
    ok(r.action === 'hold' && r.reason === '人身攻击' && /^评论\(剧:《剧F》\):/.test(runs[runs.length - 1].body.messages[1].content), 'hold(带 ``` 围栏)→ hold + 原因', r);
    const n0 = runs.length;
    for (const t of ['回答乱答的', '服务器炸了吗', '额度没了吗']) ok((await R.review(t, ctx)).action === 'allow', '放行:' + t);
    ok(runs.length === n0 + 3 && R.status().today.failed === 3, '看不懂 / 出错 / 额度用完 → 放行、记失败', R.status().today);
    ok(logs.some(m => /放行/.test(m)), '失败会记日志', logs);
    // 超时:先放行;晚到的答案进缓存,下一条同样的话直接用(不再问)
    const t0 = Date.now();
    r = await R.review('这条会超时', ctx);
    ok(r.action === 'allow' && Date.now() - t0 < 140 && R.status().today.failed === 4, '超时 → 放行(不等 AI)', [r, Date.now() - t0]);
    await sleep(200);
    const n1 = runs.length;
    r = await R.review('这条会超时', ctx);
    ok(r.action === 'reject' && r.reason === '晚到' && runs.length === n1, '超时后晚到的答案也记进缓存', r);
    // 缓存:10 分钟内同样的话只问一次;同时来的合并成一次
    r = await R.review('这集真好看啊', ctx);
    ok(r.action === 'allow' && runs.length === n1, '缓存命中不再问');
    r = await R.review('看广告领红包', ctx);
    ok(r.action === 'reject' && runs.length === n1, '缓存里的 block 也照样拒收');
    const [x1, x2] = await Promise.all([R.review('两条同时来的', ctx), R.review('两条同时来的', ctx)]);
    ok(x1.action === 'allow' && x2.action === 'allow' && runs.length === n1 + 1, '同时来的同一句只问一次', runs.length - n1);
    clock += 10 * 60e3 + 1;
    await R.review('这集真好看啊', ctx);
    ok(runs.length === n1 + 2, '过了 10 分钟再问一次');
    // 太短 / 单字重复不问
    const n2 = runs.length, sk0 = R.status().today.skipped;
    for (const t of ['好看啊', '哈哈哈哈哈哈', '6 6 6 6 6', '  ', '前方']) ok((await R.review(t, ctx)).action === 'allow', '不问:' + JSON.stringify(t));
    ok(runs.length === n2 && R.status().today.skipped === sk0 + 5, '≤3 字、同一个字重复的不送 AI', R.status().today);
    await R.review('前方高能', ctx);
    ok(runs.length === n2 + 1, '4 个字就问');
    // 关着(没配 Workers AI)→ 不问
    on = false;
    ok((await R.review('看广告领红包啊', ctx)).action === 'allow' && runs.length === n2 + 1 && R.status().enabled === false, '关着:全部放行、不调用');
    on = true;
    // 模型现取:字符串 / 思考型给够 token / 取不到 → 内置 gemma-4
    model = () => '@cf/qwen/qwen3.8-27b';
    await R.review('换个模型试试', ctx);
    let last = runs[runs.length - 1];
    ok(last.model === '@cf/qwen/qwen3.8-27b' && last.body.max_tokens === 200 && !('chat_template_kwargs' in last.body), '模型名字符串也行');
    model = () => ({ id: '@cf/zai-org/glm-5.3', extra: { reasoning_effort: 'low' }, maxTokens: 3000 });
    await R.review('思考型模型试试', ctx);
    last = runs[runs.length - 1];
    ok(last.model === '@cf/zai-org/glm-5.3' && last.body.reasoning_effort === 'low' && last.body.max_tokens === 3000, '思考关不掉的模型按它的 maxTokens 给');
    model = () => { throw new Error('x'); };
    await R.review('取模型出错了', ctx);
    last = runs[runs.length - 1];
    ok(last.model === REVIEW_MODEL && REVIEW_MODEL === '@cf/google/gemma-4-26b-a4b-it' && last.body.chat_template_kwargs.enable_thinking === false, '取模型出错 → 内置 gemma-4(关思考)');
    model = () => ({ id: '../evil' });
    await R.review('模型名不对呢', ctx);
    ok(runs[runs.length - 1].model === REVIEW_MODEL && R.status().model === REVIEW_MODEL, '模型名不对 → 内置 gemma-4');
    // 状态
    const s = R.status();
    // block 3 次 = 广告(问)+ 超时晚到的(缓存)+ 广告(缓存):用缓存的也算、也进「最近拒收」
    ok(s.enabled && s.perMinute === 120 && s.dailyMax === 0 && s.today.block === 3 && s.today.hold === 1 && s.today.failed === 4 && s.today.asked === runs.length, '状态:今天问了几次、各判了多少', s.today);
    ok(s.recent.length === 3 && s.recent[0].text === '看广告领红包' && s.recent[0].reason === '广告引流' && s.recent[0].token === TOK.a && s.recent[0].kind === 'danmaku' && s.recent[1].text === '这条会超时'
        && s.recent.every(x => x.reason !== '人身攻击'), '最近拒收的,新的在前(hold 的不在这,在库里)', s.recent);
    clock += 86400e3;
    ok(R.status().today.asked === 0 && R.status().today.day !== s.today.day, '过了北京日期计数清零');

    // 每分钟上限 / 每天上限:超了直接放行,不问
    const R2 = createAiReviewer({ ai: fakeAi, now: () => clock, opts: { perMinute: 3 } });
    const m0 = runs.length;
    for (const t of ['第一条评论', '第二条评论', '第三条评论', '第四条评论']) ok((await R2.review(t, {})).action === 'allow', '限流:' + t);
    ok(runs.length === m0 + 3 && R2.status().today.throttled === 1, '每分钟最多 3 次,第 4 条直接放行', R2.status().today);
    await R2.review('第一条评论', {});
    ok(runs.length === m0 + 3, '缓存命中不占名额');
    clock += 60e3;
    await R2.review('第五条评论', {});
    ok(runs.length === m0 + 4, '过了一分钟又能问');
    const R3 = createAiReviewer({ ai: fakeAi, now: () => clock, opts: { dailyMax: 2 } });
    for (const t of ['每天一号', '每天二号', '每天三号']) await R3.review(t, {});
    ok(runs.length === m0 + 6 && R3.status().today.throttled === 1, '每天最多 2 次');
    clock += 86400e3;
    await R3.review('每天三号', {});
    ok(runs.length === m0 + 7, '第二天又能问');

    // 接进 createComments
    const d = mkDb();
    const R4 = createAiReviewer({ ai: fakeAi, now: () => clock });
    const c = mk(d, { reviewText: (t, x) => R4.review(t, x), reviewStatus: () => R4.status() });
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧F', '第1集'), time: 3, text: '看广告领红包' });
    ok(r.error === 'review' && /没通过审核/.test(r.msg) && d.prepare('SELECT COUNT(*) n FROM uc_danmaku').get().n === 0, 'AI block → 拒收,不进库', r);
    r = await c.postComment({ token: TOK.b, title: '剧F', text: '楼上就是骂人的' });
    ok(r.ok && r.held && r.item.hidden, 'AI hold → 收下只给作者看', r);
    ok(c.listComments(K.showKey('剧F'), TOK.c, 'new', 1).total === 0, '别人看不到 hold 的');
    let ad = c.adminList({ kind: 'c', filter: 'hidden' });
    ok(ad.items.length === 1 && ad.items[0].status === 3 && ad.items[0].review === '人身攻击', '后台:hold 的带 AI 给的原因', ad.items[0]);
    ok(ad.review && ad.review.enabled && ad.review.recent.length === 1 && ad.review.recent[0].reason === '广告引流' && ad.review.recent[0].who === 'id:' + TOK.a.slice(0, 10)
        && ad.review.recent[0].nick.startsWith('观众') && ad.review.recent[0].banned === false, '后台:AI 审核状态 + 最近拒收的(带作者是谁)', ad.review);
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧F', '第1集'), time: 4, text: '这集真好看啊' });
    ok(r.ok && !r.held && c.adminList({ kind: 'd' }).items[0].review === '', 'AI ok → 照常发,没有原因');
    const n3 = runs.length;
    r = await c.postDanmaku({ token: TOK.a, id: ID('剧F', '第1集'), time: 5, text: '加 微 信 一起看' });
    ok(r.error === 'word' && runs.length === n3, '屏蔽词先拦下,不送 AI');
    c.adminAction({ kind: 'c', id: ad.items[0].id, action: 'show' });
    ok(c.listComments(K.showKey('剧F'), TOK.c, 'new', 1).total === 1 && c.adminList({ kind: 'c' }).items[0].review === '人身攻击', '站长恢复后大家都看得到,原因留着');
    ok(mk(mkDb()).adminList({ kind: 'c' }).review === null, '没接审核状态 → review: null');
    // 老库(没有 review_note 列)→ 自动补上
    const od = mkDb();
    mk(od).enabled();
    od.exec('ALTER TABLE uc_danmaku DROP COLUMN review_note; ALTER TABLE uc_comments DROP COLUMN review_note;');
    od.prepare("INSERT INTO uc_comments (show_key, title, text, user_token, created_at) VALUES (?, '剧G', '老评论', ?, ?)").run(K.showKey('剧G'), TOK.a, Date.now());
    const oc = mk(od, { reviewText: async () => ({ action: 'hold', reason: '测试' }) });
    r = await oc.postComment({ token: TOK.c, title: '剧G', text: '新评论' });
    const cols = od.prepare('PRAGMA table_info(uc_comments)').all().map(x => x.name);
    ok(r.ok && r.held && cols.includes('review_note') && od.prepare('PRAGMA table_info(uc_danmaku)').all().some(x => x.name === 'review_note'), '老库自动补 review_note 列', cols);
    ok(oc.adminList({ kind: 'c' }).items.map(x => x.review).join() === '测试,', '老评论原因为空、新的有');

    // server.js 接线
    const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('\r\n').join('\n');
    ok(/let commentReviewer = null;\nasync function reviewText\(text, ctx\) \{ return commentReviewer \? commentReviewer\.review\(text, ctx\) : \{ action: 'allow' \}; \}/.test(SERVER), 'server.js:reviewText 交给 commentReviewer,没有就放行');
    ok(/const COMMENT_AI_REVIEW = String\(process\.env\.COMMENT_AI_REVIEW \?\? ''\)\.trim\(\) === '' \|\| envFlag\('COMMENT_AI_REVIEW'\);/.test(SERVER) && /if \(comments && cfAi\.enabled\(\) && COMMENT_AI_REVIEW\) \{/.test(SERVER), 'server.js:配了 Workers AI 默认开,COMMENT_AI_REVIEW=0 关');
    ok(/createAiReviewer\(\{\n\s+ai: cfAi,\n\s+model: \(\) => \(aiModels \? aiModels\.reviewCall\(\) : null\),/.test(SERVER) && /reviewStatus: \(\) => commentReviewer \? commentReviewer\.status\(\)/.test(SERVER), 'server.js:模型从后台现取、状态给后台');
    const envFlag = (v) => { v = String(v ?? '').trim().toLowerCase(); return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'; };
    const on2 = (v) => String(v ?? '').trim() === '' || envFlag(v);
    ok(on2(undefined) && on2('') && on2('1') && on2('true') && !on2('0') && !on2('false') && !on2('off'), 'COMMENT_AI_REVIEW:不填 = 开、0/false/off = 关');
}

// 评论
{
    const d = mkDb(), c = mk(d);
    const sk = K.showKey('剧D');
    const a = await c.postComment({ token: TOK.a, title: '剧D', text: '好看，\n\n\n\n真好看！', ep: '第03集', n: 30 });
    ok(a.ok && a.item.text === '好看，\n\n真好看！' && a.item.ep === '第3集' && a.item.epKey === '3' && a.item.mine, '发评论(带集、换行折叠、全角标点原样)', a);
    const b = await c.postComment({ token: TOK.b, title: '剧D', text: '一般' });
    const r1 = await c.postComment({ token: TOK.b, parent: a.item.id, text: '同意' });
    const r2 = await c.postComment({ token: TOK.c, parent: r1.item.id, text: '回复的回复' });
    ok(r1.ok && r2.ok && r2.item.parent === a.item.id, '回复只有一层(回复的回复挂到顶层)', r2);
    for (const t of [TOK.c, TOK.d, TOK.e]) await c.postComment({ token: t, parent: a.item.id, text: '楼中楼' + t[0] });
    let L = c.listComments(sk, TOK.c, 'new', 1);
    ok(L.total === 2 && L.all === 7 && L.items[0].id === b.item.id, '最新在前 / 顶层数 / 总数', { total: L.total, all: L.all });
    const A = L.items.find(x => x.id === a.item.id);
    ok(A.replyN === 5 && A.replies.length === 3 && A.replies[0].text === '同意', '回复预览 3 条 + 总数', A);
    ok(c.listReplies(a.item.id, '', 0).items.length === 5, '展开全部回复');
    // 点赞开关
    let lk = c.like({ token: TOK.c, id: a.item.id }); ok(lk.ok && lk.liked && lk.likes === 1, '点赞');
    c.like({ token: TOK.d, id: a.item.id });
    lk = c.like({ token: TOK.c, id: a.item.id }); ok(lk.ok && !lk.liked && lk.likes === 1, '再点取消');
    ok(c.like({ token: TOK.nosync, id: a.item.id }).status === 401, '未登录不能赞');
    L = c.listComments(sk, TOK.d, 'hot', 1);
    ok(L.items[0].id === a.item.id && L.items[0].liked && L.items[0].likes === 1, '最热 + 我赞过', L.items[0]);
    // 举报:自己举报自己不算;3 个不同账号 → 自动收起,作者自己还看得见
    c.report({ token: TOK.b, kind: 'c', id: b.item.id });
    c.report({ token: TOK.a, kind: 'c', id: b.item.id });
    c.report({ token: TOK.a, kind: 'c', id: b.item.id });   // 重复不算
    c.report({ token: TOK.c, kind: 'c', id: b.item.id });
    ok(c.listComments(sk, TOK.e, 'new', 1).total === 2, '2 个人举报还在');
    c.report({ token: TOK.d, kind: 'c', id: b.item.id, reason: '<x>' });
    ok(c.listComments(sk, TOK.e, 'new', 1).total === 1, '3 个人举报自动收起');
    const mine = c.listComments(sk, TOK.b, 'new', 1).items.find(x => x.id === b.item.id);
    ok(mine && mine.hidden, '作者自己还看得见(标成收起)');
    // 删自己的
    ok(c.removeOwn({ token: TOK.c, kind: 'c', id: a.item.id }).status === 404, '不能删别人的');
    ok(c.removeOwn({ token: TOK.b, kind: 'c', id: r1.item.id }).ok, '删自己的回复');
    ok(c.listComments(sk, TOK.e, 'new', 1).items[0].replyN === 4, '删回复后回复数跟着变');
    // 站长
    let ad = c.adminList({ kind: 'c', filter: 'reported' });
    ok(ad.total === 1 && ad.items[0].id === b.item.id && ad.items[0].reports === 3 && ad.items[0].status === 2 && ad.items[0].who.startsWith('id:') && ad.items[0].token === TOK.b, '后台:被举报筛选', ad.items[0]);
    ok(ad.counts.c.reported === 1 && ad.counts.c.hidden === 1, '后台计数');
    c.adminAction({ kind: 'c', id: b.item.id, action: 'show' });
    ok(c.listComments(sk, TOK.e, 'new', 1).total === 2 && c.adminList({ kind: 'c', filter: 'reported' }).total === 0, '恢复 = 清掉举报');
    c.report({ token: TOK.e, kind: 'c', id: b.item.id });
    ok(c.listComments(sk, TOK.a, 'new', 1).total === 2, '恢复后再来一个举报不会立刻收起');
    c.adminAction({ kind: 'c', id: a.item.id, action: 'hide' });
    ok(c.listComments(sk, TOK.a, 'new', 1).total === 1, '站长隐藏(作者自己也看不到)');
    ok(c.adminList({ kind: 'c', filter: 'hidden' }).total === 1, '后台:已隐藏筛选');
    c.adminAction({ kind: 'c', ids: [a.item.id], action: 'delete' });
    ok(d.prepare('SELECT COUNT(*) n FROM uc_comments WHERE parent_id = ?').get(a.item.id).n === 0 && d.prepare('SELECT COUNT(*) n FROM uc_likes').get().n === 0, '删顶层连回复和赞一起删');
    ok((await c.postComment({ token: TOK.c, parent: a.item.id, text: 'x' })).status === 404, '回复已删的评论');
    ok(c.adminList({ kind: 'c', q: '一般' }).total === 1, '后台搜索');
    // 弹幕的后台操作
    await c.postDanmaku({ token: TOK.a, id: ID('剧D', '第2集'), time: 5, text: '弹幕一' });
    ad = c.adminList({ kind: 'd' });
    ok(ad.total === 1 && ad.items[0].t === 5 && ad.items[0].ep === '第2集' && ad.items[0].title === '剧D', '后台:弹幕列表', ad.items[0]);
    c.adminAction({ kind: 'd', id: ad.items[0].id, action: 'hide' });
    ok(c.episodeDanmaku(sk, '2', '').length === 0, '后台隐藏弹幕');
    c.adminAction({ kind: 'd', id: ad.items[0].id, action: 'delete' });
    ok(c.adminList({ kind: 'd' }).total === 0, '后台删除弹幕');
}

// ---------------- ③ 路由 ----------------
{
    const d = mkDb();
    let auth = false;
    const c = mk(d, { authRequired: () => auth });
    const app = express();
    app.use(express.json());
    c.registerRoutes(app);
    const srv = app.listen(0);
    const base = 'http://127.0.0.1:' + srv.address().port;
    const post = (p, b, h) => fetch(base + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: JSON.stringify(b) });
    try {
        let r = await post('/api/udanmaku/v3/', { token: TOK.a, id: ID('剧E', '第1集'), w: '', time: 12.3, text: '你好', color: 16777215, type: 0 });
        let j = await r.json();
        ok(r.status === 200 && j.code === 0 && j.id > 0, 'POST 弹幕 → code 0', j);
        r = await post('/api/udanmaku/v3/', { token: 'x', id: ID('剧E', '第1集'), time: 1, text: 'x' });
        j = await r.json();
        ok(r.status === 401 && j.code === 1 && j.msg, '没登录 → code 1 + 提示', j);
        r = await fetch(base + '/api/udanmaku/v3/?id=' + ID('剧E', '01') + '&w=&token=');
        j = await r.json();
        ok(r.headers.get('cache-control') === 'no-store' && j.code === 0 && j.version === 3 && j.data.length === 1 && j.data[0][4] === '你好' && j.data[0][3] === 'uc' + 1, 'GET DPlayer v3 格式', j);
        r = await fetch(base + '/api/comments?title=' + encodeURIComponent('剧E') + '&token=');
        j = await r.json();
        ok(j.enabled === true && j.total === 0, 'GET 评论');
        r = await post('/api/comments', { token: TOK.a, title: '剧E', text: '路由评论' });
        j = await r.json();
        ok(j.ok && j.item.text === '路由评论', 'POST 评论', j);
        r = await post('/api/comments', { token: TOK.nosync, title: '剧E', text: 'x' });
        ok(r.status === 401, 'POST 评论没登录 401');
        r = await fetch(base + '/api/comments/danmaku?title=' + encodeURIComponent('剧E') + '&token=');
        j = await r.json();
        ok(j.total === 1 && j.items[0].t === 12.3, 'GET 评论区弹幕');
        auth = true;
        r = await fetch(base + '/api/comments?title=' + encodeURIComponent('剧E') + '&token=');
        ok(r.status === 401, '配了访问密码:读要令牌');
        r = await fetch(base + '/api/comments?title=' + encodeURIComponent('剧E') + '&token=' + TOK.c);
        ok(r.status === 200 && (await r.json()).total === 1, '带令牌能读');
        r = await fetch(base + '/api/udanmaku/v3/?id=' + ID('剧E', '01') + '&w=&token=');
        ok((await r.json()).data.length === 1, '播放器的用户弹幕不要令牌(试看的人也看得到,和平台弹幕一样)');
        r = await fetch(base + '/api/admin/ucomm?kind=c');
        ok(r.status === 403, '后台要令牌');
        r = await fetch(base + '/api/admin/ucomm?kind=c', { headers: { 'X-Admin-Token': 'adm' } });
        j = await r.json();
        ok(r.status === 200 && j.total === 1 && j.counts.d.all === 1, '后台列表', j.counts);
        r = await post('/api/admin/ucomm/words', { words: ['甲', '乙'] }, { 'X-Admin-Token': 'adm' });
        j = await r.json();
        ok(j.ok && j.words.length === 2, '后台改屏蔽词');
    } finally { if (srv.closeAllConnections) srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
}

console.log(`\ncomments-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
