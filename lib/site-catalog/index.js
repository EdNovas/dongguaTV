// [adult] 成人站首页目录(catalog mode):后台按 maccms 增量接口爬资源站 → SQLite 索引 → 预计算首页 / 分类浏览 / 作品线路。
//
// 为什么这样做(调研 .adult-research/analysis/verdict.md §2-§6):
//   · 成人内容没有 TMDB:首页只能用资源站自己的"新上架"拼。上游 vod_hits 在 45/49 个站是随机数,不能当热度;
//     `ac=detail&h=<小时>` 全站都支持且一律新的在前 → 每站只拉"上次成功以来"的增量,稳态 ≈1 请求/分钟。
//   · 页面请求零上游调用:home() / browse() / buckets() 全读预计算快照(每 10 分钟重建),work() 只读库,
//     只有 work(wk,{expand:true}) 会现搜别的站补线路(全局信号量 ≤12、每次扩线 ≤6、按 (作品,站) 正缓存 6h / 负缓存 24h、同作品并发合并)。
//   · 绝不拉 m3u8 / 图片:所有出网请求都过 guardUrl —— 只能是 `<站 api>?ac=list` / `<站 api>?ac=detail…`,其它一律 throw。
//   · 入库顺序 fail-closed(调研 §2):分类硬过滤 → 主流影视丢弃 → policy.checkItem(条目文本)→ 审查级 → 大类
//     (mixed/uncat 只有可信番号或片名带假名才进日本区,否则进国产自拍)→ parseTitle → 作品键 → upsert。被拦的条目一行都不写。
//     分类表(ac=list)没拉到 / 条目的 type_id 不在表里 → 整条不收(父分类硬过滤要靠分类表才看得见),并安排 1h 内重拉分类表。
//   · 作品键(wk):
//       可信番号(codeOk)→ 'c:<KEY>';日本有码的无码流出/破解版 → 'c:<KEY>#U'(独立卡片);
//       解说/水果派/预告片段(标题或"解说"分类)或时长 < 本作品 50% → 'c:<KEY>#clip'(独立,不算线路);
//       没有可信番号 → 't:<titleKey>'(只按精确标题键合并)。
//       不论哪种,两边时长都知道且差 > 3% + 5s 就不合并,落到 '<键>~2'、'~3'…(JUL-123 这类占位番号被不同片子反复贴,靠这个分开)。
//       同站同番号挂在 ≥3 个不同标题上且时长对不上 → 这个站的这个番号当假番号(不可信,不进 c: 键)。
//   · 作品名(name)首次见到就冻结(番号作品 = "番号 净标题",重名加 " · 2"):历史 / 收藏 / 热门都按片名记,
//     同一作品各站标题不一样(调研:跨站同番号 47.8% 标题不同),不能跟着某个站的标题变。
//   · 首页每行同一来源站(或同家族)连续不超过 4 张:按时间倒序直接排会出现一个站连排 200 张(调研实测)。
//   · 每次读都套审查过滤 review<>'hide' AND (review<>'code' OR code_ok=1)(入库时已经拦过,这里是第二道)。
//   · 规则版本(adult.RULES_VERSION)变了:启动后把库里所有条目按新规则重跑一遍(raw 列存了政策要看的字段),
//     重跑完之前所有读接口回空(fail-closed),不合格的行直接删。
//   · 30 天没再见到的条目删掉(deps.referenced 给出的作品名 / wk 例外:历史、收藏还引用着)。
//
// 用法(server.js,CACHE_TYPE=sqlite):
//   const catalog = require('./lib/site-catalog').createCatalog({
//       db: () => cacheManager.db,            // better-sqlite3 实例,或返回它的函数(拿不到 = 所有接口回空)
//       getSites: () => adultSites(),         // [{key,name,api,search?,active?,codeTrust?,family?,crawlMode?,searchFirst?}]
//       adult: require('./lib/adult'),
//       httpGet: async (url, {timeout}) => body,   // 解析好的 JSON(字符串也认),失败 throw
//       log: (m) => console.log(m), env: process.env,
//       referenced: () => namesOrWks,         // 可选:保留期内不能删的作品名 / wk
//       socketsBusy: () => n,                 // 可选:出网连接数 > 48 时本轮爬虫暂停
//       now / sleep / opts                    // 仅测试:假时钟、假 sleep、覆盖 DEF 常量
//   });
//   catalog.start();
// 接口:start() / stop() / home() / browse(q) / buckets() / work(wk,{expand}) / classInfo(siteKey,typeId) / ingestSearchItems(siteKey,rawItems) / stats()
//   扩展:tick()(跑一轮爬虫,返回本轮摘要)/ rebuild()(立即重建快照)/ retention() / flush()(等搜索回写队列和规则重扫跑完)/
//         lookup(q,{limit})(本地查找,零上游)/ RULES_VERSION
//   第二阶段:tags(b) / suggest(q) / beacon(r, who) / picUrl(wk, site, {meta}) / imgProxy;deps.popularTitles()(可选,本站热门行)
//         browse(q) 的 q 还认 lp(厂牌前缀 /^[A-Z0-9]{2,10}$/,只出番号作品键 ckey 以 'LP-' 开头的;非法 → 空页)
//   httpGet 的第二个参数是 {timeout, siteKey}。
// 环境变量:CATALOG_DISABLE=1(不启动爬虫,读接口照常)/ CATALOG_FIRST_DELAY_MS(默认 60000)/ CATALOG_MAX_SITES(只爬前 N 个站)/
//          CATALOG_EXT_HOT_SITE(外站计数站 key,默认 av_s31;站点表 extHot:true 优先)/ ADULT_IMG_PROXY=1(卡片/线路封面改写成 /api/img)
//
// 第二阶段(调研 verdict §3-§8 "phase 2"):
//   · 热门行(首页紧跟 新上架):本站热门 = deps.popularTitles()(lib/popular 7 天、隐私门槛,按片名 = adult_works.name 对上作品),
//     够 12 部才用;否则 外站热门 = 外站计数站(站点表 extHot:true,没有就 CATALOG_EXT_HOT_SITE,默认 av_s31)的 hits_week(有能播的就出,不设下限)。
//     外站计数:爬虫顺手记下 vod_hits*,再按 ids=(每批 20、每小时 ≤10 个请求,走爬虫的预算和同域名间隔)复取热门 200 部;
//     每周做一次可信检查(≥95% 满足 日≤周≤月≤总、分布不是均匀随机(KS)、两次取数之间计数在涨),不过 → 没有外站热门行。
//     两种都只收 至少有一条没被判死的线路 的作品。
//   · tags(b):当前快照里各标签的作品数(前 24、降序);审查级标签(强制凌辱/乱伦/催眠/时间停止…)featured:false,前端不做成导航标签。
//       厂牌 / 无码 / 中字 不在这个列表里(NO_CHIP_TAGS:没筛选意义或和「标记」筛选重复)。
//   · suggest(q):本地联想(零上游):被拦 / 番号(恰好一部正片 → exact)/ 分区·标签别名 / 文字(≥3 字 FTS trigram,≤2 字 LIKE)。
//   · beacon(r, who):播放结果上报(零上游)。24h 内 ≥3 个不同上报者失败、且之后没有成功 → 线路判死;之后任何一次成功 → 复活;
//     who = 调用方算好的上报者哈希(adult-gate:有效令牌 + 可信客户端网络);who 为空 = 认不出的匿名上报者,失败不计数;
//     成功带时长 → 补上不知道的时长(和作品时长对得上才收)并重算作品中位数;带宽高 → 记分辨率。
//   · work():线路加 _family/_dead/_res/_native/_same,排序 = 活的在前、同家族挨着、再按原顺序;_meta 加 分区名/标签/厂牌前缀/
//     演员(只认 vod_actor 或 title.js 有把握的解析;纯汉字的猜测不要;国产自拍/探花/主播/网红 一律不给)/兄弟作品 main|U|clip/首见时间。
//   · picUrl(wk, site):封面代理(lib/site-catalog/img.js)查地址用;ADULT_IMG_PROXY=1 时卡片 / 线路的封面改写成 /api/img?k=&s=。
//   · 薄分区回填:每周一次,最近 30 天作品 <60 部的导航分区,按叶子分类拉 &t=<叶子 id>&pagesize=60(每个叶子 ≤10 页,绝不拉父分类),
//     用爬虫的预算 / 同域名间隔,每轮最多 backfillPerTick 个请求,首轮爬取 6h 之后才开始。
//   · 站点表字段:codeTrust:false(番号一律不可信)/ strict:true(policy.checkItem 收到 ctx.strict=true;政策回的 codeOk 更严时以它为准)/
//     nativeHls:false(线路 _native='risky')/ extHot:true(外站计数站)/ upstream:'<组名>'(同一上游不同 CDN 的站,线路 _same 相同)/
//     family:'<组名>' 只给【真镜像】(同一后端换域名/站名,内容逐字节相同:2609 家、souav、豆豆/滴滴、CK/伦理吧…)——
//     前端把同 family 的线路收成一张「+N 备用」并当自动切换的备用;调研时按播放技术/CDN 分的组(jpg 分片、单贴片、cdn2020…)不是镜像,别填进 family。
'use strict';

const U = require('./util');
const { MIN, HOUR, DAY } = U;

const DEF = {
    // 爬虫
    firstDelayMs: 60e3,          // 启动后多久跑第一轮(别和启动预热抢出网)
    tickMs: 5 * MIN,             // 调度轮询间隔(每轮只爬到期的站)
    maxReqPerTick: 120,          // 每轮全站最多几个请求(含 ac=list)
    concurrency: 2,              // 同时爬几个站
    hostGapMs: 2000,             // 同一域名两次请求至少隔多久(上一次结束 → 下一次开始);同域名同时最多 1 个
    timeoutMs: 10000,
    pageSize: 60,                // ac=detail&pagesize=60;站点不认(一页只回 20)就记下来以后用 20
    pageSizeCapped: 20,
    maxHours: 72,                // h = 距上次成功的小时数 + 1,最多 72
    maxPagesPerCrawl: 40,        // 单站单次最多翻几页(不认 h 的站兜底)
    continuousMs: 30 * MIN,      // 持续上新的站(s03/s25/s41/s42/s43 这类)
    batchMs: 60 * MIN,           // 每天一批的站
    staleMs: 6 * HOUR,           // 7 天没新东西的站
    staleAfterMs: 7 * DAY,
    continuousHours: 6,          // 最近 24h 的条目落在 ≥6 个不同钟点 → 持续上新
    failBackoff: [10 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR],
    classMs: DAY,                // 分类表每天重拉一次
    classRetryMs: HOUR,          // 拉失败 / 见到不认识的 type_id → 1h 内重拉
    socketsPause: 48,
    // 首页 / 浏览
    homeMs: 10 * MIN,            // 首页 / 浏览快照重建间隔(同一快照里翻页稳定)
    rowSize: 24,
    poolSize: 400,               // 每行候选池(打散连排要从后面捞别的站)
    rowMin: 12,                  // 大类行少于 12 部 → 不显示
    rowStaleMs: 72 * HOUR,       // 大类行最新一部超过 72h → 不显示
    maxRun: 4,                   // 同站(家族)连续最多几张
    slotMs: HOUR,                // 新上架按 1h 一槽轮流出
    browsePage: 24,
    maxPages: 500,
    browseCacheMax: 64,          // 每个快照最多缓存几种筛选组合的排序结果
    // 线路
    playTtlMs: 3 * DAY,          // 播放地址超过 3 天没刷新 → 不给(前端会走 /api/detail 现取)
    // 扩线
    expandGlobal: 12,            // 全进程同时最多 12 个扩线上游请求
    expandPer: 6,                // 单次扩线同时最多 6 个
    expandPosMs: 6 * HOUR,
    expandNegMs: 24 * HOUR,
    expandTimeoutMs: 8000,
    expandMaxReq: 60,            // 单次扩线最多几个请求
    expandDeadlineMs: 20000,     // 单次扩线超过这么久不再发新请求
    // 入库
    retentionMs: 30 * DAY,
    retentionEveryMs: 6 * HOUR,
    searchQueueMax: 3000,        // 搜索回写队列最多积压几条(超了丢,不影响搜索本身)
    rescanChunk: 500,
    maxPlayUrl: 20000,           // 播放串太长(几百集)不存,前端走 /api/detail
    maxContent: 1500,            // raw 里简介最多存多少字(规则变了重扫用)
    // 热门行
    hotMin: 12,                  // 本站热门够 12 部才用(不够 → 外站热门)
    extHotMin: 12,               // 外站热门:与本站热门同一门槛(不足 12 部不出整行,免得首页出一行 1~2 张卡)
    extHotSite: 'av_s31',        // 站点表没有 extHot:true 时按这个 key 认外站计数站(env CATALOG_EXT_HOT_SITE 覆盖)
    hitsBatch: 20,               // ids= 每批几个
    hitsPerHour: 10,             // 每小时最多几个计数请求
    hitsPerTick: 2,              // 每轮最多几个(摊开,不一次用完一小时的额度)
    hitsTop: 200,                // 复取热门前多少部
    hitsFreshMs: 72 * HOUR,      // 外站热门只看最近 72h 取到过计数的条目
    hitsRefreshMs: HOUR,         // 同一条目至少隔多久才复取
    trustEveryMs: 7 * DAY,       // 可信检查每周一次
    trustMinN: 30,               // 至少多少条计数才判
    trustMinPairs: 10,           // 至少多少条"隔 ≥2 分钟复取过"的才判计数在不在涨
    trustOrderFrac: 0.95,
    trustGrowFrac: 0.5,
    trustGapMs: 2 * MIN,
    // 上报
    deadTokens: 3,               // 24h 内几个不同上报者失败 → 判死
    deadWindowMs: DAY,
    // 薄分区回填
    backfillEveryMs: 7 * DAY,
    backfillDelayMs: 6 * HOUR,   // 第一次爬取之后多久才开始第一次回填(先让增量爬虫把分区填起来)
    backfillThin: 60,            // 最近 30 天作品数 < 60 → 薄
    backfillPages: 10,           // 每个叶子分类最多翻几页
    backfillPerTick: 12,         // 每轮最多几个回填请求
};

