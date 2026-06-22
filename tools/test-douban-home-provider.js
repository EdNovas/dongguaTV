const assert = require('node:assert/strict');
const {
    HOME_ROW_KEYS,
    GENRE_ROWS,
    normalizeDoubanItem,
    fetchDoubanHomeRows
} = require('../server/adapters/douban/homeProvider');

function recentItem(id, title, rating = 8.1) {
    return {
        id,
        title,
        rating: { value: rating },
        card_subtitle: '2026 / Test region / Test genre',
        pic: {
            normal: `https://img.example.test/${id}.jpg`
        },
        uri: `douban://douban.com/movie/${id}`
    };
}

function genreItem(id, title, rating = 8.2) {
    return {
        id,
        title,
        rate: String(rating),
        cover: `https://img.example.test/${id}.jpg`,
        url: `https://movie.douban.com/subject/${id}/`
    };
}

function makeItems(prefix, count, factory) {
    return Array.from({ length: count }, (_, index) => (
        factory(`${prefix}-${index + 1}`, `${prefix.toUpperCase()} ${index + 1}`)
    ));
}

(async () => {
    const requests = [];
    const genreByValue = new Map(
        Object.entries(GENRE_ROWS).map(([rowKey, genre]) => [genre, rowKey])
    );
    const httpClient = {
        async get(url, options) {
            requests.push({ url, options });
            if (url.includes('/j/search_subjects')) {
                const rowKey = genreByValue.get(options.params.tag);
                assert.ok(rowKey, `Unexpected genre tag: ${options.params.tag}`);
                return {
                    data: {
                        subjects: makeItems(rowKey, 35, genreItem)
                    }
                };
            }

            if (url.includes('/subject/recent_hot/movie')) {
                return {
                    data: {
                        items: makeItems('movie', 40, recentItem)
                    }
                };
            }

            const type = options.params.type;
            const counts = {
                tv_domestic: 42,
                tv_american: 38,
                tv_japanese: 26,
                tv_korean: 24,
                tv_animation: 36,
                show_domestic: 28
            };
            assert.ok(counts[type], `Unexpected TV type: ${type}`);
            return {
                data: {
                    items: makeItems(type, counts[type], recentItem)
                }
            };
        }
    };

    const result = await fetchDoubanHomeRows({
        httpClient,
        baseUrl: 'https://douban.example.test/api/v2',
        movieSearchUrl: 'https://movie.example.test/j/search_subjects',
        limit: 100,
        normalizeTitle: value => String(value || '').replace(/\s+/g, '').toLowerCase()
    });

    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.equal(requests.length, 19);
    assert.deepEqual(Object.keys(result.rows), HOME_ROW_KEYS);
    assert.equal(HOME_ROW_KEYS.every(key => result.rows[key].length > 0), true);
    assert.equal(result.rows.movieRow.length, 40);
    assert.equal(result.rows.cnRow.length, 42);
    assert.equal(result.rows.usRow.length, 38);
    assert.equal(result.rows.krjpRow.length, 50);
    assert.equal(result.rows.animeRow.length, 36);
    assert.equal(result.rows.varietyRow.length, 28);
    assert.equal(result.rows.scifiRow.length, 35);
    assert.equal(result.rows.historyRow.length, 35);
    assert.equal(result.rows.tvRow.length, 100);
    assert.equal(result.rows.randomRow.length, 100);
    assert.equal(result.rows.comedyRow[0].recommendation_reason, 'douban-genre-hot');
    assert.equal(result.rows.movieRow[0].recommendation_origin, 'douban');
    assert.equal(
        normalizeDoubanItem(recentItem('x', 'Lead title', 0), 'series').vod_remarks,
        '\u8c46\u74e3\u70ed\u95e8'
    );

    const flakyAttempts = new Map();
    const flakyClient = {
        async get(url, options) {
            const requestKey = url.includes('/j/search_subjects')
                ? genreByValue.get(options.params.tag)
                : options.params.type || 'movie';
            const attempts = (flakyAttempts.get(requestKey) || 0) + 1;
            flakyAttempts.set(requestKey, attempts);

            if ((requestKey === 'tv_domestic' || requestKey === 'actionRow') && attempts === 1) {
                throw new Error('simulated transient timeout');
            }
            return httpClient.get(url, options);
        }
    };
    const recovered = await fetchDoubanHomeRows({
        httpClient: flakyClient,
        baseUrl: 'https://douban.example.test/api/v2',
        movieSearchUrl: 'https://movie.example.test/j/search_subjects',
        limit: 100,
        normalizeTitle: value => String(value || '').replace(/\s+/g, '').toLowerCase()
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.complete, true);
    assert.deepEqual(recovered.errors, []);
    assert.equal(flakyAttempts.get('tv_domestic'), 2);
    assert.equal(flakyAttempts.get('actionRow'), 2);
    assert.equal(HOME_ROW_KEYS.every(key => recovered.rows[key].length > 0), true);

    console.log(JSON.stringify({
        ok: true,
        provider: result.provider,
        requestCount: requests.length,
        recoveredTransientFailures: 2,
        rowCounts: result.counts.rows
    }, null, 2));
})().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
