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
- Supporting artifacts:
- `evidence.md`
- Temp logs under `D:\CodexWorks\tmp\dongguatv-e2e-20260619\artifacts`
- Known gaps:
- No new `npm run build` or packaged `dist` rerun yet in this relay phase because no business-code change landed.
- `npm run build` was rerun and passed after adding the QA runner.
- A reusable automation script now exists, but it still relies on externally supplied subscription config by design.

## Retest

- Re-run:
- Run `npm run test:tvbox-real-qa` with a fresh external config file, then inspect the emitted JSON report under the configured artifact directory.
- Expected result:
- Plugin-required sources remain identified without execution; sampled HTTP and live sources are summarized into one JSON report; optional mpv smoke opens are cleaned up automatically.

## Final Summary

- Evidence checkpoint recorded. Functional relay validation now includes a reusable QA runner plus verified HTTP-ready, live, and plugin-required samples. Final acceptance is still pending broader source coverage and any additional ranking or packaging work we decide to add.
