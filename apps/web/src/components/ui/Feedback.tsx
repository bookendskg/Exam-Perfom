import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react'
import { cn } from '../../lib/cn'

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/* -------------------------------------------------------------------------- */
/* Alert                                                                       */
/* -------------------------------------------------------------------------- */

const ALERT_TONES: Record<Tone, string> = {
  neutral: 'border-outline-variant bg-surface-container text-on-surface',
  info: 'border-info/30 bg-info-container text-on-surface',
  success: 'border-success/30 bg-success-container text-on-surface',
  warning: 'border-warning/30 bg-warning-container text-on-surface',
  danger: 'border-danger/30 bg-danger-container text-on-surface',
}

const ALERT_ICONS: Record<Tone, typeof Info> = {
  neutral: Info,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
}

const ICON_TONES: Record<Tone, string> = {
  neutral: 'text-on-surface-variant',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
}

/**
 * One banner for every message the app shows.
 *
 * This replaces five hand-rolled variants that had drifted into three different
 * paddings and two different corner radii. Errors get `role="alert"` so they
 * are announced — none of the originals were.
 */
export function Alert({
  tone = 'neutral',
  title,
  children,
  className,
}: {
  tone?: Tone
  title?: string
  children?: ReactNode
  className?: string
}) {
  const Icon = ALERT_ICONS[tone]
  const assertive = tone === 'danger' || tone === 'warning'

  return (
    <div
      role={assertive ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border p-4 text-body-sm', ALERT_TONES[tone], className)}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 h-5 w-5 shrink-0', ICON_TONES[tone])} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-1', 'text-on-surface-variant')}>{children}</div>}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                       */
/* -------------------------------------------------------------------------- */

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-surface-container-high text-on-surface-variant',
  info: 'bg-info-container text-info',
  success: 'bg-success-container text-success',
  warning: 'bg-warning-container text-warning',
  danger: 'bg-danger-container text-danger',
}

/**
 * MIGRATION SHIM — remove once every page uses the semantic tone names.
 *
 * The original Badge spoke good/warn/bad. Accepting both keeps the not-yet
 * redesigned pages compiling without a big-bang rewrite of their STATUS_TONE
 * maps.
 */
type LegacyTone = 'good' | 'warn' | 'bad'
const LEGACY_TONES: Record<LegacyTone, Tone> = {
  good: 'success',
  warn: 'warning',
  bad: 'danger',
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: Tone | LegacyTone
  className?: string
}) {
  const resolved: Tone = tone in LEGACY_TONES ? LEGACY_TONES[tone as LegacyTone] : (tone as Tone)

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-caption font-semibold',
        BADGE_TONES[resolved],
        className
      )}
    >
      {children}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <>
      <Loader2 aria-hidden="true" className={cn('h-4 w-4 animate-spin', className)} />
      <span className="sr-only">{label}</span>
    </>
  )
}

/**
 * A shimmering placeholder shaped like the content it stands in for.
 *
 * Preferred over a spinner for lists and cards: it holds the layout, so the
 * page does not jump when data lands.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('relative overflow-hidden rounded-md bg-surface-container-high', className)}
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-black/[0.04] to-transparent dark:via-white/[0.06]" />
    </div>
  )
}

/** Rows of skeleton cells, matching the table body they replace. */
export function TableSkeleton({ rows = 5, columns }: { rows?: number; columns: number }) {
  return (
    <div className="divide-y divide-outline-variant" role="status" aria-label="Loading results">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: columns }, (_, cellIndex) => (
            <Skeleton
              key={cellIndex}
              className={cn('h-4 flex-1', cellIndex === 0 && 'max-w-[8rem]')}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                 */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
          {icon}
        </div>
      )}
      <p className="text-title-md text-on-surface">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-body-sm text-on-surface-variant">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
