import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { pino } from 'pino'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb , testTenantId , TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'
import { SchedulerService } from '../src/scheduling/scheduler.service.js'

let app: Application
let ctx: { kitchen: string; aiko: string; capiche: string; prep: string; topic: string }

/** 00:00 IST on 1 March 2027 — the instant §12.2's job fires. */
const FIRES_AT = new Date('2027-02-28T18:30:00.000Z')
const silent = pino({ level: 'silent' })

beforeEach(async () => {
  await truncateAll()
  await testDb().examCodeCounter.deleteMany()
  await testDb().examScheduleConfig.deleteMany()
  app = buildTestApp().app

  const db = testDb()
  const [kitchen, aiko, capiche, prep] = await Promise.all([
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'CP' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'PR' } }),
  ])
  const topic = await db.topic.create({ data: { tenantId: testTenantId(), nameEn: 'Food Safety', departmentId: kitchen.id } })

  ctx = { kitchen: kitchen.id, aiko: aiko.id, capiche: capiche.id, prep: prep.id, topic: topic.id }
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

async function seedApprovedQuestions(count: number) {
  const author = await testDb().user.findFirstOrThrow()
  for (let i = 0; i < count; i++) {
    await testDb().question.create({
      data: { tenantId: testTenantId(),
        type: 'mcq',
        difficulty: 'easy',
        topicId: ctx.topic,
        departmentId: ctx.kitchen,
        outletId: null, // global bank
        questionTextEn: `Q${i} ${Math.random()}`,
        marks: 1,
        status: 'approved',
        options: [
          { id: 'a', textEn: 'A', isCorrect: true },
          { id: 'b', textEn: 'B', isCorrect: false },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
        createdById: author.id,
      },
    })
  }
}

async function makeTemplate(over: Record<string, unknown> = {}) {
  const author = await testDb().user.findFirstOrThrow()
  return testDb().examTemplate.create({
    data: { tenantId: testTenantId(),
      nameEn: 'Monthly Staff Exam',
      totalMarks: 5,
      durationMinutes: 60,
      questionSelection: { mcq: { total: 5, distribution: [{ count: 5 }] } },
      createdById: author.id,
      ...over,
    },
  })
}

async function makeConfig(templateId: string, over: Record<string, unknown> = {}) {
  return testDb().examScheduleConfig.create({
    data: { tenantId: testTenantId(), dayOfMonth: 15, fallbackRule: 'next_monday', templateId, ...over },
  })
}

const runScheduler = (now = FIRES_AT) => new SchedulerService(testDb(), silent).run(now)

describe('§12.2 the auto-scheduling job', () => {
  it('schedules an exam for every outlet from the global config', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    const template = await makeTemplate()
    await makeConfig(template.id) // outletId null = global

    const run = await runScheduler()

    // Aiko, Capiche and Prep.
    expect(run.scheduled).toBe(3)
    expect(run.results.every((r) => r.status === 'scheduled')).toBe(true)
  })

  it('uses the month in IST, not UTC', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id)

    // FIRES_AT is 18:30 UTC on 28 Feb — but 00:00 IST on 1 March. Reading the
    // month in UTC would schedule February's exam, a month late and wrong.
    const run = await runScheduler()
    expect(run).toMatchObject({ year: 2027, month: 3 })
    expect(run.results[0]!.date).toBe('2027-03-15')
  })

  it('publishes the exam, not leaves it a draft (§12.2 step 5)', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id)

    await runScheduler()
    const exams = await testDb().exam.findMany()
    expect(exams.every((e) => e.status === 'scheduled')).toBe(true)
  })

  it('marks the exams as auto-scheduled', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id)

    await runScheduler()
    const exams = await testDb().exam.findMany()
    expect(exams.every((e) => e.isAutoScheduled)).toBe(true)
  })

  it('auto-assigns the outlet’s active staff (§12.2 step 5)', async () => {
    await tokenFor({ role: 'admin' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'CP' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id)

    await runScheduler()

    const aikoExam = await testDb().exam.findFirstOrThrow({ where: { outletId: ctx.aiko } })
    expect(await testDb().examAssignment.count({ where: { examId: aikoExam.id } })).toBe(2)
  })

  it('applies §12.1’s weekend shift', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id)

    // 2027-05-15 is a Saturday → the exam moves to Monday the 17th.
    const run = await runScheduler(new Date('2027-04-30T18:30:00.000Z')) // 1 May IST
    expect(run.results[0]!.date).toBe('2027-05-17')
    expect(run.results[0]!.shifted).toBe(true)
    expect(run.results[0]!.reason).toContain('Saturday')
  })
})

