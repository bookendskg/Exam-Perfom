/**
 * @bookends/db — the typed database surface for the portal.
 *
 * Re-exports the generated Prisma client so consumers import from here rather
 * than reaching into `@prisma/client` directly. That keeps the generator's
 * output location an implementation detail of this package.
 */
export * from '@prisma/client'

import { PrismaClient } from '@prisma/client'

/**
 * Builds a client against an explicit connection URL.
 *
 * Tests need this: `embedded-postgres` binds a random port, so the URL is only
 * known at runtime and cannot come from a build-time `env("DATABASE_URL")`.
 * Passing no URL falls back to DATABASE_URL, which is what the API does.
 */
export function createPrismaClient(url?: string): PrismaClient {
  return url ? new PrismaClient({ datasourceUrl: url }) : new PrismaClient()
}
