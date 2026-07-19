import { z } from 'zod'

/**
 * §3.2's grading payloads.
 *
 * Split by question type rather than one polymorphic body, because §3.2 splits
 * the permission the same way: `grading:theory` and `grading:video_image` are
 * separate rows, and a single endpoint could not be gated by both without
 * granting each the other's reach.
 *
 * As in the attempts module, validation is divided: this file rejects what is
 * malformed on its own, while the service rejects what is only wrong for a
 * specific response — marks above that question's maximum, a rubric criterion
 * the question does not define. Those need the stored question, which is a
 * database read that route middleware has no business doing.
 */

export const assignmentParamSchema = z.object({
  assignmentId: z.string().uuid('Must be a valid assignment id'),
})

export const responseParamSchema = assignmentParamSchema.extend({
  examQuestionId: z.string().uuid('Must be a valid question id'),
})

/**
 * Marks are DECIMAL(5,2). Two decimals is what the column stores, so a third
 * would be silently rounded and the grader would see a number they did not
 * type — better to refuse it.
 */
const marks = z
  .number()
  .min(0, 'Marks cannot be negative')
  .max(9999)
  .refine((n) => Number.isFinite(n) && Math.round(n * 100) === n * 100, {
    message: 'Marks may have at most two decimal places',
  })

const comments = z.string().trim().max(2000).nullish()

/** §3.2 "Grade theory answers". */
export const gradeTheorySchema = z.object({
  marksObtained: marks,
  graderComments: comments,
})

/**
 * §3.2 "Grade video/image answers", scored against §10.1's rubric.
 *
 * The scores arrive keyed by criterion, matching how `rubric_scores` is stored
 * (§4.1: "{ criterion: marks_given }"). The total is NOT sent — the service
 * derives it, because a client-supplied total that disagreed with its own
 * breakdown would be unresolvable, and the breakdown is the thing a candidate
 * can be shown.
 */
export const gradeRubricSchema = z.object({
  rubricScores: z
    .record(z.string().min(1), marks)
    .refine((scores) => Object.keys(scores).length > 0, {
      message: 'Score at least one criterion',
    }),
  graderComments: comments,
})

/**
 * §3.2 "Override auto-grading" — super_admin and admin only.
 *
 * Unlike the two above this may target ANY response, including an auto-graded
 * MCQ. That is the whole point of the row: correcting a question whose answer
 * key turned out to be wrong, after staff have already sat it.
 */
export const overrideSchema = z.object({
  marksObtained: marks,
  /** Required, not optional: an override with no stated reason is unauditable. */
  graderComments: z.string().trim().min(1, 'An override must say why').max(2000),
})

/** §5.3 POST /grading/assignments/:id/finalise. */
export const finaliseSchema = z.object({
  /** §4.1's `supervisor_remarks`, shown to the candidate with their result. */
  supervisorRemarks: z.string().trim().max(2000).nullish(),
})

export const queueQuerySchema = z.object({
  examId: z.string().uuid().optional(),
  outletId: z.string().uuid().optional(),
  /** Narrow to the type this grader is here to mark. */
  type: z.enum(['theory', 'video_image']).optional(),
  /** Default excludes finished work; 'all' includes it for review. */
  status: z.enum(['pending', 'all']).default('pending'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
})

export type GradeTheoryInput = z.infer<typeof gradeTheorySchema>
export type GradeRubricInput = z.infer<typeof gradeRubricSchema>
export type OverrideInput = z.infer<typeof overrideSchema>
export type FinaliseInput = z.infer<typeof finaliseSchema>
export type QueueQuery = z.infer<typeof queueQuerySchema>
