import { Link } from 'react-router-dom'
import { ArrowLeft, LifeBuoy } from 'lucide-react'
import { Alert, Card } from '../components/ui'

/**
 * Password recovery — interim.
 *
 * This page tells the truth about the system as it stands today rather than
 * pretending to a capability it does not have. There is no delivery channel
 * wired: §13's WhatsApp Business API is a later module, `User.email` is
 * optional, and in production `UnconfiguredDispatcher` refuses outright with
 * exactly this instruction. A form that accepted a number and claimed a code
 * was on its way would be a lie the user finds out about by waiting.
 *
 * Phase 3 replaces this with the real one-time-code flow. It exists now so the
 * "Forgot password?" link on the sign-in screen leads somewhere honest instead
 * of bouncing off the catch-all route back to where it started.
 */
export function ForgotPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-surface-container px-4 py-10">
      <div className="w-full max-w-sm motion-safe:animate-fade-in">
        <div className="mb-8 text-center">
          <div className="text-headline-sm font-semibold tracking-tight text-primary">BOOKENDS</div>
          <p className="mt-1 text-body-sm text-on-surface-variant">Staff Performance Portal</p>
        </div>

        <Card className="p-6 sm:p-8">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
            <LifeBuoy aria-hidden="true" className="h-5 w-5" />
          </div>

          <h1 className="text-title-md font-semibold text-on-surface">Reset your password</h1>
          <p className="mt-1.5 text-body-sm text-on-surface-variant">
            Automated password reset is not available yet.
          </p>

          <Alert tone="info" className="mt-5">
            Ask your outlet manager or an administrator to reset it for you. They can issue a new
            temporary password, and you will be asked to choose your own the next time you sign in.
          </Alert>

          <Link
            to="/login"
            className="mt-6 inline-flex items-center gap-1.5 rounded text-body-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back to sign in
          </Link>
        </Card>
      </div>
    </main>
  )
}
