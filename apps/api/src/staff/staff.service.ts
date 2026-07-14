import type { PrismaClient } from '@bookends/db'
import { ApiError } from '../http/api-error.js'

/**
 * §8.5 staff self-service.
 *
 * Every method takes an employeeId resolved from the session, never from the
 * request — that is what makes these endpoints unable to leak another
 * employee's data regardless of what the caller sends.
 *
 * Several §8.5 sections (exam history, performance trend, training, leaderboard)
 * depend on modules that are not built yet. Their tables exist, so they are
 * queried honestly and come back empty rather than being faked.
 */
const PERFORMANCE_MONTHS = 6

export class StaffService {
  constructor(private readonly prisma: PrismaClient) {}

  /** §5.3 GET /staff/profile — the §8.5 "profile summary with photo". */
  async profile(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        photoUrl: true,
        phone: true,
        email: true,
        joiningDate: true,
        employmentType: true,
        employmentStatus: true,
        preferredLanguage: true,
        city: true,
        state: true,
        emergencyContactName: true,
        emergencyContactPhone: true,
        emergencyContactRelation: true,
        outlet: { select: { id: true, name: true, code: true } },
        department: { select: { id: true, name: true, code: true } },
        designation: { select: { id: true, name: true, code: true, level: true } },
        user: { select: { lastLoginAt: true, mustChangePassword: true } },
      },
    })
    if (!employee) throw ApiError.notFound('Your account has no employee profile')
    return employee
  }

  /** §5.3 GET /staff/certificates. */
  async certificates(employeeId: string) {
    return this.prisma.certificate.findMany({
      where: { employeeId },
      orderBy: { issuedAt: 'desc' },
      select: {
        id: true,
        type: true,
        title: true,
        description: true,
        certificateUrl: true,
        certificateNumber: true,
        issuedAt: true,
        validUntil: true,
      },
    })
  }

  /**
   * §5.3 GET /staff/performance — §8.5's "performance trend (last 6 months)".
   *
   * Reads performance_snapshots, which Module 9 populates. Empty until then;
   * the shape is stable either way so the client can be built against it.
   */
  async performance(employeeId: string) {
    const snapshots = await this.prisma.performanceSnapshot.findMany({
      where: { employeeId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: PERFORMANCE_MONTHS,
      select: {
        month: true,
        year: true,
        examsAssigned: true,
        examsAttempted: true,
        examsPassed: true,
        examsMissed: true,
        averageScore: true,
        highestScore: true,
        lowestScore: true,
        topicScores: true,
        outletRank: true,
        departmentRank: true,
        overallRank: true,
        improvementFromLast: true,
      },
    })

    // Oldest-first is what a trend chart wants to plot.
    return { months: snapshots.reverse() }
  }

  /**
   * §8.5 dashboard: everything the staff home screen shows, in one round trip.
   *
   * The APK renders this on a phone over a restaurant's WiFi, so one request
   * beats six.
   */
  async dashboard(employeeId: string) {
    const [
      profile,
      upcomingExams,
      recentResults,
      performance,
      training,
      certificates,
      unreadCount,
    ] = await Promise.all([
      this.profile(employeeId),
      this.upcomingExams(employeeId),
      this.recentResults(employeeId),
      this.performance(employeeId),
      this.assignedTraining(employeeId),
      this.certificates(employeeId),
      this.unreadNotificationCount(employeeId),
    ])

    return {
      profile,
      upcomingExams,
      recentResults,
      performance,
      training,
      certificates,
      unreadNotifications: unreadCount,
      // Leaderboard position (§8.5) arrives with Module 11; performance.months
      // already carries the ranks Module 9 computes.
    }
  }

  /** §8.5 "upcoming exams". Populated by Modules 5–6. */
  private async upcomingExams(employeeId: string) {
    return this.prisma.examAssignment.findMany({
      where: {
        employeeId,
        status: { in: ['assigned', 'notified', 'started'] },
        exam: { status: { in: ['scheduled', 'active'] } },
      },
      orderBy: { exam: { scheduledDate: 'asc' } },
      select: {
        id: true,
        status: true,
        exam: {
          select: {
            id: true,
            examCode: true,
            nameEn: true,
            nameHi: true,
            nameGu: true,
            scheduledDate: true,
            startTime: true,
            endTime: true,
            durationMinutes: true,
            totalMarks: true,
          },
        },
      },
    })
  }

  /** §8.5 "recent exam results". Populated by Modules 7–8. */
  private async recentResults(employeeId: string) {
    return this.prisma.examAssignment.findMany({
      where: { employeeId, status: 'graded' },
      orderBy: { gradedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        totalMarksObtained: true,
        percentage: true,
        grade: true,
        passed: true,
        gradedAt: true,
        supervisorRemarks: true,
        exam: {
          select: {
            id: true,
            examCode: true,
            nameEn: true,
            nameHi: true,
            nameGu: true,
            totalMarks: true,
          },
        },
      },
    })
  }

  /** §8.5 "assigned training". Populated by Module 12. */
  private async assignedTraining(employeeId: string) {
    return this.prisma.trainingAssignment.findMany({
      where: { employeeId, status: { in: ['assigned', 'in_progress', 'overdue'] } },
      orderBy: { dueDate: 'asc' },
      select: {
        id: true,
        reason: true,
        status: true,
        dueDate: true,
        assignedAt: true,
        topic: { select: { id: true, nameEn: true, nameHi: true, nameGu: true } },
        sourceDocument: { select: { id: true, title: true, fileUrl: true } },
      },
    })
  }

  /** §8.5 "notifications" — a count for the home-screen badge. */
  private async unreadNotificationCount(employeeId: string): Promise<number> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true },
    })
    if (!employee) return 0

    return this.prisma.notification.count({
      where: { userId: employee.userId, isRead: false },
    })
  }
}
