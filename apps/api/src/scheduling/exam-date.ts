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

// ---------------------------------------------------------------------------
// IST wall clock → real instants
// ---------------------------------------------------------------------------

/**
 * §4.1 stores an exam's schedule as a DATE plus two TIMEs, and those
 * wall-clock values are IST — §12.1 schedules exams for Indian restaurant
 * shifts. Turning them into an instant is therefore a timezone conversion, and
 * skipping it is not a rounding error: a 10:00–12:00 exam read as UTC opens at
 * 15:30 IST, three and a half hours after the staff sitting it were told to
 * start.
 *
 * This lives here, next to the other IST concerns, because it has two callers
 * in different features — §11.3 publish validation decides whether an exam may
 * be scheduled, and Module 7 decides whether it may be sat. When those two
 * disagreed, an admin could publish an exam that no candidate could open.
 *
 * India has never observed DST and IST has been a fixed UTC+05:30 since 1945,
 * so the offset is a constant rather than an Intl lookup. That is a deliberate
 * simplification of exactly one zone — {@link BOOKENDS_TIMEZONE} — and the
 * assertion below fails loudly if that zone is ever changed to one with DST.
 */
const IST_OFFSET_MINUTES = 330

if (BOOKENDS_TIMEZONE !== 'Asia/Kolkata') {
  throw new Error(
    `istInstant assumes a fixed +05:30 offset, which only holds for Asia/Kolkata, ` +
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
  /**
   * §4.1's per-exam `timezone` column. Optional here because several callers
   * select only the columns they render; when it IS supplied it is checked.
   */
  timezone?: string | null
}

/**
 * Composes an IST wall-clock date and time into the instant it names.
 *
 * Prisma hands back a DATE as UTC midnight and a TIME as 1970-01-01T<time>Z,
 * so both carry their intended wall-clock values in their UTC fields. Reading
 * them with getUTC* and subtracting the offset converts IST → UTC exactly
 * once, in one place.
 */
export function istInstant(date: Date, time: Date): Date {
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
 * The instants an exam's window opens and closes.
 *
 * §4.1 gives every exam its own `timezone` column, defaulting to Asia/Kolkata.
 * Nothing writes anything else to it today, and {@link istInstant} would
 * silently convert a Tokyo exam as though it were Indian if anything ever did —
 * the module-level assertion above cannot catch that, because it checks the
 * constant rather than the row. So the row is checked here.
 *
 * This throws rather than returning an error: a stored timezone this code
 * cannot honour is a data-integrity problem, not something a caller can
 * usefully recover from, and computing the wrong window silently is the one
 * outcome worth crashing to avoid.
 */
export function examWindow(exam: ExamTiming): ExamWindow {
  if (exam.timezone != null && exam.timezone !== BOOKENDS_TIMEZONE) {
    throw new Error(
      `Exam window is stored in ${exam.timezone}, but only ${BOOKENDS_TIMEZONE} is ` +
        `supported — the conversion assumes a fixed +05:30 offset. Per-exam timezones ` +
        `need a real timezone conversion first.`
    )
  }

  return {
    opensAt: istInstant(exam.scheduledDate, exam.startTime),
    closesAt: istInstant(exam.scheduledDate, exam.endTime),
  }
}
