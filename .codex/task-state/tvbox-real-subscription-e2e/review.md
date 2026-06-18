# Human Review Card: DongguaTV TVBox real subscription end-to-end validation

- Task ID: `tvbox-real-subscription-e2e`
- Updated: 2026-06-18T22:36:30Z
- Verdict: pending
- Change type: review-only

## Decision Surface

- Intended files:
- `.codex/task-state/tvbox-real-subscription-e2e/task.md`
- `.codex/task-state/tvbox-real-subscription-e2e/evidence.md`
- `.codex/task-state/tvbox-real-subscription-e2e/handoff.md`
- `.codex/task-state/tvbox-real-subscription-e2e/review.md`
- Actual files:
- `.codex/task-state/tvbox-real-subscription-e2e/task.md`
- `.codex/task-state/tvbox-real-subscription-e2e/evidence.md`
- `.codex/task-state/tvbox-real-subscription-e2e/handoff.md`
- `.codex/task-state/tvbox-real-subscription-e2e/review.md`
- Commands passed:
- Preflight helper for DongguaTV relay validation
- Temp-runtime API checks on `31386`
- Representative subscription imports
- Search, detail, proxy, and mpv launch checks
- External acceptance: unavailable
- Residual risks:
- Real third-party play URLs can expire between search/detail and playback.
- Broader live playback and broader HTTP-source coverage were not completed in this checkpoint.
- Reviewer action required: inspect source artifacts, diff, and evidence
- Rollback: see `transaction.json`

## Verification Evidence

- Automated checks:
- Runtime API validation for player settings, subscription imports, search diagnostics, source diagnostics, detail fetches, proxy creation, and mpv launch.
- Manual checks:
- Verified representative subscription classification and sampled live reachability.
- Supporting artifacts:
- `evidence.md`
- Temp logs under `D:\CodexWorks\tmp\dongguatv-e2e-20260619\artifacts`
- Known gaps:
- No new `npm run build` or packaged `dist` rerun yet in this relay phase because no business-code change landed.

## Retest

- Re-run:
- Restart isolated runtime on `31386`, reimport the 3 representative subscriptions, then repeat the `量子资源` playback chain against a freshly confirmed `200` play URL.
- Expected result:
- Plugin-required sources remain identified without execution; at least one HTTP-ready source completes proxy + mpv launch again.

## Final Summary

- Evidence checkpoint recorded. Functional relay validation succeeded for one real HTTP-ready playback chain and two plugin-required comparison subscriptions. Final acceptance is still pending broader coverage and final regression/commit confirmation.
