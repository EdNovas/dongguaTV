const assert = require('node:assert/strict');
const {
    normalizeDoubanItem,
    fetchDoubanHomeRows
} = require('../server/adapters/douban/homeProvider');

function item(id, title, rating, subtitle) {
    return {
        id,
        title,
        rating: { value: rating },
        card_subtitle: subtitle,
        pic: {
            normal: `https://img.example.test/${id}.jpg`
        },
        uri: `douban://douban.com/movie/${id}`
    };
}

(async () => {
    const requests = [];
    const httpClient = {
        async get(url, options) {
            requests.push({ url, options });
            if (options.params.category === '热门') {
                return {
                    data: {
                        items: [
                            item('m1', '镖人：风起大漠', 7.6, '2026 / 中国大陆 / 动作'),
                            item('m2', '玩具总动员5', 8.1, '2026 / 美国 / 动画')
                        ]
                    }
                };
            }
            if (options.params.type === 'show_domestic') {
                return {
                    data: {
                        items: [
                            item('v1', '认识的哥哥', 8.4, '2015 / 韩国 / 真人秀')
                        ]
                    }
                };
            }
            return {
                data: {
                    items: [
                        item('t1', '爱情有烟火', 7.2, '2026 / 中国大陆 / 剧情'),
                        item('t2', '南部档案', 7.8, '2026 / 中国大陆 / 悬疑'),
                        item('t3', '莫离', 7.5, '2026 / 中国大陆 / 古装')
                    ]
                }
            };
        }
    };

    const rows = await fetchDoubanHomeRows({
        httpClient,
        baseUrl: 'https://douban.example.test/api/v2',
        limit: 12,
        normalizeTitle: value => String(value || '').replace(/\s+/g, '').toLowerCase()
    });

    assert.equal(rows.ok, true);
    assert.equal(requests.length, 3);
    assert.equal(requests.every(request => request.options.headers.Referer === 'https://m.douban.com/'), true);
    assert.deepEqual(
        rows.rows.tvRow.slice(0, 3).map(entry => entry.vod_name),
        ['爱情有烟火', '南部档案', '莫离']
    );
    assert.deepEqual(
        rows.rows.randomRow.slice(0, 4).map(entry => entry.vod_name),
        ['爱情有烟火', '镖人：风起大漠', '南部档案', '玩具总动员5']
    );
    assert.equal(rows.rows.movieRow[0].recommendation_origin, 'douban');
    assert.equal(rows.rows.varietyRow[0].vod_name, '认识的哥哥');
    assert.equal(normalizeDoubanItem(item('x', '主角', 0, '2026 / 剧情'), 'series').vod_remarks, '豆瓣热播');

    console.log(JSON.stringify({
        ok: true,
        provider: rows.provider,
        counts: rows.counts,
        random: rows.rows.randomRow.map(entry => entry.vod_name)
    }, null, 2));
})().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
