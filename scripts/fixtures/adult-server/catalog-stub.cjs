'use strict';
// [adult] scripts/adult-server-test.mjs 用的 lib/site-catalog 替身:接口形状与真模块一致,数据写死,
//   每次调用追加一行 JSON 到 ADULT_TEST_CATALOG_LOG(测试据此核对 server.js 传了什么、调了什么)。片名全是合成的。
const fs = require('fs');
const LOG = process.env.ADULT_TEST_CATALOG_LOG || '';
const rec = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); };
const card = (wk, name, extra) => Object.assign({ wk, name, pic: '', sub: '1小时前 · 2:00:10 · 3线', badge: '', bucket: 'jp_censored', code: '', dur: 0, n_sites: 1, first_seen: 1700000000000 }, extra || {});

function createCatalog(deps) {
    const HIDDEN = new Map();   // 第四阶段:后台隐藏(wk → 时间)
    let XWORDS = (process.env.ADULT_TEST_CAT_XWORDS || '').split(',').filter(Boolean);
    const SITEOV = new Set((process.env.ADULT_TEST_CAT_SITEOV || '').split(',').filter(Boolean));   // 目录自己存的站点停用覆盖(测启动时按 adult-admin.json 对齐)   // 第四阶段:目录自己存的追加屏蔽词(测启动时取并集)
    let sites = [];
    try { sites = deps.getSites().map(s => s.key); } catch (e) { sites = ['ERR:' + e.message]; }
    rec({
        ev: 'create', keys: Object.keys(deps).sort(), sites,
        hasDb: !!(deps.db && typeof deps.db.prepare === 'function'),
        dbPath: typeof deps.dbPath === 'string' ? deps.dbPath : null,                 // 第三阶段:目录自己的 catalog.db
        avdbFactory: typeof deps.avdbFactory, tagsOk: !!(deps.tags && Array.isArray(deps.tags.VOCAB)),
        adultOk: !!(deps.adult && typeof deps.adult.RULES_VERSION === 'string' && deps.adult.policy),
        httpGet: typeof deps.httpGet, log: typeof deps.log, env: !!deps.env,
        apis: (() => { try { return Object.fromEntries(deps.getSites().map(s => [s.key, s.api])); } catch (e) { return null; } })(),   // 第四阶段:一直是主地址(镜像地址只在 catalogHttpGet 打出去时换上)
    });
    const HOME = {
        generatedAt: 1700000000000,
        rows: [{
            id: 'new', title: '新上架', more: { sort: 'new' }, items: [
                card('c:SSIS-001', 'SSIS-001 温泉旅馆的邂逅', { code: 'SSIS-001', dur: 7210 }),
                card('t:blocked1', '准高一少女 初恋'),
                card('t:ok1', '邻家姐姐的周末', { bucket: 'cn_amateur' }),
            ],
        }],
    };
    return {
        start() { rec({ ev: 'start' }); },
        stop() { },
        home() { return HOME; },
        async tags(b) {
            rec({ ev: 'tags', b });
            // 第四阶段:server.js 的 catalogHttpGet 要把结果报给换域名跟随(镜像替身记下 report);getSites 把后台停用的站标成 active:false(主地址不变),httpGet 把主地址换成镜像地址
            if (b === 'probe_http') {
                const out = [];
                for (const u of String(process.env.ADULT_TEST_PROBE_URLS || '').split(' ').filter(Boolean)) {
                    try { const j = await deps.httpGet(u, { timeout: 3000, siteKey: process.env.ADULT_TEST_PROBE_SITE || 'a' }); out.push({ u, ok: true, n: Array.isArray(j.list) ? j.list.length : -1 }); }
                    catch (e) { out.push({ u, ok: false, err: String(e.message).slice(0, 80) }); }
                }
                rec({ ev: 'probe_http', out });
            }
            if (b === 'probe_sites') {
                let s = [];
                try { s = deps.getSites().map(x => [x.key, x.api, x.active !== false]); } catch (e) { s = 'ERR:' + e.message; }
                rec({ ev: 'probe_sites', sites: s });
            }
            // 第二阶段:server.js 要把 lib/popular 的片名交给目录(本站热门行)。只在测试点名时取(不然会提前把热门缓存焐成空的)
            if (b === 'probe_popular') {
                let titles = null;
                try { titles = typeof deps.popularTitles === 'function' ? deps.popularTitles() : 'missing'; } catch (e) { titles = 'ERR:' + e.message; }
                rec({ ev: 'popular', titles });
            }
            // 第三阶段形状:{groups, tags:[{id,label,count,featured:true,group}]};闸门只放 featured === true、字段对的
            return { groups: [{ id: 'persona', label: '身份·职业' }, { id: 5, label: 'x' }], tags: [
                { id: 'wife', label: '人妻', count: 9, featured: true, group: 'persona' },
                { id: 'incest', label: '乱伦剧情', count: 5, featured: false, group: 'story' },   // 审查级 → 闸门丢掉
                { id: 'bad', label: 7, count: 1, featured: true },          // label 不是字符串 → 闸门丢掉
                { id: 'noncon', label: '强制凌辱', count: '3', featured: 'yes' },   // featured 不是 true → 闸门丢掉
            ] };
        },
        suggest(q) {
            rec({ ev: 'suggest', q });
            if (/ssis-?001/i.test(String(q))) return { kind: 'code', alias: null, exact: 'c:SSIS-001', items: [card('c:SSIS-001', 'SSIS-001 温泉旅馆的邂逅', { code: 'SSIS-001' }), card('c:SSIS-001#U', 'SSIS-001 温泉旅馆的邂逅 [无码流出]')] };
            if (/ssis-?002/i.test(String(q))) return { kind: 'code', alias: null, exact: 't:blocked1', items: [card('t:blocked1', '准高一少女 初恋'), card('c:SSIS-002', 'SSIS-002 某作品')] };
            if (String(q) === '无码') return { kind: 'alias', alias: { b: 'jp_uncensored', label: '日本无码', extra: 'x' }, exact: null, items: [] };
            return { kind: 'weird', alias: null, exact: null, items: [card('t:ok1', '邻家姐姐的周末'), card('t:blocked3', '情侣自拍流出 合集')] };
        },
        beacon(r, who) { rec({ ev: 'beacon', r, who }); return { ok: true, dead: false }; },
        picUrl(k, s, o) {
            rec({ ev: 'picUrl', k, s, meta: !!(o && o.meta) });
            const base = process.env.ADULT_TEST_IMG_BASE || 'http://127.0.0.1:9';
            if (k === 'c:SSIS-001') return { url: base + '/img/101.jpg', name: 'SSIS-001 温泉旅馆的邂逅', bucket: 'jp_subbed' };   // 指向回环地址:代理必须拒
            if (k === 't:blocked1') return { url: 'https://img.example/x.jpg', name: '准高一少女 初恋', bucket: 'cn_amateur' };   // 片名被拦:代理不取
            return null;
        },
        browse(q) {
            rec({ ev: 'browse', q });
            return { page: q.page, total_pages: 1, total_results: 2, results: [card('t:ok1', '邻家姐姐的周末'), card('t:blocked2', '情侣自拍流出 合集')] };
        },
        buckets() { return [{ id: 'jp_censored', label: '日本有码', nav: true, today: 3 }]; },
        lookup(q, o) {
            rec({ ev: 'lookup', q, limit: o && o.limit });
            if (/ssis-?001/i.test(String(q))) return [card('c:SSIS-001', 'SSIS-001 温泉旅馆的邂逅', { code: 'SSIS-001' })];
            if (/ssis-?002/i.test(String(q))) return [card('c:SSIS-002', 'SSIS-002 某作品'), card('c:SSIS-002#clip', 'SSIS-002 某作品 · 片段')];
            return [card('t:ok1', '邻家姐姐的周末'), card('t:blocked3', '情侣自拍流出 合集')];
        },
        async work(wk, o) {
            rec({ ev: 'work', wk, expand: !!(o && o.expand) });
            if (!/^c:SSIS-001(?:~[23]|#clip)?$/.test(wk)) return null;   // 复核 r3:~N / #clip 兄弟也答(测隐藏主作品时兄弟一起 404)
            return {
                name: 'SSIS-001 温泉旅馆的邂逅', pic: '', _wk: wk,
                _meta: {
                    code: 'SSIS-001', dur: 7210, bucket: 'jp_subbed', bucket_label: '中文字幕', tags: [{ id: 'subbed', label: '中字', featured: true }], n_sites: 4, variants: ['中字'],
                    label_prefix: 'SSIS', actress: [{ aid: 7, name: 'テスト花子' }, { aid: null, name: '迷奸' }, 'テスト二号'], first_seen: 1700000000000,   // 第二个是硬拦词 → 闸门滤掉;旧形状字符串也认
                    released: '2024-09-28', maker: 'S1 NO.1 STYLE', label: 'S1', studio: 'S1', avdb: true,
                    siblings: [{ wk: 'c:SSIS-001#U', name: 'SSIS-001 温泉旅馆的邂逅 [无码流出]', kind: 'U' }, { wk: 't:blocked1', name: '准高一少女 初恋', kind: 'main' }],
                },
                sources: [
                    { site_key: 'a', site_name: 'stale-name', vod_id: '101', vod_name: 'SSIS-001 温泉旅馆的邂逅 中文字幕', vod_pic: '', type_name: '中文字幕', _variant: '中字', _dur: 7210, _family: 'stale', _dead: false, _res: '1920x1080', _native: 'risky', _same: 'g1' },
                    { site_key: 'd', site_name: 'x', vod_id: '401', vod_name: 'SSIS-001 温泉旅馆的邂逅', vod_pic: '', type_name: '日本有码', _variant: '', _dur: 0 },      // 停用站 → 丢
                    { site_key: 'b', site_name: 'x', vod_id: '206', vod_name: '私下曝光-某某大学生', vod_pic: '', type_name: '国产自拍', _variant: '', _dur: 0 },          // 被拦 → 丢
                    { site_key: 'b', site_name: 'x', vod_id: '201', vod_name: 'SSIS001 温泉旅馆的邂逅', vod_pic: '', type_name: '日本有码', _variant: '', _dur: 7212, _dead: true, _res: '', _same: 'g1' },
                ],
            };
        },
        // 分类图:type 77 本身名字无害,父分类是偷拍 → server.js 必须把 parentName 交给 checkItem
        classInfo(siteKey, typeId) {
            if (String(typeId) === '77') return { name: '精品视频', parentName: '自拍偷拍', bucket: 'cn_amateur', review: null, block: false };
            return null;
        },
        ingestSearchItems(siteKey, items) { rec({ ev: 'ingest', site: siteKey, ids: (items || []).map(i => i && i.vod_id) }); },
        // ---- 第三阶段 ----
        // AVDB 政策:SSIS-002 被 AVDB 拦(搜索出口 / 详情 / 作品线路都不能出)
        avdbPol(key) { return key === 'SSIS-002' ? 'block' : null; },
        // 封面代理:搜索结果里已经在索引的条目(a 站 101 = c:SSIS-001)
        indexedWks(siteKey, ids) { rec({ ev: 'indexed', site: siteKey, n: (ids || []).length }); const m = new Map(); if (siteKey === 'a' && (ids || []).map(String).includes('101')) m.set('101', 'c:SSIS-001'); return m; },
        async tagPage(id) {
            rec({ ev: 'tagPage', id });
            if (id !== 'wife') return null;
            return { tag: { id: 'wife', label: '人妻', group: 'persona' }, count: 9, buckets: [{ id: 'jp_censored', label: '日本有码', count: 5 }], related: [{ id: 'mature', label: '熟女', lift: 3.5 }],
                items: [card('t:ok1', '邻家姐姐的周末'), card('t:blocked2', '情侣自拍流出 合集')] };
        },
        async actress(aid, o) {
            rec({ ev: 'actress', aid, page: o && o.page });
            if (aid === '7') return { actress: { aid: 7, name: 'テスト花子', aliases: ['Test Hanako', '迷奸'] }, page: (o && o.page) || 1, total_pages: 1, results: [card('t:ok1', '邻家姐姐的周末'), card('t:blocked2', '情侣自拍流出 合集')] };
            if (aid === '8') return { actress: { aid: 8, name: '迷奸', aliases: [] }, page: 1, total_pages: 1, results: [] };   // 名字被拦 → 闸门 404
            return null;
        },
        actressSearch(q) { rec({ ev: 'actressSearch', q }); return [{ aid: 7, name: 'テスト花子', n: 3 }, { aid: 8, name: '迷奸', n: 1 }]; },
        studios(b) { rec({ ev: 'studios', b }); return [{ id: 'S1', label: 'S1', count: 4 }, { id: 'x', label: '迷奸传媒', count: 1 }, { id: 3, label: 'bad', count: 1 }]; },
        stats() { return { stub: true }; },
        // ---- 第四阶段(契约 P4 B1 的形状;闸门要再过滤一遍的东西故意塞进来)----
        async related(wk, o) {
            rec({ ev: 'related', wk, limit: o && o.limit });
            if (wk === 'c:SSIS-001') return {
                items: [card('c:SSIS-001', 'SSIS-001 温泉旅馆的邂逅'), card('t:ok1', '邻家姐姐的周末', { bucket: 'cn_amateur' }), card('t:blocked1', '准高一少女 初恋'),
                    card('c:SSIS-002', 'SSIS-002 某作品'), card('t:hid1', '被隐藏的合成作品', { bucket: 'cn_amateur' }), card('c:REL-001', 'REL-001 合成相关作品', { code: 'REL-001' })],
                actress: { aid: 7, name: 'テスト花子', items: [card('c:REL-002', 'REL-002 合成演员作品'), card('t:blocked2', '情侣自拍流出 合集')] },
                studio: { id: 'x', label: '迷奸传媒', items: [card('c:REL-003', 'REL-003 合成片商作品')] },   // 片商名被拦 → 闸门给 null
            };
            if (wk === 'c:REL-001') return { items: [], actress: { aid: 8, name: '迷奸', items: [] }, studio: { id: 'S1', label: 'S1', items: [card('c:REL-003', 'REL-003 合成片商作品')] } };
            return null;
        },
        async feed(o) {
            rec({ ev: 'feed', o });
            const L = (site, url, extra) => Object.assign({ site, url, dur: 45 }, extra || {});
            const item = (wk, name, orient, lines, extra) => Object.assign(card(wk, name, Object.assign({ bucket: 'short', dur: 45 }, extra || {})), { orient, dur: 45, lines });
            return {
                items: [
                    item('t:feed1', '合成短片 一号', 'v', [L('a', 'https://cdn.example/f1.m3u8', { vod_id: 101 }), L('d', 'https://cdn.example/f1d.m3u8'), L('zz', 'https://cdn.example/f1z.m3u8'),
                        L('a', 'javascript:alert(1)'), L('b', 'https://cdn.example/f1b.m3u8', { vod_name: '私下曝光-某某大学生' }), L('b', 'https://cdn.example/f1b2.m3u8')]),
                    item('t:blocked1', '准高一少女 初恋', 'v', [L('a', 'https://cdn.example/x.m3u8')]),
                    item('c:SSIS-002', 'SSIS-002 某作品', 'v', [L('a', 'https://cdn.example/y.m3u8')]),
                    item('t:feed4', '合成短片 横屏', 'h', [L('a', 'https://cdn.example/f4.m3u8')]),
                    item('t:feed5', '合成短片 无线路', 'v', [L('d', 'https://cdn.example/f5.m3u8'), L('a', 'ftp://cdn.example/f5.m3u8')]),
                    item('t:hid1', '被隐藏的合成作品', 'v', [L('a', 'https://cdn.example/h.m3u8')]),
                ],
                cursor_next: 'nx_1',
            };
        },
        async heat(wk) {
            rec({ ev: 'heat', wk });
            if (wk === 'c:SSIS-001') return { bins: Array.from({ length: 100 }, (_, i) => (i === 0 ? 150 : i === 1 ? -5 : i)), users: 5 };
            if (wk === 'c:FEW-001') return { bins: new Array(100).fill(1), users: 2 };
            return null;
        },
        async heatAdd(wk, o, who) { rec({ ev: 'heatAdd', wk, n: o && Array.isArray(o.bins) ? o.bins.length : -1, b0: o && o.bins && o.bins[0], b99: o && o.bins && o.bins[99], dur: o && o.dur, who }); return true; },
        async adminStats() {
            return { works: 3, lines: 9, sites: [{ key: 'a', name: '站A', lastOk: 1700000000000, fails: 0, active: true, overrideActive: null }, { key: 'b', name: '站B', lastOk: 0, fails: 2, active: true, overrideActive: null }],
                rejected: { 'category:x': 2 }, rescan: null, avdb: { n: 1 }, extraBlock: { n: 0, rev: '' } };
        },
        async adminHide(wk, on) {
            rec({ ev: 'adminHide', wk, on });
            if (wk === 't:catdown1') return { ok: false, reason: 'unavailable' };   // [integ] 目录写线程不可用 → 闸门回 503
            if (on) HIDDEN.set(wk, Date.now()); else HIDDEN.delete(wk);
            return true;
        },
        // [integ] 站点停用也交给目录(它的站点表里该站已被 server.js 标成 active:false)
        async adminSite(key, active) {
            let cfg = null;
            try { cfg = deps.getSites().find(x => x && x.key === key) || null; } catch (e) { cfg = null; }
            rec({ ev: 'adminSite', key, active, known: !!cfg, cfgActive: cfg ? cfg.active !== false : null });
            if (!cfg) return { ok: false, reason: 'unknown' };
            if (active === false) SITEOV.add(key); else SITEOV.delete(key);
            return { ok: true, key, active: active && cfg.active !== false, overrideActive: active ? null : false };
        },
        siteOverrides() { const o = {}; for (const k of SITEOV) o[k] = false; return o; },
        async adminHidden() {
            const NAMES = { 't:hid1': '被隐藏的合成作品', 't:blocked1': '准高一少女 初恋' };
            return [...HIDDEN].map(([wk, at]) => ({ wk, name: NAMES[wk] || wk.slice(2), at }));
        },
        setExtraBlock(words) {
            rec({ ev: 'setExtraBlock', words });
            // [integ] 目录没存上(写线程挂了之类)→ {ok:false};闸门的 PUT 要等这个结果并如实回 503
            if (Array.isArray(words) && words.indexOf('ZzCatFail') >= 0) return Promise.resolve({ ok: false, error: 'persist failed: test' });
            XWORDS = Array.isArray(words) ? words.slice() : [];
            return { n: XWORDS.length };
        },
        extraBlock() { return { words: XWORDS.slice(), n: XWORDS.length }; },
    };
}
module.exports = { createCatalog };
