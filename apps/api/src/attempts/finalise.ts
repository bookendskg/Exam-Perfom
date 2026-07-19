import { Prisma } from '@bookends/db'
import { summarise, round2, type ScoreSummary } from './grading.js'

/**
 * Turning a set of graded responses into an assignment's final result.
 *
 * Two callers reach this: Module 7's submit, which auto-grades the MCQs and
 * finalises immediately when there is nothing else to mark, and Module 8's
 * grader, which finalises once a human has marked the theory and video
 * answers. They must produce byte-identical end states — the same totals, the
 * same grade bands, the same exam statistics — so the write lives here once
 * rather than in each of them.
 *
 * It is deliberately NOT in grading.ts. That module is pure by design (its
 * header says so, and it imports nothing but types), which is what lets the
 * scoring rules be tested exhaustively without a database. This half needs
 * Prisma, so it is a separate file rather than a compromise of that one.
 */

/** Everything the assignment's result columns are derived from. */
export interface FinaliseInput {
  assignmentId: string
  examId: string
  totalMarks: number
  passingPercentage: number
  at: Date
  /** Set on submit; omitted by a regrade, which must not move the timestamp. */
  submittedAt?: Date
  /** The User who graded — NOT an employee id. Absent for pure auto-grading. */
  gradedById?: string | null
}

/**
 * Reads every response, scores the assignment, and writes the result.
 *
 * The read happens HERE, inside the caller's transaction, rather than being
 * passed in. A caller that assembled the list itself would have to remember to
 * do it after its own writes had been flushed; getting that order wrong
 * summarises the state before grading and silently leaves the assignment
 * stuck. Making it impossible to express is better than documenting it.
 */
export async function finaliseAssignment(
  tx: Prisma.TransactionClient,
  input: FinaliseInput
): Promise<ScoreSummary> {
  const rows = await tx.examResponse.findMany({
    where: { examAssignmentId: input.assignmentId },
    select: { responseType: true, marksObtained: true, maxMarks: true },
  })

  const summary = summarise(
    rows.map((r) => ({
      responseType: r.responseType,
      /**
       * The null MUST survive this conversion. `Number(null)` is 0, and
       * summarise treats 0 as a real mark — so mapping it carelessly would
       * make an ungraded theory answer indistinguishable from one a human
       * marked zero, finalise a half-graded attempt, and score the unmarked
       * answers nothing. That is precisely the confusion grading.ts refuses
       * to allow.
       */
      marksObtained: r.marksObtained == null ? null : Number(r.marksObtained),
      maxMarks: Number(r.maxMarks),
    })),
    input.totalMarks,
    input.passingPercentage
  )

  const complete = !summary.awaitingManualGrading

  await tx.examAssignment.update({
    where: { id: input.assignmentId },
    data: {
      status: complete ? 'graded' : 'submitted',
      ...(input.submittedAt ? { submittedAt: input.submittedAt } : {}),

      /**
       * Every result column is written on both branches — the totals when the
       * attempt is complete, explicit NULLs when it is not.
       *
       * Omitting them while awaiting would be enough on a fresh submit, where
       * they are NULL already. It is wrong for a regrade: clearing a mark on
       * an already-graded assignment has to demote it, and leaving a stale
       * percentage behind would keep it counted in the exam's pass rate and
       * average by refreshExamStats below.
       */
      gradedAt: complete ? input.at : null,
      totalMarksObtained: complete ? new Prisma.Decimal(summary.totalMarksObtained) : null,
      percentage: complete ? new Prisma.Decimal(summary.percentage) : null,
      grade: complete ? summary.grade : null,
      passed: complete ? summary.passed : null,

      /**
       * Who graded it, when a human did. Cleared alongside the result on a
       * demotion — the per-response trail (ExamResponse.gradedById) is the
       * durable record of who touched what, and this column only ever meant
       * "who finalised the result that is currently here".
       *
       * supervisorRemarks is deliberately untouched: §11.3's cancel path
       * stores its reason there, and blanking it here would erase that.
       */
      ...(input.gradedById !== undefined ? { gradedById: complete ? input.gradedById : null } : {}),
    },
  })

  await refreshExamStats(tx, input.examId)

  return summary
}

/**
 * Recomputes the exam's denormalised counters (§4.1).
 *
 * Aggregated from the assignments rather than incremented, so a re-grade or a
 * manually corrected row cannot drift the totals — an increment is only
 * correct if every writer remembers to do it, and there are now two.
 *
 * It must run on every finalisation, not just the first. Two of the three
 * counters move when an attempt goes from submitted to graded: a submitted
 * assignment has `passed` NULL so it is invisible to totalPassed, and a NULL
 * percentage is excluded from the average. Without a second call, an exam whose
 * papers all carry a theory question would report zero passes forever.
 */
export async function refreshExamStats(
  tx: Prisma.TransactionClient,
  examId: string
): Promise<void> {
  const [attempted, passed, average] = await Promise.all([
    tx.examAssignment.count({
      where: { examId, status: { in: ['submitted', 'graded'] } },
    }),
    tx.examAssignment.count({ where: { examId, passed: true } }),
    tx.examAssignment.aggregate({
      where: { examId, percentage: { not: null } },
      _avg: { percentage: true },
    }),
  ])

  await tx.exam.update({
    where: { id: examId },
    data: {
      totalAttempted: attempted,
      totalPassed: passed,
      averageScore:
        average._avg.percentage == null
          ? null
          : new Prisma.Decimal(round2(Number(average._avg.percentage))),
    },
  })
}
