import type { RequestHandler } from 'express'
import type { PlatformRole } from '@bookends/db'
import { ApiError } from '../http/api-error.js'
import type { PlatformService, PlatformPrincipal } from './platform.service.js'
import type { PlatformTokenService } from './platform-token.service.js'

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Set by requirePlatformAuth. Deliberately a DIFFERENT property from
     * `principal` (the tenant one): if they shared a name, a route could read
     * the wrong identity and typecheck perfectly. They are different shapes on
     * different keys so that mistake does not compile.
     */
    platform?: PlatformPrincipal
  }
}

/**
 * Authenticates a platform operator (§10).
 *
 * Verifies against PLATFORM_JWT_SECRET, so a tenant's token cannot pass here —
 * not because this checks a claim, but because the signature does not verify.
 * That is the design: the boundary is cryptographic, not conditional.
 *
 * It also re-reads the admin from the database on every request rather than
 * trusting the token's claims. The token lives 10 minutes; deactivating an
 * operator should not leave them with 10 minutes of access over every customer
 * on the platform. Same reasoning as the tenant session store, with more at
 * stake.
 */
export function requirePlatformAuth(
  tokens: PlatformTokenService,
  platform: PlatformService
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const header = req.get('authorization')
        if (!header?.startsWith('Bearer ')) {
          throw ApiError.unauthenticated('Platform authentication required')
        }

        const claims = await tokens.verify(header.slice('Bearer '.length))

        const admin = await platform.findAdmin(claims.sub)
        if (!admin || !admin.isActive) {
          // Deactivated between issuing the token and now. The token is still
          // signed and unexpired; the account is not.
          throw ApiError.unauthenticated('Platform account is not active')
        }

        req.platform = { adminId: admin.id, role: admin.role }
        next()
      } catch (err) {
        next(err)
      }
    })()
  }
}

/**
 * §6.1's platform roles: super_admin does everything; support reads; finance
 * reads billing.
 *
 * Only super_admin may mutate a tenant. Support exists to answer tickets, and
 * an operator who can accidentally suspend a paying customer while looking into
 * their problem is a worse tool than one who has to ask.
 */
export function requirePlatformRole(...allowed: PlatformRole[]): RequestHandler {
  return (req, _res, next) => {
    const principal = req.platform
    if (!principal) {
      next(ApiError.unauthenticated('Platform authentication required'))
      return
    }
    if (!allowed.includes(principal.role)) {
      next(
        ApiError.forbidden(
          `This action requires the ${allowed.join(' or ')} platform role; you have ${principal.role}`
        )
      )
      return
    }
    next()
  }
}

/** Throws rather than returning undefined, so routes need no null check. */
export function requirePlatformPrincipal(req: { platform?: PlatformPrincipal }): PlatformPrincipal {
  if (!req.platform) throw ApiError.unauthenticated('Platform authentication required')
  return req.platform
}
