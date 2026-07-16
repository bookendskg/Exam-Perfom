import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { hashPassword } from '@bookends/core'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb, testTenantId, TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'

/**
 * Platform admin API (§10), and the boundary between platform and tenant.
 *
 * The token-crossing tests are the point of this file. A platform token reads
 * and suspends every customer; a tenant token must never become one. That is
 * enforced cryptographically (separate PLATFORM_JWT_SECRET) rather than by a
 * claim check, so these tests are asserting that the secrets really are
 * different — the thing that makes a middleware mistake unexploitable.
 */

let app: Application

beforeEach(async () => {
  await truncateAll()
  await testDb().platformAuditLog.deleteMany()
  await testDb().platformAdmin.deleteMany()
  app = buildTestApp().app
})

afterAll(async () => {
  await disconnectDb()
})

const PW = 'PlatformOps@2026'

async function makePlatformAdmin(role: 'super_admin' | 'support' | 'finance' = 'super_admin') {
  const email = `ops-${Math.random().toString(36).slice(2, 8)}@examhub.test`
  const admin = await testDb().platformAdmin.create({
    data: { email, name: 'Ops Person', role, passwordHash: await hashPassword(PW) },
  })
  return { admin, email }
}

async function platformToken(role: 'super_admin' | 'support' | 'finance' = 'super_admin') {
  const { admin, email } = await makePlatformAdmin(role)
  const res = await request(app).post('/api/platform/v1/auth/login').send({ email, password: PW })
  expect(res.status).toBe(200)
  return { token: res.body.data.accessToken as string, admin }
}

async function tenantToken() {
  const made = await makeUser({ role: 'super_admin', mustChangePassword: false })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
  expect(res.status).toBe(200)
  return res.body.data.accessToken as string
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('§10 platform login', () => {
  it('issues a token to a real operator', async () => {
    const { email } = await makePlatformAdmin()
    const res = await request(app).post('/api/platform/v1/auth/login').send({ email, password: PW })

    expect(res.status).toBe(200)
    expect(res.body.data.accessToken).toBeTruthy()
    expect(res.body.data.admin.role).toBe('super_admin')
  })

  it('is case-insensitive on email, because operators type it by hand', async () => {
    const { email } = await makePlatformAdmin()
    const res = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: email.toUpperCase(), password: PW })
    expect(res.status).toBe(200)
  })

  it('answers identically for an unknown email and a wrong password', async () => {
    const { email } = await makePlatformAdmin()
    const wrongPw = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email, password: 'not-it' })
    const unknown = await request(app)
      .post('/api/platform/v1/auth/login')
      .send({ email: 'nobody@examhub.test', password: PW })

    // Same reasoning as tenant login: the response must not tell an attacker
    // which of our operators' emails are real.
    expect(wrongPw.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual(wrongPw.body)
  })

  it('refuses a deactivated operator, indistinguishably', async () => {
    const { admin, email } = await makePlatformAdmin()
    await testDb().platformAdmin.update({ where: { id: admin.id }, data: { isActive: false } })

    const res = await request(app).post('/api/platform/v1/auth/login').send({ email, password: PW })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('records the login', async () => {
    const { admin } = await platformToken()
    const row = await testDb().platformAdmin.findUniqueOrThrow({ where: { id: admin.id } })
    expect(row.lastLoginAt).not.toBeNull()
  })
})

describe('§10 the platform/tenant boundary — the reason the secrets differ', () => {
  it('refuses a TENANT token at a platform route', async () => {
    const token = await tenantToken()

    // Signed with JWT_SECRET; this route verifies against PLATFORM_JWT_SECRET.
    // It does not fail a claim check — the signature does not verify at all.
    // If this ever passes, the two secrets have been made equal and a
    // customer's admin can suspend other customers.
    const res = await request(app).get('/api/platform/v1/tenants').set(auth(token))
    expect(res.status).toBe(401)
  })

  it('refuses a PLATFORM token at a tenant route', async () => {
    const { token } = await platformToken()

    // The inverse, and equally necessary: a platform token must not be a
    // skeleton key into a tenant's own data through the ordinary API.
    const res = await request(app).get('/api/v1/employees').set(auth(token))
    expect(res.status).toBe(401)
  })

  it('refuses an unsigned or garbage token', async () => {
    expect((await request(app).get('/api/platform/v1/tenants').set(auth('garbage'))).status).toBe(
      401
    )
    expect((await request(app).get('/api/platform/v1/tenants')).status).toBe(401)
  })

  it('refuses an operator deactivated after their token was issued', async () => {
    const { token, admin } = await platformToken()
    expect((await request(app).get('/api/platform/v1/me').set(auth(token))).status).toBe(200)

    await testDb().platformAdmin.update({ where: { id: admin.id }, data: { isActive: false } })

    // The token is still signed and unexpired. The account is not — which is
    // why the middleware re-reads it rather than trusting the claims.
    const res = await request(app).get('/api/platform/v1/me').set(auth(token))
    expect(res.status).toBe(401)
  })
})

