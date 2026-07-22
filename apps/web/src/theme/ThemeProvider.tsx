import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Theme preference. `system` follows the OS and keeps following it — it is not
 * resolved once at load, so a user who flips their OS to dark at dusk sees the
 * app follow without a reload.
 */
export type Theme = 'light' | 'dark' | 'system'

/** Shared with the inline boot script in index.html; must stay in step. */
const STORAGE_KEY = 'bookends.theme'

interface ThemeState {
  /** What the user chose. */
  theme: Theme
  /** What that currently resolves to — `system` collapsed to light or dark. */
  resolved: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeState | null>(null)

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function readStored(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    /* unreachable storage (private mode) — fall through */
  }
  return 'system'
}

/**
 * Applies the theme to <html>.
 *
 * `colorScheme` is set alongside the class so that browser-rendered UI —
 * scrollbars, form controls, the autofill overlay — matches. Without it a dark
 * page keeps light scrollbars, which is the usual giveaway of a bolted-on
 * dark mode.
 */
function apply(resolved: 'light' | 'dark'): void {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialised from storage rather than a constant, so the first React render
  // already agrees with what the inline boot script painted. Disagreeing here
  // would cause exactly the flash that script exists to prevent.
  const [theme, setThemeState] = useState<Theme>(readStored)
  const [systemDark, setSystemDark] = useState(prefersDark)

  // Track the OS setting continuously, not just at mount.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const resolved: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  useEffect(() => {
    apply(resolved)
  }, [resolved])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* preference simply will not persist; the session still honours it */
    }
  }, [])

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
