import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { LockoutService } from '../src/auth/lockout.service.js'
import { ApiError } from '../src/http/api-error.js'
import { testDb, truncateAll, disconnectDb } from './helpers/db.js'

/**
 * Failed-credential lockout (§7.1).
 *
 * The service is exercised directly rather than through HTTP because the
 * interesting cases are about *thresholds and windows*, and driving 50 failures
 * through supertest would spend 50 argon2 verifies to assert something the
 * service already owns.
 *
 * The properties that matter are in tension, which is the whole point: it must
 * stop a brute-force attempt, and it must NOT let a stranger lock a user out of
 * their own account just by knowing their phone number.
 */
const prisma = testDb()
let now = Date.UTC(2026, 6, 22, 12, 0, 0)
const clock = () => now

function service() {
  return new LockoutService(prisma, clock)
}

const PHONE = '9876500001'
const IP_A = '203.0.113.10'
const IP_B = '198.51.100.20'

beforeEach(async () => {
  await truncateAll()
  now = Date.UTC(2026, 6, 22, 12, 0, 0)
})

afterAll(async () => {
  await disconnectDb()
})

async function failTimes(count: number, ip: string, phone = PHONE) {
  const lockout = service()
  for (let i = 0; i < count; i += 1) {
    await lockout.recordFailure(phone, ip)
  }
}

async function isLocked(ip: string, phone = PHONE): Promise<boolean> {
  try {
    await service().assertNotLocked(phone, ip)
    return false
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    return true
  }
}

describe('LockoutService', () => {
  it('allows attempts below the per-IP threshold', async () => {
    await failTimes(4, IP_A)
    expect(await isLocked(IP_A)).toBe(false)
  })

  it('locks an IP out of an account after five failures', async () => {
    await failTimes(5, IP_A)
    expect(await isLocked(IP_A)).toBe(true)
  })

  it('does NOT let one IP lock a different IP out of the same account', async () => {
    // The denial-of-service property. An attacker who knows a phone number can
    // burn their own attempts, but the account owner keeps signing in from
    // somewhere else. The old phone-only lockout failed exactly here.
    await failTimes(5, IP_A)

    expect(await isLocked(IP_A)).toBe(true)
    expect(await isLocked(IP_B)).toBe(false)
  })

  it('does not leak across accounts', async () => {
    await failTimes(5, IP_A)
    expect(await isLocked(IP_A, '9876500002')).toBe(false)
  })

  it('lifts the lock once the window has passed', async () => {
    await failTimes(5, IP_A)
    expect(await isLocked(IP_A)).toBe(true)

    now += 15 * 60 * 1000 + 1000
    expect(await isLocked(IP_A)).toBe(false)
  })

  it('still locks the account under a genuinely distributed attack', async () => {
    // Far above the per-IP threshold and spread across many sources: this is no
    // longer someone being locked out maliciously, it is the account being
    // attacked, and refusing logins is the lesser harm.
    for (let i = 0; i < 50; i += 1) {
      await failTimes(1, `203.0.113.${i}`)
    }

    expect(await isLocked('198.51.100.99')).toBe(true)
  })

  it('clear() releases the lock, so account recovery is not blocked', async () => {
    await failTimes(5, IP_A)
    expect(await isLocked(IP_A)).toBe(true)

    await service().clear(PHONE)
    expect(await isLocked(IP_A)).toBe(false)
  })

  it('survives a process restart (state is durable, not in memory)', async () => {
    await failTimes(5, IP_A)

    // A brand-new service instance, as after a deploy. The old in-memory Map
    // handed attackers a clean slate on every restart.
    const afterRestart = new LockoutService(prisma, clock)
    await expect(afterRestart.assertNotLocked(PHONE, IP_A)).rejects.toThrow()
  })

  it('prunes attempts older than the retention window', async () => {
    await failTimes(3, IP_A)
    now += 61 * 60 * 1000

    await service().recordFailure(PHONE, IP_A)

    const rows = await prisma.loginAttempt.count({ where: { phone: PHONE } })
    expect(rows).toBe(1)
  })
})
