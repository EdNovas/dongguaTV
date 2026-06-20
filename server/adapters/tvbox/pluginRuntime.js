const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ExternalHttpBridgeClient } = require('./externalHttpBridge');

const DEFAULT_PLUGIN_RUNTIME_SETTINGS = {
    enableJavaCatvod: false,
    javaPath: '',
    catvodBridgeJarPath: '',
    externalHttpBaseUrl: '',
    localJavaBridgePort: 9977,
    localJavaBridgeMode: 'stub',
    trustedSpiderJarPath: '',
    trustedSpiderClassName: '',
    trustedSpiderExt: '',
    allowSubscriptionJarExecution: false
};

let localJavaBridgeProcess = null;
let localJavaBridgeExit = null;
let localJavaBridgeRunConfig = null;

function settingsPath(dataDir) {
    return path.join(dataDir, 'plugin-runtime-settings.json');
}

function readPluginRuntimeSettings(dataDir) {
    try {
        const filePath = settingsPath(dataDir);
        if (!fs.existsSync(filePath)) return { ...DEFAULT_PLUGIN_RUNTIME_SETTINGS };
        return { ...DEFAULT_PLUGIN_RUNTIME_SETTINGS, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } catch (error) {
        return { ...DEFAULT_PLUGIN_RUNTIME_SETTINGS };
    }
}

function savePluginRuntimeSettings(dataDir, patch) {
    const allowed = Object.keys(DEFAULT_PLUGIN_RUNTIME_SETTINGS);
    const next = { ...readPluginRuntimeSettings(dataDir) };
    for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
            next[key] = patch[key];
        }
    }
    next.allowSubscriptionJarExecution = false;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsPath(dataDir), JSON.stringify(next, null, 2), 'utf8');
    return next;
}

function getProjectRoot() {
    if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'catvod-runtime-bridge-java'))) {
        return process.resourcesPath;
    }
    return path.resolve(__dirname, '../../..');
}

function findToolInCommonJdkRoots(toolName) {
    const roots = [
        'C:\\Program Files\\Microsoft',
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Zulu'
    ];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        const dirs = fs.readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /jdk|openjdk|temurin|zulu/i.test(entry.name))
            .map(entry => path.join(root, entry.name))
            .sort()
            .reverse();
        for (const dir of dirs) {
            const candidate = path.join(dir, 'bin', `${toolName}.exe`);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return '';
}

function resolveJavaExecutable(javaPath) {
    if (javaPath && String(javaPath).trim()) return String(javaPath).trim();
    return findToolInCommonJdkRoots('java') || 'java';
}

function javaHomeFromExecutable(executable) {
    const value = String(executable || '').trim();
    if (!value || value.toLowerCase() === 'java') return '';
    const binDir = path.dirname(value);
    if (path.basename(binDir).toLowerCase() !== 'bin') return '';
    const javaHome = path.dirname(binDir);
    return fs.existsSync(path.join(javaHome, 'bin', 'java.exe')) ? javaHome : '';
}

function hasJdkTools(javaHome) {
    return !!(
        javaHome &&
        fs.existsSync(path.join(javaHome, 'bin', 'java.exe')) &&
        fs.existsSync(path.join(javaHome, 'bin', 'javac.exe')) &&
        fs.existsSync(path.join(javaHome, 'bin', 'jar.exe'))
    );
}

function findJdkHome(preferredJavaExecutable) {
    const directHome = javaHomeFromExecutable(preferredJavaExecutable);
    if (hasJdkTools(directHome)) return directHome;
    if (hasJdkTools(process.env.JAVA_HOME)) return process.env.JAVA_HOME;

    const roots = [
        'C:\\Program Files\\Microsoft',
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Zulu'
    ];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        if (hasJdkTools(root)) return root;
        const dirs = fs.readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /jdk|openjdk|temurin|zulu/i.test(entry.name))
            .map(entry => path.join(root, entry.name))
            .sort()
            .reverse();
        for (const dir of dirs) {
            if (hasJdkTools(dir)) return dir;
        }
    }
    return '';
}

