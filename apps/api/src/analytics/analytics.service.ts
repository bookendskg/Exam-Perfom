import type { Prisma, PrismaClient } from '@bookends/db'
import type { Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'

/**
 * §5.3's analytics endpoints, reading §4.1's performance_snapshots.
 *
 * §3.2's "View all reports" row scopes an outlet_manager to their own outlet,
 * and denies trainers and staff entirely — staff see only their own figures,
 * through /staff/performance.
 */
export class AnalyticsService {
  constructor(private readonly prisma: PrismaClient) {}

  /** §5.3 GET /analytics/dashboard. */
  async dashboard(principal: Principal, scope: Scope, year: number, month: number) {
    const where = this.snapshotScope(principal, scope, { year, month })

    const [snapshots, headcount, exams] = await Promise.all([
      this.prisma.performanceSnapshot.findMany({
        where,
        select: {
          averageScore: true,
          examsAssigned: true,
          examsAttempted: true,
          examsPassed: true,
          examsMissed: true,
        },
      }),
      this.prisma.employee.count({
        where: {
          employmentStatus: 'active',
          ...(scope === 'own_outlet' ? { outletId: { in: principal.managedOutletIds } } : {}),
        },
      }),
      this.prisma.exam.count({
        where: {
          scheduledDate: {
            gte: new Date(Date.UTC(year, month - 1, 1)),
            lt: new Date(Date.UTC(year, month, 1)),
          },
          status: { notIn: ['draft', 'cancelled', 'archived'] },
          ...(scope === 'own_outlet' ? { outletId: { in: principal.managedOutletIds } } : {}),
        },
      }),
    ])

    const scored = snapshots.filter((s) => s.averageScore !== null)
    const assigned = sum(snapshots.map((s) => s.examsAssigned ?? 0))
    const attempted = sum(snapshots.map((s) => s.examsAttempted ?? 0))

    return {
      period: { year, month },
      headcount,
      examsThisMonth: exams,
      // Averaging the per-employee averages, not the raw scores: §1.2 tracks
      // people, so someone who sat one exam counts as much as someone who sat
      // three. A raw mean would weight the frequent sitters.
      averageScore: scored.length ? mean(scored.map((s) => Number(s.averageScore))) : null,
      examsAssigned: assigned,
      examsAttempted: attempted,
      examsPassed: sum(snapshots.map((s) => s.examsPassed ?? 0)),
      examsMissed: sum(snapshots.map((s) => s.examsMissed ?? 0)),
      attendanceRate: assigned > 0 ? (attempted / assigned) * 100 : null,
      passRate: (() => {
        const graded = sum(snapshots.map((s) => s.examsPassed ?? 0))
        return attempted > 0 ? (graded / attempted) * 100 : null
      })(),
    }
  }

  /** §5.3 GET /analytics/outlet-comparison — §1.2's "compare across outlets". */
  async outletComparison(principal: Principal, scope: Scope, year: number, month: number) {
    const snapshots = await this.prisma.performanceSnapshot.findMany({
      where: this.snapshotScope(principal, scope, { year, month }),
      select: {
        averageScore: true,
        examsAssigned: true,
        examsAttempted: true,
        examsPassed: true,
        employee: { select: { outletId: true } },
      },
    })

    const outlets = await this.prisma.outlet.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
    })

    const grouped = groupBy(snapshots, (s) => s.employee.outletId)

    return outlets
      .filter((o) => grouped.has(o.id))
      .map((outlet) => {
        const rows = grouped.get(outlet.id)!
        const scored = rows.filter((r) => r.averageScore !== null)
        const attempted = sum(rows.map((r) => r.examsAttempted ?? 0))

        return {
          outlet,
          employees: rows.length,
          averageScore: scored.length ? mean(scored.map((r) => Number(r.averageScore))) : null,
          examsAttempted: attempted,
          passRate:
            attempted > 0 ? (sum(rows.map((r) => r.examsPassed ?? 0)) / attempted) * 100 : null,
        }
      })
      .sort((a, b) => (b.averageScore ?? -1) - (a.averageScore ?? -1))
  }

  /** §5.3 GET /analytics/department-comparison. */
  async departmentComparison(principal: Principal, scope: Scope, year: number, month: number) {
    const snapshots = await this.prisma.performanceSnapshot.findMany({
      where: this.snapshotScope(principal, scope, { year, month }),
      select: {
        averageScore: true,
        examsAttempted: true,
        examsPassed: true,
        employee: { select: { departmentId: true } },
      },
    })

    const departments = await this.prisma.department.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
    })

    const grouped = groupBy(snapshots, (s) => s.employee.departmentId)

    return departments
      .filter((d) => grouped.has(d.id))
      .map((department) => {
        const rows = grouped.get(department.id)!
        const scored = rows.filter((r) => r.averageScore !== null)
        const attempted = sum(rows.map((r) => r.examsAttempted ?? 0))

        return {
          department,
          employees: rows.length,
          averageScore: scored.length ? mean(scored.map((r) => Number(r.averageScore))) : null,
          examsAttempted: attempted,
          passRate:
            attempted > 0 ? (sum(rows.map((r) => r.examsPassed ?? 0)) / attempted) * 100 : null,
        }
      })
      .sort((a, b) => (b.averageScore ?? -1) - (a.averageScore ?? -1))
  }

  /** §5.3 GET /analytics/trend — §1.2's "growth trajectories". */
  async trend(principal: Principal, scope: Scope, months: number) {
    const snapshots = await this.prisma.performanceSnapshot.findMany({
      where: this.snapshotScope(principal, scope, {}),
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
      select: {
        year: true,
        month: true,
        averageScore: true,
        examsAssigned: true,
        examsAttempted: true,
        examsPassed: true,
      },
    })

    const byPeriod = groupBy(snapshots, (s) => `${s.year}-${String(s.month).padStart(2, '0')}`)

    return (
      [...byPeriod.entries()]
        .map(([period, rows]) => {
          const scored = rows.filter((r) => r.averageScore !== null)
          const attempted = sum(rows.map((r) => r.examsAttempted ?? 0))
          return {
            period,
            employees: rows.length,
            averageScore: scored.length ? mean(scored.map((r) => Number(r.averageScore))) : null,
            examsAttempted: attempted,
            passRate:
              attempted > 0 ? (sum(rows.map((r) => r.examsPassed ?? 0)) / attempted) * 100 : null,
          }
        })
        .sort((a, b) => a.period.localeCompare(b.period))
        // Oldest-first, then the tail: a trend chart plots left to right.
        .slice(-months)
    )
  }

  /**
   * §5.3 GET /analytics/weak-areas — §1.2's "identify underperforming
   * employees for targeted training", and the input to §12's recommendations.
   */
  async weakAreas(principal: Principal, scope: Scope, year: number, month: number, threshold = 60) {
    const snapshots = await this.prisma.performanceSnapshot.findMany({
      where: this.snapshotScope(principal, scope, { year, month }),
      select: { topicScores: true, employeeId: true },
    })

    // Aggregate every employee's per-topic score into a group view.
    const byTopic = new Map<string, { score: number; total: number; employees: Set<string> }>()

    for (const snapshot of snapshots) {
      const topics = (snapshot.topicScores ?? {}) as Record<
        string,
        { score: number; total: number }
      >
      for (const [topicId, s] of Object.entries(topics)) {
        const current = byTopic.get(topicId) ?? { score: 0, total: 0, employees: new Set<string>() }
        current.score += Number(s.score)
        current.total += Number(s.total)
        current.employees.add(snapshot.employeeId)
        byTopic.set(topicId, current)
      }
    }

    const topics = await this.prisma.topic.findMany({
      where: { id: { in: [...byTopic.keys()] } },
      select: { id: true, nameEn: true, nameHi: true, nameGu: true, departmentId: true },
    })
    const topicById = new Map(topics.map((t) => [t.id, t]))

    return (
      [...byTopic.entries()]
        .map(([topicId, s]) => ({
          topic: topicById.get(topicId) ?? { id: topicId, nameEn: 'Unknown topic' },
          percentage: s.total > 0 ? (s.score / s.total) * 100 : 0,
          marksObtained: s.score,
          marksAvailable: s.total,
          employeesAssessed: s.employees.size,
        }))
        // Weakest first — this list exists to be acted on from the top.
        .filter((t) => t.percentage < threshold)
        .sort((a, b) => a.percentage - b.percentage)
    )
  }

  /** §5.3 GET /analytics/leaderboard. */
  async leaderboard(principal: Principal, scope: Scope, year: number, month: number, limit = 10) {
    const snapshots = await this.prisma.performanceSnapshot.findMany({
      where: {
        ...this.snapshotScope(principal, scope, { year, month }),
        averageScore: { not: null },
      },
      orderBy: { averageScore: 'desc' },
      take: limit,
      select: {
        averageScore: true,
        examsPassed: true,
        examsAttempted: true,
        outletRank: true,
        overallRank: true,
        improvementFromLast: true,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            photoUrl: true,
            outlet: { select: { id: true, name: true, code: true } },
            designation: { select: { name: true, level: true } },
          },
        },
      },
    })

    return snapshots.map((s) => ({
      rank: s.overallRank,
      outletRank: s.outletRank,
      employee: s.employee,
      averageScore: s.averageScore,
      examsPassed: s.examsPassed,
      examsAttempted: s.examsAttempted,
      // §1.2's "monitor growth" — the most-improved is often a better story
      // than the highest scorer.
      improvement: s.improvementFromLast,
    }))
  }

  /**
   * Scopes every query to what §3.2 lets the caller see.
   *
   * Snapshots have no outletId of their own — they hang off the employee — so
   * the scope has to reach through the relation.
   */
  private snapshotScope(
    principal: Principal,
    scope: Scope,
    period: { year?: number; month?: number }
  ): Prisma.PerformanceSnapshotWhereInput {
    const base: Prisma.PerformanceSnapshotWhereInput = {
      ...(period.year !== undefined ? { year: period.year } : {}),
      ...(period.month !== undefined ? { month: period.month } : {}),
    }

    if (scope === 'all') return base
    if (scope === 'own_outlet') {
      if (principal.managedOutletIds.length === 0) throw ApiError.forbidden()
      return { ...base, employee: { outletId: { in: principal.managedOutletIds } } }
    }

    // §3.2 gives staff and trainers nothing here. Staff read their own figures
    // through /staff/performance, which is scoped by construction.
    throw ApiError.forbidden()
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k)
    if (list) list.push(item)
    else map.set(k, [item])
  }
  return map
}
