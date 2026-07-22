import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ClipboardCheck, FileQuestion, LayoutDashboard, LogOut, Menu, Users, X } from 'lucide-react'
import { allowed, useAuth, type Role } from '../../lib/auth'
import { cn } from '../../lib/cn'
import { ThemeToggle } from './ThemeToggle'

interface NavItem {
  to: string
  label: string
  /** Key into the CAN matrix in lib/auth. */
  section: string
  Icon: typeof LayoutDashboard
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', section: 'organisation', Icon: LayoutDashboard },
  { to: '/employees', label: 'Employees', section: 'employees', Icon: Users },
  { to: '/questions', label: 'Questions', section: 'questions', Icon: FileQuestion },
  { to: '/exams', label: 'Exams', section: 'exams', Icon: ClipboardCheck },
  { to: '/grading', label: 'Grading', section: 'grading', Icon: ClipboardCheck },
]

const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  outlet_manager: 'Outlet Manager',
  trainer: 'Trainer',
  hr: 'HR',
  staff: 'Staff',
}

/** Page title for the header, derived from the route. */
function usePageTitle(): string {
  const { pathname } = useLocation()
  if (pathname.startsWith('/grading/')) return 'Grade attempt'
  return NAV.find((item) => item.to === pathname)?.label ?? 'Dashboard'
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <div
        aria-hidden="true"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-on-primary"
      >
        <span className="text-body-sm font-bold">B</span>
      </div>
      <div className="min-w-0">
        <p className="truncate text-body-sm font-bold tracking-tight text-on-surface">BOOKENDS</p>
        <p className="truncate text-caption text-on-surface-variant">Performance Portal</p>
      </div>
    </div>
  )
}

function NavItems({ role, onNavigate }: { role: Role | undefined; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.filter((item) => allowed(item.section, role)).map(({ to, label, Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          onClick={onNavigate}
          // aria-current is what tells a screen reader which page you are on.
          // The previous nav conveyed it by colour alone.
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-body-sm font-medium transition-colors',
              isActive
                ? 'bg-primary-container text-on-primary-container'
                : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon
                aria-hidden="true"
                className="h-5 w-5 shrink-0"
                strokeWidth={isActive ? 2.4 : 2}
              />
              <span className="truncate">{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

/**
 * The application frame: sidebar, header, content region.
 *
 * The old shell was a single flex row of links that squashed and then overflowed
 * below roughly 700px, with no mobile affordance at all. This splits into a
 * persistent sidebar from `lg` up and an off-canvas drawer below it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const title = usePageTitle()

  const [drawerOpen, setDrawerOpen] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  // Close the drawer on navigation, or it stays open over the new page.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  // Escape closes, and focus returns to the trigger — otherwise a keyboard user
  // is stranded at the top of the document after dismissing it.
  useEffect(() => {
    if (!drawerOpen) return
    closeButtonRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false)
        menuButtonRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  const signOut = () => {
    logout()
    navigate('/login')
  }

  const sidebarBody = (onNavigate?: () => void) => (
    <>
      <div className="px-4 py-4">
        <BrandMark />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        <NavItems role={user?.role} {...(onNavigate ? { onNavigate } : {})} />
      </div>
      <div className="border-t border-outline-variant p-3">
        {/* Neither /auth/login nor /auth/me returns a name, so the role is the
            only identity we can show. */}
        <div className="mb-2 px-2">
          <p className="truncate text-body-sm font-medium text-on-surface">
            {user ? ROLE_LABEL[user.role] : ''}
          </p>
          <p className="text-caption text-on-surface-variant">Signed in</p>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-body-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
        >
          <LogOut aria-hidden="true" className="h-4 w-4 shrink-0" />
          Sign out
        </button>
      </div>
    </>
  )

  return (
    <div className="min-h-screen bg-surface">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/* Persistent sidebar, large screens only. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-outline-variant bg-surface-lowest lg:flex">
        {sidebarBody()}
      </aside>

      {/* Off-canvas drawer, below lg. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 animate-fade-in bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-72 animate-slide-in-left flex-col border-r border-outline-variant bg-surface-lowest"
          >
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-md text-on-surface-variant hover:bg-surface-container"
            >
              <X aria-hidden="true" className="h-5 w-5" />
            </button>
            {sidebarBody(() => setDrawerOpen(false))}
          </div>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-outline-variant bg-surface/85 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-on-surface-variant hover:bg-surface-container lg:hidden"
            >
              <Menu aria-hidden="true" className="h-5 w-5" />
            </button>

            <p className="min-w-0 flex-1 truncate text-title-md text-on-surface">{title}</p>

            <ThemeToggle />
          </div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  )
}
