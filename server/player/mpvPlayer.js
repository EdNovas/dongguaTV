const fs = require('fs');
const { spawn } = require('child_process');

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
    if (!exePath) {
        throw new Error('mpv/mpv.net executable path is not configured.');
    }
    if (!fs.existsSync(exePath)) {
        throw new Error('Configured mpv/mpv.net executable was not found.');
    }

    const child = spawn(exePath, buildMpvArgs(url, settings), {
        detached: true,
        stdio: 'ignore',
        shell: false
    });

    child.unref();
    return { ok: true };
}

module.exports = {
    buildMpvArgs,
    playWithMpv
};
