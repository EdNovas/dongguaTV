function inferFormat(url) {
    const clean = String(url || '').split('?')[0].toLowerCase();
    if (clean.endsWith('.m3u8')) return 'm3u8';
    if (clean.endsWith('.mp4')) return 'mp4';
    if (clean.endsWith('.mkv')) return 'mkv';
    if (clean.endsWith('.ts')) return 'ts';
    if (clean.endsWith('.flv')) return 'flv';
    return 'unknown';
}

function classifyPlayUrl(playUrlResult, settings) {
    const input = playUrlResult || {};
    const url = String(input.url || '');
    const quality = String(input.quality || '').toLowerCase();
    const codec = String(input.codec || '').toLowerCase();
    const sourceKind = String(input.sourceKind || '').toLowerCase();
    const format = input.format || inferFormat(url);
    const lowerUrl = url.toLowerCase();

    if ((quality.includes('4k') || quality.includes('2160')) && settings.useMpcFor4K) {
        return { recommendedPlayer: 'mpc', reason: '4K source is better handled by MPC on Windows.' };
    }

    if ((codec.includes('hevc') || codec.includes('h265') || codec.includes('h.265')) && settings.useMpcForHEVC) {
        return { recommendedPlayer: 'mpc', reason: 'HEVC/H.265 source is better handled by MPC on Windows.' };
    }

    if (input.hdr && settings.useMpcForHDR) {
        return { recommendedPlayer: 'mpc', reason: 'HDR source is better handled by MPC on Windows.' };
    }

    if ((sourceKind === 'cloud-drive' || /alist|115|aliyundrive|quark|ucdrive|webdav|pan\./i.test(lowerUrl)) && settings.useMpcForCloudDrive) {
        return { recommendedPlayer: 'mpc', reason: 'Cloud-drive style URL is better handled by MPC.' };
    }

    if (format === 'mkv') {
        return { recommendedPlayer: 'mpc', reason: 'MKV container is better handled by MPC.' };
    }

    if (format === 'm3u8' && sourceKind === 'live') {
        return { recommendedPlayer: settings.defaultPlayer === 'mpc' ? 'mpc' : 'internal', reason: 'Live HLS can use the internal player unless the user prefers MPC.' };
    }

    return {
        recommendedPlayer: settings.defaultPlayer || 'internal',
        reason: 'Using the configured default player.'
    };
}

module.exports = {
    classifyPlayUrl,
    inferFormat
};
