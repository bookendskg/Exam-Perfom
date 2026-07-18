import { z } from 'zod'
import { LANGUAGES } from '@bookends/core'

/**
 * §5.3's exam-taking payloads.
 *
 * Answer validation is split between here and the service on purpose: this
 * file rejects what is malformed regardless of context (a media URL that is not
 * a URL, an empty MCQ selection), while the service rejects what is only wrong
 * for a specific question (an option id that question does not have, a theory
 * answer under its word limit). The second kind needs the question, which is a
 * database read, and route middleware has no business doing those.
 */

export const assignmentParamSchema = z.object({
  assignmentId: z.string().uuid('Must be a valid assignment id'),
})

export const responseParamSchema = assignmentParamSchema.extend({
  examQuestionId: z.string().uuid('Must be a valid question id'),
})

/**
 * §4.1's `exam_sessions.device_info`: { model, os_version, app_version,
 * screen_size }. Kept permissive — it is diagnostic telemetry from an APK
 * fleet that will gain fields faster than this schema is updated — but capped,
 * because it is attacker-controlled JSON written straight to JSONB.
 */
const deviceInfoSchema = z
  .object({
    model: z.string().max(100).optional(),
    osVersion: z.string().max(50).optional(),
    appVersion: z.string().max(50).optional(),
    screenSize: z.string().max(50).optional(),
  })
  .strict()

export const startAttemptSchema = z.object({
  deviceInfo: deviceInfoSchema.optional(),
})

/**
 * One saved answer. Every field is optional because this is an autosave: the
 * APK sends whatever the candidate has done so far, and "answered question 3,
 * flagged it, moved on" is three different partial payloads.
 *
 * The refinement below is what stops it being a free-for-all — a payload that
 * says nothing at all is a client bug, and silently accepting it would make an
 * unanswered question look answered.
 */
export const saveResponseSchema = z
  .object({
    /** MCQ. Explicit null clears a selection — the candidate changed their mind. */
    selectedOptionId: z.string().max(50).nullish(),

    /** Theory. */
    theoryAnswer: z.string().max(20_000).nullish(),
    theoryAnswerLanguage: z.enum(LANGUAGES).optional(),

    /** Video/image. */
    mediaUrls: z.array(z.string().url('Each media entry must be a URL')).max(10).optional(),
    mediaType: z.enum(['image', 'video']).optional(),

    isSkipped: z.boolean().optional(),
    isFlagged: z.boolean().optional(),

    /**
     * Client-reported and therefore untrusted — it is analytics (§8), never an
     * input to grading or to the deadline, both of which use server time. The
     * cap stops a garbage value poisoning per-question timing reports.
     */
    timeSpentSeconds: z.number().int().min(0).max(86_400).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'An answer payload must contain at least one field',
  })

export const listAttemptsQuerySchema = z.object({
  status: z
    .enum(['assigned', 'notified', 'started', 'submitted', 'graded', 'absent', 'exempted'])
    .optional(),
})

export type StartAttemptInput = z.infer<typeof startAttemptSchema>
export type SaveResponseInput = z.infer<typeof saveResponseSchema>
export type ListAttemptsQuery = z.infer<typeof listAttemptsQuerySchema>
