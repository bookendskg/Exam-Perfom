import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { hashPassword } from '@bookends/core'
import { MemorySessionStore } from '../src/infra/session-store/memory-store.js'
import { PostgresSessionStore } from '../src/infra/session-store/postgres-store.js'
import type { Principal, SessionStore } from '../src/infra/session-store/index.js'
import { resolveSessionPrincipal } from '../src/rbac/principal.js'
import { testDb, truncateAll, disconnectDb } from './helpers/db.js'

/**
 * One contract, both implementations. If Postgres and memory ever disagree,
 * tests that pass on the memory store would lie about production behaviour.
 */
const prisma = testDb()

async function makeUser(role: 'staff' | 'admin' = 'staff') {
  return prisma.user.create({
    data: {
      phone: `9${Math.floor(Math.random() * 1_000_000_000)}`.slice(0, 10),
      role,
      passwordHash: await hashPassword('Password1'),
    },
  })
}

async function makeSessionRow(userId: string) {
  return prisma.userSession.create({
    data: {
      userId,
      refreshTokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
  })
}

function principalFor(userId: string, sessionId: string): Principal {
  return {
    userId,
    role: 'staff',
    sessionId,
    employeeId: null,
    outletId: null,
    departmentId: null,
    scopedOutletIds: [],
    mustChangePassword: false,
  }
}

interface Fixture {
  store: SessionStore
  /** Creates a session and returns its id + principal. */
  create(userId: string): Promise<{ sessionId: string; principal: Principal }>
  advance(ms: number): Promise<void>
}

const IMPLEMENTATIONS: Array<{ name: string; make: () => Fixture }> = [
  {
    name: 'MemorySessionStore',
    make: () => {
      let offset = 0
      const store = new MemorySessionStore(async (sessionId) => {
        const resolved = await resolveSessionPrincipal(prisma, sessionId)
        return resolved?.principal ?? null
      }, () => Date.now() + offset)
      return {
        store,
        // A real session row, same as the Postgres fixture. The memory store
        // resolves role and scope from the database, so a bare random id would
        // no longer be a session — and a fixture that cannot represent a real
        // session cannot test the contract.
        async create(userId) {
          const row = await makeSessionRow(userId)
          const principal = principalFor(userId, row.id)
          await store.put(row.id, principal, 1800)
          return { sessionId: row.id, principal }
        },
        async advance(ms) {
          offset += ms
        },
      }
    },
  },
  {
    name: 'PostgresSessionStore',
    make: () => {
      const store = new PostgresSessionStore(prisma)
      return {
        store,
        async create(userId) {
          const row = await makeSessionRow(userId)
          const principal = principalFor(userId, row.id)
          await store.put(row.id, principal, 1800)
          return { sessionId: row.id, principal }
        },
        // No injectable clock against a real database — move the row's clock
        // backwards instead, which is equivalent for an idle check.
        async advance(ms) {
          await prisma.userSession.updateMany({
            data: { lastSeenAt: new Date(Date.now() - ms) },
          })
        },
      }
    },
  },
]

for (const impl of IMPLEMENTATIONS) {
  describe(`SessionStore contract — ${impl.name}`, () => {
    let fixture: Fixture

    beforeEach(async () => {
      await truncateAll()
      fixture = impl.make()
    })

    afterAll(async () => {
      await disconnectDb()
    })

    it('touch returns the principal for a live session', async () => {
      const user = await makeUser()
      const { sessionId } = await fixture.create(user.id)

      const principal = await fixture.store.touch(sessionId, 1800)
      expect(principal).not.toBeNull()
      expect(principal!.userId).toBe(user.id)
      expect(principal!.sessionId).toBe(sessionId)
    })

    it('touch returns null for an unknown session', async () => {
      expect(await fixture.store.touch(randomUUID(), 1800)).toBeNull()
    })

    it('touch returns null after delete', async () => {
      const user = await makeUser()
      const { sessionId } = await fixture.create(user.id)

      await fixture.store.delete(sessionId)
      expect(await fixture.store.touch(sessionId, 1800)).toBeNull()
    })

    it('touch returns null once the idle window has passed (§7.5)', async () => {
      const user = await makeUser()
      const { sessionId } = await fixture.create(user.id)

      // 30-minute staff idle window; go just past it.
      await fixture.advance(1800 * 1000 + 60_000)
      expect(await fixture.store.touch(sessionId, 1800)).toBeNull()
    })

    it('touch extends the idle window, so an active user is not logged out', async () => {
      const user = await makeUser()
      const { sessionId } = await fixture.create(user.id)

      // Idle 20 of 30 minutes, then act.
      await fixture.advance(20 * 60 * 1000)
      expect(await fixture.store.touch(sessionId, 1800)).not.toBeNull()

      // 20 more minutes: 40 total, but only 20 since last activity.
      await fixture.advance(20 * 60 * 1000)
      expect(await fixture.store.touch(sessionId, 1800)).not.toBeNull()
    })

    it('deleteAllForUser ends every session for that user only', async () => {
      const alice = await makeUser()
      const bob = await makeUser()
      const a1 = await fixture.create(alice.id)
      const a2 = await fixture.create(alice.id)
      const b1 = await fixture.create(bob.id)

      await fixture.store.deleteAllForUser(alice.id)

      expect(await fixture.store.touch(a1.sessionId, 1800)).toBeNull()
      expect(await fixture.store.touch(a2.sessionId, 1800)).toBeNull()
      expect(await fixture.store.touch(b1.sessionId, 1800)).not.toBeNull()
    })

    it('supports several concurrent sessions for one user (§7.5 admin)', async () => {
      const user = await makeUser('admin')
      const s1 = await fixture.create(user.id)
      const s2 = await fixture.create(user.id)

      expect(await fixture.store.touch(s1.sessionId, 7200)).not.toBeNull()
      expect(await fixture.store.touch(s2.sessionId, 7200)).not.toBeNull()
      expect(s1.sessionId).not.toBe(s2.sessionId)
    })

    it('delete is idempotent', async () => {
      const user = await makeUser()
      const { sessionId } = await fixture.create(user.id)

      await fixture.store.delete(sessionId)
      await expect(fixture.store.delete(sessionId)).resolves.not.toThrow()
    })

    it('invalidatePrincipal does not throw', async () => {
      const user = await makeUser()
      await fixture.create(user.id)
      await expect(fixture.store.invalidatePrincipal(user.id)).resolves.not.toThrow()
    })

    /**
     * The three below are the edge cases of §10, and they are the reason the
     * memory store no longer caches. Each mutates the database WITHOUT telling
     * the store — exactly what happens when an administrator deactivates
     * someone, or another process revokes a session. A store that trusted its
     * own cache would keep serving the principal and pass these vacuously.
     */
    it('touch returns null once the session row is revoked in the database', async () => {
      const user = await makeUser()
      const { sessionId } = await fixture.create(user.id)

      await prisma.userSession.update({
        where: { id: sessionId },
        data: { revokedAt: new Date(), revokedReason: 'admin_revoke' },
      })

      expect(await fixture.store.touch(sessionId, 1800)).toBeNull()
    })

    it('touch returns null once the user is deactivated', async () => {
      const user = await makeUser()
      const { sessionId } = await fixture.create(user.id)

      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } })

      expect(await fixture.store.touch(sessionId, 1800)).toBeNull()
    })

    it('touch reflects a role change made in the database', async () => {
      const user = await makeUser('admin')
      const { sessionId } = await fixture.create(user.id)

      expect((await fixture.store.touch(sessionId, 7200))?.role).toBe('admin')

      await prisma.user.update({ where: { id: user.id }, data: { role: 'staff' } })

      // Immediately, on the next request — not when a token happens to expire.
      expect((await fixture.store.touch(sessionId, 7200))?.role).toBe('staff')
    })
  })
}
