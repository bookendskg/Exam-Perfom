import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb , TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'

/**
 * End-to-end RBAC scope enforcement (§3.2).
 *
 * This closes the gap left open by Module 1: scope.ts was written but had
 * nothing to scope against until employees existed. Every assertion here is
 * against the real route stack, not the evaluator in isolation.
 */

let app: Application
let org: { aiko: string; capiche: string; kitchen: string; lineCook: string }

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app

  const db = testDb()
  const [aiko, capiche, kitchen, lineCook] = await Promise.all([
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'CP' } }),
    db.department.findFirstOrThrow({ where: { code: 'KIT' } }),
    db.designation.findFirstOrThrow({ where: { code: 'LCOOK' } }),
  ])
  org = { aiko: aiko.id, capiche: capiche.id, kitchen: kitchen.id, lineCook: lineCook.id }
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

const employeeAt = (outletId: string, over: Record<string, unknown> = {}) => ({
  firstName: 'Test',
  lastName: 'Employee',
  phone: `97${Math.floor(Math.random() * 100_000_000)}`.slice(0, 10),
  outletId,
  departmentId: org.kitchen,
  designationId: org.lineCook,
  joiningDate: '2026-02-01',
  preferredLanguage: 'en',
  ...over,
})

/** Creates an employee at an outlet using an admin (scope: all). */
async function seedEmployee(outletId: string) {
  const { token } = await tokenFor({ role: 'admin' })
  const res = await request(app)
    .post('/api/v1/employees')
    .set('Authorization', `Bearer ${token}`)
    .send(employeeAt(outletId))
  expect(res.status).toBe(201)
  return res.body.data
}

describe('scope: outlet_manager is confined to their own outlet', () => {
  it('lists only their outlet’s employees', async () => {
    const atAiko = await seedEmployee(org.aiko)
    const atCapiche = await seedEmployee(org.capiche)

    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((e: { id: string }) => e.id)
    expect(ids).toContain(atAiko.id)
    expect(ids).not.toContain(atCapiche.id)
  })

  it('reports meta.total for only the rows it can see', async () => {
    await seedEmployee(org.aiko)
    await seedEmployee(org.capiche)
    await seedEmployee(org.capiche)

    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const res = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${token}`)

    // Scope is part of the WHERE, not a post-filter. A post-filter would
    // paginate over invisible rows and report total = 3.
    expect(res.body.meta.total).toBe(1)
  })

  it('returns 404 — not 403 — for another outlet’s employee', async () => {
    const atCapiche = await seedEmployee(org.capiche)
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .get(`/api/v1/employees/${atCapiche.id}`)
      .set('Authorization', `Bearer ${token}`)

    // 403 would confirm the record exists, which leaks Capiche's roster to
    // anyone willing to enumerate ids.
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('cannot update another outlet’s employee', async () => {
    const atCapiche = await seedEmployee(org.capiche)
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .put(`/api/v1/employees/${atCapiche.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Hijacked' })

    expect(res.status).toBe(404)
    const row = await testDb().employee.findUniqueOrThrow({ where: { id: atCapiche.id } })
    expect(row.firstName).not.toBe('Hijacked')
  })

  it('cannot terminate another outlet’s employee', async () => {
    const atCapiche = await seedEmployee(org.capiche)
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    await request(app)
      .delete(`/api/v1/employees/${atCapiche.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404)

    const row = await testDb().employee.findUniqueOrThrow({ where: { id: atCapiche.id } })
    expect(row.employmentStatus).toBe('active')
  })

  it('CAN manage their own outlet’s employee', async () => {
    const atAiko = await seedEmployee(org.aiko)
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const auth = { Authorization: `Bearer ${token}` }

    await request(app).get(`/api/v1/employees/${atAiko.id}`).set(auth).expect(200)
    await request(app)
      .put(`/api/v1/employees/${atAiko.id}`)
      .set(auth)
      .send({ firstName: 'Updated' })
      .expect(200)
  })

  it('cannot CREATE an employee into an outlet it does not manage', async () => {
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    // The create path that neither the list filter nor the fetch-and-check
    // covers — there is no stored row yet. Without assertCreateInScope this
    // silently succeeds.
    const res = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(employeeAt(org.capiche))

    expect(res.status).toBe(403)
    expect(await testDb().employee.count({ where: { outletId: org.capiche } })).toBe(0)
  })

  it('CAN create into its own outlet', async () => {
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(employeeAt(org.aiko))
      .expect(201)
  })

  it('scopes to ALL outlets it manages, not just one', async () => {
    // The schema models one manager → many outlets, so scope is a list.
    const atAiko = await seedEmployee(org.aiko)
    const atCapiche = await seedEmployee(org.capiche)

    const { token } = await tokenFor({
      role: 'outlet_manager',
      managesOutletCodes: ['AK', 'CP'],
    })
    const res = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${token}`)

    const ids = res.body.data.map((e: { id: string }) => e.id)
    expect(ids).toContain(atAiko.id)
    expect(ids).toContain(atCapiche.id)
  })

  it('is refused outright when it manages no outlet at all', async () => {
    await seedEmployee(org.aiko)
    // Scope is ∅: every scoped query returns nothing, which reads as a broken
    // account. Say so plainly instead of serving an empty list.
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: [] })

    const res = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(res.body.error.message).toContain('not assigned to manage any outlet')
  })

  it('loses access the moment its outlet assignment is removed', async () => {
    // Runs against the Postgres store deliberately: the memory store caches the
    // Principal and cannot observe a scope change, so it would pass this test
    // vacuously while production behaved differently. Postgres is what runs in
    // production and is the stricter of the two.
    app = buildTestApp({ SESSION_STORE: 'postgres' }).app

    const atAiko = await seedEmployee(org.aiko)
    const { token, user } = await tokenFor({
      role: 'outlet_manager',
      managesOutletCodes: ['AK'],
    })
    const auth = { Authorization: `Bearer ${token}` }

    await request(app).get(`/api/v1/employees/${atAiko.id}`).set(auth).expect(200)

    // Scope rides on the session rather than the JWT precisely so this takes
    // effect now, not when a 15-minute access token happens to expire.
    await testDb().outlet.updateMany({ where: { managerId: user.id }, data: { managerId: null } })

    const after = await request(app).get(`/api/v1/employees/${atAiko.id}`).set(auth)
    expect(after.status).toBe(403)
  })
})

