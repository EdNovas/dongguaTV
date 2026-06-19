const fs = require('fs');
const crypto = require('crypto');

function removeLineCommentsPreservingStrings(text) {
    const input = String(text || '').replace(/^\uFEFF/, '');
    let output = '';
    let inString = false;
    let quote = '';
    let escaped = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        const next = input[index + 1];

        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                inString = false;
                quote = '';
            }
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            output += char;
            continue;
        }

        if (char === '#') {
            while (index < input.length && input[index] !== '\n') index += 1;
            output += '\n';
            continue;
        }

        if (char === '/' && next === '/') {
            while (index < input.length && input[index] !== '\n') index += 1;
            output += '\n';
            continue;
        }

        output += char;
    }

    return output;
}

function stripJsonLikeComments(text) {
    return removeLineCommentsPreservingStrings(text)
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

function escapeRawControlsInStrings(text) {
    const input = String(text || '');
    let output = '';
    let inString = false;
    let quote = '';
    let escaped = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        const code = char.charCodeAt(0);

        if (inString) {
            if (escaped) {
                output += char;
                escaped = false;
                continue;
            }
            if (char === '\\') {
                output += char;
                escaped = true;
                continue;
            }
            if (char === quote) {
                output += '"';
                inString = false;
                quote = '';
                continue;
            }
            if (char === '\n') {
                output += '\\n';
                continue;
            }
            if (char === '\r') {
                output += '\\r';
                continue;
            }
            if (char === '\t') {
                output += '\\t';
                continue;
            }
            if (code < 32) {
                output += ' ';
                continue;
            }
            if (char === '"' && quote === "'") {
                output += '\\"';
                continue;
            }
            output += char;
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            output += '"';
            continue;
        }

        output += char;
    }

    return output;
}

function extractFirstJsonCandidate(text) {
    const input = String(text || '');
    const start = input.search(/[\[{]/);
    if (start < 0) return '';

    const opener = input[start];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;

    for (let index = start; index < input.length; index += 1) {
        const char = input[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                inString = false;
                quote = '';
            }
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            continue;
        }

        if (char === opener) depth += 1;
        if (char === closer) {
            depth -= 1;
            if (depth === 0) return input.slice(start, index + 1);
        }
    }

    return input.slice(start);
}

function quoteBareKeys(text) {
    return String(text || '').replace(/([{\[,]\s*)([A-Za-z_$\u4e00-\u9fff][A-Za-z0-9_$.\-\u4e00-\u9fff]*)(\s*:)/g, '$1"$2"$3');
}

function quoteBareValues(text) {
    return String(text || '').replace(/(:\s*)([^"',{\[\]\s][^,\}\]\r\n]*?)(\s*[,}\]])/g, (match, prefix, value, suffix) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) return match;
        if (/^(true|false|null)$/i.test(trimmed)) return `${prefix}${trimmed.toLowerCase()}${suffix}`;
        if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return `${prefix}${trimmed}${suffix}`;
        const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `${prefix}"${escaped}"${suffix}`;
    });
}

function relaxedJsonText(text) {
    return quoteBareValues(quoteBareKeys(escapeRawControlsInStrings(text)))
        .replace(/,\s*([}\]])/g, '$1');
}

function detectBinaryPayload(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg-image';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png-image';
    if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif-image';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp-image';
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip-like-binary';
    return null;
}

function createPayloadError(message, code, payloadKind) {
    const error = new Error(message);
    error.code = code;
    if (payloadKind) error.payloadKind = payloadKind;
    return error;
}

function toPayloadText(payload) {
    if (Buffer.isBuffer(payload)) {
        const binaryKind = detectBinaryPayload(payload);
        if (binaryKind) {
            throw createPayloadError(
                `Unsupported TVBox image config: ${binaryKind}. Image-steganography configs are recognized but not decoded in this version.`,
                'image-config-unsupported',
                binaryKind
            );
        }
        return payload.toString('utf8');
    }
    return String(payload || '');
}

function padFongMiSecret(value) {
    const text = String(value || '');
    if (!text || text.length > 16) {
        throw createPayloadError('Invalid FongMi encoded config key or IV.', 'encoded-config-invalid');
    }
    return text.padEnd(16, '0');
}

function decodeFongMiCbcPayload(text) {
    const compact = String(text || '').replace(/\s+/g, '');
    if (!compact.startsWith('2423') || !/^[0-9a-f]+$/i.test(compact) || compact.length % 2 !== 0) {
        return null;
    }

    const envelope = Buffer.from(compact, 'hex').toString('utf8').toLowerCase();
    const keyStart = envelope.indexOf('$#');
    const keyEnd = envelope.indexOf('#$', keyStart + 2);
    const encryptedStart = compact.indexOf('2324') + 4;
    const encryptedEnd = compact.length - 26;
    if (keyStart < 0 || keyEnd < 0 || encryptedStart < 4 || encryptedEnd <= encryptedStart) {
        throw createPayloadError('Invalid FongMi AES-CBC config envelope.', 'encoded-config-invalid');
    }

    const key = padFongMiSecret(envelope.slice(keyStart + 2, keyEnd));
    const iv = padFongMiSecret(envelope.slice(-13));
    try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(compact.slice(encryptedStart, encryptedEnd), 'hex')),
            decipher.final()
        ]);
        return decrypted.toString('utf8');
    } catch (error) {
        throw createPayloadError('Failed to decode FongMi AES-CBC TVBox config.', 'encoded-config-decode-failed');
    }
}

