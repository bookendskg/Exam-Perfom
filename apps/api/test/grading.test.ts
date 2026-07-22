import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'
import { istToday } from '../src/scheduling/exam-date.js'

/**
 * Module 8 — §3.2 grading, end to end over HTTP.
 *
 * Every attempt here is driven through Module 7's real endpoints: started,
 * answered and submitted over the API, then graded. Seeding responses straight
 * into the database would let these tests pass against a submit path that had
 * stopped producing the rows a grader needs.
 */

let app: Application
let ctx: { kitchen: string; aiko: string; capiche: string }
let examSeq = 0

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app
  examSeq = 0

  const db = testDb()
  const [kitchen, aiko, capiche] = await Promise.all([
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'CP' } }),
  ])
  ctx = { kitchen: kitchen.id, aiko: aiko.id, capiche: capiche.id }
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

async function candidate(outletCode = 'AK') {
  const made = await tokenFor({ role: 'staff', withEmployee: true, employeeOutletCode: outletCode })
  const employee = await testDb().employee.findFirstOrThrow({ where: { userId: made.user.id } })
  return { ...made, employeeId: employee.id }
}

const RUBRIC = [
  { criterion: 'Cheese distribution', maxMarks: 4 },
  { criterion: 'Basil placement', maxMarks: 3 },
  { criterion: 'Crust presentation', maxMarks: 3 },
]

const MCQ_OPTIONS = [
  { id: 'a', textEn: 'Four degrees', isCorrect: true },
  { id: 'b', textEn: 'Ten degrees', isCorrect: false },
  { id: 'c', textEn: 'Twenty degrees', isCorrect: false },
  { id: 'd', textEn: 'Thirty degrees', isCorrect: false },
]

interface Spec {
  type: 'mcq' | 'theory' | 'video_image'
  marks: number
}

/**
 * A submitted attempt, driven through Module 7. Returns the ids a grader needs.
 *
 * The exam window is the whole IST day so these never race the clock.
 */
async function submittedAttempt(opts: {
  employeeId: string
  token: string
  specs?: Spec[]
  outletId?: string
  answerTheory?: boolean
}) {
  const db = testDb()
  const author = await db.user.findFirstOrThrow()
  const specs = opts.specs ?? [
    { type: 'mcq', marks: 1 },
    { type: 'theory', marks: 5 },
  ]

  const questions = await Promise.all(
    specs.map((spec, i) =>
      db.question.create({
        data: {
          type: spec.type,
          difficulty: 'easy',
          departmentId: ctx.kitchen,
          questionTextEn: `Question ${i} ${Math.random()}`,
          expectedAnswerEn: spec.type === 'theory' ? 'Below four degrees celsius.' : null,
          marks: spec.marks,
          status: 'approved',
          createdById: author.id,
          ...(spec.type === 'mcq' ? { options: MCQ_OPTIONS } : {}),
          ...(spec.type === 'video_image' ? { responseType: 'image', rubric: RUBRIC } : {}),
        },
      })
    )
  )

  const totalMarks = specs.reduce((sum, s) => sum + s.marks, 0)
  const day = istToday(new Date())

  const exam = await db.exam.create({
    data: {
      nameEn: 'Monthly Kitchen Exam',
      examCode: `GX-T-${String(++examSeq).padStart(3, '0')}`,
      scheduledDate: new Date(`${day}T00:00:00.000Z`),
      startTime: new Date('1970-01-01T00:00:00.000Z'),
      endTime: new Date('1970-01-01T23:59:59.999Z'),
      outletId: opts.outletId ?? ctx.aiko,
      departmentId: ctx.kitchen,
      totalMarks,
      passingPercentage: 40,
      durationMinutes: 60,
      shuffleQuestions: false,
      shuffleOptions: false,
      showResultImmediately: true,
      status: 'scheduled',
      createdById: author.id,
      examQuestions: {
        create: questions.map((q, i) => ({
          questionId: q.id,
          sortOrder: i,
          marks: specs[i]!.marks,
        })),
      },
    },
    include: { examQuestions: { orderBy: { sortOrder: 'asc' } } },
  })

  const assignment = await db.examAssignment.create({
    data: { examId: exam.id, employeeId: opts.employeeId, status: 'assigned' },
  })

  // Drive Module 7 for real.
  await request(app)
    .post(`/api/v1/staff/exams/${assignment.id}/start`)
    .set(auth(opts.token))
    .send({})

  for (const [i, eq] of exam.examQuestions.entries()) {
    const spec = specs[i]!
    const body =
      spec.type === 'mcq'
        ? { selectedOptionId: 'a' }
        : spec.type === 'theory'
          ? opts.answerTheory === false
            ? { isSkipped: true }
            : { theoryAnswer: 'Cold food is stored below four degrees.' }
          : { mediaUrls: ['https://example.com/plate.jpg'], mediaType: 'image' }

    await request(app)
      .put(`/api/v1/staff/exams/${assignment.id}/responses/${eq.id}`)
      .set(auth(opts.token))
      .send(body)
  }

  const submitted = await request(app)
    .post(`/api/v1/staff/exams/${assignment.id}/submit`)
    .set(auth(opts.token))
    .send({})
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)

  return { exam, assignment, examQuestions: exam.examQuestions, questions }
}

