import { z } from 'zod'

/** §13 assign. topicId and sourceDocumentId are both optional; the service
 *  requires at least one — an assignment with neither is a due date attached to
 *  nothing. */
export const assignTrainingSchema = z.object({
  employeeId: z.string().uuid('Not an employee id'),
  topicId: z.string().uuid('Not a topic id').optional(),
  sourceDocumentId: z.string().uuid('Not a document id').optional(),
  reason: z.string().trim().max(1000).optional(),
  /** ISO date. Defaults to +14 days in the service. */
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
  /** §18 provenance: which exam result prompted this. */
  triggeringExamId: z.string().uuid().optional(),
  triggeringScore: z.coerce.number().min(0).max(100).optional(),
})

export const completeTrainingSchema = z.object({
  completionNotes: z.string().trim().max(2000).optional(),
})

export const listTrainingQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  status: z.enum(['assigned', 'in_progress', 'completed', 'overdue']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

/**
 * §18 recommendations.
 *
 * The default threshold is 60, matching analytics.weakAreas(). Not §11.1's
 * passing mark of 40: passing means "did not fail the exam", and this asks a
 * different question — "is this person actually competent at this topic". A
 * 45% on food safety is a pass and is still someone who should read the manual.
 */
export const recommendQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  threshold: z.coerce.number().min(0).max(100).default(60),
  limit: z.coerce.number().int().positive().max(200).default(50),
})

export const trainingIdParamSchema = z.object({
  id: z.string().uuid('Not a training id'),
})

export type AssignTrainingInput = z.infer<typeof assignTrainingSchema>
export type CompleteTrainingInput = z.infer<typeof completeTrainingSchema>
export type ListTrainingQuery = z.infer<typeof listTrainingQuerySchema>
export type RecommendQuery = z.infer<typeof recommendQuerySchema>
