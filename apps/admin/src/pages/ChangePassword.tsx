import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import { Button, ErrorNote, Field, Input, Spinner } from '../components/ui.js'

/**
 * §7.3 force-change-on-first-login.
 *
 * Not optional and not a nag screen: an account created by HR starts with a
 * password derived from the employee's own phone number (§7.3), which is
 * public. Until it changes, the API blocks every other route — so this screen
 * is the only thing the user can reach, and it has to actually work.
 */
export function ChangePassword() {
  const { me, restoring, logout } = useAuth()
  const navigate = useNavigate()

  const [currentPassword, setCurrent] = useState('')
  const [newPassword, setNew] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  if (restoring) return <Spinner label="Signing in" />
  // Nobody is signed in — there is no password to change.
  if (!me) return <Navigate to="/login" replace />
  // Already changed it and navigated here by hand. Not an error, just done.
  if (!me.mustChangePassword) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Checked here rather than server-side because the server has no idea what
    // the user typed twice — this is the one validation the client genuinely
    // owns.
    if (newPassword !== confirm) {
      setError(new Error('The two passwords do not match'))
      return
    }

    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword })

      /**
       * Sign out rather than route onward.
       *
       * changePassword revokes every OTHER session (auth.service.ts) and clears
       * mustChangePassword on the user — but `me` in this tab still says true,
       * and re-reading it would race the write. Signing in again with the new
       * password is one extra step and leaves no room for a stale flag to bounce
       * them back here forever.
       */
      await logout()
      navigate('/login', { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-ink">Choose a password</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Your account was created with a temporary password. Pick your own before continuing.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-lg border border-edge bg-surface p-6">
          {/* The server applies §7.3's real policy — it depends on the role, so
              it cannot be checked here — and returns every violation at once.
              This renders them rather than guessing at the rules. */}
          <ErrorNote error={error} />

          <Field label="Temporary password" required>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>

          <Field label="New password" required>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>

          <Field label="Confirm new password" required>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>

          <Button type="submit" loading={busy} className="w-full">
            Set password
          </Button>
        </form>
      </div>
    </main>
  )
}
