// [adult] AVDB(avdbapi.com provide/vod)元数据本地索引:番号 → 发行日 / 时长 / 演员 / 片商 / 英文标签 / 政策等级。
//
// 调研 .adult-research/impl/p34/avdb-crawl-plan.md(§1 API 语义、§3 归一化、§4 表结构、§5 全量、§6 增量、§9 演员)。
//
// 用法(由 lib/site-catalog 的 avdbFactory 创建,和目录共用 catalog.db):
//   const avdb = require('./lib/adult-avdb').createAvdb({
//       db,                                   // better-sqlite3 连接(或返回它的函数);表 avdb / avdb_tag / avdb_state / actress /
//                                             //   actress_alias / actress_merge / avdb_actor 建在这里
//       httpGet: async (url, {timeout, siteKey:'avdb'}) => 解析好的 JSON(字符串也认),失败 throw,
//       log, env, adult,                      // adult.tags.tagsFromAvdb(英文标签) → [{id,src:'avdb'}](没有就给 [])
//       onChange: (keys) => {},               // 可选:每页 / 每批入库提交后,本批碰到的番号键(AVDB 侧 key)—— 目录据此重算 code_ok / 政策
//       now / sleep / random / opts           // 仅测试:假时钟、假 sleep、抖动、覆盖 DEF
//   });
//   avdb.start();                              // 首轮在 AVDB_FIRST_DELAY_MS(默认 10 分钟)后
//   只读连接(query_only / readonly 打开)上建的实例只查询:建实例不写库(规则版本旧了就在内存里现算标签等级),start() 不爬也不重算
//
// 接口(合同 B):
//   start() / stop()
//   lookup(key[, {dur}]) → {key, variants, tags, tags_en, actors:[{aid,name}], maker, label, released, runtime, poster, pol} | null
//       key:调用方的键(去掉 c: 前缀和 #U / #clip / ~N 后缀);variants:AVDB 有的版本 'main'|'leak'|'ensub';
//       pol:同键所有变体行的并集里最严的一级 'block' | 'review_hide' | 'review_code' | null;
//       pol='block' 的结果只留 key / variants / label / runtime / pol(其余清空:被拦的片不给任何可展示的东西)。
//       日期式番号片商对不上 = 不同的片 → null;我们是 UNC(片商未知)而 AVDB 有 ≥2 个片商:{dur}(秒)按 3%+60s 能挑出唯一一个就用,
//       挑不出来 → 任一候选被拦就回 {pol:'block', ambiguous:true…}(fail-closed),否则 null。
//       行的选择:松键(looseKey,去补零 / 去日期式片商)→ 精确键命中时只要同一类(国产 'MDS-0607' 和日本厂牌 'MDS-607' 分开)。
//       演员只出:真名字(2-3 个拉丁词或 2-10 个汉字假名)、主行优先(没有主行才用变体行)、素人(type 4)/ FC2 / KBJ 一律不出。
//       附加字段:kind、avdb_key(AVDB 侧归一化键)、pol_groups、ambiguous。
//   lookupMany(keys) → Map(调用方键 → 结果,只含命中)
//   recent(days) → string[]:AVDB 主行发行日在 [今天-days, 今天] 的番号键(AVDB 侧 key,发行日倒序;被拦的、KBJ / 无番号形状的不给)
//   actress(aid) → {aid, name, aliases:[], n} | null(合并过的 aid 自动跳到新 aid;n = 主行署名且没被拦的作品数)
//   searchActress(q) → [{aid,name,n}](≤10,只出 n ≥ 1 的)
//   stats() → {rows, lastFull, lastDelta, crawling, cursor, polv, polchg, …}
//   pol(key,{dur}) → 只要政策等级(= lookup(key).pol,不拼元数据);polVersion() → 政策相关行变了就变的戳(调用方据此作废政策缓存)。
//     读路径的等级 = 实时算(标签等级表)与库里存的行级 pol 取严:只读实例启动后爬虫新见到的拦截标签,靠存的 pol 兜住。
//   附加:actressKeys(aid,{limit,offset}) → 番号键[](没被拦的,发行日倒序)/ runFull() / runDelta() / refetch(ids) / step() /
//         ingest(list,{typeId}) / postProcess() / recomputePolicy() / looseKey / POLICY_VERSION
//
// 爬取(礼貌):单连接串行,两次请求开始间隔 ≥1.1s;出错退避 5s / 30s / 120s(共 4 次)后整个任务暂停 30 分钟;
//   全量:先拉一次不带筛选的第 1 页记 maxIdAtStart,再按类型 t=5,7,4,3,2,1 逐页(跳过 Hentai 6),每页后存游标 {t,pg},
//         重启 / 暂停后从 pg−1 续(新入库会把旧行往后挤);total=999 是封顶的假总数(category= / wd= 这类),不信 pagecount、翻到不满一页;
//         失败页超过已知计划页数的 1%(至少 5)→ 本轮作废,24h 后重来;各类型行数 ≥ 开始时 total 的 99% 才算完整,
//         完整的轮次删掉连续两轮都没见到的行;结束后从 maxIdAtStart 跑一次增量。90 天重做一次(对账)。
//   增量(每天一次 +0~10 分钟抖动):不带筛选按 id 倒序翻页,只收 id > 水位的行,某页最小 id ≤ 水位就停;30 页封顶 →
//         改按类型 t∈{1,2,3,4,5,7}&h=<距上次增量小时数+24,至少 72> 翻;水位只在一次增量完整结束后才前移。
//   不带筛选的列表绝不翻过第 5000 页(调研 §1.3:深翻会切成按 id 分页,最老的 4 万行永远翻不到)。
//   请求路径(搜索 / 详情 / 首页)永不调 AVDB:lookup 只读本地表。
// 环境变量:AVDB_DISABLE=1(不爬;本地查询照常)/ AVDB_FIRST_DELAY_MS(默认 600000)/ AVDB_MAX_PAGES(本进程总共最多拉几页,测试用)/
//          AVDB_BASE(https 接口地址覆盖)
'use strict';

const N = require('./norm');
const P = require('./policy');

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const DEF = {
    base: 'https://avdbapi.com/api.php/provide/vod',
    firstDelayMs: 600000,
    gapMs: 1100,                  // 下限 1100,不能调小
    timeoutMs: 30000,
    backoffMs: [5000, 30000, 120000],
    pauseMs: 30 * MIN,
    pageSize: 100,
    fullTypes: [5, 7, 4, 3, 2, 1],
    fullEveryMs: 90 * DAY,
    fullRetryMs: DAY,
    fullCompleteRatio: 0.99,
    failAbortRatio: 0.01,
    failAbortMin: 5,
    deltaEveryMs: DAY,
    deltaJitterMs: 10 * MIN,
    deltaCapPages: 30,
    deltaFallbackTypes: [1, 2, 3, 4, 5, 7],
    deltaFallbackHours: 72,
    deltaFallbackMaxHours: 720,
    deltaFallbackMaxPages: 100,
    unfilteredMaxPage: 5000,
    typeMaxPages: 6000,           // 单类型翻页保险丝(Censored 约 3,200 页)
    idleCheckMs: 10 * MIN,
    recentCacheMs: 10 * MIN,
    statsCacheMs: 60e3,
    tagCacheMax: 100000,
    progressEvery: 100,
    yieldEvery: 2000,
};
const TYPE_NAME = { 1: 'Censored', 2: 'Uncensored', 3: 'Uncensored Leaked', 4: 'Amateur', 5: 'Chinese AV', 6: 'Hentai', 7: 'English subtitle' };
const CODE_KINDS = new Set(['jav', 'cn', 'fc2', 'heyzo', 'uncen-date', 'tokyohot', 'h4610', 'heydouga']);
const NO_ACTOR_KINDS = new Set(['fc2', 'kbj']);
const VORD = { main: 0, leak: 1, ensub: 2 };
// 变体行(无码流出 / 英字)上的"版本"标签不代表作品本身(否则有码正片会被标成无码流出)
const VARIANT_TAG = /^(?:uncensored(?: leak(?:ed)?)?|leak(?:ed|age)?|english sub(?:title[sd]?)?|english subtitles|subtitled|censored)$/;

const envFlag = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const envInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const tidsOf = (s) => String(s || '').split(',').filter(Boolean).map(Number);
const jstDate = (t) => new Date(t + 9 * HOUR).toISOString().slice(0, 10);   // 发行日按日本日期比

