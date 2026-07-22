/**
 * Design tokens for the Bookends portal.
 *
 * Follows the Stitch / Material 3 convention of naming colours by ROLE
 * (surface, on-surface, primary, outline…) rather than by hue. A component asks
 * for `bg-surface-container` and gets the right value in both themes, so it
 * needs no `dark:` twin for colour and never hardcodes a hex.
 *
 * Every colour resolves to a CSS variable defined in src/index.css, stored as
 * bare HSL channels ("221 83% 53%") rather than a finished colour. That is what
 * lets `<alpha-value>` work, so `bg-primary/10` still composes.
 *
 * Tailwind's own palette is left intact via `extend` — the existing pages still
 * reference stone/emerald/amber and must keep rendering while they migrate.
 */

/** Wraps a CSS variable so Tailwind can apply opacity modifiers to it. */
const role = (name) => `hsl(var(--${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // --- Material 3 surface roles -------------------------------------
        // Elevation is expressed by which container you sit on, not by shadow.
        surface: {
          DEFAULT: role('surface'),
          dim: role('surface-dim'),
          bright: role('surface-bright'),
          lowest: role('surface-container-lowest'),
          low: role('surface-container-low'),
          container: role('surface-container'),
          high: role('surface-container-high'),
          highest: role('surface-container-highest'),
          inverse: role('inverse-surface'),
        },
        on: {
          surface: role('on-surface'),
          'surface-variant': role('on-surface-variant'),
          'surface-inverse': role('inverse-on-surface'),
          primary: role('on-primary'),
          'primary-container': role('on-primary-container'),
          secondary: role('on-secondary'),
          'secondary-container': role('on-secondary-container'),
        },

        outline: {
          DEFAULT: role('outline'),
          variant: role('outline-variant'),
        },

        // --- Brand --------------------------------------------------------
        // Full 50–900 ramp so charts and tints have steps to draw from; the
        // semantic `primary` role points into it.
        brand: {
          50: role('brand-50'),
          100: role('brand-100'),
          200: role('brand-200'),
          300: role('brand-300'),
          400: role('brand-400'),
          500: role('brand-500'),
          600: role('brand-600'),
          700: role('brand-700'),
          800: role('brand-800'),
          900: role('brand-900'),
        },
        primary: {
          DEFAULT: role('primary'),
          container: role('primary-container'),
        },
        secondary: {
          DEFAULT: role('secondary'),
          container: role('secondary-container'),
        },

        // --- Status -------------------------------------------------------
        success: { DEFAULT: role('success'), container: role('success-container') },
        warning: { DEFAULT: role('warning'), container: role('warning-container') },
        danger: { DEFAULT: role('danger'), container: role('danger-container') },
        info: { DEFAULT: role('info'), container: role('info-container') },

        // --- Outlets ------------------------------------------------------
        // The group's three restaurants (§9 seed data). Used to tint outlet
        // cards so a venue stays recognisable at a glance across screens.
        outlet: {
          aiko: role('outlet-aiko'),
          capiche: role('outlet-capiche'),
          prep: role('outlet-prep'),
        },

        ring: role('ring'),
      },

      // --- Typography ------------------------------------------------------
      // Named by role, matching the Stitch scale. Sizes are rem so a user's
      // browser font-size setting still scales the whole interface.
      fontSize: {
        'display-lg': [
          '3rem',
          { lineHeight: '3.5rem', letterSpacing: '-0.02em', fontWeight: '800' },
        ],
        'display-md': [
          '2.25rem',
          { lineHeight: '2.75rem', letterSpacing: '-0.02em', fontWeight: '700' },
        ],
        'headline-lg': [
          '1.75rem',
          { lineHeight: '2.25rem', letterSpacing: '-0.01em', fontWeight: '700' },
        ],
        'headline-md': [
          '1.5rem',
          { lineHeight: '2rem', letterSpacing: '-0.01em', fontWeight: '700' },
        ],
        'headline-sm': [
          '1.25rem',
          { lineHeight: '1.75rem', letterSpacing: '-0.01em', fontWeight: '600' },
        ],
        'title-md': ['1rem', { lineHeight: '1.5rem', letterSpacing: '0', fontWeight: '600' }],
        'body-base': ['0.9375rem', { lineHeight: '1.5rem', letterSpacing: '0' }],
        'body-sm': ['0.875rem', { lineHeight: '1.375rem', letterSpacing: '0' }],
        caption: ['0.75rem', { lineHeight: '1rem', letterSpacing: '0' }],
        // Uppercase micro-labels: table headers, section eyebrows, chips.
        'label-caps': [
          '0.6875rem',
          { lineHeight: '1rem', letterSpacing: '0.06em', fontWeight: '700' },
        ],
        // Dashboard figures. Pair with `tabular-nums` so digits do not jitter
        // as values update.
        'stat-lg': ['2rem', { lineHeight: '2.5rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        'stat-md': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.02em', fontWeight: '600' }],
      },

      fontFamily: {
        // System stack on purpose: no webfont request, no FOUT, and — the part
        // that actually matters here — the Noto fallbacks keep §6 Hindi and
        // Gujarati question text rendering rather than showing tofu boxes.
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Noto Sans Devanagari',
          'Noto Sans Gujarati',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },

      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.5rem',
        md: '0.625rem',
        lg: '0.875rem',
        xl: '1.125rem',
        '2xl': '1.5rem',
      },

      // Soft, low-contrast elevation. M3 leans on surface containers for depth;
      // shadow is a hint, not the mechanism.
      boxShadow: {
        xs: '0 1px 2px 0 hsl(var(--shadow) / 0.05)',
        sm: '0 1px 3px 0 hsl(var(--shadow) / 0.07), 0 1px 2px -1px hsl(var(--shadow) / 0.05)',
        md: '0 4px 12px -2px hsl(var(--shadow) / 0.08), 0 2px 4px -2px hsl(var(--shadow) / 0.05)',
        lg: '0 12px 28px -6px hsl(var(--shadow) / 0.12), 0 4px 10px -4px hsl(var(--shadow) / 0.06)',
      },

      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-left': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'slide-up': 'slide-up 180ms cubic-bezier(0.2, 0, 0, 1)',
        'slide-in-left': 'slide-in-left 220ms cubic-bezier(0.2, 0, 0, 1)',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
}
