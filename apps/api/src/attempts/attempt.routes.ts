import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { AttemptService } from './attempt.service.js'
import {
  assignmentParamSchema,
  responseParamSchema,
  startAttemptSchema,
  saveResponseSchema,
  listAttemptsQuerySchema,
  type ListAttemptsQuery,
  type SaveResponseInput,
  type StartAttemptInput,
} from './attempt.schemas.js'

/**
 * §5.3's exam-taking routes, mounted under /api/v1/staff/exams.
 *
 * Like the rest of /staff, no route names an employee — the assignment id is
 * the only identifier a candidate supplies, and the service scopes every query
 * by the session's employee. `exam:take` is staff-only per §3.2, so an admin
 * calling these gets 403 from the route gate before any query runs.
 */
export function buildAttemptRouter(deps: Deps) {
  const service = new AttemptService(deps.prisma)
  const router = Router()

  const employeeIdOf = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req)
    if (!principal.employeeId) {
      throw ApiError.notFound('Your account has no employee profile')
    }
    return principal.employeeId
  }

  // §5.3 GET /api/v1/staff/exams
  router.get(
    '/',
    requirePermission('result:read_own'),
    validate({ query: listAttemptsQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as ListAttemptsQuery
          res.json(ok(await service.list(employeeIdOf(req), query)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /api/v1/staff/exams/:assignmentId/start
  router.post(
    '/:assignmentId/start',
    requirePermission('exam:take'),
    validate({ params: assignmentParamSchema, body: startAttemptSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId } = req.valid!.params as { assignmentId: string }
          const paper = await service.start(
            employeeIdOf(req),
            assignmentId,
            req.valid!.body as StartAttemptInput,
            // §4.1 records the attempt's IP for §8's integrity checks. Express
            // resolves this through `trust proxy`, which app.ts configures.
            { ipAddress: req.ip }
          )
          res.json(ok(paper))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/staff/exams/:assignmentId/paper — resume
  router.get(
    '/:assignmentId/paper',
    requirePermission('exam:take'),
    validate({ params: assignmentParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId } = req.valid!.params as { assignmentId: string }
          res.json(ok(await service.paper(employeeIdOf(req), assignmentId)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  /**
   * §5.3 PUT /api/v1/staff/exams/:assignmentId/responses/:examQuestionId
   *
   * PUT rather than POST: this is an autosave that replaces one answer, and it
   * must be safe for the APK to retry after a timeout without creating a
   * second response or double-counting anything.
   */
  router.put(
    '/:assignmentId/responses/:examQuestionId',
    requirePermission('exam:take'),
    validate({ params: responseParamSchema, body: saveResponseSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId, examQuestionId } = req.valid!.params as {
            assignmentId: string
            examQuestionId: string
          }
          res.json(
            ok(
              await service.saveResponse(
                employeeIdOf(req),
                assignmentId,
                examQuestionId,
                req.valid!.body as SaveResponseInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /api/v1/staff/exams/:assignmentId/submit
  router.post(
    '/:assignmentId/submit',
    requirePermission('exam:take'),
    validate({ params: assignmentParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId } = req.valid!.params as { assignmentId: string }
          res.json(ok(await service.submit(employeeIdOf(req), assignmentId)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/staff/exams/:assignmentId/result
  router.get(
    '/:assignmentId/result',
    requirePermission('result:read_own'),
    validate({ params: assignmentParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { assignmentId } = req.valid!.params as { assignmentId: string }
          res.json(ok(await service.result(employeeIdOf(req), assignmentId)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
