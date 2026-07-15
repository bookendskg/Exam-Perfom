import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { pino } from 'pino'
import { runInTenant } from '@bookends/db'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb, testTenantId, TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser, useCustomPlan } from './helpers/factories.js'
import { SchedulerService } from '../src/scheduling/scheduler.service.js'

/**
 * maxExamsPerMonth (SaaS §4.3).
 *
 * Separated from the other limits because exams are the only resource with two
 * doors — POST /exams and the auto-scheduling cron — and the only one whose
 * limit has a *window*, which can be got wrong in a way no other limit can.
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

/** A question the exam can be built from — publish needs at least one. */
async function seedQuestion(createdById: string) {
  const tenantId = testTenantId()
  const department = await testDb().department.findFirstOrThrow({ where: { tenantId, code: 'KIT' } })
  return testDb().question.create({
    data: {
      tenantId,
      type: 'mcq',
      departmentId: department.id,
      questionTextEn: 'What temperature for chicken?',
      marks: 1,
      status: 'approved',
      createdById,
      options: [
        { id: 'A', text_en: '55C', is_correct: false },
        { id: 'B', text_en: '74C', is_correct: true },
      ],
    },
  })
}

const postExam = (token: string, scheduledDate: string, nameEn = 'Monthly Exam') =>
  request(app).post('/api/v1/exams').set(auth(token)).send({
    nameEn,
    scheduledDate,
    startTime: '10:00',
    endTime: '12:00',
    durationMinutes: 60,
    totalMarks: 10,
    passingPercentage: 40,
  })

describe('§4.3 maxExamsPerMonth — the boundary', () => {
  it('allows exams up to the limit and refuses the next', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxExamsPerMonth: 2 })

    expect((await postExam(token, '2026-08-10')).status).toBe(201)
    expect((await postExam(token, '2026-08-20')).status).toBe(201)

    const third = await postExam(token, '2026-08-25')
    expect(third.status).toBe(403)
    expect(third.body.error.code).toBe('PLAN_LIMIT_REACHED')
    expect(third.body.error.message).toContain('2 exams per month')
  })

  it('is unlimited on NULL — professional, the anchor’s own plan, is null here', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxExamsPerMonth: null })

    for (const day of ['05', '10', '15', '20', '25']) {
      expect((await postExam(token, `2026-08-${day}`)).status).toBe(201)
    }
  })

  it('does not burn an exam code on a refused exam', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxExamsPerMonth: 1 })

    expect((await postExam(token, '2026-08-10')).status).toBe(201)

    // Read the counter AFTER the accepted exam, not from zero: truncateAll
    // spares exam_code_counters (§8.2 codes are never reused, so the sequence is
    // meant to survive), and the property under test is relative anyway.
    const seq = async () =>
      (
        await testDb().examCodeCounter.findFirstOrThrow({
          where: { tenantId: testTenantId(), period: '2026-08' },
        })
      ).lastSeq

    const before = await seq()
    expect((await postExam(token, '2026-08-20')).status).toBe(403)

    // The limit check runs before claimExamCode, so a refused exam must not
    // consume a number — otherwise a tenant repeatedly hitting their cap would
    // punch permanent holes in a sequence exam-code.ts calls unfixable later.
    expect(await seq()).toBe(before)
  })
})

describe('§4.3 maxExamsPerMonth — which month', () => {
  /**
   * The limit is keyed on the month the exam RUNS in, not the month it was
   * created. Both these exams are created "now"; only their scheduled months
   * differ. If the implementation keyed on creation, August's cap would block
   * the September exam too.
   */
  it('counts against the scheduled month, not the month of creation', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxExamsPerMonth: 1 })

    expect((await postExam(token, '2026-08-10')).status).toBe(201)
    // August is full...
    expect((await postExam(token, '2026-08-20')).status).toBe(403)
    // ...but September is untouched, though both were created in the same breath.
    expect((await postExam(token, '2026-09-10')).status).toBe(201)
  })

  it('treats the last day of a month and the first of the next as different months', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxExamsPerMonth: 1 })

    expect((await postExam(token, '2026-08-31')).status).toBe(201)
    expect((await postExam(token, '2026-09-01')).status).toBe(201)
    expect((await postExam(token, '2026-08-01')).status).toBe(403)
  })

  it('rolls the year over at December', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxExamsPerMonth: 1 })

    expect((await postExam(token, '2026-12-15')).status).toBe(201)
    expect((await postExam(token, '2027-01-15')).status).toBe(201)
    expect((await postExam(token, '2026-12-20')).status).toBe(403)
  })

  it('frees a slot when an exam is cancelled — quota is not an exam code', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxExamsPerMonth: 1 })

    const first = await postExam(token, '2026-08-10')
    expect((await postExam(token, '2026-08-20')).status).toBe(403)

    await testDb().exam.update({
      where: { id: first.body.data.id },
      data: { status: 'cancelled' },
    })

    // Deliberately unlike claimExamCode, which never frees a number. A cancelled
    // exam was not conducted, and the meter is named examsConducted.
    expect((await postExam(token, '2026-08-20')).status).toBe(201)
  })
})

