import type { Prisma, PrismaClient } from '@bookends/db'
import type { Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'
import { scopeToWhere, assertInScope, assertCreateInScope } from '../rbac/scope.js'
import type { CreateTemplateInput, UpdateTemplateInput } from './exam.schemas.js'

/** The §11.1 step 3 numbers that have to reconcile, as plain numbers. */
interface TemplateDistribution {
  totalMarks: number
  mcqCount: number
  mcqMarksEach: number
  theoryCount: number
  theoryMarksEach: number
  videoImageCount: number
  videoImageMarksEach: number
}

/**
 * §4.1's column defaults, mirrored from schema.prisma.
 *
 * Both paths have to judge the row that will EXIST, not the payload that
 * arrived, and an omitted column does not become zero — it becomes these. Read
 * the request instead and create disagrees with update about the same
 * template: `{ totalMarks: 20, mcqCount: 10 }` looks like 10 × 0 = 0 on the way
 * in, which the "no distribution stated" exemption waves through, and 10 × 1 =
 * 10 once stored, which fails. That asymmetry made every subsequent update of
 * such a template — including deactivating it — impossible.
 */
const COLUMN_DEFAULTS = {
  mcqCount: 0,
  mcqMarksEach: 1,
  theoryCount: 0,
  theoryMarksEach: 5,
  videoImageCount: 0,
  videoImageMarksEach: 10,
} as const

/** The distribution fields, plus the total they must reconcile against. */
const DISTRIBUTION_KEYS = [
  'totalMarks',
  'mcqCount',
  'mcqMarksEach',
  'theoryCount',
  'theoryMarksEach',
  'videoImageCount',
  'videoImageMarksEach',
] as const

const num = (value: Prisma.Decimal | number | null | undefined, fallback: number): number =>
  value === null || value === undefined ? fallback : Number(value)

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
    // Judged against the row that will be written — omitted columns take their
    // §4.1 defaults, not zero. See COLUMN_DEFAULTS.
    this.assertDistributionAddsUp(this.resolveDistribution(input, COLUMN_DEFAULTS))

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
      // The distribution columns are selected so the reconciliation below can
      // judge the template as it would be after the update.
      select: {
        id: true,
        outletId: true,
        createdById: true,
        totalMarks: true,
        mcqCount: true,
        mcqMarksEach: true,
        theoryCount: true,
        theoryMarksEach: true,
        videoImageCount: true,
        videoImageMarksEach: true,
      },
    })
    if (!existing) throw ApiError.notFound('Exam template not found')

    assertInScope(scope, principal, existing, 'write')
    await this.assertRefs(input)

    /**
     * Moving a template INTO or OUT OF global scope is itself a scope change,
     * so it is checked against the create rule rather than the write rule —
     * exactly as QuestionService.update does. Without this an outlet_manager
     * could PATCH `{ outletId: null }` and promote their own template to one
     * that applies to every outlet.
     */
    if (input.outletId !== undefined) {
      assertCreateInScope(scope, principal, { outletId: input.outletId })
    }

    /**
     * §11.1 step 3's reconciliation has to survive a partial update.
     *
     * updateTemplateSchema is createTemplateSchema.partial(), so totalMarks is
     * optional and a PATCH raising mcqCount alone sends nothing invalid on its
     * own — the imbalance exists only relative to the stored row, which is what
     * the merge below supplies.
     *
     * It runs ONLY when the request touches the distribution. A rename, a
     * re-scope, and above all `{ isActive: false }` must never be refused
     * because of numbers the operator did not send: list() hides inactive
     * templates, so blocking deactivation would leave a template that is known
     * to be wrong stuck in the picker, unable to be retired.
     */
    if (DISTRIBUTION_KEYS.some((key) => input[key] !== undefined)) {
      this.assertDistributionAddsUp(this.resolveDistribution(input, existing))
    }

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
   * Resolves the distribution as it will be stored: incoming values over a
   * baseline, which is the §4.1 column defaults on create and the stored row on
   * update. Both paths therefore judge the same thing.
   */
  private resolveDistribution(
    input: Partial<CreateTemplateInput>,
    baseline: Partial<Record<(typeof DISTRIBUTION_KEYS)[number], Prisma.Decimal | number | null>>
  ): TemplateDistribution {
    const resolve = (key: Exclude<(typeof DISTRIBUTION_KEYS)[number], 'totalMarks'>): number =>
      num(input[key] ?? baseline[key], COLUMN_DEFAULTS[key])

    return {
      totalMarks: num(input.totalMarks ?? baseline.totalMarks, 0),
      mcqCount: resolve('mcqCount'),
      mcqMarksEach: resolve('mcqMarksEach'),
      theoryCount: resolve('theoryCount'),
      theoryMarksEach: resolve('theoryMarksEach'),
      videoImageCount: resolve('videoImageCount'),
      videoImageMarksEach: resolve('videoImageMarksEach'),
    }
  }

  /**
   * §11.1 step 3's per-type counts and marks must reconcile with totalMarks.
   *
   * The columns are declarative today — nothing reads them to build an exam
   * yet, so an imbalance breaks no runtime behaviour. It is still refused at
   * the door: these numbers are what an operator reads to understand what the
   * template produces, and a template stating 20 questions worth 1 mark each
   * under a 40-mark total is describing an exam that cannot exist.
   */
  private assertDistributionAddsUp(input: TemplateDistribution): void {
    const parts = [
      input.mcqCount * input.mcqMarksEach,
      input.theoryCount * input.theoryMarksEach,
      input.videoImageCount * input.videoImageMarksEach,
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
