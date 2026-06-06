const crypto = require('crypto');

function stableHash(parts) {
    return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 16);
}

function nowIso() {
    return new Date().toISOString();
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function looksLikePluginScript(value) {
    const text = String(value || '').trim().toLowerCase();
    return text.startsWith('csp_') ||
        text.includes('spider.jar') ||
        /\.(jar|py|js)(\?|#|$)/i.test(text) ||
        text.includes('drpy') ||
        text.startsWith('assets://') ||
        text.startsWith('file://');
}

function inferSourceSupport(site, rootConfig) {
    const api = String(site.api || '').trim();
    const tvboxType = Number.isFinite(Number(site.type)) ? Number(site.type) : null;
    const hasJar = !!(site.jar || rootConfig.jar || rootConfig.spider);

    if (tvboxType === 3 && api.toLowerCase().startsWith('csp_')) {
        return {
            sourceType: 'plugin-required',
            status: 'plugin-required',
            supportLevel: 'plugin-required'
        };
    }

    if (looksLikePluginScript(api) || hasJar && !isHttpUrl(api)) {
        return {
            sourceType: 'plugin-required',
            status: 'plugin-required',
            supportLevel: 'plugin-required'
        };
    }

    if (isHttpUrl(api)) {
        const lowerApi = api.toLowerCase();
        const sourceType = lowerApi.includes('provide/vod') || lowerApi.includes('ac=list') ? 'maccms' : 'tvbox';
        return {
            sourceType,
            status: 'partial',
            supportLevel: tvboxType === 0 || tvboxType === 1 || tvboxType === 2 ? 'basic' : 'metadata-only'
        };
    }

    return {
        sourceType: 'tvbox',
        status: 'unsupported',
        supportLevel: 'unsupported'
    };
}

function normalizeBoolean(value, fallback) {
    if (value === undefined || value === null) return fallback;
    return value === 1 || value === true || value === '1' || value === 'true';
}

function normalizeSite(site, context) {
    const timestamp = nowIso();
    const key = String(site.key || site.name || site.api || `site-${context.index}`).trim();
    const support = inferSourceSupport(site, context.rootConfig);
    return {
        id: `tvbox-source-${stableHash([context.subscriptionId, key, site.api, String(context.index)])}`,
        sourceSubscriptionId: context.subscriptionId,
        sourceType: support.sourceType,
        key,
        name: String(site.name || key || 'Unnamed Source').trim(),
        api: String(site.api || '').trim(),
        tvboxType: Number.isFinite(Number(site.type)) ? Number(site.type) : null,
        searchable: normalizeBoolean(site.searchable, true),
        quickSearch: normalizeBoolean(site.quickSearch, false),
        filterable: normalizeBoolean(site.filterable, false),
        switchable: normalizeBoolean(site.switchable, true),
        ext: site.ext === undefined ? null : site.ext,
        jar: site.jar || context.rootConfig.jar || null,
        spider: context.rootConfig.spider || null,
        status: support.status,
        supportLevel: support.supportLevel,
        enabled: site.enabled === undefined ? true : !!site.enabled,
        raw: site,
        createdAt: timestamp,
        updatedAt: timestamp
    };
}

function normalizeSites(sites, context) {
    return sites.map((site, index) => normalizeSite(site || {}, { ...context, index }));
}

function normalizeParses(parses, subscriptionId) {
    const timestamp = nowIso();
    return parses.map((parse, index) => ({
        id: `tvbox-parse-${stableHash([subscriptionId, parse.name, parse.url, String(index)])}`,
        sourceSubscriptionId: subscriptionId,
        name: parse.name || `parse-${index + 1}`,
        type: parse.type === undefined ? null : parse.type,
        url: parse.url || '',
        ext: parse.ext === undefined ? null : parse.ext,
        enabled: parse.enabled === undefined ? true : !!parse.enabled,
        raw: parse,
        createdAt: timestamp,
        updatedAt: timestamp
    }));
}

function countBy(items, predicate) {
    return items.filter(predicate).length;
}

function summarizeSources(sources, liveChannels, parses) {
    return {
        sites: sources.length,
        lives: liveChannels.length,
        parses: parses.length,
        pluginRequired: countBy(sources, source => source.status === 'plugin-required'),
        unsupported: countBy(sources, source => source.status === 'unsupported'),
        available: countBy(sources, source => source.status === 'available' || source.status === 'partial')
    };
}

module.exports = {
    isHttpUrl,
    stableHash,
    normalizeSites,
    normalizeParses,
    summarizeSources
};
