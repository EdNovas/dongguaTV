# Task: DongguaTV 首页榜单分层聚合与预览验收

- Task ID: `homepage-ranking-v2`
- Status: completed
- Created: 2026-06-21T06:23:29Z

## Objective

- Make the visible Windows preview homepage follow the supplied ranking plan instead of silently falling back to an almost unchanged TMDB-only wall.
- Use independent Douban recent-hot metadata for the visible homepage, while keeping user TVBox/native sources responsible for search, detail, playback, and fallback.
- Prefer compatible user TVBox HTTP sources over built-in sources, hard-filter short-form traffic content on Home only, and fill incomplete rows with cleaned fallback data.

## Scope

- In scope:
  - TVBox/native homepage aggregation order and latency.
  - Per-row Douban/source/fallback coverage.
  - Restricted Douban poster proxy and local cache.
  - Home-only quality filtering/ranking.
  - Temporary-data preview verification with user-provided or synthetic subscriptions.
- Out of scope:
  - Search-result filtering.
  - Executing unknown csp/jar/py/js plugins.
  - Hardcoding third-party media sources or recommendation titles.

## Constraints

- Preserve unrelated user changes.
- Do not expose secrets.
- Avoid global hooks or external writes unless explicitly authorized.
- Store preview subscriptions only under `D:\CodexWorks\tmp`.
- Keep TMDB as a fallback and preserve playback/detail/search behavior.

## Acceptance Criteria

- [x] Compatible user TVBox HTTP sources are scanned before built-in sources.
- [x] Homepage source requests no longer fail merely because sequential scans exceed the frontend timeout.
- [x] Each row uses Douban hot metadata first, compatible user source rows second, and cleaned fallback data when needed.
- [x] Short drama/vertical/explainer content is absent from Home but search behavior is unchanged.
- [x] Preview endpoint and visible UI show `douban-source` mode and current real titles.
- [x] Douban cards search the user's configured sources by title instead of acting as playback sources.
- [x] Ranking, endpoint, UI regression, localization, playback, build, and packaging checks pass.
- [x] Evidence and residual gaps are recorded; rollback snapshot exists.

## Source Files

- `C:\Users\DELL\Downloads\CODEX_TASK_冬瓜播放器首页榜单优化.md`
- `server.js`
- `server/adapters/tvbox/recommendationRanker.js`
- `server/adapters/douban/homeProvider.js`
- `public/index.html`
- `tools/test-douban-home-provider.js`
- `tools/test-homepage-ranking-ui.js`
- `tools/test-tvbox-home-endpoint.js`
- `tools/test-newest-order-ui.js`
