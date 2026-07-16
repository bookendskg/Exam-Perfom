/**
 * Tenant slugs (SaaS §5.3): the label in `{slug}.examhub.com`.
 *
 * Pure and here rather than in the API because two callers need identical
 * rules — signup, which mints one, and the availability check the UI calls as
 * the user types. If those two ever disagree, the form says "available" and the
 * submit fails, which is the kind of bug nobody can reproduce.
 */

/**
 * Labels that are not a customer's to take.
 *
 * Not tidiness — a real boundary. §5.3 routes `admin.examhub.com` to the
 * platform panel and `api.examhub.com` to the API, so a tenant holding "admin"
 * or "api" would collide with infrastructure at the DNS level. The rest are
 * words an attacker would want for a plausible-looking phishing subdomain
 * (`login.examhub.com`, `billing.examhub.com`), or that we will want later and
 * would then have to take back from a paying customer.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // §5.3's actual routing targets.
  'admin',
  'api',
  'app',
  'www',
  // Plausible-looking phishing hosts.
  'login',
  'signin',
  'signup',
  'auth',
  'account',
  'accounts',
  'billing',
  'payment',
  'payments',
  'secure',
  'verify',
  'support',
  'help',
  // Ours, eventually.
  'blog',
  'docs',
  'status',
  'mail',
  'smtp',
  'ftp',
  'cdn',
  'static',
  'assets',
  'platform',
  'dashboard',
  'console',
  'internal',
  'staging',
  'dev',
  'test',
  'demo',
  'examhub',
])

/** Long enough to be a real name; short enough for a DNS label (63 max). */
export const SLUG_MIN_LENGTH = 3
export const SLUG_MAX_LENGTH = 40

/**
 * Turns an organisation name into a candidate slug.
 *
 * "Bookends Hospitality Pvt. Ltd." → "bookends-hospitality-pvt-ltd"
 *
 * Deliberately lossy and ASCII-only. This is a DNS label, and a hostname cannot
 * carry the Devanagari or Gujarati that §6 makes first-class everywhere else —
 * so a tenant named "स्वाद रेस्तरां" slugifies to nothing here and needs an
 * explicit slug. That is not an oversight to fix by transliterating: a
 * machine-guessed romanisation of someone's business name is worse than asking.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    // Strip combining marks so "Café" → "Cafe" rather than "Caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '')
}

export type SlugRejection =
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'reserved'
  | 'leading_or_trailing_hyphen'
  | 'numeric_only'

/**
 * Validates a slug someone supplied (or that slugify produced).
 *
 * Returns the reason rather than a boolean so the caller can say WHICH rule was
 * broken — "that name is taken" and "that name is reserved" need different
 * answers, and "invalid" needs to say what would be valid.
 */
export function rejectSlug(slug: string): SlugRejection | null {
  if (slug.length < SLUG_MIN_LENGTH) return 'too_short'
  if (slug.length > SLUG_MAX_LENGTH) return 'too_long'
  if (!/^[a-z0-9-]+$/.test(slug)) return 'invalid_characters'
  if (slug.startsWith('-') || slug.endsWith('-')) return 'leading_or_trailing_hyphen'
  // A purely numeric label is legal DNS but reads as an IP fragment, and
  // "42.examhub.com" is nobody's brand.
  if (/^\d+$/.test(slug)) return 'numeric_only'
  if (RESERVED_SLUGS.has(slug)) return 'reserved'
  return null
}

export function isValidSlug(slug: string): boolean {
  return rejectSlug(slug) === null
}

/**
 * Picks the next candidate when one is taken: bookends, bookends-2, bookends-3.
 *
 * Numeric suffix rather than a random one: "bookends-2" is something a human
 * can read out over the phone, and "bookends-x7f2" is not. The caller loops,
 * because only it knows what is taken.
 */
export function nextSlugCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base
  const suffix = `-${attempt}`
  // Trim the base, not the suffix, or attempt 10 collides with attempt 1.
  const trimmed = base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, '')
  return `${trimmed}${suffix}`
}
