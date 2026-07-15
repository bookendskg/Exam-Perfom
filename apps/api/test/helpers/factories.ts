import { hashPassword, type Role } from '@bookends/core'
import { testDb } from './db.js'

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
}

export async function makeUser(opts: MakeUserOptions = {}) {
  const prisma = testDb()
  const password = opts.password ?? 'Password1'
  const phone = opts.phone ?? nextPhone()

  const user = await prisma.user.create({
    data: {
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
