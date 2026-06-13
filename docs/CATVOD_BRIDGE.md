# CatVod HTTP Bridge Scaffold

DongguaTV can identify TVBox plugin-style sources such as `csp_xxx`, `spider.jar`, py, and js definitions. The desktop app does not execute those plugins directly. This bridge is a local-only protocol scaffold for a future CatVod runtime.

## Safety Rules

- The bridge binds only to `127.0.0.1`, `localhost`, or `::1`.
- `allowJavaProcess` is forced to `false` in this scaffold.
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

## Future Java Runtime Bridge

The next safe step is a separate Java Runtime Bridge process that:

- is installed and configured explicitly by the user;
- runs as a local process outside Electron;
- exposes the same HTTP protocol;
- never loads subscription jar files without explicit user approval;
- redacts URLs, headers, cookies, and tokens from logs;
- converts CatVod search, category, detail, and play results into the existing DongguaTV `PlayUrlResult` flow.