describe('§10.2 tenant management', () => {
  it('lists every tenant, across all of them', async () => {
    await testDb().tenant.create({
      data: { slug: 'other-co', name: 'Other Co', ownerEmail: 'o@e.test', employeeCodePrefix: 'OC' },
    })
    const { token } = await platformToken()

    const res = await request(app).get('/api/platform/v1/tenants').set(auth(token))
    expect(res.status).toBe(200)
    // The anchor plus the one just made. A tenant-scoped query would see one.
    expect(res.body.meta.total).toBeGreaterThanOrEqual(2)
    expect(res.body.data.map((t: { slug: string }) => t.slug)).toContain('other-co')
  })

  it('reports live usage against the plan, not a stale rollup', async () => {
    const { token } = await platformToken()
    const res = await request(app)
      .get(`/api/platform/v1/tenants/${testTenantId()}`)
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data.usage.outlets.used).toBe(3) // the seeded AK/CP/PR
    expect(res.body.data.usage.employees.limit).toBe(300) // professional
  })

  it('404s a tenant that does not exist', async () => {
    const { token } = await platformToken()
    const res = await request(app)
      .get('/api/platform/v1/tenants/00000000-0000-0000-0000-000000000000')
      .set(auth(token))
    expect(res.status).toBe(404)
  })
})

describe('§10.2 suspend and activate', () => {
  it('suspends a tenant and records who, why, and what changed', async () => {
    const { token, admin } = await platformToken()

    const res = await request(app)
      .post(`/api/platform/v1/tenants/${testTenantId()}/suspend`)
      .set(auth(token))
      .send({ reason: 'Non-payment: invoice 4021 overdue 45 days' })

    expect(res.status).toBe(200)
    expect(res.body.data.isActive).toBe(false)
    expect(res.body.data.subscriptionStatus).toBe('suspended')

    const log = await testDb().platformAuditLog.findFirstOrThrow({
      where: { action: 'tenant.suspend' },
    })
    expect(log.adminId).toBe(admin.id)
    expect(log.targetTenantId).toBe(testTenantId())
    // The before-state is why this is logged in the service and not in
    // middleware: only the service knows what it changed FROM.
    expect(log.details).toMatchObject({
      reason: 'Non-payment: invoice 4021 overdue 45 days',
      from: { isActive: true },
      to: { isActive: false },
    })
  })

  it('requires a reason — an unexplained suspension is an unanswerable ticket', async () => {
    const { token } = await platformToken()
    const res = await request(app)
      .post(`/api/platform/v1/tenants/${testTenantId()}/suspend`)
      .set(auth(token))
      .send({})
    expect(res.status).toBe(400)
  })

  it('STOPS THE TENANT LOGGING IN — the suspension has to actually bite', async () => {
    const made = await makeUser({ role: 'admin', mustChangePassword: false })
    const { token } = await platformToken()

    // Works before.
    const before = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
    expect(before.status).toBe(200)

    await request(app)
      .post(`/api/platform/v1/tenants/${testTenantId()}/suspend`)
      .set(auth(token))
      .send({ reason: 'Testing that suspension is real' })

    // And not after. tenant.resolver.ts treats an inactive tenant as absent, so
    // this is TENANT_NOT_FOUND rather than a message confirming they exist.
    const after = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
    expect(after.status).toBe(404)
    expect(after.body.error.code).toBe('TENANT_NOT_FOUND')
  })

  it('activate restores access and clears the suspension record', async () => {
    const made = await makeUser({ role: 'admin', mustChangePassword: false })
    const { token } = await platformToken()

    await request(app)
      .post(`/api/platform/v1/tenants/${testTenantId()}/suspend`)
      .set(auth(token))
      .send({ reason: 'Temporary' })
    await request(app)
      .post(`/api/platform/v1/tenants/${testTenantId()}/activate`)
      .set(auth(token))

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
    expect(login.status).toBe(200)

    const tenant = await testDb().tenant.findUniqueOrThrow({ where: { id: testTenantId() } })
    expect(tenant.suspendedAt).toBeNull()
    expect(tenant.suspendedReason).toBeNull()
  })
})

