import { Prisma } from '@bookends/db'
import type { PrismaClient, AssignmentStatus, QuestionType } from '@bookends/db'
import { isLanguage, type Language } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import { buildPaper, parseOptions, type PaperQuestionSource } from './paper.js'
import { examWindow, deadlineFor, windowStateAt, type ExamWindow } from './attempt-window.js'
import { gradeMcq, summarise, round2 } from './grading.js'
import type { SaveResponseInput, StartAttemptInput, ListAttemptsQuery } from './attempt.schemas.js'

/**
 * §5.3's exam-taking API — Module 7.
 *
 * Every method takes an `employeeId` resolved from the session, exactly like
 * StaffService, and every query filters on it. There is no scope parameter
 * because there is no scope to widen: §3.2 gives `exam:take` to staff alone,
 * with scope `all` over their OWN assignments, and an assignment names its
 * employee. An admin cannot sit an exam on someone's behalf through this API,
 * which is the point.
 *
 * The invariant this module exists to protect is that a candidate can never
 * see `isCorrect` before submitting. It is enforced in exactly two places —
 * {@link buildPaper} strips it on the way out, and grading reads it server-side
 * — and nothing here selects `options` into a response.
 */

const PAPER_INCLUDE = {
  examQuestions: {
    include: {
      question: {
        select: {
          id: true,
          type: true,
          questionTextEn: true,
          questionTextHi: true,
          questionTextGu: true,
          instructionsEn: true,
          instructionsHi: true,
          instructionsGu: true,
          imageUrl: true,
          videoUrl: true,
          audioUrl: true,
          options: true,
          timeLimitSeconds: true,
          negativeMarks: true,
          minWordLimit: true,
          maxWordLimit: true,
          responseType: true,
          maxFileSizeMb: true,
          maxVideoDurationSeconds: true,
          rubric: true,
        },
      },
    },
  },
} satisfies Prisma.ExamInclude

export interface AttemptContext {
  ipAddress?: string
}

export class AttemptService {
  constructor(
    private readonly prisma: PrismaClient,
    /** Injected so tests can drive the clock without waiting for a real window. */
    private readonly now: () => Date = () => new Date()
  ) {}

  /** §5.3 GET /staff/exams — the candidate's own assignments. */
  async list(employeeId: string, query: ListAttemptsQuery) {
    const assignments = await this.prisma.examAssignment.findMany({
      where: {
        employeeId,
        ...(query.status ? { status: query.status } : {}),
        exam: { status: { notIn: ['draft', 'archived'] } },
      },
      orderBy: [{ exam: { scheduledDate: 'desc' } }],
      select: {
        id: true,
        status: true,
        startedAt: true,
        submittedAt: true,
        gradedAt: true,
        percentage: true,
        grade: true,
        passed: true,
        exam: {
          select: {
            id: true,
            examCode: true,
            nameEn: true,
            nameHi: true,
            nameGu: true,
            status: true,
            scheduledDate: true,
            startTime: true,
            endTime: true,
            // Selected so examWindow can check it — an exam stored in an
            // unsupported timezone must not be converted as though it were IST.
            timezone: true,
            durationMinutes: true,
            totalMarks: true,
            passingPercentage: true,
            showResultImmediately: true,
          },
        },
      },
    })

    const now = this.now()
    return assignments.map(({ exam, ...assignment }) => {
      const window = examWindow(exam)
      return {
        ...assignment,
        exam,
        opensAt: window.opensAt,
        closesAt: window.closesAt,
        windowState: windowStateAt(window, now),
        /** What the APK should offer as the primary action, computed once here. */
        canStart: this.startability(assignment.status, exam.status, window, now) === 'ok',
      }
    })
  }

