import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'

let app: Application
let ctx: {
  kitchen: string
  aiko: string
  capiche: string
  topic: string
  document: string
}

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app

  const db = testDb()
  const [kitchen, aiko, capiche] = await Promise.all([
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'CP' } }),
  ])

  const document = await db.sourceDocument.create({
    data: { title: 'Food Safety Manual', type: 'sop', departmentId: kitchen.id },
  })
  const topic = await db.topic.create({
    data: { nameEn: 'Food Safety', nameHi: 'खाद्य सुरक्षा', departmentId: kitchen.id },
  })

  ctx = {
    kitchen: kitchen.id,
    aiko: aiko.id,
    capiche: capiche.id,
    topic: topic.id,
    document: document.id,
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

const mcq = (over: Record<string, unknown> = {}) => ({
  type: 'mcq',
  difficulty: 'easy',
  topicId: ctx.topic,
  departmentId: ctx.kitchen,
  sourceDocumentId: ctx.document,
  questionTextEn: 'What temperature should chicken be cooked to?',
  questionTextHi: 'चिकन को किस तापमान पर पकाना चाहिए?',
  questionTextGu: 'ચિકનને કયા તાપમાને રાંધવું જોઈએ?',
  marks: 1,
  options: [
    { id: 'a', textEn: '65°C', isCorrect: false },
    { id: 'b', textEn: '74°C', isCorrect: true },
    { id: 'c', textEn: '80°C', isCorrect: false },
    { id: 'd', textEn: '90°C', isCorrect: false },
  ],
  ...over,
})

const theory = (over: Record<string, unknown> = {}) => ({
  type: 'theory',
  topicId: ctx.topic,
  departmentId: ctx.kitchen,
  sourceChapter: 'Chapter 3',
  questionTextEn: 'Explain the cold chain.',
  marks: 5,
  ...over,
})

const videoImage = (over: Record<string, unknown> = {}) => ({
  type: 'video_image',
  topicId: ctx.topic,
  departmentId: ctx.kitchen,
  sourceChapter: 'Chapter 4',
  questionTextEn: 'Show the correct plating for Margherita Pizza',
  marks: 10,
  responseType: 'image',
  rubric: [
    { criterion: 'Cheese distribution', maxMarks: 4 },
    { criterion: 'Basil placement', maxMarks: 3 },
    { criterion: 'Crust presentation', maxMarks: 3 },
  ],
  ...over,
})

const create = (token: string, body: unknown) =>
  request(app).post('/api/v1/questions').set(auth(token)).send(body)

describe('§10.1 MCQ validation', () => {
  it('creates a trilingual MCQ', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(token, mcq())

    expect(res.status).toBe(201)
    expect(res.body.data.type).toBe('mcq')
    // §10.2: everything starts as a draft.
    expect(res.body.data.status).toBe('draft')
  })

  it('requires exactly 4 options (§10.1)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const threeOptions = mcq().options.slice(0, 3)
    const res = await create(token, mcq({ options: threeOptions }))
    expect(res.status).toBe(400)
  })

  it('requires exactly one correct option', async () => {
    const { token } = await tokenFor({ role: 'admin' })

    const none = mcq().options.map((o) => ({ ...o, isCorrect: false }))
    expect((await create(token, mcq({ options: none }))).status).toBe(400)

    const two = mcq().options.map((o) => ({ ...o, isCorrect: true }))
    expect((await create(token, mcq({ options: two }))).status).toBe(400)
  })

  it('rejects duplicate option ids', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const dupes = mcq().options.map((o) => ({ ...o, id: 'a' }))
    expect((await create(token, mcq({ options: dupes }))).status).toBe(400)
  })

  it('rejects an option with no English text (§6.2)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const options = mcq().options
    options[0] = { ...options[0]!, textEn: '' }
    expect((await create(token, mcq({ options }))).status).toBe(400)
  })

  it('supports negative marking (§10.1)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(token, mcq({ negativeMarks: 0.25 }))
    expect(res.status).toBe(201)
    expect(Number(res.body.data.negativeMarks)).toBe(0.25)
  })

  it('rejects MCQ fields on a theory question', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    // The discriminated union means a theory payload has no `options` field at
    // all — a half-formed question never reaches the database.
    const res = await create(token, theory({ options: mcq().options }))
    expect(res.status).toBe(201) // extra keys are stripped, not fatal
    expect(res.body.data.type).toBe('theory')
  })
})

