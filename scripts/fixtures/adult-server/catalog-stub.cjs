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
                _meta: { code: 'SSIS-001', dur: 7210, bucket: 'jp_subbed', tags: [], n_sites: 4, variants: ['中字'] },
                sources: [
                    { site_key: 'a', site_name: 'stale-name', vod_id: '101', vod_name: 'SSIS-001 温泉旅馆的邂逅 中文字幕', vod_pic: '', type_name: '中文字幕', _variant: '中字', _dur: 7210 },
                    { site_key: 'd', site_name: 'x', vod_id: '401', vod_name: 'SSIS-001 温泉旅馆的邂逅', vod_pic: '', type_name: '日本有码', _variant: '', _dur: 0 },      // 停用站 → 丢
                    { site_key: 'b', site_name: 'x', vod_id: '206', vod_name: '私下曝光-某某大学生', vod_pic: '', type_name: '国产自拍', _variant: '', _dur: 0 },          // 被拦 → 丢
                    { site_key: 'b', site_name: 'x', vod_id: '201', vod_name: 'SSIS001 温泉旅馆的邂逅', vod_pic: '', type_name: '日本有码', _variant: '', _dur: 7212 },
                ],
            };
        },
        // 分类图:type 77 本身名字无害,父分类是偷拍 → server.js 必须把 parentName 交给 checkItem
        classInfo(siteKey, typeId) {
            if (String(typeId) === '77') return { name: '精品视频', parentName: '自拍偷拍', bucket: 'cn_amateur', review: null, block: false };
            return null;
        },
        ingestSearchItems(siteKey, items) { rec({ ev: 'ingest', site: siteKey, ids: (items || []).map(i => i && i.vod_id) }); },
        stats() { return { stub: true }; },
    };
}
module.exports = { createCatalog };
