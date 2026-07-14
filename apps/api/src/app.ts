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
import { requirePasswordChange } from './auth/middleware/require-password-change.js'
import { buildAuthRouter } from './auth/auth.routes.js'
import { buildEmployeeRouter } from './employees/employee.routes.js'

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
  const { config, logger } = deps
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

  // Everything mounted below this point is authenticated, rate-limited per role
  // (§5.4), and blocked while a password change is outstanding (§7.3).
  //
  // Note this also means an unknown /api/v1/* path returns 401 rather than 404
  // for an anonymous caller. That is deliberate — a 404 here would let anyone
  // enumerate which endpoints exist.
  app.use('/api/v1', requireAuth, roleLimiter(), requirePasswordChange())

  app.use('/api/v1/employees', buildEmployeeRouter(deps))

  app.use(notFoundHandler)
  app.use(errorHandler(logger))

  return app
}
