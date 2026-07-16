import { describe, it, expect } from 'vitest'
import {
  slugify,
  rejectSlug,
  isValidSlug,
  nextSlugCandidate,
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
} from './slug.js'

describe('slugify', () => {
  it('turns a real organisation name into a hostname label', () => {
    expect(slugify('Bookends Hospitality')).toBe('bookends-hospitality')
  })

  it('drops punctuation rather than encoding it', () => {
    expect(slugify('Bookends Hospitality Pvt. Ltd.')).toBe('bookends-hospitality-pvt-ltd')
    expect(slugify("Chef's Table & Co.")).toBe('chef-s-table-co')
  })

  it('folds accents instead of losing the letter', () => {
    // "Café" must not become "caf".
    expect(slugify('Café Chain')).toBe('cafe-chain')
  })

  it('collapses runs and trims the edges', () => {
    expect(slugify('  The   Grand   Hotel  ')).toBe('the-grand-hotel')
    expect(slugify('--Aiko--')).toBe('aiko')
  })

  it('never ends on a hyphen, even when the cut lands on one', () => {
    const name = 'a'.repeat(SLUG_MAX_LENGTH - 1) + ' extra words here'
    expect(slugify(name).endsWith('-')).toBe(false)
  })

  it('returns empty for a name with no ASCII letters at all', () => {
    // §6 makes Hindi and Gujarati first-class in content — but a hostname
    // cannot carry them, so this must fail honestly and let signup ask for a
    // slug rather than invent a romanisation of someone's business name.
    expect(slugify('स्वाद रेस्तरां')).toBe('')
    expect(slugify('カフェ')).toBe('')
  })
})

describe('rejectSlug', () => {
  it('accepts an ordinary slug', () => {
    expect(rejectSlug('bookends')).toBeNull()
    expect(rejectSlug('grand-hotel-2')).toBeNull()
  })

  it('names the rule that was broken, not just "invalid"', () => {
    expect(rejectSlug('ab')).toBe('too_short')
    expect(rejectSlug('a'.repeat(41))).toBe('too_long')
    expect(rejectSlug('Bookends')).toBe('invalid_characters')
    expect(rejectSlug('book_ends')).toBe('invalid_characters')
    expect(rejectSlug('book ends')).toBe('invalid_characters')
    expect(rejectSlug('-bookends')).toBe('leading_or_trailing_hyphen')
    expect(rejectSlug('bookends-')).toBe('leading_or_trailing_hyphen')
    expect(rejectSlug('12345')).toBe('numeric_only')
  })

  describe('reserved labels', () => {
    /**
     * The security-relevant cases. §5.3 routes admin. and api. to our own
     * infrastructure, so a tenant holding those collides at DNS. The rest are
     * hostnames an attacker would want for a convincing phishing page.
     */
    it('refuses the platform’s own routing targets', () => {
      for (const slug of ['admin', 'api', 'app', 'www']) {
        expect(rejectSlug(slug), slug).toBe('reserved')
      }
    })

    it('refuses hostnames that would make a convincing phishing page', () => {
      for (const slug of ['login', 'billing', 'secure', 'verify', 'account']) {
        expect(rejectSlug(slug), slug).toBe('reserved')
      }
    })

    it('refuses names we will want later and could not take back', () => {
      for (const slug of ['status', 'docs', 'support', 'examhub']) {
        expect(rejectSlug(slug), slug).toBe('reserved')
      }
    })

    it('does not refuse a legitimate name that merely contains a reserved word', () => {
      // "app" is reserved; "apple-bistro" is a customer.
      expect(rejectSlug('apple-bistro')).toBeNull()
      expect(rejectSlug('admin-kitchen-co')).toBeNull()
    })

    it('has no reserved entry that is itself an invalid slug', () => {
      // A reserved word shorter than the minimum would be unreachable — the
      // length check fires first and the reservation never applies.
      for (const slug of RESERVED_SLUGS) {
        expect(/^[a-z0-9-]{3,40}$/.test(slug), `${slug} is unreachable as a reservation`).toBe(true)
      }
    })
  })
})

describe('nextSlugCandidate', () => {
  it('leaves the first attempt alone', () => {
    expect(nextSlugCandidate('bookends', 1)).toBe('bookends')
    expect(nextSlugCandidate('bookends', 0)).toBe('bookends')
  })

  it('appends a number a human can read out over the phone', () => {
    expect(nextSlugCandidate('bookends', 2)).toBe('bookends-2')
    expect(nextSlugCandidate('bookends', 3)).toBe('bookends-3')
  })

  it('trims the BASE to fit, so a long name still yields distinct candidates', () => {
    const base = 'a'.repeat(SLUG_MAX_LENGTH)
    const second = nextSlugCandidate(base, 2)
    const tenth = nextSlugCandidate(base, 10)

    expect(second.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
    expect(tenth.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
    // If the suffix were trimmed instead of the base, these would collide.
    expect(second).not.toBe(tenth)
  })

  it('produces a valid slug at every attempt', () => {
    for (let i = 1; i <= 25; i++) {
      expect(isValidSlug(nextSlugCandidate('grand-hotel', i)), `attempt ${i}`).toBe(true)
    }
  })

  it('does not leave a trailing hyphen when the trim lands on one', () => {
    expect(nextSlugCandidate('bookends-hotel-group-limited-company-x', 2).includes('--')).toBe(false)
  })
})