describe('§10.1 theory validation', () => {
  it('creates a theory question', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(token, theory({ expectedAnswerEn: 'Keep food below 5°C.' }))
    expect(res.status).toBe(201)
    expect(res.body.data.type).toBe('theory')
  })

  it('rejects a min word limit above the max', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(token, theory({ minWordLimit: 200, maxWordLimit: 50 }))
    expect(res.status).toBe(400)
  })
})

describe('§10.1 video/image validation', () => {
  it('creates a video/image question with a rubric', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(token, videoImage())
    expect(res.status).toBe(201)
  })

  it('requires a rubric — without one it cannot be graded', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    expect((await create(token, videoImage({ rubric: [] }))).status).toBe(400)
  })

  it('requires the rubric to total the question marks', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    // The rubric IS the mark scheme. If criteria sum to 8 on a 10-mark
    // question, a grader awarding everything produces a score the exam does
    // not expect.
    const res = await create(
      token,
      videoImage({ marks: 10, rubric: [{ criterion: 'Only this', maxMarks: 8 }] })
    )
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('total 8')
  })

  it('caps video size at 50MB and duration at 10 minutes (§10.1)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    expect((await create(token, videoImage({ maxFileSizeMb: 500 }))).status).toBe(400)
    expect((await create(token, videoImage({ maxVideoDurationSeconds: 99999 }))).status).toBe(400)
  })
})

describe('§10.3 required metadata', () => {
  it('requires English question text (§6.2)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    expect((await create(token, mcq({ questionTextEn: '' }))).status).toBe(400)
  })

  it('requires a topic', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const body = mcq()
    delete (body as Record<string, unknown>)['topicId']
    expect((await create(token, body)).status).toBe(400)
  })

  it('requires a source reference — a document OR a chapter', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const body = mcq()
    delete (body as Record<string, unknown>)['sourceDocumentId']

    const without = await create(token, body)
    expect(without.status).toBe(400)
    // Last of four addIssue calls in the create superRefine.
    expect(
      without.body.error.details.map((d: { message: string }) => d.message).join(' | ')
    ).toContain('source reference')

    // A free-text chapter satisfies §10.3 — not every SOP is uploaded yet.
    expect((await create(token, { ...body, sourceChapter: 'Chapter 3' })).status).toBe(201)
  })

  it('rejects an unknown topic or department', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const ghost = '00000000-0000-4000-8000-000000000000'
    expect((await create(token, mcq({ topicId: ghost }))).status).toBe(400)
    expect((await create(token, mcq({ departmentId: ghost }))).status).toBe(400)
  })

  it('rejects a designation range that is inverted', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await create(token, mcq({ designationLevelMin: 5, designationLevelMax: 2 }))
    expect(res.status).toBe(400)
  })
})

/**
 * The rules createQuestionSchema enforces must survive a partial update.
 *
 * Each request below is valid taken alone — the invariant only breaks relative
 * to the stored row, which a schema never sees. These all went through before
 * QuestionService.update started checking merged values.
 */
