import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb , TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'
import { formatEmployeeCode, parseEmployeeCode } from '../src/employees/employee-code.js'

let app: Application

interface Org {
  aiko: string
  capiche: string
  kitchen: string
  lineCook: string
  headChef: string
  steward: string
}
let org: Org

beforeEach(async () => {
  // truncateAll also resets outlet managers and the §8.2 code counter.
  await truncateAll()
  app = buildTestApp().app

  const db = testDb()
  const [aiko, capiche] = await Promise.all([
    db.outlet.findFirstOrThrow({ where: { code: 'AK' } }),
    db.outlet.findFirstOrThrow({ where: { code: 'CP' } }),
  ])
  const kitchen = await db.department.findFirstOrThrow({ where: { code: 'KIT' } })
  const [lineCook, headChef, steward] = await Promise.all([
    db.designation.findFirstOrThrow({ where: { code: 'LCOOK' } }),
    db.designation.findFirstOrThrow({ where: { code: 'HCHEF' } }),
    db.designation.findFirstOrThrow({ where: { code: 'STWD' } }),
  ])

  org = {
    aiko: aiko.id,
    capiche: capiche.id,
    kitchen: kitchen.id,
    lineCook: lineCook.id,
    headChef: headChef.id,
    steward: steward.id,
  }
})

afterAll(async () => {
  await disconnectDb()
})

async function tokenFor(opts: Parameters<typeof makeUser>[0]) {
  const { phone, password } = await makeUser({ mustChangePassword: false, ...opts })
  const res = await request(app).post('/api/v1/auth/login').send({ tenantSlug: TEST_TENANT_SLUG, phone, password })
  expect(res.status, `login failed: ${JSON.stringify(res.body)}`).toBe(200)
  return res.body.data.accessToken as string
}

const newEmployee = (over: Record<string, unknown> = {}) => ({
  firstName: 'Asha',
  lastName: 'Patel',
  phone: `98${Math.floor(Math.random() * 100_000_000)}`.slice(0, 10),
  outletId: org.aiko,
  departmentId: org.kitchen,
  designationId: org.lineCook,
  joiningDate: '2026-02-01',
  preferredLanguage: 'gu',
  ...over,
})

describe('§8.2 employee code', () => {
  it('formats as BK-{OUTLET}-{SEQ}, zero-padded to 3', () => {
    // The prefix is the tenant's now, not the constant "BK" — Bookends' happens
    // to be BK, and another customer's will not be.
    expect(formatEmployeeCode('BK', 'AK', 1)).toBe('BK-AK-001')
    expect(formatEmployeeCode('BK', 'CP', 42)).toBe('BK-CP-042')
    expect(formatEmployeeCode('BK', 'PR', 15)).toBe('BK-PR-015')
  })

  it('carries each tenant’s own prefix, so two customers never collide', () => {
    expect(formatEmployeeCode('HS', 'AK', 1)).toBe('HS-AK-001')
  })

  it('does not truncate past 999', () => {
    expect(formatEmployeeCode('BK', 'AK', 1000)).toBe('BK-AK-1000')
  })

  it('round-trips through the parser', () => {
    expect(parseEmployeeCode('BK-AK-001')).toEqual({ prefix: 'BK', outletCode: 'AK', sequence: 1 })
    // Parses another tenant's prefix too: the parser has the code but not
    // necessarily the tenant that minted it.
    expect(parseEmployeeCode('HS-CP-042')).toEqual({ prefix: 'HS', outletCode: 'CP', sequence: 42 })
    expect(parseEmployeeCode('not-a-code')).toBeNull()
  })

  it('assigns sequentially per outlet', async () => {
    const token = await tokenFor({ role: 'admin' })
    const codes: string[] = []

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/v1/employees')
        .set('Authorization', `Bearer ${token}`)
        .send(newEmployee())
      expect(res.status).toBe(201)
      codes.push(res.body.data.employeeCode)
    }

    expect(codes).toEqual(['BK-AK-001', 'BK-AK-002', 'BK-AK-003'])
  })

  it('counts each outlet independently', async () => {
    const token = await tokenFor({ role: 'admin' })

    const a = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(newEmployee({ outletId: org.aiko }))
    const c = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(newEmployee({ outletId: org.capiche }))

    expect(a.body.data.employeeCode).toBe('BK-AK-001')
    expect(c.body.data.employeeCode).toBe('BK-CP-001')
  })

  it('NEVER reuses a code after an employee departs (§8.2)', async () => {
    const token = await tokenFor({ role: 'admin' })
    const auth = { Authorization: `Bearer ${token}` }

    const first = await request(app).post('/api/v1/employees').set(auth).send(newEmployee())
    expect(first.body.data.employeeCode).toBe('BK-AK-001')

    // Terminate them, then hard-delete the row — the harshest case for reuse.
    await request(app).delete(`/api/v1/employees/${first.body.data.id}`).set(auth).expect(200)
    await testDb().employee.delete({ where: { id: first.body.data.id } })

    const next = await request(app).post('/api/v1/employees').set(auth).send(newEmployee())
    // MAX(employee_code)+1 would hand back BK-AK-001 here. The counter must not.
    expect(next.body.data.employeeCode).toBe('BK-AK-002')
  })

  it('does not collide when hires race at the same outlet', async () => {
    const token = await tokenFor({ role: 'admin' })

    // The counter is incremented with UPDATE .. RETURNING under a row lock, so
    // concurrent creates serialise instead of reading the same value.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post('/api/v1/employees')
          .set('Authorization', `Bearer ${token}`)
          .send(newEmployee())
      )
    )

    const codes = results.map((r) => r.body.data.employeeCode)
    expect(results.every((r) => r.status === 201)).toBe(true)
    expect(new Set(codes).size, `duplicate codes issued: ${codes.join(', ')}`).toBe(8)
  })

  it('does not burn a code when the create fails validation', async () => {
    const token = await tokenFor({ role: 'admin' })
    const auth = { Authorization: `Bearer ${token}` }

    await request(app)
      .post('/api/v1/employees')
      .set(auth)
      .send(newEmployee({ designationId: org.headChef, departmentId: org.kitchen }))

    // A duplicate phone fails inside the transaction, so the counter rolls back.
    const dupePhone = '9812345678'
    await request(app)
      .post('/api/v1/employees')
      .set(auth)
      .send(newEmployee({ phone: dupePhone }))
    const conflict = await request(app)
      .post('/api/v1/employees')
      .set(auth)
      .send(newEmployee({ phone: dupePhone }))
    expect(conflict.status).toBe(409)

    const next = await request(app).post('/api/v1/employees').set(auth).send(newEmployee())
    expect(next.body.data.employeeCode).toBe('BK-AK-003')
  })
})

