const fs = require('fs');
const { spawn } = require('child_process');

function buildMpcArgs(url, settings) {
    const args = [];
    if (settings.fullscreenOnStart) args.push('/fullscreen');
    args.push('/play');
    if (settings.closeMpcAfterPlayback) args.push('/close');
    args.push(url);
    return args;
}

function playWithMpc(url, settings) {
    if (!url) {
        throw new Error('Playback URL is required.');
    }
    const exePath = settings && settings.mpcExePath;
    if (!exePath) {
        throw new Error('MPC executable path is not configured.');
    }
    if (!fs.existsSync(exePath)) {
        throw new Error('Configured MPC executable was not found.');
    }

    const child = spawn(exePath, buildMpcArgs(url, settings), {
        detached: true,
        stdio: 'ignore',
        shell: false
    });

    child.unref();
    return { ok: true };
}

module.exports = {
    buildMpcArgs,
    playWithMpc
};
