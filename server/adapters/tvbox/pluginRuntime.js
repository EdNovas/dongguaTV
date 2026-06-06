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

function createDefaultPluginRuntimeRegistry() {
    const runtimes = [
        new PluginRuntime({ id: 'java-catvod', type: 'java-catvod', status: 'not-installed' }),
        new PluginRuntime({ id: 'js-drpy', type: 'js-drpy', status: 'not-installed' }),
        new PluginRuntime({ id: 'python', type: 'python', status: 'not-installed' }),
        new PluginRuntime({ id: 'external-http', type: 'external-http', status: 'not-installed' })
    ];
    return {
        list() {
            return runtimes.map(runtime => ({
                id: runtime.id,
                type: runtime.type,
                status: runtime.status
            }));
        },
        get(id) {
            return runtimes.find(runtime => runtime.id === id) || null;
        }
    };
}

module.exports = {
    PluginRuntime,
    createDefaultPluginRuntimeRegistry
};
