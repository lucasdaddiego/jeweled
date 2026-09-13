import { defineConfig } from 'vitest/config';

// jsdom environment + a stubbed canvas (see test/setup.js) lets the whole
// render/scene layer run headless. Coverage is enforced at a high floor (~99%)
// across src/ — `all: true` counts files even if a test never imports them, so
// a forgotten module fails the gate instead of silently scoring high.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
    // Node >= 25 ships Web Storage on by default, but `globalThis.localStorage`
    // is an accessor that yields undefined unless --localstorage-file is set.
    // Vitest's jsdom environment only copies window properties that are absent
    // from the Node global, so that accessor shadows jsdom's Storage and every
    // localStorage call throws. Disabling Node's implementation in the test
    // workers restores jsdom's (a no-op on Node 24, where it is off by default).
    execArgv: ['--no-experimental-webstorage'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.js'],
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // High floor rather than a hard 100%. The ~1% shortfall is unreachable
      // defensive code (e.g. `if (!ctx) return`, nullish fallbacks on
      // always-present values) and forward-only paths (storage migrations) that
      // never run under test — kept in the source for safety instead of being
      // stripped or papered over with ignore pragmas. Branches floor a touch
      // lower because those guards are mostly branch arms.
      thresholds: {
        statements: 99,
        branches: 98,
        functions: 99,
        lines: 99,
      },
    },
  },
});
