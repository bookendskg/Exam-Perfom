import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'
import { istToday } from '../src/scheduling/exam-date.js'

/**
 * Module 7 — §5.3 exam taking, end to end over HTTP.
 *
 * Exams are seeded straight into the database rather than through the Module 5
 * API: §11.3 refuses to schedule an exam in the past, and every test here needs
 * one that is sittable RIGHT NOW. Module 5 is proven by its own suite.
 */

let app: Application
let ctx: { kitchen: string; aiko: string; author: string }
let examSeq = 0

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app
  examSeq = 0

  const db = testDb()
  const [kitchen, aiko] = await Promise.all([
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
  ])
  ctx = { kitchen: kitchen.id, aiko: aiko.id, author: '' }
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

async function staffCandidate() {
  const made = await tokenFor({ role: 'staff', withEmployee: true, employeeOutletCode: 'AK' })
  const employee = await testDb().employee.findFirstOrThrow({ where: { userId: made.user.id } })
  return { ...made, employeeId: employee.id }
}

const MCQ_OPTIONS = [
  { id: 'a', textEn: 'Four degrees', textHi: 'चार डिग्री', isCorrect: true },
  { id: 'b', textEn: 'Ten degrees', isCorrect: false },
  { id: 'c', textEn: 'Twenty degrees', isCorrect: false },
  { id: 'd', textEn: 'Thirty degrees', isCorrect: false },
]

interface SeedQuestion {
  type?: 'mcq' | 'theory' | 'video_image'
  marks?: number
  negativeMarks?: number
  minWordLimit?: number
  maxWordLimit?: number
  responseType?: 'image' | 'video' | 'both'
}

/** Accepts 'HH:MM', 'HH:MM:SS' or 'HH:MM:SS.mmm' and builds a Prisma TIME. */
function clockTime(value: string): Date {
  const [h = '00', m = '00', s = '00.000'] = value.split(':')
  return new Date(`1970-01-01T${h}:${m}:${s}Z`)
}

interface SeedExamOptions {
  employeeId: string
  questions?: SeedQuestion[]
  /** IST calendar date. Defaults to today, so the window is open now. */
  day?: string
  startTime?: string
  endTime?: string
  durationMinutes?: number
  passingPercentage?: number
  showResultImmediately?: boolean
  allowReview?: boolean
  shuffleQuestions?: boolean
  examStatus?: 'draft' | 'scheduled' | 'active' | 'completed' | 'cancelled'
}

/**
 * An exam whose window is open now, with the caller assigned to it.
 *
 * The default window is the whole IST day, so these tests never race the
 * clock — a window of 10:00–12:00 would pass or fail depending on what time
 * the suite happens to run.
 */
