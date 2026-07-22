import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

/**
 * Cross-outlet exam assignment (§3.2 scope).
 *
 * `ExamService.assignEmployees` took neither `principal` nor `scope`, so the
 * caller-supplied `employeeIds` array was honoured verbatim. An outlet_manager
 * could create an exam for an outlet they legitimately manage and then assign
 * staff belonging to outlets they do not — a write straight across the scope
 * boundary. Those employees were then required to sit the exam, their identity
 * and results were readable back through GET /exams/:id/assignments, and
 * POST /exams/:id/cancel would overwrite their supervisorRemarks.
 */
let app: Application
let org: { aiko: string; capiche: string; kitchen: string; lineCook: string }

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  app = buildTestApp().app

  const db = testDb()
  const [aiko, capiche, kitchen, lineCook] = await Promise.all([
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'CP' } }),
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.designation.findFirstOrThrow({ where: { code: 'LCOOK' } }),
  ])
  org = { aiko: aiko.id, capiche: capiche.id, kitchen: kitchen.id, lineCook: lineCook.id }
})

afterAll(async () => {
  await disconnectDb()
})

async function tokenFor(opts: Parameters<typeof makeUser>[0]) {
  const made = await makeUser({ mustChangePassword: false, ...opts })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ phone: made.phone, password: made.password })
  expect(res.status, `login failed: ${JSON.stringify(res.body)}`).toBe(200)
  return { token: res.body.data.accessToken as string, ...made }
}

/** An employee row created directly, so the test does not depend on employee routes. */
async function employeeAt(outletId: string) {
  const { user } = await makeUser({ role: 'staff' })
  return testDb().employee.create({
    data: {
      userId: user.id,
      firstName: 'Scoped',
      lastName: 'Employee',
      phone: `97${Math.floor(Math.random() * 100_000_000)}`.slice(0, 10),
      outletId,
      departmentId: org.kitchen,
      designationId: org.lineCook,
      joiningDate: new Date('2026-02-01'),
      employmentStatus: 'active',
    },
  })
}

describe('exam assignment respects outlet scope', () => {
  it('silently drops employees outside the manager’s outlets', async () => {
    const mine = await employeeAt(org.aiko)
    const theirs = await employeeAt(org.capiche)

    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const created = await request(app)
      .post('/api/v1/exams')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nameEn: 'Scope probe',
        outletId: org.aiko,
        scheduledDate: '2026-12-01',
        startTime: '10:00',
        endTime: '11:00',
        durationMinutes: 60,
        totalMarks: 10,
        employeeIds: [mine.id, theirs.id],
      })

    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const examId = created.body.data.id as string

    const assigned = await testDb().examAssignment.findMany({
      where: { examId },
      select: { employeeId: true },
    })
    const ids = assigned.map((a) => a.employeeId)

    expect(ids).toContain(mine.id)
    // The whole point: a foreign-outlet employee must not be conscripted.
    expect(ids).not.toContain(theirs.id)
  })

  it('does not leak foreign employees through GET /exams/:id/assignments', async () => {
    const mine = await employeeAt(org.aiko)
    const theirs = await employeeAt(org.capiche)

    // An admin (scope: all) legitimately assigns both.
    const admin = await tokenFor({ role: 'admin' })
    const created = await request(app)
      .post('/api/v1/exams')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        nameEn: 'Group exam',
        scheduledDate: '2026-12-02',
        startTime: '10:00',
        endTime: '11:00',
        durationMinutes: 60,
        totalMarks: 10,
        employeeIds: [mine.id, theirs.id],
      })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const examId = created.body.data.id as string

    // The exam has no outlet, so it is globally readable — but the roster is
    // still per-outlet. Scoping only the exam let the whole roster through.
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await request(app)
      .get(`/api/v1/exams/${examId}/assignments`)
      .set('Authorization', `Bearer ${manager.token}`)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const seen = res.body.data.map((a: { employee: { id: string } }) => a.employee.id)

    expect(seen).toContain(mine.id)
    expect(seen).not.toContain(theirs.id)
  })

  it('still lets an admin assign across outlets', async () => {
    const atAiko = await employeeAt(org.aiko)
    const atCapiche = await employeeAt(org.capiche)

    const { token } = await tokenFor({ role: 'admin' })
    const created = await request(app)
      .post('/api/v1/exams')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nameEn: 'Group-wide',
        scheduledDate: '2026-12-03',
        startTime: '10:00',
        endTime: '11:00',
        durationMinutes: 60,
        totalMarks: 10,
        employeeIds: [atAiko.id, atCapiche.id],
      })

    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const ids = (
      await testDb().examAssignment.findMany({
        where: { examId: created.body.data.id as string },
        select: { employeeId: true },
      })
    ).map((a) => a.employeeId)

    // The fix must narrow outlet_manager without crippling `all`.
    expect(ids).toContain(atAiko.id)
    expect(ids).toContain(atCapiche.id)
  })
})
