import {
  createPrismaClient,
  seedReferenceData,
  SEED_OUTLETS,
  SEED_DEPARTMENTS,
  SEED_DESIGNATIONS,
  type PrismaClient,
} from '@bookends/db'

let client: PrismaClient | undefined

export function testDb(): PrismaClient {
  if (!client) {
    const url = process.env['TEST_DATABASE_URL']
    if (!url) throw new Error('TEST_DATABASE_URL is unset — globalSetup did not run')
    client = createPrismaClient(url)
  }
  return client
}

/**
 * Tables holding test-created rows. Reference data seeded from §9 (outlets,
 * departments, designations) is deliberately absent — it survives truncation so
 * every test can rely on it.
 */
const MUTABLE_TABLES = [
  'user_sessions',
  // Lockout state is durable now, so it must be reset between tests or a test
  // that deliberately fails a login leaves the next one locked out.
  'login_attempts',
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

  // Restores isActive, names, levels and the outlet/department mappings that a
  // test may have changed or deleted.
  await seedReferenceData(prisma)
}

/** The codes are compile-time constants from @bookends/db, never user input. */
function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ')
}

export async function disconnectDb(): Promise<void> {
  await client?.$disconnect()
  client = undefined
}
