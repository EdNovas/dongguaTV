const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const axios = require('axios');

function parseArgs(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            result[key] = true;
            continue;
        }
        result[key] = next;
        i += 1;
    }
    return result;
}

function readConfig() {
    const args = parseArgs(process.argv.slice(2));
    const configPath = args.config || process.env.TEST_TVBOX_QA_CONFIG;
    const inlineJson = process.env.TEST_TVBOX_QA_JSON;

    if (inlineJson) return { config: JSON.parse(inlineJson), source: 'env:TEST_TVBOX_QA_JSON' };
    if (configPath) {
        const resolved = path.resolve(configPath);
        return {
            config: JSON.parse(fs.readFileSync(resolved, 'utf8')),
            source: resolved
        };
    }

    throw new Error(
        'Missing QA config. Provide --config <file> or set TEST_TVBOX_QA_CONFIG / TEST_TVBOX_QA_JSON.'
    );
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await axios.get(`${baseUrl}/api/player/settings`, { timeout: 3000 });
            return;
        } catch (_) {
            await delay(500);
        }
    }
    throw new Error(`Timed out waiting for server at ${baseUrl}`);
}

function toCountMap(items, field) {
    return (items || []).reduce((accumulator, item) => {
        const key = String(item && item[field] || 'unknown');
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
    }, {});
}

function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
}

function findSource(sources, matcher) {
    const exact = normalizeText(matcher);
    return (sources || []).find(source => {
        return [source.id, source.name, source.key]
            .map(normalizeText)
            .includes(exact);
    }) || (sources || []).find(source => {
        return [source.id, source.name, source.key]
            .map(normalizeText)
            .some(value => value.includes(exact));
    }) || null;
}

function extractProbeCandidates(vodPlayUrl) {
    const text = String(vodPlayUrl || '');
    if (!text) return [];
    return text
        .split('$$$')
        .slice(0, 3)
        .flatMap(group => group.split('#').slice(0, 2))
        .map(entry => {
            const match = entry.match(/\$(https?:\/\/.+)$/i);
            return match ? match[1] : '';
        })
        .filter(Boolean);
}

async function probeUrl(url) {
    try {
        const response = await axios.get(url, {
            timeout: 12000,
            maxRedirects: 5,
            responseType: 'stream',
            validateStatus: () => true,
            headers: { 'User-Agent': 'DongguaTV-Real-QA/1.0' }
        });
        response.data.destroy();
        return {
            status: response.status,
            finalUrl: response.request && response.request.res && response.request.res.responseUrl
                ? response.request.res.responseUrl
                : url
        };
    } catch (error) {
        return {
            status: 0,
            error: error.message
        };
    }
}

async function fetchJson(baseUrl, method, route, body) {
    const response = await axios({
        method,
        url: `${baseUrl}${route}`,
        timeout: 30000,
        data: body,
        validateStatus: () => true
    });
    if (response.status >= 400) {
        throw new Error(`${method.toUpperCase()} ${route} failed: ${response.status} ${JSON.stringify(response.data)}`);
    }
    return response.data;
}

function listMpvPids() {
    try {
        const output = execFileSync('powershell', [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^mpv(net)?\\.exe$' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress"
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 8000
        }).trim();
        if (!output) return [];
        const parsed = JSON.parse(output);
        return Array.isArray(parsed) ? parsed.map(Number) : [Number(parsed)];
    } catch (_) {
        return [];
    }
}

function killMpvPids(pids) {
    if (!pids || pids.length === 0) return;
    try {
        execFileSync('powershell', [
            '-NoProfile',
            '-Command',
            `$ids=@(${pids.join(',')}); Get-Process -Id $ids -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`
        ], {
            stdio: ['ignore', 'ignore', 'ignore'],
            windowsHide: true,
            timeout: 8000
        });
    } catch (_) {
        // Best-effort cleanup only.
    }
}

function summarizeSearchResult(searchResult) {
    return {
        count: Array.isArray(searchResult && searchResult.list) ? searchResult.list.length : 0,
        firstName: searchResult && searchResult.list && searchResult.list[0] ? searchResult.list[0].vod_name : '',
        firstId: searchResult && searchResult.list && searchResult.list[0] ? searchResult.list[0].vod_id : ''
    };
}