const gradeTheory = (token: string, a: string, q: string, body: unknown) =>
  request(app).put(`/api/v1/grading/assignments/${a}/theory/${q}`).set(auth(token)).send(body)

const gradeRubric = (token: string, a: string, q: string, body: unknown) =>
  request(app).put(`/api/v1/grading/assignments/${a}/rubric/${q}`).set(auth(token)).send(body)

const override = (token: string, a: string, q: string, body: unknown) =>
  request(app)
    .put(`/api/v1/grading/assignments/${a}/responses/${q}/override`)
    .set(auth(token))
    .send(body)

const finalise = (token: string, a: string, body: unknown = {}) =>
  request(app).post(`/api/v1/grading/assignments/${a}/finalise`).set(auth(token)).send(body)

describe('§3.2 the grading queue', () => {
  it('lists attempts waiting on a human', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    await submittedAttempt({ employeeId: staff.employeeId, token: staff.token })

    const res = await request(app).get('/api/v1/grading/queue').set(auth(trainer.token))

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].ungradedResponses).toBe(1)
    expect(res.body.meta.total).toBe(1)
  })

  it('drops an attempt off the queue once it is graded', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, { marksObtained: 4 })
    await finalise(trainer.token, assignment.id)

    const res = await request(app).get('/api/v1/grading/queue').set(auth(trainer.token))
    expect(res.body.data).toHaveLength(0)
  })

  it('never shows an all-MCQ attempt, which needs no human', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
      specs: [{ type: 'mcq', marks: 1 }],
    })

    const res = await request(app).get('/api/v1/grading/queue').set(auth(trainer.token))
    expect(res.body.data).toHaveLength(0)
  })

  it('cannot be widened by asking for another outlet', async () => {
    const mine = await candidate('AK')
    const theirs = await candidate('CP')
    await submittedAttempt({ employeeId: mine.employeeId, token: mine.token })
    await submittedAttempt({
      employeeId: theirs.employeeId,
      token: theirs.token,
      outletId: ctx.capiche,
    })

    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    // The filter must narrow what scope allows, never replace it. Merging the
    // two into one object silently let this through.
    const res = await request(app)
      .get('/api/v1/grading/queue')
      .query({ outletId: ctx.capiche })
      .set(auth(manager.token))

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
    expect(res.body.meta.total).toBe(0)
  })

  it('§3.2 scopes an outlet manager to their own outlet', async () => {
    const mine = await candidate('AK')
    const theirs = await candidate('CP')
    await submittedAttempt({ employeeId: mine.employeeId, token: mine.token })
    await submittedAttempt({
      employeeId: theirs.employeeId,
      token: theirs.token,
      outletId: ctx.capiche,
    })

    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await request(app).get('/api/v1/grading/queue').set(auth(manager.token))

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].employee.outlet.code).toBe('AK')
    // meta.total must count only what they can see, or pagination lies.
    expect(res.body.meta.total).toBe(1)
  })
})

