# Phase 1 Project Health Report

Date: 2026-06-06
Branch: `feature/windows-appletv-tvbox-mpc`
Workspace: `D:\CodexWorks\dongguaTV-enhanced-app`

## Summary

Current DongguaTV Enhanced is a Node/Express app serving one large static Vue 3 page from `public/index.html`. It is not currently a Vite, Next, React, or componentized Vue project.

The Windows desktop app is an Electron wrapper around the Express server. The wrapper starts the local server, stores runtime files under Electron `userData`, and opens a Chromium window pointed at `http://127.0.0.1:<port>`.

This is a viable Windows 10 desktop base, but the requested Apple TV UI, TVBox subscription management, MPC player integration, and LocalProxy need phased changes. A direct rewrite of `public/index.html` is risky because search, details, playback, TV mode, DPlayer customization, history sync, and settings logic all live in that one file.

## Technology Stack

- Runtime: Node.js
- Backend: Express 4
- Frontend: Vue 3 loaded by local static script
- Player: DPlayer + HLS.js
- Desktop: Electron 32
- Desktop packaging: electron-builder 26, NSIS
- Android shell: Capacitor project under `android/`
- Storage: JSON, optional SQLite through `better-sqlite3`, memory cache

Not present:

- No `src/` frontend source tree
- No Vite build pipeline
- No React
- No Next.js
- No Koa
- No frontend router package

## Package Scripts

From `package.json`:

- `npm run start`: `node server.js`
- `npm run dev`: `node server.js`
- `npm run desktop`: `electron .`
- `npm run dist:desktop`: `electron-builder --win`

There is no separate `npm run build` script because the frontend is currently static HTML/CSS/JS.

## Entrypoints

- Electron main process: `main.js`
- Backend server: `server.js`
- Frontend page: `public/index.html`
- Vercel bridge: `api/index.js`
- Desktop helper: `start-desktop.bat`
- Desktop notes: `LOCAL_DESKTOP.md`

## Current Page Structure

The current UI is implemented inside `public/index.html`:

- CSS: large inline `<style>` block
- Vue app: inline script using `createApp`
- Home/search/player/detail UI: same file
- Settings modal: same file
- TV mode logic: same file
- DPlayer styling and behavior hooks: same file

There are no standalone page components for Home, Search, Details, Subscriptions, Player Settings, or Live TV.

## Source Configuration

Current source configuration is loaded by `server.js` from:

- Desktop/runtime: `%APPDATA%\DongguaTV Enhanced\runtime\db.json`
- Non-desktop fallback: project `db.json`
- Template: `db.template.json`
- Optional remote config: `REMOTE_DB_URL`

Primary source API:

- `GET /api/sites`

Current expected site shape:

```json
{
  "key": "example",
  "name": "Example",
  "api": "https://example.com/api.php/provide/vod",
  "active": true
}
```

## Backend API Hotspots

Important routes in `server.js`:

- `GET /api/config`
- `GET /api/sites`
- `GET /api/search`
- `POST /api/search`
- `GET /api/detail`
- `POST /api/detail`
- `GET /api/m3u8-proxy`
- `GET /api/tmdb-proxy`
- `GET /api/tmdb-image/:size/:filename`
- `GET /api/auth/check`
- `POST /api/auth/verify`
- `GET /api/history/pull`
- `POST /api/history/push`
- `POST /api/history/clear`

## Existing Playback Logic

Playback is currently frontend-driven in `public/index.html`.

Key concepts:

- `DPlayer` and `HLS.js` are loaded locally from `public/libs/js`.
- Episode data is parsed from `vod_play_url`.
- `switchSource(source)` loads detail data and parses episodes.
- `parseEpisodes(...)` selects playable entries.
- `play(url)` initializes or switches DPlayer playback.
- Source latency testing prefers direct playback when possible and may use configured CORS proxy as fallback.
- `/api/m3u8-proxy` exists, but it is not a full MPC-oriented LocalProxy with Range support.

## Electron Desktop Baseline

`main.js` currently:

- Disables GPU paths for Windows compatibility.
- Finds an available local port starting from `PORT` or `3000`.
- Sets `DONGGUATV_DATA_DIR` to Electron userData runtime folder.
- Loads `.env` from runtime folder, creating it on first run.
- Requires `server.js`.
- Opens a BrowserWindow pointed to `http://127.0.0.1:<port>`.
- Uses Enter for fullscreen and Escape to exit fullscreen.

Runtime data location:

```text
%APPDATA%\DongguaTV Enhanced\runtime
```

## Packaging Configuration

`package.json` contains electron-builder config:

