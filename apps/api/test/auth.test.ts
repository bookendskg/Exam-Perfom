import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp, type TestHarness } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb , TEST_TENANT_SLUG } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

let harness: TestHarness
let app: Application

const login = (phone: string, password: string, deviceInfo?: object) =>
  request(app)
    .post('/api/v1/auth/login')
    // supertest sends no User-Agent unless asked; real clients always do.
    .set('User-Agent', deviceInfo ? 'BookendsApp/1.0 (Android)' : 'Mozilla/5.0')
    .send({ tenantSlug: TEST_TENANT_SLUG, phone, password, ...(deviceInfo ? { deviceInfo } : {}) })

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  harness = buildTestApp()
  app = harness.app
})

afterAll(async () => {
  await disconnectDb()
})

describe('POST /auth/login (§5.3, §7.1)', () => {
  it('logs in with phone + password and returns an access token', async () => {
    const { phone, password } = await makeUser({ role: 'staff' })
    const res = await login(phone, password)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.accessToken).toBeTruthy()
    expect(res.body.data.expiresIn).toBe(900) // §7.2 — 15 minutes
    expect(res.body.data.user.role).toBe('staff')
  })

  it('sets an HttpOnly, path-scoped refresh cookie for web clients (§7.2)', async () => {
    const { phone, password } = await makeUser()
    const res = await login(phone, password)

    const cookie = res.headers['set-cookie']?.[0] ?? ''
    expect(cookie).toContain('bookends_rt=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    // Path-scoped so the token never rides along on ordinary API calls.
    expect(cookie).toContain('Path=/api/v1/auth')
    // Never exposed to JS on the web path.
    expect(res.body.data.refreshToken).toBeUndefined()
  })

  it('returns the refresh token in the body for the APK, which has no cookie jar', async () => {
    const { phone, password } = await makeUser()
    const res = await login(phone, password, { model: 'Redmi 9', osVersion: '11' })

    expect(res.body.data.refreshToken).toBeTruthy()
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('records device info on the session (§7.5)', async () => {
    const { phone, password } = await makeUser()
    await login(phone, password, { model: 'Redmi 9', osVersion: '11' })

    const session = await testDb().userSession.findFirstOrThrow()
    expect(session.deviceInfo).toMatchObject({ model: 'Redmi 9' })
    expect(session.userAgent).toBeTruthy()
  })

  it('updates lastLoginAt', async () => {
    const { phone, password, user } = await makeUser()
    await login(phone, password)

    const after = await testDb().user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.lastLoginAt).not.toBeNull()
  })

  it('rejects a wrong password', async () => {
    const { phone } = await makeUser({ password: 'Password1' })
    const res = await login(phone, 'WrongPassword1')

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('gives an unknown phone the SAME error as a wrong password', async () => {
    // Any difference here enumerates which of the ~300 staff numbers exist.
    const { phone } = await makeUser({ password: 'Password1' })
    const wrongPw = await login(phone, 'WrongPassword1')
    const unknown = await login('9999999999', 'WrongPassword1')

    expect(unknown.status).toBe(wrongPw.status)
    expect(unknown.body).toEqual(wrongPw.body)
  })

  it('takes comparable time for an unknown phone and a wrong password', async () => {
    const { phone } = await makeUser({ password: 'Password1' })

    const t0 = performance.now()
    await login(phone, 'WrongPassword1')
    const known = performance.now() - t0

    const t1 = performance.now()
    await login('9999999998', 'WrongPassword1')
    const unknown = performance.now() - t1

    // Without the dummy-hash burn this ratio is ~50x.
    const ratio = Math.max(known, unknown) / Math.max(1, Math.min(known, unknown))
    expect(ratio, `known=${known.toFixed(0)}ms unknown=${unknown.toFixed(0)}ms`).toBeLessThan(5)
  })

  it('rejects a deactivated account without disclosing that it exists', async () => {
    const { phone, password } = await makeUser({ isActive: false })
    const res = await login(phone, password)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('rejects a malformed body with §5.2 details[]', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ tenantSlug: TEST_TENANT_SLUG, phone: '' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'phone' })])
    )
  })

  it('locks an account after 5 failed attempts', async () => {
    const { phone } = await makeUser({ password: 'Password1' })
    for (let i = 0; i < 5; i++) await login(phone, 'Wrong1')

    const res = await login(phone, 'Password1') // correct password, still locked
    expect(res.status).toBe(423)
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED')
  })
})

