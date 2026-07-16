#!/usr/bin/env node
/**
 * Creates a platform admin (§10).
 *
 * A CLI and not an HTTP route, deliberately: a self-service endpoint that mints
 * the most powerful identity on the platform is a hole no amount of guarding
 * closes, and the first admin has nobody to authenticate to anyway. Creating
 * one requires shell access to the database — which is the correct bar.
 *
 * Usage:
 *   node packages/db/scripts/create-platform-admin.mjs <email> <name> [role]
 *
 * role: super_admin (default) | support | finance
 * The password is read from PLATFORM_ADMIN_PASSWORD, never argv — arguments
 * land in shell history and in `ps`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const envFile = join(repoRoot, '.env')
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (typeof value === 'string') process.env[key] ??= value
  }
}

const [email, name, role = 'super_admin'] = process.argv.slice(2)
const password = process.env['PLATFORM_ADMIN_PASSWORD']

if (!email || !name) {
  console.error('Usage: node packages/db/scripts/create-platform-admin.mjs <email> <name> [role]')
  console.error('       PLATFORM_ADMIN_PASSWORD must be set.')
  process.exit(1)
}
if (!password) {
  console.error('PLATFORM_ADMIN_PASSWORD is not set. Refusing to create an admin without one.')
  process.exit(1)
}
if (!['super_admin', 'support', 'finance'].includes(role)) {
  console.error(`Unknown role "${role}". Use super_admin, support, or finance.`)
  process.exit(1)
}
if (password.length < 12) {
  // Not the tenant password policy: this identity can read every customer's
  // data, so the bar is higher and there is no UX argument for lowering it.
  console.error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters.')
  process.exit(1)
}

const { createPrismaClient, runAsPlatform } = await import('@bookends/db')
const { hashPassword } = await import('@bookends/core')

const prisma = createPrismaClient(process.env['DATABASE_URL'])

try {
  const passwordHash = await hashPassword(password)

  // The update branch sets the hash rather than being left empty: a re-run must
  // ROTATE the password, not silently keep the old one. (prisma/seed.ts:36
  // documents this exact trap for the bootstrap super admin — an `update: {}`
  // means rotating the env var does nothing and nobody notices.)
  const admin = await runAsPlatform('CLI: creating a platform admin', () =>
    prisma.platformAdmin.upsert({
      where: { email: email.toLowerCase() },
      update: { passwordHash, name, role, isActive: true },
      create: { email: email.toLowerCase(), name, role, passwordHash },
      select: { id: true, email: true },
    })
  )
  console.log(`Platform admin ready: ${admin.email} (${role})`)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
} finally {
  await prisma.$disconnect()
}
