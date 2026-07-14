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
    for (const permission of PERMISSION_KEYS) {
      const scope = permissionScope('staff', permission)
      expect(['none', 'own_resource', 'all'].includes(scope)).toBe(true)
      // 'all' for staff is only legitimate on exam:take.
      if (scope === 'all') expect(permission).toBe('exam:take')
    }
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
