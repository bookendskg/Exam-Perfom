import type { PrismaClient } from '@bookends/db'
import { ApiError } from '../http/api-error.js'
import type {
  CreateDepartmentInput,
  CreateDesignationInput,
  ListQuery,
  UpdateDepartmentInput,
  UpdateDesignationInput,
} from './organisation.schemas.js'

/** §9.2 departments and §9.3 designations. */
export class OrganisationService {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Departments (§9.2) ---------------------------------------------------

  async listDepartments(query: ListQuery) {
    return this.prisma.department.findMany({
      where: query.include_inactive ? {} : { isActive: true },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        name: true,
        code: true,
        description: true,
        isActive: true,
        _count: { select: { employees: true, designations: true } },
      },
    })
  }

  async createDepartment(input: CreateDepartmentInput) {
    await this.assertCodeFree('department', input.code)

    return this.prisma.department.create({
      data: {
        name: input.name,
        code: input.code,
        description: input.description ?? null,
      },
      select: { id: true, name: true, code: true, description: true, isActive: true },
    })
  }

  async updateDepartment(id: string, input: UpdateDepartmentInput) {
    const existing = await this.prisma.department.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    })
    if (!existing) throw ApiError.notFound('Department not found')

    if (input.isActive === false && existing.isActive) {
      const active = await this.prisma.employee.count({
        where: { departmentId: id, employmentStatus: { notIn: ['terminated', 'resigned'] } },
      })
      if (active > 0) {
        throw ApiError.conflict(
          `Cannot deactivate a department with ${active} active ${active === 1 ? 'employee' : 'employees'}`,
          [{ field: 'isActive', message: 'Reassign the staff in this department first' }]
        )
      }
    }

    return this.prisma.department.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: { id: true, name: true, code: true, description: true, isActive: true },
    })
  }

  // --- Designations (§9.3) --------------------------------------------------

  async listDesignations(query: ListQuery) {
    return this.prisma.designation.findMany({
      where: {
        ...(query.include_inactive ? {} : { isActive: true }),
        ...(query.department_id ? { departmentId: query.department_id } : {}),
      },
      // §9.3's table reads senior-first within each department.
      orderBy: [{ departmentId: 'asc' }, { level: 'desc' }],
      select: {
        id: true,
        name: true,
        code: true,
        level: true,
        isActive: true,
        department: { select: { id: true, name: true, code: true } },
        _count: { select: { employees: true } },
      },
    })
  }

  async createDesignation(input: CreateDesignationInput) {
    await this.assertCodeFree('designation', input.code)
    if (input.departmentId) await this.assertDepartmentExists(input.departmentId)

    return this.prisma.designation.create({
      data: {
        name: input.name,
        code: input.code,
        departmentId: input.departmentId ?? null,
        level: input.level,
      },
      select: { id: true, name: true, code: true, level: true, departmentId: true, isActive: true },
    })
  }

  async updateDesignation(id: string, input: UpdateDesignationInput) {
    const existing = await this.prisma.designation.findUnique({
      where: { id },
      select: { id: true, isActive: true, departmentId: true },
    })
    if (!existing) throw ApiError.notFound('Designation not found')

    if (input.departmentId) await this.assertDepartmentExists(input.departmentId)

    /**
     * Moving a designation to another department would strand every employee
     * already holding it: employee.designationId and employee.departmentId are
     * independent columns, so they would silently disagree — a Line Cook filed
     * under Housekeeping. The create path rejects that combination, so allowing
     * it here would produce records the API itself considers invalid.
     */
    if (
      input.departmentId !== undefined &&
      existing.departmentId !== null &&
      input.departmentId !== existing.departmentId
    ) {
      const holders = await this.prisma.employee.count({
        where: { designationId: id, employmentStatus: { notIn: ['terminated', 'resigned'] } },
      })
      if (holders > 0) {
        throw ApiError.conflict(
          `Cannot move a designation held by ${holders} active ${holders === 1 ? 'employee' : 'employees'} to another department`,
          [
            {
              field: 'departmentId',
              message: 'Their department would no longer match their designation',
            },
          ]
        )
      }
    }

    if (input.isActive === false && existing.isActive) {
      const holders = await this.prisma.employee.count({
        where: { designationId: id, employmentStatus: { notIn: ['terminated', 'resigned'] } },
      })
      if (holders > 0) {
        throw ApiError.conflict(
          `Cannot deactivate a designation held by ${holders} active ${holders === 1 ? 'employee' : 'employees'}`,
          [{ field: 'isActive', message: 'Reassign them first' }]
        )
      }
    }

    return this.prisma.designation.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: { id: true, name: true, code: true, level: true, departmentId: true, isActive: true },
    })
  }

  // --- Helpers --------------------------------------------------------------

  /**
   * Checked up front rather than relying on the unique constraint, so the
   * caller gets a §5.2 field error naming the clash instead of a bare P2002.
   * Inactive rows still hold their code — codes are not recycled.
   */
  private async assertCodeFree(kind: 'department' | 'designation', code: string): Promise<void> {
    const existing =
      kind === 'department'
        ? await this.prisma.department.findUnique({ where: { code } })
        : await this.prisma.designation.findUnique({ where: { code } })

    if (existing) {
      throw ApiError.conflict(`That ${kind} code is already in use`, [
        { field: 'code', message: `"${code}" belongs to ${existing.name}` },
      ])
    }
  }

  private async assertDepartmentExists(departmentId: string): Promise<void> {
    const department = await this.prisma.department.findUnique({ where: { id: departmentId } })
    if (!department || !department.isActive) {
      throw ApiError.validation('Unknown department', [
        { field: 'departmentId', message: 'No such active department' },
      ])
    }
  }
}
