import type { Prisma, PrismaClient } from '@bookends/db'
import { checkLimit, isFeatureAllowed, type PlanLimit } from '@bookends/core'
import { ApiError } from '../http/api-error.js'

/**
 * Plan limits and feature gates (SaaS §4.2, §4.3, §23.2).
 *
 * ---------------------------------------------------------------------------
 * A service, not just middleware, and that is load-bearing.
 *
 * Exams have two doors: POST /exams, and the auto-scheduling cron job, which
 * has no Express and no `req`. A middleware-only guard would miss the one path
 * that creates exams in bulk, unattended, every month. The codebase already
 * settled this shape for the plan's autoScheduling flag and wrote down why
 * (scheduler.service.ts): "the job is the other door into the same feature —
 * gating only the settings page would let a downgraded tenant keep the benefit
 * indefinitely."
 *
 * So: the logic lives here, the middleware is a thin adapter, and the services
 * call the same methods from inside their transactions.
 * ---------------------------------------------------------------------------
 *
 * Counts are LIVE, never read from TenantUsage. That table is a per-billing-
 * period rollup, and a stock like "employees" does not reset in a new month —
 * on the 1st its row does not exist, the count reads 0, and every limit stops
 * enforcing until the usage job runs. See the comment on model TenantUsage.
 *
 * NO runAsPlatform ANYWHERE IN THIS FILE. It disables scoping for its whole
 * callback, so wrapping a plan read around a count would compare EVERY tenant's
 * employees against ONE tenant's limit — failing open while the platform is
 * small and closed once it is not, with no error at any point. It is not needed
 * either: Tenant and Plan have no tenantId field, so the extension returns
 * before scope is consulted (packages/db/src/tenant.ts). The runAsPlatform in
 * tenant.resolver.ts is legitimate there (pre-login, no scope exists yet) and
 * that reasoning does not transfer here.
 */

/** The plan facts a guard needs. Flattened so callers never touch a null plan. */
export interface TenantPlan {
  tenantId: string
  planCode: string
  maxEmployees: PlanLimit
  maxOutlets: PlanLimit
  maxQuestions: PlanLimit
  maxExamsPerMonth: PlanLimit
  /** Which QuestionType values may be created. */
  questionTypes: readonly string[]
  autoScheduling: boolean
}

/** The countable limits. Storage is absent on purpose — see below. */
export type CountableLimit = 'maxEmployees' | 'maxOutlets' | 'maxQuestions' | 'maxExamsPerMonth'

/**
 * §8.2's statuses that release a seat.
 *
 * Both are terminal in the employee state machine ("rehiring is a new employee
 * record"), so a released seat cannot be re-claimed by flipping back — the
 * accounting closes. Everything else, including on_leave and suspended, keeps
 * its seat: they are temporarily out, not gone. Reading "active" as
 * employmentStatus === 'active' instead would be trivially exploitable (flip 50
 * to on_leave, hire 50 more, flip back) and would make the billing page and the
 * roster page disagree about the same word.
 */
const DEPARTED_STATUSES = ['terminated', 'resigned'] as const

/** Anything that can run a query — the client, or a transaction. */
type Queryable = PrismaClient | Prisma.TransactionClient

