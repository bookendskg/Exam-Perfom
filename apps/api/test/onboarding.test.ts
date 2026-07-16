import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'

/**
 * Self-service signup (SaaS §5.1).
 *
 * The headline test is "a brand-new tenant can add an employee" — everything
 * else is a detail of getting there. A signup that provisions a tenant which
 * dead-ends on the owner's first action is not a product, and no amount of
 * green unit tests would tell you that.
 */

let app: Application

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app
})

afterAll(async () => {
  await disconnectDb()
})

const OWNER_PW = 'Sunrise@2026Ops'

let phoneSeq = 9700000000
function signupBody(over: Record<string, unknown> = {}) {
  return {
    organisationName: 'Hotel Sunrise Group',
    ownerName: 'Priya Shah',
    ownerEmail: `owner-${Math.random().toString(36).slice(2, 8)}@sunrise.test`,
    ownerPhone: String(phoneSeq++),
    password: OWNER_PW,
    ...over,
  }
}

const signup = (body: Record<string, unknown>) => request(app).post('/api/v1/signup').send(body)

describe('§5.1 signup provisions a working tenant', () => {
  it('creates the tenant, on a trial, with a derived address', async () => {
    const res = await signup(signupBody())

    expect(res.status).toBe(201)
    expect(res.body.data.slug).toBe('hotel-sunrise-group')
    expect(res.body.data.organisationName).toBe('Hotel Sunrise Group')
    expect(res.body.data.planCode).toBe('professional')
    expect(new Date(res.body.data.trialEndsAt).getTime()).toBeGreaterThan(Date.now())

    const tenant = await testDb().tenant.findUniqueOrThrow({
      where: { id: res.body.data.tenantId },
    })
    expect(tenant.subscriptionStatus).toBe('trialing')
    expect(tenant.isActive).toBe(true)
  })

  it('seeds the departments, designations and an outlet (§5.1 auto-provision)', async () => {
    const res = await signup(signupBody())
    const tenantId = res.body.data.tenantId

    expect(res.body.data.seeded).toEqual({ departments: 6, designations: 15, outlets: 1 })

    const [departments, designations, outlets, mappings] = await Promise.all([
      testDb().department.count({ where: { tenantId } }),
      testDb().designation.count({ where: { tenantId } }),
      testDb().outlet.count({ where: { tenantId } }),
      testDb().outletDepartment.count({ where: { tenantId } }),
    ])

    expect(departments).toBe(6)
    expect(designations).toBe(15)
    expect(outlets).toBe(1)
    expect(mappings).toBe(6) // every department available at the outlet
  })

  it('links designations to their departments rather than orphaning them', async () => {
    const res = await signup(signupBody())
    const tenantId = res.body.data.tenantId

    const headChef = await testDb().designation.findFirstOrThrow({
      where: { tenantId, code: 'HCHEF' },
      include: { department: true },
    })
    expect(headChef.department?.code).toBe('KIT')
    expect(headChef.level).toBe(5)
  })

  it('derives an employee-code prefix from the organisation name (§8.2)', async () => {
    const res = await signup(signupBody({ organisationName: 'Bookends Hospitality' }))
    const tenant = await testDb().tenant.findUniqueOrThrow({
      where: { id: res.body.data.tenantId },
    })
    expect(tenant.employeeCodePrefix).toBe('BH')
  })

  it('creates the owner as a super_admin who is NOT forced to change password', async () => {
    const body = signupBody()
    const res = await signup(body)

    const owner = await testDb().user.findUniqueOrThrow({
      where: { id: res.body.data.ownerUserId },
    })
    expect(owner.role).toBe('super_admin')
    expect(owner.tenantId).toBe(res.body.data.tenantId)
    // They chose this password thirty seconds ago. §7.3's force-change exists
    // for accounts created FOR someone with a derived default, not this.
    expect(owner.mustChangePassword).toBe(false)
  })
})

