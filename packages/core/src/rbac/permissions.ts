import type { Role } from '../roles.js'

/**
 * The §3.2 permission matrix.
 *
 * This file is a transcription of a table in the spec, and is deliberately
 * written to stay one — a non-engineer should be able to read it side by side
 * with §3.2 and spot a difference. Resist refactoring it into something clever.
 *
 * Scope meanings:
 *   all           — every record
 *   own_outlet    — records belonging to an outlet the user manages (§3.2 "Own outlet")
 *   own_resource  — only records the user created, or their own profile
 *   none          — denied outright
 */
export type Scope = 'all' | 'own_outlet' | 'own_resource' | 'none'

// prettier-ignore
// ^ The row-per-line table alignment IS the feature: it is what lets someone
//   read this side by side with §3.2 and spot a difference. Prettier would wrap
//   each row across six lines and destroy that.
export const PERMISSIONS = {
  // --- Employee Management (§3.2) -------------------------------------------
  'employee:create': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'none' },
  'employee:read':   { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'own_outlet', hr: 'all', staff: 'own_resource' },
  'employee:update': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'none' },
  'employee:delete': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'none' },
  'employee:photo:upload': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'own_resource' },

  // --- Question Bank (§3.2) -------------------------------------------------
  'question:create': { super_admin: 'all', admin: 'all', outlet_manager: 'all', trainer: 'all', hr: 'none', staff: 'none' },
  'question:read':   { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'own_outlet', hr: 'none', staff: 'none' },
  'question:update': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'own_resource', hr: 'none', staff: 'none' },
  'question:delete': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'own_resource', hr: 'none', staff: 'none' },
  'question:approve': { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },
  'question:import':  { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },

  // --- Exam Builder (§3.2) --------------------------------------------------
  'exam_template:create': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'none', staff: 'none' },
  'exam:schedule':        { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'none', staff: 'none' },
  'exam:override_schedule': { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },

  // --- Exam Taking (§3.2) — staff only --------------------------------------
  'exam:take':        { super_admin: 'none', admin: 'none', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'all' },
  'result:read_own':  { super_admin: 'none', admin: 'none', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'own_resource' },

  // --- Grading (§3.2) -------------------------------------------------------
  'grading:theory':      { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'all', hr: 'none', staff: 'none' },
  'grading:video_image': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'all', hr: 'none', staff: 'none' },
  'grading:override':    { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },

  // --- Reports & Analytics (§3.2) -------------------------------------------
  'report:read':          { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'none' },
  'report:export':        { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'none' },
  'performance:read_own': { super_admin: 'none', admin: 'none', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'own_resource' },

  // --- System Settings (§3.2) -----------------------------------------------
  'outlet:manage':      { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },
  'department:manage':  { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },
  'designation:manage': { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },
  'role:manage':        { super_admin: 'all', admin: 'none', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },
  'audit_log:read':     { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },

  // --- Rewards & Training (§3.2) --------------------------------------------
  'reward:assign':            { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'all', hr: 'none', staff: 'none' },
  'training:assign':          { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'all', hr: 'none', staff: 'none' },
  'supervisor_remark:create': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'all', hr: 'none', staff: 'none' },
} as const satisfies Record<string, Record<Role, Scope>>
// ^ `satisfies Record<string, Record<Role, Scope>>` is load-bearing: it forces
//   every role to appear on every row. You cannot forget `hr` on a new
//   permission, and adding a role to the enum breaks the build until every row
//   accounts for it. That exhaustiveness is the whole reason this is a table.

export type Permission = keyof typeof PERMISSIONS

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[]

/** The scope a role has for a permission. `none` means denied. */
export function permissionScope(role: Role, permission: Permission): Scope {
  return PERMISSIONS[permission][role]
}

export function isAllowed(role: Role, permission: Permission): boolean {
  return permissionScope(role, permission) !== 'none'
}
