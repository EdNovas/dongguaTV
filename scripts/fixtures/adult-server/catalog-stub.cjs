'use strict';
// [adult] scripts/adult-server-test.mjs 用的 lib/site-catalog 替身:接口形状与真模块一致,数据写死,
//   每次调用追加一行 JSON 到 ADULT_TEST_CATALOG_LOG(测试据此核对 server.js 传了什么、调了什么)。片名全是合成的。
const fs = require('fs');
const LOG = process.env.ADULT_TEST_CATALOG_LOG || '';
const rec = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); };
const card = (wk, name, extra) => Object.assign({ wk, name, pic: '', sub: '1小时前 · 2:00:10 · 3线', badge: '', bucket: 'jp_censored', code: '', dur: 0, n_sites: 1, first_seen: 1700000000000 }, extra || {});

function createCatalog(deps) {
    let sites = [];
    try { sites = deps.getSites().map(s => s.key); } catch (e) { sites = ['ERR:' + e.message]; }
    rec({
        ev: 'create', keys: Object.keys(deps).sort(), sites,
        hasDb: !!(deps.db && typeof deps.db.prepare === 'function'),
        dbPath: typeof deps.dbPath === 'string' ? deps.dbPath : null,                 // 第三阶段:目录自己的 catalog.db
        avdbFactory: typeof deps.avdbFactory, tagsOk: !!(deps.tags && Array.isArray(deps.tags.VOCAB)),
        adultOk: !!(deps.adult && typeof deps.adult.RULES_VERSION === 'string' && deps.adult.policy),
        httpGet: typeof deps.httpGet, log: typeof deps.log, env: !!deps.env,
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
        tags(b) {
            rec({ ev: 'tags', b });
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
            if (wk !== 'c:SSIS-001') return null;
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
    };
}
module.exports = { createCatalog };
