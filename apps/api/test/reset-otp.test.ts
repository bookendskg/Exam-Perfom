import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp, RecordingDispatcher } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

/**
 * §5.3 password recovery by one-time code.
 *
 * The code is the entire credential for its ten-minute window, and it is six
 * digits — a million possibilities, which is seconds of work if guessing is
 * free. Almost everything below is about making guesses expensive and finite,
 * and about ensuring no response distinguishes "wrong" from "no such account".
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

/** Runs forgot-password and returns the code the user would have received. */
async function requestCode(phone: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/forgot-password').send({ phone })
  expect(res.status).toBe(200)
  const code = dispatcher.sent.at(-1)?.code
  expect(code, 'a code should have been dispatched').toBeTruthy()
  return code as string
}

const verify = (phone: string, code: string) =>
  request(app).post('/api/v1/auth/verify-reset-code').send({ phone, code })

describe('the issued code', () => {
  it('is six digits', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    expect(await requestCode(phone)).toMatch(/^[0-9]{6}$/)
  })

  it('is never stored in a form the database can give back', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    const code = await requestCode(phone)

    const row = await testDb().passwordResetOtp.findFirstOrThrow({ where: { user: { phone } } })

    // Argon2id, not a digest of the six digits. A SHA-256 table of every
    // six-digit code is a megabyte and takes seconds to build, so a bare digest
    // would make a leaked table equivalent to leaking the codes themselves.
    expect(row.codeHash).not.toContain(code)
    expect(row.codeHash).toMatch(/^\$argon2id\$/)
  })

  it('is not issued at all for an unknown number, but says so identically', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ phone: '9000009999' })

    expect(res.status).toBe(200)
    expect(
      dispatcher.sent,
      'nothing may be dispatched for an account that does not exist'
    ).toHaveLength(0)
  })
})

describe('exchanging a code for a reset token', () => {
  it('accepts the right code once and issues a token that works', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    const code = await requestCode(phone)

    const res = await verify(phone, code)
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const token = res.body.data.resetToken as string
    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'Str0ngPass1' })
    expect(reset.status, JSON.stringify(reset.body)).toBe(200)

    // The whole point of the flow: the new password actually signs in.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone, password: 'Str0ngPass1' })
    expect(login.status).toBe(200)
  })

  it('refuses the same code twice', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    const code = await requestCode(phone)

    expect((await verify(phone, code)).status).toBe(200)

    // Single use. Without this, anyone who saw the code over a shoulder could
    // keep minting reset tokens for the rest of the window.
    const second = await verify(phone, code)
    expect(second.status).toBe(400)
  })

  it('gives up after five wrong guesses, and kills the code', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    const code = await requestCode(phone)
    const wrong = code === '000000' ? '111111' : '000000'

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await verify(phone, wrong)).status, `guess ${attempt}`).toBe(400)
    }

    // The budget is spent, so the code is burned outright rather than left to
    // age out — otherwise an attacker keeps probing a code they already failed.
    const nowCorrect = await verify(phone, code)
    expect(nowCorrect.status, 'the real code must not work after the budget is spent').toBe(400)

    const row = await testDb().passwordResetOtp.findFirstOrThrow({ where: { user: { phone } } })
    expect(row.consumedAt).not.toBeNull()
  })

  it('spends an attempt on every wrong guess', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    const code = await requestCode(phone)
    const wrong = code === '123456' ? '654321' : '123456'

    await verify(phone, wrong)
    await verify(phone, wrong)

    const row = await testDb().passwordResetOtp.findFirstOrThrow({ where: { user: { phone } } })
    expect(row.attemptCount).toBe(2)
  })

  it('refuses an expired code', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    const code = await requestCode(phone)

    await testDb().passwordResetOtp.updateMany({
      where: { user: { phone } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    expect((await verify(phone, code)).status).toBe(400)
  })

  it("refuses another account's code", async () => {
    const alice = await makeUser({ role: 'admin' })
    const bob = await makeUser({ role: 'admin' })
    const aliceCode = await requestCode(alice.phone)

    // Codes are bound to the user they were issued for. Without that, one
    // attacker-owned account's code would unlock every other account.
    expect((await verify(bob.phone, aliceCode)).status).toBe(400)
  })
})

describe('nothing distinguishes a real account from an unknown one', () => {
  it('answers a wrong code and an unknown number identically', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    await requestCode(phone)

    const wrongCode = await verify(phone, '000000')
    const unknownNumber = await verify('9000009998', '000000')

    // Same status, same code, same message. Any difference reports whether the
    // number is registered — exactly what forgot-password refuses to say.
    expect(unknownNumber.status).toBe(wrongCode.status)
    expect(unknownNumber.body.error.code).toBe(wrongCode.body.error.code)
    expect(unknownNumber.body.error.message).toBe(wrongCode.body.error.message)
  })

  it('answers in comparable time for both', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    await requestCode(phone)

    const time = async (target: string) => {
      const started = Date.now()
      await verify(target, '000000')
      return Date.now() - started
    }

    // Both are held to the same floor as forgot-password. Without it, "no such
    // account" skips the argon2 verify and returns measurably sooner.
    expect(await time(phone)).toBeGreaterThanOrEqual(450)
    expect(await time('9000009997')).toBeGreaterThanOrEqual(450)
  })
})

describe('reissuing', () => {
  it('does not replace a code that was just sent', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    await requestCode(phone)

    await request(app).post('/api/v1/auth/forgot-password').send({ phone })

    // Inside the cooldown this is a no-op, so someone who knows the number
    // cannot invalidate each code as it arrives and lock recovery shut.
    expect(dispatcher.sent).toHaveLength(1)
  })

  it('supersedes the old code once the cooldown has passed', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    const first = await requestCode(phone)

    // Age the existing code past the resend cooldown.
    await testDb().passwordResetOtp.updateMany({
      where: { user: { phone } },
      data: { createdAt: new Date(Date.now() - 120_000) },
    })

    const second = await requestCode(phone)
    expect(second).not.toBe(first)

    // Exactly one code is live at a time, so the attempt budget cannot be
    // multiplied by holding several outstanding codes at once.
    const live = await testDb().passwordResetOtp.count({
      where: { user: { phone }, consumedAt: null },
    })
    expect(live).toBe(1)
    expect((await verify(phone, first)).status, 'the superseded code must be dead').toBe(400)
    expect((await verify(phone, second)).status).toBe(200)
  })
})

describe('input shape', () => {
  it('rejects anything that is not six digits without touching the database', async () => {
    const { phone } = await makeUser({ role: 'admin' })
    await requestCode(phone)

    for (const code of ['12345', '1234567', 'abcdef', '']) {
      const res = await request(app).post('/api/v1/auth/verify-reset-code').send({ phone, code })
      expect(res.status, `code "${code}"`).toBe(400)
    }

    // A malformed code must not have cost the user any of their five guesses.
    const row = await testDb().passwordResetOtp.findFirstOrThrow({ where: { user: { phone } } })
    expect(row.attemptCount).toBe(0)
  })
})
