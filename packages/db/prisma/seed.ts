/**
 * Seed data for the Bookends staff performance portal.
 *
 * Populates the organisational reference data from §9 — outlets, departments,
 * designations and their outlet mappings — plus a bootstrap super admin.
 *
 * Idempotent: every write is an upsert keyed on a natural unique column, so
 * re-running against a populated database is safe.
 */
import { PrismaClient, Role } from '@prisma/client'
import { hashPassword, validatePassword } from '@bookends/core'

const prisma = new PrismaClient()

/** §9.1 — the three Bookends outlets. */
const OUTLETS = [
  { code: 'AK', name: 'Aiko', city: 'Ahmedabad', state: 'Gujarat' },
  { code: 'CP', name: 'Capiche', city: 'Ahmedabad', state: 'Gujarat' },
  { code: 'PR', name: 'Prep', city: 'Ahmedabad', state: 'Gujarat' },
]

/** §9.2 — departments. */
const DEPARTMENTS = [
  { code: 'KIT', name: 'Kitchen', description: 'All cooking staff' },
  { code: 'SRV', name: 'Service', description: 'Front-of-house, waitstaff' },
  { code: 'BAR', name: 'Bar', description: 'Bartenders, bar staff' },
  { code: 'HK', name: 'Housekeeping', description: 'Cleaning, maintenance' },
  { code: 'MGT', name: 'Management', description: 'Outlet managers, supervisors' },
  { code: 'ADM', name: 'Admin', description: 'Back-office, HR' },
]

/** §9.3 — designations with hierarchy levels (1 = entry, 5 = senior). */
const DESIGNATIONS = [
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
]

async function main() {
  console.log('Seeding organisational reference data…')

  const outlets = new Map<string, string>()
  for (const outlet of OUTLETS) {
    const row = await prisma.outlet.upsert({
      where: { code: outlet.code },
      update: { name: outlet.name, city: outlet.city, state: outlet.state },
      create: outlet,
    })
    outlets.set(outlet.code, row.id)
  }
  console.log(`  outlets:      ${outlets.size}`)

  const departments = new Map<string, string>()
  for (const department of DEPARTMENTS) {
    const row = await prisma.department.upsert({
      where: { code: department.code },
      update: { name: department.name, description: department.description },
      create: department,
    })
    departments.set(department.code, row.id)
  }
  console.log(`  departments:  ${departments.size}`)

  let designationCount = 0
  for (const designation of DESIGNATIONS) {
    const departmentId = departments.get(designation.department)
    if (!departmentId) throw new Error(`Unknown department code: ${designation.department}`)

    await prisma.designation.upsert({
      where: { code: designation.code },
      update: { name: designation.name, departmentId, level: designation.level },
      create: {
        code: designation.code,
        name: designation.name,
        departmentId,
        level: designation.level,
      },
    })
    designationCount++
  }
  console.log(`  designations: ${designationCount}`)

  // Every department exists at every outlet until Manish supplies the real
  // per-outlet mapping. Narrow this once that data lands.
  let mappingCount = 0
  for (const outletId of outlets.values()) {
    for (const departmentId of departments.values()) {
      await prisma.outletDepartment.upsert({
        where: { outletId_departmentId: { outletId, departmentId } },
        update: {},
        create: { outletId, departmentId },
      })
      mappingCount++
    }
  }
  console.log(`  outlet/dept mappings: ${mappingCount}`)

  const bootstrapPhone = process.env.SEED_ADMIN_PHONE
  const bootstrapPassword = process.env.SEED_ADMIN_PASSWORD
  if (bootstrapPhone && bootstrapPassword) {
    // Reject a bootstrap password the login endpoint would refuse. Failing here
    // beats creating an account nobody can sign in to.
    const violations = validatePassword(bootstrapPassword, Role.super_admin)
    if (violations.length > 0) {
      throw new Error(
        `SEED_ADMIN_PASSWORD fails the super_admin policy:\n` +
          violations.map((v) => `  - ${v.message}`).join('\n')
      )
    }

    // `update` must set the hash, not be left empty. With `update: {}` a re-seed
    // silently keeps whatever hash is already stored — so rotating
    // SEED_ADMIN_PASSWORD would do nothing, and an account seeded under the old
    // scrypt hasher could never be healed by re-running the seed.
    const passwordHash = await hashPassword(bootstrapPassword)
    await prisma.user.upsert({
      where: { phone: bootstrapPhone },
      update: {
        passwordHash,
        role: Role.super_admin,
        isActive: true,
        mustChangePassword: true,
      },
      create: {
        phone: bootstrapPhone,
        role: Role.super_admin,
        passwordHash,
        mustChangePassword: true,
      },
    })
    console.log(`  bootstrap super admin: ${bootstrapPhone} (must change password on first login)`)
  } else {
    console.log('  bootstrap super admin: skipped (set SEED_ADMIN_PHONE + SEED_ADMIN_PASSWORD)')
  }

  console.log('Seed complete.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
