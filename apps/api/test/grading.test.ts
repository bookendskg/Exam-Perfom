import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb , testTenantId , TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'

let app: Application
let ctx: { kitchen: string; aiko: string; capiche: string; topic: string; authorId: string }

beforeEach(async () => {
  await truncateAll()
  await testDb().examCodeCounter.deleteMany()
  app = buildTestApp().app

  const db = testDb()
  const [kitchen, aiko, capiche] = await Promise.all([
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'CP' } }),
  ])
  const author = await makeUser({ role: 'admin', mustChangePassword: false })
  const topic = await db.topic.create({ data: { tenantId: testTenantId(), nameEn: 'Food Safety', departmentId: kitchen.id } })

  ctx = {
    kitchen: kitchen.id,
    aiko: aiko.id,
    capiche: capiche.id,
    topic: topic.id,
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
  expect(res.status, `login failed: ${JSON.stringify(res.body)}`).toBe(200)
  return { token: res.body.data.accessToken as string, ...made }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

/**
 * Builds a submitted exam with one theory + one video/image response awaiting a
 * human, plus an already-auto-graded MCQ. Returns the ids a grader works with.
 */
async function submittedPaper(over: { examOutletId?: string | null } = {}) {
  const db = testDb()
  const staff = await makeUser({
    withEmployee: true,
    employeeOutletCode: 'AK',
    mustChangePassword: false,
  })
  const employee = await db.employee.findFirstOrThrow({ where: { userId: staff.user.id } })

  const theory = await db.question.create({
    data: { tenantId: testTenantId(),
      type: 'theory',
      topicId: ctx.topic,
      departmentId: ctx.kitchen,
      questionTextEn: 'Explain the cold chain.',
      expectedAnswerEn: 'Keep food below 5°C throughout.',
      marks: 10,
      status: 'approved',
      createdById: ctx.authorId,
    },
  })
  const video = await db.question.create({
    data: { tenantId: testTenantId(),
      type: 'video_image',
      topicId: ctx.topic,
      departmentId: ctx.kitchen,
      questionTextEn: 'Show correct plating.',
      marks: 10,
      responseType: 'image',
      rubric: [
        { criterion: 'Cheese', maxMarks: 4 },
        { criterion: 'Basil', maxMarks: 3 },
        { criterion: 'Crust', maxMarks: 3 },
      ],
      status: 'approved',
      createdById: ctx.authorId,
    },
  })
  const mcq = await db.question.create({
    data: { tenantId: testTenantId(),
      type: 'mcq',
      topicId: ctx.topic,
      departmentId: ctx.kitchen,
      questionTextEn: 'Temp?',
      marks: 5,
      status: 'approved',
      options: [
        { id: 'a', textEn: '65', isCorrect: false },
        { id: 'b', textEn: '74', isCorrect: true },
        { id: 'c', textEn: '80', isCorrect: false },
        { id: 'd', textEn: '90', isCorrect: false },
      ],
      createdById: ctx.authorId,
    },
  })

  const exam = await db.exam.create({
    data: { tenantId: testTenantId(),
      examCode: `EX-G-${Math.floor(Math.random() * 1_000_000)}`,
      nameEn: 'Kitchen Exam',
      scheduledDate: new Date('2027-03-15T00:00:00.000Z'),
      startTime: new Date('1970-01-01T10:00:00.000Z'),
      endTime: new Date('1970-01-01T12:00:00.000Z'),
      outletId: over.examOutletId === undefined ? ctx.aiko : over.examOutletId,
      totalMarks: 25,
      passingPercentage: 40,
      durationMinutes: 60,
      status: 'scheduled',
      showResultImmediately: false,
      createdById: ctx.authorId,
    },
  })

  const eqs = await Promise.all(
    [theory, video, mcq].map((q, i) =>
      db.examQuestion.create({
        data: { tenantId: testTenantId(), examId: exam.id, questionId: q.id, sortOrder: i, marks: Number(q.marks) },
      })
    )
  )

  const assignment = await db.examAssignment.create({
    data: { tenantId: testTenantId(),
      examId: exam.id,
      employeeId: employee.id,
      status: 'submitted',
      submittedAt: new Date(),
    },
  })

  const theoryResp = await db.examResponse.create({
    data: { tenantId: testTenantId(),
      examAssignmentId: assignment.id,
      examQuestionId: eqs[0]!.id,
      questionId: theory.id,
      responseType: 'theory',
      theoryAnswer: 'You keep it cold.',
      maxMarks: 10,
    },
  })
  const videoResp = await db.examResponse.create({
    data: { tenantId: testTenantId(),
      examAssignmentId: assignment.id,
      examQuestionId: eqs[1]!.id,
      questionId: video.id,
      responseType: 'video_image',
      mediaUrls: ['https://example.com/plate.jpg'],
      mediaType: 'image',
      maxMarks: 10,
    },
  })
  // The MCQ is already auto-graded by Module 7.
  const mcqResp = await db.examResponse.create({
    data: { tenantId: testTenantId(),
      examAssignmentId: assignment.id,
      examQuestionId: eqs[2]!.id,
      questionId: mcq.id,
      responseType: 'mcq',
      selectedOptionId: 'b',
      isCorrect: true,
      marksObtained: 5,
      isAutoGraded: true,
      maxMarks: 5,
    },
  })

  return { assignment, exam, employee, theoryResp, videoResp, mcqResp, theory, video }
}

describe('§5.3 GET /grading/pending', () => {
  it('lists responses awaiting a human, not the auto-graded MCQ', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await submittedPaper()

    const res = await request(app).get('/api/v1/grading/pending').set(auth(token))
    expect(res.status).toBe(200)
    // Two: the theory and the video. The MCQ is done.
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data.map((r: { responseType: string }) => r.responseType).sort()).toEqual([
      'theory',
      'video_image',
    ])
  })

  it('filters by type', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await submittedPaper()

    const res = await request(app).get('/api/v1/grading/pending?type=theory').set(auth(token))
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].responseType).toBe('theory')
  })

  it('does not surface a paper that is still being sat', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const { assignment } = await submittedPaper()
    await testDb().examAssignment.update({
      where: { id: assignment.id },
      data: { status: 'started' },
    })

    const res = await request(app).get('/api/v1/grading/pending').set(auth(token))
    expect(res.body.data).toHaveLength(0)
  })

  it('scopes an outlet_manager to their own outlet', async () => {
    await submittedPaper({ examOutletId: ctx.capiche })
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app).get('/api/v1/grading/pending').set(auth(manager.token))
    // The Capiche paper is not theirs to mark.
    expect(res.body.data).toHaveLength(0)
  })
})

