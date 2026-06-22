# Evidence: DongguaTV 首页榜单分层聚合与预览验收

## Evidence Log

| Time | Command or check | Exit/status | Result or artifact |
|---|---|---|---|
| 2026-06-21T06:23:29Z | Artifact initialization | pass | `.codex/task-state/homepage-ranking-v2/` |
| 2026-06-21 | Preview data audit | pass | `D:\CodexWorks\tmp\donggua-preview-31386` had 0 subscriptions, 0 sources, and no manual home list; the preview therefore could only use fallback data. |
| 2026-06-21 | Code-path audit | pass | Homepage endpoint selected built-in sites before TVBox sites, scanned sequentially, while the frontend aborted after 3 seconds and treated any non-empty source row as an all-page success. |
| 2026-06-21 | Existing focused tests | partial pass | Ranking and endpoint tests passed; UI test could not connect because preview service was not running. |
| 2026-06-21 | Ouge/TVBox visible reference | pass | `D:\CodexWorks\tmp\ouge-tvbox-home.png` showed a `豆瓣热播` homepage with titles including `莫离`, `镖人：风起大漠`, `南部档案`, `爱情有烟火`, and `主角`. |
| 2026-06-21 | Data-source diagnosis | pass | Responsive ordinary MacCMS latest-list sources returned mostly cold/latest inventory; the Ouge result was reproduced by Douban recent-hot metadata rather than by reweighting MacCMS latest pages. |
| 2026-06-21 | Real preview endpoint | pass | `http://127.0.0.1:31386/api/recommendations/tvbox-home` returned mode `douban-source`, 24 movie, 24 series, and 24 variety metadata items; TVBox/native source scan remained enabled. |
| 2026-06-21 | Visible homepage QA | pass | `D:\CodexWorks\tmp\donggua-home-ranking-preview.png` shows posters and titles including `爱情有烟火`, `玩具总动员5`, `南部档案`, `抓特务`, `莫离`, `调音师`, and `低智商犯罪`. |
| 2026-06-21 | Douban card routing | pass | UI QA verified a Douban card routes `爱情有烟火` to `autoSearch("爱情有烟火", "爱情有烟火")`, so playback still comes from user-configured sources. |
| 2026-06-21 | Restricted poster proxy | pass | A real Douban poster returned HTTP 200 JPEG; a localhost URL was rejected with HTTP 400. Proxy accepts only HTTPS `doubanio.com` hosts. |
| 2026-06-21 | Focused automated tests | pass | `test:douban-home-provider`, `test:tvbox-home-ranking`, `test:tvbox-home-endpoint`, `test:newest-order-ui`, `test:homepage-ranking-ui`, `test:localization-ui`, `test:tvbox-parser`, `test:player-stack`, and `test:playback-ui`. |
| 2026-06-21 | Build | pass | `npm run build`. |
| 2026-06-21 | Windows packaging | pass | `npm run dist`; `D:\CodexWorks\dongguaTV-enhanced-app\dist-desktop\DongguaTV Enhanced Setup 1.0.54.exe`, 84,988,913 bytes. |
| 2026-06-21 | User-visible stale preview diagnosis | fixed | The preview server had stopped, leaving an offline Service Worker page that still showed old TMDB rows. A separate startup bug also skipped `fetchAllLists()` when no TMDB key was configured. |
| 2026-06-21 | Natural startup regression | pass | `test:homepage-ranking-ui` now uses fresh browser data and no longer manually calls `fetchAllLists`; it verifies `douban-source` loads naturally without a TMDB key and the startup overlay is hidden. |
| 2026-06-21 | Live browser acceptance | pass | Current visible tab at `http://127.0.0.1:31386/?refresh=v30-final` contains `爱情有烟火`, `南部档案`, and `莫离`; the old `凡人修仙传`/`仙逆` pair is absent from the homepage snapshot. |

## Changed Files

- `server.js`
- `server/adapters/douban/homeProvider.js`
- `server/adapters/tvbox/recommendationRanker.js`
- `public/index.html`
- `package.json`
- `tools/test-douban-home-provider.js`
- `tools/test-homepage-ranking-ui.js`
- `tools/test-tvbox-home-endpoint.js`
- `tools/test-newest-order-ui.js`
- `tools/test-localization-ui.js`

## Known Gaps

- Douban is metadata only and may be temporarily unavailable or change its public mobile API; the application falls back to compatible user source rows and existing fallback data.
- Plugin-required TVBox sources remain identified but are not executed without the separate CatVod runtime bridge.
- The installer still uses the default Electron icon; this pre-existing packaging warning is outside the homepage ranking change.

## Full Category Loading Checkpoint

- All 20 homepage rows now have independent Douban-backed metadata.
- Live verification returned 1,757 row items with no empty category.
- Movie genre rows returned 98-100 items; US returned 50, KR/JP 57, anime 68 after source merging, and variety 37 after source merging.
- The visible preview has no loading rows. Expanded pagination reports domestic 4 pages, US 3, KR/JP 3, anime 4, most movie genres 5, and variety 2 because its available list is smaller.
- Each row retains up to 100 items for expanded pagination while collapsed rails render only the first 20 cards.
- Regression checks passed: `test:douban-home-provider`, `test:tvbox-home-endpoint`, `test:homepage-ranking-ui`, `test:localization-ui`, and `npm run build`.
- Screenshot: `D:\CodexWorks\tmp\donggua-home-ranking-preview.png`.

## 2026-06-22 Incomplete Cache Recovery

- Root cause reproduced: transient Douban category failures could produce empty rows, and the incomplete aggregate was cached for 1,800 seconds.
- Fix: failed or empty category requests retry once after a short delay.
- Fix: a Douban homepage is marked complete only when all 20 rows contain items.
- Fix: incomplete aggregates are not cached; the server uses the last complete aggregate when one is available.
- Cache namespace advanced from `v6` to `v7` so previously incomplete cached data is ignored.
- Provider regression simulated first-attempt failures for `tv_domestic` and `actionRow`; both recovered and all 20 rows remained non-empty.
- Live endpoint verification returned mode `douban`, `douban.complete=true`, 1,714 total items, and no empty rows. The second request was a valid cache hit.
- UI verification passed with 800 rendered cards, 250 loaded posters, and 2-5 pages per category.
- Playback UI verification passed through LocalProxy and launched `D:\DELL\mpvnet\mpvnet.exe`.
- Screenshots:
  - `D:\CodexWorks\tmp\donggua-home-ranking-preview.png`
  - `D:\CodexWorks\tmp\playback-ui-qa.png`
- Passed commands:
  - `npm run test:douban-home-provider`
  - `npm run test:homepage-ranking-ui`
  - `npm run test:localization-ui`
  - `npm run test:playback-ui`
  - `npm run test:tvbox-parser`
  - `npm run test:player-stack`
  - `npm run test:plugin-bridge-search`
  - `npm run test:java-bridge-reflect`
  - `npm run test:java-bridge-self-test-api`
  - `npm run bridge:catvod:check`
  - `npm run build`
