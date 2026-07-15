import { resolveLanguage, resolvedLanguageOf, type Language } from '@bookends/core'
import { seededShuffle, optionSeed } from './shuffle.js'

/**
 * Builds the paper a candidate actually sees.
 *
 * ── The one rule that matters ─────────────────────────────────────────────
 *
 * §4.1 stores an MCQ's options as JSON including `is_correct`, and a theory
 * question's `expected_answer_*` is the model answer shown to graders. Both sit
 * on the same row as the question text.
 *
 * So the ONLY thing standing between a candidate and the answer key is this
 * module deliberately not copying those fields across. Returning the question
 * row — or spreading it, or adding a field later without thinking — hands every
 * answer to anyone who opens dev tools or reads the APK's network traffic.
 *
 * Everything here is therefore built by explicit construction. Nothing is
 * spread, nothing is `...question`, and every field is named on purpose.
 */

export interface CandidateOption {
  id: string
  text: string
  textLanguage: Language
  imageUrl?: string
  // NO isCorrect. Ever.
}

export interface CandidateQuestion {
  examQuestionId: string
  questionId: string
  sortOrder: number
  type: 'mcq' | 'theory' | 'video_image'
  marks: number
  negativeMarks?: number
  questionText: string
  questionTextLanguage: Language
  instructions?: string
  imageUrl?: string
  videoUrl?: string
  audioUrl?: string
  timeLimitSeconds?: number
  /** MCQ only. */
  options?: CandidateOption[]
  /** Theory only — the limits, never the model answer. */
  minWordLimit?: number
  maxWordLimit?: number
  /** Video/image only — what to upload and the caps, never the rubric. */
  responseType?: 'image' | 'video' | 'both'
  maxFileSizeMb?: number
  maxVideoDurationSeconds?: number
}

/** The shape §4.1 gives us, with the sensitive fields present. */
export interface SourceQuestion {
  id: string
  type: string
  marks: unknown
  negativeMarks: unknown
  questionTextEn: string
  questionTextHi: string | null
  questionTextGu: string | null
  instructionsEn: string | null
  instructionsHi: string | null
  instructionsGu: string | null
  imageUrl: string | null
  videoUrl: string | null
  audioUrl: string | null
  timeLimitSeconds: number | null
  options: unknown
  minWordLimit: number | null
  maxWordLimit: number | null
  responseType: string | null
  maxFileSizeMb: number | null
  maxVideoDurationSeconds: number | null
  // expectedAnswer* and rubric are deliberately NOT in this type: if they are
  // not selected, they cannot be leaked by accident.
}

export interface SourceExamQuestion {
  id: string
  sortOrder: number
  marks: unknown
  question: SourceQuestion
}

interface StoredOption {
  id: string
  textEn: string
  textHi?: string | null
  textGu?: string | null
  isCorrect: boolean
  imageUrl?: string
}

export interface PaperSettings {
  shuffleQuestions: boolean
  shuffleOptions: boolean
}

/**
 * §13.1 step 3: the candidate picks a language for the exam, and §6.2's
 * fallback fills any gap.
 */
export function buildPaper(
  examQuestions: readonly SourceExamQuestion[],
  language: Language,
  assignmentId: string,
  settings: PaperSettings
): CandidateQuestion[] {
  const ordered = settings.shuffleQuestions
    ? seededShuffle(examQuestions, assignmentId)
    : [...examQuestions].sort((a, b) => a.sortOrder - b.sortOrder)

  return ordered.map((eq, index) =>
    toCandidateQuestion(eq, language, assignmentId, index, settings.shuffleOptions)
  )
}

function toCandidateQuestion(
  eq: SourceExamQuestion,
  language: Language,
  assignmentId: string,
  index: number,
  shuffleOptions: boolean
): CandidateQuestion {
  const q = eq.question

  const text = {
    en: q.questionTextEn,
    hi: q.questionTextHi,
    gu: q.questionTextGu,
  }
  const instructions = {
    en: q.instructionsEn ?? '',
    hi: q.instructionsHi,
    gu: q.instructionsGu,
  }

  const candidate: CandidateQuestion = {
    examQuestionId: eq.id,
    questionId: q.id,
    // The position the candidate sees, not the stored order — otherwise a
    // shuffled paper shows "Question 7" first.
    sortOrder: index,
    type: q.type as CandidateQuestion['type'],
    marks: Number(eq.marks),
    questionText: resolveLanguage(text, language),
    questionTextLanguage: resolvedLanguageOf(text, language),
  }

  if (q.negativeMarks !== null && Number(q.negativeMarks) > 0) {
    // Shown so a candidate can decide whether to guess (§10.1).
    candidate.negativeMarks = Number(q.negativeMarks)
  }
  if (q.instructionsEn) candidate.instructions = resolveLanguage(instructions, language)
  if (q.imageUrl) candidate.imageUrl = q.imageUrl
  if (q.videoUrl) candidate.videoUrl = q.videoUrl
  if (q.audioUrl) candidate.audioUrl = q.audioUrl
  if (q.timeLimitSeconds) candidate.timeLimitSeconds = q.timeLimitSeconds

  if (q.type === 'mcq') {
    candidate.options = toCandidateOptions(q, language, assignmentId, shuffleOptions)
  }

  if (q.type === 'theory') {
    // The limits, so the UI can show a word counter. NOT expectedAnswer*.
    if (q.minWordLimit !== null) candidate.minWordLimit = q.minWordLimit
    if (q.maxWordLimit !== null) candidate.maxWordLimit = q.maxWordLimit
  }

  if (q.type === 'video_image') {
    // What to upload and the caps. NOT the rubric — that is the mark scheme,
    // and handing it over tells the candidate exactly what to perform.
    if (q.responseType) candidate.responseType = q.responseType as CandidateQuestion['responseType']
    if (q.maxFileSizeMb !== null) candidate.maxFileSizeMb = q.maxFileSizeMb
    if (q.maxVideoDurationSeconds !== null) {
      candidate.maxVideoDurationSeconds = q.maxVideoDurationSeconds
    }
  }

  return candidate
}

function toCandidateOptions(
  q: SourceQuestion,
  language: Language,
  assignmentId: string,
  shuffle: boolean
): CandidateOption[] {
  const stored = Array.isArray(q.options) ? (q.options as StoredOption[]) : []

  const ordered = shuffle ? seededShuffle(stored, optionSeed(assignmentId, q.id)) : stored

  return ordered.map((option) => {
    const text = { en: option.textEn, hi: option.textHi, gu: option.textGu }

    // Constructed field by field. `{ ...option }` here would ship isCorrect to
    // every candidate, and it would look completely fine in review.
    const candidate: CandidateOption = {
      id: option.id,
      text: resolveLanguage(text, language),
      textLanguage: resolvedLanguageOf(text, language),
    }
    if (option.imageUrl) candidate.imageUrl = option.imageUrl
    return candidate
  })
}

/** Server-side grading needs the key, so it reads the stored options directly. */
export function correctOptionId(options: unknown): string | null {
  if (!Array.isArray(options)) return null
  const correct = (options as StoredOption[]).find((o) => o.isCorrect)
  return correct?.id ?? null
}
