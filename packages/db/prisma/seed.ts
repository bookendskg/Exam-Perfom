/**
 * Seed CLI.
 *
 * The §9 reference data itself lives in src/seed-data.ts, because the test
 * harness restores that same state between tests and the two must not drift.
 * This file is the command-line wrapper plus the bootstrap super admin.
 */
import { PrismaClient, Role } from '@prisma/client'
import { hashPassword, validatePassword } from '@bookends/core'
import { ANCHOR_TENANT, seedPlans, seedReferenceData, seedTenant } from '../src/seed-data.js'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding subscription plans…')
  console.log(`  plans: ${await seedPlans(prisma)}`)

  // The reference data below is Bookends', so it needs Bookends to exist first.
  const tenantId = await seedTenant(prisma, ANCHOR_TENANT)
  console.log(`  tenant: ${ANCHOR_TENANT.slug} (${tenantId})`)

  console.log('Seeding organisational reference data…')

  const counts = await seedReferenceData(prisma, tenantId)
  console.log(`  outlets:      ${counts.outlets}`)
  console.log(`  departments:  ${counts.departments}`)
  console.log(`  designations: ${counts.designations}`)
  console.log(`  outlet/dept mappings: ${counts.mappings}`)

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
    // Keyed on (tenant, phone) now: the same number may be a super admin at one
    // customer and a line cook at another.
    await prisma.user.upsert({
      where: { tenantId_phone: { tenantId, phone: bootstrapPhone } },
      update: {
        passwordHash,
        role: Role.super_admin,
        isActive: true,
        mustChangePassword: true,
      },
      create: {
        tenantId,
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