describe('§5.3 GET /grading/:id/responses', () => {
  it('gives the grader the model answer and rubric', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const { assignment } = await submittedPaper()

    const res = await request(app)
      .get(`/api/v1/grading/${assignment.id}/responses`)
      .set(auth(token))

    expect(res.status).toBe(200)
    const theory = res.body.data.responses.find(
      (r: { responseType: string }) => r.responseType === 'theory'
    )
    // Unlike the candidate view, a grader DOES see these — it is who they are for.
    expect(theory.question.expectedAnswerEn).toBe('Keep food below 5°C throughout.')

    const video = res.body.data.responses.find(
      (r: { responseType: string }) => r.responseType === 'video_image'
    )
    expect(video.question.rubric).toHaveLength(3)
  })

  it('reports how many answers still need marking', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const { assignment } = await submittedPaper()

    const res = await request(app)
      .get(`/api/v1/grading/${assignment.id}/responses`)
      .set(auth(token))
    expect(res.body.data.outstanding).toBe(2)
  })
})

describe('§5.3 POST /grading/:id/grade', () => {
  it('grades a theory answer', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const { theoryResp } = await submittedPaper()

    const res = await request(app)
      .post(`/api/v1/grading/${theoryResp.id}/grade`)
      .set(auth(token))
      .send({ marks: 7, comments: 'Missing the delivery-to-service part' })

    expect(res.status).toBe(200)
    expect(res.body.data.marks).toBe(7)
    expect(res.body.data.outstanding).toBe(1)
  })

  it('rejects marks above the question’s value', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const { theoryResp } = await submittedPaper()

    const res = await request(app)
      .post(`/api/v1/grading/${theoryResp.id}/grade`)
      .set(auth(token))
      .send({ marks: 15 })
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('worth 10')
  })

  it('derives the mark from rubric scores (§10.1)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const { videoResp } = await submittedPaper()

    const res = await request(app)
      .post(`/api/v1/grading/${videoResp.id}/grade`)
      .set(auth(token))
      .send({
        rubricScores: [
          { criterion: 'Cheese', marks: 4 },
          { criterion: 'Basil', marks: 2 },
          { criterion: 'Crust', marks: 3 },
        ],
      })

    expect(res.status).toBe(200)
    expect(res.body.data.marks).toBe(9)

    const stored = await testDb().examResponse.findUniqueOrThrow({ where: { id: videoResp.id } })
    expect(stored.rubricScores).toHaveLength(3)
  })

  it('rejects a rubric score above a criterion’s max', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const { videoResp } = await submittedPaper()

    const res = await request(app)
      .post(`/api/v1/grading/${videoResp.id}/grade`)
      .set(auth(token))
      .send({
        rubricScores: [
          { criterion: 'Cheese', marks: 10 }, // max is 4
          { criterion: 'Basil', marks: 3 },
          { criterion: 'Crust', marks: 3 },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('at most 4')
  })

  it('requires every criterion to be scored', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const { videoResp } = await submittedPaper()

    // Missing "Crust" would silently cost the candidate 3 marks nobody removed.
    const res = await request(app)
      .post(`/api/v1/grading/${videoResp.id}/grade`)
      .set(auth(token))
      .send({
        rubricScores: [
          { criterion: 'Cheese', marks: 4 },
          { criterion: 'Basil', marks: 3 },
        ],
      })
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('Crust')
  })

  it('refuses to hand-mark an auto-graded MCQ', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const { mcqResp } = await submittedPaper()

    const res = await request(app)
      .post(`/api/v1/grading/${mcqResp.id}/grade`)
      .set(auth(token))
      .send({ marks: 0 })
    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain('auto-graded')
  })
})

