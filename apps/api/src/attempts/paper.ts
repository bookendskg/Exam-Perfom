import { z } from 'zod'
import { resolveLanguage, resolvedLanguageOf, type Language } from '@bookends/core'
import type { QuestionType } from '@bookends/db'

/**
 * Turning an exam's questions into the paper one candidate sees.
 *
 * Two things happen here and both are security-relevant:
 *
 *  1. The answer key is removed. `Question.options` carries `isCorrect` on
 *     every option, so handing the stored JSON to a candidate hands them the
 *     answers. Stripping happens in this module, on the way out, so there is
 *     one place to audit rather than one per endpoint.
 *  2. The order is shuffled deterministically. §11.1's `shuffleQuestions` and
 *     `shuffleOptions` mean two people sitting side by side see different
 *     papers — but the SAME person must see the same paper when their phone
 *     drops WiFi mid-exam and reconnects. A random shuffle would reorder the
 *     paper under them and turn "question 4" into a different question between
 *     autosaves.
 *
 * The order is therefore derived from the assignment id rather than stored: a
 * pure function of (assignment, exam question ids) is stable across restarts,
 * needs no migration, and cannot drift out of sync with the saved responses —
 * which are keyed on examQuestionId, never on position.
 */

/** §10.1's MCQ option shape, as stored in `Question.options`. */
const storedOption = z.object({
  id: z.string(),
  textEn: z.string(),
  textHi: z.string().nullish(),
  textGu: z.string().nullish(),
  isCorrect: z.boolean(),
  imageUrl: z.string().nullish(),
})

export const storedOptionsSchema = z.array(storedOption)
export type StoredOption = z.infer<typeof storedOption>

/**
 * Reads `Question.options` defensively.
 *
 * The column is JSONB, so nothing in the database guarantees its shape — a
 * bulk import (Module 4) or a hand-run SQL fix can put anything there. Callers
 * get an empty list rather than an exception, and the caller decides whether
 * that is fatal: it is when grading, but it must not crash a whole paper when
 * merely rendering it.
 */
export function parseOptions(raw: unknown): StoredOption[] {
  const parsed = storedOptionsSchema.safeParse(raw)
  return parsed.success ? parsed.data : []
}

export interface PaperQuestionSource {
  id: string
  sortOrder: number
  marks: unknown
  isMandatory: boolean
  question: {
    id: string
    type: QuestionType
    questionTextEn: string
    questionTextHi?: string | null
    questionTextGu?: string | null
    instructionsEn?: string | null
    instructionsHi?: string | null
    instructionsGu?: string | null
    imageUrl?: string | null
    videoUrl?: string | null
    audioUrl?: string | null
    options?: unknown
    timeLimitSeconds?: number | null
    negativeMarks?: unknown
    minWordLimit?: number | null
    maxWordLimit?: number | null
    responseType?: string | null
    maxFileSizeMb?: number | null
    maxVideoDurationSeconds?: number | null
    rubric?: unknown
  }
}

export interface PaperOptions {
  language: Language
  shuffleQuestions: boolean
  shuffleOptions: boolean
  /** Seed source. The assignment id makes the paper per-candidate and stable. */
  assignmentId: string
}

/**
 * Builds the candidate-facing paper.
 *
 * Note what is NOT here: `explanation*` and `expectedAnswer*` are the model
 * answers, and `rubric` is the grading scheme. None of them are selected —
 * they belong to the result view (after submission) and to Module 8's grading
 * screens, not to the paper.
 */
export function buildPaper(sources: PaperQuestionSource[], opts: PaperOptions) {
  const ordered = [...sources].sort((a, b) => a.sortOrder - b.sortOrder)
  const questions = opts.shuffleQuestions
    ? shuffle(ordered, seedFrom(opts.assignmentId, 'questions'))
    : ordered

  return questions.map((eq, index) => {
    const q = eq.question
    const text = { en: q.questionTextEn, hi: q.questionTextHi, gu: q.questionTextGu }
    const instructions = {
      en: q.instructionsEn ?? '',
      hi: q.instructionsHi,
      gu: q.instructionsGu,
    }

    return {
      // The candidate answers against examQuestionId — the position is display
      // only, which is what makes shuffling safe.
      examQuestionId: eq.id,
      position: index + 1,
      type: q.type,
      marks: Number(eq.marks),
      negativeMarks: q.negativeMarks == null ? 0 : Number(q.negativeMarks),
      isMandatory: eq.isMandatory,
      timeLimitSeconds: q.timeLimitSeconds ?? null,

      questionText: resolveLanguage(text, opts.language),
      // §6.3: the APK needs the language it actually got to pick the font.
      questionTextLanguage: resolvedLanguageOf(text, opts.language),
      instructions: q.instructionsEn ? resolveLanguage(instructions, opts.language) : null,

      imageUrl: q.imageUrl ?? null,
      videoUrl: q.videoUrl ?? null,
      audioUrl: q.audioUrl ?? null,

      ...typeSpecific(eq, opts),
    }
  })
}

function typeSpecific(eq: PaperQuestionSource, opts: PaperOptions) {
  const q = eq.question

  if (q.type === 'mcq') {
    const parsed = parseOptions(q.options)
    const options = opts.shuffleOptions
      ? // Seeded per question, not per paper: otherwise every question's
        // options would be permuted identically and "the answer is always C"
        // would still hold.
        shuffle(parsed, seedFrom(opts.assignmentId, 'options', eq.id))
      : parsed

    return {
      options: options.map((o) => ({
        id: o.id,
        text: resolveLanguage({ en: o.textEn, hi: o.textHi, gu: o.textGu }, opts.language),
        imageUrl: o.imageUrl ?? null,
        // isCorrect is deliberately absent. See the module comment.
      })),
    }
  }

  if (q.type === 'theory') {
    return {
      minWordLimit: q.minWordLimit ?? null,
      maxWordLimit: q.maxWordLimit ?? null,
    }
  }

  return {
    responseType: q.responseType ?? null,
    maxFileSizeMb: q.maxFileSizeMb ?? null,
    maxVideoDurationSeconds: q.maxVideoDurationSeconds ?? null,
    /**
     * The rubric's criteria are shown without their marks — §10.1 expects the
     * candidate to know what they are being judged on, but the weighting is
     * the grader's. `rubricCriteria` is derived, so a malformed rubric yields
     * an empty list rather than leaking the raw JSON.
     */
    rubricCriteria: rubricCriteriaOf(q.rubric),
  }
}

const rubricSchema = z.array(z.object({ criterion: z.string() }).passthrough())

function rubricCriteriaOf(raw: unknown): string[] {
  const parsed = rubricSchema.safeParse(raw)
  return parsed.success ? parsed.data.map((r) => r.criterion) : []
}

/**
 * FNV-1a over the parts, joined.
 *
 * Not cryptographic and not meant to be — it only needs to spread ids across
 * the seed space deterministically. Predicting it buys an attacker the order
 * of their own paper, which they can already see.
 */
export function seedFrom(...parts: string[]): number {
  let hash = 0x811c9dc5
  const input = parts.join(':')
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** mulberry32 — small, fast, and deterministic across Node versions. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates. Returns a new array; the input is not mutated. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  const random = prng(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}
