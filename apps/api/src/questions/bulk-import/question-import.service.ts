import type { Prisma, PrismaClient } from '@bookends/db'
import type { ZodError } from 'zod'
import type { Principal } from '../../infra/session-store/index.js'
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
  constructor(private readonly prisma: PrismaClient) {}

  async run(
    principal: Principal,
    rows: RawRow[],
    options: { dryRun: boolean }
  ): Promise<QuestionImportReport> {
    const lookup = await loadQuestionLookup(this.prisma)

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

    if (options.dryRun) return report

    for (const { result, data } of importable) {
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
