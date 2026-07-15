import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb, testTenantId, TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser, useCustomPlan } from './helpers/factories.js'

/**
 * Plan limits at the bulk-import boundary (SaaS §4.3, §8.3).
 *
 * The two importers behave DIFFERENTLY on purpose, and these tests sit next to
 * each other so the asymmetry is visible and hard to "fix" by accident:
 *
 *   employees → the file is refused whole. There is no defensible answer to
 *               "which 50 of your 60 new hires exist".
 *   questions → over-capacity rows come back as row errors and the rest import.
 *               Questions are fungible and their rows independent, so keeping
 *               the first 380 of 500 is a coherent outcome.
 *
 * §8.3's partial-import contract is about ROW-level defects — a bad phone, an
 * unknown outlet. A plan ceiling is not a property of any row, which is why it
 * is allowed to override that contract for employees.
 */

let app: Application

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app
})

afterAll(async () => {
  await disconnectDb()
})

async function adminToken() {
  const made = await makeUser({ role: 'admin', mustChangePassword: false })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
  expect(res.status).toBe(200)
  return res.body.data.accessToken as string
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

// Matches EMPLOYEE_IMPORT_COLUMNS exactly — see bulk-import.service.ts.
const EMPLOYEE_HEADER = 'first_name,last_name,phone,outlet_code,department,designation,joining_date'

function employeeCsv(count: number, startPhone = 9811000000): string {
  const rows = Array.from(
    { length: count },
    (_, i) => `Asha,Patel${i},${startPhone + i},AK,Kitchen,Line Cook,2026-02-01`
  )
  return [EMPLOYEE_HEADER, ...rows].join('\n')
}

const uploadEmployees = (token: string, csv: string, query = '') =>
  request(app)
    .post(`/api/v1/employees/bulk-import${query}`)
    .set(auth(token))
    .attach('file', Buffer.from(csv), { filename: 'staff.csv', contentType: 'text/csv' })

let seedPhone = 7700000000
async function seedEmployees(count: number) {
  const tenantId = testTenantId()
  const outlet = await testDb().outlet.findFirstOrThrow({ where: { tenantId, code: 'AK' } })
  const department = await testDb().department.findFirstOrThrow({ where: { tenantId, code: 'KIT' } })
  const designation = await testDb().designation.findFirstOrThrow({
    where: { tenantId, code: 'LCOOK' },
  })

  for (let i = 0; i < count; i++) {
    const phone = String(seedPhone++)
    const user = await testDb().user.create({
      data: { tenantId, phone, role: 'staff', passwordHash: 'x' },
    })
    await testDb().employee.create({
      data: {
        tenantId,
        userId: user.id,
        firstName: 'Seed',
        lastName: `E${i}`,
        phone,
        outletId: outlet.id,
        departmentId: department.id,
        designationId: designation.id,
        joiningDate: new Date('2026-01-01'),
      },
    })
  }
}

describe('§4.3 employee bulk import — the file is one decision', () => {
  it('imports the whole file when it fits exactly', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxEmployees: 5 })
    await seedEmployees(2)

    const res = await uploadEmployees(token, employeeCsv(3))
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(3)
    expect(await testDb().employee.count()).toBe(5)
  })

  it('refuses the whole file when it would overflow — and creates NOTHING', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxEmployees: 5 })
    await seedEmployees(3)

    // 3 used + 3 rows = 6 > 5. The pre-flight must fire before the insert loop,
    // not from inside it: importing 2 and erroring on the 3rd is exactly the
    // half-done outcome §23.2 calls a silent failure.
    const res = await uploadEmployees(token, employeeCsv(3))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED')
    expect(await testDb().employee.count()).toBe(3)
  })

  it('refuses by exactly one', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxEmployees: 5 })
    await seedEmployees(3)

    expect((await uploadEmployees(token, employeeCsv(2))).status).toBe(200)
  })

  it('tells the preview the truth rather than promising an import that would 403', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxEmployees: 5 })
    await seedEmployees(3)

    // A dryRun that cheerfully reports "3 valid" and then fails for real is
    // worse than no preview at all.
    const res = await uploadEmployees(token, employeeCsv(3), '?dryRun=true')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED')
    expect(await testDb().employee.count()).toBe(3)
  })

  it('imports any size on an unlimited plan', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxEmployees: null })
    await seedEmployees(3)

    const res = await uploadEmployees(token, employeeCsv(10))
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(10)
  })

  it('counts only importable rows against the plan, not rows that were already invalid', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxEmployees: 4 })
    await seedEmployees(2)

    // Three rows, one of which names an outlet that does not exist. Only two are
    // importable, so 2 + 2 = 4 fits — the bad row must not consume a seat it
    // will never occupy.
    const csv = [
      EMPLOYEE_HEADER,
      'Asha,Patel,9812200001,AK,Kitchen,Line Cook,2026-02-01',
      'Ravi,Shah,9812200002,NOPE,Kitchen,Line Cook,2026-02-01',
      'Meera,Joshi,9812200003,AK,Kitchen,Line Cook,2026-02-01',
    ].join('\n')

    const res = await uploadEmployees(token, csv)
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(2)
    expect(res.body.data.invalid).toBe(1)
  })
})

