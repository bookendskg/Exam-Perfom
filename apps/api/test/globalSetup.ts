import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { execSync, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer } from 'node:net'

/**
 * Boots a real PostgreSQL for the suite.
 *
 * Not pg-mem or a mock: the schema leans on INET, JSONB, TEXT[],
 * gen_random_uuid(), and CHECK constraints. Anything less would be testing a
 * different database than production runs on.
 *
 * Two ways to get one, tried in order:
 *
 *  1. **Embedded PostgreSQL** — the default, and what CI uses. Downloads a real
 *     binary and runs it on a random port, so no Docker and no local install.
 *  2. **A PostgreSQL server you already run** — the fallback. PostgreSQL
 *     REFUSES to start under an administrative account ("Execution of
 *     PostgreSQL by a user with administrative permissions is not permitted"),
 *     so on Windows the embedded path fails outright in an elevated terminal —
 *     which is where many people work. Rather than making `npm test` depend on
 *     which terminal you happened to open, fall back to a throwaway database on
 *     an existing server.
 *
 * The chosen path is printed, so it is never a mystery which database a run
 * used.
 */
let pgInstance: EmbeddedPostgres | undefined
let dataDir: string | undefined
/** Set only on the fallback path; drives the DROP DATABASE in teardown. */
let createdDatabase: { adminUrl: string; name: string } | undefined

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Builds the name of the throwaway database, and refuses to return anything
 * that could be a real one.
 *
 * This is the single most dangerous line in the test suite. `truncateAll()`
 * runs `DELETE FROM` across 21 tables before EVERY test — so if this ever
 * resolved to the development database, the first test would silently destroy
 * the whole dataset. The guards below are deliberately paranoid, because the
 * failure mode is unrecoverable data loss rather than a red test.
 */
const THROWAWAY_PREFIX = 'bookends_test_'

function throwawayDatabaseName(adminUrl: string): string {
  const name = `${THROWAWAY_PREFIX}${randomBytes(6).toString('hex')}`

  if (!name.startsWith(THROWAWAY_PREFIX)) {
    throw new Error(`Refusing to use "${name}": not a throwaway database name`)
  }

  const existing = new URL(adminUrl).pathname.replace(/^\//, '')
  if (name === existing) {
    throw new Error(
      `Refusing to run tests against "${existing}" — that is the database in your ` +
        `connection string, and the suite truncates every table it touches.`
    )
  }

  return name
}

/** Same server, different database. */
function withDatabase(url: string, database: string): string {
  const next = new URL(url)
  next.pathname = `/${database}`
  return next.toString()
}

/**
 * Creates a fresh database on an already-running server and returns its URL.
 *
 * Connects to the `postgres` maintenance database to issue the CREATE — never
 * to the target of the connection string, so no user data is ever in reach of
 * this code path.
 */
async function createThrowawayDatabase(adminUrl: string): Promise<string> {
  const name = throwawayDatabaseName(adminUrl)
  const maintenance = withDatabase(adminUrl, 'postgres')

  const client = new pg.Client({ connectionString: maintenance })
  await client.connect()
  try {
    // Identifier is generated above from hex, never from input, but quote it
    // anyway so the shape of this statement is not a lesson in bad habits.
    await client.query(`CREATE DATABASE "${name}"`)
  } finally {
    await client.end()
  }

  createdDatabase = { adminUrl, name }
  const url = withDatabase(adminUrl, name)

  // The same guarantee the embedded path gets from `--encoding=UTF8`: a WIN1252
  // database accepts ASCII and then rejects the first Devanagari character, so
  // every §6 trilingual test would fail for a reason that looks like a bug.
  const check = new pg.Client({ connectionString: url })
  await check.connect()
  try {
    const { rows } = await check.query<{ encoding: string }>(
      `SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()`
    )
    if (rows[0]?.encoding !== 'UTF8') {
      throw new Error(
        `The server created "${name}" with encoding ${rows[0]?.encoding ?? 'unknown'}, not UTF8. ` +
          `Hindi and Gujarati content (§6) cannot be stored in it.`
      )
    }
  } finally {
    await check.end()
  }

  return url
}

/** Reads DIRECT_URL from the repo-root .env, which the test process does not load. */
function directUrlFromEnvFile(): string | undefined {
  if (process.env['DIRECT_URL']) return process.env['DIRECT_URL']
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url))
  } catch {
    /* no .env — the fallback simply is not available */
  }
  return process.env['DIRECT_URL']
}

async function startEmbedded(): Promise<string> {
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'bookends-test-pg-'))

  pgInstance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'test',
    password: 'test',
    port,
    persistent: false,
    onLog: () => {},
    /**
     * NOT optional. initdb otherwise inherits the host's system locale, which
     * on a Windows machine means a WIN1252 cluster — and WIN1252 physically
     * cannot store Devanagari or Gujarati. Every §6 trilingual column would
     * reject its content with:
     *
     *   character with byte sequence 0xe0 0xa4 0x96 in encoding "UTF8"
     *   has no equivalent in encoding "WIN1252"
     *
     * The same trap applies to production: provision the real database with
     * UTF8 explicitly. assertUtf8Database() in the API refuses to boot without
     * it.
     */
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  })

  await pgInstance.initialise()
  await pgInstance.start()
  // createDatabase() issues a bare CREATE DATABASE, which inherits template1's
  // encoding — fine now that the cluster itself is UTF8.
  await pgInstance.createDatabase('bookends_test')

  return `postgresql://test:test@localhost:${port}/bookends_test`
}

