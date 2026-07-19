import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { ApiError } from '../lib/api'
import { Button, Card, Field, Input } from '../components/ui'

export function LoginPage() {
  const { user, login, passwordChangeRequired } = useAuth()
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (passwordChangeRequired) return <Navigate to="/change-password" replace />
  if (user) return <Navigate to="/" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(phone, password)
      navigate('/')
    } catch (err) {
      /**
       * §7.2 returns the same message for a wrong number, a wrong password and
       * a disabled account, precisely so nobody can enumerate which of the 300
       * staff numbers are registered. Showing it verbatim keeps that intact.
       */
      setError(err instanceof ApiError ? err.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-stone-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-lg font-semibold tracking-tight text-brand-700">BOOKENDS</div>
          <div className="mt-1 text-sm text-stone-500">Staff Performance Portal</div>
        </div>

        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label="Phone number">
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="9876543210"
                autoComplete="username"
                inputMode="numeric"
                required
              />
            </Field>

            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {error}
              </div>
            )}

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-xs text-stone-400">
          Staff take exams in the Android app. This panel is for management.
        </p>
      </div>
    </div>
  )
}
