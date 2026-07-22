import { describe, it, expect } from 'vitest'
import request from 'supertest'
import type { DestinationStream } from 'pino'
import { buildApp } from '../src/app.js'
import { createLogger } from '../src/infra/logger.js'
import { loadConfig, type Config } from '../src/config/env.js'
import { MemorySessionStore } from '../src/infra/session-store/memory-store.js'

/**
 * What the request log does and does not contain.
 *
 * Two separate concerns, both previously untested:
 *
 *  1. **Secrets must never reach the log.** `createLogger`'s redact list is a
 *     security control — without it every login writes a plaintext password and
 *     every authenticated call writes a bearer token. Its docblock says as much,
 *     but nothing checked it, so it was an assumption rather than a guarantee.
 *
 *  2. **Development stays readable.** pino-http's default serialisers emit every
 *     header on every request — roughly twenty lines of JSON per call, which
 *     buries the boot banner and any real error. Production keeps the full
 *     record, because that is what makes an incident reconstructable.
 */
const SECRET_TOKEN = 'super-secret-bearer-value'
const SECRET_PASSWORD = 'hunter2-should-never-be-logged'

function captureLogs(isProduction: boolean) {
  const lines: string[] = []
  const destination: DestinationStream = { write: (s: string) => void lines.push(s) }

  const base = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://localhost:5432/unused',
    JWT_SECRET: 'a-secret-long-enough-and-varied-enough-01234',
  })
  // isTest would silence the logger entirely, which is the one thing that would
  // make these assertions pass vacuously.
  const config: Config = Object.freeze({ ...base, isProduction, isTest: false })

  const app = buildApp({
    config,
    logger: createLogger(config, destination),
    prisma: {} as never,
    sessionStore: new MemorySessionStore(async () => null),
  })

  return { app, output: () => lines.join('') }
}

describe('request logging', () => {
  for (const isProduction of [true, false]) {
    const mode = isProduction ? 'production' : 'development'

    it(`never writes a bearer token to the log (${mode})`, async () => {
      const { app, output } = captureLogs(isProduction)

      await request(app)
        .get('/api/v1/health')
        .set('Authorization', `Bearer ${SECRET_TOKEN}`)
        .set('Cookie', `bookends_rt=${SECRET_TOKEN}`)

      expect(output()).not.toContain(SECRET_TOKEN)
    })

    it(`never writes a submitted password to the log (${mode})`, async () => {
      const { app, output } = captureLogs(isProduction)

      // 401 or 400 — irrelevant. What matters is what reached the log on the way.
      await request(app)
        .post('/api/v1/auth/login')
        .send({ phone: '9876543210', password: SECRET_PASSWORD })

      expect(output()).not.toContain(SECRET_PASSWORD)
    })
  }

  it('logs the full request in production, so incidents stay reconstructable', async () => {
    const { app, output } = captureLogs(true)
    await request(app).get('/api/v1/health')

    const logged = output()
    expect(logged).toContain('"headers"')
    expect(logged).toContain('"remoteAddress"')
  })

  it('logs one compact line per request in development', async () => {
    const { app, output } = captureLogs(false)
    await request(app).get('/api/v1/health')

    const logged = output()
    expect(logged).not.toContain('"headers"')
    expect(logged).toContain('GET /api/v1/health → 200')

    // The point of the change: a request costs a line, not a screen.
    expect(logged.trim().length).toBeLessThan(400)
  })
})
