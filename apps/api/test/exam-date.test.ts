import { describe, it, expect } from 'vitest'
import { resolveExamDate, istMonthOf, istToday, examWindow } from '../src/scheduling/exam-date.js'

/**
 * §12.1's rules are pure calendar arithmetic, so they can be checked
 * exhaustively — every month for a decade — with no database and no clock.
 */

describe('§12.1 — the spec’s own worked examples', () => {
  it('shifts a Saturday 15th to the 17th (Monday)', () => {
    // 2027-05-15 is a Saturday.
    const result = resolveExamDate(2027, 5)
    expect(result.originalDate).toBe('2027-05-15')
    expect(result.date).toBe('2027-05-17')
    expect(result.shifted).toBe(true)
  })

  it('shifts a Sunday 15th to the 16th (Monday)', () => {
    // 2027-08-15 is a Sunday.
    const result = resolveExamDate(2027, 8)
    expect(result.originalDate).toBe('2027-08-15')
    expect(result.date).toBe('2027-08-16')
    expect(result.shifted).toBe(true)
  })

  it('leaves a weekday 15th alone', () => {
    // 2027-03-15 is a Monday.
    const result = resolveExamDate(2027, 3)
    expect(result.date).toBe('2027-03-15')
    expect(result.shifted).toBe(false)
    expect(result.reason).toBeUndefined()
  })

  it('explains the shift so an admin can see why the date moved', () => {
    const result = resolveExamDate(2027, 5)
    expect(result.reason).toContain('Saturday')
  })
})

