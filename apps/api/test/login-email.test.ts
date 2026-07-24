import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

/**
 * Login by email — the web management panel's identifier.
 *
 * The backend accepts an email OR a phone (the staff Android app keeps sending
 * a phone to the same endpoint), so these cover the email path and prove the
 * phone path is untouched. The security properties that must survive the change:
 * one identical error for every failure, and a lockout that counts email
 * attempts.
 */
let app: Application

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  app = buildTestApp().app
})

afterAll(async () => {
  await disconnectDb()
})

/** An account with a known email + password. */
async function makeEmailUser(email: string, password = 'Password1') {
  const { phone, user } = await makeUser({ role: 'admin', password })
  await testDb().user.update({ where: { id: user.id }, data: { email } })
  return { email, phone, password, user }
}

const login = (body: object) => request(app).post('/api/v1/auth/login').send(body)

describe('signing in with an email', () => {
  it('succeeds with the right email and password', async () => {
    const { email, password } = await makeEmailUser('manager@example.com')

    const res = await login({ email, password })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.accessToken).toBeTruthy()
    // A browser login gets the refresh token as a cookie, never in the body.
    expect(res.headers['set-cookie']).toBeTruthy()
  })

  it('is case-insensitive — stored lowercase, typed however', async () => {
    const { password } = await makeEmailUser('mixed@example.com')

    const res = await login({ email: 'MiXeD@Example.COM', password })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  })

  it('rejects the right email with the wrong password', async () => {
    const { email } = await makeEmailUser('who@example.com')

    const res = await login({ email, password: 'wrong-password' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('rejects an unknown email with the identical error', async () => {
    await makeEmailUser('real@example.com')

    const unknown = await login({ email: 'nobody@example.com', password: 'whatever1' })
    const wrongPw = await login({ email: 'real@example.com', password: 'whatever1' })

    // Unknown account and wrong password must be indistinguishable, or the
    // endpoint reveals which emails are registered.
    expect(unknown.status).toBe(401)
    expect(unknown.body.error.code).toBe(wrongPw.body.error.code)
    expect(unknown.body.error.message).toBe(wrongPw.body.error.message)
  })

  it('does not mention which field was wrong', async () => {
    const { email } = await makeEmailUser('neutral@example.com')
    const res = await login({ email, password: 'wrong' })
    // The message must not name "email" or "phone" — that would leak which half
    // failed, and confuse whichever client did not send that field.
    expect(res.body.error.message).not.toMatch(/email|phone/i)
  })
})

describe('the phone path is untouched (staff Android app)', () => {
  it('still logs in with a phone number', async () => {
    const { phone, password } = await makeUser({ role: 'staff' })

    // The app sends deviceInfo, which is how the server knows to return the
    // refresh token in the body instead of a cookie.
    const res = await login({ phone, password, deviceInfo: { model: 'Redmi 9' } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.refreshToken).toBeTruthy()
  })
})

describe('validation', () => {
  it('rejects a login with neither email nor phone', async () => {
    const res = await login({ password: 'something' })
    expect(res.status).toBe(400)
    const fields = (res.body.error.details as Array<{ field: string }>).map((d) => d.field)
    expect(fields).toContain('email')
  })

  it('rejects a malformed email before it costs a lookup', async () => {
    const res = await login({ email: 'not-an-email', password: 'something' })
    expect(res.status).toBe(400)
  })
})

describe('the lockout counts email attempts', () => {
  it('locks the account after five wrong passwords by email', async () => {
    const { email, password } = await makeEmailUser('target@example.com')

    // Five failures for (email, IP) trips the per-pair lock. Well under the
    // login limiter's 10/min, so it is the lockout — not the rate limiter —
    // being tested.
    for (let i = 1; i <= 5; i++) {
      const res = await login({ email, password: 'wrong-password' })
      expect(res.status, `attempt ${i}`).toBe(401)
    }

    // The sixth is refused before the password is even checked — proven by the
    // correct password now being locked out too.
    const locked = await login({ email, password })
    expect(locked.status).toBe(423)
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED')
  })
})
