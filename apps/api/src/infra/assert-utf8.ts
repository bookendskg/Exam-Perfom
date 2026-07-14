import type { PrismaClient } from '@bookends/db'

/**
 * Refuses to run against a database that cannot store the product's content.
 *
 * §6 makes every staff-facing string trilingual: English, Hindi (Devanagari)
 * and Gujarati. A database created with a single-byte encoding — WIN1252 and
 * LATIN1 are the usual accidents, since `initdb` and `CREATE DATABASE` both
 * inherit the host locale by default — accepts ASCII happily and then rejects
 * the first Devanagari character with:
 *
 *   character with byte sequence 0xe0 0xa4 0x96 in encoding "UTF8"
 *   has no equivalent in encoding "WIN1252"
 *
 * That failure surfaces at the first Hindi question, not at deployment, so a
 * portal can look entirely healthy until the day Manish uploads real content.
 * Checking once at boot turns a mystifying runtime error into a clear one.
 */
export async function assertUtf8Database(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ encoding: string }>>`
    SELECT pg_encoding_to_char(encoding) AS encoding
      FROM pg_database
     WHERE datname = current_database()
  `

  const encoding = rows[0]?.encoding
  if (encoding !== 'UTF8') {
    throw new Error(
      `The database encoding is ${encoding ?? 'unknown'}, but this application requires UTF8.\n` +
        `Hindi and Gujarati content (§6) cannot be stored in ${encoding}.\n` +
        `Recreate the database with:\n` +
        `  CREATE DATABASE bookends WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;`
    )
  }
}

/**
 * Proves the connection can actually round-trip Devanagari and Gujarati.
 *
 * Belt and braces over the encoding check: a UTF8 database reached over a
 * mis-set client_encoding fails the same way, and that is invisible to
 * pg_database.
 */
export async function assertTrilingualRoundTrip(prisma: PrismaClient): Promise<void> {
  const probe = 'खाद्य સલામતી'
  const rows = await prisma.$queryRaw<Array<{ probe: string }>>`SELECT ${probe}::text AS probe`

  if (rows[0]?.probe !== probe) {
    throw new Error(
      `The database connection cannot round-trip Hindi/Gujarati text.\n` +
        `Sent ${JSON.stringify(probe)}, got ${JSON.stringify(rows[0]?.probe)}.\n` +
        `Check the database encoding and client_encoding.`
    )
  }
}
