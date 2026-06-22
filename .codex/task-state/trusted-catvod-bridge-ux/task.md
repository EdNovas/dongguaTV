# Task: DongguaTV trusted CatVod Bridge UX and diagnostics

- Task ID: `trusted-catvod-bridge-ux`
- Status: completed
- Created: 2026-06-22T07:44:43Z

## Objective

- Make trusted CatVod bridge state accurate and user-verifiable from the
  Subscriptions page without exposing source URLs, plugin payloads, headers, or
  playback tokens.

## Scope

- In scope:
  - Distinguish stopped, stub, reflect-ready, and reflect-incomplete bridge states.
  - Correct plugin source diagnostics so stub mode is not reported as playable.
  - Add a safe per-source plugin search probe with title-only results.
  - Add Chinese, English, and Japanese UI labels for the probe.
  - Add focused automated tests and refresh the service worker cache version.
- Out of scope:
  - Automatically trusting or executing subscription-provided jar, py, js, or csp code.
  - DRM, membership, payment, or access-control bypass.
  - Replacing the existing HTTP source, LocalProxy, or external-player flows.

## Constraints

- Preserve unrelated user changes.
- Do not expose secrets.
- Avoid global hooks or external writes unless explicitly authorized.

## Acceptance Criteria

- [x] Reflect-ready and stub diagnostics are reported accurately.
- [x] A plugin source can be safely test-searched through a user-configured trusted bridge.
- [x] Safe probe responses contain no source payload, URL, raw bridge response, or media ID.
- [x] Subscription UI shows the bridge mode and up to five matched titles.
- [x] Relevant verification passes with real exit status.
- [x] Evidence and residual gaps are recorded.
- [x] Rollback is available or explicitly not required.

## Source Files

- `server/adapters/tvbox/index.js`
- `server/adapters/tvbox/pluginRuntime.js`
- `server.js`
- `public/index.html`
- `public/sw.js`
- `tools/test-plugin-bridge-search.js`
- `docs/CATVOD_BRIDGE.md`
