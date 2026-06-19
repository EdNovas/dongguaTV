const { spawn } = require('child_process');
const { validateMpvPath } = require('./externalPlayerConfig');

function buildMpvArgs(url, settings) {
    const args = [];
    if (settings && settings.fullscreenOnStart) args.push('--fs');
    args.push(url);
    return args;
}

function playWithMpv(url, settings) {
    if (!url) {
        throw new Error('Playback URL is required.');
    }
    const exePath = settings && settings.mpvExePath;
    const validation = validateMpvPath(exePath);
    if (!validation.valid) {
        const error = new Error(validation.message || 'Configured mpv/mpv.net executable is not valid.');
        error.code = validation.reason || 'invalid-mpv-path';
        throw error;
    }

    const child = spawn(exePath, buildMpvArgs(url, settings), {
        detached: true,
        stdio: 'ignore',
        shell: false
    });

    child.unref();
    return {
        ok: true,
        pid: child.pid,
        playerType: validation.playerType
    };
}

module.exports = {
    buildMpvArgs,
    playWithMpv
};
