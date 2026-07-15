import type { RequestHandler } from 'express'
import { ApiError } from '../http/api-error.js'
import type { CountableLimit, PlanService } from './plan.service.js'

/**
 * Route-level plan gate (SaaS §4.3).
 *
 * ---------------------------------------------------------------------------
 * This is an ADVISORY fast-fail, not the enforcement.
 *
 * The authoritative check lives inside each service's transaction, next to the
 * insert. This exists to reject an at-capacity tenant cheaply — before a 5 MB
 * spreadsheet is parsed, before a ~130ms argon2 hash — and to keep the 403 on
 * the route where it is visible to anyone reading the router.
 *
 * A guard here WITHOUT its service-side twin is not enforcement: it cannot see
 * concurrent requests, and it cannot see the auto-scheduling job, which creates
 * exams with no Express in sight.
 * ---------------------------------------------------------------------------
 *
 * MOUNT PER-ROUTE. NEVER app-wide next to roleLimiter in app.ts.
 *
 * §4.3 requires that a tenant over its exam limit can still COMPLETE exams in
 * progress. That falls out for free while the gate sits only on the create
 * routes — the staff exam-taking and grading paths create no Exam rows, so they
 * are physically out of reach. Mounting this app-wide would 403 a staff member
 * mid-exam and lose their half-finished paper, which is the worst failure this
 * feature can produce. There is a test asserting exactly that; do not delete it.
 *
 * Unlike requirePermission, this handler touches the database, so it cannot be
 * synchronous. Ordering is deliberate and matters: mount it AFTER
 * requirePermission (a caller who lacks permission should not learn your plan
 * limits) and AFTER validate (a malformed body should 400 without spending a
 * query).
 */
export function planGuard(plans: PlanService) {
  return {
    /**
     * Refuses when the tenant has no headroom for one more.
     *
     * `maxExamsPerMonth` is absent by design: its window depends on the exam's
     * scheduledDate, which lives in the request body, and the guard would have
     * to duplicate the parsing that exam.service already does. Exams are gated
     * in the service only — which is also the only place that covers the cron.
     */
    limit(which: Exclude<CountableLimit, 'maxExamsPerMonth'>): RequestHandler {
      return (req, _res, next) => {
        const principal = req.principal
        if (!principal) {
          next(ApiError.unauthenticated())
          return
        }

        // The service throws ApiError.planLimitReached; anything else is a bug
        // and the error handler will render it as a 500, which is correct.
        plans
          .assertCapacity(which, principal.tenantId)
          .then(() => next())
          .catch(next)
      }
    },

    /** Refuses a question type the plan does not include. Mount after validate(). */
    questionType(): RequestHandler {
      return (req, _res, next) => {
        const principal = req.principal
        if (!principal) {
          next(ApiError.unauthenticated())
          return
        }

        // Reads the VALIDATED body, never req.body — validate() has already
        // proven `type` is a real QuestionType by this point.
        const type = (req.valid?.body as { type?: string } | undefined)?.type
        if (!type) {
          next()
          return
        }

        plans
          .forTenant(principal.tenantId)
          .then((plan) => {
            plans.assertQuestionTypeAllowed(plan, type)
            next()
          })
          .catch(next)
      }
    },
  }
}
