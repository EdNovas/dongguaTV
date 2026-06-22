# Human Review Card: DongguaTV trusted CatVod Bridge UX and diagnostics

- Task ID: `trusted-catvod-bridge-ux`
- Updated: 2026-06-22
- Verdict: ready-for-human-review
- Change type: code-change

## Decision Surface

- Intended files: see `task.md`
- Actual files: see `evidence.md`
- Commands passed: parser, plugin diagnostics, bridge search, Java Reflect,
  self-test API, player stack, localization UI, homepage ranking UI, build, dist
- External acceptance: in-app browser UI verified with the real preview dataset
- Residual risks: individual third-party Spider compatibility is not guaranteed
- Reviewer action required: optionally inspect the visible Safe Search result in the Subscriptions panel
- Rollback: see `transaction.json`

## Verification Evidence

- Automated checks: all commands recorded in `evidence.md` passed.
- Manual checks: Safe Search button count, Chinese diagnostics, and localized
  missing-bridge error verified in the in-app browser.
- Supporting artifacts: `D:\CodexWorks\tmp\donggua-catvod-safe-search-ui.png`
- Known gaps: see `evidence.md`

## Retest

- Re-run: `npm run test:plugin-source-diagnostics`;
  `npm run test:plugin-bridge-search`; `npm run test:localization-ui`;
  `npm run build`
- Expected result: all commands exit 0 and safe probe responses remain title-only

## Final Summary

- Trusted CatVod plugin routes are accurately described and can be safely
  test-searched without exposing raw source or playback data.
