# DongguaTV Enhanced Windows Desktop Acceptance

## Scope

This Windows desktop build keeps the original DongguaTV search, detail, and internal playback flow, then adds:

- Apple TV style desktop shell.
- User-provided TVBox subscription intake.
- Plugin-required source identification without executing unknown jar, py, or js code.
- MPC-HC / MPC-BE external playback support.
- Local playback proxy bound to `127.0.0.1`.
- Runtime data stored under Electron `userData/runtime`.

## Runtime Files

Electron sets `DONGGUATV_DATA_DIR` to:

```text
%APPDATA%\DongguaTV Enhanced\runtime
```

The app creates these files when missing:

- `db.json`
- `subscriptions.json`
- `sources.json`
- `live-channels.json`
- `tvbox-parses.json`
- `player-settings.json`
- `plugin-runtime-settings.json`

## Commands

```powershell
npm install
npm run dev
npm run build
npm run dist
```

`npm run dist:desktop` is kept as an alias for the Windows Electron package.

## MPC Setup

Open Settings, then either detect or paste the local MPC executable path.

Common paths checked:

- `C:\Program Files\MPC-HC\mpc-hc64.exe`
- `C:\Program Files (x86)\MPC-HC\mpc-hc.exe`
- `C:\Program Files\MPC-BE x64\mpc-be64.exe`
- `C:\Program Files\MPC-BE\mpc-be.exe`

The app passes the media URL as a separate `spawn` argument, not through a shell command string.

## TVBox Import

Open Subscriptions, paste a user-owned TVBox JSON URL, then import.

Supported in this phase:

- `sites`
- `parses`
- `lives`
- `spider`
- `jar`
- `flags`
- `rules`
- `doh`
- `wallpaper`
- `ads`
- `warningText`
- `ijk`
- `player`
- `ext`

Plugin-like sources are marked `plugin-required` and are not executed.

## Plugin Runtime Bridge Prep

Settings contains a TVBox plugin runtime panel for safe bridge preparation.

Supported in this phase:

- Save Java executable path.
- Save a local CatVod Bridge jar path.
- Save an optional external HTTP Bridge base URL.
- Detect whether Java is available.
- Detect whether an external HTTP Bridge is available.
- Show runtime statuses from `/api/plugin-runtimes`.

Not supported in this phase:

- Automatically executing `spider.jar` from subscriptions.
- Running unknown py or js plugins.
- Bypassing DRM, member-only gates, or paid content restrictions.

`allowSubscriptionJarExecution` is forced to `false` by the backend.

External HTTP Bridge endpoints used by the app:

- `GET /health`
- `POST /runtime/search`
- `POST /runtime/category`
- `POST /runtime/detail`
- `POST /runtime/play`

The Bridge base URL must point to localhost or a private network address. Public internet hosts are rejected by the backend.

This repository includes a local-only scaffold at `tools/catvod-bridge`. Start it with:

```powershell
npm run bridge:catvod
```

Default mode returns `runtime-not-configured` and does not execute CatVod jar, py, or js plugin code. Java HTTP child bridge mode exists, but it only starts a manually configured trusted local bridge jar when `mode=java-http`, `allowJavaProcess=true`, and `trustedBridgeJar=true`. See `docs/CATVOD_BRIDGE.md` for the bridge protocol and future Java Runtime Bridge plan.

A minimal Java child bridge source tree is included at `tools/catvod-runtime-bridge-java`. It builds to a local trusted jar with `npm run bridge:java:build` when a JDK is installed. The current jar protocol implementation supports disabled/stub responses only.

The Java bridge build path has been validated with Microsoft OpenJDK 21. The script can auto-detect common Windows JDK install locations when `java` is not yet visible in the current terminal `PATH`.

Settings exposes one-click local Java Bridge build/start actions. Built jars are stored in Electron `userData\plugin-runtime\catvod-runtime-bridge-java`, and the app auto-fills `externalHttpBaseUrl` with the localhost bridge URL after startup.

The Settings page also shows local Java Bridge running state, PID, URL, mode, and jar path, with refresh and stop controls.

The Subscriptions panel exposes per-source diagnostics. Plugin-required sources show whether the local Java Bridge is running and explain that subscription-provided plugin code is not executed directly.

## Playback Diagnosis

When a source cannot play:

- `plugin-required`: CatVod/Spider runtime is required and not installed.
- `unsupported`: the source is not an HTTP-compatible source in this version.
- `error`: health check or import failed.
- Missing MPC path: configure Settings > MPC external player.
- Local proxy issue: check `player-settings.json` `localProxyPort` and whether the port is occupied.
- Source diagnostics: use Subscriptions > Diagnose on the specific source to see unsupported/plugin/runtime reasons.

## LocalProxy

The LocalProxy listens only on:

```text
127.0.0.1
```

It forwards common playback headers and Range requests, and it returns `206 Partial Content` for range-capable upstream responses.

## Packaging Checklist

- `server/**` must stay in `build.files` so Electron asar includes TVBox, player, desktop, and proxy modules.
- `tools/catvod-bridge/**` and `docs/**` are packaged as `extraResources` so the installed app exposes the local bridge template and operator documentation outside `app.asar`.
- `tools/catvod-runtime-bridge-java/**` is packaged as `extraResources` without generated `build` or `dist` outputs.
- Packaged smoke tests must hit the unpacked exe, not only `npm run dev`.
- User settings must remain in `userData/runtime`, not inside the installed app directory.