  /**
   * §5.3 POST /staff/exams/:assignmentId/start.
   *
   * Starting twice is not an error — it is the normal consequence of a phone
   * dying mid-exam. The first call stamps `startedAt` and that stamp is never
   * moved, because moving it would hand a candidate a fresh duration every
   * time they force-quit the app. Subsequent calls open a new ExamSession row
   * against the same assignment, which is what §4.1's one-assignment-to-many-
   * sessions relation is for: each reconnection is auditable (§8's suspicious
   * activity), and none of them extend the clock.
   */
  async start(
    employeeId: string,
    assignmentId: string,
    input: StartAttemptInput,
    ctx: AttemptContext = {}
  ) {
    const assignment = await this.loadAssignment(employeeId, assignmentId)
    const window = examWindow(assignment.exam)
    const now = this.now()

    const startability = this.startability(
      assignment.status,
      assignment.exam.status,
      window,
      now,
      assignment.startedAt
    )
    if (startability !== 'ok') throw this.startabilityError(startability, window, now)

    const startedAt = assignment.startedAt ?? now

    await this.prisma.$transaction(async (tx) => {
      if (!assignment.startedAt) {
        await tx.examAssignment.update({
          where: { id: assignmentId },
          data: { status: 'started', startedAt },
        })
      }
      await tx.examSession.create({
        data: {
          examAssignmentId: assignmentId,
          startedAt: now,
          deviceInfo: input.deviceInfo ?? Prisma.JsonNull,
          ipAddress: ctx.ipAddress ?? null,
        },
      })
    })

    return this.paperFor(assignment, startedAt, window)
  }

  /**
   * §5.3 GET /staff/exams/:assignmentId/paper — resume an attempt.
   *
   * Returns the identical paper `start` returned, plus whatever has been saved,
   * so a reconnecting candidate can restore their place. It does NOT start an
   * attempt: a candidate who has not started gets 409, not a silently started
   * clock.
   */
  async paper(employeeId: string, assignmentId: string) {
    const assignment = await this.loadAssignment(employeeId, assignmentId)

    if (!assignment.startedAt) {
      throw ApiError.conflict('This exam has not been started yet')
    }
    if (assignment.submittedAt) {
      throw ApiError.conflict('You have already submitted this exam')
    }

    return this.paperFor(assignment, assignment.startedAt, examWindow(assignment.exam))
  }

  /**
   * §5.3 PUT /staff/exams/:assignmentId/responses/:examQuestionId — autosave.
   *
   * Idempotent by construction: the response row is unique on
   * (assignment, examQuestion), so re-sending the same answer overwrites it.
   * That is what makes the APK's "save on every change, retry on failure"
   * loop safe over a restaurant's WiFi.
   *
   * Nothing is graded here. `marksObtained` stays null until submit, so a
   * candidate cannot infer correctness from a response body — not from a
   * field, and not from how long the request took.
   */
  async saveResponse(
    employeeId: string,
    assignmentId: string,
    examQuestionId: string,
    input: SaveResponseInput
  ) {
    const assignment = await this.loadAssignment(employeeId, assignmentId)
    const now = this.now()

    if (!assignment.startedAt) {
      throw ApiError.conflict('This exam has not been started yet')
    }
    if (assignment.submittedAt) {
      throw ApiError.conflict('You have already submitted this exam')
    }

    const window = examWindow(assignment.exam)
    const deadline = deadlineFor(window, assignment.startedAt, assignment.exam.durationMinutes)
    if (now >= deadline) {
      throw ApiError.conflict('Your time for this exam has ended', [
        { field: 'deadline', message: deadline.toISOString() },
      ])
    }

    const examQuestion = assignment.exam.examQuestions.find((eq) => eq.id === examQuestionId)
    if (!examQuestion) {
      throw ApiError.notFound('That question is not part of this exam')
    }

    const answer = this.validateAnswer(examQuestion, input)

    const data = {
      responseType: examQuestion.question.type,
      maxMarks: new Prisma.Decimal(Number(examQuestion.marks)),
      ...answer,
      ...(input.isSkipped === undefined ? {} : { isSkipped: input.isSkipped }),
      ...(input.isFlagged === undefined ? {} : { isFlagged: input.isFlagged }),
      ...(input.timeSpentSeconds === undefined ? {} : { timeSpentSeconds: input.timeSpentSeconds }),
      answeredAt: now,
    }

    const saved = await this.prisma.examResponse.upsert({
      where: {
        examAssignmentId_examQuestionId: { examAssignmentId: assignmentId, examQuestionId },
      },
      create: {
        examAssignmentId: assignmentId,
        examQuestionId,
        questionId: examQuestion.question.id,
        ...data,
      },
      update: data,
      select: {
        examQuestionId: true,
        selectedOptionId: true,
        theoryAnswer: true,
        theoryAnswerLanguage: true,
        mediaUrls: true,
        mediaType: true,
        isSkipped: true,
        isFlagged: true,
        timeSpentSeconds: true,
        answeredAt: true,
      },
    })

    return { saved, deadline }
  }

