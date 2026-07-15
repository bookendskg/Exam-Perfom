import type { NextFunction, Request, Response } from 'express'
import { runInTenant } from '@bookends/db'
import { ApiError } from '../http/api-error.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'

/**
 * Runs the rest of the request inside its tenant's scope (SaaS §2.4).
 *
 * Mounted once, after authenticate. From here down every Prisma query in the
 * request — in any service, at any depth — is filtered to this tenant by the
 * extension, without a single call site knowing it happened.
 *
 * The tenant comes from the Principal, which came from the session store, which
 * was populated from the database at login. It is never taken from a header or
 * the body on an authenticated request: those are caller-supplied, and a caller
 * who could pick their own tenant_id would have defeated the entire scheme with
 * one line of curl.
 */
export function tenantScope() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = requirePrincipal(req)

    if (!principal.tenantId) {
      // Not reachable through the normal login path — resolvePrincipal always
      // sets it. Refuse rather than continue unscoped: an unscoped request is
      // the failure this whole layer exists to make impossible.
      next(ApiError.unauthenticated('Session has no tenant'))
      return
    }

    // `next` is deliberately called INSIDE runInTenant. Express's next() enters
    // the rest of the chain synchronously, so the AsyncLocalStorage context set
    // here propagates through every await downstream.
    //
    // The returned promise is intentionally not awaited: express drives the
    // response, not us. Errors still reach the error handler because each
    // handler wraps its own async work — see the routers.
    void runInTenant(principal.tenantId, () => {
      next()
    })
  }
}
