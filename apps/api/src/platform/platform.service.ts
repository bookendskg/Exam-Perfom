import type { Prisma, PrismaClient, PlatformRole } from '@bookends/db'
import { runAsPlatform } from '@bookends/db'
import { hashPassword, verifyPassword, verifyAgainstDummy } from '@bookends/core'
import { ApiError } from '../http/api-error.js'

/**
 * Platform operations (§10): the SaaS owner's view across every tenant.
 *
 * ---------------------------------------------------------------------------
 * Every query here is runAsPlatform, and that is correct rather than lazy.
 *
 * This service's entire job is to see across tenants — listing customers,
 * suspending one, changing another's plan. There is no ambient tenant, and
 * scoping to one would be meaningless. The tables it touches (platform_admins,
 * platform_audit_logs, tenants, plans) carry no tenantId, so the extension
 * ignores them anyway; the wrapper is there for the queries that DO touch
 * tenant-scoped tables — the usage counts.
 *
 * The safety here is not tenant scoping. It is that reaching this code at all
 * requires a token signed with PLATFORM_JWT_SECRET, which no tenant possesses.
 * ---------------------------------------------------------------------------
 */

const SCOPE = 'platform admin: operating across tenants by definition'

export interface PlatformPrincipal {
  adminId: string
  role: PlatformRole
}

/** What an operator saw when they acted, so the audit entry can say so. */
export interface AuditContext {
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

export class PlatformService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * §10 login.
   *
   * Mirrors auth.service.ts's anti-enumeration behaviour deliberately: unknown
   * email, wrong password and deactivated account are indistinguishable, and an
   * unknown email still burns a dummy argon2 verify so the timing does not
   * answer the question the response refuses to.
   *
   * There is no lockout here, unlike tenant login. The reasoning there was that
   * staff passwords are six characters and derived from a public phone number;
   * platform admins are a handful of operators with generated passwords, and a
   * lockout on this endpoint is a denial-of-service against the people who
   * would have to fix it. Revisit if the operator count ever grows.
   */
  async login(email: string, password: string): Promise<{ adminId: string; role: PlatformRole }> {
    const admin = await runAsPlatform(SCOPE, () =>
      this.prisma.platformAdmin.findUnique({ where: { email: email.toLowerCase() } })
    )

    if (!admin) {
      await verifyAgainstDummy(password)
      throw ApiError.invalidCredentials()
    }

    const valid = await verifyPassword(password, admin.passwordHash)
    if (!valid || !admin.isActive) throw ApiError.invalidCredentials()

    await runAsPlatform(SCOPE, () =>
      this.prisma.platformAdmin.update({
        where: { id: admin.id },
        data: { lastLoginAt: new Date() },
      })
    )

    return { adminId: admin.id, role: admin.role }
  }

  async findAdmin(id: string) {
    return runAsPlatform(SCOPE, () =>
      this.prisma.platformAdmin.findUnique({
        where: { id },
        select: { id: true, email: true, name: true, role: true, isActive: true },
      })
    )
  }