async function seedExam(opts: SeedExamOptions) {
  const db = testDb()
  const author = await db.user.findFirstOrThrow()
  const specs = opts.questions ?? [{}, {}, {}, {}]

  const questions = await Promise.all(
    specs.map((spec, i) =>
      db.question.create({
        data: {
          type: spec.type ?? 'mcq',
          difficulty: 'easy',
          departmentId: ctx.kitchen,
          questionTextEn: `What temperature? ${i} ${Math.random()}`,
          questionTextHi: `तापमान क्या है? ${i}`,
          explanationEn: `Because of food safety ${i}`,
          marks: spec.marks ?? 1,
          negativeMarks: spec.negativeMarks ?? 0,
          status: 'approved',
          createdById: author.id,
          ...(spec.type === undefined || spec.type === 'mcq' ? { options: MCQ_OPTIONS } : {}),
          ...(spec.type === 'theory'
            ? { minWordLimit: spec.minWordLimit, maxWordLimit: spec.maxWordLimit }
            : {}),
          ...(spec.type === 'video_image' ? { responseType: spec.responseType ?? 'both' } : {}),
        },
      })
    )
  )

  const totalMarks = specs.reduce((sum, s) => sum + (s.marks ?? 1), 0)
  const day = opts.day ?? istToday(new Date())

  const exam = await db.exam.create({
    data: {
      nameEn: 'Monthly Kitchen Exam',
      nameHi: 'मासिक रसोई परीक्षा',
      examCode: `EX-T-${String(++examSeq).padStart(3, '0')}`,
      scheduledDate: new Date(`${day}T00:00:00.000Z`),
      startTime: clockTime(opts.startTime ?? '00:00:00.000'),
      // Not 23:59 — windowStateAt treats closesAt as exclusive, so a window
      // ending at 23:59:00 reads as closed for the final minute of every IST
      // day, and the whole suite would fail during it.
      endTime: clockTime(opts.endTime ?? '23:59:59.999'),
      outletId: ctx.aiko,
      departmentId: ctx.kitchen,
      totalMarks,
      passingPercentage: opts.passingPercentage ?? 40,
      durationMinutes: opts.durationMinutes ?? 60,
      // Off by default so assertions can address questions by position. The
      // shuffle itself is covered exhaustively in attempt-logic.test.ts.
      shuffleQuestions: opts.shuffleQuestions ?? false,
      shuffleOptions: false,
      showResultImmediately: opts.showResultImmediately ?? false,
      allowReview: opts.allowReview ?? false,
      status: opts.examStatus ?? 'scheduled',
      createdById: author.id,
      examQuestions: {
        create: questions.map((q, i) => ({
          questionId: q.id,
          sortOrder: i,
          marks: specs[i]?.marks ?? 1,
        })),
      },
    },
    include: { examQuestions: { orderBy: { sortOrder: 'asc' } } },
  })

  const assignment = await db.examAssignment.create({
    data: { examId: exam.id, employeeId: opts.employeeId, status: 'assigned' },
  })

  return { exam, assignment, questions, examQuestions: exam.examQuestions }
}

const start = (token: string, assignmentId: string, body: unknown = {}) =>
  request(app).post(`/api/v1/staff/exams/${assignmentId}/start`).set(auth(token)).send(body)

const answer = (token: string, assignmentId: string, examQuestionId: string, body: unknown) =>
  request(app)
    .put(`/api/v1/staff/exams/${assignmentId}/responses/${examQuestionId}`)
    .set(auth(token))
    .send(body)

const submit = (token: string, assignmentId: string) =>
  request(app).post(`/api/v1/staff/exams/${assignmentId}/submit`).set(auth(token)).send({})

