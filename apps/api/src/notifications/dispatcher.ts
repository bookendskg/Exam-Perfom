import type { Logger } from 'pino'
import nodemailer from 'nodemailer'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ApiError } from '../http/api-error.js'
import type { Config, SmtpConfig } from '../config/env.js'

export interface PasswordResetMessage {
  phone: string
  /**
   * The account's email address, or null when it has none. Non-optional so the
   * service must decide what to send rather than forget it, and so a channel
   * that needs it (email) can fail loudly rather than send to `undefined`.
   */
  email: string | null
  /** The six-digit one-time code the user types back in. */
  code: string
  expiresAt: Date
}

/**
 * Outbound notification channel.
 *
 * §5.3's /auth/forgot-password takes a phone number, but Module 1 has no
 * delivery channel: User.email is optional, and §13's WhatsApp Business API
 * integration is a later module. The Notification model already has a
 * `whatsapp` channel and whatsappStatus, so WhatsApp is the evident intent.
 *
 * Until then this interface is the seam. Nothing else in auth knows how a
 * message gets delivered.
 */
export interface NotificationDispatcher {
  sendPasswordReset(message: PasswordResetMessage): Promise<void>
}

/**
 * Everything but the last two digits, so a log line can be correlated with a
 * report ("the number ending 10") without carrying a staff phone number.
 */
function maskPhone(phone: string): string {
  return phone.length <= 2 ? '**' : `${'*'.repeat(phone.length - 2)}${phone.slice(-2)}`
}

/** First letter and domain kept; the rest of the local part masked. */
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 1) return `*${email.slice(at)}`
  return `${email[0]}***${email.slice(at)}`
}

/** Ethereal's disposable-inbox preview link, or null for any real transport. */
function previewUrlFor(info: unknown): string | null {
  try {
    const url = nodemailer.getTestMessageUrl(
      info as Parameters<typeof nodemailer.getTestMessageUrl>[0]
    )
    return typeof url === 'string' ? url : null
  } catch {
    return null
  }
}

/** Where {@link DevFileDispatcher} writes when the caller does not say. */
export const DEV_RESET_LOG = '.dev-password-resets.log'

/**
 * Development delivery: the reset token goes to a local file, never to the log.
 *
 * A reset token is a password equivalent for its whole 30-minute window, and the
 * previous implementation wrote it to the pino logger at warn level. That is the
 * one destination in the system explicitly designed to be copied elsewhere —
 * scrollback, CI job output, and any aggregator the app is ever pointed at — and
 * it applied outside production only in theory, because NODE_ENV defaults to
 * `development` and an unconfigured deployment is exactly where nobody is
 * watching. Redaction could not save it either: the value is a bare string in
 * the message, not a field an allowlist can find.
 *
 * A gitignored file keeps the flow usable end-to-end on a developer's machine
 * while ensuring the token never enters the log stream and never leaves the box.
 * The logger still records that a reset happened, with the number masked, so the
 * event remains auditable without the secret.
 */
export class DevFileDispatcher implements NotificationDispatcher {
  private readonly path: string
  private announced = false

  constructor(
    private readonly logger: Logger,
    path: string = DEV_RESET_LOG
  ) {
    this.path = resolve(path)
  }

  async sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    const line =
      [
        `[${new Date().toISOString()}]`,
        `phone=${message.phone}`,
        `expires=${message.expiresAt.toISOString()}`,
        `code=${message.code}`,
      ].join(' ') + '\n'

    // Not swallowed. A failure here has to reach AuthService so it can roll the
    // token back — a persisted token nobody can read is the same dead end as a
    // persisted token nobody was sent.
    await appendFile(this.path, line, 'utf8')

    if (!this.announced) {
      // Once per process: the path is the only thing a developer needs, and
      // repeating it on every reset buries the rest of the log.
      this.logger.info({ path: this.path }, 'Password reset tokens are being written here')
      this.announced = true
    }
    this.logger.info(
      { phone: maskPhone(message.phone), expiresAt: message.expiresAt },
      'Password reset dispatched (development file sink)'
    )
  }
}

/**
 * Fails loudly in production rather than accepting a reset request it cannot
 * deliver. A silent no-op would leave staff waiting for a message that is never
 * coming, with nothing in the logs to explain it.
 */
