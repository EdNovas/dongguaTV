function inferFormat(url) {
    const clean = String(url || '').split('?')[0].toLowerCase();
    if (clean.endsWith('.m3u8')) return 'm3u8';
    if (clean.endsWith('.mp4')) return 'mp4';
    if (clean.endsWith('.mkv')) return 'mkv';
    if (clean.endsWith('.ts')) return 'ts';
    if (clean.endsWith('.flv')) return 'flv';
    return 'unknown';
}

function decodeUrlForHints(url) {
    const raw = String(url || '').toLowerCase();
    try {
        return decodeURIComponent(raw);
    } catch (error) {
        return raw;
    }
}

function hasToken(text, patterns) {
    return patterns.some(pattern => pattern.test(text));
}

function inferQuality(url, providedQuality) {
    const quality = String(providedQuality || '').toLowerCase();
    if (quality && quality !== 'unknown') return quality;

    const text = decodeUrlForHints(url);
    if (hasToken(text, [
        /(?:^|[^\da-z])(?:4k|uhd|2160p?|3840x2160)(?:[^\da-z]|$)/i,
        /(?:^|[^\da-z])(?:2160)(?:[^\da-z]|$)/i
    ])) return '4k';
    if (/(?:^|[^\da-z])1440p?(?:[^\da-z]|$)/i.test(text)) return '1440p';
    if (/(?:^|[^\da-z])1080p?(?:[^\da-z]|$)/i.test(text)) return '1080p';
    if (/(?:^|[^\da-z])720p?(?:[^\da-z]|$)/i.test(text)) return '720p';

    return 'unknown';
}

function inferCodec(url, providedCodec) {
    const codec = String(providedCodec || '').toLowerCase();
    if (codec && codec !== 'unknown') return codec;

    const text = decodeUrlForHints(url);
    if (hasToken(text, [
        /(?:^|[^\da-z])(?:hevc|h\.?265|x265|hvc1|hvc)(?:[^\da-z]|$)/i
    ])) return 'hevc';
    if (/(?:^|[^\da-z])(?:av1|av01)(?:[^\da-z]|$)/i.test(text)) return 'av1';
    if (/(?:^|[^\da-z])(?:h\.?264|x264|avc1|avc)(?:[^\da-z]|$)/i.test(text)) return 'h264';

    return 'unknown';
}

function inferHdr(url, providedHdr) {
    if (providedHdr === true) return true;
    const text = decodeUrlForHints(url);
    return hasToken(text, [
        /(?:^|[^\da-z])(?:hdr|hdr10|hdr10plus|hdr10\+|hlg)(?:[^\da-z]|$)/i,
        /(?:^|[^\da-z])(?:dolby[\s._-]?vision|dovi)(?:[^\da-z]|$)/i,
        /(?:^|[^\da-z])dv(?:[._-]|$)/i
    ]);
}

function inferSourceKind(url, providedSourceKind) {
    const sourceKind = String(providedSourceKind || '').toLowerCase();
    if (sourceKind && !['unknown', 'normal'].includes(sourceKind)) return sourceKind;

    const text = decodeUrlForHints(url);
    if (hasToken(text, [
        /(?:^|[^\da-z])alist(?:[^\da-z]|$)/i,
        /(?:^|[^\da-z])(?:aliyundrive|ali[\s._-]?pan|quark|ucdrive|webdav|pikpak|123pan|115)(?:[^\da-z]|$)/i,
        /(?:^|[^\da-z])(?:cloud\.189|drive\.uc|pan\.quark|pan\.baidu)(?:[^\da-z]|$)/i,
        /(?:^|[^\da-z])pan\./i
    ])) return 'cloud-drive';

    return 'normal';
}

function hasCustomHeaders(headers) {
    return Object.keys(headers || {}).some(key => Boolean(headers[key]));
}

function classifyPlayUrl(playUrlResult, settings) {
    const input = playUrlResult || {};
    const playerSettings = settings || {};
    const url = String(input.url || '');
    const quality = inferQuality(url, input.quality);
    const codec = inferCodec(url, input.codec);
    const sourceKind = inferSourceKind(url, input.sourceKind);
    const format = input.format || inferFormat(url);
    const hdr = inferHdr(url, input.hdr);
    const customHeaders = hasCustomHeaders(input.headers);

    if ((quality.includes('4k') || quality.includes('2160')) && playerSettings.useMpcFor4K) {
        return { recommendedPlayer: 'mpc', reason: '4K source is better handled by MPC on Windows.' };
    }

    if ((codec.includes('hevc') || codec.includes('h265') || codec.includes('h.265') || codec.includes('hvc1')) && playerSettings.useMpcForHEVC) {
        return { recommendedPlayer: 'mpc', reason: 'HEVC/H.265 source is better handled by MPC on Windows.' };
    }

    if (hdr && playerSettings.useMpcForHDR) {
        return { recommendedPlayer: 'mpc', reason: 'HDR source is better handled by MPC on Windows.' };
    }

    if (sourceKind === 'cloud-drive' && playerSettings.useMpcForCloudDrive) {
        return { recommendedPlayer: 'mpc', reason: 'Cloud-drive style URL is better handled by MPC.' };
    }

    if (format === 'mkv') {
        return { recommendedPlayer: 'mpc', reason: 'MKV container is better handled by MPC.' };
    }

    if (sourceKind === 'live' && customHeaders) {
        return { recommendedPlayer: 'mpc', reason: 'Live URL with custom headers is safer through LocalProxy and MPC.' };
    }

    if (format === 'm3u8' && sourceKind === 'live') {
        return { recommendedPlayer: playerSettings.defaultPlayer === 'mpc' ? 'mpc' : 'internal', reason: 'Live HLS can use the internal player unless the user prefers MPC.' };
    }

    return {
        recommendedPlayer: playerSettings.defaultPlayer || 'internal',
        reason: 'Using the configured default player.'
    };
}

module.exports = {
    classifyPlayUrl,
    inferFormat,
    inferQuality,
    inferCodec,
    inferHdr,
    inferSourceKind
};
