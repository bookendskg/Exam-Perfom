import type { Logger } from 'pino'
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

/** Logs the reset link so the flow is usable end-to-end in development. */
export class LoggingDispatcher implements NotificationDispatcher {
  constructor(private readonly logger: Logger) {}

  async sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    this.logger.warn(
      { phone: message.phone, token: message.token, expiresAt: message.expiresAt },
      'PASSWORD RESET (dev only — no delivery channel wired yet)'
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
