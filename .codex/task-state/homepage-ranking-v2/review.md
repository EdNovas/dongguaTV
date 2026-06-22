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
## 2026-06-21 Full Category Loading Review

- Intended scope: eliminate permanently loading homepage categories and expose substantially more content per category.
- Actual files: `server/adapters/douban/homeProvider.js`, `server.js`, `public/index.html`, `public/sw.js`, and focused tests.
- Acceptance proof: all 20 rows non-empty in live browser QA; representative expanded rows show 3-5 pages; collapsed rows render only 20 cards for performance.
- Verification: provider test, endpoint test, homepage UI test, localization UI test, build, and Windows NSIS packaging all passed.
- Residual risk: public metadata endpoints may change or temporarily throttle; existing fallback behavior remains available.
- Reviewer action: inspect the visible preview at `http://127.0.0.1:31386/`, especially US, KR/JP, anime, and one movie genre expanded view.

## 2026-06-22 Reliability Review

- Intended scope: prevent temporary metadata failures from leaving homepage categories empty for 30 minutes.
- Actual code files: `server/adapters/douban/homeProvider.js`, `server.js`, and `tools/test-douban-home-provider.js`.
- Acceptance proof: two simulated category failures recover on retry; live endpoint returns no empty rows; homepage UI, localization UI, and playback UI pass sequentially.
- Residual risk: repeated upstream failure can still return a partial uncached response when no previous complete response exists, but the next refresh retries instead of preserving the failure.
- Reviewer action: refresh the visible preview and expand several rows to confirm the content selection is acceptable.
- Packaging acceptance: `npm run dist` passed and produced the updated NSIS installer.
- Visible acceptance: the in-app browser shows the Chinese Apple TV-style homepage with loaded hero and category navigation; screenshot saved at `D:\CodexWorks\tmp\donggua-final-visible-preview.png`.
