import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { StaffExamService } from './staff-exam.service.js'
import {
  startSchema,
  answerSchema,
  examIdParamSchema,
  type AnswerInput,
  type StartInput,
} from './staff-exam.schemas.js'

/**
 * §5.3's staff exam API, gated on `exam:take` — which §3.2 grants to staff and
 * to nobody else, deliberately: an admin taking an exam would pollute the
 * performance record the whole product exists to keep.
 */
export function buildStaffExamRouter(deps: Deps) {
  const service = new StaffExamService(deps.prisma)
  const router = Router()

  const employeeIdOf = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req)
    if (!principal.employeeId) {
      throw ApiError.notFound('Your account has no employee profile')
    }
    return principal.employeeId
  }

  // §5.3 GET /api/v1/staff/exams
  router.get('/', requirePermission('exam:take'), (req, res, next) => {
    void (async () => {
      try {
        res.json(ok(await service.list(employeeIdOf(req))))
      } catch (err) {
        next(err)
      }
    })()
  })

  /**
   * §5.3 GET /staff/exams/:id/start — a POST despite §5.3's GET.
   *
   * It starts the timer and writes a session row, so it is not a safe method:
   * a GET would let a browser prefetch or a retry burn a candidate's attempt.
   * It also carries §13.1 step 4's honesty declaration, which needs a body.
   */
  router.post(
    '/:id/start',
    requirePermission('exam:take'),
    validate({ params: examIdParamSchema, body: startSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const body = req.valid!.body as StartInput
          res.json(
            ok(
              await service.start(employeeIdOf(req), id, {
                ...body,
                ipAddress: body.ipAddress ?? req.ip,
              })
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /staff/exams/:id/answer — autosave.
  router.post(
    '/:id/answer',
    requirePermission('exam:take'),
    validate({ params: examIdParamSchema, body: answerSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await service.answer(employeeIdOf(req), id, req.valid!.body as AnswerInput)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /staff/exams/:id/submit
  router.post(
    '/:id/submit',
    requirePermission('exam:take'),
    validate({ params: examIdParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await service.submit(employeeIdOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /staff/exams/:id/result
  router.get(
    '/:id/result',
    requirePermission('exam:take'),
    validate({ params: examIdParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await service.result(employeeIdOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
