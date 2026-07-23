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
 * Mirrors what the API accepts, so an obviously malformed number is caught
 * before it costs a round trip — and, more importantly, before it costs one of
 * the five attempts that lock the account for fifteen minutes.
 *
 * Deliberately permissive about format beyond length: the API is the authority
 * on which numbers exist, and a client-side rule that is stricter than the
 * server's would reject a legitimate user with no way to appeal.
 */
const schema = z.object({
  phone: z
    .string()
    .min(1, 'Enter your phone number')
    .regex(/^[0-9+\-\s()]+$/, 'Use digits only')
    .refine((v) => v.replace(/\D/g, '').length >= 10, 'Enter a complete phone number'),
  password: z.string().min(1, 'Enter your password'),
  rememberMe: z.boolean(),
})

type FormValues = z.infer<typeof schema>

/** Where the phone number is kept between visits when "Remember me" is ticked. */
const REMEMBERED_PHONE = 'bookends.rememberedPhone'

export function LoginPage() {
  const { user, login, passwordChangeRequired } = useAuth()
  const navigate = useNavigate()

  const remembered = localStorage.getItem(REMEMBERED_PHONE)

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
    defaultValues: { phone: remembered ?? '', password: '', rememberMe: Boolean(remembered) },
  })

  /**
   * Focus what the user still has to fill in. Returning visitors have their
   * number already, so sending them to the top would make them tab past it.
   */
  useEffect(() => {
    setFocus(remembered ? 'password' : 'phone')
  }, [setFocus, remembered])

  if (passwordChangeRequired) return <Navigate to="/change-password" replace />
  if (user) return <Navigate to="/" replace />

  const onSubmit = async (values: FormValues) => {
    try {
      await login(values.phone, values.password)

      // Only the number, never the password. Persisted after success so a typo
      // is not what gets remembered.
      if (values.rememberMe) localStorage.setItem(REMEMBERED_PHONE, values.phone)
      else localStorage.removeItem(REMEMBERED_PHONE)

      navigate('/')
    } catch (err) {
      /**
       * §7.2 returns the same message for a wrong number, a wrong password and
       * a disabled account, precisely so nobody can enumerate which of the 300
       * staff numbers are registered. Showing it verbatim keeps that intact.
       *
       * Attached to the form root rather than to a field for the same reason —
       * marking `phone` invalid would say the number was the part that was
       * wrong, which is exactly what the API declines to reveal.
       */
      const locked = err instanceof ApiError && err.status === 429
      setError('root', {
        message: locked
          ? err.message
          : err instanceof ApiError
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

            <Field label="Phone number" error={errors.phone?.message} required>
              <Input
                {...register('phone')}
                placeholder="9876543210"
                autoComplete="username"
                inputMode="numeric"
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
