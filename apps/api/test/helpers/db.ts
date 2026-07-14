import { createPrismaClient, type PrismaClient } from '@bookends/db'

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
 * Clears test-created rows while preserving the §9 reference data.
 *
 * Deliberately NOT `TRUNCATE ... CASCADE`. Postgres cascades a TRUNCATE by
 * foreign-key *constraint*, not by data — and `outlets.manager_id` references
 * `users`, so truncating users silently takes outlets (and, through
 * outlet_departments, the department mappings) with it. That wiped the seeded
 * reference data on every test.
 *
 * Plain TRUNCATE is not an option either: Postgres refuses to truncate a table
 * that is referenced by an unlisted table. So: null the one back-reference, then
 * DELETE leaf-first. Slower than TRUNCATE, but correct — and at these row counts
 * the difference is not measurable.
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
  ])
}

export async function disconnectDb(): Promise<void> {
  await client?.$disconnect()
  client = undefined
}
