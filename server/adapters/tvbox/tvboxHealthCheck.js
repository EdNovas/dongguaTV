const { isHttpUrl } = require('./tvboxNormalizer');

async function checkSourceHealth(source, httpClient) {
    if (!source) {
        return { status: 'error', reason: 'source-not-found' };
    }

    if (source.status === 'plugin-required') {
        return { status: 'plugin-required', reason: 'plugin-runtime-required' };
    }

    if (!isHttpUrl(source.api)) {
        return { status: 'unsupported', reason: 'not-http-api' };
    }

    const startedAt = Date.now();
    try {
        await httpClient.get(source.api, {
            timeout: 8000,
            maxRedirects: 3,
            headers: { 'User-Agent': 'DongguaTV/1.0' },
            validateStatus: status => status >= 200 && status < 500
        });
        return {
            status: 'available',
            latency: Date.now() - startedAt,
            checkedAt: new Date().toISOString()
        };
    } catch (error) {
        return {
            status: 'error',
            reason: 'request-failed',
            checkedAt: new Date().toISOString()
        };
    }
}

module.exports = {
    checkSourceHealth
};
