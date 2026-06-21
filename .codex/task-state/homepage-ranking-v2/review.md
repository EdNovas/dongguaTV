# Human Review Card: DongguaTV 首页榜单分层聚合与预览验收

- Task ID: `homepage-ranking-v2`
- Updated: 2026-06-21T06:23:29Z
- Verdict: ready for user review
- Change type: code-change

## Decision Surface

- Intended files: homepage endpoint, ranking adapter, homepage UI, focused tests
- Actual files: see `evidence.md`
- Commands passed: focused homepage, localization, parser, player, playback, build, and dist checks
- External acceptance: compared against the user-opened Ouge/TVBox homepage via `D:\CodexWorks\tmp\ouge-tvbox-home.png`
- Residual risks: Douban public metadata availability; plugin-required source runtime remains separate
- Reviewer action required: refresh `http://127.0.0.1:31386/` and inspect the first homepage row
- Rollback: see `transaction.json`

## Verification Evidence

- Automated checks: all listed in `evidence.md`
- Manual checks: visual comparison of Ouge target and Donggua preview
- Supporting artifacts: `D:\CodexWorks\tmp\ouge-tvbox-home.png`, `D:\CodexWorks\tmp\donggua-home-ranking-preview.png`
- Known gaps: see `evidence.md`

## Retest

- Re-run: `npm run test:homepage-ranking-ui`
- Expected result: mode `douban-source`, no blocked short-drama titles, at least five loaded posters, Douban card routes to title search

## Final Summary

- Homepage selection now follows a TVBox-like independent hot-list model. Douban supplies current visible metadata; the user's configured TVBox/native sources remain the only path to detail and playback.
