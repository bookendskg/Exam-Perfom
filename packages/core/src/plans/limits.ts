/**
 * Plan limit arithmetic (SaaS §4.3).
 *
 * Pure, and here rather than in the API, for one reason: NULL means unlimited,
 * and JavaScript disagrees. `count >= null` is `count >= 0`, which is `true` —
 * so the obvious one-liner
 *
 *   if (current >= plan.maxEmployees) throw   // WRONG
 *
 * blocks *everything* on an unlimited plan while passing every test written
 * against a plan that has a number. That bug would sail through Starter's
 * fixtures and brick Enterprise, and Professional too (its maxExamsPerMonth is
 * null). One function, one null check, unit-tested — nowhere else may compare a
 * limit to a count.
 */

/** A plan's ceiling for some resource. `null` is unlimited; `0` is a real zero. */
export type PlanLimit = number | null

export interface LimitVerdict {
  allowed: boolean
  /** null when the plan is unlimited — callers must not render "of null". */
  limit: number | null
  current: number
  /** How many the caller wants to add. */
  adding: number
}

/**
 * Decides whether `adding` more of something fits under `limit`.
 *
 * `adding` is explicit and not defaulted at the call site by accident: a bulk
 * import of 30 rows against a 50-seat plan with 30 used must fail as one
 * decision, not discover it on row 21.
 */
export function checkLimit(limit: PlanLimit, current: number, adding = 1): LimitVerdict {
  // Unlimited. Checked first and by identity, not truthiness — `0` is a
  // legitimate ceiling (a plan that permits none of something), and `!limit`
  // would silently promote it to unlimited.
  if (limit === null || limit === undefined) {
    return { allowed: true, limit: null, current, adding }
  }

  return { allowed: current + adding <= limit, limit, current, adding }
}

/**
 * How many more will fit. `Infinity` on an unlimited plan.
 *
 * Clamped at zero: a tenant sitting above its ceiling after a downgrade has
 * negative headroom in the arithmetic sense, and reporting "-3 remaining" to a
 * UI is worse than reporting none.
 */
export function remainingCapacity(limit: PlanLimit, current: number): number {
  if (limit === null || limit === undefined) return Number.POSITIVE_INFINITY
  return Math.max(0, limit - current)
}

/** Whether a plan permits a capability at all, e.g. a question type. */
export function isFeatureAllowed(allowed: readonly string[], feature: string): boolean {
  return allowed.includes(feature)
}
