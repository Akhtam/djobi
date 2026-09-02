/**
 * Absolute because extension pages have no web origin from which a relative API path can resolve.
 * `VITE_BACKEND_ORIGIN` overrides the local default at build time — the only way a packaged
 * extension can point at a real deployed backend instead of localhost, since it isn't served from
 * that backend's own origin the way the dashboard can be.
 */
export const EXTENSION_BACKEND_ORIGIN =
  import.meta.env?.VITE_BACKEND_ORIGIN ?? 'http://127.0.0.1:5391';

/**
 * This extension's id, pinned by `manifest.ts`'s `key` rather than left to whatever a fresh
 * "Load unpacked" assigns. Named here so `manifest.test.ts` and any other module that needs the
 * extension's own origin (`chrome-extension://${EXTENSION_ID}`) state it once — `apps/backend/src/
 * auth.ts`'s `trustedOrigins` has to match this exact string, since Better Auth rejects a POST from
 * an origin it doesn't recognize before the request reaches any route.
 */
export const EXTENSION_ID = 'fgfmcenbbggfhbddflgfoehjahnbimkg';
