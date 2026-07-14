import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'

let app: Application

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app

  const db = testDb()
  const kitchen = await db.department.findFirstOrThrow({ where: { code: 'KIT' } })
  await db.sourceDocument.create({
    data: { title: 'Food Safety Manual', type: 'sop', departmentId: kitchen.id },
  })
  await db.topic.create({ data: { nameEn: 'Food Safety', departmentId: kitchen.id } })
  // A topic in another department, for the coherence check.
  const service = await db.department.findFirstOrThrow({ where: { code: 'SRV' } })
  await db.topic.create({ data: { nameEn: 'Guest Greeting', departmentId: service.id } })
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
  return res.body.data.accessToken as string
}

/** §10.4's column order, verbatim from the spec. */
const HEADER = [
  'type',
  'difficulty',
  'department',
  'topic',
  'question_en',
  'question_hi',
  'question_gu',
  'option_a_en',
  'option_a_hi',
  'option_a_gu',
  'option_b_en',
  'option_b_hi',
  'option_b_gu',
  'option_c_en',
  'option_c_hi',
  'option_c_gu',
  'option_d_en',
  'option_d_hi',
  'option_d_gu',
  'correct_option',
  'marks',
  'explanation_en',
  'source_document',
  'source_chapter',
].join(',')

/** The exact example row from §10.4. */
const SPEC_ROW = [
  'mcq',
  'easy',
  'Kitchen',
  'Food Safety',
  '"What temperature should chicken be cooked to?"',
  '"चिकन को किस तापमान पर पकाना चाहिए?"',
  '"ચિકનને કયા તાપમાને રાંધવું જોઈએ?"',
  '"65°C"',
  '"65°C"',
  '"65°C"',
  '"74°C"',
  '"74°C"',
  '"74°C"',
  '"80°C"',
  '"80°C"',
  '"80°C"',
  '"90°C"',
  '"90°C"',
  '"90°C"',
  'B',
  '1',
  '"The safe internal temperature for chicken is 74°C"',
  '"Food Safety Manual"',
  '"Chapter 3"',
].join(',')

function csv(...rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8')
}

const upload = (token: string, buffer: Buffer, query = '') =>
  request(app)
    .post(`/api/v1/questions/bulk-import${query}`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, 'questions.csv')

describe('§10.4 import format', () => {
  it('imports the exact example row from the spec', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, csv(SPEC_ROW))

    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)
  })

  it('stores all three languages intact', async () => {
    const token = await tokenFor({ role: 'admin' })
    await upload(token, csv(SPEC_ROW))

    // The whole point of the product, and the thing a WIN1252 database
    // silently rejected until Module 4 caught it.
    const q = await testDb().question.findFirstOrThrow()
    expect(q.questionTextEn).toBe('What temperature should chicken be cooked to?')
    expect(q.questionTextHi).toBe('चिकन को किस तापमान पर पकाना चाहिए?')
    expect(q.questionTextGu).toBe('ચિકનને કયા તાપમાને રાંધવું જોઈએ?')
  })

  it('reassembles the four options from twelve flat columns', async () => {
    const token = await tokenFor({ role: 'admin' })
    await upload(token, csv(SPEC_ROW))

    const q = await testDb().question.findFirstOrThrow()
    const options = q.options as Array<{ id: string; textEn: string; isCorrect: boolean }>
    expect(options).toHaveLength(4)
    expect(options.map((o) => o.textEn)).toEqual(['65°C', '74°C', '80°C', '90°C'])
  })

  it('maps correct_option=B onto the right option', async () => {
    const token = await tokenFor({ role: 'admin' })
    await upload(token, csv(SPEC_ROW))

    const q = await testDb().question.findFirstOrThrow()
    const options = q.options as Array<{ id: string; textEn: string; isCorrect: boolean }>
    const correct = options.filter((o) => o.isCorrect)

    expect(correct).toHaveLength(1)
    // 74°C is the right answer per §10.4's own explanation column.
    expect(correct[0]!.textEn).toBe('74°C')
  })

  it('imports as DRAFT — a bulk upload is not a review (§10.2)', async () => {
    const token = await tokenFor({ role: 'admin' })
    await upload(token, csv(SPEC_ROW))

    const q = await testDb().question.findFirstOrThrow()
    expect(q.status).toBe('draft')
  })

  it('resolves department, topic and source document by name', async () => {
    const token = await tokenFor({ role: 'admin' })
    await upload(token, csv(SPEC_ROW))

    const q = await testDb().question.findFirstOrThrow({
      include: { topic: true, department: true, sourceDocument: true },
    })
    expect(q.department.code).toBe('KIT')
    expect(q.topic!.nameEn).toBe('Food Safety')
    expect(q.sourceDocument!.title).toBe('Food Safety Manual')
  })
})

