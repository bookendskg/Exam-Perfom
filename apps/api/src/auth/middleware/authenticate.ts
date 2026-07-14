import type { RequestHandler } from 'express'
import type { Principal, SessionStore } from '../../infra/session-store/index.js'
import type { TokenService } from '../token.service.js'
import type { SessionService } from '../session.service.js'
import { ApiError } from '../../http/api-error.js'

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal
  }
}

/**
 * Verifies the access token, then confirms the session is still live and
 * refreshes its idle window.
 *
 * The session lookup is not redundant with the JWT: §7.5's idle timeout demands
 * a store round trip anyway, and it is what makes a revoked session stop working
 * immediately rather than when its 15-minute access token happens to expire.
 * Scope rides back on the same call, so it costs nothing extra.
 */
export function authenticate(
  tokens: TokenService,
  store: SessionStore,
  sessions: SessionService
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const header = req.headers.authorization
        if (!header?.startsWith('Bearer ')) {
          throw ApiError.unauthenticated('Missing bearer token')
        }

        const claims = await tokens.verifyAccessToken(header.slice('Bearer '.length))
        const principal = await store.touch(claims.sid, sessions.idleTtlFor(claims.role))

        // Unknown, revoked, expired, or idled-out all land here and are
        // deliberately indistinguishable to the client.
        if (!principal) throw ApiError.sessionExpired()

        req.principal = principal
        next()
      } catch (err) {
        next(err)
      }
    })()
  }
}

/** Reads the principal or throws. Use inside handlers mounted behind authenticate. */
export function requirePrincipal(req: { principal?: Principal }): Principal {
  if (!req.principal) throw ApiError.unauthenticated()
  return req.principal
}
