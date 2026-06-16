const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

function parseWindowsCommandExecutable(command) {
    const text = String(command || '').trim();
    if (!text) return '';
    const quoted = text.match(/^"([^"]+\.exe)"/i);
    if (quoted) return quoted[1];
    const unquoted = text.match(/^(.+?\.exe)(?:\s|$)/i);
    return unquoted ? unquoted[1] : '';
}

function readRegistryDefaultValue(keyPath) {
    try {
        const output = execFileSync('reg', ['query', keyPath, '/ve'], {
            encoding: 'buffer',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 3000
        });
        const text = output.toString('utf8');
        const quotedExe = text.match(/"([^"]+\.exe)"/i);
        if (quotedExe) return `"${quotedExe[1]}"`;
        const bareExe = text.match(/([A-Z]:\\[^\r\n"]+?\.exe)(?:\s|$)/i);
        return bareExe ? bareExe[1] : '';
    } catch (error) {
        return '';
    }
}

function uniqueExistingPaths(paths) {
    return Array.from(new Set(paths.map(item => String(item || '').trim()).filter(Boolean)))
        .filter(candidate => fs.existsSync(candidate));
}

function detectMpvPaths() {
    const registryCommands = [
        'HKCU\\Software\\Classes\\Applications\\mpvnet.exe\\shell\\open\\command',
        'HKCU\\Software\\Classes\\Applications\\mpv.net.exe\\shell\\open\\command',
        'HKCU\\Software\\Classes\\Applications\\mpv.exe\\shell\\open\\command',
        'HKLM\\Software\\Classes\\Applications\\mpvnet.exe\\shell\\open\\command',
        'HKLM\\Software\\Classes\\Applications\\mpv.net.exe\\shell\\open\\command',
        'HKLM\\Software\\Classes\\Applications\\mpv.exe\\shell\\open\\command'
    ].map(key => parseWindowsCommandExecutable(readRegistryDefaultValue(key)));
    const candidates = [
        ...registryCommands,
        'C:\\Program Files\\mpv.net\\mpvnet.exe',
        'C:\\Program Files\\mpv.net\\mpv.net.exe',
        'C:\\Program Files\\mpv\\mpv.exe',
        'C:\\Program Files (x86)\\mpv.net\\mpvnet.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\mpv.net\\mpvnet.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\mpv.net\\mpv.net.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'mpv.net\\mpvnet.exe'),
        path.join(process.env.APPDATA || '', 'mpv.net\\mpvnet.exe')
    ];
    return uniqueExistingPaths(candidates);
}

function validateMpcPath(exePath) {
    const value = String(exePath || '').trim();
    if (!value) {
        return {
            valid: false,
            exists: false,
            path: '',
            playerType: 'unknown',
            reason: 'missing-path',
            message: 'MPC executable path is not configured.'
        };
    }

    const baseName = path.basename(value).toLowerCase();
    const playerType = baseName.includes('mpc-hc')
        ? 'mpc-hc'
        : baseName.includes('mpc-be')
            ? 'mpc-be'
            : 'unknown';

    try {
        const stat = fs.statSync(value);
        const isFile = stat.isFile();
        const isExe = baseName.endsWith('.exe');
        const valid = isFile && isExe && playerType !== 'unknown';
        return {
            valid,
            exists: true,
            isFile,
            isExe,
            path: value,
            playerType,
            reason: valid ? 'valid' : playerType === 'unknown' ? 'not-mpc-executable' : !isExe ? 'not-exe' : 'not-file',
            message: valid
                ? `${playerType.toUpperCase()} executable is available.`
                : 'The path exists, but it does not look like an MPC-HC or MPC-BE executable.'
        };
    } catch (error) {
        return {
            valid: false,
            exists: false,
            isFile: false,
            isExe: baseName.endsWith('.exe'),
            path: value,
            playerType,
            reason: 'path-not-found',
            message: 'MPC executable path was not found.'
        };
    }
}

function validateMpvPath(exePath) {
    const value = String(exePath || '').trim();
    if (!value) {
        return {
            valid: false,
            exists: false,
            path: '',
            playerType: 'unknown',
            reason: 'missing-path',
            message: 'mpv/mpv.net executable path is not configured.'
        };
    }

    const baseName = path.basename(value).toLowerCase();
    const playerType = baseName.includes('mpvnet') || baseName.includes('mpv.net')
        ? 'mpv.net'
        : baseName === 'mpv.exe'
            ? 'mpv'
            : 'unknown';

    try {
        const stat = fs.statSync(value);
        const isFile = stat.isFile();
        const isExe = baseName.endsWith('.exe');
        const valid = isFile && isExe && playerType !== 'unknown';
        return {
            valid,
            exists: true,
            isFile,
            isExe,
            path: value,
            playerType,
            reason: valid ? 'valid' : playerType === 'unknown' ? 'not-mpv-executable' : !isExe ? 'not-exe' : 'not-file',
            message: valid
                ? `${playerType} executable is available.`
                : 'The path exists, but it does not look like an mpv or mpv.net executable.'
        };
    } catch (error) {
        return {
            valid: false,
            exists: false,
            isFile: false,
            isExe: baseName.endsWith('.exe'),
            path: value,
            playerType,
            reason: 'path-not-found',
            message: 'mpv/mpv.net executable path was not found.'
        };
    }
}

module.exports = {
    DEFAULT_PLAYER_SETTINGS,
    readPlayerSettings,
    savePlayerSettings,
    detectMpcPaths,
    detectMpvPaths,
    validateMpcPath,
    validateMpvPath
};
