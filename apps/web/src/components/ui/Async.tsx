import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { Alert, EmptyState, Skeleton, TableSkeleton } from './Feedback'

/**
 * One component for the three states a fetched screen can be in.
 *
 * Every list goes through it, which is what stops a screen silently rendering
 * an empty table when the request actually failed — the mistake that makes an
 * API problem look like "there is no data".
 *
 * Unchanged in contract from the original so every caller keeps working; what
 * changed is what each state looks like. Loading was a centred "Loading…"
 * string that collapsed the layout and shifted the page when data arrived; it
 * is now a skeleton shaped like the content.
 */
export function Async<T>({
  state,
  empty,
  emptyDescription,
  skeleton,
  children,
}: {
  state: { loading: boolean; error: string | null; data: T | null }
  empty?: string
  emptyDescription?: string
  /** Shape of the loading placeholder. Defaults to generic stacked bars. */
  skeleton?: 'table' | 'cards' | ReactNode
  children: (data: T) => ReactNode
}) {
  if (state.loading) {
    if (skeleton === 'table') return <TableSkeleton columns={5} />
    if (skeleton === 'cards') {
      return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      )
    }
    if (skeleton) return <>{skeleton}</>
    return (
      <div className="space-y-3 py-2" role="status" aria-label="Loading">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }

  if (state.error) {
    return (
      <Alert tone="danger" title="Could not load this">
        {state.error}
      </Alert>
    )
  }

  if (!state.data || (Array.isArray(state.data) && state.data.length === 0)) {
    return (
      <EmptyState
        icon={<Inbox aria-hidden="true" className="h-6 w-6" />}
        title={empty ?? 'Nothing here yet'}
        {...(emptyDescription ? { description: emptyDescription } : {})}
      />
    )
  }

  return <>{children(state.data)}</>
}
