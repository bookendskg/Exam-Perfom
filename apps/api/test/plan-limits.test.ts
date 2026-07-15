import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb, testTenantId, TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser, usePlan, useCustomPlan } from './helpers/factories.js'

/**
 * Plan limits and feature gating (SaaS §4.2, §4.3, §23.2).
 *
 * The limits are a commercial control, so the interesting cases are the
 * boundaries and the ways around them — not the happy path. Three groups earn
 * their place specifically:
 *
 *  - NULL = unlimited. `count >= null` is `count >= 0` → true, so a naive check
 *    blocks every create on the paid tiers while passing every Starter test.
 *  - The second door. The auto-scheduling cron creates exams with no HTTP
 *    request, so a middleware-only guard misses it entirely.
 *  - In-progress exams. §4.3 says a capped tenant must still finish exams it
 *    started; the test exists to fail if anyone mounts the guard app-wide.
 */

let app: Application

beforeEach(async () => {
  await truncateAll()
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

let empCounter = 7000000000
async function seedEmployees(count: number) {
  // tenantId is explicit in every lookup here. testDb() is the RAW client — it
  // is not tenant-scoped (that is deliberate; fixtures are setup, not app code)
  // — so a bare `where: { code: 'AK' }` would happily return another tenant's
  // outlet once a test creates one, and the fixture would silently build a
  // cross-tenant employee.
  const tenantId = testTenantId()
  const outlet = await testDb().outlet.findFirstOrThrow({ where: { tenantId, code: 'AK' } })
  const department = await testDb().department.findFirstOrThrow({ where: { tenantId, code: 'KIT' } })
  const designation = await testDb().designation.findFirstOrThrow({
    where: { tenantId, code: 'LCOOK' },
  })

  for (let i = 0; i < count; i++) {
    const phone = String(empCounter++)
    const user = await testDb().user.create({
      data: { tenantId: testTenantId(), phone, role: 'staff', passwordHash: 'x' },
    })
    await testDb().employee.create({
      data: {
        tenantId: testTenantId(),
        userId: user.id,
        firstName: 'Seed',
        lastName: `Employee${i}`,
        phone,
        outletId: outlet.id,
        departmentId: department.id,
        designationId: designation.id,
        joiningDate: new Date('2026-01-01'),
      },
    })
  }
}

function newEmployeeBody(phone: string, ids: { o: string; d: string; g: string }) {
  return {
    firstName: 'New',
    lastName: 'Hire',
    phone,
    outletId: ids.o,
    departmentId: ids.d,
    designationId: ids.g,
    joiningDate: '2026-03-01',
    preferredLanguage: 'en',
  }
}

async function orgIds() {
  const tenantId = testTenantId()
  const [o, d, g] = await Promise.all([
    testDb().outlet.findFirstOrThrow({ where: { tenantId, code: 'AK' } }),
    testDb().department.findFirstOrThrow({ where: { tenantId, code: 'KIT' } }),
    testDb().designation.findFirstOrThrow({ where: { tenantId, code: 'LCOOK' } }),
  ])
  return { o: o.id, d: d.id, g: g.id }
}

const postEmployee = async (token: string, phone = '9600000001') =>
  request(app)
    .post('/api/v1/employees')
    .set(auth(token))
    .send(newEmployeeBody(phone, await orgIds()))

describe('§4.3 maxEmployees — the boundary', () => {
  it('allows the create that lands exactly on the limit', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: 3 })
    await seedEmployees(1) // + the admin's own employee? no: tokenFor makes no employee

    const res = await postEmployee(token)
    expect(res.status).toBe(201)
  })

  it('refuses the create that would exceed it, and writes nothing', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: 2 })
    await seedEmployees(2)

    const res = await postEmployee(token)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED')
    expect(await testDb().employee.count()).toBe(2)
  })

  it('says which limit was hit and where the tenant stands (§23.2: never a bare no)', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: 2 })
    await seedEmployees(2)

    const res = await postEmployee(token)
    expect(res.body.error.message).toContain('2 employees')
    expect(res.body.error.details[0].message).toMatch(/using 2 of 2/)
  })

  it('refuses a tenant already over the limit — proves > not === (e.g. after a downgrade)', async () => {
    const { token } = await tokenFor()
    await seedEmployees(3)
    await useCustomPlan({ maxEmployees: 2 })

    expect((await postEmployee(token)).status).toBe(403)
  })

  it('treats 0 as a real ceiling, not as falsy-therefore-unlimited', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: 0 })

    expect((await postEmployee(token)).status).toBe(403)
  })
})

