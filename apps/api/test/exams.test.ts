import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'
import { formatExamCode, parseExamCode } from '../src/exams/exam-code.js'
import { PublishValidator } from '../src/exams/publish-validation.js'

let app: Application
let ctx: { kitchen: string; aiko: string; capiche: string; topic: string; lineCook: string }

/** Far enough ahead that §11.3's future-date rule is satisfied. */
const FUTURE = '2027-03-15'

beforeEach(async () => {
  await truncateAll()
  await testDb().examCodeCounter.deleteMany()
  app = buildTestApp().app

  const db = testDb()
  const [kitchen, aiko, capiche, lineCook] = await Promise.all([
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'CP' } }),
    db.designation.findFirstOrThrow({ where: { code: 'LCOOK' } }),
  ])
  const topic = await db.topic.create({
    data: { nameEn: 'Food Safety', departmentId: kitchen.id },
  })

  ctx = {
    kitchen: kitchen.id,
    aiko: aiko.id,
    capiche: capiche.id,
    topic: topic.id,
    lineCook: lineCook.id,
  }
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

/** Seeds approved questions straight to the database — Module 4 is proven. */
async function seedQuestions(
  count: number,
  over: { difficulty?: 'easy' | 'medium' | 'hard'; marks?: number; outletId?: string | null } = {}
) {
  // Any user will do as the author — these questions exist to be selected, not
  // to test authorship. Filtering on role: 'admin' broke the moment a test
  // logged in as super_admin instead.
  const author = await testDb().user.findFirstOrThrow()
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const q = await testDb().question.create({
      data: {
        type: 'mcq',
        difficulty: over.difficulty ?? 'easy',
        topicId: ctx.topic,
        departmentId: ctx.kitchen,
        outletId: over.outletId === undefined ? null : over.outletId,
        questionTextEn: `Question ${i} ${Math.random()}`,
        marks: over.marks ?? 1,
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
    ids.push(q.id)
  }
  return ids
}

const exam = (over: Record<string, unknown> = {}) => ({
  nameEn: 'Monthly Kitchen Exam',
  nameHi: 'मासिक रसोई परीक्षा',
  scheduledDate: FUTURE,
  startTime: '10:00',
  endTime: '12:00',
  departmentId: ctx.kitchen,
  totalMarks: 5,
  durationMinutes: 60,
  autoAssign: false,
  ...over,
})

const create = (token: string, body: unknown) =>
  request(app).post('/api/v1/exams').set(auth(token)).send(body)

describe('§4.1 exam codes', () => {
  it('formats as EX-YYYY-MM-NNN', () => {
    expect(formatExamCode(2026, 7, 1)).toBe('EX-2026-07-001')
    expect(parseExamCode('EX-2026-07-001')).toEqual({ year: 2026, month: 7, sequence: 1 })
    expect(parseExamCode('nonsense')).toBeNull()
  })

  it('assigns sequentially within a month', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedQuestions(5)

    const codes: string[] = []
    for (let i = 0; i < 3; i++) {
      const res = await create(token, exam({ questionIds: await seedQuestions(1) }))
      expect(res.status).toBe(201)
      codes.push(res.body.data.examCode)
    }

    expect(codes).toEqual(['EX-2027-03-001', 'EX-2027-03-002', 'EX-2027-03-003'])
  })

  it('counts each month independently', async () => {
    const { token } = await tokenFor({ role: 'admin' })

    const march = await create(token, exam({ questionIds: await seedQuestions(1) }))
    const april = await create(
      token,
      exam({ scheduledDate: '2027-04-15', questionIds: await seedQuestions(1) })
    )

    expect(march.body.data.examCode).toBe('EX-2027-03-001')
    expect(april.body.data.examCode).toBe('EX-2027-04-001')
  })

  it('does not collide when exams are created concurrently', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const ids = await Promise.all(Array.from({ length: 6 }, () => seedQuestions(1)))

    // exam_code is UNIQUE, so a COUNT(*)+1 approach would simply fail here.
    const results = await Promise.all(ids.map((qs) => create(token, exam({ questionIds: qs }))))

    const codes = results.map((r) => r.body.data?.examCode)
    expect(results.every((r) => r.status === 201)).toBe(true)
    expect(new Set(codes).size, `duplicate codes: ${codes.join(', ')}`).toBe(6)
  })

  it('does not reuse a cancelled exam’s code', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const first = await create(token, exam({ questionIds: await seedQuestions(1) }))
    await request(app)
      .post(`/api/v1/exams/${first.body.data.id}/cancel`)
      .set(auth(token))
      .send({})
      .expect(200)

    const next = await create(token, exam({ questionIds: await seedQuestions(1) }))
    // Two exams sharing EX-2027-03-001 in the record is unfixable later.
    expect(next.body.data.examCode).toBe('EX-2027-03-002')
  })
})

