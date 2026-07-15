import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb , testTenantId , TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'
import { seededShuffle } from '../src/staff-exams/shuffle.js'
import { gradeFor } from '../src/staff-exams/staff-exam.service.js'

let app: Application
let ctx: { kitchen: string; aiko: string; topic: string; authorId: string }

beforeEach(async () => {
  await truncateAll()
  await testDb().examCodeCounter.deleteMany()
  app = buildTestApp().app

  const db = testDb()
  const [kitchen, aiko] = await Promise.all([
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
  ])
  const author = await makeUser({ role: 'admin', mustChangePassword: false })
  const topic = await db.topic.create({ data: { tenantId: testTenantId(), nameEn: 'Food Safety', departmentId: kitchen.id } })

  ctx = { kitchen: kitchen.id, aiko: aiko.id, topic: topic.id, authorId: author.user.id }
})

afterAll(async () => {
  await disconnectDb()
})

async function staffToken() {
  const made = await makeUser({
    role: 'staff',
    withEmployee: true,
    employeeOutletCode: 'AK',
    mustChangePassword: false,
  })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
  expect(res.status).toBe(200)
  const employee = await testDb().employee.findFirstOrThrow({ where: { userId: made.user.id } })
  return { token: res.body.data.accessToken as string, employeeId: employee.id, ...made }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

async function makeMcq(over: Record<string, unknown> = {}) {
  return testDb().question.create({
    data: { tenantId: testTenantId(),
      type: 'mcq',
      difficulty: 'easy',
      topicId: ctx.topic,
      departmentId: ctx.kitchen,
      questionTextEn: 'What temperature should chicken be cooked to?',
      questionTextHi: 'चिकन को किस तापमान पर पकाना चाहिए?',
      questionTextGu: 'ચિકનને કયા તાપમાને રાંધવું જોઈએ?',
      explanationEn: 'The safe internal temperature is 74°C',
      marks: 1,
      status: 'approved',
      options: [
        { id: 'a', textEn: '65°C', textHi: '65°C', isCorrect: false },
        { id: 'b', textEn: '74°C', textHi: '74°C', isCorrect: true },
        { id: 'c', textEn: '80°C', textHi: '80°C', isCorrect: false },
        { id: 'd', textEn: '90°C', textHi: '90°C', isCorrect: false },
      ],
      createdById: ctx.authorId,
      ...over,
    },
  })
}

async function makeTheory() {
  return testDb().question.create({
    data: { tenantId: testTenantId(),
      type: 'theory',
      topicId: ctx.topic,
      departmentId: ctx.kitchen,
      questionTextEn: 'Explain the cold chain.',
      // The model answer the grader sees. A candidate must never.
      expectedAnswerEn: 'Keep food below 5°C from delivery to service.',
      marks: 5,
      status: 'approved',
      createdById: ctx.authorId,
    },
  })
}

/** An exam open right now, assigned to `employeeId`. */
async function liveExam(
  employeeId: string,
  questionIds: string[],
  over: Record<string, unknown> = {}
) {
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

  const exam = await testDb().exam.create({
    data: { tenantId: testTenantId(),
      examCode: `EX-TEST-${Math.floor(Math.random() * 1_000_000)}`,
      nameEn: 'Monthly Kitchen Exam',
      scheduledDate: today,
      // A window spanning the whole day, so "now" is always inside it.
      startTime: new Date('1970-01-01T00:00:00.000Z'),
      endTime: new Date('1970-01-01T23:59:00.000Z'),
      outletId: ctx.aiko,
      totalMarks: questionIds.length,
      passingPercentage: 40,
      durationMinutes: 60,
      status: 'scheduled',
      showResultImmediately: true,
      createdById: ctx.authorId,
      ...over,
    },
  })

  const questions = await testDb().question.findMany({ where: { id: { in: questionIds } } })
  await testDb().examQuestion.createMany({
    data: questionIds.map((id, i) => ({
      tenantId: testTenantId(),
      examId: exam.id,
      questionId: id,
      sortOrder: i,
      marks: Number(questions.find((q) => q.id === id)!.marks),
    })),
  })

  await testDb().examAssignment.create({ data: { tenantId: testTenantId(), examId: exam.id, employeeId } })
  return exam
}

const start = (token: string, examId: string, body: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/v1/staff/exams/${examId}/start`)
    .set(auth(token))
    .send({ acceptedTerms: true, ...body })

describe('THE ANSWER KEY MUST NEVER REACH A CANDIDATE', () => {
  it('never returns isCorrect on an MCQ option', async () => {
    const staff = await staffToken()
    const q = await makeMcq()
    const exam = await liveExam(staff.employeeId, [q.id])

    const res = await start(staff.token, exam.id)
    expect(res.status).toBe(200)

    // The single most important assertion in this module. §4.1 stores
    // is_correct on the same JSON blob as the option text, so one careless
    // spread hands every answer to anyone reading the APK's network traffic.
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('isCorrect')
    expect(body).not.toContain('is_correct')

    for (const option of res.body.data.questions[0].options) {
      expect(Object.keys(option)).not.toContain('isCorrect')
    }
  })

  it('never returns a theory question’s model answer', async () => {
    const staff = await staffToken()
    const q = await makeTheory()
    const exam = await liveExam(staff.employeeId, [q.id])

    const res = await start(staff.token, exam.id)
    const body = JSON.stringify(res.body)

    expect(body).not.toContain('expectedAnswer')
    expect(body).not.toContain('Keep food below 5°C')
  })

  it('never returns the rubric of a video/image question', async () => {
    const staff = await staffToken()
    const q = await testDb().question.create({
      data: { tenantId: testTenantId(),
        type: 'video_image',
        topicId: ctx.topic,
        departmentId: ctx.kitchen,
        questionTextEn: 'Show the correct plating for Margherita Pizza',
        marks: 10,
        status: 'approved',
        responseType: 'image',
        // The mark scheme. Handing it over tells the candidate what to perform.
        rubric: [{ criterion: 'Basil placement', maxMarks: 10 }],
        createdById: ctx.authorId,
      },
    })
    const exam = await liveExam(staff.employeeId, [q.id])

    const res = await start(staff.token, exam.id)
    const body = JSON.stringify(res.body)

    expect(body).not.toContain('rubric')
    expect(body).not.toContain('Basil placement')
    // …but the candidate still learns what to upload.
    expect(res.body.data.questions[0].responseType).toBe('image')
  })

  it('never returns the explanation before the exam is submitted', async () => {
    const staff = await staffToken()
    const q = await makeMcq()
    const exam = await liveExam(staff.employeeId, [q.id])

    const res = await start(staff.token, exam.id)
    // §10.1 shows explanations AFTER answering, not during — it names the
    // right answer outright.
    expect(JSON.stringify(res.body)).not.toContain('74°C is')
    expect(res.body.data.questions[0].explanation).toBeUndefined()
  })

  it('still gives the candidate everything they legitimately need', async () => {
    const staff = await staffToken()
    const q = await makeMcq({ negativeMarks: 0.25 })
    const exam = await liveExam(staff.employeeId, [q.id])

    const res = await start(staff.token, exam.id)
    const question = res.body.data.questions[0]

    expect(question.questionText).toBeTruthy()
    expect(question.options).toHaveLength(4)
    expect(question.options[0].text).toBeTruthy()
    expect(question.marks).toBe(1)
    // Shown so they can decide whether guessing is worth it (§10.1).
    expect(question.negativeMarks).toBe(0.25)
  })
})

describe('§13.1 start flow', () => {
  it('requires the honesty declaration (§13.1 step 4)', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])

    const res = await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/start`)
      .set(auth(staff.token))
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('honesty')
  })

  it('honours the language chosen for this attempt (§13.1 step 3)', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])

    const res = await start(staff.token, exam.id, { language: 'gu' })
    expect(res.body.data.questions[0].questionText).toBe('ચિકનને કયા તાપમાને રાંધવું જોઈએ?')
  })

  it('falls back to Hindi when Gujarati is missing, and says which it used', async () => {
    const staff = await staffToken()
    const q = await makeMcq({ questionTextGu: null })
    const exam = await liveExam(staff.employeeId, [q.id])

    const res = await start(staff.token, exam.id, { language: 'gu' })
    expect(res.body.data.questions[0].questionText).toBe('चिकन को किस तापमान पर पकाना चाहिए?')
    // The APK needs this to pick a Devanagari font in a Gujarati UI (§6.3).
    expect(res.body.data.questions[0].questionTextLanguage).toBe('hi')
  })

  it('defaults to the employee’s stored language preference', async () => {
    const staff = await staffToken()
    await testDb().employee.update({
      where: { id: staff.employeeId },
      data: { preferredLanguage: 'gu' },
    })
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])

    const res = await start(staff.token, exam.id)
    expect(res.body.data.language).toBe('gu')
  })

  it('records the device for §24’s proctoring', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])

    await start(staff.token, exam.id, { deviceInfo: { model: 'Redmi 9', osVersion: '11' } })

    const session = await testDb().examSession.findFirstOrThrow()
    expect(session.deviceInfo).toMatchObject({ model: 'Redmi 9' })
    expect(session.startedAt).toBeTruthy()
  })

  it('refuses an exam the candidate is not assigned to — as a 404', async () => {
    const staff = await staffToken()
    const other = await staffToken()
    const exam = await liveExam(other.employeeId, [(await makeMcq()).id])

    // A 403 would confirm the exam exists, telling them about papers set for
    // other outlets.
    const res = await start(staff.token, exam.id)
    expect(res.status).toBe(404)
  })

  it('refuses an exam that has not opened', async () => {
    const staff = await staffToken()
    const q = await makeMcq()
    const exam = await liveExam(staff.employeeId, [q.id])
    await testDb().exam.update({
      where: { id: exam.id },
      data: { startTime: new Date('1970-01-01T23:58:00.000Z') },
    })

    const res = await start(staff.token, exam.id)
    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain('not opened')
  })

  it('refuses a cancelled exam', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])
    await testDb().exam.update({ where: { id: exam.id }, data: { status: 'cancelled' } })

    const res = await start(staff.token, exam.id)
    expect(res.status).toBe(409)
  })
})