describe('§10.1/§10.3 invariants survive a partial update', () => {
  const edit = (token: string, id: string, body: unknown) =>
    request(app).put(`/api/v1/questions/${id}`).set(auth(token)).send(body)

  const messages = (res: { body: { error?: { details?: { message: string }[] } } }) =>
    (res.body.error?.details ?? []).map((d) => d.message).join(' | ')

  const draftOf = async (token: string, body: unknown) => {
    const res = await create(token, body)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    return res.body.data.id as string
  }

  it('refuses a designation minimum that overtakes the stored maximum', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftOf(token, mcq({ designationLevelMin: 1, designationLevelMax: 3 }))

    // Only the minimum is sent, and 5 is a perfectly legal level on its own.
    const res = await edit(token, id, { designationLevelMin: 5 })
    expect(res.status).toBe(400)
    expect(messages(res)).toContain('cannot exceed the maximum 3')
  })

  it('refuses a designation maximum that drops below the stored minimum', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftOf(token, mcq({ designationLevelMin: 4, designationLevelMax: 5 }))

    const res = await edit(token, id, { designationLevelMax: 2 })
    expect(res.status).toBe(400)
  })

  it('refuses a theory word limit that inverts against the stored one', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftOf(token, theory({ minWordLimit: 50, maxWordLimit: 200 }))

    const res = await edit(token, id, { minWordLimit: 500 })
    expect(res.status).toBe(400)
    expect(messages(res)).toContain('cannot exceed the maximum 200')
  })

  it('§10.3 refuses an update that strips the last source reference', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    // Created with a document and no chapter, so clearing the document leaves
    // the question with no provenance at all.
    const id = await draftOf(token, mcq({ sourceDocumentId: ctx.document }))

    const res = await edit(token, id, { sourceDocumentId: null })
    expect(res.status).toBe(400)
    expect(messages(res)).toContain('source reference is required')
  })

  it('allows swapping one source reference for the other', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftOf(token, mcq({ sourceDocumentId: ctx.document }))

    // §10.3 is satisfied by either, so trading a document for a chapter in one
    // request must be allowed — the merged row still has a reference.
    const res = await edit(token, id, { sourceDocumentId: null, sourceChapter: 'Chapter 7' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it('leaves valid updates alone', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftOf(token, mcq({ designationLevelMin: 1, designationLevelMax: 3 }))

    expect((await edit(token, id, { designationLevelMin: 2 })).status).toBe(200)
    expect((await edit(token, id, { difficulty: 'hard' })).status).toBe(200)
  })

  it('does not persist a rejected update', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftOf(token, mcq({ designationLevelMin: 1, designationLevelMax: 3 }))

    await edit(token, id, { designationLevelMin: 5 })

    const stored = await testDb().question.findUniqueOrThrow({ where: { id } })
    expect(stored.designationLevelMin).toBe(1)
  })

  it('§10.3 refuses clearing a chapter when it is the only reference', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    // The mirror of the sourceDocumentId case: sourceChapter is nullable too,
    // so the merge has to notice an explicit null on either field.
    const id = await draftOf(token, theory({ sourceChapter: 'Chapter 3' }))

    const res = await edit(token, id, { sourceChapter: null })
    expect(res.status).toBe(400)
    expect(messages(res)).toContain('source reference is required')
  })

  it('re-checks the video rubric total on a partial update', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = await draftOf(token, videoImage({ marks: 10 }))

    // The fourth create rule. Raising marks alone leaves the rubric — still
    // totalling 10 — describing a different mark scheme from the question.
    expect((await edit(token, id, { marks: 25 })).status).toBe(400)
    // Moving both together is fine.
    expect(
      (
        await edit(token, id, {
          marks: 6,
          rubric: [
            { criterion: 'Cheese distribution', maxMarks: 3 },
            { criterion: 'Basil placement', maxMarks: 3 },
          ],
        })
      ).status
    ).toBe(200)
  })

  it('lets an unrelated edit through on a row that is already invalid', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const author = await testDb().user.findFirstOrThrow()
    // Written straight to the database, as a pre-rule row would have been.
    const row = await testDb().question.create({
      data: {
        type: 'mcq',
        departmentId: ctx.kitchen,
        questionTextEn: 'A question with no source reference',
        marks: 1,
        status: 'draft',
        createdById: author.id,
        options: [
          { id: 'a', textEn: 'A', isCorrect: true },
          { id: 'b', textEn: 'B', isCorrect: false },
          { id: 'c', textEn: 'C', isCorrect: false },
          { id: 'd', textEn: 'D', isCorrect: false },
        ],
      },
    })

    // KNOWN BEHAVIOUR, asserted so a change to it is deliberate: the §10.3
    // check is not gated on the request touching a source field, so a legacy
    // row with no reference cannot be edited at all until one is supplied.
    // Unlike the template case this strands nothing — questions have no
    // equivalent of deactivation being blocked — and forcing the missing
    // reference on first edit is the outcome §10.3 wants.
    expect((await edit(token, row.id, { difficulty: 'hard' })).status).toBe(400)
    expect((await edit(token, row.id, { sourceChapter: 'Chapter 1' })).status).toBe(200)
  })
})

