const DEFAULT_BASE_URL = 'https://m.douban.com/rexxar/api/v2';
const DEFAULT_MOVIE_SEARCH_URL = 'https://movie.douban.com/j/search_subjects';

const HOME_ROW_KEYS = [
    'randomRow',
    'movieRow',
    'tvRow',
    'cnRow',
    'usRow',
    'krjpRow',
    'animeRow',
    'scifiRow',
    'actionRow',
    'comedyRow',
    'crimeRow',
    'romanceRow',
    'familyRow',
    'docRow',
    'warRow',
    'horrorRow',
    'mysteryRow',
    'fantasyRow',
    'varietyRow',
    'historyRow'
];

const GENRE_ROWS = {
    scifiRow: '\u79d1\u5e7b',
    actionRow: '\u52a8\u4f5c',
    comedyRow: '\u559c\u5267',
    crimeRow: '\u72af\u7f6a',
    romanceRow: '\u7231\u60c5',
    familyRow: '\u5bb6\u5ead',
    docRow: '\u7eaa\u5f55\u7247',
    warRow: '\u6218\u4e89',
    horrorRow: '\u6050\u6016',
    mysteryRow: '\u60ac\u7591',
    fantasyRow: '\u5947\u5e7b',
    historyRow: '\u5386\u53f2'
};

function textOf(value) {
    return String(value || '').trim();
}

function extractYear(item) {
    const match = textOf(item && item.card_subtitle).match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : '';
}

function categoryLabel(category) {
    if (category === 'movie') return '\u8c46\u74e3\u7535\u5f71';
    if (category === 'variety') return '\u8c46\u74e3\u7efc\u827a';
    if (category === 'anime') return '\u8c46\u74e3\u52a8\u6f2b';
    return '\u8c46\u74e3\u5267\u96c6';
}

