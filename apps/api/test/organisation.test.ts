import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb , TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'

let app: Application

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app
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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('§9.1 outlets — seeded defaults', () => {
  it('lists the three Bookends outlets', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app).get('/api/v1/outlets').set(auth(token))

    expect(res.status).toBe(200)
    expect(res.body.data.map((o: { code: string }) => o.code)).toEqual(['AK', 'CP', 'PR'])
    expect(res.body.data.map((o: { name: string }) => o.name)).toEqual(['Aiko', 'Capiche', 'Prep'])
  })

  it('hides inactive outlets unless asked', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    await testDb().outlet.updateMany({ where: { code: 'PR' }, data: { isActive: false } })

    const active = await request(app).get('/api/v1/outlets').set(auth(token))
    expect(active.body.data).toHaveLength(2)

    const all = await request(app).get('/api/v1/outlets?include_inactive=true').set(auth(token))
    expect(all.body.data).toHaveLength(3)
  })
})

describe('outlet manager assignment — closes the dead-role gap', () => {
  it('makes an outlet_manager functional end to end', async () => {
    // Before Module 3 there was no API to set Outlet.managerId, so an
    // outlet_manager had scope ∅ and got 403 on everything. This is the whole
    // point of the module.
    const admin = await tokenFor({ role: 'admin' })
    const manager = await tokenFor({ role: 'outlet_manager' })

    // Starts out unable to do anything.
    const before = await request(app).get('/api/v1/employees').set(auth(manager.token))
    expect(before.status).toBe(403)
    expect(before.body.error.message).toContain('not assigned to manage any outlet')

    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })
    await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(admin.token))
      .send({ managerId: manager.user.id })
      .expect(200)

    // A fresh login picks up the new scope.
    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: manager.phone, password: manager.password })

    const after = await request(app)
      .get('/api/v1/employees')
      .set(auth(relogin.body.data.accessToken))
    expect(after.status).toBe(200)
  })

  it('refuses to appoint a user who is not an outlet_manager', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const notAManager = await tokenFor({ role: 'trainer' })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })

    // Pointing managerId at a trainer would silently do nothing — their role,
    // not the assignment, decides permissions — and look like a broken feature.
    const res = await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(token))
      .send({ managerId: notAManager.user.id })

    expect(res.status).toBe(400)
    expect(res.body.error.details[0].field).toBe('managerId')
    expect(res.body.error.details[0].message).toContain('trainer')
  })

  it('refuses an inactive user', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const inactive = await makeUser({ role: 'outlet_manager', isActive: false })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })

    const res = await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(token))
      .send({ managerId: inactive.user.id })

    expect(res.status).toBe(400)
    expect(res.body.error.details[0].message).toContain('inactive')
  })

  it('refuses an unknown user', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })

    const res = await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(token))
      .send({ managerId: '00000000-0000-4000-8000-000000000000' })
    expect(res.status).toBe(400)
  })

  it('revokes the outgoing manager’s access on handover, immediately', async () => {
    // Runs on the Postgres store: the memory store caches the principal and
    // cannot observe a scope change, so it would pass this vacuously.
    app = buildTestApp({ SESSION_STORE: 'postgres' }).app

    const admin = await tokenFor({ role: 'admin' })
    const outgoing = await tokenFor({ role: 'outlet_manager' })
    const incoming = await tokenFor({ role: 'outlet_manager' })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })

    await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(admin.token))
      .send({ managerId: outgoing.user.id })
      .expect(200)

    const outgoingSession = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: outgoing.phone, password: outgoing.password })
    await request(app)
      .get('/api/v1/employees')
      .set(auth(outgoingSession.body.data.accessToken))
      .expect(200)

    // Hand the outlet over while the outgoing manager is still signed in.
    await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(admin.token))
      .send({ managerId: incoming.user.id })
      .expect(200)

    // They must lose access now, not when their 2-hour session idles out.
    const after = await request(app)
      .get('/api/v1/employees')
      .set(auth(outgoingSession.body.data.accessToken))
    expect(after.status).toBe(403)
  })

  it('clears an assignment when managerId is null', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const manager = await tokenFor({ role: 'outlet_manager' })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })

    await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(admin.token))
      .send({ managerId: manager.user.id })
      .expect(200)

    const res = await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(admin.token))
      .send({ managerId: null })

    expect(res.status).toBe(200)
    expect(res.body.data.managerId).toBeNull()
  })

  it('supports one manager holding several outlets', async () => {
    const admin = await tokenFor({ role: 'admin' })
    const manager = await tokenFor({ role: 'outlet_manager' })
    const [aiko, capiche] = await Promise.all([
      testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } }),
      testDb().outlet.findFirstOrThrow({ where: { code: 'CP' } }),
    ])

    for (const outlet of [aiko, capiche]) {
      await request(app)
        .put(`/api/v1/outlets/${outlet.id}`)
        .set(auth(admin.token))
        .send({ managerId: manager.user.id })
        .expect(200)
    }

    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: manager.phone, password: manager.password })
    const me = await request(app).get('/api/v1/auth/me').set(auth(relogin.body.data.accessToken))

    expect(me.body.data.managedOutletIds.sort()).toEqual([aiko.id, capiche.id].sort())
  })
})

