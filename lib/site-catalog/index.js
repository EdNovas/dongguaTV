// [adult] 成人站首页目录(catalog mode):后台按 maccms 增量接口爬资源站 → SQLite 索引 → 预计算首页 / 分类浏览 / 作品线路。
//
// 为什么这样做(调研 .adult-research/analysis/verdict.md §2-§6;第三阶段 impl/cat/storage-recommendation.md、category-ux.md、p34/avdb-crawl-plan.md):
//   · 成人内容没有 TMDB:首页只能用资源站自己的"新上架"拼。上游 vod_hits 在 45/49 个站是随机数,不能当热度;
//     `ac=detail&h=<小时>` 全站都支持且一律新的在前 → 每站只拉"上次成功以来"的增量,稳态 ≈1 请求/分钟。
//   · 页面请求零上游调用:首页 / 浏览 / 分面 / 标签都读预计算快照(每 10 分钟重建),作品页只读库,
//     只有 work(wk,{expand:true}) 会现搜别的站补线路(全局信号量 ≤12、每次扩线 ≤6、按 (作品,站) 正缓存 6h / 负缓存 24h、同作品并发合并)。
//   · 绝不拉 m3u8 / 图片:所有出网请求都过 guardUrl —— 只能是 `<站 api>?ac=list` / `<站 api>?ac=detail…`,其它一律 throw。
//   · 入库顺序 fail-closed、作品键、作品名冻结、同站连排 ≤4 —— 见 writer.js 顶部。
//
// 第三阶段(本次):
//   · 存储:目录自己一个 catalog.db(dbPath;CATALOG_DB_PATH,默认 cache.db 旁边),表结构 v2(schema.js)。cache.db 里的旧 adult_* 表不再读。
//   · 线程:写全部在写线程(writer.js,自己一条连接;AVDB 也住那里),快照 / 浏览 / 分面 / 联想在两个读线程(snapshot.js),
//     主线程只做调度、出网、和几个按主键 / 索引的点查(作品页、封面地址、站点状态),永远不跑长写和全表扫描。
//     传 db 实例(测试)或 CATALOG_WORKERS=0 → 同一份代码在主线程上同步跑(inline)。
//   · 浏览:位图快照(包含 / 排除标签、时长 6 档、版本、片商、演员、排序 7 种、游标翻页、分面计数:标签按"且"、单选维度析取)—— 见 snapshot.js。
//   · 标签:lib/adult/tags(词表 163 条 9 组;featured 才做 chip / 标签云 / 相关 / 首页;review 只能筛选;blocked 永不出现)。
//   · AVDB(lib/adult-avdb,deps.avdbFactory):番号可信度、pol=block 整个番号拦掉(入库、闸门搜索出口、作品页、联想)、
//     发行日期 → 新片速递行 / released 排序、片商 / 厂牌 / 演员 / AVDB 封面兜底 / 片长兜底;演员页。
//   · 全量历史:作品永远保留,线路按健康过期;全站历史回填(每站游标可续、同域名 ≥2.2s 一个,CATALOG_BACKFILL=0 关,首轮增量爬完自动开始)。
//
// 用法(server.js):
//   const catalog = require('./lib/site-catalog').createCatalog({
//       dbPath,                               // catalog.db 路径(生产);或 db: better-sqlite3 实例 / 返回它的函数(测试,inline)
//       getSites, adult, tags?, httpGet, log, env, popularTitles?, referenced?, socketsBusy?,
//       avdbFactory: (db) => createAvdb({db, ...}) | null,   // 主线程只读实例用它建;写线程里的实例 require(avdbModule || '../adult-avdb') 自己建
//       now / sleep / opts                    // 仅测试:假时钟、假 sleep、覆盖 DEF 常量
//   });
//   catalog.start();
// 接口(读接口在 worker 模式下返回 Promise,inline 模式同步;调用方一律 await):
//   start() / stop() / close() / home() / buckets() / browse(q) / work(wk,{expand}) / classInfo(siteKey,typeId) / ingestSearchItems(siteKey,rawItems) / stats()
//   tick() / rebuild() / retention() / flush() / lookup(q,{limit}) / tags(b) / suggest(q) / beacon(r, who) / picUrl(wk, site, {meta}) / imgProxy / RULES_VERSION
//   第三阶段:tagPage(id) / studios(b) / actress(aid,{page}) / actressSearch(q) / avdbPol(key) / indexedWks(siteKey, vodIds) /
//            historyStep({maxPages}) / avdbSync({force}) / statsAsync() / ready()
//   第四阶段:related(wk,{limit}) / feed({cursor,vert,limit}) / heat(wk) / heatAdd(wk,{bins,dur},who) / beacon 多收 {orient,w,h} /
//            adminStats() / adminHide(wk,on) / adminHidden() / isHidden(wk) / setExtraBlock(words) / extraBlock() / rulesKey() /
//            adminSite(key,active) / siteOverrides() / siteActive(key) —— 签名与返回形状见各函数上方注释
//   封面域名健康:coverCheck({full}) / coverDeadHosts() / coverStatus();卡片多了可选的 alt(≤2 个别的活域名上的候补封面,代理模式没有);
//            没有活封面的作品(cov=0)首页 / 浏览 / 分面 / 相关 / 演员页 / 新片速递 / 猜你喜欢都不出,作品页 / 查找 / 联想 / 刷一刷照常(见 cover-health.js)
// 环境变量:CATALOG_DISABLE=1 / CATALOG_FIRST_DELAY_MS(默认 60000)/ CATALOG_MAX_SITES / CATALOG_EXT_HOT_SITE / ADULT_IMG_PROXY=1 /
//          CATALOG_BACKFILL=0(关全量历史回填)/ CATALOG_WORKERS=0(不开工作线程)/ CATALOG_MMAP_MB /
//          CATALOG_SHORT_BACKFILL=0(关短视频分类慢速补库)/ ADULT_COVER_HEALTH_DISABLE=1(不查封面域名、不按它隐藏)/
//          ADULT_COVER_HEALTH_DELAY_MS(封面域名首轮检查延后,默认 10 分钟)/ ADULT_COVER_SERVFAIL_DEAD=0(关掉"持续 SERVFAIL 的域名也判死",默认开)
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const U = require('./util');
const K = require('./common');
const SCH = require('./schema');
const { createWriter } = require('./writer');
const { createReader } = require('./snapshot');
const H = require('./heat');
const CH = require('./cover-health');

const { MIN, HOUR, DAY } = U;
const { ELIG, ELIG_I, F_CLIP } = K;

