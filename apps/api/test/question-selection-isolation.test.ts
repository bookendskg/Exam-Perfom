import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { runInTenant, withTenantScope, createPrismaClient, type PrismaClient } from '@bookends/db'
import { truncateAll, disconnectDb, testDb, testTenantId } from './helpers/db.js'
import { QuestionSelector } from '../src/exams/question-selection.js'

/**
 * Cross-tenant isolation of the exam question selector.
 *
 * This exists because QuestionSelector reaches the question bank through
 * $queryRaw, and the tenant extension cannot see raw SQL — it hooks $allModels,
 * and a raw query is a client-level operation. So every guarantee the rest of
 * the system gets for free has to be made by hand here, and a test has to hold
 * it in place.
 *
 * The failure this guards against is the worst one this product can have: an
 * exam built from another customer's question bank, printed to your staff.
 */

let scoped: PrismaClient
let raw: PrismaClient
let alpha: string
let beta: string
let betaDeptId: string
let alphaDeptId: string

beforeEach(async () => {
  await truncateAll()

  const url = process.env['TEST_DATABASE_URL']
  if (!url) throw new Error('TEST_DATABASE_URL is unset — globalSetup did not run')
  raw = createPrismaClient(url)
  scoped = withTenantScope(raw)

  alpha = testTenantId()

  const other = await testDb().tenant.create({
    data: {
      slug: 'qs-beta',
      name: 'Rival Hospitality',
      ownerEmail: 'owner@rival.example',
      employeeCodePrefix: 'RV',
    },
  })
  beta = other.id

  const alphaDept = await testDb().department.findFirstOrThrow({
    where: { tenantId: alpha, code: 'KIT' },
  })
  alphaDeptId = alphaDept.id
  const betaDept = await testDb().department.create({
    data: { tenantId: beta, name: 'Kitchen', code: 'KIT' },
  })
  betaDeptId = betaDept.id

  const alphaAdmin = await testDb().user.create({
    data: { tenantId: alpha, phone: '9330000001', role: 'admin', passwordHash: 'x' },
  })
  const betaAdmin = await testDb().user.create({
    data: { tenantId: beta, phone: '9330000002', role: 'admin', passwordHash: 'x' },
  })

  // Beta's bank: approved, global (outlet_id NULL), exactly what an exam wants.
  for (let i = 0; i < 5; i++) {
    await testDb().question.create({
      data: {
        tenantId: beta,
        type: 'mcq',
        difficulty: 'easy',
        departmentId: betaDeptId,
        questionTextEn: `RIVAL CONFIDENTIAL ${i}: our proprietary recipe question`,
        marks: 1,
        status: 'approved',
        createdById: betaAdmin.id,
        options: [
          { id: 'A', text_en: '55C', is_correct: false },
          { id: 'B', text_en: '74C', is_correct: true },
        ],
      },
    })
  }

  // Alpha's bank: two of its own.
  for (let i = 0; i < 2; i++) {
    await testDb().question.create({
      data: {
        tenantId: alpha,
        type: 'mcq',
        difficulty: 'easy',
        departmentId: alphaDeptId,
        questionTextEn: `Ours ${i}`,
        marks: 1,
        status: 'approved',
        createdById: alphaAdmin.id,
        options: [
          { id: 'A', text_en: '55C', is_correct: false },
          { id: 'B', text_en: '74C', is_correct: true },
        ],
      },
    })
  }
})

afterAll(async () => {
  await disconnectDb()
})

const RULES = {
  mcq: { distribution: [{ count: 10 }] },
} as const

describe('QuestionSelector cannot reach another tenant’s question bank', () => {
  it('selects only this tenant’s questions when nothing is targeted', async () => {
    const selector = new QuestionSelector(scoped)

    // The dangerous shape: a tenant-wide exam with no department/outlet/topic
    // targeting, so the WHERE degrades to type + status. Alpha owns 2 approved
    // MCQs; Beta owns 5. Asking for 10 must yield Alpha's 2 and nothing else.
    const result = await runInTenant(alpha, () =>
      selector.select(RULES as never, { outletId: null, departmentId: null })
    )

    const ids = result.questions.map((q) => q.id)
    const rows = await testDb().question.findMany({
      where: { id: { in: ids } },
      select: { tenantId: true, questionTextEn: true },
    })

    expect(rows.every((r) => r.tenantId === alpha)).toBe(true)
    expect(rows.some((r) => r.questionTextEn.includes('RIVAL CONFIDENTIAL'))).toBe(false)
    expect(result.questions).toHaveLength(2)
  })

  it('does not pull another tenant’s GLOBAL questions in via the outlet_id IS NULL branch', async () => {
    const outlet = await testDb().outlet.findFirstOrThrow({
      where: { tenantId: alpha, code: 'AK' },
    })
    const selector = new QuestionSelector(scoped)

    // outlet_id IS NULL means "applies to every outlet" — of THIS tenant. An
    // outlet-targeted exam draws on the global bank, and that branch is the one
    // that silently reached across tenants: every rival question above is global.
    const result = await runInTenant(alpha, () =>
      selector.select(RULES as never, { outletId: outlet.id, departmentId: null })
    )

    const rows = await testDb().question.findMany({
      where: { id: { in: result.questions.map((q) => q.id) } },
      select: { tenantId: true },
    })
    expect(rows.every((r) => r.tenantId === alpha)).toBe(true)
  })

  it('does not match another tenant’s department even when the codes are identical', async () => {
    const selector = new QuestionSelector(scoped)

    // Both tenants have a department coded KIT. Targeting BETA's department id
    // from ALPHA's scope must return nothing — not Beta's five.
    const result = await runInTenant(alpha, () =>
      selector.select(RULES as never, { outletId: null, departmentId: betaDeptId })
    )

    expect(result.questions).toHaveLength(0)
  })

  it('reports a shortfall rather than quietly topping up from elsewhere', async () => {
    const selector = new QuestionSelector(scoped)

    const result = await runInTenant(alpha, () =>
      selector.select(RULES as never, { outletId: null, departmentId: null })
    )

    // Asked for 10, this tenant has 2. The honest answer is "2, and here is the
    // shortfall" — filling the gap from the platform's other customers is the
    // bug this file exists to prevent.
    expect(result.shortfalls.length).toBeGreaterThan(0)
  })
})
