import type { Prisma } from '@bookends/db'

/**
 * Employee codes, per §8.2: BK-{OUTLET_CODE}-{SEQUENTIAL_NUMBER}
 *   BK-AK-001, BK-CP-042, BK-PR-015
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
export const EMPLOYEE_CODE_PREFIX = 'BK'

/** Zero-padded to 3 digits, but not truncated — outlet 1000+ becomes BK-AK-1000. */
export function formatEmployeeCode(outletCode: string, sequence: number): string {
  return `${EMPLOYEE_CODE_PREFIX}-${outletCode}-${String(sequence).padStart(3, '0')}`
}

export function parseEmployeeCode(code: string): { outletCode: string; sequence: number } | null {
  const match = /^BK-([A-Z0-9]+)-(\d+)$/.exec(code)
  if (!match?.[1] || !match[2]) return null
  return { outletCode: match[1], sequence: Number(match[2]) }
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
  outletId: string
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ code: string; last_employee_seq: number }>>`
    UPDATE outlets
       SET last_employee_seq = last_employee_seq + 1
     WHERE id = ${outletId}::uuid
    RETURNING code, last_employee_seq
  `

  const row = rows[0]
  if (!row) throw new Error(`Outlet ${outletId} not found while claiming an employee code`)

  return formatEmployeeCode(row.code, row.last_employee_seq)
}
