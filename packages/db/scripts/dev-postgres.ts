import EmbeddedPostgres from 'embedded-postgres'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createConnection } from 'node:net'

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

/** Is something already listening on the port? */
async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const done = (inUse: boolean) => {
      socket.destroy()
      resolve(inUse)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(1000, () => done(false))
  })
}

async function main() {
  /**
   * Starting a second cluster on a taken port fails deep inside initdb/pg_ctl,
   * which surfaces as a rejection carrying no message at all — the script used
   * to print "Failed to start the development database: undefined". Almost
   * always it just means one is already running from another terminal, so
   * check first and say so.
   */
  if (await portInUse(PORT)) {
    console.log(
      `\n  A PostgreSQL is already listening on port ${PORT}.\n\n` +
        `  If that is this database, you do not need to start it again —\n` +
        `  just run the API:\n` +
        `      npm run dev\n\n` +
        `  DATABASE_URL="${url}"\n\n` +
        `  If it is a different PostgreSQL, stop it (or change PORT in\n` +
        `  packages/db/scripts/dev-postgres.ts) and run this again.\n`
    )
    process.exit(0)
  }

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

main().catch(async (err: unknown) => {
  /**
   * embedded-postgres rejects with undefined when pg_ctl fails, so printing the
   * error alone produced a bare "undefined" that named neither the problem nor
   * a next step. Say what is known, and point at the log the cluster writes.
   */
  const described = err instanceof Error ? err.message : err ? String(err) : ''

  console.error(`\n  Failed to start the development database.\n`)
  if (described) console.error(`  ${described}\n`)
  console.error(
    `  Things worth checking:\n` +
      `    - Is one already running? Another terminal, or a system PostgreSQL\n` +
      `      on port ${PORT}.\n` +
      `    - If a previous run was killed, the cluster may need recovering:\n` +
      `      delete ${dataDir}\n` +
      `      and run this again (it re-migrates and re-seeds; local data is lost).\n` +
      `    - The cluster's own log: ${join(dataDir, 'postmaster.log')}\n`
  )

  // A cluster left running after a failed migration would block the next
  // attempt with "port already in use", which reads as a different problem.
  try {
    await pg.stop()
  } catch {
    /* never started */
  }
  process.exit(1)
})
