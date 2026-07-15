/**
 * A local PostgreSQL for development, with no install required.
 *
 * This machine has no Docker and no Postgres, so `npm run dev:db` downloads and
 * runs a real PostgreSQL 15 into ./.dev-db and leaves it running. It is the
 * same mechanism the test suite uses, just persistent.
 *
 * NOT for production. It is a developer convenience: a real deployment needs a
 * managed Postgres with backups.
 */
import EmbeddedPostgres from 'embedded-postgres'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = join(root, '.dev-db')

const USER = 'bookends'
const PASSWORD = 'bookends_dev'
const DATABASE = 'bookends'
const PORT = 5432

mkdirSync(dataDir, { recursive: true })

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: USER,
  password: PASSWORD,
  port: PORT,
  // Survives restarts, so seeded data and any exams you create stick around.
  persistent: true,
  /**
   * NOT optional. Without it initdb inherits the Windows system locale and
   * builds a WIN1252 cluster, which physically cannot store Devanagari or
   * Gujarati — every Hindi and Gujarati question would be rejected on insert.
   * The API refuses to boot against a non-UTF8 database for this reason.
   */
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: (e) => console.error(String(e)),
})

const url = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`

async function main() {
  let initialised = false
  try {
    await pg.initialise()
    initialised = true
  } catch {
    // Already initialised from a previous run — that is the normal case.
  }

  await pg.start()

  if (initialised) {
    await pg.createDatabase(DATABASE)
    console.log(`Created database "${DATABASE}".`)
  }

  console.log('')
  console.log('  PostgreSQL is running.')
  console.log('')
  console.log(`  DATABASE_URL="${url}"`)
  console.log('')
  console.log('  Put that in your .env, then in another terminal:')
  console.log('    npm run db:migrate    # create the tables')
  console.log('    npm run db:seed       # outlets, departments, designations')
  console.log('    npm run dev           # start the API on http://localhost:4000')
  console.log('')
  console.log('  Ctrl+C stops the database. Data is kept in ./.dev-db')
  console.log('')

  const stop = async () => {
    console.log('\nStopping PostgreSQL…')
    await pg.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((error) => {
  console.error('Failed to start the development database:')
  console.error(error.message)
  console.error('\nIf the port is already in use, another Postgres may be running.')
  process.exit(1)
})