describe('§10.2 approval workflow', () => {
  async function draft(token: string) {
    const res = await create(token, mcq())
    expect(res.status).toBe(201)
    return res.body.data.id as string
  }

  it('runs draft → pending_review → approved', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const id = await draft(admin.token)

    const submitted = await request(app)
      .post(`/api/v1/questions/${id}/submit`)
      .set(auth(admin.token))
    expect(submitted.body.data.status).toBe('pending_review')

    const approved = await request(app)
      .post(`/api/v1/questions/${id}/approve`)
      .set(auth(admin.token))
      .send({})
    expect(approved.body.data.status).toBe('approved')
  })

  it('sends a rejection back to draft, with the reason recorded', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const id = await draft(admin.token)
    await request(app).post(`/api/v1/questions/${id}/submit`).set(auth(admin.token))

    const rejected = await request(app)
      .post(`/api/v1/questions/${id}/reject`)
      .set(auth(admin.token))
      .send({ comments: 'The Hindi translation is wrong' })

    // §4.1's enum has no `rejected` — a rejected question IS a draft needing
    // work. The reason lives in question_reviews.
    expect(rejected.body.data.status).toBe('draft')

    const detail = await request(app).get(`/api/v1/questions/${id}`).set(auth(admin.token))
    expect(detail.body.data.reviews[0].action).toBe('rejected')
    expect(detail.body.data.reviews[0].comments).toContain('Hindi translation')
  })

  it('requires a reason when rejecting', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const id = await draft(admin.token)
    await request(app).post(`/api/v1/questions/${id}/submit`).set(auth(admin.token))

    // A rejection with no reason is not actionable — the author cannot fix it.
    const res = await request(app)
      .post(`/api/v1/questions/${id}/reject`)
      .set(auth(admin.token))
      .send({})
    expect(res.status).toBe(400)
  })

  it('cannot approve a question straight from draft', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const id = await draft(admin.token)

    const res = await request(app)
      .post(`/api/v1/questions/${id}/approve`)
      .set(auth(admin.token))
      .send({})
    expect(res.status).toBe(400)
  })

  it('cannot edit an approved question', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const id = await draft(admin.token)
    await request(app).post(`/api/v1/questions/${id}/submit`).set(auth(admin.token))
    await request(app).post(`/api/v1/questions/${id}/approve`).set(auth(admin.token)).send({})

    // §11.3 builds exams from approved questions; editing one would silently
    // change an exam already built on it — or already sat.
    const res = await request(app)
      .put(`/api/v1/questions/${id}`)
      .set(auth(admin.token))
      .send({ questionTextEn: 'Sneaky edit' })
    expect(res.status).toBe(409)
    expect(res.body.error.details[0].message).toContain('Archive it')
  })

  /**
   * §10.1's option-set rules must survive an edit, not just a create.
   *
   * The update schema kept the "exactly 4 options" length check but dropped
   * both refinements, so a PATCH could leave an MCQ with no correct option or
   * two. Grading reads this array directly: with none correct every candidate
   * scores zero on the question, and with two, whichever the answer-key search
   * finds first silently becomes the right answer.
   */
  describe('§10.1 option rules survive an update', () => {
    const editOptions = async (token: string, id: string, options: unknown) =>
      request(app).put(`/api/v1/questions/${id}`).set(auth(token)).send({ options })

    const options = (over: { isCorrect?: boolean[]; ids?: string[] } = {}) =>
      ['a', 'b', 'c', 'd'].map((id, i) => ({
        id: over.ids?.[i] ?? id,
        textEn: `Option ${id}`,
        isCorrect: over.isCorrect?.[i] ?? i === 1,
      }))

    it('refuses an edit leaving no correct option', async () => {
      const admin = await tokenFor({ role: 'admin' })
      const id = await draft(admin.token)

      const res = await editOptions(
        admin.token,
        id,
        options({ isCorrect: [false, false, false, false] })
      )
      expect(res.status).toBe(400)
      expect(
        res.body.error.details.map((d: { message: string }) => d.message).join(' | ')
      ).toContain('exactly one correct option')
    })

    it('refuses an edit leaving two correct options', async () => {
      const admin = await tokenFor({ role: 'admin' })
      const id = await draft(admin.token)

      const res = await editOptions(
        admin.token,
        id,
        options({ isCorrect: [true, true, false, false] })
      )
      expect(res.status).toBe(400)
    })

    it('refuses duplicate option ids', async () => {
      const admin = await tokenFor({ role: 'admin' })
      const id = await draft(admin.token)

      // Two options sharing an id makes the stored answer ambiguous and the
      // candidate's selectedOptionId unresolvable.
      const res = await editOptions(admin.token, id, options({ ids: ['a', 'a', 'c', 'd'] }))
      expect(res.status).toBe(400)
    })

    it('still accepts a valid option set', async () => {
      const admin = await tokenFor({ role: 'admin' })
      const id = await draft(admin.token)

      const res = await editOptions(
        admin.token,
        id,
        options({ isCorrect: [false, false, true, false] })
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
    })
  })

  it('records who approved it and when', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const id = await draft(admin.token)
    await request(app).post(`/api/v1/questions/${id}/submit`).set(auth(admin.token))
    await request(app).post(`/api/v1/questions/${id}/approve`).set(auth(admin.token)).send({})

    const row = await testDb().question.findUniqueOrThrow({ where: { id } })
    expect(row.approvedById).toBe(admin.user.id)
    expect(row.approvedAt).not.toBeNull()
  })

  it('archives rather than deletes (exam responses reference questions)', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const id = await draft(admin.token)

    await request(app).delete(`/api/v1/questions/${id}`).set(auth(admin.token)).expect(200)

    const row = await testDb().question.findUnique({ where: { id } })
    expect(row).not.toBeNull()
    expect(row!.status).toBe('archived')
  })
})

