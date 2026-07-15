import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb , testTenantId , TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser } from './helpers/factories.js'

let app: Application

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app
})

afterAll(async () => {
  await disconnectDb()
})

async function staffToken(over: Parameters<typeof makeUser>[0] = {}) {
  const made = await makeUser({
    role: 'staff',
    withEmployee: true,
    mustChangePassword: false,
    employeeOutletCode: 'AK',
    ...over,
  })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })
  expect(res.status).toBe(200)
  return { token: res.body.data.accessToken as string, ...made }
}

const get = (path: string, token: string) =>
  request(app).get(`/api/v1/staff${path}`).set('Authorization', `Bearer ${token}`)

describe('§5.3 GET /staff/profile', () => {
  it('returns the caller’s own profile with their outlet and designation', async () => {
    const { token } = await staffToken()
    const res = await get('/profile', token)

    expect(res.status).toBe(200)
    expect(res.body.data.firstName).toBe('Test')
    expect(res.body.data.outlet.code).toBe('AK')
    expect(res.body.data.department.code).toBe('KIT')
    expect(res.body.data.designation.code).toBe('LCOOK')
  })

  it('includes the preferred language, which drives the whole APK UI (§6)', async () => {
    const { token, user } = await staffToken()
    await testDb().employee.updateMany({
      where: { userId: user.id },
      data: { preferredLanguage: 'gu' },
    })

    const res = await get('/profile', token)
    expect(res.body.data.preferredLanguage).toBe('gu')
  })

  it('never exposes a password hash', async () => {
    const { token } = await staffToken()
    const res = await get('/profile', token)
    expect(JSON.stringify(res.body)).not.toContain('argon2')
    expect(res.body.data.user.passwordHash).toBeUndefined()
  })

  it('offers no way to ask for someone else’s profile', async () => {
    const other = await staffToken()
    const { token } = await staffToken()

    // There is no :id on this route, so scope cannot be escaped by construction.
    const res = await get('/profile', token)
    expect(res.body.data.phone).not.toBe(other.phone)
  })

  it('404s for a user with no employee record, e.g. the bootstrap super admin', async () => {
    const made = await makeUser({ role: 'super_admin', mustChangePassword: false })
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })

    const res = await get('/profile', login.body.data.accessToken)
    expect(res.status).toBe(404)
    expect(res.body.error.message).toContain('no employee profile')
  })

  it('requires authentication', async () => {
    await request(app).get('/api/v1/staff/profile').expect(401)
  })

  it('is blocked while a password change is outstanding (§7.3)', async () => {
    const made = await makeUser({ role: 'staff', withEmployee: true, mustChangePassword: true })
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ tenantSlug: TEST_TENANT_SLUG, phone: made.phone, password: made.password })

    const res = await get('/profile', login.body.data.accessToken)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED')
  })
})

describe('§8.5 GET /staff/dashboard', () => {
  it('returns every section the §8.5 home screen needs in one request', async () => {
    const { token } = await staffToken()
    const res = await get('/dashboard', token)

    expect(res.status).toBe(200)
    // The APK renders this on a phone over restaurant WiFi — one round trip.
    expect(Object.keys(res.body.data).sort()).toEqual([
      'certificates',
      'performance',
      'profile',
      'recentResults',
      'training',
      'unreadNotifications',
      'upcomingExams',
    ])
  })

  it('returns empty sections rather than failing before Modules 5–12 exist', async () => {
    const { token } = await staffToken()
    const res = await get('/dashboard', token)

    // The tables exist, so these are honest queries returning nothing — not
    // stubs. The shape is stable, so the APK can be built against it now.
    expect(res.body.data.upcomingExams).toEqual([])
    expect(res.body.data.recentResults).toEqual([])
    expect(res.body.data.training).toEqual([])
    expect(res.body.data.certificates).toEqual([])
    expect(res.body.data.performance.months).toEqual([])
    expect(res.body.data.unreadNotifications).toBe(0)
  })

  it('counts only the caller’s unread notifications', async () => {
    const { token, user } = await staffToken()
    const other = await staffToken()

    await testDb().notification.createMany({
      data: [
        { tenantId: testTenantId(), userId: user.id, type: 'system', title: 'Yours', body: 'x', isRead: false },
        { tenantId: testTenantId(), userId: user.id, type: 'system', title: 'Read', body: 'x', isRead: true },
        { tenantId: testTenantId(), userId: other.user.id, type: 'system', title: 'Theirs', body: 'x', isRead: false },
      ],
    })

    const res = await get('/dashboard', token)
    expect(res.body.data.unreadNotifications).toBe(1)
  })

  it('shows only the caller’s certificates', async () => {
    const { token, user } = await staffToken()
    const other = await staffToken()

    const mine = await testDb().employee.findFirstOrThrow({ where: { userId: user.id } })
    const theirs = await testDb().employee.findFirstOrThrow({ where: { userId: other.user.id } })

    await testDb().certificate.createMany({
      data: [
        { tenantId: testTenantId(), employeeId: mine.id, type: 'monthly', title: 'Mine' },
        { tenantId: testTenantId(), employeeId: theirs.id, type: 'monthly', title: 'Theirs' },
      ],
    })

    const res = await get('/certificates', token)
    expect(res.body.data.map((c: { title: string }) => c.title)).toEqual(['Mine'])
  })
})

describe('§8.5 GET /staff/performance', () => {
  it('returns the last 6 months, oldest first for charting', async () => {
    const { token, user } = await staffToken()
    const employee = await testDb().employee.findFirstOrThrow({ where: { userId: user.id } })

    // 8 months of history; §8.5 asks for the last 6.
    await testDb().performanceSnapshot.createMany({
      data: Array.from({ length: 8 }, (_, i) => ({
        tenantId: testTenantId(),
        employeeId: employee.id,
        year: 2026,
        month: i + 1,
        averageScore: 60 + i,
      })),
    })

    const res = await get('/performance', token)
    expect(res.body.data.months).toHaveLength(6)
    // Oldest first: a trend chart plots left to right.
    expect(res.body.data.months[0].month).toBe(3)
    expect(res.body.data.months[5].month).toBe(8)
  })

  it('shows only the caller’s snapshots', async () => {
    const { token } = await staffToken()
    const other = await staffToken()
    const theirs = await testDb().employee.findFirstOrThrow({ where: { userId: other.user.id } })

    await testDb().performanceSnapshot.create({
      data: { tenantId: testTenantId(), employeeId: theirs.id, year: 2026, month: 1, averageScore: 99 },
    })

    const res = await get('/performance', token)
    expect(res.body.data.months).toEqual([])
  })
})
