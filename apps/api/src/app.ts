import express, { type Application, type Request, type Response } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import { pinoHttp } from 'pino-http'
import type { Logger } from 'pino'
import type { PrismaClient } from '@bookends/db'
import { ok } from '@bookends/core'
import type { Config } from './config/env.js'
import type { SessionStore } from './infra/session-store/index.js'
import { errorHandler, notFoundHandler } from './http/middleware/error-handler.js'
import { roleLimiter } from './http/middleware/rate-limit.js'
import { markPublic } from './rbac/require-permission.js'
import { PermissionResolver } from './rbac/permission-resolver.js'
import { requirePasswordChange } from './auth/middleware/require-password-change.js'
import { buildAuthRouter } from './auth/auth.routes.js'
import { buildEmployeeRouter } from './employees/employee.routes.js'
import { buildStaffRouter } from './staff/staff.routes.js'
import { buildAttemptRouter } from './attempts/attempt.routes.js'
import { buildOrganisationRouters } from './organisation/organisation.routes.js'
import { buildQuestionRouters } from './questions/question.routes.js'
import { buildExamRouters } from './exams/exam.routes.js'
import { buildSchedulingRouter } from './scheduling/scheduling.routes.js'
import { buildGradingRouter } from './grading/grading.routes.js'

/**
 * Everything the app needs, passed in rather than imported. Tests inject a
 * test-scoped Prisma client and a MemorySessionStore; nothing is a module-level
 * singleton.
 */
export interface Deps {
  config: Config
  logger: Logger
  prisma: PrismaClient
  sessionStore: SessionStore
}

/**
 * Builds the app. Deliberately does NOT listen — supertest needs an app that
 * never binds a port, and main.ts owns the socket.
 */
export function buildApp(deps: Deps): Application {
  const { config, logger, prisma } = deps
  const app = express()

  // §3.2 grants, resolved from the database per request behind a short cache.
  // Placed on app.locals so requirePermission can reach it without every router
  // having to thread it through.
  app.locals.permissions = new PermissionResolver(prisma)

  // Behind nginx every request otherwise carries the proxy's IP, which collapses
  // the §5.4 per-IP rate limiter into a single global bucket.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(helmet())
  app.use(compression())
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use(cookieParser())

  if (config.corsOrigins.length > 0) {
    app.use(cors({ origin: config.corsOrigins, credentials: true }))
  }

  if (!config.isTest) {
    /**
     * Production logs the full request/response — headers included — because
     * that is what makes an incident reconstructable, and the redact list in
     * createLogger() is what keeps tokens and passwords out of it.
     *
     * Development does not want that. pino-http's default serialisers emit
     * every header on every request, which in a terminal is ~20 lines of JSON
     * per call: the boot banner, Vite's URL and any actual error scroll away
     * before you can read them. Dev gets one line per request instead.
     */
    app.use(
      config.isProduction
        ? pinoHttp({ logger })
        : pinoHttp({
            logger,
            serializers: {
              req: (req: { method: string; url: string }) => `${req.method} ${req.url}`,
              res: (res: { statusCode: number }) => res.statusCode,
            },
            customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
            customErrorMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
          })
    )
  }

  app.get('/api/v1/health', markPublic(), (_req: Request, res: Response) => {
    res.json(ok({ status: 'ok', env: config.NODE_ENV }))
  })

  // Test-only: proves the error handler flattens an unexpected throw into the
  // §5.2 envelope without leaking the message. Must be mounted above the auth
  // guard, or it would 401 before it could throw. Never mounted in production.
  if (config.isTest) {
    app.get('/api/v1/__boom', markPublic(), () => {
      throw new Error('boom: this internal detail must not reach the client')
    })
  }

  const { router: authRouter, requireAuth } = buildAuthRouter(deps)
  app.use('/api/v1/auth', authRouter)

  // Everything mounted below this point is authenticated, rate-limited per role
  // (§5.4), and blocked while a password change is outstanding (§7.3).
  //
  // Note this also means an unknown /api/v1/* path returns 401 rather than 404
  // for an anonymous caller. That is deliberate — a 404 here would let anyone
  // enumerate which endpoints exist.
  app.use('/api/v1', requireAuth, roleLimiter(), requirePasswordChange())

  app.use('/api/v1/employees', buildEmployeeRouter(deps))
  // Mounted above /api/v1/staff so /staff/exams/* resolves here. The staff
  // router has no /exams route, so the order is belt and braces rather than
  // load-bearing — but it keeps the two from racing if one ever gains one.
  app.use('/api/v1/staff/exams', buildAttemptRouter(deps))
  app.use('/api/v1/staff', buildStaffRouter(deps))

  const { outletRouter, departmentRouter, designationRouter } = buildOrganisationRouters(deps)
  app.use('/api/v1/outlets', outletRouter)
  app.use('/api/v1/departments', departmentRouter)
  app.use('/api/v1/designations', designationRouter)

  const { questionRouter, topicRouter, documentRouter } = buildQuestionRouters(deps)
  app.use('/api/v1/questions', questionRouter)
  app.use('/api/v1/topics', topicRouter)
  app.use('/api/v1/source-documents', documentRouter)

  const { examRouter, templateRouter } = buildExamRouters(deps)
  app.use('/api/v1/exam-templates', templateRouter)
  app.use('/api/v1/exams', examRouter)
  app.use('/api/v1/exam-schedule-config', buildSchedulingRouter(deps))
  app.use('/api/v1/grading', buildGradingRouter(deps))

  app.use(notFoundHandler)
  app.use(errorHandler(logger))

  return app
}
