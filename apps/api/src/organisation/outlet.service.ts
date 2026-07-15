import type { PrismaClient } from '@bookends/db'
import { currentTenantId } from '@bookends/db'
import type { Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal, SessionStore } from '../infra/session-store/index.js'
import type { CreateOutletInput, ListQuery, UpdateOutletInput } from './organisation.schemas.js'

const OUTLET_SELECT = {
  id: true,
  name: true,
  code: true,
  address: true,
  city: true,
  state: true,
  phone: true,
  email: true,
  managerId: true,
  isActive: true,
  lastEmployeeSeq: true,
}

export class OutletService {
  /**
   * The SessionStore is needed because an outlet's manager IS an
   * outlet_manager's authorisation scope. Changing managerId changes what that
   * user may touch, so their cached principal has to be dropped — otherwise a
   * demoted manager keeps their access until their session idles out.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessionStore: SessionStore
  ) {}

  async list(query: ListQuery) {
    return this.prisma.outlet.findMany({
      where: query.include_inactive ? {} : { isActive: true },
      orderBy: { code: 'asc' },
      select: {
        ...OUTLET_SELECT,
        manager: { select: { id: true, phone: true, role: true } },
        _count: { select: { employees: true } },
      },
    })
  }

  async getById(id: string) {
    const outlet = await this.prisma.outlet.findUnique({
      where: { id },
      select: {
        ...OUTLET_SELECT,
        manager: { select: { id: true, phone: true, role: true } },
        departments: { select: { department: { select: { id: true, name: true, code: true } } } },
        _count: { select: { employees: true } },
      },
    })
    if (!outlet) throw ApiError.notFound('Outlet not found')
    return outlet
  }

  async create(input: CreateOutletInput) {
    if (input.managerId) await this.assertAssignableManager(input.managerId)

    // Per tenant: "AK" being taken at another customer is not this tenant's
    // problem, and reporting it as a conflict would leak that they exist.
    const tenantId = currentTenantId()
    const existing = await this.prisma.outlet.findUnique({
      where: { tenantId_code: { tenantId, code: input.code } },
    })
    if (existing) {
      throw ApiError.conflict('That outlet code is already in use', [
        { field: 'code', message: `"${input.code}" belongs to ${existing.name}` },
      ])
    }

    const outlet = await this.prisma.outlet.create({
      data: {
        tenantId,
        name: input.name,
        code: input.code,
        address: input.address ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        managerId: input.managerId ?? null,
      },
      select: OUTLET_SELECT,
    })

    if (input.managerId) await this.sessionStore.invalidatePrincipal(input.managerId)
    return outlet
  }

  async update(id: string, input: UpdateOutletInput) {
    const existing = await this.prisma.outlet.findUnique({
      where: { id },
      select: { id: true, managerId: true, isActive: true },
    })
    if (!existing) throw ApiError.notFound('Outlet not found')

    if (input.managerId) await this.assertAssignableManager(input.managerId)

    // §8.4 keeps departed employees on the books, so only live ones count.
    if (input.isActive === false && existing.isActive) {
      const active = await this.prisma.employee.count({
        where: { outletId: id, employmentStatus: { notIn: ['terminated', 'resigned'] } },
      })
      if (active > 0) {
        throw ApiError.conflict(
          `Cannot deactivate an outlet with ${active} active ${active === 1 ? 'employee' : 'employees'}`,
          [
            {
              field: 'isActive',
              message: 'Transfer or off-board the staff at this outlet first',
            },
          ]
        )
      }
    }

    const outlet = await this.prisma.outlet.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.managerId !== undefined ? { managerId: input.managerId } : {}),
      },
      select: OUTLET_SELECT,
    })

    // Both sides of a handover lose their cached scope: the outgoing manager
    // must lose access immediately, and the incoming one must gain it without
    // having to log out and back in.
    if (input.managerId !== undefined) {
      const affected = [existing.managerId, input.managerId].filter(
        (v): v is string => typeof v === 'string'
      )
      await Promise.all(affected.map((userId) => this.sessionStore.invalidatePrincipal(userId)))
    }

    // Deactivating an outlet removes it from a manager's scope
    // (resolvePrincipal filters on isActive), so their principal is stale too.
    if (input.isActive === false && existing.managerId) {
      await this.sessionStore.invalidatePrincipal(existing.managerId)
    }

    return outlet
  }

  /** §5.3 GET /outlets/:id/employees. */
  async employees(id: string) {
    await this.getById(id) // 404s for an unknown outlet rather than returning []

    return this.prisma.employee.findMany({
      where: { outletId: id, employmentStatus: { notIn: ['terminated', 'resigned'] } },
      orderBy: { employeeCode: 'asc' },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        phone: true,
        employmentStatus: true,
        department: { select: { id: true, name: true, code: true } },
        designation: { select: { id: true, name: true, code: true, level: true } },
      },
    })
  }

  /** §5.3 GET /outlets/:id/stats. */
  async stats(principal: Principal, scope: Scope, id: string) {
    const outlet = await this.getById(id)

    // outlet:stats is own_outlet for an outlet_manager. 404 rather than 403 —
    // consistent with the rest of the API, and a 403 would confirm the outlet
    // exists.
    if (scope === 'own_outlet' && !principal.managedOutletIds.includes(id)) {
      throw ApiError.notFound('Outlet not found')
    }

    const [headcount, byDepartment, byStatus] = await Promise.all([
      this.prisma.employee.count({
        where: { outletId: id, employmentStatus: { notIn: ['terminated', 'resigned'] } },
      }),
      this.prisma.employee.groupBy({
        by: ['departmentId'],
        where: { outletId: id, employmentStatus: { notIn: ['terminated', 'resigned'] } },
        _count: { _all: true },
      }),
      this.prisma.employee.groupBy({
        by: ['employmentStatus'],
        where: { outletId: id },
        _count: { _all: true },
      }),
    ])

    const departments = await this.prisma.department.findMany({
      where: { id: { in: byDepartment.map((d) => d.departmentId) } },
      select: { id: true, name: true, code: true },
    })
    const nameOf = new Map(departments.map((d) => [d.id, d]))

    return {
      outlet: { id: outlet.id, name: outlet.name, code: outlet.code },
      headcount,
      byDepartment: byDepartment.map((d) => ({
        department: nameOf.get(d.departmentId) ?? {
          id: d.departmentId,
          name: 'Unknown',
          code: '?',
        },
        count: d._count._all,
      })),
      byStatus: Object.fromEntries(byStatus.map((s) => [s.employmentStatus, s._count._all])),
      // Exam and performance figures (§9 outlet stats) arrive with Modules 5-9.
      employeeCodesIssued: outlet.lastEmployeeSeq,
    }
  }

  /**
   * A manager assignment is a privilege grant, so the target must actually hold
   * the outlet_manager role. Without this check an admin could point managerId
   * at a staff account, which would silently do nothing (their role, not the
   * assignment, decides their permissions) and look like a broken feature.
   *
   * This is the validation Module 1 flagged as owed: an outlet_manager with no
   * managed outlet has scope ∅ and cannot do anything.
   */
  private async assertAssignableManager(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isActive: true },
    })

    if (!user) {
      throw ApiError.validation('Unknown user', [{ field: 'managerId', message: 'No such user' }])
    }
    if (!user.isActive) {
      throw ApiError.validation('That user account is inactive', [
        { field: 'managerId', message: 'Cannot assign an inactive user as manager' },
      ])
    }
    if (user.role !== 'outlet_manager') {
      throw ApiError.validation('That user is not an outlet manager', [
        {
          field: 'managerId',
          message: `User has role "${user.role}"; assign the outlet_manager role first`,
        },
      ])
    }
  }
}
