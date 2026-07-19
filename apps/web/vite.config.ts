import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The admin panel runs on its own port and talks to the API on 4000.
 *
 * Requests to /api are proxied rather than sent cross-origin: the API only
 * enables CORS when CORS_ORIGINS is set (app.ts), and a proxy means the browser
 * sees one origin, so nothing has to be configured to develop against it. It
 * also matches production, where both sit behind the same reverse proxy.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
