/**
 * §6 trilingual content.
 *
 * Every staff-facing string is stored as three columns: `<field>En` (required),
 * `<field>Hi` and `<field>Gu` (both nullable). §6.2 puts the fallback in the API
 * layer, never in the database.
 */
export const LANGUAGES = ['en', 'hi', 'gu'] as const
export type Language = (typeof LANGUAGES)[number]

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

/**
 * §6.2's fallback chain: Gujarati → Hindi → English, Hindi → English.
 *
 * English is last in every chain because it is the only column guaranteed
 * NOT NULL — so resolution can never fail.
 */
const FALLBACK: Record<Language, readonly Language[]> = {
  gu: ['gu', 'hi', 'en'],
  hi: ['hi', 'en'],
  en: ['en'],
}

export interface Trilingual {
  en: string
  hi?: string | null
  gu?: string | null
}

/**
 * Resolves a trilingual field for a language, following §6.2's chain.
 *
 * Empty strings are treated as absent: a spreadsheet import writes '' where a
 * translator left the cell blank, and showing a staff member an empty question
 * is worse than showing them the English one.
 */
export function resolveLanguage(content: Trilingual, language: Language): string {
  for (const candidate of FALLBACK[language]) {
    const value = content[candidate]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return content.en
}

/**
 * Which language the caller actually got, which is not always what they asked
 * for. The APK needs this to render Devanagari text in a Gujarati UI with the
 * right font (§6.3) — and to show "translation unavailable" honestly.
 */
export function resolvedLanguageOf(content: Trilingual, language: Language): Language {
  for (const candidate of FALLBACK[language]) {
    const value = content[candidate]
    if (typeof value === 'string' && value.trim() !== '') return candidate
  }
  return 'en'
}

/** Languages this content is genuinely available in. Drives §10.5's coverage stats. */
export function availableLanguages(content: Trilingual): Language[] {
  return LANGUAGES.filter((l) => {
    const value = content[l]
    return typeof value === 'string' && value.trim() !== ''
  })
}

export function isFullyTranslated(content: Trilingual): boolean {
  return availableLanguages(content).length === LANGUAGES.length
}
