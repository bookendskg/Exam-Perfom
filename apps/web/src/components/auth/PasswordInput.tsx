import { forwardRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '../ui'
import { cn } from '../../lib/cn'

/**
 * A password field that can be revealed.
 *
 * Typing a password blind on a phone keyboard is the single largest source of
 * failed sign-ins, and every failure here is expensive: this app locks an
 * account for fifteen minutes after five of them.
 *
 * Wraps the design system's `Input` rather than a bare `<input>`, so it inherits
 * the `Field` context — id, `aria-invalid` and `aria-describedby` are wired by
 * the surrounding `<Field>` exactly as they are for every other control.
 */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function PasswordInput({ className, ...props }, ref) {
    const [visible, setVisible] = useState(false)
    const Icon = visible ? EyeOff : Eye

    return (
      <div className="relative">
        <Input
          {...props}
          ref={ref}
          type={visible ? 'text' : 'password'}
          // Room for the toggle, so a long password never runs underneath it.
          className={cn('pr-10', className)}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          // Deliberately focusable. Placing it in the tab order is the whole
          // point for anyone who cannot use a mouse — skipping it with
          // tabIndex={-1} would put the control behind a pointer-only gesture.
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className={cn(
            'absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-md',
            'text-on-surface-variant transition-colors hover:text-on-surface',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
          )}
        >
          <Icon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    )
  }
)
