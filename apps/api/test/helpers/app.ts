import type { Application } from 'express'
import { pino } from 'pino'
import { buildApp, type Deps } from '../../src/app.js'
import { loadConfig, type Config } from '../../src/config/env.js'
import { MemorySessionStore } from '../../src/infra/session-store/memory-store.js'
import { PostgresSessionStore } from '../../src/infra/session-store/postgres-store.js'
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
  const store = new MemorySessionStore(now)

  // The memory store caches the Principal, so it cannot observe a scope change
  // (see its docblock). Tests asserting that a privilege was REVOKED must opt
  // into the real store — production uses Postgres, and it is the stricter of
  // the two. Those tests give up the controllable clock in exchange.
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
