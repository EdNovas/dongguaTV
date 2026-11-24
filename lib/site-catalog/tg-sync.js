'use strict';
// [adult] TG 频道同步:经中转的 /api/list 按消息 id 往后拉(第一次从频道第一条开始,之后只拉新的),
// 整理成 maccms 形状的条目,走目录同一套入库(硬过滤 / 合并 / 重扫都一样)。规则说明见 lib/adult/tg.js 顶上。
//   进度:adult_meta 'tg:<key>' = {cur, n, minor, sk:{short,notext,mime…}(累计不收), rej(累计入库被拦), ...}(目录重建会丢 → 从头重收,正好和被清空的线路对上)
//   停用:adult_meta 'admin:tg-kill:<key>'(admin:* 重建时原样搬回去,停用不会因为重建失效)
const TGL = require('../adult/tg');

const EVERY_MS = 10 * 60e3;
const FIRST_MS = 90e3;
const PAGES_PER_RUN = 20;          // 每个频道每轮最多拉 20 页(2000 条消息);老频道的历史分几轮收完
const ERR_BACKOFF_MS = [10 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3];
const TIMEOUT_MS = 45e3;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

function createTgSync(ctx) {
    const { tg, W, P, log, warn } = ctx;
    const nowFn = ctx.nowFn || Date.now;
    const fetchFn = ctx.fetch || globalThis.fetch;
    const runtime = new Map();      // key -> {err, errN, nextAt, ok, rej, skipped, at}
    let timer = null, running = null, started = false, stopped = false;   // stopped:stop() 之后在跑的这一轮收尾(kick 不 start 也能跑一轮)

    const meta = (k) => { try { return JSON.parse(ctx.getMeta(k) || 'null'); } catch (_) { return null; } };
    const loadState = (key) => Object.assign({ cur: 0, n: 0, minor: 0, sk: {}, rej: 0 }, meta('tg:' + key) || {});

    const relay = (path) => TGL.relayGet(tg.config(), path, { fetch: fetchFn, timeout: TIMEOUT_MS });

    // 启动时把已停用的频道告诉 tg(站点表里不再出现它们)
    function loadKills() {
        for (const c of tg.config().channels) {
            const k = meta('admin:tg-kill:' + c.key);
            if (k) tg.setKilled(c.key, k.why || 'killed');
        }
    }

    async function kill(chan, why, st) {
        await W('meta', { k: 'admin:tg-kill:' + chan.key, v: JSON.stringify({ at: nowFn(), why, minor: st ? st.minor : 0, n: st ? st.n : 0 }) });
        tg.setKilled(chan.key, why);
        let dropped = 0;
        try { const r = await W('purgeSite', { site: chan.key }); dropped = (r && r.dropped) || 0; } catch (e) { warn('tg', 'purge ' + chan.key + ': ' + e.message); }
        log(`TG 频道 ${chan.ch} 已停用(${why}),删掉已收的 ${dropped} 条`);
    }

    const className = (chan, title) => (chan.cls || String(title || '').replace(EMOJI_RE, ' ').replace(/\s+/g, ' ').trim() || chan.ch).slice(0, 60);

    async function syncChannel(chan) {
        if (tg.killedOf(chan.key) || meta('admin:tg-kill:' + chan.key)) { loadKills(); return { killed: true }; }
        const cfg = tg.config();
        const site = tg.sites().find((s) => s.key === chan.key);
        if (!site) return { skipped: true };
        const st = loadState(chan.key);
        // 收录规则改过(TGL.TG_RULES):从头再读一遍,计数也从头算(未成年比例要按新口径重算);已收的线路照样更新,不会重复
        if ((Number(st.rv) || 1) < TGL.TG_RULES) {
            if (st.cur) log(`TG ${chan.ch}:收录规则改到 v${TGL.TG_RULES},从头再读一遍`);
            Object.assign(st, { cur: 0, n: 0, minor: 0, sk: {}, rej: 0, rv: TGL.TG_RULES });
        }
        let page = await relay('/api/list?ch=' + encodeURIComponent(chan.ch) + '&after=' + st.cur + '&limit=100&info=1');
        const info = page.info || {};
        tg.setTitle(chan.key, info.title);
        // 频道名 / 简介过硬过滤:命中 = 整个频道停用
        let chk;
        try { chk = P.checkItem({ vod_name: info.title || chan.ch, vod_content: info.about || '', type_name: '' }, { strict: true, siteTrust: false }); } catch (_) { chk = { ok: false, reason: 'item:error' }; }
        if (!chk.ok && /^(item|category):/.test(chk.reason)) { await kill(chan, '频道名/简介 ' + chk.reason, st); return { killed: true }; }
        // 分类:配置的分类名,没配就用频道名(大类按它判:伪娘 / 人妖 → 同性·跨性别)
        const cls = className(chan, info.title);
        const cm = ctx.classMapFor(site.api);
        const have = cm && cm.byId && cm.byId.get(1);
        if (!have || have.name !== cls) await ctx.saveClasses(site.api, [{ id: 1, pid: 0, name: cls }]);
        const rt = { ok: 0, rej: 0, skipped: {} };
        for (let pages = 0; ; pages++) {
            const list = [];
            for (const m of Array.isArray(page.items) ? page.items : []) {
                const r = TGL.toVod(cfg, chan, m, cls);
                if (r.counted) {
                    // 有正文的帖子都算进"未成年"比例(包括太短 / 格式不对、本来就不收的)
                    st.n++;
                    let pc;
                    try { pc = P.checkItem(r.vod, { strict: true, siteTrust: false }); } catch (_) { pc = { ok: false, reason: 'error' }; }
                    if (!pc.ok && (pc.reason === 'item:minor' || pc.reason === 'category:minors')) st.minor++;
                }
                if (!r.ok) {
                    rt.skipped[r.reason] = (rt.skipped[r.reason] || 0) + 1;
                    const sk = String(r.reason || '').replace(/^tg:/, '') || 'other';
                    if (!st.sk || typeof st.sk !== 'object') st.sk = {};
                    st.sk[sk] = (Number(st.sk[sk]) || 0) + 1;
                    continue;
                }
                list.push(r.vod);
            }
            if (st.minor >= TGL.MINOR_KILL.hits && st.minor / Math.max(1, st.n) >= TGL.MINOR_KILL.ratio) {
                await W('meta', { k: 'tg:' + chan.key, v: JSON.stringify(st) });
                await kill(chan, `未成年 ${st.minor}/${st.n}`, st);
                return { killed: true };
            }
            if (list.length) {
                const res = await ctx.ingestList(site, list, 'crawl');
                rt.ok += (res && res.ok) || 0;
                rt.rej += (res && res.rejected) || 0;
                st.rej = (Number(st.rej) || 0) + ((res && res.rejected) || 0);
            }
            st.cur = Math.max(st.cur, Number(page.next) || 0);
            Object.assign(st, { at: nowFn(), title: String(info.title || '').slice(0, 80), top: Number(info.top) || st.top || 0, members: Number(info.members) || st.members || 0 });
            await W('meta', { k: 'tg:' + chan.key, v: JSON.stringify(st) });
            if (page.done || pages + 1 >= PAGES_PER_RUN || stopped) break;
            page = await relay('/api/list?ch=' + encodeURIComponent(chan.ch) + '&after=' + st.cur + '&limit=100');
        }
        return rt;
    }

    async function runAll() {
        if (!tg.config().on) return;
        if (ctx.ensureReady && !(await ctx.ensureReady())) return;
        loadKills();
        for (const chan of tg.config().channels) {
            if (stopped) break;
            const r0 = runtime.get(chan.key) || { errN: 0, nextAt: 0 };
            if (r0.nextAt > nowFn()) continue;
            try {
                const r = await syncChannel(chan);
                runtime.set(chan.key, Object.assign({ errN: 0, nextAt: 0, err: '', at: nowFn() }, r));
                if (r && r.ok) log(`TG ${chan.ch}:收 ${r.ok} 条,入库拦 ${r.rej} 条,不收 ${JSON.stringify(r.skipped)}`);
            } catch (e) {
                const errN = (r0.errN || 0) + 1;
                const wait = /BAD_CHANNEL|USERNAME|404/.test(e.message) ? 6 * 3600e3 : ERR_BACKOFF_MS[Math.min(errN, ERR_BACKOFF_MS.length) - 1];
                runtime.set(chan.key, Object.assign({}, r0, { errN, err: String(e.message || e).slice(0, 80), nextAt: nowFn() + wait, at: nowFn() }));
                warn('tg', chan.ch + ': ' + e.message);
            }
        }
    }

    // force:后台「立即同步」—— 出错退避中的频道也马上再试
    function kick(force) {
        if (running) return running;
        if (force) for (const v of runtime.values()) v.nextAt = 0;
        running = runAll().catch((e) => warn('tg', e.message)).finally(() => { running = null; });
        return running;
    }

    return {
        start() {
            if (started || !tg.config().on) { if (!tg.config().on && tg.config().channels.length) log('TG 频道没启用:' + tg.config().problems.join(';')); return; }
            started = true; stopped = false;
            try { loadKills(); } catch (_) { /* 库还没好:runAll 里再读 */ }
            const loop = async () => {
                if (!started) return;
                await kick();
                if (started) { timer = setTimeout(loop, EVERY_MS); if (timer.unref) timer.unref(); }
            };
            timer = setTimeout(loop, FIRST_MS);
            if (timer.unref) timer.unref();
            log(`TG 频道:${tg.config().channels.length} 个,经中转 ${tg.config().relay}`);
        },
        stop() { started = false; stopped = true; clearTimeout(timer); timer = null; },
        kick,
        status() {
            return tg.config().channels.map((c) => {
                const st = loadState(c.key), rt = runtime.get(c.key) || {}, k = meta('admin:tg-kill:' + c.key);
                return {
                    key: c.key, ch: c.ch, cls: c.cls || '', minSec: c.minSec, title: st.title || '', members: st.members || 0,
                    cur: st.cur, top: st.top || 0, n: st.n, minor: st.minor, sk: st.sk && typeof st.sk === 'object' ? st.sk : {}, rej: Number(st.rej) || 0,
                    killed: k ? k.why : '', killedAt: k ? k.at || 0 : 0, err: rt.err || '', nextAt: rt.err ? rt.nextAt || 0 : 0, at: st.at || 0,
                };
            });
        },
        // 中转的账号 / 缓存状态(后台 TG 页用;没启用 = null,连不上 = {ok:false, err})
        async health() {
            const cfg = tg.config();
            if (!cfg.on) return null;
            try {
                const h = await TGL.relayGet(cfg, '/api/health', { fetch: fetchFn, timeout: 6000 });
                const acc = Array.isArray(h.accounts) ? h.accounts : [];
                const n = (v) => Number(v) || 0;
                const s = (v, max) => String(v == null ? '' : v).slice(0, max);
                return {
                    ok: true, usable: n(h.usable), streams: n(h.streams), fromTg: n(h.fromTg), fromCache: n(h.fromCache),
                    cache: h.cache ? { bytes: n(h.cache.bytes), cap: n(h.cache.cap) } : null,
                    accounts: acc.slice(0, 200).map((a) => ({ name: s(a && a.name, 40), ok: !!(a && a.ok), dead: s(a && a.dead, 60), floodSec: n(a && a.floodSec), active: n(a && a.active), served: n(a && a.served), errors: n(a && a.errors), lastErr: s(a && a.lastErr, 80) })),
                };
            } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 120) }; }
        },
    };
}

module.exports = { createTgSync };
