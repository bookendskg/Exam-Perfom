import type { PrismaClient } from '@bookends/db'
import { runAsPlatform, runInTenant } from '@bookends/db'
import { isStaffRole, type Role } from '@bookends/core'
import type { Config } from '../config/env.js'
import type { Principal, SessionStore } from '../infra/session-store/index.js'
import { type TokenService, hashRefreshToken } from './token.service.js'
import { resolvePrincipal } from '../rbac/principal.js'
import { ApiError } from '../http/api-error.js'

/** Rotation grace: a mobile client firing two refreshes at once must not log itself out. */
const ROTATION_GRACE_MS = 60_000

export interface DeviceContext {
  deviceInfo?: unknown
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

export interface IssuedSession {
  sessionId: string
  accessToken: string
  refreshToken: string
  principal: Principal
}

export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: SessionStore,
    private readonly tokens: TokenService,
    private readonly config: Config
  ) {}

  /** Idle window per §7.5: 30 minutes for staff, 2 hours for everyone else. */
  idleTtlFor(role: Role): number {
    return isStaffRole(role)
      ? this.config.SESSION_IDLE_TTL_STAFF_SECONDS
      : this.config.SESSION_IDLE_TTL_ADMIN_SECONDS
  }

  /**
   * Creates a session, enforcing §7.5's split: staff get exactly one (a new
   * login kills the old), admin roles accumulate.
   *
   * The whole thing runs in a transaction with a row lock on the user, so two
   * simultaneous staff logins cannot both survive by interleaving their
   * revoke-then-insert.
   */
  async issue(
    tenantId: string,
    userId: string,
    role: Role,
    device: DeviceContext
  ): Promise<IssuedSession> {
    const { token: refreshToken, hash } = this.tokens.mintRefreshToken()

    const session = await this.prisma.$transaction(async (tx) => {
      // Serialises concurrent logins for this user.
      //
      // Raw SQL, so the tenant extension cannot see it — the tenant_id filter
      // here is written by hand and must stay. It is belt-and-braces rather
      // than load-bearing (a user id is a UUID and already unique platform-wide),
      // but an unqualified `FROM users` in a multi-tenant schema is exactly the
      // shape that becomes a leak the day someone copies it somewhere it
      // matters. Revisit once RLS lands and the database enforces this itself.
      await tx.$queryRaw`
        SELECT id FROM users
         WHERE id = ${userId}::uuid
           AND tenant_id = ${tenantId}::uuid
           FOR UPDATE
      `

      if (isStaffRole(role)) {
        await tx.userSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'superseded' },
        })
      }

      return tx.userSession.create({
        data: {
          tenantId,
          userId,
          refreshTokenHash: hash,
          expiresAt: this.tokens.refreshExpiryDate(),
          deviceInfo: (device.deviceInfo ?? undefined) as never,
          ipAddress: device.ipAddress ?? null,
          userAgent: device.userAgent ?? null,
        },
      })
    })

    // Staff superseding above only revoked rows; drop the store entries too so
    // the old access token stops working immediately rather than at its expiry.
    if (isStaffRole(role)) {
      await this.store.deleteAllForUser(userId)
    }

    const principal = await resolvePrincipal(this.prisma, userId, session.id)
    if (!principal) throw ApiError.invalidCredentials()

    await this.store.put(session.id, principal, this.idleTtlFor(role))
    const accessToken = await this.tokens.signAccessToken({
      sub: userId,
      role,
      sid: session.id,
    })

    return { sessionId: session.id, accessToken, refreshToken, principal }
  }

  /**
   * Rotates a refresh token. The old token is accepted for ROTATION_GRACE_MS
   * after rotation and rejected thereafter — replaying a long-dead token is a
   * theft signal, not a race.
   */
  async refresh(rawToken: string, device: DeviceContext): Promise<IssuedSession> {
    const hash = hashRefreshToken(rawToken)

    // Platform-scoped: /auth/refresh carries nothing but the token, so the
    // tenant is unknown until this row is found — the lookup is what discovers
    // it. Safe because refreshTokenHash is globally unique and is 256 bits of
    // entropy that the client had to already possess.
    const session = await runAsPlatform('refresh: keyed by a globally-unique opaque token', () =>
      this.prisma.userSession.findFirst({
        where: { OR: [{ refreshTokenHash: hash }, { previousTokenHash: hash }] },
        include: { user: true },
      })
    )

    if (!session) throw ApiError.sessionExpired()
    if (session.revokedAt) throw ApiError.sessionExpired()
    if (session.expiresAt <= new Date()) throw ApiError.sessionExpired()
    if (!session.user.isActive) throw ApiError.sessionExpired()

    // Presented the previous token: only honour it inside the grace window.
    if (session.previousTokenHash === hash && session.refreshTokenHash !== hash) {
      const rotatedAt = session.rotatedAt?.getTime() ?? 0
      if (Date.now() - rotatedAt > ROTATION_GRACE_MS) {
        // Outside the window this is a replay of a superseded token. Kill the
        // session rather than serve it.
        //
        // The row told us its tenant, so from here on scope to it rather than
        // stay on the platform escape hatch: these are ordinary tenant writes
        // and should be guarded like any other.
        await runInTenant(session.tenantId, () =>
          this.prisma.userSession.update({
            where: { id: session.id },
            data: { revokedAt: new Date(), revokedReason: 'token_replay' },
          })
        )
        await this.store.delete(session.id)
        throw ApiError.sessionExpired()
      }
    }

    const { token: nextToken, hash: nextHash } = this.tokens.mintRefreshToken()
    await runInTenant(session.tenantId, () =>
      this.prisma.userSession.update({
        where: { id: session.id },
        data: {
          refreshTokenHash: nextHash,
          previousTokenHash: session.refreshTokenHash,
          rotatedAt: new Date(),
          lastSeenAt: new Date(),
          ipAddress: device.ipAddress ?? session.ipAddress,
          userAgent: device.userAgent ?? session.userAgent,
        },
      })
    )

    const role = session.user.role as Role
    const principal = await resolvePrincipal(this.prisma, session.userId, session.id)
    if (!principal) throw ApiError.sessionExpired()

    await this.store.put(session.id, principal, this.idleTtlFor(role))
    const accessToken = await this.tokens.signAccessToken({
      sub: session.userId,
      role,
      sid: session.id,
    })

    return { sessionId: session.id, accessToken, refreshToken: nextToken, principal }
  }

  async revoke(sessionId: string, reason = 'logout'): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    })
    await this.store.delete(sessionId)
  }

  /** Ends every session for a user, optionally sparing the caller's own. */
  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    })

    if (exceptSessionId) {
      const survivors = await this.prisma.userSession.findMany({
        where: { userId, revokedAt: { not: null } },
        select: { id: true },
      })
      await Promise.all(survivors.map((s) => this.store.delete(s.id)))
    } else {
      await this.store.deleteAllForUser(userId)
    }
  }
}
