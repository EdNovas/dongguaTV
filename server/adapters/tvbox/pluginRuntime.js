const fs = require('fs');
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
    const result = spawnSync('powershell', [
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        buildScript,
        '-OutDir',
        paths.outputDir
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
    return {
        running: isLocalJavaBridgeRunning(),
        pid: isLocalJavaBridgeRunning() ? localJavaBridgeProcess.pid : null,
        exit: localJavaBridgeExit,
        baseUrl: `http://127.0.0.1:${port}`,
        jarPath: settings.catvodBridgeJarPath || getLocalJavaBridgePaths(dataDir).jarPath,
        mode: settings.localJavaBridgeMode || DEFAULT_PLUGIN_RUNTIME_SETTINGS.localJavaBridgeMode
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
    const mode = ['disabled', 'stub'].includes(settings.localJavaBridgeMode) ? settings.localJavaBridgeMode : 'stub';
    const baseUrl = `http://127.0.0.1:${port}`;

    if (
        isLocalJavaBridgeRunning() &&
        localJavaBridgeRunConfig &&
        (localJavaBridgeRunConfig.port !== port || localJavaBridgeRunConfig.mode !== mode || localJavaBridgeRunConfig.jarPath !== jarPath)
    ) {
        localJavaBridgeProcess.kill();
        localJavaBridgeProcess = null;
        localJavaBridgeRunConfig = null;
    }

    if (!isLocalJavaBridgeRunning()) {
        localJavaBridgeExit = null;
        localJavaBridgeProcess = spawn(javaCheck.executable, [
            '-jar',
            jarPath,
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--mode',
            mode
        ], {
            detached: false,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore']
        });
        localJavaBridgeProcess.on('exit', (code, signal) => {
            localJavaBridgeExit = { code, signal, at: new Date().toISOString() };
            localJavaBridgeRunConfig = null;
        });
        localJavaBridgeRunConfig = { port, mode, jarPath };
    }

    const health = await waitForBridgeHealth(httpClient, baseUrl);
    const nextSettings = savePluginRuntimeSettings(dataDir, {
        enableJavaCatvod: true,
        javaPath: javaCheck.executable,
        catvodBridgeJarPath: jarPath,
        externalHttpBaseUrl: baseUrl,
        localJavaBridgePort: port,
        localJavaBridgeMode: mode
    });
    return {
        ok: true,
        baseUrl,
        pid: isLocalJavaBridgeRunning() ? localJavaBridgeProcess.pid : null,
        health,
        settings: nextSettings
    };
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
        return [
            {
                id: 'java-catvod',
                type: 'java-catvod',
                status: settings.enableJavaCatvod && javaCheck.available && bridgeJarExists ? 'available' : 'not-installed',
                enabled: !!settings.enableJavaCatvod,
                javaAvailable: !!javaCheck.available,
                bridgeJarConfigured: bridgeJarExists,
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
    createDefaultPluginRuntimeRegistry
};