describe('§3.2 RBAC — question bank', () => {
  it('lets super_admin, admin, outlet_manager and trainer create questions', async () => {
    for (const role of ['super_admin', 'admin', 'trainer'] as const) {
      const { token } = await tokenFor({ role })
      const res = await create(token, mcq({ outletId: null }))
      expect(res.status, `${role} must be able to author questions`).toBe(201)
    }

    const om = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    expect((await create(om.token, mcq({ outletId: ctx.aiko }))).status).toBe(201)
  })

  it('denies hr and staff the question bank entirely (§3.2)', async () => {
    for (const role of ['hr', 'staff'] as const) {
      const { token } = await tokenFor({ role, withEmployee: role === 'staff' })
      expect((await create(token, mcq())).status, `${role} must not author`).toBe(403)
      expect(
        (await request(app).get('/api/v1/questions').set(auth(token))).status,
        `${role} must not read`
      ).toBe(403)
    }
  })

  it('lets only super_admin and admin approve (§3.2)', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const id = (await create(admin.token, mcq())).body.data.id
    await request(app).post(`/api/v1/questions/${id}/submit`).set(auth(admin.token))

    for (const role of ['outlet_manager', 'trainer'] as const) {
      const { token } = await tokenFor({ role, managesOutletCodes: ['AK'] })
      const res = await request(app)
        .post(`/api/v1/questions/${id}/approve`)
        .set(auth(token))
        .send({})
      expect(res.status, `${role} must not approve`).toBe(403)
    }
  })

  it('scopes a trainer to their OWN questions (§3.2)', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const trainer = await tokenFor({ role: 'trainer' })

    const mine = (await create(trainer.token, mcq({ outletId: null }))).body.data.id
    const theirs = (await create(admin.token, mcq({ outletId: null }))).body.data.id

    await request(app)
      .put(`/api/v1/questions/${mine}`)
      .set(auth(trainer.token))
      .send({ difficulty: 'hard' })
      .expect(200)

    // Another author's question is invisible to them, so 404 not 403.
    const other = await request(app)
      .put(`/api/v1/questions/${theirs}`)
      .set(auth(trainer.token))
      .send({ difficulty: 'hard' })
    expect(other.status).toBe(404)
  })

  /**
   * Trainer reads are scoped to their assigned outlets — §3.2 as written.
   *
   * This test used to assert the opposite ("READ the whole bank"), because
   * §3.2's "Own outlet" was not implementable: `own_outlet` resolved solely from
   * Outlet.managerId, a trainer never holds one, so the scope was always empty
   * and the role would have been dead. `user_outlets` fixed that, so the
   * assertion now follows the spec rather than the workaround.
   *
   * Global questions (outletId null) stay visible — that is the read/write
   * asymmetry in scope.ts, not a trainer exception.
   */
  it('scopes a trainer’s reads to their assigned outlets, and edits to their own work', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const trainer = await tokenFor({ role: 'trainer', assignedOutletCodes: ['AK'] })

    const globalQuestion = (await create(admin.token, mcq({ outletId: null }))).body.data.id
    const atAiko = (await create(admin.token, mcq({ outletId: ctx.aiko }))).body.data.id
    const atCapiche = (await create(admin.token, mcq({ outletId: ctx.capiche }))).body.data.id
    const mine = (await create(trainer.token, mcq({ outletId: null }))).body.data.id

    const res = await request(app).get('/api/v1/questions').set(auth(trainer.token))
    const ids = res.body.data.map((q: { id: string }) => q.id)

    expect(ids).toContain(mine)
    expect(ids).toContain(globalQuestion)
    expect(ids).toContain(atAiko)
    // The point of the change: another outlet's content is no longer visible.
    expect(ids).not.toContain(atCapiche)

    // The restriction that matters (§3.2 "Own questions") still holds.
    await request(app)
      .put(`/api/v1/questions/${globalQuestion}`)
      .set(auth(trainer.token))
      .send({ difficulty: 'hard' })
      .expect(404)
  })

  it('denies a trainer with no outlet assignment, and says why', async () => {
    const trainer = await tokenFor({ role: 'trainer' })

    // Not an empty list masquerading as "no data": an unassigned trainer is a
    // misconfigured account, and the 403 has to say so or it looks like a bug.
    const res = await request(app).get('/api/v1/questions').set(auth(trainer.token))

    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('not assigned to any outlet')
  })
})

