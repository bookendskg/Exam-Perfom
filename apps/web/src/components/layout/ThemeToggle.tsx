import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type Theme } from '../../theme/ThemeProvider'
import { cn } from '../../lib/cn'

const OPTIONS: Array<{ value: Theme; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
]

/**
 * Three-way theme control.
 *
 * A segmented group rather than a toggle button, because "system" is a real
 * third choice and a two-state toggle cannot express it — a user on a
 * dark-at-dusk schedule needs to say "follow the OS", not pick a side.
 *
 * Built as a radiogroup so arrow keys move between options, which is what
 * screen-reader users expect from a segmented control.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex rounded-lg border border-outline-variant bg-surface-container p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = theme === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'inline-flex h-7 w-8 items-center justify-center rounded-md transition-colors',
              selected
                ? 'bg-surface-lowest text-on-surface shadow-xs'
                : 'text-on-surface-variant hover:text-on-surface'
            )}
          >
            <Icon aria-hidden="true" className="h-4 w-4" />
          </button>
        )
      })}
    </div>
  )
}
