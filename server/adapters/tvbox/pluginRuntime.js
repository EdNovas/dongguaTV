const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ExternalHttpBridgeClient } = require('./externalHttpBridge');

const DEFAULT_PLUGIN_RUNTIME_SETTINGS = {
    enableJavaCatvod: false,
    javaPath: '',
    catvodBridgeJarPath: '',
    externalHttpBaseUrl: '',
    allowSubscriptionJarExecution: false
};

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

function checkJavaRuntime(javaPath) {
    const executable = javaPath && String(javaPath).trim() ? String(javaPath).trim() : 'java';
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
    createDefaultPluginRuntimeRegistry
};
