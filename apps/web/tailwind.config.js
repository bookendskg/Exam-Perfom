/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm, restaurant-ish rather than the default corporate blue.
        brand: {
          50: '#fdf5ef',
          100: '#f9e6d6',
          200: '#f2caad',
          500: '#c2703a',
          600: '#a85c2c',
          700: '#8a4a24',
          900: '#4a2712',
        },
      },
    },
  },
  plugins: [],
}
