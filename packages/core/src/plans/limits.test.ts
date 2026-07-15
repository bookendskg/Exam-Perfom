import { describe, it, expect } from 'vitest'
import { checkLimit, remainingCapacity, isFeatureAllowed } from './limits.js'

describe('checkLimit — the boundary', () => {
  it('allows the create that lands exactly on the limit', () => {
    expect(checkLimit(50, 49).allowed).toBe(true)
  })

  it('blocks the create that would exceed it', () => {
    expect(checkLimit(50, 50).allowed).toBe(false)
  })

  it('blocks a tenant already past the limit — e.g. after a downgrade', () => {
    // `>=` vs `>` lives or dies here. A plan downgrade leaves a tenant over
    // their new ceiling with existing rows; they must not be able to add more.
    expect(checkLimit(50, 51).allowed).toBe(false)
  })

  it('treats 0 as a real ceiling, not as falsy-therefore-unlimited', () => {
    expect(checkLimit(0, 0).allowed).toBe(false)
  })
})

describe('checkLimit — NULL means unlimited', () => {
  /**
   * The reason this module exists. `count >= null` is `count >= 0` → true, so a
   * naive check blocks every create on an unlimited plan. Enterprise is null on
   * all five limits, and Professional — the anchor customer's plan — is null on
   * maxExamsPerMonth. A regression here bricks the paying tiers while every
   * Starter test stays green.
   */
  it('allows a create at zero usage', () => {
    expect(checkLimit(null, 0).allowed).toBe(true)
  })

  it('allows a create at a usage that would dwarf any real limit', () => {
    expect(checkLimit(null, 400).allowed).toBe(true)
    expect(checkLimit(null, 1_000_000).allowed).toBe(true)
  })

  it('reports the limit as null rather than a number, so no UI renders "of 0"', () => {
    expect(checkLimit(null, 400).limit).toBeNull()
  })

  it('allows a bulk add of any size', () => {
    expect(checkLimit(null, 400, 5_000).allowed).toBe(true)
  })
})

describe('checkLimit — adding more than one', () => {
  it('fits a batch that lands exactly on the limit', () => {
    expect(checkLimit(50, 20, 30).allowed).toBe(true)
  })

  it('rejects a batch that would cross it, as one decision', () => {
    // 30 used + 30 rows against 50 seats. Must be refused whole, not discovered
    // on row 21 after 20 people already exist.
    expect(checkLimit(50, 30, 30).allowed).toBe(false)
  })

  it('rejects a batch by exactly one', () => {
    expect(checkLimit(50, 21, 30).allowed).toBe(false)
  })

  it('carries the numbers needed to explain the refusal', () => {
    expect(checkLimit(50, 30, 30)).toEqual({ allowed: false, limit: 50, current: 30, adding: 30 })
  })
})

describe('remainingCapacity', () => {
  it('is the gap under a finite limit', () => {
    expect(remainingCapacity(50, 20)).toBe(30)
  })

  it('is Infinity when unlimited', () => {
    expect(remainingCapacity(null, 400)).toBe(Number.POSITIVE_INFINITY)
  })

  it('clamps to zero rather than reporting negative headroom after a downgrade', () => {
    expect(remainingCapacity(50, 53)).toBe(0)
  })
})

describe('isFeatureAllowed', () => {
  it('permits a type the plan lists', () => {
    expect(isFeatureAllowed(['mcq', 'theory'], 'theory')).toBe(true)
  })

  it('refuses one it does not', () => {
    expect(isFeatureAllowed(['mcq'], 'theory')).toBe(false)
  })

  it('refuses everything on an empty allow-list', () => {
    expect(isFeatureAllowed([], 'mcq')).toBe(false)
  })
})
