import { pino, type Logger } from 'pino'
import type { Config } from '../config/env.js'

/**
 * Structured logging.
 *
 * The redact list is not optional. Without it, pino-http serialises the whole
 * request — so every login would write the plaintext password and every
 * authenticated call would write a bearer token into the log file.
 */
export function createLogger(config: Config): Logger {
  return pino({
    level: config.isTest ? 'silent' : config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.body.password',
        'req.body.newPassword',
        'req.body.currentPassword',
        'req.body.refreshToken',
        'password',
        'newPassword',
        'currentPassword',
        'refreshToken',
        'passwordHash',
        'accessToken',
      ],
      censor: '[redacted]',
    },
  })
}
