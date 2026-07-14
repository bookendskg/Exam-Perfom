import { createPrismaClient } from '@bookends/db'
import { loadConfig } from './config/env.js'
import { createLogger } from './infra/logger.js'
import { createSessionStore } from './infra/session-store/index.js'
import { assertUtf8Database, assertTrilingualRoundTrip } from './infra/assert-utf8.js'
import { buildApp } from './app.js'

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

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, sessionStore: config.SESSION_STORE },
      'API listening'
    )
  })

  // Drain in-flight requests before dropping the database connection, or a
  // deploy returns 500s to whoever was mid-request.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down')
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

main().catch((error) => {
  console.error('Failed to start API:', error)
  process.exit(1)
})
