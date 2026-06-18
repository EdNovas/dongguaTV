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
- Source drift observed in real time:
- `饭太硬` and `游魂多仓` did not present a directly importable TVBox config to the current probe path.
- `量子资源` search/detail works, but some returned play URLs are already upstream-expired and must be sampled live rather than assumed valid.

## Exact Next Action

- Run focused regression checks and create a phase checkpoint commit for the evidence artifacts.
- If continuing the matrix, expand AppleCMS coverage to a few more HTTP-ready sources and optionally sample one live channel through LocalProxy + mpv.

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