function decodeFongMiBase64Payload(text) {
    const input = String(text || '');
    const marker = input.match(/[A-Za-z0-9]{8}\*\*/);
    if (!marker) return null;
    const encoded = input.slice(input.indexOf(marker[0]) + 10).replace(/\s+/g, '');
    if (!encoded) {
        throw createPayloadError('Invalid FongMi Base64 config envelope.', 'encoded-config-invalid');
    }
    try {
        return Buffer.from(encoded, 'base64').toString('utf8');
    } catch (error) {
        throw createPayloadError('Failed to decode FongMi Base64 TVBox config.', 'encoded-config-decode-failed');
    }
}

function decodeTextPayload(text, diagnostics) {
    const input = String(text || '').trim();
    const base64Decoded = decodeFongMiBase64Payload(input);
    if (base64Decoded !== null) {
        diagnostics.decodeMode = 'fongmi-base64';
        diagnostics.decodedLength = base64Decoded.length;
        return base64Decoded;
    }

    const cbcDecoded = decodeFongMiCbcPayload(input);
    if (cbcDecoded !== null) {
        diagnostics.decodeMode = 'fongmi-aes-cbc';
        diagnostics.decodedLength = cbcDecoded.length;
        return cbcDecoded;
    }

    diagnostics.decodeMode = 'plain-text';
    return text;
}

function parseWarehouseEntriesFromText(text) {
    const entries = [];
    const seen = new Set();
    const lines = String(text || '').split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
        const urlMatch = trimmed.match(/https?:\/\/[^\s"'<>|]+/i);
        if (!urlMatch) continue;

        const url = urlMatch[0].replace(/[),，。]+$/g, '');
        if (seen.has(url)) continue;
        seen.add(url);

        const hashName = trimmed.split('#').slice(1).join('#').trim();
        const beforeUrl = trimmed.slice(0, urlMatch.index).replace(/^[\s|,，:：-]+|[\s|,，:：-]+$/g, '');
        const afterUrl = trimmed.slice(urlMatch.index + urlMatch[0].length).replace(/^[\s|,，:：-]+|[\s|,，:：-]+$/g, '');
        const name = hashName || beforeUrl || afterUrl || `warehouse-${entries.length + 1}`;

        entries.push({
            id: `warehouse-${entries.length + 1}`,
            name,
            url,
            raw: trimmed
        });
    }

    return entries;
}

