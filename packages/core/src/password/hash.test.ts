import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, verifyAgainstDummy, getDummyHash } from './hash.js'
import { defaultStaffPassword } from './policy.js'

describe('hashPassword / verifyPassword (§7.3)', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse')
    expect(await verifyPassword('wrong horse', hash)).toBe(false)
  })

  it('produces argon2id PHC output', async () => {
    expect(await hashPassword('whatever')).toMatch(/^\$argon2id\$/)
  })

  it('salts — the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')])
    expect(a).not.toBe(b)
    // …and both still verify.
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', b)).toBe(true)
  })

  it('fits users.password_hash VARCHAR(255)', async () => {
    // A hash that overflows the column would fail at INSERT, not here — so
    // assert the constraint the schema actually imposes.
    const hash = await hashPassword(defaultStaffPassword('9876543210'))
    expect(hash.length).toBeLessThanOrEqual(255)
  })

  it('handles a 6-char staff password and a long passphrase alike', async () => {
    // bcrypt would silently truncate at 72 bytes; argon2 does not. Assert it.
    const long = 'x'.repeat(200)
    const hash = await hashPassword(long)
    expect(await verifyPassword(long, hash)).toBe(true)
    expect(await verifyPassword('x'.repeat(199), hash)).toBe(false)
  })

  it('handles non-ASCII passwords', async () => {
    // Staff type in Hindi and Gujarati (§6.4); a password could be too.
    const hash = await hashPassword('પાસવર્ડ૧૨૩')
    expect(await verifyPassword('પાસવર્ડ૧૨૩', hash)).toBe(true)
    expect(await verifyPassword('પાસવર્ડ', hash)).toBe(false)
  })

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A corrupt row must be a failed login, not a 500.
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', '')).toBe(false)
    expect(await verifyPassword('x', '$argon2id$garbage')).toBe(false)
  })

  it('returns false on the legacy scrypt format from the old seed', async () => {
    // The pre-Module-1 seed wrote `scrypt:{salt}:{derived}`. There is no legacy
    // verifier by design, so such a hash must fail closed rather than error.
    const legacy = 'scrypt:' + 'a'.repeat(32) + ':' + 'b'.repeat(128)
    expect(await verifyPassword('anything', legacy)).toBe(false)
  })
})

describe('timing equalisation for unknown accounts', () => {
  it('verifyAgainstDummy always returns false', async () => {
    expect(await verifyAgainstDummy('anything')).toBe(false)
  })

  it('reuses one dummy hash rather than recomputing per request', async () => {
    expect(await getDummyHash()).toBe(await getDummyHash())
  })

  it('costs roughly the same as a real failed verify', async () => {
    // The point of the dummy is that "unknown phone" and "wrong password" are
    // indistinguishable by timing — otherwise login enumerates which of the 300
    // staff numbers are registered. Assert the same order of magnitude; a tight
    // bound would be flaky on shared CI.
    const realHash = await hashPassword('some-real-password')

    const t0 = performance.now()
    await verifyPassword('wrong-password', realHash)
    const realMs = performance.now() - t0

    const t1 = performance.now()
    await verifyAgainstDummy('wrong-password')
    const dummyMs = performance.now() - t1

    const ratio = Math.max(realMs, dummyMs) / Math.max(1, Math.min(realMs, dummyMs))
    expect(ratio, `real=${realMs.toFixed(1)}ms dummy=${dummyMs.toFixed(1)}ms`).toBeLessThan(5)
  })
})
