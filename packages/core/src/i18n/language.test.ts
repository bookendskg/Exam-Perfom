import { describe, it, expect } from 'vitest'
import {
  resolveLanguage,
  resolvedLanguageOf,
  availableLanguages,
  isFullyTranslated,
  LANGUAGES,
} from './language.js'

const full = { en: 'Chicken', hi: 'चिकन', gu: 'ચિકન' }

describe('§6.2 fallback chain', () => {
  it('returns the requested language when present', () => {
    expect(resolveLanguage(full, 'en')).toBe('Chicken')
    expect(resolveLanguage(full, 'hi')).toBe('चिकन')
    expect(resolveLanguage(full, 'gu')).toBe('ચિકન')
  })

  it('falls back Gujarati → Hindi', () => {
    expect(resolveLanguage({ en: 'Chicken', hi: 'चिकन', gu: null }, 'gu')).toBe('चिकन')
  })

  it('falls back Gujarati → Hindi → English when neither translation exists', () => {
    expect(resolveLanguage({ en: 'Chicken', hi: null, gu: null }, 'gu')).toBe('Chicken')
  })

  it('falls back Hindi → English', () => {
    expect(resolveLanguage({ en: 'Chicken', hi: null }, 'hi')).toBe('Chicken')
  })

  it('never falls back from Hindi to Gujarati', () => {
    // §6.2's chain is one-directional. A Hindi speaker must not be shown
    // Gujarati script they cannot read.
    expect(resolveLanguage({ en: 'Chicken', hi: null, gu: 'ચિકન' }, 'hi')).toBe('Chicken')
  })

  it('treats an empty string as absent', () => {
    // Spreadsheet imports write '' where a translator left the cell blank.
    // Showing a staff member a blank question is worse than showing English.
    expect(resolveLanguage({ en: 'Chicken', hi: '', gu: '   ' }, 'gu')).toBe('Chicken')
  })

  it('always resolves, because English is NOT NULL', () => {
    for (const language of LANGUAGES) {
      expect(resolveLanguage({ en: 'Only English' }, language)).toBe('Only English')
    }
  })
})

describe('resolvedLanguageOf', () => {
  it('reports what the caller actually got, not what they asked for', () => {
    // The APK needs this to pick the right font (§6.3) — Devanagari text in a
    // Gujarati UI still has to render in a Devanagari face.
    expect(resolvedLanguageOf({ en: 'Chicken', hi: 'चिकन', gu: null }, 'gu')).toBe('hi')
    expect(resolvedLanguageOf({ en: 'Chicken', hi: null, gu: null }, 'gu')).toBe('en')
    expect(resolvedLanguageOf(full, 'gu')).toBe('gu')
  })
})

describe('translation coverage (§10.5)', () => {
  it('lists only the languages genuinely present', () => {
    expect(availableLanguages(full)).toEqual(['en', 'hi', 'gu'])
    expect(availableLanguages({ en: 'x', hi: '', gu: null })).toEqual(['en'])
  })

  it('spots content missing a translation', () => {
    // §10.5 reports "Questions without Hindi/Gujarati translations".
    expect(isFullyTranslated(full)).toBe(true)
    expect(isFullyTranslated({ en: 'x', hi: 'y', gu: null })).toBe(false)
  })
})
