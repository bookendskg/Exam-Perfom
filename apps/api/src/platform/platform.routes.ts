import { Router } from 'express'
import { z } from 'zod'
import { ok, pageMeta } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { loginLimiter, publicLimiter } from '../http/middleware/rate-limit.js'
import { markPublic } from '../rbac/require-permission.js'
import { PlatformService } from './platform.service.js'
import { PlatformTokenService } from './platform-token.service.js'
import {
  requirePlatformAuth,
  requirePlatformRole,
  requirePlatformPrincipal,
} from './platform-auth.middleware.js'

/**
 * §8.1's /api/platform/v1 — the SaaS owner's API.
 *
 * Mounted in app.ts ABOVE the tenant auth chain, because none of it is
 * tenant-scoped: there is no tenant to resolve, and tenantScope() would refuse
 * every request. Its own guard is requirePlatformAuth, which verifies against a
 * different secret entirely.
 *
 * Deliberately NOT here: tenant creation. Onboarding (§5.1) is self-service and
 * has its own flow — an operator hand-creating tenants would need to duplicate
 * the default departments, designations and owner account that the signup path
 * seeds, and two provisioning paths that must stay identical is how they drift.
 */
const loginSchema = z.object({
  email: z.string().trim().email('A valid email is required'),
  password: z.string().min(1, 'Password is required'),
})

const listSchema = z.object({
  status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'suspended']).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

const tenantIdSchema = z.object({ id: z.string().uuid('Not a tenant id') })

const suspendSchema = z.object({
  // Required, and not a courtesy: this is the text that answers "why is our
  // portal down" three months later. §20.2's trail is worthless without it.
  reason: z.string().trim().min(1, 'A reason is required').max(500),
})

const planSchema = z.object({ planCode: z.string().trim().min(1) })

export function buildPlatformRouter(deps: Deps) {
  const platform = new PlatformService(deps.prisma)
  const tokens = new PlatformTokenService(deps.config)
  const router = Router()

  const auth = requirePlatformAuth(tokens, platform)
  const context = (req: { ip?: string; get(name: string): string | undefined }) => ({
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })

  // POST /api/platform/v1/auth/login
  router.post(
    '/auth/login',
    markPublic(),
    publicLimiter(),
    loginLimiter(),
    validate({ body: loginSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as z.infer<typeof loginSchema>
          const admin = await platform.login(body.email, body.password)
          const accessToken = await tokens.sign({ sub: admin.adminId, role: admin.role })

          res.json(
            ok({
              accessToken,
              expiresIn: deps.config.PLATFORM_JWT_ACCESS_TTL_SECONDS,
              admin: { id: admin.adminId, role: admin.role },
            })
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // GET /api/platform/v1/me
  router.get('/me', auth, (req, res, next) => {
    void (async () => {
      try {
        const principal = requirePlatformPrincipal(req)
        res.json(ok(await platform.findAdmin(principal.adminId)))
      } catch (err) {
        next(err)
      }
    })()
  })

  // GET /api/platform/v1/tenants
  router.get('/tenants', auth, validate({ query: listSchema }), (req, res, next) => {
    void (async () => {
      try {
        const query = req.valid!.query as z.infer<typeof listSchema>
        const { rows, total } = await platform.listTenants(query)
        res.json(ok(rows, pageMeta(query.page, query.limit, total)))
      } catch (err) {
        next(err)
      }
    })()
  })

  // GET /api/platform/v1/tenants/:id
  router.get('/tenants/:id', auth, validate({ params: tenantIdSchema }), (req, res, next) => {
    void (async () => {
      try {
        const { id } = req.valid!.params as z.infer<typeof tenantIdSchema>
        res.json(ok(await platform.getTenant(id)))
      } catch (err) {
        next(err)
      }
    })()
  })

  // POST /api/platform/v1/tenants/:id/suspend — super_admin only.
  router.post(
    '/tenants/:id/suspend',
    auth,
    requirePlatformRole('super_admin'),
    validate({ params: tenantIdSchema, body: suspendSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as z.infer<typeof tenantIdSchema>
          const { reason } = req.valid!.body as z.infer<typeof suspendSchema>
          const principal = requirePlatformPrincipal(req)

          res.json(ok(await platform.suspendTenant(principal, id, reason, context(req))))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // POST /api/platform/v1/tenants/:id/activate — super_admin only.
  router.post(
    '/tenants/:id/activate',
    auth,
    requirePlatformRole('super_admin'),
    validate({ params: tenantIdSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as z.infer<typeof tenantIdSchema>
          const principal = requirePlatformPrincipal(req)

          res.json(ok(await platform.activateTenant(principal, id, context(req))))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // PUT /api/platform/v1/tenants/:id/plan — super_admin only.
  router.put(
    '/tenants/:id/plan',
    auth,
    requirePlatformRole('super_admin'),
    validate({ params: tenantIdSchema, body: planSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as z.infer<typeof tenantIdSchema>
          const { planCode } = req.valid!.body as z.infer<typeof planSchema>
          const principal = requirePlatformPrincipal(req)

          res.json(ok(await platform.changePlan(principal, id, planCode, context(req))))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // GET /api/platform/v1/audit-logs
  router.get(
    '/audit-logs',
    auth,
    validate({ query: listSchema.extend({ tenantId: z.string().uuid().optional() }) }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as { tenantId?: string; page: number; limit: number }
          const { rows, total } = await platform.listAuditLogs(query)
          res.json(ok(rows, pageMeta(query.page, query.limit, total)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // GET /api/platform/v1/plans — the catalogue, for the tenant-edit screen.
  router.get('/plans', auth, (_req, res, next) => {
    void (async () => {
      try {
        res.json(
          ok(
            await deps.prisma.plan.findMany({
              where: { isActive: true },
              orderBy: { sortOrder: 'asc' },
            })
          )
        )
      } catch (err) {
        next(err)
      }
    })()
  })

  return router
}
