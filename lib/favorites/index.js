'use strict';
// ❤️ 收藏(追剧)+ 更新提醒(server.js 用;Vercel 无 SQLite → api/index.js 只挂桩)。
//
// 为什么这样做:
//   · 收藏和历史分开:历史是"看过什么",收藏是"等它更新"。每用户最多 100 部、全站最多跟踪 3000 个 (站, 片 id):
//     有人收藏几万部 / 拿匿名接口灌垃圾 id,后台检查也不会被拖死。
//   · 更新检查只调 maccms 详情 API(?ac=detail&ids=…,和 /api/detail 同一类请求),绝不拉 m3u8/分片(VPS 拉 m3u8 = 资源站封机房 IP)。
//     每站每批 ≤20 个 id 一个请求、每轮全站 ≤60 个请求、并发 2、同站两批间隔 ≥2s;请求路径上从不同步检查(只读库)。
//   · 用户收藏表另存 check_site/check_vid 两列(带索引):集数变多时要找"谁收藏了它"发推送,不能每次全表 json_extract。
//   · 用户输入当键的表一律 Map / Object.create(null)(PASSWORD_HASH_MAP 曾因原型键被绕过)。
//   · 跟踪表分两块容量(总 3000):"没有任何服务器收藏引用"的行(匿名 status 登记的本机收藏、被删掉的收藏留下的)
//     最多 maxWatch − anonReserve = 2000 行,到了就不再接受匿名新登记;留出的 1000 行只有服务器收藏(add/列表补登)能用。
//     服务器收藏可用任何空位;表全满时:没人收藏的行超过 2000(多出来的只能是服务器收藏留下的孤行 src='fav')→ 先挤这种孤行;
//     否则只能挤"没人收藏、且 ≥24h 没人要"的行里最久没人要的一个,没有就不登记(收藏本身照常成功,之后 GET 列表补登时再试)。
//     匿名 status 永远挤不掉任何行。服务器收藏登记的行在最后一个收藏它的人取消时直接删掉(dropFavOrphan):
//     收藏/取消 反复刷不会再留下占着预留的孤行 —— 预留里只剩真被收藏的行,每个令牌最多 100 部。
//     为什么:匿名续期是免费的(重发已有 id 不花预算),灌进来的行可以一直"新鲜"。以前要求被挤的行 7 天没人要 → 表一满新收藏全部
//     静默不跟踪;后来改成不看多久没人要 → 任何有令牌的人反复 收藏/取消 就能把刚被本机收藏用户问过的行一行行挤掉(两轮审查实锤)。
//     剩余风险(已知、接受):公开站上有人用真实存在的 id(maccms id 是连续整数)持续灌满并续期这 2000 行,
//     本机收藏(没登录/没开同步的设备)的新登记会一直被拒(已登记的不受影响);服务器收藏有预留,不受影响。
//   · 垃圾行自己会消失:站点详情请求成功、返回里有这批的别的 id、唯独没有这个 → 记一次"查无此片";连续 2 次就删掉
//     (没有服务器收藏引用时;有引用的改成 24h 后再看)。这批一个 id 都没返回(站点抽风/维护时常回 {list:[]})= 当请求失败:
//     退避、查无次数不动 —— 不能把"站点这会儿什么都不回"当成"这些片子全被删了"(审查实锤:两次抽风删光一个站的本机收藏行)。
//     请求失败不算查无、也不清零;查到了清零。本机收藏用户的行被删了,下次 status 会重新登记。
//     没人收藏的行 14 天没人再问就清掉(有人收藏的不清)。
//   · 推送去重靠每行的"已通知最高集数"max_ep:资源站重新采集时集数会 12→11→12 来回跳,只比上次存的集数会反复推同一集。
//   · 追更日历(服务器只出它独有的两样,TMDB 下一集播出时间由前端自己查):
//     total = 详情里的 vod_total(资源站从不填 vod_weekday;vod_total 有的填 30、有的填 0 —— 0/垃圾/比当前集数还小的/888 占位/
//       综艺按期数编号的一律不认;连载中正好等于当前集数的也不认,有的站永远填当前集数,见 pickTotal);
//     chg_log = 最近 35 天里"真涨过 max_ep"的更新(一次更新一笔 {t, ep, p}:p = 上一次查到的时刻,新集在 (p, t] 里上的;
//       6h 内又涨的并进同一笔;最多 40 笔;来回跳/第一次基线不记;隔了 > 8h 才看到的记成断档 u:1)→ inferCadence 推"每周几更新/日更"和大概几点上新
//     (国产剧 TMDB 只有约 1/3 有 next_episode_to_air,剩下的只能靠自己看到的更新规律)。
// 所有入口都吞异常:收藏坏了只是少个红点,绝不能拖垮播放/首页。

