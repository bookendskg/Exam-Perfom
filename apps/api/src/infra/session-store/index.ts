import type { PrismaClient } from '@bookends/db'
import type { Role } from '@bookends/core'
import type { Config } from '../../config/env.js'
import { MemorySessionStore } from './memory-store.js'
import { PostgresSessionStore } from './postgres-store.js'

/**
 * The cached authorisation context for a live session.
 *
 * This rides on the session record rather than the JWT. §7.5's idle timeout
 * already forces a store round trip on every authenticated request, so putting
 * scope here costs nothing extra — and unlike a 15-minute JWT claim, it cannot
 * carry privileges that were revoked 14 minutes ago.
 */
export interface Principal {
  userId: string
  role: Role
  sessionId: string
  /** null for a User with no Employee row — e.g. the seeded super admin. */
  employeeId: string | null
  /** Where the employee works. For display and defaults, NOT for authorisation. */
  outletId: string | null
  departmentId: string | null
  /** Authoritative outlet_manager scope, from Outlet.managerId. May be empty. */
  managedOutletIds: string[]
  mustChangePassword: boolean
}

export interface SessionStore {
  /** Creates or replaces a session entry with an idle TTL. */
  put(sessionId: string, principal: Principal, ttlSeconds: number): Promise<void>
  /**
   * Reads a session and extends its idle window in one operation. Returns null
   * when the session is unknown, revoked, expired, or idled out — the caller
   * treats all four identically (401 SESSION_EXPIRED).
   */
  touch(sessionId: string, ttlSeconds: number): Promise<Principal | null>
  delete(sessionId: string): Promise<void>
  deleteAllForUser(userId: string): Promise<void>
  /** Drops cached principals so the next request re-resolves scope from the DB. */
  invalidatePrincipal(userId: string): Promise<void>
}

export function createSessionStore(config: Config, prisma: PrismaClient): SessionStore {
  return config.SESSION_STORE === 'memory'
    ? new MemorySessionStore()
    : new PostgresSessionStore(prisma)
}

export { MemorySessionStore } from './memory-store.js'
export { PostgresSessionStore } from './postgres-store.js'
