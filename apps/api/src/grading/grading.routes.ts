import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { GradingService } from './grading.service.js'
import {
  pendingQuerySchema,
  gradeSchema,
  finalizeSchema,
  responseIdParamSchema,
  assignmentIdParamSchema,
  type FinalizeInput,
  type GradeInput,
  type PendingQuery,
} from './grading.schemas.js'

/**
 * §5.3 grading API. Gated on `grading:theory` — §3.2 grants grading to
 * super_admin, admin, outlet_manager (own outlet) and trainer, and denies it to
 * hr and staff. The route gate uses one permission; the service enforces the
 * outlet scope and the override rules.
 */
export function buildGradingRouter(deps: Deps) {
  const service = new GradingService(deps.prisma)
  const router = Router()

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  // §5.3 GET /api/v1/grading/pending
  router.get(
    '/pending',
    requirePermission('grading:theory'),
    validate({ query: pendingQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { rows, meta } = await service.pending(
            requirePrincipal(req),
            scopeOf(req),
            req.valid!.query as PendingQuery
          )
          res.json(ok(rows, meta))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/grading/:exam_assignment_id/responses
  router.get(
    '/:id/responses',
    requirePermission('grading:theory'),
    validate({ params: assignmentIdParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await service.responsesFor(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /api/v1/grading/:response_id/grade
  router.post(
    '/:id/grade',
    requirePermission('grading:theory'),
    validate({ params: responseIdParamSchema, body: gradeSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(
            ok(
              await service.grade(
                requirePrincipal(req),
                scopeOf(req),
                id,
                req.valid!.body as GradeInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /api/v1/grading/:exam_assignment_id/finalize
  router.post(
    '/:id/finalize',
    requirePermission('grading:theory'),
    validate({ params: assignmentIdParamSchema, body: finalizeSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(
            ok(
              await service.finalize(
                requirePrincipal(req),
                scopeOf(req),
                id,
                req.valid!.body as FinalizeInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
