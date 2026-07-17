import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react'
import { ApiError } from '../lib/api.js'

/**
 * The component set, hand-rolled.
 *
 * Small on purpose — this is what the screens actually need and no more. A
 * component library would be a dependency, a CLI, and a lot of generated code
 * to review for the handful of primitives below.
 */

export function Button({
  variant = 'primary',
  loading = false,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  loading?: boolean
}) {
  const styles = {
    primary: 'bg-primary text-white hover:opacity-90',
    secondary: 'bg-white text-ink border border-edge hover:bg-canvas',
    danger: 'bg-danger text-white hover:opacity-90',
    ghost: 'text-ink-muted hover:bg-canvas',
  }[variant]

  return (
    <button
      // Disabled while loading, so a double-click cannot submit twice — the
      // §8.2 employee-code counter would burn a number on the second.
      disabled={loading || rest.disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...rest}
    >
      {loading && (
        <span
          className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden
        />
      )}
      {children}
    </button>
  )
}

export function Field({
  label,
  error,
  hint,
  required,
  children,
}: {
  label: string
  error?: string | undefined
  hint?: string | undefined
  required?: boolean
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1 block text-xs text-danger">
          {error}
        </span>
      )}
    </label>
  )
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border border-edge bg-white px-3 py-2 text-sm outline-none focus:border-primary ${className}`}
      {...rest}
    />
  )
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md border border-edge bg-white px-3 py-2 text-sm outline-none focus:border-primary ${className}`}
      {...rest}
    >
      {children}
    </select>
  )
}

export function Card({
  title,
  action,
  children,
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-edge bg-surface">
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  children: ReactNode
}) {
  const styles = {
    neutral: 'bg-canvas text-ink-muted',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
    info: 'bg-info/10 text-info',
  }[tone]

  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${styles}`}>{children}</span>
}

/**
 * The error banner every screen uses.
 *
 * §23.2's rule 7 says a plan limit must never be a silent failure — it must say
 * what was hit and offer the upgrade. The API already returns that in `details`,
 * so this renders it rather than flattening everything to "something went
 * wrong", which is what makes a 403 actionable instead of baffling.
 */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null

  if (error instanceof ApiError) {
    return (
      <div
        role="alert"
        className={`rounded-md border px-4 py-3 text-sm ${
          error.isPlanLimit ? 'border-warning/40 bg-warning/5' : 'border-danger/40 bg-danger/5'
        }`}
      >
        <p className="font-medium text-ink">{error.message}</p>
        {error.details.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-ink-muted">
            {error.details.map((d, i) => (
              <li key={i}>
                {d.field !== 'row' && <span className="font-medium">{d.field}: </span>}
                {d.message}
              </li>
            ))}
          </ul>
        )}
        {error.isPlanLimit && (
          <p className="mt-2 text-xs text-ink-muted">
            Contact your account owner to change your plan.
          </p>
        )}
      </div>
    )
  }

  return (
    <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-4 py-3 text-sm">
      {error instanceof Error ? error.message : 'Something went wrong'}
    </div>
  )
}

/** §19.1: every list has a loading, an error, and an EMPTY state. */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-ink-muted">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-ink-muted border-t-transparent"
        aria-hidden
      />
      {label}…
    </div>
  )
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    // overflow-x-auto: a restaurant manager on a laptop should scroll the table,
    // not the page.
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-edge text-xs uppercase tracking-wide text-ink-muted">
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">{children}</tbody>
      </table>
    </div>
  )
}

export function Pager({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number
  totalPages: number
  total: number
  onPage: (page: number) => void
}) {
  if (totalPages <= 1) return null

  return (
    <nav className="flex items-center justify-between border-t border-edge px-4 py-3 text-sm">
      <span className="text-ink-muted">
        Page {page} of {totalPages} · {total} total
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="secondary" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  )
}
