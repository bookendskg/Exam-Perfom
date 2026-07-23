import type { PrismaClient } from '@bookends/db'
import {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  validatePassword,
  type Role,
} from '@bookends/core'
import { randomBytes, randomInt } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { ApiError } from '../http/api-error.js'
import { type SessionService, type DeviceContext, type IssuedSession } from './session.service.js'
import type { Logger } from 'pino'
import type { NotificationDispatcher } from '../notifications/dispatcher.js'
import type { LockoutService } from './lockout.service.js'
import { hashOpaqueToken } from './token.service.js'
import { ipKey } from '../http/middleware/rate-limit.js'

/** §5.3 reset window. Short: the token is a password-equivalent while it lives. */
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000

/**
 * Floor on how long /auth/forgot-password takes to answer.
 *
 * The endpoint returns the same 200 for every input, but it did not take the
 * same *time*: an unknown number cost one indexed SELECT and returned in a
 * millisecond or two, while a real one additionally wrote a row and called the
 * delivery channel. Response time therefore reported what the response body was
 * carefully refusing to say, and the identical-wording defence was decorative.
 *
 * Dummy work cannot close this — the paths differ by a database write and a
 * network call, and nothing fake matches the distribution of a real one. Holding
 * every path to a fixed floor does, and it stays correct as the work inside
 * changes: the OTP flow will add a second write and the floor absorbs it.
 *
 * Padding is measured on the wall clock rather than the injectable `now`,
 * because this defends against a stopwatch held by the caller, not against
 * anything the test clock models.
 */
const FORGOT_PASSWORD_FLOOR_MS = 500

/**
 * How long a one-time code is good for.
 *
 * Short on purpose: the code is the whole credential for that window, and ten
 * minutes is long enough to read a message and type six digits while leaving an
 * attacker almost no room to grind. The reset token it buys lives longer,
 * because by then the account holder has already proven possession.
 */
const OTP_TTL_MS = 10 * 60 * 1000

/**
 * Guesses allowed against one code. Five of a million leaves a one-in-200,000
 * chance per issued code, and the code dies the moment the budget is spent.
 */
const OTP_MAX_ATTEMPTS = 5

/** How soon a new code may replace an unspent one. See `issuePasswordReset`. */
const OTP_RESEND_COOLDOWN_MS = 60 * 1000

/**
 * A uniformly random six-digit code, leading zeros included.
 *
 * `randomInt` rather than `Math.random`, which is not a cryptographic source —
 * predicting the code would defeat the entire flow. Rejection is handled inside
 * `randomInt`, so there is no modulo bias favouring low codes.
 */
function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * The single answer for every failed verification.
 *
 * Wrong code, expired code, spent code, no code, and unknown account all end
 * here. Any distinction between them reports whether the number is registered.
 */
