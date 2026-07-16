import type { Prisma, PrismaClient } from '@bookends/db'
import { pageMeta, type Scope } from '@bookends/core'
import { ApiError } from '../http/api-error.js'
import type { Principal } from '../infra/session-store/index.js'
import { scopeToWhere } from '../rbac/scope.js'
import type {
  AssignTrainingInput,
  CompleteTrainingInput,
  ListTrainingQuery,
  RecommendQuery,
} from './training.schemas.js'

/**
 * Training assignments (§13, §18).
 *
 * §1.2 is explicit that the exam is the input and the performance record is the
 * product. This module is where that claim is cashed: a failed topic that
 * produces no action is just a number, and this is the only thing in the system
 * that turns a score into something a person does next.
 */

const LIST_SELECT = {
  id: true,
  employeeId: true,
  topicId: true,
  sourceDocumentId: true,
  reason: true,
  status: true,
  dueDate: true,
  assignedAt: true,
  completedAt: true,
  completionNotes: true,
  isAutoAssigned: true,
  triggeringExamId: true,
  triggeringScore: true,
  employee: { select: { id: true, firstName: true, lastName: true, outletId: true } },
  topic: { select: { id: true, nameEn: true, nameHi: true, nameGu: true } },
  sourceDocument: { select: { id: true, title: true, fileUrl: true } },
} satisfies Prisma.TrainingAssignmentSelect

/** §13's default window. Long enough to actually study, short enough to matter. */
const DEFAULT_DUE_DAYS = 14

