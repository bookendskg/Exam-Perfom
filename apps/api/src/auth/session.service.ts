import type { PrismaClient } from '@bookends/db'
import { isStaffRole, type Role } from '@bookends/core'
import type { Config } from '../config/env.js'
import type { Principal, SessionStore } from '../infra/session-store/index.js'
import { type TokenService, hashOpaqueToken } from './token.service.js'
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
  async issue(userId: string, role: Role, device: DeviceContext): Promise<IssuedSession> {
    const { token: refreshToken, hash } = this.tokens.mintRefreshToken()

    const session = await this.prisma.$transaction(async (tx) => {
      // Serialises concurrent logins for this user.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`

      if (isStaffRole(role)) {
        await tx.userSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'superseded' },
        })
      }

      return tx.userSession.create({
        data: {
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
    //
    // The exemption is essential. This runs AFTER the transaction that created
    // `session`, and in the Postgres store the "store entry" is the session row
    // itself — so an unfiltered call revokes the session we are in the middle of
    // issuing, and the user is 401'd on their first request.
    if (isStaffRole(role)) {
      await this.store.deleteAllForUser(userId, session.id)
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
    const hash = hashOpaqueToken(rawToken)
    const { token: nextToken, hash: nextHash } = this.tokens.mintRefreshToken()

    /**
     * The whole rotation runs in one transaction under a row lock.
     *
     * It used to be a bare `findFirst` followed by an `update` keyed only on
     * the session id, with nothing tying the write to the token that was read.
     * Two concurrent refreshes of the same token therefore both succeeded, both
     * set `previousTokenHash` to the *original* hash, and the loser was handed a
     * refresh token that was already dead — a silent logout, under exactly the
     * mobile double-fire the grace window exists to absorb. It also let an
     * attacker keep the window churning to suppress replay detection.
     *
     * `issue()` a few lines above already used the correct pattern; refresh
     * simply had not been brought in line.
     */
    const outcome = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM user_sessions
         WHERE refresh_token_hash = ${hash} OR previous_token_hash = ${hash}
         FOR UPDATE
      `
      if (!locked) return { kind: 'expired' as const }

      const session = await tx.userSession.findUnique({
        where: { id: locked.id },
        include: { user: true },
      })
      if (!session) return { kind: 'expired' as const }

      const now = new Date()
      if (session.revokedAt) return { kind: 'expired' as const }
      if (session.expiresAt <= now) return { kind: 'expired' as const }
      if (!session.user.isActive) return { kind: 'expired' as const }

      // §7.5's idle window applies here too. Previously refresh ignored it
      // entirely and unconditionally stamped lastSeenAt, so a session dormant
      // for days could be resurrected and the idle policy was decorative for
      // anyone holding a refresh token — including a thief.
      const idleMs = this.idleTtlFor(session.user.role as Role) * 1000
      if (now.getTime() - session.lastSeenAt.getTime() > idleMs) {
        await tx.userSession.update({
          where: { id: session.id },
          data: { revokedAt: now, revokedReason: 'idle_timeout' },
        })
        return { kind: 'expired' as const }
      }

      // Presented the previous token: only honour it inside the grace window.
      if (session.previousTokenHash === hash && session.refreshTokenHash !== hash) {
        const rotatedAt = session.rotatedAt?.getTime() ?? 0
        if (Date.now() - rotatedAt > ROTATION_GRACE_MS) {
          // Outside the window this is a replay of a superseded token. Kill the
          // session rather than serve it.
          await tx.userSession.update({
            where: { id: session.id },
            data: { revokedAt: now, revokedReason: 'token_replay' },
          })
          return { kind: 'replay' as const, sessionId: session.id, userId: session.userId }
        }
      }

      await tx.userSession.update({
        where: { id: session.id },
        data: {
          refreshTokenHash: nextHash,
          previousTokenHash: session.refreshTokenHash,
          rotatedAt: now,
          lastSeenAt: now,
          ipAddress: device.ipAddress ?? session.ipAddress,
          userAgent: device.userAgent ?? session.userAgent,
        },
      })

      return {
        kind: 'rotated' as const,
        sessionId: session.id,
        userId: session.userId,
        role: session.user.role as Role,
      }
    })

    if (outcome.kind === 'replay') {
      await this.store.delete(outcome.sessionId)
      // The strongest theft signal the system produces. It was previously
      // written to `revoked_reason` and never read by anything.
      await this.recordReplay(outcome.userId, outcome.sessionId)
      throw ApiError.sessionExpired()
    }
    if (outcome.kind === 'expired') throw ApiError.sessionExpired()

    const { sessionId, userId, role } = outcome
    const principal = await resolvePrincipal(this.prisma, userId, sessionId)
    if (!principal) throw ApiError.sessionExpired()

    // The role comes from the row just read under lock, so a demotion applies
    // to the token being minted rather than the one being replaced.
    await this.store.put(sessionId, principal, this.idleTtlFor(role))
    const accessToken = await this.tokens.signAccessToken({ sub: userId, role, sid: sessionId })

    return { sessionId, accessToken, refreshToken: nextToken, principal }
  }

  /**
   * Records a refresh-token replay.
   *
   * Detection already existed; nothing acted on it. A replay outside the grace
   * window means two parties hold the same token, which is the clearest
   * evidence of theft the system can produce — it belongs in the audit trail
   * where someone can see it, not only in a `revoked_reason` column.
   */
  private async recordReplay(userId: string, sessionId: string): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId,
          action: 'session.token_replay',
          entityType: 'user_session',
          entityId: sessionId,
        },
      })
    } catch {
      // Never let an audit write failure convert a correctly-refused refresh
      // into a 500 — the session is already revoked, which is the security
      // outcome that matters.
    }
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
    const where = {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}),
    }

    // Collect the ids BEFORE revoking, so the store cleanup targets exactly the
    // sessions this call ended.
    //
    // It previously re-queried afterwards for `revokedAt: { not: null }` — every
    // session the user had *ever* revoked, unbounded in time — and issued a
    // no-op write per row. Besides growing without limit, it was wrong for any
    // cache-backed store: the set it walked was only incidentally related to
    // what had just been revoked.
    const ending = await this.prisma.userSession.findMany({ where, select: { id: true } })

    await this.prisma.userSession.updateMany({
      where,
      data: { revokedAt: new Date(), revokedReason: reason },
    })

    if (exceptSessionId) {
      await Promise.all(ending.map((s) => this.store.delete(s.id)))
    } else {
      await this.store.deleteAllForUser(userId)
    }
  }
}
