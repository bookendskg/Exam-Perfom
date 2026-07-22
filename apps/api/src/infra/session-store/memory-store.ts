import type { Principal, SessionStore } from './index.js'

/** Resolves the live principal for a session, or null if it is unusable. */
export type PrincipalResolver = (sessionId: string) => Promise<Principal | null>

interface Entry {
  /** Membership only, so deleteAllForUser can find its sessions. Not authority. */
  userId: string
  expiresAtMs: number
}

/**
 * In-process session store for tests and single-process development.
 *
 * The injectable clock is the point: §7.5's idle timeouts are 30 minutes and 2
 * hours, and no test suite can afford to wait them out. Tests advance `now`
 * instead.
 *
 * Never used in production — config/env.ts refuses to boot with it there,
 * because it is per-process (two instances disagree) and non-durable (a restart
 * logs everyone out).
 *
 * What this store owns is the IDLE CLOCK, and nothing else. Role, scope and
 * session validity are resolved from the database on every `touch`, exactly as
 * PostgresSessionStore does.
 *
 * It did not always work that way. This store used to cache the whole Principal
 * handed to `put`, which made it *more permissive than production* — a
 * privilege that production revokes immediately stayed live here until TTL
 * lapse. That is the wrong direction for a test double: it hides denials rather
 * than surfacing them, and it is precisely what let a staff-login regression
 * pass 541 green tests (see test/session-postgres.test.ts). Caching removed.
 */
export class MemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly resolve: PrincipalResolver,
    private readonly now: () => number = () => Date.now()
  ) {}

  async put(sessionId: string, principal: Principal, ttlSeconds: number): Promise<void> {
    this.entries.set(sessionId, {
      userId: principal.userId,
      expiresAtMs: this.now() + ttlSeconds * 1000,
    })
  }

  async touch(sessionId: string, ttlSeconds: number): Promise<Principal | null> {
    const entry = this.entries.get(sessionId)
    if (!entry) return null

    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(sessionId)
      return null
    }

    // The database, not the map, decides whether this session is still usable
    // and what it is allowed to do.
    const principal = await this.resolve(sessionId)
    if (!principal) {
      this.entries.delete(sessionId)
      return null
    }

    entry.expiresAtMs = this.now() + ttlSeconds * 1000
    return principal
  }

  async delete(sessionId: string): Promise<void> {
    this.entries.delete(sessionId)
  }

  async deleteAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (id === exceptSessionId) continue
      if (entry.userId === userId) this.entries.delete(id)
    }
  }

  async invalidatePrincipal(_userId: string): Promise<void> {
    // Nothing to drop: `touch` re-reads the principal for every request, so
    // scope is never cached here and can never be stale.
  }

  /** Test affordance — not part of the interface. */
  size(): number {
    return this.entries.size
  }
}