describe('§3.2 grading a theory answer', () => {
  it('records the mark, the grader and the comments', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    const res = await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, {
      marksObtained: 4,
      graderComments: 'Good, but missed the four-hour rule.',
    })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.marksObtained).toBe(4)

    const stored = await testDb().examResponse.findFirstOrThrow({
      where: { examAssignmentId: assignment.id, responseType: 'theory' },
    })
    expect(Number(stored.marksObtained)).toBe(4)
    expect(stored.graderComments).toContain('four-hour rule')
    expect(stored.gradedById).toBe(trainer.user.id)
    // No longer the machine's answer.
    expect(stored.isAutoGraded).toBe(false)
  })

  it('refuses more marks than the question is worth', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    // Awarding 9 on a 5-mark question would push the percentage over 100 and
    // corrupt every chart built on it.
    const res = await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, {
      marksObtained: 9,
    })
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('maximum of 5')
  })

  it('refuses a negative mark', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    expect(
      (await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, { marksObtained: -1 }))
        .status
    ).toBe(400)
  })

  it('refuses to mark an MCQ through the theory endpoint', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    // examQuestions[0] is the MCQ, already settled by Module 7.
    const res = await gradeTheory(trainer.token, assignment.id, examQuestions[0]!.id, {
      marksObtained: 1,
    })
    expect(res.status).toBe(400)
  })

  it('still requires a mark for a skipped answer', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
      answerTheory: false,
    })

    // A skipped theory answer is almost certainly zero, but a human says so —
    // scoring it automatically would be indistinguishable from a graded zero.
    const res = await finalise(trainer.token, assignment.id)
    expect(res.body.data.awaitingManualGrading).toBe(true)
  })
})

describe('§10.1 grading against a rubric', () => {
  const videoAttempt = async (staff: { employeeId: string; token: string }) =>
    submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
      specs: [{ type: 'video_image', marks: 10 }],
    })

  it('totals the criteria and stores the breakdown', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await videoAttempt(staff)

    const res = await gradeRubric(trainer.token, assignment.id, examQuestions[0]!.id, {
      rubricScores: { 'Cheese distribution': 3, 'Basil placement': 2, 'Crust presentation': 3 },
    })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.marksObtained).toBe(8)

    const stored = await testDb().examResponse.findFirstOrThrow({
      where: { examAssignmentId: assignment.id },
    })
    expect(stored.rubricScores).toMatchObject({ 'Basil placement': 2 })
  })

  it('refuses a criterion the question does not define', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await videoAttempt(staff)

    const res = await gradeRubric(trainer.token, assignment.id, examQuestions[0]!.id, {
      rubricScores: { 'Invented criterion': 5 },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('Unknown criterion')
  })

  it('refuses more than a criterion is worth', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await videoAttempt(staff)

    const res = await gradeRubric(trainer.token, assignment.id, examQuestions[0]!.id, {
      rubricScores: { 'Basil placement': 99 },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('at most 3')
  })
})

describe('§3.2 finalising an attempt', () => {
  it('releases the result once every answer is marked', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, { marksObtained: 4 })
    const res = await finalise(trainer.token, assignment.id, {
      supervisorRemarks: 'Solid month.',
    })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.status).toBe('graded')
    // 1 (auto MCQ) + 4 (manual theory) out of 6.
    expect(res.body.data.totalMarksObtained).toBe(5)
    expect(res.body.data.percentage).toBe(83.33)
    expect(res.body.data.grade).toBe('A')
    expect(res.body.data.passed).toBe(true)

    const stored = await testDb().examAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
    expect(stored.status).toBe('graded')
    expect(stored.gradedById).toBe(trainer.user.id)
    expect(stored.supervisorRemarks).toBe('Solid month.')
  })

  it('refuses to release while an answer is unmarked', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    const res = await finalise(trainer.token, assignment.id)

    expect(res.body.data.awaitingManualGrading).toBe(true)
    expect(res.body.data.percentage).toBeUndefined()

    // Crucially: an unmarked answer must NOT be silently scored zero.
    const stored = await testDb().examAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
    expect(stored.status).toBe('submitted')
    expect(stored.percentage).toBeNull()
  })

  it('reaches the candidate through their own result endpoint', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, { marksObtained: 5 })
    await finalise(trainer.token, assignment.id)

    // The whole point of the module: the result finally arrives at §8.5.
    const result = await request(app)
      .get(`/api/v1/staff/exams/${assignment.id}/result`)
      .set(auth(staff.token))

    expect(result.body.data.resultAvailable).toBe(true)
    expect(Number(result.body.data.percentage)).toBe(100)
    expect(result.body.data.grade).toBe('A+')
  })

  it('refreshes the exam pass rate and average', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { exam, assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    // Before grading the attempt is invisible to both counters.
    const before = await testDb().exam.findUniqueOrThrow({ where: { id: exam.id } })
    expect(before.totalPassed).toBe(0)
    expect(before.averageScore).toBeNull()

    await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, { marksObtained: 5 })
    await finalise(trainer.token, assignment.id)

    const after = await testDb().exam.findUniqueOrThrow({ where: { id: exam.id } })
    expect(after.totalPassed).toBe(1)
    expect(Number(after.averageScore)).toBe(100)
  })
})

