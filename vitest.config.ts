import { defineConfig } from 'vitest/config'
import { readFileSync, existsSync } from 'node:fs'
import { parseEnv } from 'node:util'

/**
 * Load .env into the config process, so `npm test` needs no ceremony.
 *
 * Done here rather than via `test.env`: globalSetup reads TEST_DATABASE_URL and
 * runs in THIS process, not a worker, so `test.env` would arrive too late.
 *
 * `??=`, not assignment: a variable already set in the shell wins. Otherwise
 * pointing a one-off run at a different database would silently use .env.
 */
if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
    if (typeof value === 'string') process.env[key] ??= value
  }
}

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
