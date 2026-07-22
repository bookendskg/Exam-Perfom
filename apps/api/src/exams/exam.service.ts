import type { Prisma, PrismaClient } from '@bookends/db'
import { pageMeta, type Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'
import { scopeToWhere, assertInScope, assertCreateInScope } from '../rbac/scope.js'
import { claimExamCode } from './exam-code.js'
import { QuestionSelector, sumMarks } from './question-selection.js'
import { PublishValidator } from './publish-validation.js'
import type {
  AssignInput,
  CreateExamInput,
  ListExamsQuery,
  UpdateExamInput,
} from './exam.schemas.js'

const EXAM_SELECT = {
  id: true,
  examCode: true,
  templateId: true,
  nameEn: true,
  nameHi: true,
  nameGu: true,
  scheduledDate: true,
  startTime: true,
  endTime: true,
  outletId: true,
  departmentId: true,
  designationId: true,
  totalMarks: true,
  passingPercentage: true,
  durationMinutes: true,
  status: true,
  isAutoScheduled: true,
  totalAssigned: true,
  createdById: true,
} satisfies Prisma.ExamSelect

/**
 * §11 exam builder.
 *
 * Once an exam is published (scheduled), its question set is frozen. Staff may
 * already have been notified, and §12.3 sends reminders days ahead — changing
 * the questions underneath that is how someone sits a different exam from the
 * one they were told about.
 */
const EDITABLE_STATUSES = ['draft'] as const

/** §4.1 stores start_time/end_time as TIME; Prisma round-trips them on 1970-01-01. */
const clockTimeToDate = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`)

/** 'HH:MM' from a stored TIME, for comparing an incoming value against a stored one. */
const clockTimeToString = (time: Date) =>
  `${String(time.getUTCHours()).padStart(2, '0')}:${String(time.getUTCMinutes()).padStart(2, '0')}`

export class ExamService {
  private readonly selector: QuestionSelector
  private readonly validator: PublishValidator

  constructor(private readonly prisma: PrismaClient) {
    this.selector = new QuestionSelector(prisma)
    this.validator = new PublishValidator(prisma)
  }

  async list(principal: Principal, scope: Scope, query: ListExamsQuery) {
    const scoped = scopeToWhere('exam', scope, principal, 'read')

    const filters: Prisma.ExamWhereInput = {
      ...(query.status ? { status: query.status } : { status: { not: 'archived' } }),
      ...(query.outlet_id ? { outletId: query.outlet_id } : {}),
      ...(query.from_date || query.to_date
        ? {
            scheduledDate: {
              ...(query.from_date ? { gte: new Date(query.from_date) } : {}),
              ...(query.to_date ? { lte: new Date(query.to_date) } : {}),
            },
          }
        : {}),
    }

    const where: Prisma.ExamWhereInput = { AND: [scoped, filters] }

    const [rows, total] = await Promise.all([
      this.prisma.exam.findMany({
        where,
        select: EXAM_SELECT,
        orderBy: { scheduledDate: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.exam.count({ where }),
    ])

    return { rows, meta: pageMeta(query.page, query.limit, total) }
  }

  async getById(principal: Principal, scope: Scope, id: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      include: {
        template: { select: { id: true, nameEn: true } },
        outlet: { select: { id: true, name: true, code: true } },
        department: { select: { id: true, name: true, code: true } },
        designation: { select: { id: true, name: true, code: true, level: true } },
        examQuestions: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            sortOrder: true,
            marks: true,
            question: {
              select: {
                id: true,
                type: true,
                difficulty: true,
                status: true,
                questionTextEn: true,
                topicId: true,
              },
            },
          },
        },
        _count: { select: { assignments: true } },
      },
    })
    if (!exam) throw ApiError.notFound('Exam not found')

    assertInScope(
      scope,
      principal,
      { outletId: exam.outletId, createdById: exam.createdById },
      'read'
    )
    return exam
  }

  /** §11.1 — create from a template or from scratch. */
  async create(principal: Principal, scope: Scope, input: CreateExamInput) {
    assertCreateInScope(scope, principal, { outletId: input.outletId ?? null })

    const template = input.templateId ? await this.loadTemplate(input.templateId) : null

    // §11.1 step 1: the template supplies defaults, the request overrides them.
    const outletId = input.outletId ?? template?.outletId ?? null
    const departmentId = input.departmentId ?? template?.departmentId ?? null
    const designationId = input.designationId ?? template?.designationId ?? null
    const durationMinutes = input.durationMinutes ?? template?.durationMinutes ?? 60
    const passingPercentage = input.passingPercentage ?? Number(template?.passingPercentage ?? 40)

    const scheduledDate = new Date(`${input.scheduledDate}T00:00:00.000Z`)

    // §11.1 step 4: rules, manual picks, or both.
    const rules = input.questionSelection ?? (template?.questionSelection as never) ?? null
    const designationLevel = designationId
      ? (await this.prisma.designation.findUnique({ where: { id: designationId } }))?.level
      : undefined

    const selected = rules
      ? await this.selector.select(rules, {
          outletId,
          departmentId,
          ...(designationLevel !== undefined ? { designationLevel } : {}),
        })
      : { questions: [], shortfalls: [] }

    const manual = input.questionIds?.length
      ? await this.loadManualQuestions(
          input.questionIds,
          selected.questions.map((q) => q.id)
        )
      : []

    const questions = [...selected.questions, ...manual]

    // The exam's declared total must equal what its questions actually add up
    // to (§11.3). Deriving it when unstated beats storing a number the publish
    // check will reject.
    const declared = input.totalMarks ?? Number(template?.totalMarks ?? 0)
    const totalMarks = declared > 0 ? declared : sumMarks(questions)

    const exam = await this.prisma.$transaction(async (tx) => {
      // Claimed inside the transaction so a failed insert rolls the counter
      // back rather than burning a code.
      const examCode = await claimExamCode(tx, scheduledDate)

      const created = await tx.exam.create({
        data: {
          templateId: template?.id ?? null,
          examCode,
          nameEn: input.nameEn,
          nameHi: input.nameHi ?? null,
          nameGu: input.nameGu ?? null,
          scheduledDate,
          startTime: new Date(`1970-01-01T${input.startTime}:00.000Z`),
          endTime: new Date(`1970-01-01T${input.endTime}:00.000Z`),
          outletId,
          departmentId,
          designationId,
          totalMarks,
          passingPercentage,
          durationMinutes,
          shuffleQuestions: input.shuffleQuestions ?? template?.shuffleQuestions ?? true,
          shuffleOptions: input.shuffleOptions ?? template?.shuffleOptions ?? true,
          showResultImmediately:
            input.showResultImmediately ?? template?.showResultImmediately ?? false,
          allowReview: input.allowReview ?? template?.allowReview ?? false,
          allowBackNavigation: input.allowBackNavigation ?? template?.allowBackNavigation ?? true,
          // §11.1 step 8: nothing is live until it is published.
          status: 'draft',
          createdById: principal.userId,
        },
        select: EXAM_SELECT,
      })

      if (questions.length > 0) {
        await tx.examQuestion.createMany({
          data: questions.map((q, i) => ({
            examId: created.id,
            questionId: q.id,
            sortOrder: i,
            marks: q.marks,
          })),
        })
        // §10.5's "most-used questions" report depends on this staying accurate.
        await tx.question.updateMany({
          where: { id: { in: questions.map((q) => q.id) } },
          data: { usageCount: { increment: 1 } },
        })
      }

      return created
    })

    // §11.1 step 6: assign everyone matching the target unless told otherwise.
    const assigned =
      input.employeeIds?.length || input.autoAssign !== false
        ? await this.assignEmployees(
            exam.id,
            input.employeeIds,
            { outletId, departmentId, designationId },
            principal,
            scope
          )
        : 0

    return {
      exam: { ...exam, totalAssigned: assigned },
      // Surfaced, not thrown: §11.1 is a build flow, and an unsatisfiable rule
      // is something to fix before publishing rather than a reason to refuse
      // the draft. §11.3 blocks the publish itself.
      shortfalls: selected.shortfalls,
    }
  }

  async update(principal: Principal, scope: Scope, id: string, input: UpdateExamInput) {
    const existing = await this.requireEditable(principal, scope, id)

    /**
     * createExamSchema rejects a window that ends before it starts, but
     * updateExamSchema cannot: a PATCH sending only startTime has no endTime to
     * compare against, because a schema never sees the stored row. So the check
     * lives here, against the merged values, where both are available. That
     * also subsumes the both-fields-sent case, which is why the schema is left
     * alone rather than given a partial copy of this rule.
     *
     * §11.3 does refuse to publish a negative window, so this is not the only
     * thing standing between an inverted window and a candidate. It is worth
     * having anyway: without it the invalid state persists, and the complaint
     * arrives at publish time attributed to endTime rather than to the request
     * that actually broke it.
     */
    const startTime = input.startTime ?? clockTimeToString(existing.startTime)
    const endTime = input.endTime ?? clockTimeToString(existing.endTime)
    if (startTime >= endTime) {
      // Lexical comparison is safe on zero-padded HH:MM, as on create.
      throw ApiError.validation('The exam window must end after it starts', [
        {
          field: input.endTime !== undefined ? 'endTime' : 'startTime',
          message: `The window would run ${startTime} to ${endTime}`,
        },
      ])
    }

    return this.prisma.exam.update({
      where: { id: existing.id },
      data: {
        ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
        ...(input.nameHi !== undefined ? { nameHi: input.nameHi } : {}),
        ...(input.nameGu !== undefined ? { nameGu: input.nameGu } : {}),
        ...(input.scheduledDate !== undefined
          ? { scheduledDate: new Date(`${input.scheduledDate}T00:00:00.000Z`) }
          : {}),
        ...(input.startTime !== undefined ? { startTime: clockTimeToDate(input.startTime) } : {}),
        ...(input.endTime !== undefined ? { endTime: clockTimeToDate(input.endTime) } : {}),
        ...(input.totalMarks !== undefined ? { totalMarks: input.totalMarks } : {}),
        ...(input.passingPercentage !== undefined
          ? { passingPercentage: input.passingPercentage }
          : {}),
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.shuffleQuestions !== undefined
          ? { shuffleQuestions: input.shuffleQuestions }
          : {}),
        ...(input.shuffleOptions !== undefined ? { shuffleOptions: input.shuffleOptions } : {}),
        ...(input.showResultImmediately !== undefined
          ? { showResultImmediately: input.showResultImmediately }
          : {}),
        ...(input.allowReview !== undefined ? { allowReview: input.allowReview } : {}),
        ...(input.allowBackNavigation !== undefined
          ? { allowBackNavigation: input.allowBackNavigation }
          : {}),
      },
      select: EXAM_SELECT,
    })
  }

  /** §11.3 dry run — the "Review" half of §11.1 step 8. */
  async validate(principal: Principal, scope: Scope, id: string) {
    await this.getById(principal, scope, id)
    return this.validator.validate(id)
  }

  /** §5.3 POST /exams/:id/publish — draft → scheduled. */
  async publish(principal: Principal, scope: Scope, id: string) {
    const existing = await this.requireEditable(principal, scope, id)

    const validation = await this.validator.validate(id)
    if (!validation.canPublish) {
      throw ApiError.validation('This exam cannot be published yet (§11.3)', validation.errors)
    }

    const exam = await this.prisma.exam.update({
      where: { id: existing.id },
      data: { status: 'scheduled' },
      select: EXAM_SELECT,
    })

    // §11.3 warnings do not block, so they ride along with the response —
    // publishing an untranslated exam should be a visible choice.
    return { exam, warnings: validation.warnings }
  }

  /** §5.3 POST /exams/:id/cancel. */
  async cancel(principal: Principal, scope: Scope, id: string, reason?: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      select: { id: true, status: true, outletId: true, createdById: true },
    })
    if (!exam) throw ApiError.notFound('Exam not found')
    assertInScope(scope, principal, exam, 'write')

    if (exam.status === 'completed') {
      throw ApiError.conflict('A completed exam cannot be cancelled', [
        { field: 'status', message: 'Staff have already sat it; their results would be orphaned' },
      ])
    }
    if (exam.status === 'cancelled') {
      throw ApiError.validation('Exam is already cancelled')
    }

    return this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.exam.update({
        where: { id },
        data: { status: 'cancelled' },
        select: EXAM_SELECT,
      })

      // Anyone who had not started is marked exempted rather than absent —
      // they did not miss it, it was withdrawn, and §9 must not count it
      // against them.
      await tx.examAssignment.updateMany({
        where: { examId: id, status: { in: ['assigned', 'notified'] } },
        data: { status: 'exempted', supervisorRemarks: reason ?? 'Exam cancelled' },
      })

      return cancelled
    })
  }

  /** §5.3 POST /exams/:id/assign. */
  async assign(principal: Principal, scope: Scope, id: string, input: AssignInput) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        outletId: true,
        departmentId: true,
        designationId: true,
        createdById: true,
      },
    })
    if (!exam) throw ApiError.notFound('Exam not found')
    assertInScope(scope, principal, exam, 'write')

    if (['completed', 'cancelled', 'archived'].includes(exam.status)) {
      throw ApiError.conflict(`Cannot assign staff to a ${exam.status} exam`)
    }

    const count = await this.assignEmployees(
      id,
      input.employeeIds,
      {
        outletId: exam.outletId,
        departmentId: exam.departmentId,
        designationId: exam.designationId,
      },
      principal,
      scope
    )

    return { assigned: count }
  }

  async assignments(principal: Principal, scope: Scope, id: string) {
    await this.getById(principal, scope, id)

    return this.prisma.examAssignment.findMany({
      // Scoped on the *candidate*, not only on the exam.
      //
      // Checking the exam alone was not enough: a global exam (outletId null)
      // is readable by every manager, and any assignment rows attached to it —
      // however they got there — were returned in full, including foreign
      // employees' names, codes, outlets and results.
      where: { examId: id, employee: scopeToWhere('employee', scope, principal, 'read') },
      orderBy: { employee: { employeeCode: 'asc' } },
      select: {
        id: true,
        status: true,
        notifiedAt: true,
        startedAt: true,
        submittedAt: true,
        totalMarksObtained: true,
        percentage: true,
        grade: true,
        passed: true,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            outletId: true,
            preferredLanguage: true,
          },
        },
      },
    })
  }

  // --- Helpers --------------------------------------------------------------

  /**
   * §11.1 step 6: "All active employees matching outlet/department/designation,
   * OR manual selection".
   */
  private async assignEmployees(
    examId: string,
    employeeIds: string[] | undefined,
    target: {
      outletId?: string | null
      departmentId?: string | null
      designationId?: string | null
    },
    principal: Principal,
    scope: Scope
  ): Promise<number> {
    const where: Prisma.EmployeeWhereInput = employeeIds?.length
      ? { id: { in: employeeIds } }
      : {
          ...(target.outletId ? { outletId: target.outletId } : {}),
          ...(target.departmentId ? { departmentId: target.departmentId } : {}),
          ...(target.designationId ? { designationId: target.designationId } : {}),
        }

    /**
     * The caller's own scope, AND-ed — never merged.
     *
     * `employeeIds` is caller-supplied and was previously honoured verbatim, so
     * an outlet_manager could name employees of outlets they do not manage and
     * write ExamAssignment rows for them: staff in another outlet were notified
     * of, and required to sit, an exam authored outside their outlet. The same
     * ids then leaked back through GET /exams/:id/assignments — name, code,
     * outlet, percentage, grade — and POST /exams/:id/cancel would overwrite
     * their supervisorRemarks.
     *
     * Out-of-scope ids are filtered out rather than rejected: erroring would
     * confirm which employee ids exist, and the method already silently skips
     * departed staff, so silence is the consistent behaviour.
     */
    const scoped = scopeToWhere('employee', scope, principal, 'write')

    const employees = await this.prisma.employee.findMany({
      // §11.3 requires assigned employees be active. Filtering here rather than
      // failing at publish means an explicit id list silently skips a departed
      // employee instead of blocking the whole exam.
      where: { AND: [where, scoped, { employmentStatus: 'active' }] },
      select: { id: true },
    })

    if (employees.length === 0) return 0

    const created = await this.prisma.examAssignment.createMany({
      data: employees.map((e) => ({ examId, employeeId: e.id })),
      // exam_assignments is UNIQUE(exam_id, employee_id) — re-assigning is a
      // no-op, not an error, so an admin can safely re-run it after adding staff.
      skipDuplicates: true,
    })

    const total = await this.prisma.examAssignment.count({ where: { examId } })
    await this.prisma.exam.update({ where: { id: examId }, data: { totalAssigned: total } })

    return created.count
  }

  private async loadTemplate(templateId: string) {
    const template = await this.prisma.examTemplate.findUnique({ where: { id: templateId } })
    if (!template || !template.isActive) {
      throw ApiError.validation('Unknown exam template', [
        { field: 'templateId', message: 'No such active template' },
      ])
    }
    return template
  }

  /** §11.1 step 4's manual picks, validated the same way auto-selection is. */
  private async loadManualQuestions(ids: string[], alreadySelected: string[]) {
    const fresh = ids.filter((id) => !alreadySelected.includes(id))
    if (fresh.length === 0) return []

    const questions = await this.prisma.question.findMany({
      where: { id: { in: fresh } },
      select: { id: true, marks: true, type: true, status: true },
    })

    const missing = fresh.filter((id) => !questions.some((q) => q.id === id))
    if (missing.length > 0) {
      throw ApiError.validation('Unknown question', [
        { field: 'questionIds', message: `No such question: ${missing.join(', ')}` },
      ])
    }

    // §11.3 forbids unapproved questions in an exam. Rejecting at selection
    // beats letting a draft in and failing at publish with no clue which one.
    const unapproved = questions.filter((q) => q.status !== 'approved')
    if (unapproved.length > 0) {
      throw ApiError.validation('Only approved questions can be added to an exam (§11.3)', [
        {
          field: 'questionIds',
          message: `${unapproved.length} of the chosen questions are not approved`,
        },
      ])
    }

    return questions.map((q) => ({ id: q.id, marks: Number(q.marks), type: q.type }))
  }

  private async requireEditable(principal: Principal, scope: Scope, id: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      // startTime/endTime are selected for update()'s window check, which has to
      // compare an incoming value against the stored one it would replace.
      select: {
        id: true,
        status: true,
        outletId: true,
        createdById: true,
        startTime: true,
        endTime: true,
      },
    })
    if (!exam) throw ApiError.notFound('Exam not found')
    assertInScope(scope, principal, exam, 'write')

    if (!(EDITABLE_STATUSES as readonly string[]).includes(exam.status)) {
      throw ApiError.conflict(`A ${exam.status} exam cannot be edited`, [
        {
          field: 'status',
          message:
            exam.status === 'scheduled'
              ? 'Staff have been notified of this exam. Cancel it and build a new one.'
              : `Only draft exams are editable`,
        },
      ])
    }

    return exam
  }
}