export class UnconfiguredDispatcher implements NotificationDispatcher {
  async sendPasswordReset(): Promise<void> {
    throw ApiError.notImplemented(
      'Password reset delivery is not configured. Contact an administrator to reset your password.'
    )
  }
}

/**
 * The minimal slice of a nodemailer transport this needs.
 *
 * Declared as its own interface so a test can inject a stub — and assert what
 * would have been sent — without a live SMTP server. A real
 * `nodemailer.Transporter` satisfies it structurally.
 */
export interface MailSender {
  sendMail(message: {
    from: string
    to: string
    subject: string
    text: string
    html: string
  }): Promise<unknown>
}

/** The reset email, in both the plain-text and HTML parts a client may show. */
function renderResetEmail(
  code: string,
  minutes: number
): {
  subject: string
  text: string
  html: string
} {
  const subject = 'Your Bookends password reset code'
  const text = [
    `Your password reset code is: ${code}`,
    '',
    `Enter it on the password reset screen to choose a new password. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    '',
    'If you did not request this, you can ignore this email — your password will not change.',
  ].join('\n')

  const html = [
    '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1b1b1f">',
    '<p style="font-size:15px">Your password reset code is:</p>',
    `<p style="font-size:30px;font-weight:700;letter-spacing:.3em;margin:16px 0">${code}</p>`,
    `<p style="font-size:14px;color:#555">Enter it on the password reset screen to choose a new password. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.</p>`,
    '<p style="font-size:13px;color:#888">If you did not request this, you can ignore this email — your password will not change.</p>',
    '</div>',
  ].join('')

  return { subject, text, html }
}

/**
 * Emails the reset code over SMTP.
 *
 * The transport is built once from config and reused. It is also injectable so
 * tests exercise every branch — including a delivery failure — without a live
 * server.
 */
export class EmailDispatcher implements NotificationDispatcher {
  private readonly sender: MailSender
  private readonly from: string

  constructor(
    smtp: SmtpConfig,
    private readonly logger: Logger,
    sender?: MailSender
  ) {
    this.from = smtp.from
    this.sender =
      sender ??
      nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        ...(smtp.auth ? { auth: smtp.auth } : {}),
      })
  }

  async sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    if (!message.email) {
      // No channel to reach this account. Thrown rather than swallowed so
      // AuthService retires the code it just created (its existing rollback
      // path) and the caller still receives the identical generic 200 — an
      // account with no email must be indistinguishable from an unknown number.
      throw new Error('No email address on file for password reset delivery')
    }

    const minutes = Math.max(1, Math.round((message.expiresAt.getTime() - Date.now()) / 60000))
    const { subject, text, html } = renderResetEmail(message.code, minutes)

    // A transport failure propagates for the same reason: a code persisted but
    // never delivered must be rolled back, not left to block recovery for the
    // rest of its window.
    const info = await this.sender.sendMail({
      from: this.from,
      to: message.email,
      subject,
      text,
      html,
    })

    // Ethereal (a throwaway test inbox) returns a preview URL; every real
    // provider returns none, so this logs a link only during local testing and
    // is a silent no-op in production. It is what makes the code reachable while
    // developing without a real mailbox — the successor to the dev file sink.
    const preview = previewUrlFor(info)

    // The email body carries the code — that is the delivery. The log must not:
    // it is the copy-everywhere destination the B2 redaction work exists for.
    // (The preview URL is Ethereal-only and points at a disposable test inbox.)
    this.logger.info(
      {
        email: maskEmail(message.email),
        expiresAt: message.expiresAt,
        ...(preview ? { previewUrl: preview } : {}),
      },
      preview
        ? 'Password reset code emailed (Ethereal test inbox — open previewUrl to read it)'
        : 'Password reset code emailed'
    )
  }
}

/**
 * Chooses the delivery channel from configuration.
 *
 * SMTP configured wins in every environment, so email is testable in
 * development rather than production-only. With no SMTP, development keeps the
 * local file sink and production refuses to deliver rather than silently drop a
 * reset it cannot send.
 */
export function buildDispatcher(config: Config, logger: Logger): NotificationDispatcher {
  if (config.smtp) return new EmailDispatcher(config.smtp, logger)
  if (config.isProduction) return new UnconfiguredDispatcher()
  return new DevFileDispatcher(logger)
}
