import { Router } from 'express'
import { ok, type Language } from '@bookends/core'
import type { Deps } from '../app.js'
import { singleFileUpload } from '../http/middleware/upload.js'
import { planGuard } from '../plans/plan-guard.middleware.js'
import { PlanService } from '../plans/plan.service.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { QuestionService } from './question.service.js'
import { TopicService } from './topic.service.js'
import { SourceDocumentService } from './source-document.service.js'
import { parseUpload } from '../bulk-import/parse.js'
import { QuestionImportService } from './bulk-import/question-import.service.js'
import { QUESTION_IMPORT_COLUMNS } from './bulk-import/question-row.js'
import {
  createQuestionSchema,
  updateQuestionSchema,
  listQuestionsQuerySchema,
  reviewSchema,
  rejectSchema,
  idParamSchema,
  type CreateQuestionInput,
  type ListQuestionsQuery,
  type RejectInput,
  type ReviewInput,
  type UpdateQuestionInput,
} from './question.schemas.js'
import {
  createTopicSchema,
  updateTopicSchema,
  listTopicsQuerySchema,
  type CreateTopicInput,
  type ListTopicsQuery,
  type UpdateTopicInput,
} from './topic.service.js'
import {
  createSourceDocumentSchema,
  updateSourceDocumentSchema,
  listSourceDocumentsQuerySchema,
  type CreateSourceDocumentInput,
  type ListSourceDocumentsQuery,
  type UpdateSourceDocumentInput,
} from './source-document.service.js'

