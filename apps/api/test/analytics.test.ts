import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { runInTenant } from '@bookends/db'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb , testTenantId , TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'
import { SnapshotService } from '../src/analytics/snapshot.service.js'

let app: Application
let ctx: { kitchen: string; service: string; aiko: string; capiche: string; authorId: string }

const YEAR = 2027
const MONTH = 3

beforeEach(async () => {
  await truncateAll()
  await testDb().examCodeCounter.deleteMany()
  app = buildTestApp().app

  const db = testDb()
  const [kitchen, service, aiko, capiche] = await Promise.all([
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.department.findFirstOrThrow({ where: { code: 'SRV' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'CP' } }),
  ])
  const author = await makeUser({ role: 'admin', mustChangePassword: false })

  ctx = {
    kitchen: kitchen.id,
    service: service.id,
    aiko: aiko.id,
    capiche: capiche.id,
    authorId: author.user.id,
  }
})

afterAll(async () => {
  await disconnectDb()
})

async function tokenFor(opts: Parameters<typeof makeUser>[0]) {
  const made = await makeUser({ mustChangePassword: false, ...opts })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
  expect(res.status).toBe(200)
  return { token: res.body.data.accessToken as string, ...made }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

/** An employee who sat an exam and scored `percentage`. */
async function sitter(opts: {
  outlet: 'AK' | 'CP'
  percentage: number | null
  month?: number
  year?: number
  status?: 'graded' | 'absent' | 'exempted'
  topicScore?: { topicId: string; marks: number; max: number }
}) {
  const made = await makeUser({
    role: 'staff',
    withEmployee: true,
    employeeOutletCode: opts.outlet,
    mustChangePassword: false,
  })
  const employee = await testDb().employee.findFirstOrThrow({ where: { userId: made.user.id } })

  const exam = await testDb().exam.create({
    data: { tenantId: testTenantId(),
      examCode: `EX-AN-${Math.floor(Math.random() * 10_000_000)}`,
      nameEn: 'Monthly Exam',
      scheduledDate: new Date(Date.UTC(opts.year ?? YEAR, (opts.month ?? MONTH) - 1, 15)),
      startTime: new Date('1970-01-01T10:00:00.000Z'),
      endTime: new Date('1970-01-01T12:00:00.000Z'),
      outletId: opts.outlet === 'AK' ? ctx.aiko : ctx.capiche,
      totalMarks: 10,
      passingPercentage: 40,
      durationMinutes: 60,
      status: 'completed',
      createdById: ctx.authorId,
    },
  })

  const status = opts.status ?? 'graded'
  const assignment = await testDb().examAssignment.create({
    data: { tenantId: testTenantId(),
      examId: exam.id,
      employeeId: employee.id,
      status,
      ...(status === 'graded' && opts.percentage !== null
        ? {
            percentage: opts.percentage,
            passed: opts.percentage >= 40,
            totalMarksObtained: opts.percentage / 10,
          }
        : {}),
    },
  })

  if (opts.topicScore) {
    const question = await testDb().question.create({
      data: { tenantId: testTenantId(),
        type: 'mcq',
        topicId: opts.topicScore.topicId,
        departmentId: ctx.kitchen,
        questionTextEn: 'Q',
        marks: opts.topicScore.max,
        status: 'approved',
        options: [{ id: 'a', textEn: 'A', isCorrect: true }],
        createdById: ctx.authorId,
      },
    })
    const eq = await testDb().examQuestion.create({
      data: { tenantId: testTenantId(), examId: exam.id, questionId: question.id, sortOrder: 0, marks: opts.topicScore.max },
    })
    await testDb().examResponse.create({
      data: { tenantId: testTenantId(),
        examAssignmentId: assignment.id,
        examQuestionId: eq.id,
        questionId: question.id,
        responseType: 'mcq',
        maxMarks: opts.topicScore.max,
        marksObtained: opts.topicScore.marks,
        isAutoGraded: true,
      },
    })
  }

  return { employee, exam, assignment }
}

/**
 * Driven directly rather than over HTTP, so there is no request to carry a
 * tenant — the scope has to be opened here. In production this is a job, and
 * scheduler.service.ts opens the same scope per tenant for the same reason.
 */
const rebuild = (year = YEAR, month = MONTH) =>
  runInTenant(testTenantId(), () => new SnapshotService(testDb()).rebuild(year, month))

describe('§4.1 performance snapshots', () => {
  it('rolls up an employee’s month', async () => {
    await sitter({ outlet: 'AK', percentage: 80 })
    const result = await rebuild()

    expect(result.employees).toBe(1)
    const snapshot = await testDb().performanceSnapshot.findFirstOrThrow()
    expect(snapshot.examsAssigned).toBe(1)
    expect(snapshot.examsAttempted).toBe(1)
    expect(snapshot.examsPassed).toBe(1)
    expect(Number(snapshot.averageScore)).toBe(80)
    expect(Number(snapshot.highestScore)).toBe(80)
  })

  it('is a rebuild, not a patch — running twice does not double-count', async () => {
    await sitter({ outlet: 'AK', percentage: 80 })
    await rebuild()
    await rebuild()

    // A rollup that drifts from the responses it summarises is worse than none,
    // because nobody can tell it is wrong.
    const snapshots = await testDb().performanceSnapshot.findMany()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.examsAssigned).toBe(1)
  })

  it('counts an absent employee as missed, not as a zero score', async () => {
    await sitter({ outlet: 'AK', percentage: null, status: 'absent' })
    await rebuild()

    const snapshot = await testDb().performanceSnapshot.findFirstOrThrow()
    expect(snapshot.examsMissed).toBe(1)
    expect(snapshot.examsAttempted).toBe(0)
    // Missing an exam is not scoring zero — averaging in a 0 would be a
    // different and much harsher claim.
    expect(snapshot.averageScore).toBeNull()
  })

  it('counts an exempted employee as neither attempted nor missed', async () => {
    await sitter({ outlet: 'AK', percentage: null, status: 'exempted' })
    await rebuild()

    // The exam was withdrawn (§11's cancel path). §9 must not hold that against
    // them.
    const snapshot = await testDb().performanceSnapshot.findFirstOrThrow()
    expect(snapshot.examsMissed).toBe(0)
    expect(snapshot.examsAttempted).toBe(0)
  })

  it('ignores a cancelled exam entirely', async () => {
    const { exam } = await sitter({ outlet: 'AK', percentage: 80 })
    await testDb().exam.update({ where: { id: exam.id }, data: { status: 'cancelled' } })

    const result = await rebuild()
    expect(result.employees).toBe(0)
  })

  it('keys on the exam’s month, not when it was graded', async () => {
    // §12.1's weekend shift moves exams, and a paper graded in April still
    // belongs to March if that is when it was sat.
    await sitter({ outlet: 'AK', percentage: 80, month: 3 })
    await rebuild(YEAR, 4)

    expect(await testDb().performanceSnapshot.count({ where: { month: 4 } })).toBe(0)
    await rebuild(YEAR, 3)
    expect(await testDb().performanceSnapshot.count({ where: { month: 3 } })).toBe(1)
  })
})

