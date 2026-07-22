import { pino, type Logger, type DestinationStream } from 'pino'
import type { Config } from '../config/env.js'

/**
 * Structured logging.
 *
 * The redact list is not optional. Without it, pino-http serialises the whole
 * request — so every login would write the plaintext password and every
 * authenticated call would write a bearer token into the log file.
 */
export function createLogger(config: Config, destination?: DestinationStream): Logger {
  const options = {
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
  }

  // The destination seam exists so the redact list above can be asserted rather
  // than trusted. It is a security control — without it every login writes a
  // plaintext password and every authenticated call writes a bearer token — and
  // an untested security control is an assumption.
  return destination ? pino(options, destination) : pino(options)
}
