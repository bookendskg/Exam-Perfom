import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'

/**
 * Regressions for bugs found by the adversarial audit of Modules 1-7.
 *
 * Each of these passed 452 tests and was still wrong — the tests proved what I
 * thought to check, not what was actually true. They live together so the
 * connection to the audit is not lost.
 */

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
  const topic = await db.topic.create({ data: { nameEn: 'Food Safety', departmentId: kitchen.id } })

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
    .send({ phone: made.phone, password: made.password })
  expect(res.status).toBe(200)
  return { token: res.body.data.accessToken as string, ...made }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('AUDIT: source documents had NO scope enforcement at all', () => {
  async function makeDoc(outletId: string | null) {
    return testDb().sourceDocument.create({
      data: {
        title: outletId ? 'Aiko Kitchen SOP' : 'Group-wide Food Safety Manual',
        type: 'sop',
        departmentId: ctx.kitchen,
        outletId,
        uploadedById: ctx.authorId,
      },
    })
  }

  it('stops an outlet_manager editing ANOTHER outlet’s document', async () => {
    const doc = await makeDoc(ctx.capiche)
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .put(`/api/v1/source-documents/${doc.id}`)
      .set(auth(manager.token))
      .send({ title: 'Hijacked' })

    expect(res.status).toBe(404)
    const row = await testDb().sourceDocument.findUniqueOrThrow({ where: { id: doc.id } })
    expect(row.title).not.toBe('Hijacked')
  })

  it('stops an outlet_manager editing a GLOBAL document', async () => {
    const doc = await makeDoc(null)
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    // outletId NULL = every outlet. Rewriting it changes the SOP that questions
    // across all three outlets cite.
    const res = await request(app)
      .put(`/api/v1/source-documents/${doc.id}`)
      .set(auth(manager.token))
      .send({ title: 'Aiko-only rewrite' })

    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('applies to all outlets')
  })

  it('stops an outlet_manager DEACTIVATING a global document', async () => {
    const doc = await makeDoc(null)
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .put(`/api/v1/source-documents/${doc.id}`)
      .set(auth(manager.token))
      .send({ isActive: false })
    expect(res.status).toBe(403)
  })

  it('stops an outlet_manager creating a document for another outlet', async () => {
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .post('/api/v1/source-documents')
      .set(auth(manager.token))
      .send({ title: 'Planted', type: 'sop', outletId: ctx.capiche })

    expect(res.status).toBe(403)
    expect(await testDb().sourceDocument.count({ where: { outletId: ctx.capiche } })).toBe(0)
  })

  it('stops an outlet_manager creating a GLOBAL document', async () => {
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    // Omitting outletId stores NULL = applies to every outlet.
    const res = await request(app)
      .post('/api/v1/source-documents')
      .set(auth(manager.token))
      .send({ title: 'Group-wide by stealth', type: 'sop' })

    expect(res.status).toBe(403)
  })

  it('stops an outlet_manager widening their own document to global', async () => {
    const doc = await makeDoc(ctx.aiko)
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .put(`/api/v1/source-documents/${doc.id}`)
      .set(auth(manager.token))
      .send({ outletId: null })
    expect(res.status).toBe(403)
  })

  it('still lets an outlet_manager manage their OWN outlet’s document', async () => {
    const doc = await makeDoc(ctx.aiko)
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    await request(app)
      .put(`/api/v1/source-documents/${doc.id}`)
      .set(auth(manager.token))
      .send({ title: 'Aiko Kitchen SOP v2' })
      .expect(200)

    await request(app)
      .post('/api/v1/source-documents')
      .set(auth(manager.token))
      .send({ title: 'New Aiko SOP', type: 'sop', outletId: ctx.aiko })
      .expect(201)
  })

  it('still lets an admin manage global documents', async () => {
    const doc = await makeDoc(null)
    const admin = await tokenFor({ role: 'admin' })

    await request(app)
      .put(`/api/v1/source-documents/${doc.id}`)
      .set(auth(admin.token))
      .send({ title: 'Group-wide v2' })
      .expect(200)
  })
})