function invalidResetCode(): ApiError {
  return ApiError.validation('Invalid or expired code', [
    { field: 'code', message: 'This code is incorrect or has expired' },
  ])
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly lockout: LockoutService,
    /** Optional so tests can construct the service without a logger. */
    private readonly logger?: Logger,
    private readonly now: () => number = () => Date.now(),
    /**
     * Overridable so the timing test can assert the floor is applied without
     * waiting half a second per case, and so it can be raised in production
     * without a code change if the work inside ever grows past it.
     */
    private readonly floorMs: number = FORGOT_PASSWORD_FLOOR_MS
  ) {}

  /**
   * §5.3 POST /auth/login.
   *
   * Every failure path returns the identical INVALID_CREDENTIALS — unknown
   * phone, wrong password, and deactivated account are indistinguishable to a
   * caller. Anything else enumerates which of the ~300 staff numbers exist.
   */
  async login(phone: string, password: string, device: DeviceContext): Promise<IssuedSession> {
    const client = ipKey(device.ipAddress)

    // Before any argon2 work: a locked identifier must not be able to spend
    // 19 MiB of hashing per request, or the lockout becomes a CPU amplifier.
    await this.lockout.assertNotLocked(phone, client)

    const user = await this.prisma.user.findUnique({ where: { phone } })

    if (!user) {
      // Burn the same CPU a real argon2 verify would. Without this, "unknown
      // phone" returns in ~1ms and "wrong password" in ~50ms, and the gap is a
      // user-enumeration oracle.
      await verifyAgainstDummy(password)
      await this.lockout.recordFailure(phone, client)
      throw ApiError.invalidCredentials()
    }

    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid || !user.isActive) {
      await this.lockout.recordFailure(phone, client)
      throw ApiError.invalidCredentials()
    }

    await this.lockout.clear(phone)

    const issued = await this.sessions.issue(user.id, user.role as Role, device)
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })
    return issued
  }

  /**
   * §7.3 force-change-on-first-login, and ordinary voluntary changes.
   *
   * Every other session for the user is revoked: if the password changed
   * because it was compromised, leaving the attacker's session alive defeats
   * the point. The caller's own session survives so they are not bounced to
   * the login screen mid-flow.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    device: DeviceContext = {}
  ): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw ApiError.unauthenticated()

    const client = ipKey(device.ipAddress)

    // This endpoint verifies a password, so it needs the same lockout as login.
    // Without it a stolen 15-minute access token allowed unlimited guessing at
    // `currentPassword` — and staff passwords are six characters with no
    // complexity, so the guess space is small enough to exhaust. Each guess also
    // cost a full argon2 verify, making it a CPU-exhaustion vector besides.
    await this.lockout.assertNotLocked(user.phone, client)

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      await this.lockout.recordFailure(user.phone, client, 'change_password')
      throw ApiError.validation('Current password is incorrect', [
        { field: 'currentPassword', message: 'Incorrect password' },
      ])
    }

    await this.lockout.clear(user.phone)

    // The policy depends on the user's role, which is only known after lookup —
    // so this cannot be a static route-level schema. The field name must match
    // the input the panel actually renders, or the violations arrive addressed
    // to a field that is not on the form and the user sees no specifics.
    const violations = validatePassword(newPassword, user.role as Role, 'newPassword')
    if (violations.length > 0) {
      throw ApiError.validation('Password does not meet requirements', violations)
    }

    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw ApiError.validation('New password must differ from the current one', [
        { field: 'newPassword', message: 'Must differ from your current password' },
      ])
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    })

    /**
     * Rotate the session identifier, do not merely prune the others.
     *
     * Changing a credential is a privilege-change event, and the standard
     * defence against session fixation is to issue a NEW session id at that
     * point. The previous behaviour kept the caller's session id and refresh
     * token alive and only revoked the *other* sessions — which inverts badly
     * in the case that matters: if an attacker phished the password and is the
     * one sitting in the surviving session, it is the victim changing their
     * password from elsewhere who gets logged out.
     *
     * Revoking everything and re-issuing means whoever completed the change
     * holds the only live session, and every stolen token is dead.
     */
    await this.sessions.revokeAllForUser(userId, 'password_change')
    return this.sessions.issue(userId, user.role as Role, device)
  }

  /**
   * §5.3 POST /auth/forgot-password.
   *
   * Always resolves, whether or not the phone exists. Reporting "no such user"
   * would turn this endpoint into the account-enumeration oracle that the login
   * timing work exists to prevent.
   */
  async forgotPassword(phone: string): Promise<void> {
    const startedAt = Date.now()
    try {
      await this.issuePasswordReset(phone)
    } finally {
      // In a `finally` so a thrown path cannot be timed either — an exception
      // that escaped early would otherwise be its own, faster, signal.
      const remaining = this.floorMs - (Date.now() - startedAt)
      if (remaining > 0) await sleep(remaining)
    }
  }

  /** The real work behind {@link forgotPassword}, held to that method's floor. */
  private async issuePasswordReset(phone: string): Promise<void> {
    // Generated unconditionally, before the account is known to exist, so both
    // paths do the same work.
    const code = generateOtpCode()

    const user = await this.prisma.user.findUnique({ where: { phone } })
    if (!user || !user.isActive) return

    /**
     * Do not reissue while a freshly-sent code is still in flight.
     *
     * Reissuing on every request made this endpoint a way to *deny* account
     * recovery: anyone who knew a phone number could fire repeated requests and
     * invalidate every code the real owner was sent, indefinitely. A short
     * cooldown keeps "resend" working — the reason a user asks again is usually
     * that the first message has not arrived yet — while bounding how often an
     * attacker can invalidate a code the owner is in the middle of typing.
     */
    const newest = await this.prisma.passwordResetOtp.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date(this.now()) } },
      orderBy: { createdAt: 'desc' },
    })
    if (newest && this.now() - newest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) return

    const expiresAt = new Date(this.now() + OTP_TTL_MS)

    // Supersede whatever came before. Exactly one code is ever live for an
    // account, so a guess cannot be spread across several outstanding codes to
    // multiply the attempt budget.
    await this.prisma.passwordResetOtp.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date(this.now()) },
    })

    const otp = await this.prisma.passwordResetOtp.create({
      data: {
        userId: user.id,
        // Argon2id, not a bare digest: six digits is a million possibilities,
        // which a plain SHA-256 table gives up instantly.
        codeHash: await hashPassword(code),
        expiresAt,
      },
    })

    // A delivery failure must never reach the caller.
    //
    // In production the dispatcher is UnconfiguredDispatcher, which throws 501.
    // That turned this endpoint into the cleanest enumeration oracle in the API
    // — unknown number answered 200, a real one answered 501 — inverting the
    // very property the identical-response wording exists to provide. The
    // operator needs to know; the caller must not.
    try {
      await this.dispatcher.sendPasswordReset({ phone, code, expiresAt })
    } catch (err) {
      this.logger?.error({ err }, 'Password reset could not be delivered; code rolled back')

      /**
       * Undo the row above, or an undeliverable code locks recovery shut.
       *
       * The cooldown treats a stored code as proof that a message is out there
       * working. When delivery fails that premise is false, and the cooldown
       * then rejects every retry — so the account cannot start a recovery it
       * never received. Steady state was mint, persist, fail, swallow, answer
       * 200, and go dead.
       *
       * Scoped to the row we just created, not a blind clear: a concurrent
       * request may already have issued a code that WAS delivered, and wiping
       * that would break a working reset to tidy up a failed one.
       */
      await this.prisma.passwordResetOtp.updateMany({
        where: { id: otp.id, consumedAt: null },
        data: { consumedAt: new Date(this.now()) },
      })
    }
  }

  /**
   * §5.3 second step — exchange a one-time code for a reset token.
   *
   * Deliberately does not change the password itself. The token it returns is
   * the same credential the existing reset-password endpoint already accepts,
   * so the half of recovery that was hardened earlier — single use, expiry,
   * revoke-every-session — is reused rather than reimplemented alongside it.
   *
   * Every failure is the identical error: wrong code, expired code, no code,
   * too many guesses, and unknown account are indistinguishable. Separating
   * them would say whether the number is registered, which is precisely what
   * the endpoint that issued the code refuses to say.
   */
  async verifyResetCode(phone: string, code: string): Promise<string> {
    const startedAt = Date.now()
    try {
      return await this.exchangeCodeForToken(phone, code)
    } finally {
      const remaining = this.floorMs - (Date.now() - startedAt)
      if (remaining > 0) await sleep(remaining)
    }
  }

  private async exchangeCodeForToken(phone: string, code: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { phone } })

    if (!user || !user.isActive) {
      // Same argon2 cost a real verify would pay, so "no such account" cannot be
      // separated from "wrong code" by a stopwatch. The floor above covers the
      // gross difference; this covers the shape of it.
      await verifyAgainstDummy(code)
      throw invalidResetCode()
    }

    const otp = await this.prisma.passwordResetOtp.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date(this.now()) } },
      orderBy: { createdAt: 'desc' },
    })

    if (!otp) {
      await verifyAgainstDummy(code)
      throw invalidResetCode()
    }

    /**
     * Spend the attempt before checking it.
     *
     * A six-digit code is a million guesses, which is minutes of work if they
     * are free. Incrementing first means a request that dies mid-verify — a
     * dropped connection, a crash — costs the attacker an attempt rather than
     * granting a free one, and a conditional update makes concurrent guesses
     * serialise on the row instead of all reading the same count.
     */
    const spent = await this.prisma.passwordResetOtp.updateMany({
      where: { id: otp.id, consumedAt: null, attemptCount: { lt: OTP_MAX_ATTEMPTS } },
      data: { attemptCount: { increment: 1 } },
    })

    if (spent.count === 0) {
      // Budget exhausted. Burn the code outright rather than leaving it to age
      // out, so an attacker cannot keep probing a code they have already failed.
      await this.prisma.passwordResetOtp.updateMany({
        where: { id: otp.id, consumedAt: null },
        data: { consumedAt: new Date(this.now()) },
      })
      await verifyAgainstDummy(code)
      throw invalidResetCode()
    }

    if (!(await verifyPassword(code, otp.codeHash))) throw invalidResetCode()

    const token = randomBytes(32).toString('base64url')

    // One transaction: the code must be spent and the token minted together, or
    // a failure between them either burns a correct code for nothing or leaves
    // a code that can be redeemed twice.
    await this.prisma.$transaction([
      this.prisma.passwordResetOtp.updateMany({
        where: { id: otp.id, consumedAt: null },
        data: { consumedAt: new Date(this.now()) },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          // Stored hashed: a leaked database must not yield working tokens.
          passwordResetTokenHash: hashOpaqueToken(token),
          passwordResetExpiresAt: new Date(this.now() + RESET_TOKEN_TTL_MS),
        },
      }),
    ])

    return token
  }

  /**
   * §5.3 POST /auth/reset-password.
   *
   * Revokes every session including the caller's: a reset means the account may
   * have been compromised, so nothing that was signed in before survives.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { passwordResetTokenHash: hashOpaqueToken(token) },
    })

    if (!user || !user.passwordResetExpiresAt || !user.isActive) {
      throw ApiError.validation('Invalid or expired reset token', [
        { field: 'token', message: 'This reset link is invalid or has expired' },
      ])
    }

    if (user.passwordResetExpiresAt.getTime() <= this.now()) {
      throw ApiError.validation('Invalid or expired reset token', [
        { field: 'token', message: 'This reset link is invalid or has expired' },
      ])
    }

    const violations = validatePassword(newPassword, user.role as Role, 'newPassword')
    if (violations.length > 0) {
      throw ApiError.validation('Password does not meet requirements', violations)
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        // Single-use: clearing the hash makes a replay of this token fail.
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    })

    // A user who was locked out, and has now proven control of their account,
    // must be able to sign in immediately. Leaving the lock in place makes a
    // correctly-completed recovery look broken.
    await this.lockout.clear(user.phone)

    await this.sessions.revokeAllForUser(user.id, 'password_reset')
  }
}