  /**
   * §5.3 POST /staff/exams/:assignmentId/submit.
   *
   * Auto-grades the MCQs and finalises the attempt. An exam of nothing but
   * MCQs is fully graded here and lands in `graded`; anything with a theory or
   * video answer lands in `submitted` and waits for Module 8, because a
   * partial score written to `percentage` would be indistinguishable from a
   * final one — and §9's snapshots would file it as final.
   *
   * Submitting after the deadline is deliberately allowed. The alternative is
   * losing an entire attempt because a phone could not reach the server for
   * ninety seconds, and the deadline is already enforced where it matters:
   * `saveResponse` refuses answers past it, so a late submit can only finalise
   * work that was saved in time.
   */
  async submit(employeeId: string, assignmentId: string) {
    const assignment = await this.loadAssignment(employeeId, assignmentId)
    const now = this.now()

    if (!assignment.startedAt) {
      throw ApiError.conflict('This exam has not been started yet')
    }
    if (assignment.submittedAt) {
      throw ApiError.conflict('You have already submitted this exam')
    }

    const responses = await this.prisma.examResponse.findMany({
      where: { examAssignmentId: assignmentId },
      select: { id: true, examQuestionId: true, selectedOptionId: true, isSkipped: true },
    })
    const byExamQuestion = new Map(responses.map((r) => [r.examQuestionId, r]))

    const exam = assignment.exam
    const graded = exam.examQuestions.map((eq) => {
      const marks = Number(eq.marks)
      const existing = byExamQuestion.get(eq.id)

      if (eq.question.type !== 'mcq') {
        return { examQuestion: eq, existing, marks, marksObtained: null, isCorrect: null }
      }

      const { isCorrect, marksObtained } = gradeMcq(
        eq.question.options,
        existing?.isSkipped ? null : (existing?.selectedOptionId ?? null),
        marks,
        Number(eq.question.negativeMarks ?? 0)
      )
      return { examQuestion: eq, existing, marks, marksObtained, isCorrect }
    })

    const summary = summarise(
      graded.map((g) => ({
        responseType: g.examQuestion.question.type as QuestionType,
        marksObtained: g.marksObtained,
        maxMarks: g.marks,
      })),
      Number(exam.totalMarks),
      Number(exam.passingPercentage)
    )

    await this.prisma.$transaction(async (tx) => {
      for (const g of graded) {
        /**
         * Unanswered questions get a response row written at submit time. It
         * would be easier to skip them, but then "did not answer" and "was
         * never asked" look identical in the data, and Module 8's grader would
         * have nothing to open for an unattempted theory question.
         */
        const scoring = {
          marksObtained: g.marksObtained == null ? null : new Prisma.Decimal(g.marksObtained),
          isCorrect: g.isCorrect,
          isAutoGraded: g.examQuestion.question.type === 'mcq',
        }

        if (g.existing) {
          await tx.examResponse.update({ where: { id: g.existing.id }, data: scoring })
        } else {
          await tx.examResponse.create({
            data: {
              examAssignmentId: assignmentId,
              examQuestionId: g.examQuestion.id,
              questionId: g.examQuestion.question.id,
              responseType: g.examQuestion.question.type,
              maxMarks: new Prisma.Decimal(g.marks),
              isSkipped: true,
              ...scoring,
            },
          })
        }
      }

      await tx.examAssignment.update({
        where: { id: assignmentId },
        data: {
          status: summary.awaitingManualGrading ? 'submitted' : 'graded',
          submittedAt: now,
          ...(summary.awaitingManualGrading
            ? {}
            : {
                gradedAt: now,
                totalMarksObtained: new Prisma.Decimal(summary.totalMarksObtained),
                percentage: new Prisma.Decimal(summary.percentage),
                grade: summary.grade,
                passed: summary.passed,
              }),
        },
      })

      // Close any session still open, so §8's analytics see a duration rather
      // than an attempt that never ended.
      await tx.examSession.updateMany({
        where: { examAssignmentId: assignmentId, endedAt: null },
        data: { endedAt: now },
      })

      await this.refreshExamStats(tx, exam.id)
    })

    /**
     * §11.1's `showResultImmediately` governs whether the candidate sees their
     * score now. When it is off they get an acknowledgement only — and the
     * marks are withheld here rather than merely hidden by the APK, because an
     * APK is a client and clients can be read.
     */
    return this.resultPayload(assignmentId, employeeId)
  }