function parseJsonCandidate(candidate, diagnostics) {
    const cleaned = stripJsonLikeComments(candidate).trim();
    const attempts = [
        { mode: 'strict', text: cleaned },
        { mode: 'extracted-json', text: extractFirstJsonCandidate(cleaned) },
        { mode: 'relaxed-json', text: relaxedJsonText(cleaned) },
        { mode: 'relaxed-extracted-json', text: relaxedJsonText(extractFirstJsonCandidate(cleaned)) }
    ];

    let lastError = null;
    const tried = new Set();
    for (const attempt of attempts) {
        if (!attempt.text || tried.has(attempt.text)) continue;
        tried.add(attempt.text);
        try {
            const parsed = JSON.parse(attempt.text);
            diagnostics.parseMode = attempt.mode;
            return parsed;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('TVBox JSON parse failed.');
}

function normalizeParsedConfig(parsed, diagnostics, originalText) {
    if (Array.isArray(parsed)) {
        const entries = parsed
            .filter(item => item && typeof item === 'object')
            .map((item, index) => ({
                id: item.id || item.key || `warehouse-${index + 1}`,
                name: item.name || item.title || item.key || `warehouse-${index + 1}`,
                url: item.url || item.api || item.ext || '',
                raw: item
            }))
            .filter(item => /^https?:\/\//i.test(String(item.url || '')));
        if (entries.length > 0) {
            return {
                name: 'TVBox Warehouse',
                urls: entries,
                _parserDiagnostics: { ...diagnostics, configKind: 'warehouse-array', warehouseCount: entries.length }
            };
        }
    }

    if (parsed && typeof parsed === 'object') {
        return {
            ...parsed,
            _parserDiagnostics: {
                ...diagnostics,
                configKind: Array.isArray(parsed.urls) || Array.isArray(parsed.storeHouse) || Array.isArray(parsed.storehouse)
                    ? 'warehouse-object'
                    : 'tvbox-config'
            }
        };
    }

    const warehouseEntries = parseWarehouseEntriesFromText(originalText);
    if (warehouseEntries.length > 0) {
        return {
            name: 'TVBox Warehouse',
            urls: warehouseEntries,
            _parserDiagnostics: { ...diagnostics, configKind: 'warehouse-text', warehouseCount: warehouseEntries.length }
        };
    }

    const error = new Error('Unsupported TVBox config shape.');
    error.code = 'unsupported-config-shape';
    throw error;
}

function parseTvboxJson(payload) {
    const payloadText = toPayloadText(payload);
    const diagnostics = {
        payloadLength: payloadText.length,
        payloadKind: Buffer.isBuffer(payload) ? 'buffer' : 'text',
        parseMode: 'unknown',
        configKind: 'unknown',
        decodeMode: 'unknown'
    };
    const text = decodeTextPayload(payloadText, diagnostics);
    const trimmed = text.trim();

    if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) {
        const error = new Error('Unsupported TVBox payload: HTML page returned instead of JSON.');
        error.code = 'html-payload';
        throw error;
    }

    const warehouseEntries = parseWarehouseEntriesFromText(text);
    if (!/[\[{]/.test(trimmed) && warehouseEntries.length > 0) {
        return normalizeParsedConfig([], { ...diagnostics, parseMode: 'warehouse-text' }, text);
    }

    try {
        const parsed = parseJsonCandidate(text, diagnostics);
        return normalizeParsedConfig(parsed, diagnostics, text);
    } catch (error) {
        if (warehouseEntries.length > 0) {
            return {
                name: 'TVBox Warehouse',
                urls: warehouseEntries,
                _parserDiagnostics: { ...diagnostics, parseMode: 'warehouse-text-fallback', configKind: 'warehouse-text', warehouseCount: warehouseEntries.length }
            };
        }
        throw error;
    }
}

function normalizeWarehouseEntry(item, index) {
    if (!item || typeof item !== 'object') return null;
    const url = item.url || item.api || item.ext || item.value || '';
    if (!/^https?:\/\//i.test(String(url || ''))) return null;
    return {
        id: String(item.id || item.key || `warehouse-${index + 1}`),
        name: String(item.name || item.title || item.key || `warehouse-${index + 1}`),
        url: String(url),
        raw: item
    };
}

function pickWarehouseFields(safe) {
    const candidates = []
        .concat(Array.isArray(safe.urls) ? safe.urls : [])
        .concat(Array.isArray(safe.storeHouse) ? safe.storeHouse : [])
        .concat(Array.isArray(safe.storehouse) ? safe.storehouse : [])
        .concat(Array.isArray(safe.warehouses) ? safe.warehouses : []);

    const seen = new Set();
    return candidates
        .map((item, index) => normalizeWarehouseEntry(item, index))
        .filter(Boolean)
        .filter(item => {
            if (seen.has(item.url)) return false;
            seen.add(item.url);
            return true;
        });
}

async function loadTvboxConfig(input, httpClient) {
    if (input.config && typeof input.config === 'object') {
        return {
            ...input.config,
            _parserDiagnostics: {
                configKind: 'inline-config',
                parseMode: 'inline-object',
                payloadLength: 0,
                payloadKind: 'inline-object',
                decodeMode: 'none'
            }
        };
    }

    if (input.filePath) {
        return parseTvboxJson(fs.readFileSync(input.filePath));
    }

    if (!input.url) {
        throw new Error('A TVBox subscription URL, local file path, or JSON config is required.');
    }

    const response = await httpClient.get(input.url, {
        timeout: 15000,
        responseType: 'arraybuffer',
        transformResponse: data => data,
        headers: {
            'User-Agent': 'DongguaTV/1.0'
        }
    });
    return parseTvboxJson(Buffer.from(response.data));
}

function pickTvboxFields(config) {
    const safe = config && typeof config === 'object' ? config : {};
    return {
        sites: Array.isArray(safe.sites) ? safe.sites : [],
        parses: Array.isArray(safe.parses) ? safe.parses : [],
        lives: Array.isArray(safe.lives) ? safe.lives : [],
        warehouses: pickWarehouseFields(safe),
        spider: safe.spider || null,
        jar: safe.jar || null,
        flags: safe.flags || [],
        rules: safe.rules || [],
        doh: safe.doh || null,
        wallpaper: safe.wallpaper || null,
        ads: safe.ads || [],
        warningText: safe.warningText || '',
        ijk: safe.ijk || [],
        player: safe.player || {},
        ext: safe.ext || null,
        parserDiagnostics: safe._parserDiagnostics || null
    };
}

module.exports = {
    loadTvboxConfig,
    parseTvboxJson,
    pickTvboxFields,
    parseWarehouseEntriesFromText
};
