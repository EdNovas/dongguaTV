const fs = require('fs');
const http = require('http');
const path = require('path');
const { JavaBridgeSupervisor } = require('./javaBridgeSupervisor');

const SERVICE_NAME = 'dongguatv-catvod-http-bridge';
const VERSION = '0.1.0';
const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 9978,
  runtime: {
    mode: 'disabled',
    allowJavaProcess: false,
    trustedBridgeJar: false,
    javaPath: '',
    catvodBridgeJarPath: '',
    adapterModulePath: '',
    childHost: '127.0.0.1',
    childPort: 9977,
    javaArgs: ['-jar', '{jar}', '--host', '{host}', '--port', '{port}'],
    startupTimeoutMs: 8000,
    requestTimeoutMs: 15000
  },
  logging: {
    level: 'info'
  }
};
const ALLOWED_OPERATIONS = new Set(['search', 'category', 'detail', 'play']);
const MAX_BODY_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function deepMerge(base, patch) {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      output[key] = deepMerge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function loadConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };
  const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
  return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
}

function assertLocalHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1') {
    return normalized;
  }
  throw new Error('CatVod bridge refuses to bind to non-local hosts. Use 127.0.0.1.');
}

function normalizeConfig(config, args) {
  const next = deepMerge(DEFAULT_CONFIG, config);
  if (args.host) next.host = args.host;
  if (args.port) next.port = Number(args.port);

  next.host = assertLocalHost(next.host);
  next.port = Number(next.port || DEFAULT_CONFIG.port);
  if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) {
    throw new Error('CatVod bridge port must be an integer between 1024 and 65535.');
  }

  next.runtime = deepMerge(DEFAULT_CONFIG.runtime, next.runtime || {});
  if (!['disabled', 'stub', 'java-http'].includes(next.runtime.mode)) {
    next.runtime.mode = 'disabled';
  }
  next.runtime.childHost = assertLocalHost(next.runtime.childHost);
  next.runtime.childPort = Number(next.runtime.childPort || DEFAULT_CONFIG.runtime.childPort);
  if (!Number.isInteger(next.runtime.childPort) || next.runtime.childPort < 1024 || next.runtime.childPort > 65535) {
    throw new Error('Java bridge child port must be an integer between 1024 and 65535.');
  }
  next.runtime.allowJavaProcess = next.runtime.mode === 'java-http' && next.runtime.allowJavaProcess === true;
  next.runtime.trustedBridgeJar = next.runtime.mode === 'java-http' && next.runtime.trustedBridgeJar === true;
  next.runtime.startupTimeoutMs = Math.max(1000, Number(next.runtime.startupTimeoutMs || DEFAULT_CONFIG.runtime.startupTimeoutMs));
  next.runtime.requestTimeoutMs = Math.max(1000, Number(next.runtime.requestTimeoutMs || DEFAULT_CONFIG.runtime.requestTimeoutMs));
  if (!Array.isArray(next.runtime.javaArgs)) {
    next.runtime.javaArgs = DEFAULT_CONFIG.runtime.javaArgs;
  }
  return next;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function safeRuntimeStatus(config) {
  return {
    mode: config.runtime.mode,
    configured: config.runtime.mode === 'stub' || (
      config.runtime.mode === 'java-http' &&
      config.runtime.allowJavaProcess &&
      config.runtime.trustedBridgeJar &&
      !!config.runtime.catvodBridgeJarPath
    ),
    javaProcessEnabled: config.runtime.mode === 'java-http' &&
      config.runtime.allowJavaProcess &&
      config.runtime.trustedBridgeJar,
    javaPathConfigured: !!config.runtime.javaPath,
    catvodBridgeJarConfigured: !!config.runtime.catvodBridgeJarPath,
    trustedBridgeJar: !!config.runtime.trustedBridgeJar,
    childBaseUrl: `http://${config.runtime.childHost}:${config.runtime.childPort}`,
    adapterModuleConfigured: !!config.runtime.adapterModulePath
  };
}

function disabledOperation(operation) {
  return {
    ok: false,
    status: 'runtime-not-configured',
    operation,
    message: 'The local CatVod bridge scaffold is running, but no plugin runtime is enabled. Configure an explicit local runtime bridge before executing plugin sources.'
  };
}

function stubOperation(operation, payload) {
  const source = payload && payload.source ? payload.source : {};
  return {
    ok: true,
    status: 'stub',
    operation,
    source: {
      key: source.key || source.id || '',
      name: source.name || ''
    },
    result: operation === 'search' || operation === 'category' ? [] : null,
    message: 'Stub mode is active. No CatVod jar, py, or js plugin was executed.'
  };
}

async function handleRuntimeOperation(req, res, config, javaSupervisor, operation) {
  if (!ALLOWED_OPERATIONS.has(operation)) {
    sendJson(res, 404, { ok: false, status: 'unsupported-operation' });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, status: 'bad-request', error: error.message });
    return;
  }

  if (config.runtime.mode === 'stub') {
    sendJson(res, 200, stubOperation(operation, payload));
    return;
  }

  if (config.runtime.mode === 'java-http') {
    try {
      sendJson(res, 200, await javaSupervisor.call(operation, payload));
    } catch (error) {
      sendJson(res, 503, {
        ok: false,
        status: 'java-bridge-unavailable',
        operation,
        error: error.message
      });
    }
    return;
  }

  sendJson(res, 200, disabledOperation(operation));
}

function createServer(config) {
  const javaSupervisor = new JavaBridgeSupervisor(config.runtime);
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(res, 200, {
        service: SERVICE_NAME,
        version: VERSION,
        status: 'available',
        safeMode: true,
        runtime: safeRuntimeStatus(config),
        javaBridge: javaSupervisor.getStatus()
      });
      return;
    }

    const runtimeMatch = requestUrl.pathname.match(/^\/runtime\/([a-z-]+)$/);
    if (req.method === 'POST' && runtimeMatch) {
      await handleRuntimeOperation(req, res, config, javaSupervisor, runtimeMatch[1]);
      return;
    }

    sendJson(res, 404, {
      ok: false,
      status: 'not-found',
      endpoints: [
        'GET /health',
        'POST /runtime/search',
        'POST /runtime/category',
        'POST /runtime/detail',
        'POST /runtime/play'
      ]
    });
  });
  server.javaSupervisor = javaSupervisor;
  return server;
}

function start() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config
    ? path.resolve(String(args.config))
    : path.join(__dirname, 'bridge-config.json');
  const config = normalizeConfig(loadConfig(configPath), args);
  const server = createServer(config);

  server.listen(config.port, config.host, () => {
    console.log(`${SERVICE_NAME} ${VERSION} listening on http://${config.host}:${config.port}`);
    console.log(`runtime mode: ${config.runtime.mode}; java process enabled: false`);
  });

  server.on('error', error => {
    console.error(`Bridge failed to start: ${error.message}`);
    process.exitCode = 1;
  });

  function closeGracefully() {
    if (server.javaSupervisor) server.javaSupervisor.stop();
    server.close(() => process.exit(0));
  }

  process.on('SIGINT', closeGracefully);
  process.on('SIGTERM', closeGracefully);
}

if (require.main === module) {
  try {
    start();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  createServer,
  normalizeConfig,
  safeRuntimeStatus
};
