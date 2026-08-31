/**
 * The extension's configuration of `@djobi/http-client`, used by the service worker and by the
 * extension pages (panel, options) alike.
 *
 * The protocol itself — the deadline, status-before-parse, error-body extraction, schema validation,
 * abort forwarding — lives in the package, because the dashboard talks to the same backend and
 * implemented all of it a second time. What is left here is what is genuinely the extension's: the
 * origin, and the remedy to suggest when nothing answers.
 *
 * There is deliberately no relay through the service worker for the pages' calls. A relay would rest
 * on the premise that extension pages can't reach the backend themselves, and they can:
 * `manifest.ts` grants the configured backend origin to the whole extension, not just the worker.
 * Adding one back would put a second message protocol on `background/service-worker.ts`'s single
 * `onMessage` listener and give the codebase two origins and two error types where one of each does.
 */
import { createHttpTransport } from '@djobi/http-client';
import type { ZodTypeAny, ZodTypeOf } from '@djobi/shared';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';

export { HttpError, type HttpErrorKind } from '@djobi/http-client';

/**
 * The backend's origin, absolute and build-time visible.
 *
 * It has to be both: the extension has no origin of its own to be relative to, and this same value
 * appears as a `host_permissions` entry in `manifest.ts` — a request to an origin the manifest
 * doesn't grant is blocked before it is sent. When ADR-0001's deployed Worker lands, these two move
 * together. The dashboard has the opposite constraint and takes a relative `/api`.
 */
/**
 * Ninety seconds is well clear of what these calls actually cost (the slowest measured, a cold
 * `/extract-job`, was ~17s) and short enough that a hung one becomes a visible error the candidate
 * can retry.
 */
const REQUEST_TIMEOUT_MS = 90_000;

const transport = createHttpTransport({
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
});

type Method = 'GET' | 'POST' | 'PATCH';

/**
 * Sends `body` to `path` and resolves with the response decoded through `schema`. `method` defaults
 * to `POST`; `GET` requests are sent bodyless, so `body` may be omitted for them.
 *
 * **`schema` is required, and that is the point.** This used to take a type parameter and cast the
 * parsed JSON to it, leaving the response checked only where a caller remembered to check it — which
 * was three routes out of eleven, and the three with the least to get wrong. Every model-written
 * payload arrived unverified, so a `/tailor-resume` response missing `workExperience` type-checked
 * all the way through the Analysis Step and surfaced as an empty PDF with nothing pointing back
 * here. A parameter can't be forgotten the way a convention can, and it mirrors what
 * `backendClient.ts` already does outbound with `satisfies`.
 *
 * @throws {HttpError} `kind: 'http'` for a non-2xx, `'timeout'`, `'network'`, or
 *   `'invalid-response'` for a 2xx whose body isn't what the route promised.
 */
export function callBackend<Schema extends ZodTypeAny>(
  path: string,
  schema: Schema,
  body?: unknown,
  method: Method = 'POST',
  signal?: AbortSignal,
): Promise<ZodTypeOf<Schema>> {
  // `method` is passed explicitly rather than left to the transport's body-presence default: a
  // bodyless `POST` is a real case here (`saveProfile` sends the profile, `findApplicationDuplicates`
  // sends nothing and is a GET), and inferring it would quietly change one of them.
  return transport.json(path, schema, { method, body, signal });
}

/**
 * Sends `body` as JSON and resolves with the raw response bytes — for `/render-resume-pdf`, whose
 * response is a PDF that {@link callBackend}'s `JSON.parse` can't read.
 *
 * It takes a `signal` for the same reason every other route does. It used to take none, which made
 * it the one call in the extension that could not be cancelled — and it is a real generation cost
 * inside the Fill Step, not a cheap read. That asymmetry survived because "every call forwards its
 * signal" was a convention re-remembered per function rather than a rule the transport states.
 *
 * @throws {HttpError} As {@link callBackend}, minus `'invalid-response'` — there is no schema to fail.
 */
export function callBackendBinary(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  return transport.binary(path, { method: 'POST', body, signal });
}
