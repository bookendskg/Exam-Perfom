import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { Prisma } from '@bookends/db'
import { fail, type ApiErrorDetail } from '@bookends/core'
import { ApiError } from '../api-error.js'
import type { Logger } from 'pino'

/** Maps a ZodError onto §5.2's `details[]` shape. */
export function zodDetails(error: ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }))
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(fail('NOT_FOUND', `Cannot ${req.method} ${req.path}`))
}

/**
 * The only place in the API that writes an error body. Everything else throws.
 *
 * Must keep four arguments — Express identifies error middleware by arity, and
 * dropping `_next` silently turns this into ordinary middleware that never runs.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json(fail(err.code, err.message, err.details))
      return
    }

    if (err instanceof ZodError) {
      res.status(400).json(fail('VALIDATION_ERROR', 'Validation failed', zodDetails(err)))
      return
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 unique violation, P2025 record not found. Everything else is a
      // bug on our side, not the client's.
      if (err.code === 'P2002') {
        const target = err.meta?.['target']
        const fields = Array.isArray(target) ? target.map(String) : []
        res.status(409).json(
          fail(
            'CONFLICT',
            'A record with these values already exists',
            fields.map((f) => ({ field: f, message: 'Already in use' }))
          )
        )
        return
      }
      if (err.code === 'P2025') {
        res.status(404).json(fail('NOT_FOUND', 'Resource not found'))
        return
      }
    }

    // Unrecognised: log the real thing, tell the client nothing. Leaking a
    // stack trace or driver message here is how connection strings escape.
    logger.error({ err }, 'Unhandled error')
    res.status(500).json(fail('INTERNAL_ERROR', 'An unexpected error occurred'))
  }
}
