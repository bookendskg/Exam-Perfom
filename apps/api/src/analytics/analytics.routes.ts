import { Router } from 'express'
import { z } from 'zod'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { AnalyticsService } from './analytics.service.js'
import { SnapshotService } from './snapshot.service.js'
import { istMonthOf } from '../scheduling/exam-date.js'

/** Defaults to the current IST month — the product runs in Asia/Kolkata. */
const periodSchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
})

const trendSchema = z.object({
  months: z.coerce.number().int().min(1).max(36).default(6),
})

const weakAreasSchema = periodSchema.extend({
  threshold: z.coerce.number().min(0).max(100).default(60),
})

const leaderboardSchema = periodSchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

const rebuildSchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
})

export function buildAnalyticsRouter(deps: Deps) {
  const analytics = new AnalyticsService(deps.prisma)
  const snapshots = new SnapshotService(deps.prisma)
  const router = Router()

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  const periodOf = (query: z.infer<typeof periodSchema>) => {
    const now = istMonthOf(new Date())
    return { year: query.year ?? now.year, month: query.month ?? now.month }
  }

  // §5.3 GET /api/v1/analytics/dashboard
  router.get(
    '/dashboard',
    requirePermission('report:read'),
    validate({ query: periodSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { year, month } = periodOf(req.valid!.query as z.infer<typeof periodSchema>)
          res.json(ok(await analytics.dashboard(requirePrincipal(req), scopeOf(req), year, month)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/analytics/outlet-comparison
  router.get(
    '/outlet-comparison',
    requirePermission('report:read'),
    validate({ query: periodSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { year, month } = periodOf(req.valid!.query as z.infer<typeof periodSchema>)
          res.json(
            ok(await analytics.outletComparison(requirePrincipal(req), scopeOf(req), year, month))
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/analytics/department-comparison
  router.get(
    '/department-comparison',
    requirePermission('report:read'),
    validate({ query: periodSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { year, month } = periodOf(req.valid!.query as z.infer<typeof periodSchema>)
          res.json(
            ok(
              await analytics.departmentComparison(requirePrincipal(req), scopeOf(req), year, month)
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/analytics/trend
  router.get(
    '/trend',
    requirePermission('report:read'),
    validate({ query: trendSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { months } = req.valid!.query as z.infer<typeof trendSchema>
          res.json(ok(await analytics.trend(requirePrincipal(req), scopeOf(req), months)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/analytics/weak-areas
  router.get(
    '/weak-areas',
    requirePermission('report:read'),
    validate({ query: weakAreasSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as z.infer<typeof weakAreasSchema>
          const { year, month } = periodOf(query)
          res.json(
            ok(
              await analytics.weakAreas(
                requirePrincipal(req),
                scopeOf(req),
                year,
                month,
                query.threshold
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/analytics/leaderboard
  router.get(
    '/leaderboard',
    requirePermission('report:read'),
    validate({ query: leaderboardSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as z.infer<typeof leaderboardSchema>
          const { year, month } = periodOf(query)
          res.json(
            ok(
              await analytics.leaderboard(
                requirePrincipal(req),
                scopeOf(req),
                year,
                month,
                query.limit
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  /**
   * Rebuilds a month's snapshots.
   *
   * Not in §5.3. Snapshots are derived, and nothing currently rebuilds them —
   * grading a paper does not update the rollup. Until that is wired to the
   * grading flow (or a cron), this is how a month's figures get computed at
   * all. Restricted to super_admin/admin: it rewrites everyone's numbers.
   */
  router.post(
    '/snapshots/rebuild',
    requirePermission('exam:override_schedule'),
    validate({ body: rebuildSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { year, month } = req.valid!.body as z.infer<typeof rebuildSchema>
          res.json(ok(await snapshots.rebuild(year, month)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
