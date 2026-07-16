import type { PrismaClient } from '@bookends/db'
import {
  runAsPlatform,
  runInTenant,
  SEED_DEPARTMENTS,
  SEED_DESIGNATIONS,
} from '@bookends/db'
import {
  hashPassword,
  validatePassword,
  slugify,
  rejectSlug,
  nextSlugCandidate,
  type Role,
} from '@bookends/core'
import { ApiError } from '../http/api-error.js'

/**
 * Self-service tenant signup (SaaS §5.1).
 *
 * ---------------------------------------------------------------------------
 * This is the only code in the system that creates a tenant, and it is the only
 * place a caller with no tenant and no session writes tenant data. Both facts
 * shape everything below.
 *
 * runAsPlatform is unavoidable here and is NOT a weakening: the tenant does not
 * exist yet, so there is no scope to run in — this call is what brings one into
 * being. The moment it exists, provisioning switches into runInTenant so the
 * rows it writes are guarded like any other.
 * ---------------------------------------------------------------------------
 */

const SCOPE = 'signup: creating a tenant that does not exist yet'

/** §5.1's trial. Long enough to run a real monthly exam cycle and see results. */
const TRIAL_DAYS = 14

/**
 * How many slug variants to try before giving up. Twenty "grand-hotel-N"
 * collisions means something pathological — a script, or a name so generic it
 * needs a human decision — and looping forever is how a signup endpoint becomes
 * a denial-of-service against its own database.
 */
const MAX_SLUG_ATTEMPTS = 20

export interface SignupInput {
  organisationName: string
  /** Optional: derived from the name when absent (§5.1 auto-generates it). */
  slug?: string | undefined
  ownerName: string
  ownerEmail: string
  ownerPhone: string
  password: string
  /** Defaults to the trial tier. */
  planCode?: string | undefined
}

export interface SignupResult {
  tenantId: string
  slug: string
  organisationName: string
  trialEndsAt: Date | null
  planCode: string | null
  ownerUserId: string
  seeded: { departments: number; designations: number; outlets: number }
}

