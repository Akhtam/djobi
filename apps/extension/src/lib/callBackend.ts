/**
 * The extension's `@djobi/http-client` transport, shared by the service worker and extension pages:
 * the backend origin, the unreachable-backend message and bearer auth. `backendClient.ts` calls it
 * directly.
 *
 * Pages call the backend themselves (no relay through the worker): `manifest.ts` grants the origin
 * to the whole extension. The 401 adopt-and-retry policy lives in `backendClient.ts`'s
 * `withSessionRecovery`, where fakes see it too.
 */
import { createHttpTransport } from '@djobi/http-client';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
import { getAuthToken } from './authToken';

export { HttpError, isUnauthorized, userMessage, type HttpErrorKind } from '@djobi/http-client';

/**
 * Default per-call budget. 90s is well above a single call (a cold `/extract-job` measured ~17s)
 * without making fast routes like `GET /profile` look frozen when they hang; `/analyze` sets its
 * own.
 */
const REQUEST_TIMEOUT_MS = 90_000;

/** The configured transport; `backendClient.ts` is the only caller that names paths. */
export const transport = createHttpTransport({
  baseUrl: EXTENSION_BACKEND_ORIGIN,
  timeoutMs: REQUEST_TIMEOUT_MS,
  // Not "is the backend running?" alone: in the extension, `fetch` also fails when `manifest.ts`
  // no longer grants the origin (host permission changes need a reload).
  unreachableMessage:
    `Couldn't reach the djobi backend at ${EXTENSION_BACKEND_ORIGIN}. Check it's running (pnpm dev:backend), ` +
    `and that the extension was reloaded since its host permissions last changed.`,
  // Read fresh per call: sign-in, sign-out or expiry can change the token after import.
  getAuthorization: getAuthToken,
});
