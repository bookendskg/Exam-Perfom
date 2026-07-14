import { describe, it, expect } from 'vitest'
import { ROLES } from '../roles.js'
import { PERMISSIONS, PERMISSION_KEYS, permissionScope, isAllowed } from './permissions.js'

describe('permission matrix shape', () => {
  it('defines every role on every permission', () => {
    // The `satisfies` clause enforces this at compile time; this asserts it at
    // runtime too, so a hand-edit that slips past a stale build still fails.
    for (const permission of PERMISSION_KEYS) {
      for (const role of ROLES) {
        expect(PERMISSIONS[permission][role], `${permission} is missing ${role}`).toBeDefined()
      }
    }
  })

  it('only gives own_outlet to roles that can actually hold an outlet', () => {
    /**
     * `own_outlet` resolves from Outlet.managerId, which only an outlet_manager
     * is ever assigned. Granting it to any other role produces an ALWAYS-EMPTY
     * scope — every query returns nothing and every write 403s, so the role
     * looks broken rather than restricted.
     *
     * That is not hypothetical: §3.2 asks for trainer = "Own outlet", and
     * transcribing it literally made trainers a dead role until this caught it.
     * If another role should genuinely be outlet-scoped, it needs a way to be
     * linked to outlets first.
     */
    const CAN_HOLD_OUTLETS = new Set<string>(['outlet_manager'])

    for (const permission of PERMISSION_KEYS) {
      for (const role of ROLES) {
        if (PERMISSIONS[permission][role] !== 'own_outlet') continue
        expect(
          CAN_HOLD_OUTLETS.has(role),
          `"${permission}" gives ${role} own_outlet scope, but ${role} is never assigned as ` +
            `Outlet.managerId — their scope would always be empty and the permission dead.`
        ).toBe(true)
      }
    }
  })

  it('uses only valid scope values', () => {
    const valid = new Set(['all', 'own_outlet', 'own_resource', 'none'])
    for (const permission of PERMISSION_KEYS) {
      for (const role of ROLES) {
        expect(valid.has(PERMISSIONS[permission][role])).toBe(true)
      }
    }
  })
})

describe('§3.2 matrix transcription', () => {
  it('lets only staff take exams', () => {
    expect(permissionScope('staff', 'exam:take')).toBe('all')
    for (const role of ROLES.filter((r) => r !== 'staff')) {
      expect(isAllowed(role, 'exam:take'), `${role} must not take exams`).toBe(false)
    }
  })

  it('lets only super_admin manage roles', () => {
    expect(permissionScope('super_admin', 'role:manage')).toBe('all')
    for (const role of ROLES.filter((r) => r !== 'super_admin')) {
      expect(isAllowed(role, 'role:manage'), `${role} must not manage roles`).toBe(false)
    }
  })

  it('lets only super_admin and admin approve questions', () => {
    expect(isAllowed('super_admin', 'question:approve')).toBe(true)
    expect(isAllowed('admin', 'question:approve')).toBe(true)
    for (const role of ROLES.filter((r) => r !== 'super_admin' && r !== 'admin')) {
      expect(isAllowed(role, 'question:approve'), `${role} must not approve`).toBe(false)
    }
  })

  it('scopes a trainer to their own questions but not employees', () => {
    expect(permissionScope('trainer', 'question:update')).toBe('own_resource')
    expect(permissionScope('trainer', 'question:delete')).toBe('own_resource')
    expect(permissionScope('trainer', 'employee:update')).toBe('none')
  })

  it('scopes an outlet_manager to their own outlet for employees', () => {
    expect(permissionScope('outlet_manager', 'employee:create')).toBe('own_outlet')
    expect(permissionScope('outlet_manager', 'employee:update')).toBe('own_outlet')
    expect(permissionScope('outlet_manager', 'employee:delete')).toBe('own_outlet')
    expect(permissionScope('outlet_manager', 'report:read')).toBe('own_outlet')
  })

  it('denies an outlet_manager the admin-only overrides', () => {
    expect(isAllowed('outlet_manager', 'grading:override')).toBe(false)
    expect(isAllowed('outlet_manager', 'exam:override_schedule')).toBe(false)
    expect(isAllowed('outlet_manager', 'question:approve')).toBe(false)
    expect(isAllowed('outlet_manager', 'audit_log:read')).toBe(false)
    expect(isAllowed('outlet_manager', 'outlet:manage')).toBe(false)
  })

  it('gives hr employees and reports but nothing in the question bank', () => {
    expect(permissionScope('hr', 'employee:create')).toBe('all')
    expect(permissionScope('hr', 'report:export')).toBe('all')
    expect(isAllowed('hr', 'question:create')).toBe(false)
    expect(isAllowed('hr', 'question:approve')).toBe(false)
    expect(isAllowed('hr', 'grading:theory')).toBe(false)
  })

  it('restricts staff to their own records', () => {
    expect(permissionScope('staff', 'employee:read')).toBe('own_resource')
    expect(permissionScope('staff', 'result:read_own')).toBe('own_resource')
    expect(permissionScope('staff', 'performance:read_own')).toBe('own_resource')
    expect(permissionScope('staff', 'employee:photo:upload')).toBe('own_resource')
    // §3.2: staff cannot view "all reports" — only their own performance.
    expect(isAllowed('staff', 'report:read')).toBe(false)
  })

  it('never grants staff a write outside their own resources', () => {
    /**
     * Staff may hold 'all' scope on exactly these, and each needs a reason.
     * Anything else reaching 'all' is a privilege widening that should be
     * argued for here rather than slipped into the matrix.
     */
    const STAFF_MAY_HAVE_ALL = new Set<string>([
      // §3.2 — taking exams is the staff role's entire purpose.
      'exam:take',
      // Reference data. A staff member's own profile shows their outlet and
      // designation names, so withholding these breaks the app while
      // protecting nothing. All three are read-only.
      'outlet:read',
      'department:read',
      'designation:read',
    ])

    for (const permission of PERMISSION_KEYS) {
      const scope = permissionScope('staff', permission)
      expect(['none', 'own_resource', 'all'].includes(scope)).toBe(true)
      if (scope === 'all') {
        expect(
          STAFF_MAY_HAVE_ALL.has(permission),
          `staff were granted 'all' on "${permission}". If that is intended, add it to ` +
            `STAFF_MAY_HAVE_ALL with a reason; otherwise this is a privilege escalation.`
        ).toBe(true)
      }
    }
  })

  it('never grants staff anything beyond read on the org structure', () => {
    // The read grants above must not become a foothold: staff must still be
    // unable to change any of it.
    for (const permission of [
      'outlet:manage',
      'department:manage',
      'designation:manage',
    ] as const) {
      expect(isAllowed('staff', permission)).toBe(false)
    }
    // Outlet performance figures are NOT reference data — §3.2's reports row
    // governs them.
    expect(isAllowed('staff', 'outlet:stats')).toBe(false)
    expect(isAllowed('trainer', 'outlet:stats')).toBe(false)
  })

  it('gives super_admin at least as much as admin everywhere except exam-taking', () => {
    const rank = { none: 0, own_resource: 1, own_outlet: 2, all: 3 } as const
    for (const permission of PERMISSION_KEYS) {
      if (permission === 'exam:take') continue
      expect(
        rank[permissionScope('super_admin', permission)],
        `admin outranks super_admin on ${permission}`
      ).toBeGreaterThanOrEqual(rank[permissionScope('admin', permission)])
    }
  })
})
