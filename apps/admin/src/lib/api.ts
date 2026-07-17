/**
 * The API client.
 *
 * One place that knows how to talk to the server, so no screen has to think
 * about tokens, refresh, or the §5.2 envelope. Everything else calls `api.get`
 * and gets data or an ApiError.
 */

/** §5.2's error envelope, as the server actually sends it. */
export interface ApiErrorDetail {
  field: string
  message: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ApiErrorDetail[] = []
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** §4.3: the tenant is over a plan limit, or the feature is not on their tier. */
  get isPlanLimit(): boolean {
    return this.code === 'PLAN_LIMIT_REACHED' || this.code === 'PLAN_FEATURE_LOCKED'
  }
}

export interface PageMeta {
  page: number
  limit: number
  total: number
  totalPages: number
}

export interface Paged<T> {
  data: T[]
  meta: PageMeta
}

/**
 * The access token lives in memory, NOT localStorage.
 *
 * A token in localStorage is readable by any script that ends up on the page —
 * one bad dependency and a §7.2 access token walks. In memory it dies with the
 * tab, which is the correct trade: the refresh token is an HttpOnly cookie the
 * server set, so a reload silently re-authenticates from that instead. The user
 * notices nothing; an XSS gets nothing.
 */
let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

/** Called when refresh fails — the app kicks back to /login. */
let onAuthLost: (() => void) | null = null

export function setAuthLostHandler(fn: () => void): void {
  onAuthLost = fn
}

interface RequestOptions {
  method?: string
  body?: unknown
  /** Skip the refresh-and-retry dance. Used by the refresh call itself. */
  noRetry?: boolean
}

/**
 * Refresh, de-duplicated.
 *
 * Three widgets mounting at once all get a 401, and without this they would
 * each fire a refresh. The server rotates the refresh token on every use, so
 * the second and third would present one that was just superseded — which
 * session.service.ts treats as a token-replay attack and responds to by killing
 * the whole session. Three innocent widgets would log the user out.
 *
 * So: one refresh in flight, everyone else waits on it.
 */
let refreshInFlight: Promise<boolean> | null = null

async function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The refresh token is an HttpOnly cookie; this is what sends it.
        credentials: 'include',
        body: JSON.stringify({}),
      })
      if (!res.ok) return false

      const payload = (await res.json()) as { data?: { accessToken?: string } }
      if (!payload.data?.accessToken) return false

      setAccessToken(payload.data.accessToken)
      return true
    } catch {
      return false
    } finally {
      // Cleared regardless, so a later 401 can try again.
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> =>
    fetch(path.startsWith('/api') ? path : `/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })

  let res = await send()

  /**
   * A 15-minute access token (§7.2) expires while someone is mid-form. Refresh
   * once and retry, so they never see it.
   *
   * Only on 401, and never for the refresh call itself — otherwise a failed
   * refresh recurses.
   */
  if (res.status === 401 && !options.noRetry) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      res = await send()
    } else {
      setAccessToken(null)
      onAuthLost?.()
    }
  }

  if (res.status === 204) return undefined as T

  const payload = (await res.json().catch(() => null)) as
    | { success: boolean; data?: unknown; meta?: PageMeta; error?: { code: string; message: string; details?: ApiErrorDetail[] } }
    | null

  if (!res.ok || !payload?.success) {
    throw new ApiError(
      res.status,
      payload?.error?.code ?? 'INTERNAL_ERROR',
      payload?.error?.message ?? `Request failed (${res.status})`,
      payload?.error?.details ?? []
    )
  }

  // A paged response carries meta; hand both back so callers can render a
  // pager without a second shape to remember.
  if (payload.meta) return { data: payload.data, meta: payload.meta } as T
  return payload.data as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  /**
   * Login. Takes the tenant slug because the server resolves the tenant BEFORE
   * checking credentials — see tenant.resolver.ts. Omitting it yields
   * TENANT_NOT_FOUND rather than a token.
   */
  login: (tenantSlug: string, phone: string, password: string) =>
    request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { tenantSlug, phone, password },
      noRetry: true,
    }),

  logout: () => request<unknown>('/auth/logout', { method: 'POST', noRetry: true }),

  /** Restores a session from the HttpOnly refresh cookie after a page reload. */
  restore: refreshAccessToken,
}

export interface LoginResponse {
  accessToken: string
  expiresIn: number
  mustChangePassword: boolean
  user: {
    id: string
    role: string
    employeeId: string | null
    outletId: string | null
  }
}
