/**
 * `@djobi/http-client` — how the extension and dashboard call the backend: one transport with a
 * single deadline over request and body, typed errors, auth, and cancellation.
 *
 * Kept out of `@djobi/shared`: route schemas are protocol facts; deadlines and error mapping are
 * client infrastructure. Each app keeps its own route surface, fake and config — notably the
 * **origin is injected** ({@link HttpTransportOptions.baseUrl}).
 */
import { BackendErrorBodySchema, failureMessage } from '@djobi/shared';
import type { BackendErrorCode, ZodError, ZodType, ZodTypeOf } from '@djobi/shared';

/**
 * Why a call failed:
 *
 * - `'http'` — the backend answered non-2xx. Carries `status`.
 * - `'timeout'` — nothing complete (headers or body) within the deadline.
 * - `'network'` — nothing reachable; usually the backend isn't running.
 * - `'invalid-response'` — a 2xx that isn't JSON or isn't the promised shape.
 * - `'invalid-request'` — the body failed its route's request schema, so nothing was sent.
 */
export type HttpErrorKind = 'http' | 'timeout' | 'network' | 'invalid-response' | 'invalid-request';

/** Any failed call to the djobi backend. One class, discriminated by {@link HttpErrorKind}. */
export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly path: string;
  /** The response status, for `kind: 'http'` only. */
  readonly status?: number | undefined;

  constructor(
    kind: HttpErrorKind,
    path: string,
    message: string,
    status?: number,
    /**
     * The original error, kept because mapping is lossy (every `fetch` `TypeError` becomes one
     * `'network'` message).
     */
    options?: {
      cause?: unknown;
      backendCode?: BackendErrorCode | undefined;
      /**
       * Candidate-facing text when it differs from `message` — see {@link HttpError.reason}.
       * Defaults to `message`.
       */
      reason?: string;
    },
  ) {
    super(message, options);
    this.name = 'HttpError';
    this.kind = kind;
    this.path = path;
    this.status = status;
    this.backendCode = options?.backendCode;
    this.reason = options?.reason ?? message;
  }

  /** A safe semantic classification supplied by the backend, independent of transport kind. */
  readonly backendCode?: BackendErrorCode | undefined;

  /**
   * Text fit to show the candidate: no `"$METHOD $path failed ($status):"` prefix, zod issues or
   * raw body. UI should read this (via {@link userMessage}); `message` is for logs.
   */
  readonly reason: string;
}

/**
 * Whether `err` is this transport reporting a backend 401 (no or expired session — or a wrong
 * password, which looks the same). Session policy stays with each caller.
 */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof HttpError && err.kind === 'http' && err.status === 401;
}

/**
 * Candidate-facing text for any caught error: `HttpError.reason`, else `failureMessage`. Use this
 * for UI instead of `failureMessage`, which returns the diagnostic `message`.
 */
export function userMessage(error: unknown): string {
  return error instanceof HttpError ? error.reason : failureMessage(error);
}

export interface HttpTransportOptions {
  /**
   * Prefixed to every path. Injected because deployments differ (ADR-0001): the dashboard uses a
   * relative `'/api'` on its own origin; the extension needs an absolute URL matching its
   * `host_permissions`.
   */
  baseUrl: string;
  /**
   * Deadline for a whole call, headers and body; default 90s. Aborting also reaches the model,
   * since the backend passes the request signal to the SDK.
   */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
  /** What to say when nothing is reachable; the remedy differs per app. */
  unreachableMessage?: string;
  /**
   * `fetch` `credentials` for every call. The dashboard sets `'include'` (cookie session); the
   * extension leaves it unset and uses a bearer token.
   */
  credentials?: RequestCredentials;
  /**
   * Resolves the bearer token for each request (may be async), or `undefined` for none. A function
   * because the extension's token in `chrome.storage.session` can change after construction.
   */
  getAuthorization?: () => string | undefined | Promise<string | undefined>;
}

/** One request's options. `method` defaults to `'POST'` when a body is given, `'GET'` when not. */
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * The caller's cancellation, combined with the deadline. An abort propagates as itself, never as
   * `'timeout'` — lets a superseded pipeline run stop its model work.
   */
  signal?: AbortSignal | undefined;
  /**
   * Sent as `idempotency-key` for a write that may be resent after a timeout. Only
   * `POST /applications` reads it; deduping is the server's job.
   */
  idempotencyKey?: string;
  /** Overrides `timeoutMs` for one call, for a route genuinely slower than the rest. */
  timeoutMs?: number;
}

