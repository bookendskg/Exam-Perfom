import type { RequestHandler } from 'express'
import { ApiError } from '../../http/api-error.js'

/**
 * Endpoints reachable while a password change is outstanding. Anything else is
 * blocked until the user changes it.
 */
const EXEMPT_PATHS = new Set([
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
  '/api/v1/auth/me',
  '/api/v1/auth/refresh',
])

/**
 * Enforces §7.3's "force password change on first login".
 *
 * This has to be server-side middleware. Returning `mustChangePassword: true`
 * in the login response and trusting the client to act on it is not
 * enforcement — a caller hitting the API directly would simply ignore it.
 */
export function requirePasswordChange(): RequestHandler {
  return (req, _res, next) => {
    if (!req.principal?.mustChangePassword) {
      next()
      return
    }
    if (EXEMPT_PATHS.has(req.path)) {
      next()
      return
    }
    next(ApiError.passwordChangeRequired())
  }
}