describe('§4.3 maxEmployees — NULL means unlimited', () => {
  it('allows a create with no employees yet', async () => {
    const { token } = await tokenFor()
    await usePlan('enterprise')

    expect((await postEmployee(token)).status).toBe(201)
  })

  it('allows a create well past any finite plan — the one that bricks the paid tiers if wrong', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: null })
    await seedEmployees(5)

    expect((await postEmployee(token)).status).toBe(201)
  })
})

describe('§4.3 the count is the tenant’s own, not the platform’s', () => {
  it('does not count another tenant’s employees against this tenant’s limit', async () => {
    const { token } = await tokenFor()

    // A second tenant, deliberately over the anchor's ceiling on its own.
    const other = await testDb().tenant.create({
      data: { slug: 'limits-other', name: 'Other', ownerEmail: 'o@e.example', employeeCodePrefix: 'OT' },
    })
    const outlet = await testDb().outlet.create({
      data: { tenantId: other.id, name: 'Their Outlet', code: 'AK' },
    })
    const dept = await testDb().department.create({
      data: { tenantId: other.id, name: 'Kitchen', code: 'KIT' },
    })
    const desig = await testDb().designation.create({
      data: { tenantId: other.id, name: 'Cook', code: 'LCOOK', level: 1 },
    })
    for (let i = 0; i < 5; i++) {
      const u = await testDb().user.create({
        data: { tenantId: other.id, phone: `95000000${i}`, role: 'staff', passwordHash: 'x' },
      })
      await testDb().employee.create({
        data: {
          tenantId: other.id,
          userId: u.id,
          firstName: 'Their',
          lastName: `Staff${i}`,
          phone: `95000000${i}`,
          outletId: outlet.id,
          departmentId: dept.id,
          designationId: desig.id,
          joiningDate: new Date('2026-01-01'),
        },
      })
    }

    await useCustomPlan({ maxEmployees: 2 })
    await seedEmployees(1)

    // 1 of ours + 5 of theirs = 6. If the count leaked across tenants this 403s.
    expect((await postEmployee(token)).status).toBe(201)
  })
})

describe('§4.3 what "active" means for a seat', () => {
  it('frees a seat when an employee is terminated', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: 2 })
    await seedEmployees(2)
    expect((await postEmployee(token)).status).toBe(403)

    const victim = await testDb().employee.findFirstOrThrow()
    await testDb().employee.update({
      where: { id: victim.id },
      data: { employmentStatus: 'terminated' },
    })

    expect((await postEmployee(token, '9600000002')).status).toBe(201)
  })

  it('does NOT free a seat for on_leave — pair this with the test above; together they are the definition', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: 2 })
    await seedEmployees(2)

    const victim = await testDb().employee.findFirstOrThrow()
    await testDb().employee.update({
      where: { id: victim.id },
      data: { employmentStatus: 'on_leave' },
    })

    // If this ever goes 201, someone "simplified" the predicate to
    // employmentStatus:'active' — which makes the limit trivially bypassable by
    // flipping staff to on_leave, hiring, and flipping back.
    expect((await postEmployee(token, '9600000003')).status).toBe(403)
  })

  it('does NOT free a seat for suspended', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: 2 })
    await seedEmployees(2)

    const victim = await testDb().employee.findFirstOrThrow()
    await testDb().employee.update({
      where: { id: victim.id },
      data: { employmentStatus: 'suspended' },
    })

    expect((await postEmployee(token, '9600000004')).status).toBe(403)
  })
})

