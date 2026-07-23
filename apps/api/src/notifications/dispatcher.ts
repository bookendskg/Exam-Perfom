import type { Logger } from 'pino'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ApiError } from '../http/api-error.js'

export interface PasswordResetMessage {
  phone: string
  token: string
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
        `token=${message.token}`,
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