  /** §10.2 tenant list, with the usage figures the dashboard needs. */
  async listTenants(query: { status?: string; search?: string; page: number; limit: number }) {
    const where: Prisma.TenantWhereInput = {
      deletedAt: null,
      ...(query.status ? { subscriptionStatus: query.status as never } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { slug: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }

    return runAsPlatform(SCOPE, async () => {
      const [rows, total] = await Promise.all([
        this.prisma.tenant.findMany({
          where,
          select: {
            id: true,
            name: true,
            slug: true,
            subscriptionStatus: true,
            isActive: true,
            suspendedAt: true,
            suspendedReason: true,
            createdAt: true,
            plan: { select: { code: true, name: true } },
            _count: { select: { users: true, outlets: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.prisma.tenant.count({ where }),
      ])
      return { rows, total }
    })
  }

  /**
   * §10.2 tenant detail, including live usage against the plan's limits.
   *
   * Counted live, for the same reason planGuard counts live: tenant_usage is a
   * per-billing-period rollup and reads as zero on the 1st of the month until
   * the usage job runs. A dashboard that told you a customer had 0 employees
   * every month-start would be worse than no dashboard.
   */
  async getTenant(id: string) {
    return runAsPlatform(SCOPE, async () => {
      const tenant = await this.prisma.tenant.findFirst({
        where: { id, deletedAt: null },
        include: { plan: true },
      })
      if (!tenant) throw ApiError.tenantNotFound()

      const [employees, outlets, questions] = await Promise.all([
        this.prisma.employee.count({
          where: { tenantId: id, employmentStatus: { notIn: ['terminated', 'resigned'] } },
        }),
        this.prisma.outlet.count({ where: { tenantId: id, isActive: true } }),
        this.prisma.question.count({ where: { tenantId: id } }),
      ])

      return {
        tenant,
        usage: {
          employees: { used: employees, limit: tenant.plan?.maxEmployees ?? null },
          outlets: { used: outlets, limit: tenant.plan?.maxOutlets ?? null },
          questions: { used: questions, limit: tenant.plan?.maxQuestions ?? null },
        },
      }
    })
  }

  /**
   * §10.2 suspend.
   *
   * Sets isActive=false, which tenant.resolver.ts already treats as "not found"
   * at login — so a suspended tenant's staff simply cannot get a token, and
   * every existing session dies at its next request because the session store
   * re-reads the principal. No separate revocation pass is needed; that is a
   * property of the session design, not an accident, and it is worth knowing
   * before someone "optimises" the store into caching.
   */
  async suspendTenant(
    principal: PlatformPrincipal,
    tenantId: string,
    reason: string,
    ctx: AuditContext
  ) {
    return runAsPlatform(SCOPE, async () => {
      const existing = await this.prisma.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { id: true, isActive: true, subscriptionStatus: true, slug: true },
      })
      if (!existing) throw ApiError.tenantNotFound()

      const tenant = await this.prisma.tenant.update({
        where: { id: tenantId },
        data: {
          isActive: false,
          subscriptionStatus: 'suspended',
          suspendedAt: new Date(),
          suspendedReason: reason,
        },
        select: { id: true, slug: true, isActive: true, subscriptionStatus: true },
      })

      await this.audit(principal, 'tenant.suspend', tenantId, ctx, {
        reason,
        from: { isActive: existing.isActive, status: existing.subscriptionStatus },
        to: { isActive: false, status: 'suspended' },
      })

      return tenant
    })
  }

  /** §10.2 activate — the inverse, and equally audited. */
  async activateTenant(principal: PlatformPrincipal, tenantId: string, ctx: AuditContext) {
    return runAsPlatform(SCOPE, async () => {
      const existing = await this.prisma.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { id: true, isActive: true, subscriptionStatus: true },
      })
      if (!existing) throw ApiError.tenantNotFound()

      const tenant = await this.prisma.tenant.update({
        where: { id: tenantId },
        data: {
          isActive: true,
          subscriptionStatus: 'active',
          suspendedAt: null,
          suspendedReason: null,
        },
        select: { id: true, slug: true, isActive: true, subscriptionStatus: true },
      })

      await this.audit(principal, 'tenant.activate', tenantId, ctx, {
        from: { isActive: existing.isActive, status: existing.subscriptionStatus },
        to: { isActive: true, status: 'active' },
      })

      return tenant
    })
  }

  /**
   * §10.2 plan change.
   *
   * A downgrade is allowed even when the tenant is already over the new plan's
   * limits (§24.1): existing data is kept, and planGuard simply refuses new
   * creations until they are back under. Blocking the downgrade instead would
   * trap a customer on a tier they are trying to leave, which is a worse answer
   * to the same problem — and the guard's `>` (not `===`) comparison is what
   * makes the over-limit state safe.
   */
  async changePlan(
    principal: PlatformPrincipal,
    tenantId: string,
    planCode: string,
    ctx: AuditContext
  ) {
    return runAsPlatform(SCOPE, async () => {
      const [tenant, plan] = await Promise.all([
        this.prisma.tenant.findFirst({
          where: { id: tenantId, deletedAt: null },
          include: { plan: { select: { code: true } } },
        }),
        this.prisma.plan.findUnique({ where: { code: planCode } }),
      ])

      if (!tenant) throw ApiError.tenantNotFound()
      if (!plan) {
        throw ApiError.validation('Unknown plan', [
          { field: 'planCode', message: `No plan with code "${planCode}"` },
        ])
      }

      const updated = await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { planId: plan.id },
        select: { id: true, slug: true, plan: { select: { code: true, name: true } } },
      })

      await this.audit(principal, 'tenant.plan_change', tenantId, ctx, {
        from: tenant.plan?.code ?? null,
        to: plan.code,
      })

      return updated
    })
  }

  /** §10.2 audit trail for a tenant, or platform-wide when no tenant is given. */
  async listAuditLogs(query: { tenantId?: string; page: number; limit: number }) {
    const where: Prisma.PlatformAuditLogWhereInput = query.tenantId
      ? { targetTenantId: query.tenantId }
      : {}

    return runAsPlatform(SCOPE, async () => {
      const [rows, total] = await Promise.all([
        this.prisma.platformAuditLog.findMany({
          where,
          include: { admin: { select: { email: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.prisma.platformAuditLog.count({ where }),
      ])
      return { rows, total }
    })
  }

  /**
   * Writes the audit entry.
   *
   * Called inside each mutation rather than from middleware, deliberately: a
   * middleware log records what was REQUESTED, this records what actually
   * changed — including the before-state, which no middleware can know. §20.2
   * asks for the platform trail because suspending a customer is invisible to
   * them and irreversible in effect; "an admin called this endpoint" would not
   * answer the question anyone actually asks afterwards.
   */
  private async audit(
    principal: PlatformPrincipal,
    action: string,
    targetTenantId: string | null,
    ctx: AuditContext,
    details: Record<string, unknown>
  ): Promise<void> {
    await this.prisma.platformAuditLog.create({
      data: {
        adminId: principal.adminId,
        targetTenantId,
        action,
        details: details as never,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    })
  }

  /** Creates a platform admin. No HTTP route — see the CLI in scripts/. */
  static async createAdmin(
    prisma: PrismaClient,
    input: { email: string; name: string; password: string; role: PlatformRole }
  ) {
    return runAsPlatform(SCOPE, async () =>
      prisma.platformAdmin.create({
        data: {
          email: input.email.toLowerCase(),
          name: input.name,
          role: input.role,
          passwordHash: await hashPassword(input.password),
        },
        select: { id: true, email: true, name: true, role: true },
      })
    )
  }
}
