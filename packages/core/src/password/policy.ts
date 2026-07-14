import { isStaffRole, type Role } from '../roles.js'

/**
 * Password policy, per §7.3.
 *
 * Staff are hospitality workers, not tech users — the spec deliberately keeps
 * their rules loose (6 chars, no complexity). Admin roles get 8 chars plus one
 * uppercase and one number.
 */
export interface PasswordPolicy {
  minLength: number
  requireUppercase: boolean
  requireNumber: boolean
}

export const STAFF_POLICY: PasswordPolicy = {
  minLength: 6,
  requireUppercase: false,
  requireNumber: false,
}

export const ADMIN_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUppercase: true,
  requireNumber: true,
}

export function policyForRole(role: Role): PasswordPolicy {
  return isStaffRole(role) ? STAFF_POLICY : ADMIN_POLICY
}

export interface PolicyViolation {
  field: string
  message: string
}

/**
 * Returns [] when the password satisfies the role's policy. The shape matches
 * the §5.2 error `details[]` array so violations pass straight through.
 */
export function validatePassword(password: string, role: Role): PolicyViolation[] {
  const policy = policyForRole(role)
  const violations: PolicyViolation[] = []
  const field = 'password'

  if (password.length < policy.minLength) {
    violations.push({
      field,
      message: `Password must be at least ${policy.minLength} characters`,
    })
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    violations.push({ field, message: 'Password must contain at least one uppercase letter' })
  }
  if (policy.requireNumber && !/[0-9]/.test(password)) {
    violations.push({ field, message: 'Password must contain at least one number' })
  }

  return violations
}

/**
 * The §7.3 default password: last 4 digits of the phone number + "book".
 *
 * NOTE — §7.3 contradicts itself here. This produces e.g. "3210book", which has
 * no uppercase letter and so FAILS the same section's admin policy. It is valid
 * for staff only, which is why `defaultPasswordForRole` refuses to hand it to an
 * admin role. Awaiting client sign-off; see the plan's inconsistency #3.
 */
export function defaultStaffPassword(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) {
    throw new Error('Cannot derive a default password from a phone number with fewer than 4 digits')
  }
  return `${digits.slice(-4)}book`
}

/**
 * A random password that satisfies the admin policy. Used for non-staff roles,
 * where §7.3's `last4 + "book"` default would violate §7.3's own complexity rule.
 * Surfaced once to whoever created the account, never stored in plaintext.
 */
export function generateAdminTempPassword(randomBytes: (n: number) => Uint8Array): string {
  // Ambiguous glyphs (O/0, I/l/1) are excluded: these get read aloud and typed
  // on phone keyboards by people who did not choose them.
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const all = upper + lower + digits

  const bytes = randomBytes(16)
  const pick = (alphabet: string, byte: number) => alphabet[byte % alphabet.length]!

  // Seed one of each required class, then fill; shuffle so the classes are not
  // always in the same positions.
  const chars = [
    pick(upper, bytes[0]!),
    pick(digits, bytes[1]!),
    ...Array.from(bytes.slice(2, 12), (b) => pick(all, b)),
  ]

  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[12 + (i % 4)]! % (i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }

  const password = chars.join('')
  // Fail loudly rather than issue a password the login endpoint would reject.
  if (!/[A-Z]/.test(password) || !/[0-9]/.test(password) || password.length < 8) {
    throw new Error('Generated temp password failed the admin policy')
  }
  return password
}
