import type { PrismaClient } from '@bookends/db'
import { runAsPlatform, runInTenant } from '@bookends/db'
import {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  validatePassword,
  type Role,
} from '@bookends/core'
import { randomBytes, createHash } from 'node:crypto'
import { ApiError } from '../http/api-error.js'
import { type SessionService, type DeviceContext, type IssuedSession } from './session.service.js'
import type { NotificationDispatcher } from '../notifications/dispatcher.js'

/** §5.3 reset window. Short: the token is a password-equivalent while it lives. */
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000

/**
 * Failed-login lockout. §7 specifies none, but staff passwords are 6 characters
 * with no complexity and default to a derivative of a publicly-known phone
 * number — IP rate limiting alone does not stop credential stuffing. Recommend
 * adding this to the spec.
 */
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

interface Attempt {
  count: number
  lockedUntilMs: number
}

export class AuthService {
  /**
   * Keyed by `${tenantId}:${phone}`, not phone alone: the same number can be a
   * real account at two customers, and letting one tenant's failed attempts lock
   * the other's account is a cross-tenant denial of service.
   *
   * In-process, which is honest for a single instance; when the API scales out
   * this must move to the same durable store as sessions.
   */
  private readonly attempts = new Map<string, Attempt>()

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly now: () => number = () => Date.now()
  ) {}

  private lockKey(tenantId: string, phone: string): string {
    return `${tenantId}:${phone}`
  }

  private checkLock(key: string): void {
    const attempt = this.attempts.get(key)
    if (attempt && attempt.lockedUntilMs > this.now()) {
      throw ApiError.accountLocked((attempt.lockedUntilMs - this.now()) / 1000)
    }
  }

  private recordFailure(key: string): void {
    const attempt = this.attempts.get(key) ?? { count: 0, lockedUntilMs: 0 }
    attempt.count += 1
    if (attempt.count >= MAX_FAILED_ATTEMPTS) {
      attempt.lockedUntilMs = this.now() + LOCKOUT_MS
      attempt.count = 0
    }
    this.attempts.set(key, attempt)
  }

  private clearFailures(key: string): void {
    this.attempts.delete(key)
  }

  /**
   * §5.3 POST /auth/login.
   *
   * Every failure path returns the identical INVALID_CREDENTIALS — unknown
   * phone, wrong password, and deactivated account are indistinguishable to a
   * caller. Anything else enumerates which of the ~300 staff numbers exist.
   *
   * The tenant is a parameter, resolved from the request before we get here
   * (tenant/tenant.resolver.ts). It is not derived from the phone: looking up
   * "which organisations employ this number" would answer, unauthenticated,
   * precisely the question the dummy-verify below exists to refuse.
   */
  async login(
    tenantId: string,
    phone: string,
    password: string,
    device: DeviceContext
  ): Promise<IssuedSession> {
    const key = this.lockKey(tenantId, phone)
    this.checkLock(key)

    const user = await this.prisma.user.findUnique({
      where: { tenantId_phone: { tenantId, phone } },
    })

    if (!user) {
      // Burn the same CPU a real argon2 verify would. Without this, "unknown
      // phone" returns in ~1ms and "wrong password" in ~50ms, and the gap is a
      // user-enumeration oracle.
      await verifyAgainstDummy(password)
      this.recordFailure(key)
      throw ApiError.invalidCredentials()
    }

    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid || !user.isActive) {
      this.recordFailure(key)
      throw ApiError.invalidCredentials()
    }

    this.clearFailures(key)

    const issued = await this.sessions.issue(user.tenantId, user.id, user.role as Role, device)
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
    sessionId: string,
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw ApiError.unauthenticated()

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw ApiError.validation('Current password is incorrect', [
        { field: 'currentPassword', message: 'Incorrect password' },
      ])
    }

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

    await this.sessions.revokeAllForUser(userId, 'password_change', sessionId)
  }

  /**
   * §5.3 POST /auth/forgot-password.
   *
   * Always resolves, whether or not the phone exists. Reporting "no such user"
   * would turn this endpoint into the account-enumeration oracle that the login
   * timing work exists to prevent.
   */
  async forgotPassword(tenantId: string, phone: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { tenantId_phone: { tenantId, phone } },
    })
    if (!user || !user.isActive) return

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(this.now() + RESET_TOKEN_TTL_MS)

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        // Stored hashed: a leaked database must not yield working reset links.
        passwordResetTokenHash: hashResetToken(token),
        passwordResetExpiresAt: expiresAt,
      },
    })

    await this.dispatcher.sendPasswordReset({ phone, token, expiresAt })
  }

  /**
   * §5.3 POST /auth/reset-password.
   *
   * Revokes every session including the caller's: a reset means the account may
   * have been compromised, so nothing that was signed in before survives.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Platform-scoped, and deliberately so: the token arrives on its own, from
    // an email link that carries no tenant, so there is no context to scope to.
    // Safe because passwordResetTokenHash is globally unique (see schema) — it
    // identifies exactly one user across the platform or nobody at all.
    const user = await runAsPlatform('password reset: keyed by a globally-unique token', () =>
      this.prisma.user.findFirst({
        where: { passwordResetTokenHash: hashResetToken(token) },
      })
    )

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

    // The token told us who they are, and therefore which tenant. Everything
    // from here is an ordinary tenant write, so scope it rather than stay on
    // the platform hatch a moment longer than the lookup needed it.
    const passwordHash = await hashPassword(newPassword)
    await runInTenant(user.tenantId, async () => {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
          // Single-use: clearing the hash makes a replay of this token fail.
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
        },
      })

      await this.sessions.revokeAllForUser(user.id, 'password_reset')
    })
  }
}

/** sha256, matching the CHAR(64) column. The token is already high-entropy. */
function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
