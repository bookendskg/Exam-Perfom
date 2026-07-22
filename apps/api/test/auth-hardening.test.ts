import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { SignJWT } from 'jose'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'
import { loadConfig } from '../src/config/env.js'

const SECRET = 'test-secret-that-is-definitely-long-enough-to-pass'

let app: Application

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  app = buildTestApp().app
})

afterAll(async () => {
  await disconnectDb()
})

/* -------------------------------------------------------------------------- */
/* forgot-password must not distinguish accounts                               */
/* -------------------------------------------------------------------------- */

describe('POST /auth/forgot-password — account enumeration', () => {
  const forgot = (phone: string) =>
    request(app).post('/api/v1/auth/forgot-password').send({ phone })

  it('answers identically for a real, an unknown, and a deactivated number', async () => {
    const real = await makeUser({ role: 'staff' })
    const deactivated = await makeUser({ role: 'staff', isActive: false })

    const responses = await Promise.all([
      forgot(real.phone),
      forgot('9999999999'),
      forgot(deactivated.phone),
    ])

    // Status AND body. A difference in either is a usable oracle: walking the
    // ~300-number phone space is cheap, and the answer tells an attacker
    // exactly which accounts exist.
    for (const res of responses) {
      expect(res.status).toBe(200)
      expect(res.body).toEqual(responses[0]!.body)
    }
  })

  it('does not leak through the dispatcher when delivery is unconfigured', async () => {
    // Production uses UnconfiguredDispatcher, which throws 501. That inverted
    // the whole design: unknown numbers answered 200 and real ones answered
    // 501 — the single most reliable oracle in the API.
    const productionish = buildTestApp({ isProduction: true }).app
    const real = await makeUser({ role: 'staff' })

    const known = await request(productionish)
      .post('/api/v1/auth/forgot-password')
      .send({ phone: real.phone })
    const unknown = await request(productionish)
      .post('/api/v1/auth/forgot-password')
      .send({ phone: '9999999999' })

    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(known.body).toEqual(unknown.body)
  })

  it('does not invalidate a reset link that is still live', async () => {
    const { phone, user } = await makeUser({ role: 'staff' })

    await forgot(phone)
    const first = await testDb().user.findUniqueOrThrow({ where: { id: user.id } })

    // Anyone can call this endpoint for any number. If each call overwrote the
    // token, a stranger could permanently deny the owner account recovery.
    await forgot(phone)
    const second = await testDb().user.findUniqueOrThrow({ where: { id: user.id } })

    expect(second.passwordResetTokenHash).toBe(first.passwordResetTokenHash)
  })
})

/* -------------------------------------------------------------------------- */
/* Access tokens are bound to this service                                     */
/* -------------------------------------------------------------------------- */

describe('access token binding', () => {
  async function mint(claims: Record<string, unknown>, issuer?: string, audience?: string) {
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('00000000-0000-0000-0000-000000000000')
      .setIssuedAt()
      .setExpirationTime('15m')
    if (issuer) jwt = jwt.setIssuer(issuer)
    if (audience) jwt = jwt.setAudience(audience)
    return jwt.sign(new TextEncoder().encode(SECRET))
  }

  it('rejects a token signed with the right key but a foreign issuer', async () => {
    // The scenario: a sibling service reuses JWT_SECRET to sign its own tokens.
    // Without iss/aud checks those are accepted here as valid sessions.
    const token = await mint({ role: 'admin', sid: 'x' }, 'some-other-service', 'bookends-portal')

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects a token with no issuer or audience at all', async () => {
    const token = await mint({ role: 'admin', sid: 'x' })

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })
})

/* -------------------------------------------------------------------------- */
/* The signing secret must be explicit                                         */
/* -------------------------------------------------------------------------- */

describe('JWT_SECRET enforcement', () => {
  const base = { DATABASE_URL: 'postgresql://localhost:5432/x' }

  it('refuses to boot in development without a secret', async () => {
    // The old guard only fired for NODE_ENV === 'production'. NODE_ENV defaults
    // to 'development', so a container that forgot to set it ran on a constant
    // committed to this repository.
    expect(() => loadConfig({ ...base, NODE_ENV: 'development' })).toThrow(/JWT_SECRET/)
  })

  it('refuses to boot in production without a secret', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/JWT_SECRET/)
  })

  it('rejects a long but degenerate secret', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'development', JWT_SECRET: 'a'.repeat(48) })
    ).toThrow(/variety/)
  })

  it('accepts a real secret', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', JWT_SECRET: SECRET })).not.toThrow()
  })

  it('still allows tests to run without one', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'test' })).not.toThrow()
  })
})
