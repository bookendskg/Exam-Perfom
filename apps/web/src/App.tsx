import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AuthProvider, useAuth } from './lib/auth'
import { ThemeProvider } from './theme/ThemeProvider'
import { AppShell } from './components/layout/AppShell'
import { Spinner } from './components/ui'
import { ToastProvider } from './components/ui/Toast'
import { LoginPage } from './pages/LoginPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { ChangePasswordPage } from './pages/ChangePasswordPage'
import { DashboardPage } from './pages/DashboardPage'
import { EmployeesPage } from './pages/EmployeesPage'
import { QuestionsPage } from './pages/QuestionsPage'
import { ExamsPage } from './pages/ExamsPage'
import { GradingPage } from './pages/GradingPage'
import { GradeAttemptPage } from './pages/GradeAttemptPage'

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
    return (
      <div className="grid min-h-screen place-items-center bg-surface text-on-surface-variant">
        <Spinner className="h-6 w-6" label="Checking your session" />
      </div>
    )
  }
  if (passwordChangeRequired) return <Navigate to="/change-password" replace />
  if (!user) return <Navigate to="/login" replace />

  return <AppShell>{children}</AppShell>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route
        path="/"
        element={
          <Protected>
            <DashboardPage />
          </Protected>
        }
      />
      <Route
        path="/employees"
        element={
          <Protected>
            <EmployeesPage />
          </Protected>
        }
      />
      <Route
        path="/questions"
        element={
          <Protected>
            <QuestionsPage />
          </Protected>
        }
      />
      <Route
        path="/exams"
        element={
          <Protected>
            <ExamsPage />
          </Protected>
        }
      />
      <Route
        path="/grading"
        element={
          <Protected>
            <GradingPage />
          </Protected>
        }
      />
      <Route
        path="/grading/:assignmentId"
        element={
          <Protected>
            <GradeAttemptPage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  return (
    <ThemeProvider>
      {/*
        Outside AuthProvider, so a toast raised while signing out survives the
        auth state change that unmounts the screen which raised it.
      */}
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  )
}
