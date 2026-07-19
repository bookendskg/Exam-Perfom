import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type PageMeta } from './api'

/**
 * A GET with its loading, error and data states in one place.
 *
 * No data-fetching library: the panel makes simple reads, and the states worth
 * modelling are exactly these three. Pairs with <Async> so a failed request can
 * never be rendered as an empty list.
 */
export interface AsyncState<T> {
  loading: boolean
  error: string | null
  data: T | null
  meta?: PageMeta
  reload: () => void
}

export function useApi<T>(
  path: string | null,
  query?: Record<string, string | number | undefined>
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [meta, setMeta] = useState<PageMeta | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(path !== null)
  const [nonce, setNonce] = useState(0)

  // Serialised so the effect re-runs when a filter changes, without callers
  // having to memoise the object they pass.
  const queryKey = JSON.stringify(query ?? {})

  useEffect(() => {
    if (path === null) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    api
      .get<T>(path, JSON.parse(queryKey) as Record<string, string | number | undefined>)
      .then((res) => {
        if (cancelled) return
        setData(res.data)
        setMeta(res.meta)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // A 401 or a pending password change is already being handled globally;
        // showing a red box on top of the redirect would just be noise.
        if (err instanceof ApiError && (err.status === 401 || err.code === 'PASSWORD_CHANGE_REQUIRED')) {
          return
        }
        setError(err instanceof Error ? err.message : 'Something went wrong')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [path, queryKey, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  return { loading, error, data, meta, reload }
}
