import type { Prisma } from '@bookends/db'

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
  scheduledDate: Date
): Promise<string> {
  const period = periodOf(scheduledDate)

  const rows = await tx.$queryRaw<Array<{ last_seq: number }>>`
    INSERT INTO exam_code_counters (period, last_seq)
         VALUES (${period}, 1)
    ON CONFLICT (period)
      DO UPDATE SET last_seq = exam_code_counters.last_seq + 1
      RETURNING last_seq
  `

  const seq = rows[0]?.last_seq
  if (seq === undefined) throw new Error(`Failed to claim an exam code for ${period}`)

  return formatExamCode(scheduledDate.getUTCFullYear(), scheduledDate.getUTCMonth() + 1, seq)
}
