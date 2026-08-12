const BACKEND_ORIGIN = 'http://127.0.0.1:5391';

/**
 * A non-2xx response from the local djobi backend. Carries `status` and `path` alongside the
 * message so `background/pipelineRunner.ts` can report *which* call failed and why, instead of the
 * generic "something went wrong" the panel used to show for every failure alike.
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
    const error = (parsed as { error?: unknown })?.error;
    if (typeof error === 'string') return error;
    if (typeof (error as { message?: unknown })?.message === 'string') {
      return (error as { message: string }).message;
    }
  } catch {
    // Not JSON — fall through and use the raw body below.
  }
  return raw.trim().slice(0, 300) || 'empty response body';
}

/**
 * Sends `body` as JSON to the local djobi backend and resolves with the parsed JSON response.
 * `method` defaults to `POST`; `GET` requests are sent bodyless.
 *
 * Reads the body as text and checks `res.ok` *before* parsing: parsing first turns a real HTTP
 * failure into an unrelated `SyntaxError` (a plain-text `Internal Server Error` throws
 * `Unexpected token 'I'`), which is exactly how a backend 500 used to reach the panel as an
 * uninformative parse error.
 *
 * @throws {BackendError} When the response status is not 2xx.
 */
export async function callBackend<T>(
  path: string,
  body: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<T> {
  const res = await fetch(
    `${BACKEND_ORIGIN}${path}`,
    method === 'GET'
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );

  const raw = await res.text();

  if (!res.ok) {
    throw new BackendError(
      res.status,
      path,
      `${method} ${path} failed (${res.status}): ${reasonFrom(raw)}`,
    );
  }

  return (raw ? JSON.parse(raw) : undefined) as T;
}
