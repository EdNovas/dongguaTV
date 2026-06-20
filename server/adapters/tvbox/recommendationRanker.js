const SHORT_FORM_KEYWORDS = [
    '短剧',
    '微短剧',
    '爽文',
    '竖屏',
    '小剧场',
    '网剧',
    '网络剧',
    '合集',
    '解说',
    '电影解说',
    '电视剧解说',
    '讲电影',
    '看电影',
    '盘点'
];

const MAINSTREAM_HINTS = [
    '电影',
    '电视剧',
    '剧集',
    '连续剧',
    '动漫',
    '动画',
    '综艺',
    '纪录片'
];

function textOf(value) {
    return String(value || '').trim();
}

function normalizeVodTitle(title) {
    return textOf(title)
        .replace(/[【\[\(（].*?[】\]\)）]/g, '')
        .replace(/第[一二三四五六七八九十0-9]+季/g, '')
        .replace(/S\d{1,2}/ig, '')
        .replace(/\b(4k|8k|1080p|720p|2160p|hdr|h265|hevc|x265|x264|web-dl|bluray|bd|hd|tc|ts)\b/ig, '')
        .replace(/\b(19|20)\d{2}\b/g, '')
        .replace(/[\s._\-:：]+/g, '')
        .toLowerCase();
}

