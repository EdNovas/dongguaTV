# Handoff: DongguaTV TVBox real subscription end-to-end validation

- Task ID: `tvbox-real-subscription-e2e`
- Updated: 2026-06-18T22:36:30Z
- Status: active

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

## Desktop Localization Checkpoint

- Simplified Chinese is now the default language for the main desktop navigation and primary Apple TV surfaces.
- Settings includes a persisted selector for Simplified Chinese, English, and Japanese.
- `npm run test:localization-ui` verifies all three languages against the live local app and restores Simplified Chinese after the test.
- Next visual action: keep the preview open and revise layout, size, color, and menu ordering from direct user feedback.
- Follow-up interaction repair completed: Settings, Subscriptions, Live, first-run guide, and playback detail now expose explicit Back actions.
- The incorrect Settings copy-to-control mapping was fixed: `hideRandomRow` is labeled as hiding random recommendations, and `filterNsfw` is labeled as adult-content filtering.
- Subscription loading no longer pre-populates a failure message; refresh, save, detection, and proxy actions now show immediate progress/result feedback.
- `npm run test:localization-ui` now performs click-level regression checks, not only static text checks.
