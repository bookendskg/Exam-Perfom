import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as ApiModule from '../src/lib/api'

/**
 * The session behaviour of the API client.
 *
 * This file exists because the two most dangerous pieces of auth logic in the
 * panel live here and neither is reachable from the API test suite: signing out
 * has to *reach* the server, and a burst of 401s has to collapse onto a single
 * token renewal. Both were wrong at some point, both are concurrency-shaped, and
 * both fail silently rather than loudly — the panel keeps working, it is just no
 * longer signed out.
 *
 * `apps/web` had no tests at all before this.
 */

type Handler = (path: string, init: RequestInit) => { status: number; body?: unknown }

let fetchMock: ReturnType<typeof vi.fn>
let store: Map<string, string>
let api: typeof ApiModule

/** Paths the stub was asked for, in order. */
let calls: string[]

function respondWith(handler: Handler) {
  fetchMock.mockImplementation((input: URL | string, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    const { status, body } = handler(path, init)
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body ?? {}),
    })
  })
}

beforeEach(async () => {
  calls = []
  store = new Map()
  fetchMock = vi.fn()

  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } })

  // Fresh module state per test: the refresh latch and the shared in-flight
  // promise are module-level, and leaking them between tests would let one test
  // pass because of another.
  vi.resetModules()
  api = await import('../src/lib/api')
})

const envelope = (data: unknown) => ({ success: true, data })
const failure = (code: string, message = code) => ({ success: false, error: { code, message } })

describe('signing out', () => {
  it('tells the server, not just localStorage', async () => {
    api.tokenStore.set('access-token')
    respondWith(() => ({ status: 200, body: envelope({ loggedOut: true }) }))

    await api.endSession()

    // The whole defect: the old implementation cleared the token and stopped,
    // leaving the session row and the refresh cookie live for seven days.
    expect(calls).toContain('/api/v1/auth/logout')
    expect(api.tokenStore.get()).toBeNull()
  })

  it('sends credentials, or the cookie the server must clear never arrives', async () => {
    api.tokenStore.set('access-token')
    respondWith(() => ({ status: 200, body: envelope({ loggedOut: true }) }))

    await api.endSession()

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
  })

  it('still signs the user out of this device when the request fails', async () => {
    api.tokenStore.set('access-token')
    respondWith(() => {
      throw new Error('offline')
    })

    // Must not reject: a user who cannot reach the network still pressed
    // "sign out" and still expects the panel to forget them.
    await expect(api.endSession()).resolves.toBeUndefined()
    expect(api.tokenStore.get()).toBeNull()
  })

  it('does not silently sign the user back in afterwards', async () => {
    api.tokenStore.set('access-token')
    respondWith((path) =>
      path === '/api/v1/auth/logout'
        ? { status: 200, body: envelope({ loggedOut: true }) }
        : { status: 401, body: failure('UNAUTHENTICATED') }
    )

    await api.endSession()
    calls.length = 0

    /**
     * The regression this guards is one automatic refresh created.
     *
     * A request already in flight can answer 401 *after* the logout lands, and
     * the interceptor's answer to a 401 is to renew. If the logout request had
     * not yet been processed, or failed because the device was offline, the
     * refresh cookie is still in the jar and that renewal succeeds — the panel
     * quietly re-authenticates the account the user just signed out of.
     */
    await expect(api.api.get('/employees')).rejects.toThrow()
    expect(calls, 'a signed-out panel must never attempt to renew').not.toContain(
      '/api/v1/auth/refresh'
    )
  })

  it('renews again after a genuine new sign-in', async () => {
    api.tokenStore.set('access-token')
    respondWith(() => ({ status: 200, body: envelope({ loggedOut: true }) }))
    await api.endSession()

    // The latch must not be permanent, or the next user of this tab gets logged
    // out every fifteen minutes for the rest of the page's life.
    api.resumeRefreshing()
    calls.length = 0

    let issued = false
    respondWith((path) => {
      if (path === '/api/v1/auth/refresh') {
        issued = true
        return { status: 200, body: envelope({ accessToken: 'fresh' }) }
      }
      return issued
        ? { status: 200, body: envelope({ ok: true }) }
        : { status: 401, body: failure('UNAUTHENTICATED') }
    })

    await api.api.get('/employees')
    expect(calls).toContain('/api/v1/auth/refresh')
    expect(api.tokenStore.get()).toBe('fresh')
  })
})

describe('automatic renewal', () => {
  it('replays the original request once the token is renewed', async () => {
    api.tokenStore.set('stale')
    let renewed = false
    respondWith((path) => {
      if (path === '/api/v1/auth/refresh') {
        renewed = true
        return { status: 200, body: envelope({ accessToken: 'fresh' }) }
      }
      return renewed
        ? { status: 200, body: envelope({ id: 'emp-1' }) }
        : { status: 401, body: failure('UNAUTHENTICATED') }
    })

    const { data } = await api.api.get<{ id: string }>('/employees')

    // The user should never see the 401 that happened underneath them.
    expect(data).toEqual({ id: 'emp-1' })
    expect(calls).toEqual(['/api/v1/employees', '/api/v1/auth/refresh', '/api/v1/employees'])
  })

  it('collapses a burst of 401s onto a single renewal', async () => {
    api.tokenStore.set('stale')
    let renewed = false
    respondWith((path) => {
      if (path === '/api/v1/auth/refresh') {
        renewed = true
        return { status: 200, body: envelope({ accessToken: 'fresh' }) }
      }
      return renewed
        ? { status: 200, body: envelope({ ok: true }) }
        : { status: 401, body: failure('UNAUTHENTICATED') }
    })

    // A dashboard fires several requests at once, so one expired token produces
    // a burst of simultaneous 401s. The API rotates the refresh token on every
    // use and treats a replay as theft — parallel renewals would race and could
    // revoke the very session they were trying to save.
    await Promise.all([api.api.get('/employees'), api.api.get('/exams'), api.api.get('/questions')])

    const refreshes = calls.filter((p) => p === '/api/v1/auth/refresh')
    expect(refreshes, 'three concurrent 401s must produce exactly one renewal').toHaveLength(1)
  })

  it('gives up rather than looping when the renewal itself fails', async () => {
    api.tokenStore.set('stale')
    respondWith(() => ({ status: 401, body: failure('UNAUTHENTICATED') }))

    await expect(api.api.get('/employees')).rejects.toThrow()

    // One attempt, one renewal, one replay at most — never a loop.
    expect(calls.filter((p) => p === '/api/v1/auth/refresh')).toHaveLength(1)
    expect(api.tokenStore.get(), 'a dead session must not leave a token behind').toBeNull()
  })

  it('never tries to renew a failed login', async () => {
    respondWith(() => ({ status: 401, body: failure('INVALID_CREDENTIALS') }))

    await expect(api.api.post('/auth/login', { phone: '1', password: 'x' })).rejects.toThrow()

    // Refreshing here is meaningless — there is no session to renew — and it
    // would turn one wrong password into two requests.
    expect(calls).not.toContain('/api/v1/auth/refresh')
  })
})
