// [adult] catalog.db 表结构 v2 + 连接设置(调研 .adult-research/impl/cat/storage-recommendation.md §2.4)
//
//   · 目录自己一个库文件(catalog.db,默认在 cache.db 旁边;CATALOG_DB_PATH 覆盖),不再和历史 / 收藏 / 统计共用 cache.db 的写锁。
//     目录能从上游重建(全量回填约 10 小时),不需要备份;cache.db 里第一、二阶段的 adult_* 表不再读(新库从头回填)。
//   · adult_items 改成 rowid 表 + UNIQUE(site, vod_id),重扫要用的原始字段挪进 adult_items_raw(deflate 压缩)——
//     旧的 WITHOUT ROWID + 行内 raw 每行 3.4 KB,大半是溢出页空洞(调研实测 4.4 倍)。
//   · 作品表加 vis(审查通过且至少一条没判死的线路)/ hot / line_at / released / studio / maker / label / avdb / actress / dur(展示时长);
//     浏览 / 分面不走 SQL 排序索引,走读线程每 10 分钟建一次的位图快照(snapshot.js),这里只留首页 / 本地查找要的索引。
//   · 全文:作品名 trigram 外部内容 FTS(比普通 FTS 小 27%)+ 两字中文用的 bigram 无内容索引(36 B/作品,代替全表 LIKE)。
//   · 连接:WAL、synchronous=NORMAL、journal_size_limit 64MB、cache_size 64MB(写)/ 32MB(读);读连接 query_only=1(主线程绝不写)。
//   · adult_items.rv / adult_works.rv:按第几代规则入库(规则重扫期间只读得到已按新规则重跑过的行,见 common.js ELIG、writer.js rescan)。
'use strict';

const SCHEMA_VERSION = '2';

