import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowLeft, CheckCircle2, KeyRound, ShieldCheck, Smartphone } from 'lucide-react'
import { ADMIN_POLICY } from '@bookends/core/password/policy'
import { api, ApiError } from '../lib/api'
import { Alert, Button, Card, Field, Input } from '../components/ui'
import { useToast } from '../components/ui/Toast'
import { PasswordInput } from '../components/auth/PasswordInput'
import { PasswordStrength, requirementsFor } from '../components/auth/PasswordStrength'

/**
 * §5.3 password recovery: number → code → new password → done.
 *
 * Three steps in one component rather than three routes, because the flow is
 * strictly linear and each step needs the one before it. Separate URLs would be
 * directly reachable, so /forgot-password/new-password would have to invent a
 * story about what to do with no verified code — and a refresh mid-flow would
 * land somewhere meaningless. Here, a reload restarts recovery, which is both
 * safe and what the user expects.
 */
type Step = 'phone' | 'code' | 'password' | 'done'

/**
 * The reset screen cannot know the user's role — nobody is signed in — so the
 * checklist cannot know which policy applies. It shows the stricter admin rules.
 *
 * Over-asking is recoverable: a password that satisfies the admin policy
 * satisfies the staff one too, so the server accepts anything the checklist
 * accepts. Under-asking would show a completed checklist and then a rejection,
 * which is the failure the shared policy exists to prevent.
 */
const RESET_POLICY = ADMIN_POLICY

const phoneSchema = z.object({
  phone: z
    .string()
    .min(1, 'Enter your phone number')
    .regex(/^[0-9+\-\s()]+$/, 'Use digits only')
    .refine((v) => v.replace(/\D/g, '').length >= 10, 'Enter a complete phone number'),
})

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Enter the 6-digit code'),
})

const passwordSchema = z
  .object({
    newPassword: z
      .string()
      .min(1, 'Choose a new password')
      .refine(
        (v) => requirementsFor(v, RESET_POLICY).every((r) => r.met),
        'This password does not meet the requirements below'
      ),
    confirm: z.string().min(1, 'Re-enter your new password'),
  })
  .refine((v) => v.newPassword === v.confirm, {
    message: 'The two passwords do not match',
    path: ['confirm'],
  })

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-surface-container px-4 py-10">
      <div className="w-full max-w-sm motion-safe:animate-fade-in">
        <div className="mb-8 text-center">
          <div className="text-headline-sm font-semibold tracking-tight text-primary">BOOKENDS</div>
          <p className="mt-1 text-body-sm text-on-surface-variant">Staff Performance Portal</p>
        </div>
        <Card className="p-6 sm:p-8">{children}</Card>
        <p className="mt-6 text-center">
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 rounded text-body-sm font-medium text-on-surface-variant hover:text-on-surface hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  )
}

function StepIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
      {children}
    </div>
  )
}

export function ForgotPasswordPage() {
  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState('')
  const [resetToken, setResetToken] = useState('')

  return (
    <Shell>
      {step === 'phone' && (
        <PhoneStep
          onSent={(value) => {
            setPhone(value)
            setStep('code')
          }}
        />
      )}
      {step === 'code' && (
        <CodeStep
          phone={phone}
          onVerified={(token) => {
            setResetToken(token)
            setStep('password')
          }}
          onStartOver={() => setStep('phone')}
        />
      )}
      {step === 'password' && <PasswordStep token={resetToken} onDone={() => setStep('done')} />}
      {step === 'done' && <DoneStep />}
    </Shell>
  )
}