export interface HttpTransport {
  /** Sends `path` and decodes the response through `schema`. */
  json<Schema extends ZodType>(
    path: string,
    schema: Schema,
    options?: RequestOptions,
  ): Promise<ZodTypeOf<Schema>>;
  /** Sends `path` and returns the raw response bytes — for a route that answers with a PDF. */
  binary(path: string, options?: RequestOptions): Promise<ArrayBuffer>;
  /**
   * Sends `formData` as a multipart upload and decodes the JSON response — for
   * `POST /profile/extract-resume`. No `content-type` is set so `fetch` adds the boundary.
   * `x-djobi-upload` is added to force a CORS preflight, since multipart is a "simple" type the
   * backend's JSON-only CSRF guard can't otherwise protect.
   */
  upload<Schema extends ZodType>(
    path: string,
    schema: Schema,
    formData: FormData,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ZodTypeOf<Schema>>;
}

/** The failed expectations, flattened into something a UI can show a person. */
function issuesFrom(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'response'} — ${issue.message}`)
    .join('; ');
}

/**
 * `value` parsed through the route's request schema — which also strips any field the route doesn't
 * accept. A failure throws an `'invalid-request'` {@link HttpError} with readable issues, never a raw
 * `ZodError` (whose `message` is a JSON issue dump).
 */
export function requestBody<Schema extends ZodType>(
  path: string,
  schema: Schema,
  value: unknown,
): ZodTypeOf<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data as ZodTypeOf<Schema>;
  const issues = issuesFrom(parsed.error);
  throw new HttpError(
    'invalid-request',
    path,
    `${path} request body is invalid: ${issues}`,
    undefined,
    {
      cause: parsed.error,
      reason: `Some details aren't valid yet: ${issues}.`,
    },
  );
}

/**
 * A readable reason from an error body: the backend's `{ error }`, Better Auth's `{ message }`, or
 * the raw text if it isn't JSON.
 */
export function errorBodyFrom(raw: string): {
  reason: string;
  backendCode?: BackendErrorCode | undefined;
} {
  try {
    const parsed: unknown = JSON.parse(raw);

    const body = BackendErrorBodySchema.safeParse(parsed);
    if (body.success) return { reason: body.data.error, backendCode: body.data.code };

    // A route that put an `Error`-like object under `error` rather than a string.
    const message = (parsed as { error?: { message?: unknown } })?.error?.message;
    if (typeof message === 'string') return { reason: message };

    // Better Auth (`/api/auth/*`) answers `{ message, code }` rather than `{ error }`.
    const topLevelMessage = (parsed as { message?: unknown })?.message;
    if (typeof topLevelMessage === 'string') return { reason: topLevelMessage };
  } catch {
    // Not JSON — fall through and use the raw body below.
  }
  return { reason: raw.trim().slice(0, 300) || 'empty response body' };
}

const DEFAULT_TIMEOUT_MS = 90_000;

/** `POST` with a body, `GET` without, unless the caller says otherwise. */
function resolveMethod(options: RequestOptions): 'GET' | 'POST' | 'PATCH' | 'DELETE' {
  return options.method ?? (options.body === undefined ? 'GET' : 'POST');
}

/**
 * Rejects when `signal` aborts; raced against body reads so the deadline covers them by
 * construction (and testably with an injected `fetch`).
 */