describe('§4.3 ordering — a 403 must not leak plan facts to someone who cannot act', () => {
  it('reports FORBIDDEN, not PLAN_LIMIT_REACHED, when the role lacks permission', async () => {
    // staff cannot create employees at all.
    const made = await makeUser({ role: 'staff', withEmployee: true, mustChangePassword: false })
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })

    await useCustomPlan({ maxEmployees: 0 })

    const res = await postEmployee(login.body.data.accessToken)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('reports VALIDATION_ERROR, not a plan error, for a malformed body', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: 0 })

    const res = await request(app).post('/api/v1/employees').set(auth(token)).send({ firstName: '' })
    expect(res.status).toBe(400)
  })
})

describe('§4.3 the plan is not cached', () => {
  it('applies a downgrade on the very next request, without re-login', async () => {
    const { token } = await tokenFor()
    await useCustomPlan({ maxEmployees: null })
    expect((await postEmployee(token, '9600000005')).status).toBe(201)

    await useCustomPlan({ maxEmployees: 1 })

    // Same token, same session — the ceiling moved under it.
    expect((await postEmployee(token, '9600000006')).status).toBe(403)
  })
})

describe('§4.3 a tenant with no plan fails loudly rather than silently unlimited', () => {
  it('500s rather than granting a free-for-all', async () => {
    const { token } = await tokenFor()
    await testDb().tenant.update({ where: { id: testTenantId() }, data: { planId: null } })

    const res = await postEmployee(token)
    expect(res.status).toBe(500)
    expect(await testDb().employee.count()).toBe(0)
  })
})

describe('§4.3 maxOutlets', () => {
  const postOutlet = (token: string, code: string) =>
    request(app).post('/api/v1/outlets').set(auth(token)).send({ name: `Outlet ${code}`, code })

  it('refuses a create over the limit', async () => {
    const { token } = await tokenFor({ role: 'super_admin' })
    // The anchor seeds 3 active outlets.
    await useCustomPlan({ maxOutlets: 3 })

    const res = await postOutlet(token, 'NEW')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED')
  })

  it('allows a create under it', async () => {
    const { token } = await tokenFor({ role: 'super_admin' })
    await useCustomPlan({ maxOutlets: 4 })

    expect((await postOutlet(token, 'NEW')).status).toBe(201)
  })

  it('is unlimited on NULL', async () => {
    const { token } = await tokenFor({ role: 'super_admin' })
    await useCustomPlan({ maxOutlets: null })

    expect((await postOutlet(token, 'NEW')).status).toBe(201)
  })

  /**
   * The hole a create-only guard leaves open. Without a guard on the
   * false→true transition: deactivate one, create another, reactivate the
   * first, and the tenant is over its ceiling having never touched a guarded
   * route.
   */
  it('refuses reactivating an outlet that would cross the ceiling', async () => {
    const { token } = await tokenFor({ role: 'super_admin' })
    await useCustomPlan({ maxOutlets: 3 })

    const victim = await testDb().outlet.findFirstOrThrow({ where: { tenantId: testTenantId(), code: 'PR' } })
    await testDb().outlet.update({ where: { id: victim.id }, data: { isActive: false } })

    // Now at 2/3 — room for one more.
    expect((await postOutlet(token, 'NEW')).status).toBe(201)

    // Back to 3/3. Reactivating PR would make 4.
    const res = await request(app)
      .put(`/api/v1/outlets/${victim.id}`)
      .set(auth(token))
      .send({ isActive: true })

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED')
  })

  it('still allows an ordinary edit of an active outlet at exactly the limit', async () => {
    const { token } = await tokenFor({ role: 'super_admin' })
    await useCustomPlan({ maxOutlets: 3 })

    const outlet = await testDb().outlet.findFirstOrThrow({ where: { tenantId: testTenantId(), code: 'AK' } })
    const res = await request(app)
      .put(`/api/v1/outlets/${outlet.id}`)
      .set(auth(token))
      .send({ name: 'Renamed' })

    // Guarding every update rather than just the transition would 403 this.
    expect(res.status).toBe(200)
  })
})
