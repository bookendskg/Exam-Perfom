import type { ReactNode } from 'react'

/**
 * The handful of presentational pieces every screen needs.
 *
 * Deliberately small and local rather than a component library: the panel has
 * five screens, and the states that actually matter — loading, empty, failed —
 * are worth naming so no screen forgets one.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-stone-200 bg-white shadow-sm ${className}`}>
      {children}
    </div>
  )
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-stone-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  variant?: 'primary' | 'secondary' | 'ghost'
  disabled?: boolean
  className?: string
}) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-stone-300',
    secondary: 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
    ghost: 'text-stone-600 hover:bg-stone-100',
  }[variant]

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {children}
      {error && <span className="mt-1 block text-sm text-red-600">{error}</span>}
    </label>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 ${props.className ?? ''}`}
    />
  )
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 ${props.className ?? ''}`}
    />
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const styles = {
    neutral: 'bg-stone-100 text-stone-700',
    good: 'bg-emerald-100 text-emerald-800',
    warn: 'bg-amber-100 text-amber-800',
    bad: 'bg-red-100 text-red-800',
  }[tone]
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{children}</span>
}

/**
 * One component for the three states a fetched screen can be in.
 *
 * Every list here goes through it, which is what stops a screen silently
 * rendering an empty table when the request actually failed — the mistake that
 * makes an API problem look like "there is no data".
 */
export function Async<T>({
  state,
  empty,
  children,
}: {
  state: { loading: boolean; error: string | null; data: T | null }
  empty?: string
  children: (data: T) => ReactNode
}) {
  if (state.loading) {
    return <div className="py-12 text-center text-sm text-stone-500">Loading…</div>
  }
  if (state.error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <p className="font-medium">Could not load this</p>
        <p className="mt-1">{state.error}</p>
      </div>
    )
  }
  if (!state.data || (Array.isArray(state.data) && state.data.length === 0)) {
    return <div className="py-12 text-center text-sm text-stone-500">{empty ?? 'Nothing here yet'}</div>
  }
  return <>{children(state.data)}</>
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">{children}</tbody>
      </table>
    </div>
  )
}
