import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth.js'
import { Shell } from './components/Shell.js'
import { Spinner } from './components/ui.js'
import { Login } from './pages/Login.js'
import { Dashboard } from './pages/Dashboard.js'
import { Employees } from './pages/Employees.js'
import { Questions } from './pages/Questions.js'
import { Library } from './pages/Library.js'
import { Exams } from './pages/Exams.js'
import { Grading } from './pages/Grading.js'
import { Training } from './pages/Training.js'
import { Rewards } from './pages/Rewards.js'
import { Reports } from './pages/Reports.js'
import { Organisation } from './pages/Organisation.js'
import { ChangePassword } from './pages/ChangePassword.js'

/**
 * Keeps signed-out users out, without the flash-of-login-screen.
 *
 * `restoring` is the whole point: on a reload the access token is gone (it
 * lives in memory by design) and the app is asking the refresh cookie whether
 * this is still a valid session. Redirecting during that round trip would
 * bounce a signed-in user to /login and back, every single reload.
 */
function Protected() {
  const { me, restoring } = useAuth()

  if (restoring) return <Spinner label="Signing in" />
  if (!me) return <Navigate to="/login" replace />

  /**
   * §7.3: an account created for someone starts with a derived password and is
   * blocked at the API until it changes. Enforced here too, or every screen
   * renders and every request 403s — which looks like a broken product rather
   * than an instruction.
   */
  if (me.mustChangePassword) return <Navigate to="/change-password" replace />

  return <Shell />
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/change-password" element={<ChangePassword />} />

          <Route element={<Protected />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/employees" element={<Employees />} />
            <Route path="/questions" element={<Questions />} />
            <Route path="/library" element={<Library />} />
            <Route path="/exams" element={<Exams />} />
            <Route path="/grading" element={<Grading />} />
            <Route path="/training" element={<Training />} />
            <Route path="/rewards" element={<Rewards />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/organisation" element={<Organisation />} />
          </Route>

          {/* An unknown path goes home rather than to a dead end. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
