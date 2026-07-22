import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-brand-700 active:bg-brand-800 shadow-xs',
  secondary:
    'border border-outline-variant bg-surface-lowest text-on-surface hover:bg-surface-container',
  ghost: 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface',
  danger: 'bg-danger text-white hover:brightness-110 active:brightness-95 shadow-xs',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-body-sm',
  md: 'h-10 gap-2 px-4 text-body-sm',
  lg: 'h-11 gap-2 px-5 text-body-base',
  // Square, for a lone icon. Callers must pass an aria-label.
  icon: 'h-10 w-10 justify-center',
}

/**
 * Shared button styling, exported separately so non-button elements can wear it.
 *
 * React Router's `<Link>` must render an `<a>` to stay a real, middle-clickable
 * link — wrapping it in a `<button>` would break that. Previously the grading
 * queue hand-copied the primary styles onto a Link, which then drifted. Now
 * both call this.
 */
export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string
): string {
  return cn(
    'inline-flex items-center rounded-md font-medium transition-colors',
    'disabled:pointer-events-none disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    className
  )
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  children?: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and blocks input. Use for in-flight submits. */
  loading?: boolean
  /** Rendered before the label. Omitted while loading, so width stays stable. */
  icon?: ReactNode
  className?: string
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  disabled,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      // Tells assistive tech the control is working rather than simply frozen.
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
    >
      {loading ? (
        <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
      ) : (
        icon
      )}
      {children}
    </button>
  )
}
