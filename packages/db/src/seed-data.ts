import type { PrismaClient } from '@prisma/client'

/**
 * §9 organisational reference data.
 *
 * Lives here rather than in prisma/seed.ts because two callers need it: the
 * seed CLI, and the test harness, which restores this exact state between
 * tests. Duplicating the lists would let them drift, and a test suite seeded
 * differently from production is a test suite that lies.
 *
 * All of it is now tenant-scoped. Aiko, Capiche and Prep are Bookends' outlets,
 * not the platform's — a second customer gets its own, and the seed says which
 * tenant it is writing for rather than assuming there is only one.
 */

/** SaaS Appendix A — the platform's subscription tiers. */
export const SEED_PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    priceMonthlyInr: 2999,
    priceMonthlyUsd: 39,
    maxEmployees: 50,
    maxOutlets: 1,
    maxExamsPerMonth: 2,
    maxQuestions: 500,
    questionTypes: ['mcq'],
    autoScheduling: false,
    maxLanguages: 1,
    whatsappNotifications: false,
    aiInsights: false,
    customBranding: false,
    dataRetentionMonths: 6,
    sortOrder: 1,
  },
  {
    code: 'professional',
    name: 'Professional',
    priceMonthlyInr: 7999,
    priceMonthlyUsd: 99,
    maxEmployees: 300,
    maxOutlets: 5,
    // NULL, not 0: unlimited. planGuard reads absence as "no ceiling".
    maxExamsPerMonth: null,
    maxQuestions: 5000,
    questionTypes: ['mcq', 'theory'],
    autoScheduling: true,
    maxLanguages: 3,
    whatsappNotifications: true,
    aiInsights: false,
    customBranding: true,
    dataRetentionMonths: 24,
    sortOrder: 2,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    priceMonthlyInr: null,
    priceMonthlyUsd: null,
    maxEmployees: null,
    maxOutlets: null,
    maxExamsPerMonth: null,
    maxQuestions: null,
    questionTypes: ['mcq', 'theory', 'video_image'],
    autoScheduling: true,
    maxLanguages: null,
    whatsappNotifications: true,
    aiInsights: true,
    customBranding: true,
    dataRetentionMonths: 999,
    sortOrder: 3,
  },
] as const

/**
 * The anchor customer (§1.2). Seeded through the ordinary tenant path — being
 * first does not make Bookends a special case in the schema.
 */
export const ANCHOR_TENANT = {
  slug: 'bookends',
  name: 'Bookends Hospitality',
  /// §8.2's BK-AK-001 prefix, which used to be a constant in the API.
  employeeCodePrefix: 'BK',
  ownerEmail: 'admin@bookendshospitality.com',
  planCode: 'professional',
} as const

/** §9.1 — the three Bookends outlets. */
export const SEED_OUTLETS = [
  { code: 'AK', name: 'Aiko', city: 'Ahmedabad', state: 'Gujarat' },
  { code: 'CP', name: 'Capiche', city: 'Ahmedabad', state: 'Gujarat' },
  { code: 'PR', name: 'Prep', city: 'Ahmedabad', state: 'Gujarat' },
] as const

/** §9.2 — departments. */
export const SEED_DEPARTMENTS = [
  { code: 'KIT', name: 'Kitchen', description: 'All cooking staff' },
  { code: 'SRV', name: 'Service', description: 'Front-of-house, waitstaff' },
  { code: 'BAR', name: 'Bar', description: 'Bartenders, bar staff' },
  { code: 'HK', name: 'Housekeeping', description: 'Cleaning, maintenance' },
  { code: 'MGT', name: 'Management', description: 'Outlet managers, supervisors' },
  { code: 'ADM', name: 'Admin', description: 'Back-office, HR' },
] as const

/** §9.3 — designations with hierarchy levels (1 = entry, 5 = senior). */
export const SEED_DESIGNATIONS = [
  { code: 'HCHEF', name: 'Head Chef', department: 'KIT', level: 5 },
  { code: 'SCHEF', name: 'Sous Chef', department: 'KIT', level: 4 },
  { code: 'CDP', name: 'Chef de Partie', department: 'KIT', level: 3 },
  { code: 'LCOOK', name: 'Line Cook', department: 'KIT', level: 2 },
  { code: 'KHELP', name: 'Kitchen Helper', department: 'KIT', level: 1 },
  { code: 'RMGR', name: 'Restaurant Manager', department: 'SRV', level: 5 },
  { code: 'CAPT', name: 'Captain', department: 'SRV', level: 4 },
  { code: 'SSTWD', name: 'Senior Steward', department: 'SRV', level: 3 },
  { code: 'STWD', name: 'Steward', department: 'SRV', level: 2 },
  { code: 'TSTWD', name: 'Trainee Steward', department: 'SRV', level: 1 },
  { code: 'HBAR', name: 'Head Bartender', department: 'BAR', level: 4 },
  { code: 'BAR', name: 'Bartender', department: 'BAR', level: 3 },
  { code: 'BHELP', name: 'Bar Helper', department: 'BAR', level: 1 },
  { code: 'HKSUP', name: 'Housekeeping Supervisor', department: 'HK', level: 3 },
  { code: 'HKSTF', name: 'Housekeeping Staff', department: 'HK', level: 1 },
] as const

