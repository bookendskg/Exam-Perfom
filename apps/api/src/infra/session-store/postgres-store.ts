import type { PrismaClient } from '@bookends/db'
import type { Principal, SessionStore } from './index.js'
import { resolveSessionPrincipal } from '../../rbac/principal.js'

/**
 * Postgres-backed session store.
 *
 * §7.5 specifies Redis. Redis is deferred — this deployment has none, and at
 * ~300 staff the load is nowhere near needing it. The SessionStore interface
 * exists so a Redis implementation drops in later without touching callers.
 * (§2.1's BullMQ will force Redis in at Module 6 regardless.)
 */
const LAST_SEEN_THROTTLE_MS = 60_000

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The session row is written by session.service during login; this only
   * refreshes the idle window, so `put` is a no-op beyond ensuring the row's
   * clock starts now.
   */
  async put(sessionId: string, _principal: Principal, _ttlSeconds: number): Promise<void> {
    // `updateMany`, not `update`: the latter throws P2025 when the row is gone,
    // which would surface as a bare 404 from a *login*. The principal is not
    // stored — `touch` re-reads it — so this only starts the idle clock.
    await this.prisma.userSession.updateMany({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() },
    })
  }

  async touch(sessionId: string, ttlSeconds: number): Promise<Principal | null> {
    const resolved = await resolveSessionPrincipal(this.prisma, sessionId)
    if (!resolved) return null

    const { principal, lastSeenAt } = resolved

    // Idle timeout (§7.5): last activity older than the role's window ends it.
    const idleDeadline = new Date(Date.now() - ttlSeconds * 1000)
    if (lastSeenAt <= idleDeadline) {
      await this.prisma.userSession.update({
        where: { id: sessionId },
        data: { revokedAt: new Date(), revokedReason: 'idle_timeout' },
      })
      return null
    }

    // Throttled: writing lastSeenAt on every request would be a row write per
    // API call for no benefit, since the idle window is measured in minutes.
    const now = Date.now()
    if (now - lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await this.prisma.userSession.update({
        where: { id: sessionId },
        data: { lastSeenAt: new Date(now) },
      })
    }

    return principal
  }

  async delete(sessionId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    })
  }

  async deleteAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        // Here the "store entry" and the session row are the same thing, so an
        // unfiltered revoke would kill a session the caller means to keep.
        ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: 'admin_revoke' },
    })
  }

  async invalidatePrincipal(_userId: string): Promise<void> {
    // Nothing to do: `touch` reads the principal from the database on every
    // request, so scope is never cached and never stale. This method exists for
    // the Redis implementation, where it will drop the cached copy.
  }
}
