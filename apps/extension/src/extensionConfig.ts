/** Absolute because extension pages have no web origin from which a relative API path can resolve. */
export const EXTENSION_BACKEND_ORIGIN = 'http://127.0.0.1:5391';

/**
 * This extension's id, pinned by `manifest.ts`'s `key` rather than left to whatever a fresh
 * "Load unpacked" assigns. Named here so `manifest.test.ts` and any other module that needs the
 * extension's own origin (`chrome-extension://${EXTENSION_ID}`) state it once — `apps/backend/src/
 * auth.ts`'s `trustedOrigins` has to match this exact string, since Better Auth rejects a POST from
 * an origin it doesn't recognize before the request reaches any route.
 */
export const EXTENSION_ID = 'fgfmcenbbggfhbddflgfoehjahnbimkg';
