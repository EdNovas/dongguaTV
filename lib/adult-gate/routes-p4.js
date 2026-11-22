'use strict';
// [adult] p4 闸门路由(lib/adult-gate/index.js 的 register 调用;闭包里的过滤函数经 ctx 传进来)
//
// 目录(都在 requireAuth 后面:CONTENT_PATHS 含 /api/catalog):
//   GET  /api/catalog/related/:wk  (或 ?k=)  → {items, actress:{aid,name,items}|null, studio:{id,label,items}|null};作品不认识 / 被隐藏 → 404
//        卡片:片名过策略(nameOk + 分区)+ AVDB 政策 + 不在隐藏表;演员名 / 片商名过查询硬拦词(被拦 → null)
//   GET  /api/catalog/feed?cursor=&vert=1[&limit=]  → {items:FeedItem[], cursor_next};每条再过 nameOk + AVDB + 隐藏表;
//        线路只留站点表里在用的站、http(s) 地址、过 checkRaw(和 /api/catalog/work 的线路同一个出口过滤);vert=1 只留 orient:'v'
//   GET  /api/catalog/heat/:wk  (或 ?k=)  → {bins:number[100] 0..100, users};不到 3 人 → 204
//   POST /api/catalog/heat {wk, dur, bins:base64(100 字节), dev}  → 204;每 IP(可信网络)每分钟 30 次 + 每设备每分钟 6 次,超了 429;
//        who = sha256(dev + 当天的盐)(契约;一台设备当天一部片算一份);设备限流按同一个哈希;dev 原文不落任何地方;
//        认得出客户端网络时(ADULT_CLIENT_IP_HEADER / 公网直连)同一网络当天同一部片只收第一台设备(假设备号凑不出人数),认不出时不设这道;
//        复核 SEC-3:公网直连时客户端自己加的转发头(X-Forwarded-For …)不再让它"认不出"(以前一加就绕开这道上限);对端是内网 / Cloudflare 才认不出;
//        一人一个的令牌(机场用户)同样按人只收第一台设备(复核 r3)。反代后面没配头 + 共享访问密码 = 仍认不出人(已知缺口)
// 后台(X-Admin-Token 头 = 环境变量 ADULT_ADMIN_TOKEN,没配就用契约里的 ADMIN_TOKEN(主站求片后台同一个站长令牌);
//   ADULT_ADMIN_TOKEN=off/0/false/no = 不开成人后台;两个都没配 = 整个后台 404;
//   同一客户端 10 分钟内 5 次【错】令牌 → 锁 10 分钟(429),锁着时对的令牌也不收;不带令牌的请求只回 401、不算错;
//   客户端 = ctx.clientKey:配了 ADULT_CLIENT_IP_HEADER 按它,否则按对端网络(IPv6 /64),带不带转发头都一样(复核 SEC-3)):
//   GET  /admin/adult                          → public/adult/admin.html(页面本身不鉴权,数据全在令牌后面)
//   GET  /api/adult/admin/stats                → 目录 adminStats() + 闸门这边的站点覆盖 / 镜像 / 屏蔽词
//   POST /api/adult/admin/test {title, type_name} → {query, item:{ok,reason,bucket,review}, parsed:{code,key,kind,codeOk}, tags:[{id,kind}], avdb}
//   GET  /api/adult/admin/block-words          → {words, n, rev}
//   PUT  /api/adult/admin/block-words {words}  → 只会更严(内置规则一条都动不了;[] = 清空追加词)
//   GET  /api/adult/admin/hidden               → [{wk,name,at}](片名现在被拦的不列)
//   POST /api/adult/admin/hide {wk, on}        → {ok}
//   GET  /api/adult/admin/sites                → 站点表 + 覆盖 + 镜像 + 目录统计
//   POST /api/adult/admin/site {key, active}   → active:false 停用(持久化);active:true 撤销停用(回到站点表的配置;db 里 active:false 的站开不了)
//   GET  /api/adult/admin/mirrors              → mirror.status()
//   POST /api/adult/admin/mirror/probe {key}   → mirror.probe(key)
//   POST /api/adult/admin/mirror/reset {key}   → mirror.reset(key):立刻回到站点表里的主地址(复核 SEC-2;正在跑的换源作废)
//                                                 → {ok, switched, from, current, reason:'admin-reset'|'already-primary'};不认识的站 404
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WK_RE = /^[ct]:./;
const wkOk = (wk) => typeof wk === 'string' && WK_RE.test(wk) && wk.length <= 300;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0; };
const ORIENTS = new Set(['v', 'h', 'sq']);
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DEV_RE = /^[A-Za-z0-9_-]{8,64}$/;
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

