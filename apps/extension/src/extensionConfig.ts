/**
 * The backend origin, absolute (extension pages have no web origin). `VITE_BACKEND_ORIGIN`
 * overrides the local default at build time.
 */
export const EXTENSION_BACKEND_ORIGIN =
  import.meta.env?.VITE_BACKEND_ORIGIN ?? 'http://127.0.0.1:5391';

/**
 * Local dev only: the dashboard dev-server origins. The Vite proxy makes dashboard sign-ins set
 * their session cookie on *these* origins rather than the backend's, so `sharedSessionCookie.ts`
 * must look here too. Empty when `VITE_BACKEND_ORIGIN` names a real backend.
 */
export const DASHBOARD_DEV_ORIGINS = import.meta.env?.VITE_BACKEND_ORIGIN
  ? []
  : ['http://localhost:5174', 'http://127.0.0.1:5174'];

/**
 * This extension's id, pinned by `manifest.ts`'s `key`. `apps/backend/src/auth.ts`'s
 * `trustedOrigins` must list `chrome-extension://<this id>`.
 */
export const EXTENSION_ID = 'fgfmcenbbggfhbddflgfoehjahnbimkg';