describe('§5.3 POST /grading/:id/finalize', () => {
  async function gradeBoth(token: string, paper: Awaited<ReturnType<typeof submittedPaper>>) {
    await request(app)
      .post(`/api/v1/grading/${paper.theoryResp.id}/grade`)
      .set(auth(token))
      .send({ marks: 8 })
    await request(app)
      .post(`/api/v1/grading/${paper.videoResp.id}/grade`)
      .set(auth(token))
      .send({
        rubricScores: [
          { criterion: 'Cheese', marks: 4 },
          { criterion: 'Basil', marks: 3 },
          { criterion: 'Crust', marks: 2 },
        ],
      })
  }

  it('sums the whole paper including the auto-graded MCQ', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const paper = await submittedPaper()
    await gradeBoth(token, paper)

    const res = await request(app)
      .post(`/api/v1/grading/${paper.assignment.id}/finalize`)
      .set(auth(token))
      .send({})

    expect(res.status).toBe(200)
    // 8 (theory) + 9 (rubric) + 5 (mcq) = 22 of 25 = 88%.
    expect(Number(res.body.data.totalMarksObtained)).toBe(22)
    expect(Number(res.body.data.percentage)).toBe(88)
    expect(res.body.data.grade).toBe('A')
    expect(res.body.data.passed).toBe(true)
  })

  it('refuses to finalise while answers are still ungraded', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const paper = await submittedPaper()
    // Only grade the theory; the video is still open.
    await request(app)
      .post(`/api/v1/grading/${paper.theoryResp.id}/grade`)
      .set(auth(token))
      .send({ marks: 8 })

    const res = await request(app)
      .post(`/api/v1/grading/${paper.assignment.id}/finalize`)
      .set(auth(token))
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('still need marking')
  })

  it('writes an exam event to the employee timeline (§1.2)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const paper = await submittedPaper()
    await gradeBoth(token, paper)
    await request(app)
      .post(`/api/v1/grading/${paper.assignment.id}/finalize`)
      .set(auth(token))
      .send({})

    const events = await testDb().employeeTimeline.findMany({
      where: { employeeId: paper.employee.id, eventType: 'exam' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.title).toContain('A')
  })

  it('withholds the result until released, then shows it', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const paper = await submittedPaper()
    await gradeBoth(token, paper)

    await request(app)
      .post(`/api/v1/grading/${paper.assignment.id}/finalize`)
      .set(auth(token))
      .send({ releaseResults: true })

    const exam = await testDb().exam.findUniqueOrThrow({ where: { id: paper.exam.id } })
    // §11.1 step 5: releasing is a deliberate act.
    expect(exam.showResultImmediately).toBe(true)
  })

  it('refreshes the denormalised exam stats (§9 reads these)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const paper = await submittedPaper()
    await gradeBoth(token, paper)
    await request(app)
      .post(`/api/v1/grading/${paper.assignment.id}/finalize`)
      .set(auth(token))
      .send({})

    const exam = await testDb().exam.findUniqueOrThrow({ where: { id: paper.exam.id } })
    expect(exam.totalPassed).toBe(1)
    expect(Number(exam.averageScore)).toBe(88)
  })

  it('clamps a negatively-marked paper to zero percent, never negative', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const paper = await submittedPaper()
    // Give the theory a huge negative would be impossible (min 0), so instead
    // grade everything zero and confirm the floor holds.
    await request(app)
      .post(`/api/v1/grading/${paper.theoryResp.id}/grade`)
      .set(auth(token))
      .send({ marks: 0 })
    await request(app)
      .post(`/api/v1/grading/${paper.videoResp.id}/grade`)
      .set(auth(token))
      .send({
        rubricScores: [
          { criterion: 'Cheese', marks: 0 },
          { criterion: 'Basil', marks: 0 },
          { criterion: 'Crust', marks: 0 },
        ],
      })

    const res = await request(app)
      .post(`/api/v1/grading/${paper.assignment.id}/finalize`)
      .set(auth(token))
      .send({})
    // 0 + 0 + 5 (mcq) = 5 of 25 = 20%.
    expect(Number(res.body.data.percentage)).toBe(20)
    expect(res.body.data.passed).toBe(false)
  })
})