const DEF = {
    // 爬虫
    firstDelayMs: 60e3, tickMs: 5 * MIN, tickBusyMs: 30e3, maxReqPerTick: 120, concurrency: 2, hostGapMs: 2000, timeoutMs: 10000,
    pageSize: 60, pageSizeCapped: 20, maxHours: 72, maxPagesPerCrawl: 40,
    continuousMs: 30 * MIN, batchMs: 60 * MIN, staleMs: 6 * HOUR, staleAfterMs: 7 * DAY, continuousHours: 6,
    failBackoff: [10 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR], classMs: DAY, classRetryMs: HOUR, socketsPause: 48,
    // 首页 / 浏览 / 快照
    homeMs: 10 * MIN, rowSize: 24, poolSize: 400, rowMin: 12, rowStaleMs: 72 * HOUR, maxRun: 4, slotMs: HOUR,
    browsePage: 24, maxPages: 500, facetCacheMax: 200, relatedSupport: 5, sortMin: 12, freshDays: 60, freshMin: 12, textScan: 200,
    firstSnapWaitMs: 15000,
    // 线路
    playTtlMs: 3 * DAY,
    // 扩线
    expandGlobal: 12, expandPer: 6, expandPosMs: 6 * HOUR, expandNegMs: 24 * HOUR, expandTimeoutMs: 8000, expandMaxReq: 60, expandDeadlineMs: 20000,
    // 入库 / 保留期(全量历史:线路判死 >30 天删、站点删除 7 天后删线路;作品保留)
    retentionEveryMs: 6 * HOUR, deadExpireMs: 30 * DAY, siteGoneMs: 7 * DAY,
    searchQueueMax: 3000, rescanChunk: 500, rescanWorks: 100, rescanSnapMs: 30e3, purgeChunk: 500, orientBudget: 300, maxPlayUrl: 20000, maxContent: 1500,
    // 热门行
    hotMin: 12, extHotMin: 12, extHotSite: 'av_s31', hitsBatch: 20, hitsPerHour: 10, hitsPerTick: 2, hitsTop: 200,
    hitsFreshMs: 72 * HOUR, hitsRefreshMs: HOUR, trustEveryMs: 7 * DAY, trustMinN: 30, trustMinPairs: 10, trustOrderFrac: 0.95, trustGrowFrac: 0.5, trustGapMs: 2 * MIN,
    // 上报
    deadTokens: 3, deadWindowMs: DAY,
    // 薄分区回填(第二阶段)
    backfillEveryMs: 7 * DAY, backfillDelayMs: 6 * HOUR, backfillThin: 60, backfillPages: 10, backfillPerTick: 12,
    // 全量历史回填(第三阶段)
    historyGapMs: 2200, historyPagesPerRun: 100, historyIdleMs: 10 * MIN, historyBackoff: [MIN, 5 * MIN, 30 * MIN, 2 * HOUR], historyCheckpointEvery: 100,
    // 维护
    avdbCheckMs: 5 * MIN, optimizeEveryMs: DAY, avdbRetryMs: 5000,
    // 第四阶段:相关推荐(每行 ≤12、只靠标签时 Jaccard ≥0.15)/ 刷一刷(候选池 ≤3 万、按天分槽家族轮流、同家族连续 ≤2、一次最多扫 400 个候选、
    //   每条 ≤3 条线路、播放地址 14 天内、时长 8..300s(live/creators 8..180s))/ 短视频分类慢速补库(每 (站,分类) 每天 ≤10 页 —— 大分类按总页数提到 ≤40 页、每轮 ≤6 页)
    relatedRow: 12, relatedMinJac: 0.15,
    feedPoolMax: 30000, feedSlotMs: DAY, feedMaxRun: 2, feedScanMax: 400, feedLines: 3, feedPlayTtlMs: 14 * DAY, feedMinDur: 8, feedMaxDur: 300, feedMaxDurLive: 180,
    shortPagesPerDay: 10, shortPerTick: 6, shortDelayMs: 6 * HOUR,
    // 复核 CAT-4:刷一刷只出 feedPlayTtlMs(14 天)内拿到的播放地址 → 翻到底的 (站,分类) 从上一轮开扫起满 7 天(= TTL 的一半)就从第 1 页再扫一遍
    //   (还是每天 ≤10 页的额度),补库的旧短片不会 14 天后整批掉出刷一刷
    shortResweepMs: 7 * DAY,
    //   大分类(一轮 > 10 页/天 × 7 天):知道总页数后每天的额度 = ⌈总页数 / 7⌉,最多 shortPagesPerDayMax 页 —— 一轮在 7 天左右扫完,
    //   第 1 页等不到它的播放地址过期(否则候选池只是一个 ~140 页的滑动窗口);≤280 页的分类 7 天、≤560 页的 14 天内扫完一轮
    shortPagesPerDayMax: 40,
    // 封面域名健康(cover-health.js):首轮在启动 coverFirstDelayMs 后(ADULT_COVER_HEALTH_DELAY_MS 覆盖),之后每 coverEveryMs 全量查一次(死的也查:复活);
    //   一次 NXDOMAIN 的域名 coverConfirmMs 后单独复查(带 coverControls 个上一轮正常的域名当对照),两次至少隔 coverConfirmMinMs 才判死;
    //   DNS 查询并发 ≤ coverConc、一个查询总共 ≈ coverTimeoutMs;最多查 coverMaxHosts 个域名(封面多的在前),/api/config 最多报 coverMaxDead 个死域名;
    //   重挑封面每块 coverChunk 部作品;SERVFAIL 判死要全量轮里连续 ≥ coverSfMin 次、跨 ≥ coverSfMinMs;
    //   一轮出错 / 库没好(或者还从没跑完过一轮全量)→ coverRetryMs 后重试(不等 6 小时)
    coverFirstDelayMs: 10 * MIN, coverEveryMs: 6 * HOUR, coverConfirmMs: 15 * MIN, coverConfirmMinMs: 10 * MIN, coverControls: 6,
    coverConc: 8, coverTimeoutMs: 5000, coverMaxHosts: 500, coverMaxDead: 200, coverChunk: 500, coverSfMin: 3, coverSfMinMs: 24 * HOUR, coverRetryMs: 5 * MIN,
};
const BAD_QS = /m3u8|\.(?:jpe?g|png|gif|webp|bmp|avif|ts|mp4|key)(?:$|[?#&])/i;
const isP = (v) => !!v && typeof v.then === 'function';
const then = (v, fn) => (isP(v) ? v.then(fn) : fn(v));

function createCatalog(deps) {
    deps = deps || {};
    const A = deps.adult || require('../adult');   // 规则坏了这里就 throw(fail-closed)
    const T = A.title, P = A.policy, X = A.taxonomy;
    const TG = K.tagsOf(A, deps.tags);
    const RULES_VERSION = A.RULES_VERSION || P.RULES_VERSION;
    const NAV = new Set(X.NAV_BUCKETS);
    const env = deps.env || {};
    const C = Object.assign({}, DEF, deps.opts || {});
    C.firstDelayMs = K.envInt(env.CATALOG_FIRST_DELAY_MS, C.firstDelayMs, 0);
    // 封面域名健康:ADULT_COVER_HEALTH_DISABLE=1 → 不查 DNS、死域名表当空(写线程把封面按"全活"重挑回来);C 也带进写线程
    const COVER_ON = !CH.envOn(env.ADULT_COVER_HEALTH_DISABLE);
    C.coverHealth = COVER_ON;
    C.coverFirstDelayMs = K.envInt(env.ADULT_COVER_HEALTH_DELAY_MS, C.coverFirstDelayMs, 0);
    // SERVFAIL 也判死(默认开,ADULT_COVER_SERVFAIL_DEAD=0 关):A / AAAA 都 SERVFAIL、CD 位复核还是 SERVFAIL(不是 DNSSEC 签坏了)、
    //   全量轮里连续 ≥ coverSfMin 次、跨 ≥ coverSfMinMs、那几轮解析器明显正常(cover-health.js applyRound)。
    //   实测:fb.lj260522.top(av_s14 整站的封面,8.7 万条线路封面)域名还指着 Cloudflare、区已删 → 授权服务器 REFUSED、所有公共解析器 SERVFAIL,
    //   从来不是 NXDOMAIN;只认 NXDOMAIN 的话它永远不判死
    C.coverServfailDead = !K.envOff(env.ADULT_COVER_SERVFAIL_DEAD);
    const SFO = { sf: C.coverServfailDead };
    const MAX_SITES = K.envInt(env.CATALOG_MAX_SITES, 0, 1);
    const DISABLED = K.envFlag(env.CATALOG_DISABLE);
    const IMG_PROXY = K.envFlag(env.ADULT_IMG_PROXY);
    const BACKFILL = !K.envOff(env.CATALOG_BACKFILL);
    const SHORT_BF = !K.envOff(env.CATALOG_SHORT_BACKFILL);
    const EXT_HOT_KEY = String(env.CATALOG_EXT_HOT_SITE || C.extHotSite || '').trim();
    const MODE = deps.db ? 'inline' : deps.dbPath ? ((K.envOff(env.CATALOG_WORKERS) || deps.workers === false) ? 'own' : 'worker') : 'none';
    const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;
    // sleep 不能 unref:单独跑一轮(冒烟脚本)时进程会在两次请求的间隔里直接退出
    const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
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

    const stats = {
        requests: 0,
        expand: { runs: 0, cached: 0, coalesced: 0, requests: 0, errors: 0, found: 0 },
        searchDropped: 0, hits: { requests: 0, errors: 0 }, backfill: { runs: 0, requests: 0, items: 0 },
        history: { requests: 0, items: 0, errors: 0, sitesDone: 0, runs: 0 },
        short: { requests: 0, items: 0, errors: 0 },
    };

    // ---------- 后端:inline(主线程同步)/ worker(写线程 + 两个读线程) ----------
    let ready = false, rescanPending = false, ftsOk = false, rescanP = null;
    let purgeOnInit = false;   // inline:写端 init 报了没删完的追加词扫描 → ensureInline 末尾接着扫
    let coverOnInit = false;   // inline:写端 init 报了封面还没按死域名表挑完 → ensureInline 末尾接着挑
    let coverState = null, coverRunP = null, coverApplyP = null, coverTimer = null, coverLast = null, coverAbort = null, coverNext = null;   // 封面域名健康(主线程)
    let conn = null, writer = null, reader = null;          // inline
    let mdb = null, avdbMain = null;                          // 主线程只读连接 / 只读 AVDB(建在同一条只读连接上)
    let avdbErrAt = 0, avdbOff = false;                       // 上次建实例失败的时间 / 工厂明确返回 null(= 不用 AVDB)
    let wHost = null, rHosts = [], initP = null, closed = false, initFails = 0;
    let wStats = null, wCounts = null, avdbStat = null;
    const stmts = new Map();
    let stmtDb = null;
    const rd = (sql) => {
        if (mdb !== stmtDb) { stmts.clear(); stmtDb = mdb; }
        let s = stmts.get(sql);
        if (!s) { s = mdb.prepare(sql); stmts.set(sql, s); }
        return s;
    };
    function avdbModulePath() {
        if (typeof deps.avdbModule === 'string' && deps.avdbModule) return deps.avdbModule;
        if (typeof deps.avdbFactory !== 'function') return null;
        try { return require.resolve(path.join(__dirname, '..', 'adult-avdb')); } catch (_) { return null; }
    }
    // 主线程 AVDB 实例建在主线程自己的(worker 模式下 query_only)连接上:lib/adult-avdb 在只读连接上一个字都不写。
    //   建不起来(表还没建好 / 库坏了)→ 记下时间,avdbM() 每 avdbRetryMs 重试一次(不另开读写连接:主线程不碰写锁);
    //   在建好之前 avdbPol 对番号一律回 'block'(fail-closed,见 avdbPol)
    const AVDB_WANTED = typeof deps.avdbFactory === 'function' && MODE !== 'none';
    function makeAvdb(c) {
        if (typeof deps.avdbFactory !== 'function' || !c) return null;
        try {
            const a = deps.avdbFactory(c) || null;
            avdbOff = !a;
            avdbErrAt = 0;
            return a;
        } catch (e) {
            avdbErrAt = Date.now() || 1;
            warn('avdb', '主线程只读实例建不起来(稍后重试;在此之前番号一律当被拦):' + e.message);
            return null;
        }
    }
    function avdbM() {
        if (avdbMain || !AVDB_WANTED || avdbOff || !mdb) return avdbMain;
        if (avdbErrAt && Date.now() - avdbErrAt < C.avdbRetryMs) return null;
        avdbMain = makeAvdb(mdb);
        if (avdbMain) log('AVDB 主线程只读实例就绪');
        return avdbMain;
    }
    // 配了 AVDB 但主线程实例(还)没有:番号的政策不知道 → 当被拦
    const avdbFailClosed = () => AVDB_WANTED && !avdbOff && !avdbM();
    const avdbOn = () => !!avdbM() || avdbFailClosed();
    function ensureInline() {
        let c = null;
        if (MODE === 'own') {
            if (conn) return conn;
            try { fs.mkdirSync(path.dirname(path.resolve(deps.dbPath)), { recursive: true }); c = SCH.openDb(path.resolve(deps.dbPath), 'inline', env); } catch (e) { warn('open', e.message); return null; }
        } else {
            try { c = typeof deps.db === 'function' ? deps.db() : deps.db; } catch (_) { c = null; }
        }
        if (!c || typeof c.prepare !== 'function') { ready = false; return null; }
        if (c === conn && writer) return c;
        try {
            // inline / own:写端 init(loadExtraBlock)和建读端都会按库把(共用的)policy 词表整个换掉 —— 先记下主线程已有的,loadAdmin 并回来
            const keepBlock = curBlockWords();
            const w = createWriter({ db: c, adult: A, tags: deps.tags, C, rules: RULES_VERSION, log, avdb: () => avdbM() });
            const r = w.handle('init', {});
            conn = c; mdb = c; writer = w;
            rescanPending = r.rescanPending;
            purgeOnInit = !!r.purgePending;
            coverOnInit = !!r.coverPending;
            coverState = null;
            ftsOk = r.fts;
            avdbMain = makeAvdb(c);
            reader = createReader({ db: c, adult: A, tags: deps.tags, C, log });
            loadAdmin(c, keepBlock);
            cmaps.clear();
            snapJ = null;
            ready = true;
        } catch (e) { warn('init', e.message); ready = false; return null; }
        if (rescanPending) startRescan();
        if (purgeOnInit) { purgeOnInit = false; startPurge(); }
        if (coverOnInit) { coverOnInit = false; startCoverApply(); }
        return c;
    }
    function pickEnv(e) {
        const out = {};
        for (const k of Object.keys(e || {})) if (/^(AVDB_|CATALOG_|ADULT_)/.test(k) && typeof e[k] === 'string') out[k] = e[k];
        return out;
    }
    async function onRpc(op, args) {
        if (op !== 'http' || typeof deps.httpGet !== 'function') throw new Error('rpc refused');
        const url = String(args && args.url || '');
        if (!/^https?:\/\//i.test(url) || BAD_QS.test(url.split('#')[0])) throw new Error('refused url');
        const sk = args && typeof args.siteKey === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(args.siteKey) ? args.siteKey : 'avdb';
        let body = await deps.httpGet(url, { timeout: Math.min(30000, Number(args && args.timeout) || 15000), siteKey: sk });
        if (Buffer.isBuffer(body)) body = body.toString('utf8');
        if (typeof body === 'string') body = JSON.parse(body.replace(/^﻿/, '').trim());
        return body;
    }
    function initWorkers() {
        if (initP) return initP;
        const { createHost, linkPeers } = require('./host');
        initP = (async () => {
            const file = path.resolve(deps.dbPath);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const base = { dbPath: file, adultModule: deps.adultModule || path.join(__dirname, '..', 'adult'), tagsModule: deps.tagsModule || null, C, env: pickEnv(env), rules: RULES_VERSION };
            const avMod = avdbModulePath();
            const initWriter = async () => {
                const r = await wHost.call('init', {});
                rescanPending = r.rescanPending;
                ftsOk = r.fts;
                if (avMod) await wHost.call('avdbInit', {});
                if (avMod && started) await wHost.call('avdbStart', {});
                if (rescanPending) startRescan();
                if (r.purgePending) startPurge();   // 上次没删完的追加词扫描(写线程重启后也从断点续)
                if (r.coverPending) startCoverApply();   // 封面还没按死域名表(或新口径)挑完:写线程里分块接着挑
            };
            wHost = createHost({ name: '[catalog writer]', workerData: Object.assign({ role: 'writer', avdbModule: avMod }, base), log, onRpc, onRestart: () => { initWriter().catch((e) => warn('writer', e.message)); } });
            if (!(await wHost.ready())) throw new Error('writer thread failed to start');
            await initWriter();
            mdb = SCH.openDb(file, 'main', env);
            loadAdmin(mdb);
            avdbMain = makeAvdb(mdb);
            const relink = () => { if (rHosts.length === 2 && rHosts.every((h) => h.alive())) linkPeers(rHosts[0], rHosts[1]); snapJ = null; rebuild(); };
            rHosts = [0, 1].map((i) => createHost({ name: '[catalog reader ' + i + ']', workerData: Object.assign({ role: 'reader' }, base), log, onRestart: relink }));
            const ok = await Promise.all(rHosts.map((h) => h.ready()));
            if (!ok.every(Boolean)) throw new Error('reader threads failed to start');
            linkPeers(rHosts[0], rHosts[1]);
            ready = true;
            log(`目录线程就绪:写 1 + 读 2 · ${file}`);
            rebuild();
            return true;
        })().catch(async (e) => {
            warn('init', e.message);
            ready = false;
            // 启动失败(catalog.db 打不开 / 线程起不来):拆掉半成品,退避后重试。不重试的话 avdbFailClosed 会一直把所有番号当拦,
            //   搜索 / 历史 / 收藏里的番号片全部消失直到重启
            const hs = [wHost, ...rHosts].filter(Boolean);
            wHost = null; rHosts = [];
            await Promise.all(hs.map((h) => h.close().catch(() => {})));
            try { if (mdb) mdb.close(); } catch (_) { /* */ }
            mdb = null; avdbMain = null;
            if (!closed) {
                initFails++;
                const ms = Math.min(10 * 60 * 1000, 30 * 1000 * Math.pow(2, Math.min(initFails - 1, 5)));
                warn('init', '将在 ' + Math.round(ms / 1000) + 's 后重试(第 ' + initFails + ' 次失败)');
                const t = setTimeout(() => { initP = null; if (!closed) initWorkers(); }, ms);
                if (t.unref) t.unref();
            }
            return false;
        });
        return initP;
    }
    if (MODE === 'worker') initWorkers();
    // 写:inline 同步(异步的操作返回 Promise);worker 一律 Promise
    function W(op, args) {
        if (MODE === 'worker') return wHost ? wHost.call(op, args) : Promise.reject(new Error('catalog writer unavailable'));
        if (!ensureInline()) throw new Error('no db');
        return writer.handle(op, args);
    }
    // 读线程:挑在途最少的那个
    function R(op, args) {
        if (MODE !== 'worker') return reader.handle(op, args);
        const live = rHosts.filter((h) => h.alive());
        if (!live.length) return Promise.reject(new Error('catalog reader unavailable'));
        live.sort((a, b) => a.load() - b.load());
        return live[0].call(op, args);
    }
    const within = (p, ms) => Promise.race([p, new Promise((r) => { const h = setTimeout(r, ms); if (h.unref) h.unref(); })]);
    async function ensureReady() {
        if (MODE === 'worker') { await initWorkers(); return ready; }
        return !!ensureInline();
    }
    const getMeta = (k) => { try { const r = rd('SELECT v FROM adult_meta WHERE k=?').get(k); return r ? r.v : null; } catch (_) { return null; } };

    // ---------- 第四阶段:后台状态(主线程内存副本;真相在库里:adult_hidden / adult_meta 'admin:sites' / 'admin:block') ----------
    //   只会更严:隐藏作品、停用站点、追加屏蔽词。读不出来 = 保持现状(不放松)
    const hiddenSet = new Set();   // 后台隐藏的作品键(出口复查;SQL 读路径靠 ELIG 的 w.hid=0)
    let hiddenVer = 0;
    const siteOv = new Map();      // 站点停用覆盖:key → false(只能停用配置里启用着的站;"启用" = 删掉覆盖,配置里停用的站开不了)
    // 复核 CAT-2:启动时(worker 模式)目录线程起来之前,闸门已经把 adult-admin.json 的词表设进主线程 policy、syncExtraBlock / syncSiteOverrides
    //   已经发来 setExtraBlock / adminSite;initWorkers 里的 loadAdmin 不能再拿库里的旧值把它们整个盖掉。所以 loadAdmin:
    //   · 隐藏:只并进来(进程里先藏着的不丢);· 站点:这个进程里后台改过的站(siteTouched)以内存为准,其余按库;
    //   · 追加词:主线程词表 ∪ 库里的词(只会更严);库里的词记在 storedBlock,在一次成功的 setExtraBlock 存盘之前 extraBlock() 也把它们算进来
    //     (闸门 syncExtraBlock 读它求并集 —— 否则只读到 adult-admin.json 那份,库里独有的词会被下一次存盘冲掉)
    const siteTouched = new Set();
    let storedBlock = null;        // catalog.db 'admin:block'(loadAdmin 读到的);成功的 setExtraBlock 之后 = null(主线程 policy 就是准的)
    let blockGen = 0;
    const curBlockWords = () => { try { const x = typeof P.extraBlock === 'function' ? P.extraBlock() : null; return x && Array.isArray(x.words) ? x.words : []; } catch (_) { return []; } };
    // 主线程 policy 词表 ∪ extra:只会更严;坏词单独丢掉、最多 500 个(现有的在前),和闸门 syncExtraBlock 同口径
    function mergeBlock(extra) {
        if (typeof P.setExtraBlock !== 'function' || !Array.isArray(extra) || !extra.length) return;
        const cur = curBlockWords();
        const has = new Set(cur);
        const wordOk = (w) => { if (typeof w !== 'string' || has.has(w)) return false; try { return typeof P.extraWordOk === 'function' ? !!P.extraWordOk(w) : true; } catch (_) { return false; } };
        const add = extra.filter(wordOk);
        if (!add.length) return;
        const all = [...new Set(cur.concat(add))].slice(0, 500);
        if (all.length === cur.length) return;
        try { P.setExtraBlock(all); } catch (e) { warn('admin:block', e.message); }
    }
    function loadAdmin(c, keepBlock) {
        if (!c || typeof c.prepare !== 'function') return;
        try {
            const rows = c.prepare('SELECT wk FROM adult_hidden').all();
            for (const r of rows) hiddenSet.add(r.wk);
            hiddenVer++;
        } catch (_) { /* 表还没建:保持现状 */ }
        try {
            const r = c.prepare("SELECT v FROM adult_meta WHERE k='admin:sites'").get();
            const o = r && r.v ? JSON.parse(r.v) : null;
            if (o && typeof o === 'object') {
                for (const k of [...siteOv.keys()]) if (!siteTouched.has(k) && o[k] !== false) siteOv.delete(k);
                for (const k of Object.keys(o)) if (o[k] === false && !siteTouched.has(k)) siteOv.set(k, false);
            }
        } catch (e) { if (!/no such table/i.test(e.message)) warn('admin:sites', e.message); }
        mergeBlock(keepBlock);   // inline:写端 init / 建读端时按库换过一次词表 —— 之前主线程已有的(闸门设的)并回来
        try {
            const r = c.prepare("SELECT v FROM adult_meta WHERE k='admin:block'").get();
            const words = r && r.v != null ? JSON.parse(r.v) : null;
            if (Array.isArray(words)) { storedBlock = words.filter((w) => typeof w === 'string'); mergeBlock(storedBlock); }
        } catch (e) { if (!/no such table/i.test(e.message)) warn('admin:block', e.message); }
    }
    // 隐藏表从库里并进来(规则重扫 / 入库把隐藏作品的线路换了作品键时,写线程把新键也记进 adult_hidden —— 见 writer.js followHide)
    function syncHidden() {
        if (!mdb) return;
        try { for (const r of rd('SELECT wk FROM adult_hidden').all()) if (!hiddenSet.has(r.wk)) { hiddenSet.add(r.wk); hiddenVer++; } } catch (_) { /* 表还没建 */ }
    }
    // 启动时先同步读一眼(闸门的搜索在目录线程就绪之前就可能来:追加屏蔽词 / 停用站不能有空窗)
    if ((MODE === 'worker' || MODE === 'own') && deps.dbPath) {
        try {
            const f = path.resolve(deps.dbPath);
            if (fs.existsSync(f)) {
                const Database = require('better-sqlite3');
                const c0 = new Database(f, { readonly: true, fileMustExist: true });
                try { loadAdmin(c0); } finally { c0.close(); }
            }
        } catch (e) { warn('admin', e.message); }
    }
    const xKey = () => { try { const k = typeof P.rulesKey === 'function' ? P.rulesKey() : RULES_VERSION; return k !== RULES_VERSION ? k : ''; } catch (_) { return '?'; } };
    const nameExtraHit = (n) => { try { return typeof P.extraHit === 'function' && P.extraHit(String(n == null ? '' : n)); } catch (_) { return true; } };

    // ---------- 站点 ----------
    function extHotSite(act) {
        const m = act || activeSites();
        for (const s of m.values()) if (s.extHot) return s;
        return (EXT_HOT_KEY && m.get(EXT_HOT_KEY)) || null;
    }
    // 站点表(配置原样,不套后台停用)
    function cfgSites() {
        let list;
        try { list = typeof deps.getSites === 'function' ? deps.getSites() : []; } catch (e) { warn('sites', e.message); list = []; }
        const m = new Map();
        for (const s of Array.isArray(list) ? list : []) { const n = K.normSite(s); if (n && !m.has(n.key)) m.set(n.key, n); }
        return m;
    }
    // 站点表 + 后台停用(停用的站:不爬、不扩线、快照 / 作品页 / 刷一刷都不出它的线路)
    function allSites() {
        const m = cfgSites();
        if (siteOv.size) for (const [k, s] of m) if (siteOv.get(k) === false) { s.active = false; s.adminOff = true; }
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
        let body = await deps.httpGet(url, { timeout, siteKey });
        if (Buffer.isBuffer(body)) body = body.toString('utf8');
        if (typeof body === 'string') body = JSON.parse(body.replace(/^﻿/, '').trim());
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body');
        return body;
    }
    // 同域名串行 + 两次之间 ≥ gap(爬虫 2s;全量回填 2.2s)。
    //   回填碰过的域名记一个下限(hostFloor):之后这个域名上的增量爬虫请求也按 ≥2.2s 排(否则回填一页后紧跟的爬虫请求只隔 2.0s)
    const hostLast = new Map();
    const hostQ = new Map();
    const hostFloor = new Map();
    function gatedGet(site, url, gap) {
        guardUrl(site, url);
        const host = U.hostOf(url) || site.api;
        if (gap != null && gap > (hostFloor.get(host) || 0)) hostFloor.set(host, gap);
        const g = Math.max(gap == null ? C.hostGapMs : gap, hostFloor.get(host) || 0);
        const prev = hostQ.get(host) || Promise.resolve();
        const run = prev.then(async () => {
            const last = hostLast.get(host);
            if (last != null) { const wait = last + g - nowFn(); if (wait > 0) await sleep(wait); }
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

    // ---------- 分类表(主线程只读缓存;写在写线程) ----------
    const cmaps = new Map();
    function classMapFor(api) {
        if (!mdb) return null;
        const hit = cmaps.get(api);
        if (hit && hit.db === mdb) return hit;
        let rows = [];
        try { rows = rd('SELECT type_id, type_pid, type_name FROM adult_classes WHERE api=?').all(api); } catch (_) { rows = []; }
        if (!rows.length) return null;
        const byId = X.buildClassMap(rows, { host: api });
        const m = { db: mdb, byId };
        cmaps.set(api, m);
        return m;
    }
    function classState(api) { try { return rd('SELECT fetched_at, ok FROM adult_class_state WHERE api=?').get(api) || null; } catch (_) { return null; } }
    function needClass(api) {
        const r = classState(api);
        if (!r) return true;
        const age = nowFn() - (r.fetched_at || 0);
        return r.ok ? age >= C.classMs : age >= C.classRetryMs;
    }
    async function fetchClassMap(site) {
        const j = await gatedGet(site, urlFor(site, 'ac=list'));
        const rows = (Array.isArray(j.class) ? j.class : [])
            .map((c) => (c && typeof c === 'object' ? { id: Number(c.type_id), pid: Number(c.type_pid) || 0, name: U.clip(c.type_name == null ? '' : c.type_name, 60).trim() } : null))
            .filter((r) => r && Number.isFinite(r.id) && r.name);
        if (!rows.length) throw new Error('ac=list 没有 class');
        await W('classes', { api: site.api, rows, t: nowFn() });
        cmaps.delete(site.api);
        return rows.length;
    }
    const classInflight = new Map();
    async function ensureClassMap(site) {
        if (!(await ensureReady())) return null;
        const have = classMapFor(site.api);
        if (have) return have;
        const r = classState(site.api);
        if (r && !r.ok && nowFn() - r.fetched_at < C.classRetryMs) return null;
        let p = classInflight.get(site.api);
        if (!p) {
            p = fetchClassMap(site).catch(async (e) => { try { await W('classFail', { api: site.api, t: nowFn() }); } catch (_) { /* */ } warn('class ' + site.key, e.message); })
                .finally(() => classInflight.delete(site.api));
            classInflight.set(site.api, p);
        }
        await p;
        return classMapFor(site.api);
    }
    function classInfo(siteKey, typeId) {
        try {
            if (MODE !== 'worker') ensureInline();
            const s = allSites().get(String(siteKey));
            if (!s) return null;
            const m = classMapFor(s.api);
            if (!m) return null;
            const r = m.byId.get(Number(typeId));
            if (!r) return null;
            return { name: r.name, parentName: r.parentName, bucket: r.bucket, review: r.review, block: !!r.block };
        } catch (e) { warn('classInfo', e.message); return null; }
    }

    // ---------- 入库(写线程) ----------
    async function ingestList(site, list, src) {
        const hs = extHotSite();
        // 被藏作品的线路换了作品键(写线程 followHide 记了新键)→ 主线程隐藏表马上并进来,不等下一次重建快照
        return then(W('ingest', { site, list, src, t: nowFn(), withHits: !!(hs && hs.key === site.key) }), (r) => { if (r && r.hid) syncHidden(); return r; });
    }

    // ---------- 爬虫 ----------
    function loadState(site) {
        let st = null;
        try { st = rd('SELECT * FROM adult_crawl_state WHERE site=?').get(site.key); } catch (_) { st = null; }
        if (st && st.api === site.api) return Object.assign({}, st);
        return { site: site.key, api: site.api, last_ok: null, next_at: 0, mode: null, pagesize: null, fails: 0, last_new: null, last_err: null, cursor: null, ignores_h: 0, n_req: 0, n_items: 0 };
    }
    const saveState = (st) => W('state', { st });
    async function failSite(st, err) {
        st.fails = (st.fails || 0) + 1;
        st.last_err = U.clip(err, 200);
        st.cursor = null;
        st.next_at = nowFn() + C.failBackoff[Math.min(st.fails, C.failBackoff.length) - 1];
        await saveState(st);
        warn('crawl ' + st.site, err);
    }
    const take = (b) => { if (b.left <= 0) return false; b.left--; b.used++; return true; };
    const pausedNow = () => { try { return typeof deps.socketsBusy === 'function' && Number(deps.socketsBusy()) > C.socketsPause; } catch (_) { return false; } };
    const intervalOf = (mode) => (mode === 'continuous' ? C.continuousMs : mode === 'stale' ? C.staleMs : C.batchMs);
    function decideMode(site, st, t) {
        if (site.crawlMode) return site.crawlMode;
        if (!st.last_new) return 'stale';
        if (t - st.last_new > C.staleAfterMs) return 'stale';
        const n = rd('SELECT COUNT(DISTINCT vod_time / 3600000) n FROM adult_items WHERE site=? AND vod_time >= ?').get(site.key, t - DAY).n;
        return n >= C.continuousHours ? 'continuous' : 'batch';
    }
    async function crawlSite(site, budget) {
        const st = loadState(site);
        if (needClass(site.api)) {
            if (!take(budget)) return;
            st.n_req++;
            try { await fetchClassMap(site); }
            catch (e) { await W('classFail', { api: site.api, t: nowFn() }); warn('class ' + site.key, e.message); }
        }
        const cmap = classMapFor(site.api);
        if (!cmap) { await failSite(st, 'no class map'); return; }
        let cur = null;
        try { cur = st.cursor ? JSON.parse(st.cursor) : null; } catch (_) { cur = null; }
        if (!cur || cur.api !== site.api || !(cur.pg >= 1)) {
            const start = nowFn();
            const h = st.last_ok ? Math.min(C.maxHours, Math.max(1, Math.ceil((start - st.last_ok) / HOUR) + 1)) : C.maxHours;
            cur = { api: site.api, start, h, pg: 1, ps: st.pagesize || C.pageSize, n: 0 };
        }
        for (;;) {
            if (pausedNow()) { budget.paused = true; st.cursor = JSON.stringify(cur); await saveState(st); return; }
            if (!take(budget)) { st.cursor = JSON.stringify(cur); await saveState(st); return; }
            st.n_req++;
            let j;
            try { j = await gatedGet(site, urlFor(site, `ac=detail&h=${cur.h}&pagesize=${cur.ps}&pg=${cur.pg}`)); }
            catch (e) { await failSite(st, (e && e.message) || 'request failed'); return; }
            if (!j || !Array.isArray(j.list)) { await failSite(st, 'bad format'); return; }
            const list = j.list;
            if (!list.length) break;
            const r = await ingestList(site, list, 'crawl');
            cur.n += r.ok;
            st.n_items += r.ok;
            if (r.noclass) await W('classForce', { api: site.api, t: nowFn() });
            const pc = Number(j.pagecount);
            if (cur.pg === 1 && list.length < cur.ps && Number.isFinite(pc) && pc > 1) st.pagesize = list.length <= C.pageSizeCapped ? C.pageSizeCapped : list.length;
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
        st.mode = decideMode(site, st, t);
        st.next_at = Math.max(t + MIN, cur.start + intervalOf(st.mode));
        await saveState(st);
    }
    // ---------- 外站计数复取(ids= 每批 20,每小时 ≤10 个请求,走爬虫预算 + 同域名间隔) ----------
    async function hitsRefresh(budget) {
        if (budget.left <= 0 || budget.paused) return 0;
        const site = extHotSite();
        if (!site) return 0;
        if (!classMapFor(site.api)) return 0;
        let n = 0;
        while (n < C.hitsPerTick && budget.left > 0 && !budget.paused) {
            const t = nowFn();
            let times = [];
            try { times = JSON.parse(getMeta('exthot:req') || '[]'); } catch (_) { times = []; }
            times = (Array.isArray(times) ? times : []).filter((x) => typeof x === 'number' && x <= t && t - x < HOUR);
            if (times.length >= C.hitsPerHour) break;
            const ids = await W('hitsCand', { siteKey: site.key, t });
            if (!ids || !ids.length) break;
            if (!take(budget)) break;
            times.push(t);
            await W('meta', { k: 'exthot:req', v: JSON.stringify(times) });
            n++;
            stats.hits.requests++;
            let j;
            try { j = await gatedGet(site, urlFor(site, 'ac=detail&ids=' + ids.map((x) => encodeURIComponent(x)).join(','))); }
            catch (e) { stats.hits.errors++; warn('hits ' + site.key, e.message); break; }
            const want = new Set(ids.map(String));
            const list = (j && Array.isArray(j.list) ? j.list : []).filter((it) => it && typeof it === 'object' && want.has(String(it.vod_id)));
            if (list.length) await ingestList(site, list, 'crawl');
        }
        return n;
    }
    // ---------- 薄分区回填(每周;只拉叶子分类,绝不拉父分类) ----------
    async function backfillStep(budget) {
        if (budget.left <= 0 || budget.paused) return 0;
        const t = nowFn();
        let st = null;
        try { st = JSON.parse(getMeta('backfill') || 'null'); } catch (_) { st = null; }
        if (!st || typeof st !== 'object' || !Array.isArray(st.queue)) st = { startedAt: 0, thin: [], queue: [] };
        if (!st.queue.length) {
            const first = Number(getMeta('firstTick')) || t;
            if (t - first < C.backfillDelayMs || t - (Number(st.startedAt) || 0) < C.backfillEveryMs) return 0;
            st = await W('planThin', { t, sites: crawlSites().map((s) => ({ key: s.key, api: s.api, ps: loadState(s).pagesize || C.pageSize })) });
            await W('meta', { k: 'backfill', v: JSON.stringify(st) });
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
            if (!row || row.container || row.block) { st.queue.shift(); continue; }
            if (!take(budget)) break;
            n++;
            stats.backfill.requests++;
            let j = null;
            try { j = await gatedGet(site, urlFor(site, `ac=detail&t=${Number(job.t)}&pagesize=${Number(job.ps) || C.pageSize}&pg=${Number(job.pg) || 1}`)); }
            catch (e) { warn('backfill ' + site.key, e.message); j = null; }
            const list = j && Array.isArray(j.list) ? j.list : [];
            if (list.length) stats.backfill.items += (await ingestList(site, list, 'crawl')).ok;
            const pc = Number(j && j.pagecount);
            if (!j || !list.length || job.pg >= C.backfillPages || (Number.isFinite(pc) && pc > 0 && job.pg >= pc)) st.queue.shift();
            else job.pg++;
            await W('meta', { k: 'backfill', v: JSON.stringify(st) });
        }
        return n;
    }

    // ---------- 全量历史回填(第三阶段;每站一条游标,各域名并行、同域名一次一个且间隔 ≥2.2s) ----------
    //   ac=detail&pagesize=<站点认的>&pg=1..pagecount(新的在前)。续跑从上次那页的前一页开始(新上架会把旧条目往后挤,重一页 + 按 (站,vod_id) 去重)。
    //   失败退避 1m/5m/30m/2h;这一站这一轮最多 historyPagesPerRun 页,然后让给下一轮(进度存在 adult_backfill)。
    const bfResumed = new Set();
    function bfRow(site) {
        let r = null;
        try { r = rd('SELECT * FROM adult_backfill WHERE site=?').get(site.key); } catch (_) { r = null; }
        if (r && r.api === site.api) {
            r = Object.assign({}, r);
            if (!bfResumed.has(site.key)) { bfResumed.add(site.key); if (!r.done && r.pg > 1) r.pg = r.pg - 1; }
            return r;
        }
        bfResumed.add(site.key);
        return { site: site.key, api: site.api, pg: 1, pc: null, ps: null, done: 0, started_at: null, updated_at: null, next_at: 0, fails: 0, last_err: null, n_req: 0, n_items: 0 };
    }
    let histRunning = null;
    function historyStep(o) {
        if (!histRunning) histRunning = runHistory(o || {}).finally(() => { histRunning = null; });
        return histRunning;
    }
    async function runHistory(o) {
        const res = { requests: 0, items: 0, errors: 0, sitesDone: 0, active: 0, paused: false, pending: 0 };
        if (!(await ensureReady())) return Object.assign(res, { paused: true, notReady: true });   // 不是"全做完了"(规则重扫期间照常回填:新入库的就是新一代)
        const maxPages = Math.max(1, Number(o.maxPages) || C.historyPagesPerRun);
        const t0 = nowFn();
        const lanes = new Map();
        const sitesNow = crawlSites();
        // 同域名上还有站的第一轮增量没爬完(没失败过):这个域名先让给增量爬虫(共用同一条域名队列,回填会把首轮拖慢好几倍)
        const firstPending = new Set();
        for (const s of sitesNow) { const st = loadState(s); if (!st.last_ok && !(st.fails > 0)) firstPending.add(U.hostOf(s.api) || s.api); }
        for (const s of sitesNow) {
            if (!s.backfill) continue;
            const st = loadState(s);
            if (!st.last_ok) continue;              // 这个站的第一轮增量还没爬完
            const row = bfRow(s);
            if (row.done) continue;
            res.pending++;
            if (row.next_at > t0) continue;
            const h = U.hostOf(s.api) || s.api;
            if (firstPending.has(h)) { res.waitFirst = true; continue; }
            if (!lanes.has(h)) lanes.set(h, []);
            lanes.get(h).push({ site: s, row, ps: row.ps || st.pagesize || C.pageSize });
        }
        res.active = lanes.size;
        stats.history.runs++;
        await Promise.all([...lanes.values()].map(async (jobs) => {
            for (const job of jobs) {
                const { site, row } = job;
                let n = 0;
                while (n < maxPages && !closed) {
                    if (pausedNow()) { res.paused = true; return; }
                    const pg = Math.max(1, row.pg);
                    let j = null, err = null;
                    try { j = await gatedGet(site, urlFor(site, `ac=detail&pagesize=${job.ps}&pg=${pg}`), C.historyGapMs); }
                    catch (e) { err = (e && e.message) || 'request failed'; }
                    n++;
                    res.requests++;
                    stats.history.requests++;
                    row.n_req++;
                    if (!err && (!j || !Array.isArray(j.list))) err = 'bad format';
                    const t = nowFn();
                    if (err) {
                        row.fails = (row.fails || 0) + 1;
                        row.last_err = U.clip(err, 200);
                        row.next_at = t + C.historyBackoff[Math.min(row.fails, C.historyBackoff.length) - 1];
                        res.errors++;
                        stats.history.errors++;
                        await W('backfill', { row });
                        warn('history ' + site.key, err);
                        break;
                    }
                    const list = j.list;
                    if (!row.started_at) row.started_at = t;
                    const pc = Number(j.pagecount);
                    if (Number.isFinite(pc) && pc > 0) row.pc = pc;
                    if (!list.length || (row.pc && pg >= row.pc)) row.done = 1; else row.pg = pg + 1;
                    if (list.length) {
                        if (pg === 1 && list.length < job.ps && row.pc > 1) row.ps = job.ps = list.length <= C.pageSizeCapped ? C.pageSizeCapped : list.length;
                        const r = await ingestList(site, list, 'crawl');
                        row.n_items += r.ok;
                        res.items += r.ok;
                        stats.history.items += r.ok;
                    }
                    row.fails = 0;
                    row.last_err = null;
                    row.updated_at = nowFn();
                    await W('backfill', { row });
                    if (stats.history.requests % C.historyCheckpointEvery === 0) { try { await W('optimize', { checkpoint: 'passive' }); } catch (_) { /* */ } }
                    if (row.done) { res.sitesDone++; stats.history.sitesDone++; log(`全量回填完成:${site.key} · ${row.n_items} 条 / ${row.n_req} 页`); break; }
                }
            }
        }));
        return res;
    }
    // 有没有该回填的站(第一轮增量爬完了、回填没做完):重启后据此直接接着回填,不等哪一轮爬虫真发出请求
    function historyWanted() {
        if (!BACKFILL || DISABLED || !mdb) return false;
        try {
            const st = new Map(rd('SELECT site, api, last_ok FROM adult_crawl_state').all().map((r) => [r.site, r]));
            const bf = new Map(rd('SELECT site, api, done FROM adult_backfill').all().map((r) => [r.site, r]));
            for (const s of crawlSites()) {
                if (!s.backfill) continue;
                const c = st.get(s.key);
                if (!c || c.api !== s.api || !c.last_ok) continue;
                const b = bf.get(s.key);
                if (!b || b.api !== s.api || !b.done) return true;
            }
        } catch (e) { warn('history', e.message); }
        return false;
    }
    let histLoopOn = false;
    // 回填循环的空闲等待用真定时器(unref;注入的 sleep 只管同域名间隔 —— 测试里它是瞬间返回的,拿来空转会饿死事件循环)
    const idle = (ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h.unref) h.unref(); });
    function startHistory() {
        if (histLoopOn || !BACKFILL || DISABLED) return;
        histLoopOn = true;
        log('全量历史回填开始(CATALOG_BACKFILL=0 可关)');
        (async () => {
            while (started && !closed) {
                let r = null;
                try { r = await historyStep({}); } catch (e) { warn('history', e.message); }
                if (!started || closed) break;
                if (r && r.pending === 0 && !r.notReady) {
                    if (getMeta('bf:analyzed') == null) {
                        try { await W('optimize', { analyze: true, checkpoint: 'truncate' }); await W('meta', { k: 'bf:analyzed', v: nowFn() }); log('全量回填全部完成:ANALYZE + WAL 截断'); } catch (e) { warn('analyze', e.message); }
                    }
                    await idle(C.historyIdleMs * 6);
                } else if (!r || r.requests === 0) await idle(r && (r.paused || r.waitFirst) ? 30e3 : C.historyIdleMs);
                else await idle(10);
            }
            histLoopOn = false;
        })();
    }

    let tickP = null, lastTick = null, lastAvdbCheck = 0;
    function tick() {
        if (!tickP) tickP = runTick().finally(() => { tickP = null; });
        return tickP;
    }
    async function runTick() {
        if (!(await ensureReady())) return (lastTick = { at: nowFn(), skipped: 'nodb' });
        if (rescanPending) startRescan();   // 重扫在写线程里逐块跑;爬虫照常(不再整轮跳过)
        const t0 = nowFn();
        if (pausedNow()) return (lastTick = { at: t0, skipped: 'sockets' });
        if (!getMeta('firstTick')) await W('meta', { k: 'firstTick', v: t0 });
        const budget = { left: C.maxReqPerTick, used: 0, paused: false };
        const ing0 = await ingestedCount();
        const sites = crawlSites();
        let states = [];
        try { states = rd('SELECT site, api, next_at, cursor FROM adult_crawl_state').all(); } catch (_) { states = []; }
        const smap = new Map(states.map((r) => [r.site, r]));
        const rank = (s) => { const r = smap.get(s.key); if (!r || r.api !== s.api) return -2; if (r.cursor) return -1; return r.next_at || 0; };
        const due = sites.filter((s) => { const r = smap.get(s.key); return !r || r.api !== s.api || !!r.cursor || (r.next_at || 0) <= t0; });
        due.sort((a, b) => rank(a) - rank(b));
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
        // 爬虫自己就把这一轮的请求额度用完了(首轮 / 积压:还有站带着游标没爬完)→ 下一轮 tickBusyMs 后就来,不等满 tickMs
        //   (同域名间隔照旧;首轮 31 个站原来要等 3 轮 × 5 分钟)
        const crawlMore = !budget.paused && budget.left <= 0;
        let hitsN = 0, bfN = 0, shortN = 0;
        try { hitsN = await hitsRefresh(budget); } catch (e) { warn('hits', e.message); }
        try { bfN = await backfillStep(budget); } catch (e) { warn('backfill', e.message); }
        try { shortN = await shortStep(budget); } catch (e) { warn('short', e.message); }
        const ing1 = await ingestedCount();
        lastTick = { at: t0, ms: nowFn() - t0, due: due.length, requests: budget.used, ingested: ing1 - ing0, paused: budget.paused, hits: hitsN, backfill: bfN, short: shortN, more: crawlMore };
        // AVDB 有新数据 → 写线程复核签名变了的番号(异步,不等)
        if (t0 - lastAvdbCheck >= C.avdbCheckMs) { lastAvdbCheck = t0; avdbSync({}).catch((e) => warn('avdb', e.message)); }
        if (MODE === 'worker') { refreshWStats().catch(() => {}); }
        if (lastTick.ingested > 0 && (!snapJ || snapJ.empty || !snapJ.home.rows.length)) { try { await rebuild(); } catch (e) { warn('snapshot', e.message); } }
        if (started && BACKFILL && !histLoopOn && (lastTick.requests > 0 || historyWanted())) startHistory();
        return lastTick;
    }
    async function ingestedCount() {
        if (MODE !== 'worker') { try { return writer.handle('stats', {}).ingested; } catch (_) { return 0; } }
        try { const s = await W('stats', {}); wStats = s; return s.ingested; } catch (_) { return 0; }
    }
    function avdbSync(o) {
        return Promise.resolve().then(async () => {
            if (!(await ensureReady())) return { ran: false };
            return W('avdbCheck', { t: nowFn(), sites: [...allSites().values()], force: !!(o && o.force) });
        }).then((r) => { if (r && r.changed) rebuild(); return r; });
    }

    // ---------- 快照(首页 / 分区计数 / 标签云 / 片商 / 标签页 —— 主线程只拿 JSON;浏览在读线程) ----------
    let snapJ = null, buildP = null, buildNext = null, hotKey = null;
    const emptySnap = (t) => ({ at: t, sid: null, empty: true, home: { generatedAt: t, rows: [] }, buckets: X.NAV_BUCKETS.map((id) => ({ id, label: X.bucketLabel(id), nav: true, today: 0 })), pre: { tags: {}, studios: {}, tagInfo: {} }, N: 0 });
    const buildReq = (t) => ({ t, sites: [...activeSites().values()], imgProxy: IMG_PROXY, extHotKey: EXT_HOT_KEY });
    // 快照里每位演员(aid)可见作品数:worker 回 actorPairs [[aid,n]];inline 直接是 actors + actorN 两个对齐数组
    function actorMap(j) {
        try {
            if (j && Array.isArray(j.actorPairs)) return new Map(j.actorPairs.map((x) => [String(x[0]), Number(x[1]) || 0]));
            if (j && Array.isArray(j.actors) && Array.isArray(j.actorN)) return new Map(j.actors.map((a, i) => [String(a[0]), Number(j.actorN[i]) || 0]));
        } catch (_) { /* 没有就按 AVDB 的数 */ }
        return null;
    }
    function popularNames() {
        let titles = [];
        try { titles = typeof deps.popularTitles === 'function' ? deps.popularTitles() : []; } catch (e) { warn('popular', e.message); titles = []; }
        return Array.isArray(titles) ? titles.filter((x) => typeof x === 'string' && x).slice(0, 100) : [];
    }
    function rebuild() {
        const t = nowFn();
        // 规则重扫期间照常建快照:只含已按新规则重跑过的作品(SQL 里按代数过滤),重扫进行中定时重建(startRescan)
        if (MODE !== 'worker') {
            if (!ensureInline()) { snapJ = emptySnap(t); return snapJ; }
            syncHidden();
            try {
                const names = popularNames();
                const hk = names.join('\n');
                if (hk !== hotKey) { writer.handle('setHot', { names }); hotKey = hk; }
                const r = reader.handle('build', buildReq(t));
                snapJ = { at: t, sid: r.sid, empty: false, home: r.json.home, buckets: r.json.buckets, pre: r.json.pre, N: r.N, ms: r.json.ms, actorN: actorMap(r.json) };
                if (r.json.trust) writer.handle('meta', { k: 'exthot:trust', v: JSON.stringify(r.json.trust) });
            } catch (e) { warn('home', e.message); snapJ = emptySnap(t); }
            return snapJ;
        }
        // 正在建:建完再按最新的库建一次(入库之后要求重建时,不能拿到建在旧数据上的那一份)
        if (buildP) { if (!buildNext) buildNext = buildP.then(() => { buildNext = null; return rebuild(); }); return buildNext; }
        if (!ready) { snapJ = emptySnap(t); return Promise.resolve(snapJ); }
        syncHidden();
        buildP = (async () => {
            const names = popularNames();
            const hk = names.join('\n');
            if (hk !== hotKey) { await W('setHot', { names }); hotKey = hk; }
            const host = rHosts.find((h) => h.alive());
            if (!host) throw new Error('no reader');
            const r = await host.call('build', buildReq(t));
            snapJ = { at: t, sid: r.sid, empty: false, home: r.json.home, buckets: r.json.buckets, pre: r.json.pre, N: r.N, ms: r.json.ms, actorN: actorMap(r.json) };
            if (r.json.trust) await W('meta', { k: 'exthot:trust', v: JSON.stringify(r.json.trust) });
            return snapJ;
        })().catch((e) => { warn('snapshot', e.message); return snapJ || emptySnap(t); }).finally(() => { buildP = null; });
        return buildP;
    }
    const stale = (t) => !snapJ || snapJ.empty || t - snapJ.at >= C.homeMs || t < snapJ.at;
    // inline:同步拿到当前快照;worker:旧的先用、过期就后台重建,第一次还没有时等它(最多 firstSnapWaitMs)
    function withSnap(fn) {
        const t = nowFn();
        if (MODE !== 'worker') {
            if (!ensureInline()) return fn(emptySnap(t));
            if (stale(t)) rebuild();
            return fn(snapJ);
        }
        if (snapJ && !snapJ.empty) { if (stale(t) && !buildP) rebuild(); return fn(snapJ); }
        return (async () => {
            await within(initWorkers(), C.firstSnapWaitMs);
            if (ready && (!snapJ || snapJ.empty)) await within(buildP || rebuild(), C.firstSnapWaitMs);
            return fn(snapJ || emptySnap(nowFn()));
        })();
    }
    function home() {
        try { return withSnap((s) => homeOut(s)); } catch (e) { warn('home', e.message); return { generatedAt: nowFn(), rows: [] }; }
    }
    function buckets() {
        try { return withSnap((s) => s.buckets.map((b) => Object.assign({}, b))); } catch (e) { warn('buckets', e.message); return emptySnap(nowFn()).buckets; }
    }
    // 标签云:{groups:[{id,label}], tags:[{id,label,count,featured:true,group}]}(只 featured)
    function tags(b) {
        const bb = b == null ? '' : String(b).trim();
        if (bb && !NAV.has(bb)) return { groups: [], tags: [] };
        try {
            return withSnap((s) => {
                const r = s.pre.tags && s.pre.tags[bb];
                return r ? { groups: r.groups.map((g) => Object.assign({}, g)), tags: r.tags.map((x) => Object.assign({}, x)) } : { groups: [], tags: [] };
            });
        } catch (e) { warn('tags', e.message); return { groups: [], tags: [] }; }
    }
    function studios(b) {
        const bb = b == null ? '' : String(b).trim();
        if (bb && !NAV.has(bb)) return [];
        try { return withSnap((s) => ((s.pre.studios && s.pre.studios[bb]) || []).map((x) => Object.assign({}, x))); } catch (e) { warn('studios', e.message); return []; }
    }

    // ---------- 浏览 ----------
    const word = (v) => (typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : null);
    const idList = (v) => {
        if (v == null || v === '') return [];
        const arr = Array.isArray(v) ? v : String(v).split(',');
        const out = [];
        for (const x of arr) { const s = String(x).trim(); if (!s) continue; if (!word(s)) return null; if (out.indexOf(s) < 0) out.push(s); }
        return out.length > 3 ? null : out;
    };
    function normBrowse(params) {
        const o = params && typeof params === 'object' ? params : {};
        const s = (v) => (v == null ? '' : String(v).trim());
        const pg = parseInt(o.page, 10);
        const p = { b: s(o.b), t: idList(o.t), x: idList(o.x), dur: s(o.dur), v: s(o.v), studio: s(o.studio).slice(0, 80), actress: s(o.actress).slice(0, 40), lp: s(o.lp).toUpperCase(),
            multi: false, sort: s(o.sort), page: Number.isFinite(pg) && pg >= 1 ? Math.min(pg, C.maxPages) : 1, cursor: s(o.cursor).slice(0, 400), facets: o.facets === true || o.facets === 1 || s(o.facets) === '1',
            nr: o.nr === true || o.nr === 1 || s(o.nr) === '1' };   // nr:不要审查级作品(推荐位用;snapshot.js parseF)
        // b:一个分区,或逗号分隔 ≤6 个分区(取并集)
        const bParts = p.b ? p.b.split(',') : [];
        let bad = !p.t || !p.x || (p.b && (bParts.length > 6 || !bParts.every((x) => NAV.has(x)))) || (p.lp && !/^[A-Z0-9]{2,10}$/.test(p.lp));
        // 旧参数:tag=(旧 taxonomy id,经 LEGACY)、flag=zh|unc|multi、sort=random、dur=s|m|l(新的 6 档里 s/m/l 含义见 common.DUR_CLASSES)
        const tag = s(o.tag);
        if (tag && p.t) { if (!word(tag)) bad = true; else if (p.t.length < 3 && p.t.indexOf(tag) < 0) p.t.push(tag); }
        const flag = s(o.flag);
        if (flag === 'multi') p.multi = true;
        else if (K.LEGACY_FLAG[flag] && !p.v) p.v = K.LEGACY_FLAG[flag];
        if (K.LEGACY_SORT[p.sort]) p.sort = K.LEGACY_SORT[p.sort];
        if (!K.SORT_IDS.has(p.sort)) p.sort = 'new';
        // 给了但不认识的 dur / v → 空页(和未知标签 / 片商 / 演员一样;原来悄悄当"不筛"回全部)
        if (p.dur && !K.DUR_CLASSES.some((x) => x[0] === p.dur)) bad = true;
        if (p.v && !K.VARIANTS.some((x) => x[0] === p.v)) bad = true;
        if (p.actress && !/^[A-Za-z0-9_:.-]{1,40}$/.test(p.actress)) bad = true;
        p.bad = !!bad;
        return p;
    }
    const emptyPage = (p) => ({ page: p.page, total_pages: 0, total_results: 0, cursor_next: null, results: [] });
    function browse(params) {
        const p = normBrowse(params);
        const out = emptyPage(p);
        const fin = (r) => (r && Array.isArray(r.results) ? Object.assign({}, r, { results: exitList(r.results) }) : r);
        try {
            if (p.bad) return out;
            if (MODE !== 'worker') {
                const s = withSnap((x) => x);
                if (!conn || s.empty) return out;
                return fin(reader.handle('browse', p));
            }
            return withSnap((s) => (s.empty ? out : R('browse', p).then(fin).catch((e) => { warn('browse', e.message); return out; })));
        } catch (e) { warn('browse', e.message); return out; }
    }
    // 标签页:{tag:{id,label,group[,review]}, count, buckets, related(只 featured), items};blocked / 未知 → null(闸门回 404)
    function tagPage(id) {
        const rid = typeof id === 'string' && typeof TG.resolve === 'function' ? TG.resolve(id) : '';
        if (!rid) return null;
        const featured = !!TG.isFeatured(rid);
        const head = (s) => {
            const info = (s.pre.tagInfo && s.pre.tagInfo[rid]) || null;
            const tag = { id: rid, label: TG.label(rid), group: TG.group(rid) || '' };
            if (!featured) tag.review = true;
            return { tag, count: info ? info.count : 0, buckets: featured && info ? info.buckets.map((x) => Object.assign({}, x)) : [], related: featured && info ? info.related.map((x) => Object.assign({}, x)) : [] };
        };
        return then(withSnap(head), (h) => then(browse({ t: [rid], sort: 'new' }), (r) => Object.assign(h, { items: r.results })));
    }

    // ---------- 作品 / 线路(主线程点查) ----------
    const isKanjiOnly = (n) => /^[㐀-鿿豈-﫿々〆\s·・]+$/u.test(n);
    const ACTOR_JUNK = /^(?:未知|佚名|内详|內詳|暂无|暫無|无|無|不详|不詳|不明|未知演员|未知演員|未知女优|未知女優|素人|网红|網紅|主播|国产|國產|其他|其它|多人|群星|美女|女优|女優|演员|演員|自动采集|自動採集|自动|自動|采集|採集|待更新|更新中|未公开|未公開|匿名|无名|無名|网络|網路|n\/?a|none|null|unknown|various|anonymous|amateur|updating|voice cast)$/i;
    const TITLE_ACTRESS_BUCKETS = new Set(['jp_censored', 'jp_uncensored', 'jp_subbed', 'fetish', 'lgbt']);
    function epPath(pu) {
        const s = String(pu || '');
        const m = /(?:^|[#$])(https?:\/\/[^\s#$]+)/i.exec(s);
        if (!m) return '';
        let p;
        try { p = new URL(m[1]).pathname; } catch (_) { return ''; }
        const segs = p.split('/').filter(Boolean);
        return segs.length >= 2 && p.length >= 16 ? p : '';
    }
    // 演员:AVDB 主行(带 aid)在前,其次资源站 vod_actor / 片名里有把握的名字(aid 能对上 AVDB 演员就带上,否则 null);
    //   国产自拍 / 探花 / 主播 / 网红 分区一律不给;片名解析的名字只在日本片分区用;名字过查询硬拦词和审查级分类
    function actressOf(bucket, w, rows) {
        if (K.NO_ACTRESS_BUCKETS.has(bucket)) return [];
        const out = [];
        const ok = (v) => {
            if (!v || v.length < 2 || v.length > 40) return false;
            try { if (P.checkQuery(v)) return false; } catch (_) { return false; }
            try { if (X.classify(v).review) return false; } catch (_) { return false; }
            return true;
        };
        let al = null;
        try { al = w.actress ? JSON.parse(w.actress) : null; } catch (_) { al = null; }
        for (const p of Array.isArray(al) ? al : []) {
            if (!Array.isArray(p) || p[0] == null || typeof p[1] !== 'string') continue;
            const v = p[1].normalize('NFKC').replace(/\s+/g, ' ').trim();
            if (ok(v) && !out.some((x) => x.name.toLowerCase() === v.toLowerCase())) out.push({ aid: p[0], name: v });
        }
        const add = (n) => {
            const v = String(n || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
            if (!v || v.length > 24 || ACTOR_JUNK.test(v) || /[0-9#@!！?？【】\[\]()（）<>《》:：|/\\]/.test(v)) return;
            if (!/^[぀-ヿ㐀-鿿ー・々A-Za-z .'-]+$/u.test(v) || !ok(v)) return;
            if (out.some((x) => x.name.toLowerCase() === v.toLowerCase())) return;
            // 资源站 / 片名给的名字不去 AVDB 模糊搜(那是全表 LIKE,不能在主线程上跑):对不上作品自带的 AVDB 演员就 aid=null
            out.push({ aid: null, name: v });
        };
        for (const r of rows) {
            if (out.length >= 6) break;
            for (const a of String(r.actor || '').split(/[,，、/|;；]+/)) add(a);
            let parsed = null;
            try { parsed = T.parseTitle(r.name, r.type_name || ''); } catch (_) { parsed = null; }
            if (TITLE_ACTRESS_BUCKETS.has(bucket)) for (const a of (parsed && Array.isArray(parsed.actress) ? parsed.actress : [])) if (!isKanjiOnly(String(a))) add(a);
        }
        return out.slice(0, 6);
    }
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
    function tagObjs(tagsStr) {
        const ids = String(tagsStr || '').split(',').filter(Boolean);
        const obj = (id) => ({ id, label: TG.label(id), group: TG.group(id) || '', featured: !!TG.isFeatured(id) });
        const ok = ids.filter((id) => TG.label(id) && (TG.isFeatured(id) || TG.isReview(id)));
        return ok.filter((id) => TG.isFeatured(id)).map(obj).concat(ok.filter((id) => !TG.isFeatured(id)).map(obj));
    }
    function readGroup(wk) {
        const w = rd(`SELECT ${K.WCOLS}, w.ckey, w.clean, w.tags, w.variants, w.maker, w.label, w.avdb, w.actress, w.studio FROM adult_works w WHERE w.wk=? AND ${ELIG}`).get(wk);
        if (!w) return null;
        if (w.ckey && avdbPol(w.ckey) === 'block') return null;   // AVDB 拦截的番号:写线程复核前也不出
        const act = activeSites();
        const items = rd(`SELECT i.id, i.site, i.vod_id, i.name, i.pic, i.play_from, i.play_url, i.play_at, i.type_name, i.variant, i.dur, i.flags, i.last_seen,
                                   i.dead, i.res, i.ckey FROM adult_items i WHERE i.wk=? AND ${ELIG_I}`).all(wk)
            .filter((it) => !(it.ckey && it.ckey !== w.ckey && avdbPol(it.ckey) === 'block'));   // 线路自己的番号被 AVDB 拦了(复核前)也不出
        const better = (a, b) => (!!a.dead !== !!b.dead ? !a.dead
            : (a.flags & K.F_ZH) !== (b.flags & K.F_ZH) ? (a.flags & K.F_ZH) > (b.flags & K.F_ZH) : a.last_seen > b.last_seen);
        const best = new Map();
        for (const it of items) {
            if (!act.has(it.site)) continue;
            const b = best.get(it.site);
            if (!b || better(it, b)) best.set(it.site, it);
        }
        const t = nowFn();
        const picked = [...best.values()].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
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
        const parent = new Map(picked.map((it) => [it.site, it.site]));
        const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
        for (const members of groups.values()) for (let i = 1; i < members.length; i++) { const a = find(members[0]), b = find(members[i]); if (a !== b) parent.set(b, a); }
        const comps = new Map();
        for (const it of picked) { const r = find(it.site); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(it.site); }
        const sameOf = new Map();
        for (const members of comps.values()) {
            if (members.length < 2 || new Set(members.map((k) => famKey(act.get(k)))).size < 2) continue;
            const id = 'g' + U.hash31(members.slice().sort().join('|') + '|' + wk).toString(36);
            for (const k of members) sameOf.set(k, id);
        }
        const sources = orderSources(picked.map((it) => {
            const s = act.get(it.site);
            const src = {
                site_key: s.key, site_name: s.name + (it.variant ? ' · ' + it.variant : ''), vod_id: it.vod_id, vod_name: it.name,
                vod_pic: !it.pic ? '' : IMG_PROXY ? K.imgUrl(wk, s.key) : it.pic,
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
            siblings = rd(`SELECT w.wk, w.name, w.sites FROM adult_works w WHERE w.ckey=? AND w.wk<>? AND substr(w.wk, 1, 2)='c:' AND w.n_sites > 0 AND ${ELIG} ORDER BY w.is_clip, w.n_sites DESC LIMIT 10`).all(w.ckey, wk)
                .filter((r) => K.liveCount(r.sites, act) > 0)
                .map((r) => ({ wk: r.wk, name: r.name, kind: K.kindOfWk(r.wk) }));
        }
        // 作品页演员:要资源站的 vod_actor(在压缩的原始字段里)
        const rawRows = [];
        for (const it of items.filter((x) => act.has(x.site)).slice(0, 12)) {
            let actor = '';
            try { const r = rd('SELECT raw FROM adult_items_raw WHERE id=?').get(it.id); if (r) actor = String(JSON.parse(zlib.inflateRawSync(r.raw).toString('utf8')).a || ''); } catch (_) { actor = ''; }
            rawRows.push({ name: it.name, type_name: it.type_name, actor });
        }
        const picSite = String(w.pic_item || '').split('|')[0];
        // AVDB 封面在死域名上(cov=0)→ 不给;作品页照常打开
        const pic = w.pic ? (IMG_PROXY ? K.imgUrl(wk, picSite) : w.pic) : (w.apic && w.cov !== 0) ? (IMG_PROXY ? K.imgUrl(wk, '') : w.apic) : '';
        // 作品封面空着(线路封面全在死域名上)→ 退回第一条封面不在死域名上的线路封面
        let fallbackPic = '';
        if (!pic) {
            const dead = coverDeadSet();
            const s0 = sources.find((x) => x.vod_pic && !(dead.size && dead.has(CH.hostOf(x.vod_pic))));
            fallbackPic = s0 ? s0.vod_pic : '';
        }
        return {
            name: w.name,
            pic: pic || fallbackPic,
            _wk: wk,
            _meta: {
                code: w.code || '', dur: w.dur || 0, bucket: w.bucket, bucket_label: X.bucketLabel(w.bucket) || '',
                tags: tagObjs(w.tags), n_sites: sources.length,
                label_prefix: isCode && w.ckey && !/^UNC-/.test(w.ckey) ? String(w.ckey).split('-')[0] : '',
                actress: actressOf(w.bucket, w, rawRows),
                variants: w.variants ? w.variants.split(',').filter(Boolean) : [], siblings,
                first_seen: w.first_seen,
                released: w.released || '', maker: w.maker || '', label: w.label || '', studio: w.studio || '', avdb: !!w.avdb,
            },
            sources,
        };
    }
    // 扩线:现搜别的站补线路(番号作品搜 [带横线, 不带横线],绝不搜光厂牌;无番号作品搜精确净标题),搜到的合格条目写回索引
    const expanding = new Map();
    async function doExpand(wk) {
        const w = rd(`SELECT w.wk, w.code, w.ckey, w.clean, w.name FROM adult_works w WHERE w.wk=? AND ${ELIG}`).get(wk);
        if (!w) return;
        const isCode = wk.indexOf('c:') === 0;
        let variants = [], relevant;
        if (isCode) {
            const key = w.ckey;
            const sv = T.searchVariants(w.code || key || '');
            if (key && sv.kind === 'code') variants = sv.variants.slice(0, 2);
            relevant = (it) => { try { return T.parseTitle(it.vod_name, it.type_name).key === key; } catch (_) { return false; } };
        } else {
            const tk = wk.slice(2).replace(/~d?\d+$/, '');
            const qv = String(w.clean || '').trim().slice(0, 80);
            if (tk && qv && [...tk].length >= 4) variants = [qv];
            relevant = (it) => { try { return T.parseTitle(it.vod_name, it.type_name).titleKey === tk; } catch (_) { return false; } };
        }
        if (!variants.length) return;
        const t0 = nowFn();
        const have = new Set(rd('SELECT DISTINCT site FROM adult_items WHERE wk=?').all(wk).map((r) => r.site));
        const cache = new Map(rd('SELECT site, found, at FROM adult_expand WHERE wk=?').all(wk).map((r) => [r.site, r]));
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
                    if (rel.length) {
                        const r = await W('ingest', { site: s, list: rel, src: 'search', t: nowFn(), withHits: false });
                        if (r && r.hid) syncHidden();
                        found += r.wks.filter((x) => x === wk).length;
                    }
                    if (found) break;
                }
                if (answered) await W('expandMark', { wk, site: s.key, found: !!found, t: nowFn() });
                stats.expand.found += found;
            } finally { local.release(); }
        }));
    }
    async function work(wk, opts) {
        try {
            if (typeof wk !== 'string' || !wk || wk.length > 300) return null;
            if (hiddenSet.has(wk)) return null;   // 后台隐藏(ELIG 的 hid=0 也挡;这里不用等库)
            const o = opts && typeof opts === 'object' ? opts : {};
            if (!(await ensureReady())) return null;   // 规则重扫期间:还没按新规则重跑的作品 readGroup 自己读不到(代数过滤)
            if (o.expand) {
                let p = expanding.get(wk);
                if (p) stats.expand.coalesced++;
                else {
                    p = doExpand(wk).catch((e) => warn('expand', e.message)).finally(() => { if (expanding.get(wk) === p) expanding.delete(wk); });
                    expanding.set(wk, p);
                }
                await p;
            }
            if (!ready || hiddenSet.has(wk)) return null;
            const g = readGroup(wk);
            // 作品名命中站长追加屏蔽词(写线程按新规则重扫删掉之前)→ 不出
            return g && xKey() && nameExtraHit(g.name) ? null : g;
        } catch (e) { warn('work', e.message); return null; }
    }

    // ---------- AVDB(主线程只读实例) ----------
    //   缓存按 AVDB 的政策版本戳(写线程入库了带等级的行 / 规则重算就变;读一次是一条主键点查)作废:
    //   新到的拦截立刻在搜索出口 / 作品页 / 联想 / 卡片复查里生效(不等写线程复核、不等 10 分钟缓存过期)。
    //   实例没有 polVersion(替身 / 旧模块)→ 不缓存
    const polCache = new Map();
    let polVer = null, polHold = false;      // polHold:一次列表复查(同步)里只读一次政策戳
    function polCacheSync() {
        if (polHold) return;
        let v = null;
        try { v = avdbMain && typeof avdbMain.polVersion === 'function' ? String(avdbMain.polVersion()) : null; } catch (_) { v = null; }
        if (v === null || v !== polVer) { polCache.clear(); polVer = v; }
    }
    function avdbPol(key) {
        if (typeof key !== 'string' || !key || key.length > 80) return null;
        if (MODE !== 'worker') ensureInline();
        const am = avdbM();
        if (!am || typeof am.lookup !== 'function') return avdbFailClosed() ? 'block' : null;   // 配了 AVDB 却查不了 = 当被拦
        const now = Date.now();
        polCacheSync();
        const hit = polCache.get(key);
        if (hit && now - hit.at < 10 * MIN) return hit.v;
        let v = null;
        try {
            if (typeof am.pol === 'function') { const x = am.pol(key); v = typeof x === 'string' && x ? x : null; }
            else { const a = am.lookup(key); v = a && typeof a.pol === 'string' ? a.pol : null; }
        } catch (e) { warn('avdbPol', e.message); return 'block'; }   // 查出错 = 当被拦(不缓存,下次再查)
        if (polCache.size >= 5000) polCache.clear();
        polCache.set(key, { v, at: now });
        return v;
    }
    // 快照列表的出口复查(首页各行 / 浏览 / 标签页 / 演员页 / 查找 / 联想):写线程复核 + 重建快照之前,
    //   AVDB 新拦的番号(作品自己的、或它任一线路的)不出现在任何列表里;查不了 = 当被拦(fail-closed)
    function blockedWk(wk) {
        if (typeof wk !== 'string' || !wk || !mdb) return false;
        try {
            const w = rd('SELECT ckey FROM adult_works WHERE wk=?').get(wk);
            // review_hide 也一样:作品页(gate.checkRaw)已经 404,列表里不能还挂着标题
            const hid = (k) => { const v = avdbPol(k); return v === 'block' || v === 'review_hide'; };
            if (w && w.ckey && hid(w.ckey)) return true;
            for (const r of rd('SELECT DISTINCT ckey FROM adult_items WHERE wk=? AND ckey IS NOT NULL LIMIT 16').all(wk)) if (hid(r.ckey)) return true;
            return false;
        } catch (e) { warn('blockedWk', e.message); return true; }
    }
    function dropBlocked(list) {
        if (!Array.isArray(list) || !list.length || !avdbOn()) return list;
        if (polHold) return list.filter((c) => !(c && blockedWk(c.wk)));
        polCacheSync();
        polHold = true;
        try { return list.filter((c) => !(c && blockedWk(c.wk))); } finally { polHold = false; }
    }
    // 第四阶段:所有列表的出口(首页各行 / 浏览 / 标签页 / 演员页 / 查找 / 联想 / 相关 / 刷一刷):
    //   后台隐藏的作品、片名命中站长追加屏蔽词的(重扫按新规则删掉之前)、AVDB 拦的 —— 都不出
    const exitOk = (c) => !!c && typeof c.wk === 'string' && !hiddenSet.has(c.wk);
    function exitList(list) {
        if (!Array.isArray(list) || !list.length) return list;
        let out = list;
        if (hiddenSet.size) out = out.filter(exitOk);
        if (xKey()) out = out.filter((c) => !!c && !nameExtraHit(c.name));
        return dropBlocked(out);
    }
    let homeMemo = null;
    function homeOut(s) {
        if (!s || s.empty || !s.home || !Array.isArray(s.home.rows)) return s && s.home;
        const av = avdbOn(), xk = xKey(), hv = hiddenSet.size ? hiddenVer : 0;
        if (!av && !xk && !hv) return s.home;
        if (av) polCacheSync();
        if (homeMemo && homeMemo.snap === s && homeMemo.hv === hv && homeMemo.xk === xk && (av ? polVer !== null && homeMemo.ver === polVer : homeMemo.ver === null)) return homeMemo.out;
        const ver = av ? polVer : null;
        polHold = true;
        let out;
        try { out = Object.assign({}, s.home, { rows: s.home.rows.map((r) => (r && Array.isArray(r.items) ? Object.assign({}, r, { items: exitList(r.items) }) : r)) }); } finally { polHold = false; }
        homeMemo = { snap: s, ver, hv, xk, out };
        return out;
    }
    // 演员页:{actress:{aid,name,aliases}, page, total_pages, results}(按发行日期);没有 / 名字被拦 → null
    function actress(aid, opts) {
        const id = aid == null ? '' : String(aid).trim();
        if (!/^[A-Za-z0-9_:.-]{1,40}$/.test(id)) return null;
        if (MODE !== 'worker') ensureInline();
        const am = avdbM();
        if (!am || typeof am.actress !== 'function') return null;
        let info = null;
        try { info = am.actress(/^\d+$/.test(id) ? Number(id) : id); } catch (_) { info = null; }
        if (!info || typeof info.name !== 'string' || !info.name) return null;
        try { if (P.checkQuery(info.name)) return null; } catch (_) { return null; }
        const pg = Math.max(1, Math.min(C.maxPages, parseInt(opts && opts.page, 10) || 1));
        const head = { aid: info.aid != null ? info.aid : aid, name: info.name, aliases: (Array.isArray(info.aliases) ? info.aliases : []).filter((x) => typeof x === 'string' && x && !P.checkQuery(x)).slice(0, 20) };
        // 目录里她一部可见作品都没有(含全被 AVDB 拦掉)→ 没有这一页(不能拿 aid 枚举 AVDB 的名字)
        return then(browse({ actress: String(head.aid), sort: 'released', page: pg }), (r) => (!r || !(r.total_results > 0) || (pg === 1 && !(Array.isArray(r.results) && r.results.length))
            ? null : { actress: head, page: r.page, total_pages: r.total_pages, results: r.results }));
    }
    function actressSearch(qs) {
        const s = String(qs == null ? '' : qs).normalize('NFKC').trim().slice(0, 60);
        if (!s) return [];
        try { if (P.checkQuery(s)) return []; } catch (_) { return []; }
        // n = 目录快照里她的可见作品数(没快照时退回 AVDB 署名数):目录里一部都没有的不出(点进去是空页),同名精确匹配在前、再按部数
        const clean = (r) => {
            let list = (Array.isArray(r) ? r : []).filter((x) => x && x.aid != null && typeof x.name === 'string' && x.name && !P.checkQuery(x.name))
                .slice(0, 10).map((x) => ({ aid: x.aid, name: x.name, n: Number(x.n) || 0 }));
            const am = snapJ && !snapJ.empty && snapJ.actorN instanceof Map ? snapJ.actorN : null;
            if (am) {
                const nk = (v) => String(v).toLowerCase().replace(/\s+/g, '');
                const qk = nk(s);
                list = list.map((x) => ({ aid: x.aid, name: x.name, n: am.get(String(x.aid)) || 0, ex: nk(x.name) === qk ? 1 : 0 }))
                    .filter((x) => x.n > 0).sort((a, b) => (b.ex - a.ex) || (b.n - a.n)).map((x) => ({ aid: x.aid, name: x.name, n: x.n }));
            }
            return list;
        };
        // AVDB 的演员搜索有 LIKE 扫描:worker 模式交给写线程里的 AVDB 实例跑,主线程不扫
        if (MODE === 'worker') return ready && avdbModulePath() ? W('avdbSearch', { q: s }).then(clean, () => []) : [];
        ensureInline();
        const am = avdbM();
        if (!am || typeof am.searchActress !== 'function') return [];
        let r = [];
        try { r = am.searchActress(s) || []; } catch (_) { r = []; }
        return clean(r);
    }
    // 闸门的搜索出口:哪些 (站, vod_id) 已经在索引里(封面代理改写用)
    function indexedWks(siteKey, vodIds) {
        const out = new Map();
        try {
            if (MODE !== 'worker') ensureInline();
            if (!mdb || typeof siteKey !== 'string') return out;
            for (const v of (Array.isArray(vodIds) ? vodIds : []).slice(0, 200)) {
                const id = String(v == null ? '' : v);
                if (!id || id.length > 64) continue;
                const r = rd(`SELECT i.wk FROM adult_items i WHERE i.site=? AND i.vod_id=? AND ${ELIG_I}`).get(siteKey, id);
                if (r) out.set(id, r.wk);
            }
        } catch (e) { warn('indexed', e.message); }
        return out;
    }

    // ---------- 本地查找 / 联想(读线程;AVDB 拦截的番号直接空) ----------
    function codeBlocked(s) {
        const sv = T.searchVariants(s);
        return sv && sv.kind === 'code' && sv.key && avdbPol(sv.key) === 'block';
    }
    function lookup(query, opts) {
        try {
            const o = opts && typeof opts === 'object' ? opts : {};
            const s = String(query == null ? '' : query).normalize('NFKC').trim().slice(0, 100);
            if (!s || P.checkQuery(s)) return [];
            if (MODE !== 'worker') { if (!ensureInline()) return []; withSnap((x) => x); }
            if (codeBlocked(s)) return [];
            const args = { q: s, limit: o.limit, t: nowFn() };
            if (MODE !== 'worker') return exitList(reader.handle('lookup', args));
            return withSnap(() => R('lookup', args).then(exitList).catch(() => []));
        } catch (e) { warn('lookup', e.message); return []; }
    }
    function suggest(query) {
        const base = { kind: 'empty', alias: null, exact: null, items: [] };
        try {
            const s = String(query == null ? '' : query).normalize('NFKC').replace(/[​-‏﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
            if (!s) return base;
            let blocked = true;
            try { blocked = !!P.checkQuery(s); } catch (_) { blocked = true; }
            if (blocked || codeBlocked(s)) return Object.assign(base, { kind: 'blocked' });
            const args = { q: s, t: nowFn() };
            const noDb = () => Object.assign(base, { kind: T.searchVariants(s).kind === 'code' ? 'code' : 'text' });
            const fin = (r) => {
                if (r) {
                    r.items = exitList(r.items);
                    // 直接开的那一部:隐藏 / 片名命中追加屏蔽词(出口里被滤掉了)/ AVDB 拦 → 不直接开
                    if (r.exact && (hiddenSet.has(r.exact) || (xKey() && !(r.items || []).some((c) => c && c.wk === r.exact)) || (avdbOn() && blockedWk(r.exact)))) r.exact = null;
                }
                return r;
            };
            if (MODE !== 'worker') {
                if (!ensureInline()) return noDb();
                withSnap((x) => x);
                return fin(reader.handle('suggest', args));
            }
            if (!ready) return noDb();
            return withSnap(() => R('suggest', args).then(fin).catch(() => noDb()));
        } catch (e) { warn('suggest', e.message); return Object.assign(base, { kind: 'text' }); }
    }

    // ---------- 第四阶段:相关推荐 / 刷一刷(读线程算;主线程只做出口复查) ----------
    // related(wk, {limit=24}) → null(作品不存在 / 不可见 / 隐藏 / AVDB 拦)| {items:Card[], actress:{aid,name,items:Card[]}|null, studio:{id,label,items:Card[]}|null}
    //   打分见 relfeed.js;演员 / 片商名字过查询硬拦词(含追加屏蔽词),被拦 → 那一行 null;每行出口复查后空了 → null
    function related(wk, opts) {
        try {
            if (typeof wk !== 'string' || !/^[ct]:./.test(wk) || wk.length > 300 || hiddenSet.has(wk)) return MODE === 'worker' ? Promise.resolve(null) : null;
            const o = opts && typeof opts === 'object' ? opts : {};
            const args = { wk, limit: o.limit, t: nowFn() };
            const nameBad = (n) => { if (typeof n !== 'string' || !n) return true; try { return !!P.checkQuery(n); } catch (_) { return true; } };
            const row = (x, nm) => {
                if (!x || nameBad(nm)) return null;
                const items = exitList(Array.isArray(x.items) ? x.items : []);
                return items && items.length ? Object.assign({}, x, { items }) : null;
            };
            // 种子作品名命中站长追加屏蔽词 → 与 work()/heat() 一致回 null(写线程清理之前也不出)。查不到名字 / 出错 → 当命中(fail-closed)
            const seedBad = () => {
                if (!xKey()) return false;
                if (wk.charAt(0) === 't' && nameExtraHit(wk.slice(2))) return true;
                try { if (!mdb) return true; const w = rd('SELECT name FROM adult_works WHERE wk=?').get(wk); return !w || nameExtraHit(w.name); } catch (_) { return true; }
            };
            const fin = (r) => {
                if (!r || hiddenSet.has(wk)) return null;
                if (avdbOn() && blockedWk(wk)) return null;
                if (seedBad()) return null;
                return { items: exitList(Array.isArray(r.items) ? r.items : []) || [], actress: row(r.actress, r.actress && r.actress.name), studio: row(r.studio, r.studio && r.studio.label) };
            };
            if (MODE !== 'worker') {
                if (!ensureInline()) return null;
                withSnap((x) => x);
                return fin(reader.handle('related', args));
            }
            if (!ready) return Promise.resolve(null);
            return withSnap(() => R('related', args).then(fin).catch((e) => { warn('related', e.message); return null; }));
        } catch (e) { warn('related', e.message); return MODE === 'worker' ? Promise.resolve(null) : null; }
    }
    // feed({cursor, vert, limit=10}) → {items: FeedItem[], cursor_next}
    //   FeedItem = Card + {orient:'v'|'h'|'sq'|'', dur, lines:[{site, vod_id, vod_name, type_name, url(第一集 m3u8), dur, orient}]};
    //   出口:隐藏 / 追加屏蔽词 / AVDB 拦的作品去掉,线路只留现在还启用着的站(后台停用马上生效)
    function feed(opts) {
        const out = { items: [], cursor_next: null };
        try {
            const o = opts && typeof opts === 'object' ? opts : {};
            const vert = o.vert === true || o.vert === 1 || o.vert === '1' || o.vert === 'true';
            const args = { cursor: typeof o.cursor === 'string' ? o.cursor.slice(0, 400) : '', vert, limit: o.limit, t: nowFn() };
            const fin = (r) => {
                if (!r || !Array.isArray(r.items)) return out;
                const act = activeSites();
                const items = (exitList(r.items) || []).map((it) => Object.assign({}, it, { lines: (Array.isArray(it.lines) ? it.lines : []).filter((l) => l && act.has(l.site)) })).filter((it) => it.lines.length);
                return { items, cursor_next: r.cursor_next || null };
            };
            if (MODE !== 'worker') {
                if (!ensureInline()) return out;
                const s = withSnap((x) => x);
                if (!s || s.empty) return out;
                return fin(reader.handle('feed', args));
            }
            if (!ready) return Promise.resolve(out);
            return withSnap((s) => (s.empty ? out : R('feed', args).then(fin).catch((e) => { warn('feed', e.message); return out; })));
        } catch (e) { warn('feed', e.message); return MODE === 'worker' ? Promise.resolve(out) : out; }
    }

    // ---------- 第四阶段:高光热度(写线程攒;主线程点查) ----------
    // heat(wk) → {bins:number[100] 0..100, users, dur} | null(不足 3 个贡献 / 作品不可见 / 隐藏 / AVDB 拦 / 片名命中追加屏蔽词)。同步(两种模式都是)
    function heat(wk) {
        try {
            if (typeof wk !== 'string' || !wk || wk.length > 300 || hiddenSet.has(wk)) return null;
            if (MODE !== 'worker') { if (!ensureInline()) return null; } else if (!ready || !mdb) return null;
            const row = rd(`SELECT h.users, h.sums, h.dur, w.name FROM adult_heat h JOIN adult_works w ON w.wk = h.wk WHERE h.wk=? AND w.vis=1 AND ${ELIG}`).get(wk);
            if (!row || !(row.users >= H.MIN_USERS)) return null;
            if (xKey() && nameExtraHit(row.name)) return null;
            if (avdbOn() && blockedWk(wk)) return null;
            return H.heatOut(row);
        } catch (e) { warn('heat', e.message); return null; }
    }
    // heatAdd(wk, {bins:number[100] 0..255 | Uint8Array(100), dur:秒}, who:不透明哈希) → boolean(inline 同步 / worker Promise)
    //   同一 who 同一作品同一 UTC 天只算一次;去重键 2 天后删;库里只有聚合
    function heatAdd(wk, data, who) {
        const no = () => (MODE === 'worker' ? Promise.resolve(false) : false);
        try {
            const d0 = data && typeof data === 'object' ? data : {};
            if (typeof wk !== 'string' || !/^[ct]:./.test(wk) || wk.length > 300 || hiddenSet.has(wk)) return no();
            if (typeof who !== 'string' || !who || who.length > 128) return no();
            const bins = H.parseBins(d0.bins);
            if (!bins) return no();
            if (MODE === 'worker' ? !ready : !ensureInline()) return no();
            const res = W('heatAdd', { wk, bins: Array.from(bins), dur: Number(d0.dur), who, t: nowFn() });
            return isP(res) ? res.then((x) => x === true, (e) => { warn('heat', e.message); return false; }) : res === true;
        } catch (e) { warn('heat', e.message); return no(); }
    }

    // ---------- 第四阶段:后台(只会更严) ----------
    const rulesKey = () => { try { return typeof P.rulesKey === 'function' ? P.rulesKey() : RULES_VERSION; } catch (_) { return RULES_VERSION + '+x?'; } };
    // extraBlock() → {words, n, rev}(当前生效的追加屏蔽词)
    // (inline 模式第一次用时才开库读后台状态:这几个查状态的接口先 ensureInline)
    const adminLoaded = () => { if (MODE !== 'worker') { try { ensureInline(); } catch (_) { /* */ } } };
    //   库里存的词(storedBlock)在一次成功的 setExtraBlock 存盘之前也算生效(读线程 / 写线程按的就是它):先并进主线程 policy 再报 ——
    //   闸门 syncExtraBlock 拿这里求 adult-admin.json ∪ catalog.db(worker 模式启动时闸门已把主线程词表换成 json 那份)
    const extraBlock = () => {
        adminLoaded();
        if (storedBlock && storedBlock.length) mergeBlock(storedBlock);
        try { return typeof P.extraBlock === 'function' ? P.extraBlock() : { words: [], n: 0, rev: '' }; } catch (_) { return { words: [], n: 0, rev: '' }; }
    };
    // isHidden(wk) → boolean(闸门的搜索出口可以用它丢掉已入库但被隐藏的作品)
    const isHidden = (wk) => { adminLoaded(); return typeof wk === 'string' && hiddenSet.has(wk); };
    const afterAdminChange = () => { homeMemo = null; try { const r = rebuild(); if (isP(r)) r.catch(() => {}); } catch (_) { /* */ } };
    // setExtraBlock(words:string[]) → Promise<{ok, n, rev, rulesKey, rescan:false, purge, gen} | {ok:false, error}>
    //   先在主线程校验 + 生效(闸门共用这个 policy 实例,更严的立刻生效:列表 / 作品页 / 查找 / 联想 / 热度的出口按片名拦;
    //   不合法 → 抛前什么都没改,回 {ok:false})→ 写线程存 'admin:block' → 读线程换词表 → 有新词就在后台删命中的线路(extraPurge,扫完重建快照)。
    //   不加规则代数、不重扫:别的作品一部都不会因为改词表暂时消失;删词 / 清空不扫(之前删掉的线路等爬虫 / 搜索回写再遇到时按新词表入库)
    async function setExtraBlock(words) {
        if (typeof P.setExtraBlock !== 'function') return { ok: false, error: 'unsupported' };
        let x;
        try { x = P.setExtraBlock(words); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        const g = ++blockGen;
        homeMemo = null;
        if (!(await ensureReady())) return { ok: false, error: 'unavailable', n: x.n, rev: x.rev };
        let r;
        try { r = await W('setExtraBlock', { words: x.words }); } catch (e) { warn('admin', e.message); return { ok: false, error: 'persist failed: ' + e.message, n: x.n, rev: x.rev }; }
        // 存上了:库 / 写线程 / 读线程 = 这份词表。等 ensureReady 的时候 init 的 loadAdmin 可能把库里的旧词并进了主线程 —— 按这份对齐
        //   (这期间又来了一次 setExtraBlock 就让后来的那次说了算)
        if (g === blockGen) { storedBlock = null; try { P.setExtraBlock(x.words); } catch (e) { warn('admin', e.message); } }
        else storedBlock = x.words.slice();   // 后来那次还在路上:库里现在是这份(后来那次存不上的话主线程至少不比库松)
        if (MODE === 'worker') await Promise.all(rHosts.filter((h) => h.alive()).map((h) => h.call('setExtraBlock', { words: x.words }).catch((e) => warn('admin', e.message))));
        if (r && r.purge) { const p = startPurge(); if (isP(p)) p.catch(() => {}); }
        return { ok: true, n: x.n, rev: x.rev, rulesKey: rulesKey(), rescan: false, purge: !!(r && r.purge), gen: r ? r.gen : null };
    }
    // 追加词删除扫描(写线程逐块跑,见 writer.js extraPurge);扫完重建快照(计数 / 分面跟上)。跑着的时候又来一次 → 跑完再跑一遍
    let purgeRun = null, purgeAgain = false;
    function startPurge() {
        if (purgeRun) { purgeAgain = true; return purgeRun; }
        purgeAgain = false;
        purgeRun = Promise.resolve().then(() => W('extraPurge', {}))
            .then((r) => { homeMemo = null; snapJ = null; try { const b = rebuild(); if (isP(b)) b.catch(() => {}); } catch (_) { /* */ } return r; })
            .catch((e) => { warn('purge', e.message); })
            .finally(() => { purgeRun = null; if (purgeAgain) { const p = startPurge(); if (isP(p)) p.catch(() => {}); } });
        return purgeRun;
    }
    // adminHide(wk, on:boolean) → Promise<{ok, wk, hidden, known} | {ok:false, reason}>。隐藏马上在主线程出口生效(写库失败也先藏着:只会更严)
    async function adminHide(wk, on) {
        if (typeof wk !== 'string' || !/^[ct]:./.test(wk) || wk.length > 300) return { ok: false, reason: 'invalid' };
        const hide = on === true;
        if (hide) { hiddenSet.add(wk); hiddenVer++; homeMemo = null; }
        if (!(await ensureReady())) return { ok: false, reason: 'unavailable' };
        let r;
        try { r = await W('adminHide', { wk, on: hide, t: nowFn() }); } catch (e) { warn('admin', e.message); return { ok: false, reason: 'error' }; }
        if (r && r.ok && !hide) { hiddenSet.delete(wk); hiddenVer++; }
        if (r && r.ok && hide && !hiddenSet.has(wk)) { hiddenSet.add(wk); hiddenVer++; }
        afterAdminChange();
        return r;
    }
    // adminHidden() → [{wk, name, at}](最近的 2000 个,新的在前;名字过查询硬拦词,被拦的名字不回显 → name:'')
    function adminHidden() {
        try {
            if (MODE !== 'worker') ensureInline();
            if (!mdb) return [];
            return rd('SELECT wk, name, at FROM adult_hidden ORDER BY at DESC, wk LIMIT 2000').all().map((r) => {
                let nm = typeof r.name === 'string' ? r.name : '';
                try { if (nm && P.checkQuery(nm)) nm = ''; } catch (_) { nm = ''; }
                return { wk: r.wk, name: nm, at: Number(r.at) || 0 };
            });
        } catch (e) { warn('admin', e.message); return []; }
    }
    // adminSite(key, active:boolean) → Promise<{ok, key, active, overrideActive} | {ok:false, reason}>
    //   只认配置里有的站;active:false = 停用(覆盖),active:true = 删掉覆盖(配置里本来就停用的站开不了)。存 adult_meta 'admin:sites'
    async function adminSite(key, active) {
        const k = typeof key === 'string' ? key.trim() : '';
        const cfg = cfgSites().get(k);
        if (!cfg) return { ok: false, reason: 'unknown' };
        if (active !== true && active !== false) return { ok: false, reason: 'invalid' };
        const prev = siteOv.has(k);
        siteTouched.add(k);   // 内存为准:启动途中 init 的 loadAdmin 不拿库里的旧值盖它(下面存盘存的是整张内存表)
        if (active === false) siteOv.set(k, false); else siteOv.delete(k);
        const out = { ok: true, key: k, active: cfg.active && !siteOv.has(k), overrideActive: siteOv.has(k) ? false : null };
        try {
            if (!(await ensureReady())) throw new Error('unavailable');
            await W('meta', { k: 'admin:sites', v: JSON.stringify(Object.fromEntries(siteOv)) });
        } catch (e) {
            warn('admin', e.message);
            if (active === true && prev) siteOv.set(k, false);   // 启用没存上 → 回到停用(停用没存上:内存里照样停着)
            return { ok: false, reason: 'persist failed' };
        }
        afterAdminChange();
        return out;
    }
    // siteOverrides() → {key:false}(后台停用的站);siteActive(key) → boolean(配置启用且没被后台停用)
    const siteOverrides = () => { adminLoaded(); return Object.fromEntries(siteOv); };
    const siteActive = (key) => { adminLoaded(); const s = allSites().get(String(key)); return !!(s && s.active); };
    // adminStats() → Promise<{works(可见), worksTotal, lines, hidden, heatRows, sites:[{key,name,lastOk,fails,active,overrideActive,lastErr}],
    //                         rejected:{reason:n}, rescan, rescanPending, purge(追加词删除扫描进度), avdb, extraBlock:{n, rev}, rulesKey}>
    async function adminStats() {
        let ws = wStats, wc = wCounts, as = avdbStat;
        if (MODE === 'worker') { try { await refreshWStats(); ws = wStats; wc = wCounts; as = avdbStat; } catch (_) { /* 用上次的 */ } }
        else if (ensureInline()) {
            try { ws = writer.handle('stats', {}); wc = writer.handle('counts', {}); } catch (_) { /* */ }
            try { as = avdbMain && typeof avdbMain.stats === 'function' ? avdbMain.stats() : null; } catch (_) { as = null; }
        }
        ws = ws || {};
        wc = wc || {};
        let st = new Map();
        try { if (mdb) st = new Map(rd('SELECT site, last_ok, fails, last_err FROM adult_crawl_state').all().map((r) => [r.site, r])); } catch (_) { /* */ }
        const sites = [...cfgSites().values()].map((s) => {
            const c = st.get(s.key) || {};
            return { key: s.key, name: s.name, lastOk: c.last_ok || null, fails: c.fails || 0, active: !!s.active && !siteOv.has(s.key), overrideActive: siteOv.has(s.key) ? false : null, lastErr: c.last_err || null };
        });
        const x = extraBlock();
        return {
            works: wc.visible || 0, worksTotal: wc.works || 0, lines: wc.items || 0, hidden: wc.hidden != null ? wc.hidden : hiddenSet.size, heatRows: wc.heatRows || 0,
            sites, rejected: Object.assign({}, ws.rejected), rescan: ws.rescan || null, rescanPending, purge: ws.purge || null,
            avdb: Object.assign({ enabled: !!avdbMain || !!avdbModulePath() }, ws.avdb || {}, { module: as, failClosed: avdbFailClosed() }),
            extraBlock: { n: x.n, rev: x.rev }, rulesKey: rulesKey(),
        };
    }

    // ---------- 第四阶段:短视频分类的慢速补库(刷一刷候选池) ----------
    //   每个 (站, short 叶子分类) 从第 1 页往深处翻(ac=detail&t=<分类>&pg=N),每 UTC 天 ≤ shortPagesPerDay 页,翻到底就停;
    //   同全量回填一样客气:同域名一次一个、间隔 ≥2.2s、走爬虫这一轮的请求额度、出网连接忙就停;首轮之后 6h 才开始,第一轮增量没爬完的站不做。
    //   翻到底之后:这一轮开扫(j.sw)满 shortResweepMs 就从第 1 页重扫(入库会刷新 play_at,刷一刷候选池不随 feedPlayTtlMs 过期)。
    //   每天的页数:总页数(这一轮的 pc,重扫刚开始还不知道就用上一轮的 lpc)/ shortResweepMs 的天数,向上取整,夹在 shortPagesPerDay..shortPagesPerDayMax
    //   (大分类一轮也在 ~7 天扫完;超过 shortPagesPerDayMax × feedPlayTtlMs 天数页的巨型分类仍是滑动窗口,不从头重来 —— 深处的页照样轮得到)。
    //   进度存 adult_meta 'shortbf'
    const shortPerDay = (j) => {
        const pc = Number(j.pc) || Number(j.lpc) || 0;
        const lo = C.shortPagesPerDay, hi = Math.max(lo, Number(C.shortPagesPerDayMax) || 0);
        return pc > 0 ? Math.min(hi, Math.max(lo, Math.ceil(pc / Math.max(1, C.shortResweepMs / DAY)))) : lo;
    };
    async function shortStep(budget) {
        if (!SHORT_BF || budget.left <= 0 || budget.paused) return 0;
        const t = nowFn(), day = Math.floor(t / DAY);
        if (t - (Number(getMeta('firstTick')) || t) < C.shortDelayMs) return 0;   // 和薄分区回填一样:首轮之后 6h 才开始(先让增量爬虫把首页填起来)
        let st = null;
        try { st = JSON.parse(getMeta('shortbf') || 'null'); } catch (_) { st = null; }
        if (!st || typeof st !== 'object' || !st.jobs || typeof st.jobs !== 'object') st = { jobs: {} };
        const jobs = [], seen = new Set();
        const cs0 = crawlSites();
        for (const site of cs0) {
            const cs = loadState(site);
            if (!cs.last_ok) continue;
            const cmap = classMapFor(site.api);
            if (!cmap) continue;
            for (const [tid, row] of cmap.byId) {
                if (row.container || row.block || row.bucket !== 'short') continue;
                const key = site.key + '|' + tid;
                seen.add(key);
                let j = st.jobs[key];
                if (!j || typeof j !== 'object' || j.api !== site.api) j = st.jobs[key] = { api: site.api, pg: 1, pc: null, day, n: 0, done: 0, at: 0, sw: t };
                if (j.day !== day) { j.day = day; j.n = 0; }
                // 重扫:这一轮开扫满 shortResweepMs(旧进度没有 sw → 按最后一次请求的时间算)
                if (j.done && t - (Number(j.sw) || Number(j.at) || 0) >= C.shortResweepMs) { if (Number(j.pc) > 0) j.lpc = Number(j.pc); j.done = 0; j.pg = 1; j.pc = null; j.sw = t; }
                if (j.done || j.n >= shortPerDay(j)) continue;
                jobs.push({ site, tid, j, ps: cs.pagesize || C.pageSize });
            }
        }
        for (const k of Object.keys(st.jobs)) if (!seen.has(k) && !cs0.some((x) => k.indexOf(x.key + '|') === 0)) delete st.jobs[k];
        jobs.sort((a, b) => (a.j.n - b.j.n) || ((a.j.at || 0) - (b.j.at || 0)));
        let n = 0;
        for (const job of jobs) {
            if (n >= C.shortPerTick || budget.left <= 0 || budget.paused) break;
            if (pausedNow()) { budget.paused = true; break; }
            if (!take(budget)) break;
            n++;
            stats.short.requests++;
            const { site, j } = job;
            let r = null;
            try { r = await gatedGet(site, urlFor(site, `ac=detail&t=${Number(job.tid)}&pagesize=${Number(job.ps) || C.pageSize}&pg=${Number(j.pg) || 1}`), C.historyGapMs); }
            catch (e) { warn('short ' + site.key, e.message); r = null; }
            j.n++;
            j.at = nowFn();
            const list = r && Array.isArray(r.list) ? r.list : null;
            if (!list) stats.short.errors++;
            else {
                if (list.length) stats.short.items += (await ingestList(site, list, 'crawl')).ok;
                const pc = Number(r.pagecount);
                if (Number.isFinite(pc) && pc > 0) j.pc = pc;
                if (!list.length || (j.pc && j.pg >= j.pc)) j.done = 1; else j.pg++;
            }
            await W('meta', { k: 'shortbf', v: JSON.stringify(st) });
        }
        return n;
    }

    // ---------- 播放结果上报(零上游;写线程) ----------
    function beacon(r, who) {
        try {
            if (MODE !== 'worker' && !ensureInline()) return { ok: false, reason: 'unavailable' };
            if (MODE === 'worker' && !ready) return Promise.resolve({ ok: false, reason: 'unavailable' });
            const res = W('beacon', { r, who, t: nowFn() });
            return isP(res) ? res.catch((e) => { warn('beacon', e.message); return { ok: false, reason: 'error' }; }) : res;
        } catch (e) { warn('beacon', e.message); return { ok: false, reason: 'error' }; }
    }

    // ---------- 封面代理查地址(只从索引里查;客户端给不了地址) ----------
    //   返回候选地址(代理按顺序试,前一个取不到换下一个);opts.meta → {url, urls, name, bucket}。
    //   siteKey = 卡片 / 作品封面的 /api/img?s=(= pic_item 的站)或作品页某条线路的站:
    //     · 没给 / 就是 pic_item 的站 → 写线程 pickCover 挑中的那一条(pic_item 的 (站, vod_id);不在死域名上)。原来点名了站就取"这个站最新的一条",
    //       同站另有一条封面在死域名上的(更新的)线路时代理会去取死图,卡片 / 作品封面跟着 502;
    //     · 别的站(作品页的线路封面)→ 那个站最新一条有封面的合格线路;站停用 / 这部片在那个站没有合格线路 → null(不相干的站不给)。
    //   之后接着兜底:pickCover 挑中的那条 → pic_alt(别的活域名上的同一部,≤2 个;要还是这部作品在启用站上的合格线路的封面)→ AVDB 封面。
    //   死域名上的一律不取(DNS 都没有这个名字)。
    function picUrl(wk, siteKey, opts) {
        try {
            if (typeof wk !== 'string' || !wk || wk.length > 300 || hiddenSet.has(wk)) return null;
            if (MODE !== 'worker') ensureInline();
            if (!mdb) return null;
            const w = rd(`SELECT w.wk, w.pic_item, w.pic_alt, w.apic, w.name, w.bucket, w.ckey FROM adult_works w WHERE w.wk=? AND ${ELIG}`).get(wk);
            if (!w) return null;
            if (w.ckey && avdbPol(w.ckey) === 'block') return null;
            const act = activeSites();
            const named = typeof siteKey === 'string' ? siteKey : '';
            const pi = String(w.pic_item || '').split('|');
            const piSite = pi[0] || '', piVid = pi.length > 1 ? pi.slice(1).join('|') : null;
            const isUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
            // 某个站上这部作品的封面:给了 vod_id 就是那一条,否则(或那一条不合格了)= 那个站最新一条有封面的合格线路;站停用 → ''
            const sitePic = (site, vod) => {
                if (!site || !act.has(site)) return '';
                let row = vod != null ? rd(`SELECT i.pic FROM adult_items i WHERE i.wk=? AND i.site=? AND i.vod_id=? AND i.pic <> '' AND ${ELIG_I}`).get(wk, site, vod) : null;
                if (!row) row = rd(`SELECT i.pic FROM adult_items i WHERE i.wk=? AND i.site=? AND i.pic <> '' AND ${ELIG_I} ORDER BY i.last_seen DESC LIMIT 1`).get(wk, site);
                return row && isUrl(row.pic) ? row.pic : '';
            };
            const urls = [];
            const add = (u) => { if (isUrl(u) && urls.indexOf(u) < 0) urls.push(u); };
            if (named && named !== piSite) {
                const u = sitePic(named, null);
                if (!u) return null;   // 点名的站已停用 / 没有这部作品的合格线路
                add(u);
            }
            add(sitePic(piSite, piVid));
            const alts = CH.altList(w.pic_alt);
            if (alts.length) {
                const ok = new Set();
                for (const r of rd(`SELECT i.site, i.pic FROM adult_items i WHERE i.wk=? AND i.pic <> '' AND ${ELIG_I}`).all(wk)) if (act.has(r.site)) ok.add(r.pic);
                for (const u of alts) if (ok.has(u) || u === w.apic) add(u);
            }
            add(w.apic);
            // 死域名上的封面不去取(DNS 都没有这个名字;代理换下一个)
            const dead = coverDeadSet();
            if (dead.size) for (let k = urls.length - 1; k >= 0; k--) if (dead.has(CH.hostOf(urls[k]))) urls.splice(k, 1);
            if (!urls.length) return null;
            return opts && opts.meta ? { url: urls[0], urls, name: w.name, bucket: w.bucket } : urls[0];
        } catch (e) { warn('picUrl', e.message); return null; }
    }

    // ---------- 封面域名健康(cover-health.js;主线程查 DNS、判死活,写线程按死域名挑封面) ----------
    //   状态的真相在 catalog.db adult_meta 'cover:hosts'(写线程存);主线程留一份内存副本(第一次用时从库里读)。
    //   coverCheck({full}):一轮检查 —— 全量(距上次全量 ≥ coverEveryMs,或第一次):写线程扫出目录里的封面域名(封面多的在前 ≤ coverMaxHosts)
    //     全部查一遍(死的也查,解析出地址就复活);否则只复查"一次 NXDOMAIN、等确认"的那几个。结果并进状态(CH.applyRound)→ 写线程存 +
    //     换死域名表 → 有变化就在写线程里重挑受影响作品的封面(coverApply),挑完重建快照(首页 / 浏览按新的 cov 排除)。
    //   deps.resolver(测试)= {resolve4, resolve6};没给就用 c-ares 的 dns.promises.Resolver
    function coverLoadState() {
        if (coverState) return coverState;
        if (!mdb) return null;
        let raw = null;
        try { raw = rd("SELECT v FROM adult_meta WHERE k='cover:hosts'").get(); } catch (_) { return null; }
        coverState = CH.parseState(raw ? raw.v : null);
        return coverState;
    }
    function coverDeadSet() {
        if (!COVER_ON) return new Set();
        const st = coverLoadState();
        return st ? CH.deadSet(st, SFO) : new Set();
    }
    // /api/config cover_dead_hosts:现在判死的封面域名(封面多的在前,≤ coverMaxDead);关了 / 库没好 = []
    function coverDeadHosts() {
        try {
            if (!COVER_ON) return [];
            if (MODE !== 'worker') ensureInline();
            const st = coverLoadState();
            return st ? CH.deadList(st, C.coverMaxDead, SFO) : [];
        } catch (e) { warn('cover', e.message); return []; }
    }
    function startCoverApply() {
        if (coverApplyP) return coverApplyP;
        coverApplyP = Promise.resolve().then(() => W('coverApply', {}))
            .then(async (r) => {
                // 有作品的封面 / cov 变了 → 重建快照(没封面的作品马上从首页 / 浏览里下去,复活的回来)
                if (r && r.changed > 0) { try { await rebuild(); } catch (e) { warn('snapshot', e.message); } }
                return r;
            })
            .catch((e) => { warn('cover', e.message); return { error: e.message }; })
            .finally(() => { coverApplyP = null; });
        return coverApplyP;
    }
    // 每轮一个解析器(系统 DNS 改了也跟得上;stop 时 cancel 掉这一轮的在途查询)。deps.resolver(测试)原样用
    function coverRes() {
        if (deps.resolver && typeof deps.resolver.resolve4 === 'function') return deps.resolver;
        return CH.makeResolver(C.coverTimeoutMs);
    }
    //   确认轮(只复查等第二次的):另查 ≤ coverControls 个上一轮解析正常的封面域名当对照(解析器过关只看它们,见 cover-health.js applyRound)。
    //   stop() / close():取消在途的一轮(不再发查询、在途的立刻收尾),这一轮的结果整个丢掉、不落库
    function coverCheck(opts) {
        if (coverRunP) return coverRunP;
        const ac = new AbortController();
        coverAbort = ac;
        const stopped = () => ac.signal.aborted || closed;
        coverRunP = (async () => {
            if (!COVER_ON) return { skipped: 'disabled' };
            if (!(await ensureReady())) return { skipped: 'nodb' };
            const st = coverLoadState();
            if (!st) return { skipped: 'nodb' };
            const t = nowFn();
            const full = !!(opts && opts.full) || !(st.full > 0) || t - st.full >= C.coverEveryMs || t < st.full;
            let hosts, counts = null, ctl = [];
            if (full) {
                const scan = await W('coverScan', { max: C.coverMaxHosts });
                counts = new Map((Array.isArray(scan) ? scan : []).filter((x) => Array.isArray(x) && CH.checkable(x[0])).map((x) => [x[0], Number(x[1]) || 0]));
                hosts = [...counts.keys()];
            } else {
                hosts = CH.pendingList(st);
                if (hosts.length) ctl = CH.controlList(st, C.coverControls, new Set(hosts));
                // 对照凑不够(目录里正常的封面域名不到 3 个):确认轮反正过不了关,不查、不报警,等下一次全量轮
                if (hosts.length && ctl.length < CH.GUARD.minOk) return { skipped: 'nocontrols', pending: hosts.length };
            }
            if (stopped()) return { skipped: 'stopped' };
            const all = hosts.concat(ctl);
            const got = all.length ? await CH.checkHosts(all, { resolver: coverRes(), conc: C.coverConc, timeoutMs: C.coverTimeoutMs, signal: ac.signal, sfConfirm: C.coverServfailDead && full }) : new Map();
            if (stopped()) return { skipped: 'stopped' };
            const verdicts = new Map(), controls = new Map();
            for (const h of hosts) if (got.has(h)) verdicts.set(h, got.get(h));
            for (const h of ctl) if (got.has(h)) controls.set(h, got.get(h));
            const r = CH.applyRound(st, verdicts, t, { minGap: C.coverConfirmMinMs, counts, prune: full, pending: !full, controls, sfDead: C.coverServfailDead, sfMin: C.coverSfMin, sfMinMs: C.coverSfMinMs });
            if (full) st.full = t;
            // 只在"没死的域名里真有说不存在 / SERVFAIL 的"时才报(早就判死的一直 NXDOMAIN 是正常的,不报;见 applyRound 的 guard)
            const g = r.guard;
            if (r.suspicious && (g.nx > 0 || g.sf > 0)) {
                warn('cover', full ? `这一轮不判死:解析出地址的封面域名不到 3 个、或说不存在的超过 30%,可能是解析器有问题(没死的 ${g.n} 个里:解析出地址 ${g.ok}、不存在 ${g.nx}、SERVFAIL ${g.sf}、不知道 ${g.unk};早就判死的 ${g.deadBefore} 个不算)`
                    : `复查时对照域名解析不正常(${r.ctl.ok}/${r.ctl.n} 解析出地址):这一轮不确认,等下一轮`);
            }
            const res = await W('coverHosts', { state: CH.dumpState(st) });
            const dead = CH.deadList(st, C.coverMaxDead, SFO);
            if (r.changed.length) log('封面域名:' + r.changed.map((h) => h + (st.hosts[h] && st.hosts[h].dead ? (st.hosts[h].why === 'sf' ? ' 判死(SERVFAIL)' : ' 判死') : ' 复活')).join(',') + ';现在死的 ' + dead.length + ' 个');
            let applied = null;
            if (res && res.pending) applied = await startCoverApply();
            coverLast = { at: t, full, checked: hosts.length, controls: ctl.length, ok: r.ok, nx: r.nx, sf: r.sf, unk: r.unk, deadBefore: g.deadBefore, suspicious: r.suspicious, changed: r.changed.slice(0, 50), pending: CH.pendingList(st).length };
            return Object.assign({}, coverLast, { dead, applied });
        })().catch((e) => { warn('cover', e.message); return { error: e.message }; })
            .finally(() => { coverRunP = null; if (coverAbort === ac) coverAbort = null; });
        return coverRunP;
    }
    // 下一轮什么时候(last = 这一轮 coverCheck 的结果):
    //   这一轮出错 / 库还没好(skipped:'nodb'),或者还从没跑完过一轮全量(没有状态 / st.full = 0)→ coverRetryMs(≈5 分钟)后重试
    //     —— 原来首轮赶上库没好 / 出错就按"没有上次全量"算成 6 小时后,刚部署的站 6 小时里死图床一个都不判;
    //   有等确认的(而且凑得出对照)→ coverConfirmMs 后;否则到下一次全量(≥1 分钟、≤ coverEveryMs)
    function coverNextMs(last) {
        const st = coverState;
        const failed = !!(last && (last.error || last.skipped === 'nodb'));
        if (failed || !st || !(st.full > 0)) return Number(C.coverRetryMs) >= 20 ? Math.min(C.coverEveryMs, Number(C.coverRetryMs)) : 5 * MIN;
        const pend = CH.pendingList(st);
        if (pend.length && CH.controlList(st, C.coverControls, new Set(pend)).length >= CH.GUARD.minOk) return Math.max(C.coverConfirmMinMs, C.coverConfirmMs);
        const due = st.full + C.coverEveryMs - nowFn();
        return Math.max(60e3, Math.min(C.coverEveryMs, due));
    }
    function coverStatus() {
        const st = COVER_ON ? coverState : null;
        return {
            enabled: COVER_ON, servfailDead: C.coverServfailDead, hosts: st ? Object.keys(st.hosts).length : 0, dead: st ? CH.deadList(st, C.coverMaxDead, SFO) : [],
            pending: st ? CH.pendingList(st) : [], lastFull: st ? st.full || 0 : 0, last: coverLast, applying: !!coverApplyP,
            next: coverNext,   // start() 排的下一轮:{at:排的时间, ms:多久以后};没在跑 = null
        };
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
            if (!(await ensureReady())) continue;
            let cmap = classMapFor(site.api);
            if (!cmap) cmap = await ensureClassMap(site);
            if (!cmap) continue;
            const r = await ingestList(site, items, 'search');
            if (r.noclass) await W('classForce', { api: site.api, t: nowFn() });
        }
    }
    async function flush() {
        for (let i = 0; i < 1000 && (sqRunning || rescanP || purgeRun || coverApplyP); i++) {
            try { await (sqRunning || rescanP || purgeRun || coverApplyP); } catch (_) { /* 已记日志 */ }
        }
    }

    // ---------- 保留期(全量历史:作品保留,线路按健康过期) ----------
    function retention() {
        try {
            if (MODE !== 'worker' && !ensureInline()) return 0;
            if (rescanPending) return 0;
            const keep = [];
            if (typeof deps.referenced === 'function') {
                try { const r = deps.referenced(); if (r && typeof r[Symbol.iterator] === 'function') for (const x of r) if (typeof x === 'string' && x) keep.push(x); }
                catch (e) { warn('referenced', e.message); return 0; }   // 不知道谁还被引用 → 这轮不动
            }
            const res = W('retention', { t: nowFn(), keep: keep.slice(0, 5000), siteKeys: [...allSites().keys()] });
            return isP(res) ? res.catch((e) => { warn('retention', e.message); return 0; }) : res;
        } catch (e) { warn('retention', e.message); return 0; }
    }

    // ---------- 规则版本变了:全库按新规则重跑(写线程,逐块;读接口照常,只是还没重跑到的旧代行读不到) ----------
    //   重扫进行中每 rescanSnapMs 重建一次快照,让重跑完的作品(最新上架的先跑)尽快出现在首页 / 浏览里
    let rescanTimer = null;
    function startRescan() {
        if (rescanP) return rescanP;
        if (!rescanTimer && C.rescanSnapMs > 0) {
            rescanTimer = setInterval(() => { if (!buildP) { try { const r = rebuild(); if (isP(r)) r.catch(() => {}); } catch (_) { /* */ } } }, C.rescanSnapMs);
            if (rescanTimer.unref) rescanTimer.unref();
        }
        const stopTimer = () => { if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; } };
        rescanP = Promise.resolve().then(() => W('rescan', { sites: [...allSites().values()] }))
            .then((r) => {
                if (r && (r.deferred || r.error)) { stopTimer(); return r; }
                rescanPending = false;
                stopTimer();
                snapJ = null;
                rebuild();
                return r;
            })
            .catch((e) => { stopTimer(); warn('rescan', e.message); })
            .finally(() => { rescanP = null; });
        return rescanP;
    }

    // ---------- 启停 ----------
    let started = false, tickTimer = null, homeTimer = null, retTimer = null, optTimer = null;
    const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };
    function start() {
        if (started) return;
        if (DISABLED) { log('CATALOG_DISABLE=1:不启动目录爬虫(读接口照常)'); return; }
        started = true;
        // 重启:上次没回填完的站直接接着回填(游标从上次那页的前一页续),不等下一轮爬虫真发出请求
        const resumeHistory = () => { if (started && BACKFILL && historyWanted()) startHistory(); };
        if (MODE === 'worker') initWorkers().then((ok) => { if (ok && started && avdbModulePath()) W('avdbStart', {}).catch((e) => warn('avdb', e.message)); if (ok) resumeHistory(); });
        else if (ensureInline()) {
            if (avdbMain && typeof avdbMain.start === 'function') { try { avdbMain.start(); } catch (e) { warn('avdb', e.message); } }
            resumeHistory();
        }
        const loop = async () => {
            if (!started) return;
            try { await tick(); } catch (e) { warn('tick', e.message); }
            if (started) tickTimer = unref(setTimeout(loop, lastTick && lastTick.more ? Math.min(C.tickMs, C.tickBusyMs) : C.tickMs));
        };
        tickTimer = unref(setTimeout(loop, C.firstDelayMs));
        homeTimer = unref(setInterval(() => { try { const r = rebuild(); if (isP(r)) r.catch(() => {}); } catch (e) { warn('home', e.message); } }, C.homeMs));
        retTimer = unref(setInterval(() => { try { const r = retention(); if (isP(r)) r.catch(() => {}); } catch (e) { warn('retention', e.message); } }, C.retentionEveryMs));
        optTimer = unref(setInterval(() => { try { const r = W('optimize', { checkpoint: 'truncate' }); if (isP(r)) r.catch(() => {}); } catch (_) { /* */ } }, C.optimizeEveryMs));
        // 封面域名健康:首轮延后(目录先爬起来),之后按 coverNextMs 排(这一轮失败 / 库没好 → ≈5 分钟后重试)
        const coverLoop = async () => {
            if (!started) return;
            let next;
            try { next = coverNextMs(await coverCheck({})); } catch (e) { warn('cover', e.message); next = coverNextMs({ error: e.message }); }
            if (started) { coverNext = { at: nowFn(), ms: next }; coverTimer = unref(setTimeout(coverLoop, next)); }
        };
        if (COVER_ON) { coverNext = { at: nowFn(), ms: C.coverFirstDelayMs }; coverTimer = unref(setTimeout(coverLoop, C.coverFirstDelayMs)); }
        log(`已启动:爬 ${crawlSites().length} 个站,首轮 ${C.firstDelayMs}ms 后;规则 ${RULES_VERSION};${MODE === 'worker' ? '写/读线程' : '主线程(inline)'};全量回填${BACKFILL ? '开' : '关'}`);
    }
    function stop() {
        const was = started;
        started = false;
        clearTimeout(tickTimer);
        clearInterval(homeTimer);
        clearInterval(retTimer);
        clearInterval(optTimer);
        clearTimeout(coverTimer);
        tickTimer = homeTimer = retTimer = optTimer = coverTimer = coverNext = null;
        // 在途的封面域名检查:取消(不再发 DNS 查询、在途的立刻收尾、这一轮结果丢掉)—— 不取消的话一轮 500 个域名 × 超时能把进程多撑好几分钟
        if (coverAbort) { try { coverAbort.abort(); } catch (_) { /* */ } }
        if (!was) return;
        if (MODE === 'worker') { if (wHost) wHost.call('avdbStop', {}).catch(() => {}); }
        else if (avdbMain && typeof avdbMain.stop === 'function') { try { avdbMain.stop(); } catch (_) { /* */ } }
    }
    async function close() {
        stop();
        closed = true;
        // 取消了的封面检查马上就收尾;等它一下(≤3s),别在它写库的半中间把库关了
        const cr = coverRunP;
        if (cr) { let tm = null; await Promise.race([cr.catch(() => {}), new Promise((r) => { tm = setTimeout(r, 3000); })]); clearTimeout(tm); }
        if (MODE === 'worker') {
            try { await initP; } catch (_) { /* */ }
            await Promise.all([wHost, ...rHosts].filter(Boolean).map((h) => h.close()));
            try { if (mdb) mdb.close(); } catch (_) { /* */ }
        } else if (MODE === 'own' && conn) { try { conn.close(); } catch (_) { /* */ } }
    }

    async function refreshWStats() {
        if (MODE !== 'worker' || !ready) return;
        wStats = await W('stats', {});
        wCounts = await W('counts', {});
        avdbStat = await W('avdbStats', {});
    }
    function statsFn() {
        let ws = wStats, wc = wCounts, as = avdbStat;
        if (MODE !== 'worker' && ensureInline()) {
            try { ws = writer.handle('stats', {}); wc = writer.handle('counts', {}); } catch (_) { /* */ }
            try { as = avdbMain && typeof avdbMain.stats === 'function' ? avdbMain.stats() : null; } catch (_) { as = null; }
        }
        ws = ws || {};
        const out = {
            mode: MODE, ready, disabled: DISABLED, started, rulesVersion: RULES_VERSION, tagsVersion: TG.VERSION, rescanPending, rescan: ws.rescan || null, purge: ws.purge || null, fts: ftsOk, maxSites: MAX_SITES || null,
            requests: stats.requests, ingested: ws.ingested || 0, rejected: Object.assign({}, ws.rejected), flags: Object.assign({}, ws.flags), signals: Object.assign({}, ws.signals),
            migrated: ws.migrated || 0, searchQueue: sqItems, searchDropped: stats.searchDropped, retention: ws.retention || null, lastTick,
            expand: Object.assign({}, stats.expand, { inflight: expanding.size, globalActive: gsem.active, globalPeak: gsem.peak }),
            hits: Object.assign({}, stats.hits, { items: (ws.hits && ws.hits.items) || 0 }), backfill: Object.assign({}, stats.backfill), history: Object.assign({ enabled: BACKFILL, running: histLoopOn }, stats.history),
            beacon: Object.assign({}, ws.beacon), avdb: Object.assign({ enabled: !!avdbMain || !!avdbModulePath() }, ws.avdb || {}, { module: as, main: !!avdbMain, failClosed: avdbFailClosed() }), imgProxy: IMG_PROXY,
            short: Object.assign({ enabled: SHORT_BF }, stats.short), heat: ws.heat || null, hiddenWorks: hiddenSet.size, siteOverrides: Object.fromEntries(siteOv),
            extraBlock: (() => { const x = extraBlock(); return { n: x.n, rev: x.rev }; })(), rulesKey: rulesKey(),
            home: snapJ ? { generatedAt: snapJ.home.generatedAt, rows: snapJ.home.rows.map((r) => ({ id: r.id, n: r.items.length })) } : null,
            snapshot: snapJ ? { sid: snapJ.sid, works: snapJ.N, buildMs: snapJ.ms, at: snapJ.at } : null,
            cover: Object.assign(coverStatus(), { writer: ws.cover || null }),
        };
        if (wc) Object.assign(out, { items: wc.items, works: wc.works, visible: wc.visible, deadLines: wc.deadLines, hitsRows: wc.hitsRows });
        try {
            if (mdb) {
                out.sites = rd('SELECT site, last_ok, next_at, mode, pagesize, fails, last_err, ignores_h, n_req, n_items, cursor IS NOT NULL AS resuming FROM adult_crawl_state ORDER BY site').all();
                out.historySites = rd('SELECT site, pg, pc, done, fails, n_req, n_items FROM adult_backfill ORDER BY site').all();
                try { out.extTrust = JSON.parse(getMeta('exthot:trust') || 'null'); } catch (_) { out.extTrust = null; }
                try { const bf = JSON.parse(getMeta('backfill') || 'null'); out.backfillState = bf ? { startedAt: bf.startedAt, thin: bf.thin, queued: Array.isArray(bf.queue) ? bf.queue.length : 0 } : null; } catch (_) { out.backfillState = null; }
            }
        } catch (e) { out.error = e.message; }
        return out;
    }
    async function statsAsync() { try { await refreshWStats(); } catch (_) { /* */ } return statsFn(); }

    return {
        start, stop, close, home, browse, buckets, work, classInfo, ingestSearchItems, stats: statsFn,
        tick, rebuild, retention, flush, lookup,
        tags, suggest, beacon, picUrl,
        // 第三阶段
        tagPage, studios, actress, actressSearch, avdbPol, indexedWks, historyStep, avdbSync, statsAsync,
        // 第四阶段
        related, feed, heat, heatAdd, adminStats, adminHide, adminHidden, isHidden, setExtraBlock, extraBlock, rulesKey, adminSite, siteOverrides, siteActive,
        // 封面域名健康
        coverCheck, coverDeadHosts, coverStatus,
        ready: () => (MODE === 'worker' ? initWorkers().then(() => ready) : Promise.resolve(!!ensureInline())),
        imgProxy: IMG_PROXY,
        RULES_VERSION,
        mode: MODE,
    };
}

module.exports = { createCatalog, DEF };
