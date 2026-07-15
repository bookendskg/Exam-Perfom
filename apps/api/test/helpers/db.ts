import {
  ANCHOR_TENANT,
  createPrismaClient,
  seedReferenceData,
  SEED_OUTLETS,
  SEED_DEPARTMENTS,
  SEED_DESIGNATIONS,
  type PrismaClient,
} from '@bookends/db'

let client: PrismaClient | undefined

/**
 * The RAW client — deliberately not tenant-scoped.
 *
 * Fixtures and truncation are setup, not application code: they legitimately
 * write across tenants and run outside any request, so wrapping them in the
 * extension would mean every helper needed a runInTenant() around it for no
 * safety gain. The app under test builds its own scoped client from this one
 * (see buildApp), so the code being tested is still fully guarded — only the
 * scaffolding is not.
 */
export function testDb(): PrismaClient {
  if (!client) {
    const url = process.env['TEST_DATABASE_URL']
    if (!url) throw new Error('TEST_DATABASE_URL is unset — globalSetup did not run')
    client = createPrismaClient(url)
  }
  return client
}

/**
 * The tenant every fixture belongs to unless a test says otherwise.
 *
 * Synchronous by design. globalSetup resolves it once and publishes it on the
 * environment, so fixtures can drop `tenantId: testTenantId()` into an object
 * literal anywhere — including inside a non-async .map() — without restructuring
 * around an await.
 *
 * Seeded by globalSetup and never truncated, so it is stable for the whole run.
 * Cross-tenant behaviour is tested in tenant-isolation.test.ts, which makes its
 * own tenants rather than borrowing this one.
 */
export function testTenantId(): string {
  const id = process.env['TEST_TENANT_ID']
  if (!id) throw new Error('TEST_TENANT_ID is unset — globalSetup did not run')
  return id
}

/**
 * The slug a test login must present.
 *
 * Login resolves its tenant from the request before checking credentials (see
 * tenant.resolver.ts), so a test that omits this gets TENANT_NOT_FOUND rather
 * than a token. Supertest has no hostname to derive a subdomain from, so the
 * body is the route in.
 */
export const TEST_TENANT_SLUG = ANCHOR_TENANT.slug

/**
 * Tables holding test-created rows. Reference data seeded from §9 (outlets,
 * departments, designations) is deliberately absent — it survives truncation so
 * every test can rely on it.
 */
const MUTABLE_TABLES = [
  'user_sessions',
  'exam_responses',
  'exam_sessions',
  'exam_assignments',
  'exam_questions',
  'exams',
  'exam_templates',
  'question_reviews',
  'questions',
  'topics',
  'source_documents',
  'performance_snapshots',
  'certificates',
  'rewards',
  'training_assignments',
  'supervisor_remarks',
  'employee_skills',
  'employee_timeline',
  'employees',
  'audit_logs',
  'notifications',
  'users',
] as const

/**
 * Resets the database to the state a freshly-seeded one is in.
 *
 * Deliberately NOT `TRUNCATE ... CASCADE`. Postgres cascades a TRUNCATE by
 * foreign-key *constraint*, not by data — and `outlets.manager_id` references
 * `users`, so truncating users silently takes outlets (and, through
 * outlet_departments, the department mappings) with it.
 *
 * Plain TRUNCATE is not an option either: Postgres refuses to truncate a table
 * referenced by an unlisted table. So: null the one back-reference, then DELETE
 * leaf-first. At these row counts the cost is not measurable.
 *
 * Reference data is RESTORED, not merely preserved. Tests mutate it — they
 * deactivate outlets, create departments, reassign managers — and leaving those
 * changes in place makes later tests depend on execution order. A test that
 * deactivates Aiko silently gives every subsequent outlet_manager an empty
 * scope, because resolvePrincipal filters on isActive.
 */
export async function truncateAll(prisma: PrismaClient = testDb()): Promise<void> {
  await prisma.$transaction([
    // Drops the outlets → users FK reference so users can be deleted, and
    // clears manager assignments a previous test may have stamped on.
    prisma.$executeRawUnsafe(`UPDATE "outlets" SET "manager_id" = NULL`),
    // §8.2 codes are never reused, so the counter must be reset or assertions
    // on BK-AK-001 would depend on test execution order.
    prisma.$executeRawUnsafe(`UPDATE "outlets" SET "last_employee_seq" = 0`),
    ...MUTABLE_TABLES.map((t) => prisma.$executeRawUnsafe(`DELETE FROM "${t}"`)),
    // Drop org rows a test created. Keyed on the seeded codes, which come from
    // @bookends/db so they cannot drift from what the real seed writes.
    prisma.$executeRawUnsafe(
      `DELETE FROM "designations" WHERE "code" NOT IN (${sqlList(SEED_DESIGNATIONS.map((d) => d.code))})`
    ),
    prisma.$executeRawUnsafe(
      `DELETE FROM "departments" WHERE "code" NOT IN (${sqlList(SEED_DEPARTMENTS.map((d) => d.code))})`
    ),
    prisma.$executeRawUnsafe(
      `DELETE FROM "outlets" WHERE "code" NOT IN (${sqlList(SEED_OUTLETS.map((o) => o.code))})`
    ),
  ])

  // Drop every tenant a test invented, leaving only the anchor.
  //
  // Not cosmetic. Anything that legitimately iterates tenants — the
  // auto-scheduling job does, per SaaS §7 — would otherwise pick up tenants
  // left behind by tenant-isolation.test.ts and quietly do twice the work. That
  // bug only appears when the files run in a particular order, and vitest
  // reorders them between runs from its timing cache, so it surfaces as a suite
  // that passes once and fails the next time for no visible reason.
  //
  // Safe to run after the deletes above: those already removed the child rows
  // (their outlets and departments do not carry seeded codes), so nothing
  // references these tenants by the time they go.
  await prisma.tenant.deleteMany({ where: { slug: { not: ANCHOR_TENANT.slug } } })

  // Restores isActive, names, levels and the outlet/department mappings that a
  // test may have changed or deleted.
  await seedReferenceData(prisma, testTenantId())
}

/** The codes are compile-time constants from @bookends/db, never user input. */
function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ')
}

export async function disconnectDb(): Promise<void> {
  await client?.$disconnect()
  client = undefined
}
