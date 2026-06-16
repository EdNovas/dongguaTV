const fs = require('fs');
const net = require('net');
const path = require('path');
const { DEFAULT_PLAYER_SETTINGS, validateMpcPath } = require('../player/externalPlayerConfig');
const { DEFAULT_PLUGIN_RUNTIME_SETTINGS } = require('../adapters/tvbox/pluginRuntime');

const DEFAULT_JSON_FILES = {
    'subscriptions.json': [],
    'sources.json': [],
    'live-channels.json': [],
    'tvbox-parses.json': [],
    'player-settings.json': DEFAULT_PLAYER_SETTINGS,
    'plugin-runtime-settings.json': DEFAULT_PLUGIN_RUNTIME_SETTINGS
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

function countBy(items, getKey) {
    return items.reduce((counts, item) => {
        const key = getKey(item) || 'unknown';
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {});
}

function buildSourceBreakdown(sources) {
    const enabledSources = sources.filter(source => source.enabled !== false);
    const playableHttpSources = enabledSources.filter(source => {
        if (source.status === 'plugin-required' || source.status === 'unsupported' || source.status === 'error') return false;
        if (source.sourceType === 'plugin-required' || source.supportLevel === 'unsupported') return false;
        return ['native', 'tvbox', 'maccms'].includes(source.sourceType);
    });

    return {
        total: sources.length,
        enabled: enabledSources.length,
        disabled: sources.length - enabledSources.length,
        playableHttp: playableHttpSources.length,
        byStatus: countBy(sources, source => source.status),
        bySourceType: countBy(sources, source => source.sourceType),
        bySupportLevel: countBy(sources, source => source.supportLevel)
    };
}

function buildLiveBreakdown(liveChannels) {
    const playableChannels = liveChannels.filter(channel => {
        const url = String(channel.url || '').trim();
        return !!url && channel.status !== 'error';
    });

    return {
        total: liveChannels.length,
        playable: playableChannels.length,
        error: liveChannels.length - playableChannels.length,
        byStatus: countBy(liveChannels, channel => channel.status),
        byGroup: countBy(liveChannels, channel => channel.group)
    };
}

async function getDesktopStatus(dataDir) {
    ensureDesktopState(dataDir);
    const subscriptions = readJson(path.join(dataDir, 'subscriptions.json'), []);
    const sources = readJson(path.join(dataDir, 'sources.json'), []);
    const liveChannels = readJson(path.join(dataDir, 'live-channels.json'), []);
    const sourceBreakdown = buildSourceBreakdown(sources);
    const liveBreakdown = buildLiveBreakdown(liveChannels);
    const contentReady = sourceBreakdown.playableHttp > 0 || liveBreakdown.playable > 0;
    const playerSettings = readJson(path.join(dataDir, 'player-settings.json'), DEFAULT_PLAYER_SETTINGS);
    const mpcValidation = validateMpcPath(playerSettings.mpcExePath);
    const localProxyPort = Number(playerSettings.localProxyPort || DEFAULT_PLAYER_SETTINGS.localProxyPort);
    const localProxyPortAvailable = await isPortAvailable(localProxyPort);
    const requiredFiles = Object.keys(DEFAULT_JSON_FILES).map(fileName => ({
        fileName,
        exists: fs.existsSync(path.join(dataDir, fileName))
    }));
    const allRequiredFilesExist = requiredFiles.every(file => file.exists);
    const setupChecklist = [
        {
            id: 'runtime-files',
            label: 'Runtime config files',
            ok: allRequiredFilesExist,
            severity: allRequiredFilesExist ? 'ok' : 'error',
            message: allRequiredFilesExist
                ? 'All runtime JSON files exist in userData.'
                : 'Some runtime JSON files are missing and should be recreated.'
        },
        {
            id: 'subscriptions',
            label: 'User subscriptions',
            ok: subscriptions.length > 0,
            severity: subscriptions.length > 0 ? 'ok' : 'warning',
            message: subscriptions.length > 0
                ? `${subscriptions.length} subscription(s) imported.`
                : 'No user TVBox subscription has been imported yet.'
        },
        {
            id: 'http-ready-sources',
            label: 'HTTP-ready sources',
            ok: contentReady,
            severity: contentReady ? 'ok' : 'warning',
            message: sourceBreakdown.playableHttp > 0
                ? `${sourceBreakdown.playableHttp} HTTP-compatible source(s) can use the built-in resolver path.`
                : liveBreakdown.playable > 0
                    ? `No HTTP-ready VOD source yet, but ${liveBreakdown.playable} live channel(s) are playable.`
                    : sources.length > 0
                        ? 'Imported sources are plugin-required or unsupported; subscription plugin code is not executed directly.'
                        : 'No TVBox HTTP-ready sources or live channels have been imported yet.'
        },
        {
            id: 'mpc',
            label: 'MPC external player',
            ok: mpcValidation.valid,
            severity: mpcValidation.valid ? 'ok' : 'warning',
            message: mpcValidation.valid
                ? `${mpcValidation.playerType} is configured.`
                : mpcValidation.message
        },
        {
            id: 'default-player',
            label: 'Default player',
            ok: ['mpc', 'internal', 'mpv', 'vlc'].includes(playerSettings.defaultPlayer),
            severity: ['mpc', 'internal', 'mpv', 'vlc'].includes(playerSettings.defaultPlayer) ? 'ok' : 'warning',
            message: `Default player is ${playerSettings.defaultPlayer || 'not configured'}.`
        },
        {
            id: 'local-proxy',
            label: 'LocalProxy',
            ok: !!playerSettings.useLocalProxy,
            severity: playerSettings.useLocalProxy ? 'ok' : 'warning',
            message: playerSettings.useLocalProxy
                ? 'LocalProxy is enabled for headers, Range, HLS, and MPC playback.'
                : 'LocalProxy is disabled; links with headers may fail in external players.'
        },
        {
            id: 'local-proxy-port',
            label: 'LocalProxy port',
            ok: localProxyPortAvailable,
            severity: localProxyPortAvailable ? 'ok' : 'warning',
            message: localProxyPortAvailable
                ? `Port ${localProxyPort} is available before LocalProxy starts.`
                : `Port ${localProxyPort} is currently unavailable; the app will try nearby fallback ports.`
        }
    ];
    const nextActions = [];
    if (subscriptions.length === 0) nextActions.push('Import your own TVBox JSON subscription.');
    if (subscriptions.length > 0 && !contentReady) {
        nextActions.push('Import a subscription with HTTP/MacCMS sources, or configure a trusted plugin runtime bridge for plugin-required sources.');
    }
    if (!mpcValidation.valid) nextActions.push('Configure a valid MPC-HC or MPC-BE executable path.');
    if (!playerSettings.useLocalProxy) nextActions.push('Enable LocalProxy for high-bitrate, header-protected, and cloud-drive links.');
    if (!localProxyPortAvailable) nextActions.push('Keep the fallback port behavior or change the LocalProxy port in Settings.');
    if (nextActions.length === 0) nextActions.push('Setup looks ready for local playback testing.');
    const setupComplete = setupChecklist.every(item => item.ok || item.severity !== 'error')
        && subscriptions.length > 0
        && contentReady
        && mpcValidation.valid
        && !!playerSettings.useLocalProxy;

    return {
        dataDir,
        requiredFiles,
        subscriptions: subscriptions.length,
        sources: sources.length,
        sourceBreakdown,
        contentReady,
        liveChannels: liveChannels.length,
        liveBreakdown,
        player: {
            defaultPlayer: playerSettings.defaultPlayer,
            mpcConfigured: !!playerSettings.mpcExePath,
            mpcValidation: {
                valid: mpcValidation.valid,
                reason: mpcValidation.reason,
                playerType: mpcValidation.playerType,
                message: mpcValidation.message
            },
            useLocalProxy: !!playerSettings.useLocalProxy,
            localProxyPort,
            localProxyPortAvailable
        },
        setupChecklist,
        nextActions,
        setupComplete,
        firstRunRecommended: !setupComplete
    };
}

module.exports = {
    ensureDesktopState,
    getDesktopStatus
};
