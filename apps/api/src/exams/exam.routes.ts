import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { PlanService } from '../plans/plan.service.js'
import { ExamService } from './exam.service.js'
import { TemplateService } from './template.service.js'
import {
  createExamSchema,
  updateExamSchema,
  createTemplateSchema,
  updateTemplateSchema,
  listExamsQuerySchema,
  assignSchema,
  cancelSchema,
  idParamSchema,
  type AssignInput,
  type CancelInput,
  type CreateExamInput,
  type CreateTemplateInput,
  type ListExamsQuery,
  type UpdateExamInput,
  type UpdateTemplateInput,
} from './exam.schemas.js'

export function buildExamRouters(deps: Deps) {
  // No planGuard on the exam routes: maxExamsPerMonth depends on the exam's
  // scheduledDate and is enforced inside ExamService's transaction, which is
  // also the only place that covers the auto-scheduling cron.
  const exams = new ExamService(deps.prisma, new PlanService(deps.prisma))
  const templates = new TemplateService(deps.prisma)

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  const templateRouter = Router()

  templateRouter.get('/', requirePermission('exam_template:read'), (req, res, next) => {
    void (async () => {
      try {
        res.json(ok(await templates.list(requirePrincipal(req), scopeOf(req))))
      } catch (err) {
        next(err)
      }
    })()
  })

  templateRouter.post(
    '/',
    requirePermission('exam_template:create'),
    validate({ body: createTemplateSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const created = await templates.create(
            requirePrincipal(req),
            scopeOf(req),
            req.valid!.body as CreateTemplateInput
          )
          res.status(201).json(ok(created))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  templateRouter.get(
    '/:id',
    requirePermission('exam_template:read'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await templates.getById(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  templateRouter.put(
    '/:id',
    requirePermission('exam_template:create'),
    validate({ params: idParamSchema, body: updateTemplateSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(
            ok(
              await templates.update(
                requirePrincipal(req),
                scopeOf(req),
                id,
                req.valid!.body as UpdateTemplateInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  const examRouter = Router()

  examRouter.get(
    '/',
    requirePermission('exam:read'),
    validate({ query: listExamsQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { rows, meta } = await exams.list(
            requirePrincipal(req),
            scopeOf(req),
            req.valid!.query as ListExamsQuery
          )
          res.json(ok(rows, meta))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  examRouter.post(
    '/',
    requirePermission('exam:schedule'),
    validate({ body: createExamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { exam, shortfalls } = await exams.create(
            requirePrincipal(req),
            scopeOf(req),
            req.valid!.body as CreateExamInput
          )
          // Shortfalls ride along: §11.1 is a build flow, and an unsatisfiable
          // rule is something to fix before publishing, not a reason to refuse
          // the draft. §11.3 blocks the publish itself.
          res.status(201).json(ok({ ...exam, shortfalls }))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  examRouter.get(
    '/:id',
    requirePermission('exam:read'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await exams.getById(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  examRouter.put(
    '/:id',
    requirePermission('exam:schedule'),
    validate({ params: idParamSchema, body: updateExamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(
            ok(
              await exams.update(
                requirePrincipal(req),
                scopeOf(req),
                id,
                req.valid!.body as UpdateExamInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  /** §11.1 step 8's "Review" — run §11.3's checks without publishing. */
  examRouter.get(
    '/:id/validate',
    requirePermission('exam:read'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await exams.validate(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /exams/:id/publish — draft → scheduled, gated by §11.3.
  examRouter.post(
    '/:id/publish',
    requirePermission('exam:schedule'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const { exam, warnings } = await exams.publish(requirePrincipal(req), scopeOf(req), id)
          res.json(ok({ ...exam, warnings }))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  examRouter.post(
    '/:id/cancel',
    requirePermission('exam:schedule'),
    validate({ params: idParamSchema, body: cancelSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const body = req.valid!.body as CancelInput
          res.json(ok(await exams.cancel(requirePrincipal(req), scopeOf(req), id, body.reason)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  examRouter.post(
    '/:id/assign',
    requirePermission('exam:schedule'),
    validate({ params: idParamSchema, body: assignSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(
            ok(
              await exams.assign(
                requirePrincipal(req),
                scopeOf(req),
                id,
                req.valid!.body as AssignInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  examRouter.get(
    '/:id/assignments',
    requirePermission('exam:read'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await exams.assignments(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return { examRouter, templateRouter }
}
