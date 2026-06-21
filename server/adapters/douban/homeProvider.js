const DEFAULT_BASE_URL = 'https://m.douban.com/rexxar/api/v2';

function textOf(value) {
    return String(value || '').trim();
}

function extractYear(item) {
    const match = textOf(item && item.card_subtitle).match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : '';
}

function normalizeDoubanItem(item, category) {
    const title = textOf(item && item.title);
    if (!title) return null;
    const rating = Number(item && item.rating && item.rating.value || 0);
    const poster = textOf(item && item.pic && (item.pic.large || item.pic.normal));
    const subtitle = textOf(item && item.card_subtitle);
    return {
        id: `douban:${category}:${item.id || title}`,
        vod_id: `douban:${item.id || title}`,
        vod_name: title,
        vod_pic: poster,
        vod_year: extractYear(item),
        vod_score: rating > 0 ? String(rating) : '',
        vod_remarks: rating > 0 ? `豆瓣 ${rating.toFixed(1)}` : '豆瓣热播',
        vod_content: subtitle,
        type_name: category === 'movie' ? '豆瓣电影' : category === 'variety' ? '豆瓣综艺' : '豆瓣剧集',
        recommendation_origin: 'douban',
        recommendation_category: category,
        recommendation_reason: 'douban-recent-hot',
        source_count: 0,
        sources: [],
        douban_id: textOf(item && item.id),
        douban_uri: textOf(item && item.uri)
    };
}

function mergeUnique(primary, secondary, normalizeTitle, limit) {
    const merged = [];
    const seen = new Set();
    for (const item of [...(primary || []), ...(secondary || [])]) {
        const key = normalizeTitle(item && item.vod_name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
        if (merged.length >= limit) break;
    }
    return merged;
}

function interleave(groups, limit) {
    const positions = groups.map(() => 0);
    const result = [];
    while (result.length < limit) {
        let added = false;
        for (let index = 0; index < groups.length; index += 1) {
            const item = groups[index][positions[index]];
            if (!item) continue;
            positions[index] += 1;
            result.push(item);
            added = true;
            if (result.length >= limit) break;
        }
        if (!added) break;
    }
    return result;
}

async function fetchRecentHot(httpClient, baseUrl, path, params) {
    const response = await httpClient.get(`${baseUrl}${path}`, {
        params,
        timeout: 8000,
        headers: {
            Referer: 'https://m.douban.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DongguaTV/1.0',
            Accept: 'application/json'
        }
    });
    return Array.isArray(response.data && response.data.items) ? response.data.items : [];
}

async function fetchDoubanHomeRows(options = {}) {
    const httpClient = options.httpClient;
    if (!httpClient || typeof httpClient.get !== 'function') {
        throw new Error('A compatible HTTP client is required for Douban homepage metadata.');
    }
    const baseUrl = textOf(options.baseUrl) || DEFAULT_BASE_URL;
    const limit = Math.max(8, Math.min(48, Number(options.limit || 24)));
    const normalizeTitle = options.normalizeTitle || (value => textOf(value).toLowerCase());

    const [movieRaw, seriesRaw, varietyRaw] = await Promise.all([
        fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/movie', {
            start: 0,
            limit,
            category: '热门',
            type: '全部'
        }),
        fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/tv', {
            start: 0,
            limit,
            category: 'tv',
            type: 'tv_domestic'
        }),
        fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/tv', {
            start: 0,
            limit,
            category: 'show',
            type: 'show_domestic'
        })
    ]);

    const movieRow = movieRaw.map(item => normalizeDoubanItem(item, 'movie')).filter(Boolean);
    const tvRow = seriesRaw.map(item => normalizeDoubanItem(item, 'series')).filter(Boolean);
    const varietyRow = varietyRaw.map(item => normalizeDoubanItem(item, 'variety')).filter(Boolean);
    const randomRow = interleave([tvRow, movieRow], limit);

    return {
        ok: randomRow.length > 0 || movieRow.length > 0 || tvRow.length > 0,
        provider: 'douban-recent-hot',
        rows: {
            randomRow: mergeUnique(randomRow, [], normalizeTitle, limit),
            movieRow: mergeUnique(movieRow, [], normalizeTitle, limit),
            tvRow: mergeUnique(tvRow, [], normalizeTitle, limit),
            cnRow: mergeUnique(tvRow, [], normalizeTitle, limit),
            varietyRow: mergeUnique(varietyRow, [], normalizeTitle, limit)
        },
        counts: {
            movie: movieRow.length,
            series: tvRow.length,
            variety: varietyRow.length
        }
    };
}

module.exports = {
    DEFAULT_BASE_URL,
    normalizeDoubanItem,
    fetchDoubanHomeRows
};