const SCHEMA = `
CREATE TABLE IF NOT EXISTS avdb (
  id INTEGER PRIMARY KEY,
  type_id INTEGER NOT NULL,
  variant TEXT NOT NULL,
  mc TEXT NOT NULL,
  key TEXT NOT NULL,
  lkey TEXT NOT NULL,
  gk TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT, num INTEGER, studio TEXT,
  title_en TEXT,
  actors TEXT NOT NULL DEFAULT '',
  maker TEXT, director TEXT,
  tags TEXT NOT NULL DEFAULT '',
  pol TEXT NOT NULL DEFAULT '',
  polg TEXT NOT NULL DEFAULT '',
  released TEXT, runtime INTEGER, poster TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS avdb_lkey ON avdb(lkey);
CREATE INDEX IF NOT EXISTS avdb_gk ON avdb(gk);
CREATE INDEX IF NOT EXISTS avdb_label ON avdb(label, num);
CREATE INDEX IF NOT EXISTS avdb_rel ON avdb(released) WHERE variant = 'main';
CREATE TABLE IF NOT EXISTS avdb_tag (tid INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, form TEXT, pol TEXT, grp TEXT);
CREATE TABLE IF NOT EXISTS avdb_state (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS actress (
  aid INTEGER PRIMARY KEY, name TEXT NOT NULL, name_ja TEXT, name_zh TEXT,
  n_main INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, nsrc TEXT NOT NULL DEFAULT 'main'
);
CREATE TABLE IF NOT EXISTS actress_alias (
  alias TEXT PRIMARY KEY, aid INTEGER NOT NULL, kind TEXT NOT NULL, src TEXT NOT NULL,
  support INTEGER NOT NULL DEFAULT 1, display TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS actress_alias_aid ON actress_alias(aid);
CREATE TABLE IF NOT EXISTS actress_merge (from_aid INTEGER PRIMARY KEY, into_aid INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS avdb_actor (
  aid INTEGER NOT NULL, gk TEXT NOT NULL, main INTEGER NOT NULL DEFAULT 1, ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (aid, gk)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS avdb_actor_gk ON avdb_actor(gk);
`;

class StopError extends Error { constructor() { super('stopped'); this.stopped = true; } }
class CapError extends Error { constructor() { super('AVDB_MAX_PAGES 到了'); this.capped = true; } }

