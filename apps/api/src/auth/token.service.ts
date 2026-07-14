import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'
import { randomBytes, createHash } from 'node:crypto'
import type { Role } from '@bookends/core'
import type { Config } from '../config/env.js'
import { ApiError } from '../http/api-error.js'

export interface AccessTokenClaims {
  sub: string
  role: Role
  sid: string
}

/**
 * Access tokens (§7.2, 15 min) and refresh tokens (§7.2, 7 days).
 *
 * The access token is a JWT because it must be verified without I/O on every
 * request. The refresh token is NOT — it is an opaque 256-bit random string,
 * because nothing reads claims out of it; it is looked up in user_sessions.
 * An opaque token cannot be forged with a leaked signing key and is revocable
 * by deleting a row.
 */
export class TokenService {
  private readonly secret: Uint8Array

  constructor(private readonly config: Config) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET)
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ role: claims.role, sid: claims.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.config.JWT_ACCESS_TTL_SECONDS}s`)
      .sign(this.secret)
  }

  /**
   * Verifies an access token. The explicit `algorithms` allowlist is the point:
   * without it, a token claiming `alg: none` or a key-confusion attack could
   * pass verification.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'] })

      const sub = payload.sub
      const role = payload['role']
      const sid = payload['sid']
      if (typeof sub !== 'string' || typeof role !== 'string' || typeof sid !== 'string') {
        throw ApiError.unauthenticated('Malformed access token')
      }
      return { sub, role: role as Role, sid }
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw ApiError.tokenExpired()
      if (err instanceof ApiError) throw err
      throw ApiError.unauthenticated('Invalid access token')
    }
  }

  /** A fresh opaque refresh token and the hash to persist alongside it. */
  mintRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url')
    return { token, hash: hashRefreshToken(token) }
  }

  refreshExpiryDate(): Date {
    return new Date(Date.now() + this.config.REFRESH_TTL_SECONDS * 1000)
  }
}

/**
 * sha256, not argon2. The input is already 256 bits of entropy, so there is
 * nothing to brute-force and a slow KDF would only add latency to every refresh.
 * Fixed 64-char hex matches the CHAR(64) column.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
