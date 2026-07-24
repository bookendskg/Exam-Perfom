/**
 * Set (or clear) a user's email address.
 *
 * Password-reset codes are delivered by email, but `User.email` is optional and
 * most seeded accounts — including the bootstrap super admin — have none. This
 * is the one-liner for giving an account a deliverable address so the reset flow
 * can actually be tested end to end.
 *
 *   npm run db:set-email -- 9876543210 you@example.com
 *   npm run db:set-email -- 9876543210 --clear
 *
 * Development convenience only. It touches exactly the one account named.
 */
import { PrismaClient } from '@prisma/client'

// Run directly by `tsx` from packages/db, which does not load the monorepo-root
// .env the way the API does. Load it so a bare invocation works, without
// overriding an env a caller has already set.
if (!process.env['DATABASE_URL']) {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url))
  } catch {
    /* no root .env — Prisma will fail with a clear "not found" */
  }
}

const prisma = new PrismaClient()

async function main() {
  const [phone, emailArg] = process.argv.slice(2)

  if (!phone || !emailArg) {
    throw new Error(
      'Usage: npm run db:set-email -- <phone> <email|--clear>\n' +
        '  e.g. npm run db:set-email -- 9876543210 you@example.com'
    )
  }

  const clearing = emailArg === '--clear'
  const email = clearing ? null : emailArg

  // Reject obvious nonsense early — a mistyped address that silently "works"
  // then sends reset codes into the void is worse than a loud failure here.
  if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`"${email}" does not look like an email address`)
  }

  const user = await prisma.user.findUnique({ where: { phone }, select: { id: true } })
  if (!user) {
    throw new Error(`No user with phone ${phone}`)
  }

  await prisma.user.update({ where: { phone }, data: { email } })
  console.log(clearing ? `Cleared the email for ${phone}` : `Set ${phone} email to ${email}`)
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