describe('§3.2 regrading and override', () => {
  it('recomputes the result when a mark changes after release', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { exam, assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, { marksObtained: 5 })
    await finalise(trainer.token, assignment.id)

    // The grader was too generous; correcting it must not leave a stale total.
    await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, { marksObtained: 2 })

    const stored = await testDb().examAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
    expect(Number(stored.totalMarksObtained)).toBe(3)
    expect(Number(stored.percentage)).toBe(50)

    // …and the exam's average must follow it down.
    const after = await testDb().exam.findUniqueOrThrow({ where: { id: exam.id } })
    expect(Number(after.averageScore)).toBe(50)
  })

  it('§3.2 lets an admin override an auto-graded MCQ', async () => {
    const staff = await candidate()
    const admin = await tokenFor({ role: 'admin' })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    // The candidate answered 'a' and Module 7 marked it right. Suppose the
    // answer key was wrong: this is the only path that can correct it.
    const res = await override(admin.token, assignment.id, examQuestions[0]!.id, {
      marksObtained: 0,
      graderComments: 'Answer key was wrong; option A is not correct.',
    })

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const stored = await testDb().examResponse.findFirstOrThrow({
      where: { examAssignmentId: assignment.id, responseType: 'mcq' },
    })
    expect(Number(stored.marksObtained)).toBe(0)
    expect(stored.isAutoGraded).toBe(false)
  })

  it('requires a reason for an override', async () => {
    const staff = await candidate()
    const admin = await tokenFor({ role: 'admin' })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    const res = await override(admin.token, assignment.id, examQuestions[0]!.id, {
      marksObtained: 0,
    })
    expect(res.status).toBe(400)
  })

  it('§3.2 denies override to a trainer and an outlet manager', async () => {
    const staff = await candidate()
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const body = { marksObtained: 0, graderComments: 'nope' }

    expect((await override(trainer.token, assignment.id, examQuestions[0]!.id, body)).status).toBe(
      403
    )
    expect((await override(manager.token, assignment.id, examQuestions[0]!.id, body)).status).toBe(
      403
    )
  })
})

describe('§3.2 RBAC and scope', () => {
  it('denies staff and hr entirely', async () => {
    const staff = await candidate()
    const { assignment } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })
    const hr = await tokenFor({ role: 'hr' })

    // §3.2 gives hr reports, never grading.
    expect((await request(app).get('/api/v1/grading/queue').set(auth(hr.token))).status).toBe(403)
    // A candidate must not be able to mark their own paper.
    expect((await request(app).get('/api/v1/grading/queue').set(auth(staff.token))).status).toBe(
      403
    )
    expect((await finalise(staff.token, assignment.id)).status).toBe(403)
  })

  it('hides another outlet’s attempt behind a 404', async () => {
    const theirs = await candidate('CP')
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: theirs.employeeId,
      token: theirs.token,
      outletId: ctx.capiche,
    })

    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    // 404, not 403: a 403 would confirm the attempt exists.
    expect(
      (await gradeTheory(manager.token, assignment.id, examQuestions[1]!.id, { marksObtained: 1 }))
        .status
    ).toBe(404)
  })

  it('is mounted below the blanket auth guard', async () => {
    expect((await request(app).get('/api/v1/grading/queue')).status).toBe(401)
  })
})

