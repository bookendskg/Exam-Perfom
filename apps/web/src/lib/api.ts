/**
 * The one place the panel talks to the API.
 *
 * Every call goes through `request`, so the §5.2 envelope is unwrapped once,
 * the bearer token is attached once, and the two auth failures the API can
 * return — an expired token and an outstanding password change — are handled
 * once rather than in every screen.
 */

export interface ApiErrorShape {
  code: string
  message: string
  details?: Array<{ field: string; message: string }>
}

/** Thrown for any non-2xx. Carries the §5.2 code so callers can branch on it. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Array<{ field: string; message: string }>

  constructor(status: number, error: ApiErrorShape) {
    super(error.message)
    this.name = 'ApiError'
    this.status = status
    this.code = error.code
    this.details = error.details ?? []
  }

  /** A field-level message, for putting errors next to the input that caused them. */
  detailFor(field: string): string | undefined {
    return this.details.find((d) => d.field === field)?.message
  }
}

const TOKEN_KEY = 'bookends.accessToken'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

/**
 * Callbacks the app registers so the client can react to auth state without
 * importing React or the router — which would make this file untestable and
 * circular.
 */
let onUnauthenticated: (() => void) | null = null
let onPasswordChangeRequired: (() => void) | null = null

export function setAuthHandlers(handlers: {
  onUnauthenticated: () => void
  onPasswordChangeRequired: () => void
}) {
  onUnauthenticated = handlers.onUnauthenticated
  onPasswordChangeRequired = handlers.onPasswordChangeRequired
}

export interface PageMeta {
  page: number
  limit: number
  total: number
  totalPages: number
}

interface Envelope<T> {
  success: boolean
  data?: T
  meta?: PageMeta
  error?: ApiErrorShape
}

export interface Result<T> {
  data: T
  meta?: PageMeta
}

export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}
): Promise<Result<T>> {
  const url = new URL(`/api/v1${path}`, window.location.origin)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }

  const token = tokenStore.get()
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  })

  const envelope = (await res.json().catch(() => null)) as Envelope<T> | null

  if (!res.ok) {
    const error = envelope?.error ?? { code: 'UNKNOWN', message: `Request failed (${res.status})` }

    /**
     * §7.3: the API blocks every /api/v1 route until a first-login password
     * change is done. Without handling it here, every screen would render an
     * inscrutable 403 and the user would have no way to get past it.
     */
    if (error.code === 'PASSWORD_CHANGE_REQUIRED') onPasswordChangeRequired?.()
    else if (res.status === 401) {
      tokenStore.clear()
      onUnauthenticated?.()
    }

    throw new ApiError(res.status, error)
  }

  return { data: envelope?.data as T, meta: envelope?.meta }
}

export const api = {
  get: <T>(path: string, query?: Record<string, string | number | undefined>) =>
    request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
}
