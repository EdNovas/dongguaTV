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

If `DONGGUATV_DATA_DIR` is already provided in the process environment, the Electron main process keeps that override. This is used by packaged smoke tests so they do not touch the user's normal runtime data.

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

Settings can validate the configured MPC path through `POST /api/player/validate-mpc`. The validation is non-executing: it checks that the path exists, is a file, ends in `.exe`, and looks like an MPC-HC or MPC-BE executable.

## TVBox Import

Open Subscriptions, paste a user-owned TVBox JSON URL, then import. You can also choose a local `.json` file from the Subscriptions panel; the desktop UI reads the file locally and posts the parsed config to the same import endpoint. Local JSON imports are saved as a userData snapshot, so the refresh button reprocesses the last imported snapshot. If the disk file changes, choose the file again to import the new content.

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

Enabled TVBox HTTP/MacCMS-compatible sources that are marked searchable are included in normal search. Search results keep a `tvbox:` source key so the detail endpoint can fetch the matching user subscription source. Plugin-required and unsupported sources are skipped by search and remain visible through diagnostics.

Search cards and playback source buttons show TVBox badges when a result or line comes from a user subscription. The current playing source also shows whether it is a TVBox subscription source or a built-in source.

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

The Subscriptions panel also exposes per-source Health checks. HTTP-compatible sources are probed through the backend, and the latest status, latency, reason, and checked time are saved on the source record in `sources.json`. Plugin-required and unsupported sources return their marker status without executing plugin code.

Search empty states expose a Search Diagnostics panel. It reports built-in search site counts, TVBox HTTP sources participating in search, plugin-required sources, unsupported sources, and Local Java Bridge running state. This is diagnostic only for plugin sources: TVBox plugin code is not executed directly.

## Playback Diagnosis

When a source cannot play:

- `plugin-required`: CatVod/Spider runtime is required and not installed.
- `unsupported`: the source is not an HTTP-compatible source in this version.
- `error`: health check or import failed.
- Missing MPC path: configure Settings > MPC external player.
- Local proxy issue: check `player-settings.json` `localProxyPort` and whether the port is occupied.
- Current playback: use the player header `Proxy URL` button to register the current PlayUrlResult with LocalProxy and copy the local `127.0.0.1` URL for external player testing.
- Current playback recommendation: the player overlay calls `POST /api/player/classify` so MPC recommendations use the same backend rules as external playback dispatch.
- Playback classifier: when sources do not provide full metadata, the backend also infers 4K, HEVC/H.265, HDR, cloud-drive, MKV, and live-header hints from the URL before recommending a player.
- Source diagnostics: use Subscriptions > Diagnose on the specific source to see unsupported/plugin/runtime reasons.
- Search diagnostics: when search returns no results, use the inline Search Diagnostics panel to see whether the issue is missing built-in search sites, disabled TVBox sources, plugin-required sources, unsupported sources, or Local Java Bridge state.

## Live TV

The Live TV panel lists channels parsed from user-provided TVBox `lives`, M3U/M3U8, and TXT inputs. Channel cards can open the internal player or launch MPC. Live channels with custom headers are passed to MPC through the existing player API and LocalProxy path. Internal playback also registers a LocalProxy URL first when headers are present and local proxy is enabled.

Live TV supports group filtering, channel search, and paged loading for large channel lists. Group chips call the filtered live-channel API, and the search box matches channel names or group names without executing any plugin source code. The UI loads channels in batches and exposes a Load More button when additional matches are available.

Live TV channel favorites are stored in browser `localStorage` under `donggua_live_favorites`. Favorite filtering is local-only, so it does not modify imported subscriptions or hard-code any third-party source data into the app.

Live TV channel cards can copy the original channel URL. Channels with custom headers also expose a copy-proxy action that registers the URL with LocalProxy and copies the local `127.0.0.1` playback URL for external player diagnosis.

## LocalProxy

The LocalProxy listens only on:

```text
127.0.0.1
```

If the configured LocalProxy port is unavailable or denied, the app tries nearby higher ports and returns the actual local playback URL. The Settings status panel reports configured, requested, actual, and fallback reason values so the user can see when a fallback happened.

It forwards common playback headers and Range requests, and it returns `206 Partial Content` for range-capable upstream responses.

Settings exposes a read-only LocalProxy status check backed by `GET /api/player/proxy-status`. It reports whether the proxy is running, the configured port, the active listening port, and active/expired registered playback entries.

Settings also exposes a LocalProxy port check backed by `POST /api/player/proxy-port-check`. It attempts a temporary `127.0.0.1` listen on the configured port and reports `available`, `port-in-use`, or `permission-denied` without scanning external addresses.

Settings exposes a LocalProxy Range self-test backed by `POST /api/player/proxy-range-self-test`. The backend creates a temporary localhost upstream, registers it through LocalProxy, requests `Range: bytes=10-29`, and verifies `206 Partial Content`, `Content-Range`, and body length. This gives a deterministic local Range proof without depending on third-party media hosts.

## Packaging Checklist

- `server/**` must stay in `build.files` so Electron asar includes TVBox, player, desktop, and proxy modules.
- `tools/catvod-bridge/**` and `docs/**` are packaged as `extraResources` so the installed app exposes the local bridge template and operator documentation outside `app.asar`.
- `tools/catvod-runtime-bridge-java/**` is packaged as `extraResources` without generated `build` or `dist` outputs.
- Packaged smoke tests must hit the unpacked exe, not only `npm run dev`.
- User settings must remain in `userData/runtime`, not inside the installed app directory.
