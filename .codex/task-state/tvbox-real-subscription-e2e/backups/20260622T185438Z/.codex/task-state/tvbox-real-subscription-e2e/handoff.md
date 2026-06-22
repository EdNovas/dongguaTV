# Handoff: DongguaTV TVBox real subscription end-to-end validation

- Task ID: `tvbox-real-subscription-e2e`
- Updated: 2026-06-18T22:36:30Z
- Status: completed

## Current State

- Task artifacts initialized.
- Preflight, branch, clean worktree, stable commit, installer presence, and test commands have been revalidated in the relay thread.
- An isolated runtime is active on `127.0.0.1:31386` with temp data under `D:\CodexWorks\tmp\dongguatv-e2e-20260619\runtime`.
- Representative subscription matrix for this session:
- `动漫城`: 27 plugin-required sources, no lives, no direct plugin execution.
- `Pastebin 苹果CMS`: 21 basic HTTP-ready sources; `量子资源(切)` verified through search, detail, LocalProxy, and mpv.
- `南风编码配置`: encoded import decoded successfully; 75 plugin-required sources plus 1198 live channels.
- Expanded HTTP-ready findings:
- `量子资源`, `光速资源`, and `新浪资源` are the strongest currently verified HTTP-ready candidates from the sampled AppleCMS set.
- `FOX`, `番茄`, `樱花`, and `酷点` stayed importable but returned zero sampled search hits in this session.
- `卧龙`, `神速`, and `想看` produced health-check errors in this session.
- Source drift observed in real time:
- `饭太硬` and `游魂多仓` did not present a directly importable TVBox config to the current probe path.
- `量子资源` search/detail works, but some returned play URLs are already upstream-expired and must be sampled live rather than assumed valid.
- Live stack status:
- One `CCTV1` live line from the encoded subscription completed `LocalProxy -> rewritten m3u8 -> mpv.net` verification successfully.
- Automation status:
- A reusable runner now exists at `tools/test-tvbox-real-qa.js`.
- `package.json` now exposes `npm run test:tvbox-real-qa`.
- The runner requires `--config <file>` or `TEST_TVBOX_QA_CONFIG` / `TEST_TVBOX_QA_JSON`; it intentionally does not embed subscription URLs in the repository.
- A verified external test config and report were produced under `D:\CodexWorks\tmp\dongguatv-e2e-script-20260619\artifacts`.
- Batch ranking status:
- The runner now supports `autoScanHttpSources` to scan all eligible HTTP-ready candidates inside one imported subscription.
- Latest ranked AppleCMS scan result: `19` sources scanned, with `2 http-ready`, `2 searchable-no-live-play-url`, `7 no-hit`, `8 health-error`.
- Current top pair from that ranked scan: `光速资源(切)` and `新浪资源(切)`.

## Exact Next Action

- Run focused regression checks and create a phase checkpoint commit for the evidence artifacts.
- If continuing the matrix, extend beyond the current 3 strongest HTTP candidates and capture a compact ranked availability table for all 21 AppleCMS-derived sources.
- Consider adding an export-friendly markdown or CSV summary mode on top of the new ranking output so non-technical review is easier.

## Blockers

- None recorded.

## 2026-06-22 Completion Checkpoint

- The Subscriptions page now exposes a user-visible source availability scan instead of requiring engineering-only JSON reports.
- Current live matrix covered all 35 enabled HTTP-compatible sources in the preview runtime and kept 132 plugin-required sources isolated.
- Seven sources completed current search, detail, and playback-address reachability for the sample title.
- Results are deliberately time-stamped because third-party source health can drift between scans.
- Exact next action: user review of the source scan presentation and wording at `http://127.0.0.1:31386/`.
- Updated NSIS installer was generated successfully after the feature commit.

## Changed Files

- `.codex/task-state/tvbox-real-subscription-e2e/task.md`
- `.codex/task-state/tvbox-real-subscription-e2e/evidence.md`
- `.codex/task-state/tvbox-real-subscription-e2e/handoff.md`

## Last Verified Evidence

- See `evidence.md`.

## Source Artifacts

- `task.md`
- `evidence.md`
- `transaction.json`

> This is a derived resume summary. Source files and fresh checks take precedence.

## Homepage Ranking Correction Checkpoint

- Updated: 2026-06-20T07:35:00Z
- User-visible issue: the newest-first homepage looked worse than TVBox/欧歌 because it promoted raw same-day metadata records with little or no audience signal.
- Current decision: default homepage ranking is hot/trending-first. The first rows are `热播推荐`, `热门电影`, and `热门剧集`; newest sorting remains implemented and tested for explicit date-first contexts.
- Evidence: live proxy comparison showed `primary_release_date.desc` returning near-zero-popularity, zero-vote obscure records, while `popularity.desc` and `trending/all/week` returned higher-signal items.
- Latest checks passed: `npm run test:newest-order-ui`, `npm run test:localization-ui`, `npm run test:tvbox-parser`, `npm run test:player-stack`, and `npm run build`.

## Desktop Localization Checkpoint

- Simplified Chinese is now the default language for the main desktop navigation and primary Apple TV surfaces.
- Settings includes a persisted selector for Simplified Chinese, English, and Japanese.
- `npm run test:localization-ui` verifies all three languages against the live local app and restores Simplified Chinese after the test.
- Next visual action: keep the preview open and revise layout, size, color, and menu ordering from direct user feedback.
- Follow-up interaction repair completed: Settings, Subscriptions, Live, first-run guide, and playback detail now expose explicit Back actions.
- The incorrect Settings copy-to-control mapping was fixed: `hideRandomRow` is labeled as hiding random recommendations, and `filterNsfw` is labeled as adult-content filtering.
- Subscription loading no longer pre-populates a failure message; refresh, save, detection, and proxy actions now show immediate progress/result feedback.
- `npm run test:localization-ui` now performs click-level regression checks, not only static text checks.
- Search diagnostics stale-English report was traced to Service Worker `v25` returning cached HTML. Cache version is now `v26`, and navigation HTML uses network-first behavior.
- The search diagnostics card now reuses `handleAppleNav` for Subscriptions and Settings, matching the working sidebar path.
- Modal Back buttons are fixed to the viewport so they remain visible on long settings content.
- All homepage resources now use newest-first ordering. The first three rails are `最近更新`, `最新电影`, and `最新剧集`; category rails, hero content, and search groups share the same date-priority rule.
- Cards display complete release/first-air dates instead of year-only labels.
- `npm run test:newest-order-ui`, `npm run test:localization-ui`, and `npm run build` pass.
- Visible browser verification checked all 20 loaded rails: 20 descending, 0 failures.
- Image-hidden TVBox configs are now decoded when they contain embedded FongMi Base64 or visible JSON. The user-provided image config imported successfully as `jpeg-image` / `fongmi-base64`, producing 48 plugin-required sites and 2880 live channels in isolated runtime testing.
- A live sample from that imported subscription (`浙江新闻`) completed `LiveChannel -> LocalProxy -> mpv.net` validation. API launch metadata now includes `pid` and `playerType`, which should make future playback diagnostics clearer for non-technical review.
- The Live panel now has per-channel health checks backed by `POST /api/live/probe`, with localized labels and Service Worker cache version `v27`. Real probes showed `浙江新闻` reachable and `CCTV1` timed out, so future UI should frame this as line drift rather than import failure.
