import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, setAuthHandlers, tokenStore, ApiError } from './api'

/** The six §3.2 roles. */
export type Role = 'super_admin' | 'admin' | 'outlet_manager' | 'trainer' | 'hr' | 'staff'

/**
 * The panel's view of who is signed in.
 *
 * Normalised on purpose: /auth/login returns `user.id` while /auth/me returns
 * `userId`, and only /auth/me carries departmentId and scopedOutletIds.
 * Mapping both into one shape here keeps that difference out of every screen.
 * Note neither endpoint returns a phone number, so there is no name to show.
 */
export interface CurrentUser {
  userId: string
  role: Role
  employeeId: string | null
  outletId: string | null
  departmentId?: string | null
  scopedOutletIds?: string[]
}

/** GET /auth/me */
interface MeResponse {
  userId: string
  role: Role
  employeeId: string | null
  outletId: string | null
  departmentId: string | null
  scopedOutletIds: string[]
  mustChangePassword: boolean
}

/** POST /auth/login */
interface LoginResponse {
  accessToken: string
  expiresIn: number
  mustChangePassword: boolean
  user: { id: string; role: Role; employeeId: string | null; outletId: string | null }
}

interface AuthState {
  user: CurrentUser | null
  /** True until the initial /auth/me has settled, so we do not flash the login page. */
  loading: boolean
  /** Set when the API says a password change is outstanding (§7.3). */
  passwordChangeRequired: boolean
  login: (phone: string, password: string) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

/**
 * The in-flight session-restore request, shared by every caller.
 *
 * React 18 StrictMode deliberately runs an effect's setup, cleanup, then setup
 * again in development. A per-effect `cancelled` flag stops the first result
 * being written to state, but it does NOT stop the second request — both
 * setups still call the API, which is why a stale token produced *two* 401s in
 * the server log rather than one.
 *
 * Sharing the promise makes the second setup reuse the first request instead of
 * issuing another. Cleared when it settles, so a genuine later remount (or a
 * fresh page load) re-verifies rather than trusting a cached answer — this is a
 * request deduplicator, not a cache.
 */
let sessionRestore: Promise<{ data: MeResponse }> | null = null

function restoreSession(): Promise<{ data: MeResponse }> {
  sessionRestore ??= api.get<MeResponse>('/auth/me').finally(() => {
    sessionRestore = null
  })
  return sessionRestore
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false)

  const logout = useCallback(() => {
    tokenStore.clear()
    setUser(null)
    setPasswordChangeRequired(false)
  }, [])

  // Registered once so the API client can push auth failures back into React.
  useEffect(() => {
    setAuthHandlers({
      onUnauthenticated: () => {
        setUser(null)
        setPasswordChangeRequired(false)
      },
      onPasswordChangeRequired: () => setPasswordChangeRequired(true),
    })
  }, [])

  /**
   * Restore the session on load. A token in localStorage is not proof of
   * anything — it may be expired or revoked — so it is verified against
   * /auth/me before any screen renders.
   */
  useEffect(() => {
    const token = tokenStore.get()
    if (!token) {
      setLoading(false)
      return
    }

    // Two separate guards, because they solve two different problems:
    //  - `restoreSession()` dedupes the REQUEST, so StrictMode's second setup
    //    reuses the first call instead of issuing another;
    //  - `cancelled` discards a RESULT that arrives after unmount, which is the
    //    cleanup this effect previously lacked entirely.
    let cancelled = false

    restoreSession()
      .then(({ data }) => {
        if (cancelled) return
        setUser({
          userId: data.userId,
          role: data.role,
          employeeId: data.employeeId,
          outletId: data.outletId,
          departmentId: data.departmentId,
          scopedOutletIds: data.scopedOutletIds,
        })
        // /auth/me is reachable while the gate is up (it sits above the guard),
        // so the flag has to be read from the payload rather than inferred
        // from a failure that never comes.
        setPasswordChangeRequired(data.mustChangePassword)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.code === 'PASSWORD_CHANGE_REQUIRED') {
          setPasswordChangeRequired(true)
        } else {
          // A token that no longer verifies is worthless — drop it, so the next
          // load goes straight to the login screen instead of repeating a 401.
          tokenStore.clear()
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (phone: string, password: string) => {
    const { data } = await api.post<LoginResponse>('/auth/login', { phone, password })
    tokenStore.set(data.accessToken)
    setUser({
      userId: data.user.id,
      role: data.user.role,
      employeeId: data.user.employeeId,
      outletId: data.user.outletId,
    })
    // §7.3 is reported by login itself, so no extra probe is needed.
    setPasswordChangeRequired(data.mustChangePassword)
  }, [])

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    // The API rotates the session on a credential change (anti session
    // fixation), so this returns a fresh token and the old one is already
    // dead. Storing it before the /auth/me call below is not optional — that
    // call would 401 with the previous token.
    const { data: rotated } = await api.post<LoginResponse>('/auth/change-password', {
      currentPassword,
      newPassword,
    })
    tokenStore.set(rotated.accessToken)
    setPasswordChangeRequired(false)

    const { data } = await api.get<MeResponse>('/auth/me')
    setUser({
      userId: data.userId,
      role: data.role,
      employeeId: data.employeeId,
      outletId: data.outletId,
      departmentId: data.departmentId,
      scopedOutletIds: data.scopedOutletIds,
    })
  }, [])

  const value = useMemo(
    () => ({ user, loading, passwordChangeRequired, login, changePassword, logout }),
    [user, loading, passwordChangeRequired, login, changePassword, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/**
 * §3.2, mirrored for the navigation only.
 *
 * This decides what to SHOW, never what is allowed — the API enforces the real
 * matrix on every request. Hiding a link the user cannot use is a courtesy;
 * treating this as security would be a mistake, because a client can be edited.
 */
export const CAN: Record<string, Role[]> = {
  employees: ['super_admin', 'admin', 'outlet_manager', 'hr', 'trainer'],
  questions: ['super_admin', 'admin', 'outlet_manager', 'trainer'],
  exams: ['super_admin', 'admin', 'outlet_manager', 'trainer', 'hr'],
  grading: ['super_admin', 'admin', 'outlet_manager', 'trainer'],
  organisation: ['super_admin', 'admin', 'outlet_manager', 'trainer', 'hr', 'staff'],
}

export function allowed(section: keyof typeof CAN, role: Role | undefined): boolean {
  return role ? (CAN[section] ?? []).includes(role) : false
}