function latestTimestamp(item) {
    const candidates = [
        item && item.vod_time,
        item && item.vod_pubdate,
        item && item.vod_addtime,
        item && item.vod_year
    ];
    for (const value of candidates) {
        const raw = textOf(value);
        if (!raw) continue;
        if (/^\d{4}$/.test(raw)) {
            const year = Number(raw);
            if (year >= 1900 && year <= 2100) return new Date(`${raw}-01-01T00:00:00Z`).getTime();
        }
        const parsed = Date.parse(raw.replace(' ', 'T'));
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

function shortFormPenalty(item) {
    const haystack = [
        item && item.vod_name,
        item && item.type_name,
        item && item.vod_remarks,
        item && item.vod_content
    ].map(textOf).join(' ');
    let penalty = 0;
    for (const keyword of SHORT_FORM_KEYWORDS) {
        if (haystack.includes(keyword)) penalty += keyword === '网剧' || keyword === '网络剧' ? 18 : 35;
    }
    return Math.min(120, penalty);
}

function categoryForItem(item) {
    const text = [
        item && item.type_name,
        item && item.vod_name,
        item && item.vod_remarks
    ].map(textOf).join(' ');
    if (/综艺|真人秀|脱口秀|晚会|音乐/.test(text)) return 'variety';
    if (/动漫|动画|番剧|漫画|少儿/.test(text)) return 'anime';
    if (/电视剧|连续剧|国产剧|欧美剧|日韩剧|韩剧|日剧|美剧|港剧|台剧|剧集/.test(text)) return 'series';
    if (/电影|动作|喜剧|爱情|科幻|悬疑|犯罪|恐怖|战争|剧情|纪录片/.test(text)) return 'movie';
    return 'mixed';
}

function scoreVodCandidate(item, sourceCount = 1) {
    const text = [
        item && item.vod_name,
        item && item.type_name,
        item && item.vod_remarks
    ].map(textOf).join(' ');
    const hasPoster = !!textOf(item && item.vod_pic);
    const hasPlayable = !!textOf(item && item.vod_play_url);
    const timestamp = latestTimestamp(item);
    const ageDays = timestamp > 0 ? Math.max(0, (Date.now() - timestamp) / 86400000) : 9999;
    const recencyScore = timestamp > 0 ? Math.max(0, 32 - Math.min(32, ageDays / 30)) : 0;
    const mainstreamScore = MAINSTREAM_HINTS.some(keyword => text.includes(keyword)) ? 12 : 0;

    return Math.round(
        40
        + Math.min(100, sourceCount * 22)
        + (hasPoster ? 18 : 0)
        + (hasPlayable ? 18 : 0)
        + recencyScore
        + mainstreamScore
        - shortFormPenalty(item)
    );
}

function normalizeVodItem(item, site) {
    const vodName = textOf(item && (item.vod_name || item.name || item.title));
    if (!vodName) return null;
    return {
        vod_id: textOf(item.vod_id || item.id || vodName),
        vod_name: vodName,
        vod_pic: textOf(item.vod_pic || item.pic || item.poster || ''),
        vod_remarks: textOf(item.vod_remarks || item.remarks || ''),
        vod_year: textOf(item.vod_year || item.year || ''),
        vod_time: textOf(item.vod_time || item.time || ''),
        vod_pubdate: textOf(item.vod_pubdate || item.pubdate || ''),
        vod_addtime: textOf(item.vod_addtime || item.addtime || ''),
        type_name: textOf(item.type_name || item.type || ''),
        vod_content: textOf(item.vod_content || item.content || ''),
        vod_play_from: textOf(item.vod_play_from || ''),
        vod_play_url: textOf(item.vod_play_url || ''),
        site_key: site && site.key,
        site_name: site && site.name,
        source_origin: site && (site.sourceOrigin || 'native')
    };
}

function mergeAndRankVodItems(items) {
    const groups = new Map();
    for (const item of items || []) {
        const key = normalizeVodTitle(item && item.vod_name);
        if (!key) continue;
        const group = groups.get(key) || {
            key,
            title: item.vod_name,
            candidates: [],
            sourceKeys: new Set(),
            latest: 0
        };
        group.candidates.push(item);
        if (item.site_key) group.sourceKeys.add(item.site_key);
        group.latest = Math.max(group.latest, latestTimestamp(item));
        groups.set(key, group);
    }

    return [...groups.values()].map(group => {
        group.candidates.sort((a, b) => {
            const sourceCount = group.sourceKeys.size || 1;
            return scoreVodCandidate(b, sourceCount) - scoreVodCandidate(a, sourceCount)
                || latestTimestamp(b) - latestTimestamp(a)
                || textOf(a.site_name).localeCompare(textOf(b.site_name), 'zh-Hans-CN');
        });
        const best = group.candidates[0];
        const sourceCount = group.sourceKeys.size || 1;
        const score = scoreVodCandidate(best, sourceCount);
        return {
            ...best,
            id: `${best.site_key || 'source'}:${best.vod_id || group.key}`,
            source_count: sourceCount,
            recommendation_score: score,
            recommendation_category: categoryForItem(best),
            recommendation_origin: 'source-native',
            recommendation_reason: sourceCount > 1
                ? `multi-source:${sourceCount}`
                : shortFormPenalty(best) > 0 ? 'downranked-short-form' : 'source-home',
            sources: group.candidates.map(candidate => ({
                vod_id: candidate.vod_id,
                vod_name: candidate.vod_name,
                vod_pic: candidate.vod_pic,
                vod_remarks: candidate.vod_remarks,
                vod_year: candidate.vod_year,
                vod_time: candidate.vod_time,
                vod_pubdate: candidate.vod_pubdate,
                vod_addtime: candidate.vod_addtime,
                type_name: candidate.type_name,
                vod_play_from: candidate.vod_play_from,
                vod_play_url: candidate.vod_play_url,
                site_key: candidate.site_key,
                site_name: candidate.site_name,
                source_origin: candidate.source_origin
            }))
        };
    }).sort((a, b) => {
        return Number(b.recommendation_score || 0) - Number(a.recommendation_score || 0)
            || latestTimestamp(b) - latestTimestamp(a)
            || textOf(a.vod_name).localeCompare(textOf(b.vod_name), 'zh-Hans-CN');
    });
}

function splitRecommendationRows(items, limitPerRow = 24) {
    const rows = {
        randomRow: [],
        movieRow: [],
        tvRow: [],
        cnRow: [],
        animeRow: [],
        varietyRow: []
    };
    for (const item of items || []) {
        const category = item.recommendation_category || categoryForItem(item);
        rows.randomRow.push(item);
        if (category === 'movie') rows.movieRow.push(item);
        if (category === 'series') rows.tvRow.push(item);
        if (category === 'anime') rows.animeRow.push(item);
        if (category === 'variety') rows.varietyRow.push(item);
        if (/国产|中国|大陆|华语|内地|港剧|台剧/.test(`${item.type_name || ''} ${item.vod_name || ''}`)) {
            rows.cnRow.push(item);
        }
    }

    for (const key of Object.keys(rows)) {
        rows[key] = rows[key].slice(0, limitPerRow);
    }
    return rows;
}

module.exports = {
    normalizeVodTitle,
    latestTimestamp,
    shortFormPenalty,
    categoryForItem,
    scoreVodCandidate,
    normalizeVodItem,
    mergeAndRankVodItems,
    splitRecommendationRows
};
