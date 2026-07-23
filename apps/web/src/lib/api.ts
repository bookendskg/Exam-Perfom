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

/**
 * Endpoints that must never trigger a refresh attempt.
 *
 * Refreshing in response to a 401 from any of these is either meaningless or a
 * loop: `/auth/refresh` failing IS the signal that the session is over, and the
 * unauthenticated endpoints have no session to renew in the first place.
 */
const NEVER_REFRESH = [
  '/auth/refresh',
  '/auth/login',
  '/auth/logout',
  '/auth/forgot-password',
  '/auth/reset-password',
]

/**
 * Blocks token renewal once the user has deliberately signed out.
 *
 * Without it, signing out could undo itself. Logout revokes the session and
 * clears the refresh cookie, but a request already in flight can answer 401
 * *after* that — and the interceptor's response to a 401 is to refresh. If the
 * logout request had not landed yet, or failed because the device was offline,
 * the cookie is still in the jar and that refresh succeeds: the panel silently
 * re-authenticates an account the user just signed out of.
 *
 * The latch is deliberately client-side and deliberately not the whole defence.
 * The server revoking the session is what actually ends it; this only stops the
 * client from trying to resurrect one.
 */
let refreshSuppressed = false

/**
 * The in-flight refresh, shared by every caller.
 *
 * A dashboard fires several requests at once, so an expired token produces a
 * burst of simultaneous 401s. Without this, each one would start its own
 * refresh — and because the API rotates the refresh token on every use and
 * treats a replayed one as theft, the parallel rotations would race and could
 * revoke the very session they were trying to save. One refresh, shared.
 */
let refreshInFlight: Promise<boolean> | null = null

async function performRefresh(): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/v1/auth/refresh', window.location.origin), {
      method: 'POST',
      // The refresh token itself is never touched here — it rides in an
      // HttpOnly cookie the browser attaches and JavaScript cannot read. The
      // empty JSON body is simply what the endpoint's validator expects.
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
    })
    if (!res.ok) return false

    const envelope = (await res.json().catch(() => null)) as Envelope<{
      accessToken?: string
    }> | null
    const next = envelope?.data?.accessToken
    if (typeof next !== 'string' || next.length === 0) return false

    tokenStore.set(next)
    return true
  } catch {
    // Offline or the request was aborted. Indistinguishable from a dead
    // session here, and treating it as "not refreshed" fails safe.
    return false
  }
}

/**
 * Ends the session on the server, then locally — in that order, and always.
 *
 * The panel used to sign out by deleting the access token from localStorage and
 * nothing else. The `user_sessions` row stayed live and the HttpOnly refresh
 * cookie stayed in the jar for the rest of its seven days, so "signed out" meant
 * only that this tab had forgotten its token. Anyone who reached the cookie
 * could mint a fresh access token from it, and once automatic refresh existed
 * the panel itself would do exactly that on the next 401.
 *
 * Resolves even when the request fails: a user who cannot reach the network
 * still gets signed out of the device in front of them, which is the part they
 * can see. The server-side session then expires on its own schedule.
 */
export async function endSession(): Promise<void> {
  // Set first, so a 401 racing this call cannot start a renewal behind our back.
  refreshSuppressed = true
  refreshInFlight = null
  try {
    await request('/auth/logout', { method: 'POST' })
  } catch {
    // Already invalid, already revoked, or offline. All three end the same way.
  } finally {
    tokenStore.clear()
  }
}

/** Re-arms refreshing after a fresh sign-in. */
export function resumeRefreshing(): void {
  refreshSuppressed = false
}

/** Refreshes the access token, collapsing concurrent callers onto one request. */
function refreshAccessToken(): Promise<boolean> {
  if (refreshSuppressed) return Promise.resolve(false)
  if (refreshInFlight) return refreshInFlight

  const attempt = performRefresh().finally(() => {
    // Guarded so a slow attempt cannot clear a newer one that replaced it.
    if (refreshInFlight === attempt) refreshInFlight = null
  })
  refreshInFlight = attempt
  return attempt
}

export async function request<T>(
  path: string,
  options: {
    method?: string
    body?: unknown
    query?: Record<string, string | number | undefined>
  } = {},
  /** Internal: false on the retry, so a request is only ever replayed once. */
  mayRefresh = true
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
    credentials: 'same-origin',
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
    if (error.code === 'PASSWORD_CHANGE_REQUIRED') {
      onPasswordChangeRequired?.()
      throw new ApiError(res.status, error)
    }

    if (res.status === 401) {
      /**
       * The access token lives 15 minutes; the refresh cookie lives 7 days.
       * Before this, a 401 ended the session outright — so the panel bounced
       * the user to the login screen every quarter of an hour despite a
       * perfectly good refresh token sitting in the cookie jar.
       *
       * Now: renew once, replay the original request, and only give up if the
       * renewal itself fails. `mayRefresh` is false on the replay, so a token
       * that is genuinely dead ends the session rather than looping.
       */
      if (mayRefresh && !NEVER_REFRESH.includes(path)) {
        const renewed = await refreshAccessToken()
        if (renewed) return request<T>(path, options, false)
      }

      // Session is genuinely over — expired, revoked, or idled out.
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