describe('§11.2 question auto-selection', () => {
  it('selects by difficulty distribution', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedQuestions(10, { difficulty: 'easy' })
    await seedQuestions(10, { difficulty: 'medium' })
    await seedQuestions(10, { difficulty: 'hard' })

    const res = await create(
      token,
      exam({
        totalMarks: 20,
        questionSelection: {
          mcq: {
            total: 20,
            distribution: [
              { difficulty: 'easy', count: 8 },
              { difficulty: 'medium', count: 8 },
              { difficulty: 'hard', count: 4 },
            ],
          },
        },
      })
    )

    expect(res.status).toBe(201)
    const detail = await request(app).get(`/api/v1/exams/${res.body.data.id}`).set(auth(token))
    expect(detail.body.data.examQuestions).toHaveLength(20)

    const byDifficulty = detail.body.data.examQuestions.reduce(
      (acc: Record<string, number>, eq: { question: { difficulty: string } }) => {
        acc[eq.question.difficulty] = (acc[eq.question.difficulty] ?? 0) + 1
        return acc
      },
      {}
    )
    expect(byDifficulty).toEqual({ easy: 8, medium: 8, hard: 4 })
  })

  it('rejects rules whose distribution does not match the stated total', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(
      token,
      exam({
        questionSelection: {
          mcq: { total: 20, distribution: [{ difficulty: 'easy', count: 5 }] },
        },
      })
    )
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('total 5')
  })

  it('never selects an unapproved question (§11.3)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedQuestions(5)
    // Drafts must not reach staff.
    await testDb().question.updateMany({ data: { status: 'draft' } })

    const res = await create(
      token,
      exam({ questionSelection: { mcq: { total: 5, distribution: [{ count: 5 }] } } })
    )

    expect(res.status).toBe(201)
    expect(res.body.data.shortfalls[0]).toMatchObject({ requested: 5, found: 0 })
  })

  it('reports a shortfall rather than silently under-filling', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedQuestions(3, { difficulty: 'hard' })

    const res = await create(
      token,
      exam({
        questionSelection: {
          mcq: { total: 10, distribution: [{ difficulty: 'hard', count: 10 }] },
        },
      })
    )

    // Surfaced at build time, when it can still be fixed.
    expect(res.body.data.shortfalls).toEqual([
      { type: 'mcq', difficulty: 'hard', requested: 10, found: 3 },
    ])
  })

  it('never puts the same question in an exam twice', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedQuestions(5, { difficulty: 'hard' })

    // Two overlapping rules: "hard" and "any topic" both match the same rows.
    const res = await create(
      token,
      exam({
        questionSelection: {
          mcq: {
            total: 5,
            distribution: [
              { difficulty: 'hard', count: 3 },
              { count: 2, topics: ['any'] },
            ],
          },
        },
      })
    )

    const detail = await request(app).get(`/api/v1/exams/${res.body.data.id}`).set(auth(token))
    const ids = detail.body.data.examQuestions.map(
      (eq: { question: { id: string } }) => eq.question.id
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('draws on the global bank as well as the outlet’s own (§4.1)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedQuestions(3, { outletId: null }) // global
    await seedQuestions(2, { outletId: ctx.aiko })
    await seedQuestions(5, { outletId: ctx.capiche })

    const res = await create(
      token,
      exam({
        outletId: ctx.aiko,
        questionSelection: { mcq: { total: 5, distribution: [{ count: 5 }] } },
      })
    )

    // Aiko's own 2 + the 3 global ones. Capiche's must not appear, or an
    // outlet with a thin bank could never fill an exam without stealing
    // another's questions.
    expect(res.body.data.shortfalls).toEqual([])
    const detail = await request(app).get(`/api/v1/exams/${res.body.data.id}`).set(auth(token))
    expect(detail.body.data.examQuestions).toHaveLength(5)
  })

  it('treats the literal "any" topic as unrestricted (§11.2)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedQuestions(4)

    const res = await create(
      token,
      exam({
        questionSelection: { mcq: { total: 4, distribution: [{ count: 4, topics: ['any'] }] } },
      })
    )
    expect(res.body.data.shortfalls).toEqual([])
  })
})