describe('§7.5 session policy', () => {
  it('kills a staff member’s previous session on a new login', async () => {
    const { phone, password } = await makeUser({ role: 'staff' })

    const first = await login(phone, password)
    const firstToken = first.body.data.accessToken

    const second = await login(phone, password)
    expect(second.status).toBe(200)

    // The old access token must stop working immediately, not at its 15-min expiry.
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${firstToken}`)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('SESSION_EXPIRED')

    // The new one works.
    const ok = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${second.body.data.accessToken}`)
    expect(ok.status).toBe(200)
  })

  it('lets an admin hold two sessions at once', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })

    const web = await login(phone, password)
    const apk = await login(phone, password, { model: 'Redmi 9' })

    // §7.5: "Multiple sessions allowed for admin roles" — the whole reason
    // users.refresh_token had to become a table.
    for (const token of [web.body.data.accessToken, apk.body.data.accessToken]) {
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
    }
  })

  it('revokes the superseded staff session in the database, with a reason', async () => {
    const { phone, password, user } = await makeUser({ role: 'staff' })
    await login(phone, password)
    await login(phone, password)

    const revoked = await testDb().userSession.findMany({
      where: { userId: user.id, revokedAt: { not: null } },
    })
    expect(revoked).toHaveLength(1)
    expect(revoked[0]!.revokedReason).toBe('superseded')
  })

  it('ends a staff session after 30 minutes idle (§7.5)', async () => {
    const { phone, password } = await makeUser({ role: 'staff' })
    const res = await login(phone, password)
    const token = res.body.data.accessToken

    harness.advanceClock(31 * 60 * 1000)

    const after = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)
    expect(after.status).toBe(401)
    expect(after.body.error.code).toBe('SESSION_EXPIRED')
  })

  it('keeps an admin session alive at 31 minutes idle (2-hour window)', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const res = await login(phone, password)

    harness.advanceClock(31 * 60 * 1000)

    const after = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
    expect(after.status).toBe(200)
  })

  it('ends an admin session after 2 hours idle', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const res = await login(phone, password)

    harness.advanceClock(121 * 60 * 1000)

    const after = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
    expect(after.status).toBe(401)
  })

  it('does not log out a user who stays active', async () => {
    const { phone, password } = await makeUser({ role: 'staff' })
    const res = await login(phone, password)
    const token = res.body.data.accessToken

    // 20 min idle, act, 20 min idle, act — 40 minutes total but never 30 idle.
    for (let i = 0; i < 2; i++) {
      harness.advanceClock(20 * 60 * 1000)
      const r = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)
      expect(r.status).toBe(200)
    }
  })
})

describe('POST /auth/refresh (§5.3)', () => {
  it('rotates the refresh token', async () => {
    const { phone, password } = await makeUser()
    const first = await login(phone, password, { model: 'Redmi 9' })
    const oldToken = first.body.data.refreshToken

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: oldToken })
    expect(res.status).toBe(200)
    expect(res.body.data.refreshToken).toBeTruthy()
    expect(res.body.data.refreshToken).not.toBe(oldToken)
  })

  it('honours the old token briefly after rotation (mobile double-refresh race)', async () => {
    const { phone, password } = await makeUser()
    const first = await login(phone, password, { model: 'Redmi 9' })
    const oldToken = first.body.data.refreshToken

    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: oldToken })
    // Same token again, within the 60s grace window.
    const second = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: oldToken })
    expect(second.status).toBe(200)
  })

  it('kills the session when a token is replayed after the grace window', async () => {
    const { phone, password, user } = await makeUser()
    const first = await login(phone, password, { model: 'Redmi 9' })
    const oldToken = first.body.data.refreshToken

    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: oldToken })

    // Age the rotation past the 60s grace: this is theft, not a race.
    await testDb().userSession.updateMany({
      where: { userId: user.id },
      data: { rotatedAt: new Date(Date.now() - 120_000) },
    })

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: oldToken })
    expect(res.status).toBe(401)

    const session = await testDb().userSession.findFirstOrThrow({ where: { userId: user.id } })
    expect(session.revokedAt).not.toBeNull()
    expect(session.revokedReason).toBe('token_replay')
  })

  it('rejects an unknown refresh token', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'nope' })
    expect(res.status).toBe(401)
  })

  it('rejects a refresh with no token at all', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').send({})
    expect(res.status).toBe(401)
  })

  it('accepts the refresh token from the cookie (web path)', async () => {
    const { phone, password } = await makeUser()
    const first = await login(phone, password)
    const cookie = first.headers['set-cookie']

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).send({})
    expect(res.status).toBe(200)
    // Rotated back into the cookie, never into the body.
    expect(res.headers['set-cookie']?.[0]).toContain('bookends_rt=')
    expect(res.body.data.refreshToken).toBeUndefined()
  })

  it('rejects a refresh for a revoked session', async () => {
    const { phone, password, user } = await makeUser()
    const first = await login(phone, password, { model: 'Redmi 9' })

    await testDb().userSession.updateMany({
      where: { userId: user.id },
      data: { revokedAt: new Date(), revokedReason: 'admin_revoke' },
    })

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.data.refreshToken })
    expect(res.status).toBe(401)
  })
})

