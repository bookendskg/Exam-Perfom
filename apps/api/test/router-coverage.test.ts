import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb } from './helpers/db.js'

/**
 * Router coverage guard.
 *
 * Across ~20 spec modules, the realistic RBAC failure is not a wrong cell in the
 * §3.2 matrix — it is a route someone forgot to gate. A matrix test cannot catch
 * that, because an ungated route never consults the matrix.
 *
 * This tests the invariant behaviourally rather than by walking Express
 * internals. Express 5 removed `layer.regexp` in favour of opaque `matchers`
 * closures that expose no mount path, so introspection would silently return
 * the wrong paths — and a guard that passes vacuously is worse than none.
 *
 * The invariant: app.ts mounts `app.use('/api/v1', requireAuth, …)` as a
 * blanket guard AFTER the auth router. So every /api/v1 path is authenticated
 * unless it was registered above that line. The test below asserts exactly that,
 * by asking the running app rather than reading its internals.
 */

let app: Application

/** Reachable without a token, by definition — you have none yet. */
const PUBLIC_ROUTES = [
  { method: 'post' as const, path: '/api/v1/auth/login' },
  { method: 'post' as const, path: '/api/v1/auth/refresh' },
  { method: 'post' as const, path: '/api/v1/auth/forgot-password' },
  { method: 'post' as const, path: '/api/v1/auth/reset-password' },
  { method: 'get' as const, path: '/api/v1/health' },
]

/** Must reject an anonymous caller. */
const GUARDED_ROUTES = [
  { method: 'get' as const, path: '/api/v1/auth/me' },
  { method: 'post' as const, path: '/api/v1/auth/logout' },
  { method: 'post' as const, path: '/api/v1/auth/change-password' },
]

beforeEach(async () => {
  await truncateAll()
  app = buildTestApp().app
})

afterAll(async () => {
  await disconnectDb()
})

describe('router coverage guard', () => {
  it('rejects every guarded auth route without a token', async () => {
    for (const route of GUARDED_ROUTES) {
      const res = await request(app)[route.method](route.path).send({})
      expect(res.status, `${route.method.toUpperCase()} ${route.path} must require auth`).toBe(401)
    }
  })

  it('reaches every public route without a token', async () => {
    for (const route of PUBLIC_ROUTES) {
      const res = await request(app)[route.method](route.path).send({})

      // Status alone cannot decide this: POST /auth/refresh legitimately answers
      // 401 ("Refresh token is required") from inside its own handler, which
      // means it DID reach it. The blanket guard has a distinct message, so
      // match on that instead.
      expect(
        res.body?.error?.message,
        `${route.method.toUpperCase()} ${route.path} was blocked by the auth guard`
      ).not.toBe('Missing bearer token')
    }
  })

  it('guards ANY unlisted path under /api/v1 — the blanket guard is real', async () => {
    // This is the actual protection: a future module that forgets
    // requirePermission still cannot be reached anonymously, because the
    // blanket guard sits above it. If someone mounts a router ABOVE that line,
    // one of these probes starts returning something other than 401.
    const probes = [
      '/api/v1/employees',
      '/api/v1/questions',
      '/api/v1/exams',
      '/api/v1/reports/anything',
      '/api/v1/settings',
      '/api/v1/audit-logs',
      '/api/v1/some-module-nobody-has-written-yet',
    ]

    for (const path of probes) {
      const res = await request(app).get(path)
      expect(res.status, `${path} leaked to an anonymous caller`).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHENTICATED')
    }
  })

  it('does not let a public auth route bypass the guard for other paths', async () => {
    // The auth router is mounted at /api/v1/auth. Assert it did not accidentally
    // shadow the blanket guard for siblings.
    const res = await request(app).get('/api/v1/authx/pretend')
    expect(res.status).toBe(401)
  })

  it('mounts every §5.3 auth endpoint', async () => {
    // A missing route 404s; a present one returns 400/401/200. This catches a
    // route being dropped in a refactor.
    for (const route of [...PUBLIC_ROUTES, ...GUARDED_ROUTES]) {
      const res = await request(app)[route.method](route.path).send({})
      expect(res.status, `${route.method.toUpperCase()} ${route.path} is not mounted`).not.toBe(404)
    }
  })
})
