const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ALLOWED_OPERATIONS = new Set(['search', 'category', 'detail', 'play']);

function isLocalHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function httpJson(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      method,
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        if (raw.trim()) {
          try {
            data = JSON.parse(raw);
          } catch (error) {
            reject(new Error('Java bridge returned non-JSON response.'));
            return;
          }
        }
        resolve({ statusCode: res.statusCode || 0, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Java bridge request timed out.')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class JavaBridgeSupervisor {
  constructor(config) {
    this.config = config;
    this.child = null;
    this.childExit = null;
  }

  getBaseUrl() {
    return `http://${this.config.childHost}:${this.config.childPort}`;
  }

  isRunning() {
    return !!(this.child && !this.child.killed && this.child.exitCode === null);
  }

  getStatus() {
    return {
      mode: 'java-http',
      configured: this.isConfigured(),
      running: this.isRunning(),
      pid: this.isRunning() ? this.child.pid : null,
      childBaseUrl: this.getBaseUrl(),
      javaPathConfigured: !!this.config.javaPath,
      catvodBridgeJarConfigured: !!this.config.catvodBridgeJarPath,
      trustedBridgeJar: !!this.config.trustedBridgeJar,
      allowJavaProcess: !!this.config.allowJavaProcess,
      lastExit: this.childExit
    };
  }

  isConfigured() {
    return !!(
      this.config.allowJavaProcess &&
      this.config.trustedBridgeJar &&
      this.config.catvodBridgeJarPath &&
      fs.existsSync(this.config.catvodBridgeJarPath) &&
      isLocalHost(this.config.childHost)
    );
  }

  buildJavaArgs() {
    const template = Array.isArray(this.config.javaArgs) && this.config.javaArgs.length
      ? this.config.javaArgs
      : ['-jar', '{jar}', '--host', '{host}', '--port', '{port}'];

    return template.map(value => String(value)
      .replaceAll('{jar}', this.config.catvodBridgeJarPath)
      .replaceAll('{host}', this.config.childHost)
      .replaceAll('{port}', String(this.config.childPort)));
  }

  async ensureStarted() {
    if (this.isRunning()) return;
    if (!this.isConfigured()) {
      throw new Error('Java bridge is not configured. Enable java-http mode with an explicit trusted local bridge jar.');
    }

    const javaPath = this.config.javaPath || 'java';
    const args = this.buildJavaArgs();
    this.childExit = null;
    this.child = spawn(javaPath, args, {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });

    this.child.on('exit', (code, signal) => {
      this.childExit = { code, signal, at: new Date().toISOString() };
    });

    const deadline = Date.now() + this.config.startupTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) break;
      try {
        const health = await httpJson('GET', `${this.getBaseUrl()}/health`, null, 1000);
        if (health.statusCode >= 200 && health.statusCode < 300) return;
      } catch (error) {
        lastError = error;
      }
      await wait(300);
    }

    this.stop();
    throw new Error(lastError ? `Java bridge did not become healthy: ${lastError.message}` : 'Java bridge exited before becoming healthy.');
  }

  async call(operation, payload) {
    if (!ALLOWED_OPERATIONS.has(operation)) {
      throw new Error('Unsupported Java bridge operation.');
    }
    await this.ensureStarted();
    const response = await httpJson(
      'POST',
      `${this.getBaseUrl()}/runtime/${operation}`,
      payload || {},
      this.config.requestTimeoutMs
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Java bridge operation failed with HTTP ${response.statusCode}.`);
    }
    return response.data;
  }

  stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill();
  }
}

module.exports = {
  JavaBridgeSupervisor,
  isLocalHost
};
