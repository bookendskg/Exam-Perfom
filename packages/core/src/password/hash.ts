import { hash, verify } from '@node-rs/argon2'

/**
 * Argon2id. Spelled as a literal because @node-rs/argon2 declares `Algorithm`
 * as an ambient `const enum`, which cannot be dereferenced under
 * `verbatimModuleSyntax`. The hash.test.ts assertion that output starts with
 * `$argon2id$` is what actually pins this value — it fails loudly if the
 * library ever renumbers.
 */
const ARGON2ID = 2

/**
 * Password hashing, per §7.3.
 *
 * argon2id at OWASP's recommended parameters. This matters more here than in a
 * typical system: staff passwords are 6 characters with no complexity rules and
 * default to a derivative of a publicly-known phone number, so the KDF is doing
 * nearly all of the work.
 *
 * Output is a standard PHC string (~96 chars), which fits users.password_hash
 * VARCHAR(255) with room to spare.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // 19 MiB — OWASP minimum
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS)
}

/**
 * Verifies a password against a stored hash. Never throws on a malformed or
 * foreign-format hash — returns false, so a bad row in the database is a failed
 * login rather than a 500.
 */
export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, ARGON2_OPTIONS)
  } catch {
    return false
  }
}

/**
 * A precomputed hash of a value nobody knows, used to burn the same CPU time on
 * a login for a phone number that does not exist.
 *
 * Without this, "unknown phone" returns in ~1ms while "wrong password" takes
 * ~50ms, and the difference enumerates which of the 300 staff phone numbers are
 * registered. Computed once at module load.
 */
let dummyHashPromise: Promise<string> | null = null

export function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hash('bookends-nonexistent-user-timing-equalizer', ARGON2_OPTIONS)
  return dummyHashPromise
}

/**
 * Burns hashing time for a user that does not exist, so login response timing
 * does not leak account existence. Always returns false.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  await verifyPassword(plain, await getDummyHash())
  return false
}
