import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit'
import type { Role } from '@bookends/core'
import { fail } from '@bookends/core'

/**
 * Normalises a client IP into a rate-limit key.
 *
 * IPv6 collapses to its /64 prefix: a single subscriber is routinely handed a
 * whole /64, so keying on the full address would let one client cycle addresses
 * to reset its counter. IPv4 is used whole.
 *
 * (express-rate-limit v8 ships `ipKeyGenerator` for this; we are on v7.)
 */
export function ipKey(ip: string | undefined): string {
  if (!ip) return 'unknown'
  // Express reports IPv4-mapped IPv6 as ::ffff:1.2.3.4 — treat as IPv4.
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (!mapped.includes(':')) return mapped

  const groups = mapped.split(':')
  return groups.slice(0, 4).join(':') + '::/64'
}

/** §5.4 per-minute quotas. `hr` is absent from the spec's table; 100 mirrors outlet_manager. */
const ROLE_LIMITS: Record<Role, number> = {
  super_admin: 200,
  admin: 150,
  outlet_manager: 100,
  trainer: 80,
  hr: 100,
  staff: 40,
}

const rateLimited = fail('RATE_LIMITED', 'Too many requests. Please slow down.')

/**
 * Login limiter, keyed on IP **+ phone** rather than IP alone.
 *
 * §5.4 specifies 10/min for unauthenticated requests, which at a restaurant is
 * a self-inflicted outage: the whole outlet shares one NAT'd WiFi, everyone logs
 * in at shift change, and the 11th person is refused. Keying on the phone number
 * preserves the brute-force protection per account while letting a full shift
 * sign in. A looser per-IP ceiling still bounds a single source.
 */
export function loginLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const phone = phoneKey((req.body as { phone?: unknown } | undefined)?.phone)
      const ip = ipKey(req.ip)
      return phone ? `${ip}:${phone}` : ip
    },
    handler: (_req, res) => {
      res.status(429).json(rateLimited)
    },
  })
}

/**
 * Normalises a submitted phone into a rate-limit key.
 *
 * This middleware runs BEFORE zod validation, so the raw body reaches it — the
 * value is attacker-controlled and unbounded up to the 1 MB JSON limit. Two
 * consequences, both fixed here by trimming and truncating:
 *
 *  - every distinct string became its own retained bucket, so the key space was
 *    a memory-pressure vector;
 *  - the schema trims later, so `"123"` and `" 123"` were two buckets for one
 *    account, quietly doubling the permitted guess rate against it.
 */
function phoneKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // 15 matches the column width; anything longer cannot be a real identifier.
  const normalised = value.trim().slice(0, 15)
  return normalised.length > 0 ? normalised : null
}

/**
 * Per-user limit for authenticated auth routes.
 *
 * `roleLimiter` is mounted on `/api/v1` *after* the auth router, so it never
 * applies to `/api/v1/auth/*`. Anything under the auth router that verifies a
 * credential or hits the database needs its own limiter, or it has none.
 */
export function authenticatedLimiter(limit = 20): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.principal?.userId ?? ipKey(req.ip),
    handler: (_req, res) => {
      res.status(429).json(rateLimited)
    },
  })
}

/** Bounds one source overall, so IP+phone keying cannot be farmed across accounts. */
export function publicLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => ipKey(req.ip),
    handler: (_req, res) => {
      res.status(429).json(rateLimited)
    },
  })
}

/** §5.4 authenticated quotas, keyed per user so a shared IP is irrelevant. */
export function roleLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: (req) => (req.principal ? ROLE_LIMITS[req.principal.role] : 10),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.principal?.userId ?? ipKey(req.ip),
    handler: (_req, res) => {
      res.status(429).json(rateLimited)
    },
  })
}

export { ROLE_LIMITS }
