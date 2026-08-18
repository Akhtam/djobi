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
import { BackendErrorBodySchema } from '@djobi/shared';

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

async function request(path: string, body: unknown, method: Method): Promise<Response> {
  const res = await fetch(
    `${BACKEND_ORIGIN}${path}`,
    method === 'GET'
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );

  if (!res.ok) {
    const reason = reasonFrom(await res.text());
    throw new BackendError(res.status, path, `${method} ${path} failed (${res.status}): ${reason}`);
  }

  return res;
}

/**
 * Sends `body` as JSON and resolves with the parsed JSON response. `method` defaults to `POST`;
 * `GET` requests are sent bodyless, so `body` may be omitted for them.
 *
 * `PATCH` is in the union because `backendClient.updateApplication` has always sent one — the
 * narrower `'GET' | 'POST'` type was simply a lie the compiler flagged and the runtime ignored.
 *
 * @throws {BackendError} When the response status is not 2xx.
 */
export async function callBackend<T>(
  path: string,
  body?: unknown,
  method: Method = 'POST',
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