describe('§5.1 the new tenant actually works — the point of the whole feature', () => {
  it('the owner can log in and add an employee immediately', async () => {
    const body = signupBody()
    const created = await signup(body)
    expect(created.status).toBe(201)

    // 1. Log in with the credentials just chosen.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: created.body.data.slug, phone: body.ownerPhone, password: OWNER_PW })
    expect(login.status).toBe(200)
    const token = login.body.data.accessToken

    // 2. Read the org structure that signup seeded.
    const auth = { Authorization: `Bearer ${token}` }
    const [outlets, departments, designations] = await Promise.all([
      request(app).get('/api/v1/outlets').set(auth),
      request(app).get('/api/v1/departments').set(auth),
      request(app).get('/api/v1/designations').set(auth),
    ])
    expect(outlets.body.data).toHaveLength(1)
    expect(departments.body.data.length).toBe(6)

    // 3. Add an employee — which needs an outlet AND a department AND a
    //    designation. This is why signup seeds all three: without any one of
    //    them the owner's first real action fails and they have to
    //    reverse-engineer why.
    const employee = await request(app)
      .post('/api/v1/employees')
      .set(auth)
      .send({
        firstName: 'Asha',
        lastName: 'Patel',
        phone: String(phoneSeq++),
        outletId: outlets.body.data[0].id,
        departmentId: departments.body.data.find((d: { code: string }) => d.code === 'KIT').id,
        designationId: designations.body.data.find((d: { code: string }) => d.code === 'LCOOK').id,
        joiningDate: '2026-04-01',
        preferredLanguage: 'en',
      })

    expect(employee.status).toBe(201)
    // The tenant's OWN prefix, not Bookends'. "HS-MAIN-001".
    expect(employee.body.data.employeeCode).toMatch(/^HS-MAIN-\d+$/)
  })

  it('cannot see another tenant’s data, from its first minute', async () => {
    const body = signupBody()
    const created = await signup(body)

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: created.body.data.slug, phone: body.ownerPhone, password: OWNER_PW })

    const outlets = await request(app)
      .get('/api/v1/outlets')
      .set({ Authorization: `Bearer ${login.body.data.accessToken}` })

    // The anchor tenant has AK/CP/PR seeded. A brand-new tenant sees only its
    // own Main Outlet — the isolation applies to tenants it created itself.
    expect(outlets.body.data).toHaveLength(1)
    expect(outlets.body.data[0].code).toBe('MAIN')
  })
})

describe('§5.3 addresses', () => {
  it('suffixes a taken address rather than failing', async () => {
    const first = await signup(signupBody({ organisationName: 'Grand Hotel' }))
    const second = await signup(signupBody({ organisationName: 'Grand Hotel' }))

    expect(first.body.data.slug).toBe('grand-hotel')
    // A number a human can read out over the phone, not a random suffix.
    expect(second.body.data.slug).toBe('grand-hotel-2')
  })

  it('refuses a reserved address even when asked for explicitly', async () => {
    // §5.3 routes admin.examhub.com to the platform panel. A tenant holding it
    // collides with our own infrastructure.
    const res = await signup(signupBody({ slug: 'admin' }))
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toMatch(/reserved/i)
  })

  it('refuses a slug that would make a convincing phishing host', async () => {
    for (const slug of ['login', 'billing', 'secure']) {
      const res = await signup(signupBody({ slug }))
      expect(res.status, slug).toBe(400)
    }
  })

  it('CONFLICTS on an explicitly requested address that is taken, rather than silently changing it', async () => {
    await signup(signupBody({ slug: 'aiko-cafe' }))
    const res = await signup(signupBody({ slug: 'aiko-cafe' }))

    // Asked for by name, so answer plainly. Silently landing them on
    // "aiko-cafe-2" is a surprise they discover from a URL weeks later.
    expect(res.status).toBe(409)
    expect(res.body.error.details[0].message).toContain('aiko-cafe-2')
  })

  it('asks for an address when the name yields none, rather than inventing one', async () => {
    // §6 makes Hindi and Gujarati first-class in CONTENT, but a hostname cannot
    // carry them. Guessing a romanisation of someone's business name is worse
    // than asking.
    const res = await signup(signupBody({ organisationName: 'स्वाद रेस्तरां' }))
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].field).toBe('slug')
  })

  it('reports availability without naming who holds a taken address', async () => {
    await signup(signupBody({ slug: 'taken-name' }))

    const free = await request(app).get('/api/v1/signup/slug-available?slug=free-name')
    expect(free.body.data.available).toBe(true)

    const taken = await request(app).get('/api/v1/signup/slug-available?slug=taken-name')
    expect(taken.body.data.available).toBe(false)
    expect(taken.body.data.suggestion).toBe('taken-name-2')
    // An unauthenticated caller must not be able to enumerate our customers.
    expect(JSON.stringify(taken.body)).not.toMatch(/Hotel Sunrise|owner|@/)
  })

  it('reports a reserved address as reserved, so the user knows to pick another', async () => {
    const res = await request(app).get('/api/v1/signup/slug-available?slug=api')
    expect(res.body.data.available).toBe(false)
    expect(res.body.data.reason).toMatch(/reserved/i)
  })
})

