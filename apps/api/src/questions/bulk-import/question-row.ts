import type { PrismaClient } from '@bookends/db'
import type { RawRow } from '../../bulk-import/parse.js'

/**
 * §10.4's CSV format:
 *
 *   type,difficulty,department,topic,question_en,question_hi,question_gu,
 *   option_a_en,option_a_hi,option_a_gu,option_b_en,...,correct_option,marks,
 *   explanation_en,source_document,source_chapter
 *
 * Two things make this different from the employee importer (§8.3):
 *
 *  1. Options are FLATTENED across twelve columns (option_a_en … option_d_gu)
 *     and have to be reassembled into the JSON array the schema expects, with
 *     `correct_option` (A/B/C/D) deciding which one is right.
 *  2. Every text column is trilingual, so a translator's blank cell arrives as
 *     '' and must become null rather than an empty translation that §6.2's
 *     fallback would then happily serve to a staff member.
 */

/** §10.4's required columns. Option columns are required only for MCQ rows. */
export const QUESTION_IMPORT_COLUMNS = [
  'type',
  'difficulty',
  'department',
  'topic',
  'question_en',
] as const

export const OPTION_LETTERS = ['a', 'b', 'c', 'd'] as const

export interface RowError {
  field: string
  message: string
}

export interface QuestionLookup {
  departmentsByKey: Map<string, string>
  topicsByKey: Map<string, { id: string; departmentId: string | null }>
  documentsByKey: Map<string, string>
  outletsByCode: Map<string, string>
}

const key = (s: string) => s.trim().toLowerCase()

export async function loadQuestionLookup(prisma: PrismaClient): Promise<QuestionLookup> {
  const [departments, topics, documents, outlets] = await Promise.all([
    prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true },
    }),
    prisma.topic.findMany({
      where: { isActive: true },
      select: { id: true, nameEn: true, departmentId: true },
    }),
    prisma.sourceDocument.findMany({
      where: { isActive: true },
      select: { id: true, title: true },
    }),
    prisma.outlet.findMany({ where: { isActive: true }, select: { id: true, code: true } }),
  ])

  const departmentsByKey = new Map<string, string>()
  for (const d of departments) {
    departmentsByKey.set(key(d.code), d.id)
    departmentsByKey.set(key(d.name), d.id)
  }

  return {
    departmentsByKey,
    topicsByKey: new Map(
      topics.map((t) => [key(t.nameEn), { id: t.id, departmentId: t.departmentId }])
    ),
    documentsByKey: new Map(documents.map((d) => [key(d.title), d.id])),
    outletsByCode: new Map(outlets.map((o) => [key(o.code), o.id])),
  }
}

/** '' means "no translation", not "an empty translation". */
function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Reassembles the four MCQ options from §10.4's twelve flat columns.
 *
 * `correct_option` is a letter (A/B/C/D). Anything else — a missing letter, a
 * letter whose option has no text — is a row error, because an MCQ with no
 * correct answer is auto-graded as always-wrong and nobody would notice until
 * the whole outlet failed the question.
 */
export function buildOptions(values: Record<string, string>): {
  options?: unknown[]
  errors: RowError[]
} {
  const errors: RowError[] = []
  const correct = key(values['correct_option'] ?? '')

  if (!correct) {
    errors.push({ field: 'correct_option', message: 'Required for an MCQ (A, B, C or D)' })
  } else if (!(OPTION_LETTERS as readonly string[]).includes(correct)) {
    errors.push({
      field: 'correct_option',
      message: `Must be one of A, B, C, D — got "${values['correct_option']}"`,
    })
  }

  const options = OPTION_LETTERS.map((letter) => {
    const textEn = optional(values[`option_${letter}_en`])
    if (!textEn) {
      errors.push({
        field: `option_${letter}_en`,
        message: `Option ${letter.toUpperCase()} needs English text (§10.1 requires 4 options)`,
      })
    }
    return {
      id: letter,
      textEn: textEn ?? '',
      textHi: optional(values[`option_${letter}_hi`]),
      textGu: optional(values[`option_${letter}_gu`]),
      isCorrect: letter === correct,
    }
  })

  if (errors.length > 0) return { errors }
  return { options, errors: [] }
}

