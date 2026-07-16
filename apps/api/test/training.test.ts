import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import {
  truncateAll,
  disconnectDb,
  testDb,
  testTenantId,
  TEST_TENANT_SLUG,
} from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

/**
 * Training assignments and recommendations (§13, §18).
 *
 * §1.2 says the exam is the input and the performance record is the product.
 * This is where that is cashed: the recommendation tests are the ones that
 * matter, because a score nobody acts on is just a number.
 */

let app: Application
let ctx: { kitchenId: string; topicId: string; otherTopicId: string; docId: string; adminId: string }

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  app = buildTestApp().app

  const tenantId = testTenantId()
  const kitchen = await testDb().department.findFirstOrThrow({ where: { tenantId, code: 'KIT' } })
  const admin = await testDb().user.create({
    data: { tenantId, phone: '9440000001', role: 'admin', passwordHash: 'x' },
  })
  const doc = await testDb().sourceDocument.create({
    data: { tenantId, title: 'Food Safety Manual', type: 'sop', departmentId: kitchen.id },
  })
  const topic = await testDb().topic.create({
    data: { tenantId, nameEn: 'Food Safety', departmentId: kitchen.id, sourceDocumentId: doc.id },
  })
  const other = await testDb().topic.create({
    data: { tenantId, nameEn: 'Knife Skills', departmentId: kitchen.id },
  })

  ctx = {
    kitchenId: kitchen.id,
    topicId: topic.id,
    otherTopicId: other.id,
    docId: doc.id,
    adminId: admin.id,
  }
})

afterAll(async () => {
  await disconnectDb()
})