describe('§8.1 create employee', () => {
  it('creates with the required fields and returns a one-time password', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(newEmployee({ phone: '9876500011' }))

    expect(res.status).toBe(201)
    // §7.3: last 4 digits + "book"
    expect(res.body.data.temporaryPassword).toBe('0011book')
    expect(res.body.data.preferredLanguage).toBe('gu')
  })

  it('forces a password change on the new account (§7.3)', async () => {
    const token = await tokenFor({ role: 'admin' })
    const created = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(newEmployee({ phone: '9876500012' }))
    expect(created.status).toBe(201)

    // Log in with the password the API just handed back, rather than
    // reconstructing it — that also asserts the two agree.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: '9876500012', password: created.body.data.temporaryPassword })
    expect(login.status).toBe(200)
    // The default is derived from a publicly-known phone number, so the first
    // login must force a change.
    expect(login.body.data.mustChangePassword).toBe(true)
  })

  it('rejects a duplicate phone', async () => {
    const token = await tokenFor({ role: 'admin' })
    const auth = { Authorization: `Bearer ${token}` }
    await request(app)
      .post('/api/v1/employees')
      .set(auth)
      .send(newEmployee({ phone: '9876500013' }))

    const res = await request(app)
      .post('/api/v1/employees')
      .set(auth)
      .send(newEmployee({ phone: '9876500013' }))
    expect(res.status).toBe(409)
    expect(res.body.error.details[0].field).toBe('phone')
  })

  it('rejects a designation from a different department', async () => {
    const token = await tokenFor({ role: 'admin' })
    const db = testDb()
    const service = await db.department.findFirstOrThrow({ where: { code: 'SRV' } })

    // A Line Cook filed under Service. The FKs accept it — only this check does not.
    const res = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(newEmployee({ departmentId: service.id, designationId: org.lineCook }))

    expect(res.status).toBe(400)
    expect(res.body.error.details[0].field).toBe('designationId')
  })

  it('requires the §8.1 mandatory fields', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Asha' })

    expect(res.status).toBe(400)
    const fields = res.body.error.details.map((d: { field: string }) => d.field)
    for (const required of [
      'lastName',
      'phone',
      'outletId',
      'departmentId',
      'designationId',
      'joiningDate',
      'preferredLanguage',
    ]) {
      expect(fields).toContain(required)
    }
  })

  it('creates a joined timeline event', async () => {
    const token = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(newEmployee())

    const timeline = await request(app)
      .get(`/api/v1/employees/${res.body.data.id}/timeline`)
      .set('Authorization', `Bearer ${token}`)
    expect(timeline.body.data[0].eventType).toBe('joined')
  })
})