/** Undoes a partial embedded start, so a fallback does not inherit its mess. */
async function discardEmbedded(): Promise<void> {
  try {
    await pgInstance?.stop()
  } catch {
    /* never started */
  }
  pgInstance = undefined
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true })
    dataDir = undefined
  }
}

/**
 * Is this process running as Administrator?
 *
 * Checked BEFORE trying embedded PostgreSQL, not after, because the embedded
 * failure is not recoverable: `embedded-postgres` registers an async exit hook,
 * and when initdb refuses to run as admin that hook tears the whole process
 * down. There is no rejection left to catch — vitest simply dies after printing
 * its banner, which is exactly the unhelpful behaviour this fallback exists to
 * remove. So the elevated case must never enter that path at all.
 *
 * `net session` is the standard probe: it requires administrative rights and
 * fails fast (~100ms) without them.
 */
function isElevatedWindows(): boolean {
  if (process.platform !== 'win32') return false
  try {
    execFileSync('net', ['session'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function fallbackUnavailable(reason: string): Error {
  return new Error(
    `Cannot provide a database for the test suite.\n\n` +
      `  ${reason}\n\n` +
      `  Fix either way:\n` +
      `    - run the tests from a NON-elevated terminal, so the embedded\n` +
      `      PostgreSQL can start (this is what CI does); or\n` +
      `    - set DIRECT_URL in .env (or TEST_DATABASE_SERVER_URL) to a PostgreSQL\n` +
      `      server you already run, and the suite will create a throwaway\n` +
      `      database on it.\n`
  )
}

async function resolveDatabaseUrl(): Promise<{ url: string; mode: string }> {
  // 1. An explicit server wins outright — the escape hatch, and what a CI job
  //    with a Postgres service container would set.
  const explicit = process.env['TEST_DATABASE_SERVER_URL']
  if (explicit) {
    return {
      url: await createThrowawayDatabase(explicit),
      mode: 'a throwaway database on TEST_DATABASE_SERVER_URL',
    }
  }

  // 2. Elevated on Windows: embedded PostgreSQL cannot start, and trying kills
  //    the process rather than failing. Go straight to a running server.
  if (isElevatedWindows()) {
    const directUrl = directUrlFromEnvFile()
    if (!directUrl) {
      throw fallbackUnavailable(
        'This terminal is elevated, and PostgreSQL refuses to run as Administrator, ' +
          'so the embedded server cannot start. No DIRECT_URL was found in .env either.'
      )
    }
    return {
      url: await createThrowawayDatabase(directUrl),
      mode: 'a throwaway database on your local server (this terminal is elevated)',
    }
  }

  // 3. Embedded: the default, hermetic, and what CI uses.
  try {
    return { url: await startEmbedded(), mode: 'embedded PostgreSQL' }
  } catch (err) {
    await discardEmbedded()

    // Any other reason embedded failed — a running server is still worth a try.
    const directUrl = directUrlFromEnvFile()
    if (!directUrl) {
      throw fallbackUnavailable(
        `The embedded PostgreSQL failed to start: ` +
          `${err instanceof Error ? err.message : String(err ?? 'no reason reported')}.`
      )
    }

    return {
      url: await createThrowawayDatabase(directUrl),
      mode: 'a throwaway database on your local server (embedded PostgreSQL could not start)',
    }
  }
}

export async function setup() {
  const { url, mode } = await resolveDatabaseUrl()

  process.stdout.write(`\n  Tests are using ${mode}.\n\n`)

  process.env['DATABASE_URL'] = url
  process.env['TEST_DATABASE_URL'] = url

  // Apply real migrations rather than `db push`, so the suite exercises the
  // exact DDL that production will run — including the hand-appended CHECK
  // constraint that `db push` would silently skip.
  // execSync with a fixed command string: there is no interpolated input here,
  // and passing an args array with shell:true (needed for npx on Windows) trips
  // Node's DEP0190 unescaped-arguments warning.
  const dbPackage = fileURLToPath(new URL('../../../packages/db', import.meta.url))
  // DIRECT_URL as well as DATABASE_URL: the datasource declares `directUrl` for
  // Supabase's pooler, and Prisma resolves that variable for every CLI command
  // even when — as here — there is no pooler and the two are the same endpoint.
  // Leaving it unset fails with "Environment variable not found: DIRECT_URL".
  const childEnv = { ...process.env, DATABASE_URL: url, DIRECT_URL: url }

  execSync('npx prisma migrate deploy', { cwd: dbPackage, env: childEnv, stdio: 'pipe' })

  // Seed the §9 reference data — outlets, departments, designations. helpers/db
  // deliberately spares these tables from TRUNCATE so every test can rely on
  // them, which only works if they are here to begin with. No SEED_ADMIN_* is
  // set, so the seed skips the bootstrap super admin.
  execSync('npx tsx prisma/seed.ts', { cwd: dbPackage, env: childEnv, stdio: 'pipe' })

  return teardown
}

export async function teardown() {
  // Vitest calls the function returned by setup(); this also runs standalone
  // for the case where setup threw partway, so every step tolerates a state
  // that was never reached.
  try {
    await pgInstance?.stop()
  } catch {
    /* already stopped */
  }
  pgInstance = undefined

  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true })
    dataDir = undefined
  }

  if (createdDatabase) {
    const { adminUrl, name } = createdDatabase
    createdDatabase = undefined
    const client = new pg.Client({ connectionString: withDatabase(adminUrl, 'postgres') })
    try {
      await client.connect()
      // WITH (FORCE) evicts connections the suite left open; without it a single
      // lingering client leaves an undroppable database behind on every run.
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    } catch {
      /* Leaves a stray bookends_test_* database. Visible, and safe to drop. */
    } finally {
      await client.end().catch(() => undefined)
    }
  }
}
