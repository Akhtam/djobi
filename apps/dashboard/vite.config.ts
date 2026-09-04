/**
 * Vite config for `apps/dashboard` — a plain React SPA, unrelated to the extension's MV3 build.
 *
 * Port 5174 rather than 5173: 5173 is the extension dev server's `strictPort` and both are
 * routinely running at once.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    /**
     * Proxies the backend's routes onto this dev server's own origin, so `dashboardClient.ts` can
     * call them as relative paths and the browser sees every request as same-origin.
     *
     * This is the fix for real login breakage, not a nicety: the dashboard (`:5174`) and backend
     * (`:5391`) were genuinely cross-origin, which makes the session cookie a *third-party* cookie
     * from the browser's point of view — Chrome partitions/blocks those by default regardless of
     * `SameSite`/`Secure`. That's exactly what was observed: sign-in appeared to succeed (the
     * `Set-Cookie` response is never blocked), but the very next `GET /applications` came back 401
     * because the cookie was never attached. No cookie attribute fixes that; only not being
     * cross-origin does. It also matches where this was always headed —
     * `docs/multi-tenant-auth.md`'s ADR-0001 already has the deployed dashboard served from the same
     * Worker as the API, at which point this becomes moot rather than something to unwind.
     *
     * Paths only, not a catch-all: the dashboard's own routing lives entirely in the hash fragment
     * (`#/...`), which never reaches the server, so these prefixes are exactly the backend routes
     * `lib/dashboardClient.ts` actually calls (`app.ts`'s `/api/auth/*`, `/applications`,
     * `/profile`, `/extract-job`) and nothing here can collide with an asset or page path this dev
     * server itself needs to serve.
     *
     * `/extract-job` was missing, and it is the one entry whose absence didn't look like an
     * absence: the dev server answers an unproxied path with `index.html` and a 200, so the New
     * Application view's extraction failed as an invalid-response parse error rather than as a
     * connection problem pointing at this list. Every path `dashboardClient.ts` names belongs here.
     */
    proxy: {
      '/api': { target: 'http://127.0.0.1:5391', changeOrigin: true },
      '/applications': { target: 'http://127.0.0.1:5391', changeOrigin: true },
      '/profile': { target: 'http://127.0.0.1:5391', changeOrigin: true },
      '/extract-job': { target: 'http://127.0.0.1:5391', changeOrigin: true },
    },
  },
});
