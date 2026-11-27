// 📚 片单回归(离线、零网络):node scripts/playlists-test.mjs
//  ① lib/playlists 纯函数:normItem(截长 / 白名单 / 海报只认 http(s) 与站内路径)、itemKey(去空白小写 + 作品签名)
//  ② 路由(SQLite 内存库 + 假 app):鉴权 / 封禁、建 / 改名 / 删、加 / 删片子(重复加不重复不挪位)、上限(片单数 / 单个 / 总量)、
//     公开分享(私密 / 不存在一律 not_found,不给 user_token,私密站要令牌)、导入合并(同名合并、超上限报 skipped)、写限速、坏输入
//  ③ index.html 里 <dg-pl-core> 那段前端纯函数:本机片单的增删改、合并进账号前的整理、首页拼封面
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = (m) => { try { return require(path.join(ROOT, 'node_modules', m)); } catch (e) { return require(m); } };
const Database = dep('better-sqlite3');
const { createPlaylists, normItem, itemKey, cleanPoster } = require(path.join(ROOT, 'lib/playlists'));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) pass++; else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  ->  ' + JSON.stringify(extra).slice(0, 600) : '')); } };

function mkApp() {
    const routes = new Map();
    const reg = (m) => (p, ...hs) => { routes.set(m + ' ' + p, hs); };
    return { routes, get: reg('GET'), post: reg('POST') };
}
async function call(app, method, p, o) {
    o = o || {};
    const hs = app.routes.get(method + ' ' + p);
    if (!hs) throw new Error('no route ' + method + ' ' + p);
    const req = { method, body: o.body || {}, query: o.query || {}, params: o.params || {}, headers: {} };
    const res = {
        statusCode: 200, body: undefined, headers: {}, headersSent: false,
        status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; },
        json(x) { this.body = x; this.headersSent = true; return this; }
    };
    let i = 0;
    const next = () => { const h = hs[i++]; if (h) return h(req, res, next); };
    await next();
    return res;
}

console.log('① 纯函数');
{
    const it = normItem({ t: '  庆余年\u0000 第二季 ', p: 'https://image.tmdb.org/t/p/w342/a.jpg', y: 2024, ty: 'tv', tm: '12345', ot: 'Joy of Life 2', w: 'abc', junk: 'x' });
    ok(it && it.t === '庆余年 第二季' && it.p === 'https://image.tmdb.org/t/p/w342/a.jpg' && it.y === '2024' && it.ty === 'tv' && it.tm === 12345 && it.ot === 'Joy of Life 2' && it.w === 'abc' && !('junk' in it),
        '正常条目:控制字符去掉、空白收拢、年份转字符串、tm 转整数、多余字段丢掉', it);
    ok(it.k === '庆余年第二季|w:abc' && itemKey('庆余年 第二季', '') === '庆余年第二季' && itemKey('The Bear') === 'thebear', 'itemKey:去空白、小写、带作品签名', it.k);
    ok(normItem({ t: '' }) === null && normItem({ t: '   ' }) === null && normItem(null) === null && normItem([1]) === null && normItem('x') === null, '没片名 / 不是对象 → null');
    const bad = normItem({ t: 'x'.repeat(300), p: 'javascript:alert(1)', y: '1850', ty: 'TV!', tm: -3, ot: 'x'.repeat(300) });
    ok(bad.t.length === 100 && !bad.p && !bad.y && !bad.ty && !bad.tm && !bad.ot, '超长截断;坏海报 / 年份 / 类型 / id 丢掉;原名跟片名一样不存', bad);
    for (const p of ['//evil.com/a.jpg', 'data:image/png;base64,xx', 'http://', '/a b.jpg', 'https://x/"onerror=', 'ftp://x/a.jpg', 'x'.repeat(10)])
        ok(cleanPoster(p) === '', '海报不认:' + p.slice(0, 30));
    for (const p of ['https://x.com/a.jpg', 'http://x.com/a.jpg?w=1', '/proxy/img?u=https%3A%2F%2Fx'])
        ok(cleanPoster(p) === p, '海报认:' + p);
}

