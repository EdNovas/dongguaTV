# CatVod HTTP Bridge Scaffold

DongguaTV can identify TVBox plugin-style sources such as `csp_xxx`, `spider.jar`, py, and js definitions. The desktop app does not execute those plugins directly. This bridge is a local-only protocol scaffold for a future CatVod runtime.

## Safety Rules

- The bridge binds only to `127.0.0.1`, `localhost`, or `::1`.
- Java process launch is disabled unless local config explicitly sets `mode` to `java-http`, `allowJavaProcess` to `true`, and `trustedBridgeJar` to `true`.
- Subscription-provided `jar`, py, and js code is never loaded automatically.
- Runtime operation responses do not echo raw playback URLs, cookies, tokens, or headers.
- Default mode is `disabled`, which returns `runtime-not-configured` for plugin operations.

## Start The Bridge

```powershell
npm run bridge:catvod
```

Or run it directly:

```powershell
node tools\catvod-bridge\server.js --host 127.0.0.1 --port 9978
```

Then set DongguaTV Settings > TVBox plugin runtime > External HTTP Bridge to:

```text
http://127.0.0.1:9978
```

Use the Settings page "Check HTTP Bridge" button to verify it.

## Protocol

The main app expects:

- `GET /health`
- `POST /runtime/search`
- `POST /runtime/category`
- `POST /runtime/detail`
- `POST /runtime/play`

Default operation response:

```json
{
  "ok": false,
  "status": "runtime-not-configured",
  "operation": "search"
}
```

For local UI testing only, copy `bridge-config.example.json` to `bridge-config.json` and set:

```json
{
  "runtime": {
    "mode": "stub"
  }
}
```

Stub mode returns empty results and still does not execute CatVod jar, py, or js plugins.

## Java HTTP Mode

Java HTTP mode is only for a separate trusted local bridge jar that you install manually. It is not for subscription-provided `spider.jar` links.

Example local config:

```json
{
  "host": "127.0.0.1",
  "port": 9978,
  "runtime": {
    "mode": "java-http",
    "allowJavaProcess": true,
    "trustedBridgeJar": true,
    "javaPath": "java",
    "catvodBridgeJarPath": "D:\\Tools\\catvod-bridge\\catvod-runtime-bridge.jar",
    "childHost": "127.0.0.1",
    "childPort": 9977,
    "javaArgs": ["-jar", "{jar}", "--host", "{host}", "--port", "{port}"]
  }
}
```

When a runtime operation is received, the scaffold starts the Java bridge with `child_process.spawn` and `shell:false`, waits for `GET /health` on the child bridge, then forwards:

- `POST /runtime/search`
- `POST /runtime/category`
- `POST /runtime/detail`
- `POST /runtime/play`

The expected Java child bridge must expose the same HTTP protocol on `127.0.0.1`.

This repository now includes a minimal Java child bridge source tree at `tools/catvod-runtime-bridge-java`. It can be built with:

```powershell
npm run bridge:java:build
```

The output jar is `tools\catvod-runtime-bridge-java\dist\catvod-runtime-bridge.jar`. It currently implements the local HTTP protocol in disabled/stub mode only; it does not execute TVBox plugin code.

On Windows, the build script can auto-detect JDK installs under common roots such as `C:\Program Files\Microsoft`. It was validated with Microsoft OpenJDK 21.

The desktop Settings page can now build and start the local Java Bridge. The generated jar is written under Electron `userData\plugin-runtime\catvod-runtime-bridge-java`, then the app sets `externalHttpBaseUrl` to the localhost bridge URL. This avoids writing generated files into `app.asar` or the installed program resources.

Settings also shows local bridge status, including running state, PID, URL, mode, and jar path. Use `Stop Local Bridge` to stop the child process and clear the local `externalHttpBaseUrl`.

The Subscriptions panel has a per-source `Diagnose` action. Plugin-required sources report whether the local Java Bridge is running and explain why DongguaTV does not directly execute subscription-provided plugin code.

## Future Java Runtime Bridge

The Java child bridge itself still needs to be implemented separately. It should:

- is installed and configured explicitly by the user;
- runs as a local process outside Electron;
- exposes the same HTTP protocol;
- never loads subscription jar files without explicit user approval;
- redacts URLs, headers, cookies, and tokens from logs;
- converts CatVod search, category, detail, and play results into the existing DongguaTV `PlayUrlResult` flow.
