/**
 * The §5.2 response envelope. Shared with the web client so both sides agree on
 * the wire format.
 */

export interface PageMeta {
  page: number
  limit: number
  total: number
  totalPages: number
}

/**
 * §5.2 shows `meta` on the success shape unconditionally, but it is meaningless
 * for a non-list response like POST /auth/login. Modelled as optional and
 * emitted only by list endpoints.
 */
export interface ApiSuccess<T> {
  success: true
  data: T
  meta?: PageMeta
}

export interface ApiErrorDetail {
  field: string
  message: string
}

export interface ApiFailure {
  success: false
  error: {
    code: ErrorCode
    message: string
    details?: ApiErrorDetail[]
  }
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'INVALID_CREDENTIALS',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'SESSION_EXPIRED',
  'PASSWORD_CHANGE_REQUIRED',
  'ACCOUNT_LOCKED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export function ok<T>(data: T, meta?: PageMeta): ApiSuccess<T> {
  return meta ? { success: true, data, meta } : { success: true, data }
}

export function fail(code: ErrorCode, message: string, details?: ApiErrorDetail[]): ApiFailure {
  return {
    success: false,
    error: details?.length ? { code, message, details } : { code, message },
  }
}

export function pageMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
}