const DDL = `
CREATE TABLE IF NOT EXISTS adult_meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_items (
    id INTEGER PRIMARY KEY,
    site TEXT NOT NULL, vod_id TEXT NOT NULL,
    wk TEXT NOT NULL, bucket TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
    review TEXT, code_ok INTEGER NOT NULL DEFAULT 0, code_src TEXT,
    name TEXT NOT NULL, clean TEXT, code TEXT, ckey TEXT, tkey TEXT,
    pic TEXT, dur INTEGER NOT NULL DEFAULT 0, vod_time INTEGER,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    type_id INTEGER, type_name TEXT,
    play_from TEXT, play_url TEXT, play_at INTEGER,
    variant TEXT NOT NULL DEFAULT '', flags INTEGER NOT NULL DEFAULT 0,
    family TEXT, src TEXT NOT NULL DEFAULT 'crawl',
    dead INTEGER NOT NULL DEFAULT 0, ok_at INTEGER, res TEXT, dead_at INTEGER,
    studio TEXT, rv INTEGER NOT NULL DEFAULT 0,
    UNIQUE (site, vod_id)
);
CREATE INDEX IF NOT EXISTS adult_items_wk ON adult_items(wk);
CREATE INDEX IF NOT EXISTS adult_items_ckey ON adult_items(ckey) WHERE ckey IS NOT NULL;
CREATE INDEX IF NOT EXISTS adult_items_site_ckey ON adult_items(site, ckey) WHERE ckey IS NOT NULL;
CREATE INDEX IF NOT EXISTS adult_items_site_time ON adult_items(site, vod_time);
CREATE INDEX IF NOT EXISTS adult_items_dead ON adult_items(dead_at) WHERE dead = 1;
CREATE TABLE IF NOT EXISTS adult_items_raw (id INTEGER PRIMARY KEY, raw BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS adult_works (
    id INTEGER PRIMARY KEY,
    wk TEXT NOT NULL UNIQUE, name TEXT NOT NULL, code TEXT, ckey TEXT, clean TEXT,
    bucket TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', review TEXT, code_ok INTEGER NOT NULL DEFAULT 0,
    pic TEXT, pic_item TEXT, apic TEXT, dur_med INTEGER NOT NULL DEFAULT 0, dur INTEGER NOT NULL DEFAULT 0,
    n_sites INTEGER NOT NULL DEFAULT 0, sites TEXT NOT NULL DEFAULT '', live_sites TEXT NOT NULL DEFAULT '', first_site TEXT,
    variants TEXT NOT NULL DEFAULT '', flags INTEGER NOT NULL DEFAULT 0, is_clip INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, line_at INTEGER NOT NULL DEFAULT 0,
    ext_hot INTEGER, rand INTEGER NOT NULL DEFAULT 0, hot INTEGER NOT NULL DEFAULT 0, vis INTEGER NOT NULL DEFAULT 0,
    released TEXT NOT NULL DEFAULT '', studio TEXT NOT NULL DEFAULT '', maker TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '',
    avdb INTEGER NOT NULL DEFAULT 0, actress TEXT NOT NULL DEFAULT '', rv INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS adult_works_name ON adult_works(name);
CREATE INDEX IF NOT EXISTS adult_works_ckey ON adult_works(ckey) WHERE ckey IS NOT NULL;
CREATE INDEX IF NOT EXISTS adult_works_new ON adult_works(first_seen DESC, id DESC) WHERE vis = 1;
CREATE INDEX IF NOT EXISTS adult_works_bnew ON adult_works(bucket, first_seen DESC, id DESC) WHERE vis = 1;
CREATE INDEX IF NOT EXISTS adult_works_hot ON adult_works(hot DESC) WHERE hot > 0;
CREATE TABLE IF NOT EXISTS adult_classes (
    api TEXT NOT NULL, type_id INTEGER NOT NULL, type_pid INTEGER NOT NULL DEFAULT 0, type_name TEXT NOT NULL,
    PRIMARY KEY (api, type_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_class_state (api TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, ok INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_crawl_state (
    site TEXT PRIMARY KEY, api TEXT, last_ok INTEGER, next_at INTEGER, mode TEXT, pagesize INTEGER,
    fails INTEGER NOT NULL DEFAULT 0, last_new INTEGER, last_err TEXT, cursor TEXT,
    ignores_h INTEGER NOT NULL DEFAULT 0, n_req INTEGER NOT NULL DEFAULT 0, n_items INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_backfill (
    site TEXT PRIMARY KEY, api TEXT NOT NULL, pg INTEGER NOT NULL DEFAULT 1, pc INTEGER, ps INTEGER,
    done INTEGER NOT NULL DEFAULT 0, started_at INTEGER, updated_at INTEGER, next_at INTEGER NOT NULL DEFAULT 0,
    fails INTEGER NOT NULL DEFAULT 0, last_err TEXT, n_req INTEGER NOT NULL DEFAULT 0, n_items INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_expand (wk TEXT NOT NULL, site TEXT NOT NULL, found INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (wk, site)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_hits (
    site TEXT NOT NULL, vod_id TEXT NOT NULL, day INTEGER NOT NULL, week INTEGER NOT NULL, month INTEGER NOT NULL, total INTEGER NOT NULL,
    at INTEGER NOT NULL, prev_total INTEGER, prev_at INTEGER, PRIMARY KEY (site, vod_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS adult_hits_week ON adult_hits(site, week);
CREATE TABLE IF NOT EXISTS adult_line_fail (site TEXT NOT NULL, vod_id TEXT NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (site, vod_id, who)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_avsig (ckey TEXT PRIMARY KEY, sig TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_heat (wk TEXT PRIMARY KEY, users INTEGER NOT NULL DEFAULT 0, sums BLOB NOT NULL, dur INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_heat_seen (k TEXT PRIMARY KEY, day INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS adult_heat_seen_day ON adult_heat_seen(day);
CREATE TABLE IF NOT EXISTS adult_hidden (wk TEXT PRIMARY KEY, name TEXT, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_share (code TEXT PRIMARY KEY, wk TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', dur INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS adult_share_wk ON adult_share(wk);
`;
// [adult] 第四阶段:原地补的列(老库 ALTER TABLE 补上,只改表头不重写行)。新列上的索引不能写进 DDL(老库还没这一列),在补列之后建
const ADD_COLS = [
    ['adult_items', 'rv', 'INTEGER NOT NULL DEFAULT 0'], ['adult_works', 'rv', 'INTEGER NOT NULL DEFAULT 0'],
    ['adult_items', 'orient', "TEXT NOT NULL DEFAULT ''"],   // 线路画面方向 'v' | 'h' | 'sq' | ''(播放上报的 videoWidth/Height 学来的)
    ['adult_works', 'orient', "TEXT NOT NULL DEFAULT ''"],   // 作品方向 = 线路多数(平票 v 优先)
    ['adult_works', 'hid', 'INTEGER NOT NULL DEFAULT 0'],     // 后台隐藏(adult_hidden 是真相;ELIG 带 w.hid=0,所有读路径都不出)
    // 封面域名健康(cover-health.js):pic_alt = 别的活域名上的候补封面(≤2 个,\n 分隔);cov = 有没有活的封面(0 = 首页 / 浏览 / 相关 / 演员页都不出)
    ['adult_works', 'pic_alt', "TEXT NOT NULL DEFAULT ''"],
    ['adult_works', 'cov', 'INTEGER NOT NULL DEFAULT 1'],
];
// 补上列之后跑一次(只在这一列刚补上时):老库的 cov 先按"有没有封面地址"定,写线程随后按死域名把全部作品重挑一遍(writer.js coverApply)
const AFTER_ADD = {
    'adult_works.cov': "UPDATE adult_works SET cov = 0 WHERE COALESCE(pic, '') = '' AND COALESCE(apic, '') = ''",
};
// 目录自己的表(换结构版本时整体重建;AVDB 的表不动)。
//   adult_hidden / adult_heat* / adult_share 不在里面:后台隐藏是站长的决定、热度是观众攒的、分享出去的链接不能失效,目录重建不能把它们丢掉(丢隐藏 = 放松);
//   adult_meta 里 'admin:*'(追加屏蔽词 / 站点停用)重建时也原样搬回去(见 initSchema)
const OWN_TABLES = ['adult_fts', 'adult_fts2', 'adult_items', 'adult_items_raw', 'adult_works', 'adult_classes', 'adult_class_state', 'adult_crawl_state',
    'adult_backfill', 'adult_expand', 'adult_hits', 'adult_line_fail', 'adult_avsig', 'adult_meta'];

