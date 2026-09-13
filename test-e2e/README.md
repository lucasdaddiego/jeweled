# E2E smoke test

Boots the real app in headless Chromium against a built-in static server and asserts: boot splash removed (first frame drawn), `canvas#game` nonzero and actually painted, `title → gameZen → title` scene round-trip settles to cascade `IDLE`, `localStorage['gem-match:v1']` persisted, a full offline reload from the service-worker precache, and zero console/page errors. A second, touch-emulated context (Pixel 7 descriptor, `hasTouch`) then taps the release-activated buttons and asserts the action ran: View source → `popup` event to the repo URL, Share → stubbed `navigator.share` (then, with no share sheet, `navigator.clipboard.writeText`). The stubs prove the wiring under touch, not the browser's activation policy — a real phone is still worth a minute after touching that path.

Run: `node test-e2e/smoke.spec.mjs` (needs the `playwright` devDependency plus a one-time `npx playwright install chromium`).

Plain Playwright library script — no `@playwright/test` runner, no config. It is outside `test/**/*.test.js`, so Vitest and the coverage gate never see it.
