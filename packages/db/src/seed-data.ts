import type { PrismaClient } from '@prisma/client'

/**
 * §9 organisational reference data.
 *
 * Lives here rather than in prisma/seed.ts because two callers need it: the
 * seed CLI, and the test harness, which restores this exact state between
 * tests. Duplicating the lists would let them drift, and a test suite seeded
 * differently from production is a test suite that lies.
 */

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
 * Idempotent: every write is an upsert keyed on a natural unique column, and
 * the update branch restores the fields a test (or an operator) may have
 * changed — isActive especially. Re-running against a populated database is
 * safe and returns it to a known state.
 */
export async function seedReferenceData(prisma: PrismaClient): Promise<SeedCounts> {
  const outlets = new Map<string, string>()
  for (const outlet of SEED_OUTLETS) {
    const row = await prisma.outlet.upsert({
      where: { code: outlet.code },
      update: { name: outlet.name, city: outlet.city, state: outlet.state, isActive: true },
      create: { ...outlet },
    })
    outlets.set(outlet.code, row.id)
  }

  const departments = new Map<string, string>()
  for (const department of SEED_DEPARTMENTS) {
    const row = await prisma.department.upsert({
      where: { code: department.code },
      update: { name: department.name, description: department.description, isActive: true },
      create: { ...department },
    })
    departments.set(department.code, row.id)
  }

  for (const designation of SEED_DESIGNATIONS) {
    const departmentId = departments.get(designation.department)
    if (!departmentId) throw new Error(`Unknown department code: ${designation.department}`)

    await prisma.designation.upsert({
      where: { code: designation.code },
      update: {
        name: designation.name,
        departmentId,
        level: designation.level,
        isActive: true,
      },
      create: {
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
        create: { outletId, departmentId },
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
