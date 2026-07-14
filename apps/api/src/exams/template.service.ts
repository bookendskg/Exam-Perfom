import type { Prisma, PrismaClient } from '@bookends/db'
import type { Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'
import { scopeToWhere, assertInScope, assertCreateInScope } from '../rbac/scope.js'
import type { CreateTemplateInput, UpdateTemplateInput } from './exam.schemas.js'

const TEMPLATE_SELECT = {
  id: true,
  nameEn: true,
  nameHi: true,
  nameGu: true,
  descriptionEn: true,
  outletId: true,
  departmentId: true,
  designationId: true,
  totalMarks: true,
  passingPercentage: true,
  durationMinutes: true,
  mcqCount: true,
  mcqMarksEach: true,
  theoryCount: true,
  theoryMarksEach: true,
  videoImageCount: true,
  videoImageMarksEach: true,
  questionSelection: true,
  shuffleQuestions: true,
  shuffleOptions: true,
  showResultImmediately: true,
  allowReview: true,
  allowBackNavigation: true,
  showExplanationAfter: true,
  isActive: true,
  createdById: true,
} satisfies Prisma.ExamTemplateSelect

/** §4.1 exam templates — reusable exam configurations (§11.1 step 1). */
export class TemplateService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(principal: Principal, scope: Scope) {
    const scoped = scopeToWhere('exam_template', scope, principal, 'read')

    return this.prisma.examTemplate.findMany({
      where: { AND: [scoped, { isActive: true }] },
      orderBy: { nameEn: 'asc' },
      select: { ...TEMPLATE_SELECT, _count: { select: { exams: true } } },
    })
  }

  async getById(principal: Principal, scope: Scope, id: string) {
    const template = await this.prisma.examTemplate.findUnique({
      where: { id },
      select: {
        ...TEMPLATE_SELECT,
        outlet: { select: { id: true, name: true, code: true } },
        department: { select: { id: true, name: true, code: true } },
        designation: { select: { id: true, name: true, code: true } },
        _count: { select: { exams: true, scheduleConfigs: true } },
      },
    })
    if (!template) throw ApiError.notFound('Exam template not found')

    assertInScope(
      scope,
      principal,
      { outletId: template.outletId, createdById: template.createdById },
      'read'
    )
    return template
  }

  async create(principal: Principal, scope: Scope, input: CreateTemplateInput) {
    assertCreateInScope(scope, principal, { outletId: input.outletId ?? null })
    await this.assertRefs(input)
    this.assertDistributionAddsUp(input)

    return this.prisma.examTemplate.create({
      data: {
        ...this.toColumns(input),
        nameEn: input.nameEn,
        totalMarks: input.totalMarks,
        createdById: principal.userId,
      },
      select: TEMPLATE_SELECT,
    })
  }

  async update(principal: Principal, scope: Scope, id: string, input: UpdateTemplateInput) {
    const existing = await this.prisma.examTemplate.findUnique({
      where: { id },
      select: { id: true, outletId: true, createdById: true },
    })
    if (!existing) throw ApiError.notFound('Exam template not found')

    assertInScope(scope, principal, existing, 'write')
    await this.assertRefs(input)

    // Templates are copied into exams at creation, not referenced live (§4.1's
    // exam columns duplicate them), so editing one cannot disturb an exam
    // already built from it.
    return this.prisma.examTemplate.update({
      where: { id },
      data: {
        ...this.toColumns(input),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: TEMPLATE_SELECT,
    })
  }

  /**
   * §11.1 step 3's per-type counts and marks must reconcile with totalMarks.
   *
   * A template whose parts do not add up produces exams that fail §11.3 every
   * time, and the operator would have no idea why — the numbers came from the
   * template they were told to use.
   */
  private assertDistributionAddsUp(input: CreateTemplateInput): void {
    const parts = [
      (input.mcqCount ?? 0) * (input.mcqMarksEach ?? 0),
      (input.theoryCount ?? 0) * (input.theoryMarksEach ?? 0),
      (input.videoImageCount ?? 0) * (input.videoImageMarksEach ?? 0),
    ]
    const summed = parts.reduce((a, b) => a + b, 0)

    // A template may legitimately state no distribution and rely on
    // questionSelection alone.
    if (summed === 0) return

    if (Math.abs(summed - input.totalMarks) > 0.001) {
      throw ApiError.validation('The question distribution does not total the template marks', [
        {
          field: 'totalMarks',
          message: `Counts × marks total ${summed} but totalMarks says ${input.totalMarks}`,
        },
      ])
    }
  }

  private async assertRefs(input: Partial<CreateTemplateInput>): Promise<void> {
    const details: Array<{ field: string; message: string }> = []

    if (input.outletId) {
      const outlet = await this.prisma.outlet.findUnique({ where: { id: input.outletId } })
      if (!outlet?.isActive) details.push({ field: 'outletId', message: 'Unknown outlet' })
    }
    if (input.departmentId) {
      const department = await this.prisma.department.findUnique({
        where: { id: input.departmentId },
      })
      if (!department?.isActive)
        details.push({ field: 'departmentId', message: 'Unknown department' })
    }
    if (input.designationId) {
      const designation = await this.prisma.designation.findUnique({
        where: { id: input.designationId },
      })
      if (!designation?.isActive) {
        details.push({ field: 'designationId', message: 'Unknown designation' })
      }
    }

    if (details.length > 0) throw ApiError.validation('Invalid references', details)
  }

  private toColumns(input: Partial<CreateTemplateInput>) {
    const data: Record<string, unknown> = {}
    const keys = [
      'nameEn',
      'nameHi',
      'nameGu',
      'descriptionEn',
      'descriptionHi',
      'descriptionGu',
      'outletId',
      'departmentId',
      'designationId',
      'totalMarks',
      'passingPercentage',
      'durationMinutes',
      'mcqCount',
      'mcqMarksEach',
      'theoryCount',
      'theoryMarksEach',
      'videoImageCount',
      'videoImageMarksEach',
      'shuffleQuestions',
      'shuffleOptions',
      'showResultImmediately',
      'allowReview',
      'allowBackNavigation',
      'showExplanationAfter',
    ] as const

    for (const key of keys) {
      if (input[key] !== undefined) data[key] = input[key]
    }
    if (input.questionSelection !== undefined) data['questionSelection'] = input.questionSelection

    return data as Prisma.ExamTemplateUncheckedCreateInput
  }
}
