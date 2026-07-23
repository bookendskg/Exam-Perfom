import { describe, it, expect } from 'vitest'
import { ADMIN_POLICY, STAFF_POLICY, validatePassword } from '@bookends/core/password/policy'
import { requirementsFor, scorePassword } from '../src/components/auth/PasswordStrength'

/**
 * The checklist must agree with the server, always.
 *
 * A checklist that disagrees is worse than none: it tells the user they have
 * satisfied every rule and the request then fails anyway, with no way to work
 * out which rule was actually broken. The defence against drift is that both
 * sides read the same policy object — these tests exist to prove that holds for
 * every rule, not merely that the import resolves.
 */

describe('the checklist matches the policy the API enforces', () => {
  const cases = [
    {
      role: 'admin' as const,
      policy: ADMIN_POLICY,
      passwords: ['', 'abc', 'abcdefgh', 'Abcdefgh', 'Abcdefg1', 'Str0ngPassword!'],
    },
    {
      role: 'staff' as const,
      policy: STAFF_POLICY,
      passwords: ['', 'abc', 'abcdef', 'Abc123', 'muchlongerpassword'],
    },
  ]

  for (const { role, policy, passwords } of cases) {
    for (const password of passwords) {
      it(`${role}: "${password}" — checklist and validatePassword agree`, () => {
        const unmet = requirementsFor(password, policy).filter((r) => !r.met).length
        const violations = validatePassword(password, role, 'newPassword').length

        // Same count, because the checklist enumerates exactly the rules the
        // policy imposes — no invented extras, none omitted.
        expect(unmet).toBe(violations)
      })
    }
  }
})

describe('the checklist only shows rules that exist', () => {
  it('does not ask staff for complexity the API never checks', () => {
    const labels = requirementsFor('abcdef', STAFF_POLICY).map((r) => r.label)

    // Staff passwords are 6 characters with no complexity requirement at all.
    // Showing an unticked "one uppercase letter" would invent a rule and make a
    // valid password look rejected.
    expect(labels).toEqual(['At least 6 characters'])
  })

  it('asks admins for all three', () => {
    const labels = requirementsFor('', ADMIN_POLICY).map((r) => r.label)
    expect(labels).toEqual(['At least 8 characters', 'One uppercase letter', 'One number'])
  })
})

describe('the strength meter never contradicts the checklist', () => {
  it('scores an empty password as nothing at all', () => {
    expect(scorePassword('', ADMIN_POLICY)).toBe(0)
  })

  it('caps at Weak while any requirement is unmet, however long', () => {
    // Twenty-six lowercase letters: long, but no uppercase and no number, so
    // the API rejects it. It must not be displayed as strong.
    const long = 'abcdefghijklmnopqrstuvwxyz'
    expect(requirementsFor(long, ADMIN_POLICY).some((r) => !r.met)).toBe(true)
    expect(scorePassword(long, ADMIN_POLICY)).toBe(1)
  })

  it('rewards length and variety once the rules are satisfied', () => {
    const minimal = scorePassword('Abcdefg1', ADMIN_POLICY)
    const longer = scorePassword('Abcdefg1xyz', ADMIN_POLICY)
    const varied = scorePassword('Abcdefg1xyz!@', ADMIN_POLICY)

    expect(minimal).toBeGreaterThanOrEqual(2)
    expect(longer).toBeGreaterThanOrEqual(minimal)
    expect(varied).toBeGreaterThanOrEqual(longer)
    expect(varied).toBeLessThanOrEqual(4)
  })

  it('never exceeds the top of the scale', () => {
    expect(scorePassword('A'.repeat(200) + '1b!', ADMIN_POLICY)).toBeLessThanOrEqual(4)
  })
})