describe('§10.2 plan changes', () => {
  it('changes the plan and audits the before and after', async () => {
    const { token } = await platformToken()

    const res = await request(app)
      .put(`/api/platform/v1/tenants/${testTenantId()}/plan`)
      .set(auth(token))
      .send({ planCode: 'starter' })

    expect(res.status).toBe(200)
    expect(res.body.data.plan.code).toBe('starter')

    const log = await testDb().platformAuditLog.findFirstOrThrow({
      where: { action: 'tenant.plan_change' },
    })
    expect(log.details).toMatchObject({ from: 'professional', to: 'starter' })
  })

  it('rejects an unknown plan rather than nulling the tenant’s plan', async () => {
    const { token } = await platformToken()
    const res = await request(app)
      .put(`/api/platform/v1/tenants/${testTenantId()}/plan`)
      .set(auth(token))
      .send({ planCode: 'platinum-deluxe' })

    expect(res.status).toBe(400)
    const tenant = await testDb().tenant.findUniqueOrThrow({
      where: { id: testTenantId() },
      include: { plan: true },
    })
    expect(tenant.plan?.code).toBe('professional')
  })

  it('allows a downgrade that leaves the tenant OVER the new limit (§24.1)', async () => {
    const { token } = await platformToken()

    // The anchor has 3 outlets; starter allows 1. The downgrade must succeed —
    // existing data is kept and planGuard blocks new creations until they are
    // back under. Refusing would trap a customer on a tier they want to leave.
    const res = await request(app)
      .put(`/api/platform/v1/tenants/${testTenantId()}/plan`)
      .set(auth(token))
      .send({ planCode: 'starter' })

    expect(res.status).toBe(200)
    expect(await testDb().outlet.count({ where: { tenantId: testTenantId(), isActive: true } })).toBe(3)
  })
})

describe('§6.1 platform roles', () => {
  it('lets support read', async () => {
    const { token } = await platformToken('support')
    expect((await request(app).get('/api/platform/v1/tenants').set(auth(token))).status).toBe(200)
  })

  it('does NOT let support suspend a customer', async () => {
    const { token } = await platformToken('support')

    // Support exists to answer tickets. An operator who can accidentally
    // suspend a paying customer while investigating their problem is a worse
    // tool than one who has to ask.
    const res = await request(app)
      .post(`/api/platform/v1/tenants/${testTenantId()}/suspend`)
      .set(auth(token))
      .send({ reason: 'should not work' })

    expect(res.status).toBe(403)
    const tenant = await testDb().tenant.findUniqueOrThrow({ where: { id: testTenantId() } })
    expect(tenant.isActive).toBe(true)
  })

  it('does not let finance change plans either', async () => {
    const { token } = await platformToken('finance')
    const res = await request(app)
      .put(`/api/platform/v1/tenants/${testTenantId()}/plan`)
      .set(auth(token))
      .send({ planCode: 'starter' })
    expect(res.status).toBe(403)
  })
})

describe('§20.2 the audit trail', () => {
  it('survives the operator being deleted — the record outlives the person', async () => {
    const { token, admin } = await platformToken()
    await request(app)
      .post(`/api/platform/v1/tenants/${testTenantId()}/suspend`)
      .set(auth(token))
      .send({ reason: 'Will outlive its author' })

    await testDb().platformAdmin.delete({ where: { id: admin.id } })

    // ON DELETE SET NULL, not cascade: removing an operator must not erase what
    // they did to a customer.
    const log = await testDb().platformAuditLog.findFirstOrThrow({
      where: { action: 'tenant.suspend' },
    })
    expect(log.adminId).toBeNull()
    expect(log.details).toMatchObject({ reason: 'Will outlive its author' })
  })

  it('is readable through the API, filtered by tenant', async () => {
    const { token } = await platformToken()
    await request(app)
      .post(`/api/platform/v1/tenants/${testTenantId()}/suspend`)
      .set(auth(token))
      .send({ reason: 'For the log' })

    const res = await request(app)
      .get(`/api/platform/v1/audit-logs?tenantId=${testTenantId()}`)
      .set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data[0].action).toBe('tenant.suspend')
    expect(res.body.data[0].admin.email).toContain('@examhub.test')
  })

  it('is not reachable by a tenant, ever', async () => {
    const token = await tenantToken()
    expect((await request(app).get('/api/platform/v1/audit-logs').set(auth(token))).status).toBe(401)
  })
})