describe('outlet create and update', () => {
  it('creates an outlet and uppercases its code', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/outlets')
      .set(auth(token))
      .send({ name: 'Nova', code: 'nv', city: 'Ahmedabad' })

    expect(res.status).toBe(201)
    // Codes land inside employee codes (BK-NV-001); lowercase would break §8.2.
    expect(res.body.data.code).toBe('NV')
  })

  it('rejects a duplicate code, naming the clash', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/outlets')
      .set(auth(token))
      .send({ name: 'Impostor', code: 'AK' })

    expect(res.status).toBe(409)
    expect(res.body.error.details[0].message).toContain('Aiko')
  })

  it('rejects a code with punctuation', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/outlets')
      .set(auth(token))
      .send({ name: 'Bad', code: 'A-K' })
    expect(res.status).toBe(400)
  })

  it('offers no way to change an outlet’s code', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })

    // Recoding would orphan every BK-AK-nnn already issued (§8.2 codes are
    // permanent). The schema simply does not accept it.
    await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(token))
      .send({ code: 'XX', name: 'Aiko Renamed' })
      .expect(200)

    const after = await testDb().outlet.findUniqueOrThrow({ where: { id: aiko.id } })
    expect(after.code).toBe('AK')
    expect(after.name).toBe('Aiko Renamed')
  })

  it('refuses to deactivate an outlet that still has staff', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })

    const res = await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(token))
      .send({ isActive: false })

    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain('1 active employee')
  })

  it('allows deactivating an outlet whose staff have all departed (§8.4)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })
    const staff = await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    await testDb().employee.updateMany({
      where: { userId: staff.user.id },
      data: { employmentStatus: 'resigned' },
    })

    await request(app)
      .put(`/api/v1/outlets/${aiko.id}`)
      .set(auth(token))
      .send({ isActive: false })
      .expect(200)
  })
})

describe('§9.2 departments', () => {
  it('lists the six seeded departments', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app).get('/api/v1/departments').set(auth(token))
    expect(res.body.data.map((d: { code: string }) => d.code)).toEqual([
      'ADM',
      'BAR',
      'HK',
      'KIT',
      'MGT',
      'SRV',
    ])
  })

  it('creates a department', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/departments')
      .set(auth(token))
      .send({ name: 'Delivery', code: 'DEL' })
    expect(res.status).toBe(201)
  })

  it('rejects a duplicate code', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app)
      .post('/api/v1/departments')
      .set(auth(token))
      .send({ name: 'Kitchen Two', code: 'KIT' })
    expect(res.status).toBe(409)
  })

  it('refuses to deactivate a department with staff', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const kitchen = await testDb().department.findFirstOrThrow({ where: { code: 'KIT' } })
    await makeUser({ withEmployee: true })

    const res = await request(app)
      .put(`/api/v1/departments/${kitchen.id}`)
      .set(auth(token))
      .send({ isActive: false })
    expect(res.status).toBe(409)
  })
})

describe('§9.3 designations', () => {
  it('lists the fifteen seeded designations, senior first within a department', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const res = await request(app).get('/api/v1/designations').set(auth(token))
    expect(res.body.data).toHaveLength(15)

    const kitchen = res.body.data.filter(
      (d: { department: { code: string } }) => d.department?.code === 'KIT'
    )
    expect(kitchen.map((d: { level: number }) => d.level)).toEqual([5, 4, 3, 2, 1])
  })

  it('filters by department', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const bar = await testDb().department.findFirstOrThrow({ where: { code: 'BAR' } })

    const res = await request(app)
      .get(`/api/v1/designations?department_id=${bar.id}`)
      .set(auth(token))
    expect(res.body.data.map((d: { code: string }) => d.code).sort()).toEqual([
      'BAR',
      'BHELP',
      'HBAR',
    ])
  })

  it('rejects a level outside 1-5 (§9.3)', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const kitchen = await testDb().department.findFirstOrThrow({ where: { code: 'KIT' } })

    for (const level of [0, 6]) {
      const res = await request(app)
        .post('/api/v1/designations')
        .set(auth(token))
        .send({ name: 'Bad', code: `BAD${level}`, departmentId: kitchen.id, level })
      expect(res.status).toBe(400)
    }
  })

  it('refuses to move a designation held by active staff to another department', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const lineCook = await testDb().designation.findFirstOrThrow({ where: { code: 'LCOOK' } })
    const service = await testDb().department.findFirstOrThrow({ where: { code: 'SRV' } })
    await makeUser({ withEmployee: true }) // a Line Cook

    // Their employee.departmentId would no longer match their designation —
    // exactly the combination the create path rejects.
    const res = await request(app)
      .put(`/api/v1/designations/${lineCook.id}`)
      .set(auth(token))
      .send({ departmentId: service.id })

    expect(res.status).toBe(409)
    expect(res.body.error.details[0].field).toBe('departmentId')
  })
})

