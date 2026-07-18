import { BOOKENDS_TIMEZONE } from '../scheduling/exam-date.js'

/**
 * When an exam may actually be sat, in real instants.
 *
 * An Exam stores `scheduledDate` (a DATE) and `startTime`/`endTime` (TIMEs)
 * separately, and those wall-clock values are IST — §12.1 schedules exams for
 * Indian restaurant shifts, not for UTC. Turning them into an instant is
 * therefore a timezone conversion, and getting it wrong is not a rounding
 * error: a 10:00–12:00 exam read as UTC opens at 15:30 IST, three and a half
 * hours after the staff sitting it were told to start.
 *
 * India has never observed DST and IST has been a fixed UTC+05:30 since 1945,
 * so the offset is a constant rather than an Intl lookup. That is a deliberate
 * simplification of exactly one zone — {@link BOOKENDS_TIMEZONE} — and the
 * assertion below fails loudly if that zone is ever changed to one with DST.
 */
const IST_OFFSET_MINUTES = 330

if (BOOKENDS_TIMEZONE !== 'Asia/Kolkata') {
  throw new Error(
    `attempt-window assumes a fixed +05:30 offset, which only holds for Asia/Kolkata, ` +
      `but BOOKENDS_TIMEZONE is ${BOOKENDS_TIMEZONE}. Replace the constant with a real ` +
      `timezone conversion before shipping.`
  )
}

export interface ExamWindow {
  /** The instant the exam opens. */
  opensAt: Date
  /** The instant the exam closes for everyone, regardless of when they started. */
  closesAt: Date
}

export interface ExamTiming {
  scheduledDate: Date
  startTime: Date
  endTime: Date
}

/**
 * Composes the IST wall-clock date and time into UTC instants.
 *
 * Prisma hands back a DATE as UTC midnight and a TIME as 1970-01-01T<time>Z,
 * so both carry their intended wall-clock values in their UTC fields. Reading
 * them with getUTC* and subtracting the offset converts IST → UTC once, in one
 * place.
 */
export function examWindow(exam: ExamTiming): ExamWindow {
  return {
    opensAt: istInstant(exam.scheduledDate, exam.startTime),
    closesAt: istInstant(exam.scheduledDate, exam.endTime),
  }
}

function istInstant(date: Date, time: Date): Date {
  const utc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    time.getUTCHours(),
    time.getUTCMinutes(),
    time.getUTCSeconds(),
    time.getUTCMilliseconds()
  )
  return new Date(utc - IST_OFFSET_MINUTES * 60_000)
}

/**
 * The instant this particular attempt must be finished by.
 *
 * Two clocks bound an attempt and the tighter one wins: the exam's own window
 * (§11.1 `endTime`) and the candidate's personal duration (§11.1
 * `durationMinutes`) counted from when they started. Someone who opens a
 * 60-minute exam 20 minutes before the window shuts gets 20 minutes, not 60 —
 * the window closes the hall.
 */
export function deadlineFor(window: ExamWindow, startedAt: Date, durationMinutes: number): Date {
  const personal = new Date(startedAt.getTime() + durationMinutes * 60_000)
  return personal < window.closesAt ? personal : window.closesAt
}

export type WindowState = 'open' | 'not_yet_open' | 'closed'

export function windowStateAt(window: ExamWindow, now: Date): WindowState {
  if (now < window.opensAt) return 'not_yet_open'
  if (now >= window.closesAt) return 'closed'
  return 'open'
}
