import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './test-worker/leaderboard.worker.js',
      miniflare: {
        compatibilityDate: '2026-07-25',
        compatibilityFlags: ['nodejs_compat'],
        kvNamespaces: ['LEADERBOARD'],
      },
    }),
  ],
  test: {
    include: ['test-worker/**/*.test.js'],
    testTimeout: 10_000,
  },
});
