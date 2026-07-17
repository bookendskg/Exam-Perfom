import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { canSee, useAuth, type NavArea } from '../lib/auth.js'
import { Button } from './ui.js'

/**
 * §19.3's navigation.
 *
 * Items a role cannot use are HIDDEN, not disabled — a greyed-out "Exams" tells
 * a trainer the feature exists and they are not allowed it, which is an
 * invitation to ask why. Hiding is honest: for them, it does not exist.
 *
 * This is a courtesy only. §3.2's matrix is enforced server-side; if this list
 * and the API ever disagree, the API wins and the user gets a 403 — which is
 * the right failure, and why the check here is allowed to be coarse.
 */
const NAV: Array<{ to: string; label: string; area: NavArea }> = [
  { to: '/', label: 'Dashboard', area: 'dashboard' },
  { to: '/employees', label: 'Employees', area: 'employees' },
  { to: '/questions', label: 'Question Bank', area: 'questions' },
  // Directly under Questions: nobody sets out to manage source documents, they
  // set out to add a question and find §10.3 requires one first.
  { to: '/library', label: 'Library', area: 'questions' },
  { to: '/exams', label: 'Exams', area: 'exams' },
  { to: '/grading', label: 'Grading', area: 'grading' },
  { to: '/training', label: 'Training', area: 'training' },
  { to: '/rewards', label: 'Rewards', area: 'rewards' },
  { to: '/reports', label: 'Reports', area: 'reports' },
  { to: '/organisation', label: 'Organisation', area: 'organisation' },
]

export function Shell() {
  const { me, tenantSlug, logout } = useAuth()
  const navigate = useNavigate()

  const signOut = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-56 shrink-0 border-r border-edge bg-surface md:block">
        <div className="border-b border-edge px-4 py-4">
          <p className="text-lg font-semibold text-primary">ExamHub</p>
          {/* The tenant, always visible. With one product serving many
              companies, "which company am I looking at" must never be a guess. */}
          <p className="mt-0.5 truncate text-xs text-ink-muted">{tenantSlug}</p>
        </div>

        <nav className="p-2">
          {NAV.filter((item) => canSee(me?.role, item.area)).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              // `end` only on the index route, or "/" matches every path and
              // every item renders as active.
              end={item.to === '/'}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm ${
                  isActive ? 'bg-primary/10 font-medium text-primary' : 'text-ink hover:bg-canvas'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-edge bg-surface px-6 py-3">
          <div className="md:hidden">
            <span className="font-semibold text-primary">ExamHub</span>
          </div>
          <div className="ml-auto flex items-center gap-4">
            <span className="text-sm text-ink-muted">
              {me?.role.replace(/_/g, ' ')}
            </span>
            <Button variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </header>

        {/* min-w-0 on the flex child, or a wide table stretches the layout
            instead of scrolling inside its own container. */}
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
