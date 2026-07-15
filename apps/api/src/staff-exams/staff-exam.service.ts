import type { PrismaClient } from '@bookends/db'
import { currentTenantId } from '@bookends/db'
import type { Language } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import { combine } from '../exams/publish-validation.js'
import { buildPaper, correctOptionId } from './exam-paper.js'
import type { AnswerInput, StartInput } from './staff-exam.schemas.js'

/**
 * §13 exam taking.
 *
 * Every method resolves the assignment from (examId, employeeId-from-session),
 * never from a request field — a candidate cannot name someone else's
 * assignment because there is nowhere to put the id.
 *
 * The timer is enforced here, on the server, against started_at. A client-side
 * countdown is a courtesy; anything that decides marks has to be authoritative
 * on this side, because the client is a phone in the candidate's hand.
 */
const GRACE_SECONDS = 30

export class StaffExamService {
  constructor(private readonly prisma: PrismaClient) {}

  /** §5.3 GET /staff/exams — my upcoming and past exams. */
  async list(employeeId: string) {
    const assignments = await this.prisma.examAssignment.findMany({
      where: { employeeId, exam: { status: { notIn: ['draft', 'archived'] } } },
      orderBy: { exam: { scheduledDate: 'desc' } },
      select: {
        id: true,
        status: true,
        startedAt: true,
        submittedAt: true,
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
            scheduledDate: true,
            startTime: true,
            endTime: true,
            durationMinutes: true,
            totalMarks: true,
            passingPercentage: true,
            status: true,
            showResultImmediately: true,
            _count: { select: { examQuestions: true } },
          },
        },
      },
    })

    const now = new Date()
    return assignments.map((a) => {
      const opensAt = combine(a.exam.scheduledDate, a.exam.startTime)
      const closesAt = combine(a.exam.scheduledDate, a.exam.endTime)

      return {
        ...a,
        questionCount: a.exam._count.examQuestions,
        opensAt,
        closesAt,
        // §13.1 step 2: the app needs to know whether "Start Exam" is live.
        canStart:
          ['assigned', 'notified', 'started'].includes(a.status) &&
          now >= opensAt &&
          now <= closesAt &&
          a.exam.status !== 'cancelled',
        // Results are only visible once graded, and only if the exam says so.
        resultAvailable: a.status === 'graded' && a.exam.showResultImmediately,
      }
    })
  }

  /**
   * §5.3 GET /staff/exams/:id/start — §13.1 steps 5-7.
   *
   * Idempotent: re-calling it returns the same paper with the same remaining
   * time. A candidate whose phone drops off restaurant WiFi mid-exam must be
   * able to reload without losing their attempt or gaining a fresh timer.
   */
  async start(employeeId: string, examId: string, input: StartInput, now = new Date()) {
    const assignment = await this.loadAssignment(employeeId, examId)
    const exam = assignment.exam

    if (exam.status === 'cancelled') {
      throw ApiError.conflict('This exam has been cancelled')
    }

    /**
     * The exam must be PUBLISHED. Only rejecting 'cancelled' was a hole:
     * create() with autoAssign writes assignment rows while the exam is still a
     * draft, so a candidate could start one and sit it — bypassing every §11.3
     * check at once. A draft may hold unapproved questions and a totalMarks
     * that nothing has reconciled against its question marks, so the resulting
     * percentage would be meaningless and would still land in the performance
     * record as fact.
     */
    if (!['scheduled', 'active'].includes(exam.status)) {
      throw ApiError.notFound('You have not been assigned to this exam')
    }
    if (['submitted', 'graded'].includes(assignment.status)) {
      // One attempt. Re-starting would silently discard the answers already
      // given, which is worse than refusing.
      throw ApiError.conflict('You have already submitted this exam', [
        { field: 'status', message: 'An exam can only be taken once' },
      ])
    }
    if (assignment.status === 'exempted') {
      throw ApiError.conflict('You have been exempted from this exam')
    }

    const opensAt = combine(exam.scheduledDate, exam.startTime)
    const closesAt = combine(exam.scheduledDate, exam.endTime)

    if (now < opensAt) {
      throw ApiError.conflict('This exam has not opened yet', [
        { field: 'startTime', message: `It opens at ${opensAt.toISOString()}` },
      ])
    }
    if (now > closesAt) {
      throw ApiError.conflict('This exam has closed', [
        { field: 'endTime', message: `It closed at ${closesAt.toISOString()}` },
      ])
    }

    // §13.1 step 6: the timer starts on the FIRST start and never restarts.
    const startedAt = assignment.startedAt ?? now
    if (!assignment.startedAt) {
      await this.prisma.examAssignment.update({
        where: { id: assignment.id },
        data: { status: 'started', startedAt },
      })

      // §4.1 exam_sessions — device info for §24's proctoring.
      await this.prisma.examSession.create({
        data: {
          tenantId: currentTenantId(),
          examAssignmentId: assignment.id,
          startedAt,
          deviceInfo: (input.deviceInfo ?? undefined) as never,
          ipAddress: input.ipAddress ?? null,
        },
      })
    }

    const deadline = this.deadlineFor(startedAt, exam.durationMinutes, closesAt)
    if (now > deadline) {
      throw ApiError.conflict('Your time for this exam has run out', [
        { field: 'duration', message: 'The exam was auto-submitted' },
      ])
    }

    // §13.1 step 3: the language chosen for this attempt, falling back to the
    // employee's stored preference.
    const language = input.language ?? assignment.employee.preferredLanguage

    const paper = buildPaper(exam.examQuestions, language as Language, assignment.id, {
      shuffleQuestions: exam.shuffleQuestions ?? true,
      shuffleOptions: exam.shuffleOptions ?? true,
    })

    // Answers already saved, so a reload restores what was typed.
    const saved = await this.prisma.examResponse.findMany({
      where: { examAssignmentId: assignment.id },
      select: {
        examQuestionId: true,
        selectedOptionId: true,
        theoryAnswer: true,
        mediaUrls: true,
        isFlagged: true,
        isSkipped: true,
      },
    })

    return {
      assignmentId: assignment.id,
      exam: {
        id: exam.id,
        examCode: exam.examCode,
        name: exam.nameEn,
        totalMarks: exam.totalMarks,
        passingPercentage: exam.passingPercentage,
        durationMinutes: exam.durationMinutes,
        allowBackNavigation: exam.allowBackNavigation,
        allowReview: exam.allowReview,
      },
      language,
      startedAt,
      /** Authoritative. The client's own countdown is decoration. */
      deadline,
      remainingSeconds: Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000)),
      questions: paper,
      answers: saved,
    }
  }

  /**
   * §5.3 POST /staff/exams/:id/answer — autosave, one question at a time.
   *
   * §21 (offline sync) will replay these, so it is an upsert: the same answer
   * arriving twice must be harmless.
   */
  async answer(employeeId: string, examId: string, input: AnswerInput, now = new Date()) {
    const assignment = await this.loadAssignment(employeeId, examId)

    if (assignment.status !== 'started') {
      throw ApiError.conflict(
        assignment.status === 'submitted' || assignment.status === 'graded'
          ? 'You have already submitted this exam'
          : 'You have not started this exam'
      )
    }

    const closesAt = combine(assignment.exam.scheduledDate, assignment.exam.endTime)
    const deadline = this.deadlineFor(
      assignment.startedAt!,
      assignment.exam.durationMinutes,
      closesAt
    )

    // A small grace: a phone on restaurant WiFi can take seconds to deliver the
    // last answer, and rejecting it because the request landed at T+3s would
    // punish the network rather than the candidate.
    if (now.getTime() > deadline.getTime() + GRACE_SECONDS * 1000) {
      throw ApiError.conflict('Your time for this exam has run out')
    }

    const examQuestion = assignment.exam.examQuestions.find((eq) => eq.id === input.examQuestionId)
    if (!examQuestion) {
      // The question is not on this paper — either a bug or someone probing.
      throw ApiError.notFound('That question is not part of this exam')
    }

    const type = examQuestion.question.type
    this.assertAnswerMatchesType(type, input)

    await this.prisma.examResponse.upsert({
      where: {
        examAssignmentId_examQuestionId: {
          examAssignmentId: assignment.id,
          examQuestionId: examQuestion.id,
        },
      },
      create: {
        tenantId: currentTenantId(),
        examAssignmentId: assignment.id,
        examQuestionId: examQuestion.id,
        questionId: examQuestion.question.id,
        responseType: type,
        selectedOptionId: input.selectedOptionId ?? null,
        theoryAnswer: input.theoryAnswer ?? null,
        theoryAnswerLanguage: input.theoryAnswerLanguage ?? null,
        mediaUrls: input.mediaUrls ?? [],
        mediaType: input.mediaType ?? null,
        maxMarks: examQuestion.marks,
        isFlagged: input.isFlagged ?? false,
        isSkipped: input.isSkipped ?? false,
        timeSpentSeconds: input.timeSpentSeconds ?? null,
        answeredAt: now,
      },
      update: {
        /**
         * Guarded, not `?? null`.
         *
         * §13.1 step 9 makes flagging its own action, and answerSchema permits
         * a request carrying ONLY isFlagged. Writing `selectedOptionId ?? null`
         * unconditionally meant flagging a question you had already answered
         * silently erased the answer — and the candidate would have no reason
         * to suspect it until they saw their marks.
         */
        ...(input.selectedOptionId !== undefined
          ? { selectedOptionId: input.selectedOptionId }
          : {}),
        ...(input.theoryAnswer !== undefined ? { theoryAnswer: input.theoryAnswer } : {}),
        ...(input.theoryAnswerLanguage !== undefined
          ? { theoryAnswerLanguage: input.theoryAnswerLanguage }
          : {}),
        ...(input.mediaUrls ? { mediaUrls: input.mediaUrls } : {}),
        ...(input.mediaType ? { mediaType: input.mediaType } : {}),
        ...(input.isFlagged !== undefined ? { isFlagged: input.isFlagged } : {}),
        ...(input.isSkipped !== undefined ? { isSkipped: input.isSkipped } : {}),
        ...(input.timeSpentSeconds !== undefined
          ? { timeSpentSeconds: input.timeSpentSeconds }
          : {}),
        answeredAt: now,
      },
    })

    return {
      saved: true,
      remainingSeconds: Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000)),
    }
  }

  /**
   * §5.3 POST /staff/exams/:id/submit — §13.1 steps 10-11.
   *
   * MCQs are auto-graded here (§10.1 "Auto-graded instantly"). Theory and
   * video/image go to Module 8's queue.
   */
  async submit(employeeId: string, examId: string, now = new Date()) {
    const assignment = await this.loadAssignment(employeeId, examId)

    if (['submitted', 'graded'].includes(assignment.status)) {
      throw ApiError.conflict('You have already submitted this exam')
    }
    if (assignment.status !== 'started') {
      throw ApiError.conflict('You have not started this exam')
    }

    const responses = await this.prisma.examResponse.findMany({
      where: { examAssignmentId: assignment.id },
      include: {
        question: { select: { id: true, type: true, options: true, negativeMarks: true } },
      },
    })

    let autoMarks = 0

    /**
     * Derived from what is ON THE PAPER, not from the answers given.
     *
     * Deriving it from the responses meant a candidate who simply skipped every
     * theory question had their paper auto-marked `graded` and never seen by a
     * human — the blank answers scored nothing, the MCQ score became the whole
     * result, and Module 8's queue never heard about it.
     */
    const needsManualGrading = assignment.exam.examQuestions.some(
      (eq) => eq.question.type !== 'mcq'
    )

    await this.prisma.$transaction(async (tx) => {
      for (const response of responses) {
        // Only MCQs are auto-gradeable (§10.1). The rest wait for Module 8.
        if (response.question.type !== 'mcq') continue

        const correct = correctOptionId(response.question.options)
        const isCorrect = correct !== null && response.selectedOptionId === correct

        // §10.1's negative marking. A skipped question scores zero, not a
        // penalty — guessing is discouraged, not answering at all is not
        // punished twice.
        const marks = isCorrect
          ? Number(response.maxMarks)
          : response.selectedOptionId
            ? -Number(response.question.negativeMarks ?? 0)
            : 0

        autoMarks += marks

        await tx.examResponse.update({
          where: { id: response.id },
          data: {
            isCorrect,
            marksObtained: marks,
            isAutoGraded: true,
            gradedAt: now,
          },
        })
      }

      // A whole-paper score is only meaningful once everything is marked.
      // Module 8 finalises the assignments that still need a human.
      const total = Number(assignment.exam.totalMarks)
      const percentage = total > 0 ? (autoMarks / total) * 100 : 0

      await tx.examAssignment.update({
        where: { id: assignment.id },
        data: {
          status: needsManualGrading ? 'submitted' : 'graded',
          submittedAt: now,
          ...(needsManualGrading
            ? {}
            : {
                gradedAt: now,
                totalMarksObtained: autoMarks,
                percentage,
                passed: percentage >= Number(assignment.exam.passingPercentage),
                grade: gradeFor(percentage),
              }),
        },
      })

      await tx.examSession.updateMany({
        where: { examAssignmentId: assignment.id, endedAt: null },
        data: { endedAt: now },
      })
    })

    return {
      submitted: true,
      // §11.1 step 5's "Show result immediately". Anything needing a human is
      // never immediate, whatever the setting says.
      resultAvailable: !needsManualGrading && (assignment.exam.showResultImmediately ?? false),
      awaitingGrading: needsManualGrading,
    }
  }

  /** §5.3 GET /staff/exams/:id/result. */
  async result(employeeId: string, examId: string) {
    const assignment = await this.loadAssignment(employeeId, examId)

    if (assignment.status !== 'graded') {
      throw ApiError.conflict(
        assignment.status === 'submitted'
          ? 'Your exam is still being graded'
          : 'You have not completed this exam'
      )
    }

    if (!assignment.exam.showResultImmediately) {
      // §11.1 step 5: an exam can withhold results until management releases
      // them. Module 8's finalise is what flips that.
      throw ApiError.conflict('Results for this exam have not been released yet')
    }

    const responses = await this.prisma.examResponse.findMany({
      where: { examAssignmentId: assignment.id },
      select: {
        examQuestionId: true,
        marksObtained: true,
        maxMarks: true,
        isCorrect: true,
        graderComments: true,
        question: {
          select: {
            id: true,
            type: true,
            questionTextEn: true,
            questionTextHi: true,
            questionTextGu: true,
            explanationEn: true,
            explanationHi: true,
            explanationGu: true,
          },
        },
      },
    })

    return {
      examCode: assignment.exam.examCode,
      totalMarksObtained: assignment.totalMarksObtained,
      totalMarks: assignment.exam.totalMarks,
      percentage: assignment.percentage,
      grade: assignment.grade,
      passed: assignment.passed,
      supervisorRemarks: assignment.supervisorRemarks,
      responses,
    }
  }

  // --- Helpers --------------------------------------------------------------

  /**
   * The deadline is whichever comes first: the candidate's own duration from
   * when they started, or the exam window closing.
   *
   * Without the second, someone starting a 60-minute exam 10 minutes before the
   * window shuts would keep answering for 50 minutes after it closed.
   */
  private deadlineFor(startedAt: Date, durationMinutes: number, closesAt: Date): Date {
    const byDuration = new Date(startedAt.getTime() + durationMinutes * 60_000)
    return byDuration < closesAt ? byDuration : closesAt
  }

  private async loadAssignment(employeeId: string, examId: string) {
    const assignment = await this.prisma.examAssignment.findFirst({
      // Resolved from the session's employeeId, never from a request field.
      where: { examId, employeeId },
      include: {
        employee: { select: { id: true, preferredLanguage: true } },
        exam: {
          include: {
            examQuestions: {
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                sortOrder: true,
                marks: true,
                question: {
                  // Explicitly selected. expectedAnswer* and rubric are absent
                  // by construction, so nothing downstream can leak them.
                  select: {
                    id: true,
                    type: true,
                    marks: true,
                    negativeMarks: true,
                    questionTextEn: true,
                    questionTextHi: true,
                    questionTextGu: true,
                    instructionsEn: true,
                    instructionsHi: true,
                    instructionsGu: true,
                    imageUrl: true,
                    videoUrl: true,
                    audioUrl: true,
                    timeLimitSeconds: true,
                    options: true,
                    minWordLimit: true,
                    maxWordLimit: true,
                    responseType: true,
                    maxFileSizeMb: true,
                    maxVideoDurationSeconds: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!assignment) {
      // 404, not 403: confirming the exam exists would tell a candidate about
      // papers set for other outlets.
      throw ApiError.notFound('You have not been assigned to this exam')
    }
    return assignment
  }

  private assertAnswerMatchesType(type: string, input: AnswerInput): void {
    if (type === 'mcq' && input.theoryAnswer) {
      throw ApiError.validation('That is a multiple-choice question', [
        { field: 'theoryAnswer', message: 'Send selectedOptionId instead' },
      ])
    }
    if (type === 'theory' && input.selectedOptionId) {
      throw ApiError.validation('That is a theory question', [
        { field: 'selectedOptionId', message: 'Send theoryAnswer instead' },
      ])
    }
    if (type === 'video_image' && !input.mediaUrls && !input.isSkipped) {
      throw ApiError.validation('That question needs an uploaded response', [
        { field: 'mediaUrls', message: 'Upload the file first, then send its URL' },
      ])
    }
  }
}

/** §4.1's grade column: A+, A, B+, B, C, F. */
export function gradeFor(percentage: number): string {
  if (percentage >= 90) return 'A+'
  if (percentage >= 80) return 'A'
  if (percentage >= 70) return 'B+'
  if (percentage >= 60) return 'B'
  if (percentage >= 40) return 'C'
  return 'F'
}
