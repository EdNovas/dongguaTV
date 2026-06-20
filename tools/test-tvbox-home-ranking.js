const assert = require('node:assert/strict');
const {
    normalizeVodItem,
    mergeAndRankVodItems,
    splitRecommendationRows,
    shortFormPenalty,
    isLowQualityRankItem,
    categoryForItem
} = require('../server/adapters/tvbox/recommendationRanker');

const siteA = { key: 'tvbox:a', name: 'A Source', sourceOrigin: 'tvbox' };
const siteB = { key: 'tvbox:b', name: 'B Source', sourceOrigin: 'tvbox' };

const mainstreamA = normalizeVodItem({
    vod_id: '100',
    vod_name: '流浪地球2 4K',
    vod_pic: 'https://example.test/poster-a.jpg',
    vod_year: '2023',
    type_name: '电影',
    vod_play_url: 'HD$https://example.test/a.m3u8'
}, siteA);

const mainstreamB = normalizeVodItem({
    vod_id: '200',
    vod_name: '流浪地球2',
    vod_pic: 'https://example.test/poster-b.jpg',
    vod_year: '2023',
    type_name: '科幻电影',
    vod_play_url: 'HD$https://example.test/b.m3u8'
}, siteB);

const shortDrama = normalizeVodItem({
    vod_id: '300',
    vod_name: '霸总短剧合集',
    vod_pic: 'https://example.test/short.jpg',
    vod_time: '2026-06-20 10:00:00',
    type_name: '短剧',
    vod_remarks: '竖屏爽文',
    vod_play_url: '01$https://example.test/short.m3u8'
}, siteA);

const explainer = normalizeVodItem({
    vod_id: '400',
    vod_name: '一分钟看完某电影解说',
    vod_pic: 'https://example.test/explain.jpg',
    vod_time: '2026-06-20 10:00:00',
    type_name: '电影解说',
    vod_play_url: '01$https://example.test/explain.m3u8'
}, siteB);

const series = normalizeVodItem({
    vod_id: '500',
    vod_name: '庆余年 第二季',
    vod_pic: 'https://example.test/series.jpg',
    vod_year: '2024',
    type_name: '国产剧',
    vod_play_url: '01$https://example.test/series.m3u8'
}, siteA);

const ranked = mergeAndRankVodItems([shortDrama, mainstreamA, mainstreamB, explainer, series]);
const rows = splitRecommendationRows(ranked, 12);

assert.equal(shortFormPenalty(shortDrama) > 0, true);
assert.equal(shortFormPenalty(explainer) > 0, true);
assert.equal(isLowQualityRankItem(shortDrama), true);
assert.equal(isLowQualityRankItem(explainer), true);
assert.equal(categoryForItem(mainstreamA), 'movie');
assert.equal(categoryForItem(series), 'series');
assert.equal(ranked[0].vod_name, '流浪地球2 4K');
assert.equal(ranked[0].source_count, 2);
assert.equal(rows.randomRow[0].vod_name, '流浪地球2 4K');
assert.equal(rows.movieRow.some(item => item.vod_name.includes('流浪地球2')), true);
assert.equal(rows.tvRow.some(item => item.vod_name.includes('庆余年')), true);
assert.equal(rows.randomRow.some(item => item.vod_name.includes('短剧')), false);
assert.equal(rows.randomRow.some(item => item.vod_name.includes('解说')), false);

console.log(JSON.stringify({
    ok: true,
    top: ranked.slice(0, 4).map(item => ({
        name: item.vod_name,
        score: item.recommendation_score,
        sourceCount: item.source_count,
        reason: item.recommendation_reason
    })),
    rows: Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.map(item => item.vod_name)]))
}, null, 2));