export interface SeedCounts {
  outlets: number
  departments: number
  designations: number
  mappings: number
}

/**
 * Upserts the platform's plans. Platform-level: no tenant, and every tenant
 * points at one of these rows.
 */
export async function seedPlans(prisma: PrismaClient): Promise<number> {
  for (const plan of SEED_PLANS) {
    const { code, ...rest } = plan
    const data = { ...rest, questionTypes: [...rest.questionTypes] }
    await prisma.plan.upsert({
      where: { code },
      update: data,
      create: { code, ...data },
    })
  }
  return SEED_PLANS.length
}

/**
 * Upserts a tenant by slug and returns its id. Requires seedPlans() to have run
 * if planCode is given.
 */
export async function seedTenant(
  prisma: PrismaClient,
  input: {
    slug: string
    name: string
    ownerEmail: string
    employeeCodePrefix: string
    planCode?: string | undefined
  }
): Promise<string> {
  const plan = input.planCode
    ? await prisma.plan.findUnique({ where: { code: input.planCode } })
    : null

  if (input.planCode && !plan) {
    throw new Error(`Unknown plan code: ${input.planCode} — run seedPlans() first`)
  }

  const data = {
    name: input.name,
    ownerEmail: input.ownerEmail,
    employeeCodePrefix: input.employeeCodePrefix,
    planId: plan?.id ?? null,
    // An anchor customer is a paying one, not a trial that silently lapses into
    // read-only 14 days after the first deploy.
    subscriptionStatus: 'active' as const,
    isActive: true,
  }

  const row = await prisma.tenant.upsert({
    where: { slug: input.slug },
    update: data,
    create: { slug: input.slug, ...data },
  })
  return row.id
}

/**
 * Idempotent: every write is an upsert keyed on (tenantId, natural code), and
 * the update branch restores the fields a test (or an operator) may have
 * changed — isActive especially. Re-running against a populated database is
 * safe and returns it to a known state.
 *
 * tenantId is explicit rather than resolved from context: the seed runs outside
 * any request, so there is no ambient tenant to inherit and guessing one would
 * be exactly the bug the tenant extension exists to prevent.
 */
export async function seedReferenceData(
  prisma: PrismaClient,
  tenantId: string
): Promise<SeedCounts> {
  const outlets = new Map<string, string>()
  for (const outlet of SEED_OUTLETS) {
    const row = await prisma.outlet.upsert({
      where: { tenantId_code: { tenantId, code: outlet.code } },
      update: { name: outlet.name, city: outlet.city, state: outlet.state, isActive: true },
      create: { ...outlet, tenantId },
    })
    outlets.set(outlet.code, row.id)
  }

  const departments = new Map<string, string>()
  for (const department of SEED_DEPARTMENTS) {
    const row = await prisma.department.upsert({
      where: { tenantId_code: { tenantId, code: department.code } },
      update: { name: department.name, description: department.description, isActive: true },
      create: { ...department, tenantId },
    })
    departments.set(department.code, row.id)
  }

  for (const designation of SEED_DESIGNATIONS) {
    const departmentId = departments.get(designation.department)
    if (!departmentId) throw new Error(`Unknown department code: ${designation.department}`)

    await prisma.designation.upsert({
      where: { tenantId_code: { tenantId, code: designation.code } },
      update: {
        name: designation.name,
        departmentId,
        level: designation.level,
        isActive: true,
      },
      create: {
        tenantId,
        code: designation.code,
        name: designation.name,
        departmentId,
        level: designation.level,
      },
    })
  }

  // Every department exists at every outlet until Manish supplies the real
  // per-outlet mapping. Narrow this once that data lands.
  let mappings = 0
  for (const outletId of outlets.values()) {
    for (const departmentId of departments.values()) {
      await prisma.outletDepartment.upsert({
        where: { outletId_departmentId: { outletId, departmentId } },
        update: {},
        create: { outletId, departmentId, tenantId },
      })
      mappings++
    }
  }

  return {
    outlets: outlets.size,
    departments: departments.size,
    designations: SEED_DESIGNATIONS.length,
    mappings,
  }
}
