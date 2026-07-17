import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    /**
     * Proxy /api to the Express server rather than calling it cross-origin.
     *
     * Not laziness — it makes dev match production. §21.1 puts both behind one
     * nginx, so the browser sees one origin there. Without this the app would
     * need CORS and SameSite cookie handling in dev that it does not need in
     * prod, and the refresh-token cookie (§7.2, HttpOnly) would silently not be
     * sent — a bug that only exists on developers' machines.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
