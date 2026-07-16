import { z } from 'zod'

/**
 * §11's threshold for "weak". 60, matching analytics.weakAreas and training's
 * recommendations — not §11.1's passing mark of 40. Those answer different
 * questions: passing means "did not fail the exam", weak means "is not actually
 * competent at this". A 45% on food safety is a pass and still a problem.
 */
const threshold = z.coerce.number().min(0).max(100).default(60)

export const employeeReportQuerySchema = z.object({
  /** How much history to include. Six months matches §8.5's trend chart. */
  months: z.coerce.number().int().positive().max(36).default(6),
  threshold,
})

export const examReportQuerySchema = z.object({
  includeDistribution: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
})

export const outletReportQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  threshold,
})

/**
 * §11's export. `csv` is not in §4.1's matrix — the tiers are "PDF + Excel" —
 * but it is the only one of the three this system can honestly produce today,
 * and it is what a spreadsheet actually opens. See reports.export.ts.
 */
export const exportQuerySchema = z.object({
  type: z.enum(['employee', 'exam', 'outlet']),
  format: z.enum(['csv', 'pdf', 'excel']),
  /** The employee, exam or outlet being exported. */
  id: z.string().uuid('Not a valid id'),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
})

export const idParamSchema = z.object({ id: z.string().uuid('Not a valid id') })

export type EmployeeReportQuery = z.infer<typeof employeeReportQuerySchema>
export type ExamReportQuery = z.infer<typeof examReportQuerySchema>
export type OutletReportQuery = z.infer<typeof outletReportQuerySchema>
export type ExportQuery = z.infer<typeof exportQuerySchema>