describe('§12.1 across a decade', () => {
  const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`).getUTCDay()

  it('never lands on a weekend, in any month from 2026 to 2035', () => {
    for (let year = 2026; year <= 2035; year++) {
      for (let month = 1; month <= 12; month++) {
        const { date } = resolveExamDate(year, month)
        const day = weekdayOf(date)
        expect(day, `${date} is a weekend day`).not.toBe(0)
        expect(day, `${date} is a weekend day`).not.toBe(6)
      }
    }
  })

  it('always lands on the 15th, 16th or 17th under the default rule', () => {
    // Saturday → 17th, Sunday → 16th, weekday → 15th. Nothing else is reachable.
    const seen = new Set<string>()
    for (let year = 2026; year <= 2035; year++) {
      for (let month = 1; month <= 12; month++) {
        seen.add(resolveExamDate(year, month).date.slice(-2))
      }
    }
    expect([...seen].sort()).toEqual(['15', '16', '17'])
  })

  it('never shifts into another month', () => {
    // A shift is at most +2 days from the 15th, so it cannot cross a boundary —
    // but the day_of_month is configurable, and this is the guard for that.
    for (let year = 2026; year <= 2035; year++) {
      for (let month = 1; month <= 12; month++) {
        const { date } = resolveExamDate(year, month)
        expect(date.slice(0, 7)).toBe(`${year}-${String(month).padStart(2, '0')}`)
      }
    }
  })
})

describe('fallback rules (§4.1)', () => {
  it('previous_friday moves a Saturday back one day', () => {
    // 2027-05-15 is a Saturday.
    expect(resolveExamDate(2027, 5, 15, 'previous_friday').date).toBe('2027-05-14')
  })

  it('previous_friday moves a Sunday back two days', () => {
    // 2027-08-15 is a Sunday.
    expect(resolveExamDate(2027, 8, 15, 'previous_friday').date).toBe('2027-08-13')
  })

  it('previous_friday always lands on a Friday', () => {
    for (let year = 2026; year <= 2030; year++) {
      for (let month = 1; month <= 12; month++) {
        const result = resolveExamDate(year, month, 15, 'previous_friday')
        if (!result.shifted) continue
        expect(new Date(`${result.date}T00:00:00.000Z`).getUTCDay()).toBe(5)
      }
    }
  })

  it('next_weekday behaves identically to next_monday for a weekend date', () => {
    // The next non-weekend day after a Saturday or Sunday IS Monday. §4.1 names
    // both rules; they only differ if day_of_month were something exotic.
    for (let year = 2026; year <= 2030; year++) {
      for (let month = 1; month <= 12; month++) {
        expect(resolveExamDate(year, month, 15, 'next_weekday').date).toBe(
          resolveExamDate(year, month, 15, 'next_monday').date
        )
      }
    }
  })
})

describe('configurable day_of_month (§4.1)', () => {
  it('honours a different day', () => {
    // 2027-03-01 is a Monday.
    expect(resolveExamDate(2027, 3, 1).date).toBe('2027-03-01')
  })

  it('clamps a day past the end of the month', () => {
    // Asking for the 31st of February must not silently roll into March and
    // schedule the exam in the wrong month entirely.
    const result = resolveExamDate(2027, 2, 31)
    expect(result.originalDate).toBe('2027-02-28')
  })

  it('keeps a month-end shift inside its own month', () => {
    /**
     * 2027-02-28 is a Sunday, so "next Monday" is 1 March — February's exam
     * would run in March, and §9's snapshots (keyed on month+year) would file
     * it under the wrong month. It shifts backwards instead.
     *
     * Unreachable at §12.1's default of the 15th; only a configured month-end
     * day_of_month gets here.
     */
    const result = resolveExamDate(2027, 2, 28)
    expect(result.date.slice(0, 7)).toBe('2027-02')
    expect(result.date).toBe('2027-02-26') // the Friday
    expect(result.reason).toContain('stay within the month')
  })

  it('keeps every configurable day in its own month, all year', () => {
    for (let year = 2026; year <= 2030; year++) {
      for (let month = 1; month <= 12; month++) {
        for (const day of [1, 15, 28, 29, 30, 31]) {
          const { date } = resolveExamDate(year, month, day)
          expect(date.slice(0, 7), `day ${day} of ${year}-${month} escaped its month`).toBe(
            `${year}-${String(month).padStart(2, '0')}`
          )
          // …and still never a weekend.
          const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay()
          expect([0, 6]).not.toContain(weekday)
        }
      }
    }
  })

  it('handles a leap February', () => {
    expect(resolveExamDate(2028, 2, 31).originalDate).toBe('2028-02-29')
  })

  it('clamps a nonsensical day rather than producing a nonsensical date', () => {
    expect(resolveExamDate(2027, 3, 0).originalDate).toBe('2027-03-01')
    expect(resolveExamDate(2027, 3, 99).originalDate).toBe('2027-03-31')
  })
})

describe('IST month resolution (§12.2)', () => {
  it('reads the month in IST, not UTC', () => {
    /**
     * The trap this exists to avoid: §12.2 fires the job at 00:00 IST on the
     * 1st. At that instant UTC is still 18:30 on the LAST day of the previous
     * month. Reading the month off a UTC date would schedule every exam a
     * month early — every single time, silently.
     */
    const firesAt = new Date('2027-02-28T18:30:00.000Z') // = 2027-03-01 00:00 IST
    expect(istMonthOf(firesAt)).toEqual({ year: 2027, month: 3 })

    // Reading it in UTC would have said February.
    expect(firesAt.getUTCMonth() + 1).toBe(2)
  })

  it('rolls the year over correctly at the new year', () => {
    const firesAt = new Date('2026-12-31T18:30:00.000Z') // = 2027-01-01 00:00 IST
    expect(istMonthOf(firesAt)).toEqual({ year: 2027, month: 1 })
  })

  it('agrees with UTC during IST working hours', () => {
    const midday = new Date('2027-03-15T06:30:00.000Z') // = 12:00 IST
    expect(istMonthOf(midday)).toEqual({ year: 2027, month: 3 })
  })

  it('reports today in IST', () => {
    expect(istToday(new Date('2027-02-28T18:30:00.000Z'))).toBe('2027-03-01')
    expect(istToday(new Date('2027-03-15T06:30:00.000Z'))).toBe('2027-03-15')
  })
})

/**
 * The DATE + TIME → instant conversion, which §11.3 publish validation and
 * Module 7's exam taking both depend on. They had one implementation each once,
 * and the two disagreed by 5h30m: publish validation composed the wall clock as
 * though it were UTC, so an admin could publish an exam that had already
 * finished while every candidate correctly saw a closed window.
 */
describe('§12.1 IST wall clock → instants', () => {
  /** Prisma returns a DATE as UTC midnight and a TIME as 1970-01-01T<time>Z. */
  const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
  const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`)

  const timing = (day: string, start: string, end: string) => ({
    scheduledDate: date(day),
    startTime: time(start),
    endTime: time(end),
  })

  it('reads the stored wall clock as Asia/Kolkata', () => {
    const { opensAt, closesAt } = examWindow(timing('2027-03-15', '10:00', '12:00'))

    // 10:00 IST is 04:30 UTC. Reading it as UTC would open the exam at 15:30
    // IST — three and a half hours after the staff were told to sit it.
    expect(opensAt.toISOString()).toBe('2027-03-15T04:30:00.000Z')
    expect(closesAt.toISOString()).toBe('2027-03-15T06:30:00.000Z')
  })

  it('rolls back across the date line for early-morning windows', () => {
    // 04:00 IST is 22:30 UTC on the PREVIOUS day.
    const { opensAt } = examWindow(timing('2027-03-15', '04:00', '06:00'))
    expect(opensAt.toISOString()).toBe('2027-03-14T22:30:00.000Z')
  })

  it('is never the naive UTC composition', () => {
    // Pins the defect itself: the old combine() returned exactly this.
    const { opensAt } = examWindow(timing('2027-03-15', '10:00', '12:00'))
    expect(opensAt.toISOString()).not.toBe('2027-03-15T10:00:00.000Z')
    expect(opensAt.getTime()).toBe(new Date('2027-03-15T10:00:00.000Z').getTime() - 330 * 60_000)
  })
})
