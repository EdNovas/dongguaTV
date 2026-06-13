const net = require('net');

const ALLOWED_OPERATIONS = new Set(['search', 'category', 'detail', 'play']);

function normalizeBaseUrl(baseUrl) {
    const value = String(baseUrl || '').trim();
    if (!value) return '';
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Bridge URL must use http or https.');
    }
    if (!isAllowedBridgeHost(url.hostname)) {
        throw new Error('Bridge URL must point to localhost or a private network address.');
    }
    return url.toString().replace(/\/$/, '');
}

function isAllowedBridgeHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;

    if (net.isIP(host)) {
        if (host.startsWith('127.')) return true;
        if (host.startsWith('10.')) return true;
        if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
        if (host.startsWith('192.168.')) return true;
        if (host.startsWith('169.254.')) return true;
        if (/^fe80:/i.test(host)) return true;
        if (/^fc00:/i.test(host) || /^fd[0-9a-f]{2}:/i.test(host)) return true;
    }

    return false;
}

class ExternalHttpBridgeClient {
    constructor({ baseUrl, httpClient }) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.httpClient = httpClient;
    }

    isConfigured() {
        return !!this.baseUrl;
    }

    async health() {
        if (!this.isConfigured()) {
            return { status: 'not-installed', configured: false };
        }
        try {
            const response = await this.httpClient.get(`${this.baseUrl}/health`, {
                timeout: 5000,
                validateStatus: status => status >= 200 && status < 500
            });
            return {
                status: response.status >= 200 && response.status < 300 ? 'available' : 'error',
                configured: true,
                httpStatus: response.status,
                data: response.data || null
            };
        } catch (error) {
            return {
                status: 'error',
                configured: true,
                error: error.message || 'Bridge health check failed'
            };
        }
    }

    async call(operation, payload) {
        if (!ALLOWED_OPERATIONS.has(operation)) {
            throw new Error('Unsupported bridge operation.');
        }
        if (!this.isConfigured()) {
            throw new Error('External HTTP bridge is not configured.');
        }
        const response = await this.httpClient.post(`${this.baseUrl}/runtime/${operation}`, payload || {}, {
            timeout: 15000,
            validateStatus: status => status >= 200 && status < 500
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Bridge operation failed with HTTP ${response.status}.`);
        }
        return response.data;
    }
}

module.exports = {
    ALLOWED_OPERATIONS,
    ExternalHttpBridgeClient,
    isAllowedBridgeHost,
    normalizeBaseUrl
};