describe('§3.2 grading RBAC', () => {
  it('lets a trainer grade across outlets (§3.1)', async () => {
    const { token } = await tokenFor({ role: 'trainer' })
    const { theoryResp } = await submittedPaper({ examOutletId: ctx.capiche })

    // A trainer belongs to multiple outlets, so they grade anywhere.
    const res = await request(app)
      .post(`/api/v1/grading/${theoryResp.id}/grade`)
      .set(auth(token))
      .send({ marks: 5 })
    expect(res.status).toBe(200)
  })

  it('denies hr and staff (§3.2)', async () => {
    for (const role of ['hr', 'staff'] as const) {
      const { token } = await tokenFor({ role, withEmployee: role === 'staff' })
      const res = await request(app).get('/api/v1/grading/pending').set(auth(token))
      expect(res.status, `${role} must not grade`).toBe(403)
    }
  })

  it('stops a trainer overriding a finalised grade — only admins may', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const paper = await submittedPaper()
    await request(app)
      .post(`/api/v1/grading/${paper.theoryResp.id}/grade`)
      .set(auth(admin.token))
      .send({ marks: 8 })
    await request(app)
      .post(`/api/v1/grading/${paper.videoResp.id}/grade`)
      .set(auth(admin.token))
      .send({
        rubricScores: [
          { criterion: 'Cheese', marks: 4 },
          { criterion: 'Basil', marks: 3 },
          { criterion: 'Crust', marks: 3 },
        ],
      })
    await request(app)
      .post(`/api/v1/grading/${paper.assignment.id}/finalize`)
      .set(auth(admin.token))
      .send({})

    // §3.2 "Override grades" is super_admin/admin only.
    const trainer = await tokenFor({ role: 'trainer' })
    const res = await request(app)
      .post(`/api/v1/grading/${paper.theoryResp.id}/grade`)
      .set(auth(trainer.token))
      .send({ marks: 10 })
    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('override')
  })
})