function resolveJdkTools(javaExecutable) {
    const javaHome = findJdkHome(javaExecutable);
    if (!javaHome) {
        throw new Error('A JDK with java, javac, and jar is required for Java Bridge Reflect self-test.');
    }
    return {
        javaHome,
        java: path.join(javaHome, 'bin', 'java.exe'),
        javac: path.join(javaHome, 'bin', 'javac.exe'),
        jar: path.join(javaHome, 'bin', 'jar.exe')
    };
}

function checkJavaRuntime(javaPath) {
    const executable = resolveJavaExecutable(javaPath);
    const result = spawnSync(executable, ['-version'], {
        encoding: 'utf8',
        timeout: 3000,
        shell: false
    });
    const output = `${result.stderr || ''}${result.stdout || ''}`;
    return {
        executable,
        available: result.status === 0,
        version: (output.match(/version "([^"]+)"/) || [])[1] || '',
        error: result.error ? result.error.message : ''
    };
}

function getLocalJavaBridgePaths(dataDir) {
    const projectRoot = getProjectRoot();
    return {
        sourceDir: path.join(projectRoot, 'catvod-runtime-bridge-java'),
        devSourceDir: path.join(projectRoot, 'tools', 'catvod-runtime-bridge-java'),
        outputDir: path.join(dataDir, 'plugin-runtime', 'catvod-runtime-bridge-java'),
        jarPath: path.join(dataDir, 'plugin-runtime', 'catvod-runtime-bridge-java', 'catvod-runtime-bridge.jar')
    };
}

function getJavaBridgeSourceDir(dataDir) {
    const paths = getLocalJavaBridgePaths(dataDir);
    if (fs.existsSync(path.join(paths.sourceDir, 'build.ps1'))) return paths.sourceDir;
    return paths.devSourceDir;
}

function buildLocalJavaBridge(dataDir) {
    const settings = readPluginRuntimeSettings(dataDir);
    const javaCheck = checkJavaRuntime(settings.javaPath);
    if (!javaCheck.available) {
        throw new Error(`Java is not available: ${javaCheck.error || javaCheck.executable}`);
    }

    const sourceDir = getJavaBridgeSourceDir(dataDir);
    const buildScript = path.join(sourceDir, 'build.ps1');
    if (!fs.existsSync(buildScript)) {
        throw new Error('Local Java bridge build script was not found.');
    }

    const paths = getLocalJavaBridgePaths(dataDir);
    fs.mkdirSync(paths.outputDir, { recursive: true });
    const javaHome = findJdkHome(javaCheck.executable);
    const buildArgs = [
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        buildScript
    ];
    if (javaHome) {
        buildArgs.push('-JavaHome', javaHome);
    }
    buildArgs.push('-OutDir', paths.outputDir);
    const result = spawnSync('powershell', [
        ...buildArgs
    ], {
        encoding: 'utf8',
        timeout: 60000,
        shell: false
    });
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || 'Java bridge build failed').trim());
    }
    if (!fs.existsSync(paths.jarPath)) {
        throw new Error('Java bridge build finished but jar was not created.');
    }

    const nextSettings = savePluginRuntimeSettings(dataDir, {
        enableJavaCatvod: true,
        javaPath: javaCheck.executable,
        catvodBridgeJarPath: paths.jarPath
    });
    return {
        ok: true,
        jarPath: paths.jarPath,
        outputDir: paths.outputDir,
        java: javaCheck,
        settings: nextSettings
    };
}

function isLocalJavaBridgeRunning() {
    return !!(localJavaBridgeProcess && localJavaBridgeProcess.exitCode === null && !localJavaBridgeProcess.killed);
}

