import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { pino } from 'pino'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevFileDispatcher, UnconfiguredDispatcher } from '../src/notifications/dispatcher.js'

/**
 * B2 — a password reset token is a password equivalent for its whole 30-minute
 * window, and it used to be written to the logger at warn level.
 *
 * The log stream is the one destination in the system designed to be copied
 * somewhere else: terminal scrollback, CI job output, and whatever aggregator
 * the app is eventually pointed at. "Development only" was no defence either,
 * because NODE_ENV defaults to `development` and an unconfigured deployment is
 * precisely where nobody is watching the logs.
 */
let dir: string
let path: string
let lines: string[]

function capturingLogger() {
  lines = []
  return pino(
    { level: 'trace' },
    {
      write(chunk: string) {
        lines.push(chunk)
      },
    }
  )
}

const message = () => ({
  phone: '9876543210',
  token: 'tok_SUPERSECRET_do_not_log_me',
  expiresAt: new Date('2026-01-01T00:30:00.000Z'),
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bookends-dispatch-'))
  path = join(dir, 'resets.log')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('DevFileDispatcher', () => {
  it('never writes the raw token to the log stream', async () => {
    const msg = message()
    await new DevFileDispatcher(capturingLogger(), path).sendPasswordReset(msg)

    expect(lines.length, 'it should still say something happened').toBeGreaterThan(0)
    const logged = lines.join('\n')
    expect(logged, 'the token must not appear anywhere in the log').not.toContain(msg.token)
  })

  it('does not log the phone number in the clear either', async () => {
    const msg = message()
    await new DevFileDispatcher(capturingLogger(), path).sendPasswordReset(msg)

    const logged = lines.join('\n')
    expect(logged).not.toContain(msg.phone)
    // Masked rather than dropped, so an operator can still correlate a log line
    // with a support report about "the number ending 10".
    expect(logged).toContain('10')
  })

  it('writes the token to the file, so the dev flow still works end to end', async () => {
    const msg = message()
    await new DevFileDispatcher(capturingLogger(), path).sendPasswordReset(msg)

    const contents = await readFile(path, 'utf8')
    expect(contents).toContain(msg.token)
    expect(contents).toContain(msg.expiresAt.toISOString())
  })

  it('appends rather than truncating, so a second reset does not erase the first', async () => {
    const dispatcher = new DevFileDispatcher(capturingLogger(), path)
    await dispatcher.sendPasswordReset({ ...message(), token: 'first_token' })
    await dispatcher.sendPasswordReset({ ...message(), token: 'second_token' })

    const contents = await readFile(path, 'utf8')
    expect(contents).toContain('first_token')
    expect(contents).toContain('second_token')
  })

  it('propagates a write failure instead of swallowing it', async () => {
    // A token that was persisted but never recorded anywhere readable is the
    // same dead end as one that was never delivered — AuthService has to hear
    // about it so it can roll the token back.
    const unwritable = new DevFileDispatcher(capturingLogger(), join(dir, 'nope', 'resets.log'))
    await expect(unwritable.sendPasswordReset(message())).rejects.toThrow()
  })
})

describe('UnconfiguredDispatcher', () => {
  it('refuses rather than silently accepting a reset it cannot deliver', async () => {
    await expect(new UnconfiguredDispatcher().sendPasswordReset()).rejects.toThrow(
      /not configured/i
    )
  })
})