describe('§4.1 ranks', () => {
  it('ranks within outlet, department and overall', async () => {
    const top = await sitter({ outlet: 'AK', percentage: 90 })
    const mid = await sitter({ outlet: 'AK', percentage: 70 })
    await sitter({ outlet: 'CP', percentage: 80 })
    await rebuild()

    const topSnap = await testDb().performanceSnapshot.findFirstOrThrow({
      where: { employeeId: top.employee.id },
    })
    const midSnap = await testDb().performanceSnapshot.findFirstOrThrow({
      where: { employeeId: mid.employee.id },
    })

    expect(topSnap.overallRank).toBe(1)
    expect(topSnap.outletRank).toBe(1)
    // Second at Aiko, but third overall — Capiche's 80 sits between them.
    expect(midSnap.outletRank).toBe(2)
    expect(midSnap.overallRank).toBe(3)
  })

  it('gives tied scores the same rank (1,2,2,4)', async () => {
    const a = await sitter({ outlet: 'AK', percentage: 90 })
    const b = await sitter({ outlet: 'AK', percentage: 80 })
    const c = await sitter({ outlet: 'AK', percentage: 80 })
    const d = await sitter({ outlet: 'AK', percentage: 70 })
    await rebuild()

    const rankOf = async (id: string) =>
      (await testDb().performanceSnapshot.findFirstOrThrow({ where: { employeeId: id } }))
        .overallRank

    // They can see each other's badges; splitting a tie on a tiebreak nobody
    // chose would be arbitrary and visible.
    expect(await rankOf(a.employee.id)).toBe(1)
    expect(await rankOf(b.employee.id)).toBe(2)
    expect(await rankOf(c.employee.id)).toBe(2)
    expect(await rankOf(d.employee.id)).toBe(4)
  })

  it('leaves an unranked employee null rather than last', async () => {
    await sitter({ outlet: 'AK', percentage: 90 })
    const absent = await sitter({ outlet: 'AK', percentage: null, status: 'absent' })
    await rebuild()

    const snapshot = await testDb().performanceSnapshot.findFirstOrThrow({
      where: { employeeId: absent.employee.id },
    })
    // They did not perform badly; there is nothing to rank.
    expect(snapshot.overallRank).toBeNull()
  })
})

