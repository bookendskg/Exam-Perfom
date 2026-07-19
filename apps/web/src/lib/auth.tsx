import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, setAuthHandlers, tokenStore, ApiError } from './api'

/** The six §3.2 roles. */
export type Role = 'super_admin' | 'admin' | 'outlet_manager' | 'trainer' | 'hr' | 'staff'

/**
 * The panel's view of who is signed in.
 *
 * Normalised on purpose: /auth/login returns `user.id` while /auth/me returns
 * `userId`, and only /auth/me carries departmentId and managedOutletIds.
 * Mapping both into one shape here keeps that difference out of every screen.
 * Note neither endpoint returns a phone number, so there is no name to show.
 */
export interface CurrentUser {
  userId: string
  role: Role
  employeeId: string | null
  outletId: string | null
  departmentId?: string | null
  managedOutletIds?: string[]
}

/** GET /auth/me */
interface MeResponse {
  userId: string
  role: Role
  employeeId: string | null
  outletId: string | null
  departmentId: string | null
  managedOutletIds: string[]
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

    api
      .get<MeResponse>('/auth/me')
      .then(({ data }) => {
        setUser({
          userId: data.userId,
          role: data.role,
          employeeId: data.employeeId,
          outletId: data.outletId,
          departmentId: data.departmentId,
          managedOutletIds: data.managedOutletIds,
        })
        // /auth/me is reachable while the gate is up (it sits above the guard),
        // so the flag has to be read from the payload rather than inferred
        // from a failure that never comes.
        setPasswordChangeRequired(data.mustChangePassword)
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'PASSWORD_CHANGE_REQUIRED') {
          setPasswordChangeRequired(true)
        } else {
          tokenStore.clear()
        }
      })
      .finally(() => setLoading(false))
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

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await api.post('/auth/change-password', { currentPassword, newPassword })
      setPasswordChangeRequired(false)
      const { data } = await api.get<MeResponse>('/auth/me')
      setUser({
        userId: data.userId,
        role: data.role,
        employeeId: data.employeeId,
        outletId: data.outletId,
        departmentId: data.departmentId,
        managedOutletIds: data.managedOutletIds,
      })
    },
    []
  )

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
