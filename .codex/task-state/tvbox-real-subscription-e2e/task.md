# Task: DongguaTV TVBox real subscription end-to-end validation

- Task ID: `tvbox-real-subscription-e2e`
- Status: active
- Created: 2026-06-18T22:36:30Z

## Objective

- Validate the current DongguaTV Windows enhanced app against real user-supplied TVBox subscriptions end to end.
- Prove a reproducible chain for representative sources: import -> classify -> search -> detail -> playback line -> play URL resolution -> LocalProxy -> mpv.
- Record which representative subscriptions are HTTP-ready, live-ready, plugin-required, unsupported, or currently network-failed.

## Scope

- In scope:
- Temporary `DONGGUATV_DATA_DIR` runtime under `D:\CodexWorks\tmp`.
- Real-time validation of 2 to 3 representative public TVBox subscriptions provided earlier by the user.
- Reuse existing HTTP/MacCMS search/detail/playback APIs and existing player stack.
- Small, targeted fixes only if current behavior blocks the requested validation path.
- Out of scope:
- Hardcoding third-party subscriptions into the repository.
- Executing unknown TVBox `jar` / `py` / `js` / `csp_*` plugin runtimes.
- DRM bypass, paid-content bypass, or membership circumvention.
- Polluting formal Electron userData with test subscriptions or playback state.

## Constraints

- Preserve unrelated user changes.
- Do not expose secrets.
- Avoid global hooks or external writes unless explicitly authorized.
- Keep the old source thread preserved and do not archive it.
- After each meaningful phase, keep the app startable, revertible, and packageable.
- Treat live third-party sources as unstable and verify them fresh instead of reusing prior assumptions.

## Acceptance Criteria

- [ ] At least 2 representative subscriptions are imported and classified with evidence.
- [ ] At least 1 HTTP-ready source completes search -> detail -> playback line -> proxy -> mpv validation.
- [ ] Live/plugin-required/unsupported/network-failed outcomes are distinguished clearly.
- [ ] Relevant verification passes with real exit status.
- [ ] Evidence and residual gaps are recorded.
- [ ] Rollback is available or explicitly not required.

## Source Files

- Add authoritative files and specifications here.
- `server.js`
- `server/adapters/tvbox/**`
- `server/player/**`
- `tools/test-player-upstream.js`
- `tools/test-player-stack.js`
- `tools/test-playback-ui.js`
- User delegation note in current thread and prior stable commit `4470288`
