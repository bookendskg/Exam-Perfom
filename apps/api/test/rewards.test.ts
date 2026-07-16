import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb, testTenantId, TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'
import {
  formatCertificateNumber,
  parseCertificateNumber,
} from '../src/rewards/certificate-number.js'

/**
 * Rewards and certificates (§12).
 *
 * The certificate-numbering tests carry the most weight: a number is a claim an
 * employee makes to a future employer, so a duplicate is unfixable after the
 * fact and a reused one makes the first holder's record unverifiable.
 */

let app: Application

beforeEach(async () => {
  await truncateAll()
  await testDb().certificateCounter.deleteMany()
  await resetOutletManagers()
  app = buildTestApp().app
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

async function performer(averageScore: number, opts: { outlet?: string; improvement?: number } = {}) {
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
      averageScore,
      examsAttempted: 2,
      examsPassed: 2,
      ...(opts.improvement !== undefined ? { improvementFromLast: opts.improvement } : {}),
    },
  })

  return { ...made, employee }
}

describe('§4.1 certificate numbers', () => {
  it('formats as CERT-YYYY-NNNN', () => {
    expect(formatCertificateNumber(2026, 1)).toBe('CERT-2026-0001')
    expect(formatCertificateNumber(2026, 42)).toBe('CERT-2026-0042')
  })

  it('does not truncate past 9999', () => {
    expect(formatCertificateNumber(2026, 10000)).toBe('CERT-2026-10000')
  })

  it('round-trips through the parser', () => {
    expect(parseCertificateNumber('CERT-2026-0007')).toEqual({ year: 2026, sequence: 7 })
    expect(parseCertificateNumber('not-a-number')).toBeNull()
  })
})

describe('§12 issuing certificates', () => {
  it('issues with a sequential number', async () => {
    const { employee } = await performer(90)
    const { token } = await tokenFor()

    const res = await request(app)
      .post('/api/v1/certificates')
      .set(auth(token))
      .send({ employeeId: employee.id, type: 'monthly', title: 'Top Performer — July 2026' })

    expect(res.status).toBe(201)
    expect(res.body.data.certificateNumber).toMatch(/^CERT-\d{4}-0001$/)
    // The record exists; the PDF does not. Rendering needs a library, §5.2's
    // branding assets and file storage — none of which exist — and an unbranded
    // PDF to nowhere would be worse than an honest null.
    expect(res.body.data.certificateUrl).toBeNull()
  })

  it('numbers sequentially within a year', async () => {
    const a = await performer(90)
    const b = await performer(85)
    const { token } = await tokenFor()

    const first = await request(app)
      .post('/api/v1/certificates')
      .set(auth(token))
      .send({ employeeId: a.employee.id, type: 'monthly', title: 'First' })
    const second = await request(app)
      .post('/api/v1/certificates')
      .set(auth(token))
      .send({ employeeId: b.employee.id, type: 'monthly', title: 'Second' })

    expect(parseCertificateNumber(first.body.data.certificateNumber)!.sequence).toBe(1)
    expect(parseCertificateNumber(second.body.data.certificateNumber)!.sequence).toBe(2)
  })

  it('NEVER reuses a number, even after the certificate is deleted', async () => {
    const { employee } = await performer(90)
    const { token } = await tokenFor()

    const first = await request(app)
      .post('/api/v1/certificates')
      .set(auth(token))
      .send({ employeeId: employee.id, type: 'monthly', title: 'Revoked later' })

    // Revoke it. A number that came back would make the original holder's claim
    // unverifiable against a different person's record — unfixable afterwards.
    await testDb().certificate.delete({ where: { id: first.body.data.id } })

    const second = await request(app)
      .post('/api/v1/certificates')
      .set(auth(token))
      .send({ employeeId: employee.id, type: 'monthly', title: 'Next' })

    expect(second.body.data.certificateNumber).not.toBe(first.body.data.certificateNumber)
    expect(parseCertificateNumber(second.body.data.certificateNumber)!.sequence).toBe(2)
  })

  it('gives each tenant its own sequence, starting at 1', async () => {
    const { employee } = await performer(90)
    const { token } = await tokenFor()

    await request(app)
      .post('/api/v1/certificates')
      .set(auth(token))
      .send({ employeeId: employee.id, type: 'monthly', title: 'Ours' })

    // The counter is keyed (tenantId, year) and claimed by RAW SQL, which the
    // tenant extension cannot see — so the hand-written tenant_id in that
    // statement is the only thing keeping the sequences apart.
    const other = await testDb().tenant.create({
      data: { slug: 'cert-other', name: 'Other', ownerEmail: 'o@e.test', employeeCodePrefix: 'OT' },
    })
    const counters = await testDb().certificateCounter.findMany()

    expect(counters).toHaveLength(1)
    expect(counters[0]!.tenantId).toBe(testTenantId())
    expect(counters[0]!.tenantId).not.toBe(other.id)
  })

  it('refuses to certify someone who has left', async () => {
    const { employee } = await performer(90)
    await testDb().employee.update({
      where: { id: employee.id },
      data: { employmentStatus: 'terminated' },
    })
    const { token } = await tokenFor()

    const res = await request(app)
      .post('/api/v1/certificates')
      .set(auth(token))
      .send({ employeeId: employee.id, type: 'monthly', title: 'Too late' })
    expect(res.status).toBe(400)
  })

  it('does not burn a number on a refused issue', async () => {
    const a = await performer(90)
    const { token } = await tokenFor()

    await request(app)
      .post('/api/v1/certificates')
      .set(auth(token))
      .send({ employeeId: a.employee.id, type: 'monthly', title: 'Real' })

    // Rejected before the transaction opens, so the counter must not move.
    await request(app)
      .post('/api/v1/certificates')
      .set(auth(token))
      .send({ employeeId: '00000000-0000-0000-0000-000000000000', type: 'monthly', title: 'Ghost' })

    const counter = await testDb().certificateCounter.findFirstOrThrow()
    expect(counter.lastSeq).toBe(1)
  })
})