describe('scope: staff see only their own record', () => {
  it('a staff member cannot list employees at all', async () => {
    await seedEmployee(org.aiko)
    const { token } = await tokenFor({ role: 'staff', withEmployee: true })

    // §3.2 gives staff employee:read = own_resource, so the list is scoped to
    // themselves rather than denied.
    const res = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
  })

  it('a staff member sees only themselves in the list', async () => {
    const other = await seedEmployee(org.aiko)
    const { token, user } = await tokenFor({ role: 'staff', withEmployee: true })

    const res = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${token}`)
    const ids = res.body.data.map((e: { id: string }) => e.id)
    expect(ids).not.toContain(other.id)

    const mine = await testDb().employee.findFirstOrThrow({ where: { userId: user.id } })
    expect(ids).toEqual([mine.id])
  })

  it('a staff member gets 404 for someone else’s record', async () => {
    const other = await seedEmployee(org.aiko)
    const { token } = await tokenFor({ role: 'staff', withEmployee: true })

    const res = await request(app)
      .get(`/api/v1/employees/${other.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('a staff member cannot create employees (§3.2)', async () => {
    const { token } = await tokenFor({ role: 'staff', withEmployee: true })
    const res = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(employeeAt(org.aiko))

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('a staff member cannot update or delete anyone, including themselves', async () => {
    const { token, user } = await tokenFor({ role: 'staff', withEmployee: true })
    const mine = await testDb().employee.findFirstOrThrow({ where: { userId: user.id } })
    const auth = { Authorization: `Bearer ${token}` }

    await request(app).put(`/api/v1/employees/${mine.id}`).set(auth).send({ city: 'X' }).expect(403)
    await request(app).delete(`/api/v1/employees/${mine.id}`).set(auth).expect(403)
  })
})

describe('scope: trainer and hr per §3.2', () => {
  it('a trainer cannot create, update, or delete employees', async () => {
    const existing = await seedEmployee(org.aiko)
    const { token } = await tokenFor({ role: 'trainer' })
    const auth = { Authorization: `Bearer ${token}` }

    await request(app).post('/api/v1/employees').set(auth).send(employeeAt(org.aiko)).expect(403)
    await request(app)
      .put(`/api/v1/employees/${existing.id}`)
      .set(auth)
      .send({ city: 'X' })
      .expect(403)
    await request(app).delete(`/api/v1/employees/${existing.id}`).set(auth).expect(403)
  })

  it('hr manages employees across every outlet', async () => {
    const atAiko = await seedEmployee(org.aiko)
    const atCapiche = await seedEmployee(org.capiche)
    const { token } = await tokenFor({ role: 'hr' })
    const auth = { Authorization: `Bearer ${token}` }

    const list = await request(app).get('/api/v1/employees').set(auth)
    const ids = list.body.data.map((e: { id: string }) => e.id)
    expect(ids).toContain(atAiko.id)
    expect(ids).toContain(atCapiche.id)

    await request(app).post('/api/v1/employees').set(auth).send(employeeAt(org.capiche)).expect(201)
  })

  it('super_admin sees everything', async () => {
    const atAiko = await seedEmployee(org.aiko)
    const atCapiche = await seedEmployee(org.capiche)
    const { token } = await tokenFor({ role: 'super_admin' })

    const res = await request(app).get('/api/v1/employees').set('Authorization', `Bearer ${token}`)
    const ids = res.body.data.map((e: { id: string }) => e.id)
    expect(ids).toEqual(expect.arrayContaining([atAiko.id, atCapiche.id]))
  })
})

describe('scope: filters cannot be used to escape it', () => {
  it('an outlet_manager cannot widen scope with ?outlet_id=', async () => {
    const atCapiche = await seedEmployee(org.capiche)
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    // The query filter is ANDed with the scope, never substituted for it.
    const res = await request(app)
      .get(`/api/v1/employees?outlet_id=${org.capiche}`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
    expect(res.body.data.map((e: { id: string }) => e.id)).not.toContain(atCapiche.id)
  })

  it('a staff member cannot widen scope with ?outlet_id=', async () => {
    const other = await seedEmployee(org.aiko)
    const { token } = await tokenFor({ role: 'staff', withEmployee: true })

    const res = await request(app)
      .get(`/api/v1/employees?outlet_id=${org.aiko}`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.body.data.map((e: { id: string }) => e.id)).not.toContain(other.id)
  })

  it('search cannot reach across outlets', async () => {
    const atCapiche = await seedEmployee(org.capiche)
    const { token } = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })

    const res = await request(app)
      .get(`/api/v1/employees?search=${atCapiche.employeeCode}`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.body.data).toHaveLength(0)
  })
})
