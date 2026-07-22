import path from 'node:path'
import { defineConfig } from 'prisma/config'

/**
 * Prisma CLI configuration.
 *
 * Its reason for existing is the .env problem. Prisma treats this package as the
 * project root and only looks for a .env beside this file — it never reads the
 * monorepo-root .env that the rest of the repo uses (the API loads that one via
 * Node's --env-file). So a bare `npm run db:deploy` / `db:studio` from a fresh
 * checkout found no DATABASE_URL and failed with a bare "Environment variable
 * not found". Load the root .env here, once, for every Prisma command.
 *
 * Guarded: the test harness and CI inject DATABASE_URL/DIRECT_URL for a
 * throwaway cluster on a random port, and that must win — never overwrite an env
 * the caller has already set.
 *
 * This also replaces the deprecated `package.json#prisma` block, which is why
 * the seed command moves here.
 */
if (!process.env['DATABASE_URL']) {
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url))
  } catch {
    /* no root .env — Prisma then fails with its own clear "not found" */
  }
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
})
