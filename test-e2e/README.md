# E2E smoke test

Boots the real app in headless Chromium against a built-in static server and asserts: boot splash removed (first frame drawn), `canvas#game` nonzero and actually painted, `title → gameZen → title` scene round-trip settles to cascade `IDLE`, `localStorage['gem-match:v1']` persisted, and zero console/page errors.

Run: `node test-e2e/smoke.spec.mjs` (needs the `playwright` devDependency plus a one-time `npx playwright install chromium`).

Plain Playwright library script — no `@playwright/test` runner, no config. It is outside `test/**/*.test.js`, so Vitest and the coverage gate never see it.
