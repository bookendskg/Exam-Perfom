import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { ROLES, ADMIN_ROLES, isStaffRole } from '../roles.js'
import {
  validatePassword,
  policyForRole,
  defaultStaffPassword,
  generateAdminTempPassword,
  STAFF_POLICY,
  ADMIN_POLICY,
} from './policy.js'

describe('policyForRole (§7.3)', () => {
  it('gives staff the loose policy', () => {
    expect(policyForRole('staff')).toEqual(STAFF_POLICY)
    expect(STAFF_POLICY.minLength).toBe(6)
    expect(STAFF_POLICY.requireUppercase).toBe(false)
  })

  it('gives every non-staff role the admin policy', () => {
    for (const role of ADMIN_ROLES) {
      expect(policyForRole(role)).toEqual(ADMIN_POLICY)
    }
    expect(ADMIN_POLICY.minLength).toBe(8)
    expect(ADMIN_POLICY.requireUppercase).toBe(true)
    expect(ADMIN_POLICY.requireNumber).toBe(true)
  })

  it('covers every role in the enum', () => {
    for (const role of ROLES) {
      expect(policyForRole(role)).toBeDefined()
    }
  })
})

describe('validatePassword (§7.3)', () => {
  it('accepts a 6-char password with no complexity for staff', () => {
    expect(validatePassword('abcdef', 'staff')).toEqual([])
  })

  it('rejects a 5-char password for staff', () => {
    const violations = validatePassword('abcde', 'staff')
    expect(violations).toHaveLength(1)
    expect(violations[0]!.field).toBe('password')
  })

  it('rejects an 8-char admin password with no uppercase', () => {
    const violations = validatePassword('abcdefg1', 'admin')
    expect(violations.map((v) => v.message)).toContain(
      'Password must contain at least one uppercase letter'
    )
  })

  it('rejects an 8-char admin password with no number', () => {
    const violations = validatePassword('Abcdefgh', 'admin')
    expect(violations.map((v) => v.message)).toContain('Password must contain at least one number')
  })

  it('accepts a compliant admin password', () => {
    expect(validatePassword('Abcdefg1', 'admin')).toEqual([])
  })

  it('reports every violation at once rather than stopping at the first', () => {
    // §5.2's details[] is an array precisely so the client can show all of them.
    expect(validatePassword('abc', 'admin')).toHaveLength(3)
  })
})

describe('defaultStaffPassword (§7.3)', () => {
  it('is last-4-digits + "book"', () => {
    expect(defaultStaffPassword('9876543210')).toBe('3210book')
  })

  it('ignores punctuation and country-code formatting', () => {
    expect(defaultStaffPassword('+91 98765-43210')).toBe('3210book')
  })

  it('throws rather than emit a guessable short password', () => {
    expect(() => defaultStaffPassword('123')).toThrow()
  })

  it('satisfies the staff policy it is issued under', () => {
    // The canary. §7.3 sets both the default and the policy; this asserts they
    // actually agree for staff.
    expect(validatePassword(defaultStaffPassword('9876543210'), 'staff')).toEqual([])
  })

  it('DOCUMENTS the §7.3 self-contradiction: the default fails the admin policy', () => {
    // "3210book" has no uppercase, but §7.3 requires admins have one. This is a
    // real inconsistency in the spec, pending client sign-off. The test asserts
    // the contradiction exists so that if the spec is fixed, this fails loudly
    // and reminds us to revisit generateAdminTempPassword.
    const violations = validatePassword(defaultStaffPassword('9876543210'), 'admin')
    expect(violations.map((v) => v.message)).toContain(
      'Password must contain at least one uppercase letter'
    )
  })
})

describe('generateAdminTempPassword', () => {
  const rand = (n: number) => new Uint8Array(randomBytes(n))

  it('always satisfies the admin policy', () => {
    // Generated from random bytes, so run it enough times to catch a class that
    // only gets seeded by luck.
    for (let i = 0; i < 500; i++) {
      const pw = generateAdminTempPassword(rand)
      expect(validatePassword(pw, 'admin'), `failed for: ${pw}`).toEqual([])
    }
  })

  it('satisfies every admin role, not just "admin"', () => {
    for (const role of ROLES.filter((r) => !isStaffRole(r))) {
      expect(validatePassword(generateAdminTempPassword(rand), role)).toEqual([])
    }
  })

  it('excludes glyphs that get misread when spoken or typed', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateAdminTempPassword(rand)).not.toMatch(/[O0Il1]/)
    }
  })

  it('does not return the same password twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateAdminTempPassword(rand)))
    expect(seen.size).toBe(200)
  })
})
