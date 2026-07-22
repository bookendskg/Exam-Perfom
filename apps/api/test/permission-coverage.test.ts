import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Router } from 'express'
import { pino } from 'pino'
import { loadConfig } from '../src/config/env.js'
import { MemorySessionStore } from '../src/infra/session-store/memory-store.js'
import type { Deps } from '../src/app.js'
import { buildEmployeeRouter } from '../src/employees/employee.routes.js'
import { buildStaffRouter } from '../src/staff/staff.routes.js'
import { buildAttemptRouter } from '../src/attempts/attempt.routes.js'
import { buildOrganisationRouters } from '../src/organisation/organisation.routes.js'
import { buildQuestionRouters } from '../src/questions/question.routes.js'
import { buildExamRouters } from '../src/exams/exam.routes.js'
import { buildSchedulingRouter } from '../src/scheduling/scheduling.routes.js'
import { buildGradingRouter } from '../src/grading/grading.routes.js'
import { testDb, disconnectDb } from './helpers/db.js'

/**
 * Every feature route must carry a permission guard.
 *
 * `requirePermission` has always tagged its handler with the permission it
 * enforces, and `markPublic` tags deliberately-open routes — the comments say
 * this exists "so the router coverage guard can see it". No such guard was ever
 * written. router-coverage.test.ts checks only that anonymous callers are
 * rejected, which the blanket `app.use('/api/v1', requireAuth)` guarantees on
 * its own; it cannot distinguish "authenticated AND authorised" from merely
 * "authenticated".
 *
 * That gap is the realistic RBAC failure across ~20 modules: not a wrong cell in
 * the matrix, but a route nobody gated, reachable by any signed-in staff member.
 *
 * Express 5 did remove `layer.regexp`, so a router's MOUNT path is opaque — but
 * route layers still expose `.path`, `.methods` and their handler stack, which
 * is all this needs.
 */

interface RouteLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: { permission?: string; isPublicMarker?: boolean } }>
  }
}

interface DiscoveredRoute {
  router: string
  method: string
  path: string
  permission: string | undefined
  isPublic: boolean
}

function routesOf(name: string, router: Router): DiscoveredRoute[] {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack
  const found: DiscoveredRoute[] = []

  for (const layer of stack) {
    if (!layer.route) continue
    const handlers = layer.route.stack.map((s) => s.handle)
    const method = Object.keys(layer.route.methods)[0] ?? 'all'

    found.push({
      router: name,
      method: method.toUpperCase(),
      path: layer.route.path,
      permission: handlers.find((h) => h.permission)?.permission,
      isPublic: handlers.some((h) => h.isPublicMarker),
    })
  }

  return found
}

let routes: DiscoveredRoute[] = []

beforeAll(() => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? 'postgresql://localhost:5432/x',
    SESSION_STORE: 'memory',
  })

  const deps: Deps = {
    config,
    logger: pino({ level: 'silent' }),
    prisma: testDb(),
    sessionStore: new MemorySessionStore(async () => null),
  }

  const org = buildOrganisationRouters(deps)
  const questions = buildQuestionRouters(deps)
  const exams = buildExamRouters(deps)

  routes = [
    ...routesOf('employees', buildEmployeeRouter(deps)),
    ...routesOf('staff', buildStaffRouter(deps)),
    ...routesOf('attempts', buildAttemptRouter(deps)),
    ...routesOf('outlets', org.outletRouter),
    ...routesOf('departments', org.departmentRouter),
    ...routesOf('designations', org.designationRouter),
    ...routesOf('questions', questions.questionRouter),
    ...routesOf('topics', questions.topicRouter),
    ...routesOf('source-documents', questions.documentRouter),
    ...routesOf('exams', exams.examRouter),
    ...routesOf('exam-templates', exams.templateRouter),
    ...routesOf('scheduling', buildSchedulingRouter(deps)),
    ...routesOf('grading', buildGradingRouter(deps)),
  ]
})

afterAll(async () => {
  await disconnectDb()
})

describe('permission coverage', () => {
  it('discovers routes at all — the guard is not passing vacuously', () => {
    // Without this, a change to Express internals would silently reduce the
    // assertion below to "for (const route of []) {}" and the suite would stay
    // green while checking nothing.
    expect(routes.length).toBeGreaterThan(30)
  })

  it('gates every feature route with requirePermission', () => {
    const ungated = routes
      .filter((r) => !r.permission && !r.isPublic)
      .map((r) => `${r.method} ${r.router}${r.path}`)

    expect(ungated, 'these routes are authenticated but not permission-checked').toEqual([])
  })

  it('names a permission that exists in the matrix', async () => {
    const { PERMISSIONS } = await import('@bookends/core')
    const known = new Set(Object.keys(PERMISSIONS))

    const unknown = routes
      .filter((r) => r.permission && !known.has(r.permission))
      .map((r) => `${r.method} ${r.router}${r.path} → ${r.permission}`)

    expect(unknown, 'these routes reference a permission the matrix does not define').toEqual([])
  })
})
