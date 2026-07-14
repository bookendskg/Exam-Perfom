import type { PrismaClient } from '@bookends/db'
import { z } from 'zod'
import { ApiError } from '../http/api-error.js'

/**
 * §4.1 source documents — the cookbooks, SOPs and manuals questions are drawn
 * from (§1.3: "Questions are derived from SOPs, training manuals, cookbooks,
 * recipes, service manuals").
 */
export const createSourceDocumentSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(255),
  type: z.enum([
    'cookbook',
    'sop',
    'training_manual',
    'recipe',
    'service_manual',
    'hygiene_guide',
    'other',
  ]),
  description: z.string().trim().max(2000).optional(),
  fileUrl: z.string().url('Must be a valid URL').optional(),
  /** NULL = applies to all outlets (§4.1). */
  outletId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().optional(),
  version: z.string().trim().max(20).optional(),
})

export const updateSourceDocumentSchema = createSourceDocumentSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })

export const listSourceDocumentsQuerySchema = z.object({
  type: z
    .enum([
      'cookbook',
      'sop',
      'training_manual',
      'recipe',
      'service_manual',
      'hygiene_guide',
      'other',
    ])
    .optional(),
  outlet_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export type CreateSourceDocumentInput = z.infer<typeof createSourceDocumentSchema>
export type UpdateSourceDocumentInput = z.infer<typeof updateSourceDocumentSchema>
export type ListSourceDocumentsQuery = z.infer<typeof listSourceDocumentsQuerySchema>

const DOC_SELECT = {
  id: true,
  title: true,
  type: true,
  description: true,
  fileUrl: true,
  outletId: true,
  departmentId: true,
  version: true,
  isActive: true,
  uploadedById: true,
  createdAt: true,
}

export class SourceDocumentService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: ListSourceDocumentsQuery) {
    return this.prisma.sourceDocument.findMany({
      where: {
        ...(query.include_inactive ? {} : { isActive: true }),
        ...(query.type ? { type: query.type } : {}),
        ...(query.department_id ? { departmentId: query.department_id } : {}),
        // A document with outletId NULL applies everywhere, so an outlet filter
        // must include the global ones or Aiko's list hides the shared SOPs.
        ...(query.outlet_id ? { OR: [{ outletId: query.outlet_id }, { outletId: null }] } : {}),
      },
      orderBy: [{ type: 'asc' }, { title: 'asc' }],
      select: { ...DOC_SELECT, _count: { select: { questions: true, topics: true } } },
    })
  }

  async getById(id: string) {
    const document = await this.prisma.sourceDocument.findUnique({
      where: { id },
      select: {
        ...DOC_SELECT,
        outlet: { select: { id: true, name: true, code: true } },
        department: { select: { id: true, name: true, code: true } },
        topics: { select: { id: true, nameEn: true }, orderBy: { sortOrder: 'asc' } },
        _count: { select: { questions: true } },
      },
    })
    if (!document) throw ApiError.notFound('Source document not found')
    return document
  }

  async create(uploadedById: string, input: CreateSourceDocumentInput) {
    await this.assertRefs(input.outletId, input.departmentId)

    return this.prisma.sourceDocument.create({
      data: {
        title: input.title,
        type: input.type,
        description: input.description ?? null,
        fileUrl: input.fileUrl ?? null,
        outletId: input.outletId ?? null,
        departmentId: input.departmentId ?? null,
        version: input.version ?? '1.0',
        uploadedById,
      },
      select: DOC_SELECT,
    })
  }

  async update(id: string, input: UpdateSourceDocumentInput) {
    const existing = await this.prisma.sourceDocument.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    })
    if (!existing) throw ApiError.notFound('Source document not found')

    await this.assertRefs(input.outletId, input.departmentId)

    if (input.isActive === false && existing.isActive) {
      const live = await this.prisma.question.count({
        where: { sourceDocumentId: id, status: { not: 'archived' } },
      })
      if (live > 0) {
        throw ApiError.conflict(
          `Cannot deactivate a document cited by ${live} live ${live === 1 ? 'question' : 'questions'}`,
          [
            {
              field: 'isActive',
              message: '§10.3 requires a source reference; those questions would lose theirs',
            },
          ]
        )
      }
    }

    return this.prisma.sourceDocument.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.fileUrl !== undefined ? { fileUrl: input.fileUrl } : {}),
        ...(input.outletId !== undefined ? { outletId: input.outletId } : {}),
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: DOC_SELECT,
    })
  }

  private async assertRefs(outletId?: string | null, departmentId?: string): Promise<void> {
    const details: Array<{ field: string; message: string }> = []

    if (outletId) {
      const outlet = await this.prisma.outlet.findUnique({ where: { id: outletId } })
      if (!outlet || !outlet.isActive)
        details.push({ field: 'outletId', message: 'Unknown outlet' })
    }
    if (departmentId) {
      const department = await this.prisma.department.findUnique({ where: { id: departmentId } })
      if (!department || !department.isActive) {
        details.push({ field: 'departmentId', message: 'Unknown department' })
      }
    }

    if (details.length > 0) throw ApiError.validation('Invalid references', details)
  }
}
