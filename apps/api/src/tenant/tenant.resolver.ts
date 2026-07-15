import type { PrismaClient } from '@bookends/db'
import { runAsPlatform } from '@bookends/db'
import { ApiError } from '../http/api-error.js'

/**
 * Works out which tenant an unauthenticated request is talking to (SaaS §2.3).
 *
 * Only needed before login. Once there is a session the tenant comes from the
 * Principal, which is authoritative and cannot be spoofed by a header.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATE DEVIATION FROM THE SPEC — read before "fixing" this.
 *
 * §24.1 says: staff enters a phone, we look up which tenants hold that phone,
 * and if there are several we show a tenant-selection screen. That design is an
 * account-enumeration oracle, and this codebase has gone to real lengths to
 * avoid exactly that — auth.service.ts burns a dummy argon2 verify on unknown
 * phones so that "no such user" and "wrong password" take the same time, and
 * forgot-password always resolves. A "pick your organisation" response would
 * hand back, before any credential is checked, the facts that a phone exists
 * and how many of our customers employ that person.
 *
 * So the tenant is established BEFORE credentials are looked at, from the
 * request itself. The lookup then becomes (tenant, phone), and every existing
 * anti-enumeration property survives untouched.
 *
 * The staff app can still offer a tenant picker — it just picks from a list the
 * user was given (or from its own white-label build), rather than one the
 * server derived from an unauthenticated phone number.
 * ---------------------------------------------------------------------------
 */

/** Where the tenant hint came from. Ordered most to least trustworthy. */
export type TenantSource = 'header' | 'body' | 'subdomain'

export interface ResolvedTenant {
  tenantId: string
  slug: string
  source: TenantSource
}

/**
 * Pulls a tenant slug off the request without touching the database.
 *
 * Returns null rather than throwing: the caller decides whether an unresolved
 * tenant is fatal, because it is for login and not for, say, a health check.
 */
export function readTenantHint(req: {
  get(name: string): string | undefined
  hostname?: string
  body?: unknown
}): { slug: string; source: TenantSource } | null {
  const header = req.get('x-tenant-id')?.trim()
  if (header) return { slug: header.toLowerCase(), source: 'header' }

  const body = req.body as { tenantSlug?: unknown } | undefined
  if (typeof body?.tenantSlug === 'string' && body.tenantSlug.trim()) {
    return { slug: body.tenantSlug.trim().toLowerCase(), source: 'body' }
  }

  const sub = subdomainOf(req.hostname)
  if (sub) return { slug: sub, source: 'subdomain' }

  return null
}

/**
 * The reserved labels that are not tenants. `api` and `admin` are the platform's
 * own hosts (§5.3); `www` and `app` are the marketing site and the shared staff
 * PWA. Treating any of them as a slug would send a login at api.examhub.com
 * hunting for a tenant called "api".
 */
const RESERVED_SUBDOMAINS = new Set(['api', 'admin', 'www', 'app', 'localhost'])

function subdomainOf(hostname: string | undefined): string | null {
  if (!hostname) return null

  const labels = hostname.split('.')
  // Needs at least {sub}.{domain}.{tld}. A bare "examhub.com" or "localhost"
  // has no tenant in it.
  if (labels.length < 3) return null

  const first = labels[0]?.toLowerCase()
  if (!first || RESERVED_SUBDOMAINS.has(first)) return null
  return first
}

/**
 * Resolves a slug to a live tenant.
 *
 * Runs as platform because `tenants` is a platform table and, by definition,
 * there is no tenant context yet — this call is what establishes it.
 *
 * A suspended or soft-deleted tenant is treated as absent rather than reported
 * as suspended: the caller is unauthenticated, and "that organisation exists but
 * is suspended" is a business fact we owe nobody before login. The suspension
 * message belongs after authentication, where §Appendix B's TENANT_SUSPENDED can
 * name it to someone who actually works there.
 */
export async function resolveTenantBySlug(
  prisma: PrismaClient,
  slug: string
): Promise<ResolvedTenant | null> {
  const tenant = await runAsPlatform('resolving a tenant slug before login', () =>
    prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true, isActive: true, deletedAt: true },
    })
  )

  if (!tenant || !tenant.isActive || tenant.deletedAt) return null
  return { tenantId: tenant.id, slug: tenant.slug, source: 'header' }
}

/**
 * Resolves the tenant for a login-style request, or throws.
 *
 * The thrown error is deliberately the same shape whether the slug was absent
 * or simply unknown — probing for which organisations exist should not be
 * cheaper than probing for which phones do.
 */
export async function requireTenant(
  prisma: PrismaClient,
  req: { get(name: string): string | undefined; hostname?: string; body?: unknown }
): Promise<ResolvedTenant> {
  const hint = readTenantHint(req)
  if (!hint) throw ApiError.tenantNotFound()

  const resolved = await resolveTenantBySlug(prisma, hint.slug)
  if (!resolved) throw ApiError.tenantNotFound()

  return { ...resolved, source: hint.source }
}