describe('the outletId=NULL read/write asymmetry (§4.1)', () => {
  /**
   * The sharpest edge in scope.ts, built in Module 1 and untestable until now.
   * Question.outletId is nullable and NULL means "applies to all outlets".
   */
  it('lets an outlet_manager SEE a global question', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const global = (await create(admin.token, mcq({ outletId: null }))).body.data.id
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    // A global question appears in their staff's exams, so they must see it.
    const list = await request(app).get('/api/v1/questions').set(auth(manager.token))
    expect(list.body.data.map((q: { id: string }) => q.id)).toContain(global)

    await request(app).get(`/api/v1/questions/${global}`).set(auth(manager.token)).expect(200)
  })

  it('does NOT let an outlet_manager EDIT a global question', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const global = (await create(admin.token, mcq({ outletId: null }))).body.data.id
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    // Editing it would silently change content for Capiche and Prep too.
    const res = await request(app)
      .put(`/api/v1/questions/${global}`)
      .set(auth(manager.token))
      .send({ questionTextEn: 'Rewritten for Aiko only' })

    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('applies to all outlets')

    const row = await testDb().question.findUniqueOrThrow({ where: { id: global } })
    expect(row.questionTextEn).not.toBe('Rewritten for Aiko only')
  })

  it('does NOT let an outlet_manager archive a global question', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const global = (await create(admin.token, mcq({ outletId: null }))).body.data.id
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app).delete(`/api/v1/questions/${global}`).set(auth(manager.token))
    expect(res.status).toBe(403)
  })

  it('lets an outlet_manager edit their OWN outlet’s question', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const aikoQuestion = (await create(admin.token, mcq({ outletId: ctx.aiko }))).body.data.id
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    await request(app)
      .put(`/api/v1/questions/${aikoQuestion}`)
      .set(auth(manager.token))
      .send({ difficulty: 'hard' })
      .expect(200)
  })

  it('hides another outlet’s question from an outlet_manager entirely', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const capicheQuestion = (await create(admin.token, mcq({ outletId: ctx.capiche }))).body.data.id
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const list = await request(app).get('/api/v1/questions').set(auth(manager.token))
    expect(list.body.data.map((q: { id: string }) => q.id)).not.toContain(capicheQuestion)

    await request(app)
      .get(`/api/v1/questions/${capicheQuestion}`)
      .set(auth(manager.token))
      .expect(404)
  })

  /**
   * The create/edit mismatch is closed.
   *
   * These two tests previously asserted the opposite: that an outlet_manager
   * COULD create a global question, and then could not edit the thing it had
   * just made. That transcribed §3.2's "Create questions" ✅ literally, and the
   * older comment flagged the pair as odd and awaiting client confirmation.
   *
   * It has now been confirmed as a defect rather than a rule: authoring content
   * that lands in every outlet's exams is not something an outlet-scoped role
   * should be able to do, least of all content it cannot subsequently correct.
   * `question:create` is `own_outlet` for outlet_manager, so the create is
   * refused at the source and the follow-on test has nothing left to assert.
   */
  it('stops an outlet_manager creating a global question', async () => {
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await create(manager.token, mcq({ outletId: null }))

    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('must specify an outlet')
  })

  it('still lets an outlet_manager create a question for an outlet it manages', async () => {
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await create(manager.token, mcq({ outletId: ctx.aiko }))

    // Narrowing must not break the legitimate case.
    expect(res.status).toBe(201)
  })

  it('stops an outlet_manager creating a question for an outlet it does not manage', async () => {
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await create(manager.token, mcq({ outletId: ctx.capiche }))

    expect(res.status).toBe(403)
  })

  it('stops an outlet_manager moving their question to global scope', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const aikoQuestion = (await create(admin.token, mcq({ outletId: ctx.aiko }))).body.data.id
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    // The escape hatch: edit your own, then widen it to everyone.
    const res = await request(app)
      .put(`/api/v1/questions/${aikoQuestion}`)
      .set(auth(manager.token))
      .send({ outletId: null })
    expect(res.status).toBe(403)
  })
})