describe('the timer is the server’s, not the phone’s', () => {
  it('does not restart when the candidate reloads', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])

    const first = await start(staff.token, exam.id)
    // A phone on restaurant WiFi drops and reconnects. Re-starting must not
    // hand out a fresh 60 minutes.
    await testDb().examAssignment.updateMany({
      where: { examId: exam.id },
      data: { startedAt: new Date(Date.now() - 30 * 60_000) },
    })

    const second = await start(staff.token, exam.id)
    expect(second.status).toBe(200)
    expect(second.body.data.remainingSeconds).toBeLessThan(first.body.data.remainingSeconds)
    expect(second.body.data.remainingSeconds).toBeLessThanOrEqual(30 * 60 + 5)
  })

  it('creates only one session however many times start is called', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])

    await start(staff.token, exam.id)
    await start(staff.token, exam.id)
    await start(staff.token, exam.id)

    expect(await testDb().examSession.count()).toBe(1)
  })

  it('rejects an answer after the duration has elapsed', async () => {
    const staff = await staffToken()
    const q = await makeMcq()
    const exam = await liveExam(staff.employeeId, [q.id])
    const started = await start(staff.token, exam.id)

    // 61 minutes into a 60-minute exam.
    await testDb().examAssignment.updateMany({
      where: { examId: exam.id },
      data: { startedAt: new Date(Date.now() - 61 * 60_000) },
    })

    const res = await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/answer`)
      .set(auth(staff.token))
      .send({
        examQuestionId: started.body.data.questions[0].examQuestionId,
        selectedOptionId: 'b',
      })

    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain('run out')
  })

  it('caps the deadline at the exam window, not just the duration', async () => {
    const staff = await staffToken()
    const q = await makeMcq()
    // A 60-minute exam whose window shuts in 10 minutes: someone starting now
    // must not keep answering for 50 minutes after it closed.
    const closesSoon = new Date(Date.now() + 10 * 60_000)
    const exam = await liveExam(staff.employeeId, [q.id], {
      startTime: new Date('1970-01-01T00:00:00.000Z'),
      endTime: new Date(
        `1970-01-01T${String(closesSoon.getUTCHours()).padStart(2, '0')}:${String(closesSoon.getUTCMinutes()).padStart(2, '0')}:00.000Z`
      ),
      durationMinutes: 60,
    })

    const res = await start(staff.token, exam.id)
    if (res.status !== 200) return // the window rolled past midnight UTC; skip

    expect(res.body.data.remainingSeconds).toBeLessThanOrEqual(10 * 60 + 5)
  })
})

describe('§13.1 answering', () => {
  async function startedExam() {
    const staff = await staffToken()
    const q = await makeMcq()
    const exam = await liveExam(staff.employeeId, [q.id])
    const res = await start(staff.token, exam.id)
    return { staff, exam, question: res.body.data.questions[0] }
  }

  const answer = (token: string, examId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/v1/staff/exams/${examId}/answer`).set(auth(token)).send(body)

  it('saves an MCQ answer', async () => {
    const { staff, exam, question } = await startedExam()
    const res = await answer(staff.token, exam.id, {
      examQuestionId: question.examQuestionId,
      selectedOptionId: 'b',
    })
    expect(res.status).toBe(200)
  })

  it('is an upsert — the same answer twice is harmless (§21 offline replay)', async () => {
    const { staff, exam, question } = await startedExam()

    for (const option of ['a', 'b', 'b']) {
      await answer(staff.token, exam.id, {
        examQuestionId: question.examQuestionId,
        selectedOptionId: option,
      })
    }

    const responses = await testDb().examResponse.findMany()
    expect(responses).toHaveLength(1)
    expect(responses[0]!.selectedOptionId).toBe('b')
  })

  it('restores saved answers when the candidate reloads', async () => {
    const { staff, exam, question } = await startedExam()
    await answer(staff.token, exam.id, {
      examQuestionId: question.examQuestionId,
      selectedOptionId: 'c',
    })

    const reloaded = await start(staff.token, exam.id)
    expect(reloaded.body.data.answers[0]).toMatchObject({ selectedOptionId: 'c' })
  })

  it('flags a question for review (§13.1 step 9)', async () => {
    const { staff, exam, question } = await startedExam()
    await answer(staff.token, exam.id, {
      examQuestionId: question.examQuestionId,
      isFlagged: true,
    })

    const response = await testDb().examResponse.findFirstOrThrow()
    expect(response.isFlagged).toBe(true)
  })

  it('rejects a question that is not on this paper', async () => {
    const { staff, exam } = await startedExam()
    const res = await answer(staff.token, exam.id, {
      examQuestionId: '00000000-0000-4000-8000-000000000000',
      selectedOptionId: 'b',
    })
    expect(res.status).toBe(404)
  })

  it('rejects a theory answer to an MCQ', async () => {
    const { staff, exam, question } = await startedExam()
    const res = await answer(staff.token, exam.id, {
      examQuestionId: question.examQuestionId,
      theoryAnswer: 'I think it is 74 degrees',
    })
    expect(res.status).toBe(400)
  })

  it('refuses answers before the exam is started', async () => {
    const staff = await staffToken()
    const q = await makeMcq()
    const exam = await liveExam(staff.employeeId, [q.id])
    const eq = await testDb().examQuestion.findFirstOrThrow()

    const res = await answer(staff.token, exam.id, {
      examQuestionId: eq.id,
      selectedOptionId: 'b',
    })
    expect(res.status).toBe(409)
  })
})

