const { URL } = require('url');
const { isHttpUrl, stableHash } = require('./tvboxNormalizer');

function parseAttrs(text) {
    const attrs = {};
    String(text || '').replace(/([a-zA-Z0-9_-]+)="([^"]*)"/g, (_, key, value) => {
        attrs[key] = value;
        return '';
    });
    return attrs;
}

function makeChannel({ subscriptionId, name, group, url, logo, headers, status }) {
    return {
        id: `live-${stableHash([subscriptionId, name, group, url])}`,
        name: String(name || 'Unnamed Channel').trim(),
        group: String(group || '默认').trim(),
        url: String(url || '').trim(),
        logo: logo || null,
        sourceSubscriptionId: subscriptionId,
        headers: headers || {},
        status: status || (url ? 'unknown' : 'error')
    };
}

function parseM3u(content, subscriptionId) {
    const channels = [];
    const lines = String(content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    let pending = null;

    for (const line of lines) {
        if (line.startsWith('#EXTINF')) {
            const commaIndex = line.lastIndexOf(',');
            const attrPart = commaIndex >= 0 ? line.slice(0, commaIndex) : line;
            const attrs = parseAttrs(attrPart);
            pending = {
                name: commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : attrs['tvg-name'],
                group: attrs['group-title'] || '默认',
                logo: attrs['tvg-logo'] || null
            };
            continue;
        }

        if (line.startsWith('#')) continue;
        if (!pending) {
            pending = { name: line, group: '默认', logo: null };
        }

        channels.push(makeChannel({
            subscriptionId,
            name: pending.name,
            group: pending.group,
            logo: pending.logo,
            url: line,
            status: isHttpUrl(line) ? 'unknown' : 'error'
        }));
        pending = null;
    }

    return channels;
}

function parseTxt(content, subscriptionId) {
    const channels = [];
    let group = '默认';
    const lines = String(content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
        if (line.startsWith('#')) continue;
        const parts = line.split(',');
        if (parts.length < 2) continue;

        const name = parts.shift().trim();
        const rest = parts.join(',').trim();
        if (!name || !rest) continue;

        if (rest === '#genre#') {
            group = name;
            continue;
        }

        const url = rest.split('#').find(part => isHttpUrl(part.trim())) || rest.split('#')[0];
        channels.push(makeChannel({
            subscriptionId,
            name,
            group,
            url: url.trim(),
            logo: null,
            status: isHttpUrl(url) ? 'unknown' : 'error'
        }));
    }

    return channels;
}

function detectLiveFormat(url, content) {
    const lowerUrl = String(url || '').toLowerCase();
    const head = String(content || '').slice(0, 200).trim();
    if (head.startsWith('#EXTM3U') || lowerUrl.endsWith('.m3u') || lowerUrl.endsWith('.m3u8')) return 'm3u';
    return 'txt';
}

function extractHttpUrl(value) {
    const text = String(value || '').trim();
    if (isHttpUrl(text)) return text;

    const extMatch = text.match(/[?&]ext=([^&]+)/i);
    if (extMatch) {
        try {
            const decoded = decodeURIComponent(extMatch[1]);
            if (isHttpUrl(decoded)) return decoded;
        } catch (error) {
            return null;
        }
    }

    const directMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
    return directMatch ? directMatch[0] : null;
}

async function parseLives(lives, subscriptionId, httpClient) {
    const channels = [];
    const errors = [];

    for (const [index, live] of lives.entries()) {
        const liveUrl = extractHttpUrl(live && live.url);
        const liveName = live && (live.name || live.group || `live-${index + 1}`);

        if (Array.isArray(live && live.channels)) {
            for (const channel of live.channels) {
                channels.push(makeChannel({
                    subscriptionId,
                    name: channel.name,
                    group: channel.group || liveName,
                    logo: channel.logo || null,
                    url: channel.url,
                    headers: channel.headers || {},
                    status: isHttpUrl(channel.url) ? 'unknown' : 'error'
                }));
            }
            continue;
        }

        if (!liveUrl) {
            errors.push({ index, reason: 'unsupported-live-url' });
            continue;
        }

        try {
            const response = await httpClient.get(liveUrl, {
                timeout: 12000,
                responseType: 'text',
                transformResponse: data => data,
                headers: { 'User-Agent': 'DongguaTV/1.0' }
            });
            const format = detectLiveFormat(liveUrl, response.data);
            const parsed = format === 'm3u'
                ? parseM3u(response.data, subscriptionId)
                : parseTxt(response.data, subscriptionId);
            channels.push(...parsed);
        } catch (error) {
            errors.push({ index, reason: 'fetch-failed' });
        }
    }

    const unique = [];
    const seen = new Set();
    for (const channel of channels) {
        if (!channel.url || seen.has(channel.id)) continue;
        seen.add(channel.id);
        unique.push(channel);
    }

    return { channels: unique, errors };
}

module.exports = {
    parseLives,
    parseM3u,
    parseTxt
};