describe('grading preconditions', () => {
  it('refuses an attempt the candidate has not submitted', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const author = await testDb().user.findFirstOrThrow()

    const question = await testDb().question.create({
      data: {
        type: 'theory',
        departmentId: ctx.kitchen,
        questionTextEn: 'Explain the cold chain.',
        marks: 5,
        status: 'approved',
        createdById: author.id,
      },
    })
    const exam = await testDb().exam.create({
      data: {
        nameEn: 'Not sat yet',
        examCode: 'GX-NS-001',
        scheduledDate: new Date(`${istToday(new Date())}T00:00:00.000Z`),
        startTime: new Date('1970-01-01T00:00:00.000Z'),
        endTime: new Date('1970-01-01T23:59:59.999Z'),
        departmentId: ctx.kitchen,
        totalMarks: 5,
        durationMinutes: 60,
        status: 'scheduled',
        createdById: author.id,
        examQuestions: { create: [{ questionId: question.id, sortOrder: 0, marks: 5 }] },
      },
      include: { examQuestions: true },
    })
    const assignment = await testDb().examAssignment.create({
      data: { examId: exam.id, employeeId: staff.employeeId, status: 'assigned' },
    })

    const res = await gradeTheory(trainer.token, assignment.id, exam.examQuestions[0]!.id, {
      marksObtained: 3,
    })
    expect(res.status).toBe(409)
  })

  it('refuses an exempted attempt', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    await testDb().examAssignment.update({
      where: { id: assignment.id },
      data: { status: 'exempted' },
    })

    const res = await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, {
      marksObtained: 3,
    })
    expect(res.status).toBe(409)
    expect(res.body.error.details[0].message).toContain('did not sit')
  })

  it('survives two graders marking the same attempt at once', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const admin = await tokenFor({ role: 'admin' })
    const { assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
      specs: [
        { type: 'theory', marks: 5 },
        { type: 'theory', marks: 5 },
      ],
    })

    // Two people marking one paper is normal — a trainer and a manager
    // reviewing together. Neither mark may be lost.
    await Promise.all([
      gradeTheory(trainer.token, assignment.id, examQuestions[0]!.id, { marksObtained: 4 }),
      gradeTheory(admin.token, assignment.id, examQuestions[1]!.id, { marksObtained: 3 }),
    ])
    await finalise(trainer.token, assignment.id)

    const stored = await testDb().examAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
    expect(stored.status).toBe('graded')
    expect(Number(stored.totalMarksObtained)).toBe(7)
  })

  it('is safe to finalise twice', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { exam, assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, { marksObtained: 4 })
    await finalise(trainer.token, assignment.id)
    const second = await finalise(trainer.token, assignment.id)

    expect(second.status).toBe(200)
    expect(second.body.data.totalMarksObtained).toBe(5)

    // The exam counters must not double-count a second finalise.
    const after = await testDb().exam.findUniqueOrThrow({ where: { id: exam.id } })
    expect(after.totalAttempted).toBe(1)
    expect(after.totalPassed).toBe(1)
  })
})

describe('§3.2 the grading screen', () => {
  it('shows the grader the model answer the candidate never saw', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { assignment } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    const res = await request(app)
      .get(`/api/v1/grading/assignments/${assignment.id}`)
      .set(auth(trainer.token))

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.ungraded).toBe(1)

    const theory = res.body.data.responses.find(
      (r: { responseType: string }) => r.responseType === 'theory'
    )
    expect(theory.theoryAnswer).toContain('four degrees')
    // The mirror of Module 7's paper: the grader gets the key, the candidate does not.
    expect(theory.question.expectedAnswerEn).toBe('Below four degrees celsius.')
  })
})

describe('demotion after a regrade leaves nothing stale', () => {
  it('clears the released result when a mark is removed', async () => {
    const staff = await candidate()
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })
    const { exam, assignment, examQuestions } = await submittedAttempt({
      employeeId: staff.employeeId,
      token: staff.token,
    })

    await gradeTheory(trainer.token, assignment.id, examQuestions[1]!.id, { marksObtained: 5 })
    await finalise(trainer.token, assignment.id)

    // Unmark it directly, as a future "unmark" action would.
    await testDb().examResponse.updateMany({
      where: { examAssignmentId: assignment.id, responseType: 'theory' },
      data: { marksObtained: null },
    })
    // Any grading write re-finalises; use the MCQ override to trigger it.
    const admin = await tokenFor({ role: 'admin' })
    await override(admin.token, assignment.id, examQuestions[0]!.id, {
      marksObtained: 1,
      graderComments: 'Confirming the key.',
    })

    const stored = await testDb().examAssignment.findUniqueOrThrow({ where: { id: assignment.id } })
    // A stale percentage here would keep the attempt counted as a pass.
    expect(stored.status).toBe('submitted')
    expect(stored.percentage).toBeNull()
    expect(stored.passed).toBeNull()

    const after = await testDb().exam.findUniqueOrThrow({ where: { id: exam.id } })
    expect(after.totalPassed).toBe(0)
    expect(after.averageScore).toBeNull()
  })
})
