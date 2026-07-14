import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { StaffService } from './staff.service.js'

/**
 * §5.3's staff self-service API, backing the §8.5 dashboard.
 *
 * Everything here is implicitly scoped to the caller — there is no :id. A staff
 * member cannot ask for someone else's profile because the route offers no way
 * to name one.
 */
export function buildStaffRouter(deps: Deps) {
  const service = new StaffService(deps.prisma)
  const router = Router()

  /**
   * A User without an Employee is a legitimate state — the bootstrap super
   * admin is exactly that — but it has no self-service profile to show.
   */
  const employeeIdOf = (req: Parameters<typeof requirePrincipal>[0]) => {
    const principal = requirePrincipal(req)
    if (!principal.employeeId) {
      throw ApiError.notFound('Your account has no employee profile')
    }
    return principal.employeeId
  }

  // §5.3 GET /api/v1/staff/profile
  router.get('/profile', requirePermission('employee:read'), (req, res, next) => {
    void (async () => {
      try {
        res.json(ok(await service.profile(employeeIdOf(req))))
      } catch (err) {
        next(err)
      }
    })()
  })

  // §8.5 dashboard summary
  router.get('/dashboard', requirePermission('employee:read'), (req, res, next) => {
    void (async () => {
      try {
        res.json(ok(await service.dashboard(employeeIdOf(req))))
      } catch (err) {
        next(err)
      }
    })()
  })

  // §5.3 GET /api/v1/staff/certificates
  router.get('/certificates', requirePermission('employee:read'), (req, res, next) => {
    void (async () => {
      try {
        res.json(ok(await service.certificates(employeeIdOf(req))))
      } catch (err) {
        next(err)
      }
    })()
  })

  // §5.3 GET /api/v1/staff/performance
  router.get('/performance', requirePermission('employee:read'), (req, res, next) => {
    void (async () => {
      try {
        res.json(ok(await service.performance(employeeIdOf(req))))
      } catch (err) {
        next(err)
      }
    })()
  })

  return router
}