async function tokenFor(over: Parameters<typeof makeUser>[0] = {}) {
  const made = await makeUser({ role: 'admin', mustChangePassword: false, ...over })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
  expect(res.status).toBe(200)
  return { token: res.body.data.accessToken as string, ...made }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

/** An employee with a snapshot carrying the given per-topic scores. */
async function employeeScoring(
  topicScores: Record<string, { score: number; total: number }>,
  opts: { outlet?: string } = {}
) {
  const made = await makeUser({
    role: 'staff',
    withEmployee: true,
    mustChangePassword: false,
    employeeOutletCode: opts.outlet ?? 'AK',
  })
  const employee = await testDb().employee.findFirstOrThrow({ where: { userId: made.user.id } })

  await testDb().performanceSnapshot.create({
    data: {
      tenantId: testTenantId(),
      employeeId: employee.id,
      year: 2026,
      month: 7,
      topicScores,
      averageScore: 50,
    },
  })

  return { ...made, employee }
}

describe('§18 recommendations are derived from what people got wrong', () => {
  it('proposes training for a topic below the threshold', async () => {
    const { employee } = await employeeScoring({ [ctx.topicId]: { score: 3, total: 10 } })
    const { token } = await tokenFor()

    const res = await request(app)
      .get('/api/v1/training/recommendations?year=2026&month=7')
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].employeeId).toBe(employee.id)
    expect(res.body.data[0].percentage).toBe(30)
    expect(res.body.data[0].topic.nameEn).toBe('Food Safety')
  })

  it('suggests the topic’s own source document, so accepting it needs no hunting', async () => {
    await employeeScoring({ [ctx.topicId]: { score: 2, total: 10 } })
    const { token } = await tokenFor()

    const res = await request(app)
      .get('/api/v1/training/recommendations?year=2026&month=7')
      .set(auth(token))

    expect(res.body.data[0].suggestedSourceDocumentId).toBe(ctx.docId)
  })

  it('ignores a topic at or above the threshold', async () => {
    await employeeScoring({ [ctx.topicId]: { score: 6, total: 10 } }) // 60% == threshold
    const { token } = await tokenFor()

    const res = await request(app)
      .get('/api/v1/training/recommendations?year=2026&month=7')
      .set(auth(token))
    expect(res.body.data).toHaveLength(0)
  })

  it('honours a custom threshold', async () => {
    await employeeScoring({ [ctx.topicId]: { score: 7, total: 10 } })
    const { token } = await tokenFor()

    const strict = await request(app)
      .get('/api/v1/training/recommendations?year=2026&month=7&threshold=80')
      .set(auth(token))
    expect(strict.body.data).toHaveLength(1)
  })

  it('does NOT treat an untested topic as a weakness', async () => {
    // 0 of 0 is not 0%. Recommending training for a topic the exam never asked
    // about is how the list becomes noise nobody reads.
    await employeeScoring({ [ctx.topicId]: { score: 0, total: 0 } })
    const { token } = await tokenFor()

    const res = await request(app)
      .get('/api/v1/training/recommendations?year=2026&month=7')
      .set(auth(token))
    expect(res.body.data).toHaveLength(0)
  })

  it('orders weakest first, because whoever reads it will stop partway', async () => {
    await employeeScoring({ [ctx.topicId]: { score: 5, total: 10 } })
    await employeeScoring({ [ctx.otherTopicId]: { score: 1, total: 10 } })
    const { token } = await tokenFor()

    const res = await request(app)
      .get('/api/v1/training/recommendations?year=2026&month=7')
      .set(auth(token))

    expect(res.body.data[0].percentage).toBe(10)
    expect(res.body.data[1].percentage).toBe(50)
  })

  it('does not re-recommend what is already assigned and open', async () => {
    const { employee } = await employeeScoring({ [ctx.topicId]: { score: 1, total: 10 } })
    const { token } = await tokenFor()

    await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })

    const res = await request(app)
      .get('/api/v1/training/recommendations?year=2026&month=7')
      .set(auth(token))
    expect(res.body.data).toHaveLength(0)
  })

  it('DOES recommend again once the earlier assignment is completed', async () => {
    const { employee } = await employeeScoring({ [ctx.topicId]: { score: 1, total: 10 } })
    const { token } = await tokenFor()

    const created = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })
    await request(app)
      .post(`/api/v1/training/${created.body.data.id}/complete`)
      .set(auth(token))
      .send({})

    // They read the manual and still scored 10%. That is exactly the person who
    // needs it again — suppressing it would hide the failure of the training.
    const res = await request(app)
      .get('/api/v1/training/recommendations?year=2026&month=7')
      .set(auth(token))
    expect(res.body.data).toHaveLength(1)
  })

  it('writes NOTHING — a recommendation is a proposal, not an action', async () => {
    await employeeScoring({ [ctx.topicId]: { score: 1, total: 10 } })
    const { token } = await tokenFor()

    await request(app).get('/api/v1/training/recommendations?year=2026&month=7').set(auth(token))
    expect(await testDb().trainingAssignment.count()).toBe(0)
  })

  it('is scoped: an outlet_manager sees only their own outlet’s people', async () => {
    await employeeScoring({ [ctx.topicId]: { score: 1, total: 10 } }, { outlet: 'AK' })
    await employeeScoring({ [ctx.topicId]: { score: 1, total: 10 } }, { outlet: 'CP' })

    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await request(app)
      .get('/api/v1/training/recommendations?year=2026&month=7')
      .set(auth(token))

    expect(res.body.data).toHaveLength(1)
  })
})