describe('§12.2 step 4-6 conflict handling', () => {
  it('flags a conflict rather than double-booking an outlet', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    const template = await makeTemplate()
    await makeConfig(template.id)

    // An admin already scheduled something that day.
    const author = await testDb().user.findFirstOrThrow()
    await testDb().exam.create({
      data: { tenantId: testTenantId(),
        examCode: 'EX-MANUAL-1',
        nameEn: 'Manually scheduled',
        scheduledDate: new Date('2027-03-15T00:00:00.000Z'),
        startTime: new Date('1970-01-01T09:00:00.000Z'),
        endTime: new Date('1970-01-01T11:00:00.000Z'),
        outletId: ctx.aiko,
        totalMarks: 5,
        durationMinutes: 60,
        status: 'scheduled',
        createdById: author.id,
      },
    })

    const run = await runScheduler()

    // Creating a second exam on the same day would double-book every employee.
    const aiko = run.results.find((r) => r.outletId === ctx.aiko)!
    expect(aiko.status).toBe('conflict')
    expect(aiko.reason).toContain('manually-scheduled')

    // The other outlets are unaffected.
    expect(run.scheduled).toBe(2)
    expect(run.conflicts).toBe(1)
    expect(token).toBeTruthy()
  })

  it('is idempotent — a second run conflicts instead of duplicating', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id)

    await runScheduler()
    const second = await runScheduler()

    // This is what makes the in-process cron safe on more than one instance.
    expect(second.scheduled).toBe(0)
    expect(second.conflicts).toBe(3)
    expect(await testDb().exam.count()).toBe(3)
  })

  it('ignores a cancelled exam when checking for conflicts', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id)

    await runScheduler()
    await testDb().exam.updateMany({ data: { status: 'cancelled' } })

    // A cancelled exam is not a booking, so the month can be re-scheduled.
    const second = await runScheduler()
    expect(second.scheduled).toBe(3)
  })

  it('does not stop at the first outlet that fails', async () => {
    await tokenFor({ role: 'admin' })
    // No approved questions at all → §11.3 blocks every publish.
    await makeConfig((await makeTemplate()).id)

    const run = await runScheduler()

    // Every outlet is attempted; Aiko's problem must not cost Capiche its exam.
    expect(run.results).toHaveLength(3)
  })

  it('leaves an exam as a draft rather than publishing one that fails §11.3', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(2) // template asks for 5
    await makeConfig((await makeTemplate()).id)

    const run = await runScheduler()

    // An auto-scheduled exam that skipped validation could put a broken paper
    // in front of 300 staff with nobody watching.
    expect(run.scheduled).toBe(0)
    const exams = await testDb().exam.findMany()
    expect(exams.every((e) => e.status === 'draft')).toBe(true)
    expect(run.results[0]!.reason).toBeTruthy()
  })
})

describe('§4.1 per-outlet configuration', () => {
  it('lets an outlet override the global config', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    const template = await makeTemplate()

    await makeConfig(template.id) // global: 15th
    await makeConfig(template.id, { outletId: ctx.aiko, dayOfMonth: 20 }) // Aiko: 20th

    const run = await runScheduler()

    const aiko = run.results.find((r) => r.outletId === ctx.aiko)!
    const capiche = run.results.find((r) => r.outletId === ctx.capiche)!

    // Aiko's config says the 20th, which in March 2027 is a Saturday, so
    // next_monday moves it to the 22nd. Capiche follows the global 15th, a
    // Monday, and does not shift.
    expect(aiko.date).toBe('2027-03-22')
    expect(aiko.shifted).toBe(true)
    expect(capiche.date).toBe('2027-03-15')
    expect(capiche.shifted).toBe(false)
  })

  it('does not double-schedule an outlet that has its own config', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    const template = await makeTemplate()
    await makeConfig(template.id)
    await makeConfig(template.id, { outletId: ctx.aiko, dayOfMonth: 20 })

    const run = await runScheduler()
    // The global config must skip Aiko, or it gets two exams a month.
    expect(run.results.filter((r) => r.outletId === ctx.aiko)).toHaveLength(1)
    expect(run.results).toHaveLength(3)
  })

  it('skips an inactive config', async () => {
    await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id, { isActive: false })

    const run = await runScheduler()
    expect(run.results).toHaveLength(0)
  })

  it('does nothing when no config exists at all', async () => {
    await tokenFor({ role: 'admin' })
    const run = await runScheduler()
    expect(run).toMatchObject({ scheduled: 0, conflicts: 0, failed: 0 })
  })
})

