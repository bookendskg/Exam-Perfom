import { createPrismaClient } from '@bookends/db'
import { loadConfig } from './config/env.js'
import { createLogger } from './infra/logger.js'
import { createSessionStore } from './infra/session-store/index.js'
import { assertUtf8Database, assertTrilingualRoundTrip } from './infra/assert-utf8.js'
import { buildApp } from './app.js'
import { startExamScheduler } from './scheduling/cron.js'

/**
 * Process entry point. Owns the socket and the shutdown sequence; app.ts owns
 * the middleware.
 */
async function main() {
  const config = loadConfig()
  const logger = createLogger(config)
  const prisma = createPrismaClient(config.DATABASE_URL)
  const sessionStore = createSessionStore(config, prisma)

  // Before accepting a single request: a non-UTF8 database accepts ASCII and
  // then rejects the first Hindi question, which would look like an
  // application bug months after deployment (§6).
  await assertUtf8Database(prisma)
  await assertTrilingualRoundTrip(prisma)

  const app = buildApp({ config, logger, prisma, sessionStore })

  // Started here rather than in buildApp: every test calls buildApp, and none
  // of them should spawn a background timer that outlives the test.
  const scheduler = startExamScheduler(prisma, logger)

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, sessionStore: config.SESSION_STORE },
      'API listening'
    )

    /**
     * The structured log above carries the port as a JSON field, which a
     * terminal cannot turn into a link — there is no URL text in it to click.
     * Outside production, print the address plainly so there is.
     */
    if (!config.isProduction) {
      const url = `http://localhost:${config.PORT}`
      process.stdout.write(
        `\n  Bookends API ready\n` +
          `    API     ${url}/api/v1\n` +
          `    Health  ${url}/api/v1/health\n\n`
      )
    }
  })

  // Drain in-flight requests before dropping the database connection, or a
  // deploy returns 500s to whoever was mid-request.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down')
    scheduler.stop()
    server.close(async () => {
      await prisma.$disconnect()
      process.exit(0)
    })
    setTimeout(() => {
      logger.error('Forced shutdown after 10s timeout')
      process.exit(1)
    }, 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  /**
   * "Can't reach database server" is the single most common way this fails on
   * a fresh checkout, and a raw Prisma stack trace does not tell you the one
   * thing you need to know: the database is a separate process you have to
   * start. Say so, then still print the error.
   */
  const message = error instanceof Error ? error.message : String(error)
  if (/reach database server|ECONNREFUSED|P1001/i.test(message)) {
    console.error(
      `\n  Cannot reach the database at the URL in .env\n\n` +
        `  If you are using the bundled one, start it first, in its own terminal:\n` +
        `      npm run db:dev\n\n` +
        `  Otherwise point DATABASE_URL at a PostgreSQL 15+ instance you have.\n`
    )
  }

  console.error('Failed to start API:', error)
  process.exit(1)
})