function registerCatalogP4(app, withCat, ctx) {
    const { nameOk, titleAvdbOk, queryBlocked, isHidden, refreshHidden, sitesOf, lineName, checkRaw, perMinute, beaconBody, warnOnce } = ctx;
    const cardVisible = (c) => !!c && typeof c === 'object' && typeof c.wk === 'string' && nameOk(c.name, '', c.bucket) && titleAvdbOk(c.name) && !isHidden(c.wk);
    const cards = (a, self) => (Array.isArray(a) ? a : []).filter((c) => cardVisible(c) && c.wk !== self);
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    const cache60 = (res) => res.set('Cache-Control', 'private, max-age=60');
    const wkParam = (req) => {
        const v = typeof req.query.k === 'string' && req.query.k ? req.query.k : (req.params && typeof req.params.wk === 'string' ? req.params.wk : '');
        return wkOk(v) ? v : '';
    };

    // ---------- 相关推荐 ----------
    app.get(['/api/catalog/related', '/api/catalog/related/:wk'], withCat(async (cat, req, res) => {
        const wk = wkParam(req);
        if (!wk) { noStore(res); return res.status(400).json({ error: 'BAD_KEY' }); }
        await refreshHidden(false);
        if (isHidden(wk) || typeof cat.related !== 'function') { noStore(res); return res.status(404).json({ error: 'NOT_FOUND' }); }
        const limit = clamp(parseInt(req.query.limit, 10) || 24, 1, 48);
        const r = await cat.related(wk, { limit });
        if (!r || typeof r !== 'object') { noStore(res); return res.status(404).json({ error: 'NOT_FOUND' }); }
        const a = r.actress && typeof r.actress === 'object' ? r.actress : null;
        const s = r.studio && typeof r.studio === 'object' ? r.studio : null;
        const out = {
            items: cards(r.items, wk),
            actress: a && typeof a.name === 'string' && a.name && !queryBlocked(a.name)
                ? { aid: (typeof a.aid === 'number' || typeof a.aid === 'string') ? a.aid : null, name: a.name, items: cards(a.items, wk) } : null,
            studio: s && typeof s.label === 'string' && s.label && !queryBlocked(s.label)
                ? { id: (typeof s.id === 'number' || typeof s.id === 'string') ? s.id : s.label, label: s.label, items: cards(s.items, wk) } : null,
        };
        cache60(res);
        res.json(out);
    }));

    // ---------- 竖屏短片流 ----------
    app.get('/api/catalog/feed', withCat(async (cat, req, res) => {
        noStore(res);
        const cursor = typeof req.query.cursor === 'string' && /^[A-Za-z0-9_-]{1,400}$/.test(req.query.cursor) ? req.query.cursor : '';
        const vert = req.query.vert === '1' || req.query.vert === 'true';
        const limit = clamp(parseInt(req.query.limit, 10) || 10, 1, 20);
        if (typeof cat.feed !== 'function') return res.json({ items: [], cursor_next: null });
        await refreshHidden(false);
        const r = await cat.feed({ cursor, vert, limit });
        const byKey = new Map(sitesOf().filter((x) => x && x.key).map((x) => [x.key, x]));
        const items = [];
        for (const it of (r && Array.isArray(r.items) ? r.items : [])) {
            if (!cardVisible(it)) continue;
            const orient = ORIENTS.has(it.orient) ? it.orient : '';
            if (vert && orient !== 'v') continue;
            const lines = [];
            for (const l of (Array.isArray(it.lines) ? it.lines : [])) {
                if (!l || typeof l !== 'object' || typeof l.site !== 'string') continue;
                const site = byKey.get(l.site);
                if (!site || typeof l.url !== 'string' || !/^https?:\/\/[^\s"'<>]+$/i.test(l.url) || l.url.length > 2048) continue;
                // 和 /api/catalog/work 的线路同一个出口过滤:站点表在用 + checkRaw(站的 strict/codeTrust 照样生效)
                const vn = typeof l.vod_name === 'string' && l.vod_name ? l.vod_name : it.name;
                if (!checkRaw(site, { vod_name: vn, type_name: typeof l.type_name === 'string' ? l.type_name : '' }).ok) continue;
                const vid = (typeof l.vod_id === 'string' || typeof l.vod_id === 'number') && String(l.vod_id) !== '' && String(l.vod_id).length <= 64 ? String(l.vod_id) : '';
                lines.push({
                    site: l.site, site_name: lineName(site, ''), url: l.url, dur: num(l.dur),
                    _family: typeof site.family === 'string' ? site.family.slice(0, 40) : '', _native: site.nativeHls === false ? 'risky' : 'ok',
                    // [integ] vod_id 透传:刷短片量到画面方向后直接按 (站, vod_id) 报 beacon,不必再拉一次作品信息(/api/catalog/work 本来就给它)
                    vod_id: vid,
                });
                if (lines.length >= 8) break;
            }
            if (!lines.length) continue;
            items.push(Object.assign({}, it, { orient, dur: num(it.dur), lines }));
        }
        res.json({ items, cursor_next: r && typeof r.cursor_next === 'string' && r.cursor_next ? r.cursor_next : null });
    }));

    // ---------- 热度条 ----------
    app.get(['/api/catalog/heat', '/api/catalog/heat/:wk'], withCat(async (cat, req, res) => {
        const wk = wkParam(req);
        if (!wk) { noStore(res); return res.status(400).json({ error: 'BAD_KEY' }); }
        await refreshHidden(false);
        const h = !isHidden(wk) && typeof cat.heat === 'function' ? await cat.heat(wk) : null;
        const bins = h && Array.isArray(h.bins) && h.bins.length === 100 ? h.bins.map((x) => clamp(Math.round(Number(x) || 0), 0, 100)) : null;
        const users = h ? Math.max(0, Math.floor(Number(h.users) || 0)) : 0;
        if (!bins || users < 3) { noStore(res); return res.status(204).end(); }
        res.set('Cache-Control', 'private, max-age=300');
        res.json({ bins, users });
    }));
    const heatIp = new Map(), heatDev = new Map();
    const heatNet = new Map(), HEAT_NET_MAX = 50000;   // 可信网络 × 作品 → 当天第一台设备的 who(见 POST)
    let heatNetDay = '';
    let saltDay = '', salt = '';
    function dailySalt() {
        const d = utcDay(Date.now());
        if (d !== saltDay) {
            let seed = '';
            try { seed = ctx.adminState.heatSecret(); } catch (e) { seed = ''; }
            if (!seed) seed = ctx.ephemeralSecret;
            salt = crypto.createHmac('sha256', seed).update('heat|' + d).digest('hex');
            saltDay = d;
        }
        return salt;
    }
    app.post('/api/catalog/heat', withCat(async (cat, req, res) => {
        noStore(res);
        // 每 IP(可信网络 / 对端地址;伪造的转发头开不出新键)每分钟 30 次;配了密码时再按令牌分开(反代后面没配 ADULT_CLIENT_IP_HEADER 时,
        //   不同用户的令牌不同 → 不至于全站共用这 30 次;共享一个访问密码的站仍然共用)
        const ipk = ctx.tokenKey(req) + '|' + ctx.clientKey(req);
        if (!perMinute(heatIp, 'i|' + ipk, 30)) return res.status(429).json({ error: 'RATE_LIMITED' });
        const b = await beaconBody(req);
        const wk = b && b.wk, dev = b && b.dev, s = b && b.bins, dur = Number(b && b.dur);
        if (!wkOk(wk) || typeof dev !== 'string' || !DEV_RE.test(dev) || !Number.isFinite(dur) || dur < 1 || dur > 43200
            || typeof s !== 'string' || s.length < 134 || s.length > 136 || !B64_RE.test(s)) return res.status(400).json({ error: 'BAD_HEAT' });
        const buf = Buffer.from(s, 'base64');
        if (buf.length !== 100 || buf.toString('base64').replace(/=+$/, '') !== s.replace(/=+$/, '')) return res.status(400).json({ error: 'BAD_HEAT' });
        // 契约:who = sha256(dev + 当天的盐)(一台设备当天一部片算一份;dev 原文不落任何地方)。限流按同一个设备哈希。
        // 复核修订(原来 who 按客户端网络 → 反代后面没配 ADULT_CLIENT_IP_HEADER 时全站共用一个网络键,每部片每天最多 1 份,热度条永远凑不到 3 人):
        //   防"一个人造几个假设备号凑够 3 人、再减掉自己的数据反推唯一真实观众"这道,改成【认得出客户端网络时】的扇出上限:
        //   clientKey 是可信网络('n:',ADULT_CLIENT_IP_HEADER 或公网直连)→ 同一网络当天同一部片只收第一台设备的那份(其余照回 204、不计);
        //   认不出('p:',反代后面没配头 / 内网,所有人共用一个键)→ 不设这道(设了 = 功能整个没了),只靠每 IP / 每设备限流
        const salt0 = dailySalt();
        const devKey = crypto.createHash('sha256').update('d|' + dev + '|' + salt0).digest('hex').slice(0, 32);
        if (!perMinute(heatDev, devKey, 6)) return res.status(429).json({ error: 'RATE_LIMITED' });
        const who = crypto.createHash('sha256').update('w|' + dev + '|' + salt0).digest('hex').slice(0, 32);
        let counted = true;
        // 复核 r3:扇出键 = 可信网络('n:')和/或 一人一个的令牌(机场用户,ctx.personKey);两道都要是"当天这部片第一台设备"才计。
        //   'p:' + 共享访问密码(反代后面没配 ADULT_CLIENT_IP_HEADER)仍然认不出人 —— 已知缺口,只靠每 IP / 每设备限流;要堵就配那个头
        const nk = String(ctx.clientKey(req) || '');
        let pk = '';
        try { pk = typeof ctx.personKey === 'function' ? String(ctx.personKey(req) || '') : ''; } catch (e) { pk = ''; }
        const fan = [];
        if (nk.indexOf('n:') === 0) fan.push('c|' + nk);
        if (pk) fan.push('u|' + pk);
        if (fan.length) {
            if (heatNetDay !== salt0) { heatNet.clear(); heatNetDay = salt0; }
            const cks = fan.map((f) => crypto.createHash('sha256').update(f + '|' + wk + '|' + salt0).digest('hex').slice(0, 24));
            if (cks.some((ck) => { const first = heatNet.get(ck); return first && first !== who; })) counted = false;
            else {
                for (const ck of cks) {
                    if (heatNet.has(ck)) continue;
                    if (heatNet.size >= HEAT_NET_MAX) heatNet.delete(heatNet.keys().next().value);   // 先进先出(一天最多记这么多 网络/人×作品)
                    heatNet.set(ck, who);
                }
            }
        }
        await refreshHidden(false);
        if (counted && typeof cat.heatAdd === 'function' && !isHidden(wk)) {
            try { await cat.heatAdd(wk, { bins: Array.from(buf), dur: Math.round(dur) }, who); } catch (e) { warnOnce('heatAdd', e); }
        }
        res.status(204).end();
    }));
}

// ---------- 后台 ----------
function registerAdmin(app, ctx) {
    const { env, warnOnce, getCatalog, nameOk, queryBlocked, checkRaw, avdbPolOf, adult, adminState, getMirror, isHidden, refreshHidden } = ctx;
    // 令牌(复核修订,回到契约):ADULT_ADMIN_TOKEN 优先;没配就用 ADMIN_TOKEN(契约写的就是它 —— 成人版是单独的部署,站长同一个令牌);
    //   只想要主站求片后台、不想开成人后台 → ADULT_ADMIN_TOKEN=off(0/false/no/disable 同义)
    const rawAdult = String(env.ADULT_ADMIN_TOKEN == null ? '' : env.ADULT_ADMIN_TOKEN).trim();
    const adminOff = /^(?:off|0|false|no|disabled?)$/i.test(rawAdult);
    const TOKEN = adminOff ? '' : (rawAdult || String(env.ADMIN_TOKEN == null ? '' : env.ADMIN_TOKEN).trim());
    const TOKEN_SRC = rawAdult ? 'ADULT_ADMIN_TOKEN' : 'ADMIN_TOKEN';
    const enabled = TOKEN.length > 0;
    const tokHash = crypto.createHash('sha256').update(TOKEN).digest();
    const fails = new Map();   // 客户端键 → [时间]
    const LOCK_N = 5, LOCK_MS = 10 * 60e3;
    function recentFails(k, t) {
        const a = (fails.get(k) || []).filter((x) => t - x < LOCK_MS);
        if (a.length) fails.set(k, a); else fails.delete(k);
        return a;
    }
    function tokenOk(v) {
        if (typeof v !== 'string' || !v || v.length > 512) return false;
        const h = crypto.createHash('sha256').update(v).digest();
        return crypto.timingSafeEqual(h, tokHash);
    }
    const notAvail = (req, res) => { res.set('Cache-Control', 'no-store'); res.status(404).json({ error: 'NOT_AVAILABLE' }); };
    function adminAuth(req, res, next) {
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        if (!enabled) return notAvail(req, res);
        const k = ctx.clientKey(req) || '-';
        const t = Date.now();
        if (recentFails(k, t).length >= LOCK_N) return res.status(429).json({ error: 'LOCKED' });
        let v = req.headers['x-admin-token'];
        if (Array.isArray(v)) v = v[0];
        if (tokenOk(v)) return next();
        // 没带令牌(页面探测、只带 cookie 的请求…)只回 401、不算错:否则和站长共用客户端键的人(反代后面没配 ADULT_CLIENT_IP_HEADER 时 = 所有人)
        //   随手发几个空请求就能把站长一直锁在外面;带了错令牌才算一次猜
        if (typeof v !== 'string' || !v) return res.status(401).json({ error: 'NO_TOKEN' });
        const a = recentFails(k, t);
        a.push(t);
        if (fails.size >= 5000 && !fails.has(k)) {
            // 表满:先清过期的,还满就按先来先走挪掉最老的(不再整表清空 —— 那样换 5000 个键就能把所有锁定一起解掉)
            for (const key of [...fails.keys()]) recentFails(key, t);
            for (const key of fails.keys()) { if (fails.size < 5000) break; fails.delete(key); }
        }
        fails.set(k, a);
        return res.status(a.length >= LOCK_N ? 429 : 401).json({ error: a.length >= LOCK_N ? 'LOCKED' : 'BAD_TOKEN' });
    }
    const wrap = (fn) => async (req, res) => {
        try { await fn(req, res); }
        catch (e) { warnOnce('admin', e); if (!res.headersSent) res.status(500).json({ error: 'ADMIN_ERROR' }); }
    };
    const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
    const configured = () => { try { return (ctx.configuredSites() || []).filter((s) => s && typeof s.key === 'string' && s.key); } catch (e) { return []; } };

    // 页面:后台没开(ADULT_ADMIN_TOKEN / ADMIN_TOKEN 都没配,或 ADULT_ADMIN_TOKEN=off)= 404;页面本身不鉴权(数据都在令牌后面)
    app.get('/admin/adult', (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!enabled) return res.status(404).type('text').send('Not Found');
        const f = path.join(ctx.publicDir, 'adult', 'admin.html');
        if (!fs.existsSync(f)) return res.status(404).type('text').send('Not Found');
        res.set('X-Frame-Options', 'DENY');
        res.set('Referrer-Policy', 'no-referrer');
        res.sendFile(f);
    });
    // [integ] 静态目录里的同一个页面(express.static 会按 /adult/admin.html 直接给,不带 DENY / no-store):没开后台 = 404,开了 = 转到 /admin/adult
    app.get('/adult/admin.html', (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!enabled) return res.status(404).type('text').send('Not Found');
        res.redirect(302, '/admin/adult');
    });
    app.use('/api/adult/admin', adminAuth);

    function siteRows() {
        const mir = getMirror();
        const mst = new Map();
        if (mir) { try { for (const m of mir.status() || []) if (m && m.key) mst.set(m.key, m); } catch (e) { warnOnce('mirror.status', e); } }
        return configured().map((s) => {
            const off = adminState.siteOff(s.key);
            const m = mst.get(s.key);
            return {
                key: s.key, name: typeof s.name === 'string' ? s.name : s.key, api: typeof s.api === 'string' ? s.api : '',
                current: m ? m.current : (typeof s.api === 'string' ? s.api : ''),
                configuredActive: s.active !== false, overrideActive: off ? false : null, active: s.active !== false && !off,
                search: s.search !== false, family: typeof s.family === 'string' ? s.family : '',
                mirrors: Array.isArray(s.mirrors) ? s.mirrors.length : 0, mirrorFails: m ? m.fails : 0, mirrorReason: m ? m.reason : '',
            };
        });
    }
    async function catalogStats() {
        const cat = getCatalog();
        if (!cat || typeof cat.adminStats !== 'function') return null;
        try { const r = await cat.adminStats(); return r && typeof r === 'object' ? r : null; } catch (e) { warnOnce('adminStats', e); return null; }
    }
    function extraInfo() {
        try { if (typeof adult.policy.extraBlock === 'function') { const x = adult.policy.extraBlock(); return { words: Array.isArray(x.words) ? x.words : [], n: Number(x.n) || 0, rev: typeof x.rev === 'string' ? x.rev : '' }; } }
        catch (e) { warnOnce('extraBlock', e); }
        const w = adminState.blockWords() || [];
        return { words: w, n: w.length, rev: '' };
    }

    app.get('/api/adult/admin/stats', wrap(async (req, res) => {
        const st = await catalogStats();
        const rows = siteRows();
        const byKey = new Map(rows.map((r) => [r.key, r]));
        // 只放约定的字段,值只要计数 / 简单量(目录将来多塞了带片名的东西也不会经这里露出去)
        const flat = (o) => {
            if (o == null || typeof o !== 'object') return (typeof o === 'number' || typeof o === 'boolean' || (typeof o === 'string' && o.length <= 80)) ? o : null;
            const r = {};
            for (const k of Object.keys(o).slice(0, 60)) { const v = o[k]; if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 80)) r[k] = v; }
            return r;
        };
        const s0 = st || {};
        const rejected = {};
        if (s0.rejected && typeof s0.rejected === 'object') for (const k of Object.keys(s0.rejected).slice(0, 200)) { const n = Number(s0.rejected[k]); if (Number.isFinite(n) && k.length <= 60) rejected[k] = n; }
        const out = { works: Number.isFinite(Number(s0.works)) ? Number(s0.works) : null, lines: Number.isFinite(Number(s0.lines)) ? Number(s0.lines) : null, sites: [], rejected, rescan: flat(s0.rescan), purge: flat(s0.purge), avdb: flat(s0.avdb) };
        // 站点:目录的 lastOk/fails 合上闸门这边的覆盖 / 镜像(目录不在 = 只有闸门这边)
        const catSites = Array.isArray(s0.sites) ? s0.sites : [];
        const seen = new Set();
        out.sites = catSites.filter((x) => x && typeof x.key === 'string' && byKey.has(x.key)).map((x) => {
            seen.add(x.key);
            const r = byKey.get(x.key);
            return { key: x.key, name: r.name, lastOk: Number(x.lastOk) || 0, fails: Number(x.fails) || 0, active: r.active, overrideActive: r.overrideActive, current: r.current || '' };
        });
        for (const r of rows) if (!seen.has(r.key)) out.sites.push({ key: r.key, name: r.name, lastOk: 0, fails: 0, active: r.active, overrideActive: r.overrideActive, current: r.current });
        const x = extraInfo();
        out.extraBlock = { n: x.n, rev: x.rev };
        out.catalog = !!st;
        out.mirrors = rows.filter((r) => r.current && r.api && r.current !== r.api).length;
        res.json(out);
    }));

    app.post('/api/adult/admin/test', wrap(async (req, res) => {
        const b = body(req);
        const t = b.title, tn = b.type_name == null ? '' : b.type_name;
        if (typeof t !== 'string' || !t.trim() || t.length > 400 || typeof tn !== 'string' || tn.length > 60) return res.status(400).json({ error: 'BAD_INPUT' });
        const item = { vod_name: t, type_name: tn };
        let query = true;
        try { query = !!adult.policy.checkQuery(t); } catch (e) { query = true; }
        const chk = checkRaw(null, item);
        const p = chk.parsed || (() => { try { return adult.title.parseTitle(t, tn); } catch (e) { return {}; } })();
        let codeOk = false;
        try { codeOk = !!adult.title.codeOk(p, { siteTrust: true }); } catch (e) { codeOk = false; }
        const tagsOut = [];
        try {
            if (adult.tags && typeof adult.tags.tagLine === 'function') {
                const tl = adult.tags.tagLine(item, { parsed: p, bucket: chk.bucket || '' }) || {};
                for (const x of Array.isArray(tl.tags) ? tl.tags : []) {
                    if (!x || typeof x.id !== 'string') continue;
                    const kind = adult.tags.isReview(x.id) ? 'review' : adult.tags.isFeatured(x.id) ? 'featured' : 'plain';
                    tagsOut.push({ id: x.id, kind });
                }
                for (const id of Array.isArray(tl.signals) ? tl.signals : []) {
                    let kind = 'signal';
                    try { kind = String(adult.tags.signalKind(id) || 'signal'); } catch (e) { kind = 'signal'; }
                    tagsOut.push({ id: String(id), kind });
                }
            }
        } catch (e) { warnOnce('admin:tagLine', e); }
        res.json({
            query,
            item: { ok: !!chk.ok, reason: chk.reason || '', bucket: chk.bucket || '', review: chk.review || null },
            parsed: { code: p.code || '', key: p.key || '', kind: p.kind || '', codeOk },
            tags: tagsOut,
            avdb: avdbPolOf(p),
        });
    }));

    app.get('/api/adult/admin/block-words', wrap(async (req, res) => { res.json(extraInfo()); }));
    app.put('/api/adult/admin/block-words', wrap(async (req, res) => {
        const b = body(req);
        const w = b.words;
        if (!Array.isArray(w) || w.length > 500) return res.status(400).json({ error: 'BAD_WORDS', detail: 'words 必须是 ≤500 个的数组' });
        const words = [];
        const seen = new Set();
        for (const x of w) {
            if (typeof x !== 'string') return res.status(400).json({ error: 'BAD_WORDS', detail: '每个词必须是字符串' });
            const s = x.trim();
            const n = [...s].length;
            if (n < 2 || n > 40 || /[\u0000-\u001f\u007f]/.test(s)) return res.status(400).json({ error: 'BAD_WORDS', detail: '每个词 2..40 字(不含控制字符)' });
            if (seen.has(s)) continue;
            seen.add(s);
            words.push(s);
        }
        const r = ctx.applyExtraBlock(words);
        if (r.error) return res.status(400).json({ error: 'BAD_WORDS', detail: r.error });
        // 主线程已生效(只会更严)→ 先落盘(重启时 syncExtraBlock 会再推给目录);目录那边等它的结果:{ok:false} = 没存上 / 不可用
        adminState.setBlockWords(r.words || words);
        let catErr = '';
        if (r.catalogP) {
            let cr = null;
            try { cr = await r.catalogP; } catch (e) { cr = { ok: false, error: String((e && e.message) || e) }; }
            if (cr && typeof cr === 'object' && cr.ok === false) catErr = String(cr.error || 'catalog').slice(0, 200);
        }
        if (catErr) {
            return res.status(503).json(Object.assign({ ok: false, error: 'CATALOG_FAILED', detail: '已在搜索 / 详情生效并保存;目录没设上(' + catErr + '),重启后会再试',
                applied: { main: r.main, catalog: false } }, extraInfo()));
        }
        res.json(Object.assign({ ok: true, applied: { main: r.main, catalog: r.catalog } }, extraInfo()));
    }));

    app.get('/api/adult/admin/hidden', wrap(async (req, res) => {
        const cat = getCatalog();
        if (!cat || typeof cat.adminHidden !== 'function') return res.json([]);
        const list = await cat.adminHidden();
        // 片名现在被拦的不列(被拦的本来就哪儿都不出;它的 t: 键里就是片名)
        res.json((Array.isArray(list) ? list : []).filter((x) => x && typeof x.wk === 'string' && nameOk(x.name, '', x.bucket) && !queryBlocked(x.wk.slice(2)))
            .map((x) => ({ wk: x.wk, name: typeof x.name === 'string' ? x.name : '', at: Number(x.at) || 0 })));
    }));
    app.post('/api/adult/admin/hide', wrap(async (req, res) => {
        const b = body(req);
        if (!wkOk(b.wk) || typeof b.on !== 'boolean') return res.status(400).json({ error: 'BAD_INPUT' });
        const cat = getCatalog();
        if (!cat || typeof cat.adminHide !== 'function') return res.status(503).json({ error: 'CATALOG_UNAVAILABLE' });
        const r = await cat.adminHide(b.wk, b.on);
        await refreshHidden(true);
        // 目录回 {ok:false, reason}(invalid / unavailable / error)或 false = 没成
        const failed = r === false || (!!r && typeof r === 'object' && r.ok === false);
        if (failed) {
            const reason = r && typeof r === 'object' && typeof r.reason === 'string' ? r.reason : 'error';
            return res.status(reason === 'invalid' ? 400 : 503).json({ ok: false, error: reason === 'invalid' ? 'BAD_INPUT' : 'CATALOG_UNAVAILABLE', detail: reason, wk: b.wk, on: b.on, hidden: isHidden(b.wk) });
        }
        res.json({ ok: true, wk: b.wk, on: b.on, hidden: isHidden(b.wk) });
    }));

    app.get('/api/adult/admin/sites', wrap(async (req, res) => {
        const rows = siteRows();
        const st = await catalogStats();
        const cs = new Map((st && Array.isArray(st.sites) ? st.sites : []).filter((x) => x && x.key).map((x) => [x.key, x]));
        res.json(rows.map((r) => { const c = cs.get(r.key); return Object.assign({}, r, { lastOk: c ? Number(c.lastOk) || 0 : 0, fails: c ? Number(c.fails) || 0 : 0 }); }));
    }));
    app.post('/api/adult/admin/site', wrap(async (req, res) => {
        const b = body(req);
        if (typeof b.key !== 'string' || !b.key || b.key.length > 64 || typeof b.active !== 'boolean') return res.status(400).json({ error: 'BAD_INPUT' });
        const s = configured().find((x) => x.key === b.key);
        if (!s) return res.status(404).json({ error: 'UNKNOWN_SITE' });
        const saved = adminState.setSiteOff(b.key, !b.active);
        // 目录也记一份(它的站点表里这个站已按闸门的停用表标成 active:false;这里让快照 / 刷一刷立刻重建,stats 也能看到覆盖)。
        //   配置里本来就停用的站目录不认识(unknown)→ 不算失败;只会更严:撤销停用没存上 = 目录那边照样停着
        let catalogOk = null;
        const cat = getCatalog();
        if (cat && typeof cat.adminSite === 'function') {
            try {
                const cr = await cat.adminSite(b.key, b.active);
                catalogOk = !!(cr && cr.ok) || !!(cr && cr.reason === 'unknown');
                if (cr && cr.ok === false && cr.reason !== 'unknown') warnOnce('adminSite', new Error(String(cr.reason || 'failed')));
            } catch (e) { catalogOk = false; warnOnce('adminSite', e); }
        }
        const row = siteRows().find((x) => x.key === b.key);
        res.json(Object.assign({ ok: true, persisted: saved, catalog: catalogOk }, row));
    }));

    app.get('/api/adult/admin/mirrors', wrap(async (req, res) => {
        const mir = getMirror();
        res.json(mir ? (mir.status() || []) : []);
    }));
    app.post('/api/adult/admin/mirror/probe', wrap(async (req, res) => {
        const b = body(req);
        if (typeof b.key !== 'string' || !b.key || b.key.length > 64) return res.status(400).json({ error: 'BAD_INPUT' });
        const mir = getMirror();
        if (!mir) return res.status(503).json({ error: 'MIRROR_UNAVAILABLE' });
        if (!configured().some((x) => x.key === b.key)) return res.status(404).json({ error: 'UNKNOWN_SITE' });
        res.json(await mir.probe(b.key));
    }));
    // 复核 SEC-2:「回到主地址」—— 换上去的地址不对(或站长就想用主地址)时一键撤回,不用改 db / 删 adult-mirror.json
    app.post('/api/adult/admin/mirror/reset', wrap(async (req, res) => {
        const b = body(req);
        if (typeof b.key !== 'string' || !b.key || b.key.length > 64) return res.status(400).json({ error: 'BAD_INPUT' });
        const mir = getMirror();
        if (!mir || typeof mir.reset !== 'function') return res.status(503).json({ error: 'MIRROR_UNAVAILABLE' });
        if (!configured().some((x) => x.key === b.key)) return res.status(404).json({ error: 'UNKNOWN_SITE' });
        const r = await mir.reset(b.key);
        if (!r || typeof r !== 'object' || r.ok !== true) return res.status(r && r.reason === 'unknown-site' ? 404 : 409).json({ error: r && r.reason === 'unknown-site' ? 'UNKNOWN_SITE' : 'RESET_FAILED', detail: r && typeof r.reason === 'string' ? r.reason : '' });
        res.json({ key: b.key, ok: true, switched: !!r.switched, from: typeof r.from === 'string' ? r.from : '', current: typeof r.current === 'string' ? r.current : '', reason: typeof r.reason === 'string' ? r.reason : '' });
    }));
    // 后台下其它路径(令牌对了)→ 404
    app.use('/api/adult/admin', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
    if (enabled && TOKEN.length < 16) warnOnce('ADULT_ADMIN_TOKEN', TOKEN_SRC + ' 太短(<16 字符),成人站后台(/admin/adult)建议用长随机串(可单独设 ADULT_ADMIN_TOKEN)');
}

module.exports = { registerCatalogP4, registerAdmin, wkOk };