describe('AUDIT: a DRAFT exam was sittable, bypassing all of §11.3', () => {
  async function draftExamAssignedTo(employeeId: string, status: 'draft' | 'scheduled') {
    const now = new Date()
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

    // Deliberately UNAPPROVED — exactly what §11.3 exists to keep out.
    const question = await testDb().question.create({
      data: {
        type: 'mcq',
        topicId: ctx.topic,
        departmentId: ctx.kitchen,
        questionTextEn: 'An unreviewed question',
        marks: 1,
        status: 'draft',
        options: [
          { id: 'a', textEn: 'A', isCorrect: true },
          { id: 'b', textEn: 'B', isCorrect: false },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
        createdById: ctx.authorId,
      },
    })

    const exam = await testDb().exam.create({
      data: {
        examCode: `EX-DRAFT-${Math.floor(Math.random() * 1_000_000)}`,
        nameEn: 'Unpublished exam',
        scheduledDate: today,
        startTime: new Date('1970-01-01T00:00:00.000Z'),
        endTime: new Date('1970-01-01T23:59:00.000Z'),
        outletId: ctx.aiko,
        // A total nothing has reconciled against the question marks.
        totalMarks: 999,
        durationMinutes: 60,
        status,
        createdById: ctx.authorId,
      },
    })
    await testDb().examQuestion.create({
      data: { examId: exam.id, questionId: question.id, sortOrder: 0, marks: 1 },
    })
    await testDb().examAssignment.create({ data: { examId: exam.id, employeeId } })
    return exam
  }

  it('refuses to start a draft exam', async () => {
    const staff = await tokenFor({
      role: 'staff',
      withEmployee: true,
      employeeOutletCode: 'AK',
    })
    const employee = await testDb().employee.findFirstOrThrow({
      where: { userId: staff.user.id },
    })
    const exam = await draftExamAssignedTo(employee.id, 'draft')

    // create() with autoAssign writes assignments while the exam is still a
    // draft, so the row exists. Starting it would serve unapproved questions
    // and score them against an unvalidated totalMarks — every §11.3 check
    // bypassed at once.
    const res = await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/start`)
      .set(auth(staff.token))
      .send({ acceptedTerms: true })

    expect(res.status).toBe(404)
    // Nothing was started.
    const assignment = await testDb().examAssignment.findFirstOrThrow({
      where: { examId: exam.id },
    })
    expect(assignment.startedAt).toBeNull()
    expect(assignment.status).toBe('assigned')
  })

  it('refuses to start an archived exam', async () => {
    const staff = await tokenFor({ role: 'staff', withEmployee: true, employeeOutletCode: 'AK' })
    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: staff.user.id } })
    const exam = await draftExamAssignedTo(employee.id, 'draft')
    await testDb().exam.update({ where: { id: exam.id }, data: { status: 'archived' } })

    const res = await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/start`)
      .set(auth(staff.token))
      .send({ acceptedTerms: true })
    expect(res.status).toBe(404)
  })

  it('still allows a published exam', async () => {
    const staff = await tokenFor({ role: 'staff', withEmployee: true, employeeOutletCode: 'AK' })
    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: staff.user.id } })
    const exam = await draftExamAssignedTo(employee.id, 'scheduled')

    await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/start`)
      .set(auth(staff.token))
      .send({ acceptedTerms: true })
      .expect(200)
  })
})

describe('AUDIT: flagging a question erased the answer', () => {
  async function startedExam() {
    const staff = await tokenFor({ role: 'staff', withEmployee: true, employeeOutletCode: 'AK' })
    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: staff.user.id } })

    const question = await testDb().question.create({
      data: {
        type: 'mcq',
        topicId: ctx.topic,
        departmentId: ctx.kitchen,
        questionTextEn: 'Q',
        marks: 1,
        status: 'approved',
        options: [
          { id: 'a', textEn: 'A', isCorrect: false },
          { id: 'b', textEn: 'B', isCorrect: true },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
        createdById: ctx.authorId,
      },
    })

    const now = new Date()
    const exam = await testDb().exam.create({
      data: {
        examCode: `EX-FLAG-${Math.floor(Math.random() * 1_000_000)}`,
        nameEn: 'Exam',
        scheduledDate: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        ),
        startTime: new Date('1970-01-01T00:00:00.000Z'),
        endTime: new Date('1970-01-01T23:59:00.000Z'),
        outletId: ctx.aiko,
        totalMarks: 1,
        durationMinutes: 60,
        status: 'scheduled',
        showResultImmediately: true,
        createdById: ctx.authorId,
      },
    })
    await testDb().examQuestion.create({
      data: { examId: exam.id, questionId: question.id, sortOrder: 0, marks: 1 },
    })
    await testDb().examAssignment.create({ data: { examId: exam.id, employeeId: employee.id } })

    const started = await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/start`)
      .set(auth(staff.token))
      .send({ acceptedTerms: true })

    return { staff, exam, examQuestionId: started.body.data.questions[0].examQuestionId }
  }

  it('keeps the answer when a flag-only update arrives (§13.1 step 9)', async () => {
    const { staff, exam, examQuestionId } = await startedExam()

    await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/answer`)
      .set(auth(staff.token))
      .send({ examQuestionId, selectedOptionId: 'b' })
      .expect(200)

    // Flagging an already-answered question is a normal flow. It used to wipe
    // the answer, and the candidate would only find out from their marks.
    await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/answer`)
      .set(auth(staff.token))
      .send({ examQuestionId, isFlagged: true })
      .expect(200)

    const response = await testDb().examResponse.findFirstOrThrow()
    expect(response.selectedOptionId).toBe('b')
    expect(response.isFlagged).toBe(true)
  })

  it('the answer still counts after flagging', async () => {
    const { staff, exam, examQuestionId } = await startedExam()

    await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/answer`)
      .set(auth(staff.token))
      .send({ examQuestionId, selectedOptionId: 'b' })
    await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/answer`)
      .set(auth(staff.token))
      .send({ examQuestionId, isFlagged: true })
    await request(app).post(`/api/v1/staff/exams/${exam.id}/submit`).set(auth(staff.token))

    const result = await request(app)
      .get(`/api/v1/staff/exams/${exam.id}/result`)
      .set(auth(staff.token))
    // Correct answer, correctly marked — not silently zeroed by the flag.
    expect(Number(result.body.data.totalMarksObtained)).toBe(1)
  })

  it('keeps a theory answer when a skip-only update arrives', async () => {
    const { staff, exam, examQuestionId } = await startedExam()

    await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/answer`)
      .set(auth(staff.token))
      .send({ examQuestionId, selectedOptionId: 'c' })
    await request(app)
      .post(`/api/v1/staff/exams/${exam.id}/answer`)
      .set(auth(staff.token))
      .send({ examQuestionId, isSkipped: true })

    const response = await testDb().examResponse.findFirstOrThrow()
    expect(response.selectedOptionId).toBe('c')
  })

  it('an explicit change still replaces the answer', async () => {
    const { staff, exam, examQuestionId } = await startedExam()

    for (const option of ['a', 'd']) {
      await request(app)
        .post(`/api/v1/staff/exams/${exam.id}/answer`)
        .set(auth(staff.token))
        .send({ examQuestionId, selectedOptionId: option })
    }

    const response = await testDb().examResponse.findFirstOrThrow()
    expect(response.selectedOptionId).toBe('d')
  })
})

describe('AUDIT: §11.3 "all employees active" ignored on_leave', () => {
  it('refuses to publish with an on_leave employee assigned', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const staff = await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: staff.user.id } })

    const question = await testDb().question.create({
      data: {
        type: 'mcq',
        topicId: ctx.topic,
        departmentId: ctx.kitchen,
        questionTextEn: 'Q',
        marks: 1,
        status: 'approved',
        options: [
          { id: 'a', textEn: 'A', isCorrect: true },
          { id: 'b', textEn: 'B', isCorrect: false },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
        createdById: ctx.authorId,
      },
    })

    const created = await request(app)
      .post('/api/v1/exams')
      .set(auth(admin.token))
      .send({
        nameEn: 'Exam',
        scheduledDate: '2027-03-15',
        startTime: '10:00',
        endTime: '12:00',
        totalMarks: 1,
        durationMinutes: 60,
        questionIds: [question.id],
        employeeIds: [employee.id],
      })
    expect(created.status).toBe(201)

    // §8.4's enum has five statuses and only ONE is active. on_leave is not.
    await testDb().employee.update({
      where: { id: employee.id },
      data: { employmentStatus: 'on_leave' },
    })

    const res = await request(app)
      .post(`/api/v1/exams/${created.body.data.id}/publish`)
      .set(auth(admin.token))
      .send({})

    expect(res.status).toBe(400)
    const detail = res.body.error.details.find((d: { field: string }) => d.field === 'assignments')
    expect(detail.message).toContain('on_leave')
  })
})

describe('AUDIT: an MCQ could be updated to have no correct answer', () => {
  async function draftMcq(token: string) {
    const res = await request(app)
      .post('/api/v1/questions')
      .set(auth(token))
      .send({
        type: 'mcq',
        topicId: ctx.topic,
        departmentId: ctx.kitchen,
        sourceChapter: 'Ch 1',
        questionTextEn: 'Q',
        marks: 1,
        options: [
          { id: 'a', textEn: 'A', isCorrect: true },
          { id: 'b', textEn: 'B', isCorrect: false },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
      })
    expect(res.status).toBe(201)
    return res.body.data.id as string
  }

  it('rejects an update leaving ZERO correct options', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftMcq(token)

    // With no correct option, correctOptionId() returns null at grading time,
    // every candidate is marked wrong, and negative marking penalises them for
    // a question that had no right answer.
    const res = await request(app)
      .put(`/api/v1/questions/${id}`)
      .set(auth(token))
      .send({
        options: [
          { id: 'a', textEn: 'A', isCorrect: false },
          { id: 'b', textEn: 'B', isCorrect: false },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
      })

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('exactly one correct')
  })

  it('rejects an update leaving TWO correct options', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftMcq(token)

    const res = await request(app)
      .put(`/api/v1/questions/${id}`)
      .set(auth(token))
      .send({
        options: [
          { id: 'a', textEn: 'A', isCorrect: true },
          { id: 'b', textEn: 'B', isCorrect: true },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
      })
    expect(res.status).toBe(400)
  })

  it('rejects an update to three options', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftMcq(token)

    const res = await request(app)
      .put(`/api/v1/questions/${id}`)
      .set(auth(token))
      .send({
        options: [
          { id: 'a', textEn: 'A', isCorrect: true },
          { id: 'b', textEn: 'B', isCorrect: false },
          { id: 'c', textEn: 'C', isCorrect: false },
        ],
      })
    expect(res.status).toBe(400)
  })

  it('rejects an update with duplicate option ids', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftMcq(token)

    const res = await request(app)
      .put(`/api/v1/questions/${id}`)
      .set(auth(token))
      .send({
        options: [
          { id: 'a', textEn: 'A', isCorrect: true },
          { id: 'a', textEn: 'B', isCorrect: false },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
      })
    expect(res.status).toBe(400)
  })

  it('still accepts a valid option update', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftMcq(token)

    await request(app)
      .put(`/api/v1/questions/${id}`)
      .set(auth(token))
      .send({
        options: [
          { id: 'a', textEn: 'A', isCorrect: false },
          { id: 'b', textEn: 'B', isCorrect: true },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
      })
      .expect(200)
  })
})
