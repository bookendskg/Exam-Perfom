import { describe, it, expect } from 'vitest'
import { examWindow, deadlineFor, windowStateAt } from '../src/attempts/attempt-window.js'
import { gradeMcq, gradeFor, summarise } from '../src/attempts/grading.js'
import { buildPaper, shuffle, seedFrom, type PaperQuestionSource } from '../src/attempts/paper.js'

/**
 * Module 7's pure logic. No database, no clock, no HTTP — these are the rules
 * that decide whether someone's marks are right, so they are tested where
 * every case can be enumerated.
 */

/** Prisma hands back a DATE as UTC midnight and a TIME as 1970-01-01T<time>Z. */
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`)

const timing = (day: string, start: string, end: string) => ({
  scheduledDate: date(day),
  startTime: time(start),
  endTime: time(end),
})

// The IST → instant conversion itself is tested in exam-date.test.ts, where it
// now lives. What is tested here is what attempts add on top of it.
describe('window state', () => {
  it('classifies before, during and after', () => {
    const window = examWindow(timing('2027-03-15', '10:00', '12:00'))

    expect(windowStateAt(window, new Date('2027-03-15T04:29:59Z'))).toBe('not_yet_open')
    expect(windowStateAt(window, new Date('2027-03-15T04:30:00Z'))).toBe('open')
    expect(windowStateAt(window, new Date('2027-03-15T06:29:59Z'))).toBe('open')
    // The close is exclusive: at 12:00:00 IST sharp the exam is over.
    expect(windowStateAt(window, new Date('2027-03-15T06:30:00Z'))).toBe('closed')
  })
})

describe('attempt deadlines', () => {
  const window = examWindow(timing('2027-03-15', '10:00', '12:00'))

  it('gives the full duration to someone who starts on time', () => {
    const startedAt = new Date('2027-03-15T04:30:00Z')
    expect(deadlineFor(window, startedAt, 60).toISOString()).toBe('2027-03-15T05:30:00.000Z')
  })

  it('is cut short by the window for a late starter', () => {
    // Starts 20 minutes before the hall closes with a 60 minute exam.
    const startedAt = new Date('2027-03-15T06:10:00Z')
    expect(deadlineFor(window, startedAt, 60).toISOString()).toBe('2027-03-15T06:30:00.000Z')
  })
})

describe('§10.1 MCQ auto-grading', () => {
  const options = [
    { id: 'a', textEn: 'A', isCorrect: false },
    { id: 'b', textEn: 'B', isCorrect: true },
    { id: 'c', textEn: 'C', isCorrect: false },
    { id: 'd', textEn: 'D', isCorrect: false },
  ]

  it('awards the exam question marks for the correct option', () => {
    expect(gradeMcq(options, 'b', 2, 0.5)).toEqual({ isCorrect: true, marksObtained: 2 })
  })

  it('applies negative marking to a wrong answer', () => {
    expect(gradeMcq(options, 'a', 2, 0.5)).toEqual({ isCorrect: false, marksObtained: -0.5 })
  })

  it('never penalises an unanswered question', () => {
    expect(gradeMcq(options, null, 2, 0.5)).toEqual({ isCorrect: false, marksObtained: 0 })
  })

  it('scores zero without a penalty when no option is marked correct', () => {
    // A data problem, not a wrong answer — everybody would otherwise lose
    // marks for a bad import.
    const broken = options.map((o) => ({ ...o, isCorrect: false }))
    expect(gradeMcq(broken, 'a', 2, 0.5)).toEqual({ isCorrect: false, marksObtained: 0 })
  })

  it('survives an options column that is not an options array', () => {
    expect(gradeMcq(null, 'a', 2, 0.5).marksObtained).toBe(0)
    expect(gradeMcq({ nonsense: true }, 'a', 2, 0.5).marksObtained).toBe(0)
  })
})

describe('grade bands', () => {
  it('maps percentages to §11.1 letters', () => {
    expect(gradeFor(95, 40)).toBe('A+')
    expect(gradeFor(90, 40)).toBe('A+')
    expect(gradeFor(85, 40)).toBe('A')
    expect(gradeFor(75, 40)).toBe('B+')
    expect(gradeFor(65, 40)).toBe('B')
    expect(gradeFor(45, 40)).toBe('C')
    expect(gradeFor(39.99, 40)).toBe('F')
  })

  it('defines F against the exam pass mark, not a fixed 40', () => {
    // An exam that passes at 60 must not hand a C to someone on 45.
    expect(gradeFor(45, 60)).toBe('F')
    expect(gradeFor(65, 60)).toBe('B')
  })
})

describe('score summaries', () => {
  const mcq = (marksObtained: number | null, maxMarks = 1) =>
    ({ responseType: 'mcq', marksObtained, maxMarks }) as const

  it('totals marks and computes a percentage against the exam total', () => {
    const summary = summarise([mcq(1), mcq(1), mcq(1), mcq(0)], 4, 40)

    expect(summary.totalMarksObtained).toBe(3)
    expect(summary.percentage).toBe(75)
    expect(summary.grade).toBe('B+')
    expect(summary.passed).toBe(true)
    expect(summary.awaitingManualGrading).toBe(false)
  })

  it('floors a negatively-marked wipeout at zero', () => {
    const summary = summarise([mcq(-0.5), mcq(-0.5), mcq(-0.5)], 3, 40)

    expect(summary.totalMarksObtained).toBe(0)
    expect(summary.percentage).toBe(0)
    expect(summary.grade).toBe('F')
  })

  it('flags an attempt that still needs a human', () => {
    const summary = summarise(
      [mcq(1), { responseType: 'theory', marksObtained: null, maxMarks: 5 }],
      6,
      40
    )
    expect(summary.awaitingManualGrading).toBe(true)
  })

  it('does not wait on a theory answer a grader has already marked', () => {
    const summary = summarise(
      [mcq(1), { responseType: 'theory', marksObtained: 4, maxMarks: 5 }],
      6,
      40
    )
    expect(summary.awaitingManualGrading).toBe(false)
    expect(summary.totalMarksObtained).toBe(5)
  })

  it('rounds to the two decimals the column stores', () => {
    const summary = summarise([mcq(1), mcq(0)], 3, 40)
    expect(summary.percentage).toBe(33.33)
  })
})

describe('paper assembly', () => {
  const question = (i: number): PaperQuestionSource => ({
    id: `eq-${i}`,
    sortOrder: i,
    marks: 1,
    isMandatory: true,
    question: {
      id: `q-${i}`,
      type: 'mcq',
      questionTextEn: `Question ${i}`,
      questionTextHi: `प्रश्न ${i}`,
      questionTextGu: null,
      options: [
        { id: 'a', textEn: 'A', isCorrect: true },
        { id: 'b', textEn: 'B', isCorrect: false },
        { id: 'c', textEn: 'C', isCorrect: false },
        { id: 'd', textEn: 'D', isCorrect: false },
      ],
    },
  })

  const sources = Array.from({ length: 12 }, (_, i) => question(i))
  const opts = {
    language: 'en' as const,
    shuffleQuestions: true,
    shuffleOptions: true,
    assignmentId: 'assignment-1',
  }

  it('never exposes which option is correct', () => {
    const paper = buildPaper(sources, opts)
    expect(JSON.stringify(paper)).not.toContain('isCorrect')
  })

  it('is stable across calls, so a reconnecting phone sees the same paper', () => {
    // The whole reason the order is seeded rather than random: an autosave
    // keyed on "question 4" must still mean the same question after a
    // dropped connection.
    expect(buildPaper(sources, opts)).toEqual(buildPaper(sources, opts))
  })

  it('differs between candidates', () => {
    const mine = buildPaper(sources, opts).map((q) => q.examQuestionId)
    const theirs = buildPaper(sources, { ...opts, assignmentId: 'assignment-2' }).map(
      (q) => q.examQuestionId
    )
    expect(mine).not.toEqual(theirs)
  })

  it('does not permute every question’s options identically', () => {
    // Otherwise "the answer is always the second one" survives the shuffle.
    const paper = buildPaper(sources, opts)
    const orders = new Set(paper.map((q) => q.options?.map((o) => o.id).join('')))
    expect(orders.size).toBeGreaterThan(1)
  })

  it('keeps the authored order when shuffling is off', () => {
    const paper = buildPaper(sources, { ...opts, shuffleQuestions: false })
    expect(paper.map((q) => q.examQuestionId)).toEqual(sources.map((s) => s.id))
    expect(paper.map((q) => q.position)).toEqual(sources.map((_, i) => i + 1))
  })

  it('§6.2 renders in the candidate’s language and reports what they got', () => {
    const [first] = buildPaper([question(1)], { ...opts, language: 'gu' })
    // No Gujarati, so the chain falls back to Hindi — and says so, because the
    // APK picks a font from it.
    expect(first!.questionText).toBe('प्रश्न 1')
    expect(first!.questionTextLanguage).toBe('hi')
  })
})

describe('seeded shuffle', () => {
  it('permutes rather than drops or duplicates', () => {
    const input = Array.from({ length: 50 }, (_, i) => i)
    const out = shuffle(input, seedFrom('any-assignment'))

    expect(out).toHaveLength(50)
    expect([...out].sort((a, b) => a - b)).toEqual(input)
    expect(out).not.toEqual(input)
  })

  it('does not mutate its input', () => {
    const input = [1, 2, 3, 4, 5]
    shuffle(input, 42)
    expect(input).toEqual([1, 2, 3, 4, 5])
  })

  it('handles empty and single-item lists', () => {
    expect(shuffle([], 1)).toEqual([])
    expect(shuffle(['only'], 1)).toEqual(['only'])
  })
})
