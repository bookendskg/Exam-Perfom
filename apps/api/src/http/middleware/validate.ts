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
      /**
       * `req.body ?? {}` is load-bearing, not defensive noise.
       *
       * Express 4 defaulted `req.body` to `{}`; Express 5 with body-parser 2
       * leaves it `undefined` when no body was sent. A `z.object()` then fails
       * with a root-level "Required" before any field is examined — so a
       * request whose payload is legitimately optional is rejected outright.
       *
       * That is exactly what broke POST /auth/refresh for browsers: the token
       * arrives in an HttpOnly cookie, the body is empty by design, and the
       * route 400'd before `readRefreshToken` could look at the cookie.
       *
       * Treating a missing body as an empty object also improves every other
       * route's errors: a POST with genuinely required fields now reports which
       * fields are missing instead of one opaque "(root): Required".
       */
      if (targets.body) req.valid.body = targets.body.parse(req.body ?? {})
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
