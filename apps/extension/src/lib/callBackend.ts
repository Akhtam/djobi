/**
 * The one transport to the local djobi backend, used by the service worker and by the extension
 * pages (panel, options) alike.
 *
 * There used to be three. This one; a `{ path, body, method? }` relay message (`sendToBackground`
 * -> `background/relay.ts` -> here) for the extension pages; and a bare `fetch` in
 * `fetchResumePdf.ts` for the one response that isn't JSON. The relay rested on the premise that
 * extension pages can't call the backend directly — which that bare `fetch` disproved by doing
 * exactly that from the panel. They can: `manifest.ts` grants `http://127.0.0.1:5391/*` to the
 * whole extension, not just the service worker. Collapsing them here also lets
 * `background/service-worker.ts` stop multiplexing two message protocols onto one `onMessage`
 * listener, and leaves one origin and one error type instead of three of each.
 */
import { BackendErrorBodySchema, type StructuredCallFailure } from '@djobi/shared';

const BACKEND_ORIGIN = 'http://127.0.0.1:5391';

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
    /**
     * Why a structured LLM call failed, when that is what this was. Carried as data so a caller can
     * decide whether a retry is worth anything; before this it existed only inside the message text.
     * `undefined` for every other failure.
     *
     * Typed as the shared union rather than `string`: a bare `string` accepts
     * `kind === 'no-tool-cal'` as a perfectly good comparison that never matches, which would give
     * back exactly the stringly-typed error this field replaced.
     */
    readonly kind?: StructuredCallFailure,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/**
 * Best-effort extraction of a human-readable reason from an error response body. Handles the
 * backend's `{ error }` shape (used by both route validation failures and `app.onError`), and
 * falls back to the raw text for anything that isn't JSON at all — a crash outside the backend's
 * own error handling, or nothing listening on the port, still produces a readable message.
 */
function reasonFrom(raw: string): { reason: string; kind?: StructuredCallFailure } {
  try {
    const parsed: unknown = JSON.parse(raw);

    // The shape `app.onError` produces. Parsing rather than hand-checking is what keeps `kind`
    // narrowed to the union — an unrecognized value is dropped here instead of reaching a caller
    // as a `string` that compares equal to nothing.
    const body = BackendErrorBodySchema.safeParse(parsed);
    if (body.success) return { reason: body.data.error, kind: body.data.kind };

    // A route that put an `Error`-like object under `error` rather than a string.
    const message = (parsed as { error?: { message?: unknown } })?.error?.message;
    if (typeof message === 'string') return { reason: message };
  } catch {
    // Not JSON — fall through and use the raw body below.
  }
  return { reason: raw.trim().slice(0, 300) || 'empty response body' };
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
async function request(path: string, body: unknown, method: 'GET' | 'POST'): Promise<Response> {
  const res = await fetch(
    `${BACKEND_ORIGIN}${path}`,
    method === 'GET'
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );

  if (!res.ok) {
    const { reason, kind } = reasonFrom(await res.text());
    throw new BackendError(
      res.status,
      path,
      `${method} ${path} failed (${res.status}): ${reason}`,
      kind,
    );
  }

  return res;
}

/**
 * Sends `body` as JSON and resolves with the parsed JSON response. `method` defaults to `POST`;
 * `GET` requests are sent bodyless.
 *
 * @throws {BackendError} When the response status is not 2xx.
 */
export async function callBackend<T>(
  path: string,
  body: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<T> {
  const raw = await (await request(path, body, method)).text();
  return (raw ? JSON.parse(raw) : undefined) as T;
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
