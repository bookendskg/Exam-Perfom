import type { Prisma, PrismaClient } from '@bookends/db'
import { currentTenantId } from '@bookends/db'
import { pageMeta, type Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'
import { gradeFor } from '../staff-exams/staff-exam.service.js'
import type { FinalizeInput, GradeInput, PendingQuery } from './grading.schemas.js'

/**
 * §14 grading and evaluation.
 *
 * MCQs are already scored by Module 7 (§10.1 "Auto-graded instantly"). This
 * module handles the two types that need a human: theory and video/image.
 *
 * Unlike the staff-facing exam API — which goes to great lengths NOT to send
 * the answer key — a grader is exactly who the model answer and rubric are for.
 * The asymmetry is the point, and it is enforced by `grading:*` permissions,
 * which §3.2 denies to staff and hr.
 */

interface RubricCriterion {
  criterion: string
  maxMarks: number
  description?: string
}

export class GradingService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * §5.3 GET /grading/pending — the queue.
   *
   * Lists RESPONSES rather than assignments: a grader works through answers,
   * and one submitted paper can hold several that need marking.
   */
  async pending(principal: Principal, scope: Scope, query: PendingQuery) {
    const where: Prisma.ExamResponseWhereInput = {
      // Auto-graded MCQs are done. Anything still unmarked is ours.
      marksObtained: null,
      responseType: query.type ?? { in: ['theory', 'video_image'] },
      examAssignment: {
        // A paper still being sat is not ready to mark.
        status: 'submitted',
        ...(query.exam_id ? { examId: query.exam_id } : {}),
        ...this.scopeFilter(principal, scope, query.outlet_id),
      },
    }

    const [rows, total] = await Promise.all([
      this.prisma.examResponse.findMany({
        where,
        // Oldest first: a candidate waiting since the 15th should not sit
        // behind one who submitted this morning.
        orderBy: { examAssignment: { submittedAt: 'asc' } },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          responseType: true,
          maxMarks: true,
          answeredAt: true,
          examAssignment: {
            select: {
              id: true,
              submittedAt: true,
              employee: {
                select: { id: true, employeeCode: true, firstName: true, lastName: true },
              },
              exam: { select: { id: true, examCode: true, nameEn: true, outletId: true } },
            },
          },
          question: {
            select: { id: true, type: true, questionTextEn: true, difficulty: true },
          },
        },
      }),
      this.prisma.examResponse.count({ where }),
    ])

    return { rows, meta: pageMeta(query.page, query.limit, total) }
  }

  /**
   * §5.3 GET /grading/:exam_assignment_id/responses — one paper, in full.
   *
   * This is where the model answer and rubric ARE returned: a grader cannot
   * mark a theory answer without knowing what a good one looks like.
   */
  async responsesFor(principal: Principal, scope: Scope, assignmentId: string) {
    const assignment = await this.loadAssignment(principal, scope, assignmentId)

    const responses = await this.prisma.examResponse.findMany({
      where: { examAssignmentId: assignmentId },
      orderBy: { examQuestion: { sortOrder: 'asc' } },
      select: {
        id: true,
        responseType: true,
        selectedOptionId: true,
        theoryAnswer: true,
        theoryAnswerLanguage: true,
        mediaUrls: true,
        mediaType: true,
        marksObtained: true,
        maxMarks: true,
        isCorrect: true,
        isAutoGraded: true,
        graderComments: true,
        rubricScores: true,
        gradedAt: true,
        timeSpentSeconds: true,
        isFlagged: true,
        isSkipped: true,
        question: {
          select: {
            id: true,
            type: true,
            questionTextEn: true,
            questionTextHi: true,
            questionTextGu: true,
            // The grader's reference material (§10.1). Never sent to a
            // candidate — see staff-exams/exam-paper.ts.
            expectedAnswerEn: true,
            expectedAnswerHi: true,
            expectedAnswerGu: true,
            rubric: true,
            options: true,
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
        employee: assignment.employee,
        exam: assignment.exam,
      },
      responses,
      // What the grader still has to do before this paper can be finalised.
      outstanding: responses.filter((r) => r.marksObtained === null).length,
    }
  }

  /** §5.3 POST /grading/:response_id/grade. */
  async grade(principal: Principal, scope: Scope, responseId: string, input: GradeInput) {
    const response = await this.prisma.examResponse.findUnique({
      where: { id: responseId },
      include: {
        question: { select: { id: true, type: true, rubric: true } },
        examAssignment: {
          select: {
            id: true,
            status: true,
            employeeId: true,
            exam: { select: { id: true, outletId: true } },
          },
        },
      },
    })
    if (!response) throw ApiError.notFound('Response not found')

    await this.assertCanGrade(principal, scope, response.examAssignment.exam.outletId)

    if (response.examAssignment.status === 'graded') {
      // §3.2 has a separate "Override grades" row: super_admin and admin only.
      // A trainer re-marking a finalised paper would silently change a result
      // the employee has already been told.
      if (!['super_admin', 'admin'].includes(principal.role)) {
        throw ApiError.forbidden('This paper is finalised; only an admin can override a grade')
      }
    }
    if (
      response.examAssignment.status !== 'submitted' &&
      response.examAssignment.status !== 'graded'
    ) {
      throw ApiError.conflict(`Cannot grade a paper that is ${response.examAssignment.status}`)
    }

    if (response.isAutoGraded && response.question.type === 'mcq') {
      // An MCQ has one correct answer; re-marking it by hand means either the
      // question is wrong (fix the question) or the grader is.
      throw ApiError.conflict('MCQs are auto-graded and cannot be marked by hand', [
        { field: 'marks', message: 'Fix the question if its answer key is wrong' },
      ])
    }

    const marks = this.resolveMarks(response, input)

    await this.prisma.examResponse.update({
      where: { id: responseId },
      data: {
        marksObtained: marks,
        graderComments: input.comments ?? null,
        rubricScores: (input.rubricScores ?? undefined) as never,
        gradedById: principal.userId,
        gradedAt: new Date(),
        isAutoGraded: false,
      },
    })

    const outstanding = await this.prisma.examResponse.count({
      where: { examAssignmentId: response.examAssignment.id, marksObtained: null },
    })

    return { marks, outstanding }
  }

  /**
   * §5.3 POST /grading/:exam_assignment_id/finalize.
   *
   * Sums the whole paper and writes the result. Separate from grading each
   * answer because a partly-marked paper has no meaningful total, and an
   * employee must not see a score that is still moving.
   */
  async finalize(principal: Principal, scope: Scope, assignmentId: string, input: FinalizeInput) {
    const assignment = await this.loadAssignment(principal, scope, assignmentId)
    await this.assertCanGrade(principal, scope, assignment.exam.outletId)

    if (assignment.status === 'graded' && !['super_admin', 'admin'].includes(principal.role)) {
      throw ApiError.forbidden('This paper is already finalised')
    }
    if (!['submitted', 'graded'].includes(assignment.status)) {
      throw ApiError.conflict(`Cannot finalise a paper that is ${assignment.status}`)
    }

    const responses = await this.prisma.examResponse.findMany({
      where: { examAssignmentId: assignmentId },
      select: { id: true, marksObtained: true },
    })

    const ungraded = responses.filter((r) => r.marksObtained === null)
    if (ungraded.length > 0) {
      throw ApiError.validation('This paper still has ungraded answers', [
        {
          field: 'responses',
          message: `${ungraded.length} answer(s) still need marking`,
        },
      ])
    }

    // Decimal columns: Number() every one. Summing Prisma Decimals with + would
    // concatenate them as strings.
    const obtained = responses.reduce((sum, r) => sum + Number(r.marksObtained), 0)
    const totalMarks = Number(assignment.exam.totalMarks)

    // Negative marking (§10.1) can take a paper below zero; a negative
    // percentage is not a thing anyone means.
    const clamped = Math.max(0, obtained)
    const percentage = totalMarks > 0 ? (clamped / totalMarks) * 100 : 0

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.examAssignment.update({
        where: { id: assignmentId },
        data: {
          status: 'graded',
          gradedAt: new Date(),
          gradedById: principal.userId,
          totalMarksObtained: obtained,
          percentage,
          grade: gradeFor(percentage),
          passed: percentage >= Number(assignment.exam.passingPercentage),
          ...(input.supervisorRemarks ? { supervisorRemarks: input.supervisorRemarks } : {}),
        },
        select: {
          id: true,
          totalMarksObtained: true,
          percentage: true,
          grade: true,
          passed: true,
          supervisorRemarks: true,
        },
      })

      // §4.1's employee_timeline — an exam result belongs in the employee's
      // history, which is what §1.2 says the product is actually for.
      await tx.employeeTimeline.create({
        data: {
          tenantId: currentTenantId(),
          employeeId: assignment.employeeId,
          eventType: 'exam',
          title: `${assignment.exam.examCode}: ${result.grade} (${percentage.toFixed(1)}%)`,
          description: input.supervisorRemarks ?? null,
          metadata: {
            examId: assignment.exam.id,
            marksObtained: obtained,
            totalMarks,
            passed: result.passed,
          },
          createdById: principal.userId,
        },
      })

      if (input.releaseResults) {
        // §11.1 step 5: results are withheld by default. Releasing is a
        // deliberate act, and it applies to the whole exam, not one paper.
        await tx.exam.update({
          where: { id: assignment.exam.id },
          data: { showResultImmediately: true },
        })
      }

      return result
    })

    await this.refreshExamStats(assignment.exam.id)
    return updated
  }

  // --- Helpers --------------------------------------------------------------

  /**
   * Turns the grader's input into a mark.
   *
   * With a rubric the total is DERIVED from the criteria rather than typed:
   * §10.1 makes the rubric the mark scheme, and letting a grader enter a total
   * that disagrees with their own criterion scores makes the rubric decorative.
   */
  private resolveMarks(
    response: { maxMarks: unknown; question: { type: string; rubric: unknown } },
    input: GradeInput
  ): number {
    const maxMarks = Number(response.maxMarks)

    if (input.rubricScores?.length) {
      const rubric = Array.isArray(response.question.rubric)
        ? (response.question.rubric as RubricCriterion[])
        : []

      if (rubric.length === 0) {
        throw ApiError.validation('That question has no rubric', [
          { field: 'rubricScores', message: 'Send marks instead' },
        ])
      }

      const details: Array<{ field: string; message: string }> = []

      for (const score of input.rubricScores) {
        const criterion = rubric.find((c) => c.criterion === score.criterion)
        if (!criterion) {
          details.push({
            field: 'rubricScores',
            message: `"${score.criterion}" is not a criterion of this question's rubric`,
          })
          continue
        }
        if (score.marks > Number(criterion.maxMarks)) {
          details.push({
            field: 'rubricScores',
            message: `"${score.criterion}" scored ${score.marks} but is worth at most ${criterion.maxMarks}`,
          })
        }
      }

      // Every criterion must be scored, or the total silently under-counts and
      // the candidate loses marks nobody decided to take.
      const missing = rubric.filter(
        (c) => !input.rubricScores!.some((s) => s.criterion === c.criterion)
      )
      if (missing.length > 0) {
        details.push({
          field: 'rubricScores',
          message: `Not scored: ${missing.map((c) => c.criterion).join(', ')}`,
        })
      }

      if (details.length > 0) throw ApiError.validation('Invalid rubric scores', details)

      const total = input.rubricScores.reduce((sum, s) => sum + s.marks, 0)

      if (input.marks !== undefined && Math.abs(input.marks - total) > 0.001) {
        throw ApiError.validation('The marks do not match the rubric scores', [
          {
            field: 'marks',
            message: `Criteria total ${total}; omit "marks" and it is used directly`,
          },
        ])
      }

      return total
    }

    const marks = input.marks!
    if (marks > maxMarks) {
      throw ApiError.validation('That is more than the question is worth', [
        { field: 'marks', message: `The question is worth ${maxMarks}` },
      ])
    }
    return marks
  }

  /** §4.1's denormalised exam stats, which §9's reporting reads. */
  private async refreshExamStats(examId: string): Promise<void> {
    const assignments = await this.prisma.examAssignment.findMany({
      where: { examId },
      select: { status: true, percentage: true, passed: true },
    })

    const graded = assignments.filter((a) => a.status === 'graded')
    const attempted = assignments.filter((a) =>
      ['started', 'submitted', 'graded'].includes(a.status)
    )

    await this.prisma.exam.update({
      where: { id: examId },
      data: {
        totalAssigned: assignments.length,
        totalAttempted: attempted.length,
        totalPassed: graded.filter((a) => a.passed).length,
        averageScore:
          graded.length > 0
            ? graded.reduce((sum, a) => sum + Number(a.percentage ?? 0), 0) / graded.length
            : null,
      },
    })
  }

  private async loadAssignment(principal: Principal, scope: Scope, assignmentId: string) {
    const assignment = await this.prisma.examAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        status: true,
        submittedAt: true,
        employeeId: true,
        employee: {
          select: { id: true, employeeCode: true, firstName: true, lastName: true, outletId: true },
        },
        exam: {
          select: {
            id: true,
            examCode: true,
            nameEn: true,
            outletId: true,
            totalMarks: true,
            passingPercentage: true,
          },
        },
      },
    })
    if (!assignment) throw ApiError.notFound('Exam paper not found')

    await this.assertCanGrade(principal, scope, assignment.exam.outletId)
    return assignment
  }

  /**
   * §3.2 scopes an outlet_manager's grading to their own outlet. A trainer gets
   * a plain ✅ — they grade across outlets, which matches §3.1's "Trainer can
   * belong to multiple outlets".
   */
  private async assertCanGrade(
    principal: Principal,
    scope: Scope,
    examOutletId: string | null
  ): Promise<void> {
    if (scope === 'all') return
    if (scope === 'none') throw ApiError.forbidden()

    if (scope === 'own_outlet') {
      // An exam with no outlet is group-wide; an outlet_manager has no claim
      // on marking it.
      if (!examOutletId || !principal.managedOutletIds.includes(examOutletId)) {
        throw ApiError.notFound('Exam paper not found')
      }
      return
    }

    throw ApiError.forbidden()
  }

  private scopeFilter(
    principal: Principal,
    scope: Scope,
    outletFilter?: string
  ): Prisma.ExamAssignmentWhereInput {
    const base = outletFilter ? { exam: { outletId: outletFilter } } : {}

    if (scope === 'own_outlet') {
      if (principal.managedOutletIds.length === 0) throw ApiError.forbidden()
      // ANDed with any requested filter, never substituted for it.
      return { ...base, exam: { outletId: { in: principal.managedOutletIds } } }
    }

    return base
  }
}
