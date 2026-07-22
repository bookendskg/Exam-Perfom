import type { RequestHandler } from 'express'
import type { Permission, Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { PermissionResolver } from './permission-resolver.js'

declare module 'express-serve-static-core' {
  interface Request {
    scope?: Scope
    /** Set by markPublic() so the router coverage guard can tell "public" from "forgotten". */
    isPublicRoute?: boolean
  }
}

/**
 * Phase 1 of enforcement: the route gate. No database access — it only asks
 * whether this role has any scope at all for this permission.
 *
 * Phase 2 (scope.ts) narrows the actual data. Both are required: this alone
 * would let an outlet_manager edit another outlet's employee.
 */
export function requirePermission(permission: Permission): RequestHandler {
  const handler: RequestHandler = (req, _res, next) => {
    void (async () => {
      try {
        if (!req.principal) {
          next(ApiError.unauthenticated())
          return
        }

        /**
         * Grants come from the database, via a resolver put on `app.locals` by
         * buildApp.
         *
         * Read from the app rather than injected through every router so that
         * ~40 existing route definitions did not have to change; the trade is
         * that it must be present. Absent, this throws rather than falling back
         * to the compiled matrix — a silent fallback would mean an unseeded or
         * misconfigured deployment quietly enforcing a *different* matrix from
         * the one in the database, which is far worse than failing loudly.
         */
        const resolver = req.app.locals.permissions as PermissionResolver | undefined
        if (!resolver) {
          throw new Error('PermissionResolver is not configured on app.locals.permissions')
        }

        const scope = await resolver.scopeFor(req.principal.role, permission)
        if (scope === 'none') {
          next(ApiError.forbidden())
          return
        }

        // An outlet_manager with no managed outlet has an empty scope. Every
        // scoped query would return nothing, which reads as a broken account
        // rather than a permission problem — so say so plainly.
        if (scope === 'own_outlet' && req.principal.scopedOutletIds.length === 0) {
          next(
            ApiError.forbidden(
              'Your account is not assigned to any outlet. Contact an administrator.'
            )
          )
          return
        }

        req.scope = scope
        next()
      } catch (err) {
        next(err)
      }
    })()
  }

  // Tagged so the router coverage guard can see this route is gated.
  Object.defineProperty(handler, 'permission', { value: permission })
  return handler
}

/**
 * Marks a route as deliberately unauthenticated (login, refresh, health).
 *
 * Exists so the coverage guard can distinguish "public on purpose" from
 * "someone forgot requirePermission" — over ~20 modules that is the realistic
 * RBAC failure, not a wrong matrix cell.
 */
export function markPublic(): RequestHandler {
  const handler: RequestHandler = (req, _res, next) => {
    req.isPublicRoute = true
    next()
  }
  Object.defineProperty(handler, 'isPublicMarker', { value: true })
  return handler
}