describe('§8.4 status transitions', () => {
  async function makeEmployee(token: string, over = {}) {
    const res = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${token}`)
      .send(newEmployee(over))
    expect(res.status).toBe(201)
    return res.body.data
  }

  const setStatus = (token: string, id: string, status: string) =>
    request(app)
      .post(`/api/v1/employees/${id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status })

  it('allows active → on_leave → active', async () => {
    const token = await tokenFor({ role: 'admin' })
    const emp = await makeEmployee(token)

    await setStatus(token, emp.id, 'on_leave').expect(200)
    await setStatus(token, emp.id, 'active').expect(200)
  })

  it('allows active → suspended → active', async () => {
    const token = await tokenFor({ role: 'admin' })
    const emp = await makeEmployee(token)

    await setStatus(token, emp.id, 'suspended').expect(200)
    await setStatus(token, emp.id, 'active').expect(200)
  })

  it('treats terminated as final', async () => {
    const token = await tokenFor({ role: 'admin' })
    const emp = await makeEmployee(token)

    await setStatus(token, emp.id, 'terminated').expect(200)
    const res = await setStatus(token, emp.id, 'active')
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('final')
  })

  it('treats resigned as final', async () => {
    const token = await tokenFor({ role: 'admin' })
    const emp = await makeEmployee(token)

    await setStatus(token, emp.id, 'resigned').expect(200)
    await setStatus(token, emp.id, 'active').expect(400)
  })

  it('rejects a no-op transition', async () => {
    const token = await tokenFor({ role: 'admin' })
    const emp = await makeEmployee(token)
    const res = await setStatus(token, emp.id, 'active')
    expect(res.status).toBe(400)
  })

  it('disables the login and kills sessions when someone is terminated', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const emp = await makeEmployee(admin, { phone: '9876500021' })

    // The employee logs in…
    const theirLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: '9876500021', password: '0021book' })
    expect(theirLogin.status).toBe(200)

    await setStatus(admin, emp.id, 'terminated').expect(200)

    // …and is out the moment they are terminated. Leaving the account live is
    // how a terminated employee keeps sitting exams.
    const after = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${theirLogin.body.data.accessToken}`)
    expect(after.status).toBe(401)

    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: '9876500021', password: '0021book' })
    expect(relogin.status).toBe(401)
  })

  it('soft-deletes on DELETE — the record and its history survive (§8.4)', async () => {
    const token = await tokenFor({ role: 'admin' })
    const emp = await makeEmployee(token)

    await request(app)
      .delete(`/api/v1/employees/${emp.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    // A hard delete would cascade away their exam history — the product's point.
    const row = await testDb().employee.findUnique({ where: { id: emp.id } })
    expect(row).not.toBeNull()
    expect(row!.employmentStatus).toBe('terminated')
  })

  it('hides departed employees from the default list but keeps them findable', async () => {
    const token = await tokenFor({ role: 'admin' })
    const auth = { Authorization: `Bearer ${token}` }
    const stays = await makeEmployee(token)
    const goes = await makeEmployee(token)

    await setStatus(token, goes.id, 'resigned').expect(200)

    const list = await request(app).get('/api/v1/employees').set(auth)
    const ids = list.body.data.map((e: { id: string }) => e.id)
    expect(ids).toContain(stays.id)
    expect(ids).not.toContain(goes.id)
    expect(list.body.meta.total).toBe(1)

    const filtered = await request(app).get('/api/v1/employees?status=resigned').set(auth)
    expect(filtered.body.data.map((e: { id: string }) => e.id)).toEqual([goes.id])
  })

  it('records a timeline event with the right type', async () => {
    const token = await tokenFor({ role: 'admin' })
    const emp = await makeEmployee(token)
    await setStatus(token, emp.id, 'suspended').expect(200)

    const timeline = await request(app)
      .get(`/api/v1/employees/${emp.id}/timeline`)
      .set('Authorization', `Bearer ${token}`)
    expect(timeline.body.data[0].eventType).toBe('suspension')
    expect(timeline.body.data[0].metadata).toMatchObject({ from: 'active', to: 'suspended' })
  })
})
