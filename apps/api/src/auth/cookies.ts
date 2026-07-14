import type { Response, Request } from 'express'
import type { Config } from '../config/env.js'

export const REFRESH_COOKIE = 'bookends_rt'

/**
 * Path-scoped to /api/v1/auth so the refresh token is never attached to
 * ordinary API calls — only to the endpoints that actually need it.
 *
 * SameSite=Strict is sufficient CSRF defence for a POST-only endpoint PROVIDED
 * the API is same-origin with the web app (i.e. served under the same origin via
 * reverse proxy). If the API ever moves to a separate subdomain this must drop
 * to Lax plus credentialed CORS plus an explicit CSRF token.
 */
export function setRefreshCookie(res: Response, config: Config, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: config.REFRESH_TTL_SECONDS * 1000,
  })
}

export function clearRefreshCookie(res: Response, config: Config): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
  })
}

/**
 * §7.2 says the refresh token lives in an HttpOnly cookie; §5.3 says it arrives
 * in the request body. Both are real: the cookie serves the web app, the body
 * serves the APK, which has no cookie jar. Cookie wins when both are present.
 */
export function readRefreshToken(req: Request): { token: string; fromCookie: boolean } | null {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE]
  if (cookieToken) return { token: cookieToken, fromCookie: true }

  const bodyToken = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken
  if (typeof bodyToken === 'string' && bodyToken.length > 0) {
    return { token: bodyToken, fromCookie: false }
  }
  return null
}
