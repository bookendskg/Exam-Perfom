import { Router, type Request, type Response } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { authenticatedLimiter, loginLimiter, publicLimiter } from '../http/middleware/rate-limit.js'
import { ApiError } from '../http/api-error.js'
import { TokenService } from './token.service.js'
import { SessionService, type DeviceContext, type IssuedSession } from './session.service.js'
import { AuthService } from './auth.service.js'
import { authenticate, requirePrincipal } from './middleware/authenticate.js'
import {
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  verifyResetCodeSchema,
  resetPasswordSchema,
  type LoginInput,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type VerifyResetCodeInput,
  type ResetPasswordInput,
} from './auth.schemas.js'
import { LockoutService } from './lockout.service.js'
import { DevFileDispatcher, UnconfiguredDispatcher } from '../notifications/dispatcher.js'
import { setRefreshCookie, clearRefreshCookie, readRefreshToken } from './cookies.js'

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
  const dispatcher =
    deps.dispatcher ??
    (config.isProduction ? new UnconfiguredDispatcher() : new DevFileDispatcher(logger))
  const lockout = new LockoutService(prisma)
  const auth = new AuthService(prisma, sessions, dispatcher, lockout, logger)

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
          const issued = await auth.login(
            body.phone,
            body.password,
            deviceFrom(req, body.deviceInfo)
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

  // §5.3 POST /api/v1/auth/logout — ends only the calling session.
  router.post('/logout', requireAuth, authenticatedLimiter(30), (req, res, next) => {
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
   * POST /api/v1/auth/logout-all — ends every session this user holds.
   *
   * `revokeAllForUser` already existed and was reachable only as a side effect
   * of changing a password. Someone who believes they are compromised needs a
   * direct way to evict every other device, without first having to invent a
   * new password.
   */
  router.post('/logout-all', requireAuth, authenticatedLimiter(10), (req, res, next) => {
    void (async () => {
      try {
        const principal = requirePrincipal(req)
        await sessions.revokeAllForUser(principal.userId, 'user_revoked_all')
        clearRefreshCookie(res, config)
        res.json(ok({ loggedOut: true, allDevices: true }))
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
    requireAuth,
    // The blanket roleLimiter in app.ts is mounted AFTER this router, so it
    // never reaches these routes — this endpoint had no limiter at all, and it
    // verifies a password. Limit it explicitly.
    authenticatedLimiter(),
    validate({ body: changePasswordSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const principal = requirePrincipal(req)
          const body = req.valid!.body as ChangePasswordInput

          // Returns a NEW session: the identifier is rotated on a credential
          // change, so the caller's previous access and refresh tokens are dead
          // and the client must adopt these.
          const issued = await auth.changePassword(
            principal.userId,
            body.currentPassword,
            body.newPassword,
            deviceFrom(req)
          )
          respondWithSession(res, issued, !req.body?.deviceInfo)
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
          await auth.forgotPassword(body.phone)
          // Always 200, even for an unknown phone — anything else enumerates
          // accounts. The response says nothing about whether one was sent.
          res.json(
            ok({ message: 'If that phone number is registered, a reset code has been sent' })
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

  /**
   * §5.3 POST /api/v1/auth/verify-reset-code — code in, reset token out.
   *
   * Carries the same two limiters as forgot-password and login. The per-code
   * attempt budget bounds guessing at ONE code; these bound how fast an
   * attacker can cycle through many, which is the axis the row counter cannot
   * see. Both are needed.
   */
  router.post(
    '/verify-reset-code',
    publicLimiter(),
    loginLimiter(),
    validate({ body: verifyResetCodeSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as VerifyResetCodeInput
          const token = await auth.verifyResetCode(body.phone, body.code)
          // The token is the credential for the final step. It is returned in
          // the body rather than a cookie because the caller is not yet a
          // session — there is nothing to attach a cookie to.
          res.json(ok({ resetToken: token }))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // Every call re-resolves the principal (a multi-join read), so an unlimited
  // /me is free database load for anyone holding a token.
  router.get('/me', requireAuth, authenticatedLimiter(60), (req, res, next) => {
    try {
      const principal = requirePrincipal(req)
      res.json(
        ok({
          userId: principal.userId,
          role: principal.role,
          employeeId: principal.employeeId,
          outletId: principal.outletId,
          departmentId: principal.departmentId,
          scopedOutletIds: principal.scopedOutletIds,
          mustChangePassword: principal.mustChangePassword,
        })
      )
    } catch (err) {
      next(err)
    }
  })

  /**
   * GET /api/v1/auth/profile — the signed-in user's own account, for display.
   *
   * Separate from /me on purpose. /me is on the session-restore path and runs
   * on every page load; it answers "who is this and what may they do" and is
   * deliberately all identifiers, no joins. This answers "what should we show
   * them about themselves", which needs the outlet, department and designation
   * names resolved — three joins nobody should pay for on every restore.
   *
   * Everything is scoped to the caller's own id, so there is no scope check to
   * make: a user reading their own record is the only thing this can express.
   */
  router.get('/profile', requireAuth, authenticatedLimiter(30), (req, res, next) => {
    void (async () => {
      try {
        const principal = requirePrincipal(req)
        const user = await prisma.user.findUnique({
          where: { id: principal.userId },
          select: {
            phone: true,
            email: true,
            role: true,
            lastLoginAt: true,
            createdAt: true,
            passwordChangedAt: true,
            // Admin and super_admin accounts are not staff and have no employee
            // record at all, so every field behind this is optional.
            employee: {
              select: {
                firstName: true,
                lastName: true,
                employeeCode: true,
                joiningDate: true,
                outlet: { select: { name: true } },
                department: { select: { name: true } },
                designation: { select: { name: true } },
              },
            },
          },
        })

        // The session resolved a moment ago, so this is all but unreachable —
        // it means the account was deleted mid-request.
        if (!user) throw ApiError.unauthenticated()

        const { employee } = user
        res.json(
          ok({
            phone: user.phone,
            email: user.email,
            role: user.role,
            name: employee ? `${employee.firstName} ${employee.lastName}` : null,
            employeeCode: employee?.employeeCode ?? null,
            outlet: employee?.outlet.name ?? null,
            department: employee?.department.name ?? null,
            designation: employee?.designation.name ?? null,
            joinedAt: employee?.joiningDate ?? null,
            lastLoginAt: user.lastLoginAt,
            passwordChangedAt: user.passwordChangedAt,
            createdAt: user.createdAt,
          })
        )
      } catch (err) {
        next(err)
      }
    })()
  })

  // Only these two are consumed (app.ts). `tokens`, `sessions` and `auth` were
  // also returned and used by nobody.
  return { router, requireAuth }
}
