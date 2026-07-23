import { useEffect, useMemo } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ShieldCheck } from 'lucide-react'
import { policyForRole } from '@bookends/core/password/policy'
import { useAuth } from '../lib/auth'
import { ApiError } from '../lib/api'
import { Alert, Button, Card, Field } from '../components/ui'
import { useToast } from '../components/ui/Toast'
import { PasswordInput } from '../components/auth/PasswordInput'
import { PasswordStrength, requirementsFor } from '../components/auth/PasswordStrength'

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
  const toast = useToast()

  /**
   * Staff and admin roles have genuinely different rules (6 characters and no
   * complexity, against 8 with an uppercase letter and a number), so the
   * checklist has to know which one applies.
   *
   * Falls back to the stricter admin policy when the role is somehow unknown.
   * Over-asking is recoverable — a password that satisfies the admin rules
   * satisfies the staff ones too — whereas under-asking shows a completed
   * checklist and then a rejection from the server.
   */
  const policy = useMemo(() => policyForRole(user?.role ?? 'admin'), [user?.role])

  const schema = useMemo(
    () =>
      z
        .object({
          currentPassword: z.string().min(1, 'Enter your current password'),
          // Mirrors the server's rules exactly, because they come from the same
          // module the server validates with.
          newPassword: z
            .string()
            .min(1, 'Choose a new password')
            .refine(
              (v) => requirementsFor(v, policy).every((r) => r.met),
              'This password does not meet the requirements below'
            ),
          confirm: z.string().min(1, 'Re-enter your new password'),
        })
        .refine((v) => v.newPassword === v.confirm, {
          message: 'The two passwords do not match',
          // Reported on the field the user must actually correct.
          path: ['confirm'],
        })
        .refine((v) => v.newPassword !== v.currentPassword, {
          message: 'Choose a password different from your current one',
          path: ['newPassword'],
        }),
    [policy]
  )

  type FormValues = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    watch,
    setFocus,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  })

  // Drives the live meter below the field.
  const newPassword = watch('newPassword') ?? ''

  useEffect(() => {
    setFocus('currentPassword')
  }, [setFocus])

  // Reachable only while the gate is up, or for a signed-in user changing it
  // by choice. Otherwise there is nothing to change.
  if (!passwordChangeRequired && !user) return <Navigate to="/login" replace />

  const onSubmit = async (values: FormValues) => {
    try {
      await changePassword(values.currentPassword, values.newPassword)
      toast.success('Password changed', 'Your other sessions have been signed out.')
      navigate('/')
    } catch (err) {
      if (err instanceof ApiError) {
        /**
         * The API answers a wrong current password with a `currentPassword`
         * detail and a policy failure with `newPassword` details. Routing each
         * to its own field is what makes the message actionable — before the
         * server started naming the field correctly, none of this was reachable
         * and every failure showed one generic banner.
         */
        const current = err.detailFor('currentPassword')
        const next = err.detailFor('newPassword')

        if (current) setError('currentPassword', { message: current })
        if (next) setError('newPassword', { message: next })
        if (!current && !next) setError('root', { message: err.message })
      } else {
        setError('root', { message: 'Could not reach the server. Please try again.' })
      }
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-surface-container px-4 py-10">
      <div className="w-full max-w-sm motion-safe:animate-fade-in">
        <div className="mb-8 text-center">
          <div className="text-headline-sm font-semibold tracking-tight text-primary">BOOKENDS</div>
          <p className="mt-1 text-body-sm text-on-surface-variant">Choose a new password</p>
        </div>

        <Card className="p-6 sm:p-8">
          {passwordChangeRequired && (
            <Alert tone="warning" className="mb-5">
              You must change your password before you can continue.
            </Alert>
          )}

          <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
            {errors.root && (
              <Alert tone="danger" className="motion-safe:animate-slide-up">
                {errors.root.message}
              </Alert>
            )}

            <Field label="Current password" error={errors.currentPassword?.message} required>
              <PasswordInput {...register('currentPassword')} autoComplete="current-password" />
            </Field>

            <Field label="New password" error={errors.newPassword?.message} required>
              <PasswordInput {...register('newPassword')} autoComplete="new-password" />
            </Field>

            <PasswordStrength password={newPassword} policy={policy} />

            <Field label="Confirm new password" error={errors.confirm?.message} required>
              <PasswordInput {...register('confirm')} autoComplete="new-password" />
            </Field>

            <Button
              type="submit"
              loading={isSubmitting}
              icon={<ShieldCheck aria-hidden="true" className="h-4 w-4" />}
              className="w-full justify-center"
            >
              {isSubmitting ? 'Saving…' : 'Change password'}
            </Button>
          </form>
        </Card>
      </div>
    </main>
  )
}
