import type { RequestHandler } from 'express'
import { ApiError } from '../../http/api-error.js'

/**
 * Endpoints reachable while a password change is outstanding. Anything else is
 * blocked until the user changes it.
 *
 * Paths are relative to where this middleware is MOUNTED, not absolute. Inside
 * a middleware added with `app.use('/api/v1', …)`, Express strips the mount
 * prefix from `req.path` — so a request to `/api/v1/auth/change-password`
 * arrives here as `/auth/change-password`.
 *
 * These were previously written with the `/api/v1` prefix, which meant the set
 * could never match anything and the whole check was dead. It happened not to
 * matter only because the auth router is mounted above this guard, so those
 * routes never reach it. Reorder those two lines and it would silently lock
 * every user out of the one endpoint that unblocks them.
 */
const EXEMPT_PATHS = new Set([
  '/auth/change-password',
  '/auth/logout',
  '/auth/logout-all',
  '/auth/me',
  '/auth/refresh',
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