describe('§11.1 manual and hybrid selection', () => {
  it('accepts manually picked questions', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const ids = await seedQuestions(3)

    const res = await create(token, exam({ questionIds: ids, totalMarks: 3 }))
    expect(res.status).toBe(201)

    const detail = await request(app).get(`/api/v1/exams/${res.body.data.id}`).set(auth(token))
    expect(detail.body.data.examQuestions).toHaveLength(3)
  })

  it('combines auto-selection with manual picks (§11.1 hybrid)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await seedQuestions(5, { difficulty: 'easy' })
    const extra = await seedQuestions(2, { difficulty: 'hard' })

    const res = await create(
      token,
      exam({
        questionSelection: { mcq: { total: 3, distribution: [{ difficulty: 'easy', count: 3 }] } },
        questionIds: extra,
      })
    )

    const detail = await request(app).get(`/api/v1/exams/${res.body.data.id}`).set(auth(token))
    expect(detail.body.data.examQuestions).toHaveLength(5)
  })

  it('refuses an unapproved manual pick (§11.3)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const ids = await seedQuestions(1)
    await testDb().question.update({ where: { id: ids[0]! }, data: { status: 'draft' } })

    const res = await create(token, exam({ questionIds: ids }))
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('approved')
  })

  it('refuses an unknown question id', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(token, exam({ questionIds: ['00000000-0000-4000-8000-000000000000'] }))
    expect(res.status).toBe(400)
  })

  it('bumps usageCount so §10.5’s most-used report stays honest', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const ids = await seedQuestions(1)

    await create(token, exam({ questionIds: ids }))
    await create(token, exam({ questionIds: ids }))

    const q = await testDb().question.findUniqueOrThrow({ where: { id: ids[0]! } })
    expect(q.usageCount).toBe(2)
  })
})