const DAY = 86400e3, HOUR = 3600e3;
const DEF = {
    maxFav: 100,                 // 每用户最多收藏几部
    maxWatch: 3000,              // 全站最多跟踪几个 (site_key, vod_id);满了按上面的规则让位/拒绝
    anonReserve: 1000,           // 留给服务器收藏的容量:没人收藏的行到了 maxWatch − anonReserve 就不再接受匿名新登记
    favEvictIdleMs: 24 * HOUR,   // 表全满时服务器收藏只能挤掉"没人收藏、且这么久没人要"的行
    evictIdleMs: 7 * DAY,        // 站长调小上限后的兜底削减(trimOver)只削"没人收藏、且这么久没人要"的行
    missDrop: 2,                 // 详情请求成功却连续几次查无此片 → 删行(没人收藏时)
    missRefMs: 24 * HOUR,        // 有人收藏的行查无此片 → 这么久后再看(不删)
    maxSources: 10,              // 条目里最多存几条线路
    batchIds: 20,                // 每个详情请求最多几个 id(maccms 默认 pagesize 20,多了会被截断)
    maxReqPerRound: 60,          // 每轮全站最多几个请求(含直连失败后的代理重试)
    concurrency: 2,              // 同时请求几个站
    siteGapMs: 2000,             // 同一站两批之间至少隔多久
    roundMs: 10 * 60e3,          // 每 10 分钟一轮
    firstDelayMs: 60e3,          // 启动 60s 后第一轮(别和启动预热抢出网)
    changedMs: 2 * HOUR,         // 有变化 → 2h 后再查(连更的剧)
    ongoingMs: 4 * HOUR,         // 连载没变化 → 4h
    finishedMs: 72 * HOUR,       // 完结 → 72h
    failBackoff: [HOUR, 6 * HOUR, 24 * HOUR],   // 请求失败/片子不见了 → 退避
    badSiteMs: 24 * HOUR,        // 站点已从配置里删掉/变成规则站 → 一天后再看
    staleAnonMs: 14 * DAY,       // 没人收藏的行 14 天没人再问 → 删(有人收藏的不删)
    timeoutMs: 10000,
    statusMax: 100,              // 匿名 status 一次最多查几个
    newPerIpHour: 300,           // 每个来源每小时最多新登记几个 (站, 片):来源 = 令牌(配了访问密码时)/IP(公开站)。防灌垃圾 id 占满跟踪表
    ipMapMax: 50000,
    touchMs: 5 * 60e3,           // GET 列表续期 last_wanted 的节流
    touchMapMax: 50000,
    nameMax: 100, posterMax: 500, sigMax: 80, labelMax: 60, siteNameMax: 60, epMax: 60, remarksMax: 60,
    chgLogMax: 40,               // chg_log 最多几笔。一笔 = 一次更新(6h 内的几次涨集并成一笔),40 笔够日更剧填满 35 天窗口、一天两批的也有 20 天
                                 //   (以前存 12 次"检测":一天涨两次的日更剧只剩 6 天,永远缺一个星期几、报不出"每天")
    chgGapMs: 8 * HOUR,          // 上次查到距今超过这么久(失败退避/停机后)才看到涨集 → 不知道是哪天更新的,只记成断档 {u:1}(不拿它定更新日,见 inferCadence ⑥)
};
// 更新规律推断参数。时间一律按北京时间(UTC+8,无夏令时):国产剧/番剧的排播都是北京时间
const CAD = {
    winMs: 35 * DAY,             // 只看最近 35 天的更新
    minDays: 3,                  // 至少 3 个不同的更新日才推断
    dailyWinMs: 14 * DAY,        // 最近 14 天里出现 ≥5 个不同的星期几(且每个都够次数,见 inferCadence)→ 日更
    dailyMin: 5,
    minSpanDays: 7,              // 第一次涨集到现在不满 7 天 → 不报:才看到周三四五连着更,分不清是日更还是"每周三至五"
    shortSpanDays: 14,           // 第一次涨集到现在不满 14 天 = 每个更新日还没机会出现两次 → 见过一次的星期几也算;满了要 ≥2 次
    staleMs: 14 * DAY,           // 最后一次更新已过 14 天(停更/完结但备注没写完结)→ 不再报规律,免得一直说"周三更新"
    // 每笔 chg_log 带上一次查到的时刻 p:资源站是在 (p, t] 里上的新集。按"被最多笔的 (p, t] 盖住的最早钟点"定这部剧的上新钟点(锚点),
    //   每笔取窗口里落在锚点的那一刻(锚点不在窗口里 → 取离锚点近的那一端)。以前按检测时刻 t − 2h 的平均:检测一连几周偏晚(每次检查
    //   相位后移 10 分钟)时平均值滑过零点,周五 22:00 的剧整部被报成"周六"(审查实锤)
    defWinMs: 4 * HOUR,          // 没有 p(或 p 不可信)的笔:当成上一次检查在 4h 前(连载没变化 4h 查一次)
    maxWinMs: 8 * HOUR,          // 窗口比这长的不可信(= DEF.chgGapMs:更久的根本不记)
    labelLagMs: HOUR,            // 算"星期几"时锚点再往前挪 1h:22:00~23:00 更新、资源站过了零点才有的,仍算前一天晚上的更新
    eveMaxMs: 6 * HOUR,          // 锚点在凌晨 6 点前、且有一周 01:00 前就查到了 → 也算前一天晚上(见 inferCadence ①)
    wdShare: 0.75,               // 一致性(见 inferCadence ⑤):报出的星期几在跟踪期间出现的那几天里至少更了 75%(5 周漏 1 周还算)
    coverShare: 0.75,            //   报出的几天至少盖住 75% 的更新日(偶尔一次补更不碍事)
    dueMs: 12 * HOUR,            //   上新钟点过了 12h 还没查到涨集 = 这天没更(4h 一查 + 资源站晚几小时都够了)
    mergeMs: 6 * HOUR,           // chg_log:离上一笔不到 6h 的涨集 = 同一次更新,并进上一笔。只按间隔不按日期:以前"同一个北京日"也并,
                                 //   检测 02:46 和次日 01:46(相隔 23h)被并成一笔,日更剧每周丢一两天(审查实锤);同一天的几笔在 inferCadence 里本来就算一天
    tzMs: 8 * HOUR,
};
const VID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// 站 key 不进 URL(URL 用配置里的 api 拼),只要在站点列表里就行;片 id 要拼进 ids=,不许逗号等字符
const siteKeyOk = (k) => typeof k === 'string' && k.length > 0 && k.length <= 64 && !/[\u0000-\u001f\u007f]/.test(k);
const FINISHED_RE = /完结|全集|已完结|全\d+集/;
const CTRL_RE = /[\u0000-\u001f\u007f]/g;
const clean = (v, n) => String(v == null ? '' : v).replace(CTRL_RE, ' ').trim().slice(0, n);
const intIn = (v, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

// ---------- 纯函数(测试直接调) ----------
// vod_play_url → { ep_count, latest_ep }。与前端 parseEpisodes 同规则:'$$$' 分路,取第一路含 m3u8 的,否则第一路;按 '#' 分集。
//   空段(结尾多一个 '#')不算一集:前端把它当成一集只会让 seen 更大 → 不会误报红点;反过来就会永远有红点。
function parsePlayUrl(s) {
    s = typeof s === 'string' ? s : '';
    let src = s;
    if (s.includes('$$$')) {
        const sets = s.split('$$$');
        src = sets.find(x => x.toLowerCase().includes('m3u8')) || sets[0];
    }
    const eps = src.split('#').map(x => x.trim()).filter(Boolean);
    if (!eps.length) return { ep_count: 0, latest_ep: '' };
    const last = eps[eps.length - 1];
    const i = last.indexOf('$');
    return { ep_count: eps.length, latest_ep: clean(i > 0 ? last.slice(0, i) : '正片', DEF.epMax) };
}
// 详情 API 的一条 vod → 状态
function vodStatus(v) {
    const p = parsePlayUrl(v && v.vod_play_url);
    const remarks = clean(v && v.vod_remarks, DEF.remarksMax);
    return { ep_count: p.ep_count, latest_ep: p.latest_ep, remarks, finished: FINISHED_RE.test(remarks) ? 1 : 0, total: datedEps(p.latest_ep, remarks) ? null : parseTotal(v && v.vod_total) };
}
// vod_total → 正整数或 null。maccms 没填时是 0(绝不能当"共 0 集");"全30集"/"30.5"/负数之类也不认;
//   888/999/9999 这种重复数字是采集站的占位(实测 jisu 刘在街头 165/888、凡人修仙传重制版 21/888)
function parseTotal(v) {
    let n = null;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && /^\s*\d{1,6}\s*$/.test(v)) n = parseInt(v, 10);
    if (Number.isInteger(n) && /^(\d)\1{2,}$/.test(String(n))) return null;
    return Number.isInteger(n) && n > 0 && n <= 100000 ? n : null;
}
// 综艺/按期数、日期编号的(「20261007期」「261007」「第646期」):没有"共几集",vod_total 是占位(实测超人回来了/东张西望填 200)→ 不认
const DATED_EP_RE = /期|^\D{0,2}\d{6}(\d{2})?\D{0,2}$/;
const datedEps = (latest, remarks) => DATED_EP_RE.test(String(latest || '').trim()) || /期/.test(String(remarks || ''));
// 这次要存的总集数:新值可信(正整数且 > 当前集数)就用新值;否则沿用上次的 —— 但上次的也得 ≥ 当前集数
//   (集数都超过它了说明它是错的/过时的,不能再报"共 30 集")。
//   新值 = 当前集数不算数(只沿用上次的):有的站 vod_total 永远填当前集数(实测 maotaizy 家庭关系证明书 57/57「第57集」,
//   bfzy 同一部「更新至第58集」),存下来就成了"已到总集数" → 连载中的剧永远不报规律、卡片像播完了(审查实锤)。
//   真的总集数在连载中途一定见过比集数大的值(10/11 → 11/11 季终照样认);备注写了完结的(finished)= 当前集数就是总集数,照认;
//   连载中第一次就看到 40/40 的只是少显示一个总集数
function pickTotal(raw, prev, ep, finished) {
    const t = parseTotal(raw);
    ep = Number(ep) || 0;
    if (t != null && (t > ep || (t === ep && finished))) return t;
    return Number.isInteger(prev) && prev > 0 && prev >= ep ? prev : null;
}
const parseLog = (s) => {
    if (typeof s !== 'string' || !s) return [];
    try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
};
// 北京时间日序号 → ISO 星期几(1=周一 … 7=周日);1970-01-01 是周四
const isoWeekday = (dayIdx) => ((dayIdx % 7) + 10) % 7 + 1;
// 北京时间的"钟点"ms(0 ~ DAY)
const bjClock = (t) => (((t + CAD.tzMs) % DAY) + DAY) % DAY;
const mod = (x) => ((x % DAY) + DAY) % DAY;
// 两次涨集算不算同一次更新(chg_log 并笔用):离得不到 6h
const sameRelease = (a, b) => Math.abs(b - a) < CAD.mergeMs;
// chg_log([{t, ep, p}])→ 更新规律 { daily, days:[ISO 星期几], n:更新日数, last_t, clock? } 或 null(推不出/完结/停更/才开始跟踪)。
//   ① 每笔的上新时刻落在 (p, t](p = 上一次查到的时刻)。锚点 = 被最多笔窗口盖住的最早钟点(候选只有各窗口起点);
//      每笔取窗口里落在锚点的那一刻(锚点不在窗口里取离它近的一端),归到离锚点最近的那个"更新日"(切口在锚点 ±12h);
//      锚点本身在零点后 labelLagMs 以内(资源站过了零点才有)算前一天晚上的更新;锚点在凌晨 eveMaxMs 以内、但有一笔
//      在它那天零点后 labelLagMs 之前就查到了(t 早于 01:00 = 那一周按同一惯例就是前一天晚上的更新)→ 整部也算前一天晚上。
//      锚点 = 盖住它的笔里最晚的起点,一次 01:27 才查过(还没有)的笔就能把锚点拖过 labelLag:周五 23:00 的剧资源站
//      23:30~01:30 才上,有的种子整部报成周六;周三 20:00 晚 0~8h 的报成周四(审查实锤;那几周里明明有一周 23:47 就查到了)。
//      剩下的:每一笔都要到 01:00 后才查到(窗口全跨零点)、资源站真有几周 01:00 后才上的,数据上和"周六 01:xx 更新"分不出,仍报周六。
//      锚点并列取钟点早的(从中午排起:晚上的排在零点后的前面),不按 chg_log 顺序 —— 以前取先出现的,老笔滑出 35 天窗口时
//      锚点在两个钟点间来回换,标签一天一变(审查实锤 周一至四 ↔ 周二至五)。
//      同一部剧的笔都对齐到同一个钟点,不会因为检测一会儿 00:xx 一会儿 02:xx 分到两天;锚点取最早那端:资源站有新集
//      总在官方更新之后,往早靠更接近官方日期。盖住锚点的笔不到一半(什么钟点都有)→ 不对齐,各取窗口中点。
//   ② 同一天的几笔算一次更新。
//   ③ 第一次涨集到现在:不满 7 天不报(分不清日更和"每周这几天");满 7 不满 14 天,见过的星期几都算;满 14 天后只算出现 ≥2 次的
//      (一次的多半是补更/延迟)—— 日更也一样:最近 14 天里有、且够次数的星期几 ≥5 个才算日更(days 给出是哪几天)。
//   ④ clock = 锚点相对"更新日"北京零点的分钟数(更新日 + clock 分钟 ≈ 资源站上新时刻;过零点的 > 1440,最大 30:00):
//      前端拿它把北京时间的星期几/TMDB 日期换成用户本地日历(海外用户)。不对齐时不给。
//   ⑤ 一致性:报出的每个星期几,从第一个更新日到现在(该查到的都该查到了)它出现的那几天里至少更了 wdShare(75%);
//      报出的几天加起来至少盖住 coverShare(75%)的更新日。跟踪不满 14 天时两条都要 100%(每个星期几最多才出现两次,
//      一次没更就说明不了规律),日更还要有连着 dailyMin 天的更新。以前只数次数:随机哪几天更(每周两三天)、资源站隔两三天
//      补一批的,几乎总能凑出"周一、二、五至日"这种规律,还几天一变(审查实锤:随机日 87~93% 的天报出规律;现在 5~9%)。
//   ⑥ 断档(u:1 的笔:失败退避/停机后隔了 > chgGapMs 才看到涨集,只知道 (p, t] 里更过、不知道哪天):不参与锚点和更新日;
//      它盖住的日子(那天上新钟点 ~ +dueMs 跟断档有重叠)没看到 = 不知道更没更 → 不算漏更、不打断连更,次数门槛也相应放宽。
//      seen = 最后一次查成功的时刻:还没查成功过的日子同样不算(资源站正挂着时,不能把今晚算成"没更")。
//      以前只能当"没更":一次资源站夜里挂 6 小时,周一至四的剧就丢掉那个星期几、错一个多星期(审查实锤)
//   (模拟:真检查路径、检查相位随机,40 种排播 × 16 个种子 × 每天三次:规律剧标错 1497 → 646 → 327(⑥ 断档)/ 4.4 万个标签,
//    剩下的是上面说的跨零点分不出的;每个上新夜在第 2~4 周挂一次 6 小时的周一至四/五剧:错 364/448 → 0/1)
//   一个都没有 / 不一致 = 不规律 → null
function inferCadence(log, now, finished, seen) {
    if (finished || !Array.isArray(log)) return null;
    now = Number(now);
    if (!Number.isFinite(now)) return null;
    const ws = [], gaps = [];
    for (const e of log) {
        const t = e && Number(e.t);
        if (!Number.isFinite(t) || t <= 0 || t < now - CAD.winMs || t > now + HOUR) continue;
        let p = e && Number(e.p);
        if (e.u) { if (Number.isFinite(p) && p < t) gaps.push({ p, t }); continue; }   // 断档(⑥)
        if (!(Number.isFinite(p) && p < t && t - p <= CAD.maxWinMs)) p = t - CAD.defWinMs;
        ws.push({ p, t, s: bjClock(p) });
    }
    if (!ws.length) return null;
    // 锚点:每个窗口起点盖住几笔,取最多的;并列取钟点早的(从中午排起)
    const rank = (s) => mod(s - DAY / 2);
    let best = 0, x = 0;
    for (const a of ws) {
        let cover = 0;
        for (const b of ws) if (mod(a.s - b.s) < b.t - b.p) cover++;
        if (cover > best || (cover === best && rank(a.s) < rank(x))) { best = cover; x = a.s; }
    }
    const anchored = best >= 2 && best * 2 >= ws.length;
    // 每笔先归到离锚点最近的那天 d0(锚点那一刻 = d0 天北京零点 + x;切口在锚点 ±12h,同一部剧的笔不会因为离锚点差几十分钟就跨日)
    const d0 = [];
    let eve = false;
    for (const w of ws) {
        let d;
        if (anchored) {
            const len = w.t - w.p, off = mod(x - w.s);
            const at = off < len ? w.p + off : (off - len <= DAY - off ? w.t : w.p);
            d = Math.round((at + CAD.tzMs - x) / DAY);
            if (w.t + CAD.tzMs < d * DAY + CAD.labelLagMs) eve = true;   // 这笔在它那天零点后 labelLag 前就查到了(那一周按惯例就是前一天晚上的更新)
        } else d = Math.floor(((w.p + w.t) / 2 + CAD.tzMs - CAD.labelLagMs) / DAY);
        d0.push(d);
    }
    // 锚点相对"更新日"零点的位置:算前一天晚上的(见 ①)记成前一天的 24:xx
    const back = anchored && (x < CAD.labelLagMs || (eve && x < CAD.eveMaxMs));
    const xc = back ? x + DAY : x;
    const days = new Map();   // 日序号 → 这天最早一次的 t
    let last = 0, first = Infinity;
    ws.forEach((w, i) => {
        const d = back ? d0[i] - 1 : d0[i];
        if (!(days.get(d) <= w.t)) days.set(d, w.t);
        if (w.t > last) last = w.t;
        if (w.t < first) first = w.t;
    });
    if (days.size < CAD.minDays || now - last > CAD.staleMs || now - first < CAD.minSpanDays * DAY) return null;
    const short = now - first < CAD.shortSpanDays * DAY;
    const need = short ? 1 : 2;
    const cnt = new Map(), occ = new Map(), recent = new Set();
    let lo = Infinity, hi = -Infinity;
    for (const [d, t] of days) {
        const w = isoWeekday(d);
        cnt.set(w, (cnt.get(w) || 0) + 1);
        if (t >= now - CAD.dailyWinMs) recent.add(w);
        if (d < lo) lo = d;
        if (d > hi) hi = d;
    }
    // ⑤ 第一个更新日到"该更的都该查到了"的最后一天(那天的上新钟点 + dueMs 已过)之间,每个星期几出现了几天;最长连着几天有更新。
    //   只数到最后一个更新日不够:才更了周一、四、六,之后一个多星期没动静,周一也"每次都更了"
    //   "已过"按最后一次查成功的时刻 seen 算(⑥),没给 seen 按 now
    seen = Number(seen);
    const upto = Number.isFinite(seen) && seen > 0 && seen < now ? seen : now;
    const due = Math.floor((upto + CAD.tzMs - (anchored ? xc : DAY) - CAD.dueMs) / DAY);
    // d 天的"该看到"区间:上新钟点 ~ +dueMs(不对齐时 = 整个北京日);跟哪笔断档有重叠 = 这天不知道(⑥)
    const blind = (d) => {
        const a = d * DAY - CAD.tzMs + (anchored ? xc : 0), b = a + (anchored ? CAD.dueMs : DAY);
        return gaps.some(g => g.p < b && g.t > a);
    };
    const nb = new Map();   // 每个星期几有几天是不知道的
    const dr = Math.floor((now - CAD.dailyWinMs + CAD.tzMs) / DAY), vis = new Set(), dark = new Set();   // 最近 14 天里看得到 / 不知道的星期几
    let run = 0, longest = 0;
    for (let d = lo; d <= Math.max(hi, due); d++) {
        const w = isoWeekday(d);
        if (!days.has(d) && blind(d)) { nb.set(w, (nb.get(w) || 0) + 1); if (d >= dr) dark.add(w); continue; }
        if (d >= dr) vis.add(w);
        occ.set(w, (occ.get(w) || 0) + 1);
        run = days.has(d) ? run + 1 : 0;
        if (run > longest) longest = run;
    }
    const n = days.size;
    const share = short ? 1 : CAD.wdShare, cover = short ? 1 : CAD.coverShare;
    // 次数门槛 need 减掉这个星期几不知道的天数(至少 1):周二那周断档 → 跟踪满 14 天时周二只看得到 1 次,照样算
    const needOf = (w) => Math.max(1, need - (nb.get(w) || 0));
    const steady = (w) => cnt.get(w) >= needOf(w) && cnt.get(w) >= occ.get(w) * share - 1e-9;
    const covers = (wds) => { let k = 0; for (const w of wds) k += cnt.get(w) || 0; return k >= n * cover - 1e-9; };
    const asc = (a) => a.sort((u, v) => u - v);
    const out = (daily, wds) => {
        const o = { daily, days: wds, n, last_t: last };
        if (anchored) o.clock = Math.round(xc / 60e3);
        return o;
    };
    // 日更:最近 14 天里够稳的星期几 ≥ dailyMin 才算;报哪几天仍按次数(最近有、够 need 次)—— 日更剧每天都有一次
    //   检查失败退避就漏记一天,按"够稳"挑会把漏记过两次的那天说成不更(D123467)。
    //   最近 14 天里这个星期几一次都没看到、只有断档(⑥)的:没证据说它不更 → 跟着日更算(连着几周周二晚上都在断档里也不报 D134567)
    if ([...recent].filter(steady).length >= CAD.dailyMin && (!short || longest >= CAD.dailyMin)) {
        const dd = [1, 2, 3, 4, 5, 6, 7].filter(w => recent.has(w) ? cnt.get(w) >= needOf(w) : (dark.has(w) && !vis.has(w)));
        if (covers(dd)) return out(true, dd);
    }
    const wk = asc([...cnt.keys()].filter(steady));
    return wk.length && covers(wk) ? out(false, wk) : null;
}
// 详情响应 → list 数组;不认识 → null(当请求失败)
function parseDetail(data) {
    if (typeof data === 'string') {
        try { data = JSON.parse(data.replace(/^﻿/, '')); } catch (e) { return null; }
    }
    return data && Array.isArray(data.list) ? data.list : null;
}
const favIdOf = (name, sig) => sig ? name + '|w:' + sig : name;
function normSource(x) {
    if (!x || typeof x !== 'object') return null;
    const site_key = clean(x.site_key, 64), vod_id = clean(x.vod_id, 64);
    if (!site_key || !vod_id) return null;
    return { site_key, vod_id, site_name: clean(x.site_name, DEF.siteNameMax) };
}
// 前端交来的条目 → 瘦身后的 data;checkSource 必须是能查更新的 maccms 站(siteOk),否则从 sources 里挑第一条能用的
function normItem(raw, siteOk) {
    if (!raw || typeof raw !== 'object') return null;
    const name = clean(raw.name, DEF.nameMax);
    if (!name) return null;
    const workSig = clean(raw.workSig, DEF.sigMax);
    let poster = clean(raw.poster, DEF.posterMax);
    if (poster && !/^(https?:\/\/|\/)/i.test(poster)) poster = '';
    const sources = [];
    const seen = new Set();
    for (const x of (Array.isArray(raw.sources) ? raw.sources : []).slice(0, 50)) {
        const s = normSource(x);
        if (!s) continue;
        const k = s.site_key + '|' + s.vod_id;
        if (seen.has(k)) continue;
        seen.add(k);
        sources.push(s);
        if (sources.length >= DEF.maxSources) break;
    }
    const can = (s) => !!s && siteKeyOk(s.site_key) && VID_RE.test(s.vod_id) && !!siteOk(s.site_key);
    let checkSource = normSource(raw.checkSource);
    if (!can(checkSource)) checkSource = sources.find(can) || null;
    const added = intIn(raw.addedEpCount, 0, 100000);
    return {
        name, poster, workSig, workLabel: clean(raw.workLabel, DEF.labelMax),
        checkSource, sources, addedEpCount: added == null ? 0 : added, kind: 'vod'
    };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_favorites (
    user_token TEXT NOT NULL, fav_id TEXT NOT NULL, data TEXT NOT NULL, added_at INTEGER, updated_at INTEGER,
    seen_count INTEGER NOT NULL DEFAULT 0, check_site TEXT, check_vid TEXT,
    PRIMARY KEY (user_token, fav_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_check ON user_favorites(check_site, check_vid);
CREATE TABLE IF NOT EXISTS fav_watch (
    site_key TEXT NOT NULL, vod_id TEXT NOT NULL, ep_count INTEGER, latest_ep TEXT, remarks TEXT, finished INTEGER,
    checked_at INTEGER, changed_at INTEGER, next_check INTEGER, last_wanted INTEGER, fails INTEGER NOT NULL DEFAULT 0,
    max_ep INTEGER, miss INTEGER NOT NULL DEFAULT 0, src TEXT NOT NULL DEFAULT 'anon', total INTEGER, chg_log TEXT,
    PRIMARY KEY (site_key, vod_id)
);
CREATE INDEX IF NOT EXISTS idx_fw_next ON fav_watch(next_check);
CREATE INDEX IF NOT EXISTS idx_fw_wanted ON fav_watch(last_wanted);
`;
// 被用户收藏引用的跟踪行
const REF = 'EXISTS (SELECT 1 FROM user_favorites f WHERE f.check_site = w.site_key AND f.check_vid = w.vod_id)';

function createFavorites(deps) {
    deps = deps || {};
    const C = Object.assign({}, DEF, deps.opts || {});
    const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;
    const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise(r => setTimeout(r, ms));
    const dbOf = () => { try { return deps.db ? (deps.db() || null) : null; } catch (e) { return null; } };
    const enabled = () => { try { return !!dbOf() && (deps.enabled ? !!deps.enabled() : true); } catch (e) { return false; } };
    const checkEnabled = () => { try { return enabled() && (deps.checkEnabled ? !!deps.checkEnabled() : true); } catch (e) { return false; } };
    const tokenOk = (t) => { try { return typeof t === 'string' && !!t && !!(deps.tokenOk && deps.tokenOk(t)); } catch (e) { return false; } };
    // 集数变多时给谁发通知(后台用,接口鉴权不用它);没注入 = 同 tokenOk。server.js 里机场令牌不在内存表也算(重启后不断档)
    const notifyOk = typeof deps.notifyOk === 'function'
        ? (t) => { try { return typeof t === 'string' && !!t && !!deps.notifyOk(t); } catch (e) { return false; } }
        : tokenOk;
    const isBanned = (t) => { try { return !!(deps.isBanned && deps.isBanned(t)); } catch (e) { return false; } };
    const adminOk = (req) => { try { return !!(deps.adminAuthed && deps.adminAuthed(req)); } catch (e) { return false; } };
    const ipOf = (req) => { try { return String(deps.ipKey ? deps.ipKey(req) : (req.ip || '')); } catch (e) { return ''; } };
    // 配了访问密码(私密站)→ 匿名 status 也要有效令牌,新登记预算按令牌算;依赖缺省 = 公开站(按 IP)
    const authRequired = () => { try { return !!(deps.authRequired && deps.authRequired()); } catch (e) { return true; } };
    // 能查更新的站:key → site(只 maccms;规则站/没 api 的不算)
    const mapOf = (list) => {
        const m = new Map();
        for (const s of (Array.isArray(list) ? list : [])) {
            if (s && typeof s.key === 'string' && typeof s.api === 'string' && /^https?:\/\//i.test(s.api) && !/m3u8/i.test(s.api) && !m.has(s.key)) m.set(s.key, s);
        }
        return m;
    };
    // 请求路径用(同步):每次调用现取,db.json 改了立刻生效
    const siteMap = () => {
        try { return mapOf(deps.sites ? deps.sites() || [] : []); } catch (e) { warn('sites', e); return new Map(); }
    };
    // 后台检查用(可异步):deps.loadSites 在 REMOTE_DB_URL 还没加载时会先拉远程配置;拉不到/空 → null(本轮整个跳过,不碰任何行)。
    //   以前直接用 getDB():重启后还没人打开过首页时它读的是本地模板,所有到期行都被当成"站点已删除"推迟 24h(审查实锤)
    async function roundSites() {
        let list;
        try { list = deps.loadSites ? await deps.loadSites() : (deps.sites ? deps.sites() : null); }
        catch (e) { warn('sites', e); return null; }
        if (!Array.isArray(list)) return null;
        const m = mapOf(list);
        return m.size ? m : null;
    }

    const warnAt = {};
    const warn = (tag, e) => { const t = Date.now(); if (!warnAt[tag] || t - warnAt[tag] > 60e3) { warnAt[tag] = t; console.warn('[Favorites] ' + tag + ':', e && e.message || e); } };

    const inited = new WeakSet();
    let stmtDb = null;
    const stmts = new Map();
    const q = (d, sql) => {
        if (d !== stmtDb) { stmts.clear(); stmtDb = d; }
        let s = stmts.get(sql);
        if (!s) { s = d.prepare(sql); stmts.set(sql, s); }
        return s;
    };
    // 幂等迁移:早期建的 fav_watch 没有 max_ep(已通知过的最高集数)/ miss(连续查无此片次数)
    function migrate(d) {
        const cols = d.prepare('PRAGMA table_info(fav_watch)').all().map(c => c.name);
        if (!cols.includes('max_ep')) {
            try { d.exec('ALTER TABLE fav_watch ADD COLUMN max_ep INTEGER'); } catch (e) { /* 并发迁移:列已存在 */ }
        }
        if (!cols.includes('miss')) {
            try { d.exec('ALTER TABLE fav_watch ADD COLUMN miss INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* 同上 */ }
        }
        // src:这行是谁登记的('fav' 服务器收藏 / 'anon' 匿名 status)。老行一律当 'anon'(受 24h 保护,保守)
        if (!cols.includes('src')) {
            try { d.exec("ALTER TABLE fav_watch ADD COLUMN src TEXT NOT NULL DEFAULT 'anon'"); } catch (e) { /* 同上 */ }
        }
        // 追更日历:total(vod_total,只存可信的)/ chg_log(最近的涨集记录)。老行都是 NULL = 不知道,下次涨集才开始记
        if (!cols.includes('total')) {
            try { d.exec('ALTER TABLE fav_watch ADD COLUMN total INTEGER'); } catch (e) { /* 同上 */ }
        }
        if (!cols.includes('chg_log')) {
            try { d.exec('ALTER TABLE fav_watch ADD COLUMN chg_log TEXT'); } catch (e) { /* 同上 */ }
        }
    }
    function getDb() {
        const d = dbOf();
        if (d && !inited.has(d)) { d.exec(SCHEMA); migrate(d); inited.add(d); }
        return d;
    }
    setImmediate(() => { try { if (enabled()) getDb(); } catch (e) { warn('schema', e); } });

    // ---------- 登记跟踪 ----------
    // 每个来源每小时新登记预算(固定窗口;Map 有上限)。来源键:'t:<令牌>' 或 'ip:<IP>'
    const ipNew = new Map();
    function budgetOf(key, now) {
        let e = ipNew.get(key);
        if (!e || now - e.start >= HOUR) {
            if (!e && ipNew.size >= C.ipMapMax) ipNew.clear();
            e = { start: now, n: 0 };
            ipNew.set(key, e);
        }
        return e;
    }
    // pairs: [{site_key, vod_id}](已校验)。新行 next_check=now(下一轮就查);已有行只续 last_wanted。返回新登记数
    //   mayEvict=false(匿名 status):没人收藏的行已到 maxWatch − anonReserve(或表满)→ 不登记,也不挤任何行;
    //     (这个 id 恰好被某个服务器收藏引用、只是行丢了 → 按收藏行算,不占匿名那块)
    //   mayEvict=true(服务器收藏):任何空位都能用;表全满 → 挤掉"没人收藏、且 ≥favEvictIdleMs 没人要"的行里最久没人要的一个,
    //     没有这种行就不登记(收藏本身照常成功,列表 GET 时会再试)。被收藏引用的行永不被挤
    function register(d, pairs, key, mayEvict) {
        if (!pairs.length) return 0;
        const now = nowFn();
        const b = budgetOf(key || '', now);
        const ins = q(d, 'INSERT OR IGNORE INTO fav_watch (site_key, vod_id, next_check, last_wanted, fails, src) VALUES (?, ?, ?, ?, 0, ?)');
        const touch = q(d, 'UPDATE fav_watch SET last_wanted = ? WHERE site_key = ? AND vod_id = ?');
        const has = q(d, 'SELECT 1 FROM fav_watch WHERE site_key = ? AND vod_id = ?');
        const count = q(d, 'SELECT COUNT(*) n FROM fav_watch');
        const unrefCount = q(d, `SELECT COUNT(*) n FROM fav_watch w WHERE NOT ${REF}`);
        const isRef = q(d, 'SELECT 1 FROM user_favorites WHERE check_site = ? AND check_vid = ? LIMIT 1');
        const victim = q(d, `SELECT w.rowid id FROM fav_watch w WHERE NOT ${REF} AND COALESCE(w.last_wanted, 0) <= ? ORDER BY w.last_wanted ASC LIMIT 1`);
        // 没人收藏的行超过匿名那块(说明多出来的是服务器收藏留下的孤行,不是本机收藏用户的)→ 先挤这种孤行,不看多新
        const favOrphan = q(d, `SELECT w.rowid id FROM fav_watch w WHERE w.src = 'fav' AND NOT ${REF} ORDER BY w.last_wanted ASC LIMIT 1`);
        const delRow = q(d, 'DELETE FROM fav_watch WHERE rowid = ?');
        const anonCap = Math.max(0, C.maxWatch - Math.max(0, C.anonReserve));
        let added = 0;
        d.transaction(() => {
            let n = count.get().n;
            let unref = null;   // 没人收藏的行数:真要新登记匿名行时才数(多数 status 只是续期已有行)
            for (const p of pairs) {
                if (has.get(p.site_key, p.vod_id)) { touch.run(now, p.site_key, p.vod_id); continue; }
                if (b.n >= C.newPerIpHour) continue;   // 超预算:这次先不登记(用户的收藏下次 GET 会再补登)
                const ref = !!isRef.get(p.site_key, p.vod_id);
                if (!mayEvict && !ref) {
                    if (unref == null) unref = unrefCount.get().n;
                    if (unref >= anonCap) continue;
                }
                if (n >= C.maxWatch) {
                    if (!mayEvict) continue;
                    if (unref == null) unref = unrefCount.get().n;
                    const v = (unref > anonCap && favOrphan.get()) || victim.get(now - C.favEvictIdleMs);
                    if (!v) continue;
                    delRow.run(v.id);
                    n--;
                    unref--;
                }
                if (ins.run(p.site_key, p.vod_id, now, now, mayEvict ? 'fav' : 'anon').changes) { b.n++; added++; n++; if (!ref && unref != null) unref++; }
            }
        })();
        return added;
    }
    // 服务器收藏登记的行,最后一个收藏它的人删掉后立刻删行:否则 收藏/取消 反复刷就能把留给服务器收藏的 1000 行
    //   全变成"没人收藏"的孤行,再用免费的匿名续期让它们永远不满 24h → 之后所有人的新收藏都登记不上(第三轮审查实锤)。
    //   匿名 status 登记的行('anon')不删 —— 本机收藏用户可能还在等它;同一部片本机收藏用户下次 status 会按匿名重新登记。
    function dropFavOrphan(d, site, vid) {
        if (!site || !vid) return;
        try {
            q(d, `DELETE FROM fav_watch WHERE site_key = ? AND vod_id = ? AND src = 'fav'
                AND NOT EXISTS (SELECT 1 FROM user_favorites f WHERE f.check_site = ? AND f.check_vid = ?)`).run(site, vid, site, vid);
        } catch (e) { warn('orphan', e); }
    }
    // 兜底:表比上限还大(站长调小了上限等)时保守削减,绝不动有人收藏或 7 天内有人要的行
    function trimOver(d) {
        try {
            const n = q(d, 'SELECT COUNT(*) n FROM fav_watch').get().n;
            if (n <= C.maxWatch) return 0;
            return q(d, `DELETE FROM fav_watch WHERE rowid IN (SELECT w.rowid FROM fav_watch w WHERE COALESCE(w.last_wanted, 0) < ? AND NOT ${REF} ORDER BY w.last_wanted ASC LIMIT ?)`)
                .run(nowFn() - C.evictIdleMs, n - C.maxWatch).changes;
        } catch (e) { warn('evict', e); return 0; }
    }
    // 每轮顺手清 staleAnonMs(14 天)没人再问过的、没人收藏的行(本机收藏删了/设备不用了/收藏删掉留下的;有人收藏的不清)
    function pruneStale(d) {
        try { q(d, `DELETE FROM fav_watch WHERE rowid IN (SELECT w.rowid FROM fav_watch w WHERE w.last_wanted < ? AND NOT ${REF})`).run(nowFn() - C.staleAnonMs); }
        catch (e) { warn('prune', e); }
    }
    // total / cadence 只在知道时才带(回包小;没有 = 不知道)。cadence 读的时候现算:"最近 35 天""停更 14 天"都相对现在。
    //   集数已到总集数(11/11)= 这季播完了:很多站完结后备注还是「第11集」「更新至第11集」(finished 认不出),
    //   不能再报"通常每周四更新"(审查实锤:完结后 14 天里一直报)。total 只在可信时才有(不是 0/占位/综艺,见 parseTotal/datedEps)
    const statusOf = (w, now) => {
        if (!w || w.checked_at == null || w.ep_count == null) return null;
        const s = { ep_count: w.ep_count, latest_ep: w.latest_ep || '', remarks: w.remarks || '', finished: !!w.finished, changed_at: w.changed_at || null, checked_at: w.checked_at };
        if (w.total > 0 && w.total >= w.ep_count && !datedEps(w.latest_ep, w.remarks)) s.total = w.total;   // 综艺的旧值(修复前存下的)也不报
        const done = w.finished || (s.total > 0 && w.ep_count >= s.total);
        const cad = done ? null : inferCadence(parseLog(w.chg_log), now, false, w.checked_at);
        if (cad) s.cadence = cad;
        return s;
    };

    // ---------- 用户收藏 ----------
    const touchAt = new Map();
    function list(token) {
        const d = getDb();
        const rows = q(d, `SELECT f.fav_id, f.data, f.added_at, f.seen_count, f.check_site, f.check_vid,
                w.ep_count, w.latest_ep, w.remarks, w.finished, w.changed_at, w.checked_at, w.total, w.chg_log
                FROM user_favorites f LEFT JOIN fav_watch w ON w.site_key = f.check_site AND w.vod_id = f.check_vid
                WHERE f.user_token = ? ORDER BY f.added_at DESC, f.rowid DESC LIMIT ?`).all(token, C.maxFav * 2);
        // 续期 last_wanted(并把被淘汰掉的补登回来):每 token 5 分钟最多一次
        const now = nowFn();
        const last = touchAt.get(token);
        if (!last || now - last >= C.touchMs) {
            if (touchAt.size >= C.touchMapMax) touchAt.clear();
            touchAt.set(token, now);
            const sites = siteMap();
            const pairs = rows.filter(r => r.check_site && r.check_vid && sites.has(r.check_site)).map(r => ({ site_key: r.check_site, vod_id: r.check_vid }));
            try { register(d, pairs, 't:' + token, true); } catch (e) { warn('touch', e); }
        }
        const items = rows.map(r => {
            let data = {};
            try { data = JSON.parse(r.data) || {}; } catch (e) { }
            const status = statusOf(r, now);
            const seen = r.seen_count || 0;
            return { fav_id: r.fav_id, data, added_at: r.added_at, seen_count: seen, status, has_update: !!status && status.ep_count > seen };
        });
        return { enabled: true, limit: C.maxFav, items };
    }
    function add(token, raw) {
        const d = getDb();
        const sites = siteMap();
        const item = normItem(raw, (k) => sites.has(k));
        if (!item) return { status: 400, body: { ok: false, error: 'item' } };
        const fav_id = favIdOf(item.name, item.workSig);
        const now = nowFn();
        let out = null;
        const cs = item.checkSource;
        d.transaction(() => {
            const old = q(d, 'SELECT seen_count, check_site, check_vid FROM user_favorites WHERE user_token = ? AND fav_id = ?').get(token, fav_id);
            if (!old && q(d, 'SELECT COUNT(*) n FROM user_favorites WHERE user_token = ?').get(token).n >= C.maxFav) {
                out = { status: 200, body: { ok: false, error: 'limit', limit: C.maxFav } };
                return;
            }
            // 已看集数是相对"检查线路"的;换了线路(各站集数不一样)旧值作废,按这次给的重来
            const sameLine = old && old.check_site === (cs ? cs.site_key : null) && old.check_vid === (cs ? cs.vod_id : null);
            let seen = Math.max(sameLine ? old.seen_count || 0 : 0, item.addedEpCount || 0);
            // 前端没给集数:用服务器已知的当前集数当基线,否则一收藏就亮"有更新"
            if (!seen && cs) {
                const w = q(d, 'SELECT ep_count FROM fav_watch WHERE site_key = ? AND vod_id = ?').get(cs.site_key, cs.vod_id);
                if (w && w.ep_count != null) seen = w.ep_count;
            }
            q(d, `INSERT INTO user_favorites (user_token, fav_id, data, added_at, updated_at, seen_count, check_site, check_vid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_token, fav_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
                    seen_count = excluded.seen_count, check_site = excluded.check_site, check_vid = excluded.check_vid`)
                .run(token, fav_id, JSON.stringify(item), now, now, seen, cs ? cs.site_key : null, cs ? cs.vod_id : null);
            if (old && !sameLine) dropFavOrphan(d, old.check_site, old.check_vid);   // 换了检查线路:旧线路那行可能没人要了
            out = { status: 200, body: { ok: true, fav_id } };
        })();
        if (out.body.ok && cs) { try { register(d, [cs], 't:' + token, true); } catch (e) { warn('register', e); } }
        return out;
    }
    function remove(token, favId) {
        const d = getDb();
        if (typeof favId !== 'string' || !favId) return { status: 400, body: { ok: false, error: 'fav_id' } };
        let n = 0;
        d.transaction(() => {
            const old = q(d, 'SELECT check_site, check_vid FROM user_favorites WHERE user_token = ? AND fav_id = ?').get(token, favId);
            n = q(d, 'DELETE FROM user_favorites WHERE user_token = ? AND fav_id = ?').run(token, favId).changes;
            if (n && old) dropFavOrphan(d, old.check_site, old.check_vid);
        })();
        return { status: 200, body: { ok: true, removed: n } };
    }
    // count 缺省 = 服务器已知的当前集数(直接清红点)
    function seenSet(token, favId, count) {
        const d = getDb();
        if (typeof favId !== 'string' || !favId) return { status: 400, body: { ok: false, error: 'fav_id' } };
        const r = q(d, `SELECT f.seen_count, w.ep_count FROM user_favorites f LEFT JOIN fav_watch w ON w.site_key = f.check_site AND w.vod_id = f.check_vid
                WHERE f.user_token = ? AND f.fav_id = ?`).get(token, favId);
        if (!r) return { status: 200, body: { ok: false, error: 'not_found' } };
        let c = intIn(count, 0, 100000);
        if (c == null) c = r.ep_count != null ? r.ep_count : 0;
        const seen = Math.max(r.seen_count || 0, c);
        if (seen !== r.seen_count) q(d, 'UPDATE user_favorites SET seen_count = ?, updated_at = ? WHERE user_token = ? AND fav_id = ?').run(seen, nowFn(), token, favId);
        return { status: 200, body: { ok: true, seen_count: seen } };
    }
    // 本机收藏(没登录/没开同步)查更新:登记进跟踪表(表满不挤别人)+ 返回已知状态。key = 新登记预算的来源键
    function anonStatus(items, key) {
        const d = getDb();
        const sites = siteMap();
        const pairs = [];
        const seen = new Set();
        for (const x of (Array.isArray(items) ? items : []).slice(0, C.statusMax)) {
            if (!x || typeof x !== 'object') continue;
            const site_key = typeof x.site_key === 'string' ? x.site_key : '', vod_id = x.vod_id == null ? '' : String(x.vod_id);
            if (!siteKeyOk(site_key) || !VID_RE.test(vod_id) || !sites.has(site_key)) continue;
            const k = site_key + '|' + vod_id;
            if (seen.has(k)) continue;
            seen.add(k);
            pairs.push({ site_key, vod_id });
        }
        register(d, pairs, key, false);
        const status = Object.create(null);
        const get = q(d, 'SELECT ep_count, latest_ep, remarks, finished, changed_at, checked_at, total, chg_log FROM fav_watch WHERE site_key = ? AND vod_id = ?');
        const now = nowFn();
        for (const p of pairs) {
            const s = statusOf(get.get(p.site_key, p.vod_id), now);
            if (s) { delete s.checked_at; status[p.site_key + '|' + p.vod_id] = s; }
        }
        return { enabled: true, status };
    }

    // ---------- 后台检查 ----------
    let running = null;
    function runRound() {
        if (!running) running = round().catch(e => { warn('round', e); return { error: String(e && e.message || e) }; }).finally(() => { running = null; });
        return running;
    }
    async function round() {
        const sum = { due: 0, requests: 0, checked: 0, failed: 0, changed: 0, pushed: 0, skipped: 0, dropped: 0 };
        if (!checkEnabled()) return sum;
        const d = getDb();
        if (!d) return sum;
        // 站点列表没加载到(远程配置拉不到/空):整轮跳过,一行都不碰 —— 不能把所有到期行当"站点已删除"推迟一天
        const sites = await roundSites();
        if (!sites) { sum.no_sites = true; return sum; }
        const t0 = nowFn();
        // 取全部到期行(表最多 maxWatch 行,很小):只取"预算能查完的条数"会按 site_key 截断,排在后面的站永远轮不到
        const due = q(d, 'SELECT site_key, vod_id, ep_count, latest_ep, remarks, finished, fails, max_ep, miss, checked_at, total, chg_log FROM fav_watch WHERE next_check <= ? ORDER BY next_check, site_key, vod_id LIMIT ?')
            .all(t0, Math.max(C.maxWatch * 2, C.maxReqPerRound * C.batchIds));
        sum.due = due.length;
        // 按站分组;站点已不可用的推迟一天
        const bySite = new Map();
        const later = q(d, 'UPDATE fav_watch SET next_check = ? WHERE site_key = ? AND vod_id = ?');
        d.transaction(() => {
            for (const r of due) {
                if (!sites.has(r.site_key)) { later.run(t0 + C.badSiteMs, r.site_key, r.vod_id); sum.skipped++; continue; }
                let a = bySite.get(r.site_key);
                if (!a) { a = []; bySite.set(r.site_key, a); }
                a.push(r);
            }
        })();
        // 每站切批(≤20 id),全站请求预算按站轮转分配:一个大站不会把别的站饿死
        const queues = [];
        for (const [key, rows] of bySite) {
            const batches = [];
            for (let i = 0; i < rows.length; i += C.batchIds) batches.push(rows.slice(i, i + C.batchIds));
            queues.push({ site: sites.get(key), batches, take: [] });
        }
        let budget = C.maxReqPerRound;
        for (let i = 0; budget > 0; i++) {
            let any = false;
            for (const qd of queues) if (i < qd.batches.length && budget > 0) { qd.take.push(qd.batches[i]); budget--; any = true; }
            if (!any) break;
        }
        const changes = [];
        let next = 0;
        // 实际出网请求计数:每批先占 1 个;fetchJson 直连失败想走代理重试时再调 ctl.extra() 占 1 个(占不到就不重试)。
        //   以前每批只记 1 个,代理对比/重试让一轮实际可达 ~120 个请求
        let used = 0;
        const reserve = () => { if (used >= C.maxReqPerRound) return false; used++; sum.requests++; return true; };
        const worker = async () => {
            while (next < queues.length) {
                const qd = queues[next++];
                for (let i = 0; i < qd.take.length; i++) {
                    if (!reserve()) return;   // 预算被代理重试占完:剩下的保持到期,下一轮最先查
                    if (i > 0) await sleep(C.siteGapMs);
                    await checkBatch(d, qd.site, qd.take[i], sum, changes, reserve);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, C.concurrency) }, worker));
        // 集数变多 → 给收藏了它的用户发推送(逐个发,失败只记日志)
        for (const c of changes) sum.pushed += await notify(d, c);
        trimOver(d);
        pruneStale(d);
        return sum;
    }
    async function checkBatch(d, site, rows, sum, changes, reserve) {
        const ids = rows.map(r => r.vod_id);
        const url = site.api + '?ac=detail&ids=' + ids.map(encodeURIComponent).join(',');
        let list = null;
        try { list = parseDetail(await deps.fetchJson(url, site.key, C.timeoutMs, { extra: reserve })); }
        catch (e) { warn('fetch ' + site.key, e); list = null; }
        const now = nowFn();
        const fail = q(d, 'UPDATE fav_watch SET fails = ?, next_check = ?, miss = ? WHERE site_key = ? AND vod_id = ?');
        // 请求失败:退避,查无次数不动(没拿到确定答复,既不算一次查无,也不清零)
        const backoff = (r, miss) => { const f = (r.fails || 0) + 1; fail.run(f, now + C.failBackoff[Math.min(f, C.failBackoff.length) - 1], miss, r.site_key, r.vod_id); sum.failed++; };
        if (!list) { d.transaction(() => rows.forEach(r => backoff(r, r.miss || 0)))(); return; }
        const byId = new Map();
        for (const v of list) if (v && v.vod_id != null) byId.set(String(v.vod_id), v);
        // 这批要的 id 一个都没回来(站点过载/维护时常回 {code:1,list:[]}):说明不了任何一部片子被删了 → 当请求失败,
        //   退避、查无次数不动。"查无此片"只在同一个回包里有这批别的 id、唯独没有它时才记(单 id 的批次因此永远不记查无,只退避)
        if (!rows.some(r => byId.has(String(r.vod_id)))) {
            warn('empty ' + site.key, '详情接口没返回这批任何一个 id,按请求失败退避');
            d.transaction(() => rows.forEach(r => backoff(r, r.miss || 0)))();
            return;
        }
        const upd = q(d, `UPDATE fav_watch SET ep_count = ?, latest_ep = ?, remarks = ?, finished = ?, checked_at = ?,
                changed_at = COALESCE(?, changed_at), next_check = ?, fails = 0, max_ep = ?, miss = 0, total = ?, chg_log = COALESCE(?, chg_log)
                WHERE site_key = ? AND vod_id = ?`);
        const baseline = q(d, 'UPDATE user_favorites SET seen_count = ? WHERE check_site = ? AND check_vid = ? AND seen_count = 0');
        const referenced = q(d, 'SELECT 1 FROM user_favorites WHERE check_site = ? AND check_vid = ? LIMIT 1');
        const drop = q(d, 'DELETE FROM fav_watch WHERE site_key = ? AND vod_id = ?');
        d.transaction(() => {
            for (const r of rows) {
                const v = byId.get(String(r.vod_id));
                if (!v) {
                    // 请求成功但站上查无此片(下架/换 id/压根是灌进来的垃圾 id):连续 missDrop 次 → 没人收藏就删行,
                    //   有人收藏的不删(用户还在等),改成 missRefMs 后再看;不到次数先按失败退避
                    const m = (r.miss || 0) + 1;
                    if (m < C.missDrop) { backoff(r, m); continue; }
                    if (!referenced.get(r.site_key, r.vod_id)) { drop.run(r.site_key, r.vod_id); sum.dropped++; continue; }
                    fail.run((r.fails || 0) + 1, now + C.missRefMs, m, r.site_key, r.vod_id);
                    sum.failed++;
                    continue;
                }
                const s = vodStatus(v);
                // 已通知最高集数(老库迁移来的行 max_ep 为空 → 用上次存的集数)。只有超过它才算"更新了"、才推送:
                //   资源站重新采集/换源时集数会 12→11→12 来回跳,只比上次存的集数会把同一集反复推给所有人
                const hw = Math.max(r.max_ep || 0, r.ep_count || 0);
                const known = hw > 0;   // 以前查到过正数集数;0/空只当"没信息",第一次查到正数才作基线(不推送)
                const empty = s.ep_count <= 0 && (r.ep_count || 0) > 0;   // 这次播放列表是空的:绝不拿 0 覆盖已知集数
                const ep = empty ? r.ep_count : s.ep_count;
                const latest = empty ? (r.latest_ep || '') : s.latest_ep;
                const grew = known && s.ep_count > hw;
                const diff = grew || (r.ep_count != null && (latest !== (r.latest_ep || '') || s.remarks !== (r.remarks || '')));
                const wait = diff ? C.changedMs : (s.finished ? C.finishedMs : C.ongoingMs);
                // 追更日历:真涨过 max_ep 才记一笔(来回跳、第一次基线都不记)。
                //   一笔 = {t:这次查到, ep, p:上一次查到}(新集是在 (p, t] 里上的,inferCadence 按它对齐钟点)。
                //   上次查到太久以前的(失败退避/停机后,> chgGapMs)不知道是哪天更新的 → 记成断档 {…, u:1}:不拿它定更新日,
                //   只告诉 inferCadence 这段时间没看见(以前干脆不记 → 那几天被当成"没更",一次资源站夜里挂掉就丢一个星期几,审查实锤)。
                //   同一次更新又涨了(6h 内又上一集)并进上一笔(t/p 留最早那次,离真实更新最近;ep 记最新);35 天窗口外的丢掉
                let log = null;
                if (grew && r.checked_at != null) {
                    const gap = now - r.checked_at > C.chgGapMs;
                    const a = parseLog(r.chg_log).filter(x => x && Number(x.t) > now - CAD.winMs - DAY && Number(x.t) <= now);
                    const p = a[a.length - 1];
                    if (p && !gap && sameRelease(Number(p.t), now)) p.ep = s.ep_count;
                    else a.push(gap ? { t: now, ep: s.ep_count, p: r.checked_at, u: 1 } : { t: now, ep: s.ep_count, p: r.checked_at });
                    log = JSON.stringify(a.slice(-C.chgLogMax));
                }
                // 综艺(按期数/日期编号):vod_total 是占位,这次的不认、以前存的也不沿用
                const dated = datedEps(latest, s.remarks);
                // 集数回落照存(角标可能暂时消失),但 max_ep 只升不降:回到已通知过的集数不会再推
                upd.run(ep, latest, s.remarks, s.finished, now, grew ? now : null, now + wait, Math.max(hw, s.ep_count),
                    dated ? null : pickTotal(s.total, r.total, ep, s.finished), log, r.site_key, r.vod_id);
                if (!known && s.ep_count > 0) baseline.run(s.ep_count, r.site_key, r.vod_id);   // 第一次查到:没集数基线的收藏以此为准
                if (grew) { sum.changed++; changes.push({ site_key: r.site_key, vod_id: r.vod_id, ep_count: s.ep_count, latest_ep: s.latest_ep }); }
                sum.checked++;
            }
        })();
    }
    async function notify(d, c) {
        if (!deps.push) return 0;
        let rows = [];
        try { rows = q(d, 'SELECT user_token, fav_id, data, seen_count FROM user_favorites WHERE check_site = ? AND check_vid = ?').all(c.site_key, c.vod_id); }
        catch (e) { warn('notify', e); return 0; }
        const done = new Set();
        let n = 0;
        for (const r of rows) {
            // 令牌已失效(notifyOk 不认:如独立密码被删/改)或被封禁 → 不推(订阅可能已经换了人用这台设备)
            if (done.has(r.user_token) || (r.seen_count || 0) >= c.ep_count || !notifyOk(r.user_token) || isBanned(r.user_token)) continue;
            done.add(r.user_token);
            let data = {};
            try { data = JSON.parse(r.data) || {}; } catch (e) { }
            const name = data.name || r.fav_id;
            let url = '/?play=' + encodeURIComponent(name) + (c.latest_ep ? '&ep=' + encodeURIComponent(c.latest_ep) : '');
            if (data.workSig) url += '&w=' + encodeURIComponent(data.workSig);
            try {
                const res = await deps.push(r.user_token, { title: '《' + name + '》更新了', body: '更新至 ' + (c.latest_ep || ('第' + c.ep_count + '集')), url, tag: 'fav:' + r.fav_id });
                if (res && res.sent) n++;
            } catch (e) { warn('push', e); }
        }
        return n;
    }
    // 定时器放到下一轮事件循环再判开关:注册时 server.js 还没执行完,deps 里的 REQ_DB_OK 等还在 TDZ
    let timers = [], stopped = false;
    function start() {
        stopped = false;
        setImmediate(() => {
            if (stopped || timers.length || !checkEnabled()) return;
            const a = setTimeout(() => { runRound(); }, C.firstDelayMs);
            const b = setInterval(() => { runRound(); }, C.roundMs);
            if (a.unref) a.unref();
            if (b.unref) b.unref();
            timers = [a, b];
        });
    }
    function stop() { stopped = true; for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

    // ---------- 路由 ----------
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    const bodyOf = (req) => (req.body && typeof req.body === 'object') ? req.body : {};
    // 鉴权(同历史同步:PASSWORD_HASH_MAP 自有属性 + 未封禁);失败已回包 → true
    function guard(res, token) {
        if (!tokenOk(token)) { res.status(401).json({ ok: false, error: 'Invalid token' }); return true; }
        if (isBanned(token)) { res.status(403).json({ ok: false, error: 'banned', banned: true }); return true; }
        return false;
    }
    const wrap = (fn) => (req, res) => {
        noStore(res);
        try { fn(req, res); }
        catch (e) { warn('route', e); if (!res.headersSent) res.status(500).json({ ok: false, error: 'Database error' }); }
    };
    function registerRoutes(app) {
        app.get('/api/favorites', wrap((req, res) => {
            if (!enabled()) return res.json({ enabled: false, limit: C.maxFav, items: [] });
            const token = String((req.query && req.query.token) || '');
            if (guard(res, token)) return;
            res.json(list(token));
        }));
        const post = (fn) => wrap((req, res) => {
            if (!enabled()) return res.json({ ok: false, enabled: false });
            const b = bodyOf(req);
            if (guard(res, b.token)) return;
            const r = fn(b, req);
            res.status(r.status).json(r.body);
        });
        app.post('/api/favorites/add', post((b) => add(b.token, b.item)));
        app.post('/api/favorites/remove', post((b) => remove(b.token, b.fav_id)));
        app.post('/api/favorites/seen', post((b) => seenSet(b.token, b.fav_id, b.count)));
        const statusHandlers = deps.statusLimiter ? [deps.statusLimiter] : [];
        // 私密站(配了访问密码):要有效令牌(body.token,也认 ?token=),新登记预算按令牌算 —— IP 来自可伪造的 CF-Connecting-IP 等头,
        //   换个头就是新预算;公开站没有令牌可认,只能按 IP(反正表满后匿名登记也挤不掉任何行)
        app.post('/api/favorites/status', ...statusHandlers, wrap((req, res) => {
            if (!enabled()) return res.json({ enabled: false, status: {} });
            const b = bodyOf(req);
            let key;
            if (authRequired()) {
                const token = (typeof b.token === 'string' && b.token) ? b.token : String((req.query && req.query.token) || '');
                if (guard(res, token)) return;
                key = 't:' + token;
            } else key = 'ip:' + ipOf(req);
            res.json(anonStatus(b.items, key));
        }));
        // 站长手动跑一轮(只查到期的;与定时器共用同一把锁,不会叠两轮)
        app.post('/api/admin/favorites/check', async (req, res) => {
            noStore(res);
            if (!adminOk(req)) return res.status(403).json({ error: 'Forbidden' });
            if (!checkEnabled()) return res.json({ ok: false, error: 'disabled' });
            res.json(Object.assign({ ok: true }, await runRound()));
        });
    }

    return { registerRoutes, start, stop, runRound, enabled, checkEnabled, _armed: () => timers.length > 0, _ensureSchema: () => !!getDb() };
}

module.exports = { createFavorites, parsePlayUrl, vodStatus, parseDetail, normItem, favIdOf, parseTotal, pickTotal, inferCadence, isoWeekday, DEF, CAD };
