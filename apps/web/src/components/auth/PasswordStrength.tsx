import { Check, X } from 'lucide-react'
import type { PasswordPolicy } from '@bookends/core/password/policy'
import { cn } from '../../lib/cn'

/**
 * A requirements checklist and strength meter for a new password.
 *
 * The rules come from `@bookends/core/password/policy` — the same module the API
 * validates against — rather than being restated here. A checklist that
 * disagrees with the server is worse than no checklist: it tells the user they
 * have satisfied a rule and then the request fails anyway.
 *
 * That sharing is only possible through a subpath export. `@bookends/core`'s
 * index re-exports the argon2 hasher, which is a native Node addon and cannot be
 * bundled for a browser; `@bookends/core/password/policy` reaches the one module
 * whose entire dependency graph is `roles.ts`, which imports nothing.
 */

export interface Requirement {
  /** Shown to the user. Phrased as the rule, not as the failure. */
  label: string
  met: boolean
}

/**
 * The policy expressed as a checklist.
 *
 * Only rules the policy actually imposes are listed. Staff have a 6-character
 * minimum and no complexity requirement at all, so showing them an unticked
 * "one uppercase letter" would be inventing a rule the API does not enforce.
 */
export function requirementsFor(password: string, policy: PasswordPolicy): Requirement[] {
  const requirements: Requirement[] = [
    {
      label: `At least ${policy.minLength} characters`,
      met: password.length >= policy.minLength,
    },
  ]

  if (policy.requireUppercase) {
    requirements.push({ label: 'One uppercase letter', met: /[A-Z]/.test(password) })
  }
  if (policy.requireNumber) {
    requirements.push({ label: 'One number', met: /[0-9]/.test(password) })
  }

  return requirements
}

type Level = 0 | 1 | 2 | 3 | 4

const LEVELS: Record<Level, { label: string; bar: string; text: string }> = {
  0: { label: '', bar: 'bg-outline-variant', text: 'text-on-surface-variant' },
  1: { label: 'Weak', bar: 'bg-danger', text: 'text-danger' },
  2: { label: 'Fair', bar: 'bg-warning', text: 'text-warning' },
  3: { label: 'Good', bar: 'bg-info', text: 'text-info' },
  4: { label: 'Strong', bar: 'bg-success', text: 'text-success' },
}

/**
 * Scores a password from 0–4.
 *
 * Capped at "Weak" until every policy rule is satisfied, because the meter and
 * the checklist must never disagree: a password the API will reject cannot be
 * shown as "Good" no matter how long it is. Above that floor the score rewards
 * length and character variety, which is what actually resists guessing — a
 * short password meeting every rule is not a strong one.
 */
export function scorePassword(password: string, policy: PasswordPolicy): Level {
  if (password.length === 0) return 0
  if (requirementsFor(password, policy).some((r) => !r.met)) return 1

  let score = 2
  if (password.length >= policy.minLength + 4) score++

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password))
  if (classes.length >= 3 && password.length >= policy.minLength + 2) score++

  return Math.min(score, 4) as Level
}

export function PasswordStrength({
  password,
  policy,
  className,
}: {
  password: string
  policy: PasswordPolicy
  className?: string
}) {
  const requirements = requirementsFor(password, policy)
  const level = scorePassword(password, policy)
  const { label, bar, text } = LEVELS[level]

  return (
    <div className={cn('space-y-2.5', className)}>
      <div className="flex items-center gap-2">
        <div
          className="flex h-1 flex-1 gap-1"
          // The bar duplicates the label beside it, which is announced instead.
          aria-hidden="true"
        >
          {[1, 2, 3, 4].map((segment) => (
            <div
              key={segment}
              className={cn(
                'h-full flex-1 rounded-full transition-colors duration-300',
                segment <= level ? bar : 'bg-outline-variant/40'
              )}
            />
          ))}
        </div>
        {label && (
          <span className={cn('w-12 text-right text-caption font-medium', text)}>{label}</span>
        )}
      </div>

      {/*
        Announced politely rather than assertively: this updates on every
        keystroke, and an assertive region would interrupt the screen reader
        continuously while the user is still typing.
      */}
      <ul className="space-y-1" aria-live="polite">
        {requirements.map((requirement) => (
          <li
            key={requirement.label}
            className={cn(
              'flex items-center gap-1.5 text-caption transition-colors',
              requirement.met ? 'text-success' : 'text-on-surface-variant'
            )}
          >
            {requirement.met ? (
              <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <X aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-50" />
            )}
            <span>{requirement.label}</span>
            <span className="sr-only">{requirement.met ? ' — met' : ' — not yet met'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
