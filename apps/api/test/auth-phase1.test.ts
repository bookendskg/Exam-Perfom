import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp, RecordingDispatcher } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'
import { REFRESH_COOKIE } from '../src/auth/cookies.js'

/**
 * Phase 1 — the security defects found in the authentication audit.
 *
 * Each block names the failure it prevents rather than the code it touches, so
 * a future change that reintroduces the behaviour fails on a description of the
 * problem instead of an assertion about an implementation detail.
 */
let app: Application
let dispatcher: RecordingDispatcher

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  dispatcher = new RecordingDispatcher()
  app = buildTestApp({}, dispatcher).app
})

afterAll(async () => {
  await disconnectDb()
})

async function resetStateFor(phone: string) {
  const user = await testDb().user.findUnique({
    where: { phone },
    select: { passwordResetTokenHash: true, passwordResetExpiresAt: true },
  })
  return user
}

describe('B1 — an undeliverable reset token must not lock recovery shut', () => {
  it('clears the token when delivery fails, so the next request is not refused', async () => {
    const { phone } = await makeUser({ role: 'admin' })

    dispatcher.failWith = new Error('no delivery channel configured')
    const first = await request(app).post('/api/v1/auth/forgot-password').send({ phone })
    expect(first.status, 'a delivery failure must never reach the caller').toBe(200)

    // The token was written before delivery was attempted. If it survives the
    // failure, the "do not overwrite a live token" guard treats it as proof that
    // a working message is out there and refuses every retry for 30 minutes.
    const after = await resetStateFor(phone)
    expect(after?.passwordResetTokenHash, 'undelivered token must be rolled back').toBeNull()
    expect(after?.passwordResetExpiresAt).toBeNull()

    // The real proof: recovery still works immediately afterwards.
    dispatcher.failWith = null
    const second = await request(app).post('/api/v1/auth/forgot-password').send({ phone })
    expect(second.status).toBe(200)
    expect(dispatcher.sent, 'the retry must actually issue a token').toHaveLength(1)
    expect(dispatcher.sent[0]?.phone).toBe(phone)
  })

  it('still keeps a delivered token, so repeat requests cannot invalidate it', async () => {
    const { phone } = await makeUser({ role: 'admin' })

    await request(app).post('/api/v1/auth/forgot-password').send({ phone })
    const issued = dispatcher.sent[0]?.token
    expect(issued).toBeTruthy()

    // The rollback must not have weakened the anti-denial-of-recovery guard:
    // a second request while the first token is live is still a no-op.
    await request(app).post('/api/v1/auth/forgot-password').send({ phone })
    expect(dispatcher.sent, 'a live token must not be replaced').toHaveLength(1)

    // And the token the user was actually sent still works.
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: issued, newPassword: 'Str0ngPass' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })
})

describe('B3 — forgot-password must not leak account existence through timing', () => {
  it('answers in comparable time whether or not the account exists', async () => {
    const { phone } = await makeUser({ role: 'admin' })

    const time = async (target: string) => {
      const started = Date.now()
      const res = await request(app).post('/api/v1/auth/forgot-password').send({ phone: target })
      expect(res.status).toBe(200)
      return Date.now() - started
    }

    const known = await time(phone)
    const unknown = await time('9000000001')

    // Both are held to the floor. Asserting the floor rather than the gap is
    // what makes this stable: the gap alone is noisy on a loaded machine, while
    // "both took at least the floor" is the property that closes the oracle.
    expect(known, 'known account must not return before the floor').toBeGreaterThanOrEqual(450)
    expect(unknown, 'unknown account must not return early').toBeGreaterThanOrEqual(450)
  })
})

describe('B4 — a rejected password must tell the user which rule it broke', () => {
  it('addresses violations to newPassword, the field the form actually renders', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const login = await request(app).post('/api/v1/auth/login').send({ phone, password })
    const token = login.body.data.accessToken as string

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: password, newPassword: 'short' })

    expect(res.status).toBe(400)
    const details = res.body.error.details as Array<{ field: string; message: string }>

    // The panel looks these up by field name. Addressed to `password` — an input
    // that does not exist on the change-password form — every lookup missed and
    // the user was told only "Password does not meet requirements".
    expect(details.map((d) => d.field)).toContain('newPassword')
    expect(details.some((d) => /at least 8 characters/i.test(d.message))).toBe(true)
    expect(details.every((d) => d.field === 'newPassword')).toBe(true)
  })

  it('reports every broken rule at once, not just the first', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const login = await request(app).post('/api/v1/auth/login').send({ phone, password })

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .send({ currentPassword: password, newPassword: 'abc' })

    // Length, uppercase, and number are all violated. A checklist UI needs all
    // three or it turns one correction into three round trips.
    expect(res.body.error.details).toHaveLength(3)
  })
})

describe('F2 — signing out must end the session on the server', () => {
  it('revokes the session and refuses a later refresh from the same cookie', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const login = await request(app)
      .post('/api/v1/auth/login')
      .set('User-Agent', 'Mozilla/5.0')
      .send({ phone, password })

    const cookie = login.headers['set-cookie'] as unknown as string[]
    const accessToken = login.body.data.accessToken as string
    expect(cookie).toBeTruthy()

    // Refreshing works before logout — otherwise the assertion after it proves
    // nothing about logout.
    const before = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)
    expect(before.status, 'refresh must work before logout for this test to mean anything').toBe(
      200
    )
    const rotated = before.headers['set-cookie'] as unknown as string[]

    const out = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
    expect(out.status).toBe(200)

    // This is the hole: the panel used to clear localStorage and stop there, so
    // the session row and the refresh cookie stayed live for the rest of their
    // seven days and a single 401 would silently mint a new access token.
    const after = await request(app).post('/api/v1/auth/refresh').set('Cookie', rotated)
    expect(after.status, 'a revoked session must not be refreshable').toBe(401)
  })

  it('clears the refresh cookie on the way out', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const login = await request(app)
      .post('/api/v1/auth/login')
      .set('User-Agent', 'Mozilla/5.0')
      .send({ phone, password })

    const out = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)

    const cleared = (out.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith(`${REFRESH_COOKIE}=`)
    )

    // Revoking the session server-side is what actually ends it, but leaving the
    // cookie in the jar means the browser keeps presenting a dead credential on
    // every subsequent auth call. Emptied and back-dated is how a cookie is
    // deleted — there is no other mechanism.
    expect(cleared, 'the browser must be told to drop the cookie too').toBeTruthy()
    expect(cleared).toContain(`${REFRESH_COOKIE}=;`)
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/)
  })

  it('the access token is dead immediately, not merely forgotten by the client', async () => {
    const { phone, password } = await makeUser({ role: 'admin' })
    const login = await request(app).post('/api/v1/auth/login').send({ phone, password })
    const accessToken = login.body.data.accessToken as string

    await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`)

    // The JWT itself is still within its 15-minute validity window; what makes
    // it useless is that the session it names has been revoked.
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
    expect(me.status).toBe(401)
  })
})
