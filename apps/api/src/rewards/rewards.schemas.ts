import { z } from 'zod'

const rewardType = z.enum(['gold', 'silver', 'bronze', 'employee_of_month', 'special'])
const certificateType = z.enum([
  'monthly',
  'quarterly',
  'yearly',
  'special',
  'training_completion',
])

/** §12 award. */
export const awardRewardSchema = z.object({
  employeeId: z.string().uuid('Not an employee id'),
  type: rewardType,
  title: z.string().trim().min(1, 'A title is required').max(255),
  description: z.string().trim().max(2000).optional(),
  /**
   * The period the reward is FOR, not when it was given. Optional because §12's
   * `special` awards are not tied to a month — but when present, both are
   * required together: a year with no month cannot be compared against the
   * monthly snapshots the suggestion list is built from.
   */
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  /** §4.1's "what earned this reward" — free-form, the awarder knows why. */
  criteria: z.record(z.unknown()).optional(),
})
  .refine((v) => (v.month === undefined) === (v.year === undefined), {
    message: 'Give both month and year, or neither',
    path: ['month'],
  })

export const listRewardsQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  type: rewardType.optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export const suggestionsQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  limit: z.coerce.number().int().positive().max(50).default(10),
})

/** §12 issue a certificate. */
export const issueCertificateSchema = z.object({
  employeeId: z.string().uuid('Not an employee id'),
  type: certificateType,
  title: z.string().trim().min(1, 'A title is required').max(255),
  description: z.string().trim().max(2000).optional(),
  /** Which exam earned it, when there is one. */
  examId: z.string().uuid().optional(),
  validUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
})

export const listCertificatesQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  type: certificateType.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export type AwardRewardInput = z.infer<typeof awardRewardSchema>
export type ListRewardsQuery = z.infer<typeof listRewardsQuerySchema>
export type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>
export type IssueCertificateInput = z.infer<typeof issueCertificateSchema>
export type ListCertificatesQuery = z.infer<typeof listCertificatesQuerySchema>