describe('§5.3 starting an exam', () => {
  it('returns the paper and records the attempt', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: staff.employeeId })

    const res = await start(staff.token, assignment.id, {
      deviceInfo: { model: 'Redmi 12', osVersion: '13', appVersion: '1.0.0' },
    })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.questions).toHaveLength(4)
    expect(res.body.data.deadline).toBeTruthy()
    expect(res.body.data.savedResponses).toEqual([])

    const stored = await testDb().examAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    })
    expect(stored.status).toBe('started')
    expect(stored.startedAt).toBeTruthy()

    const sessions = await testDb().examSession.findMany({
      where: { examAssignmentId: assignment.id },
    })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.deviceInfo).toMatchObject({ model: 'Redmi 12' })
  })

  it('never sends the answer key', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: staff.employeeId })

    const res = await start(staff.token, assignment.id)

    // The blunt assertion is the point: any future field that leaks isCorrect,
    // an explanation, or an expected answer trips this.
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('isCorrect')
    expect(body).not.toContain('Because of food safety')
    expect(res.body.data.questions[0].options).toHaveLength(4)
    expect(Object.keys(res.body.data.questions[0].options[0]).sort()).toEqual([
      'id',
      'imageUrl',
      'text',
    ])
  })

  it('does not extend the clock when a dropped phone reconnects', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: staff.employeeId })

    const first = await start(staff.token, assignment.id)
    const second = await start(staff.token, assignment.id)

    expect(second.status).toBe(200)
    // Same deadline: a candidate cannot buy time by force-quitting the app.
    expect(second.body.data.deadline).toBe(first.body.data.deadline)
    expect(second.body.data.startedAt).toBe(first.body.data.startedAt)

    // But each reconnection is its own auditable session (§8).
    const sessions = await testDb().examSession.count({
      where: { examAssignmentId: assignment.id },
    })
    expect(sessions).toBe(2)
  })

  it('refuses before the window opens', async () => {
    const staff = await staffCandidate()
    const tomorrow = new Date(Date.now() + 86_400_000)
    const { assignment } = await seedExam({
      employeeId: staff.employeeId,
      day: istToday(tomorrow),
    })

    const res = await start(staff.token, assignment.id)
    expect(res.status).toBe(409)
    expect(res.body.error.details[0].field).toBe('opensAt')
  })

  it('refuses after the window closes', async () => {
    const staff = await staffCandidate()
    const yesterday = new Date(Date.now() - 86_400_000)
    const { assignment } = await seedExam({
      employeeId: staff.employeeId,
      day: istToday(yesterday),
    })

    const res = await start(staff.token, assignment.id)
    expect(res.status).toBe(409)
    expect(res.body.error.details[0].field).toBe('closesAt')
  })

  it('refuses a draft or cancelled exam', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({
      employeeId: staff.employeeId,
      examStatus: 'cancelled',
    })

    const res = await start(staff.token, assignment.id)
    expect(res.status).toBe(409)
  })

  it('is mounted below the blanket auth guard', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: staff.employeeId })

    // Pins the mount position in app.ts: mounted above `app.use('/api/v1',
    // requireAuth, …)` these routes would serve papers to anyone with an
    // assignment id.
    expect((await request(app).post(`/api/v1/staff/exams/${assignment.id}/start`)).status).toBe(401)
    expect((await request(app).get('/api/v1/staff/exams')).status).toBe(401)
  })

  it('hides another candidate’s assignment behind a 404', async () => {
    const mine = await staffCandidate()
    const theirs = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: theirs.employeeId })

    const res = await start(mine.token, assignment.id)
    // 404, not 403: a 403 would confirm the assignment exists.
    expect(res.status).toBe(404)
  })

  it('§3.2 gives exam:take to staff alone', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: staff.employeeId })
    const admin = await tokenFor({ role: 'admin' })

    expect((await start(admin.token, assignment.id)).status).toBe(403)
  })
})

describe('§5.3 saving answers', () => {
  it('autosaves and overwrites without duplicating', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({ employeeId: staff.employeeId })
    await start(staff.token, assignment.id)
    const eq = examQuestions[0]!.id

    expect((await answer(staff.token, assignment.id, eq, { selectedOptionId: 'b' })).status).toBe(
      200
    )
    const res = await answer(staff.token, assignment.id, eq, { selectedOptionId: 'a' })

    expect(res.status).toBe(200)
    expect(res.body.data.saved.selectedOptionId).toBe('a')

    const rows = await testDb().examResponse.findMany({
      where: { examAssignmentId: assignment.id },
    })
    expect(rows).toHaveLength(1)
    // Nothing is graded before submit — not even the field.
    expect(rows[0]!.marksObtained).toBeNull()
    expect(rows[0]!.isCorrect).toBeNull()
  })

  it('rejects an option the question does not have', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({ employeeId: staff.employeeId })
    await start(staff.token, assignment.id)

    const res = await answer(staff.token, assignment.id, examQuestions[0]!.id, {
      selectedOptionId: 'z',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].field).toBe('selectedOptionId')
  })

  it('rejects an answer of the wrong shape for the question type', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({ employeeId: staff.employeeId })
    await start(staff.token, assignment.id)

    const res = await answer(staff.token, assignment.id, examQuestions[0]!.id, {
      theoryAnswer: 'An essay, for a multiple-choice question',
    })
    expect(res.status).toBe(400)
  })

  it('§10.1 enforces theory word limits', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({
      employeeId: staff.employeeId,
      questions: [{ type: 'theory', marks: 5, minWordLimit: 5, maxWordLimit: 10 }],
    })
    await start(staff.token, assignment.id)
    const eq = examQuestions[0]!.id

    expect(
      (await answer(staff.token, assignment.id, eq, { theoryAnswer: 'Too short' })).status
    ).toBe(400)
    expect(
      (
        await answer(staff.token, assignment.id, eq, {
          theoryAnswer: 'one two three four five six seven eight nine ten eleven',
        })
      ).status
    ).toBe(400)

    // An empty answer is "not started", not "too short".
    expect((await answer(staff.token, assignment.id, eq, { theoryAnswer: '' })).status).toBe(200)
    expect(
      (await answer(staff.token, assignment.id, eq, { theoryAnswer: 'one two three four five' }))
        .status
    ).toBe(200)
  })

  it('refuses a question from a different exam', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: staff.employeeId })
    const other = await seedExam({ employeeId: staff.employeeId })
    await start(staff.token, assignment.id)

    const res = await answer(staff.token, assignment.id, other.examQuestions[0]!.id, {
      selectedOptionId: 'a',
    })
    expect(res.status).toBe(404)
  })

  it('closes the door when the candidate’s time is up', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({
      employeeId: staff.employeeId,
      durationMinutes: 60,
    })
    await start(staff.token, assignment.id)

    // Rewind the start so the personal deadline has passed while the exam
    // window itself is still open — the two clocks are independent.
    await testDb().examAssignment.update({
      where: { id: assignment.id },
      data: { startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    })

    const res = await answer(staff.token, assignment.id, examQuestions[0]!.id, {
      selectedOptionId: 'a',
    })
    expect(res.status).toBe(409)
    expect(res.body.error.details[0].field).toBe('deadline')
  })

  it('refuses before the exam is started', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({ employeeId: staff.employeeId })

    const res = await answer(staff.token, assignment.id, examQuestions[0]!.id, {
      selectedOptionId: 'a',
    })
    expect(res.status).toBe(409)
  })
})

