import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { createHash } from 'node:crypto'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

let app: Application

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  app = buildTestApp().app
})

afterAll(async () => {
  await disconnectDb()
})

const forgot = (phone: string) => request(app).post('/api/v1/auth/forgot-password').send({ phone })

const reset = (token: string, newPassword: string) =>
  request(app).post('/api/v1/auth/reset-password').send({ token, newPassword })

describe('POST /auth/forgot-password (§5.3)', () => {
  it('accepts a known phone', async () => {
    const { phone } = await makeUser()
    const res = await forgot(phone)
    expect(res.status).toBe(200)
  })

  it('returns the SAME response for an unknown phone', async () => {
    // Otherwise this endpoint enumerates accounts, undoing the login work.
    const { phone } = await makeUser()
    const known = await forgot(phone)
    const unknown = await forgot('9999999999')

    expect(unknown.status).toBe(known.status)
    expect(unknown.body).toEqual(known.body)
  })

  it('stores the token hashed, never in plaintext', async () => {
    const { phone, user } = await makeUser()
    await forgot(phone)

    const after = await testDb().user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.passwordResetTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(after.passwordResetExpiresAt).not.toBeNull()
  })

  it('issues nothing for a deactivated account', async () => {
    const { phone, user } = await makeUser({ isActive: false })
    await forgot(phone)

    const after = await testDb().user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.passwordResetTokenHash).toBeNull()
  })
})

describe('POST /auth/reset-password (§5.3)', () => {
  /** Drives the real flow, then reads back the token the dispatcher was handed. */
  async function requestReset(phone: string, userId: string) {
    await forgot(phone)
    // The service hashes with sha256; invert by generating a token whose hash we
    // control is impossible, so instead assert via the stored hash and use a
    // known-good raw token injected directly.
    const raw = 'test-raw-reset-token-value'
    await testDb().user.update({
      where: { id: userId },
      data: { passwordResetTokenHash: createHash('sha256').update(raw).digest('hex') },
    })
    return raw
  }

  it('resets the password with a valid token', async () => {
    const { phone, user } = await makeUser({ role: 'staff' })
    const token = await requestReset(phone, user.id)

    await reset(token, 'newpass').expect(200)

    // The new password works…
    await request(app).post('/api/v1/auth/login').send({ phone, password: 'newpass' }).expect(200)
  })

  it('rejects an unknown token', async () => {
    const res = await reset('not-a-real-token', 'newpass')
    expect(res.status).toBe(400)
    expect(res.body.error.details[0].field).toBe('token')
  })

  it('is single-use — a replayed token fails', async () => {
    const { phone, user } = await makeUser({ role: 'staff' })
    const token = await requestReset(phone, user.id)

    await reset(token, 'newpass').expect(200)
    // Replay must fail: the hash was cleared on use.
    await reset(token, 'othrpw').expect(400)
  })

  it('rejects an expired token', async () => {
    const { phone, user } = await makeUser({ role: 'staff' })
    const token = await requestReset(phone, user.id)

    await testDb().user.update({
      where: { id: user.id },
      data: { passwordResetExpiresAt: new Date(Date.now() - 1000) },
    })

    const res = await reset(token, 'newpass')
    expect(res.status).toBe(400)
  })

  it('enforces the role password policy (§7.3)', async () => {
    const { phone, user } = await makeUser({ role: 'admin' })
    const token = await requestReset(phone, user.id)

    // Valid for staff, too weak for an admin.
    const res = await reset(token, 'abcdef')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('revokes EVERY session including the current one', async () => {
    const { phone, password, user } = await makeUser({ role: 'admin' })
    const live = await request(app).post('/api/v1/auth/login').send({ phone, password })

    const token = await requestReset(phone, user.id)
    await reset(token, 'BrandNew1').expect(200)

    // A reset means the account may be compromised — nothing signed in before
    // it survives, unlike change-password which spares the caller.
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${live.body.data.accessToken}`)
    expect(res.status).toBe(401)
  })

  it('clears mustChangePassword', async () => {
    const { phone, user } = await makeUser({ role: 'staff', mustChangePassword: true })
    const token = await requestReset(phone, user.id)

    await reset(token, 'newpass').expect(200)

    const after = await testDb().user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.mustChangePassword).toBe(false)
    expect(after.passwordChangedAt).not.toBeNull()
  })
})
