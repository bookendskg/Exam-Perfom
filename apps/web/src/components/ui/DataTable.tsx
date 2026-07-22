import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './Button'

/* -------------------------------------------------------------------------- */
/* Table                                                                       */
/* -------------------------------------------------------------------------- */

export interface Column {
  key: string
  label: string
  /** Right-align. Use for numeric columns so digits line up. */
  numeric?: boolean
  /**
   * Hide below the given breakpoint. The exam table carries nine columns, which
   * cannot fit a phone; rather than force a horizontal scrollbar for everyone,
   * secondary columns drop out and the important ones stay readable.
   */
  hideBelow?: 'sm' | 'md' | 'lg'
}

const HIDE_BELOW: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
}

export function Table({
  columns,
  head,
  children,
  caption,
}: {
  columns?: Column[]
  /**
   * MIGRATION SHIM — remove once every table passes `columns`.
   * The original Table took a plain string[] of header labels.
   */
  head?: string[]
  children: ReactNode
  /** Announced to screen readers to say what the table lists. */
  caption?: string
}) {
  const resolved: Column[] = columns ?? (head ?? []).map((label) => ({ key: label, label }))

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-outline-variant bg-surface-container/60">
            {resolved.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'whitespace-nowrap px-4 py-3 text-label-caps uppercase text-on-surface-variant',
                  column.numeric && 'text-right',
                  column.hideBelow && HIDE_BELOW[column.hideBelow]
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-outline-variant">{children}</tbody>
      </table>
    </div>
  )
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr className={cn('transition-colors hover:bg-surface-container/50', className)}>{children}</tr>
  )
}

export function Cell({
  children,
  numeric,
  hideBelow,
  className,
}: {
  children: ReactNode
  numeric?: boolean
  hideBelow?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  return (
    <td
      className={cn(
        'px-4 py-3.5 text-body-sm text-on-surface',
        numeric && 'text-right tabular-nums',
        hideBelow && HIDE_BELOW[hideBelow],
        className
      )}
    >
      {children}
    </td>
  )
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Page controls for a server-paginated list.
 *
 * This markup was copy-pasted verbatim across three pages. Beyond the
 * duplication, each copy announced nothing: the page counter was a plain <div>,
 * so a screen-reader user pressing Next heard silence. `aria-live` fixes that.
 */
export function Pagination({
  page,
  pageCount,
  total,
  onPageChange,
  className,
}: {
  page: number
  pageCount: number
  /** Total row count, when the API reports it. */
  total?: number
  onPageChange: (page: number) => void
  className?: string
}) {
  // A single page needs no controls, and rendering them implies there is more.
  if (pageCount <= 1) return null

  return (
    <div
      className={cn(
        'flex flex-col-reverse items-center justify-between gap-3 border-t border-outline-variant px-4 py-3 sm:flex-row',
        className
      )}
    >
      <p aria-live="polite" className="text-caption text-on-surface-variant">
        Page <span className="font-semibold text-on-surface">{page}</span> of {pageCount}
        {total !== undefined && ` · ${total} total`}
      </p>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          icon={<ChevronLeft aria-hidden="true" className="h-4 w-4" />}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
        >
          Next
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
