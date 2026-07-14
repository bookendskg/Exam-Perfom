/**
 * Roles, per §3.1. Declared here rather than imported from @bookends/db so that
 * this package stays dependency-free — the seed in @bookends/db imports the
 * hasher from here, so a dependency the other way would be a cycle.
 *
 * A compile-time parity check in apps/api asserts this matches the Prisma
 * `Role` enum; the build fails if the two ever drift.
 */
export const ROLES = ['super_admin', 'admin', 'outlet_manager', 'trainer', 'hr', 'staff'] as const

export type Role = (typeof ROLES)[number]

/**
 * "Admin roles" per §7.3 and §7.5 — both sections use the phrase without ever
 * defining it. Resolved here, once: everything that is not staff.
 *
 * This reading follows §7.5, which splits the world into "staff" (single
 * session, 30-min idle) and everything else (multi-session, 2-hour idle).
 * Pending client sign-off; if they mean only super_admin + admin, this constant
 * is the single place to change.
 */
export const ADMIN_ROLES: readonly Role[] = ROLES.filter((r) => r !== 'staff')

export function isStaffRole(role: Role): boolean {
  return role === 'staff'
}

export function isAdminRole(role: Role): boolean {
  return !isStaffRole(role)
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}
