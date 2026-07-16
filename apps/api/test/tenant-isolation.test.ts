import { describe, it, expect, beforeAll } from 'vitest'
import {
  createPrismaClient,
  withTenantScope,
  runInTenant,
  runAsPlatform,
  tenantScopedModels,
  seedPlans,
  seedTenant,
  TenantContextError,
  withHandWrittenTenantFilter,
  type PrismaClient,
} from '@bookends/db'

/**
 * Cross-tenant isolation (SaaS §2.4).
 *
 * The point of the whole conversion. Everything else — the tenantId columns,
 * the composite constraints, the extension — exists so that these assertions
 * hold, so they are written against the real database rather than a mock of it.
 */

let raw: PrismaClient
let scoped: ReturnType<typeof withTenantScope>
let alpha: string
let beta: string

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL']
  if (!url) throw new Error('TEST_DATABASE_URL is unset — globalSetup did not run')
  raw = createPrismaClient(url)
  scoped = withTenantScope(raw)

  await runAsPlatform('test setup: creating tenants', async () => {
    await seedPlans(raw)
    alpha = await seedTenant(raw, {
      slug: 'iso-alpha',
      name: 'Alpha Hospitality',
      ownerEmail: 'owner@alpha.example',
      employeeCodePrefix: 'AL',
      planCode: 'professional',
    })
    beta = await seedTenant(raw, {
      slug: 'iso-beta',
      name: 'Beta Hospitality',
      ownerEmail: 'owner@beta.example',
      employeeCodePrefix: 'BE',
      planCode: 'starter',
    })
  })

  // One department per tenant, with the SAME code on purpose: proving that is
  // now legal is half the point.
  //
  // Rebuilt from scratch each run rather than created once. The suite's
  // truncateAll() spares these rows, and a later test here renames one — so
  // without the delete, a second run would both trip the (tenantId, code)
  // constraint and inherit the previous run's mutations.
  await runAsPlatform('test setup: fixtures', async () => {
    await raw.department.deleteMany({ where: { code: { in: ['ISOK', 'ISOS', 'ISOX'] } } })
    await raw.department.createMany({
      data: [
        { tenantId: alpha, name: 'Kitchen', code: 'ISOK' },
        { tenantId: beta, name: 'Kitchen', code: 'ISOK' },
      ],
    })
  })
})

describe('which models are guarded', () => {
  it('derives the scoped set from the schema, not a hand-written list', () => {
    const models = tenantScopedModels()

    // Tenant data.
    for (const model of ['User', 'Employee', 'Outlet', 'Question', 'Exam', 'Setting', 'AuditLog']) {
      expect(models.has(model), `${model} must be tenant-scoped`).toBe(true)
    }

    // Platform data: deliberately NOT scoped, or the platform could never read
    // its own plan catalogue.
    for (const model of ['Plan', 'Tenant']) {
      expect(models.has(model), `${model} must NOT be tenant-scoped`).toBe(false)
    }
  })
})

