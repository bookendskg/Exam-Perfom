import type { Prisma } from '@bookends/db'
import { withHandWrittenTenantFilter } from '@bookends/db'

/**
 * Employee codes, per §8.2: {PREFIX}-{OUTLET_CODE}-{SEQUENTIAL_NUMBER}
 *   BK-AK-001, BK-CP-042, BK-PR-015
 *
 * The prefix is per tenant (Tenant.employeeCodePrefix), not the constant "BK"
 * it used to be: "BK" is Bookends' prefix, and a second customer's staff must
 * not be issued codes branded with another company's initials.
 *
 * §8.2 requires codes are unique, sequential per outlet, and **never reused —
 * even after employee departure**. That last clause is why this uses a counter
 * on the outlet row rather than the obvious MAX(employee_code) + 1: if
 * BK-AK-003 leaves and their row is deleted, MAX+1 hands 003 to the next hire,
 * and two people share a code in the historical record.
 *
 * `UPDATE .. SET last_employee_seq = last_employee_seq + 1 RETURNING` is atomic
 * and takes a row lock, so two simultaneous hires at the same outlet serialise
 * rather than both reading the same value.
 */

/** Zero-padded to 3 digits, but not truncated — outlet 1000+ becomes BK-AK-1000. */
export function formatEmployeeCode(prefix: string, outletCode: string, sequence: number): string {
  return `${prefix}-${outletCode}-${String(sequence).padStart(3, '0')}`
}

/**
 * Parses a code without knowing the tenant's prefix.
 *
 * The prefix is matched loosely rather than pinned to "BK", because the caller
 * generally has the code but not the tenant that minted it. Callers that need
 * to know the prefix is *theirs* should compare against their own tenant's.
 */
export function parseEmployeeCode(
  code: string
): { prefix: string; outletCode: string; sequence: number } | null {
  const match = /^([A-Z0-9]+)-([A-Z0-9]+)-(\d+)$/.exec(code)
  if (!match?.[1] || !match[2] || !match[3]) return null
  return { prefix: match[1], outletCode: match[2], sequence: Number(match[3]) }
}

/**
 * Claims the next code for an outlet. MUST be called inside the same
 * transaction as the employee insert — otherwise a failed insert burns a
 * sequence number and leaves a gap.
 *
 * (A gap is not a correctness bug — §8.2 asks for sequential-and-never-reused,
 * not gapless — but burning numbers on every validation failure is untidy.)
 */
export async function claimEmployeeCode(
  tx: Prisma.TransactionClient,
  tenantId: string,
  outletId: string
): Promise<string> {
  // Raw SQL, so the tenant extension cannot reach it — the tenant_id predicate
  // is hand-written and load-bearing. Without it, passing another tenant's
  // outletId would increment THEIR counter and mint a code in their sequence.
  // Remove it only once RLS is enforcing the same thing underneath.
  const rows = await withHandWrittenTenantFilter(
    'UPDATE outlets ... WHERE tenant_id = $tenantId',
    () =>
      tx.$queryRaw<Array<{ code: string; last_employee_seq: number }>>`
        UPDATE outlets
           SET last_employee_seq = last_employee_seq + 1
         WHERE id = ${outletId}::uuid
           AND tenant_id = ${tenantId}::uuid
        RETURNING code, last_employee_seq
      `
  )

  const row = rows[0]
  if (!row) throw new Error(`Outlet ${outletId} not found while claiming an employee code`)

  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { employeeCodePrefix: true },
  })

  return formatEmployeeCode(tenant.employeeCodePrefix, row.code, row.last_employee_seq)
}
