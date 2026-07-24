import type { PrismaClient } from '@bookends/db'
import { ApiError } from '../http/api-error.js'

/**
 * Failed-credential lockout (§7.1).
 *
 * Replaces a process-local `Map` keyed on the identifier alone. That design had
 * two defects that only show up in production:
 *
 *  1. **Not durable or shared.** State died on every restart and was per
 *     instance, so behind N processes the real threshold was 5×N and any deploy
 *     reset it. Attackers get free retries; the control was decorative.
 *
 *  2. **It was a denial-of-service weapon.** The login identifier — an email or
 *     a phone number — is not a secret. Five deliberate wrong passwords locked
 *     any known account, repeatable forever, from one IP, for free.
 *
 * The fix for (2) is to stop treating "one attacker" and "this account is under
 * attack from everywhere" as the same event:
 *
 *  - **Per (identifier, IP)** — tight and hard. Five failures locks that IP out
 *    of that account. This is the real brute-force control, and an attacker can
 *    only ever lock *themselves* out of it.
 *  - **Per identifier, globally** — deliberately loose. It takes far more
 *    failures, across many IPs, before the account itself locks. Reaching it
 *    means a genuine distributed attack, where locking is the lesser harm.
 *    Driving it as a DoS costs an attacker many IPs *and* runs into the per-IP
 *    request limiter first.
 *
 * The identifier is whatever was typed — an email on the web panel, a phone
 * from the Android app. There is no FK to User: attempts against identifiers
 * that do not exist must be counted too, or the table becomes an
 * account-enumeration oracle.
 */

/** Per (identifier, IP). Low, because a legitimate user rarely fails five times. */
const PAIR_MAX_FAILURES = 5
const PAIR_WINDOW_MS = 15 * 60 * 1000

/** Per identifier, all IPs. High, because this one is reachable by third parties. */
const GLOBAL_MAX_FAILURES = 50
const GLOBAL_WINDOW_MS = 60 * 60 * 1000

/** Rows older than this are useless to every window above. */
const RETENTION_MS = GLOBAL_WINDOW_MS

export type AttemptKind = 'login' | 'change_password'

export class LockoutService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Throws ACCOUNT_LOCKED if this identifier is currently barred.
   *
   * Call before verifying a credential, so a locked account never spends an
   * argon2 verify — that is also what stops the lockout being a CPU amplifier.
   */
  async assertNotLocked(identifier: string, ipKey: string): Promise<void> {
    const retryAfterMs = await this.lockedUntil(identifier, ipKey)
    if (retryAfterMs !== null) {
      throw ApiError.accountLocked(Math.ceil(retryAfterMs / 1000))
    }
  }

  /** Milliseconds remaining on a lock, or null when not locked. */
  private async lockedUntil(identifier: string, ipKey: string): Promise<number | null> {
    const now = this.now()

    const [pairOldest, globalOldest] = await Promise.all([
      this.oldestWithinWindow(identifier, PAIR_WINDOW_MS, PAIR_MAX_FAILURES, ipKey),
      this.oldestWithinWindow(identifier, GLOBAL_WINDOW_MS, GLOBAL_MAX_FAILURES),
    ])

    // The lock lifts a full window after the oldest failure still counted, so it
    // decays naturally rather than needing a scheduled unlock.
    const deadlines = [
      pairOldest === null ? null : pairOldest.getTime() + PAIR_WINDOW_MS - now,
      globalOldest === null ? null : globalOldest.getTime() + GLOBAL_WINDOW_MS - now,
    ].filter((ms): ms is number => ms !== null && ms > 0)

    return deadlines.length > 0 ? Math.max(...deadlines) : null
  }

  /**
   * The oldest failure in the window, but only once the threshold is met.
   * Returns null when the account is under the limit.
   */
  private async oldestWithinWindow(
    identifier: string,
    windowMs: number,
    threshold: number,
    ipKey?: string
  ): Promise<Date | null> {
    const since = new Date(this.now() - windowMs)
    const where = { identifier, attemptedAt: { gte: since }, ...(ipKey ? { ipKey } : {}) }

    const failures = await this.prisma.loginAttempt.findMany({
      where,
      orderBy: { attemptedAt: 'asc' },
      select: { attemptedAt: true },
      // One more than the threshold is all that is needed to decide.
      take: threshold,
    })

    if (failures.length < threshold) return null
    return failures[0]?.attemptedAt ?? null
  }

  /** Records one failed credential check. */
  async recordFailure(
    identifier: string,
    ipKey: string,
    kind: AttemptKind = 'login'
  ): Promise<void> {
    // Stamped from the injected clock, not the column default. Every threshold
    // here is "N failures within a window", so the timestamps and the windows
    // must be measured by the same clock — letting the database stamp `now()`
    // while the service reads its own makes the two disagree, and the windows
    // become untestable and subtly wrong under clock skew.
    await this.prisma.loginAttempt.create({
      data: { identifier, ipKey, kind, attemptedAt: new Date(this.now()) },
    })

    // Prune opportunistically rather than on a schedule: the table is only ever
    // read through a time window, so anything older is dead weight. Scoped to
    // this identifier so the write stays small and indexed.
    await this.prisma.loginAttempt.deleteMany({
      where: { identifier, attemptedAt: { lt: new Date(this.now() - RETENTION_MS) } },
    })
  }

  /**
   * Clears an identifier's failures.
   *
   * Called on a successful login and on a completed password reset. The reset
   * case matters: without it, a user who has been locked out and correctly
   * recovers their account still cannot get in until the window elapses, which
   * makes the recovery flow look broken.
   */
  async clear(identifier: string): Promise<void> {
    await this.prisma.loginAttempt.deleteMany({ where: { identifier } })
  }
}