// 首页 13 个大类行(调研 §3 顺序)
const HOME_BUCKETS = ['cn_amateur', 'cn_studio', 'cn_hookup', 'live', 'creators', 'short', 'jp_censored', 'jp_uncensored', 'jp_subbed', 'western', 'anime', 'softcore', 'fetish'];
const SORTS = new Set(['new', 'dur', 'random', 'lines']);
const DURS = { s: [1, 599], m: [600, 3600], l: [3601, 1e9] };
const BFLAGS = new Set(['zh', 'unc', 'multi']);
const MODES = new Set(['continuous', 'batch', 'stale']);
const F_ZH = 1, F_UNC = 2, F_LEAK = 4, F_CLIP = 8, F_UHD = 16;
const JP_KINDS = /^(?:jav|jav-cid|fc2|heyzo|uncen-date|tokyohot|h4610)$/;
const KANA = /[ぁ-ゖゝ-ゟァ-ヺヽ-ヿ]/;
// 查询串里出现这些 = 不是 maccms 列表/详情请求(m3u8 / 图片 / 分片),一律拒绝
const BAD_QS = /m3u8|\.(?:jpe?g|png|gif|webp|bmp|avif|ts|mp4|key)(?:$|[?#&])/i;
const REVIEW_RANK = { filter: 1, code: 2, hide: 3 };
const ELIG = "COALESCE(w.review,'') <> 'hide' AND (COALESCE(w.review,'') <> 'code' OR w.code_ok = 1)";
const ELIG_I = "COALESCE(i.review,'') <> 'hide' AND (COALESCE(i.review,'') <> 'code' OR i.code_ok = 1)";
const WCOLS = 'w.wk, w.name, w.pic, w.pic_item, w.bucket, w.code, w.dur_med, w.n_sites, w.sites, w.first_site, w.flags, w.first_seen';
// 审查级标签:不做成导航标签(featured:false),只在浏览筛选里可选(调研 §4)。另外 taxonomy 给标签名判出 code/hide 审查级的也算
const NONFEATURED = new Set(['noncon', 'incest', 'hypnosis', 'timestop', 'time_stop', 'rape', 'forced', 'sleep', 'drunk', 'teen', 'student']);
// 这些分区里的人名多半是素人 / 主播本人:作品页一律不给演员(调研 §6)
const NO_ACTRESS_BUCKETS = new Set(['cn_amateur', 'cn_hookup', 'live', 'creators']);
// 不进浏览页标签行的:「厂牌」没有筛选意义;「无码」「中字」浏览页已有「标记」筛选(flag=unc/zh),在日本有码分类里出「无码」还自相矛盾。
//   作品页的标签照常给;&tag= 照常能筛
const NO_CHIP_TAGS = new Set(['studio', 'uncensored', 'subbed']);
const TITLE_ACTRESS_BUCKETS = new Set(['jp_censored', 'jp_uncensored', 'jp_subbed', 'fetish', 'lgbt']);   // 片名解析出的演员名只在这些分区用
const ACTOR_JUNK = /^(?:未知|佚名|内详|暂无|无|不详|未知演员|素人|网红|主播|国产|其他|其它|多人|群星|美女|女优|演员|n\/?a|none|null|unknown|various|anonymous|amateur)$/i;
// 第二阶段新增列(旧库启动时补上)
const ITEM_COLS_P2 = [['dead', 'INTEGER NOT NULL DEFAULT 0'], ['ok_at', 'INTEGER'], ['res', 'TEXT'], ['dead_at', 'INTEGER']];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS adult_items (
    site TEXT NOT NULL, vod_id TEXT NOT NULL,
    wk TEXT NOT NULL, bucket TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
    review TEXT, code_ok INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL, clean TEXT, code TEXT, ckey TEXT, tkey TEXT,
    pic TEXT, dur INTEGER NOT NULL DEFAULT 0, vod_time INTEGER,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    type_id INTEGER, type_name TEXT,
    play_from TEXT, play_url TEXT, play_at INTEGER,
    variant TEXT NOT NULL DEFAULT '', flags INTEGER NOT NULL DEFAULT 0,
    family TEXT, src TEXT NOT NULL DEFAULT 'crawl', raw TEXT,
    PRIMARY KEY (site, vod_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS adult_items_wk ON adult_items(wk);
CREATE INDEX IF NOT EXISTS adult_items_bucket ON adult_items(bucket, first_seen);
CREATE INDEX IF NOT EXISTS adult_items_seen ON adult_items(last_seen);
CREATE INDEX IF NOT EXISTS adult_items_ckey ON adult_items(site, ckey);
CREATE TABLE IF NOT EXISTS adult_works (
    wk TEXT NOT NULL UNIQUE, name TEXT NOT NULL, code TEXT, ckey TEXT, clean TEXT,
    bucket TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', review TEXT, code_ok INTEGER NOT NULL DEFAULT 0,
    pic TEXT, pic_item TEXT, dur_med INTEGER NOT NULL DEFAULT 0,
    n_sites INTEGER NOT NULL DEFAULT 0, sites TEXT NOT NULL DEFAULT '', first_site TEXT,
    variants TEXT NOT NULL DEFAULT '', flags INTEGER NOT NULL DEFAULT 0, is_clip INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, ext_hot INTEGER, rand INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS adult_works_bucket ON adult_works(bucket, first_seen);
CREATE INDEX IF NOT EXISTS adult_works_first ON adult_works(first_seen);
CREATE INDEX IF NOT EXISTS adult_works_name ON adult_works(name);
CREATE INDEX IF NOT EXISTS adult_works_ckey ON adult_works(ckey);
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
CREATE TABLE IF NOT EXISTS adult_expand (wk TEXT NOT NULL, site TEXT NOT NULL, found INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (wk, site)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS adult_hits (
    site TEXT NOT NULL, vod_id TEXT NOT NULL, day INTEGER NOT NULL, week INTEGER NOT NULL, month INTEGER NOT NULL, total INTEGER NOT NULL,
    at INTEGER NOT NULL, prev_total INTEGER, prev_at INTEGER, PRIMARY KEY (site, vod_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS adult_hits_week ON adult_hits(site, week);
CREATE TABLE IF NOT EXISTS adult_line_fail (site TEXT NOT NULL, vod_id TEXT NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (site, vod_id, who)) WITHOUT ROWID;
`;

// 布尔开关:只认 1/true/yes/on("填 0 反而关掉"的坑见 memory envFlag)
function envFlag(v) { return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim()); }
function envInt(v, def, min) {
    if (v == null || String(v).trim() === '') return def;
    const n = Number(String(v).trim());
    return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
}
const str = (v, n) => (v == null ? '' : U.clip(v, n || 20000));

function createCatalog(deps) {
    deps = deps || {};
    const A = deps.adult || require('../adult');   // 规则坏了这里就 throw(fail-closed)
    const T = A.title, P = A.policy, X = A.taxonomy;
    const RULES_VERSION = A.RULES_VERSION || P.RULES_VERSION;
    const NAV = new Set(X.NAV_BUCKETS);
    const DROP = new Set(X.DROP_BUCKETS);
    const env = deps.env || {};
    const C = Object.assign({}, DEF, deps.opts || {});
    C.firstDelayMs = envInt(env.CATALOG_FIRST_DELAY_MS, C.firstDelayMs, 0);
    const MAX_SITES = envInt(env.CATALOG_MAX_SITES, 0, 1);
    const DISABLED = envFlag(env.CATALOG_DISABLE);
    const IMG_PROXY = envFlag(env.ADULT_IMG_PROXY);
    const EXT_HOT_KEY = String(env.CATALOG_EXT_HOT_SITE || C.extHotSite || '').trim();
    const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;
    // sleep 不能 unref:单独跑一轮(冒烟脚本)时进程会在两次请求的间隔里直接退出
    const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
    // 注入的 log 自己加前缀(server.js 传的是 '[Catalog] ' + msg);默认 console.log 才由这里加
    const logFn = typeof deps.log === 'function' ? deps.log : (m) => console.log('[Catalog] ' + m);
    const log = (m) => { try { logFn(m); } catch (_) { /* 日志坏了不影响 */ } };
    const warnAt = new Map();
    const warn = (tag, m) => {
        const t = Date.now();
        if ((warnAt.get(tag) || 0) + 60e3 > t) return;
        if (warnAt.size > 500) warnAt.clear();
        warnAt.set(tag, t);
        log(tag + ': ' + m);
    };
    const HOME_B = HOME_BUCKETS.filter((b) => NAV.has(b));

    const stats = {
        requests: 0, ingested: 0, rejected: Object.create(null), flags: Object.create(null), migrated: 0,
        expand: { runs: 0, cached: 0, coalesced: 0, requests: 0, errors: 0, found: 0 },
        searchDropped: 0, retention: null,
        hits: { requests: 0, errors: 0, items: 0 },
        backfill: { runs: 0, requests: 0, items: 0 },
        beacon: { ok: 0, fail: 0, ignored: 0, dead: 0, revived: 0, dur: 0, res: 0 },
    };
    const bump = (m, k, n) => { if (!(k in m) && Object.keys(m).length >= 200) k = 'other'; m[k] = (m[k] || 0) + (n || 1); };

    // ---------- 数据库 ----------
    const inited = new WeakSet();
    let ftsOk = false;
    let rescanPending = false, rescanP = null;
    let stmtDb = null;
    const stmts = new Map();
    const q = (d, sql) => {
        if (d !== stmtDb) { stmts.clear(); stmtDb = d; }
        let s = stmts.get(sql);
        if (!s) { s = d.prepare(sql); stmts.set(sql, s); }
        return s;
    };
    function dbOf() {
        let d = null;
        try { d = typeof deps.db === 'function' ? deps.db() : deps.db; } catch (_) { d = null; }
        if (!d || typeof d.prepare !== 'function') return null;
        if (!inited.has(d)) {
            try { initDb(d); inited.add(d); } catch (e) { warn('init', e.message); return null; }
        }
        return d;
    }
    function initDb(d) {
        d.exec(SCHEMA);
        const have = new Set(d.prepare('PRAGMA table_info(adult_items)').all().map((r) => r.name));
        for (const [c, def] of ITEM_COLS_P2) if (!have.has(c)) d.exec(`ALTER TABLE adult_items ADD COLUMN ${c} ${def}`);
        try { d.exec("CREATE VIRTUAL TABLE IF NOT EXISTS adult_fts USING fts5(name, code, tokenize='trigram')"); ftsOk = true; }
        catch (_) { ftsOk = false; }   // 没有 fts5/trigram 的 SQLite:本地查找退回 LIKE
        checkRules(d);
    }
    const getMeta = (d, k) => { const r = q(d, 'SELECT v FROM adult_meta WHERE k=?').get(k); return r ? r.v : null; };
    const setMeta = (d, k, v) => q(d, 'INSERT OR REPLACE INTO adult_meta (k, v) VALUES (?, ?)').run(k, v);

    // ---------- 站点 ----------
    function normSite(s) {
        if (!s || typeof s !== 'object') return null;
        const key = typeof s.key === 'string' ? s.key.trim() : '';
        const api = typeof s.api === 'string' ? s.api.trim() : '';
        if (!key || key.length > 64 || !/^https?:\/\/[^\s#]+$/i.test(api) || /m3u8/i.test(api)) return null;
        return {
            key, api,
            name: U.clip(s.name || key, 60),
            search: s.search !== false,
            active: s.active !== false && !s.alias,
            codeTrust: s.codeTrust !== false,
            family: typeof s.family === 'string' && s.family ? U.clip(s.family, 40) : '',
            crawlMode: MODES.has(s.crawlMode) ? s.crawlMode : '',
            searchFirst: !!s.searchFirst,
            crawl: s.crawl !== false,
            strict: s.strict === true,
            nativeHls: s.nativeHls !== false,
            extHot: s.extHot === true,
            upstream: typeof s.upstream === 'string' && s.upstream ? U.clip(s.upstream, 40) : '',
        };
    }
    // 外站计数站:站点表 extHot:true 优先,否则按 key(CATALOG_EXT_HOT_SITE / 默认 av_s31)
    function extHotSite(act) {
        const m = act || activeSites();
        for (const s of m.values()) if (s.extHot) return s;
        return (EXT_HOT_KEY && m.get(EXT_HOT_KEY)) || null;
    }
    function allSites() {
        let list;
        try { list = typeof deps.getSites === 'function' ? deps.getSites() : []; } catch (e) { warn('sites', e.message); list = []; }
        const m = new Map();
        for (const s of Array.isArray(list) ? list : []) { const n = normSite(s); if (n && !m.has(n.key)) m.set(n.key, n); }
        return m;
    }
    function activeSites() {
        const m = new Map();
        for (const [k, s] of allSites()) if (s.active) m.set(k, s);
        return m;
    }
    function crawlSites() {
        let a = [...activeSites().values()].filter((s) => s.crawl);
        if (MAX_SITES) a = a.slice(0, MAX_SITES);
        return a;
    }
    const urlFor = (site, qs) => site.api + (site.api.indexOf('?') >= 0 ? '&' : '?') + qs;

    // ---------- 出网(只许 ac=list / ac=detail) ----------
    function guardUrl(site, url) {
        const pre = site.api + (site.api.indexOf('?') >= 0 ? '&' : '?');
        if (typeof url !== 'string' || url.indexOf(pre) !== 0) throw new Error('refused url (not site api)');
        const qs = url.slice(pre.length);
        if (!/^ac=(?:list|detail)(?:&|$)/.test(qs) || BAD_QS.test(qs)) throw new Error('refused url');
    }
    async function doGet(url, timeout, siteKey) {
        if (typeof deps.httpGet !== 'function') throw new Error('no httpGet');
        stats.requests++;
        let body = await deps.httpGet(url, { timeout, siteKey });   // siteKey:server.js 的代理回退记忆用
        if (Buffer.isBuffer(body)) body = body.toString('utf8');
        if (typeof body === 'string') body = JSON.parse(body.replace(/^﻿/, '').trim());
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
        return body;
    }
    // 爬虫 / 分类表:同域名串行 + 两次之间 ≥ hostGapMs
    const hostLast = new Map();
    const hostQ = new Map();
    function gatedGet(site, url) {
        guardUrl(site, url);
        const host = U.hostOf(url) || site.api;
        const prev = hostQ.get(host) || Promise.resolve();
        const run = prev.then(async () => {
            const last = hostLast.get(host);
            if (last != null) { const wait = last + C.hostGapMs - nowFn(); if (wait > 0) await sleep(wait); }
            try { return await doGet(url, C.timeoutMs, site.key); } finally { hostLast.set(host, nowFn()); }
        });
        const tail = run.then(() => {}, () => {});
        hostQ.set(host, tail);
        tail.then(() => { if (hostQ.get(host) === tail) hostQ.delete(host); });
        return run;
    }
    const gsem = new U.Sem(C.expandGlobal);
    async function withGlobal(fn) {
        await gsem.acquire();
        try { return await fn(); } finally { gsem.release(); }
    }

    // ---------- 分类表(按 API 地址,ac=list 每天一次) ----------
    const cmaps = new Map();
    function classMapFor(api) {
        const d = dbOf();
        if (!d) return null;
        const hit = cmaps.get(api);
        if (hit && hit.db === d) return hit;
        const rows = q(d, 'SELECT type_id, type_pid, type_name FROM adult_classes WHERE api=?').all(api);
        if (!rows.length) return null;
        const byId = X.buildClassMap(rows, { host: api });
        const byName = new Map();
        for (const [id, row] of byId) {
            const k = X.normName(row.name);
            const e = byName.get(k);
            if (!e || (row.block && !e.row.block)) byName.set(k, { id, row });   // 同名分类:硬过滤的那个说了算
        }
        const m = { db: d, byId, byName };
        cmaps.set(api, m);
        return m;
    }
    function classState(d, api) { return q(d, 'SELECT fetched_at, ok FROM adult_class_state WHERE api=?').get(api) || null; }
    function needClass(d, api) {
        const r = classState(d, api);
        if (!r) return true;
        const age = nowFn() - (r.fetched_at || 0);
        return r.ok ? age >= C.classMs : age >= C.classRetryMs;
    }
    function markClassFail(d, api) {
        q(d, 'INSERT INTO adult_class_state (api, fetched_at, ok) VALUES (?, ?, 0) ON CONFLICT(api) DO UPDATE SET fetched_at=excluded.fetched_at, ok=0').run(api, nowFn());
    }
    function forceClassRefresh(d, api) {
        q(d, 'UPDATE adult_class_state SET fetched_at = MIN(fetched_at, ?) WHERE api=?').run(nowFn() - C.classMs + C.classRetryMs, api);
    }
    async function fetchClassMap(site) {
        const j = await gatedGet(site, urlFor(site, 'ac=list'));
        const d = dbOf();
        if (!d) throw new Error('no db');
        const rows = (Array.isArray(j.class) ? j.class : [])
            .map((c) => (c && typeof c === 'object' ? { id: Number(c.type_id), pid: Number(c.type_pid) || 0, name: U.clip(c.type_name == null ? '' : c.type_name, 60).trim() } : null))
            .filter((r) => r && Number.isFinite(r.id) && r.name);
        if (!rows.length) throw new Error('ac=list 没有 class');
        d.transaction(() => {
            q(d, 'DELETE FROM adult_classes WHERE api=?').run(site.api);
            const ins = q(d, 'INSERT OR REPLACE INTO adult_classes (api, type_id, type_pid, type_name) VALUES (?, ?, ?, ?)');
            for (const r of rows) ins.run(site.api, r.id, r.pid, r.name);
            q(d, 'INSERT OR REPLACE INTO adult_class_state (api, fetched_at, ok) VALUES (?, ?, 1)').run(site.api, nowFn());
        })();
        cmaps.delete(site.api);
        return rows.length;
    }
    // 搜索回写 / 扩线用:没有分类表就现拉一次(同 API 并发合并,失败 1h 内不再试)
    const classInflight = new Map();
    async function ensureClassMap(site) {
        const d = dbOf();
        if (!d) return null;
        const have = classMapFor(site.api);
        if (have) return have;
        const r = classState(d, site.api);
        if (r && !r.ok && nowFn() - r.fetched_at < C.classRetryMs) return null;
        let p = classInflight.get(site.api);
        if (!p) {
            p = fetchClassMap(site).catch((e) => { const d2 = dbOf(); if (d2) markClassFail(d2, site.api); warn('class ' + site.key, e.message); })
                .finally(() => classInflight.delete(site.api));
            classInflight.set(site.api, p);
        }
        await p;
        return classMapFor(site.api);
    }
    function classInfo(siteKey, typeId) {
        try {
            const s = allSites().get(String(siteKey));
            if (!s) return null;
            const m = classMapFor(s.api);
            if (!m) return null;
            const r = m.byId.get(Number(typeId));
            if (!r) return null;
            return { name: r.name, parentName: r.parentName, bucket: r.bucket, review: r.review, block: !!r.block };
        } catch (e) { warn('classInfo', e.message); return null; }
    }

    // ---------- 入库 ----------
    // mixed / uncat 分类:可信日本番号或片名带假名 → 日本区(按 中字 / 无码 / 有码);可信国产番号 → 国产传媒;其余 → 国产自拍
    function route(parsed, codeOk, name) {
        const f = parsed.flags || {};
        if ((codeOk && JP_KINDS.test(parsed.kind || '')) || KANA.test(name)) return f.chineseSub ? 'jp_subbed' : (f.uncensored ? 'jp_uncensored' : 'jp_censored');
        if (codeOk && parsed.kind === 'cn') return 'cn_studio';
        return 'cn_amateur';
    }
    // 同站同番号挂在 ≥3 个不同标题上、时长又对不上(或没时长可比)→ 这个站在乱贴番号
    function autoFlagged(d, siteKey, vodId, parsed, dur) {
        if (!parsed || !parsed.key) return false;
        const rows = q(d, 'SELECT tkey, dur FROM adult_items WHERE site=? AND ckey=? AND vod_id<>? LIMIT 50').all(siteKey, parsed.key, vodId);
        if (rows.length < 2) return false;
        const keys = new Set(rows.map((r) => r.tkey));
        keys.add(parsed.titleKey);
        if (keys.size < 3) return false;
        const durs = rows.map((r) => r.dur).concat([dur]).filter((x) => x > 0);
        if (durs.length < 2) return true;
        const m = U.median(durs);
        return durs.some((x) => !U.durCompatible(x, m));
    }
    function inChain(wk, base, isCode) {
        if (wk === base || wk.indexOf(base + '~') === 0) return true;
        return isCode && (wk === base + '#clip' || wk.indexOf(base + '#clip~') === 0);
    }
    function chooseWk(d, siteKey, vodId, base, dur, isCode, prev) {
        // 已经在库里的条目:还在同一条键链上、时长和其他线路仍对得上 → 不挪(防抖)
        if (prev && prev.wk && inChain(prev.wk, base, isCode)) {
            const others = q(d, 'SELECT dur FROM adult_items WHERE wk=? AND dur>0 AND NOT (site=? AND vod_id=?) LIMIT 200').all(prev.wk, siteKey, vodId).map((r) => r.dur);
            if (U.durCompatible(dur, U.median(others))) return prev.wk;
        }
        return assignWk(d, base, dur, isCode, 0);
    }
    function assignWk(d, base, dur, isCode, depth) {
        for (let k = 1; k <= 9; k++) {
            const cand = k === 1 ? base : base + '~' + k;
            const w = q(d, 'SELECT dur_med FROM adult_works WHERE wk=?').get(cand);
            if (!w) return cand;
            if (U.durCompatible(dur, w.dur_med)) return cand;
            if (isCode && k === 1 && depth === 0 && !/#clip$/.test(base) && dur > 0 && w.dur_med > 0) {
                if (dur < 0.5 * w.dur_med) return assignWk(d, base + '#clip', dur, isCode, 1);   // 解说 / 片段
                if (w.dur_med < 0.5 * dur) { migrateClip(d, base); return base; }                // 先来的是片段,完整版后到
            }
        }
        return base + '~d' + dur;
    }
    // 先入库的是片段(时长 < 新来完整版的 50%):把它们挪去 '#clip',主键让给完整版(新作品名按完整版重新冻结)
    function migrateClip(d, base) {
        const rows = q(d, 'SELECT site, vod_id, dur FROM adult_items WHERE wk=?').all(base);
        for (const r of rows) {
            const nk = assignWk(d, base + '#clip', r.dur, true, 1);
            q(d, 'UPDATE adult_items SET wk=?, flags = flags | ? WHERE site=? AND vod_id=?').run(nk, F_CLIP, r.site, r.vod_id);
            refreshWork(d, nk, { site: r.site, vod_id: r.vod_id });
        }
        refreshWork(d, base);
        stats.migrated++;
    }

    // 一条原始 maccms 条目 → 库(调用方包事务)。返回 {ok, wk?, bucket?, reason?}
    function ingestItem(d, site, raw, o) {
        const rej = (reason) => { bump(stats.rejected, reason); return { ok: false, reason }; };
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rej('invalid');
        const vodId = String(raw.vod_id == null ? '' : raw.vod_id).trim();
        const name = str(raw.vod_name, 200).trim();
        if (!vodId || vodId.length > 64 || !name) return rej('invalid');
        // 1) 分类(按条目自己的 type_id;搜索结果没有 type_id 时按分类名在本站表里找)
        const cmap = o.cmap;
        let typeId = raw.type_id == null || raw.type_id === '' ? NaN : Number(raw.type_id);
        let cls = Number.isFinite(typeId) ? (cmap.byId.get(typeId) || null) : null;
        if (!cls && !Number.isFinite(typeId) && raw.type_name) {
            const e = cmap.byName.get(X.normName(raw.type_name));
            if (e) { cls = e.row; typeId = e.id; }
        }
        if (!cls) { o.noclass = true; return rej('noclass'); }
        // 2) 分类硬过滤(自己或任一祖先)
        if (cls.block) return rej('category');
        // 3) 主流影视 / 非视频 / 纯结构父分类
        if (DROP.has(cls.bucket)) return rej('mainstream');
        // 4) 条目政策(片名/简介/分类/标签/备注全查)
        const typeName = str(raw.type_name != null && raw.type_name !== '' ? raw.type_name : cls.name, 60);
        const parsed = T.parseTitle(name, typeName);
        const dur = U.parseDur(raw.vod_duration, raw.vod_remarks);
        let codeOk = T.codeOk(parsed, { siteTrust: site.codeTrust });
        if (codeOk && autoFlagged(d, site.key, vodId, parsed, dur)) { codeOk = false; bump(stats.flags, 'autoflag'); }
        const item = {
            vod_name: name, vod_sub: str(raw.vod_sub), vod_content: str(raw.vod_content), vod_blurb: str(raw.vod_blurb),
            type_name: typeName, vod_tag: str(raw.vod_tag), vod_class: str(raw.vod_class), vod_remarks: str(raw.vod_remarks),
            vod_actor: str(raw.vod_actor), vod_director: str(raw.vod_director), vod_area: str(raw.vod_area),   // 政策 p2 起演员栏也查硬拦词
        };
        let pc;
        try { pc = P.checkItem(item, { cls, codeOk, siteTrust: site.codeTrust !== false, strict: site.strict === true }); } catch (e) { return rej('policy-error'); }
        if (!pc || pc.ok !== true) return rej(String((pc && pc.reason) || 'policy'));
        // p5:政策实际采用的番号可信度(严格站会更严:日本番号挂在国产分类上、占位番号…)—— 只收紧不放宽;
        //   下面的审查兜底、日本区路由、作品键、code_ok 都用它(否则严格站的假番号会拿到 c: 键并进真作品当线路)
        if (pc.codeOk === false && codeOk) { codeOk = false; bump(stats.flags, 'policy-code'); }
        // 5) 审查级(checkItem 已经拦过,再兜一道)
        const review = pc.review || null;
        if (review === 'hide' || (review === 'code' && !codeOk)) return rej('review');
        // 6/7) 大类
        let bucket = pc.bucket;
        if (bucket === 'mixed' || bucket === 'uncat') bucket = route(parsed, codeOk, name);
        if (!NAV.has(bucket)) return rej('bucket');
        // 8) 变体
        const f = parsed.flags || {};
        const flags = (f.chineseSub ? F_ZH : 0) | (f.uncensored ? F_UNC : 0) | (f.leak ? F_LEAK : 0) | (f.clip || bucket === 'commentary' ? F_CLIP : 0) | (f.uhd ? F_UHD : 0);
        const variant = f.chineseSub ? '中字' : f.leak ? '无码流出' : f.uncensored ? '无码' : f.uhd ? '4K' : '';
        const tags = (Array.isArray(pc.tags) ? pc.tags : []).slice(0, 20);
        if (f.chineseSub && tags.indexOf('subbed') < 0) tags.push('subbed');
        if (f.uncensored && tags.indexOf('uncensored') < 0) tags.push('uncensored');
        // 9) 作品键
        let base = T.workKey(parsed, { codeOk });
        if (!base || base === 't:') base = 't:' + (T.titleKey(name) || vodId);
        const isCode = base.indexOf('c:') === 0;
        if (isCode && (flags & F_CLIP)) base += '#clip';
        const prev = q(d, 'SELECT wk, play_url, dead FROM adult_items WHERE site=? AND vod_id=?').get(site.key, vodId);
        const wk = chooseWk(d, site.key, vodId, base, dur, isCode, prev);
        // 10) upsert
        const now = o.now;
        const vt = U.parseTime(raw.vod_time);
        // 首见时间:爬虫 = 资源站上架时间(不晚于现在);搜索回写 = 上架时间,没有就当 30 天前(不进"新上架")
        const first = vt > 0 && vt <= now ? vt : (o.src === 'crawl' ? now : now - C.retentionMs);
        const pu = typeof raw.vod_play_url === 'string' && raw.vod_play_url && raw.vod_play_url.length <= C.maxPlayUrl ? raw.vod_play_url : null;
        // 被上报判死的线路:资源站换了播放地址(去掉 ?签名 之后仍不同)→ 复活,之前的失败不再算
        const stripQs = (x) => String(x || '').replace(/\?[^#$]*/g, '');
        const reset = !!(prev && prev.dead && pu && prev.play_url && stripQs(pu) !== stripQs(prev.play_url));
        const pic = typeof raw.vod_pic === 'string' && /^https?:\/\//i.test(raw.vod_pic.trim()) ? U.clip(raw.vod_pic.trim(), 500) : '';
        const rawJson = JSON.stringify({
            n: name, s: str(raw.vod_sub, 300), c: str(raw.vod_content, C.maxContent), b: str(raw.vod_blurb, 300), t: Number.isFinite(typeId) ? typeId : null,
            tn: typeName, tg: str(raw.vod_tag, 300), cl: str(raw.vod_class, 300), rm: str(raw.vod_remarks, 100),
            du: str(raw.vod_duration, 20), tm: str(raw.vod_time, 30), p: pic, pf: str(raw.vod_play_from, 200),
            a: str(raw.vod_actor, 300), dr: str(raw.vod_director, 100), ar: str(raw.vod_area, 50),
        });
        q(d, `INSERT INTO adult_items (site, vod_id, wk, bucket, tags, review, code_ok, name, clean, code, ckey, tkey, pic, dur, vod_time,
                first_seen, last_seen, type_id, type_name, play_from, play_url, play_at, variant, flags, family, src, raw)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(site, vod_id) DO UPDATE SET wk=excluded.wk, bucket=excluded.bucket, tags=excluded.tags, review=excluded.review,
                code_ok=excluded.code_ok, name=excluded.name, clean=excluded.clean, code=excluded.code, ckey=excluded.ckey, tkey=excluded.tkey,
                pic=CASE WHEN excluded.pic <> '' THEN excluded.pic ELSE adult_items.pic END,
                dur=CASE WHEN excluded.dur > 0 THEN excluded.dur ELSE adult_items.dur END,
                vod_time=COALESCE(excluded.vod_time, adult_items.vod_time),
                first_seen=MIN(adult_items.first_seen, excluded.first_seen), last_seen=MAX(adult_items.last_seen, excluded.last_seen),
                type_id=excluded.type_id, type_name=excluded.type_name,
                play_from=CASE WHEN excluded.play_url IS NOT NULL THEN excluded.play_from ELSE adult_items.play_from END,
                play_at=CASE WHEN excluded.play_url IS NOT NULL THEN excluded.play_at ELSE adult_items.play_at END,
                play_url=COALESCE(excluded.play_url, adult_items.play_url),
                variant=excluded.variant, flags=excluded.flags, family=excluded.family,
                src=CASE WHEN excluded.src='crawl' OR adult_items.src='crawl' THEN 'crawl' ELSE excluded.src END,
                raw=excluded.raw,
                dead=CASE WHEN ${reset ? 1 : 0} THEN 0 ELSE adult_items.dead END,
                ok_at=CASE WHEN ${reset ? 1 : 0} THEN excluded.last_seen ELSE adult_items.ok_at END`).run(
            site.key, vodId, wk, bucket, tags.length ? ',' + tags.join(',') + ',' : '', review, codeOk ? 1 : 0,
            name, U.clip(parsed.cleanTitle || '', 200), parsed.code || null, parsed.key || null, parsed.titleKey || '',
            pic, dur, vt > 0 ? vt : null, first, now, Number.isFinite(typeId) ? typeId : null, typeName,
            pu ? str(raw.vod_play_from, 200) : null, pu, pu ? (o.playAt != null ? o.playAt : now) : null,
            variant, flags, site.family || '', o.src === 'crawl' ? 'crawl' : String(o.src || 'search'), rawJson);
        if (reset) q(d, 'DELETE FROM adult_line_fail WHERE site=? AND vod_id=?').run(site.key, vodId);
        refreshWork(d, wk, { site: site.key, vod_id: vodId });
        if (prev && prev.wk && prev.wk !== wk) refreshWork(d, prev.wk);
        return { ok: true, wk, bucket };
    }

    function canonName(row, wk) {
        let n;
        if (wk.indexOf('c:') === 0 && row.code) n = (row.code + ' ' + (row.clean || '')).trim();
        else n = String(row.clean || row.name || '').trim();
        if (!n) n = String(row.name || wk);
        if (/#U(?=$|[#~])/.test(wk)) n += ' [无码流出]';
        if (wk.indexOf('#clip') >= 0) n += ' [解说]';
        return U.clip(n, 120);
    }
    function uniqueName(d, n, wk) {
        const taken = (x) => { const r = q(d, 'SELECT wk FROM adult_works WHERE name=? LIMIT 1').get(x); return !!r && r.wk !== wk; };
        if (!taken(n)) return n;
        for (let i = 2; i <= 30; i++) { const m = n + ' · ' + i; if (!taken(m)) return m; }
        return n + ' · ' + U.hash31(wk).toString(36);
    }
    // 重算一个作品的汇总(线路数/时长中位数/大类/审查级…);没有条目了就删
    function refreshWork(d, wk, trigger) {
        const rows = q(d, 'SELECT site, vod_id, bucket, tags, review, code_ok, code, ckey, clean, name, pic, dur, first_seen, last_seen, flags, variant FROM adult_items WHERE wk=?').all(wk);
        const w = q(d, 'SELECT rowid AS rid, wk, bucket, first_seen FROM adult_works WHERE wk=?').get(wk);
        if (!rows.length) {
            if (w) {
                q(d, 'DELETE FROM adult_works WHERE wk=?').run(wk);
                if (ftsOk) { try { q(d, 'DELETE FROM adult_fts WHERE rowid=?').run(w.rid); } catch (_) { /* fts 坏了不影响主表 */ } }
            }
            return;
        }
        const sites = new Set(), bc = new Map(), tags = new Set(), vars = new Set(), durs = [];
        let review = null, codeOk = 1, flags = 0, last = 0, firstRow = null, picRow = null;
        for (const r of rows) {
            sites.add(r.site);
            bc.set(r.bucket, (bc.get(r.bucket) || 0) + 1);
            for (const t of String(r.tags || '').split(',')) if (t) tags.add(t);
            if ((REVIEW_RANK[r.review] || 0) > (REVIEW_RANK[review] || 0)) review = r.review;
            if (!r.code_ok) codeOk = 0;
            flags |= r.flags;
            if (r.variant) vars.add(r.variant);
            if (r.dur > 0) durs.push(r.dur);
            if (!firstRow || r.first_seen < firstRow.first_seen) firstRow = r;
            if (r.last_seen > last) last = r.last_seen;
            if (r.pic && (!picRow || r.last_seen > picRow.last_seen)) picRow = r;
        }
        const trig = (trigger && rows.find((r) => r.site === trigger.site && r.vod_id === trigger.vod_id)) || firstRow;
        // 大类 = 线路里最多的那个;平手时优先保持现有大类,其次触发这次重算的条目的大类
        const pref = (b) => (w && b === w.bucket ? 2 : 0) + (b === trig.bucket ? 1 : 0);
        let bucket = null, best = -1;
        for (const [b, n] of bc) if (n > best || (n === best && pref(b) > pref(bucket))) { bucket = b; best = n; }
        const firstSeen = w ? Math.min(w.first_seen, firstRow.first_seen) : firstRow.first_seen;
        const sitesStr = ',' + [...sites].join(',') + ',';
        const tagsStr = tags.size ? ',' + [...tags].slice(0, 30).join(',') + ',' : '';
        const varsStr = [...vars].join(',');
        const picItem = picRow ? picRow.site + '|' + picRow.vod_id : null;
        if (w) {
            q(d, `UPDATE adult_works SET bucket=?, tags=?, review=?, code_ok=?, pic=?, pic_item=?, dur_med=?, n_sites=?, sites=?, first_site=?,
                    variants=?, flags=?, first_seen=?, last_seen=? WHERE wk=?`)
                .run(bucket, tagsStr, review, codeOk, picRow ? picRow.pic : '', picItem, U.median(durs), sites.size, sitesStr, firstRow.site,
                    varsStr, flags, firstSeen, last, wk);
            return;
        }
        const name = uniqueName(d, canonName(trig, wk), wk);
        const info = q(d, `INSERT INTO adult_works (wk, name, code, ckey, clean, bucket, tags, review, code_ok, pic, pic_item, dur_med, n_sites, sites,
                first_site, variants, flags, is_clip, first_seen, last_seen, rand) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(wk, name, wk.indexOf('c:') === 0 ? trig.code : null, trig.ckey, trig.clean, bucket, tagsStr, review, codeOk,
                picRow ? picRow.pic : '', picItem, U.median(durs), sites.size, sitesStr, firstRow.site, varsStr, flags,
                wk.indexOf('#clip') >= 0 ? 1 : 0, firstSeen, last, U.hash31('r:' + wk));
        if (ftsOk) {
            try { q(d, 'INSERT INTO adult_fts (rowid, name, code) VALUES (?, ?, ?)').run(info.lastInsertRowid, name, wk.indexOf('c:') === 0 ? (trig.code || '') : ''); }
            catch (_) { /* fts 坏了不影响主表 */ }
        }
    }

    // 外站计数(vod_hits / _day / _week / _month):四个都是非负整数才记;距上次 ≥2 分钟才把上次的总数挪进 prev(可信检查看涨没涨)
    const hitNum = (v) => { if (v == null || v === '') return NaN; const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.floor(n) : NaN; };
    function recordHits(d, siteKey, raw, t) {
        if (!raw || typeof raw !== 'object') return false;
        const vodId = String(raw.vod_id == null ? '' : raw.vod_id).trim();
        const h = [hitNum(raw.vod_hits_day), hitNum(raw.vod_hits_week), hitNum(raw.vod_hits_month), hitNum(raw.vod_hits)];
        if (!vodId || vodId.length > 64 || h.some((x) => Number.isNaN(x))) return false;
        const old = q(d, 'SELECT total, at, prev_total, prev_at FROM adult_hits WHERE site=? AND vod_id=?').get(siteKey, vodId);
        const shift = old && t - old.at >= C.trustGapMs;
        q(d, 'INSERT OR REPLACE INTO adult_hits (site, vod_id, day, week, month, total, at, prev_total, prev_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(siteKey, vodId, h[0], h[1], h[2], h[3], t, shift ? old.total : (old ? old.prev_total : null), shift ? old.at : (old ? old.prev_at : null));
        return true;
    }
    function ingestBatch(d, site, list, o) {
        const res = { ok: 0, rejected: 0, noclass: false, wks: [], hits: 0 };
        const t = nowFn();
        const hs = extHotSite();
        const withHits = !!(hs && hs.key === site.key);
        d.transaction(() => {
            for (const raw of list) {
                const ctx = { src: o.src, cmap: o.cmap, now: t };
                let r;
                try { r = ingestItem(d, site, raw, ctx); } catch (e) { warn('ingest', e.message); r = { ok: false, reason: 'error' }; bump(stats.rejected, 'error'); }
                if (ctx.noclass) res.noclass = true;
                if (r.ok) { res.ok++; res.wks.push(r.wk); } else res.rejected++;
                // 只给入了库(过了政策)的条目记计数
                if (r.ok && withHits) { try { if (recordHits(d, site.key, raw, t)) res.hits++; } catch (e) { warn('hits', e.message); } }
            }
        })();
        stats.ingested += res.ok;
        return res;
    }

    // ---------- 爬虫 ----------
    function loadState(d, site) {
        const st = q(d, 'SELECT * FROM adult_crawl_state WHERE site=?').get(site.key);
        if (st && st.api === site.api) return st;
        return { site: site.key, api: site.api, last_ok: null, next_at: 0, mode: null, pagesize: null, fails: 0, last_new: null, last_err: null, cursor: null, ignores_h: 0, n_req: 0, n_items: 0 };
    }
    function saveState(d, st) {
        q(d, `INSERT OR REPLACE INTO adult_crawl_state (site, api, last_ok, next_at, mode, pagesize, fails, last_new, last_err, cursor, ignores_h, n_req, n_items)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(st.site, st.api, st.last_ok, st.next_at, st.mode, st.pagesize, st.fails, st.last_new, st.last_err, st.cursor, st.ignores_h, st.n_req, st.n_items);
    }
    function failSite(d, st, err) {
        st.fails = (st.fails || 0) + 1;
        st.last_err = U.clip(err, 200);
        st.cursor = null;
        st.next_at = nowFn() + C.failBackoff[Math.min(st.fails, C.failBackoff.length) - 1];
        saveState(d, st);
        warn('crawl ' + st.site, err);
    }
    const take = (b) => { if (b.left <= 0) return false; b.left--; b.used++; return true; };
    const pausedNow = () => { try { return typeof deps.socketsBusy === 'function' && Number(deps.socketsBusy()) > C.socketsPause; } catch (_) { return false; } };
    const intervalOf = (mode) => (mode === 'continuous' ? C.continuousMs : mode === 'stale' ? C.staleMs : C.batchMs);
    function decideMode(d, site, st, cur, t) {
        if (site.crawlMode) return site.crawlMode;
        if (!st.last_new) return 'stale';                                   // 72h 窗口里一部都没收到
        if (t - st.last_new > C.staleAfterMs) return 'stale';
        const n = q(d, 'SELECT COUNT(DISTINCT vod_time / 3600000) n FROM adult_items WHERE site=? AND vod_time >= ?').get(site.key, t - DAY).n;
        return n >= C.continuousHours ? 'continuous' : 'batch';
    }
    async function crawlSite(site, budget) {
        let d = dbOf();
        if (!d) return;
        const st = loadState(d, site);
        // 分类表(每天;失败了有旧表就接着用)
        if (needClass(d, site.api)) {
            if (!take(budget)) return;
            st.n_req++;
            try { await fetchClassMap(site); }
            catch (e) { d = dbOf(); if (!d) return; markClassFail(d, site.api); warn('class ' + site.key, e.message); }
            d = dbOf();
            if (!d) return;
        }
        const cmap = classMapFor(site.api);
        if (!cmap) { failSite(d, st, 'no class map'); return; }
        let cur = null;
        try { cur = st.cursor ? JSON.parse(st.cursor) : null; } catch (_) { cur = null; }
        if (!cur || cur.api !== site.api || !(cur.pg >= 1)) {
            const start = nowFn();
            const h = st.last_ok ? Math.min(C.maxHours, Math.max(1, Math.ceil((start - st.last_ok) / HOUR) + 1)) : C.maxHours;
            cur = { api: site.api, start, h, pg: 1, ps: st.pagesize || C.pageSize, n: 0 };
        }
        for (;;) {
            if (pausedNow()) { budget.paused = true; st.cursor = JSON.stringify(cur); saveState(d, st); return; }
            if (!take(budget)) { st.cursor = JSON.stringify(cur); saveState(d, st); return; }
            st.n_req++;
            let j;
            try { j = await gatedGet(site, urlFor(site, `ac=detail&h=${cur.h}&pagesize=${cur.ps}&pg=${cur.pg}`)); }
            catch (e) { d = dbOf(); if (d) failSite(d, st, (e && e.message) || 'request failed'); return; }
            d = dbOf();
            if (!d) return;
            if (!j || !Array.isArray(j.list)) { failSite(d, st, 'bad format'); return; }
            const list = j.list;
            if (!list.length) break;
            const r = ingestBatch(d, site, list, { src: 'crawl', cmap });
            cur.n += r.ok;
            st.n_items += r.ok;
            if (r.noclass) forceClassRefresh(d, site.api);
            const pc = Number(j.pagecount);
            // 站点不认 pagesize(一页只给 20)→ 记下来,以后按 20 要(本轮继续用原值,翻页才对得上)
            if (cur.pg === 1 && list.length < cur.ps && Number.isFinite(pc) && pc > 1) st.pagesize = list.length <= C.pageSizeCapped ? C.pageSizeCapped : list.length;
            // 站点不认 h(回来的条目早于窗口)→ 这页收完就停,不要把整站翻一遍
            let oldest = Infinity;
            for (const it of list) { const tt = U.parseTime(it && it.vod_time); if (tt > 0 && tt < oldest) oldest = tt; }
            if (oldest < cur.start - (cur.h + 3) * HOUR) { st.ignores_h = 1; break; }
            if (Number.isFinite(pc) && pc > 0 && cur.pg >= pc) break;
            if (cur.pg >= C.maxPagesPerCrawl) break;
            cur.pg++;
        }
        const t = nowFn();
        st.last_ok = cur.start;
        st.fails = 0;
        st.last_err = null;
        st.cursor = null;
        if (cur.n > 0) st.last_new = t;
        st.mode = decideMode(d, site, st, cur, t);
        st.next_at = Math.max(t + MIN, cur.start + intervalOf(st.mode));
        saveState(d, st);
    }
    // ---------- 外站计数复取(ids= 每批 20,每小时 ≤10 个请求,走爬虫预算 + 同域名间隔) ----------
    const hitsTried = new Map();   // vod_id → 上次请求时间(站点不回的 id 别反复要)
    function hitsCandidates(d, site, t) {
        const fresh = (id) => { const x = hitsTried.get(site.key + '|' + id); return !x || t - x >= C.hitsRefreshMs; };
        const top = q(d, `SELECT h.vod_id, h.at FROM adult_hits h JOIN adult_items i ON i.site = h.site AND i.vod_id = h.vod_id
                          WHERE h.site=? AND ${ELIG_I} ORDER BY h.week DESC LIMIT ?`).all(site.key, C.hitsTop)
            .filter((r) => t - r.at >= C.hitsRefreshMs && fresh(r.vod_id)).sort((a, b) => a.at - b.at).map((r) => r.vod_id);
        const out = top.slice(0, C.hitsBatch);
        if (out.length < C.hitsBatch) {
            // 还没有计数的条目(搜索回写进来的 / 上线计数之前爬的):新的先
            const none = q(d, `SELECT i.vod_id FROM adult_items i LEFT JOIN adult_hits h ON h.site = i.site AND h.vod_id = i.vod_id
                               WHERE i.site=? AND h.vod_id IS NULL AND ${ELIG_I} ORDER BY i.first_seen DESC LIMIT ?`).all(site.key, C.hitsBatch * 3)
                .map((r) => r.vod_id).filter(fresh);
            for (const id of none) { if (out.length >= C.hitsBatch) break; if (out.indexOf(id) < 0) out.push(id); }
        }
        return out;
    }
    async function hitsRefresh(budget) {
        let d = dbOf();
        if (!d || budget.left <= 0 || budget.paused) return 0;
        const site = extHotSite();
        if (!site) return 0;
        const cmap = classMapFor(site.api);
        if (!cmap) return 0;   // 分类表还没拉(爬虫会拉)
        let n = 0;
        while (n < C.hitsPerTick && budget.left > 0 && !budget.paused) {
            const t = nowFn();
            let times = [];
            try { times = JSON.parse(getMeta(d, 'exthot:req') || '[]'); } catch (_) { times = []; }
            times = (Array.isArray(times) ? times : []).filter((x) => typeof x === 'number' && x <= t && t - x < HOUR);
            if (times.length >= C.hitsPerHour) break;
            const ids = hitsCandidates(d, site, t);
            if (!ids.length) break;
            if (!take(budget)) break;
            times.push(t);
            setMeta(d, 'exthot:req', JSON.stringify(times));
            for (const id of ids) hitsTried.set(site.key + '|' + id, t);
            if (hitsTried.size > 20000) hitsTried.clear();
            n++;
            stats.hits.requests++;
            let j;
            try { j = await gatedGet(site, urlFor(site, 'ac=detail&ids=' + ids.map((x) => encodeURIComponent(x)).join(','))); }
            catch (e) { stats.hits.errors++; warn('hits ' + site.key, e.message); break; }
            d = dbOf();
            if (!d) return n;
            const want = new Set(ids.map(String));
            const list = (j && Array.isArray(j.list) ? j.list : []).filter((it) => it && typeof it === 'object' && want.has(String(it.vod_id)));
            if (list.length) stats.hits.items += ingestBatch(d, site, list, { src: 'crawl', cmap }).hits;
        }
        return n;
    }
    // 每周一次的可信检查(纯本地;复取由 hitsRefresh 顺带完成)。没判出来(数据不够)→ 下次快照再判
    function extTrust(d, site, t) {
        let m = null;
        try { m = JSON.parse(getMeta(d, 'exthot:trust') || 'null'); } catch (_) { m = null; }
        if (m && m.site === site.key && m.decided && t >= m.at && t - m.at < C.trustEveryMs) return m;
        const rows = q(d, 'SELECT day, week, month, total, at, prev_total, prev_at FROM adult_hits WHERE site=? AND at >= ?').all(site.key, t - C.trustEveryMs);
        const r = Object.assign({ site: site.key, at: t }, U.hitsTrust(rows, { minN: C.trustMinN, minPairs: C.trustMinPairs, orderFrac: C.trustOrderFrac, growFrac: C.trustGrowFrac, gapMs: C.trustGapMs }));
        setMeta(d, 'exthot:trust', JSON.stringify(r));
        return r;
    }

    // ---------- 薄分区回填(每周;只拉叶子分类,绝不拉父分类) ----------
    function planBackfill(d, t) {
        const thin = [];
        for (const b of X.NAV_BUCKETS) {
            const n = q(d, `SELECT COUNT(*) n FROM adult_works w WHERE w.bucket=? AND w.first_seen >= ? AND w.is_clip=0 AND ${ELIG}`).get(b, t - C.retentionMs).n;
            if (n < C.backfillThin) thin.push(b);
        }
        const queue = [];
        if (thin.length) {
            const T = new Set(thin);
            for (const s of crawlSites()) {
                const cmap = classMapFor(s.api);
                if (!cmap) continue;
                const ps = loadState(d, s).pagesize || C.pageSize;
                for (const [id, row] of cmap.byId) {
                    if (row.container || row.block || !T.has(row.bucket)) continue;
                    queue.push({ site: s.key, api: s.api, t: id, ps, pg: 1 });
                }
            }
        }
        return { startedAt: t, thin, queue };
    }
    async function backfillStep(budget) {
        let d = dbOf();
        if (!d || budget.left <= 0 || budget.paused) return 0;
        const t = nowFn();
        let st = null;
        try { st = JSON.parse(getMeta(d, 'backfill') || 'null'); } catch (_) { st = null; }
        if (!st || typeof st !== 'object' || !Array.isArray(st.queue)) st = { startedAt: 0, thin: [], queue: [] };
        if (!st.queue.length) {
            const first = Number(getMeta(d, 'firstTick')) || t;
            if (t - first < C.backfillDelayMs || t - (Number(st.startedAt) || 0) < C.backfillEveryMs) return 0;
            st = planBackfill(d, t);
            setMeta(d, 'backfill', JSON.stringify(st));
            stats.backfill.runs++;
            if (st.thin.length) log(`薄分区回填:${st.thin.join(',')} · ${st.queue.length} 个叶子分类`);
            if (!st.queue.length) return 0;
        }
        const sites = new Map(crawlSites().map((s) => [s.key, s]));
        let n = 0;
        while (st.queue.length && n < C.backfillPerTick && budget.left > 0 && !budget.paused) {
            if (pausedNow()) { budget.paused = true; break; }
            const job = st.queue[0];
            const site = sites.get(job.site);
            const cmap = site && site.api === job.api ? classMapFor(site.api) : null;
            const row = cmap ? cmap.byId.get(Number(job.t)) : null;
            if (!row || row.container || row.block) { st.queue.shift(); continue; }   // 站没了 / 分类变了 / 变成父分类 → 跳过
            if (!take(budget)) break;
            n++;
            stats.backfill.requests++;
            let j = null;
            try { j = await gatedGet(site, urlFor(site, `ac=detail&t=${Number(job.t)}&pagesize=${Number(job.ps) || C.pageSize}&pg=${Number(job.pg) || 1}`)); }
            catch (e) { warn('backfill ' + site.key, e.message); j = null; }
            d = dbOf();
            if (!d) return n;
            const list = j && Array.isArray(j.list) ? j.list : [];
            if (list.length) stats.backfill.items += ingestBatch(d, site, list, { src: 'crawl', cmap }).ok;
            const pc = Number(j && j.pagecount);
            if (!j || !list.length || job.pg >= C.backfillPages || (Number.isFinite(pc) && pc > 0 && job.pg >= pc)) st.queue.shift();
            else job.pg++;
            setMeta(d, 'backfill', JSON.stringify(st));
        }
        return n;
    }

    let tickP = null, lastTick = null;
    function tick() {
        if (!tickP) tickP = runTick().finally(() => { tickP = null; });
        return tickP;
    }
    async function runTick() {
        const d = dbOf();
        if (!d) return (lastTick = { at: nowFn(), skipped: 'nodb' });
        if (rescanPending) { if (!rescanP) startRescan(d); return (lastTick = { at: nowFn(), skipped: 'rescan' }); }
        const t0 = nowFn();
        if (pausedNow()) return (lastTick = { at: t0, skipped: 'sockets' });   // 出网连接已经很忙:这轮不爬
        if (!getMeta(d, 'firstTick')) setMeta(d, 'firstTick', String(t0));
        const budget = { left: C.maxReqPerTick, used: 0, paused: false };
        const ing0 = stats.ingested;
        const sites = crawlSites();
        const states = new Map(q(d, 'SELECT site, api, next_at, cursor FROM adult_crawl_state').all().map((r) => [r.site, r]));
        const rank = (s) => { const r = states.get(s.key); if (!r || r.api !== s.api) return -2; if (r.cursor) return -1; return r.next_at || 0; };
        const due = sites.filter((s) => { const r = states.get(s.key); return !r || r.api !== s.api || !!r.cursor || (r.next_at || 0) <= t0; });
        due.sort((a, b) => rank(a) - rank(b));
        // 同域名的站归一组、组内串行:保证同域名同时最多 1 个请求
        const groups = new Map();
        for (const s of due) { const h = U.hostOf(s.api); if (!groups.has(h)) groups.set(h, []); groups.get(h).push(s); }
        const queue = [...groups.values()];
        const worker = async () => {
            while (queue.length && budget.left > 0 && !budget.paused) {
                const g = queue.shift();
                for (const s of g) {
                    if (budget.left <= 0 || budget.paused) break;
                    try { await crawlSite(s, budget); } catch (e) { warn('crawl ' + s.key, e.message); }
                }
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, C.concurrency) }, worker));
        // 剩下的预算:先复取外站计数,再做薄分区回填(都走同一套同域名串行 / 间隔)
        let hitsN = 0, bfN = 0;
        try { hitsN = await hitsRefresh(budget); } catch (e) { warn('hits', e.message); }
        try { bfN = await backfillStep(budget); } catch (e) { warn('backfill', e.message); }
        lastTick = { at: t0, ms: nowFn() - t0, due: due.length, requests: budget.used, ingested: stats.ingested - ing0, paused: budget.paused, hits: hitsN, backfill: bfN };
        if (lastTick.ingested > 0 && (!snap || snap.empty || !snap.home.rows.length)) rebuild();
        return lastTick;
    }

    // ---------- 快照:首页 / 大类计数 / 浏览排序 ----------
    let snap = null, snapSeq = 0;
    const liveCount = (w, act) => { let n = 0; for (const k of String(w.sites || '').split(',')) if (k && act.has(k)) n++; return n; };
    const famFn = (act) => (w) => { const s = act.get(w.first_site); return (s && s.family) || w.first_site || ''; };
    const slotOf = (w) => Math.floor((w.first_seen || 0) / C.slotMs);
    // 封面代理开着(ADULT_IMG_PROXY=1)时,卡片 / 线路封面一律改成 /api/img?k=<作品键>&s=<站>(地址由服务器查索引,客户端给不了地址)
    const imgUrl = (wk, site) => '/api/img?k=' + encodeURIComponent(wk) + (site ? '&s=' + encodeURIComponent(site) : '');
    function card(w, ctx) {
        const n = liveCount(w, ctx.act);
        const zh = (w.flags & F_ZH) || w.bucket === 'jp_subbed';
        const unc = (w.flags & F_UNC) || w.bucket === 'jp_uncensored';
        const badge = zh ? '中字' : unc ? '无码' : w.bucket === 'short' ? '竖屏' : '';
        const sub = [U.relTime(w.first_seen, ctx.t), U.fmtDur(w.dur_med), n + '线'].filter(Boolean).join(' · ');
        const pic = !w.pic ? '' : IMG_PROXY ? imgUrl(w.wk, String(w.pic_item || '').split('|')[0]) : w.pic;
        return { wk: w.wk, name: w.name, pic, sub, badge, bucket: w.bucket, code: w.code || '', dur: w.dur_med || 0, n_sites: n, first_seen: w.first_seen };
    }
    // 作品至少有一条没被判死、在启用站上的线路
    function playable(d, wk, act) {
        for (const r of q(d, `SELECT i.site FROM adult_items i WHERE i.wk=? AND i.dead=0 AND ${ELIG_I}`).all(wk)) if (act.has(r.site)) return true;
        return false;
    }
    // 本站热门:lib/popular 的片名(已过隐私门槛,快照对所有人共用 → 按"匿名调用者"口径取)按名字对上作品
    function localHot(d, act) {
        let titles = [];
        try { titles = typeof deps.popularTitles === 'function' ? deps.popularTitles() : []; } catch (e) { warn('popular', e.message); titles = []; }
        if (!Array.isArray(titles) || !titles.length) return [];
        const out = [], seen = new Set();
        for (const name of titles.slice(0, 100)) {
            if (typeof name !== 'string' || !name || seen.has(name)) continue;
            seen.add(name);
            const w = q(d, `SELECT ${WCOLS} FROM adult_works w WHERE w.name=? AND ${ELIG} AND w.is_clip=0`).get(name);
            if (w && !out.some((x) => x.wk === w.wk) && liveCount(w, act) > 0 && playable(d, w.wk, act)) out.push(w);
            if (out.length >= C.rowSize) break;
        }
        return out;
    }
    // 外站热门:外站计数站最近 72h 取到的 hits_week,按作品取最大值排序;可信检查不过 → 空
    function extHot(d, act, t) {
        const site = extHotSite(act);
        if (!site) return [];
        const tr = extTrust(d, site, t);
        if (!tr.ok) return [];
        const rows = q(d, `SELECT ${WCOLS}, MAX(h.week) AS hw FROM adult_hits h
                           JOIN adult_items i ON i.site = h.site AND i.vod_id = h.vod_id
                           JOIN adult_works w ON w.wk = i.wk
                           WHERE h.site=? AND h.at >= ? AND ${ELIG_I} AND ${ELIG} AND w.is_clip=0
                           GROUP BY w.wk ORDER BY hw DESC, w.first_seen DESC LIMIT ?`).all(site.key, t - C.hitsFreshMs, C.hitsTop);
        const out = [];
        for (const w of rows) {
            if (liveCount(w, act) > 0 && playable(d, w.wk, act)) out.push(w);
            if (out.length >= C.rowSize) break;
        }
        return out;
    }
    function hotRow(d, act, ctx, t) {
        const local = localHot(d, act);
        if (local.length >= C.hotMin) return { id: 'hot', title: '本站热门', source: 'local', more: null, items: local.map((w) => card(w, ctx)) };
        const ext = extHot(d, act, t);
        if (ext.length >= Math.max(1, C.extHotMin)) return { id: 'hot', title: '外站热门', source: 'ext', more: null, items: ext.map((w) => card(w, ctx)) };
        return null;
    }
    function countToday(d, b, t) {
        const sql = `SELECT COUNT(*) n FROM adult_works w WHERE ${b ? 'w.bucket=? AND ' : ''}w.first_seen >= ? AND w.is_clip=0 AND ${ELIG}`;
        return b ? q(d, sql).get(b, t - DAY).n : q(d, sql).get(t - DAY).n;
    }
    const emptyBuckets = () => X.NAV_BUCKETS.map((id) => ({ id, label: X.bucketLabel(id), nav: true, today: 0 }));
    function rebuild() {
        const t = nowFn();
        const d = dbOf();
        if (!d || rescanPending) {
            snap = { id: ++snapSeq, at: t, db: d, empty: true, home: { generatedAt: t, rows: [] }, buckets: emptyBuckets(), browse: new Map() };
            return snap;
        }
        try {
            const act = activeSites();
            const ctx = { t, act };
            const fam = famFn(act);
            const live = (w) => liveCount(w, act) > 0;
            const rows = [];
            // 新上架:按作品去重(本来就是作品表)、1h 一槽轮流出、同站连续 ≤4
            const pool = q(d, `SELECT ${WCOLS} FROM adult_works w WHERE ${ELIG} AND w.is_clip=0 ORDER BY w.first_seen DESC LIMIT ?`).all(C.poolSize).filter(live);
            const fresh = U.interleave(U.slotRoundRobin(pool, fam, slotOf), fam, C.rowSize, C.maxRun);
            if (fresh.length) rows.push({ id: 'new', title: '新上架', more: { sort: 'new' }, today: countToday(d, null, t), items: fresh.map((w) => card(w, ctx)) });
            // 热门(本站 → 外站 → 不显示),紧跟新上架
            let hot = null;
            try { hot = hotRow(d, act, ctx, t); } catch (e) { warn('hot', e.message); hot = null; }
            if (hot) rows.push(hot);
            // 13 个大类行:最新一部超过 72h 或不足 12 部 → 不显示
            for (const b of HOME_B) {
                const list = q(d, `SELECT ${WCOLS} FROM adult_works w WHERE w.bucket=? AND ${ELIG} AND w.is_clip=0 ORDER BY w.first_seen DESC LIMIT ?`).all(b, C.poolSize).filter(live);
                if (list.length < C.rowMin) continue;
                if (t - list[0].first_seen > C.rowStaleMs) continue;
                // 大类行:同样打散,但某个站独占这个大类时照常排满(不像新上架那样截断)
                const items = U.interleave(U.slotRoundRobin(list, fam, slotOf), fam, C.rowSize, C.maxRun, true);
                rows.push({ id: b, title: X.bucketLabel(b), more: { b }, today: countToday(d, b, t), items: items.map((w) => card(w, ctx)) });
            }
            // 随机发现:按北京时间日期定种子,同一天顺序不变
            const seed = U.hash31('rand:' + U.dayNo(t));
            const rnd = q(d, `SELECT ${WCOLS} FROM adult_works w WHERE ${ELIG} AND w.is_clip=0
                              ORDER BY ((((w.rand | ?) - (w.rand & ?)) * 1103515245) % 2147483647), w.wk LIMIT ?`).all(seed, seed, C.poolSize).filter(live).slice(0, C.rowSize);
            if (rnd.length >= C.rowMin) rows.push({ id: 'random', title: '随机发现', more: { sort: 'random' }, items: rnd.map((w) => card(w, ctx)) });
            const buckets = X.NAV_BUCKETS.map((id) => ({ id, label: X.bucketLabel(id), nav: true, today: countToday(d, id, t) }));
            snap = { id: ++snapSeq, at: t, db: d, empty: false, home: { generatedAt: t, rows }, buckets, browse: new Map() };
        } catch (e) {
            warn('home', e.message);
            snap = { id: ++snapSeq, at: t, db: d, empty: true, home: { generatedAt: t, rows: [] }, buckets: emptyBuckets(), browse: new Map() };
        }
        return snap;
    }
    function ensureSnap() {
        const t = nowFn();
        const d = dbOf();
        if (!snap || snap.empty || snap.db !== d || t - snap.at >= C.homeMs || t < snap.at) rebuild();
        return snap;
    }
    function home() {
        try { return ensureSnap().home; } catch (e) { warn('home', e.message); return { generatedAt: nowFn(), rows: [] }; }
    }
    function buckets() {
        try { return ensureSnap().buckets.map((b) => Object.assign({}, b)); } catch (e) { warn('buckets', e.message); return emptyBuckets(); }
    }
    function normBrowse(params) {
        const o = params && typeof params === 'object' ? params : {};
        const s = (v) => (v == null ? '' : String(v).trim());
        const b = s(o.b), tag = s(o.tag);
        const sort = SORTS.has(s(o.sort)) ? s(o.sort) : 'new';
        const dur = Object.prototype.hasOwnProperty.call(DURS, s(o.dur)) ? s(o.dur) : '';
        const flag = BFLAGS.has(s(o.flag)) ? s(o.flag) : '';
        const pg = parseInt(o.page, 10);
        const page = Number.isFinite(pg) && pg >= 1 ? Math.min(pg, C.maxPages) : 1;
        const lp = s(o.lp).toUpperCase();   // 厂牌前缀(作品页「SSIS」按钮 → 这个厂牌的番号作品)
        const bad = (b && !NAV.has(b)) || (tag && !X.TAGS.some((x) => x.id === tag)) || (lp && !/^[A-Z0-9]{2,10}$/.test(lp));
        return { b, tag, sort, dur, flag, page, bad, lp };
    }
    function computeBrowse(d, p, act) {
        const where = [ELIG];
        const args = [];
        if (p.b) { where.push('w.bucket=?'); args.push(p.b); }
        if (p.b !== 'commentary') where.push('w.is_clip=0');
        if (p.tag) { where.push('w.tags LIKE ?'); args.push('%,' + p.tag + ',%'); }
        if (p.lp) { where.push("substr(w.wk, 1, 2)='c:' AND substr(w.ckey, 1, ?)=?"); args.push(p.lp.length + 1, p.lp + '-'); }
        if (p.dur) { where.push('w.dur_med BETWEEN ? AND ?'); args.push(DURS[p.dur][0], DURS[p.dur][1]); }
        if (p.flag === 'zh') where.push(`((w.flags & ${F_ZH}) <> 0 OR w.bucket='jp_subbed')`);
        if (p.flag === 'unc') where.push(`((w.flags & ${F_UNC}) <> 0 OR w.bucket='jp_uncensored')`);
        if (p.flag === 'multi') where.push('w.n_sites >= 3');
        let order = 'w.first_seen DESC, w.wk';
        if (p.sort === 'dur') order = 'w.dur_med DESC, w.first_seen DESC, w.wk';
        else if (p.sort === 'lines') order = 'w.n_sites DESC, w.first_seen DESC, w.wk';
        else if (p.sort === 'random') {
            const seed = U.hash31('rand:' + U.dayNo(nowFn()));
            order = `((((w.rand | ${seed}) - (w.rand & ${seed})) * 1103515245) % 2147483647), w.wk`;
        }
        const cap = C.maxPages * C.browsePage;
        let rows = q(d, `SELECT w.wk, w.first_seen, w.first_site, w.sites FROM adult_works w WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
            .all(...args, cap).filter((w) => liveCount(w, act) > 0);
        if (p.sort === 'new') {
            const fam = famFn(act);
            const rr = U.slotRoundRobin(rows, fam, slotOf);
            rows = U.interleave(rr, fam, rr.length, C.maxRun, true);
        }
        return rows.map((w) => w.wk);
    }
    function browse(params) {
        const p = normBrowse(params);
        const out = { page: p.page, total_pages: 0, total_results: 0, results: [] };
        try {
            const s = ensureSnap();
            const d = dbOf();
            if (!d || s.empty || p.bad) return out;
            const act = activeSites();
            const key = [p.b, p.tag, p.sort, p.dur, p.flag, p.lp].join('|');
            let list = s.browse.get(key);
            if (!list) {
                list = computeBrowse(d, p, act);
                s.browse.set(key, list);
                while (s.browse.size > C.browseCacheMax) s.browse.delete(s.browse.keys().next().value);
            }
            out.total_results = list.length;
            out.total_pages = Math.min(C.maxPages, Math.ceil(list.length / C.browsePage));
            if (p.page > out.total_pages) return out;
            const slice = list.slice((p.page - 1) * C.browsePage, p.page * C.browsePage);
            if (!slice.length) return out;
            // 排序在快照里冻结,卡片内容现读(仍套审查过滤;快照之后被删的作品直接跳过)
            const rows = q(d, `SELECT ${WCOLS} FROM adult_works w WHERE w.wk IN (${slice.map(() => '?').join(',')}) AND ${ELIG}`).all(...slice);
            const byWk = new Map(rows.map((r) => [r.wk, r]));
            const ctx = { t: s.at, act };
            out.results = slice.map((wk) => byWk.get(wk)).filter((w) => w && liveCount(w, act) > 0).map((w) => card(w, ctx));
        } catch (e) { warn('browse', e.message); }
        return out;
    }

    // ---------- 作品 / 线路 ----------
    // 标签是否做成导航标签:审查级(强制凌辱/乱伦/催眠/时间停止…)永不;taxonomy 若给标签带了 review / featured:false 也照办;
    //   标签名本身被分类审查判成 code/hide 级的也不要
    const TAG_INFO = new Map();
    for (const t of X.TAGS) {
        let featured = !NONFEATURED.has(t.id) && t.featured !== false && !t.review;
        if (featured) {
            try { const r = X.classify(t.label).review; if (r === 'code' || r === 'hide') featured = false; } catch (_) { featured = false; }
        }
        TAG_INFO.set(t.id, { id: t.id, label: t.label, featured });
    }
    const kindOfWk = (k) => (k.indexOf('#clip') >= 0 ? 'clip' : /#U(?=$|[#~])/.test(k) ? 'U' : 'main');
    const isKanjiOnly = (n) => /^[㐀-鿿豈-﫿々〆\s·・]+$/u.test(n);
    // 线路第一集地址去掉协议和域名后的路径:不同 CDN 上路径一样 = 同一上游的同一个文件
    function epPath(pu) {
        const s = String(pu || '');
        const m = /(?:^|[#$])(https?:\/\/[^\s#$]+)/i.exec(s);
        if (!m) return '';
        let p;
        try { p = new URL(m[1]).pathname; } catch (_) { return ''; }
        const segs = p.split('/').filter(Boolean);
        return segs.length >= 2 && p.length >= 16 ? p : '';
    }
    // 演员:只认 vod_actor(资源站标注)或 title.js 有把握的解析;纯汉字的解析结果不要(多半是标签 / 素人网名);
    //   国产自拍 / 探花 / 主播 / 网红 分区一律不给。片名解析出的名字只在日本片分区用(TITLE_ACTRESS_BUCKETS):
    //   动漫里是角色/VTuber 名、欧美/国产传媒里是频道/上传者 handle、AI 短剧/解说/混合分区认不准 —— 那些分区只信 vod_actor
    function actressOf(bucket, rows) {
        if (NO_ACTRESS_BUCKETS.has(bucket)) return [];
        const out = [];
        const add = (n) => {
            const v = String(n || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
            if (!v || v.length < 2 || v.length > 24 || ACTOR_JUNK.test(v) || /[0-9#@!！?？【】\[\]()（）<>《》:：|/\\]/.test(v)) return;
            if (!/^[぀-ヿ㐀-鿿ー・々A-Za-z .'-]+$/u.test(v)) return;
            try { if (P.checkQuery(v)) return; } catch (_) { return; }
            // 演员按钮点了就是全站搜:名字本身像审查级题材词(催眠 / 強制 …)的也不给
            try { if (X.classify(v).review) return; } catch (_) { return; }
            if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
        };
        for (const r of rows) {
            let raw = null;
            try { raw = JSON.parse(r.raw || 'null'); } catch (_) { raw = null; }
            for (const a of String((raw && raw.a) || '').split(/[,，、/|;；]+/)) add(a);
            let parsed = null;
            try { parsed = T.parseTitle(r.name, r.type_name || ''); } catch (_) { parsed = null; }
            if (TITLE_ACTRESS_BUCKETS.has(bucket)) for (const a of (parsed && Array.isArray(parsed.actress) ? parsed.actress : [])) if (!isKanjiOnly(String(a))) add(a);
            if (out.length >= 6) break;
        }
        return out.slice(0, 6);
    }
    // 排序:活的在前;同家族挨着(家族第一次出现的位置把整个家族带上);其余保持原顺序
    function orderSources(list) {
        const out = [];
        for (const deadPart of [false, true]) {
            const part = list.filter((s) => !!s._dead === deadPart);
            const used = new Set();
            for (let i = 0; i < part.length; i++) {
                if (used.has(i)) continue;
                used.add(i);
                out.push(part[i]);
                const f = part[i]._family;
                if (!f) continue;
                for (let k = i + 1; k < part.length; k++) if (!used.has(k) && part[k]._family === f) { used.add(k); out.push(part[k]); }
            }
        }
        return out;
    }
    function readGroup(d, wk) {
        const w = q(d, `SELECT ${WCOLS}, w.ckey, w.clean, w.tags, w.variants FROM adult_works w WHERE w.wk=? AND ${ELIG}`).get(wk);
        if (!w) return null;
        const act = activeSites();
        const items = q(d, `SELECT i.site, i.vod_id, i.name, i.pic, i.play_from, i.play_url, i.play_at, i.type_name, i.variant, i.dur, i.flags, i.last_seen,
                                   i.dead, i.res, i.raw
                            FROM adult_items i WHERE i.wk=? AND ${ELIG_I}`).all(wk);
        // 每站一条:没判死的优先,其次中字,再其次最近见到的
        const better = (a, b) => (!!a.dead !== !!b.dead ? !a.dead
            : (a.flags & F_ZH) !== (b.flags & F_ZH) ? (a.flags & F_ZH) > (b.flags & F_ZH) : a.last_seen > b.last_seen);
        const best = new Map();
        for (const it of items) {
            if (!act.has(it.site)) continue;
            const b = best.get(it.site);
            if (!b || better(it, b)) best.set(it.site, it);
        }
        const t = nowFn();
        const picked = [...best.values()].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
        // 同源(同一上游、不同 CDN / 家族):站点表 upstream 相同,或第一集路径(去掉域名)相同;组里至少跨两个家族才标
        const famKey = (s) => s.family || ('site:' + s.key);
        const groups = new Map();
        const keyOf = (it) => {
            const s = act.get(it.site);
            const ks = [];
            if (s.upstream) ks.push('u:' + s.upstream);
            const p = epPath(it.play_url);
            if (p) ks.push('p:' + p);
            return ks;
        };
        for (const it of picked) for (const k of keyOf(it)) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it.site); }
        // 并查集:A、B 同 upstream,B、C 第一集路径相同 → A/B/C 同一组
        const parent = new Map(picked.map((it) => [it.site, it.site]));
        const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
        for (const members of groups.values()) for (let i = 1; i < members.length; i++) { const a = find(members[0]), b = find(members[i]); if (a !== b) parent.set(b, a); }
        const comps = new Map();
        for (const it of picked) { const r = find(it.site); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(it.site); }
        const sameOf = new Map();
        for (const members of comps.values()) {
            if (members.length < 2 || new Set(members.map((k) => famKey(act.get(k)))).size < 2) continue;   // 同一家族的镜像不算"同源"(那是 _family)
            const id = 'g' + U.hash31(members.slice().sort().join('|') + '|' + wk).toString(36);
            for (const k of members) sameOf.set(k, id);
        }
        const sources = orderSources(picked.map((it) => {
            const s = act.get(it.site);
            const src = {
                site_key: s.key, site_name: s.name + (it.variant ? ' · ' + it.variant : ''), vod_id: it.vod_id, vod_name: it.name,
                vod_pic: !it.pic ? '' : IMG_PROXY ? imgUrl(wk, s.key) : it.pic,
                type_name: it.type_name || '', _variant: it.variant || '', _dur: it.dur || 0,
                _family: s.family || '', _dead: !!it.dead, _res: /^\d{2,5}x\d{2,5}$/.test(it.res || '') ? it.res : '',
                _native: s.nativeHls === false ? 'risky' : 'ok', _same: sameOf.get(s.key) || '',
            };
            if (it.play_url && it.play_at && t - it.play_at <= C.playTtlMs) {
                src.vod_play_url = it.play_url;
                if (it.play_from) src.vod_play_from = it.play_from;
            }
            return src;
        }));
        if (!sources.length) return null;
        const isCode = wk.indexOf('c:') === 0;
        let siblings = [];
        if (isCode && w.ckey) {
            siblings = q(d, `SELECT w.wk, w.name, w.sites FROM adult_works w WHERE w.ckey=? AND w.wk<>? AND substr(w.wk, 1, 2)='c:' AND ${ELIG} ORDER BY w.is_clip, w.n_sites DESC LIMIT 10`).all(w.ckey, wk)
                .filter((r) => liveCount(r, act) > 0)
                .map((r) => ({ wk: r.wk, name: r.name, kind: kindOfWk(r.wk) }));
        }
        const tags = String(w.tags || '').split(',').filter(Boolean).map((id) => TAG_INFO.get(id)).filter(Boolean).map((x) => Object.assign({}, x));
        return {
            name: w.name,
            pic: (w.pic ? (IMG_PROXY ? imgUrl(wk, String(w.pic_item || '').split('|')[0]) : w.pic) : '') || sources[0].vod_pic || '',
            _wk: wk,
            _meta: {
                code: w.code || '', dur: w.dur_med || 0, bucket: w.bucket, bucket_label: X.bucketLabel(w.bucket) || '',
                tags, n_sites: sources.length,
                label_prefix: isCode && w.ckey && !/^UNC-/.test(w.ckey) ? String(w.ckey).split('-')[0] : '',
                actress: actressOf(w.bucket, items.filter((it) => act.has(it.site))),
                variants: w.variants ? w.variants.split(',').filter(Boolean) : [], siblings,
                first_seen: w.first_seen,
            },
            sources,
        };
    }
    // 扩线:现搜别的站补线路(番号作品搜 [带横线, 不带横线],绝不搜光厂牌;无番号作品搜精确净标题),搜到的合格条目写回索引
    const expanding = new Map();
    async function doExpand(wk) {
        const d = dbOf();
        if (!d || rescanPending) return;
        const w = q(d, `SELECT w.wk, w.code, w.ckey, w.clean, w.name FROM adult_works w WHERE w.wk=? AND ${ELIG}`).get(wk);
        if (!w) return;
        const isCode = wk.indexOf('c:') === 0;
        let variants = [], relevant;
        if (isCode) {
            const key = w.ckey;
            const sv = T.searchVariants(w.code || key || '');
            // searchVariants 只会给 [带横线, 不带横线] 的完整番号(或日期码两种写法),从不给光厂牌
            if (key && sv.kind === 'code') variants = sv.variants.slice(0, 2);
            relevant = (it) => { try { return T.parseTitle(it.vod_name, it.type_name).key === key; } catch (_) { return false; } };
        } else {
            const tk = wk.slice(2).replace(/~d?\d+$/, '');
            const qv = String(w.clean || '').trim().slice(0, 80);
            // 太短的标题("人妻""自拍")各站一搜一大把同名不同片,不扩
            if (tk && qv && [...tk].length >= 4) variants = [qv];
            relevant = (it) => { try { return T.parseTitle(it.vod_name, it.type_name).titleKey === tk; } catch (_) { return false; } };
        }
        if (!variants.length) return;
        const t0 = nowFn();
        const have = new Set(q(d, 'SELECT DISTINCT site FROM adult_items WHERE wk=?').all(wk).map((r) => r.site));
        const cache = new Map(q(d, 'SELECT site, found, at FROM adult_expand WHERE wk=?').all(wk).map((r) => [r.site, r]));
        let sites = [...activeSites().values()].filter((s) => s.search && !have.has(s.key) && !(isCode && !s.codeTrust));
        sites = sites.filter((s) => { const c = cache.get(s.key); return !c || t0 - c.at >= (c.found ? C.expandPosMs : C.expandNegMs); });
        sites.sort((a, b) => (b.searchFirst ? 1 : 0) - (a.searchFirst ? 1 : 0));
        if (!sites.length) { stats.expand.cached++; return; }
        stats.expand.runs++;
        const local = new U.Sem(C.expandPer);
        let budget = C.expandMaxReq;
        const deadline = t0 + C.expandDeadlineMs;
        await Promise.all(sites.map(async (s) => {
            await local.acquire();
            try {
                let found = 0, answered = false;
                for (const v of variants) {
                    if (budget <= 0 || nowFn() > deadline) break;
                    let cmap = classMapFor(s.api);
                    if (!cmap) {
                        budget--;
                        cmap = await withGlobal(() => ensureClassMap(s));
                        if (!cmap) break;
                    }
                    budget--;
                    stats.expand.requests++;
                    let j = null;
                    try {
                        const url = urlFor(s, 'ac=detail&wd=' + encodeURIComponent(v));
                        guardUrl(s, url);
                        j = await withGlobal(() => doGet(url, C.expandTimeoutMs, s.key));
                    } catch (e) { stats.expand.errors++; continue; }
                    if (!j || !Array.isArray(j.list)) { stats.expand.errors++; continue; }
                    answered = true;
                    const rel = j.list.filter((it) => it && typeof it === 'object' && relevant(it)).slice(0, 20);
                    const d2 = dbOf();
                    if (rel.length && d2) {
                        const r = ingestBatch(d2, s, rel, { src: 'search', cmap });
                        found += r.wks.filter((x) => x === wk).length;
                    }
                    if (found) break;   // 带横线的已经找到,不再搜不带横线的
                }
                const d2 = dbOf();
                if (answered && d2) q(d2, 'INSERT OR REPLACE INTO adult_expand (wk, site, found, at) VALUES (?, ?, ?, ?)').run(wk, s.key, found ? 1 : 0, nowFn());
                stats.expand.found += found;
            } finally { local.release(); }
        }));
    }
    async function work(wk, opts) {
        try {
            if (typeof wk !== 'string' || !wk || wk.length > 300) return null;
            const o = opts && typeof opts === 'object' ? opts : {};
            if (!dbOf() || rescanPending) return null;
            if (o.expand) {
                let p = expanding.get(wk);
                if (p) stats.expand.coalesced++;
                else {
                    p = doExpand(wk).catch((e) => warn('expand', e.message)).finally(() => { if (expanding.get(wk) === p) expanding.delete(wk); });
                    expanding.set(wk, p);
                }
                await p;
            }
            const d = dbOf();
            if (!d || rescanPending) return null;
            return readGroup(d, wk);
        } catch (e) { warn('work', e.message); return null; }
    }

    // 本地查找(扩展接口):番号查询按 key 精确命中;文字 ≥3 字走 FTS trigram,否则 LIKE。零上游请求
    function codeRows(d, key, n) {
        return q(d, `SELECT ${WCOLS} FROM adult_works w WHERE w.ckey=? AND substr(w.wk, 1, 2)='c:' AND ${ELIG} ORDER BY w.is_clip, w.n_sites DESC, w.first_seen DESC LIMIT ?`).all(key, n);
    }
    function textRows(d, s, n) {
        if (ftsOk && [...s].length >= 3) {
            return q(d, `SELECT ${WCOLS} FROM adult_fts f JOIN adult_works w ON w.rowid = f.rowid WHERE adult_fts MATCH ? AND ${ELIG} ORDER BY w.n_sites DESC, w.first_seen DESC LIMIT ?`)
                .all('"' + s.replace(/"/g, '""') + '"', n);
        }
        return q(d, `SELECT ${WCOLS} FROM adult_works w WHERE w.name LIKE ? ESCAPE '\\' AND ${ELIG} ORDER BY w.n_sites DESC, w.first_seen DESC LIMIT ?`)
            .all('%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%', n);
    }
    function lookup(query, opts) {
        try {
            const o = opts && typeof opts === 'object' ? opts : {};
            const limit = Math.max(1, Math.min(24, parseInt(o.limit, 10) || 8));
            const d = dbOf();
            if (!d || rescanPending) return [];
            const s = String(query == null ? '' : query).normalize('NFKC').trim().slice(0, 100);
            if (!s || P.checkQuery(s)) return [];
            const sv = T.searchVariants(s);
            const rows = sv.kind === 'code' && sv.key ? codeRows(d, sv.key, limit * 2) : textRows(d, s, limit * 2);
            const act = activeSites();
            const ctx = { t: nowFn(), act };
            return rows.filter((w) => liveCount(w, act) > 0).slice(0, limit).map((w) => card(w, ctx));
        } catch (e) { warn('lookup', e.message); return []; }
    }

    // ---------- 标签(当前快照内计数) ----------
    function tags(b) {
        const out = { tags: [] };
        try {
            const bb = b == null ? '' : String(b).trim();
            if (bb && !NAV.has(bb)) return out;
            const s = ensureSnap();
            const d = dbOf();
            if (!d || s.empty) return out;
            if (!s.tags) s.tags = new Map();
            let list = s.tags.get(bb);
            if (!list) {
                const act = activeSites();
                const sql = `SELECT w.tags, w.sites FROM adult_works w WHERE ${bb ? 'w.bucket=? AND ' : ''}w.is_clip=0 AND w.tags <> '' AND ${ELIG}`;
                const rows = bb ? q(d, sql).all(bb) : q(d, sql).all();
                const cnt = new Map();
                for (const r of rows) {
                    if (liveCount(r, act) <= 0) continue;
                    for (const id of String(r.tags).split(',')) if (id && TAG_INFO.has(id) && !NO_CHIP_TAGS.has(id)) cnt.set(id, (cnt.get(id) || 0) + 1);
                }
                list = [...cnt.entries()].sort((a, c) => c[1] - a[1] || (a[0] < c[0] ? -1 : 1)).slice(0, 24)
                    .map(([id, count]) => Object.assign({}, TAG_INFO.get(id), { count }));
                s.tags.set(bb, list);
            }
            out.tags = list.map((x) => Object.assign({}, x));
        } catch (e) { warn('tags', e.message); }
        return out;
    }

    // ---------- 本地联想(零上游) ----------
    const normQ = (v) => T.t2s(String(v == null ? '' : v).normalize('NFKC')).toLowerCase().replace(/[\s​-‏﻿]+/g, '');
    const ALIAS = new Map();
    (function buildAlias() {
        const add = (w, v) => { const k = normQ(w); if (k && !ALIAS.has(k)) ALIAS.set(k, v); };
        const B = (b) => (NAV.has(b) ? { b, label: X.bucketLabel(b) } : null);
        const Tg = (id) => { const t = TAG_INFO.get(id); return t && t.featured ? { tag: id, label: t.label } : null; };   // 审查级标签不做别名
        const manual = [
            ['无码', B('jp_uncensored')], ['無碼', B('jp_uncensored')], ['有码', B('jp_censored')], ['日本', B('jp_censored')], ['中字', B('jp_subbed')], ['中文字幕', B('jp_subbed')], ['字幕', B('jp_subbed')],
            ['探花', B('cn_hookup')], ['约炮', B('cn_hookup')], ['里番', B('anime')], ['动漫', B('anime')], ['动画', B('anime')], ['欧美', B('western')],
            ['国产', B('cn_amateur')], ['自拍', B('cn_amateur')], ['传媒', B('cn_studio')], ['主播', B('live')], ['直播', B('live')],
            ['网红', B('creators')], ['福利姬', B('creators')], ['短视频', B('short')], ['抖音', B('short')], ['竖屏', B('short')],
            ['三级', B('softcore')], ['伦理', B('softcore')], ['解说', B('commentary')], ['sm', B('fetish')], ['重口', B('fetish')],
            ['同性', B('lgbt')], ['ts', B('lgbt')], ['韩国', B('asia')], ['东南亚', B('asia')], ['ai短剧', B('ai_drama')],
            ['人妻', Tg('milf')], ['熟女', Tg('milf')], ['巨乳', Tg('busty')], ['美乳', Tg('busty')], ['制服', Tg('uniform')], ['丝袜', Tg('legs')], ['美腿', Tg('legs')],
            ['cosplay', Tg('cosplay')], ['cos', Tg('cosplay')], ['群交', Tg('group')], ['多p', Tg('group')], ['ntr', Tg('ntr')], ['绿帽', Tg('ntr')],
            ['口交', Tg('oral')], ['颜射', Tg('oral')], ['自慰', Tg('solo')], ['潮吹', Tg('squirt')], ['调教', Tg('bdsm')], ['露出', Tg('outdoor')], ['野外', Tg('outdoor')],
            ['女同', Tg('lesbian')], ['百合', Tg('lesbian')], ['男同', Tg('gay')], ['跨性别', Tg('trans')], ['vr', Tg('vr')], ['素人', Tg('amateur')],
            ['黑人', Tg('bbc')], ['按摩', Tg('massage')], ['剧情', Tg('story')], ['港台', Tg('hktw')], ['高颜值', Tg('beauty')],
        ];
        for (const [w, v] of manual) if (v) add(w, v);
        for (const b of X.NAV_BUCKETS) { const v = B(b); add(v.label, v); for (const part of v.label.split(/[·・]/)) if ([...part].length >= 2) add(part, v); }
        for (const t of TAG_INFO.values()) if (t.featured) add(t.label, { tag: t.id, label: t.label });
    })();
    function suggest(query) {
        const out = { kind: 'empty', alias: null, exact: null, items: [] };
        try {
            const s = String(query == null ? '' : query).normalize('NFKC').replace(/[​-‏﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
            if (!s) return out;
            let blocked = true;
            try { blocked = !!P.checkQuery(s); } catch (_) { blocked = true; }
            if (blocked) { out.kind = 'blocked'; return out; }
            const d = dbOf();
            const act = activeSites();
            const ctx = { t: nowFn(), act };
            const sv = T.searchVariants(s);
            if (sv.kind === 'code' && sv.key) {
                out.kind = 'code';
                if (!d || rescanPending) return out;
                const rows = codeRows(d, sv.key, 16).filter((w) => liveCount(w, act) > 0);
                const mains = rows.filter((w) => kindOfWk(w.wk) === 'main');
                if (mains.length === 1) out.exact = mains[0].wk;
                else if (mains.length > 1) {
                    // 同番号按时长拆出来的 '~2' / '~d<秒>' 版本不算另一部:正片全是 本体 + 它的 ~N 时直接开本体(作品页「同番号另一版本」列着其余的)
                    const base = mains.find((w) => !/~d?\d+$/.test(w.wk));
                    if (base && mains.every((w) => w.wk === base.wk || w.wk.replace(/~d?\d+$/, '') === base.wk)) out.exact = base.wk;
                }
                const rank = (w) => ({ main: 0, U: 1, clip: 2 })[kindOfWk(w.wk)];
                out.items = rows.sort((a, b) => rank(a) - rank(b)).slice(0, 8).map((w) => card(w, ctx));
                return out;
            }
            const al = ALIAS.get(normQ(s));
            out.kind = al ? 'alias' : 'text';
            if (al) out.alias = Object.assign({}, al);
            if (!d || rescanPending) return out;
            let rows = textRows(d, s, 16);
            const s2 = T.t2s(s);
            if (!rows.length && s2 !== s) rows = textRows(d, s2, 16);
            out.items = rows.filter((w) => liveCount(w, act) > 0 && w.wk.indexOf('#clip') < 0).slice(0, 8).map((w) => card(w, ctx));
        } catch (e) { warn('suggest', e.message); out.items = []; }
        return out;
    }

    // ---------- 播放结果上报(零上游) ----------
    // r: {wk, site_key, vod_id, ok, err?, dur?, w?, h?};who: 上报者标识(调用方传 令牌 + 可信客户端网络 的哈希)。
    //   who 为空 = 认不出的匿名上报者(调用方判定):成功照收(补时长/分辨率/复活),失败不计数(伪造转发头造不出"不同上报者")。
    //   返回 {ok, reason?, dead?}
    function beacon(r, who) {
        try {
            const d = dbOf();
            if (!d || rescanPending) return { ok: false, reason: 'unavailable' };
            const b = r && typeof r === 'object' ? r : {};
            const site = typeof b.site_key === 'string' ? b.site_key : '';
            const vid = (typeof b.vod_id === 'string' || typeof b.vod_id === 'number') ? String(b.vod_id) : '';
            const id = typeof who === 'string' ? who.slice(0, 128) : '';
            if (!site || site.length > 64 || !vid || vid.length > 64 || typeof b.ok !== 'boolean') { stats.beacon.ignored++; return { ok: false, reason: 'invalid' }; }
            if (!b.ok && !id) { stats.beacon.ignored++; return { ok: false, reason: 'anonymous' }; }
            const it = q(d, 'SELECT wk, dur, dead, ok_at, res FROM adult_items WHERE site=? AND vod_id=?').get(site, vid);
            if (!it) { stats.beacon.ignored++; return { ok: false, reason: 'unknown' }; }
            // 线路身份是 (站, vod_id);客户端手里的作品键可能已过时(片段/完整版迁移)—— 状态照记,时长只在作品键对得上时补
            const sameWk = typeof b.wk !== 'string' || !b.wk || b.wk === it.wk;
            const t = nowFn();
            let dead = !!it.dead;
            d.transaction(() => {
                if (b.ok) {
                    stats.beacon.ok++;
                    if (it.dead) stats.beacon.revived++;
                    q(d, 'UPDATE adult_items SET dead=0, ok_at=?, dead_at=NULL WHERE site=? AND vod_id=?').run(t, site, vid);
                    q(d, 'DELETE FROM adult_line_fail WHERE site=? AND vod_id=?').run(site, vid);
                    dead = false;
                    const dur = Math.round(Number(b.dur));
                    if (sameWk && !(it.dur > 0) && Number.isFinite(dur) && dur >= 1 && dur <= 12 * 3600) {
                        // 只收和作品里其他线路对得上的时长(一个上报不该把作品拆开)
                        const others = q(d, 'SELECT dur FROM adult_items WHERE wk=? AND dur>0 AND NOT (site=? AND vod_id=?) LIMIT 200').all(it.wk, site, vid).map((x) => x.dur);
                        if (U.durCompatible(dur, U.median(others))) {
                            q(d, 'UPDATE adult_items SET dur=? WHERE site=? AND vod_id=?').run(dur, site, vid);
                            refreshWork(d, it.wk);
                            stats.beacon.dur++;
                        }
                    }
                    const w = Math.round(Number(b.w)), h = Math.round(Number(b.h));
                    if (Number.isFinite(w) && Number.isFinite(h) && w >= 16 && h >= 16 && w <= 16384 && h <= 16384) {
                        const res = w + 'x' + h;
                        if (res !== it.res) { q(d, 'UPDATE adult_items SET res=? WHERE site=? AND vod_id=?').run(res, site, vid); stats.beacon.res++; }
                    }
                } else {
                    stats.beacon.fail++;
                    q(d, 'INSERT OR REPLACE INTO adult_line_fail (site, vod_id, who, at) VALUES (?, ?, ?, ?)').run(site, vid, id, t);
                    // 24h 内、且不早于上次成功(成功时已把之前的失败删掉;这里再按时间兜一道)的不同上报者
                    const since = Math.max(t - C.deadWindowMs, it.ok_at || 0);
                    const n = q(d, 'SELECT COUNT(*) n FROM adult_line_fail WHERE site=? AND vod_id=? AND at >= ?').get(site, vid, since).n;
                    if (n >= C.deadTokens && !it.dead) {
                        q(d, 'UPDATE adult_items SET dead=1, dead_at=? WHERE site=? AND vod_id=?').run(t, site, vid);
                        stats.beacon.dead++;
                        dead = true;
                    }
                    q(d, 'DELETE FROM adult_line_fail WHERE site=? AND vod_id=? AND at < ?').run(site, vid, t - 2 * C.deadWindowMs);
                }
            })();
            return { ok: true, dead };
        } catch (e) { warn('beacon', e.message); return { ok: false, reason: 'error' }; }
    }

    // ---------- 封面代理查地址(只从索引里查;客户端给不了地址) ----------
    //   opts.meta:true → {url, name, bucket}(闸门再按片名过一遍策略),否则只回地址
    function picUrl(wk, siteKey, opts) {
        try {
            if (typeof wk !== 'string' || !wk || wk.length > 300) return null;
            const d = dbOf();
            if (!d || rescanPending) return null;
            const w = q(d, `SELECT w.wk, w.pic_item, w.name, w.bucket FROM adult_works w WHERE w.wk=? AND ${ELIG}`).get(wk);
            if (!w) return null;
            const act = activeSites();
            let site = typeof siteKey === 'string' ? siteKey : '';
            let vid = null;
            if (!site) { const pi = String(w.pic_item || '').split('|'); site = pi[0] || ''; vid = pi.length > 1 ? pi.slice(1).join('|') : null; }
            if (!site || !act.has(site)) return null;
            const row = vid != null
                ? q(d, `SELECT i.pic FROM adult_items i WHERE i.wk=? AND i.site=? AND i.vod_id=? AND ${ELIG_I}`).get(wk, site, vid)
                : q(d, `SELECT i.pic FROM adult_items i WHERE i.wk=? AND i.site=? AND i.pic <> '' AND ${ELIG_I} ORDER BY i.last_seen DESC LIMIT 1`).get(wk, site);
            const u = row && row.pic;
            if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return null;
            return opts && opts.meta ? { url: u, name: w.name, bucket: w.bucket } : u;
        } catch (e) { warn('picUrl', e.message); return null; }
    }

    // ---------- 搜索回写(异步队列,不阻塞搜索请求) ----------
    const sq = [];
    let sqItems = 0, sqRunning = null;
    function ingestSearchItems(siteKey, rawItems) {
        try {
            if (!Array.isArray(rawItems) || !rawItems.length) return;
            const site = activeSites().get(String(siteKey));
            if (!site) return;
            const items = rawItems.slice(0, 100).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
            if (!items.length) return;
            if (sqItems + items.length > C.searchQueueMax) { stats.searchDropped += items.length; return; }
            sq.push({ site, items });
            sqItems += items.length;
            if (!sqRunning) {
                sqRunning = new Promise((r) => setImmediate(r)).then(drainSearch)
                    .catch((e) => warn('search ingest', e.message))
                    .finally(() => { sqRunning = null; });
            }
        } catch (e) { warn('search ingest', e.message); }
    }
    async function drainSearch() {
        while (sq.length) {
            const { site, items } = sq.shift();
            sqItems -= items.length;
            if (rescanPending) { bump(stats.rejected, 'rescan', items.length); continue; }
            let cmap = classMapFor(site.api);
            if (!cmap) cmap = await ensureClassMap(site);
            const d = dbOf();
            if (!cmap || !d) { bump(stats.rejected, 'noclass', items.length); continue; }
            const r = ingestBatch(d, site, items, { src: 'search', cmap });
            if (r.noclass) forceClassRefresh(d, site.api);
        }
    }
    async function flush() {
        for (let i = 0; i < 1000 && (sqRunning || rescanP); i++) {
            try { await (sqRunning || rescanP); } catch (_) { /* 已记日志 */ }
        }
    }

    // ---------- 保留期 ----------
    function retention() {
        const d = dbOf();
        if (!d || rescanPending) return 0;
        const t = nowFn();
        const keep = new Set();
        if (typeof deps.referenced === 'function') {
            try { const r = deps.referenced(); if (r && typeof r[Symbol.iterator] === 'function') for (const x of r) if (typeof x === 'string' && x) keep.add(x); }
            catch (e) { warn('referenced', e.message); return 0; }   // 不知道谁还被引用 → 这轮不删
        }
        const rows = q(d, 'SELECT i.site, i.vod_id, i.wk, w.name FROM adult_items i LEFT JOIN adult_works w ON w.wk = i.wk WHERE i.last_seen < ? LIMIT 20000').all(t - C.retentionMs);
        let n = 0;
        d.transaction(() => {
            const dirty = new Set();
            for (const r of rows) {
                if (keep.has(r.wk) || (r.name && keep.has(r.name))) continue;
                q(d, 'DELETE FROM adult_items WHERE site=? AND vod_id=?').run(r.site, r.vod_id);
                dirty.add(r.wk);
                n++;
            }
            for (const wk of dirty) refreshWork(d, wk);
            q(d, 'DELETE FROM adult_expand WHERE at < ?').run(t - Math.max(C.expandNegMs, C.expandPosMs));
            // 计数 / 失败上报跟着条目走
            q(d, 'DELETE FROM adult_hits WHERE NOT EXISTS (SELECT 1 FROM adult_items i WHERE i.site = adult_hits.site AND i.vod_id = adult_hits.vod_id)').run();
            q(d, 'DELETE FROM adult_line_fail WHERE at < ? OR NOT EXISTS (SELECT 1 FROM adult_items i WHERE i.site = adult_line_fail.site AND i.vod_id = adult_line_fail.vod_id)').run(t - 2 * C.deadWindowMs);
        })();
        stats.retention = { at: t, deleted: n };
        if (n) log('保留期清理 ' + n + ' 条');
        return n;
    }

    // ---------- 规则版本变了:全库按新规则重跑 ----------
    function checkRules(d) {
        if (getMeta(d, 'rules') === RULES_VERSION) return;
        if (!q(d, 'SELECT 1 FROM adult_items LIMIT 1').get()) { setMeta(d, 'rules', RULES_VERSION); return; }
        rescanPending = true;   // 重跑完之前所有读接口回空
        startRescan(d);
    }
    function startRescan(d) {
        if (rescanP) return rescanP;
        rescanP = new Promise((r) => setImmediate(r)).then(() => runRescan(d))
            .catch((e) => warn('rescan', 'failed, catalog stays dark until retried: ' + e.message))
            .finally(() => { rescanP = null; });
        return rescanP;
    }
    function rawFromRow(row) {
        let r;
        try { r = JSON.parse(row.raw || ''); } catch (_) { return null; }
        if (!r || typeof r !== 'object') return null;
        return {
            vod_id: row.vod_id, vod_name: r.n, vod_sub: r.s, vod_content: r.c, vod_blurb: r.b, type_id: r.t, type_name: r.tn,
            vod_tag: r.tg, vod_class: r.cl, vod_remarks: r.rm, vod_duration: r.du, vod_time: r.tm, vod_pic: r.p,
            vod_play_from: r.pf, vod_play_url: row.play_url, vod_actor: r.a, vod_director: r.dr, vod_area: r.ar,
        };
    }
    async function runRescan(d) {
        const sitesAll = allSites();
        // 站点配置还没加载(REMOTE_DB_URL 没拉到 / 返回空)→ 不重扫(否则会把所有行当"站点已删除"删光),读接口继续回空,下一轮爬虫再试
        if (!sitesAll.size) { warn('rescan', 'site list empty, rescan deferred'); return; }
        // 站点的 API 地址改了、新地址的分类表还没拉:用上次爬它时的地址的分类表复查
        const crawledApi = new Map(q(d, 'SELECT site, api FROM adult_crawl_state').all().map((r) => [r.site, r.api]));
        const cmapOf = (s) => classMapFor(s.api) || (crawledApi.get(s.key) ? classMapFor(crawledApi.get(s.key)) : null);
        let last = ['', ''], checked = 0, dropped = 0;
        for (;;) {
            const rows = q(d, 'SELECT * FROM adult_items WHERE site > ? OR (site = ? AND vod_id > ?) ORDER BY site, vod_id LIMIT ?').all(last[0], last[0], last[1], C.rescanChunk);
            if (!rows.length) break;
            d.transaction(() => {
                for (const row of rows) {
                    checked++;
                    const s = sitesAll.get(row.site);
                    const cmap = s ? cmapOf(s) : null;
                    const raw = rawFromRow(row);
                    let r = { ok: false };
                    if (s && cmap && raw) {
                        try { r = ingestItem(d, s, raw, { src: row.src || 'crawl', cmap, now: row.last_seen, playAt: row.play_at }); }
                        catch (e) { r = { ok: false }; }
                    }
                    if (!r.ok) {
                        q(d, 'DELETE FROM adult_items WHERE site=? AND vod_id=?').run(row.site, row.vod_id);
                        refreshWork(d, row.wk);
                        dropped++;
                    }
                }
            })();
            last = [rows[rows.length - 1].site, rows[rows.length - 1].vod_id];
            await new Promise((r) => setImmediate(r));
        }
        setMeta(d, 'rules', RULES_VERSION);
        rescanPending = false;
        log(`规则版本 ${RULES_VERSION}:重扫 ${checked} 条,删除 ${dropped} 条`);
        rebuild();
    }

    // ---------- 启停 ----------
    let started = false, tickTimer = null, homeTimer = null, retTimer = null;
    const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };
    function start() {
        if (started) return;
        if (DISABLED) { log('CATALOG_DISABLE=1:不启动目录爬虫(读接口照常)'); return; }
        started = true;
        dbOf();   // 建表 + 规则版本检查
        const loop = async () => {
            if (!started) return;
            try { await tick(); } catch (e) { warn('tick', e.message); }
            if (started) tickTimer = unref(setTimeout(loop, C.tickMs));
        };
        tickTimer = unref(setTimeout(loop, C.firstDelayMs));
        homeTimer = unref(setInterval(() => { try { rebuild(); } catch (e) { warn('home', e.message); } }, C.homeMs));
        retTimer = unref(setInterval(() => { try { retention(); } catch (e) { warn('retention', e.message); } }, C.retentionEveryMs));
        log(`已启动:爬 ${crawlSites().length} 个站,首轮 ${C.firstDelayMs}ms 后;规则 ${RULES_VERSION}`);
    }
    function stop() {
        started = false;
        clearTimeout(tickTimer);
        clearInterval(homeTimer);
        clearInterval(retTimer);
        tickTimer = homeTimer = retTimer = null;
    }

    function statsFn() {
        const out = {
            disabled: DISABLED, started, rulesVersion: RULES_VERSION, rescanPending, fts: ftsOk, maxSites: MAX_SITES || null,
            requests: stats.requests, ingested: stats.ingested, rejected: Object.assign({}, stats.rejected), flags: Object.assign({}, stats.flags),
            migrated: stats.migrated, searchQueue: sqItems, searchDropped: stats.searchDropped, retention: stats.retention, lastTick,
            expand: Object.assign({}, stats.expand, { inflight: expanding.size, globalActive: gsem.active, globalPeak: gsem.peak }),
            hits: Object.assign({}, stats.hits), backfill: Object.assign({}, stats.backfill), beacon: Object.assign({}, stats.beacon), imgProxy: IMG_PROXY,
            home: snap ? { generatedAt: snap.home.generatedAt, rows: snap.home.rows.map((r) => ({ id: r.id, n: r.items.length })) } : null,
        };
        try {
            const d = dbOf();
            if (d) {
                out.items = q(d, 'SELECT COUNT(*) n FROM adult_items').get().n;
                out.works = q(d, 'SELECT COUNT(*) n FROM adult_works').get().n;
                out.sites = q(d, 'SELECT site, last_ok, next_at, mode, pagesize, fails, last_err, ignores_h, n_req, n_items, cursor IS NOT NULL AS resuming FROM adult_crawl_state ORDER BY site').all();
                out.deadLines = q(d, 'SELECT COUNT(*) n FROM adult_items WHERE dead=1').get().n;
                out.hitsRows = q(d, 'SELECT COUNT(*) n FROM adult_hits').get().n;
                try { out.extTrust = JSON.parse(getMeta(d, 'exthot:trust') || 'null'); } catch (_) { out.extTrust = null; }
                try { const bf = JSON.parse(getMeta(d, 'backfill') || 'null'); out.backfillState = bf ? { startedAt: bf.startedAt, thin: bf.thin, queued: Array.isArray(bf.queue) ? bf.queue.length : 0 } : null; } catch (_) { out.backfillState = null; }
            }
        } catch (e) { out.error = e.message; }
        return out;
    }

    return {
        start, stop, home, browse, buckets, work, classInfo, ingestSearchItems, stats: statsFn,
        // 扩展(测试 / 运维 / 本地查找):
        tick, rebuild, retention, flush, lookup,
        // 第二阶段:标签计数 / 本地联想 / 播放上报 / 封面代理查地址
        tags, suggest, beacon, picUrl,
        imgProxy: IMG_PROXY,
        RULES_VERSION,
    };
}

module.exports = { createCatalog };
