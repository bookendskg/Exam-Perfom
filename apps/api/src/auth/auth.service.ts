import type { PrismaClient } from '@bookends/db'
import {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  validatePassword,
  type Role,
} from '@bookends/core'
import { randomBytes } from 'node:crypto'
import { ApiError } from '../http/api-error.js'
import { type SessionService, type DeviceContext, type IssuedSession } from './session.service.js'
import type { Logger } from 'pino'
import type { NotificationDispatcher } from '../notifications/dispatcher.js'
import type { LockoutService } from './lockout.service.js'
import { hashOpaqueToken } from './token.service.js'
import { ipKey } from '../http/middleware/rate-limit.js'

/** §5.3 reset window. Short: the token is a password-equivalent while it lives. */
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly lockout: LockoutService,
    /** Optional so tests can construct the service without a logger. */
    private readonly logger?: Logger,
    private readonly now: () => number = () => Date.now()
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
    // so this cannot be a static route-level schema.
    const violations = validatePassword(newPassword, user.role as Role)
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
    // Generated unconditionally, before the account is known to exist, so the
    // work is identical on both paths. Cheap (32 random bytes + one sha256).
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashOpaqueToken(token)
    const expiresAt = new Date(this.now() + RESET_TOKEN_TTL_MS)

    const user = await this.prisma.user.findUnique({ where: { phone } })
    if (!user || !user.isActive) return

    // Do not overwrite a reset token that is still live.
    //
    // Overwriting made this endpoint a way to *deny* account recovery: anyone
    // who knew a phone number could fire repeated requests and invalidate every
    // link the real owner was sent, permanently. Leaving the existing token
    // alone means the message the user already received keeps working for its
    // full window. A caller who genuinely lost that message waits it out — the
    // lesser harm, and the reason the window is only 30 minutes.
    const liveToken =
      user.passwordResetTokenHash !== null &&
      user.passwordResetExpiresAt !== null &&
      user.passwordResetExpiresAt.getTime() > this.now()
    if (liveToken) return

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        // Stored hashed: a leaked database must not yield working reset links.
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: expiresAt,
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
      await this.dispatcher.sendPasswordReset({ phone, token, expiresAt })
    } catch (err) {
      this.logger?.error({ err }, 'Password reset could not be delivered')
    }
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

    const violations = validatePassword(newPassword, user.role as Role)
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
