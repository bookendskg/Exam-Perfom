import type { Principal, SessionStore } from './index.js'

interface Entry {
  principal: Principal
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
 * KNOWN DIVERGENCE from PostgresSessionStore: this caches the Principal handed
 * to `put`, whereas the Postgres store re-reads it from the database on every
 * `touch`. So a scope change (Outlet.managerId, Employee.outletId, User.role)
 * is visible immediately under Postgres but stale here until
 * `invalidatePrincipal` is called.
 *
 * That makes this store MORE permissive than production, which is the dangerous
 * direction for a test double — a denial that production would enforce can pass
 * unnoticed here. Any test asserting that a privilege was *revoked* must run
 * against the Postgres store; see buildTestApp({ SESSION_STORE: 'postgres' }).
 */
export class MemorySessionStore implements SessionStore {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  async put(sessionId: string, principal: Principal, ttlSeconds: number): Promise<void> {
    this.entries.set(sessionId, {
      principal,
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

    entry.expiresAtMs = this.now() + ttlSeconds * 1000
    return entry.principal
  }

  async delete(sessionId: string): Promise<void> {
    this.entries.delete(sessionId)
  }

  async deleteAllForUser(userId: string): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.principal.userId === userId) this.entries.delete(id)
    }
  }

  async invalidatePrincipal(userId: string): Promise<void> {
    // No cached copy to drop: the principal is re-read from this map on every
    // touch, and deleteAllForUser is the heavier hammer when scope moves.
    for (const [id, entry] of this.entries) {
      if (entry.principal.userId === userId) this.entries.delete(id)
    }
  }

  /** Test affordance — not part of the interface. */
  size(): number {
    return this.entries.size
  }
}