describe('§4.3 the exam limit blocks scheduling, never completion', () => {
  it('still publishes an existing draft when the tenant is over its limit', async () => {
    const token = await adminToken()
    await useCustomPlan({ maxExamsPerMonth: 1 })

    const admin = await testDb().user.findFirstOrThrow({ where: { tenantId: testTenantId() } })
    const question = await seedQuestion(admin.id)

    const created = await postExam(token, '2026-08-10')
    expect(created.status).toBe(201)

    // Tenant is now at 1/1 — a new exam would 403.
    expect((await postExam(token, '2026-08-20')).status).toBe(403)

    await testDb().examQuestion.create({
      data: {
        tenantId: testTenantId(),
        examId: created.body.data.id,
        questionId: question.id,
        sortOrder: 0,
        marks: 1,
      },
    })
    await testDb().exam.update({
      where: { id: created.body.data.id },
      data: { totalMarks: 1 },
    })

    // Publish is an UPDATE of a row already created and already counted. If this
    // ever 403s, the limit has started blocking work in progress — which §4.3
    // explicitly forbids, and which would strand auto-scheduled exams as drafts.
    const published = await request(app)
      .post(`/api/v1/exams/${created.body.data.id}/publish`)
      .set(auth(token))
      .send({})

    expect(published.status).toBe(200)
  })
})

describe('§4.3 the auto-scheduler is the other door', () => {
  /**
   * The test that fails if planGuard is ever implemented as middleware only.
   * The cron has no Express, no req, and creates exams per outlet, unattended,
   * every month — it is the single biggest way to blow past a plan.
   */
  it('cannot schedule past the limit', async () => {
    const admin = await makeUser({ role: 'admin', mustChangePassword: false })
    const tenantId = testTenantId()

    // A template and a config, so the job has something to schedule.
    const question = await seedQuestion(admin.user.id)
    const department = await testDb().department.findFirstOrThrow({
      where: { tenantId, code: 'KIT' },
    })
    const template = await testDb().examTemplate.create({
      data: {
        tenantId,
        nameEn: 'Monthly Kitchen Exam',
        departmentId: department.id,
        totalMarks: 1,
        durationMinutes: 60,
        mcqCount: 1,
        createdById: admin.user.id,
      },
    })
    await testDb().examScheduleConfig.create({
      data: { tenantId, dayOfMonth: 15, templateId: template.id, isActive: true },
    })
    expect(question).toBeTruthy()

    // Three active outlets, one global config → the job wants three exams.
    // The plan allows one, and permits auto-scheduling at all.
    await useCustomPlan({ maxExamsPerMonth: 1, autoScheduling: true })

    const scheduler = new SchedulerService(testDb(), pino({ level: 'silent' }))
    const run = await scheduler.run(new Date('2026-08-01T00:30:00+05:30'))

    // The job must not be a way around the plan.
    expect(run.scheduled).toBeLessThanOrEqual(1)
    const exams = await runInTenant(tenantId, () =>
      testDb().exam.count({ where: { tenantId, scheduledDate: { gte: new Date('2026-08-01') } } })
    )
    expect(exams).toBeLessThanOrEqual(1)

    // And it must not die on the outlet that hit the limit — the others simply
    // report failure, per its own "one outlet failing must not stop the others".
    expect(run.results.length).toBe(3)
    expect(run.results.some((r) => r.status === 'failed')).toBe(true)
  })

  it('skips a tenant whose plan excludes auto-scheduling', async () => {
    await useCustomPlan({ maxExamsPerMonth: null, autoScheduling: false })

    const scheduler = new SchedulerService(testDb(), pino({ level: 'silent' }))
    const run = await scheduler.run(new Date('2026-08-01T00:30:00+05:30'))

    expect(run.scheduled).toBe(0)
    expect(run.results).toEqual([])
  })
})
