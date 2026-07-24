import { useEffect } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { LogIn } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { ApiError } from '../lib/api'
import { Alert, Button, Card, Field, Input } from '../components/ui'
import { PasswordInput } from '../components/auth/PasswordInput'

/**
 * Mirrors what the API accepts, so an obviously malformed email is caught before
 * it costs a round trip — and, more importantly, before it costs one of the five
 * attempts that lock the account for fifteen minutes.
 *
 * The management panel signs in with email. Staff sign in on the Android app
 * with a phone number, which posts to the same endpoint — that path is
 * unaffected by this form.
 */
const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
  rememberMe: z.boolean(),
})

type FormValues = z.infer<typeof schema>

/** Where the email is kept between visits when "Remember me" is ticked. */
const REMEMBERED_EMAIL = 'bookends.rememberedEmail'

export function LoginPage() {
  const { user, login, passwordChangeRequired } = useAuth()
  const navigate = useNavigate()

  const remembered = localStorage.getItem(REMEMBERED_EMAIL)

  const {
    register,
    handleSubmit,
    setFocus,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    // Errors appear when a field is left, then correct themselves as the user
    // types. Validating on every keystroke from the start would mark a field
    // invalid before it has been finished.
    mode: 'onTouched',
    defaultValues: { email: remembered ?? '', password: '', rememberMe: Boolean(remembered) },
  })

  /**
   * Focus what the user still has to fill in. Returning visitors have their
   * email already, so sending them to the top would make them tab past it.
   */
  useEffect(() => {
    setFocus(remembered ? 'password' : 'email')
  }, [setFocus, remembered])

  if (passwordChangeRequired) return <Navigate to="/change-password" replace />
  if (user) return <Navigate to="/" replace />

  const onSubmit = async (values: FormValues) => {
    try {
      await login(values.email, values.password)

      // Only the email, never the password. Persisted after success so a typo
      // is not what gets remembered.
      if (values.rememberMe) localStorage.setItem(REMEMBERED_EMAIL, values.email)
      else localStorage.removeItem(REMEMBERED_EMAIL)

      navigate('/')
    } catch (err) {
      /**
       * §7.2 returns the same message for a wrong email, a wrong password and a
       * disabled account, precisely so nobody can enumerate which accounts
       * exist. Showing it verbatim keeps that intact.
       *
       * Attached to the form root rather than to a field for the same reason —
       * marking `email` invalid would say the email was the part that was wrong,
       * which is exactly what the API declines to reveal.
       */
      // The API already phrases every case safely — invalid credentials,
      // account locked, password-change-required — so its message is shown
      // verbatim; only a transport failure (no ApiError) needs our own wording.
      setError('root', {
        message:
          err instanceof ApiError
            ? err.message
            : 'Could not reach the server. Check your connection and try again.',
      })
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-surface-container px-4 py-10">
      <div className="w-full max-w-sm motion-safe:animate-fade-in">
        <div className="mb-8 text-center">
          <div className="text-headline-sm font-semibold tracking-tight text-primary">BOOKENDS</div>
          <p className="mt-1 text-body-sm text-on-surface-variant">Staff Performance Portal</p>
        </div>

        <Card className="p-6 sm:p-8">
          <h1 className="text-title-md font-semibold text-on-surface">Sign in</h1>
          <p className="mt-1 text-body-sm text-on-surface-variant">
            Welcome back. Enter your details to continue.
          </p>

          {/*
            `noValidate` hands validation to Zod. Without it the browser's own
            bubbles fire first, in a different voice, and never reach a screen
            reader the way the field messages below do. Enter-to-submit is
            native to <form> and needs no handler.
          */}
          <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-6 space-y-4">
            {errors.root && (
              <Alert tone="danger" className="motion-safe:animate-slide-up">
                {errors.root.message}
              </Alert>
            )}

            <Field label="Email" error={errors.email?.message} required>
              <Input
                {...register('email')}
                type="email"
                placeholder="you@example.com"
                autoComplete="username"
                inputMode="email"
              />
            </Field>

            <Field label="Password" error={errors.password?.message} required>
              <PasswordInput {...register('password')} autoComplete="current-password" />
            </Field>

            <div className="flex items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-body-sm text-on-surface-variant">
                <input
                  type="checkbox"
                  {...register('rememberMe')}
                  className="h-4 w-4 rounded border-outline-variant text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
                Remember me
              </label>

              <Link
                to="/forgot-password"
                className="rounded text-body-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Forgot password?
              </Link>
            </div>

            <Button
              type="submit"
              loading={isSubmitting}
              icon={<LogIn aria-hidden="true" className="h-4 w-4" />}
              className="w-full justify-center"
            >
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-caption text-on-surface-variant">
          Staff take exams in the Android app. This panel is for management.
        </p>
      </div>
    </main>
  )
}