  /** §5.3 GET /staff/exams/:assignmentId/result. */
  async result(employeeId: string, assignmentId: string) {
    return this.resultPayload(assignmentId, employeeId)
  }

  // -------------------------------------------------------------------------

  private async loadAssignment(employeeId: string, assignmentId: string) {
    const assignment = await this.prisma.examAssignment.findFirst({
      // Scoping on employeeId in the WHERE, not after the read: a findUnique
      // followed by an ownership check is one forgotten `if` away from serving
      // another candidate's paper.
      where: { id: assignmentId, employeeId },
      include: { exam: { include: PAPER_INCLUDE } },
    })
    if (!assignment) throw ApiError.notFound('Exam assignment not found')
    return assignment
  }

  private startability(
    status: AssignmentStatus,
    examStatus: string,
    window: ExamWindow,
    now: Date,
    startedAt?: Date | null
  ): 'ok' | 'not_open' | 'closed' | 'submitted' | 'exam_not_live' | 'excluded' {
    if (status === 'submitted' || status === 'graded') return 'submitted'
    if (status === 'absent' || status === 'exempted') return 'excluded'
    if (!['scheduled', 'active'].includes(examStatus)) return 'exam_not_live'

    const state = windowStateAt(window, now)
    if (state === 'not_yet_open') return 'not_open'
    // A closed window blocks a fresh start but not a resume — someone who
    // started legitimately keeps whatever the deadline gives them.
    if (state === 'closed' && !startedAt) return 'closed'
    return 'ok'
  }

  private startabilityError(
    reason: Exclude<ReturnType<AttemptService['startability']>, 'ok'>,
    window: ExamWindow,
    now: Date
  ): ApiError {
    switch (reason) {
      case 'not_open':
        return ApiError.conflict('This exam has not opened yet', [
          { field: 'opensAt', message: window.opensAt.toISOString() },
        ])
      case 'closed':
        return ApiError.conflict('This exam has closed', [
          { field: 'closesAt', message: window.closesAt.toISOString() },
        ])
      case 'submitted':
        return ApiError.conflict('You have already submitted this exam')
      case 'excluded':
        return ApiError.conflict('You are not required to sit this exam')
      case 'exam_not_live':
        return ApiError.conflict('This exam is not open for attempts')
    }
    // Unreachable; `now` is accepted for symmetry with future reasons.
    void now
  }

