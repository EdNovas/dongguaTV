const fs = require('fs');
const net = require('net');
const path = require('path');
const { DEFAULT_PLAYER_SETTINGS } = require('../player/externalPlayerConfig');

const DEFAULT_JSON_FILES = {
    'subscriptions.json': [],
    'sources.json': [],
    'live-channels.json': [],
    'tvbox-parses.json': [],
    'player-settings.json': DEFAULT_PLAYER_SETTINGS
};

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        return fallback;
    }
}

function writeJsonIfMissing(filePath, value) {
    if (fs.existsSync(filePath)) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
    return true;
}

function ensureDesktopState(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const created = [];
    for (const [fileName, value] of Object.entries(DEFAULT_JSON_FILES)) {
        if (writeJsonIfMissing(path.join(dataDir, fileName), value)) {
            created.push(fileName);
        }
    }
    return { dataDir, created };
}

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => {
                server.close(() => resolve(true));
            })
            .listen(Number(port), '127.0.0.1');
    });
}

async function getDesktopStatus(dataDir) {
    ensureDesktopState(dataDir);
    const subscriptions = readJson(path.join(dataDir, 'subscriptions.json'), []);
    const sources = readJson(path.join(dataDir, 'sources.json'), []);
    const liveChannels = readJson(path.join(dataDir, 'live-channels.json'), []);
    const playerSettings = readJson(path.join(dataDir, 'player-settings.json'), DEFAULT_PLAYER_SETTINGS);
    const localProxyPort = Number(playerSettings.localProxyPort || DEFAULT_PLAYER_SETTINGS.localProxyPort);
    const localProxyPortAvailable = await isPortAvailable(localProxyPort);
    const requiredFiles = Object.keys(DEFAULT_JSON_FILES).map(fileName => ({
        fileName,
        exists: fs.existsSync(path.join(dataDir, fileName))
    }));

    return {
        dataDir,
        requiredFiles,
        subscriptions: subscriptions.length,
        sources: sources.length,
        liveChannels: liveChannels.length,
        player: {
            defaultPlayer: playerSettings.defaultPlayer,
            mpcConfigured: !!playerSettings.mpcExePath,
            useLocalProxy: !!playerSettings.useLocalProxy,
            localProxyPort,
            localProxyPortAvailable
        },
        firstRunRecommended: subscriptions.length === 0 || !playerSettings.mpcExePath
    };
}

module.exports = {
    ensureDesktopState,
    getDesktopStatus
};