describe('§5.3 schedule config API', () => {
  it('creates and then updates the config rather than duplicating it', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const template = await makeTemplate()

    await request(app)
      .put('/api/v1/exam-schedule-config')
      .set(auth(token))
      .send({ templateId: template.id, dayOfMonth: 15 })
      .expect(200)

    await request(app)
      .put('/api/v1/exam-schedule-config')
      .set(auth(token))
      .send({ templateId: template.id, dayOfMonth: 20 })
      .expect(200)

    // §4.1 has no unique constraint on outlet_id, so a second row would
    // silently double-schedule every outlet.
    const configs = await testDb().examScheduleConfig.findMany()
    expect(configs).toHaveLength(1)
    expect(configs[0]!.dayOfMonth).toBe(20)
  })

  it('rejects a config with no template', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .put('/api/v1/exam-schedule-config')
      .set(auth(token))
      .send({ dayOfMonth: 15 })
    expect(res.status).toBe(400)
  })

  it('previews the dates the config will produce', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await makeConfig((await makeTemplate()).id)

    const res = await request(app)
      .get('/api/v1/exam-schedule-config/preview?months=3')
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(3)
    // "Why is May's exam on the 17th?" has an answer without reading the code.
    for (const month of res.body.data) {
      expect(month.date).toBeTruthy()
      const weekday = new Date(`${month.date}T00:00:00.000Z`).getUTCDay()
      expect([0, 6]).not.toContain(weekday)
    }
  })

  it('runs the job on demand (§5.3 trigger-now)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id)

    const res = await request(app)
      .post('/api/v1/exam-schedule-config/trigger-now?asOf=2027-02-28T18:30:00.000Z')
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data.scheduled).toBe(3)
  })

  it('lets an admin re-run a month the job missed', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedApprovedQuestions(10)
    await makeConfig((await makeTemplate()).id)

    // The recovery path for the in-process cron's weakness: if the API was
    // down at 00:00 IST on the 1st, nothing retries automatically.
    const res = await request(app)
      .post('/api/v1/exam-schedule-config/trigger-now?asOf=2027-04-30T18:30:00.000Z')
      .set(auth(token))

    expect(res.body.data.month).toBe(5)
  })

  it('rejects a malformed asOf', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/exam-schedule-config/trigger-now?asOf=not-a-date')
      .set(auth(token))
    expect(res.status).toBe(400)
  })
})

describe('§3.2 RBAC — auto-scheduling is admin-only', () => {
  it('lets super_admin and admin manage the schedule', async () => {
    for (const role of ['super_admin', 'admin'] as const) {
      const { token } = await tokenFor({ role })
      await request(app).get('/api/v1/exam-schedule-config').set(auth(token)).expect(200)
    }
  })

  it('denies everyone else (§3.2 "Override auto-schedule")', async () => {
    for (const role of ['outlet_manager', 'trainer', 'hr', 'staff'] as const) {
      const { token } = await tokenFor({
        role,
        withEmployee: role === 'staff',
        managesOutletCodes: role === 'outlet_manager' ? ['AK'] : undefined,
      })
      await request(app).get('/api/v1/exam-schedule-config').set(auth(token)).expect(403)
      await request(app)
        .post('/api/v1/exam-schedule-config/trigger-now')
        .set(auth(token))
        .expect(403)
    }
  })
})