export function buildQuestionRouters(deps: Deps) {
  const plans = new PlanService(deps.prisma)
  const questions = new QuestionService(deps.prisma, plans)
  const topics = new TopicService(deps.prisma)
  const documents = new SourceDocumentService(deps.prisma)
  const importer = new QuestionImportService(deps.prisma, plans)
  const guard = planGuard(plans)

  // Shared with the employee importer. Beyond deduplicating the multer error
  // translation, the shared version is what preserves the tenant context across
  // the upload — see its docblock.
  const uploadSingle = (field: string) => singleFileUpload(field)

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  const questionRouter = Router()

  // §5.3 GET /questions/stats — above /:id so "stats" is not read as an id.
  questionRouter.get('/stats', requirePermission('question:read'), (req, res, next) => {
    void (async () => {
      try {
        res.json(ok(await questions.stats(requirePrincipal(req), scopeOf(req))))
      } catch (err) {
        next(err)
      }
    })()
  })

  /**
   * §5.3 POST /api/v1/questions/bulk-import — §3.2: super_admin and admin only.
   * Mounted above /:id so "bulk-import" is never read as an id.
   */
  questionRouter.post(
    '/bulk-import',
    requirePermission('question:import'),
    // Fast-fail only — do NOT mistake this for enforcement. It fires once, and
    // the importer then inserts N rows. A tenant at 499/500 passes here and
    // would land at 699. QuestionImportService decrements real capacity per row.
    guard.limit('maxQuestions'),
    uploadSingle('file'),
    (req, res, next) => {
      void (async () => {
        try {
          if (!req.file) {
            throw ApiError.validation('No file uploaded', [
              { field: 'file', message: 'Attach a .csv or .xlsx file in the "file" field' },
            ])
          }

          const rows = await parseUpload(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
            QUESTION_IMPORT_COLUMNS
          )

          const report = await importer.run(requirePrincipal(req), rows, {
            dryRun: req.query['dryRun'] === 'true',
          })
          res.json(ok(report))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  questionRouter.get(
    '/',
    requirePermission('question:read'),
    validate({ query: listQuestionsQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { rows, meta } = await questions.list(
            requirePrincipal(req),
            scopeOf(req),
            req.valid!.query as ListQuestionsQuery
          )
          res.json(ok(rows, meta))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  questionRouter.post(
    '/',
    requirePermission('question:create'),
    validate({ body: createQuestionSchema }),
    // Both after validate(): the type gate reads the VALIDATED body, so it can
    // trust `type` is a real QuestionType and only has to ask whether the plan
    // includes it. Feature gate first — "not on your plan" is a better answer
    // than "you have too many" when both are true.
    guard.questionType(),
    guard.limit('maxQuestions'),
    (req, res, next) => {
      void (async () => {
        try {
          const created = await questions.create(
            requirePrincipal(req),
            scopeOf(req),
            req.valid!.body as CreateQuestionInput
          )
          res.status(201).json(ok(created))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  questionRouter.get(
    '/:id',
    requirePermission('question:read'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const lang = req.query['lang'] as Language | undefined
          res.json(ok(await questions.getById(requirePrincipal(req), scopeOf(req), id, lang)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  questionRouter.put(
    '/:id',
    requirePermission('question:update'),
    validate({ params: idParamSchema, body: updateQuestionSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(
            ok(
              await questions.update(
                requirePrincipal(req),
                scopeOf(req),
                id,
                req.valid!.body as UpdateQuestionInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  questionRouter.delete(
    '/:id',
    requirePermission('question:delete'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await questions.archive(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §10.2: draft → pending_review. Anyone who may edit the question may submit it.
  questionRouter.post(
    '/:id/submit',
    requirePermission('question:update'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await questions.submitForReview(requirePrincipal(req), scopeOf(req), id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // §5.3 POST /questions/:id/approve — §3.2: super_admin and admin only.
  questionRouter.post(
    '/:id/approve',
    requirePermission('question:approve'),
    validate({ params: idParamSchema, body: reviewSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const body = req.valid!.body as ReviewInput
          res.json(ok(await questions.approve(requirePrincipal(req), id, body.comments)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  questionRouter.post(
    '/:id/reject',
    requirePermission('question:approve'),
    validate({ params: idParamSchema, body: rejectSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          const body = req.valid!.body as RejectInput
          res.json(ok(await questions.reject(requirePrincipal(req), id, body.comments)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  const topicRouter = Router()

  topicRouter.get(
    '/',
    requirePermission('topic:read'),
    validate({ query: listTopicsQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          res.json(ok(await topics.list(req.valid!.query as ListTopicsQuery)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  topicRouter.post(
    '/',
    requirePermission('topic:manage'),
    validate({ body: createTopicSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          res.status(201).json(ok(await topics.create(req.valid!.body as CreateTopicInput)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  topicRouter.put(
    '/:id',
    requirePermission('topic:manage'),
    validate({ params: idParamSchema, body: updateTopicSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await topics.update(id, req.valid!.body as UpdateTopicInput)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  const documentRouter = Router()

  documentRouter.get(
    '/',
    requirePermission('source_document:read'),
    validate({ query: listSourceDocumentsQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          res.json(ok(await documents.list(req.valid!.query as ListSourceDocumentsQuery)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  documentRouter.post(
    '/',
    requirePermission('source_document:manage'),
    validate({ body: createSourceDocumentSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const principal = requirePrincipal(req)
          res
            .status(201)
            .json(
              ok(
                await documents.create(
                  principal,
                  scopeOf(req),
                  principal.userId,
                  req.valid!.body as CreateSourceDocumentInput
                )
              )
            )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  documentRouter.get(
    '/:id',
    requirePermission('source_document:read'),
    validate({ params: idParamSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(ok(await documents.getById(id)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  documentRouter.put(
    '/:id',
    requirePermission('source_document:manage'),
    validate({ params: idParamSchema, body: updateSourceDocumentSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { id } = req.valid!.params as { id: string }
          res.json(
            ok(
              await documents.update(
                requirePrincipal(req),
                scopeOf(req),
                id,
                req.valid!.body as UpdateSourceDocumentInput
              )
            )
          )
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return { questionRouter, topicRouter, documentRouter }
}
