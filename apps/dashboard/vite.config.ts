/**
 * Vite config for the dashboard SPA. Port 5174, since the extension's dev server holds 5173.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    /**
     * Proxies backend routes onto this dev server's origin, so the session cookie is first-party
     * (cross-origin, Chrome blocks it and every call after sign-in 401s). Production matches this
     * shape (ADR-0001; nginx in Docker Compose).
     *
     * Every path prefix `lib/dashboardClient.ts` calls must be listed: an unproxied path gets
     * `index.html` with a 200, which surfaces as a confusing parse error.
     */
    proxy: {
      '/api': { target: 'http://127.0.0.1:5391', changeOrigin: true },
      '/applications': { target: 'http://127.0.0.1:5391', changeOrigin: true },
      '/profile': { target: 'http://127.0.0.1:5391', changeOrigin: true },
      '/extract-job': { target: 'http://127.0.0.1:5391', changeOrigin: true },
    },
  },
});