console.log('② 路由');
const db = new Database(':memory:');
const TOK = { a: 'tok-a', b: 'tok-b', banned: 'tok-ban' };
let authReq = true, now = 1_700_000_000_000;
const P = createPlaylists({
    db: () => db, now: () => now,
    authRequired: () => authReq,
    tokenOk: (t) => Object.prototype.hasOwnProperty.call({ 'tok-a': 1, 'tok-b': 1, 'tok-ban': 1 }, t),
    isBanned: (t) => t === TOK.banned,
    opts: { maxLists: 4, maxItems: 5, maxTotal: 8, writePerMin: 1000 },
});
const app = mkApp();
P.registerRoutes(app);
const post = (p, body) => call(app, 'POST', '/api/playlists/' + p, { body });
const getAll = (token) => call(app, 'GET', '/api/playlists', { query: { token } });
const pub = (id, token) => call(app, 'GET', '/api/playlists/public/:id', { params: { id }, query: token ? { token } : {} });
const I = (t, extra) => Object.assign({ t, p: 'https://img/' + encodeURIComponent(t) + '.jpg', y: '2020', ty: 'tv' }, extra || {});
{
    let r = await getAll('nope');
    ok(r.statusCode === 401, '令牌不对 → 401');
    r = await getAll('constructor');
    ok(r.statusCode === 401, '原型键 constructor 当令牌 → 401');
    r = await getAll(TOK.banned);
    ok(r.statusCode === 403 && r.body.banned, '封禁 → 403');
    r = await getAll(TOK.a);
    ok(r.statusCode === 200 && r.body.enabled && Array.isArray(r.body.lists) && r.body.lists.length === 0 && r.body.limits.lists === 4, '空列表 + 上限', r.body);
    ok(r.headers['Cache-Control'] === 'no-store', '不缓存');

    r = await post('create', { token: TOK.a, name: '  ', desc: 'x' });
    ok(r.statusCode === 400 && r.body.error === 'name', '空名字 → 400');
    r = await post('create', { token: TOK.a, name: '周末必看'.repeat(20), desc: 'd'.repeat(500), item: I('繁花') });
    const L1 = r.body.list;
    ok(r.body.ok && /^[A-Za-z0-9_-]{12}$/.test(L1.id) && L1.name.length === 40 && L1.desc.length === 200 && L1.pub === false && L1.count === 1 && L1.items[0].t === '繁花' && L1.items[0].k === '繁花' && L1.items[0].a === now,
        '新建:名字 / 简介截长,默认私密,顺手加第一部', L1);
    ok(!JSON.stringify(r.body).includes('tok-a'), '回包里没有 user_token');

    now += 1000;
    r = await post('add', { token: TOK.a, id: L1.id, item: I('狂飙') });
    ok(r.body.ok && r.body.added && r.body.k === '狂飙' && r.body.item.a === now, '加一部', r.body);
    now += 1000;
    r = await post('add', { token: TOK.a, id: L1.id, item: I(' 繁 花 ', { p: 'https://img/new.jpg', tm: 99 }) });
    ok(r.body.ok && !r.body.added && r.body.k === '繁花' && r.body.item.a === now - 2000, '重复加(空白不同也算同一部):更新内容、不重复、加入时间不变', r.body);
    r = await getAll(TOK.a);
    let l = r.body.lists[0];
    ok(l.count === 2 && l.items.map(x => x.t).join() === '狂飙,繁 花' && l.items[1].p === 'https://img/new.jpg' && l.items[1].tm === 99 && l.updated_at === now, '新加的在前;更新过的那条换了海报 / id、位置不变', l.items);
    r = await post('add', { token: TOK.b, id: L1.id, item: I('x') });
    ok(r.statusCode === 404, '别人的片单加不进去');
    r = await post('add', { token: TOK.a, id: L1.id, item: { t: '' } });
    ok(r.statusCode === 400, '坏条目 → 400');
    r = await post('add', { token: TOK.a, id: '../../etc', item: I('x') });
    ok(r.statusCode === 404, '坏 id → 404');

    // 单个上限 5、总量 8、片单数 4
    for (const t of ['a1', 'a2', 'a3']) r = await post('add', { token: TOK.a, id: L1.id, item: I(t) });
    r = await post('add', { token: TOK.a, id: L1.id, item: I('a4') });
    ok(!r.body.ok && r.body.error === 'limit' && r.body.limits.items === 5, '单个片单满 5 部 → limit', r.body);
    r = await post('add', { token: TOK.a, id: L1.id, item: I('a1', { y: '2021' }) });
    ok(r.body.ok && !r.body.added, '满了也能更新已有的那部');
    r = await post('create', { token: TOK.a, name: '二号', item: I('b1') });
    const L2 = r.body.list;
    for (const t of ['b2', 'b3']) await post('add', { token: TOK.a, id: L2.id, item: I(t) });
    r = await post('add', { token: TOK.a, id: L2.id, item: I('b4') });
    ok(!r.body.ok && r.body.error === 'total', '所有片单加起来满 8 部 → total', r.body);
    r = await post('create', { token: TOK.a, name: '三号' });
    r = await post('create', { token: TOK.a, name: '四号' });
    r = await post('create', { token: TOK.a, name: '五号' });
    ok(!r.body.ok && r.body.error === 'limit', '片单满 4 个 → limit', r.body);

    // 改名 / 简介 / 公开
    r = await post('update', { token: TOK.a, id: L2.id, name: '' });
    ok(r.statusCode === 400, '改成空名字 → 400');
    r = await post('update', { token: TOK.b, id: L2.id, name: 'x' });
    ok(r.statusCode === 404, '改别人的 → 404');
    r = await post('update', { token: TOK.a, id: L2.id, name: '  新名字 ', desc: '一句话', pub: true });
    ok(r.body.ok && r.body.list.name === '新名字' && r.body.list.desc === '一句话' && r.body.list.pub === true && r.body.list.count === 3 && !r.body.list.items, '改名 + 简介 + 设公开(回包只带元信息)', r.body);
    r = await post('update', { token: TOK.a, id: L2.id, pub: 'yes' });
    ok(r.body.list.pub === false && r.body.list.name === '新名字', 'pub 只认 true;只改一个字段时别的不动', r.body.list);
    await post('update', { token: TOK.a, id: L2.id, pub: true });

    // 公开分享
    r = await pub(L2.id, TOK.b);
    ok(r.body.ok && !r.body.mine && r.body.list.name === '新名字' && r.body.list.items.length === 3 && !JSON.stringify(r.body).includes('tok-a'), '别人看公开片单:有名字和片子,没有 user_token', r.body);
    r = await pub(L2.id);
    ok(r.statusCode === 401, '私密站:不带令牌看公开片单 → 401');
    authReq = false;
    r = await pub(L2.id);
    ok(r.body.ok && !r.body.mine, '公开站:不带令牌也能看');
    authReq = true;
    r = await pub(L1.id, TOK.b);
    ok(r.statusCode === 404 && r.body.error === 'not_found', '私密的 → not_found');
    r = await pub(L1.id, TOK.a);
    ok(r.body.ok && r.body.mine && r.body.list.items.length === 5, '自己看自己私密的:能看(mine)');
    r = await pub('AAAAAAAAAAAA', TOK.b);
    const r2 = await pub('bad', TOK.b);
    ok(r.statusCode === 404 && r.body.error === 'not_found' && r2.statusCode === 404, '不存在 / 格式不对 → 同样的 not_found');
    db.prepare("UPDATE user_playlists SET user_token = 'tok-ban' WHERE id = ?").run(L2.id);
    r = await pub(L2.id, TOK.b);
    ok(r.statusCode === 404, '片单主人被封禁 → 公开片单看不到');
    db.prepare("UPDATE user_playlists SET user_token = 'tok-a' WHERE id = ?").run(L2.id);

    // 删片子 / 删片单
    r = await post('remove', { token: TOK.a, id: L2.id, k: 'b2' });
    ok(r.body.ok && r.body.removed === 1, '删一部');
    r = await post('remove', { token: TOK.a, id: L2.id, k: 'b2' });
    ok(r.body.ok && r.body.removed === 0, '再删一次:removed 0');
    r = await post('remove', { token: TOK.a, id: L2.id, k: { x: 1 } });
    ok(r.statusCode === 400, 'k 不是字符串 → 400');
    r = await post('delete', { token: TOK.b, id: L2.id });
    ok(r.body.ok && r.body.removed === 0 && (await getAll(TOK.a)).body.lists.some(x => x.id === L2.id), '别人删不掉(回 removed 0)');
    r = await post('delete', { token: TOK.a, id: L2.id });
    ok(r.body.ok && r.body.removed === 1 && db.prepare('SELECT COUNT(*) n FROM user_playlist_items WHERE list_id = ?').get(L2.id).n === 0, '删片单连片子一起删');
    r = await pub(L2.id, TOK.b);
    ok(r.statusCode === 404, '删了的公开片单链接失效');

    // 导入(登录时本机片单并进账号)
    r = await post('create', { token: TOK.a, name: '五号' });
    ok(r.body.ok, '删掉一个后又能建了(现在 4 个,满)');
    const before = (await getAll(TOK.a)).body;
    r = await post('import', { token: TOK.a, lists: 'x' });
    ok(r.statusCode === 400, 'lists 不是数组 → 400');
    r = await post('import', {
        token: TOK.a, lists: [
            { name: '三号', desc: '不覆盖', items: [I('c1', { a: now - 50 }), I('c2', { a: now - 60 }), { t: '' }] },
            { name: '本机新单', desc: '本机的', created_at: now - 99999, items: [I('d1'), I('d2'), I('d3')] },
            { name: '' }, null,
        ]
    });
    const after = r.body;
    const san = after.lists && after.lists.find(x => x.name === '三号'), nl = after.lists && after.lists.find(x => x.name === '本机新单');
    ok(after.ok && after.merged === 1 && san && san.items.map(x => x.t).join() === 'c1,c2' && san.desc === '' && san.items[0].a === now - 50,
        '同名片单合并:片子并进去、顺序 / 加入时间沿用本机的、简介不覆盖', after);
    ok(!nl && after.created === 0 && after.skipped > 0 && after.lists.length === before.lists.length,
        '片单已满 4 个:新的那个整个跳过(报 skipped)', { created: after.created, skipped: after.skipped, n: after.lists.length });
    await post('delete', { token: TOK.a, id: after.lists.find(x => x.name === '四号').id });
    r = await post('import', { token: TOK.a, lists: [{ name: '本机新单', created_at: now - 99999, items: [I('d1'), I('d2'), I('d3')] }] });
    const nl2 = r.body.lists.find(x => x.name === '本机新单');
    ok(r.body.created === 1 && nl2 && nl2.created_at === now - 99999 && nl2.items.length === 1 && r.body.skipped === 2,
        '有空位了:新建;总量只剩 1 部的额度 → 只进 1 部,其余报 skipped', r.body);
    r = await post('import', { token: TOK.a, lists: [{ name: '三号', items: [I('c1'), I('c2')] }] });
    ok(r.body.merged === 1 && r.body.skipped === 0 && r.body.lists.find(x => x.name === '三号').count === 2, '重复导入同样的:不重复、不算 skipped');
}
{
    // 写限速
    const P2 = createPlaylists({ db: () => db, tokenOk: () => true, opts: { writePerMin: 3 } });
    const app2 = mkApp();
    P2.registerRoutes(app2);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call(app2, 'POST', '/api/playlists/create', { body: { token: 'tok-r', name: 'n' + i } })).statusCode);
    ok(codes.join() === '200,200,200,429,429', '每个令牌每分钟写 3 次后 429', codes);
    // 没有数据库 → enabled:false,不报错
    const P3 = createPlaylists({ db: () => null, tokenOk: () => true });
    const app3 = mkApp();
    P3.registerRoutes(app3);
    const g = await call(app3, 'GET', '/api/playlists', { query: { token: 'x' } });
    const c = await call(app3, 'POST', '/api/playlists/create', { body: { token: 'x', name: 'n' } });
    ok(g.body.enabled === false && c.body.enabled === false && !P3.enabled(), '没有 sqlite:接口报 enabled:false');
}

