# Human Review Card: DongguaTV TVBox real subscription end-to-end validation

- Task ID: `tvbox-real-subscription-e2e`
- Updated: 2026-06-19T00:00:00Z
- Verdict: pending
- Change type: review-only

## Decision Surface

- Intended files:
- `.codex/task-state/tvbox-real-subscription-e2e/task.md`
- `.codex/task-state/tvbox-real-subscription-e2e/evidence.md`
- `.codex/task-state/tvbox-real-subscription-e2e/handoff.md`
- `.codex/task-state/tvbox-real-subscription-e2e/review.md`
- `package.json`
- `tools/test-tvbox-real-qa.js`
- Actual files:
- `.codex/task-state/tvbox-real-subscription-e2e/task.md`
- `.codex/task-state/tvbox-real-subscription-e2e/evidence.md`
- `.codex/task-state/tvbox-real-subscription-e2e/handoff.md`
- `.codex/task-state/tvbox-real-subscription-e2e/review.md`
- Commands passed:
- Preflight helper for DongguaTV relay validation
- Temp-runtime API checks on `31386`
- Representative subscription imports
- Expanded HTTP source sampling
- Search, detail, proxy, and mpv launch checks
- Reusable real-subscription QA runner implementation and execution
- Automatic HTTP candidate ranking mode implementation and execution
- External acceptance: unavailable
- Residual risks:
- Real third-party play URLs can expire between search/detail and playback.
- Broader all-source coverage was not completed in this checkpoint.
- Reviewer action required: inspect source artifacts, diff, and evidence
- Rollback: see `transaction.json`

## Verification Evidence

- Automated checks:
- Runtime API validation for player settings, subscription imports, search diagnostics, source diagnostics, detail fetches, proxy creation, and mpv launch.
- Manual checks:
- Verified representative subscription classification, expanded HTTP-ready sampling, sampled live reachability, and one live `LocalProxy -> mpv` playback chain.
- Verified the new QA runner produces a real report from external config and does not leave `31386`, `9979`, or `mpv.net` running afterward.
- Verified the ranking mode produces a usable top-list and outcome buckets across the eligible AppleCMS-derived HTTP candidates.
- Supporting artifacts:
- `evidence.md`
- Temp logs under `D:\CodexWorks\tmp\dongguatv-e2e-20260619\artifacts`
- Known gaps:
- No new `npm run build` or packaged `dist` rerun yet in this relay phase because no business-code change landed.
- `npm run build` was rerun and passed after adding the QA runner.
- A reusable automation script now exists, but it still relies on externally supplied subscription config by design.
- The ranking report is still JSON-first; there is not yet a compact markdown or CSV export for non-technical review.

## Retest

- Re-run:
- Run `npm run test:tvbox-real-qa` with a fresh external config file, then inspect the emitted JSON report under the configured artifact directory.
- Run `npm run test:tvbox-real-qa` with `autoScanHttpSources` configured, then inspect the ranked `httpScan` section inside the emitted JSON report.
- Expected result:
- Plugin-required sources remain identified without execution; sampled HTTP and live sources are summarized into one JSON report; optional mpv smoke opens are cleaned up automatically.
- Plugin-required sources remain identified without execution; sampled HTTP/live results and ranked HTTP candidate buckets are summarized into one JSON report; optional mpv smoke opens are cleaned up automatically.

## Final Summary

- Evidence checkpoint recorded. Functional relay validation now includes a reusable QA runner plus verified HTTP-ready, live, and plugin-required samples. Final acceptance is still pending broader source coverage and any additional ranking or packaging work we decide to add.
- Evidence checkpoint recorded. Functional relay validation now includes a reusable QA runner, verified HTTP-ready/live/plugin-required samples, and a ranked AppleCMS HTTP candidate scan. Final acceptance is still pending any output-polish or broader source-family expansion we decide to add.

## Desktop Localization Review

- Visible review: Simplified Chinese is the default; Simplified Chinese, English, and Japanese switch immediately in Settings.
- Automated review: `npm run test:localization-ui` passed for navigation, search, settings, HTML language, and persisted preference.
- Build review: `npm run build` passed after the localization change.
- Residual scope: secondary diagnostic and deeply nested operational strings can be localized incrementally during the next visual review.

## Interaction Repair Review

- Fixed a functional mismatch where two Settings switches displayed external-player/proxy descriptions while actually controlling random-row visibility and adult-content filtering.
- Fixed the false subscription failure message shown during normal loading.
- Added explicit Back actions to core modal/detail surfaces.
- Added visible action feedback and automated click checks for proxy status and subscription refresh.
- The in-app browser is intentionally left on the Subscriptions panel with the successful refresh state visible for human review.

## Search Diagnostics Cache Review

- Confirmed the user's English screenshot came from stale Service Worker HTML, not the current translation table.
- Advanced the cache to `v26` and switched HTML navigation to network-first.
- Reproduced `梦魔绝镇` and verified the complete no-result diagnostics view in Chinese.
- Verified Refresh, Subscriptions, Settings, panel Back, and Home interactions.

## Newest-First Ordering Review

- Replaced trending/random homepage ordering with a fixed newest-first policy.
- Mixed movie/series updates are fetched by release or first-air date, merged, deduplicated, and sorted.
- Search results preserve richer update date fields and group titles by their newest known source record.
- Full dates are visible under cards so ordering can be reviewed without developer tools.
- Automated checks passed: `npm run test:newest-order-ui`, `npm run test:localization-ui`, and `npm run build`.
- Human-visible browser check passed across all 20 loaded rows with no descending-order failures.
- Residual risk: third-party search APIs may omit or misreport update dates; these items are kept and placed after reliably dated items.

## TVBox Image Config Decode Review

- Fixed the user-visible import failure for compatible image-hidden TVBox configs that previously stopped at `Unsupported TVBox image config: jpeg-image`.
- The parser now detects image payloads and extracts embedded FongMi Base64 or visible JSON only when the decoded content looks like a TVBox config.
- Real API import of the user-provided image config succeeded in an isolated runtime: `48` sites, `2880` live channels, `48` plugin-required sources, and `0` unsupported entries.
- Safety boundary remains intact: plugin-required `csp_*` and spider sources are identified but not executed.
- Automated checks passed: `npm run test:tvbox-parser` and `npm run build`.

## FanTaiYing Live Playback Review

- Verified that imported live channels can move through `LiveChannel -> PlayUrlResult -> LocalProxy -> mpv.net`.
- A live `浙江新闻` sample returned a valid HLS playlist through `127.0.0.1:9979`, including local proxy rewrites for child segments.
- Added launch metadata to external-player APIs so future UI/debug output can show `mpv.net` plus the spawned process id.
- Automated checks passed: `npm run test:player-stack` and `npm run build`.
- Residual risk: live endpoints drift by provider; unreachable individual channels should be treated as line health issues, not import/parser failures.

## Live Channel Health Review

- Added a safe per-channel live probe API that reports availability without returning raw stream URLs or sensitive header values.
- Added localized Live panel health controls so users can tell whether a channel is available, timed out, or returned an HTTP error before blaming the app.
- Verified real mixed results from the imported `饭太硬` list: `浙江新闻` available, `CCTV1` timed out in this session.
- Service Worker cache was advanced to `v27` so the updated Live panel is not hidden behind stale cached HTML.
