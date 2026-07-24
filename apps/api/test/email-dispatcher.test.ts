import { describe, it, expect, beforeEach } from 'vitest'
import { pino } from 'pino'
import { EmailDispatcher, type MailSender } from '../src/notifications/dispatcher.js'
import type { SmtpConfig } from '../src/config/env.js'

/**
 * EmailDispatcher — the real delivery channel for password-reset codes.
 *
 * Driven through an injected stub transport, so every branch (a normal send, a
 * missing address, a transport failure) is exercised without a live SMTP server.
 * The properties under test are the ones a reset flow depends on: the code
 * reaches the right inbox, a delivery failure is not swallowed, and the raw code
 * never reaches the log.
 */

const SMTP: SmtpConfig = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  from: 'Bookends <no-reply@bookends.example>',
  auth: { user: 'u', pass: 'p' },
}

interface SentMail {
  from: string
  to: string
  subject: string
  text: string
  html: string
}

/** Captures what would have been sent; `failWith` drives the failure path. */
class StubSender implements MailSender {
  readonly sent: SentMail[] = []
  failWith: Error | null = null

  async sendMail(message: SentMail): Promise<unknown> {
    if (this.failWith) throw this.failWith
    this.sent.push(message)
    return { messageId: 'stub' }
  }
}

let logLines: string[]

function capturingLogger() {
  logLines = []
  return pino(
    { level: 'trace' },
    {
      write(chunk: string) {
        logLines.push(chunk)
      },
    }
  )
}

const message = (over: Partial<{ email: string | null; code: string; expiresAt: Date }> = {}) => ({
  phone: '9876543210',
  email: 'staff@example.com' as string | null,
  code: '481937',
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  ...over,
})

let sender: StubSender

beforeEach(() => {
  sender = new StubSender()
})

describe('EmailDispatcher', () => {
  it('sends the code to the account email, from the configured address', async () => {
    await new EmailDispatcher(SMTP, capturingLogger(), sender).sendPasswordReset(message())

    expect(sender.sent).toHaveLength(1)
    const mail = sender.sent[0]!
    expect(mail.to).toBe('staff@example.com')
    expect(mail.from).toBe(SMTP.from)
    // The code has to be in the body — that is the whole delivery — in both the
    // text and HTML parts, since clients pick one.
    expect(mail.text).toContain('481937')
    expect(mail.html).toContain('481937')
    expect(mail.subject).toMatch(/reset code/i)
  })

  it('states how long the code is valid for', async () => {
    await new EmailDispatcher(SMTP, capturingLogger(), sender).sendPasswordReset(
      message({ expiresAt: new Date(Date.now() + 10 * 60 * 1000) })
    )
    // Rounded from the expiry the message carries, not hardcoded, so the email
    // cannot claim a window the token does not actually have.
    expect(sender.sent[0]!.text).toMatch(/10 minutes/)
  })

  it('throws when the account has no email, so the code can be rolled back', async () => {
    // An account with no address is unreachable by this channel. Throwing rather
    // than quietly returning is what lets AuthService retire the code it created
    // and keeps the caller response identical to an unknown number.
    await expect(
      new EmailDispatcher(SMTP, capturingLogger(), sender).sendPasswordReset(
        message({ email: null })
      )
    ).rejects.toThrow(/no email/i)
    expect(sender.sent, 'nothing should have been sent').toHaveLength(0)
  })

  it('propagates a transport failure instead of swallowing it', async () => {
    sender.failWith = new Error('SMTP 550 mailbox unavailable')

    // A code persisted but never delivered must reach the rollback path, not be
    // silently dropped and left to block recovery for its whole window.
    await expect(
      new EmailDispatcher(SMTP, capturingLogger(), sender).sendPasswordReset(message())
    ).rejects.toThrow(/SMTP 550/)
  })

  it('never writes the raw code to the log stream', async () => {
    const msg = message()
    await new EmailDispatcher(SMTP, capturingLogger(), sender).sendPasswordReset(msg)

    const logged = logLines.join('\n')
    expect(logged.length, 'it should still record that a code was sent').toBeGreaterThan(0)
    expect(logged, 'the code must never reach the log').not.toContain(msg.code)
  })

  it('does not log the email address in the clear', async () => {
    await new EmailDispatcher(SMTP, capturingLogger(), sender).sendPasswordReset(message())

    const logged = logLines.join('\n')
    expect(logged).not.toContain('staff@example.com')
    // Masked, so an operator can still correlate a report with a log line.
    expect(logged).toContain('example.com')
  })
})