function PhoneStep({ onSent }: { onSent: (phone: string) => void }) {
  const {
    register,
    handleSubmit,
    setFocus,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof phoneSchema>>({
    resolver: zodResolver(phoneSchema),
    mode: 'onTouched',
    defaultValues: { phone: '' },
  })

  useEffect(() => {
    setFocus('phone')
  }, [setFocus])

  const onSubmit = async ({ phone }: z.infer<typeof phoneSchema>) => {
    try {
      await api.post('/auth/forgot-password', { phone })
      // Always advances, because the API always answers the same way. Stopping
      // here for an unknown number would report whether it is registered — the
      // one thing the endpoint is carefully built not to say.
      onSent(phone)
    } catch (err) {
      setError('root', {
        message:
          err instanceof ApiError
            ? err.message
            : 'Could not reach the server. Check your connection and try again.',
      })
    }
  }

  return (
    <>
      <StepIcon>
        <Smartphone aria-hidden="true" className="h-5 w-5" />
      </StepIcon>
      <h1 className="text-title-md font-semibold text-on-surface">Reset your password</h1>
      <p className="mt-1.5 text-body-sm text-on-surface-variant">
        Enter your phone number and we will send you a 6-digit code.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-6 space-y-4">
        {errors.root && <Alert tone="danger">{errors.root.message}</Alert>}

        <Field label="Phone number" error={errors.phone?.message} required>
          <Input
            {...register('phone')}
            placeholder="9876543210"
            autoComplete="username"
            inputMode="numeric"
          />
        </Field>

        <Button type="submit" loading={isSubmitting} className="w-full justify-center">
          {isSubmitting ? 'Sending…' : 'Send code'}
        </Button>
      </form>
    </>
  )
}

function CodeStep({
  phone,
  onVerified,
  onStartOver,
}: {
  phone: string
  onVerified: (token: string) => void
  onStartOver: () => void
}) {
  const toast = useToast()
  const [resentAt, setResentAt] = useState<number | null>(null)

  const {
    register,
    handleSubmit,
    setFocus,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof codeSchema>>({
    resolver: zodResolver(codeSchema),
    mode: 'onTouched',
    defaultValues: { code: '' },
  })

  useEffect(() => {
    setFocus('code')
  }, [setFocus])

  const masked = useMemo(
    () => (phone.length <= 4 ? phone : `${'•'.repeat(phone.length - 4)}${phone.slice(-4)}`),
    [phone]
  )

  const onSubmit = async ({ code }: z.infer<typeof codeSchema>) => {
    try {
      const { data } = await api.post<{ resetToken: string }>('/auth/verify-reset-code', {
        phone,
        code,
      })
      onVerified(data.resetToken)
    } catch (err) {
      setError('code', {
        message:
          err instanceof ApiError
            ? (err.detailFor('code') ?? err.message)
            : 'Could not reach the server. Please try again.',
      })
    }
  }

  const resend = async () => {
    try {
      await api.post('/auth/forgot-password', { phone })
      setResentAt(Date.now())
      // Deliberately vague. The server applies a cooldown and will not always
      // have issued a new code; claiming one was sent would be a guess.
      toast.success('Code requested', 'If a code was due, it is on its way.')
    } catch {
      toast.error('Could not request a new code', 'Please try again in a moment.')
    }
  }

  return (
    <>
      <StepIcon>
        <KeyRound aria-hidden="true" className="h-5 w-5" />
      </StepIcon>
      <h1 className="text-title-md font-semibold text-on-surface">Enter the code</h1>
      <p className="mt-1.5 text-body-sm text-on-surface-variant">
        If {masked} is registered, a 6-digit code is on its way. It expires in 10 minutes.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-6 space-y-4">
        <Field label="6-digit code" error={errors.code?.message} required>
          <Input
            {...register('code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            // Wide, evenly spaced digits: this is read off another screen and
            // typed back, and a cramped field makes transcription errors that
            // cost one of only five attempts.
            className="text-center text-headline-sm tracking-[0.4em]"
          />
        </Field>

        <Button type="submit" loading={isSubmitting} className="w-full justify-center">
          {isSubmitting ? 'Verifying…' : 'Verify code'}
        </Button>
      </form>

      <div className="mt-5 flex items-center justify-between gap-3 text-body-sm">
        <button
          type="button"
          onClick={() => void resend()}
          disabled={resentAt !== null}
          className="rounded font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-on-surface-variant disabled:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {resentAt ? 'Code requested' : 'Resend code'}
        </button>
        <button
          type="button"
          onClick={onStartOver}
          className="rounded text-on-surface-variant hover:text-on-surface hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Use a different number
        </button>
      </div>
    </>
  )
}

function PasswordStep({ token, onDone }: { token: string; onDone: () => void }) {
  const {
    register,
    handleSubmit,
    watch,
    setFocus,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    mode: 'onTouched',
    defaultValues: { newPassword: '', confirm: '' },
  })

  const newPassword = watch('newPassword') ?? ''

  useEffect(() => {
    setFocus('newPassword')
  }, [setFocus])

  const onSubmit = async (values: z.infer<typeof passwordSchema>) => {
    try {
      await api.post('/auth/reset-password', { token, newPassword: values.newPassword })
      onDone()
    } catch (err) {
      if (err instanceof ApiError) {
        const policy = err.detailFor('newPassword')
        const badToken = err.detailFor('token')
        if (policy) setError('newPassword', { message: policy })
        // The token expires 30 minutes after verification. Saying so plainly
        // beats a generic failure the user cannot act on.
        else if (badToken)
          setError('root', {
            message: 'This reset has expired. Please start again from the sign-in page.',
          })
        else setError('root', { message: err.message })
      } else {
        setError('root', { message: 'Could not reach the server. Please try again.' })
      }
    }
  }

  return (
    <>
      <StepIcon>
        <ShieldCheck aria-hidden="true" className="h-5 w-5" />
      </StepIcon>
      <h1 className="text-title-md font-semibold text-on-surface">Choose a new password</h1>
      <p className="mt-1.5 text-body-sm text-on-surface-variant">
        Signing in elsewhere will be ended on every device.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-6 space-y-4">
        {errors.root && <Alert tone="danger">{errors.root.message}</Alert>}

        <Field label="New password" error={errors.newPassword?.message} required>
          <PasswordInput {...register('newPassword')} autoComplete="new-password" />
        </Field>

        <PasswordStrength password={newPassword} policy={RESET_POLICY} />

        <Field label="Confirm new password" error={errors.confirm?.message} required>
          <PasswordInput {...register('confirm')} autoComplete="new-password" />
        </Field>

        <Button type="submit" loading={isSubmitting} className="w-full justify-center">
          {isSubmitting ? 'Saving…' : 'Reset password'}
        </Button>
      </form>
    </>
  )
}

function DoneStep() {
  const navigate = useNavigate()
  const [seconds, setSeconds] = useState(5)

  /**
   * Counts down, then goes to sign-in. The count is shown rather than hidden so
   * the redirect is not a surprise, and the button below makes waiting optional
   * — an automatic redirect with no way to skip it is its own annoyance.
   */
  useEffect(() => {
    if (seconds <= 0) {
      navigate('/login', { replace: true })
      return
    }
    const timer = setTimeout(() => setSeconds((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [seconds, navigate])

  return (
    <div className="text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-success-container text-success">
        <CheckCircle2 aria-hidden="true" className="h-6 w-6" />
      </div>

      <h1 className="text-title-md font-semibold text-on-surface">Password reset</h1>
      {/* Announced, because the screen it replaces had focus and a sighted user
          sees the change while a screen-reader user would otherwise not. */}
      <p role="status" className="mt-1.5 text-body-sm text-on-surface-variant">
        You can now sign in with your new password. Taking you there in {seconds}…
      </p>

      <Button
        onClick={() => navigate('/login', { replace: true })}
        className="mt-6 w-full justify-center"
      >
        Go to sign in
      </Button>
    </div>
  )
}
