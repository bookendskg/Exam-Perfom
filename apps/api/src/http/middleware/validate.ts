import type { RequestHandler } from 'express'
import { ZodError, type ZodSchema } from 'zod'
import { ApiError } from '../api-error.js'
import { zodDetails } from './error-handler.js'

export interface ValidationTargets {
  body?: ZodSchema
  query?: ZodSchema
  params?: ZodSchema
}

declare module 'express-serve-static-core' {
  interface Request {
    valid?: { body?: unknown; query?: unknown; params?: unknown }
  }
}

/**
 * Validates a request and stashes the parsed result on `req.valid`.
 *
 * Parsed output does NOT overwrite req.body/req.query. In Express 5 `req.query`
 * is a getter with no setter — assigning to it throws at runtime, which is the
 * classic Express 4 → 5 migration trap.
 */
export function validate(targets: ValidationTargets): RequestHandler {
  return (req, _res, next) => {
    try {
      req.valid = {}
      if (targets.body) req.valid.body = targets.body.parse(req.body)
      if (targets.query) req.valid.query = targets.query.parse(req.query)
      if (targets.params) req.valid.params = targets.params.parse(req.params)
      next()
    } catch (err) {
      if (err instanceof ZodError) {
        next(ApiError.validation('Validation failed', zodDetails(err)))
        return
      }
      next(err)
    }
  }
}