describe('§5.3 resuming', () => {
  it('returns the same paper with the saved answers', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({
      employeeId: staff.employeeId,
      shuffleQuestions: true,
    })
    const started = await start(staff.token, assignment.id)
    await answer(staff.token, assignment.id, examQuestions[0]!.id, {
      selectedOptionId: 'a',
      isFlagged: true,
    })

    const resumed = await request(app)
      .get(`/api/v1/staff/exams/${assignment.id}/paper`)
      .set(auth(staff.token))

    expect(resumed.status).toBe(200)
    expect(
      resumed.body.data.questions.map((q: { examQuestionId: string }) => q.examQuestionId)
    ).toEqual(started.body.data.questions.map((q: { examQuestionId: string }) => q.examQuestionId))
    expect(resumed.body.data.savedResponses).toHaveLength(1)
    expect(resumed.body.data.savedResponses[0].isFlagged).toBe(true)
  })

  it('does not silently start an unstarted exam', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: staff.employeeId })

    const res = await request(app)
      .get(`/api/v1/staff/exams/${assignment.id}/paper`)
      .set(auth(staff.token))

    expect(res.status).toBe(409)
    const stored = await testDb().examAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
    expect(stored.startedAt).toBeNull()
  })
})

describe('§5.3 submitting and auto-grading', () => {
  it('grades an all-MCQ exam immediately', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({
      employeeId: staff.employeeId,
      showResultImmediately: true,
    })
    await start(staff.token, assignment.id)

    // Three right, one wrong.
    await answer(staff.token, assignment.id, examQuestions[0]!.id, { selectedOptionId: 'a' })
    await answer(staff.token, assignment.id, examQuestions[1]!.id, { selectedOptionId: 'a' })
    await answer(staff.token, assignment.id, examQuestions[2]!.id, { selectedOptionId: 'a' })
    await answer(staff.token, assignment.id, examQuestions[3]!.id, { selectedOptionId: 'c' })

    const res = await submit(staff.token, assignment.id)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.status).toBe('graded')
    expect(res.body.data.resultAvailable).toBe(true)
    expect(Number(res.body.data.totalMarksObtained)).toBe(3)
    expect(Number(res.body.data.percentage)).toBe(75)
    expect(res.body.data.grade).toBe('B+')
    expect(res.body.data.passed).toBe(true)
  })

  it('writes a response row for every question, answered or not', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({ employeeId: staff.employeeId })
    await start(staff.token, assignment.id)
    await answer(staff.token, assignment.id, examQuestions[0]!.id, { selectedOptionId: 'a' })

    await submit(staff.token, assignment.id)

    const rows = await testDb().examResponse.findMany({
      where: { examAssignmentId: assignment.id },
    })
    // "Did not answer" and "was never asked" must not look the same.
    expect(rows).toHaveLength(4)
    expect(rows.filter((r) => r.isSkipped)).toHaveLength(3)
    expect(rows.every((r) => r.isAutoGraded)).toBe(true)
  })

  it('applies negative marking but never below zero', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({
      employeeId: staff.employeeId,
      questions: [
        { negativeMarks: 0.5 },
        { negativeMarks: 0.5 },
        { negativeMarks: 0.5 },
        { negativeMarks: 0.5 },
      ],
      showResultImmediately: true,
    })
    await start(staff.token, assignment.id)
    for (const eq of examQuestions) {
      await answer(staff.token, assignment.id, eq.id, { selectedOptionId: 'b' })
    }

    const res = await submit(staff.token, assignment.id)

    expect(Number(res.body.data.totalMarksObtained)).toBe(0)
    expect(Number(res.body.data.percentage)).toBe(0)
    expect(res.body.data.passed).toBe(false)
  })

  it('does not penalise a skipped question', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({
      employeeId: staff.employeeId,
      questions: [{ negativeMarks: 1 }, { negativeMarks: 1 }],
      showResultImmediately: true,
    })
    await start(staff.token, assignment.id)
    await answer(staff.token, assignment.id, examQuestions[0]!.id, { selectedOptionId: 'a' })
    await answer(staff.token, assignment.id, examQuestions[1]!.id, { isSkipped: true })

    const res = await submit(staff.token, assignment.id)
    expect(Number(res.body.data.totalMarksObtained)).toBe(1)
  })

  it('waits for a human when the paper has theory answers', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({
      employeeId: staff.employeeId,
      questions: [{}, { type: 'theory', marks: 5 }],
      showResultImmediately: true,
    })
    await start(staff.token, assignment.id)
    await answer(staff.token, assignment.id, examQuestions[0]!.id, { selectedOptionId: 'a' })
    await answer(staff.token, assignment.id, examQuestions[1]!.id, {
      theoryAnswer: 'Cold food is stored below four degrees.',
      theoryAnswerLanguage: 'en',
    })

    const res = await submit(staff.token, assignment.id)

    expect(res.body.data.status).toBe('submitted')
    expect(res.body.data.resultAvailable).toBe(false)
    // A partial score would be indistinguishable from a final one.
    expect(res.body.data.percentage).toBeNull()

    const stored = await testDb().examAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
    expect(stored.percentage).toBeNull()
    expect(stored.gradedAt).toBeNull()

    // The MCQ half is still auto-graded, ready for Module 8's grader.
    const mcqRow = await testDb().examResponse.findFirstOrThrow({
      where: { examAssignmentId: assignment.id, responseType: 'mcq' },
    })
    expect(Number(mcqRow.marksObtained)).toBe(1)
  })

  it('refuses a second submission', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: staff.employeeId })
    await start(staff.token, assignment.id)

    expect((await submit(staff.token, assignment.id)).status).toBe(200)
    expect((await submit(staff.token, assignment.id)).status).toBe(409)
  })

  it('closes the attempt’s open sessions', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({ employeeId: staff.employeeId })
    await start(staff.token, assignment.id)
    await submit(staff.token, assignment.id)

    const sessions = await testDb().examSession.findMany({
      where: { examAssignmentId: assignment.id },
    })
    expect(sessions.every((s) => s.endedAt !== null)).toBe(true)
  })

  it('refreshes the exam’s denormalised stats', async () => {
    const first = await staffCandidate()
    const second = await staffCandidate()
    const { exam, assignment, examQuestions } = await seedExam({ employeeId: first.employeeId })
    const other = await testDb().examAssignment.create({
      data: { examId: exam.id, employeeId: second.employeeId, status: 'assigned' },
    })

    // One passes outright, one fails.
    await start(first.token, assignment.id)
    for (const eq of examQuestions) {
      await answer(first.token, assignment.id, eq.id, { selectedOptionId: 'a' })
    }
    await submit(first.token, assignment.id)

    await start(second.token, other.id)
    await submit(second.token, other.id)

    const stored = await testDb().exam.findUniqueOrThrow({ where: { id: exam.id } })
    expect(stored.totalAttempted).toBe(2)
    expect(stored.totalPassed).toBe(1)
    expect(Number(stored.averageScore)).toBe(50)
  })
})

