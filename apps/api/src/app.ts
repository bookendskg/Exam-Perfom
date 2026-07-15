import express, { type Application, type Request, type Response } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import { pinoHttp } from 'pino-http'
import type { Logger } from 'pino'
import type { PrismaClient } from '@bookends/db'
import { withTenantScope } from '@bookends/db'
import { ok } from '@bookends/core'
import type { Config } from './config/env.js'
import type { SessionStore } from './infra/session-store/index.js'
import { errorHandler, notFoundHandler } from './http/middleware/error-handler.js'
import { roleLimiter } from './http/middleware/rate-limit.js'
import { markPublic } from './rbac/require-permission.js'
import { requirePasswordChange } from './auth/middleware/require-password-change.js'
import { tenantScope } from './tenant/tenant.middleware.js'
import { buildAuthRouter } from './auth/auth.routes.js'
import { buildEmployeeRouter } from './employees/employee.routes.js'
import { buildStaffRouter } from './staff/staff.routes.js'
import { buildStaffExamRouter } from './staff-exams/staff-exam.routes.js'
import { buildOrganisationRouters } from './organisation/organisation.routes.js'
import { buildQuestionRouters } from './questions/question.routes.js'
import { buildExamRouters } from './exams/exam.routes.js'
import { buildSchedulingRouter } from './scheduling/scheduling.routes.js'
import { buildGradingRouter } from './grading/grading.routes.js'
import { buildAnalyticsRouter } from './analytics/analytics.routes.js'

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
export function buildApp(rawDeps: Deps): Application {
  const { config, logger } = rawDeps

  /**
   * Every service below gets the tenant-scoped client, never the raw one.
   *
   * Wrapped here, once, rather than at each construction site: a service that
   * could be handed either client is a service someone will eventually hand the
   * wrong one. There is exactly one client in this process, and it is guarded.
   */
  const deps: Deps = { ...rawDeps, prisma: withTenantScope(rawDeps.prisma) }

  const app = express()

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
    app.use(pinoHttp({ logger }))
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

  // Everything mounted below this point is authenticated, tenant-scoped,
  // rate-limited per role (§5.4), and blocked while a password change is
  // outstanding (§7.3).
  //
  // Note this also means an unknown /api/v1/* path returns 401 rather than 404
  // for an anonymous caller. That is deliberate — a 404 here would let anyone
  // enumerate which endpoints exist.
  //
  // tenantScope() sits immediately after requireAuth, so no route below can run
  // a query outside its tenant: the extension refuses an unscoped query, so
  // forgetting to mount it fails loudly rather than leaking quietly.
  app.use('/api/v1', requireAuth, tenantScope(), roleLimiter(), requirePasswordChange())

  app.use('/api/v1/employees', buildEmployeeRouter(deps))
  // Mounted before /staff so /staff/exams is not swallowed by it.
  app.use('/api/v1/staff/exams', buildStaffExamRouter(deps))
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
  app.use('/api/v1/analytics', buildAnalyticsRouter(deps))

  app.use(notFoundHandler)
  app.use(errorHandler(logger))

  return app
}