async function runHttpSample(baseUrl, source, sample) {
    const siteKey = `tvbox:${source.id}`;
    const health = await fetchJson(baseUrl, 'post', '/api/source-health-check', { sourceId: source.id }).catch(error => ({
        status: 'error',
        error: error.message
    }));
    const search = await fetchJson(
        baseUrl,
        'get',
        `/api/search?wd=${encodeURIComponent(sample.keyword)}&site_key=${encodeURIComponent(siteKey)}`
    );
    const summary = summarizeSearchResult(search);
    const result = {
        sourceId: source.id,
        sourceName: source.name,
        keyword: sample.keyword,
        healthStatus: health.status || 'error',
        search: summary
    };

    if (!summary.firstId || sample.probeDetail === false) {
        return result;
    }

    const detail = await fetchJson(
        baseUrl,
        'get',
        `/api/detail?id=${encodeURIComponent(summary.firstId)}&site_key=${encodeURIComponent(siteKey)}&nocache=1`
    );
    const item = detail && detail.list && detail.list[0] ? detail.list[0] : null;
    const candidates = extractProbeCandidates(item && item.vod_play_url);
    result.detail = {
        vodName: item && item.vod_name || summary.firstName,
        playFrom: item && item.vod_play_from || '',
        candidateCount: candidates.length
    };

    if (candidates.length === 0 || sample.probePlayback === false) {
        return result;
    }

    const probes = [];
    for (const candidate of candidates.slice(0, sample.maxProbeUrls || 2)) {
        probes.push({
            url: candidate,
            ...(await probeUrl(candidate))
        });
    }
    result.playbackProbes = probes;

    const successful = probes.find(probe => probe.status === 200);
    if (!successful || sample.runPlayerChain === false) {
        return result;
    }

    const playUrlResult = {
        url: successful.url,
        format: successful.url.toLowerCase().includes('.m3u8') ? 'm3u8' : 'unknown',
        quality: 'unknown',
        codec: 'unknown',
        hdr: false,
        sourceKind: 'normal',
        headers: {},
        sourceId: source.id,
        sourceName: source.name,
        title: item && item.vod_name || summary.firstName
    };
    result.playerChain = await runPlayerChain(baseUrl, playUrlResult, sample.openMpv === true, sample.killNewMpvAfterOpen !== false);
    return result;
}

async function runPlayerChain(baseUrl, playUrlResult, openMpv, killNewMpvAfterOpen) {
    const classify = await fetchJson(baseUrl, 'post', '/api/player/classify', playUrlResult);
    const diagnose = await fetchJson(baseUrl, 'post', '/api/player/diagnose', playUrlResult);
    const proxy = await fetchJson(baseUrl, 'post', '/api/player/proxy-url', playUrlResult);
    let proxyPreview = '';
    try {
        const response = await axios.get(proxy.proxyUrl, {
            timeout: 20000,
            validateStatus: () => true
        });
        proxyPreview = String(response.data || '').split(/\r?\n/).slice(0, 8).join('\n');
    } catch (error) {
        proxyPreview = `proxy-preview-error: ${error.message}`;
    }

    const result = {
        classify,
        diagnose,
        proxy,
        proxyPreview
    };

    if (!openMpv) return result;

    const before = listMpvPids();
    const openResult = await fetchJson(baseUrl, 'post', '/api/player/open-mpv', playUrlResult);
    await delay(3000);
    const after = listMpvPids();
    const newPids = after.filter(pid => !before.includes(pid));
    result.openMpv = {
        response: openResult,
        newPids
    };
    if (killNewMpvAfterOpen) {
        killMpvPids(newPids);
    }
    return result;
}

async function runLiveSample(baseUrl, subscription, sample) {
    const channelsResponse = await fetchJson(
        baseUrl,
        'get',
        `/api/live/channels?group=${encodeURIComponent(sample.group)}&limit=${Number(sample.limit || 3)}`
    );
    const channels = channelsResponse.channels || [];
    const probes = [];
    for (const channel of channels) {
        probes.push({
            id: channel.id,
            name: channel.name,
            group: channel.group,
            url: channel.url,
            ...(await probeUrl(channel.url))
        });
    }

    const result = {
        group: sample.group,
        total: channelsResponse.total,
        sampled: probes
    };

    const playable = probes.find(item => item.status === 200);
    if (!playable || sample.runPlayerChain === false) {
        return result;
    }

    const playUrlResult = {
        url: playable.url,
        format: 'm3u8',
        quality: 'unknown',
        codec: 'unknown',
        hdr: false,
        sourceKind: 'live',
        headers: {},
        sourceId: playable.id,
        sourceName: `${subscription.name}:${playable.name}`,
        title: playable.name
    };
    result.playerChain = await runPlayerChain(baseUrl, playUrlResult, sample.openMpv === true, sample.killNewMpvAfterOpen !== false);
    return result;
}

