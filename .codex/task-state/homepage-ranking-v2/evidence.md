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
