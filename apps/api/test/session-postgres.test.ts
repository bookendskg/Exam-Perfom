import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Application } from 'express'
import { buildTestApp } from './helpers/app.js'
import { truncateAll, disconnectDb, testDb } from './helpers/db.js'
import { makeUser, resetOutletManagers } from './helpers/factories.js'

/**
 * Session lifecycle against the REAL store.
 *
 * The rest of the suite runs on MemorySessionStore for its controllable clock,
 * but that store is a Map keyed by session id and is therefore blind to an
 * entire class of defect: anything where the store entry and the database row
 * are the same object. Production is Postgres — config/env.ts refuses to boot
 * with anything else — so these assertions run there.
 *
 * This file exists because of a real, shipped bug. `SessionService.issue`
 * called `store.deleteAllForUser(userId)` after creating the new session, to
 * drop the superseded staff session's store entry. Under Postgres that call is
 * `UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at
 * IS NULL` — which matched the row created moments earlier. Every staff login
 * succeeded, returned a token, and then 401'd on the first request made with it.
 * The memory store made the same call a no-op, so 541 tests stayed green.
 */
let app: Application

beforeEach(async () => {
  await truncateAll()
  await resetOutletManagers()
  app = buildTestApp({ SESSION_STORE: 'postgres' }).app
})

afterAll(async () => {
  await disconnectDb()
})

const login = (phone: string, password: string) =>
  request(app).post('/api/v1/auth/login').set('User-Agent', 'Mozilla/5.0').send({ phone, password })

describe('session lifecycle under the Postgres store', () => {
  it('leaves a staff session usable immediately after login (§7.5 single-session)', async () => {
    const { phone, password } = await makeUser({ role: 'staff' })

    const res = await login(phone, password)
    expect(res.status).toBe(200)
    const token = res.body.data.accessToken as string

    // The regression: this returned 401 SESSION_EXPIRED because login revoked
    // the session it had just issued.
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)

    expect(me.status).toBe(200)
    expect(me.body.data.role).toBe('staff')
  })

  it('does not leave the freshly issued staff session revoked in the database', async () => {
    const { phone, password, user } = await makeUser({ role: 'staff' })
    await login(phone, password)

    const live = await testDb().userSession.findMany({
      where: { userId: user.id, revokedAt: null },
    })

    // Exactly one, and it is not revoked. Asserting on the row rather than only
    // on the HTTP status pins the actual invariant.
    expect(live).toHaveLength(1)
  })

  it('still supersedes the previous staff session on a second login (§7.5)', async () => {
    const { phone, password, user } = await makeUser({ role: 'staff' })

    const first = await login(phone, password)
    const firstToken = first.body.data.accessToken as string

    const second = await login(phone, password)
    const secondToken = second.body.data.accessToken as string

    // The fix must not weaken single-session: the old one dies, the new lives.
    const oldSession = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${firstToken}`)
    expect(oldSession.status).toBe(401)

    const newSession = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${secondToken}`)
    expect(newSession.status).toBe(200)

    const live = await testDb().userSession.findMany({
      where: { userId: user.id, revokedAt: null },
    })
    expect(live).toHaveLength(1)
  })

  it('logout-all evicts every device the user holds', async () => {
    const { phone, password, user } = await makeUser({ role: 'admin' })

    const first = await login(phone, password)
    const second = await login(phone, password)

    await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${first.body.data.accessToken}`)
      .expect(200)

    // Including the one that asked — "everywhere" means everywhere.
    for (const res of [first, second]) {
      const me = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      expect(me.status).toBe(401)
    }

    const live = await testDb().userSession.findMany({
      where: { userId: user.id, revokedAt: null },
    })
    expect(live).toHaveLength(0)
  })

  it('refuses to refresh a session that has idled out (§7.5)', async () => {
    const { phone, password, user } = await makeUser({ role: 'staff' })
    const res = await login(phone, password)
    const refreshToken = res.body.data.refreshToken as string | undefined
    const cookie = res.headers['set-cookie']

    // Push last activity well past the 30-minute staff idle window. Refresh
    // used to ignore the idle clock entirely, so a session dormant for days
    // could be resurrected — which made the policy decorative for anyone
    // holding a refresh token, a thief included.
    await testDb().userSession.updateMany({
      where: { userId: user.id },
      data: { lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    })

    const req = request(app).post('/api/v1/auth/refresh')
    if (cookie) req.set('Cookie', cookie)
    const refreshed = await req.send(refreshToken ? { refreshToken } : {})

    expect(refreshed.status).toBe(401)
  })

  it('lets an admin role hold several concurrent sessions (§7.5)', async () => {
    const { phone, password, user } = await makeUser({ role: 'admin' })

    const first = await login(phone, password)
    const second = await login(phone, password)

    // Admins are exempt from superseding, so both tokens keep working.
    for (const res of [first, second]) {
      const me = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      expect(me.status).toBe(200)
    }

    const live = await testDb().userSession.findMany({
      where: { userId: user.id, revokedAt: null },
    })
    expect(live).toHaveLength(2)
  })
})
