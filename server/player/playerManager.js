const { readPlayerSettings, savePlayerSettings, detectMpcPaths } = require('./externalPlayerConfig');
const { classifyPlayUrl } = require('./playUrlClassifier');
const { playWithMpc } = require('./mpcPlayer');
const { LocalProxy } = require('./localProxy');

class PlayerManager {
    constructor(dataDir, httpClient) {
        this.dataDir = dataDir;
        this.localProxy = new LocalProxy(httpClient);
    }

    getSettings() {
        return readPlayerSettings(this.dataDir);
    }

    saveSettings(patch) {
        return savePlayerSettings(this.dataDir, patch || {});
    }

    detectMpc() {
        const matches = detectMpcPaths();
        return {
            found: matches.length > 0,
            matches,
            recommended: matches[0] || ''
        };
    }

    classify(playUrlResult) {
        return classifyPlayUrl(playUrlResult, this.getSettings());
    }

    async createProxyUrl(playUrlResult) {
        const settings = this.getSettings();
        return this.localProxy.register(playUrlResult, settings);
    }

    async openMpc(playUrlResult) {
        const input = typeof playUrlResult === 'string' ? { url: playUrlResult } : (playUrlResult || {});
        const settings = this.getSettings();
        const classification = classifyPlayUrl(input, settings);
        const proxy = settings.useLocalProxy ? await this.localProxy.register(input, settings) : null;
        playWithMpc(proxy ? proxy.proxyUrl : input.url, settings);
        return {
            ok: true,
            proxyUrl: proxy ? proxy.proxyUrl : null,
            recommendedPlayer: classification.recommendedPlayer,
            reason: classification.reason
        };
    }
}

module.exports = {
    PlayerManager
};