async function startServer(repoDir, runtimeDir, port, artifactsDir) {
    ensureDir(runtimeDir);
    ensureDir(artifactsDir);
    const stdoutPath = path.join(artifactsDir, `server-${port}.out.log`);
    const stderrPath = path.join(artifactsDir, `server-${port}.err.log`);
    const stdout = fs.openSync(stdoutPath, 'w');
    const stderr = fs.openSync(stderrPath, 'w');

    const child = spawn(process.execPath, ['server.js'], {
        cwd: repoDir,
        env: {
            ...process.env,
            DONGGUATV_DATA_DIR: runtimeDir,
            PORT: String(port)
        },
        detached: false,
        stdio: ['ignore', stdout, stderr],
        windowsHide: true
    });

    return {
        child,
        stdoutPath,
        stderrPath
    };
}

async function stopServer(child) {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        delay(5000)
    ]);
    if (child.exitCode === null) {
        try {
            process.kill(child.pid, 'SIGKILL');
        } catch (_) {
            // Best-effort cleanup only.
        }
    }
}

async function main() {
    const { config, source } = readConfig();
    const repoDir = path.resolve(__dirname, '..');
    const runtimeDir = path.resolve(
        config.runtimeDir || fs.mkdtempSync(path.join(os.tmpdir(), 'donggua-real-qa-'))
    );
    const artifactsDir = path.resolve(
        config.artifactsDir || path.join(path.dirname(runtimeDir), 'artifacts')
    );
    const port = Number(config.port || 31386);
    const baseUrl = `http://127.0.0.1:${port}`;
    const reportPath = path.resolve(
        config.reportPath
            || process.env.TEST_TVBOX_QA_REPORT
            || path.join(artifactsDir, `tvbox-real-qa-report-${Date.now()}.json`)
    );

    const server = await startServer(repoDir, runtimeDir, port, artifactsDir);
    const report = {
        ok: false,
        configSource: source,
        repoDir,
        runtimeDir,
        artifactsDir,
        port,
        startedAt: new Date().toISOString(),
        subscriptions: []
    };

    try {
        await waitForServer(baseUrl, 40000);

        if (config.player && Object.keys(config.player).length > 0) {
            report.playerSettings = await fetchJson(baseUrl, 'patch', '/api/player/settings', config.player);
        } else {
            report.playerSettings = await fetchJson(baseUrl, 'get', '/api/player/settings');
        }

        for (const definition of config.subscriptions || []) {
            const imported = await fetchJson(baseUrl, 'post', '/api/subscriptions/import', {
                url: definition.url,
                filePath: definition.filePath,
                config: definition.config,
                localFileName: definition.localFileName,
                name: definition.name,
                enabled: definition.enabled !== false,
                expandWarehouses: definition.expandWarehouses,
                warehouseLimit: definition.warehouseLimit
            });

            const entry = {
                name: definition.name || imported.subscription && imported.subscription.name || '',
                subscriptionId: imported.subscription && imported.subscription.id || '',
                statusCounts: toCountMap(imported.sources || [], 'status'),
                supportCounts: toCountMap(imported.sources || [], 'supportLevel'),
                sourceCount: (imported.sources || []).length,
                liveCount: (imported.liveChannels || []).length,
                parseCount: (imported.parses || []).length,
                httpSamples: [],
                liveSample: null
            };

            for (const sample of definition.httpSamples || []) {
                const sourceMatch = findSource(imported.sources, sample.sourceName || sample.sourceKey || sample.sourceId);
                if (!sourceMatch) {
                    entry.httpSamples.push({
                        sourceName: sample.sourceName || sample.sourceKey || sample.sourceId,
                        keyword: sample.keyword,
                        error: 'source-not-found'
                    });
                    continue;
                }
                entry.httpSamples.push(await runHttpSample(baseUrl, sourceMatch, sample));
            }

            if (definition.liveSample) {
                entry.liveSample = await runLiveSample(baseUrl, definition, definition.liveSample);
            }

            report.subscriptions.push(entry);
        }

        report.ok = true;
        report.finishedAt = new Date().toISOString();
    } finally {
        await stopServer(server.child);
        ensureDir(path.dirname(reportPath));
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
        report.reportPath = reportPath;
    }

    console.log(JSON.stringify({
        ok: report.ok,
        reportPath,
        subscriptionCount: report.subscriptions.length,
        runtimeDir,
        artifactsDir
    }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