describe('§13 assigning training', () => {
  it('assigns with a default due date two weeks out', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    const res = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId, reason: 'Scored 30% in July' })

    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('assigned')
    expect(res.body.data.isAutoAssigned).toBe(false)

    const due = new Date(res.body.data.dueDate).getTime()
    expect(due).toBeGreaterThan(Date.now())
    expect(due).toBeLessThan(Date.now() + 15 * 24 * 3600 * 1000)
  })

  it('refuses an assignment with nothing to study', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    // No topic and no document is a due date attached to nothing.
    const res = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, reason: 'Do better' })

    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toMatch(/topic, a source document, or both/)
  })

  it('refuses a duplicate open assignment, and says when the first was made', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })

    const res = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })

    expect(res.status).toBe(409)
    expect(res.body.error.details[0].message).toMatch(/Assigned on \d{4}-\d{2}-\d{2}/)
  })

  it('allows re-assigning the same topic once the first is complete', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    const first = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })
    await request(app)
      .post(`/api/v1/training/${first.body.data.id}/complete`)
      .set(auth(token))
      .send({})

    const second = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })
    expect(second.status).toBe(201)
  })

  it('refuses to assign homework to someone who has left', async () => {
    const { employee } = await employeeScoring({})
    await testDb().employee.update({
      where: { id: employee.id },
      data: { employmentStatus: 'resigned' },
    })
    const { token } = await tokenFor()

    const res = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })

    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toMatch(/resigned/)
  })

  it('rejects an unknown topic rather than assigning a dangling reference', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    const res = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: '00000000-0000-0000-0000-000000000000' })
    expect(res.status).toBe(400)
  })
})

describe('§3.2 scope', () => {
  it('an outlet_manager cannot assign into an outlet they do not manage', async () => {
    const { employee } = await employeeScoring({}, { outlet: 'CP' })
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })

    // NOT_FOUND, not FORBIDDEN: a 403 confirms the employee exists, which leaks
    // another outlet's roster to anyone willing to enumerate ids.
    expect(res.status).toBe(404)
  })

  it('hr cannot assign training at all (§3.2)', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor({ role: 'hr' })

    const res = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })
    expect(res.status).toBe(403)
  })

  it('a trainer can assign, per the matrix', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor({ role: 'trainer' })

    const res = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })
    expect(res.status).toBe(201)
  })
})

describe('§13 completing training', () => {
  it('marks it complete with notes', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    const created = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })

    const res = await request(app)
      .post(`/api/v1/training/${created.body.data.id}/complete`)
      .set(auth(token))
      .send({ completionNotes: 'Read the manual and discussed with the head chef' })

    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('completed')
    expect(res.body.data.completedAt).toBeTruthy()
  })

  it('moves through in_progress so a manager can see it was started', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    const created = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })

    const started = await request(app)
      .post(`/api/v1/training/${created.body.data.id}/start`)
      .set(auth(token))
    expect(started.body.data.status).toBe('in_progress')
  })

  it('refuses to complete twice', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    const created = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })
    await request(app)
      .post(`/api/v1/training/${created.body.data.id}/complete`)
      .set(auth(token))
      .send({})

    const again = await request(app)
      .post(`/api/v1/training/${created.body.data.id}/complete`)
      .set(auth(token))
      .send({})
    expect(again.status).toBe(409)
  })
})

describe('§13 overdue is derived, never stored', () => {
  it('reports overdue from the due date rather than a status column', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    const created = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })

    // Backdate it. Nothing runs at midnight to flip a status, so a stored
    // `overdue` would only be true when a job last ran — i.e. it would lie.
    await testDb().trainingAssignment.update({
      where: { id: created.body.data.id },
      data: { dueDate: new Date('2020-01-01') },
    })

    const list = await request(app).get('/api/v1/training').set(auth(token))
    expect(list.body.data[0].isOverdue).toBe(true)
    // The stored status is untouched — the derivation is the truth.
    expect(list.body.data[0].status).toBe('assigned')
  })

  it('a completed assignment is never overdue, however late it was', async () => {
    const { employee } = await employeeScoring({})
    const { token } = await tokenFor()

    const created = await request(app)
      .post('/api/v1/training')
      .set(auth(token))
      .send({ employeeId: employee.id, topicId: ctx.topicId })
    await testDb().trainingAssignment.update({
      where: { id: created.body.data.id },
      data: { dueDate: new Date('2020-01-01') },
    })
    await request(app)
      .post(`/api/v1/training/${created.body.data.id}/complete`)
      .set(auth(token))
      .send({})

    const list = await request(app).get('/api/v1/training').set(auth(token))
    expect(list.body.data[0].isOverdue).toBe(false)
  })
})