function normalizeDoubanItem(item, category, reason = 'douban-recent-hot') {
    const title = textOf(item && item.title);
    if (!title) return null;
    const rating = Number(
        item && item.rating && item.rating.value
        || item && item.rate
        || 0
    );
    const poster = textOf(
        item && item.pic && (item.pic.large || item.pic.normal)
        || item && item.cover
    );
    const subtitle = textOf(item && (item.card_subtitle || item.episodes_info));
    return {
        id: `douban:${category}:${item.id || title}`,
        vod_id: `douban:${item.id || title}`,
        vod_name: title,
        vod_pic: poster,
        vod_year: extractYear(item),
        vod_score: rating > 0 ? String(rating) : '',
        vod_remarks: rating > 0
            ? `\u8c46\u74e3 ${rating.toFixed(1)}`
            : '\u8c46\u74e3\u70ed\u95e8',
        vod_content: subtitle,
        type_name: categoryLabel(category),
        recommendation_origin: 'douban',
        recommendation_category: category,
        recommendation_reason: reason,
        source_count: 0,
        sources: [],
        douban_id: textOf(item && item.id),
        douban_uri: textOf(item && (item.uri || item.url))
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

function requestOptions(params, referer) {
    return {
        params,
        timeout: 12000,
        headers: {
            Referer: referer,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DongguaTV/1.0',
            Accept: 'application/json'
        }
    };
}

async function fetchRecentHot(httpClient, baseUrl, path, params) {
    const response = await httpClient.get(
        `${baseUrl}${path}`,
        requestOptions(params, 'https://m.douban.com/')
    );
    return Array.isArray(response.data && response.data.items) ? response.data.items : [];
}

async function fetchMovieGenre(httpClient, searchUrl, genre, limit) {
    const response = await httpClient.get(
        searchUrl,
        requestOptions({
            type: 'movie',
            tag: genre,
            page_limit: limit,
            page_start: 0
        }, 'https://movie.douban.com/explore')
    );
    return Array.isArray(response.data && response.data.subjects)
        ? response.data.subjects
        : [];
}

async function settleRequests(requests) {
    const entries = Object.entries(requests);
    const settled = await Promise.allSettled(entries.map(([, request]) => request()));
    const values = {};
    const errors = [];
    settled.forEach((result, index) => {
        const key = entries[index][0];
        if (result.status === 'fulfilled') {
            values[key] = result.value;
        } else {
            values[key] = [];
            errors.push(`${key}: ${textOf(result.reason && result.reason.message || result.reason).slice(0, 120)}`);
        }
    });
    return { values, errors };
}

async function fetchDoubanHomeRows(options = {}) {
    const httpClient = options.httpClient;
    if (!httpClient || typeof httpClient.get !== 'function') {
        throw new Error('A compatible HTTP client is required for Douban homepage metadata.');
    }
    const baseUrl = textOf(options.baseUrl) || DEFAULT_BASE_URL;
    const movieSearchUrl = textOf(options.movieSearchUrl) || DEFAULT_MOVIE_SEARCH_URL;
    const limit = Math.max(20, Math.min(100, Number(options.limit || 100)));
    const normalizeTitle = options.normalizeTitle || (value => textOf(value).toLowerCase());

    const requests = {
        movie: () => fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/movie', {
            start: 0,
            limit,
            category: '\u70ed\u95e8',
            type: '\u5168\u90e8'
        }),
        domestic: () => fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/tv', {
            start: 0,
            limit,
            category: 'tv',
            type: 'tv_domestic'
        }),
        american: () => fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/tv', {
            start: 0,
            limit,
            category: 'tv',
            type: 'tv_american'
        }),
        japanese: () => fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/tv', {
            start: 0,
            limit,
            category: 'tv',
            type: 'tv_japanese'
        }),
        korean: () => fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/tv', {
            start: 0,
            limit,
            category: 'tv',
            type: 'tv_korean'
        }),
        animation: () => fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/tv', {
            start: 0,
            limit,
            category: 'tv',
            type: 'tv_animation'
        }),
        variety: () => fetchRecentHot(httpClient, baseUrl, '/subject/recent_hot/tv', {
            start: 0,
            limit,
            category: 'show',
            type: 'show_domestic'
        })
    };
    for (const [rowKey, genre] of Object.entries(GENRE_ROWS)) {
        requests[rowKey] = () => fetchMovieGenre(httpClient, movieSearchUrl, genre, limit);
    }

    const { values, errors } = await settleRequests(requests);
    const normalize = (items, category, reason) => (items || [])
        .map(item => normalizeDoubanItem(item, category, reason))
        .filter(Boolean);

    const movieRow = normalize(values.movie, 'movie', 'douban-recent-hot');
    const cnRow = normalize(values.domestic, 'series', 'douban-recent-hot');
    const usRow = normalize(values.american, 'series', 'douban-recent-hot');
    const japaneseRow = normalize(values.japanese, 'series', 'douban-recent-hot');
    const koreanRow = normalize(values.korean, 'series', 'douban-recent-hot');
    const animeRow = normalize(values.animation, 'anime', 'douban-recent-hot');
    const varietyRow = normalize(values.variety, 'variety', 'douban-recent-hot');
    const krjpRow = interleave([koreanRow, japaneseRow], limit);
    const tvRow = interleave([cnRow, usRow, koreanRow, japaneseRow], limit);
    const randomRow = interleave([cnRow, movieRow, usRow, krjpRow, animeRow, varietyRow], limit);

    const rows = Object.fromEntries(HOME_ROW_KEYS.map(key => [key, []]));
    Object.assign(rows, {
        randomRow,
        movieRow,
        tvRow,
        cnRow,
        usRow,
        krjpRow,
        animeRow,
        varietyRow
    });
    for (const rowKey of Object.keys(GENRE_ROWS)) {
        rows[rowKey] = normalize(values[rowKey], 'movie', 'douban-genre-hot');
    }
    for (const key of HOME_ROW_KEYS) {
        rows[key] = mergeUnique(rows[key], [], normalizeTitle, limit);
    }

    const rowCounts = Object.fromEntries(
        HOME_ROW_KEYS.map(key => [key, rows[key].length])
    );
    return {
        ok: Object.values(rowCounts).some(count => count > 0),
        provider: 'douban-home-categories',
        rows,
        counts: {
            movie: movieRow.length,
            series: tvRow.length,
            variety: varietyRow.length,
            rows: rowCounts
        },
        errors
    };
}

module.exports = {
    DEFAULT_BASE_URL,
    DEFAULT_MOVIE_SEARCH_URL,
    HOME_ROW_KEYS,
    GENRE_ROWS,
    normalizeDoubanItem,
    fetchDoubanHomeRows
};
