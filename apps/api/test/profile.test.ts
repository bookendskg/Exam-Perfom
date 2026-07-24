import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp, RecordingDispatcher } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

/**
 * GET /auth/profile — the signed-in user's own account.
 *
 * Kept apart from /me deliberately: /me runs on the session-restore path on
 * every page load and is all identifiers with no joins, while this resolves
 * three relations for display. The tests below pin both halves of that split —
 * that the data is genuinely there, and that it is scoped to the caller alone.
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

async function signIn(opts: Parameters<typeof makeUser>[0] = {}) {
  const { phone, password, user } = await makeUser(opts)
  const res = await request(app).post('/api/v1/auth/login').send({ phone, password })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { token: res.body.data.accessToken as string, phone, user }
}

describe('GET /auth/profile', () => {
  it('resolves outlet, department and designation names for a staff account', async () => {
    const { token, phone } = await signIn({ role: 'staff', withEmployee: true })

    const res = await request(app)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    const body = res.body.data

    expect(body.phone).toBe(phone)
    expect(body.role).toBe('staff')
    expect(body.name).toBe('Test User')
    // The point of the endpoint: names, not the identifiers /me already returns.
    expect(body.outlet).toBeTruthy()
    expect(body.department).toBeTruthy()
    expect(body.designation).toBeTruthy()
    expect(body.joinedAt).toBeTruthy()
  })

  it('degrades cleanly for an account with no employee record', async () => {
    // Admin and super_admin accounts are not staff and have no Employee row —
    // the seeded super admin is exactly this. Every joined field must come back
    // null rather than throwing or omitting the key.
    const { token, phone } = await signIn({ role: 'super_admin' })

    const res = await request(app)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    const body = res.body.data

    expect(body.phone).toBe(phone)
    expect(body.role).toBe('super_admin')
    expect(body.name).toBeNull()
    expect(body.outlet).toBeNull()
    expect(body.department).toBeNull()
    expect(body.designation).toBeNull()
    // Present as an explicit null, so the client can distinguish "no employee
    // record" from "the server forgot to send this".
    expect(body).toHaveProperty('employeeCode', null)
  })

  it('returns the security dates the profile screen shows', async () => {
    const { token } = await signIn({ role: 'admin' })

    const res = await request(app)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${token}`)

    // lastLoginAt is stamped by the login that just happened.
    expect(res.body.data.lastLoginAt).toBeTruthy()
    expect(res.body.data.createdAt).toBeTruthy()
    expect(res.body.data).toHaveProperty('passwordChangedAt')
  })

  it('never leaks the password hash or reset token', async () => {
    const { token } = await signIn({ role: 'admin', withEmployee: true })

    const res = await request(app)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${token}`)

    // The handler selects explicitly rather than spreading the user row. This
    // asserts that stays true — a later `select: undefined` would return the
    // argon2 hash and the reset-token hash to the browser.
    const serialised = JSON.stringify(res.body)
    expect(serialised).not.toMatch(/passwordHash|password_hash/)
    expect(serialised).not.toMatch(/\$argon2/)
    expect(serialised).not.toMatch(/passwordResetTokenHash|password_reset_token_hash/)
  })

  it('shows the caller their own account and nobody else', async () => {
    const alice = await signIn({ role: 'admin', withEmployee: true })
    const bob = await signIn({ role: 'admin', withEmployee: true })

    const res = await request(app)
      .get('/api/v1/auth/profile')
      .set('Authorization', `Bearer ${bob.token}`)

    // There is no id parameter to tamper with — the endpoint can only ever
    // express "the caller". This pins that there is no way to widen it.
    expect(res.body.data.phone).toBe(bob.phone)
    expect(res.body.data.phone).not.toBe(alice.phone)
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get('/api/v1/auth/profile')
    expect(res.status).toBe(401)
  })
})

describe('PATCH /auth/profile — setting your own recovery email', () => {
  const patch = (token: string, body: object) =>
    request(app).patch('/api/v1/auth/profile').set('Authorization', `Bearer ${token}`).send(body)

  it('stores the email, lowercased, when the current password is correct', async () => {
    const { token, user } = await signIn({ role: 'admin', password: 'Password1' })

    const res = await patch(token, { email: 'Me@Example.com', currentPassword: 'Password1' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const after = await testDb().user.findUniqueOrThrow({ where: { id: user.id } })
    // Lowercased so casing cannot create a case-duplicate of an existing address.
    expect(after.email).toBe('me@example.com')
    // Stored unverified — nothing here proved the mailbox belongs to the user.
    expect(after.emailVerifiedAt).toBeNull()
  })

  it('refuses without the correct current password', async () => {
    const { token, user } = await signIn({ role: 'admin', password: 'Password1' })

    const res = await patch(token, { email: 'me@example.com', currentPassword: 'wrong-password' })
    expect(res.status).toBe(400)
    expect((res.body.error.details as Array<{ field: string }>)[0]?.field).toBe('currentPassword')

    // The email must not have changed on a failed password check.
    const after = await testDb().user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.email).toBeNull()
  })

  it('rejects an email already linked to another account', async () => {
    const other = await makeUser({ role: 'admin' })
    await testDb().user.update({
      where: { id: other.user.id },
      data: { email: 'taken@example.com' },
    })

    const { token } = await signIn({ role: 'admin', password: 'Password1' })
    const res = await patch(token, { email: 'taken@example.com', currentPassword: 'Password1' })

    // A unique email is what lets a reset be delivered to exactly one account.
    expect(res.status).toBe(409)
    expect((res.body.error.details as Array<{ field: string }>)[0]?.field).toBe('email')
  })

  it('rejects a malformed email', async () => {
    const { token } = await signIn({ role: 'admin', password: 'Password1' })
    const res = await patch(token, { email: 'not-an-email', currentPassword: 'Password1' })
    expect(res.status).toBe(400)
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app)
      .patch('/api/v1/auth/profile')
      .send({ email: 'me@example.com', currentPassword: 'x' })
    expect(res.status).toBe(401)
  })

  it('makes the account recoverable: the code then goes to the email just set', async () => {
    const { token, phone } = await signIn({ role: 'admin', password: 'Password1' })

    // Before: no email, so an email channel has nowhere to deliver.
    await patch(token, { email: 'recover@example.com', currentPassword: 'Password1' }).expect(200)

    // The whole point — the address a user sets is where their reset code goes.
    const res = await request(app).post('/api/v1/auth/forgot-password').send({ phone })
    expect(res.status).toBe(200)
    expect(dispatcher.sent).toHaveLength(1)
    expect(dispatcher.sent[0]?.email).toBe('recover@example.com')
  })
})
