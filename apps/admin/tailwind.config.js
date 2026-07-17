/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      /**
       * §19.2's palette, as CSS variables rather than literals.
       *
       * The variables are the point: §5.2 lets each tenant set its own primary
       * and secondary colours, so the app has to be able to re-theme itself at
       * runtime from the tenant's branding. Baking #1E3A5F into class names
       * would mean a rebuild per customer.
       */
      colors: {
        primary: 'rgb(var(--color-primary) / <alpha-value>)',
        secondary: 'rgb(var(--color-secondary) / <alpha-value>)',
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        // §19.2's system colours, never overridden by a tenant: red must mean
        // error at every customer.
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#EF4444',
        info: '#3B82F6',
        surface: '#FFFFFF',
        canvas: '#F8FAFC',
        ink: {
          DEFAULT: '#1E293B',
          muted: '#64748B',
        },
        edge: '#E2E8F0',
      },
    },
  },
  plugins: [],
}
