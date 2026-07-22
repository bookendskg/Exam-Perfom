---
name: Bookends Performance Portal
colors:
  # Surfaces — a tonal ladder. Higher container = closer to the viewer.
  surface: '#fbfcfd'
  surface-dim: '#e9ecf0'
  surface-bright: '#ffffff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f9fafb'
  surface-container: '#f2f4f7'
  surface-container-high: '#e9ecf0'
  surface-container-highest: '#e2e5ea'
  on-surface: '#161d29'
  on-surface-variant: '#5a6577'
  inverse-surface: '#1c2531'
  inverse-on-surface: '#f2f4f7'
  outline: '#94a0b1'
  outline-variant: '#dde1e8'
  # Brand — Bookends primary blue
  primary: '#2563eb'
  on-primary: '#ffffff'
  primary-container: '#dbe8fe'
  on-primary-container: '#1b3fa8'
  secondary: '#576273'
  on-secondary: '#ffffff'
  secondary-container: '#e8ebef'
  on-secondary-container: '#2b3546'
  # Status
  success: '#19883f'
  success-container: '#dcf7e3'
  warning: '#c2760a'
  warning-container: '#fdf0cd'
  danger: '#c72626'
  danger-container: '#fde8e8'
  info: '#0c86c0'
  info-container: '#daf0fc'
  # Outlets — the group's three restaurants
  outlet-aiko: '#e2a50e'
  outlet-capiche: '#d32f2f'
  outlet-prep: '#23a394'
typography:
  display-lg: { fontSize: 48px, fontWeight: '800', lineHeight: 56px, letterSpacing: -0.02em }
  display-md: { fontSize: 36px, fontWeight: '700', lineHeight: 44px, letterSpacing: -0.02em }
  headline-lg: { fontSize: 28px, fontWeight: '700', lineHeight: 36px, letterSpacing: -0.01em }
  headline-md: { fontSize: 24px, fontWeight: '700', lineHeight: 32px, letterSpacing: -0.01em }
  headline-sm: { fontSize: 20px, fontWeight: '600', lineHeight: 28px, letterSpacing: -0.01em }
  title-md: { fontSize: 16px, fontWeight: '600', lineHeight: 24px }
  body-base: { fontSize: 15px, fontWeight: '400', lineHeight: 24px }
  body-sm: { fontSize: 14px, fontWeight: '400', lineHeight: 22px }
  caption: { fontSize: 12px, fontWeight: '400', lineHeight: 16px }
  label-caps: { fontSize: 11px, fontWeight: '700', lineHeight: 16px, letterSpacing: 0.06em }
  stat-lg: { fontSize: 32px, fontWeight: '600', lineHeight: 40px, letterSpacing: -0.02em }
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.625rem
  lg: 0.875rem
  xl: 1.125rem
  2xl: 1.5rem
spacing:
  unit: 4px
  margin-mobile: 16px
  margin-desktop: 24px
  sidebar: 256px
  header-h: 64px
  container-max: 1280px
---

## Brand & Style

Bookends Hospitality runs three restaurants — **Aiko**, **Capiche** and **Prep** —
and this portal is how their managers, trainers and HR staff run examinations and
track staff performance. The people using it are not sitting at a desk all day;
they are between services, often on a phone, often in a hurry.

That sets the tone: **calm, dense, and fast to scan**. Generous whitespace where it
aids reading, but no decorative chrome. The interface should disappear behind the
data.

The system follows **Material 3 colour roles** rather than a hue-named palette. A
component asks for `surface-container` or `on-surface-variant` and is correct in
both themes automatically. This is what makes dark mode a property of the tokens
rather than a `dark:` variant hand-written on every element.

## Colours

**Bookends blue** is the primary. It carries navigation state, primary actions and
focus rings, and nothing else — so that when something is blue, it is actionable.

> **Note:** the previous palette was a warm terracotta (`#c2703a`), chosen in the
> original code explicitly "rather than the default corporate blue". Blue is used
> here because the brand specification calls for it. Reverting is a single edit to
> the `--brand-*` ramp in `src/index.css`; nothing else references the hue.

**Status colours** are reserved and never decorative: green for passed and
approved, amber for waiting and pending, red for failed and destructive, blue for
informational. Every status is paired with a text label — colour is never the only
carrier of meaning, which matters for the roughly 1 in 12 men with colour-vision
deficiency.

**Outlet colours** (Aiko amber, Capiche red, Prep teal) tint venue cards so a
manager recognises their restaurant instantly. They are identity, not status, and
never appear on controls.

Dark mode is not an inversion. Surfaces move to a near-black blue rather than pure
black — pure black makes elevation invisible and smears on OLED — and the primary
lightens from 600 to 400, because the light-theme blue fails contrast on a dark
surface.

## Typography

A single system font stack, no webfont. This is deliberate: there is no network
request, no flash of unstyled text, and — the part that actually matters — the
stack carries **Noto Sans Devanagari** and **Noto Sans Gujarati** fallbacks so §6
trilingual question content renders instead of showing tofu boxes.

Type is named by role, not size. `stat-lg` for dashboard figures, `label-caps` for
table headers and eyebrows, `body-sm` for the dense table text that most of the
app is made of. Numeric columns and statistics use `tabular-nums` so digits do not
change width as values update.

## Layout & Spacing

A strict **4px baseline**. A 256px sidebar persists from `lg` up and becomes an
off-canvas drawer below it; content is capped at 1280px so tables do not stretch
into unreadable lines on ultrawide displays.

Elevation is expressed by **which surface container an element sits on**, not by
shadow. Shadows are a hint at the edges of interactive cards, never the mechanism
that separates layers.

## Motion

Short and functional: 150–220ms, ease-out. Movement confirms a state change —
a drawer sliding, a skeleton resolving — and never merely decorates. All of it
collapses to near-zero under `prefers-reduced-motion`, which is honoured globally
in `index.css` rather than per component.

## Accessibility

Targeting **WCAG 2.1 AA**.

- One focus ring, defined once on `:focus-visible`, so keyboard users always see
  where they are and mouse users never do.
- Every page begins with a skip link to `#main`.
- Form controls are wired to their labels and error messages through `Field`,
  which supplies `id`, `aria-invalid` and `aria-describedby`; errors carry
  `role="alert"` so they are announced.
- Navigation state uses `aria-current`, not colour alone.
- Loading regions expose `role="status"`; pagination announces page changes via
  `aria-live`.