export class TrainingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * §18: who needs training, derived from what they actually got wrong.
   *
   * Per EMPLOYEE, deliberately — analytics.weakAreas() answers the group
   * question ("which topics is this outlet weak on") and this answers the
   * assignable one ("who needs what"). They look similar and are not
   * interchangeable: you cannot assign training to a department.
   *
   * Recommendations are NOT written to the database. This returns a proposal a
   * human accepts or ignores; auto-assigning on a threshold would mean a
   * borderline score silently generating homework, and §13's own framing is
   * "recommendations". The `isAutoAssigned` flag exists for a future scheduled
   * job — the column is there, the job is not, and inventing one now would put
   * unreviewed assignments in front of staff.
   */
  async recommend(principal: Principal, scope: Scope, query: RecommendQuery) {
    const employeeWhere = scopeToWhere('employee', scope, principal, 'read')

    const snapshots = await this.prisma.performanceSnapshot.findMany({
      where: {
        year: query.year,
        month: query.month,
        employee: { ...employeeWhere, employmentStatus: 'active' },
      },
      select: {
        employeeId: true,
        topicScores: true,
        averageScore: true,
        employee: { select: { firstName: true, lastName: true, outletId: true } },
      },
    })

    // Topics already assigned and still open. Recommending what someone is
    // already working on is how a useful list becomes noise nobody reads.
    const open = await this.prisma.trainingAssignment.findMany({
      where: { status: { in: ['assigned', 'in_progress'] } },
      select: { employeeId: true, topicId: true },
    })
    const alreadyOpen = new Set(open.map((a) => `${a.employeeId}:${a.topicId}`))

    const proposals: Array<{
      employeeId: string
      employeeName: string
      topicId: string
      percentage: number
      marksObtained: number
      marksAvailable: number
    }> = []

    for (const snapshot of snapshots) {
      const topics = (snapshot.topicScores ?? {}) as Record<
        string,
        { score: number; total: number }
      >

      for (const [topicId, s] of Object.entries(topics)) {
        const total = Number(s.total)
        // A topic the exam never tested for this person. Zero of zero is not a
        // weakness, and treating it as 0% would recommend training for a topic
        // they were never asked about.
        if (total <= 0) continue

        const percentage = (Number(s.score) / total) * 100
        if (percentage >= query.threshold) continue
        if (alreadyOpen.has(`${snapshot.employeeId}:${topicId}`)) continue

        proposals.push({
          employeeId: snapshot.employeeId,
          employeeName: `${snapshot.employee.firstName} ${snapshot.employee.lastName}`,
          topicId,
          percentage,
          marksObtained: Number(s.score),
          marksAvailable: total,
        })
      }
    }

    // Weakest first: this list exists to be worked from the top, and whoever
    // reads it will stop partway down.
    proposals.sort((a, b) => a.percentage - b.percentage)

    const topics = await this.prisma.topic.findMany({
      where: { id: { in: [...new Set(proposals.map((p) => p.topicId))] } },
      select: { id: true, nameEn: true, nameHi: true, nameGu: true, sourceDocumentId: true },
    })
    const topicById = new Map(topics.map((t) => [t.id, t]))

    return proposals.slice(0, query.limit).map((p) => ({
      ...p,
      topic: topicById.get(p.topicId) ?? { id: p.topicId, nameEn: 'Unknown topic' },
      // The topic's own source document, so accepting a recommendation does not
      // then require hunting for the material to read.
      suggestedSourceDocumentId: topicById.get(p.topicId)?.sourceDocumentId ?? null,
    }))
  }

  async list(principal: Principal, scope: Scope, query: ListTrainingQuery) {
    const where: Prisma.TrainingAssignmentWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.status ? { status: query.status } : {}),
      // Scoped through the employee: an outlet_manager sees their own outlet's
      // training, not everyone's. The assignment has no outletId of its own.
      employee: scopeToWhere('employee', scope, principal, 'read'),
    }

    const [rows, total] = await Promise.all([
      this.prisma.trainingAssignment.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.trainingAssignment.count({ where }),
    ])

    return { rows: rows.map(withOverdue(this.now())), meta: pageMeta(query.page, query.limit, total) }
  }

  /** §13 assign. */
  async assign(principal: Principal, scope: Scope, input: AssignTrainingInput) {
    const employee = await this.assertAssignableEmployee(principal, scope, input.employeeId)
    await this.assertRefs(input.topicId, input.sourceDocumentId)

    // One open assignment per (employee, topic). Two people independently
    // noticing the same weak score should not produce two identical pieces of
    // homework — and the second assigner needs to know the first exists.
    if (input.topicId) {
      const existing = await this.prisma.trainingAssignment.findFirst({
        where: {
          employeeId: input.employeeId,
          topicId: input.topicId,
          status: { in: ['assigned', 'in_progress'] },
        },
        select: { id: true, assignedAt: true },
      })
      if (existing) {
        throw ApiError.conflict('That training is already assigned and still open', [
          {
            field: 'topicId',
            message: `Assigned on ${existing.assignedAt.toISOString().slice(0, 10)} and not yet completed`,
          },
        ])
      }
    }

    const dueDate = input.dueDate ? new Date(input.dueDate) : this.defaultDueDate()

    return this.prisma.trainingAssignment.create({
      data: {
        tenantId: principal.tenantId,
        employeeId: employee.id,
        topicId: input.topicId ?? null,
        sourceDocumentId: input.sourceDocumentId ?? null,
        reason: input.reason ?? null,
        dueDate,
        assignedById: principal.userId,
        triggeringExamId: input.triggeringExamId ?? null,
        triggeringScore: input.triggeringScore ?? null,
        // Assigned by a person through this route. The auto-assign path (§18's
        // scheduled job) does not exist yet; when it does, it sets this true so
        // the two are distinguishable in the record forever after.
        isAutoAssigned: false,
      },
      select: LIST_SELECT,
    })
  }

  /**
   * §13 complete.
   *
   * The employee themselves may mark it done, and so may their manager. That is
   * §13's model — this is not an exam, it is "have you read the SOP", and a
   * system that requires a supervisor to witness reading is a system nobody
   * uses. The record says who marked it and when.
   */
  async complete(principal: Principal, scope: Scope, id: string, input: CompleteTrainingInput) {
    const existing = await this.prisma.trainingAssignment.findFirst({
      where: { id },
      select: { id: true, status: true, employeeId: true, employee: { select: { outletId: true, userId: true } } },
    })
    // NOT_FOUND rather than FORBIDDEN on a scope miss: a 403 confirms the
    // assignment exists, which leaks another outlet's staff (see rbac/scope.ts).
    if (!existing) throw ApiError.notFound('Training assignment not found')

    const isOwn = existing.employee.userId === principal.userId
    if (!isOwn) {
      this.assertInEmployeeScope(principal, scope, existing.employee.outletId)
    }

    if (existing.status === 'completed') {
      throw ApiError.conflict('That training is already marked complete', [
        { field: 'status', message: 'Nothing to do' },
      ])
    }

    return this.prisma.trainingAssignment.update({
      where: { id },
      data: {
        status: 'completed',
        completedAt: this.now(),
        completionNotes: input.completionNotes ?? null,
      },
      select: LIST_SELECT,
    })
  }

  /** Moves an assignment to in_progress, so a manager can see it was started. */
  async start(principal: Principal, scope: Scope, id: string) {
    const existing = await this.prisma.trainingAssignment.findFirst({
      where: { id },
      select: { id: true, status: true, employee: { select: { outletId: true, userId: true } } },
    })
    if (!existing) throw ApiError.notFound('Training assignment not found')

    if (existing.employee.userId !== principal.userId) {
      this.assertInEmployeeScope(principal, scope, existing.employee.outletId)
    }
    if (existing.status !== 'assigned') {
      throw ApiError.conflict(`Cannot start training that is ${existing.status}`, [
        { field: 'status', message: 'Only an assigned item can be started' },
      ])
    }

    return this.prisma.trainingAssignment.update({
      where: { id },
      data: { status: 'in_progress' },
      select: LIST_SELECT,
    })
  }

  private defaultDueDate(): Date {
    const due = new Date(this.now())
    due.setUTCDate(due.getUTCDate() + DEFAULT_DUE_DAYS)
    return due
  }

  private async assertAssignableEmployee(principal: Principal, scope: Scope, employeeId: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId },
      select: { id: true, outletId: true, employmentStatus: true },
    })
    if (!employee) throw ApiError.notFound('Employee not found')

    this.assertInEmployeeScope(principal, scope, employee.outletId)

    // §8.4 keeps departed staff on the books for the record. Assigning homework
    // to someone who has left is noise in a report nobody can action.
    if (['terminated', 'resigned'].includes(employee.employmentStatus)) {
      throw ApiError.validation('That employee has left', [
        { field: 'employeeId', message: `Employment status is ${employee.employmentStatus}` },
      ])
    }

    return employee
  }

  private assertInEmployeeScope(principal: Principal, scope: Scope, outletId: string): void {
    if (scope === 'all') return
    if (scope === 'none') throw ApiError.forbidden()
    if (scope === 'own_resource') return
    if (!principal.managedOutletIds.includes(outletId)) {
      throw ApiError.notFound('Training assignment not found')
    }
  }

  private async assertRefs(topicId?: string | null, sourceDocumentId?: string | null) {
    // Both are optional, but an assignment with NEITHER is a note with a due
    // date — there is nothing for the employee to actually read.
    if (!topicId && !sourceDocumentId) {
      throw ApiError.validation('Training needs something to study', [
        { field: 'topicId', message: 'Provide a topic, a source document, or both' },
      ])
    }

    if (topicId) {
      const topic = await this.prisma.topic.findFirst({ where: { id: topicId }, select: { id: true } })
      if (!topic) {
        throw ApiError.validation('Unknown topic', [{ field: 'topicId', message: 'No such topic' }])
      }
    }
    if (sourceDocumentId) {
      const doc = await this.prisma.sourceDocument.findFirst({
        where: { id: sourceDocumentId },
        select: { id: true },
      })
      if (!doc) {
        throw ApiError.validation('Unknown source document', [
          { field: 'sourceDocumentId', message: 'No such document' },
        ])
      }
    }
  }
}

/**
 * §13's `overdue` status, computed rather than stored.
 *
 * The enum has an `overdue` member, but nothing can move a row into it: that
 * would need a job running at midnight, and a status that is only true when the
 * job last ran is a status that lies. Derived from dueDate at read time, it is
 * always correct — and `currentTenantId` is untouched here because this is pure.
 */
function withOverdue(now: Date) {
  return <T extends { status: string; dueDate: Date | null }>(row: T) => ({
    ...row,
    isOverdue:
      row.status !== 'completed' && row.dueDate !== null && row.dueDate.getTime() < now.getTime(),
  })
}

/** Exported for the tests: proves the derivation, not a stored column. */
export { withOverdue }
