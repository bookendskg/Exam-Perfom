import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

/**
 * POST /auth/refresh as a BROWSER actually calls it.
 *
 * The refresh token reaches this endpoint in an HttpOnly cookie, so the request
 * body is empty by design — `auth.schemas.ts:30` says as much. It nonetheless
 * answered 400 for every browser: Express 5 with body-parser 2 leaves
 * `req.body` undefined when nothing is sent, and `validate()` handed that
 * straight to `z.object()`, which rejects with a root-level "Required" before
 * `readRefreshToken` ever looks at the cookie.
 *
 * The whole documented web session flow was therefore dead, which is why the
 * panel logged people out every 15 minutes instead of renewing.
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

async function loginWithCookie() {
  const { phone, password } = await makeUser({ role: 'admin' })
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('User-Agent', 'Mozilla/5.0')
    .send({ phone, password })

  expect(res.status).toBe(200)
  const cookie = res.headers['set-cookie']
  expect(cookie, 'login must set a refresh cookie for browser clients').toBeTruthy()
  return { cookie: cookie as unknown as string[], accessToken: res.body.data.accessToken as string }
}

describe('POST /auth/refresh — the browser flow', () => {
  it('renews from the cookie alone, with no request body at all', async () => {
    const { cookie } = await loginWithCookie()

    // No .send(), no Content-Type — exactly what fetch() issues for a bodyless
    // POST. This returned 400 VALIDATION_ERROR "(root): Required".
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.accessToken).toBeTruthy()
    expect(res.body.data.expiresIn).toBe(900)

    // Deliberately NOT asserting the new access token differs from the old one.
    // `iat`/`exp` have one-second resolution, so a refresh in the same second as
    // the login produces byte-identical claims and therefore an identical JWT.
    // That is correct behaviour, and asserting inequality here only buys a
    // flaky test. What matters — that the session was genuinely renewed — is
    // covered by the rotated cookie and the usability checks below.
  })

  it('issues a rotated refresh cookie alongside the new access token', async () => {
    const { cookie } = await loginWithCookie()

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)

    expect(res.status).toBe(200)
    // Rotation is what makes a stolen refresh token detectable; if the endpoint
    // stopped re-issuing the cookie the client would replay a dead one forever.
    expect(res.headers['set-cookie']).toBeTruthy()
  })

  it('the renewed access token actually works', async () => {
    const { cookie } = await loginWithCookie()

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)
    const next = refreshed.body.data.accessToken as string

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${next}`)
    expect(me.status).toBe(200)
  })

  it('still refuses when there is no cookie and no body', async () => {
    // The fix must not turn "no credential at all" into a success.
    const res = await request(app).post('/api/v1/auth/refresh')

    expect(res.status).toBe(401)
    expect(res.body.error.message).toMatch(/refresh token/i)
  })

  it('still accepts a body token, for clients with no cookie jar (the APK)', async () => {
    const { phone, password } = await makeUser({ role: 'staff' })
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone, password, deviceInfo: { model: 'Redmi 9' } })

    const refreshToken = login.body.data.refreshToken as string
    expect(refreshToken, 'a device client must receive the token in the body').toBeTruthy()

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken })
    expect(res.status).toBe(200)
    expect(res.body.data.refreshToken).toBeTruthy()
  })
})

describe('validate() treats a missing body as empty', () => {
  it('reports which fields are missing rather than one opaque root error', async () => {
    // Express 5 leaves req.body undefined; previously that produced
    // `(root): Required`, which tells a client nothing about what to send.
    const res = await request(app).post('/api/v1/auth/login')

    expect(res.status).toBe(400)
    const fields = (res.body.error.details as Array<{ field: string }>).map((d) => d.field)
    expect(fields).toContain('phone')
    expect(fields).toContain('password')
    expect(fields).not.toContain('(root)')
  })
})