describe('§11.1 result release', () => {
  it('withholds the marks, not merely hides them, when release is off', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({
      employeeId: staff.employeeId,
      showResultImmediately: false,
    })
    await start(staff.token, assignment.id)
    for (const eq of examQuestions) {
      await answer(staff.token, assignment.id, eq.id, { selectedOptionId: 'a' })
    }
    await submit(staff.token, assignment.id)

    const res = await request(app)
      .get(`/api/v1/staff/exams/${assignment.id}/result`)
      .set(auth(staff.token))

    expect(res.status).toBe(200)
    expect(res.body.data.resultAvailable).toBe(false)
    expect(res.body.data.percentage).toBeNull()
    expect(res.body.data.grade).toBeNull()

    // Graded in the database — just not released to the candidate.
    const stored = await testDb().examAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
    expect(Number(stored.percentage)).toBe(100)
  })

  it('returns the marked paper only when §11.1 allows review', async () => {
    const staff = await staffCandidate()
    const { assignment, examQuestions } = await seedExam({
      employeeId: staff.employeeId,
      showResultImmediately: true,
      allowReview: true,
    })
    await start(staff.token, assignment.id)
    await answer(staff.token, assignment.id, examQuestions[0]!.id, { selectedOptionId: 'a' })
    await submit(staff.token, assignment.id)

    const res = await request(app)
      .get(`/api/v1/staff/exams/${assignment.id}/result`)
      .set(auth(staff.token))

    expect(res.body.data.responses).toHaveLength(4)
    // The attempt is over and review is allowed, so the key is finally public.
    expect(res.body.data.responses[0].correctOptionId).toBe('a')
    expect(res.body.data.responses[0].explanationEn).toContain('food safety')
  })

  it('omits the paper when review is off', async () => {
    const staff = await staffCandidate()
    const { assignment } = await seedExam({
      employeeId: staff.employeeId,
      showResultImmediately: true,
      allowReview: false,
    })
    await start(staff.token, assignment.id)
    await submit(staff.token, assignment.id)

    const res = await request(app)
      .get(`/api/v1/staff/exams/${assignment.id}/result`)
      .set(auth(staff.token))

    expect(res.body.data.responses).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('correctOptionId')
  })
})

