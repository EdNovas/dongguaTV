const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        return fallback;
    }
}

function writeJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
}

class SubscriptionStore {
    constructor(dataDir) {
        this.dataDir = dataDir;
        ensureDir(this.dataDir);
        this.paths = {
            subscriptions: path.join(dataDir, 'subscriptions.json'),
            sources: path.join(dataDir, 'sources.json'),
            liveChannels: path.join(dataDir, 'live-channels.json'),
            parses: path.join(dataDir, 'tvbox-parses.json')
        };
    }

    getSubscriptions() {
        return readJson(this.paths.subscriptions, []);
    }

    saveSubscriptions(subscriptions) {
        writeJson(this.paths.subscriptions, subscriptions);
    }

    getSources() {
        return readJson(this.paths.sources, []);
    }

    saveSources(sources) {
        writeJson(this.paths.sources, sources);
    }

    getLiveChannels() {
        return readJson(this.paths.liveChannels, []);
    }

    saveLiveChannels(channels) {
        writeJson(this.paths.liveChannels, channels);
    }

    getParses() {
        return readJson(this.paths.parses, []);
    }

    saveParses(parses) {
        writeJson(this.paths.parses, parses);
    }

    upsertImportResult(result) {
        const subscriptions = this.getSubscriptions().filter(item => item.id !== result.subscription.id);
        subscriptions.push(result.subscription);
        this.saveSubscriptions(subscriptions);

        const sources = this.getSources().filter(item => item.sourceSubscriptionId !== result.subscription.id);
        this.saveSources([...sources, ...result.sources]);

        const liveChannels = this.getLiveChannels().filter(item => item.sourceSubscriptionId !== result.subscription.id);
        this.saveLiveChannels([...liveChannels, ...result.liveChannels]);

        const parses = this.getParses().filter(item => item.sourceSubscriptionId !== result.subscription.id);
        this.saveParses([...parses, ...result.parses]);
    }

    removeSubscription(subscriptionId) {
        this.saveSubscriptions(this.getSubscriptions().filter(item => item.id !== subscriptionId));
        this.saveSources(this.getSources().filter(item => item.sourceSubscriptionId !== subscriptionId));
        this.saveLiveChannels(this.getLiveChannels().filter(item => item.sourceSubscriptionId !== subscriptionId));
        this.saveParses(this.getParses().filter(item => item.sourceSubscriptionId !== subscriptionId));
    }
}

module.exports = {
    SubscriptionStore,
    readJson,
    writeJson
};
