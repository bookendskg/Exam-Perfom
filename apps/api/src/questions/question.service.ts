import type { Prisma, PrismaClient } from '@bookends/db'
import {
  pageMeta,
  resolveLanguage,
  resolvedLanguageOf,
  type Language,
  type Scope,
} from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'
import { scopeToWhere, assertInScope, assertCreateInScope } from '../rbac/scope.js'
import { assertEditable, assertTransition } from './question-status.js'
import type {
  CreateQuestionInput,
  ListQuestionsQuery,
  UpdateQuestionInput,
} from './question.schemas.js'

const LIST_SELECT = {
  id: true,
  type: true,
  difficulty: true,
  status: true,
  marks: true,
  negativeMarks: true,
  topicId: true,
  departmentId: true,
  outletId: true,
  questionTextEn: true,
  questionTextHi: true,
  questionTextGu: true,
  tags: true,
  usageCount: true,
  createdById: true,
  createdAt: true,
} satisfies Prisma.QuestionSelect

export class QuestionService {
  constructor(private readonly prisma: PrismaClient) {}

  /** §5.3 GET /questions. */
  async list(principal: Principal, scope: Scope, query: ListQuestionsQuery) {
    // 'read' mode: an outlet_manager sees global (outletId NULL) questions as
    // well as their own outlet's. They just cannot edit the global ones.
    const scoped = scopeToWhere('question', scope, principal, 'read')

    const filters: Prisma.QuestionWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.difficulty ? { difficulty: query.difficulty } : {}),
      ...(query.topic_id ? { topicId: query.topic_id } : {}),
      ...(query.department_id ? { departmentId: query.department_id } : {}),
      ...(query.outlet_id ? { outletId: query.outlet_id } : {}),
      ...(query.status ? { status: query.status } : { status: { not: 'archived' } }),
      ...(query.search
        ? {
            OR: [
              { questionTextEn: { contains: query.search, mode: 'insensitive' } },
              { questionTextHi: { contains: query.search } },
              { questionTextGu: { contains: query.search } },
              { tags: { has: query.search } },
            ],
          }
        : {}),
      // §10.5: find questions still needing a translation. An empty string
      // counts as missing — an importer writes '' for a blank cell.
      ...(query.missing_translation === 'hi'
        ? { OR: [{ questionTextHi: null }, { questionTextHi: '' }] }
        : {}),
      ...(query.missing_translation === 'gu'
        ? { OR: [{ questionTextGu: null }, { questionTextGu: '' }] }
        : {}),
    }

    const where: Prisma.QuestionWhereInput = { AND: [scoped, filters] }

    const [rows, total] = await Promise.all([
      this.prisma.question.findMany({
        where,
        select: LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.question.count({ where }),
    ])

    return {
      rows: query.lang ? rows.map((r) => this.localise(r, query.lang!)) : rows,
      meta: pageMeta(query.page, query.limit, total),
    }
  }

  /** §5.3 GET /questions/:id. */
  async getById(principal: Principal, scope: Scope, id: string, lang?: Language) {
    const question = await this.prisma.question.findUnique({
      where: { id },
      include: {
        topic: { select: { id: true, nameEn: true, nameHi: true, nameGu: true } },
        department: { select: { id: true, name: true, code: true } },
        outlet: { select: { id: true, name: true, code: true } },
        sourceDocument: { select: { id: true, title: true, type: true } },
        createdBy: { select: { id: true, phone: true } },
        reviews: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            action: true,
            comments: true,
            createdAt: true,
            reviewer: { select: { id: true, phone: true } },
          },
        },
      },
    })
    if (!question) throw ApiError.notFound('Question not found')

    assertInScope(
      scope,
      principal,
      { outletId: question.outletId, createdById: question.createdById },
      'read'
    )

    return lang ? this.localise(question, lang) : question
  }

  /** §5.3 POST /questions. Always lands in DRAFT (§10.2). */
  async create(principal: Principal, scope: Scope, input: CreateQuestionInput) {
    // A trainer's scope is own_resource, which assertCreateInScope waves through
    // (ownership is stamped below, not supplied). An outlet_manager creating a
    // global question is caught here — see the note in the method.
    assertCreateInScope(scope, principal, { outletId: input.outletId ?? null })

    await this.assertRefsExist(input.topicId, input.departmentId, input.sourceDocumentId)

    return this.prisma.question.create({
      data: {
        ...(this.toColumns(input) as Prisma.QuestionUncheckedCreateInput),
        // Named explicitly, not left to the spread: these are the NOT NULL
        // columns, and stating them here is what lets the compiler confirm the
        // insert is complete rather than trusting an untyped bag of keys.
        type: input.type,
        departmentId: input.departmentId,
        questionTextEn: input.questionTextEn,
        // §10.2: everything starts as a draft, whoever wrote it.
        status: 'draft',
        createdById: principal.userId,
      },
      select: LIST_SELECT,
    })
  }

  /** §5.3 PUT /questions/:id. */
  async update(principal: Principal, scope: Scope, id: string, input: UpdateQuestionInput) {
    const existing = await this.prisma.question.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        status: true,
        outletId: true,
        createdById: true,
        marks: true,
      },
    })
    if (!existing) throw ApiError.notFound('Question not found')

    // 'write' mode: an outlet_manager cannot edit a global (outletId NULL)
    // question — doing so would silently change content for the other outlets.
    assertInScope(scope, principal, existing, 'write')
    assertEditable(existing.status)

    this.assertTypeFieldsMatch(existing.type, input)

    if (input.topicId || input.departmentId || input.sourceDocumentId) {
      await this.assertRefsExist(input.topicId, input.departmentId, input.sourceDocumentId)
    }

    // Moving a question INTO or OUT OF global scope is a scope change; an
    // outlet_manager must not be able to do either.
    if (input.outletId !== undefined) {
      assertCreateInScope(scope, principal, { outletId: input.outletId })
    }

    // The rubric is the mark scheme, so it must still total the question's
    // marks after a partial update that touches only one of the two.
    if (existing.type === 'video_image' && (input.rubric || input.marks !== undefined)) {
      await this.assertRubricTotals(id, input)
    }

    return this.prisma.question.update({
      where: { id },
      data: this.toColumns(input as Partial<CreateQuestionInput>),
      select: LIST_SELECT,
    })
  }

  /** §5.3 DELETE /questions/:id — archives rather than deletes. */
  async archive(principal: Principal, scope: Scope, id: string) {
    const existing = await this.prisma.question.findUnique({
      where: { id },
      select: { id: true, status: true, outletId: true, createdById: true, usageCount: true },
    })
    if (!existing) throw ApiError.notFound('Question not found')

    assertInScope(scope, principal, existing, 'write')
    assertTransition(existing.status, 'archived')

    // A hard delete would break exam_questions rows pointing at it — and with
    // them the responses staff already gave.
    return this.prisma.question.update({
      where: { id },
      data: { status: 'archived' },
      select: LIST_SELECT,
    })
  }

  /** §10.2: a draft is submitted for admin review. */
  async submitForReview(principal: Principal, scope: Scope, id: string) {
    const existing = await this.requireOwn(principal, scope, id)
    assertTransition(existing.status, 'pending_review')

    // A question with no English text cannot be reviewed. The create schema
    // enforces this, but an import may have produced one.
    if (!existing.questionTextEn?.trim()) {
      throw ApiError.validation('Cannot submit a question with no English text (§10.3)', [
        { field: 'questionTextEn', message: 'Required before review' },
      ])
    }

    return this.prisma.question.update({
      where: { id },
      data: { status: 'pending_review' },
      select: LIST_SELECT,
    })
  }

  /** §5.3 POST /questions/:id/approve. §3.2: super_admin and admin only. */
  async approve(principal: Principal, id: string, comments?: string) {
    const existing = await this.prisma.question.findUnique({
      where: { id },
      select: { id: true, status: true },
    })
    if (!existing) throw ApiError.notFound('Question not found')
    assertTransition(existing.status, 'approved')

    return this.prisma.$transaction(async (tx) => {
      const question = await tx.question.update({
        where: { id },
        data: {
          status: 'approved',
          approvedById: principal.userId,
          approvedAt: new Date(),
        },
        select: LIST_SELECT,
      })

      await tx.questionReview.create({
        data: {
          questionId: id,
          reviewerId: principal.userId,
          action: 'approved',
          comments: comments ?? null,
        },
      })

      return question
    })
  }

  /** §5.3 POST /questions/:id/reject — back to draft, with the reason recorded. */
  async reject(principal: Principal, id: string, comments: string) {
    const existing = await this.prisma.question.findUnique({
      where: { id },
      select: { id: true, status: true },
    })
    if (!existing) throw ApiError.notFound('Question not found')
    assertTransition(existing.status, 'draft')

    return this.prisma.$transaction(async (tx) => {
      const question = await tx.question.update({
        where: { id },
        // §4.1's enum has no `rejected`, and a rejected question IS a draft
        // needing work. The reason lives in the review row below.
        data: { status: 'draft', approvedById: null, approvedAt: null },
        select: LIST_SELECT,
      })

      await tx.questionReview.create({
        data: {
          questionId: id,
          reviewerId: principal.userId,
          action: 'rejected',
          comments,
        },
      })

      return question
    })
  }

  /** §10.5 question bank statistics. */
  async stats(principal: Principal, scope: Scope) {
    const where = scopeToWhere('question', scope, principal, 'read')

    const [byType, byDifficulty, byStatus, byDepartment, total, missingHi, missingGu, mostUsed] =
      await Promise.all([
        this.prisma.question.groupBy({ by: ['type'], where, _count: { _all: true } }),
        this.prisma.question.groupBy({ by: ['difficulty'], where, _count: { _all: true } }),
        this.prisma.question.groupBy({ by: ['status'], where, _count: { _all: true } }),
        this.prisma.question.groupBy({ by: ['departmentId'], where, _count: { _all: true } }),
        this.prisma.question.count({ where }),
        this.prisma.question.count({
          where: { AND: [where, { OR: [{ questionTextHi: null }, { questionTextHi: '' }] }] },
        }),
        this.prisma.question.count({
          where: { AND: [where, { OR: [{ questionTextGu: null }, { questionTextGu: '' }] }] },
        }),
        this.prisma.question.findMany({
          where,
          orderBy: { usageCount: 'desc' },
          take: 5,
          select: { id: true, questionTextEn: true, usageCount: true },
        }),
      ])

    const departments = await this.prisma.department.findMany({
      where: { id: { in: byDepartment.map((d) => d.departmentId) } },
      select: { id: true, name: true, code: true },
    })
    const departmentById = new Map(departments.map((d) => [d.id, d]))

    return {
      total,
      byType: countMap(byType, 'type'),
      byDifficulty: countMap(byDifficulty, 'difficulty'),
      byStatus: countMap(byStatus, 'status'),
      byDepartment: byDepartment.map((d) => ({
        department: departmentById.get(d.departmentId) ?? {
          id: d.departmentId,
          name: 'Unknown',
          code: '?',
        },
        count: d._count._all,
      })),
      pendingReview: countMap(byStatus, 'status')['pending_review'] ?? 0,
      // §10.5: "Questions without Hindi/Gujarati translations".
      missingTranslations: { hi: missingHi, gu: missingGu },
      mostUsed,
    }
  }

  // --- Helpers --------------------------------------------------------------

  /** Loads a question the caller may write to. */
  private async requireOwn(principal: Principal, scope: Scope, id: string) {
    const question = await this.prisma.question.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        outletId: true,
        createdById: true,
        questionTextEn: true,
      },
    })
    if (!question) throw ApiError.notFound('Question not found')
    assertInScope(scope, principal, question, 'write')
    return question
  }

  /**
   * `type` is immutable (the update schema has no field for it), so a payload
   * carrying another type's fields is a client bug — reject it rather than
   * silently writing options onto a theory question.
   */
  private assertTypeFieldsMatch(type: string, input: UpdateQuestionInput): void {
    const wrong: string[] = []
    if (type !== 'mcq' && (input.options || input.negativeMarks !== undefined)) {
      wrong.push('options', 'negativeMarks')
    }
    if (
      type !== 'theory' &&
      (input.minWordLimit !== undefined || input.maxWordLimit !== undefined)
    ) {
      wrong.push('minWordLimit', 'maxWordLimit')
    }
    if (type !== 'video_image' && (input.rubric || input.responseType)) {
      wrong.push('rubric', 'responseType')
    }

    if (wrong.length > 0) {
      throw ApiError.validation(`Those fields do not apply to a ${type} question`, [
        { field: wrong[0]!, message: `Not valid for a ${type} question` },
      ])
    }
  }

  private async assertRubricTotals(id: string, input: UpdateQuestionInput): Promise<void> {
    const current = await this.prisma.question.findUniqueOrThrow({
      where: { id },
      select: { marks: true, rubric: true },
    })

    const rubric = input.rubric ?? (current.rubric as Array<{ maxMarks: number }> | null) ?? []
    const marks = input.marks ?? Number(current.marks)
    const total = rubric.reduce((sum, c) => sum + Number(c.maxMarks), 0)

    if (Math.abs(total - marks) > 0.001) {
      throw ApiError.validation('The rubric no longer totals the question marks', [
        { field: 'rubric', message: `Criteria total ${total} but the question is worth ${marks}` },
      ])
    }
  }

  private async assertRefsExist(
    topicId?: string,
    departmentId?: string,
    sourceDocumentId?: string | null
  ): Promise<void> {
    const details: Array<{ field: string; message: string }> = []

    if (topicId) {
      const topic = await this.prisma.topic.findUnique({ where: { id: topicId } })
      if (!topic || !topic.isActive) details.push({ field: 'topicId', message: 'Unknown topic' })
    }
    if (departmentId) {
      const department = await this.prisma.department.findUnique({ where: { id: departmentId } })
      if (!department || !department.isActive) {
        details.push({ field: 'departmentId', message: 'Unknown department' })
      }
    }
    if (sourceDocumentId) {
      const document = await this.prisma.sourceDocument.findUnique({
        where: { id: sourceDocumentId },
      })
      if (!document || !document.isActive) {
        details.push({ field: 'sourceDocumentId', message: 'Unknown source document' })
      }
    }

    if (details.length > 0) throw ApiError.validation('Invalid references', details)
  }

  /** Maps the validated input onto Prisma columns, dropping undefined keys. */
  private toColumns(input: Partial<CreateQuestionInput> & Record<string, unknown>) {
    const data: Record<string, unknown> = {}
    const copy = (key: string, column = key) => {
      if (input[key] !== undefined) data[column] = input[key]
    }

    for (const key of [
      'type',
      'difficulty',
      'topicId',
      'departmentId',
      'outletId',
      'designationLevelMin',
      'designationLevelMax',
      'questionTextEn',
      'questionTextHi',
      'questionTextGu',
      'explanationEn',
      'explanationHi',
      'explanationGu',
      'instructionsEn',
      'instructionsHi',
      'instructionsGu',
      'imageUrl',
      'videoUrl',
      'audioUrl',
      'marks',
      'negativeMarks',
      'timeLimitSeconds',
      'expectedAnswerEn',
      'expectedAnswerHi',
      'expectedAnswerGu',
      'minWordLimit',
      'maxWordLimit',
      'responseType',
      'maxFileSizeMb',
      'maxVideoDurationSeconds',
      'sourceDocumentId',
      'sourceChapter',
      'sourcePage',
      'tags',
    ]) {
      copy(key)
    }

    // JSON columns: Prisma wants the value, not undefined.
    if (input['options'] !== undefined) data['options'] = input['options']
    if (input['rubric'] !== undefined) data['rubric'] = input['rubric']

    return data
  }

  /**
   * Collapses trilingual columns to the requested language (§6.2), reporting
   * which language actually came back — the APK needs it to pick a font (§6.3).
   */
  private localise<T extends Record<string, unknown>>(row: T, lang: Language) {
    const content = {
      en: String(row['questionTextEn'] ?? ''),
      hi: row['questionTextHi'] as string | null,
      gu: row['questionTextGu'] as string | null,
    }

    return {
      ...row,
      questionText: resolveLanguage(content, lang),
      questionTextLanguage: resolvedLanguageOf(content, lang),
    }
  }
}

function countMap<K extends string>(
  rows: Array<Record<string, unknown> & { _count: { _all: number } }>,
  key: K
): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [String(r[key]), r._count._all]))
}
