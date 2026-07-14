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

/**
 * TRAINER SCOPE — a deliberate deviation from §3.2. Needs client sign-off.
 *
 * §3.2 gives `trainer` "Own outlet" on employee and question reads. That scope
 * is not implementable as written:
 *
 *  - `own_outlet` resolves from `Outlet.managerId`, which only an
 *    outlet_manager ever holds. A trainer's managedOutletIds is therefore
 *    ALWAYS empty, so "own outlet" means ∅ and the trainer gets 403 on
 *    everything — a dead role, exactly like outlet_manager was before Module 3.
 *  - The obvious alternative — resolving a trainer's outlet from
 *    `Employee.outletId` — contradicts §3.1, which says "Trainer can belong to
 *    multiple outlets". Employee.outletId is singular, and §4.1 has no
 *    trainer↔outlets table to express the plural.
 *
 * So §3.1 and §3.2 disagree, and §4.1 cannot model either reading. Until that
 * is resolved, trainers get 'all' on reads: they author questions across the
 * bank and grade theory answers, so seeing the content is inherent to the job,
 * and a working role beats a dead one. Their WRITES stay 'own_resource'
 * (§3.2's "Own questions"), which is the restriction that actually matters.
 *
 * To narrow this properly, §4.1 needs a trainer_outlets join table.
 */

// prettier-ignore
// ^ The row-per-line table alignment IS the feature: it is what lets someone
//   read this side by side with §3.2 and spot a difference. Prettier would wrap
//   each row across six lines and destroy that.
export const PERMISSIONS = {
  // --- Employee Management (§3.2) -------------------------------------------
  'employee:create': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'none' },
  // trainer is 'all', not §3.2's "Own outlet" — see TRAINER SCOPE below.
  'employee:read':   { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'all', hr: 'all', staff: 'own_resource' },
  'employee:update': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'none' },
  'employee:delete': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'none' },
  'employee:photo:upload': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'own_resource' },

  // --- Question Bank (§3.2) -------------------------------------------------
  'question:create': { super_admin: 'all', admin: 'all', outlet_manager: 'all', trainer: 'all', hr: 'none', staff: 'none' },
  'question:read':   { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'all', hr: 'none', staff: 'none' },
  'question:update': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'own_resource', hr: 'none', staff: 'none' },
  'question:delete': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'own_resource', hr: 'none', staff: 'none' },
  'question:approve': { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },
  'question:import':  { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },

  // --- Topics & source documents (§10) --------------------------------------
  // Not a separate §3.2 row: topics and source documents are the question
  // bank's structure, so they follow the question-bank rows. Reads go to
  // whoever can author questions; writes to whoever can edit them. Staff and hr
  // are excluded — §3.2 gives them nothing in the question bank.
  'topic:read':           { super_admin: 'all', admin: 'all', outlet_manager: 'all', trainer: 'all', hr: 'none', staff: 'none' },
  'topic:manage':         { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'none', staff: 'none' },
  'source_document:read': { super_admin: 'all', admin: 'all', outlet_manager: 'all', trainer: 'all', hr: 'none', staff: 'none' },
  'source_document:manage': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'none', staff: 'none' },

  // --- Exam Builder (§3.2) --------------------------------------------------
  'exam_template:create': { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'none', staff: 'none' },
  'exam:schedule':        { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'none', staff: 'none' },
  'exam:override_schedule': { super_admin: 'all', admin: 'all', outlet_manager: 'none', trainer: 'none', hr: 'none', staff: 'none' },

  // Not a §3.2 row. Reading an exam's definition follows its scheduling row —
  // whoever may schedule an exam may see one. Trainers are included because
  // they grade its responses (§3.2 grading rows) and hr because they own
  // reporting. Staff read exams through /staff/*, never here: this exposes the
  // question set, which would be the answer key.
  'exam:read':            { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'all', hr: 'all', staff: 'none' },
  'exam_template:read':   { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'none', staff: 'none' },

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

  // --- Organisational reads -------------------------------------------------
  // NOT in §3.2, which only specifies "Manage outlets/departments/designations".
  // Reading them is granted to every role because the data is unavoidable: a
  // staff member's profile shows their outlet name, and every create form needs
  // department and designation dropdowns. Withholding it would break the app
  // without protecting anything — this is reference data, not a secret.
  // Flag for client confirmation.
  'outlet:read':        { super_admin: 'all', admin: 'all', outlet_manager: 'all', trainer: 'all', hr: 'all', staff: 'all' },
  'department:read':    { super_admin: 'all', admin: 'all', outlet_manager: 'all', trainer: 'all', hr: 'all', staff: 'all' },
  'designation:read':   { super_admin: 'all', admin: 'all', outlet_manager: 'all', trainer: 'all', hr: 'all', staff: 'all' },
  // Outlet performance figures ARE sensitive — §3.2's "View all reports" row
  // governs these, so they follow it exactly rather than outlet:read.
  'outlet:stats':       { super_admin: 'all', admin: 'all', outlet_manager: 'own_outlet', trainer: 'none', hr: 'all', staff: 'none' },

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