function getLocalJavaBridgeStatus(dataDir) {
    const settings = readPluginRuntimeSettings(dataDir);
    const port = Number(settings.localJavaBridgePort || DEFAULT_PLUGIN_RUNTIME_SETTINGS.localJavaBridgePort);
    const trustedSpiderJarPath = String(settings.trustedSpiderJarPath || '').trim();
    const trustedSpiderClassName = String(settings.trustedSpiderClassName || '').trim();
    return {
        running: isLocalJavaBridgeRunning(),
        pid: isLocalJavaBridgeRunning() ? localJavaBridgeProcess.pid : null,
        exit: localJavaBridgeExit,
        baseUrl: `http://127.0.0.1:${port}`,
        jarPath: settings.catvodBridgeJarPath || getLocalJavaBridgePaths(dataDir).jarPath,
        mode: settings.localJavaBridgeMode || DEFAULT_PLUGIN_RUNTIME_SETTINGS.localJavaBridgeMode,
        trustedSpiderJarConfigured: !!(trustedSpiderJarPath && fs.existsSync(trustedSpiderJarPath)),
        trustedSpiderClassName,
        trustedSpiderExtConfigured: !!String(settings.trustedSpiderExt || '').trim()
    };
}

async function waitForBridgeHealth(httpClient, baseUrl) {
    let lastError = null;
    for (let i = 0; i < 20; i += 1) {
        try {
            const response = await httpClient.get(`${baseUrl}/health`, {
                timeout: 1000,
                validateStatus: status => status >= 200 && status < 500
            });
            if (response.status >= 200 && response.status < 300) return response.data;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(lastError ? lastError.message : 'Local Java bridge did not become healthy.');
}

async function startLocalJavaBridge(dataDir, httpClient) {
    const settings = readPluginRuntimeSettings(dataDir);
    const jarPath = settings.catvodBridgeJarPath || getLocalJavaBridgePaths(dataDir).jarPath;
    if (!fs.existsSync(jarPath)) {
        throw new Error('Local Java bridge jar is missing. Build it first.');
    }
    const javaCheck = checkJavaRuntime(settings.javaPath);
    if (!javaCheck.available) {
        throw new Error(`Java is not available: ${javaCheck.error || javaCheck.executable}`);
    }
    const port = Number(settings.localJavaBridgePort || DEFAULT_PLUGIN_RUNTIME_SETTINGS.localJavaBridgePort);
    const mode = ['disabled', 'stub', 'reflect'].includes(settings.localJavaBridgeMode) ? settings.localJavaBridgeMode : 'stub';
    const trustedSpiderJarPath = String(settings.trustedSpiderJarPath || '').trim();
    const trustedSpiderClassName = String(settings.trustedSpiderClassName || '').trim();
    const trustedSpiderExt = String(settings.trustedSpiderExt || '');
    const baseUrl = `http://127.0.0.1:${port}`;

    if (mode === 'reflect') {
        if (!trustedSpiderJarPath || !fs.existsSync(trustedSpiderJarPath)) {
            throw new Error('Reflect mode requires a trusted local Spider jar path.');
        }
        if (!trustedSpiderClassName) {
            throw new Error('Reflect mode requires a trusted Spider class name.');
        }
    }

    const runConfig = {
        port,
        mode,
        jarPath,
        trustedSpiderJarPath,
        trustedSpiderClassName,
        trustedSpiderExt
    };

    if (
        isLocalJavaBridgeRunning() &&
        localJavaBridgeRunConfig &&
        (
            localJavaBridgeRunConfig.port !== runConfig.port ||
            localJavaBridgeRunConfig.mode !== runConfig.mode ||
            localJavaBridgeRunConfig.jarPath !== runConfig.jarPath ||
            localJavaBridgeRunConfig.trustedSpiderJarPath !== runConfig.trustedSpiderJarPath ||
            localJavaBridgeRunConfig.trustedSpiderClassName !== runConfig.trustedSpiderClassName ||
            localJavaBridgeRunConfig.trustedSpiderExt !== runConfig.trustedSpiderExt
        )
    ) {
        localJavaBridgeProcess.kill();
        localJavaBridgeProcess = null;
        localJavaBridgeRunConfig = null;
    }

    if (!isLocalJavaBridgeRunning()) {
        localJavaBridgeExit = null;
        const args = [
            '-jar',
            jarPath,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--mode',
            mode
        ];
        if (mode === 'reflect') {
            args.push(
                '--spider-jar',
                trustedSpiderJarPath,
                '--spider-class',
                trustedSpiderClassName,
                '--spider-ext',
                trustedSpiderExt
            );
        }
        localJavaBridgeProcess = spawn(javaCheck.executable, args, {
            detached: false,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore']
        });
        localJavaBridgeProcess.on('exit', (code, signal) => {
            localJavaBridgeExit = { code, signal, at: new Date().toISOString() };
            localJavaBridgeRunConfig = null;
        });
        localJavaBridgeRunConfig = runConfig;
    }

    const health = await waitForBridgeHealth(httpClient, baseUrl);
    const nextSettings = savePluginRuntimeSettings(dataDir, {
        enableJavaCatvod: true,
        javaPath: javaCheck.executable,
        catvodBridgeJarPath: jarPath,
        externalHttpBaseUrl: baseUrl,
        localJavaBridgePort: port,
        localJavaBridgeMode: mode,
        trustedSpiderJarPath,
        trustedSpiderClassName,
        trustedSpiderExt
    });
    return {
        ok: true,
        baseUrl,
        pid: isLocalJavaBridgeRunning() ? localJavaBridgeProcess.pid : null,
        health,
        settings: nextSettings
    };
}

function freeLoopbackPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function postJson(url, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload || {});
        const request = http.request(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body)
            }
        }, response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => {
                try {
                    const json = JSON.parse(text || '{}');
                    if (response.statusCode >= 400) {
                        reject(new Error(json.error || `HTTP ${response.statusCode}`));
                        return;
                    }
                    resolve(json);
                } catch (error) {
                    reject(new Error(`Invalid JSON response: ${text.slice(0, 200)}`));
                }
            });
        });
        request.on('error', reject);
        request.write(body);
        request.end();
    });
}