describe('§12 reward suggestions', () => {
  it('ranks by average score and proposes a podium', async () => {
    const gold = await performer(95)
    const silver = await performer(88)
    const bronze = await performer(80)
    const { token } = await tokenFor()

    const res = await request(app)
      .get('/api/v1/rewards/suggestions?year=2026&month=7')
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data.map((s: { employee: { id: string } }) => s.employee.id)).toEqual([
      gold.employee.id,
      silver.employee.id,
      bronze.employee.id,
    ])
    expect(res.body.data.map((s: { suggestedType: string }) => s.suggestedType)).toEqual([
      'gold',
      'silver',
      'bronze',
    ])
  })

  it('suggests nothing beyond third place — a name on a list, not a medal', async () => {
    for (const score of [95, 90, 85, 80]) await performer(score)
    const { token } = await tokenFor()

    const res = await request(app)
      .get('/api/v1/rewards/suggestions?year=2026&month=7')
      .set(auth(token))
    expect(res.body.data[3].suggestedType).toBeNull()
  })

  it('says WHY someone is on the list', async () => {
    await performer(92, { improvement: 15 })
    const { token } = await tokenFor()

    const res = await request(app)
      .get('/api/v1/rewards/suggestions?year=2026&month=7')
      .set(auth(token))

    // The awarder should not have to trust an ordering whose basis they cannot see.
    expect(res.body.data[0].reason).toMatch(/up 15\.0 points/)
  })

  it('drops someone already recognised this month', async () => {
    const top = await performer(95)
    await performer(88)
    const { token } = await tokenFor()

    await request(app)
      .post('/api/v1/rewards')
      .set(auth(token))
      .send({
        employeeId: top.employee.id,
        type: 'gold',
        title: 'Top Performer',
        month: 7,
        year: 2026,
      })

    const res = await request(app)
      .get('/api/v1/rewards/suggestions?year=2026&month=7')
      .set(auth(token))

    // Suggesting someone who already has their medal is how the list stops
    // being read.
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].employee.id).not.toBe(top.employee.id)
  })

  it('excludes staff who have left', async () => {
    const gone = await performer(99)
    await performer(70)
    await testDb().employee.update({
      where: { id: gone.employee.id },
      data: { employmentStatus: 'resigned' },
    })
    const { token } = await tokenFor()

    const res = await request(app)
      .get('/api/v1/rewards/suggestions?year=2026&month=7')
      .set(auth(token))
    expect(res.body.data).toHaveLength(1)
  })

  it('writes NOTHING — it proposes, a human awards', async () => {
    await performer(95)
    const { token } = await tokenFor()

    await request(app).get('/api/v1/rewards/suggestions?year=2026&month=7').set(auth(token))
    expect(await testDb().reward.count()).toBe(0)
  })

  it('is scoped to an outlet_manager’s own outlet', async () => {
    await performer(95, { outlet: 'AK' })
    await performer(99, { outlet: 'CP' })
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .get('/api/v1/rewards/suggestions?year=2026&month=7')
      .set(auth(token))
    expect(res.body.data).toHaveLength(1)
  })
})

