import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { OutletService } from './outlet.service.js'
import { OrganisationService } from './organisation.service.js'
import {
  createOutletSchema,
  updateOutletSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  createDesignationSchema,
  updateDesignationSchema,
  idParamSchema,
  listQuerySchema,
  type CreateDepartmentInput,
  type CreateDesignationInput,
  type CreateOutletInput,
  type ListQuery,
  type UpdateDepartmentInput,
  type UpdateDesignationInput,
  type UpdateOutletInput,
} from './organisation.schemas.js'

/** §5.3 outlets, departments and designations. */
export function buildOrganisationRouters(deps: Deps) {
  const outlets = new OutletService(deps.prisma, deps.sessionStore)
  const org = new OrganisationService(deps.prisma)

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  const outletRouter = Router()

  outletRouter.get(
    '/',
    requirePermission('outlet:read'),
    validate({ query: listQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          res.json(ok(await outlets.list(req.valid!.query as ListQuery)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  outletRouter.post(
    '/',
    requirePermission('outlet:manage'),
    validate({ body: createOutletSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          res.status(201).json(ok(await outlets.create(req.valid!.body as CreateOutletInput)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  outletRouter.get(
    '/:id',
    requirePermission('outlet:read'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await outlets.getById(id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  outletRouter.put(
    '/:id',
    requirePermission('outlet:manage'),
    validate({ params: idParamSchema, body: updateOutletSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await outlets.update(id, req.valid!.body as UpdateOutletInput)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 GET /outlets/:id/employees — gated on employee:read, not outlet:read:
  // this is staff data, and outlet:read is granted to everyone.
  outletRouter.get(
    '/:id/employees',
    requirePermission('employee:read'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const principal = requirePrincipal(req)
          const { id } = req.valid!.params as { id: string }
          const scope = scopeOf(req)

          // An outlet_manager may only enumerate their own outlet's roster; a
          // staff member may not enumerate anyone.
          if (scope === 'own_outlet' && !principal.scopedOutletIds.includes(id)) {
            throw ApiError.notFound('Outlet not found')
          }
          if (scope === 'own_resource') throw ApiError.forbidden()

          res.json(ok(await outlets.employees(id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  outletRouter.get(
    '/:id/stats',
    requirePermission('outlet:stats'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await outlets.stats(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  const departmentRouter = Router()

  departmentRouter.get(
    '/',
    requirePermission('department:read'),
    validate({ query: listQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          res.json(ok(await org.listDepartments(req.valid!.query as ListQuery)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  departmentRouter.post(
    '/',
    requirePermission('department:manage'),
    validate({ body: createDepartmentSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          res
            .status(201)
            .json(ok(await org.createDepartment(req.valid!.body as CreateDepartmentInput)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  departmentRouter.put(
    '/:id',
    requirePermission('department:manage'),
    validate({ params: idParamSchema, body: updateDepartmentSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await org.updateDepartment(id, req.valid!.body as UpdateDepartmentInput)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  const designationRouter = Router()

  designationRouter.get(
    '/',
    requirePermission('designation:read'),
    validate({ query: listQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          res.json(ok(await org.listDesignations(req.valid!.query as ListQuery)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  designationRouter.post(
    '/',
    requirePermission('designation:manage'),
    validate({ body: createDesignationSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          res
            .status(201)
            .json(ok(await org.createDesignation(req.valid!.body as CreateDesignationInput)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  designationRouter.put(
    '/:id',
    requirePermission('designation:manage'),
    validate({ params: idParamSchema, body: updateDesignationSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await org.updateDesignation(id, req.valid!.body as UpdateDesignationInput)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return { outletRouter, departmentRouter, designationRouter }
}
