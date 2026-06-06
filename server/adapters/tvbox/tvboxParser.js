const fs = require('fs');

function stripJsonLikeComments(text) {
    return String(text || '')
        .replace(/^\uFEFF/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function parseTvboxJson(text) {
    const cleaned = stripJsonLikeComments(text);
    return JSON.parse(cleaned);
}

async function loadTvboxConfig(input, httpClient) {
    if (input.config && typeof input.config === 'object') {
        return input.config;
    }

    if (input.filePath) {
        return parseTvboxJson(fs.readFileSync(input.filePath, 'utf8'));
    }

    if (!input.url) {
        throw new Error('A TVBox subscription URL, local file path, or JSON config is required.');
    }

    const response = await httpClient.get(input.url, {
        timeout: 15000,
        responseType: 'text',
        transformResponse: data => data,
        headers: {
            'User-Agent': 'DongguaTV/1.0'
        }
    });
    return parseTvboxJson(response.data);
}

function pickTvboxFields(config) {
    const safe = config && typeof config === 'object' ? config : {};
    return {
        sites: Array.isArray(safe.sites) ? safe.sites : [],
        parses: Array.isArray(safe.parses) ? safe.parses : [],
        lives: Array.isArray(safe.lives) ? safe.lives : [],
        spider: safe.spider || null,
        jar: safe.jar || null,
        flags: safe.flags || [],
        rules: safe.rules || [],
        doh: safe.doh || null,
        wallpaper: safe.wallpaper || null,
        ads: safe.ads || [],
        warningText: safe.warningText || '',
        ijk: safe.ijk || [],
        player: safe.player || {},
        ext: safe.ext || null
    };
}

module.exports = {
    loadTvboxConfig,
    parseTvboxJson,
    pickTvboxFields
};
