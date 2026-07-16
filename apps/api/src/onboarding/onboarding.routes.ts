import { Router } from 'express'
import { z } from 'zod'
import { ok } from '@bookends/core'
import { Prisma } from '@bookends/db'
import type { Deps } from '../app.js'
import { validate } from '../http/middleware/validate.js'
import { signupLimiter, publicLimiter } from '../http/middleware/rate-limit.js'
import { markPublic } from '../rbac/require-permission.js'
import { ApiError } from '../http/api-error.js'
import { OnboardingService } from './onboarding.service.js'

/**
 * §5.1 self-service signup. PUBLIC and unauthenticated — that is the point, and
 * it is also the risk: this is the only endpoint where an anonymous caller
 * writes a tenant into existence.
 *
 * What guards it:
 *   - a dedicated rate limiter, tighter than the general public one, because
 *     the cost of abuse here is durable (a squatted slug) rather than transient;
 *   - the slug rules, which keep `admin.` and `login.` out of customer hands;
 *   - a full password policy, applied to the owner as the admin they are.
 *
 * What does NOT guard it: email verification. §14's notification system is a
 * logging stub today, so a verification flow would be a link nobody receives.
 * That is a real gap and it is written down rather than papered over — the
 * trial tier is where it belongs until there is a mailer.
 */

const signupSchema = z.object({
  organisationName: z.string().trim().min(2, 'Organisation name is required').max(255),
  // Optional: derived from the organisation name when absent (§5.1).
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Use only lowercase letters, numbers and hyphens')
    .optional(),
  ownerName: z.string().trim().min(2, 'Your name is required').max(200),
  ownerEmail: z.string().trim().toLowerCase().email('A valid email is required'),
  ownerPhone: z.string().trim().min(6, 'A phone number is required').max(15),
  // No length rule here: the service applies the real §7.3 admin policy and
  // reports every violation at once, which is a better answer than "too short".
  password: z.string().min(1, 'Password is required'),
  planCode: z.string().trim().optional(),
})

const slugQuerySchema = z.object({
  slug: z.string().trim().toLowerCase().min(1).max(60),
})

export function buildOnboardingRouter(deps: Deps) {
  const onboarding = new OnboardingService(deps.prisma)
  const router = Router()

  /**
   * GET /api/v1/signup/slug-available?slug=bookends
   *
   * For the signup form, as the user types. Answers only yes/no and why —
   * never who holds a taken slug, because an unauthenticated caller enumerating
   * our customer list is competitive intelligence given away for free.
   */
  router.get(
    '/slug-available',
    markPublic(),
    publicLimiter(),
    validate({ query: slugQuerySchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const { slug } = req.valid!.query as z.infer<typeof slugQuerySchema>
          res.json(ok(await onboarding.slugAvailability(slug)))
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  // POST /api/v1/signup
  router.post(
    '/',
    markPublic(),
    signupLimiter(),
    validate({ body: signupSchema }),
    (req, res, next) => {
      void (async () => {
        try {
          const body = req.valid!.body as z.infer<typeof signupSchema>
          const result = await onboarding.signup(body)

          res.status(201).json(
            ok({
              ...result,
              // Where to go next. The client cannot construct this itself
              // without knowing the platform domain.
              loginUrl: `/api/v1/auth/login`,
              tenantSlug: result.slug,
            })
          )
        } catch (err) {
          // Two signups raced onto the same slug and lost at the unique index.
          // The availability check cannot prevent this — only the constraint
          // can — so translate it into the answer the loser needs rather than a
          // 500 that says "internal error" about someone else's timing.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            next(
              ApiError.conflict('That address was just taken', [
                { field: 'slug', message: 'Please try a different one' },
              ])
            )
            return
          }
          next(err)
        }
      })()
    }
  )

  return router
}
