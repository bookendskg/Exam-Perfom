import EmbeddedPostgres from 'embedded-postgres'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { ANCHOR_TENANT, createPrismaClient } from '@bookends/db'
import { assertTrilingualRoundTrip, assertUtf8Database } from '../src/infra/assert-utf8.js'

/**
 * Boots a real PostgreSQL 15 for the suite.
 *
 * Not pg-mem or a mock: the schema leans on INET, JSONB, TEXT[],
 * gen_random_uuid(), and CHECK constraints. Anything less would be testing a
 * different database than production runs on. This machine has no Docker, so
 * the binary is downloaded and run directly.
 *
 * Unless TEST_DATABASE_URL is already set — see setup().
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
  // An externally-supplied database wins, and the suite boots nothing.
  //
  // embedded-postgres is unusable on some machines through no fault of the
  // schema: PostgreSQL refuses to start under an administrative token —
  // "Execution of PostgreSQL by a user with administrative permissions is not
  // permitted" — so an elevated shell can never run these tests. Worse, the
  // refusal arrives as a bare `undefined` throw, which vitest renders as
  // "Unknown Error: undefined" with no mention of privileges.
  //
  // Pointing TEST_DATABASE_URL at a server someone else manages (a Windows
  // service install, or a CI service container) sidesteps that entirely: the
  // server runs under its own account and the suite is merely a client.
  const externalUrl = process.env['TEST_DATABASE_URL']
  const url = externalUrl ?? (await startEmbeddedPostgres())

  process.env['DATABASE_URL'] = url
  process.env['TEST_DATABASE_URL'] = url

  // An external database was created by someone else, so nothing enforces the
  // UTF8/C that initdbFlags guarantees below. Check it here: the first symptom
  // otherwise is a §6 trilingual column rejecting Devanagari, several steps
  // later and a long way from the cause.
  if (externalUrl) await assertExternalDatabaseIsUsable(url)

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

  // Publish the anchor tenant's id so helpers/db.ts can hand it out
  // synchronously. Fixtures need it in places where awaiting is awkward — inside
  // a .map() building createMany rows, for one — and an async lookup there turns
  // a one-line fixture into a restructured one.
  process.env['TEST_TENANT_ID'] = await readAnchorTenantId(url)

  return async () => {
    await pg?.stop()
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  }
}

/** The tenant the seed creates, and that every fixture belongs to by default. */
async function readAnchorTenantId(url: string): Promise<string> {
  const prisma = createPrismaClient(url)
  try {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { slug: ANCHOR_TENANT.slug },
      select: { id: true },
    })
    return tenant.id
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * Fails fast on an external database that cannot store the product's content.
 *
 * Reuses the API's own boot checks rather than restating them, so the suite and
 * production agree on what "usable" means.
 */
async function assertExternalDatabaseIsUsable(url: string): Promise<void> {
  const prisma = createPrismaClient(url)
  try {
    await assertUtf8Database(prisma)
    await assertTrilingualRoundTrip(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

/** Downloads and runs a throwaway PostgreSQL on a random port. */
async function startEmbeddedPostgres(): Promise<string> {
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

  return `postgresql://test:test@localhost:${port}/bookends_test`
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
