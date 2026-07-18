import EmbeddedPostgres from 'embedded-postgres'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * A development PostgreSQL, for machines with neither Docker nor a local
 * install.
 *
 * The README says to point DATABASE_URL at any PostgreSQL you have — which
 * assumes you have one. The test suite already downloads and runs a real
 * PostgreSQL 15 binary (see apps/api/test/globalSetup.ts), so the same
 * mechanism serves development: no Docker, no service to install, and the same
 * engine the tests and production use.
 *
 * The difference from the test harness is persistence. Tests want a throwaway
 * cluster on a random port; development wants the same data back tomorrow, so
 * this uses a fixed port and a data directory under packages/db/pgdata (already
 * gitignored). Stop it with Ctrl-C — the data survives.
 *
 *   npm run db:dev      # in one terminal, leave it running
 *   npm run dev         # in another
 */
const PORT = 5432
const USER = 'bookends'
const PASSWORD = 'bookends_dev'
const DATABASE = 'bookends'

const dbPackage = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(dbPackage, 'pgdata')
const url = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}?schema=public`

/**
 * `initialise()` runs initdb, which refuses to touch a directory that already
 * holds a cluster. PG_VERSION is written by a SUCCESSFUL initdb, so its
 * presence — rather than the directory's — is what distinguishes "already set
 * up" from "a previous run died halfway".
 */
const alreadyInitialised = existsSync(join(dataDir, 'PG_VERSION'))

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  onLog: () => {},
  /**
   * NOT optional, and the same trap the test harness documents: initdb
   * otherwise inherits the host's system locale, which on a Windows machine
   * means a WIN1252 cluster — and WIN1252 physically cannot store Devanagari or
   * Gujarati. Every §6 trilingual column would reject its content, and
   * assertUtf8Database() refuses to boot the API against such a cluster.
   */
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
})

async function main() {
  if (!alreadyInitialised) {
    mkdirSync(dataDir, { recursive: true })
    console.log('Initialising a new PostgreSQL cluster (first run only)...')
    await pg.initialise()
  }

  await pg.start()
  console.log(`PostgreSQL listening on port ${PORT}`)

  if (!alreadyInitialised) {
    await pg.createDatabase(DATABASE)

    const childEnv = { ...process.env, DATABASE_URL: url }
    // Real migrations, not `db push` — the same reasoning as the test harness:
    // db push silently skips the hand-appended CHECK constraint.
    console.log('Applying migrations...')
    execSync('npx prisma migrate deploy', { cwd: dbPackage, env: childEnv, stdio: 'inherit' })

    console.log('Seeding reference data...')
    execSync('npx tsx prisma/seed.ts', { cwd: dbPackage, env: childEnv, stdio: 'inherit' })
  }

  console.log(`\nDATABASE_URL="${url}"`)
  console.log('Ready. Leave this running and start the API with `npm run dev`.')
  console.log('Ctrl-C to stop; the data in packages/db/pgdata survives.\n')

  const shutdown = async () => {
    console.log('\nStopping PostgreSQL...')
    try {
      await pg.stop()
    } catch {
      /* already stopped */
    }
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch(async (err) => {
  console.error('Failed to start the development database:', err)
  // A cluster left running after a failed migration would block the next
  // attempt with "port already in use", which reads as a different problem.
  try {
    await pg.stop()
  } catch {
    /* never started */
  }
  process.exit(1)
})
