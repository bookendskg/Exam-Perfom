import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth, allowed, type Role } from './lib/auth'
import { LoginPage } from './pages/LoginPage'
import { ChangePasswordPage } from './pages/ChangePasswordPage'
import { DashboardPage } from './pages/DashboardPage'
import { EmployeesPage } from './pages/EmployeesPage'
import { QuestionsPage } from './pages/QuestionsPage'
import { ExamsPage } from './pages/ExamsPage'
import { GradingPage } from './pages/GradingPage'
import { GradeAttemptPage } from './pages/GradeAttemptPage'

const NAV: Array<{ to: string; label: string; section: string }> = [
  { to: '/', label: 'Dashboard', section: 'organisation' },
  { to: '/employees', label: 'Employees', section: 'employees' },
  { to: '/questions', label: 'Questions', section: 'questions' },
  { to: '/exams', label: 'Exams', section: 'exams' },
  { to: '/grading', label: 'Grading', section: 'grading' },
]

const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  outlet_manager: 'Outlet Manager',
  trainer: 'Trainer',
  hr: 'HR',
  staff: 'Staff',
}

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-8">
            <div>
              <div className="text-sm font-semibold tracking-tight text-brand-700">BOOKENDS</div>
              <div className="text-xs text-stone-500">Staff Performance Portal</div>
            </div>
            <nav className="flex gap-1">
              {NAV.filter((item) => allowed(item.section, user?.role)).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-2 text-sm font-medium transition ${
                      isActive ? 'bg-brand-50 text-brand-700' : 'text-stone-600 hover:bg-stone-100'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            {/* No name to show: neither /auth/login nor /auth/me returns one. */}
            <div className="text-right">
              <div className="text-sm font-medium text-stone-800">
                {user ? ROLE_LABEL[user.role] : ''}
              </div>
              <div className="text-xs text-stone-500">Signed in</div>
            </div>
            <button
              onClick={() => {
                logout()
                navigate('/login')
              }}
              className="rounded-md px-3 py-2 text-sm text-stone-600 hover:bg-stone-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  )
}

/**
 * The gate every screen sits behind.
 *
 * Three states have to be distinguished, and collapsing any two produces a bug:
 * still checking the stored token (render nothing, or the login page flashes),
 * authenticated but blocked by §7.3 (send to the change-password screen, not
 * the login one), and genuinely signed out.
 */
function Protected({ children }: { children: ReactNode }) {
  const { user, loading, passwordChangeRequired } = useAuth()

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-sm text-stone-500">Loading…</div>
  }
  if (passwordChangeRequired) return <Navigate to="/change-password" replace />
  if (!user) return <Navigate to="/login" replace />

  return <Shell>{children}</Shell>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route path="/" element={<Protected><DashboardPage /></Protected>} />
      <Route path="/employees" element={<Protected><EmployeesPage /></Protected>} />
      <Route path="/questions" element={<Protected><QuestionsPage /></Protected>} />
      <Route path="/exams" element={<Protected><ExamsPage /></Protected>} />
      <Route path="/grading" element={<Protected><GradingPage /></Protected>} />
      <Route path="/grading/:assignmentId" element={<Protected><GradeAttemptPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
