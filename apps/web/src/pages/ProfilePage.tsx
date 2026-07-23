import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { KeyRound, LogOut } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth, type Role } from '../lib/auth'
import {
  Alert,
  Async,
  Badge,
  Button,
  Card,
  PageHeader,
  Skeleton,
  buttonClasses,
} from '../components/ui'
import { useToast } from '../components/ui/Toast'

interface Profile {
  phone: string
  email: string | null
  role: Role
  name: string | null
  employeeCode: string | null
  outlet: string | null
  department: string | null
  designation: string | null
  joinedAt: string | null
  lastLoginAt: string | null
  passwordChangedAt: string | null
  createdAt: string
}

/** §3.2's role identifiers are snake_case; nobody wants to read that. */
const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  outlet_manager: 'Outlet Manager',
  trainer: 'Trainer',
  hr: 'HR',
  staff: 'Staff',
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** One label/value pair. Dashes rather than blanks, so a gap reads as "none". */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-3">
      <dt className="text-caption text-on-surface-variant">{label}</dt>
      <dd className="mt-0.5 text-body-sm text-on-surface">{value}</dd>
    </div>
  )
}

/**
 * The signed-in user's own account.
 *
 * Everything here was already in the database and reachable by nobody: the
 * panel knew the user's role and ids but never showed them, and
 * `POST /auth/logout-all` had been live with no caller. This is the screen
 * where a user can see who the system thinks they are and end a session they
 * left open on a shared terminal — the practical half of the session work.
 */
export function ProfilePage() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [revoking, setRevoking] = useState(false)
  const profile = useApi<Profile>('/auth/profile')

  /**
   * Signing out everywhere ends THIS session too — that is the point, and the
   * API gives the caller no exemption. So the local state has to be torn down
   * as well, or the panel keeps rendering as though signed in and every
   * subsequent request 401s.
   */
  const signOutEverywhere = async () => {
    setRevoking(true)
    try {
      await api.post('/auth/logout-all')
      await logout()
      navigate('/login')
      toast.success('Signed out everywhere', 'Every device has been signed out.')
    } catch (err) {
      toast.error(
        'Could not sign out everywhere',
        err instanceof ApiError ? err.message : 'Please check your connection and try again.'
      )
      setRevoking(false)
    }
  }

  return (
    <>
      <PageHeader title="My profile" subtitle="Your account details and session controls." />

      <Async
        state={profile}
        skeleton={
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        {(profile) => (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="truncate text-title-md font-semibold text-on-surface">
                    {profile.name ?? profile.phone}
                  </h2>
                  {profile.name && (
                    <p className="mt-0.5 text-body-sm text-on-surface-variant">{profile.phone}</p>
                  )}
                </div>
                <Badge tone="info">{ROLE_LABELS[profile.role]}</Badge>
              </div>

              <dl className="mt-4 divide-y divide-outline-variant border-t border-outline-variant">
                {profile.email && <Detail label="Email" value={profile.email} />}
                {profile.employeeCode && (
                  <Detail label="Employee code" value={profile.employeeCode} />
                )}
                {/*
                  Admin and super_admin accounts have no employee record, so
                  these are genuinely absent rather than empty — showing the
                  rows with dashes would imply an unassigned outlet.
                */}
                {profile.outlet && <Detail label="Outlet" value={profile.outlet} />}
                {profile.department && <Detail label="Department" value={profile.department} />}
                {profile.designation && <Detail label="Designation" value={profile.designation} />}
                {profile.joinedAt && <Detail label="Joined" value={formatDate(profile.joinedAt)} />}
                <Detail label="Account created" value={formatDate(profile.createdAt)} />
              </dl>
            </Card>

            <Card className="p-6">
              <h2 className="text-title-md font-semibold text-on-surface">Security</h2>

              <dl className="mt-4 divide-y divide-outline-variant border-t border-outline-variant">
                <Detail label="Last sign-in" value={formatDateTime(profile.lastLoginAt)} />
                <Detail
                  label="Password last changed"
                  value={
                    profile.passwordChangedAt ? formatDateTime(profile.passwordChangedAt) : 'Never'
                  }
                />
              </dl>

              <div className="mt-5 space-y-3">
                <Link
                  to="/change-password"
                  className={buttonClasses('secondary', 'md', 'w-full justify-center')}
                >
                  <KeyRound aria-hidden="true" className="h-4 w-4" />
                  Change password
                </Link>

                <Alert tone="warning" title="Sign out of all devices">
                  Ends every session, including this one. Use this if you have signed in on a shared
                  or lost device.
                </Alert>

                <Button
                  variant="danger"
                  loading={revoking}
                  onClick={() => void signOutEverywhere()}
                  icon={<LogOut aria-hidden="true" className="h-4 w-4" />}
                  className="w-full justify-center"
                >
                  {revoking ? 'Signing out…' : 'Sign out everywhere'}
                </Button>
              </div>
            </Card>
          </div>
        )}
      </Async>
    </>
  )
}
