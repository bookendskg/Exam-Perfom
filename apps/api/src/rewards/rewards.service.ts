import type { Prisma, PrismaClient } from '@bookends/db'
import { pageMeta, type Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'
import { scopeToWhere } from '../rbac/scope.js'
import { claimCertificateNumber } from './certificate-number.js'
import type {
  AwardRewardInput,
  IssueCertificateInput,
  ListCertificatesQuery,
  ListRewardsQuery,
  SuggestionsQuery,
} from './rewards.schemas.js'

/**
 * Rewards and certificates (§12).
 *
 * §1.2 lists recognition alongside training as what the performance record is
 * FOR. Both are built the same way and on purpose: the system proposes from
 * real data, a human decides. Recognition that arrives automatically from a
 * query is worth nothing to the person receiving it, and a wrong one — someone
 * who left last week, or gamed a single exam — is worse than none at all. The
 * record says who decided.
 */

const REWARD_SELECT = {
  id: true,
  employeeId: true,
  type: true,
  title: true,
  description: true,
  month: true,
  year: true,
  criteria: true,
  awardedAt: true,
  employee: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true, outletId: true },
  },
  awardedBy: { select: { id: true, phone: true } },
} satisfies Prisma.RewardSelect

const CERTIFICATE_SELECT = {
  id: true,
  employeeId: true,
  examId: true,
  type: true,
  title: true,
  description: true,
  certificateNumber: true,
  certificateUrl: true,
  issuedAt: true,
  validUntil: true,
  employee: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true, outletId: true },
  },
} satisfies Prisma.CertificateSelect

