import type { PrismaClient } from '@bookends/db'
import { currentTenantId, runAsPlatform, runInTenant } from '@bookends/db'
import type { Logger } from 'pino'
import { ExamService } from '../exams/exam.service.js'
import { PlanService } from '../plans/plan.service.js'
import type { Principal } from '../infra/session-store/index.js'
import { resolveExamDate, istMonthOf } from './exam-date.js'

/**
 * §12.2 auto-scheduling job.
 *
 *   Runs: 1st of every month at 00:00 IST
 *   1. Calculate exam date for this month
 *   2. Check if date falls on weekend
 *   3. Apply fallback rule
 *   4. Check for existing manually-scheduled exam on that date
 *   5. If no conflict: create per outlet, auto-select, auto-assign, SCHEDULE
 *   6. If conflict: flag for admin review + notify admin
 */
export interface OutletScheduleResult {
  outletId: string | null
  outletName: string
  status: 'scheduled' | 'conflict' | 'skipped' | 'failed'
  examId?: string
  examCode?: string
  date?: string
  shifted?: boolean
  reason?: string
  shortfalls?: unknown[]
}

export interface SchedulingRun {
  year: number
  month: number
  results: OutletScheduleResult[]
  scheduled: number
  conflicts: number
  failed: number
}

export class SchedulerService {
  private readonly exams: ExamService

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger
  ) {
    // The same ExamService the HTTP routes use, so the §4.3 exam limit applies
    // to this door too. The job must not be the way around a plan.
    this.exams = new ExamService(prisma, new PlanService(prisma))
  }

  /**
   * Runs the §12.2 job for the month `now` falls in.
   *
   * `now` is injected rather than read from the clock so this can be tested at
   * any date without waiting for the 1st of a month.
   */
  /**
   * Runs auto-scheduling for every eligible tenant.
   *
   * A job, not a request, so there is no ambient tenant to inherit — it has to
   * enumerate them and enter each one explicitly. Doing that per tenant, rather
   * than sweeping every config at once as the single-tenant version did, is
   * what keeps one customer's cron from touching another's exams: inside
   * runInTenant every query below is filtered, so the blast radius of a bug
   * here is one tenant instead of all of them.
   */
  async run(now: Date = new Date()): Promise<SchedulingRun> {
    // §12.2 fires at 00:00 IST, when UTC is still the previous month. Reading
    // the month in IST is what stops every exam being scheduled a month early.
    const { year, month } = istMonthOf(now)

    const tenants = await runAsPlatform('auto-scheduler: enumerating tenants to run for', () =>
      this.prisma.tenant.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true, slug: true, plan: { select: { autoScheduling: true } } },
      })
    )

    const results: OutletScheduleResult[] = []

    for (const tenant of tenants) {
      // §7: auto-scheduling is Professional and above. Enforced here as well as
      // at the API, because the job is the other door into the same feature —
      // gating only the settings page would let a downgraded tenant keep the
      // benefit indefinitely.
      if (!tenant.plan?.autoScheduling) {
        this.logger.debug(
          { tenantSlug: tenant.slug },
          'Skipping auto-scheduling: plan does not include it'
        )
        continue
      }

      results.push(...(await runInTenant(tenant.id, () => this.runForTenant(year, month))))
    }

    const run: SchedulingRun = {
      year,
      month,
      results,
      scheduled: results.filter((r) => r.status === 'scheduled').length,
      conflicts: results.filter((r) => r.status === 'conflict').length,
      failed: results.filter((r) => r.status === 'failed').length,
    }

    this.logger.info({ run }, 'Auto-scheduling complete')
    return run
  }

  /** One tenant's worth of scheduling. Every query here is tenant-filtered. */
  private async runForTenant(year: number, month: number): Promise<OutletScheduleResult[]> {
    const configs = await this.prisma.examScheduleConfig.findMany({
      where: { isActive: true },
      include: { outlet: true, template: true },
    })

    if (configs.length === 0) {
      this.logger.warn('Auto-scheduling ran with no active configuration; nothing to do')
      return []
    }

    const results: OutletScheduleResult[] = []

    for (const config of configs) {
      // §4.1: a NULL outlet_id is the global setting, so it applies to every
      // outlet that has no config of its own.
      const outlets = config.outletId
        ? await this.prisma.outlet.findMany({ where: { id: config.outletId, isActive: true } })
        : await this.prisma.outlet.findMany({
            where: {
              isActive: true,
              id: { notIn: configs.filter((c) => c.outletId).map((c) => c.outletId!) },
            },
          })

      for (const outlet of outlets) {
        results.push(await this.scheduleForOutlet(year, month, outlet, config))
      }
    }

    return results
  }

  private async scheduleForOutlet(
    year: number,
    month: number,
    outlet: { id: string; name: string },
    config: {
      id: string
      dayOfMonth: number
      fallbackRule: 'next_monday' | 'previous_friday' | 'next_weekday'
      templateId: string | null
      template: { id: string; nameEn: string; durationMinutes: number } | null
    }
  ): Promise<OutletScheduleResult> {
    const base: OutletScheduleResult = {
      outletId: outlet.id,
      outletName: outlet.name,
      status: 'failed',
    }

    // §12.2 steps 1-3
    const { date, shifted, reason } = resolveExamDate(
      year,
      month,
      config.dayOfMonth,
      config.fallbackRule
    )

    if (!config.template) {
      // §12.2 step 5 needs a template to create from. Without one there is
      // nothing to schedule, and silently skipping would mean an outlet's staff
      // simply never sit an exam and nobody notices.
      this.logger.error(
        { outletId: outlet.id, configId: config.id },
        'Schedule config has no template; cannot auto-schedule'
      )
      return { ...base, date, reason: 'The schedule configuration has no exam template' }
    }

    // §12.2 step 4: an exam already on that date for this outlet.
    const existing = await this.prisma.exam.findFirst({
      where: {
        outletId: outlet.id,
        scheduledDate: new Date(`${date}T00:00:00.000Z`),
        status: { notIn: ['cancelled', 'archived'] },
      },
      select: { id: true, examCode: true, isAutoScheduled: true },
    })

    if (existing) {
      // §12.2 step 6: flag for admin review rather than creating a second exam
      // on the same day, which would double-book every employee.
      this.logger.warn(
        { outletId: outlet.id, date, existingExam: existing.examCode },
        'Auto-scheduling conflict: an exam already exists on that date'
      )
      return {
        ...base,
        status: 'conflict',
        date,
        examId: existing.id,
        examCode: existing.examCode,
        reason: existing.isAutoScheduled
          ? `Already auto-scheduled as ${existing.examCode}`
          : `A manually-scheduled exam (${existing.examCode}) already exists on ${date}`,
      }
    }

    try {
      // The job acts as the config's owner. §3.2 has no "system" role, so it
      // borrows 'all' scope — this is not a request and no user is present.
      const principal: Principal = {
        userId: await this.systemUserId(),
        // The ambient scope set by run(); systemUserId() resolved inside it too,
        // so the borrowed admin is guaranteed to be this tenant's own.
        tenantId: currentTenantId(),
        role: 'admin',
        sessionId: 'auto-scheduler',
        employeeId: null,
        outletId: null,
        departmentId: null,
        managedOutletIds: [],
        mustChangePassword: false,
      }

      const { exam, shortfalls } = await this.exams.create(principal, 'all', {
        templateId: config.template.id,
        nameEn: config.template.nameEn,
        scheduledDate: date,
        // §4.1's config has no time window, so a working-hours default is used.
        // Flagged: §12.2 does not say what time an auto-scheduled exam runs.
        startTime: '10:00',
        endTime: '18:00',
        outletId: outlet.id,
        autoAssign: true,
      })

      // §12.2 step 5: "Set status to SCHEDULED". ExamService.create leaves it a
      // draft (§11.1 step 8), so the job publishes it — but only if §11.3's
      // checks pass. An auto-scheduled exam that skipped validation could put
      // unapproved questions in front of 300 staff unattended.
      const validation = await this.exams.validate(principal, 'all', exam.id)
      if (!validation.canPublish) {
        this.logger.error(
          { outletId: outlet.id, examId: exam.id, errors: validation.errors },
          'Auto-scheduled exam failed §11.3 validation; left as a draft for admin review'
        )
        return {
          ...base,
          date,
          shifted,
          examId: exam.id,
          examCode: exam.examCode,
          reason: `Created as a draft: ${validation.errors.map((e) => e.message).join('; ')}`,
          shortfalls,
        }
      }

      await this.exams.publish(principal, 'all', exam.id)
      await this.prisma.exam.update({
        where: { id: exam.id },
        data: { isAutoScheduled: true },
      })

      return {
        ...base,
        status: 'scheduled',
        examId: exam.id,
        examCode: exam.examCode,
        date,
        shifted,
        ...(reason ? { reason } : {}),
        shortfalls,
      }
    } catch (err) {
      // One outlet failing must not stop the others — Aiko's staff should still
      // get their exam if Capiche's bank is short.
      this.logger.error({ err, outletId: outlet.id }, 'Auto-scheduling failed for outlet')
      return {
        ...base,
        date,
        reason: err instanceof Error ? err.message : 'Unknown error',
      }
    }
  }

  /**
   * The job needs a user to attribute created exams to (exams.created_by is NOT
   * NULL). §3.2 has no system role, so it uses the oldest super_admin — the
   * bootstrap account.
   */
  private async systemUserId(): Promise<string> {
    const admin = await this.prisma.user.findFirst({
      where: { role: { in: ['super_admin', 'admin'] }, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })

    if (!admin) {
      throw new Error(
        'Auto-scheduling needs an active super_admin or admin to attribute exams to, and none exists'
      )
    }
    return admin.id
  }
}
