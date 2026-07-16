import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { TrainingService } from './training.service.js'
import {
  assignTrainingSchema,
  completeTrainingSchema,
  listTrainingQuerySchema,
  recommendQuerySchema,
  trainingIdParamSchema,
  type AssignTrainingInput,
  type CompleteTrainingInput,
  type ListTrainingQuery,
  type RecommendQuery,
} from './training.schemas.js'

/** §5.3's /api/v1/training. */
export function buildTrainingRouter(deps: Deps) {
  const training = new TrainingService(deps.prisma)
  const router = Router()

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  // GET /api/v1/training
  router.get(
    '/',
    requirePermission('training:assign'),
    validate({ query: listTrainingQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as ListTrainingQuery
          const { rows, meta } = await training.list(requirePrincipal(req), scopeOf(req), query)
          res.json(ok(rows, meta))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  /**
   * GET /api/v1/training/recommendations — §18.
   *
   * Mounted above /:id so "recommendations" is never read as an id.
   *
   * A proposal, not an action: nothing is written. Whoever reads this decides
   * what to assign, which is what §13 means by "recommendations" — a threshold
   * that silently generated homework would be a different feature, and a worse
   * one.
   */
  router.get(
    '/recommendations',
    requirePermission('training:assign'),
    validate({ query: recommendQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as RecommendQuery
          res.json(ok(await training.recommend(requirePrincipal(req), scopeOf(req), query)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // POST /api/v1/training
  router.post(
    '/',
    requirePermission('training:assign'),
    validate({ body: assignTrainingSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as AssignTrainingInput
          const created = await training.assign(requirePrincipal(req), scopeOf(req), body)
          res.status(201).json(ok(created))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  /**
   * POST /api/v1/training/:id/start and /complete.
   *
   * Guarded by training:assign, which staff do NOT have — but the service also
   * allows an employee to act on their OWN assignment regardless of scope.
   * That is deliberate and it is §13's model: this is "have you read the SOP",
   * not an exam, and requiring a supervisor to witness reading is how a feature
   * goes unused. The staff-facing route lives under /api/v1/staff.
   */
  router.post(
    '/:id/start',
    requirePermission('training:assign'),
    validate({ params: trainingIdParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await training.start(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.post(
    '/:id/complete',
    requirePermission('training:assign'),
    validate({ params: trainingIdParamSchema, body: completeTrainingSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const body = req.valid!.body as CompleteTrainingInput
          res.json(ok(await training.complete(requirePrincipal(req), scopeOf(req), id, body)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