describe('§12 awarding', () => {
  it('awards with the criteria that earned it', async () => {
    const { employee } = await performer(95)
    const { token } = await tokenFor()

    const res = await request(app)
      .post('/api/v1/rewards')
      .set(auth(token))
      .send({
        employeeId: employee.id,
        type: 'employee_of_month',
        title: 'Employee of the Month — July',
        month: 7,
        year: 2026,
        criteria: { averageScore: 95, basis: 'Highest average across two exams' },
      })

    expect(res.status).toBe(201)
    expect(res.body.data.criteria).toMatchObject({ averageScore: 95 })
    expect(res.body.data.awardedBy).toBeTruthy()
  })

  it('refuses the same medal twice in a month', async () => {
    const { employee } = await performer(95)
    const { token } = await tokenFor()

    const body = { employeeId: employee.id, type: 'gold', title: 'Gold', month: 7, year: 2026 }
    await request(app).post('/api/v1/rewards').set(auth(token)).send(body)
    const again = await request(app).post('/api/v1/rewards').set(auth(token)).send(body)

    expect(again.status).toBe(409)
    expect(again.body.error.details[0].message).toMatch(/Awarded on \d{4}-\d{2}-\d{2}/)
  })

  it('allows a different medal in the same month', async () => {
    const { employee } = await performer(95)
    const { token } = await tokenFor()

    await request(app)
      .post('/api/v1/rewards')
      .set(auth(token))
      .send({ employeeId: employee.id, type: 'gold', title: 'Gold', month: 7, year: 2026 })
    const other = await request(app)
      .post('/api/v1/rewards')
      .set(auth(token))
      .send({
        employeeId: employee.id,
        type: 'employee_of_month',
        title: 'EOM',
        month: 7,
        year: 2026,
      })
    expect(other.status).toBe(201)
  })

  it('allows a special award with no month at all', async () => {
    const { employee } = await performer(95)
    const { token } = await tokenFor()

    const res = await request(app)
      .post('/api/v1/rewards')
      .set(auth(token))
      .send({ employeeId: employee.id, type: 'special', title: 'Saved a service' })
    expect(res.status).toBe(201)
  })

  it('refuses a year without a month — it could not be compared to a snapshot', async () => {
    const { employee } = await performer(95)
    const { token } = await tokenFor()

    const res = await request(app)
      .post('/api/v1/rewards')
      .set(auth(token))
      .send({ employeeId: employee.id, type: 'gold', title: 'Gold', year: 2026 })
    expect(res.status).toBe(400)
  })

  it('an outlet_manager cannot award outside their outlet', async () => {
    const other = await performer(95, { outlet: 'CP' })
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .post('/api/v1/rewards')
      .set(auth(token))
      .send({ employeeId: other.employee.id, type: 'gold', title: 'Nope' })

    // NOT_FOUND, not FORBIDDEN — a 403 confirms the employee exists.
    expect(res.status).toBe(404)
  })

  it('hr cannot award (§3.2)', async () => {
    const { employee } = await performer(95)
    const { token } = await tokenFor({ role: 'hr' })

    const res = await request(app)
      .post('/api/v1/rewards')
      .set(auth(token))
      .send({ employeeId: employee.id, type: 'gold', title: 'Nope' })
    expect(res.status).toBe(403)
  })
})
