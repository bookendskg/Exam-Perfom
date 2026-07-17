import { z } from 'zod'
import { questionSelectionSchema } from './question-selection.js'

/** §11 exam templates and exams. */

const trilingualName = {
  nameEn: z.string().trim().min(1, 'English name is required').max(255),
  nameHi: z.string().trim().max(255).optional(),
  nameGu: z.string().trim().max(255).optional(),
}

/** §4.1 stores start_time/end_time as TIME. */
const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Must be a 24-hour time like 14:30')

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid date')

/** §11.1 step 5 exam settings. */
const settings = {
  shuffleQuestions: z.boolean().optional(),
  shuffleOptions: z.boolean().optional(),
  showResultImmediately: z.boolean().optional(),
  allowReview: z.boolean().optional(),
  allowBackNavigation: z.boolean().optional(),
}

export const createTemplateSchema = z.object({
  ...trilingualName,
  descriptionEn: z.string().trim().max(2000).optional(),
  descriptionHi: z.string().trim().max(2000).optional(),
  descriptionGu: z.string().trim().max(2000).optional(),

  // §11.1 step 2 — target audience. NULL means "all" for each (§4.1).
  outletId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  designationId: z.string().uuid().nullable().optional(),

  // §11.1 step 3
  totalMarks: z.coerce.number().positive('Total marks must be greater than zero').max(9999),
  passingPercentage: z.coerce.number().min(0).max(100).default(40),
  durationMinutes: z.coerce.number().int().positive().max(600).default(60),

  mcqCount: z.coerce.number().int().min(0).max(200).optional(),
  mcqMarksEach: z.coerce.number().positive().max(999).optional(),
  theoryCount: z.coerce.number().int().min(0).max(200).optional(),
  theoryMarksEach: z.coerce.number().positive().max(999).optional(),
  videoImageCount: z.coerce.number().int().min(0).max(200).optional(),
  videoImageMarksEach: z.coerce.number().positive().max(999).optional(),

  /** §11.2 auto-selection rules. */
  questionSelection: questionSelectionSchema.optional(),

  ...settings,
  showExplanationAfter: z.boolean().optional(),
})

export const updateTemplateSchema = createTemplateSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })

/**
 * §11.1: an exam is created from a template OR from scratch. Both paths land
 * here — templateId simply pre-fills the parameters.
 */
export const createExamSchema = z
  .object({
    templateId: z.string().uuid().optional(),

    ...trilingualName,

    // §11.1 step 7
    scheduledDate: isoDate,
    startTime: clockTime,
    endTime: clockTime,

    outletId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    designationId: z.string().uuid().nullable().optional(),

    totalMarks: z.coerce.number().positive().max(9999).optional(),
    passingPercentage: z.coerce.number().min(0).max(100).optional(),
    durationMinutes: z.coerce.number().int().positive().max(600).optional(),

    ...settings,

    /**
     * §11.1 step 4: auto-select by rules, pick manually, or both.
     * `questionIds` are added on top of whatever the rules produce.
     */
    questionSelection: questionSelectionSchema.optional(),
    questionIds: z.array(z.string().uuid()).max(200).optional(),

    /** §11.1 step 6: leave unset to auto-assign everyone matching the target. */
    employeeIds: z.array(z.string().uuid()).max(500).optional(),
    autoAssign: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.startTime >= v.endTime) {
      // Lexical comparison is safe on zero-padded HH:MM.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endTime'],
        message: 'The exam window must end after it starts',
      })
    }

    // Without a template there is nothing to inherit from, so the parameters
    // §11.1 step 3 calls for have to be present.
    if (!v.templateId && v.durationMinutes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationMinutes'],
        message: `Required when creating an exam without a template`,
      })
    }

    /**
     * totalMarks is only required when nothing can supply it.
     *
     * With a template it is inherited; with questions it is their sum, which is
     * what §11.3 checks the declared total against anyway — so asking for it up
     * front is asking the admin to predict a number the API already knows, and
     * a wrong guess is a draft that will not publish. Only a bare exam with no
     * template and no questions has no other source.
     */
    if (!v.templateId && !v.questionSelection && !v.questionIds?.length && v.totalMarks === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalMarks'],
        message: `Required when creating an exam without a template or any questions`,
      })
    }
  })

export const updateExamSchema = z
  .object({
    ...trilingualName,
    nameEn: z.string().trim().min(1).max(255).optional(),
    scheduledDate: isoDate.optional(),
    startTime: clockTime.optional(),
    endTime: clockTime.optional(),
    totalMarks: z.coerce.number().positive().max(9999).optional(),
    passingPercentage: z.coerce.number().min(0).max(100).optional(),
    durationMinutes: z.coerce.number().int().positive().max(600).optional(),
    ...settings,
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' })

/**
 * §11.1 step 6: naming employees is the exception, not the rule.
 *
 * Omitting them means "everyone this exam targets", which is what assigning an
 * exam scoped to an outlet and department normally means — and what
 * `assignEmployees` already does when handed no ids. Requiring the list forced
 * the caller to compute a set the API derives better: it applies §11.3's active
 * filter itself, so a named list can silently skip a departed employee where
 * the derived one simply never includes them.
 *
 * An empty array stays rejected — it reads as a mistake, not as "everyone".
 */
export const assignSchema = z.object({
  employeeIds: z.array(z.string().uuid()).min(1, 'Provide at least one employee').max(500).optional(),
})

export const listExamsQuerySchema = z.object({
  status: z.enum(['draft', 'scheduled', 'active', 'completed', 'cancelled', 'archived']).optional(),
  outlet_id: z.string().uuid().optional(),
  from_date: isoDate.optional(),
  to_date: isoDate.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export const cancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

export const idParamSchema = z.object({ id: z.string().uuid('Must be a valid id') })

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>
export type CreateExamInput = z.infer<typeof createExamSchema>
export type UpdateExamInput = z.infer<typeof updateExamSchema>
export type AssignInput = z.infer<typeof assignSchema>
export type ListExamsQuery = z.infer<typeof listExamsQuerySchema>
export type CancelInput = z.infer<typeof cancelSchema>
