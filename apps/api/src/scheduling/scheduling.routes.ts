import { Router } from 'express'
import { z } from 'zod'
import { currentTenantId } from '@bookends/db'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { ApiError } from '../http/api-error.js'
import { SchedulerService } from './scheduler.service.js'
import { resolveExamDate, istMonthOf } from './exam-date.js'

/** §4.1 exam_schedule_config. */
const upsertConfigSchema = z.object({
  dayOfMonth: z.coerce.number().int().min(1).max(31).default(15),
  fallbackRule: z.enum(['next_monday', 'previous_friday', 'next_weekday']).default('next_monday'),
  isActive: z.boolean().default(true),
  /** NULL = the global setting, used by any outlet without one of its own. */
  outletId: z.string().uuid().nullable().optional(),
  templateId: z.string().uuid('An exam template is required to auto-schedule from'),
  notifyDaysBefore: z.coerce.number().int().min(0).max(30).default(3),
  reminderDayBefore: z.boolean().default(true),
  reminderMorningOf: z.boolean().default(true),
})

const previewQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
})

type UpsertConfigInput = z.infer<typeof upsertConfigSchema>

export function buildSchedulingRouter(deps: Deps) {
  const scheduler = new SchedulerService(deps.prisma, deps.logger)
  const router = Router()

  // §5.3 GET /api/v1/exam-schedule-config
  router.get('/', requirePermission('exam:override_schedule'), (_req, res, next) => {
    void (async () => {
      try {
        const configs = await deps.prisma.examScheduleConfig.findMany({
          include: {
            outlet: { select: { id: true, name: true, code: true } },
            template: { select: { id: true, nameEn: true } },
          },
          orderBy: { createdAt: 'asc' },
        })
        res.json(ok(configs))
      } catch (err) {
        next(err)
      }
    })()
  })

  // §5.3 PUT /api/v1/exam-schedule-config
  router.put(
    '/',
    requirePermission('exam:override_schedule'),
    validate({ body: upsertConfigSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as UpsertConfigInput

          const template = await deps.prisma.examTemplate.findUnique({
            where: { id: body.templateId },
          })
          if (!template?.isActive) {
            throw ApiError.validation('Unknown exam template', [
              { field: 'templateId', message: 'No such active template' },
            ])
          }

          if (body.outletId) {
            const outlet = await deps.prisma.outlet.findUnique({ where: { id: body.outletId } })
            if (!outlet?.isActive) {
              throw ApiError.validation('Unknown outlet', [
                { field: 'outletId', message: 'No such active outlet' },
              ])
            }
          }

          // One config per outlet, and one global. §4.1 has no unique
          // constraint on outlet_id, so a second config for the same outlet
          // would silently double-schedule it.
          const existing = await deps.prisma.examScheduleConfig.findFirst({
            where: { outletId: body.outletId ?? null },
          })

          const data = {
            dayOfMonth: body.dayOfMonth,
            fallbackRule: body.fallbackRule,
            isActive: body.isActive,
            outletId: body.outletId ?? null,
            templateId: body.templateId,
            notifyDaysBefore: body.notifyDaysBefore,
            reminderDayBefore: body.reminderDayBefore,
            reminderMorningOf: body.reminderMorningOf,
          }

          const config = existing
            ? await deps.prisma.examScheduleConfig.update({ where: { id: existing.id }, data })
            : await deps.prisma.examScheduleConfig.create({
                data: { ...data, tenantId: currentTenantId() },
              })

          res.json(ok(config))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  /**
   * Shows the dates the current configuration will produce.
   *
   * Not in §5.3, but §12.1's weekend rule is exactly the sort of thing an
   * operator should be able to see rather than trust — "why is May's exam on
   * the 17th?" has an answer here.
   */
  router.get(
    '/preview',
    requirePermission('exam:override_schedule'),
    validate({ query: previewQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { months } = req.valid!.query as z.infer<typeof previewQuerySchema>
          const config = await deps.prisma.examScheduleConfig.findFirst({
            where: { isActive: true, outletId: null },
          })

          const now = new Date()
          const start = istMonthOf(now)
          const preview = Array.from({ length: months }, (_, i) => {
            const month = ((start.month - 1 + i) % 12) + 1
            const year = start.year + Math.floor((start.month - 1 + i) / 12)
            return {
              year,
              month,
              ...resolveExamDate(year, month, config?.dayOfMonth ?? 15, config?.fallbackRule),
            }
          })

          res.json(ok(preview))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  /**
   * §5.3 POST /api/v1/exam-schedule-config/trigger-now — the manual trigger.
   *
   * §3.2's "Override auto-schedule" row restricts this to super_admin and admin.
   * It is also the only way to test the job without waiting for the 1st.
   */
  router.post('/trigger-now', requirePermission('exam:override_schedule'), (req, res, next) => {
    void (async () => {
      try {
        // Accept an explicit month so an admin can re-run a month the job
        // missed — e.g. the API was down on the 1st.
        const asOf =
          typeof req.query['asOf'] === 'string' ? new Date(req.query['asOf']) : new Date()
        if (Number.isNaN(asOf.getTime())) {
          throw ApiError.validation('Invalid asOf date', [
            { field: 'asOf', message: 'Must be an ISO date' },
          ])
        }

        const run = await scheduler.run(asOf)
        res.json(ok(run))
      } catch (err) {
        next(err)
      }
    })()
  })

  return router
}
