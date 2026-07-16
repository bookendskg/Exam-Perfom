import type { Prisma } from '@bookends/db'
import { withHandWrittenTenantFilter } from '@bookends/db'

/**
 * §4.1 exam codes: EX-2026-07-001 — year, month, then a sequence within that
 * month.
 *
 * Backed by a counter row rather than COUNT(*)+1 over exams, for the same two
 * reasons as employee codes (§8.2):
 *
 *  - Concurrency. Two admins scheduling at once would both read the same count
 *    and mint the same code; exam_code is UNIQUE, so one simply fails.
 *  - Stability. Cancelling an exam must not free its number — two different
 *    exams sharing EX-2026-07-003 in the historical record is unfixable later.
 */
export function formatExamCode(year: number, month: number, sequence: number): string {
  return `EX-${year}-${String(month).padStart(2, '0')}-${String(sequence).padStart(3, '0')}`
}

export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function parseExamCode(
  code: string
): { year: number; month: number; sequence: number } | null {
  const match = /^EX-(\d{4})-(\d{2})-(\d+)$/.exec(code)
  if (!match?.[1] || !match[2] || !match[3]) return null
  return { year: Number(match[1]), month: Number(match[2]), sequence: Number(match[3]) }
}

/**
 * Claims the next code for the month an exam is scheduled in.
 *
 * Must run inside the same transaction as the exam insert, so a failed insert
 * rolls the counter back instead of burning a number.
 *
 * `INSERT .. ON CONFLICT DO UPDATE .. RETURNING` is one atomic statement: the
 * first caller in a month inserts, everyone after updates under a row lock.
 */
export async function claimExamCode(
  tx: Prisma.TransactionClient,
  tenantId: string,
  scheduledDate: Date
): Promise<string> {
  const period = periodOf(scheduledDate)

  // Raw SQL, invisible to the tenant extension: the tenant_id here is written
  // by hand and must stay. The counter is keyed (tenant_id, period) — without
  // the column in both the INSERT and the ON CONFLICT target, every tenant
  // would share one sequence, so Bookends scheduling an exam would advance
  // Hotel Sunrise's numbering and leak our exam volume through the gaps.
  const rows = await withHandWrittenTenantFilter(
    'INSERT ... exam_code_counters keyed (tenant_id, period), tenant_id supplied',
    () =>
      tx.$queryRaw<Array<{ last_seq: number }>>`
        INSERT INTO exam_code_counters (tenant_id, period, last_seq)
             VALUES (${tenantId}::uuid, ${period}, 1)
        ON CONFLICT (tenant_id, period)
          DO UPDATE SET last_seq = exam_code_counters.last_seq + 1
          RETURNING last_seq
      `
  )

  const seq = rows[0]?.last_seq
  if (seq === undefined) throw new Error(`Failed to claim an exam code for ${period}`)

  return formatExamCode(scheduledDate.getUTCFullYear(), scheduledDate.getUTCMonth() + 1, seq)
}
