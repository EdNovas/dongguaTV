const { readPlayerSettings, savePlayerSettings, detectMpcPaths } = require('./externalPlayerConfig');
const { classifyPlayUrl } = require('./playUrlClassifier');
const { playWithMpc } = require('./mpcPlayer');

class PlayerManager {
    constructor(dataDir) {
        this.dataDir = dataDir;
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

    openMpc(playUrlResult) {
        const input = typeof playUrlResult === 'string' ? { url: playUrlResult } : (playUrlResult || {});
        const settings = this.getSettings();
        const classification = classifyPlayUrl(input, settings);
        playWithMpc(input.url, settings);
        return {
            ok: true,
            recommendedPlayer: classification.recommendedPlayer,
            reason: classification.reason
        };
    }
}

module.exports = {
    PlayerManager
};
