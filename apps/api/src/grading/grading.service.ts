import { Prisma } from '@bookends/db'
import type { PrismaClient, QuestionType } from '@bookends/db'
import { pageMeta, type Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'
import { scopeToWhere, assertInScope } from '../rbac/scope.js'
import { finaliseAssignment } from '../attempts/finalise.js'
import type {
  GradeTheoryInput,
  GradeRubricInput,
  OverrideInput,
  FinaliseInput,
  QueueQuery,
} from './grading.schemas.js'

/**
 * §3.2's grading workflow — Module 8.
 *
 * Module 7 auto-grades the MCQs on submit and stops. An attempt carrying a
 * theory or video answer lands in `submitted` with a NULL percentage, and
 * everything downstream — the candidate's result, §9's performance record, the
 * exam's pass rate — waits here. This module is what ends that wait.
 *
 * Scope is the candidate's outlet, not the exam's. §3.2 gives an outlet_manager
 * `own_outlet` on grading, and the two differ in practice: Exam.outletId is
 * nullable (a global exam belongs to no outlet), and assignment by explicit
 * employeeIds ignores the exam's outlet target entirely. Grading is about the
 * person being marked, so the filter follows the employee.
 */

/** Only a human's work belongs here; MCQs are settled before this module sees them. */
const MANUAL_TYPES: readonly QuestionType[] = ['theory', 'video_image']

/**
 * An attempt can be graded only once the candidate has finished with it.
 * `graded` is included so a mark can be corrected after the fact.
 */
const GRADABLE_STATUSES = ['submitted', 'graded'] as const

export class GradingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * §5.3 GET /grading/queue — what still needs a human.
   *
   * Scoped by the candidate's outlet through the relation, not filtered after
   * the fact, so `meta.total` counts only what this grader can actually see.
   */
  async queue(principal: Principal, scope: Scope, query: QueueQuery) {
    const employeeWhere = scopeToWhere('employee', scope, principal, 'read')

    const where: Prisma.ExamAssignmentWhereInput = {
      status: query.status === 'all' ? { in: [...GRADABLE_STATUSES] } : 'submitted',
      /**
       * Scope and caller filter are AND-ed, never merged.
       *
       * Spreading them into one object looks equivalent and is not: both
       * constrain `outletId`, so the caller's value replaces the scope's and an
       * outlet_manager passing ?outletId=<another outlet> reads a queue that is
       * not theirs. A filter may only ever narrow what scope already allows.
       */
      employee: {
        AND: [employeeWhere, ...(query.outletId ? [{ outletId: query.outletId }] : [])],
      },
      ...(query.examId ? { examId: query.examId } : {}),
      responses: {
        some: {
          responseType: query.type ? query.type : { in: [...MANUAL_TYPES] },
          // 'pending' means at least one manual answer is still unmarked.
          ...(query.status === 'all' ? {} : { marksObtained: null }),
        },
      },
    }

    const [rows, total] = await Promise.all([
      this.prisma.examAssignment.findMany({
        where,
        orderBy: [{ submittedAt: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          status: true,
          submittedAt: true,
          gradedAt: true,
          employee: {
            select: {
              id: true,
              employeeCode: true,
              firstName: true,
              lastName: true,
              outlet: { select: { id: true, name: true, code: true } },
              department: { select: { id: true, name: true } },
            },
          },
          exam: {
            select: {
              id: true,
              examCode: true,
              nameEn: true,
              nameHi: true,
              nameGu: true,
              totalMarks: true,
              scheduledDate: true,
            },
          },
          _count: {
            select: {
              responses: {
                where: { responseType: { in: [...MANUAL_TYPES] }, marksObtained: null },
              },
            },
          },
        },
      }),
      this.prisma.examAssignment.count({ where }),
    ])

    return {
      rows: rows.map(({ _count, ...row }) => ({ ...row, ungradedResponses: _count.responses })),
      meta: pageMeta(query.page, query.pageSize, total),
    }
  }

  /**
   * §5.3 GET /grading/assignments/:assignmentId — the grading screen.
   *
   * This is the mirror image of Module 7's paper: the candidate is shown the
   * question with the answer key stripped, while the grader needs the model
   * answer and the rubric to mark against. Both are returned here, which is
   * safe because §3.2 gives staff no grading permission at all — the route
   * gate refuses them before this runs.
   */
  async attempt(principal: Principal, scope: Scope, assignmentId: string) {
    const assignment = await this.loadAssignment(principal, scope, assignmentId)

    const responses = await this.prisma.examResponse.findMany({
      where: { examAssignmentId: assignmentId },
      orderBy: { examQuestion: { sortOrder: 'asc' } },
      select: {
        examQuestionId: true,
        responseType: true,
        selectedOptionId: true,
        theoryAnswer: true,
        theoryAnswerLanguage: true,
        mediaUrls: true,
        mediaType: true,
        isCorrect: true,
        isSkipped: true,
        marksObtained: true,
        maxMarks: true,
        isAutoGraded: true,
        graderComments: true,
        rubricScores: true,
        gradedAt: true,
        gradedBy: { select: { id: true, phone: true } },
        question: {
          select: {
            id: true,
            type: true,
            questionTextEn: true,
            questionTextHi: true,
            questionTextGu: true,
            // The grader's side of the paper: model answer and mark scheme.
            expectedAnswerEn: true,
            expectedAnswerHi: true,
            expectedAnswerGu: true,
            explanationEn: true,
            rubric: true,
            minWordLimit: true,
            maxWordLimit: true,
          },
        },
      },
    })

    return {
      assignment: {
        id: assignment.id,
        status: assignment.status,
        submittedAt: assignment.submittedAt,
        gradedAt: assignment.gradedAt,
        totalMarksObtained: assignment.totalMarksObtained,
        percentage: assignment.percentage,
        grade: assignment.grade,
        passed: assignment.passed,
        supervisorRemarks: assignment.supervisorRemarks,
        employee: assignment.employee,
        exam: assignment.exam,
      },
      responses,
      ungraded: responses.filter(
        (r) => MANUAL_TYPES.includes(r.responseType) && r.marksObtained === null
      ).length,
    }
  }

  /** §5.3 PUT /grading/assignments/:id/theory/:examQuestionId. */
  async gradeTheory(
    principal: Principal,
    scope: Scope,
    assignmentId: string,
    examQuestionId: string,
    input: GradeTheoryInput
  ) {
    return this.applyMark(principal, scope, assignmentId, examQuestionId, {
      expectType: 'theory',
      marksObtained: input.marksObtained,
      graderComments: input.graderComments ?? null,
    })
  }

  /** §5.3 PUT /grading/assignments/:id/rubric/:examQuestionId. */
  async gradeRubric(
    principal: Principal,
    scope: Scope,
    assignmentId: string,
    examQuestionId: string,
    input: GradeRubricInput
  ) {
    return this.applyMark(principal, scope, assignmentId, examQuestionId, {
      expectType: 'video_image',
      rubricScores: input.rubricScores,
      graderComments: input.graderComments ?? null,
    })
  }

  /**
   * §5.3 PUT /grading/assignments/:id/responses/:examQuestionId/override.
   *
   * §3.2 gives this to super_admin and admin alone — not even an outlet_manager,
   * who may grade their own outlet's theory answers. The difference is what it
   * can reach: this is the only path that may change an AUTO-graded MCQ mark,
   * which is how a wrong answer key gets corrected after staff have sat the
   * exam.
   */
  async override(
    principal: Principal,
    scope: Scope,
    assignmentId: string,
    examQuestionId: string,
    input: OverrideInput
  ) {
    return this.applyMark(principal, scope, assignmentId, examQuestionId, {
      marksObtained: input.marksObtained,
      graderComments: input.graderComments,
      isOverride: true,
    })
  }

  /**
   * §5.3 POST /grading/assignments/:id/finalise.
   *
   * Explicit rather than automatic on the last mark. A grader works through an
   * attempt over minutes, sometimes across sessions, and revises earlier marks
   * as they go; finalising the instant the last box is filled would publish a
   * result they were still working on. It also gives them one place to attach
   * §4.1's supervisor remarks.
   *
   * Finalising is idempotent and re-runnable: it recomputes from whatever the
   * responses currently say, so correcting a mark afterwards and finalising
   * again produces the right result rather than a stale one.
   */
  async finalise(principal: Principal, scope: Scope, assignmentId: string, input: FinaliseInput) {
    const assignment = await this.loadAssignment(principal, scope, assignmentId)
    const now = this.now()

    const summary = await this.prisma.$transaction(async (tx) => {
      await this.lockAssignment(tx, assignmentId)

      if (input.supervisorRemarks !== undefined && input.supervisorRemarks !== null) {
        await tx.examAssignment.update({
          where: { id: assignmentId },
          data: { supervisorRemarks: input.supervisorRemarks },
        })
      }

      return finaliseAssignment(tx, {
        assignmentId,
        examId: assignment.exam.id,
        totalMarks: Number(assignment.exam.totalMarks),
        passingPercentage: Number(assignment.exam.passingPercentage),
        at: now,
        gradedById: principal.userId,
      })
    })

    /**
     * Not an error when marks are still missing — a grader may legitimately
     * finalise what they have and come back. The response says so plainly
     * instead, and the assignment stays in `submitted`.
     */
    return {
      assignmentId,
      status: summary.awaitingManualGrading ? 'submitted' : 'graded',
      awaitingManualGrading: summary.awaitingManualGrading,
      ...(summary.awaitingManualGrading
        ? { message: 'Some answers are still unmarked; the result is not released yet' }
        : {
            totalMarksObtained: summary.totalMarksObtained,
            percentage: summary.percentage,
            grade: summary.grade,
            passed: summary.passed,
          }),
    }
  }

  // -------------------------------------------------------------------------

  /**
   * The one write path, shared by both grading endpoints and by override.
   *
   * Everything type-specific is decided by the caller; what is common — scope,
   * status, bounds, locking, and the audit columns — happens once here, so a
   * future third grading mode cannot quietly skip one of them.
   */
  private async applyMark(
    principal: Principal,
    scope: Scope,
    assignmentId: string,
    examQuestionId: string,
    op: {
      expectType?: QuestionType
      marksObtained?: number
      rubricScores?: Record<string, number>
      graderComments: string | null
      isOverride?: boolean
    }
  ) {
    const assignment = await this.loadAssignment(principal, scope, assignmentId)
    const now = this.now()

    const response = await this.prisma.examResponse.findUnique({
      where: {
        examAssignmentId_examQuestionId: { examAssignmentId: assignmentId, examQuestionId },
      },
      select: {
        id: true,
        responseType: true,
        maxMarks: true,
        question: { select: { rubric: true } },
      },
    })
    if (!response) throw ApiError.notFound('That question is not part of this attempt')

    /**
     * A theory endpoint must not mark a video answer, and neither may touch an
     * MCQ — §3.2 splits the permission by type, so allowing it would let a
     * trainer with only `grading:theory` reach work the matrix did not give
     * them. Override is exempt: reaching an auto-graded MCQ is its purpose.
     */
    if (op.expectType && response.responseType !== op.expectType) {
      throw ApiError.validation(
        `This is a ${response.responseType} answer; use the ${response.responseType} endpoint`,
        [{ field: 'examQuestionId', message: `Expected ${op.expectType}` }]
      )
    }
    if (!op.isOverride && !MANUAL_TYPES.includes(response.responseType)) {
      throw ApiError.validation('Multiple-choice answers are graded automatically', [
        { field: 'examQuestionId', message: 'Use the override endpoint to correct an MCQ' },
      ])
    }

    const maxMarks = Number(response.maxMarks)
    const marks = op.rubricScores
      ? this.rubricTotal(op.rubricScores, response.question.rubric, maxMarks)
      : (op.marksObtained ?? 0)

    /**
     * The exam's own marks for that question are the ceiling. Awarding more
     * would push the candidate's percentage above 100 and break §9's snapshots
     * and every chart built on them.
     */
    if (marks > maxMarks) {
      throw ApiError.validation(`This question is worth ${maxMarks} marks`, [
        { field: 'marksObtained', message: `${marks} exceeds the maximum of ${maxMarks}` },
      ])
    }

    await this.prisma.$transaction(async (tx) => {
      await this.lockAssignment(tx, assignmentId)

      await tx.examResponse.update({
        where: { id: response.id },
        data: {
          marksObtained: new Prisma.Decimal(marks),
          graderComments: op.graderComments,
          ...(op.rubricScores ? { rubricScores: op.rubricScores } : {}),
          // No longer the machine's answer, whichever way it was set before.
          isAutoGraded: false,
          gradedById: principal.userId,
          gradedAt: now,
        },
      })

      /**
       * Regrading an assignment that was already finalised has to reopen it:
       * the stored percentage now describes marks that no longer exist. Rather
       * than patching the total, re-run the same finalisation the grader would,
       * which recomputes everything and demotes the row to `submitted` if the
       * change left something unmarked.
       */
      if (assignment.status === 'graded') {
        await finaliseAssignment(tx, {
          assignmentId,
          examId: assignment.exam.id,
          totalMarks: Number(assignment.exam.totalMarks),
          passingPercentage: Number(assignment.exam.passingPercentage),
          at: now,
          gradedById: principal.userId,
        })
      }
    })

    return {
      examQuestionId,
      marksObtained: marks,
      maxMarks,
      graderComments: op.graderComments,
      ...(op.rubricScores ? { rubricScores: op.rubricScores } : {}),
      gradedAt: now,
    }
  }

  /**
   * §10.1's rubric is the mark scheme, so a score is checked against it rather
   * than merely summed: a criterion the question does not define is a client
   * bug or a stale grading screen, and silently accepting it would put marks
   * against a criterion nobody can explain.
   *
   * The per-criterion ceilings are NOT re-derived from the question's marks —
   * `maxMarks` on the response is the exam's figure for that question, which
   * may differ from the question bank's default, and the caller checks the
   * total against it.
   */
  private rubricTotal(scores: Record<string, number>, rubric: unknown, maxMarks: number): number {
    const criteria = rubricCriteria(rubric)
    if (criteria.length === 0) {
      throw ApiError.validation('This question has no rubric to grade against', [
        { field: 'rubricScores', message: 'The question defines no criteria' },
      ])
    }

    const known = new Map(criteria.map((c) => [c.criterion, c.maxMarks]))
    const details: Array<{ field: string; message: string }> = []

    for (const [criterion, awarded] of Object.entries(scores)) {
      const ceiling = known.get(criterion)
      if (ceiling === undefined) {
        details.push({ field: 'rubricScores', message: `Unknown criterion "${criterion}"` })
        continue
      }
      if (awarded > ceiling) {
        details.push({
          field: 'rubricScores',
          message: `"${criterion}" is worth at most ${ceiling}, got ${awarded}`,
        })
      }
    }

    if (details.length > 0) {
      throw ApiError.validation('The rubric scores do not match this question', details)
    }

    const total = Object.values(scores).reduce((sum, n) => sum + n, 0)
    // Rounded here so the number stored matches the number returned, exactly as
    // Module 7's grading does.
    const rounded = Math.round((total + Number.EPSILON) * 100) / 100
    return Math.min(rounded, maxMarks)
  }

  /**
   * Loads the assignment and proves the caller may act on it.
   *
   * Scope is asserted against the candidate's outlet. `assertInScope` throws
   * NOT_FOUND rather than FORBIDDEN on a miss, which is what stops an
   * outlet_manager confirming another outlet's assignment exists by probing ids.
   */
  private async loadAssignment(principal: Principal, scope: Scope, assignmentId: string) {
    const assignment = await this.prisma.examAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        status: true,
        submittedAt: true,
        gradedAt: true,
        totalMarksObtained: true,
        percentage: true,
        grade: true,
        passed: true,
        supervisorRemarks: true,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            outletId: true,
            outlet: { select: { id: true, name: true, code: true } },
          },
        },
        exam: {
          select: {
            id: true,
            examCode: true,
            nameEn: true,
            nameHi: true,
            nameGu: true,
            status: true,
            totalMarks: true,
            passingPercentage: true,
          },
        },
      },
    })
    if (!assignment) throw ApiError.notFound('Exam assignment not found')

    assertInScope(scope, principal, { outletId: assignment.employee.outletId }, 'write')

    if (!(GRADABLE_STATUSES as readonly string[]).includes(assignment.status)) {
      throw ApiError.conflict(`A ${assignment.status} attempt cannot be graded`, [
        {
          field: 'status',
          message:
            assignment.status === 'absent' || assignment.status === 'exempted'
              ? 'This candidate did not sit the exam'
              : 'The candidate has not submitted it yet',
        },
      ])
    }

    return assignment
  }

  /**
   * Serialises graders on one attempt.
   *
   * Two people marking the same paper is normal — a trainer and a manager
   * reviewing together — and without this the second finalise can read the
   * responses before the first has committed, then write a total that omits
   * the other's mark. Postgres runs these transactions at READ COMMITTED, so
   * an explicit row lock is what makes the read-then-write sequence safe;
   * nothing on ExamAssignment carries a version column to check instead.
   */
  private async lockAssignment(tx: Prisma.TransactionClient, assignmentId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM exam_assignments WHERE id = ${assignmentId}::uuid FOR UPDATE`
  }
}

/** §10.1's stored rubric: [{ criterion, maxMarks, description }]. */
function rubricCriteria(raw: unknown): Array<{ criterion: string; maxMarks: number }> {
  if (!Array.isArray(raw)) return []

  const out: Array<{ criterion: string; maxMarks: number }> = []
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const { criterion, maxMarks } = entry as { criterion?: unknown; maxMarks?: unknown }
      if (typeof criterion === 'string' && typeof maxMarks === 'number') {
        out.push({ criterion, maxMarks })
      }
    }
  }
  return out
}
