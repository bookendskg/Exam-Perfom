import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className,
  /** Lifts on hover. Only for cards that are themselves a link or button. */
  interactive = false,
}: {
  children: ReactNode
  className?: string
  interactive?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-outline-variant bg-surface-lowest shadow-xs',
        interactive &&
          'transition-shadow duration-200 hover:border-outline hover:shadow-md motion-reduce:transition-none',
        className
      )}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 border-b border-outline-variant px-5 py-4',
        className
      )}
    >
      <div className="min-w-0">
        <h2 className="text-title-md text-on-surface">{title}</h2>
        {description && (
          <p className="mt-0.5 text-body-sm text-on-surface-variant">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('p-5', className)}>{children}</div>
}

/* -------------------------------------------------------------------------- */
/* Page header                                                                 */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {/* The only <h1> on the page — the shell deliberately does not render one. */}
        <h1 className="text-headline-lg text-on-surface">{title}</h1>
        {subtitle && <p className="mt-1 text-body-sm text-on-surface-variant">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Stat                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A single headline figure.
 *
 * `tabular-nums` matters more than it looks: without it, proportional digits
 * change width as a count updates and the whole tile shifts.
 */
export function Stat({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string
  value: ReactNode
  hint?: string
  icon?: ReactNode
  /** Optional accent bar, to mark a figure that needs attention. */
  tone?: 'primary' | 'success' | 'warning' | 'danger'
}) {
  const accent = {
    primary: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
  }

  return (
    <Card className="relative overflow-hidden">
      {tone && (
        <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-1', accent[tone])} />
      )}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-label-caps uppercase text-on-surface-variant">{label}</p>
          {icon && <span className="shrink-0 text-on-surface-variant">{icon}</span>}
        </div>
        <p className="mt-2 text-stat-lg tabular-nums text-on-surface">{value}</p>
        {hint && <p className="mt-1 text-caption text-on-surface-variant">{hint}</p>}
      </div>
    </Card>
  )
}
