import type { QuestionType } from '@bookends/db'
import { parseOptions } from './paper.js'

/**
 * Auto-grading and score arithmetic — pure, so it can be tested exhaustively
 * without a database.
 *
 * Only MCQ is auto-graded. Theory and video/image answers go to a human
 * (§3.2's grading rows, Module 8); this module deliberately scores them as
 * "pending" rather than zero, because a zero is indistinguishable from a
 * graded-and-wrong answer once it is written to `marks_obtained`.
 */

/** §11.1's grade bands: A+, A, B+, B, C, F. */
const BANDS = [
  { min: 90, grade: 'A+' },
  { min: 80, grade: 'A' },
  { min: 70, grade: 'B+' },
  { min: 60, grade: 'B' },
] as const

/**
 * The letter grade for a percentage.
 *
 * The pass mark is per-exam (§11.1 `passingPercentage`, default 40), so F is
 * defined relative to it rather than at a fixed 40: an exam configured to pass
 * at 60 must not hand out a C to someone who failed it. C is therefore
 * "passed, but below B" — which collapses to nothing when the pass mark is
 * itself 60 or higher, and that is correct.
 *
 * FLAG FOR CLIENT: the band boundaries above are not in the spec, which names
 * the six grades without defining them. These are the conventional Indian
 * academic bands; confirm before the first real exam is graded.
 */
export function gradeFor(percentage: number, passingPercentage: number): string {
  if (percentage < passingPercentage) return 'F'
  for (const band of BANDS) {
    if (percentage >= band.min) return band.grade
  }
  return 'C'
}

export interface McqGrade {
  isCorrect: boolean
  marksObtained: number
}

/**
 * Grades one MCQ response.
 *
 * `negativeMarks` (§10.1) is subtracted for a wrong answer but never for an
 * unanswered one — penalising a skip would punish honesty and is not what a
 * negative marking scheme means.
 */
export function gradeMcq(
  options: unknown,
  selectedOptionId: string | null,
  marks: number,
  negativeMarks: number
): McqGrade {
  if (selectedOptionId == null) return { isCorrect: false, marksObtained: 0 }

  const correct = parseOptions(options).find((o) => o.isCorrect)

  /**
   * No correct option means the question is unanswerable — a bad import, or an
   * options array that no longer parses. Marking every candidate wrong for a
   * data problem is the one outcome that is definitely unfair, so the response
   * scores zero WITHOUT a negative penalty and without being called incorrect.
   * Module 8's grader sees it as ungraded and can void the question.
   */
  if (!correct) return { isCorrect: false, marksObtained: 0 }

  return correct.id === selectedOptionId
    ? { isCorrect: true, marksObtained: marks }
    : { isCorrect: false, marksObtained: -negativeMarks }
}

export interface ScorableResponse {
  responseType: QuestionType
  marksObtained: number | null
  maxMarks: number
}

export interface ScoreSummary {
  /** Marks awarded so far. Never negative — see below. */
  totalMarksObtained: number
  percentage: number
  grade: string
  passed: boolean
  /** True when a human still has to grade something (§3.2 grading rows). */
  awaitingManualGrading: boolean
}

/**
 * Totals an attempt.
 *
 * `totalMarks` is the exam's configured total rather than the summed response
 * maxima: §11.3 already enforces that those agree at publish time, and using
 * the exam's figure keeps a candidate's percentage comparable with everyone
 * else's even if a question is later voided.
 *
 * The floor at zero is a policy choice: with negative marking, enough wrong
 * answers produce a negative total, and a negative percentage breaks §9's
 * snapshots, the grade bands, and every chart downstream. Zero is the worst
 * possible performance, so that is where it stops.
 */
export function summarise(
  responses: ScorableResponse[],
  totalMarks: number,
  passingPercentage: number
): ScoreSummary {
  const awaitingManualGrading = responses.some(
    (r) => r.responseType !== 'mcq' && r.marksObtained == null
  )

  const raw = responses.reduce((sum, r) => sum + (r.marksObtained ?? 0), 0)
  const totalMarksObtained = round2(Math.max(0, raw))
  const percentage = totalMarks > 0 ? round2((totalMarksObtained / totalMarks) * 100) : 0

  return {
    totalMarksObtained,
    percentage,
    grade: gradeFor(percentage, passingPercentage),
    passed: percentage >= passingPercentage,
    awaitingManualGrading,
  }
}

/**
 * Marks are DECIMAL(5,2) in the database. Rounding here rather than letting
 * Postgres do it keeps the number the API returns identical to the number that
 * was stored — otherwise a submit response and a later result read can differ
 * in the last decimal place.
 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
