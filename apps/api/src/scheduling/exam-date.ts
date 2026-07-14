import type { ScheduleFallbackRule } from '@bookends/db'

/**
 * §12.1 exam date rules:
 *
 *   Default: 15th of every month
 *   If 15th = Saturday → Exam on 17th (Monday)
 *   If 15th = Sunday   → Exam on 16th (Monday)
 *   If 15th = Public Holiday → Admin must manually adjust (system flags for review)
 *
 * Pure calendar arithmetic, deliberately. A date's day-of-week is a property of
 * the date itself, not of a timezone — 2027-03-15 is a Monday everywhere — so
 * this needs no timezone handling and can be tested exhaustively without a
 * clock, a database, or a cron.
 *
 * The ONLY place the timezone matters is deciding which month "now" is in when
 * the job fires, which is why that lives in istMonthOf() below rather than
 * being smuggled in here.
 */
export const BOOKENDS_TIMEZONE = 'Asia/Kolkata'

export interface ExamDateResult {
  /** The date the exam should run, as YYYY-MM-DD. */
  date: string
  /** The unshifted day_of_month date, for explaining the shift to an admin. */
  originalDate: string
  shifted: boolean
  reason?: string
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function toIso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 0 = Sunday … 6 = Saturday. UTC is used only as a stable calendar, not a zone. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Resolves the exam date for a month per §12.1.
 *
 * `dayOfMonth` is clamped to the month's length: a config asking for the 31st
 * would otherwise silently roll into the next month in February, scheduling
 * March's exam in the wrong month entirely.
 */
export function resolveExamDate(
  year: number,
  month: number,
  dayOfMonth = 15,
  fallbackRule: ScheduleFallbackRule = 'next_monday'
): ExamDateResult {
  const lastDay = daysInMonth(year, month)
  const day = Math.min(Math.max(dayOfMonth, 1), lastDay)

  const originalDate = toIso(year, month, day)
  const weekday = weekdayOf(year, month, day)

  // Monday–Friday: no shift.
  if (weekday !== 0 && weekday !== 6) {
    return { date: originalDate, originalDate, shifted: false }
  }

  let offset = shiftFor(weekday, fallbackRule)
  let shifted = new Date(Date.UTC(year, month - 1, day + offset))
  let note = ''

  /**
   * The shift must not leave the month.
   *
   * Unreachable at §12.1's default of the 15th — a ±2 day shift cannot cross a
   * boundary from mid-month. But day_of_month is configurable (§4.1), and set
   * to 28-31 the "next Monday" from a Sunday can land in the following month.
   * February's exam would then run on 1 March, and §9's performance snapshots —
   * keyed on (employee, month, year) — would file it under the wrong month.
   *
   * §1.3 says exams are monthly, so the exam stays in its month: shift the
   * other way instead, which still lands on a weekday.
   */
  if (shifted.getUTCMonth() !== month - 1 || shifted.getUTCFullYear() !== year) {
    offset = -offset === 0 ? offset : shiftFor(weekday, 'previous_friday')
    shifted = new Date(Date.UTC(year, month - 1, day + offset))
    note = ' (shifted backwards to stay within the month)'
  }

  return {
    date: toIso(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()),
    originalDate,
    shifted: true,
    reason:
      `The ${ordinal(day)} falls on a ${DAY_NAMES[weekday]}; shifted per the ` +
      `${fallbackRule.replace(/_/g, ' ')} rule${note}`,
  }
}

function shiftFor(weekday: number, rule: ScheduleFallbackRule): number {
  const isSaturday = weekday === 6

  // Each case returns rather than falling through: §4.1 names three rules and
  // the compiler should keep checking that all three are handled if a fourth
  // is ever added.
  switch (rule) {
    case 'next_monday':
      // §12.1's default, and §1.3's "shifts to the nearest Monday (next
      // Monday)". Saturday → +2 (the 15th becomes the 17th), Sunday → +1.
      return isSaturday ? 2 : 1

    case 'next_weekday':
      // Identical to next_monday for a weekend date — the next non-weekend day
      // after a Saturday or Sunday IS Monday. Spelled out separately because
      // §4.1 names both, and because they would diverge if the weekend
      // definition ever changed.
      return isSaturday ? 2 : 1

    case 'previous_friday':
      return isSaturday ? -1 : -2
  }
}

function ordinal(n: number): string {
  const suffix =
    n % 10 === 1 && n % 100 !== 11
      ? 'st'
      : n % 10 === 2 && n % 100 !== 12
        ? 'nd'
        : n % 10 === 3 && n % 100 !== 13
          ? 'rd'
          : 'th'
  return `${n}${suffix}`
}

/**
 * The year and month "now" falls in, in IST.
 *
 * §12.2 fires the job at 00:00 IST on the 1st. At that instant UTC is still
 * 18:30 on the LAST day of the previous month, so reading the month off a UTC
 * date would schedule every exam a month early — every single time.
 */
export function istMonthOf(now: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOOKENDS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { year: get('year'), month: get('month') }
}

/** Today's date in IST as YYYY-MM-DD. */
export function istToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BOOKENDS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