function runChecked(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: options.timeout || 60000,
        cwd: options.cwd || process.cwd(),
        shell: false
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed: ${result.stderr || result.stdout || (result.error && result.error.message) || 'unknown error'}`);
    }
    return result;
}

function writeFakeSpiderSource(spiderSrc) {
    fs.mkdirSync(spiderSrc, { recursive: true });
    fs.writeFileSync(path.join(spiderSrc, 'FakeSpider.java'), `
package com.example;

import java.util.List;

public class FakeSpider {
    public void init(String ext) {}

    public String searchContent(String keyword, boolean quick) {
        return "{\\"list\\":[{\\"vod_id\\":\\"reflect-1\\",\\"vod_name\\":\\"Reflect Search " + keyword + "\\",\\"vod_pic\\":\\"https://example.test/reflect.jpg\\",\\"vod_remarks\\":\\"reflect\\"}]}";
    }

    public String detailContent(List<String> ids) {
        String id = ids == null || ids.isEmpty() ? "reflect-1" : ids.get(0);
        return "{\\"list\\":[{\\"vod_id\\":\\"" + id + "\\",\\"vod_name\\":\\"Reflect Detail\\",\\"vod_play_from\\":\\"reflect\\",\\"vod_play_url\\":\\"HD$https://example.test/reflect.m3u8\\"}]}";
    }

    public String playerContent(String flag, String id, List<String> flags) {
        return "{\\"url\\":\\"https://example.test/play/" + id + ".m3u8\\",\\"headers\\":{\\"User-Agent\\":\\"DongguaTV-Test\\"}}";
    }
}
`, 'utf8');
}

async function runJavaReflectSelfTest(dataDir, httpClient) {
    const settings = readPluginRuntimeSettings(dataDir);
    const javaCheck = checkJavaRuntime(settings.javaPath);
    if (!javaCheck.available) {
        throw new Error(`Java is not available: ${javaCheck.error || javaCheck.executable}`);
    }
    const tools = resolveJdkTools(javaCheck.executable);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donggua-java-reflect-self-test-'));
    const bridgeOut = path.join(tempDir, 'bridge');
    const spiderSrc = path.join(tempDir, 'spider-src', 'com', 'example');
    const spiderClasses = path.join(tempDir, 'spider-classes');
    const spiderJar = path.join(tempDir, 'fake-spider.jar');
    let child = null;

    try {
        const sourceDir = getJavaBridgeSourceDir(dataDir);
        const buildScript = path.join(sourceDir, 'build.ps1');
        if (!fs.existsSync(buildScript)) {
            throw new Error('Local Java bridge build script was not found.');
        }
        runChecked('powershell', [
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            buildScript,
            '-JavaHome',
            tools.javaHome,
            '-OutDir',
            bridgeOut
        ], { timeout: 120000 });
        const bridgeJar = path.join(bridgeOut, 'catvod-runtime-bridge.jar');
        if (!fs.existsSync(bridgeJar)) {
            throw new Error('Java bridge self-test build finished but jar was not created.');
        }

        fs.mkdirSync(spiderClasses, { recursive: true });
        writeFakeSpiderSource(spiderSrc);
        runChecked(tools.javac, ['-encoding', 'UTF-8', '-d', spiderClasses, path.join(spiderSrc, 'FakeSpider.java')]);
        runChecked(tools.jar, ['cf', spiderJar, '-C', spiderClasses, '.']);
        if (!fs.existsSync(spiderJar)) {
            throw new Error('Java Bridge Reflect self-test fake Spider jar was not created.');
        }

        const port = await freeLoopbackPort();
        const baseUrl = `http://127.0.0.1:${port}`;
        child = spawn(tools.java, [
            '-jar',
            bridgeJar,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--mode',
            'reflect',
            '--spider-jar',
            spiderJar,
            '--spider-class',
            'com.example.FakeSpider',
            '--spider-ext',
            'self-test'
        ], {
            stdio: ['ignore', 'ignore', 'ignore'],
            windowsHide: true,
            shell: false
        });

        await waitForBridgeHealth(httpClient, baseUrl);
        const search = await postJson(`${baseUrl}/runtime/search`, {
            params: { keyword: 'Joy', quick: false }
        });
        const detail = await postJson(`${baseUrl}/runtime/detail`, {
            params: { id: 'reflect-1' }
        });
        const play = await postJson(`${baseUrl}/runtime/play`, {
            params: { flag: 'HD', id: 'reflect-1' }
        });

        const searchTitle = search && search.result && search.result.list && search.result.list[0] && search.result.list[0].vod_name;
        const detailTitle = detail && detail.result && detail.result.list && detail.result.list[0] && detail.result.list[0].vod_name;
        const playUrl = play && play.result && play.result.url;
        if (searchTitle !== 'Reflect Search Joy' || detailTitle !== 'Reflect Detail' || !/reflect-1\.m3u8/.test(playUrl || '')) {
            throw new Error('Java Bridge Reflect self-test returned unexpected search/detail/play results.');
        }

        const nextSettings = savePluginRuntimeSettings(dataDir, {
            javaPath: tools.java
        });
        return {
            ok: true,
            mode: 'reflect',
            java: {
                executable: tools.java,
                javaHome: tools.javaHome,
                version: javaCheck.version
            },
            bridgeBuilt: true,
            fakeSpiderOnly: true,
            searchTitle,
            detailTitle,
            playUrl,
            settings: nextSettings
        };
    } finally {
        if (child) child.kill();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {}
    }
}

