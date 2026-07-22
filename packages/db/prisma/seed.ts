/**
 * Seed CLI.
 *
 * The §9 reference data itself lives in src/seed-data.ts, because the test
 * harness restores that same state between tests and the two must not drift.
 * This file is the command-line wrapper plus the bootstrap super admin.
 */
import { PrismaClient, Role } from '@prisma/client'
import { hashPassword, validatePassword } from '@bookends/core'
import { seedReferenceData } from '../src/seed-data.js'

// The API loads the monorepo-root .env via Node's --env-file, but this script
// is run directly by `tsx` from packages/db, which does not. Load it here so a
// bare `npm run db:seed` works — unless the caller (the test harness, CI) has
// already injected DATABASE_URL, in which case theirs must win untouched.
if (!process.env['DATABASE_URL']) {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url))
  } catch {
    /* no root .env — Prisma will then fail with a clear "not found" */
  }
}

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding organisational reference data…')

  const counts = await seedReferenceData(prisma)
  console.log(`  outlets:      ${counts.outlets}`)
  console.log(`  departments:  ${counts.departments}`)
  console.log(`  designations: ${counts.designations}`)
  console.log(`  outlet/dept mappings: ${counts.mappings}`)
  console.log(`  permission grants:    ${counts.permissions}`)

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
