/**
 * Absolute because extension pages have no web origin from which a relative API path can resolve.
 * `VITE_BACKEND_ORIGIN` overrides the local default at build time — the only way a packaged
 * extension can point at a real deployed backend instead of localhost, since it isn't served from
 * that backend's own origin the way the dashboard can be.
 */
export const EXTENSION_BACKEND_ORIGIN =
  import.meta.env?.VITE_BACKEND_ORIGIN ?? 'http://127.0.0.1:5391';

/**
 * Local-dev-only: the two host names `apps/dashboard/vite.config.ts`'s dev server answers on,
 * matching `apps/backend/src/auth.ts`'s own `trustedOrigins` entries for it.
 *
 * `lib/sharedSessionCookie.ts` needs these because a dashboard sign-in's `Set-Cookie` doesn't land
 * on `EXTENSION_BACKEND_ORIGIN` the way this whole shared-session mechanism assumes — not in local
 * dev. The dashboard's dev server proxies `/api` etc. to the backend precisely so the browser sees
 * a same-origin response (`vite.config.ts`'s own doc comment walks through why: a genuinely
 * cross-origin cookie is a third-party cookie Chrome blocks by default), which means the cookie
 * Better Auth's response sets is scoped to *this* origin — wherever the candidate's browser tab
 * actually is, `localhost:5174` or `127.0.0.1:5174` — not to the backend's own origin the extension
 * calls directly. A sign-in on the dashboard was consequently invisible to the extension no matter
 * what `sharedSessionCookie.ts` did, until it also knew to look here.
 *
 * Once a real deployed backend is named (`VITE_BACKEND_ORIGIN` overriding the dev default above),
 * this list is empty: nothing in this array is a fallback a packaged build should carry, or a
 * `host_permissions` entry it should request from a real user for an origin that means nothing
 * outside a checkout of this repo.
 */
export const DASHBOARD_DEV_ORIGINS = import.meta.env?.VITE_BACKEND_ORIGIN
  ? []
  : ['http://localhost:5174', 'http://127.0.0.1:5174'];

/**
 * This extension's id, pinned by `manifest.ts`'s `key` rather than left to whatever a fresh
 * "Load unpacked" assigns. Named here so `manifest.test.ts` and any other module that needs the
 * extension's own origin (`chrome-extension://${EXTENSION_ID}`) state it once — `apps/backend/src/
 * auth.ts`'s `trustedOrigins` has to match this exact string, since Better Auth rejects a POST from
 * an origin it doesn't recognize before the request reaches any route.
 */
export const EXTENSION_ID = 'fgfmcenbbggfhbddflgfoehjahnbimkg';