function stopLocalJavaBridge(dataDir) {
    const settings = readPluginRuntimeSettings(dataDir);
    const localBaseUrl = `http://127.0.0.1:${Number(settings.localJavaBridgePort || DEFAULT_PLUGIN_RUNTIME_SETTINGS.localJavaBridgePort)}`;
    if (isLocalJavaBridgeRunning()) {
        localJavaBridgeProcess.kill();
    }
    localJavaBridgeRunConfig = null;
    if (settings.externalHttpBaseUrl === localBaseUrl) {
        savePluginRuntimeSettings(dataDir, { externalHttpBaseUrl: '' });
    }
    return getLocalJavaBridgeStatus(dataDir);
}

process.once('exit', () => {
    if (isLocalJavaBridgeRunning()) {
        localJavaBridgeProcess.kill();
    }
});

class PluginRuntime {
    constructor({ id, type, status }) {
        this.id = id;
        this.type = type;
        this.status = status || 'not-installed';
    }

    unsupported() {
        throw new Error('Plugin runtime is not installed. This version only identifies plugin-required TVBox sources.');
    }

    search() { return this.unsupported(); }
    category() { return this.unsupported(); }
    detail() { return this.unsupported(); }
    play() { return this.unsupported(); }
}

function createDefaultPluginRuntimeRegistry(dataDir, httpClient) {
    function getExternalHttpBridge() {
        const settings = readPluginRuntimeSettings(dataDir);
        return new ExternalHttpBridgeClient({
            baseUrl: settings.externalHttpBaseUrl,
            httpClient
        });
    }

    function buildRuntimeDescriptors() {
        const settings = readPluginRuntimeSettings(dataDir);
        const javaCheck = settings.enableJavaCatvod ? checkJavaRuntime(settings.javaPath) : { available: false };
        const bridgeJarExists = !!(settings.catvodBridgeJarPath && fs.existsSync(settings.catvodBridgeJarPath));
        const trustedSpiderJarPath = String(settings.trustedSpiderJarPath || '').trim();
        const trustedSpiderClassName = String(settings.trustedSpiderClassName || '').trim();
        return [
            {
                id: 'java-catvod',
                type: 'java-catvod',
                status: settings.enableJavaCatvod && javaCheck.available && bridgeJarExists ? 'available' : 'not-installed',
                enabled: !!settings.enableJavaCatvod,
                javaAvailable: !!javaCheck.available,
                bridgeJarConfigured: bridgeJarExists,
                localJavaBridgeMode: settings.localJavaBridgeMode || DEFAULT_PLUGIN_RUNTIME_SETTINGS.localJavaBridgeMode,
                trustedSpiderJarConfigured: !!(trustedSpiderJarPath && fs.existsSync(trustedSpiderJarPath)),
                trustedSpiderClassName,
                trustedSpiderExtConfigured: !!String(settings.trustedSpiderExt || '').trim(),
                safeMode: true
            },
            {
                id: 'js-drpy',
                type: 'js-drpy',
                status: 'not-installed',
                enabled: false,
                safeMode: true
            },
            {
                id: 'python',
                type: 'python',
                status: 'not-installed',
                enabled: false,
                safeMode: true
            },
            {
                id: 'external-http',
                type: 'external-http',
                status: settings.externalHttpBaseUrl ? 'available' : 'not-installed',
                enabled: !!settings.externalHttpBaseUrl,
                safeMode: true
            }
        ];
    }

    return {
        list() {
            return buildRuntimeDescriptors();
        },
        get(id) {
            const descriptor = buildRuntimeDescriptors().find(runtime => runtime.id === id);
            return descriptor ? new PluginRuntime(descriptor) : null;
        },
        getSettings() {
            return readPluginRuntimeSettings(dataDir);
        },
        saveSettings(patch) {
            return savePluginRuntimeSettings(dataDir, patch);
        },
        checkJava() {
            const settings = readPluginRuntimeSettings(dataDir);
            return checkJavaRuntime(settings.javaPath);
        },
        buildLocalJavaBridge() {
            return buildLocalJavaBridge(dataDir);
        },
        getLocalJavaBridgeStatus() {
            return getLocalJavaBridgeStatus(dataDir);
        },
        startLocalJavaBridge() {
            return startLocalJavaBridge(dataDir, httpClient);
        },
        runJavaReflectSelfTest() {
            return runJavaReflectSelfTest(dataDir, httpClient);
        },
        stopLocalJavaBridge() {
            return stopLocalJavaBridge(dataDir);
        },
        async checkExternalHttpBridge() {
            return getExternalHttpBridge().health();
        },
        async callExternalHttpBridge(operation, payload) {
            return getExternalHttpBridge().call(operation, payload);
        }
    };
}

module.exports = {
    PluginRuntime,
    DEFAULT_PLUGIN_RUNTIME_SETTINGS,
    readPluginRuntimeSettings,
    savePluginRuntimeSettings,
    checkJavaRuntime,
    runJavaReflectSelfTest,
    createDefaultPluginRuntimeRegistry
};
