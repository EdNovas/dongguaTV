const fs = require('fs');
const path = require('path');

const DEFAULT_PLAYER_SETTINGS = {
    defaultPlayer: 'mpc',
    mpcExePath: '',
    mpcArgsTemplate: '/play /fullscreen /close "{url}"',
    mpvExePath: '',
    vlcExePath: '',
    useMpcFor4K: true,
    useMpcForHEVC: true,
    useMpcForHDR: true,
    useMpcForCloudDrive: true,
    useLocalProxy: true,
    localProxyPort: 9979,
    closeMpcAfterPlayback: true,
    fullscreenOnStart: true
};

function settingsPath(dataDir) {
    return path.join(dataDir, 'player-settings.json');
}

function readPlayerSettings(dataDir) {
    const filePath = settingsPath(dataDir);
    try {
        if (!fs.existsSync(filePath)) return { ...DEFAULT_PLAYER_SETTINGS };
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { ...DEFAULT_PLAYER_SETTINGS, ...saved };
    } catch (error) {
        return { ...DEFAULT_PLAYER_SETTINGS };
    }
}

function savePlayerSettings(dataDir, patch) {
    const next = { ...readPlayerSettings(dataDir), ...patch };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsPath(dataDir), JSON.stringify(next, null, 2), 'utf8');
    return next;
}

function detectMpcPaths() {
    const candidates = [
        'C:\\Program Files\\MPC-HC\\mpc-hc64.exe',
        'C:\\Program Files (x86)\\MPC-HC\\mpc-hc.exe',
        'C:\\Program Files\\MPC-BE x64\\mpc-be64.exe',
        'C:\\Program Files\\MPC-BE\\mpc-be.exe'
    ];
    return candidates.filter(candidate => fs.existsSync(candidate));
}

module.exports = {
    DEFAULT_PLAYER_SETTINGS,
    readPlayerSettings,
    savePlayerSettings,
    detectMpcPaths
};