describe('POST /auth/logout', () => {
  it('ends only the calling session', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const a = await login(phone, password)
    const b = await login(phone, password, { model: 'Redmi 9' })

    await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${a.body.data.accessToken}`)
      .expect(200)

    const gone = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${a.body.data.accessToken}`)
    expect(gone.status).toBe(401)

    const alive = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${b.body.data.accessToken}`)
    expect(alive.status).toBe(200)
  })

  it('requires authentication', async () => {
    await request(app).post('/api/v1/auth/logout').expect(401)
  })
})

describe('authenticate middleware', () => {
  it('rejects a missing token', async () => {
    const res = await request(app).get('/api/v1/auth/me')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
  })

  it('rejects a garbage token', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer garbage')
    expect(res.status).toBe(401)
  })

  it('rejects a token signed with the wrong secret', async () => {
    const other = buildTestApp({ JWT_SECRET: 'a-completely-different-secret-of-sufficient-length' })
    const { phone, password } = await makeUser()
    const res = await request(other.app).post('/api/v1/auth/login').send({ tenantSlug: TEST_TENANT_SLUG, phone, password })

    // Issued by an app with a different signing key — this one must refuse it.
    const mine = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
    expect(mine.status).toBe(401)
  })

  it('rejects the alg:none confusion attack', async () => {
    // Hand-rolled unsigned token. jose's explicit HS256 allowlist is what stops this.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub: 'x', role: 'super_admin', sid: 'y', exp: Date.now() / 1000 + 999 })
    ).toString('base64url')

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${header}.${payload}.`)
    expect(res.status).toBe(401)
  })
})

describe('§7.3 force password change', () => {
  it('reports mustChangePassword on login', async () => {
    const { phone, password } = await makeUser({ mustChangePassword: true })
    const res = await login(phone, password)
    expect(res.body.data.mustChangePassword).toBe(true)
  })

  it('blocks other routes until the password is changed', async () => {
    const { phone, password } = await makeUser({ mustChangePassword: true })
    const res = await login(phone, password)

    const blocked = await request(app)
      .get('/api/v1/some-future-route')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
    expect(blocked.status).toBe(403)
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED')
  })

  it('still allows change-password and logout while blocked', async () => {
    const { phone, password } = await makeUser({ mustChangePassword: true })
    const res = await login(phone, password)
    const token = res.body.data.accessToken

    await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200)

    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: password, newPassword: 'BrandNew1' })
      .expect(200)
  })

  it('unblocks routes once changed', async () => {
    const { phone, password } = await makeUser({ mustChangePassword: true })
    const first = await login(phone, password)

    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${first.body.data.accessToken}`)
      .send({ currentPassword: password, newPassword: 'BrandNew1' })
      .expect(200)

    const after = await login(phone, 'BrandNew1')
    expect(after.body.data.mustChangePassword).toBe(false)
  })
})

describe('POST /auth/change-password', () => {
  // Not async: callers chain .expect(), which needs the supertest Test object
  // rather than a Promise wrapping it.
  const changeAs = (token: string, currentPassword: string, newPassword: string) =>
    request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword, newPassword })

  it('rejects a wrong current password', async () => {
    const { phone, password } = await makeUser()
    const res = await login(phone, password)

    const out = await changeAs(res.body.data.accessToken, 'NotMyPassword1', 'BrandNew1')
    expect(out.status).toBe(400)
    expect(out.body.error.details[0].field).toBe('currentPassword')
  })

  it('enforces the 6-char staff policy (§7.3)', async () => {
    const { phone, password } = await makeUser({ role: 'staff' })
    const res = await login(phone, password)

    const out = await changeAs(res.body.data.accessToken, password, 'abc')
    expect(out.status).toBe(400)
    expect(out.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('accepts a simple 6-char password for staff — no complexity required', async () => {
    const { phone, password } = await makeUser({ role: 'staff' })
    const res = await login(phone, password)

    await changeAs(res.body.data.accessToken, password, 'abcdef').expect(200)
  })

  it('enforces the stricter admin policy on the same endpoint', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const res = await login(phone, password)

    // 'abcdef' passes for staff but must fail here: 8 chars + upper + number.
    const out = await changeAs(res.body.data.accessToken, password, 'abcdef')
    expect(out.status).toBe(400)
    expect(out.body.error.details.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects reusing the current password', async () => {
    const { phone, password } = await makeUser()
    const res = await login(phone, password)

    const out = await changeAs(res.body.data.accessToken, password, password)
    expect(out.status).toBe(400)
    expect(out.body.error.details[0].field).toBe('newPassword')
  })

  it('revokes other sessions but keeps the caller signed in', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const a = await login(phone, password)
    const b = await login(phone, password, { model: 'Redmi 9' })

    await changeAs(a.body.data.accessToken, password, 'BrandNew1').expect(200)

    // If the password changed because it leaked, the attacker's session must die.
    const other = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${b.body.data.accessToken}`)
    expect(other.status).toBe(401)

    // …but do not bounce the person who just changed it.
    const self = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${a.body.data.accessToken}`)
    expect(self.status).toBe(200)
  })
})
