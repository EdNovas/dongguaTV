const assert = require('node:assert/strict');
const { buildPluginSourceDiagnostics } = require('../server/adapters/tvbox');

const source = {
    id: 'plugin-source-1',
    name: 'Plugin Fixture',
    sourceType: 'plugin-required',
    status: 'plugin-required'
};

const stopped = buildPluginSourceDiagnostics(source, {
    settings: {},
    localJavaBridge: { running: false, mode: 'stub', readiness: 'stopped' }
});
assert.equal(stopped.playable, false);
assert.equal(stopped.reason, 'plugin-runtime-required');

const stub = buildPluginSourceDiagnostics(source, {
    settings: {},
    localJavaBridge: { running: true, mode: 'stub', readiness: 'stub' }
});
assert.equal(stub.playable, false);
assert.equal(stub.reason, 'bridge-stub-mode');

const reflect = buildPluginSourceDiagnostics(source, {
    settings: {},
    localJavaBridge: {
        running: true,
        mode: 'reflect',
        readiness: 'reflect-ready',
        trustedSpiderJarConfigured: true,
        trustedSpiderClassName: 'com.example.Spider'
    }
});
assert.equal(reflect.playable, true);
assert.equal(reflect.reason, 'trusted-reflect-runtime-running');

const external = buildPluginSourceDiagnostics(source, {
    settings: { externalHttpBaseUrl: 'http://127.0.0.1:4567' },
    localJavaBridge: { running: false, mode: 'stub', readiness: 'stopped' }
});
assert.equal(external.playable, true);
assert.equal(external.reason, 'trusted-external-bridge-configured');
assert.equal(Object.prototype.hasOwnProperty.call(external.runtime, 'externalHttpBaseUrl'), false);

console.log(JSON.stringify({
    ok: true,
    stopped: stopped.reason,
    stub: stub.reason,
    reflect: reflect.reason,
    external: external.reason
}, null, 2));
