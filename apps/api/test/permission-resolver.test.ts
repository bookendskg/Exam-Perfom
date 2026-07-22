import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PERMISSIONS, ROLES, type Permission, type Role, type Scope } from '@bookends/core'
import { PermissionResolver } from '../src/rbac/permission-resolver.js'
import { testDb, truncateAll, disconnectDb } from './helpers/db.js'

/**
 * §3.2 grants now come from the database rather than a compiled constant.
 *
 * The constant remains the compile-time contract and the seed source; these
 * tables are the runtime authority. The first test is therefore the important
 * one: the two must agree exactly, or moving the matrix into the database has
 * silently changed who can do what.
 */
const prisma = testDb()

beforeEach(async () => {
  // Re-seeds reference data, which now includes the permission grants.
  await truncateAll()
})

afterAll(async () => {
  await disconnectDb()
})

describe('PermissionResolver', () => {
  it('resolves exactly the matrix compiled into @bookends/core', async () => {
    const resolver = new PermissionResolver(prisma)
    const mismatches: string[] = []

    for (const [permission, roleScopes] of Object.entries(PERMISSIONS)) {
      for (const role of ROLES) {
        const expected = (roleScopes as Record<Role, Scope>)[role]
        const actual = await resolver.scopeFor(role, permission as Permission)
        if (actual !== expected) {
          mismatches.push(`${role} × ${permission}: db=${actual} code=${expected}`)
        }
      }
    }

    expect(mismatches).toEqual([])
  })

  it('fails closed for a permission that has no row', async () => {
    const resolver = new PermissionResolver(prisma)

    // A missing grant must deny. If it defaulted to anything else, a failed or
    // partial seed would quietly open the API rather than close it.
    const scope = await resolver.scopeFor('staff', 'not:a:real:permission' as Permission)
    expect(scope).toBe('none')
  })

  it('reflects a grant changed in the database', async () => {
    const resolver = new PermissionResolver(prisma)
    expect(await resolver.scopeFor('staff', 'employee:read')).toBe('own_resource')

    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'employee:read' },
    })
    await prisma.rolePermission.update({
      where: { role_permissionId: { role: 'staff', permissionId: permission.id } },
      data: { scope: 'none' },
    })

    // The point of the whole change: a grant is data now, so this takes effect
    // without a release.
    resolver.invalidate()
    expect(await resolver.scopeFor('staff', 'employee:read')).toBe('none')
  })

  it('serves repeat lookups from cache rather than re-querying', async () => {
    let queries = 0
    const counting = new Proxy(prisma, {
      get(target, prop) {
        if (prop === 'rolePermission') {
          queries += 1
          return target.rolePermission
        }
        return Reflect.get(target, prop) as unknown
      },
    }) as typeof prisma

    const resolver = new PermissionResolver(counting)
    for (let i = 0; i < 25; i += 1) {
      await resolver.scopeFor('admin', 'employee:read')
    }

    // Authorisation runs on every request; a query per call would be an N+1
    // across the entire API.
    expect(queries).toBe(1)
  })

  it('issues one query for a burst of concurrent first-time lookups', async () => {
    let queries = 0
    const counting = new Proxy(prisma, {
      get(target, prop) {
        if (prop === 'rolePermission') {
          queries += 1
          return target.rolePermission
        }
        return Reflect.get(target, prop) as unknown
      },
    }) as typeof prisma

    const resolver = new PermissionResolver(counting)
    await Promise.all(Array.from({ length: 20 }, () => resolver.scopeFor('admin', 'employee:read')))

    // A cold cache under concurrent load must not stampede the database.
    expect(queries).toBe(1)
  })
})
