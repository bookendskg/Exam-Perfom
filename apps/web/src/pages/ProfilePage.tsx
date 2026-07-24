import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { KeyRound, LogOut, Mail } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useAuth, type Role } from '../lib/auth'
import {
  Alert,
  Async,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Skeleton,
  buttonClasses,
} from '../components/ui'
import { useToast } from '../components/ui/Toast'
import { PasswordInput } from '../components/auth/PasswordInput'

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

const emailFormSchema = z.object({
  email: z.string().trim().min(1, 'Enter an email address').email('Enter a valid email address'),
  currentPassword: z.string().min(1, 'Enter your current password'),
})

/**
 * The recovery email, shown and edited in one place.
 *
 * This is where a user gives the address their password-reset codes go to —
 * the self-service half of email recovery. The current password is required
 * because this address decides where a reset lands, so the API will not change
 * it on a merely-signed-in session; the form collects it to match.
 */
function RecoveryEmail({ email, onSaved }: { email: string | null; onSaved: () => void }) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof emailFormSchema>>({
    resolver: zodResolver(emailFormSchema),
    mode: 'onTouched',
    defaultValues: { email: email ?? '', currentPassword: '' },
  })

  const open = () => {
    reset({ email: email ?? '', currentPassword: '' })
    setEditing(true)
  }

  const onSubmit = async (values: z.infer<typeof emailFormSchema>) => {
    try {
      await api.patch('/auth/profile', values)
      toast.success('Recovery email updated', 'Password-reset codes will go here.')
      setEditing(false)
      onSaved()
    } catch (err) {
      if (err instanceof ApiError) {
        const emailErr = err.detailFor('email')
        const pwErr = err.detailFor('currentPassword')
        if (emailErr) setError('email', { message: emailErr })
        if (pwErr) setError('currentPassword', { message: pwErr })
        if (!emailErr && !pwErr) setError('root', { message: err.message })
      } else {
        setError('root', { message: 'Could not reach the server. Please try again.' })
      }
    }
  }

  if (!editing) {
    return (
      <div className="rounded-lg border border-outline-variant p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Mail aria-hidden="true" className="h-4 w-4 shrink-0 text-on-surface-variant" />
            <div className="min-w-0">
              <p className="text-caption text-on-surface-variant">Recovery email</p>
              <p className="truncate text-body-sm text-on-surface">
                {email ?? 'Not set — you cannot reset your own password without it'}
              </p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={open}>
            {email ? 'Change' : 'Add'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="space-y-3 rounded-lg border border-outline-variant p-4"
    >
      <p className="text-body-sm font-medium text-on-surface">
        {email ? 'Change recovery email' : 'Add a recovery email'}
      </p>

      {errors.root && <Alert tone="danger">{errors.root.message}</Alert>}

      <Field label="Email address" error={errors.email?.message} required>
        <Input
          {...register('email')}
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
        />
      </Field>

      <Field label="Current password" error={errors.currentPassword?.message} required>
        <PasswordInput {...register('currentPassword')} autoComplete="current-password" />
      </Field>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save email'}
        </Button>
      </div>
    </form>
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
  const profileState = useApi<Profile>('/auth/profile')

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
        state={profileState}
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
                {/* Email lives in the Security card, where it can be edited. */}
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
                <RecoveryEmail email={profile.email} onSaved={profileState.reload} />

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