describe('§11.3 publish validation', () => {
  async function draft(token: string, over: Record<string, unknown> = {}) {
    const ids = await seedQuestions(5)
    const res = await create(token, exam({ questionIds: ids, totalMarks: 5, ...over }))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.data.id as string
  }

  const publish = (token: string, id: string) =>
    request(app).post(`/api/v1/exams/${id}/publish`).set(auth(token)).send({})

  it('publishes a valid exam', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draft(token)

    const res = await publish(token, id)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('scheduled')
  })

  it('refuses an exam with no questions', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(token, exam({ totalMarks: 5 }))
    const out = await publish(token, res.body.data.id)

    expect(out.status).toBe(400)
    expect(out.body.error.details.map((d: { field: string }) => d.field)).toContain('questions')
  })

  it('refuses when total marks do not match the questions', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draft(token)
    // 5 one-mark questions, but the exam now claims 99.
    await request(app).put(`/api/v1/exams/${id}`).set(auth(token)).send({ totalMarks: 99 })

    const res = await publish(token, id)
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('total')
  })

  it('refuses when any question is not approved', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draft(token)
    // Approved at selection, un-approved afterwards — the check has to run at
    // publish time, not only at selection.
    await testDb().question.updateMany({ data: { status: 'archived' } })

    const res = await publish(token, id)
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('not approved')
  })

  it('refuses a date in the past', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draft(token)
    await testDb().exam.update({
      where: { id },
      data: { scheduledDate: new Date('2020-01-01T00:00:00.000Z') },
    })

    const res = await publish(token, id)
    expect(res.status).toBe(400)
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('scheduledDate')
  })

  /**
   * §11.3's future-date rule, at the boundary that actually matters.
   *
   * The test above dates the exam six years back, so it passed even while the
   * validator composed the stored IST wall clock as though it were UTC — an
   * error of exactly 5h30m, invisible at a distance of years. These drive
   * PublishValidator directly with an injected `now`, because the boundary is
   * hours wide and a test that reads the real clock could not address it.
   *
   * The exam runs 10:00–12:00 IST on 2027-03-15, which is 04:30–06:30 UTC.
   */
  describe('the future-date rule is evaluated in IST', () => {
    const validatorFor = async (token: string) => {
      const id = await draft(token, { startTime: '10:00', endTime: '12:00', durationMinutes: 60 })
      return { id, validator: new PublishValidator(testDb()) }
    }

    const scheduledDateErrors = (report: { errors: { field: string }[] }) =>
      report.errors.filter((e) => e.field === 'scheduledDate')

    it('allows an exam that has not opened yet', async () => {
      const { token } = await tokenFor({ role: 'admin' })
      const { id, validator } = await validatorFor(token)

      // 09:30 IST — half an hour before it opens.
      const report = await validator.validate(id, new Date('2027-03-15T04:00:00.000Z'))
      expect(scheduledDateErrors(report)).toHaveLength(0)
      expect(report.canPublish).toBe(true)
    })

    it('refuses an exam whose window has already opened', async () => {
      const { token } = await tokenFor({ role: 'admin' })
      const { id, validator } = await validatorFor(token)

      // 10:30 IST — half an hour in. Composed as UTC this instant looks like
      // it is still 5 hours BEFORE the exam starts, so the guard stayed quiet.
      const report = await validator.validate(id, new Date('2027-03-15T05:00:00.000Z'))
      expect(scheduledDateErrors(report)).toHaveLength(1)
      expect(report.canPublish).toBe(false)
    })

    it('refuses an exam whose window has already closed', async () => {
      const { token } = await tokenFor({ role: 'admin' })
      const { id, validator } = await validatorFor(token)

      // 12:30 IST — half an hour after it ended. This is the case that hurt:
      // the exam published, and every assignee opening it got "This exam has
      // closed", because Module 7 reads the same columns correctly.
      const report = await validator.validate(id, new Date('2027-03-15T07:00:00.000Z'))
      expect(scheduledDateErrors(report)).toHaveLength(1)
      expect(report.canPublish).toBe(false)
    })

    it('still measures the window length correctly', async () => {
      const { token } = await tokenFor({ role: 'admin' })
      const { id, validator } = await validatorFor(token)

      // The 30-minute and duration-fit checks subtract two instants carrying
      // the same offset, so they were never wrong — and must stay right.
      const report = await validator.validate(id, new Date('2027-03-15T04:00:00.000Z'))
      expect(report.errors.filter((e) => e.field === 'endTime')).toHaveLength(0)
    })
  })

  it('refuses a window shorter than 30 minutes (§11.3)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draft(token, { startTime: '10:00', endTime: '10:15', durationMinutes: 10 })

    const res = await publish(token, id)
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('minimum is 30')
  })

  it('refuses a window shorter than the exam itself', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    // A 60-minute exam in a 45-minute window is unsittable, and staff would
    // find out at the moment it mattered.
    const id = await draft(token, { startTime: '10:00', endTime: '10:45', durationMinutes: 60 })

    const res = await publish(token, id)
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('takes 60')
  })

  it('refuses when an assigned employee has left', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const staff = await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    const id = await draft(token)

    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: staff.user.id } })
    await request(app)
      .post(`/api/v1/exams/${id}/assign`)
      .set(auth(token))
      .send({ employeeIds: [employee.id] })

    await testDb().employee.update({
      where: { id: employee.id },
      data: { employmentStatus: 'resigned' },
    })

    const res = await publish(token, id)
    expect(res.status).toBe(400)
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain('assignments')
  })

  it('WARNS about missing translations without blocking (§11.3)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draft(token) // seeded questions are English-only

    const res = await publish(token, id)
    // §11.3 says "Warning if any question lacks Hindi/Gujarati translation" —
    // a warning, not an error. Publishing an English-only exam to Gujarati
    // speakers is a visible choice, not a blocked one.
    expect(res.status).toBe(200)
    const fields = res.body.data.warnings.map((w: { field: string }) => w.field)
    expect(fields).toContain('questions.hi')
    expect(fields).toContain('questions.gu')
  })

  it('warns when nobody is assigned', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draft(token)

    const res = await publish(token, id)
    expect(res.status).toBe(200)
    expect(res.body.data.warnings.map((w: { field: string }) => w.field)).toContain('assignments')
  })

  it('reports every §11.3 failure at once, not just the first', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(token, exam({ totalMarks: 5, startTime: '10:00', endTime: '10:10' }))

    const out = await publish(token, res.body.data.id)
    // An operator fixing an exam needs the whole list.
    expect(out.body.error.details.length).toBeGreaterThanOrEqual(2)
  })

  it('exposes the same checks as a dry run before publishing (§11.1 step 8)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draft(token)

    const res = await request(app).get(`/api/v1/exams/${id}/validate`).set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body.data.canPublish).toBe(true)
    expect(res.body.data.warnings.length).toBeGreaterThan(0)

    // A dry run must not publish.
    const row = await testDb().exam.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('draft')
  })
})

