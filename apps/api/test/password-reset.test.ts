import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp, type RecordingDispatcher } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

let app: Application
let dispatcher: RecordingDispatcher

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  const harness = buildTestApp()
  app = harness.app
  dispatcher = harness.dispatcher
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

    // The token is minted by the verify step now, not by forgot-password — the
    // first step issues only a one-time code (see reset-otp.test.ts).
    await forgot(phone)
    await request(app)
      .post('/api/v1/auth/verify-reset-code')
      .send({ phone, code: dispatcher.sent.at(-1)?.code })

    const after = await testDb().user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.passwordResetTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(after.passwordResetExpiresAt).not.toBeNull()
  })

  it('issues nothing for a deactivated account', async () => {
    const { phone, user } = await makeUser({ isActive: false })
    await forgot(phone)

    expect(dispatcher.sent, 'a deactivated account must not receive a code').toHaveLength(0)
    const codes = await testDb().passwordResetOtp.count({ where: { userId: user.id } })
    expect(codes).toBe(0)
  })
})

describe('POST /auth/reset-password (§5.3)', () => {
  /**
   * Drives the real recovery flow end to end and returns the reset token.
   *
   * Previously this injected a known hash straight into the user row, because
   * forgot-password minted a token that only the dispatcher ever saw. Now the
   * dispatcher is captured, so the whole path — request a code, read the code
   * the user would have received, exchange it — runs for real. The injected
   * version silently stopped working the moment the token stopped being minted
   * at step one, which is precisely the kind of break a stubbed test hides.
   */
  async function requestReset(phone: string, _userId: string) {
    await forgot(phone)
    const code = dispatcher.sent.at(-1)?.code
    expect(code, 'forgot-password must have dispatched a code').toBeTruthy()

    const verified = await request(app).post('/api/v1/auth/verify-reset-code').send({ phone, code })
    expect(verified.status, JSON.stringify(verified.body)).toBe(200)

    return verified.body.data.resetToken as string
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
