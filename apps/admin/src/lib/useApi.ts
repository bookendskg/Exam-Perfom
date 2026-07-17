import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'

/**
 * Fetch-on-mount, with the three states §19.1 requires every list to have.
 *
 * Deliberately not react-query: this app reads, it does not cache-invalidate a
 * graph, and the ~60 lines below are the whole of what it needs. A dependency
 * would be more code to reason about, not less.
 *
 * `refetch` is what a screen calls after a mutation — there is no cache to
 * invalidate, so re-asking the server IS the update, and the server is the only
 * thing that knows whether the write actually happened.
 */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(path !== null)

  const load = useCallback(async () => {
    if (path === null) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      setData(await api.get<T>(path))
    } catch (err) {
      setError(err)
      // The old data is deliberately kept: a filter change that 500s should
      // show the error over the last good list, not blank the screen.
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      if (path === null) {
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const result = await api.get<T>(path)
        // A fast filter change can land its response after a slower earlier
        // one. Without this the screen shows the stale result and the user sees
        // their own typing undone.
        if (!cancelled) setData(result)
      } catch (err) {
        if (!cancelled) setError(err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
    // The spread is deliberate: this is a generic hook, so the caller decides
    // what its fetch depends on. React's exhaustive-deps lint would want a
    // static array here and cannot be satisfied without making every caller
    // pass a memoised function instead — more ceremony at ten call sites to
    // silence one rule that is not even installed in this repo.
  }, [path, ...deps])

  return { data, error, loading, refetch: load }
}

/** Builds a query string, dropping empty values so the URL stays readable. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}