export class OnboardingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Whether a slug can be taken.
   *
   * Deliberately answers only "yes/no + why not". It must NOT say who holds a
   * taken slug: this endpoint is public and unauthenticated, and an enumerable
   * customer list is competitive intelligence we hand out for free. "Taken" and
   * "reserved" are distinguishable because the caller can act on the second
   * (pick another name) and not the first.
   */
  async slugAvailability(
    candidate: string
  ): Promise<{ available: boolean; reason?: string; suggestion?: string }> {
    const slug = candidate.trim().toLowerCase()

    const rejection = rejectSlug(slug)
    if (rejection) {
      return { available: false, reason: REJECTION_MESSAGES[rejection] }
    }

    const taken = await runAsPlatform(SCOPE, () =>
      this.prisma.tenant.findUnique({ where: { slug }, select: { id: true } })
    )

    if (!taken) return { available: true }

    return {
      available: false,
      reason: 'That address is already taken',
      suggestion: await this.findFreeSlug(slug),
    }
  }

  /**
   * §5.1's signup: provision a working tenant, or nothing at all.
   *
   * Everything after the tenant row is inside ONE transaction. A tenant with an
   * owner but no departments, or departments but no owner, is worse than a
   * failed signup: the customer cannot use it, cannot fix it, and the slug is
   * burned — so a rollback is the only acceptable partial outcome.
   */
  async signup(input: SignupInput): Promise<SignupResult> {
    // Password policy first: the owner is an admin (§7.3's stricter rule), and
    // failing here costs nothing, whereas failing after the writes wastes a slug.
    const violations = validatePassword(input.password, 'super_admin' as Role)
    if (violations.length > 0) {
      throw ApiError.validation('Password does not meet requirements', violations)
    }

    const slug = await this.resolveSlug(input)
    const plan = await this.resolvePlan(input.planCode)

    const trialEndsAt = new Date(this.now())
    trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + TRIAL_DAYS)

    // Hashed outside the transaction: argon2 takes ~130ms and holding a
    // connection through it is exactly the mistake planGuard's design notes
    // call out. Nothing here depends on the transaction being open.
    const passwordHash = await hashPassword(input.password)

    const created = await runAsPlatform(SCOPE, () =>
      this.prisma.$transaction(async (tx) => {
        // Unique(slug) is the real guard, not the availability check above —
        // two signups racing on the same name both see it free. Prisma throws
        // P2002 here and the route turns it into a 409, which is correct: the
        // loser genuinely must pick another name.
        const tenant = await tx.tenant.create({
          data: {
            slug,
            name: input.organisationName.trim(),
            ownerName: input.ownerName.trim(),
            ownerEmail: input.ownerEmail.trim().toLowerCase(),
            ownerPhone: input.ownerPhone.trim(),
            planId: plan?.id ?? null,
            subscriptionStatus: 'trialing',
            trialEndsAt,
            // §8.2's code prefix, derived so BK-AK-001 reads like the tenant.
            employeeCodePrefix: derivePrefix(input.organisationName),
          },
        })

        // Inside the tenant from here: these are ordinary tenant rows and the
        // extension should guard them exactly as it guards everyone else's.
        const seeded = await runInTenant(tenant.id, () => this.provision(tx, tenant.id))

        const owner = await runInTenant(tenant.id, () =>
          tx.user.create({
            data: {
              tenantId: tenant.id,
              phone: input.ownerPhone.trim(),
              email: input.ownerEmail.trim().toLowerCase(),
              role: 'super_admin',
              passwordHash,
              // They chose this password thirty seconds ago. Forcing a change
              // now (the §7.3 default) would be pure friction — that rule
              // exists for accounts created FOR someone with a derived default.
              mustChangePassword: false,
            },
            select: { id: true },
          })
        )

        return { tenant, owner, seeded }
      })
    )

    return {
      tenantId: created.tenant.id,
      slug: created.tenant.slug,
      organisationName: created.tenant.name,
      trialEndsAt: created.tenant.trialEndsAt,
      planCode: plan?.code ?? null,
      ownerUserId: created.owner.id,
      seeded: created.seeded,
    }
  }

  /**
   * §5.1's "auto-provision": what a new tenant wakes up with.
   *
   * Departments, designations AND one outlet. The outlet is the difference
   * between a product someone can try and one that dead-ends: creating an
   * employee requires an outlet, a department and a designation, so a tenant
   * without all three fails on the owner's very first action. A placeholder
   * they rename beats a wall they have to reverse-engineer.
   */
  private async provision(
    tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
    tenantId: string
  ) {
    // The same lists the seed uses, imported rather than copied — a signup that
    // provisioned a different set from the one every test runs against would
    // drift silently.
    await tx.department.createMany({
      data: SEED_DEPARTMENTS.map((d) => ({
        tenantId,
        name: d.name,
        code: d.code,
        description: d.description,
      })),
    })

    const departments = await tx.department.findMany({
      where: { tenantId },
      select: { id: true, code: true },
    })
    const byCode = new Map(departments.map((d) => [d.code, d.id]))

    await tx.designation.createMany({
      data: SEED_DESIGNATIONS.map((d) => ({
        tenantId,
        name: d.name,
        code: d.code,
        level: d.level,
        departmentId: byCode.get(d.department) ?? null,
      })),
    })

    const outlet = await tx.outlet.create({
      data: {
        tenantId,
        name: 'Main Outlet',
        code: 'MAIN',
      },
      select: { id: true },
    })

    // §4.1's mapping: every department is available at the outlet until the
    // tenant says otherwise.
    await tx.outletDepartment.createMany({
      data: departments.map((d) => ({ tenantId, outletId: outlet.id, departmentId: d.id })),
    })

    return {
      departments: SEED_DEPARTMENTS.length,
      designations: SEED_DESIGNATIONS.length,
      outlets: 1,
    }
  }

  /** An explicit slug is honoured as given; a derived one may be suffixed. */
  private async resolveSlug(input: SignupInput): Promise<string> {
    if (input.slug) {
      const slug = input.slug.trim().toLowerCase()
      const rejection = rejectSlug(slug)
      if (rejection) {
        throw ApiError.validation('That address cannot be used', [
          { field: 'slug', message: REJECTION_MESSAGES[rejection] },
        ])
      }

      const taken = await runAsPlatform(SCOPE, () =>
        this.prisma.tenant.findUnique({ where: { slug }, select: { id: true } })
      )
      if (taken) {
        // Asked for, so answer plainly rather than silently substituting —
        // someone typing "bookends" and landing on "bookends-4" is a surprise
        // they discover from a URL later.
        throw ApiError.conflict('That address is already taken', [
          { field: 'slug', message: `Try "${await this.findFreeSlug(slug)}"` },
        ])
      }
      return slug
    }

    const base = slugify(input.organisationName)
    if (!base || rejectSlug(base)) {
      // Names that yield nothing usable: non-Latin scripts (§6 makes those
      // first-class in CONTENT, but a hostname cannot carry them), or names so
      // short the label is invalid. Ask rather than invent a romanisation.
      throw ApiError.validation('We could not make a web address from that name', [
        {
          field: 'slug',
          message: 'Please choose an address using letters a-z, numbers and hyphens',
        },
      ])
    }

    return this.findFreeSlug(base)
  }

  /** First free candidate: base, base-2, base-3, … */
  private async findFreeSlug(base: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const candidate = nextSlugCandidate(base, attempt)
      if (rejectSlug(candidate)) continue

      const taken = await runAsPlatform(SCOPE, () =>
        this.prisma.tenant.findUnique({ where: { slug: candidate }, select: { id: true } })
      )
      if (!taken) return candidate
    }

    throw ApiError.conflict('We could not find a free web address for that name', [
      { field: 'slug', message: 'Please choose one yourself' },
    ])
  }

  private async resolvePlan(code: string | undefined) {
    const plan = await runAsPlatform(SCOPE, () =>
      this.prisma.plan.findFirst({
        where: code ? { code, isActive: true } : { code: DEFAULT_TRIAL_PLAN, isActive: true },
        select: { id: true, code: true },
      })
    )

    if (!plan && code) {
      throw ApiError.validation('Unknown plan', [
        { field: 'planCode', message: `No plan with code "${code}"` },
      ])
    }

    // No default plan configured is an operator problem, not the signer-up's.
    // Failing loudly beats creating an unbilled tenant with no limits — which
    // is exactly what PlanService.forTenant refuses to guess about later.
    if (!plan) {
      throw new Error(
        `No active "${DEFAULT_TRIAL_PLAN}" plan exists. Seed the plans before opening signup.`
      )
    }

    return plan
  }
}

/** §5.1: "default: 14-day Professional trial". */
const DEFAULT_TRIAL_PLAN = 'professional'

/**
 * §8.2's employee-code prefix: BK-AK-001 for Bookends.
 *
 * Initials of the first two words, so "Bookends Hospitality" → "BH" and
 * "Aiko" → "AI". Falls back to the first letters when there is one word, and to
 * "EMP" (the schema default) when the name is non-Latin — because a code prefix
 * is stamped on every employee record and a wrong guess is visible forever.
 */
function derivePrefix(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter(Boolean)

  if (words.length === 0) return 'EMP'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase().padEnd(2, 'X')
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

const REJECTION_MESSAGES: Record<NonNullable<ReturnType<typeof rejectSlug>>, string> = {
  too_short: 'Must be at least 3 characters',
  too_long: 'Must be 40 characters or fewer',
  invalid_characters: 'Use only lowercase letters, numbers and hyphens',
  leading_or_trailing_hyphen: 'Cannot start or end with a hyphen',
  numeric_only: 'Cannot be only numbers',
  reserved: 'That address is reserved',
}
