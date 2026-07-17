import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, setAccessToken, setAuthLostHandler, type LoginResponse } from './api.js'

/**
 * Who is signed in, for the whole app.
 *
 * Deliberately thin: it holds the identity the server gave us and nothing more.
 * Permissions are NOT mirrored here — §3.2's matrix is enforced server-side and
 * a copy in the browser would be a second source of truth that drifts. The UI
 * hides what a role cannot do as a courtesy; the server is what refuses.
 */

export interface Me {
  userId: string
  role: string
  employeeId: string | null
  outletId: string | null
  departmentId: string | null
  managedOutletIds: string[]
  mustChangePassword: boolean
}

interface AuthState {
  me: Me | null
  /** Null until the first restore attempt finishes — see `restoring`. */
  restoring: boolean
  tenantSlug: string | null
  login: (tenantSlug: string, phone: string, password: string) => Promise<LoginResponse>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

/**
 * The slug is remembered across reloads, unlike the token.
 *
 * It is not a secret — it is in the URL of every real deployment
 * ({slug}.examhub.com, §5.3) — and remembering it means a returning user does
 * not retype their own company name. localStorage is the right place for
 * exactly this class of thing and the wrong place for the token.
 */
const SLUG_KEY = 'examhub.tenantSlug'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [tenantSlug, setTenantSlug] = useState<string | null>(() =>
    localStorage.getItem(SLUG_KEY)
  )

  const loadMe = useCallback(async () => {
    const profile = await api.get<Me>('/auth/me')
    setMe(profile)
    return profile
  }, [])

  /**
   * On boot, try to restore from the HttpOnly refresh cookie.
   *
   * The access token died with the last tab (it lives in memory, on purpose —
   * see api.ts), so a reload has nothing until this runs. `restoring` exists so
   * the router does not bounce a signed-in user to /login during the round
   * trip, which is the classic flash-of-login-screen bug.
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const ok = await api.restore()
      if (cancelled) return

      if (ok) {
        try {
          await loadMe()
        } catch {
          setMe(null)
        }
      }
      setRestoring(false)
    })()

    return () => {
      cancelled = true
    }
  }, [loadMe])

  // The client calls this when a refresh fails mid-session — the token expired
  // and could not be renewed, so the session is genuinely over.
  useEffect(() => {
    setAuthLostHandler(() => setMe(null))
  }, [])

  const login = useCallback(
    async (slug: string, phone: string, password: string) => {
      const result = await api.login(slug, phone, password)
      setAccessToken(result.accessToken)
      localStorage.setItem(SLUG_KEY, slug)
      setTenantSlug(slug)
      await loadMe()
      return result
    },
    [loadMe]
  )

  const logout = useCallback(async () => {
    // Best effort: a failed logout must still clear the client. The server-side
    // session is revoked by the call; if the call fails, the token expires in
    // 15 minutes regardless, and leaving the user apparently-signed-in is worse.
    try {
      await api.logout()
    } catch {
      /* already gone */
    }
    setAccessToken(null)
    setMe(null)
  }, [])

  const value = useMemo<AuthState>(
    () => ({ me, restoring, tenantSlug, login, logout }),
    [me, restoring, tenantSlug, login, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/**
 * §3.2's matrix, mirrored only for HIDING things.
 *
 * This is a courtesy, never a control: the server enforces the real rule, and
 * a UI check that disagreed with it would just mean a button that 403s. Kept
 * deliberately coarse — it answers "should this person see this nav item",
 * not "may they do this", because the second question has an authoritative
 * answer elsewhere.
 */
export function canSee(role: string | undefined, area: NavArea): boolean {
  if (!role) return false

  switch (area) {
    case 'dashboard':
      return true
    case 'employees':
      return ['super_admin', 'admin', 'outlet_manager', 'hr'].includes(role)
    case 'questions':
      return ['super_admin', 'admin', 'outlet_manager', 'trainer'].includes(role)
    case 'exams':
      return ['super_admin', 'admin', 'outlet_manager'].includes(role)
    case 'grading':
      return ['super_admin', 'admin', 'outlet_manager', 'trainer'].includes(role)
    case 'training':
    case 'rewards':
      return ['super_admin', 'admin', 'outlet_manager', 'trainer'].includes(role)
    case 'reports':
      return ['super_admin', 'admin', 'outlet_manager', 'hr'].includes(role)
    case 'organisation':
      return ['super_admin', 'admin'].includes(role)
  }
}

export type NavArea =
  | 'dashboard'
  | 'employees'
  | 'questions'
  | 'exams'
  | 'grading'
  | 'training'
  | 'rewards'
  | 'reports'
  | 'organisation'
