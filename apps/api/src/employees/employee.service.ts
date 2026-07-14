import type { EmploymentStatus, Prisma, PrismaClient } from '@bookends/db'
import {
  defaultStaffPassword,
  generateAdminTempPassword,
  hashPassword,
  isStaffRole,
  pageMeta,
  type Scope,
} from '@bookends/core'
import { randomBytes } from 'node:crypto'
import { ApiError } from '../http/api-error.js'
import type { Principal, SessionStore } from '../infra/session-store/index.js'
import { scopeToWhere, assertInScope, assertCreateInScope } from '../rbac/scope.js'
import { claimEmployeeCode } from './employee-code.js'
import { assertTransition, isDeparted, timelineEventFor } from './employee-status.js'
import type {
  CreateEmployeeInput,
  ListEmployeesQuery,
  UpdateEmployeeInput,
} from './employee.schemas.js'

const LIST_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  photoUrl: true,
  outletId: true,
  departmentId: true,
  designationId: true,
  joiningDate: true,
  employmentType: true,
  employmentStatus: true,
  preferredLanguage: true,
} satisfies Prisma.EmployeeSelect

export class EmployeeService {
  /**
   * The SessionStore is not optional. Revoking user_sessions rows only ends a
   * session for a store that reads the database on every request (Postgres).
   * Any caching store — the memory store, or Redis later — keeps serving the
   * cached principal until its TTL lapses, so a terminated employee would stay
   * logged in for up to two hours. The store must be told explicitly.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessionStore: SessionStore
  ) {}

  /**
   * §5.3 GET /employees.
   *
   * Scope becomes part of the `where` rather than a filter applied afterwards,
   * so meta.total counts only rows the caller may see. Post-filtering a page
   * would paginate over invisible records and report the wrong total.
   */
  async list(principal: Principal, scope: Scope, query: ListEmployeesQuery) {
    const scoped = scopeToWhere('employee', scope, principal, 'read')

    const filters: Prisma.EmployeeWhereInput = {
      ...(query.outlet_id ? { outletId: query.outlet_id } : {}),
      ...(query.department_id ? { departmentId: query.department_id } : {}),
      // §8.4: departed employees are hidden from active lists unless asked for.
      ...(query.status
        ? { employmentStatus: query.status }
        : { employmentStatus: { notIn: ['terminated', 'resigned'] } }),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { employeeCode: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
            ],
          }
        : {}),
    }

    const where: Prisma.EmployeeWhereInput = { AND: [scoped, filters] }

    const [rows, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [{ employeeCode: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.employee.count({ where }),
    ])

    return { rows, meta: pageMeta(query.page, query.limit, total) }
  }

  /** §5.3 GET /employees/:id. Out of scope reads as 404, never 403 — see scope.ts. */
  async getById(principal: Principal, scope: Scope, id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, role: true, isActive: true, lastLoginAt: true } },
        outlet: { select: { id: true, name: true, code: true } },
        department: { select: { id: true, name: true, code: true } },
        designation: { select: { id: true, name: true, code: true, level: true } },
      },
    })
    if (!employee) throw ApiError.notFound('Employee not found')

    assertInScope(
      scope,
      principal,
      { outletId: employee.outletId, userId: employee.userId },
      'read'
    )
    return employee
  }

  /**
   * §5.3 POST /employees.
   *
   * Creates the User and Employee together — an Employee with no login is not a
   * usable record, and a User with no Employee would be indistinguishable from
   * the bootstrap super admin.
   *
   * Returns the generated password ONCE. It is never stored in plaintext and
   * cannot be retrieved later.
   */
  async create(principal: Principal, scope: Scope, input: CreateEmployeeInput) {
    // The create path: no stored row exists yet, so neither scopeToWhere nor
    // assertInScope applies. Without this an outlet_manager could POST an
    // employee into an outlet they do not manage.
    assertCreateInScope(scope, principal, { outletId: input.outletId })

    await this.assertOrgRefsExist(input)

    const existing = await this.prisma.user.findUnique({ where: { phone: input.phone } })
    if (existing) {
      throw ApiError.conflict('That phone number is already registered', [
        { field: 'phone', message: 'Already in use' },
      ])
    }

    // New employees are staff (§3.3: "Staff is the default role"). Promoting
    // someone is a role change, which only Super Admin/Admin may do (§3.2).
    const role = 'staff' as const

    // §7.3: staff get last-4-digits + "book". Admin roles cannot — that default
    // has no uppercase and fails §7.3's own admin complexity rule — so they get
    // a generated compliant password instead.
    const plainPassword = isStaffRole(role)
      ? defaultStaffPassword(input.phone)
      : generateAdminTempPassword((n) => new Uint8Array(randomBytes(n)))

    const passwordHash = await hashPassword(plainPassword)

    const employee = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          phone: input.phone,
          email: input.email ?? null,
          role,
          passwordHash,
          // §7.3 force change on first login. The default is derived from a
          // publicly-known phone number, so this is not optional.
          mustChangePassword: true,
        },
      })

      // Claimed inside the transaction so a failed insert rolls the counter back
      // rather than burning a code.
      const employeeCode = input.employeeCode ?? (await claimEmployeeCode(tx, input.outletId))

      const created = await tx.employee.create({
        data: {
          userId: user.id,
          employeeCode,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          email: input.email ?? null,
          photoUrl: input.photoUrl ?? null,
          dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
          gender: input.gender ?? null,
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          outletId: input.outletId,
          departmentId: input.departmentId,
          designationId: input.designationId,
          joiningDate: new Date(input.joiningDate),
          employmentType: input.employmentType ?? 'full_time',
          preferredLanguage: input.preferredLanguage,
          emergencyContactName: input.emergencyContactName ?? null,
          emergencyContactPhone: input.emergencyContactPhone ?? null,
          emergencyContactRelation: input.emergencyContactRelation ?? null,
          createdById: principal.userId,
        },
        select: LIST_SELECT,
      })

      await tx.employeeTimeline.create({
        data: {
          employeeId: created.id,
          eventType: 'joined',
          eventDate: new Date(input.joiningDate),
          title: 'Joined Bookends',
          createdById: principal.userId,
        },
      })

      return created
    })

    return { employee, temporaryPassword: plainPassword }
  }

  /** §5.3 PUT /employees/:id. */
  async update(principal: Principal, scope: Scope, id: string, input: UpdateEmployeeInput) {
    const existing = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, outletId: true, userId: true, employmentStatus: true },
    })
    if (!existing) throw ApiError.notFound('Employee not found')

    assertInScope(scope, principal, existing, 'write')

    if (input.departmentId || input.designationId) {
      await this.assertOrgRefsExist({
        outletId: existing.outletId,
        departmentId: input.departmentId,
        designationId: input.designationId,
      })
    }

    return this.prisma.employee.update({
      where: { id },
      data: {
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.photoUrl !== undefined ? { photoUrl: input.photoUrl } : {}),
        ...(input.dateOfBirth !== undefined ? { dateOfBirth: new Date(input.dateOfBirth) } : {}),
        ...(input.gender !== undefined ? { gender: input.gender } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
        ...(input.designationId !== undefined ? { designationId: input.designationId } : {}),
        ...(input.joiningDate !== undefined ? { joiningDate: new Date(input.joiningDate) } : {}),
        ...(input.employmentType !== undefined ? { employmentType: input.employmentType } : {}),
        ...(input.preferredLanguage !== undefined
          ? { preferredLanguage: input.preferredLanguage }
          : {}),
        ...(input.emergencyContactName !== undefined
          ? { emergencyContactName: input.emergencyContactName }
          : {}),
        ...(input.emergencyContactPhone !== undefined
          ? { emergencyContactPhone: input.emergencyContactPhone }
          : {}),
        ...(input.emergencyContactRelation !== undefined
          ? { emergencyContactRelation: input.emergencyContactRelation }
          : {}),
      },
      select: LIST_SELECT,
    })
  }

  /**
   * §5.3 DELETE /employees/:id, and §8.4's status machine.
   *
   * §8.4: "Terminated/Resigned employees are soft-deleted (hidden from active
   * lists but data retained)". A hard delete would cascade away their exam
   * history, which is the entire point of the product.
   */
  async changeStatus(
    principal: Principal,
    scope: Scope,
    id: string,
    status: EmploymentStatus,
    reason?: string
  ) {
    const existing = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, outletId: true, userId: true, employmentStatus: true },
    })
    if (!existing) throw ApiError.notFound('Employee not found')

    assertInScope(scope, principal, existing, 'write')
    assertTransition(existing.employmentStatus, status)

    const deactivates = isDeparted(status) || status === 'suspended'

    const updated = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { id },
        data: { employmentStatus: status },
        select: LIST_SELECT,
      })

      // A departed or suspended employee must not be able to log in. Leaving the
      // account enabled is how a terminated employee keeps taking exams.
      if (deactivates) {
        await tx.user.update({ where: { id: existing.userId }, data: { isActive: false } })
        await tx.userSession.updateMany({
          where: { userId: existing.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'admin_revoke' },
        })
      } else if (status === 'active') {
        await tx.user.update({ where: { id: existing.userId }, data: { isActive: true } })
      }

      await tx.employeeTimeline.create({
        data: {
          employeeId: id,
          eventType: timelineEventFor(status),
          title: `Status changed from ${existing.employmentStatus} to ${status}`,
          description: reason ?? null,
          metadata: { from: existing.employmentStatus, to: status },
          createdById: principal.userId,
        },
      })

      return updated
    })

    // Outside the transaction: the store is not transactional, so evicting
    // before commit would log someone out of a change that then rolled back.
    if (deactivates) {
      await this.sessionStore.deleteAllForUser(existing.userId)
    }

    return updated
  }

  /** §5.3 GET /employees/:id/timeline. */
  async timeline(principal: Principal, scope: Scope, id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, outletId: true, userId: true },
    })
    if (!employee) throw ApiError.notFound('Employee not found')

    assertInScope(scope, principal, employee, 'read')

    return this.prisma.employeeTimeline.findMany({
      where: { employeeId: id },
      orderBy: { eventDate: 'desc' },
    })
  }

  /**
   * Verifies outlet/department/designation exist and are coherent.
   *
   * Without the designation-department check, a Line Cook could be filed under
   * Housekeeping — the FKs accept it, because they only constrain each id
   * individually.
   */
  private async assertOrgRefsExist(input: {
    outletId?: string
    departmentId?: string | undefined
    designationId?: string | undefined
  }): Promise<void> {
    const details: Array<{ field: string; message: string }> = []

    if (input.outletId) {
      const outlet = await this.prisma.outlet.findUnique({ where: { id: input.outletId } })
      if (!outlet || !outlet.isActive)
        details.push({ field: 'outletId', message: 'Unknown outlet' })
    }

    let department = null
    if (input.departmentId) {
      department = await this.prisma.department.findUnique({ where: { id: input.departmentId } })
      if (!department || !department.isActive) {
        details.push({ field: 'departmentId', message: 'Unknown department' })
      }
    }

    if (input.designationId) {
      const designation = await this.prisma.designation.findUnique({
        where: { id: input.designationId },
      })
      if (!designation || !designation.isActive) {
        details.push({ field: 'designationId', message: 'Unknown designation' })
      } else if (
        input.departmentId &&
        designation.departmentId &&
        designation.departmentId !== input.departmentId
      ) {
        details.push({
          field: 'designationId',
          message: 'That designation does not belong to the selected department',
        })
      }
    }

    if (details.length > 0) throw ApiError.validation('Invalid organisational references', details)
  }
}
