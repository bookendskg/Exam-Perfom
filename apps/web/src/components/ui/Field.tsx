import { createContext, useContext, useId } from 'react'
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { cn } from '../../lib/cn'

/**
 * Wiring shared between a Field and the control inside it.
 *
 * The control needs three things the label knows: its own id, whether it is
 * invalid, and the id of the message describing why. Passing them through
 * context means a caller writes `<Field label="Phone"><Input /></Field>` and
 * gets the correct ARIA relationships for free — previously the error text sat
 * in an unassociated <span>, so a screen reader never announced it.
 */
interface FieldContext {
  controlId: string
  describedBy: string | undefined
  invalid: boolean
}

const FieldCtx = createContext<FieldContext | null>(null)

/** Control-side half of Field. Returns empty props when used standalone. */
function useFieldProps() {
  const ctx = useContext(FieldCtx)
  if (!ctx) return {}
  return {
    id: ctx.controlId,
    'aria-invalid': ctx.invalid || undefined,
    'aria-describedby': ctx.describedBy,
  }
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
  /** Guidance shown under the control. Hidden once an error replaces it. */
  hint?: string
  required?: boolean
  children: ReactNode
}) {
  const controlId = useId()
  const messageId = `${controlId}-message`
  const hasMessage = Boolean(error ?? hint)

  return (
    <FieldCtx.Provider
      value={{
        controlId,
        describedBy: hasMessage ? messageId : undefined,
        invalid: Boolean(error),
      }}
    >
      <div className="block">
        <label
          htmlFor={controlId}
          className="mb-1.5 block text-body-sm font-medium text-on-surface"
        >
          {label}
          {required && (
            <>
              <span aria-hidden="true" className="ml-0.5 text-danger">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          )}
        </label>

        {children}

        {hasMessage && (
          <p
            id={messageId}
            // Errors are announced as they appear; hints are not, since they
            // are present from the start and would be noise.
            role={error ? 'alert' : undefined}
            className={cn('mt-1.5 text-caption', error ? 'text-danger' : 'text-on-surface-variant')}
          >
            {error ?? hint}
          </p>
        )}
      </div>
    </FieldCtx.Provider>
  )
}

/** Shared control chrome, so input/select/textarea cannot drift apart. */
const controlClasses = cn(
  'w-full rounded-md border bg-surface-lowest text-on-surface',
  'border-outline-variant placeholder:text-on-surface-variant/60',
  'transition-colors hover:border-outline',
  'aria-[invalid]:border-danger',
  'disabled:cursor-not-allowed disabled:bg-surface-container disabled:opacity-60'
)

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...useFieldProps()}
      {...props}
      className={cn(controlClasses, 'h-10 px-3 text-body-sm', className)}
    />
  )
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...useFieldProps()}
      {...props}
      className={cn(controlClasses, 'min-h-[5rem] px-3 py-2 text-body-sm', className)}
    />
  )
}

export interface SelectOption {
  value: string
  label: string
}

/**
 * A native <select>, deliberately.
 *
 * The filter dropdowns were previously inline <select> elements copy-pasted
 * across two pages. A custom listbox would look more designed, but native gets
 * correct keyboard behaviour, mobile pickers and screen-reader support for
 * free — worth more here than a styled popup.
 */
export function Select({
  options,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { options: SelectOption[] }) {
  return (
    <select
      {...useFieldProps()}
      {...props}
      className={cn(
        controlClasses,
        'h-10 cursor-pointer appearance-none bg-no-repeat px-3 pr-9 text-body-sm',
        // Chevron drawn as a background image so the control stays a native
        // <select> (an overlaid icon would swallow clicks on some browsers).
        "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 fill=%22none%22 viewBox=%220 0 24 24%22 stroke-width=%222%22 stroke=%22%23697586%22%3E%3Cpath stroke-linecap=%22round%22 stroke-linejoin=%22round%22 d=%22m6 9 6 6 6-6%22/%3E%3C/svg%3E')]",
        'bg-[length:1.1rem] bg-[right_0.6rem_center]',
        className
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
