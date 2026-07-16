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
      const phone = (req.body as { phone?: unknown } | undefined)?.phone
      const ip = ipKey(req.ip)
      return typeof phone === 'string' ? `${ip}:${phone}` : ip
    },
    handler: (_req, res) => {
      res.status(429).json(rateLimited)
    },
  })
}

/**
 * Signup limiter (§5.1). Deliberately per-HOUR, not per-minute like the others.
 *
 * Every other limiter here bounds a transient cost — a wasted query, a login
 * attempt. Signup's cost is DURABLE: each success burns a slug forever, seeds
 * ~25 rows, and puts a tenant in the auto-scheduler's loop. A 60-second window
 * would let one source create 60 junk tenants an hour indefinitely and still be
 * "within the limit".
 *
 * Five per hour per IP is generous for the real case — a person signing their
 * company up does it once — and it makes squatting the interesting slugs a job
 * rather than a script.
 *
 * This bounds abuse, it does not prevent it: nothing here proves the signer-up
 * owns the email, because §14's mailer does not exist yet. Email verification
 * is the actual answer and this is the holding measure until there is one.
 */
export function signupLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60 * 60_000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => ipKey(req.ip),
    // Successful signups are what we are limiting. A failed one (a taken slug,
    // a weak password) is a mistake to correct, not an attack to punish — and
    // counting it would lock someone out of their own third attempt.
    skipFailedRequests: true,
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
