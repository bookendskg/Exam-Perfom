import type { Prisma } from '@bookends/db'
import { withHandWrittenTenantFilter } from '@bookends/db'

/**
 * Certificate numbers (§4.1): CERT-2026-0001.
 *
 * The same counter pattern as exam codes (exams/exam-code.ts) and employee
 * codes (§8.2), for the same two reasons — and the stakes are higher here than
 * either:
 *
 *  - Concurrency. Two admins issuing at once would both read the same COUNT(*)
 *    and mint the same number. certificate_number is UNIQUE per tenant, so one
 *    simply fails — but if the constraint were ever relaxed, two employees would
 *    hold CERT-2026-0007 and nothing could say which was real.
 *  - Permanence. A certificate number is a claim an employee makes to a future
 *    employer. Revoking one must not free its number: reissuing CERT-2026-0007
 *    to someone else makes the first holder's record unverifiable, and there is
 *    no fixing that afterwards.
 *
 * Gaps are the feature, not a defect — the same point exam-code.ts makes.
 */

/** Zero-padded to 4, not truncated: certificate 10000 becomes CERT-2026-10000. */
export function formatCertificateNumber(year: number, sequence: number): string {
  return `CERT-${year}-${String(sequence).padStart(4, '0')}`
}

export function parseCertificateNumber(value: string): { year: number; sequence: number } | null {
  const match = /^CERT-(\d{4})-(\d+)$/.exec(value)
  if (!match?.[1] || !match[2]) return null
  return { year: Number(match[1]), sequence: Number(match[2]) }
}

/**
 * Claims the next number for a year.
 *
 * MUST run inside the same transaction as the certificate insert, so a failed
 * insert rolls the counter back rather than burning a number.
 *
 * `INSERT .. ON CONFLICT DO UPDATE .. RETURNING` is one atomic statement: the
 * first issuer of a year inserts, everyone after updates under a row lock, so
 * concurrent callers serialise instead of racing.
 */
export async function claimCertificateNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  year: number
): Promise<string> {
  // Raw SQL, so the tenant extension cannot see it — the tenant_id here is
  // hand-written and load-bearing. Without it in BOTH the INSERT and the
  // ON CONFLICT target, every tenant would share one sequence: issuing a
  // certificate at Bookends would advance Hotel Sunrise's numbering and leak
  // our issuance volume through the gaps.
  const rows = await withHandWrittenTenantFilter(
    'INSERT ... certificate_counters keyed (tenant_id, year), tenant_id supplied',
    () =>
      tx.$queryRaw<Array<{ last_seq: number }>>`
        INSERT INTO certificate_counters (tenant_id, year, last_seq)
             VALUES (${tenantId}::uuid, ${year}, 1)
        ON CONFLICT (tenant_id, year)
          DO UPDATE SET last_seq = certificate_counters.last_seq + 1
          RETURNING last_seq
      `
  )

  const seq = rows[0]?.last_seq
  if (seq === undefined) throw new Error(`Failed to claim a certificate number for ${year}`)

  return formatCertificateNumber(year, seq)
}
