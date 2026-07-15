import type { PrismaClient } from '@bookends/db'

/**
 * §4.1 performance_snapshots — §1.2's "track individual employee performance
 * over time" and "monitor growth trajectories".
 *
 * A snapshot is a DERIVED, denormalised monthly rollup. It exists because §9's
 * reporting reads it constantly (dashboards, trends, leaderboards) and
 * recomputing a year of exam responses on every page load would not survive
 * contact with 300 employees.
 *
 * It is rebuilt, never incrementally patched: recomputing a month from source
 * is cheap at this scale, and a rollup that drifts from the responses it
 * summarises is worse than no rollup, because nobody can tell it is wrong.
 */
export interface SnapshotResult {
  month: number
  year: number
  employees: number
}

interface EmployeeAggregate {
  employeeId: string
  outletId: string
  departmentId: string
  assigned: number
  attempted: number
  passed: number
  missed: number
  scores: number[]
  topicScores: Map<string, { score: number; total: number }>
}

export class SnapshotService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Rebuilds every employee's snapshot for a month.
   *
   * The month is the EXAM's scheduled month, not when it was graded — §12.1's
   * weekend shift can move an exam, and a paper graded in April still belongs
   * to March's performance if that is when it was sat.
   */
  async rebuild(year: number, month: number): Promise<SnapshotResult> {
    const from = new Date(Date.UTC(year, month - 1, 1))
    const to = new Date(Date.UTC(year, month, 1))

    const assignments = await this.prisma.examAssignment.findMany({
      where: { exam: { scheduledDate: { gte: from, lt: to }, status: { not: 'cancelled' } } },
      select: {
        id: true,
        status: true,
        percentage: true,
        passed: true,
        employee: { select: { id: true, outletId: true, departmentId: true } },
        responses: {
          select: {
            marksObtained: true,
            maxMarks: true,
            question: { select: { topicId: true } },
          },
        },
      },
    })

    const byEmployee = new Map<string, EmployeeAggregate>()

    for (const a of assignments) {
      const key = a.employee.id
      let agg = byEmployee.get(key)
      if (!agg) {
        agg = {
          employeeId: key,
          outletId: a.employee.outletId,
          departmentId: a.employee.departmentId,
          assigned: 0,
          attempted: 0,
          passed: 0,
          missed: 0,
          scores: [],
          topicScores: new Map(),
        }
        byEmployee.set(key, agg)
      }

      agg.assigned++

      // 'exempted' counts as neither attempted nor missed — the exam was
      // withdrawn (§11's cancel path), and §9 must not hold that against them.
      if (['started', 'submitted', 'graded'].includes(a.status)) agg.attempted++
      if (a.status === 'absent') agg.missed++

      if (a.status === 'graded' && a.percentage !== null) {
        agg.scores.push(Number(a.percentage))
        if (a.passed) agg.passed++
      }

      // §4.1's topic_scores — the input to §9's weak-area analysis and §12's
      // training recommendations.
      for (const r of a.responses) {
        const topicId = r.question.topicId
        if (!topicId || r.marksObtained === null) continue

        const current = agg.topicScores.get(topicId) ?? { score: 0, total: 0 }
        // Negative marking can push a response below zero; a topic score of
        // -3/10 is not meaningful, so the floor is zero per response.
        current.score += Math.max(0, Number(r.marksObtained))
        current.total += Number(r.maxMarks)
        agg.topicScores.set(topicId, current)
      }
    }

    const aggregates = [...byEmployee.values()]
    const ranks = this.computeRanks(aggregates)
    const previous = await this.previousAverages(year, month)

    for (const agg of aggregates) {
      const average = agg.scores.length
        ? agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length
        : null

      const priorAverage = previous.get(agg.employeeId)
      const rank = ranks.get(agg.employeeId)!

      await this.prisma.performanceSnapshot.upsert({
        where: { employeeId_month_year: { employeeId: agg.employeeId, month, year } },
        create: {
          employeeId: agg.employeeId,
          month,
          year,
          ...this.toColumns(agg, average, priorAverage, rank),
        },
        update: this.toColumns(agg, average, priorAverage, rank),
      })
    }

    return { month, year, employees: aggregates.length }
  }

  /**
   * §4.1's outlet_rank / department_rank / overall_rank.
   *
   * Competition ranking (1,2,2,4): two employees on the same score share a
   * rank. Giving one of them second and the other third on a tiebreak nobody
   * chose would be arbitrary and visible — they can see each other's badges.
   *
   * An employee with no graded exam is unranked (null) rather than last: they
   * did not perform badly, there is simply nothing to rank.
   */
  private computeRanks(aggregates: EmployeeAggregate[]) {
    const ranks = new Map<
      string,
      { outletRank: number | null; departmentRank: number | null; overallRank: number | null }
    >()

    for (const agg of aggregates) {
      ranks.set(agg.employeeId, { outletRank: null, departmentRank: null, overallRank: null })
    }

    const averageOf = (agg: EmployeeAggregate) =>
      agg.scores.length ? agg.scores.reduce((a, b) => a + b, 0) / agg.scores.length : null

    const rankWithin = (
      group: EmployeeAggregate[],
      field: 'outletRank' | 'departmentRank' | 'overallRank'
    ) => {
      const ranked = group
        .map((a) => ({ id: a.employeeId, average: averageOf(a) }))
        .filter((a): a is { id: string; average: number } => a.average !== null)
        .sort((a, b) => b.average - a.average)

      let lastAverage: number | null = null
      let lastRank = 0

      ranked.forEach((entry, index) => {
        // Ties share a rank; the next distinct score skips ahead.
        const rank = entry.average === lastAverage ? lastRank : index + 1
        lastAverage = entry.average
        lastRank = rank
        ranks.get(entry.id)![field] = rank
      })
    }

    rankWithin(aggregates, 'overallRank')

    for (const outletId of new Set(aggregates.map((a) => a.outletId))) {
      rankWithin(
        aggregates.filter((a) => a.outletId === outletId),
        'outletRank'
      )
    }

    for (const departmentId of new Set(aggregates.map((a) => a.departmentId))) {
      rankWithin(
        aggregates.filter((a) => a.departmentId === departmentId),
        'departmentRank'
      )
    }

    return ranks
  }

  /** Last month's averages, for §4.1's improvement_from_last. */
  private async previousAverages(year: number, month: number): Promise<Map<string, number>> {
    const prevMonth = month === 1 ? 12 : month - 1
    const prevYear = month === 1 ? year - 1 : year

    const rows = await this.prisma.performanceSnapshot.findMany({
      where: { year: prevYear, month: prevMonth, averageScore: { not: null } },
      select: { employeeId: true, averageScore: true },
    })

    return new Map(rows.map((r) => [r.employeeId, Number(r.averageScore)]))
  }

  private toColumns(
    agg: EmployeeAggregate,
    average: number | null,
    priorAverage: number | undefined,
    rank: { outletRank: number | null; departmentRank: number | null; overallRank: number | null }
  ) {
    const topicScores = Object.fromEntries(
      [...agg.topicScores.entries()].map(([topicId, s]) => [
        topicId,
        {
          score: s.score,
          total: s.total,
          percentage: s.total > 0 ? (s.score / s.total) * 100 : 0,
        },
      ])
    )

    return {
      examsAssigned: agg.assigned,
      examsAttempted: agg.attempted,
      examsPassed: agg.passed,
      examsMissed: agg.missed,
      averageScore: average,
      highestScore: agg.scores.length ? Math.max(...agg.scores) : null,
      lowestScore: agg.scores.length ? Math.min(...agg.scores) : null,
      topicScores: topicScores as never,
      outletRank: rank.outletRank,
      departmentRank: rank.departmentRank,
      overallRank: rank.overallRank,
      // §4.1: "Percentage change from previous month". Null on someone's first
      // month — zero would read as "no improvement", which is a different claim.
      improvementFromLast:
        average !== null && priorAverage !== undefined ? average - priorAverage : null,
    }
  }
}
