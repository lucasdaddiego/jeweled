import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './test-worker/leaderboard.worker.js',
      miniflare: {
        // Same date as wrangler.jsonc. No compatibilityFlags: nodejs_compat is
        // default from 2026-08-04 and workerd rejects the redundant flag.
        compatibilityDate: '2026-08-22',
        kvNamespaces: ['LEADERBOARD'],
      },
    }),
  ],
  test: {
    include: ['test-worker/**/*.test.js'],
    testTimeout: 10_000,
  },
});