describe('§6.2 language resolution over the API', () => {
  it('returns the requested language', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = (await create(token, mcq())).body.data.id

    const res = await request(app).get(`/api/v1/questions/${id}?lang=gu`).set(auth(token))
    expect(res.body.data.questionText).toBe('ચિકનને કયા તાપમાને રાંધવું જોઈએ?')
    expect(res.body.data.questionTextLanguage).toBe('gu')
  })

  it('falls back Gujarati → Hindi and says so', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = (await create(token, mcq({ questionTextGu: undefined }))).body.data.id

    const res = await request(app).get(`/api/v1/questions/${id}?lang=gu`).set(auth(token))
    expect(res.body.data.questionText).toBe('चिकन को किस तापमान पर पकाना चाहिए?')
    // The APK needs this to pick a Devanagari font in a Gujarati UI (§6.3).
    expect(res.body.data.questionTextLanguage).toBe('hi')
  })

  it('falls back to English when no translation exists', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = (await create(token, theory())).body.data.id

    const res = await request(app).get(`/api/v1/questions/${id}?lang=gu`).set(auth(token))
    expect(res.body.data.questionText).toBe('Explain the cold chain.')
    expect(res.body.data.questionTextLanguage).toBe('en')
  })
})

describe('§10.5 question bank statistics', () => {
  it('counts by type, difficulty and status', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await create(token, mcq())
    await create(token, mcq({ difficulty: 'hard' }))
    await create(token, theory())

    const res = await request(app).get('/api/v1/questions/stats').set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(3)
    expect(res.body.data.byType).toEqual({ mcq: 2, theory: 1 })
    expect(res.body.data.byDifficulty).toEqual({ easy: 1, hard: 1, medium: 1 })
    expect(res.body.data.byStatus).toEqual({ draft: 3 })
  })

  it('counts questions missing Hindi and Gujarati (§10.5)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await create(token, mcq()) // fully translated
    await create(token, theory()) // English only

    const res = await request(app).get('/api/v1/questions/stats').set(auth(token))
    expect(res.body.data.missingTranslations).toEqual({ hi: 1, gu: 1 })
  })

  it('reports the pending review queue', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = (await create(token, mcq())).body.data.id
    await request(app).post(`/api/v1/questions/${id}/submit`).set(auth(token))

    const res = await request(app).get('/api/v1/questions/stats').set(auth(token))
    expect(res.body.data.pendingReview).toBe(1)
  })

  it('scopes stats to what the caller can see', async () => {
    const admin = await tokenFor({ role: 'admin' })
    await create(admin.token, mcq({ outletId: ctx.capiche }))
    await create(admin.token, mcq({ outletId: ctx.aiko }))
    await create(admin.token, mcq({ outletId: null }))

    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await request(app).get('/api/v1/questions/stats').set(auth(manager.token))

    // Their outlet's question plus the global one — not Capiche's.
    expect(res.body.data.total).toBe(2)
  })
})