describe('§10.1 MCQ auto-grading', () => {
  async function sit(answers: Record<number, string | null>, over: Record<string, unknown> = {}) {
    const staff = await staffToken()
    const questions = await Promise.all([makeMcq(over), makeMcq(over), makeMcq(over)])
    const exam = await liveExam(
      staff.employeeId,
      questions.map((q) => q.id)
    )
    const started = await start(staff.token, exam.id)

    for (const [index, option] of Object.entries(answers)) {
      if (option === null) continue
      const question = started.body.data.questions.find(
        (q: { questionId: string }) => q.questionId === questions[Number(index)]!.id
      )
      await request(app)
        .post(`/api/v1/staff/exams/${exam.id}/answer`)
        .set(auth(staff.token))
        .send({ examQuestionId: question.examQuestionId, selectedOptionId: option })
    }

    const submit = await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/submit`)
      .set(auth(staff.token))
    return { staff, exam, submit }
  }

  it('grades a perfect paper instantly (§10.1)', async () => {
    const { staff, exam } = await sit({ 0: 'b', 1: 'b', 2: 'b' })

    const result = await request(app)
      .get(`/api/v1/staff/exams/${exam.id}/result`)
      .set(auth(staff.token))

    expect(result.status).toBe(200)
    expect(Number(result.body.data.totalMarksObtained)).toBe(3)
    expect(Number(result.body.data.percentage)).toBe(100)
    expect(result.body.data.grade).toBe('A+')
    expect(result.body.data.passed).toBe(true)
  })

  it('grades a wrong paper as zero and failing', async () => {
    const { staff, exam } = await sit({ 0: 'a', 1: 'a', 2: 'a' })

    const result = await request(app)
      .get(`/api/v1/staff/exams/${exam.id}/result`)
      .set(auth(staff.token))
    expect(Number(result.body.data.totalMarksObtained)).toBe(0)
    expect(result.body.data.passed).toBe(false)
    expect(result.body.data.grade).toBe('F')
  })

  it('applies negative marking to a wrong answer (§10.1)', async () => {
    const { staff, exam } = await sit({ 0: 'b', 1: 'a', 2: 'b' }, { negativeMarks: 0.5 })

    const result = await request(app)
      .get(`/api/v1/staff/exams/${exam.id}/result`)
      .set(auth(staff.token))
    // 1 + 1 correct, −0.5 for the wrong one.
    expect(Number(result.body.data.totalMarksObtained)).toBe(1.5)
  })

  it('does not penalise a question left unanswered', async () => {
    const { staff, exam } = await sit({ 0: 'b', 1: null, 2: 'b' }, { negativeMarks: 0.5 })

    const result = await request(app)
      .get(`/api/v1/staff/exams/${exam.id}/result`)
      .set(auth(staff.token))
    // Guessing is discouraged; not answering is not punished twice.
    expect(Number(result.body.data.totalMarksObtained)).toBe(2)
  })

  it('marks the responses so a grader can see what happened', async () => {
    await sit({ 0: 'b', 1: 'a', 2: 'b' })

    const responses = await testDb().examResponse.findMany({ where: {} })
    expect(responses.filter((r) => r.isCorrect)).toHaveLength(2)
    expect(responses.every((r) => r.isAutoGraded)).toBe(true)
  })
})

describe('submission', () => {
  it('cannot be submitted twice', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])
    await start(staff.token, exam.id)

    await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/submit`)
      .set(auth(staff.token))
      .expect(200)
    const second = await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/submit`)
      .set(auth(staff.token))
    expect(second.status).toBe(409)
  })

  it('cannot be restarted after submitting', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])
    await start(staff.token, exam.id)
    await request(app).post(`/api/v1/staff/exams/${exam.id}/submit`).set(auth(staff.token))

    // Re-starting would silently discard the answers already given.
    const res = await start(staff.token, exam.id)
    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain('already submitted')
  })

  it('leaves a theory paper awaiting a human grader', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeTheory()).id])
    await start(staff.token, exam.id)

    const res = await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/submit`)
      .set(auth(staff.token))

    expect(res.body.data.awaitingGrading).toBe(true)
    // Whatever showResultImmediately says, nothing needing a human is instant.
    expect(res.body.data.resultAvailable).toBe(false)

    const assignment = await testDb().examAssignment.findFirstOrThrow()
    expect(assignment.status).toBe('submitted')
  })

  it('closes the proctoring session', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id])
    await start(staff.token, exam.id)
    await request(app).post(`/api/v1/staff/exams/${exam.id}/submit`).set(auth(staff.token))

    const session = await testDb().examSession.findFirstOrThrow()
    expect(session.endedAt).not.toBeNull()
  })

  it('withholds a result the exam has not released', async () => {
    const staff = await staffToken()
    const exam = await liveExam(staff.employeeId, [(await makeMcq()).id], {
      showResultImmediately: false,
    })
    await start(staff.token, exam.id)
    await request(app).post(`/api/v1/staff/exams/${exam.id}/submit`).set(auth(staff.token))

    const res = await request(app)
      .get(`/api/v1/staff/exams/${exam.id}/result`)
      .set(auth(staff.token))
    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain('not been released')
  })
})

