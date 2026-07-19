import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { GradingService } from './grading.service.js'
import {
  assignmentParamSchema,
  responseParamSchema,
  gradeTheorySchema,
  gradeRubricSchema,
  overrideSchema,
  finaliseSchema,
  queueQuerySchema,
  type GradeTheoryInput,
  type GradeRubricInput,
  type OverrideInput,
  type FinaliseInput,
  type QueueQuery,
} from './grading.schemas.js'

/**
 * §3.2's grading routes — Module 8, mounted at /api/v1/grading.
 *
 * The permission on each route is the §3.2 row it implements, which is why
 * theory and video/image have separate endpoints rather than one polymorphic
 * one: a trainer holding only `grading:theory` must not reach a video answer
 * through a shared gate, and requirePermission takes exactly one permission.
 *
 * Reads are gated on `grading:theory` rather than a reads-everything
 * permission. Its row and `grading:video_image`'s are identical in §3.2, so
 * the queue and the grading screen are visible to exactly the roles that may
 * mark something — and to no one else. Staff hold neither.
 */
export function buildGradingRouter(deps: Deps) {
  const service = new GradingService(deps.prisma)
  const router = Router()

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  // §5.3 GET /api/v1/grading/queue
  router.get(
    '/queue',
    requirePermission('grading:theory'),
    validate({ query: queueQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { rows, meta } = await service.queue(
            requirePrincipal(req),
            scopeOf(req),
            req.valid!.query as QueueQuery
          )
          res.json(ok(rows, meta))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/grading/assignments/:assignmentId
  router.get(
    '/assignments/:assignmentId',
    requirePermission('grading:theory'),
    validate({ params: assignmentParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId } = req.valid!.params as { assignmentId: string }
          res.json(ok(await service.attempt(requirePrincipal(req), scopeOf(req), assignmentId)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  /**
   * §5.3 PUT /api/v1/grading/assignments/:id/theory/:examQuestionId
   *
   * PUT because a mark replaces whatever was there: a grader revising their own
   * figure must not create a second one, and the endpoint has to be safe to
   * retry after a timeout.
   */
  router.put(
    '/assignments/:assignmentId/theory/:examQuestionId',
    requirePermission('grading:theory'),
    validate({ params: responseParamSchema, body: gradeTheorySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId, examQuestionId } = req.valid!.params as {
            assignmentId: string
            examQuestionId: string
          }
          res.json(
            ok(
              await service.gradeTheory(
                requirePrincipal(req),
                scopeOf(req),
                assignmentId,
                examQuestionId,
                req.valid!.body as GradeTheoryInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 PUT /api/v1/grading/assignments/:id/rubric/:examQuestionId
  router.put(
    '/assignments/:assignmentId/rubric/:examQuestionId',
    requirePermission('grading:video_image'),
    validate({ params: responseParamSchema, body: gradeRubricSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId, examQuestionId } = req.valid!.params as {
            assignmentId: string
            examQuestionId: string
          }
          res.json(
            ok(
              await service.gradeRubric(
                requirePrincipal(req),
                scopeOf(req),
                assignmentId,
                examQuestionId,
                req.valid!.body as GradeRubricInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 PUT /api/v1/grading/assignments/:id/responses/:examQuestionId/override
  router.put(
    '/assignments/:assignmentId/responses/:examQuestionId/override',
    requirePermission('grading:override'),
    validate({ params: responseParamSchema, body: overrideSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId, examQuestionId } = req.valid!.params as {
            assignmentId: string
            examQuestionId: string
          }
          res.json(
            ok(
              await service.override(
                requirePrincipal(req),
                scopeOf(req),
                assignmentId,
                examQuestionId,
                req.valid!.body as OverrideInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /api/v1/grading/assignments/:assignmentId/finalise
  router.post(
    '/assignments/:assignmentId/finalise',
    requirePermission('grading:theory'),
    validate({ params: assignmentParamSchema, body: finaliseSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId } = req.valid!.params as { assignmentId: string }
          res.json(
            ok(
              await service.finalise(
                requirePrincipal(req),
                scopeOf(req),
                assignmentId,
                req.valid!.body as FinaliseInput
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
