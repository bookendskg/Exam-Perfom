import type { RequestHandler } from 'express'
import { permissionScope, type Permission, type Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'

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
    if (!req.principal) {
      next(ApiError.unauthenticated())
      return
    }

    const scope = permissionScope(req.principal.role, permission)
    if (scope === 'none') {
      next(ApiError.forbidden())
      return
    }

    // An outlet_manager with no managed outlet has an empty scope. Every scoped
    // query would return nothing, which reads as a broken account rather than a
    // permission problem — so say so plainly.
    if (scope === 'own_outlet' && req.principal.managedOutletIds.length === 0) {
      next(
        ApiError.forbidden(
          'Your account is not assigned to manage any outlet. Contact an administrator.'
        )
      )
      return
    }

    req.scope = scope
    next()
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
