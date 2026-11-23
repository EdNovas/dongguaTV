// [adult] 目录的写入端(第三阶段):入库 / 作品汇总 / 播放上报 / 保留期 / 规则重扫 / AVDB 复核 / 热门分 —— 所有写操作都在这里。
//
//   生产(createCatalog({dbPath})):跑在 lib/site-catalog/worker.js 的写线程里,自己一条 catalog.db 连接,
//     主线程只发请求、等回包,永远不做长写(调研 storage-recommendation §2.3:60 条一页的入库事务 27–537 ms)。
//   测试 / 传了 db 实例(inline):同一份代码直接在主线程上跑(同步)。
//   时间全由调用方传进来(args.t):测试用假时钟;这里不读 Date.now 做业务判断。
//
// 入库顺序(fail-closed,与第一/二阶段相同,新增 AVDB):
//   分类硬过滤 → 主流影视丢弃 → AVDB 政策(pol=block 的番号整条不收;review_hide 不收;review_code 当审查级 code)
//   → 番号可信度(见 codeTrust)→ policy.checkItem → 审查级 → 大类路由 → 标签(lib/adult/tags.tagLine)→ 作品键 → upsert。
// 番号可信度(契约 C):code_ok = (AVDB 命中 且 (两边时长都知道时 3%+60s 内对得上 或 这个站没把这个番号乱贴在多个标题上))
//   或 (在白名单里且不可疑)。另外:两边时长都知道却对不上(不是片段)= 冲突,两条路都不算;
//   占位/可疑番号(JUL-123 这类)走 AVDB 这条路必须时长对得上;KBJ 永不可信;CN 的 AVDB 片长不可靠,不拿来否定。
//   AVDB 片长还用来认片段:我们的时长 < 片长 50%(CN 40%)且片长 ≥20 分钟 → '#clip'。
// 作品汇总(refreshWork):标签 = tags.mergeWork(各线路标签, AVDB 标签)(严格口径:只有 AI 改写标题站的片名给的标签要别的线路或 AVDB 证实);
//   展示时长 = 线路中位数,没有就 AVDB 片长;发行日期 / 片商 / 厂牌 / 演员(AVDB 主行)/ AVDB 封面(线路没封面时用)。
//   vis = 审查通过 且 至少一条没被判死的线路(浏览快照只看 vis=1 的作品)。
// 保留期(全量历史):作品永远保留;线路按健康过期 —— 判死超过 30 天的删掉,站点表里删掉的站连续 7 天不在就删它的线路。
// 规则重扫(rescan):规则版本一变,代数 GEN +1;旧代的行读接口读不到(common.js ELIG),这里逐块按新规则重跑、跑完即可读,入库照常(见 rescan 注释)。
'use strict';

const zlib = require('zlib');
const U = require('./util');
const SCH = require('./schema');
const K = require('./common');
const H = require('./heat');
const CH = require('./cover-health');

const { MIN, HOUR, DAY } = U;
const { F_ZH, F_UNC, F_LEAK, F_CLIP, F_UHD, ELIG, ELIG_I } = K;
const JP_KINDS = /^(?:jav|jav-cid|fc2|heyzo|uncen-date|tokyohot|h4610)$/;
const KANA = /[ぁ-ゖゝ-ゟァ-ヺヽ-ヿ]/;
const REVIEW_RANK = { filter: 1, code: 2, hide: 3 };
// 片名括号里解析出的"片商"其实是分类 / 泛称的(【自拍】【国产】…):不当片商(片商分面里全是这种就没意义了)
// 第四阶段复核:社区 / 论坛名也不是片商(和 tags.js NOT_STUDIO 同表 —— tagLine 清掉了,这里不能再从 parseTitle 的片商捡回来):
//   海角社区 / 杏吧 / 91视频 是乱伦 / 偷拍 / 探花的集散地,做成"同片商"行 = 把审查级题材当普通卡片推荐
const STUDIO_JUNK = /^(?:自拍|國產|国产|偷拍|网红|網紅|主播|直播|传媒|傳媒|原创|原創|精品|合集|其他|其它|未知|素人|探花|无码|無碼|有码|有碼|中字|中文字幕|日本|欧美|歐美|韩国|韓國|动漫|動漫|视频|視頻|福利|热门|熱門|最新|推荐|推薦|独家|獨家|海角(?:社区|社區)?|杏吧|91视频|91視頻)$/i;
const SRC_CH = { cat: 'c', raw: 'r', flag: 'f', title: 't', title_ai: 'a', avdb: 'v' };
// ingest 规则修订(writer 自己的入库判定变了也要触发重扫;policy/tags 的指纹在 o.rules 里)
// i3:审查级标签不吃严格口径 + policy.reviewTagHints 补审查级标签 + 社区名不当片商
const INGEST_REV = 'i3';
const CH_SRC = { c: 'cat', r: 'raw', f: 'flag', t: 'title', a: 'title', v: 'avdb' };
const str = (v, n) => (v == null ? '' : U.clip(v, n || 20000));
const yieldTick = () => new Promise((r) => setImmediate(r));