  private async paperFor(
    assignment: Awaited<ReturnType<AttemptService['loadAssignment']>>,
    startedAt: Date,
    window: ExamWindow
  ) {
    const exam = assignment.exam
    const language = await this.languageOf(assignment.employeeId)

    const questions = buildPaper(exam.examQuestions as PaperQuestionSource[], {
      language,
      shuffleQuestions: exam.shuffleQuestions ?? true,
      shuffleOptions: exam.shuffleOptions ?? true,
      assignmentId: assignment.id,
    })

    const saved = await this.prisma.examResponse.findMany({
      where: { examAssignmentId: assignment.id },
      select: {
        examQuestionId: true,
        selectedOptionId: true,
        theoryAnswer: true,
        theoryAnswerLanguage: true,
        mediaUrls: true,
        mediaType: true,
        isSkipped: true,
        isFlagged: true,
        timeSpentSeconds: true,
      },
    })

    return {
      assignmentId: assignment.id,
      exam: {
        id: exam.id,
        examCode: exam.examCode,
        nameEn: exam.nameEn,
        nameHi: exam.nameHi,
        nameGu: exam.nameGu,
        totalMarks: exam.totalMarks,
        passingPercentage: exam.passingPercentage,
        durationMinutes: exam.durationMinutes,
        allowBackNavigation: exam.allowBackNavigation ?? true,
        allowReview: exam.allowReview ?? false,
      },
      language,
      startedAt,
      closesAt: window.closesAt,
      deadline: deadlineFor(window, startedAt, exam.durationMinutes),
      serverTime: this.now(),
      questions,
      savedResponses: saved,
    }
  }

