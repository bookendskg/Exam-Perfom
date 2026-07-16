import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'
import type { PlatformRole } from '@bookends/db'
import type { Config } from '../config/env.js'
import { ApiError } from '../http/api-error.js'

/**
 * Platform admin access tokens (§10, §21.3).
 *
 * ---------------------------------------------------------------------------
 * A separate class from TokenService, signing with a separate secret, and the
 * separation is the whole security model — not code style.
 *
 * A platform token reads and suspends EVERY tenant. If it shared JWT_SECRET
 * with tenant tokens, then the only thing standing between a customer's admin
 * and every other customer's data would be a correct claim check in middleware
 * — one forgotten `if` away from total compromise. With separate secrets the
 * failure is impossible rather than unlikely: a tenant token presented here
 * does not verify, full stop.
 *
 * env.ts refuses to boot if the two secrets are equal, in every environment.
 * ---------------------------------------------------------------------------
 *
 * No refresh token, deliberately. §7.2's refresh flow exists so staff on a
 * phone are not thrown out mid-exam; a platform operator sits at a desk and can
 * log in again. A long-lived credential for the most powerful identity on the
 * platform is a liability with no matching benefit — so the token is short
 * (10 minutes) and there is nothing to steal that outlives it.
 */

export interface PlatformTokenClaims {
  sub: string
  role: PlatformRole
  /** Distinguishes these tokens from tenant ones even under a shared secret. */
  typ: 'platform'
}

export class PlatformTokenService {
  private readonly secret: Uint8Array

  constructor(private readonly config: Config) {
    this.secret = new TextEncoder().encode(config.PLATFORM_JWT_SECRET)
  }

  async sign(claims: Omit<PlatformTokenClaims, 'typ'>): Promise<string> {
    return new SignJWT({ role: claims.role, typ: 'platform' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.config.PLATFORM_JWT_ACCESS_TTL_SECONDS}s`)
      .sign(this.secret)
  }

  /**
   * Verifies a platform token.
   *
   * The `algorithms` allowlist is not optional: without it a token claiming
   * `alg: none` would pass verification (the same reasoning as token.service.ts).
   *
   * The `typ` check is belt and braces. Separate secrets already make a tenant
   * token unverifiable here — but if someone ever "simplifies" the config by
   * pointing both at one secret, this is what still refuses. Defence in depth
   * costs one comparison.
   */
  async verify(token: string): Promise<PlatformTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'] })

      const sub = payload.sub
      const role = payload['role']
      const typ = payload['typ']

      if (typeof sub !== 'string' || typeof role !== 'string') {
        throw ApiError.unauthenticated('Malformed platform token')
      }
      if (typ !== 'platform') {
        // A tenant token that somehow verified. Refuse loudly rather than let a
        // tenant user near the platform panel.
        throw ApiError.unauthenticated('This is not a platform token')
      }

      return { sub, role: role as PlatformRole, typ: 'platform' }
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw ApiError.tokenExpired()
      if (err instanceof ApiError) throw err
      throw ApiError.unauthenticated('Invalid platform token')
    }
  }
}