export class RewardsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * §12 suggestions: who is worth recognising this month.
   *
   * Reads the same performance snapshots the leaderboard does, so the two agree
   * — a suggestion list that disagreed with the leaderboard next to it would be
   * a support ticket nobody can resolve.
   *
   * Writes nothing. It proposes; a human awards. Same shape as training's
   * recommendations, and for the same reason.
   */
  async suggestions(principal: Principal, scope: Scope, query: SuggestionsQuery) {
    const snapshots = await this.prisma.performanceSnapshot.findMany({
      where: {
        year: query.year,
        month: query.month,
        averageScore: { not: null },
        employee: {
          ...scopeToWhere('employee', scope, principal, 'read'),
          // Recognising someone who has left is the kind of mistake that makes
          // a whole feature look unserious.
          employmentStatus: { notIn: ['terminated', 'resigned'] },
        },
      },
      orderBy: { averageScore: 'desc' },
      take: query.limit,
      select: {
        averageScore: true,
        examsPassed: true,
        examsAttempted: true,
        improvementFromLast: true,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            outletId: true,
          },
        },
      },
    })

    // Already recognised this month. Suggesting someone who has their medal is
    // how the list stops being read.
    const awarded = await this.prisma.reward.findMany({
      where: { year: query.year, month: query.month },
      select: { employeeId: true },
    })
    const already = new Set(awarded.map((a) => a.employeeId))

    return snapshots
      .filter((s) => !already.has(s.employee.id))
      .map((s, index) => ({
        employee: s.employee,
        averageScore: s.averageScore === null ? null : Number(s.averageScore),
        examsPassed: s.examsPassed,
        examsAttempted: s.examsAttempted,
        improvementFromLast:
          s.improvementFromLast === null ? null : Number(s.improvementFromLast),
        rank: index + 1,
        // A proposal, not a decision — §12's gold/silver/bronze by position,
        // which the awarder is free to ignore.
        suggestedType: SUGGESTED_BY_RANK[index] ?? null,
        // Why this person is on the list, so the awarder is not just trusting
        // an ordering they cannot see the basis for.
        reason:
          s.improvementFromLast !== null && Number(s.improvementFromLast) > 0
            ? `Averaged ${Number(s.averageScore).toFixed(1)}%, up ${Number(s.improvementFromLast).toFixed(1)} points`
            : `Averaged ${Number(s.averageScore).toFixed(1)}% across ${s.examsAttempted} exams`,
      }))
  }

  async listRewards(principal: Principal, scope: Scope, query: ListRewardsQuery) {
    const where: Prisma.RewardWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.year ? { year: query.year } : {}),
      ...(query.month ? { month: query.month } : {}),
      employee: scopeToWhere('employee', scope, principal, 'read'),
    }

    const [rows, total] = await Promise.all([
      this.prisma.reward.findMany({
        where,
        select: REWARD_SELECT,
        orderBy: { awardedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.reward.count({ where }),
    ])

    return { rows, meta: pageMeta(query.page, query.limit, total) }
  }

  /** §12 award. */
  async award(principal: Principal, scope: Scope, input: AwardRewardInput) {
    const employee = await this.assertRecognisableEmployee(principal, scope, input.employeeId)

    // One reward of a type per employee per month. Two managers independently
    // deciding the same person deserves gold should not produce two medals —
    // and the second one needs to know the first exists.
    if (input.month && input.year) {
      const existing = await this.prisma.reward.findFirst({
        where: {
          employeeId: input.employeeId,
          type: input.type,
          month: input.month,
          year: input.year,
        },
        select: { id: true, awardedAt: true },
      })
      if (existing) {
        throw ApiError.conflict('That reward has already been given for that month', [
          {
            field: 'type',
            message: `Awarded on ${existing.awardedAt.toISOString().slice(0, 10)}`,
          },
        ])
      }
    }

    return this.prisma.reward.create({
      data: {
        tenantId: principal.tenantId,
        employeeId: employee.id,
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        month: input.month ?? null,
        year: input.year ?? null,
        // §4.1's "what earned this reward". Free-form on purpose: the awarder
        // knows why, and a fixed schema would either constrain their reasoning
        // or be left empty.
        criteria: (input.criteria ?? undefined) as never,
        awardedById: principal.userId,
      },
      select: REWARD_SELECT,
    })
  }

  async listCertificates(principal: Principal, scope: Scope, query: ListCertificatesQuery) {
    const where: Prisma.CertificateWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.type ? { type: query.type } : {}),
      employee: scopeToWhere('employee', scope, principal, 'read'),
    }

    const [rows, total] = await Promise.all([
      this.prisma.certificate.findMany({
        where,
        select: CERTIFICATE_SELECT,
        orderBy: { issuedAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.certificate.count({ where }),
    ])

    return { rows, meta: pageMeta(query.page, query.limit, total) }
  }

  /**
   * §12 issue a certificate.
   *
   * The RECORD is issued and numbered; certificateUrl stays null. Rendering the
   * PDF needs three things that do not exist: a PDF library, §5.2's tenant
   * branding assets (certificateLogoUrl and the signature are empty on every
   * tenant), and file storage. Issuing an unbranded PDF to nowhere would be
   * worse than issuing nothing — this way the employee can see they earned one
   * and the URL fills in when there is somewhere to put it.
   */
  async issueCertificate(principal: Principal, scope: Scope, input: IssueCertificateInput) {
    const employee = await this.assertRecognisableEmployee(principal, scope, input.employeeId)

    if (input.examId) {
      const exam = await this.prisma.exam.findFirst({
        where: { id: input.examId },
        select: { id: true },
      })
      if (!exam) {
        throw ApiError.validation('Unknown exam', [{ field: 'examId', message: 'No such exam' }])
      }
    }

    const issuedAt = this.now()

    return this.prisma.$transaction(async (tx) => {
      // Claimed inside the transaction so a failed insert rolls the number back
      // rather than burning it — a gap is acceptable, a duplicate is not.
      const certificateNumber = await claimCertificateNumber(
        tx,
        principal.tenantId,
        issuedAt.getUTCFullYear()
      )

      return tx.certificate.create({
        data: {
          tenantId: principal.tenantId,
          employeeId: employee.id,
          examId: input.examId ?? null,
          type: input.type,
          title: input.title,
          description: input.description ?? null,
          certificateNumber,
          validUntil: input.validUntil ? new Date(input.validUntil) : null,
          issuedAt,
          issuedById: principal.userId,
        },
        select: CERTIFICATE_SELECT,
      })
    })
  }

  private async assertRecognisableEmployee(
    principal: Principal,
    scope: Scope,
    employeeId: string
  ) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId },
      select: { id: true, outletId: true, employmentStatus: true },
    })
    if (!employee) throw ApiError.notFound('Employee not found')

    if (scope === 'none') throw ApiError.forbidden()
    if (scope === 'own_outlet' && !principal.managedOutletIds.includes(employee.outletId)) {
      // NOT_FOUND rather than FORBIDDEN: a 403 confirms the employee exists and
      // leaks another outlet's roster to anyone enumerating ids (rbac/scope.ts).
      throw ApiError.notFound('Employee not found')
    }

    if (['terminated', 'resigned'].includes(employee.employmentStatus)) {
      throw ApiError.validation('That employee has left', [
        { field: 'employeeId', message: `Employment status is ${employee.employmentStatus}` },
      ])
    }

    return employee
  }
}

/** §12's podium. Beyond third there is no suggested type — just a name on a list. */
const SUGGESTED_BY_RANK = ['gold', 'silver', 'bronze'] as const
