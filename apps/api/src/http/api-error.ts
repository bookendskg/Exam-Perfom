import type { ApiErrorDetail, ErrorCode } from '@bookends/core'

/**
 * An error with an intended HTTP status and §5.2 error code. Anything thrown
 * that is not an ApiError is treated as a bug and flattened to INTERNAL_ERROR
 * by the error handler — driver text and stack traces never reach a client.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly details?: ApiErrorDetail[]

  constructor(status: number, code: ErrorCode, message: string, details?: ApiErrorDetail[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  static validation(message: string, details?: ApiErrorDetail[]) {
    return new ApiError(400, 'VALIDATION_ERROR', message, details)
  }

  /**
   * Login failure. Deliberately identical for "no such phone", "wrong
   * password", and "account inactive" — anything else lets an attacker
   * enumerate which of the 300 staff numbers are registered.
   */
  static invalidCredentials() {
    return new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid phone number or password')
  }

  static unauthenticated(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHENTICATED', message)
  }

  static tokenExpired() {
    return new ApiError(401, 'TOKEN_EXPIRED', 'Access token has expired')
  }

  static sessionExpired() {
    return new ApiError(401, 'SESSION_EXPIRED', 'Session has expired; please log in again')
  }

  static passwordChangeRequired() {
    return new ApiError(
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'You must change your password to continue'
    )
  }

  static accountLocked(retryAfterSeconds: number) {
    return new ApiError(
      423,
      'ACCOUNT_LOCKED',
      `Too many failed attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes`
    )
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, 'FORBIDDEN', message)
  }

  /**
   * Also used when a record exists but is outside the caller's scope. A 403
   * there would confirm the row exists, leaking another outlet's roster.
   */
  static notFound(message = 'Resource not found') {
    return new ApiError(404, 'NOT_FOUND', message)
  }

  static conflict(message: string, details?: ApiErrorDetail[]) {
    return new ApiError(409, 'CONFLICT', message, details)
  }

  static notImplemented(message: string) {
    return new ApiError(501, 'NOT_IMPLEMENTED', message)
  }

  /**
   * Also used when the tenant exists but is suspended or soft-deleted, and when
   * no tenant was named at all — for the same reason invalidCredentials() lumps
   * its three causes together. Telling an unauthenticated caller "that
   * organisation exists, but it is suspended" answers a question they have not
   * earned the right to ask.
   */
  static tenantNotFound() {
    return new ApiError(404, 'TENANT_NOT_FOUND', 'Organisation not found')
  }

  /** Post-authentication only: the caller demonstrably works here (§Appendix C). */
  static tenantSuspended() {
    return new ApiError(403, 'TENANT_SUSPENDED', 'Your organisation has been suspended')
  }

  /**
   * §23.2: never a silent failure. `details` carries the limit that was hit and
   * what the current plan allows, so the UI can say which, and offer an upgrade
   * rather than a shrug.
   */
  static planLimitReached(message: string, details?: ApiErrorDetail[]) {
    return new ApiError(403, 'PLAN_LIMIT_REACHED', message, details)
  }

  static planFeatureLocked(message: string, details?: ApiErrorDetail[]) {
    return new ApiError(403, 'PLAN_FEATURE_LOCKED', message, details)
  }
}
