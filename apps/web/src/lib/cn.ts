import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Joins class names, with later Tailwind utilities beating earlier ones.
 *
 * Plain string concatenation is not enough for a component library: every
 * component here accepts a `className` so callers can adjust it, and
 * `"px-4" + " " + "px-8"` leaves both in the class list, where the winner is
 * decided by stylesheet order rather than by the caller. `twMerge` resolves the
 * conflict properly, so an override reliably overrides.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
