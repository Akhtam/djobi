/**
 * The one transport to the local djobi backend, used by the service worker and by the extension
 * pages (panel, options) alike.
 *
 * There is deliberately no relay through the service worker for the pages' calls. A relay would
 * rest on the premise that extension pages can't reach the backend themselves, and they can:
 * `manifest.ts` grants `http://127.0.0.1:5391/*` to the whole extension, not just the worker.
 * Adding one back would put a second message protocol on `background/service-worker.ts`'s single
 * `onMessage` listener and give the codebase two origins and two error types where one of each
 * does. The PDF route is the one non-JSON response and is served here too, by
 * {@link callBackendBinary}, rather than by a bare `fetch` somewhere else.
 */
import { BackendErrorBodySchema } from '@djobi/shared';
import type { ZodError, ZodTypeAny, ZodTypeOf } from '@djobi/shared';

const BACKEND_ORIGIN = 'http://127.0.0.1:5391';

/**
 * How long any one backend call may take before it is abandoned.
 *
 * `fetch` has no timeout of its own, so a request that never completes never settles, and the
 * Analysis Step's `Promise.all` waits on it forever — the panel spins on "Analyzing job posting…"
 * with no failure to report and no way back except reloading the extension.
 *
 * Ninety seconds is well clear of what these calls actually cost (the slowest measured, a cold
 * `/extract-job`, was ~17s) and short enough that a hung one becomes a visible error the candidate
 * can retry. Aborting also reaches the model: the backend hands each request's signal down to the
 * SDK, so giving up here stops the generation rather than merely stopping the wait.
 */
const REQUEST_TIMEOUT_MS = 90_000;

/** A {@link BackendError} for a call that ran past {@link REQUEST_TIMEOUT_MS}. */
export class BackendTimeoutError extends Error {
  constructor(readonly path: string) {
    super(`${path} did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
    this.name = 'BackendTimeoutError';
  }
}

/**
 * A non-2xx response from the local djobi backend. Carries `status` and `path` alongside the
 * message so `background/applicationPipeline.ts` can report *which* call failed and why, instead of
 * the generic "something went wrong" the panel used to show for every failure alike.
 */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/**
 * A 2xx response whose body isn't the shape the route promised.
 *
 * Separate from {@link BackendError}, which means the request failed. This one means it *succeeded*
 * and lied — a distinction worth keeping, because the two have different causes and different fixes:
 * a `BackendError` is usually the backend being down or rejecting the request, while this is the two
 * halves having drifted apart.
 */
export class BackendResponseError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendResponseError';
  }
}

/** The failed expectations, flattened into something a panel can show a person. */
function issuesFrom(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'response'} — ${issue.message}`)
    .join('; ');
}

/**
 * Best-effort extraction of a human-readable reason from an error response body. Handles the
 * backend's `{ error }` shape (used by both route validation failures and `app.onError`), and
 * falls back to the raw text for anything that isn't JSON at all — a crash outside the backend's
 * own error handling, or nothing listening on the port, still produces a readable message.
 */
function reasonFrom(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);

    // The shape `app.onError` produces. Unknown legacy metadata is stripped by the schema.
    const body = BackendErrorBodySchema.safeParse(parsed);
    if (body.success) return body.data.error;

    // A route that put an `Error`-like object under `error` rather than a string.
    const message = (parsed as { error?: { message?: unknown } })?.error?.message;
    if (typeof message === 'string') return message;
  } catch {
    // Not JSON — fall through and use the raw body below.
  }
  return raw.trim().slice(0, 300) || 'empty response body';
}

/**
 * Sends `body` to `path` and returns the response, having already turned a non-2xx into a
 * {@link BackendError}. The body is only read here on the failure path, so the caller decides how
 * to decode a success — JSON for most routes, raw bytes for the rendered resume PDF.
 *
 * The status check happens *before* any parsing: parsing first turns a real HTTP failure into an
 * unrelated `SyntaxError` (a plain-text `Internal Server Error` throws `Unexpected token 'I'`),
 * which is exactly how a backend 500 used to reach the panel as an uninformative parse error.
 */
type Method = 'GET' | 'POST' | 'PATCH';

async function request(
  path: string,
  body: unknown,
  method: Method,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const init: RequestInit =
    method === 'GET'
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };

  let res: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    res = await fetch(`${BACKEND_ORIGIN}${path}`, {
      ...init,
      // A pipeline run supplies the first signal so re-analysis stops superseded model work. The
      // deadline remains independent: either reason is enough to abandon this particular request.
      signal: externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal,
    });
  } catch (error) {
    // A timeout reaches here as a bare `TimeoutError`, which says nothing about which call stalled.
    // The panel reports the cause it is given, so the path has to be in it.
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new BackendTimeoutError(path);
    }
    throw error;
  }

  if (!res.ok) {
    const reason = reasonFrom(await res.text());
    throw new BackendError(res.status, path, `${method} ${path} failed (${res.status}): ${reason}`);
  }

  return res;
}

/**
 * Sends `body` as JSON and resolves with the response decoded through `schema`. `method` defaults to
 * `POST`; `GET` requests are sent bodyless, so `body` may be omitted for them.
 *
 * `PATCH` is in the union because `backendClient.updateApplication` has always sent one — the
 * narrower `'GET' | 'POST'` type was simply a lie the compiler flagged and the runtime ignored.
 *
 * **`schema` is required, and that is the point.** This used to take a type parameter and cast the
 * parsed JSON to it, leaving the response checked only where a caller remembered to check it — which
 * was three routes out of eleven, and the three with the least to get wrong. Every model-written
 * payload arrived unverified, so a `/tailor-resume` response missing `workExperience` type-checked
 * all the way through the Analysis Step and surfaced as an empty PDF with nothing pointing back
 * here. A parameter can't be forgotten the way a convention can, and it mirrors what
 * `backendClient.ts` already does outbound with `satisfies`: both halves of every call now have to
 * agree with the shared schema rather than merely with each other.
 *
 * An empty body decodes as `undefined` and therefore fails the schema, which is the honest reading:
 * a route that promised JSON and sent nothing did not do what it said.
 *
 * @throws {BackendError} When the response status is not 2xx.
 * @throws {BackendResponseError} When a 2xx body isn't what `schema` describes.
 */
export async function callBackend<Schema extends ZodTypeAny>(
  path: string,
  schema: Schema,
  body?: unknown,
  method: Method = 'POST',
  signal?: AbortSignal,
): Promise<ZodTypeOf<Schema>> {
  const raw = await (await request(path, body, method, signal)).text();
  const decoded = schema.safeParse(raw ? JSON.parse(raw) : undefined);

  if (!decoded.success) {
    throw new BackendResponseError(
      path,
      `${method} ${path} returned an unexpected response: ${issuesFrom(decoded.error)}`,
    );
  }

  return decoded.data;
}

/**
 * Sends `body` as JSON and resolves with the raw response bytes — for `/render-resume-pdf`, whose
 * response is a PDF that {@link callBackend}'s `JSON.parse` can't read.
 *
 * @throws {BackendError} When the response status is not 2xx.
 */
export async function callBackendBinary(path: string, body: unknown): Promise<ArrayBuffer> {
  return (await request(path, body, 'POST')).arrayBuffer();
}
