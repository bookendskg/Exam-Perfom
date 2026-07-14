import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { EmployeeService } from './employee.service.js'
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  listEmployeesQuerySchema,
  changeStatusSchema,
  employeeIdParamSchema,
  type ChangeStatusInput,
  type CreateEmployeeInput,
  type ListEmployeesQuery,
  type UpdateEmployeeInput,
} from './employee.schemas.js'

export function buildEmployeeRouter(deps: Deps) {
  const service = new EmployeeService(deps.prisma, deps.sessionStore)
  const router = Router()

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  // §5.3 GET /api/v1/employees
  router.get(
    '/',
    requirePermission('employee:read'),
    validate({ query: listEmployeesQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { rows, meta } = await service.list(
            requirePrincipal(req),
            scopeOf(req),
            req.valid!.query as ListEmployeesQuery
          )
          res.json(ok(rows, meta))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /api/v1/employees
  router.post(
    '/',
    requirePermission('employee:create'),
    validate({ body: createEmployeeSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { employee, temporaryPassword } = await service.create(
            requirePrincipal(req),
            scopeOf(req),
            req.valid!.body as CreateEmployeeInput
          )
          // Shown once and never again — it is not stored in plaintext.
          res.status(201).json(ok({ ...employee, temporaryPassword }))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/employees/:id
  router.get(
    '/:id',
    requirePermission('employee:read'),
    validate({ params: employeeIdParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await service.getById(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 PUT /api/v1/employees/:id
  router.put(
    '/:id',
    requirePermission('employee:update'),
    validate({ params: employeeIdParamSchema, body: updateEmployeeSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(
            ok(
              await service.update(
                requirePrincipal(req),
                scopeOf(req),
                id,
                req.valid!.body as UpdateEmployeeInput
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
   * §5.3 DELETE /api/v1/employees/:id
   *
   * Soft delete per §8.4 — "data retained". A hard delete would cascade away
   * the employee's entire exam history, which is the product's whole point.
   */
  router.delete(
    '/:id',
    requirePermission('employee:delete'),
    validate({ params: employeeIdParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(
            ok(
              await service.changeStatus(
                requirePrincipal(req),
                scopeOf(req),
                id,
                'terminated',
                'Deleted via API'
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §8.4 status transitions
  router.post(
    '/:id/status',
    requirePermission('employee:update'),
    validate({ params: employeeIdParamSchema, body: changeStatusSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const body = req.valid!.body as ChangeStatusInput
          res.json(
            ok(
              await service.changeStatus(
                requirePrincipal(req),
                scopeOf(req),
                id,
                body.status,
                body.reason
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /api/v1/employees/:id/timeline
  router.get(
    '/:id/timeline',
    requirePermission('employee:read'),
    validate({ params: employeeIdParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await service.timeline(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
