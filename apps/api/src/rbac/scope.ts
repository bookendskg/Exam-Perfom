import type { Scope } from '@bookends/core'
import type { Principal } from '../infra/session-store/index.js'
import { ApiError } from '../http/api-error.js'

/**
 * Entities that carry outlet scoping. Each resolves `own_resource` differently:
 * an employee's own record is keyed by userId, a question's by who created it.
 */
export type ScopedEntity =
  'employee' | 'question' | 'exam' | 'exam_template' | 'source_document' | 'topic'

/**
 * Read and write scope are NOT the same, and conflating them is a data
 * integrity bug rather than a permissions one.
 *
 * Question.outletId, ExamTemplate.outletId and Exam.outletId are nullable, and
 * NULL means "applies to all outlets" (schema.prisma). An outlet_manager should
 * SEE a global question — it appears in their staff's exams — but must not EDIT
 * one, because editing it silently changes content for the other two outlets.
 *
 * Hence the explicit mode. There is no sensible default.
 */
export type ScopeMode = 'read' | 'write'

type WhereFragment = Record<string, unknown>

const OWN_RESOURCE_KEY: Record<ScopedEntity, string> = {
  employee: 'userId',
  question: 'createdById',
  exam: 'createdById',
  exam_template: 'createdById',
  source_document: 'uploadedById',
  // Topic has no creator column; no role holds own_resource on topic:manage, so
  // this is unreachable. Pointed at a column that cannot match rather than left
  // absent, so a future matrix change fails closed instead of widening.
  topic: 'id',
}

/**
 * Turns a scope into a Prisma `where` fragment.
 *
 * Filtering rather than post-hoc checking is deliberate: it also makes
 * meta.total correct for free, whereas filtering a page after the query would
 * paginate over rows the caller cannot see.
 */
export function scopeToWhere(
  entity: ScopedEntity,
  scope: Scope,
  principal: Principal,
  mode: ScopeMode
): WhereFragment {
  switch (scope) {
    case 'all':
      return {}

    case 'none':
      // Unreachable behind requirePermission, but never return {} here — that
      // would silently widen a denial into full access.
      throw ApiError.forbidden()

    case 'own_resource': {
      const key = OWN_RESOURCE_KEY[entity]
      return { [key]: principal.userId }
    }

    case 'own_outlet': {
      const ids = principal.scopedOutletIds
      if (ids.length === 0) throw ApiError.forbidden('No outlets assigned to your account')

      if (mode === 'read' && entityHasNullableOutlet(entity)) {
        // NULL = all outlets, so it is legitimately visible.
        return { OR: [{ outletId: { in: ids } }, { outletId: null }] }
      }
      // Write: NULL excluded. A global record is not this manager's to change.
      return { outletId: { in: ids } }
    }
  }
}

/** Employee.outletId is required; the content entities' are nullable. */
function entityHasNullableOutlet(entity: ScopedEntity): boolean {
  return entity !== 'employee'
}

/**
 * Asserts an existing record is within scope.
 *
 * Throws NOT_FOUND rather than FORBIDDEN on a scope miss: a 403 confirms the
 * record exists, which leaks another outlet's employee roster to anyone willing
 * to enumerate IDs.
 */
export function assertInScope(
  scope: Scope,
  principal: Principal,
  record: { outletId?: string | null; userId?: string | null; createdById?: string | null },
  mode: ScopeMode
): void {
  if (scope === 'all') return
  if (scope === 'none') throw ApiError.forbidden()

  if (scope === 'own_resource') {
    const owner = record.userId ?? record.createdById
    if (owner !== principal.userId) throw ApiError.notFound()
    return
  }

  // own_outlet
  if (record.outletId === null || record.outletId === undefined) {
    // Global record: readable, not writable.
    if (mode === 'read') return
    throw ApiError.forbidden('This record applies to all outlets and cannot be edited here')
  }
  if (!principal.scopedOutletIds.includes(record.outletId)) throw ApiError.notFound()
}

/**
 * Asserts a create payload is within scope.
 *
 * This is the path everyone forgets. There is no stored record yet, so neither
 * scopeToWhere nor assertInScope applies — without this an outlet_manager can
 * POST an employee with someone else's outletId and it just works.
 */
export function assertCreateInScope(
  scope: Scope,
  principal: Principal,
  payload: { outletId?: string | null }
): void {
  if (scope === 'all') return
  if (scope === 'none') throw ApiError.forbidden()
  if (scope === 'own_resource') return // ownership is stamped by the service, not supplied

  const target = payload.outletId
  if (!target) {
    throw ApiError.forbidden('You must specify an outlet you are assigned to')
  }
  if (!principal.scopedOutletIds.includes(target)) {
    throw ApiError.forbidden('You cannot create records for an outlet you are not assigned to')
  }
}
