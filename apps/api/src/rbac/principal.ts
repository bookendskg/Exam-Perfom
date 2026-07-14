import type { PrismaClient } from '@bookends/db'
import type { Role } from '@bookends/core'
import type { Principal } from '../infra/session-store/index.js'

/**
 * Resolves the authorisation context for a user.
 *
 * The outlet_manager scope comes from Outlet.managerId, NOT Employee.outletId.
 * These are different facts: outletId is where someone *works*, managerId is
 * what they *manage*. Unioning them would silently couple permissions to HR
 * data entry — transferring a manager's posting would change what they can
 * touch, with nothing in the audit trail saying permissions changed.
 *
 * The schema allows one manager to hold several outlets, so the scope is a list.
 */
export async function resolvePrincipal(
  prisma: PrismaClient,
  userId: string,
  sessionId: string
): Promise<Principal | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      employee: { select: { id: true, outletId: true, departmentId: true } },
      outletsManaged: { where: { isActive: true }, select: { id: true } },
    },
  })

  if (!user || !user.isActive) return null

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

/**
 * Logs outlet_managers who manage no outlet. Their scope is empty, so every
 * scoped query returns nothing and they appear to have a broken account. Module
 * 2 should reject the role assignment outright; until then, surface it at boot.
 */
export async function warnOrphanedManagers(prisma: PrismaClient): Promise<string[]> {
  const orphans = await prisma.user.findMany({
    where: { role: 'outlet_manager', isActive: true, outletsManaged: { none: {} } },
    select: { id: true, phone: true },
  })
  return orphans.map((o) => o.phone)
}