describe('§4.1 improvement_from_last', () => {
  it('is the change from last month', async () => {
    const made = await makeUser({
      role: 'staff',
      withEmployee: true,
      employeeOutletCode: 'AK',
      mustChangePassword: false,
    })
    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: made.user.id } })

    await testDb().performanceSnapshot.create({
      data: { tenantId: testTenantId(), employeeId: employee.id, year: YEAR, month: 2, averageScore: 60 },
    })

    // Same employee, this month, scoring 75.
    const exam = await testDb().exam.create({
      data: { tenantId: testTenantId(),
        examCode: 'EX-IMP-1',
        nameEn: 'Exam',
        scheduledDate: new Date(Date.UTC(YEAR, MONTH - 1, 15)),
        startTime: new Date('1970-01-01T10:00:00.000Z'),
        endTime: new Date('1970-01-01T12:00:00.000Z'),
        outletId: ctx.aiko,
        totalMarks: 10,
        durationMinutes: 60,
        status: 'completed',
        createdById: ctx.authorId,
      },
    })
    await testDb().examAssignment.create({
      data: { tenantId: testTenantId(),
        examId: exam.id,
        employeeId: employee.id,
        status: 'graded',
        percentage: 75,
        passed: true,
      },
    })

    await rebuild()
    const snapshot = await testDb().performanceSnapshot.findFirstOrThrow({
      where: { employeeId: employee.id, month: MONTH },
    })
    expect(Number(snapshot.improvementFromLast)).toBe(15)
  })

  it('is null on a first month, not zero', async () => {
    await sitter({ outlet: 'AK', percentage: 80 })
    await rebuild()

    // Zero would read as "no improvement", which is a different claim.
    const snapshot = await testDb().performanceSnapshot.findFirstOrThrow()
    expect(snapshot.improvementFromLast).toBeNull()
  })

  it('rolls the year over at January', async () => {
    const made = await makeUser({
      role: 'staff',
      withEmployee: true,
      employeeOutletCode: 'AK',
      mustChangePassword: false,
    })
    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: made.user.id } })
    await testDb().performanceSnapshot.create({
      data: { tenantId: testTenantId(), employeeId: employee.id, year: 2026, month: 12, averageScore: 50 },
    })

    const exam = await testDb().exam.create({
      data: { tenantId: testTenantId(),
        examCode: 'EX-JAN-1',
        nameEn: 'Exam',
        scheduledDate: new Date(Date.UTC(2027, 0, 15)),
        startTime: new Date('1970-01-01T10:00:00.000Z'),
        endTime: new Date('1970-01-01T12:00:00.000Z'),
        outletId: ctx.aiko,
        totalMarks: 10,
        durationMinutes: 60,
        status: 'completed',
        createdById: ctx.authorId,
      },
    })
    await testDb().examAssignment.create({
      data: { tenantId: testTenantId(),
        examId: exam.id,
        employeeId: employee.id,
        status: 'graded',
        percentage: 65,
        passed: true,
      },
    })

    await rebuild(2027, 1)
    const snapshot = await testDb().performanceSnapshot.findFirstOrThrow({
      where: { employeeId: employee.id, year: 2027, month: 1 },
    })
    // January's previous month is last December, not month 0.
    expect(Number(snapshot.improvementFromLast)).toBe(15)
  })
})