describe('§10.4 validation', () => {
  const row = (over: Record<number, string>) => {
    const cells = SPEC_ROW.split(',')
    for (const [i, value] of Object.entries(over)) cells[Number(i)] = value
    return cells.join(',')
  }

  it('rejects an unknown type', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, csv(row({ 0: 'essay' })), '?dryRun=true')
    expect(res.body.data.rows[0].errors[0].field).toBe('type')
  })

  it('rejects an unknown department or topic', async () => {
    const token = await tokenFor({ role: 'admin' })

    const dept = await upload(token, csv(row({ 2: 'Wizardry' })), '?dryRun=true')
    expect(dept.body.data.rows[0].errors.map((e: { field: string }) => e.field)).toContain(
      'department'
    )

    const topic = await upload(token, csv(row({ 3: 'Nonsense' })), '?dryRun=true')
    expect(topic.body.data.rows[0].errors.map((e: { field: string }) => e.field)).toContain('topic')
  })

  it('rejects a topic from a different department', async () => {
    const token = await tokenFor({ role: 'admin' })
    // Guest Greeting is a Service topic, not Kitchen — the question would be
    // filed where nobody looks for it.
    const res = await upload(token, csv(row({ 3: 'Guest Greeting' })), '?dryRun=true')
    const err = res.body.data.rows[0].errors.find((e: { field: string }) => e.field === 'topic')
    expect(err.message).toContain('does not belong')
  })

  it('requires correct_option', async () => {
    const token = await tokenFor({ role: 'admin' })
    // An MCQ with no correct answer is auto-graded as always-wrong, and nobody
    // notices until the whole outlet fails that question.
    const res = await upload(token, csv(row({ 19: '' })), '?dryRun=true')
    expect(res.body.data.rows[0].errors[0].field).toBe('correct_option')
  })

  it('rejects a correct_option that is not A-D', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, csv(row({ 19: 'E' })), '?dryRun=true')
    expect(res.body.data.rows[0].errors[0].message).toContain('A, B, C, D')
  })

  it('requires English text for every option (§10.1 needs 4)', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, csv(row({ 16: '' })), '?dryRun=true')
    expect(res.body.data.rows[0].errors[0].field).toBe('option_d_en')
  })

  it('requires English question text (§6.2)', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, csv(row({ 4: '' })), '?dryRun=true')
    expect(res.body.data.rows[0].errors.length).toBeGreaterThan(0)
  })

  it('refuses video_image rows, which §10.4 cannot express', async () => {
    const token = await tokenFor({ role: 'admin' })
    // §10.1 makes a rubric mandatory for this type; §10.4's format has no
    // rubric columns. Better to say so than import an ungradeable question.
    const res = await upload(token, csv(row({ 0: 'video_image' })), '?dryRun=true')
    expect(res.body.data.rows[0].errors[0].message).toContain('rubric')
  })

  it('names the missing required columns', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, Buffer.from('type,difficulty\nmcq,easy'))
    expect(res.status).toBe(400)
    const fields = res.body.error.details.map((d: { field: string }) => d.field)
    expect(fields).toEqual(expect.arrayContaining(['department', 'topic', 'question_en']))
  })
})

describe('§10.4 preview and partial import', () => {
  it('dryRun reports without writing', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await upload(token, csv(SPEC_ROW), '?dryRun=true')

    expect(res.body.data.dryRun).toBe(true)
    expect(res.body.data.valid).toBe(1)
    expect(res.body.data.imported).toBe(0)
    expect(await testDb().question.count()).toBe(0)
  })

  it('imports valid rows and skips bad ones', async () => {
    const token = await tokenFor({ role: 'admin' })
    const bad = SPEC_ROW.split(',')
    bad[2] = 'Wizardry'

    const res = await upload(token, csv(SPEC_ROW, bad.join(','), SPEC_ROW))
    expect(res.body.data.imported).toBe(2)
    expect(res.body.data.invalid).toBe(1)
    expect(await testDb().question.count()).toBe(2)
  })

  it('reports translation coverage for the batch (§10.5)', async () => {
    const token = await tokenFor({ role: 'admin' })
    const englishOnly = SPEC_ROW.split(',')
    englishOnly[5] = '' // no Hindi
    englishOnly[6] = '' // no Gujarati

    const res = await upload(token, csv(SPEC_ROW, englishOnly.join(',')))
    expect(res.body.data.imported).toBe(2)
    expect(res.body.data.translations).toEqual({ hi: 1, gu: 1 })
  })

  it('treats a blank translation cell as absent, not as an empty translation', async () => {
    const token = await tokenFor({ role: 'admin' })
    const noHindi = SPEC_ROW.split(',')
    noHindi[5] = ''

    await upload(token, csv(noHindi.join(',')))
    const q = await testDb().question.findFirstOrThrow()

    // If '' were stored, §6.2's fallback would serve a staff member a blank
    // question instead of falling through to English.
    expect(q.questionTextHi).toBeNull()
  })

  it('points errors at the row number in the operator’s file', async () => {
    const token = await tokenFor({ role: 'admin' })
    const bad = SPEC_ROW.split(',')
    bad[2] = 'Wizardry'

    const res = await upload(token, csv(SPEC_ROW, bad.join(',')), '?dryRun=true')
    // Line 3: the header is line 1.
    expect(res.body.data.rows[1].lineNumber).toBe(3)
  })
})

describe('§3.2 RBAC — bulk import is admin-only', () => {
  it('lets super_admin and admin import', async () => {
    for (const role of ['super_admin', 'admin'] as const) {
      const token = await tokenFor({ role })
      expect((await upload(token, csv(SPEC_ROW), '?dryRun=true')).status).toBe(200)
    }
  })

  it('denies everyone else (§3.2 "Import bulk questions")', async () => {
    for (const role of ['outlet_manager', 'trainer', 'hr', 'staff'] as const) {
      const token = await tokenFor({
        role,
        withEmployee: role === 'staff',
        managesOutletCodes: role === 'outlet_manager' ? ['AK'] : undefined,
      })
      const res = await upload(token, csv(SPEC_ROW))
      expect(res.status, `${role} must not bulk import`).toBe(403)
    }
  })

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/questions/bulk-import')
      .attach('file', csv(SPEC_ROW), 'questions.csv')
    expect(res.status).toBe(401)
  })
})
