import type { ExamWindow } from '../scheduling/exam-date.js'

/**
 * When one candidate's attempt must end.
 *
 * The IST wall-clock → instant conversion itself lives in
 * scheduling/exam-date.ts, alongside §12.1's other timezone concerns, because
 * §11.3 publish validation needs the identical answer. Two implementations of
 * it disagreed by five and a half hours once already: an admin could publish an
 * exam whose window this module then reported as closed, so nobody could sit it.
 *
 * What is specific to taking an exam — and therefore still here — is the second
 * clock: the candidate's own duration. Re-exported below so attempt code has a
 * single import for both.
 */
export { examWindow, type ExamWindow, type ExamTiming } from '../scheduling/exam-date.js'

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

/**
 * `closesAt` is exclusive: at the closing instant exactly, the exam is over.
 */
export function windowStateAt(window: ExamWindow, now: Date): WindowState {
  if (now < window.opensAt) return 'not_yet_open'
  if (now >= window.closesAt) return 'closed'
  return 'open'
}
