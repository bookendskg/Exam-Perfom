import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The ambient tenant for the current unit of work.
 *
 * Held in AsyncLocalStorage rather than threaded through every signature. That
 * is a real departure from this codebase's "pass deps, import nothing" rule
 * (app.ts), and it is a considered one: the alternative is adding a tenantId
 * parameter to all ~190 Prisma call sites and every service method between the
 * request and the query. Every one of those is a place to forget it, and
 * forgetting it here does not fail — it silently returns another customer's
 * rows.
 *
 * ALS inverts that. There is exactly one place to set the tenant (the request
 * middleware) and exactly one place that reads it (the extension below), and
 * the failure mode is a thrown error rather than a leak.
 */

export type TenantScope =
  | { kind: 'tenant'; tenantId: string }
  /**
   * Deliberately unscoped. Only for work that genuinely has no tenant yet:
   * resolving a login by phone, reading the platform's `plans`, migrations and
   * seeds. Named so it is obvious in review and greppable in one command.
   */
  | { kind: 'platform'; reason: string }

const storage = new AsyncLocalStorage<TenantScope>()

/**
 * Runs `fn` with every query inside it scoped to `tenantId`.
 *
 * Always async, and it awaits `fn` INSIDE the scope rather than handing the
 * caller a promise to await outside it. That is not ceremony — Prisma's query
 * promises are lazy, so
 *
 *   runInTenant(id, () => prisma.employee.findMany())   // no await inside
 *
 * would return an unstarted promise, and the query would actually run after the
 * scope had already closed: "no tenant context" at best, and a confusing one to
 * debug. Awaiting here makes that shape impossible to write by accident.
 */
export async function runInTenant<T>(tenantId: string, fn: () => T | Promise<T>): Promise<T> {
  return storage.run({ kind: 'tenant', tenantId }, async () => await fn())
}

/**
 * Runs `fn` with tenant scoping switched OFF.
 *
 * `reason` is mandatory and is not decoration: it is the audit trail for why a
 * query was allowed to see across tenants, and it makes every such site
 * self-documenting at the call, not in a comment somewhere above it.
 */
export async function runAsPlatform<T>(reason: string, fn: () => T | Promise<T>): Promise<T> {
  return storage.run({ kind: 'platform', reason }, async () => await fn())
}

export function currentScope(): TenantScope | undefined {
  return storage.getStore()
}

/**
 * The current tenant, or a thrown error.
 *
 * Callers that write rows use this. It throws rather than returning null
 * because there is no safe fallback: a create with no tenant is either a bug or
 * a cross-tenant write, and both should stop the request.
 */
export function currentTenantId(): string {
  const scope = storage.getStore()
  if (!scope) {
    throw new TenantContextError(
      'No tenant context. Wrap the work in runInTenant(), or runAsPlatform() if it genuinely has no tenant.'
    )
  }
  if (scope.kind === 'platform') {
    throw new TenantContextError(
      `Platform scope ("${scope.reason}") has no tenant, but a tenant-scoped write was attempted.`
    )
  }
  return scope.tenantId
}

export class TenantContextError extends Error {
  override readonly name = 'TenantContextError'
}
