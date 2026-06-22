# Evidence: DongguaTV trusted CatVod Bridge UX and diagnostics

## Evidence Log

| Time | Command or check | Exit/status | Result or artifact |
|---|---|---|---|
| 2026-06-22T07:44:43Z | Artifact initialization | pass | `.codex/task-state/trusted-catvod-bridge-ux/` |
| 2026-06-22 | `npm run test:plugin-source-diagnostics` | pass | Stopped, stub, reflect-ready, and external bridge states were distinguished correctly. |
| 2026-06-22 | `npm run test:plugin-bridge-search` | pass | Safe search/detail/probe path returned title-only results and exercised `search`, `detail`, `search`. |
| 2026-06-22 | `npm run build` | pass | Server, Electron main process, service worker, CatVod bridge, and Java supervisor syntax checks passed. |
| 2026-06-22 | `git diff --stat` | observed | 7 tracked files changed, 331 insertions, 47 deletions; one new focused test file and task-state directory are untracked. |
| 2026-06-22 | Relay checkpoint refresh | observed | `docs/CATVOD_BRIDGE.md` was subsequently updated by the existing Project 2 work; current diff is 8 tracked files, 343 insertions, 47 deletions. |
| 2026-06-22 | `npm run test:java-bridge-reflect` | pass | Trusted fake Spider search, detail, and play reflection passed on JDK 21. |
| 2026-06-22 | `npm run test:java-bridge-self-test-api` | pass | Local Reflect self-test API passed without subscription plugin execution. |
| 2026-06-22 | `npm run test:localization-ui` | pass | Chinese, English, and Japanese language switching passed. |
| 2026-06-22 | In-app browser QA at `http://127.0.0.1:31386/` | pass | 132 plugin sources showed Safe Search; stopped/stub diagnosis and missing-bridge error rendered in Chinese. |
| 2026-06-22 | Visual QA screenshot | pass | `D:\CodexWorks\tmp\donggua-catvod-safe-search-ui.png` |
| 2026-06-22 | `npm run test:tvbox-parser` | pass | Plain, Base64, AES-CBC, image Base64, and image diagnostics passed. |
| 2026-06-22 | `npm run test:player-stack` | pass | mpv args, classification, Range, HEAD, expiry, and HLS rewrite passed. |
| 2026-06-22 | `npm run test:homepage-ranking-ui` | pass | Homepage remained populated; 800 cards rendered and category pagination remained available. |
| 2026-06-22 | `npm run dist` | pass | `dist-desktop\DongguaTV Enhanced Setup 1.0.55.exe` |
| 2026-06-22 | Installer hash | pass | 84,996,744 bytes; SHA-256 `103F48D945E264B042056269A16788E828C8037BD6AA5008CA6378AF90AD43CD` |

## Changed Files

- `package.json`
- `package-lock.json`
- `docs/CATVOD_BRIDGE.md`
- `public/index.html`
- `public/sw.js`
- `server.js`
- `server/adapters/tvbox/index.js`
- `server/adapters/tvbox/pluginRuntime.js`
- `tools/test-plugin-bridge-search.js`
- `tools/test-plugin-source-diagnostics.js` (new)

## Known Gaps

- Real third-party CatVod compatibility still depends on a user-selected trusted
  Spider runtime. Unknown subscription-provided jar, py, js, and csp code remains
  intentionally unexecuted.
- The packaged application uses the default Electron icon because no dedicated
  Windows icon has been configured yet.