describe('raw SQL fails closed', () => {
  /**
   * The extension cannot read a raw statement, so it cannot know whether it
   * filters. It used to let raw through silently, and question-selection.ts
   * shipped with no tenant predicate — an exam could be built from another
   * customer's question bank. These tests hold the door shut.
   */
  it('refuses a raw query inside a tenant scope unless the author signs for it', async () => {
    await expect(
      runInTenant(alpha, () => scoped.$queryRaw`SELECT id FROM departments`)
    ).rejects.toThrow(TenantContextError)
  })

  it('names the three ways out, so the error is a fix and not a puzzle', async () => {
    await expect(
      runInTenant(alpha, () => scoped.$queryRaw`SELECT id FROM departments`)
    ).rejects.toThrow(/withHandWrittenTenantFilter[\s\S]*runAsPlatform[\s\S]*query builder/)
  })

  it('allows a raw query whose author states it carries its own tenant_id', async () => {
    const rows = await runInTenant(alpha, () =>
      withHandWrittenTenantFilter(
        'test: the predicate is right there in the statement',
        () => scoped.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM departments WHERE tenant_id = ${alpha}::uuid AND code = 'ISOK'
        `
      )
    )
    expect(rows).toHaveLength(1)
  })

  it('allows raw under runAsPlatform, which is unscoped by definition', async () => {
    const rows = await runAsPlatform('test: platform-wide raw read', () =>
      scoped.$queryRaw<Array<{ id: string }>>`SELECT id FROM departments WHERE code = 'ISOK'`
    )
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('does NOT verify the SQL — the signature is a claim a reviewer must check', async () => {
    // Deliberate: this query is a lie. It says it filters and it does not, and
    // the guard cannot tell. Asserted so nobody mistakes the wrapper for a
    // parser and starts trusting it to catch what only review can.
    const rows = await runInTenant(alpha, () =>
      withHandWrittenTenantFilter(
        'test: this reason is false, on purpose',
        () => scoped.$queryRaw<Array<{ id: string }>>`SELECT id FROM departments WHERE code = 'ISOK'`
      )
    )
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })
})

describe('fail-closed: no tenant context', () => {
  it('refuses to read a tenant table with no context at all', async () => {
    await expect(scoped.department.findMany()).rejects.toThrow(TenantContextError)
  })

  it('refuses to write a tenant table with no context at all', async () => {
    await expect(
      scoped.department.create({ data: { tenantId: alpha, name: 'X', code: 'ISOX' } })
    ).rejects.toThrow(TenantContextError)
  })

  it('still allows platform tables with no context — they are not tenant data', async () => {
    await expect(scoped.plan.findMany()).resolves.toBeInstanceOf(Array)
  })
})

describe('reads are confined to the current tenant', () => {
  it('findMany returns only this tenant, though both tenants have the row', async () => {
    const asAlpha = await runInTenant(alpha, () =>
      scoped.department.findMany({ where: { code: 'ISOK' } })
    )
    const asBeta = await runInTenant(beta, () =>
      scoped.department.findMany({ where: { code: 'ISOK' } })
    )

    expect(asAlpha).toHaveLength(1)
    expect(asBeta).toHaveLength(1)
    expect(asAlpha[0]!.tenantId).toBe(alpha)
    expect(asBeta[0]!.tenantId).toBe(beta)
    // Same natural key, different rows: this is what per-tenant uniqueness buys.
    expect(asAlpha[0]!.id).not.toBe(asBeta[0]!.id)
  })

  it('count does not see the other tenant', async () => {
    const seen = await runInTenant(alpha, () =>
      scoped.department.count({ where: { code: 'ISOK' } })
    )
    expect(seen).toBe(1)
  })

  it('findUnique by primary key cannot reach across tenants', async () => {
    const betaRow = await runInTenant(beta, () =>
      scoped.department.findFirstOrThrow({ where: { code: 'ISOK' } })
    )

    // Alpha knows beta's UUID and asks for it directly — the id is a valid,
    // existing primary key. It must still come back empty.
    const stolen = await runInTenant(alpha, () =>
      scoped.department.findUnique({ where: { id: betaRow.id } })
    )
    expect(stolen).toBeNull()
  })
})

describe('writes cannot cross tenants', () => {
  it('rejects a create that names a different tenant than the context', async () => {
    await expect(
      runInTenant(alpha, () =>
        scoped.department.create({ data: { tenantId: beta, name: 'Smuggled', code: 'ISOS' } })
      )
    ).rejects.toThrow(/tried to write to tenant/)
  })

  it('does not write the row it rejected', async () => {
    const smuggled = await runAsPlatform('verifying nothing was written', () =>
      raw.department.findMany({ where: { code: 'ISOS' } })
    )
    expect(smuggled).toHaveLength(0)
  })

  it('updateMany cannot touch another tenant even when told to', async () => {
    await runInTenant(alpha, () =>
      scoped.department.updateMany({ where: { code: 'ISOK' }, data: { name: 'Renamed by Alpha' } })
    )

    const betaRow = await runInTenant(beta, () =>
      scoped.department.findFirstOrThrow({ where: { code: 'ISOK' } })
    )
    expect(betaRow.name).toBe('Kitchen')
  })

  it('delete cannot reach across tenants', async () => {
    const betaRow = await runInTenant(beta, () =>
      scoped.department.findFirstOrThrow({ where: { code: 'ISOK' } })
    )

    // Alpha tries to delete beta's row by its real id.
    await expect(
      runInTenant(alpha, () => scoped.department.delete({ where: { id: betaRow.id } }))
    ).rejects.toThrow()

    const survivor = await runAsPlatform('verifying beta survived', () =>
      raw.department.findUnique({ where: { id: betaRow.id } })
    )
    expect(survivor).not.toBeNull()
  })
})

describe('runAsPlatform is an explicit, narrow escape hatch', () => {
  it('sees across tenants when asked to', async () => {
    const all = await runAsPlatform('login lookup by phone', () =>
      scoped.department.findMany({ where: { code: 'ISOK' } })
    )
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  it('does not leak out of its callback', async () => {
    await runAsPlatform('brief platform work', async () => {
      await scoped.department.findMany({ where: { code: 'ISOK' } })
    })
    // Back outside, the default is still deny.
    await expect(scoped.department.findMany()).rejects.toThrow(TenantContextError)
  })
})