function abortedWith(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    else signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Resolved per call so stubs or polyfills installed after module load are honoured.
  const doFetch = (input: string, init: RequestInit) =>
    (options.fetch ?? globalThis.fetch)(input, init);

  /**
   * Runs one call — request and body read — under one deadline. `read` is a callback so the body is
   * consumed inside the `try`. Status is checked before parsing, so a plain-text 500 isn't reported
   * as a JSON `SyntaxError`.
   */
  async function call<T>(
    path: string,
    requestOptions: RequestOptions,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const { body, signal, idempotencyKey } = requestOptions;
    const method = resolveMethod(requestOptions);

    const init: RequestInit =
      body === undefined
        ? // No body, but still `application/json` on anything that changes state. The backend's CSRF
          // guard (`app.ts`) requires it on every POST/PATCH/PUT/DELETE, body or not, to force a
          // CORS preflight. GET sends none.
          method === 'GET'
          ? { method }
          : { method, headers: { 'content-type': 'application/json' } }
        : body instanceof FormData
          ? { method, headers: { 'x-djobi-upload': '1' }, body }
          : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };

    // `fetch` rejects a GET with a body as a `TypeError`, which would be misreported as
    // "backend unreachable". It's a caller bug, so throw it as such.
    if (method === 'GET' && body !== undefined) {
      throw new Error(`GET ${path} was given a body; use POST, or send it in the path.`);
    }

    const callTimeoutMs = requestOptions.timeoutMs ?? timeoutMs;
    const timeoutSignal = AbortSignal.timeout(callTimeoutMs);
    const deadline = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    try {
      // Resolved fresh per call. Only awaited when set: an extra `await` would delay `doFetch` past
      // a caller's synchronous `abort()`. Inside the `try`, so a rejection maps to `HttpError`.
      const authorization = options.getAuthorization ? await options.getAuthorization() : undefined;

      const response = await doFetch(`${options.baseUrl}${path}`, {
        ...init,
        signal: deadline,
        ...(options.credentials ? { credentials: options.credentials } : {}),
        ...(authorization || idempotencyKey
          ? {
              headers: {
                ...init.headers,
                ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
                ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
              },
            }
          : {}),
      });

      // Every body read, error bodies included, races the same deadline.
      const readBody = <R>(consume: Promise<R>) => Promise.race([consume, abortedWith(deadline)]);

      if (!response.ok) {
        const { reason, backendCode } = errorBodyFrom(await readBody(response.text()));
        throw new HttpError(
          'http',
          path,
          `${method} ${path} failed (${response.status}): ${reason}`,
          response.status,
          { backendCode, reason },
        );
      }

      return await readBody(read(response));
    } catch (error) {
      // The caller cancelled. Theirs to know about, not a failure to report — and checked before
      // the deadline, because an aborted call can surface as either.
      if (signal?.aborted) throw error;

      if (error instanceof HttpError) throw error;

      if (timeoutSignal.aborted) {
        throw new HttpError(
          'timeout',
          path,
          `${path} did not respond within ${Math.round(callTimeoutMs / 1000)}s`,
          undefined,
          { reason: 'This is taking longer than expected. Please try again.' },
        );
      }

      // `fetch` throws `TypeError` when nothing is reachable ("Failed to fetch"). It can also mean
      // a malformed request; the original is kept as `cause`.
      if (error instanceof TypeError) {
        throw new HttpError(
          'network',
          path,
          options.unreachableMessage ?? `Couldn't reach the djobi backend at ${options.baseUrl}.`,
          undefined,
          { cause: error },
        );
      }

      throw error;
    }
  }

  /** Shared decode step for `json()`/`upload()`: text in, `schema`-checked value out. */
  function decodeJson<Schema extends ZodType>(
    path: string,
    method: string,
    raw: string,
    schema: Schema,
  ): ZodTypeOf<Schema> {
    let parsed: unknown;
    // Candidate-facing; the raw body and zod issues stay in `message` for logs.
    const unexpectedResponseReason = 'The server sent back something unexpected. Please try again.';

    try {
      // An empty body decodes as `undefined` and therefore fails the schema, which is the honest
      // reading: a route that promised JSON and sent nothing did not do what it said.
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      // Previously this threw a raw `SyntaxError` straight past both apps' own error types.
      throw new HttpError(
        'invalid-response',
        path,
        `${method} ${path} returned a body that is not JSON: ${raw.trim().slice(0, 300)}`,
        undefined,
        { reason: unexpectedResponseReason },
      );
    }

    const decoded = schema.safeParse(parsed);
    if (!decoded.success) {
      throw new HttpError(
        'invalid-response',
        path,
        `${method} ${path} returned an unexpected response: ${issuesFrom(decoded.error)}`,
        undefined,
        { reason: unexpectedResponseReason },
      );
    }

    return decoded.data as ZodTypeOf<Schema>;
  }

  return {
    async json(path, schema, requestOptions = {}) {
      const raw = await call(path, requestOptions, (response) => response.text());
      return decodeJson(path, resolveMethod(requestOptions), raw, schema);
    },

    binary(path, requestOptions = {}) {
      return call(path, requestOptions, (response) => response.arrayBuffer());
    },

    async upload(path, schema, formData, requestOptions = {}) {
      const raw = await call(
        path,
        { method: 'POST', body: formData, signal: requestOptions.signal },
        (response) => response.text(),
      );
      return decodeJson(path, 'POST', raw, schema);
    },
  };
}

export { backendRoutes, type BackendRoutes } from './routes.js';
