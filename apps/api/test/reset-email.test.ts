import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp, RecordingDispatcher } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

/**
 * The forgot-password → email delivery seam.
 *
 * EmailDispatcher itself is unit-tested in email-dispatcher.test.ts; here the
 * concern is the service around it — that the account's email reaches the
 * dispatcher, and that an account WITHOUT one is handled through the rollback
 * path so it stays indistinguishable from an unknown number.
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

async function withEmail(phone: string, email: string) {
  await testDb().user.update({ where: { phone }, data: { email } })
}

const forgot = (phone: string) => request(app).post('/api/v1/auth/forgot-password').send({ phone })

const liveCodes = (phone: string) =>
  testDb().passwordResetOtp.count({
    where: { user: { phone }, consumedAt: null, expiresAt: { gt: new Date() } },
  })

describe('forgot-password hands the account email to the dispatcher', () => {
  it('passes the address and the code through', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    await withEmail(phone, 'admin@example.com')

    const res = await forgot(phone)
    expect(res.status).toBe(200)

    expect(dispatcher.sent).toHaveLength(1)
    expect(dispatcher.sent[0]?.email).toBe('admin@example.com')
    expect(dispatcher.sent[0]?.code).toMatch(/^[0-9]{6}$/)
  })
})

describe('an account with no email stays indistinguishable from an unknown one', () => {
  it('answers 200 and retires the code when the channel rejects a null address', async () => {
    dispatcher.throwOnMissingEmail = true
    const { phone } = await makeUser({ role: 'admin' }) // makeUser sets no email

    const res = await forgot(phone)
    expect(res.status, 'a delivery failure must never reach the caller').toBe(200)

    // Nothing delivered, and the code the service optimistically created is
    // rolled back — otherwise the resend cooldown would treat a code nobody can
    // receive as proof one is in flight and refuse retries.
    expect(dispatcher.sent).toHaveLength(0)
    expect(await liveCodes(phone), 'the undeliverable code must be retired').toBe(0)
  })

  it('returns the identical response for a no-email account and an unknown number', async () => {
    dispatcher.throwOnMissingEmail = true
    const { phone } = await makeUser({ role: 'admin' })

    const noEmail = await forgot(phone)
    const unknown = await forgot('9000000123')

    // Same status, same body. Any difference here reports whether the number is
    // registered — the exact leak the whole flow is built to avoid.
    expect(noEmail.status).toBe(unknown.status)
    expect(noEmail.body).toEqual(unknown.body)
  })
})