describe('exam lifecycle', () => {
  async function published(token: string) {
    const ids = await seedQuestions(5)
    const res = await create(token, exam({ questionIds: ids, totalMarks: 5 }))
    await request(app).post(`/api/v1/exams/${res.body.data.id}/publish`).set(auth(token)).send({})
    return res.body.data.id as string
  }

  it('freezes a published exam against edits', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await published(token)

    // Staff have been notified; §12.3 sends reminders days ahead. Changing the
    // questions now means someone sits a different exam from the one described.
    const res = await request(app)
      .put(`/api/v1/exams/${id}`)
      .set(auth(token))
      .send({ nameEn: 'Sneaky rename' })

    expect(res.status).toBe(409)
    expect(res.body.error.details[0].message).toContain('Cancel it')
  })

  it('cancels a published exam and exempts the staff assigned to it', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const staff = await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: staff.user.id } })

    const ids = await seedQuestions(5)
    const res = await create(token, exam({ questionIds: ids, totalMarks: 5 }))
    const id = res.body.data.id
    await request(app)
      .post(`/api/v1/exams/${id}/assign`)
      .set(auth(token))
      .send({ employeeIds: [employee.id] })

    await request(app)
      .post(`/api/v1/exams/${id}/cancel`)
      .set(auth(token))
      .send({ reason: 'Kitchen closed for repairs' })
      .expect(200)

    // Exempted, not absent: they did not miss it, it was withdrawn — §9 must
    // not count it against them.
    const assignment = await testDb().examAssignment.findFirstOrThrow({ where: { examId: id } })
    expect(assignment.status).toBe('exempted')
    expect(assignment.supervisorRemarks).toContain('repairs')
  })

  it('refuses to cancel a completed exam', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await published(token)
    await testDb().exam.update({ where: { id }, data: { status: 'completed' } })

    const res = await request(app).post(`/api/v1/exams/${id}/cancel`).set(auth(token)).send({})
    expect(res.status).toBe(409)
    expect(res.body.error.details[0].message).toContain('results would be orphaned')
  })
})

describe('§11.1 step 6 assignment', () => {
  it('auto-assigns everyone matching the target', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'CP' })

    const res = await create(
      token,
      exam({ outletId: ctx.aiko, questionIds: await seedQuestions(1), autoAssign: true })
    )
    expect(res.body.data.totalAssigned).toBe(2)
  })

  it('skips departed staff when auto-assigning (§11.3)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const gone = await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    await testDb().employee.updateMany({
      where: { userId: gone.user.id },
      data: { employmentStatus: 'terminated' },
    })

    const res = await create(
      token,
      exam({ outletId: ctx.aiko, questionIds: await seedQuestions(1), autoAssign: true })
    )
    expect(res.body.data.totalAssigned).toBe(1)
  })

  it('is idempotent — re-assigning does not duplicate', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const staff = await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: staff.user.id } })

    const res = await create(token, exam({ questionIds: await seedQuestions(1) }))
    const id = res.body.data.id

    for (let i = 0; i < 2; i++) {
      await request(app)
        .post(`/api/v1/exams/${id}/assign`)
        .set(auth(token))
        .send({ employeeIds: [employee.id] })
    }

    expect(await testDb().examAssignment.count({ where: { examId: id } })).toBe(1)
  })

  it('lists assignments', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })

    const res = await create(
      token,
      exam({ outletId: ctx.aiko, questionIds: await seedQuestions(1), autoAssign: true })
    )
    const list = await request(app)
      .get(`/api/v1/exams/${res.body.data.id}/assignments`)
      .set(auth(token))

    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0].status).toBe('assigned')
  })
})

describe('§3.2 RBAC — exam builder', () => {
  it('lets super_admin and admin schedule exams', async () => {
    for (const role of ['super_admin', 'admin'] as const) {
      const { token } = await tokenFor({ role })
      const res = await create(token, exam({ questionIds: await seedQuestions(1) }))
      expect(res.status, `${role} must be able to schedule`).toBe(201)
    }
  })

  it('denies trainer, hr and staff (§3.2)', async () => {
    for (const role of ['trainer', 'hr', 'staff'] as const) {
      const { token } = await tokenFor({ role, withEmployee: role === 'staff' })
      const res = await create(token, exam({}))
      expect(res.status, `${role} must not schedule exams`).toBe(403)
    }
  })

  it('scopes an outlet_manager to their own outlet', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    await request(app)
      .post('/api/v1/exams')
      .set(auth(manager.token))
      .send(exam({ outletId: ctx.aiko, questionIds: await seedQuestions(1) }))
      .expect(201)

    // Another outlet's staff are not theirs to examine.
    const other = await request(app)
      .post('/api/v1/exams')
      .set(auth(admin.token))
      .send(exam({ outletId: ctx.capiche, questionIds: await seedQuestions(1) }))

    const hidden = await request(app)
      .get(`/api/v1/exams/${other.body.data.id}`)
      .set(auth(manager.token))
    expect(hidden.status).toBe(404)
  })

  it('never exposes an exam to staff through the admin API', async () => {
    const { token } = await tokenFor({ role: 'staff', withEmployee: true })
    // The exam detail includes its question set — that is the answer key.
    const res = await request(app).get('/api/v1/exams').set(auth(token))
    expect(res.status).toBe(403)
  })
})