describe('§10.5 filters', () => {
  it('filters by type, difficulty and topic', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await create(token, mcq({ difficulty: 'hard' }))
    await create(token, theory())

    const byType = await request(app).get('/api/v1/questions?type=theory').set(auth(token))
    expect(byType.body.data).toHaveLength(1)

    const byDifficulty = await request(app)
      .get('/api/v1/questions?difficulty=hard')
      .set(auth(token))
    expect(byDifficulty.body.data).toHaveLength(1)

    const byTopic = await request(app)
      .get(`/api/v1/questions?topic_id=${ctx.topic}`)
      .set(auth(token))
    expect(byTopic.body.data).toHaveLength(2)
  })

  it('searches across all three languages', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await create(token, mcq())

    const english = await request(app).get('/api/v1/questions?search=chicken').set(auth(token))
    expect(english.body.data).toHaveLength(1)

    const gujarati = await request(app).get('/api/v1/questions?search=ચિકન').set(auth(token))
    expect(gujarati.body.data).toHaveLength(1)
  })

  it('finds questions still needing a translation (§10.5)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await create(token, mcq()) // translated
    const untranslated = (await create(token, theory())).body.data.id

    const res = await request(app).get('/api/v1/questions?missing_translation=gu').set(auth(token))
    expect(res.body.data.map((q: { id: string }) => q.id)).toEqual([untranslated])
  })

  it('hides archived questions by default', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const id = (await create(token, mcq())).body.data.id
    await request(app).delete(`/api/v1/questions/${id}`).set(auth(token))

    const active = await request(app).get('/api/v1/questions').set(auth(token))
    expect(active.body.data).toHaveLength(0)

    const archived = await request(app).get('/api/v1/questions?status=archived').set(auth(token))
    expect(archived.body.data).toHaveLength(1)
  })
})
