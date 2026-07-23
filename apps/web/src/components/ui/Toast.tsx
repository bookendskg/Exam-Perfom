import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { Tone } from './Feedback'

/**
 * Transient notifications.
 *
 * The app had no way to confirm that something worked. Success was reported by
 * the absence of an error, which reads as "nothing happened" — particularly
 * after an action that navigates away, where the destination screen carries no
 * evidence the previous step succeeded.
 *
 * Deliberately not a general-purpose queue: at most a handful are ever visible,
 * they dismiss themselves, and they never carry information the user cannot
 * afford to miss. Anything that must be read belongs in an `<Alert>` on the page
 * itself, because a toast that has already faded is unrecoverable.
 */

export interface Toast {
  id: number
  tone: Tone
  title: string
  description?: string
}

interface ToastApi {
  show(toast: Omit<Toast, 'id'>): void
  success(title: string, description?: string): void
  error(title: string, description?: string): void
  dismiss(id: number): void
}

const ToastCtx = createContext<ToastApi | null>(null)

const DEFAULT_DURATION_MS = 5000

const TONE_STYLES: Record<Tone, { container: string; icon: string; Icon: typeof Info }> = {
  neutral: {
    container: 'border-outline-variant bg-surface-container-highest',
    icon: 'text-on-surface-variant',
    Icon: Info,
  },
  info: { container: 'border-info/30 bg-info-container', icon: 'text-info', Icon: Info },
  success: {
    container: 'border-success/30 bg-success-container',
    icon: 'text-success',
    Icon: CheckCircle2,
  },
  warning: {
    container: 'border-warning/30 bg-warning-container',
    icon: 'text-warning',
    Icon: AlertTriangle,
  },
  danger: { container: 'border-danger/30 bg-danger-container', icon: 'text-danger', Icon: XCircle },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  // Monotonic rather than random: two toasts raised in the same millisecond
  // must not collide on a React key.
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const show = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId.current++
      setToasts((current) => [...current, { ...toast, id }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DEFAULT_DURATION_MS)
      )
    },
    [dismiss]
  )

  // Without this, a timer that outlives the provider calls setState on an
  // unmounted tree — harmless in production, noisy in development, and a leak
  // either way.
  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach(clearTimeout)
      pending.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, description) => show({ tone: 'success', title, description }),
      error: (title, description) => show({ tone: 'danger', title, description }),
      dismiss,
    }),
    [show, dismiss]
  )

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  )
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  return (
    <div
      // `pointer-events-none` on the stack and `auto` on each toast keeps the
      // empty column from swallowing clicks on the page beneath it.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:top-0 sm:items-end"
    >
      {toasts.map((toast) => {
        const { container, icon, Icon } = TONE_STYLES[toast.tone]
        const assertive = toast.tone === 'danger' || toast.tone === 'warning'

        return (
          <div
            key={toast.id}
            // Errors interrupt; confirmations wait their turn.
            role={assertive ? 'alert' : 'status'}
            aria-live={assertive ? 'assertive' : 'polite'}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm gap-3 rounded-lg border p-4 shadow-md',
              // The design system's existing entrance, not a second one that
              // does almost the same thing. `motion-safe` so anyone who has
              // asked their OS for reduced motion simply gets the toast.
              'motion-safe:animate-slide-up',
              container
            )}
          >
            <Icon aria-hidden="true" className={cn('mt-0.5 h-5 w-5 shrink-0', icon)} />
            <div className="min-w-0 flex-1">
              <p className="text-body-sm font-semibold text-on-surface">{toast.title}</p>
              {toast.description && (
                <p className="mt-0.5 text-caption text-on-surface-variant">{toast.description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="-m-1 h-6 w-6 shrink-0 rounded p-1 text-on-surface-variant transition-colors hover:bg-black/5 hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:hover:bg-white/10"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
