import { Router, type Request, type Response } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { loginLimiter, publicLimiter } from '../http/middleware/rate-limit.js'
import { ApiError } from '../http/api-error.js'
import { TokenService } from './token.service.js'
import { SessionService, type DeviceContext } from './session.service.js'
import { AuthService } from './auth.service.js'
import { authenticate, requirePrincipal } from './middleware/authenticate.js'
import {
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  type LoginInput,
  type ForgotPasswordInput,
  type ResetPasswordInput,
} from './auth.schemas.js'
import { LoggingDispatcher, UnconfiguredDispatcher } from '../notifications/dispatcher.js'
import { runInTenant } from '@bookends/db'
import { readTenantHint, requireTenant, resolveTenantBySlug } from '../tenant/tenant.resolver.js'
import { tenantScope } from '../tenant/tenant.middleware.js'
import { setRefreshCookie, clearRefreshCookie, readRefreshToken } from './cookies.js'
import type { IssuedSession } from './session.service.js'

function deviceFrom(req: Request, deviceInfo?: unknown): DeviceContext {
  return {
    deviceInfo,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }
}

export function buildAuthRouter(deps: Deps) {
  const { config, logger, prisma, sessionStore } = deps
  const tokens = new TokenService(config)
  const sessions = new SessionService(prisma, sessionStore, tokens, config)
  // No delivery channel exists yet (§13's WhatsApp is a later module). Dev logs
  // the link so the flow is testable; production refuses rather than silently
  // accepting a reset it cannot deliver.
  const dispatcher = config.isProduction
    ? new UnconfiguredDispatcher()
    : new LoggingDispatcher(logger)
  const auth = new AuthService(prisma, sessions, dispatcher)

  const router = Router()
  const requireAuth = authenticate(tokens, sessionStore, sessions)

  /**
   * Shapes the response for both clients. The web app gets the refresh token as
   * an HttpOnly cookie and never sees it in JS; the APK has no cookie jar, so it
   * gets the token in the body.
   */
  const respondWithSession = (res: Response, issued: IssuedSession, wantsCookie: boolean) => {
    if (wantsCookie) setRefreshCookie(res, config, issued.refreshToken)

    res.json(
      ok({
        accessToken: issued.accessToken,
        expiresIn: config.JWT_ACCESS_TTL_SECONDS,
        mustChangePassword: issued.principal.mustChangePassword,
        ...(wantsCookie ? {} : { refreshToken: issued.refreshToken }),
        user: {
          id: issued.principal.userId,
          role: issued.principal.role,
          employeeId: issued.principal.employeeId,
          outletId: issued.principal.outletId,
        },
      })
    )
  }

  // §5.3 POST /api/v1/auth/login
  router.post(
    '/login',
    publicLimiter(),
    loginLimiter(),
    validate({ body: loginSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as LoginInput
          // Before the password is looked at. Which organisation you are
          // logging into is not something we infer from your phone number —
          // see tenant.resolver.ts for why that matters.
          const tenant = await requireTenant(prisma, req)

          // Inside the tenant from here on. The auth router is mounted above
          // the global tenantScope() middleware — it has to be, since it is
          // what establishes the tenant — so login opens its own scope once it
          // knows which one it is talking to.
          const issued = await runInTenant(tenant.tenantId, () =>
            auth.login(tenant.tenantId, body.phone, body.password, deviceFrom(req, body.deviceInfo))
          )
          // An APK login declares itself by sending deviceInfo; browsers do not.
          respondWithSession(res, issued, !body.deviceInfo)
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /api/v1/auth/refresh
  router.post('/refresh', publicLimiter(), validate({ body: refreshSchema }), (req, res, next) => {
    void (async () => {
      try {
        const presented = readRefreshToken(req)
        if (!presented) throw ApiError.unauthenticated('Refresh token is required')

        const issued = await sessions.refresh(presented.token, deviceFrom(req))
        respondWithSession(res, issued, presented.fromCookie)
      } catch (err) {
        next(err)
      }
    })()
  })

  // The authenticated routes below need a tenant scope of their own: this
  // router is mounted above app.ts's global tenantScope(), because it is the
  // thing that establishes the tenant in the first place.
  const scoped = [requireAuth, tenantScope()] as const

  // §5.3 POST /api/v1/auth/logout — ends only the calling session.
  router.post('/logout', ...scoped, (req, res, next) => {
    void (async () => {
      try {
        const principal = requirePrincipal(req)
        await sessions.revoke(principal.sessionId, 'logout')
        clearRefreshCookie(res, config)
        res.json(ok({ loggedOut: true }))
      } catch (err) {
        next(err)
      }
    })()
  })

  /**
   * POST /api/v1/auth/change-password — not in §5.3, but §7.3 mandates
   * force-change-on-first-login and reset-password is token-based (the forgot
   * flow), so there is no endpoint for it otherwise.
   */
  router.post(
    '/change-password',
    ...scoped,
    validate({ body: changePasswordSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const principal = requirePrincipal(req)
          const body = req.valid!.body as { currentPassword: string; newPassword: string }
          await auth.changePassword(
            principal.userId,
            principal.sessionId,
            body.currentPassword,
            body.newPassword
          )
          res.json(ok({ passwordChanged: true }))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /api/v1/auth/forgot-password
  router.post(
    '/forgot-password',
    publicLimiter(),
    loginLimiter(),
    validate({ body: forgotPasswordSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as ForgotPasswordInput

          // Unresolvable tenant is swallowed rather than thrown. This endpoint's
          // whole contract is that it says nothing — answering TENANT_NOT_FOUND
          // here would reinstate the enumeration oracle one field to the left,
          // and let someone map our customer list from the login page.
          const hint = readTenantHint(req)
          const tenant = hint ? await resolveTenantBySlug(prisma, hint.slug) : null
          if (tenant) {
            await runInTenant(tenant.tenantId, () => auth.forgotPassword(tenant.tenantId, body.phone))
          }

          // Always 200, even for an unknown phone — anything else enumerates
          // accounts. The response says nothing about whether one was sent.
          res.json(
            ok({ message: 'If that phone number is registered, a reset link has been sent' })
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /api/v1/auth/reset-password
  router.post(
    '/reset-password',
    publicLimiter(),
    validate({ body: resetPasswordSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as ResetPasswordInput
          await auth.resetPassword(body.token, body.newPassword)
          res.json(ok({ passwordReset: true }))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  router.get('/me', ...scoped, (req, res, next) => {
    try {
      const principal = requirePrincipal(req)
      res.json(
        ok({
          userId: principal.userId,
          role: principal.role,
          employeeId: principal.employeeId,
          outletId: principal.outletId,
          departmentId: principal.departmentId,
          managedOutletIds: principal.managedOutletIds,
          mustChangePassword: principal.mustChangePassword,
        })
      )
    } catch (err) {
      next(err)
    }
  })

  return { router, tokens, sessions, auth, requireAuth }
}
