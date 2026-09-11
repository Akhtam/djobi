/**
 * The extension's configuration of `@djobi/http-client`, used by the service worker and by the
 * extension pages (panel, options) alike.
 *
 * The protocol itself — the deadline, status-before-parse, error-body extraction, schema validation,
 * abort forwarding — lives in the package, because the dashboard talks to the same backend and
 * implemented all of it a second time. What is left here is what is genuinely the extension's: the
 * origin, the remedy to suggest when nothing answers, and how the bearer token attaches.
 * `backendClient.ts` calls {@link transport} directly — `json`/`binary`/`upload` — rather than
 * through a per-route wrapper: once every route named its own response schema
 * (`backendClient.ts`'s own doc comment), a `callBackend(path, schema, options)` that only forwarded
 * its arguments to `transport.json` was a shallow layer between the two, and the divergence its own
 * comment used to apologize for — `transport.json`'s bodyless-request default is `GET`, not `POST` —
 * is exactly what naming `method` explicitly at every call site below removes, rather than leaving a
 * shared default a future bodyless `POST` route could silently fall through.
 *
 * There is deliberately no relay through the service worker for the pages' calls. A relay would rest
 * on the premise that extension pages can't reach the backend themselves, and they can:
 * `manifest.ts` grants the configured backend origin to the whole extension, not just the worker.
 * Adding one back would put a second message protocol on `background/service-worker.ts`'s single
 * `onMessage` listener and give the codebase two origins and two error types where one of each does.
 *
 * The "adopt a shared dashboard session and retry once on a 401" policy does *not* live here, even
 * though every route below sits behind `requireAuth` — it lives at the `BackendClient` boundary in
 * `backendClient.ts`'s `withSessionRecovery` instead. This transport is real-HTTP-only; the fake
 * `BackendClient` the panel and options tests render against never reaches it, so a retry wired in
 * here would be invisible in every test and to any future non-HTTP adapter. `withSessionRecovery`
 * wraps the interface both clients implement, so it is the one place the policy reaches every
 * caller — see its own doc comment for why `signIn`/`signOut` sit outside it.
 */
import { createHttpTransport } from '@djobi/http-client';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
import { getAuthToken } from './authToken';

export { HttpError, isUnauthorized, userMessage, type HttpErrorKind } from '@djobi/http-client';

/**
 * The backend's origin, absolute and build-time visible.
 *
 * It has to be both: the extension has no origin of its own to be relative to, and this same value
 * appears as a `host_permissions` entry in `manifest.ts` — a request to an origin the manifest
 * doesn't grant is blocked before it is sent. When ADR-0001's deployed Worker lands, these two move
 * together. The dashboard has the opposite constraint and takes a relative `/api`.
 */
/**
 * The default budget for a route that has not asked for its own — see `@djobi/http-client`'s
 * per-call `timeoutMs` for the one that has (`/analyze`, in `backendClient.ts`).
 *
 * Ninety seconds is well clear of what a single call costs: the slowest measured, a cold
 * `/extract-job`, was ~17s. It stays the default rather than rising to clear the slowest route,
 * because a route that answers in milliseconds should fail fast when it hangs — a `GET /profile`
 * left spinning for the chained model work's budget is a bootstrap that looks frozen.
 */
const REQUEST_TIMEOUT_MS = 90_000;

/**
 * The extension's configured transport — `json`/`binary`/`upload` — called directly by
 * `backendClient.ts`, which is the one place that names a backend path. See this module's own doc
 * comment for why there is no per-route wrapper between the two.
 */
export const transport = createHttpTransport({
  baseUrl: EXTENSION_BACKEND_ORIGIN,
  timeoutMs: REQUEST_TIMEOUT_MS,
  // Not the dashboard's wording, which sends the reader straight to `pnpm dev:backend`. In the
  // extension a `TypeError` out of `fetch` has a second common cause with a different fix: the
  // request never left, because `manifest.ts` no longer grants this origin (a `host_permissions`
  // edit takes effect only on reload). Naming the backend alone sent candidates to restart one that
  // was already running.
  unreachableMessage:
    `Couldn't reach the djobi backend at ${EXTENSION_BACKEND_ORIGIN}. Check it's running (pnpm dev:backend), ` +
    `and that the extension was reloaded since its host permissions last changed.`,
  // Every route here (`/api/auth/*` aside, which never goes through this transport — see
  // `lib/authClient.ts`) sits behind `app.ts`'s `requireAuth`, so every call needs whatever token
  // `chrome.storage.session` currently holds. Resolved fresh per call rather than read once: the
  // token can change — sign-in, sign-out, a session that expires — after this module's first import,
  // and a value captured at that moment would go stale the first time it did.
  getAuthorization: getAuthToken,
});
