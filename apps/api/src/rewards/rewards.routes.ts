import { Router } from 'express'
import { ok } from '@bookends/core'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { requirePermission } from '../rbac/require-permission.js'
import { requirePrincipal } from '../auth/middleware/authenticate.js'
import { ApiError } from '../http/api-error.js'
import { RewardsService } from './rewards.service.js'
import {
  awardRewardSchema,
  issueCertificateSchema,
  listCertificatesQuerySchema,
  listRewardsQuerySchema,
  suggestionsQuerySchema,
  type AwardRewardInput,
  type IssueCertificateInput,
  type ListCertificatesQuery,
  type ListRewardsQuery,
  type SuggestionsQuery,
} from './rewards.schemas.js'

/**
 * §5.3's /api/v1/rewards and /api/v1/certificates.
 *
 * Two routers from one builder, like buildOrganisationRouters: they share a
 * service because §12 treats recognition as one idea, but they are different
 * resources and mounting them together would make /rewards/certificates read as
 * a reward with the id "certificates".
 */
export function buildRewardsRouters(deps: Deps) {
  const rewards = new RewardsService(deps.prisma)
  const rewardRouter = Router()
  const certificateRouter = Router()

  const scopeOf = (req: { scope?: 'all' | 'own_outlet' | 'own_resource' | 'none' }) => {
    if (!req.scope) throw ApiError.forbidden()
    return req.scope
  }

  // GET /api/v1/rewards
  rewardRouter.get(
    '/',
    requirePermission('reward:assign'),
    validate({ query: listRewardsQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as ListRewardsQuery
          const { rows, meta } = await rewards.listRewards(
            requirePrincipal(req),
            scopeOf(req),
            query
          )
          res.json(ok(rows, meta))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  /**
   * GET /api/v1/rewards/suggestions — §12.
   *
   * Above /:id so "suggestions" is never read as an id. Writes nothing: it
   * proposes from the same snapshots the leaderboard uses, and a human awards.
   */
  rewardRouter.get(
    '/suggestions',
    requirePermission('reward:assign'),
    validate({ query: suggestionsQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as SuggestionsQuery
          res.json(ok(await rewards.suggestions(requirePrincipal(req), scopeOf(req), query)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // POST /api/v1/rewards
  rewardRouter.post(
    '/',
    requirePermission('reward:assign'),
    validate({ body: awardRewardSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as AwardRewardInput
          const created = await rewards.award(requirePrincipal(req), scopeOf(req), body)
          res.status(201).json(ok(created))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // GET /api/v1/certificates
  certificateRouter.get(
    '/',
    requirePermission('reward:assign'),
    validate({ query: listCertificatesQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const query = req.valid!.query as ListCertificatesQuery
          const { rows, meta } = await rewards.listCertificates(
            requirePrincipal(req),
            scopeOf(req),
            query
          )
          res.json(ok(rows, meta))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // POST /api/v1/certificates
  certificateRouter.post(
    '/',
    requirePermission('reward:assign'),
    validate({ body: issueCertificateSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as IssueCertificateInput
          const created = await rewards.issueCertificate(
            requirePrincipal(req),
            scopeOf(req),
            body
          )
          res.status(201).json(ok(created))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return { rewardRouter, certificateRouter }
}
