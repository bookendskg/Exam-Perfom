import { hashPassword, type Role } from '@bookends/core'
import { testDb, testTenantId } from './db.js'

let phoneCounter = 9000000000

export function nextPhone(): string {
  return String(phoneCounter++)
}

export interface MakeUserOptions {
  role?: Role
  password?: string
  phone?: string
  isActive?: boolean
  mustChangePassword?: boolean
  /** Attach an Employee record. Users without one exist — e.g. the seeded super admin. */
  withEmployee?: boolean
  /** Outlets this user manages (drives outlet_manager scope via Outlet.managerId). */
  managesOutletCodes?: string[]
  employeeOutletCode?: string
  /** Defaults to the anchor tenant. Only cross-tenant tests need to set it. */
  tenantId?: string
}

export async function makeUser(opts: MakeUserOptions = {}) {
  const prisma = testDb()
  const password = opts.password ?? 'Password1'
  const phone = opts.phone ?? nextPhone()
  const tenantId = opts.tenantId ?? testTenantId()

  const user = await prisma.user.create({
    data: {
      tenantId,
      phone,
      role: opts.role ?? 'staff',
      passwordHash: await hashPassword(password),
      isActive: opts.isActive ?? true,
      mustChangePassword: opts.mustChangePassword ?? false,
    },
  })

  if (opts.withEmployee) {
    const outlet = await prisma.outlet.findFirstOrThrow({
      where: opts.employeeOutletCode ? { code: opts.employeeOutletCode } : {},
    })
    const department = await prisma.department.findFirstOrThrow({ where: { code: 'KIT' } })
    const designation = await prisma.designation.findFirstOrThrow({ where: { code: 'LCOOK' } })

    /**
     * A real employee always has a §8.2 code — EmployeeService.create claims
     * one from the outlet counter. The factory bypasses that path, so it claims
     * one the same way, or fixtures drift from production: a test would see a
     * null employeeCode that the live API can never produce.
     */
    const claimed = await prisma.outlet.update({
      where: { id: outlet.id },
      data: { lastEmployeeSeq: { increment: 1 } },
      select: { code: true, lastEmployeeSeq: true },
    })

    await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeCode: `BK-${claimed.code}-${String(claimed.lastEmployeeSeq).padStart(3, '0')}`,
        firstName: 'Test',
        lastName: 'User',
        phone,
        outletId: outlet.id,
        departmentId: department.id,
        designationId: designation.id,
        joiningDate: new Date('2026-01-01'),
      },
    })
  }

  if (opts.managesOutletCodes?.length) {
    await prisma.outlet.updateMany({
      where: { code: { in: opts.managesOutletCodes } },
      data: { managerId: user.id },
    })
  }

  return { user, password, phone }
}

/**
 * Reference data from §9. truncateAll() deliberately spares outlets,
 * departments and designations, but managerId gets stamped by tests — reset it
 * so an outlet_manager fixture from one test does not leak into the next.
 */
export async function resetOutletManagers(): Promise<void> {
  await testDb().outlet.updateMany({ data: { managerId: null } })
}

/**
 * Puts the tenant on one of the seeded plans (starter | professional | enterprise).
 *
 * All three exist in every run — globalSetup seeds them. The anchor defaults to
 * professional, and truncateAll() puts it back, so a test may downgrade freely.
 *
 * Takes effect on the very next request: nothing caches the plan, by design.
 */
export async function usePlan(code: string, tenantId = testTenantId()): Promise<void> {
  const plan = await testDb().plan.findUniqueOrThrow({ where: { code } })
  await testDb().tenant.update({ where: { id: tenantId }, data: { planId: plan.id } })
}

/**
 * Puts the tenant on a throwaway plan with exactly the limits under test.
 *
 * Better than the seeded tiers for edge cases — asserting the boundary at 50
 * means creating 50 employees, whereas a plan with maxEmployees: 1 asserts the
 * same arithmetic in two rows. truncateAll() deletes plans it does not
 * recognise, so these do not leak.
 */
export async function useCustomPlan(
  limits: {
    maxEmployees?: number | null
    maxOutlets?: number | null
    maxQuestions?: number | null
    maxExamsPerMonth?: number | null
    questionTypes?: string[]
    autoScheduling?: boolean
  },
  tenantId = testTenantId()
): Promise<string> {
  const code = `test-plan-${planCounter++}`
  const plan = await testDb().plan.create({
    data: {
      code,
      name: code,
      // Spread AFTER the defaults so an explicit `null` (unlimited) survives —
      // `?? null` on each would work too, but this way a limit the test does not
      // mention stays unlimited rather than silently becoming zero.
      maxEmployees: null,
      maxOutlets: null,
      maxQuestions: null,
      maxExamsPerMonth: null,
      questionTypes: ['mcq', 'theory', 'video_image'],
      autoScheduling: true,
      ...limits,
    },
  })
  await testDb().tenant.update({ where: { id: tenantId }, data: { planId: plan.id } })
  return plan.id
}

let planCounter = 1