- App ID: `com.donggua.tv.enhanced`
- Product name: `DongguaTV Enhanced`
- Output: `dist-desktop`
- Windows target: `nsis`
- Packaged files include `public`, `server.js`, `main.js`, `proxy-server.js`, `db.template.json`, `.env.example`, and `node_modules`.

## Verification Results

Commands run during Phase 1:

```powershell
npm.cmd install
node --check server.js
node --check main.js
$env:PORT='3100'; node server.js
npx.cmd electron-builder --win --config.directories.output=dist-desktop-check
```

Results:

- `npm.cmd install`: passed
- `node --check server.js`: passed
- `node --check main.js`: passed
- Dev server on port `3100`: passed
  - `/`: HTTP 200
  - `/api/config`: HTTP 200
- Electron build check to `dist-desktop-check`: passed
  - `better-sqlite3` Electron rebuild succeeded
  - NSIS installer built successfully

Note: port `3000` was already occupied by a running packaged app process:

```text
DongguaTV Enhanced.exe
```

The dev validation used port `3100` to avoid interrupting that running app.

## Modified Files In Current Baseline

Already modified before this report:

- `package.json`
- `package-lock.json`
- `server.js`

Added before this report:

- `main.js`
- `start-desktop.bat`
- `LOCAL_DESKTOP.md`

Modified in Phase 1:

- `.gitignore`
- `docs/PHASE_1_PROJECT_HEALTH_REPORT.md`

## Likely Files To Modify In Later Phases

Phase 2 UI:

- `public/index.html`
- optional `public/styles/apple-tv.css`
- optional `public/js/apple-tv-shell.js`

Phase 3 TVBox subscriptions:

- `server/adapters/tvbox/tvboxParser.js`
- `server/adapters/tvbox/tvboxNormalizer.js`
- `server/stores/subscriptionStore.js`
- `server/stores/sourceStore.js`
- `server/stores/liveStore.js`
- `server.js` for API mounting
- `public/index.html` for subscription manager UI

Phase 4 player integration:

- `server/player/playerManager.js`
- `server/player/mpcPlayer.js`
- `server/player/playUrlClassifier.js`
- `server/stores/playerSettingsStore.js`
- `main.js` if IPC is needed
- `public/index.html` for player settings and MPC actions

Phase 5 LocalProxy:

- `server/player/localProxy.js`
- `server/player/playerManager.js`
- `server.js` for API mounting

## Files To Keep Read-Only Unless Needed

- `android/**` during Windows desktop phases
- `public/libs/**` third-party vendor assets
- `cloudflare-cors-proxy.js`
- `cloudflare-tmdb-proxy.js`
- `proxy-server.js` unless proxy behavior is consolidated
- `api/index.js` unless Vercel behavior must mirror new backend APIs

## Risk Register

1. `public/index.html` is too large and contains many responsibilities.
   - Risk: UI changes can break playback, history, TV mode, or search.
   - Mitigation: add new views incrementally and keep existing methods intact.

2. TVBox `csp_`, `spider.jar`, JS, Python, and DRPY sources are not simple HTTP APIs.
   - Risk: executing them directly is unsafe and brittle.
   - Mitigation: first import as `plugin-required` metadata only.

3. MPC external playback needs careful argument handling.
   - Risk: URL tokens and special characters break command execution.
   - Mitigation: use `spawn` with `shell:false` and URL as its own argument.

4. LocalProxy must support Range correctly.
   - Risk: MPC seeking fails if `206`, `Content-Range`, and `Accept-Ranges` are wrong.
   - Mitigation: implement Range tests before enabling as default for MPC.

5. Packaged app must not write into app install directory.
   - Current status: runtime data already moved to userData via `DONGGUATV_DATA_DIR`.

## Recommended Phase Plan

Phase 2 should not start with a full frontend rewrite. Recommended safe sequence:

1. Add an Apple TV shell layout in the current `public/index.html`.
2. Add side navigation and view state while keeping existing search/detail/player DOM available.
3. Move settings into clearer panels.
4. Only after behavior is stable, extract modules or migrate to a build-based frontend.

Phase 3 should add TVBox subscription storage and APIs before UI polish:

1. Parser and normalizer modules.
2. JSON stores under userData/runtime.
3. Preview/import APIs.
4. Subscription manager UI.

Phase 4 should add MPC settings and direct external playback before LocalProxy:

1. Detect common MPC paths.
2. Save player settings.
3. Open direct URL with MPC.
4. Add classifier and recommendation labels.

Phase 5 should add full LocalProxy:

1. Local-only listener.
2. Play ID registry with expiry.
3. Range forwarding.
4. Header forwarding.
5. m3u8 rewrite as an incremental follow-up.
