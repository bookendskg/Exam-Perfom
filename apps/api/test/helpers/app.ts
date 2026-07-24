import type { Application } from 'express'
import { pino } from 'pino'
import { buildApp, type Deps } from '../../src/app.js'
import { loadConfig, type Config } from '../../src/config/env.js'
import { MemorySessionStore } from '../../src/infra/session-store/memory-store.js'
import { PostgresSessionStore } from '../../src/infra/session-store/postgres-store.js'
import { resolveSessionPrincipal } from '../../src/rbac/principal.js'
import type {
  NotificationDispatcher,
  PasswordResetMessage,
} from '../../src/notifications/dispatcher.js'
import { testDb } from './db.js'

/**
 * Captures reset messages instead of delivering them.
 *
 * The default outside production is DevFileDispatcher, which appends to a file —
 * a test suite has no business writing password-reset tokens to disk, and the
 * captured token is more useful to a test than a file it would have to read
 * back. `failWith` drives the delivery-failure path.
 */
export class RecordingDispatcher implements NotificationDispatcher {
  readonly sent: PasswordResetMessage[] = []
  failWith: Error | null = null
  /**
   * Emulate the email channel's contract: throw for an account with no address.
   * Lets a route-level test exercise the real service rollback for the
   * null-email case without standing up SMTP. Off by default so existing tests
   * are unaffected.
   */
  throwOnMissingEmail = false

  async sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    if (this.failWith) throw this.failWith
    if (this.throwOnMissingEmail && !message.email) {
      throw new Error('No email address on file for password reset delivery')
    }
    this.sent.push(message)
  }
}

export interface TestHarness {
  app: Application
  deps: Deps
  store: MemorySessionStore
  /** Whatever the auth router used to "deliver" reset tokens. */
  dispatcher: RecordingDispatcher
  /** Advance the session clock — idle timeouts are 30 min and 2 h (§7.5). */
  advanceClock(ms: number): void
}

export function buildTestApp(
  overrides: Partial<Config> = {},
  dispatcher: RecordingDispatcher = new RecordingDispatcher()
): TestHarness {
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
    dispatcher,
  }

  return {
    app: buildApp(deps),
    deps,
    store,
    dispatcher,
    advanceClock: (ms: number) => {
      clockOffsetMs += ms
    },
  }
}