export class PlanService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The tenant's plan.
   *
   * Not cached, deliberately. An admin upgrading their plan expects the ceiling
   * to lift on the next request, not when a TTL lapses — and a stale cache at
   * exactly the moment a customer has just paid you is a support ticket. This
   * costs one indexed lookup on two tiny tables, on a path that already awaits
   * argon2. Revisit with a measurement, not a hunch.
   */
  async forTenant(tenantId: string, db: Queryable = this.prisma): Promise<TenantPlan> {
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        plan: {
          select: {
            code: true,
            maxEmployees: true,
            maxOutlets: true,
            maxQuestions: true,
            maxExamsPerMonth: true,
            questionTypes: true,
            autoScheduling: true,
          },
        },
      },
    })

    if (!tenant) throw new Error(`Tenant ${tenantId} not found while resolving its plan`)

    // A tenant with no plan is a provisioning bug, not a free-for-all. Failing
    // loudly beats silently granting unlimited everything to an unbilled tenant.
    if (!tenant.plan) {
      throw new Error(
        `Tenant ${tenantId} has no plan. Every tenant must reference one — refusing to guess its limits.`
      )
    }

    return {
      tenantId: tenant.id,
      planCode: tenant.plan.code,
      maxEmployees: tenant.plan.maxEmployees,
      maxOutlets: tenant.plan.maxOutlets,
      maxQuestions: tenant.plan.maxQuestions,
      maxExamsPerMonth: tenant.plan.maxExamsPerMonth,
      questionTypes: tenant.plan.questionTypes,
      autoScheduling: tenant.plan.autoScheduling,
    }
  }

  /**
   * Counts what a limit measures, live.
   *
   * `tenantId` is passed explicitly in every `where` even though the tenant
   * extension would inject it. Belt and braces: a Prisma query extension
   * intercepts top-level operations, and if it ever failed to fire inside an
   * interactive transaction the count would silently span every tenant and be
   * compared against one tenant's limit. Same value either way, so there is no
   * conflict — and the failure it guards against is invisible.
   */
  async currentUsage(
    limit: CountableLimit,
    tenantId: string,
    db: Queryable = this.prisma,
    opts: { month?: { start: Date; end: Date } } = {}
  ): Promise<number> {
    switch (limit) {
      case 'maxEmployees':
        return db.employee.count({
          where: { tenantId, employmentStatus: { notIn: [...DEPARTED_STATUSES] } },
        })

      case 'maxOutlets':
        return db.outlet.count({ where: { tenantId, isActive: true } })

      case 'maxQuestions':
        // Every question, archived included (§4.2 total_questions). Archiving is
        // this system's only delete — a hard delete would orphan exam_questions
        // and the responses behind them — so under this rule a tenant has no
        // self-serve way to free a slot. That is the intended commercial
        // behaviour, confirmed, not an oversight.
        return db.question.count({ where: { tenantId } })

      case 'maxExamsPerMonth': {
        if (!opts.month) {
          throw new Error('maxExamsPerMonth needs the month window it is counting within')
        }
        return db.exam.count({
          where: {
            tenantId,
            scheduledDate: { gte: opts.month.start, lt: opts.month.end },
            // A cancelled exam was not conducted, and the meter is literally
            // named examsConducted. Note this deliberately differs from the
            // adjacent exam-code counter, which does NOT free a number on
            // cancel — codes must never be reused, quota should be.
            status: { not: 'cancelled' },
          },
        })
      }
    }
  }

  /**
   * Throws PLAN_LIMIT_REACHED unless `adding` more will fit.
   *
   * Call this INSIDE the caller's transaction, passing `tx`. Above the
   * transaction there is a ~130ms argon2 hash between the check and the insert
   * (employee.service.ts) — the race window shrinks roughly a hundredfold by
   * moving in, for free, since the transactions already exist.
   */
  async assertCapacity(
    limit: CountableLimit,
    tenantId: string,
    db: Queryable = this.prisma,
    opts: { adding?: number; month?: { start: Date; end: Date } } = {}
  ): Promise<void> {
    const plan = await this.forTenant(tenantId, db)
    const ceiling = plan[limit]

    // Cheap exit before the count: an unlimited plan never needs to know its
    // usage, and Enterprise is unlimited on all four.
    if (ceiling === null) return

    const current = await this.currentUsage(limit, tenantId, db, opts)
    const verdict = checkLimit(ceiling, current, opts.adding ?? 1)
    if (verdict.allowed) return

    throw ApiError.planLimitReached(MESSAGES[limit](verdict.limit ?? 0), [
      { field: LIMIT_FIELD[limit], message: describe(verdict.current, verdict.limit, plan.planCode) },
    ])
  }

  /** Throws PLAN_FEATURE_LOCKED unless the plan permits this question type. */
  assertQuestionTypeAllowed(plan: TenantPlan, type: string): void {
    if (isFeatureAllowed(plan.questionTypes, type)) return

    throw ApiError.planFeatureLocked(`Your plan does not include ${type} questions`, [
      {
        field: 'type',
        message: `The ${plan.planCode} plan allows: ${plan.questionTypes.join(', ')}`,
      },
    ])
  }
}

/**
 * The month an exam counts against: the month it RUNS in, not the month it was
 * created (§4.2 examsConducted).
 *
 * Takes the already-parsed scheduledDate, which exam.service builds from a
 * validated YYYY-MM-DD pinned to UTC midnight — a calendar date, not an instant.
 * So getUTCMonth() returns the month the admin typed, from a server in any zone,
 * and there is no IST subtlety here to get wrong.
 *
 * The trap runs the other way: keying on `new Date()` would reintroduce exactly
 * the bug istMonthOf() exists to prevent — an exam created at 00:30 IST on 1
 * August counted against July, so the limit appears to reset at 05:30 rather
 * than midnight. Created-month is also gameable (create twelve on 1 January,
 * dated across the year) and would break the supported `?asOf=` backfill.
 */
export function examMonthWindow(scheduledDate: Date): { start: Date; end: Date } {
  const year = scheduledDate.getUTCFullYear()
  const month = scheduledDate.getUTCMonth()
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  }
}

const LIMIT_FIELD: Record<CountableLimit, string> = {
  maxEmployees: 'employees',
  maxOutlets: 'outlets',
  maxQuestions: 'questions',
  maxExamsPerMonth: 'exams',
}

/**
 * §23.2 rule 7: never a silent failure, and never a bare "no". The message says
 * which limit was hit; the detail says where they stand and on which plan, so
 * the UI can offer an upgrade rather than a shrug.
 */
const MESSAGES: Record<CountableLimit, (limit: number) => string> = {
  maxEmployees: (n) => `Your plan allows ${n} employees`,
  maxOutlets: (n) => `Your plan allows ${n} outlets`,
  maxQuestions: (n) => `Your plan allows ${n} questions`,
  maxExamsPerMonth: (n) => `Your plan allows ${n} exams per month`,
}

function describe(current: number, limit: number | null, planCode: string): string {
  return `You are using ${current} of ${limit ?? 'unlimited'} on the ${planCode} plan`
}
