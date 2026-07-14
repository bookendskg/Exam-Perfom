import type { PrismaClient } from '@bookends/db'
import { z } from 'zod'
import { ApiError } from '../http/api-error.js'

/** §4.1 topics — a tree, scoped to a department, trilingual (§6.2). */

export const createTopicSchema = z.object({
  nameEn: z.string().trim().min(1, 'English name is required').max(255),
  nameHi: z.string().trim().max(255).optional(),
  nameGu: z.string().trim().max(255).optional(),
  sourceDocumentId: z.string().uuid().optional(),
  parentTopicId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  sortOrder: z.coerce.number().int().min(0).max(32767).optional(),
})

export const updateTopicSchema = createTopicSchema.partial().extend({
  isActive: z.boolean().optional(),
  parentTopicId: z.string().uuid().nullable().optional(),
})

export const listTopicsQuerySchema = z.object({
  department_id: z.string().uuid().optional(),
  source_document_id: z.string().uuid().optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Nest into a tree instead of a flat list. */
  tree: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export type CreateTopicInput = z.infer<typeof createTopicSchema>
export type UpdateTopicInput = z.infer<typeof updateTopicSchema>
export type ListTopicsQuery = z.infer<typeof listTopicsQuerySchema>

const TOPIC_SELECT = {
  id: true,
  nameEn: true,
  nameHi: true,
  nameGu: true,
  sourceDocumentId: true,
  parentTopicId: true,
  departmentId: true,
  sortOrder: true,
  isActive: true,
}

interface TopicNode {
  id: string
  parentTopicId: string | null
  children: TopicNode[]
  [key: string]: unknown
}

export class TopicService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: ListTopicsQuery) {
    const topics = await this.prisma.topic.findMany({
      where: {
        ...(query.include_inactive ? {} : { isActive: true }),
        ...(query.department_id ? { departmentId: query.department_id } : {}),
        ...(query.source_document_id ? { sourceDocumentId: query.source_document_id } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      select: { ...TOPIC_SELECT, _count: { select: { questions: true } } },
    })

    return query.tree ? buildTree(topics) : topics
  }

  async create(input: CreateTopicInput) {
    if (input.parentTopicId) await this.assertTopicExists(input.parentTopicId, 'parentTopicId')
    if (input.departmentId) await this.assertDepartmentExists(input.departmentId)
    if (input.sourceDocumentId) await this.assertDocumentExists(input.sourceDocumentId)

    return this.prisma.topic.create({
      data: {
        nameEn: input.nameEn,
        nameHi: input.nameHi ?? null,
        nameGu: input.nameGu ?? null,
        sourceDocumentId: input.sourceDocumentId ?? null,
        parentTopicId: input.parentTopicId ?? null,
        departmentId: input.departmentId ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
      select: TOPIC_SELECT,
    })
  }

  async update(id: string, input: UpdateTopicInput) {
    const existing = await this.prisma.topic.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    })
    if (!existing) throw ApiError.notFound('Topic not found')

    if (input.parentTopicId) {
      await this.assertTopicExists(input.parentTopicId, 'parentTopicId')
      await this.assertNoCycle(id, input.parentTopicId)
    }
    if (input.departmentId) await this.assertDepartmentExists(input.departmentId)
    if (input.sourceDocumentId) await this.assertDocumentExists(input.sourceDocumentId)

    if (input.isActive === false && existing.isActive) {
      // Questions reference topics; deactivating one out from under a live
      // question leaves it categorised under something the UI will not show.
      const live = await this.prisma.question.count({
        where: { topicId: id, status: { not: 'archived' } },
      })
      if (live > 0) {
        throw ApiError.conflict(
          `Cannot deactivate a topic used by ${live} live ${live === 1 ? 'question' : 'questions'}`,
          [{ field: 'isActive', message: 'Recategorise or archive those questions first' }]
        )
      }
    }

    return this.prisma.topic.update({
      where: { id },
      data: {
        ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
        ...(input.nameHi !== undefined ? { nameHi: input.nameHi } : {}),
        ...(input.nameGu !== undefined ? { nameGu: input.nameGu } : {}),
        ...(input.sourceDocumentId !== undefined
          ? { sourceDocumentId: input.sourceDocumentId }
          : {}),
        ...(input.parentTopicId !== undefined ? { parentTopicId: input.parentTopicId } : {}),
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: TOPIC_SELECT,
    })
  }

  /**
   * A topic cannot become its own ancestor. The self-referencing FK happily
   * permits A→B→A, which would make the tree builder recurse forever and any
   * ancestor walk hang.
   */
  private async assertNoCycle(id: string, newParentId: string): Promise<void> {
    if (id === newParentId) {
      throw ApiError.validation('A topic cannot be its own parent', [
        { field: 'parentTopicId', message: 'Cannot be itself' },
      ])
    }

    let cursor: string | null = newParentId
    const seen = new Set<string>([id])

    while (cursor) {
      if (seen.has(cursor)) {
        throw ApiError.validation('That would create a loop in the topic tree', [
          { field: 'parentTopicId', message: 'The chosen parent is a descendant of this topic' },
        ])
      }
      seen.add(cursor)

      const parent: { parentTopicId: string | null } | null = await this.prisma.topic.findUnique({
        where: { id: cursor },
        select: { parentTopicId: true },
      })
      cursor = parent?.parentTopicId ?? null
    }
  }

  private async assertTopicExists(id: string, field: string): Promise<void> {
    const topic = await this.prisma.topic.findUnique({ where: { id } })
    if (!topic) throw ApiError.validation('Unknown topic', [{ field, message: 'No such topic' }])
  }

  private async assertDepartmentExists(id: string): Promise<void> {
    const department = await this.prisma.department.findUnique({ where: { id } })
    if (!department || !department.isActive) {
      throw ApiError.validation('Unknown department', [
        { field: 'departmentId', message: 'No such active department' },
      ])
    }
  }

  private async assertDocumentExists(id: string): Promise<void> {
    const document = await this.prisma.sourceDocument.findUnique({ where: { id } })
    if (!document || !document.isActive) {
      throw ApiError.validation('Unknown source document', [
        { field: 'sourceDocumentId', message: 'No such active document' },
      ])
    }
  }
}

/** Nests a flat list. Orphans (parent filtered out by a query) surface at root. */
function buildTree<T extends { id: string; parentTopicId: string | null }>(rows: T[]): TopicNode[] {
  const nodes = new Map<string, TopicNode>(
    rows.map((r) => [r.id, { ...r, children: [] } as unknown as TopicNode])
  )
  const roots: TopicNode[] = []

  for (const node of nodes.values()) {
    const parent = node.parentTopicId ? nodes.get(node.parentTopicId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  return roots
}