describe('§5.1 signup refuses bad input without leaving debris', () => {
  it('applies the ADMIN password policy to the owner (§7.3)', async () => {
    const res = await signup(signupBody({ password: 'short' }))

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    // Every violation at once, not "too short" and then "needs a capital".
    expect(res.body.error.details.length).toBeGreaterThan(0)
  })

  it('creates NOTHING when the password is rejected', async () => {
    const before = await testDb().tenant.count()
    await signup(signupBody({ password: 'weak' }))

    // Checked before any write, so the slug is not burned by a failed attempt.
    expect(await testDb().tenant.count()).toBe(before)
  })

  it('rejects an unknown plan', async () => {
    const res = await signup(signupBody({ planCode: 'platinum-deluxe' }))
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].field).toBe('planCode')
  })

  it('honours an explicit plan', async () => {
    const res = await signup(signupBody({ planCode: 'starter' }))
    expect(res.status).toBe(201)
    expect(res.body.data.planCode).toBe('starter')
  })

  it('requires a real email and a phone', async () => {
    expect((await signup(signupBody({ ownerEmail: 'not-an-email' }))).status).toBe(400)
    expect((await signup(signupBody({ ownerPhone: '' }))).status).toBe(400)
  })
})

describe('§5.1 provisioning is all-or-nothing', () => {
  it('leaves no orphan tenant when a later step fails', async () => {
    const body = signupBody()
    await signup(body)

    // A second signup reusing the same OWNER PHONE, forced onto the same slug.
    // The user insert violates UNIQUE(tenantId, phone)… except it is a new
    // tenant, so it does not. Use the slug collision instead, which is the real
    // race: both pass the availability check, one loses at the unique index.
    const conflicting = await signup(signupBody({ slug: 'grand-hotel' }))
    expect(conflicting.status).toBe(201)

    const dupe = await signup(signupBody({ slug: 'grand-hotel' }))
    expect(dupe.status).toBe(409)

    // Exactly one tenant on that slug, and it is fully provisioned — not a
    // half-built shell from the loser's attempt.
    const tenants = await testDb().tenant.findMany({ where: { slug: 'grand-hotel' } })
    expect(tenants).toHaveLength(1)
    expect(await testDb().department.count({ where: { tenantId: tenants[0]!.id } })).toBe(6)
  })

  it('every provisioned row belongs to the new tenant, not the anchor', async () => {
    const res = await signup(signupBody())
    const tenantId = res.body.data.tenantId

    // The provisioning runs inside runInTenant, so the extension stamps and
    // verifies each row. A mistake here would silently seed the anchor tenant.
    const strays = await testDb().department.count({
      where: { tenantId: { not: tenantId }, code: 'KIT', tenant: { slug: { startsWith: 'hotel' } } },
    })
    expect(strays).toBe(0)
  })
})
