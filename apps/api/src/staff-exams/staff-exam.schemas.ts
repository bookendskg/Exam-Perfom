import { z } from 'zod'

/** §13 exam taking. */

export const startSchema = z.object({
  /** §13.1 step 3 — the language chosen for this attempt. */
  language: z.enum(['en', 'hi', 'gu']).optional(),
  /** §13.1 step 4: "I will complete this exam honestly". */
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the honesty declaration to start (§13.1)' }),
  }),
  /** §4.1 exam_sessions.device_info — for §24's proctoring. */
  deviceInfo: z
    .object({
      model: z.string().max(100).optional(),
      osVersion: z.string().max(50).optional(),
      appVersion: z.string().max(50).optional(),
      screenSize: z.string().max(50).optional(),
    })
    .optional(),
  ipAddress: z.string().max(45).optional(),
})

export const answerSchema = z
  .object({
    examQuestionId: z.string().uuid('Must be a valid question reference'),
    selectedOptionId: z.string().max(50).optional(),
    theoryAnswer: z.string().max(20000).optional(),
    theoryAnswerLanguage: z.enum(['en', 'hi', 'gu']).optional(),
    mediaUrls: z.array(z.string().url()).max(5).optional(),
    mediaType: z.enum(['image', 'video']).optional(),
    /** §13.1 step 9 — flag for review. */
    isFlagged: z.boolean().optional(),
    isSkipped: z.boolean().optional(),
    timeSpentSeconds: z.coerce.number().int().min(0).max(86400).optional(),
  })
  .refine(
    (v) =>
      v.selectedOptionId !== undefined ||
      v.theoryAnswer !== undefined ||
      v.mediaUrls !== undefined ||
      v.isSkipped === true ||
      v.isFlagged !== undefined,
    { message: 'Provide an answer, or mark the question skipped or flagged' }
  )

export const examIdParamSchema = z.object({ id: z.string().uuid('Must be a valid exam id') })

export type StartInput = z.infer<typeof startSchema>
export type AnswerInput = z.infer<typeof answerSchema>