  /**
   * §6.2: the paper is rendered in the candidate's own preferred language.
   *
   * It is read from the Employee record rather than an Accept-Language header
   * or a query parameter, because it must be the same on every device the
   * candidate picks up, and because a candidate should not be able to change
   * the language of a paper they are mid-way through.
   */
  private async languageOf(employeeId: string): Promise<Language> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { preferredLanguage: true },
    })
    return isLanguage(employee?.preferredLanguage) ? employee.preferredLanguage : 'en'
  }

  /**
   * Per-question answer rules that need the question itself.
   *
   * Returns the columns to write. A question's type decides which columns are
   * legal: accepting a theory answer for an MCQ would store text that nothing
   * ever grades, and the candidate would have no way of knowing.
   */
  private validateAnswer(
    examQuestion: {
      question: {
        type: QuestionType
        options?: unknown
        minWordLimit?: number | null
        maxWordLimit?: number | null
        responseType?: string | null
      }
    },
    input: SaveResponseInput
  ) {
    const q = examQuestion.question

    if (q.type === 'mcq') {
      this.rejectFields(input, ['theoryAnswer', 'mediaUrls'], 'a multiple-choice question')
      if (input.selectedOptionId == null) return { selectedOptionId: null }

      const known = parseOptions(q.options).some((o) => o.id === input.selectedOptionId)
      if (!known) {
        throw ApiError.validation('That option does not belong to this question', [
          { field: 'selectedOptionId', message: 'Unknown option' },
        ])
      }
      return { selectedOptionId: input.selectedOptionId }
    }

    if (q.type === 'theory') {
      this.rejectFields(input, ['selectedOptionId', 'mediaUrls'], 'a theory question')
      const answer = input.theoryAnswer ?? null
      if (answer !== null) this.checkWordLimits(answer, q.minWordLimit, q.maxWordLimit)
      return {
        theoryAnswer: answer,
        ...(input.theoryAnswerLanguage ? { theoryAnswerLanguage: input.theoryAnswerLanguage } : {}),
      }
    }

    this.rejectFields(input, ['selectedOptionId', 'theoryAnswer'], 'a video or image question')
    if (input.mediaUrls === undefined) return {}

    // §10.1: a video question takes a video, an image question an image.
    if (input.mediaType && q.responseType && q.responseType !== 'both') {
      if (input.mediaType !== q.responseType) {
        throw ApiError.validation(`This question expects ${q.responseType}`, [
          { field: 'mediaType', message: `Expected ${q.responseType}, got ${input.mediaType}` },
        ])
      }
    }

    return {
      mediaUrls: input.mediaUrls,
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    }
  }

  private rejectFields(
    input: SaveResponseInput,
    fields: (keyof SaveResponseInput)[],
    what: string
  ) {
    for (const field of fields) {
      // Only a value counts: an explicit null is the client clearing a field,
      // and clearing something that was never set is harmless.
      if (input[field] != null) {
        throw ApiError.validation(`${String(field)} is not a valid answer for ${what}`, [
          { field: String(field), message: `Not accepted for ${what}` },
        ])
      }
    }
  }

  /** §10.1's theory word limits, enforced on save so the APK can show them live. */
  private checkWordLimits(answer: string, min?: number | null, max?: number | null) {
    const words = answer.trim() === '' ? 0 : answer.trim().split(/\s+/).length

    // An empty answer is "not answered yet", not "too short" — a candidate
    // typing their first word must not be told off before they type it.
    if (min && words > 0 && words < min) {
      throw ApiError.validation(`This answer needs at least ${min} words`, [
        { field: 'theoryAnswer', message: `${words} words; minimum is ${min}` },
      ])
    }
    if (max && words > max) {
      throw ApiError.validation(`This answer may be at most ${max} words`, [
        { field: 'theoryAnswer', message: `${words} words; maximum is ${max}` },
      ])
    }
  }

  private async resultPayload(assignmentId: string, employeeId: string) {
    const assignment = await this.prisma.examAssignment.findFirst({
      where: { id: assignmentId, employeeId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        submittedAt: true,
        gradedAt: true,
        totalMarksObtained: true,
        percentage: true,
        grade: true,
        passed: true,
        supervisorRemarks: true,
        exam: {
          select: {
            id: true,
            examCode: true,
            nameEn: true,
            nameHi: true,
            nameGu: true,
            totalMarks: true,
            passingPercentage: true,
            showResultImmediately: true,
            allowReview: true,
          },
        },
      },
    })
    if (!assignment) throw ApiError.notFound('Exam assignment not found')

    const { exam, ...rest } = assignment
    const released = exam.showResultImmediately === true && assignment.status === 'graded'

    if (!released) {
      return {
        ...rest,
        exam: { ...exam, showResultImmediately: undefined },
        resultAvailable: false,
        // The marks are removed, not just flagged — see submit().
        totalMarksObtained: null,
        percentage: null,
        grade: null,
        passed: null,
        message:
          assignment.status === 'graded'
            ? 'Your result will be released by your manager'
            : 'Your answers are being graded',
      }
    }

    /**
     * §11.1's `allowReview` decides whether the candidate sees the paper back
     * with explanations. Without it they get the score alone — which is the
     * default, because an exam bank of 300 staff sitting variants of the same
     * questions leaks fast if every candidate can walk away with a marked copy.
     */
    const responses = exam.allowReview ? await this.reviewResponses(assignmentId) : undefined

    return {
      ...rest,
      exam: { ...exam, showResultImmediately: undefined },
      resultAvailable: true,
      ...(responses ? { responses } : {}),
    }
  }

  private async reviewResponses(assignmentId: string) {
    const rows = await this.prisma.examResponse.findMany({
      where: { examAssignmentId: assignmentId },
      orderBy: { examQuestion: { sortOrder: 'asc' } },
      select: {
        examQuestionId: true,
        responseType: true,
        selectedOptionId: true,
        theoryAnswer: true,
        mediaUrls: true,
        isCorrect: true,
        isSkipped: true,
        marksObtained: true,
        maxMarks: true,
        graderComments: true,
        rubricScores: true,
        question: {
          select: {
            questionTextEn: true,
            questionTextHi: true,
            questionTextGu: true,
            explanationEn: true,
            explanationHi: true,
            explanationGu: true,
            options: true,
          },
        },
      },
    })

    return rows.map(({ question, ...response }) => ({
      ...response,
      questionTextEn: question.questionTextEn,
      questionTextHi: question.questionTextHi,
      questionTextGu: question.questionTextGu,
      explanationEn: question.explanationEn,
      explanationHi: question.explanationHi,
      explanationGu: question.explanationGu,
      // Now — and only now — the key is public: the attempt is over and the
      // exam allows review.
      correctOptionId: parseOptions(question.options).find((o) => o.isCorrect)?.id ?? null,
    }))
  }

  /**
   * Recomputes the exam's denormalised counters (§4.1).
   *
   * Aggregated from the assignments rather than incremented, so a re-grade in
   * Module 8 or a manually corrected row cannot drift the totals — an
   * increment is only correct if every writer remembers to do it.
   */
  private async refreshExamStats(tx: Prisma.TransactionClient, examId: string) {
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
}
