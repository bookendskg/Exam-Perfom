import EmbeddedPostgres from 'embedded-postgres'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer } from 'node:net'

/**
 * Boots a real PostgreSQL 15 for the suite.
 *
 * Not pg-mem or a mock: the schema leans on INET, JSONB, TEXT[],
 * gen_random_uuid(), and CHECK constraints. Anything less would be testing a
 * different database than production runs on. This machine has no Docker, so
 * the binary is downloaded and run directly.
 */
let pg: EmbeddedPostgres | undefined
let dataDir: string | undefined

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

export async function setup() {
  // A random port lets concurrent runs (and a dev server) coexist.
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'bookends-test-pg-'))

  pg = new EmbeddedPostgres({
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

  await pg.initialise()
  await pg.start()
  // createDatabase() issues a bare CREATE DATABASE, which inherits template1's
  // encoding — fine now that the cluster itself is UTF8.
  await pg.createDatabase('bookends_test')

  const url = `postgresql://test:test@localhost:${port}/bookends_test`
  process.env['DATABASE_URL'] = url
  process.env['TEST_DATABASE_URL'] = url

  // Apply real migrations rather than `db push`, so the suite exercises the
  // exact DDL that production will run — including the hand-appended CHECK
  // constraint that `db push` would silently skip.
  // execSync with a fixed command string: there is no interpolated input here,
  // and passing an args array with shell:true (needed for npx on Windows) trips
  // Node's DEP0190 unescaped-arguments warning.
  const dbPackage = fileURLToPath(new URL('../../../packages/db', import.meta.url))
  const childEnv = { ...process.env, DATABASE_URL: url }

  execSync('npx prisma migrate deploy', { cwd: dbPackage, env: childEnv, stdio: 'pipe' })

  // Seed the §9 reference data — outlets, departments, designations. helpers/db
  // deliberately spares these tables from TRUNCATE so every test can rely on
  // them, which only works if they are here to begin with. No SEED_ADMIN_* is
  // set, so the seed skips the bootstrap super admin.
  execSync('npx tsx prisma/seed.ts', { cwd: dbPackage, env: childEnv, stdio: 'pipe' })

  return async () => {
    await pg?.stop()
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  }
}

export async function teardown() {
  // Vitest calls the function returned by setup(); this is a belt-and-braces
  // fallback for the case where setup threw partway.
  try {
    await pg?.stop()
  } catch {
    /* already stopped */
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
}
