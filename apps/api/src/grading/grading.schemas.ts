import { z } from 'zod'

/**
 * §14 grading. The spec section itself was not received, so this is built from
 * §5.3's endpoints, §4.1's exam_responses columns (marks_obtained, graded_by,
 * grader_comments, rubric_scores) and §3.2's grading rows.
 */

export const pendingQuerySchema = z.object({
  exam_id: z.string().uuid().optional(),
  /** §5.3's ?type= — theory and video_image are the two that need a human. */
  type: z.enum(['theory', 'video_image']).optional(),
  outlet_id: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

/** §10.1: "Rubric with multiple criteria, each with max marks". */
const rubricScore = z.object({
  criterion: z.string().trim().min(1),
  marks: z.coerce.number().min(0),
})

export const gradeSchema = z
  .object({
    /** Omitted when rubricScores are given — the total is derived from them. */
    marks: z.coerce.number().min(0).max(999).optional(),
    comments: z.string().trim().max(4000).optional(),
    rubricScores: z.array(rubricScore).max(10).optional(),
  })
  .refine((v) => v.marks !== undefined || (v.rubricScores?.length ?? 0) > 0, {
    message: 'Provide marks, or rubric scores to derive them from',
  })

export const finalizeSchema = z.object({
  /** §4.1 exam_assignments.supervisor_remarks. */
  supervisorRemarks: z.string().trim().max(2000).optional(),
  /**
   * §11.1 step 5's "Show result immediately" is false by default, so grading an
   * exam does not automatically show anyone their marks. Releasing is an
   * explicit act.
   */
  releaseResults: z.boolean().optional(),
})

export const responseIdParamSchema = z.object({
  id: z.string().uuid('Must be a valid response id'),
})

export const assignmentIdParamSchema = z.object({
  id: z.string().uuid('Must be a valid assignment id'),
})

export type PendingQuery = z.infer<typeof pendingQuerySchema>
export type GradeInput = z.infer<typeof gradeSchema>
export type FinalizeInput = z.infer<typeof finalizeSchema>