console.log('③ 前端纯函数 <dg-pl-core>');
{
    const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').split('\r\n').join('\n');
    const m = /\/\/ <dg-pl-core>\n([\s\S]*?)\n\s*\/\/ <\/dg-pl-core>/.exec(HTML);
    ok(!!m, 'index.html 里有 <dg-pl-core> 段');
    if (m) {
        let seq = 0;
        const S = vm.runInNewContext(m[1] + '\n;DgPl;', { Array, Object, JSON, Set, Map, String, Number, Math, Date: { now: () => 1000 + (seq++) } });
        const LIM = { lists: 3, items: 2, total: 4 };
        ok(S.keyOf(' 庆余年 第二季 ', '') === '庆余年第二季' && S.keyOf('A b', 'w1') === 'ab|w:w1', 'keyOf 和服务器 itemKey 同规则');
        let st = S.load('{bad');
        ok(Array.isArray(st) && st.length === 0, '本机存的坏了 → 空');
        let r = S.create(st, '  我的单 ', '', LIM, { t: '繁花', p: 'https://x/a.jpg' });
        ok(r.ok && r.lists.length === 1 && r.list.name === '我的单' && /^l[a-z0-9]+$/.test(r.list.id) && r.list.items.length === 1 && r.list.items[0].k === '繁花', '本机新建 + 顺手加第一部', r);
        st = r.lists;
        const id = r.list.id;
        r = S.add(st, id, { t: '狂飙' }, LIM);
        ok(r.ok && r.added && r.lists[0].items.map(x => x.t).join() === '狂飙,繁花' && st[0].items.length === 1, '加一部(不改原数组,新的在前)');
        st = r.lists;
        r = S.add(st, id, { t: ' 繁 花', y: '2023' }, LIM);
        ok(r.ok && !r.added && r.lists[0].items[1].y === '2023', '重复加 = 更新,不挪位置');
        r = S.add(st, id, { t: '第三部' }, LIM);
        ok(!r.ok && r.error === 'limit', '单个满了 → limit');
        r = S.add(st, id, { t: '' }, LIM);
        ok(!r.ok && r.error === 'item', '没片名 → item');
        st = S.create(st, '二', '', LIM, { t: 'x1' }).lists;
        const id2 = st[0].id;
        st = S.add(st, id2, { t: 'x2' }, LIM).lists;
        r = S.add(S.create(st, '三', '', LIM).lists, st[0].id, { t: 'x3' }, LIM);
        ok(!r.ok && r.error === 'limit', '另一个片单也满了 → limit');
        const c3 = S.create(st, '三', '', LIM);
        r = S.add(c3.lists, c3.list.id, { t: 'x3' }, LIM);
        ok(!r.ok && r.error === 'total', '总量满了 → total', r);
        r = S.create(S.create(st, '三', '', LIM).lists, '四', '', LIM);
        ok(!r.ok && r.error === 'limit', '片单数满了 → limit');
        r = S.update(st, id2, { name: '改名', desc: '简介' });
        ok(r.ok && r.lists[0].name === '改名' && r.lists[0].desc === '简介' && st[0].name === '二', '改名 / 简介(不改原数组)');
        ok(!S.update(st, id2, { name: ' ' }).ok, '改成空名字不行');
        r = S.removeItem(st, id, '繁花');
        ok(r.find(x => x.id === id).items.map(x => x.t).join() === '狂飙', '删一部');
        r = S.removeList(st, id2);
        ok(r.length === 1 && r[0].id === id, '删片单');
        ok(S.has(st, '繁花') && !S.has(st, '没有') && S.inLists(st, '繁花').join() === id, 'has / inLists:哪些片单里有这部');
        const cov = S.covers({ items: [{ p: 'a' }, {}, { p: 'b' }, { p: 'c' }, { p: 'd' }, { p: 'e' }] });
        ok(JSON.stringify(cov) === '["a","b","c","d"]', '封面拼图:取前 4 张有海报的', cov);
        // 导入整理:只带名字 / 简介 / 建立时间 / 片子(瘦身),去掉本机 id
        const ex = S.forImport(st);
        ok(ex.length === 2 && ex.every(x => !('id' in x) && typeof x.name === 'string' && Array.isArray(x.items)) && ex[1].items[0].t === '狂飙', 'forImport 去掉本机 id', ex);
        // 存回去再读:原样
        const round = S.load(JSON.stringify(st));
        ok(JSON.stringify(round) === JSON.stringify(st), '存本机再读回来:原样');
        const dirty = S.load(JSON.stringify([{ id: 'l1', name: '', items: [] }, { id: 'l2', name: 'ok', items: [{ t: '' }, { t: 'a' }, null] }, 5, null]));
        ok(dirty.length === 1 && dirty[0].items.length === 1 && dirty[0].items[0].k === 'a', '读本机时坏片单 / 坏条目丢掉', dirty);
    }
}

console.log(`\n${fail ? '✗' : '✓'} playlists-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
