import { Prisma } from '@bookends/db'
import type { PrismaClient, QuestionType } from '@bookends/db'
import { z } from 'zod'
import { ApiError } from '../http/api-error.js'

/**
 * §11.2 auto-selection rules:
 *
 *   {
 *     "mcq": {
 *       "total": 20,
 *       "distribution": [
 *         { "difficulty": "easy", "count": 8, "topics": ["food_safety", "hygiene"] },
 *         { "difficulty": "medium", "count": 8, "topics": [...] },
 *         { "difficulty": "hard", "count": 4, "topics": ["any"] }
 *       ]
 *     },
 *     "theory": { ... },
 *     "video_image": { ... }
 *   }
 */
const distributionRule = z.object({
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  count: z.coerce.number().int().positive().max(200),
  /** Topic ids. §11.2's example uses the literal "any" to mean unrestricted. */
  topics: z.array(z.string()).optional(),
  responseType: z.enum(['image', 'video', 'both']).optional(),
})

const typeRules = z.object({
  total: z.coerce.number().int().positive().max(200),
  distribution: z.array(distributionRule).min(1),
})

export const questionSelectionSchema = z
  .object({
    mcq: typeRules.optional(),
    theory: typeRules.optional(),
    video_image: typeRules.optional(),
  })
  .refine((v) => v.mcq || v.theory || v.video_image, {
    message: 'Selection rules must cover at least one question type',
  })
  .superRefine((rules, ctx) => {
    for (const [type, spec] of Object.entries(rules)) {
      if (!spec) continue
      const summed = spec.distribution.reduce((n, d) => n + d.count, 0)
      if (summed !== spec.total) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [type, 'total'],
          message: `Distribution counts total ${summed} but "total" says ${spec.total}`,
        })
      }
    }
  })

export type QuestionSelectionRules = z.infer<typeof questionSelectionSchema>

export interface SelectedQuestion {
  id: string
  marks: number
  type: QuestionType
}

export interface ShortfallReport {
  type: QuestionType
  difficulty?: string
  requested: number
  found: number
}

export interface SelectionResult {
  questions: SelectedQuestion[]
  /** Rules the bank could not satisfy. §11.3 blocks publishing while any exist. */
  shortfalls: ShortfallReport[]
}

/**
 * Picks questions matching §11.2's rules.
 *
 * Only APPROVED questions are eligible — §11.3 requires it, and selecting a
 * draft would let unreviewed content reach staff. Filtering here rather than at
 * publish time also means the shortfall is reported while the exam is still
 * being built, when it can be fixed.
 */
export class QuestionSelector {
  constructor(private readonly prisma: PrismaClient) {}

  async select(
    rules: QuestionSelectionRules,
    target: { outletId?: string | null; departmentId?: string | null; designationLevel?: number }
  ): Promise<SelectionResult> {
    const questions: SelectedQuestion[] = []
    const shortfalls: ShortfallReport[] = []
    // A question must not appear twice in one exam, and two rules can overlap
    // (a "hard/any-topic" rule and a "hard/food-safety" rule both match).
    const taken = new Set<string>()

    for (const type of ['mcq', 'theory', 'video_image'] as const) {
      const spec = rules[type]
      if (!spec) continue

      for (const rule of spec.distribution) {
        const where = this.buildWhere(type, rule, target, taken)

        // Random ordering so two exams from the same template are not
        // identical, and so §11.2's "count" is a genuine sample rather than
        // always the oldest N.
        const found = await this.prisma.$queryRaw<Array<{ id: string; marks: string }>>`
          SELECT id, marks::text FROM questions
           WHERE ${where}
           ORDER BY random()
           LIMIT ${rule.count}
        `

        for (const q of found) {
          taken.add(q.id)
          questions.push({ id: q.id, marks: Number(q.marks), type })
        }

        if (found.length < rule.count) {
          shortfalls.push({
            type,
            ...(rule.difficulty ? { difficulty: rule.difficulty } : {}),
            requested: rule.count,
            found: found.length,
          })
        }
      }
    }

    return { questions, shortfalls }
  }

  private buildWhere(
    type: QuestionType,
    rule: z.infer<typeof distributionRule>,
    target: { outletId?: string | null; departmentId?: string | null; designationLevel?: number },
    taken: Set<string>
  ): Prisma.Sql {
    const clauses: Prisma.Sql[] = [
      Prisma.sql`type = ${type}::"QuestionType"`,
      // §11.3: exams are built from approved questions only.
      Prisma.sql`status = 'approved'::"QuestionStatus"`,
    ]

    if (rule.difficulty) {
      clauses.push(Prisma.sql`difficulty = ${rule.difficulty}::"Difficulty"`)
    }

    // §11.2's example uses the literal "any" to mean "no topic restriction".
    const topics = rule.topics?.filter((t) => t.toLowerCase() !== 'any')
    if (topics && topics.length > 0) {
      clauses.push(
        Prisma.sql`topic_id IN (${Prisma.join(topics.map((t) => Prisma.sql`${t}::uuid`))})`
      )
    }

    if (target.departmentId) {
      clauses.push(Prisma.sql`department_id = ${target.departmentId}::uuid`)
    }

    // A NULL outlet_id means the question applies everywhere (§4.1), so an
    // outlet-targeted exam must draw on the global bank too — otherwise an
    // outlet with few questions of its own could never fill an exam.
    if (target.outletId) {
      clauses.push(Prisma.sql`(outlet_id = ${target.outletId}::uuid OR outlet_id IS NULL)`)
    }

    // §4.1's designation targeting: a Head Chef question should not land in a
    // Kitchen Helper's exam.
    if (target.designationLevel !== undefined) {
      clauses.push(
        Prisma.sql`COALESCE(designation_level_min, 1) <= ${target.designationLevel}`,
        Prisma.sql`COALESCE(designation_level_max, 5) >= ${target.designationLevel}`
      )
    }

    if (rule.responseType) {
      clauses.push(Prisma.sql`response_type = ${rule.responseType}::"ExpectedResponseType"`)
    }

    if (taken.size > 0) {
      clauses.push(
        Prisma.sql`id NOT IN (${Prisma.join([...taken].map((id) => Prisma.sql`${id}::uuid`))})`
      )
    }

    return Prisma.join(clauses, ' AND ')
  }
}

/**
 * §11.3: "Total marks must match sum of question marks".
 *
 * Returned rather than thrown so the builder can show the mismatch while the
 * exam is still a draft.
 */
export function sumMarks(questions: Array<{ marks: number }>): number {
  return questions.reduce((total, q) => total + q.marks, 0)
}

export function assertNoShortfalls(shortfalls: ShortfallReport[]): void {
  if (shortfalls.length === 0) return

  throw ApiError.validation(
    'The question bank cannot satisfy these selection rules',
    shortfalls.map((s) => ({
      field: `${s.type}${s.difficulty ? `.${s.difficulty}` : ''}`,
      message:
        `Asked for ${s.requested} approved ${s.difficulty ?? ''} ${s.type} questions, found ${s.found}`.replace(
          /\s+/g,
          ' '
        ),
    }))
  )
}
