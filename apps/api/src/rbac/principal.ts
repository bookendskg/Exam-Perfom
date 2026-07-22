import type { PrismaClient } from '@bookends/db'
import type { Role } from '@bookends/core'
import type { Principal } from '../infra/session-store/index.js'

/**
 * The one definition of what a Principal is read from.
 *
 * This used to be written twice — once here and once, by hand, inside
 * PostgresSessionStore.touch. Two copies of an authorisation projection is a
 * standing invitation for them to drift: add a scope axis to one and the other
 * silently keeps handing out the old shape. Both now share this include and the
 * mapper below.
 */
export const PRINCIPAL_USER_INCLUDE = {
  employee: { select: { id: true, outletId: true, departmentId: true } },
  outletsManaged: { where: { isActive: true }, select: { id: true } },
} as const

/**
 * The shape `PRINCIPAL_USER_INCLUDE` produces.
 *
 * Declared structurally rather than with Prisma's generated payload types so
 * that both call sites — one selecting a User, one selecting a Session's nested
 * user — satisfy it without contortions.
 */
export interface UserWithScope {
  id: string
  role: string
  isActive: boolean
  mustChangePassword: boolean
  employee: { id: string; outletId: string; departmentId: string | null } | null
  outletsManaged: Array<{ id: string }>
}

/**
 * Builds the authorisation context for a user.
 *
 * The outlet_manager scope comes from Outlet.managerId, NOT Employee.outletId.
 * These are different facts: outletId is where someone *works*, managerId is
 * what they *manage*. Unioning them would silently couple permissions to HR
 * data entry — transferring a manager's posting would change what they can
 * touch, with nothing in the audit trail saying permissions changed.
 *
 * The schema allows one manager to hold several outlets, so the scope is a list.
 */
export function toPrincipal(user: UserWithScope, sessionId: string): Principal {
  return {
    userId: user.id,
    role: user.role as Role,
    sessionId,
    // Null for a User with no Employee — the seeded super admin is exactly this.
    employeeId: user.employee?.id ?? null,
    outletId: user.employee?.outletId ?? null,
    departmentId: user.employee?.departmentId ?? null,
    managedOutletIds: user.outletsManaged.map((o) => o.id),
    mustChangePassword: user.mustChangePassword,
  }
}

/** Resolves a principal by user id. Used at login and refresh, where there is no session row to read yet. */
export async function resolvePrincipal(
  prisma: PrismaClient,
  userId: string,
  sessionId: string
): Promise<Principal | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: PRINCIPAL_USER_INCLUDE,
  })

  if (!user || !user.isActive) return null
  return toPrincipal(user, sessionId)
}

/**
 * Resolves a principal by session id, validating the session itself.
 *
 * This is the per-request authority: it re-reads role and scope from the
 * database on every call, so a revoked privilege stops working on the next
 * request rather than when a 15-minute token happens to expire.
 *
 * Returns null — never throws — for every unusable state, because the caller
 * deliberately treats unknown, revoked, expired and deactivated identically
 * (§7.5). Distinguishing them to the client would leak whether a session id is
 * real.
 */
export async function resolveSessionPrincipal(
  prisma: PrismaClient,
  sessionId: string
): Promise<{ principal: Principal; lastSeenAt: Date } | null> {
  const session = await prisma.userSession.findUnique({
    where: { id: sessionId },
    include: { user: { include: PRINCIPAL_USER_INCLUDE } },
  })

  if (!session) return null
  if (session.revokedAt) return null
  if (session.expiresAt <= new Date()) return null
  if (!session.user.isActive) return null

  return { principal: toPrincipal(session.user, session.id), lastSeenAt: session.lastSeenAt }
}

// `warnOrphanedManagers` lived here, claiming in its own comment to "surface it
// at boot". It was never called from anywhere. The condition it looked for — an
// outlet_manager who manages no outlet — is already reported where it actually
// matters: requirePermission returns an explanatory 403 naming the problem the
// moment such an account touches a scoped route. Removed rather than wired up,
// because a boot-time log nobody reads is not a second line of defence.