describe('§3.2 RBAC for organisation management', () => {
  const MANAGERS: Array<'super_admin' | 'admin'> = ['super_admin', 'admin']
  const NON_MANAGERS: Array<'outlet_manager' | 'trainer' | 'hr' | 'staff'> = [
    'outlet_manager',
    'trainer',
    'hr',
    'staff',
  ]

  it('lets super_admin and admin manage outlets', async () => {
    for (const role of MANAGERS) {
      const { token } = await tokenFor({ role })
      await request(app)
        .post('/api/v1/outlets')
        .set(auth(token))
        .send({ name: `Outlet ${role}`, code: role === 'admin' ? 'X1' : 'X2' })
        .expect(201)
    }
  })

  it('denies everyone else outlet management (§3.2)', async () => {
    for (const role of NON_MANAGERS) {
      const { token } = await tokenFor({
        role,
        withEmployee: role === 'staff',
      })
      const res = await request(app)
        .post('/api/v1/outlets')
        .set(auth(token))
        .send({ name: 'Nope', code: 'NO' })
      expect(res.status, `${role} must not create outlets`).toBe(403)
    }
  })

  it('denies everyone else department and designation management', async () => {
    for (const role of NON_MANAGERS) {
      const { token } = await tokenFor({ role, withEmployee: role === 'staff' })
      await request(app)
        .post('/api/v1/departments')
        .set(auth(token))
        .send({ name: 'Nope', code: 'NO' })
        .expect(403)
      await request(app)
        .post('/api/v1/designations')
        .set(auth(token))
        .send({ name: 'Nope', code: 'NO', level: 1 })
        .expect(403)
    }
  })

  it('lets every role READ the org structure — forms need the dropdowns', async () => {
    for (const role of [...MANAGERS, ...NON_MANAGERS]) {
      const { token } = await tokenFor({ role, withEmployee: role === 'staff' })
      await request(app).get('/api/v1/outlets').set(auth(token)).expect(200)
      await request(app).get('/api/v1/departments').set(auth(token)).expect(200)
      await request(app).get('/api/v1/designations').set(auth(token)).expect(200)
    }
  })
})

describe('§5.3 outlet employees and stats', () => {
  it('lists an outlet’s roster', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'CP' })

    const res = await request(app).get(`/api/v1/outlets/${aiko.id}/employees`).set(auth(token))
    expect(res.body.data).toHaveLength(1)
  })

  it('stops an outlet_manager enumerating another outlet’s roster', async () => {
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const capiche = await testDb().outlet.findFirstOrThrow({ where: { code: 'CP' } })

    const res = await request(app)
      .get(`/api/v1/outlets/${capiche.id}/employees`)
      .set(auth(manager.token))
    expect(res.status).toBe(404)
  })

  it('stops a staff member enumerating any roster', async () => {
    const { token } = await tokenFor({ role: 'staff', withEmployee: true })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })

    const res = await request(app).get(`/api/v1/outlets/${aiko.id}/employees`).set(auth(token))
    expect(res.status).toBe(403)
  })

  it('reports headcount broken down by department', async () => {
    const { token } = await tokenFor({ role: 'admin' })
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })
    await makeUser({ withEmployee: true, employeeOutletCode: 'AK' })

    const res = await request(app).get(`/api/v1/outlets/${aiko.id}/stats`).set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body.data.headcount).toBe(2)
    expect(res.body.data.byDepartment[0].department.code).toBe('KIT')
    expect(res.body.data.byDepartment[0].count).toBe(2)
  })

  it('denies stats to a trainer and to staff (§3.2 reports row)', async () => {
    const aiko = await testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } })
    for (const role of ['trainer', 'staff'] as const) {
      const { token } = await tokenFor({ role, withEmployee: role === 'staff' })
      const res = await request(app).get(`/api/v1/outlets/${aiko.id}/stats`).set(auth(token))
      expect(res.status, `${role} must not read outlet stats`).toBe(403)
    }
  })

  it('scopes stats to an outlet_manager’s own outlet', async () => {
    const manager = await tokenFor({ role: 'outlet_manager', managesOutletCodes: ['AK'] })
    const [aiko, capiche] = await Promise.all([
      testDb().outlet.findFirstOrThrow({ where: { code: 'AK' } }),
      testDb().outlet.findFirstOrThrow({ where: { code: 'CP' } }),
    ])

    await request(app).get(`/api/v1/outlets/${aiko.id}/stats`).set(auth(manager.token)).expect(200)
    await request(app)
      .get(`/api/v1/outlets/${capiche.id}/stats`)
      .set(auth(manager.token))
      .expect(404)
  })
})
