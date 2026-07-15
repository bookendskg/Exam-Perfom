import type { PrismaClient } from '@bookends/db'
import { availableLanguages } from '@bookends/core'

/**
 * §11.3 exam validation rules, checked before publishing:
 *
 *   - At least 1 question must be assigned
 *   - Total marks must match sum of question marks
 *   - All assigned employees must be active
 *   - Scheduled date must be in the future
 *   - Time window must be at least 30 minutes
 *   - All questions must be in APPROVED status
 *   - Warning if any question lacks Hindi/Gujarati translation
 *
 * The last one is explicitly a WARNING in §11.3, not an error — which is why
 * this returns a report rather than throwing. Publishing an English-only exam
 * to staff who read Gujarati is bad, but §11.3 says it is the client's call,
 * so the decision is surfaced rather than made here.
 */
export interface ValidationIssue {
  field: string
  message: string
}

export interface PublishValidation {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  canPublish: boolean
}

const MIN_WINDOW_MINUTES = 30

export class PublishValidator {
  constructor(private readonly prisma: PrismaClient) {}

  async validate(examId: string, now: Date = new Date()): Promise<PublishValidation> {
    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []

    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        examQuestions: {
          include: {
            question: {
              select: {
                id: true,
                status: true,
                questionTextEn: true,
                questionTextHi: true,
                questionTextGu: true,
              },
            },
          },
        },
        assignments: {
          include: { employee: { select: { id: true, employmentStatus: true, firstName: true } } },
        },
      },
    })

    if (!exam) {
      return { errors: [{ field: 'exam', message: 'Exam not found' }], warnings, canPublish: false }
    }

    // §11.3: at least 1 question
    if (exam.examQuestions.length === 0) {
      errors.push({ field: 'questions', message: 'An exam needs at least one question' })
    }

    // §11.3: all questions APPROVED
    const unapproved = exam.examQuestions.filter((eq) => eq.question.status !== 'approved')
    if (unapproved.length > 0) {
      errors.push({
        field: 'questions',
        message:
          `${unapproved.length} of ${exam.examQuestions.length} questions are not approved ` +
          `(${[...new Set(unapproved.map((q) => q.question.status))].join(', ')}). ` +
          `Unreviewed content must not reach staff.`,
      })
    }

    // §11.3: total marks must match the sum of question marks
    const summed = exam.examQuestions.reduce((total, eq) => total + Number(eq.marks), 0)
    if (exam.examQuestions.length > 0 && Math.abs(summed - Number(exam.totalMarks)) > 0.001) {
      errors.push({
        field: 'totalMarks',
        message: `The exam says ${exam.totalMarks} marks but its questions total ${summed}`,
      })
    }

    /**
     * §11.3: "All assigned employees must be active".
     *
     * §8.4's enum has five statuses and only ONE of them is active — so this is
     * an allowlist, not a denylist. Listing the bad ones missed `on_leave`
     * entirely: an employee on leave is not active, and scheduling them to sit
     * an exam they cannot attend marks them absent and drags down §9's record
     * through no fault of their own.
     */
    const inactive = exam.assignments.filter((a) => a.employee.employmentStatus !== 'active')
    if (inactive.length > 0) {
      const byStatus = [...new Set(inactive.map((a) => a.employee.employmentStatus))]
      errors.push({
        field: 'assignments',
        message:
          `${inactive.length} assigned ${inactive.length === 1 ? 'employee is' : 'employees are'} ` +
          `not active (${byStatus.join(', ')}). §11.3 requires every assignee be active.`,
      })
    }

    // §11.3: scheduled date must be in the future
    const startsAt = combine(exam.scheduledDate, exam.startTime)
    const endsAt = combine(exam.scheduledDate, exam.endTime)

    if (startsAt <= now) {
      errors.push({
        field: 'scheduledDate',
        message: 'The exam window has already started; staff could not be notified in time',
      })
    }

    // §11.3: time window at least 30 minutes
    const windowMinutes = (endsAt.getTime() - startsAt.getTime()) / 60_000
    if (windowMinutes < MIN_WINDOW_MINUTES) {
      errors.push({
        field: 'endTime',
        message: `The exam window is ${Math.round(windowMinutes)} minutes; the minimum is ${MIN_WINDOW_MINUTES}`,
      })
    }

    // The window must also fit the exam. §11.3 does not say this, but a 60
    // minute exam inside a 30 minute window is unsittable, and staff would find
    // out at the moment it mattered.
    if (windowMinutes > 0 && windowMinutes < exam.durationMinutes) {
      errors.push({
        field: 'endTime',
        message: `The window is ${Math.round(windowMinutes)} minutes but the exam takes ${exam.durationMinutes}`,
      })
    }

    // Assigning nobody is not an error per §11.3, but it is never intentional.
    if (exam.assignments.length === 0) {
      warnings.push({
        field: 'assignments',
        message: 'No employees are assigned — nobody will sit this exam',
      })
    }

    // §11.3: "Warning if any question lacks Hindi/Gujarati translation"
    const missingHi: string[] = []
    const missingGu: string[] = []
    for (const eq of exam.examQuestions) {
      const languages = availableLanguages({
        en: eq.question.questionTextEn,
        hi: eq.question.questionTextHi,
        gu: eq.question.questionTextGu,
      })
      if (!languages.includes('hi')) missingHi.push(eq.question.id)
      if (!languages.includes('gu')) missingGu.push(eq.question.id)
    }

    if (missingHi.length > 0) {
      warnings.push({
        field: 'questions.hi',
        message: `${missingHi.length} question(s) have no Hindi translation; Hindi-speaking staff will see English`,
      })
    }
    if (missingGu.length > 0) {
      warnings.push({
        field: 'questions.gu',
        message: `${missingGu.length} question(s) have no Gujarati translation; Gujarati-speaking staff will see Hindi or English`,
      })
    }

    return { errors, warnings, canPublish: errors.length === 0 }
  }
}

/**
 * §4.1 stores scheduled_date as DATE and start_time/end_time as TIME, so a
 * usable instant has to be reassembled from the two.
 *
 * Both come back from Prisma as Dates: the date carries the day at 00:00 UTC,
 * the time carries the clock reading on 1970-01-01. Taking the UTC parts of
 * each is what keeps them from drifting through a local-timezone conversion.
 */
export function combine(date: Date, time: Date): Date {
  const combined = new Date(date)
  combined.setUTCHours(
    time.getUTCHours(),
    time.getUTCMinutes(),
    time.getUTCSeconds(),
    time.getUTCMilliseconds()
  )
  return combined
}
