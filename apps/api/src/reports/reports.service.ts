import type { PrismaClient } from '@bookends/db'
import type { Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'
import { scopeToWhere } from '../rbac/scope.js'
import type { EmployeeReportQuery, ExamReportQuery, OutletReportQuery } from './reports.schemas.js'

/**
 * Reports (§11).
 *
 * A presentation layer, deliberately: everything here is assembled from data
 * the other modules already compute. It adds no new arithmetic — where it
 * needed a number, it asks the module that owns it, because two places
 * computing "average score" is two places to disagree, and a report that
 * disagrees with the dashboard is worse than no report.
 *
 * §1.2's claim is that the exam is the input and the performance record is the
 * product. This is the closest thing to that product a human actually reads.
 */

export class ReportsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * §11 employee report: one person's whole record.
   *
   * The thing a manager opens before a review conversation, so it answers the
   * questions that conversation asks — how are they doing, is it improving,
   * what are they weak at, what have they been given to fix it.
   */
  async employee(principal: Principal, scope: Scope, id: string, query: EmployeeReportQuery) {
    const employee = await this.prisma.employee.findFirst({
      where: { AND: [{ id }, scopeToWhere('employee', scope, principal, 'read')] },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        photoUrl: true,
        joiningDate: true,
        employmentStatus: true,
        preferredLanguage: true,
        outlet: { select: { id: true, name: true, code: true } },
        department: { select: { id: true, name: true, code: true } },
        designation: { select: { id: true, name: true, level: true } },
      },
    })
    // NOT_FOUND on a scope miss, not FORBIDDEN: a 403 confirms the employee
    // exists and leaks another outlet's roster (rbac/scope.ts).
    if (!employee) throw ApiError.notFound('Employee not found')

    const [snapshots, assignments, rewards, certificates, training] = await Promise.all([
      this.prisma.performanceSnapshot.findMany({
        where: { employeeId: id },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        take: query.months,
        select: {
          year: true,
          month: true,
          examsAssigned: true,
          examsAttempted: true,
          examsPassed: true,
          examsMissed: true,
          averageScore: true,
          highestScore: true,
          lowestScore: true,
          outletRank: true,
          departmentRank: true,
          overallRank: true,
          improvementFromLast: true,
          topicScores: true,
        },
      }),
      this.prisma.examAssignment.findMany({
        where: { employeeId: id, status: { in: ['graded', 'submitted'] } },
        orderBy: { exam: { scheduledDate: 'desc' } },
        take: query.months,
        select: {
          id: true,
          status: true,
          percentage: true,
          grade: true,
          passed: true,
          submittedAt: true,
          exam: { select: { id: true, examCode: true, nameEn: true, scheduledDate: true } },
        },
      }),
      this.prisma.reward.findMany({
        where: { employeeId: id },
        orderBy: { awardedAt: 'desc' },
        select: { id: true, type: true, title: true, month: true, year: true, awardedAt: true },
      }),
      this.prisma.certificate.findMany({
        where: { employeeId: id },
        orderBy: { issuedAt: 'desc' },
        select: { id: true, type: true, title: true, certificateNumber: true, issuedAt: true },
      }),
      this.prisma.trainingAssignment.findMany({
        where: { employeeId: id },
        orderBy: { assignedAt: 'desc' },
        select: {
          id: true,
          status: true,
          dueDate: true,
          completedAt: true,
          topic: { select: { id: true, nameEn: true } },
        },
      }),
    ])

    // Oldest first: this is charted, and a trend line reads left to right.
    const trend = [...snapshots].reverse().map((s) => ({
      year: s.year,
      month: s.month,
      averageScore: s.averageScore === null ? null : Number(s.averageScore),
      improvementFromLast:
        s.improvementFromLast === null ? null : Number(s.improvementFromLast),
    }))

    const latest = snapshots[0] ?? null

    return {
      employee,
      // The current standing, called out rather than left for the reader to
      // find at the end of an array.
      current: latest
        ? {
            period: { year: latest.year, month: latest.month },
            averageScore: latest.averageScore === null ? null : Number(latest.averageScore),
            examsAttempted: latest.examsAttempted,
            examsPassed: latest.examsPassed,
            examsMissed: latest.examsMissed,
            outletRank: latest.outletRank,
            overallRank: latest.overallRank,
          }
        : null,
      trend,
      weakTopics: await this.weakTopicsFor(latest?.topicScores ?? null, query.threshold),
      recentExams: assignments.map((a) => ({
        ...a,
        percentage: a.percentage === null ? null : Number(a.percentage),
      })),
      rewards,
      certificates,
      training: {
        open: training.filter((t) => t.status !== 'completed').length,
        completed: training.filter((t) => t.status === 'completed').length,
        items: training,
      },
    }
  }

  /**
   * §11 exam report: how one exam went.
   *
   * Reads the denormalised stats on the exam row rather than recomputing them —
   * grading.service already maintains totalAttempted/totalPassed/averageScore,
   * and a report that recomputed would eventually disagree with the exam list
   * screen showing the same numbers.
   */
  async exam(principal: Principal, scope: Scope, id: string, query: ExamReportQuery) {
    const exam = await this.prisma.exam.findFirst({
      where: { AND: [{ id }, scopeToWhere('exam', scope, principal, 'read')] },
      select: {
        id: true,
        examCode: true,
        nameEn: true,
        nameHi: true,
        nameGu: true,
        scheduledDate: true,
        status: true,
        totalMarks: true,
        passingPercentage: true,
        durationMinutes: true,
        totalAssigned: true,
        totalAttempted: true,
        totalPassed: true,
        averageScore: true,
        outlet: { select: { id: true, name: true, code: true } },
        department: { select: { id: true, name: true } },
      },
    })
    if (!exam) throw ApiError.notFound('Exam not found')

    const assignments = await this.prisma.examAssignment.findMany({
      where: { examId: id },
      orderBy: { percentage: 'desc' },
      select: {
        id: true,
        status: true,
        percentage: true,
        grade: true,
        passed: true,
        submittedAt: true,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            outlet: { select: { code: true } },
          },
        },
      },
    })

    const scored = assignments
      .filter((a) => a.percentage !== null)
      .map((a) => Number(a.percentage))

    return {
      exam: {
        ...exam,
        totalMarks: Number(exam.totalMarks),
        passingPercentage: Number(exam.passingPercentage),
        averageScore: exam.averageScore === null ? null : Number(exam.averageScore),
      },
      summary: {
        assigned: exam.totalAssigned ?? 0,
        attempted: exam.totalAttempted ?? 0,
        passed: exam.totalPassed ?? 0,
        // Absent rather than failed: §4.1's assignment status distinguishes
        // them, and conflating the two would make an outlet look incompetent
        // when it was actually short-staffed that day.
        absent: (exam.totalAssigned ?? 0) - (exam.totalAttempted ?? 0),
        passRate:
          exam.totalAttempted && exam.totalAttempted > 0
            ? ((exam.totalPassed ?? 0) / exam.totalAttempted) * 100
            : null,
        // Median as well as mean: one 12% drags an average down in a way that
        // misrepresents the group, and the gap between the two is itself the
        // signal that something is skewed.
        median: median(scored),
        distribution: query.includeDistribution ? distribution(scored) : undefined,
      },
      results: assignments.map((a) => ({
        ...a,
        percentage: a.percentage === null ? null : Number(a.percentage),
      })),
    }
  }

  /**
   * §11 outlet report.
   *
   * §3.2 treats outlet performance as sensitive — an outlet_manager sees their
   * own, not a league table of their peers. scopeToWhere enforces that; the
   * comparison view lives in analytics behind a permission they do not have.
   */
  async outlet(principal: Principal, scope: Scope, id: string, query: OutletReportQuery) {
    if (scope === 'own_outlet' && !principal.managedOutletIds.includes(id)) {
      throw ApiError.notFound('Outlet not found')
    }

    const outlet = await this.prisma.outlet.findFirst({
      where: { id },
      select: { id: true, name: true, code: true, city: true, isActive: true },
    })
    if (!outlet) throw ApiError.notFound('Outlet not found')

    const snapshots = await this.prisma.performanceSnapshot.findMany({
      where: {
        year: query.year,
        month: query.month,
        employee: { outletId: id, employmentStatus: { notIn: ['terminated', 'resigned'] } },
      },
      select: {
        averageScore: true,
        examsAttempted: true,
        examsPassed: true,
        examsMissed: true,
        topicScores: true,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            department: { select: { id: true, name: true, code: true } },
          },
        },
      },
      orderBy: { averageScore: 'desc' },
    })

    const scores = snapshots
      .filter((s) => s.averageScore !== null)
      .map((s) => Number(s.averageScore))

    // Aggregate every employee's per-topic scores into the outlet's view, so
    // "what is this outlet weak at" is answerable from one report.
    const byTopic = new Map<string, { score: number; total: number }>()
    for (const s of snapshots) {
      const topics = (s.topicScores ?? {}) as Record<string, { score: number; total: number }>
      for (const [topicId, t] of Object.entries(topics)) {
        const current = byTopic.get(topicId) ?? { score: 0, total: 0 }
        current.score += Number(t.score)
        current.total += Number(t.total)
        byTopic.set(topicId, current)
      }
    }

    const topicRows = await this.prisma.topic.findMany({
      where: { id: { in: [...byTopic.keys()] } },
      select: { id: true, nameEn: true, nameHi: true, nameGu: true },
    })
    const topicById = new Map(topicRows.map((t) => [t.id, t]))

    // By department, because that is how a restaurant is actually managed —
    // "the kitchen is struggling" is an actionable sentence and "the outlet
    // averages 71%" is not.
    const byDepartment = new Map<string, { name: string; scores: number[] }>()
    for (const s of snapshots) {
      const dept = s.employee.department
      if (!dept || s.averageScore === null) continue
      const entry = byDepartment.get(dept.id) ?? { name: dept.name, scores: [] }
      entry.scores.push(Number(s.averageScore))
      byDepartment.set(dept.id, entry)
    }

    return {
      outlet,
      period: { year: query.year, month: query.month },
      summary: {
        employeesAssessed: snapshots.length,
        averageScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        median: median(scores),
        examsAttempted: snapshots.reduce((a, s) => a + (s.examsAttempted ?? 0), 0),
        examsPassed: snapshots.reduce((a, s) => a + (s.examsPassed ?? 0), 0),
        examsMissed: snapshots.reduce((a, s) => a + (s.examsMissed ?? 0), 0),
      },
      byDepartment: [...byDepartment.entries()]
        .map(([id, d]) => ({
          departmentId: id,
          name: d.name,
          employeesAssessed: d.scores.length,
          averageScore: d.scores.reduce((a, b) => a + b, 0) / d.scores.length,
        }))
        .sort((a, b) => a.averageScore - b.averageScore),
      weakTopics: [...byTopic.entries()]
        .map(([topicId, t]) => ({
          topic: topicById.get(topicId) ?? { id: topicId, nameEn: 'Unknown topic' },
          percentage: t.total > 0 ? (t.score / t.total) * 100 : 0,
        }))
        .filter((t) => t.percentage < query.threshold)
        // Weakest first: this exists to be acted on from the top.
        .sort((a, b) => a.percentage - b.percentage),
      employees: snapshots.map((s) => ({
        ...s.employee,
        averageScore: s.averageScore === null ? null : Number(s.averageScore),
        examsAttempted: s.examsAttempted,
        examsPassed: s.examsPassed,
      })),
    }
  }

  private async weakTopicsFor(
    topicScores: unknown,
    threshold: number
  ): Promise<Array<{ topic: { id: string; nameEn: string }; percentage: number }>> {
    const topics = (topicScores ?? {}) as Record<string, { score: number; total: number }>
    const weak = Object.entries(topics)
      // 0 of 0 is not 0%: a topic the exam never asked about is not a weakness.
      .filter(([, s]) => Number(s.total) > 0)
      .map(([topicId, s]) => ({
        topicId,
        percentage: (Number(s.score) / Number(s.total)) * 100,
      }))
      .filter((t) => t.percentage < threshold)
      .sort((a, b) => a.percentage - b.percentage)

    if (weak.length === 0) return []

    const rows = await this.prisma.topic.findMany({
      where: { id: { in: weak.map((w) => w.topicId) } },
      select: { id: true, nameEn: true, nameHi: true, nameGu: true },
    })
    const byId = new Map(rows.map((t) => [t.id, t]))

    return weak.map((w) => ({
      topic: byId.get(w.topicId) ?? { id: w.topicId, nameEn: 'Unknown topic' },
      percentage: w.percentage,
    }))
  }
}

/** Robust to the one terrible score that makes a mean lie about the group. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** §11's histogram: fixed decile buckets, so two reports are comparable. */
function distribution(values: number[]): Array<{ range: string; count: number }> {
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    range: `${i * 10}-${i * 10 + 9}`,
    count: 0,
  }))
  for (const v of values) {
    // 100 belongs in the top bucket, not an eleventh one.
    const index = Math.min(9, Math.floor(v / 10))
    buckets[index]!.count++
  }
  buckets[9]!.range = '90-100'
  return buckets
}

/** Exported for the tests — pure, and the arithmetic is worth pinning down. */
export { median, distribution }
