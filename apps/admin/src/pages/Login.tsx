import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.js'
import { Button, ErrorNote, Field, Input } from '../components/ui.js'

/**
 * §5.3 login.
 *
 * Asks for the organisation as well as the phone, because the server resolves
 * the tenant BEFORE it looks at credentials (tenant.resolver.ts). That is not
 * an implementation detail leaking into the UI — it is deliberate: §24.1's
 * "type your phone and we'll show you which companies you work for" would tell
 * an unauthenticated stranger that a number exists and where it works.
 *
 * On a real deployment the slug comes from the subdomain and this field is
 * hidden. Here it is typed, and remembered, so a returning user does not have
 * to enter their own company name twice.
 */
export function Login() {
  const { login, tenantSlug } = useAuth()
  const navigate = useNavigate()

  const [slug, setSlug] = useState(tenantSlug ?? '')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await login(slug.trim().toLowerCase(), phone.trim(), password)
      // §7.3: an account created for someone starts with a derived password and
      // must not be usable until they change it. Routing anywhere else would
      // hand them a dashboard the API will 403 on every request.
      navigate(result.mustChangePassword ? '/change-password' : '/', { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-primary">ExamHub</h1>
          <p className="mt-1 text-sm text-ink-muted">Staff performance &amp; examinations</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-lg border border-edge bg-surface p-6">
          <ErrorNote error={error} />

          <Field label="Organisation" required hint="The address your team uses to sign in">
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="bookends"
              autoComplete="organization"
              required
            />
          </Field>

          <Field label="Phone number" required>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="9876543210"
              // §7.1 logs in by phone, so the browser should offer the phone,
              // not an email it has saved for some other site.
              autoComplete="tel"
              inputMode="numeric"
              required
            />
          </Field>

          <Field label="Password" required>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>

          <Button type="submit" loading={busy} className="w-full">
            Sign in
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-ink-muted">
          New organisation? <a className="text-primary underline" href="/signup">Start a free trial</a>
        </p>
      </div>
    </main>
  )
}
