import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Boots one real PostgreSQL 15 for the whole run and applies migrations.
    globalSetup: ['./apps/api/test/globalSetup.ts'],
    // The suite shares a single database, so parallel files would race on
    // TRUNCATE. Revisit with per-worker template databases if this gets slow.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