describe('§5.3 analytics endpoints', () => {
  it('summarises the month on the dashboard', async () => {
    await sitter({ outlet: 'AK', percentage: 80 })
    await sitter({ outlet: 'CP', percentage: 60 })
    await rebuild()
    const { token } = await tokenFor({ role: 'admin' })

    const res = await request(app)
      .get(`/api/v1/analytics/dashboard?year=${YEAR}&month=${MONTH}`)
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data.averageScore).toBe(70)
    expect(res.body.data.examsAttempted).toBe(2)
    expect(res.body.data.passRate).toBe(100)
  })

  it('compares outlets, best first (§1.2)', async () => {
    await sitter({ outlet: 'AK', percentage: 90 })
    await sitter({ outlet: 'CP', percentage: 50 })
    await rebuild()
    const { token } = await tokenFor({ role: 'admin' })

    const res = await request(app)
      .get(`/api/v1/analytics/outlet-comparison?year=${YEAR}&month=${MONTH}`)
      .set(auth(token))

    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].outlet.code).toBe('AK')
    expect(res.body.data[0].averageScore).toBe(90)
  })

  it('plots a trend oldest-first', async () => {
    await sitter({ outlet: 'AK', percentage: 50, month: 1 })
    await sitter({ outlet: 'AK', percentage: 70, month: 2 })
    await sitter({ outlet: 'AK', percentage: 90, month: 3 })
    await rebuild(YEAR, 1)
    await rebuild(YEAR, 2)
    await rebuild(YEAR, 3)
    const { token } = await tokenFor({ role: 'admin' })

    const res = await request(app).get('/api/v1/analytics/trend?months=6').set(auth(token))
    expect(res.body.data.map((p: { period: string }) => p.period)).toEqual([
      '2027-01',
      '2027-02',
      '2027-03',
    ])
    // A trend chart plots left to right.
    expect(res.body.data[0].averageScore).toBe(50)
    expect(res.body.data[2].averageScore).toBe(90)
  })

  it('finds weak topics, weakest first (§1.2)', async () => {
    const strong = await testDb().topic.create({
      data: { tenantId: testTenantId(), nameEn: 'Hygiene', departmentId: ctx.kitchen },
    })
    const weak = await testDb().topic.create({
      data: { tenantId: testTenantId(), nameEn: 'Food Safety', departmentId: ctx.kitchen },
    })

    await sitter({
      outlet: 'AK',
      percentage: 80,
      topicScore: { topicId: strong.id, marks: 9, max: 10 },
    })
    await sitter({
      outlet: 'AK',
      percentage: 40,
      topicScore: { topicId: weak.id, marks: 2, max: 10 },
    })
    await rebuild()
    const { token } = await tokenFor({ role: 'admin' })

    const res = await request(app)
      .get(`/api/v1/analytics/weak-areas?year=${YEAR}&month=${MONTH}`)
      .set(auth(token))

    // This list exists to be acted on from the top.
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].topic.nameEn).toBe('Food Safety')
    expect(res.body.data[0].percentage).toBe(20)
  })

  it('ranks the leaderboard', async () => {
    await sitter({ outlet: 'AK', percentage: 95 })
    await sitter({ outlet: 'CP', percentage: 60 })
    await rebuild()
    const { token } = await tokenFor({ role: 'admin' })

    const res = await request(app)
      .get(`/api/v1/analytics/leaderboard?year=${YEAR}&month=${MONTH}`)
      .set(auth(token))

    expect(res.body.data[0].rank).toBe(1)
    expect(Number(res.body.data[0].averageScore)).toBe(95)
    expect(res.body.data[0].employee.employeeCode).toBeTruthy()
  })
})

describe('§3.2 RBAC — reports', () => {
  it('scopes an outlet_manager to their own outlet', async () => {
    await sitter({ outlet: 'AK', percentage: 90 })
    await sitter({ outlet: 'CP', percentage: 50 })
    await rebuild()
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .get(`/api/v1/analytics/dashboard?year=${YEAR}&month=${MONTH}`)
      .set(auth(manager.token))

    expect(res.status).toBe(200)
    // Aiko's 90 only — Capiche's 50 must not move their average.
    expect(res.body.data.averageScore).toBe(90)
  })

  it('shows an outlet_manager only their own outlet in the comparison', async () => {
    await sitter({ outlet: 'AK', percentage: 90 })
    await sitter({ outlet: 'CP', percentage: 50 })
    await rebuild()
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .get(`/api/v1/analytics/outlet-comparison?year=${YEAR}&month=${MONTH}`)
      .set(auth(manager.token))
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].outlet.code).toBe('AK')
  })

  it('lets hr see everything (§3.2)', async () => {
    await sitter({ outlet: 'AK', percentage: 90 })
    await sitter({ outlet: 'CP', percentage: 50 })
    await rebuild()
    const { token } = await tokenFor({ role: 'hr' })

    const res = await request(app)
      .get(`/api/v1/analytics/outlet-comparison?year=${YEAR}&month=${MONTH}`)
      .set(auth(token))
    expect(res.body.data).toHaveLength(2)
  })

  it('denies trainers and staff (§3.2 "View all reports")', async () => {
    for (const role of ['trainer', 'staff'] as const) {
      const { token } = await tokenFor({ role, withEmployee: role === 'staff' })
      const res = await request(app).get('/api/v1/analytics/dashboard').set(auth(token))
      expect(res.status, `${role} must not read reports`).toBe(403)
    }
  })

  it('denies everyone but admins the snapshot rebuild', async () => {
    for (const role of ['outlet_manager', 'trainer', 'hr', 'staff'] as const) {
      const { token } = await tokenFor({
        role,
        withEmployee: role === 'staff',
        managesOutletCodes: role === 'outlet_manager' ? ['AK'] : undefined,
      })
      // It rewrites everyone's numbers.
      const res = await request(app)
        .post('/api/v1/analytics/snapshots/rebuild')
        .set(auth(token))
        .send({ year: YEAR, month: MONTH })
      expect(res.status, `${role} must not rebuild snapshots`).toBe(403)
    }
  })

  it('rebuilds via the API for an admin', async () => {
    await sitter({ outlet: 'AK', percentage: 80 })
    const { token } = await tokenFor({ role: 'admin' })

    const res = await request(app)
      .post('/api/v1/analytics/snapshots/rebuild')
      .set(auth(token))
      .send({ year: YEAR, month: MONTH })
    expect(res.status).toBe(200)
    expect(res.body.data.employees).toBe(1)
  })
})
