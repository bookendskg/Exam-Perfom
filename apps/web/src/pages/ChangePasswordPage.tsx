import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { ApiError } from '../lib/api'
import { Button, Card, Field, Input } from '../components/ui'

/**
 * §7.3's forced first-login password change.
 *
 * Without this screen the panel is unusable for a new account: the API blocks
 * every other /api/v1 route with PASSWORD_CHANGE_REQUIRED, so a user who has
 * just been created can log in and then find that nothing works, with no way
 * to fix it from the UI.
 */
export function ChangePasswordPage() {
  const { passwordChangeRequired, user, changePassword } = useAuth()
  const navigate = useNavigate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  // Reachable only while the gate is up, or for a signed-in user changing it
  // by choice. Otherwise there is nothing to change.
  if (!passwordChangeRequired && !user) return <Navigate to="/login" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setFieldError(undefined)

    if (newPassword !== confirm) {
      setFieldError('The two passwords do not match')
      return
    }

    setBusy(true)
    try {
      await changePassword(currentPassword, newPassword)
      navigate('/')
    } catch (err) {
      if (err instanceof ApiError) {
        // §7.4's policy failures come back as field details; show them where
        // the user typed rather than as a generic banner.
        setFieldError(err.detailFor('newPassword'))
        setError(err.detailFor('newPassword') ? null : err.message)
      } else {
        setError('Could not change the password')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-stone-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-lg font-semibold tracking-tight text-brand-700">BOOKENDS</div>
          <div className="mt-1 text-sm text-stone-500">Choose a new password</div>
        </div>

        <Card className="p-6">
          {passwordChangeRequired && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              You must change your password before you can continue.
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <Field label="Current password">
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>

            <Field label="New password" error={fieldError}>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>

            <Field label="Confirm new password">
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {error}
              </div>
            )}

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Saving…' : 'Change password'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}