describe('§3.2 — only staff take exams', () => {
  it('denies every non-staff role', async () => {
    for (const role of ['super_admin', 'admin', 'outlet_manager', 'trainer', 'hr'] as const) {
      const made = await makeUser({ role, mustChangePassword: false })
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })

      // An admin sitting an exam would pollute the performance record the
      // whole product exists to keep.
      const res = await request(app)
        .get('/api/v1/staff/exams')
        .set(auth(login.body.data.accessToken))
      expect(res.status, `${role} must not take exams`).toBe(403)
    }
  })
})

describe('deterministic shuffling', () => {
  it('gives the same candidate the same order every time', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f']
    // A reload must not reorder the paper — "I'll come back to number 7" has
    // to still mean something.
    expect(seededShuffle(items, 'assignment-1')).toEqual(seededShuffle(items, 'assignment-1'))
  })

  it('gives different candidates different orders', () => {
    const items = Array.from({ length: 20 }, (_, i) => String(i))
    expect(seededShuffle(items, 'assignment-1')).not.toEqual(seededShuffle(items, 'assignment-2'))
  })

  it('keeps every item', () => {
    const items = ['a', 'b', 'c', 'd']
    expect(seededShuffle(items, 'x').sort()).toEqual(items)
  })

  it('does not mutate the input', () => {
    const items = ['a', 'b', 'c']
    seededShuffle(items, 'x')
    expect(items).toEqual(['a', 'b', 'c'])
  })

  it('holds the question order across a reload, end to end', async () => {
    const staff = await staffToken()
    const questions = await Promise.all(Array.from({ length: 8 }, () => makeMcq()))
    const exam = await liveExam(
      staff.employeeId,
      questions.map((q) => q.id)
    )

    const first = await start(staff.token, exam.id)
    const second = await start(staff.token, exam.id)

    expect(second.body.data.questions.map((q: { questionId: string }) => q.questionId)).toEqual(
      first.body.data.questions.map((q: { questionId: string }) => q.questionId)
    )
  })
})

describe('§4.1 grading bands', () => {
  it('maps percentages to A+ through F', () => {
    expect(gradeFor(100)).toBe('A+')
    expect(gradeFor(90)).toBe('A+')
    expect(gradeFor(89.9)).toBe('A')
    expect(gradeFor(80)).toBe('A')
    expect(gradeFor(70)).toBe('B+')
    expect(gradeFor(60)).toBe('B')
    expect(gradeFor(40)).toBe('C')
    expect(gradeFor(39.9)).toBe('F')
    expect(gradeFor(0)).toBe('F')
  })
})