describe('§5.3 GET /staff/exams', () => {
  it('lists the caller’s own assignments with their window state', async () => {
    const staff = await staffCandidate()
    const other = await staffCandidate()
    await seedExam({ employeeId: staff.employeeId })
    await seedExam({ employeeId: other.employeeId })

    const res = await request(app).get('/api/v1/staff/exams').set(auth(staff.token))

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].windowState).toBe('open')
    expect(res.body.data[0].canStart).toBe(true)
  })

  it('does not advertise a draft exam', async () => {
    const staff = await staffCandidate()
    await seedExam({ employeeId: staff.employeeId, examStatus: 'draft' })

    const res = await request(app).get('/api/v1/staff/exams').set(auth(staff.token))
    expect(res.body.data).toHaveLength(0)
  })
})

describe('§6.2 the paper is in the candidate’s language', () => {
  it('renders Hindi for a Hindi speaker', async () => {
    const staff = await staffCandidate()
    await testDb().employee.update({
      where: { id: staff.employeeId },
      data: { preferredLanguage: 'hi' },
    })
    const { assignment } = await seedExam({ employeeId: staff.employeeId })

    const res = await start(staff.token, assignment.id)

    expect(res.body.data.language).toBe('hi')
    expect(res.body.data.questions[0].questionText).toContain('तापमान')
    expect(res.body.data.questions[0].questionTextLanguage).toBe('hi')
    // §6.2's chain: no Gujarati option text, so it falls back to English.
    expect(res.body.data.questions[0].options[0].text).toBe('चार डिग्री')
  })
})
