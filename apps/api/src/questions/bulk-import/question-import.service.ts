import type { Prisma, PrismaClient } from '@bookends/db'
import { isFeatureAllowed, remainingCapacity } from '@bookends/core'
import type { ZodError } from 'zod'
import type { Principal } from '../../infra/session-store/index.js'
import type { PlanService } from '../../plans/plan.service.js'
import type { RawRow } from '../../bulk-import/parse.js'
import { createQuestionSchema } from '../question.schemas.js'
import { loadQuestionLookup, mapQuestionRow, type RowError } from './question-row.js'

export interface QuestionRowResult {
  lineNumber: number
  questionText?: string
  questionId?: string
  errors: RowError[]
}

export interface QuestionImportReport {
  dryRun: boolean
  totalRows: number
  valid: number
  invalid: number
  imported: number
  /** §10.5 translation coverage, computed over the batch as it lands. */
  translations: { hi: number; gu: number }
  rows: QuestionRowResult[]
}

/**
 * §10.4 question bulk import.
 *
 * §3.2 restricts this to super_admin and admin, so unlike the employee
 * importer there is no per-row scope check — the caller already has 'all'.
 *
 * Everything imports as DRAFT (§10.2). A bulk upload is not a review, and
 * approving 200 questions by uploading a file would defeat the workflow.
 */
export class QuestionImportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly plans: PlanService
  ) {}

  async run(
    principal: Principal,
    rows: RawRow[],
    options: { dryRun: boolean }
  ): Promise<QuestionImportReport> {
    const lookup = await loadQuestionLookup(this.prisma)

    // Read once per file, not per row.
    const plan = await this.plans.forTenant(principal.tenantId)

    const results: QuestionRowResult[] = []
    const importable: Array<{ result: QuestionRowResult; data: Record<string, unknown> }> = []
    const translations = { hi: 0, gu: 0 }

    for (const raw of rows) {
      const result: QuestionRowResult = { lineNumber: raw.lineNumber, errors: [] }
      result.questionText = raw.values['question_en']?.slice(0, 80)

      const mapped = mapQuestionRow(raw, lookup)
      result.errors.push(...mapped.errors)

      if (mapped.errors.length === 0) {
        // Reuse the API's own schema rather than a parallel one: an importer
        // with looser rules is how invalid questions get into the bank.
        const parsed = createQuestionSchema.safeParse(mapped.input)
        if (!parsed.success) {
          result.errors.push(...zodRowErrors(parsed.error))
        } else if (!isFeatureAllowed(plan.questionTypes, parsed.data.type)) {
          // A row error, not a thrown 403: a Starter tenant's file of 50 MCQs
          // with two stray theory rows should import 48, and be told precisely
          // which two were refused and why.
          result.errors.push({
            field: 'type',
            message: `The ${plan.planCode} plan does not include ${parsed.data.type} questions (allowed: ${plan.questionTypes.join(', ')})`,
          })
        } else {
          importable.push({ result, data: parsed.data as unknown as Record<string, unknown> })
          if (mapped.input['questionTextHi']) translations.hi++
          if (mapped.input['questionTextGu']) translations.gu++
        }
      }

      results.push(result)
    }

    const report: QuestionImportReport = {
      dryRun: options.dryRun,
      totalRows: rows.length,
      valid: importable.length,
      invalid: results.length - importable.length,
      imported: 0,
      translations,
      rows: results,
    }

    /**
     * §4.3 capacity, spent down row by row.
     *
     * Deliberately NOT the employee importer's hard-fail. The asymmetry is the
     * point and it is not an oversight: questions are fungible and their rows
     * independent, so importing the first 380 of 500 is a coherent outcome and
     * the tenant keeps the work. People are not fungible — "which 50 of your 60
     * new hires exist" has no defensible answer, so that file is refused whole.
     *
     * Computed before the dryRun return so the preview tells the truth about
     * which rows a real run would reject.
     */
    let remaining = remainingCapacity(
      plan.maxQuestions,
      await this.plans.currentUsage('maxQuestions', principal.tenantId)
    )

    const withinCapacity: typeof importable = []
    for (const entry of importable) {
      if (remaining > 0) {
        remaining--
        withinCapacity.push(entry)
        continue
      }
      entry.result.errors.push({
        field: 'row',
        message: `Your plan allows ${plan.maxQuestions} questions and you are at the limit`,
      })
      report.valid--
      report.invalid++
    }

    if (options.dryRun) return report

    for (const { result, data } of withinCapacity) {
      try {
        const created = await this.insertOne(principal, data)
        result.questionId = created.id
        report.imported++
      } catch (err) {
        result.errors.push({
          field: 'row',
          message: err instanceof Error ? err.message : 'Failed to import',
        })
        report.valid--
        report.invalid++
      }
    }

    return report
  }

  /** One insert per row: a single bad row must not roll back the batch. */
  private async insertOne(principal: Principal, data: Record<string, unknown>) {
    return this.prisma.question.create({
      data: {
        ...(data as unknown as Prisma.QuestionUncheckedCreateInput),
        // Named explicitly so the compiler can confirm the NOT NULL columns are
        // written, rather than trusting an untyped bag of keys. The cast above
        // hides tenantId's absence from the compiler entirely, so it must be
        // stated here.
        tenantId: principal.tenantId,
        type: data['type'] as Prisma.QuestionUncheckedCreateInput['type'],
        departmentId: data['departmentId'] as string,
        questionTextEn: data['questionTextEn'] as string,
        // §10.2: imported questions are drafts and still need review.
        status: 'draft',
        createdById: principal.userId,
      },
      select: { id: true },
    })
  }
}

function zodRowErrors(error: ZodError): RowError[] {
  return error.issues.map((i) => ({
    field: i.path.join('.') || 'row',
    message: i.message,
  }))
}