describe('§4.3 question bulk import — rows are independent', () => {
  // §10.4's columns; the subset the importer needs. All four options are
  // mandatory for an MCQ (§10.1), so a two-option row is a row error, not a
  // question — which would silently make every case here about the wrong thing.
  const QUESTION_HEADER = [
    'type',
    'difficulty',
    'department',
    'topic',
    'question_en',
    'option_a_en',
    'option_b_en',
    'option_c_en',
    'option_d_en',
    'correct_option',
    'marks',
    // §10.3 requires every question to cite a source. Without this column every
    // row is invalid for a reason that has nothing to do with plans.
    'source_document',
  ].join(',')

  const mcqRow = (i: number) =>
    `mcq,easy,Kitchen,Food Safety,"Question ${i}?","65C","74C","80C","90C",B,1,"Food Safety Manual"`
  const theoryRow = (i: number) =>
    `theory,easy,Kitchen,Food Safety,"Explain ${i}?",,,,,,5,"Food Safety Manual"`

  function questionCsv(count: number): string {
    return [QUESTION_HEADER, ...Array.from({ length: count }, (_, i) => mcqRow(i))].join('\n')
  }

  const uploadQuestions = (token: string, csv: string, query = '') =>
    request(app)
      .post(`/api/v1/questions/bulk-import${query}`)
      .set(auth(token))
      .attach('file', Buffer.from(csv), { filename: 'q.csv', contentType: 'text/csv' })

  // The importer resolves `topic` and `source_document` by name, so both must
  // exist or every row fails for reasons unrelated to plans.
  beforeEach(async () => {
    const tenantId = testTenantId()
    const dept = await testDb().department.findFirstOrThrow({ where: { tenantId, code: 'KIT' } })
    await testDb().topic.create({
      data: { tenantId, nameEn: 'Food Safety', departmentId: dept.id },
    })
    await testDb().sourceDocument.create({
      data: { tenantId, title: 'Food Safety Manual', type: 'sop', departmentId: dept.id },
    })
  })

  async function seedQuestions(count: number) {
    const tenantId = testTenantId()
    const dept = await testDb().department.findFirstOrThrow({ where: { tenantId, code: 'KIT' } })
    const admin = await testDb().user.findFirstOrThrow({ where: { tenantId } })
    for (let i = 0; i < count; i++) {
      await testDb().question.create({
        data: {
          tenantId,
          type: 'mcq',
          departmentId: dept.id,
          questionTextEn: `Seeded ${i}`,
          marks: 1,
          createdById: admin.id,
        },
      })
    }
  }

  it('imports what fits and reports the rest as row errors — NOT a 403', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxQuestions: 5 })
    await seedQuestions(3)

    // Room for 2 of the 4. Contrast the employee importer directly above: the
    // tenant keeps the work that fits.
    const res = await uploadQuestions(token, questionCsv(4))
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(2)
    expect(await testDb().question.count()).toBe(5)

    const refused = res.body.data.rows.filter(
      (r: { errors: unknown[] }) => r.errors.length > 0
    )
    expect(refused).toHaveLength(2)
    expect(refused[0].errors[0].message).toMatch(/plan allows 5 questions/)
  })

  it('imports nothing when already at the limit, and still answers 200', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxQuestions: 3 })
    await seedQuestions(3)

    const res = await uploadQuestions(token, questionCsv(2))
    // The route guard fast-fails an at-capacity tenant before the body is read.
    expect(res.status).toBe(403)
    expect(await testDb().question.count()).toBe(3)
  })

  it('imports every row on an unlimited plan', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxQuestions: null })

    const res = await uploadQuestions(token, questionCsv(6))
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(6)
  })

  it('refuses a row whose type the plan excludes, and imports the rest', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxQuestions: null, questionTypes: ['mcq'] })

    const csv = [QUESTION_HEADER, mcqRow(1), theoryRow(2)].join('\n')

    const res = await uploadQuestions(token, csv)
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)

    const refused = res.body.data.rows.find((r: { errors: unknown[] }) => r.errors.length > 0)
    expect(refused.errors[0].message).toMatch(/does not include theory/)
  })
})
