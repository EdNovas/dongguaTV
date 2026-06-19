# Evidence: DongguaTV TVBox real subscription end-to-end validation

## Evidence Log

| Time | Command or check | Exit/status | Result or artifact |
|---|---|---|---|
| 2026-06-18T22:36:30Z | Artifact initialization | pass | `.codex/task-state/tvbox-real-subscription-e2e/` |
| 2026-06-19T00:00:00Z | `python D:\CodexWorks\scripts\codex_second_brain_preflight.py "DongguaTV TVBox real subscription end to end search detail resolve LocalProxy mpv" --limit 8` | pass | Reconfirmed temp `DONGGUATV_DATA_DIR` workflow, packaged desktop rebuild memory, and real-time verification requirement |
| 2026-06-19T00:00:00Z | `git status --short`; `git branch --show-current`; `git log -n 5 --oneline` | pass | Worktree clean, branch `feature/windows-appletv-tvbox-mpc`, head `4470288` |
| 2026-06-19T00:00:00Z | Installer and package metadata spot-check | pass | `dist-desktop/DongguaTV Enhanced Setup 1.0.54.exe` exists; `package.json` scripts include `test:tvbox-parser`, `test:player-stack`, `test:playback-ui`, `build`, `dist` |
| 2026-06-19T00:00:00Z | Candidate subscription HTTP probe with `curl.exe` | pass with drift | `https://www.yingm.cc/dm/dm.json` returned JSON; `https://pastebin.com/raw/gtbKvnE1` returned plain TVBox JSON; `https://raw.githubusercontent.com/yoursmile66/TVBox/main/XC.json` returned encoded payload; `http://www.饭太硬.net/tv` and `https://www.iyouhun.com/tv/dc` returned HTML/homepage-style responses instead of direct TVBox configs in this session |
| 2026-06-19T00:00:00Z | Isolated runtime startup | pass | App launched on `http://127.0.0.1:31386` with `DONGGUATV_DATA_DIR=D:\CodexWorks\tmp\dongguatv-e2e-20260619\runtime`; runtime image cache confirmed under temp path |
| 2026-06-19T00:00:00Z | `PATCH /api/player/settings`; `POST /api/player/validate-mpv`; `POST /api/player/proxy-port-check` | pass | Temporary player settings saved with `D:\DELL\mpvnet\mpvnet.exe`; mpv validation passed; proxy port `9979` available |
| 2026-06-19T00:00:00Z | Import representative subscription `https://www.yingm.cc/dm/dm.json` | pass | 27 sources imported; all classified `plugin-required`; 20 parses; no live channels |
| 2026-06-19T00:00:00Z | Import representative subscription `https://pastebin.com/raw/gtbKvnE1` | pass | 21 sources imported; all classified `partial/basic` HTTP-ready candidates; 51 parses; no live channels |
| 2026-06-19T00:00:00Z | Import representative subscription `https://raw.githubusercontent.com/yoursmile66/TVBox/main/XC.json` | pass | Encoded payload decoded successfully; 75 plugin-required sources, 1198 live channels, 7 parses |
| 2026-06-19T00:00:00Z | `GET /api/search/diagnostics` after imports | pass | Search layer now reports 19 compatible TVBox HTTP search sources and 102 plugin-required sources |
| 2026-06-19T00:00:00Z | AppleCMS source search sweep | mixed | `量子资源(切)` returned search results for `哪吒`, `斗罗大陆`, and `长安的荔枝`; `FOX资源(切)` and `樱花资源(切)` returned zero results for sampled titles in this session |
| 2026-06-19T00:00:00Z | Detail fetch for `量子资源(切)` | pass with source drift | `长安的荔枝电影版` detail resolved but sampled direct `m3u8` was upstream `404`; switching to `莲花童子哪吒[电影解说]` produced a direct `m3u8` that returned HTTP `200` |
| 2026-06-19T00:00:00Z | Real playback chain via `量子资源(切)` -> `莲花童子哪吒[电影解说]` | pass | `/api/player/classify` recommended `mpv`; `/api/player/diagnose` passed; `/api/player/proxy-url` returned `http://127.0.0.1:9979/play/...`; proxied playlist preview returned `#EXTM3U` with nested `127.0.0.1:9979/play/...` rewrite; `/api/player/open-mpv` returned success; running `mpvnet.exe` command line contained the LocalProxy URL rather than the raw source URL |
| 2026-06-19T00:00:00Z | Plugin-required diagnostics | pass | Sampled `次元城` and `Tg豆瓣` both returned `plugin-runtime-required` with stub Java bridge guidance; no subscription-provided jar was executed |
| 2026-06-19T00:00:00Z | Live channel sampling from encoded subscription | pass with mixed reachability | `GET /api/live/channels?group=央视&limit=3` returned channels; sampled live URLs returned HTTP `200`, `000`, and `200` respectively, proving list parsing works while endpoint reachability varies per line |
| 2026-06-19T00:00:00Z | Expanded AppleCMS HTTP-ready sweep across 8 sources | mixed | `量子资源` remained searchable and healthy; `光速资源` and `新浪资源` also returned live search results for current titles; `FOX`, `番茄`, `樱花`, and `酷点` stayed searchable-in-config but returned zero hits for sampled titles; `卧龙`, `神速`, and `想看` showed health-check errors in this session |
| 2026-06-19T00:00:00Z | Additional HTTP source probe for `光速资源(切)` and `新浪资源(切)` | pass | `长安的荔枝` and `庆余年 第二季` were searchable; sampled play entries returned HTTP `200`; detail previews exposed paired `play/...` and `play/.../index.m3u8` URLs |
| 2026-06-19T00:00:00Z | Live playback chain via `CCTV1` sample from encoded subscription | pass | `/api/player/classify` recommended `mpv` for live HLS under current settings; `/api/player/proxy-url` returned `127.0.0.1:9979/play/...`; proxied playlist preview returned `#EXTM3U` with rewritten nested proxy segment URLs; `/api/player/open-mpv` returned success; running `mpvnet.exe` command line contained the LocalProxy live URL |
| 2026-06-19T00:00:00Z | Added reusable QA script `tools/test-tvbox-real-qa.js` and package script `test:tvbox-real-qa` | pass | Script reads external config only, launches isolated runtime, imports subscriptions, samples HTTP/live playback, verifies proxy and optional mpv launch, then writes a JSON report without hardcoding third-party sources into the repo |
| 2026-06-19T00:00:00Z | `node --check tools/test-tvbox-real-qa.js`; `npm.cmd run test:tvbox-real-qa`; `npm.cmd run build` | pass | Real QA report generated at `D:\CodexWorks\tmp\dongguatv-e2e-script-20260619\artifacts\tvbox-real-qa-report.json`; report covered 3 representative subscriptions, 3 HTTP samples, and 1 live playback chain; build check remained green |
| 2026-06-19T00:00:00Z | Extended QA runner with automatic HTTP source scan and ranking mode | pass | Runner now supports `autoScanHttpSources` per subscription, scoring HTTP candidates by health, search hit, and playback probe result, then emitting a ranked report |
| 2026-06-19T00:00:00Z | `npm.cmd run test:tvbox-real-qa` with `autoScanHttpSources` enabled for Pastebin AppleCMS sample | pass | Ranked scan covered 19 searchable HTTP candidates; summary: `http-ready=2`, `searchable-no-live-play-url=2`, `no-hit=7`, `health-error=8`; top verified sources were `光速资源(切)` and `新浪资源(切)` with HTTP `200` probe pairs |
| 2026-06-19T00:00:00Z | `npm.cmd run build` after ranking-mode update | pass | Syntax/build check remained green after adding batch scan mode |

## Changed Files

- `.codex/task-state/tvbox-real-subscription-e2e/task.md`
- `.codex/task-state/tvbox-real-subscription-e2e/evidence.md`
- `.codex/task-state/tvbox-real-subscription-e2e/handoff.md`
- `package.json`
- `tools/test-tvbox-real-qa.js`

## Known Gaps

- Only 3 representative subscriptions were validated in this phase; broader source coverage remains pending.
- Live-channel parsing and one live `mpv` playback chain are proven, but only a small sample was exercised.
- Sampled AppleCMS sources show mixed current availability; broader per-source health mapping remains pending.
- The reusable QA script currently depends on an external config file or environment variable; no in-repo sample config is kept by design because third-party subscription URLs must not be hardcoded.
- The new batch ranking mode currently scans only HTTP-ready candidates filtered by existing support/status flags; plugin-required sources remain intentionally excluded from this ranking table.