export interface MappedRow {
  input: Record<string, unknown>
  errors: RowError[]
}

/**
 * Maps a §10.4 row onto the JSON shape createQuestionSchema validates. Resolves
 * department/topic/document by name, since a spreadsheet has no UUIDs.
 *
 * Returns errors rather than throwing: §8.3's partial-import contract applies
 * here too — one bad row must not reject a 200-row cookbook.
 */
export function mapQuestionRow(raw: RawRow, lookup: QuestionLookup): MappedRow {
  const v = raw.values
  const errors: RowError[] = []

  const type = key(v['type'] ?? '')
  if (!['mcq', 'theory', 'video_image'].includes(type)) {
    errors.push({
      field: 'type',
      message: `Must be mcq, theory or video_image — got "${v['type'] ?? ''}"`,
    })
  }

  const departmentId = lookup.departmentsByKey.get(key(v['department'] ?? ''))
  if (!departmentId) {
    errors.push({ field: 'department', message: `Unknown department "${v['department'] ?? ''}"` })
  }

  const topic = lookup.topicsByKey.get(key(v['topic'] ?? ''))
  if (!topic) {
    errors.push({ field: 'topic', message: `Unknown topic "${v['topic'] ?? ''}"` })
  } else if (departmentId && topic.departmentId && topic.departmentId !== departmentId) {
    // Same coherence check the JSON API applies: a Food Safety topic filed
    // under Service would categorise the question where nobody looks for it.
    errors.push({
      field: 'topic',
      message: `Topic "${v['topic']}" does not belong to the "${v['department']}" department`,
    })
  }

  let sourceDocumentId: string | undefined
  const documentName = optional(v['source_document'])
  if (documentName) {
    sourceDocumentId = lookup.documentsByKey.get(key(documentName))
    if (!sourceDocumentId) {
      errors.push({
        field: 'source_document',
        message: `Unknown source document "${documentName}"`,
      })
    }
  }

  let outletId: string | null = null
  const outletCode = optional(v['outlet_code'])
  if (outletCode) {
    outletId = lookup.outletsByCode.get(key(outletCode)) ?? null
    if (!outletId) {
      errors.push({ field: 'outlet_code', message: `Unknown outlet code "${outletCode}"` })
    }
  }

  const input: Record<string, unknown> = {
    type,
    difficulty: optional(v['difficulty']) ?? 'medium',
    departmentId,
    topicId: topic?.id,
    outletId,
    questionTextEn: optional(v['question_en']) ?? '',
    questionTextHi: optional(v['question_hi']),
    questionTextGu: optional(v['question_gu']),
    explanationEn: optional(v['explanation_en']),
    explanationHi: optional(v['explanation_hi']),
    explanationGu: optional(v['explanation_gu']),
    marks: optional(v['marks']) ?? '1',
    sourceDocumentId,
    sourceChapter: optional(v['source_chapter']),
    sourcePage: optional(v['source_page']),
    tags: optional(v['tags'])
      ?.split('|')
      .map((t) => t.trim())
      .filter(Boolean),
  }

  if (type === 'mcq') {
    const { options, errors: optionErrors } = buildOptions(v)
    errors.push(...optionErrors)
    if (options) input['options'] = options
    const negative = optional(v['negative_marks'])
    if (negative) input['negativeMarks'] = negative
  }

  if (type === 'theory') {
    input['expectedAnswerEn'] = optional(v['expected_answer_en'])
    input['expectedAnswerHi'] = optional(v['expected_answer_hi'])
    input['expectedAnswerGu'] = optional(v['expected_answer_gu'])
    const min = optional(v['min_word_limit'])
    const max = optional(v['max_word_limit'])
    if (min) input['minWordLimit'] = min
    if (max) input['maxWordLimit'] = max
  }

  if (type === 'video_image') {
    input['responseType'] = optional(v['response_type']) ?? 'image'
    // §10.4's format has no rubric columns, and §10.1 makes a rubric mandatory
    // for this type — a rubric is a variable-length list of criteria and does
    // not flatten into a CSV row sensibly.
    errors.push({
      field: 'type',
      message:
        'video_image questions cannot be imported: §10.1 requires a rubric, which §10.4 has no columns for. Create them through the API.',
    })
  }

  return { input, errors }
}
