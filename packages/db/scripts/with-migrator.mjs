#!/usr/bin/env node
/**
 * Runs a Prisma CLI command as the migrator role.
 *
 * The app connects as `examhub_app`, which deliberately cannot run DDL — so a
 * bare `prisma migrate deploy` picks up DATABASE_URL and dies with
 * "permission denied for table _prisma_migrations". That error is correct but
 * says nothing about why, and the fix ("use a different role") is not guessable
 * from it.
 *
 * So: if MIGRATE_DATABASE_URL is set, migrations use it. If it is not, they use
 * DATABASE_URL exactly as before — a database with no split roles keeps working
 * untouched, which matters because scripts/provision-roles.sql is optional and
 * CI may not run it.
 *
 * Usage: node scripts/with-migrator.mjs migrate deploy
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

// The Prisma CLI loads .env itself, but only AFTER we would have had to pick a
// URL — so read it here too. Shell values win, matching vitest.config.ts.
const envFile = join(repoRoot, '.env')
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (typeof value === 'string') process.env[key] ??= value
  }
}

const migrateUrl = process.env['MIGRATE_DATABASE_URL']
if (migrateUrl) {
  process.env['DATABASE_URL'] = migrateUrl
  const role = decodeURIComponent(migrateUrl.split('://')[1]?.split(':')[0] ?? '?')
  console.log(`Running as the migrator role (${role}) — MIGRATE_DATABASE_URL is set.`)
} else {
  console.log('MIGRATE_DATABASE_URL is unset; using DATABASE_URL.')
}

const result = spawnSync('npx', ['prisma', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  // npx is a .cmd on Windows and will not spawn without a shell.
  shell: true,
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
