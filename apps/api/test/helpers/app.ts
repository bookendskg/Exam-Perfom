import type { Application } from 'express'
import { pino } from 'pino'
import { buildApp, type Deps } from '../../src/app.js'
import { loadConfig, type Config } from '../../src/config/env.js'
import { MemorySessionStore } from '../../src/infra/session-store/memory-store.js'
import { PostgresSessionStore } from '../../src/infra/session-store/postgres-store.js'
import { resolveSessionPrincipal } from '../../src/rbac/principal.js'
import { testDb } from './db.js'

export interface TestHarness {
  app: Application
  deps: Deps
  store: MemorySessionStore
  /** Advance the session clock — idle timeouts are 30 min and 2 h (§7.5). */
  advanceClock(ms: number): void
}

export function buildTestApp(overrides: Partial<Config> = {}): TestHarness {
  const config: Config = Object.freeze({
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
      JWT_SECRET: 'test-secret-that-is-definitely-long-enough-to-pass',
      SESSION_STORE: 'memory',
    }),
    ...overrides,
  })

  // A controllable clock: waiting out a 2-hour idle window is not a test.
  let clockOffsetMs = 0
  const now = () => Date.now() + clockOffsetMs
  const store = new MemorySessionStore(async (sessionId) => {
    const resolved = await resolveSessionPrincipal(testDb(), sessionId)
    return resolved?.principal ?? null
  }, now)

  // Both stores now read role and scope from the database on every request, so
  // they agree on authorisation; the memory store only adds a movable clock.
  // Tests that need the real idle-timeout write path still opt into Postgres.
  const sessionStore =
    config.SESSION_STORE === 'postgres' ? new PostgresSessionStore(testDb()) : store

  const deps: Deps = {
    config,
    logger: pino({ level: 'silent' }),
    prisma: testDb(),
    sessionStore,
  }

  return {
    app: buildApp(deps),
    deps,
    store,
    advanceClock: (ms: number) => {
      clockOffsetMs += ms
    },
  }
}