function createAvdb(deps) {
    const d = deps || {};
    const db = typeof d.db === 'function' ? d.db() : d.db;
    if (!db || typeof db.prepare !== 'function') throw new Error('createAvdb: 需要 better-sqlite3 连接 db');
    const env = d.env || {};
    const o = Object.assign({}, DEF, d.opts || {});
    o.gapMs = Math.max(1100, +o.gapMs || 0);
    if (env.AVDB_FIRST_DELAY_MS != null && String(env.AVDB_FIRST_DELAY_MS).trim() !== '') o.firstDelayMs = envInt(env.AVDB_FIRST_DELAY_MS, o.firstDelayMs);
    o.maxPages = envInt(env.AVDB_MAX_PAGES, o.maxPages || 0);
    if (env.AVDB_BASE && /^https:\/\/[^\s?#]+$/i.test(String(env.AVDB_BASE))) o.base = String(env.AVDB_BASE);
    const disabled = envFlag(env.AVDB_DISABLE);
    const log = (m) => { try { (d.log || console.log)('[AVDB] ' + m); } catch (e) { /* 日志失败不影响 */ } };
    const now = typeof d.now === 'function' ? d.now : Date.now;
    const random = typeof d.random === 'function' ? d.random : Math.random;
    const httpGet = d.httpGet;
    const adult = d.adult || null;

    // 只读连接(主线程 query_only / readonly 打开):建实例时一个字都不写(写线程的实例负责建表、规则重算、状态),
    //   否则空表时写 polv_rows 会 SQLITE_READONLY,主线程只读实例建不起来 → 闸门的 AVDB 检查整个失效
    const RO = (() => { try { return !!db.readonly || !!db.pragma('query_only', { simple: true }); } catch (e) { return false; } })();
    db.exec(SCHEMA);   // 表都在时是只读的空操作(只读连接也能跑);表不在 → 只读连接这里 throw(调用方稍后重试)

    // ---------- 语句 ----------
    const S = {
        stGet: db.prepare('SELECT v FROM avdb_state WHERE k=?'),
        stSet: db.prepare('INSERT INTO avdb_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
        upsert: db.prepare(`INSERT INTO avdb(id,type_id,variant,mc,key,lkey,gk,kind,label,num,studio,title_en,actors,maker,director,tags,pol,polg,released,runtime,poster,added,seen)
            VALUES(@id,@type_id,@variant,@mc,@key,@lkey,@gk,@kind,@label,@num,@studio,@title_en,@actors,@maker,@director,@tags,@pol,@polg,@released,@runtime,@poster,@added,@seen)
            ON CONFLICT(id) DO UPDATE SET type_id=excluded.type_id,variant=excluded.variant,mc=excluded.mc,key=excluded.key,lkey=excluded.lkey,gk=excluded.gk,
            kind=excluded.kind,label=excluded.label,num=excluded.num,studio=excluded.studio,title_en=excluded.title_en,actors=excluded.actors,maker=excluded.maker,
            director=excluded.director,tags=excluded.tags,pol=excluded.pol,polg=excluded.polg,released=excluded.released,runtime=excluded.runtime,
            poster=excluded.poster,added=excluded.added,seen=max(avdb.seen,excluded.seen)`),
        byLkey: db.prepare('SELECT * FROM avdb WHERE lkey=?'),
        byGk: db.prepare('SELECT * FROM avdb WHERE gk=?'),
        rowsForCredits: db.prepare('SELECT id,type_id,variant,kind,actors FROM avdb WHERE gk=? ORDER BY id'),
        tagByName: db.prepare('SELECT tid FROM avdb_tag WHERE name=?'),
        tagIns: db.prepare('INSERT OR IGNORE INTO avdb_tag(name,form,pol,grp) VALUES(?,?,?,?)'),
        tagName: db.prepare('SELECT name FROM avdb_tag WHERE tid=?'),
        polTagsAll: db.prepare('SELECT tid,name,pol,grp FROM avdb_tag WHERE pol IS NOT NULL'),
        polTagsSince: db.prepare('SELECT tid,name,pol,grp FROM avdb_tag WHERE tid>? AND pol IS NOT NULL'),
        maxTid: db.prepare('SELECT MAX(tid) AS m FROM avdb_tag'),
        prevOfId: db.prepare('SELECT gk,pol FROM avdb WHERE id=?'),
        aliasGet: db.prepare('SELECT aid,kind,src,support FROM actress_alias WHERE alias=?'),
        aliasIns: db.prepare('INSERT OR IGNORE INTO actress_alias(alias,aid,kind,src,support,display) VALUES(?,?,?,?,0,?)'),
        aliasBump: db.prepare('UPDATE actress_alias SET support=support+1 WHERE alias=? AND aid=?'),
        aliasesOf: db.prepare('SELECT alias,kind,src,support,display FROM actress_alias WHERE aid=? ORDER BY support DESC, alias'),
        actressIns: db.prepare('INSERT INTO actress(name,nsrc) VALUES(?,?)'),
        actressGet: db.prepare('SELECT aid,name,name_ja,name_zh,n_main,hidden,nsrc FROM actress WHERE aid=?'),
        actressSetName: db.prepare('UPDATE actress SET name=?, nsrc=? WHERE aid=?'),
        actressSetJa: db.prepare('UPDATE actress SET name_ja=? WHERE aid=? AND name_ja IS NULL'),
        mergeGet: db.prepare('SELECT into_aid FROM actress_merge WHERE from_aid=?'),
        creditsOfGk: db.prepare('SELECT aid FROM avdb_actor WHERE gk=?'),
        creditsDelGk: db.prepare('DELETE FROM avdb_actor WHERE gk=?'),
        creditIns: db.prepare('INSERT OR IGNORE INTO avdb_actor(aid,gk,main,ord) VALUES(?,?,?,?)'),
        creditsForGks: (n) => db.prepare(`SELECT a.aid, a.main, a.ord, s.name FROM avdb_actor a JOIN actress s ON s.aid=a.aid
            WHERE a.gk IN (${Array(n).fill('?').join(',')}) AND s.hidden=0 ORDER BY a.main DESC, a.ord`),
        recount: db.prepare(`UPDATE actress SET n_main=(SELECT COUNT(*) FROM avdb_actor a WHERE a.aid=@aid AND a.main=1
            AND NOT EXISTS (SELECT 1 FROM avdb r WHERE r.gk=a.gk AND r.pol='block')) WHERE aid=@aid`),
        keysOfActress: db.prepare('SELECT gk, main FROM avdb_actor WHERE aid=?'),
        countRows: db.prepare('SELECT COUNT(*) AS n FROM avdb'),
        maxId: db.prepare('SELECT MAX(id) AS m FROM avdb'),
        recentGks: db.prepare(`SELECT gk, MAX(released) AS rel FROM avdb WHERE variant='main' AND released>=? AND released<=? GROUP BY gk ORDER BY rel DESC`),
    };
    const creditStmtCache = new Map();
    const creditsForGks = (gks) => {
        let st = creditStmtCache.get(gks.length);
        if (!st) { st = S.creditsForGks(gks.length); creditStmtCache.set(gks.length, st); }
        return st.all(...gks);
    };

    // ---------- 状态 ----------
    const stGet = (k, dflt) => { const r = S.stGet.get(k); if (!r) return dflt; try { return JSON.parse(r.v); } catch (e) { return dflt; } };
    const stSet = (k, v) => S.stSet.run(k, JSON.stringify(v));

    // ---------- 标签表(名 → tid;带政策等级的标签常驻内存) ----------
    const tagIdCache = new Map();
    const tagNameCache = new Map();
    let polTags = new Map();                         // tid → {name, pol, grp}
    let polMaxTid = 0, polSyncAt = 0;
    let polLive = false;                             // 只读连接上标签等级表还是旧规则算的:内存里按当前规则现算(不写库)
    function loadPolTags() {
        const m = new Map();
        if (polLive) {
            for (const r of db.prepare('SELECT tid,name FROM avdb_tag').all()) { const c = P.classifyTagNoType(r.name); if (c) m.set(r.tid, { tid: r.tid, name: r.name, pol: c.list, grp: c.group }); }
        } else for (const r of S.polTagsAll.all()) m.set(r.tid, r);
        polTags = m; polMaxTid = +(S.maxTid.get().m) || 0; polSyncAt = now();
    }
    // 别的连接(写线程里的爬虫)新建的带等级标签:只读实例按 MAX(tid) 增量补进来(最多 2 秒查一次)。
    //   正确性不靠它 —— 读路径一律再和库里存的行级 pol 取严(readPol),这里只是让"实时算"那半边也跟上
    function syncPolTags() {
        const t = now();
        if (t - polSyncAt < 2000 && t >= polSyncAt) return;
        polSyncAt = t;
        try {
            const m = +(S.maxTid.get().m) || 0;
            if (m > polMaxTid) { for (const r of S.polTagsSince.all(polMaxTid)) polTags.set(r.tid, r); polMaxTid = m; }
        } catch (e) { /* 查不到就只靠存的 pol */ }
    }
    // 政策相关的行变了(新出现 / 改了 pol 的行、规则重算)→ avdb_state.polchg +1;主线程的政策缓存按它作废
    function bumpPolchg() { stSet('polchg', (+stGet('polchg', 0) || 0) + 1); }
    function tagId(k, form) {
        let tid = tagIdCache.get(k);
        if (tid) return tid;
        let r = S.tagByName.get(k);
        if (!r) {
            const c = P.classifyTagNoType(k);
            S.tagIns.run(k, form, c ? c.list : null, c ? c.group : null);
            r = S.tagByName.get(k);
            if (c && r) polTags.set(r.tid, { tid: r.tid, name: k, pol: c.list, grp: c.group });
        }
        tid = r.tid;
        if (tagIdCache.size >= o.tagCacheMax) tagIdCache.clear();
        tagIdCache.set(k, tid);
        return tid;
    }
    function tagName(tid) {
        let n = tagNameCache.get(tid);
        if (n !== undefined) return n;
        const r = S.tagName.get(tid);
        n = r ? r.name : '';
        if (tagNameCache.size >= o.tagCacheMax) tagNameCache.clear();
        tagNameCache.set(tid, n);
        return n;
    }
    // 行级政策(实时算:标签 tid ∩ 带等级的标签,套 type_exceptions;再看英文片名)
    function rowPol(r, groups) {
        let best = null;
        const tn = TYPE_NAME[r.type_id] || '';
        for (const tid of tidsOf(r.tags)) {
            const pt = polTags.get(tid);
            if (!pt || P.typeExcepted(pt.name, tn)) continue;
            best = P.maxPol(best, pt.pol);
            if (groups) groups.add(pt.grp);
        }
        if (r.title_en) {
            const tc = P.classifyTitle(r.title_en);
            if (tc) { best = P.maxPol(best, tc.list); if (groups) groups.add(tc.group); }
        }
        return best;
    }
    // 读路径的行级政策:实时算 + 库里存的 pol/polg(写线程入库时按它当时的全部标签等级算好)取严。
    //   只读实例的标签等级表是启动时载入的,之后爬虫新见到的拦截标签它不知道 —— 存的 pol 补上这个洞(fail-closed:
    //   规则放宽后、后台重算完之前,存的旧等级只会更严)
    function readPol(r, groups) {
        let best = rowPol(r, groups);
        const sp = r && typeof r.pol === 'string' ? r.pol : '';
        if (sp) {
            best = P.maxPol(best, sp);
            if (groups && r.polg) for (const g of String(r.polg).split(',')) if (g) groups.add(g);
        }
        return best;
    }

    // 政策规则版本变了:标签分级同步重算(几万个标签,启动时一次);行级 pol 列后台分块重算(lookup 一律实时算,不依赖它)
    function refreshTagPolicy() {
        if (stGet('polv_tags', '') === P.POLICY_VERSION) return false;
        if (RO) { polLive = true; return false; }
        const all = db.prepare('SELECT tid,name FROM avdb_tag').all();
        const upd = db.prepare('UPDATE avdb_tag SET pol=?, grp=? WHERE tid=?');
        db.transaction(() => { for (const t of all) { const c = P.classifyTagNoType(t.name); upd.run(c ? c.list : null, c ? c.group : null, t.tid); } })();
        stSet('polv_tags', P.POLICY_VERSION);
        if (all.length) { bumpPolchg(); log(`政策规则 ${P.POLICY_VERSION}:重算 ${all.length} 个标签的等级`); }
        return true;
    }
    refreshTagPolicy();
    loadPolTags();
    // 空表:之后入库的行都是按当前规则算的(已经是当前版本就不写;只读连接永远不写)
    if (!RO && !S.countRows.get().n && stGet('polv_rows', '') !== P.POLICY_VERSION) stSet('polv_rows', P.POLICY_VERSION);

    // ---------- 演员 ----------
    const aliasKeyR = (s) => { const k = N.orderKey(s); return k ? 'r:' + k : null; };
    const aliasKeyC = (s) => { const k = N.cjkKey(s); return k ? 'c:' + k : null; };
    // 去空格的拼写键(原词序):拼音的切分不统一("Le Naizi" / "Le Nai Zi"、"Xiaoshui Shui" / "Xiao Shui Shui")—— 词序键 r: 认不出是同一个人
    const aliasKeyS = (s) => { const k = String(s || '').toLowerCase().replace(/[^a-z]/g, ''); return k.length >= 4 ? 's:' + k : null; };
    const isLatinName = (s) => /^[A-Za-z]/.test(String(s || ''));
    function aliasAid(k) { if (!k) return 0; const r = S.aliasGet.get(k); return r ? r.aid : 0; }
    // 一行的 actors('|' 拼的显示名)→ 可署名的名字 [{primary, disp, paren?, ja?}]
    function namesOfRows(rows) {
        const out = [];
        const seen = new Set();
        for (const r of rows) {
            for (const a of String(r.actors || '').split('|')) {
                if (!a) continue;
                const sp = N.splitActor(a);
                const cands = [];
                if (sp.merged) {
                    // 两个人粘在一起("Alpha Testa Bravo Fixto" 这种 4 个词):两半都已经是认识的名字才拆,否则丢
                    const toks = sp.romaji.split(/\s+/).filter(Boolean);
                    if (toks.length === 4) {
                        const h1 = toks.slice(0, 2).join(' '), h2 = toks.slice(2).join(' ');
                        if (aliasAid(aliasKeyR(h1)) && aliasAid(aliasKeyR(h2))) cands.push({ romaji: h1 }, { romaji: h2 });
                    }
                } else if (N.isRealName(sp.romaji)) {
                    cands.push({ romaji: sp.romaji, paren: sp.alias && N.isRealName(sp.alias) ? sp.alias : null, ja: sp.ja && N.isRealName(sp.ja) ? sp.ja : null });
                }
                for (const c of cands) {
                    const latin = isLatinName(c.romaji);
                    const primary = latin ? aliasKeyR(c.romaji) : aliasKeyC(c.romaji);
                    if (!primary || seen.has(primary)) continue;
                    seen.add(primary);
                    out.push({ primary, kind: latin ? 'romaji' : 'cjk', disp: N.displayName(c.romaji), paren: c.paren || null, ja: c.ja || null });
                }
            }
        }
        return out;
    }
    function mergeActress(from, into) {
        if (!from || !into || from === into) return;
        db.prepare('INSERT OR IGNORE INTO avdb_actor(aid,gk,main,ord) SELECT ?,gk,main,ord FROM avdb_actor WHERE aid=?').run(into, from);
        db.prepare('UPDATE avdb_actor SET main=1 WHERE aid=? AND gk IN (SELECT gk FROM avdb_actor WHERE aid=? AND main=1)').run(into, from);
        db.prepare('DELETE FROM avdb_actor WHERE aid=?').run(from);
        db.prepare('UPDATE actress_alias SET aid=? WHERE aid=?').run(into, from);
        db.prepare('UPDATE actress_merge SET into_aid=? WHERE into_aid=?').run(into, from);
        db.prepare('INSERT OR REPLACE INTO actress_merge(from_aid,into_aid) VALUES(?,?)').run(from, into);
        db.prepare('DELETE FROM actress WHERE aid=?').run(from);
        S.recount.run({ aid: into });
    }
    // 名字 → aid(按罗马字词序键 / 括号别名 / 日文名找;找不到就新建)。src: 'avdb'(主行)| 'avdb-leak'(只有变体行)
    function resolveName(nm, src) {
        const kP = nm.paren ? (isLatinName(nm.paren) ? aliasKeyR(nm.paren) : aliasKeyC(nm.paren)) : null;
        const kJ = nm.ja ? aliasKeyC(nm.ja) : null;
        const kS = nm.kind === 'romaji' ? aliasKeyS(nm.disp) : null;
        let aid = aliasAid(nm.primary) || aliasAid(kP) || aliasAid(kJ) || aliasAid(kS);
        if (!aid) aid = Number(S.actressIns.run(nm.disp, src === 'avdb' ? 'main' : 'leak').lastInsertRowid);
        S.aliasIns.run(nm.primary, aid, nm.kind === 'romaji' ? 'romaji' : 'cjk', src, nm.disp);
        if (kS) {
            const a3 = aliasAid(kS);
            if (!a3) S.aliasIns.run(kS, aid, 'squash', src, nm.disp);
            else if (a3 !== aid && src === 'avdb') mergeActress(a3, aid);   // 同一个拼写只是空格切分不同 = 同一个人(主行才合并)
        }
        if (kP) {
            const a2 = aliasAid(kP);
            if (!a2) S.aliasIns.run(kP, aid, 'paren', src, nm.paren);
            else if (a2 !== aid && src === 'avdb') mergeActress(a2, aid);      // 主行写明 "A (B)" = 同一个人
        }
        if (kJ && !aliasAid(kJ)) S.aliasIns.run(kJ, aid, 'ja', src, nm.ja);
        if (src === 'avdb') {
            const a = S.actressGet.get(aid);
            if (a && a.nsrc !== 'main') S.actressSetName.run(nm.disp, 'main', aid);   // 先从变体行建的,主行一来改成主行写法
        }
        return aid;
    }
    // 重算一个作品组(gk)的署名:主行(非素人、非 FC2/KBJ)有真名字就用主行(main=1);主行没有 → 变体行(main=0,不算作品数)
    function recomputeCredits(gk, touchedAids) {
        const rows = S.rowsForCredits.all(gk);
        const old = S.creditsOfGk.all(gk).map((r) => r.aid);
        let names = [];
        let main = 0;
        if (rows.length && !rows.some((r) => r.type_id === 4) && !rows.some((r) => NO_ACTOR_KINDS.has(r.kind))) {
            const mains = rows.filter((r) => r.variant === 'main');
            names = namesOfRows(mains);
            if (names.length) main = 1;
            else names = namesOfRows(rows.filter((r) => r.variant !== 'main'));
        }
        S.creditsDelGk.run(gk);
        let ord = 0;
        const oldSet = new Set(old);
        for (const nm of names) {
            const aid = resolveName(nm, main ? 'avdb' : 'avdb-leak');
            if (!aid) continue;
            if (S.creditIns.run(aid, gk, main, ord++).changes && !oldSet.has(aid)) {
                S.aliasBump.run(nm.primary, aid);
                if (nm.ja) {
                    const kJ = aliasKeyC(nm.ja);
                    S.aliasBump.run(kJ, aid);
                    const al = S.aliasGet.get(kJ);
                    if (al && al.aid === aid && al.support >= 2) S.actressSetJa.run(nm.ja, aid);   // 日文名有 ≥2 部作品佐证才上
                }
            }
            touchedAids.add(aid);
        }
        for (const a of old) touchedAids.add(a);
    }
    function recountAids(aids) { for (const a of aids) S.recount.run({ aid: a }); }

    // ---------- 入库 ----------
    let gen = 0;
    let statsCache = null;
    let recentCache = null;
    function rowOf(raw, run, typeHint) {
        if (!raw || typeof raw !== 'object') return { skip: 'bad' };
        const id = parseInt(raw.id, 10);
        if (!(id > 0)) return { skip: 'bad' };
        const typeName = raw.type_name != null && String(raw.type_name).trim() ? String(raw.type_name) : (TYPE_NAME[typeHint] || '');
        const typeId = N.typeIdOf(typeName) || (+typeHint || 0);
        const mc = N.decode(raw.movie_code).trim();
        if (typeId === 6 || /^avdb-/i.test(mc)) return { skip: 'hentai' };
        const nk = N.normKey(mc, typeName);
        if (!nk || !nk.key) return { skip: 'nokey' };
        const lkey = N.looseKey(nk.key);
        if (!lkey) return { skip: 'nokey' };
        const variant = N.variantOf(mc, typeName);
        const tags = N.tagsOf(raw);
        const tids = tags.map((t) => tagId(t.k, t.form));
        const title = N.titleOf(raw.name, mc);
        const actors = N.cleanActors(raw.actor).join('|').slice(0, 1000);
        const dirs = Array.isArray(raw.director) ? raw.director : (raw.director ? String(raw.director).split(',') : []);
        const row = {
            id, type_id: typeId, variant, mc: mc.slice(0, 80), key: nk.key, lkey,
            // 作品组键(署名按它记):日期式带片商(同日同号不同片商 = 不同的片);国产单独一组(MDS-0607 国产 ≠ MDS-607 日本厂牌)
            gk: nk.kind === 'uncen-date' ? nk.key.toUpperCase() : (nk.kind === 'cn' ? 'C:' + lkey : lkey),
            kind: nk.kind, label: nk.label || null, num: Number.isFinite(nk.num) ? nk.num : null, studio: nk.studio || null,
            title_en: title, actors, maker: N.makerOf(dirs), director: N.directorOf(dirs),
            tags: tids.length ? ',' + tids.join(',') + ',' : '',
            released: N.releaseDate(raw.created_at) || N.releaseDate(raw.vod_pubdate) || null,
            runtime: N.hms(raw.time), poster: N.posterOf(raw), added: N.addedOf(raw), seen: run || 0,
        };
        const groups = new Set();
        row.pol = rowPol(row, groups) || '';
        row.polg = groups.size ? ',' + [...groups].join(',') + ',' : '';
        return { row };
    }
    // 一页入库(一个事务):upsert + 受影响作品组重算署名 + 演员作品数;返回本页统计
    function ingest(list, opts) {
        const op = opts || {};
        const run = op.run != null ? op.run : stGet('run', 0);
        const minFresh = op.minId != null ? op.minId : -Infinity;
        const res = { rows: 0, skipped: 0, hentai: 0, minId: Infinity, maxId: 0, n: 0, keys: [] };
        const gks = new Set();
        const keys = new Set();
        try {
            db.transaction(() => {
                let polTouched = false;
                for (const raw of Array.isArray(list) ? list : []) {
                    const id = parseInt(raw && raw.id, 10);
                    if (id > 0) { res.n++; if (id < res.minId) res.minId = id; if (id > res.maxId) res.maxId = id; }
                    if (!(id > minFresh)) continue;
                    let r;
                    try { r = rowOf(raw, run, op.typeId); } catch (e) { r = { skip: 'bad' }; }       // 一行怪数据不能卡死整个全量
                    if (r.skip) { if (r.skip === 'hentai') res.hentai++; else res.skipped++; continue; }
                    const prev = S.prevOfId.get(r.row.id);
                    if (prev && prev.gk !== r.row.gk) gks.add(prev.gk);
                    if ((r.row.pol || '') !== ((prev && prev.pol) || '') || (r.row.pol && prev && prev.gk !== r.row.gk)) polTouched = true;
                    S.upsert.run(r.row);
                    gks.add(r.row.gk);
                    keys.add(r.row.key);
                    res.rows++;
                }
                const aids = new Set();
                for (const gk of gks) recomputeCredits(gk, aids);
                recountAids(aids);
                if (polTouched) bumpPolchg();
            })();
        } catch (e) {
            // 事务回滚了:本页新插的标签行也没了,内存里的 名→tid / tid→等级 缓存必须作废(否则 tid 被别的标签复用时政策会错位)
            tagIdCache.clear();
            tagNameCache.clear();
            loadPolTags();
            throw e;
        }
        if (res.minId === Infinity) res.minId = 0;
        res.keys = [...keys];
        if (res.rows) {
            gen++;
            statsCache = null;
            recentCache = null;
            if (typeof d.onChange === 'function' && res.keys.length) { try { d.onChange(res.keys); } catch (e) { log('onChange 出错:' + e.message); } }
        }
        return res;
    }

    // ---------- 请求(单连接串行、≥1.1s 间隔、退避) ----------
    let stopped = false;
    let lastStart = -Infinity;
    let pagesFetched = 0;
    let requestsMade = 0;
    const waiters = new Set();
    // 调度层的长等待(首轮延迟 / 空闲 / 暂停)unref,不拖住进程退出;请求间隔和退避 ref(脚本里直接跑 runFull 也不会半路退出)
    function wait(ms, unref) {
        if (!(ms > 0)) return Promise.resolve();
        if (typeof d.sleep === 'function') return d.sleep(ms);
        return new Promise((resolve) => {
            const w = { resolve, t: setTimeout(() => { waiters.delete(w); resolve(); }, ms) };
            if (unref && w.t && w.t.unref) w.t.unref();
            waiters.add(w);
        });
    }
    function urlOf(params) {
        return o.base + '?' + Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(String(v))).join('&');
    }
    const FILTER_KEYS = ['t', 'h', 'ids', 'wd', 'category', 'actor'];
    async function fetchPage(params) {
        if (typeof httpGet !== 'function') throw new Error('AVDB:没有 httpGet');
        const filtered = FILTER_KEYS.some((k) => params[k] != null && params[k] !== '');
        if (!filtered && (+params.pg || 1) > o.unfilteredMaxPage) throw new Error('AVDB:不带筛选的列表不能翻过第 ' + o.unfilteredMaxPage + ' 页');
        if (o.maxPages > 0 && pagesFetched >= o.maxPages) throw new CapError();
        const url = urlOf(params);
        let attempt = 0;
        for (;;) {
            if (stopped) throw new StopError();
            const gap = lastStart + o.gapMs - now();
            if (gap > 0) await wait(gap);
            if (stopped) throw new StopError();
            lastStart = now();
            requestsMade++;
            let err = null;
            try {
                let body = await httpGet(url, { timeout: o.timeoutMs, siteKey: 'avdb' });
                if (typeof body === 'string') body = JSON.parse(body.replace(/^﻿/, ''));
                if (!body || typeof body !== 'object' || !Array.isArray(body.list)) throw new Error('不是 AVDB 列表 JSON');
                pagesFetched++;
                return body;
            } catch (e) { err = e; }
            if (attempt >= o.backoffMs.length) {
                const e = new Error('AVDB 请求失败(' + (attempt + 1) + ' 次):' + String(err && err.message || err).slice(0, 160));
                e.pageFail = true;
                throw e;
            }
            await wait(o.backoffMs[attempt++]);
        }
    }

    // ---------- 任务(同一时刻只跑一个) ----------
    let crawling = false;
    let lastError = '';
    async function exclusive(name, fn) {
        if (crawling) return { status: 'busy', crawling };
        crawling = name;
        try { return await fn(); } catch (e) {
            if (e && e.stopped) return { status: 'stopped' };
            if (e && e.capped) return { status: 'capped' };
            lastError = String(e && e.message || e).slice(0, 300);
            log(name + ' 出错:' + lastError);
            return { status: 'error', error: lastError };
        } finally { crawling = false; }
    }
    function pause(reason) {
        const until = now() + o.pauseMs;
        stSet('pauseUntil', until);
        lastError = String(reason || '').slice(0, 300);
        log('暂停 ' + Math.round(o.pauseMs / MIN) + ' 分钟:' + lastError);
        return until;
    }

    // 全量:游标 {run, startedAt, maxIdAtStart, ti, pg, totals, skipped, failed, phase}
    function runFull() {
        return exclusive('full', async () => {
            let f = stGet('full', null);
            let resume = false;
            if (!f || f.phase === 'done' || f.phase === 'aborted') {
                const run = stGet('run', 0) + 1;
                stSet('run', run);
                f = { run, startedAt: now(), maxIdAtStart: 0, ti: -1, pg: 1, totals: {}, pagecounts: {}, skipped: {}, failed: 0, phase: 'types' };
                stSet('full', f);
                log(`全量第 ${run} 轮开始`);
            } else resume = true;
            const save = () => stSet('full', f);
            const onFail = (e) => {
                f.failed++;
                const planned = Math.max(500, Object.values(f.pagecounts).reduce((a, b) => a + (+b || 0), 0));
                if (f.failed > Math.max(o.failAbortMin, Math.ceil(o.failAbortRatio * planned))) {
                    f.phase = 'aborted';
                    save();
                    stSet('fullRetryAt', now() + o.fullRetryMs);
                    lastError = e.message;
                    log(`全量第 ${f.run} 轮作废:失败页 ${f.failed} 超过 1%;${Math.round(o.fullRetryMs / HOUR)}h 后重来`);
                    return { status: 'aborted', run: f.run };
                }
                save();
                return { status: 'paused', until: pause(e.message), run: f.run };
            };
            try {
                // ① 不带筛选的第 1 页:记 maxIdAtStart(结束后从这里跑增量)
                if (f.ti === -1) {
                    const body = await fetchPage({ ac: 'detail', pg: 1 });
                    const r = ingest(body.list, { run: f.run });
                    f.maxIdAtStart = Math.max(f.maxIdAtStart || 0, r.maxId || 0);
                    f.ti = 0; f.pg = 1;
                    save();
                }
                // ② 按类型逐页
                while (f.ti < o.fullTypes.length) {
                    const T = o.fullTypes[f.ti];
                    let pg = resume ? Math.max(1, (f.pg || 1) - 1) : (f.pg || 1);
                    resume = false;
                    let prevFirst = null;
                    for (;;) {
                        const body = await fetchPage({ ac: 'detail', t: T, pg });
                        const total = parseInt(body.total, 10) || 0;
                        const pagecount = parseInt(body.pagecount, 10) || 0;
                        const firstId = body.list.length ? String(body.list[0] && body.list[0].id) : null;
                        if (firstId != null && firstId === prevFirst) { log(`全量 t=${T} 第 ${pg} 页和上一页一样(接口不认 pg?),本类型到此为止`); break; }
                        prevFirst = firstId;
                        if (f.totals[T] == null || pg === 1) f.totals[T] = total;
                        f.pagecounts[T] = pagecount;
                        const r = ingest(body.list, { run: f.run, typeId: T });
                        f.skipped[T] = (f.skipped[T] || 0) + r.skipped + r.hentai;
                        f.pg = pg + 1;
                        save();
                        if (pg % o.progressEvery === 0) log(`全量 t=${T} 第 ${pg}/${pagecount} 页`);
                        const capped = total === 999;                         // 封顶的假总数:不信 pagecount,翻到不满一页为止
                        const lastPage = body.list.length < o.pageSize || (!capped && pagecount > 0 && pg >= pagecount) || pg >= o.typeMaxPages;
                        if (!body.list.length || lastPage) break;
                        pg++;
                    }
                    f.ti++; f.pg = 1;
                    save();
                }
                // ③ 完整性 + 对账删除 + 从 maxIdAtStart 跑增量
                const counts = {};
                for (const r of db.prepare('SELECT type_id, COUNT(*) AS n FROM avdb WHERE seen=? GROUP BY type_id').all(f.run)) counts[r.type_id] = r.n;
                let complete = true;
                for (const T of o.fullTypes) {
                    const tot = +f.totals[T] || 0;
                    if (tot === 999) continue;
                    if ((counts[T] || 0) + (f.skipped[T] || 0) < o.fullCompleteRatio * tot) { complete = false; log(`全量 t=${T}:${counts[T] || 0}+${f.skipped[T] || 0} 行 < 开始时 ${tot} 的 99%`); }
                }
                // 对账删除:本轮和上一轮都完整,才删两轮都没见到的行;带政策等级的行永远不删(过期的拦截 = fail-closed)
                let dropped = 0;
                if (complete && f.run >= 2 && stGet('lastCompleteRun', 0) === f.run - 1) dropped = dropUnseen(f.run - 1);
                if (complete) stSet('lastCompleteRun', f.run);
                f.phase = 'delta';
                f.complete = complete;
                save();
                const wm = stGet('wm', 0);
                if (!(wm >= f.maxIdAtStart)) stSet('wm', f.maxIdAtStart);
                f.phase = 'done';
                save();
                stSet('lastFull', now());
                stSet('needFull', false);
                log(`全量第 ${f.run} 轮完成(${complete ? '完整' : '不完整'};删除 ${dropped} 行没再见到的)`);
                crawling = 'delta';
                const dr = await deltaBody();
                await postProcess();
                return { status: 'done', run: f.run, complete, dropped, delta: dr };
            } catch (e) {
                if (e && e.pageFail) return onFail(e);
                throw e;
            }
        });
    }
    // 连续两轮全量都没见到的行(seen < run-1)删掉;受影响作品组重算署名
    function dropUnseen(minSeen) {
        const victims = db.prepare("SELECT id, gk FROM avdb WHERE seen < ? AND pol = ''").all(minSeen);
        if (!victims.length) return 0;
        db.transaction(() => {
            const del = db.prepare('DELETE FROM avdb WHERE id=?');
            const gks = new Set();
            for (const v of victims) { del.run(v.id); gks.add(v.gk); }
            const aids = new Set();
            for (const gk of gks) recomputeCredits(gk, aids);
            recountAids(aids);
        })();
        gen++; statsCache = null; recentCache = null;
        return victims.length;
    }

    // 增量:id 倒序翻,只收 id > 水位;某页最小 id ≤ 水位就停;30 页封顶 → 按类型 &h= 兜底
    async function deltaBody() {
        const wm0 = stGet('wm', 0);
        if (!(wm0 > 0)) return { status: 'nofull' };
        const run = stGet('run', 0);
        let maxSeen = wm0;
        let added = 0;
        let reached = false;
        let pages = 0;
        let pg = 1;
        try {
            for (; pg <= o.deltaCapPages; pg++) {
                const body = await fetchPage({ ac: 'detail', pg });
                pages++;
                const r = ingest(body.list, { run, minId: wm0 });
                added += r.rows;
                if (r.maxId > maxSeen) maxSeen = r.maxId;
                if (!body.list.length || r.minId <= wm0 || body.list.length < o.pageSize) { reached = true; break; }
            }
            let gap = false;
            if (!reached) {
                const lastDelta = stGet('lastDelta', 0);
                let H = o.deltaFallbackHours;
                if (lastDelta > 0) H = Math.max(H, Math.ceil((now() - lastDelta) / HOUR) + 24);
                const clamped = H > o.deltaFallbackMaxHours;
                H = Math.min(H, o.deltaFallbackMaxHours);
                log(`增量翻满 ${o.deltaCapPages} 页还没到水位 ${wm0},改按类型 h=${H} 兜底`);
                for (const T of o.deltaFallbackTypes) {
                    let ok = false;
                    for (let p = 1; p <= o.deltaFallbackMaxPages; p++) {
                        const body = await fetchPage({ ac: 'detail', t: T, h: H, pg: p });
                        pages++;
                        const r = ingest(body.list, { run, minId: wm0, typeId: T });
                        added += r.rows;
                        if (r.maxId > maxSeen) maxSeen = r.maxId;
                        if (!body.list.length || r.minId <= wm0) { ok = true; break; }
                        if (body.list.length < o.pageSize) { ok = !clamped; break; }
                    }
                    if (!ok) gap = true;
                }
                if (gap) { stSet('needFull', true); log('增量兜底没覆盖到水位:安排一次全量对账'); }
            }
            stSet('wm', maxSeen);
            const t = now();
            stSet('lastDelta', t);
            stSet('nextDeltaAt', t + o.deltaEveryMs + Math.floor(random() * o.deltaJitterMs));
            if (added) log(`增量:${pages} 页,新增 ${added} 行,水位 ${wm0} → ${maxSeen}`);
            return { status: 'done', pages, added, wm: maxSeen, fallback: !reached, gap };
        } catch (e) {
            if (e && e.pageFail) return { status: 'paused', until: pause(e.message), pages, added };
            throw e;
        }
    }
    function runDelta() {
        return exclusive('delta', async () => {
            const r = await deltaBody();
            if (r.status === 'done' && r.added) r.post = await postProcess();
            return r;
        });
    }

    // ids= 精确复取(对账 / 抽查):每请求 100 个 id
    function refetch(ids) {
        return exclusive('refetch', async () => {
            const list = [...new Set((ids || []).map((x) => parseInt(x, 10)).filter((x) => x > 0))];
            const run = stGet('run', 0);
            let rows = 0, pages = 0;
            for (let i = 0; i < list.length; i += 100) {
                const chunk = list.slice(i, i + 100);
                try {
                    const body = await fetchPage({ ac: 'detail', ids: chunk.join(',') });
                    pages++;
                    rows += ingest(body.list, { run }).rows;
                } catch (e) {
                    if (e && e.pageFail) return { status: 'paused', until: pause(e.message), pages, rows };
                    throw e;
                }
            }
            return { status: 'done', pages, rows };
        });
    }

    // ---------- 批处理(全量 / 增量之后) ----------
    const yieldLoop = () => new Promise((r) => setImmediate(r));
    // 变体行(无码流出)的机翻名字:和同一作品主行的唯一名字一一对应、≥2 部作品 → 并到主行那位
    async function mergeLeakAliases() {
        const pairs = new Map();          // 变体名键 → Map(主名键 → 次数)
        const rev = new Map();            // 主名键 → Set(变体名键)
        const disp = new Map();
        const rows = db.prepare(`SELECT l.actors AS la, m.actors AS ma FROM avdb l JOIN avdb m ON m.gk=l.gk AND m.variant='main' AND m.type_id IN (1,2,5)
            WHERE l.variant='leak' AND l.actors<>'' AND m.actors<>''`).all();
        let k = 0;
        for (const r of rows) {
            if (++k % o.yieldEvery === 0) await yieldLoop();
            const ln = namesOfRows([{ actors: r.la }]).filter((x) => x.kind === 'romaji');
            const mn = namesOfRows([{ actors: r.ma }]).filter((x) => x.kind === 'romaji');
            if (ln.length !== 1 || mn.length !== 1 || ln[0].primary === mn[0].primary) continue;
            const a = ln[0].primary, b = mn[0].primary;
            disp.set(a, ln[0].disp);
            let m = pairs.get(a); if (!m) pairs.set(a, (m = new Map()));
            m.set(b, (m.get(b) || 0) + 1);
            let s = rev.get(b); if (!s) rev.set(b, (s = new Set()));
            s.add(a);
        }
        let merged = 0;
        db.transaction(() => {
            for (const [a, m] of pairs) {
                if (m.size !== 1) continue;
                const [[b, n]] = [...m.entries()];
                if (n < 2 || (rev.get(b) && rev.get(b).size !== 1)) continue;
                const aidB = aliasAid(b);
                if (!aidB) continue;
                const aidA = aliasAid(a);
                if (aidA === aidB) continue;
                if (aidA) {
                    const ra = S.actressGet.get(aidA);
                    if (ra && (ra.nsrc === 'main' || ra.n_main > 0)) continue;        // 这个"机翻名"自己就是主行署名的真人:绝不并
                    mergeActress(aidA, aidB);
                }
                else S.aliasIns.run(a, aidB, 'romaji', 'avdb-leak', disp.get(a) || null);
                merged++;
            }
        })();
        return merged;
    }
    async function postProcess() {
        // ① 粘在一起的名字:两半后来才出现的,重算一次
        const gks = db.prepare(`SELECT DISTINCT gk FROM avdb WHERE actors GLOB '* * * *'`).all().map((r) => r.gk);
        for (let i = 0; i < gks.length; i += 500) {
            const part = gks.slice(i, i + 500);
            db.transaction(() => { const aids = new Set(); for (const gk of part) recomputeCredits(gk, aids); recountAids(aids); })();
            await yieldLoop();
        }
        // ② 变体行机翻名合并
        const merged = await mergeLeakAliases();
        // ③ 没有任何署名的演员删掉(别名一起)
        const orphans = db.prepare('SELECT aid FROM actress a WHERE NOT EXISTS (SELECT 1 FROM avdb_actor x WHERE x.aid=a.aid)').all().map((r) => r.aid);
        db.transaction(() => {
            const da = db.prepare('DELETE FROM actress WHERE aid=?'), dl = db.prepare('DELETE FROM actress_alias WHERE aid=?');
            for (const a of orphans) { da.run(a); dl.run(a); }
        })();
        gen++; statsCache = null; recentCache = null;
        return { merged, orphans: orphans.length, regrouped: gks.length };
    }
    // 行级 pol 列按当前规则重算(规则版本变了才需要;lookup 不依赖它,只影响演员作品数和诊断)
    async function recomputePolicy() {
        if (stGet('polv_rows', '') === P.POLICY_VERSION) return { status: 'current' };
        let last = 0, changed = 0;
        const sel = db.prepare('SELECT id,type_id,tags,title_en,pol,polg,gk FROM avdb WHERE id>? ORDER BY id LIMIT ?');
        const upd = db.prepare('UPDATE avdb SET pol=?, polg=? WHERE id=?');
        for (;;) {
            const rows = sel.all(last, o.yieldEvery);
            if (!rows.length) break;
            db.transaction(() => {
                const gks = new Set();
                for (const r of rows) {
                    const groups = new Set();
                    const pol = rowPol(r, groups) || '';
                    const polg = groups.size ? ',' + [...groups].join(',') + ',' : '';
                    if (pol !== r.pol || polg !== r.polg) { upd.run(pol, polg, r.id); changed++; gks.add(r.gk); }
                }
                const aids = new Set();
                for (const gk of gks) for (const c of S.creditsOfGk.all(gk)) aids.add(c.aid);
                recountAids(aids);
                if (gks.size) bumpPolchg();
            })();
            last = rows[rows.length - 1].id;
            await yieldLoop();
        }
        stSet('polv_rows', P.POLICY_VERSION);
        if (changed) { gen++; statsCache = null; recentCache = null; log(`政策规则 ${P.POLICY_VERSION}:${changed} 行等级变了`); }
        return { status: 'done', changed };
    }

    // ---------- 调度 ----------
    let loopPromise = null, policyP = null;
    async function step() {
        if (disabled || stopped) return o.idleCheckMs;
        if (o.maxPages > 0 && pagesFetched >= o.maxPages) return o.idleCheckMs;
        const t = now();
        const pu = stGet('pauseUntil', 0);
        if (pu > t) return pu - t;
        const f = stGet('full', null);
        const lastFull = stGet('lastFull', 0);
        const retryAt = stGet('fullRetryAt', 0);
        const inProgress = f && f.phase !== 'done' && f.phase !== 'aborted';
        const due = !lastFull || t - lastFull >= o.fullEveryMs || stGet('needFull', false);
        if (inProgress || (due && !(retryAt > t))) {
            const r = await runFull();
            return r.status === 'done' || r.status === 'paused' ? 0 : o.idleCheckMs;
        }
        if (lastFull) {
            const next = stGet('nextDeltaAt', 0) || (stGet('lastDelta', 0) + o.deltaEveryMs);
            if (t >= next) { await runDelta(); return 0; }
            return Math.min(o.idleCheckMs, next - t);
        }
        return o.idleCheckMs;
    }
    function start() {
        if (RO) { log('只读连接上的实例只查询,不爬也不重算'); return; }
        // 行级 pol 重算只读写本地表:AVDB_DISABLE 时也要跑(否则规则放宽后存的旧等级永远比实时算的严)
        if (!loopPromise && !policyP && stGet('polv_rows', '') !== P.POLICY_VERSION) {
            policyP = recomputePolicy().catch((e) => log('重算政策出错:' + e.message)).finally(() => { policyP = null; });
        }
        if (disabled) { log('AVDB_DISABLE:不爬(本地查询照常)'); return; }
        if (loopPromise) return;
        stopped = false;
        loopPromise = (async () => {
            await wait(o.firstDelayMs, true);
            while (!stopped) {
                let ms;
                try { ms = await step(); } catch (e) { lastError = String(e && e.message || e); log('调度出错:' + lastError); ms = o.idleCheckMs; }
                if (stopped) break;
                await wait(Math.max(0, ms), true);
            }
        })();
    }
    async function stop() {
        stopped = true;
        for (const w of waiters) { clearTimeout(w.t); w.resolve(); }
        waiters.clear();
        const p = loopPromise;
        loopPromise = null;
        if (p) { try { await p; } catch (e) { /* 已停 */ } }
    }

    // ---------- 查询(只读本地表) ----------
    function selectRows(key, opts) {
        const ok = N.ourKey(key);
        const lk = N.looseKey(ok.key);
        if (!lk) return null;
        let rows = S.byLkey.all(lk);
        if (!rows.length) return null;
        const dur = opts && +opts.dur > 0 ? +opts.dur : 0;
        const durOk = (rt) => dur > 0 && rt > 0 && Math.abs(dur - rt) <= 0.03 * rt + 60;   // 挑片商用严一点的 3%+60s(同日两家常只差 10%)
        if (ok.date) {
            rows = rows.filter((r) => r.kind === 'uncen-date');
            const S0 = ok.date.studio;
            const unc = rows.filter((r) => r.studio === 'UNC');
            const byStudio = new Map();
            for (const r of rows) if (r.studio !== 'UNC') { const a = byStudio.get(r.studio) || []; a.push(r); byStudio.set(r.studio, a); }
            if (S0 !== 'UNC') {
                if (byStudio.has(S0)) return { rows: byStudio.get(S0), key: ok.key };
                if (!byStudio.size && unc.length) return { rows: unc, key: ok.key };
                return null;                                                     // 片商冲突 = 不同的片
            }
            if (byStudio.size === 0) return unc.length ? { rows: unc, key: ok.key } : null;
            if (byStudio.size === 1) return { rows: [...byStudio.values()][0].concat(unc), key: ok.key };
            const fit = [...byStudio.values()].filter((g) => g.some((r) => durOk(r.runtime)));
            if (fit.length === 1) return { rows: fit[0], key: ok.key };
            return { rows, key: ok.key, ambiguous: true };
        }
        rows = rows.filter((r) => r.kind !== 'uncen-date');
        if (!rows.length) return null;
        const exact = rows.filter((r) => r.key.toUpperCase() === ok.key.toUpperCase());
        if (exact.length) {
            const cn = exact[0].kind === 'cn';
            rows = rows.filter((r) => (r.kind === 'cn') === cn);              // MDS-607(JAV)和 MDS-0607(国产)只差补零:精确命中哪边就只要哪边
        }
        return { rows, key: ok.key };
    }
    const sortRows = (rows) => rows.slice().sort((a, b) => (VORD[a.variant] - VORD[b.variant]) || ((a.type_id === 4) - (b.type_id === 4)) || (a.id - b.id));
    const pick = (rows, f) => { for (const r of rows) if (r[f] != null && r[f] !== '' && r[f] !== 0) return r[f]; return null; };
    const blockedTagNames = () => {
        const T = adult && adult.tags;
        if (!T || !Array.isArray(T.VOCAB)) return null;
        if (!blockedTagNames.cache || blockedTagNames.src !== T.VOCAB) {
            blockedTagNames.cache = new Set(T.VOCAB.filter((v) => v && v.kind === 'blocked').map((v) => v.id));
            blockedTagNames.src = T.VOCAB;
        }
        return blockedTagNames.cache;
    };
    function tagsEnOf(rows) {
        const out = new Set();
        for (const r of rows) {
            const names = new Set();
            for (const a of String(r.actors || '').split('|')) {
                const t = a.toLowerCase().trim();
                if (!t) continue;
                names.add(t);
                for (const w of t.split(/[\s()（）]+/)) if (w.length >= 3) names.add(w);
            }
            const label = String(r.label || '').toLowerCase();
            for (const tid of tidsOf(r.tags)) {
                const nm = tagName(tid);
                if (!nm || nm.length > 40) continue;
                if (r.variant !== 'main' && VARIANT_TAG.test(nm)) continue;
                if (nm === label || /[a-z]{2,}[\s-]?\d{2,}/.test(nm) || names.has(nm)) continue;   // 厂牌 / 番号碎片 / 人名
                out.add(nm);
            }
        }
        return [...out];
    }
    function compose(sel) {
        const rows = sortRows(sel.rows);
        const groups = new Set();
        let pol = null;
        for (const r of rows) pol = P.maxPol(pol, readPol(r, groups));
        const variants = [...new Set(rows.map((r) => r.variant))].sort((a, b) => VORD[a] - VORD[b]);
        const main = rows.filter((r) => r.variant === 'main');
        const first = main[0] || rows[0];
        const kind = first.kind;
        const runtime = +pick(main, 'runtime') || +pick(rows, 'runtime') || 0;
        const base = {
            key: sel.key, avdb_key: first.key, kind, variants, label: first.label || '', runtime, pol: pol || null,
            pol_groups: [...groups].filter(Boolean), ambiguous: !!sel.ambiguous,
            tags: [], tags_en: [], actors: [], maker: '', released: '', poster: '',
        };
        if (pol === 'block' || sel.ambiguous) return base;
        base.released = pick(main, 'released') || pick(rows, 'released') || '';
        base.poster = N.posterUrl(pick(main, 'poster') || pick(rows, 'poster'));
        base.maker = kind === 'kbj' ? '' : (pick(main, 'maker') || pick(rows, 'maker') || '');
        base.tags_en = tagsEnOf(rows);
        const T = adult && adult.tags;
        if (T && typeof T.tagsFromAvdb === 'function') {
            try {
                const blocked = blockedTagNames();
                const seen = new Set();
                for (const t of T.tagsFromAvdb(base.tags_en) || []) {
                    if (!t || !t.id || seen.has(t.id) || (blocked && blocked.has(t.id))) continue;
                    seen.add(t.id);
                    base.tags.push({ id: t.id, src: 'avdb' });
                }
            } catch (e) { base.tags = []; }
        }
        if (!NO_ACTOR_KINDS.has(kind)) {
            const gks = [...new Set(rows.map((r) => r.gk))];
            const seen = new Set();
            for (const c of creditsForGks(gks)) { if (seen.has(c.aid)) continue; seen.add(c.aid); base.actors.push({ aid: c.aid, name: c.name }); }
        }
        return base;
    }
    function lookup(key, opts) {
        syncPolTags();
        const sel = selectRows(key, opts);
        if (!sel) return null;
        if (sel.ambiguous) {
            // 片商未知、AVDB 有好几个片商挑不出来:任一候选被拦 → 当被拦(fail-closed);否则当没查到
            let pol = null;
            for (const r of sel.rows) pol = P.maxPol(pol, readPol(r));
            return pol === 'block' ? compose(sel) : null;
        }
        return compose(sel);
    }
    // 只要政策等级(闸门搜索出口 / 目录卡片复查用):和 lookup().pol 同口径,不拼元数据
    function polOf(key, opts) {
        syncPolTags();
        const sel = selectRows(key, opts);
        if (!sel) return null;
        let pol = null;
        for (const r of sel.rows) pol = P.maxPol(pol, readPol(r));
        if (sel.ambiguous) return pol === 'block' ? 'block' : null;
        return pol || null;
    }
    // 政策版本戳:政策相关的行变了就变(调用方据此作废自己的政策缓存)
    function polVersion() { const r = S.stGet.get('polchg'); return r ? String(r.v) : ''; }
    function lookupMany(keys) {
        const m = new Map();
        for (const k of keys || []) { if (m.has(k)) continue; const r = lookup(k); if (r) m.set(k, r); }
        return m;
    }
    function polOfGk(gk) {
        let pol = null;
        for (const r of S.byGk.all(gk)) pol = P.maxPol(pol, readPol(r));
        return pol;
    }
    function recent(days) {
        const n = Math.max(1, Math.min(3650, parseInt(days, 10) || 60));
        const t = now();
        const hi = jstDate(t), lo = jstDate(t - n * DAY);
        syncPolTags();
        const ck = `${n}|${hi}|${gen}|${polVersion()}`;
        if (recentCache && recentCache.k === ck && t - recentCache.at < o.recentCacheMs) return recentCache.v.slice();
        const out = [];
        for (const g of S.recentGks.all(lo, hi)) {
            const rows = S.byGk.all(g.gk);
            if (!rows.length) continue;
            let pol = null;
            for (const r of rows) pol = P.maxPol(pol, readPol(r));
            if (pol === 'block') continue;
            const main = sortRows(rows)[0];
            if (!CODE_KINDS.has(main.kind)) continue;
            out.push(main.key);
        }
        recentCache = { k: ck, at: t, v: out };
        return out.slice();
    }
    function realAid(aid) {
        let a = parseInt(aid, 10);
        for (let i = 0; i < 8 && a > 0; i++) {
            if (S.actressGet.get(a)) return a;
            const m = S.mergeGet.get(a);
            if (!m) return 0;
            a = m.into_aid;
        }
        return 0;
    }
    function actress(aid) {
        const a = realAid(aid);
        if (!a) return null;
        const r = S.actressGet.get(a);
        if (!r || r.hidden) return null;
        const aliases = [];
        const seen = new Set([String(r.name).toLowerCase()]);
        for (const al of S.aliasesOf.all(a)) {
            const disp = al.display || '';
            if (!disp || seen.has(disp.toLowerCase())) continue;
            seen.add(disp.toLowerCase());
            aliases.push(disp);
            if (aliases.length >= 20) break;
        }
        const out = { aid: r.aid, name: r.name, aliases, n: r.n_main };
        if (r.name_ja) out.name_ja = r.name_ja;
        return out;
    }
    function actressKeys(aid, opts) {
        const a = realAid(aid);
        if (!a) return [];
        syncPolTags();
        const op = opts || {};
        const res = [];
        for (const c of S.keysOfActress.all(a)) {
            const rows = S.byGk.all(c.gk);
            if (!rows.length) continue;
            let pol = null;
            for (const r of rows) pol = P.maxPol(pol, readPol(r));
            if (pol === 'block') continue;
            const s = sortRows(rows);
            res.push({ key: s[0].key, rel: pick(s, 'released') || '', main: c.main });
        }
        res.sort((x, y) => (y.main - x.main) || (y.rel < x.rel ? -1 : y.rel > x.rel ? 1 : 0));
        const off = Math.max(0, parseInt(op.offset, 10) || 0);
        const lim = Math.max(1, Math.min(5000, parseInt(op.limit, 10) || 5000));
        return res.slice(off, off + lim).map((x) => x.key);
    }
    const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
    function searchActress(q) {
        const s = String(q == null ? '' : q).normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (s.length < 2) return [];
        const out = new Map();
        const add = (rows, exact) => {
            for (const r of rows) {
                if (out.size >= 10) break;
                if (out.has(r.aid) || !(r.n_main >= 1) || r.hidden) continue;
                out.set(r.aid, { aid: r.aid, name: r.name, n: r.n_main, exact });
            }
        };
        const base = 'SELECT DISTINCT a.aid, a.name, a.n_main, a.hidden FROM actress_alias l JOIN actress a ON a.aid=l.aid WHERE ';
        if (/^[A-Za-z][A-Za-z .'\-]*$/.test(s)) {
            const k = N.orderKey(s);
            if (!k) return [];
            add(db.prepare(base + 'l.alias=? ORDER BY a.n_main DESC LIMIT 10').all('r:' + k), true);
            const toks = k.split(' ');
            const where = toks.map(() => "(l.alias LIKE ? ESCAPE '\\' OR l.alias LIKE ? ESCAPE '\\')").join(' AND ');
            const args = [];
            for (const t of toks) args.push('r:' + likeEsc(t) + '%', 'r:% ' + likeEsc(t) + '%');
            add(db.prepare(base + where + ' ORDER BY a.n_main DESC LIMIT 30').all(...args), false);
        } else {
            const k = N.cjkKey(s);
            if (k.length < 2) return [];
            add(db.prepare(base + 'l.alias=? ORDER BY a.n_main DESC LIMIT 10').all('c:' + k), true);
            add(db.prepare(base + "l.alias LIKE ? ESCAPE '\\' ORDER BY a.n_main DESC LIMIT 30").all('c:%' + likeEsc(k) + '%'), false);
        }
        return [...out.values()].sort((a, b) => (b.exact - a.exact) || (b.n - a.n)).slice(0, 10).map(({ aid, name, n }) => ({ aid, name, n }));
    }
    function stats() {
        const t = now();
        if (!statsCache || t - statsCache.at > o.statsCacheMs) statsCache = { at: t, rows: S.countRows.get().n, actresses: db.prepare('SELECT COUNT(*) AS n FROM actress WHERE n_main>=1 AND hidden=0').get().n };
        const f = stGet('full', null);
        const cursor = f && f.phase !== 'done' && f.phase !== 'aborted' ? { run: f.run, t: f.ti >= 0 ? o.fullTypes[f.ti] || null : null, pg: f.pg, phase: f.phase } : null;
        return {
            rows: statsCache.rows, lastFull: stGet('lastFull', 0) || null, lastDelta: stGet('lastDelta', 0) || null, crawling, cursor,
            run: stGet('run', 0), wm: stGet('wm', 0), pauseUntil: stGet('pauseUntil', 0) || null, nextDeltaAt: stGet('nextDeltaAt', 0) || null,
            pages: pagesFetched, requests: requestsMade, disabled, polv: P.POLICY_VERSION, polchg: polVersion(), gen, actresses: statsCache.actresses, lastError: lastError || null,
        };
    }

    return {
        start, stop, lookup, lookupMany, recent, actress, searchActress, stats, pol: polOf, polVersion,
        actressKeys, runFull, runDelta, refetch, step, ingest, postProcess, recomputePolicy,
        looseKey: N.looseKey, POLICY_VERSION: P.POLICY_VERSION,
        _opts: o,
    };
}

module.exports = { createAvdb, norm: N, policy: P, POLICY_VERSION: P.POLICY_VERSION, looseKey: N.looseKey, TYPE_NAME };