function applyPragmas(db, role, env) {
    const e = env || {};
    try { db.pragma('journal_mode = WAL'); } catch (_) { /* :memory: */ }
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('journal_size_limit = 67108864');
    db.pragma('cache_size = ' + (role === 'writer' || role === 'inline' ? -65536 : -32768));
    const mm = Number(e.CATALOG_MMAP_MB);
    if (Number.isFinite(mm) && mm > 0) db.pragma('mmap_size = ' + Math.floor(Math.min(mm, 4096) * 1048576));
    // 主线程的同步忙等会卡事件循环:读连接只等一小会儿(WAL 下读几乎不会碰到忙)
    db.pragma('busy_timeout = ' + (role === 'main' || role === 'avdbread' ? 150 : role === 'reader' ? 2000 : 5000));
    if (role === 'main' || role === 'reader') db.pragma('query_only = 1');
}

function hasTable(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name); }

// 建表 / 换版本。返回 {fts, bigram}
function initSchema(db) {
    let ver = null;
    if (hasTable(db, 'adult_meta')) { try { const r = db.prepare("SELECT v FROM adult_meta WHERE k='schema'").get(); ver = r ? r.v : null; } catch (_) { ver = null; } }
    // 第一 / 二阶段的表(WITHOUT ROWID、行内 raw)或别的版本 → 目录可以重建:整体删掉重来
    let old = ver != null && ver !== SCHEMA_VERSION;
    if (ver == null && hasTable(db, 'adult_items')) {
        const cols = new Set(db.prepare('PRAGMA table_info(adult_items)').all().map((r) => r.name));
        if (!cols.has('id') || cols.has('raw')) old = true;
    }
    // 站长设置('admin:*')在重建时原样搬回去:丢了 = 放松(追加屏蔽词 / 站点停用失效)
    let adminKeep = [];
    if (old && hasTable(db, 'adult_meta')) { try { adminKeep = db.prepare("SELECT k, v FROM adult_meta WHERE k LIKE 'admin:%'").all(); } catch (_) { adminKeep = []; } }
    if (old) db.transaction(() => { for (const t of OWN_TABLES) db.exec('DROP TABLE IF EXISTS ' + t); })();
    db.exec(DDL);
    if (adminKeep.length) { const ins = db.prepare('INSERT OR REPLACE INTO adult_meta (k, v) VALUES (?, ?)'); for (const r of adminKeep) ins.run(r.k, r.v); }
    // 后加的列(rv = 规则代数,见 common.js ELIG;orient / hid 第四阶段):同版本的旧库原地补上(只改表头,不重写行)
    const colsOf = new Map();
    for (const [t, c, decl] of ADD_COLS) {
        if (!colsOf.has(t)) colsOf.set(t, new Set(db.prepare('PRAGMA table_info(' + t + ')').all().map((r) => r.name)));
        if (!colsOf.get(t).has(c)) {
            db.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + c + ' ' + decl);
            colsOf.get(t).add(c);
            if (AFTER_ADD[t + '.' + c]) db.exec(AFTER_ADD[t + '.' + c]);
        }
    }
    // 隐藏标记补列之后按 adult_hidden 对一遍(老库第一次补列 / 作品行被重建过)
    try { db.exec('UPDATE adult_works SET hid = 1 WHERE hid = 0 AND wk IN (SELECT wk FROM adult_hidden)'); } catch (_) { /* */ }
    let fts = false, bigram = false;
    try { db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS adult_fts USING fts5(name, code, content='adult_works', content_rowid='id', tokenize='trigram')"); fts = true; }
    catch (_) { fts = false; }   // 没有 fts5/trigram 的 SQLite:本地查找退回 LIKE
    try { db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS adult_fts2 USING fts5(bg, content='', contentless_delete=1, columnsize=0, detail='none', tokenize='unicode61')"); bigram = true; }
    catch (_) {
        try { db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS adult_fts2 USING fts5(bg, content='', columnsize=0, detail='none', tokenize='unicode61')"); bigram = true; } catch (__) { bigram = false; }
    }
    db.prepare("INSERT OR REPLACE INTO adult_meta (k, v) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    return { fts, bigram };
}
// 读连接看看有哪些全文表(不建)
function probeSchema(db) {
    return { fts: hasTable(db, 'adult_fts'), bigram: hasTable(db, 'adult_fts2'), ready: hasTable(db, 'adult_works') };
}

// 两字中文:CJK 连续段切成重叠的两字词,字母数字整段小写(调研 extra-bench:0.05 ms vs 全表 LIKE 563 ms @2M)
const CJK_RUN = /[぀-ヿ㐀-鿿豈-﫿]+|[A-Za-z0-9]+/g;
function bigrams(s) {
    const out = [];
    for (const m of String(s || '').normalize('NFKC').match(CJK_RUN) || []) {
        if (/^[A-Za-z0-9]+$/.test(m)) { out.push(m.toLowerCase()); continue; }
        const c = [...m];
        if (c.length === 1) out.push(c[0]);
        for (let i = 0; i + 1 < c.length; i++) out.push(c[i] + c[i + 1]);
    }
    return out.join(' ');
}

function openDb(file, role, env) {
    const Database = require('better-sqlite3');
    const db = new Database(file, role === 'main' || role === 'reader' || role === 'avdbread' ? { fileMustExist: true } : {});
    applyPragmas(db, role, env);
    return db;
}

module.exports = { SCHEMA_VERSION, DDL, ADD_COLS, OWN_TABLES, applyPragmas, initSchema, probeSchema, bigrams, openDb, hasTable };