function createWriter(o) {
    const d = o.db;
    const A = o.adult;
    const T = A.title, P = A.policy, X = A.taxonomy;
    const TG = K.tagsOf(A, o.tags);
    const C = o.C;
    // 第四阶段(修订):站长追加屏蔽词【不进】规则键 —— 改词表不加新一代规则(加一代 = 没重扫到的作品整段读不到:作品页 404、浏览缩水,
    //   库越大停摆越久;清空词表也一样)。现在:主线程出口按片名立刻拦(index.js exitList / work / heat),入库 / 重扫照常按现词表判
    //   (policy.checkItem),加了新词 → 后台逐块删掉命中的线路(extraPurge);删词 / 清空 = 什么都不扫
    const rulesNow = () => (o.rules || '') + '|' + INGEST_REV;
    // 旧写法(词表哈希进过规则键:RULES_VERSION + '+x' + 8 位哈希 + '|i2')→ 去掉哈希再比(同一套内置规则不因此加代)
    const noX = (s) => (s == null ? s : String(s).replace(/\+x(?:[0-9a-f]{8}|\?)(?=\|[^|]*$)/, ''));
    let RULES = rulesNow();
    const NAV = new Set(X.NAV_BUCKETS);
    const DROP = new Set(X.DROP_BUCKETS);
    const getAvdb = typeof o.avdb === 'function' ? o.avdb : () => o.avdb || null;
    const logFn = typeof o.log === 'function' ? o.log : () => {};
    const warnAt = new Map();
    const warn = (tag, m) => {
        const t = Date.now();
        if ((warnAt.get(tag) || 0) + 60e3 > t) return;
        if (warnAt.size > 500) warnAt.clear();
        warnAt.set(tag, t);
        try { logFn(tag + ': ' + m); } catch (_) { /* 日志坏了不影响 */ }
    };
    const TAGSET = new Set(TG.VOCAB.filter((t) => t.kind !== 'blocked').map((t) => t.id));
    const stats = {
        ingested: 0, rejected: Object.create(null), flags: Object.create(null), signals: Object.create(null), migrated: 0,
        hits: { items: 0 }, beacon: { ok: 0, fail: 0, ignored: 0, dead: 0, revived: 0, dur: 0, res: 0, orient: 0 },
        avdb: { reeval: 0, keys: 0, changed: 0, blockedDropped: 0 }, retention: null, rescan: null, purge: null, cover: null,
    };
    const bump = (m, k, n) => { if (!(k in m) && Object.keys(m).length >= 200) k = 'other'; m[k] = (m[k] || 0) + (n || 1); };

    const stmts = new Map();
    const q = (sql) => { let s = stmts.get(sql); if (!s) { s = d.prepare(sql); stmts.set(sql, s); } return s; };
    let ftsOk = false, bigramOk = false, rescanPending = false, rescanP = null, avdbP = null;
    let rescanEpoch = 0;   // 第四阶段:规则代数在重扫进行中又加了一代 → +1,进行中的重扫从头再来
    let GEN = 0;   // 当前规则代数(init 定;入库一律记这一代,读接口只认 rv ≥ GEN 的行,见 common.js ELIG)
    const getMeta = (k) => { const r = q('SELECT v FROM adult_meta WHERE k=?').get(k); return r ? r.v : null; };
    const setMeta = (k, v) => q('INSERT OR REPLACE INTO adult_meta (k, v) VALUES (?, ?)').run(k, v == null ? null : String(v));
    const heatW = H.createHeatWriter({ q, d, elig: ELIG });
    // 封面域名健康(cover-health.js):死域名表(主线程判、存在 adult_meta 'cover:hosts';ADULT_COVER_HEALTH_DISABLE=1 → C.coverHealth=false → 永远空)
    const COVER_ON = !(C && C.coverHealth === false);
    let coverDead = new Set();

    // ---------- AVDB(只读查找;本次操作内缓存) ----------
    const avCache = new Map();
    // dur:片商未知的日期式番号(UNC-…)AVDB 可能有好几个片商,按时长挑(其余番号时长不参与查找)
    function av(key, dur) {
        if (!key) return null;
        const inst = getAvdb();
        if (!inst || typeof inst.lookup !== 'function') return null;
        const unc = /^UNC-/.test(key) && dur > 0;
        const ck = unc ? key + '@' + dur : key;
        if (avCache.has(ck)) return avCache.get(ck);
        let r = null;
        try { r = (unc ? inst.lookup(key, { dur }) : inst.lookup(key)) || null; } catch (e) { warn('avdb lookup', e.message); r = null; }
        if (r && typeof r !== 'object') r = null;
        if (avCache.size > 4000) avCache.clear();
        avCache.set(ck, r);
        return r;
    }
    function avSig(a) {
        if (!a) return '0';
        const ids = (x) => (Array.isArray(x) ? x.map((e) => (e && typeof e === 'object' ? (e.aid != null ? e.aid : e.id) : e)).join('.') : '');
        return ['1', a.pol || '', Number(a.runtime) || 0, a.released || '', a.poster ? 1 : 0, ids(a.actors), ids(a.tags), a.maker || '', a.label || ''].join('|');
    }
    function avTags(a, bucket) {
        if (!a) return null;
        if (Array.isArray(a.tags)) return a.tags.filter((e) => e && typeof e.id === 'string');
        if (Array.isArray(a.tags_en) && typeof TG.tagsFromAvdb === 'function') { try { return TG.tagsFromAvdb(a.tags_en, { bucket }); } catch (_) { return null; } }
        return null;
    }

    // ---------- 分类表(写线程自己一份缓存) ----------
    const cmaps = new Map();
    function classMap(api) {
        const hit = cmaps.get(api);
        if (hit) return hit;
        const rows = q('SELECT type_id, type_pid, type_name FROM adult_classes WHERE api=?').all(api);
        if (!rows.length) return null;
        const byId = X.buildClassMap(rows, { host: api });
        const byName = new Map();
        for (const [id, row] of byId) {
            const k = X.normName(row.name);
            const e = byName.get(k);
            if (!e || (row.block && !e.row.block)) byName.set(k, { id, row });   // 同名分类:硬过滤的那个说了算
        }
        const m = { byId, byName, names: rows.map((r) => r.type_name) };
        cmaps.set(api, m);
        return m;
    }
    function saveClasses({ api, rows, t }) {
        d.transaction(() => {
            q('DELETE FROM adult_classes WHERE api=?').run(api);
            const ins = q('INSERT OR REPLACE INTO adult_classes (api, type_id, type_pid, type_name) VALUES (?, ?, ?, ?)');
            for (const r of rows) ins.run(api, r.id, r.pid, r.name);
            q('INSERT OR REPLACE INTO adult_class_state (api, fetched_at, ok) VALUES (?, ?, 1)').run(api, t);
        })();
        cmaps.delete(api);
        return rows.length;
    }

    // ---------- 入库 ----------
    function route(parsed, codeOk, name) {
        const f = parsed.flags || {};
        if ((codeOk && JP_KINDS.test(parsed.kind || '')) || KANA.test(name)) return f.chineseSub ? 'jp_subbed' : (f.uncensored ? 'jp_uncensored' : 'jp_censored');
        if (codeOk && parsed.kind === 'cn') return 'cn_studio';
        return 'cn_amateur';
    }
    // 同站同番号挂在 ≥3 个不同标题上、时长又对不上(或没时长可比)→ 这个站在乱贴番号
    function autoFlagged(siteKey, vodId, parsed, dur) {
        if (!parsed || !parsed.key) return false;
        const rows = q('SELECT tkey, dur FROM adult_items WHERE site=? AND ckey=? AND vod_id<>? LIMIT 50').all(siteKey, parsed.key, vodId);
        if (rows.length < 2) return false;
        const keys = new Set(rows.map((r) => r.tkey));
        keys.add(parsed.titleKey);
        if (keys.size < 3) return false;
        const durs = rows.map((r) => r.dur).concat([dur]).filter((x) => x > 0);
        if (durs.length < 2) return true;
        const m = U.median(durs);
        return durs.some((x) => !U.durCompatible(x, m));
    }
    function codeTrust(site, vodId, parsed, dur, a) {
        const allow = T.codeOk(parsed, { siteTrust: site.codeTrust });
        const shape = !!(parsed && parsed.key && parsed.code && site.codeTrust !== false && parsed.kind !== 'west-date' && parsed.kind !== 'kbj');
        const out = { ok: false, src: null, clip: false };
        if (!shape && !allow) return out;
        const multi = autoFlagged(site.key, vodId, parsed, dur);
        let conflict = false, avdbOk = false;
        if (a && shape) {
            const rt = Number(a.runtime) > 0 ? Number(a.runtime) : 0;
            const cn = parsed.kind === 'cn';
            const both = dur > 0 && rt > 0;
            const clip = both && rt >= 1200 && dur < (cn ? 0.4 : 0.5) * rt;
            const eff = both && !cn;                         // CN 的 AVDB 片长不可靠:不拿来证实,也不拿来否定
            const agree = eff && Math.abs(dur - rt) <= 0.03 * rt + 60;
            conflict = eff && !agree && !clip;
            const suspect = !!(parsed.suspect || parsed.placeholder);
            avdbOk = eff ? (agree || (clip && !multi)) : (!multi && !suspect);
            out.clip = clip;
            if (conflict) bump(stats.flags, 'avdb-conflict');
        }
        const allowOk = allow && !multi && !conflict;
        if (allow && multi) bump(stats.flags, 'autoflag');
        out.ok = avdbOk || allowOk;
        out.src = avdbOk ? 'avdb' : allowOk ? 'allow' : null;
        if (avdbOk && !allow) bump(stats.flags, 'avdb-rescue');
        return out;
    }
    function inChain(wk, base, isCode) {
        if (wk === base || wk.indexOf(base + '~') === 0) return true;
        return isCode && (wk === base + '#clip' || wk.indexOf(base + '#clip~') === 0);
    }
    function chooseWk(siteKey, vodId, base, dur, isCode, prev) {
        if (prev && prev.wk && inChain(prev.wk, base, isCode)) {
            const others = q('SELECT dur FROM adult_items WHERE wk=? AND dur>0 AND NOT (site=? AND vod_id=?) LIMIT 200').all(prev.wk, siteKey, vodId).map((r) => r.dur);
            if (U.durCompatible(dur, U.median(others))) return prev.wk;
        }
        return assignWk(base, dur, isCode, 0);
    }
    function assignWk(base, dur, isCode, depth) {
        for (let k = 1; k <= 9; k++) {
            const cand = k === 1 ? base : base + '~' + k;
            const w = q('SELECT dur_med, n_sites FROM adult_works WHERE wk=?').get(cand);
            if (!w || !w.n_sites) return cand;                     // 没有 / 只剩空壳(线路都过期了)→ 直接用
            if (U.durCompatible(dur, w.dur_med)) return cand;
            if (isCode && k === 1 && depth === 0 && !/#clip$/.test(base) && dur > 0 && w.dur_med > 0) {
                if (dur < 0.5 * w.dur_med) return assignWk(base + '#clip', dur, isCode, 1);   // 解说 / 片段
                if (w.dur_med < 0.5 * dur) { migrateClip(base); return base; }                // 先来的是片段,完整版后到
            }
        }
        return base + '~d' + dur;
    }
    // 复核 CAT-5:后台隐藏跟着线路走。一条线路从被藏的作品(adult_hidden 里有它的键,或去掉 #… / ~N 后的主键 —— 和闸门 isHidden 同口径)
    //   挪到别的作品键(规则重扫番号可信度翻了 c:→t:、片名键变了、片段迁移…)→ 新键也记进 adult_hidden(名字 / 时间沿用原来那条)并 hid=1。
    //   新作品行建出来时 refreshWork 按 adult_hidden 定 hid,所以要在 refreshWork(新键) 之前调。只会更严(站长在后台能看到、能取消)
    function followHide(from, to) {
        if (!from || !to || from === to) return false;
        const base = from.replace(/[#~].*$/, '');
        const h = q('SELECT name, at FROM adult_hidden WHERE wk=?').get(from) || (base !== from ? q('SELECT name, at FROM adult_hidden WHERE wk=?').get(base) : null);
        if (!h || q('SELECT 1 FROM adult_hidden WHERE wk=?').get(to)) return false;
        // 并进了一部已有的(没藏的)作品:整部一起藏(宁严;同一部片)—— 单独计数 + 日志,站长在后台隐藏列表里能看到、能取消
        const merged = !!q('SELECT 1 FROM adult_works WHERE wk=? AND n_sites > 0').get(to);
        q('INSERT OR IGNORE INTO adult_hidden (wk, name, at) VALUES (?, ?, ?)').run(to, h.name, Number(h.at) || 0);
        q('UPDATE adult_works SET hid=1 WHERE wk=?').run(to);
        bump(stats.flags, merged ? 'hide-follow-merge' : 'hide-follow');
        if (merged) warn('hide-follow', '被藏作品的线路并进了已有作品 ' + to + '(整部一起藏,后台可取消)');
        hideFollowN++;
        return true;
    }
    let hideFollowN = 0;   // ingest 回包带上这一批跟过去几个(主线程马上并进隐藏表,不等下一次重建快照)
    // 先入库的是片段(时长 < 新来完整版的 50%):把它们挪去 '#clip',主键让给完整版(作品行删掉,新作品名按完整版重新冻结)
    function migrateClip(base) {
        const rows = q('SELECT site, vod_id, dur FROM adult_items WHERE wk=?').all(base);
        for (const r of rows) {
            const nk = assignWk(base + '#clip', r.dur, true, 1);
            q('UPDATE adult_items SET wk=?, flags = flags | ? WHERE site=? AND vod_id=?').run(nk, F_CLIP, r.site, r.vod_id);
            followHide(base, nk);
            refreshWork(nk, { site: r.site, vod_id: r.vod_id });
        }
        deleteWork(base);
        stats.migrated++;
    }
    function deleteWork(wk) {
        const w = q('SELECT id, name, code FROM adult_works WHERE wk=?').get(wk);
        if (!w) return;
        q('DELETE FROM adult_works WHERE id=?').run(w.id);
        if (ftsOk) { try { q("INSERT INTO adult_fts (adult_fts, rowid, name, code) VALUES ('delete', ?, ?, ?)").run(w.id, w.name, w.code || ''); } catch (_) { /* fts 坏了不影响主表 */ } }
        if (bigramOk) { try { q('DELETE FROM adult_fts2 WHERE rowid=?').run(w.id); } catch (_) { /* 老 SQLite 不支持删:留着只会多出候选,读时按主表过滤 */ } }
    }
    function encTags(list) {
        const out = [];
        const seen = new Set();
        for (const e of Array.isArray(list) ? list : []) {
            if (!e || typeof e.id !== 'string' || !TAGSET.has(e.id) || seen.has(e.id)) continue;
            seen.add(e.id);
            let ch = SRC_CH[e.src] || 'c';
            if (ch === 't' && e.ai === true) ch = 'a';
            out.push(e.id + '.' + ch);
            if (out.length >= 30) break;
        }
        return out.length ? ',' + out.join(',') + ',' : '';
    }
    function decTags(s, site) {
        const out = [];
        for (const part of String(s || '').split(',')) {
            if (!part) continue;
            const i = part.lastIndexOf('.');
            const id = i > 0 ? part.slice(0, i) : part;
            const ch = i > 0 ? part.slice(i + 1) : 'c';
            const e = { id, src: CH_SRC[ch] || 'cat', site };
            if (ch === 'a') e.ai = true;
            out.push(e);
        }
        return out;
    }
    const rawBlob = (o2) => zlib.deflateRawSync(Buffer.from(JSON.stringify(o2), 'utf8'));
    function rawFrom(blob) {
        if (!blob) return null;
        try { const j = JSON.parse(zlib.inflateRawSync(blob).toString('utf8')); return j && typeof j === 'object' ? j : null; } catch (_) { return null; }
    }

    // 一条原始 maccms 条目 → 库(调用方包事务)。返回 {ok, wk?, bucket?, reason?}
    function ingestItem(site, raw, ctx) {
        const rej = (reason) => { bump(stats.rejected, reason); return { ok: false, reason }; };
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rej('invalid');
        const vodId = String(raw.vod_id == null ? '' : raw.vod_id).trim();
        const name = str(raw.vod_name, 200).trim();
        if (!vodId || vodId.length > 64 || !name) return rej('invalid');
        // 1) 分类(按条目自己的 type_id;搜索结果没有 type_id 时按分类名在本站表里找)
        const cmap = ctx.cmap;
        let typeId = raw.type_id == null || raw.type_id === '' ? NaN : Number(raw.type_id);
        let cls = Number.isFinite(typeId) ? (cmap.byId.get(typeId) || null) : null;
        if (!cls && !Number.isFinite(typeId) && raw.type_name) {
            const e = cmap.byName.get(X.normName(raw.type_name));
            if (e) { cls = e.row; typeId = e.id; }
        }
        if (!cls) { ctx.noclass = true; return rej('noclass'); }
        // 2) 分类硬过滤(自己或任一祖先) 3) 主流影视 / 非视频 / 纯结构父分类
        if (cls.block) return rej('category');
        if (DROP.has(cls.bucket)) return rej('mainstream');
        // 4) 片名身份 + AVDB 政策
        const typeName = str(raw.type_name != null && raw.type_name !== '' ? raw.type_name : cls.name, 60);
        const parsed = T.parseTitle(name, typeName);
        const dur = U.parseDur(raw.vod_duration, raw.vod_remarks);
        const a = parsed.key ? av(parsed.key, dur) : null;
        if (a && a.pol === 'block') { bump(stats.flags, 'avdb-block'); return rej('avdb-block'); }
        if (a && a.pol === 'review_hide') return rej('avdb-review');
        const ct = codeTrust(site, vodId, parsed, dur, a);
        let codeOk = ct.ok;
        // 政策(审查级 code / 过滤词)只认白名单番号,和 gate.checkRaw 同一条规则:AVDB 证实(code_src='avdb')只管分组和元数据,
        //   不能让 gate 拒掉的审查级线路在目录里上架(否则卡片点开是 404)
        let polCodeOk = codeOk && !!T.codeOk(parsed, { siteTrust: site.codeTrust });
        const item = {
            vod_name: name, vod_sub: str(raw.vod_sub), vod_content: str(raw.vod_content), vod_blurb: str(raw.vod_blurb),
            type_name: typeName, vod_tag: str(raw.vod_tag), vod_class: str(raw.vod_class), vod_remarks: str(raw.vod_remarks),
            vod_actor: str(raw.vod_actor), vod_director: str(raw.vod_director), vod_area: str(raw.vod_area),
        };
        let pc;
        try { pc = P.checkItem(item, { cls, codeOk: polCodeOk, siteTrust: site.codeTrust !== false, strict: site.strict === true }); } catch (e) { return rej('policy-error'); }
        if (!pc || pc.ok !== true) return rej(String((pc && pc.reason) || 'policy'));
        if (pc.codeOk === false && polCodeOk) { polCodeOk = false; codeOk = false; bump(stats.flags, 'policy-code'); }   // 严格站否决
        // 5) 审查级(checkItem 已经拦过,再兜一道;AVDB review_code 也算 code 级)
        let review = pc.review || null;
        if (a && a.pol === 'review_code' && (REVIEW_RANK[review] || 0) < REVIEW_RANK.code) review = 'code';
        if (review === 'hide' || (review === 'code' && !polCodeOk)) return rej('review');
        // 6/7) 大类
        let bucket = pc.bucket;
        if (bucket === 'mixed' || bucket === 'uncat') bucket = route(parsed, codeOk, name);
        if (!NAV.has(bucket)) return rej('bucket');
        // 8) 变体 + 标签
        const f = parsed.flags || {};
        const isClip = !!(f.clip || bucket === 'commentary' || (codeOk && ct.clip));
        const flags = (f.chineseSub ? F_ZH : 0) | (f.uncensored ? F_UNC : 0) | (f.leak ? F_LEAK : 0) | (isClip ? F_CLIP : 0) | (f.uhd ? F_UHD : 0);
        const variant = f.chineseSub ? '中字' : f.leak ? '无码流出' : f.uncensored ? '无码' : f.uhd ? '4K' : '';
        let tl = null;
        try {
            tl = TG.tagLine(Object.assign({}, raw, { vod_name: name, type_name: typeName }),
                { site: { key: site.key, aiTitles: site.aiTitles }, parsed, cls, bucket, classNames: cmap.names, pcTags: pc.tags });
        } catch (e) { warn('tagLine', e.message); tl = null; }
        const lineTags = tl && Array.isArray(tl.tags) ? tl.tags.slice() : [];
        // 第四阶段复核:政策给的审查级标签补召回(乱伦框架片名:内射妈妈 / 小姨 / 表姐…)—— 只补审查级,只会更不露出
        if (typeof P.reviewTagHints === 'function') {
            let hints = [];
            try { hints = P.reviewTagHints(item) || []; } catch (_) { hints = []; }
            for (const id of hints) if (TAGSET.has(id) && TG.isReview(id) && !lineTags.some((e) => e && e.id === id)) lineTags.push({ id, src: 'title' });
        }
        if (TG.VERSION === 'legacy') {   // 旧内容层没有标签模块:分类派生标签 + 中字/无码
            if (f.chineseSub) lineTags.push({ id: 'subbed', src: 'flag' });
            if (f.uncensored) lineTags.push({ id: 'uncensored', src: 'flag' });
        }
        if (tl && Array.isArray(tl.signals)) for (const s of tl.signals) if (typeof s === 'string') bump(stats.signals, s);
        let studio = tl && typeof tl.studio === 'string' && tl.studio ? tl.studio : (parsed.studio || '');
        // 番号不可信时,从番号前缀推出来的片商也不可信(假番号站给国产片硬贴 SSIS-xxx);片名里写明的片商(传媒-X / 欧美片商名)照用
        if (!codeOk && parsed.code && studio && studio === parsed.studio) studio = '';
        if (parsed.kind === 'kbj' || /^kbj$/i.test(studio) || STUDIO_JUNK.test(String(studio).trim())) studio = '';
        // 9) 作品键
        let base = T.workKey(parsed, { codeOk });
        if (!base || base === 't:') base = 't:' + (T.titleKey(name) || vodId);
        const isCode = base.indexOf('c:') === 0;
        if (isCode && (flags & F_CLIP)) base += '#clip';
        const prev = q('SELECT id, wk, play_url, dead FROM adult_items WHERE site=? AND vod_id=?').get(site.key, vodId);
        const wk = chooseWk(site.key, vodId, base, dur, isCode, prev);
        // 10) upsert
        const now = ctx.now;
        const vt = U.parseTime(raw.vod_time);
        // 首见时间:爬虫 = 资源站上架时间(不晚于现在);搜索回写 = 上架时间,没有就当 30 天前(不进"新上架")
        const first = vt > 0 && vt <= now ? vt : (ctx.src === 'crawl' ? now : now - 30 * DAY);
        const pu = typeof raw.vod_play_url === 'string' && raw.vod_play_url && raw.vod_play_url.length <= C.maxPlayUrl ? raw.vod_play_url : null;
        const stripQs = (x) => String(x || '').replace(/\?[^#$]*/g, '');
        const reset = !!(prev && prev.dead && pu && prev.play_url && stripQs(pu) !== stripQs(prev.play_url));
        const pic = typeof raw.vod_pic === 'string' && /^https?:\/\//i.test(raw.vod_pic.trim()) ? U.clip(raw.vod_pic.trim(), 500) : '';
        const row = q(`INSERT INTO adult_items (site, vod_id, wk, bucket, tags, review, code_ok, code_src, name, clean, code, ckey, tkey, pic, dur, vod_time,
                first_seen, last_seen, type_id, type_name, play_from, play_url, play_at, variant, flags, family, src, studio, rv)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(site, vod_id) DO UPDATE SET wk=excluded.wk, bucket=excluded.bucket, tags=excluded.tags, review=excluded.review, rv=excluded.rv,
                code_ok=excluded.code_ok, code_src=excluded.code_src, name=excluded.name, clean=excluded.clean, code=excluded.code, ckey=excluded.ckey, tkey=excluded.tkey,
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
                studio=excluded.studio,
                dead=CASE WHEN ? THEN 0 ELSE adult_items.dead END,
                ok_at=CASE WHEN ? THEN excluded.last_seen ELSE adult_items.ok_at END,
                dead_at=CASE WHEN ? THEN NULL ELSE adult_items.dead_at END
              RETURNING id`).get(
            site.key, vodId, wk, bucket, encTags(lineTags), review, codeOk ? 1 : 0, codeOk ? ct.src : null,
            name, U.clip(parsed.cleanTitle || '', 200), parsed.code || null, parsed.key || null, parsed.titleKey || '',
            pic, dur, vt > 0 ? vt : null, first, now, Number.isFinite(typeId) ? typeId : null, typeName,
            pu ? str(raw.vod_play_from, 200) : null, pu, pu ? (ctx.playAt != null ? ctx.playAt : now) : null,
            variant, flags, site.family || '', ctx.src === 'crawl' ? 'crawl' : String(ctx.src || 'search'), studio ? U.clip(studio, 60) : null, GEN,
            reset ? 1 : 0, reset ? 1 : 0, reset ? 1 : 0);
        // 重扫要的原始字段(规则变了按新规则重跑):压缩存在旁表
        q('INSERT OR REPLACE INTO adult_items_raw (id, raw) VALUES (?, ?)').run(row.id, rawBlob({
            n: name, s: str(raw.vod_sub, 300), c: str(raw.vod_content, C.maxContent), b: str(raw.vod_blurb, 300), t: Number.isFinite(typeId) ? typeId : null,
            tn: typeName, tg: str(raw.vod_tag, 300), cl: str(raw.vod_class, 300), rm: str(raw.vod_remarks, 100),
            du: str(raw.vod_duration, 20), tm: str(raw.vod_time, 30), p: pic, pf: str(raw.vod_play_from, 200),
            a: str(raw.vod_actor, 300), dr: str(raw.vod_director, 100), ar: str(raw.vod_area, 50),
        }));
        // 签名和复核(avdbRun)同口径:UNC-(片商未知)按时长挑的结果因线路而异,签名一律按不带时长的查法记,否则每轮复核都当"变了"
        if (parsed.key) q('INSERT OR REPLACE INTO adult_avsig (ckey, sig) VALUES (?, ?)').run(parsed.key, avSig(/^UNC-/.test(parsed.key) && dur > 0 ? av(parsed.key) : a));
        if (reset) q('DELETE FROM adult_line_fail WHERE site=? AND vod_id=?').run(site.key, vodId);
        if (prev && prev.wk && prev.wk !== wk) followHide(prev.wk, wk);   // 被藏作品的线路换了作品键:新键也藏(CAT-5)
        refreshWork(wk, { site: site.key, vod_id: vodId });
        if (prev && prev.wk && prev.wk !== wk) refreshWork(prev.wk);
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
    function uniqueName(n, wk) {
        const taken = (x) => { const r = q('SELECT wk FROM adult_works WHERE name=? LIMIT 1').get(x); return !!r && r.wk !== wk; };
        if (!taken(n)) return n;
        for (let i = 2; i <= 30; i++) { const m = n + ' · ' + i; if (!taken(m)) return m; }
        return n + ' · ' + U.hash31(wk).toString(36);
    }
    // 作品名过一遍片名政策(和闸门 nameOk 同口径;作品名冻结,结果按 名字+分区 记住)。异常 = 不放行
    const nameMemo = new Map();
    function workNameOk(name, bucket) {
        const k = bucket + '\x01' + name;
        let v = nameMemo.get(k);
        if (v === undefined) {
            try { v = !(typeof P.checkQuery === 'function' && P.checkQuery(name)) && P.checkItem({ vod_name: name, type_name: '' }, { cls: { bucket, tags: [], review: null, block: false } }).ok === true; } catch (_) { v = false; }
            if (nameMemo.size >= 50000) nameMemo.clear();
            nameMemo.set(k, v);
        }
        return v;
    }
    // 重算一个作品的汇总;没有线路了 → 作品行保留(全量历史:历史 / 收藏还按片名认它),只是 vis=0
    function refreshWork(wk, trigger) {
        const rows = q('SELECT site, vod_id, bucket, tags, review, code_ok, code, ckey, clean, name, pic, dur, first_seen, last_seen, flags, variant, dead, studio, rv, orient FROM adult_items WHERE wk=?').all(wk);
        const w = q('SELECT id, wk, bucket, first_seen, name FROM adult_works WHERE wk=?').get(wk);
        if (!rows.length) {
            // 线路按健康过期 → 作品保留(vis=0);规则重扫 / AVDB 拦截把线路全删了 → 作品本身不合格,一起删
            if (w && trigger && trigger.dropEmpty) deleteWork(wk);
            else if (w) q("UPDATE adult_works SET n_sites=0, sites='', live_sites='', vis=0 WHERE id=?").run(w.id);
            return;
        }
        const sites = new Set(), live = new Set(), bc = new Map(), vars = new Set(), durs = [], studios = new Map(), lists = [];
        let review = null, codeOk = 1, flags = 0, last = 0, lineAt = 0, firstRow = null, rv = GEN;
        for (const r of rows) {
            if (!(r.rv >= rv)) rv = Number(r.rv) || 0;   // 作品的代数 = 线路里最旧的那一代(有一条没按新规则重跑过,整部作品就先不出)
            sites.add(r.site);
            if (!r.dead) live.add(r.site);
            bc.set(r.bucket, (bc.get(r.bucket) || 0) + 1);
            lists.push(decTags(r.tags, r.site));
            if ((REVIEW_RANK[r.review] || 0) > (REVIEW_RANK[review] || 0)) review = r.review;
            if (!r.code_ok) codeOk = 0;
            flags |= r.flags;
            if (r.variant) vars.add(r.variant);
            if (r.dur > 0) durs.push(r.dur);
            if (r.studio) studios.set(r.studio, (studios.get(r.studio) || 0) + 1);
            if (!firstRow || r.first_seen < firstRow.first_seen) firstRow = r;
            if (r.last_seen > last) last = r.last_seen;
            if (r.first_seen > lineAt) lineAt = r.first_seen;
        }
        const trig = (trigger && rows.find((r) => r.site === trigger.site && r.vod_id === trigger.vod_id)) || firstRow;
        const pref = (b) => (w && b === w.bucket ? 2 : 0) + (b === trig.bucket ? 1 : 0);
        let bucket = null, best = -1;
        for (const [b, n] of bc) if (n > best || (n === best && pref(b) > pref(bucket))) { bucket = b; best = n; }
        const firstSeen = w ? Math.min(w.first_seen, firstRow.first_seen) : firstRow.first_seen;
        // AVDB(番号作品;片段不吃 AVDB 的片长 / 标签 / 演员)
        const isCode = wk.indexOf('c:') === 0;
        const kind = K.kindOfWk(wk);
        const ckey = isCode ? (trig.ckey || firstRow.ckey) : null;
        const aw = ckey ? av(ckey) : null;
        const useA = !!(aw && kind !== 'clip');
        let tagIds = [];
        try { tagIds = TG.mergeWork(lists, useA ? avTags(aw, bucket) : null, { bucket }); } catch (e) { warn('mergeWork', e.message); tagIds = []; }
        tagIds = (Array.isArray(tagIds) ? tagIds : []).filter((id) => typeof id === 'string' && TAGSET.has(id)).slice(0, 40);
        // 第四阶段复核:严格口径(只来自 AI 改写标题的标签要别处证实)只该管【放大露出】的 featured 标签;审查级标签只会让作品更不露出,
        //   任何一条线路有就算(否则 AI 标题站的"继母…继子"作品一个审查级标签都留不下,被当普通卡片进相关 / 猜你喜欢)
        for (const l of lists) for (const e of l) {
            const id = e && e.id;
            if (typeof id === 'string' && TAGSET.has(id) && TG.isReview(id) && tagIds.indexOf(id) < 0 && tagIds.length < 40) tagIds.push(id);
        }
        const durMed = U.median(durs);
        const dur = durMed || (useA && Number(aw.runtime) > 0 ? Math.round(Number(aw.runtime)) : 0);
        const released = useA && /^\d{4}-\d{2}-\d{2}$/.test(String(aw.released || '')) ? aw.released : '';
        const maker = useA ? U.clip(aw.maker || '', 60) : '';
        const label = useA ? U.clip(aw.label || '', 60) : '';
        let studio = '', sbest = 0;
        for (const [s, n] of studios) if (n > sbest) { studio = s; sbest = n; }
        if (!studio) studio = maker;
        const actors = useA && Array.isArray(aw.actors) ? aw.actors.filter((x) => x && x.aid != null && typeof x.name === 'string' && x.name.trim()).slice(0, 8).map((x) => [x.aid, U.clip(x.name.trim(), 60)]) : [];
        const apic = useA && typeof aw.poster === 'string' && /^https?:\/\//i.test(aw.poster) ? U.clip(aw.poster, 500) : null;
        // 作品名冻结在第一条线路的片名上:那条线路后来被新规则删了(媚薬 / 熟睡…),名字里的证据还在 —— 闸门出口按作品名会把卡片 / 作品页丢掉,
        //   这里按同一口径(nameOk:查询硬拦词 + 片名政策,带分区)算进 vis,快照里就不留它(计数 / 分页 / 分面和露出来的一致)
        const name = w ? w.name : uniqueName(canonName(trig, wk), wk);
        const vis = K.eligOk(review, codeOk) && live.size > 0 && workNameOk(name, bucket) ? 1 : 0;
        const sitesStr = ',' + [...sites].join(',') + ',';
        const liveStr = live.size ? ',' + [...live].join(',') + ',' : '';
        const tagsStr = tagIds.length ? ',' + tagIds.join(',') + ',' : '';
        const varsStr = [...vars].join(',');
        // 封面:最新一条封面不在死域名上的线路 + ≤2 个别的活域名候补;AVDB 封面域名没死才算(cover-health.js pickCover)
        const cv = CH.pickCover(rows, apic, coverDead);
        // 第四阶段:作品方向 = 线路方向多数(播放上报学来的)
        const orient = K.workOrient(rows.map((r) => r.orient));
        const vals = [bucket, tagsStr, review, codeOk, cv.pic, cv.item, apic, cv.alt, cv.cov, durMed, dur, sites.size, sitesStr, liveStr, firstRow.site,
            varsStr, flags, firstSeen, last, lineAt, vis, released, U.clip(studio, 60), maker, label, aw ? 1 : 0, actors.length ? JSON.stringify(actors) : '', rv, orient];
        if (w) {
            q(`UPDATE adult_works SET bucket=?, tags=?, review=?, code_ok=?, pic=?, pic_item=?, apic=?, pic_alt=?, cov=?, dur_med=?, dur=?, n_sites=?, sites=?, live_sites=?, first_site=?,
                    variants=?, flags=?, first_seen=?, last_seen=?, line_at=?, vis=?, released=?, studio=?, maker=?, label=?, avdb=?, actress=?, rv=?, orient=? WHERE id=?`).run(...vals, w.id);
            return;
        }
        const code = isCode ? trig.code : null;
        // 后台隐藏(adult_hidden 是真相):作品行被删了重建(片段迁移 / 规则重扫)也照样藏着
        const hid = q('SELECT 1 FROM adult_hidden WHERE wk=?').get(wk) ? 1 : 0;
        const info = q(`INSERT INTO adult_works (bucket, tags, review, code_ok, pic, pic_item, apic, pic_alt, cov, dur_med, dur, n_sites, sites, live_sites, first_site,
                variants, flags, first_seen, last_seen, line_at, vis, released, studio, maker, label, avdb, actress, rv, orient, wk, name, code, ckey, clean, is_clip, rand, hid)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(...vals, wk, name, code, trig.ckey, trig.clean, wk.indexOf('#clip') >= 0 ? 1 : 0, U.hash31('r:' + wk), hid);
        if (ftsOk) { try { q('INSERT INTO adult_fts (rowid, name, code) VALUES (?, ?, ?)').run(info.lastInsertRowid, name, code || ''); } catch (_) { /* fts 坏了不影响主表 */ } }
        if (bigramOk) { try { q('INSERT INTO adult_fts2 (rowid, bg) VALUES (?, ?)').run(info.lastInsertRowid, SCH.bigrams(name)); } catch (_) { /* 同上 */ } }
    }

    // 外站计数:四个都是非负整数才记;距上次 ≥2 分钟才把上次的总数挪进 prev
    const hitNum = (v) => { if (v == null || v === '') return NaN; const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.floor(n) : NaN; };
    function recordHits(siteKey, raw, t) {
        if (!raw || typeof raw !== 'object') return false;
        const vodId = String(raw.vod_id == null ? '' : raw.vod_id).trim();
        const h = [hitNum(raw.vod_hits_day), hitNum(raw.vod_hits_week), hitNum(raw.vod_hits_month), hitNum(raw.vod_hits)];
        if (!vodId || vodId.length > 64 || h.some((x) => Number.isNaN(x))) return false;
        const old = q('SELECT total, at, prev_total, prev_at FROM adult_hits WHERE site=? AND vod_id=?').get(siteKey, vodId);
        const shift = old && t - old.at >= C.trustGapMs;
        q('INSERT OR REPLACE INTO adult_hits (site, vod_id, day, week, month, total, at, prev_total, prev_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(siteKey, vodId, h[0], h[1], h[2], h[3], t, shift ? old.total : (old ? old.prev_total : null), shift ? old.at : (old ? old.prev_at : null));
        return true;
    }
    // {site, list, src, t, withHits} → {ok, rejected, noclass, wks, hits}
    function ingest({ site, list, src, t, withHits }) {
        const res = { ok: 0, rejected: 0, noclass: false, wks: [], hits: 0, hid: 0 };
        const hf0 = hideFollowN;
        // 规则重扫期间照常入库:新入库的行就是按新规则判的(rv = 当前代),马上可读;重扫只管旧代的行
        const cmap = classMap(site.api);
        if (!cmap) { bump(stats.rejected, 'noclass', Array.isArray(list) ? list.length : 0); res.noclass = true; res.rejected = Array.isArray(list) ? list.length : 0; return res; }
        avCache.clear();
        d.transaction(() => {
            for (const raw of Array.isArray(list) ? list : []) {
                const ctx = { src, cmap, now: t };
                let r;
                try { r = ingestItem(site, raw, ctx); } catch (e) { warn('ingest', e.message); r = { ok: false, reason: 'error' }; bump(stats.rejected, 'error'); }
                if (ctx.noclass) res.noclass = true;
                if (r.ok) { res.ok++; res.wks.push(r.wk); } else res.rejected++;
                if (r.ok && withHits) { try { if (recordHits(site.key, raw, t)) res.hits++; } catch (e) { warn('hits', e.message); } }
            }
        })();
        stats.ingested += res.ok;
        stats.hits.items += res.hits;
        res.hid = hideFollowN - hf0;
        return res;
    }

    // ---------- 爬虫状态 / 杂项 ----------
    function saveState({ st }) {
        q(`INSERT OR REPLACE INTO adult_crawl_state (site, api, last_ok, next_at, mode, pagesize, fails, last_new, last_err, cursor, ignores_h, n_req, n_items)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(st.site, st.api, st.last_ok, st.next_at, st.mode, st.pagesize, st.fails, st.last_new, st.last_err, st.cursor, st.ignores_h, st.n_req, st.n_items);
        return true;
    }
    function saveBackfill({ row }) {
        q(`INSERT OR REPLACE INTO adult_backfill (site, api, pg, pc, ps, done, started_at, updated_at, next_at, fails, last_err, n_req, n_items)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(row.site, row.api, row.pg, row.pc, row.ps, row.done ? 1 : 0, row.started_at, row.updated_at, row.next_at || 0, row.fails || 0, row.last_err || null, row.n_req || 0, row.n_items || 0);
        return true;
    }
    function expandMark({ wk, site, found, t }) { q('INSERT OR REPLACE INTO adult_expand (wk, site, found, at) VALUES (?, ?, ?, ?)').run(wk, site, found ? 1 : 0, t); return true; }
    // 外站计数复取的候选(写线程自己记"最近要过"的 id,站点不回的 id 别反复要)
    const hitsTried = new Map();
    function hitsCandidates({ siteKey, t }) {
        const fresh = (id) => { const x = hitsTried.get(siteKey + '|' + id); return !x || t - x >= C.hitsRefreshMs; };
        const top = q(`SELECT h.vod_id, h.at FROM adult_hits h JOIN adult_items i ON i.site = h.site AND i.vod_id = h.vod_id
                          WHERE h.site=? AND ${ELIG_I} ORDER BY h.week DESC LIMIT ?`).all(siteKey, C.hitsTop)
            .filter((r) => t - r.at >= C.hitsRefreshMs && fresh(r.vod_id)).sort((a, b) => a.at - b.at).map((r) => r.vod_id);
        const out = top.slice(0, C.hitsBatch);
        if (out.length < C.hitsBatch) {
            const none = q(`SELECT i.vod_id FROM adult_items i LEFT JOIN adult_hits h ON h.site = i.site AND h.vod_id = i.vod_id
                               WHERE i.site=? AND h.vod_id IS NULL AND ${ELIG_I} ORDER BY i.vod_time DESC LIMIT ?`).all(siteKey, C.hitsBatch * 3)
                .map((r) => r.vod_id).filter(fresh);
            for (const id of none) { if (out.length >= C.hitsBatch) break; if (out.indexOf(id) < 0) out.push(id); }
        }
        for (const id of out) hitsTried.set(siteKey + '|' + id, t);
        if (hitsTried.size > 20000) hitsTried.clear();
        return out;
    }
    // 薄分区回填计划:最近 30 天作品 <60 部的导航分区 → 各站这个分区的叶子分类(绝不拉父分类)
    function planThin({ t, sites }) {
        const thin = [];
        for (const b of X.NAV_BUCKETS) {
            const n = q(`SELECT COUNT(*) n FROM adult_works w WHERE w.vis=1 AND w.bucket=? AND w.first_seen >= ? AND w.is_clip=0 AND ${ELIG}`).get(b, t - 30 * DAY).n;
            if (n < C.backfillThin) thin.push(b);
        }
        const queue = [];
        if (thin.length) {
            const TT = new Set(thin);
            for (const s of sites) {
                const cmap = classMap(s.api);
                if (!cmap) continue;
                for (const [id, row] of cmap.byId) {
                    if (row.container || row.block || !TT.has(row.bucket)) continue;
                    queue.push({ site: s.key, api: s.api, t: id, ps: s.ps, pg: 1 });
                }
            }
        }
        return { startedAt: t, thin, queue };
    }
    // 本站热门分(lib/popular 片名 → 作品):排名越前分越高;不在名单里的清零
    function setHot({ names }) {
        const want = new Map();
        (Array.isArray(names) ? names : []).slice(0, 100).forEach((n, i) => { if (typeof n === 'string' && n && !want.has(n)) want.set(n, 1000 - i); });
        let n = 0;
        d.transaction(() => {
            for (const r of q('SELECT id, name FROM adult_works WHERE hot > 0').all()) if (!want.has(r.name)) { q('UPDATE adult_works SET hot=0 WHERE id=?').run(r.id); n++; }
            for (const [name, score] of want) n += q('UPDATE adult_works SET hot=? WHERE name=? AND hot<>?').run(score, name, score).changes;
        })();
        return n;
    }

    // ---------- 播放结果上报 ----------
    const oriSpent = new Map();   // 上报者|UTC 天 → 今天改过几条线路的方向(匿名合用一份)
    function orientSpend(id, t) {
        const day = Math.floor((Number(t) || 0) / DAY);
        const k = (id || '-') + '|' + day;
        const n = oriSpent.get(k) || 0;
        if (n >= (Number(C.orientBudget) > 0 ? Number(C.orientBudget) : 300)) { stats.beacon.orientCapped = (stats.beacon.orientCapped || 0) + 1; return false; }
        if (!oriSpent.has(k) && oriSpent.size >= 20000) { for (const x of [...oriSpent.keys()]) if (!x.endsWith('|' + day)) oriSpent.delete(x); if (oriSpent.size >= 20000) return false; }
        oriSpent.set(k, n + 1);
        return true;
    }
    function beacon({ r, who, t }) {
        const b = r && typeof r === 'object' ? r : {};
        const site = typeof b.site_key === 'string' ? b.site_key : '';
        const vid = (typeof b.vod_id === 'string' || typeof b.vod_id === 'number') ? String(b.vod_id) : '';
        const id = typeof who === 'string' ? who.slice(0, 128) : '';
        if (!site || site.length > 64 || !vid || vid.length > 64 || typeof b.ok !== 'boolean') { stats.beacon.ignored++; return { ok: false, reason: 'invalid' }; }
        if (!b.ok && !id) { stats.beacon.ignored++; return { ok: false, reason: 'anonymous' }; }
        const it = q('SELECT wk, dur, dead, ok_at, res, orient FROM adult_items WHERE site=? AND vod_id=?').get(site, vid);
        if (!it) { stats.beacon.ignored++; return { ok: false, reason: 'unknown' }; }
        const sameWk = typeof b.wk !== 'string' || !b.wk || b.wk === it.wk;
        let dead = !!it.dead;
        avCache.clear();
        d.transaction(() => {
            if (b.ok) {
                stats.beacon.ok++;
                if (it.dead) stats.beacon.revived++;
                q('UPDATE adult_items SET dead=0, ok_at=?, dead_at=NULL WHERE site=? AND vod_id=?').run(t, site, vid);
                q('DELETE FROM adult_line_fail WHERE site=? AND vod_id=?').run(site, vid);
                dead = false;
                let refresh = !!it.dead;
                const dur = Math.round(Number(b.dur));
                if (sameWk && !(it.dur > 0) && Number.isFinite(dur) && dur >= 1 && dur <= 12 * 3600) {
                    const others = q('SELECT dur FROM adult_items WHERE wk=? AND dur>0 AND NOT (site=? AND vod_id=?) LIMIT 200').all(it.wk, site, vid).map((x) => x.dur);
                    if (U.durCompatible(dur, U.median(others))) {
                        q('UPDATE adult_items SET dur=? WHERE site=? AND vod_id=?').run(dur, site, vid);
                        refresh = true;
                        stats.beacon.dur++;
                    }
                }
                if (refresh) refreshWork(it.wk);
                const w = Math.round(Number(b.w)), h = Math.round(Number(b.h));
                if (Number.isFinite(w) && Number.isFinite(h) && w >= 16 && h >= 16 && w <= 16384 && h <= 16384) {
                    const res = w + 'x' + h;
                    if (res !== it.res) { q('UPDATE adult_items SET res=? WHERE site=? AND vod_id=?').run(res, site, vid); stats.beacon.res++; }
                }
                // 第四阶段:画面方向(videoWidth/Height 学来的;宽高认得出就以宽高为准,否则收客户端给的 orient)→ 线路 + 作品方向。
                //   宽高是客户端报的、服务器没法核实(不拉 m3u8):每个上报者每 UTC 天最多改 orientBudget 条线路的方向,挡住一个人批量把横屏片
                //   报成竖屏挤进刷一刷的竖屏层;单条被乱报的,下一个真实播放的客户端量到真实宽高就改回来
                const ori = K.orientOf(b.w, b.h) || (K.ORIENTS.has(b.orient) ? b.orient : '');
                if (ori && ori !== (it.orient || '') && orientSpend(id, t)) {
                    q('UPDATE adult_items SET orient=? WHERE site=? AND vod_id=?').run(ori, site, vid);
                    stats.beacon.orient = (stats.beacon.orient || 0) + 1;
                    const wo = K.workOrient(q('SELECT orient FROM adult_items WHERE wk=?').all(it.wk).map((x) => x.orient));
                    q('UPDATE adult_works SET orient=? WHERE wk=?').run(wo, it.wk);
                }
            } else {
                stats.beacon.fail++;
                q('INSERT OR REPLACE INTO adult_line_fail (site, vod_id, who, at) VALUES (?, ?, ?, ?)').run(site, vid, id, t);
                const since = Math.max(t - C.deadWindowMs, it.ok_at || 0);
                const n = q('SELECT COUNT(*) n FROM adult_line_fail WHERE site=? AND vod_id=? AND at >= ?').get(site, vid, since).n;
                if (n >= C.deadTokens && !it.dead) {
                    q('UPDATE adult_items SET dead=1, dead_at=? WHERE site=? AND vod_id=?').run(t, site, vid);
                    stats.beacon.dead++;
                    dead = true;
                    refreshWork(it.wk);   // 活线路少了一条:vis / live_sites 跟着变
                }
                q('DELETE FROM adult_line_fail WHERE site=? AND vod_id=? AND at < ?').run(site, vid, t - 2 * C.deadWindowMs);
            }
        })();
        return { ok: true, dead };
    }

    // ---------- 保留期(全量历史:线路按健康过期,作品保留) ----------
    function retention({ t, keep, siteKeys }) {
        if (rescanPending) return 0;
        const ids = [];
        for (const r of q('SELECT id, wk FROM adult_items WHERE dead=1 AND dead_at < ? LIMIT 20000').all(t - C.deadExpireMs)) ids.push(r);
        // 站点表里删掉的站:连续 7 天不在才删它的线路(站点表暂时拉不到 = 空表 → 什么都不做)
        if (Array.isArray(siteKeys) && siteKeys.length) {
            const present = new Set(siteKeys);
            const known = q(`WITH RECURSIVE s(site) AS (SELECT MIN(site) FROM adult_items UNION ALL SELECT (SELECT MIN(site) FROM adult_items WHERE site > s.site) FROM s WHERE s.site IS NOT NULL)
                             SELECT site FROM s WHERE site IS NOT NULL`).all().map((r) => r.site);
            for (const k of known) {
                const mk = 'gone:' + k;
                if (present.has(k)) { if (getMeta(mk) != null) q('DELETE FROM adult_meta WHERE k=?').run(mk); continue; }
                const since = Number(getMeta(mk)) || 0;
                if (!since) { setMeta(mk, t); continue; }
                if (t - since < C.siteGoneMs) continue;
                for (const r of q('SELECT id, wk FROM adult_items WHERE site=? LIMIT 20000').all(k)) ids.push(r);
            }
        }
        let n = 0;
        d.transaction(() => {
            const dirty = new Set();
            for (const r of ids) {
                const it = q('SELECT site, vod_id FROM adult_items WHERE id=?').get(r.id);
                if (!it) continue;
                q('DELETE FROM adult_items WHERE id=?').run(r.id);
                q('DELETE FROM adult_items_raw WHERE id=?').run(r.id);
                q('DELETE FROM adult_line_fail WHERE site=? AND vod_id=?').run(it.site, it.vod_id);
                dirty.add(r.wk);
                n++;
            }
            for (const wk of dirty) refreshWork(wk);
            q('DELETE FROM adult_expand WHERE at < ?').run(t - Math.max(C.expandNegMs, C.expandPosMs));
            q('DELETE FROM adult_hits WHERE NOT EXISTS (SELECT 1 FROM adult_items i WHERE i.site = adult_hits.site AND i.vod_id = adult_hits.vod_id)').run();
            q('DELETE FROM adult_line_fail WHERE at < ?').run(t - 2 * C.deadWindowMs);
            heatW.retention(t);   // 第四阶段:热度去重键 2 天过期、作品没了的热度行
        })();
        stats.retention = { at: t, deleted: n, keep: Array.isArray(keep) ? keep.length : 0 };
        if (n) logFn('保留期清理 ' + n + ' 条线路(判死 >30 天 / 站点已删除)');
        return n;
    }

    // ---------- 规则版本变了:全库按新规则重跑(分块,块间让出事件循环) ----------
    function rawItemOf(row) {
        const r = rawFrom(row.raw);
        if (!r) return null;
        return {
            vod_id: row.vod_id, vod_name: r.n, vod_sub: r.s, vod_content: r.c, vod_blurb: r.b, type_id: r.t, type_name: r.tn,
            vod_tag: r.tg, vod_class: r.cl, vod_remarks: r.rm, vod_duration: r.du, vod_time: r.tm, vod_pic: r.p,
            vod_play_from: r.pf, vod_play_url: row.play_url, vod_actor: r.a, vod_director: r.dr, vod_area: r.ar,
        };
    }
    // 一行已入库的线路按现在的规则重跑一遍;不合格 → 删掉。返回 true = 还在
    function reingestRow(row, sitesAll, crawledApi) {
        const s = sitesAll.get(row.site);
        const cmap = s ? (classMap(s.api) || (crawledApi.get(s.key) ? classMap(crawledApi.get(s.key)) : null)) : null;
        const raw = rawItemOf(row);
        let r = { ok: false };
        if (s && cmap && raw) {
            try { r = ingestItem(s, raw, { src: row.src || 'crawl', cmap, now: row.last_seen, playAt: row.play_at }); }
            catch (e) { r = { ok: false }; }
        }
        if (!r.ok) {
            q('DELETE FROM adult_items WHERE id=?').run(row.id);
            q('DELETE FROM adult_items_raw WHERE id=?').run(row.id);
            refreshWork(row.wk, { dropEmpty: true });
            return false;
        }
        return true;
    }
    // 不再整库回空(全量历史 ~340 万行按 4k 行/秒要十几分钟):旧代(rv < GEN)的行读接口本来就读不到(common.js ELIG),
    //   这里逐块按新规则重跑,跑完一块那一块就可读;爬虫 / 回填 / 搜索回写照常(新入库的就是新一代)。
    //   A 段:可见作品按"最新上架"倒序,一次 rescanWorks 部、连同它们全部旧代线路 —— 首页 / 浏览从最新的开始几秒内亮起来;
    //   B 段:剩下的旧代线路(不可见作品的、作品键挪了的…)按 id 扫完。进度记在 adult_meta 'rv:cur',重启从断点续(重跑过的行 rv 已是新代,不会再跑)
    function rescan({ sites }) {
        if (rescanP) return rescanP;
        rescanP = (async () => {
            const sitesAll = new Map((Array.isArray(sites) ? sites : []).filter(Boolean).map((s) => [s.key, s]));
            // 站点配置还没加载(远程表没拉到 / 空)→ 不重扫(否则会把所有行当"站点已删除"删光),旧代的行继续读不到,下一轮再试
            if (!sitesAll.size) { warn('rescan', 'site list empty, rescan deferred'); return { deferred: true }; }
            const crawledApi = new Map(q('SELECT site, api FROM adult_crawl_state').all().map((r) => [r.site, r.api]));
            let checked = 0, dropped = 0;
            const t0 = Date.now();
            // 第四阶段:重扫进行中规则又变了(站长改追加屏蔽词 → bumpGen):这一轮从头按最新一代重跑(否则 A 段已经走过的作品会停在旧一代、永远读不到)
            for (;;) {
                const ep = rescanEpoch;
                let cur = null;
                try { cur = JSON.parse(getMeta('rv:cur') || 'null'); } catch (_) { cur = null; }
                if (!cur || typeof cur !== 'object') cur = { p: 'a' };
                stats.rescan = { running: true, gen: GEN, phase: cur.p, checked, dropped };
                const run = (rows, mark) => {
                    avCache.clear();
                    d.transaction(() => {
                        for (const row of rows) { checked++; if (!reingestRow(row, sitesAll, crawledApi)) dropped++; }
                        setMeta('rv:cur', JSON.stringify(mark));
                    })();
                    Object.assign(stats.rescan, { phase: mark.p, checked, dropped });
                };
                if (cur.p !== 'b') {
                    let fs = Number.isFinite(cur.fs) ? cur.fs : null, wid = Number.isFinite(cur.id) ? cur.id : null;
                    for (;;) {
                        if (ep !== rescanEpoch) break;
                        const works = fs == null
                            ? q('SELECT id, wk, first_seen FROM adult_works WHERE vis = 1 ORDER BY first_seen DESC, id DESC LIMIT ?').all(C.rescanWorks || 100)
                            : q('SELECT id, wk, first_seen FROM adult_works WHERE vis = 1 AND (first_seen, id) < (?, ?) ORDER BY first_seen DESC, id DESC LIMIT ?').all(fs, wid, C.rescanWorks || 100);
                        if (!works.length) break;
                        const rows = [];
                        for (const w of works) for (const r of q('SELECT i.*, x.raw FROM adult_items i LEFT JOIN adult_items_raw x ON x.id = i.id WHERE i.wk=? AND i.rv < ?').all(w.wk, GEN)) rows.push(r);
                        const lw = works[works.length - 1];
                        fs = lw.first_seen; wid = lw.id;
                        run(rows, { p: 'a', fs, id: wid });
                        await yieldTick();
                    }
                    if (ep !== rescanEpoch) continue;
                    cur = { p: 'b', id: 0 };
                    setMeta('rv:cur', JSON.stringify(cur));
                }
                let last = Number(cur.id) || 0;
                for (;;) {
                    if (ep !== rescanEpoch) break;
                    const rows = q('SELECT i.*, x.raw FROM adult_items i LEFT JOIN adult_items_raw x ON x.id = i.id WHERE i.id > ? AND i.rv < ? ORDER BY i.id LIMIT ?').all(last, GEN, C.rescanChunk);
                    if (!rows.length) break;
                    last = rows[rows.length - 1].id;
                    run(rows, { p: 'b', id: last });
                    await yieldTick();
                }
                if (ep === rescanEpoch) break;
            }
            setMeta('rules', RULES);
            setMeta('rv:cur', null);
            rescanPending = false;
            stats.rescan = { running: false, gen: GEN, checked, dropped, ms: Date.now() - t0 };
            logFn(`规则版本 ${RULES}(第 ${GEN} 代):重扫 ${checked} 条,删除 ${dropped} 条,${Math.round((Date.now() - t0) / 1000)}s`);
            return { checked, dropped };
        })().catch((e) => { warn('rescan', 'failed, rows of the old rules stay hidden until retried: ' + e.message); if (stats.rescan) stats.rescan.running = false; return { error: e.message }; })
            .finally(() => { rescanP = null; });
        return rescanP;
    }

    // ---------- AVDB 有新数据:签名变了的番号重跑(拦截 / 可信度 / 片段 / 封面 / 发行日期 / 演员) ----------
    let avdbNext = null;
    function avdbCheck(args) {
        // 正在复核:等它跑完再按最新的 AVDB 状态复核一次(不要把旧那轮的结果当成这次的)
        if (avdbP) { if (!avdbNext) avdbNext = avdbP.then(() => { avdbNext = null; return avdbCheck(args); }); return avdbNext; }
        return avdbRun(args || {});
    }
    function avdbRun({ t, sites, force }) {
        const inst = getAvdb();
        if (!inst || typeof inst.lookup !== 'function' || rescanPending) return { ran: false };
        let st = null;
        try { st = typeof inst.stats === 'function' ? inst.stats() : null; } catch (_) { st = null; }
        // 签名带上政策规则版本(polv:部署收紧了 AVDB 政策 → 行数/时间都没变也要复核)和政策戳(polchg:有带等级的行进来了)
        const pchg = st && st.polchg != null ? String(st.polchg) : '';
        const sig = st ? [st.rows, st.lastFull, st.lastDelta, st.polv || '', pchg].join('|') : 'x';
        const lastRun = Number(getMeta('avdb:run')) || 0;
        if (!force && getMeta('avdb:seen') === sig) return { ran: false };
        // 全量爬取中:最多 30 分钟复核一次;政策戳 / 规则版本变了(有新拦截)缩到 10 分钟。
        //   列表里的标题不靠这里挡:主线程出口复查(index.js blockedWk)1 秒内生效,这里只是让计数 / 分面跟上
        const polSig = [st && st.polv || '', pchg].join('|');
        if (!force && st && st.crawling && t - lastRun < (getMeta('avdb:pol') === polSig ? 30 : 10) * MIN) return { ran: false, crawling: true };
        avdbP = (async () => {
            const sitesAll = new Map((Array.isArray(sites) ? sites : []).filter(Boolean).map((s) => [s.key, s]));
            const crawledApi = new Map(q('SELECT site, api FROM adult_crawl_state').all().map((r) => [r.site, r.api]));
            let last = '', keys = 0, changed = 0, deferred = false;
            for (;;) {
                const rows = q('SELECT ckey, sig FROM adult_avsig WHERE ckey > ? ORDER BY ckey LIMIT 400').all(last);
                if (!rows.length) break;
                avCache.clear();
                let many = null;
                try { many = typeof inst.lookupMany === 'function' ? inst.lookupMany(rows.map((r) => r.ckey)) : null; } catch (_) { many = null; }
                if (many instanceof Map) for (const [k, v] of many) avCache.set(k, v && typeof v === 'object' ? v : null);
                const diff = rows.filter((r) => avSig(av(r.ckey)) !== r.sig);
                if (diff.length && !sitesAll.size) deferred = true;   // 站点表还没加载:这些番号这轮重跑不了,不记"已复核"
                if (diff.length && sitesAll.size) {
                    d.transaction(() => {
                        for (const r of diff) {
                            const items = q('SELECT i.*, x.raw FROM adult_items i LEFT JOIN adult_items_raw x ON x.id = i.id WHERE i.ckey=?').all(r.ckey);
                            for (const row of items) if (!reingestRow(row, sitesAll, crawledApi)) stats.avdb.blockedDropped++;
                            q('INSERT OR REPLACE INTO adult_avsig (ckey, sig) VALUES (?, ?)').run(r.ckey, avSig(av(r.ckey)));
                        }
                    })();
                }
                keys += rows.length;
                if (sitesAll.size) changed += diff.length;
                last = rows[rows.length - 1].ckey;
                await yieldTick();
            }
            if (!deferred) { setMeta('avdb:seen', sig); setMeta('avdb:pol', polSig); }
            else warn('avdbCheck', 'site list empty, re-evaluation deferred');
            setMeta('avdb:run', t);
            stats.avdb.reeval++;
            stats.avdb.keys = keys;
            stats.avdb.changed += changed;
            if (changed) logFn(`AVDB 复核:${keys} 个番号,${changed} 个有变化已重跑`);
            return { ran: true, keys, changed, deferred };
        })().catch((e) => { warn('avdbCheck', e.message); return { ran: false, error: e.message }; })
            .finally(() => { avdbP = null; });
        return avdbP;
    }

    // ---------- 维护 ----------
    function optimize({ analyze, checkpoint }) {
        const out = {};
        try { if (analyze) { d.exec('ANALYZE'); out.analyze = true; } } catch (e) { warn('analyze', e.message); }
        try { d.pragma('optimize'); out.optimize = true; } catch (e) { warn('optimize', e.message); }
        try { if (checkpoint) out.checkpoint = d.pragma('wal_checkpoint(' + (checkpoint === 'truncate' ? 'TRUNCATE' : 'PASSIVE') + ')'); } catch (e) { warn('checkpoint', e.message); }
        return out;
    }
    function counts() {
        return {
            items: q('SELECT COUNT(*) n FROM adult_items').get().n,
            works: q('SELECT COUNT(*) n FROM adult_works').get().n,
            visible: q('SELECT COUNT(*) n FROM adult_works WHERE vis=1').get().n,
            deadLines: q('SELECT COUNT(*) n FROM adult_items WHERE dead=1').get().n,
            hitsRows: q('SELECT COUNT(*) n FROM adult_hits').get().n,
            hidden: q('SELECT COUNT(*) n FROM adult_hidden').get().n,
            heatRows: q('SELECT COUNT(*) n FROM adult_heat').get().n,
        };
    }
    // 新的一代规则:旧行立刻读不到(ELIG 的 rv ≥ 代数),重扫逐块按新规则放出来;库是空的就直接记成已重扫
    function bumpGen() {
        if (!q('SELECT 1 FROM adult_items LIMIT 1').get()) { setMeta('rules', RULES); setMeta('rv:rules', RULES); return false; }
        GEN += 1;
        d.transaction(() => { setMeta('rv:gen', GEN); setMeta('rv:rules', RULES); setMeta('rv:cur', null); })();
        rescanPending = true;
        rescanEpoch++;
        return true;
    }
    // 站长追加屏蔽词(adult_meta 'admin:block',JSON 数组)→ 本线程的 policy 实例。坏了 = 保持现有词表(不放松)并告警
    function loadExtraBlock() {
        if (typeof P.setExtraBlock !== 'function') return null;
        const v = getMeta('admin:block');
        if (v == null) return null;
        try { const words = JSON.parse(v); if (Array.isArray(words)) { P.setExtraBlock(words); nameMemo.clear(); return words; } } catch (e) { warn('admin:block', e.message); }
        return null;
    }
    function init() {
        const s = SCH.initSchema(d);
        ftsOk = s.fts;
        bigramOk = s.bigram;
        loadExtraBlock();
        RULES = rulesNow();
        // 规则代数:'rv:rules' = 当前代代表的规则('rules' = 已经全库重跑完的规则)。
        //   代表的规则 ≠ 现在的规则 → 新的一代(旧行立刻读不到,重扫逐块放出来);同一套规则重启 → 接着重扫,不加代。
        //   (半路回滚到上一套规则也是"代表的规则不同":再加一代全部重跑 —— 不会把按别的规则判过的行当成已复查)
        GEN = Number(getMeta('rv:gen')) || 0;
        const rawGen = getMeta('rv:rules'), rawDone = getMeta('rules');
        const genRules = noX(rawGen), doneRules = noX(rawDone);
        if ((genRules != null ? genRules : doneRules) !== RULES) bumpGen();
        else {
            // 旧写法的记录(带词表哈希)改成新写法;同一套内置规则 → 不加代
            if (rawGen != null && rawGen !== genRules) setMeta('rv:rules', genRules);
            if (rawDone != null && rawDone !== doneRules) setMeta('rules', doneRules);
            if (doneRules !== RULES) rescanPending = true;
        }
        let extra = null;
        try { extra = typeof P.extraBlock === 'function' ? P.extraBlock() : null; } catch (_) { extra = null; }
        // 上次没删完的追加词扫描(重启续扫);词表已空 = 不用扫了
        let purgePending = getMeta('admin:purge') != null;
        if (purgePending && !(extra && extra.n > 0)) { setMeta('admin:purge', null); purgePending = false; }
        // 封面域名健康:按存下来的死域名挑封面;还没按它(或这一版口径)挑完 → 调用方随后 coverApply
        coverLoad();
        return { rescanPending, purgePending, coverPending: coverPending(), fts: ftsOk, bigram: bigramOk, rules: RULES, gen: GEN, extraBlock: extra };
    }

    // ---------- 第四阶段:后台(只会更严) ----------
    // 追加屏蔽词:本线程 policy 换词表 → 存 adult_meta 'admin:block'。不加代、不重扫(见 rulesNow 注释)。
    //   有新词(上次存的词表里没有的)→ 记下要删命中线路(adult_meta 'admin:purge',调用方随后 extraPurge);正在删的那一轮按新词表从头来。
    //   只删词 / 清空 → 不扫(之前删掉的线路不会自己回来:爬虫 / 搜索回写再遇到时按新词表重新入库)。
    //   词表不合法 → 抛错(policy.setExtraBlock),什么都不改
    function setExtraBlockOp({ words }) {
        if (typeof P.setExtraBlock !== 'function') throw new Error('policy has no setExtraBlock');
        // 和"上次存下来的词表"比(inline 模式下主线程和这里共用一个 policy 实例,它已经换成新词表了);读不出来 = 全当新词
        let before = [];
        try { const v = getMeta('admin:block'); const a = v ? JSON.parse(v) : []; before = Array.isArray(a) ? a : []; } catch (_) { before = []; }
        const x = P.setExtraBlock(words);
        setMeta('admin:block', JSON.stringify(x.words));
        nameMemo.clear();
        avCache.clear();
        const old = new Set(before);
        const added = x.words.filter((w) => !old.has(w));
        let purge = false;
        if (x.n > 0 && (added.length > 0 || getMeta('admin:purge') != null)) {
            setMeta('admin:purge', JSON.stringify({ rev: x.rev, p: 'i', id: 0 }));
            purgeEpoch++;
            purge = true;
        } else if (!(x.n > 0)) setMeta('admin:purge', null);
        return { n: x.n, rev: x.rev, words: x.words, rescanPending, purge, bumped: false, gen: GEN, rules: RULES };
    }
    // 追加屏蔽词的删除扫描(只在加了新词后跑;进度 adult_meta 'admin:purge' = {rev, p:'i'|'w', id},重启续扫;扫的中途词表又变了 → 从头按新词表):
    //   i 段:线路按 id 逐块,标签性字段(和 policy.checkItem 查追加词的字段相同:片名 / 副名 / 分类名 / 标签 / 类别 / 备注)命中追加词的
    //        直接删掉(按现在的规则它一定入不了库),作品重算(线路全没了 → 作品一起删,和规则重扫同口径);
    //   w 段:作品名命中追加词的可见作品重算(作品名冻结在第一条线路上;vis 按 workNameOk 变 0,快照里就不再有它)。
    //   读接口在扫完之前靠主线程出口按片名拦,所以这里慢慢扫,其它作品的可见性一点不受影响
    let purgeP = null, purgeEpoch = 0;
    function extraRowHit(row) {
        const r = rawFrom(row.raw);
        const it = r ? { vod_name: r.n, vod_sub: r.s, type_name: r.tn, vod_tag: r.tg, vod_class: r.cl, vod_remarks: r.rm }
            : { vod_name: row.name || '', type_name: row.type_name || '' };
        if (typeof P.extraHitItem === 'function') return !!P.extraHitItem(it);   // 出错 = 命中(policy 里 fail-closed)
        for (const f of [it.vod_name, it.vod_sub, it.type_name, it.vod_tag, it.vod_class, it.vod_remarks]) if (f && P.extraHit(String(f))) return true;
        return false;
    }
    function extraPurge() {
        if (purgeP) return purgeP;
        purgeP = (async () => {
            const t0 = Date.now();
            let checked = 0, dropped = 0, works = 0, rev = '';
            const chunk = Math.max(1, Number(C.purgeChunk) || 500);
            for (;;) {
                const ep = purgeEpoch;
                let cur = null;
                try { cur = JSON.parse(getMeta('admin:purge') || 'null'); } catch (_) { cur = { p: 'i', id: 0 }; }
                if (!cur || typeof cur !== 'object') break;
                let x = null;
                try { x = typeof P.extraBlock === 'function' ? P.extraBlock() : null; } catch (_) { x = null; }
                if (!x || !(x.n > 0)) { setMeta('admin:purge', null); break; }
                rev = x.rev;
                stats.purge = { running: true, rev, phase: cur.p === 'w' ? 'w' : 'i', checked, dropped, works };
                if (cur.p !== 'w') {
                    let last = Number(cur.id) || 0;
                    for (;;) {
                        if (ep !== purgeEpoch) break;
                        const rows = q('SELECT i.id, i.wk, i.name, i.type_name, x.raw FROM adult_items i LEFT JOIN adult_items_raw x ON x.id = i.id WHERE i.id > ? ORDER BY i.id LIMIT ?').all(last, chunk);
                        if (!rows.length) break;
                        last = rows[rows.length - 1].id;
                        d.transaction(() => {
                            const touched = new Set();
                            for (const row of rows) {
                                checked++;
                                if (!extraRowHit(row)) continue;
                                q('DELETE FROM adult_items WHERE id=?').run(row.id);
                                q('DELETE FROM adult_items_raw WHERE id=?').run(row.id);
                                touched.add(row.wk);
                                dropped++;
                                bump(stats.rejected, 'item:admin');
                            }
                            for (const wk of touched) refreshWork(wk, { dropEmpty: true });
                            setMeta('admin:purge', JSON.stringify({ rev, p: 'i', id: last }));
                        })();
                        Object.assign(stats.purge, { checked, dropped });
                        await yieldTick();
                    }
                    if (ep !== purgeEpoch) continue;
                    cur = { p: 'w', id: 0 };
                    setMeta('admin:purge', JSON.stringify({ rev, p: 'w', id: 0 }));
                    stats.purge.phase = 'w';
                }
                let lastW = Number(cur.id) || 0;
                for (;;) {
                    if (ep !== purgeEpoch) break;
                    const ws = q('SELECT id, wk, name FROM adult_works WHERE id > ? AND vis = 1 ORDER BY id LIMIT ?').all(lastW, chunk * 4);
                    if (!ws.length) break;
                    lastW = ws[ws.length - 1].id;
                    const hit = ws.filter((w) => { try { return !!P.extraHit(String(w.name || '')); } catch (_) { return true; } });
                    d.transaction(() => {
                        for (const w of hit) { refreshWork(w.wk); works++; }
                        setMeta('admin:purge', JSON.stringify({ rev, p: 'w', id: lastW }));
                    })();
                    stats.purge.works = works;
                    await yieldTick();
                }
                if (ep !== purgeEpoch) continue;
                setMeta('admin:purge', null);
                break;
            }
            stats.purge = { running: false, rev, checked, dropped, works, ms: Date.now() - t0 };
            if (checked) logFn(`追加屏蔽词扫描:查 ${checked} 条线路,删除 ${dropped} 条,重算作品 ${works} 部,${Math.round((Date.now() - t0) / 1000)}s`);
            return { checked, dropped, works };
        })().catch((e) => { warn('extraPurge', 'failed, retried on next change / restart: ' + e.message); if (stats.purge) stats.purge.running = false; return { error: e.message }; })
            .finally(() => { purgeP = null; });
        return purgeP;
    }
    // 分享链接短码(#/v/<码>):一部作品一个码(已有就用原来的),10 位 base62 随机;连同当时的片名 / 时长记下 ——
    //   规则重扫后作品键变了,读的那边(index.js shareResolve)按片名找回同一部。只存作品,不存谁分享的
    const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    function shareCode({ wk, name, dur, t }) {
        if (typeof wk !== 'string' || !/^[ct]:./.test(wk) || wk.length > 300) return null;
        const ex = q('SELECT code FROM adult_share WHERE wk=? ORDER BY at, code LIMIT 1').get(wk);
        if (ex) return ex.code;
        for (let k = 0; k < 5; k++) {
            const b = require('crypto').randomBytes(10);
            let code = '';
            for (let i = 0; i < 10; i++) code += B62[b[i] % 62];
            try {
                q('INSERT INTO adult_share (code, wk, name, dur, at) VALUES (?, ?, ?, ?, ?)').run(code, wk, String(name || '').slice(0, 300), Math.max(0, Math.round(Number(dur) || 0)), Number(t) || Date.now());
                return code;
            } catch (e) { if (!/UNIQUE|constraint/i.test(String(e && e.message))) throw e; }
        }
        return null;
    }
    // 隐藏 / 取消隐藏一个作品(adult_hidden 是真相,adult_works.hid 跟着;ELIG 带 hid=0)。作品还不存在也记下(以后出现就是藏着的)
    function adminHide({ wk, on, t }) {
        if (typeof wk !== 'string' || !/^[ct]:./.test(wk) || wk.length > 300) return { ok: false, reason: 'invalid' };
        const w = q('SELECT name FROM adult_works WHERE wk=?').get(wk);
        d.transaction(() => {
            if (on) {
                q('INSERT OR REPLACE INTO adult_hidden (wk, name, at) VALUES (?, ?, ?)').run(wk, w ? w.name : null, Number(t) || 0);
                q('UPDATE adult_works SET hid=1 WHERE wk=?').run(wk);
            } else {
                q('DELETE FROM adult_hidden WHERE wk=?').run(wk);
                q('UPDATE adult_works SET hid=0 WHERE wk=?').run(wk);
            }
        })();
        return { ok: true, wk, hidden: !!on, known: !!w };
    }

    // ---------- 封面域名健康(主线程按 DNS 判死活,这里只按死域名挑封面) ----------
    //   作品的 pic / pic_item / pic_alt / cov 由 CH.pickCover 定(refreshWork 每次重算都按当前死域名表)。
    //   死域名表一变(死了 / 复活):coverApply 在本线程里分块重挑受影响的作品(轻量:只读线路的封面列、只写变了的行,
    //   每块一个事务、块间让出,入库照常插进来);不动规则代数、不触发规则重扫。
    //   进度:adult_meta 'cover:applied' = {rev, dead:'已经按它挑过的死域名(排序、逗号)'};和现在的死域名表 / COVER_REV 不同 = 还要重挑:
    //     COVER_REV 不同(升级后第一次)→ 全部作品按 id 逐块重挑('cover:job' 记进度,重启续);否则 → 只重挑变了的域名上有封面的作品
    //     (线路按 id 逐块扫封面域名 + 作品的 AVDB 封面域名)。重挑途中死域名表又变了 → 从头按新表来,
    //     而且被打断那几轮动过的域名('cover:touch',落库、重启也在)一并再扫 —— 表变回"已挑过"的样子(死了又活)也一样
    let coverEpoch = 0, coverP = null;
    function coverLoad() {
        coverDead = COVER_ON ? CH.deadSet(CH.parseState(getMeta('cover:hosts')), { sf: !!C.coverServfailDead }) : new Set();
    }
    const coverKey = () => [...coverDead].sort().join(',');
    function coverApplied() {
        try { const a = JSON.parse(getMeta('cover:applied') || 'null'); return a && typeof a === 'object' ? a : null; } catch (_) { return null; }
    }
    // 'cover:touch':按域名重挑开始前记下这一轮要扫的域名(重挑完清掉)。被打断(死域名表中途又变了 / 进程重启)时,
    //   这些域名上的作品可能是按中间那张表挑的 —— 哪怕表又变回了"已挑过"的样子(死了又活),下一轮也要把它们再扫一遍
    function coverTouched() {
        try { const a = JSON.parse(getMeta('cover:touch') || 'null'); return Array.isArray(a) ? a.filter((h) => typeof h === 'string' && h) : []; } catch (_) { return []; }
    }
    function coverPending() { const a = coverApplied(); return !a || a.rev !== CH.COVER_REV || a.dead !== coverKey() || coverTouched().length > 0; }
    // 主线程一轮检查完 → 存状态、换死域名表。→ {changed, pending, dead}
    function coverHosts({ state }) {
        const s = CH.parseState(state);
        setMeta('cover:hosts', CH.dumpState(s));
        const before = coverKey();
        coverDead = COVER_ON ? CH.deadSet(s, { sf: !!C.coverServfailDead }) : new Set();
        const changed = coverKey() !== before;
        if (changed) coverEpoch++;
        return { changed, pending: coverPending(), dead: [...coverDead] };
    }
    // 目录里的封面域名及封面数(线路封面 + AVDB 封面),多的在前,≤ max 个。分块扫、块间让出
    async function coverScan({ max }) {
        const cnt = new Map();
        const add = (u) => { const h = CH.hostOf(u); if (h) cnt.set(h, (cnt.get(h) || 0) + 1); };
        const chunk = Math.max(100, (Number(C.coverChunk) || 500) * 10);
        let last = 0;
        for (;;) {
            const rows = q("SELECT id, pic FROM adult_items WHERE id > ? ORDER BY id LIMIT ?").all(last, chunk);
            if (!rows.length) break;
            last = rows[rows.length - 1].id;
            for (const r of rows) if (r.pic) add(r.pic);
            await yieldTick();
        }
        last = 0;
        for (;;) {
            const rows = q("SELECT id, apic FROM adult_works WHERE id > ? AND apic IS NOT NULL AND apic <> '' ORDER BY id LIMIT ?").all(last, chunk);
            if (!rows.length) break;
            last = rows[rows.length - 1].id;
            for (const r of rows) add(r.apic);
            await yieldTick();
        }
        return [...cnt].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, Math.max(1, Number(max) || 500));
    }
    const COVER_COLS = 'id, wk, pic, pic_item, pic_alt, apic, cov';
    // 重挑这批作品的封面(行 = COVER_COLS)。只写变了的行;一条线路都没有的作品(全量历史里线路过期了)封面列不动、只按死域名重算 cov。→ 改了几部
    function coverFix(ws) {
        if (!ws.length) return 0;
        const byWk = new Map(ws.map((w) => [w.wk, []]));
        for (let k = 0; k < ws.length; k += 400) {
            const part = ws.slice(k, k + 400);
            for (const r of q(`SELECT wk, site, vod_id, pic, last_seen FROM adult_items WHERE wk IN (${part.map(() => '?').join(',')})`).all(...part.map((w) => w.wk))) {
                const l = byWk.get(r.wk);
                if (l) l.push(r);
            }
        }
        const isDead = (u) => coverDead.size > 0 && coverDead.has(CH.hostOf(u));
        let n = 0;
        for (const w of ws) {
            const rows = byWk.get(w.wk) || [];
            let pic = w.pic || '', item = w.pic_item || null, alt = w.pic_alt || '', cov;
            if (rows.length) { const c = CH.pickCover(rows, w.apic, coverDead); pic = c.pic; item = c.item; alt = c.alt; cov = c.cov; }
            else cov = (pic && !isDead(pic)) || (typeof w.apic === 'string' && /^https?:\/\//i.test(w.apic) && !isDead(w.apic)) ? 1 : 0;
            if (pic === (w.pic || '') && item === (w.pic_item || null) && alt === (w.pic_alt || '') && cov === w.cov) continue;
            q('UPDATE adult_works SET pic=?, pic_item=?, pic_alt=?, cov=? WHERE id=?').run(pic, item, alt, cov, w.id);
            n++;
        }
        return n;
    }
    function coverApply() {
        if (coverP) return coverP;
        coverP = (async () => {
            const t0 = Date.now();
            const chunk = Math.max(1, Number(C.coverChunk) || 500);
            let works = 0, changed = 0, scanned = 0, mode = '';
            for (let round = 0; round < 100; round++) {
                const ep = coverEpoch;
                if (!coverPending()) break;
                const a = coverApplied();
                const key = coverKey();
                const moved = () => ep !== coverEpoch;
                if (!a || a.rev !== CH.COVER_REV) {
                    mode = 'all';
                    let job = null;
                    try { job = JSON.parse(getMeta('cover:job') || 'null'); } catch (_) { job = null; }
                    let last = job && job.rev === CH.COVER_REV && job.dead === key ? Number(job.id) || 0 : 0;
                    for (;;) {
                        if (moved()) break;
                        const ws = q(`SELECT ${COVER_COLS} FROM adult_works WHERE id > ? ORDER BY id LIMIT ?`).all(last, chunk);
                        if (!ws.length) break;
                        last = ws[ws.length - 1].id;
                        d.transaction(() => { changed += coverFix(ws); setMeta('cover:job', JSON.stringify({ rev: CH.COVER_REV, dead: key, id: last })); })();
                        works += ws.length;
                        stats.cover = { running: true, mode, works, changed, scanned };
                        await yieldTick();
                    }
                } else {
                    mode = 'hosts';
                    const prev = new Set(String(a.dead || '').split(',').filter(Boolean));
                    // 要扫的域名 = 上次挑过的表 Δ 现在的表 ∪ 之前被打断的几轮(本次调用里 / 上次进程)已经动过的域名(见 coverTouched)。
                    //   先记下来再动作品:中途被打断(表又变了 / 重启),下一轮照样把这些域名上的作品按最新的表重挑一遍
                    const D = new Set(coverTouched());
                    for (const h of prev) if (!coverDead.has(h)) D.add(h);
                    for (const h of coverDead) if (!prev.has(h)) D.add(h);
                    if (D.size) setMeta('cover:touch', JSON.stringify([...D].slice(0, 5000)));
                    const done = new Set();
                    let pend = [];
                    const flush = async () => {
                        while (pend.length) {
                            const part = pend.splice(0, chunk);
                            const ws = q(`SELECT ${COVER_COLS} FROM adult_works WHERE wk IN (${part.map(() => '?').join(',')})`).all(...part);
                            d.transaction(() => { changed += coverFix(ws); })();
                            works += ws.length;
                            await yieldTick();
                        }
                    };
                    const take = (wk) => { if (!done.has(wk)) { done.add(wk); pend.push(wk); } };
                    const scan = async (sql, col) => {
                        let last = 0;
                        for (;;) {
                            if (moved()) return;
                            const rows = q(sql).all(last, chunk * 10);
                            if (!rows.length) break;
                            last = rows[rows.length - 1].id;
                            scanned += rows.length;
                            for (const r of rows) if (r[col] && D.has(CH.hostOf(r[col]))) take(r.wk);
                            if (pend.length >= chunk) await flush();
                            stats.cover = { running: true, mode, works, changed, scanned };
                            await yieldTick();
                        }
                        await flush();
                    };
                    if (D.size) {
                        await scan('SELECT id, wk, pic FROM adult_items WHERE id > ? ORDER BY id LIMIT ?', 'pic');
                        await scan("SELECT id, wk, apic FROM adult_works WHERE id > ? AND apic IS NOT NULL AND apic <> '' ORDER BY id LIMIT ?", 'apic');
                    }
                }
                if (moved()) continue;
                d.transaction(() => { setMeta('cover:applied', JSON.stringify({ rev: CH.COVER_REV, dead: key })); setMeta('cover:job', null); setMeta('cover:touch', null); })();
                break;
            }
            const ms = Date.now() - t0;
            stats.cover = { running: false, mode, works, changed, scanned, ms };
            if (changed) logFn(`封面域名:重挑 ${works} 部作品的封面(${mode}),${changed} 部有变化,${Math.round(ms / 1000)}s`);
            return { mode, works, changed, scanned, ms, dead: [...coverDead] };
        })().catch((e) => { warn('coverApply', 'failed, retried on next check / restart: ' + e.message); if (stats.cover) stats.cover.running = false; return { error: e.message }; })
            .finally(() => { coverP = null; });
        return coverP;
    }

    const OPS = {
        init, ingest, beacon, retention, rescan, avdbCheck, optimize, counts, setHot,
        // 封面域名健康
        coverHosts, coverScan, coverApply,
        // 第四阶段
        heatAdd: (a) => heatW.heatAdd(a), adminHide, setExtraBlock: setExtraBlockOp, extraPurge, shareCode,
        classes: saveClasses,
        classFail: ({ api, t }) => { q('INSERT INTO adult_class_state (api, fetched_at, ok) VALUES (?, ?, 0) ON CONFLICT(api) DO UPDATE SET fetched_at=excluded.fetched_at, ok=0').run(api, t); return true; },
        classForce: ({ api, t }) => { q('UPDATE adult_class_state SET fetched_at = MIN(fetched_at, ?) WHERE api=?').run(t - C.classMs + C.classRetryMs, api); return true; },
        state: saveState, backfill: saveBackfill, expandMark, hitsCand: hitsCandidates, planThin,
        meta: ({ k, v }) => { setMeta(k, v); return true; },
        stats: () => JSON.parse(JSON.stringify(Object.assign({ rescanPending, fts: ftsOk, bigram: bigramOk, rules: RULES, gen: GEN, heat: heatW.stats, coverDead: coverDead.size, coverPending: coverPending() }, stats))),
        avdbStats: () => { const i = getAvdb(); try { return i && typeof i.stats === 'function' ? i.stats() : null; } catch (_) { return null; } },
    };
    function handle(op, args) {
        const fn = OPS[op];
        if (!fn) throw new Error('unknown writer op ' + op);
        return fn(args || {});
    }
    return { handle, isRescanPending: () => rescanPending };
}

module.exports = { createWriter, INGEST_REV };
